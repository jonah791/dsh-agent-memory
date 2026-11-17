/**
 * 事实生命周期维（v0.24.0）：`validAfter`（从何时开始为真）/ `supersededBy` / `supersedes`
 * （谁替代了谁，只留一层）。
 *
 * 背景（主人 2026-11-17 的诊断）：压缩摘要是**散文**，T1→T2→T3 的更新关系在压缩时会被抹平。
 * 库里已有五个时效字段，仍缺两格——「何时开始为真」与「被谁替代」。
 *
 * 本文件的判据按「五跳」逐跳落位（类型→投影→每个消费者的 schema→渲染→写入边界），
 * 并显式标注**判据边界**：哪一跳这里看得见、哪一跳只能靠重启后实调（宿主校验）。
 *
 * 运行：npm test（node --test "tests/*.test.mjs"，导入编译产物 lib/*.js）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore } from '../lib/store.js'
import { DIMENSION_ITEM_FIELDS, createMemoryTools } from '../lib/tools.js'
import { entrySchema } from '../lib/index.js'
import { workspaceIdOf } from '../lib/scope.js'
import {
  filterBySuccession,
  isSuperseded,
  parseStoredValidAfter,
  parseSupersedesArg,
  parseValidAfterArg,
  shortId,
  supersededByTag,
  supersedesTag,
  validAfterTag,
} from '../lib/succession.js'

// ---------- 测试基建（与 schema-parity.test.mjs 同形） ----------

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
  return { kv, store, tools, byName }
}

const EXEC = {
  agent: { session: { id: 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', header: { cwd: CWD } } },
  signal: new AbortController().signal,
}

/** 直接经 store 造一条（不经工具层）——用于控制「这条带不带新字段」 */
async function seed(store, title, extra = {}) {
  return store.remember({
    kind: 'knowledge',
    title,
    body: `${title} 的正文`,
    tags: ['succession'],
    scope: WID,
    level: null,
    bucket: null,
    ...extra,
  })
}

// ---------- A1 ★ 零拷贝（未给新参数 = 同一数组引用） ----------

test('A1 ★ 零拷贝：未给 superseded 参数时过滤函数返回**同一数组引用**', () => {
  const entries = [{ id: 'a' }, { id: 'b', supersededBy: 'x' }]
  assert.equal(
    filterBySuccession(entries, undefined),
    entries,
    '未给 mode 时必须原样返回同一数组引用（不是「结果看起来一样」）——这是零回归硬判据',
  )
  // 对照（判据自证）：给了 mode 就必须真的筛，否则上面的零拷贝会被「永远不过滤」的实现蒙过去
  assert.deepEqual(filterBySuccession(entries, 'current').map((e) => e.id), ['a'])
  assert.deepEqual(filterBySuccession(entries, 'superseded').map((e) => e.id), ['b'])
  // 脏值容错（读取侧）：空串 / 非字符串不算「已替代」（否则空字段会渲染成假标记）
  assert.equal(isSuperseded({ supersededBy: '' }), false)
  assert.equal(isSuperseded({ supersededBy: 42 }), false)
})

test('A1b 端到端零回归：未给 superseded 时 recall/browse 命中数不变，且条目一个不少', async () => {
  const { store, byName } = setup()
  await seed(store, '当前结论')
  const old = await seed(store, '旧结论')
  await store.update(WID, old.id, { supersededBy: 'deadbeef-dead-beef-dead-beefdeadbeef' })

  const recall = byName.get('recall')
  const all = await recall.execute({ limit: 50 }, EXEC)
  assert.equal(all.total, 2, '缺省**不隐藏**已过时条目——对照是它的全部价值')
  const onlyCurrent = await recall.execute({ superseded: 'current', limit: 50 }, EXEC)
  const onlyOld = await recall.execute({ superseded: 'superseded', limit: 50 }, EXEC)
  assert.equal(onlyCurrent.total, 1, 'current 只回未被替代的那条')
  assert.equal(onlyOld.total, 1, 'superseded 只回已被替代的那条')

  const browse = byName.get('memory_browse')
  const browseAll = await browse.execute({}, EXEC)
  const flat = browseAll.groups.flatMap((g) => g.items)
  assert.equal(flat.length, 2, 'browse 缺省同样不隐藏')
})

