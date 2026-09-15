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
  <a href="https://github.com/jonah791/dsh-agent-memory"><img src="https://img.shields.io/badge/version-0.8.0-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
  <img src="https://img.shields.io/badge/tests-125%20passed-brightgreen" alt="tests">
</p>

**一句话**：给 DSH 里的 agent 装上**跨会话的长期记忆**——把「经历过的事」结构化写入持久层，再在恰当的时机（会话启动、每条主人消息、时间桶结束、会话压缩完成）把它带回上下文，并允许 agent 检索、修订、归档、沿关系行走。

**为什么值得用**：agent 的原生记忆边界就是一次会话与一份压缩 checkpoint——上一个项目踩过的坑、主人说过的偏好、决策的理由，新会话里全部蒸发。本插件把「记忆」变成可检索、可压缩、可回滚的资产：全局偏好（`global`）永随检索，项目知识按 workspace 分区，情景经历按日→周→月→年自动升维成概要，检索到的每条记忆还附带**关联链**（连着它的邻居一起浮现）。用它的差别很具体：**下一条主人消息到手时，相关记忆已经在上下文里（auto-recall），而不是等你想起来去查**。

## 能力

11 个工具（均 `defineTool` 注册，名称与源码逐字一致）：

| 工具 | 用途 |
|------|------|
| `remember` | 写入/覆盖/合并。L1 `fact` 带 `key`（同 scope+key 精确覆盖）；L2 `knowledge` / L3 `episodic` 同标题自动合并（标签并集 + 正文追加）；未命中则新建。受 `max_entries` 守卫（**仅拦新建**） |
| `recall` | 检索：关键词/层级/标签/时间过滤，相关度（标签 3 > 标题 2 > 正文 1）+ 新鲜度排序；每个结果附 `related` 关联链；结果标注来源 scope 与压缩层级。**v0.5：受角色视野约束**（见「角色视野」），可用 `role` 参数切换视角 |
| `memory_relate` | 联想导航：按 id 展开关联网络；`depth>1` 走 BFS 多跳记忆社区（`hop` 标注层级、visited 防环、每跳 `limit` 扇出） |
| `memory_browse` | 时间金字塔浏览（年/月/周/日分桶 + 层级/标签/时间过滤 + 分页）。与 `recall` 互补——「不知道有什么」时的发现路径 |
| `update` | 按 id 修订：`text` 首行作新标题、全文替换正文；`tags` 整体替换 |
| `forget` | 软归档（`archived=true` + 记 `reason`）：不再进活跃检索，`includeArchive` 可找回 |
| `memory_stats` | 各层级/压缩层级/时间桶计数 + 归档数（可 `scope` 限定） |
| `memory_health` | 运行时概览：条目总数、归档数、生效读 scopes、注入开关、**生效角色（`role` / `rolesEnabled` / `roleReason`）** |
| `memory_audit` | **价值体检（v0.6 · 只读提案器）**：四档提案 `KEEP` / `DEMOTE` / `ARCHIVE` / `REVIEW` + 证据行 + 按层级聚合的体量视图。判据序：承重（被概要 `archiveRef` 引用）＞ 新（≤ `keep_recent_days`）＞ 未引用且老且无溯源（归档候选）＞ 未引用且体量大（可降级）＞ 小体量兜底。**不归档、不删除、不刷新 `accessedAt`**；分数是序数（权重为启发式先验，非拟合值） |
| `memory_version` | 插件版本 + 构建时刻（**动态**读 `package.json` 与产物 mtime，用于 HMR 验证） |
| `memory_check` | 「待沉淀建议」——**当前恒返回空数组**（通道 B 未接线，工具描述已如实声明） |

行为侧（无工具面，自动发生）：

- **启动注入**：会话第 1 个 step 注入一次「记忆速览」（global fact 全量 → 概要按桶降序 → 近期明细按 `updatedAt` 降序；只给标题/时间/tags，**不给正文**）。
- **auto-recall**：每条**真实主人消息**（GUI/Web，或 telegram 插件注入）到达时注入 top-N 相关记忆（含 ≤90 字 snippet）；工具结果与其他插件注入**不触发**；同消息 id 每会话只注入一次。
  **v0.7 重心化**：查询词不再是「最后一条消息的字面」，而是**上下文重心**——最近 4 轮对话文本的加权词项（越新权重越高 `decay=0.7`，最新一条再 ×2.0 作锚点）。动机是实测反例：重启唤醒消息曾注入三条与当轮意图无关的记忆。无历史时退化为原行为（零回归，A47 断言逐字节一致）。
