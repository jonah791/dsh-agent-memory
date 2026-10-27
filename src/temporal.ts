/**
 * 时效维（v0.15.0「执行时是否仍然有效」）—— 记忆的**复查死线**与**观察条件**。
 *
 * 动机（论文 Fresh at Decision, Stale at Action · arXiv:2610.18126v1 · 主人 2026-10-14 交办）：
 * 论文把「决策有效性」与「证据新鲜度」**分开**，并证明二者不等价——
 *
 *   ① **新鲜度天花板**（Prop. 1）：`Pr[f holds at ta] ≤ e^(-λ_f · Δact)`。
 *      执行间隙 Δact 内的信息变化决定了上限；**决策时刻再新鲜也突破不了它**
 *      （`ta − tv = Δfresh + Δact`，而 Δfresh ≥ 0 ⇒ 第一因子 ≤ 1）。
 *      多依赖时天花板更紧：`Pr[全部 fk 成立] ≤ exp(−Δact · Σλ_fk)`。
 *   ② **精度分解**（Eq. 3）：`A = (1−π)K + π[ρS + (1−ρ)L]`——
 *      π=应改变比例，ρ=**路由召回**，S=收到后切换率，L=没收到却切换率，K=应保留的保留率。
 *      路由器对比（App. A 闭式）：`A′−A = π(ρ′−ρ)(S−L) + (1−π)(K′−K)`
 *      ⇒ **判断强 ⇒ 召回主导；判断弱 ⇒ 暴露主导**。
 *   ③ **索引决定召回**（实测）：决策文本只达 37.5%（另一名字）/ 12.5%（上游实体）；
 *      加全 dossier 达 100% 但带 89 条陷阱；**加观察条件达 92.2% 且仅 20 条陷阱**。
 *   ④ **残余误差是时间判断**（P4）：Ministral 8B 与 Qwen3-235B **放弃全部**
 *      「变更已结束」的决策（保留 0.0%）——它们对「变更宣告」反应，**跳过「何时生效」的检查**。
 *      用**规则**做这个检查（time filter）把 Qwen3-235B 从 85.3% 提到 **92.0%**。
 *
 * **迁移到我的场景**（论文的「决策」在这里是什么）：
 * 我写下一条结论（技能读数 / 环境坐标 / 实测判据 / 裁决）时，那是 `td`；
 * **未来的我执行它**（加载技能、引用记忆、按它行事）时，那是 `ta`。
 * 中间的 Δact 可能是几天到几周——**库里的结论正是这样悄悄过期的**。
 * 论文的原话是：*freshness makes a decision right when it is made; routing and
 * temporal judgment keep it right when it is carried out.*
 *
 * 论文的三条设计原则（结论节逐字）→ 本模块的字段映射：
 *   ① 「record each decision with its times and **what it depends on**」→ `watchFor`
 *   ② 「route news to it **until its revision deadline**, through an index written
 *      when the decision is made」→ `reviewAfter`（死线）+ 写入时登记（**唯一时机**）
 *   ③ 「revalidate it by **checking when each change is in effect**」→ 人读 `watchFor` 时
 *      的检查动作（这一条**不落字段**，靠渲染把条件摆到眼前）
 *
 * **三个字段设计决定（每条附理由；理由不写下来，将来会被「对齐」掉）**：
 *
 *   1. **不做自动 router**（刻意不实现论文的核心部件之一）。
 *      理由：论文的 router 服务于「持续新闻流 × 大量开放决策」；而**我的输入流本身就是
 *      我的注意力**——`recall` 每轮都在把相关记忆拉到眼前，**recall 已经是路由器**。
 *      建一个「写入时拿新条目去比存量观察条件」的独立 router，在没有实测尸体前
 *      只是**无谓的暴露**（论文 P3：每次投递都是放弃正确决策的机会）。
 *      ⇒ 本版只让 `watchFor` **印在结果里**（免费路由：召回由现有检索负责，我只加"条件可见"）。
 *      ⚠ 这是**可推翻的**：若实测发现「该失效的条目从没被 recall 到」⇒ 那条尸体成立 ⇒ 补 router。
 *
 *   2. **不设默认死线**（判断不代填 · §2.4）。
 *      给每条记忆自动盖一个「90 天后复查」听起来省事，但那等于把**判断**写死在机制里：
 *      主人的偏好该永久有效，环境坐标该 30 天一看，两者被同一个默认值绑住 = 全错。
 *      **空是常态，填是例外**——只有我此刻判断「这条会腐化」时才填。
 *
 *   3. **到期 ≠ 作废，只 = 该重看**（不做自动失效/自动归档）。
 *      同 `grounding` 的立场：**移植的是可见性，不是拦截**（AGENTS.md §2.2 技术处置自主）。
 *      到期就自动归档会静默丢掉可能仍然正确的结论——而「更弱的实现能通过吗」这条自问
 *      （§5.9 规则 5）的答案是「能」，所以它拦不住任何东西，只会误伤。
 *
 * **与既有维度正交**（四维可任意组合）：
 *   - `role`       答「**谁写的**」（准入隔间）
 *   - `subject`    答「**关于谁的**」（语义标记）
 *   - `grounding`  答「**是否已被共同建立**」（来源性质标记）
 *   - `reviewAfter` / `watchFor` 答「**什么时候该重看 / 在等什么**」← 本模块
 *
 * ⚠ **本版如实保留的残留风险（不得粉饰）**：字段**可选**，缺省 = 无死线 = 永不亮标记。
 * 也就是说**不主动填就得不到保护**（与 `grounding` 同型的失败面）。对策只有两条：
 *   ① `remember` / `update` 提供参数，并在工具描述里写清**何时填**（不强制）；
 *   ② 提供 `recall({ staleness: 'expired' })` 这类**审查入口**，让我能把该看的捞出来。
 * ⇒ **退出判据**：若长期（≥2 周）新写入里带 `reviewAfter` 的比例 ≈ 0，
 *   说明这个维度没被用起来 ⇒ **撤掉或改形**，不留死字段充数。
 *
 * **日期口径（显式声明，防「日界」歧义）**：库内 `reviewAfter` **统一存 `YYYY-MM-DD`**，
 * 语义是「该 UTC **日结束前**复查」（解析成当日 `23:59:59.999Z`）。所有时间戳同为 UTC，
 * 与 `search.ts` 的 `normalizeSince` 一致。把 `+7d` 这类相对写法**在写入时就固化成绝对日期**
 * ——存相对值会让「什么时候到期」随「何时读取」漂移。
 *
 * 纯函数层：不依赖 Cordis / fs，离线可测（tests/temporal.test.mjs）。
 */

