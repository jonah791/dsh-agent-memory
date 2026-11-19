/**
 * tools.ts 单测（IMPLEMENTATION.md §6 T5 验收）：
 * 六工具行为（mock MemoryStore 注入）+ schema 校验。
 * 运行：node --test tests/（Node ≥22.18 原生 TS 支持）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Entry, EntryKind } from '../lib/types.js'
import type { MemoryConfig } from '../lib/types.js'
import type { KvLike } from '../lib/store.js'
import { MemoryStore } from '../lib/store.js'
import { createMemoryTools } from '../lib/tools.js'

// ---------- 测试基建 ----------

/**
 * 从 README 的**对外契约表**解析工具名——判据的真源不再是手抄名单。
 *
 * 为什么改：这份名单在 2026-10-14 / 11-12 / 11-18 / 11-19 / 11-20 漂了五次，每次都是
 * 「新增工具时忘了同步」。手抄清单本身就是第二个真源，改一处漏一处；而 README 的工具有
 * 两个方向的互锁价值：实现多了一个没写进契约的工具会红（对外承诺不全），契约多写了一个
 * 不存在的工具也会红（承诺了做不到的事）。
 *
 * @returns 工具表内声明的工具名（表内顺序）
 * @throws 表头缺失或解析出 0 个名字时抛错——「解析不到」不等于「零工具」
 */
function readmeToolNames(): string[] {
  const text = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim() === '| 工具 | 用途 |')
  if (start < 0) throw new Error('README 缺工具表（表头应为 | 工具 | 用途 |）')
  const names: string[] = []
  for (let index = start + 2; index < lines.length; index += 1) {
    const match = /^\| `([a-z_]+)` \|/.exec(lines[index] ?? '')
    if (match === null) break
    names.push(match[1] as string)
  }
  if (names.length === 0) throw new Error('README 工具表解析出 0 个名字——表头或行格式变了')
  return names
}

/** 内存 kv mock（同官方 storage-domain 测试模式） */
class MemoryKv implements KvLike {
  private readonly map = new Map<string, Entry>()

  get(key: string): Entry | undefined {
    const value = this.map.get(key)
    return value === undefined ? undefined : { ...value }
  }

  async put(key: string, value: Entry): Promise<void> {
    this.map.set(key, { ...value })
  }

  async delete(key: string): Promise<boolean> {
    return this.map.delete(key)
  }

  entries(): IterableIterator<[string, Entry]> {
    return this.map.entries()
  }

  get size(): number {
    return this.map.size
  }
}

const CWD = 'C:\\Users\\Alice\\proj'
const WID = 'c:/Users/Alice/proj'

/** 默认测试配置（workspace 模式） */
const BASE_CONFIG: MemoryConfig = {
  scope: 'workspace',
  layers: ['fact', 'knowledge', 'episodic'],
  autoSink: true,
  timeline: { day: true, week: true, month: true, year: true, archive: 'keep' },
  weeklyTemplate: '',
  maxEntries: 2000,
}

/** 构造测试环境：mock kv + store + 六工具（注入固定配置加载器） */
function setup(config: MemoryConfig = BASE_CONFIG) {
  const kv = new MemoryKv()
  const store = new MemoryStore(kv)
  const tools = createMemoryTools({ store, loadConfig: async () => config })
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const exec = {
    agent: { session: { header: { cwd: CWD } } },
    signal: new AbortController().signal,
  } as unknown as ToolRunContext
  return { kv, store, tools, byName, exec }
}

/** 直接往 store 塞一条条目（绕过 remember，方便构造场景） */
async function seed(store: MemoryStore, scope: string, kind: EntryKind, title: string, tags: string[] = []) {
  return store.remember({ kind, title, body: `${title} 的正文内容`, tags, scope, level: null, bucket: null })
}

// ---------- 工具集合形状 ----------

