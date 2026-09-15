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
import type { Entry, EntryKind, MemoryConfig, RememberResult } from './types.ts'
import { loadMemoryConfig, memoryConfigPath } from './config.ts'
import { resolveScopes, sessionCwdOf } from './scope.ts'
import type { EntryPatch, MemoryStats, MemoryStore } from './store.ts'
import { statsOf, titleFingerprint } from './store.ts'
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

/** 构建 update 工具 */
function buildUpdate(deps: MemoryToolDeps): ToolDefinition {
  return defineTool({
    name: 'update',
    description: '修订一条记忆条目（按 id）。text 的首行替换标题、全文替换正文；tags 整体替换。仅改需要改的字段。',
    parameters: {
      id: { type: 'string', required: true, description: '目标条目 id（来自 remember/recall 返回）。' },
      text: { type: 'string', description: '新内容（首行作标题，其余作正文）；缺省不改正文。' },
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
      const patch: EntryPatch = {}
      if (args.text !== undefined) {
        const { title, body } = splitText(args.text)
        patch.title = title
        patch.body = body
      }
      if (args.tags !== undefined) patch.tags = args.tags
      await deps.store.update(entry.scope, args.id, patch)
      return { id: args.id }
    },
  })
}

/** 构建 forget 工具 */
function buildForget(deps: MemoryToolDeps): ToolDefinition {
  return defineTool({
    name: 'forget',
    description: '归档一条记忆条目（软删除：不再进活跃检索，可从 includeArchive 找回）。需要理由时填 reason 记入溯源。',
    parameters: {
      id: { type: 'string', required: true, description: '目标条目 id（来自 remember/recall 返回）。' },
      reason: { type: 'string', description: '归档原因（可选，记入条目 source）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          archived: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `已归档记忆条目 ${value.id}` }],
    },
    async execute(args, exec) {
      const { config, cwd, view } = await resolveRuntime(exec, deps)
      const { readScopes } = resolveScopes({ configScope: config.scope, cwd })
      // 视野内定位：视野外的条目不可归档（v0.5，同 update）
      const { entries } = gatherReadable(deps, { readScopes, includeArchive: true, view })
      const entry = entries.find((candidate) => candidate.id === args.id)
      if (entry === undefined) {
        throw new Error(`forget: 未找到 id="${args.id}" 的记忆条目（当前视野内）`)
      }
      await deps.store.forget(entry.scope, args.id, args.reason)
      return { id: args.id, archived: true }
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
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `记忆插件健康：${value.ok ? '正常' : '异常'}（共 ${value.total} 条 / 归档 ${value.archiveCount}；注入 ${value.injectEnabled ? '开' : '关'}）｜角色 ${value.role}（${value.rolesEnabled ? '角色维度已启用' : '角色维度未启用→零过滤'}；判据：${value.roleReason}）`,
      }],
    },
    async execute(args, exec) {
      const { config, cwd, view } = await resolveRuntime(exec, deps)
      const { readScopes } = resolveScopes({ configScope: config.scope, cwd })
      const { entries } = gatherReadable(deps, { readScopes, includeArchive: true, view })
      const stats = statsOf(entries)
      return {
        ok: true,
        total: stats.total,
        archiveCount: stats.archiveCount,
        scopes: readScopes,
        injectEnabled: config.inject.enabled,
        role: view.role,
        rolesEnabled: view.enabled,
        roleReason: view.reason,
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
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const { config, cwd, view } = await resolveRuntime(exec, deps, args.role)
      const { readScopes } = resolveScopes({ configScope: config.scope, cwd, explicit: args.scope })
      const includeArchive = args.includeArchive ?? false
      // 视野一致（硬约束 ②）：体检是读路径，提案只含调用者视野内的条目
      const { entries } = gatherReadable(deps, { readScopes, includeArchive, view, explicitScope: args.scope })
      const usage = deps.readAccess === undefined ? undefined : await deps.readAccess()
      return auditMemory({
        entries,
        ...(config.audit !== undefined ? { config: config.audit } : {}),
        ...(usage !== undefined ? { usage } : {}),
        query: { topN: args.topN, minChars: args.minChars, includeArchive },
      })
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
