/**
 * 工具注册（IMPLEMENTATION.md §4 / DESIGN.md §八）——六工具：
 * remember / recall / update / forget / memory_stats / memory_check。
 *
 * 取证结论（2026-08-14，注册方式已回写 IMPLEMENTATION.md §4）：
 * 采用官方 tool-fs（packages/fs/tool-fs/src/read.ts:76）与 dsh-agent-teams
 * （src/tools.ts:125）同款的函数插件形态：inject 'tools' 服务 + ctx.tools.register(defineTool(...))，
 * 经 bundle 挂载进 host 组合（T7 接线）。当前会话 workspace 取自
 * exec.agent.session.header.cwd（见 scope.ts 取证）。
 *
 * 质量协议（写入工具 description，模型视角）：
 * 记事实 / 可复用知识 / 有结果的情景；不记临时状态 / 文件可索引内容 / 凭证。
 */

import type { Context } from '@deepseek-ai/cordis'
import { readFileSync, statSync } from 'node:fs'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Entry, EntryKind, EvidenceRef, MemoryConfig, RecallEntityMatch, RememberResult, Revision } from './types.ts'
import { loadMemoryConfig, memoryConfigPath } from './config.ts'
import { resolveScopes, sessionCwdOf } from './scope.ts'
import type { EntryPatch, MemoryStats, MemoryStore } from './store.ts'
import { statsOf, titleFingerprint } from './store.ts'
import type { AccessSummary } from './access-trace.ts'
import type { CompressSummary } from './compress-trace.ts'
import { formatSkipped } from './compress-trace.ts'
import { browseEntries, bucketLabel } from './search.ts'
import { recallEntries, relatedOf, relateClosure } from './search.ts'
import { findNearDuplicates, formatCandidate, parseSimilarDisposition, unresolvedCandidates } from './dedupe.ts'
import type { DedupeTraceRecord, SimilarDisposition } from './dedupe.ts'
import { applyRoleView, narrowReadScopes, roleViewOf, sessionHeaderOf, sessionIdOf, type RoleView } from './role.ts'
import { countBySubject, filterBySubject, normalizeSubject, parseSubjectArg, subjectLabel, subjectTag, UNSPECIFIED_SUBJECT } from './subject.ts'
import { countByProject, executionTag, filterByExecution, normalizeProject, parseExecutionArgs, parseExecutionId } from './execution.ts'
import { countByGrounding, filterByGrounding, groundingTag, normalizeGrounding, parseGroundingArg, UNLABELED_GROUNDING } from './grounding.ts'
import { countByStaleness, cueTag, filterByStaleness, parseReviewAfterArg, parseStalenessFilterArg, parseWatchForArg, stalenessTag, stalenessVerdict, watchForTag } from './temporal.ts'
import { transcriptiveTag } from './origin.ts'
import { countByMemType, filterByMemType, memTypeTag, parseMemTypeArg, parseMemTypeFilterArg } from './memType.ts'
import { countBySpace, filterBySpace, parseSpaceArg, parseSpaceFilterArg, spaceTag } from './space.ts'
import { countByLifecycle, filterByLifecycle, lifecycleTag, parseLifecycleFilterArg, parseStatusArg } from './lifecycle.ts'
import { evidenceTag, formatEvidenceRef, parseEvidenceRefsArg } from './evidence.ts'
import { archivalOf, archiveReasonTag, countByArchiveReason, countByProvenance, filterByProvenance, parseArchiveReasonTypeArg, parseProvenanceArg, provenanceTag, PROVENANCE_TYPES } from './archive.ts'
import { filterBySuccession, parseSupersedesArg, parseSupersessionFilterArg, parseValidAfterArg, shortId, supersededByTag, supersedesTag, validAfterTag } from './succession.ts'
import { auditMemory } from './audit.ts'
import {
  RELATION_TYPE_SPECS,
  RELATION_TYPES,
  edgesOf,
  isRelationLive,
  parseConfidenceArg,
  parseRelationTypeArg,
  parseRelationTypesArg,
  parseValidTimeArg,
  structuralHitsOf,
  type RelationStore,
} from './relations.ts'
import {
  isConceptActive,
  labelsOf,
  type ConceptDraft,
  type ConceptStore,
} from './thesaurus.ts'
import {
  isEntityActive,
  matchesName,
  namesOf,
  normalizeEntityName,
  type EntityDraft,
  type EntityStore,
} from './entities.ts'
import type { SourcePatch, SourceStore, SourceType } from './sources.ts'

/** 概要重压的外部结果（工具层回报用；与 timeline.RecompressResult 解耦，界面只认这几个读数） */
export interface RecompressOutcome {
  /** 重压前正文长度（字符） */
  beforeChars: number
  /** 重压后正文长度（字符） */
  afterChars: number
  /** true = 未执行（原因见 note） */
  skipped: boolean
  /** 人类可读说明（含原因码） */
  note: string
}

/** 工具依赖：存储 + 配置加载（单测注入 mock 用） */
export interface MemoryToolDeps {
  /** 记忆存储（T7 用 storage-domain kv 表构造 MemoryStore） */
  store: MemoryStore
  /**
   * 执行位置自动判定（v0.23.0）——与 `dsh-project-state` 联动的**唯一接缝**。
   *
   * ## 为什么是回调，不是 import
   *
   * 消费方**不 import 提供方**：那样会变成构建期硬依赖，没装 `dsh-project-state` 的
   * profile 连记忆插件都起不来。`index.ts` 用 `ctx.reflect.get('projectState', false)`
   * （cordis 的可选服务读取）取到服务、包成这个纯函数传进来；服务不在时传 `undefined`，
   * 工具层**静默降级为「不盖章」**——绝不因为缺一个可选插件让「记记忆」失败。
   *
   * ## 为什么只有这一个方法
   *
   * 工具层需要的只有一件事：**这个目录属于哪个项目**。最小接口 = 最小耦合；
   * 别的方法（取任务列表 / 写回状态）不属于记忆插件的职责，需要时再加。
   *
   * @param cwd - 当前会话工作目录（已由 `sessionCwdOf(exec)` 取出）
   * @returns 项目 id；无归属返回 `undefined`（**不猜**）
   */
  resolveProject?: (cwd: string) => string | undefined
  /**
   * 证据坐标（v0.25.0）：该会话**当前最新的事件序号**。缺省 ⇒ 只盖会话级坐标。
   *
   * 为什么由外部注入：`ToolRunContext` 里没有事件号（2026-11-18 实测），seq 只能从
   * `session/event` 火线观察到；index.ts 订阅火线维护「每会话最新 seq」，工具层只读。
   */
  resolveEvidence?: (sessionId: string) => number | undefined
  /** 配置加载：workspace 根目录 → MemoryConfig；缺省读 <root>/.dsh/memory.yml */
  loadConfig?: (workspaceRoot: string) => Promise<MemoryConfig> | MemoryConfig
  /** 懒压缩钩子（T7 接线：TimelineCompressor.compressPending；访问记忆时补压上一自然单位，DESIGN.md §五） */
  compress?: (scope: string, agent?: Agent) => Promise<void>
  /**
   * 侧车用量轨迹写入（v0.6；缺省不落盘）。
   * 实现方负责「只追加 / 吞错 / 按体积轮转」——工具层只负责把命中 id 交出去。
   */
  recordAccess?: (record: { atMs: number; source: 'recall' | 'auto' | 'audit'; role?: string; ids: string[] }) => Promise<boolean> | void
  /**
   * 侧车轨迹读取（体检用；缺省/读失败 ⇒ undefined = 无用量信号）。
   * v0.12：每项还带 `attributed`（排序加权归因，见 access-trace.ts）——声明与实现对齐；
   * `attributed` 缺失时体检评分回退 `hits`（零回归）。
   */
  readAccess?: () => Promise<Map<string, { hits: number; lastAtMs: number; attributed?: number }> | undefined>
  /** 用量轨迹汇总（v0.7 命中率度量：注入次数 / 主动检索次数；缺省不报） */
  readAccessSummary?: () => Promise<AccessSummary | undefined>
  /** 提案日志写入（v0.7：让提案有历史——audit 候选 + forget/update 动作同文件可 join；吞错） */
  recordProposal?: (record: unknown) => Promise<boolean> | void
  /**
   * 已裁决标记写入（v0.11.2）：记「这条体检候选我已裁决过」，使下次体检不再反复报同一条
   * （今晚实测：同一批 15 条 REVIEW 会在每次体检里重复出现）。
   * 与 `recordProposal` 同纪律：只追加 / 吞错 / 按体积轮转。
   */
  recordReviewMark?: (id: string, note: string) => Promise<boolean> | void
  /** 已裁决标记读取（体检用；缺省/读失败 ⇒ undefined = 无标记信号，全部条目照常分档） */
  readReviewMarks?: () => Promise<Map<string, number> | undefined>
  /**
   * 概要重压（v0.11.3）：把一条已超预算的概要压回预算内。
   * 实现在 index.ts（需要 LLM 直调 + 压缩器）——工具层只负责解析参数与回报读数。
   * 缺省不接线 ⇒ 工具抛错（不假装成功）。
   */
  recompress?: (input: { summaryId: string; maxChars?: number }) => Promise<RecompressOutcome | undefined>
  /**
   * 压缩流水线轨迹汇总（v0.8 §5.12：五问里 ③「断在哪一段」的答案面）。
   * 缺省不报——工具层只展示，不判定。
   */
  readCompressSummary?: () => Promise<CompressSummary | undefined>
  /**
   * 近重复处置轨迹写入（2026-10-28 · lh-0f54524a）：记「这次撞车我处置了」或「这次撞上了」。
   * 与 `recordReviewMark` 同纪律：只追加 / 吞错 / 按体积轮转。
   */
  recordDedupeTrace?: (records: DedupeTraceRecord[]) => Promise<boolean> | void
  /**
   * 近重复处置轨迹读取（`memory_check` 用）。
   * ⚠ 缺省 / 读失败 ⇒ `undefined` = **读不到**，与「读到了、里面是空」严格分开——
   * 后者才是「零欠账」，前者只能说「不知道」。
   */
  readDedupeTrace?: () => Promise<DedupeTraceRecord[] | undefined>
  /**
   * 关系层（v0.28.0 · 方案 §4.4）：类型化边存储。
   *
   * 为什么**可选**：它是 v0.28 新增的接线点，19 个既有测试文件构造 deps 时不带它；
   * 强行必填会把「加一个维度」变成 19 个文件的机械改动（噪音淹没真正的判据）。
   * **可选不等于静默降级**：三个关系工具与 `memory_stats.relations` 在它为
   * `undefined` 时**响亮报错**（「关系层未接线」），绝不假装成功——silent skip 比缺能力更坏。
   */
  relations?: RelationStore
  /**
   * 主题词表（v0.29.0 · 方案 §4.2）：受控词表存储。
   *
   * 与 `relations` 同形的可选依赖（19 个既有测试文件构造 deps 时不带它）；
   * 未接线时概念工具与 `memory_stats.concepts` **响亮报错/明确标注**，不假装成功。
   */
  concepts?: ConceptStore
  /**
   * 实体权威档（v0.30.0 · 方案 §4.3）：实体档案存储。
   *
   * 与 `relations` / `concepts` 同形的可选依赖（既有测试文件构造 deps 时不带它）；
   * 未接线时两个实体工具与 `memory_stats.entities` **响亮报错 / 明确标注**，不假装成功。
   */
  entities?: EntityStore
  /**
   * 来源实体（v0.35 · 方案 §5.2）：来源档案存储。
   *
   * 与 `entities` 同形的可选依赖（既有测试构造 deps 时不带它）；未接线时两个来源工具
   * 与 `memory_stats.sources` **响亮报错 / 明确标注 `wired: false`**，不假装成功。
   */
  sources?: SourceStore
}

/** 缺省配置加载器：读取 .dsh/memory.yml，缺失走默认，非法 fail loud */
async function loadConfigDefault(workspaceRoot: string): Promise<MemoryConfig> {
  return loadMemoryConfig(memoryConfigPath(workspaceRoot))
}

/** 会话载体类型（roleViewOf / sessionHeaderOf 的鸭子类型输入） */
type RoleCarrierLike = Parameters<typeof roleViewOf>[1]

/**
 * 一次调用的运行时上下文：解析出的配置 + 会话 cwd + **调用者视野**（v0.5）。
 * 视野在唯一的入口处解析一次，所有读路径共用——避免各工具各推导一遍角色。
 * @param roleOverride - 工具参数显式指定的角色（最高优先）
 */
async function resolveRuntime(
  exec: ToolRunContext,
  deps: MemoryToolDeps,
  roleOverride?: string,
): Promise<{ config: MemoryConfig; cwd: string | undefined; view: RoleView }> {
  const cwd = sessionCwdOf(exec)
  const loader = deps.loadConfig ?? loadConfigDefault
  const config = await loader(cwd ?? process.cwd())
  const view = roleViewOf(config, exec as unknown as RoleCarrierLike, roleOverride)
  return { config, cwd, view }
}

/**
 * 写路径的角色盖章（v0.5）：
 * - `role` 只在**角色维度启用**或调用方**显式指定**时盖章——缺省不盖章 = 共享记忆（迁移安全：
 *   存量条目与未启用角色的项目行为不变）；
 * - `author` 无条件记录（溯源，与可见性无关）。
 */
function roleStampOf(
  exec: ToolRunContext,
  config: MemoryConfig,
  explicitRole: string | undefined,
): { role?: string; author: Entry['author'] } {
  const view = roleViewOf(config, exec as unknown as RoleCarrierLike)
  const header = sessionHeaderOf(exec as unknown as RoleCarrierLike)
  const sessionId = sessionIdOf(exec as unknown as RoleCarrierLike)
  const author: Entry['author'] = {
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(header?.delegationDepth !== undefined ? { delegationDepth: header.delegationDepth } : {}),
    ...(header?.agentPreset !== undefined ? { preset: header.agentPreset } : {}),
  }
  const explicit = explicitRole?.trim()
  const role = explicit !== undefined && explicit.length > 0
    ? explicit
    : (view.enabled ? view.role : undefined)
  return { ...(role !== undefined ? { role } : {}), author }
}

/**
 * 证据戳（v0.25.0）：写入时能确定的坐标就盖，不确定的就空着。
 *
 * 只盖「我知道的」：会话 id 一定知道（`sessionIdOf`），事件序号只在火线订阅到了才有。
 * **不猜**——宁缺一个 seq，也不写一个假坐标（那会让「可追溯」变成不可核的字段）。
 * @param exec - 工具执行上下文
 * @param deps - 工具依赖（`resolveEvidence` 可选）
 * @returns 可并入 EntryDraft 的补丁；无会话 id 时返回空对象
 */
function evidenceStampOf(
  exec: ToolRunContext,
  deps: MemoryToolDeps,
): { evidenceRefs?: Entry['evidenceRefs'] } {
  const sessionId = sessionIdOf(exec as unknown as RoleCarrierLike)
  if (sessionId === undefined || sessionId === '') return {}
  const seq = deps.resolveEvidence?.(sessionId)
  return { evidenceRefs: [formatEvidenceRef({ kind: 'session', sessionId, ...(seq !== undefined ? { seq } : {}) })] }
}

/**
 * 记录一次显式动作到提案日志（v0.7 §5.11 的动作侧；吞错，绝不影响主流程）。
 * 与 `memory_audit` 写的 `audit` 记录同文件，可按 id join ⇒ 为权重校准攒「提案 vs 采纳」样本。
 */
function recordAction(
  deps: MemoryToolDeps,
  config: MemoryConfig,
  record: { action: 'forget' | 'update' | 'supersede'; id: string; reason?: string; mode?: string },
): void {
  if (config.audit?.proposalLog?.enabled !== true || deps.recordProposal === undefined) return
  void deps.recordProposal({ atMs: Date.now(), kind: 'action', ...record })
}

/**
 * 读路径统一取数：作用域合并 → 视野收窄 → 角色准入过滤（v0.5）。
 * 所有读工具（recall / browse / relate / stats）必须走这里——**单点过滤**，
 * 否则「recall 过滤了但 browse 没过滤」= 隔离是假的。
 */
function gatherReadable(
  deps: MemoryToolDeps,
  opts: { readScopes: string[]; includeArchive: boolean; view: RoleView; explicitScope?: string },
): { entries: Entry[]; scopes: string[] } {
  const scopes = narrowReadScopes(opts.readScopes, opts.view, opts.explicitScope)
  const entries = scopes.flatMap((scope) => deps.store.list(scope, { includeArchive: opts.includeArchive }))
  return { entries: applyRoleView(entries, opts.view), scopes }
}

/** action → 中文文案（工具 render 用） */
const ACTION_TEXT: Record<RememberResult['action'], string> = {
  created: '创建',
  updated: '更新',
  merged: '合并',
}

/** 标题最大长度（超长截断加省略号） */
const TITLE_MAX = 80

/** 正文 → (标题, 正文)：首行作标题，全文作正文（正文保留 markdown 全文，检索不丢内容） */
function splitText(text: string): { title: string; body: string } {
  const body = text.trim()
  const firstLine = body.split(/\r?\n/).find((line) => line.trim().length > 0) ?? body
  const base = firstLine.trim()
  const title = base.length > TITLE_MAX ? base.slice(0, TITLE_MAX - 1) + '…' : base
  return { title, body }
}

/** 在多个作用域中按 id 定位条目（update/forget 用；id 全局唯一，跨 scope 找） */
function findEntry(store: MemoryStore, scopes: string[], id: string) {
  for (const scope of scopes) {
    const entry = store.get(scope, id)
    if (entry !== undefined) return entry
  }
  return undefined
}

/** 计数合并（memory_stats 跨作用域聚合用） */
function mergeCounts(target: Record<string, number>, source: Record<string, number>): void {
  for (const [key, value] of Object.entries(source)) {
    target[key] = (target[key] ?? 0) + value
  }
}

/** 构建 remember 工具 */
function buildRemember(deps: MemoryToolDeps): ToolDefinition {
  return defineTool({
    name: 'remember',
    description: '记录一条记忆。适用于：事实（主人偏好/环境事实/决策结论）、可复用知识（项目知识/学习沉淀/教训）、有结果的情景（重要事件/经历时间线）。不记录：临时状态、文件可索引内容（代码/文档全文）、凭证（密钥/口令）。L1 事实可用 key 精确覆盖（同 key 再次写入=更新）；L2/L3 同标题自动合并（标签并集+正文追加）。**写入前不会自动查重**（2026-11-12 下线，判据不可行——证据见 `src/dedupe.ts` 顶部）：要「先搜再写」（§5.8）就用 `dryRun:true` 显式预检，它会返回候选；L1 同 key 精确覆盖与 L2/L3 同标题自动合并仍照常生效。**`aliases` 强烈建议填**（2026-10-13 重做）：检索是字面匹配，而「记忆的措辞 ≠ 提问的措辞」——实测三个案例靠补别名从 #2/#4/#5 全部升到 #1。',
    parameters: {
      text: { type: 'string', required: true, description: '记忆内容（markdown；首行自动作为标题）。' },
      key: { type: 'string', description: 'L1 精确覆盖键：同一 (scope, key) 再次写入 = 覆盖更新。' },
      kind: { type: 'string', enum: ['fact', 'knowledge', 'episodic'], description: '层级：fact=事实 / knowledge=知识 / episodic=情景。缺省 knowledge。' },
      tags: { type: 'array', items: { type: 'string' }, description: '检索标签（可选）。' },
      aliases: { type: 'array', items: { type: 'string' }, description: '**检索别名**：这条记忆**可能被怎么问**的同义表述（与 tags 同级参与打分 ×3）。**为什么要填**：检索是按字面匹配的，而记忆的措辞常与提问的措辞不同——实测（2026-10-13）：标题「把别人的『未找到』转述成『不存在』」完全不含查询「我的错误 教训 误判 修正」里的任何实词 ⇒ 排第 5；补上别名（我的错误/我犯的错/误判/修正/虚假断言）后升到 **#1**。**怎么填**：想「以后我会用什么词来找这条」，通常 4-8 个短语，含口语问法（如「服务起不来」）与同义术语（如「宿主故障」）。' },
      scope: { type: 'string', description: '写入作用域覆盖：global 或 workspaceId（缺省按项目 memory.yml 路由）。' },
      role: { type: 'string', description: '角色归属（v0.5 多智能体工作台）：条目归属的角色隔间。缺省时——项目启用 roles 则盖调用者角色，否则为共享记忆（所有角色可见）。' },
      subject: { type: 'string', description: '主体层（v0.13.0）：这条记忆**关于谁**——`self`（关于我：我的判断/错误/成长/决策理由）或 `master`（关于主人：主人的偏好/定调/习惯/反馈）。缺省 = **通用**（技术知识/项目工作/外部论文这类不关于特定主体的）。⚠ 它不是隔离：设了 subject 的条目**依然对所有调用方可见**，只是可被过滤与统计。只在**新建**时盖章；命中已有条目（key 覆盖/标题合并）时不覆盖原标注——纠正用 update。' },
      memType: { type: 'string', description: '内容分类（v0.26.0 · 方案 §3.1 七类）：这条记忆**是哪一类馆藏**——`episodic` 情景（发生过的事/对话/经历）/ `semantic` 语义（稳定事实与结论）/ `procedural` 程序（怎么做/工作流/经验）/ `profile` 画像（关于主人的持久偏好）/ `project` 项目（目标/进度/决策）/ `relational` 关系（实体之间的关联）/ `operational` 运行（工具经验/失败原因/环境限制）。可与 `kind` 不同——`kind` 是存储与粒度轴，本字段是内容性质轴。**没有默认值**：不填 = 未分类（统计单列），不替你猜。只在新建设章；改判用 update。' },
      space: { type: 'string', description: '空间归属（v0.27.0 · 方案 §3.2 四空间）：这条知识属于**谁的疆域**——`personal` 个人（关于我与主人的偏好/画像/关系）/ `project` 项目（某个工程的目标/进度/决策）/ `domain` 领域（跨项目可复用的领域知识）/ `system` 系统（运行环境锚点、工具失败原因、通道纪律）。与 `scope` 不同：scope 是存储分区与准入，本字段是知识归属。**没有默认值**：不填 = 未标注（统计单列；授权策略对它 fail-closed）。' },
      status: { type: 'string', description: '生命周期（v0.27.0 · 方案 §3.3）：只接受 `pending` 待审核（候选区——**不进注入**，审核通过用 `update({status:\"\"})`）与 `disputed` 存疑（可见可注入但打标）。不填 = 常态（active）。⚠ 其余三态走既有载体：superseded 用 memory_supersede、archived/deleted 用 forget。' },
      project: { type: 'string', description: '执行位置·领域（v0.23.0）：这条记忆是在**哪个项目**里得到的（如 `alice` / `pp`）。**缺省自动判定**——按会话工作目录查项目注册表（`dsh-project-state`），命中则盖章、没有则留空（不猜）。**什么时候要显式给**：① 在别的目录里干活时（注入只覆盖会话 cwd）② 想纠正自动判定。⚠ 与 `scope` 不同：scope 是存储分区与准入（值是路径，目录改名就漂），本字段是语义标记（只是可选筛子，不改变可见性）。⚠ **通用知识不要盖项目标记**（不属于任何项目的方法论 / 外部论文）——自动判定可能盖错，用 `update({ project: "" })` 清除。' },
      taskId: { type: 'string', description: '执行位置·节点（v0.23.0）：这条记忆是在**哪个任务**里得到的（`dsh-project-state` 的任务 id，如 `ps-4a2b`）。**只在 project 内唯一** ⇒ 给 taskId 必须同时给 project，否则报错。**不自动判定**——「这条记忆是否来自该任务」是判断，不由机制替你断言；只在确实是从某个任务里得到结论时才填。用途：项目侧可反查「这个任务留下了哪些经验」，记忆侧可按任务聚合出**执行路径**（而不是按内容相似度捞条目）。' },
      grounding: { type: 'string', description: '约定状态（v0.14.0）：这条记忆涉及的事**是否已被主人与我共同建立**——`established`（主人明确说过/定调过）· `proposed`（**我自己提的、主人未回应**）· `scoped`（主人接受但限定范围）· `rejected`（主人否决过）。缺省 = 未标注。⚠ **写入纪律**：我提出的、主人没回应的方案，**必须标 `proposed`**——否则未来的我会把它当成「主人说过的」而当授权用（论文实测：未接受提议被记成「已确认信息」的比例高达 86–100%）。' },
      reviewAfter: { type: 'string', description: '复查死线（v0.15.0）：这条结论**该在什么时候被重看**——那是「未来的我执行它」的时刻。接受 `YYYY-MM-DD`（如 2026-11-01）/ ISO 时刻 / 相对写法 `+7d`（7 天后）或 `+2w`（2 周后）。**什么时候填**：这条结论依赖**会变的外部状态**时——环境坐标（端口/路径/版本号/目录布局）、工具或通道的可用率读数、别人的系统行为、价格与限额、尚未定稿的方案。**什么时候不填**：结论永久成立时（原则 / 教训 / 主人偏好 / 我的代码风格 / 已发生事件的事实）——**空是常态，填是例外**。⚠ 到期**不等于作废**，只表示该去核实；核实后 `update` 续新死线或清除。' },
      watchFor: { type: 'array', items: { type: 'string' }, description: '观察条件（v0.15.0）：**什么样的新信息会让这条失效**（1–8 条短句，每条 ≤200 字）。**为什么值得填**（论文实测）：决策时写下的观察条件能达 92.2% 的关键新信息、只带 20 条无关噪音；而「把全部背景事实都索引上」虽达 100%，却带 89 条噪音——**少而准**才划算。**怎么填**：写「什么事件会让它不成立」，点名具体实体（含它的**别名**与**上游依赖**），**略去用不到的**。例：`["DuckDuckGo 通道可用率重测低于 80%", "busDir 或 web 端口改变", "该插件被卸载或改名"]`。**写入时机只有一次——就是现在**（我记得为什么这样判断）；事后再补，我想不起当时在等什么。它会被印在 recall 结果里，命中的那一刻我就看见「它在等什么」。' },
      provenance: { type: 'string', description: '来源类型（v0.21.0）：这条记忆的信息**从哪来**——`master`（主人说的：原话 / 指令 / 定调 / 纠正）/ `web`（外部：网页 / 论文 / 他人代码 / 第三方工具输出）/ `self`（**我自己推出或提议的**）/ `measured`（我实测 / 运行 / 读数得到的）。**为什么填**：`grounding` 只覆盖「需要授权判断」的条目（约 7%），技术结论、论文笔记、实测读数全落在它之外——于是「这条是我实测的还是我从网上读来的」在库里无法区分，而两者该怎么用完全不同（读数要问样本多大，网上读来的要回原文核对）。**什么时候不填**：真的想不起来源时留空（省略 = 不知道，不是某个默认值）。⚠ 与 `grounding` 不冲突、可同时填：一条「主人否决了 RAG」既是 `master` 又可以是 `established`。' },
      cue: { type: 'array', items: { type: 'string' }, description: '情境形状（v0.16.0）：这条经验**在什么形状的情境下该被取出使用**（1–8 条短句）。与另两维**不可互相替代**：`aliases` 管**入口词**（可能被怎么问）、`watchFor` 管**时效**（什么新信息会让它失效）、`cue` 管**应用场景**（什么处境该用它）。**怎么填**：写情境的**形状**而不是本次任务的事实，才能在**另一件事**上触发。论文给的判据线（Harness² 的 experience cue）：太泛无用（`be thorough`）；太具体永不触发（`某日某费用涨到 250`）；正好是「当仪器执行若干顺序动作、且其中一个会终止行动者自身的权限时，把终止性动作排在最后」。它会被印在 recall 里——命中的那一刻我就看见「什么处境该用它」。' },
      validAfter: { type: 'string', description: '生效时间（v0.24.0）：这条结论**从何时开始成立**——`YYYY-MM-DD`（如 2026-11-01）或 ISO 时刻（如 2026-11-01T09:00:00Z，取 UTC 日）。**与 createdAt 不是一回事**：createdAt 答「我什么时候记下」，本字段答「这件事什么时候开始为真」——主人的定调可能今天记下、针对的是上周的决定。**什么时候填**：这条结论所描述的事**早于/晚于**我记下它的时刻时（追记历史决定、追认已生效的规则、登记从某日起适用的约定）。**什么时候不填**：写入时刻就是事实起点时（大多数情况）——⚠ **空是常态，填是例外**；省略 = 不知道，**不是**「等于 createdAt」（别拿它凑时间线）。⚠ **不接受相对写法**（`+7d`）——它答既成事实，不是死线（要死线请用 reviewAfter）。' },
      dryRun: { type: 'boolean', description: '预检（v0.19.1 · lh-0f54524a）：**只跑近重复检测、返回候选与强度，不落库**。⚠ 2026-11-12 起这是这条检测器**唯一**的入口（写入路径不再自动跑它，见 `src/dedupe.ts` 顶部证据）。它**宁滥勿缺**：会列出一批字面相关的条目供你自己筛，`强度` 是绝对计数、**不代表语义相似**。仍值得走它而不是先 `recall`，因为两者候选集**不同源**（实测：先 recall 搜「测试期望写错」返回 96 条却不含真正的母条目，而这条检测器报出了它）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          // ⚠ 同一个工具有两种形态，必填项不同（dryRun 没有 id/action——没有写入就没有它们）。
          // 用 additionalProperties:false + 一个显式 dryRun 分支表达，比 oneOf 更好读；
          // 代价是非 dryRun 形态的「必有 id」从 schema 层降到了渲染层守卫（见 render 的第一行）。
          id: { type: 'string', description: '条目 id（**dryRun 时不出现**——没有写入就没有 id）' },
          action: { type: 'string', enum: ['created', 'updated', 'merged'], description: '本次写入的结果：新建 / 补写 / 合并进同名条目（**dryRun 时不出现**）' },
          dryRun: { type: 'boolean', description: 'true = 只做了近重复检测、**未落库**；此时 id / action 均不出现' },
          similar: { type: 'array', items: { type: 'string' }, description: '（**仅 dryRun 形态**）字面相关候选（`id — 标题（强度 N）`；有内容时附一行「节：小节标题 / …」，让人不必再去读正文就能判断覆盖范围）；无候选时省略该键' },
          hint: { type: 'string', description: '（**仅 dryRun 形态**）与候选无关的补充警告（如「库已满」）；无内容时省略该键' },
        },
      },
      render: (args, value) => {
        if (value.dryRun === true) {
          const lines = ['dry-run：**未落库**。近重复检测用的是 `remember` 自己的检测器（不是 `recall` 的候选集）；⚠ 2026-11-12 起它只在 `dryRun` 里跑，写入路径不再自动查重。']
          const sim = value.similar
          if (sim !== undefined && sim.length > 0) {
            lines.push(`列出 ${sim.length} 条字面相关候选（**宁滥勿缺，「强度」是绝对计数、不代表语义相似**，请自己筛）：`)
            for (const s of sim) lines.push(`  - ${s}`)
            lines.push('下一步：判为真重复就 `update` 补写或 `memory_merge` 合流；判为无关则直接正式写入（不会再产生待处置欠账）。')
          } else {
            lines.push('这个检测器没列出候选 ⇒ 可以正式写入（去掉 `dryRun`）。⚠ 这不等于 `recall` 也搜不到——两者候选集不同源，而且**字面不相关 ≠ 语义不重复**。')
          }
          // hint 必须**无条件**印出：它不只装近重复提示，也装「库已满」这类与候选无关的警告。
          // 2026-11-03 测试抓到过一版把它嵌进「有候选」分支里 ⇒ 库满提示整条被吞掉，
          // 而回执照样说「可以正式写入」——正是「以为能写、其实会被拒」的形状。
          if (typeof value.hint === 'string' && value.hint.length > 0) lines.push(value.hint)
          return [{ type: 'text', text: lines.join('\n') }]
        }
        // 非 dryRun 形态必须同时有 id 与 action：这不是风格问题，缺了就是内部契约破了 → 响亮报错
        if (value.id === undefined || value.action === undefined) {
          return [{ type: 'text', text: '⚠ remember 返回缺 id / action（非 dryRun 形态必须有这两个字段）——内部契约破损，不要把这个当成功。' }]
        }
        // 写入形态的回执只报结果本身：`similar` / `hint` / 欠账计数都是 dryRun 形态的东西（2026-11-12 起）
        return [{
          type: 'text',
          text: `已${ACTION_TEXT[value.action]}记忆条目 ${value.id}（${args.kind ?? 'knowledge'}）`,
        }]
      },
    },
    async execute(args, exec) {
      const { config, cwd } = await resolveRuntime(exec, deps)
      const text = (args.text ?? '').trim()
      if (text.length === 0) throw new Error('remember: text 不能为空')
      const kind = args.kind ?? 'knowledge'
      // 层级受项目配置约束（layers 声明本项目记忆形态）
      if (!config.layers.includes(kind)) {
        throw new Error(`remember: 本项目 memory.yml 未启用 ${kind} 层（layers: ${config.layers.join(' / ')}），请改用已启用层或调整配置`)
      }
      const tags = args.tags ?? []
      // 主体层（v0.13.0）：**显式给值才盖章**——不猜（猜错会静默污染检索，错标比不标更坏）；
      // 非法值 fail-loud（parseSubjectArg），不静默降级成通用。
      const subject = parseSubjectArg(args.subject, 'remember.subject')
      // 内容分类（v0.26.0）：参数路径 fail-loud（拼错当场报），不静默当未分类
      const memType = parseMemTypeArg(args.memType, 'remember.memType')
      const space = parseSpaceArg(args.space, 'remember.space')
      const status = parseStatusArg(args.status, 'remember.status')
      // 约定状态（v0.14.0）：同纪律——**显式给值才标**，非法值 fail-loud
      // （静默降级成「未标注」正是本维度要防的那种失败：以为标了、其实没标）。
      const grounding = parseGroundingArg(args.grounding, 'remember.grounding')
      // 时效维（v0.15.0）：同纪律——**显式给值才设**，非法值 fail-loud（静默当「无死线」
      // 正是本维度要防的失败：我以为标了、其实没标，未来的我照旧拿过期结论当前提）。
      // ⚠ 相对写法（`+7d` / `+2w`）在这里**固化成绝对日期**——存相对值会让「何时到期」
      // 随「何时读取」漂移（同一个 +7d，今天读是 7 天后、明天读还是 7 天后 ⇒ 永不到期）。
      const rememberNow = new Date()
      const reviewAfter = parseReviewAfterArg(args.reviewAfter, rememberNow, 'remember.reviewAfter')
      const watchFor = parseWatchForArg(args.watchFor, 'remember.watchFor')
      // 来源类型（v0.21.0）：同纪律——**显式给值才盖章**，非法值 fail-loud
      // （静默当「未标注」正是本维度要防的失败：我以为标了、其实没标）。
      const provenance = parseProvenanceArg(args.provenance, 'remember.provenance')
      // 生效时间（v0.24.0）：同纪律——**显式给值才设**，非法值 fail-loud
      // （静默当「不知道」正是本维度要防的失败：我以为记下了生效时间、其实没记，
      // 未来的我照旧把「写作时刻」当「事实起点」）。⚠ 不收相对写法（理由见 succession.ts）。
      const validAfter = parseValidAfterArg(args.validAfter, 'remember.validAfter')
      // 执行位置（v0.23.0）：与 `dsh-project-state` 联动的**那一跳**。
      //   - `project` 缺省**自动判定**：cwd 属于哪个已注册项目是**查表**（事实），不是判断；
      //   - `taskId` **不自动**：「这条记忆是否来自这个任务」是判断，不由机制替我断言
      //     （§1.3 禁自动决策 · 判断型字段禁默认值）。
      // ⚠ 自动判定会盖错（通用方法论写在项目目录里也是常事）⇒ 本维**必须**可清除
      //   （`update({ project: "" })`）且渲染可见（`executionTag`）——移植的是可见性，不是拦截。
      const execPos = parseExecutionArgs({ project: args.project, taskId: args.taskId }, 'remember')
      const autoProject = execPos.project !== undefined || cwd === undefined || deps.resolveProject === undefined
        ? undefined
        : deps.resolveProject(cwd)
      const project = execPos.project ?? normalizeProject(autoProject)
      const taskId = execPos.taskId
      const { writeScope } = resolveScopes({ configScope: config.scope, cwd, explicit: args.scope })
      const { title, body } = splitText(text)
      // max_entries 守卫：仅当会新建时拦截（更新/合并不受限）
      const active = deps.store.list(writeScope)
      const wouldCreate = !(
        (args.key !== undefined && active.some((entry) => entry.key === args.key))
        || ((kind === 'knowledge' || kind === 'episodic')
          && active.some((entry) => entry.kind === kind && titleFingerprint(entry.title) === titleFingerprint(title)))
      )
      // dryRun（v0.19.1 · lh-0f54524a）：只跑近重复检测、返回候选与强度，**不落库**。
      // 为什么必须复用这里的检测器：`remember` 与 `recall` 的候选集**不同源**——2026-11-02 实测，
      // 先 recall 搜「测试期望写错」返回 96 条却**不含**真正的母条目 8b074a6e（标题「我的错误模式清单」
      // 与查询措辞零字面重叠），而随后 remember 把它报了出来。⇒ 预检若走 recall，恰好救不了
      // 「措辞不同、主题相同」这种情形，而那正是它该救的。
      // 放在 maxEntries 守卫**之前**：预检不写库，所以「库满」不该表现为抛错（那会连「会不会撞车」
      // 都问不出来）——它作为一条提示与候选一起返回。
      if (args.dryRun === true) {
        const dups = findNearDuplicates(active, { title, body, tags, kind, scope: writeScope })
        const fullNote = wouldCreate && active.length >= config.maxEntries
          ? `⚠ 库已满：${writeScope} ${active.length}/${config.maxEntries}，正式写入会被拒（先 forget 归档旧条目或调高配置）。`
          : ''
        // ⚠ 不返回近重复的 hint：`similar[]` 已列全候选与强度，再走一遍 formatDuplicateHint
        // 会让回执里同一份候选清单出现两遍（2026-11-03 上线后首次实调就看到了）。
        // 正式写入路径仍用 hint —— 那里没有 similar 的渲染位，需要一句话把该做什么说完。
        return {
          dryRun: true as const,
          ...(dups.length > 0 ? { similar: dups.map(formatCandidate) } : {}),
          ...(fullNote.length > 0 ? { hint: fullNote } : {}),
        }
      }
      if (wouldCreate && active.length >= config.maxEntries) {
        throw new Error(`remember: ${writeScope} 已达 max_entries(${config.maxEntries})，请先 forget 归档旧条目或调高配置`)
      }
      const written = await deps.store.remember({
        kind,
        key: args.key,
        title,
        body,
        tags,
        ...(args.aliases !== undefined && args.aliases.length > 0 ? { aliases: args.aliases } : {}),
        ...(args.cue !== undefined && args.cue.length > 0 ? { cue: args.cue } : {}),
        scope: writeScope,
        level: null,
        bucket: null,
        ...roleStampOf(exec, config, args.role),
        // 证据坐标（v0.25.0）：会话 + 写入时刻的事件序号（有则盖，不猜）
        ...evidenceStampOf(exec, deps),
        ...(subject !== undefined ? { subject } : {}),
        // 内容分类（v0.26.0）：没有默认值——不填就是未分类，不替你猜
        ...(memType !== undefined ? { memType } : {}),
        ...(space !== undefined ? { space } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(grounding !== undefined ? { grounding } : {}),
        ...(reviewAfter !== undefined ? { reviewAfter } : {}),
        ...(watchFor !== undefined ? { watchFor } : {}),
        ...(provenance !== undefined ? { provenance } : {}),
        // 生效时间（v0.24.0）：只在新建时盖章（store 层同形处理——命中已有条目时保留原值）。
        ...(validAfter !== undefined ? { validAfter } : {}),
        // 执行位置（v0.23.0）：两级不可拆——taskId 没有 project 时不落盘（见 execution.ts）。
        ...(project !== undefined ? { project } : {}),
        ...(project !== undefined && taskId !== undefined ? { taskId } : {}),
      })
      // ⚠ 自动近重复检测已于 2026-11-12 下线（判据不可行的三条硬证据见 dedupe.ts 顶部注释）。
      //
      // 后果是**有意**的、且要说清：
      //   - 写入路径不再跑相似度、不再写 `hit` 轨迹 ⇒ **也不会再产生「欠账」**
      //   - 「先搜再写」（主人 2026-09-17 的指令）的入口改为三处：
      //       ① 显式 `dryRun`（上面那一支，仍是 `remember` 自己的检测器）
      //       ② L1 同 key 精确覆盖
      //       ③ L2/L3 同标题自动合并
      //   - **已知缺口**：写入路径上现在没有布线化的「先搜」，剩下的是我在写之前的 `recall` 纪律。
      //     这不是我以为已经解决了的事——它记在长期台账上，替代方案要求先标定再上线（见 dedupe.ts 注释）。
      return {
        id: written.id,
        action: written.action,
      }
    },
  })
}

