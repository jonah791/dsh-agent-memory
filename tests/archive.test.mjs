/**
 * 归档因果 + 来源类型（v0.21.0）——`archival` 与 `provenance` 两个新维度的判据集。
 *
 * 背景：这是**返回弧**（forget 的因果）与 **`p` 轴**（来源链）的第一次落地。
 * 两件事的共同病因是同一个：`source` 字段被当成两个东西用（来源链 + 归档原因），
 * 于是「我引用的那条为什么没了」和「这条结论的权威归谁」都无法在机制上回答。
 *
 * 判据纪律（照本仓既有做法）：
 * - **每条判据都配一个已知坏样本**（尸体测试）——恒为真的断言不是证据。
 * - **对照组**：不该打标记的必须**真的不打**（`[已合并]` / `[主人]`），否则「标记要挑着打」
 *   那条纪律形同虚设。
 * - **不枚举字段名**（判据㉓：枚举式守卫在命名空间扩张时静默失效），能走常量就走常量。
 *
 * 运行：npm test（node --test "tests/*.test.mjs"，导入编译产物 lib/*.js）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore } from '../lib/store.js'
import { createMemoryTools } from '../lib/tools.js'
import { workspaceIdOf } from '../lib/scope.js'
import {
  ARCHIVE_REASON_TYPES,
  PROVENANCE_TYPES,
  archivalOf,
  archiveReasonTag,
  countByArchiveReason,
  countByProvenance,
  parseArchiveReasonTypeArg,
  parseProvenanceArg,
  provenanceTag,
} from '../lib/archive.js'
// `transcriptiveFlagOf` 在 origin.ts（不在 archive.ts）——声明与猜测的分工见该模块文件头
import { transcriptiveFlagOf, transcriptiveFlagOf as originEntryFlag } from '../lib/origin.js'

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
  return { kv, store, byName }
}

const EXEC = {
  agent: { session: { id: 'session-11111111-2222-3333-4444-555555555555', header: { cwd: CWD } } },
  signal: new AbortController().signal,
}

async function seed(store, overrides = {}) {
  return store.remember({
    kind: 'knowledge',
    title: overrides.title ?? '测试条目',
    body: overrides.body ?? '正文',
    tags: [],
    scope: WID,
    level: null,
    bucket: null,
    ...overrides,
  })
}

// ============================================================================
// 一、archival：forget 的因果（返回弧）
// ============================================================================

test('A1 ★ forget 把因果写进 archival，且**不再污染 source**', async () => {
  const { store } = setup()
  const { id } = await seed(store)
  const archived = await store.forget(WID, id, { reasonType: 'refuted', reason: '后来的实测推翻了它' })

  assert.ok(archived !== undefined, 'forget 返回了 undefined（条目没被归档）')
  assert.equal(archived.archived, true, 'archived 标记没置上')
  assert.equal(archived.archivedReasonType, 'refuted', 'reasonType 没写进 archival')
  assert.equal(archived.archivedReason, '后来的实测推翻了它', 'reason 没写进 archival')
  assert.match(archived.updatedAt, /^\d{4}-\d{2}-\d{2}T/, 'archival.at 不是 ISO 时刻')

  // ★ 本判据的核心：source 不再被归档原因污染（旧实现写的是 source.reason）
  assert.equal(
    archived.source?.reason,
    undefined,
    '归档原因仍落进了 source.reason ⇒ 字段语义错配没修好（`source` 该答「从哪来」不是「怎么没了」）',
  )
})

test('A1b 对照：forget 不给 reasonType 时落 unspecified（**不是**某个具体原因）', async () => {
  const { store } = setup()
  const { id } = await seed(store)
  const archived = await store.forget(WID, id)
  assert.equal(
    archived.archivedReasonType,
    'unspecified',
    '缺省应显式落 unspecified（「未判断」），而不是被猜成某个具体原因',
  )
  assert.equal(archived.archivedReason, undefined, '没给 reason 时不该凭空造一个')
})

test('A2 ★ 存量归一：v0.20 及以前「归档原因在 source.reason 里」的条目读得出因果关系', async () => {
  // 尸体样本：直接构造旧形态（不迁移数据是 v0.21.0 的明确决定）
  const legacy = {
    archived: true,
    source: { reason: '旧版的归档原因文本' },
    updatedAt: '2026-10-01T00:00:00.000Z',
  }
  const record = archivalOf(legacy)
  assert.ok(record !== undefined, '旧形态条目读不出归档记录 ⇒ 「我引用的那条为什么没了」在存量上仍无解')
  assert.equal(record.reasonType, 'unspecified', '旧形态必须读成 unspecified（它确实没有类型）')
  assert.equal(record.reason, '旧版的归档原因文本', '旧形态的 reason 文本丢了')
  assert.equal(record.at, '2026-10-01T00:00:00.000Z', '时刻应取 updatedAt（归档会刷新它）')
})

test('A2b ★ 对照：**未归档**条目的 source.reason 不得被读成归档记录', async () => {
  // 真实形态：timeline.ts 写概要条目时往 source.reason 塞「时间压缩：…」，那是**产出说明**
  // 不是归档记录。不加 `archived === true` 这个条件，概要把自己伪装成「被归档的条目」——
  // 正是字段语义错配的老毛病换个地方重演。
  const summaryLike = {
    archived: false,
    source: { reason: '时间压缩：day 2026-11-01，覆盖 12 条原料' },
    updatedAt: '2026-11-01T00:00:00.000Z',
  }
  assert.equal(
    archivalOf(summaryLike),
    undefined,
    '未归档条目被读出了归档记录 ⇒ 概要会把自己伪装成「被归档的条目」',
  )
})

test('A3 归档原因计数：新形态 + 旧形态 + 未归档三者各自落对', async () => {
  const { store } = setup()
  const a = await seed(store, { title: '被证伪的' })
  const b = await seed(store, { title: '被合并的' })
  await seed(store, { title: '还活着的' })
  await store.forget(WID, a.id, { reasonType: 'refuted', reason: 'x' })
  await store.forget(WID, b.id, { reasonType: 'merged', reason: 'y' })

  const counts = countByArchiveReason(store.list(WID, { includeArchive: true }))
  assert.equal(counts.refuted, 1, 'refuted 计数错')
  assert.equal(counts.merged, 1, 'merged 计数错')
  assert.equal(counts.unspecified, 0, '不该有 unspecified（两条都给了明确类型）')
  const sum = ARCHIVE_REASON_TYPES.reduce((acc, key) => acc + counts[key], 0)
  assert.equal(sum, 2, `分档之和应为已归档数 2，实为 ${sum}（口径不同体）`)
})

// ============================================================================
// 二、provenance：来源链（`p` 轴）
// ============================================================================

test('B1 provenance 落盘并贯穿投影层（recall 结果里看得见）', async () => {
  const { store, byName } = setup()
  await seed(store, { title: '实测出来的读数', provenance: 'measured' })

  const recall = byName.get('recall')
  const value = await recall.execute({}, EXEC)
  assert.ok(value.results.length > 0, '夹具没落盘')
  assert.equal(
    value.results[0].provenance,
    'measured',
    '结果项里没有 provenance ⇒ 渲染层打不出标记（v0.13/v0.14/v0.15 连续三版都栽在这个投影点）',
  )
})

test('B2 ★ provenance 过滤：`self` 能把「我自己推的」捞出来（审查入口）', async () => {
  const { store, byName } = setup()
  await seed(store, { title: '我推的方案', provenance: 'self' })
  await seed(store, { title: '主人说的话', provenance: 'master' })
  await seed(store, { title: '网上读的', provenance: 'web' })

  const recall = byName.get('recall')
  const selfOnly = await recall.execute({ provenance: 'self' }, EXEC)
  assert.equal(selfOnly.results.length, 1, `provenance 过滤没生效（返回 ${selfOnly.results.length} 条）`)
  assert.equal(selfOnly.results[0].title, '我推的方案', '过滤把别的来源放进来了')

  // 对照：不给过滤条件时三条都在（可选筛子，不是可见性边界）
  const all = await recall.execute({}, EXEC)
  assert.equal(all.results.length, 3, '不过滤时应返回全部 3 条')
})

test('B3 ★ update 三态：给值设置 / 空串清除 / 缺省不动', async () => {
  const { store, byName } = setup()
  const { id } = await seed(store, { title: '三态样本', provenance: 'web' })
  const update = byName.get('update')

  // ① 缺省 = 不动
  await update.execute({ id, text: '三态样本\n改了一行正文' }, EXEC)
  assert.equal(store.get(WID, id)?.provenance, 'web', '不给 provenance 时被动了（应「不动」）')

  // ② 给值 = 设置
  await update.execute({ id, provenance: 'measured' }, EXEC)
  assert.equal(store.get(WID, id)?.provenance, 'measured', '给值时没设置上')

  // ③ 空串 = 清除回未标注
  await update.execute({ id, provenance: '' }, EXEC)
  assert.equal(
    store.get(WID, id)?.provenance,
    undefined,
    '空串应清除回「未标注」（留 provenance:"" 会产生第二种表示 ⇒ 两个真源）',
  )
})

test('B4 合并路径保留原 provenance（不静默改写来源）', async () => {
  const { store } = setup()
  const first = await seed(store, { title: '同标题的记忆', body: '原正文', provenance: 'master' })
  // 同标题指纹 ⇒ 走 mergeEntry；draft 的 provenance 不同，但**保留原标注**
  const second = await store.remember({
    kind: 'knowledge',
    title: '同标题的记忆',
    body: '补充正文',
    tags: [],
    scope: WID,
    level: null,
    bucket: null,
    provenance: 'measured',
  })
  assert.equal(second.id, first.id, '前提：应走合并路径（同标题指纹）')
  assert.equal(
    store.get(WID, first.id)?.provenance,
    'master',
    '合并把原来源改了 ⇒ 两条来源不同时静默覆盖，等于篡改「这条是谁说的」',
  )
})

// ============================================================================
// 三、渲染标记：标记要挑着打（对照组是判据的一半）
// ============================================================================

test('C1 来源标记：只凸显权威不在我这一侧的（[外部] / [自推]）', () => {
  assert.equal(provenanceTag('web'), '[外部]', 'web 该打标记（别人的说法）')
  assert.equal(provenanceTag('self'), '[自推]', 'self 该打标记（我的提议不是主人的话）')
  // ★ 对照组：硬来源与未标注必须**真的空**
  assert.equal(provenanceTag('master'), '', 'master 不该打标记（主人的话是硬来源，全打等于没打）')
  assert.equal(provenanceTag('measured'), '', 'measured 不该打标记（我自己的读数是硬来源）')
  assert.equal(provenanceTag(undefined), '', '未标注不该打标记')
})

test('C2 归档标记：只对「结论已不能用」的原因打（[被证伪] 打，[已合并] 不打）', () => {
  assert.equal(archiveReasonTag('refuted'), '[被证伪]', '被证伪必须打（引用方要撤）')
  assert.equal(archiveReasonTag('superseded'), '[被取代]', '被取代必须打')
  assert.equal(archiveReasonTag('stale'), '[已过时]', '过时必须打')
  // ★ 对照组：内容还在的两种不得打
  assert.equal(archiveReasonTag('merged'), '', '已合并不该打（内容还在，只是换了位置）')
  assert.equal(archiveReasonTag('capacity'), '', '容量清理不该打（不因为错）')
  assert.equal(archiveReasonTag('unspecified'), '', '未分类不该打')
  assert.equal(archiveReasonTag(undefined), '', '未归档不该打')
})

test('C3 render 端到端：recall 文本里出现来源标记，且归档条目的原因标记随 includeArchive 出现', async () => {
  const { store, byName } = setup()
  await seed(store, { title: '外部读来的东西', provenance: 'web' })
  const gone = await seed(store, { title: '后来被推翻的结论', provenance: 'measured' })
  await store.forget(WID, gone.id, { reasonType: 'refuted', reason: '实测推翻了' })

  const recall = byName.get('recall')
  const live = await recall.execute({}, EXEC)
  const liveText = recall.output.render({}, live).map((b) => b.text).join('\n')
  assert.ok(liveText.includes('[外部]'), `活跃条目行的 render 缺来源标记：\n${liveText}`)
  assert.ok(!liveText.includes('[被证伪]'), '默认视图不该出现归档条目的标记（归档条目本就不该在结果里）')

  const withArchive = await recall.execute({ includeArchive: true }, EXEC)
  const archText = recall.output.render({}, withArchive).map((b) => b.text).join('\n')
  assert.ok(
    archText.includes('[被证伪]'),
    `归档条目的原因标记没打出来 ⇒ 「我引用的那条为什么没了」在界面上仍看不见：\n${archText}`,
  )
})

// ============================================================================
// 四、与既有 origin（正则启发式）的联动：声明取代猜测
// ============================================================================

test('D1 ★ provenance 接管 origin 判据：`measured` 的条目不再被误标「转述型·无出处」', () => {
  // 尸体样本：标题命中转述形态、正文无 arXiv 编号 ⇒ 旧判据**必然**标它
  const body = '我的实测结论，没有引用任何论文'
  assert.equal(
    originEntryFlag({ title: '论文：某主题评估', body }),
    true,
    '前提：旧判据对这条确实会标（否则本判据无分辨力）',
  )
  // 声明为「我实测的」⇒ 它的权威是我自己的读数，不是转述 ⇒ 不该标
  assert.equal(
    transcriptiveFlagOf({ provenance: 'measured', title: '论文：某主题评估', body }),
    false,
    '已声明 provenance=measured 仍被旧正则误标 ⇒ 声明没接管判据（正则的已知误标照旧）',
  )
  // 对照：未标注 ⇒ 回退旧行为（零回归）
  assert.equal(
    transcriptiveFlagOf({ title: '论文：某主题评估', body }),
    true,
    '未标注时必须回退旧启发式（否则存量条目的既有行为被改了）',
  )
})

test('D2 provenance=web 时判据改为「它自己说的来源有没有可核出处」', () => {
  // ① 自认外部来源 + 无出处 ⇒ 标（**它确实没给出处**）
  assert.equal(
    transcriptiveFlagOf({ provenance: 'web', title: '随手记的一条', body: '某处看到说 X 会 Y' }),
    true,
    '自认外部来源却没出处 ⇒ 必须标',
  )
  // ② 自认外部来源 + 有 arXiv 编号 ⇒ 不标（可核）
  assert.equal(
    transcriptiveFlagOf({ provenance: 'web', title: '随手记的一条', body: '见 arXiv:2606.30306' }),
    false,
    '有可核出处的转述不该被同等对待（那会把标记变成噪音）',
  )
  // ③ 标题不像转述、但自认外部来源 + 无出处 ⇒ **仍要标**（这是正则做不到的那一半：
  //    正则只看标题形态，而 provenance 是声明，与标题长什么样无关）
  assert.equal(
    transcriptiveFlagOf({ provenance: 'web', title: '通道可用率读数', body: '据某个博客说 80%' }),
    true,
    '正则在「标题不像转述」时看不见外部来源——provenance 应补上这一半',
  )
})

// ============================================================================
// 五、fail-loud：非法值不静默降级
// ============================================================================

test('E1 ★ 非法 provenance / reasonType 必须抛错，不得静默当「未标注」', () => {
  // 静默降级正是这两个维度要防的失败：我以为标了、其实没标，
  // 而未来的我拿一条「不知道来源」的结论当实测定论用。
  assert.throws(() => parseProvenanceArg('mater', 'test'), /未知来源类型/, '拼错的值必须报错')
  assert.throws(() => parseArchiveReasonTypeArg('refute', 'test'), /未知归档原因类型/, '拼错的值必须报错')

  // 对照组：合法值与缺省不抛
  assert.equal(parseProvenanceArg('measured', 'test'), 'measured')
  assert.equal(parseProvenanceArg(undefined, 'test'), undefined)
  assert.equal(parseProvenanceArg('  ', 'test'), undefined, '空白串应视为未给（不是非法值）')
  assert.equal(parseArchiveReasonTypeArg('refuted', 'test'), 'refuted')
})

test('E2 工具层 fail-loud：remember / update / forget 传非法值都抛错', async () => {
  const { store, byName } = setup()
  const { id } = await seed(store)

  await assert.rejects(
    () => byName.get('remember').execute({ text: '标题\n正文', provenance: 'master2' }, EXEC),
    /未知来源类型/,
    'remember 对非法 provenance 没抛错（静默丢了标注）',
  )
  await assert.rejects(
    () => byName.get('update').execute({ id, provenance: 'web2' }, EXEC),
    /未知来源类型/,
    'update 对非法 provenance 没抛错',
  )
  await assert.rejects(
    () => byName.get('forget').execute({ id, reasonType: 'refute' }, EXEC),
    /未知归档原因类型/,
    'forget 对非法 reasonType 没抛错（静默当成 unspecified = 「我判断过」与「我打错字」同形）',
  )
})

test('E3 forget 工具端到端：reasonType 落进 archival 且条目真的归档了', async () => {
  const { store, byName } = setup()
  const { id } = await seed(store, { title: '要归档的条目' })
  await byName.get('forget').execute({ id, reasonType: 'superseded', reason: '新结论覆盖了它' }, EXEC)

  const entry = store.get(WID, id)
  assert.equal(entry?.archived, true, '条目没被归档')
  assert.equal(entry?.archivedReasonType, 'superseded', 'reasonType 没落盘')
  assert.equal(entry?.archivedReason, '新结论覆盖了它', 'reason 没落盘')
  assert.equal(entry?.source?.reason, undefined, '仍写进了 source.reason（语义错配没修好）')
})

// ============================================================================
// 六、常量自证（判据不能恒真）
// ============================================================================

test('F1 常量非空且无重复（否则靠枚举常量的判据会恒真）', () => {
  assert.equal(new Set(ARCHIVE_REASON_TYPES).size, ARCHIVE_REASON_TYPES.length, '归档原因类型有重复')
  assert.equal(new Set(PROVENANCE_TYPES).size, PROVENANCE_TYPES.length, '来源类型有重复')
  assert.ok(ARCHIVE_REASON_TYPES.length >= 6, '归档原因类型少于 6 档（设计值）')
  assert.equal(PROVENANCE_TYPES.length, 4, '来源类型应为 4 档（设计值）')
  // 计数函数的域必须覆盖全部常量（漏一档会让那档永远读 0，看起来像「没人用」）
  const emptyProvenance = countByProvenance([])
  for (const p of PROVENANCE_TYPES) {
    assert.equal(typeof emptyProvenance[p], 'number', `countByProvenance 漏了 ${p} 档`)
  }
  const emptyArchive = countByArchiveReason([])
  for (const t of ARCHIVE_REASON_TYPES) {
    assert.equal(typeof emptyArchive[t], 'number', `countByArchiveReason 漏了 ${t} 档`)
  }
})
