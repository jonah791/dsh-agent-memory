/**
 * R7 失效误用的严格上限（v0.46）· 判据——设计正本 `docs/design/aml-r7-cap.md`
 *
 * 这一层守三件事：
 * ① **上限有分辨力**（C1/C2/C3 三档各能变红，且各自的误报率可算）；
 * ② **分子不混入「我要求看归档」**（`includeArchive` 分层——旧口径 38 条里 9 条是假阳性）；
 * ③ **样本不足不伪装成健康**（`inconclusive` 不是 `ok`）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  R7_BASELINE_RATE,
  R7_CUMULATIVE_CAP,
  classifyReturn,
  misuseReport,
  worstVerdict,
} from '../lib/misuse.js'
import { DEFAULT_CONFIG } from '../lib/config.js'
import { MemoryStore } from '../lib/store.js'
import { createMemoryTools } from '../lib/tools.js'
import { workspaceIdOf } from '../lib/scope.js'

const CWD = 'C:\\Users\\Alice\\proj'
const WID = workspaceIdOf(CWD)
const SESSION = 'session-11111111-2222-3333-4444-555555555555'
const NOW = Date.parse('2026-11-19T12:00:00.000Z')
const DAY = 86_400_000

function entry(partial = {}) {
  const created = partial.createdAt ?? new Date(NOW - 30 * DAY).toISOString()
  return {
    id: partial.id ?? 'e',
    kind: partial.kind ?? 'knowledge',
    title: partial.title ?? '条目',
    body: partial.body ?? '正文',
    tags: partial.tags ?? [],
    scope: partial.scope ?? WID,
    createdAt: created,
    updatedAt: partial.updatedAt ?? created,
    accessedAt: partial.accessedAt ?? created,
    level: null,
    bucket: null,
    archived: false,
    ...partial,
  }
}

/** 造一条返回记录（`includeArchive` 省略 = 历史记录，不可分辨） */
function rec(atMs, ids, extra = {}) {
  return { atMs, source: 'recall', ids, ...extra }
}

/** 重复 n 条记录，每条都返回同一个 id（用于把分母撑到指定规模） */
function repeat(count, id, atMs = NOW - DAY, extra = {}) {
  return Array.from({ length: count }, () => rec(atMs, [id], extra))
}

const SUPERSEDED = entry({ id: 'sup', supersededBy: 'newer' })
const ARCHIVED_REFUTED = entry({ id: 'ref', archived: true, archivedReasonType: 'refuted', updatedAt: new Date(NOW - 20 * DAY).toISOString() })
const ARCHIVED_PLAIN = entry({ id: 'arc', archived: true, updatedAt: new Date(NOW - 20 * DAY).toISOString() })
const NORMAL = entry({ id: 'ok' })
const REVIEW_OVERDUE = entry({ id: 'rev', reviewAfter: new Date(NOW - 40 * DAY).toISOString() })

function windows(report) {
  return Object.fromEntries(report.windows.map((w) => [w.label, w]))
}

// ---------- C 段：纯函数判据 ----------

test('C1 ★自动注入通道零容忍：1 条即 breach，且 reason 指向机制而非容忍度', () => {
  const report = misuseReport({
    entries: [SUPERSEDED],
    records: [rec(NOW - DAY, ['sup'], { source: 'auto', includeArchive: false })],
    now: NOW,
  })
  const all = windows(report).all
  assert.equal(all.autoTierA, 1)
  assert.equal(all.verdict, 'breach', 'auto 通道出现误用必须直接红')
  assert.match(all.verdictReason, /自动注入/, 'reason 必须说清是哪条通道')
  assert.match(all.verdictReason, /机制/, 'reason 必须指向机制问题（该路径不经过调用方判断）')
})

test('C2 自动注入 0 条 ⇒ 不得由 C1 触发（同一批数据换通道即不红）', () => {
  const entries = [SUPERSEDED]
  const autoReport = misuseReport({ entries, records: [rec(NOW - DAY, ['sup'], { source: 'recall', includeArchive: false })], now: NOW })
  const autoWin = windows(autoReport)
  assert.equal(autoWin.all.autoTierA, 0, 'recall 通道不计入 autoTierA')
  assert.notEqual(autoWin.all.verdictReason.includes('自动注入'), true, '不得报自动注入')
})

