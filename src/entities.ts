/**
 * 实体权威档（v0.30.0 · 方案 §4.3）——规范控制：同一个现实对象的多种称呼收在一处。
 *
 * ## 它解决什么（与 `aliases` / `concepts` 的分工）
 *
 * 条目的 `aliases` 是**检索别名**（v0.5，供这一条记忆被别的词命中），它挂在条目上、
 * 不同条目各写各的；实体权威档是**档案**：一个人 / 一个项目 / 一个机构只有一个档，
 * 档上写着它的全部称呼。三者分工：
 * - `tags`：自由文本（逐字匹配，无序无层级）。
 * - `concepts`（§4.2 主题词表）：**主题**。一个词只指一个概念 ⇒ 唯一标签空间。
 * - `entities`（本模块）：**现实对象**（人 / 项目 / 机构 / 作品 / 地点）。
 *
 * ## 与词表的三处刻意差异（照抄词表的判据会错）
 *
 * 1. **别名多对一**：一个实体有多个称呼（`canonicalName` + `aliases`），这是词表也有的；
 *    但实体额外允许**一名称多实体**（两个不同的人恰好同名）。
 * 2. **名字可多指 ⇒ 不建唯一标签空间**：两个实体用同一称呼是**合法**的，代价是这个名字
 *    无法唯一解析。方案 §4.3 明确「两个同名人物不能仅因为名称相同就合并」——所以
 *    `resolveName` 返回**候选列表**，多命中就 `ambiguous: true`，**程序不猜**；
 *    新建/加别名撞上别人的称呼时**必须给 `disambiguation`**（写清凭什么区分），否则整笔拒绝。
 * 3. **合并是显式动作**：`mergeInto` 把旧档的全部称呼并入存续档，旧档标 `merged` 并指向
 *    存续档——**不删除、不自动合并**（自动合并就是拿名字相同当同一件事）。
 *
 * ## 与 SKOS 循例一致的两条
 *
 * - **停用不删除**：`status:'deprecated'` 只是「不再用」，旧记忆里提到的它仍要能解释。
 * - **合并只保留一层**：A 并入 B、B 再并入 C 会造出链，解析要跟随多跳、且中间态永远留坑
 *   ⇒ 合并目标不得是「已合并体」（拒绝并直接给最终体 id）。
 *
 * ## 已知边界
 *
 * - **不做词形还原 / 繁简转换 / 标点归一**：归一函数与词表**逐字同源**（`normalizeLabel`：
 *   去首尾空白 + 折叠连续空白 + 小写）。多走一步就是「猜」，猜错即把两个实体合成一个。
 * - **不参与检索排序**：本版只建档案与解析入口；「实体匹配进 recall 权重」是 §8.3，
 *   届时才动检索面（本期改检索面会污染存量排序的对照）。
 * - **不做同名自动消歧**：`resolveName` 只报「有歧义」，判断靠 `entityType` / `disambiguation` /
 *   上下文，由调用方做——判断型字段禁默认值。
 *
 * 纯函数 + 单表存储，不依赖 Cordis / fs（离线可测：tests/entities.test.mjs）。
 */

import type { Entity, EntityRevision } from './types.ts'
import { normalizeLabel } from './thesaurus.ts'

/** 每个实体保留的变更记录条数（全历史在提交里；存储只留最近几条解释「怎么变成现在这样」） */
export const MAX_ENTITY_REVISIONS = 5

/** 实体表 kv 最小接口（与 relations.ts::RelationKvLike / thesaurus.ts::ConceptKvLike 同形） */
export interface EntityKvLike {
  get(key: string): Entity | undefined
  put(key: string, value: Entity): Promise<void>
  delete(key: string): Promise<boolean>
  entries(): IterableIterator<[string, Entity]>
  readonly size: number
}

/** 新实体草稿 */
export interface EntityDraft {
  scope: string
  canonicalName: string
  entityType: string
  aliases?: string[]
  firstSeen?: string
  topics?: string[]
  relatedEntities?: string[]
  /** 消歧说明：与别的实体同名时凭什么区分（撞名时**必填**） */
  disambiguation?: string
}

