/**
 * 工具 output schema 与实现的一致性（v0.13–v0.15 三版漂移的**机制承载** · 2026-10-17）。
 *
 * 背景（为什么需要这个文件）：v0.13 subject / v0.14 grounding / v0.15 temporal 连续三版，
 * `search.ts` 的共用投影层都补了字段、`recall` 的 output schema 也补了，而 **`memory_browse`
 * 的 output schema 一次都没跟上**。后果不是「少个字段」：browse 的 execute 直接返回投影结果
 * ⇒ 线上被 harness 的 `additionalProperties: false` **整条拒收**，该工具**完全不可用**
 * （2026-10-17 实测：调用即报 `"subject" is not a declared property`）。
 *
 * ⚠ 为什么原有测试没抓到：其余 browse 测试**直接调 `execute()`**，绕过了 harness 的 output
 * schema 校验这一跳 ⇒ schema 声明的正确性在测试里**完全不可见**。
 * ⇒ 本文件的判据必须打在 **schema 本身**，而不是只打 execute 的返回值。
 *
 * 判据（均为结构性、自动跟随新增字段——**不枚举字段名**，避免判据㉓「枚举式守卫在命名空间
 * 扩张时静默失效」）：
 *   A117 逐层一致性：execute 真实返回的每个键，schema 都必须声明（递归下钻 items/properties）
 *   A117b ★判据自证：collectUndeclared 对未声明键**真会亮**——否则 A117 是恒真的假绿
 *   A118 单一真源：recall 与 memory_browse 的 item 键集合之差恰为 ['related']，
 *        且共有键**引用相等**（同一份 DIMENSION_ITEM_FIELDS）⇒ 被拆回两份时立刻红
 *   A119 memory_browse 的 render 打出维度标记（semantic.md「渲染纪律」明列它为触发点之一）
 *
 * ★ 尸体样本纪律：样本条目**必须带全部维度字段**，且**先自证它们真落了盘**——
 * 否则「返回里没有该键」会让 A117 恒真（恒为空的输出不是证据，§5.9 规则 2）。
 *
 * 运行：npm test（node --test "tests/*.test.mjs"，导入编译产物 lib/*.js）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore } from '../lib/store.js'
import { DIMENSION_ITEM_FIELDS, createMemoryTools } from '../lib/tools.js'
import { workspaceIdOf } from '../lib/scope.js'
import { stalenessTag, watchForTag } from '../lib/temporal.js'
import { normalizeSubject, subjectTag } from '../lib/subject.js'

// ---------- 测试基建（与 temporal.test.mjs 同形） ----------

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
const WID = workspaceIdOf(CWD)

const CONFIG = {
  scope: 'workspace',
  layers: ['fact', 'knowledge', 'episodic'],
  autoSink: true,
  timeline: { day: true, week: true, month: true, year: true, archive: 'keep' },
  weeklyTemplate: '',
  maxEntries: 2000,
  inject: { enabled: true, maxBytes: 3000, maxEntries: 20 },
  autoInject: { enabled: true, maxBytes: 1500, maxEntries: 3 },
}

function setup() {
  const kv = new MemoryKv()
  const store = new MemoryStore(kv)
  const tools = createMemoryTools({ store, loadConfig: async () => CONFIG })
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  return { kv, store, byName }
}

const EXEC = {
  agent: { session: { id: 'session-11111111-2222-3333-4444-555555555555', header: { cwd: CWD } } },
  signal: new AbortController().signal,
}

/** 带**全部**维度字段的条目（★ 尸体样本：缺任一字段都会让 A117 对那个字段恒真） */
async function seedFull(store) {
  return store.remember({
    kind: 'knowledge',
    title: '带全维度的条目',
    body: '带全维度的条目 的正文',
    tags: ['schema-parity'],
    scope: WID,
    level: null,
    bucket: null,
    subject: 'self',
    grounding: 'proposed',
    reviewAfter: '2020-01-01',
    watchFor: ['某事件发生'],
  })
}

function renderText(tool, args, value) {
  return tool.output.render(args, value).map((b) => b.text).join('\n')
}

