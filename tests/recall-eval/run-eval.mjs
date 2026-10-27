/**
 * 跑检索评测（同一把尺子量前后 —— measurable-optimization 拍 7）
 *
 * 用法：
 *   node tests/recall-eval/run-eval.mjs [--set=<eval-set.json>] [--split=tune|holdout|all] [--verbose]
 *
 * 判据（做完了吗）：
 *   ① 报告必须带**分母**（多少 case）——「top1 命中 0.72」没分母等于没报
 *   ② tune 与 holdout **分开报**（样本外纪律：留出集只跑一次，跑完就冻结结论）
 *   ③ 除总体外**按类型报**（哪种查询形态退化才有行动性；总体一个好数字会盖住一类全灭）
 *   ④ 必带**长文档偏差探针**（top10 里超长条目的占比）——那是 v0.17 要治的病，
 *      不做成读数就等于没验
 *
 * ⚠ 本脚本**不改任何东西**：只读语料、只调 lib/search.js 的 recallEntries。
 */

import { readFileSync } from 'node:fs'
import { DEFAULT_DB, corpusFingerprint, loadCorpus, loadSearch } from './lib.mjs'

const DEFAULT_SET = 'E:/alice/.dsh/recall-eval/eval-set.json'
/** 超长条目的口径（与 v0.17 设计文档一致：正文 > 20000 字符 = 长文档偏差的高危区） */
const LONG_BODY = 20000
/** 取多少条做噪音/长文档读数 */
const TOPK = 10

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit === undefined ? fallback : hit.slice(name.length + 3)
}

const setPath = arg('set', DEFAULT_SET)
const splitFilter = arg('split', 'all')
const verbose = process.argv.includes('--verbose')

const { recallEntries } = await loadSearch()
const set = JSON.parse(readFileSync(setPath, 'utf8'))
// ⚠ 优先用评测集自带的**语料快照**：尺子必须是冻结的（理由见 build-eval-set.mjs 的注释）。
//   否则每写一条新记忆语料指纹就变、评测集作废、跨天读数不可比，而扫参期间不可能不写记忆。
//   只有旧版评测集（无快照）才回落到读当前库——那时语料指纹不符就拒绝跑。
const useSnapshot = Array.isArray(set.corpusSnapshot) && set.corpusSnapshot.length > 0
const entries = useSnapshot ? set.corpusSnapshot : loadCorpus(set.db ?? DEFAULT_DB)
const corpusSource = useSnapshot ? '评测集自带快照（冻结）' : '当前库（⚠ 非冻结，读数只在当天有效）'

const fp = corpusFingerprint(entries)
if (set.corpus?.digest !== fp.digest) {
  console.error(
    `✖ 语料指纹不符：评测集记录 ${set.corpus?.count} 条（${set.corpus?.digest}），` +
      `实测 ${fp.count} 条（${fp.digest}）`,
  )
  console.error('  ⇒ 重建评测集（build-eval-set.mjs），否则这次读数与之前的不是同一把尺子。')
  process.exit(2)
}

const cases = set.cases.filter((c) => splitFilter === 'all' || c.split === splitFilter)
if (cases.length === 0) {
  console.error(`没有 case（split=${splitFilter}）；实有：${JSON.stringify([...new Set(set.cases.map((c) => c.split))])}`)
  process.exit(3)
}

const byId = new Map(entries.map((e) => [e.id, e]))
const results = []
const t0 = Date.now()
for (let i = 0; i < cases.length; i++) {
  const c = cases[i]
  const r = recallEntries(entries, { query: c.query, limit: 50, withRelated: false, includeArchive: true })
  const ids = r.results.map((x) => x.id)
  const rank = ids.indexOf(c.answerId) + 1 // 0 = 未命中
  const top = r.results.slice(0, TOPK)
  const longHits = top.filter((x) => (byId.get(x.id)?.body.length ?? 0) > LONG_BODY).length
  results.push({
    query: c.query,
    type: c.type,
    split: c.split,
    rank,
    returned: r.results.length,
    total: r.total,
    longHits,
    targetLen: byId.get(c.answerId)?.body.length ?? 0,
  })
  if (verbose || (i + 1) % 100 === 0) console.log(`  …${i + 1}/${cases.length}`)
}
const elapsed = ((Date.now() - t0) / 1000).toFixed(1)

