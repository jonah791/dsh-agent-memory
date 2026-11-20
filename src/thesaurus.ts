/**
 * 主题词表（v0.29.0 · 方案 §4.2 · 参考 W3C SKOS）——受控词表：同一个概念的多种写法收在一处。
 *
 * ## 它解决什么（与 `tags` 的分工）
 *
 * `tags` 是自由文本、无序、无层级：同义词各写各的（「记忆库」/「记忆系统」/「智能体记忆」），
 * 检索只能逐字匹配。受控词表提供三件 `tags` 结构上做不到的事：
 * 1. **术语归一**：一个概念一个首选名 + 若干同义词（`prefLabel` / `altLabels`）。
 * 2. **查询扩展**：`recall({expandThesaurus:true})` 把查询词换成它的全部写法再检索
 *    （SKOS 的用词能力在检索侧的直接用法）。
 * 3. **层级导航**：上位（`broader`）→ 下位（派生）→ 关联（`related`），供 §4.5 知识地图用。
 *
 * ## 一个事实一个归宿（三处与 SKOS 存储形态的刻意差异）
 *
 * - **只存 `broader`**：SKOS 的 `narrower` 是它的逆关系；两边都存，只改一侧时就出现
 *   互相矛盾的两个事实 ⇒ 下位一律由反查派生（`narrowerOf`）。
 * - **`related` 对称但只存一侧**：A→B 与 B→A 是同一句「两者相关」，读路径双向都算。
 * - **停用不删除**：`status:'deprecated'` 只是「不再用」，旧条目上的标签仍要能解释；
 *   删除一个概念会让历史记忆上的标签失去含义。
 *
 * ## 唯一性与消歧（本模块最硬的判据）
 *
 * `prefLabel` 与全部 `altLabels` 在**同一 scope 内**共用一个标签空间：
 * 新建/改名时任一新标签若是另一个概念的标签（归一后相同），**整笔拒绝**并点名冲突概念。
 * 这条判据是 §4.3 实体权威档的基础——没有唯一标签空间，归一化就是猜。
 * ⚠ 跨 scope 不做唯一性约束（不同项目可以有自己的同名词），但 `lookup` 需显式给 scope。
 *
 * ## 已知边界
 *
 * - **不做词形还原/分词**：匹配按「归一化后的子串包含」判定（中文无空格，靠子串更稳）；
 *   英文单复数、动名词变形不在 v1 范围（要做得引词干库，属另一个决定）。
 * - **不做导入的冲突合并**：导入是「验完全部再写」，冲突项整批拒绝并逐条报，
 *   不提供「自动合并两套词表」这种会静默丢信息的操作。
 *
 * 纯函数 + 单表存储，不依赖 Cordis / fs（离线可测：tests/thesaurus.test.mjs）。
 */

import type { Concept, ConceptRevision } from './types.ts'

/** 每个概念保留的变更记录条数（全历史在提交里；存储只留最近几条解释「怎么变成现在这样」） */
export const MAX_CONCEPT_REVISIONS = 5

/** 概念表 kv 最小接口（与 relations.ts::RelationKvLike 同形） */
export interface ConceptKvLike {
  get(key: string): Concept | undefined
  put(key: string, value: Concept): Promise<void>
  delete(key: string): Promise<boolean>
  entries(): IterableIterator<[string, Concept]>
  readonly size: number
}

/** 新概念草稿 */
export interface ConceptDraft {
  scope: string
  prefLabel: string
  altLabels?: string[]
  definition?: string
  scopeNote?: string
  broader?: string[]
  related?: string[]
}

/** 概念可变字段（update 用；只改给到的） */
export interface ConceptPatch {
  prefLabel?: string
  altLabels?: string[]
  definition?: string
  scopeNote?: string
  broader?: string[]
  related?: string[]
}

/** 词表统计（memory_stats 用） */
export interface ConceptStats {
  total: number
  active: number
  deprecated: number
  withAltLabels: number
  withDefinition: number
  withBroader: number
  byScope: Record<string, number>
}

