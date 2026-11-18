/**
 * 证据维度（v0.25.0）：把「这条记忆能回到哪里」变成一个可核的字段，而不是散文里的「我记得」。
 *
 * 落盘形态是**编码字符串数组**（格式见 `types.ts::EvidenceKind` 注释）：
 * 本仓 schema DSL 不支持嵌套对象（required 会被提成对象级、泛型推断退化、维度常量对不上），
 * 所以编码/解析集中在本模块，条目里只存平级字符串。
 *
 * 本模块只做**编码、解析、呈现**，不做采集：采集在写入侧
 * （`tools.ts::evidenceStampOf` / `compaction-sink.ts`），坐标由会话火线提供（`index.ts`）。
 */

import type { EvidenceKind, EvidenceRef } from './types.ts'

/** 证据类型的中文短标（渲染用；数据侧仍是英文枚举，不混两种表示） */
const KIND_LABEL: Record<EvidenceKind, string> = {
  session: '会话',
  compaction: '压缩',
  derived: '派生',
}

/** 编码分隔符（选 `|`：会话 id / 压缩 id 都不会含它） */
const SEP = '|'

/**
 * 把证据引用编码成落盘字符串。
 * @param ref - 解析视图
 * @returns 形如 `session|<sid>|<seq>` / `compaction|<sid>|<cid>` / `derived|<locator>`
 */
export function formatEvidenceRef(ref: EvidenceRef): string {
  if (ref.kind === 'session') {
    return [ref.kind, ref.sessionId ?? '', ref.seq === undefined ? '' : String(ref.seq)].join(SEP)
  }
  if (ref.kind === 'compaction') {
    return [ref.kind, ref.sessionId ?? '', ref.compactionId ?? ''].join(SEP)
  }
  return [ref.kind, ref.locator ?? ''].join(SEP)
}

/**
 * 解析落盘字符串。认不出的（空串 / 未知 kind / 段数不足）返回 `undefined`——
 * **数据路径容错**（同其它维度的读取侧纪律）：坏坐标不能让检索崩。
 * @param raw - 落盘字符串
 * @returns 解析视图；不可解析为 undefined
 */
export function parseEvidenceRef(raw: string): EvidenceRef | undefined {
  if (typeof raw !== 'string') return undefined
  const parts = raw.split(SEP)
  const kind = parts[0]
  if (kind !== 'session' && kind !== 'compaction' && kind !== 'derived') return undefined
  if (kind === 'session') {
    const sessionId = parts[1] ?? ''
    if (sessionId === '') return undefined
    const seqText = parts[2] ?? ''
    const seq = seqText === '' ? undefined : Number(seqText)
    return { kind, sessionId, ...(seq !== undefined && Number.isFinite(seq) ? { seq } : {}) }
  }
  if (kind === 'compaction') {
    const sessionId = parts[1] ?? ''
    const compactionId = parts[2] ?? ''
    if (compactionId === '') return undefined
    return { kind, ...(sessionId !== '' ? { sessionId } : {}), compactionId }
  }
  const locator = parts.slice(1).join(SEP)
  return locator === '' ? undefined : { kind, locator }
}

/**
 * 解析工具入参里的证据坐标数组（v0.28.0：关系边首次需要**由调用方显式给坐标**）。
 *
 * 三条纪律：
 * 1. **fail-loud**：认不出的坐标整笔拒绝——读取侧容错（坏坐标不能让检索崩），
 *    但写入侧不能容错：坏坐标写进去就是「有一条查不回去的出处」，比没有更坏。
 * 2. 去重保序（同一坐标写两遍不是两条证据）。
 * 3. 上限 8 条（同 `store.ts::MAX_EVIDENCE_REFS`：证据是坐标不是日志）。
 * @param raw - 工具参数原值（字符串或字符串数组）
 * @param field - 报错里用的字段名
 * @returns 编码串数组；未给返回 `undefined`（= 不带坐标）
 */
export function parseEvidenceRefsArg(raw: unknown, field = 'evidenceRefs'): string[] | undefined {
  if (raw === undefined || raw === null) return undefined
  const list = Array.isArray(raw) ? raw : [raw]
  const out: string[] = []
  for (const item of list) {
    if (typeof item !== 'string') throw new Error(`${field}: 每一项都必须是字符串，收到 ${typeof item}`)
    const trimmed = item.trim()
    if (trimmed.length === 0) continue
    if (parseEvidenceRef(trimmed) === undefined) {
      throw new Error(
        `${field}: 无法解析的坐标 ${JSON.stringify(item)}——合法形态：`
        + '`session|<会话id>|<事件号>` / `compaction|<会话id>|<压缩id>` / `derived|<定位串>`',
      )
    }
    if (!out.includes(trimmed)) out.push(trimmed)
  }
  if (out.length > 8) {
    throw new Error(`${field}: 最多 8 条（收到 ${out.length} 条）——证据是坐标不是日志，超量说明在乱塞`)
  }
  return out.length > 0 ? out : undefined
}

/**
 *
 * 只印最有力的一条：`⚓<类型>@<事件号>`；没有事件号时只印 `⚓<类型>`。
 * 为什么不把全部引用印出来：回忆结果每行都在跟字数竞争（本插件的渲染行本就密），
 * 完整列表在结构化结果里（`evidenceRefs`），行内只需要一个「有出处、能回查」的信号。
 * @param refs - 条目的证据引用（编码串数组，可能为空/未定义）
 * @returns 标记串；无证据返回空串（渲染侧据此不打）
 */
export function evidenceTag(refs: readonly string[] | undefined): string {
  if (refs === undefined || refs.length === 0) return ''
  const parsed = refs.map(parseEvidenceRef).filter((ref): ref is EvidenceRef => ref !== undefined)
  if (parsed.length === 0) return ''
  // 优先带事件号的（可精确回查），其次压缩事务，最后会话级
  const strongest = parsed.find((ref) => ref.seq !== undefined)
    ?? parsed.find((ref) => ref.compactionId !== undefined)
    ?? parsed[0]
  if (strongest === undefined) return ''
  const label = KIND_LABEL[strongest.kind] ?? strongest.kind
  return strongest.seq !== undefined ? `⚓${label}@${strongest.seq}` : `⚓${label}`
}
