/**
 * dedupe.ts — 写入前的近重复检测（纯逻辑，可离线单测）
 *
 * 动机（主人 2026-09-17 指令「存记忆的时候先搜索记忆」）：把「先搜再写」从**纪律**变成**机制**——
 * `remember` 命中高度相似的既有条目时当场提示，而不是默默造平行副本。
 *
 * 判据单一真源：复用 `search.ts::relatedOf` 的打分
 * （共享标签×3 + 标题 2-gram 重叠×2 + 正文 2-gram 重叠×1），不另立一套相似度。
 */
import type { Entry } from './types.ts'
import { relatedOf } from './search.ts'

export interface DuplicateCandidate {
  title: string
  body?: string
  tags?: string[]
  kind?: string
  scope?: string
}

export interface NearDuplicate {
  id: string
  title: string
  strength: number
  sharedTags: number
}

/** 阈值 6 = 2 个共享标签（2×3）或标题 2-gram 命中 ≥3（3×2）；低于此视为弱关联，不打扰。 */
export const NEAR_DUP_THRESHOLD = 6

/** 找出与新条目高度相似的既有条目（按强度降序，取前 limit 条）。 */
export function findNearDuplicates(
  entries: Entry[],
  candidate: DuplicateCandidate,
  limit = 5,
  threshold = NEAR_DUP_THRESHOLD,
): NearDuplicate[] {
  if (!candidate.title || candidate.title.trim() === '') return []
  // 探针条目：relatedOf 只用到 id/archived/tags/title/body，其余字段用占位值（类型上按 Entry 视图）
  const probe = {
    id: '__candidate__',
    kind: candidate.kind ?? 'knowledge',
    key: null,
    title: candidate.title,
    body: candidate.body ?? '',
    tags: candidate.tags ?? [],
    scope: candidate.scope ?? '',
    archived: false,
  } as unknown as Entry
  return relatedOf(entries, probe, limit)
    .filter((r) => r.strength >= threshold)
    .map((r) => ({ id: r.id, title: r.title, strength: r.strength, sharedTags: r.sharedTags }))
}

/** 提示文案（无近重复时返回空串——调用方据此省略字段，保持无损 JSON）。 */
export function formatDuplicateHint(dups: NearDuplicate[]): string {
  if (dups.length === 0) return ''
  const list = dups.map((d) => `${d.id}（${d.title}，强度 ${d.strength}）`).join(' · ')
  return `⚠ 命中 ${dups.length} 条高度相似的既有条目——**先考虑 update 补写或 memory_merge 合流，而不是新建平行条目**（§5.8 先搜再写）：${list}`
}

// ─────────────────────────────────────────────────────────────────────────────
// 处置闭环（2026-10-28 · lh-0f54524a）
//
// 动机：命中相似只提示、不处置，等于把「先搜再写」停在提示这一步。今晚实测两处失效——
//   ① 提示之后没有任何落点记住「我处置过这一对」，同一候选每次 remember 都重报；
//   ② 于是判断被重复消耗，而束之高阁的提示等于没提示。
//
// ⚠ 为什么键是 candidateId，不是 (newId, candidateId)：
//   每次 remember 都产生新的 newId，「同一对」在结构上根本不存在 ⇒ 按对记账永远算不出欠账。
//   候选条目才是稳定的那一侧：它撞过我几次、我最后一次处置它是什么时候，这两件事都可算。
//   这是 2026-10-28 读码后**先排除掉的那个看起来最自然的方案**。
// ─────────────────────────────────────────────────────────────────────────────

/** 命中相似后的三选一。缺 option 会让「无关」无处表达，人只能二选一地委屈一条。 */
export type SimilarDisposition = 'merged' | 'updated' | 'unrelated'

/**
 * 解析 `similarDisposition` 参数：缺省 ⇒ undefined（不处置）；非法值 ⇒ **fail-loud**。
 * 不在 schema 之后就收手：schema 校验可能被绕过（直接调 execute 的单测、旧客户端），
 * 而静默降级会把「我判了无关」变成「我什么也没判」——那正是本条要治的病。
 */
