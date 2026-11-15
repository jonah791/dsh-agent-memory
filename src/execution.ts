/**
 * 执行位置维（v0.23.0「这条记忆是在哪得到的」）——记忆的**执行归属**，不是准入。
 *
 * ## 为什么有它（两条依据，一条来自主人，一条来自论文）
 *
 * **依据一（主人 2026-11-15 架构定调，三句原文）**：
 *   「Project 不应该属于 Agent，也不属于 Session。Agent 和 Session 只是项目的执行者。」
 *   「Session 是执行历史，不是项目状态。Memory 是模型的上下文辅助，不是项目的权威记忆。
 *     Project State Manager 是所有 Agent 共享的事实来源。」
 * ⇒ 项目状态的**权威**在 `dsh-project-state`；本维不是第二个权威，它只回答
 *   「**这条记忆是在哪个项目、哪个任务里得到的**」——一个**语义标记**，用于聚合与过滤。
 *
 * **依据二（MAGE · EMNLP 2026 · aclanthology.org/2026.emnlp-main.828）**：
 * 论文的实测结论是：现有 agent 记忆系统按**语义相似度**组织，在长任务上必然导致
 *   ① **状态碎片化**——决策链被打散成「内容相关的几条」，重建不出完整状态；
 *   ② **错误无法隔离**——对的错的混在同一相关空间，检索时一起浮上来。
 * 它的解法是把记忆组织成**执行状态树**，当前状态 = **根到当前的路径**（不是检索组装）。
 *
 * ⇒ **本维是那棵树落到本插件上的最小形状**：`project` 是「哪棵树」，`taskId` 是「树上哪个节点」。
 *   只有 `project` 等于**按池子分家**（还是语义组织）；加上 `taskId` 才够得着**路径**——
 *   「这个任务一路留下了什么」可以按顺序取出来，而「内容相关但属于别处的条目」不会混进来。
 *
 * ⚠ **本维刻意不做论文的另外两件**（做了就是过度设计，理由留在这里免得将来被「对齐」上）：
 *   1. **不做 Maintain（摘要对底稿验真）**：本插件的摘要（时间桶概要）原料是条目本身、
 *      就在同一个库里，`archiveRef` 已经让它可查；再引入一层 LLM 验真，代价落在每次写入上，
 *      而收益只在「概要写错」这一种情形——本插件至今没有该情形的实例。
 *   2. **不做 Revise（回退到边界重来）**：MAGE 敢这么做，是因为它的环境是**可快照可重放**的
 *      模拟器（代码 `_do_backtrace` 最后一步调 `_on_backtrace_env_restore`）。我的世界里
 *      文件改了就是改了、消息发了就是发了——**记忆层的「回退」只能是逻辑分支（新写一条），
 *      不能是物理回退**。用 `forget` + 新条目表达即可，不需要新机制。
 *
 * ## 与 `scope` 的分工（**两维正交，不可互换**）
 *
 *   - `scope` 答「**存到哪个分区 / 谁看得见**」：`global` 或 workspaceId（**绝对路径规范化**）。
 *     它是**准入**（条目在检索之前被剔除），所以它有总开关、有安全后果。
 *   - `project` / `taskId` 答「**在哪得到的**」：`alice` / `pp` + 任务 id，或不设（通用）。
 *     它们是**可选筛子**（只是不匹配就不返回），不改变任何条目的可见性。
 *
 * ⚠ **为什么不把项目塞进 scope**（三条理由，任一条都足以否掉）：
 *   1. scope 已承载**读写路由**（决定落在哪个库段）——改它的语义等于改准入，有安全后果；
 *   2. scope 的值是**路径**，目录改名 / 换盘 / 换个成员目录就会漂；project 是**语义 id**，稳定；
 *   3. 同族先例：`subject` 与 `role` 刻意分离（语义标记 ≠ 准入），本维与 scope 照同一纪律。
 *
 * ## 与 `subject` 的同构与三点刻意不同
 *
 * **同构**：都是平级标量、都是可选筛子、都**不做准入**、都允许显式纠正
 * （否则存量几百条永远无法标注，维度等于白建）。荒谬性检验同样成立：
 * 「我记不住这个项目里发生过什么」不该是机制能造成的结果。
 *
 * **不同 1 · 没有枚举，因此没有「未知取值」可报**。`subject` 只有 self/master，
 * 参数入口能 fail-loud（拼错当场报错）。project 是**开放集合**（任何项目 id 都合法），
 * ⇒ 只能校验**形状**（非空 / 无控制字符 / 长度上限），校验不了「存在性」。
 * 存在性由写入侧的另一条路保证：`index.ts` 的自动盖章只在
 * `resolveProjectByPath(cwd)` **返回了真项目**时才写——它天然只产出已注册的 id。
 * ⇒ 判据边界写清楚：**本模块保证「形状合法」，不保证「项目存在」**。
 *
 * **不同 2 · 没有别名表**。`subject` 的别名表（「我」→ self）能建，是因为取值域封闭；
 * project 的取值域开放，别名表只会把不同项目撞在一起（`pp` 与 `pp-strategy` 谁是谁的别名？
 * 无法判定）。⇒ **认不出就是不设**，绝不猜。
 *
 * **不同 3 · 两级结构且不可拆**。`subject` 是单级标量；`project` + `taskId` 是两级，
 * 且 **`taskId` 只在 `project` 内唯一**（`ps-4a2b` 在 alice 与 pp 里可以是两个任务）。
 * ⇒ **给 taskId 必须同时给 project**，否则二义（见 `parseExecutionArgs` 的 fail-loud）。
 *
 * **信任边界（诚实声明）**：本维是语义标记，不是授权。它不阻止任何人读任何条目——
 * 要隔离请用 `role` 隔间或独立 DSH_HOME。
 *
 * 纯函数层：不依赖 Cordis / fs，离线可测（tests/execution.test.mjs）。
 */