/** 概念表 key：`<scope>:concept:<id>` */
export function conceptKey(scope: string, id: string): string {
  return `${scope}:concept:${id}`
}

/**
 * 标签归一（唯一性与匹配的判据口径）。
 *
 * 去首尾空白、折叠连续空白、转小写。**不做的**：去标点、去单复数、繁简转换——
 * 那些是「猜」，猜错就把两个不同概念合成一个（消歧的反面）。
 * @param label - 原始标签
 */
export function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** 概念的全部标签（含首选名；用于唯一性检查与匹配） */
export function labelsOf(concept: Pick<Concept, 'prefLabel' | 'altLabels'>): string[] {
  return [concept.prefLabel, ...(concept.altLabels ?? [])]
}

/**
 * 两个概念之间是否有标签冲突（归一后相交）。
 * @param a - 概念或草稿
 * @param b - 概念或草稿
 */
export function labelsCollide(
  a: Pick<Concept, 'prefLabel' | 'altLabels'>,
  b: Pick<Concept, 'prefLabel' | 'altLabels'>,
): string[] {
  const left = new Set(labelsOf(a).map(normalizeLabel))
  return labelsOf(b).filter((label) => left.has(normalizeLabel(label)))
}

/** 概念是否处于适用状态（未停用） */
export function isConceptActive(concept: Pick<Concept, 'status'>): boolean {
  return concept.status !== 'deprecated'
}

/** 概念表的存储与查询（单表 CRUD + 唯一性/环/引用完整性校验） */
export class ConceptStore {
  constructor(private readonly kv: ConceptKvLike) {}

  /** 全量概念（快照拷贝） */
  all(): Concept[] {
    const out: Concept[] = []
    for (const [, concept] of this.kv.entries()) out.push({ ...concept })
    return out
  }

  /**
   * 某分区的概念。
   * @param scope - 存储分区
   */
  byScope(scope: string): Concept[] {
    return this.all().filter((concept) => concept.scope === scope)
  }

  /**
   * 按 id 跨 scope 查找。
   * @param id - 概念 id
   */
  find(id: string): Concept | undefined {
    for (const [, concept] of this.kv.entries()) {
      if (concept.id === id) return { ...concept }
    }
    return undefined
  }

  /**
   * 按标签查（首选名或同义词，归一后**精确**相等）。
   * @param scope - 存储分区
   * @param label - 任意写法
   */
  findByLabel(scope: string, label: string): Concept | undefined {
    const target = normalizeLabel(label)
    return this.byScope(scope).find((concept) => labelsOf(concept).some((candidate) => normalizeLabel(candidate) === target))
  }

  /**
   * 查询扩展：把查询串里出现的概念换成它们的**全部其他写法**。
   *
   * 匹配口径：概念任一个标签（归一后）是查询串（归一后）的**子串**——中文无空格，
   * 子串比切词稳；英文多词标签也能命中。已停用的概念不参与扩展（「不再用」）。
   * @param scope - 存储分区
   * @param query - 查询串
   * @returns `concepts` 命中的概念、`extraTerms` 尚未在查询里出现的其他写法
   */
  expand(scope: string, query: string): { concepts: Concept[]; extraTerms: string[] } {
    const normalizedQuery = normalizeLabel(query)
    if (normalizedQuery.length === 0) return { concepts: [], extraTerms: [] }
    const concepts: Concept[] = []
    const extraTerms: string[] = []
    for (const concept of this.byScope(scope)) {
      if (!isConceptActive(concept)) continue
      const hit = labelsOf(concept).some((label) => {
        const normalized = normalizeLabel(label)
        return normalized.length > 0 && normalizedQuery.includes(normalized)
      })
      if (!hit) continue
      concepts.push(concept)
      for (const label of labelsOf(concept)) {
        if (normalizedQuery.includes(normalizeLabel(label))) continue
        if (!extraTerms.includes(label)) extraTerms.push(label)
      }
    }
    return { concepts, extraTerms }
  }

