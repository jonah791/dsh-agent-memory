/**
 * 角色维度（v0.5.0「多智能体工作台模式」）——记忆的**归属**与**准入**。
 *
 * 动机（借鉴 MAGE，arXiv:2608.29678 §4.2 role policy index + §4.4 Γ 准入门槛）：
 *   工作台里同时存在主脑（人类会话）、派生队员（子代理 / Agent Teams 成员）、
 *   验收方、幽灵隔间。它们共享同一张记忆表，但**不该共享同一片视野**：
 *   - 队员只需要自己隔间 + 公共记忆，不需要别人的过程流；
 *   - 验收方（verifier）必须拿不到实施方的过程轨迹（AGENTS.md §5.26 G8
 *     「验收不自己验自己」——从纪律升格为**检索层机制**）；
 *   - 幽灵隔间互不可见（§5.26 G1 无关联的机制化）。
 *
 * 两条正交语义：
 *   1. **归属**（write）：条目落库时盖章 `role`（仅当角色维度启用或调用方显式指定；
 *      缺省不盖章 ⇒ 条目是**共享记忆**）。
 *   2. **准入**（read）：按调用者角色的策略过滤可见条目，**在检索之前剔除**
 *      （不是排序降权）——这是与 MAGE Γ 门槛同形的「准入」而非「排序」。
 *
 * 四条准入判据（fail-closed，按序）：
 *   R1 种类过滤：`policy.kinds` 非空且条目 kind 不在其中 → 拒绝
 *   R2 公共记忆：条目无 `role` ⇒ 共享，`policy.includeShared !== false` 时放行
 *   R3 自己：条目 `role` === 调用者角色 → 放行
 *   R4 白名单：`policy.read` 含 `'*'` 或含条目的 role → 放行；否则拒绝
 *
 * **信任边界（诚实声明）**：角色维度是**视野管理**，不是安全边界。工具参数
 * `role` 可自述、记忆文件可被能读盘的人改写——它防的是「不小心看见」与
 * 「默认继承上下文」，不防「蓄意越权」。要真正的隔离请用独立 DSH_HOME。
 *
 * 纯函数层：不依赖 Cordis / fs，离线可测（tests/role.test.mjs）。
 * 另：所有入口都对「未带 roles 段的配置对象」容错（走 DEFAULT_ROLES_CONFIG）——
 * 历史配置字面量与外部调用方不得因新增字段而崩溃。
 */

import type { Entry, MemoryConfig, ReadableByRole, RolePolicy, RolesConfig, Space } from './types.ts'

/** 人类（主脑）会话的缺省角色 */
export const DEFAULT_ROLE = 'main'

/** 派生会话（子代理 / 队员）的缺省角色 */
export const DERIVED_ROLE = 'derived'

/** 缺省角色配置：**总开关关闭** + 默认策略不设限（启用时若未配置策略，行为与今日一致） */
export const DEFAULT_ROLES_CONFIG: RolesConfig = deepFreeze({
  enabled: false,
  default: DEFAULT_ROLE,
  derived: DERIVED_ROLE,
  byPreset: {},
  policyDefault: { read: ['*'], includeShared: true, includeGlobal: true },
  policies: {},
})

/** 深度冻结（同 config.ts 手法；此处独立实现以免与配置模块循环依赖） */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
    Object.freeze(value)
  }
  return value
}

/** 取 roles 段（容错：历史配置对象无该字段时走缺省） */
export function rolesOf(config: Pick<MemoryConfig, 'roles'> | undefined | null): RolesConfig {
  const roles = (config as { roles?: RolesConfig } | undefined | null)?.roles
  return roles ?? DEFAULT_ROLES_CONFIG
}

/**
 * 人类会话判据：DSH 人类会话形如 `session-<uuid>`；子代理/队员是裸 uuid。
 * 与 `self-plugins/dsh-life-core/src/target.ts:isUserSession` 同源（判据唯一真源，勿各拼各的）。
 */
