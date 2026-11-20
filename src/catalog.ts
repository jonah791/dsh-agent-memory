/**
 * 编目工作面（v0.40 · 方案 §7 第 07 步「编目与标引」· §5.1 九组元数据）——**只读**。
 *
 * ## 为什么是「存量工作面」而不是「写入闸」
 *
 * 方案 §7 的十步流水线里本插件只有 01（采集＝`remember`）与 09（存储索引）。第 07 步
 * 「赋予元数据、分类、主题词和规范实体」没有载体。而缺口的主战场是**存量**：
 * 应编目活跃条目 1700+ 条，`memType` 有值的只有 20 条（真分母口径），增量每天才几十条
 * ⇒ 就算从今天起每次写入都编目，也要近百天才能追平。所以本节先补**让存量可作业**的那一层。
 *
 * ## 为什么不做批量标注
 *
 * 「这条属于哪一类」是判断。批量赋值＝机制替我判断，而判错的代价（类别错了却看起来
 * 像已编目）比「未分类」更贵——**未分类是诚实的「不知道」**。本节只做三件事：
 * 报缺口、按标签聚簇、给建议（`suggested` 永不落库）。
 *
 * ## 三个分母口径（都随返回值一起出现，不让人去猜）
 *
 * 1. **应编目分母**：活跃且非压缩产物（排除 `archived` / 冷存档 / `compaction` / `kind='summary'`）。
 *    `summary` 是压缩流水线自动生成的桶，**不属于七类任何一类**——把它算进「未分类」会让
 *    分母虚高、并让「完整率」永远差一截而原因不可见。
 * 2. **四维缺口各自独立**：不合成一个「完整度分数」（合成就丢掉了「差哪一维」）。
 * 3. **可机械覆盖上限**：按标签贪心聚簇能覆盖多少（2026-11-19 实测 1016/2245 = 45%）。
 *    这个数决定「批量归类值不值得做」——§13.3 的 98% 用机械手段达不到。
 *
 * 纯函数层：不依赖 Cordis / fs，离线可测（tests/catalog.test.mjs）。
 */

import type { Entry, MemType } from './types.ts'
import { COLD_CHECKPOINT_TAG } from './types.ts'
import { MEM_TYPES, isMemType } from './memType.ts'
import { countByEffectiveType, countByEffectiveTypeSource, type EffectiveTypeSource } from './retention.ts'

/** 压缩检查点的另一个标签（与 COLD_CHECKPOINT_TAG 并列，两者都表示「压缩产物」） */
export const COMPACTION_TAG = 'compaction'

/**
 * 标签 → 建议类别（**服务端启发式先验，不是数据**）。
 *
 * 只用于 `suggested` 字段，**永不写入条目**。它会错——`任务板` 既可能是「今天做了什么」
 * （episodic）也可能是「项目进度」（project）；`实测` 既可能是结论（semantic）也可能是
 * 工具经验（operational）。所以它出现在返回值里时是**提问**不是**答案**。
 *
 * 表里没有的标签 ⇒ 不给建议（诚实留空比硬塞一个最近类强）。
 */
export const TAG_MEMTYPE_HINTS: Readonly<Record<string, MemType>> = {
  // 怎么做 / 判据 / 教训 → 程序记忆
  技能: 'procedural',
  判据: 'procedural',
  判据设计: 'procedural',
  教训: 'procedural',
  方法论: 'procedural',
  口径: 'procedural',
  验收: 'procedural',
  // 运行经验 / 事故 / 工具 → 系统运行记忆
  事故: 'operational',
  插件: 'operational',
  git: 'operational',
  报错: 'operational',
  compaction: 'operational',
  压缩: 'operational',
  // 项目
  期货: 'project',
  论文: 'project',
  anima: 'project',
  量化: 'project',
  milestone: 'project',
  manor: 'project',
  庄园: 'project',
  // 工作记录 → 情景记忆
  任务板: 'episodic',
  日结: 'episodic',
  每日反思: 'episodic',
  '6维棱镜': 'episodic',
  '6维': 'episodic',
  // 实测读数多为结论
  实测: 'semantic',
}

