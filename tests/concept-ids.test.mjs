/**
 * 方案 §6.3「统一资源标识符」· 概念（主题）可读 ID 的判据（C 段）
 *
 * 背景：实体有 `ENTITY-0001`、来源有 `SOURCE-0001`、关系有独立 id，**只有概念是随机 uuid**——
 * 而概念的 id 正是要被人引用的东西（`broader` / `related` / 实体的 `topics`，以及我说
 * 「把 CONCEPT-0007 的上位改掉」时的那个号）。uuid 不可口述、不可肉眼比对。
 *
 * 这一层要守的不是「新概念长得好看」，而是三件会悄悄错的事：
 * ① **迁移把引用弄断**（改了 id 没改 `broader`/`related`/`topics` ⇒ 悬空）
 * ② **迁移不幂等**（重跑一次把号再往后推 ⇒ 编号随重跑漂移）
 * ③ **跨 scope 挤号**（别的 scope 有 `CONCEPT-0001` 就把本 scope 的第一个挤成 0002）
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { ConceptStore, conceptKey } from '../lib/thesaurus.js'
import { EntityStore, entityKey } from '../lib/entities.js'
import { MemoryStore } from '../lib/store.js'
import { createMemoryTools } from '../lib/tools.js'
import { workspaceIdOf } from '../lib/scope.js'

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
  const conceptKv = new MemoryKv()
  const entityKv = new MemoryKv()
  return {
    conceptKv,
    entityKv,
    concepts: new ConceptStore(conceptKv),
    entities: new EntityStore(entityKv),
  }
}

/** 造一条「存量」概念（uuid 形态，模拟 v0.29.0 到 v0.56 之间写下的数据） */
async function seedLegacyConcept(kv, { scope, id, prefLabel, createdAt, broader, related }) {
  await kv.put(conceptKey(scope, id), {
    id,
    scope,
    prefLabel,
    createdAt,
    updatedAt: createdAt,
    ...(broader !== undefined ? { broader } : {}),
    ...(related !== undefined ? { related } : {}),
    revisions: [{ at: createdAt, action: 'create', detail: `prefLabel=${prefLabel}` }],
  })
}

test('C1 新建概念即得可读 id，且**全局唯一**（同号跨 scope 会让按 id 的解析歧义）', async () => {
  const { concepts } = setup()
  const first = await concepts.create({ scope: 's1', prefLabel: '甲' })
  const second = await concepts.create({ scope: 's1', prefLabel: '乙' })
  const other = await concepts.create({ scope: 's2', prefLabel: '丙' })
  assert.equal(first.id, 'CONCEPT-0001')
  assert.equal(second.id, 'CONCEPT-0002')
  // ⚠ 这条判据的第一版写的是「每 scope 独立、各得 0001」——那是**错的**：
  // 两个 scope 都有 CONCEPT-0001 时，`find(id)`（全局按 id 查）返回哪一个取决于遍历顺序，
  // 跨 scope 引用校验就退化成「碰巧撞对」。既有 T3 / E7 两条判据当场变红才暴露它。
  assert.equal(other.id, 'CONCEPT-0003', '全局唯一——别的 scope 的号必须继续往后排')
  const all = [...concepts.byScope('s1'), ...concepts.byScope('s2')].map((c) => c.id)
  assert.equal(new Set(all).size, all.length, '全库不许有重号')
  assert.match(first.id, /^CONCEPT-\d{4}$/)
})

