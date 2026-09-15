/**
 * 项目记忆配置（IMPLEMENTATION.md §2.3）——memory.yml 解析 + 默认值。
 *
 * 配置来源：工作区 `.dsh/memory.yml`。
 * - 文件缺失 / 字段缺失 → 走缺省配置（DEFAULT_CONFIG）
 * - 文件存在但解析失败（YAML 语法错误或字段非法）→ fail loud（抛错，绝不静默吞掉）
 *
 * v0.5 新增 `roles` 段（多智能体工作台模式：角色归属与准入，见 src/role.ts）。
 *
 * 本模块是纯函数层，不依赖 Cordis 运行时，便于离线单测（tests/config.test.ts）。
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { DEFAULT_ROLES_CONFIG } from './role.ts'
import { DEFAULT_AUDIT_CONFIG } from './audit.ts'
import type { AuditConfig, AuditWeights, EntryKind, MemoryConfig, RolePolicy, RolesConfig } from './types.ts'

/** 合法条目层级（memory.yml layers 字段取值域） */
const VALID_KINDS: readonly string[] = ['fact', 'knowledge', 'episodic', 'summary']

/** 合法作用域取值 */
const VALID_SCOPES: ReadonlySet<string> = new Set(['workspace', 'global-first', 'global'])

/** memory.yml 顶层合法键（拒绝拼写错误 / 未知字段） */
const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  'scope',
  'layers',
  'auto_sink',
  'timeline',
  'weekly_template',
  'max_entries',
  'inject',
  'auto_inject',
  'roles',
  'audit',
])

/** inject 块内合法键 */
const INJECT_KEYS: ReadonlySet<string> = new Set(['enabled', 'max_bytes', 'max_entries'])

/** auto_inject 块内合法键 */
const AUTO_INJECT_KEYS: ReadonlySet<string> = new Set(['enabled', 'max_bytes', 'max_entries'])

/** timeline 块内合法键 */
const TIMELINE_KEYS: ReadonlySet<string> = new Set(['day', 'week', 'month', 'year', 'archive'])

/** audit 块内合法键（v0.6 价值体检器） */
const AUDIT_KEYS: ReadonlySet<string> = new Set([
  'weights',
  'keep_recent_days',
  'archive_min_age_days',
  'review_min_chars',
  'demote_min_chars',
  'access_trace',
  'proposal_log',
  'compress_trace',
])

/** audit.weights 内合法键（与 AuditWeights 逐字一致） */
const WEIGHT_KEYS: ReadonlySet<string> = new Set(['ref', 'recent', 'usage', 'tag', 'role', 'size', 'dup'])

/** audit.access_trace 内合法键 */
const ACCESS_TRACE_KEYS: ReadonlySet<string> = new Set(['enabled', 'max_bytes'])

/** roles 块内合法键 */
const ROLES_KEYS: ReadonlySet<string> = new Set([
  'enabled',
  'default',
  'derived',
  'by_preset',
  'policy_default',
  'policies',
])

/** 单条角色策略块内合法键 */
const POLICY_KEYS: ReadonlySet<string> = new Set(['read', 'kinds', 'include_shared', 'include_global'])

/** 缺省配置（§2.3 默认值表），冻结防改 */
export const DEFAULT_CONFIG: MemoryConfig = deepFreeze({
  scope: 'workspace',
  layers: ['fact', 'knowledge', 'episodic'],
  autoSink: true,
  timeline: {
    day: true,
    week: true,
    month: true,
    year: true,
    archive: 'keep',
  },
  weeklyTemplate: '',
  maxEntries: 2000,
  inject: {
    enabled: true,
    maxBytes: 3000,
    maxEntries: 20,
  },
  autoInject: {
    enabled: true,
    maxBytes: 1500,
    maxEntries: 3,
  },
  roles: DEFAULT_ROLES_CONFIG,
  audit: DEFAULT_AUDIT_CONFIG,
})

/** 配置非法时抛出的错误类型（fail loud 的载体） */
export class MemoryConfigError extends Error {
  /** @param message - 面向使用者的中文错误说明 */
  constructor(message: string) {
    super(message)
    this.name = 'MemoryConfigError'
  }
}

