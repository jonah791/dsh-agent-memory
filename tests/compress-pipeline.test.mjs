/**
 * 压缩流水线判定与轨迹发射离线单测（v0.8 · §5.12）
 *
 * 覆盖三件事：
 * 1. `explainCompressions` 的判定命名（not-ended / no-sources / already-summarized / pending）
 *    —— 判据优先级 = 短路顺序，与重构前的 `findPendingCompressions` 语义一致；
 * 2. **判据单一真源**：`findPendingCompressions` == `explainCompressions(...)` 里 pending 的投影；
 * 3. 轨迹发射：首轮 scan（含非待压判定分布 + 逐桶样本）/ unit / end；
 *    以及**零回归硬约束**——不提供 sink 时压缩结果逐字段与提供 sink 时一致（观测不改行为）。
 *
 * 运行：pnpm test:all（先 build 再 node --test）
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { explainCompressions, findPendingCompressions, TimelineCompressor } from '../lib/timeline.js'
import { MemoryStore, memoryKey } from '../lib/store.js'
import { DEFAULT_CONFIG } from '../lib/config.js'

/** 内存 mock kv（与 timeline.test.mjs 同款） */
class MemoryKv {
  constructor() {
    this.map = new Map()
    this.writes = []
    this.deletes = []
  }
  get(key) { return this.map.get(key) }
  async put(key, value) { this.map.set(key, value); this.writes.push({ key, value }) }
  async delete(key) { const existed = this.map.has(key); this.map.delete(key); this.deletes.push(key); return existed }
  entries() { return this.map.entries() }
  get size() { return this.map.size }
}

/** 直接构造 Entry（createdAt/bucket 可控，绕过 remember 的 now 戳） */
function entry(overrides = {}) {
  const base = {
    id: randomUUID(),
    kind: 'episodic',
    title: '情景条目',
    body: '正文内容',
    tags: [],
    scope: 'ws',
    createdAt: '2026-08-05T00:00:00.000Z',
    updatedAt: '2026-08-05T00:00:00.000Z',
    accessedAt: '2026-08-05T00:00:00.000Z',
    level: 'day',
    bucket: '2026-08-05',
    archived: false,
  }
  return { ...base, ...overrides }
}

function seeded(entries) {
  const kv = new MemoryKv()
  const store = new MemoryStore(kv)
  for (const e of entries) kv.map.set(memoryKey(e.scope, e.kind, e.id), { ...e })
  return { kv, store }
}

const NOW = new Date(2026, 7, 14) // 2026-08-14 周五（W33）

describe('explainCompressions：把「为什么没压」命名化', () => {
  test('四种判定各有其桶，且优先级 = 短路顺序', () => {
    const entries = [
      // ① 已结束 + 有原料 + 无概要 ⇒ pending
      entry({ id: 'a', bucket: '2026-08-05' }),
      // ② 原料已被归档 ⇒ no-sources（归档条目不参与压缩）
      entry({ id: 'b', bucket: '2026-08-06', archived: true }),
      // ③ 已有同层概要 ⇒ already-summarized（幂等）
      entry({ id: 'c', bucket: '2026-08-07' }),
      entry({ id: 'd', bucket: '2026-08-07', kind: 'summary', level: 'day', title: '日概要 2026-08-07' }),
      // ④ 当前单位未结束 ⇒ not-ended
      entry({ id: 'e', bucket: '2026-08-14' }),
    ]
    const verdicts = explainCompressions(entries, DEFAULT_CONFIG, NOW)
    const dayOf = (bucket) => verdicts.find((v) => v.level === 'day' && v.bucket === bucket)?.decision
    assert.equal(dayOf('2026-08-05'), 'pending')
    assert.equal(dayOf('2026-08-06'), 'no-sources')
    assert.equal(dayOf('2026-08-07'), 'already-summarized')
    assert.equal(dayOf('2026-08-14'), 'not-ended')
    // 前一自然日（无原料）也要作为候选出现并被点名
    assert.equal(dayOf('2026-08-13'), 'no-sources')
  })

  test('判据单一真源：findPendingCompressions == explain 里 pending 的投影（含顺序）', () => {
    const entries = [
      entry({ id: 'a', bucket: '2026-08-05' }),
      entry({ id: 'b', bucket: '2026-08-06' }),
      entry({ id: 'c', bucket: '2026-08-07' }),
      entry({ id: 'd', bucket: '2026-08-07', kind: 'summary', level: 'day', title: '日概要 2026-08-07' }),
    ]
    const projected = explainCompressions(entries, DEFAULT_CONFIG, NOW)
      .filter((v) => v.decision === 'pending')
      .map((v) => ({ level: v.level, bucket: v.bucket }))
    assert.deepEqual(findPendingCompressions(entries, DEFAULT_CONFIG, NOW), projected)
    assert.ok(projected.length >= 2)
  })
})

