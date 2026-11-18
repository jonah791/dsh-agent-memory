/**
 * 类型化关系层单测（v0.28.0 · 方案 §4.4）——relations.ts 纯函数 + 存储 + 工具层 + 端到端存活。
 * 运行：npm test（tsc 后 node --test "tests/*.test.mjs"，导入编译产物 lib/*.js）
 *
 * 覆盖：
 *   R1 建立与双向读：out 读「支持」、in 读「被支持」，对端标题可解析
 *   R2 幂等：同 (type, from, to) 再写 → created=false、库里仍只有一条边
 *   R3 fail-loud 三例：supersedes 拒写 / 对端不存在整笔拒绝 / 自环拒绝（且一条不写）
 *   R4 退役语义：unlink 后默认不可见、includeExpired 可见（live=false）、二次退役不改写时刻
 *   R5 派生结构边：supersededBy / archiveRef 读成结构边，但**不落盘**（relations 表不增长）
 *   R6 端到端存活：relationSchema 真 parse 后每个字段都还在（防「未声明字段被静默剥掉」）
 *   R7 分区过滤：读 scopes 之外的边不返回（关系层不得成为隔离缺口）
 *   R8 统计：byType 之和 == total；未接线时 wired=false（**「没接线」≠「零条」**）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore } from '../lib/store.js'
import { RelationStore, edgesOf, isRelationLive, structuralEdgesOf } from '../lib/relations.js'
import { createMemoryTools } from '../lib/tools.js'
import { relationSchema } from '../lib/index.js'
import { workspaceIdOf } from '../lib/scope.js'
import { parseEvidenceRefsArg } from '../lib/evidence.js'

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

const CWD = 'C:\\Users\\Alice\\proj'
const WID = workspaceIdOf(CWD)
const CONFIG = { maxEntries: 500, layers: ['fact', 'knowledge', 'episodic', 'summary'] }

function setup() {
  const store = new MemoryStore(new MemoryKv())
  const relations = new RelationStore(new MemoryKv())
  const tools = createMemoryTools({ store, relations, loadConfig: () => CONFIG })
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  // ⚠ cwd 必须挂在 `agent.session.header` 下（`sessionCwdOf` 的真实载体）；
  // 挂在顶层 `session` 上会让读作用域降级成只 global，而夹具条目写在 WID ⇒ 「未找到」。
  const exec = { agent: { session: { id: 'session-rel', header: { cwd: CWD } } } }
  return { store, relations, byName, exec }
}

async function seed(store, title, extra = {}) {
  const result = await store.remember({
    kind: 'knowledge',
    title,
    body: `${title} 的正文`,
    tags: [],
    scope: WID,
    level: null,
    bucket: null,
    ...extra,
  })
  return result.id
}

test('R1 建立与双向读：out 读「支持」、in 读「被支持」', async () => {
  const { store, byName, exec } = setup()
  const evidence = await seed(store, '证据条目')
  const conclusion = await seed(store, '结论条目')
  const link = byName.get('memory_link')
  const read = byName.get('memory_relations')

  const created = await link.execute({ type: 'supports', from: evidence, to: conclusion, provenance: 'measured' }, exec)
  assert.equal(created.created, true)
  assert.equal(created.label, '支持')

  const fromSide = await read.execute({ id: evidence }, exec)
  assert.equal(fromSide.edges.length, 1)
  assert.equal(fromSide.edges[0].direction, 'out')
  assert.equal(fromSide.edges[0].label, '支持')
  assert.equal(fromSide.edges[0].peer, conclusion)
  assert.equal(fromSide.edges[0].peerTitle, '结论条目')

  const toSide = await read.execute({ id: conclusion }, exec)
  assert.equal(toSide.edges.length, 1)
  assert.equal(toSide.edges[0].direction, 'in')
  assert.equal(toSide.edges[0].label, '被支持')

  // 方向过滤：in / out 各只返回一侧
  const onlyIn = await read.execute({ id: conclusion, direction: 'out' }, exec)
  assert.equal(onlyIn.edges.length, 0, '结论条目没有出边 ⇒ direction=out 必须返回 0 条')
})

test('R2 幂等：同 (type, from, to) 再写 → created=false、库里仍只有一条边', async () => {
  const { store, relations, byName, exec } = setup()
  const a = await seed(store, '甲')
  const b = await seed(store, '乙')
  const link = byName.get('memory_link')

  const first = await link.execute({ type: 'related-to', from: a, to: b, provenance: 'self' }, exec)
  const second = await link.execute({ type: 'related-to', from: a, to: b, provenance: 'self' }, exec)
  assert.equal(second.created, false, '重复写入必须报 created=false（幂等）')
  assert.equal(second.id, first.id, '幂等命中必须返回既有边 id（不是新 id）')
  assert.equal(relations.all().length, 1, '库里不得出现第二条同型同向边')

  // 反向是另一条边（方向有意义，不是同一件事）
  const reverse = await link.execute({ type: 'related-to', from: b, to: a, provenance: 'self' }, exec)
  assert.equal(reverse.created, true)
  assert.equal(relations.all().length, 2)
})

test('R3 fail-loud：supersedes 拒写 / 对端不存在整笔拒绝 / 自环拒绝', async () => {
  const { store, relations, byName, exec } = setup()
  const a = await seed(store, '甲')
  const b = await seed(store, '乙')
  const link = byName.get('memory_link')

  await assert.rejects(
    () => link.execute({ type: 'supersedes', from: a, to: b, provenance: 'self' }, exec),
    /唯一写入口是 `memory_supersede`/,
    'supersedes 必须由 memory_link 拒写（一个事实一个归宿）',
  )
  await assert.rejects(
    () => link.execute({ type: 'supports', from: a, to: 'no-such-id', provenance: 'self' }, exec),
    /未找到/,
    '对端不存在必须整笔拒绝',
  )
  await assert.rejects(
    () => link.execute({ type: 'supports', from: a, to: a, provenance: 'self' }, exec),
    /自环/,
  )
  await assert.rejects(
    () => link.execute({ type: 'supports', from: a, to: b, provenance: '' }, exec),
    // 两道门：工具框架的 enum 校验在先，执行层 parseProvenanceArg 在后。
    // 断言只要求「provenance 被拒」——两道门任一拦住都算（判据不比自己更严）。
    /provenance|provenance 必填/,
    'provenance 无默认值（空串也必须拒绝，不许猜成 self）',
  )
  assert.equal(relations.all().length, 0, '三次失败调用不得留下任何半成品边')
})

test('R4 退役语义：默认不可见、includeExpired 可见、二次退役不改写时刻', async () => {
  const { store, relations, byName, exec } = setup()
  const a = await seed(store, '甲')
  const b = await seed(store, '乙')
  const link = byName.get('memory_link')
  const read = byName.get('memory_relations')
  const unlink = byName.get('memory_unlink')

  const edge = await link.execute({ type: 'depends-on', from: a, to: b, provenance: 'self' }, exec)
  const first = await unlink.execute({ id: edge.id, reason: '依赖已解除' }, exec)
  assert.equal(first.changed, true)
  assert.notEqual(first.validTo, undefined)

  const afterDefault = await read.execute({ id: a }, exec)
  assert.equal(afterDefault.edges.length, 0, '已退役的边默认不返回')

  const afterIncluded = await read.execute({ id: a, includeExpired: true }, exec)
  assert.equal(afterIncluded.edges.length, 1, 'includeExpired 必须能看到已退役的边（历史仍可查）')
  assert.equal(afterIncluded.edges[0].live, false)

  const second = await unlink.execute({ id: edge.id }, exec)
  assert.equal(second.changed, false, '二次退役必须报 changed=false')
  assert.equal(second.validTo, first.validTo, '二次退役不得改写退役时刻')
  assert.equal(relations.all().length, 1, '退役不删除记录')
})

test('R5 派生结构边：读得到、但**不落盘**', async () => {
  const { store, relations, byName, exec } = setup()
  const oldId = await seed(store, '旧结论')
  const newId = await seed(store, '新结论')
  // supersede 两侧（模拟 memory_supersede 的写入结果）
  await store.update(WID, newId, { supersedes: [oldId] })
  await store.update(WID, oldId, { supersededBy: newId })
  // 概要 → 原料（archiveRef）
  const sourceId = await seed(store, '原料观察')
  const summaryId = await seed(store, '日概要', { kind: 'summary', archiveRef: [sourceId] })

  const read = byName.get('memory_relations')
  const onNew = await read.execute({ id: newId }, exec)
  assert.equal(onNew.structural.length, 1, '新结论应有一条派生「取代」边')
  assert.equal(onNew.structural[0].type, 'supersedes')
  assert.equal(onNew.structural[0].direction, 'out')
  assert.equal(onNew.structural[0].peer, oldId)

  const onOld = await read.execute({ id: oldId }, exec)
  assert.equal(onOld.structural[0].direction, 'in', '旧条目那侧读作「被取代」')

  const onSummary = await read.execute({ id: summaryId }, exec)
  const derived = onSummary.structural.filter((edge) => edge.origin === 'archiveRef')
  assert.equal(derived.length, 1)
  assert.equal(derived[0].label, '派生自')

  // 关键：派生边来自字段，**不写关系表**（否则同一事实两个真源）
  assert.equal(relations.all().length, 0, '派生边不得落盘——字段是唯一真源')

  // 纯函数层同源：structuralEdgesOf 与工具读路径一致（两侧都写过也只算一条）
  const entries = store.list(WID, { includeArchive: true })
  const edges = structuralEdgesOf(entries)
  assert.equal(edges.filter((edge) => edge.type === 'supersedes' && edge.from === newId && edge.to === oldId).length, 1)
})

test('R6 端到端存活：relationSchema 真 parse 后每个字段都还在', async () => {
  const { store, relations, byName, exec } = setup()
  const a = await seed(store, '甲')
  const b = await seed(store, '乙')
  const link = byName.get('memory_link')
  const edge = await link.execute({
    type: 'supports',
    from: a,
    to: b,
    provenance: 'measured',
    confidence: 0.8,
    validFrom: '2026-11-01',
    evidenceRefs: ['session|session-rel|7'],
    note: '实测三条样本',
  }, exec)

  const stored = relations.find(edge.id)
  assert.notEqual(stored, undefined)
  // 真 parse（不是 grep）：未在 relationSchema 声明的字段会被静默剥掉 ⇒ 这条判据会红
  const parsed = relationSchema.parse(stored)
  for (const field of ['id', 'type', 'from', 'to', 'fromKind', 'toKind', 'scope', 'provenance', 'confidence', 'validFrom', 'evidenceRefs', 'note', 'createdAt']) {
    assert.ok(field in parsed, `写入边界剥掉了 ${field}——relationSchema 未声明它（本仓已踩过十三次的坑）`)
  }
  assert.equal(parsed.confidence, 0.8)
  assert.equal(parsed.note, '实测三条样本')
  assert.deepEqual(parsed.evidenceRefs, ['session|session-rel|7'])
})

test('R7 分区过滤：读 scopes 之外的边不返回', async () => {
  const { store, byName, exec } = setup()
  const a = await seed(store, '甲')
  const b = await seed(store, '乙')
  await byName.get('memory_link').execute({ type: 'uses', from: a, to: b, provenance: 'self' }, exec)

  const read = byName.get('memory_relations')
  const inScope = await read.execute({ id: a, scope: WID }, exec)
  assert.equal(inScope.edges.length, 1, '同分区内应可见')

  const outOfScope = await read.execute({ id: a, scope: 'global' }, exec)
  // 显式 scope=global ⇒ 读作用域不含 WID ⇒ 连目标条目都找不到（关系层不越权取数）
  assert.equal(outOfScope.ok, false, '目标不在读作用域内时必须报找不到，而不是返回别的分区的边')
})

test('R8 统计：byType 之和 == total；未接线时 wired=false', async () => {
  const { store, relations, byName, exec } = setup()
  const a = await seed(store, '甲')
  const b = await seed(store, '乙')
  const link = byName.get('memory_link')
  await link.execute({ type: 'supports', from: a, to: b, provenance: 'measured' }, exec)
  await link.execute({ type: 'refutes', from: b, to: a, provenance: 'self' }, exec)

  const stats = await byName.get('memory_stats').execute({}, exec)
  assert.equal(stats.relations.wired, true)
  assert.equal(stats.relations.total, 2)
  const sum = Object.values(stats.relations.byType).reduce((acc, n) => acc + n, 0)
  assert.equal(sum, stats.relations.total, 'byType 之和必须等于 total')
  assert.equal(stats.relations.byType.supports, 1)
  assert.equal(stats.relations.byType.refutes, 1)
  assert.equal(stats.relations.nodesCovered, 2, '两条边覆盖两个条目')
  assert.equal(relations.stats().expired, 0)

  // 未接线：wired=false（「没接线」不能长得像「零条」）
  const unwired = createMemoryTools({ store, loadConfig: () => CONFIG })
    .find((tool) => tool.name === 'memory_stats')
  const unwiredStats = await unwired.execute({}, exec)
  assert.equal(unwiredStats.relations.wired, false)
  assert.equal(unwiredStats.relations.total, 0)

  // 未接线时关系工具必须响亮报错（不假装成功）
  const unwiredRead = createMemoryTools({ store, loadConfig: () => CONFIG })
    .find((tool) => tool.name === 'memory_relations')
  await assert.rejects(() => unwiredRead.execute({ id: a }, exec), /关系层未接线/)
})

test('R10 memory_relate 的 typed 段不因对端归档而消失（线上 00:31 缺陷的反例）', async () => {
  const { store, byName, exec } = setup()
  const conclusion = await seed(store, '结论条目')
  const source = await seed(store, '原料条目')
  await byName.get('memory_link').execute({ type: 'derived-from', from: conclusion, to: source, provenance: 'measured' }, exec)
  // 把对端归档（模拟压缩链把原料归档成冷存档）
  await store.forget(WID, source, { reasonType: 'capacity', reason: 'R10 夹具' })

  const relate = await byName.get('memory_relate').execute({ id: conclusion }, exec)
  assert.equal(
    relate.typed.length,
    1,
    '对端已归档时边仍必须出现——「这条结论派生自已归档的观察」正是最需要被看见的边；'
    + '首版复用 includeArchive=false 的集合，线上实测报 0 条（同一刻 memory_relations 报 1 条）',
  )
  assert.equal(relate.typed[0].peer, source)
})

test('R9 纯函数：有效期判据与证据坐标解析的 fail-loud', () => {
  const now = new Date('2026-11-19T00:00:00Z')
  assert.equal(isRelationLive({}, now), true, '未设 validTo = 仍有效')
  assert.equal(isRelationLive({ validTo: '2026-11-18' }, now), false, 'validTo 已过 = 不成立')
  assert.equal(isRelationLive({ validTo: '2026-12-01' }, now), true)
  assert.equal(isRelationLive({ validTo: '不是时间' }, now), true, '坏值不当作过期（数据路径容错）')

  assert.deepEqual(parseEvidenceRefsArg(['session|s1|3', 'session|s1|3']), ['session|s1|3'], '去重保序')
  assert.equal(parseEvidenceRefsArg([]), undefined)
  assert.throws(() => parseEvidenceRefsArg(['乱写']), /无法解析的坐标/)
  assert.throws(() => parseEvidenceRefsArg(Array.from({ length: 9 }, (_, i) => `derived|p${i}`)), /最多 8 条/)

  const hits = edgesOf([], 'x')
  assert.deepEqual(hits, [], '空边集不崩')
})
