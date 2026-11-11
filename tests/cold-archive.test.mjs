/**
 * 冷存档（压缩检查点）不参与活跃检索（2026-11-12）
 *
 * **为什么需要这条判据**（读数来自真实库，不是设想）：
 * 库里 179 条「会话压缩检查点」占全库 **27.2%**（172.6 万字符 / 634 万），平均 9641 字符、
 * 最长一条 11.7 万。它们落库时是**活跃**条目（`remember` 恒置 `archived:false`），
 * 要等时间桶摘要跑过才归档 ⇒ 中间存在**窗口期**，而窗口期内它们以「容器」形态参与检索：
 * 整段会话摘要包含几乎所有查询词，词命中累加即最高分。
 *
 * **实测**（2026-11-12 01:53，唯一未归档的那条 26980 字）：
 * - 查「否定判据 或式外面 仪器读数 假差值」→ 它排 **第 1**（49.5，第 2 名 40.4 的 1.23 倍）
 * - 查「读数器在说谎 仪器 bug 判据」→ 第 2
 * - 查「压缩 checkpoint 存档」→ 第 2
 * 而它不含任何可用判据，只是「今晚压缩过」的凭证；一次命中就是 25KB 噪音进上下文。
 *
 * **同一问题 2026-10-27 已记过一次**（package.json v0.17 条目：「十万字符的压缩 checkpoint
 * 容器会挤掉真正相关的短条目」），当时修法是 BM25 长度归一，v0.18 经样本外验证证明是
 * **净损失**并退役（-5.7 个百分点，18:3）。所以这次不走「调权重」，走**分类**：
 * 它不是「相关但排得太前」，它是**根本不该进候选**。
 *
 * **判据形状**：落库时盖 `COLD_CHECKPOINT_TAG` → `store.list()`（一切不带
 * `includeArchive` 的读取路径）把它当冷存档跳过。归档后的条目本来就被 `archived` 挡住，
 * 两个判据**互补、无缝隙**。
 *
 * **回查能力不变**（这条是设计约束，不是巧合）：
 * - `get(scope, id)` 不经 `list`（按 id 直接取）⇒ 通知里给的 entryId 永远读得到
 * - `list(scope, { includeArchive: true })` 仍返回它 ⇒ recall/memory_browse 带参可检
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore, COLD_CHECKPOINT_TAG } from '../lib/store.js'

/** 内存 mock kv：满足 KvLike 全接口 */
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

const SCOPE = 'e:/alice'

/** 造一条检查点（形状同 compaction-sink 落库：episodic + 日粒度标题 + 两个标签） */
async function seedCheckpoint(store, { title = '会话压缩检查点 · 2026-11-12 UTC+08:00', tags } = {}) {
  return store.remember({
    kind: 'episodic',
    title,
    body: '> 压缩于 2026-11-12 01:52\n\n' + 'x'.repeat(2000),
    tags: tags ?? ['compaction', COLD_CHECKPOINT_TAG],
    scope: SCOPE,
    level: null,
    bucket: null,
  })
}

describe('冷存档：压缩检查点不进活跃检索', () => {
  test('尸体样本：带冷标签的条目不出现在 list(scope)（旧实现必红——它会被返回）', async () => {
    const store = new MemoryStore(new MemoryKv())
    await store.remember({
      kind: 'knowledge',
      title: '一条普通知识',
      body: '正文',
      tags: [],
      scope: SCOPE,
    })
    await seedCheckpoint(store)

    const active = store.list(SCOPE)
    assert.equal(active.length, 1, '活跃视图应只有普通条目')
    assert.equal(active[0].title, '一条普通知识')
    assert.ok(
      !active.some((e) => e.tags.includes(COLD_CHECKPOINT_TAG)),
      '带冷标签的条目不得出现在活跃视图',
    )
  })

  test('includeArchive 仍能取到：冷存档被藏起、没有被删', async () => {
    const store = new MemoryStore(new MemoryKv())
    const r = await seedCheckpoint(store)

    const all = store.list(SCOPE, { includeArchive: true })
    assert.equal(all.length, 1)
    assert.equal(all[0].id, r.id)
    assert.equal(all[0].archived, false, '它是冷存档，但不是 archived——两件事不同')
  })

  test('get() 按 id 不受影响：通知里给的 entryId 永远读得到', async () => {
    const store = new MemoryStore(new MemoryKv())
    const r = await seedCheckpoint(store)

    const entry = store.get(SCOPE, r.id)
    assert.ok(entry !== undefined, 'get 不经 list，冷存档照样可取')
    assert.ok(entry.body.includes('压缩于'))
  })

  test('回归面：普通条目（无冷标签）照常出现在活跃视图', async () => {
    const store = new MemoryStore(new MemoryKv())
    for (let i = 0; i < 3; i += 1) {
      await store.remember({
        kind: 'knowledge',
        title: `普通条目 ${i}`,
        body: '正文',
        tags: ['compaction'], // 只有 compaction 标签、没有冷标签 ⇒ 不算冷存档
        scope: SCOPE,
      })
    }
    assert.equal(store.list(SCOPE).length, 3, '仅带 compaction 标签不足以判为冷存档')
  })

  test('边界：无 tags 字段的条目不会崩（冷判据必须容忍缺字段）', async () => {
    const store = new MemoryStore(new MemoryKv())
    await store.remember({ kind: 'knowledge', title: '无标签条目', body: '正文', scope: SCOPE })
    const active = store.list(SCOPE)
    assert.equal(active.length, 1)
    assert.deepEqual(active[0].tags, [])
  })

  test('标签位置无关：冷标签排在 tags 任意位置都算', async () => {
    const store = new MemoryStore(new MemoryKv())
    await seedCheckpoint(store, { tags: ['compaction', 'x', COLD_CHECKPOINT_TAG, 'y'] })
    assert.equal(store.list(SCOPE).length, 0, 'tags 里任一处命中冷标签即视为冷存档')
    assert.equal(store.list(SCOPE, { includeArchive: true }).length, 1)
  })
})
