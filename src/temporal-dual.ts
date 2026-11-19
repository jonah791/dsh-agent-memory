/**
 * 双时态（v0.38 · 方案 §9.3「建立时间维度管理」）——`occurredAt`（事件时间）+ `expiry`（失效时刻）。
 *
 * ## 它补的是哪两个缺口
 *
 * 方案要求每条有时效性的记忆至少记三个时间：发生时间（Valid Time）、进入系统的时间
 * （Transaction Time）、失效时间（Expiry Time）。本库里已有后者（`createdAt` / `updatedAt`）
 * 与 `validAfter`（适用起点，v0.24.0），缺两件：
 *
 * | 缺口 | 症状（可指认） |
 * |---|---|
 * | `occurredAt` | 追记上周的事时，`memory_browse` 的时间桶把它排在**今天**——「我何时记下」被当成「何时发生」。压缩摘要尤其会把这段关系抹平（v0.24 的同一诊断）。 |
 * | `expiry` | 「今天下午 3 点开会」这类条目过了 3 点仍被当有效。`reviewAfter` 救不了：它答「我该何时**重看**」，且文档明写「到期 ≠ 作废」——那是提醒维，不是事实维。 |
 *
 * ## 三条不可合并（本模块存在的全部理由，写在这里防止未来被「对齐」掉）
 *
 * 1. **`occurredAt` ≠ `validAfter`**：前者答「这件事何时发生」，后者答「这条结论从何时适用」。
 *    情景类记忆（`memType=episodic`）没有「生效」可言；语义类结论的核心是适用范围。
 *    ⇒ 两者是**不同 memType 的主轴**，不是同一轴的两个精度。
 * 2. **`expiry` ≠ `reviewAfter`**：一个事实维（到此时不再成立），一个提醒维（该何时重看）。
 *    两者可同时存在且日期不同：「12-31 失效，但 9-30 就该核实」。
 * 3. **`expiry` ≠ `supersededBy`**：一个「时间到了」，一个「被别人顶掉」。前者无替代者、不可追溯，后者有。
 *
 * ## 两条纪律
 *
 * - **存入与派生分开**：只存我给的日期/时刻；「是否已失效」由 `expiryStateOf` 按**此刻**现算
 *   （不预存档位——预存就与读取时刻脱钩，这是 `staleness` 已经踩过的坑）。
 * - **过期不改生命周期**：六态（§5.20）里没有「过期」这一态，也不该有——
 *   它是**读数**，不是状态迁移。处置（归档 / 删除）仍归人。
 *
 * 纯函数层：不依赖 Cordis / fs，离线可测（`tests/temporal-dual.test.mjs`）。
 */

import { DATE_RE, ISO_DATETIME_RE, isoDate } from './temporal.ts'

/** 失效状态三档（`unset` 单独成档：**「不知道」不是「有效」**） */
export type ExpiryState = 'active' | 'expired' | 'unset'

export const EXPIRY_STATES: readonly ExpiryState[] = ['active', 'expired', 'unset']

export const EXPIRY_LABELS: Record<ExpiryState, string> = {
  active: '有效',
  expired: '已失效',
  unset: '未设失效时间',
}

const REL_RE = /^\+(\d+)([dw])$/

/**
 * 写入侧解析（`occurredAt` 与 `expiry` 共用）。
 *
 * **与 `parseValidAfterArg` 刻意不同的一处**：本函数**原样保留 ISO 时刻**，而 `validAfter`
 * 一律取 UTC 日。理由：`occurredAt` 的价值常在分钟级（「11-15 21:00 定的架构」），
 * 而 `validAfter` 是既有契约（v0.24.0 已发布、存量按日期存），改它要动存量 ⇒ 不动。
 * 这个不对称写进语义文档 §5.31，不是疏漏。
 *
 * @param raw - 用户给的原始值
 * @param field - 字段名（报错用，如 `remember.occurredAt`）
 * @returns 归一化字符串（`YYYY-MM-DD` 或原样 ISO 时刻）；未给 / 空串 ⇒ `undefined`
 */
