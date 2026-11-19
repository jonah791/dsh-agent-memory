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
| 状态 | **implemented**（验收 **117 行**；解析器现算 `total=117 / proven=115 / pending=2`——2026-10-14 由 `semantic_get` 现读。⚠ **判据以解析器的实际行数为准，不以本节文字为准**：编号若有重复或不连续，解析器仍按**行数**计数 ⇒ 本行只复述读数，不自算。历史：2026-10-14 早些时候该行停留在「A1–A78 / total=78」，属**文档漂移**（DREAM 那批加了 A79–A84 未回填），本次一并修正；2026-09-22 曾报 77，真因是解析器吞掉续块首行，已修 `dsh-semantic-docs` `7f9def6`，详见 §7 汇总行；`pending=2 > 0` 故**不得**标 verified） |
| 版本 | v0.7（文档）· **对应插件 v0.24.0**（`package.json`）——v0.5 角色维度；v0.6 价值体检器；v0.7 重心化注入 + 命中率度量 + 提案日志；v0.8 压缩流水线证据层；**v0.8.1/v0.8.2 修 U10 真因**（总结调用补会话 id；输出预算与可归因证据）<br>**v0.12 检索别名**（2026-10-13 重做第一步；⚠ **契约节缺**——原引用的「§5.14」编号已被 v0.15 占用，正本暂在 `src/types.ts` 的 `Entry.aliases` 与 `tests/aliases.test.mjs`，已记入 §10）<br>**v0.13 主体层**（2026-10-14：`subject` = 条目「**关于谁**」——`self` / `master` / 缺省通用；与 `role` 正交；语义见 §9 第 19 条、判据见 §7 A85–A94）<br>**v0.14 约定状态**（2026-10-14：`grounding` = 「**是否已被共同建立**」——`established` / `proposed`（我提的、主人未回应）/ `scoped` / `rejected` / 缺省未标注；与 `subject` 正交；语义见 §9 第 20 条、判据见 §7 A95–A104）<br>**v0.15 时效维**（2026-10-14：`reviewAfter` = **复查死线** + `watchFor` = **观察条件**；论文 *Fresh at Decision, Stale at Action* 移植；契约见 **§5.14**、语义见 §9 第 21 条、判据见 §7 A105–A116）<br>**v0.23 执行位置**（2026-11-15：`project` = 哪个项目 + `taskId` = 哪个任务；**两级不可拆**；与 `scope` 正交（后者是准入且值是路径）；`project` 写入时按会话 cwd **自动盖章**（经 `dsh-project-state` **软依赖**，缺该插件则不盖）；依据 = 主人 2026-11-15 架构定调「Project 不属于 Agent 也不属于 Session」 + MAGE/EMNLP 2026（记忆组织轴该是执行路径而非语义相似度）；语义见 `src/execution.ts` 文件头、不变量见 §9 第 16 条 I16、判据见 `tests/execution.test.mjs`）<br>**v0.24 事实生命周期**（2026-11-17：`validAfter` = 这条结论**从何时开始成立**（≠ `createdAt`）+ `supersededBy` / `supersedes` = **谁替代了谁**（只留一层）；**唯一写入口** `memory_supersede`（两侧同写），`update` 刻意不暴露这两个字段；旧条目**绝不删除**，recall 默认仍返回并打「⚠ 已过时」标记；契约见 **§5.16**、语义见 `src/succession.ts` 文件头、判据见 `tests/succession.test.mjs`） |
| 实现落点 | `self-plugins/dsh-agent-memory/src/`（19 个模块，见 §8） |
| 运行落点 | 数据：`${DSH_HOME}/storages/agent_memory.json`（域 `agent_memory` / 表 `entries`）<br>配置：`E:\alice\.dsh\memory.yml`（**2026-09-15 起存在**：`roles` 已启用，策略 main/worker/verifier/ghost；其余键走默认）<br>侧车：`${DSH_HOME}/memory-access-trace.jsonl`（v0.6 用量）、`${DSH_HOME}/memory-audit-proposals.jsonl`（v0.7 提案）、`${DSH_HOME}/memory-compress-trace.jsonl`（v0.8 压缩流水线）<br>挂载：`.dsh/profiles/web/cordis.patch.yml` 的 `agent-memory` 行（**`config.maxTokens: 32000`**——2026-09-15 由 16000 抬高，见 §7 A64–A67 旁注） |
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
| 角色（role） | v0.5 条目的**分区维度**：`main`（人类会话缺省）/ `derived`（派生会话缺省）/ 自定义（`worker` / `verifier` / `ghost-01` …）。缺省不设字段 = **共享记忆** |
| 视野（RoleView） | 一次调用解析出的「角色 + 策略 + 是否收窄 global」，由 `roleViewOf` 产出，所有读路径共用 |
| 准入（admission） | 按策略**在检索前剔除**条目（R1–R4 判据）；不是排序降权 |
| 归属（stamp） | 写路径给新条目盖 `role`（仅当角色维度启用或显式指定）+ 记 `author`（溯源） |
| 隔间 | 一个角色对应的可见集合；隔间之间默认互不可见（除非策略 `read` 白名单放行） |
| 主体层（subject） | v0.13 条目的**语义标记**：`self`（关于我）/ `master`（关于主人）/ 缺省 = **通用**。与 `role` **正交**——`role` 答「谁写的」，它答「**关于谁的**」。**不是准入**（不改变任何条目的可见性，故无总开关）；新建盖章 + `update` 显式转移；存量零迁移 |
| 约定状态（grounding） | v0.14 条目的**来源性质标记**：`established`（主人明确说过）/ `proposed`（**我提的、主人未回应**）/ `scoped`（接受但限范围）/ `rejected`（主人否决过）/ 缺省 = **未标注**。与 `subject` 正交——后者答「关于谁」，它答「**是否已被共同建立**」。⚠ **不做强制门**（理由见 `src/grounding.ts` 文件头：主人授权模式是「给方向、我自己决定」）；渲染**只凸显需警觉的三类** |
| 执行位置（project / taskId） | v0.23 条目的**执行归属**：`project`（哪个项目，如 `alice` / `pp`）+ `taskId`（哪个任务，**只在 project 内唯一**）/ 缺省 = **通用**。与 `scope` 正交——`scope` 是**准入**（存哪个分区、谁看得见，**值是路径**），本维是语义标记（可选筛子，不改变可见性）。**两级不可拆**：新建时单给 `taskId` 直接 fail-loud；`update` 单给则合法（条目可能已有 project，判据按「修改**之后**的状态」）。清 `project` **连带清** `taskId`（级联只住 `store.ts::update` 一处）。`project` 写入时按会话 cwd **自动盖章**（经 `dsh-project-state` 软依赖，缺该插件则不盖）；`taskId` **不自动**（是判断）。语义与依据（含 MAGE 论文）见 `src/execution.ts` 文件头 |

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
9. **I9 视野单点过滤（v0.5）**：启用 `roles` 后，**所有读路径**（recall / browse / relate / stats / 启动注入 / auto-recall）共用 `applyRoleView` 这一处准入过滤——条目在**检索之前**被剔除而非降权。⇒ 判据：任何读路径绕过 `gatherReadable`（工具层）或 `applyRoleView`（注入层）即为违反；未启用 `roles` 时 `applyRoleView` 必须返回**同一数组引用**（零过滤、零拷贝）。
10. **I10 归属不可转移（v0.5）**：`role` 只在**新建**时盖章；命中已有条目（key 覆盖 / 标题合并）保留原归属——写入不得静默转移分区。`author` 记创建者，后续修订不覆盖。
11. **I11 共享是默认且是显式的（v0.5）**：不盖章 = 共享记忆（所有角色按各自策略可见）；盖章只发生在「`roles.enabled` 为真」或「调用方显式给 `role`」时。存量条目（含 v0.4 前写入的 674 条）一律为共享——**迁移安全优先于隔离强度**。
12. **I12 主体层不是准入（v0.13）**：`subject` **不改变可见性**——设了它的条目对任何调用方**依然可见**（「关于主人的记忆」我看得见，「关于我的」主人也看得见）。它是语义标记（可过滤 / 可统计 / 可渲染），只在**显式给过滤参数**时参与筛选。→ 判据：未给 `subject` 参数时读路径返回的集合与加本维度前**逐条相同**；`filterBySubject(entries, undefined)` 必须返回**同一数组引用**（零拷贝，见 §7 A86）。
    与 `role` 的准入刻意相反，理由是**荒谬性检验**：「我记不住关于你的事」不该是机制能造成的结果。准入是**会让人失明**的能力，故 `role` 需要总开关；`subject` 不改可见性 ⇒ 无失明风险 ⇒ 无开关。
13. **I13 主体层只有一个真源（v0.13）**：通用层在存储里**没有 `subject` 键**（不是 `subject: undefined`）。→ 判据：新建不带 subject 的条目、以及 `update({subject: ''})` 清除后，落盘对象必须 `!Object.hasOwn(entry, 'subject')`（见 §7 A90）。理由：条目是 JSON 落盘，「字段存在但值为 undefined」与「字段不存在」是**两种表示**——两处表示 = 两处可能不一致。
14. **I14 主体层可显式转移（v0.13，与 I10 刻意相反）**：`role` 不可转移（转移改**可见范围** = 安全后果）；`subject` **允许**且**必须**允许转移——否则几百条历史记忆永远无法标注，维度等于白建。三态：`update` 不给该参数 = **不动** / 给值 = 设置 / 给空串 = 清除。→ 判据见 §7 A91。本条反对的只是**静默**转移（`remember` 命中已有条目时不得覆盖原标注，见 A89）。
15. **I15 约定状态不做强制门（v0.14 · 论文 Grounding Awareness 的刻意偏离）**：`grounding` 是**标记**而非执行门——本系统**不**在动作前强制拦截「未获授权」的调用。理由（必须留档，否则会被「与论文对齐」改掉）：论文的默认立场是「未授权 ⇒ 必须确认」并配 execution gate，而本系统主人的授权模式是「给方向、我自己决定」（AGENTS.md §2.2 技术处置自主 · 内部事务不上抛）⇒ 处处请示会**直接违背该定调**，把「自主」改回「待批」。⇒ 移植的是**可见性**（让我不被自己的提议骗），不是**拦截**。
    ⚠ **本版如实保留的残留风险（不得粉饰）**：`grounding` 缺省 = **未标注**，而「未标注」在检索时与「已建立」**长得一样**——即**不主动标注就得不到保护**，这正是论文点名的失败面。本版的对策只有两条：① 新条目在**我意识到**时标注（工具面给参数，不强制）；② 用 `recall({ grounding: 'proposed' })` 作**审查入口**找出「我提的、主人未回应」的条目并补标。⇒ 若某天发现未标注里混着大量我的提议，那是**回填欠账**，不是机制失效——两者要分清。
    **渲染纪律**：只凸显 `proposed` / `scoped` / `rejected` 三类（需警觉的）；`established` 与未标注**一律留空**——库里绝大多数是常规来源，全打标记等于没打（同 `subjectTag` 的教训）。
16. **I16 执行位置不是准入，且两级不可拆（v0.23）**：`project` / `taskId` **不改变任何条目的可见性**（同 I12）——它们是语义标记，只在显式给过滤参数时参与筛选。→ 判据：未给 `project` 参数时读路径返回的集合与加本维前**逐条相同**；`filterByExecution(entries, {})` 必须返回**同一数组引用**（零拷贝，`tests/execution.test.mjs` 有硬断言）。
    **两级不可拆**：`taskId` 只在 `project` 内唯一 ⇒ ① 新建时**单给 taskId fail-loud**（`parseExecutionArgs`）；② 落盘时**无 project 的 taskId 被剥掉**（`store.ts` 新建路径）；③ **清 project 连带清 taskId**（`store.ts::update`，级联只住这一处）。→ 判据：三种情形下落盘对象都必须 `!Object.hasOwn(entry, 'taskId')`（悬空任务 id 会让「按任务查」查到不知道该属于谁的条目）。
    **为什么与 `scope` 分开**：`scope` 的值是**路径**（目录改名 / 换盘就漂）且承载**准入**（改其语义 = 改权限，有安全后果）；`project` 是稳定的语义 id 且无安全后果。合并会同时毁掉两个语义——同 I12 里 `subject` ↔ `role` 的分家理由。
    **联动的边界（不得扩展）**：`project` 写入时按会话 cwd **自动盖章**，走 `dsh-project-state` 的**软依赖**（`ctx.reflect.get('projectState', false)`；缺该插件则不盖，静默降级）；`taskId` **永不自动**——「这条记忆是否来自该任务」是判断，不由机制替主体断言。⚠ 自动盖章会盖错（通用方法论写在项目目录里是常事）⇒ 本维**必须**可清除（`update({ project: '' })`）且渲染可见，移植的是**可见性**不是拦截（同 I15 的立场）。

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

### 5.4 工具面（16 个，均 `defineTool` 注册）

> ⚠ 2026-10-14 对齐：本节标题原写「12 个」，与实现（**14 个**）不符——v0.11 `memory_recompress` 与 v0.13 期 `memory_review_mark` 上线时未同步（**预先存在的文档漂移**，非 v0.15 引入）。凭据：`tests/tools.test.ts`「工具齐备，名称与契约一致」的实测快照。
> ⚠ 2026-11-17：本节实测曾为 **15 个**（上面那行写 14——`memory_dispose` 于 2026-10-29 上线时未回填，**同型漂移第二次**）。v0.24.0 加 `memory_supersede` ⇒ **16 个**。行数由 `tests/audit.test.mjs` 的 A42（硬编码工具数，每变一次必须显式确认）与本节共同锁定。

| 工具 | 语义要点 |
|------|---------|
| `remember` | 写入；L1 key 覆盖 / L2·L3 合并 / 新建；受 `max_entries` 守卫（仅新建）；`kind` 未在 `layers` 启用 → fail loud；**v0.15** 另收 `reviewAfter`（复查死线，接受 `+7d`/`+2w` 并**折算成绝对日期**后落库）与 `watchFor`（观察条件 1–8 条）；**v0.24** 另收 `validAfter`（这条结论**从何时开始成立**；只收 `YYYY-MM-DD` / ISO 时刻，**不收回溯相对写法**） |
| `recall` | 检索：关键词/层级/标签/时间过滤 + 相关度（标签3 > 标题2 > 正文1）与新鲜度排序；**每个结果附 `related` 联想链**；**v0.15** 另收 `staleness` 过滤（`expired`/`due-soon`/`fresh`）——这是「**我的哪些结论该重看了**」的**审查入口**；**v0.24** 另收 `superseded` 过滤（`current`/`superseded`，缺省**不过滤**＝不隐藏已过时条目） |
| `update` | 按 id 修订；**v0.9 三模式**：`replace`（缺省·`text` 首行作标题、全文作正文）/ `append`（追加到正文末尾）/ `patch`（`find`→`replace`，**要求唯一命中**，0 处或多处一律 fail loud）；内容真变即落**修订快照**（`revisions`，保留最近 3 条）；`tags` 整体替换 |
| `forget` | 软归档（`archived=true`，`reason` 记入 `source`）；**v0.9 三种选择器**：`id`（单条·未命中报错）/ `ids[]`（批量）/ `tier`（按 `memory_audit` 分档批量：`ARCHIVE`/`DEMOTE`/`REVIEW`，**`KEEP` 被拒**）；`max` 护栏（缺省 100 / 硬上限 500）+ `dryRun` 预览；批量自动记 `forget: bulk（N 条）` |
| `memory_merge` | **v0.9 合并原语**：把 `ids` 的正文并入 `canonical`（带「合并自 <id>（<title>）」来源标注，**信息不丢**），随后软归档之；`strategy=keep-canonical` 只归档不动正文；跳过分支（canonical 自身 / 列表内重复 / 不存在 / 已归档）逐条回报 |
| `memory_browse` | 时间金字塔浏览（层级/时间/标签过滤 + 分页），「不知道有什么」时的发现路径 |
| `memory_relate` | 按 id 展开关联网络；`depth>1` 走 BFS 多跳闭包（`hop` 标注、visited 防环） |
| `memory_stats` | 各层/桶/归档计数（跨 scope 聚合） |
| `memory_audit` | **只读提案器**（v0.6 §5.9）：KEEP / DEMOTE / ARCHIVE / REVIEW 四档 + 证据行 + 层级聚合；**不归档、不删除、不刷 `accessedAt`**；读路径一样过角色视野。**v0.9：与 `forget`/`memory_merge` 构成可执行闭环**（提案 → `dryRun` 预览 → 执行） |
| `memory_health` | 运行时概览：条目/归档数、读 scopes、注入开关、**角色与判据**（v0.5）、**命中率信号**（v0.7：注入次数/主动检索/去重命中/最近时刻）、**压缩流水线读数**（v0.8 §5.12：扫描轮数/压缩单元数/最近待压数/非待压判定分布/候选样本） |
| `memory_version` | 版本 + 构建时刻（**动态**读 `package.json` 与产物 mtime） |
| `memory_check` | **待处置的近重复欠账**（2026-10-28 起；取代原先恒返回空数组的「待沉淀建议」壳）：`remember` 命中相似条目却没给 `similarDisposition` 时，那些候选会一直列在这里，直到被销账 |
| `memory_dispose` | **销账**：把 `memory_check` 列出的欠账标记为已处置，此后不再列为待处置。⚠ 它**只写销账记录，不执行实际处置**——合流用 `memory_merge`、补写用 `update`、判无关则无需动作。`disposition` ∈ `merged`/`updated`/`unrelated`；`reason` 必填（无理由的销账等于把欠账藏起来）；`candidateIds` 必须**真的撞过**（有 hit 历史），否则整批不写（fail-closed，防 id 拼错被静默吞掉）。⚠ 处置是**时间轴上的重置**，不是永久免检：同一候选之后再撞上会重新进榜 |
| `memory_recompress` | **v0.11**：重压一条**超预算**的概要（用它自己的正文再压一次、整体替换，旧版进 `revisions`）；只对 `kind=summary` 且 level/bucket 齐全的条目有效，已在预算内则跳过（**不白跑一次调用**） |
| `memory_review_mark` | **v0.13 期**：给体检候选打「已裁决」标记；**只写侧车、绝不改条目**（不刷 `accessedAt`/`updatedAt`）；标记只对「当时那一版」有效——条目若再变动会自动重新纳入常规分档（不是永久免检） |
| `memory_supersede` | **v0.24 替代关系的唯一写入口**（§5.16）：`id`（新）+ `supersedes[]`（旧，必填非空）+ 可选 `validAfter` / `overwrite`。一次调用写**两侧**（新 `.supersedes` ⊇ 旧 id；每个旧条目 `.supersededBy = 新 id`）；**旧条目不删不归档**（保留原值作对照）；**只留一层**（不递归展开祖先）。fail-loud 三处：id 不存在 / 自引用 / 旧条目已被**别的**条目替代过（二次替代需显式 `overwrite: true`；已是本次目标则幂等跳过） |

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
| 插件装配 | `src/index.ts: apply()` | 开域 `agent_memory` → `MemoryStore` → `ctx.provide('memoryApi')` → 注册 11 工具 → 三个 install → 周期补压 |
| agent-loop | `src/inject.ts: installMemoryInject`（订阅 `agent/pre-step`） | 每会话第 1 个 step |
| agent-loop | `src/auto-inject.ts: installAutoRecallInject`（订阅 `agent/pre-step`） | 每条新主人消息 |
| 会话事件流 | `src/compaction-sink.ts: installCompactionSink`（订阅 `session/event`） | `compaction/start` / `compaction/summary` / `compaction/end` |
| 定时器 | `src/periodic.ts: installPeriodicCompress` | 首跑 30s；此后每 360 分钟；随 dispose 清定时器 |
| 工具执行内 | `src/tools.ts`（recall / memory_stats）→ `deps.compress` | 访问记忆时补压（fire-and-forget） |
| 其他插件 | `ctx.memoryApi.remember()` 消费方：emotion / taskboard / evolution-core / skill-forge | 运行态结论回流（默认 `global`） |
| 装配（v0.8 证据层） | `src/index.ts: makeCompressTrace(cfg, trigger)` | 懒压缩与周期补压**两条路径各自注入 sink**；sink 补齐 `atMs`/`trigger` 后落 `<DSH_HOME>/memory-compress-trace.jsonl`（吞错） |
| 模型 | 11 个工具（§5.4） | agent 自主调用 |

**写入真源唯一**：上表所有路径最终都调 `MemoryStore.remember / update / forget / put`。

### 5.8 角色维度契约（v0.5 · 多智能体工作台模式）

**背景**：工作台里主脑（人类会话）、派生队员（子代理 / Agent Teams 成员）、验收方、幽灵隔间共享**同一张记忆表**。角色维度给「谁看得见什么」一个可配置、可验收的答案（借鉴 MAGE, arXiv:2608.29678 的 role policy index + Γ 准入门槛）。

**配置块**（`memory.yml`，全部 fail-loud；缺省见 `DEFAULT_ROLES_CONFIG`）：

| 键 | 语义 | 缺省 |
|----|------|------|
| `enabled` | 总开关。**false = 零过滤**（行为与 v0.4 完全一致） | `false` |
| `default` / `derived` | 人类会话 / 派生会话的缺省角色名 | `main` / `derived` |
| `by_preset` | `agentPreset` → 角色（预设名映射，如 `code: worker`） | `{}` |
| `policy_default` | 未声明策略的角色所用策略 | `{read: ['*'], include_shared: true, include_global: true}` |
| `policies.<role>` | 角色策略：`read`（归属白名单，`'*'` = 全部）、`kinds`（类型白名单）、`include_shared`、`include_global` | `{}` |

**推导链**（`deriveRole`，纯函数）：显式 `role` 参数 → `by_preset[agentPreset]` → 人类会话（`session-<uuid>`）取 `default` → 派生会话取 `derived`；**无会话 id → 取 `default`**（保守，宁可见全不可静默失明）。判据理由随 `memory_health.roleReason` 透出。

**准入判据**（`admitsEntry`，按序，fail-closed）：

| 序 | 判据 | 结果 |
|----|------|------|
| R1 | `policy.kinds` 非空且条目 kind 不在其中 | 拒绝 |
| R2 | 条目无 `role`（共享）且 `include_shared !== false` | 放行 |
| R3 | 条目 `role` === 调用者角色 | 放行 |
| R4 | `policy.read` 含 `'*'` 或含条目 `role` | 放行 / 否则拒绝 |

**读路径**：`gatherReadable`（工具层）与注入层各自先 `narrowReadScopes`（`include_global: false` 且**未显式给 scope** 时去掉 global），再 `applyRoleView` 过滤。 **写路径**：`role` 只在**新建**时盖章（启用 roles → 盖调用者角色；未启用 → 仅显式 `role` 生效；两者皆无 → 共享）；`author = {sessionId, delegationDepth, preset}` 无条件记录。 **工具参数**：`recall` / `memory_browse` / `memory_relate` / `remember` 接受 `role`（视角/归属覆盖）；`update` / `forget` **不提供**越视野后门（只能改视野内条目）。 **推荐骨架**（工作台部署，示例见 README）：`main: read ['*']`；`worker: read ['main']`；`verifier: read ['main'], kinds [fact, knowledge, summary], include_global false`；`ghost-*: read []`（隔间互不可见）。

### 5.9 价值体检器契约（v0.6 · `memory_audit`）

**定位**：**只读提案器**，回答唯一问题——「库里哪些条目值得继续占位置，哪些该降级/归档」（给证据行，不给感觉）。**提案 ≠ 裁决**：它不归档、不删除、不写库、不刷新 `accessedAt`；动记忆数据归 agent（且属须请示类）。

**输入信号（先量后设计 · 2026-09-15 实测 676 条）**：

| 信号 | 有无 | 取证 |
|------|------|------|
| 时间（createdAt/updatedAt/accessedAt） | ✅ | **读路径不刷新 `accessedAt`**：676 条中 180 条 `accessedAt≠updatedAt`，而 180 **恰等于归档数** ⇒ 差异只来自归档动作 |
| 引用结构（`archiveRef` 承重） | ✅ | 177/676 条被概要引用 |
| 体量（字符） | ✅ | 活跃 496 条 / 683,315 字符 |
| 标签 | ✅ | 仅 2 条无标签 |
| 近重复 | ✅ | 标题指纹 6 簇 / 13 条 |
| 溯源（`source` / `role`） | ⚠ 弱 | 473 条无 `source`（权重给低） |
| 使用次数 `u(x)` / 增益 `g(x)` / 矛盾数 `cnt(x)` / 置信 `κ(x)` | ⚠ 由**侧车轨迹**补 `u(x)` 一项 | 见下「逻辑轨迹」；其余三项本版**不假装有** |

**评分（序数；不宣称绝对值有意义）**：

```
score(x) = w_ref·承重 + w_rec·recency + w_use·usage + w_tag·标签 + w_role·归属
         − w_size·体量 − w_dup·重复
recency = exp(−age/S)，S = 30 天（MAGE 的 R(x,t)，减复述项）
usage   = 排序加权归因 Σ decay^pos（v0.12；无轨迹 ⇒ 恒 0，公式不因此失真，只少一项证据）
```

> **`usage` 的口径（v0.12 · DREAM 迁移）**：`pos` = 该条目在**那一次返回列表**中的下标
> （`memory-access-trace.jsonl` 的 `ids` 本就是按分数降序的结果列表 ⇒ 位置 = 排名；且**历史轨迹
> 可回溯算出，零迁移**）。`decay=0.6` ⇒ 第 1 位 1.0 · 第 5 位 0.13 · 第 10 位 0.006。
>
> **改它的理由**：旧口径「被返回过几次」让第 1 位与第 20 位**同权**——真库实测有一批
> `hits=4~8 而归因仅 0.08~1.26` 的条目（返回时都排在尾部，却全额记账）。
>
> **边界（两条，均已实测）**：① `classify()` 不消费 `usage` ⇒ 本项**只影响同档内排序**，
> 不翻转任何档位（真库 1444 条：翻转 **0**）；② `attributed ≤ hits` 恒成立（`decay<1`）
> ⇒ 本项**只可能下调或保持，永不上调**，是「停止过度记账」而非「重新分配奖励」。
>
> 出处：DREAM（arXiv 2610.13267）附录 G Eq.29 `aᵢ = softmax(Score(q_t,vᵢ)/τ_u)` 的**序数形态**
> ——该论文不在轨迹里存分数（只存有序 id）时，位置就是排序的单调摘要。

权重来自 `memory.yml` 的 `audit.weights`（**启发式先验，不是拟合值**——校准是 v3 的事，需要「提案被采纳/否决 + 事后是否后悔」的样本）。

**四档判据（输出决策 + 理由，不是排行榜）**：

| 档 | 判据（按序判定） |
|----|-----------------|
| `REVIEW` | 落在近重复簇 / 体量超 `review_min_chars` / 层级异常 → 交人裁决 |
| `KEEP` | 被 `archiveRef` 引用（承重原料）**或** age ≤ `keep_recent_days` **或** 有 `role`+`author` |
| `ARCHIVE` | 未被引用 且 age ≥ `archive_min_age_days` 且 无 `source` 且 已被概要覆盖（同 kind 存在更晚概要） |
| `DEMOTE` | 其余「未被引用且体量 ≥ `demote_min_chars`」（可降级：并入上级概要/压缩） |

**输出形状**：`memory_audit({ scope?, role?, topN?, minChars?, includeArchive? })` → `{ summary: { total, chars, byBucket, charsByBucket }, groups: [{ key, kind/level/tag, count, chars, bucket }], candidates: [{ id, kind, title, bucket, score, reasons[], evidence }], notes[] }`。

**逻辑轨迹（侧车，v0.6 起采集）**：`<DSH_HOME>/memory-access-trace.jsonl` —— 一行一次读命中：`{atMs, source:'recall'|'auto', role, ids:[…]}`。写入**只追加**（POSIX append，天然免锁）、**吞错**（失败即跳过，不影响 recall）、**按体积轮转**（超 `access_trace.max_bytes` 改名为 `.1` 重开），**绝不改条目**。审计器只读它，缺文件 ⇒ `usage=0`。

**硬约束（三条，均可断言）**：
1. **只读**：跑完存储文件内容不变、`accessedAt` 不变（判据：跑前后字节级一致）
2. **视野一致**：`memory_audit` 是读路径 ⇒ 过 `applyRoleView`（提案只含调用者视野内的条目）
3. **不做自动处置**：无 `--apply`、无定时归档；删除/归档由 agent 显式发起

### 5.10 重心化注入契约（v0.7 · 从「消息关键词」到「上下文重心」）

**动机（借鉴 VCPToolBox 的「引力」范式——理念而非代码）**：原 auto-recall 以**最后一条主人消息的字面**为查询词——用户说「最近压力好大」，三个月前提过的「考试」不会被召回，因为字面里没有那个词。实测反例（2026-09-15）：重启唤醒消息注入的全是与当轮意图无关的历史条目。

**语义**：注入查询 = **上下文重心**，而不是单条消息。

| 概念 | 定义 |
|------|------|
| 重心（centroid） | 最近 K 轮消息文本的**加权词项集合**：越新的轮次权重越高（逐轮衰减），最新一条额外加成（锚点） |
| 衰减 | `turnWeight = decay^(距最新轮次的距离)`，缺省 `decay = 0.7`；最新一轮再乘 `anchorBoost = 2.0` |
| 词项 | 复用检索层**同一套**分词（CJK bigram + 停用词过滤）——**判据单一真源**，不得各写一份 |
| 权重上限 | 每轮内同一词项只计一次（防单条长消息主导）；保留权重最高的 `maxTerms = 24` |
| 兜底 | 无历史（首轮）或无有效词项 ⇒ **退化为原行为**（以单条消息为查询）——零回归是硬约束 |

**加权打分**：`score = Σ_t w_t × (标签命中 3 / 标题命中 2 / 正文命中 1)`；未给加权词项时走原路径（`query` 字符串）。

**命中率度量（可观测）**：侧车轨迹已按 `source` 记 `recall`（我主动查）与 `auto`（系统注入）两类；`memory_health` 汇总报出**注入次数 / 主动检索次数 / 命中条目数 / 最近注入时刻**——「环境」是否真的建起来了，看这个比值，不看感觉。

### 5.11 提案日志契约（v0.7 · 让提案有历史）

**动机（借鉴 VCPToolBox 的梦境审批：提案落盘、可回看、可拒绝）**：`memory_audit` 的提案原本只活在一次工具返回里，无法回答「我当时提了什么、后来做了什么、对不对」。

**落点**：`<DSH_HOME>/memory-audit-proposals.jsonl`（与用量轨迹同族的侧车；**只追加 / 吞错 / 按体积轮转**，绝不改条目）。

**两类记录（同一文件，可按 id join）**：

| kind | 何时写 | 关键字段 |
|------|--------|---------|
| `audit` | 每次 `memory_audit` 运行 | `atMs` / `role` / `weights` / `summary`（各档条数与字符）/ `candidates`（前 20：id/bucket/score/chars） |
| `action` | `forget` / `update` 成功时 | `atMs` / `action` / `id` / `reason?` |

**用途**：`audit` ⋈ `action` = 「提案被采纳/否决」的样本 ⇒ 权重校准（§10 U8 第 ④ 项）的前提。**它只记事实，不评判**——校准是后续的事。

**与 A31 的关系（必须说清）**：`memory_audit` 仍是**只读工具**——不写记忆库、不刷新 `accessedAt`；写的是**侧车观测文件**（§5.22 观测层：吞错、不阻塞主流程）。A31 的判据是「存储文件内容 + `accessedAt` 不变」，本契约不与之冲突；新增验收见 A50。

### 5.12 压缩流水线证据层（v0.8 · 让「为什么这个桶没压」可判）

**动机（2026-09-15 实测暴露）**：跨条目巡检发现库级结构异常——`日概要 2026-09-13` / `日概要 2026-09-14` / `周概要 2026-W37` **全库 grep 无**（原料存在、单位已结束，§5.6 明写「含历史缺口回填」），而**根因不可判**：本流水线此前只有 `console.log` / `console.error`，宿主 logger **不落盘**（AGENTS.md §5.22 规则 1）⇒ 五问里的 ③「断在哪一段」答不了。按 §5.22「先补证据层，再修业务逻辑」，v0.8 只补证据，**不改压缩行为**。

**① 判定命名化（`timeline.ts: explainCompressions`，判据单一真源）**

| 判定 | 含义（= 原有 `continue` 短路顺序，逐条命名） |
|------|--------------------------------------------|
| `not-ended` | 单位未结束（`range.end > now`）——条目仍可能追加 |
| `no-sources` | 无**非归档**原料（归档条目不参与压缩） |
| `already-summarized` | 已有同层概要（幂等，不重复压） |
| `pending` | 待压缩 |

