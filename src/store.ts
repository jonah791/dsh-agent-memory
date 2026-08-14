/**
 * 存储层：条目 CRUD + 去重合并（IMPLEMENTATION.md §2.2）
 *
 * 对接 ctx.storage.domain 的 kv 表（KvTable<string, Entry>）：
 * - key 格式 `<scope>:<kind>:<id>`（domain 即命名空间，规格 §2.2 取证结论）
 * - 读取走内存快照（get/entries 均为同步），写入走 put/delete（持久化后生效）
 * - 去重合并：L1 按 (scope, key) 精确匹配 → updated；L2/L3 按 title 归一化指纹 → merged
 * - 归档条目（archived）不参与查重——冷归档是「保留但不活跃」，新写入应新建
 *
 * 通过最小 KvLike 接口注入 kv 表，离线测试可注入内存 mock（官方
 * storage-domain 测试即此模式：tests/helpers/memory-backend.ts）。
 */

import { randomUUID } from 'node:crypto'
import type { Entry, EntryKind, RememberResult, TimelineLevel } from './types.ts'

/**
 * kv 最小接口：KvTable<string, Entry> 的能力子集。
 * 生产由 storage-domain 的 table('entries') 满足；测试注入内存实现。
 */
export interface KvLike {
  /** 同步读单条；不存在返回 undefined */
  get(key: string): Entry | undefined
  /** 持久化写入（整条覆盖） */
  put(key: string, value: Entry): Promise<void>
  /** 持久化删除；返回该 key 是否原本存在 */
  delete(key: string): Promise<boolean>
  /** 快照迭代器：[key, entry] 全量遍历 */
  entries(): IterableIterator<[string, Entry]>
  /** 当前记录数 */
  readonly size: number
}

/** 新条目草稿（id / 时间戳 / 归档标记由存储层生成） */
export interface EntryDraft {
  kind: EntryKind
  /** L1 精确覆盖键（可选的显式身份） */
  key?: string
  title: string
  body: string
  tags?: string[]
  /** global 或 workspaceId */
  scope: string
  level: TimelineLevel | null
  bucket: string | null
  source?: Entry['source']
  /** summary → 原始条目 id 列表（T6 压缩产物，规格 §2.1） */
  archiveRef?: string[]
}

/** 条目更新补丁（按 id 定位，缺省字段不动） */
export interface EntryPatch {
  title?: string
  body?: string
  tags?: string[]
}

/** 存储层统计（memory_stats 工具用） */
export interface MemoryStats {
  total: number
  byKind: Partial<Record<EntryKind, number>>
  byLevel: Partial<Record<TimelineLevel, number>>
  bucketCounts: Record<string, number>
  archiveCount: number
}

/**
 * key 编码：<scope>:<kind>:<id>。
 * domain（agent-memory）已是命名空间，表内 key 不再重复前缀（队长定稿，规格 §2.2 取证结论）。
 */
export function memoryKey(scope: string, kind: EntryKind, id: string): string {
  return `${scope}:${kind}:${id}`
}

/** title 归一化：去首尾空白、折叠连续空白、小写（L2/L3 查重指纹的输入） */
export function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** title 确定性指纹：FNV-1a 32bit → hex（L2/L3 查重用） */
export function titleFingerprint(title: string): string {
  let hash = 0x811c9dc5
  const normalized = normalizeTitle(title)
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}

/**
 * 记忆存储：包装一张 kv 表，提供条目 CRUD 与去重合并。
 * 所有单条定位按 (scope, id)（工具契约只有 id）；去重查重按 scope 内扫描
 * （v1 条目量小，全量内存过滤可接受，规格 §2.2 明示）。
 */
export class MemoryStore {
  constructor(private readonly kv: KvLike) {}

  /** 按 (scope, id) 读单条（跨 kind 扫描；不存在返回 undefined） */
  get(scope: string, id: string): Entry | undefined {
    for (const [, entry] of this.kv.entries()) {
      if (entry.scope !== scope || entry.id !== id) continue
      return { ...entry }
    }
    return undefined
  }

  /** 当前 scope 全量条目（快照拷贝，防止外部误改存储对象；可含归档） */
  list(scope: string, opts: { includeArchive?: boolean } = {}): Entry[] {
    const out: Entry[] = []
    for (const [, entry] of this.kv.entries()) {
      if (entry.scope !== scope) continue
      if (!opts.includeArchive && entry.archived) continue
      out.push({ ...entry })
    }
    return out
  }

