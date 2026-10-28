/**
 * dedupe 单测（node --test，跑构建产物 lib/dedupe.js）
 * 判据：近重复要提示、**无重复不得提示**（尸体测试）、边界与守卫。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NEAR_DUP_THRESHOLD, findNearDuplicates, formatDuplicateHint, parseDedupeTrace } from '../lib/dedupe.js'
import { readDedupeTrace } from '../lib/dedupe-trace.js'

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

// ─── 处置闭环（2026-10-28 · lh-0f54524a）────────────────────────────────────
//
// 这组的重点是**能证伪两个看起来对、实际错的实现**：
//   ① 处置时不清空桶，只打标记 ⇒ 「处置后又被撞」永远算作已处置（本例 4 抓）
//   ② 排序时不拷贝入参 ⇒ 调用方数组被就地改写（本例 5 抓）
import { unresolvedCandidates } from '../lib/dedupe.js'

const hit = (candidateId, atMs, strength = 10) => ({ kind: 'hit', candidateId, atMs, strength })
const disposed = (candidateId, atMs, disposition = 'merged') => ({ kind: 'disposed', candidateId, atMs, disposition })

test('空记录 ⇒ 无欠账', () => {
  assert.deepEqual(unresolvedCandidates([]), [])
})

test('一次命中 ⇒ 一条欠账', () => {
  const out = unresolvedCandidates([hit('c1', 100, 12)])
  assert.equal(out.length, 1)
  assert.equal(out[0].candidateId, 'c1')
  assert.equal(out[0].hitCount, 1)
  assert.equal(out[0].lastHitMs, 100)
  assert.equal(out[0].maxStrength, 12)
})

test('同一候选两次命中 ⇒ 累加，强度取大、时间取晚', () => {
  const out = unresolvedCandidates([hit('c1', 100, 30), hit('c1', 200, 8)])
  assert.equal(out[0].hitCount, 2)
  assert.equal(out[0].maxStrength, 30)
  assert.equal(out[0].lastHitMs, 200)
})

test('命中后被处置 ⇒ **清账**（处置是时间轴上的重置）', () => {
  assert.deepEqual(unresolvedCandidates([hit('c1', 100), disposed('c1', 200)]), [])
})

test('★ 处置后又被撞两次 ⇒ 重新计 2（处置**不是**永久免检）', () => {
  const out = unresolvedCandidates([hit('c1', 100), disposed('c1', 200), hit('c1', 300), hit('c1', 400)])
  assert.equal(out.length, 1)
  assert.equal(out[0].hitCount, 2)
  assert.equal(out[0].lastHitMs, 400)
})

test('尸体测试：只有处置没有命中 ⇒ 不得凭空造欠账', () => {
  assert.deepEqual(unresolvedCandidates([disposed('c1', 200)]), [])
})

test('多条候选按最后命中时间降序（最久没管的排后面，最新撞的排前面）', () => {
  const out = unresolvedCandidates([hit('c1', 100), hit('c2', 300), hit('c3', 200)])
  assert.deepEqual(out.map((x) => x.candidateId), ['c2', 'c3', 'c1'])
})

test('★ 不修改入参数组（排序前拷贝——就地排序会污染调用方的记录）', () => {
  const records = [hit('c1', 300), hit('c2', 100)]
  const before = records.map((r) => r.candidateId)
  unresolvedCandidates(records)
  assert.deepEqual(records.map((r) => r.candidateId), before)
})

test('不同候选互不干扰（处置 c1 不影响 c2）', () => {
  const out = unresolvedCandidates([hit('c1', 100), hit('c2', 150), disposed('c1', 200)])
  assert.deepEqual(out.map((x) => x.candidateId), ['c2'])
})

// ─── IO 层与解析（2026-10-28 实测踩过假报警）───────────────────────────────────

test('★ 侧车不存在 ⇒ 空数组，**不是** undefined（首次使用不是故障）', async () => {
  const out = await readDedupeTrace('/nonexistent/definitely-absent-dedupe-trace.jsonl')
  assert.deepEqual(out, [])
})

test('parseDedupeTrace：坏行跳过、结构不全的跳过，好行保留', () => {
  const text = [
    JSON.stringify({ kind: 'hit', atMs: 1, candidateId: 'c1', strength: 9 }),
    'not json at all',
    JSON.stringify({ kind: 'disposed', atMs: 2, candidateId: 'c1', disposition: 'merged' }),
    JSON.stringify({ kind: 'bogus', atMs: 3, candidateId: 'c2' }),
    JSON.stringify({ kind: 'hit', atMs: 4 }),
    '',
  ].join('\n')
  const out = parseDedupeTrace(text)
  assert.equal(out.length, 2)
  assert.equal(out[0].candidateId, 'c1')
  assert.equal(out[0].kind, 'hit')
  assert.equal(out[1].kind, 'disposed')
  assert.equal(out[1].disposition, 'merged')
})

test('parseDedupeTrace：空文本 ⇒ 空数组（不是错误）', () => {
  assert.deepEqual(parseDedupeTrace(''), [])
})
