# 记忆连续性（memory-continuity）· 语义文档

> 版本 v0.1 · 2026-09-13 · 作者：爱丽丝 · 状态：**已实现（implemented）**
> 实现落点：`self-plugins/dsh-agent-memory/src/`
> 能力载体：插件 `dsh-agent-memory` v0.2.3（HOST 组合行 `agent-memory`）
> 开发方式：语义文档优先（先写清「是什么/什么关系/怎么裁决」，再让实现逼近，最后用实践回修）
> 本文件是**主副本**（I1）；`README.md` 面向使用者，`DESIGN.md` / `IMPLEMENTATION.md` 是设计文档——**都不是本文的同语义副本**，语义冲突以本文件为准（冲突需回修，见 §9）

---

## 1 · 元信息

| 字段 | 值 |
|------|-----|
| 能力名 | 记忆连续性（memory-continuity） |
| 主副本 | 本文件（`self-plugins/dsh-agent-memory/docs/semantic.md`） |
| 状态 | **implemented**（验收 18 项：17 项已实测 / 1 项待线上验收；`pending>0` 故**不得**标 verified） |
| 版本 | v0.2（文档）· 对应插件 v0.2.4（`package.json`） |
| 实现落点 | `self-plugins/dsh-agent-memory/src/`（14 个模块，见 §8） |
| 运行落点 | 数据：`${DSH_HOME}/storages/agent_memory.json`（域 `agent_memory` / 表 `entries`）<br>配置：`<workspace>/.dsh/memory.yml`（当前 E:\alice 不存在 → 全默认）<br>挂载：`.dsh/profiles/web/cordis.patch.yml` 的 `agent-memory` 行（`config.maxTokens: 16000`） |
| 作者 / 日期 | 爱丽丝 · 2026-09-13 |
| 相关规则 | AGENTS.md §5.20（语义文档系统）；§5.8（记忆检索纪律） |

## 2 · 定位与反定位

**定位**：让「经历过的事」跨会话存续——把 agent 决定要记的内容**结构化写入持久层**，再在恰当的时机（会话启动、主人每条消息、时间桶结束、会话压缩完成）**把它带回上下文**，并允许 agent 检索、修订、归档、沿关系行走。

**反定位（本文不管什么）**：

- **不是会话历史的替代**：原始逐字记录归 session log 与 compaction checkpoint；本能力存的是**提炼后的条目**。
- **不是知识库检索站**：不做向量检索、不做全文索引站；检索 = 标签/标题/正文加权打分 + 字符 2-gram（中文无空格分词自然工作）。
- **不做内容决策**：记什么、怎么组织、何时腾空归 agent（README §设计总纲：「机制只保证不丢、知道、兜底」）。
- **不是沙箱也不是权限边界**：它读写自己的存储与工作区配置，不隔离调用方、不做授权。
- **不压缩 L1/L2**：时间压缩只作用于 L3 情景记忆；`global` 作用域不压缩。
- **不是本次新写的实现**：本文档是对既有实现的语义收口，未改动任何代码。

## 3 · 术语

| 术语 | 含义 |
|------|------|
| 条目（Entry） | 记忆的最小单位：`{id, kind, title, body, tags, scope, createdAt, updatedAt, accessedAt, level, bucket, archived, key?, source?, archiveRef?}` |
| L1 `fact` | 事实层（主人偏好/环境事实）；带 `key` 时**同 (scope,key) 精确覆盖** |
| L2 `knowledge` | 知识层（可复用知识/教训）；同标题**合并** |
| L3 `episodic` | 情景层（有结果的事件/经历）；时间压缩的**唯一原料层**，也是压缩存档的落点 |
| `summary` | 压缩产物（日/周/月/年概要）；`level` + `bucket` 标明它代表哪个自然单位 |
| scope / workspaceId | 存储分区。`global` 为全局；workspaceId = `cwd` 规范化（统一 `/`、去尾分隔符、盘符小写，如 `e:/alice`） |
| bucket（桶） | 自然单位标识：`2026-09-12`（日）/`2026-W36`（周）/`2026-09`（月）/`2026`（年） |
| archived | **软删**：不进活跃检索，`includeArchive` 可取回（forget 的产物） |
| 去重三态 | `created`（新建）/ `updated`（L1 key 覆盖）/ `merged`（L2/L3 标题指纹合并） |
| 启动注入 | 会话第一个 step 注入一次「记忆速览」（目录化：标题+时间+tags，不含正文） |
| auto-recall | 每条**真实主人消息**到达时注入 top-N 相关记忆（带 snippet） |
| 懒压缩 | 访问记忆（recall / memory_stats）时触发的补压（fire-and-forget） |
| 周期补压 | 定时器驱动的补压（启动首跑 + 轮询），不依赖是否访问记忆 |
| 记忆回流 | 服务 `ctx.memoryApi.remember()`——其他插件把运行态结论写回记忆库 |
| 联想链 / 联想闭包 | `relatedOf` 单跳相关条目；`relateClosure` BFS 多跳记忆图行走（`hop` 标注层级） |
| 尾部追加 | 动态注入统一放在消息批次**末尾**（保护前缀缓存，避免插在中部破坏缓存命中） |

