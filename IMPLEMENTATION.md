# dsh-agent-memory 实现规格（IMPLEMENTATION.md）

> 配套 [DESIGN.md](DESIGN.md)（设计意图）· 2026-08-14 · 本文件是团队成员唯一依赖的工程契约
> 状态：**v0.1 MVP 完成 + v0.2 增强完成**（166 tests / 165 pass；冒烟 MEMORY_OK → V02_OK）· 更新记录见文末
> 原则：读不到本文件以外的讨论；一切接口、格式、验收以本文为准；标注「取证」处实现者自行查证源码后定

## 0. 实现完成状态（2026-08-14）

- 全部任务完成：T0 骨架 / T1 store / T2 config / T3 scope / T4 search / T5 tools / T6 timeline+summarizer / T7 集成
- 全量测试 **151 tests / 150 pass / 0 fail**（1 Windows 平台跳过项）；pnpm build / typecheck 通过
- at-test headless 冒烟：**MEMORY_OK**，六工具可见
- **接入方式（bundle）**：package.json `dsh.bundle.patch` → `cordis.patch.yml`（自包含挂载 storage → storage-json → storage-domain → agent-memory）；profile 只需 link: 依赖 + bundles 列表加入 dsh-agent-memory

## 0.1 实现期取证结论（回写）

- **storage-domain 服务**：函数插件（name='storage-domain'，inject=['storage']），apply 内 ctx.provide('storageDomain', facility)；需先挂载 dsh-storage + 后端（json/sqlite）
- **domain 名限制**：/^[a-z][a-z0-9_]*$/（不允许连字符）→ 域名用 agent_memory
- **Domain 打开**：ctx.storageDomain.open(spec) + ctx.effect(() => () => domain.close(), ...)（官方 workspace 同款）；domain.table('entries') → KvTable<string, Entry>
- **KvTable 能力**：get/put/delete/entries()/keys()/size/update（原子 RMW）；read 同步内存、write 持久化后生效——recall 全量拉取过滤可行
- **workspace 归属**：exec.agent?.session.header.cwd（官方 tool-fs session-cwd.ts:24）；workspaceId = 规范化绝对路径
- **工具注册**：函数插件形态 ctx.tools.register(defineTool(...))（tool-fs / dsh-agent-teams 同款）
- **zod 版本**：官方 workspace 用 zod ^4.4.3（v4）；schemastery object 字段默认可选（不需要 .optional()）

## 1. 工程骨架（T0）

参照 `self-plugins/dsh-agent-compact` 的工程形态：

```
dsh-agent-memory/
├── package.json        // name: dsh-agent-memory, type: module, main: lib/index.js
│                        // exports: . -> lib/index.js + lib/types/index.d.ts
│                        // files: [lib], license: MIT
│                        // peerDeps: @deepseek-ai/cordis, @deepseek-ai/dsh-agent,
│                        //   @deepseek-ai/dsh-storage, @deepseek-ai/dsh-storage-domain,
│                        //   @deepseek-ai/dsh-llm, @deepseek-ai/dsh-session
├── tsconfig.json       // 同 dsh-agent-compact（strict, rootDir: src, outDir: lib/types）
├── src/
│   ├── index.ts       // 插件入口：export class AgentMemoryPlugin（或 function plugin 形态，取证）
│   ├── types.ts       // 仅类型：Entry, MemoryConfig, RecallQuery, RecallResult
│   ├── config.ts      // memory.yml 解析 + 默认值（T2）
│   ├── store.ts       // 存储层：条目 CRUD + 去重合并（T1）
│   ├── scope.ts       // 作用域解析：当前 workspace → 库定位（T3）
│   ├── search.ts      // 检索管道：标签+全文+排序（T4）
│   ├── tools.ts       // 工具注册：remember/recall/update/forget/memory_stats/memory_check（T5）
│   ├── timeline.ts    // 时间 bucket + 懒压缩触发 + 冷归档（T6）
│   └── summarizer.ts  // LLM 直调总结（复用 summarizeWithLlm 模式，取证 dsh-compaction-basic）
├── lib/               // build 产物（gitignore）
└── tests/             // 离线测试
```

## 2. 数据契约

### 2.1 Entry（types.ts）

