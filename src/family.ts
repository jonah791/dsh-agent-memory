/**
 * 家族折叠（v0.16.0）——记忆的**同源占位**治理（论文 Memory Echo / FPA 的 Family 组件）。
 *
 * 动机（论文 Memory Echo · arXiv:2610.17763v1 · 主人 2026-10-14 交办）：
 * 论文定义 **Memory Echo** = 「同一来源的历史信息，在**没有新增独立证据**的情况下，
 * 通过反复检索 + 写回获得的**超额检索曝光**」。核心判据是论文 §5.1 的一句：
 * **「Repeated writes therefore add records, not independent votes」**——
 * 同一来源派生出的多条记录，**不该被当作多个独立证据**去占检索位。
 *
 * 本插件的对应物（不需要新标注，用已有字段）：**时间桶概要与其 `archiveRef` 原料**
 * 本来就是同源派生（`timeline.ts` 写概要时把当日原料列进 `archiveRef`）。
 * 默认视图下原料已冷归档 ⇒ 二者不会同时命中；但 `includeArchive=true`
 * （`memory_browse` / 体检 / 带参的 recall）时它们会一起进候选池，各占一位。
 *
 * ⚠ **局部而非全局**（2026-10-14 实测教训 · 勿「优化」成连通分量）：
 * 初版曾用**全库并查集**把 `archiveRef` 连成家族，实测**最大族 156 条**——
 * 因为周概要引用日概要、日概要引用当日条目，**整条时间线连成一片**。
 * 那样折叠等于砍掉上下文，正是论文自证的那一坑（Family 单独上线 0.825 → **0.651**）。
 * ⇒ 本函数**只看本次候选池内**的直接父子关系，族规模天然被候选池大小限住。
 *
 * ⚠ **默认关闭**：论文消融显示 Family 只有与「当前事实优先」（Authority）配对才不掉分，
 * 而后者本插件尚无 ⇒ 先提供**可选**手段，待有配套再议默认值（负结果见测试）。
 *
 * ⚠ **不删数据**（论文 §5.1：「source grouping does not delete the unselected records」）：
 * 未选中的同族条目只是**不占本次服务位**，仍可显式取回（返回里附折叠清单）。
 *
 * 纯函数层：不依赖 Cordis / fs，离线可测（tests/family.test.mjs）。
 */

import type { Entry } from './types.ts'

/** 折叠输入项：任意带条目与分数的对象（recall 的打分结果） */
export interface ScoredLike {
  entry: Entry
  score: number
}

/** 一个被折叠的族：代表 + 未占位的成员 */
export interface CollapsedFamily {
  /** 族键（族内 id 字典序最小者，确定性；用于日志与测试断言） */
  key: string
  /** 代表的条目 id（族内得分最高者；并列取 id 字典序小者） */
  representativeId: string
  /** 未被选中的同族成员 id（**仍在库里**，只是本次不占位） */
  foldedIds: string[]
}

/** 折叠结果 */
export interface CollapseResult<T extends ScoredLike> {
  /** 折叠后仍需占位的项（保持输入顺序的过滤视图） */
  kept: T[]
  /** 被折叠掉的项 id → 其所属族的代表 id */
  foldedTo: Map<string, string>
  /** 发生折叠的族（无折叠时为空数组） */
  families: CollapsedFamily[]
}

/**
 * 家族折叠（纯函数）：在**候选池内**，把「概要 + 它的 archiveRef 目标」归为一族，
 * 每族只保留**一个代表**（族内得分最高者），其余折叠。
 *
 * 族的构建规则（确定性，不依赖输入顺序）：
 *  1. 父指针 = 候选池里**有 `archiveRef`** 的条目（概要）；其**也在池内**的 ref 目标为子；
 *  2. 一个条目被多个概要引用时，归给 **id 字典序最小**的那个概要（避免顺序敏感）；
 *  3. 概要自身若也是别的概要的 ref 目标 ⇒ 归给那个更上层的概要（同一规则）；
 *  4. 无 `archiveRef` 且不被任何池内概要引用的条目 ⇒ **独立族**（永不折叠）。
 *
 * @param scored - 候选池（已打分；本函数**不重排**，只做子集筛选）
 * @returns 保留项 / 折叠映射 / 族清单
 */
