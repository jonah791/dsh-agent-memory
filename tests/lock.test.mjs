/**
 * 按键串行锁离线单测（2026-09-13 记忆压缩幂等缺口修复配套）
 *
 * 覆盖：同键串行（并发不重叠）/ 异键并行 / 异常不毒化链 / 严格顺序 / 链尾清理 / 大量并发仍串行
 * 运行：pnpm test（先 build 再 node --test）
 */

import { describe, test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { withKeyLock, lockKeys, resetLocks } from '../lib/lock.js'

/** 可手动放行的闸门（用于观测「谁真的在临界区里」） */
function gate() {
  let release
  const p = new Promise((resolve) => { release = resolve })
  return { p, release }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

describe('withKeyLock 按键串行锁', () => {
  beforeEach(() => { resetLocks() })

  test('同键任务排队串行：并发不重叠', async () => {
    let active = 0
    let maxActive = 0
    const g = gate()
    const task = async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await g.p
      active--
      return 'done'
    }
    const p1 = withKeyLock('k', task)
    const p2 = withKeyLock('k', task)
    await tick()
    assert.equal(active, 1, '第二个任务必须排队等第一个释放，不得同时在临界区')
    g.release()
    assert.deepEqual(await Promise.all([p1, p2]), ['done', 'done'])
    assert.equal(maxActive, 1)
  })

  test('异键并行：互不阻塞', async () => {
    let active = 0
    let maxActive = 0
    const g = gate()
    const task = async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await g.p
      active--
    }
    const p1 = withKeyLock('k1', task)
    const p2 = withKeyLock('k2', task)
    await tick()
    assert.equal(active, 2, '不同键必须能同时在飞（锁粒度不能退化成全局锁）')
    g.release()
    await Promise.all([p1, p2])
    assert.equal(maxActive, 2)
  })

  test('前序任务抛错不毒化链：后到者照常执行', async () => {
    const p1 = withKeyLock('k', async () => { throw new Error('boom') })
    const p2 = withKeyLock('k', async () => 'ok')
    await assert.rejects(p1, /boom/)
    assert.equal(await p2, 'ok', '压缩失败必须能在下一次重试（§5.10 预防性存活）')
  })

  test('严格顺序：后到者在锁内才开始（前序结束后）', async () => {
    const order = []
    const p1 = withKeyLock('k', async () => {
      order.push('first-start')
      await new Promise((resolve) => setTimeout(resolve, 5))
      order.push('first-end')
      return 1
    })
    const p2 = withKeyLock('k', async () => {
      order.push('second-start')
      return 2
    })
    await Promise.all([p1, p2])
    assert.deepEqual(order, ['first-start', 'first-end', 'second-start'])
  })

  test('链尾清理：settle 后键从表里移除（不泄漏）', async () => {
    await withKeyLock('k', async () => 1)
    await tick()
    assert.deepEqual(lockKeys(), [])
  })

  test('50 个并发同键任务：每个都执行，且任意时刻只有 1 个在临界区', async () => {
    let active = 0
    let maxActive = 0
    let ran = 0
    const ps = Array.from({ length: 50 }, () => withKeyLock('k', async () => {
      active++
      ran++
      maxActive = Math.max(maxActive, active)
      await tick()
      active--
    }))
    await Promise.all(ps)
    assert.equal(ran, 50, '排队不等于丢弃：50 个请求都要执行')
    assert.equal(maxActive, 1)
  })
})
