/**
 * 四维可信度读数（v0.41 · 方案 §5.4「可信度不能只有一个数字」· §5.1 认知信息组）——**只读**。
 *
 * ## 为什么是「派生」而不是「四个新字段」
 *
 * 方案要求分别评价四维：来源可靠性、抽取置信度、事实核验状态、时效状态。直觉做法是加四个
 * 可空字段。**本库已有的三个先例全都证明那会失败**：`memType` 1.1%（v0.26.0 建）、`space` 1.2%
 * （v0.27.0 建）、`sourceIds` 0.11%（v0.35.0 建）——新增可空字段的默认结局是**永远不填**，
 * 于是「有字段」变成一种看起来像已建成的状态。
 *
 * 所以本模块**不存任何东西**：四维全部从既有字段派生，报的是**「这一维现在能不能读」**，
 * 不是「这一维打几分」。缺字段的地方就报 `unknown`——**未标注是诚实的「不知道」**。
 *
 * ## 方案要的是「评价」，我能给的常常是「看得到什么」——逐维交代（不许含糊）
 *
 * | 维度 | 我读到的 | 我读不到的 | 保真度 |
 * |---|---|---|---|
 * | 来源可靠性 | 引用了几个来源、其中几个标了 `reliability` | 来源**可不可靠**（`reliability` 是自由文本，机器判不了） | 代理 |
 * | 抽取置信度 | 可**回原文/来源核**吗（`provenance` + `evidenceRefs` + `sourceIds`） | 我**抽得准不准**（自评没有仪器，写个数字只是把猜测变成字段） | 代理 |
 * | 事实核验状态 | 外部主体（主人）回应过没有（`grounding` 四档） | 第三方独立复核（库外的事） | 直接 |
 * | 时效状态 | `expiry` 到点没有 · `reviewAfter` 该不该重看 | 内容实质是否仍成立（要人判） | 直接 |
 *
 * ⇒ **两个代理维必须在返回值里带 `caveat`**，而不是让人把「可核性」读成「准确率」。
 *
 * ## 本模块存在的真实理由（方案原文的例子就是现成样本）
 *
 * 方案 §5.4 的原话：「用户说『我计划明年学习某项技术』，这句话的来源可以是确定的，但不能
 * 因此认定用户已经掌握该技术。」——这正是 `grounding='proposed'` 的形状：**有值，但表示未核验**。
 *
 * 活库实测（2026-11-19 15:25，3098 条）：`established` 253 · `proposed` 5 · `scoped` 0 ·
 * `rejected` 0 · 未标注 2840。如果拿「有没有 `grounding`」当「核验过没有」，那 5 条**我自己提的、
 * 主人从未回应**的条目就会被读成已核实——与 AGENTS.md「把提议当授权」是同一个坑。
 * 所以本模块把「有值」拆成 `settled` / `selfVerified` / `inconclusive` / `unknown` 四档，
 * **四档之和恒等于分母**（可断言，见 tests/credibility.test.mjs C1）。
 *
 * ## 不合成总分
 *
 * 方案原话：「可信度不能只有一个数字」。所以返回值里没有 score——只有 `allSettled` /
 * `anySettled` 两个**计数**（「四维里能下几个结论」），且 `note` 明写它不表示「可信」。
 *
 * 纯函数层：不依赖 Cordis / fs，离线可测（`tests/credibility.test.mjs`）。
 */

import type { Entry, Grounding, Provenance } from './types.ts'
import { isCatalogable } from './catalog.ts'
import { expiryStateOf } from './temporal-dual.ts'
import { stalenessOf } from './temporal.ts'

/** 四维标识（与方案 §5.4 的四条一一对应，不多不少） */
export type CredDimensionId =
  | 'sourceReliability'
  | 'extractionConfidence'
  | 'verificationStatus'
  | 'freshness'

export const CRED_DIMENSIONS: readonly CredDimensionId[] = [
  'sourceReliability',
  'extractionConfidence',
  'verificationStatus',
  'freshness',
]

/**
 * 单维判定四档。
 *
 * - `settled`：字段有值**且语义成立**——这一维能下结论（结论可能是坏的，如「已失效」）
 * - `selfVerified`：**自验**（同一主体的第二次观察）。单列出来，因为方案要的是「**独立**核实」，
 *   而「我自己又看了一遍」不独立——合并进 `settled` 会让核实数虚高
 * - `inconclusive`：**有值但不能下结论**（`grounding='proposed'` 是未核验；`measured` 不是抽取产物）
 * - `unknown`：没有字段 ⇒ 不知道
 */
