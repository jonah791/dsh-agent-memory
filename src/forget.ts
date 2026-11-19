/**
 * §10.4 遗忘传播：把「删一条记忆」变成**逐面处理计划**。
 *
 * 设计正本 `docs/design/aml-forget.md`（九处传播面 × 本插件的真实载体）。
 * 方案出处 `docs/plans/智能体记忆图书馆实施方案.md` §10.4。
 *
 * 为什么是纯函数：传播面计算要能逐个面单测，而「写」分散在四个 Store 里
 * （entries / relations / 侧车 / 宿主日志）。把「算什么」与「写什么」分开，
 * 判据才能只测前者——F2（面完整）与 F4（未覆盖面必报）都在这一层可证伪。
 *
 * 为什么「未覆盖面」是一个必填字段而不是注释：方案列了九处，本插件只拥有其中七处
 * 的一部分。少了这一格，反馈会让人以为九处都处理了——**窄的地方不会自己报错**。
 */

/** 方案 §10.4 列出的九处传播面（外加「用户画像」的实体档分支）。 */
export type ForgetSurfaceName =
  | 'entry'        // 条目本体（含 revisions 快照——它们存在条目内部）
  | 'derived'      // 自动生成的摘要（archiveRef 指回原料）
  | 'relations'    // 知识图谱关联节点（类型化边的 from/to）
  | 'access-trace' // 用量侧车（只存 {atMs, ids}，**无内容**）
  | 'entities'     // 用户画像 / 实体权威档
  | 'host-log'     // 原始来源：宿主会话事件日志
  | 'backup'       // 备份副本与其过期策略

/** 一个面的处置结果。`count` 是**实际被处理的条数**，0 与「没跑」必须可区分。 */
export interface ForgetSurface {
  surface: ForgetSurfaceName
  action: string
  count: number
}

/** 本插件不拥有、因而无法传播的面。**必须带原因**，否则读者无从判断该找谁。 */
export interface UnownedSurface {
  surface: ForgetSurfaceName
  why: string
}

/** 派生条目所需的最小投影；调用者传入已受读权限过滤的集合。 */
export interface ArchiveRefNode {
  id: string
  archiveRef?: readonly string[]
}

/**
 * 从权威 `archiveRef` 字段按需求目标的后代闭包。
 * 只读取调用者传入的可读视图，不落盘第二份图；循环与多原料边由 visited 集合去重。
 */
export function archiveRefDescendants(
  entries: readonly ArchiveRefNode[],
  targetIds: readonly string[],
): DerivedDescendant[] {
  const seen = new Set(targetIds)
  let frontier = new Set(targetIds)
  const found: DerivedDescendant[] = []
  let depth = 0

  while (frontier.size > 0) {
    depth += 1
    const next = new Set<string>()
    for (const entry of entries) {
      if (seen.has(entry.id)) continue
      if ((entry.archiveRef ?? []).some((sourceId) => frontier.has(sourceId))) next.add(entry.id)
    }
    if (next.size === 0) break
    for (const id of next) {
      seen.add(id)
      found.push({ id, depth, disposition: 'review-required' })
    }
    frontier = next
  }

  return found.sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id))
}

/** 一次遗忘的输入：调用方先把可读条目与关系边取好，纯函数不碰 IO。 */
export interface DerivedDescendant {
  /** 派生后代条目 id（只从调用者当前可读的条目集合中派生） */
  id: string
  /** 沿 `archiveRef` 从本次目标到此后代的最短边数；1=直接引用 */
  depth: number
  /** 发现不是删除：仍需人工检查是否重压或保留 */
  disposition: 'review-required'
}

export interface ForgetPlanInput {
  /** 被遗忘的条目 id */
  entryId: string
  /** 当前可读条目集合内，经 `archiveRef` 求得的全部派生后代（直接与嵌套） */
  derivedEntries: DerivedDescendant[]
  /** `from` / `to` 命中 `entryId` 且**仍有效**的关系边 id（需要退役，不是删除） */
  liveRelations: string[]
}

