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

import type { BrowseGroup, BrowseQuery, BrowseResult, Entry, RecallQuery, RecallResult, RecallResultItem, RelatedItem, TimelineLevel, WeightedTerm } from './types.ts'

/** 检索默认截断条数（未显式给 limit 时） */
export const DEFAULT_RECALL_LIMIT = 20

/** 相关度权重：标签命中 > 标题命中 > 正文命中 */
const SCORE_TAG = 3
const SCORE_TITLE = 2
const SCORE_BODY = 1

/**
 * 文档频率：包含该 token 的条目数（大小写不敏感；标签/标题/正文任一命中即计）。
 *
 * 用于 IDF —— **「相关度算法」的核心改进（2026-09-26 主人指令「相关度算法可以再改进改进」）**。
 * 原打分对每个词项等权，于是「改进 / 可以 / 需要」这类高频泛词与「相关度算法」这类特征词
 * 同权，泛词主导排序。当晚实例：主人那句话触发的注入三条，全是靠 bigram「改进」命中的
 * 无关条目（技能熔炉改进 / freelance-radar 改进 / 20+ 项改进），与「相关度算法」无关。
 * @param entries - 候选全集（打分上下文）
 * @param token - 查询词项
 * @returns 命中该词的条目数
 */
function documentFrequency(entries: readonly Entry[], token: string): number {
  const needle = token.toLowerCase()
  let count = 0
  for (const entry of entries) {
    if (entry.title.toLowerCase().includes(needle)) count += 1
    else if (entry.tags.some((tag) => tag.toLowerCase().includes(needle))) count += 1
    else if (entry.body.toLowerCase().includes(needle)) count += 1
  }
  return count
}

/**
 * IDF 权重：`log(1 + N / (1 + df))`（平滑；df=0 时取最大）。
 * 罕见词（「相关度算法」）权重高，高频泛词（「改进」）权重低。
 * @param total - 候选条目总数
 * @param df - 该词的文档频率
 */
function idfOf(total: number, df: number): number {
  return Math.log(1 + total / (1 + df))
}

/** 泛词门阈值：df ≥ 绝对下限 **且** df/N 超过比例线 ⇒ 该词无区分力（idf 置 0，不参与打分）。
 *  绝对下限用于**保护小语料**——测试夹具里 df/N 也会到 100%，但那里的词其实有区分力。 */
const GENERIC_MIN_DF = 50
const GENERIC_DF_RATIO = 0.1

/**
 * 为查询词集合预算 IDF 表（每词一次 DF 扫描，O(T×N)；recall 为低频操作，实测耗时无感）。
 * @param entries - 候选全集
 * @param tokens - 查询词项（可含重复）
 * @returns token → IDF
 */
function buildIdf(entries: readonly Entry[], tokens: readonly string[]): Map<string, number> {
  const out = new Map<string, number>()
  const total = entries.length
  for (const raw of tokens) {
    // 统一小写做键：scoreEntry* 查表用小写 token（tokenizeQuery 已小写，但 v0.7 重心项
    // 来自对话原文，未小写——不在此归一就会查空、静默退化为等权）
    const token = raw.toLowerCase()
    if (out.has(token)) continue
    const df = documentFrequency(entries, token)
    // 泛词门（v0.9）：无区分力的词置 idf=0 ⇒ 不贡献分数。动机（2026-09-26 实测）：
    // 主人说「相关度算法可以再改进改进」时命中 135 条、top5 分数并列（旧实现 6/6/6/6），
    // 全是靠 bigram「改进」命中的无关条目——泛词盖过了查询的真实意图。
    // 过滤后若无人得分 ⇒ 结果为空 ⇒ 上游静默跳过（**没有相关记忆就不打扰**）。
    const generic = total > 0 && df >= GENERIC_MIN_DF && df / total > GENERIC_DF_RATIO
    out.set(token, generic ? 0 : idfOf(total, df))
  }
  return out
}

/** snippet 最大长度（字符） */
const SNIPPET_MAX = 140

/** 文本清洗：小写 + 去空白（n-gram 前） */
function cleanForGram(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '')
}

/** 字符 2-gram：中文/英文通用子串特征（「上下文管理」→ 上下/下文/文管/管理） */
function ngrams(text: string): string[] {
  const clean = cleanForGram(text)
  if (clean.length < 2) return clean.length === 1 ? [clean] : []
  const out: string[] = []
  for (let i = 0; i < clean.length - 1; i++) out.push(clean.slice(i, i + 2))
  return out
}

/**
 * 联想层（v0.3）：为单个命中条目计算相关条目链（因果留痕维度）。
 * 关联强度 = 共享标签数×3 + 标题 2-gram 重叠×2 + 正文 2-gram 重叠×1。
 * 用「目标标题的 2-gram 是否出现在对方标题/正文」判定——中文无空格分词也自然工作。
 * 仅考虑有实质关联（strength>0）的条目；排除自身与归档（除非 includeArchive）。
 * @returns 按 strength 降序、取前 limit 条
 */
