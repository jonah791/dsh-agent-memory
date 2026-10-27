/**
 * 检索评测的共享底座（零人工标注评测集 · 2026-10-27 建，同日重修一次）
 *
 * ## 为什么需要它（主人 2026-10-27「有没有办法可以让算法自进化」）
 *
 * 参数可以自优化，**判据不能自进化**——自指闭环会塌。所以要一个**外生**的评测集：
 * 不来自我的判断，来自记忆库里客观存在的标识符。
 *
 * ## ★ 第一版设计失败（这段比代码重要，别删）
 *
 * 第一版：抽「全库只出现过一次」的独特标识符（**单 token，df===1**）当查询，
 * 正确答案 = 那条唯一含它的条目。看起来零标注、答案客观唯一——**实测 top1 = 100.0%、
 * 615/615 全对、噪音恰好 1.00 条，全类型全侧满分**。
 *
 * 为什么满分不是好消息：df===1 ⇒ 只有目标条目 `body.includes(token)` 为真 ⇒ 只有它有分
 * ⇒ 被 `filter(score > 0)` 之后结果恰好 1 条。**任何能匹配子串的检索器都会得 100%**。
 * 这个尺子测不出「排序好不好」，只测出「能不能匹配子串」——**恒为满分的判据不是判据**
 * （与「恒为空的输出不是证据」同形）。
 *
 * ## 现在的设计：查询由**多个 token** 组成，正确答案 = 唯一同时含全部 token 的条目
 *
 * 关键差别：查询里**至少一个稀有 token**（只会引入 ≤3 个候选）+ **至少一个常见 token**
 * （会引入十几个候选）。⇒ 多个条目都能得到分，**排序与长度归一才真正被考到**：
 *   - 「命中 2/3 个词但正文很短」的条目会不会靠长度归一压过「命中 3/3 但正文很长」的目标？
 *   - 相对分门槛会不会把本该排第二的相关条目砍掉？
 * 这两条正是 v0.17 改的东西，也正好是**会被误判的真难点**。
 *
 * ⚠ 边界（写清楚才不算夸大）：
 *   - 它测「**能不能把那条同时提到这几个词的记忆排第一**」，不测「排第一的是否最有用」。
 *     后者要人来判，本底座结构上测不了 ⇒ 它是**下限**判据，不是上限。
 *   - df 全小（稀有 token 主导）⇒ 对**泛词门**不敏感。泛词门的问题用真实宽查询单独测。
 */

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

/** 记忆库默认位置（可用环境变量覆盖，便于跨语料复算） */
export const DEFAULT_DB = process.env.MEMORY_DB ?? 'E:/alice/.dsh/storages/agent_memory.json'

/** 编译产物（评测跑的是**线上同一份** lib/search.js，不另抄一份打分逻辑） */
const SEARCH_URL = new URL('../../lib/search.js', import.meta.url).href

/**
 * 递归收集条目（存储文件是嵌套结构，形状随配置变；walk 比写死路径稳）。
 * @param {string} dbPath
 * @returns {Array<object>}
 */
export function loadCorpus(dbPath = DEFAULT_DB) {
  const raw = JSON.parse(readFileSync(dbPath, 'utf8'))
  const entries = []
  const seen = new Set()
  const walk = (o) => {
    if (Array.isArray(o)) {
      for (const v of o) walk(v)
      return
    }
    if (!o || typeof o !== 'object') return
    if (typeof o.id === 'string' && typeof o.title === 'string' && typeof o.body === 'string' && !seen.has(o.id)) {
      seen.add(o.id)
      entries.push({
        id: o.id,
        kind: o.kind ?? 'knowledge',
        title: o.title,
        body: o.body,
        tags: Array.isArray(o.tags) ? o.tags : [],
        aliases: Array.isArray(o.aliases) ? o.aliases : [],
        cue: Array.isArray(o.cue) ? o.cue : [],
        scope: o.scope ?? 'e:/alice',
        createdAt: o.createdAt ?? '2026-01-01T00:00:00.000Z',
        updatedAt: o.updatedAt ?? o.createdAt ?? '2026-01-01T00:00:00.000Z',
        accessedAt: o.accessedAt ?? o.updatedAt ?? o.createdAt ?? '2026-01-01T00:00:00.000Z',
        archived: o.archived === true,
        level: o.level ?? null,
        bucket: o.bucket ?? null,
      })
    }
    for (const v of Object.values(o)) walk(v)
  }
  walk(raw)
  return entries
}

/** 动态引入编译产物（不复制打分逻辑：单一真源） */
export async function loadSearch() {
  return import(SEARCH_URL)
}

/**
 * 候选标识符的抽取规则。每条规则一个名字（写进案例，便于按类型看读数——
 * 「哪种查询形态退化」比「总体退化了」有行动性）。
 */
