/**
 * 类型化关系层（v0.28.0 · 方案 §4.4）——从「记忆目录」走向「知识网络」的第一块地基。
 *
 * ## 为什么是独立资源，而不是条目里的一个字段
 *
 * 一条关系有自己的身份、来源、有效时间与可信度：`A 支持 B` 这句话的真值不随 A 或 B 的
 * 正文改写而消失，也不该被 `A.tags` 这种自由文本承载（标签无类型、无方向、无有效期）。
 * 因此边落**独立表** `relations`，条目一个字段都不加。
 *
 * ## 十种关系类型（方案 §4.4 原文）
 *
 * | 类型 | 读法（from → to） | 反向读法 |
 * |------|------------------|---------|
 * | `belongs-to` | 属于 | 包含 |
 * | `related-to` | 关联 | 关联 |
 * | `supports` | 支持 | 被支持 |
 * | `refutes` | 反驳 | 被反驳 |
 * | `sourced-from` | 来源于 | 是…的来源 |
 * | `derived-from` | 派生自 | 被派生 |
 * | `supersedes` | 取代 | 被取代 |
 * | `participates-in` | 参与 | 被参与 |
 * | `uses` | 使用 | 被使用 |
 * | `depends-on` | 依赖 | 被依赖 |
 *
 * **方向由类型定义**（每种类型声明 `fromRole` / `toRole` 两个角色名），没有「反向边」
 * 这种独立类型：读 `direction: "in"` 时同一条边以反向标签呈现——同一事实不存两份。
 *
 * ## 一个事实一个归宿：`supersedes` 不由本层写入
 *
 * 条目已有 `supersededBy` / `supersedes` 两个字段（§5.16），唯一写入口是
 * `memory_supersede`（它写**两侧**）。本层若再存一条「取代」边，就有两个真源，
 * 两者不同步时无人能判谁对 ⇒ `memory_link` 对 `supersedes` **拒写**并指向那个工具；
 * 读取侧改用 `structuralEdgesOf` 从字段**派生**（不落盘、随时可重建）。
 *
 * 同一条纪律适用于压缩链：概要的 `archiveRef` 是「派生自」的权威字段 ⇒ 也走派生视图。
 *
 * ## 有效期不是作废
 *
 * `validTo` 过了 = 这条断言**不再成立**，但它曾经成立（历史仍可查，`includeExpired` 可见）。
 * 与 `reviewAfter` 的裁决同源（§5.14）：到期只表示该重看，不表示自动失效。
 *
 * ## 已知边界（不得读成「已有知识图谱」）
 *
 * - 节点只开放 `entry`（实体 / 主题是 §4.3 / §4.2 的活，届时扩 `RelationNodeKind`）。
 * - 不做图数据库、不做查询语言（主人 2026-10-13 定调排除）。
 * - 关系**不参与检索排序**（§8.3 的「实体匹配 / 主题关联度」仍在缺项清单里）——
 *   本层只提供「沿边行走」的读路径，不改变 `recall` 的排序。
 *
 * 纯函数 + 单表存储，不依赖 Cordis / fs（离线可测：tests/relations.test.mjs）。
 */

import { randomUUID } from 'node:crypto'
import type { Entry, Provenance, Relation, RelationNodeKind, RelationType } from './types.ts'

// ---------- 类型枚举（单一真源） ----------

/** 十种关系类型（顺序 = 方案 §4.4 的列举顺序，也是统计展示顺序） */
export const RELATION_TYPES: readonly RelationType[] = [
  'belongs-to',
  'related-to',
  'supports',
  'refutes',
  'sourced-from',
  'derived-from',
  'supersedes',
  'participates-in',
  'uses',
  'depends-on',
]

/** 关系类型的读法、方向语义与一句话说明 */
export interface RelationTypeSpec {
  /** 从 `from` 读到 `to` 的标签（如「支持」） */
  label: string
  /** 从 `to` 反读时的标签（如「被支持」） */
  inverse: string
  /** `from` 端的角色名 */
  fromRole: string
  /** `to` 端的角色名 */
  toRole: string
  /** 什么时候用这条边（给写入侧看的判据，不是散文） */
  note: string
}

