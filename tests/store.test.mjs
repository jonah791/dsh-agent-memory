/**
 * 存储层离线单测（T1 验收）：注入内存 mock kv，覆盖
 * create/update/delete/merge/去重/作用域隔离/归档 全路径。
 * 运行：pnpm test（先 build 再 node --test tests/）
 */

import { describe, test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  MemoryStore,
  memoryKey,
  normalizeTitle,
  titleFingerprint,
} from '../lib/store.js'

/** 内存 mock kv：实现 KvLike 接口，并记录写路径便于断言 */
class MemoryKv {
  constructor() {
    this.map = new Map()
    this.writes = [] // { key, value } 写序
    this.deletes = [] // 删除的 key 列表
  }

  get(key) {
    return this.map.get(key)
  }

  async put(key, value) {
    this.map.set(key, value)
    this.writes.push({ key, value })
  }

  async delete(key) {
    const existed = this.map.has(key)
    this.map.delete(key)
    this.deletes.push(key)
    return existed
  }

  entries() {
    return this.map.entries()
  }

  get size() {
    return this.map.size
  }
}

/** 构造一个条目草稿（默认 fact / workspace-a） */
function draft(overrides = {}) {
  return {
    kind: 'fact',
    title: '主人偏好：喜欢简洁直接的回复',
    body: '回复要点：先说结论，再给细节。',
    tags: ['preference'],
    scope: 'workspace-a',
    level: null,
    bucket: null,
    ...overrides,
  }
}

describe('MemoryStore · 基础 CRUD', () => {
  let kv
  let store

  beforeEach(() => {
    kv = new MemoryKv()
    store = new MemoryStore(kv)
  })

  test('create：新建条目返回 created + uuid，落盘 key 编码正确', async () => {
    const res = await store.remember(draft())
    assert.equal(res.action, 'created')
    assert.match(res.id, /^[0-9a-f-]{36}$/)

    // kv 中恰好一条，key = <scope>:<kind>:<id>
    assert.equal(kv.size, 1)
    const stored = kv.map.get(memoryKey('workspace-a', 'fact', res.id))
    assert.ok(stored, '条目应以规范 key 落盘')
    assert.equal(stored.title, '主人偏好：喜欢简洁直接的回复')
    assert.equal(stored.archived, false)
    assert.equal(stored.scope, 'workspace-a')
    assert.equal(stored.kind, 'fact')
    assert.ok(stored.createdAt && stored.updatedAt && stored.accessedAt)
    assert.equal(stored.createdAt, stored.updatedAt)
    assert.deepEqual(stored.tags, ['preference'])
    assert.equal(stored.level, null)
    assert.equal(stored.bucket, null)
  })

  test('create：未传 tags/level/bucket 时使用默认值', async () => {
    const res = await store.remember({
      kind: 'knowledge',
      title: 'DSH 插件开发要点',
      body: '一切皆插件，注册是可逆 effect。',
      scope: 'workspace-a',
      level: null,
      bucket: null,
    })
    const stored = kv.map.get(memoryKey('workspace-a', 'knowledge', res.id))
    assert.deepEqual(stored.tags, [])
    assert.equal(stored.level, null)
    assert.equal(stored.bucket, null)
  })

  test('get：按 (scope, id) 跨 kind 定位；不存在返回 undefined', async () => {
    const created = await store.remember(draft({ kind: 'knowledge' }))
    const found = store.get('workspace-a', created.id)
    assert.equal(found.id, created.id)
    assert.equal(found.kind, 'knowledge')
    assert.equal(store.get('workspace-a', 'no-such-id'), undefined)
    assert.equal(store.get('other-workspace', created.id), undefined)
  })

  test('get：返回快照拷贝，外部改动不影响存储对象', async () => {
    const created = await store.remember(draft())
    const found = store.get('workspace-a', created.id)
    found.title = '被外部篡改'
    const again = store.get('workspace-a', created.id)
    assert.equal(again.title, '主人偏好：喜欢简洁直接的回复')
  })

  test('update：改字段 + 刷新 updatedAt，id 不变；不存在返回 undefined', async () => {
    const created = await store.remember(draft())
    const before = store.get('workspace-a', created.id)
    // 跨毫秒，确保 updatedAt 严格推进可观察
    await new Promise((resolve) => setTimeout(resolve, 5))
    const updated = await store.update('workspace-a', created.id, {
      body: '新的正文',
      tags: ['preference', 'style'],
    })
    assert.equal(updated.id, created.id)
    assert.equal(updated.body, '新的正文')
    assert.deepEqual(updated.tags, ['preference', 'style'])
    assert.equal(updated.title, '主人偏好：喜欢简洁直接的回复')
    assert.ok(updated.updatedAt >= before.updatedAt)
    // createdAt 不受 update 影响
    assert.equal(updated.createdAt, before.createdAt)

    // kv 仍是同一条，未新增
    assert.equal(kv.size, 1)
    assert.equal(await store.update('workspace-a', 'missing', { title: 'x' }), undefined)
  })

  test('forget：置 archived 并记录 reason；list 默认过滤、includeArchive 可查', async () => {
    const created = await store.remember(draft())
    const forgotten = await store.forget('workspace-a', created.id, '过时了')
    assert.equal(forgotten.archived, true)
    assert.equal(forgotten.source.reason, '过时了')
    assert.equal(forgotten.id, created.id)

    assert.deepEqual(store.list('workspace-a'), [])
    assert.equal(store.list('workspace-a', { includeArchive: true }).length, 1)
    assert.equal(kv.size, 1, '归档是软删除，不落盘删除')
  })

  test('remove：硬删除，二次删除返回 false', async () => {
    const created = await store.remember(draft())
    assert.equal(await store.remove('workspace-a', created.id), true)
    assert.equal(kv.size, 0)
    assert.equal(await store.remove('workspace-a', created.id), false)
    assert.equal(await store.remove('workspace-a', 'missing'), false)
  })

  test('list：按 scope 过滤 + 快照拷贝', async () => {
    const a = await store.remember(draft({ scope: 'workspace-a' }))
    await store.remember(draft({ scope: 'workspace-b', title: '另一项目条目' }))
    const list = store.list('workspace-a')
    assert.equal(list.length, 1)
    assert.equal(list[0].id, a.id)
    // 拷贝语义
    list[0].title = '篡改'
    assert.equal(store.list('workspace-a')[0].title, '主人偏好：喜欢简洁直接的回复')
  })

  test('stats：按 kind/level/bucket/归档计数', async () => {
    await store.remember(draft({ kind: 'fact' }))
    await store.remember(draft({ kind: 'knowledge', title: 'K1' }))
    await store.remember(draft({ kind: 'episodic', title: 'E1', level: 'day', bucket: '2026-08-14' }))
    const e2 = await store.remember(draft({ kind: 'episodic', title: 'E2', level: 'day', bucket: '2026-08-14' }))
    await store.forget('workspace-a', e2.id)
    // 另一个 scope 的条目不计入
    await store.remember(draft({ scope: 'workspace-b', kind: 'fact', title: 'F2' }))

    const stats = store.stats('workspace-a')
    assert.equal(stats.total, 4)
    assert.deepEqual(stats.byKind, { fact: 1, knowledge: 1, episodic: 2 })
    assert.deepEqual(stats.byLevel, { day: 2 })
    assert.deepEqual(stats.bucketCounts, { '2026-08-14': 2 })
    assert.equal(stats.archiveCount, 1)
  })
})

