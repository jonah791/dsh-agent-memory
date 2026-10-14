/**
 * 主体层单测（v0.13.0「关于谁的」维度）——subject.ts 纯函数 + 工具层行为。
 * 运行：npm test（node --test "tests/*.test.mjs"，导入编译产物 lib/*.js）
 *
 * 覆盖（对应 docs/semantic.md §7 的 A85–A94）：
 *   A85 归一（容错路径）认规范值与别名；A86 参数路径 fail-loud（两条路径分流）；
 *   A87 过滤零拷贝（未给参数 = 同一数组引用）；A88 过滤生效；
 *   A89 计数三档；A90 标签与渲染标记（通用层留空）；
 *   A91 写路径盖章；A92 合并/key 覆盖不静默转移；A93 update 显式转移三态（设置/清除/不动）；
 *   A94 端到端（recall 过滤 + 非法参数 + 存量兼容 + stats 分档）。
 *
 * 本文件刻意复用「v0.4 形状配置字面量」作配置 ⇒ 顺带覆盖
 * 「历史配置对象（无新字段）不崩」这条硬约束。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore } from '../lib/store.js'
import { createMemoryTools } from '../lib/tools.js'
import { workspaceIdOf } from '../lib/scope.js'
import {
  SUBJECTS,
  UNSPECIFIED_SUBJECT,
  countBySubject,
  filterBySubject,
  isSubject,
  normalizeSubject,
  parseSubjectArg,
  subjectLabel,
  subjectTag,
} from '../lib/subject.js'

// ---------- 测试基建（与 role.test.mjs 同形） ----------

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

// ⚠ 双平台夹具纪律：WID 必须由**被测的派生函数**算出（硬编码路径在 WSL 下作用域不匹配）
const CWD = 'C:\\Users\\Alice\\proj'
const WID = workspaceIdOf(CWD)

/** v0.4 形状的配置（**没有 subjects/roles 段**）——历史字面量的活样本，顺带验兼容 */
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

function setup(config = LEGACY_CONFIG) {
  const kv = new MemoryKv()
  const store = new MemoryStore(kv)
  const tools = createMemoryTools({ store, loadConfig: async () => config })
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  return { kv, store, byName }
}

function execOf({ sessionId = 'session-11111111-2222-3333-4444-555555555555', cwd = CWD } = {}) {
  return {
    agent: { session: { id: sessionId, header: { cwd, id: sessionId } } },
    signal: new AbortController().signal,
  }
}

const EXEC = execOf()

/** 直接塞条目（绕过 remember 时用它显式控制 subject） */
async function seed(store, { scope = WID, kind = 'knowledge', title, subject }) {
  return store.remember({
    kind,
    title,
    body: `${title} 的正文`,
    tags: [],
    scope,
    level: null,
    bucket: null,
    ...(subject !== undefined ? { subject } : {}),
  })
}

/** 从工具返回值里取模型可见文本（render 的产物） */
function renderText(tool, args, value) {
  const blocks = tool.output.render(args, value)
  return blocks.map((block) => block.text).join('\n')
}

// ---------- A85 归一（容错路径） ----------

test('A85 normalizeSubject：认规范值与常见别名；空/未知/非字符串 → undefined（通用）', () => {
  for (const value of SUBJECTS) assert.equal(normalizeSubject(value), value)
  assert.equal(normalizeSubject('SELF'), 'self', '大小写不敏感')
  assert.equal(normalizeSubject('  master  '), 'master', '去首尾空白')
  assert.equal(normalizeSubject('我'), 'self', '中文别名')
  assert.equal(normalizeSubject('主人'), 'master')
  assert.equal(normalizeSubject('owner'), 'master')
  // 认不出/空/非字符串 ⇒ 通用（容错：不抛错，因为读历史数据不该让检索崩）
  assert.equal(normalizeSubject('bogus'), undefined)
  assert.equal(normalizeSubject(''), undefined)
  assert.equal(normalizeSubject('   '), undefined)
  assert.equal(normalizeSubject(undefined), undefined)
  assert.equal(normalizeSubject(null), undefined)
  assert.equal(normalizeSubject(42), undefined)
  assert.equal(normalizeSubject({}), undefined)
})

