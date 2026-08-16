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
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { EntryKind, MemoryConfig, RememberResult } from './types.ts'
import { loadMemoryConfig, memoryConfigPath } from './config.ts'
import { resolveScopes, sessionCwdOf } from './scope.ts'
import type { EntryPatch, MemoryStats, MemoryStore } from './store.ts'
import { titleFingerprint } from './store.ts'
import { browseEntries, bucketLabel } from './search.ts'
import { recallEntries } from './search.ts'

/** 工具依赖：存储 + 配置加载（单测注入 mock 用） */
export interface MemoryToolDeps {
  /** 记忆存储（T7 用 storage-domain kv 表构造 MemoryStore） */
  store: MemoryStore
  /** 配置加载：workspace 根目录 → MemoryConfig；缺省读 <root>/.dsh/memory.yml */
  loadConfig?: (workspaceRoot: string) => Promise<MemoryConfig> | MemoryConfig
  /** 懒压缩钩子（T7 接线：TimelineCompressor.compressPending；访问记忆时补压上一自然单位，DESIGN.md §五） */
  compress?: (scope: string, agent?: Agent) => Promise<void>
}

/** 缺省配置加载器：读取 .dsh/memory.yml，缺失走默认，非法 fail loud */
async function loadConfigDefault(workspaceRoot: string): Promise<MemoryConfig> {
  return loadMemoryConfig(memoryConfigPath(workspaceRoot))
}

/** 一次调用的运行时上下文：解析出的配置 + 会话 cwd（cwd 缺失时配置按启动目录读） */
async function resolveRuntime(
  exec: ToolRunContext,
  deps: MemoryToolDeps,
): Promise<{ config: MemoryConfig; cwd: string | undefined }> {
  const cwd = sessionCwdOf(exec)
  const loader = deps.loadConfig ?? loadConfigDefault
  const config = await loader(cwd ?? process.cwd())
  return { config, cwd }
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
      })
    },
  })
}

