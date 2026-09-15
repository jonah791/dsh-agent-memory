/**
 * 价值体检器单测（v0.6 · `memory_audit`）——audit.ts 纯函数 + 工具层 + 侧车轨迹 + 配置。
 * 运行：npm test（node --test "tests/*.test.mjs"，导入编译产物 lib/*.js）
 *
 * 覆盖（对应 docs/semantic.md §7 的 A31–A42）：
 *   A31 只读：跑前后库内容与 accessedAt 不变；A32 承重原料必为 KEEP（反例）；
 *   A33 recency 单调；A34 体量惩罚单调；A35 近重复簇 → REVIEW；
 *   A36 分档顺序可复现；A37 对账（各档字符合计 = 总量）；A38 视野一致；
 *   A39 轨迹只追加/轮转/吞错；A40 用量项与 usageSource；A41 audit 配置 fail-loud；A42 工具面 11 个。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../lib/store.js'
import { createMemoryTools } from '../lib/tools.js'
import {
  DEFAULT_AUDIT_CONFIG,
  auditMemory,
  classify,
  duplicateClusters,
  referenceIndex,
  scoreEntry,
} from '../lib/audit.js'
import { appendAccessTrace, parseAccessTrace, shouldRotate } from '../lib/access-trace.js'
import { DEFAULT_CONFIG, MemoryConfigError, parseMemoryConfig } from '../lib/config.js'

// ---------- 测试基建 ----------

class MemoryKv {
  constructor() {
    this.map = new Map()
  }
  get(key) {
    const value = this.map.get(key)
    return value === undefined ? undefined : { ...value }
  }
  async put(key, value) {
    this.map.set(key, { ...value })
  }
  async delete(key) {
    return this.map.delete(key)
  }
  entries() {
    return this.map.entries()
  }
  get size() {
    return this.map.size
  }
}

const CWD = 'C:\\Users\\Alice\\proj'
const WID = 'c:/Users/Alice/proj'
const NOW = Date.parse('2026-09-15T12:00:00.000Z')
const DAY = 86_400_000

/** 固定时钟的条目夹具（不经过 store，直接构造） */
function entry(partial) {
  const created = partial.createdAt ?? new Date(NOW - 5 * DAY).toISOString()
  return {
    id: partial.id ?? Math.random().toString(36).slice(2),
    kind: 'knowledge',
    title: partial.title ?? '条目',
    body: partial.body ?? '正文',
    tags: partial.tags ?? [],
    scope: partial.scope ?? WID,
    createdAt: created,
    updatedAt: partial.updatedAt ?? created,
    accessedAt: partial.accessedAt ?? partial.updatedAt ?? created,
    level: null,
    bucket: null,
    archived: false,
    ...partial,
  }
}

/** 造一条「N 天前更新」的条目 */
function aged(days, partial = {}) {
  const iso = new Date(NOW - days * DAY).toISOString()
  return entry({ createdAt: iso, updatedAt: iso, accessedAt: iso, ...partial })
}

/** 配置（含 audit + roles 段） */
const CONFIG = {
  ...DEFAULT_CONFIG,
  audit: DEFAULT_AUDIT_CONFIG,
}

function setup(config = CONFIG) {
  const kv = new MemoryKv()
  const store = new MemoryStore(kv)
  const tools = createMemoryTools({ store, loadConfig: async () => config })
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const exec = {
    agent: {
      session: {
        id: 'session-11111111-2222-3333-4444-555555555555',
        header: { id: 'session-11111111-2222-3333-4444-555555555555', cwd: CWD },
      },
    },
    signal: new AbortController().signal,
  }
  return { kv, store, tools, byName, exec }
}

/** 把条目直接塞进 kv（绕过 remember，保留 role/author 原样） */
function seedRaw(kv, entries) {
  for (const e of entries) kv.map.set(`${e.scope}:${e.kind}:${e.id}`, { ...e })
}