/** 实体可变字段（update 用；只改给到的） */
export interface EntityPatch {
  canonicalName?: string
  entityType?: string
  aliases?: string[]
  firstSeen?: string
  topics?: string[]
  relatedEntities?: string[]
  disambiguation?: string
}

/** 实体档案统计（memory_stats 用） */
export interface EntityStats {
  total: number
  active: number
  merged: number
  deprecated: number
  withAliases: number
  withTopics: number
  withRelatedEntities: number
  withDisambiguation: number
  byType: Record<string, number>
  byScope: Record<string, number>
}

/** 一个名字的解析结果（★ 多命中不替调用方挑） */
export interface NameResolution {
  /** 适用中的命中（可能 >1：同名不同实体） */
  active: Entity[]
  /** 命中但已合并的（含存续档 id，供调用方改指） */
  merged: Array<{ entity: Entity; survivorId: string }>
  /** 命中但已停用的 */
  deprecated: Entity[]
  /** 有多个适用中的候选（消歧不可省） */
  ambiguous: boolean
}

/** 实体表 key：`<scope>:entity:<id>` */
export function entityKey(scope: string, id: string): string {
  return `${scope}:entity:${id}`
}

/**
 * 实体名的归一（与词表同一个函数，**不另写一份**）。
 * @param name - 原始称呼
 */
export function normalizeEntityName(name: string): string {
  return normalizeLabel(name)
}

/** 实体的全部称呼（含规范名；用于匹配） */
export function namesOf(entity: Pick<Entity, 'canonicalName' | 'aliases'>): string[] {
  return [entity.canonicalName, ...(entity.aliases ?? [])]
}

/**
 * 名称是否出现在一段文本里——**检索与反查共用的唯一口径**（别在两处各写一份）。
 *
 * - **CJK 名字走子串**：中文没有词边界可依。
 * - **含 ASCII 的名字走词边界**：纯子串会让 `AML` 命中 `yaml` / `example`——
 *   2026-11-19 线上实测反查 5 条**全是 yaml 噪声**（见 `docs/semantic.md §5.23`）。
 *
 * ⚠ 已知边界：词边界分不开**同形异义**（「损害 AML 体系」= 反洗钱），那需要语义，不在本层。
 * @param haystackLower - 已被调用方小写化的文本（含标题正文标签别名拼接）
 * @param normalizedKey - 已归一的名称（`normalizeEntityName` 的输出）
 */
export function matchesName(haystackLower: string, normalizedKey: string): boolean {
  if (normalizedKey.length === 0) return false
  if (/^[\x20-\x7e]+$/.test(normalizedKey)) {
    const escaped = normalizedKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(haystackLower)
  }
  return haystackLower.includes(normalizedKey)
}

/** 实体是否适用中（未合并、未停用）——**合并态不算「当前节点」**：它指向存续档 */
export function isEntityActive(entity: Pick<Entity, 'status'>): boolean {
  return entity.status === undefined
}

/** 实体是否仍在用（未停用；合并态也算「在用」，只是要用存续档的 id） */
export function isEntityUsable(entity: Pick<Entity, 'status'>): boolean {
  return entity.status !== 'deprecated'
}

/** 实体表的存储与查询（单表 CRUD + 撞名/引用/合并校验） */
export class EntityStore {
  /** 每 scope 的序号分配水位（进程内单调：并发创建不得发出同一个 id） */
  private readonly seq = new Map<string, number>()

  constructor(private readonly kv: EntityKvLike) {}

  /** 全量实体（快照拷贝） */
  all(): Entity[] {
    const out: Entity[] = []
    for (const [, entity] of this.kv.entries()) out.push({ ...entity })
    return out
  }

  /**
   * 某分区的实体。
   * @param scope - 存储分区
   */
  byScope(scope: string): Entity[] {
    return this.all().filter((entity) => entity.scope === scope)
  }

  /**
   * 按 id 跨 scope 查找。
   * @param id - 实体 id（`ENTITY-0001` 形态）
   */
  find(id: string): Entity | undefined {
    for (const [, entity] of this.kv.entries()) {
      if (entity.id === id) return { ...entity }
    }
    return undefined
  }