test('C3 ★includeArchive 分层：同一条归档条目，切换标志必须改变分子', () => {
  const entries = [ARCHIVED_PLAIN]
  const withFlag = misuseReport({ entries, records: [rec(NOW - DAY, ['arc'], { includeArchive: true })], now: NOW })
  const withoutFlag = misuseReport({ entries, records: [rec(NOW - DAY, ['arc'], { includeArchive: false })], now: NOW })
  const legacy = misuseReport({ entries, records: [rec(NOW - DAY, ['arc'])], now: NOW })

  assert.equal(windows(withFlag).all.tierA, 0, '显式要求看归档 ⇒ 不计入误用')
  assert.equal(windows(withFlag).all.tierAExplicit, 1)
  assert.equal(windows(withoutFlag).all.tierA, 1, '不允许归档却返回了 ⇒ 计入误用')
  assert.equal(windows(withoutFlag).all.tierAExplicit, 0)
  assert.equal(windows(legacy).all.tierA, 1, '历史记录（无标志）沿用旧口径计入分子——不猜')
  assert.equal(windows(legacy).all.unresolved, 1, '历史记录必须单列为「不可分辨」')
})

test('C4 已被取代不受 includeArchive 豁免（它比「已归档」更具体）', () => {
  const tier = classifyReturn(SUPERSEDED, NOW, true)
  assert.equal(tier.kind, 'tierA', 'includeArchive 的语义是「包含已归档」，不是「包含已被新结论顶掉的」')
  assert.equal(tier.reason, '已被取代')
})

test('C5 返回之后才归档 ⇒ 不计入（时间线证明当时仍有效）', () => {
  const later = entry({ id: 'later', archived: true, updatedAt: new Date(NOW - DAY).toISOString() })
  const tier = classifyReturn(later, NOW - 5 * DAY, false)
  assert.equal(tier.kind, 'afterReturn')
})

test('C6 B 档（过复查死线）单列，不计入误用', () => {
  const report = misuseReport({ entries: [REVIEW_OVERDUE], records: [rec(NOW - DAY, ['rev'], { includeArchive: false })], now: NOW })
  const all = windows(report).all
  assert.equal(all.tierB, 1)
  assert.equal(all.tierA, 0)
})

test('C7 轨迹里已查不到的 id 计入 gone，不计入误用', () => {
  const report = misuseReport({ entries: [NORMAL], records: [rec(NOW - DAY, ['ghost'], { includeArchive: false })], now: NOW })
  assert.equal(windows(report).all.gone, 1)
  assert.equal(windows(report).all.tierA, 0)
})

test('C8 ★C2 累计上限：率超 0.40% ⇒ breach；恰在线上 ⇒ 不判红（判据是 > 不是 ≥）', () => {
  const over = misuseReport({ entries: [ARCHIVED_PLAIN], records: repeat(1000, 'arc', NOW - DAY, { includeArchive: false }), now: NOW })
  assert.ok(windows(over).all.rate > R7_CUMULATIVE_CAP)
  assert.equal(windows(over).all.verdict, 'breach')
  assert.match(windows(over).all.verdictReason, /累计率/)
  // 4/1000 = 0.4% 恰在线上：不得因 C2 判红（> 而非 ≥）
  const boundary = misuseReport({
    entries: [ARCHIVED_PLAIN, NORMAL],
    records: [...repeat(4, 'arc', NOW - DAY, { includeArchive: false }), ...repeat(996, 'ok', NOW - DAY, { includeArchive: false })],
    now: NOW,
  })
  assert.ok(Math.abs(windows(boundary).all.rate - 0.004) < 1e-12, '边界样本的率必须恰为 0.004')
  assert.notEqual(windows(boundary).all.verdict, 'breach', '恰在上限上不得判红（判据是 >）')
})

