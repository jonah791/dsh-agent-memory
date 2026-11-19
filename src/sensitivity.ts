/**
 * 敏感分级与隐私检查（v0.47 · 方案 §11.2 + §7 第 04 步）· 契约见 `docs/semantic.md` §5.38。
 *
 * 三层可判的事，别的不做：
 * 1. **形态硬闸**——五类极窄凭据形态（活库 1,796 条实测命中 0），防「我没意识到自己在写凭据」。
 *    刻意极窄：宽形态（`sk-` ≥16 / `password=` / 关键词语义）在本语料假阳率 100%，
 *    实测见 `docs/design/aml-sensitivity.md` §2。
 * 2. **等级字段**——`L0`–`L3` 四档，无默认值。决定「能不能出现在默认路径上」。
 * 3. **派生**——只往严的方向推（私钥块 ⇒ L3），不从 `memType` / `subject` / 标签 / 来源推。
 *
 * 不返回命中内容：回执只带类别与长度，否则检查本身会把凭据复制进日志与返回。
 */

import type { SensitivityLevel } from './types.ts'

export type { SensitivityLevel } from './types.ts'

/** 四档（方案 §11.2 原文的 L0–L3，不拆更细）——类型本体住 `types.ts`，此处只给运行时枚举。 */
export const SENSITIVITY_LEVELS: readonly SensitivityLevel[] = ['L0', 'L1', 'L2', 'L3']

/** 读数的证据来源：显式标注 / 派生 / 未标注（不猜）。 */
export type SensitivitySource = 'explicit' | 'derived' | 'unlabeled'

export interface SensitivityReadout {
  /** 未标注时为 `undefined`（≠ `L0`：`L0` 是我判断过「这是公开信息」）。 */
  readonly level: SensitivityLevel | undefined
  readonly source: SensitivitySource
  /** 派生依据（只有 `derived` 时存在），形如 `private-key-block`。 */
  readonly basis?: string
}

/** 硬闸命中描述——**刻意不含命中内容**。 */
export interface CredentialHit {
  readonly kind: string
  readonly length: number
}

interface CredentialPattern {
  readonly kind: string
  readonly pattern: RegExp
}

/**
 * 五类极窄形态。挑选判据是**「正常技术笔记里不会出现」**，不是「像凭据」：
 * - 宽 `sk-`：本地网关自设 key（19–25 字符）也命中 ⇒ 不收；
 * - 40 位十六进制：git 提交号命中 ⇒ 不收；
 * - `SHA256:` 指纹：SSH 主机公钥指纹是公开标识 ⇒ 不收。
 */
