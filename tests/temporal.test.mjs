/**
 * 时效维单测（v0.15.0「执行时是否仍然有效」· 论文 Fresh at Decision, Stale at Action,
 * arXiv:2610.18126v1）—— temporal.ts 纯函数 + 工具层行为 + 写入边界 schema。
 * 运行：npm test（node --test "tests/*.test.mjs"，导入编译产物 lib/*.js）
 *
 * 覆盖（对应 docs/semantic.md §7 的 A105–A116）：
 *   A105 容错归一（认不出即 undefined，不抛）；A106 参数路径 fail-loud；
 *   A106b ★尸体样本：**不存在的日期**（2026-02-30）必须被拦——JS 原生解析会静默滚到 3 月 2 日；
 *   A107 相对写法固化成绝对日期；A108 三档 + ★尸体样本「未设死线**不得恒亮**」；
 *   A109 渲染只凸显需警觉的档位；A110 UTC 日粒度；A111 计数四档自洽；
 *   A112 过滤（零拷贝 + 未设死线任何档位都不返回）；A112b 过滤参数 fail-loud；
 *   A113 写路径盖章 + ★写入边界 schema 真 parse（新字段不得被静默剥掉）；
 *   A114 端到端（recall 过滤 + 投影 + 渲染 + stats 自洽 + ★存量兼容尸体样本 + fail-loud）；
 *   A115 update 三态；A116 汇总结论。
 *
 * ⚠ 时间夹具纪律：**不硬编码「今天」**——用「永远过去」的日期（2020-01-01）与相对写法
 * （+3d / +90d）构造档位，使断言与运行日期无关（双平台/跨日跑都稳）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore } from '../lib/store.js'
import { DIMENSION_ITEM_FIELDS, createMemoryTools } from '../lib/tools.js'
import { workspaceIdOf } from '../lib/scope.js'
import { entrySchema } from '../lib/index.js'
import {
  DUE_SOON_DAYS,
  MAX_WATCH_CHARS,
  STALENESS_LEVELS,
  UNTRACKED_STALENESS,
  countByStaleness,
  cueTag,
  daysUntil,
  filterByStaleness,
  normalizeReviewAfter,
  normalizeWatchFor,
  parseReviewAfterArg,
  parseStalenessFilterArg,
  parseWatchForArg,
  stalenessOf,
  stalenessTag,
  stalenessVerdict,
  watchForTag,
} from '../lib/temporal.js'

// ---------- 测试基建（与 grounding.test.mjs 同形） ----------

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

async function seed(store, { scope = WID, kind = 'knowledge', title, reviewAfter, watchFor }) {
  return store.remember({
    kind, title, body: `${title} 的正文`, tags: [], scope, level: null, bucket: null,
    ...(reviewAfter !== undefined ? { reviewAfter } : {}),
    ...(watchFor !== undefined ? { watchFor } : {}),
  })
}

function renderText(tool, args, value) {
  return tool.output.render(args, value).map((b) => b.text).join('\n')
}

/** 纯函数测试的固定基准时刻（不依赖「今天」） */
const NOW = new Date('2026-10-14T12:00:00.000Z')

/**
 * 相对「今天」的绝对日期（`YYYY-MM-DD`）——给**工具层**测试用。
 *
 * ⚠ 为什么不直接在夹具里写 `'+3d'`：相对写法**只在工具层折算**，而 `seed()` 走
 * `store.remember` 直落盘 ⇒ 存进去的是**脏值**（这正是 A108c 那条尸体样本要证明的事）。
 * 夹具用绝对日期才能与运行日期无关地构造出「3 天后到期」这一档；
 * 此处只做日期算术，**不复刻**被测的折算逻辑（否则测试会与被测同错）。
 */
function isoInDays(days) {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)
}

// ---------- A105 容错归一（服务通道 / 读路径） ----------

