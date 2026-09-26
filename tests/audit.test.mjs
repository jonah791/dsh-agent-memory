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
import { workspaceIdOf } from '../lib/scope.js'

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

// ⚠ 双平台夹具纪律（技能 dsh-plugin-testability）：`WID` 由**被测的派生函数**算出，
// 不硬编码——POSIX（WSL）下 `resolve()` 语义不同，硬编码会让作用域不匹配、整组用例静默 0 命中。
const CWD = 'C:\\Users\\Alice\\proj'
const WID = workspaceIdOf(CWD)
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

test('A42 工具面：memory_audit 已注册（共 14 个工具）', () => {
  const { byName } = setup()
  assert.equal(byName.size, 14)
  assert.ok(byName.has('memory_audit'))
  assert.ok(byName.get('memory_audit').description.includes('只读'))
  // v0.9：合并原语进工具面（近重复簇从「只标记」到「可执行」）
  assert.ok(byName.has('memory_merge'))
  // v0.11.2：裁决留痕原语进工具面（体检候选从「每次重报」到「可标记已审」）
  assert.ok(byName.has('memory_review_mark'))
  // v0.11.3：重压原语进工具面（超预算概要从「看得见」到「改得动」）
  assert.ok(byName.has('memory_recompress'))
})

// ---------- A54 已裁决标记（v0.11.2） ----------