/**
 * 解析 memory.yml 文本 → 完整 MemoryConfig。
 * YAML 语法错误包装为 MemoryConfigError；字段非法同样抛 MemoryConfigError。
 * @param text - memory.yml 原文（utf8）
 * @returns 合并缺省后的完整配置（冻结）
 */
export function parseMemoryConfig(text: string): MemoryConfig {
  let raw: unknown
  try {
    raw = parseYaml(text)
  } catch (error) {
    throw new MemoryConfigError(`memory.yml 解析失败：${(error as Error).message}`)
  }
  // 空文档 / 纯注释文档 → 全部走默认
  if (raw === null || raw === undefined) return DEFAULT_CONFIG
  return resolveMemoryConfig(raw)
}

/**
 * 把未知结构的原始配置对象规范化为 MemoryConfig。
 * 缺省字段补默认；非法值 / 未知键一律抛 MemoryConfigError（fail loud）。
 * @param raw - YAML 解析产物（可为任意结构）
 * @returns 合并缺省后的完整配置（冻结）
 */
export function resolveMemoryConfig(raw: unknown): MemoryConfig {
  if (!isPlainObject(raw)) {
    throw new MemoryConfigError('memory.yml 顶层必须是映射（key: value）')
  }
  assertNoUnknownKeys(raw, TOP_LEVEL_KEYS, 'memory.yml')
  return deepFreeze({
    scope: enumOrDefault(raw.scope, VALID_SCOPES, DEFAULT_CONFIG.scope, 'scope'),
    layers: layersOrDefault(raw.layers),
    autoSink: booleanOrDefault(raw.auto_sink, DEFAULT_CONFIG.autoSink, 'auto_sink'),
    timeline: timelineOrDefault(raw.timeline),
    weeklyTemplate: stringOrDefault(raw.weekly_template, DEFAULT_CONFIG.weeklyTemplate, 'weekly_template'),
    maxEntries: positiveIntOrDefault(raw.max_entries, DEFAULT_CONFIG.maxEntries, 'max_entries'),
    inject: injectOrDefault(raw.inject),
    autoInject: autoInjectOrDefault(raw.auto_inject),
    roles: rolesOrDefault(raw.roles),
    audit: auditOrDefault(raw.audit),
  })
}

/** auto_inject 块：字段级缺省 + 未知键拒绝 */
function autoInjectOrDefault(value: unknown): MemoryConfig['autoInject'] {
  if (value === undefined || value === null) return DEFAULT_CONFIG.autoInject
  if (!isPlainObject(value)) {
    throw new MemoryConfigError('memory.yml: auto_inject 必须是映射（enabled/max_bytes/max_entries）')
  }
  assertNoUnknownKeys(value, AUTO_INJECT_KEYS, 'memory.yml.auto_inject')
  return deepFreeze({
    enabled: booleanOrDefault(value.enabled, DEFAULT_CONFIG.autoInject.enabled, 'auto_inject.enabled'),
    maxBytes: positiveIntOrDefault(value.max_bytes, DEFAULT_CONFIG.autoInject.maxBytes, 'auto_inject.max_bytes'),
    maxEntries: positiveIntOrDefault(value.max_entries, DEFAULT_CONFIG.autoInject.maxEntries, 'auto_inject.max_entries'),
  })
}

/** inject 块：字段级缺省 + 未知键拒绝 */
function injectOrDefault(value: unknown): MemoryConfig['inject'] {
  if (value === undefined || value === null) return DEFAULT_CONFIG.inject
  if (!isPlainObject(value)) {
    throw new MemoryConfigError('memory.yml: inject 必须是映射（enabled/max_bytes/max_entries）')
  }
  assertNoUnknownKeys(value, INJECT_KEYS, 'memory.yml.inject')
  return deepFreeze({
    enabled: booleanOrDefault(value.enabled, DEFAULT_CONFIG.inject.enabled, 'inject.enabled'),
    maxBytes: positiveIntOrDefault(value.max_bytes, DEFAULT_CONFIG.inject.maxBytes, 'inject.max_bytes'),
    maxEntries: positiveIntOrDefault(value.max_entries, DEFAULT_CONFIG.inject.maxEntries, 'inject.max_entries'),
  })
}