/**
 * 十种类型的完整规格。
 *
 * ⚠ `supersedes` 的 `note` 明写「不由本层写入」——它是读路径的派生视图专用类型，
 * 写入口是 `memory_supersede`（见文件头「一个事实一个归宿」）。
 */
export const RELATION_TYPE_SPECS: Record<RelationType, RelationTypeSpec> = {
  'belongs-to': {
    label: '属于',
    inverse: '包含',
    fromRole: '从属者',
    toRole: '容器',
    note: '某条记忆属于某个项目 / 主题 / 集合。判据：换一个容器它就说不通。',
  },
  'related-to': {
    label: '关联',
    inverse: '关联',
    fromRole: '一方',
    toRole: '另一方',
    note: '两个节点有联系但说不清更强的类型时用。⚠ 它是**兜底类型**：能说清就别说「关联」。',
  },
  supports: {
    label: '支持',
    inverse: '被支持',
    fromRole: '证据',
    toRole: '结论',
    note: '一条记忆支持某项结论。这是知识网络里最重要的一条边：结论被推翻时沿它反向找证据。',
  },
  refutes: {
    label: '反驳',
    inverse: '被反驳',
    fromRole: '反证',
    toRole: '结论',
    note: '一条证据反驳某项结论。与 `supports` 同形反向，用来记「为什么我改主意了」。',
  },
  'sourced-from': {
    label: '来源于',
    inverse: '是…的来源',
    fromRole: '记忆',
    toRole: '来源',
    note: '一条记忆来源于某个事件 / 文档 / 会话条目。与 `evidenceRefs` 分工：那个存坐标字符串，这个连到**库内的节点**。',
  },
  'derived-from': {
    label: '派生自',
    inverse: '被派生',
    fromRole: '派生知识',
    toRole: '来源知识',
    note: '一条知识由另一条整理形成（提炼 / 归纳 / 合并）。压缩链的 `archiveRef` 是它的既有载体，本层读为派生边。',
  },
  supersedes: {
    label: '取代',
    inverse: '被取代',
    fromRole: '新',
    toRole: '旧',
    note: '⚠ **不由 memory_link 写入**：唯一写入口是 memory_supersede（它写条目两侧字段）。本层只读派生视图。',
  },
  'participates-in': {
    label: '参与',
    inverse: '被参与',
    fromRole: '参与者',
    toRole: '事件 / 活动',
    note: '某个人 / 某个角色参与了某个事件。',
  },
  uses: {
    label: '使用',
    inverse: '被使用',
    fromRole: '任务',
    toRole: '方法 / 工具',
    note: '某个任务采用某种方法或工具。',
  },
  'depends-on': {
    label: '依赖',
    inverse: '被依赖',
    fromRole: '依赖方',
    toRole: '被依赖的成果',
    note: '一个项目或任务依赖另一项成果。⚠ 依赖是**有方向的时间断言**：上游变了要沿它回查。',
  },
}

/** 节点类别（v0.28.0 只开放 `entry`；实体 / 主题待 §4.3 / §4.2） */
export const RELATION_NODE_KINDS: readonly RelationNodeKind[] = ['entry']

/** 节点类别中文标签（渲染与报错用） */
const NODE_KIND_LABELS: Record<RelationNodeKind, string> = {
  entry: '记忆条目',
}

// ---------- 参数解析（工具层入口：fail-loud，不猜） ----------

/**
 * 类型守卫：是不是合法关系类型。
 * @param value - 任意输入
 */
export function isRelationType(value: unknown): value is RelationType {
  return typeof value === 'string' && RELATION_TYPES.includes(value as RelationType)
}

/**
 * 解析**写入侧**关系类型（必填，fail-loud）。
 *
 * 写入不接受别名：边类型是结构而不是措辞，猜一个近似类型等于把「支持」记成「关联」，
 * 而这两条边在结论被推翻时的用途完全不同。
 * @param raw - 工具参数原值
 * @param field - 报错里用的字段名
 */