/** 单维缺口读数 */
export interface CatalogGap {
  /** 分母内缺该维的条数 */
  readonly missing: number
  /** 分母（应编目条目数） */
  readonly total: number
  /** 覆盖率 `(total - missing) / total`；分母 0 ⇒ 0（不是 NaN） */
  readonly rate: number
}

export interface CatalogCluster {
  readonly tag: string
  /** 该标签下「应编目且未分类」的条数 */
  readonly count: number
  /** 建议类别；标签不在提示表里 ⇒ 缺省（**不给建议**，不硬塞最近类） */
  readonly suggested?: MemType
  /** 样本（id 全量，能直接喂给 `update`） */
  readonly samples: Array<{ id: string; title: string }>
}

export interface CatalogReport {
  /**
   * 时间窗（v0.64 · 方案 §10.2 日增量维护）。**缺省不出现** = 全库读数。
   *
   * 出现的唯一理由是「**窗内读数必须自带范围**」——否则同一个 20.2% 在「全库」与
   * 「近 1 天」两个口径下会被读成同一件事（§13.3 反复踩过的形状：读数不自带范围标注）。
   */
  readonly window?: {
    readonly sinceHours: number
    /** 窗口左端（ISO）——读数自带坐标，不靠调用方记 */
    readonly startIso: string
  }
  /** 应编目分母 */
  readonly denominator: number
  /**
   * 被排除的部分（自报，否则「为什么只有这么少」不可见）。
   *
   * ⚠ **`net` 是唯一可减的数**：`isCatalogable` 只有三条排除（归档 / 压缩产物 / summary），
   * 而下面四项是**各自在全量上的独立计数**，彼此有交集（一条归档的 summary 在 `archived`
   * 与 `summary` 各计一次）。2026-11-19 实测（工具视野 = `e:/alice` + `global`）：
   * 全量 3099 − 应编目 1771 = 净排除 **1328**，而四项相加 1752 ⇒ 重叠 **424**。
   * 磁盘口径是 3101 − 1773 = **同一净排除 1328**（差 2 是两个孤儿 scope 的活跃条目）。
   * 旧渲染把它们并列成「分母排除：…」，读法上诱导相加，得出的分母比真值小 424。
   * **分项相加 ≠ 净排除，这个数不报就不自洽。**
   */
  readonly excluded: {
    /** 传入集合的全量条数（= 分母 + 净排除） */
    readonly considered: number
    /** 净排除 = `considered − denominator`。**唯一可减的数**；四项分项不可相加 */
    readonly net: number
    readonly archived: number
    readonly coldCheckpoint: number
    readonly compaction: number
    readonly summary: number
  }
  readonly gaps: {
    readonly memType: CatalogGap
    readonly space: CatalogGap
    readonly provenance: CatalogGap
    readonly sourceIds: CatalogGap
  }
  /** 「未分类且应编目」的条数（= `gaps.memType.missing`，单列出来便于读） */
  readonly unclassified: number
  readonly clusters: CatalogCluster[]
  /** 被簇覆盖的条目数（去重后） */
  readonly clustered: number
  /** 簇覆盖不到的条目数（`unclassified - clustered`） */
  readonly uncovered: number
  /** 零标签的未分类条目数（任何聚簇都覆盖不到，必须自报） */
  readonly zeroTag: number
  /** 生效类别分布（与 `memory_stats.retention` / `memory_audit.retention` 同源） */
  readonly byEffectiveType: Record<MemType | 'unknown', number>
  /**
   * 类别**来源**三档计数（与 `byEffectiveType` 同分母、同判据，只是按来源拆开）。
   *
   * 为什么要单列：`gaps.memType` 报的是**字段存有率**（我亲笔填了几条），
   * `byEffectiveType` 报的是**有效分类率**（含零猜测派生）。2026-11-19 线上实测两者差
   * **13 倍**（1.4% vs 17.0%）——只报前者会让「维度建了但没人用」变成唯一读法，
   * 而真实边界是「83.0% 的存量在语义上无法机械归类」（全是 `kind='knowledge'`，
   * 可被语义/程序/运行/项目/关系五类中的任一类解释 ⇒ 推不出就不推）。
   */
  readonly effectiveSources: Record<EffectiveTypeSource, number>
}

