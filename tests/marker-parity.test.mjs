/**
 * 标记一致性（v0.50 · 方案 §16.2「每种记忆应当采用不同的调用规则」）· 判据
 *
 * ## 为什么需要这一层
 *
 * `provenance`（外部/自推）与 `lifecycle`（存疑）两个维度的标记**早就存在**，
 * 但它们只接在 `recall` / `memory_browse` 的渲染一侧（`tools.ts`），两条注入路径
 * （`auto-inject` 每消息注入 / `inject` 会话速览）**从来没有打过**。
 *
 * 后果不是「少了个装饰」：速览与自动注入是**我最先看到、也最常看到**的文本，
 * 而「存疑信息不该被当作确定事实说出来」这条方案要求的调用规则，在注入面
 * 此前**没有任何标记可依**——`lifecycle.ts` 的表格写着 disputed「可注入 / ❓存疑」，
 * 实际只在工具侧生效。
 *
 * ## 判据形状：成对
 *
 * 单测一侧（只测注入有标记）证明不了「一致」——两边各自演进就会漂。
 * 所以每条判据都**同时取两条路径的渲染结果**再断言：同一批条目，
 * `recall` 的 render 输出与注入文本必须给出**同一组标记**。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MemoryStore } from '../lib/store.js'
import { createMemoryTools } from '../lib/tools.js'
import { DEFAULT_CONFIG } from '../lib/config.js'
import { workspaceIdOf } from '../lib/scope.js'
import { buildAutoRecallDigest } from '../lib/auto-inject.js'
import { buildMemoryDigest } from '../lib/inject.js'

const CWD = 'C:\\Users\\Alice\\proj'
const WID = workspaceIdOf(CWD)

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

function setup() {
  const kv = new MemoryKv()
  const store = new MemoryStore(kv)
  const tools = createMemoryTools({ store, loadConfig: async () => DEFAULT_CONFIG })
  const exec = {
    agent: {
      session: {
        id: 'session-11111111-2222-3333-4444-555555555555',
        header: { id: 'session-11111111-2222-3333-4444-555555555555', cwd: CWD },
      },
    },
    signal: new AbortController().signal,
  }
  return { kv, byName: new Map(tools.map((t) => [t.name, t])), exec }
}

function entry(partial) {
  const at = partial.createdAt ?? '2026-11-01T00:00:00.000Z'
  return {
    kind: 'knowledge',
    tags: [],
    body: '',
    scope: WID,
    title: partial.title ?? '标记一致性样本',
    createdAt: at,
    updatedAt: at,
    accessedAt: at,
    level: null,
    bucket: null,
    archived: false,
    ...partial,
  }
}

/**
 * ⚠ **夹具纪律（2026-11-19 尸体验证抓出来的）**：title / body 一律用**中性样本名**
 * （「标记一致性样本甲」这类），**绝不许含被断言的子串**（存疑 / 外部 / 自推）。
 * 第一版把「存疑样本」写进了标题，于是删掉标记代码后断言照样通过——
 * 判据的观测面与夹具字面重合，等于对标记恒真、无分辨力。
 * 这条与 v0.49 的「夹具里没有未知 kind」同族：**夹具要让缺陷有显形的机会**。
 */

/** 走 recall 渲染（真实工具 render，不是复刻逻辑） */
async function recallText(byName, exec, query) {
  const tool = byName.get('recall')
  const value = await tool.execute({ query, limit: 10 }, exec)
  const blocks = tool.output.render({ query }, value)
  return blocks.map((b) => b.text ?? '').join('\n')
}

/** 走自动注入渲染（每条主人消息都跑的那条路径） */
function injectText(entries, query) {
  return buildAutoRecallDigest(entries, query, { maxEntries: 5, maxBytes: 3000 })
}

/** 走会话速览渲染（每个会话最先看到的那条路径） */
function digestText(entries) {
  return buildMemoryDigest([], entries, { maxBytes: 4000, maxEntries: 30 })
}

// ---------- M 段 ----------

