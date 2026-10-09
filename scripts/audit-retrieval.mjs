/**
 * 记忆检索面体检器（2026-10-10 由四个一次性脚本合并而来）
 *
 * 为什么存在：泛词门（df >= GENERIC_MIN_DF 且 df/N > GENERIC_DF_RATIO）曾把
 * 「插件 / 技能 / 任务板 / 教训」这类最核心的概念词**静默清零**——查询返回
 * 「命中 0 条」，而模型会把它读成「我没有这条记忆」。v0.12 已修（空结果自报
 * suppressedTerms）。本器是那处修复的**回归哨兵**，同时把论文线
 * （arXiv 2610.10170「placebo 对照 + 跨语料复制」）的方法固化成可重跑读数。
 *
 * 用法：node scripts/audit-retrieval.mjs [gate|ablation|timing|inject|all]
 *   gate      概念词普查：哪些词因泛词门被清零 + tags 归因 + 装置尸体样本
 *   ablation  placebo 四臂对照：干预效应 vs 装置分辨力
 *   timing    单次 recall 耗时基线（多档查询，打印 3 次原始值）
 *   inject    auto-inject 成本（按主人消息长度分档，打印 3 次原始值）
 *   all       = gate + ablation（**不含性能档**，理由见下）
 *
 * ⚠ 性能档（timing / inject）必须**在独立进程里单跑**（`node ... timing`）。
 *   2026-10-10 实测：同一进程内先跑 gate 再跑 timing，短档耗时虚高约 **6 倍**
 *   （inject 短档 209ms → 1227ms；长档 4597 → 4695 几乎不变）⇒ 堆状态会污染
 *   性能读数，且**短档受害最重**。故 `all` 刻意不含性能档——把不可比的读数
 *   放在一起输出，比不输出更坏。
 *
 * 仪器保真：import 生产编译产物 lib/*.js 的**纯函数**；只在内存里变换条目，
 * 绝不写盘上数据。判据单一真源——「这个词被清零了吗」以 recallEntries 自报的
 * suppressedTerms 为准，本器复算的 df 只用于**归因**（为什么）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { recallEntries, tokenizeQuery } from '../lib/search.js'
import { buildAutoRecallDigest } from '../lib/auto-inject.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DSH_HOME = process.env.DSH_HOME || 'E:/alice/.dsh'
const STORE = process.env.MEMORY_STORE || path.join(DSH_HOME, 'storages', 'agent_memory.json')
const SEED = 20261010

const argv = process.argv.slice(2)
const CMD = argv.find((a) => !a.startsWith('--')) || 'all'
const optOf = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit === undefined ? dflt : hit.slice(name.length + 3)
}

// ---------- 语料与门常量 ----------
const raw = JSON.parse(fs.readFileSync(STORE, 'utf8'))
const all = Object.values(raw.tables.entries)

/**
 * --scope=all|global|workspace：**跨语料复制**用的第二语料轴。
 * 论文纪律（arXiv 2610.10170）：单一语料上的结论可能是语料专属的——
 * 「With one corpus we would have gotten that conclusion wrong」。
 * 同一记忆库里恰有 global / workspace 两个天然分布不同的语料。
 */
const SCOPE = optOf('scope', 'all')
const liveAll = all.filter((e) => !e.archived)
const scopeOf = (e) => (e.scope === 'global' ? 'global' : 'workspace')
const live = SCOPE === 'all' ? liveAll : liveAll.filter((e) => scopeOf(e) === SCOPE)
const N = live.length
if (N === 0) {
  console.error(`[FATAL] --scope=${SCOPE} 过滤后活跃条目为 0 —— 请核对 entry.scope 的实际取值。`)
  process.exit(4)
}

/**
 * 门常量**不在本器里写死**：从构建产物里解析出来。解析不到即响亮失败——
 * 宁可不跑，也不拿默认值兜底（默认值会让本器在常量改名后静默失明）。
 */
