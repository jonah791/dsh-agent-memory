/**
 * 事实生命周期维（v0.24.0）：这条结论**从何时开始为真**，以及**谁替代了谁**。
 *
 * ## 为什么有它（主人 2026-11-17 的诊断）
 *
 * 压缩摘要是**散文**：T1→T2→T3 的更新关系在压缩时会被抹平。库里已有五个时效字段
 * （`grounding` / `provenance` / `watchFor` / `reviewAfter` / `staleness`），仍然缺两格：
 *
 *   1. `validAfter`——「我什么时候**记下**的」（`createdAt`）与「这件事什么时候**开始为真**」
 *      是两个问题。主人的定调可能今天记下，而它针对的是上周的决定。少了这一格，
 *      时间线就只剩「写作时刻」，而写作时刻不是事实生效时刻。
 *   2. `supersededBy` / `supersedes`——「谁替代了谁」。现有的 `archivedReasonType:
 *      'superseded'` 只是**归档状态**（这条怎么没了），**不含对象**（被谁替代了）。
 *      于是「B 替代了 A」在库里只能靠正文散文表达，而散文正是压缩会抹平的东西。
 *
 * ## 三个字段的语义分工
 *
 *   - `validAfter`：这条结论**从何时开始成立**（`YYYY-MM-DD`）。**不给默认值**——
 *     省略 = 不知道，**不是**「等于 createdAt」。这是判据型字段（判断不代填）。
 *   - `supersededBy`：这条**被哪一条替代了**（单个 id，不是数组）。
 *   - `supersedes`：这条**替代了哪些**（id 列表）。
 *
 * ## 替代关系**只保留一层**（刻意设计，不是简化）
 *
 * A→B→C 是允许的（每层各记一格：`A.supersededBy=B`、`B.supersededBy=C`、
 * `C.supersedes=[B]`），但**不要求**把 C 的 `supersedes` 递归填成 `[A, B]`。
 * 理由：记忆库不是事件溯源库——完整版本树会让 recall 越跑越慢（每次命中都要展开链）、
 * 命中越排越散（同族多代同时占服务位）、旧值持续挤占注意力。**一层足够回答
 * 「我手上这条是不是最新的」**，而这是本维度唯一要回答的问题。
 *
 * ## 旧条目**绝不删除**
 *
 * 被替代的条目保留原 value 作对照——「以前用 diff，因为成本模型要 tick 尺度」这半句的
 * 价值就在旧值里。只标 `supersededBy`，**不归档、不删除、不隐藏**（recall 默认仍返回它，
 * 只是打上「⚠ 已过时」标记）。对照是它的全部价值。
 *
 * ## 两边都要写（本模块不负责写，只负责判据；写入在 `tools.ts::memory_supersede`）
 *
 * 新条目 `supersedes=[旧id]`、每个旧条目 `supersededBy=新id`，**同一次调用里两侧都写**。
 * 只写一侧会让审计查不到反向关系：「谁还在引用一条已被取代的结论」必须能从旧条目往新条目查。
 * ⇒ 这两个字段**唯一写入口是 `memory_supersede`**（`update` 工具不暴露它们）——
 * 单一写入点比「两处都记得写两侧」可靠。
 *
 * ## 与既有维度的关系（都与它们正交）
 *
 *   - `reviewAfter`（该重看）vs `validAfter`（何时开始为真）：一个向前看、一个向后看。
 *   - `archivedReasonType='superseded'`（归档状态）vs `supersededBy`（替代对象）：
 *     前者说「这条没了」，后者说「被谁顶掉了」——**不替代，互补**。
 *   - `provenance`（信息从哪来）vs `supersedes`（顶替了谁）：来源维 vs 演化维。
 *
 * 纯函数层：不依赖 Cordis / fs，离线可测（tests/succession.test.mjs）。
 */

import type { Entry } from './types.ts'
import { isoDate } from './temporal.ts'

/** 替代状态筛的可选值（`current` = 未被替代 / `superseded` = 已被替代） */
export const SUPERSESSION_FILTERS = ['current', 'superseded'] as const
export type SupersessionFilter = (typeof SUPERSESSION_FILTERS)[number]

