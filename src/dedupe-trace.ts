/**
 * 近重复处置轨迹的 IO 层（2026-10-28 · lh-0f54524a）。
 *
 * 为什么单独一个文件，而不是塞进 dedupe.ts 或 access-trace.ts：
 *  - `dedupe.ts` 是**纯逻辑**（离线可测、无 IO）——它是「什么算近重复」的判据单一真源，
 *    被 IO 污染后单测就得碰文件系统
 *  - `access-trace.ts` 已经在承担用量轨迹，主题不同；混进去会让「哪条侧车归谁」再次失焦
 *  ⇒ 对齐 `compress-trace.ts` 的形态：**纯解析在 X.ts、IO 包装在 X-trace.ts**。
 *
 * 纪律同 `access-trace.ts`：只追加（POSIX append 天然免锁）/ 吞错 / 按体积轮转 / 绝不改条目。
 *
 * ⚠ 本层的核心契约是**三态**，读的人必须分清：
 *   - 返回数组（可能是空） ⇒ **读到了**，空数组就是「真的零记录」
 *   - 返回 `undefined`      ⇒ **读不到**（文件不存在 / 权限 / 解析全废）
 *   把后者读成前者，就会把「不知道」当成「零欠账」——那正是这类诊断最常见的病。
 */

import { readFile } from 'node:fs/promises'
import type { DedupeTraceRecord } from './dedupe.ts'
import { parseDedupeTrace } from './dedupe.ts'
import { appendJsonl } from './access-trace.ts'

/**
 * 追加一批处置轨迹（**吞错**：写失败只返回 false，绝不抛、绝不阻塞 remember）。
 *
 * 为什么是「一批」而不是一条：一次 remember 命中 N 条候选时要写 N 条 hit
 * （处置时再加 N 条 disposed）。逐条调用会让每次 remember 做 N 次 stat + open，
 * 而这一批在语义上本来就是**同一次撞车**，一起写才对应得上。
 */
export async function appendDedupeTrace(
  filePath: string,
  records: DedupeTraceRecord[],
  maxBytes: number,
): Promise<boolean> {
  if (records.length === 0) return true
  let allOk = true
  for (const record of records) {
    const ok = await appendJsonl(filePath, record, maxBytes)
    if (!ok) allOk = false
  }
  return allOk
}

/**
 * 读取处置轨迹。**不可读 ⇒ `undefined`**（调用方按「不知道」处理，不得读成「零欠账」）。
 * 文件不存在也算 `undefined`：首次使用时它本来就不存在，而「没有这个文件」与
 * 「有文件但里面没有记录」对诊断是两件事——前者说明这条侧车从未被写过。
 */
export async function readDedupeTrace(filePath: string): Promise<DedupeTraceRecord[] | undefined> {
  try {
    const text = await readFile(filePath, 'utf8')
    return parseDedupeTrace(text)
  } catch {
    return undefined
  }
}
