/**
 * 留出集验证：**一次性**。跑固定两臂，不做扫参。
 *
 * 为什么单独一个脚本而不是给 `sweep.mjs` 加个 `--split=holdout`：
 * `sweep.mjs` 里有一道**结构防线**——它不提供 split 选项、也不读它，从根上做不了「在留出集上调参」。
 * 给那道防线加例外，等于把「我只跑一次」变成一个需要自觉的承诺。
 * 这里改成：留在留出集上的**每一次运行都追加一行记录**（`holdout-runs.jsonl`），
 * 所以「跑了几次」是可查的事实，不是记性。跑第二次时脚本会响亮地说出这是第二次。
 *
 * 用法：node tests/recall-eval/validate-holdout.mjs
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { corpusFingerprint, loadSearch } from './lib.mjs'
import { mcnemar } from './stats.mjs'

const SET_PATH = 'E:/alice/.dsh/recall-eval/eval-set.json'
const RUN_LOG = 'E:/alice/.dsh/recall-eval/holdout-runs.jsonl'

/**
 * 被验证的两个配置：**写死在这里**，不读命令行。
 * 若哪天要验证别的组合，就改这个文件并留一次 git 提交——改了什么、为什么，都在历史里。
 */
const BASELINE = {
  label: '现状 v0.17（b=0.75 floor=0.05）',
  tuning: { k1: 1.2, b: 0.75, relativeFloor: 0.05 },
}
const CANDIDATE = {
  label: '候选 v0.18（b=0 floor=0.08）',
  tuning: { k1: 1.2, b: 0, relativeFloor: 0.08 },
}

const set = JSON.parse(readFileSync(SET_PATH, 'utf8'))
const entries = set.corpusSnapshot
if (!Array.isArray(entries) || entries.length === 0) {
  console.error('✖ 评测集没有语料快照 ⇒ 读数不冻结，验证无意义')
  process.exit(2)
}
const fp = corpusFingerprint(entries)
if (set.corpus?.digest !== fp.digest) {
  console.error(`✖ 快照指纹与记录不符（${fp.digest} vs ${set.corpus?.digest}）`)
  process.exit(3)
}
const cases = set.cases.filter((c) => c.split === 'holdout')
if (cases.length === 0) {
  console.error('✖ 评测集里没有 holdout 侧 case')
  process.exit(4)
}

