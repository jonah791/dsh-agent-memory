/**
 * dsh-agent-memory 插件入口（T7 集成组装）
 *
 * 函数插件形态（对齐官方 packages/AGENTS.md 与 dsh-agent-teams）：
 * - name / inject / Config / apply，无 default export
 * - 组装职责：storage-domain 开域 → MemoryStore → TimelineCompressor → 工具注册
 *   → 启动注入（记忆速览）→ 压缩即记忆（compaction 联动）
 * - 懒压缩接线：recall/memory_stats 访问时经 compress 钩子补压上一自然单位
 *   （DESIGN.md §五：只压缩 L3 情景；global 不压缩；项目配置驱动）
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { MemoryStore } from './store.ts'
import { RelationStore } from './relations.ts'
import { ConceptStore } from './thesaurus.ts'
import { EntityStore } from './entities.ts'
import { SourceStore } from './sources.ts'
import { TimelineCompressor, type SummarizeFn } from './timeline.ts'
import { summarizeEntries, type SummarizerConfig } from './summarizer.ts'
import { registerMemoryTools, type MemoryToolDeps } from './tools.ts'
import { installMemoryInject } from './inject.ts'
import { installAutoRecallInject } from './auto-inject.ts'
import { installCompactionSink } from './compaction-sink.ts'
import { installPeriodicCompress } from './periodic.ts'
import { loadMemoryConfig, memoryConfigPath } from './config.ts'
import { appendAccessTrace, appendProposalRecord, readAccessIndex, readAccessSummary as readAccessSummaryFromTrace, readReviewMarks as readReviewMarksFromTrace } from './access-trace.ts'
import { appendCompressTrace, readCompressSummary as readCompressSummaryFromTrace, type CompressTraceSink } from './compress-trace.ts'
import { appendDedupeTrace, readDedupeTrace as readDedupeTraceFromSidecar } from './dedupe-trace.ts'
import { DEFAULT_AUDIT_CONFIG } from './audit.ts'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { Concept, Entity, Entry, Grounding, Relation, Source, Subject } from './types.ts'
import { normalizeSubject } from './subject.ts'
import { normalizeGrounding } from './grounding.ts'
import { normalizeReviewAfter, normalizeWatchFor } from './temporal.ts'
import { normalizeValidAfter } from './succession.ts'

// ---------- 持久化域 ----------

/** 记忆条目 zod schema（storage-domain 持久化校验边界，对齐 types.ts Entry） */
/**
 * 写入边界 schema（**导出供测试直接校验**）。
 *
 * 为什么必须导出：这个 schema 是「新字段静默剥掉」那个坑的现场（v0.12/13/14 连中三次）。
 * 只靠源码 grep 断言「某行存在」是弱判据——**真正的判据是喂一个带该字段的对象进去、
 * 断言它没被剥掉**。导出后 tests/temporal.test.mjs 的 A113 就是这么测的（真 parse，非 grep）。
 */