/**
 * 一次替代最多覆盖多少条旧条目。
 *
 * 为什么要有上限：`supersedes` 会被**每个** recall 结果项带着（外加渲染），
 * 无上限意味着一条条目能把结果项撑成清单。32 足够覆盖「一次合并/一次重构顶掉一批」，
 * 再多就说明该用 `memory_merge`（合流）而不是逐个建立替代边。
 */
export const MAX_SUPERSEDES = 32

/** 条目 id 的长度上限（超了说明把描述塞进了 id——那是放错位置） */
const MAX_ID_LENGTH = 128

/** 控制字符 / 换行：出现在 id 里一定是放错了位置（会破坏渲染与日志行） */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const REL_RE = /^\+\d+[dw]$/
/** ISO 8601 日期时间的形态闸门（与 `temporal.ts::parseStoredDeadline` 同一条理由：
 *  **形态白名单优于引擎启发式**——`Date.parse` 连 `'Nov 1 2026'` 都收，那会让
 *  「什么算合法日期」出现第二个真源）。 */
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/

/**
 * 解析 `validAfter` 参数（**写入时**路径 · fail-loud）。
 *
 * 接受：`YYYY-MM-DD`（如 `2026-11-01`）/ ISO 时刻（如 `2026-11-01T09:00:00Z`，取 UTC 日）。
 * **不接受**相对写法（`+7d`）——见下方抛错理由。
 *
 * @throws 非法值一律抛错。**不静默当「不知道」**——静默降级正是本维度要防的失败
 *         （我以为记下了生效时间、其实没记 ⇒ 未来的我照旧把「写作时刻」当「生效时刻」）。
 */
export function parseValidAfterArg(raw: unknown, field = 'validAfter'): string | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') {
    throw new Error(`${field}: 必须是字符串（YYYY-MM-DD 或 ISO 时刻），实际类型 ${typeof raw}`)
  }
  const text = raw.trim()
  if (text.length === 0) return undefined

  // 相对写法在此**语义不通**，故单独给一条精确的报错（而不是让其落进「无法解析」）。
  // `reviewAfter` 收 `+7d` 是因为它是**未来**的死线；`validAfter` 答的是「何时开始为真」
  // ——要么已经发生（给日期），要么是未来的计划生效（也给日期，但那是排期不是相对推算）。
  // 若在这里接受 `+7d`，同一次写入隔天再写就会得到两个不同的「生效时间」。
  if (REL_RE.test(text)) {
    throw new Error(
      `${field}: 不接受相对写法 ${JSON.stringify(raw)}——本字段答「这条结论从何时开始成立」，`
      + '是既成事实（或明确排期），请给绝对日期 YYYY-MM-DD（如 2026-11-01）',
    )
  }

  if (DATE_RE.test(text)) {
    const parsed = Date.parse(`${text}T00:00:00.000Z`)
    if (!Number.isFinite(parsed)) throw new Error(`${field}: 日期不存在 ${text}`)
    // ⚠ JS 对 2026-02-30 这类不存在的日期会静默滚到下月（→ 3-02），
    // 只查 Number.isFinite 抓不住 ⇒ 回读比对，滚动了就抛（与 temporal 同一条尸体样本）。
    const roundTrip = isoDate(new Date(parsed))
    if (roundTrip !== text) throw new Error(`${field}: 日期不存在 ${text}（被解析成 ${roundTrip}）`)
    return text
  }

  if (ISO_DATETIME_RE.test(text)) {
    const parsed = Date.parse(text)
    if (Number.isFinite(parsed)) return isoDate(new Date(parsed))
    throw new Error(`${field}: ISO 时刻无法解析 ${JSON.stringify(raw)}`)
  }

  throw new Error(
    `${field}: 无法解析 ${JSON.stringify(raw)}——接受 YYYY-MM-DD（如 2026-11-01）`
    + ' 或 ISO 时刻（如 2026-11-01T09:00:00Z）。⚠ 不接受相对写法（+7d）',
  )
}

