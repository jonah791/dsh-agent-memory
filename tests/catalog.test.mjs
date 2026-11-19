/**
 * §7 编目工作面 · 判据（C 段）——设计正本 `docs/semantic.md` §5.33
 *
 * 这一层守的是**三个分母口径**（应编目分母排除压缩产物 / 四维各自独立 / 可机械覆盖上限是下界），
 * 加一条硬线：**聚簇只建议、不写库**。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  COMPACTION_TAG,
  TAG_MEMTYPE_HINTS,
  catalogGaps,
  catalogReport,
  clusterByTag,
  isCatalogable,
} from '../lib/catalog.js'
import { COLD_CHECKPOINT_TAG } from '../lib/types.js'
import { retentionSummary } from '../lib/retention.js'
import { DEFAULT_CONFIG } from '../lib/config.js'
import { MemoryStore } from '../lib/store.js'
import { createMemoryTools } from '../lib/tools.js'
import { workspaceIdOf } from '../lib/scope.js'

const CWD = 'C:\\Users\\Alice\\proj'
const WID = workspaceIdOf(CWD)
const SESSION = 'session-11111111-2222-3333-4444-555555555555'
const NOW = Date.parse('2026-11-19T12:00:00.000Z')
const DAY = 86_400_000

function entry(partial = {}) {
  const created = partial.createdAt ?? new Date(NOW - 5 * DAY).toISOString()
  return {
    id: partial.id ?? Math.random().toString(36).slice(2),
    kind: partial.kind ?? 'knowledge',
    title: partial.title ?? '条目',
    body: partial.body ?? '正文',
    tags: partial.tags ?? [],
    scope: partial.scope ?? WID,
    createdAt: created,
    updatedAt: partial.updatedAt ?? created,
    accessedAt: partial.accessedAt ?? created,
    level: null,
    bucket: null,
    archived: false,
    ...partial,
  }
}

class MemoryKv {
  constructor() {
    this.map = new Map()
  }
  get(key) {
    const value = this.map.get(key)
    return value === undefined ? undefined : { ...value }
  }
  async put(key, value) {
    this.map.set(key, { ...value })
  }
  async delete(key) {
    return this.map.delete(key)
  }
  entries() {
    return this.map.entries()
  }
  get size() {
    return this.map.size
  }
}

function setup() {
  const kv = new MemoryKv()
  const store = new MemoryStore(kv)
  const tools = createMemoryTools({ store, loadConfig: async () => DEFAULT_CONFIG })
  const byName = new Map(tools.map((t) => [t.name, t]))
  const exec = {
    agent: { session: { id: SESSION, header: { id: SESSION, cwd: CWD } } },
    signal: new AbortController().signal,
  }
  return { kv, store, byName, exec }
}

// ---------- C1 分母排除压缩产物 ----------

test('C1 ★分母排除压缩产物：归档 / 冷存档 / compaction / summary 都不进应编目分母', () => {
  const entries = [
    entry({ id: 'live' }),
    entry({ id: 'archived', archived: true }),
    entry({ id: 'cold', tags: [COLD_CHECKPOINT_TAG] }),
    entry({ id: 'comp', tags: [COMPACTION_TAG] }),
    entry({ id: 'sum', kind: 'summary', level: 'day' }),
  ]
  const report = catalogReport(entries)
  assert.equal(report.denominator, 1, '只有 live 一条该编目')
  assert.equal(report.excluded.archived, 1)
  assert.equal(report.excluded.coldCheckpoint, 1)
  assert.equal(report.excluded.compaction, 1)
  assert.equal(report.excluded.summary, 1, '概要是压缩桶，不属于七类任何一类——必须单列排除')
  assert.equal(isCatalogable(entries[4]), false, 'summary 不是应编目成员')
})

test('C1b 一条 summary 挂在库里不改变覆盖率（分母纯度）', () => {
  const base = [entry({ id: 'a' }), entry({ id: 'b' })]
  const withSummary = [...base, entry({ id: 's', kind: 'summary', level: 'week' })]
  assert.equal(catalogReport(base).gaps.memType.rate, catalogReport(withSummary).gaps.memType.rate,
    '加一条概要后覆盖率必须逐字不变，否则分母被污染')
})

test('C1c ★分项相加 ≠ 净排除：四项有交集，只有 net 能减出分母', () => {
  // 一条「已归档的 summary」会同时进 archived 与 summary 两个分项——这正是线上那 422 条重叠的形状。
  // 2026-11-19 实测：全量 3101 − 应编目 1771 = 净排除 1330，而四项相加 1752 ⇒ 旧渲染把它们
  // 并列成「分母排除：…」，读者相减得 1349，比真分母小 422。
  const entries = [
    entry({ id: 'live1' }),
    entry({ id: 'live2' }),
    entry({ id: 'archOnly', archived: true }),
    entry({ id: 'sumOnly', kind: 'summary', level: 'day' }),
    entry({ id: 'archSum', archived: true, kind: 'summary', level: 'week' }), // 重叠：归档 + 概要
  ]
  const report = catalogReport(entries)
  assert.equal(report.denominator, 2, '只有两条 live 该编目')
  assert.equal(report.excluded.considered, 5, 'considered 是传入集合全量，不是分母')
  assert.equal(report.excluded.net, 3, '净排除 = considered 5 − denominator 2')
  assert.equal(report.excluded.archived, 2, 'archOnly + archSum')
  assert.equal(report.excluded.summary, 2, 'sumOnly + archSum')

  // 核心断言：分项相加必然 ≥ 净排除，等号只在样本无重叠时成立 ⇒ 用它证明「不可相加」
  const naiveSum =
    report.excluded.archived +
    report.excluded.coldCheckpoint +
    report.excluded.compaction +
    report.excluded.summary
  assert.equal(naiveSum, 4)
  assert.equal(naiveSum - report.excluded.net, 1, '重叠 1 条 ⇒ 分项相加比净排除大 1；两者相等说明样本没有重叠，这条断言就空转了')
  assert.equal(report.excluded.considered - report.denominator, report.excluded.net, 'net 必须与「全量 − 分母」恒等')
})

// ---------- C2 四维各自独立 ----------

test('C2 ★四维各自独立：只缺 space 的条目不污染其他三维', () => {
  const entries = [
    entry({ id: 'full', memType: 'semantic', space: 'domain', provenance: 'measured' }),
    entry({ id: 'noSpace', memType: 'semantic', provenance: 'measured' }),
  ]
  const gaps = catalogGaps(entries)
  assert.equal(gaps.memType.missing, 0)
  assert.equal(gaps.space.missing, 1, '只有 noSpace 缺 space')
  assert.equal(gaps.provenance.missing, 0)
  assert.equal(gaps.sourceIds.missing, 2, '两条都没 sourceIds')
  // 刻意的不变量：四维之和 ≠ 条目数（同一条可缺多维）——这不是 bug
  const sum = gaps.memType.missing + gaps.space.missing + gaps.provenance.missing + gaps.sourceIds.missing
  assert.equal(sum, 3, '2（sourceIds）+ 1（space）= 3 ≠ 条目数 2 ⇒ 四维不可相加成一个分数')
})

// ---------- C3 覆盖率口径 ----------

test('C3 覆盖率口径：分母 0 ⇒ rate 0（不是 NaN）', () => {
  const empty = catalogReport([])
  assert.equal(empty.denominator, 0)
  assert.equal(empty.gaps.memType.rate, 0, '空库的覆盖率是 0，不能是 NaN')
  const one = catalogReport([entry({ memType: 'semantic' })])
  assert.equal(one.gaps.memType.rate, 1, '唯一一条有类别 ⇒ 100%')
})

// ---------- C4 聚簇只建议不写入 ----------

test('C4 ★聚簇只建议不写入：跑前后条目逐字段不变，suggested 不落到条目', () => {
  const entries = [
    ...Array.from({ length: 10 }, (_, i) => entry({ id: `s${i}`, title: `技能条目${i}`, tags: ['技能'] })),
    ...Array.from({ length: 10 }, (_, i) => entry({ id: `q${i}`, title: `期货条目${i}`, tags: ['期货'] })),
  ]
  const before = JSON.stringify(entries)
  const report = catalogReport(entries, { minClusterSize: 2 })
  assert.equal(JSON.stringify(entries), before, '编目台是只读的：条目逐字段不变')
  assert.equal(entries[0].memType, undefined, 'suggested 绝不能写回条目')
  assert.equal(report.clusters.length, 2, '两个标签各成一簇')
  const byTag = new Map(report.clusters.map((c) => [c.tag, c.suggested]))
  assert.equal(byTag.get('技能'), 'procedural')
  assert.equal(byTag.get('期货'), 'project')
})

test('C4b 标签不在提示表里 ⇒ 不给建议（不硬塞最近类）', () => {
  const entries = Array.from({ length: 5 }, (_, i) => entry({ id: `x${i}`, tags: ['未收录的怪标签'] }))
  const report = catalogReport(entries, { minClusterSize: 2 })
  assert.equal(report.clusters.length, 1)
  assert.equal(report.clusters[0].suggested, undefined, '没有映射就不给建议——诚实留空')
})

// ---------- C5 贪心覆盖是下界 ----------

test('C5 贪心覆盖：clustered + uncovered == unclassified，且都 ≤ 分母', () => {
  const entries = [
    ...Array.from({ length: 6 }, (_, i) => entry({ id: `a${i}`, tags: ['甲'] })),
    ...Array.from({ length: 4 }, (_, i) => entry({ id: `b${i}`, tags: ['乙'] })),
    ...Array.from({ length: 3 }, (_, i) => entry({ id: `c${i}`, tags: ['丙'] })), // 少于 minClusterSize
  ]
  const report = catalogReport(entries, { minClusterSize: 4 })
  assert.equal(report.clustered + report.uncovered, report.unclassified, '覆盖 + 未覆盖必须等于未分类总数')
  assert.ok(report.clustered <= report.denominator)
  assert.deepEqual(report.clusters.map((c) => c.tag), ['甲', '乙'], '小于阈值的簇不成簇（丙 被排除）')
})

test('C5b 覆盖优先而非频次优先：高重叠标签不各占一个簇位', () => {
  // A 组 20 条都带 [X, Y]；B 组 10 条只带 [Y]
  const entries = [
    ...Array.from({ length: 20 }, (_, i) => entry({ id: `a${i}`, tags: ['X', 'Y'] })),
    ...Array.from({ length: 10 }, (_, i) => entry({ id: `b${i}`, tags: ['Y'] })),
  ]
  const { clusters, clustered } = clusterByTag(entries, { minClusterSize: 2 })
  // 第一步：Y 覆盖 30 条（比 X 的 20 条多）⇒ 选 Y，全部覆盖完
  assert.equal(clusters[0].tag, 'Y')
  assert.equal(clusters[0].count, 30)
  assert.equal(clustered, 30, 'Y 一次覆盖满，X 不应再占簇位（它的成员已被覆盖）')
  assert.equal(clusters.length, 1)
})

// ---------- C6 零标签自报 ----------

test('C6 零标签条目单独计数（不静默消失）', () => {
  const entries = [
    entry({ id: 'tagged', tags: ['技能'] }),
    entry({ id: 'bare1' }),
    entry({ id: 'bare2' }),
  ]
  const report = catalogReport(entries, { minClusterSize: 99 })
  assert.equal(report.zeroTag, 2, '零标签的两条必须自报')
  assert.equal(report.clustered, 0, '阈值太高 ⇒ 一个簇都没有')
  assert.equal(report.uncovered, 3, '三条全部未覆盖')
})

// ---------- C7 样本可核 ----------

test('C7 样本可核：每簇 ≤3 条，id 是全量（能直接喂给 update）', () => {
  const entries = Array.from({ length: 9 }, (_, i) =>
    entry({ id: `full-uuid-${String(i).padStart(4, '0')}-abcd`, title: `样本${i}`, tags: ['技能'] }))
  const report = catalogReport(entries, { minClusterSize: 2 })
  const cluster = report.clusters[0]
  assert.ok(cluster.samples.length <= 3, '样本最多 3 条')
  assert.equal(cluster.samples[0].id.length, 'full-uuid-0000-abcd'.length, 'id 必须是全量而非截断前缀')
  assert.ok(cluster.samples[0].id.startsWith('full-uuid-'), 'id 与条目一致')
})

// ---------- C8 与 §5.32 同口径 ----------

test('C8 ★byEffectiveType 与 retention 同源（不造第二把尺子）', () => {
  const entries = [
    entry({ kind: 'episodic' }),
    entry({ kind: 'fact' }),
    entry({ memType: 'operational' }),
    entry({ kind: 'summary', level: 'day' }), // 不进分母
    entry({ archived: true }), // 不进分母
  ]
  const report = catalogReport(entries)
  const expected = retentionSummary(entries.filter(isCatalogable), NOW)
  assert.deepEqual(report.byEffectiveType, expected.byEffectiveType,
    '同一分母下必须逐字段相等——两处各算一遍必然漂移')
})

// ---------- C9 工具层 ----------

test('C9 ★工具只读 + 返回键与 schema 对齐 + 分母自报', async () => {
  const { kv, byName, exec } = setup()
  const tool = byName.get('memory_catalog')
  assert.ok(tool !== undefined, 'memory_catalog 必须注册')
  await byName.get('remember').execute({ text: '编目台判据用的种子条目，带一个技能标签', kind: 'knowledge', tags: ['技能'] }, exec)
  await byName.get('remember').execute({ text: '编目台判据用的另一条种子条目，什么都不标', kind: 'knowledge' }, exec)

  const snap = () => JSON.stringify([...kv.entries()].sort(([a], [b]) => (a < b ? -1 : 1)))
  const before = snap()
  const value = await byName.get('memory_catalog').execute({}, exec)
  assert.equal(snap(), before, 'memory_catalog 必须只读：存储逐字节不变（含 accessedAt）')

  // 返回键必须都在 schema 里（宿主 additionalProperties:false 会整条拒收）
  const schemaProps = new Set(Object.keys(tool.output.schema.properties ?? {}))
  for (const key of Object.keys(value)) {
    assert.ok(schemaProps.has(key), `返回键 ${key} 未在 output.schema 声明 ⇒ 宿主会整条拒收`)
  }
  // 分母自报：写入两条后，排除项必须是显式的 0 而不是缺失
  assert.ok(value.denominator >= 2)
  assert.equal(typeof value.excluded.summary, 'number', '排除项必须显式给 0，不能省略')
  // 渲染必须能跑通（有无簇都不能崩）
  const text = tool.output.render({}, value).map((c) => c.text).join('\n')
  assert.match(text, /编目工作面/, '渲染要有表头')
  assert.match(text, /上限|覆盖/, '渲染必须说清覆盖情况')
})

test('C10 提示表只含合法类别（防止手滑写错枚举）', () => {
  const valid = new Set(['episodic', 'semantic', 'procedural', 'profile', 'project', 'relational', 'operational'])
  for (const [tag, type] of Object.entries(TAG_MEMTYPE_HINTS)) {
    assert.ok(valid.has(type), `${tag} → ${type} 不是合法 memType`)
  }
})

test('C11 ★ credibility 的口径必须印在渲染里（同数并列时的误读防线）', async () => {
  const { byName, exec } = setup()
  const tool = byName.get('memory_catalog')
  await byName.get('remember').execute({ text: '口径判据用的种子条目，什么都不标', kind: 'knowledge' }, exec)
  const value = await tool.execute({}, exec)
  const text = tool.output.render({}, value).map((c) => c.text).join('\n')

  // ① 新段必须进渲染——只写在结构化返回里等于没做（v0.24.3 同形教训）
  assert.match(text, /四维可信度/, 'credibility 段没进渲染 ⇒ 到不了人眼前')
  assert.ok(value.credibility.dimensions.length === 4)

  // ② ★ 口径句必须在：线上实测（15:38）出现「核验 unknown 1309」与「归档 1309」同数，
  //    两组数毫无关系（分母已排除归档），但并列出现时读者会怀疑其中一个把另一个算进去了。
  //    这是「读数层表达缺陷」的第四次同形 ⇒ 把口径写进渲染，不指望读者自己想到。
  assert.match(text, /归档已排除/, '口径必须紧贴在数后面')
  assert.match(text, /巧合/, '同数时要明说「不是串了」——不说就会被当成 bug')

  // ③ 代理维的边界必须出现在人眼前（只写在 schema description 里不算）
  assert.match(text, /代理/, 'proxy 维的 caveat 必须渲染')
  assert.match(text, /不含总分/, '「可信度不能只有一个数字」是方案原话，渲染里必须说清')

  // ④ 两段分母必须是同一个数（各报一个会让「差在哪」不可见）
  assert.equal(value.credibility.denominator, value.denominator)
})

test('C12 ★分项不可相加的口径必须进渲染（读数层表达缺陷·第五次同形）', async () => {
  const { byName, exec } = setup()
  const tool = byName.get('memory_catalog')
  await byName.get('remember').execute({ text: '分母口径判据用的种子条目，什么都不标', kind: 'knowledge' }, exec)
  const value = await tool.execute({}, exec)
  const text = tool.output.render({}, value).map((c) => c.text).join('\n')

  // ① 净排除必须是显式的数——让读者自己把四个分项相减，正是那 422 条误差的来源
  assert.equal(typeof value.excluded.net, 'number', 'net 必须显式给')
  assert.equal(typeof value.excluded.considered, 'number', 'considered 必须显式给')
  assert.match(text, /净排除/, '净排除是唯一可减的数，必须渲染')

  // ② ★ 并列四个分项就必须同时给「它们不能相加」的理由：并列而无警告，读法上就在诱导相加
  assert.match(text, /不可相加/, '分项并列时必须显式标不可相加')
  assert.match(text, /交集/, '说清为什么不可相加（有交集）')

  // ③ 可核性：三个数之间必须自洽，渲染层不得自己重算一个。
  //    ⚠ 这条断言在本样本（无排除项）上**恒成立**——四项和与净排除都是 0，它抓不到「用四项相加算 net」
  //    这个错（尸体验证 2026-11-19：注入该错后只有 C1c 红，本格仍绿）。真正判交集与自洽的是 C1c；
  //    这里的分工只是「防止渲染层偏离结构化返回」，不要把它当成覆盖了自洽性。
  assert.equal(value.excluded.considered, value.denominator + value.excluded.net)
})
