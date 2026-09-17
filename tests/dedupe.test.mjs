/**
 * dedupe 单测（node --test，跑构建产物 lib/dedupe.js）
 * 判据：近重复要提示、**无重复不得提示**（尸体测试）、边界与守卫。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NEAR_DUP_THRESHOLD, findNearDuplicates, formatDuplicateHint } from '../lib/dedupe.js'

const entry = (over = {}) => ({
  id: 'e1',
  kind: 'knowledge',
  key: null,
  title: 'x402 收录死锁的解剖',
  body: '发现面合规即可被目录收录',
  tags: ['x402', '收录'],
  scope: 'e:/alice',
  archived: false,
  ...over,
})

test('两个共享标签即达阈值（2×3=6）⇒ 命中', () => {
  const dup = findNearDuplicates([entry()], { title: 'x402 收录死锁', tags: ['x402', '收录'] })
  assert.equal(dup.length, 1)
  assert.equal(dup[0].id, 'e1')
  assert.ok(dup[0].strength >= NEAR_DUP_THRESHOLD)
})

test('标题高度重合（2-gram 命中 ≥3）⇒ 命中', () => {
  const dup = findNearDuplicates([entry()], { title: 'x402 收录死锁的解剖（补记）', tags: [] })
  assert.equal(dup.length, 1)
})

test('尸体测试：完全无关的新条目 ⇒ **不得**提示', () => {
  const dup = findNearDuplicates(
    [entry()],
    { title: 'ComfyUI 底模瘦身', body: '只留 1.6', tags: ['comfyui', '模型'] },
  )
  assert.deepEqual(dup, [])
})

test('尸体测试：无标题 ⇒ 不得提示（守卫）', () => {
  assert.deepEqual(findNearDuplicates([entry()], { title: '   ' }), [])
})

test('归档条目不进候选（避免提示已归档的）', () => {
  const dup = findNearDuplicates([entry({ archived: true })], { title: 'x402 收录死锁', tags: ['x402', '收录'] })
  assert.deepEqual(dup, [])
})

test('阈值可覆盖：调高到 99 ⇒ 不再提示', () => {
  const dup = findNearDuplicates([entry()], { title: 'x402 收录死锁', tags: ['x402', '收录'] }, 5, 99)
  assert.deepEqual(dup, [])
})

test('按强度降序并受 limit 约束', () => {
  const many = Array.from({ length: 7 }, (_, i) =>
    entry({ id: `e${i}`, title: 'x402 收录死锁的解剖', tags: ['x402', '收录'] }),
  )
  const dup = findNearDuplicates(many, { title: 'x402 收录死锁', tags: ['x402', '收录'] }, 3)
  assert.equal(dup.length, 3)
  assert.ok(dup[0].strength >= dup[1].strength)
})

test('提示文案：含条数、id 与「先考虑 update/merge」的行动指引', () => {
  const text = formatDuplicateHint([{ id: 'e1', title: 'x402 收录', strength: 9, sharedTags: 2 }])
  assert.ok(text.includes('1 条'))
  assert.ok(text.includes('e1'))
  assert.ok(text.includes('memory_merge'))
  assert.ok(text.includes('§5.8'))
})

test('提示文案：空数组 ⇒ 空串（调用方据此省略字段）', () => {
  assert.equal(formatDuplicateHint([]), '')
})
