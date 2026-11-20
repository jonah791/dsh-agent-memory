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
 *
 * v0.63 追加 B1–B6：`memory_browse` 这一档（方案 §11.4 分子分母同口径）。此前 browse 的
 * **拒绝**进 `permission` 审计（分子）而**访问**不进轨迹（分母）⇒「权限违规率」虚高。
 * B 系列守的是「补一档时六个落点必须同时改」——漏任一处会静默错掉一边（写入写 browse、
 * 解析归 recall ⇒ recallCalls 虚高而 browse 消失，两个数一起错且都看起来正常）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../lib/store.js'
import { createMemoryTools } from '../lib/tools.js'
import { DEFAULT_CONFIG } from '../lib/config.js'
import { DEFAULT_AUDIT_CONFIG } from '../lib/audit.js'
import {
  appendAccessTrace,
  parseAccessTrace,
  parseAccessRecords,
  readAccessSummary,
  summarizeAccessRecords,
  MAX_IDS_PER_RECORD,
} from '../lib/access-trace.js'
import { workspaceIdOf } from '../lib/scope.js'

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

// ---------- B 系列：browse 档（v0.63 · 方案 §11.4 分子分母同口径） ----------

const CWD = 'C:\\Users\\Alice\\proj'
const WID = workspaceIdOf(CWD)

class MemoryKv {
  constructor() { this.map = new Map() }
  get(key) { const v = this.map.get(key); return v === undefined ? undefined : { ...v } }
  async put(key, value) { this.map.set(key, { ...value }) }
  async delete(key) { return this.map.delete(key) }
  entries() { return this.map.entries() }
  get size() { return this.map.size }
}

function entry(partial) {
  const iso = partial.createdAt ?? '2026-09-10T00:00:00.000Z'
  return {
    id: partial.id ?? Math.random().toString(36).slice(2),
    kind: 'knowledge',
    title: partial.title ?? '条目',
    body: partial.body ?? '正文',
    tags: partial.tags ?? [],
    scope: partial.scope ?? WID,
    createdAt: iso,
    updatedAt: partial.updatedAt ?? iso,
    accessedAt: partial.accessedAt ?? iso,
    level: null,
    bucket: null,
    archived: false,
    ...partial,
  }
}

const BASE_CONFIG = { ...DEFAULT_CONFIG, audit: DEFAULT_AUDIT_CONFIG }

/** 启用角色维度：main 看全部；worker read 为空且不共享 ⇒ 任何有归属的条目都被拒（制造拒绝） */
const ROLE_CONFIG = {
  ...BASE_CONFIG,
  roles: {
    enabled: true,
    default: 'main',
    derived: 'worker',
    policyDefault: { read: ['*'], includeShared: true, includeGlobal: true },
    policies: {
      main: { read: ['*'], includeShared: true, includeGlobal: true },
      worker: { read: [], includeShared: false, includeGlobal: true },
    },
  },
}

function setup(config = BASE_CONFIG, extraDeps = {}) {
  const kv = new MemoryKv()
  const store = new MemoryStore(kv)
  const accessRecords = []
  const auditRecords = []
  const tools = createMemoryTools({
    store,
    loadConfig: async () => config,
    recordAccess: (record) => { accessRecords.push(record) },
    recordAudit: (record) => { auditRecords.push(record) },
    ...extraDeps,
  })
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const exec = {
    agent: { session: { id: 'session-11111111-2222-3333-4444-555555555555', header: { id: 'session-11111111-2222-3333-4444-555555555555', cwd: CWD } } },
    signal: new AbortController().signal,
  }
  return { kv, store, byName, exec, accessRecords, auditRecords }
}

test('B1 browse 调用写一条 source=browse、ids 为空的轨迹记录（分母存在）', async () => {
  const { kv, byName, exec, accessRecords } = setup()
  kv.map.set(`${WID}:knowledge:e1`, entry({ id: 'e1', title: '一条记忆' }))
  kv.map.set(`${WID}:knowledge:e2`, entry({ id: 'e2', title: '另一条记忆' }))

  await byName.get('memory_browse').execute({}, exec)

  const browse = accessRecords.filter((record) => record.source === 'browse')
  assert.equal(browse.length, 1, '一次 browse 必须落且只落一条 browse 记录')
  assert.deepEqual(browse[0].ids, [], 'browse 是「按桶翻全库」，ids 必须留空——否则前 30 条会被当成「被检索命中」污染用量归因')
  // 反向断言：同一次调用不得冒充 recall / auto（那会让另外两个计数虚高）
  assert.equal(accessRecords.some((record) => record.source === 'recall'), false, 'browse 不得被记成 recall')
  assert.equal(accessRecords.some((record) => record.source === 'auto'), false, 'browse 不得被记成 auto')
})

test('B1b access_trace 关闭时零写入（配置纪律不被绕过）', async () => {
  const config = { ...BASE_CONFIG, audit: { ...DEFAULT_AUDIT_CONFIG, accessTrace: { enabled: false, maxBytes: 2_000_000 } } }
  const { kv, byName, exec, accessRecords } = setup(config)
  kv.map.set(`${WID}:knowledge:e1`, entry({ id: 'e1' }))
  await byName.get('memory_browse').execute({}, exec)
  assert.equal(accessRecords.length, 0, 'accessTrace.enabled=false ⇒ 完全不落盘')
})

