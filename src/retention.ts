/**
 * 七类保留策略（v0.39 · 方案 §10.1）——让 `memType` 产生后果的**后置修正层**。
 *
 * ## 为什么存在（动机是实测出来的，不是把方案表格照抄一遍）
 *
 * 2026-11-19 实测：真分母 1770 条人工写入条目里 `memType` 覆盖率只有 **1.1%**，而
 * `aliases` 47.5% / `cue` 36.3% / `watchFor` 32.5%——分界**不是字段新旧**（v0.15 的
 * `aliases` 远高于 v0.26 的 `memType`），而是**填了有没有后果**：前三个直接改变检索命中，
 * `memType` 当时不改变任何行为。⇒ 本模块的职责不是「提醒人去填字段」，是**让填了改变什么**。
 *
 * ## 反定位：不动 `classify()`
 *
 * 基础四档（`audit.ts` §5.9）回答「这条值不值得继续占位置」，与类别无关。本层是它的
 * **后置修正**：先出基础档，再按类别决定要不要推向「更需要人看一眼」的方向。理由是可证伪性
 * ——「未分类条目逐字不变」只有在底层不动的前提下才可断言（判据 R3）。
 *
 * ## 三条硬约束
 *
 * 1. **只往更需要人看的方向推**：`KEEP` < `DEMOTE` < `ARCHIVE` < `REVIEW`，修正只在
 *    目标档严格更高时生效；**永不把 `REVIEW` / `ARCHIVE` 拉回 `KEEP`**。修正层提示节奏，
 *    不替我裁决安全。
 * 2. **`unknown` 零修正**：未分类条目原样返回（当前 98.9% 的条目走这条路径）。
 * 3. **不写库**：本模块是纯函数，不碰存储、不刷新 `accessedAt`。
 *
 * ## 推导不是补字段
 *
 * `effectiveMemType` 只在**读取口径**上给一个类别，**不写回条目**——存储里 `memType`
 * 仍为空。所以它不能用来「事后声称覆盖率达标」，只能用来让体检对全库做差异化。
 *
 * 纯函数层：不依赖 Cordis / fs，离线可测（tests/retention.test.mjs）。
 */

import type { AuditBucket, Entry, MemType, RetentionSummary } from './types.ts'
import { isMemType, MEM_TYPES } from './memType.ts'
import { expiryStateOf, parseStoredExpiry } from './temporal-dual.ts'

/** 形状的真源在 `types.ts`（`AuditResult.retention` 也要用它）；此处 re-export 便于本模块消费者 */
export type { RetentionSummary }

const DAY_MS = 86_400_000

/** 未分类在生效类别里的键名（**不是**一个可写入的 `memType` 取值） */
export const UNKNOWN_EFFECTIVE_TYPE = 'unknown'

/**
 * 条目年龄（天，非负）——**全库唯一口径**（`updatedAt ?? createdAt`）。
 *
 * 从 `audit.ts` 移到这里并反向导出：类别策略与基础分档必须用同一把尺子，否则同一条目在
 * 「基础档」与「类别修正」里会看到两个年龄，而差异不会报错、只会让档位对不上。
 */
export function ageDaysOf(entry: Entry, nowMs: number): number {
  const t = Date.parse(entry.updatedAt ?? entry.createdAt)
  if (Number.isNaN(t)) return 0
  return Math.max(0, (nowMs - t) / DAY_MS)
}

/** 生效类别从哪来——三档可辨，不猜 */
export type EffectiveTypeSource = 'explicit' | 'derived-from-kind' | 'unknown'

export const EFFECTIVE_TYPE_SOURCES: readonly EffectiveTypeSource[] = [
  'explicit', 'derived-from-kind', 'unknown',
]

export interface EffectiveMemType {
  /** 生效类别；`null` = 类未知（不是「未分类」这个类别） */
  readonly type: MemType | null
  readonly source: EffectiveTypeSource
}

