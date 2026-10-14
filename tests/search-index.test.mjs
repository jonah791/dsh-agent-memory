/**
 * 倒排索引等价性测试（2026-10-13 性能改造）
 *
 * **这个文件的存在理由**：索引只被允许改变「谁被遍历」，**不允许改变任何结果**。
 * 故这里做两件事：
 *   ① 等价性——同一批 fixture，索引版与「全库遍历」参照实现逐字段比对；
 *   ② 尸体样本——构造三类「若收窄判据写错就会静默丢结果」的条目，证明判据真的会拦（不是恒绿）。
 *
 * 参照实现（referenceRelatedOf）是**改造前的旧代码逐字复制**，作为 oracle。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { relatedOf, relateClosure } from '../lib/search.js'

let seq = 0
/** 造一个最小 Entry（只填 relatedOf 用得到的字段） */
function mk (over) {
  seq += 1
  const id = over.id ?? `id-${seq}`
  return {
    id,
    kind: over.kind ?? 'knowledge',
    title: over.title ?? `标题 ${id}`,
    body: over.body ?? '',
    tags: over.tags ?? [],
    scope: over.scope ?? 'e:/alice',
    createdAt: over.createdAt ?? '2026-10-13T00:00:00.000Z',
    updatedAt: over.updatedAt ?? '2026-10-13T00:00:00.000Z',
    accessedAt: over.accessedAt ?? '2026-10-13T00:00:00.000Z',
    level: over.level ?? null,
    bucket: over.bucket ?? null,
    archived: over.archived ?? false,
  }
}

// ---------- 参照实现：改造前的 relatedOf（oracle） ----------
const STOP = new Set(['的', '了', '是', '在'])
function cleanForGram (t) { return t.toLowerCase().replace(/\s+/g, '') }
function ngrams (t) {
  const c = cleanForGram(t)
  if (c.length < 2) return c.length === 1 ? [c] : []
  const out = []
  for (let i = 0; i < c.length - 1; i++) out.push(c.slice(i, i + 2))
  return out
}
function referenceRelatedOf (entries, target, limit = 3, includeArchive = false) {
  const targetTitleGrams = ngrams(target.title)
  const out = []
  for (const other of entries) {
    if (other.id === target.id) continue
    if (!includeArchive && other.archived) continue
    let sharedTags = 0
    for (const tag of other.tags) if (target.tags.includes(tag)) sharedTags += 1
    let titleOverlap = 0, bodyOverlap = 0
    const tCl = cleanForGram(other.title), bCl = cleanForGram(other.body)
    const tSet = new Set(); for (let i = 0; i < tCl.length - 1; i++) tSet.add(tCl.slice(i, i + 2))
    const bSet = new Set(); for (let i = 0; i < bCl.length - 1; i++) bSet.add(bCl.slice(i, i + 2))
    for (const g of targetTitleGrams) {
      const two = g.length === 2
      const inTitle = two ? tSet.has(g) : tCl.includes(g)
      if (inTitle) titleOverlap += 1
      else if (two ? bSet.has(g) : bCl.includes(g)) bodyOverlap += 1
    }
    const strength = sharedTags * 3 + titleOverlap * 2 + bodyOverlap * 1
    if (strength > 0) out.push({ id: other.id, kind: other.kind, title: other.title, scope: other.scope, sharedTags, strength })
  }
  out.sort((a, b) => b.strength - a.strength)
  return out.slice(0, limit)
}

// ============ ① 等价性 ============
test('等价性：随机语料上索引版与参照实现逐字段一致（200 条 · 20 个目标）', () => {
  const words = ['记忆', '检索', '性能', '插件', '向量', '索引', '压缩', '停摆', '设计', '思路', '改造', '测试', '判据', '证据', '主人', '指令']
  const rnd = (n) => Math.floor(Math.random() * n)
  const entries = []
  for (let i = 0; i < 200; i++) {
    const t = []
    const tl = 2 + rnd(4)
    for (let j = 0; j < tl; j++) t.push(words[rnd(words.length)])
    const tags = []
    const gl = rnd(3)
    for (let j = 0; j < gl; j++) tags.push(words[rnd(words.length)])
    entries.push(mk({ title: t.join(''), body: words[rnd(words.length)] + words[rnd(words.length)], tags, archived: rnd(8) === 0 }))
  }
  let compared = 0
  for (const target of entries.slice(0, 20)) {
    const got = relatedOf(entries, target, 5, false)
    const want = referenceRelatedOf(entries, target, 5, false)
    assert.deepEqual(got, want, `目标 ${target.id} 结果不一致`)
    compared += 1
  }
  assert.equal(compared, 20)
})

test('等价性：includeArchive=true 时逐字段一致（不启用收窄）', () => {
  const entries = [
    mk({ id: 'a', title: '记忆检索', tags: ['x'] }),
    mk({ id: 'b', title: '记忆压缩', tags: ['x'], archived: true }),
    mk({ id: 'c', title: '无关条目', tags: [] }),
  ]
  const target = entries[0]
  assert.deepEqual(relatedOf(entries, target, 5, true), referenceRelatedOf(entries, target, 5, true))
})