export const entrySchema = zod.object({
  id: zod.string(),
  kind: zod.enum(['fact', 'knowledge', 'episodic', 'summary']),
  key: zod.string().optional(),
  title: zod.string(),
  body: zod.string(),
  tags: zod.array(zod.string()),
  /**
   * 检索别名（2026-10-13 重做）。
   * ⚠ **必须在此声明**：storage-domain 在写入边界用本 schema 校验，
   * 未声明的字段会被**静默剥掉**（存了等于没存）——这正是「持久化契约」的意义。
   */
  aliases: zod.array(zod.string()).optional(),
  scope: zod.string(),
  createdAt: zod.string(),
  updatedAt: zod.string(),
  accessedAt: zod.string(),
  level: zod.enum(['day', 'week', 'month', 'year']).nullable(),
  bucket: zod.string().nullable(),
  archived: zod.boolean(),
  source: zod.object({
    sessionId: zod.string().optional(),
    seq: zod.number().optional(),
    reason: zod.string().optional(),
  }).optional(),
  archiveRef: zod.array(zod.string()).optional(),
  /**
   * 归档原因（v0.21.0）：这条**怎么没了**——平级标量，**不是嵌套对象**。
   * 与 `source`（这条从哪来）分离；旧实现把归档原因塞进 `source.reason`，是 `p` 轴语义错配的根因。
   * ⚠ 平级而非对象：本仓 schema DSL 的 required 只支持字段级，嵌套对象在归一化时会被改形
   * （schema-parity A118 红 + `defineTool` 泛型推断退化成 never）——实测踩过两次。
   * ⚠ **必须在此声明**（同一个坑**第六次**：v0.12 `aliases`、v0.13 `subject`、
   * v0.14 `grounding`、v0.15 `reviewAfter/watchFor`、v0.16 `cue`）：
   * storage-domain 在写入边界用本 schema 校验，**未声明的字段会被静默剥掉**——
   * 存了等于没存，而写入**仍返回成功**，是最难查的一类缺陷。
   */
  archivedReasonType: zod.enum(['refuted', 'merged', 'superseded', 'stale', 'capacity', 'deleted', 'unspecified']).optional(),
  archivedReason: zod.string().optional(),
  /**
   * 来源类型（v0.21.0）：`master` / `web` / `self` / `measured`。缺省 = 未标注。
   * ⚠ **必须在此声明**（同一个坑**第七次**，见上方 `archivedReasonType` 的清单）。
   */
  provenance: zod.enum(['master', 'web', 'self', 'measured']).optional(),
  /**
   * 执行位置（v0.23.0）：`project`（那个项目）+ `taskId`（那个任务，**只在 project 内唯一**）。
   *
   * ⚠ **必须在此声明**（同一个坑**第八次**：v0.12 `aliases`、v0.13 `subject`、
   * v0.14 `grounding`、v0.15 `reviewAfter/watchFor`、v0.16 `cue`、v0.21 `provenance` 与
   * `archivedReasonType`）：storage-domain 在写入边界用本 schema 校验，**未声明的字段会被
   * 静默剥掉**——存了等于没存，而写入**仍返回成功**，是最难查的一类缺陷。
   *
   * ⇒ 判据（第三次重申，因为前两次重申都没拦住）：**任何新字段加进 `Entry`，
   * 必须同时来这里声明一次**——类型层不会报错，运行层不会报错，只有「读数不对」会报错。
   */
  project: zod.string().optional(),
  taskId: zod.string().optional(),
  // v0.5 角色维度（多智能体工作台模式）：归属 + 写入者溯源
  role: zod.string().optional(),
  /**
   * 主体层（v0.13.0）：条目**关于谁**——与 `role` 正交（role 答「谁写的」，本字段答
   * 「关于谁的」）。缺省 = 通用。
   * ⚠ **必须在此声明**（同 v0.12 `aliases` 的教训）：storage-domain 在写入边界用本
   * schema 校验，未声明的字段会被**静默剥掉**（存了等于没存——过滤/渲染/统计全部失效，
   * 而写入还返回成功，是最难查的一类缺陷）。
   */
  subject: zod.enum(['self', 'master']).optional(),
  /**
   * 约定状态（v0.14.0）：事项**是否已被共同建立**——`established` / `proposed`（**我提的、
   * 主人未回应**）/ `scoped` / `rejected`。缺省 = 未标注。
   * ⚠ **必须在此声明**（这是同一个坑第三次：v0.12 `aliases`、v0.13 `subject`）：
   * storage-domain 在写入边界用本 schema 校验，**未声明的字段会被静默剥掉**——
   * 存了等于没存，而写入**仍返回成功**，是最难查的一类缺陷。
   */
  grounding: zod.enum(['established', 'proposed', 'scoped', 'rejected']).optional(),
  /**
   * 时效维（v0.15.0）：复查死线（`YYYY-MM-DD`，**存绝对日期**——相对写法在工具层就折算了）
   * 与观察条件（1–8 条短句）。
   * ⚠ **必须在此声明**（同一个坑**第四次**：v0.12 `aliases`、v0.13 `subject`、v0.14 `grounding`）：
   * storage-domain 在写入边界用本 schema 校验，**未声明的字段会被静默剥掉**——
   * 存了等于没存，而写入**仍返回成功**，是最难查的一类缺陷。
   * ⇒ 判据：**任何新字段加进 `Entry`，必须同时来这里声明一次**（类型层不会报错）。
   */
  reviewAfter: zod.string().optional(),
  watchFor: zod.array(zod.string()).optional(),
  /**
   * 情境形状（v0.16.0，2026-10-21）：这条经验**在什么形状的情境下该被取出使用**。
   *
   * 与另两维的语义分工（三者不可互相替代）：`aliases` 管**入口词**（可能被怎么问）、
   * `watchFor` 管**时效**（什么新信息会让它失效）、`cue` 管**应用场景**（什么形状的处境该用它）。
   *
   * 论文依据（Harness² 的 experience `cue`，arXiv:2610.14224 §H Prompt 6）：cue 描述情境的
   * **形状**而非本次任务的事实，因而能在**另一件事**上触发。原文判据线：太泛无用
   * （`be thorough`）；太具体永不触发（`the fee rose to 250 on Jan 1`）。
   *
   * ⚠ **必须在此声明**（同一个坑**第五次**：v0.12 `aliases`、v0.13 `subject`、
   * v0.14 `grounding`、v0.15 `reviewAfter/watchFor`）：storage-domain 在写入边界用本 schema
   * 校验，**未声明的字段会被静默剥掉**——存了等于没存，而写入**仍返回成功**。
   */
  cue: zod.array(zod.string()).optional(),
  /**
   * 事实生命周期（v0.24.0）：`validAfter`（从何时开始为真）+ `supersededBy` / `supersedes`
   * （谁替代了谁，只留一层）。
   *
   * ⚠ **必须在此声明**（同一个坑**第九次**：v0.12 `aliases`、v0.13 `subject`、
   * v0.14 `grounding`、v0.15 `reviewAfter/watchFor`、v0.16 `cue`、v0.21 `provenance` 与
   * `archivedReasonType`、v0.23 `project/taskId`）：storage-domain 在写入边界用本 schema
   * 校验，**未声明的字段会被静默剥掉**——存了等于没存，而写入**仍返回成功**，
   * 是最难查的一类缺陷。
   *
   * ⇒ 判据（第四次重申）：**任何新字段加进 `Entry`，必须同时来这里声明一次**
   * ——类型层不会报错，运行层不会报错，只有「读数不对」会报错。
   */
  validAfter: zod.string().optional(),
  supersededBy: zod.string().optional(),
  supersedes: zod.array(zod.string()).optional(),
  author: zod.object({
    sessionId: zod.string().optional(),
    delegationDepth: zod.number().optional(),
    preset: zod.string().optional(),
  }).optional(),
  /**
   * 证据引用（v0.25.0）：这条记忆**能回到哪里**（编码串，格式见 `types.ts::EvidenceKind`）。
   *
   * ⚠ **必须在此声明**（同一个坑**第十次**：v0.12 `aliases`、v0.13 `subject`、v0.14
   * `grounding`、v0.15 `reviewAfter/watchFor`、v0.16 `cue`、v0.21 `provenance` 与
   * `archivedReasonType`、v0.23 `project/taskId`、v0.24 `validAfter/supersededBy/supersedes`）：
   * storage-domain 在写入边界用本 schema 校验，**未声明的字段会被静默剥掉**——存了等于没存，
   * 而写入**仍返回成功**。证据层尤其致命：它会安静地让「可追溯率」永远是 0。
   */
  evidenceRefs: zod.array(zod.string()).optional(),
  /**
   * 来源实体引用（v0.35 · 方案 §5.2）：`SOURCE-0001` 形态的 id 列表。
   * 与 `evidenceRefs` 分工：那个是坐标字符串，这个连到可复用的来源对象。
   * 同一条纪律：**未声明就会被静默剥掉**。
   */
  sourceIds: zod.array(zod.string()).optional(),
  /**
   * 内容分类（v0.26.0 · 方案 §3.1 七类）。
   *
   * ⚠ **必须在此声明**（同一个坑**第十一次**）：storage-domain 在写入边界用本 schema 校验，
   * 未声明的字段会被静默剥掉而写入**仍返回成功**。
   */
  memType: zod.enum(['episodic', 'semantic', 'procedural', 'profile', 'project', 'relational', 'operational']).optional(),
  /**
   * 空间归属与生命周期（v0.27.0 · 方案 §3.2 / §3.3）。
   *
   * ⚠ **必须在此声明**（同一个坑**第十二、十三次**）：storage-domain 在写入边界用本
   * schema 校验，未声明的字段会被静默剥掉而写入**仍返回成功**。
   */
  space: zod.enum(['personal', 'project', 'domain', 'system']).optional(),
  status: zod.enum(['pending', 'disputed']).optional(),
})

