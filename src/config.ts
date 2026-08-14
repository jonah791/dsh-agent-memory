/**
 * 项目记忆配置（IMPLEMENTATION.md §2.3）——memory.yml 解析 + 默认值。
 *
 * 配置来源：工作区 `.dsh/memory.yml`。
 * - 文件缺失 / 字段缺失 → 走缺省配置（DEFAULT_CONFIG）
 * - 文件存在但解析失败（YAML 语法错误或字段非法）→ fail loud（抛错，绝不静默吞掉）
 *
 * 本模块是纯函数层，不依赖 Cordis 运行时，便于离线单测（tests/config.test.ts）。
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { EntryKind, MemoryConfig } from './types.ts'

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
])

/** inject 块内合法键 */
const INJECT_KEYS: ReadonlySet<string> = new Set(['enabled', 'max_bytes', 'max_entries'])

/** timeline 块内合法键 */
const TIMELINE_KEYS: ReadonlySet<string> = new Set(['day', 'week', 'month', 'year', 'archive'])

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

/** 深度冻结（防止调用方误改共享配置对象） */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
    Object.freeze(value)
  }
  return value
}
