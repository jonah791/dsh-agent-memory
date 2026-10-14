/**
 * 排序加权归因单测（v0.12 · DREAM 迁移）
 *
 * 出处：DREAM（arXiv 2610.13267）附录 G Eq.29 —— 效用归因 `aᵢ(t) = softmax(Score(q_t, vᵢ)/τ_u)`：
 * 被检索的记忆按**检索分数**分走该轮效用，而不是各记一笔。本插件不在轨迹里存分数（只存有序 id），
 * 故取 softmax 的**序数形态**：返回列表的位置即排序的单调摘要。
 *
 * 运行：npm test（node --test "tests/*.test.mjs"，导入编译产物 lib/*.js）
 *
 * 覆盖：
 *   A43 位置敏感（**尸体样本 + 对照组**）：同 hits、异位置 ⇒ 归因不同；且老口径确实分不开
 *   A44 回溯性：轨迹里从无 `attributed` 字段，位置一直在 ⇒ 历史轨迹零迁移可算
 *   A45 位置取数组下标：坏元素占位，不让后面的条目排名前移
 *   A46 分型：有归因 / 无归因（回退 hits）两种世界在 notes 与 evidence 上**长得不一样**
 *   A47 边界：用量项不参与分档 —— 归因差异不得翻转任何档位（把代码注释里的边界变成可执行断言）
 *
 * ⚠ 判据纪律：A43 里**必须先断言老口径分不开两者**。没有这个对照组，「新口径能分开」
 *   只是一句无从证伪的话（真正的证据是：同一个装置，在旧输入形态下失败、在新输入形态下成功）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_ATTRIBUTION_DECAY, parseAccessTrace } from '../lib/access-trace.js'
import { DEFAULT_AUDIT_CONFIG, auditMemory, scoreEntry } from '../lib/audit.js'
import { DEFAULT_CONFIG } from '../lib/config.js'
import { MemoryStore } from '../lib/store.js'
import { createMemoryTools } from '../lib/tools.js'

/** 内存 KV 垫片（与 audit.test.mjs / centroid.test.mjs 同款：不碰真盘） */
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

const CWD = 'C:\\Users\\Alice\\proj'
const EXEC = {
  agent: { session: { id: 'session-11111111-2222-3333-4444-555555555555', header: { id: 'session-11111111-2222-3333-4444-555555555555', cwd: CWD } } },
  signal: new AbortController().signal,
}

const DECAY = DEFAULT_ATTRIBUTION_DECAY
const NOW = Date.parse('2026-10-14T12:00:00.000Z')
const DAY = 86_400_000

/** 条目夹具（不经过 store，直接构造；字段与 types.ts Entry 对齐） */
function entry(partial = {}) {
  const created = partial.createdAt ?? new Date(NOW - 5 * DAY).toISOString()
  return {
    id: 'e0',
    kind: 'knowledge',
    title: '条目',
    body: '正文',
    tags: [],
    scope: 'global',
    createdAt: created,
    updatedAt: partial.updatedAt ?? created,
    accessedAt: partial.accessedAt ?? partial.updatedAt ?? created,
    level: null,
    bucket: null,
    archived: false,
    ...partial,
  }
}

/** 造一条「N 天前更新」的条目 */
function aged(days, partial = {}) {
  const iso = new Date(NOW - days * DAY).toISOString()
  return entry({ createdAt: iso, updatedAt: iso, accessedAt: iso, ...partial })
}

const BASE = {
  weights: DEFAULT_AUDIT_CONFIG.weights,
  refs: new Map(),
  tagReuse: new Map(),
  dups: new Map(),
  nowMs: NOW,
}

/** 一行轨迹（注意：**从无 `attributed` 字段**——位置信息本就在 ids 的下标里） */
function line(atMs, ids) {
  return JSON.stringify({ atMs, source: 'recall', ids })
}

// ---------- A43 位置敏感（尸体样本 + 对照组） ----------

