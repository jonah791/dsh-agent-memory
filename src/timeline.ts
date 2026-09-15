/**
 * 时间压缩线（IMPLEMENTATION.md §3 / DESIGN.md §五）
 *
 * 职责三件套：
 * 1. 时间桶算法：day（YYYY-MM-DD）/ week（ISO 8601 周，周一起，YYYY-Www）/
 *    month（YYYY-MM）/ year（YYYY），全部基于本地时区。
 * 2. 懒压缩触发：访问记忆时发现「上一自然单位已结束且有未压缩条目」→ 生成待压缩单位；
 *    压缩输入 = 该单位全部非归档原料条目，输出 = summary 条目（level/bucket/archiveRef），
 *    原条目冷归档（archived=true，保留不删，可 includeArchive 深挖）。
 * 3. 层级链：日概要（episodic 日条目总结）→ 周概要（7 个日概要再总结）→ 月概要（周概要再总结）→ 年概要（月概要再总结）；只作用于 L3 情景记忆，
 *    L1 事实 / L2 知识永不参与压缩（DESIGN.md §五）。
 *
 * 本模块不触碰 LLM：总结通过 SummarizeFn 注入（summarizer.ts 提供真实实现，
 * 离线测试注入 fake），保持纯逻辑可测。
 */

import type { MemoryConfig } from './types.ts'
import type { Entry, TimelineLevel } from './types.ts'
import type { MemoryStore } from './store.ts'
import { withKeyLock } from './lock.ts'
import type { CompressTraceEvent, CompressTraceSink } from './compress-trace.ts'

/** 压缩目标层级（金字塔：日概要 → 周概要 ← 日概要再总结 → 月概要 ← 周概要再总结 → 年概要 ← 月概要再总结） */
export type CompressionLevel = 'day' | 'week' | 'month' | 'year'

/**
 * 压缩单元互斥键（**唯一真源**）：任何需要串行化的调用点都从这里取，
 * 禁止各自拼字符串——键漂移 = 锁静默失效（两把不同的锁保护同一份资源）。
 * 粒度 = scope + 层级 + 桶：不同桶可并行压缩，同桶必须串行。
 */
export function compressUnitKey(scope: string, level: CompressionLevel, bucket: string): string {
  return `agent-memory:compress-unit:${scope}:${level}:${bucket}`
}

/** 待压缩单位：目标层级 + 目标时间桶（上一自然单位） */
export interface PendingCompression {
  level: CompressionLevel
  bucket: string
}

/** 时间桶范围：本地时区 [start, end) 开区间 + 人类可读标签 */
export interface BucketRange {
  start: Date
  end: Date
  label: string
}

/** 压缩调用入参（summarizer.ts / 测试 fake 共用契约） */
export interface SummarizeInput {
  /** 该单位全部非归档原料条目（快照） */
  entries: readonly Entry[]
  /** 目标概要层级 */
  level: CompressionLevel
  /** 目标时间桶（上一自然单位） */
  bucket: string
  /** 桶的时间范围（标题与提示词用） */
  range: BucketRange
  /** 周记模板（建议结构，来自 memory.yml weekly_template，可为空） */
  weeklyTemplate?: string
}

/** 总结函数：条目列表 → 概要正文（LLM 直调或测试 fake） */
export type SummarizeFn = (input: SummarizeInput) => Promise<string>

/** 单单位压缩结果 */
export interface CompressUnitResult {
  /** 生成的概要条目；跳过时为 null */
  summary: Entry | null
  /** 已归档的原料条目 id 列表 */
  archivedIds: string[]
  /** true = 本次未执行压缩 */
  skipped: boolean
  /** 结果原因：compressed | no-sources | already-summarized */
  reason: 'compressed' | 'no-sources' | 'already-summarized'
}

/** 层级显示名（概要标题用） */
const LEVEL_LABEL: Record<CompressionLevel, string> = {
  day: '日概要',
  week: '周概要',
  month: '月概要',
  year: '年概要',
}