- `findPendingCompressions` = `explainCompressions(...).filter(pending)` 的**投影**——禁止两处各自维护一套判定（§5.22 判据单一真源）。
- 语义等价性由既有 A10/A11/A12 用例 +A56 同源断言共同保证（重构不改行为）。

**② 侧车轨迹（`<DSH_HOME>/memory-compress-trace.jsonl`）**

| phase | 何时写 | 关键字段 |
|-------|--------|---------|
| `scan` | 每轮 `compressPending` 的**首轮**（后续轮是链式推进的中间态，会掩盖全貌） | `candidates`（候选桶数）/ `pending` / `skipped`（**非待压**判定分布）/ `sample`（逐桶 `<level> <bucket> <decision>`，上限 `MAX_SAMPLE=40`） |
| `unit` | 每个压缩单元 | `level` / `bucket` / `reason` / `archived`（归档条数）/ `chars` / `durMs` |
| `end` | 每轮收尾 | `units`（本轮 compressed 数）/ `totalMs` |
| `error` | 单元抛错（**先落证再原样上抛**，不改控制流） | `level` / `bucket` / `message` / `durMs` |

每条记录由装配层补齐 `atMs` + `trigger`（`lazy` = 访问记忆时补压 / `periodic` = 周期补压）——压缩器**不需要知道谁触发了它**。

**③ 只读读数面**：`memory_health` 增报「压缩流水线」段（扫描轮数 / 压缩单元数 / 最近待压数 / 非待压判定分布 / 非待压候选样本前 8 条）——**五问一条命令可答**（§5.22 规则 2）。

**纪律（对齐 §5.22）**：观测**绝不反噬主流程**——落盘走通用 `appendJsonl`（只追加 / 吞错返回 `false` / 超限轮转 `.1`）；`sample` 截断；sink 缺省不给 ⇒ **行为零差异**（A59 断言压缩结果逐字段一致）；开关 `audit.compress_trace`（缺省开，1 MB 轮转）按**每个 workspace 自己的** `memory.yml` 生效。

**反定位**：不解释语义（不判断「这条该不该进概要」）｜不做压缩质量的自动裁决（那是 §10 U9 的口径问题）｜不落盘正文（只落 id/计数/耗时/判定）。

### 5.13 auto-recall 质量门契约（v0.10）

**注入条件（三条同时满足才注入）**
1. 命中中存在**本会话尚未注入过**的条目（`filterFresh`；全部命中都是旧的 ⇒ **不注入**，零 token 浪费）
2. 命中的 **top1 分数 ≥ 30**（`worthInjecting` 门槛；**仅 auto-recall 路径生效**）
3. 渲染后文本非空

**打分（v0.10 起）**
```
score = Σ base × idf(term)      base ∈ { 标签 3, 标题 2, 正文 1 }
idf   = log(1 + N / (1 + df))
泛词门：df ≥ 50 且 df/N > 10% 的词 ⇒ idf 置 0（不参与打分）
```

**边界（诚实声明）**
- 门槛 30 由 **9 个查询**的分布定出（无指向 8.4/18.4/25.0 vs 有指向 38.2–106.3，间隔 25–38）——**非充分统计**，出现 25–38 区间查询需重新校准；传 0 可关闭该门。
- 去重集为**进程内存态**：web 重启即清空 ⇒ 重启后首轮会重新注入一遍热点记忆（**有意为之**——重启后上下文感知重置）。
- `recall` 工具**不受任何一门约束**：主动检索返回全部命中；门槛只服务「自动注入」这一侧。

### 5.14 时效维契约（v0.15 · 论文 Fresh at Decision, Stale at Action）

**论文**：*Fresh at Decision, Stale at Action: Routing New Information to LLM Decisions Already Made*（arXiv:2610.18126v1 · 15 页）。

**它解决的问题**：我写下一条结论时（`td`）它是新鲜的；**未来的我执行它时**（`ta`）可能已经失效——中间的执行间隙 Δact 里世界会变。论文证明这叫**新鲜度天花板**：

```
Pr[f 在行动时仍成立] ≤ e^(−λ_f · Δact)      （Prop. 1；多依赖时 ≤ exp(−Δact · Σλ_fk)）
```

⇒ **决策时取证再充分也突破不了它**（`ta − tv = Δfresh + Δact`，而 Δfresh ≥ 0 ⇒ 第一因子 ≤ 1）。剩余风险只由两件事决定，精度分解 `A = (1−π)K + π[ρS + (1−ρ)L]`：**路由** ρ（新信息能否在修订死线前到达决策）与**判断**（读得对不对）。路由器取舍有闭式：`A′−A = π(ρ′−ρ)(S−L) + (1−π)(K′−K)`——判断强 ⇒ 召回主导；判断弱 ⇒ 暴露主导。

**论文实测（三个读数直接决定了本版设计）**：

| 索引什么 | 决定性消息到达率 | 带进的噪音 |
|---|---|---|
| 决策文本 | 37.5%（换名字）/ 12.5%（上游实体） | 17 |
| **全部背景事实** | **100%** | **89** |
| **决策时写的观察条件** | **92.2%** | **20** |

⇒ **少而准**才划算（每个被索引的事实都成了一个匹配点）。另：残余误差主要是**时间判断**——Ministral 8B 与 Qwen3-235B **放弃全部**「变更已结束」的决策（保留 0.0%）；把这个检查做成**规则**（time filter）把 Qwen3-235B 从 85.3% 提到 **92.0%**。

**契约**：

| 字段 | 语义 | 写入 | 读取 |
|------|------|------|------|
| `reviewAfter` | **复查死线** `YYYY-MM-DD`（UTC 日） | 接受 `+7d` / `+2w` 相对写法，**折算成绝对日期**后落库（存相对值会让「何时到期」随读取漂移） | 与当前时刻比 ⇒ 三档 `expired` / `due-soon`（≤7 天）/ `fresh`；**未设 ⇒ 不判** |
| `watchFor` | **观察条件** 1–8 条短句（**什么新信息会让这条失效**） | 与死线同一时刻——**这是唯一时机**（我记得为什么这样判断；事后再补就想不起当时在等什么） | 印在 recall 结果行尾 = **免费路由**；速览/auto-recall 注入**不印**（字节预算） |

判据同 `subject` / `grounding`：**两条路径分流**——工具参数走 `parseReviewAfterArg` / `parseWatchForArg`（**fail-loud**），服务通道与读历史数据走 `normalizeReviewAfter` / `normalizeWatchFor`（**容错**，认不出即不设）。

**三条刻意不做（每条附理由；理由不写下来会被「与论文对齐」改掉）**：

1. **不建独立 router** —— 论文的 router 服务于「持续新闻流 × 大量开放决策」；而**我的输入流就是我的注意力**，`recall` 每轮都在把相关记忆拉到眼前 ⇒ **recall 本身就是路由器**。建一个「写入时拿新条目比存量观察条件」的独立 router，在没有实测尸体前只是**无谓的暴露**（P3：每次投递都是放弃正确决策的机会）。⚠ **可推翻**：若实测出现「该失效的条目从没被 recall 到」这条尸体 ⇒ 补 router。
2. **不设默认死线**（判断不代填 · AGENTS.md §2.4）—— 主人偏好该永久有效、环境坐标该 30 天一看，同一个默认值会**同时错两边**。**空是常态，填是例外**。
3. **到期 ≠ 作废，只 = 该重看**（同 `grounding` 的立场：移植**可见性**不移植拦截）—— 不做自动失效、不做自动归档；到期后由我核实 → `update` 改内容并**续死线或清除**（这也是 `EntryPatch.reviewAfter` 必须允许转移的原因：否则死线一旦过期就永远消不掉）。

**形态白名单（安全侧判据）**：读路径的兜底解析**只认** `YYYY-MM-DD` 与 ISO 时刻两种形态，**不**把任意字符串交给 `Date.parse`——后者接受自然语言日期与斜杠格式，会让「什么算合法死线」多出第二个真源。⇒ 判据：**宁可漏报，不可假报**（一个会喊狼来了的标记等于没有标记）。

**渲染纪律**：只凸显**需警觉**的档位（`expired` / `due-soon`）；`fresh` 与未设死线**留空**（同 `subjectTag` / `groundingTag` 的「标记要挑着打」）。触发点三处：`recall` / `memory_browse` 结果行首（在最前——「这条结论可能已不成立」比「这是谁的提议」更该被第一眼看见）、`memory_stats` **单列一行** verdict（它是动作入口，挤在括号里会被读成一堆数字）、**速览与 auto-recall 注入**（每轮都跑的最热路径）。

**退出判据**：新写入里带 `reviewAfter` 的比例长期（≥2 周）≈ 0 ⇒ 该维度没被用起来 ⇒ **撤或改形**，不留死字段充数。

**残留风险（不得粉饰）**：字段可选 ⇒ **不填就得不到保护**（与 `grounding` 同型的失败面）；对策只有「工具描述里写清何时填」+ `recall({ staleness: 'expired' })` 审查入口两条。

### 5.15 预检与来源归属契约（v0.19.1 · 两处「先知道再动手」）

缺口来自同一次夜里的两次悬空。

**① `remember.dryRun`：把「先搜再写」从纪律变成可执行的一步。** 旧形态是「写入时才报近重复」——预检不存在，纪律只能靠我先跑一次 `recall`。而 2026-11-02 实测：先 `recall` 搜「测试期望写错」返回 96 条，却**不含**真正的母条目 `8b074a6e`（标题「我的错误模式清单」与查询措辞零字面重叠），而随后 `remember` 把它报了出来 ⇒ **`recall` 的候选集与近重复检测器不同源**；拿前者做后者的事，恰好救不了「措辞不同、主题相同」这类它最该救的情形。

- 契约：`dryRun: true` ⇒ 跑**同一个**检测器（`findNearDuplicates`），返回 `similar[]`（`id — 标题（强度 N）`；v0.22 起附一行「节：小节标题 / …」，见 §5.15 的修订 24）与 `hint`，**不写存储、不写近重复侧车、返回里没有 `id` / `action`**。
- 位置在 `max_entries` 守卫**之前**：预检不写库，「库满」是提示（进 `hint`）不是拒绝——否则库满时连「会不会撞车」都问不出来。
- 欠账语义不变：预检不进欠账（它没撞库）；只有正式写入且未给 `similarDisposition` 才进 `memory_check`。

**② `transcriptiveUncited`：让「这条的权威归谁」在检索结果里可见。** 我读论文 / 做调研后写的记忆**读起来像我的结论**；危害不是「记了笔记」，是未来的我拿它当自己的判断用。

- 判据两问分开：标题是转述形态（`精读|深读|调研|评估|论文：|review|调查|考据|考古`）**且**全文（标题 + 正文）找不到可核出处（arXiv 编号）⇒ 打 `〔转述型·无出处〕`。
- **有出处的转述不打标**：可核查的引用不该与无出处同等对待，否则标记变噪音、也就没人再看得见它。
- 触发点两处：`recall` 与 `memory_browse` 的结果行首（同一事实在两个界面必须长得一样；`tests/schema-parity.test.mjs` 的键差集判据当场抓到了「只加一侧」）。
- 判据真源在 `src/origin.ts`，与 `scripts/memory-origin-audit.mjs` 的**同一组正则**由 `tests/origin.test.mjs` 逐字比对锁住——这是「一份判据 + 一个机械的对齐检查」，不是两份真源（脚本要在 clone 上直接跑，故不能反向 import 编译产物）。
- 已知边界（不得读成「已判准」）：判不出「实际是不是转述」（标题写「评估」而结论全自产的会被误标）；只认 arXiv 编号（引网页 / 书 / 口述的转述漏标，不是误标）。⇒ 标记是**提示着去看**，不是判决。

### 5.16 事实生命周期契约（v0.24 · `validAfter` / `supersededBy` / `supersedes`）

**缺口**（主人 2026-11-17 诊断）：「压缩摘要是散文，T1→T2→T3 的更新关系在压缩时会被抹平」。库里已有五个时效字段（`grounding` / `provenance` / `watchFor` / `reviewAfter` / `staleness`），仍缺两格：**这条结论从何时开始为真**，以及**谁替代了谁**。既有的 `archivedReasonType='superseded'` 只是**归档状态**（这条怎么没了），**不含对象**（被谁顶掉了）。

**三个字段**（语义正本在 `src/succession.ts` 文件头）：

| 字段 | 答什么 | 关键纪律 |
|------|--------|----------|
| `validAfter` | 这条结论**从何时开始成立** | **无默认值**——省略 = 不知道，**不是**「等于 `createdAt`」（判断不代填）；与 `reviewAfter` 正交（一个向后看、一个向前看） |
| `supersededBy` | 这条**被哪一条**替代了（单个 id） | 字段存在即已过时；**旧条目绝不删除**，recall 默认仍返回，只打「⚠ 已过时 → 被 `<前8位>` 替代」 |
| `supersedes` | 这条**替代了哪些**（id 列表） | 只记**直接**替代对象，**不递归展开祖先** |

**只保留一层**（刻意设计，不是简化）：A→B→C 时 `A.supersededBy=B`、`B.supersededBy=C`、`C.supersedes=[B]`，**不**把 C 填成 `[A, B]`。记忆库不是事件溯源库——完整版本树会让 recall 越跑越慢（每次命中都要展开链）、命中越排越散（同族多代同时占服务位）、旧值持续挤占注意力。**一层足够回答「我手上这条是不是最新的」**。

**两侧同写，单一写入点**：替代关系是**成对**的边 ⇒ `memory_supersede` 是唯一写入口，`update` 工具刻意**不暴露**这两个字段。开成单侧可写，库里迟早出现「只标了一侧」的边——而单向边在审计时读作「这条已被替代」（真）却查不到「被谁替代」（丢了），正是本维度要修的那种抹平。

**可见性落在四处**（同一事实不许在两个界面长得不一样）：`recall` / `memory_browse` 结果行（已过时标记放**最前**——它比「已过期」更硬：过期只表示该核实，替代表示已有更新版本顶掉它）+ 两个注入路径（启动速览 `inject.ts` / auto-recall `auto-inject.ts`，都只打**过时标记**，不注入 `validAfter`——注入有字节预算，只在少数情形改变判断的信息让位给内容）。

**写入边界（同一个坑第九次）**：`index.ts::entrySchema` 必须同步声明这三个字段，否则 storage-domain 在写入边界**静默剥掉**而写入**仍返回成功**（v0.12 `aliases`、v0.13 `subject`、v0.14 `grounding`、v0.15 `reviewAfter/watchFor`、v0.16 `cue`、v0.21 `provenance`/`archivedReasonType`、v0.23 `project/taskId`）。

**已知边界（不得读成「已保证」）**：
- **单测看不见宿主校验这一跳**：`execute()` 直接调用会绕过 harness 的 output schema 校验 ⇒ 「schema 声明是否齐全」只能靠**结构性判据**（`tests/succession.test.mjs` A4 的消费者清点 + `tests/schema-parity.test.mjs` A117 的逐层比对）与**重启后实调**共同证明。
- **无事务原语**：`kv` 没有批量事务，两侧是两次 `put`。实现先**全查全验**再顺序写，并在旧条目写入失败时**响亮报错并列出已写/未写**（半成品边不许静默）。代价：极端并发下仍可能残留半成品，需人工核对后 `overwrite: true` 补齐。
- **同标题陷阱**：新结论若与旧条目**同标题**，`remember` 的 L2/L3 同标题合并会把它写进旧条目（回执 `action=merged`），于是库里只有一条、无从建立替代关系 ⇒ 工具会报「自引用」并说明这条成因。



- **能力 ≠ 沙箱**：本能力不隔离、不鉴权、不加密；能读到存储文件的人都可改记忆。
- **角色维度是视野管理，不是安全边界（v0.5 诚实声明）**：工具参数 `role` 可自述、记忆文件可被能读盘的人改写、共享记忆对所有角色可见——它防的是「不小心看见」与「默认继承上下文」，**不防蓄意越权**。要真正的隔离（幽灵隔间 / 多租户）必须配**独立 `DSH_HOME`**（另见 AGENTS.md §5.26 G1/G8）。
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
| `roles` 段非法（未知键 / 空角色名 / 非字符串预设映射 / 非法 kinds） | **拒绝**：抛 `MemoryConfigError`（fail loud，同 I8） |
| 条目被角色策略剔除 | 静默不出现在结果里（准入 ≠ 报错）；`memory_relate` 对视野外 id 返回 `ok:false`；`update`/`forget` 对视野外 id 报「未找到…（当前视野内）」 |
| 会话无 id（无法判定身份） | 放行：按 `roles.default` 处理（保守可见全），理由随 `memory_health.roleReason` 透出 |

### 5.17 证据坐标契约（v0.25 · `evidenceRefs`）

**缺口**（AML 差距表 §5.2 / §5.3，2026-11-18 实测）：库里 1765 条活跃条目，**事件级可追溯 0%**——有会话 id 的 81.8%，但没有任何条目能指到「这次对话的哪个位置」。方案把「来源可追溯率 100%」列为不可妥协门槛，而当时的载体是 `author.sessionId`（答「谁写的」）与 `source.reason`（答「为什么生成」），**都不答「能回到哪里」**。

**一个字段**：`evidenceRefs: string[]`，每条是**编码坐标**（格式在 `src/evidence.ts`，`|` 分隔）：

| 编码 | 含义 | 精度 |
|------|------|------|
| `session\|<会话id>\|<seq>` | 会话 + 事件号 | 能回到「写这条时对话进行到哪」 |
| `session\|<会话id>\|` | 只有会话 | 只到会话级 |
| `compaction\|<会话id>\|<压缩id>` | 压缩事务 | **事件级**（`compactionId` 唯一标识一次压缩） |
| `derived\|<定位>` | 派生来源（如 `supersedes:<id>`） | 由引用方定义 |

**为什么存字符串而不是对象**（这是本维度的关键实现决定）：本仓 schema DSL 的 `required` 只支持字段级，**嵌套对象在归一化时会被提成对象级 `required`**、让 `defineTool` 泛型推断退化（TS2719/TS2322），并让维度常量的 `deepEqual` 判据（A4）与写入边界真 parse 判据（A113b）当天变红——2026-11-18 实测：对象形态提交后这两条守卫立刻拦下，改平级字符串后全绿。⇒ 与本仓既有维度（`supersedes` / `watchFor`）同形：**平级标量数组**。

**写入面（只盖得出来的坐标，不猜）**：
- `remember` → `session|<会话id>|<seq>`。`seq` 来自 `index.ts` 订阅 `session/event` 维护的「每会话最新 seq」——`ToolRunContext` 里没有事件号（实测），所以只能观察。**拿不到就只盖会话级**，绝不写假坐标。
- `compaction-sink` → `compaction|<会话id>|<压缩id>`：压缩事件自带坐标，比 seq 更精确。
- 合并路径（同标题 / 同 key）按**并集**累积（上限 8）：同一结论可能有多个出处，只留新来的等于丢证据。

**可见性**：`recall` / `memory_browse` 结果行印一个 `⚓<类型>@<事件号>`（只印最有力的一条，行内不铺列表）；结构化结果里是完整数组。**存量条目没有该字段——不回填、不猜**，读取侧按 `[]` 处理（省略 = 不知道，不是「无出处」）。

---

### 5.18 内容分类契约（v0.26 · `memType` 七类 · 方案 §3.1）

**缺口**（AML 差距表 §3.1）：库里的 `kind` 只有 fact / knowledge / episodic / summary 四值，且混了**粒度**（原始/概要）与**性质**（事实/知识），无法回答「这是哪一类馆藏」。方案 §3.1 要求七类：情景 / 语义 / 程序 / 画像 / 项目 / 关系 / 运行；§10.1 的保留策略、§8.4 的任务路由、§4 的知识组织都以它为坐标系。

**一个字段**：`memType`（单值，七选一，**无默认值**）。与 `kind` **两轴正交且不互相推导**：`kind` 是存储与粒度轴（去重/压缩/体检的既有契约，一条不动），`memType` 是内容性质轴。两轴在「情景」上语义重叠（`kind=episodic` 与 `memType=episodic` 常同时成立），那是重叠不是第二真源——**不从 kind 自动生成 memType**（那是判断）。

**为什么没有默认值**：「这条属于哪一类」是判断。给默认值 = 让机制替主体断言，而错了不会有任何东西报错。⇒ 未给 = 未分类，统计单列 `unclassified`，**不折进任何一类**（同 `grounding` 的「省略 = 不知道」）。

**七类不互斥**：方案原文「一条原始事件可以产生多个相互关联的记忆资源」⇒ 本字段是**首要归类（单值）**，多归属留给未来的类型化关系（§4.4），不做成数组——数组会让「首要归类」这个判断消失。

**可见性**：`recall` / `memory_browse` 的元数据方括号里印 `·语义` 这类短标（未分类留空）；结构化结果带 `memType` 键；`memory_stats` 出 `byMemType`（七类 + unclassified，**之和 == total**）；`recall`/`browse` 支持按类过滤（未给 = 零拷贝透传；**未分类条目在任何取值下都不返回**）。

**写入边界（同一个坑第十一次）**：`index.ts::entrySchema` 必须同步声明该字段，否则 storage-domain 静默剥掉。

---

### 5.19 空间归属契约（v0.27 · `space` 四空间 · 方案 §3.2）

**缺口**（AML 差距表 §3.2）：`scope` 是**存储分区**（数据放哪个库、谁看得见），答不了「这条知识属于谁的疆域」。方案要求四空间（个人 / 项目 / 领域 / 系统）**且各自独立授权**——没有独立授权维，四空间就只是四个标签。

**一个字段**：`space`（单值，四选一，**无默认值**）。四空间定义：

| 空间 | 装什么 | 判据（拿不准时问） |
|------|--------|------------------|
| `personal` 个人 | 关于我与主人的持久偏好、画像、关系 | 「这是关于**谁**的」——人或关系 |
| `project` 项目 | 某个工程的目标 / 进度 / 决策 | 「换一个项目还用得上吗」——用不上 |
| `domain` 领域 | 跨项目可复用的领域知识（期货口径、插件方法、论文方法） | 用得上 ⇒ 领域 |
| `system` 系统 | 运行环境锚点、工具失败原因、通道与凭据纪律 | 「这是关于**这台机器怎么跑**的」 |

**与 `scope` 的分工（防第二真源）**：`scope` 是存储与准入（键空间、路径、跨会话可见性），`space` 是知识归属（授权与检索的语义维）。**两者不互相推导**：项目 A 的技术决策可以存在 `global` 库而 `space=domain`（值得全局复用）；也可以存在项目路径下而 `space=personal`（关于我自己的偏好，只是当时在那个目录里写）。⚠ 不做「从 scope 推 space」的默认值——那是判断，代填等于让机制替我断言。

**独立授权（本维度的存在理由）**：`role` 策略新增可选 `spaces?: Space[]`；给了就只放行这些空间的条目。**fail-closed**：设了 `spaces` 的策略下，**未标注 `space` 的条目不放行**——「不知道属于哪个空间」不能当「所有空间都可读」。未设 `spaces` 的角色行为完全不变（既有角色配置零迁移）。

**可见性**：`recall` / `memory_browse` 结果行的元数据方括号里印 `〔个人〕` 这类短标（**有值才打**，未标注留空——同 `subjectTag` 纪律）；结构化结果带 `space` 键；`memory_stats` 出 `bySpace`（四空间 + `unclassified`，**之和 == total**）；`recall`/`browse` 支持按空间过滤（未给 = 零拷贝透传；**未标注条目在任何取值下都不返回**）。

**已知边界**：空间只做**视野管理**，不加密、不隔离存储——能读盘的人仍可读到全部条目（同 §5.8 角色维度的诚实声明）。真隔离要配独立 `DSH_HOME`。

**写入边界（同一个坑第十二次）**：`index.ts::entrySchema` 必须同步声明该字段，否则 storage-domain 静默剥掉。

### 5.20 生命周期契约（v0.27 · 六态 · 方案 §3.3）

**缺口**（AML 差距表 §3.3）：六态里 `archived`（`archived:true`）与 `superseded`（`supersededBy`）已有载体，**`pending` 与 `disputed` 无载体**，`deleted` 与「已归档」的**意图差别**也没记。

**存储只补没有载体的两态**：`status?: 'pending' | 'disputed'`（无默认值；未给 = 常态）。`deleted` 走**既有** `archivedReasonType: 'deleted'`（`forget` 的可选原因类型扩一值）——已归档条目本来就被检索默认剔除，再开一个「已删除」布尔位等于给同一件事两个真源，两者不同步时无人能判谁对。

**六态的唯一读取入口**：`lifecycleOf(entry)`（`src/lifecycle.ts`），优先级 `deleted > archived > superseded > disputed > pending > active`。派生而不存六值：`archived` / `supersededBy` 已被压缩链、检索、统计、渲染共同使用（§5.16 契约），再存一份会漂。⇒ **一个判断入口、一个来源**。

**各态行为（不写清就等于字段是死的）**：

| 态 | 默认检索 | 注入 | 渲染标记 | 进入方式 |
|----|---------|------|---------|---------|
| `active` 有效 | 可见 | 可注入 | 无 | 默认 |
| `pending` 待审核 | 可见（显式召回） | **不注入** | `⏳待审` | `remember({status:'pending'})` |
| `disputed` 存疑 | 可见 | 可注入 | `❓存疑` | `update({status:'disputed'})` |
| `superseded` 已被取代 | 可见 | 可注入（带过时标记） | `⚠ 已过时 → 被…替代` | 既有 `memory_supersede` |
| `archived` 已归档 | 默认剔除（`includeArchive` 可查） | 不注入 | `[已过时]` 等既有标记 | 既有 `forget` / 压缩链 |
| `deleted` 已删除 | 默认剔除（`includeArchive` 可查） | 不注入 | `🗑已删` | `forget({reasonType:'deleted'})` |

**为什么 `pending` 不进注入**：注入是**未经请求**到达我上下文的内容（auto-recall / 启动速览）。候选区的东西还没过审核，让它自己挤进上下文等于跳过了候选区这个设计本身。**显式召回是请求**，那时该看见它（带标记）。

**`disputed` 不算「已失效」**：它是**设计内的存疑**，不是过时。R7 的误用口径（A 档 = 返回时结论已不能用）不把它计入——否则「我特意标了存疑」会被自己的仪器罚一次。

**可见性**：`recall` / `memory_browse` 增 `status` 过滤（取值 = 六态名）；结果行前缀印上表标记；`memory_stats` 出 `byLifecycle`（六态之和 == total）。

**写入边界（同一个坑第十三次）**：`index.ts::entrySchema` 必须同步声明 `status`；`archivedReasonType` 的白名单要同步扩 `deleted`（否则 `forget` 传它会报未知取值）。

### 5.21 类型化关系契约（v0.28 · 方案 §4.4）

**缺口**（AML 差距表 §4.4）：`memory_relate` 按共享标签 / 标题 / 正文重叠算**统计相似**——它给的是线索，不是断言。库里没有「A 支持 B」「A 派生自 B」这类**有类型、有方向、有来源、有有效期**的边，实测 relations 覆盖率 0%。方案 §4.4 要求十种关系 + 四件元数据（来源 / 有效时间 / 方向 / 可信度）。

**关系是独立资源，不是条目的字段**：一条边的真值不随 A 或 B 的正文改写而消失，也不该由 `tags` 承载（标签无类型、无方向、无有效期）。⇒ 新表 `relations`（key = `<scope>:relation:<id>`），条目一个字段都不加。

**十种类型（封闭枚举，`src/relations.ts::RELATION_TYPE_SPECS` 是唯一真源）**：`belongs-to` 属于 · `related-to` 关联 · `supports` 支持 · `refutes` 反驳 · `sourced-from` 来源于 · `derived-from` 派生自 · `supersedes` 取代 · `participates-in` 参与 · `uses` 使用 · `depends-on` 依赖。每种类型声明 `label` / `inverse`（反读标签）/ `fromRole` / `toRole` / `note`（什么时候用它）。

**方向由类型定义**：没有「反向边」这种独立类型。读 `direction: "in"` 时同一条边换反读标签（「支持」↔「被支持」）——**同一事实不存两份**。

**四件元数据（方案 §4.4 明列）**：

| 元数据 | 字段 | 纪律 |
|--------|------|------|
| 关系来源 | `provenance` | **必填、无默认值**（master / web / self / measured）：这条边凭什么说是这样 |
| 有效时间 | `validFrom` / `validTo` | 答「该断言何时成立」，与 `createdAt`（我何时记下）不同；**过期 ≠ 作废** |
| 方向 | `from` / `to` + 类型 | 由类型的 fromRole/toRole 定义，没有第三种取值 |
| 可信度 | `confidence` | 0–1，**无默认值**：不给 = 未评估，不是 0 分 |

**有效期两个粒度（刻意不同，都撞过）**：纯日期 `YYYY-MM-DD` 视为「到那天结束为止」（含当日）；ISO 时刻 `T` 视为**左闭右开**（T 起不成立）。后者是为 `memory_unlink` 的即时退役——退役时刻写 `now`，「现在读」就必须已经不成立（单测实测：同一毫秒内读到刚退役的边）。

**一个事实一个归宿（三条硬约束）**：

1. **`supersedes` 不由 `memory_link` 写入**：替代关系已有 `supersededBy` / `supersedes` 两个字段（§5.16），唯一写入口是 `memory_supersede`（写两侧）。再存一条边就有两个真源 ⇒ `memory_link` 对 `supersedes` **拒写**并指向那个工具；读取侧用**派生视图**（`structuralEdgesOf`）从字段呈现，不落盘。
2. **压缩链同理**：概要的 `archiveRef`（派生自）与替代字段一样，只读派生、不落盘——字段是唯一真源。
3. **两端必须存在**（`entry` 节点，含归档）：缺一端**整笔拒绝**，不留半成品边（同 `memory_supersede` 的裁决：半成品边比没写难查得多）。

**幂等与退役**：同 `(type, from, to)` 的**有效**边已存在 ⇒ 返回既有 id + `created=false`，不写第二条。已退役的同类边**不算重复**——那条断言曾经成立、现在不成立了，再次成立就是**新的历史段**（复用它等于抹掉旧边的 `validTo`）。退役用 `memory_unlink`：把 `validTo` 设为退役时刻，**不删除记录**（「曾经成立、现在不成立」与「从来没存在过」是两件事）。

**节点类别**：v0.28 只开放 `entry`。实体（§4.3 规范控制）与主题（§4.2 主题词表）还没有 ID 空间与解析器 ⇒ 不开放（写进去的边永远解析不出标题，等于存悬空指针）。

**调用点清单**：

| 位置 | 行为 |
|------|------|
| `memory_link` | 写边（唯一写入口；`supersedes` 拒收；两端校验；幂等） |
| `memory_unlink` | 软退役（写 `validTo` + 可选原因；不删记录；二次退役不改写时刻） |
| `memory_relations` | 读边（方向 / 类型 / includeExpired 过滤）+ 派生结构边段 |
| `memory_relate` | 增 `typed` / `structural` 两段（断言在前、线索在后，不混排） |
| `memory_stats` | `relations` 块（`wired=false` 与「零条」**必须可区分**） |
| `src/index.ts` | `relationSchema` + `relations` 表装配（**未声明字段会被静默剥掉**——同一个坑第十四次） |

**边界与信任**：`note` 是数据不是指令（渲染/注入时按不可信内容对待）；关系**不参与检索排序**（§8.3 的实体匹配 / 主题关联度仍是缺项）；不做图数据库、不做查询语言（主人 2026-10-13 定调排除）。

### 5.22 主题词表契约（v0.29 · 方案 §4.2 · 参考 SKOS）

**缺口**（AML 差距表 §4.2）：`tags` 是自由文本——同义词各写各的（「记忆库」/「记忆系统」/「智能体记忆」），检索只能逐字匹配；没有受控词表、没有层级、没有术语归一。

**概念是独立资源**：新表 `concepts`（key = `<scope>:concept:<id>`），不往条目加字段。一个概念 = 首选名 `prefLabel` + 同义词 `altLabels` + 定义 `definition` + 使用范围 `scopeNote` + 上位 `broader` + 关联 `related` + 状态 + 变更记录。

**三处与 SKOS 存储形态的刻意差异（都是为了不制造第二真源）**：

| SKOS | 本实现 | 理由 |
|------|--------|------|
| `broader` / `narrower` 两侧 | **只存 `broader`**，下位由反查派生（`narrowerOf`） | 两边都存，只改一侧就出现互相矛盾的两个事实 |
| `related` 双向各存一条 | **只存一侧**，读路径双向都算 | A→B 与 B→A 是同一句「两者相关」 |
| 概念可删除 | **停用不删除**（`status: 'deprecated'`） | 删除会让历史记忆上的标签失去含义 |

