/**
 * 记忆库导出（v0.56 · 方案 §1 第十项「用户控制：可查看、纠正、**导出**、删除」）。
 *
 * ## 它解决什么
 *
 * 记忆库此前只有「留在系统里」这一种存在方式：能查、能改、能删，但**拿不走**。
 * 「拿不走」不是功能缺口，是**所有权缺口**——数据在别人的存储里，我（或主人）就没有
 * 第二种处置方式：换工具、做离线审计、冷备份都做不到。方案把它列进「用户控制」四件事
 * 之一，正是这个意思。
 *
 * ## 三条形态判断（都是先写死再实现的）
 *
 * 1. **落盘，不回灌上下文**。全库 3,100 条 × 平均 1.5KB ≈ 4.7MB，任何把内容塞进工具
 *    返回实现在真实库上都会把一轮上下文撑爆。⇒ 导出体写文件，回执只给
 *    「路径 + 字节 + 计数 + sha256 + 前 N 字符预览」。**预览是给人眼扫一眼的，不是数据**。
 * 2. **敏感默认不导**。`L2`/`L3` 与检索面同一准入（`includeSensitive` 才含）。导出比
 *    检索更危险：检索留在系统内、受 `role` 与调用规则约束；导出**离开系统**，此后一切
 *    准入都不再生效。所以这一条不能用「等价于 recall」来论证，它比 recall 更紧。
 * 3. **不覆盖**。导出文件常常是**唯一备份**，静默覆盖等于销毁一份备份且不留痕
 *    ⇒ 目标已存在即拒，要覆盖必须显式 `overwrite: true`。写入走 `临时文件 + rename`
 *    （原子替换：半截文件比没有文件更坏，它看起来像一份完整导出）。
 *
 * ## 导什么、不导什么
 *
 * 五张表全部导出（条目 / 概念 / 实体 / 来源 / 关系），因为它们是**同一个事实面的不同形状**：
 * 只导条目会丢关系边与词表，拿走的人会得到一个「记得很多但不知道自己知道什么」的库。
 * 侧车（用量轨迹 / 操作者审计 / 遗忘凭证）**不导**，且每次在 `notExported` 里点名——
 * 「没导」与「没有」必须可区分，这正是遗忘传播 `UNOWNED_SURFACES` 的同一条纪律。
 *
 * ## 不做导入（v0.56 的边界，写在这里供未来复查）
 *
 * 导入是写路径，带 id 冲突 / 引用悬空 / 覆盖策略三类判断，且方案要的是「用户能拿走」。
 * 判据因此换成正向等价：导出体与库内对象逐字段比对（`export.test.mjs` E2/E3）。
 * 重开条件：出现第一个「要把导出体读回来」的真实需求（换库迁移 / 恢复事故）。
 */

import { createHash } from 'node:crypto'
import type { Concept, Entity, Entry, Relation, SensitivityLevel, Source } from './types.ts'

/** 导出体格式标识（`version` 必须有：没有它，未来改格式时旧文件无法被识别） */
export const EXPORT_FORMAT = 'aml-export'
export const EXPORT_FORMAT_VERSION = 1

/**
 * 不导出的面（**显式点名**）。
 *
 * 为什么写在导出体里而不是只写在文档里：拿到 JSON 的人不会去读我的文档。
 * 他要能从这个文件本身看出「这里没有的东西是有意的，不是漏了」。
 */
export const EXPORT_NOT_EXPORTED: readonly { surface: string; why: string }[] = Object.freeze([
  { surface: 'access-trace', why: '用量侧车（谁读过什么）属运行观测，不是记忆本体；要看清走 memory_health / memory_misuse' },
  { surface: 'actor-audit', why: '操作者归因与权限拒绝属审计面（memory_trail），把它当记忆导出会让「动作」冒充「知识」' },
  { surface: 'forget-certificates', why: '遗忘凭证属审计面，且含被删条目的标题与计数' },
  { surface: 'session-events', why: '原始档（会话事件日志）由宿主持有，本插件不拥有，拿不到也就不承诺' },
])

