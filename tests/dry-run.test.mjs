/**
 * dry-run.test.mjs — `remember` 的预检形态（2026-11-03 · lh-0f54524a）。
 *
 * 存在理由：「先搜再写」在执行上**悬空**——它要求我先搜，但搜的工具（`recall`）与
 * 「会不会撞车」的判据（`remember` 的近重复检测器）**候选集不同源**。
 * 2026-11-02 实测：先 recall 搜「测试期望写错」返回 96 条却**不含**真正的母条目 `8b074a6e`
 * （标题「我的错误模式清单」与查询措辞零字面重叠），而随后 remember 把它报了出来。
 * ⇒ 预检必须走**同一个检测器**；本文件用那个实况做尸体样本。
 *
 * 钉四件事：
 *   ① ★ 不落库（端到端：库大小不变、侧车不新增、返回里没有 id）
 *   ② ★ 措辞不同、主题相同的候选**必须被报出**（这是它区别于 recall 预检的唯一理由）
 *   ③ 库满时 dryRun **不抛错**（预检不写库，「库满」是提示不是拒绝）
 *   ④ 渲染文案说清「未落库」，别让人把 dryRun 的回执当成写入成功
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore } from '../lib/store.js'
import { createMemoryTools } from '../lib/tools.js'
import { DEFAULT_CONFIG } from '../lib/config.js'

class MemoryKv {
  constructor() { this.map = new Map() }
  get(key) { const v = this.map.get(key); return v === undefined ? undefined : { ...v } }
  async put(key, value) { this.map.set(key, { ...value }) }
  async delete(key) { return this.map.delete(key) }
  entries() { return this.map.entries() }
  get size() { return this.map.size }
}

function setup(overrides = {}) {
  const kv = new MemoryKv()
  const trace = []
  const deps = {
    store: new MemoryStore(kv),
    loadConfig: async () => DEFAULT_CONFIG,
    recordDedupeTrace: async (records) => { trace.push(...records); return true },
    ...overrides,
  }
  const byName = new Map(createMemoryTools(deps).map((t) => [t.name, t]))
  const rememberTool = byName.get('remember')
  return {
    kv,
    trace,
    remember: (args) => rememberTool.execute(args),
    render: (args, value) => rememberTool.output.render(args, value),
  }
}

test('★ 端到端：dryRun 不落库（库大小不变、侧车不新增、返回里没有 id）', async () => {
  const s = setup()
  const before = s.kv.size
  const r = await s.remember({ text: '一条全新的经验\n内容和库里任何条目都不像。', dryRun: true })

  assert.equal(r.dryRun, true)
  assert.equal(r.id, undefined, 'dryRun 不该返回 id——没有写入就没有 id')
  assert.equal(r.action, undefined, 'dryRun 不该声称 created/updated')
  assert.equal(s.kv.size, before, '库大小必须不变')
  assert.equal(s.trace.length, 0, 'dryRun 不该往近重复侧车写任何东西')
})

test('★ 尸体（2026-11-02 实况）：标题措辞不同、主题相同的母条目必须被报出', async () => {
  const s = setup()
  // 母条目：标题里没有「测试期望写错」任何 2-gram，但正文讲了同一件事
  await s.remember({
    text: '我的错误模式清单\n第 3 条：把「测试期望写错」当成实现 bug——测试期望写错时断言会红，先看判据再看代码。',
    tags: ['错误', '测试'],
  })
  const before = s.kv.size

  const r = await s.remember({ text: '测试期望写错\n又一次：断言失败第一反应是改实现。', tags: ['错误', '测试'], dryRun: true })

  assert.equal(r.dryRun, true)
  assert.equal(s.kv.size, before, '预检不该落库')
  assert.ok(Array.isArray(r.similar) && r.similar.length > 0, '必须报出母条目——这正是 recall 预检救不了的那一情形')
  assert.match(r.similar[0], /我的错误模式清单/)
  assert.match(r.similar[0], /强度 \d+/)
})

test('未命中 ⇒ 明说「可以正式写入」，但不许把它说成「recall 也搜不到」', async () => {
  const s = setup()
  const r = await s.remember({ text: '量子色动力学的色彩因子\n完全无关的一条。', dryRun: true })
  assert.equal(r.similar, undefined, '未命中时省略 similar（无损 JSON）')
  const text = s.render({}, r).map((c) => c.text).join('\n')
  assert.match(text, /没列出候选/)
  assert.match(text, /不等于 `recall` 也搜不到/, '边界必须写在文案里：两个检测器不同源')
  assert.match(text, /字面不相关 ≠ 语义不重复/, '2026-11-12 教训：这条检测器测的是字面，必须自己承认')
})

test('库满时 dryRun 不抛错，只提示（预检不写库 ⇒ 守卫不该阻断它）', async () => {
  const s = setup({ loadConfig: async () => ({ ...DEFAULT_CONFIG, maxEntries: 1 }) })
  await s.remember({ text: '占位条目\n把库填满。' })
  const r = await s.remember({ text: '又一条全新内容\n库里放不下了。', dryRun: true })
  assert.equal(r.dryRun, true)
  const text = s.render({}, r).map((c) => c.text).join('\n')
  assert.match(text, /库已满/)
})

test('渲染说清「未落库」，有候选时给出下一步（合流 / 或直接写入）', async () => {
  const s = setup()
  await s.remember({ text: '我的错误模式清单\n把测试期望写错当成实现 bug。', tags: ['错误', '测试'] })
  const r = await s.remember({ text: '测试期望写错\n再来一次。', tags: ['错误', '测试'], dryRun: true })
  const text = s.render({}, r).map((c) => c.text).join('\n')
  assert.match(text, /未落库/)
  assert.match(text, /写入路径不再自动查重/, '必须说清它已是唯一入口，否则读者会以为正式写入也会提示')
  assert.match(text, /memory_merge/, '下一步仍要给合流出路')
  assert.doesNotMatch(text, /similarDisposition/, '该参数已于 2026-11-12 移除，文案不得再指向它')
})

// ─── 自动检测下线（2026-11-12 · 台账 lh-1f8c4a72）───────────────────────────
//
// 判据不可行的证据在 src/dedupe.ts 文件头（空模型 100% 触发 / 历史精度 6.4% /
// 换判据后召回 0%）。本条把**行为**钉住：正式写入不再返回 similar、不再进欠账。
test('★ 正式写入不再做自动查重：不返回 similar / hint / pendingDisposition', async () => {
  const s = setup()
  await s.remember({ text: '我的错误模式清单\n把测试期望写错当成实现 bug。', tags: ['错误', '测试'] })
  const r = await s.remember({ text: '测试期望写错\n再来一次。', tags: ['错误', '测试'] })
  assert.equal(r.similar, undefined, '自动路径不得再返回候选（那是 76 次/天噪音的来源）')
  assert.equal(r.hint, undefined)
  assert.equal(r.pendingDisposition, undefined, '不自动检测 ⇒ 不得再产生欠账')
})

test('回归：不带 dryRun 的正式写入仍返回 id / action，且真的落库', async () => {
  const s = setup()
  const before = s.kv.size
  const r = await s.remember({ text: '正常写入一条\n没有 dryRun。' })
  assert.ok(typeof r.id === 'string' && r.id.length > 0, '正式写入必须有 id')
  assert.equal(typeof r.action, 'string')
  assert.ok(s.kv.size > before, '库必须变大')
  const text = s.render({}, r).map((c) => c.text).join('\n')
  assert.match(text, /^已/, '正式写入的文案仍以「已…」开头')
})