  /**
   * 按称呼解析（规范名或别名，归一后**精确**相等）。
   *
   * **多命中不挑**：同名的不同实体全部返回，`ambiguous` 由调用方处理。
   * @param scope - 存储分区
   * @param name - 任意写法
   */
  resolveName(scope: string, name: string): NameResolution {
    const target = normalizeEntityName(name)
    const active: Entity[] = []
    const merged: Array<{ entity: Entity; survivorId: string }> = []
    const deprecated: Entity[] = []
    for (const entity of this.byScope(scope)) {
      if (!namesOf(entity).some((candidate) => normalizeEntityName(candidate) === target)) continue
      if (entity.status === 'merged' && entity.mergedInto !== undefined) merged.push({ entity, survivorId: entity.mergedInto })
      else if (entity.status === 'deprecated') deprecated.push(entity)
      else active.push(entity)
    }
    return { active, merged, deprecated, ambiguous: active.length > 1 }
  }

  /**
   * 规范化到存续档（合并态跟随**一跳**；未合并且未停用则返回自身）。
   * @param id - 实体 id
   */
  survivorOf(id: string): Entity | undefined {
    const entity = this.find(id)
    if (entity === undefined) return undefined
    if (entity.status !== 'merged' || entity.mergedInto === undefined) return entity
    return this.find(entity.mergedInto)
  }

  /**
   * 引用了该实体的其他实体（`relatedEntities` 反查 + 合并入向）。
   * @param id - 实体 id
   */
  referrersOf(id: string): Entity[] {
    return this.all().filter((entity) => (entity.relatedEntities ?? []).includes(id) || entity.mergedInto === id)
  }

  /**
   * 引用该实体的主题（概念 id 反查 `topics`）。
   * @param conceptId - 概念 id
   */
  byTopic(conceptId: string): Entity[] {
    return this.all().filter((entity) => (entity.topics ?? []).includes(conceptId))
  }

  /**
   * 建立实体（fail-loud：空规范名 / 空类型 / 内部称呼重复 / 撞名未消歧 / 引用不存在）。
   * @param draft - 实体草稿
   */
  async create(draft: EntityDraft): Promise<Entity> {
    const canonicalName = draft.canonicalName.trim()
    if (canonicalName.length === 0) throw new Error('实体：canonicalName（规范名）不能为空')
    const entityType = draft.entityType.trim()
    if (entityType.length === 0) {
      throw new Error('实体：entityType（实体类型）不能为空——「人 / 项目 / 机构 / 作品 / 地点」这类信息是消歧的第一依据，不许缺省')
    }
    const candidate = { canonicalName, aliases: draft.aliases ?? [] }
    this.assertNoInternalDuplicates(candidate)
    this.assertCollisionsAllowDisambiguation(draft.scope, candidate, undefined, draft.disambiguation)
    this.assertReferences(draft.scope, draft.topics, draft.relatedEntities, undefined)
    const now = new Date().toISOString()
    const entity: Entity = {
      id: this.nextId(draft.scope),
      scope: draft.scope,
      canonicalName,
      entityType,
      createdAt: now,
      updatedAt: now,
      ...(draft.aliases !== undefined && draft.aliases.length > 0 ? { aliases: draft.aliases.map((alias) => alias.trim()).filter((alias) => alias !== '') } : {}),
      ...(draft.firstSeen !== undefined && draft.firstSeen.trim() !== '' ? { firstSeen: draft.firstSeen.trim() } : {}),
      ...(draft.topics !== undefined && draft.topics.length > 0 ? { topics: draft.topics } : {}),
      ...(draft.relatedEntities !== undefined && draft.relatedEntities.length > 0 ? { relatedEntities: draft.relatedEntities } : {}),
      ...(draft.disambiguation !== undefined && draft.disambiguation.trim() !== '' ? { disambiguation: draft.disambiguation.trim() } : {}),
      revisions: [{ at: now, action: 'create', detail: `canonicalName=${canonicalName}；entityType=${entityType}` }],
    }
    await this.kv.put(entityKey(entity.scope, entity.id), entity)
    return entity
  }