test('工具齐备，名称与契约一致', () => {
  const { byName } = setup()
  // 2026-10-14 对齐（**预先存在的债**，非本轮引入——v0.15 只在既有工具上加参数、不改工具集合）：
  // v0.11 `memory_recompress` 与 v0.13 期 `memory_review_mark` 上线时，本断言未同步。
  // 2026-11-12：`memory_dispose`（v0.22 近重复欠账销账）同样漏补 —— 已一并补齐。
  // 2026-11-18：`memory_supersede`（v0.24.0 事实生命周期）同样漏补 —— 已补齐。
  // 2026-11-19：`memory_link` / `memory_unlink` / `memory_relations`（v0.28.0 类型化关系 · 方案 §4.4）—— 同一次提交内补上。
  // 2026-11-19：`memory_concept` / `memory_thesaurus`（v0.29.0 主题词表 · 方案 §4.2）—— 同上。
  // 2026-11-19：`memory_entity` / `memory_entities`（v0.30.0 实体权威档 · 方案 §4.3）—— 同上。
  // 2026-11-19：`memory_source` / `memory_sources`（v0.35.0 来源实体 · 方案 §5.2）—— 同上。
  // 2026-11-19：`memory_trail`（v0.37 操作者审计流 · 方案 §11.4）—— 同上，同一次提交内补上。
  // ⚠ 这行的用途是「工具集合被意外增删时变红」，但它每漏补一次就变成**恒红**，
  //   而恒红的断言不再是指标（读数纪律：两次读数是同一个坏值 ⇒ 先怀疑量法）。
  //   ⇒ 判据：新增工具时**同一次提交**里改这一行；`.ts` 套件不在 `npm test` 的绿线内，
  //   所以它冷了六周才被发现（v0.24.0 → 2026-11-18）。
  // 2026-11-19：`memory_catalog`（v0.40 编目工作面 · 方案 §7 第 07 步）—— 同上，同一次提交内补上。
  // 2026-11-19：`memory_map`（v0.45 知识地图 · 方案 §4.5）—— 同上，同一次提交内补上。
  // 2026-11-19：`memory_misuse`（v0.46 R7 严格上限 · 方案 §13.3）—— 同上。
  // ⚠ 2026-11-19（v0.51 补记）：`memory_consolidate`（v0.49）**漏在这里**，于是从 v0.49 起
  //   `.ts` 口径一直是 87 pass / 1 fail，而 v0.49 与 v0.50 两轮的报告写的是「88 pass」——
  //   **那个数字是抄的，不是跑出来的**。教训不是「记得同步」（这份手抄清单本身就是
  //   第二个真源，迟早再漂），而是：**跑测试要看 `pass + fail + skip` 三项，不看 pass 单项**——只看 pass 时，
  //   一个 fail 与一个新增测试在数字上可能互相抵消。
  // 2026-11-20（v0.56）：**这条预言又一次应验**（`memory_export` 上线时清单没跟上）。
  //   ⇒ 不再手抄：工具名从 README 的对外契约表解析，与工具面做**双向互锁**——
  //   README 多写一个不存在的工具会红，实现多加一个没写进契约的工具也会红，
  //   而「加工具」这件事从此只需要改一处（README）就必然带动这里。
  const declared = readmeToolNames()
  assert.deepEqual(
    [...byName.keys()].sort(),
    [...declared].sort(),
    '工具面必须与 README 对外契约逐名相等（本判据从契约派生，不再手抄清单）',
  )
  assert.ok(byName.get('remember')!.description.includes('不记录：临时状态'))
  assert.ok(byName.get('remember')!.description.includes('凭证'))
})

// ---------- memory_relate（联想导航） ----------