/**
 * 关系表 schema（v0.28.0 · 方案 §4.4）。
 *
 * 同 `entrySchema` 的地位：storage-domain 在写入边界用它校验，**未声明的字段会被静默剥掉
 * 而写入仍返回成功**（本仓已踩过十三次）。字段全是平级标量，不用嵌套对象。
 */
export const relationSchema = zod.object({
  id: zod.string(),
  type: zod.enum([
    'belongs-to',
    'related-to',
    'supports',
    'refutes',
    'sourced-from',
    'derived-from',
    'supersedes',
    'participates-in',
    'uses',
    'depends-on',
  ]),
  from: zod.string(),
  to: zod.string(),
  fromKind: zod.enum(['entry']),
  toKind: zod.enum(['entry']),
  scope: zod.string(),
  provenance: zod.enum(['master', 'web', 'self', 'measured']),
  confidence: zod.number().optional(),
  validFrom: zod.string().optional(),
  validTo: zod.string().optional(),
  evidenceRefs: zod.array(zod.string()).optional(),
  note: zod.string().optional(),
  createdAt: zod.string(),
})

/**
 * 概念表 schema（v0.29.0 · 方案 §4.2 主题词表）。
 *
 * 同 `entrySchema` / `relationSchema` 的地位：storage-domain 在写入边界用它校验，
 * **未声明的字段会被静默剥掉而写入仍返回成功**。`revisions` 是本表唯一的嵌套结构
 * （与条目的 `revisions` 同形，只在存储侧；工具参数面仍保持平级标量）。
 */
export const conceptSchema = zod.object({
  id: zod.string(),
  scope: zod.string(),
  prefLabel: zod.string(),
  altLabels: zod.array(zod.string()).optional(),
  definition: zod.string().optional(),
  scopeNote: zod.string().optional(),
  broader: zod.array(zod.string()).optional(),
  related: zod.array(zod.string()).optional(),
  status: zod.enum(['deprecated']).optional(),
  deprecatedNote: zod.string().optional(),
  createdAt: zod.string(),
  updatedAt: zod.string(),
  revisions: zod.array(zod.object({
    at: zod.string(),
    action: zod.string(),
    detail: zod.string(),
    reason: zod.string().optional(),
  })).optional(),
})

/**
 * 实体表 schema（v0.30.0 · 方案 §4.3 实体权威档）。
 *
 * 与 `conceptSchema` 同一条纪律：**未声明的字段会在写入边界被静默剥掉而写入仍返回成功**
 * （同一个坑第十五次）。`revisions` 是本表唯一嵌套，只在存储侧；工具参数面保持平级标量。
 */
