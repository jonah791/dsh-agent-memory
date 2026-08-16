/**
 * 时间压缩线离线单测（T6 验收）：覆盖
 * - bucket 算法边界：周一 / 跨年 W01 / 年初归上年 W53 / 跨月跨年
 * - 懒压缩触发 findPendingCompressions：已结束日/周原料 / 幂等 / L1-L2 隔离 / 配置开关
 * - 压缩执行 compressUnit：产物字段（level/bucket/archiveRef/标题/正文）/ 归档标记 / 跳过分支
 * - 层级链：episodic → 日概要 → 周概要 → 月概要 → 年概要（金字塔逐层再总结）
 * - compressPending 懒压缩入口一次处理多单位
 * 运行：pnpm test（先 build 再 node --test）
 */

import { describe, test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  dayBucket, weekBucket, monthBucket, yearBucket, bucketKey,
  previousBucketKey, bucketRange, bucketBelongsTo,
  findPendingCompressions, TimelineCompressor,
} from '../lib/timeline.js'
import { MemoryStore, memoryKey } from '../lib/store.js'
import { DEFAULT_CONFIG } from '../lib/config.js'

/** 内存 mock kv（与 store.test.mjs 同款，写路径可断言） */
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

/** 直接构造 Entry 对象（createdAt/bucket 可控，绕过 remember 的 now 戳） */
function entry(overrides = {}) {
  const base = {
    id: randomUUID(),
    kind: 'episodic',
    title: '情景条目',
    body: '正文内容',
    tags: [],
    scope: 'workspace-a',
    createdAt: '2026-08-05T00:00:00.000Z',
    updatedAt: '2026-08-05T00:00:00.000Z',
    accessedAt: '2026-08-05T00:00:00.000Z',
    level: 'day',
    bucket: '2026-08-05',
    archived: false,
  }
  return { ...base, ...overrides }
}

/** 建 store + 注入若干条目，返回 { kv, store, ids } */
function seeded(entries) {
  const kv = new MemoryKv()
  const store = new MemoryStore(kv)
  for (const e of entries) {
    kv.map.set(memoryKey(e.scope, e.kind, e.id), { ...e })
  }
  return { kv, store }
}

/** fake 总结：捕获入参并返回固定文本 */
function fakeSummarize(captured) {
  return async (input) => {
    captured.push(input)
    return `这是${input.level}概要正文`
  }
}

// 固定时刻：2026-08-14（周五，W33；上月 2026-07；去年 2025）
const NOW = new Date(2026, 7, 14)

describe('时间桶算法（本地时区）', () => {
  test('day：YYYY-MM-DD 本地日期', () => {
    assert.equal(dayBucket(new Date(2026, 7, 14)), '2026-08-14')
    assert.equal(dayBucket(new Date(2026, 0, 1)), '2026-01-01')
  })

  test('week：周一为一周起点，同周桶键一致', () => {
    assert.equal(weekBucket(new Date(2026, 7, 10)), '2026-W33') // 周一
    assert.equal(weekBucket(new Date(2026, 7, 14)), '2026-W33') // 周五
    assert.equal(weekBucket(new Date(2026, 7, 16)), '2026-W33') // 周日
    assert.equal(weekBucket(new Date(2026, 7, 17)), '2026-W34') // 下周一
  })

  test('week 跨年：12 月末归次年 W01', () => {
    assert.equal(weekBucket(new Date(2024, 11, 30)), '2025-W01') // 2024-12-30 周一
    assert.equal(weekBucket(new Date(2026, 11, 28)), '2026-W53') // 2026-12-28 周一
  })

  test('week 年初：1 月初可能归上年 W53', () => {
    assert.equal(weekBucket(new Date(2021, 0, 1)), '2020-W53') // 2021-01-01 周五
    assert.equal(weekBucket(new Date(2026, 0, 1)), '2026-W01') // 2026-01-01 周四
  })

  test('month / year：YYYY-MM / YYYY', () => {
    assert.equal(monthBucket(new Date(2026, 7, 14)), '2026-08')
    assert.equal(monthBucket(new Date(2026, 0, 31)), '2026-01')
    assert.equal(yearBucket(new Date(2026, 7, 14)), '2026')
  })

  test('bucketKey：按层级统一入口', () => {
    const d = new Date(2026, 7, 14)
    assert.equal(bucketKey('day', d), '2026-08-14')
    assert.equal(bucketKey('week', d), '2026-W33')
    assert.equal(bucketKey('month', d), '2026-08')
    assert.equal(bucketKey('year', d), '2026')
  })
})

