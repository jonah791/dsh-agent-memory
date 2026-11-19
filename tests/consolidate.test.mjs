/**
 * 知识提炼候选（v0.49 · 方案 §16.1）· 判据
 *
 * 设计正本：`src/consolidate.ts` 头注。这一层守四件事：
 * ① **候选识别的三要素齐全**（条目数 / 时间跨度 / summary 覆盖）——少一样就不足以支撑「够不够格」；
 * ② **阈值真的起作用**（调紧必须让候选单调减少——否则参数被实现悄悄忽略）；
 * ③ **时间坐标不算主题**（`2026-09-16` 39 条、跨度 0 天，收进来就让「按主题归纳」退化成流水账）；
 * ④ **只读**（跑前后输入数组不被改动——本模块不落库、不改条目）。
 *
 * 不守的那件事：**它不判断「这个主题意味着什么」**。归纳归人，机制只报证据量。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CONSOLIDATION_DEFAULTS,
  findConsolidationCandidates,
  isTopicTag,
  spanDaysOf,
} from '../lib/consolidate.js'
import { MemoryStore } from '../lib/store.js'
import { createMemoryTools } from '../lib/tools.js'
import { DEFAULT_CONFIG } from '../lib/config.js'
import { workspaceIdOf } from '../lib/scope.js'

const CWD = 'C:\\Users\\Alice\\proj'
const WID = workspaceIdOf(CWD)

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

function setupTools() {
  const kv = new MemoryKv()
  const store = new MemoryStore(kv)
  const tools = createMemoryTools({ store, loadConfig: async () => DEFAULT_CONFIG })
  const exec = {
    agent: {
      session: {
        id: 'session-11111111-2222-3333-4444-555555555555',
        header: { id: 'session-11111111-2222-3333-4444-555555555555', cwd: CWD },
      },
    },
    signal: new AbortController().signal,
  }
  return { kv, tools, byName: new Map(tools.map((t) => [t.name, t])), exec }
}

function entry(partial) {
  const at = partial.createdAt ?? '2026-10-01T00:00:00.000Z'
  return {
    kind: 'knowledge',
    tags: [],
    body: '',
    scope: WID,
    title: partial.title ?? 't',
    createdAt: at,
    updatedAt: at,
    accessedAt: at,
    level: null,
    bucket: null,
    archived: false,
    ...partial,
  }
}

/** 造一个簇：n 条同标签条目，首末相隔 days 天 */
function cluster(tag, n, days, kind = 'knowledge') {
  return Array.from({ length: n }, (_, i) => {
    const offsetDays = n === 1 ? 0 : Math.round((i * days) / (n - 1))
    const at = new Date(Date.parse('2026-01-01T00:00:00.000Z') + offsetDays * 86_400_000).toISOString()
    return entry({ id: `${tag}-${i}`, title: `${tag} 第${i}条`, tags: [tag], kind, createdAt: at })
  })
}

// ---------- K 段：纯函数判据 ----------

test('K1 候选三要素齐全：条目数 / 跨度 / summary 覆盖', () => {
  const es = [...cluster('判据', 25, 40), ...cluster('判据', 3, 0, 'summary')]
  const [c] = findConsolidationCandidates(es, { minEntries: 20, minDays: 30, limit: 5 })
  assert.equal(c.tag, '判据')
  assert.equal(c.entries, 28)
  assert.equal(c.spanDays, 40)
  assert.equal(c.summaryCovered, 3)
  assert.equal(c.kinds.knowledge, 25)
  assert.equal(c.kinds.summary, 3)
  assert.equal(c.recentTitles.length, 3)
  assert.match(c.firstAt, /^\d{4}-\d{2}-\d{2}$/)
  assert.match(c.lastAt, /^\d{4}-\d{2}-\d{2}$/)
})

test('K2 调紧阈值 ⇒ 候选数单调不增（参数不许被实现忽略）', () => {
  const es = [
    ...cluster('A', 40, 60),
    ...cluster('B', 25, 40),
    ...cluster('C', 10, 35),
    ...cluster('D', 22, 5), // 条数够、跨度不够
  ]
  const count = (minEntries, minDays) =>
    findConsolidationCandidates(es, { minEntries, minDays, limit: 100 }).length
  // 夹具：A 40 条/60 天 · B 25 条/40 天 · C 10 条/35 天（条数不够）· D 22 条/5 天（跨度不够）
  assert.equal(count(20, 30), 2) // A / B
  assert.equal(count(20, 45), 1) // 只剩 A（B 跨度 40 < 45）
  assert.equal(count(30, 30), 1) // 只剩 A（B 条数 25 < 30）
  assert.ok(count(20, 30) >= count(20, 45))
  assert.ok(count(20, 45) >= count(30, 45))
})

