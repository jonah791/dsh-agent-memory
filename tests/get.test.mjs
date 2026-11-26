/**
 * `memory_get`（v0.68）：按 id 读**单条记忆的完整正文**
 *
 * 它存在的唯一理由是**别的读工具都不给全文**：`recall` / `memory_browse` 给 `snippet`
 * （为了一次列几十条），`memory_relate` 只给标题，`memory_export` 把全库写成文件。
 * G11 是这条理由的结构证据——`recall` 的 item schema 里没有 `body`。
 *
 * 覆盖（G 段编号，避开 A1xx 那个跨小节命名空间）：
 *   G1 全文不截断 · G2 精确 id · G3 唯一前缀 · G4 多义前缀不猜 · G5 短前缀拒
 *   G6 不存在 vs 无权看 · G7 归档缺省可读 · G8 显式排除归档要说真话
 *   G9 角色准入拒（且不泄漏正文）· G10 敏感分级 · G11 与 recall 的分工 · G12 截断自报
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore } from '../lib/store.js'
import { createMemoryTools } from '../lib/tools.js'
import { workspaceIdOf } from '../lib/scope.js'

// ---------- 测试基建（与 role.test.mjs 同一套夹具纪律） ----------

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

// ⚠ WID 必须由**被测的派生函数**算出（硬编码在 POSIX 下不成立 ⇒ 整组静默 0 命中）
const CWD = 'C:\\Users\\Alice\\proj'
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

/** 角色维度启用的配置：main 看全部；worker 只看自己 + 共享 */
const ROLE_CONFIG = {
  ...BASE_CONFIG,
  roles: {
    enabled: true,
    default: 'main',
    derived: 'worker',
    byPreset: {},
    policyDefault: { read: ['*'], includeShared: true, includeGlobal: true },
    policies: {
      worker: { read: [], includeShared: true, includeGlobal: true },
    },
  },
}

function setup(config = BASE_CONFIG) {
  const kv = new MemoryKv()
  const store = new MemoryStore(kv)
  const tools = createMemoryTools({ store, loadConfig: async () => config })
  return { kv, store, byName: new Map(tools.map((tool) => [tool.name, tool])) }
}

function execOf({ sessionId, depth, preset, cwd = CWD } = {}) {
  const header = { cwd }
  if (sessionId !== undefined) header.id = sessionId
  if (depth !== undefined) header.delegationDepth = depth
  if (preset !== undefined) header.agentPreset = preset
  return {
    agent: { session: { id: sessionId, header } },
    signal: new AbortController().signal,
  }
}

const MAIN_EXEC = execOf({ sessionId: 'session-11111111-2222-3333-4444-555555555555' })
const WORKER_EXEC = execOf({ sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', depth: 1 })

async function seed(store, { title, body, role, archived = false, sensitivity }) {
  const entry = await store.remember({
    kind: 'knowledge',
    title,
    body: body !== undefined ? body : `${title} 的正文`,
    tags: [],
    scope: WID,
    level: null,
    bucket: null,
    ...(role !== undefined ? { role } : {}),
    ...(sensitivity !== undefined ? { sensitivity } : {}),
  })
  if (archived) await store.forget(WID, entry.id, { reason: '测试归档' })
  return entry
}

/** 把一批条目的 id 改写成**共享前缀**（真实 uuid 前缀碰撞不可控，只能显式造） */
function forceIds(kv, mapping) {
  for (const [key, value] of kv.map) {
    const next = mapping.get(value.id)
    if (next !== undefined) kv.map.set(key, { ...value, id: next })
  }
}

// ---------- G1 全文不截断（这是工具的立身之本） ----------

test('G1 正文原样返回，一字不少（4000 字符正文）', async () => {
  const { store, byName } = setup()
  // 造一段含明显首尾标记的长正文：截断会立刻被「尾部标记是否存在」抓住
  const filler = '中'.repeat(3980)
  const body = `开头标记\n${filler}\n结尾标记XYZ`
  const entry = await seed(store, { title: '长正文条目', body })

  const result = await byName.get('memory_get').execute({ id: entry.id }, MAIN_EXEC)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.entry.body.length, body.length)
  assert.equal(result.entry.body, body, '必须与写入时逐字相同')
  assert.ok(result.entry.body.endsWith('结尾标记XYZ'), '尾部标记必须在——被截断就会丢')
  assert.equal(result.truncated, undefined, '不出现 = 全文（不是「不知道有没有截断」）')
})

// ---------- G2 / G3 精确定位 ----------

test('G2 完整 id → matchedBy=exact', async () => {
  const { store, byName } = setup()
  const entry = await seed(store, { title: '精确定位条目' })
  const result = await byName.get('memory_get').execute({ id: entry.id }, MAIN_EXEC)
  assert.equal(result.ok, true)
  assert.equal(result.matchedBy, 'exact')
  assert.equal(result.entry.id, entry.id)
})

test('G3 唯一前缀 → matchedBy=prefix', async () => {
  const { store, byName } = setup()
  const entry = await seed(store, { title: '前缀条目' })
  const prefix = entry.id.slice(0, 8)
  const result = await byName.get('memory_get').execute({ id: prefix }, MAIN_EXEC)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.matchedBy, 'prefix')
  assert.equal(result.entry.id, entry.id)
})