  /**
   * remember 主入口：查重 → 更新不新增。
   * - L1（带 key）：(scope, key) 精确匹配 → updated（精确覆盖语义）
   * - L2/L3（knowledge/episodic）：title 归一化指纹匹配 → merged（标签并集 + 正文追加）
   * - 无命中 → created（新建条目）
   */
  async remember(draft: EntryDraft): Promise<RememberResult> {
    const now = new Date().toISOString()
    const { scope, kind } = draft

    // L1：key 精确覆盖（key 即显式身份，同 (scope, key) 视为同一槽位）
    if (draft.key !== undefined) {
      const existing = this.findByKey(scope, draft.key)
      if (existing !== undefined) {
        const updated: Entry = {
          ...existing,
          title: draft.title,
          body: draft.body,
          tags: draft.tags ?? [],
          updatedAt: now,
          accessedAt: now,
          ...(draft.source !== undefined ? { source: draft.source } : {}),
        }
        await this.kv.put(memoryKey(scope, existing.kind, existing.id), updated)
        return { id: existing.id, action: 'updated' }
      }
    }

    // L2/L3：title 指纹查重 → 合并（不新增条目）
    if (kind === 'knowledge' || kind === 'episodic') {
      const existing = this.findByTitleFingerprint(scope, kind, draft.title)
      if (existing !== undefined) {
        const merged = this.mergeEntry(existing, draft, now)
        await this.kv.put(memoryKey(scope, kind, existing.id), merged)
        return { id: existing.id, action: 'merged' }
      }
    }

    // 无命中：新建
    const entry: Entry = {
      id: randomUUID(),
      kind,
      key: draft.key,
      title: draft.title,
      body: draft.body,
      tags: draft.tags ?? [],
      scope,
      createdAt: now,
      updatedAt: now,
      accessedAt: now,
      level: draft.level ?? null,
      bucket: draft.bucket ?? null,
      archived: false,
      ...(draft.source !== undefined ? { source: draft.source } : {}),
      ...(draft.archiveRef !== undefined ? { archiveRef: draft.archiveRef } : {}),
    }
    await this.kv.put(memoryKey(scope, kind, entry.id), entry)
    return { id: entry.id, action: 'created' }
  }

  /** 按 (scope, id) 更新：缺省字段不动，时间戳刷新；不存在返回 undefined */
  async update(scope: string, id: string, patch: EntryPatch): Promise<Entry | undefined> {
    const existing = this.get(scope, id)
    if (existing === undefined) return undefined
    const now = new Date().toISOString()
    const updated: Entry = {
      ...existing,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.body !== undefined ? { body: patch.body } : {}),
      ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
      updatedAt: now,
      accessedAt: now,
    }
    await this.kv.put(memoryKey(scope, existing.kind, id), updated)
    return { ...updated }
  }

  /** 归档（软删除）：置 archived，不进活跃检索；reason 记入 source */
  async forget(scope: string, id: string, reason?: string): Promise<Entry | undefined> {
    const existing = this.get(scope, id)
    if (existing === undefined) return undefined
    const now = new Date().toISOString()
    const archived: Entry = {
      ...existing,
      archived: true,
      updatedAt: now,
      ...(reason !== undefined
        ? { source: { ...existing.source, reason } }
        : {}),
    }
    await this.kv.put(memoryKey(scope, existing.kind, id), archived)
    return { ...archived }
  }

  /** 硬删除（压缩/清理路径使用）；返回该条目是否原本存在 */
  async remove(scope: string, id: string): Promise<boolean> {
    const existing = this.get(scope, id)
    if (existing === undefined) return false
    return this.kv.delete(memoryKey(scope, existing.kind, id))
  }

  /** 统计（memory_stats 工具用）：按 kind/level/bucket/归档计数 */
  stats(scope: string): MemoryStats {
    const byKind: Partial<Record<EntryKind, number>> = {}
    const byLevel: Partial<Record<TimelineLevel, number>> = {}
    const bucketCounts: Record<string, number> = {}
    let archiveCount = 0
    let total = 0
    for (const [, entry] of this.kv.entries()) {
      if (entry.scope !== scope) continue
      total += 1
      byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1
      if (entry.level !== null) byLevel[entry.level] = (byLevel[entry.level] ?? 0) + 1
      if (entry.bucket !== null) bucketCounts[entry.bucket] = (bucketCounts[entry.bucket] ?? 0) + 1
      if (entry.archived) archiveCount += 1
    }
    return { total, byKind, byLevel, bucketCounts, archiveCount }
  }

  /** (scope, key) 精确匹配活跃条目（L1 查重） */
  private findByKey(scope: string, key: string): Entry | undefined {
    for (const [, entry] of this.kv.entries()) {
      if (entry.scope !== scope || entry.key !== key || entry.archived) continue
      return entry
    }
    return undefined
  }

  /** (scope, kind, title指纹) 匹配活跃条目（L2/L3 查重） */
  private findByTitleFingerprint(scope: string, kind: EntryKind, title: string): Entry | undefined {
    const fingerprint = titleFingerprint(title)
    for (const [, entry] of this.kv.entries()) {
      if (entry.scope !== scope || entry.kind !== kind || entry.archived) continue
      if (titleFingerprint(entry.title) === fingerprint) return entry
    }
    return undefined
  }

  /** 合并语义：标签并集 + 正文追加（正文相同则不重复追加），保留原 id/createdAt */
  private mergeEntry(existing: Entry, draft: EntryDraft, now: string): Entry {
    const tags = [...new Set([...existing.tags, ...(draft.tags ?? [])])]
    const body = existing.body.trim() === draft.body.trim()
      ? existing.body
      : `${existing.body}\n\n${draft.body}`
    return {
      ...existing,
      title: draft.title,
      body,
      tags,
      updatedAt: now,
      accessedAt: now,
      ...(draft.source !== undefined ? { source: draft.source } : {}),
    }
  }
}