// ---------- A2 ★ 端到端存活（真存储 + 写入边界 schema） ----------

test('A2 ★ 端到端存活：真存储写入 → 读回 → 三字段仍在（且过 entrySchema 写入边界）', async () => {
  const { store, byName } = setup()
  const remember = byName.get('remember')
  const supersede = byName.get('memory_supersede')

  const older = await remember.execute({ text: '旧结论：用 diff 做检测' }, EXEC)
  const newer = await remember.execute({ text: '新结论：改用 tick 级成本模型', validAfter: '2026-11-10' }, EXEC)

  const result = await supersede.execute(
    { id: newer.id, supersedes: [older.id], validAfter: '2026-11-12' },
    EXEC,
  )
  assert.equal(result.id, newer.id)
  assert.deepEqual(result.supersedes, [older.id], '返回里必须带新条目当前的替代列表')
  assert.equal(result.validAfter, '2026-11-12', 'validAfter 落到新条目')
  assert.deepEqual(result.superseded.map((x) => x.id), [older.id])
  assert.equal(result.superseded[0].changed, true)
  assert.equal(result.skipped, 0)

  // ① 真存储读回（**绕过投影层**——证明是落盘，不是「渲染时现算」）
  const newEntry = store.get(WID, newer.id)
  const oldEntry = store.get(WID, older.id)
  assert.equal(newEntry.validAfter, '2026-11-12', 'validAfter 没落盘 ⇒ 存了等于没存')
  assert.deepEqual(newEntry.supersedes, [older.id], 'supersedes 没落盘')
  assert.equal(oldEntry.supersededBy, newer.id, 'supersededBy 没落盘（反向关系丢了）')

  // ② ★ 写入边界：storage-domain 用 entrySchema 校验，**未声明字段会被静默剥掉而写入仍返回成功**。
  //    这里真 parse（不是 grep 源码）——漏声明就红。
  for (const [label, entry] of [['新条目', newEntry], ['旧条目', oldEntry]]) {
    const parsed = entrySchema.parse(entry)
    for (const field of ['validAfter', 'supersededBy', 'supersedes']) {
      assert.deepEqual(
        parsed[field],
        entry[field],
        `${label}的 ${field} 被 entrySchema 剥掉了（index.ts 未声明）`,
      )
    }
  }

  // ③ 投影层：recall 结果项里看得见（否则渲染层打不出标记）
  const recall = byName.get('recall')
  const value = await recall.execute({ limit: 50 }, EXEC)
  const projectedNew = value.results.find((item) => item.id === newer.id)
  const projectedOld = value.results.find((item) => item.id === older.id)
  assert.equal(projectedNew.validAfter, '2026-11-12', '投影层漏了 validAfter')
  assert.deepEqual(projectedNew.supersedes, [older.id], '投影层漏了 supersedes')
  assert.equal(projectedOld.supersededBy, newer.id, '投影层漏了 supersededBy')
})