function parseGateConstants() {
  const src = fs.readFileSync(path.join(HERE, '..', 'lib', 'search.js'), 'utf8')
  const mMin = src.match(/GENERIC_MIN_DF\s*=\s*(\d+)/)
  const mRatio = src.match(/GENERIC_DF_RATIO\s*=\s*([\d.]+)/)
  if (mMin === null || mRatio === null) {
    console.error('[FATAL] 无法从 lib/search.js 解析 GENERIC_MIN_DF / GENERIC_DF_RATIO')
    console.error('        常量改名或门被移除 ⇒ 本器失明，拒绝用默认值兜底。')
    process.exit(2)
  }
  return { minDf: Number(mMin[1]), ratio: Number(mRatio[1]) }
}

/**
 * df 复算（**照抄源码口径**，仅供归因）：同一文档只计一次，位置优先
 * title > tags > body（短路）。与 buildIdf 同形，改源码口径时此处必须同改。
 */
function dfOf(entries, word, withTags) {
  const t = word.toLowerCase()
  let dt = 0
  let da = 0
  let db = 0
  for (const e of entries) {
    if ((e.title ?? '').toLowerCase().includes(t)) dt++
    else if (withTags && (e.tags ?? []).some((x) => x.toLowerCase().includes(t))) da++
    else if ((e.body ?? '').toLowerCase().includes(t)) db++
  }
  return { title: dt, tags: da, body: db, df: dt + da + db }
}

