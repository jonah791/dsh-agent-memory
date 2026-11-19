// 尸体验证 driver（catalog 段）：改坏 → 重编 → 跑测试 → 数红 → 恢复。
// 判据：每处改坏都必须让至少一条测试变红；全绿则说明该判据没有分辨力。
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const SRC = 'src/catalog.ts'
const original = readFileSync(SRC, 'utf8')

const cases = [
  {
    name: '尸体1 不排除 summary ⇒ C1/C1b 分母纯度应变红',
    from: "  if (entry.kind === 'summary') return false",
    to: '  // 尸体：故意不排除 summary',
  },
  {
    name: '尸体2 聚簇改成按标签频次排序（非覆盖优先）⇒ C5b 应变红',
    from: `    let bestTag: string | undefined
    let bestCount = 0
    for (const [tag, count] of counts) {
      // 并列时取字典序小的，保证可复现（不依赖 Map 插入顺序）
      if (count > bestCount || (count === bestCount && bestTag !== undefined && tag < bestTag)) {
        bestTag = tag
        bestCount = count
      }
    }`,
    to: `    // 尸体：按**全体**标签频次排序（不看是否已被覆盖）⇒ 高重叠标签会各占一个簇位
    const allCounts = new Map<string, number>()
    for (const entry of entries) for (const tag of new Set(entry.tags ?? [])) {
      allCounts.set(tag, (allCounts.get(tag) ?? 0) + 1)
    }
    let bestTag: string | undefined
    let bestCount = 0
    for (const already of clusters) allCounts.delete(already.tag)
    for (const [tag, count] of allCounts) {
      if (count > bestCount || (count === bestCount && bestTag !== undefined && tag < bestTag)) {
        bestTag = tag
        bestCount = count
      }
    }`,
  },
  {
    name: '尸体3 样本 id 截断成 8 位 ⇒ C7 应变红',
    from: "      .map((entry) => ({ id: entry.id, title: entry.title }))",
    to: "      .map((entry) => ({ id: entry.id.slice(0, 8), title: entry.title }))",
  },
  {
    name: '尸体4 技能建议改成 semantic ⇒ C4 应变红',
    from: "  技能: 'procedural',",
    to: "  技能: 'semantic',",
  },
  {
    name: '尸体5 space 判据误用 provenance ⇒ C2 四维独立应变红',
    from: '    space: gapOf(entries, (entry) => entry.space === undefined),',
    to: '    space: gapOf(entries, (entry) => entry.provenance === undefined),',
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
    const errs = (tsc.stdout ?? '') + (tsc.stderr ?? '')
    results.push({ name: c.name, status: '编译失败（拦下但不是目标形态）', detail: errs.split('\n').filter((l) => l.includes('error')).slice(0, 1).join('') })
    writeFileSync(SRC, original, 'utf8')
    continue
  }
  const run = spawnSync('node', ['--test', 'tests/catalog.test.mjs'], { encoding: 'utf8', shell: true })
  const out = (run.stdout ?? '') + (run.stderr ?? '')
  const fail = /ℹ fail (\d+)/.exec(out)
  const names = [...new Set([...out.matchAll(/✖ (.+?) \(\d/g)].map((m) => m[1]))]
  results.push({
    name: c.name,
    status: fail ? (Number(fail[1]) > 0 ? `红 ${fail[1]} 条 ✔` : '全绿 ✘（判据无分辨力）') : '解析失败',
    detail: names.slice(0, 3).join(' / '),
  })
  writeFileSync(SRC, original, 'utf8')
}

writeFileSync(SRC, original, 'utf8')
const restore = spawnSync('npx', ['tsc', '-p', 'tsconfig.json'], { encoding: 'utf8', shell: true })
const after = spawnSync('node', ['--test', 'tests/catalog.test.mjs'], { encoding: 'utf8', shell: true })
const afterOut = (after.stdout ?? '') + (after.stderr ?? '')
const afterFail = /ℹ fail (\d+)/.exec(afterOut)

console.log('=== 尸体验证（catalog）===')
for (const r of results) console.log(`${r.status.padEnd(26)} ${r.name}${r.detail ? `\n   └ ${r.detail}` : ''}`)
console.log(`\n恢复后：tsc=${restore.status} · 测试 fail=${afterFail ? afterFail[1] : '?'}`)