/**
 * 维度字段声明（v0.13–v0.15）——`recall` 与 `memory_browse` 的 item schema **共用同一份**。
 *
 * 为什么抽成常量（而不是两处各写一份）：v0.13 / v0.14 / v0.15 连续三版发生**同一漂移**——
 * `search.ts` 的共用投影层补了字段、`recall` 的 schema 补了字段，而 `memory_browse` 的
 * schema 一次都没跟上。后果不是「少个字段」：browse 的 execute 直接返回投影结果 ⇒ 线上被
 * harness 的 `additionalProperties: false` 校验整条拒收，**工具完全不可用**（2026-10-17 实测）；
 * 而单测全绿——因为它们直接调 `execute()`、绕过了 schema 校验这一跳。
 *
 * ⇒ 投影层注释写了三遍「新增字段必须贯穿投影层」都没拦住，因为漏的不是投影层而是它的**下游**。
 *   换机制承载（§5.39）：让「加字段」在结构上只可能改一处。
 * ⚠ 新增维度字段时**只改这里**——两侧 schema 与回归测试（tests/schema-parity.test.mjs）会自动跟上。
 *
 * 导出给测试：判据要能**从常量本身出发**遍历键（而不是在测试里枚举字段名——那会重蹈判据㉓
 * 「枚举式守卫在命名空间扩张时静默失效」）。tests/schema-parity.test.mjs 的 A118 断言
 * 「两侧展开的每个键都与本常量**引用相等**」⇒ 被拆回两份时立刻红。
 */
export const DIMENSION_ITEM_FIELDS = {
  subject: { type: 'string', enum: ['self', 'master'], description: '主体层（v0.13.0）：该条目关于谁；通用条目省略该键。' },
  project: { type: 'string', description: '执行位置·领域（v0.23.0）：这条记忆是在**哪个项目**里得到的（如 `alice` / `pp`）；通用条目省略该键。与 `scope` 不同——scope 是准入与存储分区（值是路径），本字段是语义标记（只是可选筛子，不改变可见性）。' },
  taskId: { type: 'string', description: '执行位置·节点（v0.23.0）：这条记忆是在**哪个任务**里得到的（server 侧任务 id）；**只在 `project` 内唯一**——无 project 时不透出该键（否则会被误读成项目名）。' },
  grounding: { type: 'string', enum: ['established', 'proposed', 'scoped', 'rejected'], description: '约定状态（v0.14.0）：该条是否已被共同建立；未标注条目省略该键（⚠ 省略 = 不知道，不等同于「已建立」）。' },
  reviewAfter: { type: 'string', description: '时效维（v0.15.0）：复查死线 `YYYY-MM-DD`；未设死线的条目省略该键。⚠ 档位（已过期 / N 天后复查）由**渲染层按当前时刻现算**，不预存——存了就会与读取时刻脱钩。' },
  watchFor: { type: 'array', items: { type: 'string' }, description: '时效维（v0.15.0）：观察条件——这条记忆在等什么新信息会让它失效；未设的条目省略该键。' },
  cue: { type: 'array', items: { type: 'string' }, description: '情境形状（v0.16.0）：这条经验适用的处境**形状**；未设的条目省略该键。与 watchFor（在等什么）不同，它答的是「什么处境该用它」。' },
  provenance: { type: 'string', enum: ['master', 'web', 'self', 'measured'], description: '来源类型（v0.21.0）：这条的信息**从哪来**——`master`（主人说的）/ `web`（外部：网页·论文·他人代码）/ `self`（我自己推出或提议的）/ `measured`（我实测·运行·读数得到的）。未标注的条目省略该键（⚠ 省略 = 不知道，**不是**某个默认来源）。与 grounding 正交：grounding 答「是否已被共同建立」，本字段答「信息从哪来」。' },
  archivedReasonType: { type: 'string', enum: ['refuted', 'merged', 'superseded', 'stale', 'capacity', 'deleted', 'unspecified'], description: '归档原因类型（v0.21.0 · v0.27 扩 `deleted`）：这条**怎么没了**——仅已归档条目出现。它决定引用它的活跃条目该怎么处置：`refuted`/`superseded`/`stale` ⇒ 结论不能再当依据（引用方必须撤或降置信）；`merged`/`capacity` ⇒ 内容仍在（换了位置 / 只是清位）；`deleted` ⇒ **我删掉它**（用户意图，区别于「它退役了」）；`unspecified` = 未判断（v0.20 及以前的存量归档）。' },
  archivedReason: { type: 'string', description: '归档原因详情（v0.21.0）：类型之外的人类可读补充；仅已归档且给了原因时出现。' },
  validAfter: { type: 'string', description: '生效时间（v0.24.0）：这条结论**从何时开始成立**（`YYYY-MM-DD`）。与 `createdAt`（我何时记下）不同——主人的定调可能今天记下、针对的是上周的决定。未设的条目省略该键（⚠ 省略 = **不知道**，**不是**「等于 createdAt」）。' },
  supersededBy: { type: 'string', description: '被替代（v0.24.0）：替代这条的记忆 id（**字段存在即已过时**；只记一格，不递归成链）。⚠ 旧条目**不会被删除**，仍会返回——保留原值正是为了对照（「以前是 X，因为…」）。' },
  supersedes: { type: 'array', items: { type: 'string' }, description: '替代了谁（v0.24.0）：被这条顶掉的记忆 id 列表（只记**直接**替代对象，不递归展开祖先）。' },
  evidenceRefs: {
    type: 'array',
    items: { type: 'string' },
    description: '证据引用（v0.25.0）：这条记忆**能回到哪里**，形如 `session|<会话id>|<事件号>` / `compaction|<会话id>|<压缩id>` / `derived|<定位>`。与 `provenance`（权威归谁）互补——那个答「谁说的」，这个答「去哪核」。⚠ 事件号是**写入时刻该会话的最新事件**（可回查「写这条时对话进行到哪」），不是「这句内容出自哪条事件」的精确指针。未带证据坐标的条目省略该键（省略 = 不知道，不是「无出处」）。',
  },
  memType: {
    type: 'string',
    enum: ['episodic', 'semantic', 'procedural', 'profile', 'project', 'relational', 'operational'],
    description: '内容分类（v0.26.0 · 方案 §3.1 七类）：情景 / 语义 / 程序 / 画像 / 项目 / 关系 / 运行。与 `kind`（存储与粒度轴）正交——它答「这是哪一类馆藏」，服务保留策略与任务路由。未分类的条目省略该键（⚠ 省略 = 不知道，**不折进任何一类**）。',
  },
  space: {
    type: 'string',
    enum: ['personal', 'project', 'domain', 'system'],
    description: '空间归属（v0.27.0 · 方案 §3.2 四空间）：个人 / 项目 / 领域 / 系统——这条知识属于**谁的疆域**。与 `scope`（存储分区与准入）正交：scope 答「放哪、谁看得见」，本字段答「属于谁的疆域」，服务独立授权（`role.spaces`）与检索分区。未标注的条目省略该键（⚠ 省略 = 不知道；设了 spaces 的授权策略对它 fail-closed）。',
  },
} as const

/**
 * **派生**字段（v0.27.0）：出现在结果项里，但**不是存储维度**——它由 `lifecycleOf()` 现算。
 *
 * 为什么不放进 `DIMENSION_ITEM_FIELDS`：那个常量的契约是「两侧 schema 的**可写维度**真源」，
 * 而 `lifecycle` 不可写（存储只有 `status` 两态 + `archived`/`archivedReasonType`/`supersededBy`
 * 三个既有载体）。放进去会让写入边界校验要求 `entrySchema` 声明它 ⇒ 等于开了一个
 * 「客户端可直写生命周期」的口子，而这正是本维度要避免的第二真源。
 */
export const DERIVED_ITEM_FIELDS = {
  lifecycle: {
    type: 'string',
    enum: ['active', 'pending', 'disputed', 'superseded', 'archived', 'deleted'],
    description: '生命周期六态（v0.27.0 · 方案 §3.3）：**派生值**（`lifecycleOf()` 统一判定，非存储字段直读）。优先级 deleted > archived > superseded > disputed > pending > active。`pending` 待审核（不进注入）/ `disputed` 存疑 / `superseded` 已被取代 / `archived` 已归档 / `deleted` 已删除（我删的，区别于退役）。',
  },
} as const

/** 构建 recall 工具 */
function buildRecall(deps: MemoryToolDeps): ToolDefinition {
  return defineTool({
    name: 'recall',
    description: '检索记忆。按关键词/层级/标签/时间过滤，按相关度（标签命中 > 标题命中 > 正文命中）与新鲜度排序；每个结果附带「相关链」（related：共享标签/标题/正文关联的记忆，因果留痕维度）。**每条都带 id**（主条目与相关链都有，可直接用于 update / forget / memory_merge）。结果标注来源作用域（global 或 workspaceId）与压缩层级（周概要/月概要等）。缺省检索当前项目 + global（全局记忆永远附加，来源在 scope 字段标注）。⚠ **返回「命中 0 条」时先看是否带了 suppressedTerms**：带了 = 查询词太泛被抑制（如「插件」「技能」这类高频概念词），**不等于没有相关记忆**，换更具体的词或加 tags/kind 过滤；没带 = 库里确实没有。',
    parameters: {
      query: { type: 'string', description: '检索关键词（多个词空格分隔，任一命中即计分；省略则按新鲜度排序）。' },
      kind: { type: 'array', items: { type: 'string', enum: ['fact', 'knowledge', 'episodic', 'summary'] }, description: '层级过滤（任一命中）。' },
      tags: { type: 'array', items: { type: 'string' }, description: '标签过滤（全部命中；**包含**匹配：给 `技能` 也命中 `技能维护`/`技能熔炉` 等变体，给 `技能维护` 只命中该串。v0.20 起与打分路径口径一致）。' },
      since: { type: 'string', description: '起始时间（ISO 时间或 YYYY-MM-DD，按创建时间过滤）。' },
      until: { type: 'string', description: '截止时间（ISO 时间或 YYYY-MM-DD）。' },
      scope: { type: 'string', description: '作用域覆盖：global 只查全局；workspaceId 跨项目查（global 仍附加）。' },
      limit: { type: 'integer', description: '返回条数上限（缺省 20）。' },
      includeArchive: { type: 'boolean', description: '是否包含已归档条目（缺省 false）。' },
      role: { type: 'string', description: '角色视角覆盖（v0.5）：以指定角色检索。缺省 = 按调用者会话身份推导（人类会话→主脑角色；子代理/队员→派生角色）。仅当项目启用 roles 时生效。' },
      subject: { type: 'string', description: '主体层过滤（v0.13.0）：只看「关于谁」的条目——`self` = 只看关于我自己的，`master` = 只看关于主人的。缺省 = 不过滤（通用条目照常返回）。⚠ 与 role 的**准入**不同：这是**可选筛子**，不是可见性边界——它只是不匹配就不返回，不改变任何条目的可见性。想「关于我的 + 关于主人的、排除通用」目前需分两次调用。' },
      memType: { type: 'array', items: { type: 'string', enum: ['episodic', 'semantic', 'procedural', 'profile', 'project', 'relational', 'operational'] }, description: '内容分类过滤（v0.26.0 · 方案 §3.1 七类）：只看某几类馆藏（可多选）——`semantic` 语义 / `procedural` 程序 / `project` 项目 / `operational` 运行 / `profile` 画像 / `relational` 关系 / `episodic` 情景。缺省 = 不过滤。⚠ 未分类条目在任何取值下都不返回（它们的类型是「不知道」，不是某一类）。' },
      space: { type: 'array', items: { type: 'string', enum: ['personal', 'project', 'domain', 'system'] }, description: '空间过滤（v0.27.0 · 四空间）：只看某几个空间的条目。缺省 = 不过滤。⚠ 未标注空间的条目在任何取值下都不返回（它的空间是「不知道」）。' },
      status: { type: 'array', items: { type: 'string', enum: ['active', 'pending', 'disputed', 'superseded', 'archived', 'deleted'] }, description: '生命周期过滤（v0.27.0 · 六态）：只看处于某几态的条目。缺省 = 不过滤。取值是派生读法（lifecycleOf），不是存储字段直读。⚠ 按 `archived`/`deleted` 过滤时**自动包含归档**（不必再传 includeArchive）。' },
      project: { type: 'string', description: '执行位置过滤（v0.23.0）：只看某个**项目**的条目（如 `alice` / `pp`）。缺省 = 不过滤。用途：① 换到别的目录干活时取回「那个项目的经验」② 自查「这个项目的结论都有哪些」。⚠ 可选筛子，不是可见性边界。' },
      taskId: { type: 'string', description: '执行位置过滤（v0.23.0）：精确到某个**任务**（`dsh-project-state` 的任务 id）。**必须与 project 同时给**（任务 id 只在项目内唯一，单给会报错）。用途：取回「这个任务一路留下的经验」= 按执行路径聚合，而不是按内容相似度捞。' },
      grounding: { type: 'string', description: '约定状态过滤（v0.14.0）：`proposed` = **只看我自己提的、主人未回应的事**——自查「我有没有把提议当成定论」时用它；`rejected` = 只看主人否决过的（防我旧事重提）；`established` = 只看主人明确说过的。缺省 = 不过滤。⚠ 同为**可选筛子**，不是可见性边界。' },
      provenance: { type: 'string', enum: ['master', 'web', 'self', 'measured'], description: '来源过滤（v0.21.0）：只看某类来源的条目——`master`（主人说的）/ `web`（外部：网页·论文）/ `self`（我推的·我提议的）/ `measured`（我实测的）。缺省 = 不过滤。**典型用法**：`self` = 自查「哪些结论的权威只在我这边」；`web` = 找出「该回原文核对」的条目；`master` = 「主人到底说过哪些」。⚠ 与 grounding 不同：那个筛「主人回应了没有」，这个筛「信息从哪来」。' },
      staleness: { type: 'array', items: { type: 'string', enum: ['expired', 'due-soon', 'fresh'] }, description: '时效维过滤（v0.15.0）：只看**该重看**的条目——`expired`（**已过复查死线**）/ `due-soon`（7 天内到期）/ `fresh`（还早）。典型用法：`["expired","due-soon"]` = 「**我的哪些结论该重看了**」。缺省 = 不过滤。⚠ 只筛「设了死线」的条目——未设死线的条目在任何取值下都不返回（它们的时效状态是「**不知道**」，不是「有效」）。' },
      superseded: { type: 'string', description: '替代状态筛（v0.24.0）：`current` = 只看**还没被替代**的条目 / `superseded` = 只看**已被替代**的条目。缺省 = 不过滤。⚠ **缺省不隐藏已过时条目是刻意的**——对照是它的全部价值（旧值里往往写着「以前为什么这么定」）。本筛子是**审查入口**：「我有哪些结论已经被顶掉了」。' },
      collapseFamily: { type: 'boolean', description: '家族折叠（v0.16.0 · 论文 Memory Echo 的 Family 组件）：把**候选池内**的「时间桶概要 + 它 archiveRef 的原料」压成**每族一位**（族内得分最高者为代表），其余不占本次服务位。论文依据：「Repeated writes therefore add records, not independent votes」（arXiv 2610.17763v1 §5.1）——同一来源的派生不该当多个独立证据占位。**缺省 false**：论文消融显示 Family 单独上线会把准确率从 0.825 打到 0.651（≈ −33 题），须与「当前事实优先」配对才安全，故先做成可选。⚠ 只在 `includeArchive: true` 时有实际效果（默认视图下原料已冷归档，不会与概要同时命中）；折叠不删数据，只是本次不占位。' },
      expandThesaurus: { type: 'boolean', description: '按主题词表扩展查询（v0.29.0 · 方案 §4.2）：把查询里出现的概念换成它的**全部同义词**再检索（查「记忆库」也能命中写成「智能体记忆」的条目）。**缺省 false**（存量检索行为逐字不变）；展开的词会出现在返回的 `expandedTerms` 里，**看得见才可复核**。词表为空时静默不扩展（不是错误）。前提：该概念已在词表中且适用中（`memory_concept` 建立、`memory_thesaurus` 查看）。' },
      expandEntities: { type: 'boolean', description: '实体匹配（v0.31.0 · 方案 §8.3）：查询里出现某个实体（含别名）时，**提到该实体的条目**加一份分（权重 2.5：低于标签/别名命中的 3、高于正文命中的 1）。与 `expandThesaurus` 的区别：那个是「把同义词塞进查询词」（只让字面相同的条目得分），这个是「同一个东西的另一种写法也算」——查「AML 的进度」能找到写「智能体记忆图书馆」的条目。**缺省 false**（存量排序逐字不变）；命中的实体会出现在返回的 `matchedEntities` 里。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
          familyNote: {
            type: 'string',
            description:
              'v0.16.0：家族折叠说明（**仅当真发生折叠时出现**）——解释「为什么返回条数看着比命中数少」；无折叠时不打这一行。',
          },
          suppressedTerms: {
            type: 'array',
            items: { type: 'string' },
            description:
              'v0.12：被泛词门抑制的词项（**仅结果为空时出现**）。出现即说明「命中 0 条」是**打分被抑制**，不是「没有相关记忆」。',
          },
          expandedTerms: {
            type: 'array',
            items: { type: 'string' },
            description:
              'v0.29.0：主题词表扩展出的词（**仅当真发生扩展时出现**）——「这次检索多用了哪些同义词」，让扩展**看得见才可复核**；未开 `expandThesaurus` 时不含本键。',
          },
          matchedEntities: {
            type: 'array',
            description: 'v0.31.0：这次查询匹配到的实体（**仅当真匹配到时出现**）——哪个实体参与加分成，让实体匹配看得见才可复核。',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true, description: '实体 id（`ENTITY-0001` 形态）' },
                canonicalName: { type: 'string', required: true },
                entityType: { type: 'string', required: true },
                matchedNames: { type: 'array', items: { type: 'string' }, description: '查询里点到的该实体的写法（原样）' },
              },
            },
          },
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                title: { type: 'string', required: true },
                snippet: { type: 'string', required: true },
                tags: { type: 'array', required: true, items: { type: 'string' } },
                scope: { type: 'string', required: true },
                transcriptiveUncited: {
                  type: 'boolean',
                  description: 'v0.19.1：**转述型·无出处**标记（**仅命中时出现**）——标题是「精读/调研/评估/论文:/review」一类转述形态，而全文找不到可核出处（arXiv 编号）。语义不是「这条错了」，而是**它的权威不是我实测来的**：拿它当自己的结论用之前，回去核对原文，或把它当「别人的说法」。',
                },
                ...DIMENSION_ITEM_FIELDS,
                ...DERIVED_ITEM_FIELDS,
                level: { oneOf: [{ type: 'string', enum: ['day', 'week', 'month', 'year'] }, { type: 'null' }], required: true },
                score: { type: 'number', required: true },
                archived: { type: 'boolean', required: true },
                updatedAt: { type: 'string', required: true },
                related: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      id: { type: 'string', required: true },
                      kind: { type: 'string', required: true },
                      title: { type: 'string', required: true },
                      scope: { type: 'string', required: true },
                      sharedTags: { type: 'number', required: true },
                      strength: { type: 'number', required: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
      render: (args, value) => {
        // v0.12（2026-10-10）：空结果必须自证原因——
        // 「被泛词门抑制」≠「没有相关记忆」。实测 recall("插件") / recall("技能")
        // 曾返回「命中 0 条」（库里分别有 510 / 395 条提及），读起来像"没有这条记忆"。
        if (value.results.length === 0) {
          const sup = value.suppressedTerms
          const text =
            sup !== undefined && sup.length > 0
              ? `命中 0 条。⚠ 但**这不是「没有相关记忆」**：查询词 ${sup.map((t) => `「${t}」`).join('、')} 在本库中出现过频（超过泛词阈值）⇒ 词项被打分抑制。请换更具区分力的词，或配合 tags / kind / since 收窄后重试。`
              : '命中 0 条：库中确实没有包含这些词项的条目（非抑制所致）。'
          return [{ type: 'text', text }]
        }
        // 时效维的判定基准：整批结果共用**同一时刻**——避免渲染 N 条时前后条目的基准漂移
        // （档位本就该按「读的人看到它的时刻」算，所以这里用渲染时刻而非 execute 的局部变量）。
        const renderNow = new Date()
        const lines = value.results.map((item) => {
          const levelNote = item.level !== null ? `（${item.level}概要）` : ''
          const relatedNote = item.related !== undefined && item.related.length > 0
            ? ' → 关联: ' + item.related.map((r) => `${r.title}(id=${r.id})`).join(' / ')
            : ''
          // 渲染 id（v0.11.0）：id 本就在 output schema 里（数据层一直有），此前只在 render 层漏掉，
          // 导致「知道标题却拿不到 id」⇒ update / forget / memory_merge 全部缺入口
          // （2026-09-26 实测：为找一条已知标题的条目花掉 5 轮仍未取到 id）。
          // 主体层标记（v0.13.0）：**只在有值时**渲染——通用条目留空。
          // 为什么留空：库里绝大多数条目属于通用层，给它们都打标记只会淹没真正该被看见的那两条
          // （同型教训见 silent-suppression-gate：标记也要挑着打，否则最该被看见的被背景吃掉）。
          // 经 normalizeSubject 归一而非直读：历史数据可能含别名或非法值，直读会渲染出 `[undefined]`。
          const subjectNote = subjectTag(normalizeSubject(item.subject))
          // 约定状态标记（v0.14.0）：**只凸显需警觉的**（我的提议 / 限范围 / 已被否决），
          // `established` 与未标注一律留空——库里绝大多数是常规来源，全打标记等于没打
          // （同 subjectTag 的教训）。经归一而非直读：历史数据可能含别名或非法值。
          const groundingNote = groundingTag(normalizeGrounding(item.grounding))
          // 时效维标记（v0.15.0）：**只对需警觉的档位**打（已过期 / 7 天内到期；fresh 与
          // 「未设死线」留空）——同 subjectTag / groundingTag 的教训：标记要挑着打，
          // 全打等于没打。它放前缀的**最前**：过期是「这条结论可能已经不成立」，
          // 比「这是谁的提议」更该被第一眼看见。
          const stalenessNote = stalenessTag(item.reviewAfter, renderNow)
          // 观察条件（v0.15.0）：印在结果行尾 = **免费路由**。论文的 router 服务于
          // 「持续新闻流 × 大量开放决策」；而我的输入流就是我的注意力——`recall` 每轮都在
          // 把相关记忆拉到眼前，**recall 本身就是路由器**。命中即看见「它在等什么」，
          // 由我判断此刻是否正撞上那个事件。（独立 router 等有尸体再做，见 temporal.ts 决定 1）
          const watchNote = watchForTag(item.watchFor)
          const cueNote = cueTag(item.cue)
          // 转述型·无出处（v0.19.1）：与 groundingTag 同类——都是「这条的权威归谁」的警示，
          // 所以并排放在前缀，不进元数据方括号。
          const transcriptiveNote = transcriptiveTag(item.transcriptiveUncited)
          // 来源标记（v0.21.0）：只凸显**权威不在我这一侧**的（`[外部]` 别人的说法、
          // `[自推]` 我推的）。`master` / `measured` / 未标注留空——标记要挑着打。
          const provenanceNote = provenanceTag(item.provenance)
          // 证据标记（v0.25.0）：`⚓会话@33847` = 这条能回到该会话的那个事件位置。
          // 放在权威簇里（紧邻 provenance）：provenance 答「谁说的」，它答「去哪核」。
          const evidenceNote = evidenceTag(item.evidenceRefs)
          // 内容分类标记（v0.26.0）：`·语义` 拼进元数据方括号；未分类留空（标记要挑着打）
          const memTypeNote = memTypeTag(item.memType)
          // 归档标记（v0.21.0）：只在**结论已不能用**的原因上打（`[被证伪]` / `[被取代]` /
          // `[已过时]`）；`merged` / `capacity` / 未分类留空——内容还在，换位置而已。
          // 仅在 includeArchive 时才有归档条目进来，但一旦进来这一格就是「能不能引用它」的答案。
          const archiveNote = archiveReasonTag(item.archivedReasonType)
          // 执行位置标记（v0.23.0）：**有值才打**（通用条目留空——同 subjectTag 的教训：标记要挑着打，
          // 库里绝大多数条目不属于任何项目）。放在前缀**末尾**而不是最前：它是**定位信息**
          // （这条属于哪），不是警示（那几位留给「可能已不成立 / 权威不在我这边」）。
          const projectNote = executionTag(item.project, item.taskId)
          // 事实生命周期标记（v0.24.0）：**已过时放在最前**——它比「已过期」更硬：
          // 过期只表示该核实，**替代表示已有更新版本顶掉它**，照它做就是用旧值。
          // validAfter（自何时成立）与 supersedes（替代了谁）都是元数据，放句尾。
          const supersededNote = supersededByTag(item.supersededBy)
          const validAfterNote = validAfterTag(item.validAfter)
          const supersedesNote = supersedesTag(item.supersedes)
          // 空间归属 / 生命周期标记（v0.27.0）：`〔个人〕` 只给已标注条目；
          // 生命周期标记只给 pending / disputed / deleted 三态（其余由既有 tag 渲染，不重复）
          const spaceNote = spaceTag(item.space)
          const lifecycleNote = lifecycleTag(item.lifecycle)
          return `- ${lifecycleNote}${supersededNote}${stalenessNote}${subjectNote}${groundingNote}${transcriptiveNote}${provenanceNote}${evidenceNote}${archiveNote}${projectNote}[${item.kind}@${item.scope}${levelNote}${memTypeNote}${spaceNote} 相关度${item.score}] ${item.title}(id=${item.id})${validAfterNote.length > 0 ? ' ' + validAfterNote : ''}${watchNote.length > 0 ? ' ' + watchNote : ''}${cueNote.length > 0 ? ' ' + cueNote : ''}${supersedesNote}${relatedNote}`
        })
        return [{
          type: 'text',
          text: [
            (value.expandedTerms !== undefined && value.expandedTerms.length > 0
              ? `词表扩展 +${value.expandedTerms.length} 词：${value.expandedTerms.join(' / ')}`
              : ''),
            (value.matchedEntities !== undefined && value.matchedEntities.length > 0
              ? `实体匹配 ${value.matchedEntities.length} 个：${value.matchedEntities.map((hit) => `${hit.canonicalName}(${hit.id})←${(hit.matchedNames ?? []).join('/')}`).join('；')}`
              : ''),
            `命中 ${value.total} 条，返回 ${value.results.length} 条：`,
            ...lines,
          ].filter((line) => line !== '').join('\n'),
        }]
      },
    },
    async execute(args, exec) {
      const { config, cwd, view } = await resolveRuntime(exec, deps, args.role)
      const { readScopes } = resolveScopes({ configScope: config.scope, cwd, explicit: args.scope })
      // 懒压缩（DESIGN.md §五）：访问记忆时补压上一自然单位；fire-and-forget，失败静默（幂等保证下次重试）
      for (const scope of readScopes) {
        if (deps.compress !== undefined) void deps.compress(scope, exec.agent).catch(() => {})
      }
      // 生命周期筛（v0.27.0）：**先解析**，因为它会影响「要不要取归档」——按 archived/deleted
      // 过滤时自动放行，否则「查已删除的条目」这条最基本的用法得先记得传 includeArchive。
      const statuses = parseLifecycleFilterArg(args.status, 'recall.status')
      const wantsArchived = statuses !== undefined
        && statuses.some((state) => state === 'archived' || state === 'deleted')
      const includeArchive = args.includeArchive ?? wantsArchived
      // 取数：作用域合并 → 视野收窄 → 角色准入过滤（v0.5 单点过滤）
      //      → 主体层筛选（v0.13.0，可选）→ 检索管道
      const gathered = gatherReadable(deps, { readScopes, includeArchive, view, explicitScope: args.scope })
      // 主体层是**可选筛子**（非准入）：未给参数时 `filterBySubject` 原样返回同一数组引用
      // （零拷贝）⇒ 存量无 subject 的条目行为逐字节不变。非法值 fail-loud（不静默当通用）。
      const subject = parseSubjectArg(args.subject, 'recall.subject')
      // 约定状态筛（v0.14.0）：同为可选筛子；两级过滤串联，两者都未给时全是零拷贝透传。
      const grounding = parseGroundingArg(args.grounding, 'recall.grounding')
      // 时效维筛（v0.15.0）：同为可选筛子（三级串联，都未给时全部零拷贝透传，存量行为逐字节不变）。
      // ⚠ 它不是「过滤掉过期的」——是**审查入口**：`staleness:['expired']` 把该重看的捞出来。
      // now 在这里取**一次**、整批共用：避免长批处理里前后条目的判定基准漂移（§仪器纪律）。
      const staleness = parseStalenessFilterArg(args.staleness, 'recall.staleness')
      // 来源筛（v0.21.0）：同为可选筛子。它是**审查入口**而不是分类展示——
      // `provenance:'self'` = 「这些结论的权威其实在我这边」（我推的、不是主人定的、也不是实测），
      // `'web'` = 「从外面读来的」（拿它当自己的结论用之前回原文核对）。
      const provenance = parseProvenanceArg(args.provenance, 'recall.provenance')
      // 执行位置筛（v0.23.0）：同为可选筛子（四级串联，都未给时全部零拷贝透传）。
      // 用途与 provenance 不同：那是**审查入口**（权威在哪），这是**执行路径入口**
      // ——「这个项目/这个任务一路留下了什么」。给 taskId 必须配 project（parseExecutionArgs 会报错）。
      const execPos = parseExecutionArgs({ project: args.project, taskId: args.taskId }, 'recall')
      // 替代状态筛（v0.24.0）：同为可选筛子。**未给参数时零拷贝原样透传**
      // （`filterBySuccession(entries, undefined) === entries`，判据 A1）⇒ 存量行为逐字节不变。
      const superseded = parseSupersessionFilterArg(args.superseded, 'recall.superseded')
      // 内容分类筛（v0.26.0）：同为可选筛子。**未给时零拷贝透传**（存量行为逐字节不变）；
      // 给了就只返回已分类且匹配的——未分类条目在任何取值下都不返回（类型是「不知道」）。
      const memTypes = parseMemTypeFilterArg(args.memType, 'recall.memType')
      // 空间 / 生命周期筛（v0.27.0）：同为可选筛子，**未给时零拷贝透传**（存量行为逐字节不变）。
      const spaces = parseSpaceFilterArg(args.space, 'recall.space')
      const now = new Date()
      const entries = filterByStaleness(
        filterByProvenance(
          filterByGrounding(filterByExecution(filterBySubject(filterBySuccession(gathered.entries, superseded), subject), execPos), grounding),
          provenance,
        ),
        staleness,
        now,
      )
      // 词表扩展（v0.29.0 · 方案 §4.2）：**开了才扩展**（缺省 false ⇒ 存量检索行为逐字不变）。
      // 展开出的同义词随结果返回（`expandedTerms`）——扩展改了排序，就必须**看得见**才可复核；
      // 词表为空 / 未接线时静默不扩展（不是错误：没有受控词表就没有可扩展的东西）。
      const queryBase = typeof args.query === 'string' ? args.query : ''
      const expandedTerms: string[] = []
      if (args.expandThesaurus === true && deps.concepts !== undefined && queryBase.trim().length > 0) {
        for (const scope of readScopes) {
          for (const term of deps.concepts.expand(scope, queryBase).extraTerms) {
            if (!expandedTerms.includes(term)) expandedTerms.push(term)
          }
        }
      }
      const effectiveQuery = [queryBase, ...expandedTerms].filter((term) => term.trim().length > 0).join(' ')
      // 实体匹配（v0.31.0 · 方案 §8.3）：**开了才做**（缺省 false ⇒ 存量排序逐字不变）。
      // 为什么不是把别名塞进查询词（那是上面 expandThesaurus 的做法）：塞词只让字面相同的条目得分，
      // 而实体匹配要的恰是「同一个东西的另一种写法」——查「AML 的进度」要能找到写「智能体记忆图书馆」的条目。
      // 命中结果随返回透出 `matchedEntities`——**改了排序就必须看得见才可复核**。
      const entityMatches: RecallEntityMatch[] = []
      const matchedEntities: Array<{ id: string; canonicalName: string; entityType: string; matchedNames: string[] }> = []
      if (args.expandEntities === true && deps.entities !== undefined && queryBase.trim().length > 0) {
        const lowerQuery = queryBase.toLowerCase()
        for (const scope of readScopes) {
          for (const entity of deps.entities.byScope(scope)) {
            if (!isEntityActive(entity)) continue
            if (matchedEntities.some((hit) => hit.id === entity.id)) continue
            const pairs = namesOf(entity)
              .map((raw) => ({ raw, key: normalizeEntityName(raw) }))
              .filter((pair) => pair.key.length >= 2)
            const hitNames = pairs.filter((pair) => matchesName(lowerQuery, pair.key)).map((pair) => pair.raw)
            if (hitNames.length === 0) continue
            entityMatches.push({ names: pairs.map((pair) => pair.key), weight: 1 })
            matchedEntities.push({ id: entity.id, canonicalName: entity.canonicalName, entityType: entity.entityType, matchedNames: hitNames })
          }
        }
      }
      const result = recallEntries(filterByLifecycle(filterBySpace(filterByMemType(entries, memTypes), spaces), statuses), {
        query: effectiveQuery.length > 0 ? effectiveQuery : undefined,
        kind: args.kind,
        tags: args.tags,
        since: args.since,
        until: args.until,
        limit: args.limit,
        includeArchive,
        collapseFamily: args.collapseFamily ?? false,
        ...(entityMatches.length > 0 ? { entityMatches } : {}),
      })
      // 侧车用量轨迹（v0.6）：只交出命中 id，**绝不改条目**；失败静默（吞错在实现方）
      if (config.audit?.accessTrace?.enabled === true && deps.recordAccess !== undefined && result.results.length > 0) {
        void deps.recordAccess({
          atMs: Date.now(),
          source: 'recall',
          role: view.role,
          ids: result.results.map((item) => item.id),
        })
      }
      // 扩展词只在真发生时出现（省略 ≠ 空数组：没开就是没开，不是「扩展了 0 个词」）
      const withExpanded = expandedTerms.length > 0 ? { ...result, expandedTerms } : result
      // 实体命中同理：没命中就不出现（省略 ≠ 空数组）
      return matchedEntities.length > 0 ? { ...withExpanded, matchedEntities } : withExpanded
    },
  })
}

