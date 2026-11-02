/**
 * origin.test.mjs — 「转述型·无出处」标记（2026-11-03 · lh-d5e409bf / t-abdc2452 最小落点）。
 *
 * 存在理由：我读论文 / 做调研后写的记忆，**读起来像我的结论**，但权威来自别人。
 * 危害不是「记了笔记」，是**未来的我拿它当自己的判断用**——那时它已和实测结论同库同语气。
 *
 * 本文件钉四件事：
 *   ① 判据两问分开（标题像转述 ∧ 全文无出处）——有出处的转述**不该**被标（否则标记变噪音）
 *   ② 标记只在命中时出现（false 与未判定同形，读者不需要看见）
 *   ③ ★ 与 `scripts/memory-origin-audit.mjs` 的**正则逐字对齐**（同源不同文件，靠这个测试锁住）
 *   ④ 端到端：recall 的结果项真的带上这个字段（投影层漏一行 = 判定生效但渲染打不出来，
 *      v0.13/v0.14/v0.15 连续三版都栽在这里）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ORIGIN_PATTERN_SOURCES, isTranscriptiveWithoutOrigin, transcriptiveTag } from '../lib/origin.js'
import { MemoryStore } from '../lib/store.js'
import { createMemoryTools } from '../lib/tools.js'
import { DEFAULT_CONFIG } from '../lib/config.js'

// ---------- 判据 ----------

test('标题是转述形态、全文没有可核出处 ⇒ 打标', () => {
  assert.equal(isTranscriptiveWithoutOrigin('论文精读：某个多智能体架构', '它提出了一种新的记忆组织方式。'), true)
  assert.equal(isTranscriptiveWithoutOrigin('调研：竞品如何做记忆检索', '结论：都靠关键词。'), true)
  assert.equal(isTranscriptiveWithoutOrigin('评估：某个 harness 的插件模型', '优点是可组合。'), true)
  assert.equal(isTranscriptiveWithoutOrigin('review 一下这套方案', '看起来能跑。'), true)
})

test('★ 有出处的转述**不打标**：可核查的引用不该与「无出处」同等对待', () => {
  assert.equal(isTranscriptiveWithoutOrigin('论文精读：某架构', '见 arXiv:2610.12345 的 §3。'), false)
  assert.equal(isTranscriptiveWithoutOrigin('论文精读：某架构', '见 arxiv 2610.12345v2。'), false)
})

test('标题不是转述形态 ⇒ 不打标（自产经验不该被这条规则碰到）', () => {
  assert.equal(isTranscriptiveWithoutOrigin('把别人的未找到转述成不存在', '我犯过的错。'), false)
  assert.equal(isTranscriptiveWithoutOrigin('重启配方', '改代码 → 预检 → 重启。'), false)
})

test('出处只在正文里也算数：判据看的是标题+正文全文，不是只看标题', () => {
  assert.equal(isTranscriptiveWithoutOrigin('精读：某论文', 'arXiv:2610.99999'), false)
})

test('空输入不抛错（渲染层会拿任意条目来问）', () => {
  assert.equal(isTranscriptiveWithoutOrigin('', ''), false)
  assert.equal(isTranscriptiveWithoutOrigin(undefined, undefined), false)
})

test('标记串用〔〕而不是[]：同一行已有 [kind@scope] 这种方括号，不能读成同一个语法元素', () => {
  assert.equal(transcriptiveTag(true), '〔转述型·无出处〕')
  assert.equal(transcriptiveTag(false), '')
  assert.equal(transcriptiveTag(undefined), '')
})

// ---------- ★ 与审计脚本的正则对齐（同源不同文件的锁） ----------

const SCRIPT_PATH = fileURLToPath(new URL('../../../scripts/memory-origin-audit.mjs', import.meta.url))

/** 从脚本里抽出 `const NAME = /.../flags;` 的正则**源文本**（该脚本带分号，故 flags 后容许 `;`） */
function scriptPatternSource(text, name) {
  const m = text.match(new RegExp(`^const ${name} = /(.+?)/[a-z]*;?$`, 'm'))
  if (m === null) throw new Error(`审计脚本里找不到 ${name}——判据搬家了？这个测试要跟着改`)
  return m[1]
}

test('★ 两侧正则逐字一致：插件 origin.ts ↔ scripts/memory-origin-audit.mjs', () => {
  const script = fs.readFileSync(SCRIPT_PATH, 'utf8')
  assert.equal(
    scriptPatternSource(script, 'RE_ARXIV'),
    ORIGIN_PATTERN_SOURCES.arxiv,
    'arXiv 判据与审计脚本不一致——改了一侧没改另一侧（这正是要靠测试拦住的漂移）',
  )
  assert.equal(
    scriptPatternSource(script, 'RE_DIGEST_TITLE'),
    ORIGIN_PATTERN_SOURCES.digestTitle,
    '转述型标题判据与审计脚本不一致',
  )
})

// ---------- 端到端：recall 结果项带上字段 ----------

class MemoryKv {
  constructor() { this.map = new Map() }
  get(key) { const v = this.map.get(key); return v === undefined ? undefined : { ...v } }
  async put(key, value) { this.map.set(key, { ...value }) }
  async delete(key) { return this.map.delete(key) }
  entries() { return this.map.entries() }
  get size() { return this.map.size }
}

function setup() {
  const deps = { store: new MemoryStore(new MemoryKv()), loadConfig: async () => DEFAULT_CONFIG }
  const byName = new Map(createMemoryTools(deps).map((t) => [t.name, t]))
  return {
    remember: (args) => byName.get('remember').execute(args),
    recall: (args) => byName.get('recall').execute(args),
  }
}

test('★ 端到端：无出处的转述条目在 recall 结果项里带 transcriptiveUncited，有出处的不带', async () => {
  const s = setup()
  await s.remember({ text: '论文精读：某多智能体记忆架构\n它把记忆分三层，但没给出可证伪判据。', tags: ['论文'] })
  await s.remember({ text: '论文精读：另一篇有出处的\n见 arXiv:2610.12345，结论可复核。', tags: ['论文'] })

  const r = await s.recall({ query: '论文精读' })
  const byTitle = new Map(r.results.map((it) => [it.title, it]))

  const uncited = byTitle.get('论文精读：某多智能体记忆架构')
  const cited = byTitle.get('论文精读：另一篇有出处的')
  assert.ok(uncited !== undefined && cited !== undefined, '前置：两条都该被检索到')
  assert.equal(uncited.transcriptiveUncited, true, '无出处的转述必须带标记')
  assert.equal(cited.transcriptiveUncited, undefined, '有出处的转述不该带标记（否则标记变噪音）')
})
