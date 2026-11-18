/**
 * 主题词表单测（v0.29.0 · 方案 §4.2）——thesaurus.ts 纯函数/存储 + 工具层 + 检索扩展端到端。
 * 运行：npm test（tsc 后 node --test "tests/*.test.mjs"，导入编译产物 lib/*.js）
 *
 * 覆盖：
 *   T1 归一口径与标签唯一性：同 scope 内任两个概念的标签归一后不得相同（整笔拒绝，点名冲突概念）
 *   T2 建立与读取：按首选名/同义词都能查到；写入边界 schema 真 parse 后字段不丢
 *   T3 层级：只存 broader，下位由反查派生；上位链可传递；成环整笔拒绝
 *   T4 关联对称：只写一侧，双向都能读到
 *   T5 停用不删除：停用后不参与查询扩展、默认不列出、记录仍在、includeDeprecated 可见
 *   T6 查询扩展：命中首选名/同义词，返回**其他写法**（已在查询里的不重复）
 *   T7 导入：验完全部再写全部（批内冲突 / 缺首选名 / 上位不存在 ⇒ 整批拒绝且零写入）
 *   T8 端到端：memory_concept → memory_thesaurus（查/详情/导出）→ recall({expandThesaurus:true}) 用同义词命中
 *   T9 统计与未接线：stats 计数；deps.concepts 缺失时工具响亮报错、stats 标 wired=false
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore } from '../lib/store.js'
import { ConceptStore, labelsOf, normalizeLabel } from '../lib/thesaurus.js'
import { createMemoryTools } from '../lib/tools.js'
import { conceptSchema } from '../lib/index.js'
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

const CWD = 'C:\\Users\\Alice\\proj'
const WID = workspaceIdOf(CWD)
const CONFIG = { maxEntries: 500, layers: ['fact', 'knowledge', 'episodic', 'summary'] }

function setup() {
  const store = new MemoryStore(new MemoryKv())
  const relations = undefined
  const concepts = new ConceptStore(new MemoryKv())
  const tools = createMemoryTools({ store, relations, concepts, loadConfig: () => CONFIG })
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const exec = { agent: { session: { id: 'session-th', header: { cwd: CWD } } } }
  return { store, concepts, byName, exec }
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

test('T1 归一与标签唯一性：归一后相同即冲突，整笔拒绝并点名占用者', async () => {
  assert.equal(normalizeLabel('  智能体   记忆 '), '智能体 记忆')
  assert.equal(normalizeLabel('Agent Memory'), 'agent memory')

  const { concepts } = setup()
  const base = await concepts.create({ scope: WID, prefLabel: '智能体记忆', altLabels: ['记忆库', 'Agent Memory'] })
  assert.deepEqual(labelsOf(base), ['智能体记忆', '记忆库', 'Agent Memory'])

  // 首选名撞别人的同义词（归一后大小写/空白不同也算撞）
  await assert.rejects(
    () => concepts.create({ scope: WID, prefLabel: '记忆库' }),
    /标签冲突/,
    '同义词被占用时新建必须整笔拒绝（不许自动合并）',
  )
  await assert.rejects(
    () => concepts.create({ scope: WID, prefLabel: 'agent   memory' }),
    /标签冲突/,
    '归一后相同即冲突（大小写与空白不构成区分）',
  )
  // 自己内部重复写法也拒绝
  await assert.rejects(
    () => concepts.create({ scope: WID, prefLabel: '压缩链', altLabels: ['压缩链'] }),
    /内部有重复写法/,
  )
  // 不同 scope 可以同名词（项目各自维护自己的词表）
  const other = await concepts.create({ scope: 'global', prefLabel: '记忆库' })
  assert.equal(other.scope, 'global')
})

test('T2 建立与读取：首选名与同义词都能查到；写入边界 schema 真 parse 后字段不丢', async () => {
  const { concepts } = setup()
  const created = await concepts.create({
    scope: WID,
    prefLabel: '记忆图书馆',
    altLabels: ['AML', '智能体记忆图书馆'],
    definition: '把记忆当馆藏管理：编目、知识组织、证据追溯',
    scopeNote: '用于体系与建设计划；单条记忆的组织方法用「记忆维护」',
  })
  assert.equal(concepts.findByLabel(WID, 'AML')?.id, created.id)
  assert.equal(concepts.findByLabel(WID, '记忆图书馆')?.id, created.id)
  assert.equal(concepts.findByLabel(WID, 'Agent Memory Library'), undefined, '不做模糊匹配：认不出就是认不出')

  const stored = concepts.find(created.id)
  assert.notEqual(stored, undefined)
  const parsed = conceptSchema.parse(stored)
  for (const field of ['id', 'scope', 'prefLabel', 'altLabels', 'definition', 'scopeNote', 'createdAt', 'updatedAt', 'revisions']) {
    assert.ok(field in parsed, `写入边界剥掉了 ${field}——conceptSchema 未声明它`)
  }
  assert.equal(parsed.definition, '把记忆当馆藏管理：编目、知识组织、证据追溯')
  assert.equal((parsed.revisions ?? []).length, 1, '创建时留一条变更记录')
})

test('T3 层级：只存 broader，下位派生；上位链可传递；成环拒绝', async () => {
  const { concepts } = setup()
  const top = await concepts.create({ scope: WID, prefLabel: '知识组织' })
  const mid = await concepts.create({ scope: WID, prefLabel: '主题词表', broader: [top.id] })
  const leaf = await concepts.create({ scope: WID, prefLabel: '同义词', broader: [mid.id] })

  // 只存一侧：mid.broader 有值，mid 没有 narrower 字段
  assert.deepEqual(concepts.find(mid.id).broader, [top.id])
  assert.equal('narrower' in concepts.find(mid.id), false, 'narrower 不落盘（派生）')
  assert.deepEqual(concepts.narrowerOf(top.id).map((c) => c.prefLabel), ['主题词表'])
  assert.deepEqual(concepts.ancestorsOf(leaf.id).map((c) => c.prefLabel), ['主题词表', '知识组织'])

  // 成环：把 top 的上位设成 leaf ⇒ 拒绝
  await assert.rejects(
    () => concepts.update(top.id, { broader: [leaf.id] }),
    /成环/,
    'broader 成环必须整笔拒绝（层级查询会停不下来）',
  )
  // 自引用
  await assert.rejects(() => concepts.update(top.id, { broader: [top.id] }), /不能指向自己/)
  // 引用不存在的概念
  await assert.rejects(() => concepts.create({ scope: WID, prefLabel: '孤儿', broader: ['no-such-id'] }), /不存在/)
  // 跨 scope 引用
  const foreign = await concepts.create({ scope: 'global', prefLabel: '别处概念' })
  await assert.rejects(() => concepts.create({ scope: WID, prefLabel: '跨界', broader: [foreign.id] }), /不能跨 scope/)
})

test('T4 关联对称：只写一侧，双向都能读到', async () => {
  const { concepts } = setup()
  const a = await concepts.create({ scope: WID, prefLabel: '压缩链' })
  const b = await concepts.create({ scope: WID, prefLabel: '时间桶' })
  await concepts.update(a.id, { related: [b.id] })

  assert.deepEqual(concepts.relatedOf(a.id).map((c) => c.prefLabel), ['时间桶'])
  assert.deepEqual(concepts.relatedOf(b.id).map((c) => c.prefLabel), ['压缩链'], 'B 侧没写也能读到（同一句「两者相关」）')
})

test('T5 停用不删除：不参与扩展、默认不列、记录仍在、可显式取回', async () => {
  const { concepts } = setup()
  const created = await concepts.create({ scope: WID, prefLabel: '旧术语', altLabels: ['老叫法'] })
  const first = await concepts.deprecate(created.id, '统一改称「新术语」')
  assert.equal(first.changed, true)
  assert.equal(concepts.find(created.id).status, 'deprecated')
  assert.equal(concepts.find(created.id).deprecatedNote, '统一改称「新术语」')

  const second = await concepts.deprecate(created.id, '再说一次')
  assert.equal(second.changed, false, '二次停用不改写理由')

  // 扩展不再命中（「不再用」）
  assert.deepEqual(concepts.expand(WID, '旧术语 的用法').concepts, [])
  // 但记录还在
  assert.equal(concepts.all().length, 1)
  await assert.rejects(() => concepts.deprecate(created.id, '   '), /必须给 reason/)
})

test('T6 查询扩展：命中首选名/同义词，返回其他写法且不重复', async () => {
  const { concepts } = setup()
  await concepts.create({ scope: WID, prefLabel: '智能体记忆', altLabels: ['记忆库', 'Agent Memory'] })
  await concepts.create({ scope: WID, prefLabel: '压缩链' })

  const hit = concepts.expand(WID, '记忆库的压缩链怎么设计')
  assert.deepEqual(hit.concepts.map((c) => c.prefLabel).sort(), ['压缩链', '智能体记忆'])
  // 已在查询里出现的写法不重复返回
  assert.deepEqual(hit.extraTerms, ['智能体记忆', 'Agent Memory'])
  assert.equal(concepts.expand(WID, '完全无关的句子').concepts.length, 0)
  assert.deepEqual(concepts.expand(WID, '   ').extraTerms, [])
})

test('T7 导入：验完全部再写全部（任何一项非法 ⇒ 整批拒绝且零写入）', async () => {
  const { concepts } = setup()
  const ok = await concepts.importMany([
    { scope: WID, prefLabel: '实体权威档', altLabels: ['Authority Record'] },
    { scope: WID, prefLabel: '规范控制' },
  ], WID)
  assert.equal(ok.length, 2)
  assert.equal(concepts.all().length, 2)

  const before = concepts.all().length
  await assert.rejects(
    () => concepts.importMany([
      { scope: WID, prefLabel: '检索' },
      { scope: WID, prefLabel: '检索' },
    ], WID),
    /标签冲突/,
  )
  assert.equal(concepts.all().length, before, '批内冲突必须零写入（半套词表比没有更坏）')

  await assert.rejects(() => concepts.importMany([{ scope: WID, prefLabel: '  ' }], WID), /prefLabel 为空/)
  await assert.rejects(
    () => concepts.importMany([{ scope: WID, prefLabel: '新词', broader: ['no-such'] }], WID),
    /不存在/,
  )
  assert.equal(concepts.all().length, before)
})

test('T8 端到端：建概念 → 查词表 → recall 用同义词命中（expandedTerms 可见）', async () => {
  const { store, byName, exec } = setup()
  const conceptId = await seed(store, '知识组织体系')
  assert.notEqual(conceptId, undefined)

  const link = byName.get('memory_concept')
  const created = await link.execute({
    prefLabel: '知识组织体系',
    altLabels: ['SKOS-lite 词表'],
    definition: '用受控词表与层级把记忆组织成知识',
  }, exec)
  assert.equal(created.action, 'created')

  // 条目里只出现同义词，查询用的是首选名 ⇒ 不开扩展检索不到，开了才命中
  await seed(store, 'SKOS-lite 词表 的落地记录')

  const recallTool = byName.get('recall')
  const plain = await recallTool.execute({ query: '知识组织体系' }, exec)
  assert.equal(plain.results.some((item) => item.title.includes('SKOS-lite')), false, '不开扩展：同义词条目不命中（前提断言）')
  assert.equal(plain.expandedTerms, undefined, '没开扩展时不得出现 expandedTerms（省略 ≠ 空数组）')

  const expanded = await recallTool.execute({ query: '知识组织体系', expandThesaurus: true }, exec)
  assert.ok(expanded.expandedTerms.includes('SKOS-lite 词表'), '扩展词必须回传（看得见才可复核）')
  assert.ok(expanded.results.some((item) => item.title.includes('SKOS-lite')), '开了扩展必须命中同义词条目')

  // 查词表：按首选名/同义词都能查到
  const thesaurus = byName.get('memory_thesaurus')
  const lookup = await thesaurus.execute({ query: 'SKOS-lite 词表' }, exec)
  assert.equal(lookup.mode, 'lookup')
  assert.equal(lookup.concepts[0].prefLabel, '知识组织体系')

  // 详情：含定义与变更记录条数
  const detail = await thesaurus.execute({ id: created.id }, exec)
  assert.equal(detail.mode, 'detail')
  assert.equal(detail.concepts[0].definition, '用受控词表与层级把记忆组织成知识')
  assert.equal(detail.concepts[0].revisions, 1)

  // 导出：SKOS-lite JSON 可解析且含同义词
  const exported = await thesaurus.execute({ export: true }, exec)
  assert.equal(exported.mode, 'export')
  const parsed = JSON.parse(exported.exportJson)
  assert.equal(parsed.format, 'aml-thesaurus/1')
  assert.deepEqual(parsed.concepts[0].altLabel, ['SKOS-lite 词表'])
})

test('T9 统计与未接线：计数正确；未接线时工具响亮报错、stats 标 wired=false', async () => {
  const { concepts, byName, exec, store } = setup()
  await concepts.create({ scope: WID, prefLabel: '甲', altLabels: ['甲同义'], definition: '定义' })
  await concepts.create({ scope: WID, prefLabel: '乙', broader: [] })
  const deprecated = await concepts.create({ scope: WID, prefLabel: '丙' })
  await concepts.deprecate(deprecated.id, '不再用')

  const stats = concepts.stats()
  assert.equal(stats.total, 3)
  assert.equal(stats.active, 2)
  assert.equal(stats.deprecated, 1)
  assert.equal(stats.withAltLabels, 1)
  assert.equal(stats.withDefinition, 1)
  assert.deepEqual(stats.byScope, { [WID]: 3 })

  const viaTool = await byName.get('memory_stats').execute({}, exec)
  assert.equal(viaTool.concepts.wired, true)
  assert.equal(viaTool.concepts.total, 3)
  assert.equal(viaTool.concepts.active, 2)
  assert.equal(viaTool.concepts.deprecated, 1)

  // 未接线：wired=false，且概念工具响亮报错（不假装成功）
  const unwired = createMemoryTools({ store, loadConfig: () => CONFIG })
  const unwiredStats = await unwired.find((tool) => tool.name === 'memory_stats').execute({}, exec)
  assert.equal(unwiredStats.concepts.wired, false)
  await assert.rejects(
    () => unwired.find((tool) => tool.name === 'memory_thesaurus').execute({}, exec),
    /主题词表未接线/,
  )
})
