/**
 * 版本一致性（2026-11-24 · lh-6009c216）
 *
 * 守的是这条规则（正本写在 README 头注与 docs/semantic.md 的「版本」格）：
 *   ① **包语义版本** = `package.json` 的 `version`，唯一真源；`dsh-plugin.json` 的 `version`
 *      与 README 的 version 徽章**都必须等于它**。
 *   ② **能力编号**（`docs/semantic.md` 的 `v0.NN`）是**另一条轴**，与包版本刻意不相等
 *      （v0.32–v0.36 五个能力未单独发版）——本文件**刻意不判它**，判它就会逼人把两条轴对齐。
 *
 * 为什么要有它：这两处此前分别停在 0.24.0 与 0.17.0（真源已是 0.32.0），而没有任何东西会提醒。
 * 这正是「状态型落点」——状态一变，描述旧状态的句子就变假，而它们不含任何会被 grep 到的代码名。
 * 早在 `lh-6009c216` 之前，同族已经踩过三次（见技能 acceptance-integrity 判据 16）。
 *
 * ⚠ 刻意**不**校验 README 的 tests 徽章：测试数由本文件所在的这组测试自己决定，写死数字第二天
 * 就过期，而校验它会形成自指。该徽章已改为不带数字（`tests-passing`）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')
const VERSION_RE = /^\d+\.\d+\.\d+$/

test('版本一致性：dsh-plugin.json 与 README 徽章都等于 package.json 的 version', () => {
  const pkgVersion = JSON.parse(read('package.json')).version
  assert.match(pkgVersion, VERSION_RE, 'package.json 的 version 必须是 x.y.z')

  const manifest = JSON.parse(read('dsh-plugin.json'))
  assert.match(manifest.manifestVersion, VERSION_RE, 'manifestVersion 是清单格式版本，独立于插件版本但须是版本形态')
  assert.equal(manifest.version, pkgVersion, 'dsh-plugin.json 的 version 必须跟 package.json——两者同属「包版本」这条轴')

  const readme = read('README.md')
  const badge = /badge\/version-([0-9]+\.[0-9]+\.[0-9]+)-/.exec(readme)
  assert.ok(badge !== null, 'README 必须保留 version 徽章——删掉它会让本判据静默失效（判据失效必须响亮）')
  assert.equal(badge[1], pkgVersion, 'README 的 version 徽章必须跟 package.json')
})

test('两条轴的规则写在明处：README 写明「能力编号与包版本刻意不相等」，且不试图对齐', () => {
  const readme = read('README.md')
  assert.match(readme, /能力编号/, 'README 必须把「两条轴」写在明处——否则下一个人会把它当疏漏去「修」')
  assert.match(readme, /刻意不相等/, '规则里要点明「刻意不相等」：看着像疏漏的东西必须被显式标成决定')
})