// ---------- v0.9：遗忘与修改的执行原语（纯函数，单测直接测） ----------

/** 批量遗忘单次上限（护栏：误传 tier 不会一次清空全库） */
export const MAX_BULK_FORGET = 500
/** 批量遗忘缺省上限 */
export const DEFAULT_BULK_FORGET = 100
/** 每条例目保留的修订快照数（旧→新，超出丢最旧） */
export const MAX_REVISIONS = 3

/** 子串出现次数（patch 唯一性判据） */
export function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0
  let count = 0
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at === -1) return count
    count += 1
    from = at + needle.length
  }
}

/**
 * 文本改写模式（v0.9 纯函数）：
 * - `replace`：text 首行 → 标题、其余 → 正文（v0.8 行为，零回归）
 * - `append`：text 追加到正文末尾（标题不动）
 * - `patch`：在正文（正文不中则标题）把 find 换成 replace——**要求唯一命中**，
 *   0 处或多处一律 fail loud（宁可拒绝也不改错位置）
 */
export function applyTextMode(
  existing: { title: string; body: string },
  options: { mode: 'replace' | 'append' | 'patch'; text?: string; find?: string; replace?: string },
): { title: string; body: string } {
  if (options.mode === 'append') {
    const added = options.text ?? ''
    if (added.trim() === '') throw new Error('update: append 模式需要非空 text')
    return { title: existing.title, body: `${existing.body}\n\n${added}` }
  }
  if (options.mode === 'patch') {
    const find = options.find
    if (find === undefined || find === '') {
      throw new Error('update: patch 模式必须提供非空 find')
    }
    const to = options.replace ?? ''
    const inBody = countOccurrences(existing.body, find)
    if (inBody === 1) return { title: existing.title, body: existing.body.replace(find, to) }
    if (inBody > 1) {
      throw new Error(`update: patch 在正文匹配到 ${inBody} 处（要求唯一）——请给出更长的上下文`)
    }
    const inTitle = countOccurrences(existing.title, find)
    if (inTitle === 1) return { title: existing.title.replace(find, to), body: existing.body }
    if (inTitle > 1) {
      throw new Error(`update: patch 在标题匹配到 ${inTitle} 处（要求唯一）`)
    }
    throw new Error('update: patch 未命中 find（正文与标题各 0 处）——先读原文再改')
  }
  if (options.text === undefined) throw new Error('update: replace 模式需要 text')
  const { title, body } = splitText(options.text)
  return { title, body }
}

/** 修订留痕（v0.9）：把「改前快照」推入 revisions，保留最近 MAX_REVISIONS 条（旧→新） */
export function pushRevision(
  existing: { title: string; body: string; revisions?: Revision[] },
  mode: 'replace' | 'append' | 'patch',
  by?: string,
): Revision[] {
  const prev = existing.revisions ?? []
  const snapshot: Revision = {
    at: new Date().toISOString(),
    prevTitle: existing.title,
    prevBody: existing.body,
    mode,
    ...(by !== undefined ? { by } : {}),
  }
  return [...prev, snapshot].slice(-MAX_REVISIONS)
}

/**
 * 批量遗忘目标选择（v0.9 纯函数）：去重 → 只留**存在且未归档**者 → 截断到上限。
 * `skipped` 计「重复 / 不存在 / 已归档」；`truncated` 计被上限挡下的条数（两者都如实回报）。
 */
export function selectForgetTargets(
  entries: readonly Entry[],
  requestedIds: readonly string[],
  max: number,
): { targets: Entry[]; skipped: number; truncated: number } {
  const alive = new Map<string, Entry>()
  for (const entry of entries) {
    if (entry.archived === true) continue
    alive.set(entry.id, entry)
  }
  const seen = new Set<string>()
  const picked: Entry[] = []
  let skipped = 0
  for (const id of requestedIds) {
    if (seen.has(id)) {
      skipped += 1
      continue
    }
    seen.add(id)
    const entry = alive.get(id)
    if (entry === undefined) {
      skipped += 1
      continue
    }
    picked.push(entry)
  }
  const truncated = Math.max(0, picked.length - max)
  return { targets: picked.slice(0, max), skipped, truncated }
}

/** 合并正文（v0.9 纯函数）：把 others 的正文并入 canonical（带来源标注，信息不丢） */
export function mergeBodies(
  canonical: Entry,
  others: readonly Entry[],
  strategy: 'append-sources' | 'keep-canonical',
): { body: string; charsAdded: number } {
  if (strategy === 'keep-canonical') return { body: canonical.body, charsAdded: 0 }
  let body = canonical.body
  for (const other of others) {
    body += `\n\n## 合并自 ${other.id}（${other.title}）\n${other.body}`
  }
  return { body, charsAdded: body.length - canonical.body.length }
}

/**
 * 构建 update 工具（v0.9：三模式 + 修订留痕）。
 * 修改机制的最小闭环：能改（replace/append/patch）→ 改前留痕（revisions）→ 改错可回溯。
 */
function buildUpdate(deps: MemoryToolDeps): ToolDefinition {
  return defineTool({
    name: 'update',
    description: '修订一条记忆条目（按 id）。mode=replace（缺省）：text 首行作标题、其余作正文；mode=append：text 追加到正文末尾；mode=patch：把 find 替换成 replace（要求在正文或标题中**唯一命中**，否则拒绝）。每次内容真变都留一条修订快照（最多 3 条，可回溯）。tags 整体替换；**aliases 整体替换**（留空数组即清空别名）。',
    parameters: {
      id: { type: 'string', required: true, description: '目标条目 id（来自 remember/recall 返回）。' },
      mode: { type: 'string', description: '改写模式：replace（缺省·整文替换）/ append（追加到正文）/ patch（局部替换）。' },
      text: { type: 'string', description: 'replace 模式：新内容（首行作标题，其余作正文）；append 模式：要追加的片段。' },
      find: { type: 'string', description: 'patch 模式：要被替换的原文片段（须唯一命中）。' },
      replace: { type: 'string', description: 'patch 模式：替换成的文本（缺省空串 = 删除该片段）。' },
      tags: { type: 'array', items: { type: 'string' }, description: '替换后的标签；缺省不动。' },
      aliases: { type: 'array', items: { type: 'string' }, description: '替换后的**检索别名**（整体替换，与 tags 同语义）；缺省不动。用途：给已存在的记忆补「它可能被怎么问」的同义表述——实测补后可从 #5 升到 #1。' },
      cue: { type: 'array', items: { type: 'string' }, description: '替换后的**情境形状**（整体替换，v0.16.0；留空数组即清空）；缺省不动。用途：给已存在的经验补「什么形状的处境该用它」——与 aliases 的区别是它防**场景失配**而非词面失配。' },
      subject: { type: 'string', description: '主体层（v0.13.0）——**显式纠正/标注**已存在条目的「关于谁」：给 `self`/`master` = 设置，给空字符串 = 清除回通用，缺省 = 不动。用途：给存量历史记忆补标注（新建时忘标或标错时的唯一入口）；批量标注请先用 recall/memory_browse 定位 id。' },
      memType: { type: 'string', description: '内容分类（v0.26.0 · 方案 §3.1 七类）——**显式改判 / 清除**已存在条目的「是哪一类馆藏」：给 `episodic`/`semantic`/`procedural`/`profile`/`project`/`relational`/`operational` = 设置，给空字符串 = 清除回未分类，缺省 = 不动。用途：存量条目改判（新建时没填或填错）；批量改判请先用 recall/memory_browse 定位 id。' },
      space: { type: 'string', description: '空间归属（v0.27.0 · 四空间）——**显式改归属 / 清除**：给 `personal`/`project`/`domain`/`system` = 设置，给空字符串 = 清除回未标注，缺省 = 不动。' },
      status: { type: 'string', description: '生命周期（v0.27.0）——三态写入：给 `pending` 待审核 / `disputed` 存疑 = 设置；给空字符串或 `active` = **清除回常态**（待审核条目就是这样审核通过的）；缺省 = 不动。⚠ 它设不出 archived / deleted——那两态走 `forget`（要写归档时间与原因）。' },
      project: { type: 'string', description: '执行位置（v0.23.0）——**显式纠正 / 清除**已存在条目的项目归属：给值 = 设置，给**空字符串** = 清除（⚠ **清除会连带清 taskId**——任务 id 没有项目归属就成了悬空指针），缺省 = 不动。用途：① 自动判定盖错了（通用知识被盖成项目记忆）② 存量条目回填。' },
      taskId: { type: 'string', description: '执行位置（v0.23.0）——显式纠正 / 清除任务归属：给值 = 设置（必须该条目已有 project 或同批给 project），给**空字符串** = 清除（不动 project），缺省 = 不动。' },
      grounding: { type: 'string', description: '约定状态（v0.14.0）——**显式纠正/回填**已存在条目的「是否已被共同建立」：给 `established`/`proposed`/`scoped`/`rejected` = 设置，给空字符串 = 清除回未标注，缺省 = 不动。**主要用途是回填**：把库里「我自己提的、主人未回应」的条目标成 `proposed`，防止未来的我把它当授权用；批量回填请先用 recall({ grounding: ... }) 定位 id。' },
      reviewAfter: { type: 'string', description: '时效维（v0.15.0）——**显式续期 / 清除**复查死线：给 `YYYY-MM-DD`（或相对写法 `+7d` / `+2w`，按**此刻**折算成绝对日期）= 设置；给**空字符串** = 清除（不再跟踪）；缺省 = 不动。**主要用途是「到期后的动作链」**：核实完 → 改内容 + 续新死线（或清除）。必须允许转移——死线一旦过期就永远卡在过期态，标记天天亮而消不掉。' },
      watchFor: { type: 'array', items: { type: 'string' }, description: '时效维（v0.15.0）——**整体替换**观察条件：给 1–8 条（每条 ≤200 字）= 设置；给**空数组** = 清空；缺省 = 不动。' },
      provenance: { type: 'string', description: '来源类型（v0.21.0）——**显式纠正 / 回填**已存在条目的「信息从哪来」：给 `master`/`web`/`self`/`measured` = 设置，给空字符串 = 清除回未标注，缺省 = 不动。**主要用途是回填**：存量条目写入时还没有这个字段，而「这条是主人说的还是我从网页读来的」决定它该怎么被用；批量回填请先用 recall 定位 id。' },
      validAfter: { type: 'string', description: '生效时间（v0.24.0）——**显式纠正 / 回填**「这条结论从何时开始成立」：给 `YYYY-MM-DD`（或 ISO 时刻，取 UTC 日）= 设置；给**空字符串** = 清除（回到「不知道」）；缺省 = 不动。**主要用途是回填**：存量条目写入时还没有这个字段，而「这件事从何时为真」是我事后仍能判断的事实（无需当时在场）。⚠ 不接受相对写法（`+7d`）；要设死线请用 `reviewAfter`。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `已更新记忆条目 ${value.id}` }],
    },
    async execute(args, exec) {
      const { config, cwd, view } = await resolveRuntime(exec, deps)
      const { readScopes } = resolveScopes({ configScope: config.scope, cwd })
      // 视野内定位：视野外的条目不可修订（v0.5——修订权随视野，不留越视野后门）
      const { entries } = gatherReadable(deps, { readScopes, includeArchive: true, view })
      const entry = entries.find((candidate) => candidate.id === args.id)
      if (entry === undefined) {
        throw new Error(`update: 未找到 id="${args.id}" 的记忆条目（当前视野内）`)
      }
      const rawMode = args.mode ?? 'replace'
      if (rawMode !== 'replace' && rawMode !== 'append' && rawMode !== 'patch') {
        throw new Error(`update: 未知 mode="${rawMode}"（允许 replace / append / patch）`)
      }
      const mode: 'replace' | 'append' | 'patch' = rawMode
      const patch: EntryPatch = {}
      const touchesText = mode === 'append' || mode === 'patch' || args.text !== undefined
      if (touchesText) {
        const next = applyTextMode(
          { title: entry.title, body: entry.body },
          {
            mode,
            ...(args.text !== undefined ? { text: args.text } : {}),
            ...(args.find !== undefined ? { find: args.find } : {}),
            ...(args.replace !== undefined ? { replace: args.replace } : {}),
          },
        )
        if (next.title !== entry.title || next.body !== entry.body) {
          patch.title = next.title
          patch.body = next.body
          // 只有内容真的变了才记快照——空改写不产生噪音历史
          patch.revisions = pushRevision(entry, mode, sessionIdOf(exec as unknown as RoleCarrierLike))
        }
      }
      if (args.tags !== undefined) patch.tags = args.tags
      if (args.aliases !== undefined) patch.aliases = args.aliases
      // cue 整体替换（v0.16.0）：与 aliases 同语义——给了就整体替换，留空数组即清空
      if (args.cue !== undefined) patch.cue = args.cue
      // 主体层显式转移（v0.13.0）：给值 = 设置，空串 = 清除回通用，缺省 = 不动。
      // 与 role 刻意不同——role 转移会改**可见范围**（安全后果），故 I10 禁止；subject 只是
      // 语义标记，且**必须**允许显式纠正，否则几百条历史记忆永远无法标注（见 subject.ts 决定 3）。
      // 仍不静默：不给该参数就绝不动它（反对的是静默转移，不是显式纠正）。
      if (args.subject !== undefined) {
        patch.subject = parseSubjectArg(args.subject, 'update.subject') ?? null
      }
      // 内容分类显式改判 / 清除（v0.26.0）：三态同 subject（给值 = 设置 / 空串 = 清除回未分类 /
      // 缺省 = 不动）。存量几千条历史记忆停在未分类，这条路径是唯一的改判入口。
      if (args.memType !== undefined) {
        patch.memType = parseMemTypeArg(args.memType, 'update.memType') ?? null
      }
      // 空间归属 / 生命周期（v0.27.0）：三态同 memType——undefined 不动 / 空串清除 / 值设置。
      // `status: ''`（或 active）就是候选区的审核出口：清除回常态。
      if (args.space !== undefined) {
        patch.space = parseSpaceArg(args.space, 'update.space') ?? null
      }
      if (args.status !== undefined) {
        patch.status = parseStatusArg(args.status, 'update.status') ?? null
      }
      // 约定状态显式转移 / 清除（v0.14.0）：三态同 subject（给值 = 设置 / 空串 = 清除回未标注 /
      // 缺省 = 不动）。这是**回填 `proposed` 的唯一入口**——本维度若不回填，保护等于没有
      // （论文的反面：库里「我提的、主人没应」的条目在未标注时就与「已建立」长得一样）。
      if (args.grounding !== undefined) {
        patch.grounding = parseGroundingArg(args.grounding, 'update.grounding') ?? null
      }
      // 时效维显式续期 / 清除（v0.15.0）：三态同 subject / grounding（给值 = 设置 / 空串或空数组
      // = 清除 / 缺省 = 不动）。空值统一折成 `null` 交给 store 层 `delete`——**不留
      // `reviewAfter: ''` 这种「第二表示」**（字段存在但值为空，会让「未设死线」有两个真源）。
      if (args.reviewAfter !== undefined) {
        patch.reviewAfter = parseReviewAfterArg(args.reviewAfter, new Date(), 'update.reviewAfter') ?? null
      }
      if (args.watchFor !== undefined) {
        patch.watchFor = parseWatchForArg(args.watchFor, 'update.watchFor') ?? null
      }
      // 来源类型显式转移 / 清除（v0.21.0）：三态同 subject / grounding——给值 = 设置 /
      // 空串 = 清除回未标注 / 缺省 = 不动。这是**存量回填的唯一入口**。
      if (args.provenance !== undefined) {
        patch.provenance = parseProvenanceArg(args.provenance, 'update.provenance') ?? null
      }
      // 生效时间显式纠正 / 清除（v0.24.0）：三态同 reviewAfter（给值 = 设置 / 空串 = 清除回
      // 「不知道」/ 缺省 = 不动）。空值折成 `null` 交给 store 层 `delete`——**不留
      // `validAfter: ''` 这种「第二表示」**。
      // ⚠ 替代关系（supersededBy / supersedes）**刻意不在这里开**：它们是成对的边，
      // 单侧可写会让库里出现只标了一侧的关系 ⇒ 唯一入口是 memory_supersede。
      if (args.validAfter !== undefined) {
        patch.validAfter = parseValidAfterArg(args.validAfter, 'update.validAfter') ?? null
      }
      // 执行位置显式纠正 / 清除（v0.23.0）：三态同 subject（给值 = 设置 / 空串 = 清除 / 缺省 = 不动）。
      // ⚠ 两条与**新建**路径刻意不同的判断（理由见 `execution.ts::parseExecutionId` 注释）：
      //   ① 单给 taskId 在这里**可能合法**——条目若已有 project，就地补任务 id 是正当操作
      //      ⇒ 不能复用 `parseExecutionArgs`（那是新建视角，强制两级同批给）；
      //   ② 合法性按「修改**之后**的状态」判：patch 完若没有 project，就不能有 taskId
      //      （否则存档里出现悬空任务 id，将来按它查会查到「不知道该属于谁」的条目）。
      // ⚠ 清 project 的级联（连带清 taskId）住在 `store.ts::update`，这里不重写一遍——
      //    同一条规则两处实现，迟早一改一漏。
      const nextProject = args.project !== undefined
        ? parseExecutionId(args.project, 'update.project')
        : normalizeProject(entry.project)
      if (args.project !== undefined) {
        patch.project = nextProject ?? null
      }
      if (args.taskId !== undefined) {
        const nextTaskId = parseExecutionId(args.taskId, 'update.taskId')
        if (nextTaskId !== undefined && nextProject === undefined) {
          throw new Error('update.taskId: 该条目没有项目归属，不能单独设置任务 id（先设 project）')
        }
        patch.taskId = nextTaskId ?? null
      }
      await deps.store.update(entry.scope, args.id, patch)
      recordAction(deps, config, { action: 'update', id: args.id, mode })
      return { id: args.id }
    },
  })
}

/**
 * 构建 `memory_supersede` 工具（v0.24.0）——**替代关系的唯一写入口**。
 *
 * ## 为什么必须是一个独立工具，而不是 `update` 的两个参数
 *
 * 替代关系是**成对**的边：`新.supersedes ∋ 旧` ⇔ `旧.supersededBy = 新`。把它开成
 * `update({ supersededBy })` 那样的单侧可写参数，库里迟早出现「只标了一侧」的边——
 * 而单向边在审计时读作「这条已被替代」（真）却**查不到被谁替代**（丢了），
 * 正是本维度要修的那种「更新关系被抹平」。⇒ **一工具一意图**：一次调用建立一整条边。
 *
 * ## 为什么只保留一层（不做版本树）
 *
 * A→B→C 时三条各记一格，**不**把 C 递归填成 `[A, B]`。记忆库不是事件溯源库：完整链会让
 * recall 越跑越慢、命中越排越散、旧值持续挤占注意力。一层足够回答「我手上这条是不是最新的」。
 *
 * ## fail-loud 三处（都不许静默降级）
 *
 * 1. **id 不存在** —— 保留「静默跳过不存在的 id」就等于给了一个假的成功回执
 *    （我以为建立了替代关系，其实那条边指向空气）。
 * 2. **自引用** —— `A.supersededBy = A` 是自环，会让「这条过时了吗」永远答 yes。
 * 3. **已被别的条目替代过** —— 说明这条已有一条入边；二次替代是**覆盖历史**，
 *    必须显式 `overwrite: true`（判断归调用方，机制不替他决定，也不许悄悄做）。
 *    已在本次目标上的（幂等重调）不算冲突，跳过不写。
 */
function buildSupersede(deps: MemoryToolDeps): ToolDefinition {
  return defineTool({
    name: 'memory_supersede',
    deferLoading: true,
    description: '建立「替代关系」（记忆的事实生命周期维，v0.24.0）：新条目**替代**旧条目。一次调用写**两侧**——新条目记 `supersedes=[旧id…]`，每个旧条目记 `supersededBy=新id`（只写一侧会让审计查不到反向关系，故本工具是唯一写入口，`update` 刻意不暴露这两个字段）。**旧条目不会被删除、不会归档、不会隐藏**：保留原值作对照（「以前用 diff，因为…」那半句的价值就在旧值里），recall 里只打「⚠ 已过时 → 被 xxx 替代」。**只保留一层**：A→B→C 各记一格，不递归成链（记忆库不是版本树）。三处 fail-loud：id 不存在 / 自引用 / 该旧条目已被别的条目替代过（二次替代需显式 `overwrite: true`）。用途：① 结论被推翻并重写（旧的错值仍需可查）② 定调升级（T1→T2）③ 回填历史演替。',
    parameters: {
      id: { type: 'string', required: true, description: '**新**条目 id（替代者）。先用 remember / update 写好新结论，再调本工具建立边。' },
      supersedes: { type: 'array', required: true, items: { type: 'string' }, description: '被替代的**旧**条目 id 列表（至少 1 个；不能含 id 自己）。这些条目会保留原值，只被标上「已过时 → 被 <新id前8位> 替代」。' },
      validAfter: { type: 'string', description: '（可选）同时设**新条目**的生效时间——这条新结论从何时开始成立（`YYYY-MM-DD` 或 ISO 时刻）。缺省 = 不动（⚠ 不会替你填 createdAt）。典型用法：追认「上周三起就该按这个做了」。' },
      overwrite: { type: 'boolean', description: '（可选）显式允许**二次替代**：某条旧条目已被别的条目标过 `supersededBy` 时，默认报错（它已有一条入边，覆盖等于改写历史）。确需覆盖才传 `true`。已在本次目标上的幂等重调不需要它。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true, description: '新条目 id' },
          supersedes: { type: 'array', required: true, items: { type: 'string' }, description: '新条目**当前**的替代列表（全量，不只本次新增——多次建立时只留一层、平铺不递归）' },
          validAfter: { type: 'string', description: '新条目**当前**的生效时间；未设则省略该键' },
          superseded: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                supersededBy: { type: 'string', required: true },
                changed: { type: 'boolean', required: true, description: 'true = 本次写了这一侧；false = 本来就是该状态（幂等重调），未改写' },
              },
            },
            description: '每个被替代条目**写后的状态**（受影响的条目全列出来，便于立刻核对）',
          },
          skipped: { type: 'integer', required: true, description: '其中「本来已是该状态、未改写」的条数' },
        },
      },
      render: (_args, value) => {
        const lines = [`已建立替代关系：${shortId(value.id)} 替代 ${value.superseded.length} 条`
          + (value.skipped > 0 ? `（其中 ${value.skipped} 条本已是该状态，未改写）` : '') + '。']
        for (const item of value.superseded) {
          lines.push(`  - [旧] ${item.title}(id=${item.id}) → 已过时，被 ${shortId(item.supersededBy)} 替代`)
        }
        if (value.validAfter !== undefined) lines.push(`新条目生效时间：自 ${value.validAfter} 起成立。`)
        lines.push('⚠ 旧条目**未删除、未归档**（保留原值作对照）：recall 仍会返回它们，只是带「⚠ 已过时」标记；'
          + '想只看当前结论用 `recall({ superseded: "current" })`。')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const { config, cwd, view } = await resolveRuntime(exec, deps)
      const { readScopes } = resolveScopes({ configScope: config.scope, cwd })
      // 视野内定位（同 update / forget）：视野外的条目不可建立替代关系（不留越视野后门）。
      // includeArchive: **含归档**——替代一条已归档的旧条目是正当操作（它的结论被新条目接棒）。
      const { entries } = gatherReadable(deps, { readScopes, includeArchive: true, view })

      const newId = typeof args.id === 'string' ? args.id.trim() : ''
      if (newId.length === 0) throw new Error('memory_supersede: id（新条目）不能为空')
      const oldIds = parseSupersedesArg(args.supersedes, 'memory_supersede.supersedes')
      if (oldIds.includes(newId)) {
        throw new Error(
          `memory_supersede: supersedes 里不能包含 id 自己（自引用 ${newId}）——自环会让「这条过时了吗」永远答 yes。`
          + '⚠ **常见原因不是笔误**：新条目与旧条目**同标题**时，`remember` 的 L2/L3 同标题合并会把它写进旧条目'
          + '（回执里 `action` 是 `merged`）⇒ 于是库里只有一条，没有「两条」可建立替代关系。'
          + '替代场景请让新结论用**不同的标题**（或先 `update` 改旧标题），再调本工具。',
        )
      }
      // 生效时间（可选）：同 remember 的 fail-loud 纪律
      const validAfter = parseValidAfterArg(args.validAfter, 'memory_supersede.validAfter')

      const target = entries.find((candidate) => candidate.id === newId)
      if (target === undefined) throw new Error(`memory_supersede: 未找到新条目 id="${newId}"（当前视野内）`)

      const missing: string[] = []
      const olds: Entry[] = []
      for (const oldId of oldIds) {
        const found = entries.find((candidate) => candidate.id === oldId)
        if (found === undefined) missing.push(oldId)
        else olds.push(found)
      }
      if (missing.length > 0) {
        // ⚠ 整笔拒绝：先全查再全写。否则「写了一部分、报错停在中途」的半成品边，
        // 比「一条都没写」难查得多（而半成品同样会让审计读到不一致的关系）。
        throw new Error(`memory_supersede: 未找到被替代条目 ${missing.map((id) => `"${id}"`).join(', ')}（当前视野内）——**本次未写入任何一侧**`)
      }

      const overwrite = args.overwrite === true
      const conflicts = olds.filter((old) => old.supersededBy !== undefined && old.supersededBy !== newId)
      if (conflicts.length > 0 && !overwrite) {
        throw new Error(
          'memory_supersede: 下列条目已被**别的**条目替代过，二次替代会改写历史 ⇒ 默认拒绝：'
          + conflicts.map((old) => `"${old.id}"（已被 ${old.supersededBy} 替代）`).join(', ')
          + '。确需覆盖请显式传 overwrite: true。',
        )
      }

      // ① 新条目：supersedes 只留一层（平铺 union，不递归展开祖先）+ 可选 validAfter
      const current = target.supersedes ?? []
      const nextSupersedes = [...current]
      for (const oldId of oldIds) if (!nextSupersedes.includes(oldId)) nextSupersedes.push(oldId)
      const newPatch: EntryPatch = {}
      if (nextSupersedes.length !== current.length) newPatch.supersedes = nextSupersedes
      if (validAfter !== undefined) newPatch.validAfter = validAfter
      const updatedNew = Object.keys(newPatch).length > 0
        ? await deps.store.update(target.scope, newId, newPatch)
        : target
      if (updatedNew === undefined) throw new Error(`memory_supersede: 新条目 "${newId}" 在写入时消失（并发删除？）——本次未建立任何边`)

      // ② 每个旧条目：supersededBy = 新 id（幂等：已是该状态就不写）
      const superseded: { id: string; title: string; supersededBy: string; changed: boolean }[] = []
      for (const old of olds) {
        if (old.supersededBy === newId) {
          superseded.push({ id: old.id, title: old.title, supersededBy: newId, changed: false })
          continue
        }
        const written = await deps.store.update(old.scope, old.id, { supersededBy: newId })
        if (written === undefined || written.supersededBy !== newId) {
          // 半成品边必须响亮报出：此时新条目已经写好了 supersedes 一侧。
          throw new Error(
            `memory_supersede: 旧条目 "${old.id}" 写入失败——已写入：新条目 ${newId}.supersedes；`
            + `未写入：${oldIds.filter((id) => !superseded.some((done) => done.id === id)).join(', ')}。`
            + '这是**半成品关系**，请先核对再用 overwrite: true 补齐。',
          )
        }
        superseded.push({ id: old.id, title: old.title, supersededBy: newId, changed: true })
      }

      recordAction(deps, config, {
        action: 'supersede',
        id: newId,
        reason: `supersedes: ${oldIds.join(', ')}`,
      })
      return {
        id: newId,
        supersedes: updatedNew.supersedes ?? [],
        ...(updatedNew.validAfter !== undefined ? { validAfter: updatedNew.validAfter } : {}),
        superseded,
        skipped: superseded.filter((item) => !item.changed).length,
      }
    },
  })
}