// ---------- A42 工具面 ----------

test('A42 工具面：memory_audit 已注册（共 11 个工具）', () => {
  const { byName } = setup()
  assert.equal(byName.size, 11)
  assert.ok(byName.has('memory_audit'))
  assert.ok(byName.get('memory_audit').description.includes('只读'))
})

// ---------- A32 承重原料必为 KEEP（反例） ----------

test('A32 承重原料必为 KEEP——即使又老又没溯源（反例：防「建议归档掉自己赖以回溯的原料」）', async () => {
  const summary = entry({ id: 's1', kind: 'summary', title: '日概要', level: 'day', bucket: '2026-08-01', archiveRef: ['raw1'] })
  const raw = aged(30, { id: 'raw1', title: '被概要吸收的原料', body: '原料正文', source: undefined })
  const entries = [summary, raw]
  const refs = referenceIndex(entries)
  assert.equal(refs.get('raw1'), 1, '引用索引应记到 1 条引用')

  const breakdown = scoreEntry(raw, {
    weights: DEFAULT_AUDIT_CONFIG.weights,
    refs,
    tagReuse: new Map(),
    dups: new Map(),
    nowMs: NOW,
  })
  const { bucket, reasons } = classify(raw, breakdown, DEFAULT_AUDIT_CONFIG)
  assert.equal(bucket, 'KEEP')
  assert.ok(reasons[0].includes('承重'))

  const result = auditMemory({ entries, now: NOW })
  assert.equal(result.candidates.find((c) => c.id === 'raw1').bucket, 'KEEP')
  assert.equal(result.summary.referenced, 1)
})

// ---------- A33 / A34 单调性 ----------

test('A33 recency 单调：其余相同，越新分数越高', () => {
  const ctxBase = { weights: DEFAULT_AUDIT_CONFIG.weights, refs: new Map(), tagReuse: new Map(), dups: new Map(), nowMs: NOW }
  const fresh = scoreEntry(aged(0), ctxBase).score
  const mid = scoreEntry(aged(15), ctxBase).score
  const stale = scoreEntry(aged(60), ctxBase).score
  assert.ok(fresh > mid, `${fresh} 应 > ${mid}`)
  assert.ok(mid > stale, `${mid} 应 > ${stale}`)
})

test('A34 体量惩罚单调：其余相同，越大分数越低', () => {
  const ctxBase = { weights: DEFAULT_AUDIT_CONFIG.weights, refs: new Map(), tagReuse: new Map(), dups: new Map(), nowMs: NOW }
  const small = scoreEntry(entry({ body: 'x'.repeat(100) }), ctxBase).score
  const large = scoreEntry(entry({ body: 'x'.repeat(8000) }), ctxBase).score
  assert.ok(small > large, `${small} 应 > ${large}`)
})

// ---------- A35 近重复簇 ----------

test('A35 近重复簇：同标题条目同簇且 canonical 为最新，全部进 REVIEW', () => {
  const older = aged(20, { id: 'old', title: '  DSH 插件 缓存  ' })
  const newer = aged(1, { id: 'new', title: 'dsh 插件 缓存' })
  const dups = duplicateClusters([older, newer])
  assert.equal(dups.get('old').cluster, dups.get('new').cluster)
  assert.equal(dups.get('old').canonicalId, 'new')

  const result = auditMemory({ entries: [older, newer], now: NOW })
  for (const candidate of result.candidates) {
    assert.equal(candidate.bucket, 'REVIEW')
    assert.ok(candidate.reasons[0].includes('近重复簇'))
  }
})

// ---------- A36 分档顺序 ----------