/** 是否为压缩产物（冷存档检查点或 compaction 标记） */
export function isCompactionArtifact(entry: Pick<Entry, 'tags'>): boolean {
  const tags = entry.tags ?? []
  return tags.includes(COLD_CHECKPOINT_TAG) || tags.includes(COMPACTION_TAG)
}

/**
 * 应编目分母成员判定。
 *
 * 三条排除各有理由：`archived` 已离开活跃馆藏；压缩产物（检查点 / `compaction` 标记）
 * 是自动生成的冷数据；`kind='summary'` 是压缩链的桶，**不属于七类任何一类**。
 */
export function isCatalogable(entry: Pick<Entry, 'archived' | 'tags' | 'kind'>): boolean {
  if (entry.archived) return false
  if (isCompactionArtifact(entry)) return false
  if (entry.kind === 'summary') return false
  return true
}

function gapOf(entries: readonly Entry[], missing: (entry: Entry) => boolean): CatalogGap {
  let miss = 0
  for (const entry of entries) if (missing(entry)) miss += 1
  const total = entries.length
  return { missing: miss, total, rate: total === 0 ? 0 : (total - miss) / total }
}

/** 四维缺口（各自独立，不合成分数） */
export function catalogGaps(entries: readonly Entry[]): CatalogReport['gaps'] {
  return {
    memType: gapOf(entries, (entry) => !isMemType(entry.memType)),
    // 只判 `undefined`：`Space` / `Provenance` 是固定枚举，写空串不是合法值（参数入口 fail-loud），
    // 所以「有值」等价于「非 undefined」。
    space: gapOf(entries, (entry) => entry.space === undefined),
    provenance: gapOf(entries, (entry) => entry.provenance === undefined),
    sourceIds: gapOf(entries, (entry) => !Array.isArray(entry.sourceIds) || entry.sourceIds.length === 0),
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 引用完整性（v0.65 · 方案 §10.2「日增量维护」第三项「失效引用」）
// ════════════════════════════════════════════════════════════════════════════

/**
 * 一档引用计数的**三档互斥**读数。
 *
 * `checked + missing + unverifiable === total` 恒成立——这是本模块唯一的不变量，
 * 理由见 `integrityReport` 的文档。
 */
export interface IntegrityCell {
  /** 校验过且目标存在 */
  readonly checked: number
  /** 校验过且目标不存在（真悬空） */
  readonly missing: number
  /** **无法校验**（判据池不可得 / 只校验了引用的一部分）——不是「没有悬空」 */
  readonly unverifiable: number
  /** 三档之和 */
  readonly total: number
}

/**
 * 引用完整性需要的判据池（都是**全库**集合，不随窗口变化）。
 *
 * ⚠ 除 `entryIds` 外全部可选，且 `undefined` 与**空集**含义相反：
 * - 空集 ⇒ 判据池可用但一个目标都没有 ⇒ 所有引用都是悬空（**真红**）
 * - `undefined` ⇒ 该表未接线 / 读不到 ⇒ 该档记 `unverifiable`（**不是红**）
 *
 * 这条区分是本模块存在的一半理由：把「装配缺陷」静默成「引用都悬空」会让我去修一个
 * 不存在的问题，而那个假问题看起来与真问题完全一样。
 */
export interface IntegrityInputs {
  /** 条目 id（`store.list` 恒有，故必填）——`archiveRef` 的判据池 */
  readonly entryIds: ReadonlySet<string>
  /** 来源表；`undefined` ⇒ 来源引用档逐处记 unverifiable */
  readonly sourceIds?: ReadonlySet<string>
  /** 概念表；`undefined` ⇒ 关系边指向概念时该端记 unverifiable */
  readonly conceptIds?: ReadonlySet<string>
  /** 实体表；`undefined` ⇒ 关系边指向实体时该端记 unverifiable */
  readonly entityIds?: ReadonlySet<string>
  /**
   * 磁盘上真实存在的会话 id（**归一化**：去掉 `session-` 前缀、转小写）。
   * `undefined` ⇒ 调用方拿不到磁盘目录 ⇒ 会话类坐标全部记 `unverifiable`。
   */
  readonly sessionIds?: ReadonlySet<string>
  /**
   * 关系边（全库；边不按窗口切——两端不在窗内也照样要存在）。
   * `undefined` ⇒ 关系层未接线，该档 `total` 为 0 并由 caveats 点名（**不是「没有边」**）。
   */
  readonly relations?: readonly {
    readonly id: string
    readonly from: string
    readonly to: string
    readonly fromKind?: string
    readonly toKind?: string
  }[]
}

/** 一条悬空样本（只给坐标，不给正文——与 actor-audit 的最小化同纪律） */
export interface IntegritySample {
  readonly kind: string
  readonly ownerId: string
  readonly ref: string
}

export interface IntegrityReport {
  /** 证据坐标 · 会话类 */
  readonly evidenceSession: IntegrityCell
  /**
   * 证据坐标 · 压缩类。
   * ⚠ 只校验会话存在，**不校验第三段的 compaction id**（载体是会话日志内的事件）
   * ⇒ 会话存在时记 `unverifiable`，这是**下界**。
   */
  readonly evidenceCompaction: IntegrityCell
  /** 归档引用（概要 → 原料） */
  readonly archiveRef: IntegrityCell
  /** 来源实体引用 */
  readonly sourceIds: IntegrityCell
  /** 关系边两端 */
  readonly relations: IntegrityCell
  /** 悬空样本（最多 8 条） */
  samples: IntegritySample[]
  /** 本轮**没能覆盖**的面，逐条点名 */
  caveats: string[]
}

const MAX_INTEGRITY_SAMPLES = 8

function emptyCell(): { checked: number; missing: number; unverifiable: number; total: number } {
  return { checked: 0, missing: 0, unverifiable: 0, total: 0 }
}

function asRefList(value: readonly string[] | string | undefined | null): string[] {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? [...value] : [value as string]
}

/** 归一化会话 id：去 `session-` 前缀、转小写（与磁盘目录名同一口径）。 */
export function normalizeSessionId(value: string): string {
  return String(value).replace(/^session-/, '').toLowerCase()
}

/**
 * 量一遍引用完整性（**只读派生**，不改任何条目）。
 *
 * ## 这个 0 为什么是「构造性为零」而不是「维护得好」
 *
 * 来源 / 概念 / 实体在**写入时**就拒写悬空（`remember.sourceIds` 校验、
 * `thesaurus.ts` 与 `entities.ts` 的引用完整性检查），归档引用与证据坐标又都从真实对象
 * 生成 ⇒ 全库 585 处引用实测悬空 0（2026-11-20）。所以这一项的真形态是**哨兵**：
 * 只有「目标在写入**之后**消失」才会破，而本库唯一会消失的目标是会话日志
 * （磁盘清理 / 迁移）。这与「代理结构性不触发」不同——那不是没对象，是不可能触发；
 * 这里是有对象、当前都健康。
 *
 * ## 为什么必须分三档
 *
 * 哨兵最怕**恒 0 的假绿**：若某天会话目录读不到，`missing` 仍是 0，而它看起来与
 * 「全都好」一模一样。⇒ `unverifiable` 单列，且三档之和恒等于 `total`。
 *
 * ## 判据池与被检查集合是两件事
 *
 * `inputs` 里的四个 id 集合与 `relations` 是**全库**的判据池（「目标在不在」要问全库）；
 * 被检查的条目由调用方按窗口切（日增量维护只看窗内新增）。⇒ `total` 是**窗内条目上
 * 出现过的引用处数**，不是全库引用数。两者在返回值里各自可读，不混成一个数。
 */
export function integrityReport(
  entries: readonly Entry[],
  inputs: IntegrityInputs,
): IntegrityReport {
  const evidenceSession = emptyCell()
  const evidenceCompaction = emptyCell()
  const archiveRef = emptyCell()
  const sourceIds = emptyCell()
  const relations = emptyCell()
  const samples: IntegritySample[] = []

  const push = (kind: string, ownerId: string, ref: string): void => {
    if (samples.length < MAX_INTEGRITY_SAMPLES) samples.push({ kind, ownerId, ref })
  }

  for (const entry of entries) {
    for (const raw of asRefList(entry.evidenceRefs)) {
      const [kind, scopeId] = String(raw).split('|')
      if (kind === 'session') {
        evidenceSession.total += 1
        if (inputs.sessionIds === undefined || scopeId === undefined || scopeId === '') {
          // 判据池不可得，或坐标本身解不出会话段（格式坏）：都不判悬空
          evidenceSession.unverifiable += 1
        } else if (inputs.sessionIds.has(normalizeSessionId(scopeId))) {
          evidenceSession.checked += 1
        } else {
          evidenceSession.missing += 1
          push('evidenceSession', entry.id, String(raw))
        }
      } else if (kind === 'compaction') {
        evidenceCompaction.total += 1
        if (inputs.sessionIds === undefined || scopeId === undefined || scopeId === '') {
          evidenceCompaction.unverifiable += 1
        } else if (inputs.sessionIds.has(normalizeSessionId(scopeId))) {
          // 会话在，但 compaction id 本身未校验 ⇒ 下界
          evidenceCompaction.unverifiable += 1
        } else {
          evidenceCompaction.missing += 1
          push('evidenceCompaction', entry.id, String(raw))
        }
      } else {
        // 未知前缀：不猜它指向什么，也不当悬空——记「无法校验」
        evidenceSession.total += 1
        evidenceSession.unverifiable += 1
      }
    }

    for (const target of asRefList(entry.archiveRef)) {
      archiveRef.total += 1
      if (inputs.entryIds.has(target)) archiveRef.checked += 1
      else {
        archiveRef.missing += 1
        push('archiveRef', entry.id, target)
      }
    }

    for (const target of asRefList(entry.sourceIds)) {
      sourceIds.total += 1
      if (inputs.sourceIds === undefined) {
        // 来源表未接线：引用处数照算，但判不了 ⇒ 记「无法校验」，**不记悬空**
        sourceIds.unverifiable += 1
      } else if (inputs.sourceIds.has(target)) {
        sourceIds.checked += 1
      } else {
        sourceIds.missing += 1
        push('sourceIds', entry.id, target)
      }
    }
  }

  /** 关系边两端的判据池：按 kind 取；池不可用返回 undefined（该端记 unverifiable）。 */
  const poolOf = (kind: string | undefined): ReadonlySet<string> | undefined =>
    kind === 'concept' ? inputs.conceptIds : kind === 'entity' ? inputs.entityIds : inputs.entryIds

  for (const edge of inputs.relations ?? []) {
    for (const [side, id, kind] of [
      ['from', edge.from, edge.fromKind],
      ['to', edge.to, edge.toKind],
    ] as const) {
      relations.total += 1
      const pool = poolOf(kind)
      if (pool === undefined) relations.unverifiable += 1
      else if (pool.has(id)) relations.checked += 1
      else {
        relations.missing += 1
        push('relations', edge.id, `${side}=${id}`)
      }
    }
  }

  const caveats: string[] = []
  if (inputs.sessionIds === undefined) {
    caveats.push('会话目录不可得（或未接线）⇒ 证据坐标全部记「无法校验」，**不是 0 悬空**')
  } else {
    caveats.push(
      `压缩类坐标只校验所属会话存在（${evidenceCompaction.checked + evidenceCompaction.unverifiable} 处），第三段 compaction id 未校验 ⇒ 该项是下界`,
    )
  }
  if (inputs.sourceIds === undefined) caveats.push('来源表未接线 ⇒ 来源引用逐处记「无法校验」，不是 0 悬空')
  if (inputs.relations === undefined) caveats.push('关系层未接线 ⇒ 关系边一档**未测**（total 0 不代表没有边）')
  if (inputs.conceptIds === undefined || inputs.entityIds === undefined) {
    caveats.push('概念表或实体表未接线 ⇒ 指向它们的关系端点记「无法校验」')
  }
  caveats.push('来源引用与 credibility 段的悬空报告同源（同一判据池），两处不另算增量')

  return {
    evidenceSession: { ...evidenceSession },
    evidenceCompaction: { ...evidenceCompaction },
    archiveRef: { ...archiveRef },
    sourceIds: { ...sourceIds },
    relations: { ...relations },
    samples,
    caveats,
  }
}

/** 把一个 cell 折成「有悬空吗」的单值，仅用于渲染与测试断言（不参与任何判断）。 */
export function hasMissing(report: IntegrityReport): boolean {
  return (
    report.evidenceSession.missing +
      report.evidenceCompaction.missing +
      report.archiveRef.missing +
      report.sourceIds.missing +
      report.relations.missing >
    0
  )
}

export interface ClusterOptions {
  /** 最多出几个簇（缺省 12） */
  readonly maxClusters?: number
  /** 一个标签至少覆盖多少条才成簇（缺省 8）——太小的簇是噪声 */
  readonly minClusterSize?: number
  /** 每簇样本数（缺省 3） */
  readonly samples?: number
  /**
   * 时间窗（小时）：只统计 `createdAt` 落在此窗内的条目（v0.64 · 方案 §10.2「日增量维护」）。
   * 缺省 = 全库（零回归）。传 `24` 就是「昨天新增那一批」。
   */
  readonly sinceHours?: number
  /** 窗口右端（ms）。缺省 `Date.now()`；测试传固定值，避免读数随跑的时刻漂移 */
  readonly nowMs?: number
}

/**
 * 按共享标签贪心聚簇（**覆盖优先**，不是「标签频次优先」）。
 *
 * 每步选「能覆盖最多**尚未被覆盖**条目」的标签——这与「按标签条数排序」不同：
 * 后者会让三个高重叠的标签各占一个簇位却只覆盖同一批条目。
 *
 * ⚠ 已知低估：字面标签不合并同义词（`插件` 与 `plugin` 是两个簇），补齐要词表参与。
 */
export function clusterByTag(
  entries: readonly Entry[],
  options: ClusterOptions = {},
): { clusters: CatalogCluster[]; clustered: number } {
  const maxClusters = options.maxClusters ?? 12
  const minClusterSize = options.minClusterSize ?? 8
  const samplesPer = options.samples ?? 3

  const pending = new Map<string, Entry>()
  for (const entry of entries) pending.set(entry.id, entry)

  // 标签 → 条目（只统计还在 pending 里的，每步重算，天然去重覆盖）
  const clusters: CatalogCluster[] = []
  let clustered = 0

  for (let step = 0; step < maxClusters; step += 1) {
    const counts = new Map<string, number>()
    for (const entry of pending.values()) {
      for (const tag of new Set(entry.tags ?? [])) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1)
      }
    }
    let bestTag: string | undefined
    let bestCount = 0
    for (const [tag, count] of counts) {
      // 并列时取字典序小的，保证可复现（不依赖 Map 插入顺序）
      if (count > bestCount || (count === bestCount && bestTag !== undefined && tag < bestTag)) {
        bestTag = tag
        bestCount = count
      }
    }
    if (bestTag === undefined || bestCount < minClusterSize) break

    const members: Entry[] = []
    for (const entry of pending.values()) {
      if ((entry.tags ?? []).includes(bestTag)) members.push(entry)
    }
    // 样本取体量最大的几条：信息量大的更值得人读一眼
    const sample = [...members]
      .sort((a, b) => (b.body ?? '').length - (a.body ?? '').length)
      .slice(0, samplesPer)
      .map((entry) => ({ id: entry.id, title: entry.title }))

    const hint = TAG_MEMTYPE_HINTS[bestTag]
    clusters.push({
      tag: bestTag,
      count: members.length,
      ...(hint !== undefined ? { suggested: hint } : {}),
      samples: sample,
    })
    clustered += members.length
    for (const entry of members) pending.delete(entry.id)
  }

  return { clusters, clustered }
}

