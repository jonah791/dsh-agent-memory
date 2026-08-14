/**
 * 作用域路由（IMPLEMENTATION.md §5）——workspaceId 解析 + 读写 scope 决策。
 *
 * 取证结论（2026-08-14，官方源码 packages/fs/tool-fs/src/session-cwd.ts:24）：
 * 当前会话的 workspace 由工具执行上下文的 `exec.agent?.session.header.cwd`
 * 给出（绝对工作目录），与 dsh-tool-bash 的 workdir 默认值同源。
 * 本模块只依赖该结构的鸭子类型，不 import harness 运行时，离线可测。
 *
 * 路由规则（§5 + DESIGN.md §3/§4）：
 * - 默认读写 scope = 当前 workspaceId；recall 永远附加 global（合并结果，标注来源）
 * - 配置 scope 三态：workspace（读=workspace+global，写=workspace）/
 *   global-first（读=global 优先+workspace，写=workspace）/ global（只 global）
 * - 工具参数 scope 显式覆盖：scope=global 只查 global；scope=<workspaceId> 跨项目查
 * - 无 cwd（无 agent / header 无 cwd）→ 降级只走 global
 */

import { resolve } from 'node:path'
import type { MemoryConfig } from './types.ts'

/** 全局作用域常量 */
export const GLOBAL_SCOPE = 'global'

/**
 * 最小会话载体（鸭子类型，对齐 @deepseek-ai/dsh-tools ToolExecution 的相关字段）。
 * 运行时传入真实 exec 对象即可，无需类型依赖。
 */
export interface SessionCwdCarrier {
  agent?: { session?: { header?: { cwd?: string } } } | null
}

/** 作用域解析输入 */
export interface ScopeResolutionInput {
  /** 配置里的 scope 模式（来自 memory.yml，缺省 'workspace'） */
  configScope: MemoryConfig['scope']
  /** 当前会话工作目录（sessionCwdOf(exec) 的产物；缺省=无 workspace） */
  cwd?: string
  /** 工具参数显式覆盖：'global' 或 workspaceId */
  explicit?: 'global' | string
}

/** 作用域解析结果 */
export interface ResolvedScopes {
  /** 当前 workspaceId（无 cwd 时为 null） */
  workspaceId: string | null
  /** 读取作用域列表（按优先级排序，含 global 附加规则） */
  readScopes: string[]
  /** 写入作用域（单个） */
  writeScope: string
}

/** 从工具执行上下文提取当前会话工作目录（与官方 tool-fs 同源） */
export function sessionCwdOf(carrier: SessionCwdCarrier | null | undefined): string | undefined {
  return carrier?.agent?.session?.header?.cwd
}

/**
 * 绝对路径 → 稳定 workspaceId：
 * 统一分隔符为 '/'、去尾部分隔符、Windows 盘符转小写，保证跨会话/跨平台稳定。
 * @param cwd - 绝对工作目录
 * @returns 规范化后的 workspaceId
 */
export function workspaceIdOf(cwd: string): string {
  const normalized = resolve(cwd).replace(/\\/g, '/').replace(/\/+$/, '')
  // Windows 盘符统一小写（C:/... → c:/...）
  return /^[A-Za-z]:/.test(normalized)
    ? normalized[0]!.toLowerCase() + normalized.slice(1)
    : normalized
}

/** 判断 scope 是否为全局 */
export function isGlobalScope(scope: string): boolean {
  return scope === GLOBAL_SCOPE
}

/**
 * 作用域路由决策：读哪些、写哪个。
 * @param input - 配置 scope 模式 + 当前 cwd + 工具参数显式覆盖
 * @returns 解析后的读写作用域
 */
export function resolveScopes(input: ScopeResolutionInput): ResolvedScopes {
  const workspaceId = input.cwd === undefined ? null : workspaceIdOf(input.cwd)
  const explicit = input.explicit

  // 工具参数显式覆盖（优先级最高）：global 只查 global；workspaceId 跨项目查（global 附加）
  if (explicit !== undefined && explicit !== null) {
    if (isGlobalScope(explicit)) {
      return { workspaceId, readScopes: [GLOBAL_SCOPE], writeScope: GLOBAL_SCOPE }
    }
    return { workspaceId, readScopes: [explicit, GLOBAL_SCOPE], writeScope: explicit }
  }

  // 无 cwd（无 workspace 归属）→ 无论何种配置模式都降级只走 global
  if (workspaceId === null) {
    return { workspaceId: null, readScopes: [GLOBAL_SCOPE], writeScope: GLOBAL_SCOPE }
  }

  // 按配置模式路由
  switch (input.configScope) {
    case 'global':
      return { workspaceId, readScopes: [GLOBAL_SCOPE], writeScope: GLOBAL_SCOPE }
    case 'global-first':
      // 读：global 优先，再当前 workspace；写：当前 workspace
      return { workspaceId, readScopes: [GLOBAL_SCOPE, workspaceId], writeScope: workspaceId }
    case 'workspace':
    default:
      // 读：当前 workspace 优先，global 附加；写：当前 workspace
      return { workspaceId, readScopes: [workspaceId, GLOBAL_SCOPE], writeScope: workspaceId }
  }
}