test('K3 时间坐标不算主题：日 / 周 / 月 / 年 / 纯数字一律排除', () => {
  for (const t of ['2026-09-16', '2026-W45', '2026-09', '2026', '12345']) {
    assert.equal(isTopicTag(t), false, `应排除：${t}`)
  }
  for (const t of ['判据', '任务板', '6维', 'AML', 'asr', '2026年度总结']) {
    assert.equal(isTopicTag(t), true, `应保留：${t}`)
  }
  // 端到端：日期簇即使条数与跨度都够，也不进候选
  const es = cluster('2026-09-16', 30, 50)
  assert.equal(findConsolidationCandidates(es, { minEntries: 20, minDays: 30, limit: 10 }).length, 0)
})

test('K4 spanDaysOf 边界：单条 = 0；时间不可解析 = 0（不是「跨度为零的长期主题」）', () => {
  assert.equal(spanDaysOf([]), 0)
  assert.equal(spanDaysOf([entry({})]), 0)
  assert.equal(spanDaysOf([entry({ createdAt: '不是时间' }), entry({ createdAt: '也不是' })]), 0)
  const es = [
    entry({ createdAt: '2026-01-01T00:00:00.000Z' }),
    entry({ createdAt: '2026-01-31T00:00:00.000Z' }),
  ]
  assert.equal(spanDaysOf(es), 30)
})

test('K5 空输入与全不达阈值都返回空数组（不 panic、不返回 null）', () => {
  assert.deepEqual(findConsolidationCandidates([]), [])
  const es = cluster('小众', 3, 100)
  assert.deepEqual(findConsolidationCandidates(es, { minEntries: 20, minDays: 30, limit: 10 }), [])
})

test('K6 默认阈值是裁决过的 20 条 × 30 天（改默认值要改头注的理由）', () => {
  assert.equal(CONSOLIDATION_DEFAULTS.minEntries, 20)
  assert.equal(CONSOLIDATION_DEFAULTS.minDays, 30)
  assert.equal(CONSOLIDATION_DEFAULTS.limit, 12)
})

test('K7 limit 只截断条数，不改排序（按条目数降序）', () => {
  const es = [...cluster('小簇', 21, 40), ...cluster('大簇', 50, 40)]
  const all = findConsolidationCandidates(es, { minEntries: 20, minDays: 30, limit: 100 })
  assert.deepEqual(all.map((c) => c.tag), ['大簇', '小簇'])
  const one = findConsolidationCandidates(es, { minEntries: 20, minDays: 30, limit: 1 })
  assert.deepEqual(one.map((c) => c.tag), ['大簇'])
})

test('K8 只读：跑前后输入数组与条目对象逐字段不变（不落库、不刷 accessedAt）', () => {
  const es = cluster('只读检查', 25, 40)
  const before = JSON.stringify(es)
  findConsolidationCandidates(es, { minEntries: 20, minDays: 30, limit: 5 })
  assert.equal(JSON.stringify(es), before)
})

test('K9 同一标签的条目跨多个 kind 时，kinds 分布之和 == 该簇条目数', () => {
  const es = [...cluster('混合', 12, 40, 'knowledge'), ...cluster('混合', 9, 40, 'fact'), ...cluster('混mixed', 0, 0)]
  const [c] = findConsolidationCandidates(es, { minEntries: 20, minDays: 30, limit: 5 })
  if (c !== undefined) {
    const sum = Object.values(c.kinds).reduce((a, b) => a + b, 0)
    assert.equal(sum, c.entries)
  }
  const es2 = [...cluster('混合2', 12, 40, 'knowledge'), ...cluster('混合2', 9, 40, 'fact')]
  const [c2] = findConsolidationCandidates(es2, { minEntries: 20, minDays: 30, limit: 5 })
  assert.equal(c2.entries, 21)
  assert.equal(Object.values(c2.kinds).reduce((a, b) => a + b, 0), 21)
})

// ---------- E 段：真实工具调用（直调 execute 会绕过宿主 schema 校验，
// 而 schema 与实现不一致正是 v0.47 第八次同形的形态——所以必须有一条判据）
// 见 semantic.md §5.39 / A211 旁的事故记录：那道防线在 A117 覆盖不到的新工具上尤其要靠这里。