/** 一昼夜毫秒数（bucket 计算用） */
const DAY_MS = 86_400_000

// ---------- 时间桶纯函数（本地时区） ----------

/** 本地时区日期 → 日桶键 YYYY-MM-DD */
export function dayBucket(date: Date): string {
  return fmtDate(date)
}

/**
 * 本地时区日期 → ISO 8601 周桶键 YYYY-Www（周一起算）。
 * 算法：取该日所在周的周四（ISO 周归属周）→ 该周四所在年即周属年 →
 * 周数 = ceil(周四年内天数 / 7)。边界正确：12 月末可能归次年 W01，
 * 1 月初可能归上年 W53。
 */
export function weekBucket(date: Date): string {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const weekdayOffset = (d.getDay() + 6) % 7 // 周一=0 … 周日=6
  const thursday = new Date(d)
  thursday.setDate(d.getDate() - weekdayOffset + 3)
  const weekYear = thursday.getFullYear()
  const jan1 = new Date(weekYear, 0, 1)
  const dayOfYear = Math.floor((thursday.getTime() - jan1.getTime()) / DAY_MS) + 1
  const week = Math.ceil(dayOfYear / 7)
  return `${weekYear}-W${String(week).padStart(2, '0')}`
}

/** 本地时区日期 → 月桶键 YYYY-MM */
export function monthBucket(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

/** 本地时区日期 → 年桶键 YYYY */
export function yearBucket(date: Date): string {
  return String(date.getFullYear())
}

/** 按层级取桶键（day/week/month/year 统一入口） */
export function bucketKey(level: TimelineLevel, date: Date): string {
  switch (level) {
    case 'day': return dayBucket(date)
    case 'week': return weekBucket(date)
    case 'month': return monthBucket(date)
    case 'year': return yearBucket(date)
  }
}

/**
 * 上一自然单位桶键（本地时区）：
 * - day：前一天；week：前 7 天（同星期几，保证跨年正确）；month：上一月；year：上一年
 */
export function previousBucketKey(level: TimelineLevel, date: Date): string {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  switch (level) {
    case 'day': {
      d.setDate(d.getDate() - 1)
      return dayBucket(d)
    }
    case 'week': {
      d.setDate(d.getDate() - 7)
      return weekBucket(d)
    }
    case 'month': {
      return monthBucket(new Date(d.getFullYear(), d.getMonth() - 1, 1))
    }
    case 'year': {
      return yearBucket(new Date(d.getFullYear() - 1, 0, 1))
    }
  }
}

/**
 * 桶键 → 本地时区时间范围 [start, end) + 人类可读标签。
 * week 桶解析用 ISO 周起算（第 1 周 = 含 1 月 4 日的周，周一起）。
 */
export function bucketRange(level: TimelineLevel, bucket: string): BucketRange {
  switch (level) {
    case 'day': {
      const [y, m, d] = parseDayBucket(bucket)
      const start = new Date(y, m - 1, d)
      return { start, end: addDays(start, 1), label: bucket }
    }
    case 'week': {
      const { year, week } = parseWeekBucket(bucket)
      const start = weekStart(year, week)
      const end = addDays(start, 7)
      return { start, end, label: `${bucket}（${fmtDate(start)} ~ ${fmtDate(addDays(end, -1))}）` }
    }
    case 'month': {
      const [y, m] = parseMonthBucket(bucket)
      const start = new Date(y, m - 1, 1)
      const end = new Date(y, m, 1)
      return { start, end, label: `${bucket}（${fmtDate(start)} ~ ${fmtDate(addDays(end, -1))}）` }
    }
    case 'year': {
      const y = parseYearBucket(bucket)
      const start = new Date(y, 0, 1)
      const end = new Date(y + 1, 0, 1)
      return { start, end, label: `${bucket}（${fmtDate(start)} ~ ${fmtDate(addDays(end, -1))}）` }
    }
  }
}

/**
 * 下级桶是否属于上级单位（压缩链归属判断）。
 * 以桶范围起点落入上级单位范围为准：周的归属取周一起点所在月（跨月周归入其开始的月）。
 */
export function bucketBelongsTo(
  level: TimelineLevel,
  bucket: string,
  upperLevel: TimelineLevel,
  upperBucket: string,
): boolean {
  const lower = bucketRange(level, bucket)
  const upper = bucketRange(upperLevel, upperBucket)
  return lower.start.getTime() >= upper.start.getTime() && lower.start.getTime() < upper.end.getTime()
}

// ---------- 原料匹配与懒压缩触发 ----------

/**
 * 该条目是否是指定目标层级的压缩原料（非归档）。
 * 金字塔链：day ← episodic 日条目；week ← day 概要（7 个日概要再总结）；
 * month ← week 概要；year ← month 概要。
 * fact / knowledge 永不参与（DESIGN.md §五：只作用于 L3 情景记忆）。
 */
function isSourceFor(entry: Entry, level: CompressionLevel, upperBucket: string): boolean {
  if (entry.archived) return false
  switch (level) {
    case 'day': {
      if (entry.kind !== 'episodic') return false
      const day = entry.bucket ?? dayBucket(new Date(entry.createdAt))
      return bucketBelongsTo('day', day, 'day', upperBucket)
    }
    case 'week': {
      if (entry.kind !== 'summary' || entry.level !== 'day') return false
      if (entry.bucket === null) return false
      return bucketBelongsTo('day', entry.bucket, 'week', upperBucket)
    }
    case 'month': {
      if (entry.kind !== 'summary' || entry.level !== 'week') return false
      if (entry.bucket === null) return false
      return bucketBelongsTo('week', entry.bucket, 'month', upperBucket)
    }
    case 'year': {
      if (entry.kind !== 'summary' || entry.level !== 'month') return false
      if (entry.bucket === null) return false
      return bucketBelongsTo('month', entry.bucket, 'year', upperBucket)
    }
  }
}

/**
 * 单个候选桶的判定（v0.8：把「为什么没压」变成一等结果）。
 * 语义 = 原 `findPendingCompressions` 里那串 `continue` 的**命名化**，判定优先级即短路顺序：
 * `not-ended`（单位未结束）→ `no-sources`（无未归档原料）→ `already-summarized`（已有同层概要）→ `pending`。
 */
export type CompressDecision = 'pending' | 'not-ended' | 'no-sources' | 'already-summarized'

/** 一个候选桶的判定行 */
export interface CompressVerdict {
  level: CompressionLevel
  bucket: string
  decision: CompressDecision
}

/**
 * 逐桶判定（**判据单一真源**）：扫描当前 scope 条目，对**每个候选桶**给出它在金字塔上的处境。
 *
 * 候选桶 = 所有条目的该层级桶 + 上一自然单位。
 * - day 层优先用条目自身 `bucket`（episodic/日概要落库时即日桶，可能与 createdAt 推算不一致）；
 *   上层（week/month/year）按 `createdAt` 推算归属桶（低层 summary 的 bucket 不是本层桶）。
 * - 不只上一单位：凡已结束（`range.end <= now`）且有原料、无同层概要的桶全部补压——
 *   历史缺口（如插件上线前的天）也能补齐，保证金字塔完整。
 * - 幂等：目标桶已存在同层级概要 → 不算待压缩（不重复压缩）。
 *
 * ⚠ 本函数是 `findPendingCompressions` 的**唯一实现来源**——后者只做过滤，
 * 禁止两处各自维护一套判定（§5.22 判据单一真源）。
 * @param entries - scope 全量条目（含归档，供幂等检查；通常为 `store.list(scope, {includeArchive:true})`）
 * @param config - 项目记忆配置（`timeline.*` 开关决定哪些层级启用）
 * @param now - 当前时刻（测试注入固定时刻）
 * @returns 判定行列表（按 日→周→月→年 顺序，层级内按候选桶发现顺序）
 */
export function explainCompressions(
  entries: readonly Entry[],
  config: MemoryConfig,
  now: Date = new Date(),
): CompressVerdict[] {
  const verdicts: CompressVerdict[] = []
  const levels: CompressionLevel[] = ['day', 'week', 'month', 'year']
  for (const level of levels) {
    if (!config.timeline[level]) continue
    const candidates = new Set<string>()
    for (const entry of entries) {
      if (level === 'day' && typeof entry.bucket === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry.bucket)) {
        candidates.add(entry.bucket) // 仅日桶格式（episodic/日概要）；周/月/年概要的 bucket 不是日桶
        continue
      }
      const d = new Date(entry.createdAt)
      if (isFinite(d.getTime())) candidates.add(bucketKey(level, d))
    }
    candidates.add(previousBucketKey(level, now))
    for (const bucket of candidates) {
      verdicts.push({ level, bucket, decision: judgeBucket(entries, level, bucket, now) })
    }
  }
  return verdicts
}