  /**
   * 修改实体（只改给到的字段；每次真变留一条变更记录）。
   * @param id - 实体 id
   * @param patch - 变更
   * @param reason - 为什么改（可选，但记下来才有价值）
   */
  async update(id: string, patch: EntityPatch, reason?: string): Promise<Entity> {
    const current = this.find(id)
    if (current === undefined) throw new Error(`实体：未找到 id="${id}"`)
    if (current.status === 'merged') {
      throw new Error(`实体："${id}" 已合并到 "${current.mergedInto}"——档案只改存续档，旧档留作历史（要改请改存续档）`)
    }
    const next: Entity = { ...current }
    const details: string[] = []
    if (patch.canonicalName !== undefined) {
      const name = patch.canonicalName.trim()
      if (name.length === 0) throw new Error('实体：canonicalName（规范名）不能为空')
      if (name !== current.canonicalName) {
        details.push(`canonicalName：${current.canonicalName} → ${name}`)
        next.canonicalName = name
      }
    }
    if (patch.entityType !== undefined) {
      const type = patch.entityType.trim()
      if (type.length === 0) throw new Error('实体：entityType（实体类型）不能为空')
      if (type !== current.entityType) {
        details.push(`entityType：${current.entityType} → ${type}`)
        next.entityType = type
      }
    }
    if (patch.aliases !== undefined) {
      const cleaned = patch.aliases.map((alias) => alias.trim()).filter((alias) => alias !== '')
      const before = (current.aliases ?? []).join(' / ')
      const after = cleaned.join(' / ')
      if (before !== after) {
        details.push(`aliases：${before === '' ? '（无）' : before} → ${after === '' ? '（无）' : after}`)
        if (cleaned.length > 0) next.aliases = cleaned
        else delete next.aliases
      }
    }
    for (const field of ['firstSeen', 'disambiguation'] as const) {
      const value = patch[field]
      if (value === undefined) continue
      const trimmed = value.trim()
      if ((current[field] ?? '') === trimmed) continue
      details.push(`${field}：${current[field] === undefined ? '（无）' : '（有）'} → ${trimmed === '' ? '（清空）' : '（更新）'}`)
      if (trimmed === '') delete next[field]
      else next[field] = trimmed
    }
    for (const field of ['topics', 'relatedEntities'] as const) {
      const value = patch[field]
      if (value === undefined) continue
      const before = (current[field] ?? []).join(',')
      const after = value.join(',')
      if (before === after) continue
      details.push(`${field}：${before === '' ? '（无）' : before} → ${after === '' ? '（无）' : after}`)
      if (value.length > 0) next[field] = value
      else delete next[field]
    }
    if (details.length === 0) return current
    this.assertNoInternalDuplicates({ canonicalName: next.canonicalName, aliases: next.aliases ?? [] })
    // 撞名放宽：档案上已经有 disambiguation 就算「说过凭什么区分」；本次显式给了新的就用新的
    this.assertCollisionsAllowDisambiguation(
      current.scope,
      { canonicalName: next.canonicalName, aliases: next.aliases ?? [] },
      id,
      patch.disambiguation ?? next.disambiguation,
    )
    this.assertReferences(current.scope, next.topics, next.relatedEntities, id)
    const at = new Date().toISOString()
    next.updatedAt = at
    next.revisions = pushRevision(current.revisions, {
      at,
      action: 'update',
      detail: details.join('；'),
      ...(reason !== undefined && reason.trim() !== '' ? { reason: reason.trim() } : {}),
    })
    await this.kv.put(entityKey(next.scope, next.id), next)
    return next
  }

