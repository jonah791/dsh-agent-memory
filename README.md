<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: Agent 驱动的长期记忆：作用域分区（global + per-workspace）+ 分层条目（fact/knowledge/episodic）+ 时间桶压缩（日→周→月→年）+ 关联检索（related 链 / memory_relate 多跳 BFS）+ 主人消息 auto-recall 注入（CJK 2-gram、尾部追加）；内容决策全归 agent
  inject: 'storageDomain','tools','llm','agents'
  tools: remember,recall,update,forget,memory_browse,memory_relate,memory_stats,memory_health,memory_version,memory_check
  runtime: host-only（无 client 侧）
  envDeps: 无外部服务/无网络依赖（LLM 总结走 ctx.llm；另用 yaml + zod 两个纯 JS 依赖，node:fs 只读工作区 memory.yml）
  boundary: 读写自身存储域（agent_memory.entries）与 <workspace>/.dsh/memory.yml；不隔离、不鉴权、不加密、不做内容判断；工具描述明确「不用来记凭据（密钥/口令）」；压缩只作用于 L3 episodic，fact/knowledge 永不作为原料
  compat: cordis ^4.0.1 / dsh-tools ^0.1.0-rc.6 / dsh-agent ^0.0.1-rc.1 / dsh-llm ^0.0.1-rc.1 / dsh-session ^0.0.1-rc.1 / dsh-storage ^0.0.1-rc.1 / dsh-storage-domain ^0.0.1-rc.1 / schemastery ^3.18.1-rc.1
-->
# dsh-agent-memory

<p align="center">
  <a href="https://github.com/jonah791/dsh-agent-memory"><img src="https://img.shields.io/badge/version-0.2.4-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
  <img src="https://img.shields.io/badge/tests-125%20passed-brightgreen" alt="tests">
</p>

**一句话**：给 DSH 里的 agent 装上**跨会话的长期记忆**——把「经历过的事」结构化写入持久层，再在恰当的时机（会话启动、每条主人消息、时间桶结束、会话压缩完成）把它带回上下文，并允许 agent 检索、修订、归档、沿关系行走。

**为什么值得用**：agent 的原生记忆边界就是一次会话与一份压缩 checkpoint——上一个项目踩过的坑、主人说过的偏好、决策的理由，新会话里全部蒸发。本插件把「记忆」变成可检索、可压缩、可回滚的资产：全局偏好（`global`）永随检索，项目知识按 workspace 分区，情景经历按日→周→月→年自动升维成概要，检索到的每条记忆还附带**关联链**（连着它的邻居一起浮现）。用它的差别很具体：**下一条主人消息到手时，相关记忆已经在上下文里（auto-recall），而不是等你想起来去查**。

## 能力

10 个工具（均 `defineTool` 注册，名称与源码逐字一致）：

| 工具 | 用途 |
|------|------|
| `remember` | 写入/覆盖/合并。L1 `fact` 带 `key`（同 scope+key 精确覆盖）；L2 `knowledge` / L3 `episodic` 同标题自动合并（标签并集 + 正文追加）；未命中则新建。受 `max_entries` 守卫（**仅拦新建**） |
| `recall` | 检索：关键词/层级/标签/时间过滤，相关度（标签 3 > 标题 2 > 正文 1）+ 新鲜度排序；每个结果附 `related` 关联链；结果标注来源 scope 与压缩层级 |
| `memory_relate` | 联想导航：按 id 展开关联网络；`depth>1` 走 BFS 多跳记忆社区（`hop` 标注层级、visited 防环、每跳 `limit` 扇出） |
| `memory_browse` | 时间金字塔浏览（年/月/周/日分桶 + 层级/标签/时间过滤 + 分页）。与 `recall` 互补——「不知道有什么」时的发现路径 |
| `update` | 按 id 修订：`text` 首行作新标题、全文替换正文；`tags` 整体替换 |
| `forget` | 软归档（`archived=true` + 记 `reason`）：不再进活跃检索，`includeArchive` 可找回 |
| `memory_stats` | 各层级/压缩层级/时间桶计数 + 归档数（可 `scope` 限定） |
| `memory_health` | 运行时概览：条目总数、归档数、生效读 scopes、注入开关 |
| `memory_version` | 插件版本 + 构建时刻（**动态**读 `package.json` 与产物 mtime，用于 HMR 验证） |
| `memory_check` | 「待沉淀建议」——**当前恒返回空数组**（通道 B 未接线，工具描述已如实声明） |