import type { Entry } from './types.ts'

/** 未标项目（通用层）在统计里的键名 */
export const UNSPECIFIED_PROJECT = 'unspecified'

/**
 * project / taskId 的长度上限。
 *
 * 为什么是 64：它们是**人类可读的短标识**（`alice` / `ps-4a2b`），不是标题。
 * 过长说明调用方把「描述」塞进了「标识」——那种内容该进 tags 或正文。
 * 上限的作用不是审美，是**让放错位置的东西当场被拒**（fail-loud 的意图）。
 */
export const MAX_EXECUTION_ID_LENGTH = 64

/** 控制字符 / 换行：出现在标识里一定是放错了位置（会破坏渲染与日志行） */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

/** 通用形状归一（两级共用：project 与 taskId 的形状规则完全相同） */
function normalizeIdentifier(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (trimmed.length === 0) return undefined
  if (trimmed.length > MAX_EXECUTION_ID_LENGTH) return undefined
  if (CONTROL_CHARS.test(trimmed)) return undefined
  return trimmed
}

/**
 * 归一项目 id（**容错路径**，用于读取历史数据与回流服务）。
 *
 * @param raw - 任意输入
 * @returns 规范 id；`undefined` = **通用**（空、未给、或认不出）
 *
 * ⚠ 工具**参数**入口不走这里——见 `parseExecutionArgs`（那里 fail-loud）。
 * ⚠ 不做大小写折叠：项目 id 是调用方定义的标识，`PP` 与 `pp` 可能是两个项目。
 */
export function normalizeProject(raw: unknown): string | undefined {
  return normalizeIdentifier(raw)
}

/** 归一任务 id（容错路径；语义见文件头「不同 3」） */
export function normalizeTaskRef(raw: unknown): string | undefined {
  return normalizeIdentifier(raw)
}

/** 是否为可用项目 id（用于校验而非归一） */
export function isProject(value: unknown): value is string {
  return normalizeProject(value) !== undefined
}

/** 执行位置过滤条件（两级都可选，语义见 `filterByExecution`） */
export interface ExecutionFilter {
  /** 执行领域（项目 id）。`undefined` = 不按项目筛 */
  project?: string
  /** 执行节点（任务 id）。**给它必须同时给 project**（见文件头「不同 3」） */
  taskId?: string
}

/**
 * 解析执行位置的**工具参数**（**fail-loud**）：形状非法抛错，不静默当通用。
 *
 * 与 `normalizeProject` 分流的两条路径语义（与 `subject.ts` 同一纪律）：
 *   - **参数**是「我此刻的意图」——写错了必须**当场**知道，静默降级成通用 =
 *     我以为标上了、其实没标（本插件反复栽过的静默失败形状）；
 *   - **历史数据**是「既成事实」——读到认不出的值不该让整次检索崩掉。
 *
 * @param args - 工具参数原值（`project` / `taskId`）
 * @param fieldPrefix - 报错里用的字段名前缀（便于定位是哪个工具）
 */
export function parseExecutionArgs(
  args: { project?: unknown; taskId?: unknown },
  fieldPrefix = '',
): ExecutionFilter {
  const at = fieldPrefix === '' ? '' : `${fieldPrefix}.`
  const project = parseExecutionId(args.project, `${at}project`)
  const taskId = parseExecutionId(args.taskId, `${at}taskId`)

  // 两级不可拆：taskId 只在 project 内唯一，单给 taskId 是二义的
  if (taskId !== undefined && project === undefined) {
    throw new Error(
      `${at}taskId: 给了任务 id 就必须同时给 ${at}project——`
      + '任务 id 只在项目内唯一，跨项目无法判定（见 execution.ts 文件头「不同 3」）',
    )
  }

  return {
    ...(project !== undefined ? { project } : {}),
    ...(taskId !== undefined ? { taskId } : {}),
  }
}