export const entitySchema = zod.object({
  id: zod.string(),
  scope: zod.string(),
  canonicalName: zod.string(),
  aliases: zod.array(zod.string()).optional(),
  entityType: zod.string(),
  firstSeen: zod.string().optional(),
  topics: zod.array(zod.string()).optional(),
  relatedEntities: zod.array(zod.string()).optional(),
  disambiguation: zod.string().optional(),
  status: zod.enum(['merged', 'deprecated']).optional(),
  mergedInto: zod.string().optional(),
  deprecatedNote: zod.string().optional(),
  createdAt: zod.string(),
  updatedAt: zod.string(),
  revisions: zod.array(zod.object({
    at: zod.string(),
    action: zod.string(),
    detail: zod.string(),
    reason: zod.string().optional(),
  })).optional(),
})

/**
 * 来源实体（v0.35 · 方案 §5.2）：独立表，`SOURCE-0001` 每 scope 递增。
 *
 * 与 `entitySchema` 同一条纪律：**未声明的字段会在写入边界被静默剥掉而写入仍返回成功**
 * （同一个坑第十五次）。`reliability` / `permissions` **刻意不带默认值**——它们缺省是
 * 「未标注」，与「中等可靠」「无限制」是两件事（契约 S2）。
 */
export const sourceSchema = zod.object({
  id: zod.string(),
  scope: zod.string(),
  type: zod.enum(['master', 'web', 'self', 'measured']),
  location: zod.string(),
  collectedAt: zod.string(),
  owner: zod.string().optional(),
  reliability: zod.string().optional(),
  permissions: zod.array(zod.string()).optional(),
  label: zod.string().optional(),
  status: zod.enum(['active', 'retired']).optional(),
  retiredNote: zod.string().optional(),
  createdAt: zod.string(),
  updatedAt: zod.string(),
  revisions: zod.array(zod.object({
    at: zod.string(),
    action: zod.string(),
    detail: zod.string(),
    reason: zod.string().optional(),
  })).optional(),
})

/** 记忆域声明：条目表 + 关系表 + 概念表 + 实体表 + 来源表，key = `<scope>:<kind|relation|concept|entity|source>:<id>`（domain 即命名空间，规格 §2.2） */
export const memoryDomainSpec = defineDomain({
  name: 'agent_memory', // DSH 域名限制 /^[a-z][a-z0-9_]*$/（不允许连字符）
  version: 1,
  tables: {
    entries: domainTable<string, Entry>(entrySchema),
    // 关系表（v0.28.0 · 方案 §4.4）：边是独立资源，不嵌条目。
    // ⚠ 加表**不抬 version**：single 布局按 descriptor 里的表清单读盘，缺表当空表
    // （storage-json/src/format.ts 只遍历 descriptor.tables），而存量文件里没有
    // `relations` 键 ⇒ 读出空表，不需要迁移。判据：重启后 memory_stats.relations.total 为 0
    // 且不报 version-mismatch（见 aml-eval.md 的部署读数）。
    relations: domainTable<string, Relation>(relationSchema),
    // 概念表（v0.29.0 · 方案 §4.2 主题词表）：同 `relations`——加表不抬 version，
    // 存量文件里没有 `concepts` 键 ⇒ 读出空表（判据：重启后 memory_stats.concepts.total 为 0
    // 且不报 version-mismatch）。
    concepts: domainTable<string, Concept>(conceptSchema),
    // 实体表（v0.30.0 · 方案 §4.3 实体权威档）：同 `relations` / `concepts`——加表不抬 version，
    // 存量文件里没有 `entities` 键 ⇒ 读出空表（判据：重启后 memory_stats.entities.total 为 0
    // 且不报 version-mismatch）。
    entities: domainTable<string, Entity>(entitySchema),
    // 来源表（v0.35 · 方案 §5.2 独立来源记录）：同 `relations` / `concepts` / `entities`——
    // 加表不抬 version，存量文件里没有 `sources` 键 ⇒ 读出空表（判据：重启后
    // memory_stats.sources.total 为 0 且不报 version-mismatch）。
    sources: domainTable<string, Source>(sourceSchema),
  },
})

// ---------- 插件形态 ----------

export const name = 'agent-memory'
export const inject = ['storageDomain', 'tools', 'llm', 'agents'] as const

/** 记忆回流服务（2026-09-06 审查改进）：其他插件（emotion/taskboard/evolution-core/skill-forge）注入消费，
 *  把运行态状态/结论回流主记忆库——记忆库成为唯一时间线，插件 JSON 只是运行态。 */