/**
 * 本模块只关心这两个字段——用**结构化入参**（duck typing）而非 `import type { Entry }`：
 *   ① 纯函数层不该依赖契约层（它只依赖自己实际用到的形状）；
 *   ② `types.ts` 要引本模块的 `StalenessLevel` ⇒ 反过来 import 会形成类型循环；
 *   ③ 泛型透传 ⇒ `filterByStaleness(entries: Entry[])` 仍返回 `Entry[]`（不丢型）。
 */
export interface TemporalCarrier {
  reviewAfter?: string
  watchFor?: string[]
}

/** 有效期判定档位（三态互斥；`undefined` 另表示「未设死线」） */
export type StalenessLevel = 'expired' | 'due-soon' | 'fresh'

/**
 * 「临近」窗口（天）——**启发式先验，不是实测值**。
 *
 * 取 7 天的理由：它是「我下次可能看到这条记忆」的典型间隔量级（周一的活到下周还记得）。
 * ⚠ 这是**猜的**，不是量出来的。要把它变成读数，需要统计「设了死线的条目两次被
 * recall 命中的间隔」——本版没有这个数据 ⇒ 标为启发式，等有读数再改。
 */
export const DUE_SOON_DAYS = 7

/** 规范档位（顺序即展示顺序：先警觉，后常态） */
export const STALENESS_LEVELS: readonly StalenessLevel[] = ['expired', 'due-soon', 'fresh']

/** 中文标签 */
export const STALENESS_LABELS: Record<StalenessLevel, string> = {
  expired: '已过期',
  'due-soon': '临近复查',
  fresh: '有效',
}

/** 未设死线在统计里的键名 */
export const UNTRACKED_STALENESS = 'untracked'

/** 观察条件条数上限（论文 INDIRECT 提示词写的是 3–8 条） */
export const MAX_WATCH_CONDITIONS = 8

/** 单条观察条件字符上限（超了 fail-loud，**不静默截断**——截断会把条件削成半个） */
export const MAX_WATCH_CHARS = 200