test('memory_relate：按 id 展开关联网络（共享标签邻居降序）', async () => {
  const { byName, store, exec } = setup()
  const target = await seed(store, WID, 'knowledge', '插件开发要点', ['dsh', 'plugin'])
  await seed(store, WID, 'knowledge', '插件安装', ['dsh'])
  await seed(store, WID, 'knowledge', '插件陷阱', ['dsh', 'plugin'])
  await seed(store, WID, 'knowledge', '完全无关', ['other'])

  const result = await byName.get('memory_relate')!.execute({ id: target.id }, exec)
  assert.equal(result.ok, true)
  assert.equal(result.target.id, target.id)
  // 共享标签邻居进链（2 个），无关不进
  assert.ok(result.related.length >= 2)
  assert.ok(!result.related.some((r: any) => r.title === '完全无关'))
  // 关联强度降序：插件陷阱（2 共享标签）> 插件安装（1 共享标签）
  const strengths = result.related.map((r: any) => r.strength)
  assert.ok(strengths.every((s: number, i: number) => i === 0 || s <= strengths[i - 1]))
  const traps = result.related.find((r: any) => r.title === '插件陷阱')
  assert.equal(traps.sharedTags, 2)
})

test('memory_relate：未找到 id → ok=false + error', async () => {
  const { byName, exec } = setup()
  const result = await byName.get('memory_relate')!.execute({ id: 'missing-id' }, exec)
  assert.equal(result.ok, false)
  assert.ok(result.error.includes('未找到'))
})

test('memory_relate：limit 截断关联条数', async () => {
  const { byName, store, exec } = setup()
  const target = await seed(store, WID, 'knowledge', '目标', ['dsh'])
  for (let i = 0; i < 5; i++) await seed(store, WID, 'knowledge', `关联${i}`, ['dsh'])
  const result = await byName.get('memory_relate')!.execute({ id: target.id, limit: 2 }, exec)
  assert.ok(result.related.length <= 2)
})

// ---------- remember ----------

test('remember：新建（created），写入当前 workspace，首行作标题', async () => {
  const { byName, store, exec } = setup()
  const result = await byName.get('remember')!.execute({ text: '主人喜欢喝绿茶\n冬天尤其如此', kind: 'fact' }, exec)
  assert.equal(result.action, 'created')
  const entries = store.list(WID)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].title, '主人喜欢喝绿茶')
  assert.equal(entries[0].kind, 'fact')
  assert.equal(entries[0].scope, WID)
})

test('remember：同 key 再写 → updated（L1 覆盖）', async () => {
  const { byName, exec } = setup()
  const first = await byName.get('remember')!.execute({ text: '默认语言：中文', key: 'lang', kind: 'fact' }, exec)
  const second = await byName.get('remember')!.execute({ text: '默认语言：中文（社区交流）', key: 'lang', kind: 'fact' }, exec)
  assert.equal(first.action, 'created')
  assert.equal(second.action, 'updated')
  assert.equal(second.id, first.id)
})

test('remember：同标题 knowledge → merged（标签并集）', async () => {
  const { byName, exec } = setup()
  const first = await byName.get('remember')!.execute({ text: 'DSH 一切皆插件', kind: 'knowledge', tags: ['dsh'] }, exec)
  const second = await byName.get('remember')!.execute({ text: 'DSH 一切皆插件', kind: 'knowledge', tags: ['架构'] }, exec)
  assert.equal(second.action, 'merged')
  assert.equal(second.id, first.id)
  const recall = await byName.get('recall')!.execute({ query: '插件', kind: ['knowledge'] }, exec)
  assert.equal(recall.total, 1)
  assert.deepEqual(recall.results[0].tags.sort(), ['dsh', '架构'])
})

test('remember：缺省 kind = knowledge', async () => {
  const { byName, store, exec } = setup()
  await byName.get('remember')!.execute({ text: '一条默认知识' }, exec)
  const entries = store.list(WID)
  assert.equal(entries[0].kind, 'knowledge')
})

test('remember：text 为空 → 报错', async () => {
  const { byName, exec } = setup()
  await assert.rejects(() => byName.get('remember')!.execute({ text: '   ' }, exec), /text 不能为空/)
})

