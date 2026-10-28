/**
 * dispose.test.mjs — 欠账销账入口（2026-10-29 · lh-0f54524a）。
 *
 * 存在理由（缺口是实测出来的）：处置队列 2026-10-28 上线后，`remember` 命中相似时
 * 能通过 `similarDisposition` 处置，但那个参数只在**写入那一刻**存在。于是
 * 「当时没算到、事后才想清楚」这一整类判断无法落账——欠账只进不出。
 * 当晚三次写入累积 15 条，一条都清不掉。
 *
 * 数据层其实早已就绪（`unresolvedCandidates` 认 `kind:'disposed'`），缺的只是写入入口。
 * ⇒ 本文件钉住那个入口的四件事：
 *   ① 销账后 memory_check 真的不再列出（**端到端**，不是只看返回值）
 *   ② 只销一条时，其他欠账照常列出（**尸体：防一刀切关掉整档**）
 *   ③ 未知 id 整批不写（**fail-closed：部分成功会让「我销了 5 条」变成假话**）
 *   ④ 销账后再撞上会重新进榜（时间轴重置是既有语义，不能被这个入口破坏）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore } from '../lib/store.js'
import { createMemoryTools } from '../lib/tools.js'
import { DEFAULT_CONFIG } from '../lib/config.js'

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

// ⚠ 时间必须落在「现在之前」：`unresolvedCandidates` 按 atMs 升序折叠，
// disposed 靠「晚于 hit」来销账。最初我把 T0 写成 UTC 2026-10-29T04:00Z，
// 而运行时 UTC 才 10-28T20:xx ⇒ hit 比销账记录**晚 8 小时**，销账被空转，
// 四条端到端用例全红。真实场景里 disposed 必然后写，所以这是夹具的坑不是实现的坑。
const T0 = Date.now() - 3_600_000

/** 一条 hit 记录（模拟 remember 撞车时写下的） */
function hit(candidateId, atMs = T0, strength = 10) {
  return { kind: 'hit', atMs, candidateId, newId: 'new-' + candidateId, strength }
}

/**
 * 搭一套夹具。`trace` 是**内存侧车**——测试直接读写它，
 * 这样「销账后 check 还列不列」这个端到端问题才能真被问到。
 */
function setup(initTrace = [], overrides = {}) {
  const trace = [...initTrace]
  // ⚠ 用哨兵对象而不是 `let readResult = undefined`：后者无法区分
  // 「测试没设置」与「测试明确要求返回 undefined（模拟读不到）」——
  // 两者行为相反，混在一起会让「读不到就拒绝写」这条判据永远测不到（写测试时踩过）。
  let readOverride = { set: false, value: undefined }
  const deps = {
    store: new MemoryStore(new MemoryKv()),
    loadConfig: async () => DEFAULT_CONFIG,
    readDedupeTrace: async () => (readOverride.set ? readOverride.value : [...trace]),
    recordDedupeTrace: async (records) => {
      trace.push(...records)
      return true
    },
    ...overrides,
  }
  const tools = createMemoryTools(deps)
  const byName = new Map(tools.map((t) => [t.name, t]))
  return {
    trace,
    byName,
    setReadResult: (v) => {
      readOverride = { set: true, value: v }
    },
    check: () => byName.get('memory_check').execute({}),
    dispose: (args) => byName.get('memory_dispose').execute(args),
  }
}

// ---------- 主路径 ----------

test('销账成功：返回 ok / disposed，且侧车里真的多了一条 disposed', async () => {
  const s = setup([hit('cand-a')])
  const r = await s.dispose({ candidateIds: ['cand-a'], disposition: 'unrelated', reason: '判过无关' })
  assert.equal(r.ok, true)
  assert.deepEqual(r.disposed, ['cand-a'])
  const disposed = s.trace.filter((x) => x.kind === 'disposed')
  assert.equal(disposed.length, 1)
  assert.equal(disposed[0].candidateId, 'cand-a')
  assert.equal(disposed[0].disposition, 'unrelated')
  assert.equal(disposed[0].reason, '判过无关')
})

