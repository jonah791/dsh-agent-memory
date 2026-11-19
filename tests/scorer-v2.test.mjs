/**
 * 打分器 v2（v0.34 · 三层计价）——A152 契约。
 * 运行：npm test（tsc 后 node --test "tests/*.test.mjs"，导入编译产物 lib/*.js）
 *
 * 覆盖：
 *   V1 缺省关：不传 `scorer` 与显式传 `'v1'` **逐位相同**（零行为变化）
 *   V2 主题词保护：同一个高频主题词，v1 把它归零、v2 仍给它正贡献
 *   V3 噪声判据：跨词边界的字符对被判为噪声；实词字符对不是
 *   V4 三层可分离：`coverageWeight` 只加不减（L2 是可关的覆盖层，不是惩罚项）
 *
 * ⚠ 本文件不测「v2 让真实检索变好」：小语料里 IDF 与规模都不成立。真实库读数见
 * `docs/design/aml-eval.md`「打分器 v2 首次实现与 L2 系数扫描」，机制判据见 `semantic.md §5.27`。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isNoiseBigram, recallEntries } from '../lib/search.js'

let seq = 0
function entry(over = {}) {
  seq += 1
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    kind: 'knowledge',
    title: `条目 ${seq}`,
    body: '',
    tags: [],
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...over,
  }
}

test('V1 缺省关：不传 scorer 与显式 v1 逐位相同', () => {
  const entries = [
    entry({ title: '上下文压缩的原理', body: '压缩之后怎么恢复上下文' }),
    entry({ title: '无关条目', body: '完全无关的内容' }),
  ]
  const plain = recallEntries(entries, { query: '上下文 压缩', limit: 5, withRelated: false })
  const v1 = recallEntries(entries, { query: '上下文 压缩', limit: 5, withRelated: false, tuning: { scorer: 'v1' } })
  assert.deepEqual(v1, plain)
})

test('V2 主题词保护：v1 归零的高频主题词，v2 仍给出候选', () => {
  // 61 条含「压缩」的条目 ⇒ df=61/61 ⇒ v1 的泛词门（df≥50 且 df/N>10%）把它**整词归零**。
  // 高分辨力的断言不是「分数更高」而是「v1 无候选、v2 有候选」——因为归零在 v1 里是**断崖**。
  const entries = []
  for (let i = 0; i < 60; i += 1) entries.push(entry({ title: `压缩 笔记 ${i}`, body: '填充内容' }))
  const target = entry({ title: '上下文压缩的原理', body: '压缩之后怎么恢复上下文' })
  entries.push(target)
  const q = '压缩'
  const v1 = recallEntries(entries, { query: q, limit: 10, withRelated: false })
  const v2 = recallEntries(entries, { query: q, limit: 10, withRelated: false, tuning: { scorer: 'v2' } })
  assert.equal(v1.total, 0, '前提：v1 下「压缩」被泛词门整词归零 ⇒ 零候选（这是要治的断崖）')
  assert.ok(v2.total > 0, 'v2 的主题词保护应让高频主题词仍有候选')
  const targetRow = v2.results.find((r) => r.id === target.id)
  assert.ok(targetRow !== undefined, '目标条目应在 v2 的候选里')
  assert.ok(targetRow.score > 0, 'v2 下目标条目的分数应为正')
})

test('V3 噪声判据：跨词边界字符对是噪声，实词字符对不是', () => {
  // 噪声：来自「怎么恢复」两个词的交界 / 停用字参与 / 疑问字参与
  for (const bad of ['么恢', '后怎', '的时', '怎么', '什么']) {
    assert.equal(isNoiseBigram(bad), true, `「${bad}」应判为噪声`)
  }
  // 实词：正常名词的字符对不能被误杀
  for (const good of ['压缩', '上下', '恢复', '检索', '实体']) {
    assert.equal(isNoiseBigram(good), false, `「${good}」不应判为噪声`)
  }
})

test('V4 三层可分离：coverageWeight 只加不减', () => {
  const target = entry({ title: '上下文压缩的原理', body: '压缩之后怎么恢复上下文' })
  const entries = [target]
  const q = '压缩之后怎么恢复上下文'
  const off = recallEntries(entries, { query: q, limit: 5, withRelated: false, tuning: { scorer: 'v2', coverageWeight: 0 } })
  const on = recallEntries(entries, { query: q, limit: 5, withRelated: false, tuning: { scorer: 'v2', coverageWeight: 1 } })
  const offRow = off.results.find((r) => r.id === target.id)
  const onRow = on.results.find((r) => r.id === target.id)
  assert.ok(offRow !== undefined && onRow !== undefined, '前提：目标条目在两种覆盖系数下都要命中')
  assert.ok(onRow.score >= offRow.score, `L2 是覆盖层，加大系数不应降分（off=${offRow.score} · on=${onRow.score}）`)
  assert.ok(onRow.score > offRow.score, 'L2 在关掉时应有可观测差异，否则这一层是装饰品')
})
