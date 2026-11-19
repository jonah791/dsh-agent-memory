/**
 * 写入准入（v0.51 · 方案 §11.1 四类权限之「写」）· 判据
 *
 * ## 为什么需要这一层
 *
 * 读准入门（v0.5 `role`）早就存在：worker 看不见 main 的隔间。但**写侧没有任何闸**——
 * `remember` 的 `role` 参数（`roleStampOf`）是**调用方自述**的，worker 可以
 * `remember({ role: 'main' })` 把条目写进主脑的隔间。
 *
 * 这不是「少见」的问题，是**单向门**的问题：伪造条目落在 main 自己的隔间里，
 * main 读到它时**没有任何标记**说「这不是你写的」；要发现得专门去查 `memory_trail`
 * 的 actor，而那时数据已经脏了。读闸 + 写闸是一对，缺一半就不是隔间。
 *
 * ## 判据形状：三对
 *
 * ① **该拒的拒**（W1–W6）：目标归属 / 空间不在白名单 ⇒ 拒，拒因码可辨
 * ② **该过的过**（W7–W10）：自己的隔间、共享记忆、白名单含 `'*'`、未启用角色维度
 * ③ **判的与盖的是同一个值**（E6）：闸门判 A 而落库写 B 是最难发现的漏洞形状
 *
 * ## 向后兼容是硬约束
 *
 * `write` / `writeSpaces` 缺省**不设限**（`.write ?? ['*']`、未设则跳过空间检查）。
 * 存量配置（含 `roles.enabled=false`）升级后行为必须逐字不变——E5 钉这一条。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MemoryStore } from '../lib/store.js'
import { createMemoryTools } from '../lib/tools.js'
import { DEFAULT_CONFIG } from '../lib/config.js'
import { workspaceIdOf } from '../lib/scope.js'
import { admitsWrite, rejectWriteReason } from '../lib/role.js'

const CWD = 'C:\\Users\\Alice\\proj'
const WID = workspaceIdOf(CWD)

/** 内存 KV（与 marker-parity 同形） */
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

/** 造一份启用角色维度的配置 */
function cfgWithRoles(policies) {
  return {
    ...DEFAULT_CONFIG,
    roles: {
      enabled: true,
      default: 'main',
      derived: 'worker',
      byPreset: {},
      policyDefault: { read: ['*'], includeShared: true, includeGlobal: true },
      policies,
    },
  }
}

/**
 * 造一次工具调用。
 * @param sessionId - `session-<uuid>` ⇒ 人类会话（main）；裸 uuid ⇒ 派生会话（worker）
 */
function execOf(sessionId) {
  return {
    agent: { session: { id: sessionId, header: { id: sessionId, cwd: CWD } } },
    signal: new AbortController().signal,
  }
}

const HUMAN = 'session-11111111-2222-3333-4444-555555555555'
const DERIVED = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

/** 造一套工具（可注入配置与审计收集器） */
function setup({ config = DEFAULT_CONFIG, audits = [] } = {}) {
  const kv = new MemoryKv()
  const store = new MemoryStore(kv)
  const tools = createMemoryTools({
    store,
    loadConfig: async () => config,
    recordAudit: (record) => {
      audits.push(record)
    },
  })
  return { kv, store, byName: new Map(tools.map((t) => [t.name, t])), audits }
}

async function rememberWith(byName, exec, args) {
  const tool = byName.get('remember')
  return tool.execute({ kind: 'knowledge', text: '写入准入判据样本甲\n中性正文，不含被断言的字面。', ...args }, exec)
}

// ---------- W 段：纯函数 ----------

test('W1 空策略：任意目标都放行（缺省不设限 = 升级不改存量行为）', () => {
  const policy = {}
  for (const target of [{}, { role: 'main' }, { role: 'other', space: 'system' }, { space: 'personal' }]) {
    assert.equal(rejectWriteReason(policy, 'worker', target), undefined, `空策略不该拒 ${JSON.stringify(target)}`)
    assert.equal(admitsWrite(policy, 'worker', target), true)
  }
})

test('W2 写白名单含目标角色 ⇒ 放行', () => {
  assert.equal(rejectWriteReason({ write: ['main'] }, 'worker', { role: 'main' }), undefined)
})

test('W3 目标角色不在写白名单 ⇒ 拒 W2-role', () => {
  assert.equal(rejectWriteReason({ write: ['main'] }, 'worker', { role: 'stranger' }), 'W2-role')
})

test('W4 写白名单为空数组 ⇒ 别人的隔间一律拒（空 ≠ 不设限）', () => {
  assert.equal(rejectWriteReason({ write: [] }, 'worker', { role: 'main' }), 'W2-role')
  // ⚠ 空数组与缺省必须是两件事：缺省 = 不设限，[] = 谁都不许。若两者同义，
  // 想收紧配置的人写 `write: []` 会得到完全相反的效果。
})

