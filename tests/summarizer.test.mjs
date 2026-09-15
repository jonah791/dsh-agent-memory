/**
 * 总结器离线单测（T6 验收）：覆盖
 * - buildSummaryPrompt：条目清单 / 时间范围 / 周记模板注入（仅 week）/ 多行正文缩进
 * - summarizeEntries 直调全路径：成功流 / usage 透传 / finish error / max-tokens /
 *   空输出 / 路由解析（显式配置 > 会话路由 > fail loud）
 * 运行：pnpm test（先 build 再 node --test）
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSummaryPrompt, summarizeEntries } from '../lib/summarizer.js'

/** 标准压缩入参（与 timeline 的 SummarizeInput 同形） */
function makeInput(overrides = {}) {
  return {
    entries: [
      {
        id: 'e1', kind: 'episodic', title: '完成 AlphaFactory 重构', body: '将 core 模块拆分为 5 个服务，接口兼容。',
        tags: ['refactor'], scope: 'workspace-a', level: 'day', bucket: '2026-08-05', archived: false,
        createdAt: '2026-08-05T00:00:00.000Z', updatedAt: '2026-08-05T00:00:00.000Z', accessedAt: '2026-08-05T00:00:00.000Z',
      },
      {
        id: 'e2', kind: 'episodic', title: '修复构建缓存 bug', body: 'pnpm cache 过期导致旧产物。\n已清缓存重建。',
        tags: ['bugfix'], scope: 'workspace-a', level: 'day', bucket: '2026-08-06', archived: false,
        createdAt: '2026-08-06T00:00:00.000Z', updatedAt: '2026-08-06T00:00:00.000Z', accessedAt: '2026-08-06T00:00:00.000Z',
      },
    ],
    level: 'week',
    bucket: '2026-W32',
    range: { start: new Date(2026, 7, 3), end: new Date(2026, 7, 10), label: '2026-W32（2026-08-03 ~ 2026-08-09）' },
    weeklyTemplate: '',
    ...overrides,
  }
}

/** fake ctx：只提供 llm.stream（async generator） */
function fakeCtx(chunks) {
  return {
    llm: {
      stream: async function* () {
        for (const c of chunks) yield c
      },
    },
  }
}

