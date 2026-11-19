/**
 * access-trace **写入器**契约（v0.44 · 方案 §16.3）
 *
 * 为什么单独一个文件：这一层是**真实写入器**，而 `audit.test.mjs` 的 A31c 嘲掉了
 * `recordAccess`（测的是**调用点**）。2026-11-19 线上实测暴露了这个分工的盲区——
 * A31c 绿，但 `appendAccessTrace` 里还留着一道 `ids.length === 0 ⇒ return false`，
 * 于是空结果依然不落盘。**被嘲掉的那一层里藏着第三道门。**
 *
 * 判据纪律：凡「改了 A 要让它生效」的修复，A 的上下游都要有非 mock 的判据；
 * 否则测试通过只证明「mock 契约成立」，不证明「真实链路走通」。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendAccessTrace, parseAccessTrace, MAX_IDS_PER_RECORD } from '../lib/access-trace.js'

/** 每例一个临时文件（并发安全，互不覆盖） */
function tmpFile() {
  return join(mkdtempSync(join(tmpdir(), 'aml-trace-')), 'trace.jsonl')
}

/** 逐行读回（不走 parseAccessTrace：它按 id 建索引，空 ids 不产生 key） */
function readLines(p) {
  return readFileSync(p, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l))
}

test('T1 ★空 ids 必须落盘——这是失败样本的唯一载体', async () => {
  const p = tmpFile()
  const ok = await appendAccessTrace(p, { atMs: 1, source: 'recall', role: 'main', ids: [] }, 0)
  assert.equal(ok, true, '空 ids 必须返回 true（此前这里是 return false）')
  const lines = readLines(p)
  assert.equal(lines.length, 1, '必须真的写了一行——否则「空结果率」的分子永远是 0')
  assert.deepEqual(lines[0].ids, [], 'ids 是空数组，不是被省略（省略 = 不知道，空数组 = 查了没结果）')
  assert.equal(lines[0].source, 'recall', '来源必须可辨')
})

test('T2 有 ids 照旧落盘 + 超上限截断', async () => {
  const p = tmpFile()
  const ids = Array.from({ length: MAX_IDS_PER_RECORD + 5 }, (_, i) => `id-${i}`)
  await appendAccessTrace(p, { atMs: 2, source: 'auto', ids }, 0)
  const lines = readLines(p)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].ids.length, MAX_IDS_PER_RECORD, '必须截断到上限')
})

test('T3 空结果与有结果混写后，两类都能被数出来（空结果率的分子/分母）', async () => {
  const p = tmpFile()
  await appendAccessTrace(p, { atMs: 3, source: 'recall', ids: ['a'] }, 0)
  await appendAccessTrace(p, { atMs: 4, source: 'recall', ids: [] }, 0)
  await appendAccessTrace(p, { atMs: 5, source: 'auto', ids: [] }, 0)
  const lines = readLines(p)
  assert.equal(lines.length, 3, '三次调用三行——调用次数是分母')
  assert.equal(lines.filter((r) => r.ids.length === 0).length, 2, '两行空结果——空结果率的分子')
  assert.equal(lines.reduce((n, r) => n + r.ids.length, 0), 1, '条目·次是另一个分母（这里 1）')
})

test('T4 空 ids 行不破坏按 id 建索引的读端', async () => {
  const p = tmpFile()
  await appendAccessTrace(p, { atMs: 6, source: 'recall', ids: ['x', 'y'] }, 0)
  await appendAccessTrace(p, { atMs: 7, source: 'recall', ids: [] }, 0)
  const index = parseAccessTrace(readFileSync(p, 'utf8'))
  assert.equal(index.size, 2, '只有两条真实 id 进索引，空行不产生 key 也不崩')
  assert.ok(index.has('x') && index.has('y'))
})