export interface ForgetPlan {
  surfaces: ForgetSurface[]
  derivedEntries: DerivedDescendant[]
  derivedCoverage: 'caller-readable-view'
  unowned: UnownedSurface[]
}

/**
 * 一条删除凭证（方案 §10.4 的「最小化删除处理凭证」）。
 *
 * ⚠ **字段是白名单**：新增一个字段前先问「它会不会把被删内容带回来」。
 * 最小化判据可证伪——拿被删条目的 title/body 去 grep 凭证文件，命中即违反（F3）。
 *
 * 它存在的理由：`archivedReason` 住在条目里，而条目本身会随归档/清理消失；
 * 凭证住独立侧车，回答「这条为什么没了」而**不需要记住它是什么**。
 */
export interface ForgetCertificate {
  certId: string
  at: string
  mode: 'entry' | 'topic' | 'all'
  scope: string
  /** 逐面结果。⚠ 空数组不是「没有传播面」，是「没跑传播」——两者必须可区分。 */
  surfaces: ForgetSurface[]
  /** 当次发现的派生后代审计快照，不是另一份血缘真源。 */
  derivedEntries: DerivedDescendant[]
  /** 派生清单仅覆盖调用者当前可读视野。 */
  derivedCoverage: 'caller-readable-view'
  /** 命中条目的 id（随机 uuid，无内容）。不存标题 / 正文 / 来源。 */
  ids: string[]
  reason?: string
  /** 归档原因类型（取值同 `ArchiveReasonType`，此处用 string 避免为类型引入循环依赖）。 */
  reasonType: string
  /** 未覆盖的面与原因。**必填**——它是最容易被省掉、也最不能省的一格。 */
  unowned: UnownedSurface[]
}

/**
 * 本插件**永远不拥有**的三处（方案九处里的三处）。
 *
 * 每次遗忘都原样带出——不是模板噪音：这三处的过期策略分别由宿主、仓库与快照层决定，
 * 而调用方（我）只有看到它们才会去那三层处理，否则「已经忘记」就是一句谎。
 */
export const UNOWNED_SURFACES: readonly UnownedSurface[] = Object.freeze([
  { surface: 'host-log' as const, why: '原文在宿主会话事件日志（compaction-sink 只写入条目、不持有原文）；最小化由宿主层负责，本插件无删除权' },
  { surface: 'backup' as const, why: '备份副本的过期策略由仓库历史与快照层决定，本插件不持有备份' },
  { surface: 'entities' as const, why: '实体权威档没有 `entry → entity` 边（§4.3 已知缺口）⇒ 无法确定「哪些画像来自这条记忆」；按名称命中的候选只作**推断**列出，不自动改档' },
])

/**
 * 算出一条记忆被遗忘时，各面要做什么。
 *
 * 三个不变量（实现时若违反，宁可让判据红）：
 * 1. **`access-trace` 永远出现在结果里且 `count` 恒 0**——它只存随机 id 与时刻，
 *    删它不减少任何暴露面，只毁掉用量归因。沉默地不列它，读者会以为漏了一处。
 * 2. **`derived` 只清引用、不删概要本身**——删的是「原料」，而概要是独立成立的结论。
 *    概要是含该原料的派生内容 ⇒ 数量报出来，是否一并处置交给人判断（不猜）。
 * 3. **`relations` 是退役不是删除**——`validTo` 置时刻，记录保留：
 *    「它曾经成立」与「它从来没存在过」是两件事。
 *
 * @param input - 已取好的三处数据
 * @returns 逐面结果 + 未覆盖面；`surfaces` 的顺序稳定（本体 → 派生 → 关系 → 侧车）
 */
function derivedAction(derivedEntries: readonly DerivedDescendant[]): string {
  const direct = derivedEntries.filter((item) => item.depth === 1).length
  const nested = derivedEntries.length - direct
  return derivedEntries.length > 0
    ? `当前可读视野中发现 ${derivedEntries.length} 条 archiveRef 派生后代（直接 ${direct} / 嵌套 ${nested}）；派生内容可能同时依赖其他原料，不自动归档，待判断`
    : '当前可读视野中未发现 archiveRef 派生后代'
}