test('remember：kind 未在 layers 启用 → 报错（fail loud）', async () => {
  const cfg = { ...BASE_CONFIG, layers: ['fact', 'knowledge'] as EntryKind[] }
  const { byName, exec } = setup(cfg)
  await assert.rejects(
    () => byName.get('remember')!.execute({ text: '一次情景', kind: 'episodic' }, exec),
    /未启用 episodic 层/,
  )
})

test('remember：max_entries 满且新建 → 报错；同 key 更新仍允许', async () => {
  const cfg = { ...BASE_CONFIG, maxEntries: 1 }
  const { byName, exec } = setup(cfg)
  await byName.get('remember')!.execute({ text: '占位条目', key: 'slot', kind: 'fact' }, exec)
  await assert.rejects(
    () => byName.get('remember')!.execute({ text: '新条目', kind: 'fact' }, exec),
    /已达 max_entries/,
  )
  const update = await byName.get('remember')!.execute({ text: '占位条目（更新）', key: 'slot', kind: 'fact' }, exec)
  assert.equal(update.action, 'updated')
})

test('remember：显式 scope=global → 写入全局库', async () => {
  const { byName, store, exec } = setup()
  const result = await byName.get('remember')!.execute({ text: '跨项目通用知识', kind: 'knowledge', scope: 'global' }, exec)
  assert.equal(result.action, 'created')
  assert.equal(store.list('global').length, 1)
  assert.equal(store.list(WID).length, 0)
})

// ---------- recall ----------

test('recall：合并 workspace + global（global 永远附加）', async () => {
  const { byName, store, exec } = setup()
  await seed(store, WID, 'fact', '项目 A 的部署路径')
  await seed(store, 'global', 'fact', '主人喜欢喝绿茶')
  const result = await byName.get('recall')!.execute({}, exec)
  assert.equal(result.total, 2)
  const scopes = result.results.map((item) => item.scope).sort()
  assert.deepEqual(scopes, ['global', WID].sort())
})

test('recall：scope=global 只查全局', async () => {
  const { byName, store, exec } = setup()
  await seed(store, WID, 'fact', '项目内条目')
  await seed(store, 'global', 'fact', '全局条目')
  const result = await byName.get('recall')!.execute({ scope: 'global' }, exec)
  assert.equal(result.total, 1)
  assert.equal(result.results[0].scope, 'global')
})

test('recall：关键词过滤 + 相关度排序（标签 > 标题 > 正文）', async () => {
  const { byName, store, exec } = setup()
  // 标题互不相同，避免 store 同标题合并影响本场景
  await store.remember({ kind: 'knowledge', title: '甲条目', body: '正文里提到关键词', tags: [], scope: WID, level: null, bucket: null })
  await store.remember({ kind: 'knowledge', title: '乙条目', body: '无关', tags: ['关键词'], scope: WID, level: null, bucket: null })
  await store.remember({ kind: 'knowledge', title: '关键词标题命中', body: '无关', tags: [], scope: WID, level: null, bucket: null })
  const result = await byName.get('recall')!.execute({ query: '关键词' }, exec)
  assert.equal(result.total, 3)
  assert.equal(result.results[0].title, '乙条目') // 标签命中（3分）最高
  assert.equal(result.results[1].title, '关键词标题命中') // 标题命中（2分）
  assert.equal(result.results[2].title, '甲条目') // 正文命中（1分）
})

