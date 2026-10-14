/**
 * 侧车用量轨迹（v0.6）——记「谁、什么时候、读了哪些条目」。
 *
 * 为什么需要它：MAGE 的价值函数里 `u(x)`（使用次数）与复述型衰减
 * `S(x)=S_0(1+κ_S·ln(1+u))` 依赖真实使用信号；本插件原先**没有**任何使用信号
 * （实测：读路径不刷新 `accessedAt`）。所以在**不改条目**的前提下补一层侧车。
 *
 * 纪律（对齐 AGENTS.md §5.22「观测绝不反噬主流程」）：
 *  1. **只追加**（POSIX append，天然免锁，跨进程安全）
 *  2. **吞错**：任何写失败只返回 `false`，绝不抛、绝不阻塞 recall
 *  3. **按体积轮转**：超 `maxBytes` 改名 `.1` 重开（不无限长大）
 *  4. **绝不改条目**：读路径不产生对记忆库的写副作用
 *  5. **可关**：`audit.access_trace.enabled: false` 即完全不落盘
 *
 * 纯函数部分（`parseAccessTrace` / `shouldRotate` / `summarizeAccess`）离线可测。
 */

import { appendFile, rename, stat, readFile } from 'node:fs/promises'

/** 一行轨迹记录 */
export interface AccessRecord {
  atMs: number
  /** 来源：工具 recall / 自动注入 auto-recall */
  source: 'recall' | 'auto' | 'audit'
  /** 调用者角色（v0.5；未知留空） */
  role?: string
  /** 命中条目 id（上限见 MAX_IDS_PER_RECORD） */
  ids: string[]
}

/** 单行最多记多少个 id（防长文把轨迹撑爆） */
export const MAX_IDS_PER_RECORD = 30

/**
 * 归因位置衰减的先验（**不是拟合值**）：第 pos 位（0 起）的权重 = `decay^pos`。
 *
 * 0.6 ⇒ 第 1 位 1.0 · 第 3 位 0.36 · 第 5 位 0.13 · 第 10 位 0.006 —— 与 DREAM 小 τ_u 的
 * 尖锐 softmax 同向：「被排到很后面」不该与第 1 位同权。
 *
 * ⚠ 为什么**不做成 `memory.yml` 配置**（诚实登记，不是疏漏）：
 *   ① 轨迹 `memory-access-trace.jsonl` 是**全局侧车**，而 `audit` 配置是**每 workspace** 的
 *      —— 按 workspace 配置解析同一份文件，会出现「同一份轨迹在不同 workspace 得到不同索引」
 *      的语义疙瘩；
 *   ② 爆炸半径小：`classify()` 完全不消费 usage（分档只看绝对阈值与 evidence），本项
 *      **只影响同档内排序**，不改变任何归档/降级结论；
 *   ③ 论文实测参数敏感（附录 H：λ₀ 最敏感、k 过大会过度剪枝）⇒ 要调必须带真库读数一起调，
 *      不凭直觉。取值依据见 v0.12 迁移记录（真库分布核对）。
 */
export const DEFAULT_ATTRIBUTION_DECAY = 0.6

/** 轨迹索引项 */
export interface AccessStat {
  hits: number
  lastAtMs: number
  /**
   * 排序加权归因（v0.12 · DREAM 迁移）——`Σ decay^pos`，pos = 该 id 在**那一次返回列表**中的位置。
   *
   * 与 `hits` 的分工（这才是本项存在的理由）：`hits` = 被返回过几次，**不分位置**——第 1 位与
   * 第 20 位同权，于是「返回 20 条全是泛词命中」的噪声与「真正的金标命中」被记成同一个数。
   * `attributed` = 按位置加权的等效次数：3 次都在第 1 位 ⇒ 3.0；3 次都在第 15 位 ⇒ ≈0.001。
   *
   * 出处：DREAM（arXiv 2610.13267）附录 G Eq.29 `aᵢ(t) = softmax(Score(q_t, vᵢ) / τ_u)`
   * ——被检索的记忆按**检索分数**分走该轮效用。本插件不在轨迹里存分数（只存有序 id），
   * 故取 softmax 的**序数形态**：位置是排序的单调摘要。
   */
  attributed: number
}

