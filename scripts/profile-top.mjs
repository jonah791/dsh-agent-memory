#!/usr/bin/env node
/**
 * CPU profile 排行（复现 audit-retrieval 归因用的**同一口径**）
 *
 * 用法：node --cpu-prof --cpu-prof-name=x.cpuprofile --cpu-prof-dir=<dir> <被测命令>
 *       node scripts/profile-top.mjs <file.cpuprofile> [topN]
 *
 * 口径：self time / **总采样时间**（不是「有名字的函数之和」）—— 依据是任务里那份
 * 归因同时报了 GC 0.8% 与 buildIdf 0.1%，说明分母含 GC 等无函数名样本。
 * 口径不一致 = 两次读数不可比 ⇒ 复测必须用同一个解析器。
 */
import fs from 'node:fs'

const P = process.argv[2]
const N = Number(process.argv[3] ?? 15)
if (!P) {
  console.error('用法：node scripts/profile-top.mjs <file.cpuprofile> [topN]')
  process.exit(2)
}

const prof = JSON.parse(fs.readFileSync(P, 'utf8'))
const byId = new Map(prof.nodes.map((n) => [n.id, n]))

const self = new Map()
let total = 0
prof.samples.forEach((id, i) => {
  const dt = prof.timeDeltas[i] ?? 0
  total += dt
  const n = byId.get(id)
  if (!n) return
  const cf = n.callFrame
  const file = (cf.url || '').split(/[\\/]/).pop() || ''
  const name = cf.functionName ? `${cf.functionName}  [${file}]` : `(anon)  [${file}:${cf.lineNumber}]`
  self.set(name, (self.get(name) ?? 0) + dt)
})

const rows = [...self.entries()].sort((a, b) => b[1] - a[1])
const pct = (us) => ((us / total) * 100).toFixed(1)

console.log(`总采样=${(total / 1000).toFixed(1)}ms  样本数=${prof.samples.length}`)
for (const [name, us] of rows.slice(0, N)) {
  console.log(`  ${pct(us).padStart(5)}%  ${(us / 1000).toFixed(1).padStart(8)}ms  ${name}`)
}

const sum = (pat) => rows.filter(([n]) => pat.test(n)).reduce((a, [, us]) => a + us, 0)
console.log(`\n[家族] relatedOf|cleanForGram|ngrams = ${pct(sum(/relatedOf|cleanForGram|ngrams/))}%`)