/**
 * 从磁盘加载并解析 memory.yml；文件不存在（ENOENT）→ 缺省配置。
 * 其余 IO 错误原样上抛（fail loud，不吞异常）。
 * @param filePath - memory.yml 完整路径（由 scope.ts 定位 workspace 后给出）
 * @returns 合并缺省后的完整配置（冻结）
 */
export async function loadMemoryConfig(filePath: string): Promise<MemoryConfig> {
  let text: string
  try {
    text = await readFile(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_CONFIG
    throw error
  }
  return parseMemoryConfig(text)
}

/** workspace 根目录 → .dsh/memory.yml 路径（供 scope.ts / tools.ts 接线） */
export function memoryConfigPath(workspaceRoot: string): string {
  return join(workspaceRoot, '.dsh', 'memory.yml')
}

// ---------- 校验辅助（全部 fail loud） ----------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 拒绝未知键，防止拼写错误被默认值悄悄掩盖 */
function assertNoUnknownKeys(
  obj: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  where: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new MemoryConfigError(
        `${where}: 未知配置键 "${key}"（允许：${[...allowed].join(', ')}）`,
      )
    }
  }
}

/** 枚举字段：缺省走默认，非法值抛错 */
function enumOrDefault(
  value: unknown,
  allowed: ReadonlySet<string>,
  fallback: MemoryConfig['scope'],
  name: string,
): MemoryConfig['scope'] {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw new MemoryConfigError(
      `memory.yml: ${name} 必须是 ${[...allowed].join(' | ')} 之一（实际：${JSON.stringify(value)}）`,
    )
  }
  return value as MemoryConfig['scope']
}

/** layers 字段：数组且每个元素是合法 kind；缺省走默认（空数组合法=关闭所有层级） */
function layersOrDefault(value: unknown): EntryKind[] {
  if (value === undefined || value === null) return [...DEFAULT_CONFIG.layers]
  if (!Array.isArray(value)) {
    throw new MemoryConfigError('memory.yml: layers 必须是数组')
  }
  const kinds: EntryKind[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !VALID_KINDS.includes(item)) {
      throw new MemoryConfigError(
        `memory.yml: layers 元素必须是 ${VALID_KINDS.join(' | ')} 之一（实际：${JSON.stringify(item)}）`,
      )
    }
    kinds.push(item as EntryKind)
  }
  return kinds
}

/** 布尔字段：缺省走默认，非法值抛错 */
function booleanOrDefault(value: unknown, fallback: boolean, name: string): boolean {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') {
    throw new MemoryConfigError(
      `memory.yml: ${name} 必须是布尔值（实际：${JSON.stringify(value)}）`,
    )
  }
  return value
}

/** timeline 块：字段级缺省 + 未知键拒绝 + archive 仅允许 keep */
function timelineOrDefault(value: unknown): MemoryConfig['timeline'] {
  if (value === undefined || value === null) return DEFAULT_CONFIG.timeline
  if (!isPlainObject(value)) {
    throw new MemoryConfigError('memory.yml: timeline 必须是映射（day/week/month/year/archive）')
  }
  assertNoUnknownKeys(value, TIMELINE_KEYS, 'memory.yml.timeline')
  return deepFreeze({
    day: booleanOrDefault(value.day, DEFAULT_CONFIG.timeline.day, 'timeline.day'),
    week: booleanOrDefault(value.week, DEFAULT_CONFIG.timeline.week, 'timeline.week'),
    month: booleanOrDefault(value.month, DEFAULT_CONFIG.timeline.month, 'timeline.month'),
    year: booleanOrDefault(value.year, DEFAULT_CONFIG.timeline.year, 'timeline.year'),
    archive: archiveOrDefault(value.archive),
  })
}

