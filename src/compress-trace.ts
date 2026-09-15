/**
 * 压缩流水线轨迹（v0.8）——记「这一轮扫描看到什么、压了什么、**为什么没压**」。
 *
 * 为什么需要它（2026-09-15 实况）：跨条目巡检发现库级结构异常——
 *   ① `日概要 2026-09-13` / `日概要 2026-09-14` 缺失（全库 grep 无）；
 *   ② `周概要 2026-W37` 缺失（该周已有 4 个日概要为原料、单位已结束两天）；
 *   ③ 而 §5.6 明写「含历史缺口回填」⇒ 声明与事实背离，且**根因不可判**：
 *   本流水线只有 `console.log` / `console.error`，而宿主 logger **不落盘**
 *   （AGENTS.md §5.22 规则 1）⇒ 五问里的 ③「断在哪一段」答不了。
 *   按 §5.22「先补证据层，再修业务逻辑」，本模块先落证据。
 *
 * 纪律（与 access-trace.ts 同源，**写入实现只有一份** = `appendJsonl`）：
 *   1. 只追加（POSIX append，免锁、跨进程安全）
 *   2. 吞错：任何写失败返回 `false`，绝不抛、绝不阻塞压缩
 *   3. 按体积轮转（超 `maxBytes` 改名 `.1`）
 *   4. 绝不改条目（纯观测，不产生对记忆库的写副作用）
 *   5. 可关：`memory.yml` 的 `audit.compress_trace.enabled: false` 即完全不落盘
 *
 * 纯函数部分（`summarizeCompressTrace` / 样本截断）离线可测。
 */

import { readFile } from 'node:fs/promises'
import { appendJsonl } from './access-trace.ts'

/** 阶段：`scan`（本轮候选与逐桶判定）/ `unit`（单个压缩单元）/ `end`（收尾）/ `error` */
export type CompressPhase = 'scan' | 'unit' | 'end' | 'error'

/**
 * 压缩流水线事件（调用方给出的最小形状）。
 * `atMs` / `trigger` 由装配层补齐——压缩器本身不该知道「谁触发了我」。
 */
export interface CompressTraceEvent {
  /** 作用域（记忆分区） */
  scope: string
  phase: CompressPhase
  /** scan：候选桶总数 */
  candidates?: number
  /** scan：本轮判定为待压缩的桶数 */
  pending?: number
  /** scan：非待压缩候选的判定分布（decision → 桶数） */
  skipped?: Record<string, number>
  /** scan：逐桶样本行（`<level> <bucket> <decision>`），上限 MAX_SAMPLE */
  sample?: string[]
  /** unit：层级与桶 */
  level?: string
  bucket?: string
  /** unit：结果原因（compressed / no-sources / already-summarized） */
  reason?: string
  /** unit：原料条数与归档条数 */
  sources?: number
  archived?: number
  /** unit：概要正文字符数 */
  chars?: number
  /** unit / end：耗时 */
  durMs?: number
  /** end：本次压缩完成的单元数 */
  units?: number
  /** end：本轮总耗时 */
  totalMs?: number
  /** error：错误信息（fail loud 的证据面） */
  message?: string
}

/** 一行轨迹（落盘形状） */
export interface CompressTraceRecord extends CompressTraceEvent {
  atMs: number
  /** 触发路径：周期补压 / 访问记忆时的懒压缩 */
  trigger: 'lazy' | 'periodic'
}

/**
 * 轨迹接收器（**同步、fire-and-forget**）：压缩器只把事件交出去，不关心落到哪、是否落。
 * 装配层负责补齐 `atMs` / `trigger` 并调用 `appendCompressTrace`（吞错）。
 */
export type CompressTraceSink = (event: CompressTraceEvent) => void

/** 每个阶段最多记多少个候选样本（防长文把轨迹撑爆） */
export const MAX_SAMPLE = 40