- **时间压缩**：L3 情景记忆按日桶 → 日概要 → 周 → 月 → 年（只压**已结束**且有原料的自然单位，同桶同层幂等）。
  **v0.8 证据层**：每轮压缩落一条 `scan` 轨迹——逐桶判定（`not-ended` / `no-sources` / `already-summarized` / `pending`）+ 非待压样本 ⇒「**为什么这个桶没压**」一次读清，`memory_health` 同段回报。判定与 `findPendingCompressions` **同源**（`explainCompressions` 是唯一实现），只记首轮（后续轮是链式推进的中间态）。
- **压缩即记忆**：订阅 `compaction/*` 事件，会话压缩完成时把 checkpoint 原文**保底存档**为 episodic 并即时通知（`wakeup=true`）——提炼与否由 agent 决定。
- **记忆回流服务**：`ctx.memoryApi.remember({text,kind?,tags?,key?,scope?})` → `{id,action}` 或 `{error}`（默认 `global` + `knowledge`），供 emotion / taskboard / evolution-core / skill-forge 等插件把运行态结论写回主记忆库。

> 两侧注入都采用**尾部追加**（不动消息批次中部），以保护前缀缓存命中率。

**角色视野（v0.5 · 多智能体工作台模式）**：启用 `roles` 后，`recall` / `memory_browse` / `memory_relate` / `memory_stats` 与两侧注入**共用同一视野**——按调用者角色（人类会话 → `default`；子代理 / 队员 → `derived`，可用 `by_preset` 精确映射）**在检索前剔除**不可见条目；`remember` 自动盖角色章并记 `author`（会话 id / 委派深度 / 预设名）。**未启用时零过滤**（`applyRoleView` 返回同一数组引用），行为与 v0.4 完全一致。排查「为什么看不见某条」先调 `memory_health` 看 `role` 与 `roleReason`。

> **诚实声明**：角色维度是**视野管理**，不是安全边界——`role` 参数可自述、记忆文件可被能读盘的人改写。要真正的隔离（幽灵隔间 / 多租户）请用**独立 `DSH_HOME`**。详见 `docs/semantic.md` §5.8 / §6。

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

**3) 30 秒验证**：调 `memory_version` → 期望返回 `name: dsh-agent-memory`、`version: 0.8.0` 与**晚于源码修改时刻**的 `buildAt`；再调 `memory_health` → 期望 `total > 0`（已有历史条目）**且尾部出现「压缩流水线：扫描 N 次 / 压缩 M 单元 / …」（无此段 ⇒ 还没重启到 v0.8）**；再调 `memory_stats` → 各 `kind` 计数与 `${DSH_HOME}/storages/agent_memory.json` 中的实际条目数一致。

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
| `roles.enabled` | `false` | **角色维度总开关**（v0.5）：`false` = 零过滤，行为与 v0.4 一致 |
| `roles.default` / `roles.derived` | `main` / `derived` | 人类会话 / 派生会话（子代理·队员）的缺省角色 |
| `roles.by_preset` | `{}` | `agentPreset` → 角色映射（如 `code: worker`） |
| `roles.policy_default` | `{read: ['*'], include_shared: true, include_global: true}` | 未声明策略的角色所用策略 |
| `roles.policies.<角色>` | `{}` | 角色策略：`read`（归属白名单，`'*'`=全部）、`kinds`（类型白名单）、`include_shared`、`include_global` |
| `audit.weights.*` | `ref .30 / recent .20 / usage .15 / tag .10 / role .10 / size .08 / dup .07` | 体检评分权重（**启发式先验**，非拟合值；校准见 `docs/semantic.md` §10 U8） |
| `audit.keep_recent_days` / `archive_min_age_days` | `7` / `14` | 保新窗口 / 归档候选最小年龄（天） |
| `audit.review_min_chars` / `demote_min_chars` | `12000` / `3000` | 交人裁决阈值 / 可降级阈值（字符） |
| `audit.access_trace.enabled` / `max_bytes` | `true` / `2000000` | 侧车用量轨迹（`<DSH_HOME>/memory-access-trace.jsonl`）：只追加 + 吞错 + 超限轮转 `.1`，**绝不改条目**；关掉则体检的 `usage` 项恒 0 |
| `audit.proposal_log.enabled` / `max_bytes` | `true` / `1000000` | 提案日志（`<DSH_HOME>/memory-audit-proposals.jsonl`，v0.7）：`audit` 候选 + `forget/update` 动作**同文件可按 id join** ⇒ 权重校准样本；同样只追加 + 吞错 + 轮转，**不写记忆库** |
| `audit.compress_trace.enabled` / `max_bytes` | `true` / `1000000` | **压缩流水线轨迹**（`<DSH_HOME>/memory-compress-trace.jsonl`，v0.8）：`scan` 逐桶判定 + `unit` 结果 + `error` 留证；只追加 + 吞错 + 轮转；`enabled: false` ⇒ 完全不落盘。**按各 workspace 自己的 `memory.yml` 生效**（实测口径见 §测试旁注） |

