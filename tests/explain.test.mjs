/**
 * 打分分解（v0.32 · 诊断视图）——A150 契约。
 * 运行：npm test（tsc 后 node --test "tests/*.test.mjs"，导入编译产物 lib/*.js）
 *
 * 覆盖：
 *   X1 求和可核：各项 contribution 之和 == score（普通路径逐位相等；加权路径 < 1e-3，因既有 round）
 *   X2 与生产同源：同一条目在 explainRecall 与 recallEntries 里 **score 相同**
 *   X3 名次一致：explainRecall 的前 k 个 id 与 recallEntries 的 results 前 k 个 id 逐个相同
 *   X4 抑制可见：被泛词门置零的词项仍出现在分解里（idf=0 / contribution=0），不被静默吞掉
 *   X5 字段分级：同一个词在标题与正文各命中时分成两条（2w / 1w×lenNorm），不合并成一条
 *   X6 实体项：传 entityMatches 时出现 field='entity'，贡献 = SCORE_ENTITY × weight
 *
 * ⚠ 本文件不测「噪声抑制让真实检索变好了」：小语料里 IDF 与规模都不成立，那种断言只会
 * 得出假读数。真实库读数见 `docs/design/aml-eval.md`，机制判据见 `docs/semantic.md §5.25`。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { explainRecall, recallEntries } from '../lib/search.js'

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

/** 分解项贡献之和（A150 的求和侧） */
const sumOf = (terms) => terms.reduce((acc, t) => acc + t.contribution, 0)

test('X1 求和可核：普通路径各项之和与 score 逐位相等', () => {
  const entries = [
    entry({ title: '检索 噪声', body: '检索的噪声抑制与检索分级' }),
    entry({ title: '无关条目', body: '检索' }),
  ]
  const out = explainRecall(entries, { query: '检索 噪声' })
  assert.ok(out.length > 0, '前提：查询至少命中一条')
  for (const item of out) {
    assert.equal(sumOf(item.terms), item.score, `「${item.title}」的分解之和应等于 score`)
  }
})

test('X1b 加权路径：分解之和与 score 的差 < 1e-3（既有 round 的舍入）', () => {
  const target = entry({ title: '检索 噪声', body: '检索的噪声' })
  const out = explainRecall([target], {
    weightedTerms: [{ term: '检索', weight: 1 }, { term: '噪声', weight: 0.5 }],
  })
  const item = out.find((x) => x.id === target.id)
  assert.ok(item !== undefined, '前提：目标条目必须命中')
  assert.ok(Math.abs(sumOf(item.terms) - item.score) < 1e-3, '加权路径允许 < 1e-3 的舍入差')
})

test('X2/X3 与生产同源：同一条目 score 相同、top-k 名次逐个相同', () => {
  const entries = [
    entry({ title: '检索 噪声 抑制', body: '检索链路的噪声' }),
    entry({ title: '噪声的来源', body: '正文里也提到检索' }),
    entry({ title: '检索 分级', body: '标题命中与正文命中的差别' }),
    entry({ title: '无关条目甲', body: '完全无关' }),
    entry({ title: '无关条目乙', body: '也无关' }),
  ]
  const q = '检索 噪声'
  const verdict = recallEntries(entries, { query: q, limit: 5, withRelated: false })
  const explain = explainRecall(entries, { query: q })
  const byId = new Map(explain.map((item, index) => [item.id, { item, index }]))
  assert.ok(verdict.results.length >= 3, '前提：至少 3 条过相对分门槛（否则名次断言无分辨力）')
  for (const [rank, result] of verdict.results.entries()) {
    const hit = byId.get(result.id)
    assert.ok(hit !== undefined, `recall 的结果 ${result.id} 必须出现在分解里`)
    assert.equal(hit.item.score, result.score, '同一条目的分数必须相同（否则是两把尺子）')
    assert.equal(hit.index, rank, `第 ${rank + 1} 名的位置必须相同`)
  }
})

test('X4 抑制可见：泛词门的词项仍出现在分解里（idf=0，贡献 0）', () => {
  // 60 条含「泛词」+ 1 条含「特征词」⇒ N=61 · df(泛词)=61 ≥ 50 且 61/61 > 0.1 ⇒ 置零
  const entries = []
  for (let i = 0; i < 60; i += 1) entries.push(entry({ title: `泛词条目 ${i}`, body: '填充' }))
  const target = entry({ title: '特征词条目', body: '泛词 也在正文' })
  entries.push(target)
  const out = explainRecall(entries, { query: '泛词 特征词' })
  const item = out.find((x) => x.id === target.id)
  assert.ok(item !== undefined, '前提：目标条目必须命中')
  const suppressed = item.terms.find((t) => t.term === '泛词' && t.idf === 0)
  assert.ok(suppressed !== undefined, '被抑制的词项必须出现在分解里（不能被静默吞掉）')
  assert.equal(suppressed.contribution, 0, '被抑制的词项贡献必须为 0')
})

test('X5 字段分级：同一词在标题与正文各命中时分成两条', () => {
  const target = entry({ title: '噪声 抑制', body: '正文里也讲噪声' })
  const out = explainRecall([target], { query: '噪声' })
  const item = out.find((x) => x.id === target.id)
  assert.ok(item !== undefined, '前提：目标条目必须命中')
  const parts = item.terms.filter((t) => t.term === '噪声')
  assert.deepEqual(parts.map((t) => t.field), ['title', 'body'], '标题与正文必须各占一条，不合并')
  const titlePart = parts.find((t) => t.field === 'title')
  const bodyPart = parts.find((t) => t.field === 'body')
  assert.equal(titlePart.contribution, titlePart.idf * 2, '标题项 = 2 × IDF')
  // b=0 ⇒ 长度归一恒为 1（见 search.ts 的 BM25_B 注释）
  assert.equal(bodyPart.contribution, bodyPart.idf * 1, '正文项 = 1 × IDF × lenNorm(=1)')
})

test('X6 实体项：field=entity，贡献 = SCORE_ENTITY(2.5) × weight', () => {
  const target = entry({ title: 'AML 进度记录', body: '智能体记忆图书馆的进度' })
  const out = explainRecall([target], {
    query: 'AML 的进度',
    entityMatches: [{ names: ['aml'], weight: 2 }],
  })
  const item = out.find((x) => x.id === target.id)
  assert.ok(item !== undefined, '前提：目标条目必须命中')
  const entityParts = item.terms.filter((t) => t.field === 'entity')
  assert.equal(entityParts.length, 1, '一个命中实体只产生一条分解项')
  assert.equal(entityParts[0].contribution, 2.5 * 2)
  assert.equal(entityParts[0].weight, 2, '重心权重原样记入（诊断要能区分「罕见」与「重心」）')
  assert.equal(sumOf(item.terms), item.score, '含实体项时求和要求同样成立')
})
