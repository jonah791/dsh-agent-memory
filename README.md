<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: 
  inject: 'storageDomain','tools','llm','agents'
  tools: memory_*,recall,remember,update,forget
  runtime: host-only
  envDeps: 无（纯逻辑/标准 Node）
  boundary: 无特殊授权边界
  compat: cordis ^4.0.1 / dsh-tools ^0.1.0-rc.6
-->
# dsh-agent-memory — DSH 的 Agent 驱动长期记忆插件


<p align="center">
  <a href="https://github.com/jonah791/dsh-agent-memory"><img src="https://img.shields.io/badge/version-0.2.4-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
</p>
**为 DeepSeek Harness (DSH) 打造的智能体驱动长期记忆插件。** 跨会话的经历库：主人偏好、项目知识、决策理由、学习沉淀——结构化写入、可检索读取、可整理压缩。

> 状态：v0.3（智能体核心联动已落地）。DSH 为预览版（0.1.0-rc），无兼容承诺。


## 安装

```bash
cd <你的 self-plugins 目录>
git clone https://github.com/jonah791/dsh-agent-memory.git
cd dsh-agent-memory
pnpm install
pnpm build
```

## 设计总纲

**程序系统只是工具和框架，重要的决策与行为由智能体自己决定。**

- 框架层负责可靠的条件：存储持久化、作用域路由、时间刻度压缩、检索管道、去重与完整性、工具面形状
- 智能体负责一切内容判断：记什么、怎么组织、何时 recall、更新与遗忘
- 「爱丽丝为核心」分工总则：机制只保证不丢、知道、兜底，不替 agent 做内容决策

## 功能

### 分层记忆（L1 事实 / L2 知识 / L3 情景）

- **L1 fact**：主人偏好、环境事实——`key` 精确覆盖更新
- **L2 knowledge**：可复用知识、学习沉淀——同标题自动合并
- **L3 episodic**：有结果的情景、经历时间线——时间桶压缩（日→周→月→年）
- **summary**：压缩产物，冷归档保留（可深挖），索引高密度

### 作用域

- `global`：全局记忆（主人偏好/环境），永远附加检索
- workspace 级：按项目 `.dsh/memory.yml` 配置路由（层级、预算、时间刻度）

### 工具面（agent 自主调用）

| 工具 | 用途 |
|---|---|
| `remember` | 写入/覆盖/合并；返回 id + action |
| `recall` | 检索：关键词/层级/标签/时间过滤，相关度+新鲜度排序；**每个结果附带联想链（related：共享标签/2-gram 关联的记忆，v0.2）** |
| `memory_relate` | **联想导航（v0.3）**：按 id 展开单条记忆的关联网络（共享标签/2-gram 邻居降序）——从已知记忆沿关系行走（记忆图导航） |
| `memory_browse` | 时间金字塔浏览（不知道有什么时的发现路径） |
| `update` / `forget` | 修订 / 归档（不进活跃检索，可深挖） |
| `memory_stats` | 各层/时间桶/归档计数 |

### 联想层（v0.2：从关键词检索到关系检索）

recall 命中条目时，每个结果附带 `related` 关联链——联想强度 = 共享标签×3 + 标题 2-gram 重叠×2 + 正文 2-gram 重叠×1（中文/英文无空格分词自然工作）。让记忆从「关键词命中列表」升级为「关系网的一角」：检索到一条时，连着它的因果邻居一起浮现（因果留痕维度）。

### 联想导航（v0.3：记忆图行走）

`memory_relate` 让联想可主动导航：给定一条记忆 id，展开它的关联邻居（共享标签/2-gram 重叠，强度降序）——从「联想检索」到「联想导航」，记忆成为可沿关系行走的网络（AGI 记忆形态：不是数据库，是关联图）。

### 联想闭包（v0.4：BFS 多跳记忆社区）

`memory_relate` 新增 `depth` 参数（默认 1=单跳；>1 走 BFS 多跳）：沿关联边逐层扩展联想社区——hop 标注层级、visited 防环、每跳 limit 控制扇出。从「单点导航」升级为「社区探索」（记忆图 BFS，因果留痕维度深化）。

### 压缩即记忆（通道 C，与 dsh-agent-compact 联动）

会话压缩完成 → checkpoint 原文**保底存档**（episodic）+ inbox 通知（`wakeup=true` **完成即送达**，不等主人下一条消息——2026-08-16 主人定调，为权威语义）——提炼与否、如何组织由 agent 自主决策，理由记入 `source.reason`。压缩在进程内已完整，不再写哨兵重启。

## 组合

```yaml
- insert:
    - id: agent-memory
      name: dsh-agent-memory
```

依赖官方 storage 栈（storage / storage-json / storage-domain，web-app bundle 已提供）。

## 测试

```sh
pnpm test          # 构建 + 125 用例（tests/*.test.mjs，node ≥ 22 任意平台）
pnpm run test:ts   # 构建 + 76 用例（tests/*.test.ts，需 node ≥ 24：原生类型剥离）
pnpm run test:all  # 构建 + 全量 201 用例（200 通过 / 1 跳过）
```

125 + 76 = 201 tests / 0 fail（`.ts` 套件含 1 个 skip）。

> 2026-09-13 起 `.ts` 套件纳入 npm 脚本：此前 5 个 `.ts` 测试文件（76 用例）**不在 `npm test` 内**，跑绿只证明 `.mjs` 那一半——记账缺口已闭合（`test:ts` / `test:all`）。

## 设计文档

- [DESIGN.md](DESIGN.md) — 设计意图（输入通道、检索管道、防失控机制）
- [IMPLEMENTATION.md](IMPLEMENTATION.md) — 工程契约（接口、验收、取证记录）

## 关联项目

- [dsh-agent-compact](https://github.com/jonah791/dsh-agent-compact) — Agent 驱动会话压缩（通道 C 的咬合方）

## 相关

- [我的数字生命爱丽丝 — 插件生态中心（架构总览）](https://github.com/jonah791/alice-digital-life)

## License

MIT
