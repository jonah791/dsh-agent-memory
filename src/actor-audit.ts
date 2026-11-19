/**
 * 操作者审计流（v0.37 · 方案 §11.4「审计八类事件」）——记「谁、对什么、做了什么、成没成」。
 *
 * ## 为什么需要它（不是为方案凑数）
 *
 * `role.ts::admitsEntry` 是**布尔函数**：权限拒绝被压成一个 `false`，被拒的条目静默不出现在结果里。
 * 于是方案 §13.3 那一项「高风险权限违规 = 0」**没有判据**——不是因为没违规，而是因为**违规不可见**。
 * 审计流的第一个价值不是「记录谁干了什么」，而是**让拒绝从布尔值变成一个可读的事件**。
 *
 * ## 与既有侧车的分工（**不重复建**，这是本模块最重要的边界）
 *
 * | 侧车 | 记什么 | 本模块的关系 |
 * |---|---|---|
 * | `memory-access-trace.jsonl` | **读**路径：谁读了哪些条目 | 不记读——已存在且已有消费者（体检的 usage 信号） |
 * | `memory-forget-certificates.jsonl` | 遗忘**内容面**：什么被传播到哪些面、哪些面够不着 | 不重复面清单——只补「谁发起的、成没成」 |
 * | `memory-compress-trace.jsonl` / `memory-dedupe-trace.jsonl` | 加工动作的机制读数 | 不动 |
 * | **本模块** `memory-actor-audit.jsonl` | **变更面 + 授权面的操作者归因** | — |
 *
 * 于是方案八类事件落到我的载体上只有**五个动作类型**（不是八条平行流水）：
 * ① 谁写 → `write` · ④ 谁改 → `update` · ⑦ 删除 → `forget` · 知识组织变更 → `link`
 * ⑥ 权限使用 → `permission` · ⑧ 异常访问 → **不新造事件类型**，由 `findBursts` 在读取侧从既有记录算簇
 * ② 来源 / ③ 谁加工 / ⑤ 谁调用 → 已有载体（`sources` 表 / compress-trace / access-trace），不重复。
 *
 * ⚠ **按「消费者需要区分什么」定动作类型，不按方案的条目数定**——八条平行流水里会有一半没有读者。
 *
 * ## 纪律
 *
 * 1. **只追加 / 吞错 / 按体积轮转 / 可关**（同 §5.22 access-trace 五条）。
 * 2. **最小化**：`target` 只有 id / 计数 / scope；**不记正文、不记标题、不记查询全文**。
 *    拒绝理由只放**判据码**（`R1-kind` / `R4-read`），不放自由文本——用户给的理由属内容面，归凭证。
 * 3. **只记异常面**：权限**放行不记**（放行是默认）；拒绝 > 0 才写一条。否则每轮 recall 一条，
 *    审计流会变成没人读的洪水——那是这类记录最常见的死法。
 * 4. **判断型字段禁默认值**：`outcome` 必填，且 `rejected` 时 `code` **必填**（类型上强制），
 *    不存在「拒绝但说不出为什么」的记录。
 *
 * 纯函数层不依赖 Cordis / fs（`sanitizeActorAuditRecord` / `parseActorAudit` / `summarizeActorAudit` /
 * `filterActorAudit` / `findBursts`），离线可测（tests/actor-audit.test.mjs）；文件底部另有一个
 * 与 `access-trace.ts::readAccessIndex` 同构的读函数（吞错、不可读返回 undefined）。
 */

import { readFile } from 'node:fs/promises'

/** 动作类型（五个，见文件头「按消费者需要区分什么定」） */
export const ACTOR_AUDIT_ACTIONS = ['write', 'update', 'forget', 'link', 'permission'] as const

export type ActorAuditAction = (typeof ACTOR_AUDIT_ACTIONS)[number]

/** 结果三态（`partial` = 操作发生了但没全成，如 forget 有 skipped / supersede 部分目标不存在） */
export const ACTOR_AUDIT_OUTCOMES = ['ok', 'partial', 'rejected'] as const

export type ActorAuditOutcome = (typeof ACTOR_AUDIT_OUTCOMES)[number]

