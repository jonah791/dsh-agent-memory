/**
 * config.ts 四态单测（IMPLEMENTATION.md §6 T2 验收）：
 * 缺省 / 部分 / 完整 / 非法（fail loud）。
 * 运行：node --test tests/（Node ≥22.18 原生 TS 支持）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_CONFIG,
  MemoryConfigError,
  loadMemoryConfig,
  memoryConfigPath,
  parseMemoryConfig,
  resolveMemoryConfig,
} from '../src/config.ts'

// ---------- 1. 缺省态 ----------

test('缺省：空文档 → 全部默认值', () => {
  const cfg = parseMemoryConfig('')
  assert.deepEqual(cfg, DEFAULT_CONFIG)
})

test('缺省：纯注释文档 → 全部默认值', () => {
  const cfg = parseMemoryConfig('# 这是注释\n# 没有实际字段\n')
  assert.deepEqual(cfg, DEFAULT_CONFIG)
})

test('缺省：文件不存在（ENOENT）→ 全部默认值', async () => {
  const missing = join(tmpdir(), 'memory-missing-', Date.now().toString(), 'memory.yml')
  const cfg = await loadMemoryConfig(missing)
  assert.deepEqual(cfg, DEFAULT_CONFIG)
})

test('缺省：空对象 resolve → 全部默认值', () => {
  const cfg = resolveMemoryConfig({})
  assert.deepEqual(cfg, DEFAULT_CONFIG)
})

// ---------- 2. 部分态 ----------

test('部分：只给 scope → 其余默认', () => {
  const cfg = parseMemoryConfig('scope: global\n')
  assert.equal(cfg.scope, 'global')
  assert.equal(cfg.autoSink, DEFAULT_CONFIG.autoSink)
  assert.deepEqual(cfg.layers, DEFAULT_CONFIG.layers)
  assert.equal(cfg.maxEntries, DEFAULT_CONFIG.maxEntries)
})

test('部分：只给 timeline 部分字段 → 其余默认', () => {
  const cfg = parseMemoryConfig('timeline:\n  day: false\n')
  assert.equal(cfg.timeline.day, false)
  assert.equal(cfg.timeline.week, true)
  assert.equal(cfg.timeline.month, true)
  assert.equal(cfg.timeline.year, true)
  assert.equal(cfg.timeline.archive, 'keep')
})

test('部分：只给 max_entries 和 auto_sink → 其余默认', () => {
  const cfg = parseMemoryConfig('max_entries: 500\nauto_sink: false\n')
  assert.equal(cfg.maxEntries, 500)
  assert.equal(cfg.autoSink, false)
  assert.equal(cfg.scope, DEFAULT_CONFIG.scope)
  assert.equal(cfg.weeklyTemplate, '')
})

// ---------- 3. 完整态 ----------

const FULL_YAML = `
scope: global-first
layers:
  - fact
  - knowledge
auto_sink: false
timeline:
  day: true
  week: false
  month: true
  year: false
  archive: keep
weekly_template: "每周回顾：{{week}}"
max_entries: 1234
inject:
  enabled: false
  max_bytes: 1500
  max_entries: 8
`

test('完整：全部字段 → 原样生效', () => {
  const cfg = parseMemoryConfig(FULL_YAML)
  assert.deepEqual(cfg, {
    scope: 'global-first',
    layers: ['fact', 'knowledge'],
    autoSink: false,
    timeline: { day: true, week: false, month: true, year: false, archive: 'keep' },
    weeklyTemplate: '每周回顾：{{week}}',
    maxEntries: 1234,
    inject: { enabled: false, maxBytes: 1500, maxEntries: 8 },
  })
})

test('完整：文件加载路径（memoryConfigPath + loadMemoryConfig）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-full-'))
  const p = memoryConfigPath(dir)
  assert.equal(p, join(dir, '.dsh', 'memory.yml'))
  mkdirSync(join(dir, '.dsh'), { recursive: true })
  writeFileSync(p, FULL_YAML, 'utf8')
  const cfg = await loadMemoryConfig(p)
  assert.equal(cfg.scope, 'global-first')
  assert.equal(cfg.maxEntries, 1234)
  assert.equal(cfg.inject.enabled, false)
  assert.equal(cfg.inject.maxBytes, 1500)
})

test('完整：layers 允许 summary 与空数组', () => {
  const withSummary = parseMemoryConfig('layers: [fact, summary]\n')
  assert.deepEqual(withSummary.layers, ['fact', 'summary'])
  const none = parseMemoryConfig('layers: []\n')
  assert.deepEqual(none.layers, [])
})

// ---------- 4. 非法态（fail loud） ----------

test('非法：YAML 语法错误 → MemoryConfigError', () => {
  assert.throws(() => parseMemoryConfig('scope: [workspace'), MemoryConfigError)
})

test('非法：顶层不是映射（数组）→ MemoryConfigError', () => {
  assert.throws(() => parseMemoryConfig('- a\n- b\n'), MemoryConfigError)
})

test('非法：未知顶层键 → MemoryConfigError', () => {
  assert.throws(() => parseMemoryConfig('scopee: global\n'), MemoryConfigError)
})

test('非法：scope 值不在枚举 → MemoryConfigError', () => {
  assert.throws(() => parseMemoryConfig('scope: everywhere\n'), MemoryConfigError)
})

test('非法：auto_sink 非布尔 → MemoryConfigError', () => {
  assert.throws(() => parseMemoryConfig('auto_sink: yes\n'), MemoryConfigError)
})

test('非法：max_entries 为负 → MemoryConfigError', () => {
  assert.throws(() => parseMemoryConfig('max_entries: -1\n'), MemoryConfigError)
})

test('非法：max_entries 为小数 → MemoryConfigError', () => {
  assert.throws(() => parseMemoryConfig('max_entries: 1.5\n'), MemoryConfigError)
})

test('非法：max_entries 为字符串 → MemoryConfigError', () => {
  assert.throws(() => parseMemoryConfig('max_entries: "2000"\n'), MemoryConfigError)
})

test('非法：layers 含未知 kind → MemoryConfigError', () => {
  assert.throws(() => parseMemoryConfig('layers: [fact, gossip]\n'), MemoryConfigError)
})

test('非法：layers 非数组 → MemoryConfigError', () => {
  assert.throws(() => parseMemoryConfig('layers: fact\n'), MemoryConfigError)
})

test('非法：timeline 未知键 → MemoryConfigError', () => {
  assert.throws(() => parseMemoryConfig('timeline:\n  hourly: true\n'), MemoryConfigError)
})

test('非法：timeline.archive 非 keep → MemoryConfigError', () => {
  assert.throws(() => parseMemoryConfig('timeline:\n  archive: delete\n'), MemoryConfigError)
})

test('非法：timeline 非映射 → MemoryConfigError', () => {
  assert.throws(() => parseMemoryConfig('timeline: true\n'), MemoryConfigError)
})

test('非法：weekly_template 非字符串 → MemoryConfigError', () => {
  assert.throws(() => parseMemoryConfig('weekly_template: 42\n'), MemoryConfigError)
})

test('非法：冻结保护（默认配置不可改）', () => {
  assert.throws(() => {
    ;(DEFAULT_CONFIG as { scope: string }).scope = 'global'
  }, TypeError)
  assert.throws(() => {
    DEFAULT_CONFIG.layers.push('episodic')
  }, TypeError)
})
