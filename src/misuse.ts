/**
 * R7 失效误用的**严格上限**与判定（v0.46 · 方案 §13.3）。
 *
 * ## 它补的是哪一格
 *
 * 方案对「已失效记忆的错误调用率」的要求是「持续降低并**设定严格上限**」
 * （`docs/plans/智能体记忆图书馆实施方案.md:1288`）。读数自 v0.19 就有（A 档 / B 档分层），
 * 但**上限那一半从未落地** ⇒ 这个数回答不了唯一该由它回答的问题：**现在算不算失控**。
 *
 * ## 两层口径，缺一层就会读错
 *
 * 1. **`includeArchive` 分层**：`memory_recall` 的 `includeArchive` 最终值是
 *    `args.includeArchive ?? wantsArchived`，而 `status: ['archived']` 这种查询**语义上就是
 *    「我要看归档的」**。这类返回被旧口径算进 A 档是假阳性——2026-11-19 实测：38 条 A 档里
 *    9 条来自同一次调用（全是会话压缩检查点）。**分不清「我要求看归档」与「系统把过时结论
 *    喂给我」，这个读数就不成立。**
 * 2. **通道分层**：`auto`（自动注入）与 `recall`（主动检索）的容忍度不同——auto 路径不经过
 *    我的判断，误用我无从察觉 ⇒ **零容忍**（`R7_AUTO_TOLERANCE`）。
 *
 * ## 三层上限（详见设计正本 `docs/design/aml-r7-cap.md`）
 *
 * - **C1 自动注入 = 0**：任何 1 条都是机制 bug。
 * - **C2 累计率 ≤ 0.40%**：基线 0.267% 的 3σ 泊松上界（λ=38, √λ=6.16 ⇒ 38+18.5=56.5 条）。
 *   故意设松：抓「翻倍」而不抓「波动」，抓波动是 C3 的职责。
 * - **C3 趋势**：7 天 / 30 天窗口对**冻结基线**做泊松检验——`k ≥ λ+3√λ` 红、`≥ λ+2√λ` 黄、
 *   `λ < 3` 不判（样本不足，**不伪装成健康**）。
 *
 * **为什么不用「连续 N 次读数上升」**：读数由我手动触发，不是等间隔采样 ⇒「连续 3 次」在
 * 两天里跑三次与三周里跑三次含义完全不同，且单次波动就打断链条。泊松检验有明确误报率，
 * 且不假设采样间隔。
 *
 * 纯函数层：不依赖 Cordis / fs，离线可测（`tests/misuse.test.mjs`）。
 * 消费面：`memory_misuse`（在线）与 `scripts/aml_scorecard.py`（离线），两处同源同口径。
 */

import type { Entry } from './types.ts'

/** 基线：2026-11-19 17:23 实测的 A 档 / 返回条目·次。**冻结**——动态基线会让检测随库变坏而变钝。 */
export const R7_BASELINE_NUMERATOR = 38
export const R7_BASELINE_DENOMINATOR = 14226
export const R7_BASELINE_RATE = R7_BASELINE_NUMERATOR / R7_BASELINE_DENOMINATOR
/** 基线取自哪一刻（写进读数，让未来能判断它该不该重标） */
export const R7_BASELINE_AT = '2026-11-19T17:23:00+08:00'

/** C2 累计率上限（= 基线 3σ 泊松上界 56.5/14226） */
export const R7_CUMULATIVE_CAP = 0.004

/** C1 自动注入通道容忍度（零容忍） */
export const R7_AUTO_TOLERANCE = 0

/** 泊松检验的最小期望：λ < 3 时分不清「真恶化」与「小样本噪声」 */
export const R7_MIN_LAMBDA = 3

/** 小样本兜底：λ 不足时，k ≥ 5 且率 > 4×基线仍报黄（弱信号，不是结论） */
export const R7_SMALL_SAMPLE_K = 5
export const R7_SMALL_SAMPLE_FACTOR = 4

/** 归档原因里「结论已不可用」的那几类（与 `aml_scorecard.py` 同口径） */
const DECIDED_REASONS: ReadonlySet<string> = new Set(['refuted', 'superseded', 'stale'])

/** 判定四态：`inconclusive` 不是 ok——**样本不足不等于健康** */
export type MisuseVerdict = 'ok' | 'warn' | 'breach' | 'inconclusive'