// ---------- gate：概念词普查 ----------
function runGate() {
  const { minDf, ratio } = parseGateConstants()
  const threshold = Math.max(minDf, Math.ceil(N * ratio))
  const minTagDf = Number(optOf('min-tag-df', 20))

  const dist = liveAll.reduce((m, e) => {
    const k = scopeOf(e)
    m[k] = (m[k] ?? 0) + 1
    return m
  }, {})
  console.log('=== gate · 泛词门影响面普查 ===')
  console.log(`语料：${all.length} 条（活跃 ${liveAll.length} / 归档 ${all.length - liveAll.length}） · 库 ${STORE}`)
  console.log(`作用域：--scope=${SCOPE} ⇒ 本次参与 ${N} 条` + (SCOPE === 'all' ? `（${Object.entries(dist).map(([k, v]) => k + ' ' + v).join(' / ')}）` : ''))
  console.log(`门：df >= ${minDf} 且 df/N > ${ratio} ⇒ 有效阈值 df >= ${threshold}（N=${N}）\n`)
  console.log('⚠ 门是**比例门**（df/N）⇒ 换语料即换阈值，两个语料的读数**不可直接比大小**，')
  console.log('  要比的是**形状**：被清零的词是哪一类、以及它们是不是「最核心的概念词」。\n')

  // 候选概念词：tags 频次 >= minTagDf（这些是「我平时会拿来当查询词」的概念）
  // ⚠ 键必须**按小写归并**：df 匹配本身是大小写不敏感的（源码 toLowerCase），
  //   若按 tags 原样大小写取键，`dsh`/`DSH`、`github`/`GitHub` 会被当成两个词
  //   各计一次 ⇒ ① 被清零清单出现重复项，受害面被虚报（2026-10-10 实测踩到）。
  const tagFreq = new Map()
  for (const e of live)
    for (const t of e.tags ?? []) {
      const key = t.toLowerCase()
      tagFreq.set(key, (tagFreq.get(key) ?? 0) + 1)
    }
  const candidates = [...tagFreq.entries()]
    .filter(([, n]) => n >= minTagDf)
    .sort((a, b) => b[1] - a[1])
    .map(([t]) => t)

  const rows = []
  let staleBuild = 0
  for (const w of candidates) {
    const res = recallEntries(live, { query: w, limit: 10, includeArchive: false })
    const sup = res.suppressedTerms
    // 空结果必须自报原因（v0.12）——字段缺失 = 构建产物落后，不是「没有抑制」
    if (res.total === 0 && sup === undefined) staleBuild++
    const kind = res.total > 0 ? 'hits' : (sup ?? []).length > 0 ? 'gated' : 'absent'
    const withT = dfOf(live, w, true)
    const withoutT = dfOf(live, w, false)
    const isGen = (df) => df >= minDf && df / N > ratio
    rows.push({
      w,
      tagDf: tagFreq.get(w),
      total: res.total,
      kind,
      sup: sup ?? [],
      dfWith: withT.df,
      dfWithout: withoutT.df,
      tagsContribution: withT.tags,
      pushedByTags: isGen(withT.df) && !isGen(withoutT.df),
    })
  }

  if (staleBuild > 0) {
    console.error(`\n[FATAL] ${staleBuild} 个空结果**没有** suppressedTerms ⇒ 构建产物落后于 v0.12。`)
    console.error('        先 `npx tsc -p tsconfig.json` 重建，再跑本器（空结果不带原因 = 本器的判据失明）。')
    process.exit(3)
  }

  const gated = rows.filter((r) => r.kind === 'gated')
  const absent = rows.filter((r) => r.kind === 'absent')
  const hits = rows.filter((r) => r.kind === 'hits')

  console.log('--- 分类（每词一次真 recall，判据 = 工具自报） ---')
  console.log(`① 被门清零（total=0 且有 suppressedTerms） : ${gated.length}`)
  console.log(`② 真的没有（total=0 且无 suppressedTerms） : ${absent.length}`)
  console.log(`③ 有命中                                   : ${hits.length}`)
  console.log(`   候选词 = tags 频次 >= ${minTagDf} 的概念词，共 ${rows.length} 个\n`)

  if (gated.length > 0) {
    console.log('--- ① 被清零的词（真缺陷面：用户会读成「没有这条记忆」） ---')
    console.log('词'.padEnd(14) + 'tags频次'.padEnd(10) + 'df含tags'.padEnd(10) + 'df不含'.padEnd(8) + '被tags推过')
    for (const r of gated.sort((a, b) => b.dfWith - a.dfWith)) {
      console.log(
        r.w.padEnd(14) + String(r.tagDf).padEnd(10) + String(r.dfWith).padEnd(10) + String(r.dfWithout).padEnd(8) +
          (r.pushedByTags ? '★是' : '否'),
      )
    }
    console.log('')
  }

  const avgTags = rows.reduce((s, r) => s + r.tagsContribution, 0) / Math.max(rows.length, 1)
  const avgDf = rows.reduce((s, r) => s + r.dfWith, 0) / Math.max(rows.length, 1)
  const overWith = rows.filter((r) => r.dfWith >= minDf && r.dfWith / N > ratio).length
  const overWithout = rows.filter((r) => r.dfWithout >= minDf && r.dfWithout / N > ratio).length
  const pushed = rows.filter((r) => r.pushedByTags)

  console.log('--- 汇总 ---')
  console.log(`清零率：${((gated.length / Math.max(rows.length, 1)) * 100).toFixed(1)}%`)
  console.log(`候选词平均 df=${avgDf.toFixed(1)}，其中 tags 贡献 ${avgTags.toFixed(1)}（${((avgTags / avgDf) * 100).toFixed(1)}%）`)
  console.log(`触发率：含 tags ${((overWith / Math.max(rows.length, 1)) * 100).toFixed(1)}%  vs  不含 tags ${((overWithout / Math.max(rows.length, 1)) * 100).toFixed(1)}%`)
  console.log(`纯因 tags 被推过阈值：${pushed.length} 个${pushed.length > 0 ? '（' + pushed.map((r) => r.w).join('、') + '）' : ''}`)
  console.log('⇒ 读法：主要死因是**词本身常见**，不是 tags（tags 贡献占比见上）。')
  console.log('  候选词集合随语料增长而变 ⇒ **跨语料规模不可比**，比读数前先看上面的活跃条数。\n')

  // 尸体样本：证明「① 与 ②」真的被区分开（若连乱码都报 gated，本器恒报缺陷）
  const junk = ['zzqxwvqq', 'qqzzxxjj-not-a-word']
  console.log('--- 尸体样本（证明判据会亮，且不会恒报①） ---')
  for (const j of junk) {
    const res = recallEntries(live, { query: j, limit: 10, includeArchive: false })
    const sup = res.suppressedTerms ?? []
    const ok = res.total === 0 && sup.length === 0
    console.log(`  "${j}" ⇒ total=${res.total} suppressed=[${sup.join(',')}]  ${ok ? '✔ 落在②（正确）' : '✘ 未落在② ⇒ 判据可疑'}`)
  }
}

// ---------- 性能档公用：3 次原始值 ----------
let LAST_RAW = []
function median3(fn) {
  const ts = []
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now()
    fn()
    ts.push(performance.now() - t0)
  }
  LAST_RAW = ts.map((x) => Number(x.toFixed(1)))
  const sorted = [...ts].sort((a, b) => a - b)
  return sorted[1]
}

