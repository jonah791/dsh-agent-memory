/**
 * v0.20 标签过滤语义：**包含** vs 精确相等（2026-11-04）
 *
 * 动机：打分路径（`scoreEntry`）一直用 `tag.includes(token)`，而过滤路径曾是
 * `entry.tags.includes(tag)`（精确）——同一份 tag 数据两套口径。实测后果（活跃
 * 1418 条）：「技能」df/N=26.5% 触发泛词门 ⇒ 该词 idf 归零 ⇒ 自由文本搜它是 0 条；
 * 唯一入口是 tags 过滤，而它只认 `技能` 不认 `技能维护`/`技能熔炉` 等 39 条变体
 * ⇒ 双重失效，条目搜不到且不报错。
 *
 * 运行：pnpm test（先 build 再 node --test）
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { recallEntries, browseEntries } from '../lib/search.js'

/** 构造一条测试条目（与 search.test.mjs 的 entry() 同形，最小字段集） */
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
    archived: false,
    level: null,
    bucket: null,
    ...overrides,
  }
}

const fixture = () => [
  entry('main', { tags: ['技能'], createdAt: '2026-08-11T00:00:00.000Z' }),
  entry('variant-a', { tags: ['技能维护'], createdAt: '2026-08-12T00:00:00.000Z' }),
  entry('variant-b', { tags: ['技能熔炉'], createdAt: '2026-08-13T00:00:00.000Z' }),
  entry('unrelated', { tags: ['论文迁移'], createdAt: '2026-08-14T00:00:00.000Z' }),
]

describe('v0.20 tag 过滤：包含语义', () => {
  test('给主干词 ⇒ 命中所有含该串的变体', () => {
    const r = recallEntries(fixture(), { tags: ['技能'] })
    assert.deepEqual(r.results.map((x) => x.id).sort(), ['main', 'variant-a', 'variant-b'])
    assert.equal(r.total, 3)
  })

  test('方向性：给变体词 ⇒ **不**命中主干与其它变体（粒度由调用方决定）', () => {
    const r = recallEntries(fixture(), { tags: ['技能维护'] })
    assert.deepEqual(r.results.map((x) => x.id), ['variant-a'])
  })

  test('AND 语义不变：多个词每个都要命中', () => {
    const both = recallEntries(fixture(), { tags: ['技能', '熔炉'] })
    assert.deepEqual(both.results.map((x) => x.id), ['variant-b'])
    const miss = recallEntries(fixture(), { tags: ['技能', '不存在的词'] })
    assert.deepEqual(miss.results, [])
  })

  test('尸体：空串不匹配任何条目（否则 includes("") 恒真，过滤形同虚设）', () => {
    const r = recallEntries(fixture(), { tags: [''] })
    assert.deepEqual(r.results, [])
  })

  test('回归：精确同名仍命中（包含是超集，不是替换）', () => {
    const r = recallEntries(fixture(), { tags: ['论文迁移'] })
    assert.deepEqual(r.results.map((x) => x.id), ['unrelated'])
  })

  test('browseEntries 同口径（两条路径不得各自演化）', () => {
    const r = browseEntries(fixture(), { tags: ['技能'] })
    assert.equal(r.total, 3)
    assert.deepEqual(
      r.groups.flatMap((g) => g.items.map((x) => x.id)).sort(),
      ['main', 'variant-a', 'variant-b'],
    )
  })
})
