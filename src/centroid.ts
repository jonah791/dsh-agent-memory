/**
 * 上下文重心（v0.7）——注入查询不是「最后一条消息」，而是「此刻这段对话在谈什么」。
 *
 * 动机（理念借自 VCPToolBox 的「引力」范式，实现是本插件的轻量版本）：
 *   原 auto-recall 以最后一条消息的**字面**为查询词。用户说「最近压力好大」，
 *   而三个月前提过的「考试」不会被召回——因为字面里没有那个词。
 *   实测反例（2026-09-15）：重启唤醒消息（"web 已重启，请继续"）注入的三条记忆
 *   全与当轮意图无关（双重重启事故/守护协议/哨兵拦截）。
 *
 * 做法：把最近 K 轮消息合成**加权词项集合**——
 *   turnWeight = decay^(距最新轮次的距离)，最新一条再乘 anchorBoost（锚点仍是最强信号）；
 *   每轮内同一词项只计一次（防单条长消息主导）；保留权重最高的 maxTerms 条。
 *
 * 纪律：
 *   - **分词单一真源**：复用 `search.ts` 的 `tokenizeQuery`（CJK bigram + 停用词），不另写一份；
 *   - **零回归兜底**：无历史 / 无有效词项 ⇒ 返回空数组，调用方退化为原行为（单条消息查询）；
 *   - 纯函数，离线可测（tests/centroid.test.mjs）。
 */

import { tokenizeQuery } from './search.ts'
import type { WeightedTerm } from './types.ts'

/** 重心参数（缺省见 DEFAULT_CENTROID_OPTIONS） */
export interface CentroidOptions {
  /** 最新一条消息的权重加成（它是当下意图，仍应最强） */
  anchorBoost?: number
  /** 每往前一轮的权重衰减系数 */
  decay?: number
  /** 保留词项数上限 */
  maxTerms?: number
  /** 单轮截断字符数（防长文把词项表冲爆） */
  maxCharsPerTurn?: number
}

/** 缺省参数：锚点 2.0 / 衰减 0.7 / 24 词项 / 单轮 400 字 */
export const DEFAULT_CENTROID_OPTIONS: Required<CentroidOptions> = Object.freeze({
  anchorBoost: 2.0,
  decay: 0.7,
  maxTerms: 24,
  maxCharsPerTurn: 400,
})

/**
 * 组装上下文重心（纯函数）。
 * @param turns - 历史消息文本（**由旧到新**，不含锚点那条）
 * @param anchor - 最新一条消息文本（可为空：无锚点时只按历史算）
 * @param options - 参数覆盖
 * @returns 加权词项（权重降序）；无有效词项返回空数组（调用方据此退化）
 */
export function buildCentroid(
  turns: readonly string[],
  anchor?: string,
  options: CentroidOptions = {},
): WeightedTerm[] {
  const opts = { ...DEFAULT_CENTROID_OPTIONS, ...options }
  const weights = new Map<string, number>()

  const addTurn = (text: string, turnWeight: number): void => {
    const trimmed = text.trim()
    if (trimmed.length === 0) return
    const limited = trimmed.length > opts.maxCharsPerTurn ? trimmed.slice(0, opts.maxCharsPerTurn) : trimmed
    const seen = new Set<string>()
    for (const term of tokenizeQuery(limited)) {
      if (seen.has(term)) continue // 每轮同一词项只计一次
      seen.add(term)
      weights.set(term, (weights.get(term) ?? 0) + turnWeight)
    }
  }

  // 历史：越新权重越高
  const n = turns.length
  for (let i = 0; i < n; i++) {
    const distance = n - 1 - i // 0 = 最新一轮历史
    addTurn(turns[i] as string, opts.decay ** (distance + 1))
  }
  // 锚点：当下意图
  if (anchor !== undefined) addTurn(anchor, opts.anchorBoost)

  return [...weights.entries()]
    .map(([term, weight]) => ({ term, weight: Math.round(weight * 1000) / 1000 }))
    .sort((a, b) => (b.weight !== a.weight ? b.weight - a.weight : a.term < b.term ? -1 : 1))
    .slice(0, opts.maxTerms)
}

/**
 * 从消息批次里挑出「可作重心素材」的文本（由旧到新）。
 * 只取有正文的消息；**排除工具结果与插件注入**（那些是系统产物，不是对话内容），
 * 但保留 AI 的回答——它承载着话题的延续。
 * @param messages - 批次消息（pre-step decision.messages）
 * @returns 文本数组（由旧到新）
 */
export function recentTurnTexts(messages: readonly unknown[], limit = 4): string[] {
  const texts: string[] = []
  for (const raw of messages) {
    const m = raw as {
      role?: string
      source?: { kind?: string; plugin?: string }
      content?: Array<{ type?: string; text?: string }>
    }
    if (m.role !== 'user' && m.role !== 'assistant') continue
    const kind = m.source?.kind
    // 工具结果（tool）与插件注入（plugin）不是对话内容；主人消息（user）与模型回答（model/assistant）才是
    if (kind !== undefined && kind !== 'user' && kind !== 'model') continue
    const text = (m.content ?? [])
      .filter((block) => block?.type === 'text')
      .map((block) => block?.text ?? '')
      .join('\n')
      .trim()
    if (text.length > 0) texts.push(text)
  }
  return texts.slice(-limit)
}