test('A105 normalize*（容错路径）：认得出给规范值，认不出即 undefined 且**不抛**', () => {
  assert.equal(normalizeReviewAfter('+7d', NOW), '2026-10-21')
  assert.equal(normalizeReviewAfter('2026-11-01', NOW), '2026-11-01')
  assert.equal(normalizeReviewAfter(undefined, NOW), undefined)
  assert.equal(normalizeReviewAfter('', NOW), undefined)
  // 认不出 / 非字符串 / 不存在的日期 ⇒ undefined（读历史数据不该让检索崩）
  assert.equal(normalizeReviewAfter('not-a-date', NOW), undefined)
  assert.equal(normalizeReviewAfter(42, NOW), undefined)
  assert.equal(normalizeReviewAfter('2026-02-30', NOW), undefined)

  assert.deepEqual(normalizeWatchFor(['a', 'b']), ['a', 'b'])
  assert.deepEqual(normalizeWatchFor('单条也接受'), ['单条也接受'])
  assert.equal(normalizeWatchFor([1, 2]), undefined)
  assert.equal(normalizeWatchFor('x'.repeat(MAX_WATCH_CHARS + 1)), undefined)
  assert.equal(normalizeWatchFor(undefined), undefined)
})

// ---------- A106 参数路径 fail-loud ----------

test('A106 parse*（参数路径）：合法通过、空 → undefined、非法**抛错**（两条路径分流）', () => {
  assert.equal(parseReviewAfterArg('2026-11-01', NOW), '2026-11-01')
  assert.equal(parseReviewAfterArg('2026-11-01T09:00:00Z', NOW), '2026-11-01', 'ISO 时刻取 UTC 日')
  assert.equal(parseReviewAfterArg('  ', NOW), undefined)
  assert.equal(parseReviewAfterArg(undefined, NOW), undefined)
  assert.throws(() => parseReviewAfterArg('随便', NOW), /无法解析/)
  assert.throws(() => parseReviewAfterArg(42, NOW), /必须是字符串/)
  assert.throws(() => parseReviewAfterArg('+0d', NOW), /正数/)
  assert.throws(() => parseReviewAfterArg('+4000d', NOW), /上限/)

  assert.deepEqual(parseWatchForArg(['a', '', '  b  ']), ['a', 'b'], '去空白、丢空串')
  assert.equal(parseWatchForArg(['  ']), undefined, '全空 ⇒ 视为未给')
  assert.throws(() => parseWatchForArg('x'.repeat(MAX_WATCH_CHARS + 1)), /超过/)
  assert.throws(() => parseWatchForArg(new Array(9).fill('c')), /最多/)
  assert.throws(() => parseWatchForArg([1]), /必须是字符串/)
})

test('A106b ★尸体样本：不存在的日期（2026-02-30）必须被拦——JS 会静默滚到 3 月 2 日', () => {
  // ① 先证「不拦会怎样」：JS 原生解析不报错，且悄悄换了个日期
  const raw = Date.parse('2026-02-30T23:59:59.999Z')
  assert.equal(Number.isFinite(raw), true, 'JS 原生解析不报错（这正是坑）')
  assert.equal(new Date(raw).toISOString().slice(0, 10), '2026-03-02', '它把 2-30 滚成了 3-02')
  // ② 我们的解析器必须拦（写入路径：抛错）
  assert.throws(() => parseReviewAfterArg('2026-02-30', NOW), /日期不存在/)
  // ③ 容错路径：认不出，**不当成有效死线**（否则会渲染出假的「已过期」）
  assert.equal(normalizeReviewAfter('2026-02-30', NOW), undefined)
  assert.equal(stalenessOf('2026-02-30', NOW), undefined, '读路径也不得把它当死线')
  assert.equal(stalenessTag('2026-02-30', NOW), '', '更不得据此打标记')
})

// ---------- A107 相对写法固化 ----------