test('A2b ★ fail-loud：id 不存在 / 自引用 / 二次替代 都必须报错（不静默降级）', async () => {
  const { store, byName } = setup()
  const supersede = byName.get('memory_supersede')
  const target = await seed(store, '新结论')
  const other = await seed(store, '另一条结论')

  // ① 旧 id 不存在 ⇒ 整笔拒绝，**两侧都不许写**
  await assert.rejects(
    () => supersede.execute({ id: target.id, supersedes: ['no-such-id'] }, EXEC),
    /未找到被替代条目/,
  )
  assert.equal(store.get(WID, target.id).supersedes, undefined, '报错时不得留下半条边')

  // ② 自引用
  await assert.rejects(
    () => supersede.execute({ id: target.id, supersedes: [target.id] }, EXEC),
    /自引用/,
  )

  // ③ 空列表
  await assert.rejects(() => supersede.execute({ id: target.id, supersedes: [] }, EXEC), /至少给 1 个/)

  // ④ 二次替代：other 已被别人替代过 ⇒ 默认拒绝；显式 overwrite 才允许
  await store.update(WID, other.id, { supersededBy: 'first-superseder' })
  await assert.rejects(
    () => supersede.execute({ id: target.id, supersedes: [other.id] }, EXEC),
    /二次替代会改写历史/,
  )
  assert.equal(store.get(WID, other.id).supersededBy, 'first-superseder', '被拒时不得改写')
  const forced = await supersede.execute({ id: target.id, supersedes: [other.id], overwrite: true }, EXEC)
  assert.equal(forced.superseded[0].supersededBy, target.id, 'overwrite 应显式覆盖')
  assert.equal(store.get(WID, other.id).supersededBy, target.id)

  // ⑤ 幂等：同一对重调不报错、不重复写
  const again = await supersede.execute({ id: target.id, supersedes: [other.id] }, EXEC)
  assert.equal(again.skipped, 1, '本来已是该状态 ⇒ changed=false，计入 skipped')
  assert.equal(again.superseded[0].changed, false)
})

// ---------- A3 ★ 尸体样本：存量无该字段的条目，行为逐项不变 ----------

test('A3 ★ 尸体样本：无新字段的条目 —— 结果项不多键、渲染不出 undefined / 不多标记', async () => {
  const { store, byName } = setup()
  const corpse = await seed(store, '存量条目（v0.23 及以前）')

  const recall = byName.get('recall')
  const value = await recall.execute({ limit: 50 }, EXEC)
  const item = value.results.find((r) => r.id === corpse.id)
  for (const field of ['validAfter', 'supersededBy', 'supersedes']) {
    assert.equal(field in item, false, `尸体样本不得凭空长出 ${field}（省略 = 不知道，不是默认值）`)
  }

  // 渲染：既不得出现 undefined，也不得多出任何标记——行形状必须与加字段前逐字一致
  const text = recall.output.render({}, value).map((b) => b.text).join('\n')
  assert.equal(text.includes('undefined'), false, '渲染不得出现 undefined')
  const line = text.split('\n').find((l) => l.includes('存量条目（v0.23 及以前）'))
  // 分数由被测返回值取（不硬编码打分实现），但**整行形状**必须逐字一致 ⇒ 多一个标记就红
  assert.equal(
    line.trim(),
    `- [knowledge@${WID} 相关度${item.score}] 存量条目（v0.23 及以前）(id=${corpse.id})`,
    `尸体样本的行必须逐字不变，实为「${line.trim()}」`,
  )

  // 纯函数层：脏值 / 缺值一律空串（不许渲染出 `[自 undefined 起成立]`）
  assert.equal(supersededByTag(undefined), '')
  assert.equal(supersededByTag(''), '')
  assert.equal(validAfterTag(undefined), '')
  assert.equal(validAfterTag('不是一个日期'), '')
  assert.equal(supersedesTag(undefined), '')
  assert.equal(supersedesTag([]), '')
})

// ---------- A4 ★ schema 与实现一致性（打在被绕过的那一层上） ----------

/**
 * 递归下钻 schema，收集所有**承载维度字段名**的结构节点。
 * ⚠ 不枚举字段名、不枚举工具名：从 `DIMENSION_ITEM_FIELDS` 与真实 schema 树出发
 * （枚举式守卫会在命名空间扩张时静默失效 —— 判据㉓）。
 *
 * ⚠ **判据的域（实测划清）**：「节点里出现维度字段名」≠「这是那个 item 结构」。
 * `memory_supersede` 的**写入回执**也声明了 `validAfter` / `supersedes`——那是另一种结构
 * （部分键、不同语义），不是投影结果项。⇒ 用**投影形态自己的标记** `snippet` 认出 item 结构
 * （`snippet` 只由 `search.ts::toResultItem` 产出），其余节点只做「不得发明新维度名」的弱断言。
 * 这条边界写在这里，免得下次有人把回执结构也按 item 结构去要求。
 */