/** 相对写法允许的最大天数（10 年；防手滑写 `+999999d` 造出一个永不复查的死线） */
const MAX_RELATIVE_DAYS = 3650

const DAY_MS = 86_400_000
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const REL_RE = /^\+(\d+)([dw])$/
/** ISO 8601 日期时间（`YYYY-MM-DDThh:mm…`）的**形态**闸门——见 `parseStoredDeadline` 的收窄理由 */
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/

/** `Date` → `YYYY-MM-DD`（UTC 日） */
export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/**
 * 解析 `reviewAfter` 参数（**写入时**路径 · fail-loud）。
 *
 * 接受的写法（统一归一成 `YYYY-MM-DD`）：
 *   - `YYYY-MM-DD`：绝对日期
 *   - ISO 时刻（含 `T`，如 `2026-11-01T09:00:00Z`）：取其 UTC 日
 *   - `+Nd` / `+Nw`：相对**此刻** N 天 / N 周（写入时固化，不留相对值）
 *
 * @param raw - 工具参数原值
 * @param now - 基准时刻（相对写法用；由调用方注入 ⇒ 可测）
 * @param field - 报错里的字段名
 * @throws 非法值一律抛错——**不静默当「无死线」**：那正是本维度要防的失败
 *         （我以为标了、其实没标 ⇒ 未来的我照旧在用过期的结论）
 */
export function parseReviewAfterArg(raw: unknown, now: Date, field = 'reviewAfter'): string | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') {
    throw new Error(`${field}: 必须是字符串（YYYY-MM-DD / ISO 时刻 / +7d / +2w），实际类型 ${typeof raw}`)
  }
  const text = raw.trim()
  if (text.length === 0) return undefined

  const relative = REL_RE.exec(text)
  if (relative !== null) {
    const amount = Number(relative[1])
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error(`${field}: 相对写法必须是正数天/周，实际 ${JSON.stringify(raw)}`)
    }
    const days = relative[2] === 'w' ? amount * 7 : amount
    if (days > MAX_RELATIVE_DAYS) {
      throw new Error(`${field}: 相对写法上限 ${MAX_RELATIVE_DAYS} 天，实际 ${days} 天（${JSON.stringify(raw)}）`)
    }
    return isoDate(new Date(now.getTime() + days * DAY_MS))
  }

  if (DATE_RE.test(text)) {
    const parsed = Date.parse(`${text}T23:59:59.999Z`)
    if (!Number.isFinite(parsed)) throw new Error(`${field}: 日期不存在 ${text}`)
    // ⚠ JS 对 2026-02-30 这类**不存在的日期会静默滚到下月**（→ 3-02），
    // 只查 Number.isFinite 抓不住。⇒ 回读比对，滚动了就抛。（尸体样本见测试）
    const roundTrip = isoDate(new Date(parsed))
    if (roundTrip !== text) throw new Error(`${field}: 日期不存在 ${text}（被解析成 ${roundTrip}）`)
    return text
  }

  const parsed = Date.parse(text)
  if (Number.isFinite(parsed)) return isoDate(new Date(parsed))
  throw new Error(
    `${field}: 无法解析 ${JSON.stringify(raw)}——接受 YYYY-MM-DD（如 2026-11-01）`
    + ' / ISO 时刻（如 2026-11-01T09:00:00Z）/ 相对写法 +7d（天）或 +2w（周）',
  )
}

/**
 * 解析 `watchFor` 参数（**写入时**路径 · fail-loud）。
 *
 * 接受单条字符串或字符串数组（都归一成数组——只等一个事件是最常见的情形）。
 * 空数组 / 全空白 ⇒ 视为未给。
 *
 * @throws 条数超上限、单条超长、元素非字符串 —— 全部抛错（静默截断 = 条件被削掉一半）
 */