/**
 * 操作者身份三要素。
 *
 * 全字段可选，**键缺失 = 不知道**（不是「默认角色」）——与全库「判断型字段禁默认值」同一条纪律。
 * `delegationDepth` 是多代理场景下最重要的归因维度：同一 operator 的 0 层与 3 层，
 * 该被问责的对象不是同一个。
 */
export interface ActorIdentity {
  sessionId?: string
  /** 角色（`role.ts` 的视野维度；roles 未启用时通常缺省） */
  role?: string
  /** 委派深度（0 = 主会话；>0 = 子代理 / 队员） */
  delegationDepth?: number
}

/**
 * 动作目标——**只允许这五种**，全是标识或计数，没有内容。
 *
 * `ids` 会被截断（`MAX_AUDIT_IDS`），但 `count` **不截断**——数组截断只影响可读性，
 * 计数是汇总口径，失真会让「删了多少」变成假读数。
 */
export interface AuditTarget {
  /** 单目标 id（remember / update 的条目 id） */
  id?: string
  /** 多目标 id（forget / merge 的 id 列表；超上限截断） */
  ids?: string[]
  /** 真实目标数量（**不截断**） */
  count?: number
  /** 存储作用域（路径分区名，不是内容） */
  scope?: string
}

/** 单条审计记录：成功 / 部分成功 */
export interface ActorAuditRecordOk {
  atMs: number
  action: ActorAuditAction
  actor: ActorIdentity
  target: AuditTarget
  outcome: 'ok' | 'partial'
  /** 判据码（成功时可选，如 `partial` 带上「哪一项没成」） */
  code?: string
  /** 入口工具名（`remember` / `forget` / `recall` …）——把事件归到工具，便于按入口聚合 */
  tool?: string
}

/** 单条审计记录：被拒（**`code` 必填**——不存在「拒绝但说不出为什么」） */
export interface ActorAuditRecordRejected {
  atMs: number
  action: ActorAuditAction
  actor: ActorIdentity
  target: AuditTarget
  outcome: 'rejected'
  code: string
  tool?: string
}

export type ActorAuditRecord = ActorAuditRecordOk | ActorAuditRecordRejected

/** `ids` 单条最多记几个（防长列表把侧车撑爆；`count` 不受此限） */
export const MAX_AUDIT_IDS = 20

/** 字段白名单——`sanitizeActorAuditRecord` 只放行这些键 */
const RECORD_KEYS = ['atMs', 'action', 'actor', 'target', 'outcome', 'code', 'tool'] as const
const ACTOR_KEYS = ['sessionId', 'role', 'delegationDepth'] as const
const TARGET_KEYS = ['id', 'ids', 'count', 'scope'] as const

/**
 * 白名单裁剪（**最小化的执行点**）。
 *
 * 为什么需要它：埋点散在十几个工具里，任何一个把 `text` / `title` / `query` 顺手塞进 target
 * 都会让审计流变成第二个记忆库副本。白名单让「多塞字段」在写入前就消失——
 * 而不是靠每个调用点自觉（那是「希望我记得」）。
 *
 * @param record - 调用方给的记录（可能带多余键）
 * @returns 只含白名单字段的记录；`ids` 截断到 `MAX_AUDIT_IDS`；空字符串键剔除
 */
export function sanitizeActorAuditRecord(record: ActorAuditRecord): ActorAuditRecord {
  const pick = <T extends object>(src: T, keys: readonly string[]): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    for (const key of keys) {
      const value = (src as Record<string, unknown>)[key]
      if (value === undefined) continue
      if (typeof value === 'string' && value.length === 0) continue
      out[key] = value
    }
    return out
  }
  const actor = pick(record.actor ?? {}, ACTOR_KEYS) as ActorIdentity
  const rawTarget = pick(record.target ?? {}, TARGET_KEYS) as AuditTarget
  const target: AuditTarget = {
    ...rawTarget,
    ...(Array.isArray(rawTarget.ids) ? { ids: rawTarget.ids.slice(0, MAX_AUDIT_IDS) } : {}),
  }
  const base = {
    atMs: record.atMs,
    action: record.action,
    actor,
    target,
    outcome: record.outcome,
    ...(record.code !== undefined && record.code.length > 0 ? { code: record.code } : {}),
    ...(record.tool !== undefined && record.tool.length > 0 ? { tool: record.tool } : {}),
  }
  return base as ActorAuditRecord
}

