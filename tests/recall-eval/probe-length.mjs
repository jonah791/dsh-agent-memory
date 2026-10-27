/**
 * 探针：长度分布全貌（不写盘、不改评测集）。
 *
 * 回答一个问题：**这个语料里到底有没有「长答案 + 短竞争者」的场景？**
 * 有 ⇒ 长度归一有作用面，评测集只要按 ratio 分层抽样就能测到收益；
 * 没有 ⇒ 无论怎么重建，这台仪器都测不到归一的收益，得先换查询构造法。
 *
 * 用法：node tests/recall-eval/probe-length.mjs
 */
import { DEFAULT_DB, buildCases, loadCorpus } from './lib.mjs'

const q = (arr, f) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(arr.length * f)))]
const fmt = (n) => String(n).padStart(5)

const entries = loadCorpus(DEFAULT_DB)
console.log(`语料 ${entries.length} 条`)

// 门关掉 ⇒ 拿到全部候选，看见完整分布（这正是评测集看不见的那一半）
const cases = buildCases(entries, { maxTokens: 3, lengthBand: null, verbose: false })
console.log(`候选 case ${cases.length} 个（无长度门）\n`)

const ratios = cases.map((c) => c.lengthRatio).sort((a, b) => a - b)
console.log('── 答案/竞争者中位 的比值分布 ──')
for (const f of [0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99]) {
  console.log(`  p${String(f * 100).padStart(4)}  ${q(ratios, f).toFixed(3)}`)
}

console.log('\n── 分桶（桶 = 归一的作用面）──')
const buckets = [
  [0, 0.4, '答案远短于竞争者（归一帮它最多）'],
  [0.4, 0.7, '答案短'],
  [0.7, 1.0, '相当'],
  [1.0, 1.2, '相当（略长）'],
  [1.2, 1.5, '答案略长（归一轻度伤它）'],
  [1.5, 2.0, '答案长（归一显著伤它）'],
  [2.0, 3.0, '答案很长'],
  [3.0, Infinity, '答案极长'],
]
for (const [lo, hi, label] of buckets) {
  const n = cases.filter((c) => c.lengthRatio >= lo && c.lengthRatio < hi).length
  console.log(`  [${String(lo).padEnd(4)}, ${String(hi === Infinity ? '∞' : hi).padEnd(4)}) ${fmt(n)}  ${label}`)
}

// ★ 真正的判据：比对全库——答案绝对长度是不是系统性偏长（选入偏差）
const allLens = entries.map((e) => e.body.length).sort((a, b) => a - b)
const ansLens = cases.map((c) => c.answerLen).sort((a, b) => a - b)
const compLens = cases.map((c) => c.compMedLen).sort((a, b) => a - b)
const med = (a) => q(a, 0.5)
console.log('\n── 绝对长度（字符）──')
console.log(`  全库中位       ${fmt(med(allLens))}`)
console.log(`  答案中位       ${fmt(med(ansLens))}   ⇒ ${(med(ansLens) / med(allLens)).toFixed(2)}× 全库（旧集实测 1.53×）`)
console.log(`  竞争者中位     ${fmt(med(compLens))}   ⇒ ${(med(compLens) / med(allLens)).toFixed(2)}× 全库`)
console.log(`  ⇒ **竞争者自己就是长条目** ⇒ 答案比值再公平，两者都远长于全库`)

// ★★ 决定性判据：「答案比竞争者中位长出 40% 以上」的 case 有几个。
//   归一的收益只能在这种场景里出现（长答案被压低，短竞争者被提权）。
//   ⚠ 用中位比而不是「有没有一条竞争者更短」：后者几乎恒真（竞争者动辄几十条，总有一条短的），
//     而真正决定 top1 的是**分数最高的那几条**，它们的长短由中位近似。
const longAns = cases.filter((c) => c.lengthRatio > 1.43).length
console.log(`\n  答案比竞争者中位长 40%+ 的 case：${longAns} 个（${((longAns / cases.length) * 100).toFixed(1)}%）—— 归一收益的唯一作用面`)

// 按类型看：哪个 token 类型能造出长答案
console.log('\n── 按类型的 ratio 中位（哪个类型能造出「长答案」）──')
const byType = new Map()
for (const c of cases) {
  if (!byType.has(c.type)) byType.set(c.type, [])
  byType.get(c.type).push(c.lengthRatio)
}
for (const [t, arr] of [...byType.entries()].sort()) {
  arr.sort((a, b) => a - b)
  console.log(`  ${t.padEnd(10)} n=${fmt(arr.length)}  中位 ${q(arr, 0.5).toFixed(3)}  p90 ${q(arr, 0.9).toFixed(3)}`)
}