test('A107 相对写法按**写入时刻**折算成绝对日期（不是存相对值 ⇒ 到期日不会漂移）', () => {
  assert.equal(parseReviewAfterArg('+7d', NOW), '2026-10-21')
  assert.equal(parseReviewAfterArg('+2w', NOW), '2026-10-28')
  assert.equal(parseReviewAfterArg('+1d', new Date('2026-10-31T23:30:00.000Z')), '2026-11-01', '跨月进位')
  assert.equal(parseReviewAfterArg('+1d', new Date('2026-12-31T23:30:00.000Z')), '2027-01-01', '跨年进位')

  // 存的是绝对日期 ⇒ 无论何时读，到期日都是同一个（相对值会让「何时到期」永远追不上）
  const stored = parseReviewAfterArg('+7d', NOW)
  assert.equal(stalenessOf(stored, new Date('2026-10-20T00:00:00.000Z')), 'due-soon')
  assert.equal(stalenessOf(stored, new Date('2026-10-22T00:00:00.000Z')), 'expired')
})

// ---------- A108 三档判定 + 尸体样本 ----------

test('A108 stalenessOf：三档边界正确；★未设死线**永远不亮**（尸体样本）', () => {
  assert.equal(stalenessOf('2026-10-14', NOW), 'due-soon', '当天到期（今天还没过完）')
  assert.equal(stalenessOf('2026-10-13', NOW), 'expired')
  assert.equal(stalenessOf('2026-10-21', NOW), 'due-soon', `第 ${DUE_SOON_DAYS} 天仍在窗口内`)
  assert.equal(stalenessOf('2026-10-22', NOW), 'fresh', `第 ${DUE_SOON_DAYS + 1} 天出窗口`)
  assert.equal(stalenessOf('2026-10-15', NOW), 'due-soon')

  // ★ 尸体样本：没设死线的条目**永远不亮**（若这里返回了值，全库都会恒亮 = 标记失效）
  assert.equal(stalenessOf(undefined, NOW), undefined)
  assert.equal(stalenessOf(null, NOW), undefined)
  assert.equal(stalenessOf('', NOW), undefined)
  assert.equal(stalenessOf('bogus', NOW), undefined, '脏值不当死线')
  assert.equal(stalenessOf(123, NOW), undefined)
  // 与 daysUntil / stalenessOf **同口径**（日差）：第 7 天是 due-soon，不是 fresh
  assert.equal(daysUntil('2026-10-21', NOW), DUE_SOON_DAYS)
})

test('A108b 形态白名单：非 ISO 形态的值**一律不被当死线**（合法性由我们定义，不由 V8 启发式定义）', () => {
  // `Date.parse` 接受的东西远广于 ISO：斜杠格式、自然语言日期它都收。若这些也算有效死线，
  // 「什么算合法死线」就有了第二个真源（我们定义的 vs V8 认的），库里会出现两种形态的日期。
  assert.equal(Number.isFinite(Date.parse('2026/11/01')), true, '斜杠格式 V8 认（我们**不**认）')
  assert.equal(Number.isFinite(Date.parse('Nov 1 2026')), true, '自然语言日期 V8 也认')
  // ⚠ 诚实标注：`'+3d'` 其实是 NaN —— 它不是本收窄的理由（初版注释在此写错过一次，勿复现）
  assert.equal(Number.isFinite(Date.parse('+3d')), false, '相对写法本身是 NaN')

  for (const bogus of ['+3d', '+90d', '2026/11/01', 'Nov 1 2026', '下周', 'bogus', '2026-02-30']) {
    assert.equal(stalenessOf(bogus, NOW), undefined, `不得把 ${bogus} 当死线`)
    assert.equal(stalenessTag(bogus, NOW), '', `更不得据此打标记：${bogus}`)
  }
  // 白名单内的两种形态仍认：规范日期 `YYYY-MM-DD` 与 ISO 时刻
  assert.equal(stalenessOf('2026-10-13', NOW), 'expired')
  assert.equal(stalenessOf('2026-10-13T09:00:00.000Z', NOW), 'expired')
})

