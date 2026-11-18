/**
 * 空间归属维度（v0.27.0 · 方案 §3.2 四空间）——一条记忆属于**谁的疆域**。
 *
 * ## 与 `scope` 的分工（两轴正交，不可互相推导）
 *
 * - `scope` 是**存储与准入**：数据放哪个分区（`global` / 工作区路径），决定键空间、
 *   磁盘分片与「谁看得见这个库」。它是**物理位置**。
 * - `space`（本模块）是**知识归属**：这条知识属于谁的疆域——我自己的、某个工程的、
 *   跨工程可复用的领域知识、还是这台机器怎么跑的系统知识。它是**语义维度**，
 *   服务的是**独立授权**（`role.spaces`）与**检索分区**。
 *
 * 两者**刻意不互相推导**：
 * - 项目 A 的技术决策可以存进 `global` 库而 `space='domain'`（值得全局复用）；
 * - 关于我自己的偏好可以存进项目路径而 `space='personal'`（只是当时在那个目录里写）。
 * 任何「从 scope 推 space」的默认值都等于让机制替主体断言——判断型字段禁默认值。
 *
 * ## 四空间的判据（拿不准时问）
 *
 * | 空间 | 装什么 | 判据 |
 * |------|--------|------|
 * | `personal` 个人 | 关于我与主人的持久偏好、画像、关系 | 「这是关于**谁**的」——人或关系 |
 * | `project` 项目 | 某个工程的目标 / 进度 / 决策 | 「换一个项目还用得上吗」——用不上 |
 * | `domain` 领域 | 跨项目可复用的领域知识（期货口径、插件方法、论文方法） | 用得上 ⇒ 领域 |
 * | `system` 系统 | 运行环境锚点、工具失败原因、通道与凭据纪律 | 「这是关于**这台机器怎么跑**的」 |
 *
 * ## 为什么没有默认值
 *
 * 同 `memType`：归属是**判断**。未给 = 未标注，统计里单列 `unclassified`，不折进任何空间。
 * 授权侧对未标注条目 **fail-closed**（设了 `spaces` 的角色不放行它）——「不知道属于
 * 哪个空间」不能当「所有空间都可读」。
 *
 * ## 已知边界（不得读成「已隔离」）
 *
 * 空间只做**视野管理**：它不加密、不隔离存储，能读盘的人仍能读到全部条目
 * （同 `role` 维度的诚实声明）。真隔离要配独立 `DSH_HOME`。
 *
 * 纯函数层：不依赖 Cordis / fs，离线可测（tests/space.test.mjs）。
 */

import type { Entry, Space } from './types.ts'

/** 规范取值（顺序 = 方案 §3.2 的列举顺序，也是统计展示顺序） */
export const SPACES: readonly Space[] = ['personal', 'project', 'domain', 'system']

/** 中文标签（渲染与统计用） */
export const SPACE_LABELS: Record<Space, string> = {
  personal: '个人',
  project: '项目',
  domain: '领域',
  system: '系统',
}

/** 未标注（统计键名；**不是**一个可写入的取值） */
export const UNCLASSIFIED_SPACE = 'unclassified'

/**
 * 容错别名表——**只用于读取历史数据**（参数入口 fail-loud，见 `parseSpaceArg`）。
 *
 * 只收**无歧义**写法。刻意不收 `通用` / `公共`——它们不是方案四空间之一，
 * 收进来等于把「我不知道」写成「我知道」。
 */
const SPACE_ALIASES: Readonly<Record<string, Space>> = {
  personal: 'personal',
  个人: 'personal',
  个人空间: 'personal',
  私人: 'personal',
  project: 'project',
  项目: 'project',
  项目空间: 'project',
  domain: 'domain',
  领域: 'domain',
  领域空间: 'domain',
  专业知识: 'domain',
  system: 'system',
  系统: 'system',
  系统空间: 'system',
  系统运行: 'system',
}

