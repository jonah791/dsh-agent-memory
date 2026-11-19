/**
 * §10.4 遗忘传播 · 判据（F 段）——设计正本 `docs/design/aml-forget.md`
 *
 * 这一层测**传播计划**（纯函数），不测写入路径：写入分散在四个 Store，而「哪些面该动、
 * 动几条」是判据真正要守的东西。工具层的端到端在 `forget-e2e` 段。
 *
 * ⚠ 成对纪律（本仓 2026-11-19 的教训）：每条「该动」的判据都要有一条「不该动」的对照，
 * 否则负向全绿会掩盖正向被堵死。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { UNOWNED_SURFACES, archiveRefDescendants, mergeForgetPlans, planForget } from '../lib/forget.js'
import { MemoryStore } from '../lib/store.js'
import { createMemoryTools } from '../lib/tools.js'
import { workspaceIdOf } from '../lib/scope.js'

const EMPTY = { entryId: 'e-1', derivedEntries: [], liveRelations: [] }

test('F0a 四个自有面恒在且顺序稳定（本体 → 派生 → 关系 → 侧车）', () => {
  const plan = planForget(EMPTY)
  assert.deepEqual(
    plan.surfaces.map((item) => item.surface),
    ['entry', 'derived', 'relations', 'access-trace'],
  )
})

test('F0b 本体面不许给「已删干净」的错觉（不做硬删除的理由必须写在反馈里）', () => {
  const entry = planForget(EMPTY).surfaces[0]
  assert.match(entry.action, /软归档/, '缺省行为必须写明是软归档')
  assert.match(entry.action, /不提供硬删除/, '不说清边界 ⇒ 读者会以为原文也已消失（它在宿主日志与备份层）')
  assert.doesNotMatch(entry.action, /已彻底删除|已永久删除/, '出现这种措辞就是撒谎——本插件删不到那两层')
})

test('F2a 派生面：直接与嵌套后代都计入，且不自动归档', () => {
  const plan = planForget({
    ...EMPTY,
    derivedEntries: [{ id: 's-1', depth: 1, disposition: 'review-required' }, { id: 's-2', depth: 2, disposition: 'review-required' }],
  })
  const derived = plan.surfaces.find((item) => item.surface === 'derived')
  assert.equal(derived.count, 2, '直接与嵌套后代都计数')
  assert.match(derived.action, /archiveRef/)
  assert.match(derived.action, /直接 1.*嵌套 1/)
  assert.match(derived.action, /不自动归档|待判断/)
  assert.deepEqual(plan.derivedEntries, [
    { id: 's-1', depth: 1, disposition: 'review-required' },
    { id: 's-2', depth: 2, disposition: 'review-required' },
  ])
})

test('F7 archiveRef 后代闭包：找全嵌套链、去重、排除无关项并防环', () => {
  const entries = [
    { id: 'A', archiveRef: ['B'] }, // 与 B 构成环；起点不能重新出现
    { id: 'B', archiveRef: ['A'] },
    { id: 'C', archiveRef: ['A'] },
    { id: 'D', archiveRef: ['A', 'missing'] }, // 多原料仍只计一条派生条目
    { id: 'E', archiveRef: ['C'] }, // 嵌套后代
    { id: 'F', archiveRef: ['unrelated'] },
  ]
  assert.deepEqual(archiveRefDescendants(entries, ['A']), [
    { id: 'B', depth: 1, disposition: 'review-required' },
    { id: 'C', depth: 1, disposition: 'review-required' },
    { id: 'D', depth: 1, disposition: 'review-required' },
    { id: 'E', depth: 2, disposition: 'review-required' },
  ])
})

test('F2b 关系面：退役不是删除（措辞必须提 validTo，否则读者会以为记录没了）', () => {
  const plan = planForget({ ...EMPTY, liveRelations: ['r-1'] })
  const relations = plan.surfaces.find((item) => item.surface === 'relations')
  assert.equal(relations.count, 1)
  assert.match(relations.action, /validTo/)
  assert.match(relations.action, /保留/, '「它曾经成立」与「它从没存在过」是两件事')
})

test('F2c access-trace 恒为 0 且必在列表里（沉默地不列它 = 让读者以为漏了一处）', () => {
  for (const plan of [planForget(EMPTY), planForget({ ...EMPTY, derivedEntries: [{ id: 's', depth: 1 }], liveRelations: ['r'] })]) {
    const trace = plan.surfaces.find((item) => item.surface === 'access-trace')
    assert.ok(trace !== undefined, '侧车面必须出现在结果里')
    assert.equal(trace.count, 0, '侧车只存 {atMs, ids}，不含内容 ⇒ 要处理的条数恒为 0')
    assert.match(trace.action, /不含|无内容/, '要说清为什么不动它，否则看起来像漏了')
  }
})

test('F2d 空输入不报假数（三个面的 count 都是 0，不是 undefined）', () => {
  const plan = planForget(EMPTY)
  for (const item of plan.surfaces) {
    assert.equal(typeof item.count, 'number', `${item.surface} 的 count 必须是数字`)
    if (item.surface !== 'entry') assert.equal(item.count, 0)
  }
})

test('F4 未覆盖面必报且点名宿主日志与备份层（这格被省掉，反馈就会撒谎）', () => {
  const plan = planForget(EMPTY)
  const names = plan.unowned.map((item) => item.surface)
  assert.ok(names.includes('host-log'), '原始来源在宿主会话日志——必须点名')
  assert.ok(names.includes('backup'), '备份层必须点名')
  assert.ok(names.includes('entities'), '实体档没有 entry→entity 边——必须点名这条缺口')
  for (const item of plan.unowned) {
    assert.ok(item.why.length > 10, `${item.surface} 的 why 太短，不足以让人判断该找谁`)
  }
  // 与常量同源：新增未覆盖面时不用改这条测试
  assert.equal(plan.unowned.length, UNOWNED_SURFACES.length)
})

test('F4b 未覆盖面是副本不是共享引用（调用方改它不该污染下一次）', () => {
  const first = planForget(EMPTY)
  first.unowned[0].why = '被改坏了'
  const second = planForget(EMPTY)
  assert.notEqual(second.unowned[0].why, '被改坏了', '返回内部常量会让一次调用污染所有后续')
})

test('F5 合并：重叠派生后代按 id 去重并取最短深度', () => {
  const merged = mergeForgetPlans([
    planForget({ ...EMPTY, entryId: 'e-1', liveRelations: ['r-1'], derivedEntries: [{ id: 'shared', depth: 2, disposition: 'review-required' }] }),
    planForget({ ...EMPTY, entryId: 'e-2', liveRelations: ['r-2', 'r-3'], derivedEntries: [{ id: 'shared', depth: 1, disposition: 'review-required' }, { id: 'unique', depth: 2, disposition: 'review-required' }] }),
  ])
  assert.equal(merged.processed, 2)
  const byName = new Map(merged.surfaces.map((item) => [item.surface, item]))
  assert.equal(byName.get('entry').count, 2)
  assert.equal(byName.get('relations').count, 3)
  assert.equal(byName.get('derived').count, 2)
  assert.deepEqual(merged.derivedEntries, [
    { id: 'shared', depth: 1, disposition: 'review-required' },
    { id: 'unique', depth: 2, disposition: 'review-required' },
  ])
  assert.equal(byName.get('access-trace').count, 0)
  assert.equal(merged.unowned.length, UNOWNED_SURFACES.length, '未覆盖面是常量，不该按条数翻倍')
})

test('F5b 合并空数组：不伪造 processed（0 条就是 0 条，不是 1）', () => {
  const merged = mergeForgetPlans([])
  assert.equal(merged.processed, 0)
  assert.deepEqual(merged.surfaces, [], '没有条目就没有面结果——凭空补四个 0 会掩盖「一条都没选中」')
  assert.equal(merged.unowned.length, UNOWNED_SURFACES.length, '但未覆盖面照报：它说的不是这次，是「本插件永远不管这几处」')
})

// ---------- 工具层端到端：F3 凭证最小化 / F5 主题选择器 / F6 全删护栏 ----------
//
// 纯函数层测的是「计划对不对」；这一段测「写下去的东西对不对」——
// 尤其 F3：凭证是本次唯一新增的**落盘物**，它一旦把内容带回来，整个「最小化」就是摆设。

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
}

const CWD = 'C:\Users\Alice\proj'
const WID = workspaceIdOf(CWD)
const CONFIG = { maxEntries: 500, layers: ['fact', 'knowledge', 'episodic', 'summary'] }

function setupE2E() {
  const store = new MemoryStore(new MemoryKv())
  const certs = []
  const tools = createMemoryTools({
    store,
    relations: undefined,
    concepts: undefined,
    entities: undefined,
    sources: undefined,
    loadConfig: () => CONFIG,
    recordForget: (cert) => {
      certs.push(cert)
    },
  })
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const exec = { agent: { session: { id: 'session-forget', header: { cwd: CWD } } } }
  return { store, certs, byName, exec }
}

test('F7 工具端到端：预览和实跑同列多层后代，且只归档目标', async () => {
  const { store, byName, exec } = setupE2E()
  const seed = (title, kind, archiveRef = []) => store.remember({
    kind,
    title,
    body: `${title}正文`,
    scope: WID,
    level: null,
    bucket: null,
    ...(archiveRef.length > 0 ? { archiveRef } : {}),
  })
  const source = await seed('F7 source', 'fact')
  const direct = await seed('F7 direct summary', 'summary', [source.id])
  const nested = await seed('F7 nested summary', 'summary', [direct.id])
  const unrelated = await seed('F7 unrelated summary', 'summary')
  const beforeDirect = store.get(WID, direct.id)
  const beforeNested = store.get(WID, nested.id)
  const beforeUnrelated = store.get(WID, unrelated.id)

  const forget = byName.get('forget')
  const preview = await forget.execute({ id: source.id, dryRun: true }, exec)
  const expected = [direct.id, nested.id].sort()
  assert.deepEqual(preview.derivedEntries.map((item) => item.id).sort(), expected)
  assert.deepEqual(preview.derivedEntries, preview.derivedEntries.slice().sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id)))
  assert.match(preview.surfaces.find((line) => line.startsWith('[derived]')), /直接 1.*嵌套 1/)

  const done = await forget.execute({ id: source.id, reason: 'F7 fixture' }, exec)
  assert.deepEqual(done.derivedEntries, preview.derivedEntries, 'dryRun 与实跑必须给同一派生清单')
  assert.equal(done.archivedCount, 1, '派生后代不自动归档')
  assert.equal(store.get(WID, source.id).archived, true)
  assert.deepEqual(store.get(WID, direct.id), beforeDirect)
  assert.deepEqual(store.get(WID, nested.id), beforeNested)
  assert.deepEqual(store.get(WID, unrelated.id), beforeUnrelated)
})

test('F8a 显式 id 可选中已归档条目：不报「未找到」，且派生闭包照常给出', async () => {
  const { store, byName, exec } = setupE2E()
  const seed = (title, kind, archiveRef = []) => store.remember({
    kind,
    title,
    body: `${title}正文`,
    scope: WID,
    level: null,
    bucket: null,
    ...(archiveRef.length > 0 ? { archiveRef } : {}),
  })
  const source = await seed('F8 source', 'fact')
  const day = await seed('F8 day summary', 'summary', [source.id])
  const week = await seed('F8 week summary', 'summary', [day.id])
  const forget = byName.get('forget')

  await forget.execute({ id: source.id, reason: 'F8 first' }, exec)
  assert.equal(store.get(WID, source.id).archived, true, '先归档它，制造「归档后还要被点名」的处境')

  const preview = await forget.execute({ id: source.id, dryRun: true }, exec)
  assert.deepEqual(preview.ids, [source.id], '已归档条目必须能被显式 id 选中——否则派生链永远没机会被检查')
  assert.deepEqual(preview.derivedEntries.map((item) => [item.id, item.depth]), [[day.id, 1], [week.id, 2]])
  assert.equal(preview.archivedCount, 0, 'dryRun 不写')

  const done = await forget.execute({ id: source.id, reason: 'F8 again' }, exec)
  assert.equal(done.archivedCount, 0, '本来就是归档态 ⇒ 不虚增')
  assert.equal(done.alreadyArchived, 1, '但要如实报「它本来已归档」')
  assert.deepEqual(done.derivedEntries, preview.derivedEntries, '实跑与预览同源')
})

test('F8b 幂等：重复点名已归档条目不刷新 updatedAt、不重复写审计', async () => {
  const { store, byName, exec } = setupE2E()
  const created = await byName.get('remember').execute({ text: '# F8b 正文' }, exec)
  const forget = byName.get('forget')
  await forget.execute({ id: created.id, reason: 'F8b first' }, exec)
  const before = store.get(WID, created.id)
  const again = await forget.execute({ id: created.id, reason: 'F8b second' }, exec)
  const after = store.get(WID, created.id)
  assert.equal(again.archivedCount, 0)
  assert.equal(again.alreadyArchived, 1)
  assert.equal(after.updatedAt, before.updatedAt, '对本来就归档的条目再归档一次不产生新信息，不该动 updatedAt')
  assert.equal(after.archivedReason, before.archivedReason, '也不该覆盖原来的归档理由')
})

test('F8c 护栏不放宽：mode=topic / all 仍只挑活跃条目', async () => {
  const { store, byName, exec } = setupE2E()
  const remember = byName.get('remember')
  const forget = byName.get('forget')
  const live = await remember.execute({ text: '# F8c 活跃', tags: ['f8c'] }, exec)
  const gone = await remember.execute({ text: '# F8c 已归档', tags: ['f8c'] }, exec)
  await forget.execute({ id: gone.id, reason: 'F8c setup' }, exec)

  const preview = await forget.execute({ mode: 'topic', topicTags: ['f8c'], dryRun: true }, exec)
  assert.deepEqual(preview.ids, [live.id], 'topic 只命中活跃的那条——批量选择器不许被 includeArchived 放宽')
  assert.equal(store.get(WID, gone.id).archived, true)
})

test('F3 凭证最小化：有面/计数/id，但**拿不到被删内容**（可对账、不可反推）', async () => {
  const { byName, certs, exec } = setupE2E()
  const titleMark = 'Zj7Q机密标题'
  const bodyMark = 'Wq9X不该出现在凭证里'
  const created = await byName.get('remember').execute({ text: `# ${titleMark}\n正文${bodyMark}` }, exec)
  const value = await byName.get('forget').execute({ id: created.id, reason: '测试最小化' }, exec)

  assert.equal(certs.length, 1, '应写一条凭证')
  const serialized = JSON.stringify(certs[0])
  assert.ok(!serialized.includes('Zj7Q'), '凭证里出现了被删**标题**片段 ⇒ 最小化已破')
  assert.ok(!serialized.includes('Wq9X'), '凭证里出现了被删**正文**片段 ⇒ 最小化已破')
  // 但必须仍能对账：id 与面都在（id 是随机 uuid，不带语义）
  assert.deepEqual(certs[0].ids, [created.id], 'id 要在——否则凭证没法回答「处理的是哪一条」')
  assert.ok(certs[0].surfaces.length >= 4, '逐面结果不能空')
  assert.ok(certs[0].unowned.length >= 3, '未覆盖面必须随凭证一起走')
  assert.equal(certs[0].mode, 'entry')
  assert.equal(typeof value.certId, 'string', '回执要给凭证 id，否则读者不知道去哪查')
})

test('F5 mode=topic：按标签选中，dryRun 与实跑的命中集合一致', async () => {
  const { store, byName, exec } = setupE2E()
  const remember = byName.get('remember')
  const forget = byName.get('forget')
  const a = await remember.execute({ text: '# 甲\n正文甲', tags: ['tok-x'] }, exec)
  const b = await remember.execute({ text: '# 乙\n正文乙', tags: ['tok-y'] }, exec)

  const preview = await forget.execute({ mode: 'topic', topicTags: ['tok-x'], dryRun: true }, exec)
  assert.deepEqual(preview.ids, [a.id], '恰好命中带该标签的那一条（不连带别的）')
  assert.equal(preview.mode, 'topic')
  assert.equal(preview.dryRun, true)
  assert.equal(preview.archivedCount, 0, 'dryRun 不写')

  const done = await forget.execute({ mode: 'topic', topicTags: ['tok-x'], reason: '测试主题遗忘' }, exec)
  assert.deepEqual(done.ids, preview.ids, 'dryRun 与实跑必须同一集合——否则预览是在骗人')
  assert.equal(done.archivedCount, 1)
  // 未命中的那条保持活跃
  assert.equal(store.get(WID, b.id).archived ?? false, false, '不该连带归档没命中的条目')
})

test('F5b mode=topic 不给任何选择器 ⇒ 拒（不然它就成了无护栏的全删）', async () => {
  const { byName, exec } = setupE2E()
  await assert.rejects(
    () => byName.get('forget').execute({ mode: 'topic' }, exec),
    /topicTags|topicMemType|topicSpace/,
  )
})

test('F6 mode=all：confirm 不逐字匹配 scope 一律拒，匹配才执行', async () => {
  const { byName, exec } = setupE2E()
  const remember = byName.get('remember')
  const forget = byName.get('forget')
  await remember.execute({ text: '# 甲\n正文甲' }, exec)
  await remember.execute({ text: '# 乙\n正文乙' }, exec)

  await assert.rejects(() => forget.execute({ mode: 'all' }, exec), /confirm/, '不给 confirm ⇒ 拒')
  await assert.rejects(() => forget.execute({ mode: 'all', confirm: 'wrong-scope' }, exec), /confirm/, '写错 ⇒ 拒')
  const done = await forget.execute({ mode: 'all', confirm: WID, reason: '测试全删' }, exec)
  assert.equal(done.mode, 'all')
  assert.equal(done.archivedCount, 2, '两条都归档')
})

test('F1 缺省关：不给 mode 时仍走 entry 语义（既有三选择器，行为不变）', async () => {
  const { byName, exec } = setupE2E()
  const created = await byName.get('remember').execute({ text: '# 丙\n正文丙' }, exec)
  const value = await byName.get('forget').execute({ id: created.id }, exec)
  assert.equal(value.mode, 'entry', '缺省必须是 entry，不能因为加了新参数就漂移')
  assert.equal(value.archivedCount, 1)
})
