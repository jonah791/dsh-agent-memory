/**
 * 执行位置维（v0.23.0）离线单测。
 *
 * 判据分四组，各自防一种不同的失败：
 *   A. 纯函数 —— 归一 / 校验 / 过滤 / 标记（防「形状判断错」）
 *   B. **零拷贝** —— 未给参数时必须返回**同一数组引用**（防「结果看起来一样」的假绿）
 *   C. 存储端到端 —— 写进去、读回来、字段仍在（防「写入边界静默剥字段」）
 *   D. 级联与尸体样本 —— 清 project 连带清 taskId；无该字段的存量条目行为逐项不变
 *
 * 运行：npm test（先 tsc 再 node --test tests/）
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import {
  executionTag,
  filterByExecution,
  MAX_EXECUTION_ID_LENGTH,
  normalizeProject,
  normalizeTaskRef,
  parseExecutionArgs,
  parseExecutionId,
  countByProject,
  UNSPECIFIED_PROJECT,
} from '../lib/execution.js'
import { MemoryStore } from '../lib/store.js'

/** 内存 mock kv（与 store.test.mjs 同形状，独立一份以免跨文件耦合） */
class MemoryKv {
  constructor() {
    this.map = new Map()
  }
  get(key) {
    return this.map.get(key)
  }
  async put(key, value) {
    this.map.set(key, value)
  }
  async delete(key) {
    const existed = this.map.has(key)
    this.map.delete(key)
    return existed
  }
  entries() {
    return this.map.entries()
  }
  get size() {
    return this.map.size
  }
}

const SCOPE = 'w:test'

function newStore() {
  return new MemoryStore(new MemoryKv())
}

/** 建一条最小条目（默认不带执行位置） */
async function seed(store, title, extra = {}) {
  const r = await store.remember({
    kind: 'knowledge',
    title,
    body: `${title} 的正文`,
    tags: [],
    scope: SCOPE,
    level: null,
    bucket: null,
    ...extra,
  })
  return r.id
}

// ────────────────────────────── A. 纯函数 ──────────────────────────────

describe('execution.normalizeProject（容错路径）', () => {
  test('正常值原样保留（只 trim）', () => {
    assert.equal(normalizeProject('alice'), 'alice')
    assert.equal(normalizeProject('  pp  '), 'pp')
  })

  test('**不做大小写折叠**：PP 与 pp 是两个项目（调用方定义的标识）', () => {
    assert.equal(normalizeProject('PP'), 'PP')
    assert.notEqual(normalizeProject('PP'), normalizeProject('pp'))
  })

  test('空 / 非字符串 / 超长 / 控制字符 ⇒ undefined（认不出就是不设，绝不猜）', () => {
    assert.equal(normalizeProject(''), undefined)
    assert.equal(normalizeProject('   '), undefined)
    assert.equal(normalizeProject(undefined), undefined)
    assert.equal(normalizeProject(null), undefined)
    assert.equal(normalizeProject(42), undefined)
    assert.equal(normalizeProject('x'.repeat(MAX_EXECUTION_ID_LENGTH + 1)), undefined)
    assert.equal(normalizeProject('a\nb'), undefined)
    assert.equal(normalizeProject('a\u0000b'), undefined)
  })

  test('恰好等于上限是合法的（边界闭区间）', () => {
    const id = 'x'.repeat(MAX_EXECUTION_ID_LENGTH)
    assert.equal(normalizeProject(id), id)
  })

  test('taskId 与 project 形状规则相同', () => {
    assert.equal(normalizeTaskRef('ps-4a2b'), 'ps-4a2b')
    assert.equal(normalizeTaskRef(''), undefined)
  })
})

describe('execution.parseExecutionId（参数路径 · fail-loud）', () => {
  test('超长抛错（而不是静默当通用）', () => {
    assert.throws(
      () => parseExecutionId('x'.repeat(MAX_EXECUTION_ID_LENGTH + 1), 'remember.project'),
      /过长/,
    )
  })

  test('控制字符抛错', () => {
    assert.throws(() => parseExecutionId('a\nb', 'remember.project'), /控制字符/)
  })

  test('非字符串抛错', () => {
    assert.throws(() => parseExecutionId(42, 'remember.project'), /必须是字符串/)
  })

  test('空串 = 清除语义（返回 undefined 而非抛错）', () => {
    assert.equal(parseExecutionId('', 'update.project'), undefined)
    assert.equal(parseExecutionId('   ', 'update.project'), undefined)
  })
})

describe('execution.parseExecutionArgs（两级不可拆）', () => {
  test('两级都给 ⇒ 都返回', () => {
    const r = parseExecutionArgs({ project: 'alice', taskId: 'ps-1' }, 'remember')
    assert.deepEqual(r, { project: 'alice', taskId: 'ps-1' })
  })

  test('只给 project ⇒ 合法', () => {
    assert.deepEqual(parseExecutionArgs({ project: 'alice' }, 'remember'), { project: 'alice' })
  })

  test('**只给 taskId ⇒ 抛错**（任务 id 只在项目内唯一，单给二义）', () => {
    assert.throws(
      () => parseExecutionArgs({ taskId: 'ps-1' }, 'remember'),
      /必须同时给.*project/,
    )
  })

  test('都不给 ⇒ 空对象（不过滤）', () => {
    assert.deepEqual(parseExecutionArgs({}, 'remember'), {})
  })
})

