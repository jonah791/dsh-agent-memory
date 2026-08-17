# dsh-agent-memory — DSH 的 Agent 驱动长期记忆插件

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
| `recall` | 检索：关键词/层级/标签/时间过滤，相关度+新鲜度排序 |
| `memory_browse` | 时间金字塔浏览（不知道有什么时的发现路径） |
| `update` / `forget` | 修订 / 归档（不进活跃检索，可深挖） |
| `memory_stats` | 各层/时间桶/归档计数 |

### 压缩即记忆（通道 C，与 dsh-agent-compact 联动）

会话压缩完成 → checkpoint 原文**保底存档**（episodic）+ inbox 通知（`wakeup=false` 排队不唤醒）——提炼与否、如何组织由 agent 自主决策，理由记入 `source.reason`。压缩在进程内已完整，不再写哨兵重启。

## 组合

```yaml
- insert:
    - id: agent-memory
      name: dsh-agent-memory
```

依赖官方 storage 栈（storage / storage-json / storage-domain，web-app bundle 已提供）。

## 测试

```sh
node node_modules/typescript/lib/tsc.js -p tsconfig.json && node --test
```

165+ tests / 0 fail。

## 设计文档

- [DESIGN.md](DESIGN.md) — 设计意图（输入通道、检索管道、防失控机制）
- [IMPLEMENTATION.md](IMPLEMENTATION.md) — 工程契约（接口、验收、取证记录）

## 关联项目

- [dsh-agent-compact](https://github.com/jonah791/dsh-agent-compact) — Agent 驱动会话压缩（通道 C 的咬合方）

## License

MIT