/**
 * 计算条目的**生效类别**（回退口径）。
 *
 * 只有**语义同构**的两处允许从 `kind` 推导：
 * - `kind='episodic'` 与 `memType='episodic'` 是同一个词的两种写法；
 * - `kind='fact'`（事实）与 `semantic`（语义记忆）在方案 §3.1 的定义里指同一类东西。
 *
 * `kind='knowledge'` 可被语义 / 程序 / 运行 / 项目 / 关系五类中的任一类解释——**推不出就不推**。
 * 这与「判断型字段禁默认值」是同一条纪律：字段本身不造值，只把**读取口径**标出来源，
 * 让读的人知道哪些结论是推断、哪些是我写的。
 */
export function effectiveMemType(entry: Pick<Entry, 'memType' | 'kind'>): EffectiveMemType {
  if (isMemType(entry.memType)) return { type: entry.memType, source: 'explicit' }
  if (entry.kind === 'episodic') return { type: 'episodic', source: 'derived-from-kind' }
  if (entry.kind === 'fact') return { type: 'semantic', source: 'derived-from-kind' }
  return { type: null, source: 'unknown' }
}

/** 单类策略：方案 §10.1 那张表的可断言形态 */
export interface RetentionPolicy {
  /**
   * 衰减半衰期（天）；`null` = **永不衰减**。
   *
   * 不用 `0` 表达「永不衰减」——`0` 会被读成「立刻衰减到零」，而这两个意思相反。
   */
  readonly decayHalfLifeDays: number | null
  /** 方案原文的对应要求（写在这里，避免读代码时还要回翻方案） */
  readonly rationale: string
}

/**
 * 七类策略表。**参数是启发式先验，不是拟合值**（同 `audit.weights` 的纪律）。
 *
 * `decayHalfLifeDays` 本版**只用于理由行披露**（写进 `reasons` 供人核），
 * **不参与检索排序**——`semantic.md §5.25` 的教训（十余个独立旋钮全部证否）说明任何改
 * 排序的改动都必须单独取证。本条不搭车。
 */
export const RETENTION_POLICIES: Record<MemType, RetentionPolicy> = {
  episodic: {
    decayHalfLifeDays: 30,
    rationale: '根据历史价值、用户授权和保留政策决定（方案 §10.1）',
  },
  semantic: {
    decayHalfLifeDays: 180,
    rationale: '有效期内持续使用，失效后修订或归档（方案 §10.1）',
  },
  procedural: {
    decayHalfLifeDays: 120,
    rationale: '定期验证，工具和环境变化时重新评估（方案 §10.1）',
  },
  profile: {
    decayHalfLifeDays: null,
    rationale: '长期保存但允许用户纠正和撤回（方案 §10.1）',
  },
  project: {
    decayHalfLifeDays: 90,
    rationale: '按项目生命周期保存（方案 §10.1）',
  },
  relational: {
    decayHalfLifeDays: 120,
    rationale: '随实体及关系的变化更新（方案 §10.1）',
  },
  operational: {
    decayHalfLifeDays: 14,
    rationale: '结合工具版本和环境状态管理（方案 §10.1）',
  },
}

/** 类别修正的理由码（渲染与断言都用它，不用自由文本） */
export type RetentionReasonCode = 'E-decay' | 'S-expired' | 'P-verify' | 'F-hold' | 'O-stale'

export const RETENTION_REASON_CODES: readonly RetentionReasonCode[] = [
  'E-decay', 'S-expired', 'P-verify', 'F-hold', 'O-stale',
]

/** 各理由码对应的目标档（`F-hold` 由基础档触发，见 `applyRetentionPolicy`） */
const TARGET_BUCKET: Record<RetentionReasonCode, AuditBucket> = {
  'E-decay': 'DEMOTE',
  'S-expired': 'REVIEW',
  'P-verify': 'REVIEW',
  'F-hold': 'REVIEW',
  'O-stale': 'REVIEW',
}