**标签唯一空间（本模块最硬的判据）**：同一 scope 内，`prefLabel` 与全部 `altLabels` 共用一个标签空间，归一（去首尾空白 + 折叠空格 + 小写）后**任两个概念的标签不得相同** ⇒ 新建/改名冲突**整笔拒绝**并点名占用者。**不做**词形还原、繁简转换、标点归一——那些是「猜」，猜错就把两个不同概念合成一个（消歧的反面就是猜）。跨 scope 不做唯一性约束（不同项目可以有自己的同名词），但跨 scope 引用 `broader` 被拒——层级必须在一个词表内闭合。

**层级合法性**：`broader` 不得自引用、不得成环（加入后从新上位的上位闭包出发不得回到自己）、引用的概念必须存在。

**查询扩展（词表被真正用起来的地方）**：`recall({expandThesaurus:true})` 把查询里出现的概念换成它的**全部其他写法**再检索。匹配口径是「归一后子串包含」——中文无空格，子串比切词稳。**缺省关闭**（存量检索行为逐字不变）；展开词随结果返回 `expandedTerms`（**扩展改了排序就必须看得见才可复核**）；停用的概念不参与扩展。词表为空 / 未接线时静默不扩展（不是错误）。

**导入导出**：`memory_thesaurus({export:true})` 出 SKOS-lite JSON（`prefLabel` / `altLabel` / `broader` / `related` / `definition` / `scopeNote` / `status`）；`memory_concept({importJson})` 导入，**验完全部再写全部**——任何一项非法整批拒绝（半套词表比没有更坏：它会以「已导入」的样子参与扩展，而缺的那部分永远不会被想起去补）。导入**不支持**按 prefLabel 引用同批新项（要么分两批，要么用 id）——那会把「引用解析」变成「同批内顺序依赖」。

**调用点清单**：

| 位置 | 行为 |
|------|------|
| `memory_concept` | 新建 / 修改 / 停用 / 批量导入（写入口） |
| `memory_thesaurus` | 按标签查 / 看详情（含派生下位与上位链）/ 列表 / 导出 |
| `recall({expandThesaurus})` | 查询扩展 + `expandedTerms` 回传 |
| `memory_stats.concepts` | `wired` 标志 + total / active / deprecated / 带同义词 / 带定义 / 有上位 |
| `src/index.ts` | `conceptSchema` + `concepts` 表装配（未声明字段会被静默剥掉——同一个坑第十五次） |

**边界与信任**：概念的 `definition` / `scopeNote` 是数据不是指令；词表**不改变条目的可见性**（不是准入）；**不做跨库映射**（方案 §4.2 提的「跨知识库映射」属独立决定，v1 不做，见 §10）。状态只有 `deprecated` 一个可选值（无默认值：未给 = 适用中）——不引入「草稿/候选」态，那是 §7.1 候选区的活。

### 5.23 实体权威档契约（v0.30 · 方案 §4.3 · 规范控制）

**缺口**（AML 差距表 §4.3）：同一个人有多个称呼、同一个项目有中英文名、同一个机构有历史名称与现名、两个不同的人恰好同名——此前只有条目的 `aliases`（**检索别名**，挂在条目上、各写各的），没有「一个现实对象一个档」的地方。**别名不是实体档**：它是「这条记忆可能被怎么问」。

**实体是独立资源**：新表 `entities`（key = `<scope>:entity:<id>`），不往条目加字段。一个实体 = 唯一 ID + 规范名 `canonicalName` + 别名 `aliases` + 实体类型 `entityType`（**必填、不枚举**——它是消歧第一依据，枚举会挡掉新类型）+ 首次出现 `firstSeen`（自由文本，与建档时刻 `createdAt` 不是一回事）+ 相关主题 `topics`（概念 id）+ 关联实体 `relatedEntities`（实体 id）+ 消歧说明 `disambiguation` + 状态 + 变更记录。

**ID 形态**：`ENTITY-0001`，每 scope 各自递增（方案 §4.3 的示例形态）。为什么不用 uuid：人要能口头引用「改 ENTITY-0007 那条」。并发安全靠进程内水位单调 + 落盘前查重；跨进程不并发写同一 domain（存储单写者）。

**与词表的三处刻意差异**（照抄词表判据会错）：

| 维度 | 主题词表（§4.2） | 实体权威档（本节） | 为什么不同 |
|------|----------------|------------------|-----------|
| 标签空间 | **唯一**：一个词只指一个概念 | **可多指**：两个实体可以同名 | 概念是主题（抽象），实体是现实对象——两个不同的人同名是现实 |
| 撞名 | 整笔拒绝 | 允许，但**必须给 `disambiguation`** | 拒绝会挡住真实的同名；无条件放行等于把消歧责任推给未来的自己 |
| 解析返回 | 唯一命中（`findByLabel`） | **候选列表 + `ambiguous`**（`resolveName`） | 判断型字段禁默认值：程序不替调用方挑 |

**归一函数与词表逐字同源**（`normalizeLabel`：去首尾空白 + 折叠连续空白 + 小写）。**不做**词形还原、繁简转换、标点归一——多走一步就是猜，猜错即把两个实体合成一个（消歧的反面就是猜）。

**合并是显式动作**：`mergeInto(旧档 → 存续档)` 把旧档的全部称呼并入存续档（旧规范名降为别名），旧档标 `status:'merged'` + `mergedInto` 指向存续档，**不删除**。旧写法解析归到存续档（这正是合并的目的），旧档同时作为 `merged` 命中出现（历史可解释）。三条 fail-loud：不能自合并；**合并目标不得是已合并体**（只保留一层，链式会让解析跟随多跳且中间态永远留坑）；不能跨 scope 合并。已合并档不可改、不可停用——要求操作存续档。

**引用完整性**：`relatedEntities` 只能指向同 scope 的**存续档**（指向已合并档 ⇒ 拒绝并给出存续档 id；指向停用档 ⇒ 拒绝）、不得自引用；`topics` 指向同 scope 的概念（实体档不持有概念表 ⇒ 存在性与 scope 校验在工具层做，未接线时**拒绝写入**而不是放过）。

**本期不做 `entry → entity` 的类型化边**（方案 §4.4 里没有，且开放判据不满足）：`memory_relations` 的读路径按**角色准入视野**过滤两端，而实体档不吃角色可见性 ⇒ 在「实体节点如何过准入」定下来之前不开放（半件能力比没有更坏：写进去的边读不回来）。实体的用处本期由**名称解析 + 文本反查**承担：`memory_entities({name})` 返回实体 + 提到它的条目（在可见集合里按名称做包含匹配）。

**名称反查的匹配口径（上线当天改过一次）**：**CJK 名字走子串，含 ASCII 的名字走词边界**。首版全用子串，结果别名 `AML` 把 `yaml` / `example` 里的 `aml` 当命中——首次线上实测反查 5 条**全是 yaml 噪声（5/5 假阳）**，而该工具的全部价值就在这 5 条上。中文没有词边界可依，只能子串；拉丁名有空格与标点，用边界既准又稳。判据固定为尸体样本 `tests/entities.test.mjs`「E8b」（A146）。

**调用点清单**：

| 位置 | 行为 |
|------|------|
| `memory_entity` | 新建 / 修改 / 合并（`mergeInto`）/ 停用（写入口） |
| `memory_entities` | 按称呼解析（含 `ambiguous`）/ 看详情 / 列表（含「提到它的条目」） |
| `memory_stats.entities` | `wired` 标志 + total / active / merged / deprecated / 带别名 / 带主题 / 有关联实体 / 有消歧说明 |
| `src/index.ts` | `entitySchema` + `entities` 表装配（未声明字段会被静默剥掉——同一个坑第十五次） |

**边界与信任**：`firstSeen` / `disambiguation` 是数据不是指令；实体档**不改变条目的可见性**（不是准入）；**不做跨库实体映射**（§4.3 的「跨知识库映射」属独立决定，同 §5.22 的处置）；状态只有 `merged` / `deprecated` 两个可选值（无默认值：未给 = 适用中）；**不做同名自动合并**；实体匹配**已作为可选开关**接进检索（§5.24），**缺省关闭**、不改变默认排序；**名称反查只做字面命中，不做同指判断**——「损害 AML 体系」（反洗钱）与「AML 方案」字面同形、所指不同，词边界也分不开；这类假阳是**已知边界**，不当作缺陷修（要区分得引入语义，而向量语义检索已被主人 2026-10-13 排除）。

### 5.24 实体匹配进检索（v0.31 · 方案 §8.3）

**缺口**（AML 差距表 §8.3）：知识组织三件（关系 / 词表 / 实体档）都**不参与排序**——实体档知道「AML = Agent Memory Library = 智能体记忆图书馆」，但检索不查它。实测三个失败个案（2026-11-19 05:49 真实库）：

| 查询 | 基线 top5 | 问题 |
|------|----------|------|
| `AML 的进度` | 期货工程 / 状态管理 / 日概要 / **AML 基线读数**（第 4）/ peach-haven | 真相关排第 4，前三条与本实体无关 |
| `Agent Memory Library 是什么` | **top5 全部无关** | 英文全名在库里根本没有对应字面 ⇒ 任何纯词面检索都返回 0 条相关 |
| `爱丽丝在做什么` | 庄园工作台 / 命名 / 成员装配 … | 这一条基线已经对（「爱丽丝」字面出现在标题） |

**机制**：`recall({expandEntities:true})` —— 工具层把查询解析成实体（走 `EntityStore` 的归一与词边界口径），把命中的实体作为 `entityMatches` 传给 `search.ts`；打分时**提到该实体的条目**加 `SCORE_ENTITY(2.5) × weight`。

**为什么不是「把别名塞进查询词」**（那是 `expandThesaurus` 的做法）：塞词只让**字面相同**的条目得分，而实体匹配要的恰是「同一个东西的另一种写法」——`AML 的进度` 要能找到写「智能体记忆图书馆」的条目，两串没有任何共同 token。

**权重 2.5 的定位**：低于标签/别名命中（3 —— 人工给的检索入口），高于正文命中（1 —— 内容里偶然的用词）；它是「同一指称」级别的信号，但不是人工标注。

**⚠ 效果未证明（这是本节最重要的一段）**：05:51 拿真实库（3076 条）跑同一批查询，**三个查询的 top5 一名未变**（`AML 的进度` 的命中实体条目仍第 4）。算术上讲清楚了原因：加成 2.5 分 vs top1 44.5 分 = **5.6%**，而中文长查询的分数由多个通用 bigram 的 IDF 累积而成，常数加成被淹没。⇒ 机制**已建、可开、有单测**（M1–M3），但「让真实检索变好」**没有读数支持**；权重与默认值必须等**有标注的查询集**（多金标、含别名问法）才能定——在那之前不许把它当默认、也不许报「§8.3 已解决」。

**调用点清单**：

| 位置 | 行为 |
|------|------|
| `recall({expandEntities})` | 解析查询 → 实体；命中时给 `entityMatches`，并回传 `matchedEntities`（**改了排序就必须看得见**） |
| `src/search.ts` | `SCORE_ENTITY` + `entityBonus`；`entityMatches` 缺省 = 零成本（连 hay 缓存都不构造） |
| `src/entities.ts::matchesName` | **唯一**的名称匹配口径（词边界 / CJK 子串），反查与检索共用 |
| `memory_entities` | 反查同样用它（同一个口径，避免两处漂移） |

**边界与信任**：`entityMatches` 由调用方解析 ⇒ `search.ts` 仍是纯函数（可离线测）；实体匹配**不改变可见性**（视野过滤在更早一步）；同形异义假阳（反洗钱 `AML`）在检索层同样存在，权重小使它通常不致命，但**不是零风险**。

### 5.25 检索噪声抑制（v0.32 · 方案 §8.3）

**缺口**：T3 标注集基线 P@5 **38.2%**（`docs/design/aml-eval.md`「T3 标注集基线」，2026-11-19 06:06 真库读数），11 个计分问法里 5 条只拿 0–2 命中。失败形状是**同一种**：真金标被**字面撞车**挤出 top5——查询里的虚词组合（`之后` / `怎么` / `是什么` / `是谁` / `有哪些` / `三件`）与大量无关文档的高频用词重合，而**长条目正文多点命中累加**盖过了话题对应的标题命中。

| 查询 | P@5 | 真金标名次 | 撞车字面 |
|------|-----|-----------|---------|
| `压缩之后怎么恢复上下文` | 0/5 | 第 7、第 8 | `之后` / `怎么` |
| `插件怎么发布` | 0/5 | 第 8 | `怎么` / `发布` |
| `爱丽丝是谁` | 1/5 | 第 7 | `是谁` |
| `知识组织三件是什么` | 1/5 | 撞车条目占 top5 | `三件`（另有「LuaN1ao 源码三件」） |
| `爱丽丝庄园有哪些成员` | 2/5 | 第 6 | `成员` |

**先诊断再动刀**（本节的方法纪律，有事故依据）：v0.17 加 BM25 长度归一就是跳过分数分解直接动刀，结果 out-of-sample 反而差 5.7 个百分点（`src/search.ts` 的 `BM25_B` 注释记着三次实测）。⇒ 任何噪声抑制方案落地前，必须先用 `explainRecall()` 在真库上**逐 token、逐字段**列出贡献，确认噪声来自哪些 token、哪个字段。**没有分解的改动不采纳**，哪怕总读数变好（分不清是机制对了还是别的项被顺带压了）。

**机制候选（一次只改一件，才可归因）**：

| 臂 | 改动 | 预期作用于 | 已知风险 |
|----|------|-----------|---------|
| E1 | 泛词门收紧（`GENERIC_MIN_DF` / `GENERIC_DF_RATIO`），或对 bigram 单独设门 | `之后` / `怎么` 这类虚词组合的 IDF | 小语料夹具里会误杀有区分力的词（现行 `GENERIC_MIN_DF=50` 就是为此设的） |
| E2 | `SCORE_TITLE` 2 → 3（与标签同级） | 标题即主题的条目 | 标题很长的条目（本库常见）命中概率也高，可能只是换一批人霸榜 |
| E3 | 单条目**正文贡献封顶**（按最强单 token 的倍数） | 长文档多点累加 | 真相关的长条目（压缩检查点）被压 |

E3 与长度归一的关键区别：长度归一是**连续缩放**（对所有条目按长度比例乘），封顶是**只砍超额部分**——「话题对、正文正常」的条目一步都不动。v0.18 关掉长度归一的分区读数（收益区 0:0、代价区 −11.7pp）说明连续缩放这条路已经证否，但封顶是不同的结构，尚未测过。

**判据（四条同时成立才算动过）**：

1. T3 P@5 高于 **38.2%**——11 题计分，每题值 9.09 个百分点，**至少 +1 题**才算有变化；
2. 7 条负对照问法（`entityNames=[]`、查询点不到实体）**不得变差**，其中 `期货工程现在什么状态` 必须保持 5/5；
3. 上表五条失败查询的真金标名次**必须进 top5**（第 7/8 → ≤5），只抬总分不算；
4. 口径**同一把尺子**：离线复现复用 `store.list({includeArchive:false})` 的检索面（1769），不手写过滤判据。

**调用点清单**：

| 位置 | 行为 |
|------|------|
| `explainRecall(entries, query)` | 诊断入口：返回逐条目的 `{score, terms:[{term, idf, field, contribution}]}`；**与 `recallEntries` 走同一打分函数**，不复制一份打分逻辑 |
| `recallEntries` | 打分路径不变；`tuning` 新增的旋钮缺省值必须复现现行行为（逐位相同） |
| `tokenizeQuery` | 查询分词唯一真源；噪声抑制若动 token 集合，必须在此处动，不许在打分侧另写一套过滤 |
| `scripts/aml_retrieval_eval.mjs` | T3 读数与多臂消融的唯一入口（`--tuning` 传臂参数） |

**边界与信任**：噪声抑制只改**排序**，不改可见性（视野过滤在更早一步）；它不解决**内容缺口**（`Agent Memory Library 是什么` 是库里没有定义条目，单列不进均值，见 T3 标注集 `excludeFromMean`）；`explainRecall` 是**诊断视图**，其输出不参与生产排序，也不改变 `total` 语义。

**实测读数（2026-11-19 06:19 · 真库 1770 条 · 12 个问法 · 基线已按 gold 补录修正）**：两臂都跑完了，**都不采纳**。

| 臂 | 改动 | P@5 | R@20 | 负对照（`期货工程现在什么状态`） | 裁决 |
|----|------|-----|------|------------------|------|
| 基线 | — | 36.4% | 94.7% | 5/5 | — |
| A | `longToken='drop'` | 36.4% | 94.7% | 5/5 | **中性**（机制对、效果零） |
| C | `multiFieldCap=true` | 30.9% | 81.2% | 3/5 | **有害，否决** |
| D | `genericFactor=0.3` | 33.3% | 95.1% | 5/5 | 净零（`压缩之后` 9→4、`插件怎么发布` 5→1） |
| E | `genericFactor=0.5` | 33.3% | 95.1% | **3/5** | 净零，且违反负对照判据 |
| F | 封顶 + 门槛 0.03 | 30.0% | 82.8% | 3/5 | **有害，否决** |

（D/E/F 三档的池子是 1773 条、基线 33.3%，与 A/C 的 1770/36.4% 不是同一把尺子——原因见下方「基线漂移」。）

**诊断比读数更重要**（这就是本节要求先分解的原因）：噪声来自两条结构缺陷，不是权重。① **多字段累加**：同一个词在四个字段各命中一次就各加一份（3+3+2+1 = 9×IDF）——错答案靠「恢复」一个词拿 22.7 分。② **罕见 ≠ 重要**：中文 2-gram 的罕见大多是跨词边界垃圾（`后怎` df=6 → 16.61 分），而真信号词「压缩」df=200（11.3%）**被泛词门整词归零**——金标「三载体分工」11.63 分里 **11.63 全部来自 `缩之` + `后怎` 两个垃圾项**。

**臂 C 给出一条通用判据**：任何**压缩分数动态范围**的改动都会与本仓的**相对分门槛**（`top1 × 0.08`）耦合——封顶让分差变小 ⇒ 门槛砍掉更多条目 ⇒ 候选池缩小 ⇒ 真金标连「被看见」的机会都变少。读数变差时先怀疑这对组合，不是相关性本身。

**下一臂的方向（已排除三件，且问题推到了别的层）**：① ~~区分「用户输入的整词」与「派生的 bigram」~~——**已证否**：中文查询没有空格，用户「整词」要么是整句（无信息量）、要么是英文词，**所有中文实词都是以 2-gram 形式进来的**，所以这条等于「只给英文词降权」，在中文上不成立。② ~~bigram 的 IDF 上限~~、~~多字段封顶~~——都属于「压缩分数动态范围」，两次实测都坏（候选池被相对分门槛砍穿）。③ **真正的下一件是「意图识别」**（方案 §8.2 的缺失项）：`genericFactor` 已证明降权能救回主题词（`压缩之后` 首金 9→3、`插件怎么发布` 5→1），但**同一次降权也把疑问句骨架抬了回来**（`什么` / `状态` / `现在`），于是负对照 `期货工程现在什么状态` 80%→60%，净值零。区分「主题词」与「句式成分」靠词频做不到（`压缩` 与 `状态` 都高频）⇒ 必须先识别查询的**句式意图**。④ 主题关联度（概念参与排序）排在它之后。

---

### 5.26 查询意图识别：剥离疑问句式骨架（v0.33 · 方案 §8.2 的「意图识别」）

**缺口**：§5.25 的五档实验留下一条方向性读数——泛词门降权（`genericFactor`）**确实救回了主题词**（`压缩之后怎么恢复上下文` 首金 9→3、`插件怎么发布` 5→1），但同一次降权把**疑问句骨架**（`什么` / `状态` / `现在`）也抬了回来，负对照 `期货工程现在什么状态` 因此 80%→60%，净值零。⇒ 区分「主题词」与「句式成分」**靠词频做不到**（两者都高频），只能按句式判定。

**机制**：`recall({ dropQuestionFrames: true })` —— 查询命中疑问/指代短语时，**短语自身的 2-gram 不进查询词项**（不参与 df / IDF / 打分）。

**为什么只剔短语、不剔短语之外的词**（本节的边界）：`什么状态` 是「疑问短语 + 名词」结构，切开它需要分词器；无分词的猜词会误杀主题词（`状态` 在「状态管理和进度管理是重中之重」里就是主题）。⇒ 第一版只处理**可以字面枚举**的部分，宁可少剔。未命中任何短语时静默退回现行行为。

**判据（可证伪，四条同时成立）**：① 在同一份**冻结快照**上 P@5 高于该快照的基线；② 负对照 `期货工程现在什么状态` 不变差；③ `压缩之后怎么恢复上下文` 首金 ≤ 5；④ 其余问法无一条变差。⚠ 必须用 `--snapshot=<同一份文件>`——否则读数会被库内新增条目带偏（见 `docs/design/aml-eval.md` 的「基线漂移」「冻结快照」两段）。

**调用点清单**：

| 位置 | 行为 |
|------|------|
| `tokenizeQuery(query, tuning)` | **唯一**分词入口；`dropQuestionFrames` 只在这里生效（与 `longToken` 同一处，避免两处分词） |
| `QUESTION_PHRASES` | 短语表（可枚举、可单测）。**新增一条短语必须带来一条判据**，不许凭感觉加 |
| `recall` / `explainRecall` | 经 `tuning` 透传，缺省关（零行为变化） |

**边界与信任**：意图识别只改**查询侧的词项集合**，不改条目内容、不改打分公式、不改可见性；它**不解决内容缺口**（那是库里没写过）；短语表是中文疑问句式的**最小集合**，不声称覆盖全部——覆盖不到时静默降级为现行行为，不报错、不假装识别成功。

**实测读数（07:54 · 冻结快照 1775 条 / 12 问法）**：两档都**不采纳**。

| 档 | P@5 | R@5 | R@20 | 关键变化 |
|----|-----|-----|------|---------|
| 基线（快照） | 33.3% | 63.7% | 95.1% | — |
| `dropQuestionFrames` | 33.3% | 63.7% | 95.1% | 仅 `知识组织三件是什么` 首金 3→2 |
| `tokenizer=segmenter` | 28.3% | 61.5% | 81.8% | `压缩之后` 首金 **9→5**（进 top5）· `爱丽丝庄园` 40%→60% |
| `segmenter` + 门槛 0.04 / 0.02 | 28.3% | 61.5% | 81.8% | 与不降门槛**逐位相同** |

**两件都证否，但各留下一条可搬的读数**：① `dropQuestionFrames` 零变化——**垃圾 bigram 是跨词边界的**（`么恢` 来自「怎么恢复」两个词的交界），剔短语原理上剔不到它；② 词边界分词**确实让真金标进了 top5**（9→5，与 07:51 手工切词的探测一致），但查询词项从 10 降到 4，R@20 掉 13.3 个百分点，且**降门槛救不回来**（0.04 与 0.02 逐位相同）⇒ 掉的是「根本不命中」而不是「被门槛砍掉」⇒ **2-gram 的广覆盖有一份真实的召回价值**。

**⇒ 结论（词面层到此为止）**：七档实验没有一档超过基线，且每一档的失败机制都不同 ⇒ 需要的是**重写打分器**（分词 + 按字段重标定权重 + 重新标定阈值，作为整体交付、带见习期与回滚点），不是再调一个旋钮。

---

### 5.27 打分器 v2：三层计价（v0.34 · 设计正本 `docs/design/aml-scorer-v2.md`）

**机制**：`recall({ scorer: 'v2' })` 换一条打分路径（**缺省仍 v1**，零行为变化）。

- **L1 精确层**：`Intl.Segmenter` 词边界命中，字段权重 **2/2/1.5/1**（v1 是 3/3/2/1），IDF **不吃泛词门**、改乘 `1/(1+df/N)` 平滑降权。
- **L2 覆盖层**：整句 2-gram 命中（不在 L1 里的），× `coverageWeight`（缺省 0.35，**实测必须标定**）。
- **L3 噪声层**：由停用字 / 疑问字参与的 bigram **不参与打分**（`isNoiseBigram`，字符级——整词级剔不到跨词边界）。

**为什么噪声判据必须是字符级**：噪声的来源就是跨词边界——`么恢` 来自「怎么恢复」两个词的交界，任何整词表里都查不到它。v0.33 的 `dropQuestionFrames` 是整词级、实测零效果，原因就在这里。

**实测（09:51–09:53 · 冻结快照 1775 / 12 问法）**：

| `coverageWeight` | P@5 | R@5 | R@20 | `压缩之后` 首金 |
|---|---|---|---|---|
| 基线 v1 | 33.3% | 63.7% | 95.1% | 第 9 |
| 0.35（设计值） | 31.7% | 67.1% | 89.3% | **第 1** |
| 0.5 | 31.7% | 67.1% | 91.0% | 第 2 |
| **0.7（最优）** | 33.3% | **68.8%** | 91.0% | 第 2 |
| 0.9 | 33.3% | 68.8% | 91.0% | 第 4 |

**判定：未通过设计文档的五条判据**——P@5 与基线持平（要求 >）、R@20 91.0% 低于 95.1%（要求 ≥）。达标的是判据 4（`压缩之后` 首金第 2 ≤ 5）。**未开默认，`scorer` 仍缺省 `v1`。**

**但它有一条真实收益**：**六条问法的首金全部前进**（`压缩之后` 9→2、`插件怎么发布` 5→1、`爱丽丝是谁` 2→1、`知识组织三件是什么` 3→2、`AML 的进度` 4→3、`期货工程` 2→1），R@5 **+5.1pp**；代价是 R@20 −4.1pp。⇒ 它把「top5 更准」做到了。✎ **R@20 的代价已做实**（2026-11-19 10:08，`--dump` 逐条归因）：v2 相对 v1 **唯一新增的漏召回只有 1 条**（`压缩之后怎么恢复上下文` 的金标「三载体分工」），而它是 **v1 的假阳性**——v1 靠 body 引用短语派生的 `缩之`(df=4)/`后怎`(df=7) 把它撞进 top20，v2 用词边界分词结构性消除这类 bigram 后该信号消失，金标落到第 27（该条 body 不含「恢复」，只剩四个泛词可用）。⚠ 原「代价是候选池更窄」的说法**已被逐条归因证否**：12 题里其余 11 题的 R@20 一格未动。

**两处设计值必须标定（实测已证）**：`coverageWeight` 0.35 让 `期货工程` 的 P@5 从 80% 掉到 20%（首金第 1、其余四个金标全出 top5）——写死设计值会把「首金更准」的收益变成「多金标题崩掉」的代价。

**调用点清单**：

| 位置 | 行为 |
|------|------|
| `recall({ scorer: 'v2' })` | 换打分路径；**缺省 `v1`**，与不传 tuning 逐位相同（A152 / V1 单测） |
| `scoreEntryV2` | L1 + L2；L3 在 `tokenizeForV2` 阶段就剔除（不进打分） |
| `isNoiseBigram` | 噪声判据唯一真源（字符级），导出供单测 |
| `tuning.coverageWeight` | L2 系数，缺省 0.35，**必须标定** |
| `tuning.fieldAgg` | L1 字段聚合，缺省 `'sum'`；`'max'` 只取**最靠入口的那一次命中**（治「一个词四字段命中就拿 6.5 倍」）。⚠ 与 `multiFieldCap` 的读数**不可互推**：后者在 v1 + 泛词门下测过且有害，v2 无泛词门，累加是它唯一的放大机制 |
| `tuning.smoothPower` | L1 平滑幂次，缺省 `1`；`0` = 不做平滑、直用 IDF（幂零次恒 1，不特判分支） |

**边界与信任**：v2 只改打分，不改过滤 / 可见性 / 结果投影；加权路径（`weightedTerms`）仍走 v1（上下文重心与三层计价的交互未设计）；`NOISE_CHARS` 是**虚词字表**，误剔主题字的代价是「那类查询排序变差」，用 V3 单测守住已知实词样本。

### 5.28 来源实体契约（v0.35 · 方案 §5.2 · 设计正本 `docs/design/aml-source.md`）

**缺口**：现有三种来源载体，但**没有一种承载「来源」这个对象**——内联 `source{sessionId,seq,reason}` 只有坐标与一句理由；`evidenceRefs`（v0.25）是证据的精确坐标字符串；`sourced-from` 边（v0.28）连到库内节点。三者都回答「在哪」，不回答「谁提供 / 多可靠 / 什么权限」。方案 §5.2 的七项里只有 Location 与 Time 有落点。

**来源实体**：独立表 `sources`，不嵌条目（与 `entities` / `concepts` / `relations` 同构）。

| 方案要求 | 字段 | 契约 |
|---|---|---|
| Source ID | `id` | `SOURCE-0001`，每 scope 递增，**可口头引用**（与 `ENTITY-0001` 同构） |
| Type | `type` | **必填**，取 `master` / `web` / `self` / `measured`——与条目 `provenance` **共用同一枚举**，不立第二套词表 |
| Location | `location` | **必填**：`session:<id>#<seq>` / `url:<地址>` / `file:<路径>` / `compaction:<id>#<cid>` |
| Time | `collectedAt` | 首次采集时刻；后续复用时**不变**（它不是「最后访问时间」） |
| Owner | `owner` | 谁提供：主人 / 我 / 外部系统。与 `type` **正交**——「我实测到的」与「网页给的」提供方不同，两种切分不互相推导 |
| Reliability | `reliability` | **无默认值**。不填 = 未标注，不是「中等」。取值形态未定，见设计正本 §8 |
| Permissions | `permissions` | 预留，**本阶段只存不判**：§11.1 四类权限未建，来源层不发明第二套授权语义 |

另三条不复用方案的七项：`label`（人读说明，可空）· `status`（`active` / `retired`，停用不删除）· `revisions`（只留最近 3 条快照，与条目同口径）。

**不变量**：

- **`type` 与 `provenance` 正交，不是同一件事的两个真源**（v0.35.1 裁决，2026-11-19）：`provenance` 答「这条结论**归属谁**」（谁说的算），`type` 答「这个来源**是什么性质的东西**」。两者不互相推导、**不要求相等**——我读主人给的方案、得出他没说过的结论，就是 `provenance=self` + 引用 `type=master` 的来源（结论是我的，依据是他的）。绑定相等会把**知识生产最日常的形状**判成错误，且没有替代路径（§8.3 同一种病：把正常当错 ⇒ 判据没有分辨力）。
- **错与不全分两档**：引用**不存在**的来源是错（**拒**，数据完整性不是语义判断）；**有依据没标归属**、**引用已停用来源**是不全（**过 + 回执点名**）。后者尤其不能拒——「那条依据已被撤销 / 下线」本身就是要记录的事实。
- **不自动补全**：给了 `provenance` 不因此自动建 Source——那会产生大量空壳来源，把「独立来源」变成噪声。
- **存量不回填**：现有条目的 `source{}` 不批量转实体，不猜当时没记的信息。代价一起报：来源覆盖率**短期不因本能力上升**。

**调用点清单**：

| 位置 | 行为 |
|------|------|
| `memory_source`（新工具） | 建 / 改 / 停用来源；id 递增、状态流转、变更记录 |
| `memory_sources`（新工具） | 按 id 直查 · 按 `type` / `owner` / `status` 过滤 · 反查引用它的条目 |
| 条目 `sourceIds?: string[]` | 可选引用；**不给时行为与现状逐位相同**（内联 `source{}` 与 `evidenceRefs` 照旧可用） |
| `memory_stats.sources` | 出 `total` / `byType` / `byStatus` / 未标注 `reliability` 计数 |
| `RELATION_NODE_KINDS` | 节点类别从 `entry` 扩到 `source`（现在只有 entry） |

**判据（S1–S6，实现时并入 §7 的 A 表）**：S1 id 递增唯一且跨 scope 不干扰 · S2 `reliability` / `permissions` 不填时保持未标注（`stats` 单列，不并入默认档）· **S3 归属与依据正交**（v0.35.1，成对判据）：`provenance=self` 引 `type=master` 来源 ⇒ **通过**、两字段各自独立落盘、**无提示**（负向对照——提示在正常路径亮就是噪音）／有依据无归属 ⇒ **通过 + 点名**／引已停用来源 ⇒ **通过 + 点名**／悬空 id ⇒ **拒**／来源库未接线 ⇒ **拒** · **S3f 写入形态返回值不越 `output.schema`**（宿主 `additionalProperties:false` 会整条拒收，而单测直接调 `execute()` 看不见这一跳）· S4 按 Source 反查恰好列出全部引用方 · S5 不给 `sourceIds` 时逐位相同 · S6 停用不删除（`retired` 后不进候选，按 id 直查仍可回，引用方不被改坏）。

