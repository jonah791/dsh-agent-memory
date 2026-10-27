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
// 统计层单独成文件：`validate-holdout.mjs` 也用它。各写一份必然漂移，
// 而两个脚本对同一个差值给出不同裁决时，没人知道该信哪个。
import { mcnemar, powerIndependent, powerPaired, requiredNIndependent, requiredNPaired } from './stats.mjs'

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
    /** 逐 case 的名次（0 = 未命中）。分区报告要用它——长度归一的效应符号按长度区翻转，
     *  只看总体会把「短目标区收益」与「长目标区代价」抵消成零，读起来像「没效果」 */
    ranks: rows.map((r) => r.rank),
  }
}

/** 按长度区切一刀：返回该区内的样本量与 top1（`hits` 供配对检验复用） */
function zoneSlice(m, zoneName, allCases) {
  const idx = []
  allCases.forEach((c, i) => {
    if (c.zone === zoneName) idx.push(i)
  })
  const hits = idx.map((i) => m.hits[i])
  const n = hits.length
  return { n, top1: n > 0 ? hits.reduce((a, b) => a + b, 0) / n : 0, hits }
}

// `normCdf` 在 ./stats.mjs（与 mcnemar / 功效 / 反解同住，保证两脚本同口径）

// `mcnemar` 在 ./stats.mjs

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

// ★ 功效（检出率）：给定 n 与效应量，这台仪器**能发现**这个效应的概率。
//   它与「量程」是一回事的两个方向：量程问「能分清多大」，功效问「这么大的有多大概率被看见」。
//   ⚠ 配对版的 ψ（不一致率）是**假设值**，不是从本评测集量出来的 ⇒ 读数只给量级，不是精确功效。
// 3 个点是「这类改动通常能带来的最大改进」的量级（核验报告的判据线即取此值）。
const powerAt3 = powerPaired(cases.length, 0.03)
const powerAt3Indep = powerIndependent(cases.length, base.top1, 0.03)

// 反解：要可靠检出 delta 这个效应，需要多少 case（α=0.05、功效 0.8）。

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
  console.log('  判定用 α=0.05 **双侧**；z 打印三位是因为两位会把 1.9551 打成「+1.96」却判不显著（核验实测 19 组如此）。')
  const baseHits = results[0].m.hits
  let anySig = false
  let anyEmpty = false
  let anyBelowBound = false
  for (const r of results.slice(1)) {
    const t = mcnemar(r.m.hits, baseHits)
    // ★ 三条互不掩盖的判定分支，段位顺序有意义：
    //   empty 必须最先判——它意味着「样本里根本没有不一致对」，此时 z=0 不是「持平」而是「测不出」。
    if (t.empty) {
      anyEmpty = true
      console.log(
        `  ${r.label.padEnd(30)} 不一致对 0（0:0）` +
          `  ⇒ ⚠ **无数据**：不是「与基线持平」，是这个评测集对这条臂**完全不敏感**（两臂逐 case 全同）`,
      )
      continue
    }
    if (t.n < 6) {
      anyBelowBound = true
      console.log(
        `  ${r.label.padEnd(30)} 本臂对/基线错=${String(t.aOnly).padStart(3)}  基线对/本臂错=${String(t.bOnly).padStart(3)}` +
          `  z=${t.z >= 0 ? '+' : ''}${t.z.toFixed(3)}  p=${t.p.toFixed(3)}` +
          `  ⇒ ⚠ **不可判**：不一致对仅 ${t.n} 个，而本实现 n≤5 时数学上不可能报显著（上界 z=(n−1)/√n）`,
      )
      continue
    }
    const dir = t.aOnly > t.bOnly ? '本臂更好' : t.aOnly < t.bOnly ? '本臂更差' : '持平'
    if (t.significant) anySig = true
    console.log(
      `  ${r.label.padEnd(30)} 本臂对/基线错=${String(t.aOnly).padStart(3)}  基线对/本臂错=${String(t.bOnly).padStart(3)}` +
        `  z=${t.z >= 0 ? '+' : ''}${t.z.toFixed(3)}  p=${t.p.toFixed(3)}` +
        `  ⇒ ${t.significant ? '★ 显著' : '不显著'}（${dir}）`,
    )
  }
  if (anyEmpty) {
    console.log('\n  ⚠ 上面有臂落在「无数据」档：不一致对为 0 ⇒ 这条臂改的东西**在这个评测集上根本不发生**。')
    console.log('     这通常指向评测集缺场景（如所有 case 的竞争者都不长），不指向「这个参数没用」——先查 case 构成。')
  }
  if (anyBelowBound) {
    console.log('\n  ⚠ 上面有臂落在「不可判」档：不一致对 < 6。改判据或加 case，别读成「效果不存在」。')
  }
  if (!anySig) {
    console.log('\n  ⚠ 没有任何臂与基线有显著差异 ⇒ **这一轮扫参什么都没证明**。')
    console.log('     别把「排名表里第一」当结论：要么加 case 数（σ ∝ 1/√n），要么承认这个差异测不出。')
  }
  // ★ 功效脚注：把「不显著」与「没有效应」分开。数字**现算**，不写死（n 一变它就变）。
  console.log(
    `\n  ⓘ 功效脚注（α=0.05 双侧、功效按 0.8 标定、基线 ${(base.top1 * 100).toFixed(1)}%、效应取 3 个百分点）：` +
      `本集 ${cases.length} case 的检出率 ≈ 配对 ${(powerAt3 * 100).toFixed(1)}% / 独立 ${(powerAt3Indep * 100).toFixed(1)}%。`,
  )
  console.log('     ⇒ 报「不显著」的意思是**这台仪器没有分辨力**，不是「效应不存在」。')
  console.log('     ⚠ 配对那一路的 ψ=0.2（不一致率）是假设值不是实测 ⇒ 只当量级看。')
}