/** 容错归一（**服务通道**路径 · 不抛）——与 `normalizeReviewAfter` 对称。 */
export function normalizeValidAfter(raw: unknown): string | undefined {
  try {
    return parseValidAfterArg(raw)
  } catch {
    return undefined
  }
}

/**
 * 读取路径归一（**容错**）：认不出的历史值返回 `undefined`，不抛。
 *
 * 与 `parseValidAfterArg` 分流：**参数**是「我此刻的意图」（拼错必须当场知道），
 * **历史数据**是既成事实（读到脏值不该让整次检索崩掉，也不该渲染出 `[自 undefined 起]`）。
 */
export function parseStoredValidAfter(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const text = raw.trim()
  if (text.length === 0) return undefined
  if (DATE_RE.test(text)) {
    const parsed = Date.parse(`${text}T00:00:00.000Z`)
    if (!Number.isFinite(parsed)) return undefined
    return isoDate(new Date(parsed)) === text ? text : undefined
  }
  if (!ISO_DATETIME_RE.test(text)) return undefined
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? isoDate(new Date(parsed)) : undefined
}

/** 归一单个条目 id 的形状（**参数路径**：形状不合法即抛） */
function parseEntryId(raw: unknown, field: string): string {
  if (typeof raw !== 'string') throw new Error(`${field}: 条目 id 必须是字符串，实际类型 ${typeof raw}`)
  const text = raw.trim()
  if (text.length === 0) throw new Error(`${field}: 条目 id 不能为空`)
  if (text.length > MAX_ID_LENGTH) {
    throw new Error(`${field}: 条目 id 超过 ${MAX_ID_LENGTH} 字符（疑似把描述当成 id）`)
  }
  if (CONTROL_CHARS.test(text)) throw new Error(`${field}: 条目 id 含控制字符`)
  return text
}

/**
 * 解析 `supersedes` 参数（**写入时**路径 · fail-loud）。
 *
 * 接受单条字符串或字符串数组（只替代一条是最常见的情形）。去重保序。
 *
 * @throws 空列表 / 非字符串 / 超上限 —— 全部抛错。空列表**不许静默当无操作**：
 *         「我调了替代工具但什么都没写」与「写了」必须可区分（静默降级 = 假的成功回执）。
 */
export function parseSupersedesArg(raw: unknown, field = 'supersedes'): string[] {
  if (raw === undefined || raw === null) {
    throw new Error(`${field}: 必填——要替代哪些旧条目（至少 1 个 id）`)
  }
  const list: unknown[] = Array.isArray(raw) ? raw : [raw]
  const out: string[] = []
  for (const item of list) {
    const id = parseEntryId(item, field)
    if (!out.includes(id)) out.push(id)
  }
  if (out.length === 0) throw new Error(`${field}: 至少给 1 个被替代条目 id`)
  if (out.length > MAX_SUPERSEDES) {
    throw new Error(`${field}: 一次最多 ${MAX_SUPERSEDES} 个（实际 ${out.length}）——更多的请用 memory_merge 合流`)
  }
  return out
}

/**
 * 解析 `superseded` 过滤参数（读取路径 · fail-loud）。
 *
 * 取值：`current`（只看未被替代的）/ `superseded`（只看已被替代的）。缺省 = 不过滤。
 * ⚠ **缺省不过滤是刻意的**：已过时的条目**不默认隐藏**——对照是它的全部价值。
 * 本筛子是**审查入口**（「哪些结论已经被顶掉了」），不是降噪开关。
 */
export function parseSupersessionFilterArg(raw: unknown, field = 'superseded'): SupersessionFilter | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') {
    throw new Error(`${field}: 必须是字符串（${SUPERSESSION_FILTERS.join(' / ')}），实际类型 ${typeof raw}`)
  }
  const text = raw.trim().toLowerCase()
  if (text.length === 0) return undefined
  if (!(SUPERSESSION_FILTERS as readonly string[]).includes(text)) {
    throw new Error(`${field}: 未知取值 ${JSON.stringify(raw)}——合法值只有 ${SUPERSESSION_FILTERS.join(' / ')}`)
  }
  return text as SupersessionFilter
}