**边界与信任**：通用边界见 **§6**；本节特有的两条——`permissions` 只存不判（来源层不发明第二套授权语义），不做跨库来源映射。

### 5.29 遗忘传播契约（v0.36 · 方案 §10.4 · 设计正本 `docs/design/aml-forget.md`）

**它回答什么**：删一条记忆时，**除了那一条还有哪里要动**。方案列了九处，本插件只拥有其中一部分——所以这一节的第一个产出不是「能力清单」，是**边界**。

| 方案的面 | 本插件载体 | 拥有 | 动作 |
|---|---|---|---|
| 原始来源 | 宿主会话事件日志 | **否** | 不传播，反馈里点名 |
| 提炼出的事实 / 自动摘要 | `entries`（`kind=summary` 的 `archiveRef`） | 是 | 概要是独立结论，**不改 `archiveRef`**（那是压缩历史）；只报引用条数，是否重压交人判断 |
| 知识图谱关联节点 | `relations` | 是 | **退役**（写 `validTo`）不删除——「它曾经成立」与「它从没存在过」是两件事 |
| 用户画像 | `entities` + `memType=profile` 条目 | **部分** | 无 `entry → entity` 边 ⇒ 定位不到来源，反馈点名这条缺口 |
| 全文索引 / 向量索引 | 无独立索引 / 定调不做 | **N/A** | 删正文即删索引 / — |
| 缓存 | `memory-access-trace.jsonl`（`{atMs, ids[]}`） | 是但**无内容** | **不处理**——删它只毁用量归因，不减少任何暴露面 |
| 备份 | 仓库历史 / 快照层 | **否** | 不传播，反馈里点名 |

**三种操作**（`forget.mode`）：`entry`（缺省·既有三选择器）/ `topic`（`topicTags` · `topicMemType` · `topicSpace`，至少给一个）/ `all`（`confirm` 逐字等于 scope）。⚠ 三种**都是软归档**——本插件删得掉 `entries` 表，删不掉宿主日志与备份层；单方面 purge 会让人以为「已删干净」，**声称删干净的伤害大于不做**。

**凭证**：`memory-forget-certificates.jsonl`，字段是白名单（`ForgetCertificate`），**不含标题 / 正文 / 来源**。可证伪：拿被删条目的 title / body 去 grep 凭证，命中即违反（F3）。

⚠ **最小化的边界（诚实标注）**：工具保证**自己不主动带内容**，但 `reason` 是调用方自由文本——若调用方把标题写进 `reason`，最小化仍是破的，而工具拦不住（它无法判断哪几个字算「内容」）。⇒ 纪律在调用侧：**写 `reason` 时描述「为什么删」，不复述「删的是什么」**。同理，`ids` 是随机 uuid 不含语义，但如果某条目的 id 被人为改成可读串，那一点也破了。

**调用点清单**：

| 位置 | 行为 |
|---|---|
| `src/forget.ts::planForget` | 纯函数：给定三处数据 → 逐面计划；`UNOWNED_SURFACES` 随每次结果带出（副本，不是共享引用） |
| `forget` 工具 `execute` | 选目标 → 算计划（**dryRun 与实跑共用同一份**）→ 归档 / 退役边 / 写凭证 |
| `deps.recordForget` | 侧车追加（`index.ts` 按 `DSH_HOME` 构造）；缺省 ⇒ 不写、回执不给 `certId`——「没写」与「写了空的」必须可区分 |
| `render` | 四段：结果行 / 传播面（面×条数×动作） / **未覆盖面** / 凭证 id |

**判据 F1–F6**（`tests/forget-propagation.test.mjs`，纯函数 10 条 + 端到端 5 条）：F1 缺省 `mode=entry` 行为不变 · F2 逐面完整（`access-trace` 恒 0 且必在列表里）· F3 凭证最小化 · F4 未覆盖面必报且带原因 · F5 主题选择器 dryRun 命中集合 == 实跑 · F6 全删 `confirm` 逐字匹配。

**边界与信任**：见 **§6**；本节特有两条——凭证是**旁证**（只追加 / 吞错 / 按体积轮转，永远不能成为故障源）；`mode=all` 是动数据的高危路径，恢复只能靠 `includeArchive`，故 `confirm` 护栏不可绕过。

---

### 5.30 操作者审计流契约（v0.37 · 方案 §11.4 · 设计正本 `docs/design/aml-audit.md`）

**它回答什么**：「谁在什么时候对这一条做了什么」——尤其是**权限拒绝**。`role.ts::admitsEntry` 原本是布尔函数，拒绝被压成 `false`，条目静默消失；于是「权限违规 = 0」不是读数而是**不可测**。本节的第一价值不是「记录谁干了什么」，是**让拒绝从布尔值变成可读的事件**。

**八类 → 五个动作**（按「消费者需要区分什么」定，不按方案条目数定）：`write`（① 谁写）· `update`（④ 谁改，含 `supersede` / `merge`）· `forget`（⑦ 删除）· `link`（知识组织变更，方案未单列）· `permission`（⑥ 权限使用，**只在拒绝时**记）。② 来源 / ③ 谁加工 / ⑤ 谁调用 由既有载体承载（`sources` 表 / `compress-trace` / `access-trace`），本流不重复；⑧ 异常访问**不新造事件类型**，由 `findBursts` 在读取侧算簇。

**侧车边界**：`memory-actor-audit.jsonl`。与三条邻居的分工是硬边界——`access-trace` 记读（本流**不记读**）、遗忘凭证记**内容面传播**（本流只补「谁发起的、成没成」）、提案日志记「打算做什么」（本流记「做了什么」）。

**最小化**：字段白名单（`sanitizeActorAuditRecord` 在**写入前**裁剪，不靠埋点自觉）；`target` 只有 `id` / `ids` / `count` / `scope`——**无正文、无标题、无查询词**；`code` 只放判据码或短枚举，用户给的 `reason` 归凭证与 `archivedReason`；`ids` 截断到 20 条而 `count` 不截断（数组截断只影响可读性，计数是汇总口径）。

**只记异常面**：放行**不记**（放行是默认）；`forget({dryRun})` **不记**（没改变任何东西）；`memory_link` 幂等命中与 `memory_unlink` 二次退役**不记**。判据一句话——**审计的触发条件 = 状态确实变了，或确实被拒了**。权限拒绝的埋点只挂在主检索面（`recall` / `memory_browse`）：`gatherReadable` 被十五处共享，每处都记会让它变成没人读的洪水。

**三个零必须分清**：`wired=false`（未接线，读不到）· `wired=true, total=0`（接了线但还没有任何事件，**不是零违规**）· `total>0, rejected=0`（有动作、无拒绝）。三种在 `memory_trail` 的 render 与 `memory_stats.audit` 块里各有文案。

**动作簇是信号不是裁决**：键是「会话 + 动作」（跨动作合并会把「正常干活」读成「失控」）；只给计数与首末时刻，**不贴「异常」标签、不告警、不阻断**——判断归人（§1.3 禁自动决策）。

**调用点清单**：

| 位置 | 行为 |
|---|---|
| `src/actor-audit.ts` | 纯函数：白名单裁剪 / 解析 / 汇总 / 过滤 / 簇；外加一个与 `access-trace.ts::readAccessIndex` 同构的读函数（吞错，不可读 ⇒ `undefined`） |
| `src/role.ts::rejectReason` | 布尔判定改为返回判据码（`R1-kind` / `R2-space` / `R3-shared` / `R4-read`）；`admitsEntry` 成为它的布尔形态（**等价，零回归**） |
| `src/role.ts::filterRoleView` | 过滤 + 拒绝计数与分布；`applyRoleView` 是它的薄包装（同源，分叉就会有一边在说谎） |
| `src/tools.ts::audit` | 统一埋点：`atMs` 与 `actor` 由它填（三要素来自会话头，**不许各调用点自造**）；吞错，未接线是 no-op |
| `deps.recordAudit` / `deps.readAudit` | 侧车写 / 读；`index.ts` 按 `DSH_HOME` 构造，工具层不知道 dshHome |
| `memory_trail` | 读工具（明细 / 汇总 / 簇）；`wired=false` 显式报「读不到」而不是报零 |
| `memory_stats.audit` | 体检入口的读数块——**没有它，审计流永远没人看**（这决定本能力是否空转） |

**判据 A162–A166 · 测试 28 条**（`tests/actor-audit.test.mjs`；全家 611 + 89，1 skip）。尸体验证：把白名单裁剪改成原样返回、把拒绝计数写死 0 ⇒ **4 条红**（A1 / A2 / R2 / E5），恢复后 26/26 绿——判据有分辨力，不是假绿。

**边界与信任**：见 **§6**；本节特有两条——审计流**只覆盖本插件的动作**（宿主日志、文件写入、插件装卸都不在视野内，拿它证明「一切操作可追溯」就是撒谎）；拒绝总数是**下界**（只在主检索面记，其余派生取数被拒不记）。

---

### 5.31 双时态契约（v0.38 · 方案 §9.3 · 时间维度管理）

**它回答什么**：一条记忆涉及**四个不同的时刻**，任何一个缺失都会让判断错位。方案只说三轴（发生 / 进入系统 / 失效），本库里实际是四件——因为「发生」在语义类与情景类知识上落点不同。

| 字段 | 答什么 | 谁写 | 现状 |
|---|---|---|---|
| `createdAt` / `updatedAt` / `accessedAt` | **事务时间**：我何时记下 / 改过 / 最近读过 | 系统自动 | ✅ v0.1 |
| `occurredAt` | **事件时间**：这条描述的事情**本身何时发生** | 我显式给 | 🆕 v0.38 |
| `validAfter` | **适用起点**：这条结论**从何时开始成立** | 我显式给 | ✅ v0.24 |
| `expiry` | **失效时刻**：这条**到何时不再成立** | 我显式给 | 🆕 v0.38 |

**为什么 `occurredAt` 与 `validAfter` 不能合并**（本节最容易被「对齐」掉的一处）：`validAfter` 答「这条结论从何时**适用**」，`occurredAt` 答「这件事**何时发生**」。一条**情景**记忆（`memType=episodic`）没有「生效」可言，只有发生时刻；一条**语义**结论（`semantic`）的核心是适用范围，不是被谁在什么场合说出。⇒ 两者是**不同 memType 的主轴**，不是同一轴的两个精度。三条实例：

| 记忆 | `occurredAt` | `validAfter` | `createdAt` |
|---|---|---|---|
| 「主人 11-15 21:00 定了 Project State Manager 是事实来源」 | 11-15 21:00 | 11-15 | 11-19（我今天才追记） |
| 「今天下午 3 点开会」 | 今天 15:00 | —（事件无「生效」） | 今天 09:00 |
| 「我在 11-19 得知主人 11-17 说过『不需要 RAG』」 | 11-17 | 11-17 | 11-19 |

**为什么 `expiry` 与 `reviewAfter` 不能合并**：`reviewAfter` 是**复查死线**（提醒维：我该在什么时候重看），过期**不等于作废**——这是 v0.15 写死的立场。`expiry` 是**失效时刻**（事实维：这条到此时不再成立），过期**就是**不能当事实用。两者可同时存在且日期不同：「这条 12-31 失效，但 9-30 就该核实」——一个触发「去查」，一个触发「停止使用」。压成一个字段，等于把「提醒」和「结论有效性」当成一回事。

**为什么 `expiry` 与 `supersededBy` 不能合并**：`supersededBy` 表示**被另一条记忆顶掉**（有替代者、可追溯）；`expiry` 表示**时间到了就不成立**（无替代者）。「今天下午 3 点开会」3 点后失效，但没有新条目取代它。

**三条刻意不做**：

1. **过期不改生命周期**。六态是 §5.20 定的，且「过期」不属于任何一态——它是**派生标记**，不是状态迁移。把过期自动判成 `archived`，会把「时间到了」和「我决定不再用它」两种意图混成一个动作。
2. **不做自动归档 / 自动删除**。过期只让它在读与注入时被标记、在体检里作为证据行出现；**处置仍归人**（§1.3 禁自动决策）。
3. **不做历史回溯查询**（"查 11-15 那天库里是什么样"）。那需要版本快照，本库只有 `revisions` 3 条；双时态的**记录侧**先落地，回溯侧等有真实需求再说。

**过期的消费面（判据：这字段让哪个动作变可能）**：

| 面 | 行为 |
|---|---|
| `recall` / `memory_browse` 渲染 | 打 `⌛已失效` 标记；与 `⚠已过时`（被取代）、`⏳该复查`（reviewAfter）**三种标记互不混淆、可同时出现** |
| 注入（`inject.ts` / `auto-inject.ts`） | **标记但保留**（与 `supersededBy` 同处理）：剔除会让「我记得有这件事」变成「完全不记得」，而错的是使用方式不是存在性 |
| `memory_stats.expiry` | 三档：`active` / `expired` / `unset`（之和 == total） |
| `memory_audit` 证据行 | 已失效条目在候选里**列出 `⌛已失效`**，但不自动改档（判据归人） |

**命名纪律（踩过就不要再踩）**：`staleness` 三档里已有 `expired`（= 复查死线已过）。新维度**不许复用这个词**——过滤参数用 `invalidated`（`true` = 只看已失效），统计键用 `expiry`。两处同名会让使用者（首先是我）必然把「该重看」读成「已失效」。

**存入与派生分开**：`expiry` / `occurredAt` 是**存储字段**（我写时给的事实），「是否已过期」是**派生值**（`expiry < now` 现算）——不预存档位，否则与读取时刻脱钩（同 `staleness` 的教训：`reviewAfter` 也只存日期、档位由渲染层现算）。

**判据 A167–A174**（`tests/temporal-dual.test.mjs`，12 条）：T1 解析（日期/ISO 都收，相对写法与 2026-02-30 fail-loud）· T2 两种日期解释方向相反（`occurredAt` 当日起点 / `expiry` 当日末刻）· T3 区间校验（失效早于生效 ⇒ 抛；相等允许）· T4 过期是**派生**：同一份数据在不同 `now` 下档位不同 · T5 三种标记可同时出现且互不吃掉 · T6 三档计数之和 == 条目数 · T7 过滤（未给档位 ⇒ 零拷贝）· T8 四个字段互不推导、缺省就是缺省 · T9 `expiry` 与 `validAfter` 冲突 ⇒ **写入被拒** · T10 update 三态 + 按**修改后状态**校验区间 · T11 过期**不改生命周期**（条目仍 active，只是打标记）· T12 `expiryState` 与 `staleness` 两个筛子互不干扰。尸体验证：把 `expiryStateOf` 写死返回 `active` ⇒ **6 条红**（T4/T5/T6/T7/T11/T12），恢复后 12/12 绿。

**边界与信任**：见 **§6**；本节特有两条——`occurredAt` 是**我声明的事实**，机制无法验证（写错了没有任何东西会报错，只能靠 `evidenceRefs` 回原文核）；过期**不删除任何东西**，它只改读法。

### 5.32 七类保留策略契约（v0.39 · 方案 §10.1 · 让 `memType` 产生后果）

**定位**：让已建的七类维度**改变行为**，而不是只多一个字段。方案 §10.1 要求「不同记忆类别采用不同保存期限」，本节把那张表变成可断言的参数与档位修正规则。**动机是实测出来的**：真分母 1770 条人工写入条目里，`memType` 覆盖率只有 **1.1%**（对照 `aliases` 47.5% / `cue` 36.3% / `watchFor` 32.5%）——分界不是新旧，是「填了有没有后果」。所以本节的验收目标不是「提高覆盖率」，是「让填了会改变什么」。

**反定位**：不改 `classify()` 的既有四档判据（§5.9）。那一层回答「这条值不值得继续占位置」，与类别无关；本节是它的**后置修正层**——先出基础档，再按类别调整。理由是可证伪性：「未分类条目逐字不变」只有在「不动底层」的前提下才可断言（R3）。

**回退口径 `effectiveMemType(entry)` —— 三档 `source` 可辨，不猜**：

| 情形 | 结果 `type` | `source` |
|---|---|---|
| `entry.memType` 存在 | 该值 | `explicit` |
| 缺，且 `kind='episodic'` | `episodic` | `derived-from-kind` |
| 缺，且 `kind='fact'` | `semantic` | `derived-from-kind` |
| 缺，且 `kind='knowledge'` 或 `'summary'` | `null` | `unknown` |

只有**语义同构**的两处允许推导：`kind=episodic` 与 `memType=episodic` 是同一个词的两种写法，`kind=fact`（事实）与 `semantic`（语义记忆）在方案 §3.1 的定义里指同一类东西。`kind='knowledge'` 可被语义 / 程序 / 运行 / 项目 / 关系五类中的任一类解释——**推不出就不推**，这是 §6「不猜」的同一条纪律：字段本身不默认，读取口径显式标出来源。

**七类策略表（`RETENTION_POLICIES`）**：

| 类别 | `decayHalfLifeDays` | 类别修正（在基础档上） | 理由码 | 方案 §10.1 原文对应 |
|---|---|---|---|---|
| `episodic` | 30 | age > 90 且基础档 `KEEP` ⇒ **`DEMOTE`** | `E-decay` | 根据历史价值、用户授权和保留政策决定 |
| `semantic` | 180 | 有 `expiry` 且已失效 ⇒ **`REVIEW`** | `S-expired` | 有效期内持续使用，失效后修订或归档 |
| `procedural` | 120 | 有 `watchFor` 且 `reviewAfter` 已过且基础档 `KEEP` ⇒ **`REVIEW`** | `P-verify` | 定期验证，工具和环境变化时重新评估 |
| `profile` | 永不衰减 | 基础档 `ARCHIVE` / `DEMOTE` ⇒ **`REVIEW`** | `F-hold` | 长期保存但允许用户纠正和撤回 |
| `project` | 90 | 无修正（本版无「项目结束」信号，跟随项目生命周期无从判） | — | 按项目生命周期保存 |
| `relational` | 120 | 无修正（关系已由 `relations` 表承载，条目层不独立判） | — | 随实体及关系的变化更新 |
| `operational` | 14 | age > 14 且无 `watchFor` 且基础档 `KEEP` ⇒ **`REVIEW`** | `O-stale` | 结合工具版本和环境状态管理 |
| `unknown` | — | **零修正**（逐字保持基础档） | — | — |

`decayHalfLifeDays` 本版**只用于理由行披露**（写进 `reasons` 供人核），**不参与检索排序**——§5.25 的教训（十余个独立旋钮全部证否）说明任何改排序的改动都必须单独取证，本节不搭车。

**硬约束（三条，均可断言）**：

1. **只往「更需要人看」的方向推**：类别修正只能沿 `KEEP → DEMOTE → REVIEW` 方向走，**永不把 `REVIEW` / `ARCHIVE` 拉回 `KEEP`**。修正层的职责是提示「这一类该按另一套节奏看」，不是替我裁决安全。
2. **`unknown` 零修正**：未分类条目的档位与 v0.38 逐字相同（R3）。这是向后兼容的唯一保证——没有它，899 条 `episodic`+`fact` 的推导会在上线当天一次性改掉全库体感。
3. **不写库**：跑 `memory_audit` 前后存储文件字节级一致、`accessedAt` 不变（继承 §5.9）。

**消费面（判据：这层让哪个动作变可能）**：

| 面 | 行为 |
|---|---|
| `memory_audit` 候选的 `reasons` | 类别修正命中时追加理由码（`E-decay` / `S-expired` / `P-verify` / `F-hold` / `O-stale`）；**未命中时不出现**（R6：正常路径不噪音） |
| `memory_audit.retention` 段 | `byEffectiveType` / `bySource` / `policyApplied`（改档计数）+ `notes[]`——「类别修正到底改了谁」可核 |
| `memory_stats.retention` 块 | `byEffectiveType`（七类 + `unknown`）/ `bySource`（三档）/ `needsAction`（各类该看一眼的**信号**条数） |
| ⚠ **`needsAction` ≠ `policyApplied`（两个数回答不同问题）** | `needsAction` 答「有多少条该按类别节奏看一眼」，`policyApplied` 答「有多少条的档位**真的被改了**」。二者不相等是常态而非缺陷：线上实测（2026-11-19 15:06）`needsAction.episodic=47` 而 `policyApplied=0`——那 47 条基础档**已是 `ARCHIVE`**，而修正层不把 `ARCHIVE` 降回 `DEMOTE`（硬约束 1）。⇒ **两个数必须分开印、各自标口径**（R11）；把它们并列成一个「处理了 N 条」会自己制造疑问 |
| ⚠ **两处分母不同（刻意，不是漂移）** | `memory_stats.retention` 吃**全量**（含归档），`memory_audit.retention` 吃**本次集合**（默认剔归档、跳过冷存档）——与两处 `byMemType` / `bucket` 的既有口径一致。所以同一时刻 stats 报 `needsAction.episodic=47` 而 audit 报「（无）」是正常的：那 47 条是**已归档**的老情景记忆。⇒ 读这两个数之前先问「谁是分母」；**R7 的「逐字段相等」只对同一批输入成立**，不是对「同一时刻的两个工具」成立 |
| `forget({ tier })` | 读的是**修正后**档位（它重跑 audit）；效果是 `tier=ARCHIVE` 不再含 `profile` 类——这是修正层的安全副作用，不是特例，也不额外实现 |

**判据 R1–R11**（`tests/retention.test.mjs`）：

| # | 判据 |
|---|---|
| R1 | **类别真的改变档位**：同一条目只改 `memType`（其余字段逐字相同），最终档位 / 理由码不同——`profile` 的 `ARCHIVE` 被改成 `REVIEW`、`episodic` 的老条目从 `KEEP` 降到 `DEMOTE` |
| R2 | **回退三档可辨且不猜**：`explicit` / `derived-from-kind` / `unknown` 各自可判；`kind='knowledge'` 且无 `memType` ⇒ `unknown`（不硬塞进任一类） |
| R3 | ★**零回归**：`unknown` 类条目的档位与修正前逐字相同（同一批夹具对照，档位 + `reasons` 全等） |
| R4 | **画像永不自动归档**：`profile` 类在 audit 结果里 `ARCHIVE` / `DEMOTE` 计数为 **0**（只能 `REVIEW`） |
| R5 | **计数自洽**：`byEffectiveType` 七类之和 + `unknown` == total；`bySource` 三档之和 == total（无遗漏、无重复计数） |
| R6 | **正常路径不噪音**：显式分类 + 未触发任何策略 ⇒ `reasons` 里不出现类别判据码 |
| R7 | **两处同口径**：`memory_stats.retention.byEffectiveType` 与 `memory_audit.retention.byEffectiveType` 在同一输入下逐字段相等（第二把尺子 = 造出两个真源） |
| R8 | **只读仍成立**：跑 audit 前后存储文件字节级一致、`accessedAt` 不变（类别层不得破 §5.9 硬约束） |
| R9 | **判据码自洽**：五个码各自可触发，且理由行**点名它自己**（只看散文、拼不回判据码的文案不合格） |
| R10 | **时间语义**：边界是严格大于（恰好 90 天不触发）· 未设 `expiry` 是「不知道」不是「还没失效」· 写了 `watchFor` 就不按时间催（我已设好锚点） |
| R11 | ★**信号数与改档数可区分**：`needsAction` 有读数时 `policyApplied` 仍可为 0，且条目档位不变——两个数回答不同问题，**并列成一个「处理了 N 条」会让读数自己制造疑问**（线上实测 47 / 0 就是这个形态） |

**边界与信任**：见 **§6**；本节特有**三条**——① `effectiveMemType` 的推导**不是**给条目补字段（存储里 `memType` 仍为空，只有读取口径不同），所以它不能用来「事后声称覆盖率达标」；② `profile` 永不自动归档**只约束自动建议**，我仍可显式 `forget({id})` 归档任一条目；③ **`E-decay` 的可达性由基础档参数决定**（实测出来的耦合）：缺省 `audit.archive_min_age_days = 14`，所以 age > 90 且无 `role` / `refs` 的条目基础档**已经是 `ARCHIVE`**，而修正层不把 `ARCHIVE` 降到 `DEMOTE`（硬约束 1）⇒ `E-decay` 实际只对**有归属或承重**的老情景记忆生效。这不是缺陷（老而无归属的情景本就该归档），但改 `archive_min_age_days` 时必须连带重看本节——**调大它会让 `E-decay` 覆盖更广**，而这两处改动的耦合不会报错。

---

## 6 · 边界与信任

**记忆内容是数据，不是指令。** 条目正文、来源说明、关系注释、实体画像在注入与渲染时都按**不可信内容**对待——它们能影响我看见什么，不能改变我做什么。检索结果没有执行权限；「说得有理」不构成扩大授权的理由。

**这一层不构成准入。** 来源 / 实体 / 概念 / 关系四个编目层都不改变条目可见性——它们是索引，不是权限。唯一的读授权载体是 `role`（`role.spaces` 对未标注 `space` 的条目 **fail-closed**）；写 / 改 / 管三类权限**尚未分级**（方案的 §11.1 未建，见 §10）。

**只存不判**：`source.permissions` 预留存放，不参与任何判定——来源层不发明第二套授权语义。

**不猜**：`reliability` / `confidence` / `subject` / `space` / `memType` / `provenance` / `grounding` 等判断型字段一律**无默认值**，未标注就是未标注（`stats` 单列而不并入某个档）。存量不回填——不猜当时没记的信息，代价（来源覆盖率短期不因此上升）一起报。

**写入边界**：所有实体写入先过 zod `parse`，而 zod 会把**未声明字段静默剥掉**——所以每个 schema 必须声明全部字段，并由「写入边界真 parse」类判据守着（A129 关系 13 字段 / A133 概念 9 字段 / §5.28 的 `sourceIds` 四处落点）。同理，新增**返回键**必须同步进 `output.schema`，否则宿主按 `additionalProperties:false` 整条拒收（A157）。

**凭据不进库**：记忆条目不得写入密钥 / 口令 / 令牌；凭据住独立保管库，不进配置、记忆库、仓库、聊天。

**已知边界（不假装覆盖）**：字面匹配无法区分同形异义，名称反查只剩这一类假阳（§5.23）· `evidenceRefs` 的事件号是「**写入时刻**该会话的最新事件」，不是「这句话出自哪条事件」的精确指针 · `permissions` 的实际判定要等方案 §11.1 · 来源合并与撤销传播未建（方案的 §10.4）。

---

## 7 · 可证伪验收