```ts
interface Entry {
  id: string;                       // uuid
  kind: 'fact' | 'knowledge' | 'episodic' | 'summary';
  key?: string;                    // L1 覆盖键
  title: string;
  body: string;                    // markdown 自由正文
  tags: string[];                  // 可选
  scope: 'global' | string;        // workspaceId
  createdAt: string; updatedAt: string; accessedAt: string;  // ISO
  level: 'day' | 'week' | 'month' | 'year' | null;
  bucket: string | null;           // 时间桶键，见 §3
  archived: boolean;
  source?: { sessionId?: string; seq?: number; reason?: string };
  archiveRef?: string[];           // summary → 原始条目 id 列表
}
```

### 2.2 存储（store.ts）— kv 对接（取证项）

- 首选：`ctx.storage.domain`（@deepseek-ai/dsh-storage-domain，kv facet）
- key 设计：`agent-memory:<scope>:<kind>:<id>`（scope 为 global 或 workspaceId）
- value：Entry JSON（含完整字段）
- **取证**：storage-domain 的 get/set/delete/遍历/批量查询能力；若只有单键读写，recall 采用「拉取当前 scope 全量条目内存过滤」（条目量小，可接受）；索引方案（tags/bucket）实现时定，允许内存构建+定期落盘
- 去重合并：remember 时按 (scope, key) 精确匹配（L1）或 title 归一化 hash（L2/L3）查重 → 更新不新增，返回 action: created|updated|merged

### 2.3 配置（config.ts）— .dsh/memory.yml

```yaml
scope: workspace            # workspace | global-first | global
layers: [fact, knowledge, episodic]
auto_sink: true
timeline: { day: true, week: true, month: true, year: true, archive: keep }
weekly_template: ""          # 空 = 默认建议
max_entries: 2000
```

缺省配置 = 上表默认值；文件缺失或字段缺失走默认。解析失败 fail loud（报错而非静默）。

## 3. 时间桶算法（timeline.ts）

- day bucket: `YYYY-MM-DD`（本地时区）
- week bucket: ISO 8601 周（`YYYY-Www`，周一起算）
- month bucket: `YYYY-MM`
- year bucket: `YYYY`
- 懒压缩：访问记忆时发现「上一自然单位已结束且有未压缩条目」→ 触发该单位压缩（LLM 直调总结，输入=该桶全部非归档条目，输出=summary 条目，原条目标 archived 并写入 archiveRef）
- 概要底：标题 + 时间范围 + 自由正文 + 来源条目数/引用；可选元数据由 LLM 自定

## 4. 工具契约（tools.ts，模型视角）

工具注册方式取证（standard 预设工具目录或独立 bundle 挂载；参考 dsh-agent-teams 的 bundle 形态）。六个工具：

```ts
remember(text, { key?, kind?, tags?, scope? })
  // -> { id, action: 'created'|'updated'|'merged' }
  // description 含质量协议：记事实/可复用知识/有结果的情景；不记临时状态/文件可索引内容/凭证
recall(query?, { kind?, tags?, since?, until?, scope?, limit?, includeArchive? })
  // -> { results: [{ entry 概要字段 + score + level 标注 }], total }
  // 排序：相关度（标签命中 > 标题命中 > 正文命中）→ accessedAt 新→旧
update(id, { text?, tags? }) -> { id }
forget(id, { reason? }) -> { id, archived: true }
memory_stats({ scope? }) -> { counts by kind/level, bucketCounts, archiveCount }
memory_check() -> { suggestions: [{ signal, summary }] }   // 通道 B 主动侧，无则空数组
```

## 5. 作用域路由（scope.ts）

- 解析当前会话 workspaceId（取证结论 2026-08-14：工具执行上下文 exec.agent.session.header.cwd——
  证据：官方 packages/fs/tool-fs/src/session-cwd.ts:24 `exec.agent?.session.header.cwd`，与
  dsh-tool-bash workdir 默认值同源；无 agent / header 无 cwd 时降级只走 global。
  scope.ts 以鸭子类型读取该字段，不依赖 harness 运行时，离线可测）