// ---------- A109 渲染纪律 ----------

test('A109 stalenessTag：**只对需警觉的档位**打标记（fresh 与未设死线留空）', () => {
  assert.equal(stalenessTag('2026-10-13', NOW), '[⚠已过期1天]')
  assert.equal(stalenessTag('2026-10-11', NOW), '[⚠已过期3天]')
  assert.equal(stalenessTag('2026-10-14', NOW), '[⚠今日复查]')
  assert.equal(stalenessTag('2026-10-18', NOW), '[⚠4天后复查]')
  assert.equal(stalenessTag('2026-12-01', NOW), '', 'fresh 必须留空（全打标记等于没打）')
  assert.equal(stalenessTag(undefined, NOW), '', '未设死线留空')
  assert.equal(stalenessTag('bogus', NOW), '', '脏值留空')
})

test('A109b watchForTag：空/未给/全空白 ⇒ 空串；有值时列出全部条件', () => {
  assert.equal(watchForTag(undefined), '')
  assert.equal(watchForTag([]), '')
  assert.equal(watchForTag(['  ', '']), '')
  assert.equal(watchForTag(['条件 A', '条件 B']), '⚠观察条件：条件 A / 条件 B')
})

test('A109c cueTag（v0.16.0）：空/未给/全空白/脏值 ⇒ 空串；有值时列出全部情境形状', () => {
  assert.equal(cueTag(undefined), '')
  assert.equal(cueTag([]), '')
  // 脏值域：cue 从存储层来（可被手改坏），渲染层不得因脏值抛错——抛错会连累整条 recall 渲染
  assert.equal(cueTag('不是数组'), '', '非数组必须留空而不是抛错')
  assert.equal(cueTag([1, null, true]), '', '非字符串项必须被过滤')
  assert.equal(cueTag(['  ', '']), '')
  assert.equal(
    cueTag(['仪器要执行若干顺序动作', '其中一个会终止行动者自身的权限']),
    '◎适用处境：仪器要执行若干顺序动作 / 其中一个会终止行动者自身的权限',
  )
})

// ---------- A110 日粒度 ----------

test('A110 daysUntil：UTC 日粒度（今天 0 / 明天 1 / 昨天 -1；同一天任何时刻都相同）', () => {
  assert.equal(daysUntil('2026-10-14', NOW), 0)
  assert.equal(daysUntil('2026-10-15', NOW), 1)
  assert.equal(daysUntil('2026-10-13', NOW), -1)
  assert.equal(daysUntil(undefined, NOW), undefined)
  assert.equal(daysUntil('2026-10-14', new Date('2026-10-14T00:00:01.000Z')), 0, '日初')
  assert.equal(daysUntil('2026-10-14', new Date('2026-10-14T23:59:59.000Z')), 0, '日末 —— 同一天必须同档')
})

// ---------- A111 计数 ----------

test('A111 countByStaleness：四档且**之和 == 总数**（脏值归 untracked，不是 fresh）', () => {
  const entries = [
    { reviewAfter: '2026-10-13' },
    { reviewAfter: '2026-10-18' },
    { reviewAfter: '2026-12-01' },
    {},
    { reviewAfter: 'bogus' },
  ]
  const counts = countByStaleness(entries, NOW)
  assert.equal(counts.expired, 1)
  assert.equal(counts['due-soon'], 1)
  assert.equal(counts.fresh, 1)
  assert.equal(counts[UNTRACKED_STALENESS], 2, '未设 + 脏值都归「未跟踪」')
  const sum = STALENESS_LEVELS.reduce((acc, level) => acc + counts[level], 0) + counts[UNTRACKED_STALENESS]
  assert.equal(sum, entries.length, '分档之和必须 == 总数（口径同体）')
})

// ---------- A112 过滤 ----------

