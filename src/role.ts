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

import type { Entry, MemoryConfig, RolePolicy, RolesConfig } from './types.ts'

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