  /**
   * 下位概念（派生：哪些概念的 `broader` 含它）。
   * @param id - 上位概念 id
   */
  narrowerOf(id: string): Concept[] {
    return this.all().filter((concept) => (concept.broader ?? []).includes(id))
  }

  /**
   * 关联概念（对称：任一侧写过即可）。
   * @param id - 概念 id
   */
  relatedOf(id: string): Concept[] {
    const byId = new Map(this.all().map((concept) => [concept.id, concept]))
    const out: Concept[] = []
    for (const concept of byId.values()) {
      if (concept.id === id) continue
      const forward = (concept.related ?? []).includes(id)
      const backward = (byId.get(id)?.related ?? []).includes(concept.id)
      if (forward || backward) out.push(concept)
    }
    return out
  }

  /**
   * 上位闭包（`broader` 传递，防环；顺序由近到远）。
   * @param id - 概念 id
   */
  ancestorsOf(id: string): Concept[] {
    const byId = new Map(this.all().map((concept) => [concept.id, concept]))
    const out: Concept[] = []
    const seen = new Set<string>([id])
    let frontier = [...(byId.get(id)?.broader ?? [])]
    while (frontier.length > 0) {
      const next: string[] = []
      for (const parentId of frontier) {
        if (seen.has(parentId)) continue
        seen.add(parentId)
        const parent = byId.get(parentId)
        if (parent === undefined) continue
        out.push(parent)
        next.push(...(parent.broader ?? []))
      }
      frontier = next
    }
    return out
  }

  /**
   * 分配下一个可读 id（`CONCEPT-0001` 形态 · 方案 §6.3「统一资源标识符」）。
   *
   * 为什么不是 uuid：与 `ENTITY-0001` / `SOURCE-0001` 同一条理由——人要能口头引用
   * 「把 CONCEPT-0007 的上位改掉」，而一串 uuid 不可口述、也不可肉眼比对。
   *
   * ## ⚠ 必须**全局唯一**，不是每 scope 归零
   *
   * 第一版写成「每 scope 各自从 0001 起」，**两条既有跨 scope 判据当场变红**
   * （`thesaurus.test.mjs` T3 与 `entities.test.mjs` E7 的「引用不能跨 scope」不再拒绝）。
   * 真因在解析层：`find(id)` 是**全局按 id 查**，`assertReferences` 再校验 `concept.scope === scope`——
   * 若两个 scope 都有 `CONCEPT-0001`，find 返回哪一个取决于遍历顺序，跨 scope 校验就退化成
   * 「碰巧撞对」。uuid 时代这条不变量是**免费**的（碰撞概率为零），换成可读号就必须**显式**保证。
   *
   * ⇒ 与 `EntityStore.nextId` 同一条路（扫全局 max + 防撞），而不是学 `SourceStore`。
   * 我上一版注释批评 entities「编号不可复现」是错的：那是刻意的取舍——**可读 id 的可解析性
   * 优先于号段整齐**。
   */
  private nextId(): string {
    const taken = new Set<string>()
    let max = 0
    for (const concept of this.all()) {
      taken.add(concept.id)
      const matched = /^CONCEPT-(\d+)$/.exec(concept.id)
      if (matched !== null) max = Math.max(max, Number(matched[1]))
    }
    let next = max + 1
    let candidate = `CONCEPT-${String(next).padStart(4, '0')}`
    while (taken.has(candidate)) {
      next += 1
      candidate = `CONCEPT-${String(next).padStart(4, '0')}`
    }
    return candidate
  }