/** 构建 recall 工具 */
function buildRecall(deps: MemoryToolDeps): ToolDefinition {
  return defineTool({
    name: 'recall',
    description: '检索记忆。按关键词/层级/标签/时间过滤，按相关度（标签命中 > 标题命中 > 正文命中）与新鲜度排序；结果标注来源作用域（global 或 workspaceId）与压缩层级（周概要/月概要等）。缺省检索当前项目 + global（全局记忆永远附加，来源在 scope 字段标注）。',
    parameters: {
      query: { type: 'string', description: '检索关键词（多个词空格分隔，任一命中即计分；省略则按新鲜度排序）。' },
      kind: { type: 'array', items: { type: 'string', enum: ['fact', 'knowledge', 'episodic', 'summary'] }, description: '层级过滤（任一命中）。' },
      tags: { type: 'array', items: { type: 'string' }, description: '标签过滤（全部命中）。' },
      since: { type: 'string', description: '起始时间（ISO 时间或 YYYY-MM-DD，按创建时间过滤）。' },
      until: { type: 'string', description: '截止时间（ISO 时间或 YYYY-MM-DD）。' },
      scope: { type: 'string', description: '作用域覆盖：global 只查全局；workspaceId 跨项目查（global 仍附加）。' },
      limit: { type: 'integer', description: '返回条数上限（缺省 20）。' },
      includeArchive: { type: 'boolean', description: '是否包含已归档条目（缺省 false）。' },
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
              },
            },
          },
        },
      },
      render: (args, value) => {
        const lines = value.results.map((item) => {
          const levelNote = item.level !== null ? `（${item.level}概要）` : ''
          return `- [${item.kind}@${item.scope}${levelNote} 相关度${item.score}] ${item.title}`
        })
        return [{
          type: 'text',
          text: [`命中 ${value.total} 条，返回 ${value.results.length} 条：`, ...lines].join('\n'),
        }]
      },
    },
    async execute(args, exec) {
      const { config, cwd } = await resolveRuntime(exec, deps)
      const { readScopes } = resolveScopes({ configScope: config.scope, cwd, explicit: args.scope })
      // 懒压缩（DESIGN.md §五）：访问记忆时补压上一自然单位；fire-and-forget，失败静默（幂等保证下次重试）
      for (const scope of readScopes) {
        if (deps.compress !== undefined) void deps.compress(scope, exec.agent).catch(() => {})
      }
      const includeArchive = args.includeArchive ?? false
      // 作用域合并：workspace + global 全量拉取后统一走检索管道（规格 §5：global 永远附加）
      const entries = readScopes.flatMap((scope) => deps.store.list(scope, { includeArchive }))
      return recallEntries(entries, {
        query: args.query,
        kind: args.kind,
        tags: args.tags,
        since: args.since,
        until: args.until,
        limit: args.limit,
        includeArchive,
      })
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
      const { config, cwd } = await resolveRuntime(exec, deps)
      const { readScopes } = resolveScopes({ configScope: config.scope, cwd })
      const entry = findEntry(deps.store, readScopes, args.id)
      if (entry === undefined) {
        throw new Error(`update: 未找到 id="${args.id}" 的记忆条目（当前检索作用域内）`)
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
      const { config, cwd } = await resolveRuntime(exec, deps)
      const { readScopes } = resolveScopes({ configScope: config.scope, cwd })
      const entry = findEntry(deps.store, readScopes, args.id)
      if (entry === undefined) {
        throw new Error(`forget: 未找到 id="${args.id}" 的记忆条目（当前检索作用域内）`)
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
      const { config, cwd } = await resolveRuntime(exec, deps)
      const { readScopes } = resolveScopes({ configScope: config.scope, cwd, explicit: args.scope })
      // 懒压缩（DESIGN.md §五）：访问记忆时补压上一自然单位；fire-and-forget，失败静默
      for (const scope of readScopes) {
        if (deps.compress !== undefined) void deps.compress(scope, exec.agent).catch(() => {})
      }
      const merged: MemoryStats = { total: 0, byKind: {}, byLevel: {}, bucketCounts: {}, archiveCount: 0 }
      for (const scope of readScopes) {
        const stats = deps.store.stats(scope)
        merged.total += stats.total
        merged.archiveCount += stats.archiveCount
        mergeCounts(merged.byKind as Record<string, number>, stats.byKind as Record<string, number>)
        mergeCounts(merged.byLevel as Record<string, number>, stats.byLevel as Record<string, number>)
        mergeCounts(merged.bucketCounts, stats.bucketCounts)
      }
      return { ...merged, scopes: readScopes }
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
                      tags: { type: 'array', required: true, items: { type: 'string' } },
                      scope: { type: 'string', required: true },
                      level: { oneOf: [{ type: 'string', enum: ['day', 'week', 'month', 'year'] }, { type: 'null' }], required: true },
                      updatedAt: { type: 'string', required: true },
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
      const { config, cwd } = await resolveRuntime(exec, deps)
      const { readScopes } = resolveScopes({ configScope: config.scope, cwd, explicit: args.scope })
      const entries = readScopes.flatMap((scope) => deps.store.list(scope, { includeArchive: args.includeArchive ?? false }))
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
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `记忆插件健康：${value.ok ? '正常' : '异常'}（共 ${value.total} 条 / 归档 ${value.archiveCount}；注入 ${value.injectEnabled ? '开' : '关'}）`,
      }],
    },
    async execute(args, exec) {
      const { config, cwd } = await resolveRuntime(exec, deps)
      const { readScopes } = resolveScopes({ configScope: config.scope, cwd })
      let total = 0
      let archiveCount = 0
      for (const scope of readScopes) {
        const stats = deps.store.stats(scope)
        total += stats.total
        archiveCount += stats.archiveCount
      }
      return {
        ok: true,
        total,
        archiveCount,
        scopes: readScopes,
        injectEnabled: config.inject.enabled,
      }
    },
  })
}

/** 构建 memory_version 工具：返回插件版本（HMR 验证判据） */
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
      return { version: '0.2.6', buildAt: new Date().toISOString().slice(0, 19) }
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
 * 构建六个记忆工具定义（纯函数，单测可直接取 execute 跑行为）。
 * @param deps - 存储 + 配置加载依赖
 * @returns 六条 registry-ready 工具定义
 */
export function createMemoryTools(deps: MemoryToolDeps): ToolDefinition[] {
  return [
    buildRemember(deps),
    buildRecall(deps),
    buildBrowse(deps),
    buildUpdate(deps),
    buildForget(deps),
    buildStats(deps),
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