/** archive 字段：当前契约只允许 keep（见 types.ts MemoryConfig.timeline.archive） */
function archiveOrDefault(value: unknown): 'keep' {
  if (value === undefined || value === null) return DEFAULT_CONFIG.timeline.archive
  if (value !== 'keep') {
    throw new MemoryConfigError(
      `memory.yml: timeline.archive 目前只支持 "keep"（实际：${JSON.stringify(value)}）`,
    )
  }
  return value
}

/** 字符串字段：缺省走默认，非法值抛错 */
function stringOrDefault(value: unknown, fallback: string, name: string): string {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string') {
    throw new MemoryConfigError(
      `memory.yml: ${name} 必须是字符串（实际：${JSON.stringify(value)}）`,
    )
  }
  return value
}

/** 角色名：非空字符串，缺省走默认（空白串视为非法——静默的空角色会让准入语义退化） */
function roleNameOrDefault(value: unknown, fallback: string, name: string): string {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new MemoryConfigError(
      `memory.yml: ${name} 必须是非空字符串（实际：${JSON.stringify(value)}）`,
    )
  }
  return value.trim()
}

/** 正整数字段：缺省走默认，非正整数 / 非整数抛错 */
function positiveIntOrDefault(value: unknown, fallback: number, name: string): number {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new MemoryConfigError(
      `memory.yml: ${name} 必须是正整数（实际：${JSON.stringify(value)}）`,
    )
  }
  return value
}

// ---------- roles 段（v0.5） ----------

/** roles 块：字段级缺省 + 未知键拒绝 */
function rolesOrDefault(value: unknown): RolesConfig {
  if (value === undefined || value === null) return DEFAULT_ROLES_CONFIG
  if (!isPlainObject(value)) {
    throw new MemoryConfigError(
      'memory.yml: roles 必须是映射（enabled/default/derived/by_preset/policy_default/policies）',
    )
  }
  assertNoUnknownKeys(value, ROLES_KEYS, 'memory.yml.roles')
  return deepFreeze({
    enabled: booleanOrDefault(value.enabled, DEFAULT_ROLES_CONFIG.enabled, 'roles.enabled'),
    default: roleNameOrDefault(value.default, DEFAULT_ROLES_CONFIG.default, 'roles.default'),
    derived: roleNameOrDefault(value.derived, DEFAULT_ROLES_CONFIG.derived, 'roles.derived'),
    byPreset: presetMapOrDefault(value.by_preset),
    policyDefault: policyOrDefault(value.policy_default, DEFAULT_ROLES_CONFIG.policyDefault, 'roles.policy_default'),
    policies: policiesOrDefault(value.policies),
  })
}

/** by_preset：预设名 → 角色名（两侧皆非空字符串） */
function presetMapOrDefault(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return { ...DEFAULT_ROLES_CONFIG.byPreset }
  if (!isPlainObject(value)) {
    throw new MemoryConfigError('memory.yml: roles.by_preset 必须是映射（预设名: 角色名）')
  }
  const out: Record<string, string> = {}
  for (const [preset, role] of Object.entries(value)) {
    if (preset.trim().length === 0) {
      throw new MemoryConfigError('memory.yml: roles.by_preset 的键必须是非空预设名')
    }
    if (typeof role !== 'string' || role.trim().length === 0) {
      throw new MemoryConfigError(
        `memory.yml: roles.by_preset["${preset}"] 必须是非空角色名（实际：${JSON.stringify(role)}）`,
      )
    }
    out[preset] = role.trim()
  }
  return out
}

/** policies：角色 → 策略映射 */
function policiesOrDefault(value: unknown): Record<string, RolePolicy> {
  if (value === undefined || value === null) return { ...DEFAULT_ROLES_CONFIG.policies }
  if (!isPlainObject(value)) {
    throw new MemoryConfigError('memory.yml: roles.policies 必须是映射（角色名: 策略块）')
  }
  const out: Record<string, RolePolicy> = {}
  for (const [role, policy] of Object.entries(value)) {
    if (role.trim().length === 0) {
      throw new MemoryConfigError('memory.yml: roles.policies 的角色名不得为空')
    }
    out[role.trim()] = policyOrDefault(policy, DEFAULT_ROLES_CONFIG.policyDefault, `roles.policies.${role}`)
  }
  return out
}

