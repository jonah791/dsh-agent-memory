/**
 * 价值体检器（v0.6 · `memory_audit`）——**只读提案器**。
 *
 * 回答唯一问题：「库里哪些条目值得继续占位置，哪些该降级/归档？」
 * 输出是**决策 + 证据行**，不是排行榜；**提案 ≠ 裁决**——本模块不归档、不删除、不写库。
 *
 * 信号（2026-09-15 对生产库实测后定稿，缺什么就承认缺什么）：
 *   ✅ refs    条目被更晚条目的 archiveRef 引用（承重原料；实测 177/676）
 *   ✅ age     条目年龄（createdAt/updatedAt）
 *   ✅ chars   体量
 *   ✅ tags    标签数与标签复用度（覆盖率最高的语义信号）
 *   ✅ role/author 归属与溯源（实测覆盖率极低 ⇒ 权重低）
 *   ✅ dup     近重复簇（标题指纹）
 *   ⚠️ usage   侧车轨迹命中次数——**未采集轨迹时恒 0**，公式不因此失真，只少一项证据
 *   ❌ 下游增益 g(x) / 矛盾计数 cnt(x) / 置信 κ(x) —— 本版**不假装有**
 *
 * 评分（序数；权重是**启发式先验不是拟合值**，校准是 v3 的事）：
 *   score = w_ref·refScore + w_recent·recency + w_usage·usageScore
 *         + w_tag·tagScore + w_role·roleScore − w_size·sizeScore − w_dup·dupPenalty
 *   recency = exp(−ageDays / S)，S = 30 天（MAGE 的 R(x,t)，减去复述项）
 *
 * 分档顺序（可复现）：REVIEW → KEEP → ARCHIVE → DEMOTE → KEEP（小体量兜底）。
 * 纯函数层：不依赖 Cordis / fs，离线可测（tests/audit.test.mjs）。
 */

import type {
  AuditBucket,
  AuditCandidate,
  AuditConfig,
  AuditGroup,
  AuditQuery,
  AuditResult,
  AuditWeights,
  Entry,
} from './types.ts'

/** 缺省权重（和 = 1.0；**先验**，非拟合） */
export const DEFAULT_AUDIT_WEIGHTS: AuditWeights = Object.freeze({
  ref: 0.30,
  recent: 0.20,
  usage: 0.15,
  tag: 0.10,
  role: 0.10,
  size: 0.08,
  dup: 0.07,
})

/** 缺省体检配置（`memory.yml` 的 `audit` 段；深冻结） */
export const DEFAULT_AUDIT_CONFIG: AuditConfig = Object.freeze({
  weights: DEFAULT_AUDIT_WEIGHTS,
  /** 近 7 天一律 KEEP（保新：在用的东西不该被建议归档） */
  keepRecentDays: 7,
  /** 少于此年龄不判 ARCHIVE */
  archiveMinAgeDays: 14,
  /** 体量 ≥ 此字符数 → REVIEW（交人裁决：超大条目先看清楚再动） */
  reviewMinChars: 12000,
  /** 未引用且体量 ≥ 此字符数 → DEMOTE（可降级/压缩） */
  demoteMinChars: 3000,
  accessTrace: Object.freeze({ enabled: true, maxBytes: 2_000_000 }),
})

/** 复述衰减的基准稳定度（天）——MAGE 用 30 天半衰期 */
const RECENCY_SCALE_DAYS = 30

/** 体检输入 */
export interface AuditInput {
  /** 候选条目（调用方已按视野过滤——体检是读路径，必须过角色准入） */
  entries: readonly Entry[]
  /** 配置（audit 段；缺省 DEFAULT_AUDIT_CONFIG） */
  config?: AuditConfig
  /** 逻辑轨迹索引：id → 命中次数/最后命中（缺省 = 无轨迹，usage 恒 0） */
  usage?: Map<string, { hits: number; lastAtMs: number }>
  /** 当前时刻（缺省 Date.now()；测试注入固定时钟） */
  now?: number
  /** 查询选项 */
  query?: AuditQuery
}

/** 条目正文长度 */
function charsOf(entry: Entry): number {
  return (entry.body ?? '').length
}

