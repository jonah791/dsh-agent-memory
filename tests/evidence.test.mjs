/**
 * 证据层单测（v0.25.0）——条目能回到哪里。
 * 运行：npm test（tsc 后 node --test "tests/*.test.mjs"，导入编译产物 lib/*.js）
 *
 * 覆盖：
 *   E1 新建写入：evidenceRefs 落盘、读回仍在（端到端，走真 store + 内存 kv）
 *   E2 合并路径：证据按**并集**累积、同一条去重、上限 8
 *   E3 编码/解析往返 + 渲染（有 seq → `⚓会话@N`；只有压缩 → `⚓压缩`；坏串 → 空）
 *   E4 投影：recall 结果项里带 evidenceRefs（漏这一层就是「存了没人看得见」）
 *   E5 尸体样本：无证据的存量条目，结果项不含该键（零回归）
 *
 * ⚠ 落盘是**编码字符串**不是对象：本仓 schema DSL 不支持嵌套对象（详见 types.ts::EvidenceKind）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore, MAX_EVIDENCE_REFS, mergeEvidence } from '../lib/store.js'
import { recallEntries } from '../lib/search.js'
import { evidenceTag, formatEvidenceRef, parseEvidenceRef } from '../lib/evidence.js'

/** 内存 kv（同官方 storage-domain 测试模式） */
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

const SESSION = 'session-cc8272d8-5195-4a34-a683-455cf5f12671'

function makeStore() {
  return new MemoryStore(new MemoryKv())
}

test('E1 新建写入：证据坐标落盘且读回仍在', async () => {
  const store = makeStore()
  const refs = [formatEvidenceRef({ kind: 'session', sessionId: SESSION, seq: 33847 })]
  const { id, action } = await store.remember({
    kind: 'knowledge',
    title: '证据层落盘用例',
    body: '正文',
    tags: ['证据'],
    scope: 'global',
    level: null,
    bucket: null,
    evidenceRefs: refs,
  })
  assert.equal(action, 'created')
  assert.deepEqual(store.get('global', id)?.evidenceRefs, refs)
})

test('E2 合并路径：证据并集 + 去重 + 上限', async () => {
  const store = makeStore()
  const first = formatEvidenceRef({ kind: 'session', sessionId: 'session-a', seq: 1 })
  const second = formatEvidenceRef({ kind: 'session', sessionId: 'session-b', seq: 2 })
  const a = await store.remember({
    kind: 'knowledge', title: '同名合并键', body: 'x', tags: [], scope: 'global',
    level: null, bucket: null, evidenceRefs: [first],
  })
  // 同标题 ⇒ 走合并路径
  const b = await store.remember({
    kind: 'knowledge', title: '同名合并键', body: 'y', tags: [], scope: 'global',
    level: null, bucket: null, evidenceRefs: [second],
  })
  assert.equal(b.action, 'merged')
  assert.equal(b.id, a.id)
  assert.deepEqual(store.get('global', a.id)?.evidenceRefs, [first, second], '两侧证据都要在（并集，不是替换）')

  // 同一条证据不因重复写入占两个位置
  assert.deepEqual(mergeEvidence([first], [first, second]).evidenceRefs, [first, second])

  // 上限
  const many = Array.from({ length: MAX_EVIDENCE_REFS + 4 }, (_, i) => `session|s-${i}|${i}`)
  assert.equal(mergeEvidence(undefined, many).evidenceRefs.length, MAX_EVIDENCE_REFS)
  // 全空 ⇒ 不产生字段
  assert.equal(mergeEvidence(undefined, undefined), undefined)
  // 坏值（非字符串 / 空串）被跳过，不炸
  assert.equal(mergeEvidence(undefined, ['', null, first]).evidenceRefs.length, 1)
})

test('E3 编码往返 + 渲染', () => {
  const session = { kind: 'session', sessionId: 'sid-1', seq: 12 }
  const compaction = { kind: 'compaction', sessionId: 'sid-1', compactionId: 'cmp-9' }
  const derived = { kind: 'derived', locator: 'supersedes:abc' }
  for (const ref of [session, compaction, derived]) {
    assert.deepEqual(parseEvidenceRef(formatEvidenceRef(ref)), ref, `往返应无损：${formatEvidenceRef(ref)}`)
  }
  // 会话级（无 seq）
  assert.deepEqual(parseEvidenceRef('session|sid-2|'), { kind: 'session', sessionId: 'sid-2' })
  // 坏串一律 undefined（数据路径容错，不能抛）
  assert.equal(parseEvidenceRef(''), undefined)
  assert.equal(parseEvidenceRef('unknown|x|y'), undefined)
  assert.equal(parseEvidenceRef('session||'), undefined)
  assert.equal(parseEvidenceRef('compaction|sid-1|'), undefined)

  // 渲染：优先带事件号的那条
  assert.equal(evidenceTag(['session|sid-1|33847']), '⚓会话@33847')
  assert.equal(evidenceTag(['session|sid-1|']), '⚓会话')
  assert.equal(evidenceTag(['compaction|sid-1|cmp-9']), '⚓压缩')
  assert.equal(evidenceTag(['session|sid-1|', 'session|sid-1|7']), '⚓会话@7')
  assert.equal(evidenceTag([]), '')
  assert.equal(evidenceTag(undefined), '')
  assert.equal(evidenceTag(['garbage']), '', '全是坏串 ⇒ 不打标记（不骗人）')
})

test('E4 投影：recall 结果项带 evidenceRefs', async () => {
  const store = makeStore()
  const refs = [formatEvidenceRef({ kind: 'session', sessionId: SESSION, seq: 12 })]
  const { id } = await store.remember({
    kind: 'knowledge', title: '投影层判据用例', body: '投影层必须透出证据', tags: [], scope: 'global',
    level: null, bucket: null, evidenceRefs: refs,
  })
  const result = recallEntries(store.list('global', { includeArchive: false }), { query: '投影层判据' })
  const hit = result.results.find((item) => item.id === id)
  assert.ok(hit, '应能检索到该条目')
  assert.deepEqual(hit.evidenceRefs, refs)
})

test('E5 尸体样本：无证据的存量条目，结果项不含该键', async () => {
  const store = makeStore()
  await store.remember({
    kind: 'knowledge', title: '无证据的老条目', body: '存量形态', tags: [], scope: 'global', level: null, bucket: null,
  })
  const result = recallEntries(store.list('global', { includeArchive: false }), { query: '无证据的老条目' })
  const hit = result.results[0]
  assert.ok(hit)
  assert.equal('evidenceRefs' in hit, false, '没有证据就不出现该键（省略 = 不知道，不是空数组）')
})