test('recall：kind/tags/since/limit/includeArchive 过滤', async () => {
  const { byName, store, exec } = setup()
  await store.remember({ kind: 'episodic', title: '今天完成 T2', body: '…', tags: ['进展'], scope: WID, level: null, bucket: null })
  await store.remember({ kind: 'fact', title: 'T2 取证结论', body: '…', tags: ['取证'], scope: WID, level: null, bucket: null })
  const byKind = await byName.get('recall')!.execute({ kind: ['fact'] }, exec)
  assert.equal(byKind.total, 1)
  const byTags = await byName.get('recall')!.execute({ tags: ['进展'] }, exec)
  assert.equal(byTags.total, 1)
  const byLimit = await byName.get('recall')!.execute({ limit: 1 }, exec)
  assert.equal(byLimit.results.length, 1)
  // 归档条目不进活跃检索
  const all = await byName.get('recall')!.execute({}, exec)
  assert.equal(all.total, 2)
  const archived = store.list(WID).find((entry) => entry.title === '今天完成 T2')
  await store.forget(WID, archived!.id, { reason: '测试' })
  const active = await byName.get('recall')!.execute({}, exec)
  assert.equal(active.total, 1)
  const withArchive = await byName.get('recall')!.execute({ includeArchive: true }, exec)
  assert.equal(withArchive.total, 2)
})

// ---------- update / forget ----------

test('update：改正文（首行新标题）+ 替换 tags', async () => {
  const { byName, store, exec } = setup()
  const { id } = await seed(store, WID, 'fact', '旧标题')
  const result = await byName.get('update')!.execute({ id, text: '新标题\n新正文内容', tags: ['改过'] }, exec)
  assert.equal(result.id, id)
  const entry = store.get(WID, id)!
  assert.equal(entry.title, '新标题')
  assert.equal(entry.body, '新标题\n新正文内容') // 正文保留全文（含标题行），检索不丢内容
  assert.deepEqual(entry.tags, ['改过'])
})

test('update：只改 tags 不动正文', async () => {
  const { byName, store, exec } = setup()
  const { id } = await seed(store, WID, 'knowledge', '标题')
  await byName.get('update')!.execute({ id, tags: ['仅标签'] }, exec)
  const entry = store.get(WID, id)!
  assert.equal(entry.title, '标题')
  assert.deepEqual(entry.tags, ['仅标签'])
})

test('update：未知 id → 报错', async () => {
  const { byName, exec } = setup()
  await assert.rejects(() => byName.get('update')!.execute({ id: 'no-such-id' }, exec), /未找到 id/)
})

test('forget：归档条目并记录 reason，不再进活跃检索', async () => {
  const { byName, store, exec } = setup()
  const { id } = await seed(store, WID, 'fact', '要归档的条目')
  // 注意：必须显式传 reasonType——v0.21.0 起归档原因是**类型化**的（决定引用方怎么处置），
  // 缺省 `unspecified` = 未判断。旧断言读 `source.reason`（v0.21.0 前的落点）恒 undefined，
  // 而实现是对的 ⇒ 那条断言测的是**已废弃的字段**，红了两天不是 bug 是断言落后。
  const result = await byName.get('forget')!.execute({ id, reason: '过时了', reasonType: 'stale' }, exec)
  assert.equal(result.id, id)
  assert.equal(result.archived, true)
  const entry = store.get(WID, id)!
  assert.equal(entry.archived, true)
  assert.equal(entry.archivedReason, '过时了')
  assert.equal(entry.archivedReasonType, 'stale')
  // 回归面：`source` 仍答「从哪来」，不得再被归档原因污染
  assert.equal(entry.source?.reason, undefined)
  const recall = await byName.get('recall')!.execute({}, exec)
  assert.equal(recall.total, 0)
})

test('forget：未知 id → 报错', async () => {
  const { byName, exec } = setup()
  await assert.rejects(() => byName.get('forget')!.execute({ id: 'no-such-id' }, exec), /未找到 id/)
})

// ---------- memory_stats ----------

test('memory_stats：默认聚合 workspace + global', async () => {
  const { byName, store, exec } = setup()
  await seed(store, WID, 'fact', '项目条目')
  await seed(store, 'global', 'knowledge', '全局条目')
  const result = await byName.get('memory_stats')!.execute({}, exec)
  assert.equal(result.total, 2)
  assert.equal(result.byKind.fact, 1)
  assert.equal(result.byKind.knowledge, 1)
  assert.deepEqual(result.scopes.sort(), ['global', WID].sort())
})

