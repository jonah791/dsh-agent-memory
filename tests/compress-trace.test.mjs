/**
 * 压缩流水线轨迹侧车离线单测（v0.8 证据层 · §5.12）
 *
 * 判据纪律（AGENTS.md §5.9）：防线必须有**已知坏样本**证明它真会拦——
 *   · 不可写路径 → 必须返回 false 且**不抛**（观测绝不反噬主流程，§5.22 规则 3）
 *   · 坏行 / 异形行 → 必须跳过，不毒化汇总（轨迹是旁证，永不能成为故障源）
 *   · 超样本上限 → 必须截断（防长文把轨迹撑爆）
 * 运行：pnpm test:all（先 build 再 node --test）
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendCompressTrace,
  formatSkipped,
  MAX_SAMPLE,
  readCompressSummary,
  summarizeCompressTrace,
} from '../lib/compress-trace.js'
import { DEFAULT_CONFIG, MemoryConfigError, parseMemoryConfig } from '../lib/config.js'

/** 建临时目录（每个用例独立，避免相互污染） */
async function tempDir() {
  return await mkdtemp(join(tmpdir(), 'mem-compress-trace-'))
}

describe('appendCompressTrace（只追加 / 吞错 / 轮转）', () => {
  test('写入 JSONL：一行一记录、逐行可解析、字段保真', async () => {
    const dir = await tempDir()
    try {
      const fp = join(dir, 'trace.jsonl')
      const ok1 = await appendCompressTrace(fp, { atMs: 1000, trigger: 'periodic', scope: 'ws', phase: 'scan', candidates: 3, pending: 1 }, 0)
      const ok2 = await appendCompressTrace(fp, { atMs: 1001, trigger: 'periodic', scope: 'ws', phase: 'unit', level: 'day', bucket: '2026-08-05', reason: 'compressed' }, 0)
      assert.equal(ok1, true)
      assert.equal(ok2, true)
      const lines = (await readFile(fp, 'utf8')).trim().split('\n')
      assert.equal(lines.length, 2)
      const first = JSON.parse(lines[0])
      assert.equal(first.phase, 'scan')
      assert.equal(first.trigger, 'periodic')
      assert.equal(first.candidates, 3)
      assert.equal(JSON.parse(lines[1]).bucket, '2026-08-05')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('样本超上限 ⇒ 截断到 MAX_SAMPLE（长文不撑爆轨迹）', async () => {
    const dir = await tempDir()
    try {
      const fp = join(dir, 'trace.jsonl')
      const sample = Array.from({ length: MAX_SAMPLE + 15 }, (_, i) => `day 2026-08-${i} pending`)
      await appendCompressTrace(fp, { atMs: 1, trigger: 'lazy', scope: 'ws', phase: 'scan', sample }, 0)
      const record = JSON.parse((await readFile(fp, 'utf8')).trim())
      assert.equal(record.sample.length, MAX_SAMPLE)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('尸体样本：不可写路径 ⇒ 返回 false 且绝不抛（观测不反噬主流程）', async () => {
    const dir = await tempDir()
    try {
      const fp = join(dir, 'no-such-dir', 'trace.jsonl')
      const ok = await appendCompressTrace(fp, { atMs: 1, trigger: 'lazy', scope: 'ws', phase: 'end' }, 0)
      assert.equal(ok, false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('超 maxBytes ⇒ 轮转为 .1 后重开（不无限长大）', async () => {
    const dir = await tempDir()
    try {
      const fp = join(dir, 'trace.jsonl')
      await writeFile(fp, 'x'.repeat(64), 'utf8')
      await appendCompressTrace(fp, { atMs: 2, trigger: 'periodic', scope: 'ws', phase: 'end' }, 16)
      const rotated = await readFile(`${fp}.1`, 'utf8')
      assert.equal(rotated.length, 64)
      const fresh = JSON.parse((await readFile(fp, 'utf8')).trim())
      assert.equal(fresh.phase, 'end')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('summarizeCompressTrace（纯函数 · 最近一次扫描口径）', () => {
  test('计数 scan/unit/error；空文本 ⇒ 全零', () => {
    const empty = summarizeCompressTrace('')
    assert.deepEqual(
      { scans: empty.scans, units: empty.units, errors: empty.errors, lastAtMs: empty.lastAtMs, pendingLast: empty.pendingLast },
      { scans: 0, units: 0, errors: 0, lastAtMs: 0, pendingLast: 0 },
    )
    const text = [
      JSON.stringify({ atMs: 10, trigger: 'lazy', scope: 'ws', phase: 'scan', candidates: 4, pending: 2, skipped: { 'no-sources': 2 }, sample: ['day 2026-08-05 pending'] }),
      JSON.stringify({ atMs: 11, trigger: 'lazy', scope: 'ws', phase: 'unit', level: 'day', bucket: '2026-08-05', reason: 'compressed' }),
      JSON.stringify({ atMs: 12, trigger: 'lazy', scope: 'ws', phase: 'error', message: '总结产出为空' }),
      JSON.stringify({ atMs: 13, trigger: 'lazy', scope: 'ws', phase: 'scan', candidates: 9, pending: 0, skipped: { 'already-summarized': 7, 'no-sources': 2 }, sample: ['day 2026-08-09 already-summarized'] }),
    ].join('\n')
    const s = summarizeCompressTrace(text)
    assert.equal(s.scans, 2)
    assert.equal(s.units, 1)
    assert.equal(s.errors, 1)
    assert.equal(s.lastAtMs, 13)
    assert.equal(s.lastTrigger, 'lazy')
    // 最近一次 scan 的口径（不是累计）
    assert.equal(s.candidatesLast, 9)
    assert.equal(s.pendingLast, 0)
    assert.deepEqual(s.skippedLast, { 'already-summarized': 7, 'no-sources': 2 })
    assert.deepEqual(s.sampleLast, ['day 2026-08-09 already-summarized'])
  })

  test('坏行 / 异形行跳过不抛：坏行不毒化汇总、也不清空既有口径', () => {
    const good = JSON.stringify({ atMs: 99, trigger: 'periodic', scope: 'ws', phase: 'scan', candidates: 1, pending: 1, skipped: {}, sample: ['day 2026-08-05 pending'] })
    const text = [
      '{ 这不是 JSON',
      'null',
      '"字符串不是对象"',
      '[1,2,3]',
      JSON.stringify({ atMs: 5, scope: 'ws', phase: 'scan', candidates: '不是数字', skipped: { bad: 'x', ok: 2 }, sample: [1, 'keep'] }),
      good,
      JSON.stringify({ atMs: 100, trigger: 'periodic', phase: 5 }), // 异形行：phase 非字符串
    ].join('\n')
    const s = summarizeCompressTrace(text)
    assert.equal(s.lastAtMs, 100)
    assert.equal(s.scans, 2) // 第二条 scan（atMs=5 那条）+ good
    assert.equal(s.candidatesLast, 1)
    assert.deepEqual(s.skippedLast, {})
    assert.deepEqual(s.sampleLast, ['day 2026-08-05 pending'])
  })

  test('formatSkipped：按桶数降序、空表返回「无」', () => {
    assert.equal(formatSkipped({}), '无')
    assert.equal(formatSkipped({ 'no-sources': 2, 'already-summarized': 7 }), 'already-summarized 7, no-sources 2')
  })
})

describe('readCompressSummary（吞错：无信号按 undefined 处理）', () => {
  test('文件不存在 ⇒ undefined', async () => {
    const summary = await readCompressSummary(join(tmpdir(), 'definitely-missing-trace-xyz.jsonl'))
    assert.equal(summary, undefined)
  })

  test('有记录但全是坏行 ⇒ undefined（lastAtMs 仍为 0 ⇒ 视为无信号）', async () => {
    const dir = await tempDir()
    try {
      const fp = join(dir, 'trace.jsonl')
      await writeFile(fp, '不是 JSON\n{也坏}\n', 'utf8')
      assert.equal(await readCompressSummary(fp), undefined)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('audit.compress_trace 配置（A62）', () => {
  test('缺省开：1 MB 轮转阈值，且缺省配置里确实有这个键', () => {
    assert.equal(DEFAULT_CONFIG.audit.compressTrace.enabled, true)
    assert.equal(DEFAULT_CONFIG.audit.compressTrace.maxBytes, 1_000_000)
  })

  test('可关 + 可覆盖轮转阈值（max_bytes=0 = 不轮转）', () => {
    const cfg = parseMemoryConfig('audit:\n  compress_trace:\n    enabled: false\n    max_bytes: 0\n')
    assert.equal(cfg.audit.compressTrace.enabled, false)
    assert.equal(cfg.audit.compressTrace.maxBytes, 0)
  })

  test('非法 fail-loud：未知键 / 非布尔 / 负值 / 非映射', () => {
    assert.throws(() => parseMemoryConfig('audit:\n  compress_trace:\n    bogus: 1\n'), MemoryConfigError)
    assert.throws(() => parseMemoryConfig('audit:\n  compress_trace:\n    enabled: yes\n'), MemoryConfigError)
    assert.throws(() => parseMemoryConfig('audit:\n  compress_trace:\n    max_bytes: -1\n'), MemoryConfigError)
    assert.throws(() => parseMemoryConfig('audit:\n  compress_trace: 3\n'), MemoryConfigError)
  })
})