/** 条目年龄（天，非负） */
function ageDaysOf(entry: Entry, nowMs: number): number {
  const t = Date.parse(entry.updatedAt ?? entry.createdAt)
  if (Number.isNaN(t)) return 0
  return Math.max(0, (nowMs - t) / 86_400_000)
}

/** 由 createdAt 生成日桶（本地时区，YYYY-MM-DD）——用于「是否已被概要覆盖」判定 */
function dayBucketOf(iso: string): string {
  const d = new Date(iso)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/**
 * 承重索引：统计每个条目被多少条更晚条目通过 `archiveRef` 引用。
 * 语义 = 「被概要吸收过的原料」——**有引用即承重，任何年龄/体量都不能推翻**（A32 反例）。
 */
export function referenceIndex(entries: readonly Entry[]): Map<string, number> {
  const refs = new Map<string, number>()
  for (const entry of entries) {
    for (const id of entry.archiveRef ?? []) {
      refs.set(id, (refs.get(id) ?? 0) + 1)
    }
  }
  return refs
}

/** 标签复用度：与该条目共享 ≥1 个标签的其他条目数（衡量「它连着什么」） */
export function tagReuseIndex(entries: readonly Entry[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const entry of entries) {
    let shared = 0
    for (const other of entries) {
      if (other.id === entry.id) continue
      if (other.tags.some((tag) => entry.tags.includes(tag))) shared += 1
    }
    out.set(entry.id, shared)
  }
  return out
}

/**
 * 近重复簇：标题归一化后相同（或互相为前缀）的条目归为一簇。
 * 簇内 canonical = 最新的一条（保留最新、其余进 REVIEW 交人裁决）。
 * @returns 每个条目 → { cluster 序号, canonicalId }（非重复条目不在返回值中）
 */
export function duplicateClusters(
  entries: readonly Entry[],
): Map<string, { cluster: number; canonicalId: string }> {
  const groups = new Map<string, Entry[]>()
  for (const entry of entries) {
    const key = (entry.title ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
    if (key.length === 0) continue
    const list = groups.get(key)
    if (list === undefined) groups.set(key, [entry])
    else list.push(entry)
  }
  const out = new Map<string, { cluster: number; canonicalId: string }>()
  let n = 0
  for (const list of groups.values()) {
    if (list.length < 2) continue
    n += 1
    const canonical = [...list].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0] as Entry
    for (const entry of list) out.set(entry.id, { cluster: n, canonicalId: canonical.id })
  }
  return out
}

/** 归一化（0..1）工具：对数压缩 + 封顶 1，避免单项主导 */
function logNorm(value: number, cap: number): number {
  if (value <= 0) return 0
  return Math.min(1, Math.log1p(value) / Math.log1p(cap))
}

/** 单条评分与证据（导出以便单测逐项断言） */
export interface ScoreBreakdown {
  score: number
  terms: {
    ref: number
    recent: number
    usage: number
    tag: number
    role: number
    size: number
    dup: number
  }
  evidence: AuditCandidate['evidence']
}

/**
 * 给单条打分（纯函数）。
 * @param entry - 目标条目
 * @param ctx - 预计算索引（引用/标签复用/重复簇/用量）+ 配置 + 时刻 + 摘要桶集合
 */
export function scoreEntry(
  entry: Entry,
  ctx: {
    weights: AuditWeights
    refs: Map<string, number>
    tagReuse: Map<string, number>
    usage?: Map<string, { hits: number; lastAtMs: number }>
    dups: Map<string, { cluster: number; canonicalId: string }>
    nowMs: number
  },
): ScoreBreakdown {
  const { weights } = ctx
  const chars = charsOf(entry)
  const ageDays = ageDaysOf(entry, ctx.nowMs)
  const refs = ctx.refs.get(entry.id) ?? 0
  const hits = ctx.usage?.get(entry.id)?.hits ?? 0
  const tags = entry.tags.length
  const shared = ctx.tagReuse.get(entry.id) ?? 0
  const dup = ctx.dups.get(entry.id)

  const refScore = logNorm(refs, 5)
  const recency = Math.exp(-ageDays / RECENCY_SCALE_DAYS)
  const usageScore = logNorm(hits, 10)
  const tagScore = 0.5 * Math.min(1, tags / 4) + 0.5 * logNorm(shared, 20)
  const roleScore = entry.role !== undefined && entry.role.length > 0
    ? 1
    : (entry.author !== undefined ? 0.5 : 0)
  const sizeScore = Math.min(1, chars / 8000)
  const dupPenalty = dup !== undefined ? 1 : 0

  const terms = {
    ref: refScore,
    recent: recency,
    usage: usageScore,
    tag: tagScore,
    role: roleScore,
    size: sizeScore,
    dup: dupPenalty,
  }
  const score =
    weights.ref * terms.ref +
    weights.recent * terms.recent +
    weights.usage * terms.usage +
    weights.tag * terms.tag +
    weights.role * terms.role -
    weights.size * terms.size -
    weights.dup * terms.dup

  return {
    score,
    terms,
    evidence: {
      ageDays: Math.round(ageDays * 10) / 10,
      chars,
      refs,
      usage: hits,
      tags,
      hasSource: entry.source !== undefined,
      ...(entry.role !== undefined ? { role: entry.role } : {}),
      ...(dup !== undefined ? { dupCluster: dup.cluster, dupOf: dup.canonicalId } : {}),
    },
  }
}

/**
 * 分档（按序判定，可复现）：
 *  1. REVIEW   落在重复簇 / 体量 ≥ reviewMinChars
 *  2. KEEP     被引用（承重）**或** age ≤ keepRecentDays **或** 有 role+author
 *  3. ARCHIVE  未引用 且 age ≥ archiveMinAgeDays 且 无 source
 *  4. DEMOTE   未引用 且 体量 ≥ demoteMinChars
 *  5. KEEP     兜底（未被引用但体量小且不新——留着不心疼）
 */
export function classify(
  entry: Entry,
  breakdown: ScoreBreakdown,
  config: AuditConfig,
): { bucket: AuditBucket; reasons: string[] } {
  const e = breakdown.evidence
  const reasons: string[] = []

  if (e.dupCluster !== undefined) {
    reasons.push(`近重复簇 #${e.dupCluster}（canonical=${e.dupOf ?? '?'}）——交人裁决合并或归档`)
    return { bucket: 'REVIEW', reasons }
  }
  if (e.chars >= config.reviewMinChars) {
    reasons.push(`体量 ${e.chars} 字符 ≥ review_min_chars(${config.reviewMinChars})——先看清再动`)
    return { bucket: 'REVIEW', reasons }
  }
  if (e.refs > 0) {
    reasons.push(`承重：被 ${e.refs} 条更晚条目通过 archiveRef 引用——不可归档`)
    return { bucket: 'KEEP', reasons }
  }
  if (e.ageDays <= config.keepRecentDays) {
    reasons.push(`新（${e.ageDays} 天 ≤ keep_recent_days ${config.keepRecentDays}）——保新`)
    return { bucket: 'KEEP', reasons }
  }
  if (e.role !== undefined || e.chars === 0) {
    if (e.role !== undefined) reasons.push(`有角色归属（role=${e.role}）——工作台产物`)
    return { bucket: 'KEEP', reasons }
  }
  if (e.ageDays >= config.archiveMinAgeDays && !e.hasSource) {
    reasons.push(`未引用 + ${e.ageDays} 天 ≥ archive_min_age_days(${config.archiveMinAgeDays}) + 无溯源——归档候选`)
    return { bucket: 'ARCHIVE', reasons }
  }
  if (e.chars >= config.demoteMinChars) {
    reasons.push(`未引用且体量 ${e.chars} ≥ demote_min_chars(${config.demoteMinChars})——可降级/压缩`)
    return { bucket: 'DEMOTE', reasons }
  }
  reasons.push(`未引用但体量小（${e.chars} 字符）——留着不心疼`)
  return { bucket: 'KEEP', reasons }
}

/** 空桶计数 */
function emptyBuckets(): Record<AuditBucket, number> {
  return { KEEP: 0, DEMOTE: 0, ARCHIVE: 0, REVIEW: 0 }
}

/**
 * 体检主入口（纯函数）：打分 → 分档 → 聚合 → 采集候选。
 * **只读**：不修改传入条目、不写库、不刷新 accessedAt。
 */
export function auditMemory(input: AuditInput): AuditResult {
  const config = input.config ?? DEFAULT_AUDIT_CONFIG
  const query = input.query ?? {}
  const nowMs = input.now ?? Date.now()
  const entries = [...input.entries]

  const refs = referenceIndex(entries)
  const tagReuse = tagReuseIndex(entries)
  const dups = duplicateClusters(entries)

  const byBucket = emptyBuckets()
  const charsByBucket = emptyBuckets()
  const groupMap = new Map<string, { kind: string; level: string; count: number; chars: number; buckets: Record<AuditBucket, number> }>()
  const candidates: AuditCandidate[] = []
  let totalChars = 0
  let referenced = 0

  for (const entry of entries) {
    const breakdown = scoreEntry(entry, {
      weights: config.weights,
      refs,
      tagReuse,
      ...(input.usage !== undefined ? { usage: input.usage } : {}),
      dups,
      nowMs,
    })
    const { bucket, reasons } = classify(entry, breakdown, config)
    const chars = breakdown.evidence.chars
    totalChars += chars
    byBucket[bucket] += 1
    charsByBucket[bucket] += chars
    if (breakdown.evidence.refs > 0) referenced += 1

    const groupKey = `${entry.kind}/${entry.level ?? '-'}`
    let group = groupMap.get(groupKey)
    if (group === undefined) {
      group = { kind: entry.kind, level: entry.level ?? '-', count: 0, chars: 0, buckets: emptyBuckets() }
      groupMap.set(groupKey, group)
    }
    group.count += 1
    group.chars += chars
    group.buckets[bucket] += 1

    candidates.push({
      id: entry.id,
      kind: entry.kind,
      title: entry.title,
      scope: entry.scope,
      bucket,
      score: Math.round(breakdown.score * 1000) / 1000,
      reasons,
      evidence: breakdown.evidence,
    })
  }

  // 分组主导档位（按条数；并列取桶序 KEEP<DEMOTE<ARCHIVE<REVIEW 中较「需要动作」者）
  const bucketOrder: AuditBucket[] = ['REVIEW', 'ARCHIVE', 'DEMOTE', 'KEEP']
  const groups: AuditGroup[] = [...groupMap.entries()].map(([key, value]) => {
    let dominant: AuditBucket = 'KEEP'
    let best = -1
    for (const candidate of bucketOrder) {
      const n = value.buckets[candidate]
      if (n > best) {
        best = n
        dominant = candidate
      }
    }
    return {
      key,
      label: `${value.kind}${value.level === '-' ? '' : ` (${value.level})`}`,
      count: value.count,
      chars: value.chars,
      dominantBucket: dominant,
    }
  }).sort((a, b) => b.chars - a.chars)

  const minChars = query.minChars ?? 0
  const topN = query.topN ?? 30
  const ranked = candidates
    .filter((candidate) => candidate.evidence.chars >= minChars)
    .sort((a, b) => {
      // 先按「需要动作」的档位聚合，再按体量——提案要先看到最占地方的那批
      const rank: Record<AuditBucket, number> = { REVIEW: 0, ARCHIVE: 1, DEMOTE: 2, KEEP: 3 }
      if (rank[a.bucket] !== rank[b.bucket]) return rank[a.bucket] - rank[b.bucket]
      if (a.evidence.chars !== b.evidence.chars) return b.evidence.chars - a.evidence.chars
      return a.score - b.score
    })
    .slice(0, topN)

  const notes: string[] = [
    `读数：条目 ${entries.length} 条 / ${totalChars} 字符；被引用（承重）${referenced} 条；近重复簇 ${new Set([...dups.values()].map((d) => d.cluster)).size} 个。`,
    input.usage === undefined
      ? '用量信号：无逻辑轨迹 ⇒ usage 项恒 0（评分仍有效，只是少一项证据）。'
      : '用量信号：来自侧车轨迹。',
    '提案 ≠ 裁决：本工具只读，不归档不删除；动记忆数据请显式发起（属须请示类）。',
  ]

  return {
    summary: {
      total: entries.length,
      chars: totalChars,
      byBucket,
      charsByBucket,
      usageSource: input.usage === undefined ? 'none' : 'trace',
      referenced,
    },
    groups,
    candidates: ranked,
    notes,
  }
}
