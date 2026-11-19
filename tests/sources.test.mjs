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
import { SourceStore, SOURCE_TYPES, isSourceUsable } from '../lib/sources.js'

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
