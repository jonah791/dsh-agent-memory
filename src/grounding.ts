/**
 * 约定状态（v0.14.0「是否已被共同建立」维度）—— 记忆的**来源性质标记**。
 *
 * 动机（论文 Grounding Awareness · arXiv:2610.18684 · 主人 2026-10-14 交办）：
 * 记忆系统只记「用户说了什么」，但**「说过」≠「已建立」**。最危险的形态是——
 * **我自己的提议被记成「主人的话」**，未来当作授权执行。论文三个实测读数：
 *   ① 被保留的未接受提议中 **86–100%** 被记成「已确认信息」或「用户事实」；
 *   ② 给它**更多**提议内容反而放大未授权执行（Qwen+Mem0 假共同基础 0.26 → 0.53）；
 *   ③ 显式 grounding 信息的贡献**远超**更强推理（Status Oracle 0.43 → 0.73，+0.30；
 *      而只给内容仅 +0.03）。
 *
 * 与既有维度**正交**（三维可任意组合）：
 *   - `role`      答「**谁写的**」（准入隔间）
 *   - `subject`   答「**关于谁的**」（语义标记）
 *   - `grounding` 答「**是否已被共同建立**」（来源性质标记） ← 本模块
 *
 * ⚠ **与论文刻意不同（理由留在此处，否则会被「对齐」掉）**：论文的默认立场是
 * 「未授权 ⇒ 必须确认」。本系统主人的授权模式却是「给方向、我自己决定」
 * （AGENTS.md §2.2 技术处置自主 · 内部事务不上抛）⇒ **不做强制门**：处处请示
 * 会直接违背该定调，把「自主」改回「待批」。**移植的是可见性，不是拦截。**
 *
 * ⚠ **本版如实保留的残留风险（不得粉饰）**：`grounding` 是**可选**字段，缺省 =
 * **未标注**。而「未标注」在检索时与「已建立」**长得一样**——也就是说，
 * **不主动标注就无法获得保护**（这正是论文指出的失败面）。本版的对策只有两条：
 *   ① 新写入的条目在**我意识到**时标注（工具面提供参数，不强制）；
 *   ② 提供 `recall({ grounding: 'proposed' })` 这类**审查入口**，让我能专门找出
 *      「我提的、主人未回应」的条目并补标（回填）；
 * ⇒ 判据：若某天发现「未标注」条目里混着大量我的提议，说明**回填欠账**，
 *    而不是「机制失效」——两者要分清。
 *
 * **渲染纪律（信噪比）**：只在有**需要警觉**的值时打标记（`proposed` / `scoped`）；
 * `established` 与「未标注」都**留空**。理由：库里绝大多数条目是常规来源，
 * 全打标记等于没打（同 `subjectTag` 的教训）。
 *
 * 纯函数层：不依赖 Cordis / fs，离线可测（tests/grounding.test.mjs）。
 */

import type { Entry, Grounding } from './types.ts'

/** 规范取值（顺序即展示顺序：先常态，后需警觉的三类） */
export const GROUNDINGS: readonly Grounding[] = ['established', 'proposed', 'scoped', 'rejected']

/** 中文标签（人读用） */
export const GROUNDING_LABELS: Record<Grounding, string> = {
  established: '已建立',
  proposed: '我的提议',
  scoped: '限范围',
  rejected: '已被否决',
}

/** 未标注（缺省）在统计里的键名 */
export const UNLABELED_GROUNDING = 'unlabeled'

/**
 * 需要**在渲染时凸显**的值——只在这一类打标记。
 *
 * `established` 刻意**不在其中**：它是常态假设，打标记会淹没真正该警觉的两条
 * （同 `subjectTag` 的教训：标记要挑着打）。
 */
const ALERTING: readonly Grounding[] = ['proposed', 'scoped', 'rejected']

/**
 * 容错别名表——**只用于读取历史数据**：常见写法 → 规范值。
 * 刻意做得短：歧义别名会把错误归类静默引进库里，比「认不出」更坏。
 */
const GROUNDING_ALIASES: Readonly<Record<string, Grounding>> = {
  established: 'established',
  accepted: 'established',
  agreed: 'established',
  已建立: 'established',
  已确认: 'established',
  主人说过: 'established',
  主人定调: 'established',
  proposed: 'proposed',
  proposal: 'proposed',
  unacknowledged: 'proposed',
  我的提议: 'proposed',
  未回应: 'proposed',
  我提的: 'proposed',
  scoped: 'scoped',
  conditional: 'scoped',
  限范围: 'scoped',
  有条件: 'scoped',
  rejected: 'rejected',
  declined: 'rejected',
  已拒绝: 'rejected',
  主人否决: 'rejected',
  被否: 'rejected',
}

/**
 * 归一任意输入为规范约定状态（容错路径）。
 *
 * @param raw - 任意输入
 * @returns 规范值；`undefined` = **未标注**（空、未给、或认不出的历史值）
 */
