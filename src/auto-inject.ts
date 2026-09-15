/**
 * 自动 recall 注入（L3，2026-09-01 主人「怎么提高记忆库使用率」定调）
 *
 * 与启动注入（inject.ts，会话首注入记忆速览）互补：
 * - 启动注入：每会话一次，注入「记忆目录速览」（时间金字塔 + 近期明细）
 * - 本模块：每条新主人消息到达时，以消息文本为 query 跑 recall，
 *   把 top 命中（标题 + snippet + 相关度）注入到批次末尾（tail append，缓存友好）
 *
 * 触发条件（全部满足才注入）：
 * 1. 批次中存在「真实主人消息」：role==='user' && source.kind==='user'
 *    （排除 source.kind === 'tool' 的工具结果 / 'plugin' 的插件注入 / 'model'）
 * 2. 该消息 id 本会话尚未处理过（per-session 去重，避免同一步骤反复注入）
 * 3. recall 有命中（score>0）且摘要非空
 * 4. 配置 autoInject.enabled === true
 *
 * 注入位置：批次末尾（尾追加，与前缀缓存兼容，同 inject.ts）。
 * 消息 source：plugin 来源 + form:'recall'（官方「从其他会话/记忆捞取内容」语义）。
 *
 * 纯函数 buildAutoRecallDigest 离线可测（tests/auto-inject.test.mjs）。
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { Entry, MemoryConfig } from './types.ts'
import type { MemoryStore } from './store.ts'
import { workspaceIdOf, GLOBAL_SCOPE } from './scope.ts'
import { applyRoleView, narrowReadScopes, roleViewOf, type RoleCarrier } from './role.ts'
import { buildCentroid, recentTurnTexts } from './centroid.ts'
import type { WeightedTerm } from './types.ts'
import { recallEntries } from './search.ts'

/** 注入依赖：存储 + 配置加载（测试注入 mock） */
export interface AutoRecallInjectDeps {
  store: MemoryStore
  loadConfig: (workspaceRoot: string) => Promise<MemoryConfig> | MemoryConfig
  /** 侧车用量轨迹写入（v0.6；缺省不落盘）。吞错由实现方负责——注入绝不能因它失败 */
  recordAccess?: (record: { atMs: number; source: 'recall' | 'auto' | 'audit'; role?: string; ids: string[] }) => Promise<boolean> | void
}

/** snippet 最大长度（字符） */
const SNIPPET_MAX = 90

/** 最长注入的查询词数（query 过长的消息截断到前 N 字符再检索，防长文噪音） */
const QUERY_MAX = 200

/**
 * 从消息批次中提取最后一条真实主人消息（role=user）。
 * 触发来源严格限定为两种（主人 2026-09-01 反馈「不要什么消息都返回记忆」）：
 * 1. GUI/Web 直接发送：source.kind === 'user'
 * 2. Telegram 收件：source.kind === 'plugin' && source.plugin === 'dsh-agent-telegram'
 *    （dsh-agent-telegram 注入，文本带 '[telegram] ' 前缀，检索前剥掉）
 * 其余一律不触发（tool 结果 / 其他 plugin 注入 / model 消息）。
 * 倒序遍历找「最新」的真实主人消息；内容取全部 text block 拼接后 trim。
 * @param messages - 当前批次消息（pre-step decision.messages）
 * @returns { id, text }；无可触发来源 / 无文本内容返回 undefined
 */
export function lastUserMessageText(
  messages: readonly unknown[],
): { id: string; text: string } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as
      | { role?: string; source?: { kind?: string; plugin?: string }; id?: string; content?: Array<{ type?: string; text?: string }> }
      | undefined
    if (m?.role !== 'user') continue
    const kind = m.source?.kind
    const isGui = kind === 'user'
    const isTelegram = kind === 'plugin' && m.source?.plugin === 'dsh-agent-telegram'
    if (!isGui && !isTelegram) continue
    if (typeof m.id !== 'string') continue
    let text = (m.content ?? [])
      .filter((b) => b?.type === 'text')
      .map((b) => b?.text ?? '')
      .join('\n')
      .trim()
    if (isTelegram) text = text.replace(/^\[telegram\]\s*/, '').trim()
    if (text.length === 0) continue
    return { id: m.id, text }
  }
  return undefined
}

/**
 * 组装自动 recall 注入文本（纯函数）。
 * 以 query 检索（recallEntries：标签>标题>正文打分，score>0 过滤无关），
 * 取 top maxEntries 命中，渲染为「标题（日期 · 相关度）：snippet」行。
 * 预算：maxEntries 截断条目数；maxBytes 截断字符数（截断处提示）。
 * **v0.7**：给了 `opts.weightedTerms`（上下文重心）就用它打分——「此刻在谈什么」比
 * 「最后一条消息的字面」更有话语权；未给则完全走原路径（零回归）。
 * @param entries - 候选条目（调用方合并当前 workspace + global）
 * @param query - 用户消息文本（自动截断到 QUERY_MAX）
 * @param opts - 预算 + 可选上下文重心
 * @returns 完整注入文本（含帧标记）；无命中返回空串
 */