export function parseRelationTypeArg(raw: unknown, field = 'type'): RelationType {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error(`${field}: 必填（${RELATION_TYPES.join(' / ')}）`)
  }
  const trimmed = raw.trim()
  if (!isRelationType(trimmed)) {
    throw new Error(
      `${field}: 未知关系类型 ${JSON.stringify(raw)}——合法值只有 ${RELATION_TYPES.join(' / ')}`
      + `（读法：${RELATION_TYPES.map((t) => `${t}=${RELATION_TYPE_SPECS[t].label}`).join('，')}）`,
    )
  }
  return trimmed
}

/**
 * 解析读取侧类型过滤（数组；任一项非法整笔拒绝）。
 * @param raw - 工具参数原值（字符串或字符串数组）
 * @param field - 报错里用的字段名
 * @returns 去重后的类型数组；未给返回 `undefined`（= 不过滤）
 */
export function parseRelationTypesArg(raw: unknown, field = 'types'): RelationType[] | undefined {
  if (raw === undefined || raw === null) return undefined
  const list = Array.isArray(raw) ? raw : [raw]
  const out: RelationType[] = []
  for (const item of list) {
    const parsed = parseRelationTypeArg(item, field)
    if (!out.includes(parsed)) out.push(parsed)
  }
  return out.length > 0 ? out : undefined
}

/**
 * 解析节点类别（缺省 `entry`：本版唯一可解析的类别）。
 * @param raw - 工具参数原值
 * @param field - 报错里用的字段名
 */
export function parseNodeKindArg(raw: unknown, field = 'kind'): RelationNodeKind {
  if (raw === undefined || raw === null) return 'entry'
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error(`${field}: 期望字符串（${RELATION_NODE_KINDS.join(' / ')}），收到 ${typeof raw}`)
  }
  const trimmed = raw.trim()
  const hit = RELATION_NODE_KINDS.find((kind) => kind === trimmed)
  if (hit === undefined) {
    throw new Error(
      `${field}: 本版只支持 ${RELATION_NODE_KINDS.map((k) => `${k}（${NODE_KIND_LABELS[k]}）`).join(' / ')}；`
      + `收到 ${JSON.stringify(raw)}。实体与主题节点待 §4.3 规范控制 / §4.2 主题词表落地后开放。`,
    )
  }
  return hit
}

/**
 * 解析可信度（0–1 之间的实数；**无默认值**——不给就是未评估）。
 * @param raw - 工具参数原值
 * @param field - 报错里用的字段名
 */
export function parseConfidenceArg(raw: unknown, field = 'confidence'): number | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new Error(`${field}: 期望 0–1 之间的数字，收到 ${typeof raw}`)
  }
  if (raw < 0 || raw > 1) throw new Error(`${field}: 必须在 0–1 之间，收到 ${raw}`)
  return raw
}

/**
 * 解析有效时间（ISO 日期或时刻；返回原字符串，不做时区改写）。
 *
 * 与 `validAfter`（条目字段）同形：接受 `YYYY-MM-DD` / ISO 时刻，
 * **不接受相对写法**——关系的有效期答的是既成事实，不是死线（死线用 `reviewAfter`）。
 * @param raw - 工具参数原值
 * @param field - 报错里用的字段名
 */
export function parseValidTimeArg(raw: unknown, field: string): string | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') throw new Error(`${field}: 期望字符串（YYYY-MM-DD 或 ISO 时刻），收到 ${typeof raw}`)
  const trimmed = raw.trim()
  if (trimmed.length === 0) return undefined
  if (!/^\d{4}-\d{2}-\d{2}([T ][0-9:.+\-Z]*)?$/.test(trimmed)) {
    throw new Error(`${field}: 期望 YYYY-MM-DD 或 ISO 时刻，收到 ${JSON.stringify(raw)}（不接受 +7d 这类相对写法）`)
  }
  const ts = Date.parse(trimmed)
  if (Number.isNaN(ts)) throw new Error(`${field}: 不是可解析的时间 ${JSON.stringify(raw)}`)
  return trimmed
}

// ---------- 边的时间语义 ----------