export type CredVerdict = 'settled' | 'selfVerified' | 'inconclusive' | 'unknown'

export const CRED_VERDICTS: readonly CredVerdict[] = ['settled', 'selfVerified', 'inconclusive', 'unknown']

export const CRED_VERDICT_LABELS: Record<CredVerdict, string> = {
  settled: '能下结论',
  selfVerified: '自验（非独立核实）',
  inconclusive: '有值但不下结论',
  unknown: '不知道',
}

/** 单条、单维的读数 */
export interface CredReading {
  readonly verdict: CredVerdict
  /** 人能直接读的一句话（进输出，保持短） */
  readonly reading: string
}

/** 一条记忆的四维读数 */
export interface EntryCredibility {
  readonly sourceReliability: CredReading
  readonly extractionConfidence: CredReading
  readonly verificationStatus: CredReading
  readonly freshness: CredReading
}

/**
 * 来源的最小形状。
 *
 * 纯函数只声明它需要什么（窄接口），不 import `src/sources.ts` 的存储类型——
 * 那条依赖会把「可信度读数」与「来源存储实现」绑在一起，而本模块只在来源表**存在时**
 * 多读一个 `reliability` 字段。映射点唯一：`tools.ts` 的 `buildCatalog`。
 */
export interface CredSource {
  readonly id: string
  /** 自由文本的可靠性评价。**空串与 undefined 同义：未标注** */
  readonly reliability?: string
  /** 已停用的来源：仍可引用（「依据被撤销」本身是要记的事实），但不算「已标注可靠性」 */
  readonly retired?: boolean
}

/** `credibilityOf` 需要的字段（窄 Pick，便于测试与复用） */
export interface CredEntryFields {
  /** 条目所在 scope——来源 id 只在 scope 内唯一，查来源必须带它（见 `SourceStore.find`） */
  readonly scope?: string
  readonly provenance?: Provenance
  readonly grounding?: Grounding
  readonly evidenceRefs?: readonly string[]
  readonly sourceIds?: readonly string[]
  readonly expiry?: string
  readonly reviewAfter?: string
}

export interface CredOptions {
  /**
   * 来源查找（scope + id）。
   *
   * 用查找函数而不是 `Map<id, Source>`：来源 id（`SOURCE-0001`）**只在 scope 内唯一**，
   * 两个 workspace 各有 `SOURCE-0001` 时按 id 建 Map 会撞号、取哪个取决于遍历顺序
   * （`sources.ts::find` 的注释里踩过同形的坑）。缺省 ⇒ 有 `sourceIds` 也判「查不到」。
   */
  readonly lookupSource?: (scope: string, id: string) => CredSource | undefined
  /** 现算时刻（缺省 `new Date()`）。注入以便测试可复现 */
  readonly now?: Date
}

// ── 四维各自的判定 ────────────────────────────────────────────────────────────

function sourceReliabilityOf(
  entry: CredEntryFields,
  lookup: (id: string) => CredSource | undefined,
): CredReading {
  const ids = entry.sourceIds ?? []
  if (ids.length === 0) {
    return { verdict: 'unknown', reading: '未登记来源——不知道这条依据的是什么' }
  }
  const missing = ids.filter((id) => lookup(id) === undefined)
  if (missing.length > 0) {
    // 悬空引用是「错」不是「不全」：来源表里没有它，可靠性无从谈起（与 v0.35.1 的两档立场一致）
    return {
      verdict: 'inconclusive',
      reading: `引用 ${ids.length} 个来源，其中 ${missing.length} 个在来源表里查不到（悬空引用）`,
    }
  }
  const labeled = ids.filter((id) => {
    const source = lookup(id)
    if (source === undefined || source.retired === true) return false
    return (source.reliability ?? '').trim() !== ''
  })
  if (labeled.length === ids.length) {
    // ⚠ 「标了」≠「可靠」：caveat 已声明 reliability 是自由文本，机器读不出高低
    return { verdict: 'settled', reading: `引用 ${ids.length} 个来源，可靠性均已标注（标注内容需人读）` }
  }
  return { verdict: 'inconclusive', reading: `引用 ${ids.length} 个来源，仅 ${labeled.length} 个标了可靠性` }
}

