/**
 * v0.52 详情出口单测（方案 §12.1）——「字段已在、渲染不印」的那两项。
 *
 * 覆盖：
 *   A160 逐角色准入判读 `readableRolesOf`：R1/R3/R4/R0 四种拒因 + 维度未启用返回空数组
 *   A161 `recall` 在**同一处返回**里给出 `readableBy`（判据①）；未启用时不写键且页脚说清；
 *        `revisions`/`readableBy` 两侧 schema 同源（防 v0.13–v0.15 那种漂移）
 *   A162 `revisions` 透出投影形状（含 at/mode/prevTitle，**不含 prevBody**）；无记录不套空壳标记
 *
 * 运行：node --test "tests/*.test.mjs"（导入编译产物 lib/*.js）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore } from '../lib/store.js'
import { createMemoryTools, AUDIT_ITEM_FIELDS } from '../lib/tools.js'
import { entrySchema } from '../lib/index.js'
import { readableRolesOf } from '../lib/role.js'
import { workspaceIdOf } from '../lib/scope.js'

// ---------- 测试基建（同 role.test.mjs：跨平台 WID 由被测派生函数算出） ----------

const NL = String.fromCharCode(10)
const BS = String.fromCharCode(92)

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

const CWD = ['C:', 'Users', 'Alice', 'proj'].join(BS)
const WID = workspaceIdOf(CWD)

const BASE_CONFIG = {
  scope: 'workspace',
  layers: ['fact', 'knowledge', 'episodic'],
  autoSink: true,
  timeline: { day: true, week: true, month: true, year: true, archive: 'keep' },
  weeklyTemplate: '',
  maxEntries: 2000,
  inject: { enabled: true, maxBytes: 3000, maxEntries: 20 },
  autoInject: { enabled: true, maxBytes: 1500, maxEntries: 3 },
}

/** 角色维度**未启用**（历史配置字面量）——判据要能区分「未启用」与「谁都能读」 */
const LEGACY_CONFIG = { ...BASE_CONFIG }

/** 与线上 `.dsh/memory.yml` 同形：main(默认) / worker / verifier / ghost 四种角色 */
const ROLE_CONFIG = {
  ...BASE_CONFIG,
  roles: {
    enabled: true,
    default: 'main',
    derived: 'worker',
    byPreset: {},
    policyDefault: { read: ['*'], includeShared: true, includeGlobal: true },
    policies: {
      worker: { read: ['main'], includeShared: true, includeGlobal: true },
      verifier: { read: ['main'], includeShared: true, includeGlobal: false, kinds: ['fact', 'knowledge', 'summary'] },
      ghost: { read: [], includeShared: true, includeGlobal: false },
    },
  },
}

function setup(config) {
  const store = new MemoryStore(new MemoryKv())
  const tools = createMemoryTools({ store, loadConfig: async () => config })
  return { store, byName: new Map(tools.map((tool) => [tool.name, tool])) }
}

function execOf({ sessionId, depth, preset } = {}) {
  const header = { cwd: CWD }
  if (sessionId !== undefined) header.id = sessionId
  if (depth !== undefined) header.delegationDepth = depth
  if (preset !== undefined) header.agentPreset = preset
  return { agent: { session: { id: sessionId, header } }, signal: new AbortController().signal }
}

const MAIN_EXEC = execOf({ sessionId: 'session-11111111-2222-3333-4444-555555555555' })

async function seed(store, { scope = WID, kind = 'knowledge', title, role }) {
  return store.remember({ kind, title, body: `${title} 的正文`, tags: [], scope, level: null, bucket: null, role })
}

/** 判读压缩成 `{角色: 'yes' | 拒因码}`，断言读起来才像一张表 */
function verdictsOf(entry, options = {}) {
  const rows = readableRolesOf({ roles: ROLE_CONFIG.roles }, entry, options)
  return Object.fromEntries(rows.map((row) => [row.role, row.canRead ? 'yes' : row.reason]))
}

// ---------- A160 逐角色准入判读 ----------

