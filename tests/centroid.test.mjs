/**
 * v0.7 单测：上下文重心（注入查询）+ 命中率度量 + 提案日志。
 * 运行：npm test（node --test "tests/*.test.mjs"，导入编译产物 lib/*.js）
 *
 * 覆盖（对应 docs/semantic.md §7 的 A45–A52）：
 *   A45 重心纯函数（衰减/锚点/去重/封顶/退化）；A46 重心召回 > 字面召回（反例翻转）；
 *   A47 未给重心 ⇒ 原路径（零回归）；A48 素材挑选（排除工具结果与插件注入）；
 *   A49 轨迹汇总口径；A50 提案日志（两类记录/轮转/吞错 + A31 只读不破）；
 *   A51 memory_health 命中率信号；A52 配置 proposal_log fail-loud。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../lib/store.js'
import { createMemoryTools } from '../lib/tools.js'
import { DEFAULT_CONFIG, MemoryConfigError, parseMemoryConfig } from '../lib/config.js'
import { DEFAULT_AUDIT_CONFIG } from '../lib/audit.js'
import { buildCentroid, recentTurnTexts } from '../lib/centroid.js'
import { buildAutoRecallDigest } from '../lib/auto-inject.js'
import {
  appendAccessTrace,
  appendProposalRecord,
  readAccessSummary,
  summarizeAccessRecords,
} from '../lib/access-trace.js'

// ---------- 基建 ----------

class MemoryKv {
  constructor() { this.map = new Map() }
  get(key) { const v = this.map.get(key); return v === undefined ? undefined : { ...v } }
  async put(key, value) { this.map.set(key, { ...value }) }
  async delete(key) { return this.map.delete(key) }
  entries() { return this.map.entries() }
  get size() { return this.map.size }
}

const CWD = 'C:\\Users\\Alice\\proj'
const WID = 'c:/Users/Alice/proj'

function entry(partial) {
  const iso = partial.createdAt ?? '2026-09-10T00:00:00.000Z'
  return {
    id: partial.id ?? Math.random().toString(36).slice(2),
    kind: 'knowledge',
    title: partial.title ?? '条目',
    body: partial.body ?? '正文',
    tags: partial.tags ?? [],
    scope: partial.scope ?? WID,
    createdAt: iso,
    updatedAt: partial.updatedAt ?? iso,
    accessedAt: partial.accessedAt ?? iso,
    level: null,
    bucket: null,
    archived: false,
    ...partial,
  }
}

const CONFIG = { ...DEFAULT_CONFIG, audit: DEFAULT_AUDIT_CONFIG }

function setup(config = CONFIG, extraDeps = {}) {
  const kv = new MemoryKv()
  const store = new MemoryStore(kv)
  const tools = createMemoryTools({ store, loadConfig: async () => config, ...extraDeps })
  const byName = new Map(tools.map((t) => [t.name, t]))
  const exec = {
    agent: { session: { id: 'session-11111111-2222-3333-4444-555555555555', header: { id: 'session-11111111-2222-3333-4444-555555555555', cwd: CWD } } },
    signal: new AbortController().signal,
  }
  return { kv, store, byName, exec }
}

// ---------- A45 重心纯函数 ----------

test('A45 重心：越新的轮次权重越高，锚点最强，同轮同词项只计一次', () => {
  const terms = buildCentroid(['旧话题', '新话题'], '锚点词')
  const weight = (t) => terms.find((x) => x.term === t)?.weight
  // 衰减：历史第 1 轮（更旧）= decay^2 = 0.49，历史第 2 轮（更新）= decay^1 = 0.7
  assert.ok(weight('新话题') > weight('旧话题'), '越新权重越高')
  assert.ok(weight('锚点词') > weight('新话题'), '锚点最强（2.0）')

  // 同一轮里重复出现的词项只计一次
  const repeated = buildCentroid(['考试 考试 考试'], undefined)
  assert.equal(repeated.filter((t) => t.term === '考试').length, 1)
  assert.equal(repeated.find((t) => t.term === '考试').weight, 0.7)
})

test('A45b 重心：封顶 maxTerms；无有效词项 ⇒ 空数组（调用方据此退化）', () => {
  const many = buildCentroid([Array.from({ length: 60 }, (_, i) => `词${i}`).join(' ')], undefined, { maxTerms: 5 })
  assert.equal(many.length, 5)
  assert.deepEqual(buildCentroid([], undefined), [])
  assert.deepEqual(buildCentroid(['   '], ''), [])
  assert.deepEqual(buildCentroid([], '的 了 吗'), [], '全停用词 ⇒ 空（退化路径）')
})

// ---------- A46 重心召回 > 字面召回（反例翻转） ----------

test('A46 重心能召回「字面里没提」的历史话题——重启唤醒消息那种场景', () => {
  const entries = [
    entry({ id: 'exam', title: '考试安排与复习计划', body: '考试时间在下个月，复习计划已列', tags: ['考试'] }),
    entry({ id: 'deploy', title: '部署脚本记录', body: '部署脚本与回滚步骤', tags: ['部署'] }),
  ]
  const anchor = '最近有点累'
  const history = ['我下个月要考试，有点紧张'] // 字面里没有「考试」的锚点消息

  // 原路径（只用最后一条消息的字面）：命中不到考试
  const literal = buildAutoRecallDigest(entries, anchor, { maxEntries: 3, maxBytes: 1500 })
  assert.ok(!literal.includes('考试安排'), '字面路径不应命中考试条目')

  // 重心路径：历史话题进入查询 ⇒ 考试条目浮现
  const weightedTerms = buildCentroid(history, anchor)
  const centroidDigest = buildAutoRecallDigest(entries, anchor, { maxEntries: 3, maxBytes: 1500, weightedTerms })
  assert.ok(centroidDigest.includes('考试安排'), '重心路径应召回历史话题相关条目')
})

// ---------- A47 零回归 ----------

test('A47 未给重心 ⇒ 完全走原路径（同一输入同一输出）', () => {
  const entries = [entry({ id: 'k1', title: 'ComfyUI 生图经验', body: 'anima-v2 工作流骨架' })]
  const a = buildAutoRecallDigest(entries, 'ComfyUI 怎么生图', { maxEntries: 3, maxBytes: 1500 })
  const b = buildAutoRecallDigest(entries, 'ComfyUI 怎么生图', { maxEntries: 3, maxBytes: 1500, weightedTerms: [] })
  assert.equal(a, b, '空重心数组必须与不传等价')

  // 有重心但锚点为空文本时不崩（纯重心查询）
  const weightedTerms = buildCentroid([], 'ComfyUI 生图')
  const c = buildAutoRecallDigest(entries, '', { maxEntries: 3, maxBytes: 1500, weightedTerms })
  assert.ok(c.includes('ComfyUI 生图经验'))
})

// ---------- A48 素材挑选 ----------

test('A48 重心素材：排除工具结果与插件注入，保留主人消息与模型回答，取最后 N 条', () => {
  const messages = [
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '第一句' }] },
    { role: 'user', source: { kind: 'tool' }, content: [{ type: 'text', text: '工具结果不该进重心' }] },
    { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: '模型回答' }] },
    { role: 'user', source: { kind: 'plugin', plugin: 'dsh-agent-memory' }, content: [{ type: 'text', text: '注入不该进重心' }] },
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '最新一句' }] },
  ]
  const texts = recentTurnTexts(messages, 4)
  assert.deepEqual(texts, ['第一句', '模型回答', '最新一句'])
  assert.ok(!texts.some((t) => t.includes('工具结果') || t.includes('注入')))
})

// ---------- A49 轨迹汇总口径 ----------

test('A49 轨迹汇总：auto/recall 计数 + 去重命中 + 最近时刻；坏行跳过', () => {
  const text = [
    JSON.stringify({ atMs: 100, source: 'auto', ids: ['a', 'b'] }),
    '{ 坏行',
    JSON.stringify({ atMs: 300, source: 'recall', ids: ['b'] }),
    JSON.stringify({ atMs: 200, source: 'auto', ids: [] }),
  ].join('\n')
  const s = summarizeAccessRecords(text)
  assert.equal(s.autoCalls, 2)
  assert.equal(s.recallCalls, 1)
  assert.equal(s.distinctIds, 2)
  assert.equal(s.totalHits, 3)
  assert.equal(s.lastAtMs, 300)
  assert.deepEqual(summarizeAccessRecords(''), { autoCalls: 0, recallCalls: 0, distinctIds: 0, totalHits: 0, lastAtMs: 0 })
})

// ---------- A50 提案日志 ----------

test('A50 提案日志：两类记录同文件可 join；memory_audit 仍不写记忆库（A31 不破）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-proposals-'))
  const logPath = join(dir, 'audit-proposals.jsonl')
  let written = []
  const { kv, store, byName, exec } = setup(CONFIG, {
    recordProposal: (record) => { written.push(record); return appendProposalRecord(logPath, record, 1_000_000) },
  })

  kv.map.set(`${WID}:knowledge:e1`, entry({ id: 'e1', title: '一个条目', body: 'x'.repeat(300) }))
  const before = JSON.stringify([...kv.entries()].sort())

  await byName.get('memory_audit').execute({ topN: 5 }, exec)
  await byName.get('forget').execute({ id: 'e1', reason: '体检提案：老且无溯源' }, exec)

  assert.equal(written.length, 2, 'audit 与 action 各写一条')
  assert.equal(written[0].kind, 'audit')
  assert.ok(Array.isArray(written[0].candidates))
  assert.equal(written[1].kind, 'action')
  assert.equal(written[1].action, 'forget')
  assert.equal(written[1].id, 'e1')
  assert.ok(written[1].reason.includes('体检提案'))

  // 落盘而不仅是内存回调（写入是 fire-and-forget 的设计，等一拍）
  await new Promise((resolve) => setTimeout(resolve, 50))
  const lines = readFileSync(logPath, 'utf8').trim().split('\n')
  assert.equal(lines.length, 2)
  const auditRecord = JSON.parse(lines[0])
  assert.ok(auditRecord.candidates.some((c) => c.id === 'e1'), '可按 id join：提案里出现了 e1')

  // A31 不破：记忆库唯一变化是 forget 导致的 archived=true；accessedAt 没被体检刷新
  const after = [...kv.entries()].map(([, e]) => e)
  const e1 = after.find((e) => e.id === 'e1')
  assert.equal(e1.archived, true)
  assert.equal(e1.accessedAt, e1.createdAt, 'accessedAt 未被体检刷新')
  assert.notEqual(JSON.stringify([...kv.entries()].sort()), before, 'forget 是显式动作，允许改变')
  assert.equal(after.length, 1, '体检不新增/不删除条目')
  assert.equal(store.list(WID, { includeArchive: true }).length, 1)
})

test('A50b 提案日志：写入失败吞错（不抛、不影响工具返回），关掉开关即不写', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-proposals-off-'))
  // 用目录当文件路径 ⇒ append 失败
  const { byName, exec } = setup(CONFIG, { recordProposal: () => appendProposalRecord(dir, { atMs: 1 }, 0) })
  const result = await byName.get('memory_audit').execute({}, exec)
  assert.equal(result.summary.total, 0, '写日志失败不影响体检返回')

  const disabled = { ...CONFIG, audit: { ...DEFAULT_AUDIT_CONFIG, proposalLog: { enabled: false, maxBytes: 0 } } }
  let called = 0
  const off = setup(disabled, { recordProposal: () => { called += 1 } })
  await off.byName.get('memory_audit').execute({}, off.exec)
  assert.equal(called, 0, '开关关闭时不得写提案日志')
})

// ---------- A51 命中率信号 ----------

test('A51 memory_health 报命中率信号（注入/主动检索/去重命中/最近时刻）', async () => {
  const summary = { autoCalls: 7, recallCalls: 2, distinctIds: 5, totalHits: 12, lastAtMs: Date.parse('2026-09-15T10:00:00Z') }
  const { byName, exec } = setup(CONFIG, { readAccessSummary: async () => summary })
  const health = await byName.get('memory_health').execute({}, exec)
  assert.equal(health.autoCalls, 7)
  assert.equal(health.recallCalls, 2)
  assert.equal(health.distinctHits, 5)
  assert.equal(health.lastAccessAt, '2026-09-15T10:00:00')
  const rendered = byName.get('memory_health').output.render({}, health)[0].text
  assert.ok(rendered.includes('注入 7 次'), rendered)
  assert.ok(rendered.includes('主动检索 2 次'))

  // 无汇总（未接线/无轨迹）⇒ 全 0 且不崩
  const bare = setup(CONFIG)
  const h2 = await bare.byName.get('memory_health').execute({}, bare.exec)
  assert.equal(h2.autoCalls, 0)
  assert.equal(h2.lastAccessAt, '')
})

// ---------- A52 配置 ----------

test('A52 audit.proposal_log 配置：缺省开、可关、非法 fail-loud', () => {
  assert.deepEqual(parseMemoryConfig('').audit.proposalLog, DEFAULT_AUDIT_CONFIG.proposalLog)
  const cfg = parseMemoryConfig('audit:\n  proposal_log:\n    enabled: false\n    max_bytes: 0\n')
  assert.equal(cfg.audit.proposalLog.enabled, false)
  assert.equal(cfg.audit.proposalLog.maxBytes, 0)
  assert.throws(() => parseMemoryConfig('audit:\n  proposal_log:\n    enabledz: true\n'), MemoryConfigError)
  assert.throws(() => parseMemoryConfig('audit:\n  proposal_log:\n    max_bytes: -1\n'), MemoryConfigError)
})

// ---------- 轨迹写入回归（v0.6 行为不变） ----------

test('轨迹写入回归：appendAccessTrace 仍只追加且空 ids 不写', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-trace-v07-'))
  const p = join(dir, 'access.jsonl')
  assert.equal(await appendAccessTrace(p, { atMs: 1, source: 'recall', ids: ['a'] }, 0), true)
  assert.equal(await appendAccessTrace(p, { atMs: 2, source: 'recall', ids: [] }, 0), false)
  const s = await readAccessSummary(p)
  assert.equal(s.recallCalls, 1)
  assert.equal(s.totalHits, 1)
})