test('C2 迁移零悬空（含跨表）：broader / related / 实体的 topics 全部指向新 id，旧 key 消失', async () => {
  const { conceptKv, entityKv, concepts, entities } = setup()
  // 上下位链按「插入顺序与 createdAt 顺序相反」造，顺带测排序判据不是插入序
  await seedLegacyConcept(conceptKv, { scope: 's1', id: 'uuid-c', prefLabel: '知识组织', createdAt: '2026-11-03T00:00:00Z', broader: ['uuid-b'], related: ['uuid-a'] })
  await seedLegacyConcept(conceptKv, { scope: 's1', id: 'uuid-a', prefLabel: '智能体记忆', createdAt: '2026-11-01T00:00:00Z' })
  await seedLegacyConcept(conceptKv, { scope: 's1', id: 'uuid-b', prefLabel: '记忆图书馆', createdAt: '2026-11-02T00:00:00Z', broader: ['uuid-a'] })
  await entityKv.put(entityKey('s1', 'ENTITY-0001'), {
    id: 'ENTITY-0001',
    scope: 's1',
    canonicalName: 'AML',
    entityType: '项目',
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    status: 'active',
    topics: ['uuid-b'],
    revisions: [],
  })

  const mapping = await concepts.renumberIds('s1')
  assert.deepEqual(mapping, {
    'uuid-a': 'CONCEPT-0001',
    'uuid-b': 'CONCEPT-0002',
    'uuid-c': 'CONCEPT-0003',
  }, '按 createdAt 升序编号——不是插入顺序、不是 id 字典序')

  const byId = new Map(concepts.byScope('s1').map((concept) => [concept.id, concept]))
  assert.deepEqual([...byId.keys()].sort(), ['CONCEPT-0001', 'CONCEPT-0002', 'CONCEPT-0003'])
  assert.deepEqual(byId.get('CONCEPT-0002').broader, ['CONCEPT-0001'])
  assert.deepEqual(byId.get('CONCEPT-0003').broader, ['CONCEPT-0002'])
  assert.deepEqual(byId.get('CONCEPT-0003').related, ['CONCEPT-0001'], 'related 也要一起改')

  // 旧 key 必须消失（否则同一条概念有两个 id，读路径会撞见幽灵）
  for (const oldId of ['uuid-a', 'uuid-b', 'uuid-c']) {
    assert.equal(conceptKv.get(conceptKey('s1', oldId)), undefined, `旧 key ${oldId} 应已删除`)
  }

  // 悬空 0：所有引用都能解析
  const dangling = []
  for (const concept of byId.values()) {
    for (const ref of [...(concept.broader ?? []), ...(concept.related ?? [])]) {
      if (!byId.has(ref)) dangling.push(`${concept.id}→${ref}`)
    }
  }
  assert.deepEqual(dangling, [], '迁移后词表内引用必须零悬空')

  const changed = await entities.rewriteTopicRefs(mapping)
  assert.equal(changed, 1)
  const entity = entities.find('ENTITY-0001')
  assert.deepEqual(entity.topics, ['CONCEPT-0002'], '实体的 topics 是跨表引用——不改它就悬空')
  assert.ok(
    (entity.revisions ?? []).some((revision) => revision.action === 'renumber-topics'),
    '迁移要留痕：事后能看出这条实体的主题为什么换了写法',
  )
  for (const topic of entity.topics) {
    assert.ok(byId.has(topic), '实体 topics 必须零悬空')
  }
})

test('C3 幂等：第二次迁移返回空映射、数据逐字不变、实体零改动', async () => {
  const { conceptKv, entityKv, concepts, entities } = setup()
  await seedLegacyConcept(conceptKv, { scope: 's1', id: 'uuid-a', prefLabel: '甲', createdAt: '2026-11-01T00:00:00Z' })
  await seedLegacyConcept(conceptKv, { scope: 's1', id: 'uuid-b', prefLabel: '乙', createdAt: '2026-11-02T00:00:00Z', broader: ['uuid-a'] })
  const mapping = await concepts.renumberIds('s1')
  await entities.rewriteTopicRefs(mapping)

  const snapshot = JSON.stringify(concepts.byScope('s1').sort((a, b) => (a.id < b.id ? -1 : 1)))
  const again = await concepts.renumberIds('s1')
  assert.deepEqual(again, {}, '已全部是可读 id ⇒ 无事可做，不能把号再往后推')
  assert.equal(JSON.stringify(concepts.byScope('s1').sort((a, b) => (a.id < b.id ? -1 : 1))), snapshot, '重跑必须逐字不变')
  assert.equal(await entities.rewriteTopicRefs(again), 0)
})