/**
 * 单字段参数解析（空串 = 清除语义，返回 `undefined`；非法形状抛错）。
 *
 * **为什么导出**：`update` 的「就地修改」路径不能走 `parseExecutionArgs`——
 * 那里按「条目修改**之后**的状态」判断合法性，而条目可能**已经有** project，
 * 此时单给 taskId 是合法的。`parseExecutionArgs` 是「新建」视角（两级必须同批给），
 * 两者判据不同，不能共用。
 */
export function parseExecutionId(raw: unknown, field: string): string | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') {
    throw new Error(`${field}: 必须是字符串（短标识），实际类型 ${typeof raw}`)
  }
  const trimmed = raw.trim()
  // 空串是**合法**的清除语义（update 用它把标记删掉）——与 subject 的「空串 = 清除」一致
  if (trimmed.length === 0) return undefined
  if (trimmed.length > MAX_EXECUTION_ID_LENGTH) {
    throw new Error(
      `${field}: 过长（${trimmed.length} > ${MAX_EXECUTION_ID_LENGTH}）——`
      + '它是短标识（如 alice / pp / ps-4a2b），描述性内容请放进正文或 tags',
    )
  }
  if (CONTROL_CHARS.test(trimmed)) {
    throw new Error(`${field}: 不得包含控制字符或换行（会破坏渲染与日志行）`)
  }
  return trimmed
}

/**
 * 按执行位置筛条目（**可选筛子**，不是准入——见文件头）。
 *
 * 语义（级联，从粗到细）：
 *   - 空条件（两者都不给）→ **不过滤**（原样返回**同一数组引用**，零拷贝）
 *   - 只给 project → 该项目的全部（含其下所有任务）
 *   - 给 project + taskId → 该任务的条目
 *   - 只给 taskId → **不提供**（二义；参数入口已 fail-loud，容错路径按 `project` 缺失处理
 *     ⇒ 等于不过滤，绝不跨项目猜）
 *
 * ⚠ **零拷贝是硬判据**（不是「结果看起来一样」）：空条件时必须返回同一引用——
 * 这是「存量无该字段的条目行为逐字节不变」的机械证明。
 */
export function filterByExecution(entries: Entry[], filter: ExecutionFilter): Entry[] {
  const project = normalizeProject(filter.project)
  const taskId = project === undefined ? undefined : normalizeTaskRef(filter.taskId)
  if (project === undefined) return entries
  return entries.filter((entry) => {
    if (entry.project !== project) return false
    return taskId === undefined || entry.taskId === taskId
  })
}

/**
 * 项目计数（memory_stats / 体检用）：每个已知 id 的条数 + 未标注。
 *
 * 返回的键按条数降序，`unspecified` 恒置末位（它是「不知道」，不是某一个项目）。
 */
export function countByProject(
  entries: readonly Pick<Entry, 'project'>[],
): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const entry of entries) {
    const key = normalizeProject(entry.project) ?? UNSPECIFIED_PROJECT
    counts[key] = (counts[key] ?? 0) + 1
  }
  const ordered: Record<string, number> = {}
  for (const [key, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    if (key !== UNSPECIFIED_PROJECT) ordered[key] = n
  }
  if (counts[UNSPECIFIED_PROJECT] !== undefined) {
    ordered[UNSPECIFIED_PROJECT] = counts[UNSPECIFIED_PROJECT]!
  }
  return ordered
}

/**
 * 渲染标记（拼接用）：`[项目:alice]` / `[项目:alice/ps-4a2b]`，通用层给**空串**。
 *
 * 通用层**必须留空**：库里绝大多数条目是通用的，给它们都打标记只会淹没真正需要被看见的
 * 那几条（同 `subjectTag` 的教训：标记也要挑着打）。
 *
 * ⚠ 容错路径的取舍：历史数据里出现「有 taskId 无 project」时**整条标记丢弃**——
 * 无项目的任务 id 无法定位，渲染出来只会误导（读成「某个叫 ps-4a2b 的项目」）。
 * 这类条目仍能按 taskId 精确查（`filterByExecution` 不会用它们），只是不带标记显示。
 */
export function executionTag(project: string | undefined, taskId: string | undefined): string {
  const p = normalizeProject(project)
  if (p === undefined) return ''
  const t = normalizeTaskRef(taskId)
  return t === undefined ? `[项目:${p}]` : `[项目:${p}/${t}]`
}