/**
 * 追加一条压缩轨迹（**吞错**）：样本超上限自动截断。
 * @param filePath - 轨迹文件路径
 * @param record - 记录
 * @param maxBytes - 轮转阈值（≤0 = 不轮转）
 * @returns 是否写入成功（失败只返回 false，不抛）
 */
export async function appendCompressTrace(
  filePath: string,
  record: CompressTraceRecord,
  maxBytes: number,
): Promise<boolean> {
  const capped: CompressTraceRecord = record.sample === undefined
    ? record
    : { ...record, sample: record.sample.slice(0, MAX_SAMPLE) }
  return appendJsonl(filePath, capped, maxBytes)
}

/** 轨迹汇总（**最近一次扫描**的口径 + 累计计数） */
export interface CompressSummary {
  /** 累计扫描轮数 */
  scans: number
  /** 累计完成压缩单元数 */
  units: number
  /** 累计错误数 */
  errors: number
  /** 最近一次扫描：候选桶数 */
  candidatesLast: number
  /** 最近一次扫描：待压缩桶数 */
  pendingLast: number
  /** 最近一次扫描：非待压缩判定分布 */
  skippedLast: Record<string, number>
  /** 最近一次扫描：逐桶样本 */
  sampleLast: string[]
  /** 最近一次写入时刻（ms；无记录为 0） */
  lastAtMs: number
  /** 最近一次写入的触发路径（无记录为空串） */
  lastTrigger: string
}

/**
 * 解析轨迹文本 → 汇总（纯函数）。
 * 坏行（非 JSON / 缺字段 / 形状不符）**跳过不抛**——轨迹是旁证，永不能成为故障源。
 */
export function summarizeCompressTrace(text: string): CompressSummary {
  const out: CompressSummary = {
    scans: 0,
    units: 0,
    errors: 0,
    candidatesLast: 0,
    pendingLast: 0,
    skippedLast: {},
    sampleLast: [],
    lastAtMs: 0,
    lastTrigger: '',
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let raw: unknown
    try {
      raw = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const r = raw as Record<string, unknown>
    const atMs = typeof r.atMs === 'number' && Number.isFinite(r.atMs) ? r.atMs : 0
    if (atMs > out.lastAtMs) {
      out.lastAtMs = atMs
      out.lastTrigger = typeof r.trigger === 'string' ? r.trigger : ''
    }
    const phase = typeof r.phase === 'string' ? r.phase : ''
    if (phase === 'scan') {
      out.scans += 1
      out.candidatesLast = intOr(r.candidates, out.candidatesLast)
      out.pendingLast = intOr(r.pending, out.pendingLast)
      out.skippedLast = countMapOr(r.skipped)
      out.sampleLast = stringListOr(r.sample)
    } else if (phase === 'unit') {
      out.units += 1
    } else if (phase === 'error') {
      out.errors += 1
    }
  }
  return out
}

/**
 * 读取并汇总压缩轨迹（**吞错**）：不可读 / 无记录 ⇒ `undefined`（调用方按「无信号」处理）。
 */
export async function readCompressSummary(filePath: string): Promise<CompressSummary | undefined> {
  try {
    const text = await readFile(filePath, 'utf8')
    const summary = summarizeCompressTrace(text)
    return summary.lastAtMs > 0 ? summary : undefined
  } catch {
    return undefined
  }
}

/** 判定分布 → 人类可读短串（如 `already-summarized 12, no-sources 3`），供工具渲染 */
export function formatSkipped(skipped: Record<string, number>): string {
  const pairs = Object.entries(skipped)
  if (pairs.length === 0) return '无'
  return pairs
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, count]) => `${key} ${count}`)
    .join(', ')
}

// ---------- 解析辅助（形状不符即丢弃，绝不抛） ----------

function intOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback
}

function countMapOr(value: unknown): Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const out: Record<string, number> = {}
  for (const [key, count] of Object.entries(value as Record<string, unknown>)) {
    if (typeof count === 'number' && Number.isInteger(count) && count >= 0) out[key] = count
  }
  return out
}

function stringListOr(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0)
}
