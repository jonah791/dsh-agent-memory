/**
 * 实体权威档单测（v0.30.0 · 方案 §4.3 规范控制）——entities.ts 纯函数/存储 + 工具层 + 反查端到端。
 * 运行：npm test（tsc 后 node --test "tests/*.test.mjs"，导入编译产物 lib/*.js）
 *
 * 覆盖：
 *   E1 建立与读取：id 形如 ENTITY-0001（同 scope 递增）；按规范名/别名都能解析；归一（空白/大小写）生效；
 *      写入边界 schema 真 parse 后字段不丢（第 15 次同形的坑）
 *   E2 撞名：两个同名不同实体**可以并存**（不许因同名就合并），但没写 disambiguation 整笔拒绝；
 *      给了之后 resolveName 返回两个候选且 ambiguous=true——**程序不替调用方挑**
 *   E3 输入 fail-loud：空规范名 / 空实体类型 / 内部重复称呼
 *   E4 合并：旧档称呼并入存续档；旧档置 merged 并指向存续档；旧写法归到存续档（旧档作 merged 命中留痕）；
 *      合并只留一层（目标本身已合并 ⇒ 拒绝）；不能自合并
 *   E5 合并/停用的写入边界：已合并档不可改、不可停用（要求操作存续档）；停用档不再算适用（deprecated 段可见）
 *   E6 引用完整性：relatedEntities 自引用 / 不存在 / 跨 scope / 指向已合并档 ⇒ 拒绝
 *   E7 topics：概念表未接线 ⇒ 拒绝（宁可不写）；概念不存在 / 跨 scope ⇒ 拒绝；详情把 topics 渲染成概念标题
 *   E8 工具端到端：memory_entity 建 → 改 → memory_entities 按称呼解析 + 按名称反查提到它的条目
 *   E9 未接线：deps.entities 缺失时两个工具**响亮报错**，memory_stats.entities.wired === false
 *   E10 统计：total / active / merged / deprecated / 带别名 / 有消歧说明
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore } from '../lib/store.js'
import { ConceptStore } from '../lib/thesaurus.js'
import { EntityStore, entityKey, normalizeEntityName } from '../lib/entities.js'
import { createMemoryTools } from '../lib/tools.js'
import { entitySchema } from '../lib/index.js'
import { workspaceIdOf } from '../lib/scope.js'

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
const CONFIG = { maxEntries: 500, layers: ['fact', 'knowledge', 'episodic', 'summary'] }

function setup(options = {}) {
  const store = new MemoryStore(new MemoryKv())
  const concepts = options.concepts === false ? undefined : new ConceptStore(new MemoryKv())
  const entities = options.entities === false ? undefined : new EntityStore(new MemoryKv())
  const tools = createMemoryTools({ store, relations: undefined, concepts, entities, loadConfig: () => CONFIG })
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const exec = { agent: { session: { id: 'session-ent', header: { cwd: CWD } } } }
  return { store, concepts, entities, byName, exec }
}

async function seedEntry(store, title, extra = {}) {
  return store.remember({
    kind: 'knowledge',
    title,
    body: `${title} 的正文`,
    tags: [],
    scope: WID,
    level: null,
    bucket: null,
    ...extra,
  })
}

// ---------- E1 建立与读取 ----------

test('E1 建立与读取：id 递增、按规范名/别名解析、归一生效、schema 真 parse 不丢字段', async () => {
  const { entities } = setup()
  const first = await entities.create({ scope: WID, canonicalName: '智能体记忆图书馆', entityType: '项目', aliases: ['AML', 'Agent Memory Library'], firstSeen: '2026-11-18 方案讨论' })
  const second = await entities.create({ scope: WID, canonicalName: '爱丽丝庄园', entityType: '机构' })
  assert.equal(first.id, 'ENTITY-0001', '首个实体 id 应为 ENTITY-0001（方案 §4.3 的示例形态）')
  assert.equal(second.id, 'ENTITY-0002', '同 scope 内 id 必须递增（否则人无法口头引用）')

  // schema 真 parse：未声明字段会被 storage-domain 在写入边界静默剥掉（第 15 次同形的坑）
  const parsed = entitySchema.parse(first)
  for (const field of ['canonicalName', 'entityType', 'aliases', 'firstSeen']) {
    assert.ok(field in parsed, `schema 丢失字段 ${field} ⇒ 存了等于没存`)
  }

  // 三种写法都能解析到同一个实体（这正是「今后任何写法都能认出它」的判据）
  for (const name of ['智能体记忆图书馆', 'AML', 'agent memory library']) {
    const resolution = entities.resolveName(WID, name)
    assert.equal(resolution.active.length, 1, `「${name}」应解析到唯一实体，实为 ${resolution.active.length}`)
    assert.equal(resolution.active[0].id, first.id)
    assert.equal(resolution.ambiguous, false)
  }
  // 归一：多余空白 + 大小写不同视为同一写法
  assert.equal(normalizeEntityName('  Agent   Memory  LIBRARY '), 'agent memory library')
  assert.equal(entities.resolveName(WID, '  Agent   Memory  LIBRARY ').active.length, 1)
})

// ---------- E2 撞名与消歧 ----------

// ---------- E1b 跨 scope 的 id 语义（2026-11-24 补 · lh-7f0e5032 复现）----------
//
// ⚠ 这条钉的不是「功能」，是**不变量**：id 跨 scope **全局唯一**，不是「每 scope 各自递增」
//（原 `nextId` 注释就是这么写的，实测与实现不符，已同步改注释）。
//
// 为什么必须钉住：工具层有多处按 id 解析而**不带 scope**（`entities.find(id)` 的唯一参数就是 id），
// 它们能无歧义工作**完全依赖**这个不变量。若有人照旧注释去「修」成每 scope 各自递增，
// 两个 scope 就会出现同一个 id，按 id 解析立刻退化成「碰运气命中哪个 scope」——
// 而此前的测试**一条都不会红**（E1 只用了单 scope）。
//
// 代价也如实钉住：新 scope 的第一个实体**不从 0001 起**（实测 B 的首个是 ENTITY-0002）。

test('E1b id 跨 scope 全局唯一：新 scope 首个实体接着全局水位（不是每 scope 各自递增）', async () => {
  const entities = new EntityStore(new MemoryKv())

  const a1 = await entities.create({ scope: 'scope-A', canonicalName: '甲', entityType: '项目' })
  assert.equal(a1.id, 'ENTITY-0001')

  // ★ 被钉住的读数：B 的首个实体是 0002、不是 0001
  const b1 = await entities.create({ scope: 'scope-B', canonicalName: '乙', entityType: '项目' })
  assert.equal(b1.id, 'ENTITY-0002', '全局唯一 ⇒ 新 scope 不从 0001 起；改成「每 scope 递增」会破坏按 id 解析')

  // 同 scope 内继续递增——这条两种实现都会过，是对照组（证明上一条不是「什么都拦」）
  const a2 = await entities.create({ scope: 'scope-A', canonicalName: '丙', entityType: '项目' })
  assert.equal(a2.id, 'ENTITY-0003')

  // ★ 真正要守的：不带 scope 的按 id 解析必须**唯一**命中它自己
  for (const created of [a1, b1, a2]) {
    const hit = entities.find(created.id)
    assert.equal(hit?.scope, created.scope, `find(${created.id}) 必须唯一命中它自己那个 scope`)
    assert.equal(hit?.canonicalName, created.canonicalName)
  }

  // 尸体样本：直接构造「跨 scope 重号」的世界，证明上面那些断言真有分辨力
  // （若 id 不全局唯一，find 只能返回先遍历到的那个 ⇒ 解析歧义）
  const kv = new MemoryKv()
  const dup = new EntityStore(kv)
  const x = await dup.create({ scope: 'scope-X', canonicalName: 'X', entityType: '项目' })
  await kv.put(entityKey('scope-Y', x.id), { ...x, scope: 'scope-Y', canonicalName: 'Y' })
  const sameId = dup.all().filter((e) => e.id === x.id)
  assert.equal(sameId.length, 2, '尸体样本：重号世界里同一个 id 对应两个实体')
  assert.equal(dup.find(x.id)?.scope, sameId[0].scope, '而 find 只能给出其中一个 ⇒ 这就是重号后的歧义')
})

test('E2 撞名：同名不同实体可并存，但没写 disambiguation 整笔拒绝；写了则两候选并存且 ambiguous', async () => {
  const { entities } = setup()
  await entities.create({ scope: WID, canonicalName: '张三', entityType: '人' })

  // 反例（尸体样本）：不写消歧说明就建同名实体 ⇒ 必须拒绝，且点名占用者
  await assert.rejects(
    () => entities.create({ scope: WID, canonicalName: '张三', entityType: '人' }),
    /称呼撞名[\s\S]*ENTITY-0001/,
    '同名新建未给 disambiguation 必须整笔拒绝并点名占用者',
  )
  // 别名撞名同样要拦（撞的是「这个名字被用了」，不是「规范名被用了」）
  await assert.rejects(
    () => entities.create({ scope: WID, canonicalName: '张三丰', entityType: '人', aliases: ['张三'] }),
    /称呼撞名/,
    '别名撞名必须同样拦下',
  )

  const second = await entities.create({ scope: WID, canonicalName: '张三', entityType: '人', disambiguation: '2026 年认识的画家' })
  const resolution = entities.resolveName(WID, '张三')
  assert.equal(resolution.active.length, 2, '同名不同实体必须都能解析出来（不许因同名就合并）')
  assert.equal(resolution.ambiguous, true, '多命中必须标 ambiguous —— 程序不替调用方挑')
  assert.ok(resolution.active.some((entity) => entity.id === second.id))
})

// ---------- E3 输入 fail-loud ----------

test('E3 输入 fail-loud：空规范名 / 空实体类型 / 内部重复称呼都拒绝', async () => {
  const { entities } = setup()
  await assert.rejects(() => entities.create({ scope: WID, canonicalName: '   ', entityType: '人' }), /canonicalName（规范名）不能为空/)
  await assert.rejects(() => entities.create({ scope: WID, canonicalName: '某项目', entityType: '  ' }), /entityType（实体类型）不能为空/)
  await assert.rejects(
    () => entities.create({ scope: WID, canonicalName: '某项目', entityType: '项目', aliases: ['某项目'] }),
    /重复写法/,
    '规范名与别名内部重复是笔误，不是信息',
  )
})

// ---------- E4 合并 ----------

test('E4 合并：称呼并入存续档、旧档置 merged 指向存续档、旧写法仍可解析、只留一层', async () => {
  const { entities } = setup()
  const survivor = await entities.create({ scope: WID, canonicalName: '智能体记忆图书馆', entityType: '项目', aliases: ['AML'] })
  const old = await entities.create({ scope: WID, canonicalName: 'Agent Memory Library', entityType: '项目', firstSeen: '2026-11-01 讨论' })
  const { survivor: merged, absorbed, changed } = await entities.mergeInto(old.id, survivor.id, '同一项目的英文名与中文名')
  assert.equal(changed, true)
  assert.equal(merged.canonicalName, '智能体记忆图书馆', '存续档的规范名不变（旧规范名降为别名）')
  assert.deepEqual(merged.aliases?.slice().sort(), ['AML', 'Agent Memory Library'].sort(), '旧档的全部称呼必须并入存续档')
  assert.equal(merged.firstSeen, '2026-11-01 讨论', '存续档为空时继承旧档的首次出现')
  assert.equal(absorbed.status, 'merged')
  assert.equal(absorbed.mergedInto, survivor.id)

  // 旧写法仍可解析——**归到存续档**（这正是合并的目的）；旧档的旧规范名同时作为 merged 命中出现（历史可解释）
  for (const name of ['Agent Memory Library', 'aml']) {
    const resolution = entities.resolveName(WID, name)
    assert.equal(resolution.active.length, 1, `「${name}」应解析到存续档`)
    assert.equal(resolution.active[0].id, survivor.id)
  }
  const oldName = entities.resolveName(WID, 'Agent Memory Library')
  assert.equal(oldName.merged.length, 1, '旧档的旧规范名还应命中那条已合并的旧档（历史留痕）')
  assert.equal(oldName.merged[0].survivorId, survivor.id)

  // 合并只留一层：把「已合并档」当目标 ⇒ 拒绝，并直接给最终存续档
  const third = await entities.create({ scope: WID, canonicalName: 'AML 方案', entityType: '项目' })
  await assert.rejects(
    () => entities.mergeInto(third.id, old.id),
    (error) => /合并只保留一层/.test(error.message) && /ENTITY-0001/.test(error.message),
    '合并目标不得是已合并体（报错必须点名最终存续档，否则调用方得再查一次）',
  )
  // 不能自合并
  await assert.rejects(() => entities.mergeInto(survivor.id, survivor.id), /不能把实体并入自己/)
})

// ---------- E5 合并 / 停用的写入边界 ----------

test('E5 已合并档不可改不可停用；停用档落入 deprecated 段且不再适用', async () => {
  const { entities } = setup()
  const survivor = await entities.create({ scope: WID, canonicalName: '智能体记忆图书馆', entityType: '项目' })
  const old = await entities.create({ scope: WID, canonicalName: 'AML', entityType: '项目' })
  await entities.mergeInto(old.id, survivor.id)

  await assert.rejects(() => entities.update(old.id, { entityType: '机构' }), /已合并到[\s\S]*只改存续档/)
  await assert.rejects(() => entities.deprecate(old.id, '说不清'), /已合并到[\s\S]*要停用请停用存续档/)

  // 停用存续档 ⇒ 不再适用，但记录仍在（停用不删除）
  await assert.rejects(() => entities.deprecate(survivor.id, '  '), /必须给 reason/)
  const { changed } = await entities.deprecate(survivor.id, '项目改名并入庄园体系')
  assert.equal(changed, true)
  const resolution = entities.resolveName(WID, '智能体记忆图书馆')
  assert.equal(resolution.active.length, 0)
  assert.equal(resolution.deprecated.length, 1)
  assert.equal(entities.find(survivor.id).deprecatedNote, '项目改名并入庄园体系', '停用理由必须留痕（否则未来的我无法复核）')
})

// ---------- E6 引用完整性 ----------

test('E6 relatedEntities 完整性：自引用 / 不存在 / 跨 scope / 指向已合并档都拒绝', async () => {
  const { entities } = setup()
  const a = await entities.create({ scope: WID, canonicalName: '爱丽丝', entityType: '人' })
  const b = await entities.create({ scope: WID, canonicalName: '智能体记忆图书馆', entityType: '项目' })
  const other = await entities.create({ scope: 'global', canonicalName: '全局实体', entityType: '概念' })

  await assert.rejects(() => entities.create({ scope: WID, canonicalName: '自环', entityType: '项目', relatedEntities: [a.id] }).then(async (created) => entities.update(created.id, { relatedEntities: [created.id] })), /不能指向自己/)
  await assert.rejects(() => entities.create({ scope: WID, canonicalName: '悬空', entityType: '项目', relatedEntities: ['ENTITY-9999'] }), /不存在/)
  await assert.rejects(() => entities.create({ scope: WID, canonicalName: '跨区', entityType: '项目', relatedEntities: [other.id] }), /不能跨 scope/)

  // 指向已合并档 ⇒ 拒绝并给存续档 id（一个事实一个归宿）
  const doomed = await entities.create({ scope: WID, canonicalName: 'AML 旧称', entityType: '项目' })
  await entities.mergeInto(doomed.id, b.id)
  await assert.rejects(
    () => entities.create({ scope: WID, canonicalName: '引用旧档', entityType: '项目', relatedEntities: [doomed.id] }),
    new RegExp(`已合并到 "${b.id}"`),
  )
  // 正常引用可建
  const ok = await entities.create({ scope: WID, canonicalName: 'AML 文档', entityType: '作品', relatedEntities: [b.id, a.id] })
  assert.deepEqual(ok.relatedEntities, [b.id, a.id])
})

// ---------- E7 topics 与概念表 ----------

test('E7 topics：概念表未接线 / 概念不存在 / 跨 scope 都拒绝；接线后详情渲染概念标题', async () => {
  // 未接线：宁可不写，也不写悬空引用
  const bare = setup({ concepts: false })
  await assert.rejects(
    () => bare.byName.get('memory_entity').execute({ canonicalName: '某项目', entityType: '项目', topics: ['whatever'] }, bare.exec),
    /概念表未接线/,
  )

  const { byName, exec, concepts, entities } = setup()
  const concept = await concepts.create({ scope: WID, prefLabel: '智能体记忆' })
  const created = await byName.get('memory_entity').execute(
    { canonicalName: '智能体记忆图书馆', entityType: '项目', topics: [concept.id] },
    exec,
  )
  assert.equal(created.action, 'created')

  await assert.rejects(
    () => byName.get('memory_entity').execute({ canonicalName: '悬空主题', entityType: '项目', topics: ['no-such-concept'] }, exec),
    /概念 id="no-such-concept" 不存在/,
  )
  const foreign = await concepts.create({ scope: 'global', prefLabel: '跨区概念' })
  await assert.rejects(
    () => byName.get('memory_entity').execute({ canonicalName: '跨区主题', entityType: '项目', topics: [foreign.id] }, exec),
    /引用不能跨 scope/,
  )

  const detail = await byName.get('memory_entities').execute({ id: created.id }, exec)
  assert.deepEqual(detail.entities[0].topics, ['智能体记忆'], '详情里的 topics 必须是概念标题（裸 uuid 读不懂）')
  assert.ok(entities.find(created.id) !== undefined)
})

// ---------- E8 工具端到端 ----------

test('E8 端到端：memory_entity 建/改 → memory_entities 按别名解析并反查提到它的条目', async () => {
  const { byName, exec, store } = setup()
  const entry = await seedEntry(store, '智能体记忆图书馆的实施方案（v1）')
  await seedEntry(store, '与实体无关的条目')

  const created = await byName.get('memory_entity').execute(
    { canonicalName: '智能体记忆图书馆', entityType: '项目', aliases: ['AML'], firstSeen: entry.id },
    exec,
  )
  assert.equal(created.action, 'created')
  assert.equal(created.id, 'ENTITY-0001')

  const updated = await byName.get('memory_entity').execute(
    { id: created.id, aliases: ['AML', 'Agent Memory Library'], disambiguation: '本仓的记忆库工程' },
    exec,
  )
  assert.equal(updated.action, 'updated')
  assert.deepEqual(updated.aliases, ['AML', 'Agent Memory Library'])

  // 按别名解析（大小写不敏感）：拿到实体 + 提到它的条目
  const looked = await byName.get('memory_entities').execute({ name: 'agent memory library' }, exec)
  assert.equal(looked.ok, true)
  assert.equal(looked.mode, 'lookup')
  assert.equal(looked.total, 1)
  assert.equal(looked.ambiguous, false)
  const hit = looked.entities[0]
  assert.equal(hit.id, created.id)
  assert.equal(hit.disambiguation, '本仓的记忆库工程')
  assert.equal(hit.mentions.length, 1, '只有标题里含「智能体记忆图书馆」的那条应被反查出来')
  assert.equal(hit.mentions[0].id, entry.id)

  // 渲染层必须给得出可执行信息（标题 + id）
  const text = byName.get('memory_entities').output.render({}, looked).map((block) => block.text).join('\n')
  assert.match(text, /实体档（lookup）：1 条/)
  assert.match(text, /ENTITY-0001/)
  assert.match(text, /提到它的条目 1 条/)

  // 列表模式
  const listed = await byName.get('memory_entities').execute({}, exec)
  assert.equal(listed.mode, 'list')
  assert.equal(listed.total, 1)
})

// ---------- E8b 名称匹配边界（线上验收抓到的缺陷） ----------

test('E8b 拉丁名按词边界匹配：别名 AML 不得命中 yaml / example（尸体样本）', async () => {
  const { byName, exec, store } = setup()
  const decoy = await seedEntry(store, 'yaml 配置要点：缩进与锚点')
  const decoy2 = await seedEntry(store, 'example.com 的 TLS 证书链')
  const real = await seedEntry(store, 'AML 方案 §4.3 实体权威档')

  await byName.get('memory_entity').execute({ canonicalName: '智能体记忆图书馆', entityType: '项目', aliases: ['AML'] }, exec)
  const looked = await byName.get('memory_entities').execute({ name: 'AML' }, exec)
  const mentions = looked.entities[0].mentions.map((mention) => mention.id)
  assert.ok(mentions.includes(real.id), '「AML 方案 …」必须被反查到')
  assert.ok(!mentions.includes(decoy.id), '「yaml …」不得命中 AML（首版纯子串 5/5 全是 yaml 假阳）')
  assert.ok(!mentions.includes(decoy2.id), '「example.com …」不得命中 AML')

  // 中文仍走子串（没有词边界可依）：中文名出现在词中间也应命中
  const cn = await seedEntry(store, '我在整理智能体记忆图书馆的差距表')
  const lookedCn = await byName.get('memory_entities').execute({ name: '智能体记忆图书馆' }, exec)
  assert.ok(
    lookedCn.entities[0].mentions.some((mention) => mention.id === cn.id),
    '中文名按子串匹配（无词边界），出现在句中也要命中',
  )
})

// ---------- E9 未接线 ----------

test('E9 未接线：两个实体工具响亮报错，memory_stats.entities.wired=false', async () => {
  const { byName, exec } = setup({ entities: false })
  await assert.rejects(
    () => byName.get('memory_entity').execute({ canonicalName: '某实体', entityType: '项目' }, exec),
    /实体权威档未接线/,
  )
  await assert.rejects(() => byName.get('memory_entities').execute({}, exec), /实体权威档未接线/)

  const stats = await byName.get('memory_stats').execute({ scope: WID }, exec)
  assert.equal(stats.entities.wired, false, '「没接线」与「没有实体」必须可区分')
  assert.equal(stats.entities.total, 0)
  const text = byName.get('memory_stats').output.render({}, stats).map((block) => block.text).join('\n')
  assert.match(text, /实体权威档：未接线/)
})

// ---------- E10 统计 ----------

test('E10 统计：total / active / merged / deprecated / 带别名 / 有消歧说明', async () => {
  const { entities, byName, exec } = setup()
  const survivor = await entities.create({ scope: WID, canonicalName: '智能体记忆图书馆', entityType: '项目', aliases: ['AML'], disambiguation: '' })
  const old = await entities.create({ scope: WID, canonicalName: 'Agent Memory Library', entityType: '项目' })
  await entities.mergeInto(old.id, survivor.id)
  const deprecated = await entities.create({ scope: WID, canonicalName: '旧项目', entityType: '项目' })
  await entities.deprecate(deprecated.id, '已废弃')

  const stats = entities.stats()
  assert.equal(stats.total, 3)
  assert.equal(stats.active, 1, '合并态与停用态都不算适用（合并态指向存续档）')
  assert.equal(stats.merged, 1)
  assert.equal(stats.deprecated, 1)
  assert.equal(stats.withAliases, 1, '只有存续档带别名（合并后旧档的称呼记在存续档上，不留在旧档）')
  assert.deepEqual(stats.byType, { 项目: 3 })

  // 与工具层读数对齐（同一把尺子：stats 的 total 必须等于列表全量）
  const listed = await byName.get('memory_entities').execute({ includeMerged: true, includeDeprecated: true }, exec)
  assert.equal(listed.total, stats.total)
  const viaStats = await byName.get('memory_stats').execute({ scope: WID }, exec)
  assert.equal(viaStats.entities.wired, true)
  assert.equal(viaStats.entities.total, stats.total)
})