function findDimensionCarriers(schema, path, out) {
  if (schema === null || typeof schema !== 'object') return
  const props = schema.properties
  if (props !== undefined && typeof props === 'object') {
    const dimsHere = Object.keys(DIMENSION_ITEM_FIELDS).filter((key) => key in props)
    if (dimsHere.length > 0) {
      out.push({ path, declared: Object.keys(props), dimsHere, isItemShape: 'snippet' in props, props })
    }
    for (const [key, sub] of Object.entries(props)) findDimensionCarriers(sub, `${path}.${key}`, out)
  }
  if (schema.items !== undefined) findDimensionCarriers(schema.items, `${path}[]`, out)
  if (Array.isArray(schema.oneOf)) schema.oneOf.forEach((sub, i) => findDimensionCarriers(sub, `${path}|${i}`, out))
}

/** 逐层比对：schema 声明的键 ⊇ 实际返回的键（递归下钻 items / properties） */
function collectUndeclared(schema, value, path, problems) {
  if (value === null || value === undefined) return
  if (Array.isArray(value)) {
    value.forEach((item, i) => collectUndeclared(schema?.items, item, `${path}[${i}]`, problems))
    return
  }
  if (typeof value !== 'object') return
  const props = schema?.properties ?? {}
  for (const [key, sub] of Object.entries(value)) {
    if (!Object.prototype.hasOwnProperty.call(props, key)) problems.push(`${path}.${key}`)
    else collectUndeclared(props[key], sub, `${path}.${key}`, problems)
  }
}

test('A4 ★ 消费者清点：返回该 item 结构的工具，每个都必须声明全部维度字段（多一个消费者就红）', () => {
  const { tools } = setup()
  const carriers = new Map()
  const others = []
  for (const tool of tools) {
    const found = []
    findDimensionCarriers(tool.output.schema, tool.name, found)
    const itemNodes = found.filter((node) => node.isItemShape)
    if (itemNodes.length > 0) carriers.set(tool.name, itemNodes)
    for (const node of found.filter((candidate) => !candidate.isItemShape)) {
      others.push({ tool: tool.name, path: node.path, dims: node.dimsHere })
    }
  }

  // ① **清点**：有几个工具在返回这个结构？共用投影让「有几份 schema」看不见，
  //    所以这一格必须由 schema 树自己数出来。新增消费者 ⇒ 本断言红 ⇒ 逼一次显式确认。
  assert.deepEqual(
    [...carriers.keys()].sort(),
    ['memory_browse', 'recall'],
    '承载 item 结构的工具集合变了：新增/删除消费者必须显式确认（否则新消费者会漏字段、线上整条被拒收）',
  )

  // ② **全有或全无**：item 结构里维度字段要么全声明、要么一个都不声明。
  //    「声明了一半」正是 v0.13–v0.15 三版漂移的形状（browse 停在 v0.12）。
  for (const [name, nodes] of carriers) {
    for (const node of nodes) {
      const missing = Object.keys(DIMENSION_ITEM_FIELDS).filter((key) => !node.declared.includes(key))
      assert.deepEqual(missing, [], `${name} 的 ${node.path} 漏声明：${missing.join(', ')}（会被 additionalProperties:false 整条拒收）`)
      // ③ 同一个键在各消费者里必须与常量逐字段相同（被拆成手写副本且已漂移 ⇒ 红）
      for (const key of Object.keys(DIMENSION_ITEM_FIELDS)) {
        assert.deepStrictEqual(
          node.props[key],
          DIMENSION_ITEM_FIELDS[key],
          `${name} 的 ${node.path}.${key} 与常量不一致（手写副本已漂移）`,
        )
      }
    }
  }

  // ④ 其它承载维度**字段名**的结构（如 `memory_supersede` 的写入回执）只能使用常量里的名字，
  //    不许发明新维度键——否则「维度命名空间」出现了第二个真源。
  for (const other of others) {
    const invented = other.dims.filter((key) => !(key in DIMENSION_ITEM_FIELDS))
    assert.deepEqual(invented, [], `${other.tool} 的 ${other.path} 使用了常量里没有的维度名：${invented.join(', ')}`)
  }
})

