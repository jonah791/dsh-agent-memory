/**
 * 证据层单测（v0.25.0）——条目能回到哪里。
 * 运行：npm test（tsc 后 node --test "tests/*.test.mjs"，导入编译产物 lib/*.js）
 *
 * 覆盖：
 *   E1 新建写入：evidenceRefs 落盘、读回仍在（端到端，走真 store + 内存 kv）
 *   E2 合并路径：证据按**并集**累积、同一条去重、上限 8
 *   E3 编码/解析往返 + 渲染（v0.58 起：不给当前会话时**一律印会话短号**；坏串 → 空）
 *   E4 投影：recall 结果项里带 evidenceRefs（漏这一层就是「存了没人看得见」）
 *   E5 尸体样本：无证据的存量条目，结果项不含该键（零回归）
 *
 * ⚠ 落盘是**编码字符串**不是对象：本仓 schema DSL 不支持嵌套对象（详见 types.ts::EvidenceKind）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore, MAX_EVIDENCE_REFS, mergeEvidence } from '../lib/store.js'
import { recallEntries } from '../lib/search.js'
import { evidenceTag, formatEvidenceRef, parseEvidenceRef, sessionShortId } from '../lib/evidence.js'

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

  // 渲染（v0.58 契约变更）：优先带事件号的那条；**未给当前会话时一律印短号**——
  // 「不知道当前会话」与「就是当前会话」是两件事，后者才允许省 id（见 E11）。
  assert.equal(evidenceTag(['session|sid-1|33847']), '⚓sid-1@33847')
  assert.equal(evidenceTag(['session|sid-1|']), '⚓sid-1')
  assert.equal(evidenceTag(['compaction|sid-1|cmp-9']), '⚓sid-1/压缩@cmp-9')
  assert.equal(evidenceTag(['session|sid-1|', 'session|sid-1|7']), '⚓sid-1@7 (+1)')
  assert.equal(evidenceTag([]), '')
  assert.equal(evidenceTag(undefined), '')
  assert.equal(evidenceTag(['garbage']), '', '全是坏串 ⇒ 不打标记（不骗人）')
})

test('E11 证据出处（v0.58 · 方案 §12.1）：同会话省 id / 异会话印号 / 不知道不省', () => {
  const cur = 'session-cc8272d8-5195-4a34-a683-455cf5f12671'
  const other = 'session-9f3a1b2c-0000-1111-2222-333344445555'

  // S1 同会话 → 省 id：回查动作 `session_event_read({seq})` 缺省读当前会话，多印 8 字符是纯噪音
  assert.equal(evidenceTag([`session|${cur}|33847`], { currentSessionId: cur }), '⚓@33847')
  // S2 异会话 → **必须印号**：不印就会读到当前会话的第 33847 条，而且不报错（静默错读）
  assert.equal(evidenceTag([`session|${cur}|33847`], { currentSessionId: other }), '⚓cc8272d8@33847')
  // S3 不知道当前会话 ⇒ 一律印号（不省）。三种「不知道」的写法都要退出同一个答案
  assert.equal(evidenceTag([`session|${cur}|33847`]), '⚓cc8272d8@33847')
  assert.equal(evidenceTag([`session|${cur}|33847`], {}), '⚓cc8272d8@33847')
  assert.equal(evidenceTag([`session|${cur}|33847`], { currentSessionId: undefined }), '⚓cc8272d8@33847')
  // S4 短号必须**剥 `session-` 前缀**——直接取前 8 位得到 `session-`，零区分度
  assert.equal(sessionShortId(cur), 'cc8272d8')
  assert.equal(sessionShortId('sid-1'), 'sid-1')
  assert.equal(sessionShortId('abcdefghij'), 'abcdefgh')
  assert.equal(sessionShortId(undefined), '')
  assert.equal(sessionShortId(''), '')
  // S5 无 seq：同会话只说「会话」（够用）；异会话给号
  assert.equal(evidenceTag([`session|${cur}|`], { currentSessionId: cur }), '⚓会话')
  assert.equal(evidenceTag([`session|${cur}|`], { currentSessionId: other }), '⚓cc8272d8')
  // S6 压缩块：cid 是 uuid，8 位可定位——此前一个字符都不印（`⚓压缩` = 不可回查，只是「有记录」）
  const cmp = 'compaction|' + cur + '|1bdf3407-1440-4f69-bf7c-f6124e5071ce'
  assert.equal(evidenceTag([cmp], { currentSessionId: cur }), '⚓压缩@1bdf3407')
  assert.equal(evidenceTag([cmp], { currentSessionId: other }), '⚓cc8272d8/压缩@1bdf3407')
  // S7 derived：locator 直接印，超长截断（一个长 locator 不能撑爆整行）
  assert.equal(evidenceTag(['derived|supersedes:abc']), '⚓派生:supersedes:abc')
  assert.equal(evidenceTag(['derived|' + 'x'.repeat(40)]), `⚓派生:${'x'.repeat(28)}…`)
  // S8 多条：只印最强一条 + 其余**条数**（全量在结构化 `evidenceRefs`，行内不做清单）
  assert.equal(
    evidenceTag([`session|${cur}|1`, `session|${cur}|2`, `session|${cur}|`], { currentSessionId: cur }),
    '⚓@1 (+2)',
  )
  // S9 已知边界（写在判据里，不假装没有）：同批两会话前 8 位相同 ⇒ 短号相同。
  // 本机实测只有 1 个会话 ⇒ 零碰撞对象，**无法证明「不会碰撞」**；回退是结构化全量坐标。
  const twin = 'session-cc8272d8-ffff-eeee-dddd-ccccbbbbaaaa'
  assert.equal(sessionShortId(twin), sessionShortId(cur), '前 8 位相同 ⇒ 短号相同（已知边界，不是 bug）')
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