export function relatedOf(entries: Entry[], target: Entry, limit = 3, includeArchive = false): RelatedItem[] {
  const targetTitleGrams = ngrams(target.title)
  const out: RelatedItem[] = []
  for (const other of entries) {
    if (other.id === target.id) continue
    if (!includeArchive && other.archived) continue
    let sharedTags = 0
    for (const tag of other.tags) {
      if (target.tags.includes(tag)) sharedTags += 1
    }
    // 目标标题 2-gram 出现在对方标题/正文的次数 = 子串关联
    let titleOverlap = 0
    let bodyOverlap = 0
    const otherTitle = cleanForGram(other.title)
    const otherBody = cleanForGram(other.body)
    for (const g of targetTitleGrams) {
      if (otherTitle.includes(g)) titleOverlap += 1
      else if (otherBody.includes(g)) bodyOverlap += 1
    }
    const strength = sharedTags * 3 + titleOverlap * 2 + bodyOverlap * 1
    if (strength > 0) {
      out.push({ id: other.id, kind: other.kind, title: other.title, scope: other.scope, sharedTags, strength })
    }
  }
  out.sort((a, b) => b.strength - a.strength)
  return out.slice(0, limit)
}

/** 联想闭包条目（多跳联想导航：带层级与来源路径） */
export interface RelatedClosureItem extends RelatedItem {
  /** BFS 跳数（1 = 直接关联） */
  hop: number
}

/**
 * 联想闭包（v0.4）：从目标条目 BFS 多跳展开联想社区（记忆图行走）。
 * 沿 relatedOf 的关联边走，逐层扩展（hop 递增）；去重（visited 防环）、
 * 排除自身；每跳取关联强度 top limitPerHop。用于「沿关系网探索记忆社区」。
 * @param entries - 候选条目（全量）
 * @param target - 起点条目
 * @param depth - 最大跳数（1 = 单跳，与 relatedOf 等价）
 * @param limitPerHop - 每跳最多展开的邻居数（控制扇出）
 * @param includeArchive - 是否包含归档
 * @returns 按 (hop, strength 降序) 排序的闭包条目
 */
export function relateClosure(
  entries: Entry[],
  target: Entry,
  depth = 1,
  limitPerHop = 3,
  includeArchive = false,
): RelatedClosureItem[] {
  const visited = new Set<string>([target.id])
  const queue: Entry[] = [target]
  const out: RelatedClosureItem[] = []
  for (let hop = 1; hop <= depth && queue.length > 0; hop++) {
    const next: Entry[] = []
    for (const current of queue) {
      const neighbors = relatedOf(entries, current, limitPerHop, includeArchive)
      for (const n of neighbors) {
        if (visited.has(n.id)) continue
        visited.add(n.id)
        const entry = entries.find((e) => e.id === n.id)
        if (entry === undefined) continue
        out.push({ ...n, hop })
        next.push(entry)
      }
    }
    queue.length = 0
    queue.push(...next)
  }
  // 先按 hop 升序，同 hop 内按 strength 降序（BFS 层次优先）
  out.sort((a, b) => (a.hop !== b.hop ? a.hop - b.hop : b.strength - a.strength))
  return out
}

/**
 * recall 主入口：过滤 → 打分 → 排序 → 截断 → 联想（为结果附加相关链）。
 * @param entries - 候选条目（通常为当前 scope 与 global 合并后的全量）
 * @param query - 检索条件（全字段可选；query 文本为空时按新鲜度排序）
 * @returns { results, total }；total 为过滤后截断前的命中数
 */