## 4 · 概念模型与不变量

```
写路径                                     读路径
────────                                   ────────
模型 → 10 个工具 ─┐                        会话首 step → 启动注入（速览，每会话一次）
其他插件 → memoryApi ─┼→ MemoryStore ─→ 域 agent_memory.entries ─→ .dsh/storages/agent_memory.json
压缩完成 → compaction sink ─┘             每条主人消息 → auto-recall（top-3 + snippet，尾追加）
                                              模型 → recall / memory_browse / memory_relate
时间轴：L3 条目 →〔日桶结束〕→ 日概要 →〔周桶结束〕→ 周概要 → 月 → 年（只压已结束单位；同桶同层幂等）
```

**不变量（每条都能被一次测量判真假）**：

1. **I1 单一写入真源**：所有写路径（10 工具 / `memoryApi` / 压缩存档 / 时间压缩）都经 `MemoryStore` → 同一张 kv 表；条目键为 `<scope>:<kind>:<id>`。→ 判据：存储文件里出现任何未经 Store 写入的条目形态即为违反。
2. **I2 写去重三态**：带 `key` 且同 (scope,key) 命中 → `updated`；`knowledge|episodic` 且标题归一化指纹命中 → `merged`（标签并集 + 正文追加，保留原 `id`/`createdAt`）；否则 `created`。
3. **I3 检索恒附加 global**：默认读 = 当前 workspace + `global`；工具参数 `scope` 显式覆盖优先于配置；无 `cwd` 时降级只读 `global`。
4. **I4 注入只给线索 + 预算封顶**：启动注入给「标题+时间+tags」不给正文，受 `inject.maxBytes/maxEntries` 约束；auto-recall 只给 top-N + ≤90 字 snippet，受 `autoInject.maxBytes(1500)/maxEntries(3)` 约束；两者**尾部追加**。
5. **I5 auto-recall 触发面严格**：仅 `source.kind==='user'`（GUI/Web）或 `dsh-agent-telegram` 插件注入的主人消息触发；同一消息 id 每会话只注入一次；工具结果/其他插件注入/模型消息一律不触发。
6. **I6 压缩只吃 L3**：`fact`/`knowledge` 永不作为压缩原料；`global` scope 不压缩；只压**已结束**的自然单位；目标桶已有同层级概要则跳过（幂等）。
   **I6a 同桶同层唯一（并发保证，2026-09-13 补）**：`compressUnit` 的临界区（查概要 → await LLM 总结 → 写入）按 `compressUnitKey(scope, level, bucket)` 在**进程内串行**（`src/lock.ts`），并在写入前二次复核。⇒ 进程内任意并发调用组合下，同一 (scope, level, bucket) 只落一条概要。判据见 §7 A16；旧反例（4 对重复桶）即本不变量**曾被违反**的实证。
7. **I7 归档是软删**：`forget` 置 `archived=true` 并记 `reason`；默认检索不可见，`includeArchive`/`memory_browse` 可再取；压缩后的原料同样被冷归档（可沿 `archiveRef` 回溯）。
8. **I8 配置 fail-loud**：`memory.yml` 未知键 / 非法值 → 抛 `MemoryConfigError`（不静默补默认）；仅「文件不存在」走默认。

## 5 · 契约

### 5.1 持久化

| 项 | 值 |
|----|-----|
| 域 / 表 | `agent_memory` / `entries`（`defineDomain`，版本 1；域名须匹配 `/^[a-z][a-z0-9_]*$/`） |
| 键 | `memoryKey(scope, kind, id)` → `<scope>:<kind>:<id>` |
| 落盘 | `${DSH_HOME}/storages/agent_memory.json`（storage-domain 负责） |
| 校验 | 域声明带 zod schema（写入边界校验）；`MemoryStore` 读出的都是**快照拷贝**（防外部误改） |
| 生产实况（2026-09-13 取证） | 547 条：knowledge 266 / episodic 177 / fact 68 / summary 35（day 31 · week 4 · month 1）；归档 180；scope 分布 `e:/alice` 458 + `global` 89 |

