/**
 * 启动注入（DESIGN.md 注入设计 v2：目录化记忆速览）
 *
 * 会话首个 pre-step 注入一条 user message（每会话一次）：
 * - 常驻层：global 作用域的事实条目（L1 fact）全量——主人偏好/环境事实，数量天然少
 * - 轮廓层：当前 workspace 的概要条目（week/month/year，按时间降序）+ 近期明细
 *   （updatedAt 降序），按 inject.maxEntries 与 inject.maxBytes 预算截断
 *
 * 与 skill 目录注入同构：只注入「标题 + 时间 + tags」线索，正文按需 recall——
 * 目录由预算约束永不失控；概要在目录里承担高密度索引角色（时间金字塔红利）。
 *
 * 纯函数 buildMemoryDigest 离线可测；pre-step 挂载走 agent-instructions 同款
 * 瀑布监听器（await next() 后 fold 进 step 1 批次）。
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { Entry, MemoryConfig } from './types.ts'
import type { MemoryStore } from './store.ts'
import { workspaceIdOf, GLOBAL_SCOPE } from './scope.ts'
import { applyRoleView, narrowReadScopes, roleViewOf, type RoleCarrier } from './role.ts'
import { normalizeSubject, subjectTag } from './subject.ts'
import { executionTag } from './execution.ts'
import { groundingTag, normalizeGrounding } from './grounding.ts'
import { stalenessTag } from './temporal.ts'
import { supersededByTag } from './succession.ts'
import { expiryTag } from './temporal-dual.ts'
import { isInjectable, lifecycleOf, lifecycleTag } from './lifecycle.ts'
import { provenanceTag } from './archive.ts'
import { deriveSensitivity, isAutoInjectable } from './sensitivity.ts'
import { neutralizeControlTags, wrapInjectionBlock } from './inject-boundary.ts'

/**
 * 注入面准入（v0.47 · 方案 §11.2）：在生命周期准入之上叠敏感分级——`L2`/`L3` **不进自动注入**。
 *
 * 自动路径不经调用方判断（同 `misuse.ts` 的 C1 零容忍：这条路上出错我无从察觉），
 * 所以宁可少注入。未标注照旧进（不猜成 `L2`——那会让全部存量消失，见 `semantic.md` §5.38）。
 */
function isInjectableEntry(entry: Entry): boolean {
  return isInjectable(entry) && isAutoInjectable(deriveSensitivity(entry))
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-agent-memory': { kind: 'dsh-agent-memory' }
  }
}

/** 注入依赖：存储 + 配置加载（测试注入 mock） */
export interface MemoryInjectDeps {
  store: MemoryStore
  loadConfig: (workspaceRoot: string) => Promise<MemoryConfig> | MemoryConfig
}

/** 单行条目渲染：主体层标记 + 类型 + 层级 + 标题 + 时间 + tags（线索，不含正文） */
function lineOf(entry: Entry): string {
  const kind = entry.kind.toUpperCase()
  const level = entry.level !== null ? ` ${entry.level}` : ''
  const date = entry.updatedAt.slice(0, 10)
  const tags = entry.tags.length > 0 ? ` · ${entry.tags.join('/')}` : ''
  // 主体层标记（v0.13.0）：**只在有值时**出现——通用层留空（库里绝大多数是通用条目，
  // 全都打标记等于没打）。经归一而非直读：历史数据可能含别名或非法值，直读会渲染 `[undefined]`。
  const subject = subjectTag(normalizeSubject(entry.subject))
  // 约定状态标记（v0.14.0）：只凸显需警觉的（我的提议 / 限范围 / 已被否决）。
  // 速览是每个会话最先看到的东西，在这里标出来最划算——「我提的、主人没应」
  // 若不带标记，未来的我会把它读成主人说过的。
  const groundingNote = groundingTag(normalizeGrounding(entry.grounding))
  // 时效维标记（v0.15.0）：只凸显需警觉的档位（已过期 / 7 天内到期）。
  // 速览是每个会话最先看到的文本——把「这条结论的复查死线已过」摆在最前，
  // 成本是每行几字符，收益是我在**用**它之前就看见它该重看了。
  const expiryNote = expiryTag(entry.expiry, new Date())
  const stalenessNote = stalenessTag(entry.reviewAfter, new Date())
  // 执行位置标记（v0.23.0）：有值才打（通用条目留空——标记要挑着打）。
  // 速览是每个会话最先看到的东西，在这里标出的理由与 stalenessNote 同：
  // 「这条结论来自哪个项目」决定它适不适用——在期货工程里读到 alice 项目的结论，
  // 我该先想「这还成立吗」，而不是直接照做。
  const projectNote = executionTag(entry.project, entry.taskId)
  // 已过时标记（v0.24.0）：**放最前**——它比「已过期」更硬。记忆速览是每个会话最先看到的
  // 文本，一条已被新结论顶掉的条目若无标记地出现在这里，未来的我会把旧值当现状直接用。
  // ⚠ 刻意**不注入 validAfter**：速览有字节预算，而它只在「写作时刻 ≠ 生效时刻」时才
  // 改变我的判断（少数情形）；recall / memory_browse 里都能看到（同 auto-inject 不注入
  // watchFor 的理由：预算要花在会改变动作的信息上）。
  const supersededNote = supersededByTag(entry.supersededBy)
  // v0.50（方案 §16.2「每种记忆应当采用不同的调用规则」）：补齐 **recall 侧早就有、注入侧漏掉**
  // 的两处标记——`lifecycle=disputed`（❓存疑）与 `provenance=web/self`（[外部]/[自推]）。
  // 为什么这里最要紧：速览是每个会话最先看到的文本，而「存疑信息不该被当作确定事实说出来」
  // 此前在注入面**没有任何标记可依**（`lifecycle.ts` 的表格写着它可注入且该打标，
  // 实际只接在 tools.ts 一侧）。两处 tag 都遵循同一条信噪比纪律：只在有值时才出现。
  const lifecycleNote = lifecycleTag(lifecycleOf(entry))
  const provenanceNote = provenanceTag(entry.provenance)
  return `- ${lifecycleNote}${supersededNote}${expiryNote}${stalenessNote}${subject}${groundingNote}${provenanceNote}${projectNote}[${kind}${level}] ${entry.title}（${date}${tags}）`
}