export function recallEntries(entries: Entry[], query: RecallQuery = {}): RecallResult {
  const filtered = filterEntries(entries, query)
  // v0.7：给了上下文重心就按权重打分；否则退回原路径（query 字符串 + 等权词项）
  const weighted = query.weightedTerms !== undefined && query.weightedTerms.length > 0
    ? query.weightedTerms
    : undefined
  const tokens = tokenizeQuery(query.query)
  const hasQuery = weighted !== undefined || tokens.length > 0
  // v0.9：IDF 表——罕见词（特征词）权重高、高频泛词权重低。
  // 在**过滤后**的候选集上算 DF（比较基准就是本次检索范围）。
  const idfTokens = weighted !== undefined ? weighted.map((item) => item.term) : tokens
  const idf = hasQuery ? buildIdf(filtered, idfTokens) : new Map<string, number>()
  let scored = filtered.map((entry) => ({
    entry,
    score: weighted !== undefined ? scoreEntryWeighted(entry, weighted, idf) : scoreEntry(entry, tokens, idf),
  }))
  // 带查询时剔除零分条目（无关内容不进结果）；无查询词时全量按新鲜度排序
  if (hasQuery) scored = scored.filter(({ score }) => score > 0)
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    // accessedAt 新→旧（ISO 字典序即时间序）
    if (a.entry.accessedAt !== b.entry.accessedAt) {
      return a.entry.accessedAt < b.entry.accessedAt ? 1 : -1
    }
    // 同刻稳定排序：updatedAt 新→旧兜底
    if (a.entry.updatedAt !== b.entry.updatedAt) {
      return a.entry.updatedAt < b.entry.updatedAt ? 1 : -1
    }
    // 全平局返回 0（保持稳定排序/插入序）——2026-09-01 修复：
    // 原实现相等时返回 -1，违反比较器契约，导致全等条目顺序被打乱
    return 0
  })
  const limit = query.limit === undefined ? DEFAULT_RECALL_LIMIT : Math.max(0, Math.floor(query.limit))
  const includeArchive = query.includeArchive ?? false
  const results = scored.slice(0, limit).map(({ entry, score }) => {
    const item = toResultItem(entry, score)
    // 联想层：每个命中条目附相关链（仅在结果项上附加，不改变 total 语义）
    item.related = relatedOf(entries, entry, 3, includeArchive)
    return item
  })
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

/** 中文停用词（轻量检索增强 v0.2：查询去噪，避免虚词全命中拉低精度） */
const STOP_WORDS = new Set([
  '的', '了', '吗', '呢', '吧', '啊', '呀', '嘛', '哦', '嗯',
  '是', '在', '有', '和', '与', '或', '及', '跟', '并', '且',
  '我', '你', '他', '她', '它', '们', '这', '那', '个', '之',
  '到', '从', '对', '为', '把', '被', '让', '给', '向', '以',
  '一个', '一些', '这个', '那个', '什么', '怎么', '为什么', '如何', '哪里',
  '的', '地', '得', '着', '过', '呢', '吧', '啊',
])

/** 查询文本分词：小写 + 按空白切分 + 过滤停用词；无有效词返回空数组（按新鲜度排序）。
 *  **导出（v0.7）**：上下文重心（centroid.ts）复用同一套分词——判据单一真源，不得各写一份。 */
export function tokenizeQuery(query: string | undefined): string[] {
  if (query === undefined) return []
  const raw = query.toLowerCase().split(/\s+/).filter((token) => token.length > 0 && !STOP_WORDS.has(token))
  const tokens: string[] = []
  for (const token of raw) {
    tokens.push(token) // 保留原词（英文词 / 精确短语）
    for (const bigram of cjkBigrams(token)) {
      if (!STOP_WORDS.has(bigram) && !tokens.includes(bigram)) tokens.push(bigram)
    }
  }
  return tokens
}

/**
 * 中文 2-gram 抽取：无空格分词的 CJK 连续段按字符 bigram 展开，
 * 让「整句 query」也能命中标题/正文中的子串特征（中文检索增强 2026-09-01，
 * 与 relatedOf 的 ngrams 同哲学）。英文段不展开（保持词边界）。
 * @param token - 单个分词（可能混含中英）
 * @returns 覆盖中文相邻字符对的 bigram 列表
 */
function cjkBigrams(token: string): string[] {
  const out: string[] = []
  for (let i = 0; i < token.length - 1; i++) {
    const pair = token.slice(i, i + 2)
    if (/[\u4e00-\u9fff]/.test(pair)) out.push(pair)
  }
  return out
}

/**
 * 打分：逐词累加——标签子串命中 +3，标题子串命中 +2，正文子串命中 +1，**再乘该词的 IDF**。
 * 无查询词时全部 0 分（纯新鲜度排序）。
 *
 * v0.9（IDF）：乘权后「罕见特征词」压过「高频泛词」——查询「相关度算法 改进」时，
 * 含「相关度算法」的条目得分远高于只含「改进」的条目（后者 df 大 ⇒ idf 小）。
 * @param entry - 候选条目
 * @param tokens - 查询词项（小写）
 * @param idf - token → IDF；缺项回退 1（等权，与原行为一致，避免静默变差）
 */
function scoreEntry(entry: Entry, tokens: string[], idf: ReadonlyMap<string, number>): number {
  if (tokens.length === 0) return 0
  const title = entry.title.toLowerCase()
  const body = entry.body.toLowerCase()
  let score = 0
  for (const token of tokens) {
    const w = idf.get(token) ?? 1
    if (entry.tags.some((tag) => tag.toLowerCase().includes(token))) score += SCORE_TAG * w
    if (title.includes(token)) score += SCORE_TITLE * w
    if (body.includes(token)) score += SCORE_BODY * w
  }
  return score
}

