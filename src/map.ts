/**
 * 知识地图（v0.45 · 方案 §4.5）——**只读、只派生、不加字段**。
 *
 * ## 它回答的问题与 `catalog.ts` 不同
 *
 * `catalog.ts`（v0.40）报「该补哪些字段」——作业面，只覆盖未分类条目。
 * 本节报「知识本身长什么样、哪里是空的」——认知面，覆盖全库。
 * 两者读同一批条目，读数不可互相替代。
 *
 * ## 三档可读性：这套仪器的核心机制
 *
 * 方案 §4.5 列了七项要求，但**其中三项的数据源近乎全空**（`space` 1.4% / 关系边 2 条 /
 * `expiry` 0 条）。照字面建七项，产出会是「输出 0 但看起来健康」的仪器——与 v0.44 之前
 * 「空结果率恒为 0.00%」是同一个病：**仪器在，读数健康，其实什么都没测**。
 *
 * 所以每一维必须自报它现在能代表多少条：
 * - `measured`：数据源填充率 ≥ 50%（我的工程惯例，取中位数：少于一半成员有值时，
 *   聚合结果由少数决定）⇒ 读数可用于排名。
 * - `starved`：0 < 填充率 < 50% ⇒ **报分母与填充率，不报排名**（排名会诱导读者把
 *   「25 条的分布」读成「1794 条的结论」）。
 * - `absent`：填充率 0 或缺载体 ⇒ **报缺什么，不报 0 作为结论**。
 *   `expiry=0` 的两种读法在数字上都是 0、在含义上相反：**「没有一条设过失效时刻」
 *   ≠「没有过期知识」**。
 *
 * ## 不做什么
 *
 * 不加字段（三个先例证明可空字段必然不填：`memType` 1.1% / `space` 1.2% /
 * `sourceIds` 0.11%）· 不自动建关系边（候选只提问）· 不建「领域 → 主题」两层树
 * （两侧数据源都 starved；触发条件见设计正本 §7）。
 *
 * 纯函数层：不依赖 Cordis / fs，离线可测（`tests/map.test.mjs`）。
 */

import type { Concept, Entry, Relation, Space } from './types.ts'
import { labelsOf, normalizeLabel } from './thesaurus.ts'
import { expiryStateOf } from './temporal-dual.ts'

/** 可读性三档（定义见文件头） */
export type MapReadability = 'measured' | 'starved' | 'absent'

/** 七维 id（与方案 §4.5 的七项一一对应） */
export type MapDimensionId = 'domains' | 'topics' | 'links' | 'activity' | 'projects' | 'blanks' | 'expiry'

export interface MapDimension {
  readonly id: MapDimensionId
  /** 方案原文那一项（引用原句，避免转述漂移） */
  readonly requirement: string
  /** 该维的分母（**口径名一起出现**，否则「1.4%」会被读成别的意思） */
  readonly denominatorName: string
  readonly denominator: number
  readonly filled: number
  readonly fillingRate: number
  readonly readability: MapReadability
  /** `starved` / `absent` 时必须说明「为什么读不出 / 读出来代表什么」 */
  readonly note: string
}

/** 阈值：填充率 ≥ 此值才算 `measured`（中位数惯例，非行业标准） */
export const MEASURED_THRESHOLD = 0.5

/**
 * 按填充率判可读性。
 *
 * @param denominator - 分母（0 ⇒ `absent`：没有可读的对象）
 * @param filled - 有值的条数
 * @returns 三档
 */
export function readabilityOf(denominator: number, filled: number): MapReadability {
  if (denominator <= 0) return 'absent'
  if (filled <= 0) return 'absent'
  return filled / denominator >= MEASURED_THRESHOLD ? 'measured' : 'starved'
}

