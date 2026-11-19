/**
 * 方案 §1 第十项「用户控制：可查看、纠正、**导出**、删除」· 判据（E 段）
 *
 * 设计正本 `src/export.ts` 头注。这一层要守的不是「文件写出来了」，而是四件会悄悄错的事：
 * ① **拿出来的东西少了**（敏感 / 角色 / 归档被谁悄悄剔掉）② **拿出来的东西多了**
 * （不该离开系统的内容被带走）③ **拿出来的东西变了**（经过 schema 重建 / 脱敏改写）
 * ④ **回执说谎**（字节 / sha256 / 计数与实际文件不符）。
 *
 * 成对纪律（本仓 2026-11-19 教训）：每条「不该有」都要有一条「该有」的对照——
 * 只有负向断言的测试，在功能被整段删掉时全绿。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EXPORT_FORMAT, EXPORT_FORMAT_VERSION, EXPORT_NOT_EXPORTED, isSensitiveEntry, serializeExportBundle, sha256Of } from '../lib/export.js'
import { MemoryStore } from '../lib/store.js'
import { createMemoryTools } from '../lib/tools.js'
import { workspaceIdOf } from '../lib/scope.js'

class MemoryKv {
  constructor() {
    this.map = new Map()
  }
  get(key) {
    const value = this.map.get(key)
    return value === undefined ? undefined : { ...value }
  }
  async put(key, value) {
    this.map.set(key, { ...value })
  }
  async delete(key) {
    return this.map.delete(key)
  }
  entries() {
    return this.map.entries()
  }
}

const CONFIG = { maxEntries: 500, layers: ['fact', 'knowledge', 'episodic', 'summary'] }

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'aml-export-'))
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true })
}

function setup(options = {}) {
  const cwd = options.cwd ?? tmpDir()
  const config = options.config ?? CONFIG
  const store = new MemoryStore(new MemoryKv())
  const tools = createMemoryTools({ store, loadConfig: () => config })
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const header = { cwd, ...(options.preset !== undefined ? { agentPreset: options.preset } : {}) }
  const exec = { agent: { session: { id: 'session-export', header } } }
  return { store, byName, exec, cwd, wid: workspaceIdOf(cwd) }
}

/** 导出一次并解析落盘文件（几乎所有判据都要「读回来」而不是信回执） */
async function exportOnce(ctx, args = {}) {
  const tool = ctx.byName.get('memory_export')
  const value = await tool.execute({ previewChars: 0, ...args }, ctx.exec)
  const text = readFileSync(value.path, 'utf8')
  return { tool, value, text, bundle: JSON.parse(text) }
}

// ---------- E1 形态常量：不导出面必须点名，敏感判据两侧都认 ----------

test('E1a 不导出的面逐条点名且都给理由（「没导」与「没有」必须可区分）', () => {
  assert.equal(EXPORT_NOT_EXPORTED.length, 4)
  for (const row of EXPORT_NOT_EXPORTED) {
    assert.ok(row.surface.length > 0)
    assert.ok(row.why.length > 10, `${row.surface} 的理由太短，拿到 JSON 的人不能据此判断该找谁`)
  }
  const surfaces = EXPORT_NOT_EXPORTED.map((row) => row.surface)
  for (const required of ['access-trace', 'actor-audit', 'forget-certificates', 'session-events']) {
    assert.ok(surfaces.includes(required), `${required} 必须点名：它是「不导出」里最容易被误读成「漏了」的一条`)
  }
})

test('E1b 敏感判据：L2/L3 拦、L0/L1 与未标注放行（「没判断过」不等于「敏感」）', () => {
  assert.equal(isSensitiveEntry({ sensitivity: 'L0' }), false)
  assert.equal(isSensitiveEntry({ sensitivity: 'L1' }), false)
  assert.equal(isSensitiveEntry({}), false, '未标注按既有行为处理——不拦')
  assert.equal(isSensitiveEntry({ sensitivity: 'L2' }), true)
  assert.equal(isSensitiveEntry({ sensitivity: 'L3' }), true)
})

test('E1c 序列化契约：两空格缩进 + 结尾换行（导出体常进版本控制，diff 要可读）', () => {
  const text = serializeExportBundle({ format: 'x', formatVersion: 1 })
  assert.ok(text.endsWith('\n'))
  assert.match(text, /\n {2}"format"/)
  assert.equal(sha256Of(text).length, 64)
  assert.equal(sha256Of(text), sha256Of(text), '同一内容指纹必须稳定')
  assert.notEqual(sha256Of(text), sha256Of(`${text} `), '多一个字节指纹就得变')
})