test('B2 解析：browse 独立计数，且不被归进 recall（串档哨兵）', () => {
  const text = [
    JSON.stringify({ atMs: 100, source: 'recall', ids: ['a'] }),
    JSON.stringify({ atMs: 200, source: 'browse', ids: [] }),
    JSON.stringify({ atMs: 300, source: 'browse', ids: [] }),
  ].join('\n')
  const summary = summarizeAccessRecords(text)
  assert.equal(summary.browseCalls, 2, 'browse 必须独立成计')
  assert.equal(summary.recallCalls, 1, 'browse 行不得被算进 recallCalls')
  assert.equal(summary.autoCalls, 0)
})

test('B3 只有 browse 记录时 readAccessSummary 仍返回读数（不是「从未检索」）', async () => {
  const p = tmpFile()
  await appendAccessTrace(p, { atMs: 1_000, source: 'browse', ids: [] }, 1_000_000)

  const summary = await readAccessSummary(p)
  assert.notEqual(summary, undefined, '只有 browse 访问的库被判成「从未检索」= v0.44「空结果恒 0.00%」同形错误')
  assert.equal(summary.browseCalls, 1)
})

test('B4 未知 source：两个读端各自的不对称容错（是既有行为，不许「顺手统一」）', () => {
  const text = JSON.stringify({ atMs: 100, source: 'weird-unknown', ids: ['a'] })

  // 逐条序列解析：未知归 recall——下游 R7 需要完整序列，不能因为来源不认得就丢行
  const records = parseAccessRecords(text)
  assert.equal(records.length, 1, '有效行不得被丢')
  assert.equal(records[0].source, 'recall', '未知 source 归 recall 是 parseAccessRecords 的既有容错')

  // 汇总口径：未知 source 只进 lines、不进任何 calls——与上一条**不对称**
  const summary = summarizeAccessRecords(text)
  assert.equal(summary.lines, 1, '有效行照数')
  assert.equal(summary.recallCalls, 0, '汇总层不把未知 source 归 recall（不对称是刻意的）')
  assert.equal(summary.autoCalls, 0)
  assert.equal(summary.browseCalls, 0)
})

test('B5 browse 的空 ids 不产生用量归因（hits / attributed 不动）', () => {
  const text = [
    JSON.stringify({ atMs: 100, source: 'browse', ids: [] }),
    JSON.stringify({ atMs: 200, source: 'recall', ids: ['a'] }),
  ].join('\n')
  const index = parseAccessTrace(text)
  assert.deepEqual([...index.keys()], ['a'], '只有 recall 的那条进归因索引')
  assert.equal(index.get('a').hits, 1)
})

test('B6 同一次 browse：拒绝进 permission 审计（分子），访问进轨迹（分母）——两族同时成立', async () => {
  const { kv, byName, exec, accessRecords, auditRecords } = setup(ROLE_CONFIG)
  kv.map.set(`${WID}:knowledge:p1`, entry({ id: 'p1', title: '项目内条目', role: 'main' }))
  kv.map.set(`${WID}:knowledge:p2`, entry({ id: 'p2', title: '另一条项目内条目', role: 'main' }))

  const result = await byName.get('memory_browse').execute({ role: 'worker' }, exec)

  // 分子：拒绝必须落审计，且**归因到 browse 这个工具**
  const rejects = auditRecords.filter((record) => record.action === 'permission' && record.tool === 'memory_browse')
  assert.ok(rejects.length > 0, '角色拒绝必须落 permission 审计（分子）')
  assert.ok(rejects.every((record) => record.outcome === 'rejected'))
  assert.ok(rejects.reduce((sum, record) => sum + (record.target?.count ?? 0), 0) > 0, '拒绝计数必须为真数')

  // 分母：同一次调用必须落一条 browse 访问记录
  const browse = accessRecords.filter((record) => record.source === 'browse')
  assert.equal(browse.length, 1, '同一次 browse 必须有分母，否则比率虚高')

  // 拒绝确实发生了（不是「审计写了但没人被拒」）
  assert.equal(result.total, 0, 'worker 视野内看不到有归属的条目')
})

test('B6b 没有拒绝时不写 permission 审计（只记异常面，不刷屏）', async () => {
  const { kv, byName, exec, accessRecords, auditRecords } = setup(ROLE_CONFIG)
  kv.map.set(`${WID}:knowledge:own1`, entry({ id: 'own1', title: 'worker 自己的', role: 'worker' }))

  await byName.get('memory_browse').execute({ role: 'worker' }, exec)

  assert.equal(auditRecords.filter((record) => record.action === 'permission').length, 0, '零拒绝 ⇒ 零审计记录')
  assert.equal(accessRecords.filter((record) => record.source === 'browse').length, 1, '但访问照记（分母与拒绝无关）')
})
