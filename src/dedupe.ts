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
