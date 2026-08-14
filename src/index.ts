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
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { MemoryStore } from './store.ts'
import { TimelineCompressor, type SummarizeFn } from './timeline.ts'
import { summarizeEntries, type SummarizerConfig } from './summarizer.ts'
import { registerMemoryTools, type MemoryToolDeps } from './tools.ts'
import { installMemoryInject } from './inject.ts'
import { installCompactionSink } from './compaction-sink.ts'
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
export const inject = ['storageDomain', 'tools', 'llm'] as const

/** 插件配置：总结路由（空字符串 = 跟随会话当前路由，DESIGN.md §十） */
export interface Config {
  provider?: string
  model?: string
  maxTokens?: number
}

export const Config: z<Config> = z.object({
  provider: z.string().default(''),
  model: z.string().default(''),
  maxTokens: z.number(), // schemastery object 字段默认可选（interface 保持 maxTokens?: number）
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

  // 2. 配置加载：每个 workspace 自己的 .dsh/memory.yml（DESIGN.md §四）
  const loadConfig = async (workspaceRoot: string) => loadMemoryConfig(memoryConfigPath(workspaceRoot))

  // 3. 懒压缩钩子：访问记忆时补压上一自然单位（fire-and-forget，幂等；失败静默下次重试）
  const compress: MemoryToolDeps['compress'] = async (scope, agent) => {
    if (scope === 'global') return // DESIGN.md §五：global 层不启用时间压缩
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

  // 6. 压缩即记忆（v0.2 通道 C）：compaction 成功 → checkpoint 自动落库
  installCompactionSink(ctx, { store })
}