test('A4b ★ 新工具的 output schema ⊇ 实现（recall/browse 由 schema-parity A117 承担）', async () => {
  const { store, byName } = setup()
  const supersede = byName.get('memory_supersede')
  const older = await seed(store, '旧')
  const newer = await seed(store, '新')

  // 两种形态都要验：新建边（changed=true）与幂等重调（changed=false / skipped>0）。
  // 只验一种会让「只在另一种形态出现的键」逃过 schema 校验。
  const first = await supersede.execute({ id: newer.id, supersedes: [older.id], validAfter: '2026-11-01' }, EXEC)
  const second = await supersede.execute({ id: newer.id, supersedes: [older.id] }, EXEC)
  for (const [label, value] of [['首次', first], ['幂等重调', second]]) {
    const problems = []
    collectUndeclared(supersede.output.schema, value, `memory_supersede(${label})`, problems)
    assert.deepEqual(
      problems,
      [],
      `memory_supersede 返回了 output schema 未声明的键（线上会被 additionalProperties:false 整条拒收）：${problems.join(', ')}`,
    )
  }
  // ★ 判据自证：上面的 collectUndeclared 真会亮
  const problems = []
  collectUndeclared(
    { properties: { a: { type: 'string' } } },
    { a: 'x', extra: { b: 1 } },
    'root',
    problems,
  )
  assert.deepEqual(problems, ['root.extra'], '判据必须能检出未声明键，否则 A4b 是恒真假绿')
})

// ---------- A5 渲染（新字段必须被人看见） ----------

test('A5 ★ 渲染：过时条目打「已过时 → 被 <id前8位> 替代」，validAfter 印出来，旧条目仍返回', async () => {
  const { store, byName } = setup()
  const supersede = byName.get('memory_supersede')
  const older = await seed(store, '旧值：成本模型用 tick')
  const newer = await seed(store, '新值：成本模型用秒')
  await supersede.execute({ id: newer.id, supersedes: [older.id], validAfter: '2026-11-01' }, EXEC)

  const recall = byName.get('recall')
  const value = await recall.execute({ limit: 50 }, EXEC)
  const text = recall.output.render({}, value).map((b) => b.text).join('\n')

  // 期望文案由被测纯函数现算（不硬编码——文案改了不该假红，但「有没有标记」必须断言）
  const expectOld = supersededByTag(newer.id)
  const expectValid = validAfterTag('2026-11-01')
  const expectNew = supersedesTag([older.id])
  assert.notEqual(expectOld, '', '前提：替代标记必须非空（否则下面恒真）')
  assert.notEqual(expectValid, '', '前提：validAfter 标记必须非空')
  assert.ok(expectOld.includes(shortId(newer.id)), '标记里必须是替代者的前 8 位')
  assert.ok(text.includes(expectOld), `旧条目缺「已过时」标记（期望含「${expectOld}」）`)
  assert.ok(text.includes(expectValid), `新条目缺 validAfter 标记（期望含「${expectValid}」）`)
  assert.ok(text.includes(expectNew), `新条目缺「替代了谁」标记（期望含「${expectNew}」）`)

  // ⚠ 对照：**旧条目仍然出现在结果里**（不隐藏——对照是它的全部价值）
  const titles = value.results.map((r) => r.title)
  assert.ok(titles.includes('旧值：成本模型用 tick'), '旧条目不得被隐藏或删除')
  assert.ok(titles.includes('新值：成本模型用秒'))

  // memory_browse 同一事实同一标记（两个界面不得长得不一样）
  const browse = byName.get('memory_browse')
  const browseValue = await browse.execute({}, EXEC)
  const browseText = browse.output.render({}, browseValue).map((b) => b.text).join('\n')
  assert.ok(browseText.includes(expectOld), 'browse 缺「已过时」标记')
  assert.ok(browseText.includes(expectValid), 'browse 缺 validAfter 标记')
})

// ---------- A6 ★ 替代关系只留一层 ----------