/**
 * 边是否仍然成立（有效期判断）。
 *
 * ## 边界口径（两个粒度，刻意不同）
 *
 * - **纯日期** `YYYY-MM-DD`：视为「到那一天的**结束**为止」⇒ 当天仍有效（写「至 2026-12-31」
 *   的人指的是年底，不是那天零点）。
 * - **ISO 时刻**：视为**左闭右开**——`validTo = T` 表示 T 起不再成立。这条口径是为了
 *   `memory_unlink` 的即时退役：退役时刻写 `now`，那么「现在读」就必须已经不成立
 *   （否则「刚退役的边还在」会在同一毫秒内骗过读者——单测实测撞到过）。
 *
 * 只有 `validTo` 参与：`validFrom` 在未来的边是「已登记、尚未生效」，仍返回（带标注），
 * 因为写入它的人此刻就在声明一条将来才成立的断言——把它藏起来等于让声明消失。
 * @param relation - 边
 * @param now - 判定基准时刻（缺省当前）
 */
export function isRelationLive(relation: Pick<Relation, 'validTo'>, now: Date = new Date()): boolean {
  if (relation.validTo === undefined) return true
  const ts = Date.parse(relation.validTo)
  // 坏值不当作过期：数据路径容错，坏坐标不能让整条边消失（同 evidence 的读取纪律）
  if (Number.isNaN(ts)) return true
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(relation.validTo.trim())
  if (dateOnly) return ts + 86_400_000 - 1 >= now.getTime()
  return now.getTime() < ts
}

/**
 * 边是否尚未生效（`validFrom` 在将来）。
 * @param relation - 边
 * @param now - 判定基准时刻（缺省当前）
 */
export function isRelationPending(relation: Pick<Relation, 'validFrom'>, now: Date = new Date()): boolean {
  if (relation.validFrom === undefined) return false
  const ts = Date.parse(relation.validFrom)
  if (Number.isNaN(ts)) return false
  return ts > now.getTime()
}

// ---------- 存储 ----------

/**
 * 关系表的 kv 最小接口（与 `store.ts::KvLike` 同形，元素类型换成 Relation）。
 */
export interface RelationKvLike {
  /** 同步读单条；不存在返回 undefined */
  get(key: string): Relation | undefined
  /** 持久化写入（整条覆盖） */
  put(key: string, value: Relation): Promise<void>
  /** 持久化删除；返回该 key 是否原本存在 */
  delete(key: string): Promise<boolean>
  /** 快照迭代器：[key, relation] 全量遍历 */
  entries(): IterableIterator<[string, Relation]>
  /** 当前记录数 */
  readonly size: number
}

/** 新边草稿（id / createdAt 由存储层生成） */
export interface RelationDraft {
  type: RelationType
  from: string
  to: string
  /** 存储分区（取 `from` 端条目的 scope：边跟着它描述的主体走） */
  scope: string
  /** 关系来源（**必填**：这条边凭什么说是这样） */
  provenance: Provenance
  confidence?: number
  validFrom?: string
  validTo?: string
  evidenceRefs?: string[]
  note?: string
}

/** 一次写入的结果：`created=false` = 已有同型同向的边（幂等，未写第二条） */
export interface LinkResult {
  relation: Relation
  created: boolean
}

/** 关系表统计（memory_stats 用） */
export interface RelationStats {
  total: number
  live: number
  expired: number
  byType: Record<RelationType, number>
  byProvenance: Record<Provenance | 'unlabeled', number>
  /** 填了可信度的条数（**未填不是 0 分**，是未评估） */
  withConfidence: number
  /** 填了有效期（validFrom 或 validTo）的条数 */
  withValidity: number
}

/** 关系表 key：`<scope>:relation:<id>` */
export function relationKey(scope: string, id: string): string {
  return `${scope}:relation:${id}`
}

/**
 * 关系存储：单表 CRUD + 幂等写 + 软退役。
 *
 * 与 `MemoryStore` 的分工：本类只做**边的生命周期**；两端节点是否存在由工具层校验
 * （那里才有条目的视野与角色准入）。
 */
export class RelationStore {
  constructor(private readonly kv: RelationKvLike) {}

  /**
   * 全量边（跨 scope；快照拷贝）。
   * @returns 边数组（顺序 = 存储迭代顺序）
   */
  all(): Relation[] {
    const out: Relation[] = []
    for (const [, relation] of this.kv.entries()) out.push({ ...relation })
    return out
  }

  /**
   * 某分区的边。
   * @param scope - 存储分区（global 或 workspaceId）
   */
  byScope(scope: string): Relation[] {
    return this.all().filter((relation) => relation.scope === scope)
  }

