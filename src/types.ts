/**
 * dsh-agent-memory 数据契约（IMPLEMENTATION.md §2.1）
 * 本文件仅含类型，无运行时代码。
 */

// 时效维的档位定义住 `temporal.ts`（那里是它的正本与理由）——此处只引用类型。
// 类型循环（temporal.ts ⇄ types.ts）是安全的：两边都是 `import type`，编译后消失。
import type { StalenessLevel } from './temporal.ts'

/** 记忆条目类型 */
export type EntryKind = 'fact' | 'knowledge' | 'episodic' | 'summary'

/** 时间压缩层级（仅 episodic/summary 使用） */
export type TimelineLevel = 'day' | 'week' | 'month' | 'year'

/**
 * 主体层（v0.13.0）：条目**关于谁**——`self`（我，爱丽丝）/ `master`（主人）。
 *
 * 与 `role`（条目归属，v0.5）**正交**：role 答「谁写的」，subject 答「关于谁的」。
 * 缺省（不设字段）= **通用**（不关于特定主体：技术知识 / 项目工作 / 外部论文）。
 * 语义、判据与「为什么与 role 刻意不同」见 `src/subject.ts` 文件头。
 */
export type Subject = 'self' | 'master'

/**
 * 约定状态（v0.14.0）：这条记忆涉及的事，**是否已被主人与我共同建立**。
 *
 * 动机（论文 Grounding Awareness · arXiv:2610.18684 · 主人 2026-10-14 交办）：
 * 记忆系统只记「用户说了什么」，但**「说过」≠「已建立」**。最危险的形态是——
 * **我自己的提议被记成「主人的话」**，未来当作授权执行。论文实测：被保留的
 * 未接受提议中 **86–100%** 被记成「已确认信息」或「用户事实」；且给它**更多**
 * 提议内容反而**放大**未授权执行（Qwen+Mem0 假共同基础 0.26 → 0.53）。
 *
 * 与既有维度**正交**：`role` 答「谁写的」· `subject` 答「关于谁的」·
 * `grounding` 答「**是否已被共同建立**」。三维可任意组合。
 *
 * **与论文 GL ledger 五状态的映射**（论文未明写，此处是我的归类）：
 *   `confirmed` → `established` · `pending` → `proposed` · `scoped` → `scoped` ·
 *   `rejected` → `rejected` · `revised` → **并进 `established`**（主人改过后接受，
 *   结果仍是已建立；「改了什么」由正文承载，不单设状态——避免与 v0.9 的
 *   `revisions`（内容修订留痕）语义打架）。
 *
 * ⚠ **与论文刻意不同（理由必须留在这里，否则会被「对齐」掉）**：论文默认
 * 「未授权 ⇒ 必须确认」并配 execution gate；但本系统主人的授权模式是
 * 「给方向、我自己决定」（AGENTS.md §2.2 技术处置自主 · 内部事务不上抛）
 * ⇒ **不做强制门**——处处请示会直接违背该定调。⇒ 移植的是**可见性**
 * （让我不被自己的提议骗），不是**拦截**。语义、判据与判例见 `src/grounding.ts` 文件头。
 */