test('A36 分档顺序可复现：REVIEW > KEEP(承重) > KEEP(新) > ARCHIVE > DEMOTE > KEEP(小兜底)', () => {
  const entries = [
    entry({ id: 'huge', title: '超大条目', body: 'x'.repeat(15000) }),                     // REVIEW（体量）
    aged(30, { id: 'keep-ref', title: '承重', archiveRef: undefined }),                     // 待引用
    aged(1, { id: 'fresh', title: '新的', body: 'x'.repeat(5000) }),                        // KEEP（新）
    aged(30, { id: 'archive', title: '老且无溯源', body: 'x'.repeat(1000) }),               // ARCHIVE
    aged(30, { id: 'demote', title: '老但有溯源', body: 'x'.repeat(5000), source: { reason: 'x' } }), // DEMOTE
    aged(30, { id: 'tiny', title: '老且小', body: 'x', source: { reason: 'x' } }),          // KEEP（兜底）
  ]
  const summary = entry({ id: 'sum', kind: 'summary', title: '概要', level: 'day', bucket: '2026-08-01', archiveRef: ['keep-ref'] })
  const result = auditMemory({ entries: [...entries, summary], now: NOW })
  const bucketOf = (id) => result.candidates.find((c) => c.id === id).bucket
  assert.equal(bucketOf('huge'), 'REVIEW')
  assert.equal(bucketOf('keep-ref'), 'KEEP')
  assert.equal(bucketOf('fresh'), 'KEEP')
  assert.equal(bucketOf('archive'), 'ARCHIVE')
  assert.equal(bucketOf('demote'), 'DEMOTE')
  assert.equal(bucketOf('tiny'), 'KEEP')
  // 候选排序：需要动作的档位在前（REVIEW → ARCHIVE → DEMOTE → KEEP）
  const order = result.candidates.map((c) => c.bucket)
  assert.deepEqual([...new Set(order)], ['REVIEW', 'ARCHIVE', 'DEMOTE', 'KEEP'])
})

// ---------- A37 对账 ----------

test('A37 对账：各档字符合计 = 总字符；各档条数合计 = 总条数', () => {
  const entries = [
    entry({ id: 'a', body: 'x'.repeat(100) }),
    aged(30, { id: 'b', body: 'y'.repeat(250) }),
    entry({ id: 'c', kind: 'summary', title: '概要', level: 'week', bucket: '2026-W36', body: 'z'.repeat(50) }),
  ]
  const result = auditMemory({ entries, now: NOW })
  const totalChars = entries.reduce((sum, e) => sum + e.body.length, 0)
  assert.equal(result.summary.chars, totalChars)
  const sumChars = Object.values(result.summary.charsByBucket).reduce((a, b) => a + b, 0)
  const sumCount = Object.values(result.summary.byBucket).reduce((a, b) => a + b, 0)
  assert.equal(sumChars, totalChars)
  assert.equal(sumCount, entries.length)
  // 分组视图同样对账
  const groupChars = result.groups.reduce((sum, g) => sum + g.chars, 0)
  assert.equal(groupChars, totalChars)
})

// ---------- A31 只读 ----------

test('A31 只读：memory_audit 跑完库内容与 accessedAt 全不变（零写入）', async () => {
  const { kv, byName, exec } = setup()
  seedRaw(kv, [
    entry({ id: 'e1', title: '一个条目', body: 'x'.repeat(400), tags: ['t'] }),
    aged(30, { id: 'e2', title: '老条目', body: 'y'.repeat(200) }),
    entry({ id: 'e3', kind: 'summary', title: '概要', level: 'day', bucket: '2026-09-01', archiveRef: ['e2'] }),
  ])
  const before = JSON.stringify([...kv.entries()].sort())
  const result = await byName.get('memory_audit').execute({ topN: 10 }, exec)
  const after = JSON.stringify([...kv.entries()].sort())
  assert.equal(after, before, '库内容必须逐字不变')
  assert.equal(result.summary.total, 3)
  assert.equal(result.candidates.length, 3)
  // accessedAt 未被刷新
  for (const [, e] of kv.entries()) assert.equal(e.accessedAt, e.updatedAt)
})

// ---------- A38 视野一致 ----------

