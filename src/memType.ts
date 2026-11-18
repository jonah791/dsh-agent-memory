/**
 * 内容分类维度（v0.26.0 · 方案 §3.1 七类记忆）——一条记忆**是哪一类馆藏**。
 *
 * ## 与 `kind` 的分工（两轴正交，不可互相替代）
 *
 * - `kind`（fact / knowledge / episodic / summary）是**存储与粒度轴**：它决定去重策略
 *   （episodic 走标题指纹合并、summary 走桶）、压缩链参与方式、体检权重。四条值在
 *   v0.1 就定了，改动会动到压缩链与体检的既有契约 ⇒ 保持不动。
 * - `memType`（本模块七类）是**内容性质轴**（方案 §3.1）：情景 / 语义 / 程序 / 画像 /
 *   项目 / 关系 / 运行。它服务的下游是**保留策略**（§10.1 按类定策略）、**任务感知路由**
 *   （§8.4 六类任务各取所需）与**知识组织**（§4 关系与主题）。
 *
 * 两轴在「情景」上重合（`kind=episodic` 与 `memType=episodic` 常同时成立），这是
 * **语义重叠而非第二真源**：它们回答不同问题（怎么存 vs 是什么），且**不互相推导**
 * ——不从 `kind` 自动生成 `memType`（那是判断，见下条）。
 *
 * ## 为什么没有默认值
 *
 * 「这条属于哪一类」是**判断**，不是可以机械推出的量。给默认值等于让机制替我断言，
 * 而断言错了不会有任何东西报错（AGENTS.md：判断型字段禁默认值）。⇒ 未给 = `未分类`，
 * 统计里单列 `unclassified`，**不折进任何一类**（同 `grounding` 的「省略 = 不知道」纪律）。
 *
 * ## 七类不互斥
 *
 * 方案原文：「这七类并不是互相排斥的……一条原始事件可以产生多个相互关联的记忆资源」。
 * 所以本字段是**单值**（一条记忆的首要归类），多归属由未来的**类型化关系**（§4.4）
 * 承载，不在这里做成数组——数组会让「首要归类」这个判断消失。
 *
 * 纯函数层：不依赖 Cordis / fs，离线可测（tests/memtype.test.mjs）。
 */

import type { Entry, MemType } from './types.ts'

/** 规范取值（顺序 = 方案 §3.1 的 A–G，也是统计展示顺序） */
export const MEM_TYPES: readonly MemType[] = [
  'episodic', 'semantic', 'procedural', 'profile', 'project', 'relational', 'operational',
]

/** 中文标签（渲染与统计用） */
export const MEM_TYPE_LABELS: Record<MemType, string> = {
  episodic: '情景',
  semantic: '语义',
  procedural: '程序',
  profile: '画像',
  project: '项目',
  relational: '关系',
  operational: '运行',
}

/** 未分类（统计键名；**不是**一个可写入的取值） */
export const UNCLASSIFIED_MEM_TYPE = 'unclassified'

/**
 * 容错别名表——**只用于读取历史数据**（参数入口 fail-loud，见 `parseMemTypeArg`）。
 *
 * 只收**无歧义**写法：方案原文术语、常见短称、英文规范值本身。
 * 刻意不收 `知识` / `事实` / `经验`——它们既能指语义也能指程序，收进来等于静默误分类。
 */
const MEM_TYPE_ALIASES: Readonly<Record<string, MemType>> = {
  episodic: 'episodic',
  情景: 'episodic',
  情景记忆: 'episodic',
  semantic: 'semantic',
  语义: 'semantic',
  语义记忆: 'semantic',
  procedural: 'procedural',
  程序: 'procedural',
  程序记忆: 'procedural',
  profile: 'profile',
  画像: 'profile',
  用户画像: 'profile',
  偏好: 'profile',
  project: 'project',
  项目: 'project',
  项目记忆: 'project',
  relational: 'relational',
  关系: 'relational',
  关系记忆: 'relational',
  operational: 'operational',
  运行: 'operational',
  运行记忆: 'operational',
  系统运行: 'operational',
}

