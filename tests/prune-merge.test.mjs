/**
 * v0.9 遗忘与修改闭环单测（`forget` 批量/分档 · `update` 三模式 · `memory_merge`）。
 * 运行：npm test（node --test "tests/*.test.mjs"，导入编译产物 lib/*.js）
 *
 * 覆盖（docs/semantic.md §7 的 A68–A77）：
 *   A68 applyTextMode 三模式；A69 patch 唯一性（未命中/多命中 fail loud）；
 *   A70 selectForgetTargets 去重/已归档剔除/截断；A71 pushRevision 只留最近 3 条；
 *   A72 forget 单条零回归（字段 + 文案逐字）；A73 批量 dryRun 不写库；
 *   A74 tier=ARCHIVE 走体检、tier=KEEP 被拒（尸体样本）、未知 tier 报错；
 *   A75 单条未命中仍抛错；A76 memory_merge 追加带来源 + 被并入者归档 + 跳过分支；
 *   A77 update append/patch 真写库并落 revisions（失败改写不留痕）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore } from '../lib/store.js'
import {
  MAX_REVISIONS,
  applyTextMode,
  countOccurrences,
  createMemoryTools,
  pushRevision,
  selectForgetTargets,
} from '../lib/tools.js'
import { DEFAULT_AUDIT_CONFIG } from '../lib/audit.js'
import { DEFAULT_CONFIG } from '../lib/config.js'
import { workspaceIdOf } from '../lib/scope.js'

// ---------- 测试基建（与 audit.test.mjs 同款；双平台纪律见技能 dsh-plugin-testability） ----------

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

const CWD = 'C:\\Users\\Alice\\proj'
const WID = workspaceIdOf(CWD)
const NOW = Date.parse('2026-09-17T12:00:00.000Z')
const DAY = 86_400_000

/** 固定时钟的条目夹具（不经过 store，直接构造） */
function entry(partial = {}) {
  const created = partial.createdAt ?? new Date(NOW - 3 * DAY).toISOString()
  return {
    id: partial.id ?? Math.random().toString(36).slice(2),
    kind: 'knowledge',
    title: partial.title ?? '条目',
    body: partial.body ?? '正文',
    tags: partial.tags ?? [],
    scope: partial.scope ?? WID,
    createdAt: created,
    updatedAt: partial.updatedAt ?? created,
    accessedAt: partial.accessedAt ?? partial.updatedAt ?? created,
    level: null,
    bucket: null,
    archived: false,
    ...partial,
  }
}

/** 造一条「N 天前」的条目（体检的 ARCHIVE 判据吃 updatedAt 年龄） */
function aged(days, partial = {}) {
  const iso = new Date(NOW - days * DAY).toISOString()
  return entry({ createdAt: iso, updatedAt: iso, accessedAt: iso, ...partial })
}

const CONFIG = { ...DEFAULT_CONFIG, audit: DEFAULT_AUDIT_CONFIG }

function setup(config = CONFIG) {
  const kv = new MemoryKv()
  const store = new MemoryStore(kv)
  const tools = createMemoryTools({ store, loadConfig: async () => config })
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const exec = {
    agent: {
      session: {
        id: 'session-11111111-2222-3333-4444-555555555555',
        header: { id: 'session-11111111-2222-3333-4444-555555555555', cwd: CWD },
      },
    },
    signal: new AbortController().signal,
  }
  return { kv, store, tools, byName, exec }
}

/** 把条目直接塞进 kv（绕过 remember，保留 archived/source 原样） */
function seedRaw(kv, entries) {
  for (const e of entries) kv.map.set(`${e.scope}:${e.kind}:${e.id}`, { ...e })
}

// ---------- A68 / A69 纯函数：文本改写模式 ----------

test('A68 applyTextMode：replace / append / patch 三模式', () => {
  const base = { title: '标题', body: '第一段\n第二段' }
  // 既有语义（splitText，v0.8 起）：title = 首行，body = **全文**（正文保留 markdown，检索不丢内容）
  assert.deepEqual(applyTextMode(base, { mode: 'replace', text: '新标题\n新正文' }), { title: '新标题', body: '新标题\n新正文' })
  assert.deepEqual(applyTextMode(base, { mode: 'append', text: '追加段' }), { title: '标题', body: '第一段\n第二段\n\n追加段' })
  assert.deepEqual(applyTextMode(base, { mode: 'patch', find: '第一段', replace: '首段' }), { title: '标题', body: '首段\n第二段' })
  // 正文不中则退到标题
  assert.deepEqual(applyTextMode(base, { mode: 'patch', find: '标题', replace: '新题' }), { title: '新题', body: '第一段\n第二段' })
})