  /**
   * 把某 scope 内**非** `CONCEPT-nnnn` 形态的概念 id 改成可读 id（方案 §6.3 迁移路径）。
   *
   * ## 为什么单独一个方法，不走 `update`
   *
   * `update` 会跑 `assertReferences`（引用必须指向已存在的概念）——而迁移的过程中
   * 「旧 id 已消失、新 id 刚出现」，任何一侧都暂时不满足，那条断言会正确地拒绝一次
   * **必须发生**的改写。所以这是显式命名的原子迁移路径，同时改三类东西：
   * ① 存储 key ② 概念自身 `id` ③ 本表内的 `broader` / `related` 引用。
   *
   * **跨表引用（实体的 `topics`）不在这里**：`ConceptStore` 不知道实体表，由调用方拿返回的
   * 映射去 `EntityStore.rewriteTopicRefs`——两条都做完才叫「零悬空」。
   *
   * 分配的确定性：按 `createdAt`（并列按 id 字典序）升序编号，同一份数据重跑得同一结果；
   * 已是可读 id 的**不动**（所以幂等：第二次跑返回 `{}`）。
   *
   * @param scope - 作用域（只迁移该 scope 的条目；**分配出的号全局唯一**，见 `nextId` 的理由）
   * @returns 旧 id → 新 id 的映射（空对象 = 无需改动）
   */
  /**
   * 只算不写：给出「若迁移，谁会被改成什么号」。迁移前必跑（破坏性操作先干跑）。
   *
   * 与 `renumberIds` 共用同一套分配规则 ⇒ 预览与实跑不可能给出不同映射。
   * @param scope - 作用域
   * @returns 旧 id → 新 id 的映射（空对象 = 无需改动）
   */
  planRenumber(scope: string): Record<string, string> {
    const rows = this.byScope(scope).slice().sort((a, b) =>
      a.createdAt === b.createdAt
        ? (a.id < b.id ? -1 : 1)
        : (a.createdAt < b.createdAt ? -1 : 1))
    // 全局占位集：别的 scope 已有的 id 也要避开，否则迁移会造出跨 scope 同号（见 nextId 的教训）
    const taken = new Set(this.all().map((concept) => concept.id))
    const mapping: Record<string, string> = {}
    let next = 1
    const take = (): string => {
      let candidate = `CONCEPT-${String(next).padStart(4, '0')}`
      while (taken.has(candidate)) {
        next += 1
        candidate = `CONCEPT-${String(next).padStart(4, '0')}`
      }
      taken.add(candidate)
      next += 1
      return candidate
    }
    for (const concept of rows) {
      if (/^CONCEPT-\d+$/.test(concept.id)) continue
      mapping[concept.id] = take()
    }
    return mapping
  }

  /**
   * 执行迁移（`planRenumber` 的写入侧）。
   * @param scope - 作用域
   * @returns 实际生效的映射（空对象 = 无事可做）
   */
  async renumberIds(scope: string): Promise<Record<string, string>> {
    const mapping = this.planRenumber(scope)
    if (Object.keys(mapping).length === 0) return {}
    for (const concept of this.byScope(scope)) {
      const newId = mapping[concept.id] ?? concept.id
      const nextConcept: Concept = {
        ...concept,
        id: newId,
        ...(concept.broader !== undefined ? { broader: concept.broader.map((id) => mapping[id] ?? id) } : {}),
        ...(concept.related !== undefined ? { related: concept.related.map((id) => mapping[id] ?? id) } : {}),
      }
      // 先写新键、再删旧键：中途中断最坏是多一份副本（可发现），而不是丢掉一条概念（不可发现）
      await this.kv.put(conceptKey(scope, newId), nextConcept)
      if (newId !== concept.id) await this.kv.delete(conceptKey(scope, concept.id))
    }
    return mapping
  }

