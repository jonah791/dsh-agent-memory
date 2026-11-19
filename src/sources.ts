/**
 * 来源实体存储（v0.35 · 方案 §5.2 · 契约 `docs/semantic.md` §5.28）。
 *
 * **为什么是独立表而不是条目上的一个字段**：来源要被多条记忆复用，且它自己有身份
 * （可口头引用的 id）与属性（类型 / 可靠度 / 权限）。塞进条目就变成每条记忆各记一份，
 * 同一来源的可靠度会被复制成 N 份互相矛盾的副本。
 *
 * ⚠ `SourceStore` **不提供条目反查**：引用方（`entry.sourceIds`）在条目表里，本 Store 只拿得到
 * 来源表。反查放在工具层（`index.ts`），那里同时持有 entries 与 sources——把两个表的 join
 * 塞进 Store 会让它依赖自己管不到的数据。
 */

import type { Source, SourceRevision } from './types.js'

/** 变更记录上限（与实体 / 概念 / 条目同口径） */
export const MAX_SOURCE_REVISIONS = 5

/**
 * 来源类型枚举——与条目 `provenance` **共用同一份取值**，不立第二套词表。
 * `provenance` 四值本来就是「来源的类型」维度；另立一套必然漂移。
 */
export const SOURCE_TYPES = ['master', 'web', 'self', 'measured'] as const

export type SourceType = (typeof SOURCE_TYPES)[number]

/** 存储抽象（与 `EntityKvLike` 同形，便于单测用内存 Map） */
export interface SourceKvLike {
  get(key: string): Source | undefined
  put(key: string, value: Source): Promise<void>
  delete(key: string): Promise<boolean>
  entries(): IterableIterator<[string, Source]>
}

/** 建来源的输入 */
export interface SourceDraft {
  scope: string
  type: SourceType
  location: string
  /** 采集时刻；不给 = 此刻（复用它时应显式给原时刻，不要让它变成「最后写入时间」） */
  collectedAt?: string
  owner?: string
  reliability?: string
  permissions?: string[]
  label?: string
}

/** 改来源的输入（只改给到的字段） */
export interface SourcePatch {
  type?: SourceType
  location?: string
  owner?: string
  reliability?: string
  permissions?: string[]
  label?: string
  retiredNote?: string
}

/** 过滤条件（各维 AND；省略 = 该维不过滤） */
export interface SourceFilter {
  scope?: string
  type?: SourceType
  owner?: string
  status?: 'active' | 'retired'
  /** `true` = 只列**未标注 `reliability`** 的——判断型字段的「不知道」要能单独看见 */
  unlabeledReliability?: boolean
}

/** 读数 */
export interface SourceStats {
  total: number
  /** `status` 未给或为 `active`（两者都算适用中） */
  active: number
  retired: number
  /** 未标注 `reliability` 的条数——**不能被并进任何默认档**（契约 S2） */
  unlabeledReliability: number
  withOwner: number
  withPermissions: number
  byType: Record<string, number>
  byScope: Record<string, number>
}

/** 存储键（与 `entityKey` 同形） */
export function sourceKey(scope: string, id: string): string {
  return `${scope}:source:${id}`
}

/** 可用 = 未停用。`retired` 不进候选，但按 id 直查仍能取回（契约 S6） */
export function isSourceUsable(source: Pick<Source, 'status'>): boolean {
  return source.status !== 'retired'
}

/** 把可选字符串字段归一：空白字符串视为「没给」（不是「给了一个空值」） */
function optionalText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

export class SourceStore {
  constructor(private readonly kv: SourceKvLike) {}

  all(): Source[] {
    const out: Source[] = []
    for (const [, source] of this.kv.entries()) out.push(source)
    return out
  }

  byScope(scope: string): Source[] {
    return this.all().filter((source) => source.scope === scope)
  }

  /**
   * 按 scope + id 直查（**不过滤状态**：停用的也能取回，这是 S6 的前提）。
   *
   * ⚠ 刻意**强制带 scope**（与 `EntityStore.find(id)` 的区别）：id 只在 scope 内唯一，
   * 跨 scope 可重号（见 S1b 单测）。不带 scope 的全表扫在两个 workspace 都有
   * `SOURCE-0001` 时返回哪个取决于遍历顺序——那是不可复现的结果，不该是 API 的默认行为。
   */
  find(scope: string, id: string): Source | undefined {
    return this.kv.get(sourceKey(scope, id))
  }

