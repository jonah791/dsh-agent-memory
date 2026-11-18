/**
 * 空间归属维度单测（v0.27.0 · 方案 §3.2 四空间）——space.ts 纯函数 + 工具层 + 授权行为。
 * 运行：npm test（tsc 后 node --test "tests/*.test.mjs"，导入编译产物 lib/*.js）
 *
 * 覆盖：
 *   S1 归一（容错路径）：规范值 + 中文别名；认不出 → undefined（**不是**某个空间）
 *   S2 参数路径 fail-loud；过滤参数数组去重且任一项非法整笔拒绝
 *   S3 过滤：未给 ⇒ 零拷贝（同一数组引用）；**未标注条目在任何取值下都不返回**
 *   S4 计数：四空间 + 未标注，**之和 == 总数**
 *   S5 渲染：有值 `〔个人〕`，未标注**空串**（标记要挑着打）
 *   S6 端到端：remember 盖章 → recall 按空间过滤 → stats 分布 → update 清除
 *   S7 授权：roles 启用且策略给了 spaces ⇒ 未标注条目**不放行**（fail-closed）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore } from '../lib/store.js'
import { createMemoryTools } from '../lib/tools.js'
import { workspaceIdOf } from '../lib/scope.js'
import { admitsEntry, roleViewOf } from '../lib/role.js'
import {
  SPACES,
  UNCLASSIFIED_SPACE,
  countBySpace,
  filterBySpace,
  normalizeSpace,
  parseSpaceArg,
  parseSpaceFilterArg,
  spaceTag,
} from '../lib/space.js'

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

function setup(config = CONFIG) {
  const store = new MemoryStore(new MemoryKv())
  const tools = createMemoryTools({ store, loadConfig: () => config })
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const exec = { session: { id: 'session-space', header: { cwd: CWD } } }
  return { store, byName, exec }
}

test('S1 归一：规范值 + 中文别名；认不出 → undefined（不是某个空间）', () => {
  for (const space of SPACES) assert.equal(normalizeSpace(space), space)
  assert.equal(normalizeSpace('个人'), 'personal')
  assert.equal(normalizeSpace('项目空间'), 'project')
  assert.equal(normalizeSpace('领域'), 'domain')
  assert.equal(normalizeSpace('系统运行'), 'system')
  assert.equal(normalizeSpace('DOMAIN'), 'domain')
  // 刻意不收：不是方案四空间之一（收进来等于把「我不知道」写成「我知道」）
  assert.equal(normalizeSpace('通用'), undefined)
  assert.equal(normalizeSpace('公共'), undefined)
  assert.equal(normalizeSpace(''), undefined)
  assert.equal(normalizeSpace(undefined), undefined)
  assert.equal(normalizeSpace(7), undefined)
})

test('S2 参数路径 fail-loud；过滤参数去重且任一项非法整笔拒绝', () => {
  assert.equal(parseSpaceArg('个人'), 'personal')
  assert.equal(parseSpaceArg(undefined), undefined)
  assert.throws(() => parseSpaceArg('随便'), /未知取值/)
  assert.throws(() => parseSpaceArg(3), /必须是字符串/)

  assert.deepEqual(parseSpaceFilterArg(['领域', 'domain', 'system']), ['domain', 'system'])
  assert.equal(parseSpaceFilterArg([]), undefined)
  assert.throws(() => parseSpaceFilterArg(['domain', '乱写']), /未知取值/)
})

test('S3 过滤：未给 ⇒ 零拷贝；未标注条目不返回', () => {
  const entries = [
    { id: 'a', space: 'personal' },
    { id: 'b', space: 'project' },
    { id: 'c' },
  ]
  assert.equal(filterBySpace(entries, undefined), entries)
  assert.deepEqual(filterBySpace(entries, ['personal']).map((e) => e.id), ['a'])
  assert.deepEqual(filterBySpace(entries, ['personal', 'project']).map((e) => e.id), ['a', 'b'])
  // 未标注在**任何**取值下都不返回（它的空间是「不知道」）
  assert.deepEqual(filterBySpace(entries, ['personal', 'project', 'domain', 'system']).map((e) => e.id), ['a', 'b'])
})

test('S4 计数：四空间 + 未标注，之和 == 总数', () => {
  const entries = [
    { space: 'personal' },
    { space: 'personal' },
    { space: 'system' },
    {},
    { space: 'not-a-space' },
  ]
  const counts = countBySpace(entries)
  assert.equal(counts.personal, 2)
  assert.equal(counts.system, 1)
  assert.equal(counts[UNCLASSIFIED_SPACE], 2)
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), entries.length)
})

test('S5 渲染：有值「〔个人〕」，未标注空串', () => {
  assert.equal(spaceTag('personal'), '〔个人〕')
  assert.equal(spaceTag('domain'), '〔领域〕')
  assert.equal(spaceTag(undefined), '')
  assert.equal(spaceTag('bogus'), '')
})

test('S6 端到端：remember 盖章 → recall 过滤 → stats 分布 → update 清除', async () => {
  const { byName, exec } = setup()
  const one = await byName.get('remember').execute(
    { text: '空间归属测试：属于个人空间的一条', space: 'personal', memType: 'profile' },
    exec,
  )
  const two = await byName.get('remember').execute(
    { text: '空间归属测试：属于领域空间的一条', space: 'domain', memType: 'semantic' },
    exec,
  )
  assert.ok(one.id.length > 0)
  assert.ok(two.id.length > 0)

  const hit = await byName.get('recall').execute({ query: '空间归属测试', space: ['domain'] }, exec)
  assert.equal(hit.results.length, 1)
  assert.equal(hit.results[0].id, two.id)
  assert.equal(hit.results[0].space, 'domain')

  const stats = await byName.get('memory_stats').execute({}, exec)
  assert.equal(stats.bySpace.personal, 1)
  assert.equal(stats.bySpace.domain, 1)
  const sum = Object.values(stats.bySpace).reduce((a, b) => a + b, 0)
  assert.equal(sum, stats.total)

  const cleared = await byName.get('update').execute({ id: one.id, space: '' }, exec)
  assert.equal(cleared.space, undefined)
  // 清除后按 personal 过滤不再命中它（未标注不匹配任何取值）
  const after = await byName.get('recall').execute({ query: '空间归属测试', space: ['personal'] }, exec)
  assert.equal(after.results.length, 0)
})

test('S7 授权：策略给了 spaces ⇒ 未标注条目不放行（fail-closed）', () => {
  const config = {
    ...CONFIG,
    roles: {
      enabled: true,
      default: 'main',
      derived: 'sub',
      byPreset: {},
      policyDefault: { read: ['*'], includeShared: true, includeGlobal: true },
      policies: { main: { read: ['*'], includeShared: true, includeGlobal: true, spaces: ['personal'] } },
    },
  }
  const view = roleViewOf(config, { session: { id: 'human-1' } })
  assert.equal(view.policy.spaces.length, 1)
  assert.equal(admitsEntry(view.policy, 'main', { kind: 'fact', space: 'personal' }), true)
  assert.equal(admitsEntry(view.policy, 'main', { kind: 'fact', space: 'domain' }), false)
  // 「不知道属于哪个空间」不能当「所有空间都可读」
  assert.equal(admitsEntry(view.policy, 'main', { kind: 'fact' }), false)
  // 未设 spaces 的策略不受影响（零迁移）
  const open = roleViewOf(config, { session: { id: 'human-1' } }, 'sub')
  assert.equal(admitsEntry(open.policy, 'sub', { kind: 'fact', space: 'system' }), true)
  assert.equal(admitsEntry(open.policy, 'sub', { kind: 'fact' }), true)
})