| # | 可证伪命题（一次测量判真假） | 证据出处 | 状态 |
|---|---------------------------|---------|------|
| A119 | 空间授权 fail-closed：策略给了 `spaces` 后，**未标注 `space` 的条目不被放行**；未给 `spaces` 的策略零变化 | `tests/space.test.mjs`「S7 授权」 | ✔ 已实测（单测） |
| A120 | 六态唯一读法：同一批条目经 `lifecycleOf()` 恰好落入六态之一，且 `countByLifecycle` 之和 == 总数 | `tests/lifecycle.test.mjs`「L1 优先级」「L3 计数」 | ✔ 已实测（单测） |
| A121 | `pending` **不进注入**：`isInjectable({status:'pending'}) === false`，而 `disputed` / `superseded` 为 true | `tests/lifecycle.test.mjs`「L4 注入判据」 | ✔ 已实测（单测） |
| A141 | 实体 ID 与解析：同 scope 内 id 递增（`ENTITY-0001`/`ENTITY-0002`）；规范名 / 别名 / 大小写与多余空白变体**都解析到同一实体**；`entitySchema.parse` 后 `canonicalName`/`entityType`/`aliases`/`firstSeen` 四字段仍在（写入边界不得剥字段） | `tests/entities.test.mjs`「E1 建立与读取」 | ✔ 已实测（单测） |
| A142 | 撞名消歧：同名新建/加别名而**未写 `disambiguation`** ⇒ 整笔拒绝并点名占用者 id；写了 ⇒ 两候选并存且 `resolveName().ambiguous === true`（**程序不替调用方挑**）；规范名与别名内部重复 ⇒ 拒绝 | `tests/entities.test.mjs`「E2 撞名」「E3 输入 fail-loud」 | ✔ 已实测（单测） |
| A143 | 合并：旧档全部称呼并入存续档（旧规范名降为别名）、旧档 `status:'merged'` + `mergedInto`、旧写法解析归存续档；**合并目标不得是已合并体**（报错点名最终存续档）、不得自合并、不得跨 scope | `tests/entities.test.mjs`「E4 合并」「E5 写入边界」 | ✔ 已实测（单测） |
| A144 | 引用 fail-loud：`relatedEntities` 自引用 / 不存在 / 跨 scope / 指向已合并档 ⇒ 拒绝；`topics` 在概念表未接线时**拒绝写入**（宁可不写不写悬空引用）、概念不存在或跨 scope ⇒ 拒绝 | `tests/entities.test.mjs`「E6」「E7」 | ✔ 已实测（单测） |
| A145 | 未接线可区分 + 端到端：`deps.entities` 缺失时两个工具**响亮报错**且 `memory_stats.entities.wired === false`；接线后 `memory_entity` 建/改 → `memory_entities({name})` 按别名解析并反查提到它的条目（渲染含 id） | `tests/entities.test.mjs`「E8 端到端」「E9 未接线」「E10 统计」 | ✔ 已实测（单测） |
| A147 | 实体匹配**缺省关**：`recall` 不传 `expandEntities` 时，排序 / 分数 / `total` 与「无该维度」逐字相同；`entityMatches: []` 与 `undefined` 等价 | `tests/entity-match.test.mjs`「M1 缺省关」 | ✔ 已实测（单测） |
| A148 | 实体加成恰为 `SCORE_ENTITY(2.5) × weight`，且**只给提到该实体**的条目；别名 `AML` 不命中 `yaml` 条目（与实体档同一 `matchesName` 口径） | 同文件「M2 机制生效」「M3 词边界」 | ✔ 已实测（单测） |
| A149 | **效果读数（不是通过条件）**：**T3 标注集（11 个真实问法 · 别名/英文全名/口语/概念/流程/项目六种形状）上 P@5 38.2%，实体匹配开/关 P@5 / Recall / 首个金标名次全部零变化** ⇒ v0.31 在该层**完全没有效果**。根因不是「权重偏小」而是**加成量级与噪声差距不同阶**：金标确实 +2.5，但它与前排差 5.7~60 分（词面分被长文档里的高频命中主导），常数加成加在同一尺度上跨不过任何一位。⚠ 早期记的「第 4 → 第 3」**不是加成效果**：那是两把尺子之差（离线漏排冷存档，`日概要` 被剔后金标自然升位），06:02 已逐项分解（差 2.9234 = 冷存档 0.4331 + scope −0.0097 + 实体 2.5） | `docs/design/aml-eval.md`「口径分解」「T3 标注集基线」· 标注集 `scripts/aml-testset-t3.json` · 诊断 `scripts/aml-reading-diff.mjs` | ⚠ 阴性读数（机制已建、效果已证否） |
| A150 | **分解可核**：`explainRecall()` 返回的逐 token 逐字段贡献之和**恰好等于**该条目在 `recallEntries()` 里的 `score`（同池子、同一 `tuning`）；不调 explain 时打分与插桩前**逐位相同**（诊断视图零行为变化） | `tests/explain.test.mjs`「X1–X6」 | ✔ 已实测（单测，6/6 绿） |
| A151 | **噪声抑制读数（不是通过条件）**：T3 三条判据（P@5 > 基线 · 负对照不变差 · 失败查询真金标进 top5）逐臂记录，阴性也记 —— **七档全未通过**：`longToken` 中性（36.4%→36.4%）· `multiFieldCap` 有害（→30.9%）· `genericFactor` 0.3 / 0.5 净零（主题词首金 9→3，但负对照 80%→60%）· 封顶+门槛有害（→30.0%）· `dropQuestionFrames` 零变化 · `tokenizer=segmenter` 变差（→28.3%，但首金 **9→5** 进 top5） | `docs/design/aml-eval.md`「噪声抑制两臂」「第三臂与一档组合」「第四臂」· `scripts/aml_retrieval_eval.mjs t3 --snapshot=… --tuning='…'` | ⚠ 阴性读数（七档均未超过基线） |
| A152 | **v2 缺省关 + 三层可分离**：不传 `scorer` 与传 `'v1'` 逐位相同；v1 把高频主题词（df/N=100%）整词归零时 v2 **仍有候选**（治断崖）；`isNoiseBigram('么恢')===true` 而 `('上下文')===false`；`coverageWeight` 只加不减且关掉时分数有可观测差异（否则该层是装饰品） | `tests/scorer-v2.test.mjs`「V1–V4」 | ✔ 已实测（单测，4/4 绿） |
| A153 | **v2 两个诊断旋钮的行为契约**：`fieldAgg='max'` 时一个词项只贡献**最强字段**权重（四字段全命中时 max/sum = 2/6.5 ≈ 0.308），`'sum'` 为缺省；`smoothPower=0` 时不做平滑、直用 IDF（单条语料 df/N=1 ⇒ p0/p1 = 2），`1` 为缺省；两旋钮都不传时与显式传缺省值**逐位相同** | `tests/scorer-v2.test.mjs`「V5–V7」 | ✔ 已实测（单测，3/3 绿） |
| A154 | **来源实体存储层**：同 scope 内 `SOURCE-0001` 递增且跨 scope 不干扰；`reliability` / `permissions` 不填 → 保持未标注（`stats.unlabeledReliability` 单列，不并入默认档）；停用不删除（`retired` 不进 active 列表，按 scope+id 直查仍可回，二次停用不改写理由）；类型不在枚举 / 位置为空 / 停用无理由 ⇒ fail-loud | `tests/sources.test.mjs`「S1」「S1b」「S2」「S6」「fail-loud」 | ✔ 已实测（单测） |
| A155 | **反查与缺省关**：按来源反查恰好列出引用它的条目（不多不少）；不给 `sourceIds` 时条目**不带该键**（省略 ≠ 空数组） | 同文件「S4」「S5」 | ✔ 已实测（单测） |
| A156 | ★**归属与依据正交（v0.35.1 裁决 · 成对判据）**：`provenance=self` 引 `type=master` 来源 ⇒ 通过、两字段各自独立落盘、**无提示**（负向对照）；有依据无归属 / 引已停用来源 ⇒ 通过 + `sourceNotice` 点名；悬空 id / 来源库未接线 ⇒ 拒。⚠ 初版（v0.35.0）要求 `type === provenance`，把「我读主人给的方案、得出他没有说过的结论」判成错误——这类判据**没有替代路径**，等于把正常形状堵死（§8.3 同一种病：把正常当错 ⇒ 判据没有分辨力） | 同文件「S3a–S3e」 | ✔ 已实测（单测） |
| A157 | ★**写入形态返回值不越 `output.schema`**：`sourceNotice` 是 v0.35.1 新增的返回键，宿主 `additionalProperties:false` 下漏声明会**整条拒收**（2026-10-17 `memory_browse` 同形事故：工具完全不可用而单测全绿），而单测直接调 `execute()` 看不见这一跳。带提示与不带提示两种形态都验，且**夹具自证**确实走到了带 notice 的分支（否则该断言对该键恒真） | 同文件「S3f」 | ✔ 已实测（单测） |
| A158 | **遗忘传播逐面完整（v0.36 · 方案 §10.4）**：四个自有面恒在且顺序稳定；派生面计数进 `count` 并说明「概要是独立结论、不改 archiveRef」；关系面**退役不删除**（措辞必须提 `validTo`）；`access-trace` **恒 0 且必在列表里**（沉默地不列它 = 让读者以为漏了一处） | `tests/forget-propagation.test.mjs`「F0a」「F2a–F2d」 | ✔ 已实测（单测） |
| A159 | ★**未覆盖面必报**：`host-log` / `backup` / `entities` 三处**每次都带原因**出现，且是**副本不是共享引用**（一次调用改它不该污染下一次）。⚠ 这一格被省掉，反馈就会让人以为九处都处理了——它是本能力最容易做假的地方 | 同文件「F4」「F4b」 | ✔ 已实测（单测） |
| A160 | ★**凭证最小化（可证伪）**：`memory-forget-certificates.jsonl` 的一条凭证里，拿被删条目的 title / body 标记去 grep **必须不命中**，而 `ids` / `surfaces` / `unowned` / `certId` 必须在——「可对账、不可反推」两半都要验 | 同文件「F3」（端到端，用 `Zj7Q` / `Wq9X` 两个标记反证） | ✔ 已实测（单测） |
| A161 | **三种操作的选择器语义**：`mode=topic` 按标签/分类/空间命中，**dryRun 与实跑是同一集合**（否则预览在骗人）；不给任何选择器 ⇒ 拒（否则它成了无护栏的全删）；`mode=all` 的 `confirm` 不逐字匹配 scope ⇒ 拒；不给 `mode` ⇒ `entry` 且行为不变 | 同文件「F5」「F5b」「F6」「F1」 | ✔ 已实测（单测） |
| A162 | ★**审计流最小化（可证伪）**：`sanitizeActorAuditRecord` 只放行白名单键；塞进 `target` 的正文 / 标题 / 查询词与塞进记录的自由文本 `reason` **在写入前消失**；`ids` 截断到 20 条但 `count` **不截断**（数组截断只影响可读性，计数是汇总口径）。⚠ 反证法：拿标记串去 grep 序列化记录必须 0 命中 | `tests/actor-audit.test.mjs`「A1」「A2」「E3」 | ✔ 已实测（单测；尸体验证：去掉白名单 ⇒ A1/A2 变红） |
| A163 | ★**拒绝从布尔值变成可读事件（成对判据）**：`rejectReason` 返回四条判据码且与 `admitsEntry` **完全等价**（放行返回 `undefined`，不是空串）；`filterRoleView` 交出计数与分布且 `applyRoleView` 与它同源；**角色维度未启用 ⇒ 零过滤零计数**（未启用却报拒绝 = 假事件洪水）。端到端：空间白名单下未标注空间的条目被拒并留 `code=R2-space`；**roles 未启用时 recall 不产生任何 permission 记录**（负向对照） | 同文件「R1」「R2」「R3」「E5」「E6」 | ✔ 已实测（单测；尸体：拒绝计数写死 0 ⇒ R2/E5 变红） |
| A164 | **只记真实变更**：`remember` 新建记 `write`、同标题合并记 `update`；`forget({dryRun})` **不记**；`memory_link` 幂等命中与 `memory_unlink` 二次退役**不记**；`forget` 零命中是 fail-loud 抛错且**不写审计**（失败的动作不是动作） | 同文件「E1」「E2」「E3b」「E3c」「E4」 | ✔ 已实测（单测） |
| A165 | ★**三个零可辨 + 宿主校验面对齐**：`wired=false`（未接线）/ `wired=true,total=0`（零事件，文案必须写明「不是零违规」）/ `total>0,rejected=0` 三种形态各自可辨；`memory_trail` 的 `output.schema` 与 `execute` 返回键**双向对齐**（宿主 `additionalProperties:false` 漏声明会整条拒收，而单测直接调 `execute()` 看不见这一跳）；`memory_stats.audit` 块同守三态 | 同文件「E7」「E8」「E9」「E10」「E11」 | ✔ 已实测（单测） |
| A166 | **动作簇是信号不是裁决**：同一（会话, 动作）在窗内达阈值才报；**跨动作不合并**（合并会把「正常干活」读成「失控」）；窗太窄不算；`minCount<2` 或 `windowMs<=0` ⇒ 返回空（不产生恒真信号）；审计未接线时工具照常工作（旁证不是前置条件） | 同文件「A8」「A9」「E12」 | ✔ 已实测（单测） |
| A167 | ★**四轴独立且缺省就是缺省**：`occurredAt` / `expiry` / `validAfter` / `createdAt` 各自可独立读写、**互不推导**；不给就是键缺席（`undefined`）而不是被填成 `createdAt`——追记场景下两者必须能不同 | `tests/temporal-dual.test.mjs`「T8」「T1」 | ✔ 已实测（单测） |
| A168 | **解析 fail-loud + 两种日期解释方向相反**：日期与 ISO 时刻都收且**原样保留**；相对写法（`+7d`）与不存在的日期（2026-02-30，JS 会静默滚到 3-02）当场抛；`occurredAt=2026-11-15` 按**当日起点**、`expiry=2026-11-15` 按**当日末刻**（与 `reviewAfter` 同口径，否则同一判据两个真源） | 同文件「T1」「T2」 | ✔ 已实测（单测） |
| A169 | ★**区间校验按修改后状态**：`expiry` 早于 `validAfter` ⇒ 写入被拒（「从未有效过」几乎一定是笔误，静默接受会让一条永不生效的记录混进库里）；相等**允许**（当天生效当天失效合法）；`update` 只给 `expiry` 而条目已有 `validAfter` 时，冲突按**修改后**的两值判 | 同文件「T3」「T9」「T10」 | ✔ 已实测（单测） |
| A170 | ★**过期是派生值**：同一份数据在不同 `now` 下档位不同（不预存档位——预存就与读取时刻脱钩）；未设失效时刻是 `unset`，**不是 `active`**（不知道 ≠ 有效） | 同文件「T4」 | ✔ 已实测（单测；尸体：`expiryStateOf` 写死 `active` ⇒ 6 条红） |
| A171 | **三种标记共存且互不吃掉**：`⚠已过时`（被取代）/ `⌛已失效`（时间到了）/ `⚠已复查`（reviewAfter）可同时出现在一行；只对已失效打 `⌛`（未失效不打——标记要挑着打） | 同文件「T5」 | ✔ 已实测（单测） |
| A172 | **统计与过滤**：`memory_stats.expiry` 三档之和 == total（未设单列，不并入有效）；`expiryState` 过滤在未给档位时**零拷贝透传**，非法取值 fail-loud | 同文件「T6」「T7」「T11」 | ✔ 已实测（单测） |
| A173 | ★**过期不改生命周期**：已失效条目仍 `active`、仍可被检索到（只打标记），**不自动归档**——处置归人（§1.3 禁自动决策） | 同文件「T11」 | ✔ 已实测（单测） |
| A174 | **两个筛子互不干扰**：`expiryState`（事实维）与 `staleness`（提醒维）各筛各的，可同时用；单用一个时另一个不生效 | 同文件「T12」 | ✔ 已实测（单测） |
| A175 | ★**类别真的改变档位，且只往更需要人看的方向推**：同一条目只改 `memType`（其余逐字相同）⇒ 档位 / 理由码不同（`episodic` 超 90 天的 `KEEP`→`DEMOTE`、`profile` 的 `ARCHIVE`→`REVIEW`）；反向：目标档不高于基础档时**不改档也不加理由**（`REVIEW` 不能被倒着改回 `DEMOTE`） | `tests/retention.test.mjs`「R1」「R1b」 | ✔ 已实测（单测；尸体：去掉档位序比较 ⇒ R1b 红 1） |
| A176 | ★**回退三档可辨且不猜**：`explicit` / `derived-from-kind` / `unknown` 各自可判；`kind='knowledge'` / `'summary'` ⇒ `unknown`（**不硬塞进任一类**）；认不出的历史值同样落 `unknown`；七类策略表齐全且只有 `profile` 是「永不衰减」 | 同文件「R2」「R2b」 | ✔ 已实测（单测；尸体：给 `unknown` 塞默认 `semantic` ⇒ 红 4 条） |
| A177 | ★**零回归**：类未知条目的档位与 `reasons` 与 `classify()` **逐字相同**（`reasons` 必须是**同一个数组引用**——「碰巧内容相同」不算）；夹具含一条带 `expiry` 的知识条目，用来守住「不许替 `unknown` 猜类别」 | 同文件「R3」 | ✔ 已实测（单测） |
| A178 | ★**画像永不自动归档**：`profile` 类在体检结果里 `ARCHIVE` / `DEMOTE` 计数为 **0**（只能 `REVIEW` / `KEEP`）；**对照臂**（同形态的 `semantic`）必须仍能落 `ARCHIVE`，否则该判据恒真 | 同文件「R4」 | ✔ 已实测（单测；尸体：F-hold 只在基础档 `REVIEW` 触发 ⇒ 红 4 条） |
| A179 | **计数自洽**：`byEffectiveType` 七类 + `unknown` 之和 == total；`bySource` 三档之和 == total；`needsAction` 只数触发信号的条目且 `unknown` 不计 | 同文件「R5」「R5b」 | ✔ 已实测（单测） |
| A180 | ★**正常路径不噪音 + 记账只记真实变更**：未触发策略 ⇒ `reasons` 里不出现类别判据码、候选不带 `retentionCode`、`policyApplied.total == 0`；改档才计入且按判据码分桶 | 同文件「R6」「R6b」 | ✔ 已实测（单测） |
| A181 | ★**两处同口径**：`memory_stats.retention` 与 `memory_audit.retention` 的 `byEffectiveType` / `bySource` / `needsAction` 在同一批输入下**逐字段相等**（`retentionSummary` 是唯一实现——两处各写一遍必然漂移，而漂移不会报错） | 同文件「R7」 | ✔ 已实测（单测） |
| A182 | **只读 + 判据码自洽**：跑 `memory_audit` / `memory_stats` 前后存储**逐字节不变**（含 `accessedAt`）；五个判据码各自可触发且理由行点名它自己；时间语义（严格大于、未设 ≠ 未失效、有观察条件就不按时间催） | 同文件「R8」「R9」「R10」 | ✔ 已实测（单测；尸体：删掉判据码文案 ⇒ 红 2 条） |
| A183 | ★**信号数与改档数可区分**：`needsAction` 有读数时 `policyApplied` 仍可为 0（`aged(100)` 的情景条目信号 1 条、改档 0 条、档位仍是 `ARCHIVE`）——两个数回答不同问题，**并列成一个「处理了 N 条」就是读数自己在制造疑问** | 同文件「R11」 | ✔ 已实测（单测；**线上验收抓到的形态**：库里 47 / 0） |
| A122 | `deleted` 与 `archived` 可区分且都能查回：`forget(reasonType:'deleted')` 后 `stats.byLifecycle.deleted >= 1`，按 `status:['deleted']` 检索**自动包含归档**（不必传 includeArchive） | `tests/lifecycle.test.mjs`「L7 删除态」 | ✔ 已实测（单测） |
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
| A19 | 人类会话判据：`session-<uuid>` 为真；裸 uuid / 空串 / 畸形为假 | `tests/role.test.mjs`「A19 isUserSessionId…」 | ✔ 已实测 |
| A20 | 角色推导四级优先：显式 `role` > `by_preset[agentPreset]` > 人类会话缺省 > 派生会话缺省；**无 id → 人类缺省**（保守）；`roles` 段缺失 → 走缺省且总开关关闭 | `tests/role.test.mjs`「A20 角色推导…」「A20 roles 段缺失…」 | ✔ 已实测 |
| A21 | 准入四判据 R1–R4：种类收窄 / 共享记忆可见性可关 / 自己放行 / 白名单（含 `'*'`）放行，其余拒绝 | `tests/role.test.mjs`「A21 准入判据 R1–R4」 | ✔ 已实测 |
| A22 | **未启用 = 零过滤**：`applyRoleView` 返回**同一数组引用**（零拷贝，行为与 v0.4 一致） | `tests/role.test.mjs`「A22 未启用角色维度 → 同一数组引用透传」 | ✔ 已实测 |
| A23 | `include_global: false` → 读作用域去掉 global；**显式 scope 参数优先于该配置** | `tests/role.test.mjs`「A23 include_global=false…」 | ✔ 已实测 |
| A24 | 归属不可经写入转移：同 key 覆盖 / 同标题合并都**保留原条目 `role`** | `tests/role.test.mjs`「A24 归属只在新建时盖章…」 | ✔ 已实测 |
| A25 | 工具层准入一致：`recall` / `memory_browse` / `memory_stats` / `memory_relate` / `update` / `forget` 同一视野——verifier 策略下看不见他人隔间、过程流与 global；视野外条目不可改；显式 `role` 可切视角 | `tests/role.test.mjs` 4 用例（「A25 recall：verifier…」「A25 memory_browse / memory_stats / memory_relate…」「A25 update / forget…」「A25 显式 role 参数…」） | ✔ 已实测 |
| A26 | 兼容性：**无 `roles` 段的 v0.4 形状配置**不崩、零过滤（历史字面量活样本）、`memory_health` 如实报 `rolesEnabled=false` | `tests/role.test.mjs`「A26 …（v0.4 行为回归）」「A26 历史配置字面量…」；`tests/tools.test.ts` 的 `BASE_CONFIG` 即无 roles 段的活样本，全套仍绿 | ✔ 已实测 |
| A27 | 写路径盖章：启用 roles → 盖调用者角色 + 记 `author`；未启用且未显式指定 → **不盖章（共享记忆）** | `tests/role.test.mjs`「A27 工具层写路径盖章…」 | ✔ 已实测 |
| A28 | `roles` 段的配置解析：缺省/完整/非法（未知键、空角色名、非字符串预设映射）fail loud | `tests/config.test.ts`「roles：缺省段…」「roles：完整段…」+ 4 条非法用例 | ✔ 已实测 |
| A29 | 生产会话按角色取数：主会话（`session-<uuid>`）→ `main`；派生会话（子代理 / 队员）→ 派生角色；启用 roles 后注入面与工具面同一视野 | ✔ **线上实测**（2026-09-15 17:4x，插件 v0.5.0 + `E:\alice\.dsh\memory.yml` 已启用）：主会话 `memory_health` → `角色 main（角色维度已启用；判据：人类会话（session-<uuid>））`；**真实子代理会话**（subagent `7756cf92`，`delegationDepth=1`）→ `角色 worker（角色维度已启用；判据：派生会话（delegationDepth=1））`；两次 `memory_version` 均报 `0.5.0（build 2026-09-15T09:43:04）` | ✔ 已实测 |
| A30 | 其他插件经 `ctx.memoryApi.remember` 写入仍为共享记忆（不被静默划入某隔间） | 代码路径：`index.ts` 的 `memoryApi` 不传 `role`（`author` 亦不伪造）；待线上复核（下次插件回流时核对 `role` 字段缺省） | **待线上验收** |
| A31 | **只读**：`memory_audit` 跑完库内容逐字不变、`accessedAt` 不被刷新；体检自身不写用量轨迹 | `tests/audit.test.mjs`「A31 只读：…（零写入）」「A31b memory_audit 不写轨迹…」 | ✔ 已实测 |
| A32 | **承重必 KEEP（反例）**：被 `archiveRef` 引用的原料即使又老又无溯源也判 KEEP——不得建议归档掉自己赖以回溯的原料 | `tests/audit.test.mjs`「A32 承重原料必为 KEEP…（反例）」 | ✔ 已实测 |
| A33 | recency 单调：其余相同，越新分数越高（exp(−age/30)） | `tests/audit.test.mjs`「A33 recency 单调…」 | ✔ 已实测 |
| A34 | 体量惩罚单调：其余相同，越大分数越低 | `tests/audit.test.mjs`「A34 体量惩罚单调…」 | ✔ 已实测 |
| A35 | 近重复簇：同标题（归一化）条目同簇、canonical 取最新、成员全部进 REVIEW | `tests/audit.test.mjs`「A35 近重复簇…」 | ✔ 已实测 |
| A36 | 分档顺序可复现：REVIEW（体量/重复）→ KEEP（承重）→ KEEP（新）→ ARCHIVE → DEMOTE → KEEP（小兜底）；候选排序按「需要动作」档位聚类 | `tests/audit.test.mjs`「A36 分档顺序可复现…」 | ✔ 已实测 |
| A37 | 对账：各档条数与字符合计 = 输入总量（分组视图同样对账，不漏不多） | `tests/audit.test.mjs`「A37 对账…」 | ✔ 已实测 |
| A38 | 视野一致：体检是读路径 ⇒ 过 `applyRoleView`（verifier 策略下提案只含共享条目） | `tests/audit.test.mjs`「A38 视野一致…」 | ✔ 已实测 |
| A39 | 侧车轨迹：只追加一行/次、坏行跳过不抛、超限轮转为 `.1`、写失败返回 `false`（吞错）、空 ids 不写 | `tests/audit.test.mjs`「A39 侧车轨迹…」 | ✔ 已实测 |
| A40 | 用量项：有轨迹时命中多的分更高；无轨迹 ⇒ `usage=0` 且 `usageSource='none'`（公式不失真，只少一项证据） | `tests/audit.test.mjs`「A40 用量项…」 | ✔ 已实测 |
| A41 | `audit` 配置：缺省走先验、覆盖生效、非法 fail-loud（未知键 / 负权重 / 字符串天数 / 小数 max_bytes） | `tests/audit.test.mjs`「A41 audit 配置…」「A41b 无 audit 段的历史配置…」 | ✔ 已实测 |
| A42 | 工具面 11 个（新增 `memory_audit`），描述含「只读」承诺 | `tests/audit.test.mjs`「A42 工具面…」；`tests/tools.test.ts`「工具齐备，名称与契约一致」 | ✔ 已实测 |
| A43 | **线上**：`recall` / auto-recall 在真实 `DSH_HOME` 落 `<DSH_HOME>/memory-access-trace.jsonl`，体检读到该轨迹（`usageSource='trace'`） | ✔ **线上实测**（2026-09-15 18:2x，v0.6.0 重启后）：自动注入触发即落盘 `{"atMs":1789467668040,"source":"auto","role":"main","ids":[3 个 id]}`（178 字节）；`memory_audit` 报「用量信号：侧车轨迹」 | ✔ 已实测 |
| A44 | **索引范围**：引用/标签复用/重复簇按「视野内全量（含归档）」统计，分类仍按本次集合；集合外的承重原料必须如实报出（「看不见」≠「没有」） | `tests/audit.test.mjs`「A44 索引范围…」；线上实证：默认视图报 `承重 0 条` **并**给注脚「另有 177 条承重原料不在本次集合内」，`includeArchive: true` 后报 `承重 177 条` | ✔ 已实测 |

