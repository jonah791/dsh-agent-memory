/**
 * §9.3 双时态 · 判据（T 段）——设计正本 `docs/semantic.md` §5.31
 *
 * 这一层守的是**四条不可合并**（本节存在的全部理由）：
 *   `occurredAt` ≠ `validAfter`（事件 vs 适用）· `expiry` ≠ `reviewAfter`（事实 vs 提醒）
 *   · `expiry` ≠ `supersededBy`（时间到了 vs 被别人顶掉）· `expiry` ≠ `archived`（读数 vs 处置）
 * 以及两条纪律：**不预存档位**（派生）· **过期不改生命周期**（不自动归档）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  assertExpiryOrder,
  countByExpiry,
  expiryStateOf,
  expiryTag,
  filterByExpiryState,
  occurredAtTag,
  parseExpiryStateFilter,
  parseMomentArg,
  parseStoredExpiry,
  parseStoredOccurredAt,
} from '../lib/temporal-dual.js'
import { MemoryStore } from '../lib/store.js'
import { createMemoryTools } from '../lib/tools.js'
import { workspaceIdOf } from '../lib/scope.js'

const NOW = new Date('2026-11-19T12:00:00.000Z')

test('T1 解析：日期 / ISO 时刻都收，相对写法与不存在的日期 fail-loud', () => {
  assert.equal(parseMomentArg('2026-11-15', 't'), '2026-11-15')
  assert.equal(parseMomentArg('2026-11-15T21:00:00+08:00', 't'), '2026-11-15T21:00:00+08:00')
  assert.equal(parseMomentArg(undefined, 't'), undefined, '不给 ⇒ undefined（不是空串）')
  assert.throws(() => parseMomentArg('+7d', 't'), /相对写法/, '相对写法会让同一份意图隔天写出两个不同时刻')
  assert.throws(() => parseMomentArg('2026-02-30', 't'), /日期不存在/, 'JS 会静默滚到 3-02，回读比对才抓得住')
  assert.throws(() => parseMomentArg('Nov 1 2026', 't'), /无法解析/, '形态白名单，不交给 Date.parse 的启发式')
})

test('T2 读取侧两种日期解释方向相反：occurredAt 取当日起点、expiry 取当日末刻', () => {
  const start = parseStoredOccurredAt('2026-11-15')
  const end = parseStoredExpiry('2026-11-15')
  assert.ok(start !== undefined && end !== undefined)
  assert.equal(new Date(start).toISOString(), '2026-11-15T00:00:00.000Z', '事情发生在 11-15 的某个时刻——起点')
  assert.equal(new Date(end).toISOString(), '2026-11-15T23:59:59.999Z', '11-15 结束前仍然有效——末刻（与 reviewAfter 同口径）')
})

test('T3 区间校验：失效早于生效 ⇒ 抛；相等允许', () => {
  assert.throws(() => assertExpiryOrder('2026-10-01', '2026-11-01', 't'), /从未有效过/)
  assert.doesNotThrow(() => assertExpiryOrder('2026-11-01', '2026-11-01', 't'), '当天生效当天失效是合法形态')
  assert.doesNotThrow(() => assertExpiryOrder(undefined, '2026-11-01', 't'), '没给失效时刻就不判')
})

test('T4 ★过期是**派生**：同一份数据在不同 now 下档位不同（不预存）', () => {
  const entry = { expiry: '2026-12-31' }
  assert.equal(expiryStateOf(entry.expiry, NOW), 'active')
  assert.equal(expiryStateOf(entry.expiry, new Date('2027-01-01T00:00:00.000Z')), 'expired',
    '跨过当日末刻才失效——预存档位就不可能做到这一点')
  assert.equal(expiryStateOf(undefined, NOW), 'unset', '未设是 unset，**不是 active**（不知道 ≠ 有效）')
})

test('T5 标记：只对已失效打、与「已过时 / 该复查」可同时出现且互不吃掉', () => {
  assert.equal(expiryTag('2026-12-31', NOW), '', '未失效不打标记（标记要挑着打）')
  assert.equal(expiryTag(undefined, NOW), '')
  // NOW = 11-19T12:00Z，expiry=11-10 的末刻 ⇒ 差 8.5 天 ⇒ floor 8
  assert.equal(expiryTag('2026-11-10', NOW), '[⌛已失效8天]')
  assert.equal(occurredAtTag('2026-11-15'), '事件 2026-11-15')
  assert.equal(occurredAtTag(undefined), '')
  // 渲染层三种标记共存的形状（取真实拼接顺序：已过时 → 已失效 → 该复查）
  const line = '[⚠已过时]' + expiryTag('2026-11-10', NOW) + '[⚠已过期3天]'
  assert.equal(line, '[⚠已过时][⌛已失效8天][⚠已过期3天]', '三种标记各占一格、互不吃掉')
})

test('T6 三档计数：之和 == 条目数，「未设」单列不并入有效', () => {
  const entries = [{ expiry: '2026-12-31' }, { expiry: '2026-01-01' }, {}, { expiry: undefined }]
  const counts = countByExpiry(entries, NOW)
  assert.deepEqual(counts, { active: 1, expired: 1, unset: 2 })
  assert.equal(counts.active + counts.expired + counts.unset, entries.length)
})

test('T7 过滤：按档筛且与条目顺序无关；未给档位 ⇒ 原样返回（零拷贝）', () => {
  const entries = [{ id: 'a', expiry: '2026-12-31' }, { id: 'b', expiry: '2026-01-01' }, { id: 'c' }]
  assert.deepEqual(filterByExpiryState(entries, ['expired'], NOW).map((e) => e.id), ['b'])
  assert.deepEqual(filterByExpiryState(entries, ['active', 'unset'], NOW).map((e) => e.id), ['a', 'c'])
  assert.equal(filterByExpiryState(entries, [], NOW), entries, '空档位必须返回同一引用（零拷贝透传）')
  assert.throws(() => parseExpiryStateFilter(['nope'], 't'), /未知取值/, '拼错当场报，不静默返回空')
})

// ---------- 工具层端到端 ----------

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
}

const CWD = 'C:\\Users\\Alice\\proj'
const WID = workspaceIdOf(CWD)
const CONFIG = { maxEntries: 500, layers: ['fact', 'knowledge', 'episodic', 'summary'] }

function setup() {
  const store = new MemoryStore(new MemoryKv())
  const tools = createMemoryTools({ store, loadConfig: () => CONFIG })
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const exec = { agent: { session: { id: 'session-dual', header: { cwd: CWD } } } }
  return { store, byName, exec }
}

test('T8 ★四个字段互不推导：remember 各写各的，缺省就是缺省（无默认值）', async () => {
  const { store, byName, exec } = setup()
  const created = await byName.get('remember').execute(
    { text: '# 追记：主人 11-15 21:00 定了架构', occurredAt: '2026-11-15T21:00:00+08:00', validAfter: '2026-11-15' },
    exec,
  )
  const entry = store.get(WID, created.id)
  assert.equal(entry.occurredAt, '2026-11-15T21:00:00+08:00', 'ISO 时刻原样保留（与 validAfter 取日的口径刻意不同）')
  assert.equal(entry.validAfter, '2026-11-15')
  assert.equal(entry.expiry, undefined, '没给就不存在该键——**不是**等于 createdAt')
  assert.notEqual(entry.occurredAt, entry.createdAt, '这正是追记场景：事情发生在我记下之前')
})

test('T9 ★expiry 与 validAfter 冲突 ⇒ 写入被拒（区间为空不是「长期有效」）', async () => {
  const { byName, exec } = setup()
  await assert.rejects(
    () => byName.get('remember').execute(
      { text: '# 矛盾区间', validAfter: '2026-11-01', expiry: '2026-10-01' },
      exec,
    ),
    /从未有效过/,
  )
})

test('T10 update 三态：给值 = 设置 / 空串 = 清除 / 缺省 = 不动；并按修改后状态校验区间', async () => {
  const { store, byName, exec } = setup()
  const created = await byName.get('remember').execute({ text: '# 三态', expiry: '2026-12-31' }, exec)
  const update = byName.get('update')

  await update.execute({ id: created.id, expiry: '2027-06-30' }, exec)
  assert.equal(store.get(WID, created.id).expiry, '2027-06-30')

  await update.execute({ id: created.id, tags: ['x'] }, exec)
  assert.equal(store.get(WID, created.id).expiry, '2027-06-30', '缺省 = 不动')

  await update.execute({ id: created.id, expiry: '' }, exec)
  assert.equal(store.get(WID, created.id).expiry, undefined, '空串 = 清除回「不知道」，不留第二表示')

  // 只给 expiry 而条目已有 validAfter 时，冲突发生在两者之间（不能只看本次给的值）
  await update.execute({ id: created.id, validAfter: '2027-01-01' }, exec)
  await assert.rejects(() => update.execute({ id: created.id, expiry: '2026-12-01' }, exec), /从未有效过/)
})

test('T11 过期**不改生命周期**（不自动归档）：条目仍 active，只是读取时打标记', async () => {
  const { store, byName, exec } = setup()
  const created = await byName.get('remember').execute({ text: '# 已失效的会', expiry: '2026-01-01' }, exec)
  const entry = store.get(WID, created.id)
  assert.equal(entry.archived ?? false, false, '过期不是处置动作——归档与否归人')
  const value = await byName.get('memory_stats').execute({}, exec)
  assert.ok(value.expiry.expired >= 1, '体检入口必须看得见它')
  assert.equal(value.expiry.active + value.expiry.expired + value.expiry.unset, value.total)
})

test('T12 过滤面：expiryState 与 staleness 互不干扰（可同时用）', async () => {
  const { byName, exec } = setup()
  const remember = byName.get('remember')
  await remember.execute({ text: '# 甲 已失效且该复查', expiry: '2026-01-01', reviewAfter: '2026-02-01' }, exec)
  await remember.execute({ text: '# 乙 只有死线', reviewAfter: '2026-02-01' }, exec)
  await remember.execute({ text: '# 丙 干净' }, exec)

  const expiredOnly = await byName.get('recall').execute({ expiryState: ['expired'] }, exec)
  assert.equal(expiredOnly.results.length, 1, '只筛内容已失效')
  assert.match(expiredOnly.results[0].title, /甲/)

  const both = await byName.get('recall').execute({ expiryState: ['expired'], staleness: ['expired'] }, exec)
  assert.equal(both.results.length, 1, '两个筛子在各自的维度上同时生效')

  const staleOnly = await byName.get('recall').execute({ staleness: ['expired'] }, exec)
  assert.equal(staleOnly.results.length, 2, 'staleness 单独用时不看 expiry（甲、乙都在）')
})