/**
 * 归一任意输入为规范类型值（容错路径）。
 * @param raw - 任意输入
 * @returns 规范值；`undefined` = 未分类（空、未给、或认不出的历史值）
 */
export function normalizeMemType(raw: unknown): MemType | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (trimmed.length === 0) return undefined
  const lower = trimmed.toLowerCase()
  if ((MEM_TYPES as readonly string[]).includes(lower)) return lower as MemType
  return MEM_TYPE_ALIASES[trimmed] ?? MEM_TYPE_ALIASES[lower]
}

/** 是否为规范类型值（校验用，不归一） */
export function isMemType(value: unknown): value is MemType {
  return typeof value === 'string' && (MEM_TYPES as readonly string[]).includes(value)
}

/**
 * 工具参数入口（**fail-loud**）：非法值抛错，不静默当未分类。
 * @param raw - 工具参数原值
 * @param field - 报错里用的字段名
 */
export function parseMemTypeArg(raw: unknown, field = 'memType'): MemType | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') {
    throw new Error(`${field}: 必须是字符串（${MEM_TYPES.join(' / ')}），实际类型 ${typeof raw}`)
  }
  const trimmed = raw.trim()
  if (trimmed.length === 0) return undefined
  const normalized = normalizeMemType(trimmed)
  if (normalized === undefined) {
    throw new Error(
      `${field}: 未知取值 ${JSON.stringify(raw)}——合法值只有 ${MEM_TYPES.join(' / ')}`
      + `（可识别中文别名：${MEM_TYPES.map((t) => MEM_TYPE_LABELS[t]).join(' / ')}）`,
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
export function parseMemTypeFilterArg(raw: unknown, field = 'memType'): MemType[] | undefined {
  if (raw === undefined || raw === null) return undefined
  const list = Array.isArray(raw) ? raw : [raw]
  const out: MemType[] = []
  for (const item of list) {
    const parsed = parseMemTypeArg(item, field)
    if (parsed !== undefined && !out.includes(parsed)) out.push(parsed)
  }
  return out.length > 0 ? out : undefined
}

/**
 * 按内容类型筛条目（**可选筛子**，不是准入——分类不改变可见性）。
 * @param entries - 候选条目
 * @param types - 目标类型；`undefined` = 不过滤（原样返回**同一数组引用**，零拷贝）
 */
export function filterByMemType(entries: Entry[], types: MemType[] | undefined): Entry[] {
  if (types === undefined) return entries
  return entries.filter((entry) => isMemType(entry.memType) && types.includes(entry.memType))
}

/** 类型计数（memory_stats 用）：七类 + 未分类（**之和 == 总数**） */
export function countByMemType(
  entries: readonly Pick<Entry, 'memType'>[],
): Record<MemType | typeof UNCLASSIFIED_MEM_TYPE, number> {
  const counts = Object.fromEntries(
    [...MEM_TYPES, UNCLASSIFIED_MEM_TYPE].map((key) => [key, 0]),
  ) as Record<MemType | typeof UNCLASSIFIED_MEM_TYPE, number>
  for (const entry of entries) {
    const key = isMemType(entry.memType) ? entry.memType : UNCLASSIFIED_MEM_TYPE
    counts[key] += 1
  }
  return counts
}

/** 中文标签；`undefined` → 「未分类」 */
export function memTypeLabel(memType: MemType | undefined): string {
  return memType === undefined ? '未分类' : MEM_TYPE_LABELS[memType]
}

/**
 * 渲染标记（拼在元数据方括号里）：有值时给 `·语义`，未分类给**空串**。
 *
 * 未分类必须留空：库里存量条目全都没有该字段，给它们都打「未分类」只是噪音
 * （同 `subjectTag` 的「标记要挑着打」）。
 */
export function memTypeTag(memType: MemType | undefined): string {
  return isMemType(memType) ? `·${MEM_TYPE_LABELS[memType]}` : ''
}