test('A112 filterByStaleness：未给 ⇒ 零拷贝；★未设死线的条目**任何档位都不返回**', () => {
  const entries = [
    { id: 'a', reviewAfter: '2026-10-13' },
    { id: 'b', reviewAfter: '2026-10-18' },
    { id: 'c', reviewAfter: '2026-12-01' },
    { id: 'd' },
  ]
  assert.equal(filterByStaleness(entries, undefined, NOW), entries, '未给参数 ⇒ 同一数组引用（零拷贝）')
  assert.equal(filterByStaleness(entries, [], NOW), entries)
  assert.deepEqual(filterByStaleness(entries, ['expired'], NOW).map((e) => e.id), ['a'])
  assert.deepEqual(filterByStaleness(entries, ['expired', 'due-soon'], NOW).map((e) => e.id), ['a', 'b'])
  // ★ 未设死线的 d：它的状态是「不知道」而非「有效」⇒ 任何档位都不返回
  assert.deepEqual(filterByStaleness(entries, ['fresh'], NOW).map((e) => e.id), ['c'])
  assert.deepEqual(
    filterByStaleness(entries, ['expired', 'due-soon', 'fresh'], NOW).map((e) => e.id),
    ['a', 'b', 'c'],
    '全档位也不返回未设死线的条目',
  )
})

test('A112b parseStalenessFilterArg：合法通过（单个字符串也接受）、空 → undefined、非法**抛错**', () => {
  assert.deepEqual(parseStalenessFilterArg(['expired', 'due-soon']), ['expired', 'due-soon'])
  assert.deepEqual(parseStalenessFilterArg('fresh'), ['fresh'])
  assert.deepEqual(parseStalenessFilterArg([' EXPIRED ']), ['expired'], '大小写与空白归一')
  assert.equal(parseStalenessFilterArg(undefined), undefined)
  assert.equal(parseStalenessFilterArg([]), undefined)
  assert.throws(() => parseStalenessFilterArg(['bogus']), /未知档位/)
  assert.throws(() => parseStalenessFilterArg([1]), /必须是字符串/)
})

// ---------- A113 写路径 + 写入边界 ----------

test('A113 写路径：remember 落字段（绝对日期）；不带则无键；非法 fail-loud 且**整笔拒绝**', async () => {
  const { store, byName } = setup()
  const remember = byName.get('remember')

  const created = await remember.execute(
    { text: '通道可用率读数', reviewAfter: '+30d', watchFor: ['通道重测低于 80%', '出口节点更换'] },
    EXEC,
  )
  const entry = store.get(WID, created.id)
  assert.match(entry.reviewAfter, /^\d{4}-\d{2}-\d{2}$/, '存的是绝对日期（相对写法已折算）')
  assert.deepEqual(entry.watchFor, ['通道重测低于 80%', '出口节点更换'])

  const plain = await remember.execute({ text: '不带时效的条目' }, EXEC)
  const plainEntry = store.get(WID, plain.id)
  assert.equal(Object.hasOwn(plainEntry, 'reviewAfter'), false, '不带 ⇒ **无该键**（无损 JSON 纪律）')
  assert.equal(Object.hasOwn(plainEntry, 'watchFor'), false)

  const before = store.list(WID).length
  await assert.rejects(() => remember.execute({ text: '非法死线', reviewAfter: '随便' }, EXEC), /无法解析/)
  assert.equal(store.list(WID).length, before, '整笔拒绝：非法死线不得留下半条记录')
})