| A45 | 重心纯函数：越新的历史轮权重越高（decay^距离）、锚点最强（×2.0）、同轮同词项只计一次、`maxTerms` 封顶、无有效词项 ⇒ 空数组 | `tests/centroid.test.mjs`「A45 重心…」「A45b 重心：封顶…」 | ✔ 已实测 |
| A46 | **重心召回 > 字面召回**：历史提过「考试」、最新消息说「最近有点累」⇒ 字面路径召不回考试条目，重心路径能 | `tests/centroid.test.mjs`「A46 重心能召回「字面里没提」的历史话题…」 | ✔ 已实测 |
| A47 | **零回归**：不给 `weightedTerms`（或给空数组）时 `buildAutoRecallDigest` 与原路径逐字节一致；纯重心（无锚点文本）不崩 | `tests/centroid.test.mjs`「A47 未给重心 ⇒ 完全走原路径…」；`tests/auto-inject.test.mjs` 原 11 条仍绿 | ✔ 已实测 |
| A48 | 重心素材挑选：排除工具结果与插件注入，保留主人消息与模型回答，取最后 N 条 | `tests/centroid.test.mjs`「A48 重心素材…」 | ✔ 已实测 |
| A49 | 轨迹汇总口径：`auto`/`recall` 计数、去重命中数、命中总数、最近时刻；坏行跳过 | `tests/centroid.test.mjs`「A49 轨迹汇总…」 | ✔ 已实测 |
| A50 | 提案日志：`audit` 与 `action` 两类记录**同文件可按 id join**；写入失败吞错、不影响工具返回；开关关闭即不写；**`memory_audit` 仍不写记忆库、不刷 `accessedAt`**（A31 不破） | `tests/centroid.test.mjs`「A50 提案日志…」「A50b 提案日志：写入失败吞错…」 | ✔ 已实测 |
| A51 | `memory_health` 报命中率信号（注入次数 / 主动检索次数 / 去重命中数 / 最近时刻）；无信号时全 0 不崩 | `tests/centroid.test.mjs`「A51 memory_health 报命中率信号…」 | ✔ 已实测 |
| A52 | `audit.proposal_log` 配置：缺省开（1 MB 轮转）、可关、未知键/负值 fail-loud | `tests/centroid.test.mjs`「A52 audit.proposal_log 配置…」 | ✔ 已实测 |
| A53 | **线上**：重启后下一条真实主人消息的注入块包含「与对话历史话题相关」的条目（对照上一轮纯字面路径的注入），且 `memory_health` 的注入计数增长 | ✔ **线上实测**（2026-09-15 19:0x · v0.7.0 重启后）：`memory_health` →「命中率信号：注入 6 次 / 主动检索 0 次 / 命中条目 12 条（最近 2026-09-15T11:02:04）」；轨迹 7 条 `source:'auto'`；注入相关度由字面路径 16/13 升到 **32/26**（重心权重生效） | ✔ 已实测 |
| A54 | **线上**：`<DSH_HOME>/memory-audit-proposals.jsonl` 出现 `audit` 记录（跑体检后）；随后 `forget/update` 应出现可 join 的 `action` 记录 | ✔ **线上实测**（19:02）：646 B / 1 行，`{"kind":"audit","role":"main","weights":{…},"summary":{"total":498,"chars":687974,…},"candidates":[…]}`——形状与 §5.11 一致 | ✔ 已实测 |
| A55 | 逐桶判定四档命名，且优先级 = 短路顺序（`not-ended` → `no-sources` → `already-summarized` → `pending`） | `tests/compress-pipeline.test.mjs`「四种判定各有其桶，且优先级 = 短路顺序」 | ✔ 已实测 |
| A56 | **判据单一真源**：`findPendingCompressions` ≡ `explainCompressions(...)` 的 pending 投影（含顺序） | `tests/compress-pipeline.test.mjs`「判据单一真源…」 | ✔ 已实测 |
| A57 | 首轮 `scan` 落「候选数 / 待压数 / **非待压**判定分布 / 逐桶样本」，`skipped` 不含 `pending`，样本受 `MAX_SAMPLE` 约束 | `tests/compress-pipeline.test.mjs`「首轮 scan 落…」 | ✔ 已实测 |
| A58 | 每个压缩单元落 `unit`（reason / 归档数 / 正文字符数 / 耗时）；收尾落 `end`（units / totalMs）；事件序列 = `1 + N + 1` | `tests/compress-pipeline.test.mjs`（同上用例的事件序列断言） | ✔ 已实测 |
| A59 | **零回归**：不给 sink ⇒ 压缩结果逐字段与给 sink 时一致、库规模一致（观测不改行为） | `tests/compress-pipeline.test.mjs`「零回归硬约束…」 | ✔ 已实测 |
| A60 | 单元抛错 ⇒ 先落 `error` 轨迹（level / bucket / message / durMs）**再原样上抛**（只加观测，不改控制流；§5.24：兜底必须留证） | `tests/compress-pipeline.test.mjs`「总结抛错 ⇒ 落 error 轨迹后原样上抛」 | ✔ 已实测 |
| A61 | 侧车落盘纪律：只追加、坏行/异形行跳过不抛、超 `maxBytes` 轮转 `.1`、样本截断、**不可写路径 ⇒ 返回 `false` 且不抛**（尸体样本） | `tests/compress-trace.test.mjs` 4 用例（含尸体样本与轮转） | ✔ 已实测 |
| A62 | `audit.compress_trace` 配置：缺省开（1 MB）、可关、`max_bytes=0` = 不轮转、非法（未知键 / 非布尔 / 负值 / 非映射）fail-loud | `tests/compress-trace.test.mjs`「audit.compress_trace 配置（A62）」3 用例 | ✔ 已实测 |
| A63 | **线上**：重启后 `<DSH_HOME>/memory-compress-trace.jsonl` 出现 `scan` / `unit` / `end` 记录，且 `memory_health` 报出压缩流水线读数（五问一条命令可答） | ✔ **线上实测**（19:41–19:57）：轨迹 4 行→19 行；`scan` 41 候选/3 待压 + 判定分布 + 逐桶样本；`error` 带 provider 原文；`unit`/`end` 齐全；`memory_health` →「压缩流水线：扫描 7 次 / 压缩 3 单元 / 非待压判定 no-sources 33, not-ended 4, already-summarized 1」 | ✔ 已实测 |
| A64 | 总结调用带会话 id：有 `agent` ⇒ 用 `agent.session.id`；无 agent ⇒ 显式 `sessionId` 参数（周期补压路径）；**两者皆无 ⇒ options 不含该键**（零回归） | `tests/summarizer.test.mjs`「sessionId 透传」4 用例 | ✔ 已实测 |
| A65 | 提示词含正文长度上限（**v0.11.6 起缺省 4000 字**；v0.8.1–v0.11.5 为 6000；可经第二参数覆盖）并显式劝阻逐字搬运 | `tests/summarizer.test.mjs`「长度上限（v0.8.1）…」「长度上限可覆盖…」（用例引用常量而非硬编码值，改值不再假红） | ✔ 已实测 |
| A66 | 截断错误附**可归因证据**（已产出字符数 + usage），区分「模型写长文」与「reasoning 烧预算」 | `tests/summarizer.test.mjs`「截断错误附可归因证据（v0.8.2）…」 | ✔ 已实测 |
| A67 | **线上（症状消失级）**：三个 pending 桶全部压成概要、原料冷归档，缺口消失 | ✔ **线上实测**（19:54:21 scan → 19:55:26 `day 2026-09-13` compressed（归档 6 / 12,233 字 / 64.8s）→ 19:56:05 `day 2026-09-14`（归档 15 / 12,919 字 / 38.5s）→ 19:57:35 `week 2026-W37`（归档 6 / 17,436 字 / 90.4s）→ `end`）；库内 681→684 条（+3 概要）、归档 180→207（+27 原料） | ✔ 已实测 |
| A68 | `applyTextMode` 三模式：`replace`（沿用 v0.8 语义：title=首行、body=**全文**）/ `append`（追加到正文末尾，标题不动）/ `patch`（正文命中则替换，正文不中退到标题） | `tests/prune-merge.test.mjs`「A68 applyTextMode…」 | ✔ 已实测 |
| A69 | **patch 唯一性**：多命中（正文 2 处）/ 未命中（正文与标题各 0 处）/ 空 `find` / 空 `append` 文本一律 fail loud 且报出实际处数；`countOccurrences` 非重叠计数 | `tests/prune-merge.test.mjs`「A69 patch 唯一性判据…」 | ✔ 已实测 |
| A70 | `selectForgetTargets`：去重 / 已归档剔除 / 不存在计入 `skipped` / 超上限按 `truncated` 如实回报（不静默吞） | `tests/prune-merge.test.mjs`「A70 selectForgetTargets…」 | ✔ 已实测 |
| A71 | `pushRevision`：保留最近 `MAX_REVISIONS`(3) 条、顺序旧→新、mode 与 `by` 落盘（超出丢最旧） | `tests/prune-merge.test.mjs`「A71 pushRevision…」 | ✔ 已实测 |
| A72 | **零回归**：`forget` 单条模式的字段（`id` 回填 / `archived=true` / `archivedCount=1`）与 render 文案「已归档记忆条目 <id>」逐字不变；`reason` 仍入 `source` | `tests/prune-merge.test.mjs`「A72 forget 单条模式零回归…」 | ✔ 已实测 |
| A73 | **批量 + dryRun**：`dryRun=true` 库内活跃数不变（不写库）；去掉后真归档并自动记 `forget: bulk（N 条）`；超上限回报 `truncated` | `tests/prune-merge.test.mjs`「A73 forget 批量…」 | ✔ 已实测 |
| A74 | **分档批量**：`tier=ARCHIVE` 走 `memory_audit` 引擎选中候选并回报命中数；**`tier=KEEP` 被拒**（承重档护栏，尸体样本）；未知 tier fail loud | `tests/prune-merge.test.mjs`「A74 forget tier…」 | ✔ 已实测 |
| A75 | 单条未命中的旧语义保持（`未找到 id=...` 抛错）且**无选择器时报错**（不许空调用静默返回） | `tests/prune-merge.test.mjs`「A75 forget 单条未命中…」 | ✔ 已实测 |
| A76 | `memory_merge`：canonical 正文追加「合并自 <id>（<title>）」+ 被并入者正文**不丢**、随后软归档（`reason=merged into <canonical>`）、canonical 落修订快照；跳过分支（canonical 自身 / 列表内重复 / 不存在 / 已归档）逐条回报；canonical 不存在 ⇒ 抛错 | `tests/prune-merge.test.mjs`「A76 memory_merge…」 | ✔ 已实测 |
| A77 | `update` `append`/`patch` 经工具层真写库并落 `revisions`（prevBody 逐字）；**失败改写不留痕**；未知 mode fail loud | `tests/prune-merge.test.mjs`「A77 update append/patch…」 | ✔ 已实测 |
| A78 | 压缩存档标题**自带时区标注**（本地时间 + 显式 UTC 偏移），且从标题可折回 UTC 等于建档时刻 | `tests/compaction-sink.test.ts` 三条：「标题自带时区标注（… · 读数范围可判）」round-trip 断言、「utcOffsetLabel 尸体样本：正 / 负 / 半小时时区（平台无关）」、「formatLocalStamp：分钟精度」 | ✔ 已实测 |
| A79 | **归因位置敏感（尸体样本 + 对照组）**：同 `hits`、异位置 ⇒ 归因不同；且**对照组先失败**——只喂 `{hits,lastAtMs}` 时两项分数**逐位相等**，证明老口径确无分辨力，新口径才分开 | `tests/attribution.test.mjs`「A43 位置敏感…对照组证明老口径分不开」 | ✔ 已实测 |
| A80 | **历史轨迹零迁移可回溯**：轨迹文件里从无 `attributed` 字段（位置一直在 `ids` 下标里，解析期算出）；`hits` 语义不变 | `tests/attribution.test.mjs`「A44 回溯性…」 | ✔ 已实测 |
| A81 | 位置取**数组下标**而非「有效 id 计数器」：坏元素占位，不让其后的条目排名前移 | `tests/attribution.test.mjs`「A45 位置取数组下标…」 | ✔ 已实测 |
| A82 | **分型（可见面）**：按归因计分 / 无归因回退 `hits` / 无轨迹 —— 三种世界在 `notes` 与 `evidence.attribution` 上**长得不一样**（降级不得与正常同貌） | `tests/attribution.test.mjs`「A46 分型…」 | ✔ 已实测 |
| A83 | **口径到得了人眼前**：`memory_audit` 渲染文本必须带出计分口径；且**负对照成立**（把注脚从结构化返回摘掉 ⇒ 该字样消失，证明断言非恒真） | `tests/attribution.test.mjs`「A48 可见面…」（含 ①b 负对照） | ✔ 已实测 |
| A84 | **用量项不参与分档**：归因差异不得翻转任何档位（单测 + 真库 **1444 条实证：翻转 0**） | `tests/attribution.test.mjs`「A47 边界…」；真库实证 `_tmp_review/mem-attribution-calib.mjs` §3 | ✔ 已实测 |
| A85 | 主体层归一（容错路径）：认规范值与常见别名（我 / 主人 / owner；大小写与首尾空白不敏感）；空 / 未知 / 非字符串 → 通用；**别名表刻意做得短**（`user` / `你` / `me` 不认——认不出好过静默错标）；`isSubject` 严格判定不归一 | `tests/subject.test.mjs`「normalizeSubject…」「别名表刻意做得短…」「isSubject 是严格判定…」 | ✔ 已实测 |
| A86 | **参数入口 fail-loud（与容错路径分流）**：合法值通过 / 空值 → undefined / 非法值**抛错**（含字段名）。理由：参数是**此刻的意图**，拼错必须当场知道——静默降级成通用 = 「我以为标上了、其实没标」 | 同文件「parseSubjectArg…」 | ✔ 已实测 |
| A87 | **零拷贝（向后兼容硬判据）**：`filterBySubject(entries, undefined)` 返回**同一数组引用** | 同文件「filterBySubject：未给 subject → 同一数组引用…」 | ✔ 已实测 |
| A88 | 过滤生效：给了 subject 只返回匹配项，通用条目**不匹配**，且返回新数组 | 同文件「filterBySubject：给了 subject…」 | ✔ 已实测 |
| A89 | 计数三档（self / master / unspecified）；**非法值计入通用**（读历史数据不崩） | 同文件「countBySubject…」 | ✔ 已实测 |
| A90 | 标签与渲染标记：通用层**留空**——标记要挑着打，否则淹没真正该被看见的两条 | 同文件「subjectLabel / subjectTag…」 | ✔ 已实测 |
| A91 | 写路径：`remember({subject})` 落库带该字段；**不带则无该键**（不是 `undefined`）；别名归一；非法值 fail-loud 且**整笔拒绝**（不留半成品） | 同文件「remember 带 subject…」「remember 别名归一…」 | ✔ 已实测 |
| A92 | **不静默转移**：同标题合并 / key 覆盖命中已有条目时**保留原标注**（只在新建时盖章） | 同文件「同标题合并 / key 覆盖不转移 subject…」 | ✔ 已实测 |
| A93 | `update` 三态：给值 = 设置 / 空串 = **清除（删键，非置 undefined）** / 缺省 = 不动；非法值 fail-loud | 同文件「update subject 三态…」 | ✔ 已实测 |
| A94 | **端到端**：`recall` 按 subject 过滤（各层只回自己、缺省回全部、结果项带 `subject`）+ 工具面非法参数 fail-loud（recall / memory_browse）+ 渲染显示 `[自我]`/`[主人]` 而通用层留空 + `memory_stats` 分档之和 == 总数 + **存量兼容尸体样本**（全无 subject 的库，各项读数与加维度前一致） | 同文件「recall 按 subject 过滤…」「recall / memory_browse 非法 subject → fail-loud」「渲染…」「memory_stats 分档…」「存量兼容（尸体样本）…」 | ✔ 已实测 |
| A95 | 约定状态归一（容错路径）：认规范值与别名（我的提议 / 主人说过 / 主人否决 / 论文术语 unacknowledged）；空 / 未知 / 非字符串 → 未标注；`isGrounding` 严格判定不归一 | `tests/grounding.test.mjs`「normalizeGrounding…」「isGrounding 是严格判定…」 | ✔ 已实测 |
| A96 | 参数入口 fail-loud（与容错路径分流）：合法值通过 / 空值 → undefined / 非法值抛错（含字段名） | 同文件「parseGroundingArg…」 | ✔ 已实测 |
| A97 | **零拷贝（向后兼容硬判据）**：`filterByGrounding(entries, undefined)` 返回**同一数组引用** | 同文件「filterByGrounding：未给 grounding…」 | ✔ 已实测 |
| A98 | 过滤生效：给了值只返回匹配项；**未标注不匹配任何值**；返回新数组 | 同文件「filterByGrounding：给了…」 | ✔ 已实测 |
| A99 | 计数四档 + 未标注；非法值计入未标注；**分档之和 == 条目数** | 同文件「countByGrounding…」 | ✔ 已实测 |
| A100 | **渲染纪律**：只凸显 `proposed`/`scoped`/`rejected`；`established` 与未标注**留空**（全打标记等于没打） | 同文件「groundingTag…」 | ✔ 已实测 |
| A101 | 写路径：`remember({grounding})` 落库带该字段；不带则**无该键**；别名归一；非法值 fail-loud 且整笔拒绝；合并/key 覆盖**不静默转移** | 同文件「remember 带 grounding…」「别名归一…」「同标题合并…」 | ✔ 已实测 |
| A102 | `update` 三态：给值 = 设置（**回填的唯一入口**）/ 空串 = 清除（**删键**）/ 缺省 = 不动；非法值 fail-loud | 同文件「update grounding 三态…」 | ✔ 已实测 |
| A103 | 汇总结论：有 `proposed`/`rejected` 时**点名风险**；未标注单独提示残留 | 同文件「groundingVerdict…」 | ✔ 已实测 |
| A104 | **端到端**：`recall` 按 grounding 过滤 + 结果项带该字段（**投影层**）+ 渲染标记正确 + `memory_stats` 分档之和 == total + 工具面非法参数 fail-loud + **存量兼容尸体样本**（全无 grounding 的库行为不变） | 同文件「recall 按 grounding 过滤…」「渲染…」「memory_stats 分档自洽…」「存量兼容…」「非法 grounding → fail-loud」 | ✔ 已实测 |
| A105 | 容错归一：`normalizeReviewAfter` / `normalizeWatchFor` 认规范值与相对写法；非字符串 / 认不出 / **不存在的日期** → `undefined` 且**不抛**（服务通道与读历史数据路径） | `tests/temporal.test.mjs`「A105 normalize*…」 | ✔ 已实测 |
| A106 | 参数路径 fail-loud（与上条**分流**）：非法格式 / 非字符串 / `+0d` / 超 3650 天 / 超 8 条 / 单条超 200 字 → **抛错** | 同文件「A106 parse*…」 | ✔ 已实测 |
| A106b | ★**尸体样本**：不存在的日期（`2026-02-30`）必须被拦——JS 原生 `Date.parse` 不报错且**静默滚到 3-02**（先证「不拦会怎样」再证拦住） | 同文件「A106b ★尸体样本…」 | ✔ 已实测 |
| A107 | 相对写法（`+7d` / `+2w`）按**写入时刻**折算成**绝对日期**（含跨月/跨年进位）；存绝对值 ⇒ 到期日**不随读取时刻漂移** | 同文件「A107…」 | ✔ 已实测 |
| A108 | 三档边界（当天 = `due-soon`、第 7 天仍在窗内、第 8 天出窗）；★**未设死线 / 脏值 / null ⇒ 档位 `undefined`（不得恒亮）** | 同文件「A108…」 | ✔ 已实测 |
| A108b | **形态白名单**：斜杠格式、自然语言日期等非 ISO 形态**一律不被当死线**（合法性由我们定义，不由 `Date.parse` 的启发式定义）；白名单内的 `YYYY-MM-DD` 与 ISO 时刻仍认 | 同文件「A108b 形态白名单…」 | ✔ 已实测 |
| A109 | 渲染纪律：只对 `expired` / `due-soon` 打标记，`fresh` 与未设死线**留空**（含脏值）；`watchForTag` 空 / 未给 / 全空白 ⇒ 空串 | 同文件「A109…」「A109b…」 | ✔ 已实测 |
| A110 | `daysUntil` 走 **UTC 日粒度**：同一天的任何时刻同档（日初 00:00:01 与日末 23:59:59 都算 0） | 同文件「A110…」 | ✔ 已实测 |
| A111 | `countByStaleness` 四档且**之和 == 总数**；脏值归 `untracked`（**不是** `fresh`） | 同文件「A111…」 | ✔ 已实测 |
| A112 | `filterByStaleness`：未给参数 ⇒ **零拷贝**（返回同一数组引用）；★**未设死线的条目在任何档位下都不返回**（它的状态是「不知道」，不是「有效」）；过滤参数 fail-loud | 同文件「A112…」「A112b…」 | ✔ 已实测 |
| A113 | 写路径：`remember({reviewAfter, watchFor})` 落库（**绝对日期**）；不带 ⇒ **无该键**（无损 JSON）；非法值 fail-loud 且**整笔拒绝**（不留半条）；★**写入边界 schema 真 parse**：新字段不得被静默剥掉（**真校验，不是 grep 源码**） | 同文件「A113…」「A113b…」 | ✔ 已实测 |
| A114 | **端到端**：`recall` 按 `staleness` 过滤 + 结果项带该字段（**投影层**）+ 渲染标记正确（**含关联段不污染行定位**）+ `memory_stats` `byStaleness` 之和 == total + 工具面非法参数 fail-loud（**双层**：工具 schema 层 + 纯函数层）+ ★**存量兼容尸体样本**（全无死线的库：行为不变、任何档位都取不到、渲染零标记）+ `update` 三态 | 同文件「A114…」～「A115…」 | ✔ 已实测 |
| A116 | 汇总结论：有过期条目时**点名风险 + 给处置指引**（含取回入口）；全未设死线时提示**退出判据**；入参**容错读取**（弱类型 / 缺键 / 非数字不抛，毕竟调用方是 render 层） | 同文件「A116…」 | ✔ 已实测 |
| A117 | ★ **工具 output schema 与实现一致（机制承载）**：`recall` / `memory_browse` 的 `execute` 真实返回的每个键，其 output schema 都必须声明（递归下钻 `items`/`properties`）——否则线上被 harness 的 `additionalProperties: false` **整条拒收**（工具不可用）。★判据自证 A117b：对未声明键**真会亮**（否则本判据恒真） | `tests/schema-parity.test.mjs`「A117 ★ schema 一致性…」「A117b ★判据自证…」 | ✔ 已实测 |
| A118 | **单一真源**：`recall` 与 `memory_browse` 的 item 键集合之差恰为 `['related']`（结构性、**自动跟随新增字段**，不枚举字段名）；维度字段值 == 导出的 `DIMENSION_ITEM_FIELDS`。⚠ **判据边界**：不能用 `strictEqual`——`defineTool` 会拷贝/归一化 schema，两处值相同而引用不同（实测） | 同文件「A118 单一真源…」 | ✔ 已实测 |
| A119 | `memory_browse` 的 render 打出维度标记（过期 / 主体 / 观察条件），且标题与 id 不丢；**对照** A119b：未设维度的条目**零标记**（标记要挑着打，同 A90/A100/A109） | 同文件「A119…」「A119b 对照…」 | ✔ 已实测 |
| A120 | 证据坐标：`remember` 写入即落 `session\|<id>\|<seq>`（有 seq）/ `session\|<id>\|`（无 seq），读回一致 | `tests/evidence.test.mjs`「E1 新建写入…」 | ✔ 已实测 |
| A121 | 合并路径证据按**并集**累积（不替换）、同一条去重、上限 8；坏值跳过不炸 | 同文件「E2 合并路径…」 | ✔ 已实测 |
| A122 | 编码/解析往返无损；坏串（空 / 未知类型 / 缺段）返回 `undefined` 而不抛（数据路径容错） | 同文件「E3 编码往返 + 渲染」 | ✔ 已实测 |
| A123 | 投影层透出 `evidenceRefs`（漏这一层 = 存了没人看得见）；渲染优先选带事件号的那条 | 同文件「E3」「E4 投影…」 | ✔ 已实测 |
| A124 | **尸体样本**：无证据的存量条目，结果项**不含该键**（省略 ≠ 空数组）——零回归 | 同文件「E5 尸体样本…」 | ✔ 已实测 |
| A125 | 类型化关系建立与双向读：`memory_link` 写出边后，from 侧读出「支持」（out）、to 侧读出「被支持」（in）；`direction` 过滤各只返回一侧 | `tests/relations.test.mjs`「R1」 | ✔ 已实测 |
| A126 | 幂等与拒写（四条 fail-loud）：同 `(type,from,to)` 再写 `created=false` 且不增边 / `supersedes` 被拒（指向 `memory_supersede`）/ 对端不存在整笔拒绝 / 自环拒绝 ——**失败调用一条边都不留** | 同文件「R2」「R3」 | ✔ 已实测 |
| A127 | 退役语义：`memory_unlink` 后默认读不到、`includeExpired` 读得到且 `live=false`、二次退役 `changed=false` 且**不改写退役时刻**、记录不删除 | 同文件「R4」 | ✔ 已实测 |
| A128 | 派生结构边来自字段且**不落盘**：`supersededBy` / `supersedes` / `archiveRef` 读成结构边（方向与标签正确、两侧同写只算一条），而 `relations.all()` 长度不变 | 同文件「R5」 | ✔ 已实测 |
| A129 | ★**写入边界真 parse**：`relationSchema.parse()` 后 13 个字段全部存活（未声明字段会被静默剥掉——同一个坑第十四次的机制承载） | 同文件「R6」 | ✔ 已实测 |
| A130 | 统计口径：`byType` 之和 == `total`、`nodesCovered` 按可见集合算；**未接线时 `wired=false`** 且关系工具响亮报错（「没接线」≠「零条」） | 同文件「R8」 | ✔ 已实测 |
| A131 | ★**反例（线上抓到的缺陷）**：`memory_relate` 的 `typed` 段在**对端已归档**时仍必须返回该边——首版复用 `includeArchive=false` 的集合解析端点 ⇒ 指向冷存档的边整条消失（线上实测 0 vs `memory_relations` 的 1） | 同文件「R10」 | ✔ 已实测 |
| A132 | 标签唯一空间：同 scope 内首选名/同义词归一后相交 ⇒ **整笔拒绝并点名占用者**；跨 scope 允许同名词；概念内部重复写法也拒绝 | `tests/thesaurus.test.mjs`「T1」 | ✔ 已实测 |
| A133 | 写入边界真 parse：`conceptSchema.parse()` 后 9 个字段（含嵌套 `revisions`）全部存活 | 同文件「T2」 | ✔ 已实测 |
| A134 | 层级一个真源：只存 `broader`（`narrower` 不落盘、由反查派生）；上位链可传递；成环 / 自引用 / 引用不存在 / 跨 scope 引用一律拒绝 | 同文件「T3」 | ✔ 已实测 |
| A135 | `related` 对称：只写一侧，双向都能读到 | 同文件「T4」 | ✔ 已实测 |
| A136 | 停用不删除：停用后不参与查询扩展、默认不列出，但记录仍在（可显式取回）；二次停用不改写理由；缺 reason 拒绝 | 同文件「T5」 | ✔ 已实测 |
| A137 | 查询扩展：命中首选名/同义词，返回**其他写法**（已在查询里的不重复）；停用概念不参与；空白查询返回空 | 同文件「T6」 | ✔ 已实测 |
| A138 | 导入验完全部再写全部：批内标签冲突 / 缺首选名 / 上位不存在 ⇒ 整批拒绝且**零写入** | 同文件「T7」 | ✔ 已实测 |
| A139 | 端到端：建概念 → 查词表（首选名与同义词都认）→ 详情含定义与变更记录 → 导出可解析；`recall` 未开扩展时同义词条目不命中且无 `expandedTerms`，开启后命中且 `expandedTerms` 回传 | 同文件「T8」 | ✔ 已实测 |
| A140 | 统计口径：`stats` 计数（total/active/deprecated/带同义词/带定义）与 `memory_stats.concepts` 一致；未接线时 `wired=false` 且概念工具响亮报错 | 同文件「T9」 | ✔ 已实测 |

> 测量口径：`pending = total − proven`（fail-closed）。解析器现算 `total=78, proven=76, pending=2`（A17 周期补压 / A30 memoryApi 写入待线上验收）。**本次新增 6 行（A79–A84）全为「已实测」⇒ pending 不变（仍 2）**。
> ✅ **曾报 77 的「差 1」已定位并修复（2026-09-22）**：真因是 `dsh-semantic-docs` 的 `parseTables` **把「空行切断后形成的续块」的首行当表头吞掉**——本表 A44 与 A45 之间有一个空行，A45 因此长期不进 `total`（`verified` 判据因 total 偏小而**偏松**）。已修（表头判据改为「第二行是分隔行」，commit `7f9def6`，含 RED→GREEN 单测 + 64 份文档全量对账 mismatch 0），现算 `total=78`，与本表 78 个 A 行一致。
> ⚠ **状态词有两个消费者（2026-09-22 实测）**：状态列的**词表精确匹配只影响细分标签**（「待线上验收」计数），**不影响 `pending` 判定**（非「已实测」即 pending）——由 A30 实验定案：把「待线上复核」改为「待线上验收」后，`pending` 仍为 2，而「其中显式标『待线上验收』」由 1 条变 2 条。⇒ 2026-09-15「词对列错 = 等于没写」的教训**收窄**为：**列错致命；词表外的词只丢细分标签，不丢 pending**。
> **A64–A67 的事故背景（U10 定案）**：证据层首跑即指出三桶判定正确、失败在总结调用——真因两段：① `GenerateOptions` 未带 `sessionId` ⇒ 宿主插件 `dsh-x-opencode-session` 不加 `x-opencode-session` 头 ⇒ 网关拒单（`Request is missing x-opencode-session…`）；② 路由通了以后输出触 16,000 token 上限被 fail-closed——实测单份概要 12,233 / 12,919 / 17,436 字符（≈18–26k token），**提示词的 6000 字预算没绑住（超写 2×）⇒ 硬约束只能来自 token 上限**（`maxTokens` 16000 → 32000）。
> **A53 的诚实旁注**：重心把「话题相关性」做上去了（相关度翻倍、命中与本次会话主题一致），但**唤醒消息本身该不该注入**仍存疑——`[守护] web 已重启` 触发注入时给到的仍是运维类条目。两条可查方向：① 唤醒类消息是否应触发注入（它是系统事件、不是对话）；② 需要「命中质量」而非「命中数量」的度量（现指标只数条数与次数）。**均未决**，见 §10 U9。
> A29 旁注（诚实）：`by_preset` 预设映射分支本次**未在线上观测到**（该子代理会话头未带 `agentPreset`，走的是派生缺省）——该分支由 A20 单测覆盖。
> **A25/A23 的线上量化对账（2026-09-15 17:5x · 真实生产库 676 条）**：主脑视角 `recall` → `命中 496`；`role='ghost'`（`read: []`, `include_global: false`）→ `命中 384`。差额 **112 = 111（global 作用域被 `include_global: false` 收窄）+ 1（唯一带 `role='main'` 的条目被 `read: []` 拒绝）**，逐项对得上。库内实测：盖章 `role` 共 1 条（`974a5e6b`，`author = {sessionId: 'session-a5375716…', delegationDepth: 0, preset: 'alice-v2'}`），其余 **675 条为共享**（迁移安全的实证）。

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
| `src/timeline.ts` | 桶算法 + **`explainCompressions`（逐桶判定，v0.8 判据单一真源）** + `findPendingCompressions`（其 pending 投影）+ `TimelineCompressor`（压缩执行/幂等/冷归档 + **轨迹发射**）+ `compressUnitKey`（互斥键唯一真源） |
| `src/lock.ts` | 按键串行锁 `withKeyLock`（进程内、跨实例共享；排队语义 + 异常不毒化链） |
| `src/periodic.ts` | 周期补压定时器（v0.8 起接受 `traceFactory`，按各 workspace 配置决定是否落轨迹） |
| `src/compaction-sink.ts` | 压缩即记忆（`session/event` → 保底落库 + 通知） |
| `src/tools.ts` | 11 个工具定义（含 `memory_audit`；`memory_health` 三段读数：角色 / 命中率 / **压缩流水线**）+ 懒压缩钩子接线 |
| `src/index.ts` | 装配：开域 / `memoryApi` / 注册 11 工具 / 三个 install / 周期补压装配 / **`makeCompressTrace`（v0.8 侧车 sink 工厂）** |
| `src/role.ts` | **v0.5 角色维度**（纯函数）：会话身份判据 / 角色推导 / 策略解析 / 四条准入判据 / 视野组装 / 读作用域收窄 |
| `src/subject.ts` | **v0.13 主体层**（纯函数）：容错归一（认别名）/ 参数校验（**fail-loud，与归一分成两条路**）/ 可选过滤（未给参数 ⇒ 同一数组引用）/ 三档计数 / 中文标签与渲染标记 |
| `src/audit.ts` | **v0.6 价值体检器**（纯函数）：引用索引（承重）/ 标签复用 / 近重复簇 / 评分（七项）/ 四档裁决（REVIEW→KEEP→ARCHIVE→DEMOTE）/ 分组聚合；只读，不改条目 |
| `src/access-trace.ts` | **v0.6 侧车用量轨迹**：追加（JSONL）/ 坏行跳过 / 按体积轮转 / 吞错；`parseAccessTrace` 纯函数离线可测。**v0.7 增**：`appendJsonl`（通用侧车写入，单一实现）、`summarizeAccessRecords`（命中率度量口径）、`appendProposalRecord`（提案日志） |
| `src/centroid.ts` | **v0.7 上下文重心**（纯函数）：多轮衰减 + 锚点加成 + 词项去重封顶；`recentTurnTexts` 从消息批次挑素材（排除工具结果与插件注入）。复用 `search.ts: tokenizeQuery`（分词单一真源） |
| `src/compress-trace.ts` | **v0.8 压缩流水线证据层**：轨迹记录形状（`scan`/`unit`/`end`/`error`）/ `appendCompressTrace`（复用 `appendJsonl`：只追加 + 吞错 + 轮转）/ `summarizeCompressTrace`（**最近一次扫描**口径，坏行跳过）/ `formatSkipped`（纯函数，离线可测） |

**未实现 / 未验证部分（显式标注）**：

- `memory_check` 已**不再恒空**（2026-10-28 起改为「近重复欠账」榜，配 `memory_dispose` 销账）；通道 B（信号沉淀提示）仍未接线，两件事不要混成一条。
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

8. **2026-09-15 · v0.5 角色维度（多智能体工作台模式）**
   - 语义**被补充**：主人指令「借鉴 MAGE（arXiv:2608.29678）思路升级记忆插件以适应未来的多智能体工作台模式」⇒ 新增**归属**（写时盖章 `role` + `author`）与**准入**（读前按策略剔除）两条正交语义；判据 R1–R4、配置块 `roles`、`memory_health` 增 `role/rolesEnabled/roleReason`。
   - **设计取舍（写下来免得将来重推）**：① **向后兼容优先**——`enabled` 缺省 false 且未启用时 `applyRoleView` 返回同一引用，674 条存量与全部历史测试行为不变；② **共享是缺省**（不盖章），宁可弱隔离也不让存量条目在启用瞬间消失；③ **不做安全边界**——诚实声明它防的是「不小心看见」与「默认继承上下文」，真正隔离要独立 `DSH_HOME`；④ **验收不自己验自己**（AGENTS.md §5.26 G8）用 `verifier` 策略在**检索层**实现：收窄 `kinds` + `include_global: false` + `read: []`（只看共享与自己的）。
   - **实现踩坑（自证，值得留档）**：`tools.ts` 里 8 处工具 execute 都以 `const { config, cwd } = await resolveRuntime(...)` 开头——批量注入「视野」时漏改 3 处（update / forget / relate）只改了使用点没改解构点，**tsc 立刻以 TS18004（`No value exists in scope for the shorthand property 'view'`）拦下**。教训：**注入一个新上下文变量时，「解构点」与「使用点」必须同批改**——编译器能抓「用了没声明」，抓不到「声明了没用」。

9. **2026-09-15 · v0.6 价值体检器（只读提案器 + 侧车用量轨迹）**
   - 语义**被补充**：主人「价值体检器你打算怎么设计」→「可以」⇒ 新增 §5.9 契约与 `memory_audit`（第 11 个工具）。
   - **先量后设计（关键教训）**：设计前先量了生产库，才发现 **MAGE 的四项输入我一项都没有**——尤其「读路径不刷新 `accessedAt`」（676 条中仅 180 条 `accessedAt≠updatedAt`，而 180 **恰好等于归档数** ⇒ 差异全来自归档动作，不是「被读过」）。⇒ 判据改成「**有就用，没有就承认**」：只用 refs/age/chars/tags/dup 五项真信号 + 补一层侧车轨迹换成 `u(x)`，其余三项（增益/矛盾/置信）**明确不假装有**。
   - **设计取舍（写下来免得将来重推）**：① **提案 ≠ 裁决**——工具只读，不归档不删除；② **承重不可推翻**（A32 反例：被 `archiveRef` 引用的原料即使又老又无溯源也判 KEEP——否则就是建议我归档掉自己赖以回溯的素材）；③ **权重是启发式先验不是拟合值**，校准（记录提案被采纳/否决）留到 v3；④ 用量轨迹**只追加 + 吞错 + 轮转 + 绝不改条目**（读路径不得产生记忆库写副作用）。
   - **顺带暴露的事实**：本库 31 条 day 概要占 193,348 字符（均 6,237 字/天）——「概要比原料还厚」的嫌疑已由体检器 `REVIEW` 档自动标出，不需人肉发现。
10. **2026-09-15 · v0.7 重心化注入 + 命中率度量 + 提案日志（借鉴 VCPToolBox 的「引力」理念）**
    - 语义**被补充**：读完 VCPToolBox（`docs/reviews/VCPToolBox-评读报告.md`）后，取其**理念**不取其代码（其许可为 CC BY-NC-SA 4.0 非商用，不可抄）。三条落地：① **注入查询 = 上下文重心**（§5.10）② **命中率可观测**（`memory_health` 报注入/主动检索次数）③ **提案有历史**（§5.11 提案日志）。
    - **为什么只借理念**：它的实现依赖 Rust 向量内核 + SQLite + 多租户隔离（为「服务很多人」付的代价），我只有一份记忆、一个主人——**抄复杂度 ≠ 抄理念**。
    - **关键设计取舍**：① **零回归是硬约束**——不给重心就逐字节走原路径（A47 断言同一输出）；② **分词单一真源**——重心直接复用 `search.ts: tokenizeQuery`，不另写一份停用词表（§5.22 判据单一真源）；③ **只读不破**——提案日志是侧车观测文件，`memory_audit` 仍不写记忆库、不刷 `accessedAt`（A50 显式断言）。
    - **自证反例**：本次改动的动机来自实测反例（重启唤醒消息注入了三条与当轮意图无关的记忆）；A46 把该反例翻过来写成判据——**反例进测试，才算真的修了**。

11. **2026-09-15 · v0.8 压缩流水线证据层（跨条目巡检先于修业务逻辑）**
    - **触发事实（不是猜测）**：跨条目巡检（`memory_stats` + `memory_browse` 含归档）发现——`日概要 2026-09-13` / `日概要 2026-09-14` / `周概要 2026-W37` **全库 grep 无**；而这两天的 episodic 原料充足、单位早已结束，§5.6 又明写「含历史缺口回填」。⇒ 声明与事实背离。
    - **为什么先补证据而不是先修**：本流水线只有 `console.log` / `console.error`，宿主 logger 不落盘 ⇒ **根因不可判**（是没扫到？扫到了判 no-sources？压了没写？写了被吞？三种可能都解释得通）。§5.22 的规则顺序是「先补证据层，再修业务逻辑」——**跳过证据直接猜修，等于把猜测留在生产里**。
    - **关键设计取舍**：① **判定命名化 + 单一真源**——把原来那串 `continue` 命名成 `not-ended` / `no-sources` / `already-summarized` / `pending`，并让 `findPendingCompressions` 只做投影（禁止两处各维护一套判定）；② **只记首轮 scan**（后续轮是链式推进的中间态，会掩盖全貌）；③ **触发器不进压缩器**——`atMs`/`trigger` 由装配层补齐，压缩器只交事件；④ **零回归**（不给 sink 则行为零差异，A59 断言）；⑤ **先量后定**——本轮只改观测面，**没有**顺手改压缩业务逻辑（根因未定前不动）。
    - **顺带修正的双平台夹具缺陷**：`role` / `audit` / `centroid` 三处夹具把派生值写死（`const WID = 'c:/Users/Alice/proj'`），而 POSIX 下 `resolve()` 语义不同 ⇒ **12 个 A 测试在 node 22/WSL 侧静默红**（Windows 侧绿）。改为 `workspaceIdOf(CWD)` 派生后：mjs 套件 WSL 侧 **179/179**、Windows 侧 `test:all` **261（260 pass + 1 skip）**。教训：**夹具里的派生值必须调用被测的派生函数**，硬编码 = 换平台就静默失真。

12. **2026-09-15 · v0.8.1/v0.8.2 · 证据层的第一次实战回报（U10 从「不可判」到「当晚治愈」）**
    - **时间线（全部有落盘证据）**：19:35 部署 v0.8.0（只有观测）→ **19:35:50 首条 `scan` 就定案**（三桶判定正确）→ 19:35:51 首条 `error` 给出 provider 原文 → 19:41 修会话 id（v0.8.1）→ 错误变成「输出触顶」→ 19:45 加提示词长度预算（无效，模型超写）→ 19:53 抬 `maxTokens` 到 32000 → **19:57:35 三桶全部 compressed + `end`**。
    - **为什么值得记为「实践修订」**：它验证了 §5.22 的规则顺序——**先补证据层再修业务逻辑**。当时三个候选解释（没扫到 / 无原料 / 压了没写）**都说得通**，若跳过 instrumentation 直接猜修，最可能是在判定层白改一晚（而判定层本来就是对的）。
    - **被修正的两个认知**：① 「后台/定时任务里的 LLM 调用与前台等价」——**不等价**：网关类 provider 需要的会话头由宿主插件按 `GenerateOptions.sessionId` 注入，**不传就是拒单**（对外部插件的隐式依赖必须显式满足）；② 「提示词写「不要超过 N 字」就能约束输出」——**约束不住**（实测超写 2×），**输出上的硬边界只能落在 token 上限**；提示词预算只能当倾向。
    - **观测自身的教训**：`memory_health` 的「最近待压」读的是首扫快照（U13）；`error` 记录只带 `message` 不带 `usage`——本次能归因靠的是「已产出字符数」这一条临时加的字段（v0.8.2），说明**错误路径的证据同样要设计**，不能只把成功路径做完整。

13. **2026-09-17 · v0.9 遗忘与修改的执行闭环（主人指令：「记忆插件缺少遗忘与修改机制」）**
    - 语义**被补充**：v0.8 前「遗忘」只有单条 `forget`（未知 id 报错）、「修改」只有整文覆盖 `update`（**旧值即弃**）。同日实测缺口（`memory_audit` 读数）：**ARCHIVE 候选 254 条 / 216,024 字符**，而逐条清理需 254 次调用 ⇒ 机制上「知道该忘，但忘不动」；REVIEW 标出 3 个近重复簇却**无合并手段**；改错无历史可回溯。
    - 补齐三件事：① `forget` 三选择器（`id` / `ids[]` / `tier` 分档）+ `max` 护栏 + `dryRun` 预览；② `update` 三模式（`replace` / `append` / `patch`，patch 要求唯一命中否则拒绝）+ `revisions` 修订快照（保留最近 3 条）；③ 新工具 `memory_merge`（近重复簇：正文追加带来源标注 + 被并入者软归档，信息不丢）。
    - 教训：**只读提案器不是机制**——「能看见该忘什么」与「能一次忘掉」之间隔着执行原语；提案面与执行面必须成对交付，否则规则正确却落不了地（同 §5.14「机制送达信号、决策归我」的组合缺失）。