/** 标准文本输出流：一段文本 + usage + stop */
function textStream(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 100, outputTokens: 20 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

describe('buildSummaryPrompt 提示词构建', () => {
  test('包含任务说明、数量、时间范围、条目标题/标签/正文', () => {
    const prompt = buildSummaryPrompt(makeInput())
    assert.ok(prompt.includes('2 条周概要'))
    assert.ok(prompt.includes('2026-W32（2026-08-03 ~ 2026-08-09）'))
    assert.ok(prompt.includes('完成 AlphaFactory 重构'))
    assert.ok(prompt.includes('（标签：refactor）'))
    assert.ok(prompt.includes('将 core 模块拆分为 5 个服务'))
    assert.ok(prompt.includes('修复构建缓存 bug'))
  })

  test('多行正文统一缩进，保持清单结构', () => {
    const prompt = buildSummaryPrompt(makeInput())
    assert.ok(prompt.includes('   pnpm cache 过期导致旧产物。\n   已清缓存重建。'))
  })

  test('week 层级注入周记模板（建议结构）', () => {
    const prompt = buildSummaryPrompt(makeInput({ weeklyTemplate: '总结本周进展与数据，如有未完成事项请单列' }))
    assert.ok(prompt.includes('周记模板（建议结构'))
    assert.ok(prompt.includes('总结本周进展与数据，如有未完成事项请单列'))
  })

  test('month/year 层级不注入周记模板', () => {
    const week = buildSummaryPrompt(makeInput({ level: 'week', weeklyTemplate: '模板A' }))
    assert.ok(week.includes('周记模板'))
    const month = buildSummaryPrompt(makeInput({ level: 'month', weeklyTemplate: '模板A' }))
    assert.ok(!month.includes('周记模板'))
    assert.ok(!month.includes('模板A'))
  })

  test('空周记模板不产生模板段落', () => {
    const prompt = buildSummaryPrompt(makeInput({ weeklyTemplate: '   ' }))
    assert.ok(!prompt.includes('周记模板'))
  })

  test('长度上限（v0.8.1）：缺省 6000 字，且显式劝阻搬运原文', () => {
    const prompt = buildSummaryPrompt(makeInput())
    assert.ok(prompt.includes('正文不超过 6000 字'))
    assert.ok(prompt.includes('导航层'))
    assert.ok(prompt.includes('不要逐字搬运原文'))
  })

  test('长度上限可覆盖（第二参数）', () => {
    const prompt = buildSummaryPrompt(makeInput(), 2500)
    assert.ok(prompt.includes('正文不超过 2500 字'))
    assert.ok(!prompt.includes('正文不超过 6000 字'))
  })
})

describe('summarizeEntries 直调全路径', () => {
  test('成功：正文拼接 + 显式路由 + usage 透传', async () => {
    const ctx = fakeCtx(textStream('本周完成了重构与缓存修复。'))
    const result = await summarizeEntries(ctx, { provider: 'deepseek', model: 'deepseek-chat' }, makeInput())
    assert.equal(result.body, '本周完成了重构与缓存修复。')
    assert.equal(result.provider, 'deepseek')
    assert.equal(result.model, 'deepseek-chat')
    assert.equal(result.maxTokens, 16000)   // v0.4（2026-09-04 主人指示）8000 → 16000；本断言曾滞后于实现（npm test 长期跑不起来，故未被发现）
    assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 20 })
  })

  test('maxTokens 使用配置值', async () => {
    const ctx = fakeCtx(textStream('概要'))
    const result = await summarizeEntries(ctx, { provider: 'deepseek', model: 'deepseek-chat', maxTokens: 500 }, makeInput())
    assert.equal(result.maxTokens, 500)
  })

  test('多文本块按序拼接', async () => {
    const ctx = fakeCtx([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '第一段。' },
      { type: 'block-end', index: 0, block: { type: 'text', text: '第一段。' } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: '第二段。' },
      { type: 'block-end', index: 1, block: { type: 'text', text: '第二段。' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    const result = await summarizeEntries(ctx, { provider: 'deepseek', model: 'deepseek-chat' }, makeInput())
    assert.equal(result.body, '第一段。\n第二段。')
  })

  test('finish error → 抛错且透传 code', async () => {
    const ctx = fakeCtx([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '部分输出' },
      { type: 'block-end', index: 0, block: { type: 'text', text: '部分输出' } },
      { type: 'finish', reason: { kind: 'error', failure: { message: 'rate limited', code: 'RATE_LIMIT' } } },
    ])
    await assert.rejects(
      () => summarizeEntries(ctx, { provider: 'deepseek', model: 'deepseek-chat' }, makeInput()),
      (err) => err.message.includes('rate limited') && err.code === 'RATE_LIMIT',
    )
  })

  test('finish aborted → 抛错', async () => {
    const ctx = fakeCtx([
      { type: 'finish', reason: { kind: 'aborted', failure: { message: 'cancelled', code: 'ABORTED' } } },
    ])
    await assert.rejects(
      () => summarizeEntries(ctx, { provider: 'deepseek', model: 'deepseek-chat' }, makeInput()),
      /cancelled/,
    )
  })

  test('finish max-tokens → 抛 MAX_TOKENS（fail closed）', async () => {
    const ctx = fakeCtx([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '截断内容' },
      { type: 'block-end', index: 0, block: { type: 'text', text: '截断内容' } },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ])
    await assert.rejects(
      () => summarizeEntries(ctx, { provider: 'deepseek', model: 'deepseek-chat' }, makeInput()),
      (err) => err.code === 'MAX_TOKENS',
    )
  })

  test('截断错误附可归因证据（v0.8.2）：已产出字符数 + usage', async () => {
    const ctx = fakeCtx([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '写了很久还没写完的正文' },
      { type: 'block-end', index: 0, block: { type: 'text', text: '写了很久还没写完的正文' } },
      { type: 'usage', usage: { inputTokens: 9000, outputTokens: 16000 } },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ])
    await assert.rejects(
      () => summarizeEntries(ctx, { provider: 'p', model: 'm' }, makeInput()),
      (err) => {
        assert.equal(err.code, 'MAX_TOKENS')
        assert.ok(err.message.includes('已产出 11 字符'), `实际消息：${err.message}`)
        assert.ok(err.message.includes('"outputTokens":16000'))
        return true
      },
    )
  })

  test('模型未产出文本 → 抛错', async () => {
    const ctx = fakeCtx([{ type: 'finish', reason: { kind: 'stop' } }])
    await assert.rejects(
      () => summarizeEntries(ctx, { provider: 'deepseek', model: 'deepseek-chat' }, makeInput()),
      /未产出任何文本概要/,
    )
  })

  test('路由回退：配置为空 + agent 会话路由可用 → 用会话路由', async () => {
    const ctx = fakeCtx(textStream('概要'))
    const agent = {
      session: {
        requestHeader: () => ({ config: { provider: 'session-provider', model: 'session-model' } }),
      },
    }
    const result = await summarizeEntries(ctx, { provider: '', model: '' }, makeInput(), agent)
    assert.equal(result.provider, 'session-provider')
    assert.equal(result.model, 'session-model')
  })

  test('路由回退：配置部分为空 + agent 路由 → 会话路由优先', async () => {
    const ctx = fakeCtx(textStream('概要'))
    const agent = {
      session: {
        requestHeader: () => ({ config: { provider: 'session-provider', model: 'session-model' } }),
      },
    }
    // provider 给了但 model 空 → 视为未完整配置，回退会话路由
    const result = await summarizeEntries(ctx, { provider: 'deepseek', model: '' }, makeInput(), agent)
    assert.equal(result.provider, 'session-provider')
  })

  test('路由 fail loud：无配置且无会话路由 → 抛错', async () => {
    const ctx = fakeCtx(textStream('概要'))
    await assert.rejects(
      () => summarizeEntries(ctx, { provider: '', model: '' }, makeInput()),
      (err) => err.message.includes('缺少 provider/model'),
    )
  })

  test('signal 透传：中止流 → 抛错', async () => {
    const ctx = fakeCtx([
      { type: 'finish', reason: { kind: 'aborted', failure: { message: 'signal aborted', code: 'ABORTED' } } },
    ])
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      () => summarizeEntries(ctx, { provider: 'deepseek', model: 'deepseek-chat' }, makeInput(), undefined, controller.signal),
      /signal aborted/,
    )
  })
})

