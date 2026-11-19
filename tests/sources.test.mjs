/**
 * 来源实体单测（v0.35 · 方案 §5.2 · 契约 `docs/semantic.md` §5.28）。
 * 运行：npm test（tsc 后 node --test "tests/*.test.mjs"，导入编译产物 lib/*.js）
 *
 * 覆盖：
 *   S1 id 递增且每 scope 独立（不是全局计数器）；键带 scope ⇒ 同号不互相覆盖
 *   S2 `reliability` / `permissions` 不填 = 未标注，**不被默认成任何档**；能单独计数
 *   S6 停用不删除：`retired` 不进 `status=active`，按 scope+id 直查仍可回，重复停用幂等
 *   + fail-loud（类型不在枚举 / 位置为空 / 停用无理由）
 *   + update 只改给到的字段、同值更新不写盘、revisions 裁到 5 条
 *
 * ⚠ S3（`provenance` 与 `type` 冲突不静默覆盖）/ S4（按来源反查引用方完整）/ S5（不给
 *   `sourceIds` 时逐位相同）都需要**条目与工具层**，接线后另文覆盖——本文件不假装测过它们。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore } from '../lib/store.js'
import { SourceStore, SOURCE_TYPES, isSourceUsable } from '../lib/sources.js'
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
}

const WS_A = 'E:/alice'
const WS_B = 'E:/alice/other-project'

test('S1 id 递增且每 scope 独立', async () => {
  const store = new SourceStore(new MemoryKv())
  const a = await store.create({ scope: WS_A, type: 'web', location: 'url:https://example.com/a' })
  const b = await store.create({ scope: WS_A, type: 'master', location: 'session:s1#3' })
  assert.equal(a.id, 'SOURCE-0001')
  assert.equal(b.id, 'SOURCE-0002')
  // 另一个 scope 有自己的编号空间——不是续着 0003
  const c = await store.create({ scope: WS_B, type: 'self', location: 'file:E:/a.md' })
  assert.equal(c.id, 'SOURCE-0001', '每 scope 各自递增（不是全局计数器）')
  const ids = store.byScope(WS_A).map((s) => s.id)
  assert.equal(new Set(ids).size, ids.length, '同 scope 内 id 唯一')
})

test('S1b 键带 scope：两个 scope 的同号来源互不覆盖', async () => {
  const store = new SourceStore(new MemoryKv())
  const a = await store.create({ scope: WS_A, type: 'web', location: 'url:a' })
  const b = await store.create({ scope: WS_B, type: 'master', location: 'url:b' })
  assert.equal(a.id, b.id, '前提：两个 scope 各自从 0001 开始')
  // 直查必须带 scope——否则「两个 SOURCE-0001 取哪个」取决于遍历顺序
  assert.equal(store.find(WS_A, a.id).location, 'url:a')
  assert.equal(store.find(WS_B, b.id).location, 'url:b')
  assert.equal(store.byScope(WS_A).length, 1)
  assert.equal(store.byScope(WS_B).length, 1)
})

test('S2 reliability / permissions 未标注就是未标注，不默认成任何档', async () => {
  const store = new SourceStore(new MemoryKv())
  const s = await store.create({ scope: WS_A, type: 'web', location: 'url:x' })
  assert.equal(s.reliability, undefined, '不填 = 未标注（不是「中等」）')
  assert.equal(s.permissions, undefined)
  assert.equal(store.stats().unlabeledReliability, 1, '未标注要能单独计数，不能并进某个档')
  // 显式标注之后计数掉下来
  await store.update(WS_A, s.id, { reliability: '高（官方文档）' })
  assert.equal(store.stats().unlabeledReliability, 0)
  // 清空 = 回到未标注（不是回到某个默认值）
  await store.update(WS_A, s.id, { reliability: '' })
  assert.equal(store.find(WS_A, s.id).reliability, undefined)
  assert.equal(store.stats().unlabeledReliability, 1)
})

test('S6 停用不删除：retired 不进 active 列表，按 scope+id 直查仍可回', async () => {
  const store = new SourceStore(new MemoryKv())
  const s = await store.create({ scope: WS_A, type: 'web', location: 'url:gone' })
  const r = await store.retire(WS_A, s.id, '上游页面已下线')
  assert.equal(r.changed, true)
  assert.equal(r.source.status, 'retired')
  assert.equal(store.list({ status: 'active' }).length, 0)
  assert.equal(store.list({ status: 'retired' }).length, 1)
  // 直查仍能取回——历史引用不会变成悬空
  const back = store.find(WS_A, s.id)
  assert.ok(back !== undefined)
  assert.equal(back.retiredNote, '上游页面已下线')
  assert.equal(isSourceUsable(back), false)
  // 幂等：再停用一次不算变化
  assert.equal((await store.retire(WS_A, s.id, '再说一遍')).changed, false)
})

test('fail-loud：类型不在枚举 / 位置为空 / 停用无理由', async () => {
  const store = new SourceStore(new MemoryKv())
  await assert.rejects(() => store.create({ scope: WS_A, type: '论坛', location: 'url:x' }), /type 必须是/)
  await assert.rejects(() => store.create({ scope: WS_A, type: 'web', location: '   ' }), /location/)
  const s = await store.create({ scope: WS_A, type: 'web', location: 'url:x' })
  await assert.rejects(() => store.retire(WS_A, s.id, '  '), /理由/)
})

test('update 只改给到的字段；同值更新不写盘不加 revision', async () => {
  const store = new SourceStore(new MemoryKv())
  const s = await store.create({ scope: WS_A, type: 'web', location: 'url:x', owner: '官方文档' })
  const same = await store.update(WS_A, s.id, { location: 'url:x' })
  assert.equal(same.revisions.length, s.revisions.length, '同值更新不该产生新 revision')
  const changed = await store.update(WS_A, s.id, { location: 'url:y' }, '换了正式地址')
  assert.equal(changed.location, 'url:y')
  assert.equal(changed.owner, '官方文档', '没给的字段不动')
  assert.equal(changed.revisions.length, 2)
  assert.equal(changed.revisions[1].reason, '换了正式地址')
})

test('revisions 只留最近 5 条（挤出最老的）', async () => {
  const store = new SourceStore(new MemoryKv())
  const s = await store.create({ scope: WS_A, type: 'web', location: 'url:0' })
  for (let i = 1; i <= 7; i += 1) await store.update(WS_A, s.id, { location: `url:${i}` })
  const back = store.find(WS_A, s.id)
  assert.equal(back.revisions.length, 5)
  assert.match(back.revisions.at(-1).detail, /url:7/, '最后一条应是最近那次')
  assert.match(back.revisions[0].detail, /url:3/, 'create 与 url:1、url:2 已被挤出')
})

test('stats：按类型 / 按 scope / 未标注计数', async () => {
  const store = new SourceStore(new MemoryKv())
  await store.create({ scope: WS_A, type: 'web', location: 'url:a', reliability: '高' })
  await store.create({ scope: WS_A, type: 'web', location: 'url:b' })
  await store.create({ scope: WS_A, type: 'master', location: 'session:s#1', owner: '主人' })
  await store.create({ scope: WS_B, type: 'self', location: 'file:f' })
  const stats = store.stats()
  assert.equal(stats.total, 4)
  assert.equal(stats.active, 4)
  assert.equal(stats.retired, 0)
  assert.equal(stats.byType.web, 2)
  assert.equal(stats.byType.master, 1)
  assert.equal(stats.byScope[WS_A], 3)
  assert.equal(stats.byScope[WS_B], 1)
  assert.equal(stats.unlabeledReliability, 3)
  assert.equal(stats.withOwner, 1)
})

test('SOURCE_TYPES 与条目 provenance 同枚举（不立第二套词表）', () => {
  assert.deepEqual([...SOURCE_TYPES], ['master', 'web', 'self', 'measured'])
})

// ---------- 端到端（工具层 + 条目层）：S3 / S4 / S5 ----------

const CWD = 'C:\\Users\\Alice\\proj'
const WID = workspaceIdOf(CWD)
const CONFIG = { maxEntries: 500, layers: ['fact', 'knowledge', 'episodic', 'summary'] }

function setupE2E(options = {}) {
  const store = new MemoryStore(new MemoryKv())
  const sources = options.sources === false ? undefined : new SourceStore(new MemoryKv())
  const tools = createMemoryTools({ store, relations: undefined, concepts: undefined, entities: undefined, sources, loadConfig: () => CONFIG })
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const exec = { agent: { session: { id: 'session-src', header: { cwd: CWD } } } }
  return { store, sources, byName, exec }
}

// ---------- S3：归属（provenance）与依据（sourceIds）**正交** ----------
//
// 裁决（2026-11-19 13:20，理由正本在 `docs/semantic.md §5.28`）：v0.35.0 的初版要求
// `source.type === entry.provenance`，把**知识生产最日常的形状**判成错误——我读了主人给的方案、
// 得出他没说过的结论（归属 self / 依据 master），这正是「结论是我的、依据是他的」。
// 两个字段答的不是同一个问题：provenance 答「这条结论归属谁」，sourceIds 答「能去哪核」。
// 绑成相等 ⇒ 判据没有分辨力（把正常当错），且没有替代路径（§8.3 同一种病）。
//
// 「正交」不等于「不管」——错与不全分两档：**悬空引用是错（拒）**，
// **有依据无归属 / 引用已停用来源是不全（过，但点名）**。
// ⚠ 每条能亮的判据都必须有一条证明它在该灭时会灭，否则负向全绿会掩盖正向被堵死。

test('S3a 正交：归属 self 引用 master 来源 ⇒ 通过，两字段各自独立落盘', async () => {
  const { store, sources, byName, exec } = setupE2E()
  const plan = await sources.create({ scope: WID, type: 'master', location: 'session:s-plan#3' })
  const remember = byName.get('remember')

  const ok = await remember.execute({ text: '# 我的推论\n基于主人的方案', provenance: 'self', sourceIds: [plan.id] }, exec)
  assert.equal(ok.action, 'created')
  const entry = store.get(WID, ok.id)
  assert.deepEqual(entry.sourceIds, [plan.id], '依据落盘')
  assert.equal(entry.provenance, 'self', '归属不被来源 type 覆盖')

  // 负向对照：这是完全正常的形状，不该报任何提示——提示若在这里亮就成了噪音
  assert.equal(ok.sourceNotice, undefined)
})

test('S3b 有依据无归属 ⇒ 通过但点名（元数据不全不是错）', async () => {
  const { sources, byName, exec } = setupE2E()
  const plan = await sources.create({ scope: WID, type: 'master', location: 'session:s-plan#4' })
  const remember = byName.get('remember')

  const ok = await remember.execute({ text: '# 只有依据\n正文', sourceIds: [plan.id] }, exec)
  assert.equal(ok.action, 'created', '元数据不全不阻断写入')
  assert.match((ok.sourceNotice ?? []).join('\n'), /provenance/, '但要点名缺的那一格')
})

test('S3c 引用已停用来源 ⇒ 通过但点名（「依据被撤销」本身是要记录的事实）', async () => {
  const { sources, byName, exec } = setupE2E()
  const page = await sources.create({ scope: WID, type: 'web', location: 'url:https://example.com/gone' })
  await sources.retire(WID, page.id, '网页已下线')
  const remember = byName.get('remember')

  const ok = await remember.execute({ text: '# 引用已下线网页\n正文', provenance: 'web', sourceIds: [page.id] }, exec)
  assert.equal(ok.action, 'created', '停用来源仍可被引用——否则「那条依据撤了」这件事无法记录')
  assert.match((ok.sourceNotice ?? []).join('\n'), /已停用/)
})

test('S3d 悬空来源 id ⇒ 拒（数据完整性，不是语义判断）', async () => {
  const { byName, exec } = setupE2E()
  await assert.rejects(
    () => byName.get('remember').execute({ text: '# 悬空\n正文', provenance: 'web', sourceIds: ['SOURCE-9999'] }, exec),
    /不存在/,
  )
})

test('S3e 来源库未接线 ⇒ 拒（不能引用不存在的来源实体）', async () => {
  const { byName, exec } = setupE2E({ sources: false })
  await assert.rejects(
    () => byName.get('remember').execute({ text: '# 无库\n正文', provenance: 'web', sourceIds: ['SOURCE-0001'] }, exec),
    /未接线/,
  )
})

test('S3f 写入形态返回值不越 output.schema（线上 additionalProperties:false 会整条拒收）', async () => {
  // 为什么单测调 execute() 看不见这一跳：宿主在进 execute 之后**按 output.schema 校验返回值**，
  // 多一个未声明的键 = 整个调用失败（不是被裁剪）。2026-10-17 memory_browse 就是这么整条不可用的
  // （见 schema-parity.test.mjs 头注释）。本工具的 schema-parity 守卫只覆盖 recall / memory_browse，
  // remember 的返回值不在它视野里 ⇒ v0.35.1 新增 sourceNotice 必须自带一条。
  const { sources, byName, exec } = setupE2E()
  const plan = await sources.create({ scope: WID, type: 'master', location: 'session:s-plan#5' })
  const remember = byName.get('remember')
  const declared = new Set(Object.keys(remember.output.schema.properties))
  const undeclaredOf = (value) => Object.keys(value).filter((key) => !declared.has(key))

  // ① 带提示的形态（新键 sourceNotice 走的就是这一支）
  const withNotice = await remember.execute({ text: '# 有提示\n正文', sourceIds: [plan.id] }, exec)
  assert.deepEqual(undeclaredOf(withNotice), [], '返回了 output schema 未声明的键 ⇒ 线上整条拒收（工具不可用）')
  // ★ 夹具自证：没走到带 notice 的分支，上一条断言对该键就恒真了
  assert.ok('sourceNotice' in withNotice, '夹具没走到带 notice 的分支 ⇒ 本判据对 sourceNotice 无分辨力')

  // ② 干净的形态：不得凭空多键
  const clean = await remember.execute({ text: '# 干净\n正文', provenance: 'master', sourceIds: [plan.id] }, exec)
  assert.deepEqual(undeclaredOf(clean), [])
  assert.equal(clean.sourceNotice, undefined, '正常的形状不该带提示（提示在正常路径亮 = 噪音）')
})

test('S4 反查完整：按来源恰好列出引用它的条目（不多不少）', async () => {
  const { sources, byName, exec } = setupE2E()
  const src = await sources.create({ scope: WID, type: 'master', location: 'session:s-1#7' })
  const remember = byName.get('remember')
  const a = await remember.execute({ text: '# 甲\n正文甲', provenance: 'master', sourceIds: [src.id] }, exec)
  const b = await remember.execute({ text: '# 乙\n正文乙', provenance: 'master', sourceIds: [src.id] }, exec)
  await remember.execute({ text: '# 丙不引用\n正文丙' }, exec)

  const detail = await byName.get('memory_sources').execute({ id: src.id, withEntries: true }, exec)
  assert.equal(detail.mode, 'detail')
  const cited = detail.sources[0].citedBy ?? []
  assert.equal(cited.length, 2, '恰好两条：不把没引用的算上')
  assert.deepEqual(cited.map((item) => item.id).sort(), [a.id, b.id].sort())
})

test('S5 缺省关：不给 sourceIds 时条目**不带这个键**（不是空数组）', async () => {
  const { store } = setupE2E()
  const written = await store.remember({
    kind: 'knowledge',
    title: '无来源的条目',
    body: '正文',
    tags: [],
    scope: WID,
    level: null,
    bucket: null,
  })
  const entry = store.get(WID, written.id)
  assert.ok(entry !== undefined)
  assert.equal('sourceIds' in entry, false, '不给就不写键——「不写键」与「写空数组」在逐字节比较里是两种形状')
})
