/**
 * 生命周期六态（v0.27.0 · 方案 §3.3）——一条记忆**现在处于什么状态**。
 *
 * ## 为什么存储只补两态
 *
 * 六态里有三态**已有载体**，而且那些载体被别处共同使用：
 * - `archived` ← `archived: true`（压缩链、检索默认剔除、统计、渲染都在读它）
 * - `superseded` ← `supersededBy`（§5.16 契约，`recall` 打过时标记）
 * - `deleted` ← `archivedReasonType: 'deleted'`（"为什么没了"这一格本来就答得出来）
 *
 * 只有 `pending`（待审核）与 `disputed`（存疑）**没有任何字段能表达** ⇒ 存储层
 * 只加 `status` 两值。若把六态整体存成新字段，同一件事就有两个真源，
 * 不同步时无人能判哪个对（压缩链写 `archived`、update 写 `status`，谁赢？）。
 *
 * ## 一个判断入口
 *
 * `lifecycleOf(entry)` 是**唯一**读法，优先级：
 * `deleted > archived > superseded > disputed > pending > active`。
 * 优先级是**判断**，不是巧合：
 * - `deleted` 高于 `archived`：用户删掉它是**意图**，「退役」只是时间线；
 * - `archived` 高于 `superseded`：已归档条目连「被谁取代」都只是历史，先按不可用读；
 * - `superseded` 高于 `disputed`：已有新版本顶掉它，就不必再争它存疑与否。
 *
 * ## 各态的行为（不写清等于字段是死的）
 *
 * | 态 | 默认检索 | 注入 | 渲染标记 |
 * |----|---------|------|---------|
 * | active | 可见 | 可注入 | 无 |
 * | pending | 可见（显式召回） | **不注入** | `⏳待审` |
 * | disputed | 可见 | 可注入 | `❓存疑` |
 * | superseded | 可见 | 可注入（带过时标记） | 由 `supersededByTag` 给 |
 * | archived | 默认剔除 | 不注入 | 由 `archiveReasonTag` 给 |
 * | deleted | 默认剔除 | 不注入 | `🗑已删` |
 *
 * `pending` 不进注入是本模块存在的第一条行为理由：注入是**未经请求**到达上下文的内容，
 * 候选区还没过审核就自己挤进去，等于跳过了候选区这个设计本身；显式召回是请求，那时该看见它。
 *
 * `disputed` **不算「已失效」**：它是设计内的存疑，不是过时。R7 的误用口径
 * （A 档 = 返回时结论已不能用）不把它计入——否则「我特意标了存疑」会被自己的仪器罚一次。
 *
 * 纯函数层：不依赖 Cordis / fs，离线可测（tests/lifecycle.test.mjs）。
 */

import type { Entry, EntryStatus, LifecycleState } from './types.ts'

/** 可写入 `status` 的取值（**只有两态**——其余四态走既有载体，见文件头） */
export const STORED_STATUSES: readonly EntryStatus[] = ['pending', 'disputed']

/** 六态（统计与过滤的取值域，顺序 = 方案 §3.3 的列举顺序） */
export const LIFECYCLE_STATES: readonly LifecycleState[] = [
  'pending', 'active', 'disputed', 'superseded', 'archived', 'deleted',
]

/** 中文标签（统计与提示用） */
export const LIFECYCLE_LABELS: Record<LifecycleState, string> = {
  pending: '待审核',
  active: '有效',
  disputed: '存疑',
  superseded: '已被取代',
  archived: '已归档',
  deleted: '已删除',
}

/** 渲染标记——**只给没有专属标记的三态**（superseded / archived 由既有 tag 渲染） */
const LIFECYCLE_TAGS: Partial<Record<LifecycleState, string>> = {
  pending: '⏳待审',
  disputed: '❓存疑',
  deleted: '🗑已删',
}

/** 容错别名表（**只用于读取历史数据**；参数入口 fail-loud） */
const STATUS_ALIASES: Readonly<Record<string, EntryStatus>> = {
  pending: 'pending',
  待审核: 'pending',
  待审: 'pending',
  候选: 'pending',
  disputed: 'disputed',
  存疑: 'disputed',
  有争议: 'disputed',
}

/** 归一为可写入的状态值；`undefined` = 常态（或认不出的值） */
export function normalizeStatus(raw: unknown): EntryStatus | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (trimmed.length === 0) return undefined
  const lower = trimmed.toLowerCase()
  if ((STORED_STATUSES as readonly string[]).includes(lower)) return lower as EntryStatus
  return STATUS_ALIASES[trimmed] ?? STATUS_ALIASES[lower]
}

/** 是否为可写入的状态值 */
export function isStoredStatus(value: unknown): value is EntryStatus {
  return typeof value === 'string' && (STORED_STATUSES as readonly string[]).includes(value)
}

/** 是否为六态之一 */
export function isLifecycleState(value: unknown): value is LifecycleState {
  return typeof value === 'string' && (LIFECYCLE_STATES as readonly string[]).includes(value)
}