describe('previousBucketKey 上一自然单位', () => {
  test('day：前一天，跨月/跨年自动进位', () => {
    assert.equal(previousBucketKey('day', new Date(2026, 7, 14)), '2026-08-13')
    assert.equal(previousBucketKey('day', new Date(2026, 7, 1)), '2026-07-31')
    assert.equal(previousBucketKey('day', new Date(2026, 0, 1)), '2025-12-31')
  })

  test('week：前一周（同星期几），跨年正确', () => {
    assert.equal(previousBucketKey('week', new Date(2026, 7, 14)), '2026-W32')
    assert.equal(previousBucketKey('week', new Date(2026, 0, 1)), '2025-W52') // 2026-01-01 周四 → 2025-12-25 周四
  })

  test('month：上一月，跨年正确', () => {
    assert.equal(previousBucketKey('month', new Date(2026, 7, 14)), '2026-07')
    assert.equal(previousBucketKey('month', new Date(2026, 0, 15)), '2025-12')
  })

  test('year：上一年', () => {
    assert.equal(previousBucketKey('year', new Date(2026, 7, 14)), '2025')
  })
})

describe('bucketRange 时间范围', () => {
  test('day：当天 00:00 ~ 次日 00:00', () => {
    const r = bucketRange('day', '2026-08-14')
    assert.deepEqual(r.start, new Date(2026, 7, 14))
    assert.deepEqual(r.end, new Date(2026, 7, 15))
    assert.equal(r.label, '2026-08-14')
  })

  test('week：周一起点；W01 可跨年（2026-W01 从 2025-12-29 开始）', () => {
    const r = bucketRange('week', '2026-W01')
    assert.deepEqual(r.start, new Date(2025, 11, 29))
    assert.deepEqual(r.end, new Date(2026, 0, 5))
    assert.equal(r.label, '2026-W01（2025-12-29 ~ 2026-01-04）')
  })

  test('month：1 号 ~ 下月 1 号（跨年与大小月）', () => {
    const r1 = bucketRange('month', '2026-02')
    assert.deepEqual(r1.start, new Date(2026, 1, 1))
    assert.deepEqual(r1.end, new Date(2026, 2, 1))
    assert.equal(r1.label, '2026-02（2026-02-01 ~ 2026-02-28）')
    const r2 = bucketRange('month', '2025-12')
    assert.deepEqual(r2.end, new Date(2026, 0, 1))
  })

  test('year：1 月 1 日 ~ 次年 1 月 1 日', () => {
    const r = bucketRange('year', '2026')
    assert.deepEqual(r.start, new Date(2026, 0, 1))
    assert.deepEqual(r.end, new Date(2027, 0, 1))
    assert.equal(r.label, '2026（2026-01-01 ~ 2026-12-31）')
  })

  test('非法桶键 fail loud', () => {
    assert.throws(() => bucketRange('week', '2026-08'), /非法周桶键/)
    assert.throws(() => bucketRange('month', '2026'), /非法月桶键/)
    assert.throws(() => bucketRange('year', '26'), /非法年桶键/)
  })
})

describe('bucketBelongsTo 上下级归属', () => {
  test('日桶属于其所在周', () => {
    assert.equal(bucketBelongsTo('day', '2026-08-10', 'week', '2026-W33'), true) // 周一
    assert.equal(bucketBelongsTo('day', '2026-08-16', 'week', '2026-W33'), true) // 周日
    assert.equal(bucketBelongsTo('day', '2026-08-17', 'week', '2026-W33'), false) // 下周一
  })

  test('周桶属于其起点所在月（跨月周归入开始的月）', () => {
    assert.equal(bucketBelongsTo('week', '2026-W32', 'month', '2026-08'), true) // 周一 08-03
    assert.equal(bucketBelongsTo('week', '2026-W31', 'month', '2026-08'), false) // 周一 07-27
    assert.equal(bucketBelongsTo('week', '2025-W01', 'month', '2025-12'), false) // 周一 2024-12-29
  })

  test('月桶属于其所在年', () => {
    assert.equal(bucketBelongsTo('month', '2026-08', 'year', '2026'), true)
    assert.equal(bucketBelongsTo('month', '2025-12', 'year', '2026'), false)
  })
})

