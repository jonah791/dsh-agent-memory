/**
 * v0.2 测试：启动注入 buildMemoryDigest 纯函数 + 压缩即记忆（node:test，离线）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildMemoryDigest } from '../lib/inject.js'

function entry(partial) {
  return {
    kind: 'knowledge',
    tags: [],
    body: '',
    scope: 'c:/proj',
    updatedAt: partial.createdAt,
    accessedAt: partial.createdAt,
    level: null,
    bucket: null,
    archived: false,
    ...partial,
  }
}

const OPTS = { maxBytes: 3000, maxEntries: 20 }

test('digest：global fact 全量 + 概要先 + 近期明细', () => {
  const globalFacts = [
    entry({ id: 'f1', title: '主人偏好：中文', createdAt: '2026-08-14T00:00:00.000Z', kind: 'fact', scope: 'global' }),
  ]
  const scopeEntries = [
    entry({ id: 'w', title: '周概要', createdAt: '2026-08-14T00:00:00.000Z', kind: 'summary', level: 'week', bucket: '2026-W33' }),
    entry({ id: 'e', title: '昨天完成压缩插件', createdAt: '2026-08-13T00:00:00.000Z', kind: 'episodic' }),
  ]
  const text = buildMemoryDigest(globalFacts, scopeEntries, OPTS)
  assert.ok(text.includes('主人偏好：中文'))
  // 概要在明细前
  const wi = text.indexOf('周概要')
  const ei = text.indexOf('昨天完成压缩插件')
  assert.ok(wi >= 0 && ei > wi)
  assert.ok(text.includes('<system-reminder>'))
})

test('digest：maxEntries 截断并提示省略', () => {
  const many = Array.from({ length: 30 }, (_, i) =>
    entry({ id: 'e' + i, title: '条目' + i, createdAt: '2026-08-01T00:00:00.000Z', kind: 'episodic' }))
  const text = buildMemoryDigest([], many, { maxBytes: 100000, maxEntries: 10 })
  const omitted = text.match(/另有 (\d+) 条未列出/)
  assert.ok(omitted !== null)
  assert.equal(Number(omitted[1]), 20)
})

test('digest：maxBytes 截断', () => {
  const many = Array.from({ length: 50 }, (_, i) =>
    entry({ id: 'e' + i, title: '长条目'.repeat(10) + i, createdAt: '2026-08-01T00:00:00.000Z', kind: 'episodic' }))
  const text = buildMemoryDigest([], many, { maxBytes: 200, maxEntries: 100 })
  // 帧开销上界 = `<system-reminder>` 标签 + header + `（dsh-agent-memory）：` + 数据边界声明 + 空行。
  // v0.48 起含方案 §11.3 的数据定性声明，上界由 80 抬到 110——**它仍是守门人**：
  // 再抬就该回答「是不是又往帧里加了东西、为什么」。不改成「跟随实现自动推导」，
  // 那等于让被守的东西自己守自己。
  assert.ok(text.length <= 200 + 110, `帧开销超界：实测 ${text.length - 200}`)
  assert.ok(text.includes('预算截断'))
})

test('digest：空记忆返回空串', () => {
  assert.equal(buildMemoryDigest([], [], OPTS), '')
})

test('digest：归档条目不出现', () => {
  const scopeEntries = [
    entry({ id: 'a', title: '活跃条目', createdAt: '2026-08-14T00:00:00.000Z' }),
    entry({ id: 'b', title: '已归档', createdAt: '2026-08-13T00:00:00.000Z', archived: true }),
  ]
  const text = buildMemoryDigest([], scopeEntries, OPTS)
  assert.ok(text.includes('活跃条目'))
  assert.ok(!text.includes('已归档'))
})

// ---------- v0.59：注入面的证据引用（方案 §8.5「上下文包」）----------
// 为什么在这条路径上补：速览是每个会话最先看到的文本，而「这条能回到哪」此前在这一面
// 完全没有入口。判据参照 v0.58 的 evidenceTag 契约（同会话省号 / 异会话印短号 / 不知道不省）。

const SID = 'session-cc8272d8-5195-4a34-a683-455cf5f12671'
const OTHER_SID = 'session-9f3a1b2c-0000-1111-2222-333344445555'

function withEvidence() {
  return [entry({
    id: 'ev', title: '带证据的条目', createdAt: '2026-08-14T00:00:00.000Z',
    evidenceRefs: [`session|${SID}|33847`],
  })]
}

test('digest I1：同会话 ⇒ 省会话号（⚓@N），字节花在会改变动作的信息上', () => {
  const text = buildMemoryDigest([], withEvidence(), { ...OPTS, currentSessionId: SID })
  assert.ok(text.includes('⚓@33847'), '同会话应省掉会话号')
})

test('digest I2：异会话 / 未给当前会话 ⇒ 印短号（不省，否则静默读错位置）', () => {
  assert.ok(
    buildMemoryDigest([], withEvidence(), { ...OPTS, currentSessionId: OTHER_SID }).includes('⚓cc8272d8@33847'),
    '异会话必须印号',
  )
  assert.ok(
    buildMemoryDigest([], withEvidence(), OPTS).includes('⚓cc8272d8@33847'),
    '不知道当前会话时不许省——「不知道」与「就是当前会话」是两件事',
  )
})

test('digest I3 尸体样本：无证据的条目行形状不变（零回归，不骗人）', () => {
  const plain = entry({ id: 'p', title: '没有证据的条目', createdAt: '2026-08-14T00:00:00.000Z' })
  const line = buildMemoryDigest([], [plain], { ...OPTS, currentSessionId: SID })
    .split('\n').find((l) => l.includes('没有证据的条目'))
  assert.ok(line !== undefined)
  assert.ok(!line.includes('⚓'), '没有坐标就不许打证据标记')
})

test('digest I6：validAfter 有值时印「自…起成立」（v0.59 · 方案 §8.5 有效时间）', () => {
  const e = entry({ id: 'va', title: '某规则从下周起生效', createdAt: '2026-08-14T00:00:00.000Z', validAfter: '2026-11-25' })
  const line = buildMemoryDigest([], [e], OPTS).split('\n').find((l) => l.includes('某规则从下周起生效'))
  assert.ok(line !== undefined)
  assert.ok(line.includes('[自 2026-11-25 起成立]'), '生效起点要能被看见')
  // 无 validAfter 的条目不许带这段（同一条信噪比纪律）
  const plain = entry({ id: 'nv', title: '普通条目', createdAt: '2026-08-14T00:00:00.000Z' })
  const line2 = buildMemoryDigest([], [plain], OPTS).split('\n').find((l) => l.includes('普通条目'))
  assert.ok(!line2.includes('起成立'))
})