**角色维度最小示例**（工作台部署）：

```yaml
# <workspace>/.dsh/memory.yml
roles:
  enabled: true
  default: main            # 人类会话：默认策略 read ['*'] → 全见
  derived: worker          # 子代理 / 队员
  by_preset:
    code: worker
    verify-preset: verifier
  policies:
    worker:
      read: [main]         # 见自己 + 主脑 + 共享；看不见其他队员的隔间
      include_shared: true
    verifier:              # 验收方：拿不到实施方的过程流（AGENTS.md §5.26 G8 机制化）
      read: [main]
      kinds: [fact, knowledge, summary]
      include_global: false
    ghost-01:
      read: []             # 隔间：只看得见自己与共享记忆
```

> **fail-loud**：`memory.yml` 未知顶层键、非法枚举、非布尔、非正整数、`archive≠keep` 等一律抛 `MemoryConfigError`（不静默补默认）；**只有「文件不存在」走全默认**。当前 `<工作区>/.dsh/memory.yml` 不存在 ⇒ 全部走默认。

**作用域裁决**（`resolveScopes`，纯函数）：显式参数 > 配置模式 > 无 cwd 降级；读默认恒附加 `global`。

## 落盘与自证（出问题时先看这里）

**本插件有三条侧车轨迹**（v0.6 起逐步补齐；均为**只追加 / 吞错 / 超限轮转 `.1`**，**绝不改条目**）：

