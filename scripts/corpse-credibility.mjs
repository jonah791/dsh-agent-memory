// 尸体验证 driver（credibility 段）：改坏 → 重编 → 跑测试 → 数红 → 恢复。
// 判据：每处改坏都必须让至少一条测试变红；全绿则说明该判据没有分辨力。
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const SRC = 'src/credibility.ts'
const original = readFileSync(SRC, 'utf8')

const cases = [
  {
    name: '尸体1 proposed 判成 settled ⇒ D6 应变红（本轮最要紧的一格）',
    from: "      return { verdict: 'inconclusive', reading: '我自己提的、主人没回应——未核验，不许当授权用' }",
    to: "      return { verdict: 'settled', reading: '我自己提的、主人没回应——未核验，不许当授权用' }",
  },
  {
    name: '尸体2 measured 判成 settled ⇒ D8 应变红（自验冒充独立核实）',
    from: "    return { verdict: 'selfVerified', reading: '我实测过（同一主体自验）——不是独立核实' }",
    to: "    return { verdict: 'settled', reading: '我实测过（同一主体自验）——不是独立核实' }",
  },
  {
    name: '尸体3 四档统计漏算 unknown ⇒ D13 自洽断言应变红',
    from: '    unknown: counts.unknown,',
    to: '    unknown: 0,',
  },
  {
    name: '尸体4 分母不再过滤（收全量）⇒ D13 分母纯度应变红',
    from: '  const pool = entries.filter((entry) => isCatalogable(entry))',
    to: '  const pool = [...entries]',
  },
  {
    name: '尸体5 caveat 清空 ⇒ D15 代理维无边界应变红',
    from: "  sourceReliability: {\n    label: '来源可靠性',\n    fidelity: 'proxy',\n    needs: ['sourceIds', 'sources.reliability'],\n    caveat:\n      '`reliability` 是自由文本，机制只报「标了没有」，读不出「可不可靠」——本维是代理，不是可靠性评分。',\n  },",
    to: "  sourceReliability: {\n    label: '来源可靠性',\n    fidelity: 'proxy',\n    needs: ['sourceIds', 'sources.reliability'],\n    caveat: '',\n  },",
  },
  {
    name: '尸体6 合成总分 ⇒ D14「不能只有一个数字」应变红',
    from: '  return {\n    denominator: pool.length,',
    to: '  return {\n    score: 0,\n    denominator: pool.length,',
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
    results.push({
      name: c.name,
      status: '编译失败（拦下但不是目标形态）',
      detail: errs.split('\n').filter((l) => l.includes('error')).slice(0, 1).join(''),
    })
    writeFileSync(SRC, original, 'utf8')
    continue
  }
  const run = spawnSync('node', ['--test', 'tests/credibility.test.mjs'], { encoding: 'utf8', shell: true })
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
const after = spawnSync('node', ['--test', 'tests/credibility.test.mjs'], { encoding: 'utf8', shell: true })
const afterOut = (after.stdout ?? '') + (after.stderr ?? '')
const afterFail = /ℹ fail (\d+)/.exec(afterOut)

console.log('=== 尸体验证（credibility）===')
for (const r of results) console.log(`${r.status.padEnd(26)} ${r.name}${r.detail ? `\n   └ ${r.detail}` : ''}`)
console.log(`\n恢复后：tsc=${restore.status} · 测试 fail=${afterFail ? afterFail[1] : '?'}`)
