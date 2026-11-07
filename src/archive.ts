/**
 * 归档因果 + 来源类型（v0.21.0）——记忆的**返回弧**与 `p` 轴。
 *
 * ## 为什么需要这个文件（两个缺口，同一形状：字段语义错配）
 *
 * **缺口一（返回弧）**：`forget` 一直把归档原因写进 `source.reason`。`source` 的语义本
 * 该是「来源链」（sessionId / seq），实际装的却是归档原因。后果不是「不好看」——归档
 * 原因是**自由文本**，无法按类型查询，于是「我引用的那条为什么没了」这个问题在机制上
 * 无法回答，只能逐条读正文去猜。
 *
 * 实测（2026-11-07，2701 条全量）：正式派生引用只有 11 条，但**已归档条目标题仍出现在
 * 118 条活跃条目正文里**（占归档 1260 条的 9.4%）——删除**没有传播**，而机制里没有任何
 * 东西能让它传播。
 *
 * 论文依据（Always-On Agents 综述 · arXiv:2606.30306）：生命周期分两段弧，前向
 * （observe→write→validate→organize→retrieve→act）与**返回弧**（update→forget→audit→
 * rollback）。435 篇语料里 retrieve 269 / write 200，而 **rollback 只有 27**、forget 66
 * ⇒ 返回弧是被系统性忽视的一段。论文还给出「删除传播不变式」：忘掉一条事实必须沿派生链
 * 撤到「抽取自的原始情节 / 吸收了它的摘要 / 以它为条件的技能 / 别人的共享副本 / 它曾授权
 * 的外部副作用」。**要传播，先要能分类**——这就是 `reasonType`。
 *
 * **缺口二（`p` 轴）**：同一个 `source` 字段，两次体检都判它「47% 覆盖、语义错配」。
 * 而真正的来源信息（这条是主人说的？我实测的？还是从网页读来的？）一个字段都没有。
 * 现有的 `origin.ts` 是补丁：用正则从标题形态猜「这可能是转述」，只标一种坏情况，
 * 已知边界写在那个文件头（引网页/书/口述的漏标）。**声明（provenance）取代猜测（正则）。**
 *
 * ## 三条设计决定
 *
 * 1. **`archival` 与 `source` 分开**（不改造 `source`）。老字段保留不动——2701 条存量里
 *    1260 条带 `source.reason`，批量迁移的数据风险远大于收益。改成**读取归一**：
 *    `archivalOf()` 在 `archival` 缺失且条目已归档时，把 `source.reason` 读成
 *    `reasonType: 'unspecified'` 的历史记录。零数据改动、语义立刻正确、新旧并存不歧义。
 *
 * 2. **`'unspecified'` 不是默认值，是「未判断」的显式表示**。AGENTS.md 禁的是判断型字段
 *    **自动填一个断言值**（程序替我断言）。`unspecified` 恰恰相反：它说「这里没有断言」，
 *    与 `grounding` 缺省 = 未标注同一立场。
 *
 * 3. **`provenance` 与 `grounding` 正交，不可互相替代**。体检时我差点把两者当成一个：
 *    `grounding` 答「**是否已被共同建立**」（授权维 `a`），`provenance` 答「**信息从哪
 *    来**」（来源维 `p`）。合并任何一个都会让另一维失去分辨力。
 *
 * ## 已知边界（如实标注，别读成「已解决」）
 *
 * - `reasonType` 只在**新归档**时有语义。存量 1260 条归一成 `unspecified` —— 它们仍然
 *   无法按类型查，只是不再冒充「来源」。要给它们真分类，得逐条读（人工判断，不做猜测）。
 * - 传播**没有自动执行**：本模块只让「为什么没了」可查，**不强制**活跃条目更新引用。
 *   自动改正文等于自动决策，且会改错（引用可能只是提到名字而非依赖结论）。
 * - `provenance` 是可选字段，与 `grounding` 同病：不填则无保护。缓解手段是让覆盖率
 *   可见（`memory_stats` 报出来），而不是让它默认有个值。
 */

import type { ArchiveReasonType, ArchiveRecord, Entry, Provenance } from './types.js'

/** 全部归档原因类型（渲染 / 校验 / 统计的单一真源——不要在别处枚举） */
export const ARCHIVE_REASON_TYPES = [
  'refuted',
  'merged',
  'superseded',
  'stale',
  'capacity',
  'unspecified',
] as const satisfies readonly ArchiveReasonType[]

/** 全部来源类型（同上，单一真源） */
export const PROVENANCE_TYPES = ['master', 'web', 'self', 'measured'] as const satisfies readonly Provenance[]