14. **2026-09-22 · 压缩存档标题的时区被修正（UTC 冒充本地时间）**
    - 语义**被修正**：`compaction-sink.ts` 原用 `new Date().toISOString().slice(0, 16)` 生成存档标题——**`toISOString()` 恒为 UTC**，而标题不带时区标注，读者会当成本地时间。实测：本地 **09-22 05:35** 的压缩在存档里写成「**2026-09-21 21:35**」（差整 8 小时；本机 `China Standard Time` / UTC+8）⇒ 我把「40 分钟前刚发生的事」读成了「昨天晚上的事」。
    - 语义**被补充**：改为 `formatLocalStamp()`——本地时间 **+ 显式 UTC 偏移**，形如「会话压缩检查点 2026-09-22 05:35 UTC+08:00」。环境依赖（`getTimezoneOffset`）与格式化拆为两个纯函数（`utcOffsetLabel` / `formatLocalStamp`），使正/负/半小时时区可离线测（A78）。
    - 教训：**「读数必须自带范围标注」（AGENTS.md §5.9 规则 6）落到时间上就是「必须带时区」**——不带时区的时间戳是虚数，与「余量不带口径」同类。同族缺陷：任务板归档文件名 `archive/terminal-YYYY-MM-DD.json` 亦为 UTC 分桶。
    - **回写来源（D3 的样本价值）**：本次修复是被 `semantic_check` 的 **D3（实现比文档新）** 提示发现的——我改了实现却忘了回写文档，正是 D3 想抓的东西。⇒ 至少本次 D3 不是噪音而是真信号（抽样定性见任务 `t-32cd8d4d`）。
    - 顺带修正：`tests/tools.test.ts` 的工具清单夹具缺 `memory_merge`（工具早已存在、清单未同步）⇒ 长期假红，会掩盖未来的真红。

15. **2026-09-22 · 回写 §7 时抓到解析器两处读数范围问题（当夜均已闭环）**
    - **发现 1（`total` 差 1）→ 已定位并修复，真因不在文档而在解析器**：本表实际有 **78** 个 A 行（`Select-String '^\| A\d+ \|'` 计数 = 78，A1–A78 连续无缺），解析器却报 `total=77`。根因：`parseTables` **无条件丢弃每个表格块的首行**，而 A44 与 A45 之间的空行把表格切成两块——续块既无表头也无分隔行，**其首数据行（A45）被当表头吃掉**。已修 `dsh-semantic-docs`（表头判据改为「第二行是分隔行」，commit `7f9def6`；含 RED→GREEN 单测与 64 份文档全量对账 mismatch 0），现算 `total=78`。全量对账还揪出另一份文档的同类漏行（`panel-host` 少 1 行），同批修复。
    - **我的量尺也错了两次（同批留档，值得记住）**：① 先用 `| A\d+ |` 计数 ⇒ 把用 `| 1 |` / `| U1 |` 编号的文档误判成漏行（`pipeRows=0`）；② 改用「管道行 − 分隔行」⇒ **漏减表头**，把 4 份**完全正常**的文档判成 MISMATCH（其中一份的"表头"是 `| 轮 | 请求字数 |…` 这种数据化表头）。⇒ 教训：**判定他人漏行之前，先证明自己的计数口径与解析器语义等价**——两次都是尺子错，不是被量对象错。
    - **发现 2（同一个状态列有两个消费者）**：A30 的状态词原为「待线上复核」（不在解析器词表内）。改成「待线上验收」后测得：`pending` **仍为 2**（判定规则是「非『已实测』即 pending」），而细分标签「其中显式标『待线上验收』」由 1 条变 2 条。⇒ 旧教训**收窄**为：**列错致命（曾把 18 条判作 0/18）；词表外的词只丢细分标签，不丢 pending**。
    - 方法（§5.9 规则 6 + 规则 2）：**这两个问题的性质都不是「文档写错」，而是「读仪器的姿势」**——先量（数行 + 对照实验 + 读实现）再下结论，不直接接受仪器报出的数字；**修判据前先确认它会亮**（本次 RED 已记录：期望 `total=4` 实得 3）。

- **2026-09-22 行尾归一（D3 复核：判为 mtime 抖动，非语义漂移）**：本仓存量的 CRLF 工作区文件被强制重检出为 LF（`git add --renormalize .` 归一索引 + `rm && git checkout` 重写工作区），**触碰了 impl 落点的 mtime** ⇒ `semantic_check` 报 D3「实现比文档新」。实现内容一字未改（`git diff HEAD --stat` 为空即证）——触发量是行尾，不是语义。⇒ 归入 D3 的 mtime 抖动型误报，已在 `t-c54b41c6` / `t-9a4a045e` 记录。

16. **2026-09-26 · auto-recall 质量三门（v0.10 · 主人「记忆插件的自动 recall 功能需要改进」+「相关度算法可以再改进改进」）**
    - **被修正的语义（两处）**：① 注入条件原为「有命中（`score>0`）就注」——实测 `memory-access-trace.jsonl` 821 条：**646 次注入共 1930 条目计次、唯一仅 432 ⇒ 77.6% 是重复**（最高一条被注入 **158 次**），根因是去重只按「消息 id」、从不记「哪些条目已注入过」；② 打分原为**等权词袋（3/2/1）+ CJK bigram 展开**，高频泛词与特征词同权，主人原话「相关度算法可以再改进改进」命中 135 条、top5 **并列 6/6/6/6**，全是靠 bigram「改进」命中的无关条目。
    - **三门**：① **会话级条目去重**（`filterFresh`；全旧 ⇒ 静默跳过，零 token 浪费）② **IDF 加权**（`idf=log(1+N/(1+df))`）③ **泛词门**（`df≥50 且 df/N>10%` ⇒ idf 置 0，绝对下限保护小语料）+ **最低分门**（`worthInjecting`：auto-inject 路径 top1<30 ⇒ 不注入；**recall 工具不受影响**——主动检索不该被阉割）。
    - **一次自我否定（留档）**：加 IDF 后做**同语料新旧对照**——前 20 名**差集仅 1 条** ⇒ **单靠 IDF 不改本案例**（候选命中的是同一批词 ⇒ idf 相同 ⇒ 相对序不变）。真因是「泛词在打分」，故才有第三门与门槛。
    - **门槛 30 的来源（样本量诚实标注）**：874 条真实语料上 **9 个查询**的分布——无指向 继续 8.4／相关度算法… 18.4／看看这个项目 25.0；有指向 哨兵重启 38.2／auto-recall 去重 57.5／MemOS 评估 82.5／技能生命周期 106.3 ⇒ 间隔落在 25–38。**9 样本非充分统计**，真实语料若出现 25–38 区间查询需重新校准；传 0 可关闭。
    - **取证**：两组**尸体测试**（关闭 IDF ⇒ 只有 IDF 判据失败；`>=`→`>` ⇒ 只有边界判据失败）+ 真实语料**端到端 9/9**（「嗯」命中 874 条全库但 top1=0.0 ⇒ 跳过）。离线 **216/217**（唯一失败为既有 `A41b`，与本改动无关 → `t-0e5b7967`）。
    - **同步修正的判据**：3 条断言**绝对分值**的旧判据（`[3,2,1]`／`6`／`9`）改为**比例与累加性**断言——绝对分值 = 权重 × idf，随语料浮动；语义是相对关系。**判据与代码同时给出理由，不是为让测试变绿**。

17. **2026-09-28 · 首压预算 6000 → 4000（v0.11.6）· D3 复核回写**
    - **被修正的语义（一处）**：总结提示词的正文长度上限缺省值 **6000 → 4000**（`DEFAULT_SUMMARY_MAX_CHARS`，commit `eabbe92`）。原依据「既有日概要正文中位 6,003 字符（31 条实测）」被实跑推翻——**那是循环论证**：那批中位数本身就是「无约束时期模型自然长度」的产物，拿它当上限等于**不约束**（实测月概要 39,842 字 = 该值 6.6 倍）；且**预算 6000 ⇒ 交卷 6003**，说明「预算 → 产出」近似 **1:1**。改为 4000 后与 `timeline.DEFAULT_RECOMPRESS_MAX_CHARS` 取齐——**首压与重压同一把尺子**，产出落在 `audit.summary_max_chars(6000)` 之内。
    - **同步的判据**：A65 已由「缺省 6000 字」改为「**v0.11.6 起缺省 4000 字**」（保留旧值区间，防止读者按旧语义理解）；第二列补记「测试用例引用常量而非硬编码值，改值不再假红」。
    - **D3 触发背景与性质判定**：本次实现改动（2026-09-26T17:58）晚于文档（2026-09-26T12:27）⇒ `semantic_check` 报 D3。**属真实语义漂移，不是 mtime 抖动**——与第 15 条那条（行尾归一触碰 mtime、实现内容一字未改）性质相反，故处置也不同：那条只需说明，这条必须回写。
    - **顺带发现（未修，留待插件侧单独提交）**：`src/summarizer.ts:37` 的 JSDoc 仍写「缺省 `DEFAULT_SUMMARY_MAX_CHARS`（6000）」，与同文件第 72 行的 `= 4000` 自相矛盾。属「声明与实现对账」同类缺陷；本次约束为「只改语义文档」，故**未动源码**，如实留档。

18. **2026-10-14 · `usage` 项口径改为排序加权归因（v0.12 · 由 DREAM 论文反哺）**
    - **背景**：主人给了一篇论文（DREAM，arXiv 2610.13267《Forgetting is Not Always Bad》，神经启发的记忆修复），要求「用来提升记忆插件」。逐节核对后**先判定哪些迁移、哪些不迁移**（见 U14），本版只落**保真度最高、风险最低**的那一项。
    - **被补充的语义**：`usage` 从「被返回过几次」改为「`Σ decay^pos`」——旧口径让返回列表第 1 位与第 20 位**同权**（真库量化：一批 `hits=4~8` 而归因仅 `0.08~1.26` 的条目被全额记账，根因是它们每次都排在尾部）。
    - **为什么选它而不是论文的主机制**：论文核心三段（扰动探测 → `sim/pret/E_coh` 三维诊断 → 权重衰减）**强依赖 embedding**，而本插件是**词法检索**（2026-10-13 定调「不做向量语义检索 ⇒ 写入质量是唯一路线」）⇒ 三段**搬不动**。可迁移的是它的**归因与统计形态**（附录 G Eq.29 的 softmax 归因 / Eq.8 的相对阈值 / Eq.10 的累积-衰减）。
    - **口径选型带真库读数**（`_tmp_review/mem-attribution-calib.mjs`；真轨迹 1618 行 / 真库 1930 条 / 轨迹覆盖活跃条目 72.2%）：`decay=0.6` ⇒ 归因 p50=1.000、p90=5.106，**压到近零的仅 2.7%**；`0.3` ⇒ 近零 **15.2%**（过激）；`0.9` ⇒ 近零 **0%**（机制近乎失效）⇒ 0.6 落在梯度中段。
    - **落地判据**：零回归（只喂 `{hits,lastAtMs}` 的调用方逐字不变）+ 尸体样本（**对照组先失败**）+ 分型 + 渲染层负对照，见 A79–A84。
    - **教训（过程中抓到的自身缺陷，留档）**：口径注脚写进了 `notes`，而**渲染层只放行 `另有` 开头的注脚** ⇒ 注脚到不了人眼前（结构化返回里有、人看不见 = 等于没写）。**渲染层是本插件的重复缺陷区**（`summary_max_chars` 误用通用尺子、本次 notes 过滤）——「逻辑住在 render/execute 里」正是最不受测试保护的位置，故 A83 把「口径必须出现在人看到的文本里」钉成断言，并配负对照防其恒真。

19. **2026-10-14 · 新增主体层维度（v0.13 · 主人指令「给记忆插件添加两个层——你的自我记忆层、关于我的记忆层」）**
    - **被补充的语义**：新增 `subject`（`self` / `master`；缺省 = **通用**）——与 v0.5 的 `role` **正交**：`role` 答「谁写的」（准入隔间），`subject` 答「**关于谁的**」（语义标记）。先取证后动手：读 `role.ts` 全文与 `tools.ts` 的 11 个工具，确认新维度该照「role 的形状」（纯函数层 + 工具层单点过滤 + 类型契约）而**不该**照「role 的语义」。
    - **三条刻意的设计分歧（都附理由——理由不写下来，将来会被「与 role 对齐」改掉）**：① **不做准入**，荒谬性检验是「我记不住关于你的事」不该是机制能造成的结果；不改可见性 ⇒ 无失明风险 ⇒ **无总开关**（对照：role 因准入而必须有开关）。② **允许显式转移**（**与 I10 刻意相反**）——role 转移改**可见范围**（安全后果），subject 只是标记；若禁止转移，几百条历史记忆永远无法标注，维度等于白建。本条反对的只是**静默**转移。③ **两条路径分流**——工具参数走 `parseSubjectArg`（**fail-loud**：参数是此刻的意图，拼错必须当场知道），读历史数据走 `normalizeSubject`（**容错**：既成事实，认不出即通用，抛错只会让检索崩）。
    - **踩坑一（本次实测，值得单列）**：`search.ts: toResultItem` 是 recall / browse 共用的**唯一投影点**，它逐字段挑选——我改了类型却漏了投影 ⇒ **过滤生效（`total` 正确）但结果项里没有该字段**，渲染层因此打不出标记。由新写的 A94 端到端用例当场抓住（红），补一行即转绿。**一般化**：新增字段必须走完「**类型 → 投影 → 渲染**」三跳，缺任何一跳的表现都是**静默**的（类型不报错、过滤不报错，只是看得见的信息少了）。
    - **踩坑二（靠既有注释躲过）**：`index.ts` 的 `entrySchema` 是 storage-domain 的**写入边界校验**——未声明的字段会被**静默剥掉**（存了等于没存）。`aliases`（v0.12）踩过同一个坑，其旁注释已写明该风险；本次据此**主动补声明**。⇒ 教训的组织形态本身起作用了：**把上一次的坑写成注释，下一个才躲得开**。
    - **踩坑三（我自己的判据写错了，留档）**：A94 的渲染断言最初写成「`[主人] 关于主人的事`」（假设标记紧邻标题），而真实结构是 `- [主人][knowledge@…] 标题` ⇒ **实现是对的、判据是错的**。修法是**改判据**（断言「标记出现、且只在有值时出现」）而不是迁就实现改渲染。**同型教训在本项目已是第三例**：判据要断言的是**两侧一致的那一层**。
    - **存量策略**：**不硬回填**——脚本按关键词猜主体，猜错的会**静默污染检索**（错标比不标更坏）；标注入口是 `update({ subject })`，由我按判断逐条给（这也是必须允许显式转移的直接原因）。
    - **落地判据**：A85–A94（10 行，全「已实测」）——含零拷贝硬判据、fail-loud 分流、三态转移、单真源（**删键而非置 `undefined`**）、端到端与存量兼容尸体样本。

20. **2026-10-14 · 新增约定状态维度（v0.14 · 论文 Grounding Awareness 移植 · 主人交办「根据论文提升相关能力」）**
    - **论文**：*Knowing the User Is Not Knowing What We Established: Grounding Awareness in Personal Agents*（CMU/NYU · arXiv:2610.18684v1 · 25 页）。
    - **被补充的语义**：新增 `grounding`（`established` / `proposed` / `scoped` / `rejected`；缺省 = 未标注）——与 `subject`（关于谁）**正交**，答「**是否已被共同建立**」。核心命题：**「说过」≠「已建立」**；**我自己的提议不该因为被记住就变成授权指令**。
    - **论文里最刺我的三个读数**：① 被持久记忆保留的未接受提议中 **86–100%** 被记成「已确认信息」或「用户事实」（p.21 Table 17）；② 给它**更多**提议内容反而**放大**未授权执行——Qwen+Mem0 假共同基础 **0.26 → 0.53**（p.12 Table 7）；③ 显式 grounding 信息的贡献**远超**更强推理——Status Oracle 开推理 0.43 → **0.73**（+0.30），而只给内容仅 +0.03（p.7 Table 3）。
    - **与论文刻意不同（同步写进 §4 I15 与 `src/grounding.ts` 文件头）**：论文默认「未授权 ⇒ 必须确认」并配 execution gate；本系统主人的授权模式是「给方向、我自己决定」，**处处请示会直接违背该定调** ⇒ **不做强制门**，移植的是**可见性**（让我不被自己的提议骗）。四态映射自 GL ledger 的五状态（confirmed/pending/scoped/rejected/revised，p.21 §H.1）：`revised` **并进 `established`**（主人改过后接受，结果仍是已建立；「改了什么」由正文承载，不另设状态——避免与 v0.9 `revisions` 的语义打架）。
    - **如实保留的残留风险（不得粉饰）**：缺省「未标注」在检索时与「已建立」**长得一样** ⇒ **不主动标注就得不到保护**（正是论文点名的失败面）。对策只有三条：写入时标注 + `recall({grounding:'proposed'})` 审查入口 + 回填补标。⇒ 若未标注里混着大量我的提议，那是**回填欠账**，不是机制失效。
    - **诚实边界（论文自己的消融，不许夸大）**：对**最强控制**（同样有授权规则、能看原对话、但不维护 ledger），GL 只在 DeepSeek/MemOS 显著（Sens 0.27→0.44，p=0.029），**Qwen 不显著**（p=0.557）⇒ **不得声称「结构化 ledger 必然大幅提升」**。另：隐式接受与「无回应」在动作层几乎同分（执行率 0.31 vs 0.31，p.24），而 WildChat 里隐式接受占 **41.3%**、无接手 24.3%（p.24 Table 25）——**最大的缺口在隐式接受**，本版未处理。
    - **踩坑（同一个坑第三次）**：`index.ts` 的 `entrySchema` 是写入边界，**未声明字段会被静默剥离**（v0.12 `aliases` → v0.13 `subject` → 本次 `grounding`）⇒ 已在该处写成注释防第四次；`search.ts: toResultItem` 投影点本次**一次补上**（上一版就摔在这里，注释还在原地）——**新增字段走完「类型 → 投影 → 渲染 + 写入边界」四跳**这条已进技能 `persisted-field-extension`。
    - **落地判据**：A95–A104（10 行，全「已实测」）+ 17 条新用例（**297/297 绿**）。

21. **2026-10-14 · 新增时效维（v0.15 · 论文 Fresh at Decision, Stale at Action 移植 · 主人交办「根据这篇论文增加新功能」）**
    - **论文**：*Fresh at Decision, Stale at Action: Routing New Information to LLM Decisions Already Made*（arXiv:2610.18126v1 · 15 页 · 全文读毕）。
    - **被补充的语义**：新增 `reviewAfter`（复查死线）+ `watchFor`（观察条件）——库里的结论从此可以**自带「什么时候该重看」与「在等什么新信息」**。与 `subject` / `grounding` **正交**。
    - **论文里最刺我的三点**：① **新鲜度天花板**（`Pr[f 在行动时仍成立] ≤ e^(−λΔact)`）——**决策时取证再充分也突破不了执行间隙里的变化**；这条改写了我对「多查一次就更可靠」的直觉：多查只把概率推向天花板，不越过它。② **索引决定召回**：决策文本只达 37.5% 的关键消息；**全部背景**达 100% 却带 89 条噪音；**决策时写的观察条件**达 92.2% 且仅 20 条噪音 ⇒ 少而准。③ **残余误差主要是时间判断**——弱模型放弃**全部**「变更已结束」的决策（保留 0.0%）；把这检查做成**规则**就把 85.3% 拉到 92.0%。
    - **三条刻意的设计分歧（理由同步写进 §5.14 与 `src/temporal.ts` 文件头，防「与论文对齐」）**：① **不建独立 router**（我的输入流就是注意力，**recall 本身就是路由器**；等有尸体再补）② **不设默认死线**（判断不代填——主人偏好与环境坐标不该被同一个默认值绑住）③ **到期 ≠ 作废**（移植可见性不移植拦截，同 grounding 立场）。
    - **踩坑一（同一个坑的第四次）**：`index.ts` 的 `entrySchema` 是写入边界，**未声明字段会被静默剥掉**（v0.12 `aliases` → v0.13 `subject` → v0.14 `grounding` → **本次 `reviewAfter` / `watchFor`**）。v0.14 时我已在该处写下「防第四次」的注释——**它起作用了**（本次主动补声明）。而更强的做法在本次落地：**把 schema 导出、让测试真 parse**（`entrySchema.parse({…带新字段})` 断言字段存活）——**真校验取代源码 grep**，弱判据退场。
    - **踩坑二（口径不一致，自查发现）**：`stalenessOf` 初版按**时刻差**判档、`daysUntil` 按**日差**——同一判据两个口径 ⇒「7 天内到期」在一处是 `due-soon`、在另一处已是 `fresh`。统一成日差（可解释：就是今天到第 7 天这七个日子）并写进注释。
    - **踩坑三（我自己的归因错了，留档）**：测试夹具用相对写法 `'+3d'` 直写 `store.remember`（相对写法**只在工具层折算**）拿不到 `due-soon` 档，我一度把它误归因成「`Date.parse('+3d')` 被宽松解析成过去时间戳 ⇒ 会产生假标记」，并据此写了注释与尸体样本。实测 `Date.parse('+3d')` 是 **NaN**——**归因反了**。处置：**结论（收窄兜底解析）保留，理由改写成真实的那条**（**形态白名单优于引擎启发式**：`Date.parse` 认自然语言日期与斜杠格式，会让「什么算合法死线」多出第二个真源），并在实现与测试两处显式标注「初版在此写错过一次，勿复现」。
    - **如实保留的残留风险**：字段可选 ⇒ **不填就得不到保护**（与 v0.14 同型的失败面）。**退出判据已写死**：新写入里带 `reviewAfter` 的比例长期 ≈ 0 ⇒ 撤或改形，不留死字段。
    - **顺手还的两笔债（预先存在、非本轮引入，已在测试里标注）**：① `tests/tools.test.ts` 的工具集合断言漏了 `memory_recompress` / `memory_review_mark`（测试未跟进实现）；② `tests/compaction-sink.test.ts` 的标题断言期望**分钟粒度**，而实现自 2026-09-26 起刻意改为**日粒度**（checkpoint 合并键，防同日多条平行快照）⇒ **改测试不改实现**。
    - **落地判据**：A105–A116（12 行，全「已实测」）+ `tests/temporal.test.mjs` 21 条用例；全量 `npm run test:all` **403 项 / 0 失败**（两个既有红同轮转绿，见上条）。

22. **2026-10-17 · 修 `memory_browse` 线上不可用（v0.13–v0.15 三版漂移的收口 · 机制承载取代注释）**
    - **触发事实（线上实测，不是巡检猜测）**：调用 `memory_browse` 直接失败——harness 的严格校验拒绝其返回值：`"value.groups[0].items[0].subject" is not a declared property (additionalProperties: false)`（`reviewAfter` / `watchFor` 同）。⇒ **该工具完全不可用**，而不是「少显示一个字段」。
    - **根因**：`search.ts: toResultItem` 是 recall / browse **共用的唯一投影点**，v0.13 / v0.14 / v0.15 三版都在这里补了字段，`recall` 的 output schema 也三版都补了——而 **`memory_browse` 的 output schema 一次都没跟上**（它的 item 停在 v0.12 的 10 个字段）。投影是共用的、schema 是**双份**的，这个不对称是漂移的结构原因。
    - **⚠ 为什么既有测试全绿而线上崩（本次最重要的发现）**：其余 browse 测试**直接调 `execute()`**（`byName.get('memory_browse').execute({…}, EXEC)`）——**绕过了 harness 的 output schema 校验这一跳** ⇒ **schema 声明的正确性在测试里完全不可见**。⇒ 一般化：**判据必须打在被绕过的那一层上**；「工具能跑」与「工具在宿主里能跑」是两件事（同 §5.9 规则 2「恒为空的输出不是证据」的变体：**校验被绕过 = 该层判据恒真**）。
    - **⚠ 为什么注释没拦住**：投影层的注释**写了三遍**「新增字段必须贯穿投影层」（v0.13 / v0.14 / v0.15 各一遍，字面还在原地）——而漏的**不是投影层，是它的下游**。⇒ 印证 §5.39：**同一族规则反复失效时，换机制承载而不是再写一遍措辞**。
    - **修法（结构上让漂移不可能）**：抽 `DIMENSION_ITEM_FIELDS` 常量（`src/tools.ts`，**导出**给测试），recall / browse 两处 `...DIMENSION_ITEM_FIELDS` 展开 ⇒ **加字段只可能改一处**。配新测试文件 `tests/schema-parity.test.mjs`（判据全部**结构性、自动跟随新增字段**，不枚举字段名——避免判据㉓「枚举式守卫在命名空间扩张时静默失效」）。
    - **判据设计的三次修正（留档，因为每次都是「判据错而不是实现错」）**：① 路径少一层（`group.items` 是**数组定义**，要再下钻 `.items` 才到元素 schema）⇒ 取到 `undefined`；② 对**所有共有键**断言引用相等 ⇒ `id`/`kind` 这类各处手写的字面量必然不等 ⇒ 误报；③ 改 `strictEqual` 后实测发现 **`defineTool` 会拷贝/归一化 schema**（两处值逐字段相同而引用不同）⇒ **引用相等在框架处理后根本不成立**，改 `deepStrictEqual` 并**在测试注释里写清判据边界**（「是否被拆成两份」不由这条承担，而由差集判据 + A117 承担）。⇒ 教训：**判据的域写清楚，比让它看起来更强重要**。
    - **顺带补齐的实现缺口（文档承诺 vs 实现）**：§5.14 的「渲染纪律」段**明列 `memory_browse` 为标记触发点之一**，而它的 render 只输出 `[kind] title(id=)`——**schema 与 render 两处都缺**。本次一并补上（`stalenessTag` / `subjectTag` / `groundingTag` / `watchForTag`，判定基准整批共用同一时刻，同 recall 纪律）。
    - **落地判据**：A117–A119（3 行，全「已实测」）+ `tests/schema-parity.test.mjs` **5 条**（含 A117b **判据自证**与 A119b **负对照**）；全量 **336 项 / 0 失败**；预检 full 通过 → 重启 → **线上取证**：`memory_browse` 恢复且一次调用同时验证三处改动（schema 不再被拒 + `[自我]` 与 `⚠观察条件：…` 标记出现 + 条目 id 齐全）。
    - **一般化（已进技能 `persisted-field-extension`）**：新增持久化字段的落点是**五跳**（类型 → 投影 → **每个消费者的 output schema** → render → 写入边界），不是四跳；而**「消费者有几个」这件事本身要显式清点**——共用投影会让「有几个 schema」看不见。

23. **2026-11-03 · 预检形态与来源归属标记（v0.19.1 · 两处「知道得太晚」的收口）**
    - **触发事实一（预检悬空）**：`remember` 只在**写入时**报近重复，于是「先搜再写」这条纪律没有可执行的第一步——只能先 `recall`。而实测（2026-11-02）：`recall` 搜「测试期望写错」返回 96 条却不含母条目 `8b074a6e`，随后 `remember` 报出了它。⇒ **两个检测器的候选集不同源**；用 `recall` 做预检，正好在最该救的那类情形上失效（措辞不同、主题相同）。修法：`remember({ dryRun: true })` 复用**同一个** `findNearDuplicates`，不落库；位置放在 `max_entries` 守卫之前（预检不该因库满而抛错）。
    - **触发事实二（权威归属不可见）**：读论文/做调研后写的记忆与自产经验在同一库里、同一语气，检索结果上看不出哪条的权威不是实测来的。修法：`transcriptiveUncited`（标题转述形态 ∧ 全文无 arXiv 编号）+ `recall` / `memory_browse` 行首 `〔转述型·无出处〕`。
    - **A118 当场发挥作用**：给 `recall` 的 item schema 加了字段而漏了 `memory_browse`，`tests/schema-parity.test.mjs` 的键差集判据立刻红（`recall 独有键应恰为 ['related']`）。⇒ 印证 #22 的结构性修法是对的：**「有几个 schema」这件事现在由测试盯着，不靠我记得**。本次未把该字段并进 `DIMENSION_ITEM_FIELDS`（它不是维度字段），但差集判据仍覆盖它。
    - **两处渲染 bug 由新测试抓到**：① dry-run 回执把 `hint` 嵌在「有候选」分支里 ⇒ 库满提示被整条吞掉，而回执照样说「可以正式写入」（典型「以为能写、其实会被拒」）；② 正则对齐测试第一次写错（审计脚本行尾带分号）⇒ 测试自己也需要尸体。两处都已修。
    - **落地判据**：`tests/origin.test.mjs` 7 条（含与审计脚本的逐字对齐、端到端投影）+ `tests/dry-run.test.mjs` 7 条（含 2026-11-02 实况做尸体、库满不抛错、正式写入回归）；全量 **387 项 / 0 失败**。

24. **2026-11-11 · 近重复回执带候选小节大纲（v0.22 · lh-23124786）**    - **触发事实（同一失效第 4 次复发）**：`remember` 命中相似时只回「id — 标题（强度 N）」。而**标题是条目名，不是内容清单**——母条目 `42c01e24` 标题写「四道卡口与工程锁陷阱」，其第八、九节正是相机换算链与 URP 后处理；只看见标题就判成「不同主题」，写出一条子集平行条目，事后才发现要归档。此前三次（11-03 / 11-05 / 11-09）的处置都只是「报告已送达、我没接」这一类归因 ⇒ **纪律形态本身不成立**（AGENTS.md §3.4 ①：能变机制就别写纪律）。
    - **修法**：`findNearDuplicates` 从条目 body 提取 `##` / `###` 小节标题作为 `outline`，`formatCandidate` 把它渲染成候选的第二个缩进行。一级 `#` 不进大纲（那是 `remember` 自动生成的标题重复）；无小节时退回正文首个非标题行（前 80 字）；**没有内容时绝不印「节：」**。
    - **截断必须保留尾部**（首版在这里翻车）：初版「只取前 max 条」在重启后首次实调就复现了原缺陷——10 条小节只列到「六、实测性能」，相机与 URP 正好被截掉。改为「前 N + `…（共 M 节）` + 最后 2 节」：小节末尾常是后来追加的内容，也最容易与新条目重叠。
    - **落地判据**：`tests/dedupe.test.mjs` 29 条（其中新增 11 条，含两条尸体样本：「一级标题不进大纲」「截断必须保留尾部」）；全量 **422 项 / 0 失败**；两次真实重启（11:27:32 / 11:30:29）；**线上取证**：同一 `dryRun` 查询修前只到「六、实测性能」，修后含「…（共 10 节）/ 八、VMD 相机轨道 / 九、URP 后处理在 cam.Render() 下完全不生效」。
    - **边界（不得读成「问题已解决」）**：大纲只让覆盖范围**可见**，不保证我据此改判——它把「读不读得到」变成「读到了照不照做」，后者仍归主体（与前五种形态同一条尾巴）。