/** 回执预览缺省字符数（给人眼扫一眼，不是数据面） */
export const DEFAULT_PREVIEW_CHARS = 240

/**
 * 被排除的量（两个数各答一个不同的问题，不可合并）。
 *
 * ⚠ **归档不是被排除的面**：`archived` 条**恒在导出体内**（它是「我决定不再用」，
 * 不是「不存在」；把它剔掉会让拿走的库看起来比真实的干净）。所以这里没有 `archived` 字段，
 * 而 `counts.archivedEntries` 报的是导出体**内部**有多少条已归档——两个方向不可混读。
 */
export interface ExportOmission {
  /** 敏感分级为 `L2`/`L3` ⇒ 缺省不导（`includeSensitive:true` 才含） */
  sensitive: number
  /** 角色准入拒绝 ⇒ 不可读即不可导出（`gatherReadable` 的 rejected） */
  unreadable: number
}

export interface ExportCounts {
  entries: number
  /** 导出体内**已归档**的条目数（与 `omitted.archived` 是两个方向，不可混读） */
  archivedEntries: number
  concepts: number
  entities: number
  sources: number
  relations: number
}

export interface ExportBundleInput {
  entries: readonly Entry[]
  concepts: readonly Concept[]
  entities: readonly Entity[]
  sources: readonly Source[]
  relations: readonly Relation[]
  scopes: readonly string[]
  omitted: ExportOmission
  exportedAt: string
}

export interface ExportBundle {
  format: string
  formatVersion: number
  exportedAt: string
  scopes: string[]
  counts: ExportCounts
  omitted: ExportOmission
  notExported: readonly { surface: string; why: string }[]
  entries: Entry[]
  concepts: Concept[]
  entities: Entity[]
  sources: Source[]
  relations: Relation[]
}

/**
 * 这条是否因敏感分级而不进缺省导出面。
 *
 * 与 recall 的 `includeSensitive` 同一口径（只有标了 `L2`/`L3` 才拦；**未标注照常导出**——
 * 「没判断过」不等于「敏感」，也不等于「公开」，按既有行为处理）。
 */
export function isSensitiveEntry(entry: Pick<Entry, 'sensitivity'>): boolean {
  const level: SensitivityLevel | undefined = entry.sensitivity
  return level === 'L2' || level === 'L3'
}

/**
 * 组装导出体（纯函数：给定输入，输出确定结构）。
 *
 * 刻意**不做**的三件事：① 不脱敏（脱敏会造出「看起来存在但内容变了」的条目，比缺席更坏：
 * 缺席 + 计数可辨，改写后的条目不可辨）② 不排序（保持库内顺序 = 保持原样，排序是读侧的事）
 * ③ 不刷新 `accessedAt`（导出不是「使用」，把导出记成读取会让用量读数失真）。
 */
export function buildExportBundle(input: ExportBundleInput): ExportBundle {
  const entries = [...input.entries]
  return {
    format: EXPORT_FORMAT,
    formatVersion: EXPORT_FORMAT_VERSION,
    exportedAt: input.exportedAt,
    scopes: [...input.scopes],
    counts: {
      entries: entries.length,
      archivedEntries: entries.filter((entry) => entry.archived).length,
      concepts: input.concepts.length,
      entities: input.entities.length,
      sources: input.sources.length,
      relations: input.relations.length,
    },
    omitted: { ...input.omitted },
    notExported: EXPORT_NOT_EXPORTED,
    entries,
    concepts: [...input.concepts],
    entities: [...input.entities],
    sources: [...input.sources],
    relations: [...input.relations],
  }
}

/** 序列化：两空格缩进 + 结尾换行（人可读，且 diff 友好——导出体常进版本控制） */
export function serializeExportBundle(bundle: ExportBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`
}

/** 内容指纹（回执与文件两侧可核：这是「拿到的就是那一次导出的」唯一的机械判据） */
export function sha256Of(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}
