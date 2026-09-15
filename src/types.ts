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
}

/** 检索查询 */
export interface RecallQuery {
  query?: string
  kind?: EntryKind[]
  tags?: string[]
  since?: string
  until?: string
  scope?: 'global' | string
  limit?: number
  includeArchive?: boolean
  /** 角色视角覆盖（缺省 = 调用者身份推导；仅当 roles.enabled 时生效） */
  role?: string
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
}
