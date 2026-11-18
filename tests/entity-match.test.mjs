/**
 * 实体匹配进检索（v0.31.0 · 方案 §8.3「实体匹配」）——search 层契约。
 * 运行：npm test（tsc 后 node --test "tests/*.test.mjs"，导入编译产物 lib/*.js）
 *
 * 覆盖：
 *   M1 缺省关：不传 `entityMatches` ⇒ 与「没有这个维度」逐字相同（排序、分数、total 全等）
 *   M2 机制生效：提到实体的条目拿到 `SCORE_ENTITY × weight` 的加成，并在构造样本里升到第一
 *   M3 词边界：别名 `AML` 不命中 `yaml` 条目（复用 `entities.matchesName` 的唯一口径）
 *
 * ⚠ **本文件不测「实体匹配让真实检索变好了」**：单测的小语料里 IDF 与规模都不成立，
 * 那种断言只会得出假读数。真实库的加成量级读数见 `docs/design/aml-eval.md` 的实体匹配一节
 * （2026-11-19 05:51：2.5 分加成对 44.5 分的 top1 = 5.6%，**三个查询的 top5 一名未变**）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recallEntries } from '../lib/search.js'
import { matchesName, normalizeEntityName } from '../lib/entities.js'

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

/** 实体信号（已归一的称呼 + 强度） */
function match(...names) {
  return { names: names.map(normalizeEntityName), weight: 1 }
}

test('M1 缺省关：不传 entityMatches 与未加该维度逐字相同', () => {
  const entries = [
    entry({ title: 'AML 基线读数', body: '智能体记忆图书馆的基线' }),
    entry({ title: '期货工程接手', body: '进度管理是重中之重' }),
  ]
  const plain = recallEntries(entries, { query: 'AML 的进度', limit: 5 })
  const explicitUndefined = recallEntries(entries, { query: 'AML 的进度', limit: 5, entityMatches: undefined })
  const empty = recallEntries(entries, { query: 'AML 的进度', limit: 5, entityMatches: [] })
  assert.deepEqual(explicitUndefined, plain)
  assert.deepEqual(empty, plain)
})

test('M2 机制生效：提到实体的条目 +SCORE_ENTITY×weight，并升到第一', () => {
  // 构造：一条「写另一种写法」的条目（不含查询词 AML），一条逐字命中查询词的无关条目
  const related = entry({ title: '智能体记忆图书馆的实施方案', body: '方案要点与进度记录' })
  const decoy = entry({ title: '进度表', body: '进度 进度' })
  const q = 'AML 的进度'
  const before = recallEntries([related, decoy], { query: q, limit: 5 })
  assert.equal(before.results[0].id, decoy.id, '前提：不开实体匹配时无关条目排第一（否则本测试无分辨力）')

  const signal = [match('AML', '智能体记忆图书馆', 'Agent Memory Library')]
  const after = recallEntries([related, decoy], { query: q, limit: 5, entityMatches: signal })
  const relatedBefore = before.results.find((r) => r.id === related.id)
  const relatedAfter = after.results.find((r) => r.id === related.id)
  assert.ok(relatedBefore !== undefined && relatedAfter !== undefined, '两条都必须在结果里')
  assert.equal(
    Math.round((relatedAfter.score - relatedBefore.score) * 1000) / 1000,
    2.5,
    '加成必须恰为 SCORE_ENTITY(2.5) × weight(1)',
  )
  assert.equal(after.results[0].id, related.id, '加成之后「同一实体的另一种写法」必须排到第一')
  // 无关条目分数不变（加成只给命中实体的条目）
  const decoyBefore = before.results.find((r) => r.id === decoy.id)
  const decoyAfter = after.results.find((r) => r.id === decoy.id)
  assert.equal(decoyAfter.score, decoyBefore.score)
})

test('M3 词边界：别名 AML 不命中 yaml 条目（与实体档同一口径）', () => {  assert.equal(matchesName('yaml 配置要点', 'aml'), false, 'yaml 里的 aml 不得命中')
  assert.equal(matchesName('example 里的内容', 'aml'), false, 'aml 作为更长单词的一部分不得命中')
  assert.equal(matchesName('aml 方案', 'aml'), true)
  assert.equal(matchesName('（aml）', 'aml'), true, '全角括号是非字母数字 ⇒ 视为边界')
  // CJK 走子串
  assert.equal(matchesName('我在整理智能体记忆图书馆的差距表', '智能体记忆图书馆'), true)

  const yamlEntry = entry({ title: 'yaml 配置要点', body: '' })
  const plain = recallEntries([yamlEntry], { query: 'yaml', limit: 5 })
  const boosted = recallEntries([yamlEntry], { query: 'yaml', limit: 5, entityMatches: [match('AML')] })
  assert.equal(boosted.results[0].score, plain.results[0].score, 'yaml 条目不得因 AML 加分')
})
