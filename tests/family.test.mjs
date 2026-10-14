/**
 * family 单测（node --test，跑构建产物 lib/family.js）
 *
 * 判据锚点（v0.16.0 · 论文 Memory Echo 的 Family 组件）：
 *  ① **局部**：只折叠**同一候选池内**的直接父子 —— 跨池的两条独立时间线**不得**互相折叠
 *     （这是 2026-10-14 实测的教训：全库并查集会因「周概要引用日概要」把时间线连成
 *      156 条一族，折叠等于砍上下文 = 论文自证的 −33 题那一坑。**此条是回归防线**）
 *  ② 概要 + 其 archiveRef 原料同在池中 ⇒ 压成一位，代表 = 池内得分最高者
 *  ③ 不删数据：被折叠者的 id 仍在 `foldedTo` 里可查（论文 §5.1：does not delete）
 *  ④ 确定性：与输入顺序无关（族键/代表并列时的裁决规则明确）
 *  ⑤ 无折叠 ⇒ 说明文案为 undefined（信噪比纪律）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { collapseFamilies, renderFamilyNote } from '../lib/family.js'

/** 造一个最小条目（只填 family 关心的字段） */
function entry(id, archiveRef) {
  return {
    id,
    kind: archiveRef === undefined ? 'episodic' : 'summary',
    title: `T-${id}`,
    body: '',
    tags: [],
    scope: 'global',
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    accessedAt: '2026-10-01T00:00:00Z',
    archived: false,
    ...(archiveRef === undefined ? {} : { archiveRef }),
  }
}

const S = (id, score, archiveRef) => ({ entry: entry(id, archiveRef), score })

test('概要 + 原料同池 ⇒ 压成一位，代表是得分最高者', () => {
  const r = collapseFamilies([S('sum1', 5, ['a1', 'a2']), S('a1', 9), S('a2', 1)])
  assert.equal(r.kept.length, 1)
  assert.equal(r.kept[0].entry.id, 'a1', '得分最高的 a1 应为代表')
  assert.equal(r.foldedTo.get('sum1'), 'a1')
  assert.equal(r.foldedTo.get('a2'), 'a1')
  assert.equal(r.families.length, 1)
  assert.deepEqual(r.families[0].foldedIds, ['a2', 'sum1'], '被折叠者按 id 字典序')
})

test('★ 局部性回归：两个独立概要各自的原料**不得**互相折叠', () => {
  // 这正是全局并查集会犯的错：如果实现改成「全库连通」，两条独立时间线会被并成一族
  const r = collapseFamilies([
    S('sumA', 5, ['a1']),
    S('a1', 3),
    S('sumB', 5, ['b1']),
    S('b1', 3),
  ])
  assert.equal(r.families.length, 2, '应得到 2 个独立的族')
  assert.equal(r.kept.length, 2)
  // 代表 = 族内得分最高者（论文 §5.1「The highest-scoring eligible member takes the
  // family's single serving position」）⇒ 概要比原料分高时，代表是**概要**而非原料
  const keptIds = r.kept.map((x) => x.entry.id).sort()
  assert.deepEqual(keptIds, ['sumA', 'sumB'])
  assert.notEqual(r.foldedTo.get('a1'), r.foldedTo.get('b1'), '两条线不得归到同一代表')
})

test('★ 局部性回归：上游概要不在池中时，其原料不该被别的概要牵连', () => {
  // week 概要引用 day 概要；day 概要引用条目。只把 week 与 day 放进池里时，
  // 条目（不在池中）不参与；week 与 day 同族（直接父子）
  const r = collapseFamilies([S('week', 5, ['day1']), S('day1', 3)])
  assert.equal(r.families.length, 1)
  assert.equal(r.kept[0].entry.id, 'week', 'week 得分高 ⇒ 当代表')
  assert.equal(r.foldedTo.get('day1'), 'week')
})

test('池外引用不参与折叠（ref 目标不在候选池里 ⇒ 各归各）', () => {
  const r = collapseFamilies([S('sum1', 5, ['notInPool']), S('other', 3)])
  assert.equal(r.families.length, 0, '池外目标不产生族')
  assert.equal(r.kept.length, 2)
  assert.equal(r.foldedTo.size, 0)
})

test('无 archiveRef 且不被引用 ⇒ 独立族，永不折叠', () => {
  const r = collapseFamilies([S('x', 1), S('y', 2), S('z', 3)])
  assert.equal(r.kept.length, 3)
  assert.equal(r.families.length, 0)
})

test('一个条目被两个概要引用 ⇒ 归给 id 字典序最小的概要（确定性）', () => {
  const r = collapseFamilies([S('sumB', 5, ['shared']), S('sumA', 5, ['shared']), S('shared', 1)])
  assert.equal(r.families.length, 1, '两个概要 + 共享原料 ⇒ 一族')
  assert.equal(r.foldedTo.get('shared'), 'sumA', '按 id 字典序归给 sumA')
})

test('确定性：输入顺序不影响结果', () => {
  const items = [S('sum1', 5, ['a1', 'a2']), S('a1', 9), S('a2', 1)]
  const forward = collapseFamilies(items)
  const backward = collapseFamilies([...items].reverse())
  assert.deepEqual(
    forward.kept.map((x) => x.entry.id).sort(),
    backward.kept.map((x) => x.entry.id).sort(),
  )
  assert.deepEqual(
    [...forward.foldedTo.entries()].sort(),
    [...backward.foldedTo.entries()].sort(),
  )
})

test('同分并列 ⇒ 取 id 字典序小者当代表（可复现）', () => {
  const r = collapseFamilies([S('sum1', 5, ['zz', 'aa']), S('zz', 5), S('aa', 5)])
  assert.equal(r.kept[0].entry.id, 'aa')
})

test('尸体样本：archiveRef 自指 / 成环时不死循环，且仍给出结果', () => {
  // 坏数据：A 引用 B、B 引用 A（现实中 archiveRef 只指向更早条目，此为防御）
  const a = entry('A', ['B'])
  const b = entry('B', ['A'])
  const r = collapseFamilies([{ entry: a, score: 1 }, { entry: b, score: 2 }])
  // 判据是**不死循环 + 不丢条目**（不是特定条数）：环被 seen 集合截断后，两条各成一组
  assert.equal(r.kept.length, 2, '成环时全部保留（宁可少折叠，不可丢证据）')
  assert.equal(r.foldedTo.size, 0)
})

test('尸体样本：自指（自己引用自己）不产生族', () => {
  const r = collapseFamilies([S('selfie', 5, ['selfie'])])
  assert.equal(r.kept.length, 1)
  assert.equal(r.families.length, 0, '自指不是家族关系')
})

test('渲染：无折叠 ⇒ undefined（不打噪声）', () => {
  assert.equal(renderFamilyNote([], (id) => id), undefined)
})

test('渲染：有折叠 ⇒ 含条数与代表标签', () => {
  const r = collapseFamilies([S('sum1', 5, ['a1']), S('a1', 3)])
  const note = renderFamilyNote(r.families, (id) => `[${id}]`)
  assert.ok(typeof note === 'string')
  assert.ok(note.includes('同源折叠'))
  assert.ok(note.includes('+1 条同源'))
  assert.ok(note.includes('[sum1]'))
})

test('空输入不炸', () => {
  const r = collapseFamilies([])
  assert.deepEqual(r.kept, [])
  assert.equal(r.families.length, 0)
})