/** 各理由码的人读文案（追加进 `reasons`；**只在档位真的被改时**出现） */
export const RETENTION_REASON_NOTES: Record<RetentionReasonCode, string> = {
  'E-decay':
    '类别修正 E-decay：情景记忆按历史价值衰减（半衰期 30 天，超过 90 天未更新）——先降级再看',
  'S-expired':
    '类别修正 S-expired：语义记忆已过失效时刻——应按「修订或归档」处理，不是继续当事实用',
  'P-verify':
    '类别修正 P-verify：程序记忆的复查死线已过——工具或环境可能变了，需重新验证',
  'F-hold':
    '类别修正 F-hold：用户画像类**永不被建议自动归档**（方案 §10.1「长期保存但允许用户纠正和撤回」）——交人裁决',
  'O-stale':
    '类别修正 O-stale：系统运行记忆超过 14 天且无观察条件——工具版本可能已变，需按环境重评',
}

/** 档位「更需要人看」的序（越大越需要动作） */
const BUCKET_RANK: Record<AuditBucket, number> = { KEEP: 0, DEMOTE: 1, ARCHIVE: 2, REVIEW: 3 }

export interface RetentionSignal {
  readonly code: RetentionReasonCode
  readonly policy: RetentionPolicy
}

/**
 * 条目**自身状态**触发的策略信号（与基础档无关）。
 *
 * 分离出来的理由：`memory_stats.needsAction` 要能报告「各类有多少条该看一眼」，
 * 而它不跑基础分档。若把「基础档为 KEEP」这类条件也塞进来，统计侧就得先复制一遍审计逻辑
 * ——那就是造第二把尺子。
 *
 * `F-hold` **不在此列**：画像类是否触发取决于基础档（是否已被建议归档/降级），
 * 而不是条目自身的时间状态。
 */
export function retentionSignal(
  entry: Entry,
  nowMs: number,
  type?: MemType | null,
): RetentionSignal | undefined {
  const eff = type === undefined ? effectiveMemType(entry).type : type
  if (eff === null) return undefined
  const policy = RETENTION_POLICIES[eff]
  const now = new Date(nowMs)

  if (eff === 'episodic') {
    // 情景记忆该褪色：超过 90 天仍在库里的，先降级而不是直接归档（归档是不可逆的动作面）。
    if (ageDaysOf(entry, nowMs) > 90) return { code: 'E-decay', policy }
    return undefined
  }

  if (eff === 'semantic') {
    // 只有**已失效**才触发；未设 expiry 是「不知道何时失效」，不是「还没失效」。
    if (expiryStateOf(entry.expiry, now) === 'expired') return { code: 'S-expired', policy }
    return undefined
  }

  if (eff === 'procedural') {
    // 有观察条件且复查死线已过 ⇒ 该重新验证。反向：不设 watchFor 的程序记忆没有验证锚点，
    // 拿时间催它只是噪音。
    const hasWatchFor = Array.isArray(entry.watchFor) && entry.watchFor.length > 0
    if (!hasWatchFor) return undefined
    const due = parseStoredExpiry(entry.reviewAfter)
    if (due !== undefined && due < nowMs) return { code: 'P-verify', policy }
    return undefined
  }

  if (eff === 'operational') {
    // 工具经验最快过期：14 天且没有观察条件（没写「什么会让它失效」）⇒ 按环境重评。
    const hasWatchFor = Array.isArray(entry.watchFor) && entry.watchFor.length > 0
    if (!hasWatchFor && ageDaysOf(entry, nowMs) > 14) return { code: 'O-stale', policy }
    return undefined
  }

  // project / relational / profile：本版无条目自身的触发条件（见 semantic.md §5.32 表）。
  return undefined
}

export interface RetentionVerdict {
  readonly bucket: AuditBucket
  readonly reasons: string[]
  /** 真的改了档才出现；未改档 ⇒ `undefined`（判据 R6：正常路径不噪音） */
  readonly applied?: RetentionReasonCode
}

