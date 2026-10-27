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
import { DEFAULT_DB, LENGTH_ZONES, buildCases, corpusFingerprint, loadCorpus, splitOf, zoneOf } from './lib.mjs'

const DEFAULT_OUT = 'E:/alice/.dsh/recall-eval/eval-set.json'

/**
 * 每个「长度区 × 侧」的配额。
 *
 * 为什么配额要配到长度区这一层（2026-10-27 改）：长度归一的效应**符号随区翻转**——
 * 短答案区它是收益（长竞争者被压、短答案被提权），长答案区它是代价。
 * 只按类型配额 ⇒ 各区占比由语料偶然分布决定 ⇒ 总体数字把两个相反方向互相抵消，
 * 读起来像「没效果」，实际是两种方向叠在一起（核验报告实测 Δ 符号按层翻转，正是这个形状）。
 *
 * 60 的取法：五个区 × 两侧 ⇒ 上限 600，实际受「每区可用候选数」约束
 * （探针实测：far-short 534 / short 337 / fair 359 / long 53 / far-long 174）。
 * 越大功效越高，但评估耗时 ∝ case 数 × 库大小（187 case ≈ 44 秒/臂 ⇒ 600 case ≈ 2 分钟/臂）。
 */
const ZONE_QUOTA = 60

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit === undefined ? fallback : hit.slice(name.length + 3)
}

const dbPath = arg('db', DEFAULT_DB)
const outPath = arg('out', DEFAULT_OUT)
const zoneQuota = Number(arg('zone-quota', String(ZONE_QUOTA)))
const dry = process.argv.includes('--dry')

const t0 = Date.now()
const entries = loadCorpus(dbPath)
if (entries.length === 0) {
  console.error(`语料为空：${dbPath} —— 「空」与「读不到」是两件事，先确认路径`)
  process.exit(2)
}
const fp = corpusFingerprint(entries)

const raw = buildCases(entries, { maxTokens: 3, verbose: true })

// 划分 + **三元分层抽样**：split × 长度区 × 类型。
// ⚠ 旧实现是「type×split 上限 40，桶内按 query 字典序截断」，两个毛病：
//   ① 长度维度完全缺失 ⇒ 答案长度分布由遍历顺序决定。实测旧集答案中位 1.53× 全库，
//      而语料本身只有 1.28× ⇒ **偏长是抽样造出来的，不是语料事实**（核验报告的核心发现）；
//   ② 字典序截断让字母靠前的类型吃满配额，是隐性类型偏差。
// 现在：先按 zone×split 分桶，每桶配额 zoneQuota 条，桶内按 type **轮流取**（round-robin）。
const withSplit = raw.map((c) => ({ ...c, split: splitOf(c.answerId), zone: zoneOf(c.lengthRatio) }))
const buckets = new Map()
for (const c of withSplit) {
  const k = `${c.zone}|${c.split}`
  if (!buckets.has(k)) buckets.set(k, [])
  buckets.get(k).push(c)
}
const cases = []
for (const [k, list] of [...buckets.entries()].sort()) {
  const byType = new Map()
  for (const c of list) {
    if (!byType.has(c.type)) byType.set(c.type, [])
    byType.get(c.type).push(c)
  }
  for (const arr of byType.values()) arr.sort((a, b) => (a.query < b.query ? -1 : a.query > b.query ? 1 : 0))
  const types = [...byType.keys()].sort()
  const picked = []
  for (let round = 0; picked.length < zoneQuota; round += 1) {
    let added = 0
    for (const t of types) {
      const arr = byType.get(t)
      if (round < arr.length && picked.length < zoneQuota) {
        picked.push(arr[round])
        added += 1
      }
    }
    if (added === 0) break // 所有类型都取空了
  }
  cases.push(...picked)
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
console.log(`入选 case : ${cases.length}（每区每侧上限 ${zoneQuota}）`)
console.log(`按侧      : ${JSON.stringify(bySplits)}`)
console.log(`按长度区  : ${JSON.stringify(tally(cases, (c) => c.zone))}（区 = 答案正文 / 竞争者正文中位）`)
console.log(`按类型    : ${JSON.stringify(tally(cases, (c) => c.type))}`)
console.log(`查询词数  : ${JSON.stringify(tally(cases, (c) => c.tokenCount))}（⚠ 必须有多词案例，否则退化成送分题）`)
console.log(`竞争条目  : ${JSON.stringify(tally(cases, (c) => c.competitors))}（≥2 才有排序可考；6 = 封顶值）`)
const multi = cases.filter((c) => c.tokenCount >= 2).length
if (multi !== cases.length) {
  console.error(`✖ 自检失败：${cases.length - multi} 个 case 只有 1 个查询词 ⇒ 与第一版（df===1 单词、实测 100% 满分）同形，无分辨力`)
  process.exit(5)
}
// ---- 判据 ⑤：长度自检 + 区覆盖自检（2026-10-27 由核验报告加的硬门）----
// 为什么是硬门而不是打印：核验实测旧集答案正文中位 1.53× 全库，而语料本身只有 1.28×
// ⇒ 偏长是**抽样造出来的**。若重建后这道读数还偏，说明抽样层没生效，此时生成的集不能用。
const qz = (arr, f) => arr[Math.min(arr.length - 1, Math.floor(arr.length * f))]
const ansLens = cases.map((c) => c.answerLen).sort((a, b) => a - b)
const allLens = entries.map((e) => e.body.length).sort((a, b) => a - b)
const ratios = cases.map((c) => c.lengthRatio).sort((a, b) => a - b)
const ansMed = qz(ansLens, 0.5)
const allMed = qz(allLens, 0.5) || 1
console.log(
  `长度分布  : 答案中位 ${ansMed} vs 全库 ${allMed} = ${(ansMed / allMed).toFixed(2)}×（旧集 1.53×）；` +
    `比值 p10 ${qz(ratios, 0.1).toFixed(2)} / 中位 ${qz(ratios, 0.5).toFixed(2)} / p90 ${qz(ratios, 0.9).toFixed(2)}`,
)
// 区覆盖：fair（纯排序能力）与 far-long（归一收益的唯一作用面）**都必须非空**。
// 只留 fair ⇒ 仪器测不到归一值不值（实测：上一版就是这么被砍成 0 条的）。
const zoneTally = tally(cases, (c) => c.zone)
const missingZones = LENGTH_ZONES.filter((z) => (zoneTally[z.name] ?? 0) === 0)
if (missingZones.length > 0) {
  console.error(`✖ 自检失败：长度区为空 ${missingZones.map((z) => z.name).join(', ')} ⇒ 仪器在那一面上失明，测不到该区的效应符号`)
  process.exit(6)
}

console.log(`耗时      : ${((Date.now() - t0) / 1000).toFixed(1)} 秒`)
// ⚠ 评测集**自带语料快照**（2026-10-27 补）：这是「同一把尺子」的正确实现——
//   否则每写一条新记忆，语料指纹就变、评测集作废、跨天读数不可比，而扫参期间
//   又不可能不写记忆。快照让评测跑在**冻结语料**上，与当天的真实库脱钩。
//   ⚠ 代价：文件变成数 MB（含全部正文）。写盘用无缩进 JSON。
const payload = {
  generatedAt: new Date().toISOString(),
  db: dbPath,
  corpus: fp,
  zoneQuota,
  lengthZones: LENGTH_ZONES.map((z) => z.name),
  cases,
  corpusSnapshot: entries,
}
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