test('A38 视野一致：verifier 策略下体检提案只含可见条目', async () => {
  const roleConfig = {
    ...CONFIG,
    roles: {
      enabled: true,
      default: 'main',
      derived: 'worker',
      byPreset: { 'verify-x': 'verifier' },
      policyDefault: { read: ['*'], includeShared: true, includeGlobal: true },
      policies: { verifier: { read: [], includeShared: true, includeGlobal: false, kinds: ['fact', 'knowledge'] } },
    },
  }
  const { kv, byName, exec } = setup(roleConfig)
  seedRaw(kv, [
    entry({ id: 'shared', title: '共享知识', body: 'x'.repeat(100) }),
    entry({ id: 'w', kind: 'episodic', title: '工人的过程', body: 'y'.repeat(100), role: 'worker' }),
    entry({ id: 'g', kind: 'fact', title: '全局事实', body: 'z'.repeat(100), scope: 'global' }),
  ])
  const verifierExec = {
    agent: { session: { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', header: { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', cwd: CWD, delegationDepth: 1, agentPreset: 'verify-x' } } },
    signal: new AbortController().signal,
  }
  const result = await byName.get('memory_audit').execute({ topN: 10 }, verifierExec)
  assert.deepEqual(result.candidates.map((c) => c.id), ['shared'], '只看得到共享条目')
  assert.equal(result.summary.total, 1)
})

// ---------- A39 侧车轨迹 ----------

test('A39 侧车轨迹：只追加、坏行跳过、超限轮转、写失败吞错', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-audit-'))
  const trace = join(dir, 'access-trace.jsonl')

  assert.equal(await appendAccessTrace(trace, { atMs: 1, source: 'recall', ids: ['a', 'b'] }, 1_000_000), true)
  assert.equal(await appendAccessTrace(trace, { atMs: 2, source: 'auto', role: 'worker', ids: ['a'] }, 1_000_000), true)
  const text = readFileSync(trace, 'utf8')
  assert.equal(text.trim().split('\n').length, 2)

  // 坏行不抛：索引只吃合法行
  const index = parseAccessTrace(`${text}\n{ 坏行\n\n${JSON.stringify({ atMs: 3, ids: ['b'] })}`)
  assert.equal(index.get('a').hits, 2)
  assert.equal(index.get('a').lastAtMs, 2)
  assert.equal(index.get('b').hits, 2)
  assert.equal(index.get('b').lastAtMs, 3)

  // 轮转：阈值小于当前体积 → 旧文件改名 .1
  assert.equal(shouldRotate(100, 10), true)
  assert.equal(await appendAccessTrace(trace, { atMs: 4, source: 'recall', ids: ['c'] }, 10), true)
  assert.ok(existsSync(`${trace}.1`), '超限应轮转为 .1')

  // 写失败吞错（不给路径、给目录）→ false，不抛
  assert.equal(await appendAccessTrace(dir, { atMs: 5, source: 'recall', ids: ['x'] }, 0), false)
  // 空 ids 不写
  assert.equal(await appendAccessTrace(trace, { atMs: 6, source: 'recall', ids: [] }, 0), false)
})

// ---------- A40 用量项 ----------

test('A40 用量项：有轨迹时命中多的分数更高；无轨迹时 usageSource=none 且 usage 恒 0', () => {
  const e = aged(10, { id: 'e1' })
  const base = { weights: DEFAULT_AUDIT_CONFIG.weights, refs: new Map(), tagReuse: new Map(), dups: new Map(), nowMs: NOW }
  const without = scoreEntry(e, base)
  const with10 = scoreEntry(e, { ...base, usage: new Map([['e1', { hits: 10, lastAtMs: NOW }]]) })
  assert.equal(without.evidence.usage, 0)
  assert.ok(with10.score > without.score, `${with10.score} 应 > ${without.score}`)

  const noTrace = auditMemory({ entries: [e], now: NOW })
  assert.equal(noTrace.summary.usageSource, 'none')
  assert.equal(noTrace.candidates[0].evidence.usage, 0)
  const traced = auditMemory({ entries: [e], usage: new Map([['e1', { hits: 3, lastAtMs: NOW }]]), now: NOW })
  assert.equal(traced.summary.usageSource, 'trace')
  assert.equal(traced.candidates[0].evidence.usage, 3)
})

