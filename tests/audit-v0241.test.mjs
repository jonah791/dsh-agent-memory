/**
 * v0.24.1 回归：体检口径与检索面对齐 + 提案自带可执行 id
 *
 * 两条都是 2026-11-18 从台账里翻出来的「工具之间不咬合」：
 *  ① `lh-4e67f6f6`：audit 遍历 entries 时缺 store 那一道冷存档过滤 ⇒ 它的「活跃条数/字符数」
 *     与检索面口径不一致（同一件事两个读数，而体检的用途恰恰是判断「谁值得继续占位置」）。
 *  ② `lh-8069f7da`：提案渲染只给标题不给 id ⇒ 要执行提案（forget / update / memory_recompress /
 *     memory_review_mark）得再花一次 browse 反查。根因已核：`findEntry` 是**精确匹配**，
 *     没有前缀解析 ⇒ 必须印全量 id，印 8 位等于让提案不可直接执行。
 *
 * 两条测试都按「能在旧实现下变红」写：① 断言 total 与 notes 自报；② 断言渲染文本里出现全量 id。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { auditMemory } from '../lib/audit.js'
import { createMemoryTools } from '../lib/tools.js'
import { DEFAULT_CONFIG } from '../lib/config.js'
import { COLD_CHECKPOINT_TAG } from '../lib/types.js'

class MemoryKv {
  constructor() { this.map = new Map() }
  get(key) { const v = this.map.get(key); return v === undefined ? undefined : { ...v } }
  async put(key, value) { this.map.set(key, { ...value }) }
  async delete(key) { return this.map.delete(key) }
  entries() { return this.map.entries() }
  get size() { return this.map.size }
}

const entry = (id, over = {}) => ({
  id,
  kind: 'knowledge',
  title: `条目 ${id.slice(0, 4)}`,
  text: `# 条目 ${id.slice(0, 4)}\n${'x'.repeat(200)}`,
  scope: 'global',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  tags: [],
  ...over,
})

const COLD_ID = 'ffffffff-1111-2222-3333-444444444444'

test('① 冷存档（checkpoint-archive）不进体检口径，且 notes 自报跳过了几条', () => {
  const result = auditMemory({
    entries: [
      entry('11111111-1111-1111-1111-111111111111'),
      entry(COLD_ID, { tags: ['compaction', COLD_CHECKPOINT_TAG] }),
    ],
    query: { topN: 10 },
  })

  // 口径：只有 1 条进体检——若旧实现，这里会是 2
  assert.equal(result.summary.total, 1, '冷存档必须不参与「活跃条数」')
  assert.ok(
    result.candidates.every((c) => c.id !== COLD_ID),
    '冷存档不应出现在候选里',
  )
  // 自报（记忆 dc1182b5）：跳过要在报告上看得见，否则「没列出来」与「不存在」同形
  const joined = result.notes.join('\n')
  assert.match(joined, /已跳过 1 条冷存档/, '必须自报跳过条数')
  assert.match(joined, /memory_browse/, '必须给出「怎么找回来」的入口')
})

test('① 无冷存档时不印跳过注脚（零噪音）', () => {
  const result = auditMemory({
    entries: [entry('22222222-2222-2222-2222-222222222222')],
    query: { topN: 10 },
  })
  assert.equal(result.summary.total, 1)
  assert.doesNotMatch(result.notes.join('\n'), /已跳过/)
})

test('② memory_audit 渲染把**全量 id** 印出来（提案可直接执行）', () => {
  // 只为拿到渲染器：构建工具不触碰 deps 的存储
  const tools = createMemoryTools({ store: undefined, loadConfig: async () => DEFAULT_CONFIG })
  const auditTool = tools.find((t) => t.name === 'memory_audit')
  assert.ok(auditTool !== undefined, 'memory_audit 工具必须存在')

  const value = {
    summary: {
      total: 1,
      chars: 1234,
      byBucket: { KEEP: 0, DEMOTE: 0, ARCHIVE: 0, REVIEW: 1 },
      charsByBucket: { KEEP: 0, DEMOTE: 0, ARCHIVE: 0, REVIEW: 1234 },
      usageSource: 'trace',
      referenced: 0,
    },
    groups: [{ key: 'knowledge/-', label: 'knowledge/-', count: 1, chars: 1234, dominantBucket: 'REVIEW' }],
    candidates: [
      {
        id: 'abcdef01-2345-6789-abcd-ef0123456789',
        kind: 'knowledge',
        title: '某条待裁决条目',
        scope: 'global',
        bucket: 'REVIEW',
        score: 0.5,
        reasons: ['体量超阈值'],
        evidence: { ageDays: 3, chars: 1234, refs: 0, usage: 0, tags: 1, hasSource: false },
      },
    ],
    notes: [],
  }

  const text = auditTool.output.render({}, value).map((c) => c.text).join('\n')
  assert.match(text, /abcdef01-2345-6789-abcd-ef0123456789/, '渲染必须含全量 id（findEntry 精确匹配）')
  assert.match(text, /某条待裁决条目/, '标题仍要在（id 是补充不是替换）')
})

test('③ 注脚默认可见（黑名单）：新增注脚不必改渲染层就能到人眼前', () => {
  const tools = createMemoryTools({ store: undefined, loadConfig: async () => DEFAULT_CONFIG })
  const auditTool = tools.find((t) => t.name === 'memory_audit')
  const value = {
    summary: {
      total: 1,
      chars: 10,
      byBucket: { KEEP: 1, DEMOTE: 0, ARCHIVE: 0, REVIEW: 0 },
      charsByBucket: { KEEP: 10, DEMOTE: 0, ARCHIVE: 0, REVIEW: 0 },
      usageSource: 'none',
      referenced: 0,
    },
    groups: [],
    candidates: [],
    // 第一条与表头重复（应被挡），第二条是「后来才加的」注脚（必须默认可见）——
    // v0.24.3 之前渲染层是白名单，这条会被静默吞掉（2026-11-18 实测现场）。
    notes: ['读数：条目 1 条 / 10 字符', '已跳过 2 条冷存档（checkpoint-archive）——要看请用 memory_browse'],
  }
  const text = auditTool.output.render({}, value).map((c) => c.text).join('\n')
  assert.match(text, /已跳过 2 条冷存档/, '新增注脚必须默认可见（黑名单形态）')
  assert.doesNotMatch(text, /读数：条目 1 条/, '与表头重复的读数码应被挡，避免同屏两遍')
})