function extractionConfidenceOf(entry: CredEntryFields): CredReading {
  const provenance = entry.provenance
  if (provenance === undefined) {
    return { verdict: 'unknown', reading: '未标来源——不知道这条是抄的、推的还是测的' }
  }
  const refs = entry.evidenceRefs ?? []
  const ids = entry.sourceIds ?? []
  switch (provenance) {
    case 'master':
      return refs.length > 0
        ? { verdict: 'settled', reading: `主人原话，有 ${refs.length} 处原文坐标可回核` }
        : { verdict: 'inconclusive', reading: '主人原话，但没记原文坐标——只能信我的抄录' }
    case 'web':
      return ids.length > 0
        ? { verdict: 'settled', reading: `外部资料，已登记 ${ids.length} 个来源可回查` }
        : { verdict: 'inconclusive', reading: '外部资料但没登记来源——查不到从哪读来的' }
    case 'measured':
      return { verdict: 'inconclusive', reading: '我实测的读数——不是抽取产物，这一维对它不适用' }
    case 'self':
      return { verdict: 'inconclusive', reading: '我的推断——不存在「抽取准确」问题，该核的是结论本身' }
  }
}

function verificationStatusOf(entry: CredEntryFields): CredReading {
  switch (entry.grounding) {
    case 'established':
      return { verdict: 'settled', reading: '主人明确说过（已建立）' }
    case 'scoped':
      return { verdict: 'settled', reading: '主人接受但限定了范围（已建立，范围受限）' }
    case 'rejected':
      return { verdict: 'settled', reading: '主人否决过——核实结果是否定，这条不能再当依据' }
    case 'proposed':
      // ⚠ 这一档是本模块最要紧的一格：**有值，但表示未核验**
      return { verdict: 'inconclusive', reading: '我自己提的、主人没回应——未核验，不许当授权用' }
    default:
      break
  }
  if (entry.provenance === 'measured') {
    return { verdict: 'selfVerified', reading: '我实测过（同一主体自验）——不是独立核实' }
  }
  return { verdict: 'unknown', reading: '没有任何核验记录' }
}

function freshnessOf(entry: CredEntryFields, now: Date): CredReading {
  const expiry = expiryStateOf(entry.expiry, now)
  if (expiry === 'expired') {
    return { verdict: 'settled', reading: '已失效——到点了，别再当有效事实用（条目仍 active，处置归人）' }
  }
  if (expiry === 'active') {
    return { verdict: 'settled', reading: '仍适用（设了失效时刻且未到）' }
  }
  const stale = stalenessOf(entry.reviewAfter, now)
  if (stale === 'expired') {
    return { verdict: 'inconclusive', reading: '没设失效时刻；复看死线已过——该重看了，但还成不成立未知' }
  }
  if (stale === 'due-soon') {
    return { verdict: 'inconclusive', reading: '没设失效时刻；复看死线 7 天内到期' }
  }
  if (stale === 'fresh') {
    return { verdict: 'inconclusive', reading: '没设失效时刻；只有复看死线（还没到）' }
  }
  return { verdict: 'unknown', reading: '既没失效时刻也没复看死线——不知道现在还成不成立' }
}

/** 一条记忆的四维读数（不合成总分） */
export function credibilityOf(entry: CredEntryFields, options: CredOptions = {}): EntryCredibility {
  const scope = entry.scope ?? ''
  const lookup = (id: string) => options.lookupSource?.(scope, id)
  const now = options.now ?? new Date()
  return {
    sourceReliability: sourceReliabilityOf(entry, lookup),
    extractionConfidence: extractionConfidenceOf(entry),
    verificationStatus: verificationStatusOf(entry),
    freshness: freshnessOf(entry, now),
  }
}

// ── 聚合面（catalog 用） ──────────────────────────────────────────────────────

interface DimensionSpec {
  readonly label: string
  /** `direct` = 字段直接答了这一维；`proxy` = 字段只是代理 */
  readonly fidelity: 'direct' | 'proxy'
  /** 这一维成立需要哪些字段（缺口时可行动） */
  readonly needs: string[]
  /** 代理边界与已知盲区（**必填**：代理读数不写清边界就会被当成真读数） */
  readonly caveat: string
}