describe('findPendingCompressions 懒压缩触发', () => {
  test('已结束日有未压缩 episodic → 待压缩 day；今天不动', () => {
    const { store } = seeded([
      entry({ id: 'a', bucket: '2026-08-05' }),
      entry({ id: 'b', bucket: '2026-08-06' }),
      entry({ id: 'c', bucket: '2026-08-14' }), // 今天，未结束
    ])
    const pending = findPendingCompressions(store.list('workspace-a', { includeArchive: true }), DEFAULT_CONFIG, NOW)
    assert.deepEqual(pending, [
      { level: 'day', bucket: '2026-08-05' },
      { level: 'day', bucket: '2026-08-06' },
    ])
  })

  test('上周有未压缩 day 概要 → 待压缩 week', () => {
    const { store } = seeded([
      entry({ id: 'd1', kind: 'summary', level: 'day', bucket: '2026-08-05', title: '日概要 2026-08-05' }), // W32
      entry({ id: 'd2', kind: 'summary', level: 'day', bucket: '2026-08-14', title: '日概要 2026-08-14' }), // 本周 W33
    ])
    const pending = findPendingCompressions(store.list('workspace-a', { includeArchive: true }), DEFAULT_CONFIG, NOW)
    assert.deepEqual(pending, [{ level: 'week', bucket: '2026-W32' }])
  })

  test('上一自然月有未压缩 week 概要 → 待压缩 month', () => {
    const { store } = seeded([
      entry({ id: 'w', kind: 'summary', level: 'week', bucket: '2026-W30', title: '周概要 2026-W30' }), // 周一 07-20 ∈ 7 月
    ])
    const pending = findPendingCompressions(store.list('workspace-a', { includeArchive: true }), DEFAULT_CONFIG, NOW)
    assert.deepEqual(pending, [{ level: 'month', bucket: '2026-07' }])
  })

  test('上一年有未压缩 month 概要 → 待压缩 year', () => {
    const { store } = seeded([
      entry({ id: 'm', kind: 'summary', level: 'month', bucket: '2025-06', title: '月概要 2025-06' }),
    ])
    const pending = findPendingCompressions(store.list('workspace-a', { includeArchive: true }), DEFAULT_CONFIG, NOW)
    assert.deepEqual(pending, [{ level: 'year', bucket: '2025' }])
  })

  test('L1 fact / L2 knowledge 永不参与压缩', () => {
    const { store } = seeded([
      entry({ id: 'f', kind: 'fact', key: 'k1', bucket: '2026-08-05' }),
      entry({ id: 'k', kind: 'knowledge', bucket: '2026-08-05' }),
    ])
    const pending = findPendingCompressions(store.list('workspace-a', { includeArchive: true }), DEFAULT_CONFIG, NOW)
    assert.deepEqual(pending, [])
  })

  test('目标桶已有同层级概要 → 幂等不重复（链完整则无事可做）', () => {
    const { store } = seeded([
      entry({ id: 'a', bucket: '2026-08-05' }),
      entry({ id: 'd', kind: 'summary', level: 'day', bucket: '2026-08-05', title: '日概要 2026-08-05' }),
      entry({ id: 'w', kind: 'summary', level: 'week', bucket: '2026-W32', title: '周概要 2026-W32' }),
    ])
    const pending = findPendingCompressions(store.list('workspace-a', { includeArchive: true }), DEFAULT_CONFIG, NOW)
    assert.deepEqual(pending, [])
  })

  test('已归档原料不再触发', () => {
    const { store } = seeded([
      entry({ id: 'a', bucket: '2026-08-05', archived: true }),
    ])
    const pending = findPendingCompressions(store.list('workspace-a', { includeArchive: true }), DEFAULT_CONFIG, NOW)
    assert.deepEqual(pending, [])
  })

  test('timeline 开关关闭的层级不触发', () => {
    const { store } = seeded([entry({ id: 'a', bucket: '2026-08-05' })])
    const config = {
      ...DEFAULT_CONFIG,
      timeline: { ...DEFAULT_CONFIG.timeline, day: false },
    }
    const pending = findPendingCompressions(store.list('workspace-a', { includeArchive: true }), config, NOW)
    assert.deepEqual(pending, [])
  })

  test('多个层级同时待压缩（周+月+年；同日已有日概要则 day 幂等跳过）', () => {
    const { store } = seeded([
      entry({ id: 'a', bucket: '2026-08-05' }),
      entry({ id: 'd', kind: 'summary', level: 'day', bucket: '2026-08-05', title: '日概要 2026-08-05' }),
      entry({ id: 'w', kind: 'summary', level: 'week', bucket: '2026-W30', title: '周概要 2026-W30' }),
      entry({ id: 'm', kind: 'summary', level: 'month', bucket: '2025-06', title: '月概要 2025-06' }),
    ])
    const pending = findPendingCompressions(store.list('workspace-a', { includeArchive: true }), DEFAULT_CONFIG, NOW)
    assert.deepEqual(pending, [
      { level: 'week', bucket: '2026-W32' },
      { level: 'month', bucket: '2026-07' },
      { level: 'year', bucket: '2025' },
    ])
  })
})