test('memory_stats：显式 scope 只统计指定库', async () => {
  const { byName, store, exec } = setup()
  await seed(store, WID, 'fact', '项目条目')
  await seed(store, 'global', 'knowledge', '全局条目')
  const result = await byName.get('memory_stats')!.execute({ scope: 'global' }, exec)
  assert.equal(result.total, 1)
  assert.deepEqual(result.scopes, ['global'])
})

// ---------- memory_check ----------

test('memory_check：未接线时不冒充零欠账', async () => {
  const { byName, exec } = setup()
  const result = await byName.get('memory_check')!.execute({}, exec)
  // 本工具的**设计核心**就是这一条：「零欠账」有四种来路（未接线 / 读不到 / 侧车空 /
  // 有记录但全处置过），前两种是「不知道」。旧断言 `deepEqual(result, { suggestions: [] })`
  // 恰好把「不知道」的形状固化成「零欠账」——它红了两天是对的，红的是断言本身。
  assert.deepEqual(result.suggestions, [])
  assert.ok(
    typeof result.note === 'string' && result.note.includes('未接线'),
    `应显式标注「未接线」而不是给一个空数组了事，实际：${JSON.stringify(result)}`,
  )
})

// ---------- schema 校验 ----------

test('schema：remember 缺 text 被拒；kind 枚举外被拒', () => {
  const { byName } = setup()
  const remember = byName.get('remember')!
  assert.ok(validateJsonSchemaValue(remember.parameters as never, {}).length > 0)
  assert.ok(validateJsonSchemaValue(remember.parameters as never, { text: 42 }).length > 0)
  assert.ok(validateJsonSchemaValue(remember.parameters as never, { text: 'ok', kind: 'gossip' }).length > 0)
  assert.equal(validateJsonSchemaValue(remember.parameters as never, { text: 'ok', kind: 'fact' }).length, 0)
})

test('schema：recall 非法参数类型被拒', () => {
  const { byName } = setup()
  const recall = byName.get('recall')!
  assert.ok(validateJsonSchemaValue(recall.parameters as never, { limit: '20' }).length > 0)
  assert.ok(validateJsonSchemaValue(recall.parameters as never, { kind: ['gossip'] }).length > 0)
  assert.equal(validateJsonSchemaValue(recall.parameters as never, { limit: 5, kind: ['fact'] }).length, 0)
})

// ---------- 懒压缩钩子（T7 接线） ----------

test('懒压缩：recall 访问时调用 compress 钩子（带 agent），失败静默不阻塞', async () => {
  const calls: Array<{ scope: string; hasAgent: boolean }> = []
  const kv = new MemoryKv()
  const store = new MemoryStore(kv)
  const tools = createMemoryTools({
    store,
    loadConfig: async () => BASE_CONFIG,
    compress: async (scope, agent) => {
      calls.push({ scope, hasAgent: agent !== undefined })
      throw new Error('压缩失败（应被吞掉）')
    },
  })
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const exec = {
    agent: { session: { header: { cwd: CWD } } },
    signal: new AbortController().signal,
  } as unknown as ToolRunContext
  const result = await byName.get('recall')!.execute({ query: 'x' }, exec)
  assert.ok(Array.isArray(result.results))
  // workspace + global 两个作用域各触发一次，agent 透传
  assert.equal(calls.length, 2)
  assert.ok(calls.every((c) => c.hasAgent))
})

test('懒压缩：未配 compress 钩子时不触发', async () => {
  const { byName, exec } = setup()
  const result = await byName.get('recall')!.execute({ query: 'x' }, exec)
  assert.ok(Array.isArray(result.results))
})
