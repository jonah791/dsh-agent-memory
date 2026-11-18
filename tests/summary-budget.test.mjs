/**
 * v0.24.2 回归：分层概要预算（lh-ac92de7e）
 *
 * 缺陷形状：压缩是**链式**的（日→周→月→年），而审计只有**一把**尺子（6000 字）。
 * 结果是周/月概要**结构上不可能**达标——2026-11-18 实测：周概要 16,945 字（2.8 倍）、
 * 日概要 17,473 字（2.9 倍）双双常驻 REVIEW，把「交人裁决」的位置占满，而重压也救不回来。
 *
 * 两条判据（都能在旧实现下变红）：
 *  ① `summaryBudgetChars` 必须按层给出不同尺子，且缺层名 / 未知层名回退单层预算（零回归）。
 *  ② 同长度（9000 字）的周概要**不该**因预算进 REVIEW，而同长度的日概要**该**进——
 *     这一对是判据的分辨力来源：只测一边，尺子写错也测不出来。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { auditMemory, summaryBudgetChars, DEFAULT_AUDIT_CONFIG } from '../lib/audit.js'
import { parseMemoryConfig } from '../lib/config.js'

const NOW = Date.parse('2026-11-18T00:00:00.000Z')

const entry = (id, over = {}) => ({
  id,
  kind: 'knowledge',
  title: `条目 ${id}`,
  // ⚠ 正文落在 `body` 字段（audit 的 charsOf 量的是 body，不是 title/text）——
  // 第一版这里写成 `text`，于是所有条目 chars=0，预算判据根本进不去，四条测试全绿得毫无意义。
  body: `# 条目 ${id}\n${'x'.repeat(200)}`,
  scope: 'global',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  tags: [],
  ...over,
})

const sectionBody = (chars) => 'x'.repeat(chars)

test('① 尺子按层取：day/week/month/year 各一把，缺层名或未知层名回退单层预算', () => {
  const cfg = DEFAULT_AUDIT_CONFIG
  assert.equal(summaryBudgetChars('day', cfg), 6000)
  assert.equal(summaryBudgetChars('week', cfg), 15000)
  assert.equal(summaryBudgetChars('month', cfg), 30000)
  assert.equal(summaryBudgetChars('year', cfg), 60000)
  // 零回归：无层名（旧形态数据）/ null / 未知层名 ⇒ 回到单层尺子
  assert.equal(summaryBudgetChars(undefined, cfg), cfg.summaryMaxChars)
  assert.equal(summaryBudgetChars(null, cfg), cfg.summaryMaxChars)
  assert.equal(summaryBudgetChars('quarter', cfg), cfg.summaryMaxChars)
})

test('② 分辨力：9000 字的周概要不出预算档，同长度的日概要出', () => {
  const auditOne = (e) => auditMemory({ entries: [e], now: NOW }).candidates.find((c) => c.id === e.id)

  // 周概要 9000 字 < 15000 ⇒ 不因预算进 REVIEW（旧实现会：9000 > 6000）
  const week = auditOne(entry('week-sum', { kind: 'summary', level: 'week', title: '周概要', body: sectionBody(9000) }))
  assert.notEqual(week.bucket, 'REVIEW', `周概要 9000 字不该因预算进 REVIEW，实得 ${week.bucket}：${week.reasons?.[0]}`)

  // 日概要 9000 字 > 6000 ⇒ 仍要进 REVIEW（这一边证明尺子没有被整体放宽）
  const day = auditOne(entry('day-sum', { kind: 'summary', level: 'day', title: '日概要', body: sectionBody(9000) }))
  assert.equal(day.bucket, 'REVIEW')
  assert.match(day.reasons[0], /概要超预算/)
  assert.match(day.reasons[0], /summary_max_chars_by_level\.day\(6000\)/, '理由要点名用的是哪把尺子')
})

test('② 超月预算仍要报：月概要 32000 字 > 30000', () => {
  const month = auditMemory({ entries: [entry('m', { kind: 'summary', level: 'month', title: '月概要', body: sectionBody(32000) })], now: NOW })
    .candidates.find((c) => c.id === 'm')
  assert.equal(month.bucket, 'REVIEW')
  assert.match(month.reasons[0], /summary_max_chars_by_level\.month\(30000\)/)
})

test('② 配置可覆盖：memory.yml 的 summary_max_chars_by_level 生效，未知层名报错', () => {
  const ok = parseMemoryConfig('audit:\n  summary_max_chars_by_level:\n    week: 20000\n')
  assert.equal(ok.audit.summaryMaxCharsByLevel.week, 20000)
  // 未配的层保持缺省（不是 0、不是 undefined）
  assert.equal(ok.audit.summaryMaxCharsByLevel.day, 6000)
  assert.equal(ok.audit.summaryMaxCharsByLevel.month, 30000)

  assert.throws(
    () => parseMemoryConfig('audit:\n  summary_max_chars_by_level:\n    weekly: 20000\n'),
    /summary_max_chars_by_level/,
    '未知层名必须报错——写错层名而静默忽略，会让配置看起来生效、实际没生效',
  )
})