行为侧（无工具面，自动发生）：

- **启动注入**：会话第 1 个 step 注入一次「记忆速览」（global fact 全量 → 概要按桶降序 → 近期明细按 `updatedAt` 降序；只给标题/时间/tags，**不给正文**）。
- **auto-recall**：每条**真实主人消息**（GUI/Web，或 telegram 插件注入）到达时注入 top-N 相关记忆（含 ≤90 字 snippet）；工具结果与其他插件注入**不触发**；同消息 id 每会话只注入一次。
- **时间压缩**：L3 情景记忆按日桶 → 日概要 → 周 → 月 → 年（只压**已结束**且有原料的自然单位，同桶同层幂等）。
- **压缩即记忆**：订阅 `compaction/*` 事件，会话压缩完成时把 checkpoint 原文**保底存档**为 episodic 并即时通知（`wakeup=true`）——提炼与否由 agent 决定。
- **记忆回流服务**：`ctx.memoryApi.remember({text,kind?,tags?,key?,scope?})` → `{id,action}` 或 `{error}`（默认 `global` + `knowledge`），供 emotion / taskboard / evolution-core / skill-forge 等插件把运行态结论写回主记忆库。

> 两侧注入都采用**尾部追加**（不动消息批次中部），以保护前缀缓存命中率。

## 快速开始

**1) 装依赖**（在目标 profile 的 `package.json` 加 link 依赖）：

```jsonc
"dsh-agent-memory": "link:<工作区>/self-plugins/dsh-agent-memory"
```

**2) 挂组合**（profile 的 `cordis.patch.yml`）：

```yaml
- insert:
    - id: agent-memory
      name: dsh-agent-memory
      config:
        maxTokens: 16000          # 总结路由的 token 上限
        compressIntervalMinutes: 360
```

> 依赖官方 storage 栈（`storage` / `storage-json` / `storage-domain`）——web-app bundle 已提供，无需额外行。

**3) 30 秒验证**：调 `memory_version` → 期望返回 `name: dsh-agent-memory`、`version: 0.2.4` 与**晚于源码修改时刻**的 `buildAt`；再调 `memory_health` → 期望 `total > 0`（已有历史条目）；再调 `memory_stats` → 各 `kind` 计数与 `${DSH_HOME}/storages/agent_memory.json` 中的实际条目数一致。

## 配置

**A. 插件行配置**（`cordis.patch.yml` 的 `config:` 段，schema 见 `src/index.ts`）：

| 项 | 默认 | 说明 |
|----|------|------|
| `provider` | `''` | 总结用 provider；空 = 跟随会话当前路由 |
| `model` | `''` | 总结用 model；空 = 跟随会话当前路由 |
| `maxTokens` | 未设（`summarizer.ts` 的 `DEFAULT_MAX_TOKENS = 16000`） | 总结输出上限；宿主实配 `16000` |
| `compressIntervalMinutes` | `360` | 周期补压间隔（分钟）；`0` = 禁用 |
| `compressInitialDelaySeconds` | `30` | 启动延迟首跑（秒）——用于回填历史缺口 |

**B. 工作区配置**（`<workspace>/.dsh/memory.yml`，缺省即下表；`DEFAULT_CONFIG` 深冻结）：

| 键 | 默认 | 说明 |
|----|------|------|
| `scope` | `workspace` | 读写路由：`workspace` / `global-first` / `global` |
| `layers` | `[fact, knowledge, episodic]` | 启用哪些层级（空数组 = 全关；写入未启用层级 fail loud） |
| `auto_sink` | `true` | 压缩存档开关字段（实际由 compaction 事件驱动） |
| `timeline.day/week/month/year` | 全 `true` | 各层级时间压缩开关 |
| `timeline.archive` | `keep` | 当前契约**只允许** `keep`（其它值 fail loud） |
| `weekly_template` | `''` | 周概要模板（空 = 内置提示词） |
| `max_entries` | `2000` | 条目上限（**仅拦截新建**，覆盖/合并不受限） |
| `inject.enabled / max_bytes / max_entries` | `true / 3000 / 20` | 启动注入预算 |
| `auto_inject.enabled / max_bytes / max_entries` | `true / 1500 / 3` | auto-recall 预算 |