test('C9 ★C3 泊松三区间：红线 breach / 黄线 warn / 线下 ok 各取一个样本', () => {
  // 用 7 天窗口测 C3——C2（累计上限）只在 label='all' 生效，拿累计窗测会把两条规则混在一起
  // （实测踩过：k=10/2000 的率 0.5% 先撞 C2，走不到泊松分支）。
  // n=8000 ⇒ λ=21.37 σ=4.62 红线≈35.24 黄线≈30.62
  const build = (k) => {
    const bad = repeat(k, 'arc', NOW - 3 * DAY, { includeArchive: false })
    const good = repeat(8000 - k, 'ok', NOW - 3 * DAY, { includeArchive: false })
    return windows(misuseReport({ entries: [ARCHIVED_PLAIN, NORMAL], records: [...bad, ...good], now: NOW }))['7d']
  }
  assert.equal(build(36).verdict, 'breach', 'k=36 应过红线')
  assert.match(build(36).verdictReason, /红线/, '红线判定的 reason 必须点名红线')
  assert.equal(build(33).verdict, 'warn', 'k=33 应在黄线与红线之间')
  assert.match(build(33).verdictReason, /黄线/)
  assert.equal(build(30).verdict, 'ok', 'k=30 应在线下')
  assert.ok(build(36).breachAt !== null && build(36).warnAt !== null)
})

test('C10 ★C4 样本不足 ⇒ inconclusive，绝不报 ok', () => {
  const small = windows(misuseReport({ entries: [NORMAL], records: repeat(100, 'ok', NOW - DAY, { includeArchive: false }), now: NOW })).all
  assert.equal(small.verdict, 'inconclusive', 'λ<3 时分不清真恶化与噪声，报 ok 会让「什么都没测」看起来像「一切正常」')
  assert.match(small.verdictReason, /样本不足/)
  assert.equal(small.warnAt, null, 'λ 不足时黄线不出现（省略 ≠ 0）')
})

test('C11 C6 可分辨度：resolvable + unresolved 必须等于 returns', () => {
  const report = misuseReport({
    entries: [ARCHIVED_PLAIN, NORMAL],
    records: [
      rec(NOW - DAY, ['arc'], { includeArchive: false }),
      rec(NOW - DAY, ['ok']),
      rec(NOW - DAY, ['ok'], { includeArchive: true }),
    ],
    now: NOW,
  })
  const all = windows(report).all
  assert.equal(all.returns, 3)
  assert.equal(all.resolvable, 2)
  assert.equal(all.unresolved, 1)
  assert.equal(all.resolvable + all.unresolved, all.returns, '两种加总必须对齐总数，否则「不可分辨」会被藏起来')
  assert.equal(report.considered.fullyResolvable, false)
})

test('C12 C7 构成之和 == A 档总数', () => {
  const report = misuseReport({
    entries: [SUPERSEDED, ARCHIVED_REFUTED, ARCHIVED_PLAIN, NORMAL],
    records: [
      rec(NOW - DAY, ['sup', 'ref', 'arc', 'ok'], { includeArchive: false }),
    ],
    now: NOW,
  })
  const all = windows(report).all
  const sum = Object.values(all.byReason).reduce((a, b) => a + b, 0)
  assert.equal(all.tierA, 3)
  assert.equal(sum, all.tierA, '构成之和与总数不符 ⇒ 有一类误用被藏起来了')
})

test('C13 窗口隔离：7 天窗不统计 10 天前的返回', () => {
  const report = misuseReport({
    entries: [ARCHIVED_PLAIN, NORMAL],
    records: [
      rec(NOW - 3 * DAY, ['arc'], { includeArchive: false }),
      rec(NOW - 10 * DAY, ['arc'], { includeArchive: false }),
      rec(NOW - 40 * DAY, ['arc'], { includeArchive: false }),
    ],
    now: NOW,
  })
  const w = windows(report)
  assert.equal(w['7d'].returns, 1)
  assert.equal(w['30d'].returns, 2)
  assert.equal(w.all.returns, 3)
})

test('C14 空轨迹 ⇒ 不是「零误用」，是「没有数据」', () => {
  const report = misuseReport({ entries: [NORMAL], records: [], now: NOW })
  assert.equal(windows(report).all.returns, 0)
  assert.ok(report.notes.some((note) => note.includes('没有数据')), '空轨迹必须显式说「没有数据」')
  assert.equal(worstVerdict(['ok', 'inconclusive', 'warn', 'breach']), 'breach', '最严重者胜出')
  assert.equal(worstVerdict(['ok', 'inconclusive']), 'inconclusive', 'inconclusive 重于 ok')
})