/** 解析过滤条件（读侧） */
export interface ActorAuditQuery {
  action?: ActorAuditAction
  /** 会话 id（精确匹配） */
  sessionId?: string
  /** 只取 `atMs >= sinceMs` 的记录 */
  sinceMs?: number
  /** 最多返回几条（取**最近**的 N 条） */
  limit?: number
}

/** 类型守卫：动作名合法 */
function isAction(value: unknown): value is ActorAuditAction {
  return typeof value === 'string' && (ACTOR_AUDIT_ACTIONS as readonly string[]).includes(value)
}

/** 类型守卫：结果名合法 */
function isOutcome(value: unknown): value is ActorAuditOutcome {
  return typeof value === 'string' && (ACTOR_AUDIT_OUTCOMES as readonly string[]).includes(value)
}

/**
 * 解析侧车文本 → 记录列表（纯函数）。
 *
 * 坏行（非 JSON / 动作或结果不合法 / 缺 `atMs`）**跳过不抛**——审计流是旁证，
 * 永远不能成为故障源（同 access-trace 的解析纪律）。
 *
 * 返回顺序 = 文件顺序（追加序）；带 `limit` 时取**末尾** N 条（审计查询通常关心最近）。
 */
export function parseActorAudit(text: string, query: ActorAuditQuery = {}): ActorAuditRecord[] {
  const out: ActorAuditRecord[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let raw: unknown
    try {
      raw = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (typeof raw !== 'object' || raw === null) continue
    const r = raw as Record<string, unknown>
    const atMs = typeof r.atMs === 'number' && Number.isFinite(r.atMs) ? r.atMs : undefined
    if (atMs === undefined) continue
    if (!isAction(r.action)) continue
    if (!isOutcome(r.outcome)) continue
    // rejected 缺 code 的记录视为坏行：它正是本模块要禁止的形状，不许在读取侧被「宽容」放回来
    if (r.outcome === 'rejected' && !(typeof r.code === 'string' && r.code.length > 0)) continue
    if (query.action !== undefined && r.action !== query.action) continue
    const actor = (typeof r.actor === 'object' && r.actor !== null ? r.actor : {}) as ActorIdentity
    if (query.sessionId !== undefined && actor.sessionId !== query.sessionId) continue
    if (query.sinceMs !== undefined && atMs < query.sinceMs) continue
    const target = (typeof r.target === 'object' && r.target !== null ? r.target : {}) as AuditTarget
    out.push({
      atMs,
      action: r.action,
      actor,
      target,
      outcome: r.outcome,
      ...(typeof r.code === 'string' && r.code.length > 0 ? { code: r.code } : {}),
      ...(typeof r.tool === 'string' && r.tool.length > 0 ? { tool: r.tool } : {}),
    } as ActorAuditRecord)
  }
  if (query.limit !== undefined && query.limit > 0 && out.length > query.limit) {
    return out.slice(out.length - query.limit)
  }
  return out
}

/** 审计汇总（读侧口径） */
export interface ActorAuditSummary {
  /** 记录总数 */
  total: number
  /** 按动作分列（五类之和 == total） */
  byAction: Record<ActorAuditAction, number>
  /** 按结果分列（三态之和 == total） */
  byOutcome: Record<ActorAuditOutcome, number>
  /**
   * 拒绝判据分布——**这是「哪条策略在工作」的读数**。
   * 例：`{'R2-space': 12}` = 有 12 条因空间未标注被 fail-closed 挡下，
   * 它同时是「该给这些条目补标注」的行动信号（而不是让人猜策略为什么空）。
   */
  rejectedByCode: Record<string, number>
  /** 去重后的操作者会话数（无 sessionId 的记录不计入——不知道 ≠ 一个新操作者） */
  distinctActors: number
  /** 最近一条记录时刻（ms；无记录为 0） */
  lastAtMs: number
}

/** 汇总审计记录（纯函数）：五类动作与三态的分母都等于 total */
export function summarizeActorAuditRecords(records: ActorAuditRecord[]): ActorAuditSummary {
  const empty = (): Record<ActorAuditAction, number> => ({ write: 0, update: 0, forget: 0, link: 0, permission: 0 })
  const out: ActorAuditSummary = {
    total: 0,
    byAction: empty(),
    byOutcome: { ok: 0, partial: 0, rejected: 0 },
    rejectedByCode: {},
    distinctActors: 0,
    lastAtMs: 0,
  }
  const actors = new Set<string>()
  for (const record of records) {
    out.total += 1
    out.byAction[record.action] += 1
    out.byOutcome[record.outcome] += 1
    if (record.outcome === 'rejected') {
      const code = record.code
      if (typeof code === 'string' && code.length > 0) {
        out.rejectedByCode[code] = (out.rejectedByCode[code] ?? 0) + 1
      }
    }
    if (typeof record.actor.sessionId === 'string' && record.actor.sessionId.length > 0) {
      actors.add(record.actor.sessionId)
    }
    if (record.atMs > out.lastAtMs) out.lastAtMs = record.atMs
  }
  out.distinctActors = actors.size
  return out
}

/** 汇总侧车文本（`summarizeActorAuditRecords` 的文本形态） */
export function summarizeActorAudit(text: string): ActorAuditSummary {
  return summarizeActorAuditRecords(parseActorAudit(text))
}

/**
 * 动作簇（**信号，不是裁决**）。
 *
 * 方案 §11.4 的第八类「异常访问」不新造事件类型——它从既有记录的**密度**里算出来。
 * 判据留给调用方（判断型字段禁默认值）：本函数只给「同一会话、同一动作、在 windowMs 内
 * 发生了 ≥ minCount 次」这一事实，**不贴「异常」标签**、不告警、不阻断。
 */
export interface ActorBurst {
  sessionId: string
  action: ActorAuditAction
  count: number
  /** 簇内首末时刻（ms） */
  firstAtMs: number
  lastAtMs: number
}

/**
 * 找出同一操作者 / 同一动作的高密度簇（滑动窗口，纯函数）。
 *
 * 为什么按「会话 + 动作」而不是按「会话」：一次会话里正常写十条与被连删三条是不同的形状，
 * 合并统计会把两者混成一个数。动作维度是区分「干活」与「失控」的最小必要维度。
 *
 * @param records - 记录列表（顺序无关，内部排序）
 * @param opts.windowMs - 窗口宽度
 * @param opts.minCount - 触发计数（<2 视为无意义，直接返回空）
 * @returns 每个（会话, 动作）最多一个簇：取**最密集**的那个窗口
 */
export function findBursts(
  records: ActorAuditRecord[],
  opts: { windowMs: number; minCount: number },
): ActorBurst[] {
  const { windowMs, minCount } = opts
  if (windowMs <= 0 || minCount < 2) return []
  const groups = new Map<string, ActorAuditRecord[]>()
  for (const record of records) {
    const sessionId = record.actor.sessionId
    if (typeof sessionId !== 'string' || sessionId.length === 0) continue
    const key = `${sessionId}\u0000${record.action}`
    const bucket = groups.get(key)
    if (bucket === undefined) groups.set(key, [record])
    else bucket.push(record)
  }
  const out: ActorBurst[] = []
  for (const bucket of groups.values()) {
    if (bucket.length < minCount) continue
    bucket.sort((a, b) => a.atMs - b.atMs)
    let best: { start: number; end: number } | undefined
    for (let left = 0; left < bucket.length; left++) {
      let right = left
      while (right + 1 < bucket.length && bucket[right + 1]!.atMs - bucket[left]!.atMs <= windowMs) right += 1
      const count = right - left + 1
      if (count < minCount) continue
      if (best === undefined || count > best.end - best.start + 1) best = { start: left, end: right }
    }
    if (best === undefined) continue
    const first = bucket[best.start]!
    const last = bucket[best.end]!
    out.push({
      sessionId: first.actor.sessionId as string,
      action: first.action,
      count: best.end - best.start + 1,
      firstAtMs: first.atMs,
      lastAtMs: last.atMs,
    })
  }
  // 稳定序：按簇大小降序、再按最近时刻降序（读数先看最密集的）
  out.sort((a, b) => b.count - a.count || b.lastAtMs - a.lastAtMs)
  return out
}

/**
 * 操作者短 id（渲染用）——**不能直接截前 N 位**。
 *
 * 会话 id 的形态是 `session-<uuid>`：所有会话共享 `session-` 前缀，取前 8 位得到的是
 * 「session-」这个**零区分度的串**（2026-11-19 线上验证当场抓到：审计明细显示「会话 session-」，
 * 而「谁干的」正是这份流唯一的用途）。⇒ 先剥掉已知共通前缀，再截。
 *
 * @param id - 完整会话 id（`session-cc8272d8-…` 或任意 id）
 * @returns 可辨识的短串（`cc8272d8…`）；剥前缀后不足 12 字符则原样返回
 */
export function shortActorId(id: string): string {
  const stripped = id.startsWith('session-') ? id.slice('session-'.length) : id
  return stripped.length > 12 ? `${stripped.slice(0, 8)}…` : stripped
}

/** 动作 → 中文（render 层用；与 ACTOR_AUDIT_ACTIONS 一一对应，测试会守住完整性） */
export const ACTION_LABELS: Record<ActorAuditAction, string> = {
  write: '写入',
  update: '修改',
  forget: '遗忘',
  link: '关系变更',
  permission: '准入拒绝',
}

/** 结果 → 中文 */
export const OUTCOME_LABELS: Record<ActorAuditOutcome, string> = {
  ok: '成功',
  partial: '部分',
  rejected: '被拒',
}

/** 判据码 → 中文说明（读侧渲染用；未知码原样显示，不猜） */
export const CODE_LABELS: Record<string, string> = {
  'R1-kind': '种类不在白名单',
  'R2-space': '空间未标注或不在白名单（fail-closed）',
  'R3-shared': '共享记忆但 includeShared=false',
  'R4-read': '角色不在读白名单',
  'W1-space': '目标空间未标注或不在写空间白名单（fail-closed）',
  'W2-role': '目标角色不在写白名单（写入归属闸）',
}

/**
 * 在**已解析**的记录上过滤（`parseActorAudit` 的数组形态）。
 *
 * 为什么单独导出：读侧要一次解析、多次过滤（`memory_trail` 先按条件取一页，
 * 再在页内算簇与汇总）；让 IO 与解析各只跑一次。
 */
export function filterActorAudit(records: ActorAuditRecord[], query: ActorAuditQuery = {}): ActorAuditRecord[] {
  let out = records
  if (query.action !== undefined) out = out.filter((r) => r.action === query.action)
  if (query.sessionId !== undefined) out = out.filter((r) => r.actor.sessionId === query.sessionId)
  const sinceMs = query.sinceMs
  if (sinceMs !== undefined) out = out.filter((r) => r.atMs >= sinceMs)
  if (query.limit !== undefined && query.limit > 0 && out.length > query.limit) {
    return out.slice(out.length - query.limit)
  }
  return out
}

/**
 * 读取并解析审计侧车（**吞错**，与 `access-trace.ts::readAccessIndex` 同构）。
 *
 * **三态必须分开**（本模块全部围绕这条纪律）：
 * - **文件不存在（`ENOENT`）⇒ 空结构**：已经接线、只是**还没有任何事件**——若把它当 `undefined`，
 *   首次部署会永远报「未接线」，而「未接线」与「零事件」的混淆正是本节要修的那种假读数。
 * - **其它读失败（权限 / IO）⇒ `undefined`**：真的读不到。
 * - 读到内容 ⇒ 正常解析。
 */
export async function readActorAudit(
  filePath: string,
): Promise<{ records: ActorAuditRecord[]; summary: ActorAuditSummary } | undefined> {
  try {
    const text = await readFile(filePath, 'utf8')
    return { records: parseActorAudit(text), summary: summarizeActorAudit(text) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      return { records: [], summary: summarizeActorAuditRecords([]) }
    }
    return undefined
  }
}
