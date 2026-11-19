/**
 * 方案 §13.2 四类测试场景（v0.42）—— 设计正本 `docs/semantic.md` §5.35
 *
 * ## 为什么这四条不是「又一组单测」
 *
 * 现有 671 条测试测的是**机制**（给定输入，函数返回什么）。方案 §13.2 要的是**场景**：
 * 用户会怎么用，用完之后**行为对不对**。两者不能互相替代——机制全绿而行为错，
 * 是本库已经踩过的形状（v0.24.3：注脚写进结构化返回却印不出来，机制没错，到不了人眼前）。
 *
 * 方案原文那句判据是全部四条的总纲：
 * **「不能只评价记得多不多，还要评价该忘掉的有没有忘掉，该更新的有没有更新。」**
 * ⇒ 所以这里每条都带**反向断言**（不该出现的必须不出现），而不只断言「找得到」。
 *
 * ## 四类的覆盖现状（写给未来的自己，避免把「有测试」读成「四类齐了」）
 *
 * | 场景 | 本文件的测法 | 未覆盖的部分（诚实标注） |
 * |---|---|---|
 * | 一 记忆回忆 | 写入后用自然查询取回**同一条**，且排第一 | 真实长查询的召回率（那是 T2/T3 检索质量集的活） |
 * | 二 跨会话整合 | 两个不同 session 写下的同主题记忆，一次检索同时取回 | **真正的「组织成完整项目记忆」需要 LLM 归纳层**（§16.1 未建）；本文件只验「两条都在视野里」 |
 * | 三 记忆变化 | A→B 替代后：新的在前 / 旧的标「已过时」/ 旧的仍可查回 / **注入面不再注入旧的** | 「我实际会不会按新偏好做」——那是行为层，测不了 |
 * | 四 记忆遗忘 | 删除后默认视图查不到 / 归档视图能找回 | 九处传播面（已在 §10.4 的 F1–F6 覆盖，不重复） |
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MemoryStore } from '../lib/store.js'
import { createMemoryTools } from '../lib/tools.js'
import { DEFAULT_CONFIG } from '../lib/config.js'
import { workspaceIdOf } from '../lib/scope.js'
import { buildAutoRecallDigest } from '../lib/auto-inject.js'

const CWD = 'C:\\Users\\Alice\\proj'
const WID = workspaceIdOf(CWD)
const SESSION_A = 'session-aaaa1111-2222-3333-4444-555555555555'
const SESSION_B = 'session-bbbb1111-2222-3333-4444-666666666666'

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

function execOf(sessionId) {
  return {
    agent: { session: { id: sessionId, header: { id: sessionId, cwd: CWD } } },
    signal: new AbortController().signal,
  }
}

function setup() {
  const kv = new MemoryKv()
  const store = new MemoryStore(kv)
  const tools = createMemoryTools({ store, loadConfig: async () => DEFAULT_CONFIG })
  return {
    kv,
    store,
    byName: new Map(tools.map((t) => [t.name, t])),
    exec: execOf(SESSION_A),
    /** 全库条目（注入面要的是全库，不是检索结果） */
    entries: () => [...kv.entries()].map(([, value]) => value),
  }
}

// ── 一 · 记忆回忆 ────────────────────────────────────────────────────────────

test('S1 记忆回忆：自然查询能取回**同一条**，且排第一', async () => {
  const { byName, exec } = setup()
  const remember = byName.get('remember')
  const target = await remember.execute(
    {
      text: '# 表格排版的定调\n主人 2026-09-29 说表格异常小，要求用 Markdown 表格，不要 ASCII 画框',
      tags: ['排版'],
    },
    exec,
  )
  // 干扰项：同样是「主人在说排版」，但不是目标那条
  await remember.execute({ text: '# 另一条无关记录\n字体与行距的讨论', tags: ['无关'] }, exec)

  const recall = byName.get('recall')
  const value = await recall.execute({ query: '表格排版', limit: 5 }, exec)
  const ids = (value.results ?? []).map((r) => r.id)

  assert.ok(ids.includes(target.id), `没取回目标条目；实际返回 ${ids.join(',') || '（空）'}`)
  // 「找得到」与「找得准」是两件事：排第一才说明相关度真的在工作
  assert.equal(ids[0], target.id, '目标条目必须排在第一位，否则我读到的第一条会是无关记忆')
})

// ── 二 · 跨会话知识整合 ──────────────────────────────────────────────────────

test('S2 跨会话整合：两个会话谈同一项目，一次检索要能同时取回两条', async () => {
  const { byName } = setup()
  const remember = byName.get('remember')
  const fromA = await remember.execute(
    { text: '# 期货项目：数据口径确认\ndata_1min_adj 是连续序列，open[i]==close[i-1] 占 98.9%', tags: ['期货'] },
    execOf(SESSION_A),
  )
  const fromB = await remember.execute(
    { text: '# 期货项目：回测结论\n8 万档实盘可行域，杠杆有死区', tags: ['期货'] },
    execOf(SESSION_B),
  )

  const value = await byName.get('recall').execute({ query: '期货项目', limit: 10 }, execOf(SESSION_A))
  const ids = (value.results ?? []).map((r) => r.id)

  assert.ok(ids.includes(fromA.id), '会话 A 写的没取回')
  assert.ok(
    ids.includes(fromB.id),
    '会话 B 写的没取回 ⇒ sessionId 若成了可见性边界，「跨会话整合」在结构上就不可能（它只该是来源标注）',
  )
})