  /**
   * 按 id 跨 scope 查找。
   * @param id - 边 id
   */
  find(id: string): Relation | undefined {
    for (const [, relation] of this.kv.entries()) {
      if (relation.id === id) return { ...relation }
    }
    return undefined
  }

  /**
   * 建立一条边（幂等：同 (type, from, to) 的**有效**边已存在 ⇒ 返回它，不写第二条）。
   *
   * ⚠ 已退役（`validTo` 已过）的同类边**不算**重复：那条断言曾经成立、现在不成立了，
   * 再次成立就是**新的历史段**。复用它等于改写历史（把旧边的 validTo 抹掉）。
   * @param draft - 边草稿（节点存在性已由调用方校验）
   */
  async link(draft: RelationDraft): Promise<LinkResult> {
    const now = new Date()
    const existing = this.all().find(
      (relation) =>
        relation.type === draft.type
        && relation.from === draft.from
        && relation.to === draft.to
        && isRelationLive(relation, now),
    )
    if (existing !== undefined) return { relation: existing, created: false }

    const relation: Relation = {
      id: randomUUID(),
      type: draft.type,
      from: draft.from,
      to: draft.to,
      fromKind: 'entry',
      toKind: 'entry',
      scope: draft.scope,
      provenance: draft.provenance,
      createdAt: now.toISOString(),
      ...(draft.confidence !== undefined ? { confidence: draft.confidence } : {}),
      ...(draft.validFrom !== undefined ? { validFrom: draft.validFrom } : {}),
      ...(draft.validTo !== undefined ? { validTo: draft.validTo } : {}),
      ...(draft.evidenceRefs !== undefined && draft.evidenceRefs.length > 0 ? { evidenceRefs: draft.evidenceRefs } : {}),
      ...(draft.note !== undefined ? { note: draft.note } : {}),
    }
    await this.kv.put(relationKey(relation.scope, relation.id), relation)
    return { relation, created: true }
  }

  /**
   * 软退役一条边（把 `validTo` 设为退役时刻；**不删除记录**）。
   *
   * 已退役的边再退役 ⇒ 原样返回（`changed=false`），让「退役时刻」保持第一次的语义。
   * @param id - 边 id
   * @param opts - `at` 退役时刻（缺省当前）、`reason` 追加到 note 的说明
   * @returns 写后的边；找不到 id 返回 `undefined`
   */
  async unlink(
    id: string,
    opts: { at?: Date; reason?: string } = {},
  ): Promise<{ relation: Relation; changed: boolean } | undefined> {
    const found = this.find(id)
    if (found === undefined) return undefined
    const now = opts.at ?? new Date()
    if (found.validTo !== undefined && !isRelationLive(found, now)) {
      return { relation: found, changed: false }
    }
    const note = opts.reason === undefined || opts.reason.trim().length === 0
      ? found.note
      : [found.note, `退役原因：${opts.reason.trim()}`].filter((part) => part !== undefined && part !== '').join('；')
    const retired: Relation = {
      ...found,
      validTo: now.toISOString(),
      ...(note !== undefined && note !== '' ? { note } : {}),
    }
    await this.kv.put(relationKey(retired.scope, retired.id), retired)
    return { relation: retired, changed: true }
  }

  /**
   * 统计（memory_stats 用）。
   * @param now - 判定基准时刻（缺省当前）
   */
  stats(now: Date = new Date()): RelationStats {
    const byType = Object.fromEntries(RELATION_TYPES.map((type) => [type, 0])) as Record<RelationType, number>
    const byProvenance = Object.fromEntries(
      [...(['master', 'web', 'self', 'measured'] as const), 'unlabeled'].map((key) => [key, 0]),
    ) as Record<Provenance | 'unlabeled', number>
    let total = 0
    let live = 0
    let withConfidence = 0
    let withValidity = 0
    for (const relation of this.all()) {
      total += 1
      if (isRelationLive(relation, now)) live += 1
      if (isRelationType(relation.type)) byType[relation.type] += 1
      byProvenance[isProvenanceValue(relation.provenance) ? relation.provenance : 'unlabeled'] += 1
      if (typeof relation.confidence === 'number') withConfidence += 1
      if (relation.validFrom !== undefined || relation.validTo !== undefined) withValidity += 1
    }
    return { total, live, expired: total - live, byType, byProvenance, withConfidence, withValidity }
  }
}

