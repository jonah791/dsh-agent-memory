/**
 * 知识提炼候选（v0.49 · 方案 §16.1「记忆知识化」）——**只读，不生成任何条目**。
 *
 * ## 方案要什么，本模块给什么
 *
 * 方案要一个**知识提炼层**（Knowledge Consolidation Layer）：跨时间跨项目把分散条目整合成
 * 经证据支持的高层知识，链条是「原始对话 → 事件记忆 → 主题归纳 → 知识关联 → 长期研究方向 →
 * 可复用研究方法」，并明确要求**证据阈值**——原话是「避免模型仅凭几次表达就断言用户已经形成
 * 稳定的长期研究方向」。
 *
 * 本模块只做链条里**机制能判的那一格**：主题归纳的候选识别与证据量。「这些条目意味着什么」
 * 「该归纳成哪条高层结论」是判断，归主体（AGENTS.md：机制只送信号，决策归我）。所以本模块
 * **不生成任何条目、不改任何条目**，只回答两问：哪些主题攒够了证据？够到什么程度？
 *
 * ## 先量数据源（2026-11-19 19:34 · 活库 1,798 条）
 *
 * 标签 4,168 个；≥5 条 286 个；≥5 条且跨 ≥30 天 **17 个**（最密 `#任务板` 165 条 / 61 天、
 * `#判据` 120 条 / 63 天、`#技能` 78 条 / 94 天）。证据量充足，与 §8.4 的空桶恰成反照。
 *
 * 两个**实测出来的限制**，一并写在这里而不是留给读者猜：
 *
 * 1. **「跨项目」维度不可用**：`project` 字段覆盖 **6.0%**（107/1,798）。方案要「跨时间跨项目」，
 *    本库只有前者量得出来。所以阈值只由「条目数 + 时间跨度」两维构成，第三维如实剔除。
 * 2. **已有 summary 对主题簇的覆盖极低**（最大簇 165 条里仅 1 条 summary）⇒ 主题维归纳确实
 *    缺位，不是「已被时间桶压缩顺手做了」。
 *
 * ## 为什么要排掉日期形态的标签
 *
 * 实测 `#2026-09-16` 有 39 条、跨度 0 天——它是**时间坐标不是主题**。把它当候选，会把
 * 「按主题归纳」退化成「按日期重排流水账」。同理排除周桶（`2026-W45`）、月桶（`2026-09`）、
 * 年桶（`2026`）与纯数字标签。判断用形态，不用白名单——白名单会随标签增长而腐烂。
 *
 * ## 阈值落点（为什么不取更松或更紧）
 *
 * 实测曲线（条目数下限 × 跨度下限 → 候选数）：5×30→169 · 10×30→81 · 20×30→**32** · 30×30→19。
 * 默认取 **20 条 × 30 天**：松于此会把几百个标签全报出来（等于没筛），紧于此会漏掉真实主题
 * （如 `#期货` 85 条、`#论文` 55 条这类中等规模但长期积累的主题）。两个参数都可调，
 * 且「调紧必须让候选数单调减少」是一条判据（K2）——防止参数被实现悄悄忽略。
 */

import type { Entry } from './types.ts'

/** 候选阈值（三参数都有默认值，但**默认值是裁决不是兜底**——见头注「阈值落点」） */
export interface ConsolidationConfig {
  /** 一个标签下至少多少条活跃条目（默认 20，依据：10×30→81 太多、30×30→19 太少） */
  minEntries: number
  /** 首末条目至少相隔多少天（默认 30，方案要「跨时间」；0 天会让单日批量写入冒充长期主题） */
  minDays: number
  /** 最多返回多少个候选（默认 12，按证据量降序） */
  limit: number
}

export const CONSOLIDATION_DEFAULTS: ConsolidationConfig = {
  minEntries: 20,
  minDays: 30,
  limit: 12,
}

/**
 * 层级分布——**固定五格而不是动态键**。
 *
 * 理由：本模块的输出要进工具的 `output.schema`（`additionalProperties: false`），动态键写不进去；
 * 而写不进去的键会被宿主整条拒收（v0.47 第八次同形的形态）。`other` 收纳未来新增的 kind，
 * 保证「五格之和 == 条目数」在任何 kind 出现时仍成立。
 */
export interface KindCounts {
  fact: number
  knowledge: number
  episodic: number
  summary: number
  other: number
}

/** 单个候选簇的证据量——只报「能数出来的」，不报「意味着什么」 */
export interface ClusterEvidence {
  /** 标签名（不含 #） */
  tag: string
  /** 该标签下的活跃条目数 */
  entries: number
  /** 首末条目相隔天数（0 = 全部同一天写入） */
  spanDays: number
  /** 最老 / 最新条目的日期（YYYY-MM-DD，来自 createdAt，缺失则 updatedAt） */
  firstAt: string
  lastAt: string
  /** 层级分布（五格之和恒等于 entries） */
  kinds: KindCounts
  /** 其中已有几条是 summary——被时间桶压缩顺手归纳过的迹象，>0 时该簇的「未归纳」程度下降 */
  summaryCovered: number
  /** 最新 3 条标题（证据样本，供人眼判断这簇是不是真主题） */
  recentTitles: string[]
}

