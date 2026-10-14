/**
 * 约定状态单测（v0.14.0「是否已被共同建立」维度 · 论文 Grounding Awareness）——
 * grounding.ts 纯函数 + 工具层行为。
 * 运行：npm test（node --test "tests/*.test.mjs"，导入编译产物 lib/*.js）
 *
 * 覆盖（对应 docs/semantic.md §7 的 A95–A104）：
 *   A95 归一（容错路径，含 rejected 别名）；A96 参数路径 fail-loud（两条路径分流）；
 *   A97 过滤零拷贝；A98 过滤生效；A99 计数四档 + 未标注；
 *   A100 渲染标记**只凸显需警觉的**（established / 未标注留空）；
 *   A101 写路径盖章 + 不静默转移；A102 update 三态；A103 汇总结论（自审用）；
 *   A104 端到端（recall 过滤 + 渲染 + stats 自洽 + 存量兼容 + 投影层存活）。
 *
 * 本文件刻意复用「v0.4 形状配置字面量」作配置 ⇒ 顺带覆盖「历史配置不崩」。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore } from '../lib/store.js'
import { createMemoryTools } from '../lib/tools.js'
import { workspaceIdOf } from '../lib/scope.js'
import {
  GROUNDINGS,
  UNLABELED_GROUNDING,
  countByGrounding,
  filterByGrounding,
  groundingLabel,
  groundingTag,
  groundingVerdict,
  isGrounding,
  normalizeGrounding,
  parseGroundingArg,
} from '../lib/grounding.js'

// ---------- 测试基建（与 subject.test.mjs 同形） ----------

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

// ⚠ 双平台夹具纪律：WID 由被测派生函数算出（硬编码在 WSL 下作用域不匹配）
const CWD = 'C:\\Users\\Alice\\proj'
const WID = workspaceIdOf(CWD)

const LEGACY_CONFIG = {
  scope: 'workspace',
  layers: ['fact', 'knowledge', 'episodic'],
  autoSink: true,
  timeline: { day: true, week: true, month: true, year: true, archive: 'keep' },
  weeklyTemplate: '',
  maxEntries: 2000,
  inject: { enabled: true, maxBytes: 3000, maxEntries: 20 },
  autoInject: { enabled: true, maxBytes: 1500, maxEntries: 3 },
}

function setup(config = LEGACY_CONFIG) {
  const kv = new MemoryKv()
  const store = new MemoryStore(kv)
  const tools = createMemoryTools({ store, loadConfig: async () => config })
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  return { kv, store, byName }
}

const EXEC = {
  agent: { session: { id: 'session-11111111-2222-3333-4444-555555555555', header: { cwd: CWD } } },
  signal: new AbortController().signal,
}

async function seed(store, { scope = WID, kind = 'knowledge', title, grounding }) {
  return store.remember({
    kind, title, body: `${title} 的正文`, tags: [], scope, level: null, bucket: null,
    ...(grounding !== undefined ? { grounding } : {}),
  })
}

function renderText(tool, args, value) {
  return tool.output.render(args, value).map((b) => b.text).join('\n')
}

// ---------- A95 归一（容错路径） ----------

test('A95 normalizeGrounding：认规范值与别名（含 rejected）；空/未知/非字符串 → undefined（未标注）', () => {
  for (const value of GROUNDINGS) assert.equal(normalizeGrounding(value), value)
  assert.equal(normalizeGrounding('ESTABLISHED'), 'established', '大小写不敏感')
  assert.equal(normalizeGrounding('  proposed  '), 'proposed', '去首尾空白')
  assert.equal(normalizeGrounding('我的提议'), 'proposed', '中文别名')
  assert.equal(normalizeGrounding('主人说过'), 'established')
  assert.equal(normalizeGrounding('主人否决'), 'rejected')
  assert.equal(normalizeGrounding('unacknowledged'), 'proposed', '论文术语别名')
  // 认不出 / 空 / 非字符串 ⇒ 未标注（容错：读历史数据不该让检索崩）
  assert.equal(normalizeGrounding('bogus'), undefined)
  assert.equal(normalizeGrounding(''), undefined)
  assert.equal(normalizeGrounding(undefined), undefined)
  assert.equal(normalizeGrounding(42), undefined)
})

test('A95b isGrounding 是严格判定（不归一）', () => {
  assert.equal(isGrounding('proposed'), true)
  assert.equal(isGrounding('rejected'), true)
  assert.equal(isGrounding('我的提议'), false, '别名不是规范值')
  assert.equal(isGrounding(undefined), false)
})

// ---------- A96 参数路径 fail-loud ----------

test('A96 parseGroundingArg：合法值通过、空值 → undefined、非法值**抛错**', () => {
  assert.equal(parseGroundingArg('proposed'), 'proposed')
  assert.equal(parseGroundingArg(' 已拒绝 '), 'rejected')
  assert.equal(parseGroundingArg(undefined), undefined)
  assert.equal(parseGroundingArg(''), undefined)
  assert.throws(() => parseGroundingArg('bogus'), /未知取值/)
  assert.throws(() => parseGroundingArg(42), /必须是字符串/)
  assert.throws(() => parseGroundingArg('bogus', 'remember.grounding'), /remember\.grounding/, '报错带字段名')
})

// ---------- A97/A98 过滤 ----------

test('A97 filterByGrounding：未给 grounding → **同一数组引用**（零拷贝零过滤）', () => {
  const entries = [{ kind: 'knowledge', grounding: 'proposed' }, { kind: 'knowledge' }]
  assert.equal(filterByGrounding(entries, undefined), entries, '必须原样返回同一引用')
})

test('A98 filterByGrounding：给了只返回匹配项；未标注**不**匹配任何值', () => {
  const entries = [
    { kind: 'knowledge', grounding: 'established' },
    { kind: 'knowledge', grounding: 'proposed' },
    { kind: 'knowledge', grounding: 'rejected' },
    { kind: 'knowledge' },
  ]
  assert.deepEqual(filterByGrounding(entries, 'proposed').map((e) => e.grounding), ['proposed'])
  assert.deepEqual(filterByGrounding(entries, 'rejected').map((e) => e.grounding), ['rejected'])
  assert.equal(filterByGrounding(entries, 'established').length, 1)
  assert.notEqual(filterByGrounding(entries, 'proposed'), entries, '给了参数必须返回新数组')
})

// ---------- A99 计数 ----------

test('A99 countByGrounding：四档 + 未标注；非法值计入未标注', () => {
  const counts = countByGrounding([
    { grounding: 'established' }, { grounding: 'established' },
    { grounding: 'proposed' }, { grounding: 'scoped' }, { grounding: 'rejected' },
    { grounding: undefined }, { grounding: 'bogus' },
  ])
  assert.equal(counts.established, 2)
  assert.equal(counts.proposed, 1)
  assert.equal(counts.scoped, 1)
  assert.equal(counts.rejected, 1)
  assert.equal(counts[UNLABELED_GROUNDING], 2, '非法值也计入未标注')
  const sum = counts.established + counts.proposed + counts.scoped + counts.rejected + counts[UNLABELED_GROUNDING]
  assert.equal(sum, 7, '分档之和 == 条目数')
})

// ---------- A100 渲染标记 ----------

test('A100 groundingTag：**只凸显需警觉的**——established 与未标注一律留空', () => {
  assert.equal(groundingTag('proposed'), '[我的提议]')
  assert.equal(groundingTag('scoped'), '[限范围]')
  assert.equal(groundingTag('rejected'), '[已被否决]')
  assert.equal(groundingTag('established'), '', '常态不打标记——否则淹没真正该警觉的')
  assert.equal(groundingTag(undefined), '', '未标注同样留空')
  assert.equal(groundingLabel('proposed'), '我的提议')
  assert.equal(groundingLabel(undefined), '未标注')
})

// ---------- A101 写路径 ----------

test('A101 remember 带 grounding → 落库带该字段；不带 → **无该键**（不是 undefined）', async () => {
  const { store, byName } = setup()
  const remember = byName.get('remember')

  const tagged = await remember.execute({ text: '我自己提的方案（主人还没回应）', grounding: 'proposed' }, EXEC)
  assert.equal(store.get(WID, tagged.id).grounding, 'proposed')

  const plain = await remember.execute({ text: '一条普通记忆' }, EXEC)
  const entry = store.get(WID, plain.id)
  assert.equal(Object.hasOwn(entry, 'grounding'), false, '未标注不留键（一个真源）')
})

test('A101b remember 别名归一 + 非法值 fail-loud 且整笔拒绝', async () => {
  const { store, byName } = setup()
  const remember = byName.get('remember')
  const viaAlias = await remember.execute({ text: '主人否决过的方案', grounding: '主人否决' }, EXEC)
  assert.equal(store.get(WID, viaAlias.id).grounding, 'rejected')

  const before = store.list(WID).length
  await assert.rejects(() => remember.execute({ text: '不该被写入', grounding: 'bogus' }, EXEC), /未知取值/)
  assert.equal(store.list(WID).length, before, '非法参数整笔拒绝，不留半成品')
})

test('A101c 同标题合并 / key 覆盖**不**转移 grounding（新建才盖章）', async () => {
  const { store, byName } = setup()
  const remember = byName.get('remember')
  const first = await remember.execute({ text: '我提的某方案', grounding: 'proposed', kind: 'knowledge' }, EXEC)
  const second = await remember.execute({ text: '我提的某方案', grounding: 'established', kind: 'knowledge' }, EXEC)
  assert.equal(second.id, first.id, '同标题走合并')
  assert.equal(store.get(WID, first.id).grounding, 'proposed', '合并不得静默改标注')
})

// ---------- A102 update 三态 ----------

test('A102 update grounding 三态：给值=设置 / 空串=清除 / 缺省=不动（回填入口）', async () => {
  const { store, byName } = setup()
  const remember = byName.get('remember')
  const update = byName.get('update')

  const { id } = await remember.execute({ text: '存量条目（未标注）', kind: 'knowledge' }, EXEC)
  assert.equal(store.get(WID, id).grounding, undefined)

  await update.execute({ id, grounding: 'proposed' }, EXEC)
  assert.equal(store.get(WID, id).grounding, 'proposed', '① 给值 = 设置（回填的唯一入口）')

  await update.execute({ id, tags: ['x'] }, EXEC)
  assert.equal(store.get(WID, id).grounding, 'proposed', '② 缺省 = 不动')

  await update.execute({ id, grounding: '' }, EXEC)
  const cleared = store.get(WID, id)
  assert.equal(cleared.grounding, undefined, '③ 空串 = 清除回未标注')
  assert.equal(Object.hasOwn(cleared, 'grounding'), false, '清除是删键，不是置 undefined')

  await assert.rejects(() => update.execute({ id, grounding: 'bogus' }, EXEC), /未知取值/)
})

// ---------- A103 汇总结论 ----------

test('A103 groundingVerdict：有 proposed/rejected 时**点名风险**；未标注单独提示残留', () => {
  const text = groundingVerdict({ established: 10, proposed: 2, scoped: 1, rejected: 3, [UNLABELED_GROUNDING]: 5 })
  assert.ok(text.includes('我的提议 2'), text)
  assert.ok(text.includes('不得当作授权使用'), 'proposed 必须点名风险')
  assert.ok(text.includes('不得旧事重提'), 'rejected 也必须点名')
  assert.ok(text.includes('未标注'), '未标注要提示残留风险')
  assert.ok(groundingVerdict({ established: 1, proposed: 0, scoped: 0, rejected: 0, [UNLABELED_GROUNDING]: 0 }).includes('无待警觉项'))
})

// ---------- A104 端到端 ----------

test('A104 recall 按 grounding 过滤（proposed 只回我提的；缺省回全部）', async () => {
  const { store, byName } = setup()
  await seed(store, { title: '我提的机制方案', grounding: 'proposed' })
  await seed(store, { title: '主人定调的事', grounding: 'established' })
  await seed(store, { title: '未标注的条目' })

  const recall = byName.get('recall')
  const all = await recall.execute({ limit: 50 }, EXEC)
  const proposed = await recall.execute({ grounding: 'proposed', limit: 50 }, EXEC)

  assert.equal(all.total, 3, '缺省不过滤')
  assert.equal(proposed.total, 1)
  assert.equal(proposed.results[0].title, '我提的机制方案')
  assert.equal(proposed.results[0].grounding, 'proposed', '结果项必须带该字段（投影层）')
})

test('A104b 渲染：proposed/rejected 显示标记，established 与未标注**不显示**', async () => {
  const { store, byName } = setup()
  await seed(store, { title: '我提的方案', grounding: 'proposed' })
  await seed(store, { title: '主人说过的事', grounding: 'established' })
  await seed(store, { title: '普通条目' })

  const recall = byName.get('recall')
  const result = await recall.execute({ limit: 50 }, EXEC)
  const text = renderText(recall, { limit: 50 }, result)

  assert.ok(text.includes('[我的提议][knowledge@'), `proposed 应有标记，实际：${text}`)
  assert.ok(!text.includes('[已建立]'), 'established 不得打标记')
  assert.ok(text.includes('\n- [knowledge@'), '未标注行首无标记')
})

test('A104c memory_stats 分档自洽（byGrounding 之和 == total）', async () => {
  const { store, byName } = setup()
  await seed(store, { title: 'a', grounding: 'proposed' })
  await seed(store, { title: 'b', grounding: 'established' })
  await seed(store, { title: 'c' })

  const stats = await byName.get('memory_stats').execute({}, EXEC)
  const g = stats.byGrounding
  assert.equal(g.proposed + g.established + g.scoped + g.rejected + g[UNLABELED_GROUNDING], stats.total)
  assert.equal(g.proposed, 1)
  assert.equal(g[UNLABELED_GROUNDING], 1)
})

test('A104d 存量兼容（尸体样本）：全无 grounding 的库，行为与加维度前逐项一致', async () => {
  const { store, byName } = setup()
  for (let i = 0; i < 5; i += 1) await seed(store, { title: `历史条目 ${i}` })

  const recall = byName.get('recall')
  const plain = await recall.execute({ limit: 50 }, EXEC)
  assert.equal(plain.total, 5, '未给 grounding 时不过滤任何条目')

  const stats = await byName.get('memory_stats').execute({}, EXEC)
  assert.equal(stats.byGrounding[UNLABELED_GROUNDING], stats.total, '存量全归未标注')
  assert.equal(stats.byGrounding.proposed, 0)
})

test('A104e recall / memory_browse 非法 grounding → fail-loud', async () => {
  const { store, byName } = setup()
  await seed(store, { title: '任意条目' })
  await assert.rejects(() => byName.get('recall').execute({ grounding: 'bogus' }, EXEC), /未知取值/)
  await assert.rejects(() => byName.get('memory_browse').execute({ grounding: 'bogus' }, EXEC), /未知取值/)
})