/** 单条角色策略：字段级缺省 + 未知键拒绝 */
function policyOrDefault(value: unknown, fallback: RolePolicy, name: string): RolePolicy {
  if (value === undefined || value === null) return { ...fallback }
  if (!isPlainObject(value)) {
    throw new MemoryConfigError(
      `memory.yml: ${name} 必须是映射（read/kinds/include_shared/include_global）`,
    )
  }
  assertNoUnknownKeys(value, POLICY_KEYS, `memory.yml.${name}`)
  const out: RolePolicy = {
    read: readListOrDefault(value.read, fallback.read, `${name}.read`),
    includeShared: booleanOrDefault(value.include_shared, fallback.includeShared ?? true, `${name}.include_shared`),
    includeGlobal: booleanOrDefault(value.include_global, fallback.includeGlobal ?? true, `${name}.include_global`),
  }
  if (value.kinds !== undefined && value.kinds !== null) {
    out.kinds = layersOrDefault(value.kinds)
  } else if (fallback.kinds !== undefined) {
    out.kinds = [...fallback.kinds]
  }
  return out
}

/** read 白名单：字符串数组（`'*'` 合法 = 全部） */
function readListOrDefault(value: unknown, fallback: string[] | undefined, name: string): string[] {
  if (value === undefined || value === null) return [...(fallback ?? [])]
  if (!Array.isArray(value)) {
    throw new MemoryConfigError(`memory.yml: ${name} 必须是数组（如 ["*"] 或 ["main"]）`)
  }
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new MemoryConfigError(
        `memory.yml: ${name} 元素必须是非空字符串（实际：${JSON.stringify(item)}）`,
      )
    }
    out.push(item.trim())
  }
  return out
}

// ---------- audit 段（v0.6 价值体检器） ----------

/** audit 块：字段级缺省 + 未知键拒绝 */
function auditOrDefault(value: unknown): AuditConfig {
  if (value === undefined || value === null) return DEFAULT_AUDIT_CONFIG
  if (!isPlainObject(value)) {
    throw new MemoryConfigError(
      'memory.yml: audit 必须是映射（weights/keep_recent_days/archive_min_age_days/review_min_chars/demote_min_chars/access_trace）',
    )
  }
  assertNoUnknownKeys(value, AUDIT_KEYS, 'memory.yml.audit')
  return deepFreeze({
    weights: weightsOrDefault(value.weights),
    keepRecentDays: nonNegativeNumberOrDefault(value.keep_recent_days, DEFAULT_AUDIT_CONFIG.keepRecentDays, 'audit.keep_recent_days'),
    archiveMinAgeDays: nonNegativeNumberOrDefault(value.archive_min_age_days, DEFAULT_AUDIT_CONFIG.archiveMinAgeDays, 'audit.archive_min_age_days'),
    reviewMinChars: nonNegativeIntOrDefault(value.review_min_chars, DEFAULT_AUDIT_CONFIG.reviewMinChars, 'audit.review_min_chars'),
    demoteMinChars: nonNegativeIntOrDefault(value.demote_min_chars, DEFAULT_AUDIT_CONFIG.demoteMinChars, 'audit.demote_min_chars'),
    accessTrace: accessTraceOrDefault(value.access_trace),
    proposalLog: proposalLogOrDefault(value.proposal_log),
    compressTrace: compressTraceOrDefault(value.compress_trace),
  })
}

/** audit.compress_trace：压缩流水线轨迹开关与轮转阈值（v0.8 证据层） */
function compressTraceOrDefault(value: unknown): AuditConfig['compressTrace'] {
  const base = DEFAULT_AUDIT_CONFIG.compressTrace
  if (value === undefined || value === null) return { ...base }
  if (!isPlainObject(value)) {
    throw new MemoryConfigError('memory.yml: audit.compress_trace 必须是映射（enabled/max_bytes）')
  }
  assertNoUnknownKeys(value, ACCESS_TRACE_KEYS, 'memory.yml.audit.compress_trace')
  return {
    enabled: booleanOrDefault(value.enabled, base.enabled, 'audit.compress_trace.enabled'),
    maxBytes: nonNegativeIntOrDefault(value.max_bytes, base.maxBytes, 'audit.compress_trace.max_bytes'),
  }
}