export function parseMomentArg(raw: unknown, field: string): string | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') {
    throw new Error(`${field}: 必须是字符串（YYYY-MM-DD 或 ISO 时刻），实际类型 ${typeof raw}`)
  }
  const text = raw.trim()
  if (text.length === 0) return undefined

  // 相对写法在这里语义不通：`occurredAt` 答「何时发生」（既成事实），
  // `expiry` 答「到何时失效」（一个确定的时刻）。若接受 `+7d`，同一份意图隔天再写
  // 会得到两个不同的时刻——那会让「这条何时失效」随写入日漂移。
  if (REL_RE.test(text)) {
    throw new Error(
      `${field}: 不接受相对写法 ${JSON.stringify(raw)}——本字段答一个确定的时刻，请给绝对日期 YYYY-MM-DD 或 ISO 时刻`,
    )
  }

  if (DATE_RE.test(text)) {
    const parsed = Date.parse(`${text}T00:00:00.000Z`)
    if (!Number.isFinite(parsed)) throw new Error(`${field}: 日期不存在 ${text}`)
    // JS 对 2026-02-30 会静默滚到下月 ⇒ 回读比对（与 temporal / succession 同一条尸体样本）
    const roundTrip = isoDate(new Date(parsed))
    if (roundTrip !== text) throw new Error(`${field}: 日期不存在 ${text}（被解析成 ${roundTrip}）`)
    return text
  }

  if (ISO_DATETIME_RE.test(text)) {
    const parsed = Date.parse(text)
    if (!Number.isFinite(parsed)) throw new Error(`${field}: 时刻无法解析 ${text}`)
    return text
  }

  throw new Error(`${field}: 无法解析 ${JSON.stringify(raw)}——接受 YYYY-MM-DD 或 ISO 时刻（如 2026-11-15T21:00:00+08:00）`)
}

/**
 * 读取侧解析**事件时刻**。
 *
 * 日期形态按**当日零点**（UTC）解释：`occurredAt=2026-11-15` 表示「事情发生在 11-15」，
 * 不是「11-15 结束前」。这与 `expiry` 的解释方向相反，是刻意的（见 `parseStoredExpiry`）。
 */
