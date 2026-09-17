/**
 * 工具注册（IMPLEMENTATION.md §4 / DESIGN.md §八）——六工具：
 * remember / recall / update / forget / memory_stats / memory_check。
 *
 * 取证结论（2026-08-14，注册方式已回写 IMPLEMENTATION.md §4）：
 * 采用官方 tool-fs（packages/fs/tool-fs/src/read.ts:76）与 dsh-agent-teams
 * （src/tools.ts:125）同款的函数插件形态：inject 'tools' 服务 + ctx.tools.register(defineTool(...))，
 * 经 bundle 挂载进 host 组合（T7 接线）。当前会话 workspace 取自
 * exec.agent.session.header.cwd（见 scope.ts 取证）。
 *
 * 质量协议（写入工具 description，模型视角）：
 * 记事实 / 可复用知识 / 有结果的情景；不记临时状态 / 文件可索引内容 / 凭证。
 */

import type { Context } from '@deepseek-ai/cordis'
import { readFileSync, statSync } from 'node:fs'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Entry, EntryKind, MemoryConfig, RememberResult, Revision } from './types.ts'
import { loadMemoryConfig, memoryConfigPath } from './config.ts'
import { resolveScopes, sessionCwdOf } from './scope.ts'
import type { EntryPatch, MemoryStats, MemoryStore } from './store.ts'
import { statsOf, titleFingerprint } from './store.ts'
import type { AccessSummary } from './access-trace.ts'
import type { CompressSummary } from './compress-trace.ts'
import { formatSkipped } from './compress-trace.ts'
import { browseEntries, bucketLabel } from './search.ts'
import { recallEntries, relatedOf, relateClosure } from './search.ts'
import { applyRoleView, narrowReadScopes, roleViewOf, sessionHeaderOf, sessionIdOf, type RoleView } from './role.ts'
import { auditMemory } from './audit.ts'

/** 工具依赖：存储 + 配置加载（单测注入 mock 用） */
export interface MemoryToolDeps {
  /** 记忆存储（T7 用 storage-domain kv 表构造 MemoryStore） */
  store: MemoryStore
  /** 配置加载：workspace 根目录 → MemoryConfig；缺省读 <root>/.dsh/memory.yml */
  loadConfig?: (workspaceRoot: string) => Promise<MemoryConfig> | MemoryConfig
  /** 懒压缩钩子（T7 接线：TimelineCompressor.compressPending；访问记忆时补压上一自然单位，DESIGN.md §五） */
  compress?: (scope: string, agent?: Agent) => Promise<void>
  /**
   * 侧车用量轨迹写入（v0.6；缺省不落盘）。
   * 实现方负责「只追加 / 吞错 / 按体积轮转」——工具层只负责把命中 id 交出去。
   */
  recordAccess?: (record: { atMs: number; source: 'recall' | 'auto' | 'audit'; role?: string; ids: string[] }) => Promise<boolean> | void
  /** 侧车轨迹读取（体检用；缺省/读失败 ⇒ undefined = 无用量信号） */
  readAccess?: () => Promise<Map<string, { hits: number; lastAtMs: number }> | undefined>
  /** 用量轨迹汇总（v0.7 命中率度量：注入次数 / 主动检索次数；缺省不报） */
  readAccessSummary?: () => Promise<AccessSummary | undefined>
  /** 提案日志写入（v0.7：让提案有历史——audit 候选 + forget/update 动作同文件可 join；吞错） */
  recordProposal?: (record: unknown) => Promise<boolean> | void
  /**
   * 压缩流水线轨迹汇总（v0.8 §5.12：五问里 ③「断在哪一段」的答案面）。
   * 缺省不报——工具层只展示，不判定。
   */
  readCompressSummary?: () => Promise<CompressSummary | undefined>
}

/** 缺省配置加载器：读取 .dsh/memory.yml，缺失走默认，非法 fail loud */
async function loadConfigDefault(workspaceRoot: string): Promise<MemoryConfig> {
  return loadMemoryConfig(memoryConfigPath(workspaceRoot))
}

/** 会话载体类型（roleViewOf / sessionHeaderOf 的鸭子类型输入） */
type RoleCarrierLike = Parameters<typeof roleViewOf>[1]

/**
 * 一次调用的运行时上下文：解析出的配置 + 会话 cwd + **调用者视野**（v0.5）。
 * 视野在唯一的入口处解析一次，所有读路径共用——避免各工具各推导一遍角色。
 * @param roleOverride - 工具参数显式指定的角色（最高优先）
 */
async function resolveRuntime(
  exec: ToolRunContext,
  deps: MemoryToolDeps,
  roleOverride?: string,
): Promise<{ config: MemoryConfig; cwd: string | undefined; view: RoleView }> {
  const cwd = sessionCwdOf(exec)
  const loader = deps.loadConfig ?? loadConfigDefault
  const config = await loader(cwd ?? process.cwd())
  const view = roleViewOf(config, exec as unknown as RoleCarrierLike, roleOverride)
  return { config, cwd, view }
}

/**
 * 写路径的角色盖章（v0.5）：
 * - `role` 只在**角色维度启用**或调用方**显式指定**时盖章——缺省不盖章 = 共享记忆（迁移安全：
 *   存量条目与未启用角色的项目行为不变）；
 * - `author` 无条件记录（溯源，与可见性无关）。
 */
function roleStampOf(
  exec: ToolRunContext,
  config: MemoryConfig,
  explicitRole: string | undefined,
): { role?: string; author: Entry['author'] } {
  const view = roleViewOf(config, exec as unknown as RoleCarrierLike)
  const header = sessionHeaderOf(exec as unknown as RoleCarrierLike)
  const sessionId = sessionIdOf(exec as unknown as RoleCarrierLike)
  const author: Entry['author'] = {
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(header?.delegationDepth !== undefined ? { delegationDepth: header.delegationDepth } : {}),
    ...(header?.agentPreset !== undefined ? { preset: header.agentPreset } : {}),
  }
  const explicit = explicitRole?.trim()
  const role = explicit !== undefined && explicit.length > 0
    ? explicit
    : (view.enabled ? view.role : undefined)
  return { ...(role !== undefined ? { role } : {}), author }
}

/**
 * 记录一次显式动作到提案日志（v0.7 §5.11 的动作侧；吞错，绝不影响主流程）。
 * 与 `memory_audit` 写的 `audit` 记录同文件，可按 id join ⇒ 为权重校准攒「提案 vs 采纳」样本。
 */
function recordAction(
  deps: MemoryToolDeps,
  config: MemoryConfig,
  record: { action: 'forget' | 'update'; id: string; reason?: string; mode?: string },
): void {
  if (config.audit?.proposalLog?.enabled !== true || deps.recordProposal === undefined) return
  void deps.recordProposal({ atMs: Date.now(), kind: 'action', ...record })
}

/**
 * 读路径统一取数：作用域合并 → 视野收窄 → 角色准入过滤（v0.5）。
 * 所有读工具（recall / browse / relate / stats）必须走这里——**单点过滤**，
 * 否则「recall 过滤了但 browse 没过滤」= 隔离是假的。
 */