export function parseWatchForArg(raw: unknown, field = 'watchFor'): string[] | undefined {
  if (raw === undefined || raw === null) return undefined
  const list: unknown[] = Array.isArray(raw) ? raw : [raw]
  const out: string[] = []
  for (const item of list) {
    if (typeof item !== 'string') {
      throw new Error(`${field}: 每条观察条件必须是字符串，实际含 ${typeof item}`)
    }
    const text = item.trim()
    if (text.length === 0) continue
    if (text.length > MAX_WATCH_CHARS) {
      throw new Error(
        `${field}: 单条观察条件超过 ${MAX_WATCH_CHARS} 字符（实际 ${text.length}）——`
        + '请写成一句可判断的短句（如「DuckDuckGo 通道可用率重测低于 80%」）',
      )
    }
    out.push(text)
  }
  if (out.length === 0) return undefined
  if (out.length > MAX_WATCH_CONDITIONS) {
    throw new Error(`${field}: 最多 ${MAX_WATCH_CONDITIONS} 条（论文用 3–8 条），实际 ${out.length} 条`)
  }
  return out
}

/**
 * 容错归一（**服务通道**路径 · 不抛）——与 `normalizeSubject` / `normalizeGrounding` 对称。
 *
 * 与 `parseReviewAfterArg` 分流的理由同 `subject.ts`：**工具参数**是「我此刻的意图」
 * （拼错必须当场知道），而**服务通道**（`memoryApi.remember`，供 emotion / taskboard /
 * evolution-core / skill-forge 回流）的契约是「**不阻塞调用方业务**」——
 * 为一个标注字段让整笔回流失败不划算。
 */
export function normalizeReviewAfter(raw: unknown, now: Date): string | undefined {
  try {
    return parseReviewAfterArg(raw, now)
  } catch {
    return undefined
  }
}

/** 容错归一（服务通道路径 · 不抛）——理由同 `normalizeReviewAfter`。 */
export function normalizeWatchFor(raw: unknown): string[] | undefined {
  try {
    return parseWatchForArg(raw)
  } catch {
    return undefined
  }
}

/**
 * 读取路径的死线解析（**容错**）：认不出的历史值返回 `undefined`，不抛。
 *
 * 与 `parseReviewAfterArg` 分流，理由同 `subject.ts`：**参数**是「我此刻的意图」
 * （拼错必须当场知道），**历史数据**是既成事实（读到脏值不该让整次检索崩掉）。
 */