test('A160 readableRolesOf：候选角色 = 缺省∪派生∪已声明；四类拒因各归各位', () => {
  const shared = { kind: 'fact', role: undefined, space: undefined }
  assert.deepEqual(
    verdictsOf(shared),
    { main: 'yes', worker: 'yes', verifier: 'yes', ghost: 'yes' },
    '共享 fact：四角色都可读（R2 共享放行）',
  )

  const workerKnowledge = { kind: 'knowledge', role: 'worker', space: undefined }
  assert.deepEqual(
    verdictsOf(workerKnowledge),
    { main: 'yes', worker: 'yes', verifier: 'R4-read', ghost: 'R4-read' },
    'worker 隔间：自己与主脑可读，verifier/ghost 被读白名单拒（R4）',
  )

  const workerEpisodic = { kind: 'episodic', role: 'worker', space: undefined }
  assert.equal(verdictsOf(workerEpisodic).verifier, 'R1-kind', 'kinds 收窄先于读白名单（R1 在 R4 之前）')

  assert.deepEqual(
    verdictsOf({ kind: 'fact', role: undefined, space: undefined }, { entryInGlobalScope: true }),
    { main: 'yes', worker: 'yes', verifier: 'R0-global', ghost: 'R0-global' },
    'includeGlobal=false 的角色看不见 global 作用域（R0，作用域层准入）',
  )

  assert.deepEqual(
    readableRolesOf({ roles: { ...ROLE_CONFIG.roles, enabled: false } }, { kind: 'fact' }),
    [],
    '维度未启用 ⇒ 空数组（**不是**「谁都不能读」）',
  )
  assert.deepEqual(readableRolesOf(LEGACY_CONFIG, { kind: 'fact' }), [], '无 roles 段 ⇒ 同样不判')
})

// ---------- A161 recall 同一返回里给出 readableBy ----------

test('A161 recall：readableBy 随结果返回；只打坏消息；未启用走页脚', async () => {
  const enabled = setup(ROLE_CONFIG)
  const shared = await seed(enabled.store, { kind: 'knowledge', title: '共享知识' })
  const compartment = await seed(enabled.store, { kind: 'knowledge', title: '工人隔间里的知识', role: 'worker' })
  const recall = enabled.byName.get('recall')

  const value = await recall.execute({}, MAIN_EXEC)
  const sharedItem = value.results.find((row) => row.id === shared.id)
  const compItem = value.results.find((row) => row.id === compartment.id)
  assert.ok(sharedItem !== undefined && compItem !== undefined, '两条都应在结果里')
  assert.deepEqual(sharedItem.readableBy.map((row) => row.role), ['main', 'worker', 'verifier', 'ghost'], '四角色各一行')
  assert.ok(sharedItem.readableBy.every((row) => row.canRead), '共享记忆四角色都可读')
  assert.deepEqual(
    compItem.readableBy.filter((row) => !row.canRead).map((row) => row.role),
    ['verifier', 'ghost'],
    'worker 隔间：verifier / ghost 读不到',
  )

  const text = recall.output.render({}, value).map((part) => part.text).join(NL)
  // ⚠ 用 id 定位行、不用标题子串：相关链后缀会把另一条的标题也带进来（`→ 关联: XX`），
  // 按标题 find 可能命中错的条目行（实测：按'共享知识'命中了隔间那条的关联段）。
  // ⚠ 只取**条目行**（以 `- [` 开头）：相关链后缀 `→ 关联: XX(id=…)` 也带别的条目 id，
  // 按 id 裸 find 会命中它（实测：按 title 与按 id 各栽了一次，才改成先按行型收窄）。
  // ⚠ 还要切掉相关链段（`→ 关联: …`）：它同时带两条的 title+id，两个 id 在两行里都出现，
  // 不切的话 `find(id=…)` 永远命中第一行（实测第三次栽在这里）。
  const ownPart = (line) => line.split('→ 关联')[0]
  const entryLines = text.split(NL).filter((line) => line.startsWith('- ['))
  const compLine = entryLines.find((line) => ownPart(line).includes(`id=${compartment.id})`))
  const sharedLine = entryLines.find((line) => ownPart(line).includes(`id=${shared.id})`))
  assert.ok(compLine.includes('🚫verifier(R4-read)'), '读不到的角色必须点名并给拒因码')
  assert.equal(sharedLine.includes('🚫'), false, '全都读得到时**不印**（标记要挑着打，A119b）')
  assert.equal(text.includes('角色维度未启用'), false, '启用时不得说「未启用」')

  // 两侧 schema 同源（v0.13–v0.15 的漂移就是「一处加、另一处没加」）。
  // 不能逐引用比较：DSL 会把嵌套的 `required: true` 规范化成对象级 `required: [...]`。
  // 判据因此取「键都在 + 两侧深相等」——同样抓得住漂移（少一处 ⇒ 键缺失；两处各写 ⇒ 深比较红）。
  const recallProps = recall.output.schema.properties.results.items.properties
  const browseProps = enabled.byName.get('memory_browse').output.schema.properties.groups.items.properties.items.items.properties
  for (const key of Object.keys(AUDIT_ITEM_FIELDS)) {
    assert.ok(key in recallProps, `recall schema 缺 ${key}（AUDIT_ITEM_FIELDS 声明了它）`)
    assert.ok(key in browseProps, `browse schema 缺 ${key}（AUDIT_ITEM_FIELDS 声明了它）`)
    assert.deepEqual(recallProps[key], browseProps[key], `${key} 两侧必须是同一份定义`)
  }

  // 维度未启用：结果项不含该键（省略 ≠ 谁都能读），页脚一次性说清（双义状态）
  const disabled = setup(LEGACY_CONFIG)
  await seed(disabled.store, { kind: 'knowledge', title: '另一条知识' })
  const legacyRecall = disabled.byName.get('recall')
  const legacyValue = await legacyRecall.execute({}, MAIN_EXEC)
  assert.equal(legacyValue.results[0].readableBy, undefined, '未启用 ⇒ 结果项不含 readableBy')
  const legacyText = legacyRecall.output.render({}, legacyValue).map((part) => part.text).join(NL)
  assert.ok(legacyText.includes('角色维度未启用'), '「没算过」与「谁都能读」同一个空白两种含义 ⇒ 必须说清')
  const legacyLine = legacyText.split(NL).filter((line) => line.startsWith('- [')).find((line) => line.includes('另一条知识'))
  assert.equal(legacyLine.includes('🔓'), false, '未启用时条目行不得带空壳标记')
})

