/**
 * 检索管道离线单测（T4 验收）：覆盖过滤（kind/tags/since-until/scope/archive）、
 * 相关度排序（标签>标题>正文）、新鲜度排序、limit/total、snippet、层级标注。
 * 运行：pnpm test（先 build 再 node --test）
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { recallEntries, DEFAULT_RECALL_LIMIT } from '../lib/search.js'

/** 构造一条测试条目（id 即 identity，时间可控） */
function entry(id, overrides = {}) {
  return {
    id,
    kind: 'knowledge',
    title: `标题 ${id}`,
    body: `正文 ${id}`,
    tags: [],
    scope: 'workspace-a',
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
    accessedAt: '2026-08-10T00:00:00.000Z',
    level: null,
    bucket: null,
    archived: false,
    ...overrides,
  }
}

describe('recallEntries · 基础', () => {
  test('空条目数组 → 空结果', () => {
    const result = recallEntries([], {})
    assert.deepEqual(result.results, [])
    assert.equal(result.total, 0)
  })

  test('无查询词：全量返回，按 accessedAt 新→旧排序', () => {
    const entries = [
      entry('old', { accessedAt: '2026-08-01T00:00:00.000Z' }),
      entry('mid', { accessedAt: '2026-08-10T00:00:00.000Z' }),
      entry('new', { accessedAt: '2026-08-20T00:00:00.000Z' }),
    ]
    const result = recallEntries(entries, {})
    assert.equal(result.total, 3)
    assert.deepEqual(result.results.map((r) => r.id), ['new', 'mid', 'old'])
    // 无查询词时分数全 0
    assert.ok(result.results.every((r) => r.score === 0))
  })

  test('默认 limit = 20；显式 limit 截断且 total 为截断前命中数', () => {
    const entries = Array.from({ length: 25 }, (_, i) => entry(`e${i}`))
    const defaultResult = recallEntries(entries, {})
    assert.equal(defaultResult.results.length, DEFAULT_RECALL_LIMIT)
    assert.equal(defaultResult.total, 25)

    const limited = recallEntries(entries, { limit: 5 })
    assert.equal(limited.results.length, 5)
    assert.equal(limited.total, 25)

    const zero = recallEntries(entries, { limit: 0 })
    assert.deepEqual(zero.results, [])
    assert.equal(zero.total, 25)
  })
})

describe('recallEntries · 相关度排序（标签>标题>正文）', () => {
  test('同词分别命中 标签/标题/正文 → 分数 3/2/1，顺序 标签>标题>正文', () => {
    const entries = [
      entry('body-hit', {
        title: '无关标题',
        body: '这里提到了 alpha 关键词',
        accessedAt: '2026-08-01T00:00:00.000Z',
      }),
      entry('tag-hit', {
        title: '无关标题',
        body: '无关正文',
        tags: ['alpha'],
        accessedAt: '2026-08-01T00:00:00.000Z',
      }),
      entry('title-hit', {
        title: 'alpha 相关标题',
        body: '无关正文',
        accessedAt: '2026-08-01T00:00:00.000Z',
      }),
    ]
    const result = recallEntries(entries, { query: 'alpha' })
    assert.deepEqual(result.results.map((r) => r.id), ['tag-hit', 'title-hit', 'body-hit'])
    assert.deepEqual(result.results.map((r) => r.score), [3, 2, 1])
  })

  test('多词累加：一词命中标签+标题 → 5 分，高于单点命中', () => {
    const entries = [
      entry('multi', {
        title: 'dsh 插件开发',
        body: '讲 dsh 插件',
        tags: ['dsh'],
        accessedAt: '2026-08-01T00:00:00.000Z',
      }),
      entry('single', {
        title: '其他',
        body: '其他内容',
        tags: ['dsh'],
        accessedAt: '2026-08-02T00:00:00.000Z',
      }),
    ]
    const result = recallEntries(entries, { query: 'dsh' })
    assert.deepEqual(result.results.map((r) => r.id), ['multi', 'single'])
    assert.equal(result.results[0].score, 6) // 标签3 + 标题2 + 正文1
    assert.equal(result.results[1].score, 3)
  })

  test('同分按 accessedAt 新→旧（新鲜度打破平局）', () => {
    const entries = [
      entry('old', {
        title: '共同词标题',
        accessedAt: '2026-08-01T00:00:00.000Z',
      }),
      entry('new', {
        title: '共同词标题',
        accessedAt: '2026-08-15T00:00:00.000Z',
      }),
    ]
    const result = recallEntries(entries, { query: '共同词' })
    assert.deepEqual(result.results.map((r) => r.id), ['new', 'old'])
    assert.equal(result.results[0].score, result.results[1].score)
  })

  test('中文无空格查询：整段子串匹配标题/正文', () => {
    const entries = [
      entry('zh', { title: 'DeepSeek Harness 插件开发要点', body: '一切皆插件' }),
      entry('other', { title: '无关内容', body: '什么都没有' }),
    ]
    const result = recallEntries(entries, { query: '插件开发' })
    assert.deepEqual(result.results.map((r) => r.id), ['zh'])
    assert.equal(result.results[0].score, 2)
  })
})