/**
 * 归档原因中文标签。
 *
 * 措辞刻意区分「内容还在不在」——这决定引用它的活跃条目要不要撤：
 * `merged` / `capacity` 的内容仍在（换了位置 / 只是清位），`refuted` / `superseded` /
 * `stale` 的结论**不能再当依据用**。这个差别是 `reasonType` 存在的全部理由。
 */
const ARCHIVE_REASON_LABELS: Record<ArchiveReasonType, string> = {
  refuted: '被证伪',
  merged: '已合并',
  superseded: '被取代',
  stale: '已过时',
  capacity: '容量清理',
  unspecified: '未分类',
}

const PROVENANCE_LABELS: Record<Provenance, string> = {
  master: '主人',
  web: '外部',
  self: '自推',
  measured: '实测',
}

/** 需要**警觉**的归档原因：结论不能再当依据用（`merged` / `capacity` 不算） */
const ALERTING_ARCHIVE_REASONS: readonly ArchiveReasonType[] = ['refuted', 'superseded', 'stale']

/** 需要**警觉**的来源：权威不在我这一侧（`master` / `measured` 是硬来源，不打标记） */
const ALERTING_PROVENANCE: readonly Provenance[] = ['web', 'self']

/** 类型守卫：是不是合法的归档原因类型 */
export function isArchiveReasonType(value: unknown): value is ArchiveReasonType {
  return typeof value === 'string' && (ARCHIVE_REASON_TYPES as readonly string[]).includes(value)
}

/** 类型守卫：是不是合法的来源类型 */
export function isProvenance(value: unknown): value is Provenance {
  return typeof value === 'string' && (PROVENANCE_TYPES as readonly string[]).includes(value)
}

/**
 * 归一归档原因类型：非法值 / 缺省 ⇒ `undefined`（**不猜**）。
 * 工具层用它校验入参；猜一个近似值会让「被证伪」和「已合并」混在一起。
 */
export function normalizeArchiveReasonType(value: unknown): ArchiveReasonType | undefined {
  return isArchiveReasonType(value) ? value : undefined
}

/** 归一来源类型：非法值 ⇒ `undefined`（不猜） */
export function normalizeProvenance(value: unknown): Provenance | undefined {
  return isProvenance(value) ? value : undefined
}

/**
 * 解析工具入参的来源类型：缺省 / 空串 ⇒ `undefined`；非法值 ⇒ **fail-loud**。
 *
 * 与 `grounding.ts::parseGroundingArg` 同形同纪律：**不静默降级**。静默把打错的
 * `'mater'` 当成「未标注」，正是本维度要防的那种失败——我以为标了，其实没标，
 * 而未来的我拿着一条「不知道来源」的结论当实测定论用。
 */
export function parseProvenanceArg(value: unknown, where: string): Provenance | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`${where}: 期望字符串，收到 ${typeof value}`)
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  const normalized = normalizeProvenance(trimmed)
  if (normalized === undefined) {
    throw new Error(`${where}: 未知来源类型 "${trimmed}"（允许 ${PROVENANCE_TYPES.join(' / ')}）`)
  }
  return normalized
}

/** 解析工具入参的归档原因类型：同 `parseProvenanceArg`（缺省 `undefined`，非法值 fail-loud） */
export function parseArchiveReasonTypeArg(value: unknown, where: string): ArchiveReasonType | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`${where}: 期望字符串，收到 ${typeof value}`)
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  const normalized = normalizeArchiveReasonType(trimmed)
  if (normalized === undefined) {
    throw new Error(`${where}: 未知归档原因类型 "${trimmed}"（允许 ${ARCHIVE_REASON_TYPES.join(' / ')}）`)
  }
  return normalized
}

/**
 * 读出任一条目的归档记录——**新旧两代格式的单一归一点**。
 *
 * 判断顺序即优先级：
 * 1. **未归档** ⇒ `undefined`（第一判——归档字段只对已归档条目有意义）
 * 2. `archivedReasonType` 合法 ⇒ 用它（v0.21.0 起的正确形态）
 * 3. 否则回退 `source.reason` ⇒ 读成 v0.20 及以前的历史记录（`reasonType: 'unspecified'`）
 *
 * ⚠ **回退必须挂在 `archived === true` 上**：`timeline.ts` 写概要条目时也往 `source.reason`
 * 塞了一句「时间压缩：…」，但那是**产出说明**不是归档记录——不加这个条件，概要把自己
 * 伪装成「被归档的条目」，而这正是字段语义错配换个地方重演。
 *
 * `at` 一律取 `updatedAt`：`store.forget` 归档时就是刷新它，那是归档时刻。不另存时间戳
 * ——「哪个才算」会变成第二个真源。
 *
 * 返回**对象视图**（不是存储形态）：调用方拿 `{ at, reasonType, reason }` 一个整体，
 * 而存储层是平级标量（理由见 `types.ts::Entry.archivedReasonType` 的注释）。
 */
