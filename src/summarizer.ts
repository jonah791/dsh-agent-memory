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

/** 输出 token 缺省上限 */
const DEFAULT_MAX_TOKENS = 2000

/** 层级显示名（提示词用，与 timeline.ts 的 LEVEL_LABEL 保持同文案） */
const LEVEL_LABEL: Record<CompressionLevel, string> = {
  week: '周概要',
  month: '月概要',
  year: '年概要',
}

/**
 * 构建总结提示词（纯函数，离线可测）。
 * 内容：任务说明 + 输出要求 + 周记模板（仅 week 压缩注入，月/年有自然结构）+ 原料条目清单。
 * @param input - 压缩入参（entries/level/bucket/range/weeklyTemplate）
 * @returns 单条 user 消息文本
 */
export function buildSummaryPrompt(input: SummarizeInput): string {
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
 * @param agent - 可选：提供当前会话路由（requestHeader）作 provider/model 回退
 * @param signal - 可选取消信号，转发给适配器
 * @returns 概要正文 + 实际路由 + usage
 */
export async function summarizeEntries(
  ctx: Context,
  config: SummarizerConfig,
  input: SummarizeInput,
  agent?: Agent,
  signal?: AbortSignal,
): Promise<MemorySummaryResult> {
  const target = resolveTarget(config, agent)
  const prompt = buildSummaryPrompt(input)

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
  }
  for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)

  const error = finishError(assembler.finish)
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

/** 路由解析：显式配置 → 会话路由 → fail loud */
function resolveTarget(config: SummarizerConfig, agent?: Agent): { provider: string; model: string } {
  if (config.provider.length > 0 && config.model.length > 0) {
    return { provider: config.provider, model: config.model }
  }
  const header = agent?.session.requestHeader()?.config
  if (header !== undefined && header.provider.length > 0 && header.model.length > 0) {
    return { provider: header.provider, model: header.model }
  }
  throw new Error(
    '记忆压缩：缺少 provider/model —— 请设置 summarizer.provider/model，或在有会话请求路由（requestHeader）的上下文中触发',
  )
}

/** 正文缩进：条目正文多行时统一缩进（续行与首行对齐），保持清单可读 */
function indentBody(body: string): string {
  const parts = body.split(/\r?\n/)
  const first = parts[0] ?? ''
  const rest = parts.slice(1)
  return '   ' + [first, ...rest.map((line) => '   ' + line)].join('\n')
}

/** 终结 finish → 失败映射（fail closed：error/aborted/max-tokens 全部抛错） */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure.message) as Error & { code?: string }
      error.code = finish.failure.code
      return error
    }
    case 'max-tokens': {
      const error = new Error('记忆压缩：输出在 token 上限处截断（概要不完整）') as Error & { code?: string }
      error.code = 'MAX_TOKENS'
      return error
    }
    default:
      return undefined
  }
}

/** 拒绝图像输出，只保留文本块 */
function summaryText(blocks: readonly ContentBlock[]): Array<Extract<ContentBlock, { type: 'text' }>> {
  if (contentHasImage(blocks)) {
    throw new LlmError('记忆压缩概要不能包含图像输出', 'UNSUPPORTED_CONTENT')
  }
  return blocks.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
}