describe('TimelineCompressor.compressUnit 压缩执行', () => {
  let kv
  let store
  let captured

  beforeEach(() => {
    kv = new MemoryKv()
    store = new MemoryStore(kv)
    captured = []
  })

  function compressor(config = DEFAULT_CONFIG) {
    return new TimelineCompressor(store, config, fakeSummarize(captured))
  }

  test('日压缩：产物字段完整 + 原料归档 + archiveRef 引用', async () => {
    const ids = ['a', 'b']
    for (const id of ids) {
      kv.map.set(memoryKey('workspace-a', 'episodic', id), entry({ id, bucket: '2026-08-05' }))
    }
    // 无关条目：其他日 + fact + knowledge 不应成为原料
    kv.map.set(memoryKey('workspace-a', 'episodic', 'c'), entry({ id: 'c', bucket: '2026-08-14' }))
    kv.map.set(memoryKey('workspace-a', 'fact', 'f'), entry({ id: 'f', kind: 'fact', key: 'k1', bucket: '2026-08-05' }))
    kv.map.set(memoryKey('workspace-a', 'knowledge', 'k'), entry({ id: 'k', kind: 'knowledge', bucket: '2026-08-05' }))

    const result = await compressor().compressUnit('workspace-a', 'day', '2026-08-05')

    assert.equal(result.skipped, false)
    assert.equal(result.reason, 'compressed')
    assert.deepEqual(result.archivedIds, ['a', 'b'])
    assert.ok(result.summary)

    // 总结入参：原料只含 episodic 两条
    assert.equal(captured.length, 1)
    assert.equal(captured[0].level, 'day')
    assert.equal(captured[0].bucket, '2026-08-05')
    assert.equal(captured[0].entries.length, 2)
    assert.equal(captured[0].range.label, '2026-08-05')
    assert.equal(captured[0].weeklyTemplate, '')

    // summary 条目字段
    const summary = store.get('workspace-a', result.summary.id)
    assert.equal(summary.kind, 'summary')
    assert.equal(summary.level, 'day')
    assert.equal(summary.bucket, '2026-08-05')
    assert.deepEqual(summary.archiveRef, ['a', 'b'])
    assert.ok(summary.title.includes('日概要'))
    assert.ok(summary.title.includes('2026-08-05'))
    assert.ok(summary.body.includes('来源 2 条'))
    assert.ok(summary.body.includes('这是day概要正文'))
    assert.equal(summary.archived, false)

    // 原料冷归档：archived=true 且保留（includeArchive 可见），活跃检索不可见
    for (const id of ['a', 'b']) {
      const e = store.get('workspace-a', id)
      assert.equal(e.archived, true)
      assert.match(e.source.reason, /已压缩入概要/)
    }
    // fact/knowledge 不参与压缩，仍在活跃列表（集合比较，顺序无关）
    assert.deepEqual(
      store.list('workspace-a').map((e) => e.id).sort(),
      [result.summary.id, 'c', 'f', 'k'].sort(),
    )
    assert.deepEqual(
      store.list('workspace-a', { includeArchive: true }).map((e) => e.id).sort(),
      [result.summary.id, 'a', 'b', 'c', 'f', 'k'].sort(),
    )
  })

  test('周压缩链：原料为上周 day 概要，产物归档 day 概要', async () => {
    kv.map.set(memoryKey('workspace-a', 'summary', 'd1'), entry({
      id: 'd1', kind: 'summary', level: 'day', bucket: '2026-08-05', title: '日概要 2026-08-05',
    }))
    kv.map.set(memoryKey('workspace-a', 'summary', 'd2'), entry({
      id: 'd2', kind: 'summary', level: 'day', bucket: '2026-08-06', title: '日概要 2026-08-06',
    }))
    kv.map.set(memoryKey('workspace-a', 'summary', 'd3'), entry({
      id: 'd3', kind: 'summary', level: 'day', bucket: '2026-08-14', title: '日概要 2026-08-14', // 本周，不在上周
    }))

    const result = await compressor().compressUnit('workspace-a', 'week', '2026-W32')

    assert.equal(result.reason, 'compressed')
    assert.deepEqual(result.archivedIds, ['d1', 'd2'])
    assert.equal(captured[0].level, 'week')
    assert.equal(captured[0].entries.length, 2)
    const summary = store.get('workspace-a', result.summary.id)
    assert.equal(summary.level, 'week')
    assert.equal(summary.bucket, '2026-W32')
    assert.deepEqual(summary.archiveRef, ['d1', 'd2'])
    assert.equal(store.get('workspace-a', 'd1').archived, true)
    assert.equal(store.get('workspace-a', 'd3').archived, false) // 本周概要不动
  })

  test('无原料 → 跳过 no-sources', async () => {
    kv.map.set(memoryKey('workspace-a', 'episodic', 'c'), entry({ id: 'c', bucket: '2026-08-14' }))
    const result = await compressor().compressUnit('workspace-a', 'week', '2026-W30')
    assert.equal(result.skipped, true)
    assert.equal(result.reason, 'no-sources')
    assert.equal(result.summary, null)
    assert.deepEqual(result.archivedIds, [])
    assert.equal(captured.length, 0)
  })

  test('目标桶已有概要 → 幂等 already-summarized（不重复压缩）', async () => {
    kv.map.set(memoryKey('workspace-a', 'episodic', 'a'), entry({ id: 'a', bucket: '2026-08-05' }))
    kv.map.set(memoryKey('workspace-a', 'summary', 's'), entry({
      id: 's', kind: 'summary', level: 'week', bucket: '2026-W32', title: '周概要 2026-W32',
    }))
    const result = await compressor().compressUnit('workspace-a', 'week', '2026-W32')
    assert.equal(result.skipped, true)
    assert.equal(result.reason, 'already-summarized')
    assert.equal(captured.length, 0)
  })

  test('月压缩链：原料为上月 week 概要，产物归档 week 概要', async () => {
    kv.map.set(memoryKey('workspace-a', 'summary', 'w1'), entry({
      id: 'w1', kind: 'summary', level: 'week', bucket: '2026-W30', title: '周概要 2026-W30',
    }))
    kv.map.set(memoryKey('workspace-a', 'summary', 'w2'), entry({
      id: 'w2', kind: 'summary', level: 'week', bucket: '2026-W31', title: '周概要 2026-W31',
    }))
    kv.map.set(memoryKey('workspace-a', 'summary', 'w3'), entry({
      id: 'w3', kind: 'summary', level: 'week', bucket: '2026-W32', title: '周概要 2026-W32', // 本周，不在上月
    }))

    const result = await compressor().compressUnit('workspace-a', 'month', '2026-07')

    assert.equal(result.reason, 'compressed')
    assert.deepEqual(result.archivedIds, ['w1', 'w2'])
    assert.equal(captured[0].level, 'month')
    assert.equal(captured[0].entries.length, 2)
    const summary = store.get('workspace-a', result.summary.id)
    assert.equal(summary.level, 'month')
    assert.equal(summary.bucket, '2026-07')
    assert.deepEqual(summary.archiveRef, ['w1', 'w2'])
    assert.equal(store.get('workspace-a', 'w1').archived, true)
    assert.equal(store.get('workspace-a', 'w3').archived, false) // 本周概要不动
  })

  test('年压缩链：原料为去年 month 概要', async () => {
    kv.map.set(memoryKey('workspace-a', 'summary', 'm1'), entry({
      id: 'm1', kind: 'summary', level: 'month', bucket: '2025-06', title: '月概要 2025-06',
    }))
    kv.map.set(memoryKey('workspace-a', 'summary', 'm2'), entry({
      id: 'm2', kind: 'summary', level: 'month', bucket: '2026-01', title: '月概要 2026-01', // 今年
    }))

    const result = await compressor().compressUnit('workspace-a', 'year', '2025')

    assert.equal(result.reason, 'compressed')
    assert.deepEqual(result.archivedIds, ['m1'])
    const summary = store.get('workspace-a', result.summary.id)
    assert.equal(summary.level, 'year')
    assert.equal(summary.bucket, '2025')
    assert.deepEqual(summary.archiveRef, ['m1'])
    assert.ok(summary.title.includes('年概要'))
    assert.equal(store.get('workspace-a', 'm2').archived, false)
  })

  test('weeklyTemplate 从配置透传进总结入参', async () => {
    kv.map.set(memoryKey('workspace-a', 'summary', 'd'), entry({ id: 'd', kind: 'summary', level: 'day', bucket: '2026-08-05', title: '日概要 2026-08-05' }))
    const config = { ...DEFAULT_CONFIG, weeklyTemplate: '总结本周进展与数据，如有未完成事项请单列' }
    await compressor(config).compressUnit('workspace-a', 'week', '2026-W32')
    assert.equal(captured[0].weeklyTemplate, '总结本周进展与数据，如有未完成事项请单列')
  })

  test('总结产出为空 → fail loud 抛错且不落库', async () => {
    kv.map.set(memoryKey('workspace-a', 'summary', 'd'), entry({ id: 'd', kind: 'summary', level: 'day', bucket: '2026-08-05', title: '日概要 2026-08-05' }))
    const c = new TimelineCompressor(store, DEFAULT_CONFIG, async () => '   ')
    await assert.rejects(() => c.compressUnit('workspace-a', 'week', '2026-W32'), /总结产出为空/)
    assert.equal(kv.size, 1) // 未新增 summary
    assert.equal(store.get('workspace-a', 'd').archived, false) // 原料未归档
  })
})