/**
 * 构建 forget 工具（v0.9：从「一条」到「能执行一次遗忘决策」）。
 * 旧形态的实际缺陷（2026-09-17 实测）：memory_audit 给出 ARCHIVE 候选 254 条，
 * 而 forget 一次只吃一个 id ⇒ 清完要 254 次调用 = 机制上「知道该忘但忘不动」。
 * 新形态：id / ids[] / tier（按体检分档）任选，带 max 护栏与 dryRun 预览。
 */
function buildForget(deps: MemoryToolDeps): ToolDefinition {
  return defineTool({
    name: 'forget',
    deferLoading: true,
    description: '归档记忆条目（软删除：不再进活跃检索，可从 includeArchive 找回）。三种选择器任一：id（单条）/ ids[]（批量）/ tier（按 memory_audit 分档批量，ARCHIVE|DEMOTE|REVIEW）。批量请先 dryRun=true 看清单；max 护栏缺省 100、上限 500。reason 记入条目 `archivedReason`，reasonType 记入 `archivedReasonType`（v0.21.0 起不再写 `source.reason`——那个字段答「从哪来」，不答「怎么没了」）。',
    parameters: {
      id: { type: 'string', description: '单条模式：目标条目 id（来自 remember/recall/audit 返回）。' },
      ids: { type: 'array', items: { type: 'string' }, description: '批量模式：目标条目 id 列表。' },
      tier: { type: 'string', description: '分档批量：按 memory_audit 的档位选目标（ARCHIVE / DEMOTE / REVIEW；KEEP 被拒绝）。' },
      max: { type: 'integer', description: `批量上限（缺省 ${DEFAULT_BULK_FORGET}，硬上限 ${MAX_BULK_FORGET}）。` },
      dryRun: { type: 'boolean', description: 'true = 只列清单不写库（批量前必做）。' },
      reason: { type: 'string', description: '归档原因（人类可读详情，记入条目 `archivedReason`）。' },
      reasonType: { type: 'string', description: '归档原因**类型**（v0.21.0）——决定引用它的活跃条目该怎么处置：`refuted`（被证伪·结论不能再当依据，引用方必须撤）/ `superseded`（被取代·有更新结论覆盖）/ `stale`（过时·依赖的外部状态变了）/ `merged`（被合并·内容换位置了，原文在别处）/ `capacity`（容量清理·不因为错，只因占位）/ `unspecified`（未判断）。**单条归档请务必判断一次**：这一格是「我引用的那条为什么没了」唯一可查的答案（旧实现把它写成自由文本，查不了）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          archived: { type: 'boolean', required: true },
          archivedCount: { type: 'integer', required: true },
          ids: { type: 'array', required: true, items: { type: 'string' } },
          skipped: { type: 'integer', required: true },
          truncated: { type: 'integer', required: true },
          dryRun: { type: 'boolean', required: true },
          notes: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        if (value.dryRun) {
          const tail = value.truncated > 0 ? ` · 超出上限未列 ${value.truncated} 条` : ''
          return [{ type: 'text', text: `dry-run：将归档 ${value.ids.length} 条（跳过 ${value.skipped}${tail}）——确认后去掉 dryRun 再调` }]
        }
        if (value.archivedCount === 1 && value.id !== undefined) {
          return [{ type: 'text', text: `已归档记忆条目 ${value.id}` }]
        }
        return [{ type: 'text', text: `已归档 ${value.archivedCount} 条（跳过 ${value.skipped}）` }]
      },
    },
    async execute(args, exec) {
      const { config, cwd, view } = await resolveRuntime(exec, deps)
      const { readScopes } = resolveScopes({ configScope: config.scope, cwd })
      // 视野内定位：视野外的条目不可归档（v0.5，同 update）
      const { entries: universe } = gatherReadable(deps, { readScopes, includeArchive: true, view })
      const max = Math.max(1, Math.min(args.max ?? DEFAULT_BULK_FORGET, MAX_BULK_FORGET))
      const notes: string[] = []
      const requested: string[] = []
      if (args.id !== undefined) requested.push(args.id)
      if (args.ids !== undefined) requested.push(...args.ids)

      if (args.tier !== undefined) {
        const tier = args.tier
        if (tier === 'KEEP') {
          throw new Error('forget: tier=KEEP 是承重档（被概要引用 / 新 / 有角色归属）——禁止批量归档；确需请逐条显式给 id')
        }
        if (tier !== 'ARCHIVE' && tier !== 'DEMOTE' && tier !== 'REVIEW') {
          throw new Error(`forget: 未知 tier="${tier}"（允许 ARCHIVE / DEMOTE / REVIEW）`)
        }
        const usage = deps.readAccess === undefined ? undefined : await deps.readAccess()
        // 已裁决标记**必须同样传**（v0.11.2）：否则「已审 ⇒ 保持现状」只在新旧路径不一致时失效，
        // 而 tier=REVIEW 会**真去归档**那些我已裁决为「保持现状」的条目 ——
        // 这是**动数据**的路径（forget），判据必须与体检主路径一致（单一真源）。
        const reviewed = deps.readReviewMarks === undefined ? undefined : await deps.readReviewMarks()
        const audit = auditMemory({
          entries: universe.filter((entry) => entry.archived !== true),
          indexEntries: universe,
          ...(config.audit !== undefined ? { config: config.audit } : {}),
          ...(usage !== undefined ? { usage } : {}),
          ...(reviewed !== undefined ? { reviewed } : {}),
          query: { topN: max + 1, minChars: 0 },
        })
        const tierIds = audit.candidates.filter((candidate) => candidate.bucket === tier).map((candidate) => candidate.id)
        notes.push(`tier=${tier}：体检命中 ${tierIds.length} 条（候选窗口 ${max + 1}）`)
        requested.push(...tierIds)
      }

      if (requested.length === 0) {
        throw new Error('forget: 需要 id / ids / tier 之一（批量归档请先 dryRun=true 看清单）')
      }

      const { targets, skipped, truncated } = selectForgetTargets(universe, requested, max)
      const singleMode = args.id !== undefined && args.ids === undefined && args.tier === undefined
      if (singleMode && targets.length === 0) {
        throw new Error(`forget: 未找到 id="${args.id}" 的记忆条目（当前视野内，或已归档）`)
      }
      if (truncated > 0) {
        notes.push(`目标共 ${targets.length + truncated} 条超上限 ${max}，本次只处理前 ${max} 条（其余下次再来）`)
      }

      const ids = targets.map((entry) => entry.id)
      const idField = singleMode && args.id !== undefined ? { id: args.id } : {}
      if (args.dryRun === true) {
        return { ...idField, archived: false, archivedCount: 0, ids, skipped, truncated, dryRun: true, notes }
      }
      const reason = args.reason ?? (targets.length > 1 ? `forget: bulk（${targets.length} 条）` : undefined)
      // 解析入参（v0.21.0）：非法值 fail-loud——静默当成 `unspecified` 会让「我判断过」
      // 与「我打错了字」在库里同形，而这两件事对未来读它的人完全不同。
      const reasonType = parseArchiveReasonTypeArg(args.reasonType, 'forget.reasonType') ?? 'unspecified'
      for (const target of targets) {
        await deps.store.forget(target.scope, target.id, {
          ...(reason !== undefined ? { reason } : {}),
          reasonType,
        })
        recordAction(deps, config, {
          action: 'forget',
          id: target.id,
          ...(reason !== undefined ? { reason } : {}),
        })
      }
      return { ...idField, archived: ids.length > 0, archivedCount: ids.length, ids, skipped, truncated, dryRun: false, notes }
    },
  })
}

/**
 * 构建 memory_merge 工具（v0.9）：近重复簇的**合并原语**。
 * 动机：memory_audit 只标出「近重复簇」（REVIEW）却不提供合并手段，只能人工逐条处理。
 * 语义：信息不丢——被并入者正文追加进 canonical（带来源标注），随后软归档（可找回）。
 */
function buildMerge(deps: MemoryToolDeps): ToolDefinition {
  return defineTool({
    name: 'memory_merge',
    deferLoading: true,
    description: '合并近重复条目（处理 memory_audit 的 REVIEW 簇）：把 ids 的正文并入 canonical（带「合并自 <id>」来源标注，信息不丢），并把被并入者软归档（includeArchive 可找回）。strategy=keep-canonical 时只归档、不动正文。',
    parameters: {
      canonical: { type: 'string', required: true, description: '保留的条目 id（合并目标，正文被追加）。' },
      ids: { type: 'array', items: { type: 'string' }, required: true, description: '被并入并归档的条目 id 列表。' },
      strategy: { type: 'string', description: 'append-sources（缺省·正文追加带来源）/ keep-canonical（只归档不追加）。' },
      reason: { type: 'string', description: '归档原因（记入被并入者 source）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          canonical: { type: 'string', required: true },
          merged: { type: 'integer', required: true },
          archived: { type: 'array', required: true, items: { type: 'string' } },
          charsAdded: { type: 'integer', required: true },
          notes: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: `已合并 ${value.merged} 条 → ${value.canonical}（正文 +${value.charsAdded} 字符，被并入者已归档）` },
      ],
    },
    async execute(args, exec) {
      const { config, cwd, view } = await resolveRuntime(exec, deps)
      const { readScopes } = resolveScopes({ configScope: config.scope, cwd })
      const { entries: universe } = gatherReadable(deps, { readScopes, includeArchive: true, view })
      const canonical = universe.find((entry) => entry.id === args.canonical)
      if (canonical === undefined) {
        throw new Error(`memory_merge: 未找到 canonical id="${args.canonical}"（当前视野内）`)
      }
      if (canonical.archived === true) {
        throw new Error(`memory_merge: canonical id="${args.canonical}" 已归档——先决定是否取消归档再合并`)
      }
      const strategy = args.strategy ?? 'append-sources'
      if (strategy !== 'append-sources' && strategy !== 'keep-canonical') {
        throw new Error(`memory_merge: 未知 strategy="${strategy}"（允许 append-sources / keep-canonical）`)
      }
      const notes: string[] = []
      const merged: Entry[] = []
      const seen = new Set<string>()
      for (const id of args.ids) {
        if (id === canonical.id) {
          notes.push(`跳过 ${id}：canonical 自身`)
          continue
        }
        if (seen.has(id)) {
          notes.push(`跳过 ${id}：列表内重复`)
          continue
        }
        seen.add(id)
        const other = universe.find((entry) => entry.id === id)
        if (other === undefined) {
          notes.push(`跳过 ${id}：视野内不存在`)
          continue
        }
        if (other.archived === true) {
          notes.push(`跳过 ${id}：已归档`)
          continue
        }
        merged.push(other)
      }
      const { body, charsAdded } = mergeBodies(canonical, merged, strategy)
      if (charsAdded > 0) {
        await deps.store.update(canonical.scope, canonical.id, {
          body,
          revisions: pushRevision(canonical, 'append', sessionIdOf(exec as unknown as RoleCarrierLike)),
        })
      }
      const reason = args.reason ?? `merged into ${canonical.id}`
      const archived: string[] = []
      for (const other of merged) {
        // 合并路径的语义是确定的：内容并进了 canonical，换位置而不是被否定 ⇒ `merged`。
        await deps.store.forget(other.scope, other.id, { reason, reasonType: 'merged' })
        recordAction(deps, config, { action: 'forget', id: other.id, reason })
        archived.push(other.id)
      }
      return { canonical: canonical.id, merged: merged.length, archived, charsAdded, notes }
    },
  })
}

/** 构建 memory_stats 工具 */
function buildStats(deps: MemoryToolDeps): ToolDefinition {
  return defineTool({
    name: 'memory_stats',
    deferLoading: true,
    description: '记忆统计：按层级（kind）/ 压缩层级（level）/ 时间桶（bucket）计数 + 归档数。缺省统计当前项目 + global，scope 参数可只统计指定库。',
    parameters: {
      scope: { type: 'string', description: '作用域覆盖：只统计该 scope（global 或 workspaceId）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
          byKind: { type: 'object', additionalProperties: true, required: true },
          byLevel: { type: 'object', additionalProperties: true, required: true },
          bucketCounts: { type: 'object', additionalProperties: true, required: true },
          archiveCount: { type: 'integer', required: true },
          bySubject: { type: 'object', additionalProperties: true, required: true, description: '主体层分布（v0.13.0）：self / master / unspecified（通用层）。' },
          byGrounding: { type: 'object', additionalProperties: true, required: true, description: '约定状态分布（v0.14.0）：established / proposed / scoped / rejected / unlabeled（未标注）。⚠ **unlabeled 与 established 是两件事**——前者是「不知道」，后者是「主人明确说过」；把未标注读成已建立正是论文点名的失败。' },
          byStaleness: { type: 'object', additionalProperties: true, required: true, description: '时效维分布（v0.15.0）：expired（**已过复查死线**）/ due-soon（7 天内到期）/ fresh（已跟踪且还早）/ untracked（**未设死线**）。⚠ untracked 与 fresh 是两件事——前者是「**不知道它会不会过期**」，后者是「已跟踪且还早」。若 untracked 长期等于总数，说明这个维度没被用起来（退出判据见 src/temporal.ts 文件头）。' },
          scopes: { type: 'array', required: true, items: { type: 'string' } },
          byProvenance: { type: 'object', additionalProperties: true, required: true, description: '来源分布（v0.21.0）：master（主人说的）/ web（外部）/ self（我推的）/ measured（我实测的）/ unlabeled（**未标注**）。⚠ unlabeled 是常态不是缺陷——但若它长期≈总数，说明这一维没被用起来，「这条是主人说的还是我从网上读来的」仍然无法区分。' },
          byArchiveReason: { type: 'object', additionalProperties: true, required: true, description: '归档原因分布（v0.21.0）：refuted（被证伪）/ superseded（被取代）/ stale（已过时）/ merged（已合并）/ capacity（容量清理）/ unspecified（未分类）。⚠ unspecified 大意味着大量归档没标原因（含 v0.16 及以前的存量，它们的原因还在 `source.reason` 里、没有类型）。' },
          byMemType: { type: 'object', additionalProperties: true, required: true, description: '内容分类分布（v0.26.0 · 方案 §3.1 七类）：episodic / semantic / procedural / profile / project / relational / operational / **unclassified**（未分类）。⚠ unclassified 与任何一类都是两件事——它是「还没判断」，不是「属于某类」；之和恒等于 total。' },
          bySpace: { type: 'object', additionalProperties: true, required: true, description: '空间归属分布（v0.27.0 · 方案 §3.2 四空间）：personal（个人）/ project（项目）/ domain（领域）/ system（系统）/ **unclassified**（未标注）。⚠ unclassified 是「还没判断」，不是某个空间；之和恒等于 total。' },
          byLifecycle: { type: 'object', additionalProperties: true, required: true, description: '生命周期分布（v0.27.0 · 方案 §3.3 六态）：active / pending / disputed / superseded / archived / deleted。**派生读法**（lifecycleOf 优先级 deleted > archived > superseded > disputed > pending > active），六态之和恒等于 total。' },
          relations: {
            type: 'object',
            additionalProperties: false,
            required: true,
            description: '关系层（v0.28.0 · 方案 §4.4）：类型化边的读数。⚠ 只有接线时才有意义——未接线时为全 0 且 `wired=false`（**「没接线」与「确实零条」必须可区分**）。',
            properties: {
              wired: { type: 'boolean', required: true, description: 'false = 关系层未接线（index.ts 未传入 RelationStore）⇒ 下面的 0 不代表「库里没有关系」' },
              total: { type: 'integer', required: true },
              live: { type: 'integer', required: true, description: '仍在有效期内（validTo 未过）' },
              expired: { type: 'integer', required: true, description: '已退役（validTo 已过）——**过期 ≠ 作废**，历史仍可读' },
              nodesCovered: { type: 'integer', required: true, description: '至少有一条有效边的条目数（可见集合内）' },
              byType: { type: 'object', additionalProperties: true, required: true, description: '十种关系类型各自的边数（含过期）' },
              byProvenance: { type: 'object', additionalProperties: true, required: true, description: '关系来源分布（master / web / self / measured）' },
              withConfidence: { type: 'integer', required: true, description: '填了可信度的边数（**未填 = 未评估，不是 0 分**）' },
              withValidity: { type: 'integer', required: true, description: '填了有效期（validFrom 或 validTo）的边数' },
            },
          },
          concepts: {
            type: 'object',
            additionalProperties: false,
            required: true,
            description: '主题词表（v0.29.0 · 方案 §4.2）：受控词表的读数。⚠ 未接线时 `wired=false`（**「没接线」与「词表为空」必须可区分**）。',
            properties: {
              wired: { type: 'boolean', required: true, description: 'false = 词表未接线 ⇒ 下面的 0 不代表「没有概念」' },
              total: { type: 'integer', required: true },
              active: { type: 'integer', required: true, description: '适用中的概念数（停用的不算）' },
              deprecated: { type: 'integer', required: true, description: '已停用（记录保留，旧标签仍可解释）' },
              withAltLabels: { type: 'integer', required: true, description: '带同义词的概念数（没有同义词的词表只管归一，不管扩展）' },
              withDefinition: { type: 'integer', required: true, description: '带定义的概念数' },
              withBroader: { type: 'integer', required: true, description: '有上位概念的概念数（层级从这长出来）' },
            },
          },
          entities: {
            type: 'object',
            additionalProperties: false,
            required: true,
            description: '实体权威档（v0.30.0 · 方案 §4.3）：规范控制的读数。⚠ 未接线时 `wired=false`（**「没接线」与「库里没有实体」必须可区分**）。',
            properties: {
              wired: { type: 'boolean', required: true, description: 'false = 实体档未接线 ⇒ 下面的 0 不代表「没有实体」' },
              total: { type: 'integer', required: true },
              active: { type: 'integer', required: true, description: '适用中的实体数（已合并 / 已停用的不算）' },
              merged: { type: 'integer', required: true, description: '已合并的旧档（记录保留，指向存续档）' },
              deprecated: { type: 'integer', required: true, description: '已停用的实体（记录保留，旧记忆里提到的仍可解释）' },
              withAliases: { type: 'integer', required: true, description: '带别名的实体数（没有别名的档案只能按规范名认出）' },
              withTopics: { type: 'integer', required: true, description: '标了相关主题的实体数' },
              withRelatedEntities: { type: 'integer', required: true, description: '有关联实体的实体数（关系网从这长出来）' },
              withDisambiguation: { type: 'integer', required: true, description: '写了消歧说明的实体数——撞名并存时它必须 > 0，否则消歧是空的' },
            },
          },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `记忆统计（${value.scopes.join(' + ')}）：共 ${value.total} 条（按层 ${JSON.stringify(value.byKind)}；主体层 ${JSON.stringify(value.bySubject)}；约定状态 ${JSON.stringify(value.byGrounding)}；已归档 ${value.archiveCount}）`
          // 时效维（v0.15.0）：**单独一行给结论**——它是「有哪些结论该重看了」的动作入口，
          // 挤在括号里会被读成一堆数字（过期数 > 0 时这行 verdict 自带处置指引）。
          + `\n${stalenessVerdict(value.byStaleness)}`
          // 来源 + 归档（v0.21.0）：同样单独一行——覆盖率的意义是「看得见才知道该不该补」，
          // 挤进括号会被读成一堆数字（同 staleness 的教训）。
          + `\n来源：${JSON.stringify(value.byProvenance)}；归档原因：${JSON.stringify(value.byArchiveReason)}`
          // 内容分类（v0.26.0）：单独一行——unclassified 长期≈总数说明这一维没被用起来，
          // 挤进括号会被读成一堆数字（同上一条的教训）。
          + `\n内容分类：${JSON.stringify(value.byMemType)}`
          // 空间归属 / 生命周期（v0.27.0）：同上——未标注长期≈总数说明这一维没被用起来，
          // 生命周期是六态派生读法（六态之和 == total）
          + `\n空间归属：${JSON.stringify(value.bySpace)}；生命周期：${JSON.stringify(value.byLifecycle)}`
          // 关系层（v0.28.0）：单独一行——wired=false 必须看得见（「没接线」≠「零条」）
          + `\n关系层：${value.relations.wired
            ? `${value.relations.total} 条类型化边（有效 ${value.relations.live} / 已退役 ${value.relations.expired}；覆盖 ${value.relations.nodesCovered} 个条目；来源 ${JSON.stringify(value.relations.byProvenance)}；可信度 ${value.relations.withConfidence} 条 / 有效期 ${value.relations.withValidity} 条）`
            : '未接线（relations 表未装配）——此处的 0 不代表库里没有关系'}`
          // 主题词表（v0.29.0）：同 relations——wired=false 必须看得见
          + `\n主题词表：${value.concepts.wired
            ? `${value.concepts.total} 个概念（适用 ${value.concepts.active} / 停用 ${value.concepts.deprecated}；带同义词 ${value.concepts.withAltLabels} / 带定义 ${value.concepts.withDefinition} / 有上位 ${value.concepts.withBroader}）`
            : '未接线（concepts 表未装配）——此处的 0 不代表词表为空'}`
          // 实体权威档（v0.30.0）：同 relations / concepts——wired=false 必须看得见
          + `\n实体权威档：${value.entities.wired
            ? `${value.entities.total} 个实体（适用 ${value.entities.active} / 已合并 ${value.entities.merged} / 停用 ${value.entities.deprecated}；带别名 ${value.entities.withAliases} / 带主题 ${value.entities.withTopics} / 有关联实体 ${value.entities.withRelatedEntities} / 有消歧说明 ${value.entities.withDisambiguation}）`
            : '未接线（entities 表未装配）——此处的 0 不代表库里没有实体'}`,
      }],
    },
    async execute(args, exec) {
      const { config, cwd, view } = await resolveRuntime(exec, deps)
      const { readScopes } = resolveScopes({ configScope: config.scope, cwd, explicit: args.scope })
      // 懒压缩（DESIGN.md §五）：访问记忆时补压上一自然单位；fire-and-forget，失败静默
      for (const scope of readScopes) {
        if (deps.compress !== undefined) void deps.compress(scope, exec.agent).catch(() => {})
      }
      // 计数按视野取数后统计（v0.5：启用角色时统计只反映可见集合；停用时与 v0.4 等价）
      const { entries, scopes } = gatherReadable(deps, {
        readScopes,
        includeArchive: true,
        view,
        explicitScope: args.scope,
      })
      // 主体层 + 约定状态分布（v0.13 / v0.14）：与 statsOf 吃**同一批** entries（含归档）——
      // 口径同体，否则「总 N 条但分档加起来不等」这种不自洽会在读数层制造新疑问。
      return {
        ...statsOf(entries),
        scopes,
        bySubject: countBySubject(entries),
        byGrounding: countByGrounding(entries),
        // 时效维（v0.15.0）：与上面两项吃**同一批** entries（含归档）——口径同体，
        // 否则「总 N 条但分档加起来不等」这种不自洽会在读数层制造新疑问。
        // now 取一次、整批共用（同一批条目的判定基准不漂移）。
        byStaleness: countByStaleness(entries, new Date()),
        // 来源 + 归档原因（v0.21.0）：同一批 entries，口径同体。
        // `byArchiveReason` 走 `archivalOf` 归一 ⇒ v0.16 及以前的存量归档全部落在
        // `unspecified`（它们的原因还在 `source.reason` 里、没有类型）——这是诚实的读数，
        // 不是「这些条目没原因」。
        byProvenance: countByProvenance(entries),
        byArchiveReason: countByArchiveReason(entries),
        // 内容分类（v0.26.0）：七类 + 未分类，之和 == total（同一批 entries，口径同体）
        byMemType: countByMemType(entries),
        // 空间归属 / 生命周期（v0.27.0）：与 byMemType 同一批样本（**之和 == total**）
        bySpace: countBySpace(entries),
        byLifecycle: countByLifecycle(entries),
        // 关系层（v0.28.0）：`wired=false` 与「零条」必须可区分（未接线时的 0 不是读数）
        relations: (() => {
          if (deps.relations === undefined) {
            return {
              wired: false,
              total: 0,
              live: 0,
              expired: 0,
              nodesCovered: 0,
              byType: Object.fromEntries(RELATION_TYPES.map((type) => [type, 0])) as Record<string, number>,
              byProvenance: { master: 0, web: 0, self: 0, measured: 0, unlabeled: 0 } as Record<string, number>,
              withConfidence: 0,
              withValidity: 0,
            }
          }
          const relationStats = deps.relations.stats()
          // 覆盖面按**可见集合**算（同上面各维度的口径：统计只反映看得见的条目）
          const visibleIds = new Set(entries.map((entry) => entry.id))
          const covered = new Set<string>()
          for (const relation of deps.relations.all()) {
            if (!isRelationLive(relation)) continue
            for (const node of [relation.from, relation.to]) {
              if (visibleIds.has(node)) covered.add(node)
            }
          }
          return { wired: true, ...relationStats, nodesCovered: covered.size }
        })(),
        // 主题词表（v0.29.0）：同 relations——`wired=false` 与「词表为空」必须可区分
        concepts: (() => {
          if (deps.concepts === undefined) {
            return { wired: false, total: 0, active: 0, deprecated: 0, withAltLabels: 0, withDefinition: 0, withBroader: 0 }
          }
          const stats = deps.concepts.stats()
          return {
            wired: true,
            total: stats.total,
            active: stats.active,
            deprecated: stats.deprecated,
            withAltLabels: stats.withAltLabels,
            withDefinition: stats.withDefinition,
            withBroader: stats.withBroader,
          }
        })(),
        // 实体权威档（v0.30.0）：同 concepts——`wired=false` 与「没有实体」必须可区分
        entities: (() => {
          if (deps.entities === undefined) {
            return { wired: false, total: 0, active: 0, merged: 0, deprecated: 0, withAliases: 0, withTopics: 0, withRelatedEntities: 0, withDisambiguation: 0 }
          }
          const stats = deps.entities.stats()
          return {
            wired: true,
            total: stats.total,
            active: stats.active,
            merged: stats.merged,
            deprecated: stats.deprecated,
            withAliases: stats.withAliases,
            withTopics: stats.withTopics,
            withRelatedEntities: stats.withRelatedEntities,
            withDisambiguation: stats.withDisambiguation,
          }
        })(),
      }
    },
  })
}