/**
 * 在基础档上应用类别修正。
 *
 * 三条规则的**唯一实现点**：`unknown` 原样返回 · 目标档严格更高才生效 · 改档才加理由。
 * 第二、三条合起来保证「只往更需要人看的方向推」与「不噪音」是同一段代码的两种读法。
 */
export function applyRetentionPolicy(
  entry: Entry,
  base: { bucket: AuditBucket; reasons: string[] },
  nowMs: number,
): RetentionVerdict {
  const eff = effectiveMemType(entry)
  // R3 零修正：类未知的条目逐字保持基础档（含 reasons 的数组引用）。
  if (eff.source === 'unknown' || eff.type === null) {
    return { bucket: base.bucket, reasons: base.reasons }
  }

  let applied: RetentionReasonCode | undefined

  if (eff.type === 'profile' && (base.bucket === 'ARCHIVE' || base.bucket === 'DEMOTE')) {
    // 画像类永不被**建议**自动归档：基础档说「该归档/降级」，类别说「这类要长期留」，
    // 冲突交给裁决环节（REVIEW），不替任何一方赢。
    applied = 'F-hold'
  } else {
    applied = retentionSignal(entry, nowMs, eff.type)?.code
  }

  if (applied === undefined) return { bucket: base.bucket, reasons: base.reasons }

  const target = TARGET_BUCKET[applied]
  if (BUCKET_RANK[target] <= BUCKET_RANK[base.bucket]) {
    // 基础档已经比目标档更需要人看 ⇒ 不改档也不加理由（否则同一件事被说两遍）。
    return { bucket: base.bucket, reasons: base.reasons }
  }

  return { bucket: target, reasons: [...base.reasons, RETENTION_REASON_NOTES[applied]], applied }
}

/** 按生效类别计数：七类 + `unknown`（**之和 == 条目数**） */
export function countByEffectiveType(
  entries: ReadonlyArray<Pick<Entry, 'memType' | 'kind'>>,
): Record<MemType | typeof UNKNOWN_EFFECTIVE_TYPE, number> {
  const out = Object.fromEntries(
    [...MEM_TYPES, UNKNOWN_EFFECTIVE_TYPE].map((key) => [key, 0]),
  ) as Record<MemType | typeof UNKNOWN_EFFECTIVE_TYPE, number>
  for (const entry of entries) {
    const { type } = effectiveMemType(entry)
    out[type ?? UNKNOWN_EFFECTIVE_TYPE] += 1
  }
  return out
}

/** 按 `source` 计数（三档之和 == 条目数） */
export function countByEffectiveTypeSource(
  entries: ReadonlyArray<Pick<Entry, 'memType' | 'kind'>>,
): Record<EffectiveTypeSource, number> {
  const out: Record<EffectiveTypeSource, number> = {
    explicit: 0, 'derived-from-kind': 0, unknown: 0,
  }
  for (const entry of entries) out[effectiveMemType(entry).source] += 1
  return out
}

/** 各类「按自身状态该看一眼」的条数（`unknown` 不计——它没有类别节奏） */
export function countNeedsAction(
  entries: readonly Entry[],
  nowMs: number,
): Record<MemType, number> {
  const out = Object.fromEntries(MEM_TYPES.map((key) => [key, 0])) as Record<MemType, number>
  for (const entry of entries) {
    const sig = retentionSignal(entry, nowMs)
    if (sig !== undefined) {
      const { type } = effectiveMemType(entry)
      if (type !== null) out[type] += 1
    }
  }
  return out
}

/**
 * 保留策略读数（`memory_audit.retention` 与 `memory_stats.retention` 的**唯一实现**）。
 *
 * 两处共用它，是为了让「两个读数逐字段相等」成为可断言的事实（判据 R7）——
 * 各写一遍必然漂移，而漂移不会报错，只会让我看到两个都像真的数字。
 */
export function retentionSummary(entries: readonly Entry[], nowMs: number): RetentionSummary {
  return {
    byEffectiveType: countByEffectiveType(entries),
    bySource: countByEffectiveTypeSource(entries),
    needsAction: countNeedsAction(entries, nowMs),
  }
}
