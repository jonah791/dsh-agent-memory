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

import type { BrowseGroup, BrowseQuery, BrowseResult, Entry, RecallEntityMatch, RecallQuery, RecallResult, RecallResultItem, RecallTuning, RelatedItem, TimelineLevel, WeightedTerm } from './types.ts'
import { matchesName } from './entities.ts'
import { lifecycleOf } from './lifecycle.ts'
import { collapseFamilies, renderFamilyNote } from './family.ts'
import { transcriptiveFlagOf } from './origin.ts'
import { archivalOf } from './archive.ts'

/** 检索默认截断条数（未显式给 limit 时） */
export const DEFAULT_RECALL_LIMIT = 20

/** 相关度权重：标签命中 > 标题命中 > 正文命中 */
const SCORE_TAG = 3
const SCORE_TITLE = 2
const SCORE_BODY = 1

/**
 * 实体匹配加成（v0.31.0 · 方案 §8.3「实体匹配」）：查询点到了某个实体，**提到该实体的条目**加分。
 *
 * **为什么不是「把别名塞进查询词」**（那是 `expandThesaurus` 的做法）：塞词只让**字面相同**的条目
 * 得分，而实体匹配要的恰是「同一个东西的另一种写法」——查「AML 的进度」要能找到写
 * 「智能体记忆图书馆」的条目，两串没有任何共同 token。
 *
 * **权重 2.5 的定位**：低于标签/别名命中（3 —— 人工给的检索入口，意图明确），
 * 高于正文命中（1 —— 内容里偶然的用词）。它是「同一指称」级别的强信号，但不是人工标注。
 */
const SCORE_ENTITY = 2.5

/**
 * 打分分解里的一个词项贡献（v0.32 · 诊断视图）。
 *
 * 存在的理由是可复现的事故：v0.17 加 BM25 长度归一就是**跳过分数分解直接动刀**，
 * 结果 out-of-sample 差 5.7 个百分点（三次实测见 `BM25_B` 注释）。判据：任何噪声抑制
 * 改动落地前，必须先看见「哪个 token、在哪个字段、贡献了多少」。
 */
export interface ScoreTermBreakdown {
  /** 该词项贡献的查询词项（小写；中文查询已被展开成 2-gram） */
  term: string
  /** 实际用于打分的 IDF（0 = 被泛词门抑制；`entity` 项不乘 IDF，恒记 1） */
  idf: number
  /** 重心权重（`weightedTerms` 路径取该词项的权重，普通路径恒 1） */
  weight: number
  /**
   * 命中字段。`alias` = 检索入口词（`aliases` ∪ `cue`，与 `lowerOf` 的合并视图同源）；
   * `entity` = 实体匹配加成（按整个 hay 匹配，不分字段）；
   * `cap` = 多字段封顶的**负贡献**（只有开 `tuning.multiFieldCap` 时出现，见 `applyCap`）。
   */
  field: 'alias' | 'tag' | 'title' | 'body' | 'entity' | 'cap'
  /** 实际加进分数的量（已含 IDF、重心权重、长度归一、实体权重） */
  contribution: number
}

/** 单个条目的打分分解（v0.32 · 诊断视图；不参与生产排序，也不改变 `total` 语义） */
export interface ScoreExplanation {
  id: string
  title: string
  /** 正文长度（诊断用：判断一个条目的词面优势是否来自体量） */
  bodyLength: number
  score: number
  /** 逐项贡献，**求和恰好等于 `score`**（A150）；被泛词门抑制的词项也会出现（贡献 0） */
  terms: ScoreTermBreakdown[]
}

/**
 * 实体匹配用小写正文视图的缓存（与 `lowerCache` 同一模式、同一失效理由）。
 * 只在真开了实体匹配（`entityMatches` 非空）时才构造 —— 关着的时候零成本。
 */
const entityHayCache = new WeakMap<Entry, string>()

function entityHayOf(entry: Entry, view: LowerView): string {
  const cached = entityHayCache.get(entry)
  if (cached !== undefined) return cached
  const hay = [view.title, ...view.tags, ...view.aliases, view.body].join('\n')
  entityHayCache.set(entry, hay)
  return hay
}

/**
 * 实体检出加成：命中几个实体就加几份（乘该实体的查询强度）。
 * @param entry - 候选条目
 * @param view - 该条目的小写视图
 * @param matches - 查询解析出的实体（缺省 = 不做实体匹配）
 * @param collect - 诊断收集器（缺省 = 不收集，零分配）
 */
function entityBonus(entry: Entry, view: LowerView, matches: readonly RecallEntityMatch[] | undefined, collect?: ScoreTermBreakdown[]): number {
  if (matches === undefined || matches.length === 0) return 0
  const hay = entityHayOf(entry, view)
  let bonus = 0
  for (const match of matches) {
    if (match.names.some((name) => matchesName(hay, name))) {
      const add = SCORE_ENTITY * match.weight
      bonus += add
      // term 取该实体的第一个称呼（调用方按规范名在前构造，见 `RecallEntityMatch.names`）
      collect?.push({ term: match.names[0] ?? '', idf: 1, weight: match.weight, field: 'entity', contribution: add })
    }
  }
  return bonus
}

/**
 * 相对分数门槛（v0.17，2026-10-27）：排序后只保留 `score ≥ topScore × 本值` 的条目。
 *
 * **动机（基线实测）**：旧实现只剔 `score > 0` ⇒ 「因单个 bigram 偶然命中」的尾巴全留下：
 * 查「读过 不代表 做出 改进 提交 修 报告」→ **140 条**，而第 2 名只有 top1 的 **16%**（26.46 / 162.83）；
 * 查「相关度算法 IDF 泛词门 最低分门 recall 检索」→ **190 条**，第 3 名只有 top1 的 **17%**。
 *
 * **为什么不是 0.2**（这是有读数的取舍，不是拍脑袋）：
 * 0.2 会把「检索路线：明确排除向量语义检索（主人 2026-10-13 20:59 定调）」砍掉
 * —— 实测 34.48 / 264.15 = **0.13**，而那条是**绝不能误杀**的定调类条目。
 *
 * **为什么 v0.18（2026-10-27）从 0.05 提到 0.08**：0.05 时它砍不动长尾——
 * 12 个真实查询平均返回 **36.5 条**、其中 6 个打满 limit。提到 0.08 后平均 **29.7 条**、
 * 打满的降到 3 个，而 top1 一分不降（门槛只能砍低分尾，**结构上不可能改变 top1**）
 * ⇒ 这个旋钮只调噪音，不牺牲精度。
 *
 * ⚠ v0.17 的注释说「主刀是 `bodyLengthNorm`（长度归一化）」——**那句话已被推翻**：
 *   长度归一是净损失（holdout 18:3 显著更差 +5.7pp），已在 v0.18 关掉（见 `BM25_B`）。
 *   ⇒ 现在砍长尾的**只有**这道门槛，它不再是配角。
 */