test('A6 ★ 只留一层：A→B→C 连续替代两次，每条 supersededBy 只有一格，不出现数组或递归链', async () => {
  const { store, byName } = setup()
  const supersede = byName.get('memory_supersede')
  const a = await seed(store, '结论 v1')
  const b = await seed(store, '结论 v2')
  const c = await seed(store, '结论 v3')

  await supersede.execute({ id: b.id, supersedes: [a.id] }, EXEC)
  await supersede.execute({ id: c.id, supersedes: [b.id] }, EXEC)

  const ea = store.get(WID, a.id)
  const eb = store.get(WID, b.id)
  const ec = store.get(WID, c.id)

  // ① 每层各记一格：A→B、B→C
  assert.equal(ea.supersededBy, b.id)
  assert.equal(eb.supersededBy, c.id)
  assert.equal(ec.supersededBy, undefined, '最新的那条不该被替代')

  // ② 每条 `supersededBy` 都是**单个字符串**（不是数组、不是链）
  for (const [label, entry] of [['A', ea], ['B', eb]]) {
    assert.equal(typeof entry.supersededBy, 'string', `${label}.supersededBy 必须是字符串（不是数组/链）`)
  }

  // ③ C.supersedes **只记直接替代对象**，不得递归展开成 [A, B]
  assert.deepEqual(ec.supersedes, [b.id], 'C.supersedes 只能有直接替代对象 B（不递归展开祖先）')
  assert.equal(ec.supersedes.includes(a.id), false, 'C.supersedes 不得包含 A —— 那是递归链，违反「只留一层」')

  // ④ B 的 supersedes 保留（它确实替代过 A），两层各自成立
  assert.deepEqual(eb.supersedes, [a.id])

  // ⑤ 中间层不再被当作「当前结论」时仍可见：recall 缺省返回全部三条
  const recall = byName.get('recall')
  const value = await recall.execute({ limit: 50 }, EXEC)
  assert.equal(value.total, 3, '三层都在库里（不删除，只标关系）')
})

// ---------- A7 参数解析（fail-loud / 容错两条路分流） ----------

test('A7 ★ 参数路径 fail-loud：相对写法 / 不存在的日期 / 非法结构一律抛错', () => {
  // validAfter 不接受相对写法（它答「何时开始为真」，是既成事实不是死线）
  assert.throws(() => parseValidAfterArg('+7d', 'validAfter'), /不接受相对写法/)
  // 不存在的日期（JS 会静默滚到下月，必须被抓住）
  assert.throws(() => parseValidAfterArg('2026-02-30', 'validAfter'), /日期不存在/)
  assert.throws(() => parseValidAfterArg('随便', 'validAfter'), /无法解析/)
  assert.throws(() => parseValidAfterArg(42, 'validAfter'), /必须是字符串/)

  // 接受：YYYY-MM-DD 原样；ISO 时刻取 UTC 日；空 ⇒ undefined（= 不知道）
  assert.equal(parseValidAfterArg('2026-11-01'), '2026-11-01')
  assert.equal(parseValidAfterArg('2026-11-01T23:30:00Z'), '2026-11-01')
  assert.equal(parseValidAfterArg('2026-11-01T23:30:00+08:00'), '2026-11-01')
  assert.equal(parseValidAfterArg(''), undefined)
  assert.equal(parseValidAfterArg(undefined), undefined)

  // 读取路径容错（历史脏值不许让检索崩，也不许渲染出假日期）
  assert.equal(parseStoredValidAfter('2026-11-01'), '2026-11-01')
  assert.equal(parseStoredValidAfter('2026-02-30'), undefined)
  assert.equal(parseStoredValidAfter('不是一个日期'), undefined)
  assert.equal(parseStoredValidAfter(null), undefined)

  // supersedes：单条字符串接受、去重保序、空/超限抛错
  assert.deepEqual(parseSupersedesArg('x'), ['x'])
  assert.deepEqual(parseSupersedesArg(['x', 'x', 'y']), ['x', 'y'])
  assert.throws(() => parseSupersedesArg([]), /至少给 1 个/)
  assert.throws(() => parseSupersedesArg(undefined), /必填/)
})
