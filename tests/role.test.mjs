/**
 * 角色维度单测（v0.5「多智能体工作台模式」）——role.ts 纯函数 + 工具层准入行为。
 * 运行：npm test（node --test "tests/*.test.mjs"，导入编译产物 lib/*.js）
 *
 * 覆盖（对应 docs/semantic.md §7 的 A19–A27）：
 *   A19 人类会话判据；A20 角色推导四级优先；A21 四条准入判据；
 *   A22 未启用 = 零过滤（含「同一数组引用」断言）；A23 读作用域收窄；
 *   A24 归属只在新建时盖章（key 覆盖 / 标题合并不转移）；
 *   A25 工具层准入（recall/browse/relate/stats/update/forget）；
 *   A26 历史配置字面量（无 roles 段）不崩且零过滤；A27 写路径盖章规则。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore } from '../lib/store.js'
import { createMemoryTools } from '../lib/tools.js'
import { workspaceIdOf } from '../lib/scope.js'
import {
  DEFAULT_ROLES_CONFIG,
  admitsEntry,
  applyRoleView,
  deriveRole,
  isUserSessionId,
  narrowReadScopes,
  rolePolicyOf,
  roleViewOf,
  rolesOf,
} from '../lib/role.js'

// ---------- 测试基建 ----------

class MemoryKv {
  constructor() {
    this.map = new Map()
  }
  get(key) {
    const value = this.map.get(key)
    return value === undefined ? undefined : { ...value }
  }
  async put(key, value) {
    this.map.set(key, { ...value })
  }
  async delete(key) {
    return this.map.delete(key)
  }
  entries() {
    return this.map.entries()
  }
  get size() {
    return this.map.size
  }
}

// ⚠ 双平台夹具纪律（技能 dsh-plugin-testability）：`WID` 必须由**被测的派生函数**算出。
// 硬编码 `c:/Users/Alice/proj` 在 POSIX（WSL）下不成立——`workspaceIdOf` 内部的 `resolve()` 语义
// 不同 ⇒ 作用域不匹配 ⇒ 整组用例静默变「0 命中」（2026-09-15 实测：12 个 A 测试在 node 22/WSL 侧红、Windows 侧绿）。
const CWD = 'C:\\Users\\Alice\\proj'
const WID = workspaceIdOf(CWD)

/** v0.4 形状的配置（**没有 roles 段**）——历史字面量的活样本 */
const LEGACY_CONFIG = {
  scope: 'workspace',
  layers: ['fact', 'knowledge', 'episodic'],
  autoSink: true,
  timeline: { day: true, week: true, month: true, year: true, archive: 'keep' },
  weeklyTemplate: '',
  maxEntries: 2000,
  inject: { enabled: true, maxBytes: 3000, maxEntries: 20 },
  autoInject: { enabled: true, maxBytes: 1500, maxEntries: 3 },
}

/** 启用角色维度的配置：main 看全部；worker 只看自己 + 共享；verifier 收窄到 fact/knowledge 且不读 global */
const ROLE_CONFIG = {
  ...LEGACY_CONFIG,
  roles: {
    enabled: true,
    default: 'main',
    derived: 'worker',
    byPreset: { code: 'worker', 'verify-preset': 'verifier' },
    policyDefault: { read: ['*'], includeShared: true, includeGlobal: true },
    policies: {
      worker: { read: [], includeShared: true, includeGlobal: true },
      verifier: { read: [], includeShared: true, includeGlobal: false, kinds: ['fact', 'knowledge'] },
    },
  },
}

function setup(config) {
  const kv = new MemoryKv()
  const store = new MemoryStore(kv)
  const tools = createMemoryTools({ store, loadConfig: async () => config })
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  return { kv, store, byName }
}

/** 构造 exec 会话载体：sessionId / delegationDepth / agentPreset 三要素 */
function execOf({ sessionId, depth, preset, cwd = CWD } = {}) {
  const header = { cwd }
  if (sessionId !== undefined) header.id = sessionId
  if (depth !== undefined) header.delegationDepth = depth
  if (preset !== undefined) header.agentPreset = preset
  return {
    agent: { session: { id: sessionId, header } },
    signal: new AbortController().signal,
  }
}

