/**
 * §10.1 七类保留策略 · 判据（R 段）——设计正本 `docs/semantic.md` §5.32
 *
 * 这一层守的是**一个闭合**：`memType` 从「填了不改变任何行为」变成「填了会改变体检档位」。
 * 动机是实测（真分母 1770 条人工写入条目里 `memType` 覆盖率 1.1%，而 `aliases` 47.5%）
 * ——不是字段新旧，是填了有没有后果。
 *
 * 判据分工：
 *   R1 类别真的改变档位（含反向：目标档不更高就不动）· R2 回退三档可辨且不猜
 *   R3 ★零回归（`unknown` 逐字不变）· R4 画像永不自动归档 · R5 计数自洽
 *   R6 正常路径不噪音 · R7 两处同口径 · R8 只读仍成立 · R9 判据码自洽 · R10 时间语义
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  RETENTION_POLICIES,
  RETENTION_REASON_CODES,
  RETENTION_REASON_NOTES,
  UNKNOWN_EFFECTIVE_TYPE,
  applyRetentionPolicy,
  effectiveMemType,
  retentionSignal,
  retentionSummary,
} from '../lib/retention.js'
import { MEM_TYPES } from '../lib/memType.js'
import { DEFAULT_AUDIT_CONFIG, auditMemory, classify, scoreEntry } from '../lib/audit.js'
import { DEFAULT_CONFIG } from '../lib/config.js'
import { MemoryStore } from '../lib/store.js'
import { createMemoryTools } from '../lib/tools.js'
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

// ⚠ 双平台夹具纪律：`WID` 由**被测的派生函数**算出，不硬编码（POSIX 下 resolve 语义不同）
const CWD = 'C:\\Users\\Alice\\proj'
const WID = workspaceIdOf(CWD)
const NOW = Date.parse('2026-11-19T12:00:00.000Z')
const DAY = 86_400_000
const SESSION = 'session-11111111-2222-3333-4444-555555555555'

/** 条目夹具：默认 5 天前（基础档落在 KEEP 的「保新」分支） */
function entry(partial = {}) {
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

/** 基础档（模拟 classify 的返回值） */
function base(bucket, reasons = ['基础理由']) {
  return { bucket, reasons }
}

/** 工具层夹具（走真实写入面——手搓夹具的值形态与生产不符是踩过的坑） */
function setup() {
  const kv = new MemoryKv()
  const store = new MemoryStore(kv)
  const tools = createMemoryTools({
    store,
    loadConfig: async () => ({ ...DEFAULT_CONFIG, audit: DEFAULT_AUDIT_CONFIG }),
  })
  const byName = new Map(tools.map((t) => [t.name, t]))
  const exec = {
    agent: { session: { id: SESSION, header: { id: SESSION, cwd: CWD } } },
    signal: new AbortController().signal,
  }
  return { kv, store, tools, byName, exec }
}

// ---------- R1 类别真的改变档位 ----------

test('R1 ★同一条目只改 memType ⇒ 档位/理由不同（策略真的在起作用）', () => {
  // 情景记忆超 90 天：KEEP → DEMOTE（该褪色，但先降级、不直接归档）
  const epi = aged(100, { memType: 'episodic' })
  const kept = applyRetentionPolicy(epi, base('KEEP'), NOW)
  assert.equal(kept.bucket, 'DEMOTE', 'episodic 超 90 天必须从 KEEP 降到 DEMOTE')
  assert.equal(kept.applied, 'E-decay')
  assert.ok(kept.reasons.some((r) => r.includes('E-decay')), '理由行必须点名判据码')

  // 同形态但无 memType ⇒ 类未知 ⇒ 零修正（差异只来自类别，不来自年龄）
  const unknown = applyRetentionPolicy(aged(100), base('KEEP'), NOW)
  assert.equal(unknown.bucket, 'KEEP', '类未知必须原样——这就是 R3 的对照臂')
  assert.equal(unknown.applied, undefined)

  // 画像类：基础档说 ARCHIVE，类别说「长期保存」⇒ 交人裁决（REVIEW）
  const prof = applyRetentionPolicy(aged(400, { memType: 'profile' }), base('ARCHIVE'), NOW)
  assert.equal(prof.bucket, 'REVIEW', 'profile 的 ARCHIVE 必须被改成 REVIEW')
  assert.equal(prof.applied, 'F-hold')
})

test('R1b 目标档不高于基础档 ⇒ 不改档也不加理由（只往更需要人看的方向推）', () => {
  const epi = aged(100, { memType: 'episodic' })

  // 已是 REVIEW：E-decay 的目标是 DEMOTE（更低）⇒ 不动
  const already = applyRetentionPolicy(epi, base('REVIEW', ['体量超限']), NOW)
  assert.equal(already.bucket, 'REVIEW')
  assert.equal(already.applied, undefined, 'REVIEW 不能被倒着改回 DEMOTE')
  assert.equal(already.reasons.length, 1, '未改档就不加理由（同一件事不说两遍）')

  // 已是 ARCHIVE：E-decay 目标是 DEMOTE ⇒ 不动
  const arch = applyRetentionPolicy(epi, base('ARCHIVE'), NOW)
  assert.equal(arch.bucket, 'ARCHIVE')
  assert.equal(arch.applied, undefined)
})

// ---------- R2 回退三档可辨且不猜 ----------

test('R2 ★回退口径三档可辨，且 knowledge 不硬塞进任一类', () => {
  assert.deepEqual(effectiveMemType({ memType: 'procedural', kind: 'knowledge' }), {
    type: 'procedural', source: 'explicit',
  })
  assert.deepEqual(effectiveMemType({ kind: 'episodic' }), {
    type: 'episodic', source: 'derived-from-kind',
  })
  assert.deepEqual(effectiveMemType({ kind: 'fact' }), {
    type: 'semantic', source: 'derived-from-kind',
  })
  // 关键负向：knowledge 可被五类解释 ⇒ 推不出就不推
  assert.deepEqual(effectiveMemType({ kind: 'knowledge' }), { type: null, source: 'unknown' })
  assert.deepEqual(effectiveMemType({ kind: 'summary' }), { type: null, source: 'unknown' })
  // 认不出的历史值同样落到 unknown（不猜）
  assert.deepEqual(effectiveMemType({ memType: '乱写的', kind: 'knowledge' }), {
    type: null, source: 'unknown',
  })
})

test('R2b 七类策略表齐全，且只有 profile 是「永不衰减」', () => {
  for (const type of MEM_TYPES) {
    assert.ok(RETENTION_POLICIES[type] !== undefined, `${type} 必须有策略`)
    assert.ok(RETENTION_POLICIES[type].rationale.length > 0, `${type} 的策略必须写明方案出处`)
  }
  const neverDecay = MEM_TYPES.filter((type) => RETENTION_POLICIES[type].decayHalfLifeDays === null)
  assert.deepEqual(neverDecay, ['profile'], '只有画像永不衰减；null 不表达「立刻衰减」，与 0 相反')
})

// ---------- R3 ★零回归 ----------

test('R3 ★零回归：类未知条目的档位与 reasons 与 classify 逐字相同', () => {
  const cases = [
    aged(5), // 保新
    aged(400), // 归档候选（未引用 + 老 + 无 source）
    aged(2, { body: 'x'.repeat(9000) }), // 超 review_min_chars
    aged(40, { body: 'y'.repeat(600) }),
    // ⚠ 这条是 R3 的**分辨力来源**：带失效时刻的 knowledge 条目，类未知 ⇒ 必须零修正。
    // 若有人「反正推不出、给个默认 semantic 吧」，`S-expired` 会把它改成 REVIEW ⇒ 本条变红。
    // 前四条都「不触发任何策略」，所以它们证明不了「不许替 unknown 猜类别」——这一条才行。
    aged(400, { expiry: '2026-01-01' }),
  ]
  for (const item of cases) {
    const breakdown = scoreEntry(item, {
      weights: DEFAULT_AUDIT_CONFIG.weights,
      refs: new Map(),
      tagReuse: new Map(),
      dups: new Map(),
      nowMs: NOW,
    })
    const expected = classify(item, breakdown, DEFAULT_AUDIT_CONFIG)
    const actual = applyRetentionPolicy(item, expected, NOW)
    assert.equal(actual.bucket, expected.bucket, `bucket 必须逐字相同（age=${breakdown.evidence.ageDays}）`)
    assert.deepEqual(actual.reasons, expected.reasons)
    assert.equal(actual.reasons, expected.reasons, 'reasons 应当**同一个数组引用**——零回归不是「碰巧内容相同」')
    assert.equal(actual.applied, undefined)
  }
})

// ---------- R4 画像永不自动归档 ----------

test('R4 ★profile 类在体检结果里 ARCHIVE / DEMOTE 计数为 0', () => {
  const entries = [
    // ⚠ 标题必须互不相同：默认标题相同会被 `duplicateClusters` 判成近重复簇 ⇒ 全部落 REVIEW，
    // 于是「画像不许归档」变成一条**恒真**判据（自己的夹具把待测路径全遮住了）。
    aged(400, { id: 'p1', title: '画像一', memType: 'profile' }),
    aged(400, { id: 'p2', title: '画像二', memType: 'profile', body: 'z'.repeat(500) }),
    aged(400, { id: 'p3', title: '画像三', memType: 'profile', body: 'w'.repeat(1200) }),
    // 对照臂：同形态但类别是语义 ⇒ 允许 ARCHIVE（没有它，这条判据可能恒真）
    aged(400, { id: 's1', title: '语义一', memType: 'semantic' }),
  ]
  const result = auditMemory({ entries, config: DEFAULT_AUDIT_CONFIG, now: NOW })
  const byBuckets = result.candidates.reduce((acc, c) => {
    const key = `${c.effectiveType ?? 'unknown'}`
    acc[key] = acc[key] ?? { ARCHIVE: 0, DEMOTE: 0, REVIEW: 0, KEEP: 0 }
    acc[key][c.bucket] += 1
    return acc
  }, {})
  assert.equal(byBuckets.profile.ARCHIVE ?? 0, 0, '画像不许被建议归档')
  assert.equal(byBuckets.profile.DEMOTE ?? 0, 0, '画像也不许被建议降级')
  assert.ok((byBuckets.profile.REVIEW ?? 0) + (byBuckets.profile.KEEP ?? 0) > 0, '画像必须仍然出现在结果里')
  assert.equal(byBuckets.semantic.ARCHIVE, 1, '对照臂必须仍能归档，否则这条判据是恒真的')
})

// ---------- R5 计数自洽 ----------

test('R5 计数自洽：byEffectiveType / bySource 各自之和 == total', () => {
  const entries = [
    aged(1, { kind: 'episodic' }), // 推导 → episodic
    aged(1, { kind: 'fact' }), // 推导 → semantic
    aged(1), // knowledge ⇒ unknown
    aged(1, { memType: 'operational', kind: 'knowledge' }), // 显式 operational
    entry({ kind: 'summary', level: 'day' }), // unknown
  ]
  const summary = retentionSummary(entries, NOW)
  assert.equal(
    Object.values(summary.byEffectiveType).reduce((a, b) => a + b, 0),
    entries.length,
    'byEffectiveType 之和必须 == total（既不漏也不重）',
  )
  assert.equal(
    Object.values(summary.bySource).reduce((a, b) => a + b, 0),
    entries.length,
    'bySource 之和必须 == total',
  )
  assert.equal(summary.byEffectiveType.episodic, 1, 'kind=episodic 推导成 episodic')
  assert.equal(summary.byEffectiveType.semantic, 1, 'kind=fact 推导成 semantic')
  assert.equal(summary.byEffectiveType.operational, 1, '显式 operational 不被推导盖掉')
  assert.equal(summary.byEffectiveType[UNKNOWN_EFFECTIVE_TYPE], 2, 'knowledge + summary 都推不出')
  assert.equal(summary.bySource.explicit, 1)
  assert.equal(summary.bySource['derived-from-kind'], 2)
  assert.equal(summary.bySource.unknown, 2)
})

test('R5b needsAction 只数触发信号的条目，unknown 不计', () => {
  const entries = [
    aged(100, { kind: 'episodic' }), // E-decay
    aged(5), // 不触发（且类未知）
  ]
  const summary = retentionSummary(entries, NOW)
  assert.equal(summary.needsAction.episodic, 1, '超 90 天的情景记一条')
  assert.equal(
    Object.values(summary.needsAction).reduce((a, b) => a + b, 0),
    1,
    'unknown 不参与 needsAction（它没有类别节奏）',
  )
})

// ---------- R6 正常路径不噪音 ----------

test('R6 ★正常路径不出类别判据码', () => {
  const clean = applyRetentionPolicy(entry({ memType: 'semantic' }), base('KEEP'), NOW)
  assert.equal(clean.applied, undefined)
  assert.equal(clean.reasons.length, 1)
  assert.ok(!clean.reasons.some((r) => r.includes('类别修正')), '没触发就不许出现理由行')

  const result = auditMemory({
    entries: [entry({ id: 'ok', memType: 'semantic' })],
    config: DEFAULT_AUDIT_CONFIG,
    now: NOW,
  })
  const candidate = result.candidates.find((c) => c.id === 'ok')
  assert.equal(candidate.retentionCode, undefined, '未改档的候选不许带 retentionCode')
  assert.ok(!candidate.reasons.some((r) => r.includes('类别修正')))
  assert.equal(result.retention.policyApplied.total, 0, '没有改档 ⇒ policyApplied.total 必须是 0')
})

test('R6b 改档才计入 policyApplied，且按判据码分桶', () => {
  const result = auditMemory({
    entries: [
      aged(400, { id: 'a', title: '画像甲', memType: 'profile' }), // ARCHIVE → REVIEW（F-hold）
      // ⚠ b 必须带 role：`archive_min_age_days` 缺省 14 ⇒ 无 role/refs 的老条目基础档已是
      // ARCHIVE，E-decay 的目标 DEMOTE 比它低 ⇒ 不改档（R1b 正是这条）。所以 E-decay 的真实
      // 可达路径是「有归属或承重的老情景记忆」——这一点写进 §5.32 的边界。
      aged(100, { id: 'b', title: '情景乙', memType: 'episodic', role: 'root' }), // KEEP → DEMOTE（E-decay）
      aged(5, { id: 'c', title: '语义丙', memType: 'semantic' }), // 不动
    ],
    config: DEFAULT_AUDIT_CONFIG,
    now: NOW,
  })
  assert.equal(result.retention.policyApplied.total, 2)
  assert.equal(result.retention.policyApplied.byCode['F-hold'], 1)
  assert.equal(result.retention.policyApplied.byCode['E-decay'], 1)
})

// ---------- R7 两处同口径 ----------

test('R7 ★memory_stats.retention 与 memory_audit.retention 同源（同一批输入逐字段相等）', async () => {
  const { byName, exec } = setup()
  await byName.get('remember').execute({ text: '种一条情景记忆的种子文本，用来验证两处统计口径一致', kind: 'episodic' }, exec)
  await byName.get('remember').execute({ text: '种一条事实记忆的种子文本，用来验证两处统计口径一致', kind: 'fact' }, exec)
  await byName.get('remember').execute({ text: '种一条知识记忆的种子文本，用来验证两处统计口径一致', kind: 'knowledge' }, exec)

  const stats = await byName.get('memory_stats').execute({}, exec)
  const audit = await byName.get('memory_audit').execute({ topN: 50 }, exec)
  // stats 吃含归档全量、audit 吃本次集合（剔归档 + 跳过冷存档）；三条都活跃且无冷存档标签 ⇒ 同集合。
  assert.deepEqual(audit.retention.byEffectiveType, stats.retention.byEffectiveType,
    'byEffectiveType 必须逐字段相等（retentionSummary 是唯一实现）')
  assert.deepEqual(audit.retention.bySource, stats.retention.bySource)
  assert.deepEqual(audit.retention.needsAction, stats.retention.needsAction)
  assert.equal(stats.retention.bySource['derived-from-kind'], 2, '两条推导（episodic + fact）')
  assert.equal(stats.retention.bySource.unknown, 1, '一条 knowledge 推不出')
})

// ---------- R8 只读仍成立 ----------

test('R8 ★体检只读：跑前跑后存储逐字节不变（含 accessedAt）', async () => {
  const { kv, byName, exec } = setup()
  await byName.get('remember').execute({ text: '只读判据用的种子条目正文，内容本身无关紧要', kind: 'knowledge' }, exec)

  const snap = () => JSON.stringify([...kv.entries()].sort(([a], [b]) => (a < b ? -1 : 1)))
  const before = snap()
  await byName.get('memory_audit').execute({}, exec)
  await byName.get('memory_stats').execute({}, exec)
  assert.equal(snap(), before, '体检 + 统计都必须只读：存储逐字节不变（含 accessedAt）')
})

// ---------- R9 判据码自洽 ----------

test('R9 五个判据码各自可触发，且理由行点名它自己', () => {
  assert.deepEqual(
    [...RETENTION_REASON_CODES].sort(),
    ['E-decay', 'F-hold', 'O-stale', 'P-verify', 'S-expired'],
  )

  const cases = [
    ['E-decay', aged(100, { memType: 'episodic' }), 'KEEP'],
    ['S-expired', aged(400, { memType: 'semantic', expiry: '2026-01-01' }), 'KEEP'],
    ['P-verify', aged(400, { memType: 'procedural', watchFor: ['工具换版本'], reviewAfter: '2026-01-01' }), 'KEEP'],
    ['O-stale', aged(20, { memType: 'operational' }), 'KEEP'],
    ['F-hold', aged(400, { memType: 'profile' }), 'ARCHIVE'],
  ]
  for (const [code, item, baseBucket] of cases) {
    const verdict = applyRetentionPolicy(item, base(baseBucket), NOW)
    assert.equal(verdict.applied, code, `${code} 应当在该构造下触发`)
    assert.ok(
      verdict.reasons.some((r) => r.includes(code)),
      `${code} 的理由行必须点名它自己（否则人看到一句散文、拼不回判据码）`,
    )
    assert.equal(RETENTION_REASON_NOTES[code].includes(code), true, '文案里要有判据码，便于 grep')
  }
})

// ---------- R11 信号数与改档数可区分 ----------

test('R11 ★信号数与改档数可区分：needsAction 有读数时 policyApplied 仍可为 0', () => {
  // 线上实测形态（2026-11-19 15:06）：库里 needsAction.episodic=47 而 policyApplied=0。
  // 不是 bug，是同一条配置耦合的两面：age>90 且无 role/refs ⇒ 基础档已 ARCHIVE，
  // 而修正层的 E-decay 目标是 DEMOTE（更低）⇒ 不改档。两个数回答不同问题。
  const result = auditMemory({
    entries: [
      aged(100, { id: 'sig', kind: 'episodic' }),
      aged(400, { id: 'arc', title: '归档对照臂', kind: 'knowledge' }),
    ],
    config: DEFAULT_AUDIT_CONFIG,
    now: NOW,
  })
  assert.equal(result.retention.needsAction.episodic, 1, '信号必须被计到（该按情景节奏看一眼）')
  assert.equal(result.retention.policyApplied.total, 0, '基础档已是 ARCHIVE ⇒ 没有任何档位被改')
  assert.equal(
    result.candidates.find((c) => c.id === 'sig').bucket,
    'ARCHIVE',
    '条目本身仍落 ARCHIVE——信号存在不等于档位要变',
  )
})

// ---------- R10 时间语义 ----------

test('R10 时间语义：边界是严格大于、未设 ≠ 未失效、有锚点就不按时间催', () => {
  // episodic：90 天是边界（> 不是 >=）
  assert.equal(retentionSignal(aged(90, { kind: 'episodic' }), NOW), undefined, '恰好 90 天不触发')
  assert.equal(retentionSignal(aged(91, { kind: 'episodic' }), NOW)?.code, 'E-decay')

  // semantic：只有「已失效」才触发；未设 expiry 是「不知道」不是「还没失效」
  assert.equal(retentionSignal(aged(400, { kind: 'fact' }), NOW), undefined, '未设失效时刻不催')
  assert.equal(retentionSignal(aged(400, { kind: 'fact', expiry: '2026-01-01' }), NOW)?.code, 'S-expired')

  // operational：14 天 + 无 watchFor；写了观察条件就不按时间催
  assert.equal(retentionSignal(aged(20, { memType: 'operational' }), NOW)?.code, 'O-stale')
  assert.equal(
    retentionSignal(aged(20, { memType: 'operational', watchFor: ['工具换版本'] }), NOW),
    undefined,
    '我已写好「什么会让它失效」的锚点，就不该再拿时间催',
  )

  // procedural：必须有 watchFor 且 reviewAfter 已过（没锚点拿时间催只是噪音）
  assert.equal(retentionSignal(aged(400, { memType: 'procedural' }), NOW), undefined)
  assert.equal(
    retentionSignal(aged(400, { memType: 'procedural', watchFor: ['x'], reviewAfter: '2026-01-01' }), NOW)?.code,
    'P-verify',
  )

  // project / relational / profile：本版无条目自身触发条件
  for (const memType of ['project', 'relational', 'profile']) {
    assert.equal(retentionSignal(aged(999, { memType }), NOW), undefined, `${memType} 本版不由条目时间触发`)
  }
})