test('A85b 别名表刻意做得短：有歧义的写法**不认**（认不出好过静默错标）', () => {
  // user 在代码里普遍指消息角色 user/assistant；你/me 语义依赖上下文
  assert.equal(normalizeSubject('user'), undefined)
  assert.equal(normalizeSubject('你'), undefined)
  assert.equal(normalizeSubject('me'), undefined)
})

test('A85c isSubject 是严格判定（不归一）', () => {
  assert.equal(isSubject('self'), true)
  assert.equal(isSubject('master'), true)
  assert.equal(isSubject('我'), false, '别名不是规范值')
  assert.equal(isSubject('SELF'), false)
  assert.equal(isSubject(undefined), false)
})

// ---------- A86 参数路径 fail-loud（与容错路径分流） ----------

test('A86 parseSubjectArg：合法值通过、空值 → undefined、非法值**抛错**（不静默降级）', () => {
  assert.equal(parseSubjectArg('self'), 'self')
  assert.equal(parseSubjectArg(' 主人 '), 'master', '参数路径也宽容别名')
  assert.equal(parseSubjectArg(undefined), undefined)
  assert.equal(parseSubjectArg(''), undefined)
  assert.equal(parseSubjectArg('   '), undefined)
  // 关键：拼错必须当场知道——静默当通用 = 我以为标上了、其实没标
  assert.throws(() => parseSubjectArg('bogus'), /未知取值/)
  assert.throws(() => parseSubjectArg('user'), /未知取值/)
  assert.throws(() => parseSubjectArg(42), /必须是字符串/)
  assert.throws(() => parseSubjectArg('bogus', 'remember.subject'), /remember\.subject/, '报错带字段名')
})

// ---------- A87 过滤零拷贝（向后兼容硬判据） ----------

test('A87 filterBySubject：未给 subject → **同一数组引用**（零拷贝零过滤）', () => {
  const entries = [
    { kind: 'knowledge', subject: 'self' },
    { kind: 'knowledge', subject: 'master' },
    { kind: 'knowledge' },
  ]
  assert.equal(filterBySubject(entries, undefined), entries, '必须原样返回同一引用')
})

test('A88 filterBySubject：给了 subject 只返回匹配项；通用条目**不**匹配', () => {
  const entries = [
    { kind: 'knowledge', subject: 'self' },
    { kind: 'knowledge', subject: 'master' },
    { kind: 'knowledge' },
  ]
  assert.deepEqual(filterBySubject(entries, 'self').map((e) => e.subject), ['self'])
  assert.deepEqual(filterBySubject(entries, 'master').map((e) => e.subject), ['master'])
  assert.notEqual(filterBySubject(entries, 'self'), entries, '给了参数必须返回新数组')
})

// ---------- A89 计数 ----------

test('A89 countBySubject：三档计数（self / master / unspecified），非法值归 unspecified', () => {
  const counts = countBySubject([
    { subject: 'self' },
    { subject: 'self' },
    { subject: 'master' },
    { subject: undefined },
    { subject: 'bogus' },
  ])
  assert.equal(counts.self, 2)
  assert.equal(counts.master, 1)
  assert.equal(counts[UNSPECIFIED_SUBJECT], 2, '非法值计入通用（读历史数据不崩）')
})

// ---------- A90 标签与渲染 ----------

test('A90 subjectLabel / subjectTag：通用层**留空**（标记要挑着打）', () => {
  assert.equal(subjectLabel('self'), '自我')
  assert.equal(subjectLabel('master'), '主人')
  assert.equal(subjectLabel(undefined), '通用')
  assert.equal(subjectTag('self'), '[自我]')
  assert.equal(subjectTag('master'), '[主人]')
  assert.equal(subjectTag(undefined), '', '通用层留空——否则会淹没真正该被看见的两条')
})