test('A43 位置敏感：同 hits、异位置 ⇒ 归因不同；对照组证明老口径分不开', () => {
  // 两条记录：front 恒在第 1 位，tail 恒在第 6 位（距首位 5 步）
  const index = parseAccessTrace([line(1, ['front', 'x1', 'x2', 'x3', 'x4', 'tail']), line(2, ['front', 'y1', 'y2', 'y3', 'y4', 'tail'])].join('\n'))
  const front = index.get('front')
  const tail = index.get('tail')

  // ① 对照组（老口径）：hits **分不开**这两条 —— 这正是缺口本身
  assert.equal(front.hits, 2)
  assert.equal(tail.hits, 2)

  // ② 新口径：分开
  assert.ok(Math.abs(front.attributed - 2) < 1e-12, `front 归因应为 2，实为 ${front.attributed}`)
  assert.ok(Math.abs(tail.attributed - 2 * DECAY ** 5) < 1e-12, `tail 归因应为 ${2 * DECAY ** 5}，实为 ${tail.attributed}`)

  const eFront = entry({ id: 'front' })
  const eTail = entry({ id: 'tail' })

  // ③ 老世界（只喂 {hits,lastAtMs} ⇒ 评分回退 hits）：两条**逐位相等**，装置分不开
  const hitsOnly = new Map([...index].map(([id, s]) => [id, { hits: s.hits, lastAtMs: s.lastAtMs }]))
  const oldFront = scoreEntry(eFront, { ...BASE, usage: hitsOnly })
  const oldTail = scoreEntry(eTail, { ...BASE, usage: hitsOnly })
  assert.equal(oldFront.score, oldTail.score, '对照组必须失败：老口径下两者分数应完全相同')

  // ④ 新世界（真轨迹索引）：同一条目、同一装置，分数必须分开 —— 否则本机制是死代码
  const newFront = scoreEntry(eFront, { ...BASE, usage: index })
  const newTail = scoreEntry(eTail, { ...BASE, usage: index })
  assert.ok(newFront.terms.usage > newTail.terms.usage, '第 1 位的用量项应高于第 6 位')
  assert.ok(newFront.score > newTail.score, '总分应随之分开')
})

// ---------- A44 回溯性 ----------

test('A44 回溯性：轨迹里没有 attributed 字段，位置一直在 ⇒ 历史轨迹零迁移可算', () => {
  const raw = line(1, ['a', 'b'])
  assert.ok(!raw.includes('attributed'), '轨迹原文不应含 attributed（它是解析期算出来的）')

  const index = parseAccessTrace(raw)
  assert.equal(index.get('a').attributed, 1)
  assert.ok(Math.abs(index.get('b').attributed - DECAY) < 1e-12)
  // hits 语义不变（既有读取方不受影响）
  assert.equal(index.get('a').hits, 1)
  assert.equal(index.get('b').hits, 1)
})

// ---------- A45 位置取数组下标 ----------

test('A45 位置取数组下标：坏元素占位，不让后面的条目排名前移', () => {
  const index = parseAccessTrace(line(1, ['good', '', 'later']))
  assert.equal(index.get('good').attributed, 1)
  // 若误用「有效 id 计数器」，later 会被算成第 2 位（0.6）而非第 3 位（0.36）
  assert.ok(Math.abs(index.get('later').attributed - DECAY ** 2) < 1e-12, `later 应记第 3 位，实为 ${index.get('later').attributed}`)
})

// ---------- A46 分型（可见面） ----------

test('A46 分型：有归因 / 无归因（回退 hits）两种世界在 notes 与 evidence 上不同', () => {
  const e = entry({ id: 'e1' })

  const withAttr = auditMemory({ entries: [e], usage: parseAccessTrace(line(1, ['e1'])), now: NOW })
  assert.ok(withAttr.notes.some((n) => n.includes('排序加权归因')), '有归因时须自报口径')
  assert.equal(withAttr.candidates[0].evidence.attribution, 1)
  assert.equal(withAttr.candidates[0].evidence.usage, 1)

  const hitsOnly = auditMemory({ entries: [e], usage: new Map([['e1', { hits: 3, lastAtMs: NOW }]]), now: NOW })
  assert.ok(hitsOnly.notes.some((n) => n.includes('回退 hits')), '降级形态必须与正常形态长得不一样（§5.9 空/降级分型）')
  assert.equal(hitsOnly.candidates[0].evidence.attribution, 3, '缺 attributed ⇒ 回退 hits')
  assert.equal(hitsOnly.candidates[0].evidence.usage, 3)
})

