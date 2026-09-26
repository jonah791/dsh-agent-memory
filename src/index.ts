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
import { DEFAULT_AUDIT_CONFIG } from './audit.ts'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { Entry } from './types.ts'

// ---------- 持久化域 ----------

/** 记忆条目 zod schema（storage-domain 持久化校验边界，对齐 types.ts Entry） */
const entrySchema = zod.object({
  id: zod.string(),
  kind: zod.enum(['fact', 'knowledge', 'episodic', 'summary']),
  key: zod.string().optional(),
  title: zod.string(),
  body: zod.string(),
  tags: zod.array(zod.string()),
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
  // v0.5 角色维度（多智能体工作台模式）：归属 + 写入者溯源
  role: zod.string().optional(),
  author: zod.object({
    sessionId: zod.string().optional(),
    delegationDepth: zod.number().optional(),
    preset: zod.string().optional(),
  }).optional(),
})

/** 记忆域声明：单表 entries，key = <scope>:<kind>:<id>（domain 即命名空间，规格 §2.2） */
export const memoryDomainSpec = defineDomain({
  name: 'agent_memory', // DSH 域名限制 /^[a-z][a-z0-9_]*$/（不允许连字符）
  version: 1,
  tables: { entries: domainTable<string, Entry>(entrySchema) },
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
    async remember(input: { text: string; kind?: 'fact' | 'knowledge' | 'episodic'; tags?: string[]; key?: string; scope?: string }) {
      try {
        const text = (input.text ?? '').trim()
        if (text.length === 0) return { error: 'text 不能为空' }
        const kind = input.kind ?? 'knowledge'
        const scope = input.scope ?? 'global'
        const body = text
        const firstLine = body.split(/\r?\n/).find((line) => line.trim().length > 0) ?? body
        const base = firstLine.trim()
        const title = base.length > 80 ? base.slice(0, 79) + '…' : base
        const r = await store.remember({ kind, key: input.key, title, body, tags: input.tags ?? [], scope, level: null, bucket: null })
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
  registerMemoryTools(ctx, { store, loadConfig, compress, recompress, recordAccess, readAccess, readAccessSummary, recordProposal, recordReviewMark, readReviewMarks, readCompressSummary })

  // 5. 启动注入（v0.2）：会话首 pre-step 注入记忆速览（目录化，预算约束）
  installMemoryInject(ctx, { store, loadConfig })

  // 5b. 自动 recall 注入（L3 2026-09-01）：每条新主人消息注入 top 命中（尾追加，缓存友好）
  installAutoRecallInject(ctx, { store, loadConfig, recordAccess })

  // 6. 压缩即记忆（v0.2 通道 C）：compaction 成功 → checkpoint 自动落库
  installCompactionSink(ctx, { store })

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