// ⚠ 诚实机制：数一数这个指纹之前被验证过几次。
const prior = []
if (existsSync(RUN_LOG)) {
  for (const line of readFileSync(RUN_LOG, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try {
      const rec = JSON.parse(line)
      if (rec.corpusDigest === fp.digest) prior.push(rec)
    } catch {
      // 坏行不让整体失败：留痕文件被手工改过时，报数比崩掉有用
    }
  }
}
const runNo = prior.length + 1

const { recallEntries } = await loadSearch()

/**
 * ⚠ 与 `sweep.mjs` 的 `evaluate` 同构（口径必须一致，否则两处读数不可比）。
 *   若哪天改打分口径或指标定义，**两处都要改**——这是已知的技术债，写在这里而不是藏着。
 */
function evaluate(tuning) {
  const rows = []
  for (const c of cases) {
    const r = recallEntries(entries, { query: c.query, limit: 50, withRelated: false, includeArchive: true, tuning })
    const rank = r.results.map((x) => x.id).indexOf(c.answerId) + 1
    rows.push({ rank, returned: r.results.length })
  }
  const n = rows.length
  const sum = (f) => rows.reduce((a, r) => a + f(r), 0)
  const top1 = sum((r) => (r.rank === 1 ? 1 : 0)) / n
  return {
    n,
    top1,
    seTop1: Math.sqrt((top1 * (1 - top1)) / n),
    top5: sum((r) => (r.rank > 0 && r.rank <= 5 ? 1 : 0)) / n,
    mrr: sum((r) => (r.rank > 0 ? 1 / r.rank : 0)) / n,
    miss: sum((r) => (r.rank === 0 ? 1 : 0)) / n,
    noise: sum((r) => r.returned) / n,
    empty: sum((r) => (r.returned === 0 ? 1 : 0)) / n,
    hits: rows.map((r) => (r.rank === 1 ? 1 : 0)),
  }
}

console.log('════ 留出集验证（一次性）════')
console.log(`评测集 : ${SET_PATH}`)
console.log(`语料   : ${fp.count} 条 / ${fp.digest}`)
console.log(`holdout: ${cases.length} case`)
console.log(`这是该指纹的**第 ${runNo} 次**留出集验证${runNo > 1 ? `（此前 ${prior.length} 次：${prior.map((r) => r.at?.slice(0, 19)).join(' / ')}）` : ''}`)
if (runNo > 1) {
  console.log('  ⚠ 第 2 次起，留出集**已经不再是样本外**。这一次的读数只能当作「重复性检查」，不能当独立验证。')
}
console.log('')

const t0 = Date.now()
const a = evaluate(BASELINE.tuning)
const b = evaluate(CANDIDATE.tuning)
const elapsed = ((Date.now() - t0) / 1000).toFixed(0)

const fmt = (m) =>
  `top1 ${(m.top1 * 100).toFixed(1)}%±${(m.seTop1 * 100).toFixed(1)}  MRR ${m.mrr.toFixed(3)}  top5 ${(m.top5 * 100).toFixed(1)}%  噪音 ${m.noise.toFixed(1)}  空 ${(m.empty * 100).toFixed(1)}%  未命中 ${(m.miss * 100).toFixed(1)}%`
console.log(`  ${BASELINE.label.padEnd(26)} ${fmt(a)}`)
console.log(`  ${CANDIDATE.label.padEnd(26)} ${fmt(b)}`)

const t = mcnemar(b.hits, a.hits)
const delta = (b.top1 - a.top1) * 100
console.log('\n── 配对检验（候选 vs 现状）──')
if (t.empty) {
  console.log('  ⚠ 不一致对 0（0:0）⇒ **无数据**：两臂逐 case 全同，这一面对该改动完全不敏感')
} else {
  console.log(
    `  候选对/现状错=${t.aOnly}  现状对/候选错=${t.bOnly}  z=${t.z >= 0 ? '+' : ''}${t.z.toFixed(3)}  p=${t.p.toFixed(3)}` +
      `  ⇒ ${t.significant ? '★ 显著' : '不显著'}（差 ${delta >= 0 ? '+' : ''}${delta.toFixed(1)} 个百分点）`,
  )
  if (t.n < 6) console.log(`  ⚠ 不一致对仅 ${t.n} 个 < 6 ⇒ 本实现在数学上不可能报显著，**不可判**`)
}
console.log(`\n耗时 ${elapsed} 秒`)

// ★ 留痕：每一次运行都追加，不覆盖。这是「只跑一次」唯一可验证的形式。
mkdirSync(dirname(RUN_LOG), { recursive: true })
appendFileSync(
  RUN_LOG,
  `${JSON.stringify({
    at: new Date().toISOString(),
    corpusDigest: fp.digest,
    setPath: SET_PATH,
    holdoutCases: cases.length,
    runNo,
    arms: [
      { label: BASELINE.label, tuning: BASELINE.tuning, top1: a.top1, mrr: a.mrr, noise: a.noise },
      { label: CANDIDATE.label, tuning: CANDIDATE.tuning, top1: b.top1, mrr: b.mrr, noise: b.noise },
    ],
    mcnemar: { aOnly: t.aOnly, bOnly: t.bOnly, n: t.n, z: t.z, p: t.p, empty: t.empty, significant: t.significant },
    deltaTop1: delta,
  })}\n`,
)
console.log(`留痕已追加: ${RUN_LOG}（第 ${runNo} 行）`)