/**
 * 加权打分（v0.7 上下文重心 + v0.9 IDF）：逐词累加 `IDF × 重心权重 × (标签 3 / 标题 2 / 正文 1)`。
 * 与 `scoreEntry` 同构，只是词项带重心权重——这样「话题重心」比「最后一个词」更有话语权。
 */
function scoreEntryWeighted(entry: Entry, terms: readonly WeightedTerm[], idf: ReadonlyMap<string, number>): number {
  if (terms.length === 0) return 0
  const title = entry.title.toLowerCase()
  const body = entry.body.toLowerCase()
  let score = 0
  for (const { term, weight } of terms) {
    const token = term.toLowerCase()
    const w = (idf.get(token) ?? 1) * weight
    if (entry.tags.some((tag) => tag.toLowerCase().includes(token))) score += SCORE_TAG * w
    if (title.includes(token)) score += SCORE_TITLE * w
    if (body.includes(token)) score += SCORE_BODY * w
  }
  return Math.round(score * 1000) / 1000
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

// ---------- 记忆浏览（memory_browse，v0.2） ----------

/** 时间桶 → 人类可读标签（year/month/week/day） */
const LEVEL_LABEL: Record<string, string> = {
  year: '年',
  month: '月',
  week: '周',
  day: '日',
}

/** 由 createdAt 生成日桶键（YYYY-MM-DD，本地时区） */
function dayBucketOf(iso: string): string {
  const d = new Date(iso)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** 条目参与浏览分组的时间键：优先自身 bucket（概要层），否则按 createdAt 日桶 */
function browseBucketOf(entry: Entry): string {
  if (entry.bucket !== null && entry.bucket.length > 0) return entry.bucket
  return dayBucketOf(entry.createdAt)
}

/**
 * 浏览分组：按时间桶聚合（概要按自身 bucket 分组，明细按 createdAt 日桶），
 * 组间按时间降序（字典序即时间序），组内按 updatedAt 新→旧。
 * level 参数存在时只浏览该层级（如只看周概要）；缺省全部层级。
 * @param entries - 候选条目（调用方合并作用域后传入）
 * @param query - 浏览条件（kind/tags/since/until/scope/includeArchive/level/分页）
 * @returns { groups, total }；total 为分页前命中条目数
 */
export function browseEntries(entries: Entry[], query: BrowseQuery = {}): BrowseResult {
  const filtered = entries.filter((entry) => {
    if (query.kind !== undefined && query.kind.length > 0 && !query.kind.includes(entry.kind)) return false
    if (query.tags !== undefined && query.tags.length > 0 && !query.tags.every((tag) => entry.tags.includes(tag))) return false
    if (query.includeArchive !== true && entry.archived) return false
    if (query.scope !== undefined && entry.scope !== query.scope) return false
    if (query.since !== undefined && entry.createdAt < query.since) return false
    if (query.until !== undefined && entry.createdAt > query.until) return false
    if (query.level !== undefined && entry.level !== query.level) return false
    return true
  })
  const groups = new Map<string, { bucket: string; level: BrowseGroup['level']; items: RecallResultItem[] }>()
  for (const entry of filtered) {
    const bucket = browseBucketOf(entry)
    let group = groups.get(bucket)
    if (group === undefined) {
      // 组层级：概要条目按其层级（day/week/month/year）；明细条目归 null
      group = { bucket, level: entry.kind === 'summary' ? (entry.level === 'day' || entry.level === 'week' || entry.level === 'month' || entry.level === 'year' ? entry.level : null) : null, items: [] }
      groups.set(bucket, group)
    }
    group.items.push(toResultItem(entry, 0))
  }
  const sorted = [...groups.values()].sort((a, b) => (a.bucket < b.bucket ? 1 : -1))
  for (const group of sorted) group.items.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  const page = Math.max(1, Math.floor(query.page ?? 1))
  const pageSize = Math.max(1, Math.floor(query.pageSize ?? 20))
  const start = (page - 1) * pageSize
  const paged = sorted.slice(start, start + pageSize).map((group) => ({ ...group, label: bucketLabel(group.bucket) }))
  return { groups: paged, total: sorted.length }
}

/** 桶键 → 展示标签（如 2026-W33 → 2026 第33周；2026-08 → 2026年8月） */
export function bucketLabel(bucket: string): string {
  if (/^\d{4}$/.test(bucket)) return bucket + ' 年'
  if (/^\d{4}-\d{2}$/.test(bucket)) {
    const [y, m] = bucket.split('-')
    return `${y} 年 ${Number(m)} 月`
  }
  if (/^\d{4}-W\d{2}$/.test(bucket)) {
    const [y, w] = bucket.split('-W')
    return `${y} 第 ${Number(w)} 周`
  }
  return bucket
}