export function buildAutoRecallDigest(
  entries: Entry[],
  query: string,
  opts: { maxEntries: number; maxBytes: number; weightedTerms?: WeightedTerm[] },
): string {
  const trimmed = query.trim()
  const weighted = opts.weightedTerms !== undefined && opts.weightedTerms.length > 0 ? opts.weightedTerms : undefined
  if (trimmed.length === 0 && weighted === undefined) return ''
  const limited = trimmed.length > QUERY_MAX ? trimmed.slice(0, QUERY_MAX) : trimmed
  const { results } = recallEntries(entries, {
    ...(weighted !== undefined ? { weightedTerms: weighted } : { query: limited }),
    limit: opts.maxEntries,
  })
  if (results.length === 0) return ''
  const lines: string[] = []
  for (const r of results) {
    const date = r.updatedAt.slice(0, 10)
    const kind = r.kind.toUpperCase()
    const score = r.score > 0 ? ` · 相关度 ${r.score}` : ''
    const snippet = r.snippet.length > SNIPPET_MAX ? r.snippet.slice(0, SNIPPET_MAX).trimEnd() + '…' : r.snippet
    lines.push(`- [${kind}] ${r.title}（${date}${score}）：${snippet}`)
  }
  let body = `【相关记忆（auto-recall）】\n${lines.join('\n')}`
  if (body.length > opts.maxBytes) {
    const hint = '\n（已按预算截断，可用 recall 展开全文）'
    body = body.slice(0, Math.max(0, opts.maxBytes - hint.length)) + hint
  }
  return `<system-reminder>\n按当前消息自动检索的相关记忆（dsh-agent-memory）：\n\n${body}\n</system-reminder>`
}

/**
 * 安装自动 recall 注入：每条新主人消息注入 top 命中（尾追加，缓存友好）。
 * 与 agent-instructions / inject.ts 同款瀑布监听器：await next() 后合并入批次。
 * @param ctx - 插件上下文（需要 agents 会话事件；pre-step 由 agent-loop 触发）
 * @param deps - 注入依赖
 */
export function installAutoRecallInject(ctx: Context, deps: AutoRecallInjectDeps): void {
  // per-session 已处理消息 id（去重：同一消息只注入一次）
  const processed = new Map<string, Set<string>>()

  ctx.on('agent/pre-step', async ({ agent, step, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision

    const sessionId = agent.session.id
    let seen = processed.get(sessionId)
    if (seen === undefined) {
      seen = new Set()
      processed.set(sessionId, seen)
    }

    // 找到最后一条真实主人消息；无则跳过（工具结果/插件注入轮不触发）
    const found = lastUserMessageText(decision.messages)
    if (found === undefined) return decision
    if (seen.has(found.id)) return decision
    seen.add(found.id)

    // 配置门：无 cwd 无法定位项目 → 跳过（同启动注入策略）
    const cwd = agent.session.header.cwd
    if (cwd === undefined) return decision
    const config = await deps.loadConfig(cwd)
    if (!config.autoInject.enabled) return decision

    // 检索：合并当前 workspace + global（attach 语义同 recall 工具）
    const scope = workspaceIdOf(cwd)
    // 角色视野（v0.5）：注入面同样受准入约束——否则隔离会在注入路径上被静默绕过
    const view = roleViewOf(config, { agent } as unknown as RoleCarrier)
    const scopes = narrowReadScopes([scope, GLOBAL_SCOPE], view, undefined)
    const merged = applyRoleView(scopes.flatMap((s) => deps.store.list(s)), view)
    // 上下文重心（v0.7）：注入查询 =「此刻这段对话在谈什么」，而不是最后一条消息的字面。
    // 锚点那条已由 lastUserMessageText 取出，从历史里剔除以免重复计权。
    const history = recentTurnTexts(decision.messages, 4)
    const anchorIndex = history.lastIndexOf(found.text)
    const turns = anchorIndex >= 0
      ? [...history.slice(0, anchorIndex), ...history.slice(anchorIndex + 1)]
      : history
    const weightedTerms = buildCentroid(turns, found.text)
    const digest = buildAutoRecallDigest(merged, found.text, {
      maxEntries: config.autoInject.maxEntries,
      maxBytes: config.autoInject.maxBytes,
      ...(weightedTerms.length > 0 ? { weightedTerms } : {}),
    })
    // 侧车用量轨迹（v0.6）：auto-recall 命中同样是「被用到」的证据；失败静默
    if (digest.length > 0 && config.audit?.accessTrace?.enabled === true && deps.recordAccess !== undefined) {
      const queryLimit = found.text.length > QUERY_MAX ? found.text.slice(0, QUERY_MAX) : found.text
      const hitIds = recallEntries(merged, {
        ...(weightedTerms.length > 0 ? { weightedTerms } : { query: queryLimit }),
        limit: config.autoInject.maxEntries,
      }).results.map((item) => item.id)
      if (hitIds.length > 0) {
        void deps.recordAccess({ atMs: Date.now(), source: 'auto', role: view.role, ids: hitIds })
      }
    }
    if (digest.length === 0) return decision

    signal.throwIfAborted()
    const message = createUserMessage({
      content: [{ type: 'text', text: digest }],
      source: { kind: 'plugin', plugin: 'dsh-agent-memory', form: 'recall' },
    })
    // 尾追加（缓存友好）：动态注入统一放在批次末尾，避免插在历史中部破坏前缀缓存
    return { kind: 'enter', messages: [...decision.messages, message] }
  })
}