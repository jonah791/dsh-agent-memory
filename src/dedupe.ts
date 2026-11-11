/**
 * dedupe.ts — 写入前的近重复检测（纯逻辑，可离线单测）
 *
 * 动机（主人 2026-09-17 指令「存记忆的时候先搜索记忆」）：把「先搜再写」从**纪律**变成**机制**——
 * `remember` 命中相关度 ≥ 阈值的既有条目时当场提示，而不是默默造平行副本。
 * ⚠ 措辞是「相关」不是「高度相似」（2026-11-12 · lh-708ed26c）：阈值 6 只代表「值得看一眼」，
 *   实测 5 条候选强度 19–21 而内容全无关 ⇒ 把它读成「高度相似」会带偏判断。
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
  /**
   * 候选条目的**小节大纲**（`##` / `###` 标题，至多 6 条；无小节时退回正文首句）。
   *
   * 存在理由（2026-11-11 · lh-23124786）：回执原本只给「id — 标题（强度 N）」。
   * 标题是**条目名**不是**内容清单**，于是「这条到底覆盖了什么」读不出来。实测代价：
   * 母条目 `42c01e24`（标题「四道卡口与工程锁陷阱」）的第八、九节写的就是相机换算链，
   * 而我只看见标题 ⇒ 判断成「不同主题」⇒ 写了一条子集平行条目，事后才发现要归档。
   * 大纲让「覆盖范围」在**不必额外调用**的情况下可见——这是把「先搜再写」从
   * 「记得去读正文」变成「回执里就有」。
   */
  outline?: string[]
}

/** 阈值 6 = 2 个共享标签（2×3）或标题 2-gram 命中 ≥3（3×2）；低于此视为弱关联，不打扰。 */
export const NEAR_DUP_THRESHOLD = 6

/**
 * 提取条目大纲：优先 `##` / `###` 小节标题，无小节时退回「正文首个非标题行」前 80 字。
 *
 * 只认二级及以下：一级 `# ` 是标题的重复（`remember` 写入时首行自动作标题），
 * 把它算进大纲会让每条候选都多一行噪声。
 * 返回空数组 = 这条候选没有可说的内容（body 为空或只有标题），此时调用方不该印「节：」。
 *
 * 超过 `max` 时**保留尾部**，不是截掉尾部。理由见下方截断分支的注释。
 */
export function extractOutline(body: string, max = 6): string[] {
  if (typeof body !== 'string' || body.trim() === '') return []
  const lines = body.split('\n').map((l) => l.trim())
  const heads: string[] = []
  for (const line of lines) {
    const m = /^#{2,3}\s+(.+)$/.exec(line)
    if (m === null) continue
    const text = (m[1] ?? '').replace(/[`*]/g, '').trim()
    if (text.length === 0) continue
    heads.push(text.length > 40 ? `${text.slice(0, 40)}…` : text)
  }
  if (heads.length === 0) {
    const firstBody = lines.find((l) => l.length > 0 && !l.startsWith('#'))
    if (firstBody === undefined) return []
    const text = firstBody.replace(/[`*]/g, '').trim()
    return text.length === 0 ? [] : [text.length > 80 ? `${text.slice(0, 80)}…` : text]
  }
  if (heads.length <= max) return heads
  // ⚠ 截断必须**保留尾部**，不能只取前 max 条。小节的末尾常是后来追加的内容，
  // 而那恰恰最容易与新条目重叠——实测母条目 42c01e24 有 9 节，相机换算链在第八、九节；
  // 只取前 6 节的话，我在写相机条目时**正好看不见它**，而这整条机制就是为了救那次失误
  // （2026-11-11 上线后首次实调就复现了这个形状：回执只列到「六、实测性能」）。
  // 输出「前 N + 占位 + 最后 2」，占位写明总节数，避免被读成「只有这些」。
  if (max < 3) return heads.slice(0, max)
  const tailCount = Math.min(2, Math.max(1, max - 2))
  const headCount = Math.max(1, max - 1 - tailCount)
  return [...heads.slice(0, headCount), `…（共 ${heads.length} 节）`, ...heads.slice(-tailCount)]
}

/** 单条候选的一行回执：基础信息 + （有内容时）大纲缩进换行。 */
export function formatCandidate(d: NearDuplicate): string {
  const base = `${d.id} — ${d.title}（强度 ${d.strength}）`
  return d.outline !== undefined && d.outline.length > 0 ? `${base}\n     节：${d.outline.join(' / ')}` : base
}

/** 找出与新条目**相关**（强度 ≥ threshold）的既有条目（按强度降序，取前 limit 条）。 */
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
  // 大纲要从候选条目的 body 取，而 relatedOf 的回执不带 body ⇒ 先建 id → body 索引
  const bodyById = new Map(entries.map((e) => [e.id, e.body ?? '']))
  return relatedOf(entries, probe, limit)
    .filter((r) => r.strength >= threshold)
    .map((r) => ({
      id: r.id,
      title: r.title,
      strength: r.strength,
      sharedTags: r.sharedTags,
      outline: extractOutline(bodyById.get(r.id) ?? ''),
    }))
}

/**
 * 提示文案（无近重复时返回空串——调用方据此省略字段，保持无损 JSON）。
 *
 * ⚠ **措辞在 2026-11-12 降级过**（台账 lh-708ed26c）：原文写「命中 N 条**高度相似**的既有条目」。
 * 实测反例：一次 remember 回了 5 条候选，强度只有 19–21（阈值 6），**逐条看全是无关**——
 * 阈值 6 的语义是「值得看一眼」，不是「高度相似」。把它读成后者的代价是判断被措辞带偏：
 * 明明是弱关联，我却按「已有同主题条目」去合并/补写，等于用一条错前提去改记忆库。
 * ⇒ 文案改成**「相关，请判是否重复」**（判断权交回读者），并**把强度读数印在抬头**：
 * 强度是这条提示唯一可核的量，读者要能一眼看出「这批候选到底有多像」。
 *
 * **不动的东西**（主人 2026-09-17 建的机制）：阈值 `NEAR_DUP_THRESHOLD = 6`、
 * 判据 `relatedOf`、命中后的归档/处置闭环——本次只改文案，不改判据。
 * @param dups - `findNearDuplicates` 的结果（空数组 ⇒ 空串）
 * @returns 多行提示；调用方原样塞进 `hint` 字段
 */
export function formatDuplicateHint(dups: NearDuplicate[]): string {
  if (dups.length === 0) return ''
  const strengths = dups.map((d) => d.strength)
  const spread = `${Math.min(...strengths)}–${Math.max(...strengths)}`
  const list = dups.map(formatCandidate).join('\n')
  return `⚠ 命中 ${dups.length} 条相关条目（强度 ${spread}，阈值 ≥${NEAR_DUP_THRESHOLD}）`
    + `——**请逐条判断是否与本次写入重复**：重复就 update 补写或 memory_merge 合流；`
    + `判为无关就标 similarDisposition=unrelated（不要新建平行条目，§5.8 先搜再写）：\n${list}`
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