test('M1 存疑条目：两条注入路径都打 ❓存疑，与 recall 侧一致', async () => {
  const { kv, byName, exec } = setup()
  const e = entry({ id: 'd1', title: '标记一致性样本甲', status: 'disputed', body: '标记一致性样本甲' })
  await kv.put(`${e.scope}:${e.kind}:${e.id}`, e)

  const recall = await recallText(byName, exec, '标记一致性')
  assert.match(recall, /存疑/, 'recall 侧应当有存疑标记（既有行为）')

  const auto = injectText([e], '标记一致性')
  assert.match(auto, /存疑/, '自动注入侧缺存疑标记——这是 v0.50 补的那一处')

  const boot = digestText([e])
  assert.match(boot, /存疑/, '会话速览侧缺存疑标记')
})

test('M2 外部来源（provenance=web）：两条注入路径都打 [外部]', async () => {
  const { kv, byName, exec } = setup()
  const e = entry({ id: 'w1', title: '标记一致性样本乙', provenance: 'web', body: '标记一致性样本乙' })
  await kv.put(`${e.scope}:${e.kind}:${e.id}`, e)

  const recall = await recallText(byName, exec, '标记一致性')
  assert.match(recall, /外部/, 'recall 侧应当有外部标记（既有行为）')
  assert.match(injectText([e], '标记一致性'), /外部/, '自动注入侧缺外部标记')
  assert.match(digestText([e]), /外部/, '会话速览侧缺外部标记')
})

test('M3 自推来源（provenance=self）：两条注入路径都打 [自推]', async () => {
  const { kv, byName, exec } = setup()
  const e = entry({ id: 's1', title: '标记一致性样本丙', provenance: 'self', body: '标记一致性样本丙' })
  await kv.put(`${e.scope}:${e.kind}:${e.id}`, e)

  const recall = await recallText(byName, exec, '标记一致性')
  assert.match(recall, /自推/, 'recall 侧应当有自推标记')
  assert.match(injectText([e], '标记一致性'), /自推/, '自动注入侧缺自推标记')
  assert.match(digestText([e]), /自推/, '会话速览侧缺自推标记')
})

test('M4 零误伤：master / measured / 未标注 三条路径都不打来源标记', async () => {
  const cases = [
    entry({ id: 'm1', title: '标记一致性样本丁', provenance: 'master', body: '标记一致性样本丁' }),
    entry({ id: 'm2', title: '标记一致性样本戊', provenance: 'measured', body: '标记一致性样本戊' }),
    entry({ id: 'm3', title: '标记一致性样本己', body: '标记一致性样本己' }),
  ]
  const { kv, byName, exec } = setup()
  for (const e of cases) await kv.put(`${e.scope}:${e.kind}:${e.id}`, e)

  const recall = await recallText(byName, exec, '标记一致性')
  assert.equal(/\[外部\]|\[自推\]/.test(recall), false, 'recall 侧不该给硬来源打标')

  for (const e of cases) {
    const auto = injectText([e], '标记一致性')
    assert.equal(/\[外部\]|\[自推\]/.test(auto), false, `自动注入侧误伤：${e.title}`)
    const boot = digestText([e])
    assert.equal(/\[外部\]|\[自推\]/.test(boot), false, `会话速览侧误伤：${e.title}`)
  }
})

test('M5 成对一致：同一条「存疑 + 外部」条目，两处标记同时出现且互不吞掉', async () => {
  const { kv, byName, exec } = setup()
  const e = entry({
    id: 'both1',
    title: '标记一致性样本庚',
    status: 'disputed',
    provenance: 'web',
    body: '标记一致性样本庚',
  })
  await kv.put(`${e.scope}:${e.kind}:${e.id}`, e)

  const auto = injectText([e], '标记一致性')
  const boot = digestText([e])
  for (const [name, text] of [['自动注入', auto], ['会话速览', boot]]) {
    assert.match(text, /存疑/, `${name}缺存疑标记`)
    assert.match(text, /外部/, `${name}缺外部标记`)
  }
  // 顺序：存疑在前（更硬的状态），外部随后——与 recall 侧的拼接顺序同族
  assert.ok(auto.indexOf('存疑') < auto.indexOf('外部'), '标记顺序应为 存疑 → 外部')
})
