/**
 * 压缩即记忆（DESIGN.md 通道 C：compaction 联动）
 *
 * 订阅会话事件流（session/event firehose），把每次成功的会话压缩 checkpoint
 * 自动落库为 L3 情景记忆（episodic）：
 * - compaction/start   → 记录事务（按 compactionId）
 * - compaction/summary → 记录摘要文本
 * - compaction/end（无 error）→ checkpoint 落库（scope = 会话 cwd 的 workspace）
 *   ——压缩产物本就是 agent 自总结（dsh-agent-compact），直接复用不重复总结
 * 失败（end 带 error）不落库；落库失败静默（幂等，下次压缩再试）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { MemoryStore } from './store.ts'
import { workspaceIdOf } from './scope.ts'

/** 单个压缩事务的跟踪记录 */
interface CompactionRecord {
  summary?: string
}

/** 落库依赖 */
export interface CompactionSinkDeps {
  store: MemoryStore
}

/**
 * 安装压缩即记忆联动。
 * @param ctx - 插件上下文（session/event firehose）
 * @param deps - 存储依赖
 */
export function installCompactionSink(ctx: Context, deps: CompactionSinkDeps): void {
  // sessionId → compactionId → 记录
  const pending = new Map<string, Map<string, CompactionRecord>>()

  ctx.on('session/event', (session, event) => {
    // compaction/* 是 compaction 插件的扩展事件类型（官方 SessionEventMap 不含），
    // 运行时确有这些字段（实测会话日志）；此处收窄类型避免声明合并依赖。
    const ev = event as unknown as {
      type: string
      data: {
        compactionId: string
        error?: unknown
        summary?: unknown
      }
    }
    if (ev.type === 'compaction/start') {
      let byId = pending.get(session.id)
      if (byId === undefined) {
        byId = new Map()
        pending.set(session.id, byId)
      }
      byId.set(ev.data.compactionId, {})
      return
    }
    if (ev.type === 'compaction/summary') {
      const rec = pending.get(session.id)?.get(ev.data.compactionId)
      if (rec === undefined) return
      const summary = ev.data.summary
      rec.summary = Array.isArray(summary)
        ? summary.map((block) => (block?.type === 'text' ? block.text : '')).filter((t) => t.length > 0).join('\n')
        : undefined
      return
    }
    if (ev.type !== 'compaction/end') return
    const byId = pending.get(session.id)
    const rec = byId?.get(ev.data.compactionId)
    if (rec === undefined) return
    byId?.delete(ev.data.compactionId)
    if (ev.data.error !== undefined) return // 失败不落库
    const text = rec.summary
    if (text === undefined || text.trim().length === 0) return
    const cwd = session.header?.cwd
    const scope = cwd === undefined ? 'global' : workspaceIdOf(cwd)
    const title = `会话压缩检查点 ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`
    // fire-and-forget：落库失败静默（压缩幂等，下次压缩再试）
    void deps.store.remember({
      kind: 'episodic',
      title,
      body: text,
      tags: ['compaction'],
      scope,
      level: null,
      bucket: null,
      source: { sessionId: session.id, reason: 'compaction/end' },
    }).catch(() => {})
  })
}