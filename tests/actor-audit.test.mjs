/**
 * §11.4 操作者审计流 · 判据（A 段）——设计正本 `docs/design/aml-audit.md`
 *
 * 这一层测三件事，顺序就是重要性：
 *   ① **最小化**（A1–A2、E3）：审计流是新的隐私面，它一旦把内容带回来，「审计」就变成第二个记忆库副本；
 *   ② **判断型字段禁默认值**（A4）：`rejected` 不带判据码的记录在**读取侧就被丢弃**——
 *      它是本模块要禁止的形状，不许被「宽容解析」放回来；
 *   ③ **成对判据**（E5/E6、R4/R5）：该记的记、不该记的不记；负向全绿会掩盖正向被堵死（本仓 2026-11-19 的教训）。
 *
 * 为什么还测 role 层：权限拒绝是审计流唯一「从不可见变可见」的那一类，
 * 而 `admitsEntry` 原本是布尔函数——拒绝被压成 `false` 就静默消失了。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_AUDIT_IDS,
  filterActorAudit,
  findBursts,
  parseActorAudit,
  readActorAudit,
  sanitizeActorAuditRecord,
  shortActorId,
  summarizeActorAudit,
  summarizeActorAuditRecords,
} from '../lib/actor-audit.js'
import { admitsEntry, applyRoleView, filterRoleView, rejectReason } from '../lib/role.js'
import { MemoryStore } from '../lib/store.js'
import { RelationStore } from '../lib/relations.js'
import { createMemoryTools } from '../lib/tools.js'
import { workspaceIdOf } from '../lib/scope.js'

// ---------- 纯函数层 ----------

const BASE = { atMs: 1_700_000_000_000, action: 'write', actor: { sessionId: 's-1' }, target: { id: 'm-1' }, outcome: 'ok' }

test('A1 白名单裁剪：塞进 target 的正文/标题/查询**在写入前就消失**（最小化的执行点）', () => {
  const dirty = {
    ...BASE,
    actor: { sessionId: 's-1', role: 'main', preset: '不该出现' },
    target: { id: 'm-1', text: 'Zj7Q正文', title: 'Wq9X标题', query: 'Kp3M查询' },
    reason: '用户给的理由（自由文本，属内容面）',
    at: '2026-11-19',
  }
  const clean = sanitizeActorAuditRecord(dirty)
  const serialized = JSON.stringify(clean)
  for (const mark of ['Zj7Q', 'Wq9X', 'Kp3M', '用户给的理由']) {
    assert.ok(!serialized.includes(mark), `白名单没拦住「${mark}」：审计流会把内容带回来`)
  }
  assert.deepEqual(Object.keys(clean).sort(), ['action', 'actor', 'atMs', 'outcome', 'target'])
  assert.deepEqual(clean.actor, { sessionId: 's-1', role: 'main' }, 'actor 也只放三要素')
  assert.deepEqual(clean.target, { id: 'm-1' })
})

test('A2 ids 截断但 count 不截断：数组截断只影响可读性，计数是汇总口径', () => {
  const ids = Array.from({ length: MAX_AUDIT_IDS + 5 }, (_, i) => `m-${i}`)
  const clean = sanitizeActorAuditRecord({ ...BASE, action: 'forget', target: { ids, count: ids.length } })
  assert.equal(clean.target.ids.length, MAX_AUDIT_IDS, 'ids 必须截断（否则长列表把侧车撑爆）')
  assert.equal(clean.target.count, MAX_AUDIT_IDS + 5, 'count 不许跟着截断——「删了多少」不能变成假读数')
})

test('A3 坏行跳过不抛：非 JSON / 缺 atMs / 非法 action / 非法 outcome 四种', () => {
  const good = JSON.stringify(BASE)
  const text = [
    good,
    'not json',
    JSON.stringify({ action: 'write', actor: {}, target: {}, outcome: 'ok' }), // 缺 atMs
    JSON.stringify({ ...BASE, action: 'delete' }), // 非法 action
    JSON.stringify({ ...BASE, outcome: 'maybe' }), // 非法 outcome
    '',
  ].join('\n')
  const records = parseActorAudit(text)
  assert.equal(records.length, 1, '只有那条合法记录能进来——侧车是旁证，坏行不许成为故障源')
})

test('A4 rejected 缺判据码的记录**在读取侧被丢弃**（不存在「拒绝但说不出为什么」）', () => {
  const text = [
    JSON.stringify({ ...BASE, action: 'permission', outcome: 'rejected' }), // 缺 code
    JSON.stringify({ ...BASE, action: 'permission', outcome: 'rejected', code: '' }), // 空 code
    JSON.stringify({ ...BASE, action: 'permission', outcome: 'rejected', code: 'R2-space' }), // 合法
  ].join('\n')
  const records = parseActorAudit(text)
  assert.equal(records.length, 1, '两条缺码的必须被丢弃——宽容解析等于把要禁止的形状放回来')
  assert.equal(records[0].code, 'R2-space')
})

test('A5 读侧过滤：action / sessionId / sinceMs 各自生效，limit 取**最近**的 N 条', () => {
  const recs = [
    { ...BASE, atMs: 1000, action: 'write', actor: { sessionId: 'a' } },
    { ...BASE, atMs: 2000, action: 'forget', actor: { sessionId: 'b' } },
    { ...BASE, atMs: 3000, action: 'write', actor: { sessionId: 'a' } },
    { ...BASE, atMs: 4000, action: 'permission', actor: { sessionId: 'a' }, outcome: 'rejected', code: 'R4-read' },
  ]
  assert.equal(filterActorAudit(recs, { action: 'write' }).length, 2)
  assert.equal(filterActorAudit(recs, { sessionId: 'b' }).length, 1)
  assert.equal(filterActorAudit(recs, { sinceMs: 3500 }).length, 1)
  assert.deepEqual(filterActorAudit(recs, { limit: 2 }).map((r) => r.atMs), [3000, 4000], 'limit 取最近：旧记录先被丢掉')
})

test('A6 汇总口径：五类动作之和与三态之和都等于 total（不存在「总 N 条但分档加起来不等」）', () => {
  const recs = [
    BASE,
    { ...BASE, atMs: 1_700_000_000_001, action: 'update' },
    { ...BASE, atMs: 1_700_000_000_002, action: 'forget', outcome: 'partial' },
    { ...BASE, atMs: 1_700_000_000_003, action: 'link' },
    { ...BASE, atMs: 1_700_000_000_004, action: 'permission', outcome: 'rejected', code: 'R2-space' },
  ]
  const s = summarizeActorAuditRecords(recs)
  assert.equal(s.total, 5)
  assert.equal(Object.values(s.byAction).reduce((a, b) => a + b, 0), s.total)
  assert.equal(Object.values(s.byOutcome).reduce((a, b) => a + b, 0), s.total)
  assert.deepEqual(s.byAction, { write: 1, update: 1, forget: 1, link: 1, permission: 1 })
  assert.deepEqual(s.rejectedByCode, { 'R2-space': 1 })
  assert.equal(s.lastAtMs, 1_700_000_000_004)
})

test('A7 distinctActors 不把「无会话 id」算成一个操作者（不知道 ≠ 一个人）', () => {
  const recs = [
    BASE,
    { ...BASE, actor: {} },
    { ...BASE, actor: { role: 'main' } },
    { ...BASE, actor: { sessionId: 's-1' } },
  ]
  assert.equal(summarizeActorAuditRecords(recs).distinctActors, 1)
})

test('A8 动作簇：同会话同动作在窗内达阈值才报；**跨动作不合并**', () => {
  const t = 1_700_000_000_000
  const burst = [
    { ...BASE, atMs: t, action: 'forget' },
    { ...BASE, atMs: t + 60_000, action: 'forget' },
    { ...BASE, atMs: t + 120_000, action: 'forget' },
  ]
  const hits = findBursts(burst, { windowMs: 5 * 60_000, minCount: 3 })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].count, 3)

  // 同会话但在三个不同动作上各一次 ⇒ 不构成「同一形状」的簇
  const mixed = [
    { ...BASE, atMs: t, action: 'forget' },
    { ...BASE, atMs: t + 1000, action: 'write' },
    { ...BASE, atMs: t + 2000, action: 'update' },
  ]
  assert.equal(findBursts(mixed, { windowMs: 5 * 60_000, minCount: 3 }).length, 0, '跨动作合一会把「正常干活」读成「失控」')

  // 窗太窄 ⇒ 也不算
  const spread = [
    { ...BASE, atMs: t, action: 'forget' },
    { ...BASE, atMs: t + 10 * 60_000, action: 'forget' },
    { ...BASE, atMs: t + 20 * 60_000, action: 'forget' },
  ]
  assert.equal(findBursts(spread, { windowMs: 5 * 60_000, minCount: 3 }).length, 0)
})

test('A9 动作簇阈值守卫：minCount < 2 与 windowMs <= 0 直接返回空（不产生恒真信号）', () => {
  const recs = Array.from({ length: 10 }, (_, i) => ({ ...BASE, atMs: i, action: 'forget' }))
  assert.deepEqual(findBursts(recs, { windowMs: 1000, minCount: 1 }), [])
  assert.deepEqual(findBursts(recs, { windowMs: 0, minCount: 3 }), [])
})

// ---------- role 层：拒绝从布尔值变成可读的判据 ----------

const POLICY_SPACES = { read: ['*'], includeShared: true, spaces: ['personal'] }
const POLICY_KINDS = { read: ['*'], includeShared: true, kinds: ['knowledge'] }
const POLICY_SHARED_OFF = { read: ['*'], includeShared: false }
const POLICY_READ = { read: ['verifier'], includeShared: true }

test('R1 四条判据码各自正确，且与 admitsEntry 布尔判定**完全等价**', () => {
  const cases = [
    [POLICY_KINDS, 'main', { kind: 'fact', role: undefined, space: undefined }, 'R1-kind'],
    [POLICY_SPACES, 'main', { kind: 'knowledge', role: undefined, space: undefined }, 'R2-space'],
    [POLICY_SHARED_OFF, 'main', { kind: 'knowledge', role: undefined, space: undefined }, 'R3-shared'],
    [POLICY_READ, 'main', { kind: 'knowledge', role: 'impl', space: undefined }, 'R4-read'],
  ]
  for (const [policy, role, entry, expected] of cases) {
    assert.equal(rejectReason(policy, role, entry), expected, `${expected} 未命中`)
    assert.equal(admitsEntry(policy, role, entry), false, `${expected}：布尔形态也必须拒`)
  }
  // 该过的必须过，且**不返回码**（否则「放行」与「有理由的拒绝」会被混为一谈）
  assert.equal(rejectReason(POLICY_SPACES, 'main', { kind: 'knowledge', role: undefined, space: 'personal' }), undefined)
  assert.equal(rejectReason({ read: ['impl'], includeShared: true }, 'verifier', { kind: 'knowledge', role: 'impl', space: undefined }), undefined,
    '白名单放的是**条目的**角色——调用者是谁不影响该条目能不能被看见')
})

test('R2 filterRoleView 交出计数与分布；applyRoleView 与它同源（零回归）', () => {
  const entries = [
    { id: 'a', kind: 'knowledge', role: undefined, space: 'personal' },
    { id: 'b', kind: 'knowledge', role: undefined, space: undefined },
    { id: 'c', kind: 'knowledge', role: undefined, space: 'domain' },
  ]
  const view = { role: 'main', reason: '', enabled: true, policy: POLICY_SPACES, includeGlobal: true }
  const filtered = filterRoleView(entries, view)
  assert.equal(filtered.admitted.length, 1)
  assert.equal(filtered.rejected, 2)
  assert.deepEqual(filtered.rejectedBy, { 'R2-space': 2 })
  assert.deepEqual(applyRoleView(entries, view), filtered.admitted, '两条路必须同源——分叉就会有一边在说谎')
})

test('R3 角色维度未启用 ⇒ 零过滤、**零计数**（向后兼容是硬约束）', () => {
  const entries = [{ id: 'a', kind: 'knowledge', role: 'other', space: undefined }]
  const view = { role: 'main', reason: '', enabled: false, policy: POLICY_READ, includeGlobal: true }
  const filtered = filterRoleView(entries, view)
  assert.equal(filtered.admitted.length, 1)
  assert.equal(filtered.rejected, 0, '未启用却报拒绝 ⇒ 审计流会被假事件淹没')
  assert.deepEqual(filtered.rejectedBy, {})
})

// ---------- 工具层端到端 ----------

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
}

const CWD = 'C:\\Users\\Alice\\proj'
const WID = workspaceIdOf(CWD)
const CONFIG = { maxEntries: 500, layers: ['fact', 'knowledge', 'episodic', 'summary'] }
const ROLE_CONFIG = {
  ...CONFIG,
  roles: {
    enabled: true,
    policyDefault: { read: ['*'], includeShared: true, includeGlobal: true, spaces: ['personal'] },
    policies: {},
  },
}

function setupE2E(opts = {}) {
  const store = new MemoryStore(new MemoryKv())
  const relations = new RelationStore(new MemoryKv())
  const audit = []
  const deps = {
    store,
    relations,
    concepts: undefined,
    entities: undefined,
    sources: undefined,
    loadConfig: () => opts.config ?? CONFIG,
  }
  if (opts.recordAudit !== false) {
    deps.recordAudit = (record) => {
      audit.push(record)
    }
  }
  if (opts.readAudit !== false) {
    deps.readAudit = async () =>
      audit.length === 0
        ? { records: [], summary: summarizeActorAuditRecords([]) }
        : { records: audit.slice(), summary: summarizeActorAuditRecords(audit) }
  }
  const tools = createMemoryTools(deps)
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const exec = { agent: { session: { id: 'session-audit', header: { cwd: CWD } } } }
  return { store, relations, audit, byName, exec }
}

test('E1 remember 写入 → 一条 write 记录，且操作者三要素可对账', async () => {
  const { byName, audit, exec } = setupE2E()
  const created = await byName.get('remember').execute({ text: '# 标题\n正文' }, exec)
  assert.equal(audit.length, 1)
  assert.equal(audit[0].action, 'write')
  assert.equal(audit[0].outcome, 'ok')
  assert.equal(audit[0].target.id, created.id, 'id 要能对上——否则审计没法回答「说的哪一条」')
  assert.equal(audit[0].actor.sessionId, 'session-audit', '操作者必须来自会话头，不许各调用点自造')
  assert.equal(audit[0].tool, 'remember')
})

test('E2 remember 同标题合并 → 记 update（不是 write：它改变了一条已存在的记忆）', async () => {
  const { byName, audit, exec } = setupE2E()
  await byName.get('remember').execute({ text: '# 同名\n第一版' }, exec)
  await byName.get('remember').execute({ text: '# 同名\n第二版' }, exec)
  assert.equal(audit.length, 2)
  assert.equal(audit[1].action, 'update', 'merged 归 update——记成 write 会让「新建了多少」虚高')
  assert.equal(audit[1].code, 'merged')
})

test('E3 forget → forget 记录**不含被删内容**（与凭证同一最小化判据）', async () => {
  const { byName, audit, exec } = setupE2E()
  const titleMark = 'Zj7Q审计标题'
  const bodyMark = 'Wq9X审计正文'
  const created = await byName.get('remember').execute({ text: `# ${titleMark}\n${bodyMark}` }, exec)
  audit.length = 0 // 只看 forget 那条
  await byName.get('forget').execute({ id: created.id, reason: '测试审计最小化' }, exec)
  const forgets = audit.filter((r) => r.action === 'forget')
  assert.equal(forgets.length, 1)
  assert.deepEqual(forgets[0].target.ids, [created.id])
  assert.equal(forgets[0].code, 'entry', 'code 放操作模式（entry/topic/all）——它是「哪种删除」的唯一载体')
  const serialized = JSON.stringify(forgets[0])
  assert.ok(!serialized.includes('Zj7Q'), '审计流里出现被删标题 ⇒ 最小化已破')
  assert.ok(!serialized.includes('Wq9X'), '审计流里出现被删正文 ⇒ 最小化已破')
  assert.ok(!serialized.includes('测试审计最小化'), '用户给的 reason 是自由文本（内容面），不许进审计流')
})

test('E3b forget 零命中是 fail-loud 且**不写审计**（失败的动作不是动作）', async () => {
  const { byName, audit, exec } = setupE2E()
  await assert.rejects(
    () => byName.get('forget').execute({ mode: 'topic', topicTags: ['不存在的标签'] }, exec),
    /id \/ ids \/ tier|选择器|未匹配/,
  )
  assert.equal(audit.length, 0, '抛错前没有动作发生——记一条「已遗忘」就是假记录')
})

test('E3c forget dryRun **不记**（审计的判据是「改变了什么」——dry-run 什么都没改）', async () => {
  const { byName, audit, exec } = setupE2E()
  const created = await byName.get('remember').execute({ text: '# 预演' }, exec)
  audit.length = 0
  await byName.get('forget').execute({ id: created.id, dryRun: true }, exec)
  assert.equal(audit.length, 0, '把查询记成变更会让「删了多少」虚高；「谁计划要删」归提案日志')
})

test('E4 memory_link 只在**真新建**时记；幂等重放不产生第二条（调用过 ≠ 改过）', async () => {
  const { byName, audit, exec } = setupE2E()
  const a = await byName.get('remember').execute({ text: '# 证据' }, exec)
  const b = await byName.get('remember').execute({ text: '# 结论' }, exec)
  audit.length = 0
  const first = await byName.get('memory_link').execute(
    { type: 'supports', from: a.id, to: b.id, provenance: 'measured' },
    exec,
  )
  const second = await byName.get('memory_link').execute(
    { type: 'supports', from: a.id, to: b.id, provenance: 'measured' },
    exec,
  )
  assert.equal(first.created, true)
  assert.equal(second.created, false)
  const links = audit.filter((r) => r.action === 'link')
  assert.equal(links.length, 1, '幂等命中没有改变任何东西 ⇒ 不许记成第二次变更')
  assert.equal(links[0].code, '+supports')
})

test('E5 权限拒绝被记录：roles 启用 + 空间白名单 ⇒ 未标注空间的条目被拒并留痕', async () => {
  const { byName, audit, exec } = setupE2E({ config: ROLE_CONFIG })
  await byName.get('remember').execute({ text: '# 未标注空间' }, exec)
  audit.length = 0
  const result = await byName.get('recall').execute({ query: '未标注空间' }, exec)
  assert.equal(result.results.length, 0, '该条必须被空间白名单 fail-closed 挡下')
  const rejects = audit.filter((r) => r.action === 'permission')
  assert.equal(rejects.length, 1)
  assert.equal(rejects[0].outcome, 'rejected')
  assert.equal(rejects[0].code, 'R2-space', '拒因必须可读——这是「哪条策略在工作」的读数')
  assert.ok(rejects[0].target.count >= 1)
  assert.equal(rejects[0].tool, 'recall')
})

test('E6 **正常路径不记**（配对判据）：roles 未启用时 recall 不产生任何 permission 记录', async () => {
  const { byName, audit, exec } = setupE2E()
  await byName.get('remember').execute({ text: '# 正常条目' }, exec)
  audit.length = 0
  await byName.get('recall').execute({ query: '正常条目' }, exec)
  assert.equal(audit.filter((r) => r.action === 'permission').length, 0, '放行不缺省记账——否则审计流会变成洪水')
})

test('E7 memory_trail 三态之一：**未接线** ⇒ wired=false（不是 total=0）', async () => {
  const { byName, exec } = setupE2E({ readAudit: false })
  const value = await byName.get('memory_trail').execute({}, exec)
  assert.equal(value.wired, false, '「没接线」与「零事件」必须可区分')
  assert.equal(value.total, 0)
})

test('E8 memory_trail 三态之二：已接线但零事件 ⇒ wired=true 且 total=0（**不是零违规**）', async () => {
  const { byName, exec } = setupE2E()
  const value = await byName.get('memory_trail').execute({}, exec)
  assert.equal(value.wired, true)
  assert.equal(value.total, 0)
  assert.deepEqual(value.records, [])
  const text = byName.get('memory_trail').output.render({}, value).map((part) => part.text).join('\n')
  assert.match(text, /还没有任何事件/, '渲染必须把「零事件」说清，否则读者会读成「一切正常」')
})

test('E9 memory_trail 三态之三：有事件时汇总、筛选与簇都对得上', async () => {
  const { byName, audit, exec } = setupE2E()
  await byName.get('remember').execute({ text: '# 一' }, exec)
  await byName.get('remember').execute({ text: '# 二' }, exec)
  const value = await byName.get('memory_trail').execute({ action: 'write' }, exec)
  assert.equal(value.wired, true)
  assert.equal(value.total, 2, '汇总吃全量')
  assert.equal(value.filteredTotal, 2, '筛选也只筛 action=write')
  assert.equal(value.shown, 2)
  assert.equal(value.writes, 2)
  assert.match(value.records[0].actor, /会话 /, '渲染行必须带操作者——「谁干的」出错时这是唯一的读入口')
  assert.ok(value.records[0].at.length > 0)
  // 未知 action 必须 fail-loud（拼错当场报，不静默返回空）
  await assert.rejects(() => byName.get('memory_trail').execute({ action: 'delete' }, exec), /must be one of/)
})

test('E10 memory_trail 的 output.schema 与 execute 返回键对齐（宿主 additionalProperties:false 会整条拒收）', async () => {
  const { byName, exec } = setupE2E()
  const tool = byName.get('memory_trail')
  const props = Object.keys(tool.output.schema.properties)
  const value = await tool.execute({}, exec)
  for (const key of Object.keys(value)) {
    assert.ok(props.includes(key), `返回键 ${key} 不在 schema 里 ⇒ 宿主会整条拒收工具结果`)
  }
  for (const [key, spec] of Object.entries(tool.output.schema.properties)) {
    if (spec.required === true) assert.ok(key in value, `schema 要求 ${key} 但返回里没有`)
  }
})

test('E11 memory_stats 的 audit 块同守三态（与 trail 共用一条纪律，不是两套说法）', async () => {
  const { byName, exec } = setupE2E()
  const value = await byName.get('memory_stats').execute({}, exec)
  assert.equal(value.audit.wired, true)
  assert.equal(value.audit.total, 0)
  const text = byName.get('memory_stats').output.render({}, value).map((part) => part.text).join('\n')
  assert.match(text, /审计流/, '审计读数必须出现在体检入口，否则它永远没人看')
  // 未接线变体
  const off = setupE2E({ readAudit: false })
  const offValue = await off.byName.get('memory_stats').execute({}, off.exec)
  assert.equal(offValue.audit.wired, false)
})

test('E12 审计未接线时工具照常工作（吞错纪律：审计失败不许让写入失败）', async () => {
  const { byName, exec } = setupE2E({ recordAudit: false })
  const created = await byName.get('remember').execute({ text: '# 无审计' }, exec)
  assert.equal(typeof created.id, 'string', '没有审计回调也必须能写入——审计是旁证，不是前置条件')
})

test('A10 ★文件不存在 ⇒ **已接线零事件**（不是「未接线」）：首次部署不该永远报「读不到」', async () => {
  const missing = await readActorAudit('C:\definitely\not\here\memory-actor-audit.jsonl')
  assert.notEqual(missing, undefined, 'ENOENT 是「还没有事件」，不是「读不到」——两者混同会让新装的插件永远显示未接线')
  assert.equal(missing.summary.total, 0)
  assert.deepEqual(missing.records, [])
})

test('A11 ★操作者短 id 必须可辨识：剥掉共通前缀再截（线上验证当场抓到的缺陷）', () => {
  const a = 'session-cc8272d8-5195-4a34-a683-455cf5f12671'
  const b = 'session-aaaaaaaa-0000-0000-0000-000000000000'
  assert.notEqual(shortActorId(a), shortActorId(b),
    '两个不同会话渲染成同一个串（「session-」）⇒「谁干的」不可查，而那正是这份流唯一的用途')
  assert.equal(shortActorId(a), 'cc8272d8…')
  assert.equal(shortActorId('short'), 'short', '无前缀且短 ⇒ 原样，不硬加省略号')
})