test('C4 混存不撞号：scope 里已有 `CONCEPT-0001` 时，uuid 从 0002 起分配', async () => {
  const { conceptKv, concepts } = setup()
  await seedLegacyConcept(conceptKv, { scope: 's1', id: 'CONCEPT-0001', prefLabel: '已规范的', createdAt: '2026-10-01T00:00:00Z' })
  await seedLegacyConcept(conceptKv, { scope: 's1', id: 'uuid-x', prefLabel: '旧甲', createdAt: '2026-11-01T00:00:00Z' })
  await seedLegacyConcept(conceptKv, { scope: 's1', id: 'uuid-y', prefLabel: '旧乙', createdAt: '2026-11-02T00:00:00Z' })

  const mapping = await concepts.renumberIds('s1')
  assert.deepEqual(mapping, { 'uuid-x': 'CONCEPT-0002', 'uuid-y': 'CONCEPT-0003' })
  const ids = concepts.byScope('s1').map((concept) => concept.id).sort()
  assert.deepEqual(ids, ['CONCEPT-0001', 'CONCEPT-0002', 'CONCEPT-0003'])
  assert.equal(concepts.byScope('s1').find((c) => c.id === 'CONCEPT-0001').prefLabel, '已规范的', '已是可读 id 的不动')
})

test('C5 迁移只影响点名的那一个 scope（别的 scope 的 uuid 原样保留）', async () => {
  const { conceptKv, concepts } = setup()
  await seedLegacyConcept(conceptKv, { scope: 's1', id: 'uuid-a', prefLabel: '甲', createdAt: '2026-11-01T00:00:00Z' })
  await seedLegacyConcept(conceptKv, { scope: 's2', id: 'uuid-z', prefLabel: '丙', createdAt: '2026-11-01T00:00:00Z' })

  await concepts.renumberIds('s1')
  assert.deepEqual(concepts.byScope('s1').map((c) => c.id), ['CONCEPT-0001'])
  assert.deepEqual(concepts.byScope('s2').map((c) => c.id), ['uuid-z'], '没点名的 scope 一个字都不该动')
})

test('C6 新建与迁移共用同一水位：迁移后再新建接着往下编号（不回填 0001 造重号）', async () => {
  const { conceptKv, concepts } = setup()
  await seedLegacyConcept(conceptKv, { scope: 's1', id: 'uuid-a', prefLabel: '甲', createdAt: '2026-11-01T00:00:00Z' })
  await seedLegacyConcept(conceptKv, { scope: 's1', id: 'uuid-b', prefLabel: '乙', createdAt: '2026-11-02T00:00:00Z' })
  await concepts.renumberIds('s1')

  const created = await concepts.create({ scope: 's1', prefLabel: '丙' })
  assert.equal(created.id, 'CONCEPT-0003', '新建必须读迁移后的水位')
  const ids = concepts.byScope('s1').map((concept) => concept.id)
  assert.equal(new Set(ids).size, ids.length, '不许出现重号')
})

test('C7 干跑不写：`planRenumber` 给出映射而数据逐字不变（预览与实跑的映射必须同源）', async () => {
  const { conceptKv, concepts } = setup()
  await seedLegacyConcept(conceptKv, { scope: 's1', id: 'uuid-a', prefLabel: '甲', createdAt: '2026-11-01T00:00:00Z' })
  await seedLegacyConcept(conceptKv, { scope: 's1', id: 'uuid-b', prefLabel: '乙', createdAt: '2026-11-02T00:00:00Z', broader: ['uuid-a'] })
  const before = JSON.stringify(concepts.byScope('s1'))

  const plan = concepts.planRenumber('s1')
  assert.deepEqual(plan, { 'uuid-a': 'CONCEPT-0001', 'uuid-b': 'CONCEPT-0002' })
  assert.equal(JSON.stringify(concepts.byScope('s1')), before, '干跑不许动一个字节')

  const applied = await concepts.renumberIds('s1')
  assert.deepEqual(applied, plan, '预览与实跑必须同一映射——否则预览是在骗人')
})

