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
import { countByEffectiveType } from './retention.ts'

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

export interface ClusterOptions {
  /** 最多出几个簇（缺省 12） */
  readonly maxClusters?: number
  /** 一个标签至少覆盖多少条才成簇（缺省 8）——太小的簇是噪声 */
  readonly minClusterSize?: number
  /** 每簇样本数（缺省 3） */
  readonly samples?: number
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
 * 编目工作面读数（纯函数）。
 *
 * @param entries - 库内条目（调用方负责视野与 scope 过滤）
 * @param options - 聚簇参数
 */
export function catalogReport(entries: readonly Entry[], options: ClusterOptions = {}): CatalogReport {
  const denominator = entries.filter(isCatalogable)
  const excluded = {
    considered: entries.length,
    // 净排除必须由「全量 − 分母」算出来，不能用四项相加：四项是独立计数、彼此有交集
    net: entries.length - denominator.length,
    archived: entries.filter((entry) => entry.archived).length,
    coldCheckpoint: entries.filter((entry) => (entry.tags ?? []).includes(COLD_CHECKPOINT_TAG)).length,
    compaction: entries.filter((entry) => (entry.tags ?? []).includes(COMPACTION_TAG)).length,
    summary: entries.filter((entry) => entry.kind === 'summary').length,
  }
  const gaps = catalogGaps(denominator)
  const unclassified = denominator.filter((entry) => !isMemType(entry.memType))
  const zeroTag = unclassified.filter((entry) => (entry.tags ?? []).length === 0).length
  const { clusters, clustered } = clusterByTag(unclassified, options)

  return {
    denominator: denominator.length,
    excluded,
    gaps,
    unclassified: unclassified.length,
    clusters,
    clustered,
    uncovered: unclassified.length - clustered,
    zeroTag,
    byEffectiveType: countByEffectiveType(denominator),
  }
}

/** 分母与七类名单一起导出，便于工具层校验「四维之和 ≠ 条目数」是刻意设计 */
export { MEM_TYPES }
