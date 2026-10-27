/**
 * 打分参数扫参（**只在 tune 侧扫**，留出集由验收脚本单独跑一次）
 *
 * 用法：
 *   node tests/recall-eval/sweep.mjs [--set=<eval-set.json>] [--stage=ablate|coarse|refine]
 *
 * 纪律（这是本脚本存在的理由，不是注释装饰）：
 *   ① **只许在 tune 侧扫**——脚本里硬拒绝 `--split=holdout`，不靠记性
 *      （调参调多了再在留出集上看结果，留出集就退化成调参集，验收变成自欺）
 *   ② 臂与臂之间**只改一个维度**才能归因；三维同扫会得到「哪一维贡献了增益」说不清
 *   ③ 报告必须同时列 top1 / MRR / 噪音 / 空结果 / 未命中——只看 top1 会让「门槛调到误杀」
 *      看起来像进步（噪音降了、top1 高了，实际是把相关条目砍没了）
 *   ④ 每次评估都用**评测集自带的冻结语料**，不受当天记忆库变化影响
 *
 * 消融臂（stage=ablate）回答「v0.17 的两处改动各自值多少」：
 *   b=0      ⇒ 关掉 BM25 长度归一（≈ v0.17 之前的行为）
 *   floor=0  ⇒ 关掉相对分门槛（≈ v0.17 之前的行为）
 *   两者都 0 ⇒ 完整回归旧行为，可用来验证「评测集能测出这个差别」
 */

import { readFileSync } from 'node:fs'
import { corpusFingerprint, loadSearch } from './lib.mjs'

const DEFAULT_SET = 'E:/alice/.dsh/recall-eval/eval-set.json'
/** 生产默认值（与 src/search.ts 的常量逐字对应；这里显式写一份是为了让报告能标「基线」） */
const BASELINE = { k1: 1.2, b: 0.75, relativeFloor: 0.05 }

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit === undefined ? fallback : hit.slice(name.length + 3)
}

const setPath = arg('set', DEFAULT_SET)
const stage = arg('stage', 'ablate')

// 🔒 结构防线：扫参只许在 tune 侧。不给 split 选项，也不读它——从根上做不了「在 holdout 上调参」。
const set = JSON.parse(readFileSync(setPath, 'utf8'))
const entries = set.corpusSnapshot
if (!Array.isArray(entries) || entries.length === 0) {
  console.error('✖ 评测集没有语料快照 ⇒ 读数不冻结，扫参无意义。重建评测集再跑。')
  process.exit(2)
}
const fp = corpusFingerprint(entries)
if (set.corpus?.digest !== fp.digest) {
  console.error(`✖ 快照指纹与评测集记录不符（${fp.digest} vs ${set.corpus?.digest}）——评测集文件可能被改过`)
  process.exit(3)
}

const cases = set.cases.filter((c) => c.split === 'tune')
if (cases.length === 0) {
  console.error('✖ 评测集里没有 tune 侧 case')
  process.exit(4)
}

const { recallEntries } = await loadSearch()

/** 跑一组 case，返回指标（分母恒定带上） */
function evaluate(tuning, subset = cases) {
  const rows = []
  for (const c of subset) {
    const r = recallEntries(entries, {
      query: c.query,
      limit: 50,
      withRelated: false,
      includeArchive: true,
      tuning,
    })
    const ids = r.results.map((x) => x.id)
    const rank = ids.indexOf(c.answerId) + 1
    rows.push({ rank, returned: r.results.length })
  }
  const n = rows.length
  const sum = (f) => rows.reduce((a, r) => a + f(r), 0)
  const top1 = sum((r) => (r.rank === 1 ? 1 : 0)) / n
  // ⚠ 必须带标准误：216 case 上 top1 的标准误约 3 个百分点 ⇒ 差 1~3 个点是**噪声**。
  //   没有这一列，扫参几乎必然选出「当次噪声最大的那个臂」并当成改进（今天差点就这样）。
  const seTop1 = n > 0 ? Math.sqrt((top1 * (1 - top1)) / n) : 0
  return {
    n,
    top1,
    seTop1,
    top5: sum((r) => (r.rank > 0 && r.rank <= 5 ? 1 : 0)) / n,
    mrr: sum((r) => (r.rank > 0 ? 1 / r.rank : 0)) / n,
    miss: sum((r) => (r.rank === 0 ? 1 : 0)) / n,
    noise: sum((r) => r.returned) / n,
    empty: sum((r) => (r.returned === 0 ? 1 : 0)) / n,
    /** 逐 case 的对错位图（配对检验用：同一条 case 上两臂一个对一个错，噪声互相抵消） */
    hits: rows.map((r) => (r.rank === 1 ? 1 : 0)),
  }
}