function gatherReadable(
  deps: MemoryToolDeps,
  opts: { readScopes: string[]; includeArchive: boolean; view: RoleView; explicitScope?: string },
): { entries: Entry[]; scopes: string[] } {
  const scopes = narrowReadScopes(opts.readScopes, opts.view, opts.explicitScope)
  const entries = scopes.flatMap((scope) => deps.store.list(scope, { includeArchive: opts.includeArchive }))
  return { entries: applyRoleView(entries, opts.view), scopes }
}

/** action → 中文文案（工具 render 用） */
const ACTION_TEXT: Record<RememberResult['action'], string> = {
  created: '创建',
  updated: '更新',
  merged: '合并',
}

/** 标题最大长度（超长截断加省略号） */
const TITLE_MAX = 80

/** 正文 → (标题, 正文)：首行作标题，全文作正文（正文保留 markdown 全文，检索不丢内容） */
function splitText(text: string): { title: string; body: string } {
  const body = text.trim()
  const firstLine = body.split(/\r?\n/).find((line) => line.trim().length > 0) ?? body
  const base = firstLine.trim()
  const title = base.length > TITLE_MAX ? base.slice(0, TITLE_MAX - 1) + '…' : base
  return { title, body }
}

/** 在多个作用域中按 id 定位条目（update/forget 用；id 全局唯一，跨 scope 找） */
function findEntry(store: MemoryStore, scopes: string[], id: string) {
  for (const scope of scopes) {
    const entry = store.get(scope, id)
    if (entry !== undefined) return entry
  }
  return undefined
}

/** 计数合并（memory_stats 跨作用域聚合用） */
function mergeCounts(target: Record<string, number>, source: Record<string, number>): void {
  for (const [key, value] of Object.entries(source)) {
    target[key] = (target[key] ?? 0) + value
  }
}

/** 构建 remember 工具 */
function buildRemember(deps: MemoryToolDeps): ToolDefinition {
  return defineTool({
    name: 'remember',
    description: '记录一条记忆。适用于：事实（主人偏好/环境事实/决策结论）、可复用知识（项目知识/学习沉淀/教训）、有结果的情景（重要事件/经历时间线）。不记录：临时状态、文件可索引内容（代码/文档全文）、凭证（密钥/口令）。L1 事实可用 key 精确覆盖（同 key 再次写入=更新）；L2/L3 同标题自动合并（标签并集+正文追加）。',
    parameters: {
      text: { type: 'string', required: true, description: '记忆内容（markdown；首行自动作为标题）。' },
      key: { type: 'string', description: 'L1 精确覆盖键：同一 (scope, key) 再次写入 = 覆盖更新。' },
      kind: { type: 'string', enum: ['fact', 'knowledge', 'episodic'], description: '层级：fact=事实 / knowledge=知识 / episodic=情景。缺省 knowledge。' },
      tags: { type: 'array', items: { type: 'string' }, description: '检索标签（可选）。' },
      scope: { type: 'string', description: '写入作用域覆盖：global 或 workspaceId（缺省按项目 memory.yml 路由）。' },
      role: { type: 'string', description: '角色归属（v0.5 多智能体工作台）：条目归属的角色隔间。缺省时——项目启用 roles 则盖调用者角色，否则为共享记忆（所有角色可见）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          action: { type: 'string', enum: ['created', 'updated', 'merged'], required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `已${ACTION_TEXT[value.action]}记忆条目 ${value.id}（${args.kind ?? 'knowledge'}）`,
      }],
    },
    async execute(args, exec) {
      const { config, cwd } = await resolveRuntime(exec, deps)
      const text = (args.text ?? '').trim()
      if (text.length === 0) throw new Error('remember: text 不能为空')
      const kind = args.kind ?? 'knowledge'
      // 层级受项目配置约束（layers 声明本项目记忆形态）
      if (!config.layers.includes(kind)) {
        throw new Error(`remember: 本项目 memory.yml 未启用 ${kind} 层（layers: ${config.layers.join(' / ')}），请改用已启用层或调整配置`)
      }
      const tags = args.tags ?? []
      const { writeScope } = resolveScopes({ configScope: config.scope, cwd, explicit: args.scope })
      const { title, body } = splitText(text)
      // max_entries 守卫：仅当会新建时拦截（更新/合并不受限）
      const active = deps.store.list(writeScope)
      const wouldCreate = !(
        (args.key !== undefined && active.some((entry) => entry.key === args.key))
        || ((kind === 'knowledge' || kind === 'episodic')
          && active.some((entry) => entry.kind === kind && titleFingerprint(entry.title) === titleFingerprint(title)))
      )
      if (wouldCreate && active.length >= config.maxEntries) {
        throw new Error(`remember: ${writeScope} 已达 max_entries(${config.maxEntries})，请先 forget 归档旧条目或调高配置`)
      }
      return deps.store.remember({
        kind,
        key: args.key,
        title,
        body,
        tags,
        scope: writeScope,
        level: null,
        bucket: null,
        ...roleStampOf(exec, config, args.role),
      })
    },
  })
}