// ── 三 · 记忆变化（★本轮核心） ──────────────────────────────────────────────

test('S3 ★记忆变化：偏好被改后，新的在前 / 旧的标「已过时」/ 旧的仍可查回 / 注入面只用新的', async () => {
  const { byName, exec, entries } = setup()
  const remember = byName.get('remember')

  const oldOne = await remember.execute(
    { text: '# 表格偏好：用 Markdown\n主人要 Markdown 表格，不要 ASCII 画框', tags: ['偏好'] },
    exec,
  )
  const newOne = await remember.execute(
    { text: '# 表格偏好：改用 ASCII 画框\n主人 2026-11-19 改了：表格要用 ASCII 画框', tags: ['偏好'] },
    exec,
  )
  await byName.get('memory_supersede').execute({ id: newOne.id, supersedes: [oldOne.id] }, exec)

  const recall = byName.get('recall')
  const value = await recall.execute({ query: '表格偏好', limit: 5 }, exec)
  const ids = (value.results ?? []).map((r) => r.id)

  // ① 新偏好必须在前——否则我会拿一条已被推翻的偏好当依据（方案原文「检查智能体是否还在使用旧偏好」）
  assert.equal(ids[0], newOne.id, `新偏好没排第一；实际顺序 ${ids.join(',')}`)

  // ② 旧的**仍要能查回**：旧值里写着「以前为什么这么定」，那是这一对记录的全部价值
  assert.ok(ids.includes(oldOne.id), '旧条目必须仍可查回——不可以「更新」为名把它抹掉')

  // ③ 旧的必须带「已过时」标记，否则我分不出哪条还算数
  const text = recall.output.render({}, value).map((b) => b.text).join('\n')
  assert.match(text, /已过时/, `旧条目没打过时标记 ⇒ 两条并列时无法判断该用哪条：\n${text}`)

  // ④ ★ 注入面：新偏好必须在前；旧偏好**若被注入**必须带「已过时」标记。
  //
  // ⚠ 刻意**不要求旧偏好消失**——v0.38 的既定设计是「标记但保留」（旧值里写着「以前为什么这么定」，
  //   那是这一对记录的全部价值），方案 §13.2 问的是「是否还在使用旧偏好」，不是「旧偏好不许出现」。
  //   ⇒ 这一格的判据是「**顺序 + 标记**」，不是「缺席」。写清楚是为了让未来的我分得清
  //   「判据按设计放宽」与「为了让测试变绿而放水」——两者的区别是：放水不会解释自己。
  const digest = buildAutoRecallDigest(entries(), '表格偏好', { maxEntries: 5, maxBytes: 4000 })
  assert.ok(digest.length > 0, '夹具没产生注入文本 ⇒ 下面两条断言恒真（判据必须自证走过了路径）')
  const newAt = digest.indexOf('ASCII')
  const oldAt = digest.indexOf('用 Markdown')
  assert.ok(newAt >= 0, `注入面没出现新偏好 ⇒ 夹具或过滤有问题：\n${digest}`)
  assert.ok(
    oldAt < 0 || newAt < oldAt,
    `旧偏好排在**新偏好之前** ⇒ 注入面上「该更新的没更新」：\n${digest}`,
  )
  assert.ok(
    oldAt < 0 || /已过时/.test(digest),
    `旧偏好被注入却没带「已过时」标记 ⇒ 两条并列时我分不出哪条算数：\n${digest}`,
  )
})

// ── 四 · 记忆遗忘 ────────────────────────────────────────────────────────────

test('S4 记忆遗忘：删除后默认视图查不到，归档视图仍能找回', async () => {
  const { byName, store, exec } = setup()
  const target = await byName.get('remember').execute(
    { text: '# 临时占位的东西\n这条只为验证遗忘场景', tags: ['临时'] },
    exec,
  )

  await store.forget(WID, target.id, { reasonType: 'capacity', reason: '场景测试：验证遗忘路径' })

  const recall = byName.get('recall')
  const live = await recall.execute({ query: '临时占位', limit: 10 }, exec)
  assert.ok(
    !(live.results ?? []).some((r) => r.id === target.id),
    '删除后默认检索不该再出现它——「该忘掉的有没有忘掉」答否',
  )

  const withArchive = await recall.execute({ query: '临时占位', limit: 10, includeArchive: true }, exec)
  assert.ok(
    (withArchive.results ?? []).some((r) => r.id === target.id),
    '归档视图必须能找回它——「它曾经存在」是事实，抹掉等于让历史不可审计',
  )
})