### 5.2 配置

`<workspace>/.dsh/memory.yml`（缺省值见下表；`DEFAULT_CONFIG` 深冻结）：

| 键 | 缺省 | 语义 |
|----|------|------|
| `scope` | `workspace` | `workspace` / `global-first` / `global`（只影响读写路由） |
| `layers` | `[fact, knowledge, episodic]` | 启用哪些层级（空数组=全关） |
| `auto_sink` | `true` | （字段存在；压缩存档由 compaction 事件驱动） |
| `timeline.{day,week,month,year}` | 全 `true` | 各层级压缩开关 |
| `timeline.archive` | `keep` | 当前契约**只允许** `keep` |
| `max_entries` | `2000` | 条目上限：**仅拦截新建**，覆盖/合并不受限 |
| `inject.{enabled,max_bytes,max_entries}` | `true / 3000 / 20` | 启动注入预算 |
| `auto_inject.{enabled,max_bytes,max_entries}` | `true / 1500 / 3` | auto-recall 预算 |

插件行配置（`cordis.patch.yml`）：`provider`/`model`（空=跟随会话路由）、`maxTokens`（宿主实配 **16000**；`summarizer.ts` 的 `DEFAULT_MAX_TOKENS` 也是 16000）、`compressIntervalMinutes`（360）、`compressInitialDelaySeconds`（30）。

### 5.3 作用域裁决（`resolveScopes`，纯函数）

| 输入状态 | 读 scopes | 写 scope |
|---------|----------|---------|
| 显式 `scope='global'` | `[global]` | `global` |
| 显式 `scope=<workspaceId>` | `[<workspaceId>, global]` | `<workspaceId>` |
| 无 `cwd`（任意配置模式） | `[global]` | `global` |
| 配置 `global` | `[global]` | `global` |
| 配置 `global-first` | `[global, <ws>]` | `<ws>` |
| 配置 `workspace`（默认） | `[<ws>, global]` | `<ws>` |

优先级：**显式参数 > 配置模式 > 无 cwd 降级**。

### 5.4 工具面（10 个，均 `defineTool` 注册）

| 工具 | 语义要点 |
|------|---------|
| `remember` | 写入；L1 key 覆盖 / L2·L3 合并 / 新建；受 `max_entries` 守卫（仅新建）；`kind` 未在 `layers` 启用 → fail loud |
| `recall` | 检索：关键词/层级/标签/时间过滤 + 相关度（标签3 > 标题2 > 正文1）与新鲜度排序；**每个结果附 `related` 联想链** |
| `update` | 按 id 改正文（首行作新标题）/ 替换 tags |
| `forget` | 软归档 + 记 `reason`（未知 id 报错） |
| `memory_browse` | 时间金字塔浏览（层级/时间/标签过滤 + 分页），「不知道有什么」时的发现路径 |
| `memory_relate` | 按 id 展开关联网络；`depth>1` 走 BFS 多跳闭包（`hop` 标注、visited 防环） |
| `memory_stats` | 各层/桶/归档计数（跨 scope 聚合） |
| `memory_health` | 运行时概览：条目总数/归档数/读 scopes/注入开关 |
| `memory_version` | 版本 + 构建时刻（**动态**读 `package.json` 与产物 mtime） |
| `memory_check` | 「待沉淀建议」；**当前恒返回空数组**（通道 B 未接线，§8） |

模型可见语义另有一条服务面：`ctx.memoryApi.remember({text, kind?, tags?, key?, scope?})` → `{id, action}` 或 `{error}`（默认 `global` + `knowledge`；标题取正文首行，>80 字截断）。

### 5.5 注入契约