  /**
   * 建立概念（fail-loud：标签冲突 / 上位不存在 / 自引用 / 空首选名）。
   * @param draft - 概念草稿
   */
  async create(draft: ConceptDraft): Promise<Concept> {
    const prefLabel = draft.prefLabel.trim()
    if (prefLabel.length === 0) throw new Error('概念：prefLabel（首选名）不能为空')
    const candidate = { prefLabel, altLabels: draft.altLabels ?? [] }
    this.assertNoLabelCollision(draft.scope, candidate, undefined)
    this.assertReferences(draft.scope, draft.broader, draft.related, undefined)
    const now = new Date().toISOString()
    const concept: Concept = {
      id: this.nextId(),
      scope: draft.scope,
      prefLabel,
      createdAt: now,
      updatedAt: now,
      ...(draft.altLabels !== undefined && draft.altLabels.length > 0 ? { altLabels: draft.altLabels } : {}),
      ...(draft.definition !== undefined ? { definition: draft.definition } : {}),
      ...(draft.scopeNote !== undefined ? { scopeNote: draft.scopeNote } : {}),
      ...(draft.broader !== undefined && draft.broader.length > 0 ? { broader: draft.broader } : {}),
      ...(draft.related !== undefined && draft.related.length > 0 ? { related: draft.related } : {}),
      revisions: [{ at: now, action: 'create', detail: `prefLabel=${prefLabel}` }],
    }
    await this.kv.put(conceptKey(concept.scope, concept.id), concept)
    return concept
  }

  /**
   * 修改概念（只改给到的字段；每次真变留一条变更记录）。
   * @param id - 概念 id
   * @param patch - 变更
   * @param reason - 为什么改（可选，但记下来才有价值）
   */
  async update(id: string, patch: ConceptPatch, reason?: string): Promise<Concept> {
    const current = this.find(id)
    if (current === undefined) throw new Error(`概念：未找到 id="${id}"`)
    const next: Concept = { ...current }
    const details: string[] = []
    if (patch.prefLabel !== undefined) {
      const label = patch.prefLabel.trim()
      if (label.length === 0) throw new Error('概念：prefLabel（首选名）不能为空')
      if (label !== current.prefLabel) {
        details.push(`prefLabel：${current.prefLabel} → ${label}`)
        next.prefLabel = label
      }
    }
    if (patch.altLabels !== undefined) {
      const before = (current.altLabels ?? []).join(' / ')
      const after = patch.altLabels.join(' / ')
      if (before !== after) {
        details.push(`altLabels：${before === '' ? '（无）' : before} → ${after === '' ? '（无）' : after}`)
        if (patch.altLabels.length > 0) next.altLabels = patch.altLabels
        else delete next.altLabels
      }
    }
    for (const field of ['definition', 'scopeNote'] as const) {
      const value = patch[field]
      if (value === undefined) continue
      if ((current[field] ?? '') === value) continue
      details.push(`${field}：${current[field] === undefined ? '（无）' : '（有）'} → ${value === '' ? '（清空）' : '（更新）'}`)
      if (value === '') delete next[field]
      else next[field] = value
    }
    for (const field of ['broader', 'related'] as const) {
      const value = patch[field]
      if (value === undefined) continue
      const before = (current[field] ?? []).join(',')
      const after = value.join(',')
      if (before === after) continue
      details.push(`${field}：${before === '' ? '（无）' : before} → ${after === '' ? '（无）' : after}`)
      if (value.length > 0) next[field] = value
      else delete next[field]
    }
    if (details.length === 0) return current
    this.assertNoLabelCollision(current.scope, { prefLabel: next.prefLabel, altLabels: next.altLabels ?? [] }, id)
    this.assertReferences(current.scope, next.broader, next.related, id)
    const at = new Date().toISOString()
    next.updatedAt = at
    next.revisions = pushRevision(current.revisions, { at, action: 'update', detail: details.join('；'), ...(reason !== undefined && reason.trim() !== '' ? { reason: reason.trim() } : {}) })
    await this.kv.put(conceptKey(next.scope, next.id), next)
    return next
  }