/** 单桶判定（短路顺序 = 判定优先级，见 `CompressDecision`） */
function judgeBucket(
  entries: readonly Entry[],
  level: CompressionLevel,
  bucket: string,
  now: Date,
): CompressDecision {
  // 只压「已结束」单位：桶范围终点 <= now；当前单位未结束不动（条目仍可能追加）
  const range = bucketRange(level, bucket)
  if (range.end.getTime() > now.getTime()) return 'not-ended'
  const hasSources = entries.some((entry) => isSourceFor(entry, level, bucket))
  if (!hasSources) return 'no-sources'
  const already = entries.some(
    (entry) => entry.kind === 'summary' && entry.level === level && entry.bucket === bucket,
  )
  if (already) return 'already-summarized'
  return 'pending'
}

/**
 * 懒压缩触发：从逐桶判定里取出待压缩单位（**只做过滤，不重写判据**）。
 * - 层级顺序 day→week→month→year：compressPending 循环调用，链式原料就绪。
 * @param entries - scope 全量条目（含归档）
 * @param config - 项目记忆配置
 * @param now - 当前时刻（测试注入固定时刻）
 * @returns 待压缩单位列表（按 日→周→月→年 顺序）
 */
export function findPendingCompressions(
  entries: readonly Entry[],
  config: MemoryConfig,
  now: Date = new Date(),
): PendingCompression[] {
  return explainCompressions(entries, config, now)
    .filter((v) => v.decision === 'pending')
    .map((v) => ({ level: v.level, bucket: v.bucket }))
}

