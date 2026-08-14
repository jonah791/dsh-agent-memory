/**
 * v0.2 测试：browseEntries 分组 + 停用词过滤（node:test，离线）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { browseEntries, bucketLabel } from '../lib/search.js'
import type { Entry } from '../lib/types.js'

function entry(partial: Partial<Entry> & { id: string; title: string; createdAt: string }): Entry {
  return {
    kind: 'knowledge',
    tags: [],
    body: '',
    scope: 'c:/proj',
    updatedAt: partial.createdAt,
    accessedAt: partial.createdAt,
    level: null,
    bucket: null,
    archived: false,
    ...partial,
  }
}

test('browseEntries：按日桶分组，组间时间降序', () => {
  const entries = [
    entry({ id: 'a', title: '三月事', createdAt: '2026-03-10T00:00:00.000Z' }),
    entry({ id: 'b', title: '一月事', createdAt: '2026-01-10T00:00:00.000Z' }),
    entry({ id: 'c', title: '三月二事', createdAt: '2026-03-10T12:00:00.000Z' }),
  ]
  const { groups, total } = browseEntries(entries)
  assert.equal(total, 2) // total = 组数（分页单位是组）
  assert.deepEqual(groups.map((g) => g.bucket), ['2026-03-10', '2026-01-10'])
  assert.equal(groups[0]!.items.length, 2)
  assert.equal(groups[1]!.items.length, 1)
})

test('browseEntries：概要条目按自身 bucket 分组并标注层级', () => {
  const entries = [
    entry({
      id: 'w', title: '周概要', createdAt: '2026-08-14T00:00:00.000Z',
      kind: 'summary', level: 'week', bucket: '2026-W33',
    }),
    entry({ id: 'd', title: '日明细', createdAt: '2026-08-12T00:00:00.000Z', kind: 'episodic', level: 'day', bucket: '2026-08-12' }),
  ]
  const { groups } = browseEntries(entries)
  assert.deepEqual(groups.map((g) => g.bucket), ['2026-W33', '2026-08-12'])
  assert.equal(groups[0]!.level, 'week')
  assert.equal(groups[1]!.level, null) // 明细组不标注层级
})

test('browseEntries：level 过滤只看概要层', () => {
  const entries = [
    entry({ id: 'w', title: '周概要', createdAt: '2026-08-14T00:00:00.000Z', kind: 'summary', level: 'week', bucket: '2026-W33' }),
    entry({ id: 'd', title: '日明细', createdAt: '2026-08-12T00:00:00.000Z', kind: 'episodic', level: 'day', bucket: '2026-08-12' }),
  ]
  const { groups, total } = browseEntries(entries, { level: 'week' })
  assert.equal(total, 1)
  assert.equal(groups[0]!.bucket, '2026-W33')
})

test('browseEntries：分页按组数', () => {
  const entries = [
    entry({ id: 'a', title: 'a', createdAt: '2026-03-10T00:00:00.000Z' }),
    entry({ id: 'b', title: 'b', createdAt: '2026-02-10T00:00:00.000Z' }),
    entry({ id: 'c', title: 'c', createdAt: '2026-01-10T00:00:00.000Z' }),
  ]
  const page1 = browseEntries(entries, { page: 1, pageSize: 2 })
  const page2 = browseEntries(entries, { page: 2, pageSize: 2 })
  assert.equal(page1.groups.length, 2)
  assert.equal(page2.groups.length, 1)
  assert.equal(page2.groups[0]!.bucket, '2026-01-10')
})

test('browseEntries：since/until/kind/tags 过滤', () => {
  const entries = [
    entry({ id: 'a', title: '三月', createdAt: '2026-03-10T00:00:00.000Z', kind: 'fact', tags: ['x'] }),
    entry({ id: 'b', title: '五月', createdAt: '2026-05-10T00:00:00.000Z', kind: 'knowledge', tags: ['y'] }),
  ]
  const bySince = browseEntries(entries, { since: '2026-04-01' })
  assert.equal(bySince.total, 1)
  const byKind = browseEntries(entries, { kind: ['fact'] })
  assert.equal(byKind.total, 1)
  const byTags = browseEntries(entries, { tags: ['y'] })
  assert.equal(byTags.total, 1)
})

test('bucketLabel：年/月/周/日标签', () => {
  assert.equal(bucketLabel('2026'), '2026 年')
  assert.equal(bucketLabel('2026-08'), '2026 年 8 月')
  assert.equal(bucketLabel('2026-W33'), '2026 第 33 周')
  assert.equal(bucketLabel('2026-08-12'), '2026-08-12')
})