export function planForget(input: ForgetPlanInput): ForgetPlan {
  const derivedEntries = input.derivedEntries
    .map((item) => ({ ...item }))
    .sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id))
  const surfaces: ForgetSurface[] = [
    {
      surface: 'entry',
      // ⚠ 不提供硬删除，而且**要在反馈里说出来**：本插件删得掉 entries 表，删不掉
      // 宿主会话日志（原文）与备份层——单方面 purge 会让人以为「已经删干净」，而那份原文
      // 还在别处。**声称删干净的伤害大于不做**，所以这一格写的是边界不是能力。
      action: '软归档（archived:true，不再进活跃检索；includeArchive 仍可找回）——本插件不提供硬删除：真删要同时覆盖宿主会话日志与备份层，单插件删不干净，声称「已删」比不做更伤人',
      count: input.entryId === '' ? 0 : 1,
    },
    {
      surface: 'derived',
      action: derivedAction(derivedEntries),
      count: derivedEntries.length,
    },
    {
      surface: 'relations',
      action: input.liveRelations.length > 0
        ? `退役 ${input.liveRelations.length} 条仍有效的边（写 validTo，记录保留）`
        : '无仍有效的关系边指向它',
      count: input.liveRelations.length,
    },
    {
      surface: 'access-trace',
      // 恒定 0 条：写死不是偷懒，是这个面**结构上不含内容**（见 access-trace.ts 的记录形态）
      action: '不处理——侧车只存 {atMs, ids[]}，不含标题/正文/来源，删它不减少暴露面',
      count: 0,
    },
  ]
  return {
    surfaces,
    derivedEntries,
    derivedCoverage: 'caller-readable-view',
    unowned: UNOWNED_SURFACES.map((item) => ({ ...item })),
  }
}

/** 反馈形状：逐面 + 总量 + 未覆盖面。三样缺一，读者就会把「没报」当成「没这回事」。 */
export interface ForgetFeedback {
  processed: number
  surfaces: ForgetSurface[]
  derivedEntries: DerivedDescendant[]
  derivedCoverage: 'caller-readable-view'
  unowned: UnownedSurface[]
}

/**
 * 把多条条目的计划合并成一份反馈（批量遗忘用）。
 *
 * 合并的是**计数**，不是计划本身：`entry` 面的 count 求和，其余面按 surface 求和。
 * 未覆盖面只保留一份（它们是常量）。
 *
 * @param plans - 每条条目各自的计划
 * @returns 汇总反馈
 */
export function mergeForgetPlans(plans: ForgetPlan[]): ForgetFeedback {
  const bySurface = new Map<ForgetSurfaceName, ForgetSurface>()
  const derivedById = new Map<string, DerivedDescendant>()
  for (const plan of plans) {
    for (const item of plan.surfaces) {
      const current = bySurface.get(item.surface)
      if (current === undefined) {
        bySurface.set(item.surface, { ...item })
      } else {
        current.count += item.count
        // 动作措辞取多条目合并后的说法：单条措辞里的数字会失真，故只保留面级说明
        current.action = item.count > 0 ? item.action : current.action
      }
    }
    for (const item of plan.derivedEntries) {
      const current = derivedById.get(item.id)
      if (current === undefined || item.depth < current.depth) derivedById.set(item.id, { ...item })
    }
  }
  const derivedEntries = [...derivedById.values()]
    .sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id))
  const derivedSurface = bySurface.get('derived')
  if (derivedSurface !== undefined) {
    derivedSurface.count = derivedEntries.length
    derivedSurface.action = derivedAction(derivedEntries)
  }
  const first = plans[0]
  return {
    processed: plans.length,
    surfaces: [...bySurface.values()],
    derivedEntries,
    derivedCoverage: 'caller-readable-view',
    unowned: first === undefined ? UNOWNED_SURFACES.map((item) => ({ ...item })) : first.unowned,
  }
}
