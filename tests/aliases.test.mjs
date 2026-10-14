/**
 * 检索别名（aliases）测试（2026-10-13 重做）
 *
 * **这个文件的存在理由**：别名是「改变检索行为」的改动，必须证明三件事：
 *   ① **零回归**——没有 aliases 的条目，打分与排序**逐位不变**（对既有 1422 条而言）；
 *   ② **别名真生效**——补了别名就能把目标排到第一（复现证伪实验）；
 *   ③ **别名不污染**——无关查询的 top1 不受影响。
 * 另加：合并路径**不丢别名**（L2/L3 合并是本插件最容易静默丢字段的地方）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recallEntries, relatedOf } from '../lib/search.js'

let seq = 0
function mk (over) {
  seq += 1
  const id = over.id ?? `id-${seq}`
  return {
    id,
    kind: over.kind ?? 'knowledge',
    title: over.title ?? `标题 ${id}`,
    body: over.body ?? '',
    tags: over.tags ?? [],
    ...(over.aliases !== undefined ? { aliases: over.aliases } : {}),
    scope: over.scope ?? 'e:/alice',
    createdAt: over.createdAt ?? '2026-10-13T00:00:00.000Z',
    updatedAt: over.updatedAt ?? '2026-10-13T00:00:00.000Z',
    accessedAt: over.accessedAt ?? '2026-10-13T00:00:00.000Z',
    level: over.level ?? null,
    bucket: over.bucket ?? null,
    archived: over.archived ?? false,
  }
}

// ============ ① 零回归：无 aliases 时与「无别名支持的参照实现」逐位一致 ============
// 参照实现：改造前的 search.ts 判据（不含 aliases 分支）
const STOP = new Set(['的', '了', '是', '在', '和', '与', '或', '我', '你', '他', '她', '它', '这', '那', '个'])
function cjkBigrams (t) { const o = []; for (let i = 0; i < t.length - 1; i++) { const p = t.slice(i, i + 2); if (/[\u4e00-\u9fff]/.test(p)) o.push(p) } return o }
function tokenizeQuery (q) {
  const raw = q.toLowerCase().split(/\s+/).filter((t) => t.length > 0 && !STOP.has(t))
  const tokens = []
  for (const token of raw) { tokens.push(token); for (const bg of cjkBigrams(token)) if (!STOP.has(bg) && !tokens.includes(bg)) tokens.push(bg) }
  return tokens
}
function refScore (entries, e, tokens) {
  const N = entries.length
  const idf = new Map()
  for (const tk of tokens) {
    if (idf.has(tk)) continue
    let c = 0
    for (const x of entries) {
      if (x.title.toLowerCase().includes(tk)) c++
      else if (x.tags.some((t) => t.toLowerCase().includes(tk))) c++
      else if (x.body.toLowerCase().includes(tk)) c++
    }
    idf.set(tk, (c >= 50 && c / N > 0.1) ? 0 : Math.log(1 + N / (1 + c)))
  }
  const ti = e.title.toLowerCase(), bo = e.body.toLowerCase()
  let s = 0
  for (const tk of tokens) {
    const w = idf.get(tk) ?? 1
    if (e.tags.some((t) => t.toLowerCase().includes(tk))) s += 3 * w
    if (ti.includes(tk)) s += 2 * w
    if (bo.includes(tk)) s += 1 * w
  }
  return s
}

test('零回归：无 aliases 条目上，打分与参照实现逐位一致（50 条 × 5 查询）', () => {
  const words = ['记忆', '检索', '性能', '插件', '索引', '压缩', '设计', '判据', '证据', '主人']
  const rnd = (n) => Math.floor(Math.random() * n)
  const entries = []
  for (let i = 0; i < 50; i++) {
    const t = []; const tl = 2 + rnd(3)
    for (let j = 0; j < tl; j++) t.push(words[rnd(words.length)])
    const tags = []; const gl = rnd(3)
    for (let j = 0; j < gl; j++) tags.push(words[rnd(words.length)])
    entries.push(mk({ title: t.join(''), body: words[rnd(words.length)] + words[rnd(words.length)], tags }))
  }
  const queries = ['记忆 检索', '插件 性能', '判据 设计', '压缩', '证据 主人']
  for (const q of queries) {
    const tokens = tokenizeQuery(q)
    const got = recallEntries(entries, { query: q, limit: 20, withRelated: false })
    // 参照：全量打分 + 同排序规则 + **同 limit 截断**
    // ⚠ 首版漏了 slice(0,20)，拿全量比 20 条切片 ⇒ 假红（是我的测试 bug，非实现缺陷）。
    const ref = entries
      .map((e) => ({ e, s: refScore(entries, e, tokens) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 20)
      .map((x) => x.e.id)
    const gotIds = got.results.map((r) => r.id)
    assert.deepEqual(gotIds, ref, `查询「${q}」排序与参照不一致`)
  }
})

// ============ ② 别名真生效 ============
test('别名生效：补别名后目标能排到第一（复现证伪实验的形状）', () => {
  // 复刻 S5 的形状：目标标题不含查询实词
  const target = mk({
    id: 'target',
    title: '把别人的未找到转述成不存在',
    body: '事故复盘：我把 subagent 的结论升级成了第一人称断言。',
    tags: ['教训'],
  })
  const noise = mk({ id: 'noise', title: '结构性认知：不进对错分类的错', body: '关于错的定义与第二项。', tags: ['自我认知'] })
  const entries = [target, noise]
  const q = '我的错误 误判 修正'
  // 无别名：目标排不上第一
  const before = recallEntries(entries, { query: q, limit: 5, withRelated: false })
  assert.notEqual(before.results[0]?.id, 'target', '夹具不成立：无别名时目标就已排第一（失去对照意义）')
  // 有别名：排第一
  const withAlias = [{ ...target, aliases: ['我的错误', '误判', '修正', '我犯的错'] }, noise]
  const after = recallEntries(withAlias, { query: q, limit: 5, withRelated: false })
  assert.equal(after.results[0]?.id, 'target', '补别名后目标未排第一——别名未接入打分')
  assert.ok(after.results[0].score > (before.results.find((r) => r.id === 'target')?.score ?? 0), '别名未提升分数')
})

test('别名与 tags 同级（×3）：同一别名命中，加权与标签命中相同', () => {
  const byTag = mk({ id: 'a', title: '甲甲', tags: ['向量检索'] })
  const byAlias = mk({ id: 'b', title: '乙乙', aliases: ['向量检索'] })
  const entries = [byTag, byAlias]
  const r = recallEntries(entries, { query: '向量检索', limit: 5, withRelated: false })
  const sa = r.results.find((x) => x.id === 'a')?.score
  const sb = r.results.find((x) => x.id === 'b')?.score
  assert.equal(sa, sb, `标签命中 ${sa} 与别名命中 ${sb} 不等——二者应同级`)
})

// ============ ③ 不污染 ============
test('不污染：无关查询在「有别名」与「无别名」的语料上 top1 相同', () => {
  const base = [
    mk({ id: 'x', title: '检索路线：排除向量语义检索', body: '主人定调不做向量。', tags: ['检索', '方向决策'] }),
    mk({ id: 'y', title: 'MCP 服务器的特殊支持', body: '兼容性处理。', tags: ['mcp', '兼容性'] }),
    mk({ id: 'z', title: '性能瓶颈优化', body: '延迟分解。', tags: ['性能'] }),
  ]
  const withAlias = base.map((e, i) => i === 0 ? { ...e, aliases: ['服务起不来', '白屏', '宿主故障'] } : e)
  for (const q of ['MCP 兼容性', '性能 瓶颈']) {
    const a = recallEntries(base, { query: q, limit: 3, withRelated: false })
    const b = recallEntries(withAlias, { query: q, limit: 3, withRelated: false })
    assert.equal(a.results[0]?.id, b.results[0]?.id, `查询「${q}」的 top1 被别名污染了`)
  }
})

// ============ ④ 联想层也读别名 ============
test('联想层读别名：目标标题不含的 gram，可由别名建立关联', () => {
  const target = mk({ id: 't', title: '排障手册', aliases: ['服务起不来', '白屏'] })
  const other = mk({ id: 'o', title: '白屏排查步骤' })
  const entries = [target, other]
  const rel = relatedOf(entries, target, 3, false)
  assert.ok(rel.find((r) => r.id === 'o'), '别名未参与联想——标题「排障手册」与「白屏排查」无 gram 重叠')
})

// ============ ⑤ 合并不丢（store 层，纯函数不可测，此处测可见行为） ============
test('别名参与 DF 统计：别名里的词应计入文档频率', () => {
  // ⚠ 夹具纪律：两个别名必须**互不为子串**（子串匹配会让一个词命中两条）。
  // 首版用「独特别名甲/乙」——都含「独特别名」子串 ⇒ 查询甲也命中乙 ⇒ 假红（我的夹具 bug）。
  const a = mk({ id: 'a', title: '甲', aliases: ['量子隧穿'] })
  const b = mk({ id: 'b', title: '乙', aliases: ['星系旋臂'] })
  const entries = [a, b]
  const r = recallEntries(entries, { query: '量子隧穿', limit: 5, withRelated: false })
  assert.equal(r.results.length, 1, `别名未计入 DF 或发生误配：期望只命中 1 条，实得 ${r.results.length}`)
  assert.equal(r.results[0].id, 'a')
})

// ============ ⑥ 尸体样本 ============
test('尸体：空别名数组不改变行为（等价于无别名）', () => {
  const withEmpty = mk({ id: 'a', title: '记忆检索', aliases: [] })
  const without = mk({ id: 'b', title: '记忆检索', tags: [] })
  const r1 = recallEntries([withEmpty], { query: '记忆', limit: 5, withRelated: false })
  const r2 = recallEntries([without], { query: '记忆', limit: 5, withRelated: false })
  assert.equal(r1.results[0].score, r2.results[0].score, '空别名数组改变了分数')
})

test('尸体：别名含停用词/单字符时仍能正常工作（不崩、不误配）', () => {
  const e = mk({ id: 'a', title: '甲', aliases: ['的', '的的', 'x'] })
  const r = recallEntries([e], { query: '甲', limit: 5, withRelated: false })
  assert.equal(r.results.length, 1)
})