/** 构建 memory_browse 工具：按时间线分组浏览记忆档案（与 recall 互补） */
function buildBrowse(deps: MemoryToolDeps): ToolDefinition {
  return defineTool({
    name: 'memory_browse',
    deferLoading: true,
    description: '浏览记忆档案：按时间桶分组翻看记忆（年/月/周/日），支持按层级/类型/标签/时间过滤与分页。与 recall 互补——recall 用于「知道要找什么」，memory_browse 用于「不知道有什么、翻档案发现」。**每条都带 id**（可直接用于 update / forget / memory_merge）。概要通过 archiveRef 关联原始条目，可用 recall 展开。',
    parameters: {
      kind: { type: 'array', items: { type: 'string', enum: ['fact', 'knowledge', 'episodic', 'summary'] }, description: '条目类型过滤（任一命中）。' },
      tags: { type: 'array', items: { type: 'string' }, description: '标签过滤（全部命中；**包含**匹配：给 `技能` 也命中 `技能维护`/`技能熔炉` 等变体，给 `技能维护` 只命中该串。v0.20 起与打分路径口径一致）。' },
      since: { type: 'string', description: '起始时间（YYYY-MM-DD 或 ISO）。' },
      until: { type: 'string', description: '截止时间（YYYY-MM-DD 或 ISO）。' },
      level: { type: 'string', enum: ['day', 'week', 'month', 'year'], description: '只看该层级概要（如 day=只看日概要，week=只看周概要）。' },
      scope: { type: 'string', description: '作用域覆盖（global 或 workspaceId）；缺省当前 workspace + global。' },
      includeArchive: { type: 'boolean', description: '是否包含已归档条目（默认否）。' },
      page: { type: 'integer', description: '页码（1 起，默认 1）。' },
      pageSize: { type: 'integer', description: '每页组数（默认 20）。' },
      role: { type: 'string', description: '角色视角覆盖（v0.5）：缺省按调用者会话身份推导。仅当项目启用 roles 时生效。' },
      subject: { type: 'string', description: '主体层过滤（v0.13.0）：只看「关于谁」的条目——`self` / `master`。缺省 = 不过滤。用于翻看某一层的积累（如「我对主人的认识都记了些什么」）。' },
      memType: { type: 'array', items: { type: 'string', enum: ['episodic', 'semantic', 'procedural', 'profile', 'project', 'relational', 'operational'] }, description: '内容分类过滤（v0.26.0 · 七类）：只看某几类馆藏。缺省 = 不过滤；未分类条目在任何取值下都不返回。' },
      space: { type: 'array', items: { type: 'string', enum: ['personal', 'project', 'domain', 'system'] }, description: '空间过滤（v0.27.0 · 四空间）：只看某几个空间。缺省 = 不过滤；未标注条目在任何取值下都不返回。' },
      status: { type: 'array', items: { type: 'string', enum: ['active', 'pending', 'disputed', 'superseded', 'archived', 'deleted'] }, description: '生命周期过滤（v0.27.0 · 六态）：只看某几态。缺省 = 不过滤；按 archived/deleted 过滤时自动包含归档。' },
      project: { type: 'string', description: '执行位置过滤（v0.23.0）：只看某个**项目**的条目（如 `alice` / `pp`）。缺省 = 不过滤。用于翻某个项目的积累（如「这个项目踩过哪些坑」）。' },
      taskId: { type: 'string', description: '执行位置过滤（v0.23.0）：精确到某个**任务**；**必须与 project 同时给**（任务 id 只在项目内唯一）。' },
      grounding: { type: 'string', description: '约定状态过滤（v0.14.0）：`proposed` / `rejected` / `scoped` / `established`。缺省 = 不过滤。用于翻档案自查（如「我提过哪些主人没回应的方案」）。' },
      provenance: { type: 'string', enum: ['master', 'web', 'self', 'measured'], description: '来源过滤（v0.21.0）：`master` / `web` / `self` / `measured`。缺省 = 不过滤。用于翻档案自查（如「我读过的东西都记了些什么」「哪些结论是我自己推的」）。' },
      staleness: { type: 'array', items: { type: 'string', enum: ['expired', 'due-soon', 'fresh'] }, description: '时效维过滤（v0.15.0）：只看某档时效状态的条目——`expired`（**已过复查死线**）/ `due-soon`（7 天内到期）/ `fresh`。用于**按时间线**翻「哪些结论该重看了」（recall 要查询词，这里不要）。缺省 = 不过滤。⚠ 只筛「设了死线」的条目——未设死线的条目时效状态是「不知道」，不是「有效」。' },
      superseded: { type: 'string', description: '替代状态筛（v0.24.0）：`current`（还没被替代）/ `superseded`（已被替代）。缺省 = 不过滤，**已过时条目默认仍会出现**（对照是它的全部价值）。用途：翻档案时只挑「已经作废的那批」看演替史。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          groups: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                bucket: { type: 'string', required: true },
                label: { type: 'string', required: true },
                level: { oneOf: [{ type: 'string', enum: ['day', 'week', 'month', 'year'] }, { type: 'null' }], required: true },
                items: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      id: { type: 'string', required: true },
                      kind: { type: 'string', required: true },
                      title: { type: 'string', required: true },
                      snippet: { type: 'string', required: true },
                      tags: { type: 'array', required: true, items: { type: 'string' } },
                      scope: { type: 'string', required: true },
                      transcriptiveUncited: {
                        type: 'boolean',
                        description: 'v0.19.1：**转述型·无出处**标记（**仅命中时出现**）——与 `recall` 同一字段同一判据（`origin.ts`）。翻档案时同样需要它：这条记忆的权威不是我实测来的。',
                      },
                      ...DIMENSION_ITEM_FIELDS,
                      ...DERIVED_ITEM_FIELDS,
                      level: { oneOf: [{ type: 'string', enum: ['day', 'week', 'month', 'year'] }, { type: 'null' }], required: true },
                      updatedAt: { type: 'string', required: true },
                      score: { type: 'number', required: true },
                      archived: { type: 'boolean', required: true },
                    },
                  },
                },
              },
            },
          },
          total: { type: 'integer', required: true },
        },
      },
      render: (args, value) => {
        // 时效维的判定基准：整批结果共用**同一时刻**——与 recall 同一条纪律
        // （避免渲染 N 条时前后条目的基准漂移）。
        const renderNow = new Date()
        const lines = value.groups.map((group) => {
          const levelNote = group.level !== null ? `（${group.level}概要）` : ''
          // 渲染 id（v0.11.0）：同 recall——id 一直在 output schema 里，此前 render 层漏掉，
          // 使「翻档案看到标题却无法对它做 update/forget/merge」
          // 维度标记（v0.13–v0.15）：与 recall 同一份渲染纪律（semantic.md「渲染纪律」段
          // **明列 memory_browse 为触发点之一**）——此前该工具的 schema 与 render **两处都缺**，
          // 文档承诺与实现不符。标记要挑着打：只凸显需警觉的档位，其余留空。
          const items = group.items
            .map((item) => {
              const stalenessNote = stalenessTag(item.reviewAfter, renderNow)
              const subjectNote = subjectTag(normalizeSubject(item.subject))
              const groundingNote = groundingTag(normalizeGrounding(item.grounding))
              // 转述型·无出处（v0.19.1）：与 recall 同一判据同一位置——两个界面同一事实不能长得不一样
              const transcriptiveNote = transcriptiveTag(item.transcriptiveUncited)
              // 来源 / 归档标记（v0.21.0）：与 recall 同一套渲染纪律（同一事实两个界面不能长得不一样）
              const provenanceNote = provenanceTag(item.provenance)
          // 证据标记（v0.25.0）：`⚓会话@33847` = 这条能回到该会话的那个事件位置。
          // 放在权威簇里（紧邻 provenance）：provenance 答「谁说的」，它答「去哪核」。
          const evidenceNote = evidenceTag(item.evidenceRefs)
          // 内容分类标记（v0.26.0）：`·语义` 拼进元数据方括号；未分类留空（标记要挑着打）
          const memTypeNote = memTypeTag(item.memType)
              const archiveNote = archiveReasonTag(item.archivedReasonType)
              // 执行位置标记（v0.23.0）：与 recall 同一位置、同一纪律（同一事实两个界面不能长得不一样）
              const projectNote = executionTag(item.project, item.taskId)
              const watchNote = watchForTag(item.watchFor)
              const cueNote = cueTag(item.cue)
              // 事实生命周期标记（v0.24.0）：与 recall 同一位置、同一纪律
              // （同一事实两个界面不能长得不一样）。已过时放最前，理由同 recall。
              const supersededNote = supersededByTag(item.supersededBy)
              const validAfterNote = validAfterTag(item.validAfter)
              const supersedesNote = supersedesTag(item.supersedes)
              return `  - ${lifecycleTag(item.lifecycle)}${supersededNote}${stalenessNote}${subjectNote}${groundingNote}${transcriptiveNote}${provenanceNote}${evidenceNote}${archiveNote}${projectNote}[${item.kind}${memTypeNote}${spaceTag(item.space)}] ${item.title}(id=${item.id})${validAfterNote.length > 0 ? ' ' + validAfterNote : ''}${watchNote.length > 0 ? ' ' + watchNote : ''}${cueNote.length > 0 ? ' ' + cueNote : ''}${supersedesNote}`
            })
            .join('\n')
          return `${group.label}${levelNote}（${group.items.length} 条）：\n${items}`
        })
        return [{
          type: 'text',
          text: `记忆档案（共 ${value.total} 组，显示 ${value.groups.length} 组）：\n${lines.join('\n')}`,
        }]
      },
    },
    async execute(args, exec) {
      const { config, cwd, view } = await resolveRuntime(exec, deps, args.role)
      const { readScopes } = resolveScopes({ configScope: config.scope, cwd, explicit: args.scope })
      // 生命周期筛（v0.27.0）：与 recall 同一条规则——按 archived/deleted 过滤时自动取归档，
      // 否则「翻已删除的条目」这条最基本的用法要先记得传 includeArchive。
      const statuses = parseLifecycleFilterArg(args.status, 'memory_browse.status')
      const wantsArchived = statuses !== undefined
        && statuses.some((state) => state === 'archived' || state === 'deleted')
      const includeArchive = args.includeArchive ?? wantsArchived
      const gathered = gatherReadable(deps, { readScopes, includeArchive, view, explicitScope: args.scope })
      // 主体层筛选（v0.13.0，可选筛子）：未给参数时零拷贝原样返回 ⇒ 存量行为不变
      // 时效维筛（v0.15.0）：第三级同为可选筛子。加在 browse 上不是「为对称而对称」——
      // **审查入口必须在所有读路径上可达**：否则「我以为能翻到，结果那个工具不支持」
      // 会复现 2026-09-26 那个坑（知道标题却拿不到 id，因为 render 层漏了字段）。
      const entries = filterByLifecycle(
        filterBySpace(
          filterByMemType(
            filterByStaleness(
              filterByProvenance(
                filterByGrounding(
                  filterByExecution(
                    filterBySubject(
                      // 替代状态筛（v0.24.0）：可选筛子（未给 = 零拷贝透传），审查入口与 recall 同源
                      filterBySuccession(gathered.entries, parseSupersessionFilterArg(args.superseded, 'memory_browse.superseded')),
                      parseSubjectArg(args.subject, 'memory_browse.subject'),
                    ),
                    parseExecutionArgs({ project: args.project, taskId: args.taskId }, 'memory_browse'),
                  ),
                  parseGroundingArg(args.grounding, 'memory_browse.grounding'),
                ),
                parseProvenanceArg(args.provenance, 'memory_browse.provenance'),
              ),
              parseStalenessFilterArg(args.staleness, 'memory_browse.staleness'),
              new Date(),
            ),
            // 内容分类筛（v0.26.0）：与 recall 同源，未给 = 零拷贝透传
            parseMemTypeFilterArg(args.memType, 'memory_browse.memType'),
          ),
          // 空间归属筛（v0.27.0）：同源，未给 = 零拷贝透传
          parseSpaceFilterArg(args.space, 'memory_browse.space'),
        ),
        statuses,
      )
      const result = browseEntries(entries, {
        kind: args.kind,
        tags: args.tags,
        since: args.since,
        until: args.until,
        scope: args.scope,
        includeArchive,
        level: args.level,
        page: args.page,
        pageSize: args.pageSize,
      })
      // 结果里补 label
      return {
        groups: result.groups.map((group) => ({ ...group, label: bucketLabel(group.bucket) })),
        total: result.total,
      }
    },
  })
}

/** 关系层取用：未接线时**响亮报错**（绝不静默降级成「没有关系」） */
function relationStoreOf(deps: MemoryToolDeps): RelationStore {
  if (deps.relations === undefined) {
    throw new Error(
      '关系层未接线（deps.relations 缺失）——类型化关系（v0.28.0 · 方案 §4.4）需要 index.ts 装配 '
      + '`new RelationStore(domain.table("relations"))`。这是装配缺陷，不是「库里没有关系」。',
    )
  }
  return deps.relations
}

/** 构建 memory_link 工具（v0.28.0 · 方案 §4.4）：建立一条类型化关系边 */
function buildLink(deps: MemoryToolDeps): ToolDefinition {
  return defineTool({
    name: 'memory_link',
    deferLoading: true,
    description: '建立一条**类型化关系边**（v0.28.0 · 方案 §4.4）：在两个记忆条目之间写下「A 支持 B」「A 派生自 B」「A 属于 B」这类**有类型、有方向、有来源**的断言。'
      + `十种类型：${RELATION_TYPES.map((type) => `${type}=${RELATION_TYPE_SPECS[type].label}`).join(' / ')}。`
      + '⚠ `supersedes`（取代）不在这里写——替代关系的唯一写入口是 `memory_supersede`（它写条目两侧字段），本工具会拒收。'
      + '关系是可退役的断言：用 `memory_unlink` 标记「它不再成立」（保留历史，不删记录）。'
      + '**何时用**：结论被证据支撑（supports）/ 我改主意的反证（refutes）/ 两条知识有强弱之分（derived-from）/ 项目归属（belongs-to）。'
      + '**何时不用**：只想打标签用 `tags`；只想说「两者有点像」用 `memory_relate`（统计相似，不落库）。',
    parameters: {
      type: { type: 'string', required: true, enum: [...RELATION_TYPES], description: `关系类型（必填）：${RELATION_TYPES.map((type) => `${type}=${RELATION_TYPE_SPECS[type].label}（${RELATION_TYPE_SPECS[type].note}）`).join('；')}` },
      from: { type: 'string', required: true, description: '起点条目 id（`RELATION_TYPE_SPECS` 里的 fromRole 那一端，如 supports 的「证据」端）。' },
      to: { type: 'string', required: true, description: '终点条目 id（toRole 那一端，如 supports 的「结论」端）。两端都必须在当前视野内存在（含归档）。' },
      provenance: { type: 'string', required: true, enum: [...PROVENANCE_TYPES], description: '关系来源（必填，**无默认值**）：这条边**凭什么说是这样**——master（主人说的）/ web（外部资料）/ self（我推的）/ measured（我实测的）。判断型字段禁默认值：不替你猜。' },
      confidence: { type: 'number', description: '可信度（0–1，可选；**不给 = 未评估**，不是 0 分）。只有你确实评估过才填。' },
      validFrom: { type: 'string', description: '该断言从何时成立（YYYY-MM-DD 或 ISO 时刻）。与 createdAt 的「我何时记下」不同——追认历史时用。' },
      validTo: { type: 'string', description: '该断言到何时为止（YYYY-MM-DD 或 ISO 时刻）。**过期 ≠ 作废**：边仍可查（memory_relations 的 includeExpired），只是不再算当前有效。' },
      evidenceRefs: { type: 'array', items: { type: 'string' }, description: '证据坐标（可选，沿用 v0.25 编码：`session|<id>|<seq>` / `compaction|<id>|<cid>` / `derived|<locator>`）。上限 8 条。' },
      note: { type: 'string', description: '人类可读补充（可选）。**它是数据不是指令**——注入/渲染时按不可信内容对待。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true, description: '边 id（幂等命中时是既有边的 id）' },
          type: { type: 'string', required: true },
          from: { type: 'string', required: true },
          to: { type: 'string', required: true },
          created: { type: 'boolean', required: true, description: 'true = 本次新建；false = 同型同向的有效边已存在（幂等，未写第二条）' },
          label: { type: 'string', required: true, description: '这条边的中文读法（如「支持」）' },
        },
      },
      render: (_a, v) => [{
        type: 'text',
        text: v.created
          ? `已建立关系：${v.label}（${v.type}）${shortId(v.from)} → ${shortId(v.to)}（边 id=${v.id}）。`
            + '\n可用 memory_relations({id}) 沿边行走；退役用 memory_unlink({id})。'
          : `该关系已存在：${v.label}（${v.type}）${shortId(v.from)} → ${shortId(v.to)}（边 id=${v.id}，未写第二条）。`,
      }],
    },
    async execute(args, exec) {
      const relations = relationStoreOf(deps)
      const { config, cwd, view } = await resolveRuntime(exec, deps)
      const { readScopes } = resolveScopes({ configScope: config.scope, cwd })

      const type = parseRelationTypeArg(args.type, 'memory_link.type')
      if (type === 'supersedes') {
        throw new Error(
          'memory_link: `supersedes`（取代）不由本工具写入——替代关系的唯一写入口是 `memory_supersede`'
          + '（它写条目两侧字段 `supersedes` / `supersededBy`，读侧由 memory_relations 派生呈现）。'
          + '两个真源必然漂移，故本层拒收。',
        )
      }
      const fromId = typeof args.from === 'string' ? args.from.trim() : ''
      const toId = typeof args.to === 'string' ? args.to.trim() : ''
      if (fromId.length === 0 || toId.length === 0) throw new Error('memory_link: from / to 都不能为空')
      if (fromId === toId) {
        throw new Error(
          `memory_link: from 与 to 不能相同（自环 ${fromId}）——自环让「这条还连着谁」永远答自己。`
          + '⚠ 常见原因不是笔误：两条要连的记忆**同标题**时 `remember` 的 L2/L3 合并会把它们写成一条'
          + '（回执 action=merged）⇒ 库里只有一条。请让两条用不同标题。',
        )
      }
      const provenance = parseProvenanceArg(args.provenance, 'memory_link.provenance')
      if (provenance === undefined) throw new Error('memory_link: provenance 必填（master / web / self / measured）——判断型字段禁默认值')
      const confidence = parseConfidenceArg(args.confidence, 'memory_link.confidence')
      const validFrom = parseValidTimeArg(args.validFrom, 'memory_link.validFrom')
      const validTo = parseValidTimeArg(args.validTo, 'memory_link.validTo')
      const evidenceRefs = parseEvidenceRefsArg(args.evidenceRefs, 'memory_link.evidenceRefs')
      const note = typeof args.note === 'string' && args.note.trim().length > 0 ? args.note.trim() : undefined

      // 两端都必须存在（含归档：指向一条已归档的原料是正当的——「这条结论派生自那条被归档的观察」）
      const { entries } = gatherReadable(deps, { readScopes, includeArchive: true, view })
      const from = entries.find((candidate) => candidate.id === fromId)
      const to = entries.find((candidate) => candidate.id === toId)
      const missing = [from === undefined ? `from="${fromId}"` : '', to === undefined ? `to="${toId}"` : ''].filter((part) => part !== '')
      if (missing.length > 0) {
        // 整笔拒绝、一条不写：半成品边比「没写」难查得多（同 memory_supersede 的裁决）
        throw new Error(`memory_link: 未找到 ${missing.join(' / ')}（当前视野内）——本次未写入任何边`)
      }

      const result = await relations.link({
        type,
        from: fromId,
        to: toId,
        scope: from!.scope,
        provenance,
        ...(confidence !== undefined ? { confidence } : {}),
        ...(validFrom !== undefined ? { validFrom } : {}),
        ...(validTo !== undefined ? { validTo } : {}),
        ...(evidenceRefs !== undefined ? { evidenceRefs } : {}),
        ...(note !== undefined ? { note } : {}),
      })
      return {
        id: result.relation.id,
        type,
        from: fromId,
        to: toId,
        created: result.created,
        label: RELATION_TYPE_SPECS[type].label,
      }
    },
  })
}

/** 构建 memory_unlink 工具：软退役一条边（不删记录） */
function buildUnlink(deps: MemoryToolDeps): ToolDefinition {
  return defineTool({
    name: 'memory_unlink',
    deferLoading: true,
    description: '退役一条类型化关系（v0.28.0）：把 `validTo` 设为退役时刻——**不删除记录**，历史仍可查（`memory_relations({includeExpired:true})`）。'
      + '「它曾经成立、现在不成立了」与「它从来没存在过」是两件事，删掉记录等于把后者写成前者。'
      + '用途：结论被推翻（连同 refutes 边一起撤）/ 项目归属改变 / 依赖关系解除。',
    parameters: {
      id: { type: 'string', required: true, description: '边 id（来自 memory_link / memory_relations）。' },
      reason: { type: 'string', description: '退役原因（可选；会追加到边的 note）。为什么不再成立，比「已退役」有用得多。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          changed: { type: 'boolean', required: true, description: 'true = 本次写入退役时刻；false = 本来就是已退役（未改写历史）' },
          type: { type: 'string', required: true },
          label: { type: 'string', required: true },
          validTo: { type: 'string', required: true, description: '退役时刻（ISO）' },
        },
      },
      render: (_a, v) => [{
        type: 'text',
        text: v.changed
          ? `已退役关系 ${v.label}（${v.type}，边 id=${v.id}）于 ${v.validTo}。记录保留，历史可查。`
          : `该关系本就已退役（边 id=${v.id}，validTo=${v.validTo}）——未改写退役时刻。`,
      }],
    },
    async execute(args, _exec) {
      const relations = relationStoreOf(deps)
      const id = typeof args.id === 'string' ? args.id.trim() : ''
      if (id.length === 0) throw new Error('memory_unlink: id 不能为空')
      const reason = typeof args.reason === 'string' ? args.reason : undefined
      const result = await relations.unlink(id, reason !== undefined ? { reason } : {})
      if (result === undefined) throw new Error(`memory_unlink: 未找到边 id="${id}"`)
      return {
        id: result.relation.id,
        changed: result.changed,
        type: result.relation.type,
        label: RELATION_TYPE_SPECS[result.relation.type].label,
        validTo: result.relation.validTo ?? result.relation.createdAt,
      }
    },
  })
}

/** 构建 memory_relations 工具：沿类型化关系行走（读路径） */
function buildRelations(deps: MemoryToolDeps): ToolDefinition {
  return defineTool({
    name: 'memory_relations',
    deferLoading: true,
    description: '读取一个条目的**类型化关系**（v0.28.0 · 方案 §4.4）：出边（它指向谁）/ 入边（谁指向它）/ 双向。'
      + '与 `memory_relate` 的分工：那个按共享标签与字面重叠算**统计相似**（不落库、只是线索）；本工具读**已写下的类型化断言**（有类型、方向、来源、有效期）。'
      + '另附**派生结构边**：条目字段里已有的 `supersededBy` / `supersedes`（取代）与 `archiveRef`（派生自）——它们不落盘，字段是唯一真源。'
      + '用于：沿「支持 / 反驳」追一条结论的证据链、查一个项目缺了什么依赖、看一条知识由哪些原料派生。',
    parameters: {
      id: { type: 'string', required: true, description: '节点 id（本版 = 记忆条目 id）。' },
      types: { type: 'array', items: { type: 'string', enum: [...RELATION_TYPES] }, description: '只看这些关系类型（任一命中）；缺省 = 全部。' },
      direction: { type: 'string', enum: ['out', 'in', 'both'], description: '方向：out=只看它指向别人 / in=只看别人指向它 / both（缺省）。' },
      includeExpired: { type: 'boolean', description: '是否包含已退役（validTo 已过）的边（缺省否）。⚠ 过期 ≠ 作废：想看「它曾经指向谁」时打开。' },
      includeArchive: { type: 'boolean', description: '对端是否包含已归档条目（缺省**是**——指向一条已归档原料的边正是最需要看见的）。' },
      limit: { type: 'integer', description: '边数上限（缺省 50）。' },
      scope: { type: 'string', description: '作用域覆盖（global 或 workspaceId）；缺省当前 workspace + global。' },
      role: { type: 'string', description: '角色视角覆盖（v0.5）：缺省按调用者会话身份推导。**两端都要通过准入**——看得见一端看不见另一端的边不返回（不泄露对端存在性）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          error: { type: 'string' },
          target: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              kind: { type: 'string', required: true },
              title: { type: 'string', required: true },
            },
          },
          edges: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                type: { type: 'string', required: true },
                label: { type: 'string', required: true },
                direction: { type: 'string', required: true },
                peer: { type: 'string', required: true },
                peerTitle: { type: 'string', required: true },
                provenance: { type: 'string', required: true },
                live: { type: 'boolean', required: true },
                pending: { type: 'boolean', required: true },
                confidence: { type: 'number' },
                validFrom: { type: 'string' },
                validTo: { type: 'string' },
                note: { type: 'string' },
              },
            },
          },
          structural: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                type: { type: 'string', required: true },
                label: { type: 'string', required: true },
                direction: { type: 'string', required: true },
                peer: { type: 'string', required: true },
                peerTitle: { type: 'string', required: true },
                origin: { type: 'string', required: true },
              },
            },
          },
          total: { type: 'integer', description: '类型化边数（截断前）。⚠ 失败时不含本键——「读不到」不写 0' },
        },
      },
      render: (_a, v) => {
        if (v.ok === false) return [{ type: 'text', text: '关系读取失败：' + String(v.error ?? '') }]
        const target = v.target
        if (target === undefined) return [{ type: 'text', text: '关系读取：目标条目缺失。' }]
        const edges = v.edges ?? []
        const structural = v.structural ?? []
        if (edges.length === 0 && structural.length === 0) {
          return [{ type: 'text', text: `关系：${target.title}(id=${target.id}) 目前没有任何边（类型化 0 条，派生结构 0 条）。\n用 memory_link 可建立类型化关系；tags / memory_relate 只能给线索，不是关系。` }]
        }
        const lines: string[] = []
        if (edges.length > 0) {
          lines.push(`类型化关系 ${edges.length} 条${(v.total ?? edges.length) > edges.length ? `（共 ${v.total}，已截断）` : ''}：`)
          for (const edge of edges) {
            const meta: string[] = [`来源${edge.provenance}`]
            if (edge.confidence !== undefined) meta.push(`可信度${edge.confidence}`)
            if (edge.validFrom !== undefined) meta.push(`自${edge.validFrom}`)
            if (edge.validTo !== undefined) meta.push(`至${edge.validTo}`)
            if (edge.live === false) meta.push('已过期')
            if (edge.pending) meta.push('未生效')
            lines.push(`- ${edge.direction === 'out' ? '→' : '←'} ${edge.label} ${edge.peerTitle}(id=${edge.peer})（${meta.join('·')}；边 ${shortId(edge.id)}）`)
            if (edge.note !== undefined && edge.note !== '') lines.push(`    · ${edge.note}`)
          }
        }
        if (structural.length > 0) {
          lines.push(`派生结构边 ${structural.length} 条（来自条目字段，不落盘）：`)
          for (const edge of structural) {
            lines.push(`- ${edge.direction === 'out' ? '→' : '←'} ${edge.label} ${edge.peerTitle}(id=${edge.peer})（字段 ${edge.origin}）`)
          }
        }
        return [{ type: 'text', text: `关系：${target.title}(id=${target.id})\n` + lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const relations = relationStoreOf(deps)
      const { config, cwd, view } = await resolveRuntime(exec, deps, args.role)
      const { readScopes } = resolveScopes({ configScope: config.scope, cwd, explicit: args.scope })
      const id = typeof args.id === 'string' ? args.id.trim() : ''
      if (id.length === 0) throw new Error('memory_relations: id 不能为空')
      const types = parseRelationTypesArg(args.types, 'memory_relations.types')
      const direction = args.direction === 'out' || args.direction === 'in' ? args.direction : 'both'
      const includeExpired = args.includeExpired === true
      const includeArchive = args.includeArchive !== false
      const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : 50

      // 视野内取数：两端都必须过准入（否则关系层会成为隔离缺口——同 memory_relate 的裁决）
      const { entries } = gatherReadable(deps, { readScopes, includeArchive, view, explicitScope: args.scope })
      const target = entries.find((candidate) => candidate.id === id)
      if (target === undefined) return { ok: false, error: `未找到 id="${id}" 的记忆条目（当前视野内）` }

      const titleById = new Map(entries.map((entry) => [entry.id, entry.title]))
      const scoped = relations.all().filter((relation) => readScopes.includes(relation.scope))
      // 两端都在视野内才返回：只因一端可见就暴露另一端的存在性，等于绕过准入
      const visible = scoped.filter((relation) => titleById.has(relation.from) && titleById.has(relation.to))
      const hits = edgesOf(visible, id, {
        ...(types !== undefined ? { types } : {}),
        direction,
        includeExpired,
        limit,
      })
      const structural = structuralHitsOf(
        entries.filter((entry) => includeArchive || !entry.archived),
        id,
      )
        .filter((edge) => titleById.has(edge.peer))
        .slice(0, limit)
      return {
        ok: true,
        target: { id: target.id, kind: target.kind, title: target.title },
        edges: hits.map((hit) => ({
          id: hit.relation.id,
          type: hit.relation.type,
          label: hit.label,
          direction: hit.direction,
          peer: hit.peer,
          peerTitle: titleById.get(hit.peer) ?? hit.peer,
          provenance: hit.relation.provenance,
          live: hit.live,
          pending: hit.pending,
          ...(hit.relation.confidence !== undefined ? { confidence: hit.relation.confidence } : {}),
          ...(hit.relation.validFrom !== undefined ? { validFrom: hit.relation.validFrom } : {}),
          ...(hit.relation.validTo !== undefined ? { validTo: hit.relation.validTo } : {}),
          ...(hit.relation.note !== undefined ? { note: hit.relation.note } : {}),
        })),
        structural: structural.map((edge) => ({
          type: edge.type,
          label: edge.label,
          direction: edge.direction,
          peer: edge.peer,
          peerTitle: titleById.get(edge.peer) ?? edge.peer,
          origin: edge.origin,
        })),
        total: hits.length,
      }
    },
  })
}