> **fail-loud**：`memory.yml` 未知顶层键、非法枚举、非布尔、非正整数、`archive≠keep` 等一律抛 `MemoryConfigError`（不静默补默认）；**只有「文件不存在」走全默认**。当前 `<工作区>/.dsh/memory.yml` 不存在 ⇒ 全部走默认。

**作用域裁决**（`resolveScopes`，纯函数）：显式参数 > 配置模式 > 无 cwd 降级；读默认恒附加 `global`。

## 落盘与自证（出问题时先看这里）

**本插件无侧车轨迹**——`src/` 里没有任何 `*.jsonl` / trace 写入（`grep -rn "trace\|jsonl" src/*.ts` 只命中注释）。因此「某次注入/压缩到底有没有发生」**不能**靠轨迹事后证明，这是已知的可维护性缺口（按生态纪律应补 `<DSH_HOME>/agent-memory-trace.jsonl`：`atMs/phase/inject|compress/scope/bucket/count/build`）。

**主持久产物**：`${DSH_HOME}/storages/agent_memory.json`（由官方 storage-domain 落盘，非本插件自写文件）。它是**状态快照**（非阶段轨迹），结构固定：

| 路径 | 含义 |
|------|------|
| `unit.name` / `unit.version` | 存储单元标识：`agent_memory` / `1`（域名须匹配 `/^[a-z][a-z0-9_]*$/`） |
| `global` | 域级共享区（本插件为 `null`） |
| `tables.entries` | 条目表：键 = `<scope>:<kind>:<id>`，值 = 条目对象 |
| 条目的 `id/kind/title/body/tags/scope/createdAt/updatedAt/accessedAt` | 条目本体（`scope` 是分区真源，也是键前缀） |
| 条目的 `level` / `bucket` | 仅 `summary` 与已压缩原料使用：`level ∈ day/week/month/year`，`bucket` 形如 `2026-09-12` / `2026-W36` / `2026-09` / `2026` |
| 条目的 `archived` / `key` / `source` / `archiveRef` | `archived` = 软归档（forget 产物）；`key` = L1 覆盖键；`source` = 来源与理由；`archiveRef` = 概要指向的原料 id 列表 |

**一条命令答五问**：

```bash
# ① 构建 ② 谁发起 ③ 断在哪段 ④ 结果质量 ⑤ 耗时预算
node -e '
const j=require(process.env.DSH_HOME+"/storages/agent_memory.json");
const e=Object.values(j.tables.entries);
const by=(f)=>e.reduce((a,x)=>(a[x[f]??"-"]=(a[x[f]??"-"]||0)+1,a),{});
console.log("①unit",j.unit.name+"@"+j.unit.version,"| 条数",e.length);
console.log("②scope→条数",by("scope"));            // 谁在写：scope 即写入方（global 或某 workspaceId）
console.log("③断在哪段: 本文件无阶段枚举/无侧车轨迹——条数随时长不前进 ⇒ 写路径或调用方断了");
console.log("④kind",by("kind"),"| archived",e.filter(x=>x.archived).length);
console.log("⑤更新时刻",new Date(require("node:fs").statSync(process.env.DSH_HOME+"/storages/agent_memory.json").mtimeMs).toISOString(),"（周期补压一轮 = 360min）");
'
```

行为级验证（不依赖落盘读取，三选一）：调 `memory_health` 证明存储域已打开；调 `memory_stats` 看计数是否与上面命令一致；调 `recall "关键词"` 看能否命中刚写的条目。

> ⚠️ 上述命令**直接读生产记忆库**——只读、不改；任何去重/删除属「动数据」类决策（须请示主人）。