test('★ 端到端：销账后 memory_check **真的不再列出**这条（不是只看返回值）', async () => {
  const s = setup([hit('cand-a')])
  const before = await s.check()
  assert.equal(before.suggestions.length, 1, '前置：销账前必须列出')
  await s.dispose({ candidateIds: ['cand-a'], disposition: 'unrelated', reason: '判过无关' })
  const after = await s.check()
  assert.deepEqual(after.suggestions, [], '销账后不该再列出')
  assert.equal(after.disposedCount, 1, '已销账计数必须为 1（否则「销了」与「从未撞过」在输出上同形）')
})

test('★ 尸体：只销 A 时 B 必须照常列出（防一刀切关掉整档）', async () => {
  const s = setup([hit('cand-a'), hit('cand-b')])
  await s.dispose({ candidateIds: ['cand-a'], disposition: 'unrelated', reason: '只销 A' })
  const after = await s.check()
  assert.equal(after.suggestions.length, 1, 'B 仍欠账')
  assert.match(after.suggestions[0].summary, /cand-b/)
})

test('★ 时间轴重置没被破坏：销账之后**再撞上**会重新进榜', async () => {
  const s = setup([hit('cand-a', T0)])
  await s.dispose({ candidateIds: ['cand-a'], disposition: 'unrelated', reason: '当时判无关' })
  assert.deepEqual((await s.check()).suggestions, [])
  // 同一候选再次被撞，时刻**晚于**销账记录（在测试内现算，模块级常量会早于销账时刻）
  s.trace.push(hit('cand-a', Date.now() + 1_000))
  const again = await s.check()
  assert.equal(again.suggestions.length, 1, '销账后的新撞车必须重新进榜——否则「判过无关」会变成永久免检')
})

test('批量销账：一次销多条同 disposition', async () => {
  const s = setup([hit('a'), hit('b'), hit('c')])
  const r = await s.dispose({ candidateIds: ['a', 'b', 'c'], disposition: 'merged', reason: '批量合流' })
  assert.equal(r.ok, true)
  assert.deepEqual(r.disposed.sort(), ['a', 'b', 'c'])
  assert.deepEqual((await s.check()).suggestions, [])
})

test('重复 id 去重（同一批里给两次不该写两条）', async () => {
  const s = setup([hit('a')])
  await s.dispose({ candidateIds: ['a', 'a'], disposition: 'unrelated', reason: '重复' })
  assert.equal(s.trace.filter((x) => x.kind === 'disposed').length, 1)
})

test('refs 会被写进记录（「凭什么说处置了」）', async () => {
  const s = setup([hit('a')])
  await s.dispose({ candidateIds: ['a'], disposition: 'updated', reason: '已补写', refs: ['src/tools.ts:1', '记忆 abc'] })
  const rec = s.trace.find((x) => x.kind === 'disposed')
  assert.deepEqual(rec.refs, ['src/tools.ts:1', '记忆 abc'])
})

test('refs 为空时不写这个字段（不留空数组噪音）', async () => {
  const s = setup([hit('a')])
  await s.dispose({ candidateIds: ['a'], disposition: 'unrelated', reason: '无关' })
  assert.equal('refs' in s.trace.find((x) => x.kind === 'disposed'), false)
})

// ---------- fail-closed ----------

test('★ 未知 id：整批不写，返回 ok:false + unknown（id 拼错不能被静默吞掉）', async () => {
  const s = setup([hit('a')])
  const before = s.trace.length
  const r = await s.dispose({ candidateIds: ['nope'], disposition: 'unrelated', reason: '拼错了' })
  assert.equal(r.ok, false)
  assert.deepEqual(r.disposed, [])
  assert.deepEqual(r.unknown, ['nope'])
  assert.equal(s.trace.length, before, '未知 id 时侧车必须一个字节都没变')
})

test('★ 部分未知 ⇒ 已知的那条也**不写**（部分成功会让「销了」变成假话）', async () => {
  const s = setup([hit('a')])
  const before = s.trace.length
  const r = await s.dispose({ candidateIds: ['a', 'nope'], disposition: 'unrelated', reason: '混着拼错' })
  assert.equal(r.ok, false)
  assert.deepEqual(r.unknown, ['nope'])
  assert.equal(s.trace.length, before, '混入未知 id 时已知条目也不该被写')
  assert.equal((await s.check()).suggestions.length, 1, 'A 必须仍然欠账（没销）')
})