  /**
   * 合并（旧档 → 存续档）：旧档的全部称呼并入存续档，旧档标 `merged` 并指向存续档。
   *
   * **不删除旧档**：历史记忆里提到的那个 id 仍要能解释成「它现在是 X」。
   * 合并目标的 `topics` / `relatedEntities` 取并集，`firstSeen` 与 `disambiguation`
   * 只在存续档为空时继承（有值的一方是更早的判断，不覆盖）。
   * @param fromId - 被并入的旧档
   * @param toId - 存续档
   * @param reason - 为什么判定它们是同一个（可选，但记下来才有复核价值）
   */
  async mergeInto(fromId: string, toId: string, reason?: string): Promise<{ survivor: Entity; absorbed: Entity; changed: boolean }> {
    if (fromId === toId) throw new Error('实体合并：不能把实体并入自己')
    const from = this.find(fromId)
    if (from === undefined) throw new Error(`实体合并：未找到旧档 id="${fromId}"`)
    const to = this.find(toId)
    if (to === undefined) throw new Error(`实体合并：未找到存续档 id="${toId}"`)
    if (to.status === 'merged') {
      throw new Error(`实体合并：存续档 "${toId}" 本身已合并到 "${to.mergedInto}"——合并只保留一层，请直接指向最终存续档`)
    }
    if (to.status === 'deprecated') throw new Error(`实体合并：存续档 "${toId}" 已停用——停用档不能再接收合并`)
    if (from.scope !== to.scope) throw new Error(`实体合并：不能跨 scope 合并（${from.scope} → ${to.scope}）`)
    if (from.status === 'merged') {
      if (from.mergedInto === toId) return { survivor: to, absorbed: from, changed: false }
      throw new Error(`实体合并："${fromId}" 已合并到 "${from.mergedInto}"——一个旧档只留一条合并出边（要改指向请先确认历史）`)
    }
    const now = new Date().toISOString()
    // 存续档：称呼并集（归一后去重），旧规范名成为它的别名——这是「今后任何写法都能认出同一个实体」的落点
    const mergedNames: string[] = [...namesOf(to)]
    const seen = new Set(mergedNames.map(normalizeEntityName))
    for (const name of namesOf(from)) {
      const key = normalizeEntityName(name)
      if (seen.has(key)) continue
      seen.add(key)
      mergedNames.push(name)
    }
    const survivor: Entity = {
      ...to,
      canonicalName: mergedNames[0]!,
      updatedAt: now,
      ...(mergedNames.length > 1 ? { aliases: mergedNames.slice(1) } : {}),
      ...(to.firstSeen === undefined && from.firstSeen !== undefined ? { firstSeen: from.firstSeen } : {}),
      ...(to.disambiguation === undefined && from.disambiguation !== undefined ? { disambiguation: from.disambiguation } : {}),
      ...unionField(to.topics, from.topics, 'topics'),
      ...unionField(to.relatedEntities, from.relatedEntities, 'relatedEntities'),
      revisions: pushRevision(to.revisions, {
        at: now,
        action: 'merge',
        detail: `并入 ${from.id}（${from.canonicalName}）；称呼 → ${mergedNames.join(' / ')}`,
        ...(reason !== undefined && reason.trim() !== '' ? { reason: reason.trim() } : {}),
      }),
    }
    // 旧档的自引用要清掉：它不再是「当前节点」，保留指向自己的边会造出两个真源
    const { relatedEntities: _dropped, ...rest } = from
    const absorbed: Entity = {
      ...rest,
      status: 'merged',
      mergedInto: toId,
      updatedAt: now,
      revisions: pushRevision(from.revisions, {
        at: now,
        action: 'merge',
        detail: `并入 ${toId}（${to.canonicalName}）`,
        ...(reason !== undefined && reason.trim() !== '' ? { reason: reason.trim() } : {}),
      }),
    }
    await this.kv.put(entityKey(survivor.scope, survivor.id), survivor)
    await this.kv.put(entityKey(absorbed.scope, absorbed.id), absorbed)
    return { survivor, absorbed, changed: true }
  }

