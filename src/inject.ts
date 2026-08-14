/**
 * 启动注入（DESIGN.md 注入设计 v2：目录化记忆速览）
 *
 * 会话首个 pre-step 注入一条 user message（每会话一次）：
 * - 常驻层：global 作用域的事实条目（L1 fact）全量——主人偏好/环境事实，数量天然少
 * - 轮廓层：当前 workspace 的概要条目（week/month/year，按时间降序）+ 近期明细
 *   （updatedAt 降序），按 inject.maxEntries 与 inject.maxBytes 预算截断
 *
 * 与 skill 目录注入同构：只注入「标题 + 时间 + tags」线索，正文按需 recall——
 * 目录由预算约束永不失控；概要在目录里承担高密度索引角色（时间金字塔红利）。
 *
 * 纯函数 buildMemoryDigest 离线可测；pre-step 挂载走 agent-instructions 同款
 * 瀑布监听器（await next() 后 fold 进 step 1 批次）。
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { Entry, MemoryConfig } from './types.ts'
import type { MemoryStore } from './store.ts'
import { workspaceIdOf } from './scope.ts'

/** 注入依赖：存储 + 配置加载（测试注入 mock） */
export interface MemoryInjectDeps {
  store: MemoryStore
  loadConfig: (workspaceRoot: string) => Promise<MemoryConfig> | MemoryConfig
}

/** 单行条目渲染：类型 + 层级 + 标题 + 时间 + tags（线索，不含正文） */
function lineOf(entry: Entry): string {
  const kind = entry.kind.toUpperCase()
  const level = entry.level !== null ? ` ${entry.level}` : ''
  const date = entry.updatedAt.slice(0, 10)
  const tags = entry.tags.length > 0 ? ` · ${entry.tags.join('/')}` : ''
  return `- [${kind}${level}] ${entry.title}（${date}${tags}）`
}

/**
 * 组装记忆速览文本（纯函数）。
 * 顺序：常驻层（global fact 全量）→ 概要层（按 bucket 降序）→ 近期明细（updatedAt 降序）。
 * 预算：maxEntries 截断条目数；maxBytes 截断字符数（截断处提示省略）。
 * @param globalFacts - global 作用域事实条目（已过滤 archived）
 * @param scopeEntries - 当前 workspace 全部非归档条目
 * @param opts - 预算
 * @returns 完整速览文本（含帧标记）；空记忆返回空串
 */
export function buildMemoryDigest(
  globalFacts: Entry[],
  scopeEntries: Entry[],
  opts: { maxBytes: number; maxEntries: number },
): string {
  const sections: string[] = []
  const lines: string[] = []
  let omitted = 0

  // 常驻层：global fact 全量（数量少，预算内优先）
  const facts = globalFacts.filter((e) => e.kind === 'fact')
  for (const entry of facts) lines.push(lineOf(entry))

  // 概要层：summary 条目按 bucket 降序（高密度索引优先）
  const summaries = scopeEntries.filter((e) => e.kind === 'summary' && !e.archived)
  summaries.sort((a, b) => (a.bucket ?? a.createdAt) < (b.bucket ?? b.createdAt) ? 1 : -1)

  // 近期明细：非 summary 按 updatedAt 降序
  const recents = scopeEntries.filter((e) => e.kind !== 'summary' && !e.archived)
  recents.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))

  const budgeted = [...summaries, ...recents]
  for (const entry of budgeted) {
    if (lines.length >= opts.maxEntries + facts.length) {
      omitted += 1
      continue
    }
    lines.push(lineOf(entry))
  }

  if (lines.length > 0) sections.push('【记忆速览】', ...lines)
  let body = sections.join('\n')
  if (omitted > 0) body += `\n（另有 ${omitted} 条未列出，可用 recall 或 memory_browse 查找）`
  // maxBytes 为完整速览正文预算（帧开销在外）；截断时保留省略提示
  if (body.length > opts.maxBytes) {
    const hint = '\n（已按预算截断，可用 recall 或 memory_browse 查找更多）'
    body = body.slice(0, Math.max(0, opts.maxBytes - hint.length)) + hint
  }
  if (body.length === 0) return ''
  return `<system-reminder>\n从记忆库加载的相关记忆（dsh-agent-memory）：\n\n${body}\n</system-reminder>`
}

/**
 * 安装启动注入：会话首 pre-step（step 1）注入记忆速览，每会话一次。
 * 与 agent-instructions 的折叠方式一致：消息插入已认领批次之后。
 * @param ctx - 插件上下文（需要 agents 会话事件；pre-step 由 agent-loop 触发）
 * @param deps - 注入依赖
 */
export function installMemoryInject(ctx: Context, deps: MemoryInjectDeps): void {
  const injected = new Set<string>()

  ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    if (step !== 1) return decision
    if (injected.has(agent.session.id)) return decision
    const cwd = agent.session.header.cwd
    if (cwd === undefined) {
      injected.add(agent.session.id) // 无 cwd 的会话无法定位项目，跳过
      return decision
    }
    const config = await deps.loadConfig(cwd)
    if (!config.inject.enabled) {
      injected.add(agent.session.id)
      return decision
    }
    const scope = workspaceIdOf(cwd)
    const globalFacts = deps.store.list('global').filter((e) => e.kind === 'fact' && !e.archived)
    const scopeEntries = deps.store.list(scope)
    const digest = buildMemoryDigest(globalFacts, scopeEntries, {
      maxBytes: config.inject.maxBytes,
      maxEntries: config.inject.maxEntries,
    })
    if (digest.length === 0) {
      injected.add(agent.session.id)
      return decision
    }
    signal.throwIfAborted()
    const message = createUserMessage({
      content: [{ type: 'text', text: digest }],
      source: { kind: 'plugin', plugin: 'dsh-agent-memory' },
    })
    injected.add(agent.session.id)
    const lastClaimedIndex = decision.messages.findLastIndex((m) => messages.includes(m))
    return { kind: 'enter', messages: decision.messages.toSpliced(lastClaimedIndex + 1, 0, message) }
  })
}
