/**
 * 主体层（v0.13.0「关于谁的」维度）——记忆的**语义标记**，不是准入。
 *
 * 动机（主人 2026-10-14 指令）：把记忆分成两个层——「你的自我记忆层」与
 * 「关于我的记忆层」。
 *
 * 与 role（v0.5 归属维度）的分工——**两维正交，不可互换**：
 *   - `role` 答「**谁写的**」：主脑 / 派生 / worker / ghost 的**视野隔间**，默认互不可见；
 *   - `subject` 答「**关于谁**」：`self`（我）/ `master`（主人）/ 不设（通用）。
 *   同一条记忆可以「由我写 ∧ 关于主人」。复用 role 会同时毁掉两个语义——
 *   「关于主人的记忆」在 role 上的取值是**写它的那个会话**，与「关于谁」无关。
 *
 * 三条设计决定（**与 role 刻意不同**，每条附理由；理由不写下来，将来会被「对齐」掉）：
 *
 *   1. **不做准入**：subject 不改变可见性。「关于主人的记忆」我看得见，「关于我的」
 *      主人也看得见。它是语义标记（可过滤 / 可统计 / 可渲染），不是权限墙。
 *      **荒谬性检验**：「我记不住关于你的事」不该是机制能造成的结果。
 *      对照：role 是准入（条目在检索**之前**被剔除），所以它需要总开关来避免误伤。
 *
 *   2. **无需总开关**：因为没有准入，就没有「让人失明」的风险面。未设 subject
 *      = 通用，天然向后兼容（存量条目一条不动、行为逐字节不变）。加开关只增加
 *      状态面而无收益。
 *
 *   3. **允许显式转移**（**与 I10「归属不可转移」刻意相反**）：role 不可转移是因为
 *      转移会改变**可见范围**（安全后果）；subject 转移不改可见性 ⇒ 无安全后果。
 *      本条反对的只是**静默**转移（写入时不小心改了归属——`remember` 命中已有条目
 *      时仍不覆盖，`update` 不给 subject 就不动）；而**显式**纠正（`update` 带
 *      subject）是**必要**的——否则几百条历史记忆永远无法标注，这个维度等于白建。
 *
 * **信任边界（诚实声明）**：subject 是**语义标记**，不是授权。它不阻止任何人读任何
 * 条目——要隔离请用 role 隔间或独立 DSH_HOME。把它当权限用是误用。
 *
 * 纯函数层：不依赖 Cordis / fs，离线可测（tests/subject.test.mjs）。
 */

import type { Entry, Subject } from './types.ts'

/** 规范取值（顺序即展示顺序：先自己，后主人） */
export const SUBJECTS: readonly Subject[] = ['self', 'master']

/** 中文标签（人读用） */
export const SUBJECT_LABELS: Record<Subject, string> = { self: '自我', master: '主人' }

/** 未标注（通用层）在统计里的键名 */
export const UNSPECIFIED_SUBJECT = 'unspecified'

/**
 * 容错别名表——**只用于读取历史数据**：常见写法 → 规范值。
 *
 * 为什么需要：写入侧用规范值，但**手写或外部调用**可能写成「主人」「我」等。
 * 读路径遇到它们应当认得出，而不是当未知值丢掉。
 *
 * 为什么**故意做得短**：别名表越宽，撞名风险越高（`user` 在代码里普遍指消息角色
 * user/assistant；`你` 在中文里语义依赖上下文）——歧义别名会把错误归类**静默**
 * 引进库里，那比「认不出」更坏。⇒ 只收**无歧义**的写法。
 */
const SUBJECT_ALIASES: Readonly<Record<string, Subject>> = {
  self: 'self',
  myself: 'self',
  alice: 'self',
  我: 'self',
  自我: 'self',
  爱丽丝: 'self',
  master: 'master',
  owner: 'master',
  主人: 'master',
}