// ============ ② 尸体样本（证明判据会拦，不是恒绿） ============
test('尸体①：**仅靠共享标签**得分的条目必须出现在结果里（若只按 gram 收窄就会丢）', () => {
  // ⚠ 夹具纪律（本测试第一版踩过）：两个标题必须**没有任何共同的 2-gram**，
  // 否则 titleOverlap 也会贡献分数、就不是"仅靠标签"了。
  // 首版用「完全不同的标题甲 / 截然无关的标题乙」——两者共享 `的标` 与 `标题`
  // ⇒ strength = 3(标签) + 2×2(标题) = 7，断言 3 失败。**是夹具错，不是实现错**
  //（同用例里与 oracle 的 deepEqual 当时已通过）。
  // 现用「阿尔法记忆体 / 贝塔压缩器」：gram 集合 {阿尔,尔法,法记,记忆,忆体} 与
  // {贝塔,塔压,压缩,缩器} 交集为空 ⇒ strength 只可能来自 sharedTags。
  const target = mk({ id: 't', title: '阿尔法记忆体', tags: ['证据'] })
  const corpse = mk({ id: 'c', title: '贝塔压缩器', tags: ['证据'] })
  const entries = [target, corpse]
  const got = relatedOf(entries, target, 5, false)
  const hit = got.find((r) => r.id === 'c')
  assert.ok(hit, '共享标签的条目被静默丢弃了——收窄判据漏了 tag 路径')
  assert.equal(hit.sharedTags, 1)
  assert.equal(hit.strength, 3, 'strength 应恰为 3（纯标签贡献）；若不是，夹具的 gram 交集不为空')
  // 与 oracle 对齐
  assert.deepEqual(got, referenceRelatedOf(entries, target, 5, false))
})

test('尸体②：**仅靠正文 gram** 得分的条目必须出现（若只查标题表就会丢）', () => {
  const target = mk({ id: 't', title: '索引性能', tags: [] })
  const corpse = mk({ id: 'c', title: '别的什么', body: '这里提到 索引 这个词' })
  const entries = [target, corpse]
  const got = relatedOf(entries, target, 5, false)
  assert.ok(got.find((r) => r.id === 'c'), '正文 gram 命中的条目被丢了——索引漏建了正文 gram')
  assert.deepEqual(got, referenceRelatedOf(entries, target, 5, false))
})

test('尸体③：**strength 恒为 0** 的条目必须被排除（证明收窄没有放水成全量）', () => {
  const target = mk({ id: 't', title: '甲甲甲', tags: ['a'] })
  const unrelated = mk({ id: 'u', title: '乙乙乙', body: '丙丙丙', tags: ['b'] })
  const entries = [target, unrelated]
  const got = relatedOf(entries, target, 5, false)
  assert.equal(got.length, 0, '无关条目被错误收进结果')
  assert.deepEqual(got, referenceRelatedOf(entries, target, 5, false))
})

test('尸体④：归档条目在 includeArchive=false 时不出现（索引建表已排除，须验证没漏判）', () => {
  const target = mk({ id: 't', title: '记忆索引', tags: [] })
  const archived = mk({ id: 'ar', title: '记忆索引续', archived: true })
  const entries = [target, archived]
  const got = relatedOf(entries, target, 5, false)
  assert.ok(!got.find((r) => r.id === 'ar'), '归档条目漏进了结果')
  assert.deepEqual(got, referenceRelatedOf(entries, target, 5, false))
})

test('退化：目标标题为单字符（无 len-2 gram）且无标签 ⇒ 回退全库路径，结果与 oracle 一致', () => {
  const target = mk({ id: 't', title: '甲', tags: [] })
  const other = mk({ id: 'o', title: '甲', tags: [] })
  const entries = [target, other]
  const got = relatedOf(entries, target, 5, false)
  assert.deepEqual(got, referenceRelatedOf(entries, target, 5, false))
})

test('缓存失效：换一个新数组（不同引用）后结果仍正确', () => {
  const target = mk({ id: 't', title: '记忆检索', tags: [] })
  const a = mk({ id: 'a', title: '记忆检索方法' })
  const first = relatedOf([target, a], target, 5, false)
  const b = mk({ id: 'b', title: '记忆检索系统' })
  const second = relatedOf([target, b], target, 5, false)
  assert.ok(first.find((r) => r.id === 'a'))
  assert.ok(second.find((r) => r.id === 'b'))
  assert.ok(!second.find((r) => r.id === 'a'), '新数组里不该出现旧数组的条目')
})

test('relateClosure：多跳闭包与逐跳 oracle 一致（byId 映射不改变结果）', () => {
  const e1 = mk({ id: 'e1', title: '记忆检索' })
  const e2 = mk({ id: 'e2', title: '记忆检索优化' })
  const e3 = mk({ id: 'e3', title: '记忆检索优化实践' })
  const entries = [e1, e2, e3]
  const got = relateClosure(entries, e1, 2, 3, false)
  // 逐跳展开的参照：hop1 = relatedOf(e1)，hop2 = 对 hop1 每个节点再取 relatedOf
  const hop1 = referenceRelatedOf(entries, e1, 3, false)
  const want = []
  const visited = new Set(['e1'])
  for (const n of hop1) { if (!visited.has(n.id)) { visited.add(n.id); want.push({ ...n, hop: 1 }) } }
  const hop2 = []
  for (const n of hop1) {
    const cur = entries.find((e) => e.id === n.id)
    for (const m of referenceRelatedOf(entries, cur, 3, false)) {
      if (!visited.has(m.id)) { visited.add(m.id); hop2.push({ ...m, hop: 2 }) }
    }
  }
  const allWant = [...want, ...hop2].sort((a, b) => (a.hop !== b.hop ? a.hop - b.hop : b.strength - a.strength))
  assert.deepEqual(got, allWant)
})