/**
 * 组装记忆速览文本（纯函数）。
 * 顺序：常驻层（global fact 全量）→ 概要层（按 bucket 降序）→ 近期明细（updatedAt 降序）。
 * 预算：maxEntries 截断条目数；maxBytes 截断字符数（截断处提示省略）。
 * @param globalFacts - global 作用域事实条目（已过滤 archived）
 * @param scopeEntries - 当前 workspace 全部非归档条目
 * @param opts - 预算
 * @returns 完整速览文本（含帧标记）；空记忆返回空串
 */
export function buildMemoryDigest(
  globalFacts: Entry[],
  scopeEntries: Entry[],
  opts: { maxBytes: number; maxEntries: number },
): string {
  const sections: string[] = []
  const lines: string[] = []
  let omitted = 0

  // 常驻层：global fact 全量（数量少，预算内优先）
  // v0.27.0：注入只给 `isInjectable()` 的条目——`pending` 待审核**不进上下文**（候选区未过审核
  // 就自己挤进注入，等于跳过了候选区这个设计本身）；`archived` / `deleted` 同理。
  const facts = globalFacts.filter((e) => e.kind === 'fact' && isInjectableEntry(e))
  for (const entry of facts) lines.push(neutralizeControlTags(lineOf(entry)))

  // 概要层：summary 条目按 bucket 降序（高密度索引优先）
  const summaries = scopeEntries.filter((e) => e.kind === 'summary' && isInjectableEntry(e))
  summaries.sort((a, b) => (a.bucket ?? a.createdAt) < (b.bucket ?? b.createdAt) ? 1 : -1)

  // 近期明细：非 summary 按 updatedAt 降序
  const recents = scopeEntries.filter((e) => e.kind !== 'summary' && isInjectableEntry(e))
  recents.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))

  const budgeted = [...summaries, ...recents]
  for (const entry of budgeted) {
    if (lines.length >= opts.maxEntries + facts.length) {
      omitted += 1
      continue
    }
    lines.push(neutralizeControlTags(lineOf(entry)))
  }

  if (lines.length > 0) sections.push('【记忆速览】', ...lines)
  let body = sections.join('\n')
  if (omitted > 0) body += `\n（另有 ${omitted} 条未列出，可用 recall 或 memory_browse 查找）`
  // maxBytes 为完整速览正文预算（帧开销在外）；截断时保留省略提示
  if (body.length > opts.maxBytes) {
    const hint = '\n（已按预算截断，可用 recall 或 memory_browse 查找更多）'
    body = body.slice(0, Math.max(0, opts.maxBytes - hint.length)) + hint
  }
  if (body.length === 0) return ''
  return wrapInjectionBlock('从记忆库加载的相关记忆', body)
}

/**
 * 安装启动注入：会话首 pre-step（step 1）注入记忆速览，每会话一次。
 * 与 agent-instructions 的折叠方式一致：消息插入已认领批次之后。
 * @param ctx - 插件上下文（需要 agents 会话事件；pre-step 由 agent-loop 触发）
 * @param deps - 注入依赖
 */
export function installMemoryInject(ctx: Context, deps: MemoryInjectDeps): void {
  const injected = new Set<string>()

  ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    if (step !== 1) return decision
    if (injected.has(agent.session.id)) return decision
    const cwd = agent.session.header.cwd
    if (cwd === undefined) {
      injected.add(agent.session.id) // 无 cwd 的会话无法定位项目，跳过
      return decision
    }
    const config = await deps.loadConfig(cwd)
    if (!config.inject.enabled) {
      injected.add(agent.session.id)
      return decision
    }
    const scope = workspaceIdOf(cwd)
    // 角色视野（v0.5）：速览只给该调用者角色可见的条目；未启用 roles 时零过滤（与 v0.4 等价）
    const view = roleViewOf(config, { agent } as unknown as RoleCarrier)
    const scopes = narrowReadScopes([GLOBAL_SCOPE, scope], view, undefined)
    const globalFacts = scopes.includes(GLOBAL_SCOPE)
      ? applyRoleView(
        deps.store.list(GLOBAL_SCOPE).filter((entry) => entry.kind === 'fact' && isInjectableEntry(entry)),
        view,
      )
      : []
    const scopeEntries = applyRoleView(deps.store.list(scope), view)
    const digest = buildMemoryDigest(globalFacts, scopeEntries, {
      maxBytes: config.inject.maxBytes,
      maxEntries: config.inject.maxEntries,
    })
    if (digest.length === 0) {
      injected.add(agent.session.id)
      return decision
    }
    signal.throwIfAborted()
    const message = createUserMessage({
      content: [{ type: 'text', text: digest }],
      source: { kind: 'dsh-agent-memory' },
    })
    injected.add(agent.session.id)
    // 尾部追加（缓存友好）：动态注入统一放在批次末尾，避免插在历史中部破坏前缀缓存。
    return { kind: 'enter', messages: [...decision.messages, message] }
  })
}