describe('sessionId 透传（v0.8.1 · 网关类 provider 的 x-opencode-session 头）', () => {
  /** 捕获 GenerateOptions 的 fake ctx（断言「发出去的请求带什么」） */
  function capturingCtx(chunks, capture) {
    return {
      llm: {
        stream: async function* (options) {
          capture.push(options)
          for (const c of chunks) yield c
        },
      },
    }
  }

  test('有 agent ⇒ 自动带 agent.session.id（懒压缩路径）', async () => {
    const capture = []
    const ctx = capturingCtx(textStream('概要'), capture)
    const agent = {
      session: {
        id: 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
      },
    }
    await summarizeEntries(ctx, { provider: '', model: '' }, makeInput(), agent)
    assert.equal(capture[0].sessionId, 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
  })

  test('无 agent ⇒ 显式 sessionId 参数生效（周期补压路径）', async () => {
    const capture = []
    const ctx = capturingCtx(textStream('概要'), capture)
    await summarizeEntries(
      ctx, { provider: 'p', model: 'm' }, makeInput(), undefined, undefined, undefined, 'session-periodic',
    )
    assert.equal(capture[0].sessionId, 'session-periodic')
  })

  test('零回归：两者皆无 ⇒ options 里**不含** sessionId 键（形状与 v0.8.0 一致）', async () => {
    const capture = []
    const ctx = capturingCtx(textStream('概要'), capture)
    await summarizeEntries(ctx, { provider: 'p', model: 'm' }, makeInput())
    assert.equal('sessionId' in capture[0], false)
  })

  test('agent 缺 session.id 也不崩，且不加键', async () => {
    const capture = []
    const ctx = capturingCtx(textStream('概要'), capture)
    const agent = { session: { requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) } }
    const result = await summarizeEntries(ctx, { provider: '', model: '' }, makeInput(), agent)
    assert.equal(result.provider, 'p')
    assert.equal('sessionId' in capture[0], false)
  })
})