export function archivalOf(
  entry: Pick<Entry, 'archived' | 'archivedReasonType' | 'archivedReason' | 'source' | 'updatedAt'>,
): ArchiveRecord | undefined {
  if (entry.archived !== true) return undefined
  const at = entry.updatedAt
  if (isArchiveReasonType(entry.archivedReasonType)) {
    const reason = typeof entry.archivedReason === 'string' ? entry.archivedReason.trim() : ''
    return { at, reasonType: entry.archivedReasonType, ...(reason.length > 0 ? { reason } : {}) }
  }
  const legacyReason = entry.source?.reason
  if (typeof legacyReason !== 'string' || legacyReason.trim().length === 0) return undefined
  return { at, reasonType: 'unspecified', reason: legacyReason }
}

/** 归档原因中文标签；`undefined` → 「未归档」 */
export function archiveReasonLabel(reasonType: ArchiveReasonType | undefined): string {
  return reasonType === undefined ? '未归档' : ARCHIVE_REASON_LABELS[reasonType]
}

/**
 * 归档标记（拼接用）：**只对「结论已不能用」的原因给标记**，其余留空。
 *
 * 标记要挑着打（`subjectTag` / `groundingTag` / `stalenessTag` 的同一条教训）：
 * `merged` / `capacity` / `unspecified` 打标记会淹没 `refuted` 这类真正要紧的。
 */
export function archiveReasonTag(reasonType: ArchiveReasonType | undefined): string {
  if (reasonType === undefined || !ALERTING_ARCHIVE_REASONS.includes(reasonType)) return ''
  return `[${ARCHIVE_REASON_LABELS[reasonType]}]`
}

/** 来源类型中文标签；`undefined` → 「未标注」 */
export function provenanceLabel(provenance: Provenance | undefined): string {
  return provenance === undefined ? '未标注' : PROVENANCE_LABELS[provenance]
}

/**
 * 来源标记（拼接用）：**只对「权威不在我这一侧」的来源给标记**。
 *
 * - `web` → `[外部]`：别人的说法，拿它当自己的结论用之前回去核对原文
 * - `self` → `[自推]`：**我的提议**，不是主人说过的（与 grounding 的 `[我的提议]` 同向：
 *   那一维答「主人回应了没有」，这一维答「这信息根本不是我实测的」）
 * - `master` / `measured` / 未标注 → 空串（硬来源与常态不打标记）
 */
export function provenanceTag(provenance: Provenance | undefined): string {
  if (provenance === undefined || !ALERTING_PROVENANCE.includes(provenance)) return ''
  return `[${PROVENANCE_LABELS[provenance]}]`
}

/** 来源过滤（可选筛子，不是可见性边界——与 `filterByGrounding` 同形同立场） */
export function filterByProvenance<T extends Pick<Entry, 'provenance'>>(entries: T[], provenance: Provenance | undefined): T[] {
  if (provenance === undefined) return entries
  return entries.filter((entry) => entry.provenance === provenance)
}

/** 来源计数（`memory_stats` 用）：四档 + 未标注 */
export function countByProvenance(
  entries: readonly Pick<Entry, 'provenance'>[],
): Record<Provenance | 'unlabeled', number> {
  const counts: Record<Provenance | 'unlabeled', number> = {
    master: 0,
    web: 0,
    self: 0,
    measured: 0,
    unlabeled: 0,
  }
  for (const entry of entries) {
    const key = isProvenance(entry.provenance) ? entry.provenance : 'unlabeled'
    counts[key] += 1
  }
  return counts
}

/** 归档原因计数（`memory_stats` 用）：六档；未归档的条目不参与 */
export function countByArchiveReason(
  entries: readonly Pick<Entry, 'archived' | 'archivedReasonType' | 'archivedReason' | 'source' | 'updatedAt'>[],
): Record<ArchiveReasonType, number> {
  const counts: Record<ArchiveReasonType, number> = {
    refuted: 0,
    merged: 0,
    superseded: 0,
    stale: 0,
    capacity: 0,
    unspecified: 0,
  }
  for (const entry of entries) {
    const record = archivalOf(entry)
    if (record !== undefined) counts[record.reasonType] += 1
  }
  return counts
}