const EXTRACTORS = [
  { name: 'arxiv', re: /arXiv:\s?(\d{4}\.\d{4,5})(?:v\d+)?/gi, take: 1, minLen: 9 },
  { name: 'kebab', re: /\b([a-z][a-z0-9]{1,}(?:-[a-z0-9]{1,}){1,4})\b/g, take: 1, minLen: 8 },
  { name: 'snake', re: /\b([a-z][a-z0-9]*(?:_[a-z0-9]+){1,4})\b/g, take: 1, minLen: 8 },
  { name: 'camel', re: /\b([a-z][a-z0-9]*(?:[A-Z][a-z0-9]+){1,3})\b/g, take: 1, minLen: 10 },
  {
    name: 'guid8',
    re: /\b([0-9a-f]{8})\b/g,
    take: 1,
    minLen: 8,
    filter: (s) => /[a-f]/.test(s),
  },
  { name: 'filename', re: /\b([\w.-]+\.(?:mjs|ts|js|ps1|py|json|ya?ml|md))\b/g, take: 1, minLen: 6 },
]

/** 太泛的公词（本来就不该当查询词；正则口径的 df 已能滤掉大多数，这里只挡明显的） */
const STOPWORDS = new Set([
  'e-2', 'x-1', 'a-1', 'i-o', 'utf-8', 'sha-256', 'sha-1', 'base-64',
  'readme-md', 'index-js', 'index-ts', 'package-json', 'node-js',
])

/** 每条条目抽出它自己的 token（确定性：正则顺序 + 首次出现顺序） */
function tokensOf(entry) {
  const text = `${entry.title}\n${entry.body}`
  const out = new Map() // lower → { token, type, count }
  for (const ex of EXTRACTORS) {
    ex.re.lastIndex = 0
    let m
    while ((m = ex.re.exec(text)) !== null) {
      const token = m[ex.take]
      if (!token || token.length < ex.minLen) continue
      if (ex.filter && !ex.filter(token)) continue
      const key = token.toLowerCase()
      if (STOPWORDS.has(key)) continue
      const rec = out.get(key) ?? { token, type: ex.name, count: 0 }
      rec.count += 1
      out.set(key, rec)
    }
  }
  return out
}

/** 全库裸串命中集（**与评测时的真实匹配口径一致**：`recallEntries` 用的是子串包含） */
function preciseOwners(texts, key, cap = 40) {
  const owners = []
  for (const t of texts) {
    if (t.text.includes(key)) {
      owners.push(t.id)
      if (owners.length >= cap) return owners // 远超「稀有」的定义，已经不可能当稀有词用
    }
  }
  return owners
}

/**
 * 竞争条目数 = 「含**至少一个**查询词」的条目数（找到 cap 个就停，不必数完）。
 *
 * 为什么这条判据关键：recall 是 **OR 累加**不是 AND ⇒ 这些条目**都会得分**，
 * 目标条目要在它们之中排第一，排序能力才被考到。
 * 若这个数是 1 ⇒ 只有一条有分 ⇒ 结果必然恰好 1 条 ⇒ top1 恒为 100%（第一版就是这样失效的）。
 */
function countCompetitors(texts, toks, cap = 6) {
  const keys = toks.map((t) => t.toLowerCase())
  let n = 0
  for (const t of texts) {
    if (keys.some((k) => t.text.includes(k))) {
      n += 1
      if (n >= cap) return n
    }
  }
  return n
}

/**
 * 生成评测案例（每条条目最多 1 个 case，答案 = 该条目）。
 *
 * 组合规则：1 个**稀有** token（精确命中集 ≤ 3）+ 1..2 个**常见** token（精确命中集 ≥ 全库中位）。
 * 这样查询会同时命中一批条目，只有目标条目命中**全部** token ⇒ 排序能力才被考到。
 *
 * @param {Array<object>} entries
 * @param {{maxTokens?: number, rarityMax?: number, verbose?: boolean}} opts
 * @returns {Array<{query: string, answerId: string, type: string, tokenCount: number, rareDf: number, commonDf: number}>}
 */