/**
 * 解析轨迹文本 → 用量索引（纯函数）。
 * 坏行（非 JSON / 缺字段）**跳过不抛**——轨迹是旁证，永远不能成为故障源。
 *
 * v0.12：同时算出**排序加权归因** `attributed`。位置信息（`ids` 的数组下标）一直都在轨迹里
 * ⇒ **历史轨迹无需迁移即可回溯归因**——这是选「序数形态」而非「写入时另记分数」的收益之一。
 * @param text - jsonl 全文
 * @param decay - 位置衰减（缺省 DEFAULT_ATTRIBUTION_DECAY）
 * @returns id → { hits, lastAtMs, attributed }
 */
export function parseAccessTrace(text: string, decay = DEFAULT_ATTRIBUTION_DECAY): Map<string, AccessStat> {
  const out = new Map<string, AccessStat>()
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let record: unknown
    try {
      record = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (typeof record !== 'object' || record === null) continue
    const r = record as { atMs?: unknown; ids?: unknown }
    const atMs = typeof r.atMs === 'number' && Number.isFinite(r.atMs) ? r.atMs : 0
    if (!Array.isArray(r.ids)) continue
    // 位置取**数组下标**而非「有效 id 计数器」：坏元素不该让它后面的条目排名前移
    for (let pos = 0; pos < r.ids.length; pos++) {
      const id = r.ids[pos]
      if (typeof id !== 'string' || id.length === 0) continue
      const weight = decay ** pos
      const current = out.get(id)
      if (current === undefined) out.set(id, { hits: 1, lastAtMs: atMs, attributed: weight })
      else {
        current.hits += 1
        current.attributed += weight
        if (atMs > current.lastAtMs) current.lastAtMs = atMs
      }
    }
  }
  return out
}

/** 是否应轮转（纯函数）：已超上限且当前已有内容 */
export function shouldRotate(sizeBytes: number, maxBytes: number): boolean {
  return maxBytes > 0 && sizeBytes >= maxBytes
}

/**
 * 追加一条轨迹（**吞错**）。
 * @param filePath - 轨迹文件路径
 * @param record - 记录（ids 超上限自动截断）
 * @param maxBytes - 轮转阈值（≤0 表示不轮转）
 * @returns 是否写入成功（失败只返回 false，不抛）
 */
/**
 * 通用 JSONL 侧车追加（**吞错**）：只追加 / 超限轮转 / 失败返回 false。
 * 用量轨迹与提案日志共用本函数——**写入纪律只有一份实现**（§5.22 判据单一真源）。
 */