/** 构建 recall 工具 */
function buildRecall(deps: MemoryToolDeps): ToolDefinition {
  return defineTool({
    name: 'recall',
    description: '检索记忆。按关键词/层级/标签/时间过滤，按相关度（标签命中 > 标题命中 > 正文命中）与新鲜度排序；每个结果附带「相关链」（related：共享标签/标题/正文关联的记忆，因果留痕维度）。结果标注来源作用域（global 或 workspaceId）与压缩层级（周概要/月概要等）。缺省检索当前项目 + global（全局记忆永远附加，来源在 scope 字段标注）。',
    parameters: {
      query: { type: 'string', description: '检索关键词（多个词空格分隔，任一命中即计分；省略则按新鲜度排序）。' },
      kind: { type: 'array', items: { type: 'string', enum: ['fact', 'knowledge', 'episodic', 'summary'] }, description: '层级过滤（任一命中）。' },
      tags: { type: 'array', items: { type: 'string' }, description: '标签过滤（全部命中）。' },
      since: { type: 'string', description: '起始时间（ISO 时间或 YYYY-MM-DD，按创建时间过滤）。' },
      until: { type: 'string', description: '截止时间（ISO 时间或 YYYY-MM-DD）。' },
      scope: { type: 'string', description: '作用域覆盖：global 只查全局；workspaceId 跨项目查（global 仍附加）。' },
      limit: { type: 'integer', description: '返回条数上限（缺省 20）。' },
      includeArchive: { type: 'boolean', description: '是否包含已归档条目（缺省 false）。' },
      role: { type: 'string', description: '角色视角覆盖（v0.5）：以指定角色检索。缺省 = 按调用者会话身份推导（人类会话→主脑角色；子代理/队员→派生角色）。仅当项目启用 roles 时生效。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                title: { type: 'string', required: true },
                snippet: { type: 'string', required: true },
                tags: { type: 'array', required: true, items: { type: 'string' } },
                scope: { type: 'string', required: true },
                level: { oneOf: [{ type: 'string', enum: ['day', 'week', 'month', 'year'] }, { type: 'null' }], required: true },
                score: { type: 'number', required: true },
                archived: { type: 'boolean', required: true },
                updatedAt: { type: 'string', required: true },
                related: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      id: { type: 'string', required: true },
                      kind: { type: 'string', required: true },
                      title: { type: 'string', required: true },
                      scope: { type: 'string', required: true },
                      sharedTags: { type: 'number', required: true },
                      strength: { type: 'number', required: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
      render: (args, value) => {
        const lines = value.results.map((item) => {
          const levelNote = item.level !== null ? `（${item.level}概要）` : ''
          const relatedNote = item.related !== undefined && item.related.length > 0
            ? ' → 关联: ' + item.related.map((r) => r.title).join(' / ')
            : ''
          return `- [${item.kind}@${item.scope}${levelNote} 相关度${item.score}] ${item.title}${relatedNote}`
        })
        return [{
          type: 'text',
          text: [`命中 ${value.total} 条，返回 ${value.results.length} 条：`, ...lines].join('\n'),
        }]
      },
    },
    async execute(args, exec) {
      const { config, cwd, view } = await resolveRuntime(exec, deps, args.role)
      const { readScopes } = resolveScopes({ configScope: config.scope, cwd, explicit: args.scope })
      // 懒压缩（DESIGN.md §五）：访问记忆时补压上一自然单位；fire-and-forget，失败静默（幂等保证下次重试）
      for (const scope of readScopes) {
        if (deps.compress !== undefined) void deps.compress(scope, exec.agent).catch(() => {})
      }
      const includeArchive = args.includeArchive ?? false
      // 取数：作用域合并 → 视野收窄 → 角色准入过滤（v0.5 单点过滤）→ 检索管道
      const { entries } = gatherReadable(deps, { readScopes, includeArchive, view, explicitScope: args.scope })
      const result = recallEntries(entries, {
        query: args.query,
        kind: args.kind,
        tags: args.tags,
        since: args.since,
        until: args.until,
        limit: args.limit,
        includeArchive,
      })
      // 侧车用量轨迹（v0.6）：只交出命中 id，**绝不改条目**；失败静默（吞错在实现方）
      if (config.audit?.accessTrace?.enabled === true && deps.recordAccess !== undefined && result.results.length > 0) {
        void deps.recordAccess({
          atMs: Date.now(),
          source: 'recall',
          role: view.role,
          ids: result.results.map((item) => item.id),
        })
      }
      return result
    },
  })
}

// ---------- v0.9：遗忘与修改的执行原语（纯函数，单测直接测） ----------

/** 批量遗忘单次上限（护栏：误传 tier 不会一次清空全库） */
export const MAX_BULK_FORGET = 500
/** 批量遗忘缺省上限 */
export const DEFAULT_BULK_FORGET = 100
/** 每条例目保留的修订快照数（旧→新，超出丢最旧） */
export const MAX_REVISIONS = 3

/** 子串出现次数（patch 唯一性判据） */
export function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0
  let count = 0
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at === -1) return count
    count += 1
    from = at + needle.length
  }
}

/**
 * 文本改写模式（v0.9 纯函数）：
 * - `replace`：text 首行 → 标题、其余 → 正文（v0.8 行为，零回归）
 * - `append`：text 追加到正文末尾（标题不动）
 * - `patch`：在正文（正文不中则标题）把 find 换成 replace——**要求唯一命中**，
 *   0 处或多处一律 fail loud（宁可拒绝也不改错位置）
 */
export function applyTextMode(
  existing: { title: string; body: string },
  options: { mode: 'replace' | 'append' | 'patch'; text?: string; find?: string; replace?: string },
): { title: string; body: string } {
  if (options.mode === 'append') {
    const added = options.text ?? ''
    if (added.trim() === '') throw new Error('update: append 模式需要非空 text')
    return { title: existing.title, body: `${existing.body}\n\n${added}` }
  }
  if (options.mode === 'patch') {
    const find = options.find
    if (find === undefined || find === '') {
      throw new Error('update: patch 模式必须提供非空 find')
    }
    const to = options.replace ?? ''
    const inBody = countOccurrences(existing.body, find)
    if (inBody === 1) return { title: existing.title, body: existing.body.replace(find, to) }
    if (inBody > 1) {
      throw new Error(`update: patch 在正文匹配到 ${inBody} 处（要求唯一）——请给出更长的上下文`)
    }
    const inTitle = countOccurrences(existing.title, find)
    if (inTitle === 1) return { title: existing.title.replace(find, to), body: existing.body }
    if (inTitle > 1) {
      throw new Error(`update: patch 在标题匹配到 ${inTitle} 处（要求唯一）`)
    }
    throw new Error('update: patch 未命中 find（正文与标题各 0 处）——先读原文再改')
  }
  if (options.text === undefined) throw new Error('update: replace 模式需要 text')
  const { title, body } = splitText(options.text)
  return { title, body }
}

/** 修订留痕（v0.9）：把「改前快照」推入 revisions，保留最近 MAX_REVISIONS 条（旧→新） */
export function pushRevision(
  existing: { title: string; body: string; revisions?: Revision[] },
  mode: 'replace' | 'append' | 'patch',
  by?: string,
): Revision[] {
  const prev = existing.revisions ?? []
  const snapshot: Revision = {
    at: new Date().toISOString(),
    prevTitle: existing.title,
    prevBody: existing.body,
    mode,
    ...(by !== undefined ? { by } : {}),
  }
  return [...prev, snapshot].slice(-MAX_REVISIONS)
}

/**
 * 批量遗忘目标选择（v0.9 纯函数）：去重 → 只留**存在且未归档**者 → 截断到上限。
 * `skipped` 计「重复 / 不存在 / 已归档」；`truncated` 计被上限挡下的条数（两者都如实回报）。
 */
export function selectForgetTargets(
  entries: readonly Entry[],
  requestedIds: readonly string[],
  max: number,
): { targets: Entry[]; skipped: number; truncated: number } {
  const alive = new Map<string, Entry>()
  for (const entry of entries) {
    if (entry.archived === true) continue
    alive.set(entry.id, entry)
  }
  const seen = new Set<string>()
  const picked: Entry[] = []
  let skipped = 0
  for (const id of requestedIds) {
    if (seen.has(id)) {
      skipped += 1
      continue
    }
    seen.add(id)
    const entry = alive.get(id)
    if (entry === undefined) {
      skipped += 1
      continue
    }
    picked.push(entry)
  }
  const truncated = Math.max(0, picked.length - max)
  return { targets: picked.slice(0, max), skipped, truncated }
}

/** 合并正文（v0.9 纯函数）：把 others 的正文并入 canonical（带来源标注，信息不丢） */
export function mergeBodies(
  canonical: Entry,
  others: readonly Entry[],
  strategy: 'append-sources' | 'keep-canonical',
): { body: string; charsAdded: number } {
  if (strategy === 'keep-canonical') return { body: canonical.body, charsAdded: 0 }
  let body = canonical.body
  for (const other of others) {
    body += `\n\n## 合并自 ${other.id}（${other.title}）\n${other.body}`
  }
  return { body, charsAdded: body.length - canonical.body.length }
}

