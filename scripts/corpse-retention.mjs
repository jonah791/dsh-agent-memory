// 尸体验证 driver：对每一处做「改坏 → 重编 → 跑测试 → 数红 → 恢复」。
// 判据：每处改坏都必须让至少一条测试变红；全绿则说明该判据没有分辨力。
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const SRC = 'src/retention.ts'
const original = readFileSync(SRC, 'utf8')

const cases = [
  {
    name: '尸体1 给 unknown 塞默认类别 semantic ⇒ R2/R3 应变红',
    from: "  return { type: null, source: 'unknown' }",
    to: "  return { type: 'semantic', source: 'derived-from-kind' }",
  },
  {
    name: '尸体2 去掉「目标档更高才生效」⇒ R1b 应变红',
    from: '  if (BUCKET_RANK[target] <= BUCKET_RANK[base.bucket]) {',
    to: '  if (false) {',
  },
  {
    name: '尸体3 knowledge 硬塞成 semantic（保留 unknown 来源）⇒ R2 应变红',
    from: "  return { type: null, source: 'unknown' }",
    to: "  return { type: 'semantic', source: 'unknown' }",
  },
  {
    name: '尸体4 F-hold 只在基础档 REVIEW 时触发 ⇒ R4 画像归档应变红',
    from: "  if (eff.type === 'profile' && (base.bucket === 'ARCHIVE' || base.bucket === 'DEMOTE')) {",
    to: "  if (eff.type === 'profile' && base.bucket === 'REVIEW') {",
  },
  {
    name: '尸体5 去掉判据码文案 ⇒ R9 应变红',
    from: "'E-decay':\n    '类别修正 E-decay：",
    to: "'E-decay':\n    '类别修正：",
  },
]

const results = []
for (const c of cases) {
  if (!original.includes(c.from)) {
    results.push({ name: c.name, status: 'SKIP（锚点未命中）' })
    continue
  }
  writeFileSync(SRC, original.replace(c.from, c.to), 'utf8')
  const tsc = spawnSync('npx', ['tsc', '-p', 'tsconfig.json'], { encoding: 'utf8', shell: true })
  if (tsc.status !== 0) {
    results.push({ name: c.name, status: `编译失败（也算拦下，但不是我想要的形态）` })
    writeFileSync(SRC, original, 'utf8')
    continue
  }
  const run = spawnSync('node', ['--test', 'tests/retention.test.mjs'], { encoding: 'utf8', shell: true })
  const out = (run.stdout ?? '') + (run.stderr ?? '')
  const fail = /ℹ fail (\d+)/.exec(out)
  const failNames = [...out.matchAll(/✖ (.+?) \(\d/g)].map((m) => m[1])
  results.push({
    name: c.name,
    status: fail ? (Number(fail[1]) > 0 ? `红 ${fail[1]} 条 ✔` : '全绿 ✘（判据无分辨力）') : '解析失败',
    detail: failNames.slice(0, 4).join(' / '),
  })
  writeFileSync(SRC, original, 'utf8')
}

// 恢复并重编
writeFileSync(SRC, original, 'utf8')
const restore = spawnSync('npx', ['tsc', '-p', 'tsconfig.json'], { encoding: 'utf8', shell: true })
const after = spawnSync('node', ['--test', 'tests/retention.test.mjs'], { encoding: 'utf8', shell: true })
const afterOut = (after.stdout ?? '') + (after.stderr ?? '')
const afterFail = /ℹ fail (\d+)/.exec(afterOut)

console.log('=== 尸体验证 ===')
for (const r of results) console.log(`${r.status.padEnd(22)} ${r.name}${r.detail ? `\n   └ ${r.detail}` : ''}`)
console.log(`\n恢复后：tsc=${restore.status} · 测试 fail=${afterFail ? afterFail[1] : '?'}`)