/**
 * 这个标签是不是「主题」形态（而不是时间坐标）。
 *
 * 只认形态：`YYYY-MM-DD` / `YYYY-Www` / `YYYY-MM` / `YYYY` / 纯数字，都是坐标不是主题。
 * 语义判断（「任务板算主题吗」）不归这里——那是人读 recentTitles 时做的。
 * @param tag - 标签原文（不含 `#`）
 * @returns 主题形态为 true；时间坐标形态为 false
 */
export function isTopicTag(tag: string): boolean {
  const t = tag.trim()
  if (t.length === 0) return false
  if (/^\d+$/.test(t)) return false // 纯数字
  if (/^\d{4}$/.test(t)) return false // 年
  if (/^\d{4}-\d{1,2}$/.test(t)) return false // 月
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(t)) return false // 日
  if (/^\d{4}-[Ww]\d{1,2}$/.test(t)) return false // 周桶
  return true
}

/** 取条目的时间戳：优先 createdAt（写入时刻），缺失回落 updatedAt */
function stampOf(entry: Entry): string {
  return entry.createdAt || entry.updatedAt || ''
}

/** 把 ISO 字符串解析成毫秒；无法解析返回 null（**不猜**，当作缺失） */
function msOf(iso: string): number | null {
  if (iso.length === 0) return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

/**
 * 一组条目的时间跨度（天，向下取整）。
 *
 * 只用能解析的时间戳；**少于两个可解析时间戳时返回 0**——那不是「跨度为零的长期主题」，
 * 是「时间不可判」，调用方应结合 entries 数一起读（单条条目必然 0 天）。
 * @param entries - 任意条目集合
 * @returns 首末相隔天数
 */
export function spanDaysOf(entries: readonly Entry[]): number {
  const ms: number[] = []
  for (const e of entries) {
    const v = msOf(stampOf(e))
    if (v !== null) ms.push(v)
  }
  if (ms.length < 2) return 0
  return Math.floor((Math.max(...ms) - Math.min(...ms)) / 86_400_000)
}

/**
 * 找出够格的知识提炼候选（按条目数降序，同数按跨度降序）。
 *
 * 纯函数：不读配置、不落库、不改任何条目。`limit` 只截断返回条数，不影响排序。
 * @param entries - 活跃条目（调用方负责滤掉归档/删除；本函数不判生命周期）
 * @param config - 阈值，缺省见 {@link CONSOLIDATION_DEFAULTS}
 * @returns 候选簇（可能为空数组；空不等于「没有主题」，等于「没有够格的」）
 */
export function findConsolidationCandidates(
  entries: readonly Entry[],
  config: ConsolidationConfig = CONSOLIDATION_DEFAULTS,
): ClusterEvidence[] {
  const byTag = new Map<string, Entry[]>()
  for (const entry of entries) {
    for (const raw of entry.tags ?? []) {
      const tag = raw.trim().replace(/^#/, '')
      if (!isTopicTag(tag)) continue
      const bucket = byTag.get(tag)
      if (bucket === undefined) byTag.set(tag, [entry])
      else bucket.push(entry)
    }
  }

  const out: ClusterEvidence[] = []
  for (const [tag, group] of byTag) {
    if (group.length < config.minEntries) continue
    const spanDays = spanDaysOf(group)
    if (spanDays < config.minDays) continue

    const kinds: KindCounts = { fact: 0, knowledge: 0, episodic: 0, summary: 0, other: 0 }
    for (const e of group) {
      if (e.kind === 'fact') kinds.fact += 1
      else if (e.kind === 'knowledge') kinds.knowledge += 1
      else if (e.kind === 'episodic') kinds.episodic += 1
      else if (e.kind === 'summary') kinds.summary += 1
      else kinds.other += 1
    }

    // 首末按时间戳定，同时保留可读日期——两处口径同源（stampOf），不另取 createdAt
    let firstMs = Number.POSITIVE_INFINITY
    let lastMs = Number.NEGATIVE_INFINITY
    let firstAt = ''
    let lastAt = ''
    for (const e of group) {
      const s = stampOf(e)
      const ms = msOf(s)
      if (ms === null) continue
      if (ms < firstMs) {
        firstMs = ms
        firstAt = s.slice(0, 10)
      }
      if (ms > lastMs) {
        lastMs = ms
        lastAt = s.slice(0, 10)
      }
    }

    const recent = [...group]
      .sort((a, b) => {
        const am = msOf(stampOf(a)) ?? 0
        const bm = msOf(stampOf(b)) ?? 0
        return bm - am
      })
      .slice(0, 3)
      .map((e) => e.title)

    out.push({
      tag,
      entries: group.length,
      spanDays,
      firstAt,
      lastAt,
      kinds,
      summaryCovered: group.filter((e) => e.kind === 'summary').length,
      recentTitles: recent,
    })
  }

  out.sort((a, b) => (b.entries - a.entries) || (b.spanDays - a.spanDays) || a.tag.localeCompare(b.tag))
  return out.slice(0, Math.max(0, config.limit))
}
