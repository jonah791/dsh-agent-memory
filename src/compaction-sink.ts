/**
 * 压缩即记忆（DESIGN.md 通道 C：compaction 联动）
 *
 * 订阅会话事件流（session/event firehose），把每次成功的会话压缩 checkpoint
 * 保底存档为 L3 情景记忆（episodic）——**智能体核心联动（2026-08-15 主人定调）**：
 * - compaction/start   → 记录事务（按 compactionId）
 * - compaction/summary → 记录摘要文本
 * - compaction/end（无 error）→ 原文保底落库（scope = 会话 cwd 的 workspace）
 *   + **inbox 通知（wakeup=true 自动送达）**：压缩完成即唤醒送达，把决策权交给
 *   爱丽丝——提炼与否/如何组织/记忆库健康，由爱丽丝自主决定（理由记入 source.reason）
 * - **不再写哨兵/不再重启**：压缩在进程内已完整，零打断当前思维（忙时排队等
 *   当前 turn 结束，空闲立即处理）；压缩时 agent 必醒着（活跃期决策发起），
 *   不存在睡眠被打断的场景（2026-08-16 主人定调：完成即送达，不等主人下一条消息）
 * 失败（end 带 error）不落库不通知；落库失败静默（幂等，下次压缩再试）。
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
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
    // 保底存档（fire-and-forget：失败静默，压缩幂等下次再试）
    const notify = (entryId: string) => {
      // 智能体核心（2026-08-16 主人定调：压缩完成自动送达）：wakeup=true——
      // 空闲立即唤醒处理；忙则当前思维结束后处理（压缩时 agent 必醒着，无睡眠打断）；
      // 决策（提炼/归档/整理）归爱丽丝
      const agent = ctx.agents?.get(session.id)
      if (agent === undefined) return
      const text = '[memory] 会话刚完成一次压缩，checkpoint 原文已存档为条目 ' + entryId
        + '（scope=' + scope + '）。是否提炼记忆版、如何组织，由你决定。'
      try {
        agent.send(
          createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'dsh-agent-memory' } }),
          'next-turn',
          true, // wakeup=true：压缩完成即自动送达（主人 2026-08-16：不等主人下一条消息）
        )
      } catch { /* 通知失败不阻塞；原文已存档，不会丢 */ }
    }
    void deps.store.remember({
      kind: 'episodic',
      title,
      body: text,
      tags: ['compaction'],
      scope,
      level: null,
      bucket: null,
      source: { sessionId: session.id, reason: 'compaction/end' },
    }).then((result) => { notify(result.id) }).catch(() => { /* 落库失败静默 */ })
  })
}