/** 类型守卫（读取侧容错：历史数据可能带未知 provenance） */
function isProvenanceValue(value: unknown): value is Provenance {
  return value === 'master' || value === 'web' || value === 'self' || value === 'measured'
}

// ---------- 派生视图（从既有字段读，不落盘） ----------

/** 派生边的来源字段 */
export type StructuralEdgeOrigin = 'supersededBy' | 'supersedes' | 'archiveRef'

/** 从条目字段派生出的结构边（不是本层写入的数据） */
export interface StructuralEdge {
  /** 关系类型（只有两种：取代 / 派生自） */
  type: 'supersedes' | 'derived-from'
  from: string
  to: string
  /** 真源字段：改这个字段就等于改这条边 */
  origin: StructuralEdgeOrigin
}

/**
 * 从条目既有字段派生结构边（**不落盘**：字段是唯一真源）。
 *
 * 映射：
 * - `entry.supersededBy = X` ⇒ `supersedes: X → entry`（X 取代 entry）
 * - `entry.supersedes = [Y…]` ⇒ `supersedes: entry → Y`（同一事实的另一侧）
 * - `entry.archiveRef = [Z…]` ⇒ `derived-from: entry → Z`（概要从原料派生）
 *
 * 两侧同时写过（`memory_supersede` 的正常行为）会得到两条同向同端点的边 ⇒ 按
 * (type, from, to) 去重，`origin` 保留先遇到的那个（结果与顺序无关：去重键唯一）。
 * @param entries - 候选条目（调用方决定视野）
 */
export function structuralEdgesOf(entries: readonly Entry[]): StructuralEdge[] {
  const seen = new Set<string>()
  const out: StructuralEdge[] = []
  const push = (edge: StructuralEdge): void => {
    const key = `${edge.type}|${edge.from}|${edge.to}`
    if (edge.from === edge.to || seen.has(key)) return
    seen.add(key)
    out.push(edge)
  }
  for (const entry of entries) {
    if (typeof entry.supersededBy === 'string' && entry.supersededBy !== '') {
      push({ type: 'supersedes', from: entry.supersededBy, to: entry.id, origin: 'supersededBy' })
    }
    for (const oldId of entry.supersedes ?? []) {
      push({ type: 'supersedes', from: entry.id, to: oldId, origin: 'supersedes' })
    }
    for (const sourceId of entry.archiveRef ?? []) {
      push({ type: 'derived-from', from: entry.id, to: sourceId, origin: 'archiveRef' })
    }
  }
  return out
}

// ---------- 读路径 ----------

/** 一条从被查节点看出去的边（方向已按被查节点归一） */
export interface RelationHit {
  relation: Relation
  /** `out` = 该节点是 from；`in` = 该节点是 to */
  direction: 'out' | 'in'
  /** 该方向上的读法标签（如「支持」/「被支持」） */
  label: string
  /** 另一端的节点 id */
  peer: string
  /** 有效期内？ */
  live: boolean
  /** 尚未生效（validFrom 在将来） */
  pending: boolean
}

/** 读路径选项 */
export interface RelationQueryOptions {
  /** 只看这些类型；缺省 = 全部 */
  types?: readonly RelationType[]
  /** 方向：`out` 出边 / `in` 入边 / `both` 双向（缺省） */
  direction?: 'out' | 'in' | 'both'
  /** 是否包含已过期（`validTo` 已过）的边；缺省否 */
  includeExpired?: boolean
  /** 判定基准时刻 */
  now?: Date
  /** 结果上限（缺省不限） */
  limit?: number
}

/**
 * 取某节点的边（已按方向归一 + 排序：有效在前、同组按类型顺序）。
 * @param relations - 候选边
 * @param nodeId - 被查节点 id
 * @param opts - 过滤与截断
 */