| 项 | 启动注入（`inject.ts`） | auto-recall（`auto-inject.ts`） |
|----|----------------------|-------------------------------|
| 时机 | `agent/pre-step` 且 `step===1`，每会话一次 | 每条**新**真实主人消息（id 去重） |
| 内容 | `【记忆速览】`：global `fact` 全量 → summary 按 bucket 降序 → 近期明细按 `updatedAt` 降序（只有标题/时间/tags） | `【相关记忆（auto-recall）】`：top-N，每行 `- [KIND] 标题（日期 · 相关度）：snippet(≤90)` |
| 预算 | `maxEntries` 条 / `maxBytes` 字符（截断追加提示） | 同左（另：query 截断到 200 字符防长文噪音） |
| 位置 | 批次**末尾**追加 | 批次**末尾**追加 |
| 帧 | `<system-reminder>从记忆库加载的相关记忆（dsh-agent-memory）：…` | `<system-reminder>按当前消息自动检索的相关记忆（dsh-agent-memory）：…` |
| 空结果 | 不注入 | 不注入 |
| 消息来源 | `plugin: dsh-agent-memory` | `plugin: dsh-agent-memory` + `form: 'recall'` |

### 5.6 时间压缩契约

- **原料链**：`day ← episodic`（按条目 `bucket` 或 `createdAt` 归日桶）→ `week ← level=day 的 summary` → `month ← level=week` → `year ← level=month`。
- **触发**：`findPendingCompressions` 扫「所有已结束且**有原料、无同层概要**」的桶（含历史缺口回填）+ **上一自然单位**；`compressPending` 按 day→week→month→year 循环（保证链式原料就绪）。
- **执行**：LLM 总结（`summarizeEntries`，`maxTokens` 缺省 16000）→ 写 `summary` 条目（带 `archiveRef` = 原料 id 列表、`source.reason='时间压缩：<level> <bucket>，覆盖 N 条原料'`）→ 原料冷归档。
- **两条触发路径**：懒压缩（`tools.ts:228` recall / `tools.ts:350` memory_stats 内 `deps.compress(...)`，fire-and-forget、错误 `.catch(()=>{})` 吞掉）+ 周期补压（`periodic.ts`：`setTimeout(initialDelay=30s)` 首跑 + `setInterval(360min)` 轮询；scope 由 `store.scopes()` 自举并排除 `global`；单 scope 失败 `console.error` 后继续，下轮重试）。
- **并发与互斥（2026-09-13 补）**：两条路径**各建一个 `TimelineCompressor` 实例**（`index.ts:184` / `periodic.ts:53`），故互斥**不能**靠实例状态——`compressUnit` 临界区经 `src/lock.ts: withKeyLock` 按 `compressUnitKey(scope, level, bucket)`（`timeline.ts` 导出，**键唯一真源**，禁止调用点各自拼串）串行。键粒度 = scope+层级+桶（不同桶可并行压缩）。语义 = **排队串行**（后到者进锁后重新观察状态 → 命中刚落库的概要 → `already-summarized`），**不是**共享在飞结果；前序任务抛错不毒化链（下一次照常重试）。
- **写前复核（跨进程兜底）**：`store.remember` **之前**再读一次同桶概要；已存在则让位（`skipped=true, reason='already-summarized'`，返回已有概要、不写不归档）。⚠ 复核必须位于写入**之前**——写在 `remember` 之后会命中自己刚写的那份 → 提前 return → **原料永不归档**（实现时踩过，见 §9 第 7 条）。
- **锁的边界（诚实声明）**：只覆盖**单进程**。多实例共享同一 DSH_HOME 时（并行会话为常态工况，AGENTS.md §5.14），跨进程窗口由写前复核从「一次 LLM 往返」压缩到两次读写之间——非零，但已不足以产生重复桶（无 CAS 支持，故不声称零）。

### 5.7 调用点清单 `[MUST]`

| 调用方 | 调用点（文件:符号） | 时机 |
|-------|------------------|------|
| 插件装配 | `src/index.ts: apply()` | 开域 `agent_memory` → `MemoryStore` → `ctx.provide('memoryApi')` → 注册 10 工具 → 三个 install → 周期补压 |
| agent-loop | `src/inject.ts: installMemoryInject`（订阅 `agent/pre-step`） | 每会话第 1 个 step |
| agent-loop | `src/auto-inject.ts: installAutoRecallInject`（订阅 `agent/pre-step`） | 每条新主人消息 |
| 会话事件流 | `src/compaction-sink.ts: installCompactionSink`（订阅 `session/event`） | `compaction/start` / `compaction/summary` / `compaction/end` |
| 定时器 | `src/periodic.ts: installPeriodicCompress` | 首跑 30s；此后每 360 分钟；随 dispose 清定时器 |
| 工具执行内 | `src/tools.ts:228`（recall）、`src/tools.ts:350`（memory_stats）→ `deps.compress` | 访问记忆时补压（fire-and-forget） |
| 其他插件 | `ctx.memoryApi.remember()` 消费方：emotion / taskboard / evolution-core / skill-forge | 运行态结论回流（默认 `global`） |
| 模型 | 10 个工具（§5.4） | agent 自主调用 |