export function isUserSessionId(sessionId: string): boolean {
  return /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)
}

/** 会话头（鸭子类型，对齐 @deepseek-ai/dsh-session SessionHeader 的可判定子集） */
export interface SessionHeaderLike {
  id?: string
  cwd?: string
  delegationDepth?: number
  agentPreset?: string
  origin?: string
  isSeeded?: boolean
  parentSession?: string
}

/** 最小会话载体（与 scope.ts 的 SessionCwdCarrier 同构，多取 id/header 字段） */
export interface RoleCarrier {
  agent?: { session?: { id?: string; header?: SessionHeaderLike } } | null
}

/** 从工具执行上下文提取会话头（缺省 undefined = 无身份信息） */
export function sessionHeaderOf(carrier: RoleCarrier | null | undefined): SessionHeaderLike | undefined {
  return carrier?.agent?.session?.header
}

/** 从工具执行上下文提取会话 id（优先 header.id，回退 session.id） */
export function sessionIdOf(carrier: RoleCarrier | null | undefined): string | undefined {
  const session = carrier?.agent?.session
  return session?.header?.id ?? session?.id
}

/** 角色推导结果（含判据理由，便于留痕与验收） */
export interface DerivedRole {
  role: string
  /** 判据理由（写进诊断/证据行） */
  reason: string
  sessionId?: string
  delegationDepth?: number
  preset?: string
}

/**
 * 推导调用者的有效角色（纯函数）。
 * 优先级：显式 override > `roles.by_preset[agentPreset]` > 人类会话缺省 > 派生会话缺省。
 * 无法判定会话身份（无 id）→ 人类缺省角色（保守：宁可见全，不可静默失明）。
 * @param header - 会话头（可为 undefined）
 * @param config - 记忆配置（读 roles 段；缺段走 DEFAULT_ROLES_CONFIG）
 * @param override - 工具参数显式指定
 */
export function deriveRole(
  header: SessionHeaderLike | undefined,
  config: Pick<MemoryConfig, 'roles'> | undefined | null,
  override?: string,
): DerivedRole {
  const roles = rolesOf(config)
  const sessionId = header?.id
  const depth = header?.delegationDepth
  const preset = header?.agentPreset
  const base = { sessionId, delegationDepth: depth, preset }

  const explicit = override?.trim()
  if (explicit !== undefined && explicit.length > 0) {
    return { role: explicit, reason: '显式指定 role', ...base }
  }
  if (preset !== undefined && preset.length > 0) {
    const mapped = roles.byPreset[preset]
    if (mapped !== undefined && mapped.length > 0) {
      return { role: mapped, reason: `预设映射 agentPreset=${preset}`, ...base }
    }
  }
  if (sessionId === undefined || sessionId.length === 0) {
    return { role: roles.default, reason: '无法判定会话身份（无 id）→ 人类缺省角色', ...base }
  }
  if (isUserSessionId(sessionId)) {
    return { role: roles.default, reason: '人类会话（session-<uuid>）', ...base }
  }
  return {
    role: roles.derived,
    reason: `派生会话（delegationDepth=${depth ?? '未标注'}）`,
    ...base,
  }
}

/** 取角色的准入策略（未配置的角色走 policyDefault；roles 段缺失走缺省策略） */
export function rolePolicyOf(
  config: Pick<MemoryConfig, 'roles'> | undefined | null,
  role: string,
): RolePolicy {
  const roles = rolesOf(config)
  const declared = roles.policies[role]
  return declared ?? roles.policyDefault
}

/**
 * 调用者视野（一次调用解析一次，供各读路径共用）。
 * `enabled=false` 时 `applyRoleView` 原样放行——**向后兼容是硬约束**：
 * 未启用角色维度时行为必须与 v0.4 完全一致。
 */
export interface RoleView {
  role: string
  reason: string
  enabled: boolean
  policy: RolePolicy
  /** 是否附加 global 作用域（`policy.includeGlobal === false` 时不附加） */
  includeGlobal: boolean
}