/**
 * 时间窗过滤（纯函数，v0.64 · 方案 §10.2「日增量维护」）。
 *
 * **为什么导出**：`memory_catalog` 的同一次返回里还有一段「四维可信度」读数，它必须与
 * 编目段**同一个窗**——否则屏幕上会出现「上面窗内 29 条、下面全库 1800 条」，而两段各自
 * 都写着「与上同一把尺子」。2026-11-20 线上实测就撞成这个形状。**一个窗口一个过滤器**。
 *
 * 为什么按 `createdAt` 而不是 `updatedAt`：「日增量」问的是「昨天新写进来那批质量如何」；
 * `updatedAt` 会把被 `update` / `forget` 动过的旧条目混进来。「变更窗口」是另一个需求。
 */
export function filterByWindow(
  entries: readonly Entry[],
  options: { sinceHours?: number; nowMs?: number } = {},
): readonly Entry[] {
  const sinceHours = options.sinceHours
  if (sinceHours === undefined) return entries
  const startMs = (options.nowMs ?? Date.now()) - sinceHours * 3_600_000
  return entries.filter((entry) => {
    const at = Date.parse(entry.createdAt)
    return Number.isFinite(at) && at >= startMs
  })
}

/**
 * 编目工作面读数（纯函数）。
 *
 * @param entries - 库内条目（调用方负责视野与 scope 过滤）
 * @param options - 聚簇参数
 */