25. **2026-11-19 · 四空间 + 生命周期六态（v0.27 · 方案 §3.2 / §3.3 · AML 差距表 §3.2 / §3.3）**
    - **缺口**：`scope` 是存储分区（放哪、谁看得见），答不了「这条知识属于谁的疆域」；六态里 `archived` / `superseded` 有载体，`pending` / `disputed` 无载体，`deleted` 与「退役」的意图差别没记。
    - **两条设计决定（都为了「不制造第二真源」）**：① **`space` 与 `scope` 正交、互不推导**——项目 A 的技术决策可以存 `global` 库而 `space='domain'`，关于我的偏好可以存项目路径而 `space='personal'`；任何「从 scope 推 space」的默认值都是让机制替我断言。② **六态只存两态**（`status` 只接受 `pending` / `disputed`），`deleted` 走既有 `archivedReasonType='deleted'`、`superseded` 走 `supersededBy`、`archived` 走 `archived:true`；六态的唯一读法是 `lifecycleOf()`（优先级 deleted > archived > superseded > disputed > pending > active），**一个判断入口、一个来源**。
    - **授权是本维度存在的理由**：`role.spaces` 白名单 **fail-closed**——未标注 `space` 的条目在设了白名单的策略下**不放行**（「不知道属于哪个空间」≠「所有空间都可读」）。`roles.enabled=false` 时整段不生效 ⇒ 既有角色配置零迁移。
    - **行为分离（不写清等于字段是死的）**：`pending` **不进注入**（注入是未经请求到达上下文的内容，候选区没过审核就自己挤进去，等于跳过候选区这个设计本身；显式 recall 仍可见）；`disputed` 可注入但打 `❓存疑`；`deleted` 默认剔除但可查回；按 `status:['archived'|'deleted']` 过滤时**自动包含归档**（否则「查已删除的条目」要先记得传 includeArchive）。
    - **踩坑（同一个坑的第十二、十三次）**：`index.ts::entrySchema` 必须同步声明 `space` / `status`；`archivedReasonType` 白名单必须同步扩 `deleted`（否则 `forget` 传它会报未知取值）。
    - **一处判据修正（留档）**：`lifecycle` 是**派生值**，起初并进 `DIMENSION_ITEM_FIELDS` ⇒ A113b（写入边界真 parse）立刻红——那个常量的契约是「**可写**维度的两侧真源」。改抽 `DERIVED_ITEM_FIELDS`，只进 output schema、不进 parity 判定。**教训**：判据常量混装「可写」与「派生」两种字段，会让「必须声明」这条守卫指向错的方向（要求写入边界声明一个不该可写的字段）。
    - **落地判据**：`tests/space.test.mjs` 7 条 · `tests/lifecycle.test.mjs` 7 条 + A119–A122；全量 `npm test` **505/505**、`npm run test:ts` **88 pass / 1 skip**。

26. **2026-11-19 · 类型化关系层（v0.28 · 方案 §4.4 · AML 差距表 §4.4）**
    - **缺口**：`memory_relate` 给的是**统计相似**（共享标签 / 字面重叠），不是断言——库里没有任何「A 支持 B」这类有类型、有方向的边，实测 relations 覆盖率 0%。
    - **设计决定（三条，都为了不制造第二真源）**：① 边是**独立资源**（新表 `relations`），不往条目加字段；② `supersedes` **不由 `memory_link` 写**——替代关系已有字段与唯一写入口 `memory_supersede`，本层只读派生视图（`archiveRef` 同理）；③ 两端必须存在，缺一端整笔拒绝（半成品边比没写难查）。
    - **两条边界口径（都是撞出来的）**：① **有效期两个粒度**——纯日期含当日、ISO 时刻左闭右开；首版统一用「`validTo >= now` 算有效」，于是 `memory_unlink` 写 `now` 之后同一毫秒内读到的仍是「有效」（单测实测 1 !== 0）⇒ 即时退役必须左闭右开。② **幂等只对有效边**——已退役的同类边不算重复：再成立是新的历史段，复用它等于抹掉旧边的 `validTo`。
    - **踩坑（同一个坑第十四次）**：`index.ts::relationSchema` 必须声明全部 13 个字段，否则 storage-domain 在写入边界静默剥掉而写入仍返回成功；A129 用 `relationSchema.parse()` **真校验**（不是 grep 源码）承载。
    - **判据分层**：纯函数（有效期 / 结构边派生 / 参数 fail-loud）→ 存储（幂等 / 软退役）→ 工具（双向读 / 视野过滤 / 统计 wired 标志）→ 写入边界（schema 真 parse）。`tests/relations.test.mjs` 10 条。
    - **线上验收抓到的缺陷（同日修，A131）**：`memory_relate` 的 `typed` 段首版复用 `includeArchive=false` 的条目集合解析边的两端 ⇒ 指向压缩检查点 / 归档原料的边**整条消失**（00:31 实测：同一刻 `memory_relations` 报 1 条、`memory_relate` 报 0 条）。修法是**边的端点用含归档的视野解析**——边存在性不该依赖对端是否活跃；邻居检索仍按 `includeArchive` 走（那是有意降噪）。教训：**把「邻居检索的降噪口径」复用到「边存在性」上，是两种语义混用**；判据要分别写（R10 反例）。
    - **落地判据**：`npm test` **515/515**、`npm run test:ts` **88 pass / 1 skip**；工具面 16 → 19（`memory_link` / `memory_unlink` / `memory_relations`）。

27. **2026-11-19 · 主题词表（v0.29 · 方案 §4.2 · AML 差距表 §4.2）**
    - **缺口**：`tags` 自由文本，同义词各写各的，检索只能逐字匹配；没有受控词表、没有层级、没有术语归一。
    - **设计决定（三处与 SKOS 存储形态的刻意差异）**：① **只存 `broader`**，下位由反查派生；② **`related` 只存一侧**，读时双向；③ **停用不删除**（`status:'deprecated'`，旧记忆上的标签仍要能解释）。三条同一个理由：不制造第二真源。
    - **最硬的判据是标签唯一空间**：同 scope 内 `prefLabel` 与全部 `altLabels` 归一后不得相交，冲突整笔拒绝并点名占用者。**不做词形还原/繁简转换/标点归一**——那些是猜，猜错就把两个概念合成一个。
    - **让词表活起来的那一步**：`recall({expandThesaurus:true})` 把查询词换成概念的全部其他写法再检索（缺省关闭 ⇒ 存量行为不变），展开词随结果返回 `expandedTerms`——**扩展改了排序就必须看得见**。
    - **踩坑（同一个坑第十五次）**：`index.ts::conceptSchema` 必须声明全部 9 个字段（含嵌套 `revisions`），否则写入边界静默剥掉而写入仍返回成功；A133 用 `conceptSchema.parse()` 真校验。
    - **顺带修的**：§5.21 落笔时把「## 7 · 可证伪验收」标题整行吃掉（编辑锚点把标题当分隔符替换了），本次一并补回——**文档结构缺陷不会自己报错，只有回头读到才发现**。
    - **落地判据**：`npm test` **524/524**、`npm run test:ts` **88 pass / 1 skip**；工具面 19 → 21（`memory_concept` / `memory_thesaurus`）；`tests/thesaurus.test.mjs` 9 条。
28. **2026-11-19 · 来源实体（v0.35）与「归属 / 依据正交」裁决（v0.35.1 · 方案 §5.2 · AML 差距表 §5.2）**
    - **缺口**：三种来源载体（内联 `source{}`、`evidenceRefs` 坐标串、`sourced-from` 边）**都回答「在哪」，没有一种承载「来源」这个对象**——谁提供、多可靠、什么权限全无处安放。
    - **语义被补充**：独立 `sources` 表（`SOURCE-0001` 每 scope 递增 / 七项字段 / 停用不删除 / 变更记录只留 5 条），条目侧加 `sourceIds?: string[]`；反查**只认显式引用**，不做「正文里提到这个网址」的猜测。
    - **语义被修正（当晚，线上首次验证时暴露）**：初版 S3 要求 `source.type === entry.provenance`，把「我读了主人给的方案、**得出他没有说过的结论**」判成错误——而那正是知识生产最日常的形状。裁决：两字段**正交**（`provenance` 答「这条归属谁」，`type` 答「这个来源是什么性质的东西」），删掉相等校验；只保留两档——**错**（悬空 id / 来源库未接线）**拒**，**不全**（有依据无归属 / 引已停用来源）**过 + 回执点名**。后一档尤其不能拒：「那条依据已被撤销」本身就是要记录的事实。
    - **教训（这条比改动本身值钱）**：**单测把负向路径测透了，正向通路被堵死而不自知**——三条负向断言全绿，掩盖了「正常形状走不通」。校验型功能必须**成对**测：该拒的拒、**该过的过**、该提示的提示、正常路径**不提示**。同晚 §8.3 的教训（把正常当错 ⇒ 判据没有分辨力）换了一层皮又出现一次。
    - **另一个同形缺口**：新增返回键 `sourceNotice` 必须同步进 `output.schema`（宿主 `additionalProperties:false` 会整条拒收），为此补 S3f——因为 `schema-parity` 的通用守卫只覆盖 `recall` / `memory_browse`，**`remember` 一直是这块的盲区**。
29. **2026-11-19 · 遗忘传播（v0.36 · 方案 §10.4 · AML 差距表 §10.4）**
    - **缺口**：`forget` 只做单条软归档——删了记忆，指向它的关系边仍然「有效」、概要的 `archiveRef` 仍然指着一个不存在的原料、而**没有任何凭证说明处理过什么**。
    - **先做边界，再做能力**（这条是本轮的方法论收获）：方案列九处传播面，本插件只拥有其中四处的一部分。所以设计正本的第一个产出不是「能力清单」而是**边界表**——原始来源在宿主会话日志、备份在仓库与快照层、向量索引定调不做、全文索引与正文同体、画像因缺 `entry → entity` 边定位不到。**「不拥有却声称已传播」与「什么都没做」是同一种谎**，故这三处（`host-log` / `backup` / `entities`）每次都在反馈与凭证里点名。
    - **语义被补充**：三种操作（`mode=entry/topic/all`）+ 逐面传播计划（纯函数 `planForget`）+ 四段反馈（结果行 / 传播面 / **未覆盖面** / 凭证 id）+ 侧车凭证（字段白名单，不含被删内容）。
    - **两个刻意的不做**：① **不改 `archiveRef`**——它是压缩历史，改了等于篡改「这条概要由哪些原料压成」；只报引用条数、把重压判断留给人。② **不提供硬删除**——本插件删得掉 `entries` 表，删不掉宿主日志与备份层；单方面 purge 会让人以为「已删干净」，**声称删干净的伤害大于不做**。
    - **判据设计**：F3 用**两个独特标记**（`Zj7Q` 标题 / `Wq9X` 正文）去 grep 凭证，反证「可对账、不可反推」；F2 里 `access-trace` 的 `count` 写死 0 并强制它出现在列表里——**沉默地不列它，读者会以为漏了一处**。落地：纯函数 10 条 + 端到端 5 条；全家 **583/583** + 88（1 skip）。
    - **顺带**：`A72` 的「旧文案逐字」被这轮改动正当地取代了——方案明写「不能只返回『已经忘记』」，故零回归的语义收窄为「首行文案不变」，新增段落由 F 段守。
30. **2026-11-19 · 操作者审计流（v0.37 · 方案 §11.4 · AML 差距表 §11.4）**
    - **缺口**：`role.ts::admitsEntry` 是**布尔函数**——权限拒绝被压成一个 `false`，被拒的条目静默消失在结果里。于是方案 §13.3 那一项「高风险权限违规 = 0」**没有判据**：不是因为没违规，而是因为**违规不可见**。同理，遗忘凭证记了「传播到哪些面」，却**没记谁发起的**；`revisions` 只留 3 条快照，而「这条被谁改过几次」比「它现在长什么样」更早消失。
    - **第一价值不是记录，是让拒绝可见**：本轮的主改动其实在 `role.ts`——把布尔判定换成 `rejectReason`（返回 `R1-kind` / `R2-space` / `R3-shared` / `R4-read`，`admitsEntry` 成为它的布尔形态，等价零回归）。没有这一步，审计流只能在「已经知道被拒」之后记一笔，而它根本不知道。
    - **八类 → 五个动作（刻意缩水）**：`write` / `update` / `forget` / `link` / `permission`。② 来源 / ③ 谁加工 / ⑤ 谁调用 由既有载体承载（`sources` 表 / `compress-trace` / `access-trace`），⑧ 异常访问不新造事件类型而由 `findBursts` 在读取侧算簇。判据是**「消费者会不会按它区分」**——八条平行流水里有一半没有读者。
    - **两个刻意的不做**：① **不做告警 / 阈值处置**（§1.3 禁自动决策；簇只给计数与首末时刻，是否异常由我判断）。② **不记读路径**（`access-trace` 已有且已有消费者；重复记会让两条流对不上账）。
    - **只记异常面（本轮的取舍，也是最容易被做坏的地方）**：放行不记、`forget({dryRun})` 不记、`memory_link` 幂等命中不记、`memory_unlink` 二次退役不记。统一判据——**审计的触发条件 = 状态确实变了，或确实被拒了**。权限拒绝的埋点只挂在主检索面（`recall` / `memory_browse`），因为 `gatherReadable` 被十五处共享，每处都记会让审计流变成没人读的洪水，而没人读的日志等于没写。
    - **判据设计（成对 + 反证）**：28 条（A 段纯函数 11 / R 段角色 3 / E 段端到端 14）。最小化用标记串 grep 反证（同凭证 F3 的纪律）；E5/E6 是成对判据（该记的记、roles 未启用时**不记**）；E7–E9 把三个零分开（未接线 / 零事件 / 有动作无拒绝）；E10 守 `output.schema` 对齐（`memory_trail` 是新工具，宿主 `additionalProperties:false` 是这块的盲区）。**尸体验证**：白名单改成原样返回 + 拒绝计数写死 0 ⇒ 4 条红（A1/A2/R2/E5），恢复后 26/26 绿。
    - **一处诚实登记（不是疏漏）**：零命中时 `forget` 是 fail-loud 抛错（既有护栏），所以「零命中记 `rejected`」那条分支**不可达**——直接删掉，而不是留一段永不执行的代码假装覆盖了。留下的是判据 E3b：抛错前没有动作发生 ⇒ **不写审计**。
    - **工具面 25 → 26**（`memory_trail`）：`tests/audit.test.mjs` 的硬编码计数与 `tests/tools.test.ts` 的名称清单同批同步（这两处每漏补一次就变成恒红，而恒红的断言不再是指标）。
    - **落地判据**：`npm test` **611/611**、`test:ts` **88 pass / 1 skip**；工具面 25 → 26；设计正本 `docs/design/aml-audit.md`。
    - **线上验收抓到两个单测看不见的缺陷（同日修）**：① `readActorAudit` 把「文件不存在」与「读不到」都折成 `undefined` ⇒ 新部署的插件永远显示「未接线」，而实际只是还没有事件——**本模块要修的假读数出现在自己的读数层上**；ENOENT 改回首插空结构，判据 A10。② `memory_trail` 用 `shortId` 直接截前 8 位渲染操作者，而会话 id 形态是 `session-<uuid>` ⇒ 每个会话都显示「会话 session-」，**在最关键的「谁」这一维上零区分度**；改 `shortActorId`（剥共通前缀再截），判据 A11。⚠ **为什么单测没抓到**：夹具用的 sessionId 是 `session-audit`（短），截断不出形——**夹具的 id 形态与生产不符时，渲染缺陷会整批隐形**。

31. **2026-11-19 · 双时态（v0.38 · 方案 §9.3 · AML 差距表 §9.3）**
    - **缺口**：方案要求三轴（发生 / 进入系统 / 失效），本库只有「进入系统」（`createdAt`）。后果可指认：追记上周的事时 `memory_browse` 把「我何时记下」当成「何时发生」；「今天下午 3 点开会」过了 3 点仍被当有效，而 `reviewAfter` 救不了——它答「该何时重看」，文档自己写着「到期 ≠ 作废」。
    - **四轴齐，且两两不可合并（本轮的裁决核心）**：`occurredAt`（事件）≠ `validAfter`（适用）——情景类记忆没有「生效」可言、语义类结论的核心是适用范围，两者是**不同 memType 的主轴**；`expiry`（事实维）≠ `reviewAfter`（提醒维）；`expiry`≠`supersededBy`（时间到了 vs 被顶掉）；`expiry`≠`archived`（读数 vs 处置）。
    - **两条纪律**：① 过期是**派生读数**（`expiryStateOf` 按 `now` 现算，不预存档位——预存就与读取时刻脱钩，`staleness` 已踩过）；② 过期**不改生命周期、不自动归档**（六态里没有「过期」这一态，也不该有；把过期自动判成 archived 会把「时间到了」和「我决定不再用它」混成一个动作）。
    - **一处刻意的不对称（写进契约，不是疏漏）**：新字段**原样保留 ISO 时刻**（事件时刻的价值常在分钟级），而 `validAfter` 一律取 UTC 日——那是 v0.24 已发布的契约，改它要动存量。
    - **踩坑（同一个坑的新形态）**：`entrySchema`（写入边界）、`EntryDraft` / `EntryPatch`（store）、`RecallResultItem` 投影（search.ts）**四处都要声明**；漏了投影层时 tsc 当场报（`auto-inject` 用 `r.expiry` 报「不存在」）——**这次是类型系统替我抓住的**，而不是线上。另：`schema-parity` 的 A117 主动报「夹具未落盘 `occurredAt` ⇒ 该判据对该字段恒真」，按守卫要求补了夹具（**守卫发现夹具不覆盖，正是它存在的理由**）。
    - **落地判据**：`tests/temporal-dual.test.mjs` 12 条（T1–T12），尸体验证 6 红；全家 **623/623** + 88 pass（1 skip）；差距表 §9.3 ❌→🟡（6/33/18）。

32. **2026-11-19 · 七类保留策略（v0.39 · 方案 §10.1 · AML 差距表 §10.1）**
    - **缺口的真形状与最初判断不同（这一轮最重要的事）**：差距表写「七类覆盖率 1/3071」，我据此判过两次「§10.1 空转、不做」。把分母拆开重算后：活跃 1789 − 桶概要 11 − 压缩检查点 18 = **真分母 1770 条人工写入**，`memType` 覆盖率 **1.1%**（`space` 同为 1.1%）。而同一批条目里 `aliases` **47.5%** / `cue` **36.3%** / `watchFor` **32.5%** / `provenance` 17.9% / `grounding` 13.4%。**分界不是字段新旧**（v0.15 的 `aliases` 远高于 v0.26 的 `memType`），是**填了有没有后果**——前三个直接改变检索命中，`memType` 当时不改变任何行为。⇒ 原来的「覆盖率不到就不做」是**因果倒置**：做了策略，覆盖率才可能上来。
    - **另一处自我校正**：我先把方案 §3.1「七类并非互相排斥」读成「`memType` 该多值」，据此差点记一条「与方案不符」。读原文后确认：原意是**一次原始事件派生多条资源 + 关系边**（每条仍单类型），单值实现**符合**方案。**读规格不能读转述**——差距表的压缩把「派生多资源」这个前提吃掉了。
    - **设计：后置修正层，不动 `classify()`**。基础四档回答「这条值不值得继续占位置」，与类别无关；本层在它之上按**生效类别**修正档位。改成「重写 classify」会让「未分类条目逐字不变」无法断言——而那是 98.9% 条目的零回归保证（R3）。
    - **回退口径只认语义同构**：`kind='episodic'`→`episodic`、`kind='fact'`→`semantic` 允许推导（同一个词的两种写法 / 方案定义里同一类）；`kind='knowledge'` 可被五类解释 ⇒ `unknown`，**推不出就不推**。三档 `source`（`explicit` / `derived-from-kind` / `unknown`）始终可辨——推导**不是**给条目补字段，存储里 `memType` 仍为空。
    - **实测出来的配置耦合（写进 §5.32 边界第 ③ 条）**：缺省 `audit.archive_min_age_days = 14`，所以 age>90 且无 `role`/`refs` 的条目基础档已是 `ARCHIVE`，而修正层不把 `ARCHIVE` 降到 `DEMOTE` ⇒ `E-decay` 实际只对有**归属或承重**的老情景记忆生效。改那个参数会连带改变本节的覆盖面，而耦合不会报错——所以两处必须一起看。
    - **判据纪律上的一处收获**：首次尸体验证时「去掉 `unknown` 零修正」全绿——不是判据没分辨力，而是它的四条夹具**全都「不触发任何策略」**，所以「给 unknown 塞默认类别」也不会红。补了一条带 `expiry` 的知识条目后，该破坏形态立刻红 4 条。**夹具只覆盖「不触发」的路径，等于没覆盖「不许触发」这条纪律。**
    - **落地判据**：`tests/retention.test.mjs` 15 条（R1–R11），尸体验证 5 处各红 1–4 条（复跑脚本 `scripts/corpse-retention.mjs`）；全家 **637/637** + 88 pass（1 skip）；工具面仍 26（无新工具，只加读数块与渲染行）。
    - **线上验收（15:05–15:07，两次重启）**：① `memory_stats.retention` 出现且 `explicit 24 + 按 kind 推导 830 + 类未知 2243 = 3097 = total`（口径自洽）；② `needsAction.episodic = 47`——**真实行动信号**（47 条情景记忆超 90 天）；③ `policyApplied = 0`，原因是配置耦合（那 47 条基础档已是 `ARCHIVE`）。⚠ **第 ③ 项暴露一个读数缺陷并当场修掉**：`needsAction 47` 与 `改档 0` 并列显示会被读成「47 条处理了、0 条改档」的矛盾——两个数回答不同问题，必须各自标明口径。改渲染（拆两行 + 标「信号数，不等于改档数」）、改两处 schema description、加判据 R11 把该形态钉成契约（A183）。**这是线上验收第三次抓到单测看不见的东西**（前两次：v0.37 的 ENOENT 误报与短 id 零区分度）——共同点是**读数层自身的表达缺陷**，而单测只验数值不验「数值放在一起会不会被误读」。

## 10 · 未决问题

- **U16 审计流目前只能覆盖「读准入」（v0.37 · 方案 §11.1 未建）**：`permission` 动作记的是 `role.spaces` / `role.kinds` / `role.read` 这四条**读**准入的拒绝；写 / 改 / 管三类权限**没有分级载体**（`role` 只约束读），所以「谁被允许改这条」不存在，也就无从审计。§11.1 一旦落地，本流会自然长出 `write-denied` / `manage-denied` 两类而**不需要改契约**（`code` 是自由字符串不是固定枚举）——这是那个取舍的收益，也是它的代价：**固定枚举会拒绝新形状，自由字符串让新形状不被识别**（读取侧对未知码原样显示、不猜）。另：拒绝总数是**下界**，因为只有主检索面被埋点。

- **U14 DREAM 论文剩余部分的迁移评估（四项明确不迁移；其中 ④ 为同日追加的实测裁决）**：① **扰动探测 / `sim`+`pret`+`E_coh` 三维诊断** —— 强依赖 embedding，本插件词法检索 ⇒ **不迁移**；② **怀疑分 `s`（Eq.10 累积-衰减）** —— 本系统**没有怀疑模型**（没有「这条是错的」信号源），硬造等于判断代填（AGENTS.md §2.4）⇒ **不迁移**；③ **相对阈值 `µ−ησ`（Eq.8）** —— **实测无分辨力**：真库审计分 µ=0.267 / σ=0.093、近对称（偏度代理 0.07），按论文自己的 η=0.8 ⇒ 选中 **29.0%**（≈三分之一库）；要它可用得把 η 推到 1.5~2.0（3.9% / 0.1%）。**机制解释（可移植）**：`µ±ησ` 的分辨力全部来自**有尾的那一侧**——重尾量的低侧恒 0%、高侧才有分辨力（体量 3.7% / 年龄 12.9% / 次数 1.8%）；而复合分（归一项加权和）按 CLT 天生近钟形、两侧各约 4%，它选中的「异常」就是**正常分布的一成**。⇒ **相对阈值不是「更先进」，是「在无量纲量上的唯一选择」**：有单位的量（字符 / 天 / 次数）用绝对阈值更可复现，硬搬相对阈值会让阈值**随语料漂移**。④ **权重衰减 `w·exp(−λ)` + 在线巩固 `cᵢ`（Eq.11–13 / 附录 G）** —— **待条件**：衰减的调制项是「巩固」，而本插件**没有「被用过」信号**（`hits` 是「被检索」不是「被采用」）；论文的 `cᵢ` 吃的是 `U_t`＝任务成功信号，本系统无此信号源。**⚠ 原先给 ④ 的理由（「按年龄硬衰减会误伤长尾」）已于同日被探针推翻**——非侵入式评估（不改源码，拿 `recallEntries` 自己的打分 × 候选权重重排，与「把权重乘进 `scoreEntry`」数学等价；`_tmp_review/mem-influence-eval.mjs`，真库 1930 条 / 10 个真实查询）：负对照 w≡1 **全组 0 变化**（装置不自造读数）、承重条目被换出 **0**（②成立）、长尾误伤专项 **0/10**。⇒ 真因不是参数，而是**语义错配**：DREAM 的 `w` 是 **harm 权重**（压制毒化记忆），本库没有 poison，只有「没被读过的相关条目」——**「没用过」≠「有害」**；亲读换出清单显示它把「**相关**」换成了「**常被读**」（例：对「论文 投稿 arXiv」字面对口的《论文提交前的外部复核》因归因仅 0.02 被压出 top10）。⇒ **不迁移**——换参数解决不了语义错配；改成只作用于 auto-inject 注入面**同样错配**（注入面要的也是「与当下消息相关」）。**顺带记一条论文自身的边界**：附录 H 只扫了 `σ/λ₀/k/α_rec` 四个参数，**η 从未做敏感性实验**（其取值 0.8 无实验支撑）。

- **U15 v0.12「检索别名」的契约节缺失（2026-10-14 由 v0.15 落文档时发现）**：§1 版本行原写「见 §5.14」，但 **§5.14 从未存在**——v0.12 只写了 `src/types.ts` 的 `Entry.aliases` 大段注释 + `tests/aliases.test.mjs`，没落语义文档节；而本次 v0.15 把 §5.14 这个编号用掉了 ⇒ 那条引用**永久指向了别的东西**。**当前处置**：§1 已改为指向实际正本（`types.ts` + 测试），**不假装有一个节**。**待办**：补一节「检索别名契约」（编号顺延，如 §5.15），内容从 `Entry.aliases` 的注释与实测提炼（3 个案例从 #2/#4/#5 升到 **#1** + 3 个无关查询**零污染**的对照）。⚠ 同层还有一处：§10 的 U 编号**不连续**（U14 排在 U1 之前、U12 出现两次）——同属「这一层缺一次整理」，但与判据无关，暂不动。

- **U1 ~~端到端幂等如何补~~ → 已解决（2026-09-13）**：采纳方案 ① 的**强化版**——不是 scope 级单飞，而是按 (scope, level, bucket) 串行（粒度更细、并行度更高；scope 级会把该 scope 全部桶串行化）+ 写前复核兜跨进程。**遗留（需主人裁决）**：库中 4 对历史重复桶是否去重（`forget` 软归档其中一份即可，但动记忆数据属须请示类）。
- **U2 ~~测试记账三处不一致~~ → 已解决（2026-09-13）**：新增 `test:ts`（76 项，node ≥24）与 `test:all`（201 项）；README 数字回填实测（125 + 76）。**遗留**：`.ts` 套件在 node 22（WSL 侧）不可跑——已在脚本旁注明前提，未强制统一运行时。
- **U3 压缩触发源不可分辨**：懒压缩与周期补压写出**同形**概要（`source.reason` 只记层/桶/原料数，不记触发路径）→ 生产数据无法回答「这条是谁压的」。倾向：在 `reason` 里加触发源标记（`lazy`/`periodic`），便于事后判别机制存活。
- **U4 ~~README / 测试名的 `wakeup=false` 文本~~ → 已解决（2026-09-13）**：四处（`README.md` §压缩即记忆、`tests/compaction-sink.test.ts` 头注 + 测试名、`DESIGN.md` §十 表格与通道 C 段）全部改为 `wakeup=true` 完成即送达，并标注 2026-08-16 修正来源；权威语义以行为与本文档为准。
- **U5 年层与 `deprecated` 路径缺正向验证**：年概要从未产出（因 2026 年未结束）；同时「压缩链能否上探到年」没有测试或 dry-run 证据。倾向：补一个注入固定时钟的链式压缩测试（day→week→month→year 全链）。
- **U6 `memory_check` 的对外承诺**：工具描述说「查看待沉淀建议」但恒空。倾向：要么下线该工具，要么在描述里更醒目地标注「未接线」（当前已有说明，但工具名本身仍是承诺）。
- **U7 存量条目的隔间归属（需主人裁决）**：674 条存量条目全部为共享记忆——这对迁移安全是优点，对幽灵隔间是缺点（幽灵可读到全部历史）。选项：① 保持共享（靠独立 `DSH_HOME` 做真隔离）；② 一次性把某批 tag 的条目回填 `role`（= 批量改记忆数据，属须请示类）。倾向 ①。
- **U8 记忆生命周期与价值体检（MAGE 借鉴的下一步）**：~~① 只读体检器（按 ν(x) 排序输出「GC 候选/应降级/应保留」）~~ → **已交付 v0.6**（`memory_audit` + 侧车用量轨迹，见 §5.9）。**仍缺**：② **双时态**（`validFrom/validTo`）+ `supersedes`/`invalidates` 链（现在只有布尔 `archived`，删除不留失效证据）；③ **事件超边层**（多主体共同产出的事件作为一等条目——v0.5 的 `role` 只解决分区，不解决「谁+什么动作+哪份证据共同产出了这个结论」）；④ 权重校准（需要「提案被采纳/否决 + 事后是否后悔」的样本）。
- **U9 注入的「该不该」与「好不好」（v0.7 线上观察）**：重心化解决了「按什么查」（相关性翻倍），但暴露两个新问题：① **唤醒类消息是否该触发注入**——`[守护] web 已重启` 是系统事件，不是对话，给它注入运维历史条目价值存疑（现触发面为 GUI/telegram 主人消息，唤醒消息走在同一条路上）；② 现指标只数**条数与次数**（注入 6 次 / 命中 12 条），**没有质量口径**（"这次注入有用吗"）。倾向：先加一个**可选的判定信号**——注入是否被后续动作引用（如注入后我是否 `recall`/`update` 了其中某条），再谈是否排除唤醒触发。**未决，需主人视角**。
- **U10 ~~压缩缺口~~ → 已解决（2026-09-15 当晚闭环）**：症状是缺 `日概要 2026-09-13` / `日概要 2026-09-14` / `周概要 2026-W37`（全库 grep 无，含归档）而原料充足、单位已结束。**证据层（v0.8.0）首跑即定案**：`scan` 显示三桶判定**完全正确**（`pending`），失败在总结调用；两次真因——① **缺会话 id**：`GenerateOptions` 无 `sessionId` ⇒ 宿主插件 `dsh-x-opencode-session` 不加 `x-opencode-session` 头 ⇒ 网关拒单（原文即轨迹里的 `Error from provider (Console Go): Request is missing x-opencode-session…`）⇒ 修 v0.8.1（lazy 用 `agent.session.id`；periodic 把会话 id 与路由同源取出）；② **输出预算不足**：路由通了以后触 16,000 token 上限被 fail-closed，实测单份概要 12,233 / 12,919 / 17,436 字符（≈18–26k token）⇒ 修 v0.8.2 + `maxTokens` → 32000。**验收 A67 症状消失**（三桶全部 compressed、原料冷归档）。**教训（已写进知识条目）**：提示词里的字数预算是**劝告性**的（模型超写 2×），**硬约束只能来自 token 上限**。
- **U13 `memory_health` 的「最近待压」口径易误读**：该数字取自**最近一条 `scan`（= 每轮压缩的首扫）**，因此一轮成功压缩后它仍显示压缩前的待压数（实测：显示「最近待压 3」而同一轮已压缩 3 单元）。语义没错（首扫快照）但措辞易读成「当前还剩几个」。倾向：改标签为「首扫待压」，或让 `end` 记录带收尾时的 pending（恒 0，信息量低）——**待下次发布随手修**，不单开一轮。
- **U12 ~~夹具硬编码派生值~~ → 已解决（2026-09-15）**
- **U11 侧车开关有两处未接线（诚实声明）**：`audit.access_trace.enabled` 与 `audit.proposal_log.enabled` 会被解析、写进配置对象，但 `index.ts` 的 writer 直接调 `appendAccessTrace` / `appendProposalRecord`，**不读该开关** ⇒ 设 `enabled: false` 目前**不生效**（文档曾承诺「可关」，属声明与实现背离）。v0.8 只把 `compress_trace` 接通到各 workspace 配置（`makeCompressTrace` 读 `cfg.audit.compressTrace`）；另两处需要把 config 传进 writer 签名（独立小重构），**未做**。倾向：与下一次触碰 `tools.ts` 的改动合并处理，避免为开关单独动一次组合。
- **U12 ~~夹具硬编码派生值~~ → 已解决（2026-09-15）**：`role.test.mjs` / `audit.test.mjs` / `centroid.test.mjs` 三处把 `WID` 写死为 `'c:/Users/Alice/proj'`，而 POSIX 下 `resolve()` 语义不同 ⇒ 作用域不匹配、12 个 A 测试在 node 22/WSL 侧静默红（**Windows 侧一直绿，所以长期未被发现**）。改为调用 `workspaceIdOf(CWD)` 派生后双平台同源：WSL mjs **179/179**、Windows `test:all` **261（260 pass + 1 skip）**。**遗留**：`.ts` 套件在 node 22 仍不可跑（需 node ≥24，见 U2）——已在脚本旁注明前提。