/**
 * McNemar 配对检验：两臂在**同一批 case** 上的「对/错」是否真不同。
 *
 * 为什么必须配对：两个独立比例的差看的是 `sqrt(p(1-p)/n)`（216 case 约 3.2 个点），
 * 而配对只看「一个对一个错」的那部分（不一致对），噪声大幅抵消——
 * 同样 216 case，配对能检出小得多的差异。今天差点被「差 3.7 个点的独立比例」骗到。
 *
 * @returns `{ aOnly, bOnly, z, significant }`；z > 1.96 ⇒ α=0.05 显著（连续校正）
 */
function mcnemar(a, b) {
  let aOnly = 0
  let bOnly = 0
  for (let i = 0; i < a.length; i++) {
    if (a[i] === 1 && b[i] === 0) aOnly += 1
    else if (a[i] === 0 && b[i] === 1) bOnly += 1
  }
  const n = aOnly + bOnly
  const z = n === 0 ? 0 : (aOnly - bOnly - Math.sign(aOnly - bOnly)) / Math.sqrt(n)
  return { aOnly, bOnly, z, significant: Math.abs(z) > 1.96 }
}

const arms = []
if (stage === 'ablate') {
  arms.push({ label: '基线 v0.17（k1=1.2 b=0.75 floor=0.05）', tuning: BASELINE })
  arms.push({ label: '消融：关长度归一（b=0）', tuning: { ...BASELINE, b: 0 } })
  arms.push({ label: '消融：关相对门槛（floor=0）', tuning: { ...BASELINE, relativeFloor: 0 } })
  arms.push({ label: '消融：两者都关（≈ v0.17 前）', tuning: { ...BASELINE, b: 0, relativeFloor: 0 } })
} else if (stage === 'coarse') {
  for (const k1 of [0.9, 1.2, 1.5]) {
    for (const b of [0.5, 0.75, 1.0]) {
      for (const relativeFloor of [0, 0.05, 0.12]) {
        arms.push({ label: `k1=${k1} b=${b} floor=${relativeFloor}`, tuning: { k1, b, relativeFloor } })
      }
    }
  }
} else if (stage === 'refine') {
  // 细化网格：按 coarse 的结果填（示例值，跑前改；留空则退化为 coarse）
  const ks = [Number(arg('k1', '1.2'))]
  const bs = [0.65, 0.75, 0.85]
  const fs = [Number(arg('floor', '0.05')), 0.08, 0.1]
  for (const k1 of ks) for (const b of bs) for (const relativeFloor of fs) arms.push({ label: `k1=${k1} b=${b} floor=${relativeFloor}`, tuning: { k1, b, relativeFloor } })
} else if (stage === 'kgrid') {
  // 扫饱和参数 k1（b 固定当前默认 0.75）。k1 同时出现在分子与分母 ⇒ 它调的是
  // **长度惩罚的陡度**：k1 小 → 快速饱和、长度影响弱；k1 大 → 线性区更长、长度影响强。
  for (const k1 of [0.5, 0.8, 1.2, 1.6, 2.5]) {
    arms.push({ label: `k1=${k1}`, tuning: { ...BASELINE, k1 } })
  }
} else if (stage === 'bgrid') {
  // 扫长度权重 b。判据不是「总体 top1 最高」，而是**两组权衡**：
  // b 越大 → 长条目被压得越狠 →「长目标」组损失越大，但「短目标」组（长文档偏差的病灶）
  // 增益越明显。选点是价值取舍，脚本只给曲线，不替你选。
  for (const b of [0, 0.25, 0.4, 0.55, 0.75, 0.9]) {
    arms.push({ label: `b=${b}`, tuning: { ...BASELINE, b } })
  }
} else if (stage === 'split') {
  // 按**目标正文长度**分组：长度归一到底在帮哪种情况、害哪种情况。
  // 「短目标」组才是长文档偏差的病灶形状（目标短、竞争者长）——若这一组在开归一后
  // 不升反降，说明归一的实际行为与文档说的不符，要先回去查实现，不是先调参数。
  arms.push({ label: '基线 v0.17（b=0.75 floor=0.05）', tuning: BASELINE })
  arms.push({ label: '关长度归一（b=0）', tuning: { ...BASELINE, b: 0 } })
} else {
  console.error(`✖ 未知 stage「${stage}」（可选 ablate / coarse / refine / split）`)
  process.exit(5)
}

