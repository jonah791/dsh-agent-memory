/**
 * v0.61 服务通道证据坐标单测（方案 §5.3 事实与证据分离 / §13.3 R1 来源可追溯）。
 *
 * 背景：`memoryApi.remember` 是 emotion / skill-forge / taskboard / evolution-core
 * 四个插件回流的入口，此前**不写 `evidenceRefs`** ⇒ 这些条目在阅读侧查不回原文
 * （2026-11-20 实测：近 1 天 43 条里 3 条无坐标，全是非工具写入）。
 * 本版给服务接口加可选 `sessionId`，由调用方显式传——**宁缺不猜**：
 * 服务接口无法知道「谁在调我」，取「当前活跃会话」会把 A 会话的写入记到 B 身上。
 *
 * 运行：node --test "tests/*.test.mjs"（导入编译产物 lib/*.js）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { evidenceRefsOfSessionId, authorOfSessionId } from '../lib/index.js'
import { parseEvidenceRef } from '../lib/evidence.js'

const SID = 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

// ---------- A257 纯函数：两侧都测（该盖的盖、不该盖的不盖） ----------

test('A257 evidenceRefsOfSessionId：给了 sessionId 就盖，seq 有则带、无则只到会话级', () => {
  // ① 有 sessionId + 有 seq ⇒ 完整事件级坐标
  assert.deepEqual(evidenceRefsOfSessionId(SID, () => 4242), [`session|${SID}|4242`])
  // ② 有 sessionId 无 seq ⇒ 会话级坐标（**不编造序号**）
  const noSeq = evidenceRefsOfSessionId(SID, () => undefined)
  assert.deepEqual(noSeq, [`session|${SID}|`])
  assert.equal(parseEvidenceRef(noSeq[0]).seq, undefined, '缺 seq 不得编一个出来')
  // ③ 不给 / 空串 ⇒ 不盖（这是本判据的核心：宁缺不猜，不是「总能盖点什么」）
  assert.equal(evidenceRefsOfSessionId(undefined, () => 1), undefined)
  assert.equal(evidenceRefsOfSessionId('', () => 1), undefined)
  // ④ 坐标能往返：写进去的字符串必须能被解析回来（否则「可追溯」是空话）
  const parsed = parseEvidenceRef(evidenceRefsOfSessionId(SID, () => 7)[0])
  assert.equal(parsed.kind, 'session')
  assert.equal(parsed.sessionId, SID)
  assert.equal(parsed.seq, 7)
})

// ---------- A258 接线：接口真的接上了（结构断言，局限已标明） ----------

test('A258 服务接口接线：provide 里传 sessionId 且落库带 evidenceRefs；不得用活跃会话兜底', () => {
  // ⚠ 局限：这是**源码结构断言**，只证「接线存在」，不证运行时正确
  //   （要真跑 `apply()` 得造整套 ctx 桩，成本远大于它多证明的那一点）。
  //   运行时那半由 A257 的往返自证 + 线上实调读数承担。
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  const provideAt = src.indexOf("ctx.provide('memoryApi'")
  assert.ok(provideAt > 0, 'memoryApi 服务必须存在')
  const block = src.slice(provideAt, provideAt + 4000)
  assert.match(block, /sessionId\?: string/, '服务签名必须接受 sessionId')
  assert.match(block, /evidenceRefsOfSession\(input\.sessionId\)/, '必须由入参派生坐标')
  assert.match(
    block,
    /\.\.\.\(evidenceRefs !== undefined \? \{ evidenceRefs \} : \{\}\)/,
    '坐标必须真的并入 store.remember 的草稿（只算不传 = 白算）',
  )
  // 反向：不许出现「取当前活跃会话」这类兜底——它会把写入记到别人身上
  assert.doesNotMatch(block, /agents\.list\(\)[\s\S]{0,200}sessionId/, '不得用活跃会话兜底（宁缺不猜）')
})

// ---------- A259 归属：与坐标同源，且只盖它知道的 ----------

test('A259 authorOfSessionId：给了 sessionId 就盖，且只盖已知部分（不猜 preset / delegationDepth）', () => {
  // ① 有 sessionId ⇒ 归属的**已知部分**
  const a = authorOfSessionId(SID)
  assert.deepEqual(a, { sessionId: SID })
  // ② 不猜：服务通道不知道调用方是哪个 agent 预设、第几层委派 ⇒ 这两格必须**不出现**。
  //    出现一个猜的值比留空更坏——它会看起来像一条真归因。
  assert.equal('preset' in a, false, '不得猜 preset：调用方是插件，不是 agent 预设')
  assert.equal('delegationDepth' in a, false, '不得猜委派深度')
  // ③ 不给 / 空串 ⇒ undefined（宁缺不猜，与坐标同一条纪律）
  assert.equal(authorOfSessionId(undefined), undefined)
  assert.equal(authorOfSessionId(''), undefined)
  // ④ **同源**：对同一个输入，归属与坐标必须同向（同存同缺）——
  //    这是本判据的核心：两处若各自演化，同一条库里的归属精度会落后于坐标精度。
  for (const input of [SID, undefined, '']) {
    const hasRefs = evidenceRefsOfSessionId(input, () => 1) !== undefined
    const hasAuthor = authorOfSessionId(input) !== undefined
    assert.equal(hasAuthor, hasRefs, `归属与坐标必须同源（同存同缺）：input=${JSON.stringify(input)}`)
  }
})

test('A259b 服务接口接线：author 由同一个入参派生，且真的并入 store.remember 草稿', () => {
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  const provideAt = src.indexOf("ctx.provide('memoryApi'")
  assert.ok(provideAt > 0, 'memoryApi 服务必须存在')
  const block = src.slice(provideAt, provideAt + 4000)
  assert.match(block, /authorOfSessionId\(input\.sessionId\)/, '必须由同一个入参派生归属')
  assert.match(
    block,
    /\.\.\.\(author !== undefined \? \{ author \} : \{\}\)/,
    '归属必须真的并入 store.remember 的草稿（只算不传 = 白算）',
  )
})
