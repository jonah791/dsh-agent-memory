/**
 * v0.3 测试：压缩即记忆（智能体核心）——保底存档 + inbox 通知（`wakeup=true` 完成即送达），无哨兵。
 *
 * v0.11.3 追加（2026-11-12 · 台账 lh-2659bafb）：**落库失败不许空吞**。
 * 旧实现在 `.catch(() => {})` 里把错误吞掉，于是「提交了但没入档」既无日志、无通知、也无可查记录；
 * 而文件头注释还声称「幂等，下次压缩再试」——**那是假的**：pending 记录在 `compaction/end`
 * 时已被删除，下一轮压缩是新 `compactionId` ⇒ 这条原文永不重试。本组夹具把「失败必须可见」钉住。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { installCompactionSink, formatLocalStamp, utcOffsetLabel, describeSinkError } from '../lib/compaction-sink.js'
import type { MemoryStore } from '../lib/store.js'

/** 记录 store.remember 调用的假存储 */
class FakeStore {
  remembered: Array<{ title: string; tags: string[]; scope: string; body: string }> = []
  /** 非空 ⇒ remember 一律 reject（尸体夹具：模拟落库失败） */
  failWith: string | null = null
  async remember(draft: any): Promise<any> {
    if (this.failWith !== null) throw new Error(this.failWith)
    this.remembered.push({ title: draft.title, tags: draft.tags, scope: draft.scope, body: draft.body })
    return { id: 'entry-' + this.remembered.length, action: 'created' }
  }
  list() { return [] }
}

/** 事件发射器：模拟 ctx.on('session/event') 订阅 + agents.get */
function harness(opts: { failureTracePath?: string } = {}) {  const store = new FakeStore()
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
  installCompactionSink(ctx, {
    store: store as unknown as MemoryStore,
    ...(opts.failureTracePath === undefined ? {} : { failureTracePath: opts.failureTracePath }),
  })
  const session = { id: 'sess-1', header: { cwd: 'C:\\Users\\Alice\\proj' } }
  const fire = (event: any) => { for (const fn of listeners) fn(session, event) }
  return { store, fire, sent }
}

test('压缩成功 → 原文保底落库 + inbox 通知（wakeup=true 完成即送达）', () => {
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
    // v0.22.1（2026-11-12）：检查点落库即带**冷存档标签**——它从一落库起就退出活跃检索面
    // （读数与理由见 types.ts::COLD_CHECKPOINT_TAG）。断言两个标签都在；顺序无关，故排序后比。
    assert.deepEqual([...r.tags].sort(), ['checkpoint-archive', 'compaction'].sort())
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

// ── 落库失败必须可见（2026-11-12 · 台账 lh-2659bafb） ─────────────────────────────

/**
 * 等侧车文件出现**完整的一行**（有界轮询，最多 ~2s）。
 *
 * 为什么不能只等两拍 `setImmediate`：侧车写入是真的 `fs.appendFile`（异步 IO），
 * 两拍微任务不足以保证落盘 —— 实测会读到「文件已建、内容还没写」的空文件。
 * 这里用「内容出现」当判据，不用固定时长；超时返回空串由断言去红（不吞）。
 */
async function waitForLines(file: string, timeoutMs = 2000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let text = ''
    try { text = readFileSync(file, 'utf8') } catch { text = '' }
    const lines = text.split('\n').filter((l) => l.trim() !== '')
    if (lines.length > 0) return lines
    if (Date.now() > deadline) return []
    await new Promise((r) => setTimeout(r, 10))
  }
}

test('★ 尸体：落库失败 ⇒ 侧车 JSONL 落一条（compactionId + 错误 + 时间），不许空吞', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'compaction-sink-'))
  const trace = join(dir, 'failures.jsonl')
  const { store, fire, sent } = harness({ failureTracePath: trace })
  store.failWith = 'disk I/O error: ENOSPC'
  fire({ type: 'compaction/start', data: { compactionId: 'c-fail-1' } })
  fire({ type: 'compaction/summary', data: { compactionId: 'c-fail-1', summary: [{ type: 'text', text: '摘要' }] } })
  const before = Date.now()
  fire({ type: 'compaction/end', data: { compactionId: 'c-fail-1' } })
  const lines = await waitForLines(trace)
  assert.equal(lines.length, 1, '落库失败必须正好落一条证据（空吞时这里会是 0 行）')
  const rec = JSON.parse(lines[0]!)
  assert.equal(rec.compactionId, 'c-fail-1', '侧车必须带 compactionId（排查的第一把钥匙）')
  assert.match(String(rec.error), /ENOSPC/, '错误原文必须留下来')
  assert.equal(typeof rec.atMs, 'number')
  assert.ok(rec.atMs >= before, 'atMs 必须是这次失败的时刻')
  assert.equal(rec.sessionId, 'sess-1')
  assert.equal(rec.scope, 'c:/Users/Alice/proj')
  // 失败时不得通知（原文没进库，通知「已存档」就是假话）
  assert.equal(sent.length, 0, '落库失败不得发「已存档」通知')
})

