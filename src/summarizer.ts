/**
 * LLM 直调总结（IMPLEMENTATION.md §3 / DESIGN.md §十）
 *
 * 记忆压缩走 summarizeWithLlm 模式（参考 dsh-agent-compact/src/summarizer.ts）：
 * - ctx.llm.stream() 直调（不打断 agent 当前轮次、不依赖 KV cache——输入是文本可控的记忆条目）
 * - BlockAssembler 增量组装 + finishError 失败映射（error/aborted/max-tokens fail closed）
 * - text-only 投影（拒绝图像输出）+ usage 透传
 *
 * 路由解析（与 compact 一致的三级回退）：
 * 1. 插件配置（SummarizerConfig.provider/model，显式优先）
 * 2. 当前会话请求路由（agent.session.requestHeader()，跟随 agent 正在用的模型）
 * 3. 均无 → fail loud 抛错（绝不静默降级）
 */

import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, LlmError, contentHasImage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock, FinishReason, GenerateOptions, Message, TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CompressionLevel, SummarizeInput } from './timeline.ts'

/** 直调配置：provider/model 均可留空走会话路由；maxTokens 缺省 2000 */
export interface SummarizerConfig {
  /** 显式 provider 路由；空字符串 = 跟随会话当前路由 */
  provider: string
  /** 显式 model；空字符串 = 跟随会话当前路由 */
  model: string
  /** 输出 token 上限 */
  maxTokens?: number
  /** 概要正文长度上限（字符，v0.8.1）；缺省 DEFAULT_SUMMARY_MAX_CHARS（6000） */
  summaryMaxChars?: number
}

/** 直调结果：概要正文 + 实际路由 + token 用量 */
export interface MemorySummaryResult {
  body: string
  provider: string
  model: string
  maxTokens?: number
  /** Provider 上报的本次调用用量（缓存读/写等） */
  usage?: TokenUsage
}

/** 输出 token 缺省上限（v0.3 从 2000 提到 8000：历史缺口补压原料量大，2000 常触发 MAX_TOKENS fail-closed；
 *  v0.4 2026-09-04 主人指示拉高：周补压原料仍超 8000（今日大量记忆），提到 16000——当前模型 contextWindow 100 万，16k 输出安全） */
const DEFAULT_MAX_TOKENS = 16000

/**
 * 概要正文缺省长度上限（**字符**，v0.8.1）——提示词里的硬约束。
 *
 * 为什么必须有上限（2026-09-15 实测）：原料常是**已成概要的检查点**（09-13 是 9 条/39,375 字符，
 * 09-14 是 19 条/76,646 字符）。提示词此前只说「信息无损」而无长度约束 ⇒ 模型倾向搬运原文 ⇒
 * 输出触顶 16,000 token 被 `finishError` fail-closed ⇒ **整份概要作废、那个桶永远压不出来**。
 * 上限的正当性：概要是**导航层**，原料冷归档（`archiveRef` 可深挖）——无损性由原料保证，不必由概要保证。
 * 取值依据：既有日概要正文中位 6,003 字符（31 条实测）⇒ 取 6,000 与既有尺度一致，
 * 且 ≈ 9,000 token < 16,000 上限（留 1.7× 余量容忍超写）。
 */
export const DEFAULT_SUMMARY_MAX_CHARS = 6000

/** 层级显示名（提示词用，与 timeline.ts 的 LEVEL_LABEL 保持同文案） */
const LEVEL_LABEL: Record<CompressionLevel, string> = {
  day: '日概要',
  week: '周概要',
  month: '月概要',
  year: '年概要',
}

/**
 * 构建总结提示词（纯函数，离线可测）。
 * 内容：任务说明 + 输出要求（含**长度上限**）+ 周记模板（仅 week 压缩注入）+ 原料条目清单。
 * @param input - 压缩入参（entries/level/bucket/range/weeklyTemplate）
 * @param maxChars - 正文长度上限（字符）；缺省 DEFAULT_SUMMARY_MAX_CHARS
 * @returns 单条 user 消息文本
 */