  /**
   * 停用实体（**不删除**：旧记忆里提到的它还要能解释）。
   * @param id - 实体 id
   * @param reason - 停用理由（必填：为什么不再用）
   */
  async deprecate(id: string, reason: string): Promise<{ entity: Entity; changed: boolean }> {
    const current = this.find(id)
    if (current === undefined) throw new Error(`实体：未找到 id="${id}"`)
    const trimmed = reason.trim()
    if (trimmed.length === 0) throw new Error('实体停用：必须给 reason（为什么不再用）——没有理由的停用无法复核')
    if (current.status === 'merged') {
      throw new Error(`实体："${id}" 已合并到 "${current.mergedInto}"——要停用请停用存续档（停用一个旧档不会影响任何解析结果）`)
    }
    if (current.status === 'deprecated') return { entity: current, changed: false }
    const at = new Date().toISOString()
    const next: Entity = {
      ...current,
      status: 'deprecated',
      deprecatedNote: trimmed,
      updatedAt: at,
      revisions: pushRevision(current.revisions, { at, action: 'deprecate', detail: `停用：${trimmed}` }),
    }
    await this.kv.put(entityKey(next.scope, next.id), next)
    return { entity: next, changed: true }
  }

  /** 统计（memory_stats 用） */
  stats(): EntityStats {
    const all = this.all()
    const byType: Record<string, number> = {}
    const byScope: Record<string, number> = {}
    let active = 0
    let merged = 0
    let deprecated = 0
    let withAliases = 0
    let withTopics = 0
    let withRelatedEntities = 0
    let withDisambiguation = 0
    for (const entity of all) {
      byScope[entity.scope] = (byScope[entity.scope] ?? 0) + 1
      byType[entity.entityType] = (byType[entity.entityType] ?? 0) + 1
      if (entity.status === 'merged') merged += 1
      else if (entity.status === 'deprecated') deprecated += 1
      else active += 1
      if ((entity.aliases ?? []).length > 0) withAliases += 1
      if ((entity.topics ?? []).length > 0) withTopics += 1
      if ((entity.relatedEntities ?? []).length > 0) withRelatedEntities += 1
      if ((entity.disambiguation ?? '').length > 0) withDisambiguation += 1
    }
    return {
      total: all.length,
      active,
      merged,
      deprecated,
      withAliases,
      withTopics,
      withRelatedEntities,
      withDisambiguation,
      byType,
      byScope,
    }
  }

  /**
   * 分配下一个可读 id（`ENTITY-0001`，每 scope 各自递增）。
   *
   * 为什么不是 uuid：方案 §4.3 的示例就是 `ENTITY-0001`，人要能口头引用「改 ENTITY-0007 那条」。
   * 为什么安全：进程内水位单调（并发创建不会发出同一个号），且落盘前查重（水位与磁盘取大）。
   */
  private nextId(scope: string): string {
    let max = 0
    for (const entity of this.byScope(scope)) {
      const matched = /^ENTITY-(\d+)$/.exec(entity.id)
      if (matched !== null) max = Math.max(max, Number(matched[1]))
    }
    let next = Math.max(max, this.seq.get(scope) ?? 0) + 1
    this.seq.set(scope, next)
    while (this.find(`ENTITY-${String(next).padStart(4, '0')}`) !== undefined) {
      next += 1
      this.seq.set(scope, next)
    }
    return `ENTITY-${String(next).padStart(4, '0')}`
  }

  /** 同一实体内部的称呼不得重复（归一后）——把同一个词写两遍是笔误，不是信息 */
  private assertNoInternalDuplicates(candidate: Pick<Entity, 'canonicalName' | 'aliases'>): void {
    const names = namesOf(candidate)
    if (new Set(names.map(normalizeEntityName)).size !== names.length) {
      throw new Error(`实体：规范名与别名内部有重复写法（${names.join(' / ')}）——同一个实体不必把同一个词写两遍`)
    }
  }