// ---------- E2/E3 完整性：条数与字段都不许悄悄少 ----------

test('E2 端到端：导出体计数与库内可见面一致，归档条目**在**导出体里（归档不是「不存在」）', async () => {
  const ctx = setup()
  try {
    const remember = ctx.byName.get('remember')
    assert.ok(remember !== undefined)
    const live = await remember.execute({ text: '# E2 活跃\n正文' }, ctx.exec)
    const gone = await remember.execute({ text: '# E2 已归档\n正文' }, ctx.exec)
    await ctx.byName.get('forget').execute({ id: gone.id, reason: 'E2 fixture' }, ctx.exec)

    const { value, bundle } = await exportOnce(ctx, { path: join(ctx.cwd, 'e2.json') })
    assert.equal(bundle.counts.entries, 2, '活跃与归档都在——导出是快照，不是「还能用的那些」')
    assert.equal(bundle.counts.archivedEntries, 1, '归档条数单列，且是导出体**内部**的数')
    assert.equal(bundle.counts.entries, bundle.entries.length, 'counts 与数组长度不一致 ⇒ 回执在说谎')
    assert.deepEqual(bundle.entries.map((e) => e.id).sort(), [live.id, gone.id].sort())
    assert.equal(value.counts.entries, bundle.counts.entries, '回执与文件同源')
    assert.equal(ctx.store.get(ctx.wid, gone.id).archived, true, '导出不改变归档态（它是只读的）')
  } finally {
    cleanup(ctx.cwd)
  }
})

test('E3 逐字段深相等：导出条目 == 库内条目（不许经 schema 重建 / 脱敏改写 / 白名单裁剪）', async () => {
  const ctx = setup()
  try {
    const remember = ctx.byName.get('remember')
    const created = await remember.execute({
      text: '# E3 字段完整\n正文首段含核心术语',
      tags: ['e3', '导出'],
      aliases: ['E3 别名'],
      provenance: 'measured',
      sensitivity: 'L1',
    }, ctx.exec)
    const inStore = ctx.store.get(ctx.wid, created.id)
    const { bundle } = await exportOnce(ctx, { path: join(ctx.cwd, 'e3.json') })
    const exported = bundle.entries.find((entry) => entry.id === created.id)
    assert.ok(exported !== undefined)
    // 判据边界：JSON 表达不了 `undefined`（`store.get` 会带着 `key: undefined` 这类显式空值）。
    // 所以「逐字段相等」的正确定义是 **JSON 可表达范围内** 相等——不是放宽，是把格式事实写清：
    // 实现若真去重建 / 白名单裁剪字段，下面两条仍会红。
    const jsonView = JSON.parse(JSON.stringify(inStore))
    assert.deepEqual(exported, jsonView, '逐字段深相等——「拿到的」必须就是「库里的」（JSON 可表达范围内）')
    assert.deepEqual(
      Object.keys(exported).sort(),
      Object.keys(inStore).filter((name) => inStore[name] !== undefined).sort(),
      '非 undefined 的字段一个都不许少',
    )
    assert.ok(typeof exported.author?.sessionId === 'string', '嵌套对象也要完整（深相等已覆盖，这条是失败时的定位线索）')
    assert.deepEqual(exported.tags, inStore.tags)
    assert.equal(exported.sensitivity, 'L1', 'L1 照常导出（只有 L2/L3 才拦）')
  } finally {
    cleanup(ctx.cwd)
  }
})

// ---------- E4 敏感：默认不外泄，显式要求才含（两侧都测） ----------

test('E4 敏感条目缺省不导且计数可辨；includeSensitive 才含（导出离开系统，准入此后不再生效）', async () => {
  const ctx = setup()
  try {
    const remember = ctx.byName.get('remember')
    const secretMark = 'Zq4SecretPending'
    const openMark = 'Zq4OpenPub'
    await remember.execute({ text: `# 公开条目\n${openMark}`, sensitivity: 'L0' }, ctx.exec)
    await remember.execute({ text: `# 敏感条目\n${secretMark}`, sensitivity: 'L2' }, ctx.exec)

    const strict = await exportOnce(ctx, { path: join(ctx.cwd, 'strict.json') })
    assert.equal(strict.bundle.omitted.sensitive, 1, '被排除的数量必须报出来——沉默地少一条比少一条更坏')
    assert.ok(!strict.text.includes(secretMark), 'L2 正文进了导出文件 ⇒ 敏感分级被导出旁路了')
    assert.ok(strict.text.includes(openMark), 'L0 必须在（负向全绿的对照）')
    assert.equal(strict.bundle.counts.entries, 1)

    const loose = await exportOnce(ctx, { path: join(ctx.cwd, 'loose.json'), includeSensitive: true })
    assert.ok(loose.text.includes(secretMark), '显式要求时必须含——否则这个参数是假的')
    assert.equal(loose.bundle.omitted.sensitive, 0)
    assert.equal(loose.bundle.counts.entries, 2)
  } finally {
    cleanup(ctx.cwd)
  }
})

