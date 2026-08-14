/**
 * v0.2 测试：压缩即记忆状态机（node:test，离线，fake store）
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
    return { id: 'x', action: 'created' }
  }
  // MemoryStore 其余接口未用到
  list() { return [] }
}

/** 事件发射器：模拟 ctx.on('session/event') 订阅 */
function harness() {
  const store = new FakeStore()
  const listeners: Array<(session: any, event: any) => void> = []
  const ctx = {
    on: (name: string, fn: (session: any, event: any) => void) => {
      if (name === 'session/event') listeners.push(fn)
      return () => { /* noop */ }
    },
  } as unknown as Context
  installCompactionSink(ctx, { store: store as unknown as MemoryStore })
  const session = { id: 'sess-1', header: { cwd: 'C:\\Users\\Alice\\proj' } }
  const fire = (event: any) => { for (const fn of listeners) fn(session, event) }
  return { store, fire }
}

test('压缩成功 → checkpoint 落库为 episodic（workspace scope，tags=compaction）', () => {
  const { store, fire } = harness()
  fire({ type: 'compaction/start', data: { compactionId: 'c1', sourceCommandId: 'cmd-1' } })
  fire({ type: 'compaction/summary', data: { compactionId: 'c1', summary: [{ type: 'text', text: '## 摘要\n本周完成了记忆插件。' }] } })
  fire({ type: 'compaction/end', data: { compactionId: 'c1', sourceCommandId: 'cmd-1' } })
  assert.equal(store.remembered.length, 1)
  const r = store.remembered[0]!
  assert.equal(r.scope, 'c:/Users/Alice/proj')
  assert.deepEqual(r.tags, ['compaction'])
  assert.ok(r.title.startsWith('会话压缩检查点'))
  assert.ok(r.body.includes('本周完成了记忆插件'))
})

test('压缩失败（end 带 error）→ 不落库', () => {
  const { store, fire } = harness()
  fire({ type: 'compaction/start', data: { compactionId: 'c1' } })
  fire({ type: 'compaction/summary', data: { compactionId: 'c1', summary: [{ type: 'text', text: '摘要' }] } })
  fire({ type: 'compaction/end', data: { compactionId: 'c1', error: 'DeepSeek API request failed' } })
  assert.equal(store.remembered.length, 0)
})

test('无 summary 或空摘要 → 不落库', () => {
  const { store, fire } = harness()
  fire({ type: 'compaction/start', data: { compactionId: 'c1' } })
  fire({ type: 'compaction/end', data: { compactionId: 'c1' } })
  assert.equal(store.remembered.length, 0)
})

test('非 compaction 事件不影响状态', () => {
  const { store, fire } = harness()
  fire({ type: 'turn/start', data: {} })
  fire({ type: 'user/message', data: {} })
  assert.equal(store.remembered.length, 0)
})