// ---------- A91 写路径盖章 ----------

test('A91 remember 带 subject → 落库条目带 subject；不带 → 字段不存在（不是 undefined）', async () => {
  const { store, byName } = setup()
  const remember = byName.get('remember')

  const tagged = await remember.execute({ text: '关于主人的一条偏好', subject: 'master' }, EXEC)
  const taggedEntry = store.get(WID, tagged.id)
  assert.equal(taggedEntry.subject, 'master')

  const plain = await remember.execute({ text: '一条通用技术知识' }, EXEC)
  const plainEntry = store.get(WID, plain.id)
  assert.equal(plainEntry.subject, undefined)
  assert.equal(Object.hasOwn(plainEntry, 'subject'), false, '通用条目不应留下 subject 键（一个真源）')
})

test('A91b remember 别名归一（主人 → master）；非法值 fail-loud 且**不落库**', async () => {
  const { store, byName } = setup()
  const remember = byName.get('remember')
  const viaAlias = await remember.execute({ text: '主人喜欢简洁的汇报', subject: ' 主人 ' }, EXEC)
  assert.equal(store.get(WID, viaAlias.id).subject, 'master')

  const before = store.list(WID).length
  await assert.rejects(
    () => remember.execute({ text: '这条不该被写进去', subject: 'bogus' }, EXEC),
    /未知取值/,
  )
  assert.equal(store.list(WID).length, before, '非法参数必须整笔拒绝，不留半成品')
})

// ---------- A92 不静默转移 ----------

test('A92 同标题合并 / key 覆盖**不**转移 subject（新建才盖章）', async () => {
  const { store, byName } = setup()
  const remember = byName.get('remember')
  const first = await remember.execute({ text: '同标题的条目', subject: 'self', kind: 'knowledge' }, EXEC)
  const second = await remember.execute({ text: '同标题的条目', subject: 'master', kind: 'knowledge' }, EXEC)
  assert.equal(second.id, first.id, '同标题走合并')
  assert.equal(store.get(WID, first.id).subject, 'self', '合并不得静默改标注')

  const k1 = await remember.execute({ text: '带 key 的条目', key: 'k1', kind: 'fact', subject: 'self' }, EXEC)
  const k2 = await remember.execute({ text: '带 key 的条目（覆盖）', key: 'k1', kind: 'fact', subject: 'master' }, EXEC)
  assert.equal(k2.action, 'updated')
  assert.equal(store.get(WID, k1.id).subject, 'self', 'key 覆盖同样不得转移')
})

// ---------- A93 update 显式转移三态 ----------

test('A93 update subject 三态：给值=设置 / 空串=清除 / 缺省=不动', async () => {
  const { store, byName } = setup()
  const remember = byName.get('remember')
  const update = byName.get('update')

  const { id } = await remember.execute({ text: '待标注的存量记忆', kind: 'knowledge' }, EXEC)
  assert.equal(store.get(WID, id).subject, undefined)

  await update.execute({ id, subject: 'master' }, EXEC)
  assert.equal(store.get(WID, id).subject, 'master', '① 给值 = 设置（存量补标注的唯一入口）')

  await update.execute({ id, tags: ['x'] }, EXEC)
  assert.equal(store.get(WID, id).subject, 'master', '② 缺省 = 不动（反对静默转移）')

  await update.execute({ id, subject: '' }, EXEC)
  const cleared = store.get(WID, id)
  assert.equal(cleared.subject, undefined, '③ 空串 = 清除回通用')
  assert.equal(Object.hasOwn(cleared, 'subject'), false, '清除必须是删键，不是置 undefined（一个真源）')

  await assert.rejects(() => update.execute({ id, subject: 'bogus' }, EXEC), /未知取值/)
})

// ---------- A94 端到端 ----------