/**
 * 构建 update 工具（v0.9：三模式 + 修订留痕）。
 * 修改机制的最小闭环：能改（replace/append/patch）→ 改前留痕（revisions）→ 改错可回溯。
 */
function buildUpdate(deps: MemoryToolDeps): ToolDefinition {
  return defineTool({
    name: 'update',
    description: '修订一条记忆条目（按 id）。mode=replace（缺省）：text 首行作标题、其余作正文；mode=append：text 追加到正文末尾；mode=patch：把 find 替换成 replace（要求在正文或标题中**唯一命中**，否则拒绝）。每次内容真变都留一条修订快照（最多 3 条，可回溯）。tags 整体替换。',
    parameters: {
      id: { type: 'string', required: true, description: '目标条目 id（来自 remember/recall 返回）。' },
      mode: { type: 'string', description: '改写模式：replace（缺省·整文替换）/ append（追加到正文）/ patch（局部替换）。' },
      text: { type: 'string', description: 'replace 模式：新内容（首行作标题，其余作正文）；append 模式：要追加的片段。' },
      find: { type: 'string', description: 'patch 模式：要被替换的原文片段（须唯一命中）。' },
      replace: { type: 'string', description: 'patch 模式：替换成的文本（缺省空串 = 删除该片段）。' },
      tags: { type: 'array', items: { type: 'string' }, description: '替换后的标签；缺省不动。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `已更新记忆条目 ${value.id}` }],
    },
    async execute(args, exec) {
      const { config, cwd, view } = await resolveRuntime(exec, deps)
      const { readScopes } = resolveScopes({ configScope: config.scope, cwd })
      // 视野内定位：视野外的条目不可修订（v0.5——修订权随视野，不留越视野后门）
      const { entries } = gatherReadable(deps, { readScopes, includeArchive: true, view })
      const entry = entries.find((candidate) => candidate.id === args.id)
      if (entry === undefined) {
        throw new Error(`update: 未找到 id="${args.id}" 的记忆条目（当前视野内）`)
      }
      const rawMode = args.mode ?? 'replace'
      if (rawMode !== 'replace' && rawMode !== 'append' && rawMode !== 'patch') {
        throw new Error(`update: 未知 mode="${rawMode}"（允许 replace / append / patch）`)
      }
      const mode: 'replace' | 'append' | 'patch' = rawMode
      const patch: EntryPatch = {}
      const touchesText = mode === 'append' || mode === 'patch' || args.text !== undefined
      if (touchesText) {
        const next = applyTextMode(
          { title: entry.title, body: entry.body },
          {
            mode,
            ...(args.text !== undefined ? { text: args.text } : {}),
            ...(args.find !== undefined ? { find: args.find } : {}),
            ...(args.replace !== undefined ? { replace: args.replace } : {}),
          },
        )
        if (next.title !== entry.title || next.body !== entry.body) {
          patch.title = next.title
          patch.body = next.body
          // 只有内容真的变了才记快照——空改写不产生噪音历史
          patch.revisions = pushRevision(entry, mode, sessionIdOf(exec as unknown as RoleCarrierLike))
        }
      }
      if (args.tags !== undefined) patch.tags = args.tags
      await deps.store.update(entry.scope, args.id, patch)
      recordAction(deps, config, { action: 'update', id: args.id, mode })
      return { id: args.id }
    },
  })
}

/**
 * 构建 forget 工具（v0.9：从「一条」到「能执行一次遗忘决策」）。
 * 旧形态的实际缺陷（2026-09-17 实测）：memory_audit 给出 ARCHIVE 候选 254 条，
 * 而 forget 一次只吃一个 id ⇒ 清完要 254 次调用 = 机制上「知道该忘但忘不动」。
 * 新形态：id / ids[] / tier（按体检分档）任选，带 max 护栏与 dryRun 预览。
 */
function buildForget(deps: MemoryToolDeps): ToolDefinition {
  return defineTool({
    name: 'forget',
    description: '归档记忆条目（软删除：不再进活跃检索，可从 includeArchive 找回）。三种选择器任一：id（单条）/ ids[]（批量）/ tier（按 memory_audit 分档批量，ARCHIVE|DEMOTE|REVIEW）。批量请先 dryRun=true 看清单；max 护栏缺省 100、上限 500。reason 记入条目 source。',
    parameters: {
      id: { type: 'string', description: '单条模式：目标条目 id（来自 remember/recall/audit 返回）。' },
      ids: { type: 'array', items: { type: 'string' }, description: '批量模式：目标条目 id 列表。' },
      tier: { type: 'string', description: '分档批量：按 memory_audit 的档位选目标（ARCHIVE / DEMOTE / REVIEW；KEEP 被拒绝）。' },
      max: { type: 'integer', description: `批量上限（缺省 ${DEFAULT_BULK_FORGET}，硬上限 ${MAX_BULK_FORGET}）。` },
      dryRun: { type: 'boolean', description: 'true = 只列清单不写库（批量前必做）。' },
      reason: { type: 'string', description: '归档原因（记入条目 source）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          archived: { type: 'boolean', required: true },
          archivedCount: { type: 'integer', required: true },
          ids: { type: 'array', required: true, items: { type: 'string' } },
          skipped: { type: 'integer', required: true },
          truncated: { type: 'integer', required: true },
          dryRun: { type: 'boolean', required: true },
          notes: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        if (value.dryRun) {
          const tail = value.truncated > 0 ? ` · 超出上限未列 ${value.truncated} 条` : ''
          return [{ type: 'text', text: `dry-run：将归档 ${value.ids.length} 条（跳过 ${value.skipped}${tail}）——确认后去掉 dryRun 再调` }]
        }
        if (value.archivedCount === 1 && value.id !== undefined) {
          return [{ type: 'text', text: `已归档记忆条目 ${value.id}` }]
        }
        return [{ type: 'text', text: `已归档 ${value.archivedCount} 条（跳过 ${value.skipped}）` }]
      },
    },
    async execute(args, exec) {
      const { config, cwd, view } = await resolveRuntime(exec, deps)
      const { readScopes } = resolveScopes({ configScope: config.scope, cwd })
      // 视野内定位：视野外的条目不可归档（v0.5，同 update）
      const { entries: universe } = gatherReadable(deps, { readScopes, includeArchive: true, view })
      const max = Math.max(1, Math.min(args.max ?? DEFAULT_BULK_FORGET, MAX_BULK_FORGET))
      const notes: string[] = []
      const requested: string[] = []
      if (args.id !== undefined) requested.push(args.id)
      if (args.ids !== undefined) requested.push(...args.ids)

      if (args.tier !== undefined) {
        const tier = args.tier
        if (tier === 'KEEP') {
          throw new Error('forget: tier=KEEP 是承重档（被概要引用 / 新 / 有角色归属）——禁止批量归档；确需请逐条显式给 id')
        }
        if (tier !== 'ARCHIVE' && tier !== 'DEMOTE' && tier !== 'REVIEW') {
          throw new Error(`forget: 未知 tier="${tier}"（允许 ARCHIVE / DEMOTE / REVIEW）`)
        }
        const usage = deps.readAccess === undefined ? undefined : await deps.readAccess()
        const audit = auditMemory({
          entries: universe.filter((entry) => entry.archived !== true),
          indexEntries: universe,
          ...(config.audit !== undefined ? { config: config.audit } : {}),
          ...(usage !== undefined ? { usage } : {}),
          query: { topN: max + 1, minChars: 0 },
        })
        const tierIds = audit.candidates.filter((candidate) => candidate.bucket === tier).map((candidate) => candidate.id)
        notes.push(`tier=${tier}：体检命中 ${tierIds.length} 条（候选窗口 ${max + 1}）`)
        requested.push(...tierIds)
      }

      if (requested.length === 0) {
        throw new Error('forget: 需要 id / ids / tier 之一（批量归档请先 dryRun=true 看清单）')
      }

      const { targets, skipped, truncated } = selectForgetTargets(universe, requested, max)
      const singleMode = args.id !== undefined && args.ids === undefined && args.tier === undefined
      if (singleMode && targets.length === 0) {
        throw new Error(`forget: 未找到 id="${args.id}" 的记忆条目（当前视野内，或已归档）`)
      }
      if (truncated > 0) {
        notes.push(`目标共 ${targets.length + truncated} 条超上限 ${max}，本次只处理前 ${max} 条（其余下次再来）`)
      }

      const ids = targets.map((entry) => entry.id)
      const idField = singleMode && args.id !== undefined ? { id: args.id } : {}
      if (args.dryRun === true) {
        return { ...idField, archived: false, archivedCount: 0, ids, skipped, truncated, dryRun: true, notes }
      }
      const reason = args.reason ?? (targets.length > 1 ? `forget: bulk（${targets.length} 条）` : undefined)
      for (const target of targets) {
        await deps.store.forget(target.scope, target.id, reason)
        recordAction(deps, config, {
          action: 'forget',
          id: target.id,
          ...(reason !== undefined ? { reason } : {}),
        })
      }
      return { ...idField, archived: ids.length > 0, archivedCount: ids.length, ids, skipped, truncated, dryRun: false, notes }
    },
  })
}

/**
 * 构建 memory_merge 工具（v0.9）：近重复簇的**合并原语**。
 * 动机：memory_audit 只标出「近重复簇」（REVIEW）却不提供合并手段，只能人工逐条处理。
 * 语义：信息不丢——被并入者正文追加进 canonical（带来源标注），随后软归档（可找回）。
 */
function buildMerge(deps: MemoryToolDeps): ToolDefinition {
  return defineTool({
    name: 'memory_merge',
    description: '合并近重复条目（处理 memory_audit 的 REVIEW 簇）：把 ids 的正文并入 canonical（带「合并自 <id>」来源标注，信息不丢），并把被并入者软归档（includeArchive 可找回）。strategy=keep-canonical 时只归档、不动正文。',
    parameters: {
      canonical: { type: 'string', required: true, description: '保留的条目 id（合并目标，正文被追加）。' },
      ids: { type: 'array', items: { type: 'string' }, required: true, description: '被并入并归档的条目 id 列表。' },
      strategy: { type: 'string', description: 'append-sources（缺省·正文追加带来源）/ keep-canonical（只归档不追加）。' },
      reason: { type: 'string', description: '归档原因（记入被并入者 source）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          canonical: { type: 'string', required: true },
          merged: { type: 'integer', required: true },
          archived: { type: 'array', required: true, items: { type: 'string' } },
          charsAdded: { type: 'integer', required: true },
          notes: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: `已合并 ${value.merged} 条 → ${value.canonical}（正文 +${value.charsAdded} 字符，被并入者已归档）` },
      ],
    },
    async execute(args, exec) {
      const { config, cwd, view } = await resolveRuntime(exec, deps)
      const { readScopes } = resolveScopes({ configScope: config.scope, cwd })
      const { entries: universe } = gatherReadable(deps, { readScopes, includeArchive: true, view })
      const canonical = universe.find((entry) => entry.id === args.canonical)
      if (canonical === undefined) {
        throw new Error(`memory_merge: 未找到 canonical id="${args.canonical}"（当前视野内）`)
      }
      if (canonical.archived === true) {
        throw new Error(`memory_merge: canonical id="${args.canonical}" 已归档——先决定是否取消归档再合并`)
      }
      const strategy = args.strategy ?? 'append-sources'
      if (strategy !== 'append-sources' && strategy !== 'keep-canonical') {
        throw new Error(`memory_merge: 未知 strategy="${strategy}"（允许 append-sources / keep-canonical）`)
      }
      const notes: string[] = []
      const merged: Entry[] = []
      const seen = new Set<string>()
      for (const id of args.ids) {
        if (id === canonical.id) {
          notes.push(`跳过 ${id}：canonical 自身`)
          continue
        }
        if (seen.has(id)) {
          notes.push(`跳过 ${id}：列表内重复`)
          continue
        }
        seen.add(id)
        const other = universe.find((entry) => entry.id === id)
        if (other === undefined) {
          notes.push(`跳过 ${id}：视野内不存在`)
          continue
        }
        if (other.archived === true) {
          notes.push(`跳过 ${id}：已归档`)
          continue
        }
        merged.push(other)
      }
      const { body, charsAdded } = mergeBodies(canonical, merged, strategy)
      if (charsAdded > 0) {
        await deps.store.update(canonical.scope, canonical.id, {
          body,
          revisions: pushRevision(canonical, 'append', sessionIdOf(exec as unknown as RoleCarrierLike)),
        })
      }
      const reason = args.reason ?? `merged into ${canonical.id}`
      const archived: string[] = []
      for (const other of merged) {
        await deps.store.forget(other.scope, other.id, reason)
        recordAction(deps, config, { action: 'forget', id: other.id, reason })
        archived.push(other.id)
      }
      return { canonical: canonical.id, merged: merged.length, archived, charsAdded, notes }
    },
  })
}

