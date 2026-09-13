/**
 * 按键串行锁（进程内，跨实例共享）——2026-09-13 幂等缺口修复。
 *
 * 存在理由（生产事故，非假设）：时间压缩有两个入口——懒压缩钩子（访问记忆时触发）与周期补压
 * （定时轮询，默认 360 分钟），二者**各建一个 TimelineCompressor 实例**。压缩临界区是
 * 「查已有概要 → await LLM 总结 → 写入」，中间横着一次 LLM 网络往返；第二个调用者能在这段
 * 等待里穿过同一道检查 → 同一 (scope, level, bucket) 写出两份概要。生产库实测 **4 对重复日桶**
 * （2026-08-24 / 08-26 / 08-30 / 09-10），每对代价 = 一次重复的 LLM 调用 + 一份重复归档。
 *
 * 语义（重要，与 single-flight 不同）：
 * - 同 key 任务**排队串行**，不是共享同一个在飞结果——后到者进锁后**重新观察状态**，
 *   因此第二次 compressUnit 会在自己的检查处看到刚落库的概要并返回 already-summarized。
 * - 不同 key 互不阻塞（压缩粒度 = scope + 层级 + 桶）。
 * - 前序任务抛错**不毒化链**：后到者照常执行（压缩失败必须能在下一次重试，见 §5.10）。
 *
 * 边界（诚实声明）：只覆盖**进程内**。多实例共享同一 DSH_HOME 时（并行会话是常态工况 §5.14），
 * 跨进程互斥由 compressUnit 的「写前复核」兜底——它把窗口从一次 LLM 往返压缩到两次读写之间。
 */

/** key → 链尾（永不 reject 的守卫 promise），用于排队 */
const tails = new Map<string, Promise<void>>()

/**
 * 同一 key 串行执行；不同 key 并行。返回本次任务自身的结果/异常。
 * @param key 互斥键（见 compressUnitKey——禁止调用点各自拼字符串）
 * @param task 临界区任务
 */
export function withKeyLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve()
  const run = prev.then(() => task())
  // 链尾守卫：吞掉结果与异常，保证后续排队者不被前序失败连带拒绝
  const guard = run.then(
    () => undefined,
    () => undefined,
  )
  tails.set(key, guard)
  void guard.then(() => {
    // 仅当自己仍是链尾时才清理——否则会摘掉后到者的链（键泄漏或提前放行）
    if (tails.get(key) === guard) tails.delete(key)
  })
  return run
}

/** 当前有排队/在飞任务的 key 列表（诊断与测试用）。 */
export function lockKeys(): string[] {
  return [...tails.keys()]
}

/** 清空锁表（仅测试用——避免用例间互相污染）。 */
export function resetLocks(): void {
  tails.clear()
}