console.log('════ 扫参 ════')
console.log(`评测集 : ${setPath}（tune 侧 ${cases.length} case；语料快照 ${fp.count} 条 / ${fp.digest}）`)
console.log(`阶段   : ${stage}（${arms.length} 臂）\n`)

const t0 = Date.now()
const results = []
for (const a of arms) {
  const m = evaluate(a.tuning)
  results.push({ ...a, m })
  console.log(`  ${a.label.padEnd(38)} top1=${(m.top1 * 100).toFixed(1)}%  MRR=${m.mrr.toFixed(3)}`)
}
const elapsed = ((Date.now() - t0) / 1000).toFixed(0)

// 报告：按 top1 降序、top1 相同再按 MRR（避免「top1 平手就随便排」）
const sorted = [...results].sort((a, b) => b.m.top1 - a.m.top1 || b.m.mrr - a.m.mrr)
const base = results[0].m // 第一臂固定是基线（ablate 阶段）或 coarse 的第一臂

console.log('\n── 排名（⚠ top1 带 ±1σ；**只认「差 > 2σ」的臂**，其余都是噪声）──')
console.log('臂'.padEnd(30) + ' top1±σ'.padEnd(14) + ' MRR    top5   噪音  空结果  未命中   与首臂差  判定')
for (const r of sorted) {
  const d = (r.m.top1 - base.top1) * 100
  const sign = d > 0 ? '+' : ''
  // 合并标准误（两臂独立近似）：sqrt(se1² + se2²)。差不到 2σ 就只算噪声——
  // 216 case 上 σ≈3 个百分点，意味着「top1 高了 1~3 个点」这种读数**什么都不能证明**。
  const seDiff = Math.sqrt(r.m.seTop1 ** 2 + base.seTop1 ** 2) * 100
  const isBase = r === results[0]
  const verdict = isBase ? '（基准）' : Math.abs(d) > 2 * seDiff ? '★ 显著' : '不显著'
  console.log(
    r.label.padEnd(30) +
      ` ${(r.m.top1 * 100).toFixed(1)}%±${(r.m.seTop1 * 100).toFixed(1)}`.padEnd(14) +
      ` ${r.m.mrr.toFixed(3)}  ${(r.m.top5 * 100).toFixed(1)}%`.padStart(6) +
      `  ${r.m.noise.toFixed(1)}`.padStart(5) +
      `  ${(r.m.empty * 100).toFixed(1)}%`.padStart(6) +
      `  ${(r.m.miss * 100).toFixed(1)}%`.padStart(6) +
      `   ${sign}${d.toFixed(1)}`.padStart(9) +
      `   ${verdict}`,
  )
}
// ★ 配对检验：判「这个臂真的更好吗」的正确判据。
//   独立比例的标准误（±3 个点）会把小改进淹掉；配对只看不一致的那几对 case。
if (results.length > 1) {
  console.log('\n── 配对检验（McNemar，各臂 vs 首臂；只统计「一个对一个错」的 case）──')
  const baseHits = results[0].m.hits
  let anySig = false
  for (const r of results.slice(1)) {
    const t = mcnemar(r.m.hits, baseHits)
    const dir = t.aOnly > t.bOnly ? '本臂更好' : t.aOnly < t.bOnly ? '本臂更差' : '持平'
    if (t.significant) anySig = true
    console.log(
      `  ${r.label.padEnd(30)} 本臂对/基线错=${String(t.aOnly).padStart(3)}  基线对/本臂错=${String(t.bOnly).padStart(3)}` +
        `  z=${t.z >= 0 ? '+' : ''}${t.z.toFixed(2)}  ⇒ ${t.significant ? '★ 显著' : '不显著'}（${dir}）`,
    )
  }
  if (!anySig) {
    console.log('\n  ⚠ 没有任何臂与基线有显著差异 ⇒ **这一轮扫参什么都没证明**。')
    console.log('     别把「排名表里第一」当结论：要么加 case 数（σ ∝ 1/√n），要么承认这个差异测不出。')
  }
}

