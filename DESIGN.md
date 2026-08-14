# dsh-agent-memory 设计文档

> 状态：设计定稿（v0.1 规划） · 2026-08-14 · 中文为主
> 设计者：天才爱丽丝 & 主人（Jonathan）

---

## 〇、设计总纲（最高原则）

**程序系统只是工具和框架，重要的决策与行为由智能体自己决定。**

框架层负责提供可靠的条件与约束：
- 存储与持久化（怎么存、不丢不坏）
- 作用域路由（存哪个项目库）
- 时间刻度与触发（何时该压缩、归档）
- 检索管道（怎么找、怎么排序）
- 去重与完整性（防膨胀、防冲突）
- 工具面形状（remember/recall 接口）

智能体决策层负责一切内容判断：
- **记什么**——信号来了，值不值得沉淀由 agent 判断
- **怎么组织**——标签、结构、正文形态
- **概要写什么**——周记的重点、详略、是否含待办
- **何时 recall、怎么用**——检索是 agent 的主动行为
- **更新与遗忘**——哪些旧条目该合并、该归档

框架不预设答案，只保证问得出、存得下、找得到。

---

## 一、定位

跨会话的「经历库」：主人偏好、项目知识、决策理由、学习沉淀——结构化写入、可检索读取、可整理压缩。与现有载体互补：

| 载体 | 角色 | 关系 |
|---|---|---|
| 会话日志（事件溯源） | 过程记录 | 记忆的原料与证据 |
| AGENTS.md（SOUL） | 灵魂/常驻人格 | 静态；记忆是增量经历 |
| docs/ 报告 | 手工知识库 | 可被 bootstrap 吸收 |
| 本插件 | 跨会话经历库 | 统一读写接口 + 检索 + 时间压缩 |

## 二、记忆模型（四层）

| 层 | 内容 | 形态 | 时间压缩 |
|---|---|---|---|
| L1 事实记忆 | 主人偏好、环境事实、决策结论 | key-value 条目（可精确覆盖） | **永不压缩**（常青） |
| L2 知识条目 | 项目知识、学习沉淀、教训 | 结构化条目：标题+正文+标签+来源 | **不压缩**（只去重/更新/冷归档） |
| L3 情景记忆 | 重要事件/经历时间线 | 追加式事件 | **压缩**（日→周→月→年） |
| L4 程序记忆 | 技能/流程 | **复用已有技能系统，不重做** | — |

### 条目结构

```
Entry = {
  id: string            // uuid
  kind: 'fact' | 'knowledge' | 'episodic' | 'summary'
  key?: string          // L1 精确键（覆盖语义用）
  title: string
  body: string          // markdown，自由正文
  tags: string[]        // 可选元数据（agent 自主决定）
  scope: 'global' | workspaceId
  createdAt / updatedAt / accessedAt: iso
  level: 'day' | 'week' | 'month' | 'year' | null  // L3 压缩层级
  bucket: string        // 时间桶键（自然周/月/年）
  archived: boolean     // 冷归档标记
  source?: { sessionId?, seq?, reason? }   // 溯源
  archiveRef?: string[]  // 概要→原始条目引用
}
```

## 三、作用域分层（解决项目差异）

```
agent-memory/
├── global/                  // 跨项目：主人偏好、通用知识
└── workspaces/<workspaceId>/  // 每项目独立库（对齐 DSH workspace 机制）
```

- **自动路由**：会话属于哪个 workspace（DSH 已知），默认读写该库 + global
- **物理隔离**：项目 A 的记忆不污染项目 B 的检索
- **跨项目查询**：显式 `scope` 参数

## 四、项目记忆配置（.dsh/memory.yml）

每个项目根目录放 `.dsh/memory.yml`（缺省用默认模板），声明该项目**自己的记忆形态**：

```yaml
# 示例：重工程项目（如 AlphaFactory）
scope: workspace            # 检索范围：仅本项目
layers: [fact, knowledge, episodic]
auto_sink: true             # 允许框架投递沉淀提示
timeline:
  day: true                 # 保留日条目
  week: true                # 7 天 → 周概要
  month: true
  year: true
  archive: keep             # 冷归档保留（不删）
weekly_template: "总结本周进展与数据，如有未完成事项请单列"
max_entries: 2000

# 示例：轻项目（如 alice 本体）
# scope: global-first, layers: [fact, knowledge], auto_sink: false
```

模板是「建议结构」不是字段校验——agent 判断没有待办就不写待办。

## 五、时间刻度机制（年月周日）

**只作用于 L3 情景记忆**（L1/L2 不衰减）。

```
日 = 自然日（细节条目）
周 = 自然周（周一起）   ← 日条目满自然周 → agent 总结为周概要
月 = 自然月           ← 周概要 ×4 → 月概要
年 = 自然年           ← 月概要 ×12 → 年概要
```

### 概要形态（灵活多变，不固定字段）

