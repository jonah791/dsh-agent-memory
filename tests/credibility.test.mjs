/**
 * §5.4 四维可信度读数 · 判据（D 段）——设计正本 `docs/semantic.md` §5.34
 *
 * 这一层守三件事：
 * 1. **四档之和恒等于分母**（可断言的自洽）——统计漏算哪一档，读数就会说谎。
 * 2. **「有值」≠「能下结论」**：`grounding='proposed'` 有值但表示未核验；`measured` 是自验
 *    不是独立核实。这两格是本模块存在的理由，所以各有独立判据，且**用尸体验证过**
 *    （把它们改回 `settled`，D6 / D8 必须红）。
 * 3. **代理维必须带 caveat**：`fidelity='proxy'` 的维度如果没写清边界，读到的人会把
 *    「可核性」当成「准确率」——那比不报更坏。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CRED_DIMENSIONS,
  CRED_VERDICT_LABELS,
  credibilityOf,
  credibilityReport,
} from '../lib/credibility.js'

const NOW = new Date('2026-11-19T12:00:00.000Z')
const DAY = 86_400_000

function fields(partial = {}) {
  return { scope: 'e:/alice', ...partial }
}

/** 来源查找器（scope + id）。生效来源按 scope 隔离：两个 workspace 各有 SOURCE-0001 时不许串 */
function lookupOf(list) {
  const table = new Map(list.map((item) => [`${item.scope ?? 'e:/alice'}:${item.id}`, item]))
  return (scope, id) => table.get(`${scope}:${id}`)
}

// ── D1 四维不多不少 ──────────────────────────────────────────────────────────

test('D1 四维恰为方案 §5.4 的四条，且返回值键与 CRED_DIMENSIONS 一致', () => {
  assert.deepEqual(
    [...CRED_DIMENSIONS],
    ['sourceReliability', 'extractionConfidence', 'verificationStatus', 'freshness'],
  )
  const reading = credibilityOf(fields(), { now: NOW })
  assert.deepEqual(Object.keys(reading).sort(), [...CRED_DIMENSIONS].sort())
})

// ── D2 来源可靠性 ────────────────────────────────────────────────────────────

test('D2 来源全部标注可靠性 ⇒ settled；一个都没标 ⇒ inconclusive（含半标）', () => {
  const lookup = lookupOf([
    { id: 'SOURCE-0001', reliability: '高，可逐行核' },
    { id: 'SOURCE-0002', reliability: '方案原文，可逐条核' },
    { id: 'SOURCE-0003' },
  ])
  const all = credibilityOf(fields({ sourceIds: ['SOURCE-0001', 'SOURCE-0002'] }), { lookupSource: lookup, now: NOW })
  assert.equal(all.sourceReliability.verdict, 'settled')

  const none = credibilityOf(fields({ sourceIds: ['SOURCE-0003'] }), { lookupSource: lookup, now: NOW })
  assert.equal(none.sourceReliability.verdict, 'inconclusive')

  // 半标也是「不下结论」——不能因为有一半标了就当成已验证
  const half = credibilityOf(fields({ sourceIds: ['SOURCE-0001', 'SOURCE-0003'] }), { lookupSource: lookup, now: NOW })
  assert.equal(half.sourceReliability.verdict, 'inconclusive')
  assert.match(half.sourceReliability.reading, /仅 1 个/)
})

test('D3 悬空来源 id ⇒ inconclusive（不是 settled，也不静默放过）', () => {
  const lookup = lookupOf([{ id: 'SOURCE-0001', reliability: '高' }])
  const reading = credibilityOf(fields({ sourceIds: ['SOURCE-0001', 'SOURCE-9999'] }), {
    lookupSource: lookup,
    now: NOW,
  })
  assert.equal(reading.sourceReliability.verdict, 'inconclusive')
  assert.match(reading.sourceReliability.reading, /查不到/)
})

test('D4 未登记来源 ⇒ unknown；已停用来源不算「已标注」', () => {
  const empty = credibilityOf(fields(), { now: NOW })
  assert.equal(empty.sourceReliability.verdict, 'unknown')

  const lookup = lookupOf([{ id: 'SOURCE-0001', reliability: '高', retired: true }])
  const retired = credibilityOf(fields({ sourceIds: ['SOURCE-0001'] }), { lookupSource: lookup, now: NOW })
  assert.equal(retired.sourceReliability.verdict, 'inconclusive')
})

// ── D5/D6 抽取置信度与核验状态的分界（本轮核心） ─────────────────────────────