export function parseSimilarDisposition(raw: unknown): SimilarDisposition | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined
  if (raw === 'merged' || raw === 'updated' || raw === 'unrelated') return raw
  throw new Error(`similarDisposition 只接受 merged / updated / unrelated，收到 ${JSON.stringify(raw)}`)
}

/**
 * 侧车记录：命中（hit）与处置（disposed）**同一个文件按 kind 区分**。
 * 不用双文件 + 差集：那样要多读一次、且两个文件的写入顺序在多实例下无法保证。
 */
export interface DedupeTraceRecord {
  kind: 'hit' | 'disposed'
  atMs: number
  /** 撞上的既有条目 id —— **欠账的键** */
  candidateId: string
  /** 本次写入的条目 id（hit 必有；disposed 表示针对这组撞车做的处置） */
  newId?: string
  /** hit 时的相似强度（disposed 无意义） */
  strength?: number
  disposition?: SimilarDisposition
  reason?: string
  /**
   * 处置的证据指针（`path:line` / 记忆 id / 提交号）——**「凭什么说处置了」**。
   * 只对 `disposed` 有意义：hit 是自动记录的，本来就有条目 id 可指；
   * 而「我说我合流了」在侧车里只是一句话，refs 让未来的我自己能现读复算。
   */
  refs?: string[]
}

/** 未处置的撞车候选。 */
export interface UnresolvedCandidate {
  candidateId: string
  hitCount: number
  lastHitMs: number
  maxStrength: number
}

/**
 * 解析侧车 JSONL 文本 → 记录数组（纯函数，可离线测）。
 *
 * **坏行跳过**，不因一行损坏丢掉整份轨迹（与 `parseReviewMarks` 同纪律）。
 * 但调用方必须把「解析出空数组」与「文件读不到」分开——前者是「真的零记录」，
 * 后者只能说「不知道」。这个区分在 `memory_check` 的 note 里显形。
 */
export function parseDedupeTrace(text: string): DedupeTraceRecord[] {
  const out: DedupeTraceRecord[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const r = JSON.parse(trimmed) as Partial<DedupeTraceRecord>
      const kindOk = r.kind === 'hit' || r.kind === 'disposed'
      const baseOk = typeof r.atMs === 'number' && typeof r.candidateId === 'string' && r.candidateId.length > 0
      if (!kindOk || !baseOk) continue
      out.push(r as DedupeTraceRecord)
    } catch {
      // 坏行跳过：侧车是证据不是账本，一行损坏不该让整份轨迹不可用
    }
  }
  return out
}

/**
 * 算出「撞过我、但最后一次撞之后没被处置」的候选。
 *
 * **处置是一次时间轴上的重置**：处置时刻之后的 hit 才算新欠账——
 * 否则「判过无关但阈值仍把它报出来」这种情况会被永久掩盖，而那恰恰是最该看见的。
 *
 * 入参不改：先拷贝再排序。
 */
export function unresolvedCandidates(records: DedupeTraceRecord[]): UnresolvedCandidate[] {
  const acc = new Map<string, UnresolvedCandidate>()
  const sorted = [...records].sort((a, b) => a.atMs - b.atMs)
  for (const r of sorted) {
    if (r.kind === 'disposed') {
      acc.delete(r.candidateId)
      continue
    }
    if (r.kind !== 'hit') continue
    const prev = acc.get(r.candidateId)
    if (prev === undefined) {
      acc.set(r.candidateId, { candidateId: r.candidateId, hitCount: 1, lastHitMs: r.atMs, maxStrength: r.strength ?? 0 })
    } else {
      prev.hitCount += 1
      if (r.atMs > prev.lastHitMs) prev.lastHitMs = r.atMs
      if ((r.strength ?? 0) > prev.maxStrength) prev.maxStrength = r.strength ?? 0
    }
  }
  return [...acc.values()].sort((a, b) => b.lastHitMs - a.lastHitMs)
}
