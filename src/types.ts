/**
 * dsh-agent-memory 数据契约（IMPLEMENTATION.md §2.1）
 * 本文件仅含类型，无运行时代码。
 */

/** 记忆条目类型 */
export type EntryKind = 'fact' | 'knowledge' | 'episodic' | 'summary'

/** 时间压缩层级（仅 episodic/summary 使用） */
export type TimelineLevel = 'day' | 'week' | 'month' | 'year'

/**
 * 角色准入策略（v0.5 多智能体工作台模式，借鉴 MAGE role policy index + Γ 准入）：
 * 描述「某个角色能看见什么」。字段缺省 = 不限制该维度。
 */
export interface RolePolicy {
  /** 可读归属白名单：`'*'` = 全部；含条目 role 值 = 放行。缺省 []（= 只看自己 + 共享） */
  read?: string[]
  /** 允许的条目类型（缺省 = 不限制） */
  kinds?: EntryKind[]
  /** 是否可见「无归属的共享记忆」（缺省 true） */
  includeShared?: boolean
  /** 是否附加 global 作用域（缺省 true；false = 不附加，显式 scope 参数仍优先） */
  includeGlobal?: boolean
}

/** 角色维度配置（memory.yml `roles` 段） */
export interface RolesConfig {
  /** 总开关：false（缺省）时**零过滤**——行为与 v0.4 完全一致（向后兼容硬约束） */
  enabled: boolean
  /** 人类会话缺省角色 */
  default: string
  /** 派生会话（子代理 / 队员 / 隔间）缺省角色 */
  derived: string
  /** 会话预设名（agentPreset）→ 角色映射 */
  byPreset: Record<string, string>
  /** 未显式配置策略的角色所用策略 */
  policyDefault: RolePolicy
  /** 角色 → 策略 */
  policies: Record<string, RolePolicy>
}

/** 记忆条目（核心契约） */
export interface Entry {
  id: string
  kind: EntryKind
  /** L1 精确覆盖键 */
  key?: string
  title: string
  /** markdown 自由正文 */
  body: string
  /** 可选元数据（agent 自主决定） */
  tags: string[]
  /**
   * 检索别名（2026-10-13 重做）：这条记忆**可能被怎么问**的同义表述。
   *
   * **为什么需要**（实测根因）：检索是字面匹配，而**记忆的措辞 ≠ 提问的措辞**。
   * 亲读归因实验（`_tmp_review/mem-attribution.mjs`）对 3 个「期望第一却排不上」的案例
   * 各换 5 个查询变体——三个全部：换个说法就排第一。机制：目标条目标题
   * 「把别人的『未找到』转述成『不存在』」**完全不含**查询「我的错误 教训 误判 修正」
   * 里的任何实词 ⇒ 只靠 bigram 碎片拿 10.5 分、排第 5。
   *
   * **证伪实验**（`_tmp_review/mem-alias-falsify.mjs`，只给 3 条补别名）：
   * S3 #2→#1（22.4→114.1）· S4 #4→#1（50.2→115.8）· S5 #5→#1（10.5→48.7）；
   * **对照组**：3 个无关查询 top1 全部不变（零污染）。
   *
   * **为什么放写入侧而非查询侧**：写入时抽，代价一次性、可复核、可人工修正；
   * 查询时扩展每次都要做且不可复核。且它把质量责任放回写入端（主人 2026-10-13 定调
   * 「不做向量语义检索 ⇒ 写入质量是唯一路线」）。
   */
  aliases?: string[]
  /** global 或 workspaceId */
  scope: 'global' | string
  createdAt: string
  updatedAt: string
  accessedAt: string
  level: TimelineLevel | null
  /** 时间桶键：YYYY-MM-DD / YYYY-Www / YYYY-MM / YYYY */
  bucket: string | null
  /** 冷归档标记（不进活跃检索） */
  archived: boolean
  source?: { sessionId?: string; seq?: number; reason?: string }
  /** summary → 原始条目 id 列表 */
  archiveRef?: string[]
  /**
   * 角色归属（v0.5）：条目的分区维度。**缺省 = 共享记忆**（任何角色都可见）；
   * 盖章只发生在「角色维度启用」或调用方显式指定 `role` 时（迁移安全）。
   */
  role?: string
  /** 写入者溯源（v0.5）：谁写的（会话 id / 委派深度 / 预设名）——与可见性无关，只作溯源 */
  author?: { sessionId?: string; delegationDepth?: number; preset?: string }
  /**
   * 修订留痕（v0.9）：每次 update 前的快照（保留最近 MAX_REVISIONS 条，旧→新）。
   * 动机：v0.8 前 `update` 是整文覆盖且**旧值即弃**——「修改机制」缺历史，改错无法回溯。
   */
  revisions?: Revision[]
}