export type Grounding = 'established' | 'proposed' | 'scoped' | 'rejected'

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
  /**
   * 情境形状（v0.16.0，2026-10-21）：这条经验**在什么形状的情境下该被取出使用**。
   *
   * 与 `aliases` 的分工：aliases 面向**词面失配**（我会用什么词来找），cue 面向**场景失配**
   * （什么样的处境该用它）。检索时同权参与打分——两者都是人工给的入口，只是防的失配不同。
   * 论文依据：Harness² 的 experience `cue`（arXiv:2610.14224 §H Prompt 6）——写「情境的形状」
   * 而不是本次任务的事实，才能在另一件事上触发。
   */
  cue?: string[]
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
  /**
   * 主体层（v0.13.0）：条目**关于谁**。缺省 = 通用（不关于特定主体）。
   *
   * 与 `role` 正交且**互不影响**：`role` 管「谁写的」（准入隔间），`subject` 管
   * 「关于谁的」（语义标记，不改变可见性）。新建时盖章；**显式纠正**走
   * `update({ subject })` 或 `remember({ subject })`（见 src/subject.ts 三条设计决定）。
   */
  subject?: Subject
  /**
   * 约定状态（v0.14.0）：事项**是否已被共同建立**——`established`（主人明确说过）/
   * `proposed`（**我提的、主人未回应**）/ `scoped`（主人接受但限定范围）。
   *
   * 缺省 = **未标注**（读作「不知道」而非「已建立」——后者恰是论文点名的错误假设）。
   * 只在新建时盖章；显式纠正走 `update({ grounding })`（三态见 `EntryPatch.grounding`）。
   */
  grounding?: Grounding
  /**
   * 复查死线（v0.15.0）：这条结论**该在什么时候被重看**——`YYYY-MM-DD`（UTC 日）。
   *
   * 动机（论文 Fresh at Decision, Stale at Action · arXiv:2610.18126v1 · 主人 2026-10-14 交办）：
   * 论文证明**新鲜度有天花板**——`Pr[f holds at ta] ≤ e^(-λ_f · Δact)`，决策时刻再新鲜
   * 也突破不了执行间隙 Δact 内发生的变化。迁移到我的场景：`td` = 我写下这条结论的时刻，
   * `ta` = **未来的我执行它**的时刻（加载技能 / 引用记忆 / 按它行事），Δact 是几天到几周。
   *
   * ⚠ **无默认值**（判断不代填 · §2.4）：给每条记忆自动盖「90 天后复查」等于把判断
   * 写死在机制里——主人的偏好该永久有效、环境坐标该 30 天一看，同一默认值会同时错两边。
   * **空是常态，填是例外**：只有我此刻判断「这条会腐化」时才填。
   *
   * ⚠ **到期 ≠ 作废，只 = 该重看**：不做自动失效、不做自动归档（同 grounding 的立场：
   * 移植的是可见性不是拦截）。到期后由我核实 → `update` 改内容并续死线或清除。
   *
   * 写入侧接受相对写法（`+7d` / `+2w`），**存盘一律固化成绝对日期**——存相对值会让
   * 「什么时候到期」随「何时读取」漂移。解析与判定见 `src/temporal.ts`。
   */
  reviewAfter?: string
  /**
   * 观察条件（v0.15.0）：**什么样的新信息会让这条失效**——1–8 条短句。
   *
   * 论文实测（INDIRECT）：把观察条件写进索引 ⇒ **达 92.2% 的决定性消息、仅 20 条陷阱**；
   * 而索引「全部背景事实」虽达 100%，却带 **89 条陷阱**（每个事实都成了匹配点）。
   * 论文的措辞是关键：条件要**点名活动依赖的实体**（含它的**另一个名字**与**上游**），
   * 同时**略去用不到的** —— 低暴露来自「只写需要的那几条」。
   *
   * **写入时机是唯一的**：论文说条件由「**知道为什么这么选的那个组件**，在写入时刻」产生
   * ——那正是我调 `remember` 的那一刻。事后再补，我已经想不起当时在等什么。
   *
   * **本版不做独立 router**（理由见 `src/temporal.ts` 文件头决定 1）：条件印在 recall
   * 结果里 = 免费路由（命中即看见「它在等什么」）。若实测「该失效的条目从没被 recall 到」，
   * 那条尸体成立再补 router。
   */
  watchFor?: string[]
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
   * 主体层过滤（v0.13.0）：只看「关于谁」的条目。缺省 = 不过滤（通用条目照常返回）。
   * ⚠ 与 `role` 的**准入**不同——这是**可选筛子**，不是可见性边界：设了 subject 的
   * 条目对任何调用方**依然可见**，只是不匹配本次筛选。
   */
  subject?: Subject
  /**
   * 约定状态过滤（v0.14.0）：只看向「**是否已被共同建立**」的条目——
   * `proposed` = **只看我自己提的、主人未回应的事**（自查「我有没有把提议当成定论」时用它）。
   * `established` = 只看主人明确说过的。缺省 = 不过滤。
   * ⚠ 同为**可选筛子**，不是可见性边界（理由同 subject）。
   */
  grounding?: Grounding
  /**
   * 时效维过滤（v0.15.0）：只看**该重看**的条目——`expired`（已过复查死线）/
   * `due-soon`（7 天内到期）/ `fresh`（还早）。可多选。缺省 = 不过滤。
   *
   * 典型用法：`recall({ staleness: ['expired', 'due-soon'] })` = 「**我的哪些结论该重看了**」。
   *
   * ⚠ 可选筛子（同 subject / grounding）；且**只筛「设了死线」的条目**——未设死线的条目
   * 在任何取值下都不返回。它们的时效状态是「**不知道**」，不是「有效」。
   */
  staleness?: StalenessLevel[]
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
  /**
   * 家族折叠（v0.16.0 · 论文 Memory Echo 的 Family 组件）：把**候选池内**的
   * 「概要与其 `archiveRef` 原料」归为一族，**每族最多占一个服务位**（族内得分最高者为代表）。
   *
   * 论文依据（arXiv 2610.17763v1 §5.1）：「**Repeated writes therefore add records,
   * not independent votes**」——同一来源的派生记录不该被当作多个独立证据占检索位。
   *
   * ⚠ **缺省 false（默认关）**，理由是论文自己的消融：Family 单独上线会把准确率
   * 从 0.825 打到 **0.651**（≈ −33 题）——它必须与「当前事实优先」（Authority）配对
   * 才不掉分，而后者本插件尚无 ⇒ 先提供可选手段，待有配套再议默认。
   * 论文亦明确「The representative is selected anew from the current candidate pool」
   * 且「source grouping **does not delete** the unselected records」——本实现照此：
   * 只影响**本次占位**，数据不动，仍可 `includeArchive` 取回。
   *
   * ⚠ 与 `includeArchive` 的关系：默认视图下原料已冷归档、不会与概要同时命中，
   * 故本项**只在 `includeArchive=true` 时有实际效果**（实测：活跃概要 + 活跃原料同源对 = 0）。
   */
  collapseFamily?: boolean
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
  /** 主体层（v0.13.0，缺省 = 通用；仅当条目已标注时出现在结果里） */
  subject?: Subject
  /** 约定状态（v0.14.0；仅当条目已标注时出现在结果里——缺省表示「未标注」而非「已建立」） */
  grounding?: Grounding
  /**
   * 时效维（v0.15.0；仅当条目设了时出现在结果里）——复查死线 `YYYY-MM-DD`。
   * 渲染层按它与当前时刻算档位（已过期 / N 天后复查），**不预存档位**（存了就会与
   * 「读取时刻」脱钩：今天算出的「3 天后」明天就成了假读数）。
   */
  reviewAfter?: string
  /** 时效维（v0.15.0；仅当条目设了时出现在结果里）——观察条件（在等什么新信息） */
  watchFor?: string[]
  /** 情境形状（v0.16.0；仅当条目设了时出现在结果里）——什么处境的「形状」该用这条经验 */
  cue?: string[]
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
  /** 主体层过滤（v0.13.0）：只看「关于谁」的条目。缺省 = 不过滤。 */
  subject?: Subject
  /** 约定状态过滤（v0.14.0）：`proposed` = 只看我自己提的、主人未回应的事。缺省 = 不过滤。 */
  grounding?: Grounding
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
   * v0.16.0：家族折叠的说明（**仅当真发生折叠时出现**）。
   *
   * 它解释「为什么返回条数看着比命中数少」——把 `query.collapseFamily` 压掉的同源条目
   * 如实报出来，避免「静默少了几条」被读成「检索漏了」。信噪比纪律同 `groundingTag`：
   * 无折叠即不打这一行。
   */
  familyNote?: string
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