/**
 * 逐层比对：schema 声明的键 ⊇ 实际返回的键；递归下钻数组的 `items` 与对象的 `properties`。
 * 返回未声明键的路径列表（空数组 = 一致）。
 */
function collectUndeclared(schema, value, path, problems) {
  if (value === null || value === undefined) return
  if (Array.isArray(value)) {
    value.forEach((v, i) => collectUndeclared(schema?.items, v, `${path}[${i}]`, problems))
    return
  }
  if (typeof value !== 'object') return
  const props = schema?.properties ?? {}
  for (const [k, v] of Object.entries(value)) {
    if (!Object.prototype.hasOwnProperty.call(props, k)) problems.push(`${path}.${k}`)
    else collectUndeclared(props[k], v, `${path}.${k}`, problems)
  }
}

// ---------- A117 ★ schema 一致性（三版漂移的机制承载） ----------

test('A117 ★ schema 一致性：execute 返回的每个键都被 output schema 声明', async () => {
  const { store, byName } = setup()
  await seedFull(store)

  // ★ 夹具自证：先确认 4 个维度字段真的落盘了——否则「返回里没有该键」会让判据恒真。
  // 用 recall（其 schema 已知正确）当参照，而不是直接读 store（store 的返回形状不是契约面）。
  const recallTool = byName.get('recall')
  const recallValue = await recallTool.execute({}, EXEC)
  assert.ok(recallValue.results.length > 0, '夹具没落盘条目')
  for (const field of ['subject', 'grounding', 'reviewAfter', 'watchFor']) {
    assert.ok(
      field in recallValue.results[0],
      `夹具未落盘 ${field} ⇒ A117 对该字段恒真（无分辨力）。先修夹具。`,
    )
  }

  for (const name of ['recall', 'memory_browse']) {
    const tool = byName.get(name)
    const value = await tool.execute({}, EXEC)
    const problems = []
    collectUndeclared(tool.output.schema, value, name, problems)
    assert.deepEqual(
      problems,
      [],
      `${name}: 返回了 output schema 未声明的键 ⇒ 线上会被 additionalProperties:false 整条拒收（工具不可用）：${problems.join(', ')}`,
    )
  }
})

test('A117b ★判据自证：collectUndeclared 对未声明键真会亮（否则 A117 恒真）', () => {
  // 尸体样本：schema 只声明 a，值里多一个 b ⇒ 判据必须报出 root.b
  const problems = []
  collectUndeclared({ properties: { a: { type: 'string' } } }, { a: 'x', b: 'y' }, 'root', problems)
  assert.deepEqual(problems, ['root.b'], '判据必须能检出未声明键——否则 A117 是恒真的假绿')

  // 对照：一致时不得误报（判据别比对象严）
  const clean = []
  collectUndeclared({ properties: { a: { type: 'string' } } }, { a: 'x' }, 'root', clean)
  assert.deepEqual(clean, [], '一致时误报 ⇒ 判据过严')

  // 数组下钻：items 里多键也必须报
  const nested = []
  collectUndeclared(
    { properties: { list: { items: { properties: { a: { type: 'string' } } } } } },
    { list: [{ a: 'x', b: 'y' }] },
    'root',
    nested,
  )
  assert.deepEqual(nested, ['root.list[0].b'], '数组内层未声明键必须被检出')
})

// ---------- A118 单一真源 ----------

