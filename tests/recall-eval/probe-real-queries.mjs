/**
 * 探针：**真实查询**上的噪音读数（不写盘）。
 *
 * 为什么需要它：评测集的查询是「稀有 token + 常见 token」构造出来的，噪音条目必须含稀有 token
 * ⇒ 噪音本身就少、分数也不低，`relativeFloor` 在那里没有被砍的对象（实测 ablate：floor 臂 0:0 无数据）。
 * 但真实查询的噪音是「碰巧含某个字」的条目，分数低得多——门槛正是在那种分布上起作用。
 * ⇒ 扫参集测不到的维度，必须回到真实查询上量。
 *
 * 同时量 b（长度归一）：评测集说 b=0 更好（+4.1pp 显著），若真实查询上噪音也不变差，那就该关。
 *
 * 用法：node tests/recall-eval/probe-real-queries.mjs
 */
import { DEFAULT_DB, corpusFingerprint, loadCorpus, loadSearch } from './lib.mjs'

const QUERIES = [
  // 今天真实查过的
  '读过不代表改进',
  '相关度算法',
  '评测集',
  '长度归一',
  '核验',
  // 常见主题（长尾噪音更多的形状）
  '夹具',
  '插件挂载',
  '记忆压缩',
  '上下文剪枝',
  '守护重启',
  '额度',
  '沙箱',
]

const ARMS = [
  // 第一轮（已完成）量的是「b 与 floor 各自对返回条数的影响」，结论：
  //   floor 是砍噪音的主力（36.5 → 46.4 条），b 通过改变分数分布**放大 floor 的砍量**（39.3 → 46.4）。
  //   ⇒ 而评测集实测 b=0 的 top1 更好（+4.1pp, 13:2, p=0.010）。
  //   所以现在要回答的是：**b=0 之后把 floor 调到多少，才既拿住 top1 又把噪音压回原水平**。
  //   ⚠ floor 在 top1 上结构无效应（只能砍低分尾，永远不动 top1）⇒ 这个旋钮只调噪音，不牺牲精度。
  ['b=0 floor=0（不砍）', { k1: 1.2, b: 0, relativeFloor: 0 }],
  ['b=0 floor=0.05（现基线值）', { k1: 1.2, b: 0, relativeFloor: 0.05 }],
  ['b=0 floor=0.08', { k1: 1.2, b: 0, relativeFloor: 0.08 }],
  ['b=0 floor=0.12', { k1: 1.2, b: 0, relativeFloor: 0.12 }],
  ['b=0 floor=0.2', { k1: 1.2, b: 0, relativeFloor: 0.2 }],
  ['b=0.75 floor=0.05（现状）', { k1: 1.2, b: 0.75, relativeFloor: 0.05 }],
]

const entries = loadCorpus(DEFAULT_DB)
const fp = corpusFingerprint(entries)
console.log(`语料 ${fp.count} 条（指纹 ${fp.digest}）——当前真实库，不是快照\n`)
const { recallEntries } = await loadSearch()

const totals = ARMS.map(() => ({ returned: 0, nonEmpty: 0 }))
console.log('查询'.padEnd(18) + ARMS.map(([label]) => label.padEnd(22)).join(''))
for (const q of QUERIES) {
  const cells = []
  ARMS.forEach(([, tuning], i) => {
    const r = recallEntries(entries, { query: q, limit: 50, withRelated: false, includeArchive: true, tuning })
    totals[i].returned += r.results.length
    if (r.results.length > 0) totals[i].nonEmpty += 1
    cells.push(`${String(r.results.length).padStart(3)} 条`.padEnd(22))
  })
  console.log(q.padEnd(18) + cells.join(''))
}

console.log('\n── 合计（噪音越少越好；但**空结果不是好事**，两者要一起看）──')
ARMS.forEach(([label], i) => {
  const avg = totals[i].returned / QUERIES.length
  console.log(`  ${label.padEnd(24)} 平均返回 ${avg.toFixed(1)} 条 / 非空 ${totals[i].nonEmpty}/${QUERIES.length}`)
})
console.log('\n  ⚠ 这是 12 个查询的抽样，不是评测集；它只回答「门槛在真实分布上有没有动手」，')
console.log('     不能用来判 top1（那些查询没有标注答案）。')