test('成功路径不写失败侧车（避免侧车被正常流量灌满）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'compaction-sink-ok-'))
  const trace = join(dir, 'failures.jsonl')
  const { fire, sent } = harness({ failureTracePath: trace })
  fire({ type: 'compaction/start', data: { compactionId: 'c-ok' } })
  fire({ type: 'compaction/summary', data: { compactionId: 'c-ok', summary: [{ type: 'text', text: '摘要' }] } })
  fire({ type: 'compaction/end', data: { compactionId: 'c-ok' } })
  await new Promise((r) => setImmediate(r))
  let text = ''
  try { text = readFileSync(trace, 'utf8') } catch { text = '' }
  assert.equal(text.trim(), '', '成功路径不得写侧车')
  assert.equal(sent.length, 1)
})

test('未配侧车路径 ⇒ 不崩（静默降级可接受，但生产装配必须给路径）', async () => {
  const { store, fire } = harness()
  store.failWith = 'boom'
  fire({ type: 'compaction/start', data: { compactionId: 'c-nopath' } })
  fire({ type: 'compaction/summary', data: { compactionId: 'c-nopath', summary: [{ type: 'text', text: '摘要' }] } })
  fire({ type: 'compaction/end', data: { compactionId: 'c-nopath' } })
  await new Promise((r) => setImmediate(r))
  assert.equal(store.remembered.length, 0)
})

test('describeSinkError：Error / 字符串 / 非 Error 值 / 空值都能规整成非空文本', () => {
  assert.equal(describeSinkError(new Error('ENOSPC')), 'ENOSPC')
  assert.equal(describeSinkError(new Error('')), 'Error', '空 message 退到 name，不返回空串')
  assert.equal(describeSinkError('raw string'), 'raw string')
  assert.equal(describeSinkError({ code: 42 }), '[object Object]')
  assert.equal(describeSinkError(undefined), 'undefined')
  assert.equal(describeSinkError(''), '(空字符串错误)')
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

test('标题自带时区标注（本地时间 + UTC 偏移 · 读数范围可判）', () => {
  const firedAt = Date.now()
  const { store, fire } = harness()
  fire({ type: 'compaction/start', data: { compactionId: 'c1' } })
  fire({ type: 'compaction/summary', data: { compactionId: 'c1', summary: [{ type: 'text', text: '摘要' }] } })
  fire({ type: 'compaction/end', data: { compactionId: 'c1' } })
  return (async () => {
    await new Promise((r) => setImmediate(r))
    const title = store.remembered[0]!.title
    // 形态：`会话压缩检查点 · YYYY-MM-DD UTC±hh:mm`（**日粒度**）。
    // ⚠ 2026-10-14 对齐（**预先存在的债**，非本轮引入）：原断言期望**分钟粒度**
    // （`YYYY-MM-DD hh:mm UTC±hh:mm`），而实现自 2026-09-26 起刻意改为**日粒度**
    // ——后者是 checkpoint 的**合并键**，让同日多次压缩落到同一条（否则 8.5 小时落 6 条
    // 平行快照，见 `dayStampOf` 的注释与实测）。⇒ 改测试，不改实现。
    const m = /^会话压缩检查点 · (\d{4})-(\d{2})-(\d{2}) UTC([+-])(\d{2}):(\d{2})$/.exec(title)
    if (m === null) assert.fail('标题缺时区标注：' + title)
    // round-trip（日粒度）：标题里的「本地日 + 偏移」折回 UTC，建档时刻必须落在那一天之内
    const offMinutes = (m[4]! === '-' ? -1 : 1) * (Number(m[5]) * 60 + Number(m[6]))
    const localDayStartUtc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - offMinutes * 60_000
    assert.ok(
      firedAt >= localDayStartUtc && firedAt < localDayStartUtc + 86_400_000,
      '标题日期与建档时刻不符：' + title,
    )
  })()
})

test('utcOffsetLabel 尸体样本：正 / 负 / 半小时时区（平台无关）', () => {
  assert.equal(utcOffsetLabel(480), 'UTC+08:00')
  assert.equal(utcOffsetLabel(-300), 'UTC-05:00')
  assert.equal(utcOffsetLabel(330), 'UTC+05:30')
  assert.equal(utcOffsetLabel(0), 'UTC+00:00')
})

test('formatLocalStamp：分钟精度（秒与毫秒截断）· 偏移取自同一真源', () => {
  const d = new Date(2026, 8, 22, 5, 35, 47, 123)
  assert.equal(formatLocalStamp(d), '2026-09-22 05:35 ' + utcOffsetLabel(-d.getTimezoneOffset()))
})