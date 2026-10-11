#!/usr/bin/env node
/**
 * 输出快照比对（等价性判据的**比对端**，自带尸体测试）
 *
 * 用法：
 *   node scripts/diff-snapshot.mjs <a.json> <b.json>   # 差异 0 ⇒ 逐字段等价
 *   node scripts/diff-snapshot.mjs --selftest          # 自检：造一具篡改副本，断言会被抓
 *
 * ⚠ 为什么必须有 --selftest：「差异 0」有三个来源 —— 真等价 / 两份都空 / 比对根本没跑。
 *   判据没有分辨力时，它给出的绿与真等价的绿长得一样。自检是这条判据的尸体测试。
 */
import fs from 'node:fs'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function compare(A, B) {
  let same = 0
  const diffs = []
  const walk = (p, x, y) => {
    if (JSON.stringify(x) === JSON.stringify(y)) {
      same++
      return
    }
    if (typeof x !== typeof y || x === null || y === null || typeof x !== 'object') {
      diffs.push(`${p}: ${JSON.stringify(x)} ≠ ${JSON.stringify(y)}`)
      return
    }
    const kx = Object.keys(x)
    const ky = Object.keys(y)
    if (kx.length !== ky.length || kx.some((k, i) => k !== ky[i])) {
      diffs.push(`${p}: 键集不同 [${kx.join(',')}] vs [${ky.join(',')}]`)
      return
    }
    for (const k of kx) walk(`${p}.${k}`, x[k], y[k])
  }
  walk('$', A, B)
  return { same, diffs }
}

function selftest() {
  const dir = mkdtempSync(join(tmpdir(), 'diff-snapshot-selftest-'))
  const base = { perTarget: { a: [{ id: 'x', strength: 8 }], b: [] }, recalls: { q: { results: [] } } }
  const sameCopy = JSON.parse(JSON.stringify(base))
  const tampered = JSON.parse(JSON.stringify(base))
  tampered.perTarget.a[0].strength = 9
  const a = join(dir, 'a.json')
  const b = join(dir, 'b.json')
  const c = join(dir, 'c.json')
  writeFileSync(a, JSON.stringify(base))
  writeFileSync(b, JSON.stringify(sameCopy))
  writeFileSync(c, JSON.stringify(tampered))

  const fails = []
  const r1 = compare(JSON.parse(fs.readFileSync(a, 'utf8')), JSON.parse(fs.readFileSync(b, 'utf8')))
  if (r1.diffs.length !== 0) fails.push(`同内容副本应差异 0，实得 ${r1.diffs.length}`)
  const r2 = compare(JSON.parse(fs.readFileSync(a, 'utf8')), JSON.parse(fs.readFileSync(c, 'utf8')))
  if (r2.diffs.length === 0) fails.push('篡改一个 strength 应被抓，实得差异 0（判据无分辨力）')
  if (r2.diffs.length > 0 && !r2.diffs[0].includes('strength')) {
    fails.push(`定位错误：应指向 strength，实得 ${r2.diffs[0]}`)
  }
  rmSync(dir, { recursive: true, force: true })

  console.log(`SELFTEST 同内容副本=0 差异 ${r1.diffs.length === 0 ? '✔' : '✘'} · 篡改被抓 ${r2.diffs.length > 0 ? '✔' : '✘'}${fails.length ? ' FAIL' : ' PASS'}`)
  for (const f of fails) console.log('  ✗ ' + f)
  process.exit(fails.length ? 1 : 0)
}

const argv = process.argv.slice(2)
if (argv.includes('--selftest')) selftest()

const [a, b] = argv
if (!a || !b) {
  console.error('用法：node scripts/diff-snapshot.mjs <a.json> <b.json>  |  --selftest')
  process.exit(2)
}
const { same, diffs } = compare(JSON.parse(fs.readFileSync(a, 'utf8')), JSON.parse(fs.readFileSync(b, 'utf8')))
console.log(`相同子树=${same}  差异=${diffs.length}`)
for (const d of diffs.slice(0, 20)) console.log('  ✗ ' + d)
process.exit(diffs.length ? 1 : 0)
