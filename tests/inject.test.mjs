/**
 * v0.2 测试：启动注入 buildMemoryDigest 纯函数 + 压缩即记忆（node:test，离线）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildMemoryDigest } from '../lib/inject.js'

function entry(partial) {
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

const OPTS = { maxBytes: 3000, maxEntries: 20 }

test('digest：global fact 全量 + 概要先 + 近期明细', () => {
  const globalFacts = [
    entry({ id: 'f1', title: '主人偏好：中文', createdAt: '2026-08-14T00:00:00.000Z', kind: 'fact', scope: 'global' }),
  ]
  const scopeEntries = [
    entry({ id: 'w', title: '周概要', createdAt: '2026-08-14T00:00:00.000Z', kind: 'summary', level: 'week', bucket: '2026-W33' }),
    entry({ id: 'e', title: '昨天完成压缩插件', createdAt: '2026-08-13T00:00:00.000Z', kind: 'episodic' }),
  ]
  const text = buildMemoryDigest(globalFacts, scopeEntries, OPTS)
  assert.ok(text.includes('主人偏好：中文'))
  // 概要在明细前
  const wi = text.indexOf('周概要')
  const ei = text.indexOf('昨天完成压缩插件')
  assert.ok(wi >= 0 && ei > wi)
  assert.ok(text.includes('<system-reminder>'))
})

test('digest：maxEntries 截断并提示省略', () => {
  const many = Array.from({ length: 30 }, (_, i) =>
    entry({ id: 'e' + i, title: '条目' + i, createdAt: '2026-08-01T00:00:00.000Z', kind: 'episodic' }))
  const text = buildMemoryDigest([], many, { maxBytes: 100000, maxEntries: 10 })
  const omitted = text.match(/另有 (\d+) 条未列出/)
  assert.ok(omitted !== null)
  assert.equal(Number(omitted[1]), 20)
})

test('digest：maxBytes 截断', () => {
  const many = Array.from({ length: 50 }, (_, i) =>
    entry({ id: 'e' + i, title: '长条目'.repeat(10) + i, createdAt: '2026-08-01T00:00:00.000Z', kind: 'episodic' }))
  const text = buildMemoryDigest([], many, { maxBytes: 200, maxEntries: 100 })
  assert.ok(text.length <= 200 + 80) // 帧开销少量余量
  assert.ok(text.includes('预算截断'))
})

test('digest：空记忆返回空串', () => {
  assert.equal(buildMemoryDigest([], [], OPTS), '')
})

test('digest：归档条目不出现', () => {
  const scopeEntries = [
    entry({ id: 'a', title: '活跃条目', createdAt: '2026-08-14T00:00:00.000Z' }),
    entry({ id: 'b', title: '已归档', createdAt: '2026-08-13T00:00:00.000Z', archived: true }),
  ]
  const text = buildMemoryDigest([], scopeEntries, OPTS)
  assert.ok(text.includes('活跃条目'))
  assert.ok(!text.includes('已归档'))
})