export interface MemoryApiService {
  /**
   * 写一条记忆（与 remember 工具同语义：L1 key 覆盖 / L2/L3 title 指纹合并 / 无命中新建）。
   * 回流默认 global scope（跨项目生命周期结论）；scope 可覆盖。
   * 返回 { id, action } 或 { error }——调用方应容错（服务不可用/写入失败静默跳过，不阻塞业务）。
   */
  remember(input: {
    text: string
    kind?: 'fact' | 'knowledge' | 'episodic'
    tags?: string[]
    key?: string
    scope?: string
    /**
     * 主体层（v0.13.0）：这条回流记忆**关于谁**（`self` = 我 / `master` = 主人；
     * 缺省 = 通用）。服务通道走**容错归一**（认别名、认不出即通用）而非 fail-loud——
     * 它的契约是「不阻塞调用方业务」，为一个标注字段让整笔回流失败不划算。
     */
    subject?: Subject
    /**
     * 约定状态（v0.14.0）：这条回流记忆涉及的事**是否已被共同建立**
     * （`established` / `proposed` / `scoped` / `rejected`；缺省 = 未标注）。
     * 同走**容错归一**（认别名、认不出即未标注）——服务通道不为标注字段阻塞调用方。
     */
    grounding?: Grounding
    /**
     * 时效维（v0.15.0）：复查死线（`YYYY-MM-DD` / ISO 时刻 / 相对写法 `+7d` / `+2w`）
     * 与观察条件（1–8 条短句）。同走**容错归一**（认不出即不设）——服务通道不为标注字段
     * 阻塞调用方。用途：调用方回流「**会腐化的运行态结论**」时（如某通道当前可用率、
     * 某依赖的版本或路径），顺手登记「它该在什么时候被重看」与「什么新信息会让它失效」。
     */
    reviewAfter?: string
    watchFor?: string[]
    /**
     * 生效时间（v0.24.0）：这条回流记忆的结论**从何时开始成立**（`YYYY-MM-DD` / ISO 时刻）。
     * 同走**容错归一**（认不出即不设）——服务通道不为标注字段阻塞调用方。
     * 用途：回流「追认的历史结论」时（如某个定调其实上周就生效了）。
     */
    validAfter?: string
  }): Promise<{ id?: string; action?: string; error?: string }>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    memoryApi: MemoryApiService
  }
}

/** 插件配置：总结路由（空字符串 = 跟随会话当前路由，DESIGN.md §十）+ 周期补压参数（v0.3） */
export interface Config {
  provider?: string
  model?: string
  maxTokens?: number
  /** 周期补压间隔（分钟；0=禁用；缺省 360=6 小时） */
  compressIntervalMinutes?: number
  /** 启动延迟首跑（秒；补历史缺口；缺省 30） */
  compressInitialDelaySeconds?: number
}

export const Config: z<Config> = z.object({
  provider: z.string().default(''),
  model: z.string().default(''),
  maxTokens: z.number(), // schemastery object 字段默认可选（interface 保持 maxTokens?: number）
  compressIntervalMinutes: z.number().default(360),
  compressInitialDelaySeconds: z.number().default(30),
})

/** summarize 直调配置（由插件配置转写） */
function toSummarizerConfig(config: Config): SummarizerConfig {
  return { provider: config.provider ?? '', model: config.model ?? '', maxTokens: config.maxTokens }
}