/** 条目是否已被替代（读取侧唯一判据：字段存在即已替代） */
export function isSuperseded(entry: { supersededBy?: unknown }): boolean {
  return typeof entry.supersededBy === 'string' && entry.supersededBy.trim().length > 0
}

/**
 * 替代状态筛（**可选筛子**）。
 *
 * ⚠ **零拷贝**：`mode` 未给时**原样返回同一数组引用**（不是「结果看起来一样」）——
 * 这是本维的零回归硬判据：存量无该字段的条目行为逐项不变（tests/succession.test.mjs A1）。
 */
export function filterBySuccession<T extends { supersededBy?: unknown }>(
  entries: T[],
  mode: SupersessionFilter | undefined,
): T[] {
  if (mode === undefined) return entries
  const wantSuperseded = mode === 'superseded'
  return entries.filter((entry) => isSuperseded(entry) === wantSuperseded)
}

/** id 缩短（渲染用）：前 8 位足够在一条结果行里定位，完整 id 仍可从工具结构里取 */
export function shortId(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const text = raw.trim()
  return text.length <= 8 ? text : text.slice(0, 8)
}

/**
 * 「已被替代」渲染标记（拼接用）——**本维度最重要的一个可见性承载**。
 *
 * 形状（主人 2026-11-17 定的规格）：「⚠ 已过时 → 被 <id前8位> 替代」。
 * 放在前缀**最前**：它比「已过期」（该重看）更硬——过期只表示该核实，
 * **替代表示这条结论已经有更新的版本顶掉它了**，照它做就是用旧值。
 *
 * @returns 标记；未替代 / 脏值 ⇒ 空串（标记要挑着打，不许渲染出 `[⚠ 被 undefined 替代]`）
 */
export function supersededByTag(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const text = raw.trim()
  if (text.length === 0) return ''
  return `[⚠ 已过时 → 被 ${shortId(text)} 替代]`
}

/**
 * 「从何时开始为真」渲染（拼接用）：无值 / 认不出 ⇒ 空串。
 *
 * 为什么印出来：`createdAt` 与 `validAfter` 可以差很远（今天记下、针对上周的决定）。
 * 只印 createdAt 会让读者把「写入时刻」当成「事实生效时刻」，这正是本字段要消除的歧义。
 */
export function validAfterTag(raw: unknown): string {
  const date = parseStoredValidAfter(raw)
  if (date === undefined) return ''
  return `[自 ${date} 起成立]`
}

/**
 * 「替代了谁」渲染（拼接用）：无值 / 空数组 ⇒ 空串。
 *
 * 与 `supersededByTag` 对称：那条答「我被谁顶掉了」，这条答「我顶掉了谁」。
 * 都印同一行（前 8 位）⇒ 在任意一侧命中都能立刻走到另一侧。
 */
export function supersedesTag(raw: unknown): string {
  if (!Array.isArray(raw)) return ''
  const ids = raw.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  if (ids.length === 0) return ''
  return ` → 替代了 ${ids.map((id) => shortId(id)).join(', ')}`
}

/** 计数（统计/体检用）：已替代条数 + 未替代条数 */
export function countSupersession(entries: readonly { supersededBy?: unknown }[]): {
  superseded: number
  current: number
} {
  let superseded = 0
  for (const entry of entries) if (isSuperseded(entry)) superseded += 1
  return { superseded, current: entries.length - superseded }
}

/** 类型守卫：给 `Entry` 用（避免调用方各写一遍 `typeof === 'string'`） */
export function supersessionOf(entry: Entry): { supersededBy?: string; supersedes?: string[]; validAfter?: string } {
  const out: { supersededBy?: string; supersedes?: string[]; validAfter?: string } = {}
  if (typeof entry.supersededBy === 'string' && entry.supersededBy.trim().length > 0) out.supersededBy = entry.supersededBy
  if (Array.isArray(entry.supersedes) && entry.supersedes.length > 0) out.supersedes = entry.supersedes
  const validAfter = parseStoredValidAfter(entry.validAfter)
  if (validAfter !== undefined) out.validAfter = validAfter
  return out
}