// ---------- A162 revisions 透出与「无记录」 ----------

test('A162 recall：revisions 透出投影形状（不含 prevBody）；无记录不套空壳标记', async () => {
  const { store, byName } = setup(ROLE_CONFIG)
  const revised = await seed(store, { kind: 'knowledge', title: '原标题' })
  const untouched = await seed(store, { kind: 'knowledge', title: '从未改过' })

  await byName.get('update').execute({ id: revised.id, mode: 'replace', text: '新标题' + NL + '新正文' }, MAIN_EXEC)

  const recall = byName.get('recall')
  const value = await recall.execute({}, MAIN_EXEC)
  const changed = value.results.find((row) => row.id === revised.id)
  assert.equal(changed.revisions.length, 1, '一次修改 = 1 条改前快照')
  const rev = changed.revisions[0]
  assert.equal(rev.prevTitle, '原标题', '改了什么：改前标题是一手对照')
  assert.equal(rev.mode, 'replace')
  assert.equal(typeof rev.at, 'string')
  assert.ok(!('prevBody' in rev), '不透出改前正文（体积取舍，见 RevisionBrief 头注）')

  assert.equal(value.results.find((row) => row.id === untouched.id).revisions, undefined, '无记录不写键')

  const text = recall.output.render({}, value).map((part) => part.text).join(NL)
  assert.ok(text.includes('⟲修订1次'), '有记录 ⇒ 印条数与最近一次')
  assert.ok(text.includes('标题曾为「原标题」'), '标题变了就说变了')
  // 判据修订（本段自我纠正）：无记录时**不印空壳标记**——A3（尸体样本：加字段不得改变无该字段
  // 条目的整行形状）与 A119b（未设维度不得带任何标记）是尸体样本换来的硬判据。
  // 「缺 ⟲」是单义的（投影层总在算，不存在「没算」这一态）⇒ 缺省不需要说话；
  // 需要一次性说明的是**双义**状态（角色维度未启用），那是 readableByFooter 的职责。
  const untouchedLine = text.split(NL).filter((line) => line.startsWith('- [')).find((line) => line.split('→ 关联')[0].includes(`id=${untouched.id})`))
  assert.equal(untouchedLine.includes('⟲'), false, '无修订记录的条目不得被套上任何修订标记')
  assert.equal(text.includes('⟲无修订记录'), false, '不得给每一行套「无记录」空壳')
})

// ---------- A163 写入 / 载入边界：revisions 必须活过 entrySchema ----------