export function edgesOf(
  relations: readonly Relation[],
  nodeId: string,
  opts: RelationQueryOptions = {},
): RelationHit[] {
  const now = opts.now ?? new Date()
  const direction = opts.direction ?? 'both'
  const hits: RelationHit[] = []
  for (const relation of relations) {
    const isFrom = relation.from === nodeId
    const isTo = relation.to === nodeId
    if (!isFrom && !isTo) continue
    if (direction === 'out' && !isFrom) continue
    if (direction === 'in' && !isTo) continue
    if (opts.types !== undefined && !opts.types.includes(relation.type)) continue
    const live = isRelationLive(relation, now)
    if (!live && opts.includeExpired !== true) continue
    const spec = RELATION_TYPE_SPECS[relation.type]
    const forward = isFrom
    hits.push({
      relation,
      direction: forward ? 'out' : 'in',
      label: spec === undefined ? relation.type : forward ? spec.label : spec.inverse,
      peer: forward ? relation.to : relation.from,
      live,
      pending: isRelationPending(relation, now),
    })
  }
  hits.sort((a, b) => {
    if (a.live !== b.live) return a.live ? -1 : 1
    const rank = (hit: RelationHit): number => RELATION_TYPES.indexOf(hit.relation.type)
    return rank(a) - rank(b)
  })
  return opts.limit !== undefined && opts.limit >= 0 ? hits.slice(0, opts.limit) : hits
}

/**
 * 某节点的派生结构边（从条目字段算；方向已归一）。
 * @param entries - 视野内条目（含归档才能看到指向归档条目的边）
 * @param nodeId - 被查节点 id
 */
export function structuralHitsOf(
  entries: readonly Entry[],
  nodeId: string,
): { type: 'supersedes' | 'derived-from'; direction: 'out' | 'in'; label: string; peer: string; origin: StructuralEdgeOrigin }[] {
  return structuralEdgesOf(entries)
    .filter((edge) => edge.from === nodeId || edge.to === nodeId)
    .map((edge) => {
      const forward = edge.from === nodeId
      const spec = RELATION_TYPE_SPECS[edge.type]
      return {
        type: edge.type,
        direction: forward ? ('out' as const) : ('in' as const),
        label: forward ? spec.label : spec.inverse,
        peer: forward ? edge.to : edge.from,
        origin: edge.origin,
      }
    })
}

/**
 * 节点的度数（有几条边连着它，只数有效边）——渲染用。
 * @param relations - 候选边
 * @param nodeId - 节点 id
 * @param now - 判定基准时刻
 */
export function degreeOf(relations: readonly Relation[], nodeId: string, now: Date = new Date()): number {
  let degree = 0
  for (const relation of relations) {
    if (relation.from !== nodeId && relation.to !== nodeId) continue
    if (!isRelationLive(relation, now)) continue
    degree += 1
  }
  return degree
}

/**
 * 渲染标记：有边给 `⇄N`，无边给空串（「标记要挑着打」，同 `spaceTag`）。
 * @param relations - 候选边
 * @param nodeId - 节点 id
 * @param now - 判定基准时刻
 */
export function relationTag(relations: readonly Relation[], nodeId: string, now: Date = new Date()): string {
  const degree = degreeOf(relations, nodeId, now)
  return degree > 0 ? `⇄${degree}` : ''
}

/**
 * 一条边的单行渲染（读路径给模型看的形态）。
 * @param hit - 已归一的边
 * @param peerTitle - 对端标题（找不到时由调用方给 id 兜底）
 */
export function formatRelationHit(hit: RelationHit, peerTitle: string): string {
  const meta: string[] = []
  if (hit.relation.provenance !== undefined) meta.push(`来源${hit.relation.provenance}`)
  if (typeof hit.relation.confidence === 'number') meta.push(`可信度${hit.relation.confidence}`)
  if (hit.relation.validFrom !== undefined) meta.push(`自${hit.relation.validFrom}`)
  if (hit.relation.validTo !== undefined) meta.push(`至${hit.relation.validTo}`)
  if (!hit.live) meta.push('已过期')
  if (hit.pending) meta.push('未生效')
  const suffix = meta.length > 0 ? `（${meta.join('·')}）` : ''
  return `${hit.direction === 'out' ? '→' : '←'} ${hit.label} ${peerTitle}(id=${hit.peer})${suffix}`
}