export function catalogReport(entries: readonly Entry[], options: ClusterOptions = {}): CatalogReport {
  // 时间窗（v0.64 · §10.2 日增量维护）：现在取一次，窗口左端与过滤用**同一个 nowMs**，
  // 否则两处各调一次 Date.now() 会差几毫秒，`window.startIso` 与实际过滤边界不同步。
  const sinceHours = options.sinceHours
  const nowMs = options.nowMs ?? Date.now()
  const windowStartMs = sinceHours === undefined ? undefined : nowMs - sinceHours * 3_600_000
  const scoped = sinceHours === undefined ? entries : filterByWindow(entries, { sinceHours, nowMs })
  const denominator = scoped.filter(isCatalogable)
  const excluded = {
    considered: scoped.length,
    // 净排除必须由「全量 − 分母」算出来，不能用四项相加：四项是独立计数、彼此有交集
    net: scoped.length - denominator.length,
    archived: scoped.filter((entry) => entry.archived).length,
    coldCheckpoint: scoped.filter((entry) => (entry.tags ?? []).includes(COLD_CHECKPOINT_TAG)).length,
    compaction: scoped.filter((entry) => (entry.tags ?? []).includes(COMPACTION_TAG)).length,
    summary: scoped.filter((entry) => entry.kind === 'summary').length,
  }
  const gaps = catalogGaps(denominator)
  const unclassified = denominator.filter((entry) => !isMemType(entry.memType))
  const zeroTag = unclassified.filter((entry) => (entry.tags ?? []).length === 0).length
  const { clusters, clustered } = clusterByTag(unclassified, options)

  return {
    // 窗内读数自带范围：缺省不出现 = 全库（见 CatalogReport.window 注释）
    ...(windowStartMs !== undefined && sinceHours !== undefined
      ? { window: { sinceHours, startIso: new Date(windowStartMs).toISOString() } }
      : {}),
    denominator: denominator.length,
    excluded,
    gaps,
    unclassified: unclassified.length,
    clusters,
    clustered,
    uncovered: unclassified.length - clustered,
    zeroTag,
    byEffectiveType: countByEffectiveType(denominator),
    // 与 byEffectiveType 同分母、同判据——只按来源拆开，不另立口径
    effectiveSources: countByEffectiveTypeSource(denominator),
  }
}

/** 分母与七类名单一起导出，便于工具层校验「四维之和 ≠ 条目数」是刻意设计 */
export { MEM_TYPES }
