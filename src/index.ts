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
  let lastRoute: { provider: string; model: string } | undefined

  /** 实时从活跃会话（ctx.agents.list）解析当前模型路由——与懒压缩的 requestHeader 同源 */
  function resolveActiveRoute(): { provider: string; model: string } | undefined {
    try {
      for (const agent of ctx.agents.list()) {
        const header = agent.session.requestHeader()?.config
        if (header !== undefined && header.provider.length > 0 && header.model.length > 0) {
          return { provider: header.provider, model: header.model }
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
        lastRoute = { provider: header.provider, model: header.model }
      }
    }
    const cfg = await loadConfig(scope)
    if (!cfg.timeline.week && !cfg.timeline.month && !cfg.timeline.year) return
    const summarize: SummarizeFn = async (input) => {
      const result = await summarizeEntries(ctx, toSummarizerConfig(config), input, agent)
      return result.body
    }
    const compressor = new TimelineCompressor(store, cfg, summarize)
    await compressor.compressPending(scope)
  }

  // 4. 注册七个记忆工具（remember/recall/memory_browse/update/forget/memory_stats/memory_check）
  registerMemoryTools(ctx, { store, loadConfig, compress })

  // 5. 启动注入（v0.2）：会话首 pre-step 注入记忆速览（目录化，预算约束）
  installMemoryInject(ctx, { store, loadConfig })

  // 5b. 自动 recall 注入（L3 2026-09-01）：每条新主人消息注入 top 命中（尾追加，缓存友好）
  installAutoRecallInject(ctx, { store, loadConfig })

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
        return summarizeEntries(
          ctx,
          toSummarizerConfig(config),
          input,
          undefined,
          undefined,
          route,
        ).then((result) => result.body)
      },
    }, {
      intervalMs: compressIntervalMs,
      initialDelayMs,
    })
  }
}