/** 概念内容签名：同 `entitySignature`——**不能用 `updatedAt` 判「改没改」**（同一毫秒内会相等） */
function conceptSignature(concept: {
  prefLabel: string
  altLabels?: string[]
  definition?: string
  scopeNote?: string
  broader?: string[]
  related?: string[]
}): string {
  return JSON.stringify([
    concept.prefLabel,
    concept.altLabels ?? [],
    concept.definition ?? '',
    concept.scopeNote ?? '',
    concept.broader ?? [],
    concept.related ?? [],
  ])
}

/** 词表取用：未接线时**响亮报错**（绝不静默降级成「没有这个概念」） */
function conceptStoreOf(deps: MemoryToolDeps): ConceptStore {
  if (deps.concepts === undefined) {
    throw new Error(
      '主题词表未接线（deps.concepts 缺失）——受控词表（v0.29.0 · 方案 §4.2）需要 index.ts 装配 '
      + '`new ConceptStore(domain.table("concepts"))`。这是装配缺陷，不是「词表里没有这个词」。',
    )
  }
  return deps.concepts
}

/** 构建 memory_concept 工具（v0.29.0 · 方案 §4.2）：维护受控词表的概念 */
function buildConcept(deps: MemoryToolDeps): ToolDefinition {
  return defineTool({
    name: 'memory_concept',
    deferLoading: true,
    description: '维护**受控词表**里的概念（v0.29.0 · 方案 §4.2 · 参考 SKOS）：新建 / 修改 / 停用，或批量导入。'
      + '一个概念 = 一个首选名（`prefLabel`）+ 若干同义词（`altLabels`）+ 定义 + 使用范围 + 上位（`broader`）+ 关联（`related`）。'
      + '**它解决什么**：`tags` 是自由文本，同义词各写各的（「记忆库」/「记忆系统」/「智能体记忆」），检索只能逐字匹配；词表让 `recall({expandThesaurus:true})` 按同义词扩展。'
      + '**唯一标签空间**：同一 scope 内任两个概念的标签不得归一后相同 ⇒ 冲突整笔拒绝（不许自动合并——两个同名词未必是同一件事）。'
      + '**停用不删除**：`deprecate` 只是「不再用」，旧记忆上的标签仍能解释。上位只存 `broader`，下位由反查派生（一个事实一个归宿）。',
    parameters: {
      id: { type: 'string', description: '概念 id（**给了就是修改**；不给 = 新建）。' },
      prefLabel: { type: 'string', description: '首选名（新建必填；同 scope 内唯一）。' },
      altLabels: { type: 'array', items: { type: 'string' }, description: '同义词与其他名称（整体替换；空数组 = 清空）。' },
      definition: { type: 'string', description: '概念定义（它是什么）。' },
      scopeNote: { type: 'string', description: '使用范围说明（什么时候该用它、什么时候不该用）。' },
      broader: { type: 'array', items: { type: 'string' }, description: '上位概念 id 列表（整体替换）。⚠ **只存上位**：下位由反查派生，不用手填；成环整笔拒绝。' },
      related: { type: 'array', items: { type: 'string' }, description: '关联概念 id 列表（整体替换）。**对称**：只写一侧，读时双向都算。' },
      deprecate: { type: 'boolean', description: '`true` = 停用该概念（需同时给 `id` 与 `reason`）。停用不删除：旧记忆上的标签仍可解释。' },
      reason: { type: 'string', description: '为什么改 / 为什么停用（可选，但记下来才有复核价值）。' },
      importJson: { type: 'string', description: '批量导入：JSON 字符串，形态 `{"concepts":[{prefLabel, altLabels, definition, broader, related}]}` 或直接数组。**验完全部再写全部**——任何一项非法则整批拒绝（半套词表比没有更坏）。' },
      scope: { type: 'string', description: '作用域（缺省当前 workspace；概念与条目同一套存储分区）。⚠ 标签唯一性只在同 scope 内成立。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true, description: 'created / updated / deprecated / unchanged / imported' },
          id: { type: 'string', required: true },
          prefLabel: { type: 'string', required: true },
          scope: { type: 'string', required: true },
          status: { type: 'string', description: 'deprecated 时出现（未给 = 适用中）' },
          altLabels: { type: 'array', items: { type: 'string' } },
          revisionCount: { type: 'integer', required: true, description: '该概念保留的变更记录条数' },
          imported: { type: 'integer', description: '批量导入时成功写入的概念数' },
        },
      },
      render: (_a, v) => [{
        type: 'text',
        text: v.action === 'imported'
          ? `已导入 ${v.imported} 个概念（首批 ${v.prefLabel}，id=${v.id}）。`
          : v.action === 'created'
            ? `已新建概念「${v.prefLabel}」(id=${v.id})${v.altLabels !== undefined && v.altLabels.length > 0 ? `，同义词：${v.altLabels.join(' / ')}` : ''}。`
            : v.action === 'updated'
              ? `已更新概念「${v.prefLabel}」(id=${v.id})，变更记录 ${v.revisionCount} 条。`
              : v.action === 'deprecated'
                ? `已停用概念「${v.prefLabel}」(id=${v.id})——记录保留，旧记忆上的标签仍可解释。`
                : `概念「${v.prefLabel}」(id=${v.id}) 无变化（给的字段与现值相同）。`,
      }],
    },
    async execute(args, exec) {
      const concepts = conceptStoreOf(deps)
      const { config, cwd } = await resolveRuntime(exec, deps)
      const { writeScope } = resolveScopes({ configScope: config.scope, cwd, explicit: args.scope })

      if (typeof args.importJson === 'string' && args.importJson.trim().length > 0) {
        let parsed: unknown
        try {
          parsed = JSON.parse(args.importJson)
        } catch (error) {
          throw new Error(`memory_concept.importJson: 不是合法 JSON（${error instanceof Error ? error.message : String(error)}）`)
        }
        const list = Array.isArray(parsed)
          ? parsed
          : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { concepts?: unknown }).concepts)
            ? (parsed as { concepts: unknown[] }).concepts
            : undefined
        if (list === undefined) throw new Error('memory_concept.importJson: 期望数组或 {concepts: [...]}')
        const drafts: ConceptDraft[] = list.map((item, index) => {
          if (typeof item !== 'object' || item === null) throw new Error(`memory_concept.importJson: 第 ${index + 1} 项不是对象`)
          const raw = item as Record<string, unknown>
          const prefLabel = typeof raw.prefLabel === 'string' ? raw.prefLabel : ''
          if (prefLabel.trim().length === 0) throw new Error(`memory_concept.importJson: 第 ${index + 1} 项缺 prefLabel`)
          const pickStrings = (value: unknown, field: string): string[] | undefined => {
            if (value === undefined) return undefined
            if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
              throw new Error(`memory_concept.importJson: 第 ${index + 1} 项 ${field} 必须是字符串数组`)
            }
            return value as string[]
          }
          return {
            scope: writeScope,
            prefLabel,
            ...(pickStrings(raw.altLabels, 'altLabels') !== undefined ? { altLabels: pickStrings(raw.altLabels, 'altLabels')! } : {}),
            ...(typeof raw.definition === 'string' ? { definition: raw.definition } : {}),
            ...(typeof raw.scopeNote === 'string' ? { scopeNote: raw.scopeNote } : {}),
            ...(pickStrings(raw.broader, 'broader') !== undefined ? { broader: pickStrings(raw.broader, 'broader')! } : {}),
            ...(pickStrings(raw.related, 'related') !== undefined ? { related: pickStrings(raw.related, 'related')! } : {}),
          }
        })
        const created = await concepts.importMany(drafts, writeScope)
        const first = created[0]!
        return {
          action: 'imported',
          id: first.id,
          prefLabel: first.prefLabel,
          scope: first.scope,
          revisionCount: (first.revisions ?? []).length,
          imported: created.length,
        }
      }

      const reason = typeof args.reason === 'string' ? args.reason : undefined
      if (args.deprecate === true) {
        const id = typeof args.id === 'string' ? args.id.trim() : ''
        if (id.length === 0) throw new Error('memory_concept: deprecate 需要 id')
        if (reason === undefined || reason.trim().length === 0) throw new Error('memory_concept: deprecate 需要 reason（为什么不再用）')
        const result = await concepts.deprecate(id, reason)
        return {
          action: result.changed ? 'deprecated' : 'unchanged',
          id: result.concept.id,
          prefLabel: result.concept.prefLabel,
          scope: result.concept.scope,
          status: 'deprecated',
          revisionCount: (result.concept.revisions ?? []).length,
        }
      }

      const id = typeof args.id === 'string' ? args.id.trim() : ''
      if (id.length > 0) {
        const patch = {
          ...(typeof args.prefLabel === 'string' ? { prefLabel: args.prefLabel } : {}),
          ...(Array.isArray(args.altLabels) ? { altLabels: args.altLabels as string[] } : {}),
          ...(typeof args.definition === 'string' ? { definition: args.definition } : {}),
          ...(typeof args.scopeNote === 'string' ? { scopeNote: args.scopeNote } : {}),
          ...(Array.isArray(args.broader) ? { broader: args.broader as string[] } : {}),
          ...(Array.isArray(args.related) ? { related: args.related as string[] } : {}),
        }
        const before = concepts.find(id)
        if (before === undefined) throw new Error(`memory_concept: 未找到概念 id="${id}"`)
        const updated = await concepts.update(id, patch, reason)
        const changed = conceptSignature(updated) !== conceptSignature(before)
        return {
          action: changed ? 'updated' : 'unchanged',
          id: updated.id,
          prefLabel: updated.prefLabel,
          scope: updated.scope,
          ...(updated.status !== undefined ? { status: updated.status } : {}),
          ...(updated.altLabels !== undefined ? { altLabels: updated.altLabels } : {}),
          revisionCount: (updated.revisions ?? []).length,
        }
      }

      const prefLabel = typeof args.prefLabel === 'string' ? args.prefLabel : ''
      if (prefLabel.trim().length === 0) throw new Error('memory_concept: 新建需要 prefLabel（首选名）；修改请给 id')
      const draft: ConceptDraft = {
        scope: writeScope,
        prefLabel,
        ...(Array.isArray(args.altLabels) ? { altLabels: args.altLabels as string[] } : {}),
        ...(typeof args.definition === 'string' ? { definition: args.definition } : {}),
        ...(typeof args.scopeNote === 'string' ? { scopeNote: args.scopeNote } : {}),
        ...(Array.isArray(args.broader) ? { broader: args.broader as string[] } : {}),
        ...(Array.isArray(args.related) ? { related: args.related as string[] } : {}),
      }
      const created = await concepts.create(draft)
      return {
        action: 'created',
        id: created.id,
        prefLabel: created.prefLabel,
        scope: created.scope,
        ...(created.altLabels !== undefined ? { altLabels: created.altLabels } : {}),
        revisionCount: (created.revisions ?? []).length,
      }
    },
  })
}

/** 构建 memory_thesaurus 工具（v0.29.0 · 方案 §4.2）：查词表 / 看概念详情 / 导出 */
function buildThesaurus(deps: MemoryToolDeps): ToolDefinition {
  return defineTool({
    name: 'memory_thesaurus',
    deferLoading: true,
    description: '查**受控词表**（v0.29.0 · 方案 §4.2）：按标签查概念（首选名或同义词都认）、看一个概念的上下位/关联/变更记录、或导出整份词表（SKOS-lite JSON，可再导入）。'
      + '**与 `tags` 的分工**：`tags` 是自由文本（逐字匹配），词表是**同义词与层级的唯一真源**——`recall({expandThesaurus:true})` 就是靠它把查询词换成全部写法。'
      + '缺省列出适用中的概念（停用的不列，`includeDeprecated:true` 才看；**停用不删除**：旧记忆上的标签还要能解释）。',
    parameters: {
      query: { type: 'string', description: '按标签查：命中首选名或任一**同义词**（归一后子串匹配，中文不需要分词）。' },
      id: { type: 'string', description: '看单个概念详情：含全部标签、定义、范围说明、下位（派生）、关联、上位链、变更记录。' },
      scope: { type: 'string', description: '作用域覆盖（缺省当前 workspace + global 一起查）。' },
      export: { type: 'boolean', description: '`true` = 导出整份词表（SKOS-lite JSON 字符串，含 prefLabel/altLabel/broader/related/definition/scopeNote/status）。' },
      includeDeprecated: { type: 'boolean', description: '是否包含已停用的概念（缺省否）。' },
      limit: { type: 'integer', description: '列表条数上限（缺省 50）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          mode: { type: 'string', required: true, description: 'lookup / detail / list / export' },
          total: { type: 'integer', required: true, description: '本次返回的概念数' },
          concepts: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                prefLabel: { type: 'string', required: true },
                altLabels: { type: 'array', items: { type: 'string' } },
                definition: { type: 'string' },
                scopeNote: { type: 'string' },
                status: { type: 'string' },
                broader: { type: 'array', items: { type: 'string' }, description: '上位概念**标题**（不是 id，便于直接读）' },
                narrower: { type: 'array', items: { type: 'string' }, description: '下位概念标题（反查派生，不存字段）' },
                related: { type: 'array', items: { type: 'string' }, description: '关联概念标题（对称，只写一侧也算）' },
                revisions: { type: 'integer', description: '变更记录条数（详情模式下出现）' },
              },
            },
          },
          exportJson: { type: 'string', description: 'export 模式下的整份词表 JSON' },
        },
      },
      render: (_a, v) => {
        if (v.mode === 'export') return [{ type: 'text', text: `词表导出：${v.total} 个概念\n\`\`\`json\n${v.exportJson ?? ''}\n\`\`\`` }]
        const concepts = v.concepts ?? []
        if (concepts.length === 0) {
          return [{ type: 'text', text: '词表：没有匹配的概念。\n用 memory_concept 建立概念（prefLabel + altLabels），之后 recall({expandThesaurus:true}) 才会按同义词扩展。' }]
        }
        const lines = concepts.map((concept) => {
          const parts: string[] = [`- 「${concept.prefLabel}」(id=${concept.id})`]
          if (concept.altLabels !== undefined && concept.altLabels.length > 0) parts.push(`同义词：${concept.altLabels.join(' / ')}`)
          if (concept.status === 'deprecated') parts.push('**已停用**')
          if (concept.definition !== undefined) parts.push(`定义：${concept.definition}`)
          if (concept.broader !== undefined && concept.broader.length > 0) parts.push(`上位：${concept.broader.join(' / ')}`)
          if (concept.narrower !== undefined && concept.narrower.length > 0) parts.push(`下位：${concept.narrower.join(' / ')}`)
          if (concept.related !== undefined && concept.related.length > 0) parts.push(`关联：${concept.related.join(' / ')}`)
          return parts.join('；')
        })
        return [{ type: 'text', text: `词表（${v.mode}）：${concepts.length} 个概念\n` + lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const concepts = conceptStoreOf(deps)
      const { config, cwd } = await resolveRuntime(exec, deps)
      const { readScopes } = resolveScopes({ configScope: config.scope, cwd, explicit: args.scope })
      const includeDeprecated = args.includeDeprecated === true
      const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : 50
      const titles = new Map(concepts.all().map((concept) => [concept.id, concept.prefLabel]))
      const titleOf = (id: string): string => titles.get(id) ?? id
      const view = (concept: ReturnType<ConceptStore['all']>[number], detail: boolean) => ({
        id: concept.id,
        prefLabel: concept.prefLabel,
        ...(concept.altLabels !== undefined ? { altLabels: concept.altLabels } : {}),
        ...(concept.definition !== undefined ? { definition: concept.definition } : {}),
        ...(concept.scopeNote !== undefined ? { scopeNote: concept.scopeNote } : {}),
        ...(concept.status !== undefined ? { status: concept.status } : {}),
        ...((concept.broader ?? []).length > 0 ? { broader: (concept.broader ?? []).map(titleOf) } : {}),
        ...(concepts.narrowerOf(concept.id).length > 0 ? { narrower: concepts.narrowerOf(concept.id).map((child) => child.prefLabel) } : {}),
        ...(concepts.relatedOf(concept.id).length > 0 ? { related: concepts.relatedOf(concept.id).map((peer) => peer.prefLabel) } : {}),
        ...(detail ? { revisions: (concept.revisions ?? []).length } : {}),
      })

      if (args.export === true) {
        const scoped = args.scope === undefined ? concepts.all() : concepts.byScope(String(args.scope))
        return { ok: true, mode: 'export', total: scoped.length, concepts: [], exportJson: concepts.exportJson(args.scope) }
      }

      const id = typeof args.id === 'string' ? args.id.trim() : ''
      if (id.length > 0) {
        const concept = concepts.find(id)
        if (concept === undefined) return { ok: false, mode: 'detail', total: 0, concepts: [] }
        return { ok: true, mode: 'detail', total: 1, concepts: [view(concept, true)] }
      }

      const query = typeof args.query === 'string' ? args.query.trim() : ''
      if (query.length > 0) {
        const hits = new Map<string, ReturnType<ConceptStore['all']>[number]>()
        for (const scope of readScopes) {
          const exact = concepts.findByLabel(scope, query)
          if (exact !== undefined) hits.set(exact.id, exact)
          for (const concept of concepts.expand(scope, query).concepts) hits.set(concept.id, concept)
        }
        const out = [...hits.values()]
          .filter((concept) => includeDeprecated || isConceptActive(concept))
          .slice(0, limit)
        return { ok: true, mode: 'lookup', total: out.length, concepts: out.map((concept) => view(concept, false)) }
      }

      const out = readScopes
        .flatMap((scope) => concepts.byScope(scope))
        .filter((concept) => includeDeprecated || isConceptActive(concept))
        .sort((a, b) => a.prefLabel.localeCompare(b.prefLabel))
        .slice(0, limit)
      return { ok: true, mode: 'list', total: out.length, concepts: out.map((concept) => view(concept, false)) }
    },
  })
}

/**
 * 实体内容签名：判定一次 update **是否真的改了东西**。
 *
 * ⚠ **不能用 `updatedAt` 比**：同一毫秒内 create + update 得到相同时间戳（2026-11-19 单测 E8 实测撞到）
 * ⇒ 真改了却被报成「无变化」，而那正是要回报给调用方的那一格。比内容本身才可靠。
 */
function entitySignature(entity: {
  canonicalName: string
  entityType: string
  aliases?: string[]
  firstSeen?: string
  topics?: string[]
  relatedEntities?: string[]
  disambiguation?: string
}): string {
  return JSON.stringify([
    entity.canonicalName,
    entity.entityType,
    entity.aliases ?? [],
    entity.firstSeen ?? '',
    entity.topics ?? [],
    entity.relatedEntities ?? [],
    entity.disambiguation ?? '',
  ])
}

/** 实体档取用：未接线时**响亮报错**（绝不静默降级成「库里没有这个实体」） */
function entityStoreOf(deps: MemoryToolDeps): EntityStore {
  if (deps.entities === undefined) {
    throw new Error(
      '实体权威档未接线（deps.entities 缺失）——实体档（v0.30.0 · 方案 §4.3）需要 index.ts 装配 '
      + '`new EntityStore(domain.table("entities"))`。这是装配缺陷，不是「实体库里没有它」。',
    )
  }
  return deps.entities
}

function sourceStoreOf(deps: MemoryToolDeps): SourceStore {
  if (deps.sources === undefined) {
    throw new Error(
      '来源实体未接线（deps.sources 缺失）——来源实体（v0.35 · 方案 §5.2）需要 index.ts 装配 '
      + '`new SourceStore(domain.table("sources"))`。这是装配缺陷，不是「来源库里没有它」。',
    )
  }
  return deps.sources
}