test('A113b ★写入边界 schema：维度字段**不得被静默剥掉**（真 parse，不是 grep 源码）', () => {
  const base = {
    id: 'x', kind: 'knowledge', title: 't', body: 'b', tags: [], scope: 'global',
    createdAt: '2026-10-14T00:00:00.000Z', updatedAt: '2026-10-14T00:00:00.000Z',
    accessedAt: '2026-10-14T00:00:00.000Z', level: null, bucket: null, archived: false,
  }
  // ⚠ 从**真源**遍历键，不在测试里枚举字段名：本节原先硬编码 reviewAfter / watchFor 两个，
  //   v0.16.0 加 `cue` 时它**静默漏掉了新字段**（与 schema-parity A117 的夹具同一形状的失效：
  //   枚举式守卫在命名空间扩张时静默失效）。按常量自己声明的类型造样例值 ⇒ 新增维度字段自动覆盖。
  const sampleOf = (schema) => {
    if (schema.type === 'string') return schema.enum ? schema.enum[0] : '样例'
    if (schema.type === 'array') return ['样例']
    throw new Error(`样例生成器不认识维度字段类型「${schema.type}」——新增类型时须先扩这里，不许静默返回 undefined`)
  }
  const dims = Object.fromEntries(Object.entries(DIMENSION_ITEM_FIELDS).map(([k, s]) => [k, sampleOf(s)]))
  assert.ok(Object.keys(dims).length > 0, '前提：维度常量不得为空（否则本测试恒真）')

  const parsed = entrySchema.parse({ ...base, ...dims })
  for (const [k, v] of Object.entries(dims)) {
    assert.deepEqual(
      parsed[k],
      v,
      `${k} 必须存活（entrySchema 未声明它 ⇒ storage-domain 写入边界会静默剥掉，而写入**仍返回成功**）`,
    )
  }
  // 对照组：不带也合法（可选字段，不是必填），且不得被填默认值（「没标」与「标了」必须可区分）
  const bare = entrySchema.parse(base)
  for (const k of Object.keys(DIMENSION_ITEM_FIELDS)) {
    assert.equal(bare[k], undefined, `${k} 是可选字段，不带时不得被填默认值`)
  }
  // ★ 判据自证：未声明的字段**确实**会被剥掉——否则上面那循环恒真
  //   （「存活」就只是「没被剥」的另一种说法，而剥字段的机制可能压根没被走到：
  //    zod 若被改成 .passthrough()，A113b 会变成永远绿的假守卫）。
  const stripped = entrySchema.parse({ ...base, __not_declared_dimension__: 'x' })
  assert.equal(
    '__not_declared_dimension__' in stripped,
    false,
    '未声明字段必须被剥掉——否则本判据恒真（剥字段的机制没被走到）',
  )
})

// ---------- A114 端到端 ----------

test('A114 recall 按 staleness 过滤（缺省不过滤；结果项带该字段 = 投影层存活）', async () => {
  const { store, byName } = setup()
  await seed(store, { title: '过期读数', reviewAfter: '2020-01-01' })
  await seed(store, { title: '临近读数', reviewAfter: isoInDays(3) })
  await seed(store, { title: '远期读数', reviewAfter: isoInDays(90) })
  await seed(store, { title: '无时效条目' })

  const recall = byName.get('recall')
  const all = await recall.execute({ limit: 50 }, EXEC)
  const expired = await recall.execute({ staleness: ['expired'], limit: 50 }, EXEC)

  assert.equal(all.total, 4, '缺省不过滤')
  assert.equal(expired.total, 1, '只回过期的那一条')
  assert.equal(expired.results[0].title, '过期读数')
  assert.equal(expired.results[0].reviewAfter, '2020-01-01', '结果项必须带该字段（投影层）')
})

