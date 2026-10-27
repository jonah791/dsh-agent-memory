/**
 * 生成**零人工标注**的检索评测集（2026-10-27 建 · 主人「有没有办法可以让算法自进化」）
 *
 * 输出：`<DSH_HOME>/recall-eval/eval-set.json`
 * ⚠ 输出**不进公开仓**（含记忆库 token）：可复现性由「脚本 + 确定性规则」保证，
 *   不由数据文件保证——同一语料跑两次得到同一评测集（划分只依赖 id，不用随机源）。
 *
 * 用法：
 *   node tests/recall-eval/build-eval-set.mjs [--db=<路径>] [--out=<路径>] [--per-type=<N>] [--dry]
 *
 * 判据（做完了吗）：
 *   ① 落盘文件含 `corpus` 指纹（条目数 + id 集合摘要）
 *   ② 每个 case 的 `answerId` 必须是**唯一同时含全部查询词**的条目（独立实现复核，不只信生成器）
 *   ③ tune / holdout 两侧都有 case，且**按类型分层**
 *   ④ 打印分布读数——未行使的仪器等于没有仪器（measurable-optimization §三）
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { DEFAULT_DB, buildCases, corpusFingerprint, loadCorpus, splitOf } from './lib.mjs'

const DEFAULT_OUT = 'E:/alice/.dsh/recall-eval/eval-set.json'

/** 每类型每侧上限（防某一类型压倒其他类型） */
const PER_TYPE_PER_SPLIT = 40

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit === undefined ? fallback : hit.slice(name.length + 3)
}

const dbPath = arg('db', DEFAULT_DB)
const outPath = arg('out', DEFAULT_OUT)
const perType = Number(arg('per-type', String(PER_TYPE_PER_SPLIT)))
const dry = process.argv.includes('--dry')

const t0 = Date.now()
const entries = loadCorpus(dbPath)
if (entries.length === 0) {
  console.error(`语料为空：${dbPath} —— 「空」与「读不到」是两件事，先确认路径`)
  process.exit(2)
}
const fp = corpusFingerprint(entries)

const raw = buildCases(entries, { maxTokens: 3, verbose: true })

// 划分 + 分层采样（按 type×split，确定性：先按 query 字典序，再截断）
const withSplit = raw.map((c) => ({ ...c, split: splitOf(c.answerId) }))
const buckets = new Map()
for (const c of withSplit) {
  const k = `${c.type}|${c.split}`
  if (!buckets.has(k)) buckets.set(k, [])
  buckets.get(k).push(c)
}
const cases = []
for (const [k, list] of [...buckets.entries()].sort()) {
  list.sort((a, b) => (a.query < b.query ? -1 : a.query > b.query ? 1 : 0))
  for (const c of list.slice(0, perType)) cases.push(c)
}

// ---- 判据 ②③：独立实现复核（不复用 buildCases 的筛选逻辑，否则同源错误会一起通过）----
// 两个指标一次遍历算完：
//   ② 含**全部**查询词的条目必须恰好 1 条且为目标（答案唯一）
//   ③ 含**至少一个**查询词的条目必须 ≥ 2（有竞争者 ⇒ 排序能力真的被考到）
//      ⚠ ③ 是第一版（df===1 单词查询）缺失的闸门：那样只有一条有分，top1 恒 100%
const dupes = []
const lonely = []
for (const c of cases) {
  const toks = c.query.toLowerCase().split(/\s+/)
  let any = 0
  let all = 0
  for (const e of entries) {
    const t = `${e.title}\n${e.body}`.toLowerCase()
    const hit = toks.reduce((n, x) => n + (t.includes(x) ? 1 : 0), 0)
    if (hit > 0) any += 1
    if (hit === toks.length) all += 1
  }
  if (all !== 1) dupes.push({ query: c.query, all, answerId: c.answerId })
  if (any < 2) lonely.push({ query: c.query, any })
}
if (dupes.length > 0) {
  console.error(`✖ 自检失败：${dupes.length} 个 case 的答案不唯一 ⇒ 评测失效`)
  for (const d of dupes.slice(0, 5)) console.error('   ', JSON.stringify(d))
  process.exit(3)
}
if (lonely.length > 0) {
  console.error(`✖ 自检失败：${lonely.length} 个 case 没有任何竞争条目 ⇒ 送分题，无分辨力`)
  for (const d of lonely.slice(0, 5)) console.error('   ', JSON.stringify(d))
  process.exit(5)
}

// ---- 判据 ④：分布读数（缺了它，评测集是个黑箱）----
const tally = (arr, f) => arr.reduce((m, x) => ((m[f(x)] = (m[f(x)] ?? 0) + 1), m), {})
const bySplits = tally(cases, (c) => c.split)
if ((bySplits.tune ?? 0) === 0 || (bySplits.holdout ?? 0) === 0) {
  console.error('✖ 自检失败：某一侧为空 ⇒ 留出集验证做不了（样本外纪律要求两侧都有）')
  process.exit(4)
}

console.log('════ 评测集生成 ════')
console.log(`语料      : ${dbPath}`)
console.log(`条目数    : ${fp.count}（指纹 ${fp.digest}）`)
console.log(`可生成    : ${raw.length} 个 case（每条条目最多 1 个）`)
console.log(`入选 case : ${cases.length}（每类型每侧上限 ${perType}）`)
console.log(`按侧      : ${JSON.stringify(bySplits)}`)
console.log(`按类型    : ${JSON.stringify(tally(cases, (c) => c.type))}`)
console.log(`查询词数  : ${JSON.stringify(tally(cases, (c) => c.tokenCount))}（⚠ 必须有多词案例，否则退化成送分题）`)
console.log(`竞争条目  : ${JSON.stringify(tally(cases, (c) => c.competitors))}（≥2 才有排序可考；6 = 封顶值）`)
const multi = cases.filter((c) => c.tokenCount >= 2).length
if (multi !== cases.length) {
  console.error(`✖ 自检失败：${cases.length - multi} 个 case 只有 1 个查询词 ⇒ 与第一版（df===1 单词、实测 100% 满分）同形，无分辨力`)
  process.exit(5)
}
console.log(`耗时      : ${((Date.now() - t0) / 1000).toFixed(1)} 秒`)

// ⚠ 评测集**自带语料快照**（2026-10-27 补）：这是「同一把尺子」的正确实现——
//   否则每写一条新记忆，语料指纹就变、评测集作废、跨天读数不可比，而扫参期间
//   又不可能不写记忆。快照让评测跑在**冻结语料**上，与当天的真实库脱钩。
//   ⚠ 代价：文件变成数 MB（含全部正文）。写盘用无缩进 JSON。
const payload = { generatedAt: new Date().toISOString(), db: dbPath, corpus: fp, perType, cases, corpusSnapshot: entries }
if (dry) {
  console.log('\n(--dry) 未写盘。样例前 6 条：')
  for (const c of cases.slice(0, 6)) {
    console.log('   ', JSON.stringify({ query: c.query, type: c.type, split: c.split, tokenCount: c.tokenCount, rareDf: c.rareDf, commonDf: c.commonDf }))
  }
  process.exit(0)
}
const existed = existsSync(outPath)
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, JSON.stringify(payload, null, 2))
console.log(`\n已写盘: ${outPath}${existed ? '（覆盖旧集 —— 若旧集已用于调参，之前的留出集就污染了，须重建）' : ''}`)