describe('compressPending：轨迹发射（回答五问 ③「断在哪一段」）', () => {
  test('首轮 scan 落候选数/待压数/非待压判定分布/逐桶样本；每单元落 unit；收尾落 end', async () => {
    const { store } = seeded([
      entry({ id: 'a', bucket: '2026-08-05' }),
      entry({ id: 'b', bucket: '2026-08-05' }),
      entry({ id: 'c', bucket: '2026-08-07' }),
      entry({ id: 'd', bucket: '2026-08-07', kind: 'summary', level: 'day', title: '日概要 2026-08-07' }),
      entry({ id: 'e', bucket: '2026-08-14' }), // 未结束
    ])
    const events = []
    const compressor = new TimelineCompressor(store, DEFAULT_CONFIG, async (input) => `这是${input.level}概要`, (event) => events.push(event))
    const results = await compressor.compressPending('ws', NOW)

    const scan = events.find((e) => e.phase === 'scan')
    assert.ok(scan !== undefined, '必须落一条 scan')
    assert.ok(scan.candidates > 0)
    assert.ok(scan.pending >= 1)
    assert.equal(scan.skipped.pending, undefined, 'skipped 只统计非待压判定')
    assert.ok(scan.skipped['already-summarized'] >= 1)
    assert.ok(scan.skipped['not-ended'] >= 1)
    assert.ok(scan.sample.includes('day 2026-08-05 pending'))
    assert.ok(scan.sample.some((line) => line.endsWith('already-summarized')))
    assert.ok(scan.sample.length <= 40, '样本受 MAX_SAMPLE 约束')

    const units = events.filter((e) => e.phase === 'unit')
    assert.ok(units.length >= 1)
    const dayUnit = units.find((u) => u.level === 'day' && u.bucket === '2026-08-05')
    assert.equal(dayUnit.reason, 'compressed')
    assert.ok(dayUnit.chars > 0)
    assert.equal(typeof dayUnit.durMs, 'number')

    const end = events.find((e) => e.phase === 'end')
    assert.ok(end !== undefined)
    assert.equal(end.units, results.filter((r) => r.reason === 'compressed').length)
    assert.equal(events.length, 1 + units.length + 1, '事件序列 = scan + 每个 pending 单元 + end')
  })

  test('零回归硬约束：不给 sink ⇒ 压缩结果逐字段一致（观测不改行为）', async () => {
    const fixture = () => [
      entry({ id: 'a', bucket: '2026-08-05' }),
      entry({ id: 'b', bucket: '2026-08-05' }),
    ]
    const summarize = async (input) => `这是${input.level}概要`
    const { store: storeA } = seeded(fixture())
    const withTrace = await new TimelineCompressor(storeA, DEFAULT_CONFIG, summarize, () => {}).compressPending('ws', NOW)
    const { store: storeB } = seeded(fixture())
    const withoutTrace = await new TimelineCompressor(storeB, DEFAULT_CONFIG, summarize).compressPending('ws', NOW)

    const shape = (results) => results.map((r) => ({
      reason: r.reason,
      skipped: r.skipped,
      archived: r.archivedIds.length,
      level: r.summary?.level ?? null,
      bucket: r.summary?.bucket ?? null,
      title: r.summary?.title ?? null,
      body: r.summary?.body ?? null,
    }))
    assert.deepEqual(shape(withTrace), shape(withoutTrace))
    // 归档量也要一致（压缩的副作用面不能被观测改动）
    assert.equal(storeA.size, storeB.size)
  })

  test('总结抛错 ⇒ 落 error 轨迹后原样上抛（只加观测，不改控制流）', async () => {
    const { store } = seeded([entry({ id: 'a', bucket: '2026-08-05' })])
    const events = []
    const compressor = new TimelineCompressor(store, DEFAULT_CONFIG, async () => { throw new Error('总结炸了') }, (event) => events.push(event))
    await assert.rejects(() => compressor.compressPending('ws', NOW), /总结炸了/)
    const error = events.find((e) => e.phase === 'error')
    assert.ok(error !== undefined, '异常必须留证（§5.24：兜底必须留证）')
    assert.equal(error.bucket, '2026-08-05')
    assert.match(error.message, /总结炸了/)
  })
})