test('A54 已裁决标记：命中 ⇒ 归 KEEP 并标注；条目再变动 ⇒ 自动重新纳入（防永久免检）', () => {
  // ★ 刻意取一个「**UTC 日 ≠ 本地日**」的时刻（本地 09-15 04:00 = UTC 09-14 20:00）：
  //   这样 v0.11.4 的「本地日期渲染」断言才有**分辨力**——若实现退回 toISOString（UTC），
  //   理由里会显示 09-14 而断言期待本地日 09-15 ⇒ **必红**。
  //   （最初用 NOW-1d 时两者同一天，断言恒真 = 无分辨力；判据要会亮。）
  //   ⚠ 在 UTC 机器上本地日 = UTC 日，该断言退化为恒真——但它仍正确，只是无差可测。
  const reviewedAt = Date.parse('2026-09-14T20:00:00.000Z')
  const target = aged(30, { id: 'marked', title: '已裁决的超大条目', body: 'x'.repeat(15000) })
  const stale = aged(0.5, { id: 'changed', title: '裁决后又被改过的条目', body: 'x'.repeat(15000) })

  // ① 基线：无标记时，体量 ≥ review_min_chars ⇒ REVIEW
  const before = auditMemory({ entries: [target], now: NOW })
  assert.equal(before.candidates[0].bucket, 'REVIEW')

  // ② 有标记且条目**未变动** ⇒ 归 KEEP + 理由点名「已裁决」
  const reviewed = new Map([['marked', reviewedAt]])
  const after = auditMemory({ entries: [target], reviewed, now: NOW })
  const hit = after.candidates.find((c) => c.id === 'marked')
  assert.equal(hit.bucket, 'KEEP', '已裁决 ⇒ 保持现状（KEEP）')
  assert.ok(hit.reasons[0].includes('已裁决'), `理由应点名已裁决，实得：${hit.reasons[0]}`)
  // ★ 本地日期渲染（v0.11.4）：断言「理由里的日期 = 标记时刻的**本地**日」。
  //   刻意不硬编码日期——那会让夹具依赖运行平台的时区（UTC 机器上会差一天，
  //   违反技能 dsh-plugin-testability 的「夹具不得依赖运行平台」纪律）。
  const md = new Date(reviewedAt)
  const p2 = (n) => String(n).padStart(2, '0')
  const localDay = `${md.getFullYear()}-${p2(md.getMonth() + 1)}-${p2(md.getDate())}`
  assert.ok(
    hit.reasons[0].includes(localDay),
    `理由里的日期应是本地日 ${localDay}（用 toISOString 会显示成 UTC 日），实得：${hit.reasons[0]}`,
  )
  // 对账不变量（A37）不破：候选仍在（★ 刻意不剔除，否则 candidates 与 byBucket 会对不上）
  assert.equal(after.candidates.length, 1, '★ 已裁决的条目仍出现在候选里（只是改判 KEEP）')
  assert.equal(after.summary.chars, target.body.length, '各档字符合计仍等于总量')

  // ③ 尸体样本（防「已审」变永久免检）：条目在标记**之后**被改过 ⇒ 标记自动失效、照常分档
  const reviewedBoth = new Map([['marked', reviewedAt], ['changed', reviewedAt]])
  const revived = auditMemory({ entries: [stale], reviewed: reviewedBoth, now: NOW })
  const back = revived.candidates.find((c) => c.id === 'changed')
  assert.equal(back.bucket, 'REVIEW', '★ updatedAt 晚于标记时刻 ⇒ 重新纳入常规分档')
  assert.ok(!back.reasons[0].includes('已裁决'), '失效的标记不该留下已裁决字样')

  // ④ 对照：同一批里没被标记的同类条目不受影响（判据不越界）
  const other = aged(30, { id: 'plain', title: '普通超大条目', body: 'x'.repeat(15000) })
  const mixed = auditMemory({ entries: [target, other], reviewed, now: NOW })
  assert.equal(mixed.candidates.find((c) => c.id === 'plain').bucket, 'REVIEW')
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

// ---------- A44 归档条目不参与重复簇（v0.11.1 修复） ----------

test('A53 归档条目不参与重复簇判定：双活跃同名仍抓，活跃 vs 已归档不误报', () => {
  // 正样本：两条**都活跃**且同标题 ⇒ 仍是真重复，该判同簇
  const liveOld = aged(20, { id: 'live-old', title: '同一个标题' })
  const liveNew = aged(1, { id: 'live-new', title: '同一个标题' })
  const liveDups = duplicateClusters([liveOld, liveNew])
  assert.equal(liveDups.get('live-old').cluster, liveDups.get('live-new').cluster, '双活跃同名 ⇒ 仍判同簇')
  assert.equal(liveDups.get('live-old').canonicalId, 'live-new', 'canonical 仍取最新者')

  // 尸体样本（本次修复的形状）：「活跃 vs 已归档同名」**不是**重复——
  // 归档那条是被时间压缩吸收的原料，活跃的是幸存副本，当前终态本就正确。
  const survivor = aged(20, { id: 'survivor', title: '前身留下的同名条目' })
  const absorbed = aged(40, { id: 'absorbed', title: '前身留下的同名条目', archived: true })
  assert.equal(duplicateClusters([survivor, absorbed]).size, 0, '★ 归档者不参与 ⇒ 不产生簇')

  // 端到端：活跃那条不该因「与已归档者同名」被判 REVIEW
  const result = auditMemory({ entries: [survivor, absorbed], now: NOW })
  const found = result.candidates.find((c) => c.id === 'survivor')
  assert.notEqual(found.bucket, 'REVIEW', `不应因已归档同名进 REVIEW，实得：${(found.reasons ?? []).join('；')}`)

  // 对照（防「修过头」）：两条都活跃时，端到端仍须判 REVIEW —— 真重复的检测力没被削弱
  const liveResult = auditMemory({ entries: [liveOld, liveNew], now: NOW })
  for (const candidate of liveResult.candidates) {
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

// ---------- A43 概要超预算（v0.11.0 判据 + 双向对照） ----------

test('A43 概要超预算 → REVIEW：判据专属 summary，且用概要自己的尺子（summary_max_chars）', () => {
  const auditOne = (e) => auditMemory({ entries: [e], now: NOW }).candidates.find((c) => c.id === e.id)

  // ① 尸体样本（正）：summary 且 7000 字 > 预算 6000，但**未达**通用门槛 12000。
  //    没有这条判据时它会滑到 KEEP(新)/DEMOTE——超预算却无人知会（2026-09-26 实测缺口）。
  const over = auditOne(entry({ id: 'over', kind: 'summary', title: '月概要 超预算', body: 'x'.repeat(7000) }))
  assert.equal(over.bucket, 'REVIEW')
  assert.ok(
    over.reasons[0].includes('概要超预算'),
    `理由应点名超预算（而非笼统「体量大」），实得：${over.reasons[0]}`,
  )

  // ② 对照组：**同样 7000 字**但 kind=knowledge——预算判据不得越界管普通条目。
  //    否则「摘要预算」会伪装成全局体量门槛，把一切条目的门槛一并收紧。
  const plain = auditOne(entry({ id: 'plain', title: '普通条目 同长度', body: 'x'.repeat(7000) }))
  assert.notEqual(plain.bucket, 'REVIEW')

  // ③ 对照组：summary 但在预算内（5000 < 6000）——不得因预算进 REVIEW。
  const within = auditOne(entry({ id: 'within', kind: 'summary', title: '日概要 预算内', body: 'x'.repeat(5000) }))
  assert.notEqual(within.bucket, 'REVIEW')
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
  // ⚠ 不断言具体桶：桶是「真实 now − 夹具 createdAt」的函数，会随时间漂移。
  //   本条曾写死 'KEEP'（写测试时 age≈5 ≤ keep_recent_days 7）；11 天后 age=16 ≥ archive_min_age_days(14)
  //   且无 source ⇒ 正确判 ARCHIVE ⇒ **假红**。这不是实现 bug，是**判据把时间相关的结果写死了**。
  //   （本文件其余桶断言都不脆：它们直接调 auditMemory({ …, now: NOW }) 注入了固定时钟；
  //     而这里走的是工具层，工具不接 now —— 结构差异就是脆性的来源。）
  //   改为断言「缺省先验真的被用上」：14 / 7 / 3000 这三个数值只可能来自 DEFAULT_AUDIT_CONFIG。
  const why = result.candidates[0].reasons.join(' · ')
  assert.match(
    why,
    /archive_min_age_days\(14\)|keep_recent_days 7|demote_min_chars\(3000\)/,
    `分档理由须引用缺省先验的数值（证明历史配置回落到 DEFAULT_AUDIT_CONFIG），实际：${why}`,
  )
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

// ---------- A44 索引范围：「看不见」≠「没有」 ----------

test('A44 索引范围：默认视图不含归档 ⇒ 如实报出「另有 N 条承重原料不在集合内」', async () => {
  const { kv, byName, exec } = setup()
  const raw = aged(30, { id: 'raw', title: '归档原料', body: 'x'.repeat(300), archived: true })
  const summaryEntry = entry({ id: 'sum', kind: 'summary', title: '日概要', level: 'day', bucket: '2026-08-01', archiveRef: ['raw'] })
  seedRaw(kv, [raw, summaryEntry])

  const defaultView = await byName.get('memory_audit').execute({}, exec)
  assert.equal(defaultView.summary.total, 1, '默认视图不含归档')
  assert.equal(defaultView.summary.referenced, 0, '集合内确实没有承重条目')
  assert.ok(
    defaultView.notes.some((n) => n.startsWith('另有 1 条承重原料')),
    '必须如实报出集合之外（已归档）的承重原料——否则「承重 0」会被误读成「没有承重原料」',
  )

  const withArchive = await byName.get('memory_audit').execute({ includeArchive: true }, exec)
  assert.equal(withArchive.summary.total, 2)
  assert.equal(withArchive.summary.referenced, 1)
  assert.ok(!withArchive.notes.some((n) => n.startsWith('另有')), '全量视图下不该再报「另有」')
})