describe('recallEntries · 过滤', () => {
  const entries = [
    entry('fact-1', {
      kind: 'fact',
      title: '偏好',
      createdAt: '2026-08-01T10:00:00.000Z',
      tags: ['preference'],
    }),
    entry('knowledge-1', {
      kind: 'knowledge',
      title: 'DSH 知识',
      createdAt: '2026-08-15T10:00:00.000Z',
      tags: ['dsh', 'plugin'],
    }),
    entry('episodic-1', {
      kind: 'episodic',
      title: '发布事件',
      createdAt: '2026-08-20T10:00:00.000Z',
      tags: ['release'],
      level: 'day',
      bucket: '2026-08-20',
    }),
    entry('archived-1', {
      kind: 'knowledge',
      title: '过时知识',
      archived: true,
      createdAt: '2026-08-05T10:00:00.000Z',
    }),
    entry('other-scope', {
      kind: 'fact',
      title: '他库偏好',
      scope: 'workspace-b',
      createdAt: '2026-08-25T10:00:00.000Z',
    }),
  ]

  test('kind 过滤：任一命中', () => {
    const result = recallEntries(entries, { kind: ['fact', 'episodic'] })
    // other-scope 也是 fact（kind 过滤不涉 scope），应一并命中
    assert.deepEqual(
      result.results.map((r) => r.id).sort(),
      ['episodic-1', 'fact-1', 'other-scope'],
    )
    assert.equal(result.total, 3)
  })

  test('tags 过滤：需全部命中（AND）', () => {
    const result = recallEntries(entries, { tags: ['dsh'] })
    assert.deepEqual(result.results.map((r) => r.id), ['knowledge-1'])
    const both = recallEntries(entries, { tags: ['dsh', 'plugin'] })
    assert.deepEqual(both.results.map((r) => r.id), ['knowledge-1'])
    const missing = recallEntries(entries, { tags: ['dsh', 'release'] })
    assert.deepEqual(missing.results, [])
  })

  test('since/until：createdAt 区间，纯日期按日界归一化', () => {
    // since=08-10 → 08-10 当天 00:00 起（other-scope 08-25 也应命中）
    const since = recallEntries(entries, { since: '2026-08-10' })
    assert.deepEqual(
      since.results.map((r) => r.id).sort(),
      ['episodic-1', 'knowledge-1', 'other-scope'],
    )
    // until=08-10 → 08-10 当天 23:59:59.999 止（08-01 的 fact 命中）
    const until = recallEntries(entries, { until: '2026-08-10' })
    assert.deepEqual(until.results.map((r) => r.id).sort(), ['fact-1'])
    // 闭区间：since=08-15 且 until=08-15 → 当天条目命中
    const both = recallEntries(entries, { since: '2026-08-15', until: '2026-08-15' })
    assert.deepEqual(both.results.map((r) => r.id), ['knowledge-1'])
    // 完整 ISO 时间戳直接比较
    const iso = recallEntries(entries, {
      since: '2026-08-19T00:00:00.000Z',
      until: '2026-08-21T00:00:00.000Z',
    })
    assert.deepEqual(iso.results.map((r) => r.id), ['episodic-1'])
  })

  test('scope 过滤：精确匹配', () => {
    const result = recallEntries(entries, { scope: 'workspace-b' })
    assert.deepEqual(result.results.map((r) => r.id), ['other-scope'])
    // 未指定 scope 时不过滤（默认剔除归档 → 5 条中 4 条活跃）
    assert.equal(recallEntries(entries, {}).total, 4)
  })

  test('归档：默认剔除，includeArchive=true 包含且透出 archived 标记', () => {
    const defaultResult = recallEntries(entries, {})
    assert.ok(!defaultResult.results.some((r) => r.id === 'archived-1'))

    const withArchive = recallEntries(entries, { includeArchive: true })
    const archived = withArchive.results.find((r) => r.id === 'archived-1')
    assert.ok(archived, 'includeArchive 应包含归档条目')
    assert.equal(archived.archived, true)
    // 普通条目 archived 标记为 false
    assert.equal(withArchive.results.find((r) => r.id === 'fact-1').archived, false)
  })

  test('组合过滤：kind + tags + since + limit 联动', () => {
    const result = recallEntries(entries, {
      kind: ['knowledge', 'fact'],
      tags: ['preference'],
      since: '2026-08-01',
      limit: 1,
    })
    assert.deepEqual(result.results.map((r) => r.id), ['fact-1'])
    assert.equal(result.total, 1)
  })
})

describe('recallEntries · 结果形态', () => {
  test('结果项字段完整：id/kind/title/snippet/tags/scope/level/score/archived/updatedAt', () => {
    const e = entry('e1', {
      kind: 'episodic',
      level: 'month',
      tags: ['t1'],
      body: '第一行\n第二行',
      updatedAt: '2026-08-01T00:00:00.000Z',
    })
    const result = recallEntries([e], { query: '标题 e1' })
    const item = result.results[0]
    assert.equal(item.id, 'e1')
    assert.equal(item.kind, 'episodic')
    assert.equal(item.title, '标题 e1')
    assert.equal(item.snippet, '第一行')
    assert.deepEqual(item.tags, ['t1'])
    assert.equal(item.scope, 'workspace-a')
    assert.equal(item.level, 'month', '层级标注透出')
    assert.equal(typeof item.score, 'number')
    assert.equal(item.archived, false)
    assert.equal(item.updatedAt, '2026-08-01T00:00:00.000Z')
  })

  test('snippet：长正文截断 + 省略号；空正文返回空串', () => {
    const long = '字'.repeat(200)
    const result = recallEntries([entry('long', { body: long })], {})
    assert.equal(result.results[0].snippet.length, 141) // 140 + 省略号
    assert.ok(result.results[0].snippet.endsWith('…'))

    const empty = recallEntries([entry('empty', { body: '   ' })], {})
    assert.equal(empty.results[0].snippet, '')
  })

  test('结果 tags 是拷贝：改动结果不影响原条目', () => {
    const e = entry('e1', { tags: ['a', 'b'] })
    const result = recallEntries([e], {})
    result.results[0].tags.push('c')
    assert.deepEqual(e.tags, ['a', 'b'])
  })
})
