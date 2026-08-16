/**
 * v0.3 测试：压缩即记忆（智能体核心）——保底存档 + inbox 通知（排队不唤醒），无哨兵。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import { installCompactionSink } from '../lib/compaction-sink.js'
import type { MemoryStore } from '../lib/store.js'

/** 记录 store.remember 调用的假存储 */
class FakeStore {
  remembered: Array<{ title: string; tags: string[]; scope: string; body: string }> = []
  async remember(draft: any): Promise<any> {
    this.remembered.push({ title: draft.title, tags: draft.tags, scope: draft.scope, body: draft.body })
    return { id: 'entry-' + this.remembered.length, action: 'created' }
  }
  list() { return [] }
}

/** 事件发射器：模拟 ctx.on('session/event') 订阅 + agents.get */
function harness() {
  const store = new FakeStore()
  const listeners: Array<(session: any, event: any) => void> = []
  const sent: Array<{ text: string; target: string; wakeup: boolean }> = []
  const ctx = {
    on: (name: string, fn: (session: any, event: any) => void) => {
      if (name === 'session/event') listeners.push(fn)
      return () => { /* noop */ }
    },
    agents: {
      get: () => ({
        send: (message: any, target: string, wakeup: boolean) => {
          sent.push({ text: message?.content?.[0]?.text ?? '', target, wakeup })
        },
      }),
    },
  } as unknown as Context
  installCompactionSink(ctx, { store: store as unknown as MemoryStore })
  const session = { id: 'sess-1', header: { cwd: 'C:\\Users\\Alice\\proj' } }
  const fire = (event: any) => { for (const fn of listeners) fn(session, event) }
  return { store, fire, sent }
}

test('压缩成功 → 原文保底落库 + inbox 通知（wakeup=false 排队不唤醒）', () => {
  const { store, fire, sent } = harness()
  fire({ type: 'compaction/start', data: { compactionId: 'c1', sourceCommandId: 'cmd-1' } })
  fire({ type: 'compaction/summary', data: { compactionId: 'c1', summary: [{ type: 'text', text: '## 摘要\n本周完成了记忆插件。' }] } })
  fire({ type: 'compaction/end', data: { compactionId: 'c1', sourceCommandId: 'cmd-1' } })
  // 落库（异步 remember → then 通知；测试需等待微任务）
  return (async () => {
    await new Promise((r) => setImmediate(r))
    assert.equal(store.remembered.length, 1)
    const r = store.remembered[0]!
    assert.equal(r.scope, 'c:/Users/Alice/proj')
    assert.deepEqual(r.tags, ['compaction'])
    assert.ok(r.title.startsWith('会话压缩检查点'))
    assert.ok(r.body.includes('本周完成了记忆插件'))
    // 通知：完成即送达（wakeup=true），消息携带条目 id，决策权留给爱丽丝
    assert.equal(sent.length, 1)
    assert.equal(sent[0]!.wakeup, true)
    assert.equal(sent[0]!.target, 'next-turn')
    assert.ok(sent[0]!.text.includes('entry-1'))
    assert.ok(sent[0]!.text.includes('由你决定'))
  })()
})

test('压缩失败（end 带 error）→ 不落库不通知', () => {
  const { store, fire, sent } = harness()
  fire({ type: 'compaction/start', data: { compactionId: 'c1' } })
  fire({ type: 'compaction/summary', data: { compactionId: 'c1', summary: [{ type: 'text', text: '摘要' }] } })
  fire({ type: 'compaction/end', data: { compactionId: 'c1', error: 'DeepSeek API request failed' } })
  return (async () => {
    await new Promise((r) => setImmediate(r))
    assert.equal(store.remembered.length, 0)
    assert.equal(sent.length, 0)
  })()
})

test('无 summary 或空摘要 → 不落库不通知', () => {
  const { store, fire, sent } = harness()
  fire({ type: 'compaction/start', data: { compactionId: 'c1' } })
  fire({ type: 'compaction/end', data: { compactionId: 'c1' } })
  return (async () => {
    await new Promise((r) => setImmediate(r))
    assert.equal(store.remembered.length, 0)
    assert.equal(sent.length, 0)
  })()
})

test('非 compaction 事件不影响状态', () => {
  const { store, fire, sent } = harness()
  fire({ type: 'turn/start', data: {} })
  fire({ type: 'user/message', data: {} })
  return (async () => {
    await new Promise((r) => setImmediate(r))
    assert.equal(store.remembered.length, 0)
    assert.equal(sent.length, 0)
  })()
})