/**
 * 插件装配。
 * @param ctx - 插件上下文（storageDomain / tools / llm 已注入）
 * @param config - 插件配置
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  // HMR probe（2026-08-14）：若终端出现本行且时间戳新于 build 时刻 → 热重载生效
  console.log('[dsh-agent-memory] apply', new Date().toISOString(), '(HMR probe)')
  // 1. 开持久化域（生命周期随插件 dispose）
  const domain = await ctx.storageDomain.open(memoryDomainSpec)
  ctx.effect(() => () => domain.close(), 'agent-memory.domainClose')
  const store = new MemoryStore(domain.table('entries'))
  // 关系层（v0.28.0 · 方案 §4.4）：独立表，节点存在性由工具层校验
  const relations = new RelationStore(domain.table('relations'))
  // 主题词表（v0.29.0 · 方案 §4.2）：独立表，标签唯一性由 ConceptStore 校验
  const concepts = new ConceptStore(domain.table('concepts'))
  // 实体权威档（v0.30.0 · 方案 §4.3）：独立表，撞名/合并/引用由 EntityStore 校验
  const entities = new EntityStore(domain.table('entities'))
  // 来源实体（v0.35 · 方案 §5.2）：独立表；类型/位置必填、可靠度与权限**无默认值**
  const sources = new SourceStore(domain.table('sources'))

  // 侧车用量轨迹（v0.6 价值体检器的用量信号）——**只追加 / 吞错 / 按体积轮转**，绝不改条目。
  // 路径约定与既有插件同源：`<DSH_HOME>/<plugin>-trace.jsonl`。
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const accessTracePath = join(dshHome, 'memory-access-trace.jsonl')
  // 提案日志（v0.7 §5.11）：audit 候选 + forget/update 动作同文件、可按 id join ⇒ 校准样本
  const proposalLogPath = join(dshHome, 'memory-audit-proposals.jsonl')
  // 已裁决标记（v0.11.2）：体检候选的裁决留痕 ⇒ 同一批候选不再**每次体检重报**。
  // 复用提案日志的 append 原语（同纪律：只追加 / 吞错 / 按体积轮转）。
  const reviewLogPath = join(dshHome, 'memory-review-marks.jsonl')
  // 压缩流水线轨迹（v0.8 §5.12）：回答「这一轮扫描看到了什么、**为什么这个桶没压**」
  // ——跨条目巡检发现 09-13/09-14 日概要与 W37 周概要缺失，而当时五问③「断在哪一段」答不了。
  const compressTracePath = join(dshHome, 'memory-compress-trace.jsonl')
  const recordAccess: NonNullable<MemoryToolDeps['recordAccess']> = (record) =>
    appendAccessTrace(accessTracePath, record, DEFAULT_AUDIT_CONFIG.accessTrace.maxBytes)
  const readAccess: NonNullable<MemoryToolDeps['readAccess']> = () => readAccessIndex(accessTracePath)
  const readAccessSummary: NonNullable<MemoryToolDeps['readAccessSummary']> = () =>
    readAccessSummaryFromTrace(accessTracePath)
  const recordProposal: NonNullable<MemoryToolDeps['recordProposal']> = (record) =>
    appendProposalRecord(proposalLogPath, record, DEFAULT_AUDIT_CONFIG.proposalLog.maxBytes)
  const recordReviewMark: NonNullable<MemoryToolDeps['recordReviewMark']> = (id, note) =>
    appendProposalRecord(reviewLogPath, { atMs: Date.now(), kind: 'review-mark', id, note }, DEFAULT_AUDIT_CONFIG.proposalLog.maxBytes)
  const readReviewMarks: NonNullable<MemoryToolDeps['readReviewMarks']> = () => readReviewMarksFromTrace(reviewLogPath)
  const readCompressSummary: NonNullable<MemoryToolDeps['readCompressSummary']> = () =>
    readCompressSummaryFromTrace(compressTracePath)
  // 近重复处置轨迹（2026-10-28 · lh-0f54524a）：记「撞车」与「处置」，让「提示过但没处置」变成可算的欠账。
  // 同纪律：只追加 / 吞错 / 按体积轮转；读取三态见 dedupe-trace.ts。
  const dedupeTracePath = join(dshHome, 'memory-dedupe-trace.jsonl')
  const recordDedupeTrace: NonNullable<MemoryToolDeps['recordDedupeTrace']> = (records) =>
    appendDedupeTrace(dedupeTracePath, records, DEFAULT_AUDIT_CONFIG.proposalLog.maxBytes)
  const readDedupeTrace: NonNullable<MemoryToolDeps['readDedupeTrace']> = () =>
    readDedupeTraceFromSidecar(dedupeTracePath)

  /**
   * 压缩轨迹接收器工厂（v0.8）：**每个 workspace 自己的 `audit.compress_trace` 说了算**
   * （enabled=false ⇒ 返回 undefined，压缩器完全不落轨迹）。落盘吞错（§5.22 规则 3）。
   */
  const makeCompressTrace = (
    cfg: { audit: { compressTrace: { enabled: boolean; maxBytes: number } } },
    trigger: 'lazy' | 'periodic',
  ): CompressTraceSink | undefined => {
    if (!cfg.audit.compressTrace.enabled) return undefined
    const maxBytes = cfg.audit.compressTrace.maxBytes
    return (event) => {
      void appendCompressTrace(compressTracePath, { atMs: Date.now(), trigger, ...event }, maxBytes)
    }
  }

  // 记忆回流服务提供（2026-09-06）：供 emotion/taskboard/evolution-core/skill-forge 注入消费。
  // 复用 store.remember（L1 key 覆盖 / L2/L3 指纹合并），容错返回 error 不抛。
  ctx.provide('memoryApi', {
    async remember(input: { text: string; kind?: 'fact' | 'knowledge' | 'episodic'; tags?: string[]; key?: string; scope?: string; subject?: Subject; grounding?: Grounding; reviewAfter?: string; watchFor?: string[]; validAfter?: string }) {
      try {
        const text = (input.text ?? '').trim()
        if (text.length === 0) return { error: 'text 不能为空' }
        const kind = input.kind ?? 'knowledge'
        const scope = input.scope ?? 'global'
        const body = text
        const firstLine = body.split(/\r?\n/).find((line) => line.trim().length > 0) ?? body
        const base = firstLine.trim()
        const title = base.length > 80 ? base.slice(0, 79) + '…' : base
        // 主体层（v0.13.0）：**容错归一**（认别名；认不出 = 通用）——服务通道不走 fail-loud，
        // 理由见 MemoryApiService.remember 的注释（不阻塞调用方业务）。
        const subject = normalizeSubject(input.subject)
        // 约定状态（v0.14.0）：同走**容错归一**——服务通道的契约是「不阻塞调用方业务」，
        // 为一个标注字段让整笔回流失败不划算（理由同上面 subject 那段注释）。
        const grounding = normalizeGrounding(input.grounding)
        // 时效维（v0.15.0）：同走**容错归一**——相对写法（`+7d`）在这里按**此刻**折算成绝对日期。
        const reviewAfter = normalizeReviewAfter(input.reviewAfter, new Date())
        const watchFor = normalizeWatchFor(input.watchFor)
        // 生效时间（v0.24.0）：同走**容错归一**——服务通道不为标注字段阻塞调用方。
        const validAfter = normalizeValidAfter(input.validAfter)
        const r = await store.remember({ kind, key: input.key, title, body, tags: input.tags ?? [], scope, level: null, bucket: null, ...(subject !== undefined ? { subject } : {}), ...(grounding !== undefined ? { grounding } : {}), ...(reviewAfter !== undefined ? { reviewAfter } : {}), ...(watchFor !== undefined ? { watchFor } : {}), ...(validAfter !== undefined ? { validAfter } : {}) })
        return { id: r.id, action: r.action }
      } catch (err) {
        return { error: 'memoryApi.remember 失败: ' + String(err) }
      }
    },
  })

  // 2. 配置加载：每个 workspace 自己的 .dsh/memory.yml（DESIGN.md §四）
  const loadConfig = async (workspaceRoot: string) => loadMemoryConfig(memoryConfigPath(workspaceRoot))

  // v0.3 周期补压路由：实时解析活跃会话的当前模型路由（原本设计——跟随会话 requestHeader，
  // 即「由主会话模型总结」，非默认/别的模型）；lastRoute 为懒压缩捕获的最近会话路由补充。
  // v0.8.1：路由必须与**会话 id** 同源取出——网关类 provider（opencode.ai）要求 `x-opencode-session`
  // 头，而该头只能由 `GenerateOptions.sessionId` 触发注入（机制见 summarizer.ts 注释）。
  let lastRoute: { provider: string; model: string; sessionId?: Agent['session']['id'] } | undefined

  /** 实时从活跃会话（ctx.agents.list）解析当前模型路由 **+ 会话 id**——与懒压缩的 requestHeader 同源 */
  function resolveActiveRoute(): { provider: string; model: string; sessionId?: Agent['session']['id'] } | undefined {
    try {
      for (const agent of ctx.agents.list()) {
        const header = agent.session.requestHeader()?.config
        if (header !== undefined && header.provider.length > 0 && header.model.length > 0) {
          return { provider: header.provider, model: header.model, sessionId: agent.session.id }
        }
      }
    } catch {
      // agents 服务不可用：忽略，交由上层路由链处理
    }
    return undefined
  }

  // 3. 懒压缩钩子：访问记忆时补压上一自然单位（fire-and-forget，幂等；失败静默下次重试）
  const compress: MemoryToolDeps['compress'] = async (scope, agent) => {
    if (scope === 'global') return // DESIGN.md §五：global 层不启用时间压缩
    // 捕获会话路由缓存（periodic 无 agent 上下文时回退用）
    if (agent !== undefined) {
      const header = agent.session.requestHeader()?.config
      if (header !== undefined && header.provider.length > 0 && header.model.length > 0) {
        lastRoute = { provider: header.provider, model: header.model, sessionId: agent.session.id }
      }
    }
    const cfg = await loadConfig(scope)
    if (!cfg.timeline.week && !cfg.timeline.month && !cfg.timeline.year) return
    const summarize: SummarizeFn = async (input) => {
      const result = await summarizeEntries(ctx, toSummarizerConfig(config), input, agent)
      return result.body
    }
    const compressor = new TimelineCompressor(store, cfg, summarize, makeCompressTrace(cfg, 'lazy'))
    await compressor.compressPending(scope)
  }

  /**
   * 概要重压（v0.11.3）：把一条已超预算的概要压回预算内。
   *
   * 输入是 **summaryId**（不是 level/bucket）——因为触发它的路径是 memory_audit 的候选，
   * 那里能拿到的就是 id；由 id 反查 scope/level/bucket 放在这一层，工具层保持薄。
   *
   * 三条与 `compress` 一致的边界：
   *   ① `global` 层不启用时间压缩（DESIGN.md §五）⇒ 直接返回 undefined；
   *   ② 只接受 `kind === 'summary'` 且 level/bucket 齐全的条目 —— 别的条目没有「桶」可重压；
   *   ③ **不落压缩轨迹**（传 undefined sink）：重压是**手动显式动作**，不是流水线的一环，
   *      混进 compress-trace 会让「为什么这个桶没压」的读数失真。
   */
  const recompress: MemoryToolDeps['recompress'] = async ({ summaryId, maxChars }) => {
    let hitScope = ''
    for (const s of store.scopes()) {
      const found = store.list(s, { includeArchive: true }).find((e) => e.id === summaryId)
      if (found !== undefined) { hitScope = s; break }
    }
    if (hitScope === '' || hitScope === 'global') return undefined
    const entry = store.get(hitScope, summaryId)
    if (entry === undefined || entry.kind !== 'summary' || entry.level === null || entry.bucket === null) {
      return undefined
    }
    const cfg = await loadConfig(hitScope)
    const summarize: SummarizeFn = async (input) => {
      // 路由来源（v0.11.4 修）：recompress 是**工具触发**、没有 agent 上下文 ⇒ 不能只靠 lastRoute
      // ——那个缓存在「懒压缩还没跑过」时是空的，实测首次调用直接 fail-loud「缺少 provider/model」。
      // 与 periodic 补压同一策略：**实时解析活跃会话路由优先，lastRoute 兜底**（复用 resolveActiveRoute）。
      const route = resolveActiveRoute() ?? lastRoute
      // ⚠ sessionId 必须**显式**传到第 7 参，不能靠 fallbackTarget 捎带（v0.11.5 修）：
      // 网关类 provider（opencode.ai）要求 `x-opencode-session` 头，而该头只能由
      // `GenerateOptions.sessionId` 触发注入 —— 实测漏传直接 400 `MissingSessionID`。
      // 这正是 summarizer.ts L122–128 注释里记着的 2026-09-15 事故同款坑（当时时间压缩 100% 失败）。
      // agent 路径（compress）由 `agent.session.id` 自动兜住；recompress 无 agent ⇒ 必须手传。
      const fallback = route !== undefined ? { provider: route.provider, model: route.model } : undefined
      const result = await summarizeEntries(ctx, toSummarizerConfig(config), input, undefined, undefined, fallback, route?.sessionId)
      return result.body
    }
    const compressor = new TimelineCompressor(store, cfg, summarize, undefined)
    const r = await compressor.recompressUnit(
      hitScope,
      entry.level,
      entry.bucket,
      maxChars !== undefined ? { maxChars } : {},
    )
    return { beforeChars: r.beforeChars, afterChars: r.afterChars, skipped: r.skipped, note: r.reason }
  }

  // 4. 注册记忆工具（remember/recall/update/forget/browse/relate/stats/audit/health/version/check）
  // 执行位置自动判定（v0.23.0）：与 `dsh-project-state` 联动的**唯一接缝**。
  //
  // 三个设计决定，每个都为了「缺了这个插件，记忆插件照常工作」：
  //   1. **软依赖**——`ctx.reflect.get(name, false)` 的 strict=false 让服务缺失时返回
  //      undefined 而不抛（直接写 `ctx.projectState` 会抛
  //      `cannot get property "projectState" without inject`，2026-11-15 实测）；
  //      写进 `inject` 就变成硬依赖，没装 project-state 的 profile 连记忆插件都起不来。
  //   2. **每次调用现取**，不在 apply 时缓存——插件可能在运行中装卸，缓存会把「当时没有」
  //      固化成「永远没有」（同 `dsh-project-orientation` 的写法）。
  //   3. **失败静默**——盖章是增值，不是前置条件；服务抛错不该让「记记忆」失败。
  const resolveProject: NonNullable<MemoryToolDeps['resolveProject']> = (cwd) => {
    try {
      const svc = ctx.reflect?.get('projectState', false) as
        | { resolveProjectByPath?: (p: string) => { projectId?: string } | null }
        | undefined
      const hit = svc?.resolveProjectByPath?.(cwd)
      return typeof hit?.projectId === 'string' && hit.projectId !== '' ? hit.projectId : undefined
    } catch {
      return undefined
    }
  }

  // 证据坐标（v0.25.0）：`ToolRunContext` 里没有事件号（2026-11-18 实测），
  // seq 只能从会话火线观察 ⇒ 订阅一次，维护「每会话最新 seq」。
  // 工具层写入时据此盖证据坐标；精度说明见 `types.ts::EvidenceRef.seq`
  // （答的是「写这条时对话进行到哪」，不是「这句出自哪条事件」）。
  const lastSeqBySession = new Map<string, number>()
  ctx.on('session/event', (session, event) => {
    const seq = (event as { seq?: unknown }).seq
    if (typeof seq === 'number') lastSeqBySession.set(session.id, seq)
  })
  const resolveEvidence: NonNullable<MemoryToolDeps['resolveEvidence']> = (sessionId) =>
    lastSeqBySession.get(sessionId)

  registerMemoryTools(ctx, { store, relations, concepts, entities, sources, loadConfig, compress, recompress, recordAccess, readAccess, readAccessSummary, recordProposal, recordReviewMark, readReviewMarks, readCompressSummary, recordDedupeTrace, readDedupeTrace, resolveProject, resolveEvidence })

  // 5. 启动注入（v0.2）：会话首 pre-step 注入记忆速览（目录化，预算约束）
  installMemoryInject(ctx, { store, loadConfig })

  // 5b. 自动 recall 注入（L3 2026-09-01）：每条新主人消息注入 top 命中（尾追加，缓存友好）
  installAutoRecallInject(ctx, { store, loadConfig, recordAccess })

  // 6. 压缩即记忆（v0.2 通道 C）：compaction 成功 → checkpoint 自动落库
  //    失败侧车（2026-11-12 · 台账 lh-2659bafb）：落库失败 = 这条原文**永久丢失**（pending 已删、
  //    下次是新 compactionId ⇒ 没有「下次再试」），所以必须留下可数的证据，不许空吞。
  installCompactionSink(ctx, {
    store,
    failureTracePath: join(dshHome, 'memory-compaction-sink-failures.jsonl'),
    failureTraceMaxBytes: DEFAULT_AUDIT_CONFIG.proposalLog.maxBytes,
  })

  // 7. 周期补压（v0.3，主人 2026-08-21 定调）：可靠触发时间桶压缩，不依赖「访问记忆才触发」。
  //    路由：config 显式 → resolveActiveRoute（活跃会话当前路由，同 requestHeader 原本设计）→ lastRoute 缓存
  const compressIntervalMs = (config.compressIntervalMinutes ?? 360) * 60_000
  const initialDelayMs = (config.compressInitialDelaySeconds ?? 30) * 1000
  if (compressIntervalMs > 0) {
    installPeriodicCompress(ctx, {
      store,
      loadConfig,
      summarize: (input) => {
        const route = resolveActiveRoute() ?? lastRoute
        if (route !== undefined) {
          console.log(`[dsh-agent-memory] 周期补压路由 ${route.provider}/${route.model}`)
        }
        // v0.8.1：把**会话 id** 一并交给总结器（网关类 provider 靠它注入 `x-opencode-session` 头）
        return summarizeEntries(
          ctx,
          toSummarizerConfig(config),
          input,
          undefined,
          undefined,
          route,
          route?.sessionId,
        ).then((result) => result.body)
      },
      traceFactory: (cfg) => makeCompressTrace(cfg, 'periodic'),
    }, {
      intervalMs: compressIntervalMs,
      initialDelayMs,
    })
  }
}
