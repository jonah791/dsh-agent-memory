/**
 * 周期补压机制（v0.3，主人 2026-08-21 定调）。
 *
 * 背景：v0.2 的懒压缩（compress 钩子）只在 recall/memory_stats 访问记忆时 fire-and-forget
 * 触发，且错误静默吞掉——时间桶压缩长期停摆（08-16 起日概要零产出）。主人指示不再深挖
 * 旧机制失效原因，直接创建一个可靠的新机制。
 *
 * 本机制：
 * - 触发：启动延迟首跑（补历史缺口，compressPending 幂等，缺啥压啥）+ 周期轮询
 * - scope：从存储自举（store.scopes()，排除 global——global 层不启用时间压缩，DESIGN.md §五）
 * - 路由：周期任务无 agent 上下文，LLM 路由由调用方注入 summarize（resolveTarget 走
 *   fallbackTarget：config 显式 → 活跃会话 requestHeader（原本设计，由主会话模型总结）
 *   → 懒压缩捕获的会话路由缓存）
 * - 错误：单 scope 失败 console.error 记录（不再静默吞），本轮继续其它 scope；下轮自动重试
 * - 幂等：复用 TimelineCompressor.compressPending（已压缩桶跳过），与懒压缩并存无冲突
 */

import type { Context } from '@deepseek-ai/cordis'
import { GLOBAL_SCOPE } from './scope.ts'
import type { MemoryStore } from './store.ts'
import { TimelineCompressor, type SummarizeFn } from './timeline.ts'
import type { CompressTraceSink } from './compress-trace.ts'
import type { MemoryConfig } from './types.ts'

export interface PeriodicCompressDeps {
  store: MemoryStore
  loadConfig: (workspaceRoot: string) => Promise<MemoryConfig>
  summarize: SummarizeFn
  /**
   * 压缩轨迹接收器工厂（v0.8）：按**该 workspace 自己的** cfg 决定是否落轨迹
   * （`audit.compress_trace.enabled=false` ⇒ 返回 undefined）。不提供即完全不落轨迹。
   */
  traceFactory?: (cfg: MemoryConfig) => CompressTraceSink | undefined
}

export interface PeriodicCompressOptions {
  /** 周期轮询间隔（毫秒） */
  intervalMs: number
  /** 启动延迟首跑（毫秒；补历史缺口） */
  initialDelayMs: number
}

/**
 * 装配周期补压：启动延迟首跑 + 周期轮询，遍历所有非 global scope 执行 compressPending。
 * 生命周期随插件 dispose（ctx.effect 清理定时器）。
 */
export function installPeriodicCompress(
  ctx: Context,
  deps: PeriodicCompressDeps,
  opts: PeriodicCompressOptions,
): void {
  const runOnce = async (): Promise<void> => {
    const scopes = deps.store.scopes().filter((scope) => scope !== GLOBAL_SCOPE)
    for (const scope of scopes) {
      try {
        const cfg = await deps.loadConfig(scope)
        const timelineEnabled = cfg.timeline.day || cfg.timeline.week || cfg.timeline.month || cfg.timeline.year
        if (!timelineEnabled) continue
        const compressor = new TimelineCompressor(deps.store, cfg, deps.summarize, deps.traceFactory?.(cfg))
        const results = await compressor.compressPending(scope)
        const done = results.filter((r) => r.reason === 'compressed')
        if (done.length > 0) {
          const labels = done.map((r) => r.summary !== null ? `${r.summary.level} ${r.summary.bucket}` : r.reason)
          console.log(`[dsh-agent-memory] 周期补压 ${scope}: ${labels.join(', ')}`)
        }
      } catch (error) {
        console.error(`[dsh-agent-memory] 周期补压失败 ${scope}: ${(error as Error).message}`)
      }
    }
  }

  const initial = setTimeout(() => { void runOnce() }, opts.initialDelayMs)
  const timer = setInterval(() => { void runOnce() }, opts.intervalMs)
  ctx.effect(() => {
    return () => {
      clearTimeout(initial)
      clearInterval(timer)
    }
  }, 'agent-memory.periodicCompress')
}