/** 实体档的标识符数组参数（fail-loud：非字符串数组不猜） */
function parseStringArrayArg(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${field}: 期望字符串数组`)
  }
  return value as string[]
}

/**
 * `topics` 的存在性校验（实体档不持有概念表 ⇒ 这一跳只能由工具层做）。
 *
 * 为什么必须校验：悬空的 topic id 会让「相关主题」永远渲染成一串裸 uuid，
 * 而那时的我已不知道它是「没建」还是「建了但删了」。
 */
function assertTopicsExist(deps: MemoryToolDeps, topics: string[] | undefined, scope: string): void {
  if (topics === undefined || topics.length === 0) return
  if (deps.concepts === undefined) {
    throw new Error('memory_entity.topics: 概念表未接线，无法校验 topics 指向的概念——宁可不写，也不写悬空引用')
  }
  for (const topicId of topics) {
    const concept = deps.concepts.find(topicId)
    if (concept === undefined) {
      throw new Error(`memory_entity.topics: 概念 id="${topicId}" 不存在（先用 memory_concept 建立，或 memory_thesaurus 查 id）`)
    }
    if (concept.scope !== scope) {
      throw new Error(`memory_entity.topics: 概念 "${topicId}" 在 ${concept.scope}，实体在 ${scope}——引用不能跨 scope`)
    }
  }
}

/** 构建 memory_entity 工具（v0.30.0 · 方案 §4.3）：维护实体权威档 */
function buildEntity(deps: MemoryToolDeps): ToolDefinition {
  return defineTool({
    name: 'memory_entity',
    deferLoading: true,
    description: '维护**实体权威档**（v0.30.0 · 方案 §4.3 规范控制）：新建 / 修改 / 合并 / 停用。'
      + '一个实体 = 唯一 ID（`ENTITY-0001`）+ 规范名 + 别名 + 实体类型 + 首次出现 + 相关主题（概念 id）+ 关联实体 + 消歧说明 + 状态。'
      + '**与词表的分工**：概念是主题（一个词只指一个概念），实体是**现实对象**（人 / 项目 / 机构 / 作品 / 地点）——同一个对象的多种称呼收在一处（规范名 + 别名）。'
      + '**别名可多指**：两个不同实体可以同名（方案 §4.3 明确不许因同名就合并）⇒ 撞名时必须给 `disambiguation` 写清凭什么区分，否则整笔拒绝。'
      + '**合并必须显式**：`mergeInto` 把旧档的全部称呼并入存续档，旧档标 merged 指向存续档（不删除；只保留一层，不链式）。',
    parameters: {
      id: { type: 'string', description: '实体 id（`ENTITY-0001`）：**给了就是修改**（或 mergeInto / deprecate 的对象）；不给 = 新建。' },
      canonicalName: { type: 'string', description: '规范名（新建必填）：档案对外用的首选称呼。' },
      entityType: { type: 'string', description: '实体类型（新建必填、不枚举）：人 / 项目 / 机构 / 作品 / 地点……它是消歧的第一依据。' },
      aliases: { type: 'array', items: { type: 'string' }, description: '别名（整体替换；空数组 = 清空）：简称 / 英文名 / 历史名称。' },
      firstSeen: { type: 'string', description: '首次出现（自由文本：会话 id / 记忆 id / 一句描述）——与建档时刻不是一回事。' },
      topics: { type: 'array', items: { type: 'string' }, description: '相关主题：主题词表里的**概念 id** 列表（整体替换）。' },
      relatedEntities: { type: 'array', items: { type: 'string' }, description: '关联实体：实体 id 列表（整体替换）。只能指向同 scope 的**存续档**。' },
      disambiguation: { type: 'string', description: '消歧说明：与别的实体同名时凭什么区分（撞名时必填）。' },
      mergeInto: { type: 'string', description: '合并：把 `id` 这个旧档并入本字段指定的存续档 id。**显式动作**——不做同名自动合并。' },
      deprecate: { type: 'boolean', description: '`true` = 停用该实体（需同时给 `id` 与 `reason`）。停用不删除：旧记忆里提到的它仍能解释。' },
      reason: { type: 'string', description: '为什么改 / 为什么合并 / 为什么停用（可选，但记下来才有复核价值）。' },
      scope: { type: 'string', description: '作用域（缺省当前 workspace；实体与条目同一套存储分区）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true, description: 'created / updated / merged / deprecated / unchanged' },
          id: { type: 'string', required: true },
          canonicalName: { type: 'string', required: true },
          entityType: { type: 'string', required: true },
          scope: { type: 'string', required: true },
          status: { type: 'string', description: 'merged / deprecated 时出现（未给 = 适用中）' },
          aliases: { type: 'array', items: { type: 'string' } },
          mergedInto: { type: 'string', description: 'merged 态指向的存续档 id' },
          absorbedId: { type: 'string', description: '合并动作里被并入的旧档 id' },
          revisionCount: { type: 'integer', required: true, description: '该实体保留的变更记录条数' },
        },
      },
      render: (_a, v) => [{
        type: 'text',
        text: v.action === 'created'
          ? `已建实体档「${v.canonicalName}」(id=${v.id}，类型 ${v.entityType})${v.aliases !== undefined && v.aliases.length > 0 ? `，别名：${v.aliases.join(' / ')}` : ''}。`
          : v.action === 'merged'
            ? `已合并：${v.absorbedId ?? '（旧档）'} → 「${v.canonicalName}」(id=${v.id})——旧档保留并指向存续档，称呼已并入。`
            : v.action === 'deprecated'
              ? `已停用实体档「${v.canonicalName}」(id=${v.id})——记录保留，旧记忆里提到的它仍可解释。`
              : v.action === 'updated'
                ? `已更新实体档「${v.canonicalName}」(id=${v.id})，变更记录 ${v.revisionCount} 条。`
                : `实体档「${v.canonicalName}」(id=${v.id}) 无变化（给的字段与现值相同）。`,
      }],
    },
    async execute(args, exec) {
      const entities = entityStoreOf(deps)
      const { config, cwd } = await resolveRuntime(exec, deps)
      const { writeScope } = resolveScopes({ configScope: config.scope, cwd, explicit: args.scope })
      const reason = typeof args.reason === 'string' ? args.reason : undefined
      const id = typeof args.id === 'string' ? args.id.trim() : ''
      const mergeInto = typeof args.mergeInto === 'string' ? args.mergeInto.trim() : ''

      if (mergeInto.length > 0) {
        if (id.length === 0) throw new Error('memory_entity: mergeInto 需要同时给 id（被并入的旧档）与 mergeInto（存续档 id）')
        const result = await entities.mergeInto(id, mergeInto, reason)
        const survivor = result.survivor
        return {
          action: result.changed ? 'merged' : 'unchanged',
          id: survivor.id,
          canonicalName: survivor.canonicalName,
          entityType: survivor.entityType,
          scope: survivor.scope,
          ...(survivor.status !== undefined ? { status: survivor.status } : {}),
          ...(survivor.aliases !== undefined ? { aliases: survivor.aliases } : {}),
          ...(survivor.mergedInto !== undefined ? { mergedInto: survivor.mergedInto } : {}),
          ...(result.changed ? { absorbedId: result.absorbed.id } : {}),
          revisionCount: (survivor.revisions ?? []).length,
        }
      }

      if (args.deprecate === true) {
        if (id.length === 0) throw new Error('memory_entity: deprecate 需要 id')
        if (reason === undefined || reason.trim().length === 0) throw new Error('memory_entity: deprecate 需要 reason（为什么不再用）')
        const result = await entities.deprecate(id, reason)
        return {
          action: result.changed ? 'deprecated' : 'unchanged',
          id: result.entity.id,
          canonicalName: result.entity.canonicalName,
          entityType: result.entity.entityType,
          scope: result.entity.scope,
          status: 'deprecated',
          revisionCount: (result.entity.revisions ?? []).length,
        }
      }

      if (id.length > 0) {
        const before = entities.find(id)
        if (before === undefined) throw new Error(`memory_entity: 未找到实体 id="${id}"`)
        const topics = parseStringArrayArg(args.topics, 'memory_entity.topics')
        const relatedEntities = parseStringArrayArg(args.relatedEntities, 'memory_entity.relatedEntities')
        assertTopicsExist(deps, topics, before.scope)
        const patch = {
          ...(typeof args.canonicalName === 'string' ? { canonicalName: args.canonicalName } : {}),
          ...(typeof args.entityType === 'string' ? { entityType: args.entityType } : {}),
          ...(Array.isArray(args.aliases) ? { aliases: args.aliases as string[] } : {}),
          ...(typeof args.firstSeen === 'string' ? { firstSeen: args.firstSeen } : {}),
          ...(topics !== undefined ? { topics } : {}),
          ...(relatedEntities !== undefined ? { relatedEntities } : {}),
          ...(typeof args.disambiguation === 'string' ? { disambiguation: args.disambiguation } : {}),
        }
        const updated = await entities.update(id, patch, reason)
        const changed = entitySignature(updated) !== entitySignature(before)
        return {
          action: changed ? 'updated' : 'unchanged',
          id: updated.id,
          canonicalName: updated.canonicalName,
          entityType: updated.entityType,
          scope: updated.scope,
          ...(updated.status !== undefined ? { status: updated.status } : {}),
          ...(updated.aliases !== undefined ? { aliases: updated.aliases } : {}),
          revisionCount: (updated.revisions ?? []).length,
        }
      }

      const canonicalName = typeof args.canonicalName === 'string' ? args.canonicalName : ''
      if (canonicalName.trim().length === 0) throw new Error('memory_entity: 新建需要 canonicalName（规范名）；修改请给 id')
      const entityType = typeof args.entityType === 'string' ? args.entityType : ''
      const topics = parseStringArrayArg(args.topics, 'memory_entity.topics')
      const relatedEntities = parseStringArrayArg(args.relatedEntities, 'memory_entity.relatedEntities')
      assertTopicsExist(deps, topics, writeScope)
      const draft: EntityDraft = {
        scope: writeScope,
        canonicalName,
        entityType,
        ...(Array.isArray(args.aliases) ? { aliases: args.aliases as string[] } : {}),
        ...(typeof args.firstSeen === 'string' ? { firstSeen: args.firstSeen } : {}),
        ...(topics !== undefined ? { topics } : {}),
        ...(relatedEntities !== undefined ? { relatedEntities } : {}),
        ...(typeof args.disambiguation === 'string' ? { disambiguation: args.disambiguation } : {}),
      }
      const created = await entities.create(draft)
      return {
        action: 'created',
        id: created.id,
        canonicalName: created.canonicalName,
        entityType: created.entityType,
        scope: created.scope,
        ...(created.aliases !== undefined ? { aliases: created.aliases } : {}),
        revisionCount: (created.revisions ?? []).length,
      }
    },
  })
}

/** `memory_entities` 的实体投影形状（与 output schema 逐键对应；schema 是契约面） */
interface EntityView {
  id: string
  canonicalName: string
  entityType: string
  scope: string
  aliases?: string[]
  firstSeen?: string
  disambiguation?: string
  status?: string
  mergedInto?: string
  topics?: string[]
  relatedEntities?: string[]
  revisions?: number
  mentions?: Array<{ id: string; title: string; kind: string }>
}

/** 构建 memory_entities 工具（v0.30.0 · 方案 §4.3）：按称呼解析 / 看详情 / 列表 */
function buildEntities(deps: MemoryToolDeps): ToolDefinition {
  return defineTool({
    name: 'memory_entities',
    deferLoading: true,
    description: '查**实体权威档**（v0.30.0 · 方案 §4.3）：按称呼解析（规范名或别名都认）→ 实体档 + 提到它的条目；按 id 看详情；或列出实体。'
      + '**多命中不猜**：同名不同实体会全部返回并标 `ambiguous=true`——判断型字段禁默认值，程序不替你挑。'
      + '「提到它的条目」按名称在标题 / 正文 / 标签 / 别名里做**包含匹配**（本期不落边：`entry → entity` 的类型化边要等「实体节点如何过角色准入」定下来）。'
      + '与 `memory_thesaurus` 的分工：那个查**主题**（概念），这个查**现实对象**（人 / 项目 / 机构）。',
    parameters: {
      name: { type: 'string', description: '任意写法（规范名 / 别名），归一后**精确**匹配；多命中会全部返回。' },
      id: { type: 'string', description: '实体 id（`ENTITY-0001`）：给了就看详情（含变更记录条数与被引用情况）。' },
      entityType: { type: 'string', description: '只看该实体类型（列表模式过滤）。' },
      includeDeprecated: { type: 'boolean', description: '是否包含已停用的实体（缺省否）。' },
      includeMerged: { type: 'boolean', description: '是否包含已合并的旧档（缺省否；打开后它们指向存续档）。' },
      withEntries: { type: 'boolean', description: '是否反查提到该实体的条目（缺省**是**；按名称包含匹配，最多 5 条）。' },
      limit: { type: 'integer', description: '实体数上限（缺省 20）。' },
      scope: { type: 'string', description: '作用域覆盖（global 或 workspaceId）；缺省当前 workspace + global。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          mode: { type: 'string', required: true, description: 'lookup / detail / list' },
          total: { type: 'integer', required: true },
          ambiguous: { type: 'boolean', description: '有多个适用中的候选（同名不同实体）——必须靠 disambiguation / entityType 判断' },
          entities: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                canonicalName: { type: 'string', required: true },
                entityType: { type: 'string', required: true },
                scope: { type: 'string', required: true },
                aliases: { type: 'array', items: { type: 'string' } },
                firstSeen: { type: 'string' },
                disambiguation: { type: 'string' },
                status: { type: 'string' },
                mergedInto: { type: 'string' },
                topics: { type: 'array', items: { type: 'string' }, description: '相关主题的**概念标题**（不是 id，便于直接读）' },
                relatedEntities: { type: 'array', items: { type: 'string' }, description: '关联实体的**规范名**' },
                revisions: { type: 'integer', description: '变更记录条数（详情模式下出现）' },
                mentions: {
                  type: 'array',
                  description: '提到它的条目（按名称包含匹配；不是类型化边）',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      id: { type: 'string', required: true },
                      title: { type: 'string', required: true },
                      kind: { type: 'string', required: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
      render: (_a, v) => {
        const list = v.entities ?? []
        if (list.length === 0) {
          return [{ type: 'text', text: '实体档：没有匹配的实体。\n用 memory_entity 建档（canonicalName + entityType + aliases）；`aliases` 条目字段是**检索别名**，不是实体档。' }]
        }
        const lines: string[] = []
        if (v.ambiguous === true) {
          lines.push(`⚠ 有 ${list.length} 个适用中的候选（同名不同实体）——**别默认取第一个**：看 \`disambiguation\` / \`entityType\` / 提到的条目再判断。`)
        }
        for (const entity of list) {
          const parts: string[] = [`- 「${entity.canonicalName}」(id=${entity.id}；${entity.entityType})`]
          if (entity.aliases !== undefined && entity.aliases.length > 0) parts.push(`别名：${entity.aliases.join(' / ')}`)
          if (entity.status !== undefined) parts.push(entity.status === 'merged' ? `**已合并 → ${entity.mergedInto ?? '（缺存续档）'}**` : '**已停用**')
          if (entity.disambiguation !== undefined) parts.push(`消歧：${entity.disambiguation}`)
          if (entity.firstSeen !== undefined) parts.push(`首次出现：${entity.firstSeen}`)
          if (entity.topics !== undefined && entity.topics.length > 0) parts.push(`相关主题：${entity.topics.join(' / ')}`)
          if (entity.relatedEntities !== undefined && entity.relatedEntities.length > 0) parts.push(`关联实体：${entity.relatedEntities.join(' / ')}`)
          lines.push(parts.join('；'))
          const mentions = entity.mentions ?? []
          if (mentions.length > 0) {
            lines.push(`    · 提到它的条目 ${mentions.length} 条：${mentions.map((mention) => `${mention.title}(id=${mention.id})`).join('；')}`)
          }
        }
        return [{ type: 'text', text: `实体档（${v.mode}）：${list.length} 条\n` + lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const entities = entityStoreOf(deps)
      const { config, cwd, view } = await resolveRuntime(exec, deps)
      const { readScopes } = resolveScopes({ configScope: config.scope, cwd, explicit: args.scope })
      const includeDeprecated = args.includeDeprecated === true
      const includeMerged = args.includeMerged === true
      const withEntries = args.withEntries !== false
      const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : 20
      const typeFilter = typeof args.entityType === 'string' && args.entityType.trim() !== '' ? args.entityType.trim() : undefined

      const topicTitleOf = (id: string): string => deps.concepts?.find(id)?.prefLabel ?? id
      const entityNameOf = (id: string): string => entities.find(id)?.canonicalName ?? id
      // 提到它的条目：只在**可见集合**里找（视野外的条目不得因为「提到了某个实体」而泄露存在性）
      const readable = withEntries
        ? gatherReadable(deps, { readScopes, includeArchive: false, view, explicitScope: args.scope }).entries
        : []
      const mentionsOf = (entity: ReturnType<EntityStore['all']>[number]): Array<{ id: string; title: string; kind: string }> => {
        if (!withEntries) return []
        const keys = namesOf(entity).map(normalizeEntityName).filter((key) => key.length >= 2)
        if (keys.length === 0) return []
        const hits: Array<{ id: string; title: string; kind: string }> = []
        for (const entry of readable) {
          const hay = (entry.title + '\n' + entry.body + '\n' + entry.tags.join('\n') + '\n' + (entry.aliases ?? []).join('\n')).toLowerCase()
          if (!keys.some((key) => matchesName(hay, key))) continue
          hits.push({ id: entry.id, title: entry.title, kind: entry.kind })
          if (hits.length >= 5) break
        }
        return hits
      }
      const viewOf = (entity: ReturnType<EntityStore['all']>[number], detail: boolean): EntityView => ({
        id: entity.id,
        canonicalName: entity.canonicalName,
        entityType: entity.entityType,
        scope: entity.scope,
        ...(entity.aliases !== undefined ? { aliases: entity.aliases } : {}),
        ...(entity.firstSeen !== undefined ? { firstSeen: entity.firstSeen } : {}),
        ...(entity.disambiguation !== undefined ? { disambiguation: entity.disambiguation } : {}),
        ...(entity.status !== undefined ? { status: entity.status } : {}),
        ...(entity.mergedInto !== undefined ? { mergedInto: entity.mergedInto } : {}),
        ...((entity.topics ?? []).length > 0 ? { topics: (entity.topics ?? []).map(topicTitleOf) } : {}),
        ...((entity.relatedEntities ?? []).length > 0 ? { relatedEntities: (entity.relatedEntities ?? []).map(entityNameOf) } : {}),
        ...(detail ? { revisions: (entity.revisions ?? []).length } : {}),
        ...(withEntries ? { mentions: mentionsOf(entity) } : {}),
      })

      const id = typeof args.id === 'string' ? args.id.trim() : ''
      if (id.length > 0) {
        const entity = entities.find(id)
        if (entity === undefined) return { ok: false, mode: 'detail', total: 0, entities: [] }
        return { ok: true, mode: 'detail', total: 1, ambiguous: false, entities: [viewOf(entity, true)] }
      }

      const name = typeof args.name === 'string' ? args.name.trim() : ''
      if (name.length > 0) {
        const seen = new Map<string, ReturnType<EntityStore['all']>[number]>()
        for (const scope of readScopes) {
          const resolution = entities.resolveName(scope, name)
          for (const entity of resolution.active) seen.set(entity.id, entity)
          // 已合并 / 已停用只在该开关打开时出现——它们的默认缺席不是「查不到」
          if (includeMerged) for (const hit of resolution.merged) seen.set(hit.entity.id, hit.entity)
          if (includeDeprecated) for (const entity of resolution.deprecated) seen.set(entity.id, entity)
        }
        const hits = [...seen.values()].filter((entity) => typeFilter === undefined || entity.entityType === typeFilter)
        const activeHits = hits.filter((entity) => isEntityActive(entity))
        return {
          ok: true,
          mode: 'lookup',
          total: hits.length,
          ambiguous: activeHits.length > 1,
          entities: hits.slice(0, limit).map((entity) => viewOf(entity, false)),
        }
      }

      const out = readScopes
        .flatMap((scope) => entities.byScope(scope))
        .filter((entity) => (includeMerged || entity.status !== 'merged') && (includeDeprecated || entity.status !== 'deprecated'))
        .filter((entity) => typeFilter === undefined || entity.entityType === typeFilter)
        .sort((a, b) => a.canonicalName.localeCompare(b.canonicalName))
        .slice(0, limit)
      return { ok: true, mode: 'list', total: out.length, ambiguous: false, entities: out.map((entity) => viewOf(entity, false)) }
    },
  })
}

/** 构建 memory_source 工具（v0.35 · 方案 §5.2）：维护来源实体 */
function buildSource(deps: MemoryToolDeps): ToolDefinition {
  return defineTool({
    name: 'memory_source',
    deferLoading: true,
    description: '维护**来源实体**（v0.35 · 方案 §5.2）：新建 / 修改 / 停用。'
      + '一个来源 = 唯一 ID（`SOURCE-0001`）+ 类型 + 位置 + 采集时刻 + 提供方 + 可靠度 + 权限 + 说明 + 状态。'
      + '**为什么要有它**：现有三种来源载体（条目的 `source{}`、`evidenceRefs` 坐标串、`sourced-from` 边）都只回答「在哪」，不回答「谁提供 / 多可靠 / 什么权限」。'
      + '**可靠度与权限没有默认值**：不填 = 未标注，不是「中等」或「无限制」。'
      + '**停用不删除**：停用后不进候选，但按 id 直查仍能取回——历史引用不会变成悬空。',
    parameters: {
      id: { type: 'string', description: '来源 id（`SOURCE-0001`）：**给了就是修改**（或停用对象）；不给 = 新建。' },
      type: { type: 'string', description: '来源类型（新建必填）：master（主人说的）/ web（网页·论文）/ self（我推的·我提的）/ measured（我实测的）——与条目 provenance 同一枚举。' },
      location: { type: 'string', description: '位置（新建必填）：`session:<id>#<seq>` / `url:<地址>` / `file:<路径>` / `compaction:<id>#<cid>`。' },
      collectedAt: { type: 'string', description: '采集时刻（ISO；新建缺省 = 此刻）。复用它时应显式给原时刻——它不是「最后写入时间」。' },
      owner: { type: 'string', description: '提供方（与 type 正交）：谁给的。自由文本。' },
      reliability: { type: 'string', description: '可靠度——**不给就是未标注**，不是「中等」。' },
      permissions: { type: 'array', items: { type: 'string' }, description: '权限（整体替换）：本阶段只存不判，不构成准入。' },
      label: { type: 'string', description: '人读说明。' },
      retire: { type: 'boolean', description: '`true` = 停用该来源（需同时给 `id` 与 `reason`）。停用不删除。' },
      reason: { type: 'string', description: '为什么改 / 为什么停用（可选，但记下来才有复核价值）。' },
      scope: { type: 'string', description: '作用域（缺省当前 workspace；来源与条目同一套存储分区）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true, description: 'created / updated / retired / unchanged' },
          id: { type: 'string', required: true },
          type: { type: 'string', required: true },
          location: { type: 'string', required: true },
          scope: { type: 'string', required: true },
          status: { type: 'string', description: 'retired 时出现（未给 = 适用中）' },
          reliability: { type: 'string', description: '未标注时**不出现**这个键' },
          revisionCount: { type: 'integer', required: true, description: '该来源保留的变更记录条数' },
        },
      },
      render: (_a, v) => [{
        type: 'text',
        text: v.action === 'created'
          ? `已建来源「${v.location}」(id=${v.id}，类型 ${v.type})${v.reliability !== undefined ? `，可靠度：${v.reliability}` : '，可靠度**未标注**'}。`
          : v.action === 'retired'
            ? `已停用来源 ${v.id}——记录保留，按 id 直查仍可回。`
            : v.action === 'updated'
              ? `已更新来源 ${v.id}，变更记录 ${v.revisionCount} 条。`
              : `来源 ${v.id} 无变化（给的字段与现值相同）。`,
      }],
    },
    async execute(args, exec) {
      const sources = sourceStoreOf(deps)
      const { config, cwd } = await resolveRuntime(exec, deps)
      const { writeScope } = resolveScopes({ configScope: config.scope, cwd, explicit: args.scope })
      const reason = typeof args.reason === 'string' ? args.reason : undefined
      const id = typeof args.id === 'string' ? args.id.trim() : ''
      const pick = (source: { id: string; type: string; location: string; scope: string; status?: 'active' | 'retired'; reliability?: string; revisions?: unknown[] }) => ({
        id: source.id,
        type: source.type,
        location: source.location,
        scope: source.scope,
        ...(source.status !== undefined ? { status: source.status } : {}),
        ...(source.reliability !== undefined ? { reliability: source.reliability } : {}),
        revisionCount: (source.revisions ?? []).length,
      })

      if (args.retire === true) {
        if (id.length === 0) throw new Error('memory_source: retire 需要 id')
        if (reason === undefined || reason.trim().length === 0) {
          throw new Error('memory_source: retire 需要 reason（为什么不再采信它）')
        }
        const result = await sources.retire(writeScope, id, reason)
        return { action: result.changed ? 'retired' : 'unchanged', ...pick(result.source) }
      }

      if (id.length > 0) {
        const before = sources.find(writeScope, id)
        if (before === undefined) throw new Error(`memory_source: 未找到 id="${id}"（scope=${writeScope}）`)
        const patch: SourcePatch = {
          ...(typeof args.type === 'string' && args.type.trim() !== '' ? { type: args.type.trim() as SourceType } : {}),
          ...(typeof args.location === 'string' ? { location: args.location } : {}),
          ...(typeof args.owner === 'string' ? { owner: args.owner } : {}),
          ...(typeof args.reliability === 'string' ? { reliability: args.reliability } : {}),
          ...(Array.isArray(args.permissions) ? { permissions: args.permissions.map((item) => String(item)) } : {}),
          ...(typeof args.label === 'string' ? { label: args.label } : {}),
        }
        const updated = await sources.update(writeScope, id, patch, reason)
        // Store 的 update 在无变化时返回原对象（`updatedAt` 不动）——用它判 unchanged，
        // 而不是对比前后两个对象引用（KV 读取返回副本，引用永不相等）。
        return { action: updated.updatedAt === before.updatedAt ? 'unchanged' : 'updated', ...pick(updated) }
      }

      const type = typeof args.type === 'string' ? args.type.trim() : ''
      if (type === '') throw new Error('memory_source: 新建需要 type（master / web / self / measured）')
      const created = await sources.create({
        scope: writeScope,
        type: type as SourceType,
        location: typeof args.location === 'string' ? args.location : '',
        ...(typeof args.collectedAt === 'string' && args.collectedAt.trim() !== '' ? { collectedAt: args.collectedAt } : {}),
        ...(typeof args.owner === 'string' ? { owner: args.owner } : {}),
        ...(typeof args.reliability === 'string' ? { reliability: args.reliability } : {}),
        ...(Array.isArray(args.permissions) ? { permissions: args.permissions.map((item) => String(item)) } : {}),
        ...(typeof args.label === 'string' ? { label: args.label } : {}),
      })
      return { action: 'created', ...pick(created) }
    },
  })
}

/** 构建 memory_sources 工具（v0.35 · 方案 §5.2）：查来源 + 按来源反查引用它的条目 */
function buildSources(deps: MemoryToolDeps): ToolDefinition {
  return defineTool({
    name: 'memory_sources',
    deferLoading: true,
    description: '查**来源实体**（v0.35 · 方案 §5.2）：按 id 看详情 + 反查引用它的条目；或按类型 / 提供方 / 状态列表。'
      + '**反查只认显式引用**（条目 `sourceIds` 里写了它），不做「正文里提到了这个网址」这种猜测——那是另一回事，混进来会让「可追溯」这个词失去意义。'
      + '**未标注可靠度能单独筛**（`unlabeledReliability=true`）：判断型字段的「不知道」必须能看见，不能被并进某个默认档。'
      + '**停用的来源按 id 直查仍能取回**（列表模式默认不含）。',
    parameters: {
      id: { type: 'string', description: '来源 id：给了就看详情 + 反查引用它的条目。' },
      type: { type: 'string', description: '只看该类型（列表模式过滤）。' },
      owner: { type: 'string', description: '只看该提供方（列表模式过滤）。' },
      status: { type: 'string', description: '`active` / `retired`（缺省不过滤）。' },
      unlabeledReliability: { type: 'boolean', description: '只看**未标注可靠度**的来源。' },
      withEntries: { type: 'boolean', description: '是否反查引用它的条目（缺省**是**）。' },
      limit: { type: 'integer', description: '条数上限（缺省 20）。' },
      scope: { type: 'string', description: '作用域覆盖（global 或 workspaceId）；缺省当前 workspace + global。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          mode: { type: 'string', required: true, description: 'detail / list' },
          total: { type: 'integer', required: true },
          sources: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                type: { type: 'string', required: true },
                location: { type: 'string', required: true },
                scope: { type: 'string', required: true },
                collectedAt: { type: 'string', required: true },
                owner: { type: 'string' },
                reliability: { type: 'string', description: '未标注时**不出现**' },
                permissions: { type: 'array', items: { type: 'string' } },
                label: { type: 'string' },
                status: { type: 'string' },
                retiredNote: { type: 'string' },
                revisions: { type: 'integer', description: '变更记录条数（详情模式）' },
                citedBy: {
                  type: 'array',
                  description: '显式引用它的条目（`entry.sourceIds` 包含该 id）',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      id: { type: 'string', required: true },
                      title: { type: 'string', required: true },
                      kind: { type: 'string', required: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
      render: (_a, v) => {
        const list = v.sources ?? []
        if (list.length === 0) {
          return [{ type: 'text', text: '来源库：没有匹配的来源。\n用 memory_source 建档（type + location）；可靠度与权限**可以不给**（= 未标注，不是默认值）。' }]
        }
        const lines = list.map((source) => {
          const parts: string[] = [`- ${source.id}（${source.type}）${source.location}`]
          if (source.status === 'retired') parts.push(`**已停用**${source.retiredNote !== undefined ? `：${source.retiredNote}` : ''}`)
          if (source.owner !== undefined) parts.push(`提供方：${source.owner}`)
          parts.push(source.reliability !== undefined ? `可靠度：${source.reliability}` : '**可靠度未标注**')
          if (source.revisions !== undefined) parts.push(`变更记录 ${source.revisions} 条`)
          const cited = source.citedBy ?? []
          if (cited.length > 0) parts.push(`被 ${cited.length} 条引用：${cited.map((entry) => `${entry.title}(id=${entry.id})`).join('；')}`)
          return parts.join('；')
        })
        return [{ type: 'text', text: `来源库（${v.mode}）：${list.length} 条\n` + lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const sources = sourceStoreOf(deps)
      const { config, cwd, view } = await resolveRuntime(exec, deps)
      const { readScopes } = resolveScopes({ configScope: config.scope, cwd, explicit: args.scope })
      const withEntries = args.withEntries !== false
      const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : 20
      // 引用方只在**可见集合**里找（视野外的条目不得因为「引用过某个来源」而泄露存在性）
      const readable = withEntries
        ? gatherReadable(deps, { readScopes, includeArchive: false, view, explicitScope: args.scope }).entries
        : []
      const citedByOf = (sourceId: string): Array<{ id: string; title: string; kind: string }> =>
        readable
          .filter((entry) => (entry.sourceIds ?? []).includes(sourceId))
          .map((entry) => ({ id: entry.id, title: entry.title, kind: entry.kind }))
      const viewOf = (source: ReturnType<SourceStore['all']>[number], detail: boolean) => ({
        id: source.id,
        type: source.type,
        location: source.location,
        scope: source.scope,
        collectedAt: source.collectedAt,
        ...(source.owner !== undefined ? { owner: source.owner } : {}),
        ...(source.reliability !== undefined ? { reliability: source.reliability } : {}),
        ...((source.permissions ?? []).length > 0 ? { permissions: source.permissions } : {}),
        ...(source.label !== undefined ? { label: source.label } : {}),
        ...(source.status !== undefined ? { status: source.status } : {}),
        ...(source.retiredNote !== undefined ? { retiredNote: source.retiredNote } : {}),
        ...(detail ? { revisions: (source.revisions ?? []).length } : {}),
        ...(withEntries ? { citedBy: citedByOf(source.id) } : {}),
      })

      const id = typeof args.id === 'string' ? args.id.trim() : ''
      if (id.length > 0) {
        // id 只在 scope 内唯一 ⇒ 逐个 scope 查，别用一个全表 find
        const found = readScopes.map((scope) => sources.find(scope, id)).find((candidate) => candidate !== undefined)
        if (found === undefined) return { ok: false, mode: 'detail', total: 0, sources: [] }
        return { ok: true, mode: 'detail', total: 1, sources: [viewOf(found, true)] }
      }

      const typeFilter = typeof args.type === 'string' && args.type.trim() !== '' ? (args.type.trim() as SourceType) : undefined
      const ownerFilter = typeof args.owner === 'string' && args.owner.trim() !== '' ? args.owner.trim() : undefined
      const statusFilter = args.status === 'active' || args.status === 'retired' ? args.status : undefined
      const out = readScopes
        .flatMap((scope) => sources.list({
          scope,
          ...(typeFilter !== undefined ? { type: typeFilter } : {}),
          ...(ownerFilter !== undefined ? { owner: ownerFilter } : {}),
          ...(statusFilter !== undefined ? { status: statusFilter } : {}),
          ...(args.unlabeledReliability === true ? { unlabeledReliability: true } : {}),
        }))
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, limit)
      return { ok: true, mode: 'list', total: out.length, sources: out.map((source) => viewOf(source, false)) }
    },
  })
}

/** 构建 memory_relate 工具：从单条记忆展开关联网络（联想导航，v0.3） */
function buildRelate(deps: MemoryToolDeps): ToolDefinition {
  return defineTool({
    name: 'memory_relate',
    deferLoading: true,
    description: '联想导航：按 id 找到一条记忆并展开它的关联网络（related 链：共享标签/标题/正文关联的邻居记忆，关联强度降序）。depth=1（默认）单跳；depth>1 沿关系网 BFS 多跳探索记忆社区（hop 标注层级）。用于从已知记忆沿关系行走——「这条记忆还连着谁」。返回目标条目摘要 + 关联链（hop/共享标签数/关联强度）。',
    parameters: {
      id: { type: 'string', required: true, description: '目标记忆条目 id（来自 recall/remember/memory_browse）。' },
      limit: { type: 'integer', description: '每跳关联条数上限（缺省 3）。' },
      depth: { type: 'integer', description: 'BFS 跳数（缺省 1=单跳；2-3 多跳探索记忆社区）。' },
      scope: { type: 'string', description: '作用域覆盖（global 或 workspaceId）；缺省当前 workspace + global。' },
      includeArchive: { type: 'boolean', description: '是否包含已归档条目（默认否）。' },
      role: { type: 'string', description: '角色视角覆盖（v0.5）：缺省按调用者会话身份推导。目标与邻居都必须通过该视野的准入。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          error: { type: 'string' },
          target: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              kind: { type: 'string', required: true },
              title: { type: 'string', required: true },
              scope: { type: 'string', required: true },
            },
          },
          related: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                title: { type: 'string', required: true },
                scope: { type: 'string', required: true },
                sharedTags: { type: 'number', required: true },
                strength: { type: 'number', required: true },
                hop: { type: 'number', required: true },
              },
            },
          },
          typed: {
            type: 'array',
            description: '类型化关系（v0.28.0 · 方案 §4.4）：已写下的断言（有类型/方向/来源），按有效在前排序。与下面的统计相似链**不可互相替代**：那个是线索，这个是断言。',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                type: { type: 'string', required: true },
                label: { type: 'string', required: true },
                direction: { type: 'string', required: true },
                peer: { type: 'string', required: true },
                peerTitle: { type: 'string', required: true },
                provenance: { type: 'string', required: true },
                live: { type: 'boolean', required: true },
              },
            },
          },
          structural: {
            type: 'array',
            description: '派生结构边（v0.28.0）：来自条目字段（supersededBy / supersedes / archiveRef），不落盘。',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                type: { type: 'string', required: true },
                label: { type: 'string', required: true },
                direction: { type: 'string', required: true },
                peer: { type: 'string', required: true },
                peerTitle: { type: 'string', required: true },
                origin: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_a, v) => {
        if (v.ok === false) return [{ type: 'text', text: '联想导航失败：' + String(v.error ?? '') }]
        if (v.target === undefined) return [{ type: 'text', text: '联想导航：目标条目缺失。' }]
        const t = v.target
        const rel = v.related ?? []
        const typed = v.typed ?? []
        const structural = v.structural ?? []
        const head: string[] = []
        // 类型化关系在前（v0.28.0）：断言 > 线索。同一行里两类不能混排，否则会被读成同一件事
        if (typed.length > 0 || structural.length > 0) {
          head.push(`类型化关系 ${typed.length} 条 / 派生结构 ${structural.length} 条：`)
          for (const edge of typed) {
            head.push(`  ${edge.direction === 'out' ? '→' : '←'} ${edge.label} ${edge.peerTitle}(id=${edge.peer})（来源${edge.provenance}${edge.live ? '' : '·已过期'}）`)
          }
          for (const edge of structural) {
            head.push(`  ${edge.direction === 'out' ? '→' : '←'} ${edge.label} ${edge.peerTitle}(id=${edge.peer})（字段 ${edge.origin}）`)
          }
        }
        if (rel.length === 0) {
          return [{
            type: 'text',
            text: `联想导航：${t.title}（${t.id}）无统计相似邻居。`
              + (head.length > 0 ? '\n' + head.join('\n') : ''),
          }]
        }
        const lines = rel.map((r) => {
          const hopNote = r.hop !== undefined && r.hop > 1 ? `[${r.hop}跳] ` : ''
          return `- ${hopNote}[${r.kind}@${r.scope} 关联强度${r.strength}] ${r.title}`
        })
        return [{
          type: 'text',
          text: `联想导航：${t.title}（${t.id}）→ ${rel.length} 条统计相似邻居：\n` + lines.join('\n')
            + (head.length > 0 ? '\n' + head.join('\n') : ''),
        }]
      },
    },
    async execute(args, exec) {
      const { config, cwd, view } = await resolveRuntime(exec, deps, args.role)
      const { readScopes } = resolveScopes({ configScope: config.scope, cwd, explicit: args.scope })
      const includeArchive = args.includeArchive ?? false
      // 视野内取数：目标与邻居都必须过同一准入（否则 memory_relate 会成为隔离缺口）
      const { entries } = gatherReadable(deps, { readScopes, includeArchive, view, explicitScope: args.scope })
      const target = entries.find((candidate) => candidate.id === args.id)
      if (target === undefined) return { ok: false, error: `未找到 id="${args.id}" 的记忆条目（当前视野内）` }
      const depth = args.depth ?? 1
      const limitPerHop = args.limit ?? 3
      const related = depth > 1
        ? relateClosure(entries, target, depth, limitPerHop, includeArchive)
        : relatedOf(entries, target, limitPerHop, includeArchive).map((r) => ({ ...r, hop: 1 }))
      // 类型化关系（v0.28.0 · 方案 §4.4）：与统计相似**并列**返回，不互相替代。
      // 未接线时静默为空（关系层可选依赖）；`memory_relations` 才是它的主读口。
      //
      // ⚠ **边的端点用「含归档」的视野解析**（线上实测 2026-11-19 00:31 抓到的缺陷）：
      // 首版复用上面的 `entries`（受 `includeArchive` 控制、且 `store.list` 还会跳过冷存档），
      // 于是「指向一条压缩检查点 / 归档原料」的边因为对端不在集合里而**整条消失**——
      // 实测：交付记忆有一条 `sourced-from` 指向 00:27 的压缩检查点，`memory_relate` 报 0 条而
      // `memory_relations` 报 1 条。**边存在性不该依赖对端是否活跃**：那正是「这条结论来自哪份
      // 已经归档的观察」最需要被看见的场景。邻居检索仍按 `includeArchive` 走（那个是有意的降噪）。
      const edgeEntries = includeArchive
        ? entries
        : gatherReadable(deps, { readScopes, includeArchive: true, view, explicitScope: args.scope }).entries
      const titleById = new Map(edgeEntries.map((entry) => [entry.id, entry.title]))
      const typed = deps.relations === undefined
        ? []
        : edgesOf(
            deps.relations.all().filter((relation) => readScopes.includes(relation.scope)
              && titleById.has(relation.from) && titleById.has(relation.to)),
            target.id,
            { direction: 'both', limit: 10 },
          ).map((hit) => ({
            id: hit.relation.id,
            type: hit.relation.type,
            label: hit.label,
            direction: hit.direction,
            peer: hit.peer,
            peerTitle: titleById.get(hit.peer) ?? hit.peer,
            provenance: hit.relation.provenance,
            live: hit.live,
          }))
      const structural = structuralHitsOf(edgeEntries, target.id)
        .filter((edge) => titleById.has(edge.peer))
        .slice(0, 10)
        .map((edge) => ({
          type: edge.type,
          label: edge.label,
          direction: edge.direction,
          peer: edge.peer,
          peerTitle: titleById.get(edge.peer) ?? edge.peer,
          origin: edge.origin,
        }))
      return {
        ok: true,
        target: { id: target.id, kind: target.kind, title: target.title, scope: target.scope },
        related: related.map((r) => ({ ...r, scope: r.scope })),
        typed,
        structural,
      }
    },
  })
}