// ---------- 压缩执行（TimelineCompressor） ----------

/**
 * 时间压缩器：把「上一自然单位的原料条目」压缩为概要条目并冷归档原料。
 * 依赖注入：store（T1 存储层）+ config（T2 配置）+ summarize（summarizer.ts 或测试 fake）
 * + `trace`（v0.8 证据层，**可选**：不给即完全不落轨迹，行为零差异——零回归硬约束）。
 */
export class TimelineCompressor {
  constructor(
    private readonly store: MemoryStore,
    private readonly config: MemoryConfig,
    private readonly summarize: SummarizeFn,
    private readonly trace?: CompressTraceSink,
  ) {}

  /** 交出一条轨迹事件（接收器自身吞错；本方法不做任何判定、不改任何状态） */
  private emit(event: CompressTraceEvent): void {
    this.trace?.(event)
  }

  /**
   * 压缩指定单位（**并发安全入口**）：按 (scope, level, bucket) 串行执行。
   *
   * 为什么必须加锁（2026-09-13 生产事故）：两个入口各建一个本类实例——懒压缩钩子（访问记忆时）
   * 与周期补压（定时轮询）。下面的临界区「查已有概要 → await LLM 总结 → 写入」中间横着一次
   * LLM 往返，第二个调用者能穿过同一道检查 → 同一桶写出两份概要（生产库实测 4 对重复日桶，
   * 每对代价 = 一次重复的 LLM 调用 + 一份重复归档）。锁语义与边界见 lock.ts。
   */
  async compressUnit(scope: string, level: CompressionLevel, bucket: string): Promise<CompressUnitResult> {
    return withKeyLock(compressUnitKey(scope, level, bucket), () =>
      this.compressUnitLocked(scope, level, bucket),
    )
  }