/**
 * 工具参数入口（**fail-loud**）：只接受两态；`active` 也接受（= 清除，语义是「审核通过」）。
 * @param raw - 工具参数原值
 * @param field - 报错里用的字段名
 */
export function parseStatusArg(raw: unknown, field = 'status'): EntryStatus | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') {
    throw new Error(`${field}: 必须是字符串（${STORED_STATUSES.join(' / ')}；空串 = 清除回常态），实际类型 ${typeof raw}`)
  }
  const trimmed = raw.trim()
  if (trimmed.length === 0) return undefined
  if (trimmed.toLowerCase() === 'active') return undefined
  const normalized = normalizeStatus(trimmed)
  if (normalized === undefined) {
    throw new Error(
      `${field}: 未知取值 ${JSON.stringify(raw)}——可写入的只有 ${STORED_STATUSES.join(' / ')}`
      + `（其余四态由既有载体表达：superseded=supersededBy / archived=archived / deleted=archivedReasonType）`,
    )
  }
  return normalized
}

/**
 * 生命周期过滤参数（数组，**fail-loud**；接受六态名）。
 * @param raw - 工具参数原值（字符串或字符串数组）
 * @param field - 报错里用的字段名
 */
export function parseLifecycleFilterArg(raw: unknown, field = 'status'): LifecycleState[] | undefined {
  if (raw === undefined || raw === null) return undefined
  const list = Array.isArray(raw) ? raw : [raw]
  const out: LifecycleState[] = []
  for (const item of list) {
    if (typeof item !== 'string') {
      throw new Error(`${field}: 每项必须是字符串（${LIFECYCLE_STATES.join(' / ')}），实际类型 ${typeof item}`)
    }
    const trimmed = item.trim().toLowerCase()
    if (trimmed.length === 0) continue
    if (!isLifecycleState(trimmed)) {
      throw new Error(`${field}: 未知取值 ${JSON.stringify(item)}——合法值只有 ${LIFECYCLE_STATES.join(' / ')}`)
    }
    if (!out.includes(trimmed)) out.push(trimmed)
  }
  return out.length > 0 ? out : undefined
}

/**
 * **六态的唯一读取入口**。
 * @param entry - 任意条目（只读四个字段：status / archived / archivedReasonType / supersededBy）
 * @returns 该条目当前所处的态
 */
export function lifecycleOf(
  entry: Pick<Entry, 'status' | 'archived' | 'archivedReasonType' | 'supersededBy'>,
): LifecycleState {
  const archived = entry.archived === true || (entry.archived as unknown) === 'true'
  if (archived && entry.archivedReasonType === 'deleted') return 'deleted'
  if (archived) return 'archived'
  if (typeof entry.supersededBy === 'string' && entry.supersededBy.length > 0) return 'superseded'
  if (entry.status === 'disputed') return 'disputed'
  if (entry.status === 'pending') return 'pending'
  return 'active'
}

/** 按六态筛条目（`undefined` = 不过滤，原样返回同一数组引用） */
export function filterByLifecycle(entries: Entry[], states: LifecycleState[] | undefined): Entry[] {
  if (states === undefined) return entries
  return entries.filter((entry) => states.includes(lifecycleOf(entry)))
}

/** 六态计数（memory_stats 用）：**之和 == 总数** */
export function countByLifecycle(
  entries: readonly Pick<Entry, 'status' | 'archived' | 'archivedReasonType' | 'supersededBy'>[],
): Record<LifecycleState, number> {
  const counts = Object.fromEntries(LIFECYCLE_STATES.map((key) => [key, 0])) as Record<LifecycleState, number>
  for (const entry of entries) counts[lifecycleOf(entry)] += 1
  return counts
}

/**
 * 是否允许**未经请求**地进入上下文（注入路径的唯一判据）。
 *
 * `pending` 不进注入（候选区未审核）；`archived` / `deleted` 不进（结论已不可用）。
 * ⚠ 这与「检索可见性」是两件事：显式 `recall` 仍能召回 `pending`（带标记），由我判断。
 */
export function isInjectable(
  entry: Pick<Entry, 'status' | 'archived' | 'archivedReasonType' | 'supersededBy'>,
): boolean {
  const state = lifecycleOf(entry)
  return state !== 'pending' && state !== 'archived' && state !== 'deleted'
}

/** 中文标签 */
export function lifecycleLabel(state: LifecycleState): string {
  return LIFECYCLE_LABELS[state]
}

/**
 * 渲染标记：只给 `pending` / `disputed` / `deleted` 三态；其余（含 `undefined`）返回空串
 * （`superseded` / `archived` 由 `supersededByTag` / `archiveReasonTag` 渲染，
 * 同一事实不许在两个界面长得不一样）。
 */
export function lifecycleTag(state: LifecycleState | undefined): string {
  if (state === undefined) return ''
  return LIFECYCLE_TAGS[state] ?? ''
}
