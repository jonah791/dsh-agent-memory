/**
 * 检索管道离线单测（T4 验收）：覆盖过滤（kind/tags/since-until/scope/archive）、
 * 相关度排序（标签>标题>正文）、新鲜度排序、limit/total、snippet、层级标注。
 * 运行：pnpm test（先 build 再 node --test）
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { recallEntries, relateClosure, DEFAULT_RECALL_LIMIT } from '../lib/search.js'

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
    // 2026-09-01 CJK bigram 增强后：'插件开发' → 插件开发(整段+2) + 插件(+2标题/+1正文) + 件开(+2) + 开发(+2) = 9
    assert.equal(result.results[0].score, 9)
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

describe('recallEntries · 联想层（related 关联链）', () => {
  test('共享标签 → 关联链生成，按 strength 降序', () => {
    const entries = [
      entry('target', { title: '插件开发要点', tags: ['dsh', 'plugin'] }),
      entry('rel-a', { title: '插件安装', tags: ['dsh'] }),
      entry('rel-b', { title: '插件陷阱', tags: ['dsh', 'plugin'] }),
      entry('unrelated', { title: '完全无关', tags: ['other'] }),
    ]
    const result = recallEntries(entries, { query: '插件' })
    const target = result.results.find((r) => r.id === 'target')
    assert.ok(target, '目标条目应命中')
    assert.ok(target.related, '命中条目应带 related')
    assert.ok(target.related.length >= 2, '共享标签条目应进关联链')
    // 无关条目不进链
    assert.ok(!target.related.some((r) => r.id === 'unrelated'))
    // strength 降序：rel-b(2 共享标签=6) > rel-a(1 共享标签=3)
    assert.ok(target.related[0].strength >= target.related[target.related.length - 1].strength)
    assert.equal(target.related.find((r) => r.id === 'rel-b').sharedTags, 2)
    assert.equal(target.related.find((r) => r.id === 'rel-a').sharedTags, 1)
  })

  test('标题 token 重叠产生弱关联（正文重叠×1）', () => {
    const entries = [
      entry('t1', { title: '上下文管理 纪律', body: '判断三问' }),
      entry('t2', { title: '上下文 剪枝', body: '剪枝纪律 判断三问' }),
    ]
    const result = recallEntries(entries, { query: '上下文' })
    const first = result.results.find((r) => r.id === 't1')
    // t2 与 t1 标题重叠「上下文」→ 关联强度 ≥2
    const rel = first.related?.find((r) => r.id === 't2')
    assert.ok(rel, '标题重叠条目应进关联链')
    assert.ok(rel.strength >= 2)
  })

  test('排除自身；归档条目不进链（除非 includeArchive）', () => {
    const entries = [
      entry('target', { title: '插件开发', tags: ['dsh'] }),
      entry('arch', { title: '旧插件知识', tags: ['dsh'], archived: true }),
    ]
    const normal = recallEntries(entries, { query: '插件' })
    const target = normal.results.find((r) => r.id === 'target')
    assert.ok(!target.related.some((r) => r.id === 'target'), '不应关联自身')
    assert.ok(!target.related.some((r) => r.id === 'arch'), '归档条目默认不进链')
    const withArchive = recallEntries(entries, { query: '插件', includeArchive: true })
    const target2 = withArchive.results.find((r) => r.id === 'target')
    assert.ok(target2.related.some((r) => r.id === 'arch'), 'includeArchive 时归档可进链')
  })

  test('无关联条目 → related 为空数组', () => {
    const entries = [entry('solo', { title: '独狼条目', tags: ['unique'] })]
    const result = recallEntries(entries, { query: '独狼' })
    assert.deepEqual(result.results[0].related, [])
  })
})

describe('relateClosure · 多跳联想闭包（BFS 记忆图）', () => {
  test('depth=1 单跳：等价 relatedOf，hop=1', () => {
    const entries = [
      entry('a', { title: '插件开发', tags: ['dsh'] }),
      entry('b', { title: '插件安装', tags: ['dsh'] }),
      entry('c', { title: '完全无关', tags: ['other'] }),
    ]
    const result = relateClosure(entries, entries[0], 1)
    assert.deepEqual(result.map((r) => r.id), ['b'])
    assert.equal(result[0].hop, 1)
  })

  test('depth=2 多跳：沿关系扩展，hop 标注层级', () => {
    // a(dsh) → b(dsh+ops) → c(ops)：b 是 a 的 1 跳邻居，c 通过 b 是 2 跳
    const entries = [
      entry('a', { title: '插件开发', tags: ['dsh'] }),
      entry('b', { title: '插件部署', tags: ['dsh', 'ops'] }),
      entry('c', { title: '运维手册', tags: ['ops'] }),
      entry('d', { title: '完全无关', tags: ['other'] }),
    ]
    const result = relateClosure(entries, entries[0], 2)
    const b = result.find((r) => r.id === 'b')
    const c = result.find((r) => r.id === 'c')
    assert.ok(b, 'b 应进闭包')
    assert.equal(b.hop, 1)
    assert.ok(c, 'c 应经 b 扩展进闭包')
    assert.equal(c.hop, 2)
    assert.ok(!result.some((r) => r.id === 'd'), '无关条目不进闭包')
  })

  test('防环：visited 去重，不重复收录', () => {
    // a↔b 强双向关联，depth=3 也不重复
    const entries = [
      entry('a', { title: '主题 A', tags: ['t'] }),
      entry('b', { title: '主题 A 变体', tags: ['t'] }),
    ]
    const result = relateClosure(entries, entries[0], 3)
    const ids = result.map((r) => r.id)
    assert.equal(new Set(ids).size, ids.length, '不应有重复 id')
  })

  test('排序：hop 升序，同 hop 内 strength 降序', () => {
    const entries = [
      entry('a', { title: '插件开发', tags: ['dsh', 'plugin'] }),
      entry('b1', { title: '插件安装', tags: ['dsh'] }),
      entry('b2', { title: '插件开发 指南', tags: ['dsh', 'plugin'] }),
      entry('c', { title: '部署运维', tags: ['dsh', 'ops'] }),
    ]
    const result = relateClosure(entries, entries[0], 2, 3)
    for (let i = 1; i < result.length; i++) {
      assert.ok(result[i].hop >= result[i - 1].hop, 'hop 应非降序')
      if (result[i].hop === result[i - 1].hop) {
        assert.ok(result[i].strength <= result[i - 1].strength, '同 hop 内 strength 应降序')
      }
    }
  })
})