export function normalizeGrounding(raw: unknown): Grounding | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (trimmed.length === 0) return undefined
  const lower = trimmed.toLowerCase()
  if ((GROUNDINGS as readonly string[]).includes(lower)) return lower as Grounding
  return GROUNDING_ALIASES[trimmed] ?? GROUNDING_ALIASES[lower]
}

/** 是否为规范约定状态值（严格判定，不归一） */
export function isGrounding(value: unknown): value is Grounding {
  return typeof value === 'string' && (GROUNDINGS as readonly string[]).includes(value)
}

/**
 * 工具参数入口（**fail-loud**）：非法值抛错，不静默当未标注。
 *
 * 与 `normalizeGrounding` 分流的理由同 `subject.ts`：参数是**我此刻的意图**，
 * 拼错必须当场知道——静默降级成「未标注」= 我以为标了、其实没标，
 * 而这恰恰是本维度要防的那种失败。
 */
export function parseGroundingArg(raw: unknown, field = 'grounding'): Grounding | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') {
    throw new Error(`${field}: 必须是字符串（${GROUNDINGS.join(' / ')}），实际类型 ${typeof raw}`)
  }
  const trimmed = raw.trim()
  if (trimmed.length === 0) return undefined
  const normalized = normalizeGrounding(trimmed)
  if (normalized === undefined) {
    throw new Error(
      `${field}: 未知取值 ${JSON.stringify(raw)}——合法值只有 ${GROUNDINGS.join(' / ')}`
      + `（可识别别名：${Object.keys(GROUNDING_ALIASES).join(' / ')}）`,
    )
  }
  return normalized
}

/**
 * 按约定状态筛条目（**可选筛子**，不是准入——同 subject）。
 *
 * @param entries - 候选条目
 * @param grounding - 目标状态；**`undefined` = 不过滤**（原样返回**同一数组引用**，零拷贝）
 */
export function filterByGrounding(entries: Entry[], grounding: Grounding | undefined): Entry[] {
  if (grounding === undefined) return entries
  return entries.filter((entry) => entry.grounding === grounding)
}

/** 约定状态计数（memory_stats 用）：三档 + 未标注 */
export function countByGrounding(
  entries: readonly Pick<Entry, 'grounding'>[],
): Record<Grounding | typeof UNLABELED_GROUNDING, number> {
  const counts: Record<Grounding | typeof UNLABELED_GROUNDING, number> = {
    established: 0,
    proposed: 0,
    scoped: 0,
    rejected: 0,
    [UNLABELED_GROUNDING]: 0,
  }
  for (const entry of entries) {
    const key = isGrounding(entry.grounding) ? entry.grounding : UNLABELED_GROUNDING
    counts[key] += 1
  }
  return counts
}

/** 中文标签；`undefined` → 「未标注」 */
export function groundingLabel(grounding: Grounding | undefined): string {
  return grounding === undefined ? '未标注' : GROUNDING_LABELS[grounding]
}

/**
 * 渲染标记（拼接用）：**只对需警觉的值**给标记，其余留空。
 *
 * - `proposed` → `[我的提议]`（**最重要的一个**：它不是主人的指令）
 * - `scoped`   → `[限范围]`（主人接受但有条件 ⇒ 别当无条件授权用）
 * - `established` / 未标注 → **空串**（常态，打标记会淹没上面两条）
 */
export function groundingTag(grounding: Grounding | undefined): string {
  if (grounding === undefined || !ALERTING.includes(grounding)) return ''
  return `[${GROUNDING_LABELS[grounding]}]`
}

/**
 * 汇总结论（自审用）：库里有多少「我提的、主人未回应」的条目。
 * @returns 人可读的一行，供审查场景直接贴出
 */
export function groundingVerdict(counts: Record<Grounding | typeof UNLABELED_GROUNDING, number>): string {
  const total = counts.established + counts.proposed + counts.scoped + counts.rejected + counts[UNLABELED_GROUNDING]
  if (total === 0) return '库里没有条目。'
  const parts = [
    `已建立 ${counts.established}`,
    `**我的提议 ${counts.proposed}**`,
    `限范围 ${counts.scoped}`,
    `已被否决 ${counts.rejected}`,
    `未标注 ${counts[UNLABELED_GROUNDING]}`,
  ]
  const alerts: string[] = []
  if (counts.proposed > 0) {
    alerts.push(`⚠ ${counts.proposed} 条是「**我提的、主人未回应**」——不得当作授权使用。`)
  }
  if (counts.rejected > 0) {
    alerts.push(`⚠ ${counts.rejected} 条是「**主人否决过**」——不得旧事重提（除非主人重新提起）。`)
  }
  if (counts[UNLABELED_GROUNDING] > 0) {
    alerts.push(`⚠ ${counts[UNLABELED_GROUNDING]} 条**未标注**：其中若混有「我提的」条目，它们现在与「已建立」长得一样（本维度的已知残留，靠回填补）。`)
  }
  return `约定状态：${parts.join(' · ')}（共 ${total}）。${alerts.length > 0 ? ' ' + alerts.join(' ') : ' 无待警觉项。'}`
}