  /** 按条件列表（各维 AND） */
  list(filter: SourceFilter = {}): Source[] {
    return this.all().filter((source) => {
      if (filter.scope !== undefined && source.scope !== filter.scope) return false
      if (filter.type !== undefined && source.type !== filter.type) return false
      if (filter.owner !== undefined && source.owner !== filter.owner) return false
      if (filter.status === 'retired' && source.status !== 'retired') return false
      if (filter.status === 'active' && source.status === 'retired') return false
      if (filter.unlabeledReliability === true && optionalText(source.reliability) !== undefined) return false
      return true
    })
  }

  /**
   * 建立来源（fail-loud：类型不在枚举 / 位置为空）。
   *
   * `reliability` / `permissions` 刻意**不给默认值**——它们缺省就是「未标注」，
   * 与「中等可靠」「无限制」是两件事（契约 S2）。
   */
  async create(draft: SourceDraft): Promise<Source> {
    if (!SOURCE_TYPES.includes(draft.type)) {
      throw new Error(`来源：type 必须是 ${SOURCE_TYPES.join(' / ')} 之一，收到 "${String(draft.type)}"`)
    }
    const location = draft.location.trim()
    if (location.length === 0) {
      throw new Error('来源：location（位置）不能为空——来源必须有可回查的落点，否则它只是一句形容词')
    }
    const now = new Date().toISOString()
    const owner = optionalText(draft.owner)
    const reliability = optionalText(draft.reliability)
    const label = optionalText(draft.label)
    const source: Source = {
      id: this.nextId(draft.scope),
      scope: draft.scope,
      type: draft.type,
      location,
      collectedAt: draft.collectedAt === undefined ? now : draft.collectedAt.trim(),
      createdAt: now,
      updatedAt: now,
      ...(owner !== undefined ? { owner } : {}),
      ...(reliability !== undefined ? { reliability } : {}),
      ...(draft.permissions !== undefined && draft.permissions.length > 0 ? { permissions: [...draft.permissions] } : {}),
      ...(label !== undefined ? { label } : {}),
      revisions: [{ at: now, action: 'create', detail: `type=${draft.type}；location=${location}` }],
    }
    await this.kv.put(sourceKey(source.scope, source.id), source)
    return source
  }

  /**
   * 修改来源（只改给到的字段；**每次真变**才留一条记录）。
   *
   * 没有变化时返回原对象、不写盘——否则「每次调用都加一条 revision」会把
   * 真实变更记录挤出去（`revisions` 只留最近 MAX_SOURCE_REVISIONS 条）。
   */
  async update(scope: string, id: string, patch: SourcePatch, reason?: string): Promise<Source> {
    const current = this.find(scope, id)
    if (current === undefined) throw new Error(`来源：未找到 id="${id}"（scope=${scope}）`)
    const next: Source = { ...current }
    const details: string[] = []
    if (patch.type !== undefined) {
      if (!SOURCE_TYPES.includes(patch.type)) {
        throw new Error(`来源：type 必须是 ${SOURCE_TYPES.join(' / ')} 之一，收到 "${String(patch.type)}"`)
      }
      if (patch.type !== current.type) {
        details.push(`type：${current.type} → ${patch.type}`)
        next.type = patch.type
      }
    }
    if (patch.location !== undefined) {
      const location = patch.location.trim()
      if (location.length === 0) throw new Error('来源：location（位置）不能为空')
      if (location !== current.location) {
        details.push(`location：${current.location} → ${location}`)
        next.location = location
      }
    }
    if (patch.owner !== undefined) {
      const owner = optionalText(patch.owner)
      if (owner !== current.owner) {
        details.push(`owner：${current.owner ?? '（未标注）'} → ${owner ?? '（清除）'}`)
        if (owner === undefined) delete next.owner
        else next.owner = owner
      }
    }
    if (patch.reliability !== undefined) {
      const reliability = optionalText(patch.reliability)
      if (reliability !== current.reliability) {
        details.push(`reliability：${current.reliability ?? '（未标注）'} → ${reliability ?? '（清除）'}`)
        if (reliability === undefined) delete next.reliability
        else next.reliability = reliability
      }
    }
    if (patch.label !== undefined) {
      const label = optionalText(patch.label)
      if (label !== current.label) {
        details.push(`label：${current.label ?? '（无）'} → ${label ?? '（清除）'}`)
        if (label === undefined) delete next.label
        else next.label = label
      }
    }
    if (patch.permissions !== undefined) {
      const before = (current.permissions ?? []).join(',')
      const after = patch.permissions.join(',')
      if (before !== after) {
        details.push(`permissions：[${before}] → [${after}]`)
        if (patch.permissions.length === 0) delete next.permissions
        else next.permissions = [...patch.permissions]
      }
    }
    if (patch.retiredNote !== undefined) {
      const note = optionalText(patch.retiredNote)
      if (note !== current.retiredNote) {
        details.push(`retiredNote：${current.retiredNote ?? '（无）'} → ${note ?? '（清除）'}`)
        if (note === undefined) delete next.retiredNote
        else next.retiredNote = note
      }
    }
    if (details.length === 0) return current
    const now = new Date().toISOString()
    next.updatedAt = now
    next.revisions = pushRevision(current.revisions, {
      at: now,
      action: 'update',
      detail: details.join('；'),
      ...(optionalText(reason) !== undefined ? { reason: reason!.trim() } : {}),
    })
    await this.kv.put(sourceKey(next.scope, next.id), next)
    return next
  }