export async function appendJsonl(
  filePath: string,
  record: unknown,
  maxBytes: number,
): Promise<boolean> {
  try {
    if (maxBytes > 0) {
      try {
        const info = await stat(filePath)
        if (shouldRotate(info.size, maxBytes)) await rename(filePath, `${filePath}.1`)
      } catch {
        // 文件不存在 / 无法 stat：直接继续写（首次写入路径）
      }
    }
    await appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * 追加一条用量轨迹（**吞错**）：只交出命中 id，绝不改条目。
 * @param filePath - 轨迹文件路径
 * @param record - 记录（ids 超上限自动截断；空 ids 不写）
 * @param maxBytes - 轮转阈值（≤0 表示不轮转）
 * @returns 是否写入成功（失败只返回 false，不抛）
 */
export async function appendAccessTrace(
  filePath: string,
  record: AccessRecord,
  maxBytes: number,
): Promise<boolean> {
  const capped: AccessRecord = {
    atMs: record.atMs,
    source: record.source,
    ...(record.role !== undefined && record.role.length > 0 ? { role: record.role } : {}),
    ids: record.ids.slice(0, MAX_IDS_PER_RECORD),
  }
  if (capped.ids.length === 0) return false
  return appendJsonl(filePath, capped, maxBytes)
}

/**
 * 用量轨迹汇总（纯函数）——**命中率度量的唯一口径**：
 * 「环境是否真的建起来了」看 `auto`（系统注入）与 `recall`（我主动查）的比值，不看感觉。
 * 坏行跳过（同 parseAccessTrace）。
 */
export interface AccessSummary {
  /** 系统注入次数 */
  autoCalls: number
  /** 主动检索次数 */
  recallCalls: number
  /** 去重后的命中条目数 */
  distinctIds: number
  /** 命中总次数（含重复命中） */
  totalHits: number
  /** 最近一次写入时刻（ms；无记录为 0） */
  lastAtMs: number
}

export function summarizeAccessRecords(text: string): AccessSummary {
  const out: AccessSummary = { autoCalls: 0, recallCalls: 0, distinctIds: 0, totalHits: 0, lastAtMs: 0 }
  const ids = new Set<string>()
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let record: unknown
    try {
      record = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (typeof record !== 'object' || record === null) continue
    const r = record as { atMs?: unknown; source?: unknown; ids?: unknown }
    const atMs = typeof r.atMs === 'number' && Number.isFinite(r.atMs) ? r.atMs : 0
    if (atMs > out.lastAtMs) out.lastAtMs = atMs
    if (r.source === 'auto') out.autoCalls += 1
    else if (r.source === 'recall') out.recallCalls += 1
    if (!Array.isArray(r.ids)) continue
    for (const id of r.ids) {
      if (typeof id !== 'string' || id.length === 0) continue
      ids.add(id)
      out.totalHits += 1
    }
  }
  out.distinctIds = ids.size
  return out
}

/** 读取并汇总用量轨迹（**吞错**）：不可读 ⇒ undefined（调用方按「无信号」处理） */
export async function readAccessSummary(filePath: string): Promise<AccessSummary | undefined> {
  try {
    const text = await readFile(filePath, 'utf8')
    const summary = summarizeAccessRecords(text)
    return summary.autoCalls + summary.recallCalls > 0 ? summary : undefined
  } catch {
    return undefined
  }
}

/** 追加一条提案日志（audit 候选 / forget-update 动作；**吞错**、只追加、可轮转） */
export async function appendProposalRecord(
  filePath: string,
  record: unknown,
  maxBytes: number,
): Promise<boolean> {
  return appendJsonl(filePath, record, maxBytes)
}


/**
 * 读取轨迹索引（**吞错**）：文件不存在或不可读 ⇒ 返回 undefined（调用方按「无用量信号」处理）。
 */
export async function readAccessIndex(filePath: string): Promise<Map<string, AccessStat> | undefined> {
  try {
    const text = await readFile(filePath, 'utf8')
    const index = parseAccessTrace(text)
    return index.size > 0 ? index : undefined
  } catch {
    return undefined
  }
}

/**
 * 解析「已裁决标记」侧车文本 → id → **最后一次**裁决时刻（纯函数，离线可测）。
 *
 * 坏行（非 JSON / 缺字段 / 非标记行）**跳过不抛**——侧车是旁证，永远不能成为故障源（同 §5.22 §3）。
 * @param text - jsonl 全文
 * @returns id → atMs（同 id 多次标记取**最大** atMs，即最近一次裁决）
 */
export function parseReviewMarks(text: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      const rec = JSON.parse(trimmed) as { kind?: unknown; id?: unknown; atMs?: unknown }
      if (rec.kind !== 'review-mark') continue
      if (typeof rec.id !== 'string' || rec.id.length === 0) continue
      if (typeof rec.atMs !== 'number' || !Number.isFinite(rec.atMs)) continue
      const prev = out.get(rec.id)
      if (prev === undefined || rec.atMs > prev) out.set(rec.id, rec.atMs)
    } catch { /* 坏行跳过 */ }
  }
  return out
}

/**
 * 读取已裁决标记（**吞错**）：文件不存在或不可读 ⇒ 返回 undefined（调用方按「无标记信号」处理）。
 * 与 `readAccessIndex` 同一分工：IO 只负责取文本，解析在纯函数里。
 */
export async function readReviewMarks(filePath: string): Promise<Map<string, number> | undefined> {
  try {
    const text = await readFile(filePath, 'utf8')
    const marks = parseReviewMarks(text)
    return marks.size > 0 ? marks : undefined
  } catch {
    return undefined
  }
}