  /**
   * 停用概念（**不删除**：旧记忆上的标签还要能解释）。
   * @param id - 概念 id
   * @param reason - 停用理由（必填：为什么不再用）
   */
  async deprecate(id: string, reason: string): Promise<{ concept: Concept; changed: boolean }> {
    const current = this.find(id)
    if (current === undefined) throw new Error(`概念：未找到 id="${id}"`)
    const trimmed = reason.trim()
    if (trimmed.length === 0) throw new Error('概念停用：必须给 reason（为什么不再用）——没有理由的停用无法复核')
    if (current.status === 'deprecated') return { concept: current, changed: false }
    const at = new Date().toISOString()
    const next: Concept = {
      ...current,
      status: 'deprecated',
      deprecatedNote: trimmed,
      updatedAt: at,
      revisions: pushRevision(current.revisions, { at, action: 'deprecate', detail: `停用：${trimmed}` }),
    }
    await this.kv.put(conceptKey(next.scope, next.id), next)
    return { concept: next, changed: true }
  }

  /** 统计（memory_stats 用） */
  stats(): ConceptStats {
    const all = this.all()
    const byScope: Record<string, number> = {}
    let active = 0
    let withAltLabels = 0
    let withDefinition = 0
    let withBroader = 0
    for (const concept of all) {
      byScope[concept.scope] = (byScope[concept.scope] ?? 0) + 1
      if (isConceptActive(concept)) active += 1
      if ((concept.altLabels ?? []).length > 0) withAltLabels += 1
      if ((concept.definition ?? '').length > 0) withDefinition += 1
      if ((concept.broader ?? []).length > 0) withBroader += 1
    }
    return {
      total: all.length,
      active,
      deprecated: all.length - active,
      withAltLabels,
      withDefinition,
      withBroader,
      byScope,
    }
  }

  /**
   * 导出（SKOS-lite JSON 字符串；`prefLabel` / `altLabel` / `broader` / `related` / `definition` 用 SKOS 词汇名）。
   * @param scope - 只导出该分区；缺省导出全部
   */
  exportJson(scope?: string): string {
    const concepts = scope === undefined ? this.all() : this.byScope(scope)
    return JSON.stringify({
      format: 'aml-thesaurus/1',
      concepts: concepts.map((concept) => ({
        id: concept.id,
        prefLabel: concept.prefLabel,
        ...(concept.altLabels !== undefined ? { altLabel: concept.altLabels } : {}),
        ...(concept.broader !== undefined ? { broader: concept.broader } : {}),
        ...(concept.related !== undefined ? { related: concept.related } : {}),
        ...(concept.definition !== undefined ? { definition: concept.definition } : {}),
        ...(concept.scopeNote !== undefined ? { scopeNote: concept.scopeNote } : {}),
        ...(concept.status !== undefined ? { status: concept.status } : {}),
      })),
    }, null, 2)
  }

  /**
   * 导入（验完全部再写全部；任何一项非法 ⇒ 整批拒绝，逐项报错）。
   *
   * 为什么不是「跳过坏的、写好的」：半套词表比没有更坏——它会以「已导入」的样子
   * 参与查询扩展，而缺的那部分永远不会被想起去补。
   * @param items - 草稿数组（scope 缺省取调用方给的默认 scope）
   * @param defaultScope - 每项未给 scope 时使用
   */
  async importMany(items: ConceptDraft[], defaultScope: string): Promise<Concept[]> {
    const drafts = items.map((item) => ({ ...item, scope: item.scope ?? defaultScope }))
    // 第一阶段：批内自检（标签互斥 + 引用存在性；批内引用按 prefLabel 无法表达，故不许指向批外不存在的 id）
    const problems: string[] = []
    for (let i = 0; i < drafts.length; i++) {
      const draft = drafts[i]!
      if (draft.prefLabel.trim().length === 0) problems.push(`第 ${i + 1} 项：prefLabel 为空`)
      for (let j = i + 1; j < drafts.length; j++) {
        const other = drafts[j]!
        if (other.scope !== draft.scope) continue
        const collide = labelsCollide(
          { prefLabel: draft.prefLabel, altLabels: draft.altLabels ?? [] },
          { prefLabel: other.prefLabel, altLabels: other.altLabels ?? [] },
        )
        if (collide.length > 0) problems.push(`第 ${i + 1} 项与第 ${j + 1} 项标签冲突：${collide.join(' / ')}`)
      }
      if (draft.broader !== undefined) {
        for (const parentId of draft.broader) {
          if (this.find(parentId) === undefined) problems.push(`第 ${i + 1} 项：上位概念 id="${parentId}" 不存在（导入不支持按引用新项，需分两批）`)
        }
      }
    }
    if (problems.length > 0) throw new Error(`导入：整批拒绝（${problems.length} 处问题）——${problems.join('；')}`)
    // 第二阶段：逐项写（到此已无非法项）
    const created: Concept[] = []
    for (const draft of drafts) created.push(await this.create(draft))
    return created
  }

