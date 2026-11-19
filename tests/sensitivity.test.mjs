/**
 * 敏感分级与隐私检查（v0.47 · 方案 §11.2 + §7 第 04 步）· 判据——设计正本 `docs/design/aml-sensitivity.md`
 *
 * 这一层守四件事：
 * ① **硬闸能拦**（五类极窄凭据形态，且**不误伤**技术笔记——反例取自活库真实样本）；
 * ② **两层正交**（标了等级不能绕过形态检查，形态干净也不等于等级为 L0）；
 * ③ **标了有后果**（`L2`/`L3` 不进自动注入与默认检索面，需 `includeSensitive`）；
 * ④ **未标注不猜**（按既有行为，不是 `L0` 也不是 `L2`）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  SENSITIVITY_LEVELS,
  countBySensitivity,
  deriveSensitivity,
  detectCredential,
  filterBySensitivity,
  isAutoInjectable,
  isDefaultVisible,
  parseSensitivity,
  requiresExplicitConsent,
  stricterSensitivity,
} from '../lib/sensitivity.js'
import { DEFAULT_CONFIG } from '../lib/config.js'
import { MemoryStore } from '../lib/store.js'
import { createMemoryTools } from '../lib/tools.js'
import { workspaceIdOf } from '../lib/scope.js'

const CWD = 'C:\\Users\\Alice\\proj'
const WID = workspaceIdOf(CWD)
const SESSION = 'session-11111111-2222-3333-4444-555555555555'

// 夹具里的凭据全是**字形样本**（重复字符），不含任何真实密钥。
const PRIVATE_KEY = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0000000000000000\n-----END RSA PRIVATE KEY-----'
const GH_TOKEN = `ghp_${'a'.repeat(36)}`
const AWS_KEY = `AKIA${'ABCDEFGHIJKLMNOP'}`
const ANTHROPIC_KEY = `sk-ant-api03-${'x'.repeat(95)}`
const SLACK_TOKEN = `xoxb-${'1'.repeat(24)}`

// ---------- S 段：纯函数判据 ----------

test('S1 四值大小写归一后接受；非法值返回 undefined（不猜）', () => {
  assert.deepEqual([...SENSITIVITY_LEVELS], ['L0', 'L1', 'L2', 'L3'])
  for (const level of SENSITIVITY_LEVELS) {
    assert.equal(parseSensitivity(level), level)
    assert.equal(parseSensitivity(level.toLowerCase()), level, '小写必须归一')
    assert.equal(parseSensitivity(` ${level} `), level, '空白必须归一')
  }
  assert.equal(parseSensitivity('L4'), undefined, '第五档不存在——不猜成 L3')
  assert.equal(parseSensitivity('sensitive'), undefined)
  assert.equal(parseSensitivity(undefined), undefined)
  assert.equal(parseSensitivity(2), undefined)
})

test('S2 ★两层正交：标 L0 不能绕过硬闸，形态干净也不改等级', () => {
  // 显式 L0 + 私钥块：读数按显式（L0），但硬闸照样命中 ⇒ 写入仍会被拒
  const readout = deriveSensitivity({ title: '标为公开的样例', body: PRIVATE_KEY, sensitivity: 'L0' })
  assert.equal(readout.level, 'L0', '显式优先——派生不覆盖我判断过的等级')
  assert.equal(readout.source, 'explicit')
  assert.equal(detectCredential(PRIVATE_KEY).length, 1, '等级不能关掉形态检查')

  // 形态干净 + 显式 L3：硬闸 0 命中，但等级仍是 L3
  assert.equal(detectCredential('一条普通的技术笔记正文').length, 0)
  assert.equal(deriveSensitivity({ title: '普通笔记', body: '正文', sensitivity: 'L3' }).level, 'L3')
})

test('S3 私钥块 ⇒ 派生 L3（只往严的方向推）', () => {
  const readout = deriveSensitivity({ title: '格式说明', body: PRIVATE_KEY })
  assert.equal(readout.level, 'L3')
  assert.equal(readout.source, 'derived')
  assert.equal(readout.basis, 'private-key-block')
})

test('S4 ★五类形态各自命中，且**不返回命中内容**', () => {
  const cases = [
    ['private-key-block', PRIVATE_KEY],
    ['github-token', GH_TOKEN],
    ['aws-access-key', AWS_KEY],
    ['anthropic-key', ANTHROPIC_KEY],
    ['slack-token', SLACK_TOKEN],
  ]
  for (const [kind, text] of cases) {
    const hits = detectCredential(text)
    assert.equal(hits.length, 1, `${kind} 必须命中`)
    assert.equal(hits[0].kind, kind)
    assert.ok(hits[0].length > 0, '长度是回执里唯一该有的信息')
    assert.deepEqual(Object.keys(hits[0]).sort(), ['kind', 'length'], '不得携带命中内容（否则检查本身会复制凭据）')
  }
})

test('S5 ★活库真实反例零误拦（宽形态假阳 100%，这些都必须过）', () => {
  const harmless = [
    '凭据不进配置、记忆库、仓库、聊天',                       // 纪律本身的表述
    'token 预算无上限——不许以省 token 为由缩减',               // 主人定调
    '诊断门：Cloudflare 面板对我的会话弹人机挑战',              // 工程语境的「诊断」
    '提交 2e7ce8a1b3c4d5e6f708192a3b4c5d6e7f809a1b',           // git 提交号
    'SHA256:nOMFCAYnEjkIDAMraQTGxJSBnBT+6QHONmCpLmk',          // SSH 主机指纹（公开标识）
    'bootstrap 邮箱 = abc@mail.tm',                            // 幽灵身份一次性邮箱
    'sk-alice-local-2048',                                     // 本地网关自设短 key（19 字符）
    'X-API-Key: 头名', 'curl --local 强制回退',                 // 协议名 / 参数名
  ]
  for (const text of harmless) {
    assert.deepEqual(detectCredential(text), [], `不得误拦：${text}`)
  }
})

test('S6 ★调用规则：L2/L3 不进自动注入；L0/L1/未标注进', () => {
  assert.equal(isAutoInjectable({ level: 'L0', source: 'explicit' }), true)
  assert.equal(isAutoInjectable({ level: 'L1', source: 'explicit' }), true)
  assert.equal(isAutoInjectable({ level: 'L2', source: 'explicit' }), false)
  assert.equal(isAutoInjectable({ level: 'L3', source: 'explicit' }), false)
  assert.equal(isAutoInjectable({ level: undefined, source: 'unlabeled' }), true, '未标注按既有行为——不猜成 L2')
  assert.equal(isDefaultVisible({ level: 'L2', source: 'explicit' }), false, '默认检索面与注入同口径')
})

test('S7 stricterSensitivity：只往严的方向推', () => {
  assert.equal(stricterSensitivity('L0', 'L3'), 'L3')
  assert.equal(stricterSensitivity('L3', 'L0'), 'L3')
  assert.equal(stricterSensitivity('L1', undefined), 'L1')
  assert.equal(stricterSensitivity(undefined, 'L2'), 'L2')
  assert.equal(stricterSensitivity(undefined, undefined), undefined)
  assert.equal(stricterSensitivity('L2', 'L2'), 'L2')
})

test('S8 requiresExplicitConsent：只有 L3 需要显式确认', () => {
  for (const level of ['L0', 'L1', 'L2']) {
    assert.equal(requiresExplicitConsent({ level, source: 'explicit' }), false)
  }
  assert.equal(requiresExplicitConsent({ level: 'L3', source: 'explicit' }), true)
  assert.equal(requiresExplicitConsent({ level: undefined, source: 'unlabeled' }), false, '未标注不等于 L3')
})

test('S9 ★四档 + 未标注之和恒等于分母', () => {
  const entries = [
    { title: 'a', body: '公开笔记', sensitivity: 'L0' },
    { title: 'b', body: '工作记录', sensitivity: 'L1' },
    { title: 'c', body: '私人偏好', sensitivity: 'L2' },
    { title: 'd', body: '格式说明', sensitivity: 'L3' },
    { title: 'e', body: PRIVATE_KEY }, // 派生 L3
    { title: 'f', body: '未标注的一条' },
    { title: 'g', body: '未标注的另一条' },
  ]
  const dist = countBySensitivity(entries)
  assert.equal(dist.total, 7)
  assert.equal(dist.byLevel.L0, 1)
  assert.equal(dist.byLevel.L1, 1)
  assert.equal(dist.byLevel.L2, 1)
  assert.equal(dist.byLevel.L3, 2, '派生 L3 与显式 L3 同档')
  assert.equal(dist.unlabeled, 2)
  const sum = dist.byLevel.L0 + dist.byLevel.L1 + dist.byLevel.L2 + dist.byLevel.L3 + dist.unlabeled
  assert.equal(sum, dist.total, '四档 + 未标注必须恰好等于分母')
})

test('S10 filterBySensitivity：默认滤掉 L2/L3，未标注照旧通过', () => {
  const entries = [
    { id: 'l0', title: 'a', sensitivity: 'L0' },
    { id: 'l2', title: 'b', sensitivity: 'L2' },
    { id: 'l3', title: 'c', sensitivity: 'L3' },
    { id: 'none', title: 'd' },
  ]
  assert.deepEqual(filterBySensitivity(entries, false).map((e) => e.id), ['l0', 'none'])
  assert.deepEqual(filterBySensitivity(entries, true).map((e) => e.id), ['l0', 'l2', 'l3', 'none'])
})

// ---------- E 段：工具层 ----------

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
  get size() {
    return this.map.size
  }
}

function setup(deps = {}) {
  const kv = new MemoryKv()
  const store = new MemoryStore(kv)
  const tools = createMemoryTools({ store, loadConfig: async () => DEFAULT_CONFIG, ...deps })
  const byName = new Map(tools.map((t) => [t.name, t]))
  const exec = {
    agent: { session: { id: SESSION, header: { id: SESSION, cwd: CWD } } },
    signal: new AbortController().signal,
  }
  return { kv, store, byName, exec }
}

test('E1 ★默认检索面不含 L2/L3；includeSensitive 才取得到', async () => {
  const { byName, exec } = setup()
  const tools = byName
  const recall = tools.get('recall')

  await tools.get('remember').execute({ text: '公开的构建笔记：先跑 tsc 再跑测试', sensitivity: 'L0' }, exec)
  await tools.get('remember').execute(
    { text: '私人偏好：主人的作息与情绪线索', sensitivity: 'L2' },
    exec,
  )
  await tools.get('remember').execute(
    { text: '高风险样例：一段脱敏的密钥格式说明', sensitivity: 'L3', allowSensitive: true },
    exec,
  )
  await tools.get('remember').execute({ text: '未标注的一条普通技术笔记' }, exec)

  const plain = await recall.execute({}, exec)
  const plainTitles = plain.results.map((item) => item.title)
  assert.equal(plainTitles.length, 2, '默认只返回 L0 与未标注')
  assert.ok(!plainTitles.some((t) => t.includes('私人偏好')), 'L2 不得出现在默认面')
  assert.ok(!plainTitles.some((t) => t.includes('高风险样例')), 'L3 不得出现在默认面')

  const withSensitive = await recall.execute({ includeSensitive: true }, exec)
  assert.equal(withSensitive.results.length, 4, 'includeSensitive 是唯一入口')

  // 投影层必须透出灵敏度（否则渲染层无法解释「为什么这条没出现」）
  const l2 = withSensitive.results.find((item) => item.title.includes('私人偏好'))
  assert.equal(l2.sensitivity, 'L2')
})

test('E2 ★L3 写入默认被拒；allowSensitive 放行并给出提示', async () => {
  const { byName, exec } = setup()
  const remember = byName.get('remember')

  await assert.rejects(
    () => remember.execute({ text: '高风险的一条', sensitivity: 'L3' }, exec),
    /L3/,
    'L3 默认禁止入库（方案 §11.2）',
  )

  const created = await remember.execute(
    { text: '高风险的一条（已显式确认）', sensitivity: 'L3', allowSensitive: true },
    exec,
  )
  assert.equal(created.action, 'created')
})

test('E3 ★凭据形态硬闸：默认拒写，且报错里不含凭据本体', async () => {
  const { byName, exec } = setup()
  const remember = byName.get('remember')

  let message = ''
  try {
    await remember.execute({ text: `格式说明\n\n${PRIVATE_KEY}` }, exec)
    assert.fail('命中私钥块必须拒写')
  } catch (error) {
    message = String(error?.message ?? error)
  }
  assert.match(message, /凭据形态/)
  assert.match(message, /private-key-block/)
  assert.ok(!message.includes('MIIEowIBAAKCAQEA'), '报错不得回显凭据本体')
  assert.match(message, /凭据保管库/, '必须给替代路径（否则只是拒绝）')

  const allowed = await remember.execute(
    { text: `格式说明\n\n${PRIVATE_KEY}`, allowSensitive: true },
    exec,
  )
  assert.equal(allowed.action, 'created')
  assert.ok(
    allowed.sensitivityNotice.some((note) => note.includes('allowSensitive')),
    '放行必须留可见提示（条目已落库，只有这一次机会）',
  )
})

test('E4 ★L2 写入被接受并提示「不进默认路径」', async () => {
  const { byName, exec } = setup()
  const created = await byName.get('remember').execute(
    { text: '私人信息：某人的健康状况', sensitivity: 'L2' },
    exec,
  )
  assert.equal(created.action, 'created', 'L2 不是拒绝，是「不进默认路径」')
  assert.ok(created.sensitivityNotice.some((note) => note.includes('includeSensitive')))
})

test('E5 ★memory_stats 的 bySensitivity 四档 + 未标注 == total，且渲染可见', async () => {
  const { byName, exec } = setup()
  await byName.get('remember').execute({ text: '公开笔记', sensitivity: 'L0' }, exec)
  await byName.get('remember').execute({ text: '未标注笔记' }, exec)

  const stats = await byName.get('memory_stats').execute({}, exec)
  const dist = stats.bySensitivity
  const sum = dist.byLevel.L0 + dist.byLevel.L1 + dist.byLevel.L2 + dist.byLevel.L3 + dist.unlabeled
  assert.equal(sum, dist.total, '四档 + 未标注恒等于分母')
  assert.equal(dist.total, 2)
  assert.equal(dist.unlabeled, 1, '未标注不是 L0')

  const text = byName.get('memory_stats').output.render({}, stats).map((c) => c.text).join('\n')
  assert.match(text, /敏感分级：/)
  assert.match(text, /未标注/)
})

test('E6 ★无回退：不给 sensitivity 时检索行为与既有版本逐位相同', async () => {
  const { byName, exec } = setup()
  await byName.get('remember').execute({ text: '第一条无标注笔记，带判据标签', tags: ['判据'] }, exec)
  await byName.get('remember').execute({ text: '第二条无标注笔记，带另一标签', tags: ['另一'] }, exec)

  const plain = await byName.get('recall').execute({}, exec)
  const explicit = await byName.get('recall').execute({ includeSensitive: false }, exec)
  assert.equal(plain.results.length, 2, '未标注条目照旧可见')
  assert.deepEqual(
    plain.results.map((item) => item.id),
    explicit.results.map((item) => item.id),
    '缺省与显式 false 必须同形',
  )
  assert.equal(plain.results[0].sensitivity, undefined, '未标注不透出 sensitivity 键（不猜成 L0）')
})

test('E7 ★结果项的新字段必须已在两个 output schema 声明（线上实测踩过：宿主整条拒收）', async () => {
  const { byName, exec } = setup()
  await byName.get('remember').execute({ text: 'L2 的结果项字段测试条目', sensitivity: 'L2' }, exec)

  // recall：投影层透出 + schema 声明，缺任一处 ⇒ 宿主报 "is not a declared property"
  const recall = byName.get('recall')
  const recallValue = await recall.execute({ includeSensitive: true }, exec)
  assert.equal(recallValue.results.length, 1)
  const recallItem = recallValue.results[0]
  assert.equal(recallItem.sensitivity, 'L2', '投影层必须透出派生读数')
  const recallProps = new Set(Object.keys(recall.output.schema.properties.results.items.properties))
  for (const key of Object.keys(recallItem)) {
    assert.ok(recallProps.has(key), `recall 结果键 ${key} 未在 output.schema 声明 ⇒ 宿主会整条拒收`)
  }

  // memory_browse：同一条纪律（两个 schema 共用 DIMENSION_ITEM_FIELDS，一处漏即两处漏）
  const browse = byName.get('memory_browse')
  const browseValue = await browse.execute({ includeSensitive: true }, exec)
  const browseItems = browseValue.groups.flatMap((group) => group.items)
  assert.ok(browseItems.length > 0, 'browse 必须能返回该条目')
  const browseProps = new Set(Object.keys(browse.output.schema.properties.groups.items.properties.items.items.properties))
  for (const key of Object.keys(browseItems[0])) {
    assert.ok(browseProps.has(key), `browse 结果键 ${key} 未在 output.schema 声明 ⇒ 宿主会整条拒收`)
  }
})