/** audit.proposal_log：提案日志开关与轮转阈值（v0.7 · 让提案有历史） */
function proposalLogOrDefault(value: unknown): AuditConfig['proposalLog'] {
  const base = DEFAULT_AUDIT_CONFIG.proposalLog
  if (value === undefined || value === null) return { ...base }
  if (!isPlainObject(value)) {
    throw new MemoryConfigError('memory.yml: audit.proposal_log 必须是映射（enabled/max_bytes）')
  }
  assertNoUnknownKeys(value, ACCESS_TRACE_KEYS, 'memory.yml.audit.proposal_log')
  return {
    enabled: booleanOrDefault(value.enabled, base.enabled, 'audit.proposal_log.enabled'),
    maxBytes: nonNegativeIntOrDefault(value.max_bytes, base.maxBytes, 'audit.proposal_log.max_bytes'),
  }
}

/** audit.weights：逐项非负数（缺省走默认先验） */
function weightsOrDefault(value: unknown): AuditWeights {
  const base = DEFAULT_AUDIT_CONFIG.weights
  if (value === undefined || value === null) return { ...base }
  if (!isPlainObject(value)) {
    throw new MemoryConfigError('memory.yml: audit.weights 必须是映射（ref/recent/usage/tag/role/size/dup）')
  }
  assertNoUnknownKeys(value, WEIGHT_KEYS, 'memory.yml.audit.weights')
  return {
    ref: nonNegativeNumberOrDefault(value.ref, base.ref, 'audit.weights.ref'),
    recent: nonNegativeNumberOrDefault(value.recent, base.recent, 'audit.weights.recent'),
    usage: nonNegativeNumberOrDefault(value.usage, base.usage, 'audit.weights.usage'),
    tag: nonNegativeNumberOrDefault(value.tag, base.tag, 'audit.weights.tag'),
    role: nonNegativeNumberOrDefault(value.role, base.role, 'audit.weights.role'),
    size: nonNegativeNumberOrDefault(value.size, base.size, 'audit.weights.size'),
    dup: nonNegativeNumberOrDefault(value.dup, base.dup, 'audit.weights.dup'),
  }
}

/** audit.access_trace：侧车轨迹开关与轮转阈值 */
function accessTraceOrDefault(value: unknown): AuditConfig['accessTrace'] {
  const base = DEFAULT_AUDIT_CONFIG.accessTrace
  if (value === undefined || value === null) return { ...base }
  if (!isPlainObject(value)) {
    throw new MemoryConfigError('memory.yml: audit.access_trace 必须是映射（enabled/max_bytes）')
  }
  assertNoUnknownKeys(value, ACCESS_TRACE_KEYS, 'memory.yml.audit.access_trace')
  return {
    enabled: booleanOrDefault(value.enabled, base.enabled, 'audit.access_trace.enabled'),
    maxBytes: nonNegativeIntOrDefault(value.max_bytes, base.maxBytes, 'audit.access_trace.max_bytes'),
  }
}

/** 非负数字段（年龄/天数允许小数；负数与 NaN/Infinity 拒绝） */
function nonNegativeNumberOrDefault(value: unknown, fallback: number, name: string): number {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new MemoryConfigError(
      `memory.yml: ${name} 必须是非负有限数字（实际：${JSON.stringify(value)}）`,
    )
  }
  return value
}

/** 非负整数字段（0 合法：如 max_bytes=0 表示不轮转） */
function nonNegativeIntOrDefault(value: unknown, fallback: number, name: string): number {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new MemoryConfigError(
      `memory.yml: ${name} 必须是非负整数（实际：${JSON.stringify(value)}）`,
    )
  }
  return value
}

/** 深度冻结（防止调用方误改共享配置对象） */function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
    Object.freeze(value)
  }
  return value
}