/**
 * 归一任意输入为规范空间值（容错路径）。
 * @param raw - 任意输入
 * @returns 规范值；`undefined` = 未标注（空、未给、或认不出的历史值）
 */
export function normalizeSpace(raw: unknown): Space | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (trimmed.length === 0) return undefined
  const lower = trimmed.toLowerCase()
  if ((SPACES as readonly string[]).includes(lower)) return lower as Space
  return SPACE_ALIASES[trimmed] ?? SPACE_ALIASES[lower]
}

/** 是否为规范空间值（校验用，不归一） */
export function isSpace(value: unknown): value is Space {
  return typeof value === 'string' && (SPACES as readonly string[]).includes(value)
}

/**
 * 工具参数入口（**fail-loud**）：非法值抛错，不静默当未标注。
 * @param raw - 工具参数原值
 * @param field - 报错里用的字段名
 */
export function parseSpaceArg(raw: unknown, field = 'space'): Space | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') {
    throw new Error(`${field}: 必须是字符串（${SPACES.join(' / ')}），实际类型 ${typeof raw}`)
  }
  const trimmed = raw.trim()
  if (trimmed.length === 0) return undefined
  const normalized = normalizeSpace(trimmed)
  if (normalized === undefined) {
    throw new Error(
      `${field}: 未知取值 ${JSON.stringify(raw)}——合法值只有 ${SPACES.join(' / ')}`
      + `（可识别中文别名：${SPACES.map((s) => SPACE_LABELS[s]).join(' / ')}）`,
    )
  }
  return normalized
}

/**
 * 检索过滤参数（数组，**fail-loud**；任一项非法整笔拒绝）。
 * @param raw - 工具参数原值（字符串或字符串数组）
 * @param field - 报错里用的字段名
 * @returns 去重后的规范值数组；未给返回 undefined（= 不过滤）
 */
export function parseSpaceFilterArg(raw: unknown, field = 'space'): Space[] | undefined {
  if (raw === undefined || raw === null) return undefined
  const list = Array.isArray(raw) ? raw : [raw]
  const out: Space[] = []
  for (const item of list) {
    const parsed = parseSpaceArg(item, field)
    if (parsed !== undefined && !out.includes(parsed)) out.push(parsed)
  }
  return out.length > 0 ? out : undefined
}

/**
 * 按空间筛条目（**可选筛子**，不是准入——空间本身不改变可见性，准入在 `role.ts`）。
 * @param entries - 候选条目
 * @param spaces - 目标空间；`undefined` = 不过滤（原样返回**同一数组引用**，零拷贝）
 */
export function filterBySpace(entries: Entry[], spaces: Space[] | undefined): Entry[] {
  if (spaces === undefined) return entries
  return entries.filter((entry) => isSpace(entry.space) && spaces.includes(entry.space))
}

/** 空间计数（memory_stats 用）：四空间 + 未标注（**之和 == 总数**） */
export function countBySpace(
  entries: readonly Pick<Entry, 'space'>[],
): Record<Space | typeof UNCLASSIFIED_SPACE, number> {
  const counts = Object.fromEntries(
    [...SPACES, UNCLASSIFIED_SPACE].map((key) => [key, 0]),
  ) as Record<Space | typeof UNCLASSIFIED_SPACE, number>
  for (const entry of entries) {
    const key = isSpace(entry.space) ? entry.space : UNCLASSIFIED_SPACE
    counts[key] += 1
  }
  return counts
}

/** 中文标签；`undefined` → 「未标注」 */
export function spaceLabel(space: Space | undefined): string {
  return space === undefined ? '未标注' : SPACE_LABELS[space]
}

/**
 * 渲染标记：有值时给 `〔个人〕`，未标注给**空串**。
 *
 * 未标注必须留空：库里存量条目全都没有该字段，给它们都打「未标注」只是噪音
 * （同 `subjectTag` / `memTypeTag` 的「标记要挑着打」）。
 */
export function spaceTag(space: Space | undefined): string {
  return isSpace(space) ? `〔${SPACE_LABELS[space]}〕` : ''
}
