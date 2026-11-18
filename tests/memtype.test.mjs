/**
 * 内容分类维度单测（v0.26.0 · 方案 §3.1 七类）——memType.ts 纯函数 + 工具层行为。
 * 运行：npm test（tsc 后 node --test "tests/*.test.mjs"，导入编译产物 lib/*.js）
 *
 * 覆盖：
 *   M1 归一（容错路径）：规范值 + 中文别名；认不出 → undefined（**不是**某一类）
 *   M2 参数路径 fail-loud；过滤参数数组去重且任一项非法整笔拒绝
 *   M3 过滤：未给 ⇒ 零拷贝（同一数组引用）；**未分类条目在任何取值下都不返回**
 *   M4 计数：七类 + 未分类，**之和 == 总数**
 *   M5 渲染：有值 `·语义`，未分类**空串**（标记要挑着打）
 *   M6 端到端：remember 盖章 → recall 结果项带该字段 → stats 分布 → update 改判 / 清除
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore } from '../lib/store.js'
import { createMemoryTools } from '../lib/tools.js'
import { workspaceIdOf } from '../lib/scope.js'
import {
  MEM_TYPES,
  UNCLASSIFIED_MEM_TYPE,
  countByMemType,
  filterByMemType,
  memTypeLabel,
  memTypeTag,
  normalizeMemType,
  parseMemTypeArg,
  parseMemTypeFilterArg,
} from '../lib/memType.js'

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
  const exec = { session: { id: 'session-memtype', header: { cwd: CWD } } }
  return { store, byName, exec }
}

test('M1 归一：规范值 + 中文别名；认不出 → undefined（不是某一类）', () => {
  for (const type of MEM_TYPES) assert.equal(normalizeMemType(type), type)
  assert.equal(normalizeMemType('语义'), 'semantic')
  assert.equal(normalizeMemType('程序记忆'), 'procedural')
  assert.equal(normalizeMemType('用户画像'), 'profile')
  assert.equal(normalizeMemType('SEMANTIC'), 'semantic')
  // 刻意不收的歧义词：既可能语义也可能程序 ⇒ 不猜，返回 undefined
  assert.equal(normalizeMemType('知识'), undefined)
  assert.equal(normalizeMemType('经验'), undefined)
  assert.equal(normalizeMemType(''), undefined)
  assert.equal(normalizeMemType(undefined), undefined)
  assert.equal(normalizeMemType(42), undefined)
})

test('M2 参数路径 fail-loud；过滤参数去重且任一项非法整笔拒绝', () => {
  assert.equal(parseMemTypeArg('情景'), 'episodic')
  assert.equal(parseMemTypeArg(undefined), undefined)
  assert.throws(() => parseMemTypeArg('不存在的类'), /未知取值/)
  assert.throws(() => parseMemTypeArg(7), /必须是字符串/)

  assert.deepEqual(parseMemTypeFilterArg(['语义', 'semantic', 'project']), ['semantic', 'project'])
  assert.equal(parseMemTypeFilterArg([]), undefined)
  assert.throws(() => parseMemTypeFilterArg(['semantic', '乱写']), /未知取值/)
})

test('M3 过滤：未给 ⇒ 零拷贝；未分类条目不返回', () => {
  const entries = [
    { id: 'a', memType: 'semantic', tags: [] },
    { id: 'b', memType: 'procedural', tags: [] },
    { id: 'c', tags: [] },
  ]
  assert.equal(filterByMemType(entries, undefined), entries, '未给参数必须返回同一数组引用')
  assert.deepEqual(filterByMemType(entries, ['semantic']).map((e) => e.id), ['a'])
  // 未分类条目在明确筛某一类时**不返回**（它的类型是「不知道」）
  assert.deepEqual(filterByMemType(entries, [...MEM_TYPES]).map((e) => e.id), ['a', 'b'])
})

test('M4 计数：七类 + 未分类，之和 == 总数', () => {
  const entries = [
    { memType: 'semantic' }, { memType: 'semantic' }, { memType: 'project' }, {},
  ]
  const counts = countByMemType(entries)
  assert.equal(counts.semantic, 2)
  assert.equal(counts.project, 1)
  assert.equal(counts[UNCLASSIFIED_MEM_TYPE], 1)
  const sum = Object.values(counts).reduce((a, b) => a + b, 0)
  assert.equal(sum, entries.length, '分档之和必须等于总数（口径同体）')
})

test('M5 渲染：有值 `·语义`，未分类空串', () => {
  assert.equal(memTypeTag('semantic'), '·语义')
  assert.equal(memTypeTag('operational'), '·运行')
  assert.equal(memTypeTag(undefined), '')
  assert.equal(memTypeLabel(undefined), '未分类')
  assert.equal(memTypeLabel('procedural'), '程序')
})

test('M6 端到端：写入盖章 → recall 透出 → stats 分布 → update 改判 / 清除', async () => {
  const { byName, exec } = setup()
  const created = await byName.get('remember').execute({
    text: '# 七类端到端用例\n\n正文', memType: '语义',
  }, exec)
  assert.equal(created.action, 'created')

  const recalled = await byName.get('recall').execute({ query: '七类端到端用例' }, exec)
  const hit = recalled.results.find((item) => item.id === created.id)
  assert.ok(hit, '应能检索到刚写入的条目')
  assert.equal(hit.memType, 'semantic', '投影层必须透出 memType')

  const filtered = await byName.get('recall').execute({ query: '七类端到端用例', memType: ['procedural'] }, exec)
  assert.equal(filtered.results.some((item) => item.id === created.id), false, '筛别的类时不应命中')

  const stats = await byName.get('memory_stats').execute({}, exec)
  assert.equal(stats.byMemType.semantic, 1, 'stats 分布应反映该条目')

  // 改判（update 三态：给值 = 设置；非法值 fail-loud）
  await assert.rejects(
    () => byName.get('update').execute({ id: created.id, memType: 'program' }, exec),
    /未知取值/,
  )
  await byName.get('update').execute({ id: created.id, memType: '程序' }, exec)
  const afterSet = await byName.get('recall').execute({ query: '七类端到端用例' }, exec)
  assert.equal(afterSet.results.find((item) => item.id === created.id).memType, 'procedural')

  // 清除（空串 = 清除回未分类，字段应消失而不是留空串）
  await byName.get('update').execute({ id: created.id, memType: '' }, exec)
  const afterClear = await byName.get('recall').execute({ query: '七类端到端用例' }, exec)
  const cleared = afterClear.results.find((item) => item.id === created.id)
  assert.equal('memType' in cleared, false, '清除后该键不应存在（省略 ≠ 空串）')
})