**写入真源唯一**：上表所有路径最终都调 `MemoryStore.remember / update / forget / put`。

## 6 · 边界与信任

- **能力 ≠ 沙箱**：本能力不隔离、不鉴权、不加密；能读到存储文件的人都可改记忆。
- **信任边界**：信任 Caller（agent/插件）的内容决策；不信任输入形态——配置走 fail-loud 校验，工具参数走 `defineTool` schema 校验，持久化走 zod schema。
- **不越界清单**：不做内容判断 ✅｜不做语义去重（只按标题指纹）✅｜不做跨设备同步 ✅｜不做凭据存储（工具描述明确「不用来记密钥/口令」）✅。
- **失败面（每条都明确「拒绝」或「放行」，无静默二义）**：

| 失败场景 | 处置 |
|---------|------|
| `memory.yml` 语法错 / 未知键 / 非法值 | **拒绝**：抛 `MemoryConfigError`（fail loud） |
| `memory.yml` 不存在（ENOENT） | 放行：全默认 |
| 溢出 `max_entries` 且要**新建** | 拒绝：报错（同 key 更新 / 合并仍允许） |
| 压缩落库失败（sink） | 静默（幂等，下次压缩再试）；原文仍留在会话日志 |
| 压缩 `end` 带 error / 摘要为空 | 不落库、不通知 |
| 归档后通知发送失败 | 吞掉（原文已落库，决策消息可后续补发） |
| 周期补压单 scope 失败 | `console.error` 记录 + 继续其它 scope + 下轮重试（**不静默**） |
| 懒压缩失败 | `.catch(()=>{})` **静默**（v0.3 前的停摆根因，见 §9） |
| 注入无命中 / 无 cwd / 配置关闭 | 不注入、不报错 |
| `memoryApi` 失败 | 返回 `{error}`，调用方容错不阻塞 |

## 7 · 可证伪验收

