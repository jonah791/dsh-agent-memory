/**
 * dedupe 单测（node --test，跑构建产物 lib/dedupe.js）
 * 判据：近重复要提示、**无重复不得提示**（尸体测试）、边界与守卫。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NEAR_DUP_THRESHOLD, findNearDuplicates, formatDuplicateHint, parseDedupeTrace } from '../lib/dedupe.js'
import { readDedupeTrace } from '../lib/dedupe-trace.js'

const entry = (over = {}) => ({
  id: 'e1',
  kind: 'knowledge',
  key: null,
  title: 'x402 收录死锁的解剖',
  body: '发现面合规即可被目录收录',
  tags: ['x402', '收录'],
  scope: 'e:/alice',
  archived: false,
  ...over,
})

test('两个共享标签即达阈值（2×3=6）⇒ 命中', () => {
  const dup = findNearDuplicates([entry()], { title: 'x402 收录死锁', tags: ['x402', '收录'] })
  assert.equal(dup.length, 1)
  assert.equal(dup[0].id, 'e1')
  assert.ok(dup[0].strength >= NEAR_DUP_THRESHOLD)
})

test('标题高度重合（2-gram 命中 ≥3）⇒ 命中', () => {
  const dup = findNearDuplicates([entry()], { title: 'x402 收录死锁的解剖（补记）', tags: [] })
  assert.equal(dup.length, 1)
})

test('尸体测试：完全无关的新条目 ⇒ **不得**提示', () => {
  const dup = findNearDuplicates(
    [entry()],
    { title: 'ComfyUI 底模瘦身', body: '只留 1.6', tags: ['comfyui', '模型'] },
  )
  assert.deepEqual(dup, [])
})

test('尸体测试：无标题 ⇒ 不得提示（守卫）', () => {
  assert.deepEqual(findNearDuplicates([entry()], { title: '   ' }), [])
})

test('归档条目不进候选（避免提示已归档的）', () => {
  const dup = findNearDuplicates([entry({ archived: true })], { title: 'x402 收录死锁', tags: ['x402', '收录'] })
  assert.deepEqual(dup, [])
})

test('阈值可覆盖：调高到 99 ⇒ 不再提示', () => {
  const dup = findNearDuplicates([entry()], { title: 'x402 收录死锁', tags: ['x402', '收录'] }, 5, 99)
  assert.deepEqual(dup, [])
})

test('按强度降序并受 limit 约束', () => {
  const many = Array.from({ length: 7 }, (_, i) =>
    entry({ id: `e${i}`, title: 'x402 收录死锁的解剖', tags: ['x402', '收录'] }),
  )
  const dup = findNearDuplicates(many, { title: 'x402 收录死锁', tags: ['x402', '收录'] }, 3)
  assert.equal(dup.length, 3)
  assert.ok(dup[0].strength >= dup[1].strength)
})

test('提示文案：含条数、id 与「先考虑 update/merge」的行动指引', () => {
  const text = formatDuplicateHint([{ id: 'e1', title: 'x402 收录', strength: 9, sharedTags: 2 }])
  assert.ok(text.includes('1 条'))
  assert.ok(text.includes('e1'))
  assert.ok(text.includes('memory_merge'))
  assert.ok(text.includes('§5.8'))
})

// ── 措辞降级（2026-11-12 · 台账 lh-708ed26c）─────────────────────────────────
//
// 实测反例：一次 remember 回了 5 条候选，强度只有 19–21（阈值 6），**逐条看全是无关**。
// 旧文案写「命中 N 条**高度相似**的既有条目」——那是把「值得看一眼」读成「已有同主题条目」，
// 代价是我按一条错前提去合并/补写记忆库。下面三条把新措辞与强度读数钉住。

test('★ 尸体：文案不得再声称「高度相似」（那是把阈值 6 读成高相似度）', () => {
  const text = formatDuplicateHint([{ id: 'e1', title: 'x402 收录', strength: 19, sharedTags: 0 }])
  assert.doesNotMatch(text, /高度相似/, '阈值 6 的语义是「值得看一眼」，不是高度相似')
  assert.match(text, /相关/, '改成「相关，请判是否重复」——判断权交回读者')
  assert.match(text, /请逐条判断是否与本次写入重复/)
})

test('★ 抬头必须印强度范围（这是唯一可核的量，读者要能看出这批候选到底有多像）', () => {
  const text = formatDuplicateHint([
    { id: 'a', title: 'A', strength: 19, sharedTags: 0 },
    { id: 'b', title: 'B', strength: 21, sharedTags: 0 },
    { id: 'c', title: 'C', strength: 20, sharedTags: 0 },
  ])
  assert.match(text, /强度 19–21/, '抬头必须带 min–max 强度')
  assert.match(text, /阈值 ≥6/, '阈值要显式写出（读者才能自己判「多接近才算像」）')
})

test('★ 判据未被文案改动带走：阈值仍是 6、无关也要能表达（unrelated 出口在文案里）', () => {
  assert.equal(NEAR_DUP_THRESHOLD, 6, '阈值 6 是主人 2026-09-17 建的机制，本次只改文案')
  const text = formatDuplicateHint([{ id: 'e1', title: 'x402 收录', strength: 6, sharedTags: 0 }])
  assert.match(text, /similarDisposition=unrelated/, '判为无关要有出口，否则人只能二选一地委屈一条')
})

test('提示文案：空数组 ⇒ 空串（调用方据此省略字段）', () => {
  assert.equal(formatDuplicateHint([]), '')
})

// ─── 处置闭环（2026-10-28 · lh-0f54524a）────────────────────────────────────
//
// 这组的重点是**能证伪两个看起来对、实际错的实现**：
//   ① 处置时不清空桶，只打标记 ⇒ 「处置后又被撞」永远算作已处置（本例 4 抓）
//   ② 排序时不拷贝入参 ⇒ 调用方数组被就地改写（本例 5 抓）
import { unresolvedCandidates } from '../lib/dedupe.js'

const hit = (candidateId, atMs, strength = 10) => ({ kind: 'hit', candidateId, atMs, strength })
const disposed = (candidateId, atMs, disposition = 'merged') => ({ kind: 'disposed', candidateId, atMs, disposition })

test('空记录 ⇒ 无欠账', () => {
  assert.deepEqual(unresolvedCandidates([]), [])
})

test('一次命中 ⇒ 一条欠账', () => {
  const out = unresolvedCandidates([hit('c1', 100, 12)])
  assert.equal(out.length, 1)
  assert.equal(out[0].candidateId, 'c1')
  assert.equal(out[0].hitCount, 1)
  assert.equal(out[0].lastHitMs, 100)
  assert.equal(out[0].maxStrength, 12)
})

test('同一候选两次命中 ⇒ 累加，强度取大、时间取晚', () => {
  const out = unresolvedCandidates([hit('c1', 100, 30), hit('c1', 200, 8)])
  assert.equal(out[0].hitCount, 2)
  assert.equal(out[0].maxStrength, 30)
  assert.equal(out[0].lastHitMs, 200)
})

test('命中后被处置 ⇒ **清账**（处置是时间轴上的重置）', () => {
  assert.deepEqual(unresolvedCandidates([hit('c1', 100), disposed('c1', 200)]), [])
})

test('★ 处置后又被撞两次 ⇒ 重新计 2（处置**不是**永久免检）', () => {
  const out = unresolvedCandidates([hit('c1', 100), disposed('c1', 200), hit('c1', 300), hit('c1', 400)])
  assert.equal(out.length, 1)
  assert.equal(out[0].hitCount, 2)
  assert.equal(out[0].lastHitMs, 400)
})

test('尸体测试：只有处置没有命中 ⇒ 不得凭空造欠账', () => {
  assert.deepEqual(unresolvedCandidates([disposed('c1', 200)]), [])
})

test('多条候选按最后命中时间降序（最久没管的排后面，最新撞的排前面）', () => {
  const out = unresolvedCandidates([hit('c1', 100), hit('c2', 300), hit('c3', 200)])
  assert.deepEqual(out.map((x) => x.candidateId), ['c2', 'c3', 'c1'])
})

test('★ 不修改入参数组（排序前拷贝——就地排序会污染调用方的记录）', () => {
  const records = [hit('c1', 300), hit('c2', 100)]
  const before = records.map((r) => r.candidateId)
  unresolvedCandidates(records)
  assert.deepEqual(records.map((r) => r.candidateId), before)
})

test('不同候选互不干扰（处置 c1 不影响 c2）', () => {
  const out = unresolvedCandidates([hit('c1', 100), hit('c2', 150), disposed('c1', 200)])
  assert.deepEqual(out.map((x) => x.candidateId), ['c2'])
})

// ─── IO 层与解析（2026-10-28 实测踩过假报警）───────────────────────────────────

test('★ 侧车不存在 ⇒ 空数组，**不是** undefined（首次使用不是故障）', async () => {
  const out = await readDedupeTrace('/nonexistent/definitely-absent-dedupe-trace.jsonl')
  assert.deepEqual(out, [])
})

test('parseDedupeTrace：坏行跳过、结构不全的跳过，好行保留', () => {
  const text = [
    JSON.stringify({ kind: 'hit', atMs: 1, candidateId: 'c1', strength: 9 }),
    'not json at all',
    JSON.stringify({ kind: 'disposed', atMs: 2, candidateId: 'c1', disposition: 'merged' }),
    JSON.stringify({ kind: 'bogus', atMs: 3, candidateId: 'c2' }),
    JSON.stringify({ kind: 'hit', atMs: 4 }),
    '',
  ].join('\n')
  const out = parseDedupeTrace(text)
  assert.equal(out.length, 2)
  assert.equal(out[0].candidateId, 'c1')
  assert.equal(out[0].kind, 'hit')
  assert.equal(out[1].kind, 'disposed')
  assert.equal(out[1].disposition, 'merged')
})

test('parseDedupeTrace：空文本 ⇒ 空数组（不是错误）', () => {
  assert.deepEqual(parseDedupeTrace(''), [])
})

// ─── 候选大纲（2026-11-11 · lh-23124786）────────────────────────────────────
//
// 存在理由：回执原本只给「id — 标题（强度 N）」。**标题是条目名，不是内容清单** ⇒
// 读不出候选到底覆盖了什么，于是「已被覆盖」被误判成「不同主题」，写出平行条目。
// 实测代价：母条目 42c01e24 标题写「四道卡口与工程锁陷阱」，而其第八、九节正是
// 相机换算链——只看见标题就动笔，事后才发现新条目是它的子集。
//
// 这组钉住四件事：① 大纲要出现且按正文顺序；② 一级 `#` 不算（那是标题重复）；
// ③ 无小节时退回正文首句（降级也要有信息）；④ **没有内容时绝不能凭空印「节：」**（尸体样本）。
import { extractOutline, formatCandidate } from '../lib/dedupe.js'

test('extractOutline：取 ## / ### 小节标题，按正文顺序', () => {
  const body = ['# 顶层标题', '', '## 一、参数契约', '正文', '## 二、工程锁', '### 细节', '正文'].join('\n')
  assert.deepEqual(extractOutline(body), ['一、参数契约', '二、工程锁', '细节'])
})

test('★ 尸体测试：一级 `# ` 标题**不进大纲**（否则每条候选都多一行噪声）', () => {
  const out = extractOutline(['# 这就是标题', '', '## 唯一小节'].join('\n'))
  assert.deepEqual(out, ['唯一小节'])
  assert.ok(!out.includes('这就是标题'))
})

test('无小节标题 ⇒ 退回正文首个非标题行', () => {
  const body = ['# 标题', '', '这是一段没有小节的正文。'].join('\n')
  assert.deepEqual(extractOutline(body), ['这是一段没有小节的正文。'])
})

test('★ 尸体测试：只有标题、没有正文 ⇒ 空数组（调用方据此不印「节：」）', () => {
  assert.deepEqual(extractOutline('# 只有标题'), [])
  assert.deepEqual(extractOutline(''), [])
  assert.deepEqual(extractOutline('   '), [])
})

test('超过 max 时截断到 max 条，且**保留尾部**并标出总节数', () => {
  const body = Array.from({ length: 10 }, (_, i) => `## 节${i + 1}`).join('\n')
  const out = extractOutline(body) // 默认 max=6
  assert.equal(out.length, 6)
  assert.deepEqual(out, ['节1', '节2', '节3', '…（共 10 节）', '节9', '节10'])
})

test('★ 尸体测试：截断**必须保留尾部**——只取前 N 会漏掉后来追加的小节', () => {
  // 42c01e24 的真实形状：前六节讲加载与工程锁，第八、九节才是相机与后处理。
  // 若实现是「只取前 max 条」，写相机条目时正好看不见它——这正是本条机制要救的失误。
  const body = [
    '一、capture 参数契约', '二、资产位置', '三、反向判据', '四、工程锁', '五、绕过覆盖',
    '六、性能', '七、舞台加载', '八、VMD 相机轨道', '九、URP 后处理不生效',
  ].map((t) => `## ${t}`).join('\n')
  const out = extractOutline(body)
  assert.ok(out.includes('八、VMD 相机轨道'), '尾部小节必须可见')
  assert.ok(out.includes('九、URP 后处理不生效'))
  assert.ok(out.some((s) => s.includes('共 9 节')), '截断必须标出总节数，否则会被读成「只有这些」')
})

test('max 边界：max=3 时仍是 1 头 + 占位 + 2 尾（不超长）', () => {
  const body = Array.from({ length: 8 }, (_, i) => `## 节${i + 1}`).join('\n')
  const out = extractOutline(body, 3)
  assert.equal(out.length, 3)
  assert.deepEqual(out, ['节1', '…（共 8 节）', '节8'])
})

test('max 极小（<3）⇒ 退化为直接取前 max 条，不产生超长输出', () => {
  const body = Array.from({ length: 5 }, (_, i) => `## 节${i + 1}`).join('\n')
  assert.deepEqual(extractOutline(body, 2), ['节1', '节2'])
})

test('超长小节标题截到 40 字加省略号（一条候选不该吃掉半屏）', () => {
  const out = extractOutline(`## ${'很'.repeat(60)}`)
  assert.equal(out[0].length, 41)
  assert.ok(out[0].endsWith('…'))
})

test('findNearDuplicates 的候选带 outline（从条目 body 提取，不是回执自带）', () => {
  const e = entry({ id: 'e9', body: ['# x402 收录', '## 死锁解剖', '## 修复路径'].join('\n') })
  const dup = findNearDuplicates([e], { title: 'x402 收录死锁', tags: ['x402', '收录'] })
  assert.equal(dup.length, 1)
  assert.deepEqual(dup[0].outline, ['死锁解剖', '修复路径'])
})

test('formatCandidate：有 outline ⇒ 两行；无 ⇒ 一行且不出现「节：」', () => {
  const withOutline = formatCandidate({ id: 'e1', title: 'T', strength: 9, sharedTags: 2, outline: ['A', 'B'] })
  assert.ok(withOutline.includes('e1 — T（强度 9）'))
  assert.ok(withOutline.includes('\n     节：A / B'))
  const without = formatCandidate({ id: 'e2', title: 'T2', strength: 8, sharedTags: 2 })
  assert.ok(!without.includes('节：'))
  assert.ok(!without.includes('\n'))
})