export function collapseFamilies<T extends ScoredLike>(scored: readonly T[]): CollapseResult<T> {
  const byId = new Map<string, T>()
  for (const item of scored) byId.set(item.entry.id, item)

  // 子 → 父（多个父时取字典序最小者，保证与输入顺序无关）
  const parentOf = new Map<string, string>()
  for (const item of scored) {
    const refs = item.entry.archiveRef
    if (refs === undefined || refs.length === 0) continue
    const parentId = item.entry.id
    for (const refId of refs) {
      // 只处理**池内**目标（池外的不参与本次折叠）
      if (!byId.has(refId)) continue
      if (refId === parentId) continue
      const prev = parentOf.get(refId)
      if (prev === undefined || parentId < prev) parentOf.set(refId, parentId)
    }
  }

  // 族键 = 沿父链上溯到族首（父链在池内是有限的且无环：archiveRef 只会指向更早的条目）
  const rootCache = new Map<string, string>()
  const rootOf = (id: string): string => {
    const cached = rootCache.get(id)
    if (cached !== undefined) return cached
    const seen = new Set<string>([id])
    let cur = id
    for (;;) {
      const parent = parentOf.get(cur)
      if (parent === undefined) break
      if (seen.has(parent)) break // 防御：环（不应发生）即停，不让坏数据挂死
      seen.add(parent)
      cur = parent
    }
    rootCache.set(id, cur)
    return cur
  }

  // 按族分组，族内选代表（得分高者；并列取 id 字典序小者 —— 确定性）
  const groups = new Map<string, T[]>()
  for (const item of scored) {
    const root = rootOf(item.entry.id)
    const bucket = groups.get(root)
    if (bucket === undefined) groups.set(root, [item])
    else bucket.push(item)
  }

  const keptSet = new Set<string>()
  const foldedTo = new Map<string, string>()
  const families: CollapsedFamily[] = []
  for (const [root, members] of groups) {
    // 分组时必然 push 过至少一项 ⇒ 首项存在；显式取值而非索引断言（tsc 严格档）
    const first = members[0]
    if (first === undefined) continue
    if (members.length === 1) {
      keptSet.add(first.entry.id)
      continue
    }
    let rep: T = first
    for (const m of members) {
      if (m.score > rep.score) rep = m
      else if (m.score === rep.score && m.entry.id < rep.entry.id) rep = m
    }
    keptSet.add(rep.entry.id)
    const foldedIds: string[] = []
    for (const m of members) {
      if (m.entry.id === rep.entry.id) continue
      foldedIds.push(m.entry.id)
      foldedTo.set(m.entry.id, rep.entry.id)
    }
    foldedIds.sort()
    families.push({ key: root, representativeId: rep.entry.id, foldedIds })
  }

  families.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return { kept: scored.filter((item) => keptSet.has(item.entry.id)), foldedTo, families }
}

/**
 * 折叠说明行（渲染用）：把折叠结果压成一句人读的话；无折叠返回 `undefined`（不打噪声）。
 *
 * 信噪比纪律同 `groundingTag` / `stalenessTag`：**只在真发生折叠时**出文案。
 */
export function renderFamilyNote(families: readonly CollapsedFamily[], labelOf: (id: string) => string): string | undefined {
  if (families.length === 0) return undefined
  const foldedTotal = families.reduce((sum, f) => sum + f.foldedIds.length, 0)
  const detail = families
    .slice(0, 3)
    .map((f) => `${labelOf(f.representativeId)}（+${f.foldedIds.length} 条同源）`)
    .join(' · ')
  const more = families.length > 3 ? ` 等 ${families.length} 族` : ''
  return `同源折叠：${foldedTotal} 条未占位（${detail}${more}）——它们是同一来源的派生，仍有档可查（includeArchive）`
}