const DIMENSION_SPECS: Record<CredDimensionId, DimensionSpec> = {
  sourceReliability: {
    label: '来源可靠性',
    fidelity: 'proxy',
    needs: ['sourceIds', 'sources.reliability'],
    caveat:
      '`reliability` 是自由文本，机制只报「标了没有」，读不出「可不可靠」——本维是代理，不是可靠性评分。',
  },
  extractionConfidence: {
    label: '抽取置信度',
    fidelity: 'proxy',
    needs: ['provenance', 'evidenceRefs', 'sourceIds'],
    caveat:
      '`provenance` 答「谁说的」，不答「我抽得准不准」。本维读到的是可核性（能否回原文/来源核），不是准确率——自评置信度没有仪器，写个数字只是把猜测变成字段。',
  },
  verificationStatus: {
    label: '事实核验状态',
    fidelity: 'direct',
    needs: ['grounding', 'provenance'],
    caveat:
      '只有外部主体（主人）的回应算独立核实；`measured` 是同一主体自验，单列 `selfVerified` 不计入核实——方案原话「来源确定 ≠ 内容已核验」。',
  },
  freshness: {
    label: '时效状态',
    fidelity: 'direct',
    needs: ['expiry', 'reviewAfter'],
    caveat:
      '`expiry` 答「何时不再成立」，`reviewAfter` 答「何时该重看」。只有前者能给「仍适用」的结论；只有后者时有值但不下结论。',
  },
}

/** 单维的聚合读数（四档之和恒等于 `total`） */
export interface CredDimensionReport {
  readonly dimension: CredDimensionId
  readonly label: string
  readonly fidelity: 'direct' | 'proxy'
  /** 字段有值且语义成立 */
  readonly settled: number
  /** 自验（同一主体，非独立核实） */
  readonly selfVerified: number
  /** 有值但不下结论 */
  readonly inconclusive: number
  /** 无值 */
  readonly unknown: number
  readonly total: number
  /** 覆盖率 `settled / total`（**不是可信度**，是「这一维能读的比例」） */
  readonly readableRate: number
  readonly needs: string[]
  readonly caveat: string
}

export interface CredibilityReport {
  /** 分母（与 `memory_catalog.gaps` 同一把尺子：`isCatalogable`） */
  readonly denominator: number
  readonly dimensions: CredDimensionReport[]
  /** 四维**全部** `settled` 的条目数（会很罕见，这是诚实的） */
  readonly allSettled: number
  /** 至少一维 `settled` 的条目数 */
  readonly anySettled: number
  /** 口径声明（不含总分、settled 不表示可信） */
  readonly note: string
}

function aggregateDimension(
  dimension: CredDimensionId,
  rows: readonly CredReading[],
): CredDimensionReport {
  const spec = DIMENSION_SPECS[dimension]
  const counts: Record<CredVerdict, number> = { settled: 0, selfVerified: 0, inconclusive: 0, unknown: 0 }
  for (const row of rows) counts[row.verdict] += 1
  const total = rows.length
  return {
    dimension,
    label: spec.label,
    fidelity: spec.fidelity,
    settled: counts.settled,
    selfVerified: counts.selfVerified,
    inconclusive: counts.inconclusive,
    unknown: counts.unknown,
    total,
    readableRate: total === 0 ? 0 : counts.settled / total,
    needs: spec.needs,
    caveat: spec.caveat,
  }
}

/**
 * 全库四维可信度读数。
 *
 * 分母与 `memory_catalog.gaps` **同一把尺子**（`isCatalogable`）——两个读数必须能并排比较，
 * 否则「字段完整率」与「可信度可读率」各自一套分母，差在哪不可见。
 */
export function credibilityReport(
  entries: readonly Entry[],
  options: CredOptions = {},
): CredibilityReport {
  const pool = entries.filter((entry) => isCatalogable(entry))
  const rows = pool.map((entry) => credibilityOf(entry, options))

  let allSettled = 0
  let anySettled = 0
  for (const row of rows) {
    const readings = [row.sourceReliability, row.extractionConfidence, row.verificationStatus, row.freshness]
    let settledCount = 0
    for (const reading of readings) {
      if (reading.verdict === 'settled') settledCount += 1
    }
    if (settledCount === readings.length) allSettled += 1
    if (settledCount > 0) anySettled += 1
  }

  return {
    denominator: pool.length,
    dimensions: CRED_DIMENSIONS.map((dimension) => {
      const dimensionRows = rows.map((row) => row[dimension])
      return aggregateDimension(dimension, dimensionRows)
    }),
    allSettled,
    anySettled,
    note:
      '不含总分（方案 §5.4 原话「可信度不能只有一个数字」）。`settled` 表示「这一维能下结论」，不表示「可信」；两维标 `fidelity=proxy`——读到的是外观（标了没有、可不可回核），不是方案要的那个评价。',
  }
}