export function buildSummaryPrompt(input: SummarizeInput, maxChars: number = DEFAULT_SUMMARY_MAX_CHARS): string {
  const levelLabel = LEVEL_LABEL[input.level]
  const lines: string[] = []
  lines.push(
    `你是一个长期记忆压缩引擎。下面是 ${input.entries.length} 条${levelLabel}的原始记忆条目（时间范围：${input.range.label}）。`,
  )
  lines.push('请将它们压缩为一份信息无损的概要，保留关键事实、决策、结论、数字、日期与引用，删除重复与琐碎细节。')
  lines.push('')
  lines.push('输出要求：')
  lines.push('- 使用 Markdown，按主题分节或分点，条理清晰')
  lines.push('- 保留精确信息：日期、数字、文件路径、命令、结论原文')
  lines.push('- 若有未完成事项或待办，单独列出')
  lines.push(`- **正文不超过 ${maxChars} 字**：概要是**导航层**，原料条目已冷归档（可按 archiveRef 深挖），`)
  lines.push('  因此**不要逐字搬运原文**，也不要为追求「无损」而铺陈细节；超限会导致整份概要作废')
  lines.push('- 只输出概要正文本身，不要任何前言、解释或客套')
  if (input.level === 'week' && input.weeklyTemplate !== undefined && input.weeklyTemplate.trim().length > 0) {
    lines.push('')
    lines.push('周记模板（建议结构，可按实际内容取舍，无内容的小节省略）：')
    lines.push(input.weeklyTemplate.trim())
  }
  lines.push('')
  lines.push('原始条目：')
  for (const [index, entry] of input.entries.entries()) {
    lines.push(`${index + 1}. **${entry.title}**${entry.tags.length > 0 ? `（标签：${entry.tags.join(', ')}）` : ''}`)
    lines.push(indentBody(entry.body))
  }
  return lines.join('\n')
}

/**
 * 直调 LLM 总结记忆条目（summarizeWithLlm 模式）。
 * @param ctx - 插件上下文（提供 ctx.llm 服务）
 * @param config - 直调配置（provider/model 可留空走会话路由）
 * @param input - 压缩入参
 * @param agent - 可选：提供当前会话路由（requestHeader）作 provider/model 回退，并**提供会话 id**
 * @param signal - 可选取消信号，转发给适配器
 * @param fallbackTarget - 周期任务等无 agent 上下文时的路由回退
 * @param sessionId - 可选会话 id（无 agent 时由调用方从活跃会话取；见下）
 * @returns 概要正文 + 实际路由 + usage
 *
 * ⚠ **sessionId 不是装饰**（2026-09-15 事故实证）：网关类 provider（opencode.ai / OpenCode Go）
 * 要求请求头 `x-opencode-session`，而该头由宿主插件 `dsh-x-opencode-session` 依据
 * `GenerateOptions.sessionId` 注入（它用 AsyncLocalStorage 把该值带进 fetch）。
 * 本函数此前**从不传 sessionId** ⇒ 头缺失 ⇒ provider 直接拒绝：
 * `Request is missing x-opencode-session and cannot be routed efficiently`
 * ⇒ **时间压缩 100% 失败**（日/周概要停摆）。故：有 agent 用 `agent.session.id`，
 * 无 agent（周期补压）由调用方显式传入活跃会话 id；两者皆无时**不传**（保持零回归）。
 */