/** 一条用量轨迹记录（`access-trace.ts::AccessRecord` 的读侧形态） */
export interface MisuseRecord {
  readonly atMs: number
  readonly source: string
  readonly ids: readonly string[]
  /**
   * 这次调用是否**显式允许**返回归档条目。
   *
   * **三态**：`true` = 我要求看归档（该次返回不计入误用）· `false` = 不允许（返回归档即误用）·
   * `undefined` = **历史记录，不可分辨**（v0.46 之前写入的 3,541 行）。
   * 缺省不是 false——「不知道」与「不允许」是两件事。
   */
  readonly includeArchive?: boolean
}

export interface MisuseInput {
  readonly entries: readonly Entry[]
  readonly records: readonly MisuseRecord[]
  readonly now: number
}

export interface MisuseWindow {
  readonly label: 'all' | '30d' | '7d'
  /** 窗口起点（ms）；`all` 为 null（= trace 覆盖全时段） */
  readonly sinceMs: number | null
  /** 返回条目·次（分母口径：**不是调用次数**——一次调用返回 9 条算 9 次） */
  readonly returns: number
  /** 带 `includeArchive` 字段的记录贡献的返回次数（可分辨部分） */
  readonly resolvable: number
  /** 历史记录贡献的返回次数（不可分辨） */
  readonly unresolved: number
  /** A 档：返回那一刻结论已不能用，且**未显式要求看归档** */
  readonly tierA: number
  /** 显式要求看归档的返回（正常用法，**不进分子**） */
  readonly tierAExplicit: number
  /** B 档：返回时已过复查死线（设计上「到期不等于作废」，单列不算误用） */
  readonly tierB: number
  /** 返回之后才归档（时间线证明非误用） */
  readonly afterReturn: number
  /** 轨迹里的 id 已查不到 */
  readonly gone: number
  /** 自动注入通道的返回条目·次 */
  readonly autoReturns: number
  /** 自动注入通道的 A 档（零容忍） */
  readonly autoTierA: number
  /** 真误用率 = tierA / returns */
  readonly rate: number
  /** A 档构成（原因 → 条数） */
  readonly byReason: Readonly<Record<string, number>>
  /** 泊松期望 λ = returns × 基线 */
  readonly lambda: number
  /** 黄线（k 达到即 warn） */
  readonly warnAt: number | null
  /** 红线（k 达到即 breach） */
  readonly breachAt: number | null
  readonly verdict: MisuseVerdict
  /** 判定依据的一句话（越线时必须说清「该查什么」） */
  readonly verdictReason: string
}

export interface MisuseReport {
  readonly considered: {
    readonly records: number
    readonly returns: number
    readonly entries: number
    /** 全部记录都带 `includeArchive` ⇒ 分层是完整的 */
    readonly fullyResolvable: boolean
  }
  readonly baseline: {
    readonly numerator: number
    readonly denominator: number
    readonly rate: number
    readonly at: string
    readonly capRate: number
  }
  readonly windows: readonly MisuseWindow[]
  /** 最严重的判定（breach > warn > inconclusive > ok） */
  readonly verdict: MisuseVerdict
  readonly notes: readonly string[]
}

/** ISO 字符串或毫秒数 → ms（解析不出来返回 0）；与 `aml_scorecard.py::ms` 同口径 */
function toMs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

type Tier =
  | { kind: 'tierA'; reason: string }
  | { kind: 'explicit' }
  | { kind: 'tierB' }
  | { kind: 'afterReturn' }
  | { kind: 'gone' }
  | { kind: 'ok' }

/**
 * 单次返回的分层（**口径的唯一真源**）。
 *
 * 判据顺序即优先级：已被取代 > 已归档(结论类) > 事后归档 > 返回前已归档 > 过复查死线 > 正常。
 * 顺序不能换——`supersededBy` 与 `archived` 可能同时成立，此时「已被取代」是更具体的原因。
 *
 * @param entry - 返回时该 id 对应的条目；`undefined` = 已查不到
 * @param atMs - 该次返回的时刻
 * @param includeArchive - 该次调用是否显式允许归档（undefined = 不可分辨）
 */