const RECALL_RELATIVE_FLOOR = 0.08

/** 条目的小写视图（检索全程复用的小写缓存实体） */
interface LowerView {
  title: string
  tags: string[]
  /** 检索入口的小写视图：`aliases`（词面）**与 `cue`（情境形状）合并**——与 tags 同级打分 */
  aliases: string[]
  body: string
}

/**
 * 小写视图缓存（2026-10-13 性能改造 · 治「每词每库重跑 toLowerCase」）。
 *
 * **为什么需要**（2026-10-13 实测）：`documentFrequency` 对**每个查询词项**遍历全库，
 * 且循环体内对每条目调用 `entry.body.toLowerCase()` —— 全库正文 217 万字符，
 * 15 个词项 ⇒ 同一批正文被小写 **15 遍**。查询「讲讲改进后的记忆插件的设计思路」
 * 实测 IDF 段 **135.3 ms**，缓存后稳态 **13.2 ms**（**10.3×**）。
 *
 * **等价性**：`toLowerCase()` 是纯函数（同一字符串返回值恒定）⇒ 本缓存只做
 * 「同一输入不重复计算」，**不改变任何比较结果**。缓存实体与未缓存实体逐字段可比。
 *
 * **失效**：键为 Entry **对象**（WeakMap）。`MemoryStore` 读出的是快照拷贝
 * （store.ts 注释明写），条目内容变化即换新对象 ⇒ 自然失效、零维护，且不阻止 GC。
 * 与既有 `gramCache` 同一模式。
 */
const lowerCache = new WeakMap<Entry, LowerView>()

function lowerOf(entry: Entry): LowerView {
  const hit = lowerCache.get(entry)
  if (hit !== undefined) return hit
  const view: LowerView = {
    title: entry.title.toLowerCase(),
    tags: entry.tags.map((tag) => tag.toLowerCase()),
    // cue（情境形状，v0.16.0）与 aliases（检索别名）**同级**：两者都是人工给的检索入口，
    // 只是防的失配不同（词面失配 vs 场景失配）。合进同一个数组 ⇒ 所有打分点自动覆盖，
    // 不必在每个 `view.aliases.some(...)` 处各加一行（那正是最容易漏一处的地方）。
    aliases: [...(entry.aliases ?? []), ...(entry.cue ?? [])].map((s) => s.toLowerCase()),
    body: entry.body.toLowerCase(),
  }
  lowerCache.set(entry, view)
  return view
}

/**
 * 检索入口词的**单一来源**：`aliases`（词面失配）+ `cue`（情境形状失配）。
 *
 * ⚠ 三处消费者（`gramIndexOf` 的 titleGrams 与 title 兜底字段、`targetGramsOf`）必须**都走本函数**。
 * 两侧范围不一致会出现「自己查自己查不到」（见 `targetGramsOf` 的同源纪律）——
 * 用一个函数而不是三处各写一遍，是因为后者正是会漏一处的形状。
 *
 * @param entry - 记忆条目
 * @returns 全部检索入口词（保持原序，不去重——去重由调用方按需做）
 */
function entryEntryWords(entry: Entry): string[] {
  return [...(entry.aliases ?? []), ...(entry.cue ?? [])]
}

/**
 * 文档频率：包含该 token 的条目数（大小写不敏感；标签/标题/正文任一命中即计）。
 *
 * 用于 IDF —— **「相关度算法」的核心改进（2026-09-26 主人指令「相关度算法可以再改进改进」）**。
 * 原打分对每个词项等权，于是「改进 / 可以 / 需要」这类高频泛词与「相关度算法」这类特征词
 * 同权，泛词主导排序。当晚实例：主人那句话触发的注入三条，全是靠 bigram「改进」命中的
 * 无关条目（技能熔炉改进 / freelance-radar 改进 / 20+ 项改进），与「相关度算法」无关。
 *
 * ⚠ 2026-10-13：小写改用 `lowerOf` 缓存视图（原为循环体内现算，见该函数注释）。
 * @param entries - 候选全集（打分上下文）
 * @param token - 查询词项
 * @returns 命中该词的条目数
 */