test('A118 单一真源：recall 与 memory_browse 的 item schema 同源（差集恰为 related）', () => {
  const { byName } = setup()
  const recallItem = byName.get('recall').output.schema.properties.results.items.properties
  // ⚠ 路径比 recall 多一层：groups(数组) → 元素(group) → group.items(数组) → 元素(item) → properties
  const browseItem = byName.get('memory_browse').output.schema.properties.groups.items.properties.items.items.properties
  assert.ok(recallItem !== undefined, 'recall 的 item schema 路径取不到（schema 结构变了？）')
  assert.ok(browseItem !== undefined, 'memory_browse 的 item schema 路径取不到（schema 结构变了？）')

  // ① 键集合差（结构性、自动跟随新增字段）：recall 独有恰为 related，browse 不得独有
  const onlyInRecall = Object.keys(recallItem).filter((k) => !(k in browseItem))
  assert.deepEqual(
    onlyInRecall,
    ['related'],
    `recall 独有键应恰为 ['related']（相关链只有 recall 返回），实为 ${JSON.stringify(onlyInRecall)} ⇒ 某字段只加在了一侧`,
  )
  const onlyInBrowse = Object.keys(browseItem).filter((k) => !(k in recallItem))
  assert.deepEqual(onlyInBrowse, [], `browse 不得有 recall 没有的键，实为 ${JSON.stringify(onlyInBrowse)}`)

  // ② 维度字段**值相等**（两侧声明必须与常量一致）。
  // 遍历**常量自己的键**（而不是在测试里枚举字段名）⇒ 新增维度字段自动被覆盖。
  // ⚠ 边界（2026-10-17 实测）：这里**不能用 strictEqual**——经 `defineTool` 处理后 schema
  //   已被拷贝/归一化（两处值逐字段相同而引用不同），引用相等判据在框架处理后不成立。
  //   因此「是否被拆成两份手写副本」这条**不由本判据承担**：拆开若不改变键集合则无害，
  //   若下次只改一侧 ⇒ 上面的差集判据与 A117 会红。判据的域写清楚，比让它看起来更强重要。
  // ⚠ 另：`id` / `kind` 这类各处手写的字面量本来就该是两份（值相等即可），不在此循环内。
  for (const k of Object.keys(DIMENSION_ITEM_FIELDS)) {
    assert.deepStrictEqual(
      recallItem[k],
      DIMENSION_ITEM_FIELDS[k],
      `recall 的 ${k} 与常量不一致（被拆成手写副本且已漂移）`,
    )
    assert.deepStrictEqual(
      browseItem[k],
      DIMENSION_ITEM_FIELDS[k],
      `memory_browse 的 ${k} 与常量不一致（被拆成手写副本且已漂移）`,
    )
  }
})

// ---------- A119 memory_browse 的 render 维度标记 ----------

test('A119 memory_browse 的 render 打出维度标记（过期 / 主体 / 观察条件）', async () => {
  const { store, byName } = setup()
  await seedFull(store)

  const tool = byName.get('memory_browse')
  const value = await tool.execute({}, EXEC)
  const text = renderText(tool, {}, value)

  // 期望值由被测的纯函数现算，**不硬编码文案**（文案改了不该假红；但「有没有标记」必须断言）
  const now = new Date()
  const expectStaleness = stalenessTag('2020-01-01', now)
  const expectSubject = subjectTag(normalizeSubject('self'))
  const expectWatch = watchForTag(['某事件发生'])

  assert.notEqual(expectStaleness, '', '前提：2020-01-01 必须落在需警觉档位（否则这条测试无分辨力）')
  assert.ok(text.includes(expectStaleness), `render 缺时效标记（期望含「${expectStaleness}」）`)
  assert.ok(text.includes(expectSubject), `render 缺主体标记（期望含「${expectSubject}」）`)
  assert.ok(text.includes(expectWatch), `render 缺观察条件（期望含「${expectWatch}」）`)
  // 条目本体仍在（标记不得把 id/标题挤掉）
  assert.match(text, /带全维度的条目\(id=/, 'render 必须仍打出标题与 id')
})

test('A119b 对照：未设维度的条目**不得**被打标记（标记要挑着打）', async () => {
  const { store, byName } = setup()
  await store.remember({
    kind: 'knowledge',
    title: '无维度的条目',
    body: '正文',
    tags: [],
    scope: WID,
    level: null,
    bucket: null,
  })

  const tool = byName.get('memory_browse')
  const value = await tool.execute({}, EXEC)
  const text = renderText(tool, {}, value)
  const line = text.split('\n').find((l) => l.includes('无维度的条目'))
  assert.ok(line !== undefined, '找不到该条目行')
  assert.equal(
    line.trim(),
    '- [knowledge] 无维度的条目(id=' + line.match(/id=([^)]+)\)/)[1] + ')',
    `未设维度的条目不得带任何标记，实为「${line.trim()}」`,
  )
})