export function parseStoredOccurredAt(raw: unknown): number | undefined {
  if (typeof raw !== 'string') return undefined
  const text = raw.trim()
  if (text.length === 0) return undefined
  if (DATE_RE.test(text)) {
    const parsed = Date.parse(`${text}T00:00:00.000Z`)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  if (ISO_DATETIME_RE.test(text)) {
    const parsed = Date.parse(text)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/**
 * 读取侧解析**失效时刻**。
 *
 * 日期形态按**当日末刻**（UTC 23:59:59.999）解释：`expiry=2026-12-31` 表示「12-31 结束前仍然有效」。
 * 与 `reviewAfter` 同口径（`parseStoredDeadline` 也这样处理），否则「当天失效」会在一个函数里
 * 算已失效、在另一个里算还有效——同一判据两个真源。
 */
export function parseStoredExpiry(raw: unknown): number | undefined {
  if (typeof raw !== 'string') return undefined
  const text = raw.trim()
  if (text.length === 0) return undefined
  if (DATE_RE.test(text)) {
    const parsed = Date.parse(`${text}T23:59:59.999Z`)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  if (ISO_DATETIME_RE.test(text)) {
    const parsed = Date.parse(text)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/**
 * 失效状态（**派生**，按传入的 `now` 现算）。
 *
 * @param expiry - 条目的失效时刻
 * @param now - 当前时刻（测试可注入固定时钟，否则「已失效」会随时间漂移而无法断言）
 * @returns `expired`（已过）/ `active`（还没过）/ `unset`（没设——**不是「有效」**）
 */
export function expiryStateOf(expiry: unknown, now: Date): ExpiryState {
  const at = parseStoredExpiry(expiry)
  if (at === undefined) return 'unset'
  return now.getTime() > at ? 'expired' : 'active'
}

/**
 * 渲染标记（拼接用）：**只对已失效打标记**。
 *
 * 为什么不做「快失效」预告（与 `reviewAfter` 的 `due-soon` 不同）：`reviewAfter` 到期触发
 * 「去核实」这个动作，所以提前提醒有价值；而 `expiry` 临近**不改变它现在能不能用**
 * （能用就该用），预告只增加标记密度。既有教训：**标记要挑着打**，全打等于没打。
 *
 * @returns `'[⌛已失效]'` / `'[⌛已失效N天]'`；未失效或未设 ⇒ 空串
 */
export function expiryTag(expiry: unknown, now: Date): string {
  if (expiryStateOf(expiry, now) !== 'expired') return ''
  const at = parseStoredExpiry(expiry)
  if (at === undefined) return '[⌛已失效]'
  const days = Math.floor((now.getTime() - at) / 86_400_000)
  return days >= 1 ? `[⌛已失效${days}天]` : '[⌛已失效]'
}

/**
 * 事件时间渲染（拼接用）：只给**日期或时刻**本身，不加装饰。
 *
 * 为什么单独一个函数而不是直接印字段：`occurredAt` 与 `createdAt` 不同时，读者需要一眼看出
 * 「这条记的是哪一天的事」；相同时不印（否则每条都多一段噪音）。
 *
 * @returns `事件 2026-11-15` / 未设 ⇒ 空串
 */
export function occurredAtTag(occurredAt: unknown): string {
  if (typeof occurredAt !== 'string') return ''
  const text = occurredAt.trim()
  if (text.length === 0) return ''
  const at = parseStoredOccurredAt(text)
  if (at === undefined) return ''
  return `事件 ${text.length > 10 ? text.slice(0, 16).replace('T', ' ') : text}`
}

/** 三档计数（之和 == 条目数——**未设的条目也计入 `unset`**，不许被静默漏掉） */
export function countByExpiry(
  entries: ReadonlyArray<{ expiry?: string }>,
  now: Date,
): Record<ExpiryState, number> {
  const out: Record<ExpiryState, number> = { active: 0, expired: 0, unset: 0 }
  for (const entry of entries) out[expiryStateOf(entry.expiry, now)] += 1
  return out
}

/**
 * 按失效状态过滤（**可选筛子**，不是准入）。
 *
 * ⚠ 与 `staleness` 过滤**互不干扰**：那个筛「复查死线」，这个筛「内容失效」。
 * 两者可同时用（「已失效且该复查」是合法组合）。
 */
export function filterByExpiryState<T extends { expiry?: string }>(
  entries: T[],
  states: readonly ExpiryState[],
  now: Date,
): T[] {
  if (states.length === 0) return entries
  return entries.filter((entry) => states.includes(expiryStateOf(entry.expiry, now)))
}

/**
 * 区间校验：失效时刻**必须不早于**适用起点。
 *
 * 为什么 fail-loud 而不是静默接受：`expiry < validAfter` 意味着「这条结论从未有效过」——
 * 那几乎一定是笔误（或两个字段各自填了不同来源的日期）。静默接受会让一条永不生效的
 * 记录混进库里，而它看起来与正常条目完全一样。
 *
 * ⚠ 相等**允许**（当天生效当天失效是合法形态，如「今天下午的会议安排」）。
 *
 * @param expiry - 失效时刻（可省）
 * @param validAfter - 适用起点（可省）
 * @param field - 报错前缀
 */
export function assertExpiryOrder(expiry: unknown, validAfter: unknown, field = 'expiry'): void {
  const expiredAt = parseStoredExpiry(expiry)
  if (expiredAt === undefined) return
  if (typeof validAfter !== 'string' || validAfter.trim().length === 0) return
  const startAt = Date.parse(`${validAfter.trim()}T00:00:00.000Z`)
  if (!Number.isFinite(startAt)) return
  if (expiredAt < startAt) {
    throw new Error(
      `${field}: 失效时刻（${String(expiry)}）早于适用起点（${validAfter}）——`
      + '这条结论将从未有效过，几乎一定是笔误。区间为空不是「长期有效」',
    )
  }
}

/**
 * 过滤参数解析（`recall` / `memory_browse` 的 `expiryState`）。
 *
 * 与 `parseStalenessFilterArg` 同形（可选数组 + 非法值 fail-loud），但**不同维**：
 * 那个筛「复查死线」（提醒维），这个筛「内容是否已失效」（事实维）。两者可同时用。
 */
export function parseExpiryStateFilter(raw: unknown, field = 'expiryState'): ExpiryState[] | undefined {
  if (raw === undefined || raw === null) return undefined
  const list = Array.isArray(raw) ? raw : [raw]
  const out: ExpiryState[] = []
  for (const item of list) {
    if (typeof item !== 'string') throw new Error(`${field}: 必须是字符串数组（允许 ${EXPIRY_STATES.join(' / ')}）`)
    const text = item.trim()
    if (text.length === 0) continue
    if (!EXPIRY_STATES.includes(text as ExpiryState)) {
      throw new Error(`${field}: 未知取值 ${JSON.stringify(item)}（允许 ${EXPIRY_STATES.join(' / ')}）`)
    }
    if (!out.includes(text as ExpiryState)) out.push(text as ExpiryState)
  }
  return out.length > 0 ? out : undefined
}