function perfBanner(what) {
  console.log('=== ' + what + ' ===')
  console.log('⚠ 性能档必须在**独立进程**里单跑（`node scripts/audit-retrieval.mjs ' + CMD + '`）。')
  console.log('  同一进程内先跑 gate 再跑本档，短档会虚高约 6 倍（2026-10-10 实测）。\n')
}

// ---------- timing：recall 耗时基线 ----------
function runTiming() {
  perfBanner('timing · 单次 recall 耗时基线（中位 / 3 次）')
  console.log(`语料：活跃 ${N}\n`)
  const long = live.find((e) => (e.body ?? '').length > 300)
  const CASES = [
    { label: '短概念词(2字)', q: '保活' },
    { label: '短概念词(2字)·空', q: '口径' },
    { label: '中概念词(4字)', q: '上下文管理' },
    { label: '自然片段(12字)', q: long === undefined ? 'fallback-query' : long.body.slice(120, 132) },
    { label: '英文词', q: 'guardian' },
  ]
  console.log('档位'.padEnd(20) + 'tokens'.padEnd(8) + 'total'.padEnd(8) + '返回'.padEnd(6) + 'ms(中位)'.padEnd(10) + '3 次原始值')
  for (const c of CASES) {
    const toks = tokenizeQuery(c.q).length
    let res = null
    const ms = median3(() => {
      res = recallEntries(live, { query: c.q, limit: 10, includeArchive: false })
    })
    console.log(
      c.label.padEnd(20) + String(toks).padEnd(8) + String(res.total).padEnd(8) + String(res.results.length).padEnd(6) +
        ms.toFixed(1).padEnd(10) + '[' + LAST_RAW.join(' / ') + ']',
    )
  }
  console.log('\n⇒ buildIdf 是 O(T x N)（T=查询词数、N=候选条目数），与 limit 无关 ⇒ 词数越多越慢。')
  console.log('⇒ **原始值离散度大或某档离群时，先核对，别把中位数当稳定基线**（一个 6x 离群值')
  console.log('   足以让「哪档最慢」的结论反过来）。')
}

// ---------- inject：auto-inject 成本 ----------
function runInject() {
  perfBanner('inject · auto-inject 每条主人消息的开销（中位 / 3 次）')
  console.log(`语料：${all.length} 条（全量，归档在内部过滤）\n`)
  const CASES = [
    { label: '短(2字)', q: '继续' },
    { label: '中(8字)', q: '继续完善理论吧' },
    { label: '近 60 字', q: '继续完善理论吧，往用来告诉别人应该怎么做、指导新系统的设计、产生强预测的这个方向进行完善，先搜索高可靠性的论文' },
    { label: '近 QUERY_MAX(200字)', q: '继续完善理论吧，往用来告诉别人应该怎么做、指导新系统的设计、产生强预测的这个方向进行完善，先搜索高可靠性的论文，如果没有就立项展开研究。这个是今晚的任务，慢慢做。另外把测试驱动开发加入到核心规则里面，把测试驱动开发加入到核心规则里面，把测试驱动开发加入到核心规则里面' },
  ]
  const OPTS = { maxEntries: 5, maxBytes: 1200 }
  console.log('档位'.padEnd(24) + 'tokens'.padEnd(8) + 'ms(中位)'.padEnd(12) + '3 次原始值'.padEnd(28) + '输出字符')
  const out = []
  for (const c of CASES) {
    const toks = tokenizeQuery(c.q).length
    let text = ''
    const ms = median3(() => {
      text = buildAutoRecallDigest(all, c.q, OPTS)
    })
    out.push({ label: c.label, toks, ms })
    console.log(c.label.padEnd(24) + String(toks).padEnd(8) + ms.toFixed(1).padEnd(12) + ('[' + LAST_RAW.join(' / ') + ']').padEnd(28) + text.length)
  }

  // 规模效应：只在**相邻可比档**之间算比值（首档 vs 末档的 tokens 差 97 倍，
  // 拿它的比值说「超线性」是把两个不同量级的东西硬套，标签会自相矛盾）。
  const prev = out[out.length - 2]
  const last = out[out.length - 1]
  const tokRatio = last.toks / Math.max(prev.toks, 1)
  const msRatio = last.ms / Math.max(prev.ms, 1)
  console.log('\n--- 规模效应（相邻可比档：' + prev.label + ' → ' + last.label + '） ---')
  console.log(`tokens ${prev.toks} → ${last.toks}（${tokRatio.toFixed(2)}x） · 耗时 ${prev.ms.toFixed(0)} → ${last.ms.toFixed(0)}ms（${msRatio.toFixed(2)}x）`)
  console.log(`⇒ 判定：耗时增速 ${msRatio > tokRatio ? '**超过**' : '未超过'} token 增速 ⇒ ${msRatio > tokRatio ? '超线性' : '线性或次线性'}`)
  console.log('\n⚠ 口径：**每条主人消息一次**，不是每 step —— agent/pre-step 钩子有 message-id 去重门')
  console.log('  （`if (seen.has(found.id)) return`）。故「每消息成本」= 上表单次耗时本身，')
  console.log('  不要按 step 数外推（旧脚本曾按 20 step 外推，已按实测纠正）。')
}