// ---------- 工具层端到端：干跑 → 实跑 → 幂等 ----------

const CWD = 'C:\\Users\\Alice\\proj'
const CONFIG = { maxEntries: 500, layers: ['fact', 'knowledge', 'episodic', 'summary'] }

test('C8 工具端到端：干跑零写入、实跑改两侧、返回键全部在 output.schema 里（否则宿主整条拒收）', async () => {
  const conceptKv = new MemoryKv()
  const entityKv = new MemoryKv()
  const concepts = new ConceptStore(conceptKv)
  const entities = new EntityStore(entityKv)
  const wid = workspaceIdOf(CWD)
  await seedLegacyConcept(conceptKv, { scope: wid, id: 'uuid-a', prefLabel: '智能体记忆', createdAt: '2026-11-01T00:00:00Z' })
  await seedLegacyConcept(conceptKv, { scope: wid, id: 'uuid-b', prefLabel: '记忆图书馆', createdAt: '2026-11-02T00:00:00Z', broader: ['uuid-a'] })
  await entityKv.put(entityKey(wid, 'ENTITY-0001'), {
    id: 'ENTITY-0001',
    scope: wid,
    canonicalName: 'AML',
    entityType: '项目',
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    status: 'active',
    topics: ['uuid-b'],
    revisions: [],
  })

  const tools = createMemoryTools({
    store: new MemoryStore(new MemoryKv()),
    concepts,
    entities,
    loadConfig: () => CONFIG,
  })
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const renumber = byName.get('memory_concept_renumber')
  assert.ok(renumber !== undefined, '工具必须存在')
  const exec = { agent: { session: { id: 'session-renumber', header: { cwd: CWD } } } }

  const preview = await renumber.execute({ dryRun: true }, exec)
  assert.equal(preview.dryRun, true)
  assert.equal(preview.total, 2)
  assert.equal(preview.rewrittenEntities, 1)
  assert.deepEqual(concepts.byScope(wid).map((c) => c.id).sort(), ['uuid-a', 'uuid-b'], '干跑不许写')

  const done = await renumber.execute({}, exec)
  assert.equal(done.dryRun, false)
  assert.equal(done.total, 2)
  assert.deepEqual(concepts.byScope(wid).map((c) => c.id).sort(), ['CONCEPT-0001', 'CONCEPT-0002'])
  assert.deepEqual(entities.find('ENTITY-0001').topics, ['CONCEPT-0002'], '跨表引用必须一起改')

  const declared = new Set(Object.keys(renumber.output.schema.properties))
  for (const key of Object.keys(done)) {
    assert.ok(declared.has(key), `返回键 ${key} 未在 output.schema 声明——宿主 additionalProperties:false 会整条拒收`)
  }

  const again = await renumber.execute({}, exec)
  assert.equal(again.total, 0, '幂等：第二次跑无事可做')
  assert.equal(again.rewrittenEntities, 0)
})

test('C9 实体表未接线时拒绝执行（只改概念不改 topics 会留悬空，比不改更坏）', async () => {
  const conceptKv = new MemoryKv()
  const concepts = new ConceptStore(conceptKv)
  const wid = workspaceIdOf(CWD)
  await seedLegacyConcept(conceptKv, { scope: wid, id: 'uuid-a', prefLabel: '甲', createdAt: '2026-11-01T00:00:00Z' })
  const tools = createMemoryTools({
    store: new MemoryStore(new MemoryKv()),
    concepts,
    loadConfig: () => CONFIG,
  })
  const renumber = new Map(tools.map((tool) => [tool.name, tool])).get('memory_concept_renumber')
  const exec = { agent: { session: { id: 'session-renumber', header: { cwd: CWD } } } }
  await assert.rejects(() => renumber.execute({}, exec), /实体表未接线/)
  assert.deepEqual(concepts.byScope(wid).map((c) => c.id), ['uuid-a'], '拒绝之后数据一个字都不该动')
})