/** 修订快照（v0.9）：让「修改」可回溯（与 forget 的软归档对称——一个管改、一个管忘） */
export interface Revision {
  /** 修订时刻（ISO） */
  at: string
  prevTitle: string
  prevBody: string
  /** 触发本次修订的模式 */
  mode: 'replace' | 'append' | 'patch'
  /** 修订者（会话 id），缺省不记 */
  by?: string
}

/** 项目记忆配置（.dsh/memory.yml，缺省走默认） */
export interface MemoryConfig {
  scope: 'workspace' | 'global-first' | 'global'
  layers: EntryKind[]
  autoSink: boolean
  timeline: {
    day: boolean
    week: boolean
    month: boolean
    year: boolean
    archive: 'keep'
  }
  weeklyTemplate: string
  maxEntries: number
  /** 启动注入配置（会话首 pre-step 注入记忆速览） */
  inject: {
    enabled: boolean
    maxBytes: number
    maxEntries: number
  }
  /** 自动 recall 注入配置（每条新主人消息注入 top 命中，L3 2026-09-01） */
  autoInject: {
    enabled: boolean
    maxEntries: number
    maxBytes: number
  }
  /** 角色维度配置（v0.5 多智能体工作台模式） */
  roles: RolesConfig
  /** 价值体检配置（v0.6：只读提案器 memory_audit） */
  audit: AuditConfig
}

/** 体检权重（`memory.yml` 的 `audit.weights`）——**启发式先验，不是拟合值**（校准是 v3 的事） */
export interface AuditWeights {
  ref: number
  recent: number
  usage: number
  tag: number
  role: number
  size: number
  dup: number
}

/** 体检档位（决策，不是排名） */
export type AuditBucket = 'KEEP' | 'DEMOTE' | 'ARCHIVE' | 'REVIEW'

/** 价值体检查询（memory_audit） */
export interface AuditQuery {
  scope?: string
  /** 角色视角覆盖（缺省按调用者推导；体检是读路径 ⇒ 过角色准入） */
  role?: string
  /** 返回候选条数上限（缺省 30） */
  topN?: number
  /** 只列体量 ≥ 此字符数的候选（缺省 0 = 全部） */
  minChars?: number
  includeArchive?: boolean
}

/** 体检候选（单个条目的分档与证据） */
export interface AuditCandidate {
  id: string
  kind: EntryKind
  title: string
  scope: string
  bucket: AuditBucket
  score: number
  /** 人可读的证据行（为什么落这一档） */
  reasons: string[]
  evidence: {
    ageDays: number
    chars: number
    refs: number
    /** 被返回过的次数（**不分位置**——v0.12 起它与评分脱钩，评分改用 `attribution`） */
    usage: number
    /**
     * 排序加权归因（v0.12 · DREAM 迁移）：`Σ decay^pos`。
     * 与 `usage` 的关系：同一条目，`usage=10` 若全在第 1 位 ⇒ ≈10；全在第 15 位 ⇒ ≈0。
     * 字段缺失时（外部只喂 hits 的调用方）评分回退 `usage`——零回归。
     */
    attribution?: number
    tags: number
    hasSource: boolean
    role?: string
    dupCluster?: number
    dupOf?: string
  }
}

/** 体检分组（按 kind/level 聚合，看「哪一坨最占地方」） */
export interface AuditGroup {
  key: string
  label: string
  count: number
  chars: number
  /** 该组主导档位 */
  dominantBucket: AuditBucket
}

/** 体检结果 */
export interface AuditResult {
  summary: {
    total: number
    chars: number
    byBucket: Record<AuditBucket, number>
    charsByBucket: Record<AuditBucket, number>
    /** 用量信号的来源：侧车轨迹 / 无 */
    usageSource: 'trace' | 'none'
    /** 被更晚条目引用过的条目数（承重计数） */
    referenced: number
  }
  groups: AuditGroup[]
  candidates: AuditCandidate[]
  notes: string[]
}

/** 体检配置（`memory.yml` 的 `audit` 段） */
export interface AuditConfig {
  weights: AuditWeights
  /** age ≤ 此天数的条目判 KEEP（保新，避免误伤在用的东西） */
  keepRecentDays: number
  /** age ≥ 此天数才够格判 ARCHIVE */
  archiveMinAgeDays: number
  /** 体量 ≥ 此字符数即入 REVIEW（超大条目交人裁决） */
  reviewMinChars: number
  /** 未被引用且体量 ≥ 此字符数即判 DEMOTE */
  demoteMinChars: number
  /**
   * summary 类正文预算（字符，v0.11.0）。
   * 概要是压缩流水线**自动生成**的，其长度上限由 `summarizer.summaryMaxChars`
   * 决定（缺省 6000）——审计必须用**它自己的尺子**量它，不能借用通用体量门槛。
   */
  summaryMaxChars: number
  /** 侧车用量轨迹（只追加、吞错、按体积轮转；绝不改条目） */
  accessTrace: { enabled: boolean; maxBytes: number }
  /** 提案日志（v0.7：让提案有历史——audit 候选 + forget/update 动作同文件可 join） */
  proposalLog: { enabled: boolean; maxBytes: number }
  /** 压缩流水线轨迹（v0.8：让「为什么这个桶没压」有证据——scan 判定分布 + 逐桶样本） */
  compressTrace: { enabled: boolean; maxBytes: number }
}