// ---------- G4 / G5 多义与过短：宁报错不猜 ----------

test('G4 前缀命中多条 → ambiguous + 候选，且不返回任何正文', async () => {
  const { kv, store, byName } = setup()
  const first = await seed(store, { title: '冲突甲', body: '甲的正文AAAA' })
  const second = await seed(store, { title: '冲突乙', body: '乙的正文BBBB' })
  forceIds(kv, new Map([
    [first.id, 'abcd1111-0000-4000-8000-000000000001'],
    [second.id, 'abcd2222-0000-4000-8000-000000000002'],
  ]))

  const result = await byName.get('memory_get').execute({ id: 'abcd' }, MAIN_EXEC)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'ambiguous')
  assert.equal(result.entry, undefined, '不能猜一个返回——猜错比报错贵')
  assert.equal(result.candidates.length, 2)
  assert.deepEqual(result.candidates.map((c) => c.id).sort(), [
    'abcd1111-0000-4000-8000-000000000001',
    'abcd2222-0000-4000-8000-000000000002',
  ])
  // 候选只给 id 与标题，**不得夹带正文**（否则等于绕过了「不猜」）
  for (const candidate of result.candidates) {
    assert.deepEqual(Object.keys(candidate).sort(), ['id', 'title'])
  }
})

test('G5 前缀短于 4 位 → bad-id（枚举候选不是帮助）', async () => {
  const { store, byName } = setup()
  await seed(store, { title: '短前缀条目' })
  const result = await byName.get('memory_get').execute({ id: 'ab' }, MAIN_EXEC)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'bad-id')
  assert.match(result.hint, /至少 4 位/)
})

// ---------- G6 不存在 vs 无权看（四种否的核心区分） ----------

test('G6 库里没有 → not-found，且明确「这不是权限问题」', async () => {
  const { store, byName } = setup()
  await seed(store, { title: '无关条目' })
  const result = await byName.get('memory_get').execute({ id: 'ffffffff-0000-4000-8000-000000000000' }, MAIN_EXEC)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'not-found')
  assert.match(result.hint, /不是权限问题/)
  // ⚠ recall 打印的 ⚓xxxx@N 是证据坐标，不是条目 id——hint 必须提醒
  assert.match(result.hint, /证据坐标/)
})

// ---------- G7 / G8 归档：缺省可读，显式排除时要说真话 ----------

test('G7 归档条目缺省就能读（与 recall 相反的缺省，是刻意的）', async () => {
  const { store, byName } = setup()
  const entry = await seed(store, { title: '已归档条目', body: '归档正文Q', archived: true })
  const result = await byName.get('memory_get').execute({ id: entry.id }, MAIN_EXEC)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.entry.archived, true)
  assert.equal(result.entry.body, '归档正文Q')
})

test('G8 显式 includeArchive:false 且该条已归档 → 说「已归档」，不谎报不存在', async () => {
  const { store, byName } = setup()
  const entry = await seed(store, { title: '已归档条目二', archived: true })
  const result = await byName.get('memory_get').execute({ id: entry.id, includeArchive: false }, MAIN_EXEC)
  assert.equal(result.ok, false)
  assert.match(result.hint, /已归档/, '必须点明真实原因——这才是「不知道」与「不存在」的分界')
  assert.match(result.hint, /includeArchive/)
})

// ---------- G9 角色准入：拒绝要带判据码，且不泄漏正文 ----------