export function buildCases(entries, opts = {}) {
  const maxTokens = opts.maxTokens ?? 3
  const rarityMax = opts.rarityMax ?? 3
  const texts = entries.map((e) => ({ id: e.id, text: `${e.title}\n${e.body}`.toLowerCase() }))

  // 每条条目的 token 表 + 正则口径倒排（**只用于粗筛**，一次遍历建好，不做全库扫）
  const perEntry = new Map()
  const inverted = new Map() // key → Set(entryId)
  for (const e of entries) {
    const toks = tokensOf(e)
    perEntry.set(e.id, toks)
    for (const key of toks.keys()) {
      if (!inverted.has(key)) inverted.set(key, new Set())
      inverted.get(key).add(e.id)
    }
  }
  /** 正则口径 df —— 它是**裸串口径的下界**（正则抽到的必然裸串包含，反之不然） */
  const approxDf = (key) => inverted.get(key)?.size ?? 0

  /** 稀有词的精确命中集（多次复用，缓存） */
  const rareCache = new Map()
  const rareOwners = (key) => {
    if (!rareCache.has(key)) rareCache.set(key, preciseOwners(texts, key, rarityMax + 2))
    return rareCache.get(key)
  }
  /** 常见词的命中数（cap=200；报「200+」就够说明它常见，不必精确到个位） */
  const dfCache = new Map()
  const dfOf = (key) => {
    if (!dfCache.has(key)) dfCache.set(key, preciseOwners(texts, key, 200).length)
    return dfCache.get(key)
  }
  const byId = new Map(entries.map((e) => [e.id, e]))
  const lowerOf = new Map(entries.map((e) => [e.id, `${e.title}\n${e.body}`.toLowerCase()]))

  const cases = []
  let skippedNoRare = 0
  let skippedNotUnique = 0
  let skippedLonely = 0
  for (const e of entries) {
    const toks = [...perEntry.get(e.id).values()]
    if (toks.length < 2) {
      skippedNoRare += 1
      continue
    }
    // 稀有候选：先用**正则口径**（裸串口径的下界）粗筛，再精确核。
    // ⚠ 顺序反过来的话要对每个 token 都全库扫一遍（2455 条 × 每条 10~50 个 token），
    //   会把生成拖到分钟级以上——而粗筛安全：正则口径已超阈值 ⇒ 裸串只会更多，可直接排除。
    const rare = toks.filter((t) => {
      const key = t.token.toLowerCase()
      if (approxDf(key) > rarityMax) return false
      return rareOwners(key).length <= rarityMax
    })
    if (rare.length === 0) {
      skippedNoRare += 1
      continue
    }
    rare.sort((a, b) => (a.token < b.token ? -1 : 1))
    const picked = [rare[0]]
    const rareKey = picked[0].token.toLowerCase()
    // ⚠ 「含全部 token」⊆「含稀有 token」⇒ 只需在稀有命中集（≤ rarityMax 条）里核对，
    //   不必扫全库（扫全库会让生成慢到分钟级，且得不到更多信息）。
    const rareOwnersOfThis = rareOwners(rareKey)
    // 逐个补 token，每次补完都验「含全部已选 token 的条目仍然只有目标自己」；
    // 一旦不再唯一就停手——这样既加到了多 token，又保住了答案唯一性。
    for (const cand of toks) {
      if (picked.length >= maxTokens) break
      if (picked.some((p) => p.token.toLowerCase() === cand.token.toLowerCase())) continue
      const trial = [...picked, cand].map((p) => p.token.toLowerCase())
      const owners = rareOwnersOfThis.filter((id) => trial.every((t) => lowerOf.get(id).includes(t)))
      if (owners.length !== 1 || owners[0] !== e.id) continue
      picked.push(cand)
    }
    if (picked.length < 2) {
      skippedNotUnique += 1
      continue
    }
    const lastToken = picked[picked.length - 1].token.toLowerCase()
    // ★ 分辨力闸门：查询必须能让**不止一条**条目得分，否则排序不被考到。
    //   第一版漏了这道门（单词 + df===1 ⇒ 只有一条有分）⇒ 实测 615/615 全满分 = 零分辨力。
    const competitors = countCompetitors(texts, picked.map((p) => p.token))
    if (competitors < 2) {
      skippedLonely += 1
      continue
    }
    cases.push({
      query: picked.map((p) => p.token).join(' '),
      answerId: byId.get(e.id).id,
      type: picked[0].type,
      tokenCount: picked.length,
      rareDf: rareOwnersOfThis.length,
      commonDf: dfOf(lastToken),
      competitors,
    })
  }
  if (opts.verbose) {
    console.log(
      `  [生成] 无稀有词跳过 ${skippedNoRare} 条；组合不唯一跳过 ${skippedNotUnique} 条；` +
        `无竞争条目（只有它有分 ⇒ 送分题）跳过 ${skippedLonely} 条`,
    )
  }
  return cases
}

/**
 * 语料指纹：判断「落盘的评测集还对得上当前语料吗」。
 *
 * ⚠ 样本外纪律的承载（AGENTS.md §3.3）：评测集必须**冻结**。语料变了而评测集没重建
 *   ⇒ 读数就不再是同一把尺子量出来的，跨天比较全部失效。
 */
export function corpusFingerprint(entries) {
  const ids = entries.map((e) => e.id).sort()
  const h = createHash('sha256')
  h.update(String(entries.length))
  h.update('|')
  h.update(ids.join(','))
  return { count: entries.length, digest: h.digest('hex').slice(0, 16) }
}

/**
 * 确定性划分：同一个 id 永远落在同一侧（不随运行次数变）。
 *
 * ⚠ 调参集与留出集**必须分开，且留出集只跑一次**（AGENTS.md §3.3 样本外纪律）。
 */
export function splitOf(id) {
  return Number.parseInt(id.slice(0, 2), 16) % 2 === 0 ? 'tune' : 'holdout'
}