export interface MapOptions {
  /** 参与共现的 top 标签数（缺省 30）——只算头部，避免两两组合爆炸 */
  readonly maxTopics?: number
  /** 共现达到多少次才进候选（缺省 5） */
  readonly minCooccurrence?: number
  /** 标签至少出现在多少条上才参与聚合（缺省 2；单例标签占比 73.7%，聚合它们无意义） */
  readonly minTopicDf?: number
  /** 候选上限（缺省 10） */
  readonly maxCandidates?: number
  /** top 标签列表长度（缺省 15） */
  readonly topTags?: number
  /** 活跃主题列表长度（缺省 10） */
  readonly topActive?: number
}

export interface MapInput {
  /** 条目（调用方负责 scope / 视野过滤） */
  readonly entries: readonly Entry[]
  readonly concepts: readonly Concept[]
  readonly relations: readonly Relation[]
  /** 条目 id → 被检索次数（来自 `memory-access-trace.jsonl`） */
  readonly retrievalCounts: ReadonlyMap<string, number>
  /** trace 首条时刻（ISO）；`null` = 无 trace ⇒ 「从未被检索」不可判 */
  readonly traceSince: string | null
  /** trace 总行数（与 `retrievalCounts` 分开传：行数含空结果记录） */
  readonly traceLines?: number
  /** 当前时刻（测试注入固定时钟，否则「已过期」随时间漂移无法断言） */
  readonly now: number
}

export interface ConceptUsage {
  readonly id: string
  readonly prefLabel: string
  readonly altLabelCount: number
  readonly broaderCount: number
  readonly relatedCount: number
  /** 有多少活跃条目用它的任一标签（按 `normalizeLabel` 归一比对） */
  readonly entriesUsing: number
}

export interface TopicStat {
  readonly tag: string
  readonly entries: number
  /** 该标签下被检索过的条目数 */
  readonly retrievedEntries: number
  /** 该标签下所有条目的检索次数之和 */
  readonly retrievals: number
}

export interface RelationCandidate {
  readonly a: string
  readonly b: string
  readonly cooccurrence: number
  /**
   * 两个标签都命中概念、且这两个概念之间已声明 `related` 边。
   * ⚠ 候选是**标签对**、声明是**概念对**——粒度不同，`false` 不代表「一定没声明」。
   */
  readonly declaredAsConceptPair: boolean
}

export interface MapReport {
  readonly considered: {
    readonly total: number
    readonly active: number
    readonly archived: number
  }
  readonly dimensions: MapDimension[]
  readonly domains: {
    readonly spaces: Array<{ space: Space; count: number }>
    /** 未标注空间的活跃条目（任何「按领域」的读数都覆盖不到） */
    readonly unset: number
  }
  readonly topics: {
    readonly concepts: ConceptUsage[]
    /** 被概念标签命中的标签数（受控率分子） */
    readonly controlledTags: number
    readonly totalTags: number
    readonly singletonTags: number
    readonly topTags: Array<{ tag: string; entries: number }>
  }
  readonly links: {
    readonly edges: number
    readonly byType: Record<string, number>
    /** 被关系边触达的不同条目数 */
    readonly entriesTouched: number
    readonly conceptRelatedPairs: number
  }
  readonly activity: {
    readonly retrievedEntries: number
    readonly neverRetrieved: number
    /** trace 是否可用（`false` ⇒ 「从未被检索」不可判，不是「没有活跃主题」） */
    readonly traceAvailable: boolean
    /** trace 首条时刻（ISO）；`traceAvailable=false` ⇒ 空串 */
    readonly traceSince: string
    readonly traceLines: number
    readonly topTopics: TopicStat[]
  }
  readonly projects: {
    readonly declared: number
    readonly byProject: Array<{ project: string; entries: number; topTags: string[] }>
  }
  readonly blanks: {
    /** 活跃但自 trace 起点起从未被记录检索过（边界：`traceSince`） */
    readonly unretrieved: number
    /** 只出现在 1 条条目上的标签（知识孤岛） */
    readonly singletonTopics: number
    /** 概念存在但没有任何条目用它的标签 */
    readonly unusedConcepts: Array<{ id: string; prefLabel: string }>
    /** 活跃条目零标签（连主题都没有，任何按主题的读数都覆盖不到） */
    readonly untagged: number
  }
  readonly expiry: {
    readonly unset: number
    readonly active: number
    readonly expired: number
  }
  readonly relationCandidates: RelationCandidate[]
}