  /**
   * 停用（**不删除**）。删了会让所有历史引用的含义一起蒸发。
   * @param reason - 为什么不再采信它（必填：这是本字段唯一的价值）
   */
  async retire(scope: string, id: string, reason: string): Promise<{ source: Source; changed: boolean }> {
    const current = this.find(scope, id)
    if (current === undefined) throw new Error(`来源：未找到 id="${id}"（scope=${scope}）`)
    if (current.status === 'retired') return { source: current, changed: false }
    const note = reason.trim()
    if (note.length === 0) {
      throw new Error('来源：停用必须给理由——「为什么不再采信它」是这个操作唯一有价值的部分')
    }
    const now = new Date().toISOString()
    const next: Source = {
      ...current,
      status: 'retired',
      retiredNote: note,
      updatedAt: now,
      revisions: pushRevision(current.revisions, { at: now, action: 'retire', detail: `停用：${note}` }),
    }
    await this.kv.put(sourceKey(next.scope, next.id), next)
    return { source: next, changed: true }
  }

  stats(): SourceStats {
    const all = this.all()
    const byType: Record<string, number> = {}
    const byScope: Record<string, number> = {}
    let active = 0
    let retired = 0
    let unlabeledReliability = 0
    let withOwner = 0
    let withPermissions = 0
    for (const source of all) {
      byScope[source.scope] = (byScope[source.scope] ?? 0) + 1
      byType[source.type] = (byType[source.type] ?? 0) + 1
      if (source.status === 'retired') retired += 1
      else active += 1
      if (optionalText(source.reliability) === undefined) unlabeledReliability += 1
      if (optionalText(source.owner) !== undefined) withOwner += 1
      if ((source.permissions ?? []).length > 0) withPermissions += 1
    }
    return { total: all.length, active, retired, unlabeledReliability, withOwner, withPermissions, byType, byScope }
  }

  /**
   * 分配下一个可读 id（`SOURCE-0001`，**每 scope 各自递增**）。
   *
   * ⚠ 与 `EntityStore.nextId` 的差别（刻意）：那边扫完 max 后还跑一个全表
   * `while (this.find(...) !== undefined)` 做防御——而 `find` 不按 scope 过滤，
   * 所以别的 scope 有 `ENTITY-0001` 时会把本 scope 的第一个挤成 `0002`。
   * 本 scope 内取 max+1 之后必然空（键带 scope），不需要那个循环。
   */
  private nextId(scope: string): string {
    let max = 0
    for (const [, source] of this.kv.entries()) {
      if (source.scope !== scope) continue
      const matched = /^SOURCE-(\d+)$/.exec(source.id)
      if (matched === null) continue
      const n = Number(matched[1])
      if (n > max) max = n
    }
    return `SOURCE-${String(max + 1).padStart(4, '0')}`
  }
}

/** 追加一条变更记录并裁到上限（保留最近 MAX_SOURCE_REVISIONS 条） */
function pushRevision(history: SourceRevision[] | undefined, entry: SourceRevision): SourceRevision[] {
  const next = [...(history ?? []), entry]
  return next.length > MAX_SOURCE_REVISIONS ? next.slice(next.length - MAX_SOURCE_REVISIONS) : next
}