/** 构建 memory_stats 工具 */
function buildStats(deps: MemoryToolDeps): ToolDefinition {
  return defineTool({
    name: 'memory_stats',
    description: '记忆统计：按层级（kind）/ 压缩层级（level）/ 时间桶（bucket）计数 + 归档数。缺省统计当前项目 + global，scope 参数可只统计指定库。',
    parameters: {
      scope: { type: 'string', description: '作用域覆盖：只统计该 scope（global 或 workspaceId）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
          byKind: { type: 'object', additionalProperties: true, required: true },
          byLevel: { type: 'object', additionalProperties: true, required: true },
          bucketCounts: { type: 'object', additionalProperties: true, required: true },
          archiveCount: { type: 'integer', required: true },
          scopes: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `记忆统计（${value.scopes.join(' + ')}）：共 ${value.total} 条（按层 ${JSON.stringify(value.byKind)}；已归档 ${value.archiveCount}）`,
      }],
    },
    async execute(args, exec) {
      const { config, cwd, view } = await resolveRuntime(exec, deps)
      const { readScopes } = resolveScopes({ configScope: config.scope, cwd, explicit: args.scope })
      // 懒压缩（DESIGN.md §五）：访问记忆时补压上一自然单位；fire-and-forget，失败静默
      for (const scope of readScopes) {
        if (deps.compress !== undefined) void deps.compress(scope, exec.agent).catch(() => {})
      }
      // 计数按视野取数后统计（v0.5：启用角色时统计只反映可见集合；停用时与 v0.4 等价）
      const { entries, scopes } = gatherReadable(deps, {
        readScopes,
        includeArchive: true,
        view,
        explicitScope: args.scope,
      })
      return { ...statsOf(entries), scopes }
    },
  })
}