const CREDENTIAL_PATTERNS: readonly CredentialPattern[] = [
  { kind: 'private-key-block', pattern: /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/ },
  { kind: 'github-token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/ },
  { kind: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: 'anthropic-key', pattern: /\bsk-ant-api\d{2}-[A-Za-z0-9_-]{90,}\b/ },
  { kind: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
]

/** 私钥块是唯一用于**派生**形态（其余四类只在写入闸拦，不改等级读数）。 */
const DERIVABLE_KINDS: readonly string[] = ['private-key-block']

/**
 * 检测极窄凭据形态。
 * @param text - 待检文本（title + body）
 * @returns 命中列表；空数组表示「没有命中」——**不等于「没有凭据」**（只有走这个函数的路径被检查）
 */
export function detectCredential(text: string): readonly CredentialHit[] {
  if (text === '') return []
  const hits: CredentialHit[] = []
  for (const { kind, pattern } of CREDENTIAL_PATTERNS) {
    const match = pattern.exec(text)
    if (match !== null) hits.push({ kind, length: match[0].length })
  }
  return hits
}

/**
 * 解析显式等级。大小写归一后接受四值；非法值返回 `undefined`（**不猜**——调用方按「未标注」处理）。
 * 非法值的**拒绝**发生在 schema 层（写入边界），不在本函数：本函数只负责读。
 */
export function parseSensitivity(raw: unknown): SensitivityLevel | undefined {
  if (typeof raw !== 'string') return undefined
  const value = raw.trim().toUpperCase()
  return (SENSITIVITY_LEVELS as readonly string[]).includes(value) ? (value as SensitivityLevel) : undefined
}

/**
 * 读数：显式 > 派生（私钥块 ⇒ `L3`）> 未标注。
 * 派生**只往严的方向推**——与 `retention.ts` 的后置修正层同一模式。
 */
export function deriveSensitivity(entry: {
  readonly title?: string
  readonly body?: string
  readonly sensitivity?: string
}): SensitivityReadout {
  const explicit = parseSensitivity(entry.sensitivity)
  if (explicit !== undefined) return { level: explicit, source: 'explicit' }
  const hits = detectCredential(`${entry.title ?? ''}\n${entry.body ?? ''}`).filter((hit) =>
    DERIVABLE_KINDS.includes(hit.kind),
  )
  if (hits.length > 0) {
    return { level: 'L3', source: 'derived', basis: hits.map((hit) => hit.kind).join(',') }
  }
  return { level: undefined, source: 'unlabeled' }
}

/**
 * 自动注入面：`L2`/`L3` 永不出现（该路径不经调用方判断）；未标注出现（= 今天的行为，见 §5.38 的取舍）。
 */
export function isAutoInjectable(readout: SensitivityReadout): boolean {
  return readout.level !== 'L2' && readout.level !== 'L3'
}

/** 默认检索面（`recall`/`browse` 不带 `includeSensitive`）与自动注入同口径。 */
export function isDefaultVisible(readout: SensitivityReadout): boolean {
  return isAutoInjectable(readout)
}

/** 写入闸：只有 `L3` 需要显式确认（`allowSensitive: true`）。 */
export function requiresExplicitConsent(readout: SensitivityReadout): boolean {
  return readout.level === 'L3'
}

/** 严格度序：`L0` < `L1` < `L2` < `L3`。 */
const STRICTNESS: Readonly<Record<SensitivityLevel, number>> = { L0: 0, L1: 1, L2: 2, L3: 3 }

/**
 * 两档并存时取**更严**的那一档（只往严的方向推，与 `retention.ts` 的后置修正层同一模式）。
 *
 * 用途：我不能同时说「这条是 L0」和「正文里有私钥块」——冲突时机制取严，
 * 因为**低估敏感性**的代价（凭据进库、隐私被喂出）远高于高估的代价（少注入一条）。
 */
export function stricterSensitivity(
  a: SensitivityLevel | undefined,
  b: SensitivityLevel | undefined,
): SensitivityLevel | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return STRICTNESS[a] >= STRICTNESS[b] ? a : b
}

/**
 * 默认检索面的敏感度过滤（v0.47 · `recall` / `memory_browse` 共用）。
 *
 * `includeSensitive: true` ⇒ 原样返回（零拷贝）；否则只留 `isDefaultVisible` 的条目——
 * **未标注照旧通过**（不猜成 `L2`，理由见 `docs/semantic.md` §5.38 的「未标注按今天的行为处理」）。
 */
export function filterBySensitivity<T extends { readonly title?: string; readonly body?: string; readonly sensitivity?: string }>(
  entries: readonly T[],
  includeSensitive: boolean,
): T[] {
  if (includeSensitive) return [...entries]
  return entries.filter((entry) => isDefaultVisible(deriveSensitivity(entry)))
}

export interface SensitivityDistribution {
  readonly total: number
  readonly byLevel: Readonly<Record<SensitivityLevel, number>>
  /** 未标注——**不是 `L0`**，单独计数。四档 + 本项恒等于 `total`。 */
  readonly unlabeled: number
}

/** 四档 + 未标注的分布；和恒等于分母（判据 S9）。 */
export function countBySensitivity(
  entries: Iterable<{ readonly title?: string; readonly body?: string; readonly sensitivity?: string }>,
): SensitivityDistribution {
  const byLevel: Record<SensitivityLevel, number> = { L0: 0, L1: 0, L2: 0, L3: 0 }
  let unlabeled = 0
  let total = 0
  for (const entry of entries) {
    total += 1
    const readout = deriveSensitivity(entry)
    if (readout.level === undefined) unlabeled += 1
    else byLevel[readout.level] += 1
  }
  return { total, byLevel, unlabeled }
}
