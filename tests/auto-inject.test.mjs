/**
 * L3 测试：自动 recall 注入（node:test，离线）——lastUserMessageText + buildAutoRecallDigest
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lastUserMessageText, buildAutoRecallDigest } from '../lib/auto-inject.js'

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

// ---------- lastUserMessageText ----------

test('lastUserMessageText：取最后一条真实用户消息（kind=user）', () => {
  const messages = [
    { id: 'a', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '旧消息' }] },
    { id: 'b', role: 'user', source: { kind: 'tool' }, content: [{ type: 'tool-result', toolCallId: 't1' }] },
    { id: 'c', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '新消息' }] },
  ]
  const found = lastUserMessageText(messages)
  assert.equal(found.id, 'c')
  assert.equal(found.text, '新消息')
})

test('lastUserMessageText：无真实用户消息返回 undefined', () => {
  const messages = [
    { id: 'a', role: 'user', source: { kind: 'tool' }, content: [] },
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

test('lastUserMessageText：Telegram 收件可触发（plugin=dsh-agent-telegram）', () => {
  const messages = [
    { id: 't', role: 'user', source: { kind: 'plugin', plugin: 'dsh-agent-telegram' }, content: [{ type: 'text', text: '[telegram] 启动comfyUI' }] },
  ]
  const found = lastUserMessageText(messages)
  assert.equal(found.id, 't')
  assert.equal(found.text, '启动comfyUI') // [telegram] 前缀被剥掉
})

test('lastUserMessageText：其他 plugin 注入不触发（不要什么消息都返回记忆）', () => {
  const messages = [
    { id: 'x', role: 'user', source: { kind: 'plugin', plugin: 'dsh-agent-other' }, content: [{ type: 'text', text: '其他插件消息' }] },
    { id: 'y', role: 'user', source: { kind: 'tool' }, content: [{ type: 'tool-result', toolCallId: 't2' }] },
  ]
  assert.equal(lastUserMessageText(messages), undefined)
})

test('lastUserMessageText：GUI 与 Telegram 混合 → 取最新一条可触发来源', () => {
  const messages = [
    { id: 'g', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'GUI 消息' }] },
    { id: 't', role: 'user', source: { kind: 'plugin', plugin: 'dsh-agent-telegram' }, content: [{ type: 'text', text: '[telegram] 电报消息' }] },
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