test('D5 provenance=master 有原文坐标 ⇒ settled；无坐标 ⇒ inconclusive', () => {
  const traced = credibilityOf(fields({ provenance: 'master', evidenceRefs: ['session|x|12'] }), { now: NOW })
  assert.equal(traced.extractionConfidence.verdict, 'settled')

  const untraced = credibilityOf(fields({ provenance: 'master' }), { now: NOW })
  assert.equal(untraced.extractionConfidence.verdict, 'inconclusive')
})

test('D6 ★ grounding=proposed 有值但**未核验** ⇒ inconclusive，绝不是 settled', () => {
  const reading = credibilityOf(fields({ grounding: 'proposed', provenance: 'self' }), { now: NOW })
  assert.equal(
    reading.verificationStatus.verdict,
    'inconclusive',
    'proposed 表示「我提的、主人没回应」——判成 settled 就是把我自己的提议当成了已核实事实',
  )
  assert.match(reading.verificationStatus.reading, /未核验/)
})

test('D7 grounding=rejected 是 settled——核实结果是否定，但**核实发生过**', () => {
  const reading = credibilityOf(fields({ grounding: 'rejected' }), { now: NOW })
  assert.equal(reading.verificationStatus.verdict, 'settled')
  assert.match(reading.verificationStatus.reading, /不能再当依据/)
})

test('D8 ★ measured 是自验 ⇒ selfVerified，**不计入 settled**（方案要的是独立核实）', () => {
  const reading = credibilityOf(fields({ provenance: 'measured' }), { now: NOW })
  assert.equal(
    reading.verificationStatus.verdict,
    'selfVerified',
    '同一主体的第二次观察不独立——合并进 settled 会让核实数虚高',
  )
  assert.match(reading.verificationStatus.reading, /不是独立核实/)
})

test('D9 grounding 优先于 measured：有外部回应时不算自验', () => {
  const reading = credibilityOf(fields({ grounding: 'established', provenance: 'measured' }), { now: NOW })
  assert.equal(reading.verificationStatus.verdict, 'settled')
})

// ── D10 抽取置信度：外部依据没有来源登记 ────────────────────────────────────

test('D10 provenance=web 无 sourceIds ⇒ inconclusive——「外部资料却查不到从哪读来的」', () => {
  const reading = credibilityOf(fields({ provenance: 'web' }), { now: NOW })
  assert.equal(reading.extractionConfidence.verdict, 'inconclusive')
  assert.match(reading.extractionConfidence.reading, /查不到/)

  const registered = credibilityOf(fields({ provenance: 'web', sourceIds: ['SOURCE-0001'] }), { now: NOW })
  assert.equal(registered.extractionConfidence.verdict, 'settled')
})

test('D11 self ⇒ inconclusive（我的推断没有「抽取准确」问题）；未标 provenance ⇒ unknown', () => {
  assert.equal(credibilityOf(fields({ provenance: 'self' }), { now: NOW }).extractionConfidence.verdict, 'inconclusive')
  assert.equal(credibilityOf(fields(), { now: NOW }).extractionConfidence.verdict, 'unknown')
})

// ── D12 时效 ────────────────────────────────────────────────────────────────

test('D12 expiry 无论过期与否都能下结论；只有 reviewAfter 时不下结论；都没有 ⇒ unknown', () => {
  const expired = credibilityOf(fields({ expiry: '2026-11-01' }), { now: NOW })
  assert.equal(expired.freshness.verdict, 'settled')
  assert.match(expired.freshness.reading, /已失效/)

  const active = credibilityOf(fields({ expiry: '2026-12-31' }), { now: NOW })
  assert.equal(active.freshness.verdict, 'settled')

  const reviewOnly = credibilityOf(fields({ reviewAfter: `2026-11-25` }), { now: NOW })
  assert.equal(reviewOnly.freshness.verdict, 'inconclusive')

  assert.equal(credibilityOf(fields(), { now: NOW }).freshness.verdict, 'unknown')
})

// ── D13 聚合自洽 ────────────────────────────────────────────────────────────