// ---------- A41 配置 ----------

test('A41 audit 配置：缺省走先验；覆盖生效；非法 fail-loud', () => {
  assert.deepEqual(parseMemoryConfig('').audit, DEFAULT_AUDIT_CONFIG)

  const cfg = parseMemoryConfig(`
audit:
  keep_recent_days: 3
  review_min_chars: 500
  weights:
    ref: 0.5
    dup: 0
  access_trace:
    enabled: false
    max_bytes: 0
`)
  assert.equal(cfg.audit.keepRecentDays, 3)
  assert.equal(cfg.audit.reviewMinChars, 500)
  assert.equal(cfg.audit.weights.ref, 0.5)
  assert.equal(cfg.audit.weights.dup, 0)
  assert.equal(cfg.audit.weights.recent, DEFAULT_AUDIT_CONFIG.weights.recent, '未覆盖项走先验')
  assert.equal(cfg.audit.accessTrace.enabled, false)
  assert.equal(cfg.audit.accessTrace.maxBytes, 0)

  assert.throws(() => parseMemoryConfig('audit:\n  weightz: {}\n'), MemoryConfigError)
  assert.throws(() => parseMemoryConfig('audit:\n  weights:\n    refz: 1\n'), MemoryConfigError)
  assert.throws(() => parseMemoryConfig('audit:\n  weights:\n    ref: -1\n'), MemoryConfigError)
  assert.throws(() => parseMemoryConfig('audit:\n  keep_recent_days: "7"\n'), MemoryConfigError)
  assert.throws(() => parseMemoryConfig('audit:\n  review_min_chars: -5\n'), MemoryConfigError)
  assert.throws(() => parseMemoryConfig('audit:\n  access_trace:\n    max_bytes: 1.5\n'), MemoryConfigError)
})

// ---------- 回归：无 audit 段的历史配置 ----------

test('A41b 无 audit 段的历史配置：auditMemory 走缺省先验，不崩', async () => {
  const legacy = {
    scope: 'workspace',
    layers: ['fact', 'knowledge', 'episodic'],
    autoSink: true,
    timeline: { day: true, week: true, month: true, year: true, archive: 'keep' },
    weeklyTemplate: '',
    maxEntries: 2000,
    inject: { enabled: true, maxBytes: 3000, maxEntries: 20 },
    autoInject: { enabled: true, maxBytes: 1500, maxEntries: 3 },
  }
  const { kv, byName, exec } = setup(legacy)
  seedRaw(kv, [entry({ id: 'x', title: '历史配置下的条目', body: 'x'.repeat(120) })])
  const result = await byName.get('memory_audit').execute({}, exec)
  assert.equal(result.summary.total, 1)
  assert.equal(result.candidates[0].bucket, 'KEEP')
})

// ---------- 只读工具不进写路径 ----------

test('A31b memory_audit 不写轨迹、不改条目（与 recall 的区别）', async () => {
  const { kv, byName, exec } = setup()
  seedRaw(kv, [entry({ id: 'e1', title: '条目', body: 'x'.repeat(50) })])
  let recorded = 0
  const tools = createMemoryTools({
    store: new MemoryStore(kv),
    loadConfig: async () => CONFIG,
    recordAccess: () => {
      recorded += 1
      return true
    },
  })
  const audit = new Map(tools.map((t) => [t.name, t])).get('memory_audit')
  await audit.execute({}, exec)
  assert.equal(recorded, 0, '体检自身不是「读到某条记忆」，不应污染用量轨迹')
})