test('C15 C8 breach 时 reason 必须带方向（构成可读）', () => {
  const entries = [SUPERSEDED]
  const report = misuseReport({
    entries,
    records: [rec(NOW - DAY, ['sup'], { source: 'auto', includeArchive: false })],
    now: NOW,
  })
  const all = windows(report).all
  assert.equal(all.verdict, 'breach')
  assert.ok(Object.keys(all.byReason).length > 0, '构成必须非空，否则读者不知道去查什么')
  assert.ok(all.verdictReason.length > 10, 'reason 不能只是「红了」')
})

test('C16 基线常量就是实测值（防止未来「悄悄重标」）', () => {
  assert.equal(R7_BASELINE_RATE.toFixed(6), (38 / 14226).toFixed(6))
  assert.equal(R7_CUMULATIVE_CAP, 0.004)
})

// ---------- E 段：工具层 ----------

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

function setup(deps = {}) {
  const kv = new MemoryKv()
  const store = new MemoryStore(kv)
  const tools = createMemoryTools({ store, loadConfig: async () => DEFAULT_CONFIG, ...deps })
  const byName = new Map(tools.map((t) => [t.name, t]))
  const exec = {
    agent: { session: { id: SESSION, header: { id: SESSION, cwd: CWD } } },
    signal: new AbortController().signal,
  }
  return { kv, store, byName, exec }
}

test('E1 ★memory_misuse 注册为按需加载，且返回键全在 schema 内', async () => {
  const { byName, exec } = setup({ readAccessRecords: async () => [] })
  const tool = byName.get('memory_misuse')
  assert.ok(tool !== undefined, 'memory_misuse 必须注册')
  assert.equal(tool.deferLoading, true, '按需加载：不占常驻 schema')

  const value = await tool.execute({}, exec)
  const schemaProps = new Set(Object.keys(tool.output.schema.properties ?? {}))
  for (const key of Object.keys(value)) {
    assert.ok(schemaProps.has(key), `返回键 ${key} 未在 output.schema 声明 ⇒ 宿主会整条拒收`)
  }
  assert.equal(value.wired, true, '读到了空数组 ≠ 未接线')
})

test('E2 ★未接线 ⇒ wired:false + 明说「不是零误用」', async () => {
  const { byName, exec } = setup() // 不给 readAccessRecords
  const value = await byName.get('memory_misuse').execute({}, exec)
  assert.equal(value.wired, false)
  assert.equal(value.verdict, 'inconclusive', '未接线不得报 ok')
  assert.ok(value.notes.some((note) => note.includes('不是「零误用」')), '必须点名「不是零误用」')
  assert.equal(value.windows.length, 0)
})

test('E3 ★工具只读：跑前后存储逐字节不变；分层在工具层同样生效', async () => {
  const { kv, store, byName, exec } = setup({
    readAccessRecords: async () => {
      // 用 store 里真实的条目 id 造记录（remember 生成的 uuid 不可预知）
      const ids = store.list(WID).map((entry) => entry.id)
      return ids.map((id) => ({ atMs: NOW - DAY, source: 'recall', ids: [id], includeArchive: false }))
    },
  })
  await byName.get('remember').execute({ text: '知识地图与误用读数共用的种子条目，带判据标签', tags: ['判据'] }, exec)
  await byName.get('remember').execute({ text: '第二条种子条目，用于确认分母随条目数增长', tags: ['判据'] }, exec)

  const snap = () => JSON.stringify([...kv.entries()].sort(([a], [b]) => (a < b ? -1 : 1)))
  const before = snap()
  const value = await byName.get('memory_misuse').execute({}, exec)
  assert.equal(snap(), before, 'memory_misuse 必须只读：存储逐字节不变（含 accessedAt）')
  assert.equal(value.considered.entries, 2)
  const all = value.windows.find((w) => w.label === 'all')
  assert.equal(all.returns, 2)
  assert.equal(all.tierA, 0, '两条都活跃 ⇒ 零误用')

  const text = tool_render(byName.get('memory_misuse'), value)
  assert.match(text, /R7 失效误用/)
  assert.match(text, /容忍度 0/, '零容忍必须在渲染里印出来')
  assert.match(text, /可分辨度/, '可分辨度必须印——否则读者会把历史记录当完整分层')
})

function tool_render(tool, value) {
  return tool.output.render({}, value).map((c) => c.text).join('\n')
}