/**
 * 归一任意输入为规范主体值（容错路径）。
 *
 * @param raw - 任意输入（字符串/undefined/null/其他）
 * @returns 规范值；`undefined` = **通用**（空、未给、或认不出的历史值）
 *
 * ⚠ 工具**参数**入口不走这里——见 `parseSubjectArg`（那里 fail-loud）。
 */
export function normalizeSubject(raw: unknown): Subject | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (trimmed.length === 0) return undefined
  const lower = trimmed.toLowerCase()
  if ((SUBJECTS as readonly string[]).includes(lower)) return lower as Subject
  return SUBJECT_ALIASES[trimmed] ?? SUBJECT_ALIASES[lower]
}

/** 是否为规范主体值（用于校验而非归一） */
export function isSubject(value: unknown): value is Subject {
  return typeof value === 'string' && (SUBJECTS as readonly string[]).includes(value)
}

/**
 * 工具参数入口（**fail-loud**）：非法值抛错，不静默当通用。
 *
 * 为什么与 `normalizeSubject` 分流（两条路径的语义不同）：
 *   - **参数**是「我此刻的意图」——拼错了必须**当场**知道，静默降级成通用 =
 *     我以为标上了、其实没标（这正是本插件反复栽过的「静默失败」形状）；
 *   - **历史数据**是「既成事实」——读到认不出的值不该让整次检索崩掉。
 *
 * @param raw - 工具参数原值
 * @param field - 报错里用的字段名（便于定位是哪个工具的哪个参数）
 */
export function parseSubjectArg(raw: unknown, field = 'subject'): Subject | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') {
    throw new Error(`${field}: 必须是字符串（self / master），实际类型 ${typeof raw}`)
  }
  const trimmed = raw.trim()
  if (trimmed.length === 0) return undefined
  const normalized = normalizeSubject(trimmed)
  if (normalized === undefined) {
    throw new Error(
      `${field}: 未知取值 ${JSON.stringify(raw)}——合法值只有 ${SUBJECTS.join(' / ')}`
      + `（可识别别名：${Object.keys(SUBJECT_ALIASES).filter((k) => k !== 'self' && k !== 'master').join(' / ')}）`,
    )
  }
  return normalized
}

/**
 * 按主体筛条目（**可选筛子**，不是准入——见文件头决定 1）。
 *
 * @param entries - 候选条目
 * @param subject - 目标主体；**`undefined` = 不过滤**（原样返回**同一数组引用**，零拷贝）
 * @returns 匹配的条目（新数组）；未给 subject 时返回入参本身
 */
export function filterBySubject(entries: Entry[], subject: Subject | undefined): Entry[] {
  if (subject === undefined) return entries
  return entries.filter((entry) => entry.subject === subject)
}

/** 主体计数（memory_stats 用）：规范值 + 未标注（通用） */
export function countBySubject(
  entries: readonly Pick<Entry, 'subject'>[],
): Record<Subject | typeof UNSPECIFIED_SUBJECT, number> {
  const counts: Record<Subject | typeof UNSPECIFIED_SUBJECT, number> = {
    self: 0,
    master: 0,
    [UNSPECIFIED_SUBJECT]: 0,
  }
  for (const entry of entries) {
    const key = isSubject(entry.subject) ? entry.subject : UNSPECIFIED_SUBJECT
    counts[key] += 1
  }
  return counts
}

/** 中文标签；`undefined` → 「通用」 */
export function subjectLabel(subject: Subject | undefined): string {
  return subject === undefined ? '通用' : SUBJECT_LABELS[subject]
}

/**
 * 渲染标记（拼接用）：有值时给 `[自我]` / `[主人]`，通用层给**空串**。
 *
 * 通用层**必须留空**：库里绝大多数条目是通用的，给它们都打上标记只会
 * 淹没真正需要被看见的那两条（同类教训：`silent-suppression-gate` 的
 * 「抑制判据会与最该被问到的对象反相关」——反过来，标记也要挑着打）。
 */
export function subjectTag(subject: Subject | undefined): string {
  return subject === undefined ? '' : `[${SUBJECT_LABELS[subject]}]`
}