/** 构建 memory_browse 工具：按时间线分组浏览记忆档案（与 recall 互补） */
function buildBrowse(deps: MemoryToolDeps): ToolDefinition {
  return defineTool({
    name: 'memory_browse',
    description: '浏览记忆档案：按时间桶分组翻看记忆（年/月/周/日），支持按层级/类型/标签/时间过滤与分页。与 recall 互补——recall 用于「知道要找什么」，memory_browse 用于「不知道有什么、翻档案发现」。概要通过 archiveRef 关联原始条目，可用 recall 展开。',
    parameters: {
      kind: { type: 'array', items: { type: 'string', enum: ['fact', 'knowledge', 'episodic', 'summary'] }, description: '条目类型过滤（任一命中）。' },
      tags: { type: 'array', items: { type: 'string' }, description: '标签过滤（全部命中）。' },
      since: { type: 'string', description: '起始时间（YYYY-MM-DD 或 ISO）。' },
      until: { type: 'string', description: '截止时间（YYYY-MM-DD 或 ISO）。' },
      level: { type: 'string', enum: ['day', 'week', 'month', 'year'], description: '只看该层级概要（如 day=只看日概要，week=只看周概要）。' },
      scope: { type: 'string', description: '作用域覆盖（global 或 workspaceId）；缺省当前 workspace + global。' },
      includeArchive: { type: 'boolean', description: '是否包含已归档条目（默认否）。' },
      page: { type: 'integer', description: '页码（1 起，默认 1）。' },
      pageSize: { type: 'integer', description: '每页组数（默认 20）。' },
      role: { type: 'string', description: '角色视角覆盖（v0.5）：缺省按调用者会话身份推导。仅当项目启用 roles 时生效。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          groups: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                bucket: { type: 'string', required: true },
                label: { type: 'string', required: true },
                level: { oneOf: [{ type: 'string', enum: ['day', 'week', 'month', 'year'] }, { type: 'null' }], required: true },
                items: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      id: { type: 'string', required: true },
                      kind: { type: 'string', required: true },
                      title: { type: 'string', required: true },
                      snippet: { type: 'string', required: true },
                      tags: { type: 'array', required: true, items: { type: 'string' } },
                      scope: { type: 'string', required: true },
                      level: { oneOf: [{ type: 'string', enum: ['day', 'week', 'month', 'year'] }, { type: 'null' }], required: true },
                      updatedAt: { type: 'string', required: true },
                      score: { type: 'number', required: true },
                      archived: { type: 'boolean', required: true },
                    },
                  },
                },
              },
            },
          },
          total: { type: 'integer', required: true },
        },
      },
      render: (args, value) => {
        const lines = value.groups.map((group) => {
          const levelNote = group.level !== null ? `（${group.level}概要）` : ''
          const items = group.items.map((item) => `  - [${item.kind}] ${item.title}`).join('\n')
          return `${group.label}${levelNote}（${group.items.length} 条）：\n${items}`
        })
        return [{
          type: 'text',
          text: `记忆档案（共 ${value.total} 组，显示 ${value.groups.length} 组）：\n${lines.join('\n')}`,
        }]
      },
    },
    async execute(args, exec) {
      const { config, cwd, view } = await resolveRuntime(exec, deps, args.role)
      const { readScopes } = resolveScopes({ configScope: config.scope, cwd, explicit: args.scope })
      const includeArchive = args.includeArchive ?? false
      const { entries } = gatherReadable(deps, { readScopes, includeArchive, view, explicitScope: args.scope })
      const result = browseEntries(entries, {
        kind: args.kind,
        tags: args.tags,
        since: args.since,
        until: args.until,
        scope: args.scope,
        includeArchive: args.includeArchive,
        level: args.level,
        page: args.page,
        pageSize: args.pageSize,
      })
      // 结果里补 label
      return {
        groups: result.groups.map((group) => ({ ...group, label: bucketLabel(group.bucket) })),
        total: result.total,
      }
    },
  })
}

/** 构建 memory_relate 工具：从单条记忆展开关联网络（联想导航，v0.3） */
function buildRelate(deps: MemoryToolDeps): ToolDefinition {
  return defineTool({
    name: 'memory_relate',
    description: '联想导航：按 id 找到一条记忆并展开它的关联网络（related 链：共享标签/标题/正文关联的邻居记忆，关联强度降序）。depth=1（默认）单跳；depth>1 沿关系网 BFS 多跳探索记忆社区（hop 标注层级）。用于从已知记忆沿关系行走——「这条记忆还连着谁」。返回目标条目摘要 + 关联链（hop/共享标签数/关联强度）。',
    parameters: {
      id: { type: 'string', required: true, description: '目标记忆条目 id（来自 recall/remember/memory_browse）。' },
      limit: { type: 'integer', description: '每跳关联条数上限（缺省 3）。' },
      depth: { type: 'integer', description: 'BFS 跳数（缺省 1=单跳；2-3 多跳探索记忆社区）。' },
      scope: { type: 'string', description: '作用域覆盖（global 或 workspaceId）；缺省当前 workspace + global。' },
      includeArchive: { type: 'boolean', description: '是否包含已归档条目（默认否）。' },
      role: { type: 'string', description: '角色视角覆盖（v0.5）：缺省按调用者会话身份推导。目标与邻居都必须通过该视野的准入。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          error: { type: 'string' },
          target: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              kind: { type: 'string', required: true },
              title: { type: 'string', required: true },
              scope: { type: 'string', required: true },
            },
          },
          related: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                title: { type: 'string', required: true },
                scope: { type: 'string', required: true },
                sharedTags: { type: 'number', required: true },
                strength: { type: 'number', required: true },
                hop: { type: 'number', required: true },
              },
            },
          },
        },
      },
      render: (_a, v) => {
        if (v.ok === false) return [{ type: 'text', text: '联想导航失败：' + String(v.error ?? '') }]
        if (v.target === undefined) return [{ type: 'text', text: '联想导航：目标条目缺失。' }]
        const t = v.target
        const rel = v.related ?? []
        if (rel.length === 0) return [{ type: 'text', text: `联想导航：${t.title}（${t.id}）无关联邻居。` }]
        const lines = rel.map((r) => {
          const hopNote = r.hop !== undefined && r.hop > 1 ? `[${r.hop}跳] ` : ''
          return `- ${hopNote}[${r.kind}@${r.scope} 关联强度${r.strength}] ${r.title}`
        })
        return [{ type: 'text', text: `联想导航：${t.title}（${t.id}）→ ${rel.length} 条关联：\n` + lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const { config, cwd, view } = await resolveRuntime(exec, deps, args.role)
      const { readScopes } = resolveScopes({ configScope: config.scope, cwd, explicit: args.scope })
      const includeArchive = args.includeArchive ?? false
      // 视野内取数：目标与邻居都必须过同一准入（否则 memory_relate 会成为隔离缺口）
      const { entries } = gatherReadable(deps, { readScopes, includeArchive, view, explicitScope: args.scope })
      const target = entries.find((candidate) => candidate.id === args.id)
      if (target === undefined) return { ok: false, error: `未找到 id="${args.id}" 的记忆条目（当前视野内）` }
      const depth = args.depth ?? 1
      const limitPerHop = args.limit ?? 3
      const related = depth > 1
        ? relateClosure(entries, target, depth, limitPerHop, includeArchive)
        : relatedOf(entries, target, limitPerHop, includeArchive).map((r) => ({ ...r, hop: 1 }))
      return {
        ok: true,
        target: { id: target.id, kind: target.kind, title: target.title, scope: target.scope },
        related: related.map((r) => ({ ...r, scope: r.scope })),
      }
    },
  })
}