test('读不到侧车 ⇒ **拒绝写**（读不到就无法校验候选，此时的成功是凭空造的）', async () => {
  const s = setup([hit('a')])
  s.setReadResult(undefined)
  await assert.rejects(
    () => s.dispose({ candidateIds: ['a'], disposition: 'unrelated', reason: 'x' }),
    /读取失败/,
  )
})

test('未接线（recordDedupeTrace 缺失）⇒ 抛错，不假装成功', async () => {
  const s = setup([hit('a')], { recordDedupeTrace: undefined })
  await assert.rejects(
    () => s.dispose({ candidateIds: ['a'], disposition: 'unrelated', reason: 'x' }),
    /未接线/,
  )
})

test('未接线（readDedupeTrace 缺失）⇒ 抛错', async () => {
  const s = setup([hit('a')], { readDedupeTrace: undefined })
  await assert.rejects(
    () => s.dispose({ candidateIds: ['a'], disposition: 'unrelated', reason: 'x' }),
    /未接线/,
  )
})

test('侧车写入失败 ⇒ 抛错（不返回 ok:true）', async () => {
  const s = setup([hit('a')], { recordDedupeTrace: async () => false })
  await assert.rejects(
    () => s.dispose({ candidateIds: ['a'], disposition: 'unrelated', reason: 'x' }),
    /写入失败/,
  )
})

// ---------- 必填校验：分两层测，每条判据对准它**实际被拦下的那一层** ----------
// 层级事实（写测试时踩出来的）：`defineTool` 在 execute 之前先做 schema 校验，而它要求
// 「lossless JSON object」⇒ 传 `undefined` 字段、enum 外值、错类型，都会在到达我的运行时
// 校验**之前**抛 ToolArgsError。把期望写成我的错误消息会假红。
//   ① 能过 schema 的坏值（空串 / 空白串 / 空数组 / 缺失的 enum 参数）→ 测**运行时的**消息
//   ② schema 就会拦的形态 → 只测「确实被拒」，不绑我的消息

test('reason 必填（空串 / 纯空白由运行时拒）', async () => {
  const s = setup([hit('a')])
  for (const reason of ['', '   ']) {
    await assert.rejects(
      () => s.dispose({ candidateIds: ['a'], disposition: 'unrelated', reason }),
      /reason 必填/,
      `reason=${JSON.stringify(reason)} 必须被拒`,
    )
  }
})

test('candidateIds 必填：空数组由运行时拒（schema 允许空数组）', async () => {
  const s = setup([hit('a')])
  await assert.rejects(
    () => s.dispose({ candidateIds: [], disposition: 'unrelated', reason: 'x' }),
    /candidateIds 必填/,
  )
})

test('全是空白 id ⇒ 运行时抛错（「不知道要销哪条」不该被当成销成功）', async () => {
  const s = setup([hit('a')])
  await assert.rejects(
    () => s.dispose({ candidateIds: ['', '   '], disposition: 'unrelated', reason: 'x' }),
    /没有有效 id/,
  )
})

test('完全不给 disposition ⇒ 由运行时拒（该参数在 schema 里不可 required，故能到达我这里）', async () => {
  const s = setup([hit('a')])
  await assert.rejects(
    () => s.dispose({ candidateIds: ['a'], reason: 'x' }),
    /disposition 必填/,
  )
})

test('enum 外的 disposition / undefined 的 reason ⇒ 被 schema 层拦下（防线在，只是不经过我的消息）', async () => {
  const s = setup([hit('a')])
  await assert.rejects(
    () => s.dispose({ candidateIds: ['a'], disposition: 'whatever', reason: 'x' }),
    /invalid arguments/,
  )
  await assert.rejects(
    () => s.dispose({ candidateIds: ['a'], disposition: 'unrelated', reason: undefined }),
    /invalid arguments/,
  )
  // 写完要确认它真的没写进侧车（被拒 ≠ 半途生效）
  assert.equal(s.trace.length, 1, '被拒的调用不该留下 disposed 记录')
})
