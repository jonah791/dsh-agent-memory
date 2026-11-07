/**
 * 「转述型 · 无出处」标记（lh-d5e409bf · t-abdc2452 的最小落点）。
 *
 * 要解决的问题：我读了一篇论文 / 一份调研，然后写一条记忆。这条记忆**读起来像我的结论**，
 * 但它的权威其实来自别人。真正的危害不是「记了一条笔记」，而是**未来的我拿它当自己的判断用**
 * ——那时它已经和「我实测出来的结论」处在同一个库里、同一种语气。
 *
 * 两问必须分开问，合起来才有意义：
 *   ① 标题像不像「转述别人的东西」（精读 / 调研 / 评估 / 论文: / review / 调查 / 考据）
 *   ② 正文里有没有**可核的出处**（arXiv 编号）
 * 只有 ① 真 且 ② 假 才打标：**有出处的转述是可核查的**，不该被同等对待——那会把标记变成噪音。
 *
 * ⚠ 判据与 `scripts/memory-origin-audit.mjs` 同源，但**不是同一份文件**：
 * 那个脚本要在 clone 上直接跑（插件的编译产物 `lib/` 不进库），所以不能反向 import 本模块。
 * ⇒ 两侧各存一份正则源文本，由 `tests/origin.test.mjs` **逐字比对**锁住；任一侧改了没同步，测试红。
 * 这不是「两份真源」，是**一份真源 + 一个机械的对齐检查**（对不齐就响，不是靠记性）。
 *
 * 已知边界（如实标注，别读成「已判准」）：
 * - 正则只看标题与正文文本，判不出「这条到底是不是转述」——标题写「评估」但结论全是自产的，
 *   会被误标。所以文案是**提示着去看**，不是判决。
 * - 出处只认 arXiv 编号。引了网页 / 书 / 别人口述的转述，编号判据看不见（漏标，不是误标）。
 *   `scripts/memory-origin-audit.mjs` 里有同因的取舍记录（URL 只作对照、不计入）。
 */

/**
 * 正则**源文本**（两侧对齐的锚点）。改这里必须同步改脚本，否则 `tests/origin.test.mjs` 红。
 */
export const ORIGIN_PATTERN_SOURCES = {
  /** arXiv 编号（硬事实：正文真的写了这个编号） */
  arxiv: String.raw`arxiv[:\s]*\d{4}\.\d{4,5}(v\d+)?|arXiv:\s*\d{4}\.\d{4,5}`,
  /** 标题形态：转述型（内容主体是外部对象） */
  digestTitle: String.raw`(精读|深读|调研|评估|论文[：:]\s*\S|:\s*arXiv|review|调查|考据|考古)`,
} as const

const RE_ARXIV = new RegExp(ORIGIN_PATTERN_SOURCES.arxiv, 'i')
const RE_DIGEST_TITLE = new RegExp(ORIGIN_PATTERN_SOURCES.digestTitle, 'i')

/** 标题是转述型、且全文找不到可核出处 ⇒ true */
export function isTranscriptiveWithoutOrigin(title: string, body: string): boolean {
  const t = typeof title === 'string' ? title : ''
  if (!RE_DIGEST_TITLE.test(t)) return false
  const text = `${t}\n${typeof body === 'string' ? body : ''}`
  return !RE_ARXIV.test(text)
}

/** 全文是否含可核出处（当前只认 arXiv 编号——边界见文件头） */
export function hasOrigin(text: string): boolean {
  return RE_ARXIV.test(typeof text === 'string' ? text : '')
}

/**
 * **条目级**判定（v0.21.0）：`provenance` 有值时由它接管，无值时回退标题正则。
 *
 * 为什么加这一层：`provenance` 是**声明**，本文件的正则是**猜测**。声明比猜测准，
 * 而且能覆盖正则的已知盲区（引网页 / 书 / 口述的转述，编号判据看不见 ⇒ 漏标）：
 * 只要写明 `provenance: 'web'`，判据就从「标题像不像转述」变成「**它自己说的来源有没有
 * 可核出处**」——后者对网页类来源同样成立。
 *
 * 三种情形：
 * - `provenance: 'web'`      ⇒ 查出处。有编号/链接即不标；没有 ⇒ 标（**它确实没给出处**）
 * - `provenance` 为其他值     ⇒ **不标**。`master` 的权威是主人、`measured` 的权威是我自己
 *   的读数——它们不是「转述」，拿正则去判只会误标（标题写「评估」而结论是我实测的条目，
 *   正是文件头承认的那类误标）
 * - `provenance` 未标注       ⇒ 回退旧启发式（存量条目的既有行为，零回归）
 */
export function transcriptiveFlagOf(entry: {
  provenance?: import('./types.ts').Provenance
  title: string
  body: string
}): boolean {
  if (entry.provenance === 'web') return !hasOrigin(`${entry.title}\n${entry.body}`)
  if (entry.provenance !== undefined) return false
  return isTranscriptiveWithoutOrigin(entry.title, entry.body)
}

/**
 * 渲染标记（拼接用）：仅在判定为真时给文案，否则空串。
 *
 * 为什么用 `〔〕` 而不是 `[]`：同一行里已经有 `[fact@scope 相关度 N]` 这种方括号，
 * 再用方括号会读成同一个语法元素；`〔〕` 在视觉上明确是「警示」而不是「元数据」。
 */
export function transcriptiveTag(flag: boolean | undefined): string {
  return flag === true ? '〔转述型·无出处〕' : ''
}