- 默认读写 scope = 当前 workspaceId；global 永远附加（recall 合并 global 结果，标注来源）
- scope 参数显式覆盖；scope=global 只查 global；scope=<workspaceId> 跨项目查（global 仍附加）
- 配置 scope 三态路由（scope.ts resolveScopes）：workspace（读=workspace+global，写=workspace）/
  global-first（读=global 优先+workspace，写=workspace）/ global（只 global）；
  workspaceId = 规范化绝对路径（盘符小写、分隔符统一 /、去尾部斜杠）

## 6. 任务分解与验收（AgentTeams 使用）

| 任务 | 内容 | 依赖 | 产出 | 验收标准 |
|---|---|---|---|---|
| T0 骨架 | 工程文件 + build 脚本 | — | package.json/tsconfig/src 空壳 | pnpm build 通过，lib/ 产出 |
| T1 存储层 | store.ts 全量 CRUD + 去重 | T0 | store.ts + tests | 单元测试：create/update/delete/merge/去重全覆盖 |
| T2 配置 | config.ts 解析+默认 | T0 | config.ts + tests | 缺省/部分/完整/非法四态测试 |
| T3 作用域 | scope.ts 路由 | T0 | scope.ts + tests | 单测：workspace/global/显式覆盖 |
| T4 检索 | search.ts 过滤排序 | T1 | search.ts + tests | 单测：标签/全文/since-until/排序/层级标注 |
| T5 工具 | tools.ts 六工具接线 | T1+T2+T3 | tools.ts + tests | 单测：schema 校验 + 各工具行为（mock store） |
| T6 时间压缩 | timeline.ts bucket+懒触发+归档 | T1+T2 | timeline.ts + tests | 单测：bucket 边界（周一/跨月/跨年）+ 压缩产物+归档标记 |
| T7 集成 | 组装 + 冒烟 | T5+T6 | 可加载插件 + ENGINE_OK 式冒烟 | headless profile 加载无错，工具可见 |

## 7. 成员分工建议

- 成员 A（存储）：T1 + T4（store 与 search 强相关）
- 成员 B（工具）：T2 + T3 + T5（配置/路由/工具一条线）
- 成员 C（压缩）：T6（timeline + summarizer，最后开工避开接口变动）
- 队长（爱丽丝）：T0 骨架先行，集成 T7，全程审代码

## 8. 纪律

- 所有代码中文注释（面向中文团队）；类型/导出英文
- 修改 DESIGN.md 需队长批准；IMPLEMENTATION.md 以队长为准
- 每任务完成必须自带测试，验收不过退回
- 取证结论（storage-domain 能力、工具注册方式、workspace 归属）回写本文件 §2.2/§4/§5

## 更新记录

- 2026-08-14 v0.1 完成：全任务交付 + 冒烟 MEMORY_OK；回写取证（storage 挂载链/域名限制/zod/schemastery）；T7 增加懒压缩钩子单测（151 tests）

## v0.2 更新（2026-08-14，主人驱动的设计演进）

- **memory_browse 工具**：按时间桶分组浏览（年/月/周/日），支持 kind/tags/since/until/level 过滤与分页；total=组数；组层级=概要层级或 null（DESIGN.md §七「找回旧记忆」温入口）
- **轻量检索增强**：中文停用词过滤（tokenize 去噪）——**明确不做向量 RAG**（主人决策：embedding 依赖重、索引增量维护难、重建成本爆炸；保持「索引可从条目重放重建」）
- **启动注入（inject.ts）**：会话首 pre-step 注入记忆速览（agent-instructions 同款瀑布监听器 + fold）——常驻层（global fact 全量）+ 轮廓层（概要先、近期次之，maxEntries/maxBytes 预算截断）；memory.yml 新增 inject 段（enabled/max_bytes/max_entries，默认 3000/20）
- **压缩即记忆（compaction-sink.ts，通道 C）**：订阅 session/event firehose——compaction/start→summary→end 状态机，end 无 error → checkpoint 落库（episodic，tags=[compaction]，scope=会话 cwd 的 workspace，fire-and-forget 幂等）；compaction/* 为插件扩展事件类型，运行时类型收窄（官方 SessionEventMap 不含）
- **工程**：tsconfig lib → ES2023（findLastIndex/toSpliced）；browse/inject/compaction-sink 测试（.ts 用 Node 原生类型剥离，.mjs 不可用 import type）