/** 构建 memory_health 工具：插件运行时状态（HMR 验证用，v0.2.1） */
function buildHealth(deps: MemoryToolDeps): ToolDefinition {
  return defineTool({
    name: 'memory_health',
    deferLoading: true,
    description: '查看记忆插件运行时状态：各作用域条目数、归档数、启动注入是否启用。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          total: { type: 'integer', required: true },
          archiveCount: { type: 'integer', required: true },
          scopes: { type: 'array', required: true, items: { type: 'string' } },
          injectEnabled: { type: 'boolean', required: true },
          role: { type: 'string', required: true },
          rolesEnabled: { type: 'boolean', required: true },
          roleReason: { type: 'string', required: true },
          autoCalls: { type: 'integer', required: true },
          recallCalls: { type: 'integer', required: true },
          distinctHits: { type: 'integer', required: true },
          lastAccessAt: { type: 'string', required: true },
          compressScans: { type: 'integer', required: true },
          compressUnits: { type: 'integer', required: true },
          compressErrors: { type: 'integer', required: true },
          compressPendingLast: { type: 'integer', required: true },
          compressSkippedText: { type: 'string', required: true },
          compressSampleText: { type: 'string', required: true },
          compressLastAt: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `记忆插件健康：${value.ok ? '正常' : '异常'}（共 ${value.total} 条 / 归档 ${value.archiveCount}；注入 ${value.injectEnabled ? '开' : '关'}）｜角色 ${value.role}（${value.rolesEnabled ? '角色维度已启用' : '角色维度未启用→零过滤'}；判据：${value.roleReason}）｜命中率信号：注入 ${value.autoCalls} 次 / 主动检索 ${value.recallCalls} 次 / 命中条目 ${value.distinctHits} 条${value.lastAccessAt.length > 0 ? `（最近 ${value.lastAccessAt}）` : ''}｜压缩流水线：扫描 ${value.compressScans} 次 / 压缩 ${value.compressUnits} 单元 / 最近待压 ${value.compressPendingLast}${value.compressErrors > 0 ? ` / 错误 ${value.compressErrors}` : ''}${value.compressLastAt.length > 0 ? `（最近 ${value.compressLastAt}）` : ''}｜非待压判定：${value.compressSkippedText}${value.compressSampleText.length > 0 ? `\n候选样本（非待压）：${value.compressSampleText}` : ''}`,
      }],
    },
    async execute(args, exec) {
      const { config, cwd, view } = await resolveRuntime(exec, deps)
      const { readScopes } = resolveScopes({ configScope: config.scope, cwd })
      const { entries } = gatherReadable(deps, { readScopes, includeArchive: true, view })
      const stats = statsOf(entries)
      // 命中率度量（v0.7 §5.10）：注入次数 vs 主动检索次数——「环境」是否真建起来了看这个比值
      const summary: AccessSummary | undefined = deps.readAccessSummary === undefined
        ? undefined
        : await deps.readAccessSummary()
      // 压缩流水线（v0.8 §5.12）：最近一轮扫描的判定分布 + 非待压样本（=「为什么这个桶没压」）
      const compress: CompressSummary | undefined = deps.readCompressSummary === undefined
        ? undefined
        : await deps.readCompressSummary()
      const sample = (compress?.sampleLast ?? [])
        .filter((line) => !line.endsWith(' pending'))
        .slice(0, 8)
      return {
        ok: true,
        total: stats.total,
        archiveCount: stats.archiveCount,
        scopes: readScopes,
        injectEnabled: config.inject.enabled,
        role: view.role,
        rolesEnabled: view.enabled,
        roleReason: view.reason,
        autoCalls: summary?.autoCalls ?? 0,
        recallCalls: summary?.recallCalls ?? 0,
        distinctHits: summary?.distinctIds ?? 0,
        lastAccessAt: summary !== undefined && summary.lastAtMs > 0
          ? new Date(summary.lastAtMs).toISOString().slice(0, 19)
          : '',
        compressScans: compress?.scans ?? 0,
        compressUnits: compress?.units ?? 0,
        compressErrors: compress?.errors ?? 0,
        compressPendingLast: compress?.pendingLast ?? 0,
        compressSkippedText: formatSkipped(compress?.skippedLast ?? {}),
        compressSampleText: sample.join(' · '),
        compressLastAt: compress !== undefined && compress.lastAtMs > 0
          ? new Date(compress.lastAtMs).toISOString().slice(0, 19)
          : '',
      }
    },
  })
}

/** 构建 memory_version 工具：返回插件版本（HMR 验证判据）。
 *  2026-09-01 修正：原实现 version 硬编码 + buildAt 实为「调用时刻」——验证判据说谎
 *  （v0.2.3 部署时仍报 0.2.2）。现 version 动态读 package.json，buildAt 取产物 mtime（真实构建时刻）。 */
function buildVersion(): ToolDefinition {
  return defineTool({
    name: 'memory_version',
    deferLoading: true,
    description: '查看记忆插件版本（HMR 热重载验证用）。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          version: { type: 'string', required: true },
          buildAt: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{ type: 'text', text: `dsh-agent-memory ${value.version}（build ${value.buildAt}）` }],
    },
    async execute() {
      let version = 'unknown'
      let buildAt = 'unknown'
      try {
        const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }
        if (typeof pkg.version === 'string') version = pkg.version
      } catch { /* 不可读时如实报 unknown */ }
      try {
        buildAt = new Date(statSync(new URL(import.meta.url)).mtimeMs).toISOString().slice(0, 19)
      } catch { /* 同上 */ }
      return { version, buildAt }
    },
  })
}

/** 构建 memory_check 工具 */
function buildCheck(deps: MemoryToolDeps): ToolDefinition {
  return defineTool({
    name: 'memory_check',
    description: '查看**待处置的近重复欠账**（2026-10-28 起；⚠ **2026-11-12 起这个源已关闭**：`remember` 不再自动查重，所以**不再产生新欠账**）。剩下的是历史存量，清完即永久为空。⚠ **列表空 ≠ 你处置得好**——它只表示机制已下线；要「先搜再写」请用 `remember({dryRun:true})` 或 `recall`。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          suggestions: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                signal: { type: 'string', required: true },
                summary: { type: 'string', required: true },
              },
            },
          },
          note: { type: 'string', description: '轨迹不可读或结果被截断时的说明（**读不到 ≠ 零欠账**）；正常且未截断时省略' },
          disposedCount: { type: 'number', description: '历史上已销账过的**不同候选**条数（供参考：销账后条目会从列表消失，与「从未撞过」在输出上同形，靠这个数区分）' },
        },
      },
      render: (args, value) => {
        const disposed = typeof value.disposedCount === 'number' && value.disposedCount > 0
          ? `\n（历史已销账 ${value.disposedCount} 条不同候选——它们不再列出，不是从未撞过）`
          : ''
        const shown = typeof value.note === 'string' && value.note.length > 0 && value.suggestions.length === 0
          ? `memory_check：${value.note}`
          : value.suggestions.length === 0
            ? '无欠账——注意这**不是**「你处置得好」：自动查重已于 2026-11-12 下线，不再产生新欠账（理由见 src/dedupe.ts 文件头）。'
            : `待处置 ${value.suggestions.length} 条近重复撞车：\n`
              + value.suggestions.map((s) => `- ${s.summary}`).join('\n')
              + (typeof value.note === 'string' && value.note.length > 0 ? `\n（${value.note}）` : '')
        return [{ type: 'text', text: shown + disposed }]
      },
    },
    async execute() {
      // 处置欠账（2026-10-28 · lh-0f54524a）：本工具的第一个真实数据源。
      // 「没有欠账」有四种来路，必须分开说：未接线 / 读不到 / 侧车空 / 有记录但全处置过。
      // 前两者是「不知道」，后两者才是真的零欠账——把「不知道」说成「零欠账」是这类诊断最典型的病。
      // （侧车不存在已由 readDedupeTrace 归入空数组：首次使用时它本来就不存在，报成故障是假报警。）
      if (deps.readDedupeTrace === undefined) {
        return { suggestions: [], note: '近重复轨迹未接线（deps.readDedupeTrace 缺失）——不假装零欠账' }
      }
      const records = await deps.readDedupeTrace()
      if (records === undefined) {
        return { suggestions: [], note: '近重复轨迹读取失败（权限 / IO）——这不等于零欠账，是「不知道」' }
      }
      const pending = unresolvedCandidates(records)
      // 「已销账过多少条不同候选」：销账后条目从 pending 里消失，与「从未撞过」同形。
      // 这个数让两者可分——也顺带证明销账记录真的被读进来了（而不是被当成坏行丢掉）。
      const disposedCount = new Set(
        records.filter((r) => r.kind === 'disposed').map((r) => r.candidateId),
      ).size
      const LIMIT = 20
      return {
        suggestions: pending.slice(0, LIMIT).map((p) => ({
          signal: 'near-duplicate-unresolved',
          summary: `${p.candidateId} 撞过 ${p.hitCount} 次（最高强度 ${p.maxStrength}，最后 ${new Date(p.lastHitMs).toISOString()}）仍未处置`,
        })),
        disposedCount,
        ...(pending.length > LIMIT ? { note: `仅列出最近 ${LIMIT} 条，另有 ${pending.length - LIMIT} 条` } : {}),
      }
    },
  })
}

/**
 * 构建 memory_dispose 工具——**欠账的销账入口**（2026-10-29 · lh-0f54524a）。
 *
 * 存在理由（缺口是实测出来的，不是设计的）：2026-10-28 上线处置队列后，`remember`
 * 命中相似时能给出 `similarDisposition`，但那个参数只在**写入那一刻**存在。
 * 于是「当时没算到该处置、事后才想清楚」这一整类判断无法落账——欠账只进不出。
 * 当晚三次写入共累积 15 条，我一条都清不掉。
 *
 * ⚠ 但它**不执行任何实际处置动作**，只写一条销账记录。这是有意的授权分割：
 *   - 合流 → `memory_merge`（已存在）
 *   - 补写 → `update`（已存在）
 *   - 判无关 → 无需动作，只销账
 * 让本工具代做这些，等于把三个独立工具的职责搅进一个销账口。2026-10-29 实测：
 * 我用 `update` 补写两条既有条目，全程零欠账——**动作从来都是可做的，缺的只是销账**。
 *
 * ⚠ 时间轴语义继承 `unresolvedCandidates`：销账之后的 hit 才算新欠账。
 * 所以同一个候选再撞上会重新进榜——**这是设计，不是漏报**。
 */
function buildDispose(deps: MemoryToolDeps): ToolDefinition {
  return defineTool({
    name: 'memory_dispose',
    description: '销账：把 `memory_check` 列出的近重复欠账标记为「已处置」，此后不再列为待处置。⚠ 它**只写销账记录，不执行实际处置**——合流用 `memory_merge`、补写用 `update`、判无关则无需动作。⚠ 处置是时间轴上的重置：同一个候选之后再撞上会重新进榜（设计，不是漏报）。⚠ 全部 candidateIds 必须真的撞过（有 hit 历史），否则整批不写（fail-closed，防 id 拼错被静默吞掉）。',
    parameters: {
      candidateIds: { type: 'array', items: { type: 'string' }, description: '要销账的候选 id（取自 memory_check 每条 summary 的首个字段）。可一次销多条，但同一批只能给同一种 disposition——需要不同处置时分批调用。' },
      disposition: { type: 'string', enum: ['merged', 'updated', 'unrelated'], description: 'merged=已合流进这条候选（你用过 memory_merge）/ updated=已补写进这条候选（你用过 update）/ unrelated=判为无关。**注意 unrelated 是「判过无关」，不是「没判」**——两者在侧车里必须可区分。' },
      reason: { type: 'string', description: '为什么这样处置，写进侧车留痕——将来重读时这是唯一线索。**必填**：无理由的销账等于把欠账藏起来。' },
      refs: { type: 'array', items: { type: 'string' }, description: '证据指针（path:line / 记忆 id / 提交号）：「凭什么说处置了」。disposition=unrelated 时可为空。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          disposed: { type: 'array', items: { type: 'string' }, required: true },
          unknown: { type: 'array', items: { type: 'string' }, required: true },
          note: { type: 'string' },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: value.ok
          ? `已销账 ${value.disposed.length} 条：${value.disposed.join(', ')}（同一候选再撞上会重新进榜）`
          : `⚠ 未写入任何记录：这 ${value.unknown.length} 个 id 没有撞车历史（可能是拼错，或从未撞过）：${value.unknown.join(', ')}`,
      }],
    },
    async execute(args) {
      if (deps.recordDedupeTrace === undefined) {
        throw new Error('memory_dispose: 未接线（deps.recordDedupeTrace 缺失）——侧车不可写时不假装成功')
      }
      if (deps.readDedupeTrace === undefined) {
        throw new Error('memory_dispose: 未接线（deps.readDedupeTrace 缺失）——无法校验候选是否真实存在')
      }
      // 运行时必填校验（schema 层可选，与 memory_review_mark 同纪律：fail-loud）
      const rawIds = args.candidateIds
      if (!Array.isArray(rawIds) || rawIds.length === 0) {
        throw new Error('memory_dispose: candidateIds 必填且不能为空（不知道要销哪条就别销）')
      }
      const ids = [...new Set(rawIds.map((x) => (typeof x === 'string' ? x.trim() : '')).filter((x) => x.length > 0))]
      if (ids.length === 0) throw new Error('memory_dispose: candidateIds 里没有有效 id')
      const disposition = parseSimilarDisposition(args.disposition)
      if (disposition === undefined) {
        throw new Error('memory_dispose: disposition 必填（merged / updated / unrelated 三选一）')
      }
      const rawReason = args.reason
      if (typeof rawReason !== 'string') throw new Error('memory_dispose: reason 必填')
      const reason = rawReason.trim()
      if (reason.length === 0) throw new Error('memory_dispose: reason 必填（无理由的销账等于把欠账藏起来）')
      const refs = Array.isArray(args.refs)
        ? args.refs.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim())
        : []

      // 校验「这些 id 真的撞过」：读不到侧车时**拒绝写**（fail-closed）——
      // 读不到就无法判断 id 是否拼错，此时的「成功」会是凭空造出来的销账记录。
      const existing = await deps.readDedupeTrace()
      if (existing === undefined) {
        throw new Error('memory_dispose: 近重复轨迹读取失败（权限 / IO）——读不到就无法校验候选，拒绝写入')
      }
      const hitIds = new Set(existing.filter((r) => r.kind === 'hit').map((r) => r.candidateId))
      const known = ids.filter((id) => hitIds.has(id))
      const unknown = ids.filter((id) => !hitIds.has(id))
      // 只要有一个 id 不存在，**整批不写**：部分写入会让「我销了 3 条」变成
      // 「我以为 5 条全销了，其实 2 条拼错」——这正是欠账类工具最该避免的静默失败。
      if (unknown.length > 0) {
        return { ok: false, disposed: [], unknown, note: '整批未写入（含未知 id 时不做部分销账）' }
      }

      const now = Date.now()
      const records: DedupeTraceRecord[] = known.map((candidateId) => ({
        kind: 'disposed',
        atMs: now,
        candidateId,
        disposition,
        reason,
        ...(refs.length > 0 ? { refs } : {}),
      }))
      const ok = (await deps.recordDedupeTrace(records)) !== false
      if (!ok) throw new Error('memory_dispose: 侧车写入失败')
      return { ok: true, disposed: known, unknown: [] }
    },
  })
}


/**
 * 构建 memory_audit 工具（v0.6 价值体检器）——**只读提案器**。
 * 硬约束（§5.9）：① 不归档不删除不写库 ② 过角色视野（读路径） ③ 分数是序数，权重是启发式先验。
 */
function buildAudit(deps: MemoryToolDeps): ToolDefinition {
  return defineTool({
    name: 'memory_audit',
    deferLoading: true,
    description: '价值体检（只读）：回答「哪些条目值得继续占位置、哪些该降级/归档」。输出四档提案——KEEP（承重：被概要 archiveRef 引用 / 新 / 有角色归属）、DEMOTE（未引用且体量大，可降级压缩）、ARCHIVE（未引用 + 老 + 无溯源，归档候选）、REVIEW（近重复簇 / 超大条目 / 概要超预算，交人裁决）——每条带证据行，并给出按层级聚合的体量视图。**只读**：不归档、不删除、不刷新 accessedAt；分数是序数（权重为启发式先验，非拟合值）。',
    parameters: {
      scope: { type: 'string', description: '作用域覆盖（缺省当前 workspace + global；受调用者角色视野约束）。' },
      role: { type: 'string', description: '角色视角覆盖（缺省按调用者会话身份推导）。' },
      topN: { type: 'integer', description: '返回候选条数上限（缺省 30）。' },
      minChars: { type: 'integer', description: '只列体量 ≥ 此字符数的候选（缺省 0 = 全部）。' },
      includeArchive: { type: 'boolean', description: '是否把已归档条目也纳入体检（缺省 false）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              total: { type: 'integer', required: true },
              chars: { type: 'integer', required: true },
              byBucket: { type: 'object', additionalProperties: true, required: true },
              charsByBucket: { type: 'object', additionalProperties: true, required: true },
              usageSource: { type: 'string', required: true },
              referenced: { type: 'integer', required: true },
            },
          },
          groups: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                key: { type: 'string', required: true },
                label: { type: 'string', required: true },
                count: { type: 'integer', required: true },
                chars: { type: 'integer', required: true },
                dominantBucket: { type: 'string', required: true },
              },
            },
          },
          candidates: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                title: { type: 'string', required: true },
                scope: { type: 'string', required: true },
                bucket: { type: 'string', required: true },
                score: { type: 'number', required: true },
                reasons: { type: 'array', required: true, items: { type: 'string' } },
                evidence: { type: 'object', additionalProperties: true, required: true },
              },
            },
          },
          notes: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        const b = value.summary.byBucket
        const cb = value.summary.charsByBucket
        const lines = [
          `记忆体检（只读提案）：${value.summary.total} 条 / ${value.summary.chars} 字符；承重 ${value.summary.referenced} 条｜用量信号：${value.summary.usageSource === 'trace' ? '侧车轨迹' : '无（usage 项恒 0）'}`,
          `分档：KEEP ${b['KEEP']}(${cb['KEEP']}) · DEMOTE ${b['DEMOTE']}(${cb['DEMOTE']}) · ARCHIVE ${b['ARCHIVE']}(${cb['ARCHIVE']}) · REVIEW ${b['REVIEW']}(${cb['REVIEW']})`,
          `体量前三组：${value.groups.slice(0, 3).map((g) => `${g.label} ${g.count} 条/${g.chars} 字`).join(' · ')}`,
        ]
        for (const candidate of value.candidates.slice(0, 10)) {
          const title = candidate.title.length > 42 ? candidate.title.slice(0, 41) + '…' : candidate.title
          // v0.24.1（lh-8069f7da）：把 id 印出来——提案要能被执行，而 forget / update /
          // memory_recompress / memory_review_mark 全都凭 id 消费（findEntry 是精确匹配，
          // 没有前缀解析 ⇒ **必须印全量 id**，印 8 位会让提案无法直接执行）。
          // 旧版只给标题，每执行一条都得再花一次 browse 反查 ⇒「提案」与「动作」之间隔着一跳。
          lines.push(`- [${candidate.bucket}] ${candidate.id} ${title}（${candidate.evidence['chars']} 字 · ${candidate.evidence['ageDays']} 天 · ${candidate.evidence['refs']} 引用）${candidate.reasons[0] ?? ''}`)
        }
        if (value.candidates.length > 10) {
          lines.push(`（另有 ${value.candidates.length - 10} 条候选，见结构化返回）`)
        }
        lines.push('提案 ≠ 裁决：本工具不归档不删除；要做请显式调用 forget（动记忆数据属须请示类）。')
        if (value.notes.length > 0) {
          // 把「看不见 ≠ 没有」这类读数注脚带出来（默认视图下承重为 0 时尤其重要）。
          // v0.12：`用量信号` 注脚也放行 —— 它承载用量项的**计分口径**（按排序加权归因 /
          // 回退 hits）。口径只写在结构化返回里等于没写：渲染层是唯一到人眼前的通道。
          //
          // v0.24.3（2026-11-18 实测抓到）：原来是**白名单**（只放行 `另有` / `用量信号`），
          // 于是 v0.24.1 新加的「已跳过 N 条冷存档」注脚写进了结构化返回、却**印不出来**——
          // 白名单的失效方向是「新信息默认不可见」，而每加一条注脚都得记得回来改渲染层。
          // 改成**黑名单**：只挡与表头重复的两类（`读数：` / `提案 ≠ 裁决`），其余默认可见。
          // 判据：新增注脚应当**默认被看见**，被隐藏才需要理由。
          for (const note of value.notes) {
            if (note.startsWith('读数：') || note.startsWith('提案 ≠ 裁决')) continue
            lines.push(note)
          }
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const { config, cwd, view } = await resolveRuntime(exec, deps, args.role)
      const { readScopes } = resolveScopes({ configScope: config.scope, cwd, explicit: args.scope })
      const includeArchive = args.includeArchive ?? false
      // 视野一致（硬约束 ②）：体检是读路径，提案只含调用者视野内的条目。
      // 索引范围 = 视野内全量（含归档；否则承重原料不可见，会被误读成「没有承重」）；
      // 分类范围 = 本次集合（默认剔归档，可由 includeArchive 放开）。
      const { entries: universe } = gatherReadable(deps, { readScopes, includeArchive: true, view, explicitScope: args.scope })
      const entries = includeArchive ? universe : universe.filter((entry) => !entry.archived)
      const usage = deps.readAccess === undefined ? undefined : await deps.readAccess()
      // 已裁决标记（v0.11.2）：读侧车后注入 —— 命中 ⇒ 该条归 KEEP 并标注「已裁决」，
      // 使同一批候选不再每次体检重复出现（今晚实测：同一批 15 条 REVIEW 每次体检都重报）。
      const reviewed = deps.readReviewMarks === undefined ? undefined : await deps.readReviewMarks()
      const result = auditMemory({
        entries,
        indexEntries: universe,
        ...(config.audit !== undefined ? { config: config.audit } : {}),
        ...(usage !== undefined ? { usage } : {}),
        ...(reviewed !== undefined ? { reviewed } : {}),
        query: { topN: args.topN, minChars: args.minChars, includeArchive },
      })
      // 提案日志（v0.7 §5.11）：让提案有历史——与后续 forget/update 动作同文件、可按 id join。
      // 写的是**侧车观测文件**：不写记忆库、不刷新 accessedAt（A31 的只读判据不受影响）。
      if (config.audit?.proposalLog?.enabled === true && deps.recordProposal !== undefined) {
        void deps.recordProposal({
          atMs: Date.now(),
          kind: 'audit',
          role: view.role,
          weights: config.audit.weights,
          summary: result.summary,
          candidates: result.candidates.slice(0, 20).map((candidate) => ({
            id: candidate.id,
            bucket: candidate.bucket,
            score: candidate.score,
            chars: candidate.evidence.chars,
          })),
        })
      }
      return result
    },
  })
}

/**
 * 构建 memory_review_mark 工具：给体检候选打「已裁决」标记（v0.11.2）。
 *
 * 存在的理由（今晚实测）：同一批 REVIEW 候选会在**每次体检**里重复出现（15 条），
 * 而裁决结果无处留痕 ⇒ 只能拿记忆条目当 workaround。本工具把裁决写进侧车，
 * `memory_audit` 读它后不再把这些条目当待办反复报。
 *
 * 硬约束：**只写侧车，绝不改条目**（不刷新 accessedAt/updatedAt ⇒ A31 的只读判据不受影响）。
 */
function buildReviewMark(deps: MemoryToolDeps): ToolDefinition {
  return defineTool({
    name: 'memory_review_mark',
    deferLoading: true,
    description: '给一条体检候选打「已裁决」标记：此后 memory_audit 不再把它当待办反复报（归 KEEP，理由里标注已裁决时刻）。**只写侧车，绝不改条目**——不刷新 accessedAt/updatedAt。⚠ 标记只对「当时那一版」有效：条目若再变动（updatedAt 晚于标记时刻）会自动重新纳入常规分档，因此它**不会**变成永久免检。',
    parameters: {
      id: { type: 'string', description: '条目 id（来自 memory_audit 的候选，或 recall / memory_browse 的输出）。' },
      note: { type: 'string', description: '裁决说明（为什么保持现状 / 怎么处理的），写入侧车供回溯——**必填**：无理由的裁决等于没裁决。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          id: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: value.ok
          ? `已标记「已裁决」：${value.id}（下次体检起不再作为待办反复报；条目若再变动会自动重新纳入）`
          : `标记失败：${value.id}`,
      }],
    },
    async execute(args) {
      if (deps.recordReviewMark === undefined) {
        throw new Error('memory_review_mark: 未接线（deps.recordReviewMark 缺失）——侧车不可写时不假装成功')
      }
      // 参数在 schema 层是可选的，**必填性由这里在运行时保证**（fail-loud，§5.30 规则 4）：
      // 类型收窄与语义校验一并在入口做完，后续代码拿到的是确定值。
      const id = args.id
      if (typeof id !== 'string' || id.length === 0) throw new Error('memory_review_mark: id 必填')
      const rawNote = args.note
      if (typeof rawNote !== 'string') throw new Error('memory_review_mark: note 必填')
      const note = rawNote.trim()
      if (note.length === 0) throw new Error('memory_review_mark: note 必填（无理由的裁决等于没裁决）')
      const ok = (await deps.recordReviewMark(id, note)) !== false
      if (!ok) throw new Error(`memory_review_mark: 侧车写入失败（${id}）`)
      return { ok: true, id }
    },
  })
}

/**
 * 构建 memory_recompress 工具：把一条已超预算的概要压回预算内（v0.11.3）。
 *
 * 存在的理由：audit 自 v0.11.0 起能**看见**超预算概要，但看见了也没法修——
 * 常规压缩对已存在的桶一律 skip（`already-summarized`），那个幂等反过来**保护**了超预算版本。
 * 本工具是它的显式出口。
 */
function buildRecompress(deps: MemoryToolDeps): ToolDefinition {
  return defineTool({
    name: 'memory_recompress',
    deferLoading: true,
    description: '重压一条已超预算的概要（正文超过 summary_max_chars）：用**它自己的正文**再压一次，压完**整体替换**（旧版进 revisions 可回溯）。⚠ 只对 kind=summary 且 level/bucket 齐全的条目有效；已在预算内则跳过（不白跑一次 LLM）。与常规时间压缩的分工：常规压缩「已存在即跳过」，本工具正是那个幂等结果的**显式出口**。',
    parameters: {
      id: { type: 'string', description: '概要条目 id（来自 memory_audit 的候选，或 recall / memory_browse 的输出）。' },
      maxChars: { type: 'integer', description: '本次重压的正文上限（字符）；缺省 4000 —— 比首压预算 6000 更严，因为重压的触发条件恰恰是「它超了」。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          beforeChars: { type: 'integer', required: true },
          afterChars: { type: 'integer', required: true },
          skipped: { type: 'boolean', required: true },
          note: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: value.skipped
          ? (value.note === 'over-budget'
            // 2026-11-03 实测两样本：月概要 20,710→20,973（变长）、20,973→20,960（只省 13）。
            // 两万字级别的概要靠「再压一次」压不动 ⇒ 这里必须给出下一步，否则它是个没有出口的状态。
            ? `未重压：产出仍超预算（LLM 产了 ${value.afterChars} 字，正文保持原 ${value.beforeChars} 字不动）—— 这个量级再压一次通常无效，改用分片压（分段产出摘要再合并）`
            : `未重压：${value.note}（原 ${value.beforeChars} 字）`)
          : `已重压：${value.beforeChars} → ${value.afterChars} 字（省 ${value.beforeChars - value.afterChars}；旧版仍在 revisions 里可回溯）`,
      }],
    },
    async execute(args) {
      if (deps.recompress === undefined) {
        throw new Error('memory_recompress: 未接线（deps.recompress 缺失）——不假装成功')
      }
      // 参数在 schema 层可选，必填性在此运行时保证（同 memory_review_mark 的理由）
      const id = args.id
      if (typeof id !== 'string' || id.length === 0) throw new Error('memory_recompress: id 必填')
      const maxChars = typeof args.maxChars === 'number' && args.maxChars > 0 ? args.maxChars : undefined
      const outcome = await deps.recompress(maxChars !== undefined ? { summaryId: id, maxChars } : { summaryId: id })
      if (outcome === undefined) {
        throw new Error(`memory_recompress: ${id} 不是可重压的概要（需 kind=summary、有 level/bucket，且不在 global 层）`)
      }
      return outcome
    },
  })
}

/**
 * 构建记忆工具定义（纯函数，单测可直接取 execute 跑行为）。
 * @param deps - 存储 + 配置加载依赖
 * @returns registry-ready 工具定义（十五件）
 */
export function createMemoryTools(deps: MemoryToolDeps): ToolDefinition[] {
  return [
    buildRemember(deps),
    buildRecall(deps),
    buildBrowse(deps),
    buildRelate(deps),
    buildLink(deps),
    buildUnlink(deps),
    buildRelations(deps),
    buildConcept(deps),
    buildThesaurus(deps),
    buildEntity(deps),
    buildEntities(deps),
    buildSource(deps),
    buildSources(deps),
    buildUpdate(deps),
    buildSupersede(deps),
    buildForget(deps),
    buildMerge(deps),
    buildStats(deps),
    buildAudit(deps),
    buildReviewMark(deps),
    buildRecompress(deps),
    buildCheck(deps),
    buildDispose(deps),
    buildHealth(deps),
    buildVersion(),
  ]
}

/**
 * 注册六个记忆工具到共享工具注册表（T7 集成接线；插件需 inject 'tools'）。
 * @param ctx - 插件上下文（ctx.tools 由 dsh-tools 声明合并提供）
 * @param deps - 存储 + 配置加载依赖
 */
export function registerMemoryTools(ctx: Context, deps: MemoryToolDeps): void {
  for (const tool of createMemoryTools(deps)) {
    ctx.tools.register(tool)
  }
}