test('A114b 渲染：过期/临近打标记 + 观察条件；fresh 与未设死线**不得有任何标记**', async () => {
  const { store, byName } = setup()
  await seed(store, { title: '过期读数', reviewAfter: '2020-01-01', watchFor: ['通道重测低于 80%'] })
  await seed(store, { title: '远期读数', reviewAfter: isoInDays(90) })
  await seed(store, { title: '无时效条目' })

  const recall = byName.get('recall')
  const result = await recall.execute({ limit: 50 }, EXEC)
  const text = renderText(recall, { limit: 50 }, result)

  // ⚠ 定位必须避开**关联段**：`→ 关联: 远期读数(id=…)` 里也有标题，用 `includes(title)`
  // 会命中**上一行的关联段**（2026-10-14 实测踩中）。用正文形态 `] {title}(id=` 区分。
  const lineOf = (title) => text.split('\n').find((line) => line.includes(`] ${title}(id=`))
  assert.ok(lineOf('过期读数').includes('[⚠已过期'), `过期行应有标记：${lineOf('过期读数')}`)
  assert.ok(lineOf('过期读数').includes('⚠观察条件：通道重测低于 80%'), '观察条件必须印出（免费路由）')
  assert.ok(!lineOf('远期读数').includes('[⚠'), `fresh 行不得有标记：${lineOf('远期读数')}`)
  assert.ok(!lineOf('无时效条目').includes('[⚠'), `未设死线行不得有标记：${lineOf('无时效条目')}`)
})

test('A114c memory_stats：byStaleness 分档之和 == total；verdict 在有过期时点名', async () => {
  const { store, byName } = setup()
  await seed(store, { title: 'a', reviewAfter: '2020-01-01' })
  await seed(store, { title: 'b', reviewAfter: isoInDays(3) })
  await seed(store, { title: 'c', reviewAfter: isoInDays(90) })
  await seed(store, { title: 'd' })

  const stats = await byName.get('memory_stats').execute({}, EXEC)
  const s = stats.byStaleness
  const sum = STALENESS_LEVELS.reduce((acc, level) => acc + s[level], 0) + s[UNTRACKED_STALENESS]
  assert.equal(sum, stats.total, '分档之和必须 == total（口径同体）')
  assert.equal(s.expired, 1)
  assert.equal(s[UNTRACKED_STALENESS], 1)

  const text = renderText(byName.get('memory_stats'), {}, stats)
  assert.ok(text.includes('时效维'), text)
  assert.ok(text.includes('已过复查死线'), `有过期条目时必须点名：${text}`)
})

test('A114d ★存量兼容（尸体样本）：全无死线的库，行为与加维度前逐项一致', async () => {
  const { store, byName } = setup()
  for (let i = 0; i < 5; i += 1) await seed(store, { title: `历史条目 ${i}` })

  const recall = byName.get('recall')
  assert.equal((await recall.execute({ limit: 50 }, EXEC)).total, 5, '未给参数时不过滤任何条目')

  const stats = await byName.get('memory_stats').execute({}, EXEC)
  assert.equal(stats.byStaleness[UNTRACKED_STALENESS], stats.total, '存量全归「未设死线」')
  assert.equal(stats.byStaleness.expired, 0)
  // 全档位筛也取不到存量条目 —— 它们的时效状态是「不知道」，不是「有效」
  const none = await recall.execute({ staleness: [...STALENESS_LEVELS], limit: 50 }, EXEC)
  assert.equal(none.total, 0, '★存量条目在任何 staleness 取值下都不返回')

  // 渲染层：存量条目一行都不该出现标记
  const text = renderText(recall, { limit: 50 }, await recall.execute({ limit: 50 }, EXEC))
  assert.ok(!text.includes('[⚠'), `存量库渲染不得出现任何时效标记：${text}`)
})