test('W5 目标无归属（共享记忆）⇒ 放行，即使白名单为空', () => {
  assert.equal(rejectWriteReason({ write: [] }, 'worker', {}), undefined)
  // 共享记忆不进任何人的隔间，也就谈不上伪造归属。
})

test('W6 写自己的隔间 ⇒ 放行，即使白名单为空', () => {
  assert.equal(rejectWriteReason({ write: [] }, 'worker', { role: 'worker' }), undefined)
  // 与读侧同规则：自己的隔间自己管。
})

test('W7 写空间白名单设了 ⇒ 未标注空间 fail-closed（W1-space）', () => {
  assert.equal(rejectWriteReason({ writeSpaces: ['project'] }, 'worker', {}), 'W1-space')
})

test('W8 写空间不在白名单 ⇒ 拒 W1-space', () => {
  assert.equal(rejectWriteReason({ writeSpaces: ['project'] }, 'worker', { space: 'system' }), 'W1-space')
})

test('W9 写空间在白名单 ⇒ 放行', () => {
  assert.equal(rejectWriteReason({ writeSpaces: ['project'] }, 'worker', { space: 'project' }), undefined)
})

test('W10 读空间白名单不影响写（两个维度独立）', () => {
  // `spaces`（读）设了 system，但 `writeSpaces` 没设 ⇒ 写 system 仍放行。
  // 若复用同一个字段，收紧读权限会连带改掉写行为——两个维度的后果不该互相传染。
  assert.equal(rejectWriteReason({ spaces: ['system'] }, 'worker', { space: 'personal' }), undefined)
})

// ---------- E 段：端到端 ----------

test('E1 worker 指定 role=main ⇒ 被拒，拒因码 W2-role', async () => {
  const cfg = cfgWithRoles({ worker: { read: ['main'], write: ['worker'] } })
  const { byName } = setup({ config: cfg })
  await assert.rejects(
    () => rememberWith(byName, execOf(DERIVED), { role: 'main' }),
    (err) => {
      assert.match(err.message, /W2-role/)
      return true
    },
  )
})

test('E2 worker 写进自己的隔间 ⇒ 成功且落库 role=worker', async () => {
  const cfg = cfgWithRoles({ worker: { read: ['main'], write: ['worker'] } })
  const { byName, store } = setup({ config: cfg })
  const result = await rememberWith(byName, execOf(DERIVED), {})
  const [entry] = store.list(WID, { includeArchive: false })
  assert.equal(entry.role, 'worker')
  assert.ok(result.id !== undefined)
})

test('E3 worker 写 space=system 而写空间白名单只有 project ⇒ 被拒 W1-space', async () => {
  const cfg = cfgWithRoles({ worker: { read: ['main'], writeSpaces: ['project'] } })
  const { byName } = setup({ config: cfg })
  await assert.rejects(
    () => rememberWith(byName, execOf(DERIVED), { space: 'system' }),
    (err) => {
      assert.match(err.message, /W1-space/)
      return true
    },
  )
})

test('E4 拒绝落审计：action=permission / code=W2-role / tool=remember', async () => {
  const cfg = cfgWithRoles({ worker: { read: ['main'], write: ['worker'] } })
  const { byName, audits } = setup({ config: cfg })
  await assert.rejects(() => rememberWith(byName, execOf(DERIVED), { role: 'main' }))
  const reject = audits.find((item) => item.action === 'permission' && item.outcome === 'rejected')
  assert.ok(reject !== undefined, '写入拒绝必须落审计——否则「写违规 = 0」又是一句不可测的断言')
  assert.equal(reject.code, 'W2-role')
  assert.equal(reject.tool, 'remember')
})

test('E5 未启用角色维度 ⇒ 行为逐字不变（worker 指定 role=main 仍放行）', async () => {
  // 向后兼容硬约束：升级不许改变任何存量配置的行为。
  const { byName, store } = setup({ config: DEFAULT_CONFIG })
  assert.equal(DEFAULT_CONFIG.roles?.enabled, false)
  await rememberWith(byName, execOf(DERIVED), { role: 'main' })
  const [entry] = store.list(WID, { includeArchive: false })
  assert.equal(entry.role, 'main')
})

