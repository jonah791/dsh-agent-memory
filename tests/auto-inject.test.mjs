/**
 * L3 测试：自动 recall 注入（node:test，离线）——lastUserMessageText + buildAutoRecallDigest
 *
 * 0.1.7 契约（2026-09-23 修）：`MessageSourceMap.plugin` 已移除，生产者按自身 kind 声明来源
 * （dsh-agent-telegram 现发 `source: { kind: 'dsh-agent-telegram' }`，证据 dsh-agent-telegram/src/index.ts:767）；
 * `tool/result` 消息的 role 由 'user' 变 'tool'、块上提到 message 顶层。夹具已同步，并含 v3 形状**尸体样本**。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lastUserMessageText, buildAutoRecallDigest, filterFresh, worthInjecting } from '../lib/auto-inject.js'

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

// ---------- filterFresh（v0.8 会话级去重）----------
// 动机（2026-09-26 实测）：646 次 auto 注入共 1930 条目计次、唯一仅 432 ⇒ 77.6% 重复，
// 最高一条被注入 158 次。去重后只有新信息占上下文。

test('filterFresh：剔除本会话已注入过的条目，未注入的保序保留', () => {
  const entries = [
    entry({ id: 'a', title: 'A', createdAt: '2026-09-26T00:00:00.000Z' }),
    entry({ id: 'b', title: 'B', createdAt: '2026-09-26T00:00:00.000Z' }),
    entry({ id: 'c', title: 'C', createdAt: '2026-09-26T00:00:00.000Z' }),
  ]
  // 修复前：不剔除 ⇒ ['a','b','c'] 每次全量重注（判据的区分力所在）
  assert.deepEqual(filterFresh(entries, new Set(['a', 'c'])).map((e) => e.id), ['b'])
})

test('filterFresh：全部命中都是旧的 → 空数组（调用方据此静默跳过，零 token 浪费）', () => {
  const entries = [entry({ id: 'hot', title: 'Hot', createdAt: '2026-09-26T00:00:00.000Z' })]
  assert.deepEqual(filterFresh(entries, new Set(['hot'])), [])
})

test('filterFresh：空注入集不改变输入（会话首轮行为与去重前一致）', () => {
  const entries = [
    entry({ id: 'a', title: 'A', createdAt: '2026-09-26T00:00:00.000Z' }),
    entry({ id: 'b', title: 'B', createdAt: '2026-09-26T00:00:00.000Z' }),
  ]
  assert.deepEqual(filterFresh(entries, new Set()).map((e) => e.id), ['a', 'b'])
})

// ---------- worthInjecting（v0.9 最低分门）----------
// 门槛来源（可复核）：874 条真实语料上 9 个查询的分布——
//   无指向：继续 8.4 / 相关度算法可以再改进改进 18.4 / 看看这个项目 25.0
//   有指向：哨兵重启静默不生效 38.2 / auto-recall 去重 57.5 / MemOS 评估 82.5 / 技能生命周期 106.3
// 间隔落在 25–38 之间 ⇒ 取 30。样本量有限，已在源码里标注「需重新校准」的条件。

test('worthInjecting：top1 低于门槛 ⇒ 不注入（宁可不打扰）', () => {
  assert.equal(worthInjecting([{ score: 18.4 }, { score: 18.1 }], 30), false, '实测「相关度算法可以再改进改进」18.4')
  assert.equal(worthInjecting([{ score: 25.0 }], 30), false, '实测「看看这个项目」25.0')
})

test('worthInjecting：达到门槛 ⇒ 注入（含边界）', () => {
  assert.equal(worthInjecting([{ score: 38.2 }], 30), true, '实测「哨兵重启静默不生效」38.2')
  assert.equal(worthInjecting([{ score: 30 }], 30), true, '等于门槛应放行')
})

test('worthInjecting：门槛 ≤0 ⇒ 关闭该门（全放行）', () => {
  assert.equal(worthInjecting([{ score: 0 }], 0), true)
})

test('worthInjecting：空结果 ⇒ 不注入', () => {
  assert.equal(worthInjecting([], 30), false)
})

// ---------- lastUserMessageText ----------

test('lastUserMessageText：取最后一条真实用户消息（kind=user）', () => {
  const messages = [
    { id: 'a', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '旧消息' }] },
    { id: 'b', role: 'tool', source: { kind: 'tool' }, toolCallId: 't1', content: [{ type: 'text', text: '工具结果' }] },
    { id: 'c', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '新消息' }] },
  ]
  const found = lastUserMessageText(messages)
  assert.equal(found.id, 'c')
  assert.equal(found.text, '新消息')
})

test('lastUserMessageText：无真实用户消息返回 undefined', () => {
  const messages = [
    { id: 'a', role: 'tool', source: { kind: 'tool' }, toolCallId: 't0', content: [] },
    { id: 'b', role: 'assistant', source: { kind: 'model', provider: 'x', model: 'y' }, content: [] },
  ]
  assert.equal(lastUserMessageText(messages), undefined)
})

test('lastUserMessageText：空文本消息跳过，继续向前找', () => {
  const messages = [
    { id: 'a', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '  ' }] },
    { id: 'b', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '有效' }] },
  ]
  const found = lastUserMessageText(messages)
  assert.equal(found.id, 'b')
})

test('lastUserMessageText：多 text block 拼接', () => {
  const messages = [
    { id: 'a', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }] },
  ]
  const found = lastUserMessageText(messages)
  assert.equal(found.text, '第一段\n第二段')
})

test('lastUserMessageText：Telegram 收件可触发（kind=dsh-agent-telegram，0.1.7 形状）', () => {
  const messages = [
    { id: 't', role: 'user', source: { kind: 'dsh-agent-telegram' }, content: [{ type: 'text', text: '[telegram] 启动comfyUI' }] },
  ]
  const found = lastUserMessageText(messages)
  assert.equal(found.id, 't')
  assert.equal(found.text, '启动comfyUI') // [telegram] 前缀被剥掉
})

test('尸体样本：v3 形状（kind=plugin + plugin 字段）**不**触发——0.1.7 已移除该 source 形状', () => {
  const messages = [
    { id: 'v3', role: 'user', source: { kind: 'plugin', plugin: 'dsh-agent-telegram' }, content: [{ type: 'text', text: '[telegram] 旧形状' }] },
  ]
  assert.equal(lastUserMessageText(messages), undefined)
})

test('lastUserMessageText：其他插件注入不触发（不要什么消息都返回记忆）', () => {
  const messages = [
    { id: 'x', role: 'user', source: { kind: 'dsh-agent-other' }, content: [{ type: 'text', text: '其他插件消息' }] },
    { id: 'y', role: 'tool', source: { kind: 'tool' }, toolCallId: 't2', content: [{ type: 'text', text: '工具结果' }] },
  ]
  assert.equal(lastUserMessageText(messages), undefined)
})

test('lastUserMessageText：GUI 与 Telegram 混合 → 取最新一条可触发来源', () => {
  const messages = [
    { id: 'g', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'GUI 消息' }] },
    { id: 't', role: 'user', source: { kind: 'dsh-agent-telegram' }, content: [{ type: 'text', text: '[telegram] 电报消息' }] },
  ]
  const found = lastUserMessageText(messages)
  assert.equal(found.id, 't')
  assert.equal(found.text, '电报消息')
})

// ---------- buildAutoRecallDigest ----------

test('digest：有命中 → 渲染相关记忆帧', () => {
  const entries = [
    entry({ id: 'k1', title: 'ComfyUI 生图经验', createdAt: '2026-08-31T00:00:00.000Z', body: 'anima-v2 工作流骨架' }),
  ]
  const text = buildAutoRecallDigest(entries, 'ComfyUI 怎么生图', { maxEntries: 3, maxBytes: 1500 })
  assert.ok(text.includes('<system-reminder>'))
  assert.ok(text.includes('ComfyUI 生图经验'))
  assert.ok(text.includes('相关记忆'))
})

test('digest：无命中返回空串', () => {
  const entries = [
    entry({ id: 'k1', title: '守护审计', createdAt: '2026-08-31T00:00:00.000Z', body: '三件套健壮性' }),
  ]
  const text = buildAutoRecallDigest(entries, '量子物理', { maxEntries: 3, maxBytes: 1500 })
  assert.equal(text, '')
})

test('digest：空 query 返回空串', () => {
  assert.equal(buildAutoRecallDigest([], '   ', { maxEntries: 3, maxBytes: 1500 }), '')
})

test('digest：maxEntries 截断（只取 top N）', () => {
  const many = Array.from({ length: 5 }, (_, i) =>
    entry({ id: 'e' + i, title: '经验' + i, createdAt: '2026-08-01T00:00:00.000Z', body: '内容 经验' + i }))
  const text = buildAutoRecallDigest(many, '经验', { maxEntries: 2, maxBytes: 1500 })
  const count = (text.match(/\[KNOWLEDGE\]/g) ?? []).length
  assert.ok(count <= 2)
  assert.ok(text.includes('经验0'))
  assert.ok(text.includes('经验1'))
})

test('digest：maxBytes 截断并提示', () => {
  const many = Array.from({ length: 10 }, (_, i) =>
    entry({ id: 'e' + i, title: '超长经验' + '内容'.repeat(30) + i, createdAt: '2026-08-01T00:00:00.000Z', body: '正文'.repeat(50) }))
  const text = buildAutoRecallDigest(many, '经验 内容 正文', { maxEntries: 10, maxBytes: 300 })
  assert.ok(text.includes('预算截断'))
})

test('digest：长 query 截断到 QUERY_MAX 再检索', () => {
  const entries = [entry({ id: 'k1', title: '独特词', createdAt: '2026-08-01T00:00:00.000Z', body: '独特词 内容' })]
  const longQuery = '独特词' + '填充词'.repeat(300)
  const text = buildAutoRecallDigest(entries, longQuery, { maxEntries: 3, maxBytes: 1500 })
  // 独特词在最前 200 字符内，中文 bigram 应命中
  assert.ok(text.includes('独特词'))
})

test('digest：中文整句 query 经 bigram 命中（无空格分词增强）', () => {
  const entries = [entry({ id: 'k1', title: '守护体系基线', createdAt: '2026-08-31T00:00:00.000Z', body: 'watch 35656 → web 37860，HTTP 401 健康' })]
  // 天然中文整句，无空格：tokenize 走 CJK bigram，应命中标题子串
  const text = buildAutoRecallDigest(entries, '帮我看一下守护体系现在是什么状态', { maxEntries: 3, maxBytes: 1500 })
  assert.ok(text.includes('守护体系基线'))
})