// ---------- E5 只读：导出不是「使用」 ----------

test('E5 导出不刷新 accessedAt（把它记成「读过」会让用量归因与体检失真）', async () => {
  const ctx = setup()
  try {
    const remember = ctx.byName.get('remember')
    await remember.execute({ text: '# E5 甲\n正文' }, ctx.exec)
    await remember.execute({ text: '# E5 乙\n正文' }, ctx.exec)
    const before = new Map(ctx.store.list(ctx.wid, { includeArchive: true }).map((entry) => [entry.id, entry.accessedAt]))
    await exportOnce(ctx, { path: join(ctx.cwd, 'e5.json') })
    for (const entry of ctx.store.list(ctx.wid, { includeArchive: true })) {
      assert.equal(entry.accessedAt, before.get(entry.id), `${entry.id} 的 accessedAt 被导出的读路径改写了`)
    }
    const after = new Map(ctx.store.list(ctx.wid, { includeArchive: true }).map((entry) => [entry.id, entry.updatedAt]))
    assert.equal(after.size, before.size)
  } finally {
    cleanup(ctx.cwd)
  }
})

// ---------- E6 不覆盖：导出常是唯一备份 ----------

test('E6 目标已存在即拒，且**文件内容不变**（不覆盖是刻意：静默覆盖等于销毁一份备份）', async () => {
  const ctx = setup()
  try {
    await ctx.byName.get('remember').execute({ text: '# E6\n正文' }, ctx.exec)
    const target = join(ctx.cwd, 'e6.json')
    const original = '{"old": true}\n'
    await import('node:fs/promises').then(({ writeFile }) => writeFile(target, original, 'utf8'))

    await assert.rejects(
      () => ctx.byName.get('memory_export').execute({ path: target, previewChars: 0 }, ctx.exec),
      /已存在[\s\S]*overwrite/,
      '不给 overwrite 必须拒，且错误里要说清怎么办',
    )
    assert.equal(readFileSync(target, 'utf8'), original, '拒绝之后旧文件必须一个字节都没动（尸体验证）')

    const forced = await ctx.byName.get('memory_export').execute({ path: target, overwrite: true, previewChars: 0 }, ctx.exec)
    assert.equal(JSON.parse(readFileSync(forced.path, 'utf8')).format, EXPORT_FORMAT, '显式 overwrite 才覆盖')
  } finally {
    cleanup(ctx.cwd)
  }
})

// ---------- E7 回执可核：字节与指纹都要与文件对得上 ----------

test('E7 回执可核：bytes == 文件大小、sha256 == 重算、渲染不回灌内容', async () => {
  const ctx = setup()
  try {
    await ctx.byName.get('remember').execute({ text: '# E7\n正文'.repeat(50) }, ctx.exec)
    const { tool, value, text } = await exportOnce(ctx, { path: join(ctx.cwd, 'e7.json') })
    assert.equal(value.bytes, statSync(value.path).size, '回执字节数与磁盘不符 ⇒ 读者无法用它核对完整性')
    assert.equal(value.bytes, Buffer.byteLength(text, 'utf8'))
    assert.equal(value.sha256, sha256Of(text), '指纹必须指向这份文件的内容')
    assert.equal(value.format, EXPORT_FORMAT)
    assert.equal(value.formatVersion, EXPORT_FORMAT_VERSION)
    assert.match(value.exportedAt, /^\d{4}-\d{2}-\d{2}T/)

    const rendered = tool.output.render({}, value).map((block) => block.text).join('\n')
    assert.ok(rendered.length < 2000, `回执 ${rendered.length} 字符——回执不是数据面，超了会挤占上下文`)
    assert.match(rendered, /已导出/)
    assert.match(rendered, /不含侧车/)

    const withPreview = await ctx.byName.get('memory_export').execute({ path: join(ctx.cwd, 'e7b.json'), previewChars: 80 }, ctx.exec)
    assert.equal(withPreview.preview.length, 80, 'previewChars 是硬上限')
  } finally {
    cleanup(ctx.cwd)
  }
})

// ---------- E8 视野边界：看不见的导不出 ----------