// ---------- A47 边界：不参与分档 ----------

test('A47 边界：用量项不参与分档 —— 归因差异不得翻转任何档位', () => {
  // 同一条目、两种用量读数（无信号 vs 拉满），档位必须一致、分数必须不同
  const e = aged(20, { id: 'f', body: 'x'.repeat(4000) })
  const none = auditMemory({ entries: [e], now: NOW })
  const full = auditMemory({
    entries: [e],
    usage: new Map([['f', { hits: 50, lastAtMs: NOW, attributed: 50 }]]),
    now: NOW,
  })
  assert.equal(none.candidates[0].bucket, full.candidates[0].bucket, '档位不得因用量改变')
  assert.ok(full.candidates[0].score > none.candidates[0].score, '但分数应改变（否则用量项是死的）')
})

// ---------- A48 可见面（渲染层） ----------

test('A48 可见面：口径注脚必须出现在**人看到的文本**里，不能只活在结构化返回', async () => {
  // 存在理由：v0.12 实施时口径注脚写进了 notes，而渲染层只放行 `另有` 开头的注脚
  // ⇒ 注脚到不了人眼前（结构化返回里有、人看不见 = 等于没写）。
  // 渲染层是本插件的历史缺陷高发区（summaryMaxChars 误用通用尺子、notes 过滤）
  // —— 「逻辑住在 render/execute 里」正是最不受测试保护的位置，故在此钉一条。
  let accessMap
  const store = new MemoryStore(new MemoryKv())
  const tools = createMemoryTools({
    store,
    loadConfig: async () => ({ ...DEFAULT_CONFIG, audit: DEFAULT_AUDIT_CONFIG }),
    readAccess: async () => accessMap,
  })
  const def = new Map(tools.map((t) => [t.name, t])).get('memory_audit')

  const created = await store.remember({ kind: 'knowledge', title: '口径用例', body: '正文', tags: [], scope: 'global', level: null, bucket: null })
  assert.ok(created.id, '夹具应先写入一条条目')

  // ① 有归因的世界
  accessMap = parseAccessTrace(line(1, [created.id]))
  const withAttr = await def.execute({}, EXEC)
  const text1 = def.output.render({}, withAttr)[0].text
  assert.ok(text1.includes('排序加权归因'), `人看到的文本必须带出计分口径，实际：\n${text1}`)

  // ①b 负对照：把该注脚从结构化返回里摘掉 ⇒ 该字样必须随之消失。
  // 没有这一条，「①②③ 都通过」有可能只是因为该字样本来就在别处（断言恒真 = 无结论）。
  const stripped = { ...withAttr, notes: withAttr.notes.filter((n) => !n.startsWith('用量信号')) }
  const text1b = def.output.render({}, stripped)[0].text
  assert.ok(!text1b.includes('排序加权归因'), `该字样必须由注脚供给，实际：\n${text1b}`)

  // ② 降级的世界（无归因 ⇒ 回退 hits）：两种世界必须长得不一样
  accessMap = new Map([[created.id, { hits: 3, lastAtMs: NOW }]])
  const text2 = def.output.render({}, await def.execute({}, EXEC))[0].text
  assert.ok(text2.includes('回退 hits'), `降级形态必须自报，实际：\n${text2}`)

  // ③ 无轨迹的世界
  accessMap = undefined
  const text3 = def.output.render({}, await def.execute({}, EXEC))[0].text
  assert.ok(text3.includes('无逻辑轨迹'), `无信号也必须自报，实际：\n${text3}`)
})