| # | 可证伪命题（一次测量判真假） | 证据出处 | 状态 |
|---|---------------------------|---------|------|
| A1 | 同 `key` 再写 → `updated`（L1 精确覆盖） | `tests/tools.test.ts`「remember：同 key 再写 → updated（L1 覆盖）」 | ✔ 已实测 |
| A2 | 同标题 `knowledge` 再写 → `merged`（标签并集 + 正文追加，不新增条目） | `tests/tools.test.ts`「remember：同标题 knowledge → merged（标签并集）」；`tests/store.test.mjs` describe「去重合并（规格 §2.2）」 | ✔ 已实测 |
| A3 | 无命中 → `created`，首行作标题、写入当前 workspace | `tests/tools.test.ts`「remember：新建（created），写入当前 workspace，首行作标题」 | ✔ 已实测 |
| A4 | `max_entries` 满：**新建**报错、同 key **更新**放行 | `tests/tools.test.ts`「remember：max_entries 满且新建 → 报错；同 key 更新仍允许」 | ✔ 已实测 |
| A5 | 作用域路由 6 条分支（显式覆盖 / 三配置模式 / 无 cwd 降级 / 显式优先） | `tests/scope.test.ts`：`默认 workspace 模式…`、`global-first 模式…`、`global 模式…`、`显式 scope=global…`、`显式 scope=workspaceId…`、`显式覆盖优先于 global-first 配置`、`无 cwd（两种模式）→ 降级只走 global`（12 用例） | ✔ 已实测 |
| A6 | 启动注入：global fact 全量 + 概要先于明细 + 预算截断 + 归档条目不出现 + 空记忆不注入 | `tests/inject.test.mjs` 5 用例（`digest：global fact 全量 + 概要先 + 近期明细` 等） | ✔ 已实测 |
| A7 | auto-recall 触发面：GUI 触发、Telegram 触发、**其他 plugin 注入不触发**、空文本跳过、多 text block 拼接、取最新一条 | `tests/auto-inject.test.mjs` 7 用例（`lastUserMessageText：其他 plugin 注入不触发` 等） | ✔ 已实测 |
| A8 | auto-recall 预算：`maxEntries` 截断、`maxBytes` 截断并提示、空 query/无命中返回空串、长 query 截断到 200 | `tests/auto-inject.test.mjs`「digest：maxEntries 截断」「digest：maxBytes 截断并提示」等 | ✔ 已实测 |
| A9 | auto-recall 在**真实会话**里生效（帧出现在模型请求中） | 本会话 system-reminder 实证：`【相关记忆（auto-recall）】` 帧（bot 抓到的 3 条记忆）；同类：启动注入帧 `从记忆库加载的相关记忆（dsh-agent-memory）` | ✔ 已实测 |
| A10 | 时间桶算法（本地时区）+ 金字塔原料归属 + 上级桶时间范围 | `tests/timeline.test.mjs`：describe「时间桶算法（本地时区）」「previousBucketKey 上一自然单位」「bucketRange 时间范围」「bucketBelongsTo 上下级归属」 | ✔ 已实测 |
| A11 | 压缩幂等（纯函数层）：目标桶已有同层级概要 → 不计入待压缩 | `tests/timeline.test.mjs` describe「findPendingCompressions 懒压缩触发」 | ✔ 已实测 |
| A12 | 只压已结束单位 + 有原料才压 + `fact`/`knowledge` 永不参与 | `tests/timeline.test.mjs`（同上 describe）；源码 `timeline.ts: isSourceFor`（kind/level 双重约束）；生产数据反查：`fact`/`knowledge` 条目 `level` 恒为 `null` | ✔ 已实测 |
| A13 | 压缩失败（`end` 带 error）/ 无摘要 → 不落库不通知；成功 → 保底落库 + 通知（`wakeup=true`、`target='next-turn'`、消息含条目 id） | `tests/compaction-sink.test.ts` 4 用例（断言 `sent[0].wakeup === true`） | ✔ 已实测 |
| A14 | 配置 fail-loud：未知顶层键 / 非法枚举 / 非布尔 / 非正整数 / `archive≠keep` / 冻结保护 等 14 类 → `MemoryConfigError` | `tests/config.test.ts`（`非法：未知顶层键 → MemoryConfigError` 等 14 用例；`非法：冻结保护（默认配置不可改）`） | ✔ 已实测 |
| A15 | 联想层：单跳关联强度降序（共享标签×3 + 标题 2-gram×2 + 正文 2-gram×1）/ BFS 闭包 hop 标注 + 防环 + 每跳 limit | `tests/search.test.mjs` describe「联想层（related 关联链）」「relateClosure · 多跳联想闭包（BFS 记忆图）」 | ✔ 已实测 |
| A16 | **端到端幂等**：进程内任意并发组合下，同一 (scope, level, bucket) 只存在一条概要 | 修复**前**反例（保留为尸体样本）：生产库 4 对重复桶 `day 2026-08-24 / 08-26 / 08-30 / 09-10`；修复**后**证据：`tests/timeline.test.mjs` describe「并发幂等（2026-09-13 修复：重复概要桶）」2 用例（两实例并发 → `summarize` 只调 1 次 + 只 1 份概要 + 原料只归档一次；写前复核命中他方概要 → 让位且原料保持未归档） | ✔ 已实测（存量 4 对重复桶仍在库，属历史数据，见 U1 遗留） |
| A17 | 周期补压：启动延迟首跑 + 周期轮询 + 单 scope 失败不静默 + dispose 清定时器 | 仅有代码路径（`src/periodic.ts` + `index.ts:200-226` 装配），**无单测文件**；生产日志未捕获 `周期补压` 输出（宿主流未落盘） | **待线上验收** |
| A18 | 互斥原语语义：同键排队串行（任意时刻 ≤1 在临界区）、异键并行不退化、前序异常不毒化链、settle 后键不泄漏 | `tests/lock.test.mjs` 6 用例（含 50 并发样本） | ✔ 已实测 |

> 测量口径：`pending = total − proven`（fail-closed）。本表 `total=18, proven=17, pending=1`。

## 8 · 与实现的关系