describe('execution.filterByExecution', () => {
  const entries = [
    { id: '1', project: 'alice', taskId: 'ps-1' },
    { id: '2', project: 'alice', taskId: 'ps-2' },
    { id: '3', project: 'pp' },
    { id: '4' },
  ]

  test('★ 零拷贝：空条件返回**同一数组引用**（不是「看起来一样」）', () => {
    assert.equal(filterByExecution(entries, {}), entries)
    // 只给 taskId（容错路径）：无 project 无法定位 ⇒ 退回不过滤，同样零拷贝
    assert.equal(filterByExecution(entries, { taskId: 'ps-1' }), entries)
  })

  test('只给 project ⇒ 该项目全部（含其下所有任务）', () => {
    const got = filterByExecution(entries, { project: 'alice' })
    assert.deepEqual(got.map((e) => e.id), ['1', '2'])
  })

  test('project + taskId ⇒ 精确到任务', () => {
    const got = filterByExecution(entries, { project: 'alice', taskId: 'ps-2' })
    assert.deepEqual(got.map((e) => e.id), ['2'])
  })

  test('不匹配 ⇒ 空数组（不是全部）', () => {
    assert.deepEqual(filterByExecution(entries, { project: 'nope' }), [])
  })
})

describe('execution.executionTag', () => {
  test('只有 project ⇒ [项目:alice]', () => {
    assert.equal(executionTag('alice', undefined), '[项目:alice]')
  })

  test('两级都有 ⇒ [项目:alice/ps-1]', () => {
    assert.equal(executionTag('alice', 'ps-1'), '[项目:alice/ps-1]')
  })

  test('通用层 ⇒ 空串（标记要挑着打）', () => {
    assert.equal(executionTag(undefined, undefined), '')
    assert.equal(executionTag('', undefined), '')
  })

  test('★ 有 taskId 无 project ⇒ 整条丢弃（无项目的任务 id 渲染出来会被读成项目名）', () => {
    assert.equal(executionTag(undefined, 'ps-1'), '')
  })
})

describe('execution.countByProject', () => {
  test('按条数降序，unspecified 恒置末位', () => {
    const counts = countByProject([
      { project: 'pp' },
      { project: 'alice' },
      { project: 'alice' },
      {},
      {},
      {},
    ])
    assert.deepEqual(Object.keys(counts), ['alice', 'pp', UNSPECIFIED_PROJECT])
    assert.equal(counts.alice, 2)
    assert.equal(counts[UNSPECIFIED_PROJECT], 3)
  })
})

// ───────────────────── B. 存储端到端（存活判据） ─────────────────────

describe('store：执行位置的写入与存活', () => {
  test('★ 写入 project + taskId ⇒ 读回仍在（端到端存活）', async () => {
    const store = newStore()
    const id = await seed(store, '带执行位置', { project: 'alice', taskId: 'ps-1' })
    const back = store.get(SCOPE, id)
    assert.equal(back.project, 'alice')
    assert.equal(back.taskId, 'ps-1')
  })

  test('★ 只给 taskId ⇒ **taskId 不落盘**（两级不可拆，悬空指针不写入）', async () => {
    const store = newStore()
    const id = await seed(store, '只有任务 id', { taskId: 'ps-1' })
    const back = store.get(SCOPE, id)
    assert.equal(back.taskId, undefined)
    assert.equal('taskId' in back, false)
  })

  test('只给 project ⇒ taskId 键不存在（不是 undefined 占位）', async () => {
    const store = newStore()
    const id = await seed(store, '只有项目', { project: 'alice' })
    const back = store.get(SCOPE, id)
    assert.equal(back.project, 'alice')
    assert.equal('taskId' in back, false)
  })
})

// ───────────────────── C. 级联与尸体样本 ─────────────────────

describe('store.update：显式清除与级联', () => {
  test('★ 清 project ⇒ 连带清 taskId（不留悬空指针）', async () => {
    const store = newStore()
    const id = await seed(store, '待清除', { project: 'alice', taskId: 'ps-1' })
    const updated = await store.update(SCOPE, id, { project: null })
    assert.equal(updated.project, undefined)
    assert.equal(updated.taskId, undefined)
    assert.equal('project' in updated, false)
    assert.equal('taskId' in updated, false)
  })

  test('★ 清除是**删键**，不是置 undefined（否则「字段存在但为空」成第二个真源）', async () => {
    const store = newStore()
    const id = await seed(store, '待清 taskId', { project: 'alice', taskId: 'ps-1' })
    const updated = await store.update(SCOPE, id, { taskId: null })
    assert.equal('taskId' in updated, false)
    // project 不动
    assert.equal(updated.project, 'alice')
  })

  test('显式设置 taskId（条目已有 project 时）⇒ 生效', async () => {
    const store = newStore()
    const id = await seed(store, '补任务 id', { project: 'alice' })
    const updated = await store.update(SCOPE, id, { taskId: 'ps-9' })
    assert.equal(updated.taskId, 'ps-9')
  })

  test('尸体样本：无执行位置的存量条目 update 后**仍无这两个键**（逐项不变）', async () => {
    const store = newStore()
    const id = await seed(store, '存量条目')
    const before = store.get(SCOPE, id)
    assert.equal('project' in before, false)
    assert.equal('taskId' in before, false)
    const after = await store.update(SCOPE, id, { tags: ['x'] })
    assert.equal('project' in after, false)
    assert.equal('taskId' in after, false)
    assert.deepEqual(after.tags, ['x'])
  })

  test('合并路径（同标题）不覆盖原项目的标注（只在新建时盖章）', async () => {
    const store = newStore()
    const first = await seed(store, '同标题条目', { project: 'alice' })
    const merged = await store.remember({
      kind: 'knowledge',
      title: '同标题条目',
      body: '第二段正文',
      tags: [],
      scope: SCOPE,
      level: null,
      bucket: null,
      project: 'pp',
    })
    assert.equal(merged.action, 'merged')
    const back = store.get(SCOPE, first)
    assert.equal(back.project, 'alice', '合并路径应保留先到者（防静默转移归属）')
  })
})