/** 组装调用者视野（配置 + 会话头 → 角色 + 策略） */
export function roleViewOf(
  config: Pick<MemoryConfig, 'roles'> | undefined | null,
  carrier: RoleCarrier | null | undefined,
  override?: string,
): RoleView {
  const derived = deriveRole(sessionHeaderOf(carrier), config, override)
  const policy = rolePolicyOf(config, derived.role)
  return {
    role: derived.role,
    reason: derived.reason,
    enabled: rolesOf(config).enabled,
    policy,
    includeGlobal: policy.includeGlobal !== false,
  }
}

/**
 * 单条准入判定（R1–R4，见文件头）——返回**拒因码**，`undefined` 表示放行。
 *
 * 为什么不是单纯的布尔（v0.37 · 方案 §11.4）：布尔把「为什么拒」压成 `false`，
 * 于是被拒的条目静默消失，「权限违规 0」变成**不可测的断言**（§13.3 该项无判据）。
 * 判据码让拒绝变成一条可读的事件，也让「哪条策略在工作」有读数。
 *
 * 判据码（与 `actor-audit.ts::CODE_LABELS` 一一对应）：
 * - `R1-kind` 种类不在白名单
 * - `R2-space` 空间未标注或不在白名单（fail-closed）
 * - `R3-shared` 共享记忆但 `includeShared=false`
 * - `R4-read` 条目角色不在读白名单
 */
export function rejectReason(
  policy: RolePolicy,
  callerRole: string,
  entry: Pick<Entry, 'kind' | 'role' | 'space'>,
): string | undefined {
  const kinds = policy.kinds
  if (kinds !== undefined && kinds.length > 0 && !kinds.includes(entry.kind)) return 'R1-kind'
  // 空间授权（v0.27.0 · 方案 §3.2）：设了白名单就 **fail-closed**——未标注空间的条目不放行。
  // 这是四空间「各自独立授权」的唯一执行点（`roles.enabled=false` 时整段不生效，零行为变化）。
  const spaces = policy.spaces
  if (spaces !== undefined && spaces.length > 0) {
    if (entry.space === undefined || !spaces.includes(entry.space)) return 'R2-space'
  }
  const entryRole = entry.role
  if (entryRole === undefined || entryRole.length === 0) {
    return policy.includeShared !== false ? undefined : 'R3-shared'
  }
  if (entryRole === callerRole) return undefined
  const read = policy.read ?? []
  if (read.includes('*')) return undefined
  return read.includes(entryRole) ? undefined : 'R4-read'
}

/** 单条准入判定（R1–R4，见文件头）——`rejectReason` 的布尔形态 */
export function admitsEntry(
  policy: RolePolicy,
  callerRole: string,
  entry: Pick<Entry, 'kind' | 'role' | 'space'>,
): boolean {
  return rejectReason(policy, callerRole, entry) === undefined
}

/** 单条写入准入判定（v0.51 · 方案 §11.1 四类权限之「写」）——`rejectWriteReason` 的布尔形态 */
export function admitsWrite(
  policy: RolePolicy,
  callerRole: string,
  target: { role?: string; space?: Space },
): boolean {
  return rejectWriteReason(policy, callerRole, target) === undefined
}

/**
 * 单条**写入**准入判定（v0.51 · 方案 §11.1）——返回拒因码，`undefined` 表示放行。
 *
 * 与 `rejectReason`（读）**成对但缺省不对称**，这是刻意的：
 * - 读闸缺省紧（`read` 缺省 `[]` ⇒ 只看自己 + 共享）
 * - 写闸缺省松（`write` 缺省 `['*']` ⇒ 不设限）——写闸是 v0.51 新增，
 *   它上线那一刻的缺省必须等于「升级前能做的」，否则存量配置会被静默改行为。
 *
 * 为什么读闸不能替代写闸（两个方向都要堵）：读闸让 worker **看不见** main 的隔间；
 * 写闸让 worker **写不进** main 的隔间。只有前者时，一条伪造归属的条目落在 main
 * 自己的隔间里，main 读到它没有任何标记说「这不是你写的」——**单向门不是隔间**。
 *
 * 判据码（与 `actor-audit.ts::CODE_LABELS` 一一对应）：
 * - `W1-space` 目标空间未标注或不在写空间白名单（fail-closed，与 R2 同纪律）
 * - `W2-role` 目标角色不在写白名单
 */