| 模块 | 职责 |
|------|------|
| `src/config.ts` | `memory.yml` 解析 + 默认值 + fail-loud 校验（纯函数） |
| `src/types.ts` | 条目/配置/查询/结果类型（无运行时） |
| `src/scope.ts` | workspaceId 规范化 + 读写 scope 裁决（纯函数） |
| `src/store.ts` | 条目 CRUD + 去重合并（L1 key / 标题指纹 FNV-1a）+ `stats`/`scopes` |
| `src/search.ts` | 过滤 → 打分（标签3/标题2/正文1）→ 排序 → 截断；`relatedOf` / `relateClosure` / `browseEntries` / `bucketLabel` |
| `src/inject.ts` | 启动注入（速览组装 + `pre-step` 挂载） |
| `src/auto-inject.ts` | auto-recall（触发面判定 + 摘要组装 + 挂载） |
| `src/summarizer.ts` | 总结提示词 + LLM 直调（`DEFAULT_MAX_TOKENS = 16000`） |
| `src/timeline.ts` | 桶算法 + `findPendingCompressions` + `TimelineCompressor`（压缩执行/幂等/冷归档）+ `compressUnitKey`（互斥键唯一真源） |
| `src/lock.ts` | 按键串行锁 `withKeyLock`（进程内、跨实例共享；排队语义 + 异常不毒化链） |
| `src/periodic.ts` | 周期补压定时器 |
| `src/compaction-sink.ts` | 压缩即记忆（`session/event` → 保底落库 + 通知） |
| `src/tools.ts` | 10 个工具定义 + 懒压缩钩子接线 |
| `src/index.ts` | 装配：开域 / `memoryApi` / 注册工具 / 三个 install / 周期补压装配 |

**未实现 / 未验证部分（显式标注）**：

- `memory_check` **恒返回空建议**——通道 B（信号沉淀提示）未接线；工具描述已如实声明。
- `timeline.archive` **只支持 `keep`**（其它值 fail loud）。
- **年层概要尚无产出**（生产库 `level='year'` 计数 0）——按设计只压**已结束**单位，2026 年未结束属正常；但缺乏「年层可产出」的正向验证（见 U5）。
- **周期补压无自动化测试**（A17）。
- **端到端幂等已修**（A16）：进程内并发不再产生重复桶；库中 4 对**历史**重复桶为存量数据，去重属「删数据」类决策（AGENTS.md §2.2 须请示），待主人裁决。
- 本文档**不是** `DESIGN.md` / `IMPLEMENTATION.md` 的同义副本；那两份是设计文档，可能与实现漂移，语义以本文件为准。

## 9 · 实践修订记录

> I3 载体：只记**被实践修正/补充**的地方（每条附取证来源）。

1. **2026-08-16 · `wakeup` 语义被修正（但文本未同步）**
   - 语义**被修正**：v0.3 初版（`645f898`）为 `wakeup=false`——「压缩完成只排队，等主人下一条消息时才送达」；同日 `e13fefc`（时间金字塔日层）改为 **`wakeup=true` 完成即送达**（主人定调：「不等主人下一条消息」）。
   - **仍未同步的文本**：`README.md` §压缩即记忆、`tests/compaction-sink.test.ts` 的文件头注释与**测试名**（`「…inbox 通知（wakeup=false 排队不唤醒）」`）写的都是旧语义，而该测试**断言的是 `true`**。→ 测试名与断言自相矛盾，属文本落后于行为（本次约束为「只写本文件」，未修，见 U4）。
   - 教训：**语义变更必须同时改「行为、测试名、README」三处**——只改行为会让下一位读者（包括压缩后的我）按旧语义理解。
2. **2026-08-21 · 懒压缩停摆 → 周期补压（预防性修复）**
   - 语义**被补充**：v0.2 只有「访问记忆才触发」的懒压缩，且错误被 `.catch(()=>{})` 吞掉 → **2026-08-16 起日概要零产出**（机制静默失效）。主人指示不再深挖旧因，直接建可靠新机制 → `periodic.ts`（启动延迟首跑 + 周期轮询 + 单 scope 失败 `console.error` 不静默）。
   - 教训：**唯一的触发路径 + 静默失败 = 停摆无人知**；触发必须至少双路（懒 + 周期），且失败必须留痕。
3. **2026-08-30 · 注入改「尾部追加」**
   - 语义**被修正**：动态注入（启动速览 + auto-recall）统一追加到消息批次**末尾**（原为插入），以保护前缀缓存、提升缓存命中率（主人指令「让注入走尾部追加」）。代码注释已固化该理由。
4. **2026-09-01 · `memory_version` 说谎被修正**
   - 语义**被修正**：原实现 `version` 硬编码、`buildAt` 实为「调用时刻」——v0.2.3 部署后仍报 0.2.2，**验证判据本身不可信**。改为动态读 `package.json` + 产物 mtime。
   - 教训：**HMR/部署验证的判据若由被验证方自报，必须自证来源**（否则「验证通过」是自欺）。
