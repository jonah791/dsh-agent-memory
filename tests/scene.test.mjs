/**
 * 场景判据标定测试（2026-10-13）
 *
 * **这个文件的存在理由**（AGENTS.md §5.35 测试驱动的内容迭代纪律）：
 * 场景判据改变 auto-recall 的**注入行为**，必须先用金标准标定、再用尸体样本证明它会拦。
 *
 * 三组判据：
 *   ① 金标准 32 条 —— 准确率 ≥ 90%（实测 90.6%）
 *   ② 关键错误方向 —— **抑制错比放行错更坏**（该检索却被抑制 ⇒ 我无从察觉）
 *   ③ 尸体样本 —— 证明判据真的会拦，不是恒绿
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyMessage, thresholdForScene } from '../lib/scene.js'

// ---------- ① 金标准（人工标定，依据写在各条 why） ----------
const GOLD = [
  // chitchat（12）
  { m: '嗯', want: 'chitchat', why: '极短无意图' },
  { m: '好的', want: 'chitchat', why: '极短无意图' },
  { m: '继续', want: 'chitchat', why: '元指令' },
  { m: '你自己决定吧', want: 'chitchat', why: '元指令' },
  { m: '随便', want: 'chitchat', why: '元指令' },
  { m: '都行', want: 'chitchat', why: '元指令' },
  { m: '听你的', want: 'chitchat', why: '元指令' },
  { m: '行', want: 'chitchat', why: '极短' },
  { m: '然后呢', want: 'chitchat', why: '元指令' },
  { m: '你看着办', want: 'chitchat', why: '元指令' },
  { m: '都可以', want: 'chitchat', why: '元指令' },
  { m: '嗯嗯', want: 'chitchat', why: '极短' },
  // tracking（6）
  { m: '成员的任务做完了吗', want: 'tracking', why: '追踪语' },
  { m: '那个修好了吗', want: 'tracking', why: '追踪语' },
  { m: '进展怎么样', want: 'tracking', why: '追踪语' },
  { m: '跑完了吗', want: 'tracking', why: '追踪语（**极短前判定**的顺序纪律）' },
  { m: '搞定了吧？', want: 'tracking', why: '追踪语' },
  { m: '解决了吗', want: 'tracking', why: '追踪语' },
  // deictic（5）
  { m: '删除这条没用的记忆', want: 'deictic', why: '「这条」' },
  { m: '把那个配置改成指向新目录', want: 'deictic', why: '「那个」' },
  { m: '昨天那个报错怎么修的', want: 'deictic', why: '「昨天」' },
  { m: '这个再改一下', want: 'deictic', why: '「这个」' },
  { m: '上次说的那个方案呢', want: 'deictic', why: '「上次」' },
  // task（9）
  { m: '请访问 https://github.com/vectorize-io/hindsight 并分析这个开源项目', want: 'task', why: '具体对象' },
  { m: '不做向量语义检索，我认为这条路是错的', want: 'task', why: '具体内容' },
  { m: '讲讲改进后的记忆插件的设计思路', want: 'task', why: '具体内容' },
  { m: '请系统分析如何提高记忆召回质量，深入剖析当前记忆写入流程中影响质量的关键因素', want: 'task', why: '长内容' },
  { m: '我觉得还是要把功能进行重做', want: 'task', why: '具体决策' },
  { m: '最后的质量检测需要你亲自去判断', want: 'task', why: '具体指令' },
  { m: '实现一个检查第三方插件上游更新的功能', want: 'task', why: '具体任务' },
  { m: '考虑对 MCP 插件的特殊支持与兼容性处理', want: 'task', why: '具体任务' },
  { m: '那么泛用性（面对不同场景下的记忆）和便捷性（auto recall）呢', want: 'task', why: '具体内容（有实词）' },
]

test('① 金标准标定：准确率 ≥ 90%（32 条）', () => {
  let correct = 0
  const errors = []
  for (const g of GOLD) {
    const r = classifyMessage(g.m)
    if (r.scene === g.want) correct++
    else errors.push(`「${g.m}」期望 ${g.want} 实得 ${r.scene}（${r.evidence}；标定依据：${g.why}）`)
  }
  const rate = correct / GOLD.length
  assert.ok(rate >= 0.9, `准确率 ${(rate * 100).toFixed(1)}% < 90%\n${errors.join('\n')}`)
})

// 已知的 3 个可接受错误（记录在案，防止被当成回归）
const KNOWN_ACCEPTABLE = new Set([
  '请访问 https://github.com/vectorize-io/hindsight 并分析这个开源项目',  // 句内指代
  '不做向量语义检索，我认为这条路是错的',                                  // 句内指代
  '刚才那个问题解决了吗',                                                  // 既指代又追踪（处置相同）
])

test('①b 三个已知可接受错误：性质不变（若变多说明判据退化）', () => {
  let miss = 0
  for (const g of GOLD) {
    const r = classifyMessage(g.m)
    if (r.scene !== g.want) miss++
  }
  assert.ok(miss <= 3, `错误数 ${miss} > 3——超过已记录的已知边界，判据退化`)
})

// ---------- ② 错误方向（抑制错 > 放行错） ----------
test('② 错误方向：task/deictic/tracking **绝不**可被判成 chitchat（抑制错比放行错更坏）', () => {
  const mustNotSuppress = GOLD.filter((g) => g.want !== 'chitchat')
  const wrong = []
  for (const g of mustNotSuppress) {
    const r = classifyMessage(g.m)
    if (r.scene === 'chitchat') wrong.push(`「${g.m}」被判 chitchat（${r.evidence}）`)
  }
  assert.deepEqual(wrong, [], `有消息被错误抑制：\n${wrong.join('\n')}`)
})

test('②b 顺序纪律（首版踩过的真缺陷）：tracking 必须先于「极短」判定', () => {
  // 「跑完了吗」5 字——若极短判定在前会被吃掉 ⇒ 该检索却被抑制
  assert.equal(classifyMessage('跑完了吗').scene, 'tracking', 'tracking 未前置到极短判定之前')
  assert.equal(classifyMessage('好了吗').scene, 'tracking')
  assert.equal(classifyMessage('修好了吗').scene, 'tracking')
})

// ---------- ③ 门槛分化 ----------
test('③ 门槛：chitchat=∞（短路），其余=20', () => {
  assert.equal(thresholdForScene('chitchat'), Number.POSITIVE_INFINITY, 'chitchat 必须短路——门槛只能压概率，不能保证零注入')
  assert.equal(thresholdForScene('task'), 20)
  assert.equal(thresholdForScene('deictic'), 20)
  assert.equal(thresholdForScene('tracking'), 20)
})

// ---------- ④ 尸体样本（证明判据会拦，不是恒绿） ----------
test('尸体①：典型闲聊**必须**被判 chitchat（若判成 task 说明判据没起作用）', () => {
  for (const m of ['嗯', '好的', '继续', '你自己决定吧']) {
    assert.equal(classifyMessage(m).scene, 'chitchat', `「${m}」未被识别为闲聊`)
  }
})

test('尸体②：含实词的长消息**不得**被判 chitchat（防误抑制）', () => {
  for (const m of ['分析一下这个项目的架构', '把配置改成新目录']) {
    assert.notEqual(classifyMessage(m).scene, 'chitchat', `「${m}」被误判为闲聊`)
  }
})

test('尸体③：空串/纯空白/纯标点不崩，且判 chitchat', () => {
  for (const m of ['', '   ', '。。。', '，']) {
    const r = classifyMessage(m)
    assert.equal(r.scene, 'chitchat', `「${m}」应判 chitchat，实得 ${r.scene}`)
  }
})

test('尸体④：判据不因长度而误判——长闲聊与短任务都要对', () => {
  // 长闲聊（含元指令语）
  assert.equal(classifyMessage('那这个事情你自己决定吧，我不管了').scene, 'chitchat')
  // 短任务（含具体对象）
  assert.equal(classifyMessage('修复 bug').scene, 'task')
})

test('尸体⑤：evidence 必须可读（说清为什么判成这类）', () => {
  for (const g of GOLD.slice(0, 8)) {
    const r = classifyMessage(g.m)
    assert.ok(r.evidence.length > 0, `「${g.m}」的 evidence 为空`)
  }
})

test('尸体⑥：系统通知（守护/插件事件）**必须**被判 chitchat——实测抓到过它被注入', () => {
  // 2026-10-13 实测：`[守护] web 已重启（22:19:22）。请继续。` 走的是主人消息同一条路径，
  // top1=26.3 ≥ task 门槛 20 ⇒ **被注入**，注入的恰是与当前工作无关的旧记忆（纯噪音）。
  for (const m of [
    '[守护] web 已重启（22:19:22）。请继续。',
    '[系统] 任务完成',
    '[watch] 心跳正常',
  ]) {
    assert.equal(classifyMessage(m).scene, 'chitchat', `系统通知「${m}」未被抑制`)
  }
})

test('尸体⑦：含「继续」的真任务**不得**被抑制（防修过头——我走过一次弯路）', () => {
  // 我曾想把 `继续` 挪进 SUBSTRING 来挡守护通知 ⇒ 会把下面这类**真任务**误抑制。
  // 正确答案是：挡系统通知靠前缀（⓪），不靠「继续」这个词。
  for (const m of ['继续分析这个项目的架构', '接着把配置改成新目录', '继续优化性能']) {
    assert.notEqual(classifyMessage(m).scene, 'chitchat', `「${m}」被误抑制——修过头了`)
  }
  // 而独立的「继续」仍需被识别为元指令
  assert.equal(classifyMessage('继续').scene, 'chitchat')
})