describe('TimelineCompressor.compressPending 懒压缩入口', () => {
  test('一次处理全部待压缩单位（日+周+月+年），链式产物齐备', async () => {
    const kv = new MemoryKv()
    const store = new MemoryStore(kv)
    const captured = []
    const seed = [
      entry({ id: 'a', bucket: '2026-08-05' }),
      entry({ id: 'w', kind: 'summary', level: 'week', bucket: '2026-W30', title: '周概要 2026-W30' }),
      entry({ id: 'm', kind: 'summary', level: 'month', bucket: '2025-06', title: '月概要 2025-06' }),
    ]
    for (const e of seed) kv.map.set(memoryKey('workspace-a', e.kind, e.id), e)

    const c = new TimelineCompressor(store, DEFAULT_CONFIG, fakeSummarize(captured))
    const results = await c.compressPending('workspace-a', NOW)

    // 链式：轮1 压 day（episodic → 日概要并归档 a）+ month/year（原料是种子概要，轮1 就绪）；
    // 轮2 才见日概要 → 压 week（周原料依赖日概要产物）。层级集合齐备即链式完整。
    assert.equal(results.length, 4)
    for (const r of results) {
      assert.equal(r.skipped, false)
      assert.equal(r.reason, 'compressed')
    }
    assert.deepEqual(results.map((r) => r.summary.level).sort(), ['day', 'month', 'week', 'year'])

    // 压缩后不再有待压缩单位（幂等闭环）
    const again = await c.compressPending('workspace-a', NOW)
    assert.equal(again.length, 0)

    // 四层概要都在；日概要在周压缩后归档，非归档 = 新生成的周/月/年
    const all = store.list('workspace-a', { includeArchive: true })
    const summaries = all.filter((e) => e.kind === 'summary')
    assert.equal(summaries.length, 6) // 4 新 + 2 种子（w/m 已归档但仍为 summary）
    assert.deepEqual(summaries.filter((e) => e.archived).map((e) => e.level).sort(), ['day', 'month', 'week'])
    assert.deepEqual(summaries.filter((e) => !e.archived).map((e) => e.level).sort(), ['month', 'week', 'year'])
    const archivedIds = all.filter((e) => e.archived).map((e) => e.id)
    assert.equal(archivedIds.length, 4) // a + 日概要 + w + m
    for (const id of ['a', 'w', 'm']) assert.ok(archivedIds.includes(id))
  })
})