export function parseStoredDeadline(raw: unknown): number | undefined {
  if (typeof raw !== 'string') return undefined
  const text = raw.trim()
  if (text.length === 0) return undefined
  if (DATE_RE.test(text)) {
    const parsed = Date.parse(`${text}T23:59:59.999Z`)
    if (!Number.isFinite(parsed)) return undefined
    // 同写入侧：滚动的假日期当认不出处理
    return isoDate(new Date(parsed)) === text ? parsed : undefined
  }
  // ⚠ 兜底**刻意收窄**：只认 ISO 8601 的 `YYYY-MM-DDThh:mm…` 形态，**不**把任意字符串
  // 交给 `Date.parse`。
  //
  // 理由（**形态白名单优于引擎启发式**）：`Date.parse` 接受的东西远广于 ISO——自然语言日期
  // （`'Nov 1 2026'`）、斜杠格式（`'2026/11/01'`）它都收。一旦这些也能成为有效死线，
  // 「**什么算合法死线**」就有了第二个真源（我们定义的 vs V8 启发式认的），而库里
  // 会开始出现两种形态的日期。写入侧只产生 `YYYY-MM-DD` ⇒ 收窄是**零损失**的。
  //
  // ⚠ 诚实标注（**2026-10-14 初版注释在此写错过一次，勿复现**）：收窄**不是**为了防
  // `'+3d'` 被解析成过去的时间戳——实测 `Date.parse('+3d')` 返回 **NaN**，它本来就走不通。
  // 那次误判来自测试夹具（用相对写法直写库拿不到 due-soon 档），我一度把夹具的错
  // 归因成实现的缺陷。**结论（收窄）保留，理由已改写**：真实理由只有上面那条白名单理由。
  if (ISO_DATETIME_RE.test(text)) {
    const parsed = Date.parse(text)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/**
 * 有效期判定。
 *
 * ⚠ **与 `daysUntil` 同口径（日差，UTC 日粒度）**——两处必须一致，否则「7 天内到期」
 * 会在一个函数里算 due-soon、在另一个里已成 fresh（同一判据两个真源）。
 * 定成日差而非时刻差的理由：它可解释——「7 天内到期」就是今天到第 7 天这七个日子。
 *
 * @param reviewAfter - 条目的复查死线（`YYYY-MM-DD`）
 * @param now - 当前时刻
 * @returns 档位；**`undefined` = 没设死线 ⇒ 不判**（空是常态，不亮标记）
 */
export function stalenessOf(reviewAfter: unknown, now: Date): StalenessLevel | undefined {
  const days = daysUntil(reviewAfter, now)
  if (days === undefined) return undefined
  if (days < 0) return 'expired'
  if (days <= DUE_SOON_DAYS) return 'due-soon'
  return 'fresh'
}

/**
 * 死线还剩几天（**UTC 日粒度**：死线所在 UTC 日 − 此刻所在 UTC 日）。
 *
 * - `0` = 今天到期 · `1` = 明天 · `-3` = 已过期 3 天 · `undefined` = 未设死线
 *
 * 口径显式（不问「哪一天的 0 点」）：两个 UTC 日相减，与库内其余时间戳一致。
 */
export function daysUntil(reviewAfter: unknown, now: Date): number | undefined {
  const deadline = parseStoredDeadline(reviewAfter)
  if (deadline === undefined) return undefined
  const deadlineDay = Math.floor(deadline / DAY_MS)
  const nowDay = Math.floor(now.getTime() / DAY_MS)
  return deadlineDay - nowDay
}

/**
 * 渲染标记（拼接用）：**只对需警觉的档位**打标记，`fresh` 与「未设死线」都给空串。
 *
 * 为什么 fresh 不打标记：库里绝大多数条目要么没死线、要么离死线还远——全打标记
 * 等于没打（`subjectTag` / `groundingTag` 的同一条教训：**标记要挑着打**）。
 */
export function stalenessTag(reviewAfter: unknown, now: Date): string {
  const level = stalenessOf(reviewAfter, now)
  if (level === undefined || level === 'fresh') return ''
  const days = daysUntil(reviewAfter, now) ?? 0
  if (level === 'expired') {
    return days === 0 ? '[⚠已过期]' : `[⚠已过期${Math.abs(days)}天]`
  }
  return days <= 0 ? '[⚠今日复查]' : `[⚠${days}天后复查]`
}

/**
 * 观察条件渲染（拼接用）：空数组 / 未给 ⇒ 空串。
 *
 * 论文的用法是**把条件摆到决策眼前**（它用条件做路由索引）；我把它印在 recall 结果里
 * ——命中即看见「这条在等什么」，**读的人是我**，由我判断此刻是否正撞上那个事件。
 */
export function watchForTag(watchFor: unknown): string {
  if (!Array.isArray(watchFor) || watchFor.length === 0) return ''
  const items = watchFor.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  if (items.length === 0) return ''
  return `⚠观察条件：${items.join(' / ')}`
}

/**
 * 渲染「情境形状」（v0.16.0）——与 `watchForTag` 同形，回答的是另一件事。
 *
 * `aliases` 决定**能不能被找到**，`cue` 决定**找到之后我会不会意识到「这就是它适用的处境」**。
 * 两者都印出来，命中那一刻我同时看见「它会怎么被问」与「什么处境该用它」——
 * 论文依据（Harness² 的 experience cue，arXiv:2610.14224 §H Prompt 6）：cue 写的是情境的
 * **形状**，因而能在另一件事上触发。
 *
 * @param cue - 条目的 cue 字段（未知形状，运行时校验）
 * @returns 渲染行；空/无 ⇒ 空串（调用方据此跳过）
 */
export function cueTag(cue: unknown): string {
  if (!Array.isArray(cue) || cue.length === 0) return ''
  const items = cue.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  if (items.length === 0) return ''
  return `◎适用处境：${items.join(' / ')}`
}

/** 有效期计数（memory_stats / 体检用）：三档 + 未设死线 */
export function countByStaleness(
  entries: readonly TemporalCarrier[],
  now: Date,
): Record<StalenessLevel | typeof UNTRACKED_STALENESS, number> {
  const counts: Record<StalenessLevel | typeof UNTRACKED_STALENESS, number> = {
    expired: 0,
    'due-soon': 0,
    fresh: 0,
    [UNTRACKED_STALENESS]: 0,
  }
  for (const entry of entries) {
    const level = stalenessOf(entry.reviewAfter, now)
    if (level === undefined) counts[UNTRACKED_STALENESS] += 1
    else counts[level] += 1
  }
  return counts
}

/**
 * 解析 `staleness` 过滤参数（**查询时**路径 · fail-loud）。
 *
 * 与 `parseSubjectArg` / `parseGroundingArg` 同纪律：参数是「我此刻的意图」，
 * 拼错必须当场知道——静默忽略等于「我以为筛了、其实看的是全库」。
 */
export function parseStalenessFilterArg(raw: unknown, field = 'staleness'): StalenessLevel[] | undefined {
  if (raw === undefined || raw === null) return undefined
  const list: unknown[] = Array.isArray(raw) ? raw : [raw]
  const out: StalenessLevel[] = []
  for (const item of list) {
    if (typeof item !== 'string') {
      throw new Error(`${field}: 档位必须是字符串（${STALENESS_LEVELS.join(' / ')}），实际含 ${typeof item}`)
    }
    const text = item.trim().toLowerCase()
    if (text.length === 0) continue
    if (!(STALENESS_LEVELS as readonly string[]).includes(text)) {
      throw new Error(`${field}: 未知档位 ${JSON.stringify(item)}——合法值只有 ${STALENESS_LEVELS.join(' / ')}`)
    }
    out.push(text as StalenessLevel)
  }
  return out.length > 0 ? out : undefined
}

/**
 * 按有效期档位筛条目（**可选筛子**，不是准入——同 subject / grounding）。
 *
 * 典型用法：`recall({ staleness: 'expired' })` = 「**我的哪些结论该重看了**」（审查入口）。
 *
 * @param entries - 候选条目
 * @param levels - 目标档位（可多选）；**`undefined` = 不过滤**（原样返回同一数组引用）
 */
export function filterByStaleness<T extends TemporalCarrier>(
  entries: T[],
  levels: StalenessLevel[] | undefined,
  now: Date,
): T[] {
  if (levels === undefined || levels.length === 0) return entries
  const wanted = new Set(levels)
  return entries.filter((entry) => {
    const level = stalenessOf(entry.reviewAfter, now)
    return level !== undefined && wanted.has(level)
  })
}

/**
 * 汇总结论（自审用）：库里有多少条该重看了。
 *
 * 入参**故意放宽**成 `Record<string, unknown>`：调用点是工具 render 层，那里拿到的是
 * output schema 推断出的弱类型对象（`Record<string, JsonValue>`）——写死强类型会逼出
 * 一串 `as` 断言。改为**容错读取**：键缺失 / 非数字当 0（读路径容错，同 `parseStoredDeadline`）。
 * 键名不硬编码，走 `STALENESS_LEVELS` 常量 ⇒ **单一真源**，加档位时不会漏改这里。
 *
 * @returns 人可读的一行，供审查场景直接贴出
 */
export function stalenessVerdict(counts: Readonly<Record<string, unknown>>): string {
  const read = (key: string): number => {
    const raw = counts[key]
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0
  }
  const byLevel = new Map<StalenessLevel, number>()
  for (const level of STALENESS_LEVELS) byLevel.set(level, read(level))
  const untracked = read(UNTRACKED_STALENESS)

  const expired = byLevel.get('expired') ?? 0
  const dueSoon = byLevel.get('due-soon') ?? 0
  const fresh = byLevel.get('fresh') ?? 0
  const tracked = expired + dueSoon + fresh
  const total = tracked + untracked
  if (total === 0) return '库里没有条目。'
  if (tracked === 0) {
    return `时效维：${total} 条**全部未设复查死线**——`
      + '该维度的退出判据正在逼近（长期无人填 ⇒ 撤或改形，见 src/temporal.ts 文件头）。'
  }
  const parts = [`已过期 ${expired}`, `${DUE_SOON_DAYS} 天内到期 ${dueSoon}`, `有效 ${fresh}`]
  const alerts: string[] = []
  if (expired > 0) {
    alerts.push(`⚠ **${expired} 条已过复查死线**——去核实它们是否还成立（recall({ staleness: 'expired' }) 取回），核实后 update 改内容并续死线或清除。`)
  }
  if (dueSoon > 0) {
    alerts.push(`${dueSoon} 条 ${DUE_SOON_DAYS} 天内到期。`)
  }
  return `时效维：${parts.join(' · ')}（已设死线 ${tracked} / 未设 ${untracked}，共 ${total}）。`
    + (alerts.length > 0 ? ' ' + alerts.join(' ') : '')
}
