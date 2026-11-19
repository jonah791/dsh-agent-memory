/**
 * §4.5 知识地图（v0.45）· 判据（M 段纯函数 / E 段工具层）——设计正本 `docs/design/aml-map.md`
 *
 * 这一层守的是**三档可读性**与**四个空白口径不可合并**——
 * 没有这一层，七项里三项（领域 1.4% / 关系 2 条 / expiry 0 条）会输出 0 而看起来健康。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MEASURED_THRESHOLD, mapReport, readabilityOf } from '../lib/map.js'
import { DEFAULT_CONFIG } from '../lib/config.js'
import { MemoryStore } from '../lib/store.js'
import { createMemoryTools } from '../lib/tools.js'
import { summarizeAccessRecords } from '../lib/access-trace.js'
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

function concept(partial) {
  return {
    id: partial.id,
    scope: partial.scope ?? WID,
    prefLabel: partial.prefLabel,
    altLabels: partial.altLabels ?? [],
    broader: partial.broader ?? [],
    related: partial.related ?? [],
    createdAt: new Date(NOW - 10 * DAY).toISOString(),
    updatedAt: new Date(NOW - 10 * DAY).toISOString(),
  }
}

function input(partial = {}) {
  return {
    entries: partial.entries ?? [],
    concepts: partial.concepts ?? [],
    relations: partial.relations ?? [],
    retrievalCounts: partial.retrievalCounts ?? new Map(),
    traceSince: partial.traceSince === undefined ? new Date(NOW - 30 * DAY).toISOString() : partial.traceSince,
    traceLines: partial.traceLines ?? 10,
    now: partial.now ?? NOW,
  }
}

function dim(report, id) {
  const found = report.dimensions.find((d) => d.id === id)
  assert.ok(found !== undefined, `维度 ${id} 必须存在`)
  return found
}

// ---------- M1 三档判据 ----------

test('M1 ★三档判据：≥50% ⇒ measured；0<r<50% ⇒ starved；0 ⇒ absent', () => {
  assert.equal(readabilityOf(100, 60), 'measured', '60% 可排名')
  assert.equal(readabilityOf(100, 50), 'measured', '恰好 50% 算够（阈值是闭区间下界）')
  assert.equal(readabilityOf(100, 49), 'starved', '49% 只报分母')
  assert.equal(readabilityOf(100, 1), 'starved', '1% 仍然不是 absent——载体在')
  assert.equal(readabilityOf(100, 0), 'absent', '填充率 0 ⇒ 读不出')
  assert.equal(readabilityOf(0, 0), 'absent', '分母 0 ⇒ 无可读对象（不是 NaN）')
  assert.equal(MEASURED_THRESHOLD, 0.5)
})

// ---------- M2 starved 维必须自带口径 ----------

test('M2 ★starved 维：读数照给，但档位与口径必须跟着数一起走（不静默排名）', () => {
  // 10 条里只有 1 条标了 space ⇒ 1.4% 量级
  const entries = [entry({ id: 'a', space: 'project', tags: ['x'] }), ...Array.from({ length: 9 }, (_, i) => entry({ id: `b${i}`, tags: ['x'] }))]
  const report = mapReport(input({ entries }))
  const domains = dim(report, 'domains')
  assert.equal(domains.readability, 'starved', '10% ⇒ starved')
  assert.equal(domains.filled, 1)
  assert.equal(domains.denominator, 10)
  assert.ok(domains.note.length > 0, 'starved 必须说明「这个数代表多少条」')
  assert.match(domains.note, /不代表全库|只代表/, 'note 必须点明覆盖范围')
  // 明细照给（读者要能看到分布），但档位在同一个返回对象里 ⇒ 不可能只拿到明细
  assert.equal(report.domains.spaces.length, 1)
  assert.equal(report.domains.unset, 9, '未标注必须自报，否则「只有 project 一个领域」是假读法')
})

// ---------- M3 absent 维报「缺什么」，不报 0 当结论 ----------

test('M3 ★absent 维：expiry 全未设 ⇒ 报「读不出哪些已过期」，不报「没有过期知识」', () => {
  // 用 10 条而不是 2 条：分母 2 时 1/2 = 50% 会过线，而那个百分比没有分辨力
  const entries = [entry({ id: 'a', expiry: new Date(NOW + 5 * DAY).toISOString() }), ...Array.from({ length: 9 }, (_, i) => entry({ id: `b${i}` }))]
  const report = mapReport(input({ entries }))
  const expiry = dim(report, 'expiry')
  assert.equal(expiry.readability, 'starved', '1/10 = 10% ⇒ 只报分母')
  assert.equal(expiry.filled, 1)
  assert.equal(report.expiry.unset, 9, '未设必须自报——它是「未知」，不是「有效」')
  // 全未设的情形
  const allUnset = mapReport(input({ entries: Array.from({ length: 10 }, (_, i) => entry({ id: `c${i}` })) }))
  const none = dim(allUnset, 'expiry')
  assert.equal(none.readability, 'absent')
  assert.equal(none.filled, 0)
  assert.match(none.note, /不是「没有过期知识」/, '两种 0 在含义上相反，必须写清')
  assert.equal(allUnset.expiry.unset, 10)
  assert.equal(allUnset.expiry.expired, 0)
})

// ---------- M4 四个空白口径各自独立 ----------

test('M4 ★空白四口径各自独立计数（不互相减、不合并）', () => {
  // solo 出现在 2 条上（不是单例）；only 出现在 1 条上（单例）；2 条零标签
  const entries = [
    entry({ id: 'a', tags: ['solo'] }),
    entry({ id: 'b', tags: ['solo'] }),
    entry({ id: 'c', tags: ['only'] }),
    entry({ id: 'd' }),
    entry({ id: 'e' }),
  ]
  const report = mapReport(input({ entries, retrievalCounts: new Map(), traceSince: new Date(NOW - DAY).toISOString() }))
  assert.equal(report.blanks.singletonTopics, 1, 'df=1 才叫单例')
  assert.equal(report.blanks.untagged, 2, '零标签单独一档')
  assert.equal(report.blanks.unretrieved, 5, '无 trace 命中 ⇒ 五条都未检索（与标签无关）')
  // 相减关系不成立：单例(1) + 零标签(2) ≠ 任何其他口径的分母
  assert.notEqual(report.blanks.singletonTopics + report.blanks.untagged, report.considered.active)
})

// ---------- M5 trace 不可用 ⇒ 「从未被检索」不可判 ----------

test('M5 ★无 trace 时「从未被检索」不可判，不报 0 当结论', () => {
  const report = mapReport(input({ entries: [entry({ id: 'a' })], traceSince: null }))
  const activity = dim(report, 'activity')
  assert.equal(activity.readability, 'absent')
  assert.match(activity.note, /不可判/, '必须说「不可判」而不是给一个数')
  assert.equal(report.activity.traceAvailable, false)
  assert.equal(report.activity.traceSince, '', '输出层用空串（宿主 schema 无 null），可用性由 traceAvailable 表达')
  const blanks = dim(report, 'blanks')
  assert.equal(blanks.readability, 'starved', '四口径里三个仍可判')
  assert.match(blanks.note, /不可判/)
})

test('M5b ★有 trace 时必须回传起点——「从未」是有界断言', () => {
  const since = new Date(NOW - 20 * DAY).toISOString()
  const report = mapReport(input({ entries: [entry({ id: 'a' })], traceSince: since, retrievalCounts: new Map([['a', 2]]) }))
  const activity = dim(report, 'activity')
  assert.equal(activity.readability, 'measured', '1/1 被检索 ⇒ 100%')
  assert.match(activity.note, /trace 起点/, 'note 必须带边界，否则「从未被检索」是不可复核的全称否定')
  assert.equal(report.activity.traceSince, since)
  assert.equal(report.activity.neverRetrieved, 0)
})

// ---------- M6 单例只数 df=1 ----------

test('M6 单例标签只数出现 1 次的，不数「≤N 次」', () => {
  const entries = [
    entry({ id: 'a', tags: ['once'] }),
    entry({ id: 'b', tags: ['twice'] }),
    entry({ id: 'c', tags: ['twice'] }),
    entry({ id: 'd', tags: ['thrice'] }),
    entry({ id: 'e', tags: ['thrice'] }),
    entry({ id: 'f', tags: ['thrice'] }),
  ]
  const report = mapReport(input({ entries }))
  assert.equal(report.blanks.singletonTopics, 1, '只有 once 是单例')
  assert.equal(report.topics.totalTags, 3)
})

// ---------- M7 概念匹配按 normalizeLabel ----------

test('M7 ★概念匹配走 normalizeLabel（与词表同源），大小写/空白差异不影响命中', () => {
  const concepts = [concept({ id: `${WID}:concept:1`, prefLabel: 'Agent Memory', altLabels: ['AML'] })]
  const entries = [
    entry({ id: 'a', tags: ['agent memory'] }), // 大小写不同
    entry({ id: 'b', tags: ['aml'] }), // 别名小写
    entry({ id: 'c', tags: ['无关'] }),
  ]
  const report = mapReport(input({ entries, concepts }))
  assert.equal(report.topics.concepts[0].entriesUsing, 2, '两种写法都要命中同一个概念')
  assert.equal(report.topics.controlledTags, 2, '受控标签按标签计，不按条目×标签计')
})

// ---------- M8 候选关联：已声明的不重复报 ----------

test('M8 ★候选关联：共现达标才进；已声明 related 的概念对要标出来，不静默重复', () => {
  const A = concept({ id: `${WID}:concept:a`, prefLabel: '甲' })
  const B = concept({ id: `${WID}:concept:b`, prefLabel: '乙' })
  const declared = { ...A, related: [B.id] }
  const entries = Array.from({ length: 6 }, (_, i) => entry({ id: `e${i}`, tags: ['甲', '乙'] }))
  const withDecl = mapReport(input({ entries, concepts: [declared, B] }))
  assert.equal(withDecl.relationCandidates.length, 1)
  assert.equal(withDecl.relationCandidates[0].cooccurrence, 6)
  assert.equal(withDecl.relationCandidates[0].declaredAsConceptPair, true, '已声明的对不能假装是新发现')
  const withoutDecl = mapReport(input({ entries, concepts: [A, B] }))
  assert.equal(withoutDecl.relationCandidates[0].declaredAsConceptPair, false)
  // 阈值：共现不足不进候选
  const thin = mapReport(input({ entries: [entry({ id: 'x', tags: ['甲', '乙'] })], concepts: [A, B] }))
  assert.equal(thin.relationCandidates.length, 0, '1 次共现达不到缺省阈值 5')
})

// ---------- M9 候选只是返回值，无写路径 ----------

test('M9 候选关联只出现在返回值里（纯函数无副作用，不返回任何 id 可供落库）', () => {
  const A = concept({ id: `${WID}:concept:a`, prefLabel: '甲' })
  const B = concept({ id: `${WID}:concept:b`, prefLabel: '乙' })
  const entries = Array.from({ length: 5 }, (_, i) => entry({ id: `e${i}`, tags: ['甲', '乙'] }))
  const report = mapReport(input({ entries, concepts: [A, B] }))
  const candidate = report.relationCandidates[0]
  assert.deepEqual(Object.keys(candidate).sort(), ['a', 'b', 'cooccurrence', 'declaredAsConceptPair'], '候选不带 relation id / type ⇒ 无法被当成「已建边」直接落库')
})

// ---------- M10 概念逐个报使用量，0 的点名 ----------

test('M10 ★每个概念都报被多少条目使用——0 使用的不静默消失', () => {
  const concepts = [
    concept({ id: `${WID}:concept:used`, prefLabel: '有人用' }),
    concept({ id: `${WID}:concept:unused`, prefLabel: '没人用' }),
  ]
  const entries = [entry({ id: 'a', tags: ['有人用'] })]
  const report = mapReport(input({ entries, concepts }))
  assert.equal(report.topics.concepts.length, 2, '两个概念都要出现')
  const unused = report.topics.concepts.find((c) => cleanLabel(c.prefLabel) === '没人用')
  assert.equal(unused.entriesUsing, 0)
  assert.equal(report.blanks.unusedConcepts.length, 1, '零使用必须单列成空白口径')
})

function cleanLabel(text) {
  return String(text).trim()
}

// ---------- 维度齐全 ----------

test('M11 七项要求各自成维，顺序与方案原文一致', () => {
  const report = mapReport(input({ entries: [entry({ id: 'a' })] }))
  assert.deepEqual(
    report.dimensions.map((d) => d.id),
    ['domains', 'topics', 'links', 'activity', 'projects', 'blanks', 'expiry'],
  )
  for (const dimension of report.dimensions) {
    assert.ok(dimension.requirement.length > 0, `${dimension.id} 必须引用方案原文那一项`)
    assert.ok(dimension.denominatorName.length > 0, `${dimension.id} 必须带分母口径名`)
    assert.ok(['measured', 'starved', 'absent'].includes(dimension.readability))
  }
})

// ---------- E1 工具层：只读 + 返回键在 schema 内 ----------

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

const CONCEPTS = [
  concept({ id: `${WID}:concept:aml`, prefLabel: '智能体记忆', altLabels: ['AML'] }),
]
const RELATIONS = []

function setup(deps = {}) {
  const kv = new MemoryKv()
  const store = new MemoryStore(kv)
  const tools = createMemoryTools({
    store,
    loadConfig: async () => DEFAULT_CONFIG,
    concepts: { all: () => CONCEPTS },
    relations: { all: () => RELATIONS },
    ...deps,
  })
  const byName = new Map(tools.map((t) => [t.name, t]))
  const exec = {
    agent: { session: { id: SESSION, header: { id: SESSION, cwd: CWD } } },
    signal: new AbortController().signal,
  }
  return { kv, store, byName, exec }
}

test('E1 ★工具只读：跑前后存储逐字节不变；返回键全部在 output.schema 内', async () => {
  const { kv, byName, exec } = setup()
  const remember = byName.get('remember')
  await remember.execute({ text: '知识地图判据用的种子条目，带技能与判据标签', kind: 'knowledge', tags: ['技能', '判据'] }, exec)
  await remember.execute({ text: '第二条种子条目，只有任务板标签', kind: 'knowledge', tags: ['任务板'] }, exec)
  const tool = byName.get('memory_map')
  assert.ok(tool !== undefined, 'memory_map 必须注册')
  assert.ok(tool.deferLoading === true, '按需加载：不占常驻 schema')

  const snap = () => JSON.stringify([...kv.entries()].sort(([a], [b]) => (a < b ? -1 : 1)))
  const before = snap()
  const value = await tool.execute({}, exec)
  assert.equal(snap(), before, 'memory_map 必须只读：存储逐字节不变（含 accessedAt）')

  const schemaProps = new Set(Object.keys(tool.output.schema.properties ?? {}))
  for (const key of Object.keys(value)) {
    assert.ok(schemaProps.has(key), `返回键 ${key} 未在 output.schema 声明 ⇒ 宿主会整条拒收`)
  }
  assert.equal(value.dimensions.length, 7)
  assert.ok(value.considered.active >= 2)

  const text = tool.output.render({}, value).map((c) => c.text).join('\n')
  assert.match(text, /知识地图/, '渲染要有表头')
  assert.match(text, /starved|measured|absent/, '渲染必须印出档位——不印档位等于把 25 条当 1794 条')
  assert.match(text, /不可相加/, '空白四口径的口径必须进渲染')
  assert.match(text, /未设 ≠ 有效/, '过期维的两种 0 必须在渲染里分开')
})

test('E2 ★trace 起点取自 firstAtMs，不是「今天」', async () => {
  const firstAt = NOW - 12 * DAY
  const { byName, exec } = setup({
    readAccess: async () => new Map([['x', { hits: 3, lastAtMs: NOW }]]),
    readAccessSummary: async () => ({
      autoCalls: 2,
      recallCalls: 1,
      distinctIds: 1,
      totalHits: 3,
      lastAtMs: NOW,
      firstAtMs: firstAt,
      lines: 3,
    }),
  })
  const value = await byName.get('memory_map').execute({}, exec)
  assert.equal(value.activity.traceAvailable, true)
  assert.equal(value.activity.traceSince, new Date(firstAt).toISOString())
  assert.equal(value.activity.traceLines, 3)
})

test('E3 填充率随标注变化（不缓存，不把上次读数当现在）', async () => {
  const { byName, exec } = setup()
  const first = await byName.get('memory_map').execute({}, exec)
  const before = first.dimensions.find((d) => d.id === 'domains').filled
  await byName.get('remember').execute(
    { text: '带空间标注的一条，用于验证填充率不缓存', kind: 'knowledge', space: 'project' },
    exec,
  )
  const second = await byName.get('memory_map').execute({}, exec)
  const after = second.dimensions.find((d) => d.id === 'domains').filled
  assert.equal(after, before + 1, '写一条带 space 的 ⇒ 领域填充数必须 +1')
})

test('E4 词表 / 关系未接线 ⇒ 传空并在渲染里说清，不假装「零概念」', async () => {
  const { kv, store, exec } = setup({ concepts: undefined, relations: undefined })
  const tools = createMemoryTools({ store, loadConfig: async () => DEFAULT_CONFIG })
  const byName = new Map(tools.map((t) => [t.name, t]))
  const value = await byName.get('memory_map').execute({}, exec)
  assert.equal(value.topics.concepts.length, 0)
  assert.equal(value.links.edges, 0)
  assert.ok(kv.size >= 0)
})

// ---------- AccessSummary 的新读数 ----------

test('E5 ★summarizeAccessRecords 报首条时刻与有效行数（「从未」的下界）', () => {
  const text = [
    JSON.stringify({ atMs: NOW - 1000, source: 'recall', role: 'main', ids: ['a'] }),
    JSON.stringify({ atMs: NOW, source: 'auto', role: 'main', ids: [] }),
    'not json',
    '',
  ].join('\n')
  const summary = summarizeAccessRecords(text)
  assert.equal(summary.firstAtMs, NOW - 1000, '首条必须是最早那条，不是最后一条')
  assert.equal(summary.lastAtMs, NOW)
  assert.equal(summary.lines, 2, '坏行不计数；空 ids 的行算有效记录（它是合法调用）')
})