- **底（插件保证）**：标题 + 时间范围（自动）+ 自由正文 + 自动元数据（来源条目数/归档引用）
- **形（agent 自由）**：流水账/要点/决策记录/教训/数据表皆可；可选元数据（kind/tags）是捷径不是必须
- **模板可配**：weekly_template 只是建议结构
- 检索兜底：正文全文可搜，结构变化不影响 recall

### 触发时机（懒压缩，不用 cron）

新时间单位第一次访问记忆时，把上一单位补压缩（周一首访 → 自动补压上周；项目久未活跃 → 首访一次性补压）。

### 归档策略

原始条目**冷归档保留**（不删、可深挖、不进活跃检索）；显式 `includeArchive` 可查。

## 六、输入通道（记忆从哪来）

| 通道 | 触发 | 写入内容 | 备注 |
|---|---|---|---|
| A 显式写入 | 主人 `remember` / agent 自觉 | 任意 | 基础通道，不指望它扛全部 |
| B 信号沉淀 | 框架检测高价值信号 → 投递轻量提示 → **agent 自主决定** | L1 纠正/偏好、L2 教训、L3 完成 | 开关 auto_sink；提示可忽略 |
| C 压缩即记忆 | /compact 成功 → checkpoint 摘要自动落库 | L3 情景 | **与 dsh-agent-compact 咬合，零新成本** |
| D 周度提炼 | 周压缩时回看本周条目（+可选会话标题） | 周概要 | v1 走 LLM 直调；会话深挖为 v2 |

### 防失控三机制

1. **去重合并**：写入前查同 key/同指纹（归一化 hash）——命中则更新不新增
2. **质量协议**（写进工具 description）：记事实/可复用知识/有结果的情景；不记临时状态/文件可索引内容/凭证
3. **冷启动 bootstrap**：安装时一次性吸收 AGENTS.md 量变记录、docs 报告要点——第一天就有内容

## 七、检索管道

```
recall(query, { kind?, tags?, since?, until?, scope?, limit?, includeArchive? })
```

- v1：标签过滤 + 关键词/全文匹配，按相关度 + 新鲜度（accessedAt）排序
- 结果标注层级："这是月概要，原始条目已归档，需要深挖吗？"
- 时间查询一等公民：since/until 按 bucket 走索引
- v2 候选：BM25 → 向量语义检索（需 embedding API，另行评估）

## 八、工具签名（模型视角，中文 description）

```
remember(text, { key?, kind?, tags?, scope? })   // 写入/覆盖/合并；返回 id + action
recall(query?, { kind?, tags?, since?, until?,
                 scope?, limit?, includeArchive? })  // 检索；返回条目 + 层级标注
update(id, { text?, tags? })                     // 修订
forget(id, { reason? })                          // 归档（不进活跃检索）
memory_stats({ scope? })                         // 各层/时间桶/归档计数
memory_check()                                   // 主动查看待沉淀提示（通道 B 的主动侧）
```

## 九、存储与对接（站在官方 storage hub 上）

- 对接 `ctx.storage`（hub）+ `storage-domain`（`ctx.storage.domain`，kv facet）：条目按 id 存 kv，value = 条目 JSON
- 派生索引（tags/bucket）内存构建 + 定期落盘；或从条目重放重建（事件溯源哲学）——实现时取证 kv 的批量查询能力后定
- 规模权衡：v1 条目量小（数百~数千，每条约 KB），recall 拉取过滤可接受；v2 再评估索引升级
- **零 token 成本**：storage hub 不注入 prompt（官方 README 明说）

## 十、与 dsh-agent-compact 的分工（双尺度记忆）

| 尺度 | 对象 | 周期 | 产物 |
|---|---|---|---|
| 会话压缩（dsh-agent-compact） | 单次对话 | 会话膨胀时 | checkpoint（agent 自总结） |
| 记忆压缩（本插件） | 跨会话经历 | 日→周→月→年 | 层级概要（LLM 直调总结） |

**关键决策**：记忆压缩走 `summarizeWithLlm`（LLM 直调）而非 agent 收件箱——因为输入是「记忆条目」（文本可控、规模小），无需 KV cache 优势，且不打断 agent 当前轮次。通道 C 例外：checkpoint 本就是 agent 自总结产物，直接落库不重复总结。

## 十一、里程碑

- **v0.1 MVP**：四层条目 + kv 存储 + remember/recall/update/forget/stats 工具 + 作用域路由 + 去重合并 + 项目配置骨架
- **v0.2**：年月周日压缩（LLM 直调 + 冷归档 + 模板）+ 时间查询
- **v0.3**：通道 C（compaction 联动）+ 通道 B（信号沉淀提示）+ bootstrap
- **v1.0**：全配置项落地 + 文档 + 发布（`dsh-plugin` topic）

## 十二、开放事项（实现前取证）

- storage-domain kv facet 的批量查询/遍历能力（决定索引方案）
- 工具注册到 standard 预设的接入方式（沿用 dsh-agent-compact 的宿主解析经验）
- 信号检测的可靠事件钩子（turn/end、command/done、user message）
- 与 dsh-agent-compact 的落库钩子（compaction/end 事件的消费点）