test('A94 recall 按 subject 过滤（自层/主层各只回自己；缺省回全部）', async () => {
  const { store, byName } = setup()
  await seed(store, { title: '我的判断失误记录', subject: 'self' })
  await seed(store, { title: '主人偏好简洁汇报', subject: 'master' })
  await seed(store, { title: 'tsc 编译产物路径', subject: undefined })

  const recall = byName.get('recall')
  const all = await recall.execute({ limit: 50 }, EXEC)
  const self = await recall.execute({ subject: 'self', limit: 50 }, EXEC)
  const master = await recall.execute({ subject: 'master', limit: 50 }, EXEC)

  assert.equal(all.total, 3, '缺省不过滤：三层都回')
  assert.equal(self.total, 1)
  assert.equal(self.results[0].title, '我的判断失误记录')
  assert.equal(master.total, 1)
  assert.equal(master.results[0].title, '主人偏好简洁汇报')
  // 结果项带 subject 字段（渲染层要用它打标记）
  assert.equal(self.results[0].subject, 'self')
  assert.equal(all.results.find((r) => r.title === 'tsc 编译产物路径').subject, undefined)
})

test('A94b recall / memory_browse 非法 subject → fail-loud', async () => {
  const { store, byName } = setup()
  await seed(store, { title: '任意条目' })
  await assert.rejects(() => byName.get('recall').execute({ subject: 'bogus' }, EXEC), /未知取值/)
  await assert.rejects(() => byName.get('memory_browse').execute({ subject: 'bogus' }, EXEC), /未知取值/)
})

test('A94c 渲染：带标注的命中显示 [自我]/[主人]，通用条目**不显示**标记', async () => {
  const { store, byName } = setup()
  await seed(store, { title: '关于主人的事', subject: 'master' })
  await seed(store, { title: '通用技术知识' })

  const recall = byName.get('recall')
  const result = await recall.execute({ limit: 50 }, EXEC)
  const text = renderText(recall, { limit: 50 }, result)

  assert.ok(text.includes('[主人][knowledge@'), `带标注的应显示标记，实际：${text}`)
  assert.ok(text.includes('] 关于主人的事'), '标记之后标题照常渲染')
  assert.ok(!text.includes('[通用]'), '通用层不得显示标记——否则淹没真正该被看见的')
  assert.ok(text.includes('\n- [knowledge@'), '通用条目行首无标记（渲染结构不变）')
})

test('A94d memory_stats 分档：bySubject 与总数自洽（口径同体）', async () => {
  const { store, byName } = setup()
  await seed(store, { title: '自我条目一', subject: 'self' })
  await seed(store, { title: '自我条目二', subject: 'self' })
  await seed(store, { title: '主人条目', subject: 'master' })
  await seed(store, { title: '通用条目' })

  const stats = await byName.get('memory_stats').execute({}, EXEC)
  const sum = stats.bySubject.self + stats.bySubject.master + stats.bySubject[UNSPECIFIED_SUBJECT]
  assert.equal(sum, stats.total, '分档之和必须等于总数（否则读数层会制造新的疑问）')
  assert.equal(stats.bySubject.self, 2)
  assert.equal(stats.bySubject.master, 1)
  assert.equal(stats.bySubject[UNSPECIFIED_SUBJECT], 1)
})

test('A94e 存量兼容（尸体样本）：全部无 subject 的库，行为与加维度前逐项一致', async () => {
  const { store, byName } = setup()
  for (let i = 0; i < 5; i += 1) await seed(store, { title: `历史条目 ${i}` })

  const recall = byName.get('recall')
  const plain = await recall.execute({ limit: 50 }, EXEC)
  assert.equal(plain.total, 5, '未给 subject 时不过滤任何条目')

  const stats = await byName.get('memory_stats').execute({}, EXEC)
  assert.equal(stats.bySubject[UNSPECIFIED_SUBJECT], stats.total, '存量全归通用层')
  assert.equal(stats.bySubject.self, 0)
  assert.equal(stats.bySubject.master, 0)
})