export function rejectWriteReason(
  policy: RolePolicy,
  callerRole: string,
  target: { role?: string; space?: Space },
): string | undefined {
  return rejectMutationReason(policy, callerRole, 'write', target)
}

/** 变更动作三档（方案 §11.1 四类权限里除「读」以外的三类） */
export type MutationAction = 'write' | 'update' | 'manage'

/** 各档的判据码（与 `actor-audit.ts::CODE_LABELS` 一一对应） */
const MUTATION_CODES: Record<MutationAction, { space: string; role: string }> = {
  write: { space: 'W1-space', role: 'W2-role' },
  update: { space: 'U1-space', role: 'U2-role' },
  manage: { space: 'M1-space', role: 'M2-role' },
}

/**
 * 变更面准入判定（v0.51 · 方案 §11.1 四类权限之「写 / 改 / 管」）——返回拒因码，`undefined` 表示放行。
 *
 * ## 为什么三档必须分开，而不是复用读闸
 *
 * `update` / `forget` / `memory_merge` 此前都先走 `gatherReadable(view)`，于是
 * **「能改的 ⊆ 能读的」**——看着像有闸，其实是读闸的副作用。后果很具体：
 * 生产配置里 `verifier` 的策略是 `read: [main]`（验收方要能读实施方的结论），
 * 而 `forget` 走同一个闸 ⇒ **验收方能删掉被验收方的记忆**。
 * 「能读」成了「能删」的充分条件，这不是权限模型，是把审阅权与改稿权焊死在一起。
 *
 * ## 三档的缺省都是「不设限」
 *
 * `policy[action] ?? ['*']`。写闸 / 改闸 / 管闸都是 v0.51 新增，缺省必须等于升级前的
 * 行为，否则存量配置会被静默改语义。想收紧就写成具体角色；写成 `[]`
 * 表示「除自己的隔间与共享记忆外一律不许」。
 *
 * ## 空间维度三档共用一个白名单
 *
 * `policy.writeSpaces` 的语义是「可写入 / 修改 / 管理的空间」。**刻意只做一档**：
 * 「写这个空间但改不了里面已有的条目」这个组合没有出现过的需求证据，
 * 而多一个字段就多一处会漂的真源（判断型字段禁默认值的同一条纪律：
 * 没有对象的维度不加旋钮）。
 *
 * 判据码：
 * - `W1/U1/M1-space` 目标空间未标注或不在白名单（fail-closed，与 `R2-space` 同纪律）
 * - `W2/U2/M2-role` 目标角色不在该动作的白名单
 */
export function rejectMutationReason(
  policy: RolePolicy,
  callerRole: string,
  action: MutationAction,
  target: { role?: string; space?: Space },
): string | undefined {
  const codes = MUTATION_CODES[action]
  const writeSpaces = policy.writeSpaces
  if (writeSpaces !== undefined && writeSpaces.length > 0) {
    if (target.space === undefined || !writeSpaces.includes(target.space)) return codes.space
  }
  const targetRole = target.role
  // 无归属 = 共享记忆：它不进任何人的隔间，也就谈不上伪造归属。
  if (targetRole === undefined || targetRole.length === 0) return undefined
  // 自己的隔间：与读侧同规则（自己的隔间自己管）。
  if (targetRole === callerRole) return undefined
  const list = policy[action] ?? ['*']
  if (list.includes('*')) return undefined
  return list.includes(targetRole) ? undefined : codes.role
}