console.log(`\n耗时 ${elapsed} 秒。`)

// 分组报告：长度归一到底帮谁、害谁（split / bgrid 阶段必出——那两阶段的结论只在分组里看得见）
if (stage === 'split' || stage === 'bgrid') {
  const byId = new Map(entries.map((e) => [e.id, e]))
  const lens = entries.map((e) => e.body.length).sort((a, b) => a - b)
  const med = lens[Math.floor(lens.length / 2)]
  const shortC = cases.filter((c) => (byId.get(c.answerId)?.body.length ?? 0) <= med)
  const longC = cases.filter((c) => (byId.get(c.answerId)?.body.length ?? 0) > med)
  console.log(`\n── 按目标正文长度分组（全库中位 ${med} 字符）──`)
  console.log('臂'.padEnd(34) + `短目标(n=${shortC.length})`.padEnd(26) + `长目标(n=${longC.length})`)
  for (const a of arms) {
    const s = evaluate(a.tuning, shortC)
    const l = evaluate(a.tuning, longC)
    console.log(
      a.label.padEnd(34) +
        `top1=${(s.top1 * 100).toFixed(1)}%  MRR=${s.mrr.toFixed(3)}`.padEnd(26) +
        `top1=${(l.top1 * 100).toFixed(1)}%  MRR=${l.mrr.toFixed(3)}`,
    )
  }
  console.log('\n读法：长度归一的意图是**压低长条目** ⇒ 它该让「短目标」组变好、让「长目标」组变差。')
  console.log('若短目标组不升反降 ⇒ 归一的实际行为与设计意图不符，先查实现再调参数。')
}

// ★ 判据力自检：消融臂如果跑出**与基线完全相同**的读数，说明参数没生效（或评测集对这两维
//   根本不敏感）——那不是「参数不重要」，是「这一刀没切到东西」。必须喧哗。
if (stage === 'ablate') {
  const abl = results.slice(1)
  const identical = abl.filter((r) => Math.abs(r.m.top1 - base.top1) < 1e-12 && Math.abs(r.m.mrr - base.mrr) < 1e-12)
  if (identical.length === abl.length) {
    console.log('\n⚠⚠ 所有消融臂与基线读数完全相同 —— 要么参数没传进去，要么评测集对这三个参数不敏感。')
    console.log('   别把它当「v0.17 无所谓」的证据；先去 src/search.ts 确认 resolveTuning 真的被用到了。')
  }
}
