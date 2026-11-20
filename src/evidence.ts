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

/** 会话 id 前缀（剥掉后才是可读短号，见 `sessionShortId`） */
const SESSION_PREFIX = 'session-'

/** 短号长度（会话 / 压缩块 id 共用） */
const SHORT_ID_LEN = 8

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
 * 会话 id 的可读短号（v0.58 · 方案 §12.1「给出具体出处」）。
 *
 * **必须剥 `session-` 前缀**：本机会话 id 形如 `session-cc8272d8-5195-4a34-a683-455cf5f12671`（44 字符），
 * 直接取前 8 位得到的是 `session-` —— **零区分度**（v0.37 审计在「操作者短 id」上踩过同一个坑：
 * 全部打印成同一串，读出来等于没读）。所以这里不复用 `succession.ts::shortId`。
 * @param sessionId - 会话 id（可缺省）
 * @returns 短号；缺省/空返回空串（渲染侧据此不打）
 */
export function sessionShortId(sessionId: string | undefined): string {
  if (typeof sessionId !== 'string') return ''
  const text = sessionId.trim()
  if (text.length === 0) return ''
  const bare = text.startsWith(SESSION_PREFIX) ? text.slice(SESSION_PREFIX.length) : text
  return bare.length <= SHORT_ID_LEN ? bare : bare.slice(0, SHORT_ID_LEN)
}

/**
 * 截断成**代表值**（超长加 `…`）：给 locator 这种人写的串用，读者要知道「这里被截了」。
 * ⚠ 短号（会话 / 压缩块 id）**不用它**——短号本身就是「截断后的代表」，再挂 `…` 是纯噪音，
 * 而且会让「有省略号 = 可能截到了别的东西」这个信号失去意义。
 */
function shortToken(raw: string | undefined, len: number): string {
  if (typeof raw !== 'string') return ''
  return raw.length <= len ? raw : `${raw.slice(0, len)}…`
}

/** 纯截断（不加省略号）：给 `短号` 用 */
function bareShort(raw: string | undefined, len: number): string {
  if (typeof raw !== 'string') return ''
  return raw.length <= len ? raw : raw.slice(0, len)
}

/**
 * 证据标记——**给出一条可回查的具体出处**（v0.25.0 建标记，**v0.58 补齐出处**）。
 *
 * 形状（`—` = 该段省略）：
 *
 * | 坐标 | 同会话 | 异会话 |
 * |---|---|---|
 * | `session|<sid>|<seq>` | `⚓@33847` | `⚓cc8272d8@33847` |
 * | `session|<sid>|` | `⚓会话` | `⚓cc8272d8` |
 * | `compaction|<sid>|<cid>` | `⚓压缩@1bdf3407` | `⚓cc8272d8/压缩@1bdf3407` |
 * | `derived|<locator>` | `⚓派生:<locator>` | 同左 |
 *
 * **为什么同会话就省 id**（v0.58 的关键裁决）：行内每字都在竞争，而同会话时回查动作
 * `session_event_read({seq})` **本来就不需要 id**（缺省读当前会话）——多印 8 个字符是纯噪音。
 * 反过来，**异会话时不印 id 会把回查引到错的位置且不报错**（可能读到另一个会话的第 33847 条，
 * 静默错）⇒ 那比不打出标记更坏。所以省 id **不是优化，是有条件的正确性**：
 * 不知道当前会话（`opts` 未给）时**一律印短号**，宁可行长一点，不可静默读错。
 *
 * ⚠ **边界（写在判据里，不假装没有）**：短号取 8 位，同批内两个会话前 8 位相同时短号也相同。
 * 本机实测只有 **1 个会话**、零碰撞对象 ⇒ **无法证明「不会碰撞」**（零命中带范围）。
 * 回退路径是结构化字段 `evidenceRefs` 里**始终**保留完整坐标——行内短号是入口，不是真源。
 * @param refs - 条目的证据引用（编码串数组，可能为空/未定义）
 * @param opts - `currentSessionId`：读这条时的会话 id（决定「省不省 id」）
 * @returns 标记串；无证据返回空串（渲染侧据此不打）
 */
export function evidenceTag(
  refs: readonly string[] | undefined,
  opts: { currentSessionId?: string | undefined } = {},
): string {
  if (refs === undefined || refs.length === 0) return ''
  const parsed = refs.map(parseEvidenceRef).filter((ref): ref is EvidenceRef => ref !== undefined)
  if (parsed.length === 0) return ''
  // 优先带事件号的（可精确回查），其次压缩事务，最后会话级
  const strongest = parsed.find((ref) => ref.seq !== undefined)
    ?? parsed.find((ref) => ref.compactionId !== undefined)
    ?? parsed[0]
  if (strongest === undefined) return ''
  // 「同会话」只在**知道**当前会话且两边都有 id 时成立（不知道就不省——见头注）
  const current = opts.currentSessionId
  const sameSession = current !== undefined
    && strongest.sessionId !== undefined
    && strongest.sessionId === current
  const sidNote = sameSession ? '' : sessionShortId(strongest.sessionId)
  let head: string
  if (strongest.seq !== undefined) {
    head = `${sidNote}@${strongest.seq}`
  } else if (strongest.compactionId !== undefined) {
    head = `${sidNote.length > 0 ? `${sidNote}/压缩` : '压缩'}@${bareShort(strongest.compactionId, SHORT_ID_LEN)}`
  } else if (strongest.kind === 'derived') {
    head = `派生:${shortToken(strongest.locator, 28)}`
  } else {
    head = sidNote.length > 0 ? sidNote : '会话'
  }
  // 其余条数：只报数，不塞内容（行内不做证据清单；全量在结构化 `evidenceRefs`）
  const more = parsed.length > 1 ? ` (+${parsed.length - 1})` : ''
  return `⚓${head}${more}`
}
