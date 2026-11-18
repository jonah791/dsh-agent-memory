/**
 * 生命周期六态单测（v0.27.0 · 方案 §3.3）——lifecycle.ts 纯函数 + 工具层行为。
 * 运行：npm test（tsc 后 node --test "tests/*.test.mjs"，导入编译产物 lib/*.js）
 *
 * 覆盖：
 *   L1 六态判定与**优先级**（deleted > archived > superseded > disputed > pending > active）
 *   L2 参数路径 fail-loud：只收两态；`active` / 空串 = 清除；其余报错并指出真实载体
 *   L3 过滤与计数：六态之和 == 总数
 *   L4 注入判据 isInjectable：pending / archived / deleted 不进上下文
 *   L5 渲染标记：只给 pending / disputed / deleted 三态
 *   L6 端到端：remember pending → 显式召回可见 → update 清空 ⇒ active
 *   L7 删除态：forget(reasonType=deleted) ⇒ lifecycleOf=deleted，且按 status=['deleted'] 能查到
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore } from '../lib/store.js'
import { createMemoryTools } from '../lib/tools.js'
import { workspaceIdOf } from '../lib/scope.js'
import {
  LIFECYCLE_STATES,
  countByLifecycle,
  filterByLifecycle,
  isInjectable,
  lifecycleOf,
  lifecycleTag,
  parseLifecycleFilterArg,
  parseStatusArg,
} from '../lib/lifecycle.js'

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
  const tools = createMemoryTools({ store, loadConfig: () => CONFIG })
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const exec = { session: { id: 'session-lifecycle', header: { cwd: CWD } } }
  return { store, byName, exec }
}

test('L1 六态判定与优先级', () => {
  assert.equal(lifecycleOf({}), 'active')
  assert.equal(lifecycleOf({ status: 'pending' }), 'pending')
  assert.equal(lifecycleOf({ status: 'disputed' }), 'disputed')
  assert.equal(lifecycleOf({ supersededBy: 'x' }), 'superseded')
  assert.equal(lifecycleOf({ archived: true }), 'archived')
  assert.equal(lifecycleOf({ archived: true, archivedReasonType: 'deleted' }), 'deleted')
  // 优先级：已删除 > 已归档 > 已被取代 > 存疑 > 待审核 > 有效
  assert.equal(lifecycleOf({ archived: true, supersededBy: 'x', status: 'pending' }), 'archived')
  assert.equal(lifecycleOf({ archived: true, archivedReasonType: 'deleted', supersededBy: 'x' }), 'deleted')
  assert.equal(lifecycleOf({ supersededBy: 'x', status: 'disputed' }), 'superseded')
  assert.equal(lifecycleOf({ status: 'disputed', pending: true }), 'disputed')
})

test('L2 参数路径：只收两态；active / 空串 = 清除；其余 fail-loud', () => {
  assert.equal(parseStatusArg('待审'), 'pending')
  assert.equal(parseStatusArg('disputed'), 'disputed')
  assert.equal(parseStatusArg('active'), undefined)
  assert.equal(parseStatusArg(''), undefined)
  assert.equal(parseStatusArg(undefined), undefined)
  // 其余四态走既有载体，不许从这里设——报错要指出真实入口
  assert.throws(() => parseStatusArg('archived'), /未知取值/)
  assert.throws(() => parseStatusArg('deleted'), /未知取值/)
  assert.throws(() => parseStatusArg('superseded'), /未知取值/)
  assert.throws(() => parseStatusArg(7), /必须是字符串/)
})

test('L3 过滤与计数：六态之和 == 总数', () => {
  const entries = [
    { id: 'a' },
    { id: 'b', status: 'pending' },
    { id: 'c', status: 'disputed' },
    { id: 'd', supersededBy: 'x' },
    { id: 'e', archived: true },
    { id: 'f', archived: true, archivedReasonType: 'deleted' },
  ]
  assert.equal(filterByLifecycle(entries, undefined), entries)
  assert.deepEqual(filterByLifecycle(entries, ['pending']).map((e) => e.id), ['b'])
  assert.deepEqual(filterByLifecycle(entries, ['active', 'disputed']).map((e) => e.id), ['a', 'c'])

  const counts = countByLifecycle(entries)
  for (const state of LIFECYCLE_STATES) assert.equal(counts[state], 1)
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), entries.length)

  assert.deepEqual(parseLifecycleFilterArg(['archived', 'deleted']), ['archived', 'deleted'])
  assert.equal(parseLifecycleFilterArg([]), undefined)
  assert.throws(() => parseLifecycleFilterArg(['archived', 'bogus']), /未知取值/)
})

test('L4 注入判据：pending / archived / deleted 不进上下文', () => {
  assert.equal(isInjectable({}), true)
  assert.equal(isInjectable({ status: 'disputed' }), true)
  assert.equal(isInjectable({ supersededBy: 'x' }), true)
  assert.equal(isInjectable({ status: 'pending' }), false)
  assert.equal(isInjectable({ archived: true }), false)
  assert.equal(isInjectable({ archived: true, archivedReasonType: 'deleted' }), false)
})

test('L5 渲染标记：只给三态（其余留空，由既有 tag 渲染）', () => {
  assert.equal(lifecycleTag('pending'), '⏳待审')
  assert.equal(lifecycleTag('disputed'), '❓存疑')
  assert.equal(lifecycleTag('deleted'), '🗑已删')
  assert.equal(lifecycleTag('active'), '')
  assert.equal(lifecycleTag('archived'), '')
  assert.equal(lifecycleTag('superseded'), '')
  assert.equal(lifecycleTag(undefined), '')
})

test('L6 端到端：remember pending → 显式召回可见 → update 清空 ⇒ active', async () => {
  const { byName, exec } = setup()
  const created = await byName.get('remember').execute(
    { text: '生命周期测试：一条待审核的候选记忆', status: 'pending', memType: 'project' },
    exec,
  )
  const recalled = await byName.get('recall').execute({ query: '生命周期测试', status: ['pending'] }, exec)
  assert.equal(recalled.results.length, 1)
  assert.equal(recalled.results[0].lifecycle, 'pending')

  // 未标注状态的条目不会出现在 pending 过滤里
  const none = await byName.get('recall').execute({ query: '生命周期测试', status: ['active'] }, exec)
  assert.equal(none.results.length, 0)

  const approved = await byName.get('update').execute({ id: created.id, status: '' }, exec)
  assert.equal(approved.status, undefined)
  const active = await byName.get('recall').execute({ query: '生命周期测试', status: ['active'] }, exec)
  assert.equal(active.results.length, 1)
  assert.equal(active.results[0].lifecycle, 'active')
})

test('L7 删除态：forget(reasonType=deleted) ⇒ deleted，且可按 status 查到', async () => {
  const { byName, exec } = setup()
  const created = await byName.get('remember').execute(
    { text: '生命周期测试：这条要被删除', memType: 'episodic' },
    exec,
  )
  await byName.get('forget').execute({ id: created.id, reasonType: 'deleted', reason: '单测删除' }, exec)

  const stats = await byName.get('memory_stats').execute({}, exec)
  assert.equal(stats.byLifecycle.deleted, 1)
  const sum = Object.values(stats.byLifecycle).reduce((a, b) => a + b, 0)
  assert.equal(sum, stats.total)

  // 按 deleted 过滤时**自动包含归档**（不必再传 includeArchive）
  const deleted = await byName.get('recall').execute({ query: '生命周期测试', status: ['deleted'] }, exec)
  assert.equal(deleted.results.length, 1)
  assert.equal(deleted.results[0].lifecycle, 'deleted')
  assert.equal(deleted.results[0].archivedReasonType, 'deleted')
})