export function classifyReturn(entry: Entry | undefined, atMs: number, includeArchive?: boolean): Tier {
  if (entry === undefined) return { kind: 'gone' }
  // 显式要求看归档 ⇒ 归档条目的返回是正常用法。但**已被取代**不受此豁免：
  // includeArchive 的语义是「包含已归档」，不是「包含已被新结论顶掉的」——
  // 后者在检索结果里出现，无论调用方要不要归档视图都是错的。
  if (includeArchive === true && entry.supersededBy === undefined) {
    if (entry.archived === true) return { kind: 'explicit' }
  }
  if (entry.supersededBy !== undefined && entry.supersededBy.length > 0) {
    return { kind: 'tierA', reason: '已被取代' }
  }
  if (entry.archived === true) {
    const reasonType = entry.archivedReasonType
    if (reasonType !== undefined && DECIDED_REASONS.has(reasonType)) {
      return { kind: 'tierA', reason: `已归档(${reasonType})` }
    }
    const archivedAt = toMs(entry.updatedAt)
    // 返回之后才归档：时间线证明当时它还是有效的（v1 把这类算成误用，报了 28.2% 的假数）
    if (archivedAt >= atMs) return { kind: 'afterReturn' }
    return { kind: 'tierA', reason: '返回前已归档' }
  }
  const reviewAt = toMs(entry.reviewAfter)
  if (reviewAt > 0 && reviewAt < atMs) return { kind: 'tierB' }
  return { kind: 'ok' }
}

/**
 * 泊松下判定：给定观测 k 与期望 λ，返回黄线 / 红线 / 判定。
 *
 * `λ < R7_MIN_LAMBDA` 时返回 `inconclusive`（或小样本兜底 warn）——**样本不足不等于健康**：
 * 报 ok 会让「什么都没测」看起来像「一切正常」，那正是读数层缺陷的经典形态。
 */
function judgeByPoisson(k: number, lambda: number, rate: number): {
  warnAt: number | null
  breachAt: number | null
  verdict: MisuseVerdict
  reason: string
} {
  if (lambda < R7_MIN_LAMBDA) {
    if (k >= R7_SMALL_SAMPLE_K && rate > R7_BASELINE_RATE * R7_SMALL_SAMPLE_FACTOR) {
      return {
        warnAt: R7_SMALL_SAMPLE_K,
        breachAt: null,
        verdict: 'warn',
        reason: `样本不足（λ=${lambda.toFixed(2)} < ${R7_MIN_LAMBDA}），但 k=${k} ≥ ${R7_SMALL_SAMPLE_K} 且率 ${(rate * 100).toFixed(2)}% > ${(R7_BASELINE_RATE * R7_SMALL_SAMPLE_FACTOR * 100).toFixed(2)}%——弱信号，不是结论`,
      }
    }
    return {
      warnAt: null,
      breachAt: null,
      verdict: 'inconclusive',
      reason: `样本不足（λ=${lambda.toFixed(2)} < ${R7_MIN_LAMBDA}）：分不清真恶化与小样本噪声，**不判为健康**`,
    }
  }
  const sigma = Math.sqrt(lambda)
  const breachAt = lambda + 3 * sigma
  const warnAt = lambda + 2 * sigma
  if (k >= breachAt) {
    return {
      warnAt,
      breachAt,
      verdict: 'breach',
      reason: `k=${k} ≥ 红线 ${breachAt.toFixed(1)}（λ=${lambda.toFixed(1)}，3σ）——统计上显著恶化（误报约 0.1%）`,
    }
  }
  if (k >= warnAt) {
    return {
      warnAt,
      breachAt,
      verdict: 'warn',
      reason: `k=${k} ≥ 黄线 ${warnAt.toFixed(1)}（λ=${lambda.toFixed(1)}，2σ）——超出基线波动，需关注`,
    }
  }
  return {
    warnAt,
    breachAt,
    verdict: 'ok',
    reason: `k=${k} < 黄线 ${warnAt.toFixed(1)}（λ=${lambda.toFixed(1)}）——在基线波动范围内`,
  }
}

const SEVERITY: Record<MisuseVerdict, number> = { ok: 0, inconclusive: 1, warn: 2, breach: 3 }

/** 最严重的判定 */
export function worstVerdict(verdicts: readonly MisuseVerdict[]): MisuseVerdict {
  let worst: MisuseVerdict = 'ok'
  for (const verdict of verdicts) if (SEVERITY[verdict] > SEVERITY[worst]) worst = verdict
  return worst
}

interface Bucket {
  returns: number
  resolvable: number
  unresolved: number
  tierA: number
  tierAExplicit: number
  tierB: number
  afterReturn: number
  gone: number
  autoReturns: number
  autoTierA: number
  byReason: Map<string, number>
}