test('G9 角色准入拒 → permission-denied（带 R4-read）且不回正文', async () => {
  const { store, byName } = setup(ROLE_CONFIG)
  const entry = await seed(store, { title: 'main 隔间条目', body: '机密正文S', role: 'main' })

  const result = await byName.get('memory_get').execute({ id: entry.id }, WORKER_EXEC)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'permission-denied')
  assert.match(result.hint, /R4-read/)
  assert.equal(result.entry, undefined)
  // 关键：连正文的一个片段都不许出现在回执里
  assert.ok(!JSON.stringify(result).includes('机密正文S'))
  // 但必须让调用方知道「它存在」——否则又会退化成「不存在」
  assert.match(result.hint, /存在/)
})

test('G9b 同一视野下共享条目照常可读（准入不是一律封）', async () => {
  const { store, byName } = setup(ROLE_CONFIG)
  const entry = await seed(store, { title: '共享条目', body: '共享正文T' })
  const result = await byName.get('memory_get').execute({ id: entry.id }, WORKER_EXEC)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.entry.body, '共享正文T')
})

// ---------- G10 敏感分级：与 recall / memory_browse 同一口径 ----------

test('G10 L2 缺省拒、includeSensitive 才放行', async () => {
  const { store, byName } = setup()
  const entry = await seed(store, { title: '私密条目', body: '私密正文U', sensitivity: 'L2' })

  const blocked = await byName.get('memory_get').execute({ id: entry.id }, MAIN_EXEC)
  assert.equal(blocked.ok, false)
  assert.equal(blocked.reason, 'sensitive-blocked')
  assert.ok(!JSON.stringify(blocked).includes('私密正文U'))

  const allowed = await byName.get('memory_get').execute({ id: entry.id, includeSensitive: true }, MAIN_EXEC)
  assert.equal(allowed.ok, true)
  assert.equal(allowed.entry.body, '私密正文U')
})

// ---------- G11 与 recall 的结构分工（工具存在的理由） ----------

test('G11 recall 的 item 没有 body，memory_get 有——这就是它存在的理由', () => {
  const { byName } = setup()
  const recallItem = byName.get('recall').output.schema.properties.results.items.properties
  assert.equal(recallItem.body, undefined, 'recall 若开始给全文，本工具就该退役（判据见下）')
  assert.ok(recallItem.snippet !== undefined)

  const browseItem = byName.get('memory_browse').output.schema.properties.groups.items.properties.items.items.properties
  assert.equal(browseItem.body, undefined)
  assert.ok(browseItem.snippet !== undefined)

  const getEntry = byName.get('memory_get').output.schema.properties.entry.properties
  assert.ok(getEntry.body !== undefined, 'memory_get 必须给 body')
  assert.ok(getEntry.facts !== undefined)
  // 正文不设长度裁点字段：截断只能是调用方显式要的（maxChars）
  assert.equal(getEntry.body.maxLength, undefined)
})

// ---------- G12 截断自报 ----------

test('G12 maxChars 截断时必须自报原长与省略量（不静默）', async () => {
  const { store, byName } = setup()
  const body = 'X'.repeat(1000)
  const entry = await seed(store, { title: '可截断条目', body })

  const cut = await byName.get('memory_get').execute({ id: entry.id, maxChars: 100 }, MAIN_EXEC)
  assert.equal(cut.ok, true)
  assert.equal(cut.entry.body.length, 100)
  assert.deepEqual(cut.truncated, { maxChars: 100, totalChars: 1000, omittedChars: 900 })

  // 0（缺省语义）= 全文，不是「截 0 个字」
  const full = await byName.get('memory_get').execute({ id: entry.id, maxChars: 0 }, MAIN_EXEC)
  assert.equal(full.entry.body.length, 1000)
  assert.equal(full.truncated, undefined)
})

test('G13 render 打出全文与元数据（渲染层是唯一到人眼前的通道）', async () => {
  const { store, byName } = setup()
  const entry = await seed(store, { title: '渲染条目', body: '渲染正文V', archived: true })
  const tool = byName.get('memory_get')
  const output = await tool.execute({ id: entry.id }, MAIN_EXEC)
  const text = tool.output.render({ id: entry.id }, output).map((part) => part.text).join('\n')
  assert.match(text, /记忆全文：渲染条目/)
  assert.match(text, /渲染正文V/, '正文必须出现在渲染里，而不只是结构化返回')
  assert.match(text, new RegExp(entry.id))
  assert.match(text, /已归档/)
})
