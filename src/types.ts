/**
 * dsh-agent-memory 数据契约（IMPLEMENTATION.md §2.1）
 * 本文件仅含类型，无运行时代码。
 */

/** 记忆条目类型 */
export type EntryKind = 'fact' | 'knowledge' | 'episodic' | 'summary'

/** 时间压缩层级（仅 episodic/summary 使用） */
export type TimelineLevel = 'day' | 'week' | 'month' | 'year'

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
}

/** remember 返回 */
export interface RememberResult {
  id: string
  action: 'created' | 'updated' | 'merged'
}

/** recall 返回（规格 §4：{ results, total }） */
export interface RecallResult {
  results: RecallResultItem[]
  /** 过滤后、截断前的命中总数 */
  total: number
}