test('K10 other 格真的会计数：未知 kind 不丢，五格之和仍 == entries', () => {
  // 这条是尸体验证补出来的：先前 K9 的夹具里没有未知 kind，
  // 于是「other 不计数」这个缺陷在全绿里藏住了（教训④：夹具只覆盖「不触发」路径等于没覆盖纪律）。
  const es = [
    ...cluster('未知格', 20, 40, 'knowledge'),
    entry({ id: 'w1', tags: ['未知格'], kind: 'weird', createdAt: '2026-02-01T00:00:00.000Z' }),
  ]
  const [c] = findConsolidationCandidates(es, { minEntries: 20, minDays: 30, limit: 5 })
  assert.equal(c.entries, 21)
  assert.equal(c.kinds.other, 1, '未知 kind 必须落进 other，不能静默丢弃')
  assert.equal(Object.values(c.kinds).reduce((a, b) => a + b, 0), 21)
})

test('E1 真实调用：返回四件套齐全，候选元素含 output schema 声明的每个字段', async () => {
  const { kv, byName, exec } = setupTools()
  // 造 25 条同标签、跨 40 天的活跃条目
  const base = Date.parse('2026-09-01T00:00:00.000Z')
  for (let i = 0; i < 25; i += 1) {
    const at = new Date(base + Math.round((i * 40 * 86400000) / 24)).toISOString()
    const e = entry({ id: `c-${i}`, title: `提炼候选 ${i}`, tags: ['提炼测试'], createdAt: at })
    await kv.put(`${e.scope}:${e.kind}:${e.id}`, e)
  }
  const before = JSON.stringify([...kv.map.entries()])
  const value = await byName.get('memory_consolidate').execute(
    { minEntries: 20, minDays: 30, limit: 5 },
    exec,
  )

  // 四件套
  for (const key of ['thresholds', 'considered', 'candidates', 'note']) {
    assert.ok(key in value, `缺顶层键：${key}`)
  }
  assert.equal(value.thresholds.minEntries, 20)
  assert.equal(value.thresholds.minDays, 30)
  assert.equal(value.considered.active, 25)
  assert.ok(value.candidates.length >= 1)
  assert.equal(value.note.length > 0, true)

  // 候选元素：schema 里声明的每个字段都必须在（漏一个 = 线上整条拒收）
  const c = value.candidates[0]
  for (const key of ['tag', 'entries', 'spanDays', 'firstAt', 'lastAt', 'kinds', 'summaryCovered', 'recentTitles']) {
    assert.ok(key in c, `候选缺字段：${key}（output schema 声明了就必须有）`)
  }
  for (const k of ['fact', 'knowledge', 'episodic', 'summary', 'other']) {
    assert.equal(typeof c.kinds[k], 'number', `kinds 缺固定格：${k}`)
  }
  assert.equal(Object.values(c.kinds).reduce((a, b) => a + b, 0), c.entries)

  // 只读：跑前后存储逐字节不变
  assert.equal(JSON.stringify([...kv.map.entries()]), before)
})

test('E2 真实调用：空库返回空候选 + 明说「不等于没有主题」', async () => {
  const { byName, exec } = setupTools()
  const value = await byName.get('memory_consolidate').execute({}, exec)
  assert.deepEqual(value.candidates, [])
  assert.equal(value.considered.active, 0)
  assert.match(value.note, /不等于库里没有主题/)
})

test('E3 渲染层：有候选时输出标签、跨度与样本，无候选时输出边界说明', async () => {
  const { kv, byName, exec } = setupTools()
  const base = Date.parse('2026-09-01T00:00:00.000Z')
  for (let i = 0; i < 22; i += 1) {
    const at = new Date(base + Math.round((i * 40 * 86400000) / 21)).toISOString()
    const e = entry({ id: `r-${i}`, title: `渲染样本 ${i}`, tags: ['渲染测试'], createdAt: at })
    await kv.put(`${e.scope}:${e.kind}:${e.id}`, e)
  }
  const tool = byName.get('memory_consolidate')
  const value = await tool.execute({ minEntries: 20, minDays: 30 }, exec)
  const blocks = tool.output.render({}, value)
  assert.equal(Array.isArray(blocks), true)
  const text = blocks.map((b) => b.text ?? '').join('\n')
  assert.match(text, /知识提炼候选/)
  assert.match(text, /#渲染测试/)
  assert.match(text, /最新的|最新样本/)
})