/** 一组结果 → 指标（分母恒定带上） */
function metrics(rows) {
  const n = rows.length
  const sum = (f) => rows.reduce((a, r) => a + f(r), 0)
  return {
    n,
    top1: sum((r) => (r.rank === 1 ? 1 : 0)) / n,
    top5: sum((r) => (r.rank > 0 && r.rank <= 5 ? 1 : 0)) / n,
    mrr: sum((r) => (r.rank > 0 ? 1 / r.rank : 0)) / n,
    miss: sum((r) => (r.rank === 0 ? 1 : 0)) / n,
    noise: sum((r) => r.returned) / n,
    empty: sum((r) => (r.returned === 0 ? 1 : 0)) / n,
    longShare: sum((r) => r.longHits) / Math.max(1, sum((r) => Math.min(r.returned, TOPK))),
  }
}

const pct = (x) => `${(x * 100).toFixed(1)}%`
const fmt = (m) =>
  `n=${String(m.n).padStart(3)}  top1=${pct(m.top1).padStart(6)}  top5=${pct(m.top5).padStart(6)}  ` +
  `MRR=${m.mrr.toFixed(3)}  未命中=${pct(m.miss).padStart(6)}  噪音(条/查询)=${m.noise.toFixed(2)}  ` +
  `空结果=${pct(m.empty).padStart(6)}  长条目占比=${pct(m.longShare).padStart(6)}`

console.log('\n════ 检索评测 ════')
console.log(`评测集   : ${setPath}（生成于 ${set.generatedAt}）`)
console.log(`语料     : ${fp.count} 条（指纹 ${fp.digest} ✓）— ${corpusSource}`)
console.log(`跑完     : ${cases.length} case / ${elapsed} 秒（split=${splitFilter}）`)

console.log('\n── 总体 ──')
const overall = metrics(results)
console.log(fmt(overall))

// ★ 仪器自检：满分是装置 bug 的指纹（AGENTS.md §2.3「好得可疑与坏得可疑都是装置 bug 的指纹」）。
//   第一版评测集就是这种形状：df===1 的单词查询 ⇒ 只有一条有分 ⇒ 任何检索器都 100%。
//   这条警告必须一直挂着，否则下一个看读数的人（包括未来的我）会把它当成算法很好。
if (overall.top1 === 1 && overall.noise <= 1.01) {
  console.log('\n⚠⚠ 警告：top1 = 100% 且噪音 ≈ 1.00 条 —— 这是**评测集没有分辨力**的典型形状，')
  console.log('   不是「算法完美」的证据。先看 case 的 competitors 分布（含至少一个查询词的条目数），')
  console.log('   若大量 case 的 competitors = 1，那它们只有一条有分，排名无从比较。')
}

const splits = [...new Set(results.map((r) => r.split))].sort()
if (splits.length > 1) {
  console.log('\n── 按侧（⚠ holdout 只该跑一次：调过参数又重跑它，它就退化成调参集）──')
  for (const s of splits) console.log(`${s.padEnd(8)} ${fmt(metrics(results.filter((r) => r.split === s)))}`)
}

console.log('\n── 按查询类型（总体好数字会盖住某一类全灭）──')
for (const t of [...new Set(results.map((r) => r.type))].sort()) {
  console.log(`${t.padEnd(9)} ${fmt(metrics(results.filter((r) => r.type === t)))}`)
}

// ---- 失败样本（没有它，读数只能证明「坏了」，不能说明「怎么坏的」）----
const fails = results.filter((r) => r.rank !== 1).slice(0, 12)
if (fails.length > 0) {
  console.log(`\n── 非 top1 样例（共 ${results.filter((r) => r.rank !== 1).length} 条，示前 ${fails.length}）──`)
  for (const f of fails) {
    console.log(`   ${f.rank === 0 ? '未命中' : `第${f.rank}位`}  [${f.type}] "${f.query}"  目标正文 ${f.targetLen} 字符`)
  }
}