/** 标签频次表（只统计传入条目） */
function tagCounts(entries: readonly Entry[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const entry of entries) {
    for (const tag of new Set(entry.tags ?? [])) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }
  return counts
}

/**
 * 知识地图读数（纯函数）。
 *
 * @param input - 条目 / 概念 / 关系 / 检索计数 / trace 边界 / 当前时刻
 * @param options - 聚合参数
 */
export function mapReport(input: MapInput, options: MapOptions = {}): MapReport {
  const maxTopics = options.maxTopics ?? 30
  const minCooccurrence = options.minCooccurrence ?? 5
  const minTopicDf = options.minTopicDf ?? 2
  const maxCandidates = options.maxCandidates ?? 10
  const topTagCount = options.topTags ?? 15
  const topActive = options.topActive ?? 10

  const now = new Date(input.now)
  const active = input.entries.filter((entry) => !entry.archived)
  const denominator = active.length
  // 按 push 顺序出（七项与方案 §4.5 同序），不用 Map：漏 push 会立刻少一项，而不是运行时 undefined
  const dimensions: MapDimension[] = []
  const push = (dimension: MapDimension): void => {
    dimensions.push(dimension)
  }

  // ── 1. 知识领域：`space` 四空间 ────────────────────────────────────────
  const spaceCounts = new Map<Space, number>()
  let spaceUnset = 0
  for (const entry of active) {
    if (entry.space === undefined) spaceUnset += 1
    else spaceCounts.set(entry.space, (spaceCounts.get(entry.space) ?? 0) + 1)
  }
  const spaceFilled = denominator - spaceUnset
  push({
    id: 'domains',
    requirement: '用户涉及哪些知识领域',
    denominatorName: '活跃条目',
    denominator,
    filled: spaceFilled,
    fillingRate: denominator === 0 ? 0 : spaceFilled / denominator,
    readability: readabilityOf(denominator, spaceFilled),
    note:
      spaceFilled === 0
        ? '四空间维度无一条目标注 ⇒ 按领域读不出任何东西（不是「只有一个领域」）'
        : `四空间维度填充率过低 ⇒ **不报领域排名**；下列分布只代表这 ${spaceFilled} 条，不代表全库`,
  })

  // ── 2. 领域下主题：词表 broader 树 + 标签受控率 ────────────────────────
  const counts = tagCounts(active)
  const totalTags = counts.size
  const conceptIndex = new Map<string, string[]>()
  for (const concept of input.concepts) {
    for (const label of labelsOf(concept)) {
      const key = normalizeLabel(label)
      if (key.length === 0) continue
      const list = conceptIndex.get(key)
      if (list === undefined) conceptIndex.set(key, [concept.id])
      else if (!list.includes(concept.id)) list.push(concept.id)
    }
  }
  const usedByConcept = new Map<string, Set<string>>()
  for (const entry of active) {
    for (const tag of new Set(entry.tags ?? [])) {
      const conceptIds = conceptIndex.get(normalizeLabel(tag))
      if (conceptIds === undefined) continue
      for (const conceptId of conceptIds) {
        const set = usedByConcept.get(conceptId)
        if (set === undefined) usedByConcept.set(conceptId, new Set([entry.id]))
        else set.add(entry.id)
      }
    }
  }
  // 受控标签数按「标签」计（不是「标签×条目」）
  const controlledTags = [...counts.keys()].filter((tag) => conceptIndex.has(normalizeLabel(tag))).length
  const concepts: ConceptUsage[] = input.concepts.map((concept) => ({
    id: concept.id,
    prefLabel: concept.prefLabel,
    altLabelCount: (concept.altLabels ?? []).length,
    broaderCount: (concept.broader ?? []).length,
    relatedCount: (concept.related ?? []).length,
    entriesUsing: usedByConcept.get(concept.id)?.size ?? 0,
  }))
  push({
    id: 'topics',
    requirement: '各个领域下有哪些主题',
    denominatorName: '库内不同标签',
    denominator: totalTags,
    filled: controlledTags,
    fillingRate: totalTags === 0 ? 0 : controlledTags / totalTags,
    readability: readabilityOf(totalTags, controlledTags),
    note:
      controlledTags === 0
        ? '没有任何标签被概念覆盖 ⇒ 主题层只有自由标签、没有受控词表'
        : `标签受控率过低 ⇒ **不按「领域 → 主题」建树**（树会是 ${controlledTags} 个标签构成的形状）；下列概念逐个报使用量`,
  })

  // ── 3. 主题间联系：关系边 + 词表 related + 共现候选 ────────────────────
  const byType: Record<string, number> = {}
  const touched = new Set<string>()
  for (const relation of input.relations) {
    byType[relation.type] = (byType[relation.type] ?? 0) + 1
    touched.add(relation.from)
    touched.add(relation.to)
  }
  let conceptRelatedPairs = 0
  for (const concept of input.concepts) conceptRelatedPairs += (concept.related ?? []).length
  // 对称存储时同一对会被数两次，取一半；但存量可能只有单侧，所以按「边」报并说明口径
  const relatedEdgeCount = conceptRelatedPairs
  push({
    id: 'links',
    requirement: '主题之间有哪些联系',
    denominatorName: '活跃条目',
    denominator,
    filled: touched.size,
    fillingRate: denominator === 0 ? 0 : touched.size / denominator,
    readability: readabilityOf(denominator, touched.size),
    note:
      input.relations.length === 0
        ? '关系表为空 ⇒ 沿边读不出任何联系；下列共现候选是唯一可用的关联线索'
        : `已声明的边只触达 ${touched.size} 条 ⇒ 沿边读不出全貌；共现候选补这一块（但共现 ≠ 语义关联）`,
  })

  // ── 4. 主题活跃：trace 检索次数按标签聚合 ──────────────────────────────
  const sortedTags = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
  let retrievedEntries = 0
  for (const entry of active) if ((input.retrievalCounts.get(entry.id) ?? 0) > 0) retrievedEntries += 1
  const neverRetrieved = denominator - retrievedEntries
  const tagStats = new Map<string, { entries: number; retrieved: number; retrievals: number }>()
  for (const entry of active) {
    const hits = input.retrievalCounts.get(entry.id) ?? 0
    for (const tag of new Set(entry.tags ?? [])) {
      const stat = tagStats.get(tag) ?? { entries: 0, retrieved: 0, retrievals: 0 }
      stat.entries += 1
      stat.retrievals += hits
      if (hits > 0) stat.retrieved += 1
      tagStats.set(tag, stat)
    }
  }
  const topTopics: TopicStat[] = [...tagStats.entries()]
    .filter(([tag]) => (counts.get(tag) ?? 0) >= minTopicDf)
    .map(([tag, stat]): TopicStat => ({
      tag,
      entries: stat.entries,
      retrievedEntries: stat.retrieved,
      retrievals: stat.retrievals,
    }))
    .sort((a, b) => b.retrievals - a.retrievals || (a.tag < b.tag ? -1 : 1))
    .slice(0, topActive)
  const activityReadability =
    input.traceSince === null || input.traceLines === 0
      ? 'absent'
      : readabilityOf(denominator, retrievedEntries)
  push({
    id: 'activity',
    requirement: '哪些主题长期活跃',
    denominatorName: '活跃条目（判据＝其中被 trace 记录检索过的比例）',
    denominator,
    filled: retrievedEntries,
    fillingRate: denominator === 0 ? 0 : retrievedEntries / denominator,
    readability: activityReadability,
    note:
      input.traceSince === null
        ? '无 access-trace ⇒ 「活跃」不可判（不是「没有活跃主题」）'
        : `trace 起点 ${input.traceSince} ⇒ 「活跃」只覆盖此后被记录的检索；auto 路径占多数时，读数偏向自动注入`,
  })

  // ── 5. 项目使用：project 字段 ─────────────────────────────────────────
  const projectCounts = new Map<string, number>()
  const projectTags = new Map<string, Map<string, number>>()
  for (const entry of active) {
    const project = entry.project
    if (project === undefined || project.length === 0) continue
    projectCounts.set(project, (projectCounts.get(project) ?? 0) + 1)
    let bucket = projectTags.get(project)
    if (bucket === undefined) {
      bucket = new Map<string, number>()
      projectTags.set(project, bucket)
    }
    for (const tag of new Set(entry.tags ?? [])) bucket.set(tag, (bucket.get(tag) ?? 0) + 1)
  }
  const byProject = [...projectCounts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([project, entryCount]) => {
      const bucket = projectTags.get(project) ?? new Map<string, number>()
      const top = [...bucket.entries()]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, 5)
        .map(([tag]) => tag)
      return { project, entries: entryCount, topTags: top }
    })
  const declaredProjects = [...projectCounts.values()].reduce((sum, value) => sum + value, 0)
  push({
    id: 'projects',
    requirement: '哪些项目正在使用这些知识',
    denominatorName: '活跃条目',
    denominator,
    filled: declaredProjects,
    fillingRate: denominator === 0 ? 0 : declaredProjects / denominator,
    readability: readabilityOf(denominator, declaredProjects),
    note: `只有 ${declaredProjects} 条声明了项目 ⇒ **不报项目排名**；下列分布只代表这些条目，未声明项目的知识按项目读不出来`,
  })

  // ── 6. 知识空白：四个口径，各自独立，不可合并 ─────────────────────────
  let singletonTags = 0
  for (const df of counts.values()) if (df === 1) singletonTags += 1
  const unusedConcepts = concepts
    .filter((concept) => concept.entriesUsing === 0)
    .map((concept) => ({ id: concept.id, prefLabel: concept.prefLabel }))
  const untagged = active.filter((entry) => (entry.tags ?? []).length === 0).length
  push({
    id: 'blanks',
    requirement: '哪些知识存在空白',
    // 分母是**口径数**不是条目数：四个口径各自独立，可判几个就报几个
    denominatorName: '四个空白口径',
    denominator: 4,
    filled: input.traceSince === null ? 3 : 4,
    fillingRate: input.traceSince === null ? 0.75 : 1,
    readability: input.traceSince === null ? 'starved' : 'measured',
    note:
      input.traceSince === null
        ? '无 trace ⇒ 「从未被检索」不可判（不是「没有未被检索的知识」）；其余三个口径（单例标签 / 未用概念 / 零标签）仍可读'
        : `四个口径各自独立、不可相加：未检索 ${neverRetrieved} · 单例标签 ${singletonTags} · 未用概念 ${unusedConcepts.length} · 零标签 ${untagged}`,
  })

  // ── 7. 知识过期：expiry 三态 ─────────────────────────────────────────
  let expiryUnset = 0
  let expiryActive = 0
  let expiryExpired = 0
  for (const entry of active) {
    const state = expiryStateOf(entry.expiry, now)
    if (state === 'unset') expiryUnset += 1
    else if (state === 'expired') expiryExpired += 1
    else expiryActive += 1
  }
  const expiryFilled = expiryActive + expiryExpired
  push({
    id: 'expiry',
    requirement: '哪些知识已经过期',
    denominatorName: '活跃条目',
    denominator,
    filled: expiryFilled,
    fillingRate: denominator === 0 ? 0 : expiryFilled / denominator,
    readability: readabilityOf(denominator, expiryFilled),
    note:
      expiryFilled === 0
        ? '没有一条设过失效时刻 ⇒ **读不出「哪些已过期」**。⚠ 这不是「没有过期知识」——两件事在数字上都是 0、在含义上相反'
        : `已设失效时刻 ${expiryFilled} 条，其中已过期 ${expiryExpired} 条；未设的死活未知`,
  })

  // ── 共现候选：只算头部标签，永不落库 ──────────────────────────────────
  const headTags = sortedTags.slice(0, maxTopics).map(([tag]) => tag)
  const headSet = new Set(headTags)
  const pairCounts = new Map<string, number>()
  for (const entry of active) {
    const present = [...new Set(entry.tags ?? [])].filter((tag) => headSet.has(tag))
    for (let i = 0; i < present.length; i += 1) {
      const left = present[i]
      if (left === undefined) continue
      for (let j = i + 1; j < present.length; j += 1) {
        const right = present[j]
        if (right === undefined) continue
        // 归一成「字典序小的在前」，同一个无序对只有一个 key
        const a = left <= right ? left : right
        const b = left <= right ? right : left
        const key = `${a}\u0000${b}`
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1)
      }
    }
  }
  const declaredPairs = new Set<string>()
  for (const concept of input.concepts) {
    for (const relatedId of concept.related ?? []) {
      declaredPairs.add([concept.id, relatedId].sort().join('\u0000'))
    }
  }
  const relationCandidates: RelationCandidate[] = [...pairCounts.entries()]
    .filter(([, count]) => count >= minCooccurrence)
    .map(([key, count]): RelationCandidate => {
      const splitAt = key.indexOf('\u0000')
      const a = key.slice(0, splitAt)
      const b = key.slice(splitAt + 1)
      const aConcepts = conceptIndex.get(normalizeLabel(a)) ?? []
      const bConcepts = conceptIndex.get(normalizeLabel(b)) ?? []
      let declared = false
      for (const left of aConcepts) {
        for (const right of bConcepts) {
          if (declaredPairs.has([left, right].sort().join('\u0000'))) declared = true
        }
      }
      return { a, b, cooccurrence: count, declaredAsConceptPair: declared }
    })
    .sort((x, y) => y.cooccurrence - x.cooccurrence || (x.a < y.a ? -1 : 1))
    .slice(0, maxCandidates)

  return {
    considered: {
      total: input.entries.length,
      active: denominator,
      // 归档 = 全量 − 活跃。**不用 `filter(archived)` 直接数**：两者应相等，
      // 但若有条目 archived 字段形态异常（历史数据），差值会暴露它
      archived: input.entries.length - denominator,
    },
    dimensions,
    domains: {
      spaces: [...spaceCounts.entries()]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .map(([space, count]) => ({ space, count })),
      unset: spaceUnset,
    },
    topics: {
      concepts,
      controlledTags,
      totalTags,
      singletonTags,
      topTags: sortedTags.slice(0, topTagCount).map(([tag, entries]) => ({ tag, entries })),
    },
    links: {
      edges: input.relations.length,
      byType,
      entriesTouched: touched.size,
      conceptRelatedPairs: relatedEdgeCount,
    },
    activity: {
      retrievedEntries,
      neverRetrieved,
      traceAvailable: input.traceSince !== null,
      // 输出层不用 null：宿主 output schema 的 type 没有 null，空串 + `traceAvailable` 才是可校验的
      traceSince: input.traceSince ?? '',
      traceLines: input.traceLines ?? 0,
      topTopics,
    },
    projects: { declared: declaredProjects, byProject },
    blanks: { unretrieved: neverRetrieved, singletonTopics: singletonTags, unusedConcepts, untagged },
    expiry: { unset: expiryUnset, active: expiryActive, expired: expiryExpired },
    relationCandidates,
  }
}