  /**
   * 压缩指定单位的临界区实现（调用者已持锁）：收集原料 → LLM 总结 → 写 summary 条目（含 archiveRef）→ 原料冷归档。
   * 幂等：目标桶已有同层级概要 → 跳过；无原料 → 跳过。
   */
  private async compressUnitLocked(scope: string, level: CompressionLevel, bucket: string): Promise<CompressUnitResult> {
    const all = this.store.list(scope, { includeArchive: true })

    // 幂等：该桶已有同层级概要
    const existing = all.find((e) => e.kind === 'summary' && e.level === level && e.bucket === bucket)
    if (existing !== undefined) {
      return { summary: null, archivedIds: [], skipped: true, reason: 'already-summarized' }
    }

    // 原料：该单位全部非归档条目
    const sources = all.filter((e) => isSourceFor(e, level, bucket))
    if (sources.length === 0) {
      return { summary: null, archivedIds: [], skipped: true, reason: 'no-sources' }
    }

    // LLM 直调总结（summarizer.ts 实现 / 测试 fake）
    const range = bucketRange(level, bucket)
    const text = await this.summarize({
      entries: sources,
      level,
      bucket,
      range,
      weeklyTemplate: this.config.weeklyTemplate,
    })
    if (text.trim().length === 0) {
      throw new Error(`时间压缩失败：${level} ${bucket} 总结产出为空`)
    }

    // 写前复核（2026-09-13）：进程内锁已经串行化，但多实例共享同一 DSH_HOME 时（并行会话是常态工况），
    // 另一进程可能在这段 LLM 往返期间已写入本桶概要——重复概要一旦落库只能人工去重，
    // 故**写入之前**再读一次（必须早于下面的 remember，写在之后就会命中自己刚写的那份、
    // 导致原料永不归档）；已存在即让位，不写不归档（幂等优先于「我这份更好」）。
    const fresh = this.store.list(scope, { includeArchive: true })
    const raced = fresh.find((e) => e.kind === 'summary' && e.level === level && e.bucket === bucket)
    if (raced !== undefined) {
      return { summary: raced, archivedIds: [], skipped: true, reason: 'already-summarized' }
    }

    // 概要条目：标题 = 层级 + 时间范围；正文 = 自动元数据头 + LLM 正文；archiveRef = 原料 id
    const tags = [...new Set(sources.flatMap((e) => e.tags))].slice(0, 32)
    const created = await this.store.remember({
      kind: 'summary',
      title: `${LEVEL_LABEL[level]} ${range.label}`,
      body: `> 时间范围：${range.label} · 来源 ${sources.length} 条

${text}`,
      tags,
      scope,
      level,
      bucket,
      source: { reason: `时间压缩：${level} ${bucket}，覆盖 ${sources.length} 条原料` },
      archiveRef: sources.map((e) => e.id),
    })

    // 原料冷归档（保留不删，可 includeArchive 深挖）；reason 记录溯源
    const archivedIds: string[] = []
    for (const source of sources) {
      await this.store.forget(scope, source.id, `已压缩入概要 ${created.id}（${level} ${bucket}）`)
      archivedIds.push(source.id)
    }

    const summary = this.store.get(scope, created.id)
    return { summary: summary ?? null, archivedIds, skipped: false, reason: 'compressed' }
  }