test('E8 视野边界：角色准入拒绝的条目既不进导出体、也不许静默消失（要计数）', async () => {
  const roleConfig = {
    ...CONFIG,
    roles: {
      enabled: true,
      default: 'main',
      derived: 'main',
      byPreset: { 'verifier-preset': 'verifier', 'worker-preset': 'worker' },
      policyDefault: {},
      policies: { verifier: { read: ['main'] } },
    },
  }
  const ctx = setup({ config: roleConfig })
  try {
    const remember = ctx.byName.get('remember')
    const mainEntry = await remember.execute({ text: '# E8 main 的条目\n正文' }, ctx.exec)

    const verifierExec = { agent: { session: { id: 'session-export', header: { cwd: ctx.cwd, agentPreset: 'verifier-preset' } } } }
    const workerExec = { agent: { session: { id: 'session-export', header: { cwd: ctx.cwd, agentPreset: 'worker-preset' } } } }
    const verifierEntry = await remember.execute({ text: '# E8 verifier 自己的条目\n正文' }, verifierExec)
    const workerEntry = await remember.execute({ text: '# E8 worker 的条目\n正文' }, workerExec)
    assert.equal(ctx.store.get(ctx.wid, workerEntry.id).role, 'worker', '第三方角色条目必须真的写成 worker（否则这条判据测不到拒绝）')

    const tool = ctx.byName.get('memory_export')
    const value = await tool.execute({ path: join(ctx.cwd, 'e8.json'), previewChars: 0 }, verifierExec)
    const bundle = JSON.parse(readFileSync(value.path, 'utf8'))
    // `read:['main']` 的语义是「白名单 + 自己 + 共享」——所以 verifier 看得见自己的条目，
    // 被拒的只能是第三方 `worker`。把这一点测出来，才不会把「自己写的」误当「越权可读」。
    assert.equal(bundle.omitted.unreadable, 1, '角色准入拒绝的条数必须报出来（否则看起来像「库里只有两条」）')
    assert.deepEqual(
      bundle.entries.map((entry) => entry.id).sort(),
      [mainEntry.id, verifierEntry.id].sort(),
      '能读 main（read:[main]）与自己写的；读不到第三方 worker 的',
    )
    assert.ok(!bundle.entries.some((entry) => entry.id === workerEntry.id))
    assert.equal(ctx.store.get(ctx.wid, mainEntry.id).role, 'main')
  } finally {
    cleanup(ctx.cwd)
  }
})

// ---------- E9/E10 形态：不导出面随文件走 / 默认路径与原子性 ----------

test('E9 不导出面随文件走：拿到 JSON 的人不看文档也知道这里没有什么', async () => {
  const ctx = setup()
  try {
    await ctx.byName.get('remember').execute({ text: '# E9\n正文' }, ctx.exec)
    const { bundle, value } = await exportOnce(ctx, { path: join(ctx.cwd, 'e9.json') })
    assert.equal(bundle.format, EXPORT_FORMAT)
    assert.equal(bundle.formatVersion, EXPORT_FORMAT_VERSION, '没有版本号 ⇒ 未来改格式时旧文件无法被识别')
    assert.equal(bundle.notExported.length, EXPORT_NOT_EXPORTED.length)
    assert.deepEqual(value.notExported, EXPORT_NOT_EXPORTED.map((row) => row.surface))
    assert.ok(!JSON.stringify(bundle).includes('"access-trace": ['), '只点名、不带侧车内容')
  } finally {
    cleanup(ctx.cwd)
  }
})

test('E10 缺省落在 <cwd>/.dsh/memory-exports/，且成功后不留临时文件（半截文件看起来像完整导出）', async () => {
  const ctx = setup()
  try {
    await ctx.byName.get('remember').execute({ text: '# E10\n正文' }, ctx.exec)
    const value = await ctx.byName.get('memory_export').execute({ previewChars: 0 }, ctx.exec)
    assert.ok(value.path.startsWith(ctx.cwd), `缺省路径应在会话 cwd 下：${value.path}`)
    assert.match(value.path, /[\\/]\.dsh[\\/]memory-exports[\\/]aml-export-.+\.json$/)
    assert.ok(existsSync(value.path))
    const files = readdirSync(join(ctx.cwd, '.dsh', 'memory-exports'))
    assert.equal(files.length, 1, `目录里只该有导出文件：${files.join(', ')}`)
    assert.ok(!files.some((name) => name.includes('.tmp-')), '临时文件必须已 rename 或清理')
  } finally {
    cleanup(ctx.cwd)
  }
})