test('A114e 工具面非法参数 → fail-loud（**双层**：schema 层 + 纯函数层）', async () => {
  const { store, byName } = setup()
  const { id } = await seed(store, { title: '任意条目' })
  // ① **schema 层**：工具参数声明了 enum ⇒ 由 DSH 的 ToolArgsError 先拦下（比我们的解析更早）
  await assert.rejects(() => byName.get('recall').execute({ staleness: ['bogus'] }, EXEC), /must be one of/)
  await assert.rejects(() => byName.get('memory_browse').execute({ staleness: ['bogus'] }, EXEC), /must be one of/)
  // ② **纯函数层**：schema 放过但语义非法的值（`reviewAfter` 声明为 string ⇒ '随便' 能过 schema）
  await assert.rejects(() => byName.get('update').execute({ id, reviewAfter: '随便' }, EXEC), /无法解析/)
  await assert.rejects(() => byName.get('update').execute({ id, reviewAfter: '2026-02-30' }, EXEC), /日期不存在/)
  // ③ 纯函数层直调：**绕过 schema 的路径也必须 fail-loud**
  //    （防「只有工具面才安全」的假安全感——内部调用方与测试都走这条）
  assert.throws(() => parseStalenessFilterArg(['bogus']), /未知档位/)
  assert.throws(() => parseReviewAfterArg('随便', NOW), /无法解析/)
})

// ---------- A115 update 三态 ----------

test('A115 update 三态：给值 = 续期 / 空值 = 清除（**删键**）/ 缺省 = 不动', async () => {
  const { store, byName } = setup()
  const remember = byName.get('remember')
  const update = byName.get('update')
  const { id } = await remember.execute({ text: '存量条目', watchFor: ['旧条件'] }, EXEC)
  assert.equal(Object.hasOwn(store.get(WID, id), 'reviewAfter'), false)

  await update.execute({ id, reviewAfter: '+30d' }, EXEC)
  assert.match(store.get(WID, id).reviewAfter, /^\d{4}-\d{2}-\d{2}$/, '① 给值 = 设置（也是「到期后动作链」的续期入口）')

  await update.execute({ id, tags: ['x'] }, EXEC)
  assert.notEqual(store.get(WID, id).reviewAfter, undefined, '② 缺省 = 不动')
  assert.deepEqual(store.get(WID, id).watchFor, ['旧条件'], '② 未给的字段同样不动')

  await update.execute({ id, reviewAfter: '' }, EXEC)
  const cleared = store.get(WID, id)
  assert.equal(Object.hasOwn(cleared, 'reviewAfter'), false, '③ 空串 = 清除（删键，不留 undefined）')

  await update.execute({ id, watchFor: [] }, EXEC)
  assert.equal(Object.hasOwn(store.get(WID, id), 'watchFor'), false, '③ 空数组 = 清空')
})

// ---------- A116 汇总结论 ----------

test('A116 stalenessVerdict：有过期时**点名风险并给处置指引**；全未设死线时提示退出判据', () => {
  const alerting = stalenessVerdict({ expired: 3, 'due-soon': 1, fresh: 5, [UNTRACKED_STALENESS]: 10 })
  assert.ok(alerting.includes('3 条已过复查死线'), alerting)
  assert.ok(alerting.includes("recall({ staleness: 'expired' })"), '必须给出取回入口')
  assert.ok(alerting.includes('已设死线 9 / 未设 10'), alerting)

  const idle = stalenessVerdict({ expired: 0, 'due-soon': 0, fresh: 0, [UNTRACKED_STALENESS]: 7 })
  assert.ok(idle.includes('全部未设复查死线'), idle)
  assert.ok(idle.includes('退出判据'), '全未设必须提示退出判据（防死字段）')

  const healthy = stalenessVerdict({ expired: 0, 'due-soon': 0, fresh: 4, [UNTRACKED_STALENESS]: 1 })
  assert.ok(!healthy.includes('⚠'), `无过期时不得报警：${healthy}`)

  assert.equal(stalenessVerdict({}), '库里没有条目。')
  // 容错读取：键缺失 / 非数字当 0（**不抛**——调用方是 render 层，拿到的是弱类型对象）
  assert.ok(
    stalenessVerdict({ expired: 'x', [UNTRACKED_STALENESS]: 3 }).includes('全部未设复查死线'),
    '非数字当 0 ⇒ 与「未设死线的 3 条」构成全未跟踪',
  )
  assert.equal(stalenessVerdict({ expired: 'x' }), '库里没有条目。', '全都是非法值时按空库处理，不抛')
})