// ---------- ablation：placebo 四臂对照 ----------
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function derangement(n, seed) {
  const r = rng(seed)
  const idx = Array.from({ length: n }, (_, i) => i)
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1))
    const tmp = idx[i]
    idx[i] = idx[j]
    idx[j] = tmp
  }
  for (let pass = 0; pass < 2; pass++)
    for (let i = 0; i < n; i++)
      if (idx[i] === i) {
        const j = (i + 1) % n
        const tmp = idx[i]
        idx[i] = idx[j]
        idx[j] = tmp
      }
  return idx
}

function jaccard(a, b) {
  const A = new Set(a)
  const B = new Set(b)
  if (A.size === 0 && B.size === 0) return null // 两臂都空 ⇒ 不可比，不记 1.0
  const inter = [...A].filter((x) => B.has(x)).length
  return inter / new Set([...A, ...B]).size
}

function runAblation() {
  const TOPK = 10
  const perClass = Number(optOf('per-class', 6))
  console.log('=== ablation · placebo 四臂对照（干预效应 vs 装置分辨力） ===')
  console.log(`语料：活跃 ${N} · seed=${SEED} · 每类 ${perClass} 查询 · topK=${TOPK}`)
  console.log('⚠ 查询集由 seed 定 + 语料抽样 ⇒ **跨语料规模不可比**（活跃数变化即换了一批查询）\n')

  const tagFreq = new Map()
  for (const e of live) for (const t of e.tags ?? []) tagFreq.set(t, (tagFreq.get(t) ?? 0) + 1)
  const conceptQueries = [...tagFreq.entries()]
    .filter(([t, n]) => n >= 5 && t.length >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, perClass)
    .map(([q]) => ({ q }))

  const naturalQueries = []
  {
    const r = rng(SEED + 7)
    const pool = live.filter((e) => (e.body ?? '').length > 300)
    const used = new Set()
    let guard = 0
    while (naturalQueries.length < perClass && guard < 4000) {
      guard++
      const i = Math.floor(r() * pool.length)
      if (used.has(i)) continue
      used.add(i)
      const b = pool[i].body
      const frag = b.slice(Math.floor(b.length * 0.35), Math.floor(b.length * 0.35) + 6).replace(/\s+/g, '').trim()
      if (frag.length >= 4) naturalQueries.push({ q: frag })
    }
  }
  const junkQueries = [{ q: 'zzqxwv' }, { q: 'qqzzxxjj' }]

  const perm = derangement(live.length, SEED)
  const tagsPool = live.map((e) => e.tags ?? [])
  const ARMS = {
    real: (es) => es,
    placebo: (es) => es.map((e, i) => ({ ...e, tags: tagsPool[perm[i]] })),
    nullTags: (es) => es.map((e) => ({ ...e, tags: [] })),
    corpseNullTitle: (es) => es.map((e) => ({ ...e, title: '' })),
  }
  const changedOf = {
    real: 0,
    placebo: live.reduce((s, e, i) => s + (JSON.stringify(e.tags ?? []) === JSON.stringify(tagsPool[perm[i]]) ? 0 : 1), 0),
    nullTags: live.filter((e) => (e.tags ?? []).length > 0).length,
    corpseNullTitle: live.filter((e) => (e.title ?? '').length > 0).length,
  }

  /** 干预的**作用面**：查询词在 tags 列真实命中多少次（0 ⇒ 干预空转） */
  const tagHitCount = (queries) => {
    let n = 0
    for (const { q } of queries)
      for (const tok of tokenizeQuery(q)) {
        const t = tok.toLowerCase()
        for (const e of live) if ((e.tags ?? []).some((x) => x.toLowerCase().includes(t))) n++
      }
    return n
  }

  const runArm = (mutate, queries) => {
    const entries = mutate(live)
    return queries.map(({ q }) => {
      const res = recallEntries(entries, { query: q, limit: TOPK, includeArchive: false })
      return res.results.map((x) => x.id)
    })
  }

  for (const [cls, queries] of [
    ['cls1_concept', conceptQueries],
    ['cls2_natural', naturalQueries],
    ['cls3_junk', junkQueries],
  ]) {
    const base = runArm(ARMS.real, queries)
    const hitsInTags = tagHitCount(queries)
    const realHits = base.filter((x) => x.length > 0).length
    console.log(`--- ${cls}（${queries.length} 查询 · real 臂命中查询数 ${realHits}） ---`)
    const js = {}
    for (const [name, fn] of Object.entries(ARMS)) {
      if (name === 'real') continue
      const arm = runArm(fn, queries)
      const cells = []
      for (let i = 0; i < base.length; i++) cells.push(jaccard(base[i], arm[i]))
      const valid = cells.filter((x) => x !== null)
      const mean = valid.length === 0 ? null : valid.reduce((s, x) => s + x, 0) / valid.length
      js[name] = mean
      const armHits = arm.filter((x) => x.length > 0).length
      console.log(
        `  ${name.padEnd(18)} 改动态条目 ${String(changedOf[name]).padEnd(6)} 命中查询 ${String(armHits).padEnd(4)} Jaccard ${mean === null ? '不可比(两臂皆空)' : mean.toFixed(3)}`,
      )
    }
    const jCorpse = js.corpseNullTitle
    const jInter = [js.placebo, js.nullTags].filter((x) => x !== null)
    let verdict
    if (jCorpse === null || jCorpse >= 0.999) verdict = 'undecided：装置无分辨力（连尸体臂都打不动）'
    else if (hitsInTags === 0) verdict = 'undecided：干预空转（查询词在 tags 列零命中 ⇒ 置换/清空必然无效应）'
    else if (jInter.length > 0 && jInter.every((x) => x >= 0.999))
      verdict = `measurable-no-effect：装置有分辨力（尸体锚 ${jCorpse.toFixed(3)}），但 tags 干预无可测效应`
    else verdict = 'effect-detected：干预与尸体锚同为可测偏差 ⇒ 需要看逐查询明细'
    console.log(`  ⇒ 判定：${verdict}`)
    console.log(`     （干预作用面：查询词在 tags 列命中 ${hitsInTags} 次）\n`)
  }

  console.log('⚠ 纪律：对照组不失败 = 实验无结论。只有**尸体臂**动了（Jaccard < 1），')
  console.log('  才证明装置有分辨力；此时若干预臂仍是 1.000，才能读成「无可测效应」。')
  console.log('  若尸体臂也打不动 ⇒ 装置分辨力不足 ⇒ 写「不可判」，不写「无效应」。')
}

// ---------- 入口 ----------
const RUNNERS = { gate: runGate, ablation: runAblation, timing: runTiming, inject: runInject }
// `all` 刻意只跑功能档：性能档需要独立进程，混在一起会得到虚高读数
const ALL_ORDER = ['gate', 'ablation']
if (CMD === 'all') {
  for (const name of ALL_ORDER) {
    RUNNERS[name]()
    console.log('')
  }
  console.log('⚠ 本次 `all` **未跑性能档**（timing / inject）——它们必须在独立进程里单跑：')
  console.log('    node scripts/audit-retrieval.mjs timing')
  console.log('    node scripts/audit-retrieval.mjs inject')
} else if (RUNNERS[CMD] !== undefined) {
  RUNNERS[CMD]()
} else {
  console.error(`[FATAL] 未知子命令 "${CMD}"；可用：gate | ablation | timing | inject | all`)
  process.exit(1)
}