5. **2026-09-01 · auto-recall 上线（L3 注入）**
   - 语义**被补充**：主人「怎么提高记忆库使用率」定调 → 每条真实主人消息注入 top-N；同时按主人反馈**收窄触发面**「不要什么消息都返回记忆」（仅 GUI/Telegram 主人消息）。
6. **2026-09-13 · 本次语义收口取证（三条发现）**
   - **发现 1（记账缺口）**：`npm test` 的 glob 为 `tests/*.test.mjs` → 只跑 **117** 项；5 个 `*.test.ts`（**76** 项，`node ≥24` 下手工全绿）**不在套件内**；README 写「165+ tests」与实际均不符（见 U2）。
   - **发现 2（端到端幂等反例）**：生产库 4 对重复概要桶（见 A16）——纯函数幂等在单测成立，但**检查与写入之间无原子性**。
   - **发现 3（配置与默认值一致）**：宿主 patch 实配 `maxTokens: 16000`，与 `DEFAULT_MAX_TOKENS` 同值。
7. **2026-09-13 · 端到端幂等修复（按桶串行锁 + 写前复核）**
   - 语义**被补充**：I6 的「同桶同层幂等」原先只在纯函数层成立——两条触发路径各建实例，检查与写入之间横着一次 LLM 往返，并发可穿过检查（实测 4 对重复桶）。修复 = `src/lock.ts` 按键串行（键唯一真源 `compressUnitKey`）+ 写前复核；判据见 §5.6 / A16 / A18。
   - **实现踩坑（自证，值得留档）**：首版把复核块插在 `store.remember` **之后** → 命中自己刚写的概要 → 提前 return → **原料永不归档**。跑测试时 7 项红拦下——注意：若只做「两实例并发只写一份概要」的浅断言，此 bug 会**静默通过**并发测试。教训：① **幂等复核必须紧贴写入之前，位置本身就是语义**；② 并发测试必须同时断言**副作用完整**（原料归档、`archiveRef`），只数产物份数会放过「该做的没做」。
   - 顺带收口：第 1 条的文本漂移（`README.md` / `tests/compaction-sink.test.ts` 头注与测试名 / `DESIGN.md` 两处的 `wakeup=false` → `true`）与第 6 条的记账缺口（新增 `test:ts` / `test:all`，README 数字回填实测）。

## 10 · 未决问题

- **U1 ~~端到端幂等如何补~~ → 已解决（2026-09-13）**：采纳方案 ① 的**强化版**——不是 scope 级单飞，而是按 (scope, level, bucket) 串行（粒度更细、并行度更高；scope 级会把该 scope 全部桶串行化）+ 写前复核兜跨进程。**遗留（需主人裁决）**：库中 4 对历史重复桶是否去重（`forget` 软归档其中一份即可，但动记忆数据属须请示类）。
- **U2 ~~测试记账三处不一致~~ → 已解决（2026-09-13）**：新增 `test:ts`（76 项，node ≥24）与 `test:all`（201 项）；README 数字回填实测（125 + 76）。**遗留**：`.ts` 套件在 node 22（WSL 侧）不可跑——已在脚本旁注明前提，未强制统一运行时。
- **U3 压缩触发源不可分辨**：懒压缩与周期补压写出**同形**概要（`source.reason` 只记层/桶/原料数，不记触发路径）→ 生产数据无法回答「这条是谁压的」。倾向：在 `reason` 里加触发源标记（`lazy`/`periodic`），便于事后判别机制存活。
- **U4 ~~README / 测试名的 `wakeup=false` 文本~~ → 已解决（2026-09-13）**：四处（`README.md` §压缩即记忆、`tests/compaction-sink.test.ts` 头注 + 测试名、`DESIGN.md` §十 表格与通道 C 段）全部改为 `wakeup=true` 完成即送达，并标注 2026-08-16 修正来源；权威语义以行为与本文档为准。
- **U5 年层与 `deprecated` 路径缺正向验证**：年概要从未产出（因 2026 年未结束）；同时「压缩链能否上探到年」没有测试或 dry-run 证据。倾向：补一个注入固定时钟的链式压缩测试（day→week→month→year 全链）。
- **U6 `memory_check` 的对外承诺**：工具描述说「查看待沉淀建议」但恒空。倾向：要么下线该工具，要么在描述里更醒目地标注「未接线」（当前已有说明，但工具名本身仍是承诺）。