test('D13 ★ 每一维四档之和恒等于分母，且分母与 catalog 同一把尺子', () => {
  const entries = [
    { id: 'a', kind: 'knowledge', title: '甲', body: 'x', tags: [], scope: 'e:/alice', archived: false, provenance: 'master' },
    { id: 'b', kind: 'knowledge', title: '乙', body: 'x', tags: [], scope: 'e:/alice', archived: false, grounding: 'proposed' },
    { id: 'c', kind: 'knowledge', title: '丙', body: 'x', tags: [], scope: 'e:/alice', archived: false, provenance: 'measured' },
    // 四维齐全的那一条：有来源且标了可靠性 + 有原文坐标 + 主人明确说过 + 设了失效时刻
    {
      id: 'full',
      kind: 'knowledge',
      title: '己',
      body: 'x',
      tags: [],
      scope: 'e:/alice',
      archived: false,
      provenance: 'master',
      evidenceRefs: ['session|x|1'],
      grounding: 'established',
      sourceIds: ['SOURCE-0001'],
      expiry: '2026-12-31',
    },
    { id: 'archived', kind: 'knowledge', title: '丁', body: 'x', tags: [], scope: 'e:/alice', archived: true },
    { id: 'summary', kind: 'summary', title: '戊', body: 'x', tags: [], scope: 'e:/alice', archived: false, level: 'day', bucket: '2026-11-18' },
  ]
  const lookup = lookupOf([{ id: 'SOURCE-0001', reliability: '高' }])
  const report = credibilityReport(entries, { lookupSource: lookup, now: NOW })
  assert.equal(report.denominator, 4, '分母必须排除归档与 summary（与 memory_catalog.gaps 同一把尺子）')

  for (const dimension of report.dimensions) {
    const sum =
      dimension.settled + dimension.selfVerified + dimension.inconclusive + dimension.unknown
    assert.equal(sum, dimension.total, `${dimension.label} 四档之和必须等于分母`)
    assert.equal(dimension.total, report.denominator)
  }

  // ⚠ 只有四维**全部**有值且语义成立的那一条能全通；
  //   只有 provenance=master（无坐标）的甲、只有 grounding=proposed 的乙、只有 measured 的丙
  //   一条都不够——这正是本模块「严格」的证据（严格不是 bug，是所有格的默认值都是 unknown）。
  assert.equal(report.allSettled, 1)
  assert.equal(report.anySettled, 1)
})

test('D14 ★ 不合成总分：报告里没有任何 score 类键', () => {
  const report = credibilityReport([], { now: NOW })
  const flat = JSON.stringify(report).toLowerCase()
  for (const forbidden of ['"score"', '"total_score"', '"credibilityscore"', '"overall"']) {
    assert.equal(flat.includes(forbidden), false, `方案 §5.4：可信度不能只有一个数字——出现 ${forbidden} 即违规`)
  }
})

test('D15 代理维必须带 caveat，且 fidelity 与「是不是真读数」一致', () => {
  const report = credibilityReport([], { now: NOW })
  for (const dimension of report.dimensions) {
    assert.ok(dimension.caveat.length > 0, `${dimension.label} 缺 caveat：代理读数不写边界就会被当成真读数`)
    assert.ok(dimension.needs.length > 0, `${dimension.label} 缺 needs：缺口不可行动`)
  }
  const proxy = report.dimensions.filter((item) => item.fidelity === 'proxy').map((item) => item.dimension)
  assert.deepEqual(proxy.sort(), ['extractionConfidence', 'sourceReliability'])
})

test('D16 空分母不产生 NaN（readableRate 为 0）', () => {
  const report = credibilityReport([], { now: NOW })
  assert.equal(report.denominator, 0)
  for (const dimension of report.dimensions) assert.equal(dimension.readableRate, 0)
})

test('D17 四档标签齐全（渲染层不需要自己造词）', () => {
  for (const verdict of ['settled', 'selfVerified', 'inconclusive', 'unknown']) {
    assert.equal(typeof CRED_VERDICT_LABELS[verdict], 'string')
    assert.ok(CRED_VERDICT_LABELS[verdict].length > 0)
  }
})

test('D18 ★ 来源按 scope 隔离：两个 workspace 各有 SOURCE-0001 时不许串号', () => {
  const lookup = lookupOf([
    { id: 'SOURCE-0001', scope: 'e:/alice', reliability: '本工作区的来源，已标注' },
    { id: 'SOURCE-0001', scope: 'e:/other', reliability: '' },
  ])
  const mine = credibilityOf(fields({ scope: 'e:/alice', sourceIds: ['SOURCE-0001'] }), {
    lookupSource: lookup,
    now: NOW,
  })
  assert.equal(mine.sourceReliability.verdict, 'settled')

  // 同 id、另一个 scope 没标 ⇒ 两条必须给出不同读数（按 id 建 Map 时这里会串成一样）
  const other = credibilityOf(fields({ scope: 'e:/other', sourceIds: ['SOURCE-0001'] }), {
    lookupSource: lookup,
    now: NOW,
  })
  assert.equal(other.sourceReliability.verdict, 'inconclusive')

  // scope 写错时不许静默串到别人的来源
  const wrong = credibilityOf(fields({ scope: 'e:/typo', sourceIds: ['SOURCE-0001'] }), {
    lookupSource: lookup,
    now: NOW,
  })
  assert.equal(wrong.sourceReliability.verdict, 'inconclusive')
  assert.match(wrong.sourceReliability.reading, /查不到/)
})