// ★★ 分区读数（2026-10-27 加）：长度归一的效应**符号按长度区翻转** ⇒ 总体数字是两个相反效应之和。
//   核验报告实测：总体 +3.7pp，但「答案≤中位」−1.7pp、「答案>2×中位」+12.0pp
//   —— 只看总体会得出「没效果」，而真相是两种相反效果叠在一起。
//   ⇒ 集子带 zone 字段就分区报，且**每个区独立做配对检验**（各区样本量小，必须带 p）。
{
  const ZONE_ORDER = ['far-short', 'short', 'fair', 'long', 'far-long']
  const ZONE_LABEL = {
    'far-short': '远短于竞争者（归一收益区）',
    short: '偏短（归一收益区）',
    fair: '长度相当（纯排序能力）',
    long: '偏长（归一代价区）',
    'far-long': '远长于竞争者（归一代价区）',
  }
  const hasZone = cases.every((c) => typeof c.zone === 'string')
  const probeArm = results.slice(1)[0]
  if (!hasZone) {
    console.log('\n⚠ 评测集没有 zone 字段（旧集）⇒ 跳过分区报告。重建评测集后才看得到效应符号翻转。')
  } else if (probeArm) {
    console.log(`\n── 分区读数：${probeArm.label}  vs  ${results[0].label} ──`)
    console.log('  长度区'.padEnd(32) + 'n'.padStart(4) + '   基线'.padStart(8) + '   对比'.padStart(8) + '    差'.padStart(8) + '   配对 a:b       p      判定')
    for (const z of ZONE_ORDER) {
      const bz = zoneSlice(base, z, cases)
      if (bz.n === 0) continue
      const oz = zoneSlice(probeArm.m, z, cases)
      const d = (oz.top1 - bz.top1) * 100
      const t = mcnemar(oz.hits, bz.hits)
      const verdict = t.empty ? '无数据' : Math.abs(t.z) > 1.96 ? '★ 显著' : '不显著'
      console.log(
        `  ${(ZONE_LABEL[z] ?? z).padEnd(30)}` +
          String(bz.n).padStart(4) +
          `${(bz.top1 * 100).toFixed(1)}%`.padStart(8) +
          `${(oz.top1 * 100).toFixed(1)}%`.padStart(8) +
          `${d >= 0 ? '+' : ''}${d.toFixed(1)}`.padStart(8) +
          `   ${String(t.aOnly).padStart(2)}:${String(t.bOnly).padEnd(2)}` +
          `  ${t.empty ? '  —  ' : t.p.toFixed(3)}` +
          `  ${verdict}`,
      )
    }
    const perZone = Math.round(cases.length / ZONE_ORDER.length)
    console.log(`  ⚠ 每区 n 约 ${perZone} ⇒ 单区 ±1 个 case 就是 ±${(100 / perZone).toFixed(1)} 个百分点。`)
    console.log('     单区的「★ 显著」只在该区样本够时才可信；单区的「不显著」同样**不可读成「无效应」**。')
  }
}

console.log(`\n耗时 ${elapsed} 秒。`)

// ★ 量程提示（2026-10-27 补）：不是「要多少样本」，而是「我这点样本能分清多大」。
//   实测（α=0.05 / 功效 0.8）：top1 67%→70%（3 个点）要 3763（独立）或 1742（配对）个 case。
//   ⇒ 216 个 case 的配对设计只能可靠检出约 8.5 个点以上。
//   这一段必须常驻：否则下一个人（包括未来的我）会拿排名表第一名当结论。
{
  const p = base.top1
  const sigma = Math.sqrt((p * (1 - p)) / cases.length)
  console.log('\n── 量程（这台仪器能判多大的效应）──')
  console.log(`  tune 侧 ${cases.length} 个 case，基线比例 ${(p * 100).toFixed(1)}% ⇒ 单臂标准误 ±${(sigma * 100).toFixed(1)} 个百分点`)
  console.log(`  ⇒ **差值小于 ±${(2 * sigma * 100).toFixed(1)} 个百分点的臂，即使排第一也只是噪声**。`)
  console.log(`  ⇒ 配对检验（McNemar）能检出更小的差异，但仍受 ${cases.length} 个样本的上限约束。`)
  // 下面三行全部**现算**（不写死数字）：n 一变，需要的样本量就跟着变。
  const n5 = requiredNPaired(0.05)
  const n3 = requiredNPaired(0.03)
  const n3i = requiredNIndependent(p, 0.03)
  console.log(`     要可靠检出 5 个点：${n5} 个 case（配对，ψ=0.2）/ 要检出 3 个点：${n3} 个（配对）或 ${n3i} 个（独立）`)
  console.log(`     ⇒ 现在这 ${cases.length} 个 case 连 5 个点都检不可靠（${(powerPaired(cases.length, 0.05) * 100).toFixed(0)}% 检出率）——加 case 数才是正解，加规则不是。`)
}

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