/** 构建 memory_health 工具：插件运行时状态（HMR 验证用，v0.2.1） */
function buildHealth(deps: MemoryToolDeps): ToolDefinition {
  return defineTool({
    name: 'memory_health',
    description: '查看记忆插件运行时状态：各作用域条目数、归档数、启动注入是否启用。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          total: { type: 'integer', required: true },
          archiveCount: { type: 'integer', required: true },
          scopes: { type: 'array', required: true, items: { type: 'string' } },
          injectEnabled: { type: 'boolean', required: true },
          role: { type: 'string', required: true },
          rolesEnabled: { type: 'boolean', required: true },
          roleReason: { type: 'string', required: true },
          autoCalls: { type: 'integer', required: true },
          recallCalls: { type: 'integer', required: true },
          distinctHits: { type: 'integer', required: true },
          lastAccessAt: { type: 'string', required: true },
          compressScans: { type: 'integer', required: true },
          compressUnits: { type: 'integer', required: true },
          compressErrors: { type: 'integer', required: true },
          compressPendingLast: { type: 'integer', required: true },
          compressSkippedText: { type: 'string', required: true },
          compressSampleText: { type: 'string', required: true },
          compressLastAt: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `记忆插件健康：${value.ok ? '正常' : '异常'}（共 ${value.total} 条 / 归档 ${value.archiveCount}；注入 ${value.injectEnabled ? '开' : '关'}）｜角色 ${value.role}（${value.rolesEnabled ? '角色维度已启用' : '角色维度未启用→零过滤'}；判据：${value.roleReason}）｜命中率信号：注入 ${value.autoCalls} 次 / 主动检索 ${value.recallCalls} 次 / 命中条目 ${value.distinctHits} 条${value.lastAccessAt.length > 0 ? `（最近 ${value.lastAccessAt}）` : ''}｜压缩流水线：扫描 ${value.compressScans} 次 / 压缩 ${value.compressUnits} 单元 / 最近待压 ${value.compressPendingLast}${value.compressErrors > 0 ? ` / 错误 ${value.compressErrors}` : ''}${value.compressLastAt.length > 0 ? `（最近 ${value.compressLastAt}）` : ''}｜非待压判定：${value.compressSkippedText}${value.compressSampleText.length > 0 ? `\n候选样本（非待压）：${value.compressSampleText}` : ''}`,
      }],
    },
    async execute(args, exec) {
      const { config, cwd, view } = await resolveRuntime(exec, deps)
      const { readScopes } = resolveScopes({ configScope: config.scope, cwd })
      const { entries } = gatherReadable(deps, { readScopes, includeArchive: true, view })
      const stats = statsOf(entries)
      // 命中率度量（v0.7 §5.10）：注入次数 vs 主动检索次数——「环境」是否真建起来了看这个比值
      const summary: AccessSummary | undefined = deps.readAccessSummary === undefined
        ? undefined
        : await deps.readAccessSummary()
      // 压缩流水线（v0.8 §5.12）：最近一轮扫描的判定分布 + 非待压样本（=「为什么这个桶没压」）
      const compress: CompressSummary | undefined = deps.readCompressSummary === undefined
        ? undefined
        : await deps.readCompressSummary()
      const sample = (compress?.sampleLast ?? [])
        .filter((line) => !line.endsWith(' pending'))
        .slice(0, 8)
      return {
        ok: true,
        total: stats.total,
        archiveCount: stats.archiveCount,
        scopes: readScopes,
        injectEnabled: config.inject.enabled,
        role: view.role,
        rolesEnabled: view.enabled,
        roleReason: view.reason,
        autoCalls: summary?.autoCalls ?? 0,
        recallCalls: summary?.recallCalls ?? 0,
        distinctHits: summary?.distinctIds ?? 0,
        lastAccessAt: summary !== undefined && summary.lastAtMs > 0
          ? new Date(summary.lastAtMs).toISOString().slice(0, 19)
          : '',
        compressScans: compress?.scans ?? 0,
        compressUnits: compress?.units ?? 0,
        compressErrors: compress?.errors ?? 0,
        compressPendingLast: compress?.pendingLast ?? 0,
        compressSkippedText: formatSkipped(compress?.skippedLast ?? {}),
        compressSampleText: sample.join(' · '),
        compressLastAt: compress !== undefined && compress.lastAtMs > 0
          ? new Date(compress.lastAtMs).toISOString().slice(0, 19)
          : '',
      }
    },
  })
}

/** 构建 memory_version 工具：返回插件版本（HMR 验证判据）。
 *  2026-09-01 修正：原实现 version 硬编码 + buildAt 实为「调用时刻」——验证判据说谎
 *  （v0.2.3 部署时仍报 0.2.2）。现 version 动态读 package.json，buildAt 取产物 mtime（真实构建时刻）。 */
function buildVersion(): ToolDefinition {
  return defineTool({
    name: 'memory_version',
    description: '查看记忆插件版本（HMR 热重载验证用）。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          version: { type: 'string', required: true },
          buildAt: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{ type: 'text', text: `dsh-agent-memory ${value.version}（build ${value.buildAt}）` }],
    },
    async execute() {
      let version = 'unknown'
      let buildAt = 'unknown'
      try {
        const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }
        if (typeof pkg.version === 'string') version = pkg.version
      } catch { /* 不可读时如实报 unknown */ }
      try {
        buildAt = new Date(statSync(new URL(import.meta.url)).mtimeMs).toISOString().slice(0, 19)
      } catch { /* 同上 */ }
      return { version, buildAt }
    },
  })
}

/** 构建 memory_check 工具 */
function buildCheck(): ToolDefinition {
  return defineTool({
    name: 'memory_check',
    description: '查看待沉淀建议（通道 B 主动侧）。v0.1 未接线信号检测，恒返回空建议——有沉淀价值的内容请直接用 remember 落库。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          suggestions: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                signal: { type: 'string', required: true },
                summary: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: value.suggestions.length === 0
          ? '暂无待沉淀建议。'
          : `待沉淀建议 ${value.suggestions.length} 条：` + value.suggestions.map((s) => `- ${s.signal}: ${s.summary}`).join('\n'),
      }],
    },
    async execute() {
      // 通道 B（信号沉淀提示）为 v0.3 规划项；规格 §4 允许「无则空数组」
      return { suggestions: [] }
    },
  })
}

