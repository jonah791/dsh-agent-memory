/**
 * scope.ts 单测（IMPLEMENTATION.md §6 T3 验收）：
 * workspaceId 规范化 / 默认路由（workspace+global 附加）/ 显式覆盖三态 / 无 cwd 降级。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  GLOBAL_SCOPE,
  isGlobalScope,
  resolveScopes,
  sessionCwdOf,
  workspaceIdOf,
} from '../src/scope.ts'

const CWD = 'C:\\Users\\Alice\\proj'
const WID = 'c:/Users/Alice/proj'

// ---------- workspaceId 规范化 ----------

test('workspaceIdOf：绝对路径 → 盘符小写 + 统一斜杠 + 去尾分隔符', () => {
  // resolve() 保留输入大小写（盘符恒小写、分隔符统一为 /、去尾部斜杠）
  assert.equal(workspaceIdOf('C:\\Users\\Alice\\proj'), 'c:/Users/Alice/proj')
  assert.equal(workspaceIdOf('C:\\Users\\Alice\\proj\\'), 'c:/Users/Alice/proj')
  assert.equal(workspaceIdOf('c:\\users\\alice\\proj'), 'c:/users/alice/proj')
})

test('workspaceIdOf：POSIX 风格路径原样规范化（非 Windows）', (t) => {
  // Windows 的 path.resolve 会给绝对 POSIX 路径加当前盘符前缀，此断言仅对 POSIX 平台有效
  if (process.platform === 'win32') return t.skip('Windows resolve 会加盘符前缀')
  assert.equal(workspaceIdOf('/home/alice/proj'), '/home/alice/proj')
  assert.equal(workspaceIdOf('/home/alice/proj/'), '/home/alice/proj')
})

test('sessionCwdOf：从 exec 形状提取 cwd；缺 agent/缺 header 返回 undefined', () => {
  const exec = { agent: { session: { header: { cwd: CWD } } } }
  assert.equal(sessionCwdOf(exec), CWD)
  assert.equal(sessionCwdOf({ agent: { session: {} } }), undefined)
  assert.equal(sessionCwdOf({}), undefined)
  assert.equal(sessionCwdOf(null), undefined)
  assert.equal(sessionCwdOf(undefined), undefined)
})

test('isGlobalScope：仅 global 为真', () => {
  assert.equal(isGlobalScope('global'), true)
  assert.equal(isGlobalScope('c:/users/alice/proj'), false)
})

// ---------- 默认路由（配置模式） ----------

test('默认 workspace 模式：读=workspace+global，写=workspace', () => {
  const r = resolveScopes({ configScope: 'workspace', cwd: CWD })
  assert.equal(r.workspaceId, WID)
  assert.deepEqual(r.readScopes, [WID, GLOBAL_SCOPE])
  assert.equal(r.writeScope, WID)
})

test('global-first 模式：读=global 优先+workspace，写=workspace', () => {
  const r = resolveScopes({ configScope: 'global-first', cwd: CWD })
  assert.equal(r.workspaceId, WID)
  assert.deepEqual(r.readScopes, [GLOBAL_SCOPE, WID])
  assert.equal(r.writeScope, WID)
})

test('global 模式：读=写=global，忽略 workspace', () => {
  const r = resolveScopes({ configScope: 'global', cwd: CWD })
  assert.equal(r.workspaceId, WID)
  assert.deepEqual(r.readScopes, [GLOBAL_SCOPE])
  assert.equal(r.writeScope, GLOBAL_SCOPE)
})

// ---------- 显式覆盖三态 ----------

test('显式 scope=global：只查 global，忽略配置模式', () => {
  const r = resolveScopes({ configScope: 'workspace', cwd: CWD, explicit: 'global' })
  assert.deepEqual(r.readScopes, [GLOBAL_SCOPE])
  assert.equal(r.writeScope, GLOBAL_SCOPE)
})

test('显式 scope=workspaceId：跨项目查（global 附加），写该 workspace', () => {
  const other = 'd:/other/proj'
  const r = resolveScopes({ configScope: 'global', cwd: CWD, explicit: other })
  assert.equal(r.workspaceId, WID)
  assert.deepEqual(r.readScopes, [other, GLOBAL_SCOPE])
  assert.equal(r.writeScope, other)
})

test('显式覆盖优先于 global-first 配置', () => {
  const r = resolveScopes({ configScope: 'global-first', cwd: CWD, explicit: 'global' })
  assert.deepEqual(r.readScopes, [GLOBAL_SCOPE])
  assert.equal(r.writeScope, GLOBAL_SCOPE)
})

// ---------- 无 cwd 降级 ----------

test('无 cwd（workspace 模式）→ 降级只走 global', () => {
  const r = resolveScopes({ configScope: 'workspace' })
  assert.equal(r.workspaceId, null)
  assert.deepEqual(r.readScopes, [GLOBAL_SCOPE])
  assert.equal(r.writeScope, GLOBAL_SCOPE)
})

test('无 cwd（global-first 模式）→ 降级只走 global', () => {
  const r = resolveScopes({ configScope: 'global-first' })
  assert.equal(r.workspaceId, null)
  assert.deepEqual(r.readScopes, [GLOBAL_SCOPE])
  assert.equal(r.writeScope, GLOBAL_SCOPE)
})

test('无 cwd + 显式 workspaceId → 仍按显式路由', () => {
  const other = 'd:/other/proj'
  const r = resolveScopes({ configScope: 'workspace', explicit: other })
  assert.equal(r.workspaceId, null)
  assert.deepEqual(r.readScopes, [other, GLOBAL_SCOPE])
  assert.equal(r.writeScope, other)
})
