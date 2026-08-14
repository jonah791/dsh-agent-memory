/**
 * 检索管道（IMPLEMENTATION.md §4 / DESIGN.md §七）
 *
 * 纯函数设计：输入条目数组 + RecallQuery → 过滤 → 打分 → 排序 → 截断。
 * 作用域合并（workspace + global 混合检索）由调用方（tools 层）组合条目后传入，
 * 本模块不触碰存储，离线测试零依赖。
 *
 * 相关度排序（规格 §4）：标签命中 > 标题命中 > 正文命中（权重 3/2/1，多词累加），
 * 同分按 accessedAt 新→旧。时间过滤（since/until）以 createdAt 为准：
 * ISO 字符串字典序即时间序；纯日期输入按日界归一化。
 */

import type { Entry, RecallQuery, RecallResult, RecallResultItem } from './types.ts'

/** 检索默认截断条数（未显式给 limit 时） */
export const DEFAULT_RECALL_LIMIT = 20

/** 相关度权重：标签命中 > 标题命中 > 正文命中 */
const SCORE_TAG = 3
const SCORE_TITLE = 2
const SCORE_BODY = 1

/** snippet 最大长度（字符） */
const SNIPPET_MAX = 140

/**
 * recall 主入口：过滤 → 打分 → 排序 → 截断。
 * @param entries - 候选条目（通常为当前 scope 与 global 合并后的全量）
 * @param query - 检索条件（全字段可选；query 文本为空时按新鲜度排序）
 * @returns { results, total }；total 为过滤后截断前的命中数
 */
export function recallEntries(entries: Entry[], query: RecallQuery = {}): RecallResult {
  const filtered = filterEntries(entries, query)
  const tokens = tokenize(query.query)
  let scored = filtered.map((entry) => ({
    entry,
    score: scoreEntry(entry, tokens),
  }))
  // 带文本查询时剔除零分条目（无关内容不进结果）；无查询词时全量按新鲜度排序
  if (tokens.length > 0) scored = scored.filter(({ score }) => score > 0)
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    // accessedAt 新→旧（ISO 字典序即时间序）
    if (a.entry.accessedAt !== b.entry.accessedAt) {
      return a.entry.accessedAt < b.entry.accessedAt ? 1 : -1
    }
    // 同刻稳定排序：updatedAt 新→旧兜底
    return a.entry.updatedAt < b.entry.updatedAt ? 1 : -1
  })
  const limit = query.limit === undefined ? DEFAULT_RECALL_LIMIT : Math.max(0, Math.floor(query.limit))
  const results = scored.slice(0, limit).map(({ entry, score }) => toResultItem(entry, score))
  return { results, total: scored.length }
}

/**
 * 过滤阶段：kind（任一命中）/ tags（全部命中）/ since-until（createdAt 区间）/
 * scope（精确）/ archived（默认剔除）。
 * 返回原始条目数组（不拷贝——下游只读）。
 */
function filterEntries(entries: Entry[], query: RecallQuery): Entry[] {
  const since = normalizeSince(query.since)
  const until = normalizeUntil(query.until)
  const kinds = query.kind
  const tags = query.tags
  return entries.filter((entry) => {
    if (kinds !== undefined && kinds.length > 0 && !kinds.includes(entry.kind)) return false
    if (tags !== undefined && tags.length > 0 && !tags.every((tag) => entry.tags.includes(tag))) return false
    if (!query.includeArchive && entry.archived) return false
    if (query.scope !== undefined && entry.scope !== query.scope) return false
    if (since !== undefined && entry.createdAt < since) return false
    if (until !== undefined && entry.createdAt > until) return false
    return true
  })
}

/** 查询文本分词：小写 + 按空白切分；无有效词返回空数组（按新鲜度排序） */
function tokenize(query: string | undefined): string[] {
  if (query === undefined) return []
  return query.toLowerCase().split(/\s+/).filter((token) => token.length > 0)
}

/**
 * 打分：逐词累加——标签子串命中 +3，标题子串命中 +2，正文子串命中 +1。
 * 无查询词时全部 0 分（纯新鲜度排序）。
 */
function scoreEntry(entry: Entry, tokens: string[]): number {
  if (tokens.length === 0) return 0
  const title = entry.title.toLowerCase()
  const body = entry.body.toLowerCase()
  let score = 0
  for (const token of tokens) {
    if (entry.tags.some((tag) => tag.toLowerCase().includes(token))) score += SCORE_TAG
    if (title.includes(token)) score += SCORE_TITLE
    if (body.includes(token)) score += SCORE_BODY
  }
  return score
}

/** 结果项组装：概要字段 + score + 层级标注（level 原样透出，标注文案由工具层给模型） */
function toResultItem(entry: Entry, score: number): RecallResultItem {
  return {
    id: entry.id,
    kind: entry.kind,
    title: entry.title,
    snippet: makeSnippet(entry.body),
    tags: [...entry.tags],
    scope: entry.scope,
    level: entry.level,
    score,
    archived: entry.archived,
    updatedAt: entry.updatedAt,
  }
}

/** snippet：正文首段的前 SNIPPET_MAX 字符，超长截断加省略号 */
function makeSnippet(body: string): string {
  const firstLine = body.split(/\n+/).find((line) => line.trim().length > 0) ?? ''
  const trimmed = firstLine.trim()
  if (trimmed.length <= SNIPPET_MAX) return trimmed
  return trimmed.slice(0, SNIPPET_MAX).trimEnd() + '…'
}

/** since 归一化：纯日期（YYYY-MM-DD）补到当日 00:00:00.000Z，其余原样 */
function normalizeSince(since: string | undefined): string | undefined {
  if (since === undefined) return undefined
  return /^\d{4}-\d{2}-\d{2}$/.test(since) ? since + 'T00:00:00.000Z' : since
}

/** until 归一化：纯日期（YYYY-MM-DD）补到当日 23:59:59.999Z，其余原样 */
function normalizeUntil(until: string | undefined): string | undefined {
  if (until === undefined) return undefined
  return /^\d{4}-\d{2}-\d{2}$/.test(until) ? until + 'T23:59:59.999Z' : until
}