test('A69 patch 唯一性判据：未命中 / 多命中 / 空 find 一律 fail loud', () => {
  assert.equal(countOccurrences('aaaa', 'aa'), 2, '非重叠计数')
  assert.equal(countOccurrences('abc', ''), 0)
  assert.throws(
    () => applyTextMode({ title: 't', body: 'a b a' }, { mode: 'patch', find: 'a', replace: 'x' }),
    /匹配到 2 处/,
  )
  assert.throws(
    () => applyTextMode({ title: 't', body: 'zzz' }, { mode: 'patch', find: 'nope', replace: 'x' }),
    /未命中 find/,
  )
  assert.throws(
    () => applyTextMode({ title: 't', body: 'zzz' }, { mode: 'patch', find: '', replace: 'x' }),
    /必须提供非空 find/,
  )
  assert.throws(
    () => applyTextMode({ title: 't', body: 'zzz' }, { mode: 'append', text: '   ' }),
    /需要非空 text/,
  )
})

// ---------- A70 / A71 纯函数：目标选择与修订留痕 ----------

test('A70 selectForgetTargets：去重 / 已归档剔除 / 截断计数', () => {
  const alive = aged(60, { id: 'a1' })
  const archived = aged(60, { id: 'a2', archived: true })
  const r = selectForgetTargets([alive, archived], ['a1', 'a1', 'a2', 'missing', 'a1'], 10)
  assert.deepEqual(r.targets.map((e) => e.id), ['a1'])
  assert.equal(r.skipped, 4, '1 重复 + 1 已归档 + 1 不存在 + 1 重复')
  assert.equal(r.truncated, 0)
  const r2 = selectForgetTargets([alive], ['a1'], 0)
  assert.equal(r2.targets.length, 0)
  assert.equal(r2.truncated, 1)
})

test('A71 pushRevision：只留最近 MAX_REVISIONS 条（旧→新）', () => {
  let cur = { title: 'v0', body: 'b0', revisions: [] }
  for (let i = 1; i <= 5; i += 1) {
    cur = { title: `v${i}`, body: `b${i}`, revisions: pushRevision(cur, 'replace') }
  }
  assert.equal(cur.revisions.length, MAX_REVISIONS)
  assert.deepEqual(cur.revisions.map((r) => r.prevTitle), ['v2', 'v3', 'v4'])
  assert.ok(cur.revisions.every((r) => r.mode === 'replace'))
})

// ---------- A72 / A73 / A74 / A75 工具层：forget ----------

test('A72 forget 单条模式零回归：id 回填 + archived=true + 旧文案逐字', async () => {
  const { kv, byName, exec } = setup()
  seedRaw(kv, [aged(60, { id: 'old-1', title: '旧知识' })])
  const forget = byName.get('forget')
  const value = await forget.execute({ id: 'old-1', reason: '测试归档' }, exec)
  assert.equal(value.id, 'old-1')
  assert.equal(value.archived, true)
  assert.equal(value.archivedCount, 1)
  assert.deepEqual(value.ids, ['old-1'])
  assert.equal(value.dryRun, false)
  assert.equal(forget.output.render({ id: 'old-1' }, value)[0].text, '已归档记忆条目 old-1')
  const stored = kv.map.get(`${WID}:knowledge:old-1`)
  assert.equal(stored.archived, true)
  assert.equal(stored.source.reason, '测试归档')
})

test('A73 forget 批量：dryRun 不写库，去掉后真归档并自动记 reason', async () => {
  const { kv, store, byName, exec } = setup()
  seedRaw(kv, [aged(60, { id: 'b1' }), aged(60, { id: 'b2' }), aged(60, { id: 'b3' })])
  const forget = byName.get('forget')
  const preview = await forget.execute({ ids: ['b1', 'b2'], dryRun: true }, exec)
  assert.equal(preview.archived, false)
  assert.equal(preview.dryRun, true)
  assert.deepEqual(preview.ids, ['b1', 'b2'])
  assert.equal(preview.archivedCount, 0)
  assert.equal(store.list(WID).length, 3, 'dryRun 不得写库')
  const capped = await forget.execute({ ids: ['b1', 'b2', 'b3'], max: 1, dryRun: true }, exec)
  assert.equal(capped.ids.length, 1)
  assert.equal(capped.truncated, 2, '超上限须如实回报截断数')
  const real = await forget.execute({ ids: ['b1', 'b2'] }, exec)
  assert.equal(real.archivedCount, 2)
  assert.equal(real.dryRun, false)
  assert.equal(store.list(WID).length, 1)
  assert.equal(kv.map.get(`${WID}:knowledge:b1`).source.reason, 'forget: bulk（2 条）')
})