## 生效判据与回退

**生效判据**（三选一，按可靠性排序）：

1. **语义级（最直接）**：调 `memory_version` → `version` 应等于 `package.json` 的 `0.2.4`，`buildAt` 应等于 `lib/index.js` 的产物 mtime（该工具是**动态**读这两处的——2026-09-01 之前它硬编码版本、`buildAt` 实为调用时刻，即「判据本身说谎」，已修）。
2. **进程级**：`lib/index.js` 的 mtime ≤ web 进程启动时间，且 `src/*.ts` 不新于 `lib/index.js`（源码改了没构建 = 跑的还是旧产物）。
3. **行为级**：工具面出现 10 个 `memory_*`；把一条记忆写进库后，`${DSH_HOME}/storages/agent_memory.json` 的 `tables.entries` 条数 +1 且文件 mtime 前进。

> **「重新构建 ≠ 生效」**：产物 mtime 新只证明「构建过」，**不证明进程在跑它**（AGENTS.md §5.11 §6 实测教训）。判据必须是「进程启动时间晚于产物 mtime」。另：HMR 默认可能未启用（web-app 自带行常为 `disabled`），改完源码务必 `npm run build`，必要时让宿主重载/重启后再复验同一判据。

**回退三档**：

- **源码级**：`git revert <commit>`（或 `git checkout <上一提交> -- src/`）→ `npm run build` → 预检 → 重启。适用于构建后行为异常。
- **组合级**：profile patch 给 `agent-memory` 行加 `disabled: true`（或 `plugin_stop dsh-agent-memory`）→ 停用后 10 个工具消失、两条注入与周期补压停止；**数据仍在**（存储文件不受影响，重新启用即恢复）。
- **运行期**：无需回滚代码即可降级——`<workspace>/.dsh/memory.yml` 里把 `inject.enabled` / `auto_inject.enabled` 置 `false`（停注入）、`compressIntervalMinutes: 0`（停周期补压）、`timeline.{day,week,month,year}: false`（停时间压缩）。回退后用同一套判据复验（工具消失 / 注入帧不再出现 / 文件 mtime 不再前进）。

## 测试

```bash
npm test          # = tsc -p tsconfig.json && node --test "tests/*.test.mjs"
npm run test:ts   # = tsc && node --test "tests/*.test.ts"   （需 node ≥ 24）
npm run test:all  # = 两套一起
```

**实测（本次运行，node v22.22.1，`npm test`）：`# tests 125 / # suites 20 / # pass 125 / # fail 0 / # skipped 0`**（约 7.6s，徽章数字即此）。**无需网络、无需真实外部依赖**——LLM 总结路径在测试里以桩注入，telegram 不涉及。

覆盖范围（`tests/` 共 12 个文件；`npm test` 跑其中 7 个 `.mjs`）：

- `store.test.mjs` — 条目 CRUD、写去重三态（`created`/`updated`/`merged`）、L1 key 覆盖、标题指纹合并
- `search.test.mjs` — 打分与排序、过滤、截断；**联想层**（related 链强度降序）与 **BFS 多跳闭包**（hop 标注/防环/每跳 limit）
- `timeline.test.mjs` — 本地时区桶算法、上级桶范围与归属、`findPendingCompressions`（只压已结束 + 有原料）、**并发幂等**（两实例并发只写一份概要 + 原料只归档一次）
- `lock.test.mjs` — 按键串行锁：同键排队、异键并行、前序异常不毒化链、settle 后键不泄漏（含 50 并发样本）
- `inject.test.mjs` — 启动注入：global fact 全量、概要先于明细、预算截断、归档条目不出场、空记忆不注入
- `auto-inject.test.mjs` — auto-recall **触发面**（GUI/Telegram 触发、其他插件注入**不触发**、空文本跳过、多 text block 拼接）+ 预算截断与长 query 截断
- `summarizer.test.mjs` — 总结提示词与响应处理