  /**
   * 懒压缩入口：扫描待压缩单位并逐个压缩（访问记忆时调用一次）。
   * 循环直到无待压缩：day 概要生成 → 归档日条目 → 下一轮 week 才能看到 day 概要原料，
   * 周 → 月 → 年 链式推进；每轮至少压一个单位否则退出（幂等有界）。
   *
   * v0.8 证据层：**首轮**落一条 `scan`（候选桶数 + 待压数 + 非待压判定分布 + 逐桶样本
   * ⇒ 直接回答「为什么偏偏这个桶没压」），每个单元落一条 `unit`，收尾落一条 `end`，
   * 异常落 `error` 后**原样上抛**（只加观测，不改控制流）。
   * 只在首轮记 scan：后续轮是链式推进的中间态，会掩盖「本轮扫描到底看到了什么」的全貌。
   */
  async compressPending(scope: string, now: Date = new Date()): Promise<CompressUnitResult[]> {
    const results: CompressUnitResult[] = []
    const startedAt = Date.now()
    let scanned = false
    for (;;) {
      const all = this.store.list(scope, { includeArchive: true })
      const verdicts = explainCompressions(all, this.config, now)
      const pending = verdicts.filter((v) => v.decision === 'pending')
      if (!scanned) {
        scanned = true
        const skipped: Record<string, number> = {}
        for (const v of verdicts) {
          if (v.decision === 'pending') continue
          skipped[v.decision] = (skipped[v.decision] ?? 0) + 1
        }
        this.emit({
          scope,
          phase: 'scan',
          candidates: verdicts.length,
          pending: pending.length,
          skipped,
          sample: verdicts.map((v) => `${v.level} ${v.bucket} ${v.decision}`),
        })
      }
      if (pending.length === 0) break
      for (const p of pending) {
        const unitStarted = Date.now()
        try {
          const result = await this.compressUnit(scope, p.level, p.bucket)
          results.push(result)
          this.emit({
            scope,
            phase: 'unit',
            level: p.level,
            bucket: p.bucket,
            reason: result.reason,
            archived: result.archivedIds.length,
            chars: result.summary?.body.length ?? 0,
            durMs: Date.now() - unitStarted,
          })
        } catch (error) {
          this.emit({
            scope,
            phase: 'error',
            level: p.level,
            bucket: p.bucket,
            message: (error as Error).message,
            durMs: Date.now() - unitStarted,
          })
          throw error
        }
      }
    }
    this.emit({
      scope,
      phase: 'end',
      units: results.filter((r) => r.reason === 'compressed').length,
      totalMs: Date.now() - startedAt,
    })
    return results
  }
}

// ---------- 解析与格式化辅助 ----------

/** 本地日期 → YYYY-MM-DD */
function fmtDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 加天数（本地日期运算，跨月/跨年由 Date 自动进位） */
function addDays(d: Date, days: number): Date {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  out.setDate(out.getDate() + days)
  return out
}

/** ISO 周 → 该周周一（本地时区）。第 1 周 = 含 1 月 4 日的周 */
function weekStart(year: number, week: number): Date {
  const jan4 = new Date(year, 0, 4)
  const jan4Offset = (jan4.getDay() + 6) % 7
  const start = new Date(year, 0, 4 - jan4Offset)
  start.setDate(start.getDate() + (week - 1) * 7)
  return start
}

/** 'YYYY-MM-DD' → [年, 月, 日]（非法格式 fail loud） */
function parseDayBucket(bucket: string): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(bucket)
  if (m === null) throw new Error(`非法日桶键：${bucket}`)
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** 'YYYY-Www' → { year, week }（非法格式 fail loud） */
function parseWeekBucket(bucket: string): { year: number; week: number } {
  const m = /^(\d{4})-W(\d{2})$/.exec(bucket)
  if (m === null) throw new Error(`非法周桶键：${bucket}`)
  const week = Number(m[2])
  if (week < 1 || week > 53) throw new Error(`非法周桶键（周数越界）：${bucket}`)
  return { year: Number(m[1]), week }
}

/** 'YYYY-MM' → [年, 月]（非法格式 fail loud） */
function parseMonthBucket(bucket: string): [number, number] {
  const m = /^(\d{4})-(\d{2})$/.exec(bucket)
  if (m === null) throw new Error(`非法月桶键：${bucket}`)
  return [Number(m[1]), Number(m[2])]
}

/** 'YYYY' → 年（非法格式 fail loud） */
function parseYearBucket(bucket: string): number {
  const m = /^(\d{4})$/.exec(bucket)
  if (m === null) throw new Error(`非法年桶键：${bucket}`)
  return Number(m[1])
}