  /**
   * 撞名判定：与另一个**适用中**实体共用称呼时，必须给 `disambiguation`。
   *
   * 为什么不是直接拒绝：现实中两个不同的人可以同名（方案 §4.3 明确不许因同名就合并）。
   * 为什么不是直接放行：放行等于把消歧责任推给未来的自己——那时只剩「两个都命中」这一条线索。
   * ⇒ 允许同名，但要求**当时**写下凭什么区分。
   */
  private assertCollisionsAllowDisambiguation(
    scope: string,
    candidate: Pick<Entity, 'canonicalName' | 'aliases'>,
    selfId: string | undefined,
    disambiguation: string | undefined,
  ): void {
    const normalized = new Set(namesOf(candidate).map(normalizeEntityName))
    const collisions: Array<{ name: string; other: Entity }> = []
    for (const other of this.byScope(scope)) {
      if (other.id === selfId) continue
      // 只与「适用中」的实体判撞名：已合并 / 已停用的档不会参与解析，撞上它们不需要消歧
      if (!isEntityActive(other)) continue
      for (const name of namesOf(other)) {
        if (normalized.has(normalizeEntityName(name))) collisions.push({ name, other })
      }
    }
    if (collisions.length === 0) return
    if (disambiguation !== undefined && disambiguation.trim() !== '') return
    const names = [...new Set(collisions.map((hit) => `"${hit.name}"`))].join(' / ')
    const owners = [...new Set(collisions.map((hit) => `${hit.other.id}（${hit.other.canonicalName}·${hit.other.entityType}）`))].join(' / ')
    throw new Error(
      `实体：称呼撞名——${names} 已被 ${owners} 使用。两个同名实体**可以并存**（不许因同名就合并），`
      + '但必须给 `disambiguation` 写清凭什么区分（如「2026 年项目 / 2025 年同名旧项目」「人物 A 的私人账号」）。'
      + '补上 disambiguation 再建；若其实是同一个对象，请用 memory_entity({mergeInto}) 显式合并。',
    )
  }

  /** 引用完整性：topics 指向同 scope 概念，relatedEntities 指向同 scope 的**可用**实体，均不得自引用 */
  private assertReferences(
    scope: string,
    topics: string[] | undefined,
    relatedEntities: string[] | undefined,
    selfId: string | undefined,
  ): void {
    if (topics !== undefined && topics.length > 0) {
      // 概念表不在本模块手里：存在性由调用方（工具层持有 ConceptStore）校验——
      // 这里只挡它自己的硬错（重复 / 空串），避免让实体档依赖词表模块的存储。
      if (new Set(topics).size !== topics.length) throw new Error(`实体：topics 有重复项（${topics.join(',')}）`)
      for (const id of topics) {
        if (id.trim() === '') throw new Error('实体：topics 不能含空 id')
      }
    }
    for (const id of relatedEntities ?? []) {
      if (selfId !== undefined && id === selfId) {
        throw new Error(`实体：relatedEntities 不能指向自己（${id}）——自环让关联查询永远停不下来`)
      }
      const target = this.find(id)
      if (target === undefined) throw new Error(`实体：relatedEntities 指向的实体 id="${id}" 不存在`)
      if (target.scope !== scope) {
        throw new Error(`实体：relatedEntities 不能跨 scope 引用（实体 "${id}" 在 ${target.scope}，当前 ${scope}）`)
      }
      if (target.status === 'merged') {
        throw new Error(`实体：relatedEntities 指向的 "${id}" 已合并到 "${target.mergedInto}"——请直接指向存续档（一个事实一个归宿）`)
      }
      if (target.status === 'deprecated') {
        throw new Error(`实体：relatedEntities 指向的 "${id}" 已停用——停用档不再接收新关联`)
      }
    }
    if (relatedEntities !== undefined && new Set(relatedEntities).size !== relatedEntities.length) {
      throw new Error(`实体：relatedEntities 有重复项（${relatedEntities.join(',')}）`)
    }
  }
}

/** 数组字段并集：任一侧有值就写入（两侧都空则不写字段——无默认值） */
function unionField(
  mine: string[] | undefined,
  theirs: string[] | undefined,
  field: 'topics' | 'relatedEntities',
): Partial<Pick<Entity, typeof field>> {
  const merged = [...new Set([...(mine ?? []), ...(theirs ?? [])])]
  return merged.length > 0 ? { [field]: merged } as Partial<Pick<Entity, typeof field>> : {}
}

/** 追加一条变更记录并裁到上限（保留最近 MAX_ENTITY_REVISIONS 条） */
function pushRevision(history: EntityRevision[] | undefined, entry: EntityRevision): EntityRevision[] {
  const next = [...(history ?? []), entry]
  return next.length > MAX_ENTITY_REVISIONS ? next.slice(next.length - MAX_ENTITY_REVISIONS) : next
}