function documentFrequency(entries: readonly Entry[], token: string): number {
  const needle = token.toLowerCase()
  let count = 0
  for (const entry of entries) {
    const view = lowerOf(entry)
    if (view.title.includes(needle)) count += 1
    else if (view.tags.some((tag) => tag.includes(needle))) count += 1
    else if (view.aliases.some((alias) => alias.includes(needle))) count += 1
    else if (view.body.includes(needle)) count += 1
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
 * 单个查询词项的检索面画像（v0.32 · 诊断视图）。
 *
 * 存在的理由是噪声抑制的核心问题：**同一个查询里，哪些词项有区分力、哪些只是噪声**。
 * 没有这张表，判断只能靠「哪条排前面」的间接观察——而 v0.17 的教训正是从观察直接跳到结论。
 */
export interface TokenProfile {
  /** 小写词项（中文查询已展开成 2-gram） */
  term: string
  /** 检索面上包含该词的条目数 */
  df: number
  /** 实际用于打分的 IDF（与 `buildIdf` 同源；0 = 被泛词门抑制） */
  idf: number
  /** 是否被泛词门置零（= 该词在本次候选集里没有区分力） */
  suppressed: boolean
}

/**
 * 泛词门判据（v0.9 · 单一真源）：`df ≥ GENERIC_MIN_DF` **且** `df/N > GENERIC_DF_RATIO` ⇒ 无区分力。
 *
 * 绝对下限用于**保护小语料**——测试夹具里 df/N 也会到 100%，但那里的词其实有区分力。
 * 动机（2026-09-26 实测）：主人说「相关度算法可以再改进改进」时命中 135 条、top5 分数并列
 * （旧实现 6/6/6/6），全是靠 bigram「改进」命中的无关条目——泛词盖过了查询的真实意图。
 */
function isGenericTerm(total: number, df: number): boolean {
  return total > 0 && df >= GENERIC_MIN_DF && df / total > GENERIC_DF_RATIO
}

/**
 * 预算查询词项画像（每词一次 DF 扫描，O(T×N)；recall 为低频操作，实测耗时无感）。
 * @param entries - 候选全集（打分上下文）
 * @param tokens - 查询词项（可含重复；按小写去重，保持首次出现顺序）
 * @param genericFactor - 泛词门的**生效值系数**：0（缺省）= 归零（v0.9 行为）；
 *   正数 = 降权而不归零（理由见 `RecallTuning.genericFactor`）。
 *   ⚠ 判据只有一处（`isGenericTerm`），本参数只决定「判为泛词之后怎么处置」。
 */
export function tokenProfile(entries: readonly Entry[], tokens: readonly string[], genericFactor = 0): TokenProfile[] {
  const total = entries.length
  const seen = new Set<string>()
  const out: TokenProfile[] = []
  for (const raw of tokens) {
    // 统一小写做键：scoreEntry* 查表用小写 token（tokenizeQuery 已小写，但 v0.7 重心项
    // 来自对话原文，未小写——不在此归一就会查空、静默退化为等权）
    const term = raw.toLowerCase()
    if (seen.has(term)) continue
    seen.add(term)
    const df = documentFrequency(entries, term)
    const suppressed = isGenericTerm(total, df)
    // `genericFactor === 0` 时 `base × 0 === 0`，与 v0.9 的「直接给 0」逐位相同（idfOf 恒正）。
    const base = idfOf(total, df)
    out.push({ term, df, idf: suppressed ? base * genericFactor : base, suppressed })
  }
  return out
}

/**
 * 为查询词集合预算 IDF 表（委托 `tokenProfile` —— 判据只有一处）。
 * @param entries - 候选全集
 * @param tokens - 查询词项（可含重复）
 * @param genericFactor - 泛词门生效值系数（0 = 归零，缺省）
 * @returns token → IDF
 */
function buildIdf(entries: readonly Entry[], tokens: readonly string[], genericFactor = 0): Map<string, number> {
  const out = new Map<string, number>()
  for (const profile of tokenProfile(entries, tokens, genericFactor)) out.set(profile.term, profile.idf)
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

/** 条目的清洗文本与其 2-gram 集合（`relatedOf` 的缓存视图） */
interface GramIndex {
  title: string
  body: string
  titleGrams: Set<string>
  bodyGrams: Set<string>
}

/**
 * gram 索引缓存（2026-10-12 性能修复）。
 *
 * 为什么快：`relatedOf` 原先对**全库每条**都做 `cleanForGram(title)+cleanForGram(body)`
 * （两次正则替换全文）+ 逐 gram `includes` ⇒ O(结果数 × 全库)，CPU profile 里
 * relatedOf 家族占 88.9%。这里把「清洗 + 2-gram 集合」按 Entry 对象缓存一次。
 *
 * 等价性依据（**这是本改动唯一需要论证的地方**）：`ngrams()` 产出的 gram 长度恒为 2
 * （唯一例外是 clean.length===1 时返回的**单字符**）⇒ 对一个长度 2 的 g，
 * `cleanText.includes(g)` ⟺ `g ∈ cleanText 的 2-gram 集合`（子串出现位置必对齐）。
 * 单字符 g 不满足此等价 ⇒ 该分支**回退** `includes`（见 `relatedOf` 内注释）。
 *
 * 用 WeakMap：键是 Entry 对象 ⇒ 条目数组换实例时自然失效，**零失效维护**，
 * 也不阻止 GC（不构成常驻内存泄漏）。
 */
const gramCache = new WeakMap<Entry, GramIndex>()

function gramSetOf(clean: string): Set<string> {
  const out = new Set<string>()
  for (let i = 0; i < clean.length - 1; i++) out.add(clean.slice(i, i + 2))
  return out
}

function gramIndexOf(entry: Entry): GramIndex {
  const hit = gramCache.get(entry)
  if (hit !== undefined) return hit
  // 标题 + 别名（见 entryGramSource 注释）。**分别取 gram 再并集**，不先拼字符串——
  // 拼接会在接缝处产生跨边界假 gram（如「手册」+「服务」→「册服」）。
  const title = entry.title
  const body = cleanForGram(entry.body)
  const words = entryEntryWords(entry)
  const titleGrams = gramSetOf(cleanForGram(title))
  for (const word of words) {
    for (const g of gramSetOf(cleanForGram(word))) titleGrams.add(g)
  }
  // `title` 字段供 |g|===1 的退化分支 `includes` 兜底——它必须覆盖与 gram 相同的文本范围，
  // 否则「单字符别名」在兜底分支里查不到（grams 并集含别名、纯 includes 不含 ⇒ 不一致）。
  const idx: GramIndex = {
    title: cleanForGram([title, ...words].join(' ')),
    body,
    titleGrams,
    bodyGrams: gramSetOf(body),
  }
  gramCache.set(entry, idx)
  return idx
}

/**
 * 目标侧 gram 来源（2026-10-13 重做）：标题 **+ 别名**。
 *
 * **为什么并入别名**：别名是「这条记忆可能被怎么问」的入口（见 `Entry.aliases` 注释）。
 * 若联想只读标题，会出现「检索能靠别名命中、但联想链里看不到关联」的不一致——
 * 同一份「入口」语义在两条路径上表现不同。
 *
 * ⚠ 必须与 `gramIndexOf` 的 titleGrams **同源**：`relatedOf` 用本函数的输出
 * 去 `has()` 对方的 `titleGrams`，两侧范围不一致就会出现「自己查自己查不到」。
 */
function targetGramsOf(entry: Entry): string[] {
  const out = ngrams(entry.title)
  for (const word of entryEntryWords(entry)) {
    for (const g of ngrams(word)) if (!out.includes(g)) out.push(g)
  }
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
  // 目标侧 gram = 标题 + 别名（与 gramIndexOf 的 titleGrams 同源，见 targetGramsOf 注释）。
  const targetTitleGrams = targetGramsOf(target)
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
    const oi = gramIndexOf(other)
    for (const g of targetTitleGrams) {
      // ⚠ 等价性边界（见 gramIndexOf 注释）：|g|===2 时 `includes` ⟺ 属于 2-gram 集合；
      // |g|===1（clean.length===1 的退化情形）不满足该等价 ⇒ 该分支回退 includes。
      const two = g.length === 2
      const inTitle = two ? oi.titleGrams.has(g) : oi.title.includes(g)
      if (inTitle) titleOverlap += 1
      else if (two ? oi.bodyGrams.has(g) : oi.body.includes(g)) bodyOverlap += 1
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

/** 一条带分数的候选：`recallEntries` 与 `explainRecall` 共用的排序输入 */
interface ScoredEntry {
  entry: Entry
  score: number
  /** 诊断收集器（只有 `explainRecall` 填；生产路径不分配） */
  terms?: ScoreTermBreakdown[]
}

/**
 * 排序比较器（v0.32 · 单一真源）：分数降序 → `accessedAt` 新→旧 → `updatedAt` 新→旧 → 稳定。
 *
 * **为什么抽成函数**：`explainRecall` 必须复现 `recallEntries` 的**名次**——否则「诊断说第 8、
 * 实际排第 5」就是新的两把尺子（手写判据已在 v0.17 吃过一次亏）。同分兜底漏一条，
 * 并列时名次就会错位，而并列在本库并不罕见（长条目多点命中常打出同分）。
 */
function compareScored(a: ScoredEntry, b: ScoredEntry): number {
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
}

/**
 * recall 主入口：过滤 → 打分 → 排序 → 截断 → 联想（为结果附加相关链）。
 * @param entries - 候选条目（通常为当前 scope 与 global 合并后的全量）
 * @param query - 检索条件（全字段可选；query 文本为空时按新鲜度排序）
 * @returns { results, total }；total 为过滤后截断前的命中数
 */
export function recallEntries(entries: Entry[], query: RecallQuery = {}): RecallResult {
  const filtered = filterEntries(entries, query)
  // 打分参数（2026-10-27）：生产调用不传 ⇒ 全部回退默认值，行为与不参数化时逐位一致
  const tuning = resolveTuning(query.tuning)
  // v0.7：给了上下文重心就按权重打分；否则退回原路径（query 字符串 + 等权词项）
  const weighted = query.weightedTerms !== undefined && query.weightedTerms.length > 0
    ? query.weightedTerms
    : undefined
  const tokens = tokenizeQuery(query.query, query.tuning)
  const hasQuery = weighted !== undefined || tokens.length > 0
  // v0.9：IDF 表——罕见词（特征词）权重高、高频泛词权重低。
  // 在**过滤后**的候选集上算 DF（比较基准就是本次检索范围）。
  const idfTokens = weighted !== undefined ? weighted.map((item) => item.term) : tokens
  const idf = hasQuery ? buildIdf(filtered, idfTokens, tuning.genericFactor) : new Map<string, number>()
  // v0.12：被泛词门置 0 的词项。idfOf 恒 > 0（log(1+N/(1+df))），故 idf===0 ⟺ 泛词门命中。
  // 用途：把「真的没有相关记忆」与「查询词过泛被抑制」分开（仅结果为空时上报）。
  const suppressedTerms = hasQuery
    ? [...new Set(idfTokens.map((t) => t.toLowerCase()).filter((t) => idf.get(t) === 0))]
    : []
  // v0.17：候选集正文平均长度（BM25 长度归一化的基准）。与 IDF 同域——在**过滤后**的
  // 候选集上算，比较基准即本次检索范围（不用全库均值，否则跨 scope 检索会失真）。
  const avgBodyLen = filtered.length > 0
    ? filtered.reduce((sum, entry) => sum + entry.body.length, 0) / filtered.length
    : 0
  let scored = filtered.map((entry) => ({
    entry,
    score: weighted !== undefined
      ? scoreEntryWeighted(entry, weighted, idf, avgBodyLen, tuning, query.entityMatches)
      : scoreEntry(entry, tokens, idf, avgBodyLen, tuning, query.entityMatches),
  }))
  // 带查询时剔除零分条目（无关内容不进结果）；无查询词时全量按新鲜度排序
  if (hasQuery) scored = scored.filter(({ score }) => score > 0)
  scored.sort(compareScored)
  // v0.17 相对分数门槛：只保留 `score ≥ topScore × RECALL_RELATIVE_FLOOR`。
  // 施加位置有讲究：**排序之后**（要先知道 topScore）、**截断之前**（limit 只负责显示条数，
  // 不负责相关性过滤——旧实现里它是唯一的"减法"，于是 190 条全算命中）。
  // ⚠ 语义变化：`total` 从此报「过门槛的相关条目数」而非「有分条目数」。
  // 旧口径会把「只因一个 bigram 偶然命中」的条算成命中，对读者是误导。
  if (hasQuery && scored.length > 1 && tuning.relativeFloor > 0) {
    // `scored[0]` 在 noUncheckedIndexedAccess 下是 `T | undefined`（长度已判 >1，用可选链收口）
    const top = scored[0]?.score ?? 0
    if (top > 0) {
      const floor = top * tuning.relativeFloor
      scored = scored.filter(({ score }) => score >= floor)
    }
  }
  const limit = query.limit === undefined ? DEFAULT_RECALL_LIMIT : Math.max(0, Math.floor(query.limit))
  const includeArchive = query.includeArchive ?? false
  // 联想层开关（2026-10-13）：缺省 true 保持原行为；false 时**完全跳过** relatedOf
  // ——它是 O(结果数 × 全库) 的，实测 20 条结果 500–640 ms，而 auto-recall 不消费它。
  const withRelated = query.withRelated ?? true
  // 家族折叠（v0.16.0 · 论文 Memory Echo 的 Family 组件）：**缺省关**。
  // 开启时把候选池内的「概要 + 其 archiveRef 原料」压成**每族一位**（族内得分最高者为代表）。
  // ⚠ 语义边界：折叠只影响**本次占位**，不改 `total`（命中总数不变），也不动数据；
  //   未占位的同族条目仍可经 includeArchive 取回（论文 §5.1：source grouping does not delete）。
  // 为什么默认关：论文自证 Family 单独上线 0.825 → 0.651（≈ −33 题）。
  const collapsed = query.collapseFamily === true ? collapseFamilies(scored) : undefined
  const serving = collapsed === undefined ? scored : collapsed.kept
  const results = serving.slice(0, limit).map(({ entry, score }) => {
    const item = toResultItem(entry, score)
    // 联想层：每个命中条目附相关链（仅在结果项上附加，不改变 total 语义）
    if (withRelated) item.related = relatedOf(entries, entry, 3, includeArchive)
    return item
  })
  const titleOf = new Map(entries.map((entry) => [entry.id, entry.title]))
  const familyNote = collapsed === undefined
    ? undefined
    : renderFamilyNote(collapsed.families, (id) => titleOf.get(id) ?? id)
  return {
    results,
    total: scored.length,
    // v0.16：仅在真发生折叠时出现（无折叠不打噪声，信噪比纪律同 groundingTag/stalenessTag）
    ...(familyNote !== undefined ? { familyNote } : {}),
    // v0.12：仅在「结果为空且确因泛词门」时上报——有结果时不加噪声
    ...(scored.length === 0 && suppressedTerms.length > 0 ? { suppressedTerms } : {}),
  }
}

/**
 * 打分分解（v0.32 · 诊断视图）：逐条目返回「哪些词项、在哪个字段、各贡献多少」。
 *
 * **为什么必须与生产路径同源**：分解若另写一套打分，它会解释一个**不存在的排序**——
 * v0.17 的教训正是「没做分解就动刀」（长度归一 out-of-sample 差 5.7 个百分点，见 `BM25_B`）。
 * 因此本函数复用 `filterEntries` / `buildIdf` / `scoreEntry(Weighted)` / `compareScored`，
 * 只往打分里挂收集器，**不复制任何判据**（A150：各项贡献之和 == score）。
 *
 * 与 `recallEntries` 只有两处刻意差异，都不改分数与名次：
 * ① 不做相对分数门槛与 `limit` 截断——诊断要看「真金标排第 8」这种被 top5 挡住的事实；
 * ② 不附联想链（`related`）与家族折叠（两者都不参与打分）。
 *
 * @param entries - 候选条目（必须是 recall 的同一个池子，否则名次不可比）
 * @param query - 与 recall 相同的查询条件（`tuning` 一并生效）
 * @returns 按分数降序的分解（带查询时零分条目同样不返回）
 */
export function explainRecall(entries: Entry[], query: RecallQuery = {}): ScoreExplanation[] {
  const filtered = filterEntries(entries, query)
  const tuning = resolveTuning(query.tuning)
  const weighted = query.weightedTerms !== undefined && query.weightedTerms.length > 0
    ? query.weightedTerms
    : undefined
  const tokens = tokenizeQuery(query.query, query.tuning)
  const hasQuery = weighted !== undefined || tokens.length > 0
  const idfTokens = weighted !== undefined ? weighted.map((item) => item.term) : tokens
  const idf = hasQuery ? buildIdf(filtered, idfTokens, tuning.genericFactor) : new Map<string, number>()
  const avgBodyLen = filtered.length > 0
    ? filtered.reduce((sum, entry) => sum + entry.body.length, 0) / filtered.length
    : 0
  const scored: ScoredEntry[] = filtered.map((entry) => {
    const terms: ScoreTermBreakdown[] = []
    const score = weighted !== undefined
      ? scoreEntryWeighted(entry, weighted, idf, avgBodyLen, tuning, query.entityMatches, terms)
      : scoreEntry(entry, tokens, idf, avgBodyLen, tuning, query.entityMatches, terms)
    return { entry, score, terms }
  })
  // 与 recallEntries 同一口径：带查询时零分条目不算候选
  const kept = hasQuery ? scored.filter((item) => item.score > 0) : scored
  kept.sort(compareScored)
  return kept.map(({ entry, score, terms }) => ({
    id: entry.id,
    title: entry.title,
    bodyLength: entry.body.length,
    score,
    terms: terms ?? [],
  }))
}

/**
 * 标签匹配语义（v0.20 · 2026-11-04）：**包含**，不是精确相等。
 *
 * 为什么改：打分路径（`scoreEntry`）一直是 `tag.includes(token)`，而过滤路径
 * 曾经是 `entry.tags.includes(tag)`（精确相等）——同一份 tag 数据两套口径。
 * 实测代价（活跃 1418 条）：「技能」df/N=26.5% 触发泛词门 ⇒ 该词 idf 归零 ⇒
 * 自由文本搜它是 0 条；唯一入口是 tags 过滤，而它只认 `技能` 不认
 * `技能维护`/`技能熔炉` 等 39 条变体 ⇒ 双重失效，条目搜不到也不报错。
 * 改为包含后，29 个主干概念的 782 条变体条目自动被覆盖（不必逐条回补 tag）。
 *
 * 方向性（刻意）：查 `技能维护` 仍只命中含该串的 tag，**不会**反向扩大到所有
 * `技能`——粒度由调用方给的词决定，不由数据决定。
 * 空串保护：`wanted` 为空时不匹配任何东西（否则 `includes('')` 恒真，一次
 * 误传空数组元素就会让过滤形同虚设）。
 */
function tagMatches(entryTag: string, wanted: string): boolean {
  return entryTag === wanted || (wanted.length > 0 && entryTag.includes(wanted))
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
  const memTypes = query.memType
  const spaces = query.space
  const statuses = query.status
  const wantsArchived = statuses !== undefined
    && statuses.some((state) => state === 'archived' || state === 'deleted')
  return entries.filter((entry) => {
    if (kinds !== undefined && kinds.length > 0 && !kinds.includes(entry.kind)) return false
    if (tags !== undefined && tags.length > 0 && !tags.every((tag) => entry.tags.some((et) => tagMatches(et, tag)))) return false
    // 内容分类（v0.26.0）：未分类条目在任何取值下都不返回——它的类型是「不知道」
    if (memTypes !== undefined && memTypes.length > 0) {
      const type = entry.memType
      if (type === undefined || !(memTypes as readonly string[]).includes(type)) return false
    }
    // 空间归属（v0.27.0）：未标注条目在任何取值下都不返回（同 memType 纪律）
    if (spaces !== undefined && spaces.length > 0) {
      const space = entry.space
      if (space === undefined || !(spaces as readonly string[]).includes(space)) return false
    }
    // 生命周期（v0.27.0）：取值是派生读法（lifecycleOf），不是存储字段直读。
    // ⚠ 位置在 includeArchive 判断之前：否则要查 archived / deleted 时永远被下面那行先剔掉。
    if (statuses !== undefined && statuses.length > 0 && !statuses.includes(lifecycleOf(entry))) return false
    // 归档剔除（v0.27.0 起带一个例外）：显式按 `archived` / `deleted` 过滤时**自动放行**，
    // 否则「查已删除的条目」这条最基本的用法要先记得传 includeArchive —— 猜不到就查不到。
    if (!query.includeArchive && !wantsArchived && entry.archived) return false
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
export function tokenizeQuery(query: string | undefined, tuning?: RecallTuning): string[] {
  if (query === undefined) return []
  const raw = query.toLowerCase().split(/\s+/).filter((token) => token.length > 0 && !STOP_WORDS.has(token))
  const tokens: string[] = []
  const dropLongCjk = tuning?.longToken === 'drop'
  for (const token of raw) {
    // 中文长段（≥5 字）的整词 token 只在「某条文档引用过这句话」时命中——那是抄袭检测的
    // 信号，不是相关性。v0.32 实测：查「压缩之后怎么恢复上下文」时它 df=1 / idf 6.79，
    // 竟是该查询的**最高分项**，把一条引用了这句查询的记忆推到第 1 名。
    // `longToken='drop'` 只剔除整词，**不影响下面照常展开它的 2-gram**。
    if (!(dropLongCjk && /^[\u4e00-\u9fff]{5,}$/.test(token))) tokens.push(token) // 保留原词（英文词 / 精确短语）
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
/**
 * BM25 文档长度归一化（k1=1.2，b=0.75 为通行缺省）。
 *
 * **为什么需要（2026-10-27 基线实测）**：旧实现对正文命中给固定 `+1 × IDF`，**与正文长度无关**，
 * 而长正文命中概率天然更高（覆盖更多 bigram）⇒ 长条目系统性占优。
 * 全库读数：正文长度 **中位 1203 / 均值 2159 / 最大 83885**，**19 条**超 2 万字符。
 * 直接后果：查「读过不代表改进」时那个 10 万字符的 checkpoint 容器（`5501b489`）挤进前 4；
 * 查「compaction-sink」时 6 条无关条目因正文偶然含该词而**同分并列**（全部 `5.060218`）。
 *
 * **性质**：`bodyLen === avgBodyLen` 时系数**恰好为 1**（分母 = 1 + k1×(1−b+b) = 1 + k1，分子 = k1+1）
 * ⇒ 不改动"典型长度条目"的相对地位，只压长条目、略微抬短条目。
 * 实测比值：短(0.5×均值) **1.257** / 典型 **1.0** / 长(10×均值) **0.214** ⇒ 长短比约 **5.9 倍**。
 *
 * @param bodyLen - 该条目正文长度
 * @param avgBodyLen - 本次候选集的正文平均长度；≤0 时退化为 1（不归一化，保护空集/夹具）
 */
const BM25_K1 = 1.2
/**
 * 长度归一权重。**v0.18（2026-10-27）从 0.75 降到 0 = 关掉**。理由是可复现的实测，不是口味：
 *
 * ① `tune` 侧 269 case：关掉后 top1 59.1% → **63.2%**，配对 13:2，p=0.010；
 * ② `holdout` 侧 264 case（**唯一一次**，留痕 `holdout-runs.jsonl` 第 1 行）：
 *    55.3% → **61.0%**，配对 **18:3、z=+3.055、p=0.002、+5.7 个百分点** ⇒ 样本外复现且更强；
 * ③ 分区读数说出机制：归一的**收益区（答案比竞争者短）实测 0:0、逐 case 全同**，
 *    代价区（答案比竞争者长 40%+）**−11.7 个百分点、7:0 全变差** ——
 *    它该帮的地方一分没帮，该害的地方害了 11.7 个点。
 *
 * 为什么它本来就不该帮：这个打分器的正文项权重是 1，标签/别名是 3、标题是 2。
 * 长条目若真霸榜，靠的是**多处命中**（那是相关性），归一只压正文项 ⇒ 压不动真正的霸榜机制，
 * 只惩罚「正文长得正常但话题对」的条目。v0.17 加它时的诊断（「长条目霸榜」）是**观察**，
 * 不是分数分解——今天第一次做了分解。
 *
 * ⚠ 保留参数（而不是删掉归一逻辑）：它仍可被 `tuning.b` 打开做对照实验。
 *   但默认 0 意味着**行为上等价于 v0.16**——这是有意的回退，不是遗漏。
 */
const BM25_B = 0

/** 已解析的打分参数（默认值 + 调用方覆盖） */
interface ResolvedTuning {
  k1: number
  b: number
  relativeFloor: number
  /** 中文长段整词 token 策略（v0.32）；`keep` = 现行行为 */
  longToken: 'keep' | 'drop'
  /** 单 token 多字段封顶（v0.32）；`false` = 现行行为 */
  multiFieldCap: boolean
  /** 泛词门生效值系数（v0.32）；`0` = 归零（v0.9 行为） */
  genericFactor: number
}

/**
 * 解析打分参数（2026-10-27 参数化，供 `tests/recall-eval/` 扫参与消融）。
 *
 * ⚠ 必须用 `??` 不能用 `||`：`k1=0` / `b=0` / `relativeFloor=0` 都是**合法且有意义的取值**
 * （= 关掉该项）。用 `||` 会把 0 当作「没给」而静默回退默认值 ⇒ 消融臂变成假读数，
 * 而且看不出来（「关了」与「没关」跑出同一个数）。
 */
function resolveTuning(tuning?: RecallTuning): ResolvedTuning {
  return {
    k1: tuning?.k1 ?? BM25_K1,
    b: tuning?.b ?? BM25_B,
    relativeFloor: tuning?.relativeFloor ?? RECALL_RELATIVE_FLOOR,
    longToken: tuning?.longToken ?? 'keep',
    multiFieldCap: tuning?.multiFieldCap ?? false,
    genericFactor: tuning?.genericFactor ?? 0,
  }
}

/**
 * 分解收集器写入（v0.32 · 零分配纪律）：`collect === undefined` 时**不构造对象**。
 *
 * 为什么不做成 `collect?.push({...})`：参数是对象字面量，即使 `collect` 为 undefined
 * 它也会被求值构造 —— 而 `scoreEntry` 是热路径（每次 recall 要跑「候选数 × 词项数」遍）。
 * 插桩不得让生产路径产生任何临时对象。
 */
function addTerm(
  collect: ScoreTermBreakdown[] | undefined,
  term: string,
  idf: number,
  weight: number,
  field: ScoreTermBreakdown['field'],
  contribution: number,
): void {
  if (collect !== undefined) collect.push({ term, idf, weight, field, contribution })
}

/**
 * 单 token 多字段封顶（v0.32 · `tuning.multiFieldCap`）：返回该词项最终计入的分数。
 *
 * 未开启时原样返回（缺省行为逐位不变）。开启时封顶在 `SCORE_TAG × IDF`（最高单档），
 * 并把超额部分记成一条 `field:'cap'` 的**负贡献** —— 这样分解求和仍等于总分（A150），
 * 且「这个词被削掉了多少」在诊断里看得见。
 */
function applyCap(
  tokenScore: number,
  capValue: number,
  tuning: ResolvedTuning,
  collect: ScoreTermBreakdown[] | undefined,
  term: string,
  idf: number,
  weight: number,
): number {
  if (!tuning.multiFieldCap || tokenScore <= capValue) return tokenScore
  addTerm(collect, term, idf, weight, 'cap', capValue - tokenScore)
  return capValue
}

function bodyLengthNorm(bodyLen: number, avgBodyLen: number, tuning: ResolvedTuning): number {
  if (avgBodyLen <= 0) return 1
  const denom = 1 + tuning.k1 * (1 - tuning.b + tuning.b * (bodyLen / avgBodyLen))
  return (tuning.k1 + 1) / denom
}

/**
 * 打分：逐词累加——标签/别名子串命中 +3，标题 +2，正文 +1×长度归一化，**再乘该词的 IDF**。
 *
 * v0.17（2026-10-27）：正文项乘 `bodyLengthNorm`（BM25 长度归一）——治长条目霸榜。
 * @param entry - 候选条目
 * @param tokens - 查询词项（小写）
 * @param idf - token → IDF；缺项回退 1（等权，与原行为一致，避免静默变差）
 * @param avgBodyLen - 候选集正文平均长度（用于 BM25 归一化）
 */
function scoreEntry(entry: Entry, tokens: string[], idf: ReadonlyMap<string, number>, avgBodyLen: number, tuning: ResolvedTuning, entityMatches?: readonly RecallEntityMatch[], collect?: ScoreTermBreakdown[]): number {
  if (tokens.length === 0) return 0
  const view = lowerOf(entry)
  const lenNorm = bodyLengthNorm(view.body.length, avgBodyLen, tuning)
  let score = 0
  for (const token of tokens) {
    const w = idf.get(token) ?? 1
    // aliases 与 tags 同级（×3，2026-10-13 重做）：二者都是「人工给的检索入口」，
    // 而标题/正文是「内容本身」——入口的意图明确性高于内容偶然的用词。
    const hitAlias = view.aliases.some((alias) => alias.includes(token))
    const hitTag = view.tags.some((tag) => tag.includes(token))
    const hitTitle = view.title.includes(token)
    const hitBody = view.body.includes(token)
    if (hitAlias) addTerm(collect, token, w, 1, 'alias', SCORE_TAG * w)
    if (hitTag) addTerm(collect, token, w, 1, 'tag', SCORE_TAG * w)
    if (hitTitle) addTerm(collect, token, w, 1, 'title', SCORE_TITLE * w)
    if (hitBody) addTerm(collect, token, w, 1, 'body', SCORE_BODY * w * lenNorm)
    if (tuning.multiFieldCap) {
      // 封顶路径：先算出该词项的总贡献，再由 `applyCap` 决定计入多少（可能削掉超额）。
      const tokenScore = (hitAlias ? SCORE_TAG * w : 0)
        + (hitTag ? SCORE_TAG * w : 0)
        + (hitTitle ? SCORE_TITLE * w : 0)
        + (hitBody ? SCORE_BODY * w * lenNorm : 0)
      score += applyCap(tokenScore, SCORE_TAG * w, tuning, collect, token, w, 1)
    } else {
      // 缺省路径：逐项直接累进 score —— 浮点加法顺序与 v0.31 完全相同（零行为变化）。
      if (hitAlias) score += SCORE_TAG * w
      if (hitTag) score += SCORE_TAG * w
      if (hitTitle) score += SCORE_TITLE * w
      if (hitBody) score += SCORE_BODY * w * lenNorm
    }
  }
  return score + entityBonus(entry, view, entityMatches, collect)
}

/**
 * 加权打分（v0.7 上下文重心 + v0.9 IDF + v0.17 长度归一）：逐词累加
 * `IDF × 重心权重 × (标签 3 / 标题 2 / 正文 1×lenNorm)`。
 * 与 `scoreEntry` 同构，只是词项带重心权重——这样「话题重心」比「最后一个词」更有话语权。
 */
function scoreEntryWeighted(entry: Entry, terms: readonly WeightedTerm[], idf: ReadonlyMap<string, number>, avgBodyLen: number, tuning: ResolvedTuning, entityMatches?: readonly RecallEntityMatch[], collect?: ScoreTermBreakdown[]): number {
  if (terms.length === 0) return 0
  const view = lowerOf(entry)
  const lenNorm = bodyLengthNorm(view.body.length, avgBodyLen, tuning)
  let score = 0
  for (const { term, weight } of terms) {
    const token = term.toLowerCase()
    // 分解里 `idf` 记基值、`weight` 记重心权重，两者相乘才是实际系数——分开记才能看清
    // 「是这个词罕见」还是「是这个词在重心上」在起作用。
    const base = idf.get(token) ?? 1
    const w = base * weight
    const hitAlias = view.aliases.some((alias) => alias.includes(token))
    const hitTag = view.tags.some((tag) => tag.includes(token))
    const hitTitle = view.title.includes(token)
    const hitBody = view.body.includes(token)
    if (hitAlias) addTerm(collect, token, base, weight, 'alias', SCORE_TAG * w)
    if (hitTag) addTerm(collect, token, base, weight, 'tag', SCORE_TAG * w)
    if (hitTitle) addTerm(collect, token, base, weight, 'title', SCORE_TITLE * w)
    if (hitBody) addTerm(collect, token, base, weight, 'body', SCORE_BODY * w * lenNorm)
    // 本路径末尾有 `Math.round(…×1000)/1000`，词项级重排的浮点差被它吸收
    // ⇒ 这里可以单路径累加（不需要为保真复制两份累加顺序）。
    const tokenScore = (hitAlias ? SCORE_TAG * w : 0)
      + (hitTag ? SCORE_TAG * w : 0)
      + (hitTitle ? SCORE_TITLE * w : 0)
      + (hitBody ? SCORE_BODY * w * lenNorm : 0)
    score += applyCap(tokenScore, SCORE_TAG * w, tuning, collect, token, base, weight)
  }
  // ⚠ 这里的 round 是本函数既有行为（v0.7 起）。后果：分解各项之和与 score 存在
  // **< 1e-3 的舍入差**，A150 的判据在加权路径按容差判、普通路径按逐位相等判。
  return Math.round((score + entityBonus(entry, view, entityMatches, collect)) * 1000) / 1000
}

/** 结果项组装：概要字段 + score + 层级标注（level 原样透出，标注文案由工具层给模型） */
function toResultItem(entry: Entry, score: number): RecallResultItem {
  // 归档因果归一（v0.21.0）：读一次、下面透出两格（存量条目要走 source.reason 回退，
  // 重复调用会让「归一口径」出现两个调用点）。
  const archival = archivalOf(entry)
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
    // 主体层（v0.13.0）—— **新增字段必须贯穿投影层**：这里是 recall / memory_browse
    // 共用的唯一投影点，漏一行就会出现「过滤生效了（total 对）但结果项里没有该字段
    // ⇒ 渲染层打不出标记」。本次实测就是这样被 subject.test.mjs 的 A88/A88c 抓住的。
    ...(entry.subject !== undefined ? { subject: entry.subject } : {}),
    // 内容分类（v0.26.0）——**同一投影点、同一教训**（第六次在同一位置补字段）。
    ...(entry.memType !== undefined ? { memType: entry.memType } : {}),
    // 空间归属（v0.27.0）——**同一投影点、同一教训**（第七次）。
    ...(entry.space !== undefined ? { space: entry.space } : {}),
    // 生命周期（v0.27.0）——**派生值**而非原始字段：六态由 lifecycleOf 统一判定，
    // 结果项透出判定结果（渲染层直接打标记，不再各自重算一遍）。
    lifecycle: lifecycleOf(entry),
    // 执行位置（v0.23.0）——**同一投影点、同一教训**（v0.13/v0.14/v0.15/v0.21 连续四版
    // 都栽在漏这一行：过滤生效了、total 对，但结果项里没有该字段 ⇒ 渲染层打不出标记）。
    // ⚠ 两级不拆：taskId 只在 project 存在时透出——无项目的任务 id 透出去会被读成
    // 「某个叫 ps-4a2b 的项目」，是**错误信息**而非缺信息。
    ...(entry.project !== undefined ? { project: entry.project } : {}),
    ...(entry.project !== undefined && entry.taskId !== undefined ? { taskId: entry.taskId } : {}),
    // 约定状态（v0.14.0）——**同一投影点、同一教训**：上一版（v0.13.0 subject）就是漏了
    // 这里，导致「过滤生效（total 对）但结果项没有该字段 ⇒ 渲染打不出标记」。
    // 这次一次补上。⇒ 判据：任何新字段加进 Entry，先来这里看一眼。
    ...(entry.grounding !== undefined ? { grounding: entry.grounding } : {}),
    // 时效维（v0.15.0）——**同一投影点、同一教训**（v0.13/v0.14 连续两版都栽在漏这里：
    // 过滤生效了、total 对，但结果项里没有该字段 ⇒ 渲染层打不出标记）。
    // ⚠ 这里只**透出原始值**，不预存档位：档位取决于「读取时刻」，存进结果项就会与它脱钩
    // （今天算出的「3 天后」明天成了假读数）。档位由工具层按 now 现算。
    ...(entry.reviewAfter !== undefined ? { reviewAfter: entry.reviewAfter } : {}),
    ...(entry.watchFor !== undefined ? { watchFor: entry.watchFor } : {}),
    ...(entry.cue !== undefined ? { cue: entry.cue } : {}),
    // 事实生命周期维（v0.24.0）——**同一投影点、同一教训**（v0.13/v0.14/v0.15/v0.21 连续四版
    // 都栽在漏这一行：过滤生效了、total 对，但结果项里没有该字段 ⇒ 渲染层打不出标记）。
    // ⚠ 三个字段都**原样透出**，不在这里判定「是否过时」：字段存在即已替代
    // （判据住 `succession.ts::isSuperseded`），渲染层只负责把它印出来。
    ...(entry.validAfter !== undefined ? { validAfter: entry.validAfter } : {}),
    ...(entry.supersededBy !== undefined ? { supersededBy: entry.supersededBy } : {}),
    ...(entry.supersedes !== undefined ? { supersedes: entry.supersedes } : {}),
    // 来源类型（v0.21.0）——**同一投影点、同一教训**（v0.13/v0.14/v0.15 连续三版都栽在漏这里）。
    ...(entry.provenance !== undefined ? { provenance: entry.provenance } : {}),
    // 证据引用（v0.25.0）——**同一投影点、同一教训**（这是第五次在同一个位置补字段）。
    // ⚠ 判据：任何新字段加进 Entry，先来这里看一眼再跑测试。
    ...(entry.evidenceRefs !== undefined && entry.evidenceRefs.length > 0
      ? { evidenceRefs: entry.evidenceRefs }
      : {}),
    // 归档因果（v0.21.0）：只对**已归档**条目出现。经 `archivalOf` 归一而不是直取存储字段
    // ——存量 1260 条的归档原因还在 `source.reason` 里（零迁移方案，理由见 archive.ts 决定 1），
    // 不归一就会出现「老条目查不到为什么没了」。
    // ⚠ 透出的是**两个平级标量**，不是嵌套对象：存储层就是平的，且 schema DSL 的 required
    // 只支持字段级（嵌套对象归一化后会被改形 ⇒ A118 红 + 泛型推断退化）。
    ...(archival !== undefined ? { archivedReasonType: archival.reasonType } : {}),
    ...(archival?.reason !== undefined ? { archivedReason: archival.reason } : {}),
    // 转述型·无出处（2026-11-03 · lh-d5e409bf；v0.21.0 起由 provenance 接管）——
    // **同一投影点、同一教训**（v0.13/v0.14/v0.15 连续三版都栽在漏这一行）。
    // 判据在 origin.ts（纯函数，单测直接测）；这里只**透出布尔**，文案归渲染层。
    // 只在该值为 true 时出现：false 与「未判定」在结果里同形，但两者对读者是同一件事（不需要看见）。
    ...(transcriptiveFlagOf(entry) ? { transcriptiveUncited: true } : {}),
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
  const wantsArchived = query.status !== undefined
    && query.status.some((state) => state === 'archived' || state === 'deleted')
  const filtered = entries.filter((entry) => {
    if (query.kind !== undefined && query.kind.length > 0 && !query.kind.includes(entry.kind)) return false
    if (query.tags !== undefined && query.tags.length > 0 && !query.tags.every((tag) => entry.tags.some((et) => tagMatches(et, tag)))) return false
    // 空间 / 生命周期（v0.27.0）：未标注空间不匹配任何取值；六态走派生读法。
    if (query.space !== undefined && query.space.length > 0) {
      const space = entry.space
      if (space === undefined || !query.space.includes(space)) return false
    }
    if (query.status !== undefined && query.status.length > 0 && !query.status.includes(lifecycleOf(entry))) return false
    if (query.includeArchive !== true && !wantsArchived && entry.archived) return false
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

