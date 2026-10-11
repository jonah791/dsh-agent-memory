#!/usr/bin/env node
/**
 * 输出快照（性能/重构类改动的等价性判据的**取样端**）
 *
 * 为什么需要它：性能改动的最强验收是「**输出逐字段等价**」，而「测试都绿」只覆盖
 * 抽样断言。本器对**全库逐 target**跑 relatedOf（+ 一批 recall），把完整输出落盘，
 * 供 diff-snapshot.mjs 与改动后的快照逐字段比对 ⇒ 覆盖所有 target，数学上等价 ⇔ 实现等价。
 *
 * 用法：node scripts/snapshot-output.mjs <输出路径>
 * 跑的是**生产编译产物** lib/*.js（与 audit-retrieval.mjs 同一份仪器）。
 *
 * ⚠ 取样必须含 `ngrams()` 的 **1 字符退化边界**（clean.length===1 ⇒ 返回单字符而非 2-gram）。
 *   那是 relatedOf 缓存优化的等价性风险点，不覆盖就等于没证 —— 见本目录 2026-10-12 的提交。
 */
import fs from 'node:fs'
import { recallEntries, relatedOf } from '../lib/search.js'

const STORE = process.env.MEMORY_STORE || 'E:/alice/.dsh/storages/agent_memory.json'
const OUT = process.argv[2]
if (!OUT) {
  console.error('用法：node scripts/snapshot-output.mjs <输出路径>')
  process.exit(2)
}

const raw = JSON.parse(fs.readFileSync(STORE, 'utf8'))
const entries = Object.values(raw.tables.entries)

/** 稳定序列化（键排序）——否则对象键序差异会造成假不等 */
const canon = (v) => {
  if (Array.isArray(v)) return v.map(canon)
  if (v && typeof v === 'object') {
    const o = {}
    for (const k of Object.keys(v).sort()) o[k] = canon(v[k])
    return o
  }
  return v
}

const cleaned = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, '')
const live = entries.filter((e) => !e.archived)
const edge = live.filter((e) => cleaned(e.title).length <= 2)
const sample = []
const seen = new Set()
for (const e of [...live.slice(0, 60), ...edge]) {
  if (seen.has(e.id)) continue
  seen.add(e.id)
  sample.push(e)
}

const perTarget = { _entries: entries.length, _live: live.length, _sampled: sample.length, _edge: edge.length }
for (const e of sample) perTarget[e.id] = canon(relatedOf(entries, e, 3, false))

const queries = ['插件', '任务板', '记忆检索', 'context', '门禁', '棘轮', '反思', '不存在的词zzz']
const recalls = {}
for (const q of queries) recalls[q] = canon(recallEntries(entries, { query: q, limit: 10 }))

fs.writeFileSync(OUT, JSON.stringify({ n: entries.length, perTarget, recalls }, null, 1))
console.log('wrote ' + OUT)
console.log(
  `entries=${entries.length} live=${live.length} sampled=${sample.length}（含 1 字符标题边界 ${edge.length}）recalls=${queries.length}`,
)