| 侧车 | 何时写 | 回答什么问题 |
|------|--------|-------------|
| `${DSH_HOME}/memory-access-trace.jsonl`（v0.6） | 每次 `recall` / 自动注入 / 体检 | 「注入到底有没有发生、命中了谁」——`memory_health` 的命中率信号读它 |
| `${DSH_HOME}/memory-audit-proposals.jsonl`（v0.7） | 每次 `memory_audit` + `forget`/`update` 成功 | 「我当时提了什么、后来做了什么」——两类记录同文件可按 id join |
| `${DSH_HOME}/memory-compress-trace.jsonl`（**v0.8**） | 每轮压缩的 `scan` / `unit` / `end` / `error` | **「这个桶为什么没压」**——`scan` 给出逐桶判定（`not-ended` / `no-sources` / `already-summarized` / `pending`）+ `memory_health` 读数 |

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
console.log("③压缩断在哪段 ↓ 侧车逐桶判定（v0.8 起可答）");
try {
  const lines = require("node:fs").readFileSync(process.env.DSH_HOME+"/memory-compress-trace.jsonl","utf8").trim().split("\n").map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);
  const scan = [...lines].reverse().find(r=>r.phase==="scan");
  console.log("   最近扫描", scan?new Date(scan.atMs).toISOString():"(无)", "| trigger="+(scan?scan.trigger:"-"), "| 候选="+(scan?scan.candidates:"-"), "| 待压="+(scan?scan.pending:"-"));
  console.log("   非待压判定", scan?scan.skipped:"-");
  console.log("   逐桶样本", scan?scan.sample.slice(0,12):"-");
  console.log("   错误笔数", lines.filter(r=>r.phase==="error").length);
} catch (err) { console.log("   (无轨迹：可能还没重启到 v0.8，或 memory.yml 里 audit.compress_trace.enabled=false)"); }
console.log("④kind",by("kind"),"| archived",e.filter(x=>x.archived).length);
console.log("⑤更新时刻",new Date(require("node:fs").statSync(process.env.DSH_HOME+"/storages/agent_memory.json").mtimeMs).toISOString(),"（周期补压一轮 = 360min）");
'
```

行为级验证（不依赖落盘读取，三选一）：调 `memory_health` 证明存储域已打开（**并读「压缩流水线」段——v0.8 起五问③的答案面**）；调 `memory_stats` 看计数是否与上面命令一致；调 `recall "关键词"` 看能否命中刚写的条目。

> ⚠️ 上述命令**直接读生产记忆库**——只读、不改；任何去重/删除属「动数据」类决策（须请示主人）。

## 生效判据与回退

**生效判据**（三选一，按可靠性排序）：

1. **语义级（最直接）**：调 `memory_version` → `version` 应等于 `package.json` 的 `0.8.0`，`buildAt` 应等于 `lib/index.js` 的产物 mtime（该工具是**动态**读这两处的——2026-09-01 之前它硬编码版本、`buildAt` 实为调用时刻，即「判据本身说谎」，已修）。
2. **进程级**：`lib/index.js` 的 mtime ≤ web 进程启动时间，且 `src/*.ts` 不新于 `lib/index.js`（源码改了没构建 = 跑的还是旧产物）。
3. **行为级**：工具面出现 11 个 `memory_*`；把一条记忆写进库后，`${DSH_HOME}/storages/agent_memory.json` 的 `tables.entries` 条数 +1 且文件 mtime 前进。

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

**实测（2026-09-15，node v24.18.0）：`npm test` → `# tests 179 / # pass 179 / # fail 0 / # skipped 0`；`npm run test:ts` → `# pass 81 / # fail 0 / # skipped 1`（跳过项为 `scope.test.ts` 的 Windows 平台条件）；`npm run test:all` → `# tests 261 / # pass 260 / # fail 0 / # skipped 1`。**无需网络、无需真实外部依赖**——LLM 总结路径在测试里以桩注入，telegram 不涉及。

> **双平台**：`.mjs` 套件在 **WSL（node v22.22.1）侧同样全绿 `179/179`**（2026-09-15 修掉三处夹具硬编码派生值之后；此前有 12 个 A 测试在 POSIX 侧**静默红**——夹具写死 `c:/Users/Alice/proj`，POSIX 下 `workspaceIdOf` 解析不出同值 ⇒ 作用域不匹配、整组用例变成 0 命中。详见 `docs/semantic.md` §10 U12。）

覆盖范围（`tests/` 共 17 个文件；`npm test` 跑其中 12 个 `.mjs`）：

- `store.test.mjs` — 条目 CRUD、写去重三态（`created`/`updated`/`merged`）、L1 key 覆盖、标题指纹合并
- `search.test.mjs` — 打分与排序、过滤、截断；**联想层**（related 链强度降序）与 **BFS 多跳闭包**（hop 标注/防环/每跳 limit）
- `timeline.test.mjs` — 本地时区桶算法、上级桶范围与归属、`findPendingCompressions`（只压已结束 + 有原料）、**并发幂等**（两实例并发只写一份概要 + 原料只归档一次）
- `lock.test.mjs` — 按键串行锁：同键排队、异键并行、前序异常不毒化链、settle 后键不泄漏（含 50 并发样本）
- `inject.test.mjs` — 启动注入：global fact 全量、概要先于明细、预算截断、归档条目不出场、空记忆不注入
- `auto-inject.test.mjs` — auto-recall **触发面**（GUI/Telegram 触发、其他插件注入**不触发**、空文本跳过、多 text block 拼接）+ 预算截断与长 query 截断
- `summarizer.test.mjs` — 总结提示词与响应处理
- `role.test.mjs` — **v0.5 角色维度**：会话判据、角色推导四级优先、准入四判据 R1–R4、未启用 = 同一引用透传、`include_global` 收窄、归属不可转移、工具层准入一致（recall/browse/stats/relate/update/forget）、无 `roles` 段的历史配置不崩
- `audit.test.mjs` — **v0.6 价值体检器**：只读零写入、承重必 KEEP（反例）、recency/体量单调、近重复簇、分档顺序、字符合计对账、视野一致、侧车轨迹（追加/坏行/轮转/吞错）、用量项、`audit` 配置 fail-loud、索引范围（看不见≠没有）
- `centroid.test.mjs` — **v0.7 重心/度量/提案日志**：重心衰减与锚点、同轮去重、封顶与退化、**重心召回落字面召不回的历史话题**、零回归逐字节一致、素材挑选、轨迹汇总口径、提案日志两类记录可 join + 吞错 + 开关、`memory_health` 命中率信号、`proposal_log` 配置
- `compress-pipeline.test.mjs` — **v0.8 压缩判定与轨迹发射**：逐桶判定四档命名与优先级、**判据单一真源**（`findPendingCompressions` ≡ `explainCompressions` 的 pending 投影）、首轮 `scan`（候选/待压/非待压分布/逐桶样本）、`unit`/`end` 事件序列、**零回归**（不给 sink ⇒ 结果逐字段一致）、**抛错先落 `error` 再原样上抛**
- `compress-trace.test.mjs` — **v0.8 侧车落盘纪律**：只追加、坏行/异形行跳过不抛、超限轮转 `.1`、样本截断、**不可写路径 ⇒ 返回 `false` 且不抛**（尸体样本）、`audit.compress_trace` 配置（缺省/可关/fail-loud）

`.ts` 套件（5 个文件：`browse` / `compaction-sink` / `config` / `scope` / `tools`）需 node ≥ 24（原生类型剥离）：2026-09-15 在 **node v24.18.0** 实测 `# pass 81 / # fail 0 / # skipped 1`（跳过为 Windows 平台条件）。`config.test.ts` 覆盖 `roles` 段的缺省/完整/4 条非法 fail-loud 用例。

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