test('A74 forget tier：ARCHIVE 走体检；KEEP 被拒；未知 tier 报错（尸体样本）', async () => {
  const { kv, byName, exec } = setup()
  seedRaw(kv, [
    aged(60, { id: 'arch-1', title: '未被引用的旧知识一' }),
    aged(61, { id: 'arch-2', title: '未被引用的旧知识二' }),
  ])
  const forget = byName.get('forget')
  const preview = await forget.execute({ tier: 'ARCHIVE', dryRun: true, max: 10 }, exec)
  assert.equal(preview.dryRun, true)
  assert.ok(preview.ids.includes('arch-1'), `期望体检判 arch-1 为 ARCHIVE，实际 ${JSON.stringify(preview.ids)}`)
  assert.ok(preview.notes.some((n) => n.startsWith('tier=ARCHIVE')), '须回报体检命中数')
  await assert.rejects(() => forget.execute({ tier: 'KEEP', dryRun: true }, exec), /KEEP 是承重档/)
  await assert.rejects(() => forget.execute({ tier: 'NOPE', dryRun: true }, exec), /未知 tier/)
})

test('A75 forget 单条未命中 / 无选择器仍抛错（保持 v0.8 语义）', async () => {
  const { byName, exec } = setup()
  const forget = byName.get('forget')
  await assert.rejects(() => forget.execute({ id: 'nope' }, exec), /未找到 id="nope"/)
  await assert.rejects(() => forget.execute({}, exec), /需要 id \/ ids \/ tier/)
})

// ---------- A76 工具层：memory_merge ----------

test('A76 memory_merge：正文追加带来源 + 被并入者归档 + 跳过分支', async () => {
  const { kv, store, byName, exec } = setup()
  seedRaw(kv, [
    aged(3, { id: 'canon', title: '主条目', body: '主正文' }),
    aged(3, { id: 'dup-1', title: '重复甲', body: '重复正文甲' }),
    aged(3, { id: 'dup-2', title: '重复乙', body: '重复正文乙' }),
  ])
  const merge = byName.get('memory_merge')
  const value = await merge.execute({ canonical: 'canon', ids: ['dup-1', 'dup-1', 'dup-2', 'canon', 'ghost'] }, exec)
  assert.equal(value.merged, 2)
  assert.deepEqual(value.archived, ['dup-1', 'dup-2'])
  assert.ok(value.charsAdded > 0)
  const canon = kv.map.get(`${WID}:knowledge:canon`)
  assert.ok(canon.body.includes('主正文'))
  assert.ok(canon.body.includes('## 合并自 dup-1（重复甲）'))
  assert.ok(canon.body.includes('重复正文甲'), '被并入者正文不得丢失')
  assert.equal(canon.revisions.length, 1)
  assert.equal(canon.revisions[0].prevBody, '主正文')
  assert.equal(kv.map.get(`${WID}:knowledge:dup-1`).archived, true)
  assert.equal(kv.map.get(`${WID}:knowledge:dup-1`).source.reason, 'merged into canon')
  assert.ok(value.notes.some((n) => n.includes('canonical 自身')))
  assert.ok(value.notes.some((n) => n.includes('列表内重复')))
  assert.ok(value.notes.some((n) => n.includes('视野内不存在')))
  assert.equal(store.list(WID).length, 1)
  // 尸体样本：canonical 不存在 / 已归档 一律拒绝
  await assert.rejects(() => merge.execute({ canonical: 'ghost', ids: ['dup-1'] }, exec), /未找到 canonical/)
})

// ---------- A77 工具层：update 三模式 ----------

test('A77 update append/patch 真写库并落 revisions（失败改写不留痕）', async () => {
  const { kv, byName, exec } = setup()
  seedRaw(kv, [aged(3, { id: 'u1', title: '标题一', body: '正文一' })])
  const update = byName.get('update')
  await update.execute({ id: 'u1', mode: 'append', text: '追加行' }, exec)
  let stored = kv.map.get(`${WID}:knowledge:u1`)
  assert.equal(stored.body, '正文一\n\n追加行')
  assert.equal(stored.title, '标题一')
  assert.equal(stored.revisions.length, 1)
  assert.equal(stored.revisions[0].prevBody, '正文一')

  await update.execute({ id: 'u1', mode: 'patch', find: '追加行', replace: '改后行' }, exec)
  stored = kv.map.get(`${WID}:knowledge:u1`)
  assert.equal(stored.body, '正文一\n\n改后行')
  assert.equal(stored.revisions.length, 2)
  assert.equal(stored.revisions[1].prevBody, '正文一\n\n追加行')

  await assert.rejects(() => update.execute({ id: 'u1', mode: 'patch', find: '不存在的片段' }, exec), /未命中 find/)
  assert.equal(kv.map.get(`${WID}:knowledge:u1`).revisions.length, 2, '失败改写不得留痕')
  await assert.rejects(() => update.execute({ id: 'u1', mode: 'append', text: '  ' }, exec), /需要非空 text/)
  await assert.rejects(() => update.execute({ id: 'u1', mode: 'nope', text: 'x' }, exec), /未知 mode/)

  await update.execute({ id: 'u1', text: '新标题\n新正文' }, exec)
  stored = kv.map.get(`${WID}:knowledge:u1`)
  assert.equal(stored.title, '新标题')
  assert.equal(stored.body, '新标题\n新正文', 'replace 沿用既有语义：body = 全文')
  assert.equal(stored.revisions.length, 3)
})