/**
 * 按视野过滤条目，**同时交出拒绝读数**（v0.37 · 方案 §11.4 的埋点）。
 *
 * `view.enabled === false` ⇒ 零过滤、零计数（`rejected: 0`）——向后兼容是硬约束：
 * 未启用角色维度时不得因为「多了一条审计」改变任何行为。
 */
export interface RoleFilterResult {
  admitted: Entry[]
  /** 被拒绝的条数（视野管理的工作量；0 = 无拒绝） */
  rejected: number
  /** 拒因分布（键是判据码；空 = 无拒绝） */
  rejectedBy: Record<string, number>
}

/** 过滤并计数（`applyRoleView` 的带读数形态，读路径埋点用） */
export function filterRoleView(entries: Entry[], view: RoleView): RoleFilterResult {
  if (!view.enabled) return { admitted: entries, rejected: 0, rejectedBy: {} }
  const admitted: Entry[] = []
  const rejectedBy: Record<string, number> = {}
  let rejected = 0
  for (const entry of entries) {
    const reason = rejectReason(view.policy, view.role, entry)
    if (reason === undefined) {
      admitted.push(entry)
      continue
    }
    rejected += 1
    rejectedBy[reason] = (rejectedBy[reason] ?? 0) + 1
  }
  return { admitted, rejected, rejectedBy }
}

/**
 * 按视野过滤条目。`view.enabled === false` → 原样返回（零过滤，零拷贝）。
 * @param entries - 候选条目
 * @param view - roleViewOf 的产物
 */
export function applyRoleView(entries: Entry[], view: RoleView): Entry[] {
  return filterRoleView(entries, view).admitted
}

/**
 * 读作用域按视野收窄：配置了 `include_global: false` 且调用方**未显式指定 scope** 时，
 * 从读作用域里去掉 global（显式参数优先于配置，与 §5.3 作用域裁决同序）。
 */
export function narrowReadScopes(
  readScopes: string[],
  view: RoleView,
  explicitScope: string | undefined,
): string[] {
  if (!view.enabled || view.includeGlobal) return readScopes
  if (explicitScope !== undefined && explicitScope.length > 0) return readScopes
  return readScopes.filter((scope) => scope !== 'global')
}

/**
 * 逐角色准入判定（v0.52 · 方案 §12.1「谁能读这条」）——把 R1–R4 从「**调用者**会不会被拒」
 * 推广成「**每个已声明角色**各自会不会被拒」，供 recall / browse 的详情渲染用。
 *
 * 候选角色 = `{roles.default, roles.derived} ∪ policies 里声明过的角色`（去重、缺省角色在前）。
 * 维度未启用时返回 `[]`——**空数组不是「谁都不能读」**，是「这个维度不存在」；渲染层据此
 * 说「角色维度未启用」而不是留空（v0.52 判据②）。
 *
 * 为什么把 `includeGlobal=false` 也算进来（`R0-global`）：那是**作用域层**的准入
 * （`narrowReadScopes` 在检索前把 global 去掉），不在 `rejectReason` 的 R1–R4 里。
 * 不并进来，「谁能读这条」就会对 global 条目上的 worker/verifier/ghost 报出假阳性——
 * 而这张表存在的全部意义就是**别让人误以为某条记忆别人看得见**。
 */
export function readableRolesOf(
  config: Pick<MemoryConfig, 'roles'> | undefined | null,
  entry: Pick<Entry, 'kind' | 'role' | 'space'>,
  options: { entryInGlobalScope?: boolean } = {},
): ReadableByRole[] {
  const roles = rolesOf(config)
  if (!roles.enabled) return []
  const names = [roles.default, roles.derived, ...Object.keys(roles.policies)]
    .filter((name, index, all) => name.length > 0 && all.indexOf(name) === index)
  return names.map((role) => {
    const policy = rolePolicyOf(config, role)
    const reason = rejectReason(policy, role, entry)
      ?? (options.entryInGlobalScope === true && policy.includeGlobal === false ? 'R0-global' : undefined)
    return reason === undefined ? { role, canRead: true } : { role, canRead: false, reason }
  })
}