export async function summarizeEntries(
  ctx: Context,
  config: SummarizerConfig,
  input: SummarizeInput,
  agent?: Agent,
  signal?: AbortSignal,
  fallbackTarget?: { provider: string; model: string },
  sessionId?: Agent['session']['id'],
): Promise<MemorySummaryResult> {
  const target = resolveTarget(config, agent, fallbackTarget)
  const prompt = buildSummaryPrompt(input, config.summaryMaxChars ?? DEFAULT_SUMMARY_MAX_CHARS)
  const effectiveSessionId = sessionId ?? agent?.session?.id

  const assembler = new BlockAssembler()
  const messages: Message[] = [
    createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'plugin', plugin: 'dsh-agent-memory' },
    }),
  ]
  const options: GenerateOptions = {
    provider: target.provider,
    model: target.model,
    messages,
    maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    purpose: 'compaction',
    ...(signal === undefined ? {} : { signal }),
    // 零回归：会话 id 缺失时**不加该键**（options 形状与 v0.8.0 逐字段一致）
    ...(effectiveSessionId === undefined || effectiveSessionId === ''
      ? {}
      : { sessionId: effectiveSessionId }),
  }
  for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)

  const error = finishError(assembler.finish, () =>
    `已产出 ${partialChars(assembler.blocks())} 字符；usage=${JSON.stringify(assembler.usage ?? null)}`)
  if (error !== undefined) throw error

  const rawOutput = assembler.blocks()
  const summary = summaryText(rawOutput)
  if (summary.length === 0) {
    throw new Error('记忆压缩：模型未产出任何文本概要')
  }
  return {
    body: summary.map((block) => block.text).join('\n'),
    provider: options.provider,
    model: options.model,
    maxTokens: options.maxTokens,
    ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
  }
}

// ---------- 内部辅助 ----------

/** 路由解析：显式配置 → 会话路由 → fallbackTarget（周期任务等无 agent 上下文用）→ fail loud */
function resolveTarget(
  config: SummarizerConfig,
  agent?: Agent,
  fallbackTarget?: { provider: string; model: string },
): { provider: string; model: string } {
  if (config.provider.length > 0 && config.model.length > 0) {
    return { provider: config.provider, model: config.model }
  }
  const header = agent?.session.requestHeader()?.config
  if (header !== undefined && header.provider.length > 0 && header.model.length > 0) {
    return { provider: header.provider, model: header.model }
  }
  if (fallbackTarget !== undefined && fallbackTarget.provider.length > 0 && fallbackTarget.model.length > 0) {
    return { provider: fallbackTarget.provider, model: fallbackTarget.model }
  }
  throw new Error(
    '记忆压缩：缺少 provider/model —— 请设置 summarizer.provider/model、在有会话请求路由（requestHeader）的上下文中触发，或提供 fallbackTarget',
  )
}

/** 正文缩进：条目正文多行时统一缩进（续行与首行对齐），保持清单可读 */
function indentBody(body: string): string {
  const parts = body.split(/\r?\n/)
  const first = parts[0] ?? ''
  const rest = parts.slice(1)
  return '   ' + [first, ...rest.map((line) => '   ' + line)].join('\n')
}

/** 终结 finish → 失败映射（fail closed：error/aborted/max-tokens 全部抛错）
 *  @param evidence - 可选：失败时的**可归因证据**（惰性求值，只在错误分支调用）。
 *  2026-09-15 加：截断此前只报「上限处截断」，无法区分「模型在写长文」与「reasoning 烧完预算」 */
function finishError(finish: FinishReason, evidence?: () => string): Error | undefined {
  switch (finish.kind) {
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure.message) as Error & { code?: string }
      error.code = finish.failure.code
      return error
    }
    case 'max-tokens': {
      const detail = evidence === undefined ? '' : `；${evidence()}`
      const error = new Error(
        `记忆压缩：输出在 token 上限处截断（概要不完整${detail}）`,
      ) as Error & { code?: string }
      error.code = 'MAX_TOKENS'
      return error
    }
    default:
      return undefined
  }
}

/** 部分产出字符数（纯函数）：只数文本块——截断归因用（reasoning 块不计入） */
function partialChars(blocks: readonly ContentBlock[]): number {
  let total = 0
  for (const block of blocks) {
    if (block.type === 'text') total += block.text.length
  }
  return total
}

/** 拒绝图像输出，只保留文本块 */
function summaryText(blocks: readonly ContentBlock[]): Array<Extract<ContentBlock, { type: 'text' }>> {
  if (contentHasImage(blocks)) {
    throw new LlmError('记忆压缩概要不能包含图像输出', 'UNSUPPORTED_CONTENT')
  }
  return blocks.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
}