/** 加权查询词项（v0.7 上下文重心：注入查询 = 加权词项集合，而非单条消息字面） */
export interface WeightedTerm {
  term: string
  weight: number
}

/** 检索查询 */
export interface RecallQuery {
  query?: string
  /** 上下文重心（v0.7）：与 `query` 二选一；给了它则按权重打分 */
  weightedTerms?: WeightedTerm[]
  kind?: EntryKind[]
  tags?: string[]
  since?: string
  until?: string
  scope?: 'global' | string
  limit?: number
  includeArchive?: boolean
  /** 角色视角覆盖（缺省 = 调用者身份推导；仅当 roles.enabled 时生效） */
  role?: string
  /**
   * 是否为每个结果附加联想链（`related`，v0.3 维度）。
   *
   * **缺省 true**（`recall` 工具的模型可见输出渲染「→ 关联: …」，必须保留）。
   * 设 false = 跳过 `relatedOf`——**每条结果一次全库扫描**，实测 20 条结果耗时
   * 500–640 ms（2026-10-13 分解读数）。
   *
   * 用于**不消费 `related` 的调用方**：`auto-inject.buildAutoRecallDigest` 只用
   * title/kind/updatedAt/score/snippet，却同样走 `recallEntries` ⇒ 白算联想层。
   * 实测 auto-recall 真实形状（limit=3）跳过联想后 **95 → 41 ms（省 56%）**。
   * 该路径**每条主人消息都跑**，是最热的调用点。
   */
  withRelated?: boolean
}

/** 检索结果项 */
export interface RecallResultItem {
  id: string
  kind: EntryKind
  title: string
  snippet: string
  tags: string[]
  scope: string
  level: TimelineLevel | null
  score: number
  archived: boolean
  updatedAt: string
  /** 角色归属（v0.5，缺省为共享记忆） */
  role?: string
  /** 联想层（v0.3）：相关条目链（共享标签/标题/正文关联），关联强度降序 */
  related?: RelatedItem[]
}

/** 联想条目（关联记忆：同标签/标题/正文关联，因果留痕维度） */
export interface RelatedItem {
  id: string
  kind: EntryKind
  title: string
  scope: string
  /** 共享标签数 */
  sharedTags: number
  /** 关联强度（共享标签×3 + 标题重叠×2 + 正文重叠×1） */
  strength: number
}

/** remember 返回 */
export interface RememberResult {
  id: string
  action: 'created' | 'updated' | 'merged'
}

/** 记忆浏览查询（memory_browse：按时间线分组翻档案，与 recall 互补） */
export interface BrowseQuery {
  kind?: EntryKind[]
  tags?: string[]
  since?: string
  until?: string
  scope?: string
  includeArchive?: boolean
  /** 只看指定层级（week/month/year）；缺省 = 全部层级按时间分组 */
  level?: TimelineLevel
  /** 分页（1 起） */
  page?: number
  pageSize?: number
  /** 角色视角覆盖（v0.5） */
  role?: string
}

/** 浏览分组：一个时间桶下的条目（level 为概要层级 week/month/year；明细组为 null） */
export interface BrowseGroup {
  bucket: string
  label: string
  level: 'day' | 'week' | 'month' | 'year' | null
  items: RecallResultItem[]
}

/** 记忆浏览返回 */
export interface BrowseResult {
  groups: BrowseGroup[]
  total: number
}

/** recall 返回（规格 §4：{ results, total }） */
export interface RecallResult {
  results: RecallResultItem[]
  /** 过滤后、截断前的命中总数 */
  total: number
  /**
   * v0.12：被泛词门抑制的词项（idf 置 0）。**仅在结果为空时出现**。
   *
   * 为什么需要它（2026-10-10 实测）：泛词门（v0.9）会把过泛的词 idf 置 0 ⇒ 全部得分清零
   * ⇒ `total=0`。但空结果此前**只有一种表达**「命中 0 条」，模型会把它读成
   * 「**没有相关记忆**」——而实测 `recall("插件")` / `recall("技能")` 就是这种情形
   * （库里分别有 510 / 395 条提及，却都返回 0 条）。
   *
   * ⇒ 「**被抑制**」与「**真的没有**」必须分开说（同 §L1.5 的
   * 「契约违规 vs 真的没标签」——自己犯过的同型错误在检索层复发）。
   */
  suppressedTerms?: string[]
}