const MAIN_EXEC = execOf({ sessionId: 'session-11111111-2222-3333-4444-555555555555' })
const WORKER_EXEC = execOf({ sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', depth: 1 })
const VERIFIER_EXEC = execOf({ sessionId: 'ffffffff-1111-2222-3333-444444444444', depth: 1, preset: 'verify-preset' })

/** 直接塞条目（绕过 remember，显式控制 role/scope/kind） */
async function seed(store, { scope = WID, kind = 'knowledge', title, role, archived = false }) {
  const entry = await store.remember({ kind, title, body: `${title} 的正文`, tags: [], scope, level: null, bucket: null, role })
  if (archived) await store.forget(scope, entry.id, '测试归档')
  return entry
}

// ---------- A19 人类会话判据 ----------

test('A19 isUserSessionId：session-<uuid> 为真，裸 uuid / 空串为假', () => {
  assert.equal(isUserSessionId('session-11111111-2222-3333-4444-555555555555'), true)
  assert.equal(isUserSessionId('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'), false)
  assert.equal(isUserSessionId(''), false)
  assert.equal(isUserSessionId('session-not-a-uuid'), false)
})

// ---------- A20 角色推导 ----------

test('A20 角色推导：显式 > 预设映射 > 人类会话缺省 > 派生会话缺省', () => {
  const config = ROLE_CONFIG
  assert.equal(deriveRole({ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', delegationDepth: 1 }, config, 'auditor').role, 'auditor')
  assert.equal(deriveRole({ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', agentPreset: 'verify-preset' }, config).role, 'verifier')
  assert.equal(deriveRole({ id: 'session-11111111-2222-3333-4444-555555555555' }, config).role, 'main')
  const derived = deriveRole({ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', delegationDepth: 1 }, config)
  assert.equal(derived.role, 'worker')
  assert.ok(derived.reason.includes('派生会话'))
  // 无身份信息 → 人类缺省（保守：宁可见全，不可静默失明）
  assert.equal(deriveRole(undefined, config).role, 'main')
})

test('A20 roles 段缺失 → 走缺省角色配置且总开关关闭', () => {
  assert.deepEqual(rolesOf(LEGACY_CONFIG), DEFAULT_ROLES_CONFIG)
  const view = roleViewOf(LEGACY_CONFIG, WORKER_EXEC)
  assert.equal(view.enabled, false)
  assert.equal(view.role, 'derived') // 缺省 derived 名（未配置时不参与过滤）
  assert.equal(rolePolicyOf(LEGACY_CONFIG, 'anyone').includeGlobal, true)
})

// ---------- A21 准入四判据 ----------

test('A21 准入判据 R1–R4', () => {
  const policy = { read: [], includeShared: true }
  assert.equal(admitsEntry(policy, 'worker', { kind: 'knowledge', role: undefined }), true, 'R2 共享记忆放行')
  assert.equal(admitsEntry(policy, 'worker', { kind: 'knowledge', role: 'worker' }), true, 'R3 自己放行')
  assert.equal(admitsEntry(policy, 'worker', { kind: 'knowledge', role: 'main' }), false, 'R4 他人拒绝')
  assert.equal(admitsEntry(policy, 'worker', { kind: 'knowledge', role: 'verifier' }), false)
  assert.equal(admitsEntry({ read: ['main'] }, 'worker', { kind: 'knowledge', role: 'main' }), true, 'R4 白名单放行')
  assert.equal(admitsEntry({ read: ['*'] }, 'worker', { kind: 'knowledge', role: 'verifier' }), true, 'R4 通配放行')
  assert.equal(admitsEntry({ read: [], kinds: ['fact'] }, 'worker', { kind: 'episodic', role: 'worker' }), false, 'R1 种类收窄')
  assert.equal(admitsEntry({ read: [], includeShared: false }, 'worker', { kind: 'fact', role: undefined }), false, 'R2 关闭共享可见')
})

// ---------- A22 未启用 = 零过滤 ----------

test('A22 未启用角色维度 → 同一数组引用透传（零拷贝零过滤）', () => {
  const view = roleViewOf(LEGACY_CONFIG, MAIN_EXEC)
  const entries = [{ kind: 'knowledge', role: 'verifier' }]
  assert.equal(applyRoleView(entries, view), entries, '必须原样返回同一引用')
})

// ---------- A23 读作用域收窄 ----------

test('A23 include_global=false → 收窄读作用域；显式 scope 优先于配置', () => {
  const view = roleViewOf(ROLE_CONFIG, VERIFIER_EXEC)
  assert.equal(view.includeGlobal, false)
  assert.deepEqual(narrowReadScopes([WID, 'global'], view, undefined), [WID])
  assert.deepEqual(narrowReadScopes([WID, 'global'], view, 'global'), [WID, 'global'], '显式参数优先')
  const openView = roleViewOf(ROLE_CONFIG, WORKER_EXEC)
  assert.deepEqual(narrowReadScopes([WID, 'global'], openView, undefined), [WID, 'global'])
})

// ---------- A24/A27 写路径盖章 ----------

test('A24 归属只在新建时盖章：key 覆盖与标题合并都不转移归属', async () => {
  const { store } = setup(ROLE_CONFIG)
  const created = await store.remember({ kind: 'fact', key: 'slot', title: '槽位', body: 'v1', scope: WID, level: null, bucket: null, role: 'worker' })
  // 同 key 再写（显式指定别的角色）→ 归属不变
  await store.remember({ kind: 'fact', key: 'slot', title: '槽位', body: 'v2', scope: WID, level: null, bucket: null, role: 'main' })
  assert.equal(store.get(WID, created.id).role, 'worker', 'key 覆盖不得转移归属')

  const merged = await store.remember({ kind: 'knowledge', title: '可复用知识', body: 'a', scope: WID, level: null, bucket: null, role: 'worker' })
  await store.remember({ kind: 'knowledge', title: '可复用知识', body: 'b', scope: WID, level: null, bucket: null, role: 'main' })
  assert.equal(store.get(WID, merged.id).role, 'worker', '标题合并不得转移归属')
})

test('A27 工具层写路径盖章：启用 roles 时盖调用者角色；未启用且未显式指定 → 不盖章（共享）', async () => {
  const enabled = setup(ROLE_CONFIG)
  const r1 = await enabled.byName.get('remember').execute({ text: '队员写下的知识', kind: 'knowledge' }, WORKER_EXEC)
  assert.equal(enabled.store.get(WID, r1.id).role, 'worker')
  assert.equal(enabled.store.get(WID, r1.id).author.delegationDepth, 1)

  const disabled = setup(LEGACY_CONFIG)
  const r2 = await disabled.byName.get('remember').execute({ text: '未启用时不盖章', kind: 'knowledge' }, WORKER_EXEC)
  assert.equal(disabled.store.get(WID, r2.id).role, undefined, '未启用 ⇒ 共享记忆')
  assert.ok(disabled.store.get(WID, r2.id).author.sessionId.length > 0, 'author 无条件记录')

  const explicit = await disabled.byName.get('remember').execute({ text: '显式指定隔间', kind: 'knowledge', role: 'ghost-01' }, WORKER_EXEC)
  assert.equal(disabled.store.get(WID, explicit.id).role, 'ghost-01')
})

// ---------- A25 工具层准入 ----------

test('A25 recall：verifier 策略下看不见他人隔间与过程流（G8 机制化）', async () => {
  const { store, byName } = setup(ROLE_CONFIG)
  await seed(store, { kind: 'fact', title: '公共事实' })
  await seed(store, { kind: 'knowledge', title: '工人的知识', role: 'worker' })
  await seed(store, { kind: 'episodic', title: '工人的过程', role: 'worker' })
  await seed(store, { kind: 'fact', title: '主脑的事实', role: 'main' })
  await seed(store, { scope: 'global', kind: 'fact', title: '全局事实' })

  const verifier = await byName.get('recall').execute({}, VERIFIER_EXEC)
  const titles = verifier.results.map((r) => r.title).sort()
  assert.deepEqual(titles, ['公共事实'], 'verifier 只见共享 fact（他人隔间 / 过程流 / global 全不可见）')

  const worker = await byName.get('recall').execute({}, WORKER_EXEC)
  assert.deepEqual(worker.results.map((r) => r.title).sort(), ['公共事实', '工人的知识', '工人的过程', '全局事实'].sort(), 'worker 见自己 + 共享 + global')

  const main = await byName.get('recall').execute({}, MAIN_EXEC)
  assert.equal(main.results.length, 5, 'main 默认策略通配 → 全见')
})

test('A25 memory_browse / memory_stats / memory_relate 与 recall 同一视野', async () => {
  const { store, byName } = setup(ROLE_CONFIG)
  await seed(store, { kind: 'fact', title: '公共事实' })
  const hidden = await seed(store, { kind: 'episodic', title: '工人的过程', role: 'worker' })
  await seed(store, { scope: 'global', kind: 'fact', title: '全局事实' })

  const browse = await byName.get('memory_browse').execute({}, VERIFIER_EXEC)
  const browseTitles = browse.groups.flatMap((g) => g.items.map((i) => i.title))
  assert.deepEqual(browseTitles, ['公共事实'], 'browse 不得成为隔离缺口')

  const stats = await byName.get('memory_stats').execute({}, VERIFIER_EXEC)
  assert.equal(stats.total, 1, '统计只反映可见集合')
  assert.deepEqual(stats.scopes, [WID], 'include_global=false → 不收窄到 global')

  const relate = await byName.get('memory_relate').execute({ id: hidden.id }, VERIFIER_EXEC)
  assert.equal(relate.ok, false, '视野外条目不可作为联想起点')
  assert.ok(relate.error.includes('未找到'))
})

test('A25 update / forget：视野外条目不可改（修订权随视野）', async () => {
  const { store, byName } = setup(ROLE_CONFIG)
  const hidden = await seed(store, { kind: 'knowledge', title: '工人的知识', role: 'worker' })
  await assert.rejects(() => byName.get('update').execute({ id: hidden.id, text: '改' }, VERIFIER_EXEC), /未找到 id/)
  await assert.rejects(() => byName.get('forget').execute({ id: hidden.id }, VERIFIER_EXEC), /未找到 id/)
  // 自己的条目照样可改
  const own = await store.remember({ kind: 'knowledge', title: '自己的知识', body: 'x', tags: [], scope: WID, level: null, bucket: null, role: 'worker' })
  const updated = await byName.get('update').execute({ id: own.id, text: '自己的知识（改）' }, WORKER_EXEC)
  assert.equal(updated.id, own.id)
})

test('A25 显式 role 参数可切换视角（含反向：worker 声明 verifier 视角）', async () => {
  const { store, byName } = setup(ROLE_CONFIG)
  await seed(store, { kind: 'episodic', title: '工人的过程', role: 'worker' })
  const asVerifier = await byName.get('recall').execute({ role: 'verifier' }, WORKER_EXEC)
  assert.equal(asVerifier.results.length, 0, '以 verifier 视角检索 → 看不见自己的过程流')
  const asWorker = await byName.get('recall').execute({}, WORKER_EXEC)
  assert.equal(asWorker.results.length, 1)
})

// ---------- A26 兼容与回归 ----------

test('A26 未启用角色维度：全部条目对所有调用者可见（v0.4 行为回归）', async () => {
  const { store, byName } = setup(LEGACY_CONFIG)
  await seed(store, { kind: 'knowledge', title: '甲的条目', role: 'worker' })
  await seed(store, { kind: 'episodic', title: '乙的条目', role: 'verifier' })
  const asWorker = await byName.get('recall').execute({}, WORKER_EXEC)
  assert.equal(asWorker.results.length, 2, '未启用 ⇒ 零过滤')
  const health = await byName.get('memory_health').execute({}, WORKER_EXEC)
  assert.equal(health.rolesEnabled, false)
  assert.equal(health.role, 'derived')
  assert.equal(health.total, 2)
})

test('A26 历史配置字面量（无 roles 段）不崩：store/tools 全路径可用', async () => {
  const { store, byName } = setup(LEGACY_CONFIG)
  await byName.get('remember').execute({ text: '历史配置下的写入', kind: 'knowledge' }, MAIN_EXEC)
  const recall = await byName.get('recall').execute({ query: '历史配置' }, MAIN_EXEC)
  assert.equal(recall.results.length, 1)
  const stats = await byName.get('memory_stats').execute({}, MAIN_EXEC)
  assert.equal(stats.total, 1)
  assert.equal(store.list(WID).length, 1)
})