test('A163 ★ entrySchema 声明了 revisions（同一个坑第十五次，只有线上实调抓得到）', () => {
  const entry = {
    id: 'e1', kind: 'fact', title: '标题', body: '正文', tags: [], scope: 's',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
    accessedAt: '2026-01-02T00:00:00.000Z', level: null, bucket: null, archived: false,
    revisions: [{ at: '2026-01-02T00:00:00.000Z', prevTitle: '旧标题', prevBody: '旧正文', mode: 'append', by: 'session-1' }],
  }
  // 反例先行：未声明的字段**确实**会被剥掉——这就是本判据要防的机制，不是假想
  assert.equal('notDeclared' in entrySchema.parse({ ...entry, notDeclared: 1 }), false, '未声明字段确实被剥')

  const parsed = entrySchema.parse(entry)
  assert.ok(Array.isArray(parsed.revisions), '载入边界不得剥掉 revisions（剥掉 = 重启后改前快照全部消失）')
  assert.equal(parsed.revisions.length, 1)
  assert.equal(parsed.revisions[0].prevTitle, '旧标题')
  assert.equal(parsed.revisions[0].prevBody, '旧正文', 'prevBody 是「能对照 / 能恢复」的全部价值，不裁')
  assert.equal(parsed.revisions[0].mode, 'append')
})

// ---------- A164–A166 修订原因（v0.53 · 方案 §9.4「含修订原因」） ----------

test('A164 update 的原因写进改前快照，并活过 entrySchema（载入边界）', async () => {
  const { store, byName } = setup(ROLE_CONFIG)
  const entry = await seed(store, { kind: 'knowledge', title: '旧标题' })
  await byName.get('update').execute({ id: entry.id, mode: 'append', text: '追加一行', reason: '补上遗漏的读数口径' }, MAIN_EXEC)

  const stored = store.get(WID, entry.id)
  assert.equal(stored.revisions.length, 1)
  assert.equal(stored.revisions[0].reason, '补上遗漏的读数口径', '原因写在这次改前快照上')

  // ⚠ 同一坑：v0.52 的 A163 证明 revisions 漏声明会被载入边界剥掉；原因字段同理
  const parsed = entrySchema.parse(stored)
  assert.equal(parsed.revisions[0].reason, '补上遗漏的读数口径', '载入边界不得剥掉 reason')
})

test('A165 渲染：有原因印「因为「…」」，没原因不印（挑着打）', async () => {
  const { store, byName } = setup(ROLE_CONFIG)
  const withReason = await seed(store, { kind: 'knowledge', title: '带原因' })
  const withoutReason = await seed(store, { kind: 'knowledge', title: '不带原因' })
  await byName.get('update').execute({ id: withReason.id, mode: 'append', text: 'x', reason: '主人纠正了口径' }, MAIN_EXEC)
  await byName.get('update').execute({ id: withoutReason.id, mode: 'append', text: 'y' }, MAIN_EXEC)

  const recall = byName.get('recall')
  const text = recall.output.render({}, await recall.execute({}, MAIN_EXEC)).map((p) => p.text).join(NL)
  const lines = text.split(NL).filter((line) => line.startsWith('- ['))
  // ⚠ 第三次同形：相关链后缀 `→ 关联: XX(id=…)` 会把另一条也带进同一行，
  // 不切掉就只能命中先出现的那行。判据要落在**自己的段**上。
  const ownPart = (line) => line.split('→ 关联')[0]
  const withLine = lines.find((line) => ownPart(line).includes('带原因(id='))
  const withoutLine = lines.find((line) => ownPart(line).includes('不带原因(id='))
  assert.ok(withLine.includes('因为「主人纠正了口径」'), '有原因必须印出来')
  assert.equal(withoutLine.includes('因为'), false, '没原因留空——缺省 = 不知道，不是「无理由」')
  assert.ok(withoutLine.includes('⟲修订1次'), '修订本身仍要印（与原因无关）')
})

test('A166 原因的两条边界：省略不写键 · 超 200 字在写入侧裁掉', async () => {
  const { store, byName } = setup(ROLE_CONFIG)
  const a = await seed(store, { kind: 'knowledge', title: '省略原因' })
  const b = await seed(store, { kind: 'knowledge', title: '超长原因' })
  await byName.get('update').execute({ id: a.id, mode: 'append', text: 'p' }, MAIN_EXEC)
  await byName.get('update').execute({ id: a.id, mode: 'append', text: 'q', reason: '   ' }, MAIN_EXEC)
  const long = '很长的理由'.repeat(80)
  await byName.get('update').execute({ id: b.id, mode: 'append', text: 'r', reason: long }, MAIN_EXEC)

  for (const rev of store.get(WID, a.id).revisions) {
    assert.equal('reason' in rev, false, '省略与纯空白都不得写键（省略 = 不知道）')
  }
  const longRev = store.get(WID, b.id).revisions.at(-1)
  assert.equal(longRev.reason.length, 200, '写入侧唯一裁点：裁到 200 字')
})