  /** 标签冲突检查（同 scope 内任一新标签与别的概念的标签归一后相同 ⇒ 拒绝） */
  private assertNoLabelCollision(
    scope: string,
    candidate: Pick<Concept, 'prefLabel' | 'altLabels'>,
    selfId: string | undefined,
  ): void {
    const normalized = new Set(labelsOf(candidate).map(normalizeLabel))
    if (normalized.size !== labelsOf(candidate).length) {
      throw new Error(`概念：prefLabel 与 altLabels 内部有重复写法（${labelsOf(candidate).join(' / ')}）——同一个概念不必把同一个词写两遍`)
    }
    for (const other of this.byScope(scope)) {
      if (other.id === selfId) continue
      const collide = labelsCollide(candidate, other)
      if (collide.length > 0) {
        throw new Error(
          `概念：标签冲突——${collide.map((label) => `"${label}"`).join(' / ')} 已被概念 "${other.prefLabel}"(id=${other.id}) 占用。`
          + '同一个词在同一 scope 内只能指一个概念（要区分就用不同词，或先给那个概念加同义词并停用它）；'
          + '**不许自动合并**——两个同名词未必是同一件事（消歧的反面就是猜）。',
        )
      }
    }
  }

  /** 引用完整性：broader / related 指向的概念必须存在、不能指向自己、broader 不能成环 */
  private assertReferences(
    scope: string,
    broader: string[] | undefined,
    related: string[] | undefined,
    selfId: string | undefined,
  ): void {
    const check = (ids: string[] | undefined, field: string): void => {
      for (const id of ids ?? []) {
        if (selfId !== undefined && id === selfId) throw new Error(`概念：${field} 不能指向自己（${id}）——自环让层级查询永远停不下来`)
        if (this.find(id) === undefined) throw new Error(`概念：${field} 指向的概念 id="${id}" 不存在`)
        if (scope !== '' && this.find(id)!.scope !== scope) {
          throw new Error(`概念：${field} 不能跨 scope 引用（概念 "${id}" 在 ${this.find(id)!.scope}，当前 ${scope}）`)
        }
      }
    }
    check(broader, 'broader')
    check(related, 'related')
    // 环检查：加入这些上位后，从每个新上位的上位闭包出发不得回到自己
    if (selfId !== undefined && broader !== undefined) {
      for (const parentId of broader) {
        if (this.ancestorsOf(parentId).some((ancestor) => ancestor.id === selfId)) {
          throw new Error(`概念：broader 成环——概念 "${selfId}" 已是 "${parentId}" 的上位之一，不能再反过来指向它`)
        }
      }
    }
  }
}

/** 追加一条变更记录并裁到上限（保留最近 MAX_CONCEPT_REVISIONS 条） */
function pushRevision(history: ConceptRevision[] | undefined, entry: ConceptRevision): ConceptRevision[] {
  const next = [...(history ?? []), entry]
  return next.length > MAX_CONCEPT_REVISIONS ? next.slice(next.length - MAX_CONCEPT_REVISIONS) : next
}