function emptyBucket(): Bucket {
  return {
    returns: 0,
    resolvable: 0,
    unresolved: 0,
    tierA: 0,
    tierAExplicit: 0,
    tierB: 0,
    afterReturn: 0,
    gone: 0,
    autoReturns: 0,
    autoTierA: 0,
    byReason: new Map<string, number>(),
  }
}

function finalizeWindow(label: MisuseWindow['label'], sinceMs: number | null, bucket: Bucket): MisuseWindow {
  const rate = bucket.returns > 0 ? bucket.tierA / bucket.returns : 0
  const lambda = bucket.returns * R7_BASELINE_RATE
  const judged = judgeByPoisson(bucket.tierA, lambda, rate)
  const byReason: Record<string, number> = {}
  for (const [reason, count] of bucket.byReason) byReason[reason] = count

  // C1 优先于一切：自动注入通道零容忍——它是唯一一条「我看不到这次注入要求了什么」的路径
  if (bucket.autoTierA > R7_AUTO_TOLERANCE) {
    return {
      label,
      sinceMs,
      returns: bucket.returns,
      resolvable: bucket.resolvable,
      unresolved: bucket.unresolved,
      tierA: bucket.tierA,
      tierAExplicit: bucket.tierAExplicit,
      tierB: bucket.tierB,
      afterReturn: bucket.afterReturn,
      gone: bucket.gone,
      autoReturns: bucket.autoReturns,
      autoTierA: bucket.autoTierA,
      rate,
      byReason,
      lambda,
      warnAt: judged.warnAt,
      breachAt: judged.breachAt,
      verdict: 'breach',
      verdictReason: `自动注入通道出现 ${bucket.autoTierA} 条误用（容忍度 ${R7_AUTO_TOLERANCE}）——该路径不经过调用方判断，出现即机制 bug：查自动注入为什么产出归档条目`,
    }
  }

  // C2 只对累计口径生效：它是「存量债天花板」，抓翻倍不抓波动
  if (label === 'all' && rate > R7_CUMULATIVE_CAP) {
    return {
      label,
      sinceMs,
      returns: bucket.returns,
      resolvable: bucket.resolvable,
      unresolved: bucket.unresolved,
      tierA: bucket.tierA,
      tierAExplicit: bucket.tierAExplicit,
      tierB: bucket.tierB,
      afterReturn: bucket.afterReturn,
      gone: bucket.gone,
      autoReturns: bucket.autoReturns,
      autoTierA: bucket.autoTierA,
      rate,
      byReason,
      lambda,
      warnAt: judged.warnAt,
      breachAt: judged.breachAt,
      verdict: 'breach',
      verdictReason: `累计率 ${(rate * 100).toFixed(2)}% > 上限 ${(R7_CUMULATIVE_CAP * 100).toFixed(2)}%（基线 ${(R7_BASELINE_RATE * 100).toFixed(2)}% 的 3σ 上界）——存量债超红线`,
    }
  }

  return {
    label,
    sinceMs,
    returns: bucket.returns,
    resolvable: bucket.resolvable,
    unresolved: bucket.unresolved,
    tierA: bucket.tierA,
    tierAExplicit: bucket.tierAExplicit,
    tierB: bucket.tierB,
    afterReturn: bucket.afterReturn,
    gone: bucket.gone,
    autoReturns: bucket.autoReturns,
    autoTierA: bucket.autoTierA,
    rate,
    byReason,
    lambda,
    warnAt: judged.warnAt,
    breachAt: judged.breachAt,
    verdict: judged.verdict,
    verdictReason: judged.reason,
  }
}

/** 窗口定义：累计 / 30 天 / 7 天。三档并列是为了让「存量」与「近期」可分别判读。 */
const WINDOW_SPECS: ReadonlyArray<{ label: MisuseWindow['label']; days: number | null }> = [
  { label: 'all', days: null },
  { label: '30d', days: 30 },
  { label: '7d', days: 7 },
]

/**
 * 计算 R7 分层读数与三档上限判定（纯函数）。
 *
 * @param input.entries - 当前视野内的**全量**条目（含归档——归档状态是分层依据）
 * @param input.records - 逐条用量轨迹（`readAccessRecords` 的输出）
 * @param input.now - 判定时刻（窗口按它回溯）
 */