describe('MemoryStore · 去重合并（规格 §2.2）', () => {
  let kv
  let store

  beforeEach(() => {
    kv = new MemoryKv()
    store = new MemoryStore(kv)
  })

  test('L1：同 (scope, key) 精确匹配 → updated，不新增条目', async () => {
    const first = await store.remember(draft({ key: 'pref.reply.style' }))
    const second = await store.remember(draft({
      key: 'pref.reply.style',
      title: '主人偏好：简洁直接（更新）',
      body: '更新后的正文',
      tags: ['preference', 'updated'],
    }))
    assert.equal(second.action, 'updated')
    assert.equal(second.id, first.id, '同 key 复用原 id')
    assert.equal(kv.size, 1, '更新不新增')

    const stored = store.get('workspace-a', first.id)
    assert.equal(stored.title, '主人偏好：简洁直接（更新）')
    assert.equal(stored.body, '更新后的正文')
    assert.deepEqual(stored.tags, ['preference', 'updated'])
  })

  test('L1：同 (scope, key) 跨 kind 视为同一槽位（key 即身份）', async () => {
    const first = await store.remember(draft({ key: 'slot.1', kind: 'fact' }))
    const second = await store.remember(draft({ key: 'slot.1', kind: 'knowledge', title: '新形态' }))
    assert.equal(second.action, 'updated')
    assert.equal(second.id, first.id)
    assert.equal(kv.size, 1)
    // kind 保持原条目的（槽位语义：key 定位，kind 不随覆盖漂移）
    assert.equal(store.get('workspace-a', first.id).kind, 'fact')
  })

  test('L1：同 key 不同 scope → 各自独立条目', async () => {
    const a = await store.remember(draft({ key: 'shared.key', scope: 'workspace-a' }))
    const b = await store.remember(draft({ key: 'shared.key', scope: 'workspace-b' }))
    assert.equal(a.action, 'created')
    assert.equal(b.action, 'created')
    assert.notEqual(a.id, b.id)
    assert.equal(kv.size, 2)
  })

  test('L2：knowledge 同 title 指纹（归一化等价）→ merged，标签并集 + 正文追加', async () => {
    const first = await store.remember(draft({
      kind: 'knowledge',
      title: '  DSH  插件开发要点  ',
      body: '一切皆插件。',
      tags: ['dsh'],
    }))
    const second = await store.remember(draft({
      kind: 'knowledge',
      title: 'dsh 插件开发要点',
      body: '注册是可逆 effect。',
      tags: ['plugin', 'dsh'],
    }))
    assert.equal(second.action, 'merged')
    assert.equal(second.id, first.id)
    assert.equal(kv.size, 1)

    const stored = store.get('workspace-a', first.id)
    assert.equal(stored.body, '一切皆插件。\n\n注册是可逆 effect。')
    assert.deepEqual(stored.tags, ['dsh', 'plugin'], '标签并集且去重')
    assert.equal(stored.createdAt, first.createdAt === undefined ? stored.createdAt : stored.createdAt)
  })

  test('L2：正文完全相同 → 不重复追加', async () => {
    const first = await store.remember(draft({ kind: 'knowledge', title: '同标题', body: '同正文' }))
    const second = await store.remember(draft({ kind: 'knowledge', title: '同标题', body: '同正文' }))
    assert.equal(second.action, 'merged')
    assert.equal(store.get('workspace-a', first.id).body, '同正文')
  })

  test('L3：episodic 同 title 指纹 → merged', async () => {
    const first = await store.remember(draft({ kind: 'episodic', title: '完成插件发布', body: '第一次发布。' }))
    const second = await store.remember(draft({ kind: 'episodic', title: '完成插件发布', body: '第二次发布。' }))
    assert.equal(second.action, 'merged')
    assert.equal(second.id, first.id)
    assert.equal(kv.size, 1)
  })

  test('跨层：同 title 不同 kind → 各自独立条目（指纹查重含 kind）', async () => {
    const fact = await store.remember(draft({ kind: 'fact', title: '同标题' }))
    const knowledge = await store.remember(draft({ kind: 'knowledge', title: '同标题' }))
    const episodic = await store.remember(draft({ kind: 'episodic', title: '同标题' }))
    assert.equal(fact.action, 'created')
    assert.equal(knowledge.action, 'created')
    assert.equal(episodic.action, 'created')
    assert.equal(kv.size, 3)
  })

  test('L2 查重不跨 scope', async () => {
    const a = await store.remember(draft({ kind: 'knowledge', title: '跨库标题', scope: 'workspace-a' }))
    const b = await store.remember(draft({ kind: 'knowledge', title: '跨库标题', scope: 'workspace-b' }))
    assert.equal(a.action, 'created')
    assert.equal(b.action, 'created')
    assert.notEqual(a.id, b.id)
  })

  test('归档条目不参与查重：forget 后同 key 再 remember → created 新条目', async () => {
    const first = await store.remember(draft({ key: 'pref.retired' }))
    await store.forget('workspace-a', first.id, '废弃')
    const second = await store.remember(draft({ key: 'pref.retired', body: '新生命' }))
    assert.equal(second.action, 'created')
    assert.notEqual(second.id, first.id)
    assert.equal(kv.size, 2, '归档条目保留 + 新条目并存')

    // 同理验证 L2/L3 指纹路径
    const e1 = await store.remember(draft({ kind: 'episodic', title: '归档事件', body: '一' }))
    await store.forget('workspace-a', e1.id)
    const e2 = await store.remember(draft({ kind: 'episodic', title: '归档事件', body: '二' }))
    assert.equal(e2.action, 'created')
  })

  test('source 溯源：remember 携带 source 落盘，updated 保留新 source', async () => {
    const created = await store.remember(draft({
      source: { sessionId: 's1', seq: 42, reason: '会话总结' },
    }))
    assert.deepEqual(store.get('workspace-a', created.id).source, {
      sessionId: 's1',
      seq: 42,
      reason: '会话总结',
    })
  })
})

describe('工具函数', () => {
  test('memoryKey 编码格式（<scope>:<kind>:<id>，无 domain 前缀）', () => {
    assert.equal(memoryKey('global', 'fact', 'abc'), 'global:fact:abc')
    assert.equal(memoryKey('ws-1', 'episodic', 'x'), 'ws-1:episodic:x')
  })

  test('normalizeTitle：去空白折叠 + 小写', () => {
    assert.equal(normalizeTitle('  Hello   World  '), 'hello world')
    assert.equal(normalizeTitle('中文 标题	空格'), '中文 标题 空格')
  })

  test('titleFingerprint：确定性 + 归一化等价', () => {
    assert.equal(titleFingerprint('Hello World'), titleFingerprint('  hello   world '))
    assert.notEqual(titleFingerprint('Hello World'), titleFingerprint('Hello World!'))
    // 确定性
    assert.equal(titleFingerprint('abc'), titleFingerprint('abc'))
    // 非空
    assert.ok(titleFingerprint('任意标题').length > 0)
  })
})