未在本次运行内（`.ts` 套件，5 个文件：`browse` / `compaction-sink` / `config` / `scope` / `tools`）：`npm run test:ts` 在 **node v22 上不可跑**（原生类型剥离需 node ≥ 24）——本次实测 `# pass 0 / # fail 5`（全部为加载失败）。**该套件在此环境的用例实数：未取到**（`docs/semantic.md` §10 U2 记为 76 项、`node ≥ 24` 下手工全绿，本次未复现）。

**未覆盖**：`ctx` 级集成（真实 `agent/pre-step` 事件流、inbox 通知投递）、周期补压定时器（`src/periodic.ts` **无单测**，见 `docs/semantic.md` §7 A17「待线上验收」）。

## 设计要点

- **机制不做内容决策**：框架层只保证「不丢、知道、兜底」——记什么、怎么组织、何时 recall、何时遗忘、压缩后是否提炼，全归 agent（设计总纲）。
- **单一写入真源**：10 个工具 / `memoryApi` / 压缩存档 / 时间压缩四条写路径最终都经 `MemoryStore` → 同一张 `agent_memory.entries` 表（键 `<scope>:<kind>:<id>`）。
- **尾部追加而非插入**：两条注入都追加在消息批次末尾——插在中部会打断前缀缓存，代价是每轮全量重算。
- **幂等复核必须紧贴写入之前**：`compressUnit` 用 `withKeyLock(compressUnitKey(scope,level,bucket))` 把「查概要 → await LLM → 写入」串行化，并在 `remember` **之前**二次复核。首版把复核放在 `remember` 之后 → 命中自己刚写的概要 → 提前 return → **原料永不归档**（7 项测试红拦下）。**位置本身就是语义**。
- **锁的边界（诚实声明）**：`src/lock.ts` 只覆盖**单进程**。多实例共享同一 `DSH_HOME` 时，跨进程窗口靠写前复核从「一次 LLM 往返」压到两次读写之间——非零，但不声称零（无 CAS 支持）。
- **压缩只吃 L3**：`fact`/`knowledge` 永不作为压缩原料，`global` scope 不压缩，只压**已结束**的自然单位，同桶同层已有概要则跳过。
- **配置 fail-loud**：未知键 / 非法值抛 `MemoryConfigError`，只有文件不存在才走默认——拼错键不会静默退化成默认行为。
- **触发双路**：时间压缩同时有懒压缩（访问记忆时 fire-and-forget）与周期补压（启动 30s 首跑 + 每 360 分钟轮询）。2026-08-21 教训：只有单路 + 静默失败 = 停摆无人知（当时日概要零产出）。
- **反定位**：不是会话历史的替代（原始逐字记录归 session log 与 compaction checkpoint）；不做向量检索/全文索引站；不隔离、不鉴权、不加密；不做跨设备同步；**不用于存凭据**。

## 相关文档

| 文档 | 内容 |
|------|------|
| [`docs/semantic.md`](docs/semantic.md) | **权威契约**：定位与反定位、术语表、概念模型与 8 条不变量、契约（持久化/配置/作用域裁决/工具面/注入/时间压缩/调用点清单）、边界与信任、可证伪验收 18 条、模块职责、实践修订记录、未决问题 6 条 |
| [DESIGN.md](DESIGN.md) | 设计意图（输入通道、检索管道、防失控机制） |
| [IMPLEMENTATION.md](IMPLEMENTATION.md) | 工程契约（接口、验收、取证记录） |
| [alice-digital-life](https://github.com/jonah791/alice-digital-life) | 本插件所属生态的中心索引（全部自研插件） |
| [dsh-agent-compact](https://github.com/jonah791/dsh-agent-compact) | Agent 驱动会话压缩——「压缩即记忆」通道 C 的咬合方 |
| 技能 `plugin-maintainability` / `dsh-plugin-development` | 机制自证与可维护性工程、DSH 插件开发方法论 |

> 语义冲突时**以 `docs/semantic.md` 为准**（它是主副本）；实现与文档冲突时以源码为准并回修文档。

## License

MIT © jonah791

---

本插件属于我的数字生命爱丽丝（[alice-digital-life](https://github.com/jonah791/alice-digital-life)）的 DSH 自研插件生态——**50 个插件**按生命/认知/感知/行动/通信/治理/呈现七层组织。