export function misuseReport(input: MisuseInput): MisuseReport {
  const byId = new Map<string, Entry>()
  for (const entry of input.entries) byId.set(entry.id, entry)

  const buckets = new Map<MisuseWindow['label'], Bucket>()
  for (const spec of WINDOW_SPECS) buckets.set(spec.label, emptyBucket())

  let totalReturns = 0
  let totalResolvable = 0
  for (const record of input.records) {
    const atMs = record.atMs
    const resolvable = record.includeArchive !== undefined
    for (const id of record.ids) {
      if (typeof id !== 'string' || id.length === 0) continue
      totalReturns += 1
      if (resolvable) totalResolvable += 1
      const tier = classifyReturn(byId.get(id), atMs, record.includeArchive)
      for (const spec of WINDOW_SPECS) {
        if (spec.days !== null && atMs < input.now - spec.days * 86_400_000) continue
        const bucket = buckets.get(spec.label)
        if (bucket === undefined) continue
        bucket.returns += 1
        if (resolvable) bucket.resolvable += 1
        else bucket.unresolved += 1
        if (record.source === 'auto') {
          bucket.autoReturns += 1
          if (tier.kind === 'tierA') bucket.autoTierA += 1
        }
        switch (tier.kind) {
          case 'tierA':
            bucket.tierA += 1
            bucket.byReason.set(tier.reason, (bucket.byReason.get(tier.reason) ?? 0) + 1)
            break
          case 'explicit':
            bucket.tierAExplicit += 1
            break
          case 'tierB':
            bucket.tierB += 1
            break
          case 'afterReturn':
            bucket.afterReturn += 1
            break
          case 'gone':
            bucket.gone += 1
            break
          case 'ok':
            break
        }
      }
    }
  }

  const windows = WINDOW_SPECS.map((spec) => {
    const bucket = buckets.get(spec.label) ?? emptyBucket()
    const sinceMs = spec.days === null ? null : input.now - spec.days * 86_400_000
    return finalizeWindow(spec.label, sinceMs, bucket)
  })

  const fullyResolvable = totalReturns > 0 && totalResolvable === totalReturns
  const notes: string[] = [
    `基线 P0 = ${R7_BASELINE_NUMERATOR}/${R7_BASELINE_DENOMINATOR} = ${(R7_BASELINE_RATE * 100).toFixed(3)}%（${R7_BASELINE_AT} 实测，**冻结**：动态基线会让检测随库变坏而变钝）`,
    `累计上限 ${(R7_CUMULATIVE_CAP * 100).toFixed(2)}% = 基线 3σ 泊松上界；它故意设松——抓「翻倍」，抓「波动」归滑窗（C3）`,
    `分母口径是**返回条目·次**，不是调用次数：一次调用返回 9 条算 9 次`,
    `A 档 = 返回那一刻结论已不能用（已被取代 / 已归档(refuted|superseded|stale) / 返回前已归档），且该次调用未显式要求看归档`,
    `B 档（过复查死线）单列不算误用：设计上「到期 ≠ 作废」（semantic.md §5.31）`,
    `「返回之后才归档」用 updatedAt 与轨迹 atMs 比先后证明，不计入`,
  ]
  if (!fullyResolvable) {
    notes.push(
      `⚠ **可分辨度**：${totalResolvable}/${totalReturns} 条返回记录的调用方带了 includeArchive（v0.46 起写入）——其余 ${totalReturns - totalResolvable} 条是历史记录，**分不清「要求看归档」与「真误用」**。分层结论只对可分辨部分成立；存量不回填（同 R1 事件级处理）。`,
    )
  }
  if (totalReturns === 0) {
    notes.push('⚠ trace 里没有任何返回记录 ⇒ 不是「零误用」，是**没有数据**（未接线或轨迹为空）。')
  }
  notes.push('A 档分子可能含我的验收探针（标题带「探针」「尸体测试」标记）——**不设特设过滤规则**（按标题匹配会腐烂），只在此披露。')

  return {
    considered: {
      records: input.records.length,
      returns: totalReturns,
      entries: input.entries.length,
      fullyResolvable,
    },
    baseline: {
      numerator: R7_BASELINE_NUMERATOR,
      denominator: R7_BASELINE_DENOMINATOR,
      rate: R7_BASELINE_RATE,
      at: R7_BASELINE_AT,
      capRate: R7_CUMULATIVE_CAP,
    },
    windows,
    verdict: worstVerdict(windows.map((window) => window.verdict)),
    notes,
  }
}