/**
 * 构建 memory_audit 工具（v0.6 价值体检器）——**只读提案器**。
 * 硬约束（§5.9）：① 不归档不删除不写库 ② 过角色视野（读路径） ③ 分数是序数，权重是启发式先验。
 */
function buildAudit(deps: MemoryToolDeps): ToolDefinition {
  return defineTool({
    name: 'memory_audit',
    description: '价值体检（只读）：回答「哪些条目值得继续占位置、哪些该降级/归档」。输出四档提案——KEEP（承重：被概要 archiveRef 引用 / 新 / 有角色归属）、DEMOTE（未引用且体量大，可降级压缩）、ARCHIVE（未引用 + 老 + 无溯源，归档候选）、REVIEW（近重复簇 / 超大条目，交人裁决）——每条带证据行，并给出按层级聚合的体量视图。**只读**：不归档、不删除、不刷新 accessedAt；分数是序数（权重为启发式先验，非拟合值）。',
    parameters: {
      scope: { type: 'string', description: '作用域覆盖（缺省当前 workspace + global；受调用者角色视野约束）。' },
      role: { type: 'string', description: '角色视角覆盖（缺省按调用者会话身份推导）。' },
      topN: { type: 'integer', description: '返回候选条数上限（缺省 30）。' },
      minChars: { type: 'integer', description: '只列体量 ≥ 此字符数的候选（缺省 0 = 全部）。' },
      includeArchive: { type: 'boolean', description: '是否把已归档条目也纳入体检（缺省 false）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              total: { type: 'integer', required: true },
              chars: { type: 'integer', required: true },
              byBucket: { type: 'object', additionalProperties: true, required: true },
              charsByBucket: { type: 'object', additionalProperties: true, required: true },
              usageSource: { type: 'string', required: true },
              referenced: { type: 'integer', required: true },
            },
          },
          groups: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                key: { type: 'string', required: true },
                label: { type: 'string', required: true },
                count: { type: 'integer', required: true },
                chars: { type: 'integer', required: true },
                dominantBucket: { type: 'string', required: true },
              },
            },
          },
          candidates: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                title: { type: 'string', required: true },
                scope: { type: 'string', required: true },
                bucket: { type: 'string', required: true },
                score: { type: 'number', required: true },
                reasons: { type: 'array', required: true, items: { type: 'string' } },
                evidence: { type: 'object', additionalProperties: true, required: true },
              },
            },
          },
          notes: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        const b = value.summary.byBucket
        const cb = value.summary.charsByBucket
        const lines = [
          `记忆体检（只读提案）：${value.summary.total} 条 / ${value.summary.chars} 字符；承重 ${value.summary.referenced} 条｜用量信号：${value.summary.usageSource === 'trace' ? '侧车轨迹' : '无（usage 项恒 0）'}`,
          `分档：KEEP ${b['KEEP']}(${cb['KEEP']}) · DEMOTE ${b['DEMOTE']}(${cb['DEMOTE']}) · ARCHIVE ${b['ARCHIVE']}(${cb['ARCHIVE']}) · REVIEW ${b['REVIEW']}(${cb['REVIEW']})`,
          `体量前三组：${value.groups.slice(0, 3).map((g) => `${g.label} ${g.count} 条/${g.chars} 字`).join(' · ')}`,
        ]
        for (const candidate of value.candidates.slice(0, 10)) {
          const title = candidate.title.length > 42 ? candidate.title.slice(0, 41) + '…' : candidate.title
          lines.push(`- [${candidate.bucket}] ${title}（${candidate.evidence['chars']} 字 · ${candidate.evidence['ageDays']} 天 · ${candidate.evidence['refs']} 引用）${candidate.reasons[0] ?? ''}`)
        }
        if (value.candidates.length > 10) {
          lines.push(`（另有 ${value.candidates.length - 10} 条候选，见结构化返回）`)
        }
        lines.push('提案 ≠ 裁决：本工具不归档不删除；要做请显式调用 forget（动记忆数据属须请示类）。')
        if (value.notes.length > 0) {
          // 把「看不见 ≠ 没有」这类读数注脚带出来（默认视图下承重为 0 时尤其重要）
          for (const note of value.notes) {
            if (note.startsWith('另有')) lines.push(note)
          }
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const { config, cwd, view } = await resolveRuntime(exec, deps, args.role)
      const { readScopes } = resolveScopes({ configScope: config.scope, cwd, explicit: args.scope })
      const includeArchive = args.includeArchive ?? false
      // 视野一致（硬约束 ②）：体检是读路径，提案只含调用者视野内的条目。
      // 索引范围 = 视野内全量（含归档；否则承重原料不可见，会被误读成「没有承重」）；
      // 分类范围 = 本次集合（默认剔归档，可由 includeArchive 放开）。
      const { entries: universe } = gatherReadable(deps, { readScopes, includeArchive: true, view, explicitScope: args.scope })
      const entries = includeArchive ? universe : universe.filter((entry) => !entry.archived)
      const usage = deps.readAccess === undefined ? undefined : await deps.readAccess()
      const result = auditMemory({
        entries,
        indexEntries: universe,
        ...(config.audit !== undefined ? { config: config.audit } : {}),
        ...(usage !== undefined ? { usage } : {}),
        query: { topN: args.topN, minChars: args.minChars, includeArchive },
      })
      // 提案日志（v0.7 §5.11）：让提案有历史——与后续 forget/update 动作同文件、可按 id join。
      // 写的是**侧车观测文件**：不写记忆库、不刷新 accessedAt（A31 的只读判据不受影响）。
      if (config.audit?.proposalLog?.enabled === true && deps.recordProposal !== undefined) {
        void deps.recordProposal({
          atMs: Date.now(),
          kind: 'audit',
          role: view.role,
          weights: config.audit.weights,
          summary: result.summary,
          candidates: result.candidates.slice(0, 20).map((candidate) => ({
            id: candidate.id,
            bucket: candidate.bucket,
            score: candidate.score,
            chars: candidate.evidence.chars,
          })),
        })
      }
      return result
    },
  })
}

/**
 * 构建六个记忆工具定义（纯函数，单测可直接取 execute 跑行为）。
 * @param deps - 存储 + 配置加载依赖
 * @returns 六条 registry-ready 工具定义
 */
export function createMemoryTools(deps: MemoryToolDeps): ToolDefinition[] {
  return [
    buildRemember(deps),
    buildRecall(deps),
    buildBrowse(deps),
    buildRelate(deps),
    buildUpdate(deps),
    buildForget(deps),
    buildMerge(deps),
    buildStats(deps),
    buildAudit(deps),
    buildCheck(),
    buildHealth(deps),
    buildVersion(),
  ]
}

/**
 * 注册六个记忆工具到共享工具注册表（T7 集成接线；插件需 inject 'tools'）。
 * @param ctx - 插件上下文（ctx.tools 由 dsh-tools 声明合并提供）
 * @param deps - 存储 + 配置加载依赖
 */
export function registerMemoryTools(ctx: Context, deps: MemoryToolDeps): void {
  for (const tool of createMemoryTools(deps)) {
    ctx.tools.register(tool)
  }
}