test('E6 判的与盖的是同一个值：闸判 worker 放行时落库就是 worker，判 main 被拒时库内零新增', async () => {
  const cfg = cfgWithRoles({ worker: { read: ['main'], write: ['worker'] } })
  const { byName, store } = setup({ config: cfg })
  const before = store.list(WID, { includeArchive: false }).length
  await rememberWith(byName, execOf(DERIVED), { role: 'worker' })
  const after = store.list(WID, { includeArchive: false })
  assert.equal(after.length, before + 1)
  assert.equal(after.every((item) => item.role === 'worker'), true)
  // 被拒的那次一条都不许落：判 A 写 B（或判拒却仍写）会让闸门变成装饰。
  await assert.rejects(() => rememberWith(byName, execOf(DERIVED), { role: 'main' }))
  assert.equal(store.list(WID, { includeArchive: false }).length, before + 1)
})

// ---------- U / M 段：改与管（v0.51 三档里的另两档） ----------

/** 造一份带 byPreset 映射的配置（用于 verifier 这类非 derived 缺省角色） */
function cfgWithVerifier(policy) {
  return {
    ...DEFAULT_CONFIG,
    roles: {
      enabled: true,
      default: 'main',
      derived: 'worker',
      byPreset: { verify: 'verifier' },
      policyDefault: { read: ['*'], includeShared: true, includeGlobal: true },
      policies: { verifier: policy },
    },
  }
}

function execWithPreset(sessionId, preset) {
  return {
    agent: { session: { id: sessionId, header: { id: sessionId, cwd: CWD, agentPreset: preset } } },
    signal: new AbortController().signal,
  }
}

test('M3 verifier 能读 main、能改 main，但**不能删 main**（审阅权 ≠ 改稿权 ≠ 删除权）', async () => {
  // 这是 v0.51 的存在理由：改/管此前复用读闸 ⇒ 能读就等于能删。
  const cfg = cfgWithVerifier({ read: ['main'], update: ['main'], manage: [] })
  const { byName, store } = setup({ config: cfg })
  // main 写一条
  await rememberWith(byName, execOf(HUMAN), {})
  const [entry] = store.list(WID, { includeArchive: false })
  assert.equal(entry.role, 'main')

  const verifier = execWithPreset(DERIVED, 'verify')
  // 改：放行（update 白名单含 main）
  await byName.get('update').execute({ id: entry.id, mode: 'append', text: '\n（验收方补注）' }, verifier)
  const afterUpdate = store.list(WID, { includeArchive: false }).find((item) => item.id === entry.id)
  assert.match(afterUpdate.body, /验收方补注/)

  // 删：拒（manage 白名单为空）
  await assert.rejects(
    () => byName.get('forget').execute({ id: entry.id, reason: '验收方尝试删除' }, verifier),
    (err) => {
      assert.match(err.message, /M2-role/)
      return true
    },
  )
  // 且**没有真删**：拒绝必须发生在落库之前，不能「拒了却已归档」
  const still = store.list(WID, { includeArchive: true }).find((item) => item.id === entry.id)
  assert.equal(still.archived, false)
})

test('U1 update 白名单不含目标角色 ⇒ 拒 U2-role（能读不等于能改）', async () => {
  const cfg = cfgWithVerifier({ read: ['main'], update: [], manage: [] })
  const { byName, store } = setup({ config: cfg })
  await rememberWith(byName, execOf(HUMAN), {})
  const [entry] = store.list(WID, { includeArchive: false })
  await assert.rejects(
    () => byName.get('update').execute({ id: entry.id, mode: 'append', text: '\n越权改' }, execWithPreset(DERIVED, 'verify')),
    (err) => {
      assert.match(err.message, /U2-role/)
      return true
    },
  )
})

test('M4 manage 缺省不设限 ⇒ 升级不改存量行为（同 E5 的改/管版）', async () => {
  // 只配 read（v0.50 之前的写法），manage 未配 ⇒ 删除仍放行。
  const cfg = cfgWithVerifier({ read: ['main'] })
  const { byName, store } = setup({ config: cfg })
  await rememberWith(byName, execOf(HUMAN), {})
  const [entry] = store.list(WID, { includeArchive: false })
  await byName.get('forget').execute({ id: entry.id, reason: '默认不设限' }, execWithPreset(DERIVED, 'verify'))
  const after = store.list(WID, { includeArchive: true }).find((item) => item.id === entry.id)
  assert.equal(after.archived, true)
})

test('M5 管拒绝也落审计（action=permission / code=M2-role / tool=forget）', async () => {
  const cfg = cfgWithVerifier({ read: ['main'], manage: [] })
  const { byName, store, audits } = setup({ config: cfg })
  await rememberWith(byName, execOf(HUMAN), {})
  const [entry] = store.list(WID, { includeArchive: false })
  await assert.rejects(() => byName.get('forget').execute({ id: entry.id }, execWithPreset(DERIVED, 'verify')))
  const reject = audits.find((item) => item.action === 'permission' && item.tool === 'forget')
  assert.ok(reject !== undefined)
  assert.equal(reject.code, 'M2-role')
})
