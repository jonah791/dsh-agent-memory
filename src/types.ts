/**
 * dsh-agent-memory 数据契约（IMPLEMENTATION.md §2.1）
 * 本文件仅含类型，无运行时代码。
 */

// 时效维的档位定义住 `temporal.ts`（那里是它的正本与理由）——此处只引用类型。
// 类型循环（temporal.ts ⇄ types.ts）是安全的：两边都是 `import type`，编译后消失。
import type { StalenessLevel } from './temporal.ts'

/** 记忆条目类型 */
export type EntryKind = 'fact' | 'knowledge' | 'episodic' | 'summary'

/**
 * 内容分类（v0.26.0 · 方案 §3.1 七类记忆）。
 *
 * 与 `EntryKind` **两轴正交**：`kind` 是存储与粒度轴（去重/压缩/体检的既有契约，不动），
 * 本类型是内容性质轴（保留策略 / 任务路由 / 知识组织的坐标系）。
 * 语义、别名、为什么没有默认值，全部在 `src/memType.ts` 文件头。
 */
export type MemType = 'episodic' | 'semantic' | 'procedural' | 'profile' | 'project' | 'relational' | 'operational'

/**
 * 空间归属（v0.27.0 · 方案 §3.2 四空间）——这条知识属于**谁的疆域**。
 *
 * 与 `scope` 正交（见 `Entry.space` 注释）：`scope` 是存储与准入（键空间 / 路径 /
 * 跨会话可见性），本类型是知识归属（授权与检索的**语义**维）。两者不互相推导。
 *
 * 四空间的判据与「拿不准时问什么」全部在 `src/space.ts` 文件头。
 */
export type Space = 'personal' | 'project' | 'domain' | 'system'

/**
 * 条目自带的生命周期状态（v0.27.0 · 方案 §3.3）——**只收没有载体的两态**。
 *
 * `superseded` 由 `supersededBy` 表达、`archived` 由 `archived:true` 表达、
 * `deleted` 由 `archivedReasonType='deleted'` 表达（既有载体，不另开一位）。
 * 六态的统一读法是纯函数 `lifecycleOf(entry)`（`src/lifecycle.ts`）——
 * **一个判断入口、一个来源**，避免同一件事存两份而漂。
 */
export type EntryStatus = 'pending' | 'disputed'

/** 六态（派生读法的取值域；`active` 是未标注时的常态） */
export type LifecycleState = 'active' | 'pending' | 'disputed' | 'superseded' | 'archived' | 'deleted'

/**
 * 关系类型（v0.28.0 · 方案 §4.4 十种）——一条**类型化边**断言两个节点之间是什么关系。
 *
 * 与 `tags` / `aliases` / `relatedOf` 的分工：那三者是**无序、无类型、无有效期**的字面线索；
 * 本类型是**有方向、有类型、有来源与有效期**的断言（「A 支持 B」与「A 反驳 B」不能互换）。
 * 十种类型的读法、方向语义与使用判据全部在 `src/relations.ts::RELATION_TYPE_SPECS`。
 *
 * ⚠ `supersedes` 虽然在此枚举里，但**不由 `memory_link` 写入**：替代关系的唯一写入口是
 * `memory_supersede`（它写条目两侧字段），本层只把它读成派生边——`一个事实一个归宿`。
 */
export type RelationType =
  | 'belongs-to'
  | 'related-to'
  | 'supports'
  | 'refutes'
  | 'sourced-from'
  | 'derived-from'
  | 'supersedes'
  | 'participates-in'
  | 'uses'
  | 'depends-on'

/**
 * 关系节点类别（v0.28.0）：本版只开放 `entry`。
 *
 * 实体（§4.3 规范控制）已有 ID 空间与解析器，但开放的判据不止「解析得出标题」：
 * `memory_relations` 的读路径要按**准入视野**过滤两端，而实体档不吃角色可见性
 * ⇒ 在把「实体节点如何过准入」定下来之前不开放，否则写进去的边读不回来（半件能力比没有更坏）。
 * 本期实体与条目的关联走「按名字解析 + 文本反查」（`memory_entities`），不落边。
 */
export type RelationNodeKind = 'entry'

/**
 * 一条类型化关系（边，v0.28.0 · 方案 §4.4）——**独立资源**，不嵌在条目里。
 *
 * 字段一律**平级标量**：本仓 schema DSL 只支持字段级 `required`，嵌套对象会让泛型退化
 * 且维度常量对不上（同 `Entry.archivedReasonType` 注释里那次实测）。
 *
 * 元数据四件（方案 §4.4 明列）：
 * - **来源**：`provenance`（master / web / self / measured）——这条边凭什么说是这样
 * - **有效时间**：`validFrom` / `validTo`——该断言何时成立（与 `createdAt` 的「何时记下」不同）
 * - **方向**：由 `type` 的 fromRole/toRole 定义（同一条边反向读时换标签，不另存一条）
 * - **可信度**：`confidence`（0–1，**无默认值**：不给 = 未评估，不是 0 分）
 */
export interface Relation {
  id: string
  type: RelationType
  /** 边的起点节点 id（本版 = 条目 id） */
  from: string
  /** 边的终点节点 id */
  to: string
  fromKind: RelationNodeKind
  toKind: RelationNodeKind
  /** 存储分区（取 `from` 端条目的 scope） */
  scope: string
  /** 关系来源（必填） */
  provenance: Provenance
  confidence?: number
  /** 该断言从何时成立（YYYY-MM-DD 或 ISO 时刻） */
  validFrom?: string
  /** 该断言到何时为止（缺省 = 仍未退役；过期 ≠ 作废，历史仍可查） */
  validTo?: string
  /** 证据坐标（沿用 v0.25 编码：`session|<id>|<seq>` 等） */
  evidenceRefs?: string[]
  /** 人类可读补充（**数据不是指令**） */
  note?: string
  /** 我何时记下这条边（事务时间，与 validFrom 的有效时间不同） */
  createdAt: string
}

/** 时间压缩层级（仅 episodic/summary 使用） */
export type TimelineLevel = 'day' | 'week' | 'month' | 'year'

/**
 * 主题词表概念（v0.29.0 · 方案 §4.2 · 参考 SKOS）。
 *
 * ## 为什么需要它（与 `tags` 的分工）
 *
 * `tags` 是**自由文本**：同义词（「记忆库」/「记忆系统」/「智能体记忆」）各写各的，
 * 检索时只能逐字匹配。受控词表把「同一个概念的多种写法」收在一处，于是
 * ① 查询可以按同义词扩展（`recall({expandThesaurus:true})`）② 我写标签时有规范名可依。
 *
 * ## 一个事实一个归宿（与 SKOS 的两处刻意不同）
 *
 * - **只存 `broader`**：SKOS 的 `narrower` 是 `broader` 的逆关系，两边都存会在
 *   「只改了一侧」时产生矛盾的事实 ⇒ 下位由反查派生（`narrowerOf`）。
 * - **`related` 对称但只存一次**：读路径双向都算（A→B 与 B→A 是同一句「两者相关」）。
 *
 * ## 停用而不删除
 *
 * `status: 'deprecated'` 表示「这个词不再用」（同 SKOS 的 deprecated 标记）：它仍可被
 * 查到（旧条目上的标签还要能解释），只是不再参与查询扩展的默认集合。
 *
 * 平级标量 + 数组；`revisions` 是唯一的嵌套（与条目的 `revisions` 同形，仅存储侧用，
 * 不进工具参数 schema——本仓 schema DSL 的嵌套会让泛型退化，见 `relations.ts` 注释）。
 */
export interface Concept {
  id: string
  /** 存储分区（与条目同源：global 或 workspaceId） */
  scope: string
  /** SKOS prefLabel：首选名（同 scope 内唯一，按 `normalizeLabel` 归一口径） */
  prefLabel: string
  /** SKOS altLabel：同义词与其他名称 */
  altLabels?: string[]
  /** SKOS definition：概念定义 */
  definition?: string
  /** SKOS scopeNote：使用范围说明（什么时候该用它、什么时候不该用） */
  scopeNote?: string
  /** SKOS broader：上位概念 id 列表（下位由反查派生，不存） */
  broader?: string[]
  /** SKOS related：关联概念 id 列表（对称，读时双向） */
  related?: string[]
  /** 停用标记；**无默认值**（未给 = 适用中） */
  status?: 'deprecated'
  /** 停用理由（仅在 deprecated 时出现） */
  deprecatedNote?: string
  createdAt: string
  updatedAt: string
  /** 变更记录：最近 MAX_CONCEPT_REVISIONS 条（创建/改名/增删标签/停用），带原因 */
  revisions?: ConceptRevision[]
}

/** 概念的变更记录（与条目的 `revisions` 同形：只留最近几条，全历史在提交里） */
export interface ConceptRevision {
  at: string
  /** 动作：create / update / deprecate */
  action: string
  /** 变更内容的人类可读说明（如「prefLabel：旧 → 新」「altLabels +记忆库」） */
  detail: string
  /** 为什么改（可选；不填就是「没记原因」，不假装有） */
  reason?: string
}

/**
 * 实体权威档（v0.30.0 · 方案 §4.3 规范控制）——**现实对象**的档案：人 / 项目 / 机构 / 作品 / 地点。
 *
 * 与 `Concept`（主题）的分工：概念是「这个词指什么」，实体是「这个东西叫什么」。
 * 结构上最硬的差异是**别名可多指**：两个不同的人可以同名（方案 §4.3 明确不许因同名就合并）
 * ⇒ 本表**没有**唯一标签空间，`resolveName` 返回候选列表，撞名时要求 `disambiguation`。
 * 契约正文在 `src/entities.ts` 文件头与 `docs/semantic.md §5.23`。
 *
 * 平级标量 + 数组；`revisions` 是唯一的嵌套（与条目 / 概念同形，仅存储侧用）。
 */
export interface Entity {
  /** 实体 ID：`ENTITY-0001` 形态（每 scope 递增；方案 §4.3 的示例形态，人能口头引用） */
  id: string
  /** 存储分区（与条目 / 概念同源：global 或 workspaceId） */
  scope: string
  /** 规范名（**首选**称呼：档案对外用它） */
  canonicalName: string
  /** 别名（同一对象的其他称呼：简称 / 英文名 / 历史名称） */
  aliases?: string[]
  /** 实体类型（人 / 项目 / 机构 / 作品 / 地点……）：必填、不枚举——枚举会挡掉新类型，而消歧第一依据正是它 */
  entityType: string
  /** 首次出现（自由文本：会话 id / 记忆 id / 一句描述）——与 `createdAt`（建档时刻）不是一回事 */
  firstSeen?: string
  /** 相关主题：主题词表里的概念 id 列表（同 scope） */
  topics?: string[]
  /** 关联实体：实体 id 列表（同 scope；存续档才可被指向） */
  relatedEntities?: string[]
  /** 消歧说明：与别的实体同名时凭什么区分（撞名时必填） */
  disambiguation?: string
  /** 合并 / 停用标记；**无默认值**（未给 = 适用中） */
  status?: 'merged' | 'deprecated'
  /** 已合并到哪个存续档（仅 `status: 'merged'`；只保留一层，不链式） */
  mergedInto?: string
  /** 停用理由（仅 `status: 'deprecated'`） */
  deprecatedNote?: string
  createdAt: string
  updatedAt: string
  /** 变更记录：最近 MAX_ENTITY_REVISIONS 条（创建 / 修改 / 合并 / 停用），带原因 */
  revisions?: EntityRevision[]
}

/** 实体的变更记录（与概念 / 条目的 `revisions` 同形） */
export interface EntityRevision {
  at: string
  /** 动作：create / update / merge / deprecate */
  action: string
  /** 变更内容的人类可读说明 */
  detail: string
  /** 为什么改（可选；不填就是「没记原因」，不假装有） */
  reason?: string
}

/**
 * 主体层（v0.13.0）：条目**关于谁**——`self`（我，爱丽丝）/ `master`（主人）。
 *
 * 与 `role`（条目归属，v0.5）**正交**：role 答「谁写的」，subject 答「关于谁的」。
 * 缺省（不设字段）= **通用**（不关于特定主体：技术知识 / 项目工作 / 外部论文）。
 * 语义、判据与「为什么与 role 刻意不同」见 `src/subject.ts` 文件头。
 */
export type Subject = 'self' | 'master'

/**
 * 约定状态（v0.14.0）：这条记忆涉及的事，**是否已被主人与我共同建立**。
 *
 * 动机（论文 Grounding Awareness · arXiv:2610.18684 · 主人 2026-10-14 交办）：
 * 记忆系统只记「用户说了什么」，但**「说过」≠「已建立」**。最危险的形态是——
 * **我自己的提议被记成「主人的话」**，未来当作授权执行。论文实测：被保留的
 * 未接受提议中 **86–100%** 被记成「已确认信息」或「用户事实」；且给它**更多**
 * 提议内容反而**放大**未授权执行（Qwen+Mem0 假共同基础 0.26 → 0.53）。
 *
 * 与既有维度**正交**：`role` 答「谁写的」· `subject` 答「关于谁的」·
 * `grounding` 答「**是否已被共同建立**」。三维可任意组合。
 *
 * **与论文 GL ledger 五状态的映射**（论文未明写，此处是我的归类）：
 *   `confirmed` → `established` · `pending` → `proposed` · `scoped` → `scoped` ·
 *   `rejected` → `rejected` · `revised` → **并进 `established`**（主人改过后接受，
 *   结果仍是已建立；「改了什么」由正文承载，不单设状态——避免与 v0.9 的
 *   `revisions`（内容修订留痕）语义打架）。
 *
 * ⚠ **与论文刻意不同（理由必须留在这里，否则会被「对齐」掉）**：论文默认
 * 「未授权 ⇒ 必须确认」并配 execution gate；但本系统主人的授权模式是
 * 「给方向、我自己决定」（AGENTS.md §2.2 技术处置自主 · 内部事务不上抛）
 * ⇒ **不做强制门**——处处请示会直接违背该定调。⇒ 移植的是**可见性**
 * （让我不被自己的提议骗），不是**拦截**。语义、判据与判例见 `src/grounding.ts` 文件头。
 */
export type Grounding = 'established' | 'proposed' | 'scoped' | 'rejected'

/**
 * 来源类型（v0.21.0）：这条记忆的**信息从哪来**——八元组的 `p` 轴（来源链）。
 *
 * **为什么需要**（2026-11-07 体检）：`source` 字段名义上是来源链（sessionId / seq），
 * 实际只用来装归档原因，**真正的来源信息一个字段都没有**。后果可指认：
 * “这条结论是主人说的、我实测的、还是从网页读来的”决定它该怎么被用——主人的话是授权，
 * 网页是别人的说法（要核对），我实测的是读数（要问样本多大），我自推的是**提议**（等回应）。
 * 四者在库里同形同语气，只能靠正文措辞去猜。
 *
 * 与 `grounding` **正交且不可合并**：`grounding` 答「是否已被共同建立」（授权维 `a`），
 * `provenance` 答「信息从哪来」（来源维 `p`）。一条「我实测某通道可用率 80%」⇒
 * grounding 未标注（不涉及授权）+ provenance = `measured`；一条「主人否决了 RAG」⇒ 两者都有。
 *
 * 与 `origin.ts` 的关系：那个模块是**补丁**（用正则从标题形态猜「这可能是转述」，只能
 * 标一种坏情况，引网页/书/口述的漏标）。`provenance` 是**声明**——写的时候我自己说。
 * ⇒ 有 `provenance` 时由它接管判据，无值时回退正则（见 `origin.ts::transcriptiveFlagOf`）。
 *
 * 缺省 = **未标注**（不知道），不是某个默认来源。
 */
export type Provenance = 'master' | 'web' | 'self' | 'measured'

/**
 * 冷存档标签（v0.22.1 · 2026-11-12）：**这条生来就是冷数据**——不是「相关但排得太前」。
 *
 * ## 为什么不走打分（读数）
 *
 * 库里 179 条「会话压缩检查点」占全库 **27.2%**（172.6 万字符 / 634 万），平均 9641 字符、
 * 最长 11.7 万。它们在「落库」到「时间桶摘要把它归档」之间有一段**窗口期**是活跃条目，
 * 而整段会话摘要**包含几乎所有查询词** ⇒ 词命中累加即最高分。实测（2026-11-12 01:53，
 * 唯一未归档的那条 26980 字）：查「否定判据 或式外面 仪器读数 假差值」它排 **第 1**
 * （49.5，第 2 名 40.4 的 1.23 倍）；查另两个不相关主题也分别排第 2。
 * 一次命中就是 25KB 噪音进上下文，且相对分门槛 0.08 会连带砍掉它下面真正有用的条目。
 *
 * ## 为什么不是「再调一次权重」
 *
 * 同一问题 2026-10-27 记过一次（package.json v0.17 条目：「十万字符的压缩 checkpoint
 * 容器会挤掉真正相关的短条目」），当时的修法是 BM25 正文长度归一，**v0.18 经样本外
 * 验证证明是净损失并退役**（55.3%→61.0% 是反方向；归一本身 -5.7pp / 18:3 / p=0.002）。
 * ⇒ 这次**不调权重，改分类**：对「容器」而言「多处命中」不是相关性的证据——它包含
 * 所有词是因为它包含一切，不是因为与问题相关。
 *
 * ## 判据位置与两条设计约束
 *
 * 1. **与 `archived` 同级**（`store.ts::list`）：归档后靠 `archived` 挡，归档前靠本标签挡，
 *    两个判据**互补、无缝隙**——不再依赖「周期摘要跑没跑」，消掉时间依赖。
 * 2. **回查能力一律不变**：`get(scope,id)` 不经 `list`（通知里给的 entryId 永远读得到）；
 *    `list(scope,{includeArchive:true})` 仍返回它（recall / memory_browse 带参可检）。
 *
 * 存量为零迁移：178 条已归档（`archived` 已挡住），唯一未归档的一条补标签即可。
 */
export const COLD_CHECKPOINT_TAG = 'checkpoint-archive'

/**
 * 归档原因类型（v0.21.0）：这条为什么被归档——**返回弧的语义承载**。
 *
 * 动机（论文 Always-On Agents · arXiv:2606.30306）：435 篇语料里 retrieve 269 / write 200，
 * 而 **rollback 只有 27**、forget 66 ⇒ 返回弧被系统性忽视。论文给「删除传播不变式」：
 * 忘掉一条事实必须沿派生链撤到抽取自的原始情节 / 吸收了它的摘要 / 以它为条件的技能 /
 * 别人的共享副本 / 它曾授权的外部副作用。**要传播，先要能分类**：一条被**证伪**的条目
 * 必须撤；被**合并**的条目内容还在（只是换了位置）；**过时**的降到低置信；**容量清理**的
 * 什么都不用做。四者对「引用它的活跃条目」的处置完全不同。
 *
 * 而旧实现把它写成自由文本（`store.ts::forget` → `source.reason`）⇒ 无法按类型查询，
 * 「我引用的那条为什么没了」只能逐条读正文猜。
 *
 * `unspecified` 是**「未判断」的显式表示**，不是替我做断言的默认值——与 `grounding`
 * 缺省 = 未标注同一立场（AGENTS.md §1.3 判断型字段禁默认值）。
 */
export type ArchiveReasonType = 'refuted' | 'merged' | 'superseded' | 'stale' | 'capacity' | 'deleted' | 'unspecified'

/**
 * 归档记录（v0.21.0）：`forget` 的因果留痕，**从 `source` 分离出来**。
 *
 * 为什么不在 `source` 上加一个 `reasonType` 了事：`source` 该答「这条从哪来」，
 * 归档记录答「这条怎么没了」——两件事装进一个字段，就是当前 `p` 轴 47% 覆盖、
 * 语义错配的根因。分开之后两边都能干净地填。
 *
 * ⚠ 存量兼容走**读取归一**而不是批量迁移（见 `archive.ts::archivalOf`）：2701 条里有
 * 1260 条带 `source.reason`，一次迁移的数据风险远大于收益。
 */
export interface ArchiveRecord {
  /** 归档时刻（ISO） */
  at: string
  /** 原因类型（枚举——让活跃条目能按类型问「我引用的东西为什么没了」） */
  reasonType: ArchiveReasonType
  /** 人类可读原因（自由文本，可选——类型之外的细节） */
  reason?: string
}

/**
 * 角色准入策略（v0.5 多智能体工作台模式，借鉴 MAGE role policy index + Γ 准入）：
 * 描述「某个角色能看见什么」。字段缺省 = 不限制该维度。
 */
export interface RolePolicy {
  /** 可读归属白名单：`'*'` = 全部；含条目 role 值 = 放行。缺省 []（= 只看自己 + 共享） */
  read?: string[]
  /** 允许的条目类型（缺省 = 不限制） */
  kinds?: EntryKind[]
  /** 是否可见「无归属的共享记忆」（缺省 true） */
  includeShared?: boolean
  /** 是否附加 global 作用域（缺省 true；false = 不附加，显式 scope 参数仍优先） */
  includeGlobal?: boolean
  /**
   * 允许的**空间归属**白名单（v0.27.0 · 方案 §3.2 四空间）；缺省 = 不限制。
   *
   * ⚠ 设了就 **fail-closed**：未标注 `space` 的条目**不放行**——「不知道属于哪个空间」
   * 不能当「所有空间都可读」。这是四空间「各自独立授权」的唯一执行点；没有它，
   * 四空间只是四个标签。
   */
  spaces?: Space[]
}

/** 角色维度配置（memory.yml `roles` 段） */
export interface RolesConfig {
  /** 总开关：false（缺省）时**零过滤**——行为与 v0.4 完全一致（向后兼容硬约束） */
  enabled: boolean
  /** 人类会话缺省角色 */
  default: string
  /** 派生会话（子代理 / 队员 / 隔间）缺省角色 */
  derived: string
  /** 会话预设名（agentPreset）→ 角色映射 */
  byPreset: Record<string, string>
  /** 未显式配置策略的角色所用策略 */
  policyDefault: RolePolicy
  /** 角色 → 策略 */
  policies: Record<string, RolePolicy>
}

/** 记忆条目（核心契约） */
/**
 * 证据引用类型（v0.25.0）：这条记忆的**原始出处**指向什么。
 *
 * 方案 §5.2「独立来源记录」与 §5.3「事实与证据分离」要求每条重要记忆可回溯。
 * v0 只做**可核的坐标**：写入时知道什么就盖什么，不知道的键不出现。
 *
 * ## 为什么存成字符串数组，不存对象
 *
 * 本仓 schema DSL 的 `required` 只支持字段级（见 `Entry.archivedReasonType` 的注释）：
 * **嵌套对象在归一化时会被提成对象级 `required`**，同时让 `defineTool` 泛型推断退化
 * （TS2719/TS2322）；此外维度常量要求各消费者逐字段 deepEqual，嵌套对象在归一化后
 * 必然与常量对不上 ⇒ 两条守卫（A4 / A113b）当天就红了。
 *
 * 所以沿用本仓既有的平级标量风格：条目里存 `string[]`，**编码格式**见下，
 * 解析/渲染集中在 `evidence.ts`（格式即契约，改格式必须同版本号）。
 *
 * 编码（三段，`|` 分隔）：
 * - `session|<sessionId>|<seq>` —— 会话级 + 事件号（seq 可省 ⇒ 只到会话级）
 * - `compaction|<sessionId>|<compactionId>`
 * - `derived|<locator>`
 */
export type EvidenceKind = 'session' | 'compaction' | 'derived'

/** 解析后的证据引用视图（`evidence.ts::parseEvidenceRef` 产出，不直接落盘） */
export interface EvidenceRef {
  kind: EvidenceKind
  /** 会话 id（kind=session / compaction 必有） */
  sessionId?: string
  /**
   * 会话内事件序号：**写入时刻该会话的最新事件 seq**。
   *
   * ⚠ 它能回答的是「写这条时对话进行到哪」，不是「这句内容出自哪一条事件」——
   * 工具调用拿不到自己那次事件号（2026-11-18 实测 `ToolRunContext` 无该字段）。
   * 精度差别写在字段上而不是靠读者猜：需要精确内容定位时回看 seq 附近的事件。
   */
  seq?: number
  /** 压缩事务 id（kind=compaction）——压缩事件自带坐标，比 seq 更精确 */
  compactionId?: string
  /** 非会话定位：`supersedes:<id>` / URL / 文件路径（kind=derived 等） */
  locator?: string
}

export interface Entry {
  id: string
  kind: EntryKind
  /** L1 精确覆盖键 */
  key?: string
  title: string
  /** markdown 自由正文 */
  body: string
  /** 可选元数据（agent 自主决定） */
  tags: string[]
  /**
   * 检索别名（2026-10-13 重做）：这条记忆**可能被怎么问**的同义表述。
   *
   * **为什么需要**（实测根因）：检索是字面匹配，而**记忆的措辞 ≠ 提问的措辞**。
   * 亲读归因实验（`_tmp_review/mem-attribution.mjs`）对 3 个「期望第一却排不上」的案例
   * 各换 5 个查询变体——三个全部：换个说法就排第一。机制：目标条目标题
   * 「把别人的『未找到』转述成『不存在』」**完全不含**查询「我的错误 教训 误判 修正」
   * 里的任何实词 ⇒ 只靠 bigram 碎片拿 10.5 分、排第 5。
   *
   * **证伪实验**（`_tmp_review/mem-alias-falsify.mjs`，只给 3 条补别名）：
   * S3 #2→#1（22.4→114.1）· S4 #4→#1（50.2→115.8）· S5 #5→#1（10.5→48.7）；
   * **对照组**：3 个无关查询 top1 全部不变（零污染）。
   *
   * **为什么放写入侧而非查询侧**：写入时抽，代价一次性、可复核、可人工修正；
   * 查询时扩展每次都要做且不可复核。且它把质量责任放回写入端（主人 2026-10-13 定调
   * 「不做向量语义检索 ⇒ 写入质量是唯一路线」）。
   */
  aliases?: string[]
  /**
   * 情境形状（v0.16.0，2026-10-21）：这条经验**在什么形状的情境下该被取出使用**。
   *
   * 与 `aliases` 的分工：aliases 面向**词面失配**（我会用什么词来找），cue 面向**场景失配**
   * （什么样的处境该用它）。检索时同权参与打分——两者都是人工给的入口，只是防的失配不同。
   * 论文依据：Harness² 的 experience `cue`（arXiv:2610.14224 §H Prompt 6）——写「情境的形状」
   * 而不是本次任务的事实，才能在另一件事上触发。
   */
  cue?: string[]
  /** global 或 workspaceId */
  scope: 'global' | string
  createdAt: string
  updatedAt: string
  accessedAt: string
  level: TimelineLevel | null
  /** 时间桶键：YYYY-MM-DD / YYYY-Www / YYYY-MM / YYYY */
  bucket: string | null
  /** 冷归档标记（不进活跃检索） */
  archived: boolean
  /**
   * 归档原因类型（v0.21.0）：这条**怎么没了**——返回弧的语义承载，与 `source`（从哪来）分离。
   *
   * 旧形态是 `forget` 把原因写进 `source.reason`，即「归档原因」与「来源」共用一个字段
   * （`p` 轴语义错配的根因）。分开之后 `source` / `provenance` 管来路，本字段管去路。
   * 论文依据（arXiv:2606.30306）：435 篇里 retrieve 269、**rollback 只有 27** ⇒ 返回弧被
   * 系统性忽视；而「删除传播」要求先能**分类**（被证伪必须撤 / 被合并内容还在 / 过时降置信）。
   *
   * ⚠ **为什么是平级标量而不是嵌套对象**（2026-11-07 实测）：本仓 schema DSL 的 `required`
   * 只支持字段级 `required: true`；嵌套对象在归一化时会被提成对象级 `required: ['a','b']`
   * ⇒ 既与常量比对不上（schema-parity A118 红），也让 `defineTool` 泛型推断退化成 never
   * （TS2719/TS2322）。⇒ 与 `subject` / `grounding` / `provenance` 同形：平级、标量、enum。
   *
   * 归档时刻**不单独存**：`store.forget` 会刷新 `updatedAt`，那就是归档时刻。存两份会让
   * 「哪个才算」变成第二个真源（同 `archivalOf` 的取舍）。
   *
   * 存量 1260 条带 `source.reason` 的旧条目**不迁移**，由 `archive.ts::archivalOf` 读取时
   * 归一（`reasonType: 'unspecified'`）——零数据改动，新旧并存不歧义。
   */
  archivedReasonType?: ArchiveReasonType
  /** 归档原因的人类可读详情（v0.21.0；类型之外的补充，可选） */
  archivedReason?: string
  source?: { sessionId?: string; seq?: number; reason?: string }
  /**
   * 证据引用（v0.25.0）：这条记忆的原始出处坐标，**编码字符串**（格式见 `EvidenceKind` 注释）。
   *
   * 三者分工不可互相替代：`source` 在压缩链里被写成「为什么生成」（如 `{reason:"时间压缩…"}`），
   * `author` 答「谁写的」，本字段答「能回到哪里」。存量条目没有本字段——**不回填、不猜**，
   * 读取侧按 `[]` 处理（`docs/semantic.md` 证据一节）。
   */
  evidenceRefs?: string[]
  /** summary → 原始条目 id 列表 */
  archiveRef?: string[]
  /**
   * 角色归属（v0.5）：条目的分区维度。**缺省 = 共享记忆**（任何角色都可见）；
   * 盖章只发生在「角色维度启用」或调用方显式指定 `role` 时（迁移安全）。
   */
  role?: string
  /**
   * 主体层（v0.13.0）：条目**关于谁**。缺省 = 通用（不关于特定主体）。
   *
   * 与 `role` 正交且**互不影响**：`role` 管「谁写的」（准入隔间），`subject` 管
   * 「关于谁的」（语义标记，不改变可见性）。新建时盖章；**显式纠正**走
   * `update({ subject })` 或 `remember({ subject })`（见 src/subject.ts 三条设计决定）。
   */
  subject?: Subject
  /**
   * 内容分类（v0.26.0 · 方案 §3.1 七类）：这条记忆**是哪一类馆藏**。
   *
   * 与 `kind` 正交（见 `MemType` 注释）；**无默认值**——未给 = 未分类，
   * 统计单列 `unclassified`，不折进任何一类（判断型字段禁默认值）。
   * 新建时盖章；显式纠正走 `update({ memType })`。
   */
  memType?: MemType
  /**
   * 空间归属（v0.27.0 · 方案 §3.2 四空间）：这条知识属于**谁的疆域**——个人 / 项目 / 领域 / 系统。
   *
   * **与 `scope` 正交且不可互换**：`scope` 是存储与准入（存哪个分区、谁看得见，值是路径）；
   * 本字段是知识归属（授权与检索的语义维）。不互相推导：项目 A 的技术决策可以存进
   * `global` 库而 `space='domain'`；也可以存进项目路径而 `space='personal'`。
   * **无默认值**——未标注 = 不知道属于哪个空间（判断型字段禁默认值）。授权侧
   * `role.spaces` 对未标注条目 **fail-closed**（不放行）。
   */
  space?: Space
  /**
   * 生命周期状态（v0.27.0 · 方案 §3.3）：只存**没有载体**的两态——`pending` 待审核 /
   * `disputed` 存疑；未给 = 常态（`active`）。六态的完整读法见 `lifecycleOf()`。
   */
  status?: EntryStatus
  /**
   * 执行位置·领域（v0.23.0）：这条记忆是在**哪个项目**里得到的——`alice` / `pp` / 不设（通用）。
   *
   * **与 `scope` 正交且不可互换**：`scope` 是**准入**（存哪个分区、谁看得见，值是路径）；
   * `project` 是**语义标记**（哪来的），只是可选筛子，不改变任何条目的可见性。
   * 理由与三条反例见 `src/execution.ts` 文件头。
   *
   * 动机 = 主人 2026-11-15 架构定调（「Project 不属于 Agent 也不属于 Session」）+
   * MAGE（EMNLP 2026）的实测结论（按语义相似度组织记忆会导致状态碎片化与错误无法隔离）。
   *
   * 缺省 = 通用（不知道属于哪个项目），不是某个默认项目——判断型字段不代填。
   */
  project?: string
  /**
   * 执行位置·节点（v0.23.0）：这条记忆是在**哪个任务**里得到的（server 侧的任务 id）。
   *
   * **只在 `project` 内唯一**（`ps-4a2b` 在 alice 与 pp 里可以是两个任务）
   * ⇒ 写入 / 查询时给 `taskId` **必须同时给 `project`**，否则二义（见 `execution.ts`）。
   *
   * 与 `project` 的分工：`project` 是「哪棵树」，`taskId` 是「树上哪个节点」——
   * 只有前者等于按池子分家（还是语义组织），加后者才够得着 MAGE 说的**执行路径**。
   */
  taskId?: string
  /**
   * 约定状态（v0.14.0）：事项**是否已被共同建立**——`established`（主人明确说过）/
   * `proposed`（**我提的、主人未回应**）/ `scoped`（主人接受但限定范围）。
   *
   * 缺省 = **未标注**（读作「不知道」而非「已建立」——后者恰是论文点名的错误假设）。
   * 只在新建时盖章；显式纠正走 `update({ grounding })`（三态见 `EntryPatch.grounding`）。
   */
  grounding?: Grounding
  /**
   * 复查死线（v0.15.0）：这条结论**该在什么时候被重看**——`YYYY-MM-DD`（UTC 日）。
   *
   * 动机（论文 Fresh at Decision, Stale at Action · arXiv:2610.18126v1 · 主人 2026-10-14 交办）：
   * 论文证明**新鲜度有天花板**——`Pr[f holds at ta] ≤ e^(-λ_f · Δact)`，决策时刻再新鲜
   * 也突破不了执行间隙 Δact 内发生的变化。迁移到我的场景：`td` = 我写下这条结论的时刻，
   * `ta` = **未来的我执行它**的时刻（加载技能 / 引用记忆 / 按它行事），Δact 是几天到几周。
   *
   * ⚠ **无默认值**（判断不代填 · §2.4）：给每条记忆自动盖「90 天后复查」等于把判断
   * 写死在机制里——主人的偏好该永久有效、环境坐标该 30 天一看，同一默认值会同时错两边。
   * **空是常态，填是例外**：只有我此刻判断「这条会腐化」时才填。
   *
   * ⚠ **到期 ≠ 作废，只 = 该重看**：不做自动失效、不做自动归档（同 grounding 的立场：
   * 移植的是可见性不是拦截）。到期后由我核实 → `update` 改内容并续死线或清除。
   *
   * 写入侧接受相对写法（`+7d` / `+2w`），**存盘一律固化成绝对日期**——存相对值会让
   * 「什么时候到期」随「何时读取」漂移。解析与判定见 `src/temporal.ts`。
   */
  reviewAfter?: string
  /**
   * 观察条件（v0.15.0）：**什么样的新信息会让这条失效**——1–8 条短句。
   *
   * 论文实测（INDIRECT）：把观察条件写进索引 ⇒ **达 92.2% 的决定性消息、仅 20 条陷阱**；
   * 而索引「全部背景事实」虽达 100%，却带 **89 条陷阱**（每个事实都成了匹配点）。
   * 论文的措辞是关键：条件要**点名活动依赖的实体**（含它的**另一个名字**与**上游**），
   * 同时**略去用不到的** —— 低暴露来自「只写需要的那几条」。
   *
   * **写入时机是唯一的**：论文说条件由「**知道为什么这么选的那个组件**，在写入时刻」产生
   * ——那正是我调 `remember` 的那一刻。事后再补，我已经想不起当时在等什么。
   *
   * **本版不做独立 router**（理由见 `src/temporal.ts` 文件头决定 1）：条件印在 recall
   * 结果里 = 免费路由（命中即看见「它在等什么」）。若实测「该失效的条目从没被 recall 到」，
   * 那条尸体成立再补 router。
   */
  watchFor?: string[]
  /**
   * 生效时间（v0.24.0）：这条结论**从何时开始成立**——`YYYY-MM-DD`。
   *
   * 与 `createdAt` **不是同一件事**：`createdAt` 答「我什么时候**记下**的」，本字段答
   * 「这件事什么时候**开始为真**」。主人的定调可能今天记下、而它针对的是上周的决定
   * （2026-11-17 诊断：压缩摘要会把这个时间关系抹平）。
   *
   * ⚠ **无默认值**（判断不代填 · §2.4）：省略 = **不知道**，**不是**「等于 createdAt」。
   * 若给默认值，库里每条「不知道何时生效」的条目都会被伪装成「写入那天生效」——
   * 那是把判断写死在机制里，比不填更坏（同 `reviewAfter` 的立场）。
   *
   * 与 `reviewAfter` 的关系：一个**向后看**（何时开始为真）、一个**向前看**（该何时重看）；
   * 两维正交，一条可以同时有、可以只有其一、也可以都没有。
   *
   * 写入侧接受 `YYYY-MM-DD` 与 ISO 时刻（取 UTC 日），**不接受相对写法**（理由见
   * `src/succession.ts::parseValidAfterArg`）；存盘一律 `YYYY-MM-DD`。
   */
  validAfter?: string
  /**
   * 被替代（v0.24.0）：这条**被哪一条替代了**（单个记忆 id，不是数组）。
   *
   * 与 `archivedReasonType='superseded'`（归档状态：这条怎么没了）**不替代、互补**：
   * 那个说「没了」，这个说「被谁顶掉了」。归档的条目不会自动带本字段——两者各写各的。
   *
   * **替代关系只保留一层**：A→B→C 时 `A.supersededBy=B`、`B.supersededBy=C`，
   * 不把 C 递归填成 `[A, B]`（理由见 `src/succession.ts` 文件头：记忆库不是事件溯源库）。
   *
   * ⚠ **旧条目绝不删除**，只标本字段——旧值是对照（「以前用 diff，因为…」那半句的价值
   * 就在旧值里）。recall 默认**仍返回**它，只打「⚠ 已过时」标记。
   *
   * ⚠ **唯一写入口是 `memory_supersede`**（它同时写两侧）。`update` 工具刻意**不暴露**
   * 本字段：只写一侧会让「谁还在引用一条已被取代的结论」查不到反向关系。
   */
  supersededBy?: string
  /**
   * 替代了谁（v0.24.0）：这条**替代了哪些**（记忆 id 列表）。
   *
   * 与 `supersededBy` 是同一条边的两侧，写入时**两侧同写**（本插件唯一的成对写路径：
   * `memory_supersede`）。只填一项 = 审计只能单向查，故工具层强制两侧。
   *
   * **只记直接替代对象**（不递归展开祖先）——见 `supersededBy` 的「只保留一层」。
   */
  supersedes?: string[]
  /**
   * 来源类型（v0.21.0）：这条记忆的**信息从哪来**（`master` / `web` / `self` / `measured`）。
   *
   * 与 `grounding` **正交且不可合并**：`grounding` 答「是否已被共同建立」（授权维 `a`），
   * 本字段答「信息从哪来」（来源维 `p`）。一条「我实测某通道可用率 80%」⇒ grounding 未标注
   * + `provenance: 'measured'`；一条「主人否决了 RAG」⇒ 两者都有值。合并任何一个都会让
   * 另一维失去分辨力。
   *
   * 缺省 = **未标注**（不知道），不是某个默认来源——与 `grounding` 同一立场（判断不代填）。
   * 写入纪律：写的时候我知道这信息从哪来，**那时就该填**；事后再补常已想不起。
   */
  provenance?: Provenance
  /** 写入者溯源（v0.5）：谁写的（会话 id / 委派深度 / 预设名）——与可见性无关，只作溯源 */
  author?: { sessionId?: string; delegationDepth?: number; preset?: string }
  /**
   * 修订留痕（v0.9）：每次 update 前的快照（保留最近 MAX_REVISIONS 条，旧→新）。
   * 动机：v0.8 前 `update` 是整文覆盖且**旧值即弃**——「修改机制」缺历史，改错无法回溯。
   */
  revisions?: Revision[]
}

/** 修订快照（v0.9）：让「修改」可回溯（与 forget 的软归档对称——一个管改、一个管忘） */
export interface Revision {
  /** 修订时刻（ISO） */
  at: string
  prevTitle: string
  prevBody: string
  /** 触发本次修订的模式 */
  mode: 'replace' | 'append' | 'patch'
  /** 修订者（会话 id），缺省不记 */
  by?: string
}

/** 项目记忆配置（.dsh/memory.yml，缺省走默认） */
export interface MemoryConfig {
  scope: 'workspace' | 'global-first' | 'global'
  layers: EntryKind[]
  autoSink: boolean
  timeline: {
    day: boolean
    week: boolean
    month: boolean
    year: boolean
    archive: 'keep'
  }
  weeklyTemplate: string
  maxEntries: number
  /** 启动注入配置（会话首 pre-step 注入记忆速览） */
  inject: {
    enabled: boolean
    maxBytes: number
    maxEntries: number
  }
  /** 自动 recall 注入配置（每条新主人消息注入 top 命中，L3 2026-09-01） */
  autoInject: {
    enabled: boolean
    maxEntries: number
    maxBytes: number
  }
  /** 角色维度配置（v0.5 多智能体工作台模式） */
  roles: RolesConfig
  /** 价值体检配置（v0.6：只读提案器 memory_audit） */
  audit: AuditConfig
}

/** 体检权重（`memory.yml` 的 `audit.weights`）——**启发式先验，不是拟合值**（校准是 v3 的事） */
export interface AuditWeights {
  ref: number
  recent: number
  usage: number
  tag: number
  role: number
  size: number
  dup: number
}

/** 体检档位（决策，不是排名） */
export type AuditBucket = 'KEEP' | 'DEMOTE' | 'ARCHIVE' | 'REVIEW'

/** 价值体检查询（memory_audit） */
export interface AuditQuery {
  scope?: string
  /** 角色视角覆盖（缺省按调用者推导；体检是读路径 ⇒ 过角色准入） */
  role?: string
  /** 返回候选条数上限（缺省 30） */
  topN?: number
  /** 只列体量 ≥ 此字符数的候选（缺省 0 = 全部） */
  minChars?: number
  includeArchive?: boolean
}

/** 体检候选（单个条目的分档与证据） */
export interface AuditCandidate {
  id: string
  kind: EntryKind
  title: string
  scope: string
  bucket: AuditBucket
  score: number
  /** 人可读的证据行（为什么落这一档） */
  reasons: string[]
  evidence: {
    ageDays: number
    chars: number
    refs: number
    /** 被返回过的次数（**不分位置**——v0.12 起它与评分脱钩，评分改用 `attribution`） */
    usage: number
    /**
     * 排序加权归因（v0.12 · DREAM 迁移）：`Σ decay^pos`。
     * 与 `usage` 的关系：同一条目，`usage=10` 若全在第 1 位 ⇒ ≈10；全在第 15 位 ⇒ ≈0。
     * 字段缺失时（外部只喂 hits 的调用方）评分回退 `usage`——零回归。
     */
    attribution?: number
    tags: number
    hasSource: boolean
    role?: string
    dupCluster?: number
    dupOf?: string
  }
}

/** 体检分组（按 kind/level 聚合，看「哪一坨最占地方」） */
export interface AuditGroup {
  key: string
  label: string
  count: number
  chars: number
  /** 该组主导档位 */
  dominantBucket: AuditBucket
}

/** 体检结果 */
export interface AuditResult {
  summary: {
    total: number
    chars: number
    byBucket: Record<AuditBucket, number>
    charsByBucket: Record<AuditBucket, number>
    /** 用量信号的来源：侧车轨迹 / 无 */
    usageSource: 'trace' | 'none'
    /** 被更晚条目引用过的条目数（承重计数） */
    referenced: number
  }
  groups: AuditGroup[]
  candidates: AuditCandidate[]
  notes: string[]
}

/** 体检配置（`memory.yml` 的 `audit` 段） */
export interface AuditConfig {
  weights: AuditWeights
  /** age ≤ 此天数的条目判 KEEP（保新，避免误伤在用的东西） */
  keepRecentDays: number
  /** age ≥ 此天数才够格判 ARCHIVE */
  archiveMinAgeDays: number
  /** 体量 ≥ 此字符数即入 REVIEW（超大条目交人裁决） */
  reviewMinChars: number
  /** 未被引用且体量 ≥ 此字符数即判 DEMOTE */
  demoteMinChars: number
  /**
   * summary 类正文预算（字符，v0.11.0）。
   * 概要是压缩流水线**自动生成**的，其长度上限由 `summarizer.summaryMaxChars`
   * 决定（缺省 6000）——审计必须用**它自己的尺子**量它，不能借用通用体量门槛。
   */
  summaryMaxChars: number
  /**
   * 分层概要预算（v0.24.2 · lh-ac92de7e）。
   *
   * 上面那把尺子是**单层**的，而压缩是**链式**的：周概要由 7 份日概要压来，月概要由 4 份周概要压来。
   * 让周/月共用日概要的 6000 字上限，等于给它们一个**结构上不可能达到**的门槛——
   * 实测（2026-11-18）：周概要 16,945 字 = 2.8 倍、月概要 39,842 字 = 6.6 倍，
   * 于是它们**每次都**落 REVIEW，把「交人裁决」的位置占满，而重压也救不回来（压完仍超，见记忆 2524eda5）。
   *
   * 缺省是**先验**（每层比下一层大一档），不是拟合值；要改就按实测改。
   * 缺省的缺省：某层没配 ⇒ 回退 `summaryMaxChars`（零回归）。
   */
  summaryMaxCharsByLevel?: Partial<Record<'day' | 'week' | 'month' | 'year', number>>
  /** 侧车用量轨迹（只追加、吞错、按体积轮转；绝不改条目） */
  accessTrace: { enabled: boolean; maxBytes: number }
  /** 提案日志（v0.7：让提案有历史——audit 候选 + forget/update 动作同文件可 join） */
  proposalLog: { enabled: boolean; maxBytes: number }
  /** 压缩流水线轨迹（v0.8：让「为什么这个桶没压」有证据——scan 判定分布 + 逐桶样本） */
  compressTrace: { enabled: boolean; maxBytes: number }
}

/** 加权查询词项（v0.7 上下文重心：注入查询 = 加权词项集合，而非单条消息字面） */
export interface WeightedTerm {
  term: string
  weight: number
}

/**
 * 检索打分参数（2026-10-27 · 供评测扫参，生产调用**不传**即用默认值）。
 *
 * **为什么把常量变成可注入**：这三项此前都是我拍的数（`k1=1.2` / `b=0.75` / `floor=0.05`），
 * 没有任何权威真源 ⇒ 按「能推导就别硬编码」的纪律，它们**本来就该可调**。
 * 有了零标注评测集（`tests/recall-eval/`）之后才能**扫**：在 tune 集上选参数，
 * 留出集只跑一次验收（样本外纪律）。
 *
 * ⚠ 生产路径（`tools.ts` 的 `recall` 工具）**不传本对象** ⇒ 行为与不参数化时逐位一致。
 */
export interface RecallTuning {
  /** BM25 饱和参数 k1。0 = 关掉饱和项（公式自动退化为恒 1，不需特判） */
  k1?: number
  /** BM25 长度权重 b。0 = 不按长度归一；1 = 完全归一（同样自然退化为恒 1） */
  b?: number
  /** 相对分门槛：保留 `score ≥ top1 × 本值`。0 = 关闭（不砍长尾） */
  relativeFloor?: number
  /**
   * 查询整句 token 策略（v0.32 · 噪声抑制实验臂）。
   * `keep`（缺省）保留中文长段原词；`drop` 只保留其 2-gram。
   *
   * 动机（2026-11-19 06:14 真库分解）：查「压缩之后怎么恢复上下文」时，整句 token 的
   * `df=1`、`idf=6.79`，是**该查询的最高分项**——它命中的是「引用过这句话的条目」，
   * 那是抄袭检测信号，不是相关性。实践中它把一条 40 分钟前写的评测记录推到了第 1 名。
   */
  longToken?: 'keep' | 'drop'
  /**
   * 单 token 多字段命中封顶（v0.32 · 噪声抑制实验臂）。
   * `false`（缺省）= 现行行为：同一词在别名/标签/标题/正文各命中一次就各加一份
   * （3+3+2+1 = **9 倍 IDF**）。`true` = 每个词项的总贡献封顶在 `SCORE_TAG × IDF`（最高单档）。
   *
   * 动机（同次实测）：错答案第 2/3 名**只靠「恢复」一个词**拿到 alias 7.58 + tag 7.58 +
   * title 5.05 + body 2.53 = 22.7 分，而该词 df=153（8.6% 的库），与问法只是词面撞车。
   * 语义主张：一个词有多相关取决于**它最靠入口的那次命中**，不重复计。
   */
  multiFieldCap?: boolean
  /**
   * 泛词门生效值（v0.32 · 噪声抑制实验臂）：被泛词门判为「无区分力」的词项，其 IDF 乘本系数。
   * `0`（缺省）= 沿用 v0.9 的**归零**（逐位不变）；正数 = **降权而不归零**。
   *
   * 为什么该有这一档（2026-11-19 06:22 真库分解）：泛词门的两条判据（`df ≥ 50` 且 `df/N > 10%`）
   * 只问「高频」，不问「是不是用户说的核心概念」。查 `压缩之后怎么恢复上下文` 时 `压缩`
   * df=200（11.3%）被判泛词 ⇒ **整词归零**，于是金标「三载体分工」的 11.63 分里 11.63
   * 全部来自 `缩之`+`后怎` 两个跨词边界垃圾 bigram（它们 df 只有 3–6，压根撞不上泛词门）。
   * ⇒ 当前归零机制**只伤高频真词，从不伤垃圾 bigram**——这是判据设计错，不是阈值错。
   */
  genericFactor?: number
  /**
   * 疑问句式骨架剥离（v0.33 · 方案 §8.2「意图识别」）。
   * `false`（缺省）= 现行行为：疑问短语的 2-gram 照常参与打分。
   * `true` = 查询命中的疑问/指代短语，**其自身的 2-gram 不进查询词项**。
   *
   * 动机（2026-11-19 06:26 五档实验）：泛词门降权救回了主题词（`压缩之后怎么恢复上下文`
   * 首金 9→3），但同一次降权把**疑问句骨架**（`什么` / `状态` / `现在`）也抬回来，
   * 负对照 `期货工程现在什么状态` 因此 80%→60%，净值零。词频分不开这两类（都高频）
   * ⇒ 只能按句式判定：句式的字面部分可以枚举，就枚举它，其余不动。
   *
   * ⚠ 刻意保守：只剔**短语自身**，不剔「短语 + 名词」里的名词（`什么状态` 的「状态」保留），
   * 因为那需要分词器，而无分词的猜词会误杀主题词（`状态` 在「状态管理是重中之重」里是主题）。
   */
  dropQuestionFrames?: boolean
  /**
   * 查询分词器（v0.33 · 中文词边界）。
   * `ngram`（缺省）= 现行行为：按空白切分 + 中文连续段展开成字符 2-gram。
   * `segmenter` = 用 `Intl.Segmenter`（Node 内置 ICU，零依赖）按**词边界**切分，**不做 2-gram 展开**。
   *
   * 动机（2026-11-19 07:51 最小探测）：同一批条目下，把查询手工切成 `压缩 / 恢复 / 上下文`
   * 之后，真金标「LLM 驱动的上下文压缩（NOA）」从**第 9 名升到第 5 名**。
   * 机制：2-gram 的噪声来自**跨词边界的字符对**（`缩之` / `后怎` / `么恢`）——它们 df 极低
   * （3–6）所以 IDF 极高（5.5–6.1），在打分里压过真正的主题词。有了词边界，这类噪声
   * 结构上不会产生。
   *
   * ⚠ 已知弱点：ICU 词典对少见词会切成单字（`评测` → `评` + `测`）。单字要么被泛词门
   * 归零（df 高），要么贡献很小——这是「用近似换结构正确」的代价，用读数判，不靠直觉判。
   */
  tokenizer?: 'ngram' | 'segmenter'
}

/** 检索查询 */
export interface RecallQuery {
  query?: string
  /** 上下文重心（v0.7）：与 `query` 二选一；给了它则按权重打分 */
  weightedTerms?: WeightedTerm[]
  kind?: EntryKind[]
  tags?: string[]
  since?: string
  until?: string
  scope?: 'global' | string
  limit?: number
  includeArchive?: boolean
  /** 角色视角覆盖（缺省 = 调用者身份推导；仅当 roles.enabled 时生效） */
  role?: string
  /**
   * 主体层过滤（v0.13.0）：只看「关于谁」的条目。缺省 = 不过滤（通用条目照常返回）。
   * ⚠ 与 `role` 的**准入**不同——这是**可选筛子**，不是可见性边界：设了 subject 的
   * 条目对任何调用方**依然可见**，只是不匹配本次筛选。
   */
  subject?: Subject
  /**
   * 内容分类过滤（v0.26.0）：只看某几类馆藏（七类可多选）。缺省 = 不过滤。
   * ⚠ 可选筛子，不是可见性边界；**未分类条目在任何取值下都不返回**（它的类型是
   * 「不知道」，不是某一类——同 `staleness` 的「未设死线」纪律）。
   *
   * 空间过滤（v0.27.0）：只看某几个空间。缺省 = 不过滤；**未标注空间的条目在任何取值下
   * 都不返回**（它的空间是「不知道」，同 memType 纪律）。
   */
  space?: Space[]
  /**
   * 生命周期过滤（v0.27.0）：只看处于某几态的条目（六态可多选）。缺省 = 不过滤。
   * 取值是**派生读法** `lifecycleOf()` 的结果，不是存储字段的直接值。
   */
  status?: LifecycleState[]
  memType?: MemType[]
  /**
   * 执行位置过滤（v0.23.0）：只看某个项目 / 某个任务的条目。
   *
   * 级联语义：只给 `project` = 该项目全部（含其下所有任务）；给 `project` + `taskId` =
   * 精确到任务。**给 `taskId` 必须同时给 `project`**（任务 id 只在项目内唯一）。
   * 缺省 = 不过滤（通用条目照常返回）。
   * ⚠ 同为**可选筛子**，不是可见性边界（理由同 subject）。
   */
  project?: string
  /** 执行位置过滤（v0.23.0）：任务节点 id；必须与 `project` 同时给 */
  taskId?: string
  /**
   * 约定状态过滤（v0.14.0）：只看向「**是否已被共同建立**」的条目——
   * `proposed` = **只看我自己提的、主人未回应的事**（自查「我有没有把提议当成定论」时用它）。
   * `established` = 只看主人明确说过的。缺省 = 不过滤。
   * ⚠ 同为**可选筛子**，不是可见性边界（理由同 subject）。
   */
  grounding?: Grounding
  /**
   * 时效维过滤（v0.15.0）：只看**该重看**的条目——`expired`（已过复查死线）/
   * `due-soon`（7 天内到期）/ `fresh`（还早）。可多选。缺省 = 不过滤。
   *
   * 典型用法：`recall({ staleness: ['expired', 'due-soon'] })` = 「**我的哪些结论该重看了**」。
   *
   * ⚠ 可选筛子（同 subject / grounding）；且**只筛「设了死线」的条目**——未设死线的条目
   * 在任何取值下都不返回。它们的时效状态是「**不知道**」，不是「有效」。
   */
  staleness?: StalenessLevel[]
  /**
   * 是否为每个结果附加联想链（`related`，v0.3 维度）。
   *
   * **缺省 true**（`recall` 工具的模型可见输出渲染「→ 关联: …」，必须保留）。
   * 设 false = 跳过 `relatedOf`——**每条结果一次全库扫描**，实测 20 条结果耗时
   * 500–640 ms（2026-10-13 分解读数）。
   *
   * 用于**不消费 `related` 的调用方**：`auto-inject.buildAutoRecallDigest` 只用
   * title/kind/updatedAt/score/snippet，却同样走 `recallEntries` ⇒ 白算联想层。
   * 实测 auto-recall 真实形状（limit=3）跳过联想后 **95 → 41 ms（省 56%）**。
   * 该路径**每条主人消息都跑**，是最热的调用点。
   */
  withRelated?: boolean
  /**
   * 家族折叠（v0.16.0 · 论文 Memory Echo 的 Family 组件）：把**候选池内**的
   * 「概要与其 `archiveRef` 原料」归为一族，**每族最多占一个服务位**（族内得分最高者为代表）。
   *
   * 论文依据（arXiv 2610.17763v1 §5.1）：「**Repeated writes therefore add records,
   * not independent votes**」——同一来源的派生记录不该被当作多个独立证据占检索位。
   *
   * ⚠ **缺省 false（默认关）**，理由是论文自己的消融：Family 单独上线会把准确率
   * 从 0.825 打到 **0.651**（≈ −33 题）——它必须与「当前事实优先」（Authority）配对
   * 才不掉分，而后者本插件尚无 ⇒ 先提供可选手段，待有配套再议默认。
   * 论文亦明确「The representative is selected anew from the current candidate pool」
   * 且「source grouping **does not delete** the unselected records」——本实现照此：
   * 只影响**本次占位**，数据不动，仍可 `includeArchive` 取回。
   *
   * ⚠ 与 `includeArchive` 的关系：默认视图下原料已冷归档、不会与概要同时命中，
   * 故本项**只在 `includeArchive=true` 时有实际效果**（实测：活跃概要 + 活跃原料同源对 = 0）。
   */
  collapseFamily?: boolean
  /**
   * 打分参数覆盖（2026-10-27）：**只给评测/消融用**，生产路径不传。
   * 不传时逐项回退 `BM25_K1=1.2` / `BM25_B=0.75` / `RECALL_RELATIVE_FLOOR=0.05`。
   */
  tuning?: RecallTuning
  /**
   * 实体匹配（v0.31.0 · 方案 §8.3「实体匹配」）：调用方**已解析好**的实体候选——
   * 每条 = 该实体的全部称呼（已归一）+ 本次查询点到它的强度。
   *
   * 为什么由调用方解析、不在这里查表：`search.ts` 是纯函数层（输入条目 → 排序），
   * 拿不到实体表；把「查询 → 实体」放在工具层只用一处实现，两层各自可离线测。
   *
   * 缺省 `undefined` = 不做实体匹配（存量排序逐字不变）。
   */
  entityMatches?: readonly RecallEntityMatch[]
}

/** 一条实体匹配信号（`RecallQuery.entityMatches` 的元素） */
export interface RecallEntityMatch {
  /** 该实体的全部称呼，**已归一**（`normalizeEntityName`：小写 + 折叠空白） */
  names: readonly string[]
  /** 本次查询点到它的强度（精确命中规范名/别名 = 1；缺省按 1 计，不做默认值猜测） */
  weight: number
}

/** 检索结果项 */
export interface RecallResultItem {
  id: string
  kind: EntryKind
  title: string
  snippet: string
  tags: string[]
  scope: string
  level: TimelineLevel | null
  score: number
  archived: boolean
  updatedAt: string
  /** 角色归属（v0.5，缺省为共享记忆） */
  role?: string
  /** 主体层（v0.13.0，缺省 = 通用；仅当条目已标注时出现在结果里） */
  subject?: Subject
  /** 内容分类（v0.26.0；仅当条目已分类时出现在结果里）——情景 / 语义 / 程序 / 画像 / 项目 / 关系 / 运行 */
  memType?: MemType
  /** 空间归属（v0.27.0；仅当条目已标注时出现在结果里）——个人 / 项目 / 领域 / 系统 */
  space?: Space
  /** 生命周期（v0.27.0；始终出现）——六态的派生读法，见 `lifecycleOf()` */
  lifecycle?: LifecycleState
  /** 执行位置（v0.23.0；仅当条目已标注时出现在结果里）——这条记忆是在哪个项目得到的 */
  project?: string
  /** 执行位置（v0.23.0；仅当条目已标注时出现）——哪个任务节点（只在 project 内唯一） */
  taskId?: string
  /** 约定状态（v0.14.0；仅当条目已标注时出现在结果里——缺省表示「未标注」而非「已建立」） */
  grounding?: Grounding
  /**
   * 时效维（v0.15.0；仅当条目设了时出现在结果里）——复查死线 `YYYY-MM-DD`。
   * 渲染层按它与当前时刻算档位（已过期 / N 天后复查），**不预存档位**（存了就会与
   * 「读取时刻」脱钩：今天算出的「3 天后」明天就成了假读数）。
   */
  reviewAfter?: string
  /** 时效维（v0.15.0；仅当条目设了时出现在结果里）——观察条件（在等什么新信息） */
  watchFor?: string[]
  /** 情境形状（v0.16.0；仅当条目设了时出现在结果里）——什么处境的「形状」该用这条经验 */
  cue?: string[]
  /**
   * 生效时间（v0.24.0；仅当条目设了时出现在结果里）——这条结论**从何时开始成立**。
   * 渲染层把它印出来，与 `createdAt`（写入时刻）区分开——两者可以差很远。
   */
  validAfter?: string
  /**
   * 被替代（v0.24.0；仅当条目**已被替代**时出现在结果里）——替代它的那条记忆 id。
   *
   * ⚠ **不预存「是否过时」的布尔**（同 `reviewAfter` 的档位纪律：档位取决于读取时刻，
   * 存进结果项就会与它脱钩）。字段存在即已替代，判据见 `succession.ts::isSuperseded`。
   */
  supersededBy?: string
  /** 替代了谁（v0.24.0；仅当条目替代过别的条目时出现在结果里）——被它顶掉的记忆 id 列表 */
  supersedes?: string[]
  /**
   * 证据引用（v0.25.0；仅当条目带证据坐标时出现在结果里）——这条记忆能回到哪里（编码串）。
   * 与 `provenance`（权威归谁）互补：那个答「谁说的」，这个答「去哪核」。
   */
  evidenceRefs?: string[]
  /** 来源类型（v0.21.0；仅当条目设了时出现在结果里）——`master` / `web` / `self` / `measured` */
  provenance?: Provenance
  /**
   * 归档原因（v0.21.0；**仅对已归档条目出现**）——这条怎么没了。
   * 由 `archive.ts::archivalOf` 归一（v0.20 及以前的存量原因在 `source.reason` 里，
   * 读取时读成 `archivedReasonType: 'unspecified'`）。归档时刻 = 条目的 `updatedAt`。
   */
  archivedReasonType?: ArchiveReasonType
  archivedReason?: string
  /**
   * 转述型·无出处（v0.19.1；**仅在判定为真时出现**）——标题是「精读/调研/评估/review…」一类
   * 转述形态，而全文找不到可核出处（arXiv 编号）。
   * 语义不是「这条记忆错了」，而是**它的权威不是我实测来的**：拿它当自己的结论用之前，
   * 要么回去核对原文，要么把它降为「别人的说法」。判据在 `origin.ts`（与审计脚本同源、由测试锁对齐）。
   */
  transcriptiveUncited?: boolean
  /** 联想层（v0.3）：相关条目链（共享标签/标题/正文关联），关联强度降序 */
  related?: RelatedItem[]
}

/** 联想条目（关联记忆：同标签/标题/正文关联，因果留痕维度） */
export interface RelatedItem {
  id: string
  kind: EntryKind
  title: string
  scope: string
  /** 共享标签数 */
  sharedTags: number
  /** 关联强度（共享标签×3 + 标题重叠×2 + 正文重叠×1） */
  strength: number
}

/** remember 返回 */
export interface RememberResult {
  id: string
  action: 'created' | 'updated' | 'merged'
}

/** 记忆浏览查询（memory_browse：按时间线分组翻档案，与 recall 互补） */
export interface BrowseQuery {
  kind?: EntryKind[]
  tags?: string[]
  since?: string
  until?: string
  scope?: string
  includeArchive?: boolean
  /** 只看指定层级（week/month/year）；缺省 = 全部层级按时间分组 */
  level?: TimelineLevel
  /** 分页（1 起） */
  page?: number
  pageSize?: number
  /** 角色视角覆盖（v0.5） */
  role?: string
  /** 主体层过滤（v0.13.0）：只看「关于谁」的条目。缺省 = 不过滤。 */
  subject?: Subject
  /** 内容分类过滤（v0.26.0）：只看某几类馆藏。缺省 = 不过滤；未分类条目在任何取值下都不返回。 */
  memType?: MemType[]
  /** 空间过滤（v0.27.0）：只看某几个空间。缺省 = 不过滤；未标注条目在任何取值下都不返回。 */
  space?: Space[]
  /** 生命周期过滤（v0.27.0）：只看某几态（六态名）。缺省 = 不过滤。 */
  status?: LifecycleState[]
  /** 执行位置过滤（v0.23.0）：只看某个项目的条目。缺省 = 不过滤。 */
  project?: string
  /** 执行位置过滤（v0.23.0）：任务节点 id；必须与 `project` 同时给 */
  taskId?: string
  /** 约定状态过滤（v0.14.0）：`proposed` = 只看我自己提的、主人未回应的事。缺省 = 不过滤。 */
  grounding?: Grounding
}

/** 浏览分组：一个时间桶下的条目（level 为概要层级 week/month/year；明细组为 null） */
export interface BrowseGroup {
  bucket: string
  label: string
  level: 'day' | 'week' | 'month' | 'year' | null
  items: RecallResultItem[]
}

/** 记忆浏览返回 */
export interface BrowseResult {
  groups: BrowseGroup[]
  total: number
}

/** recall 返回（规格 §4：{ results, total }） */
export interface RecallResult {
  results: RecallResultItem[]
  /** 过滤后、截断前的命中总数 */
  total: number
  /**
   * v0.16.0：家族折叠的说明（**仅当真发生折叠时出现**）。
   *
   * 它解释「为什么返回条数看着比命中数少」——把 `query.collapseFamily` 压掉的同源条目
   * 如实报出来，避免「静默少了几条」被读成「检索漏了」。信噪比纪律同 `groundingTag`：
   * 无折叠即不打这一行。
   */
  familyNote?: string
  /**
   * v0.12：被泛词门抑制的词项（idf 置 0）。**仅在结果为空时出现**。
   *
   * 为什么需要它（2026-10-10 实测）：泛词门（v0.9）会把过泛的词 idf 置 0 ⇒ 全部得分清零
   * ⇒ `total=0`。但空结果此前**只有一种表达**「命中 0 条」，模型会把它读成
   * 「**没有相关记忆**」——而实测 `recall("插件")` / `recall("技能")` 就是这种情形
   * （库里分别有 510 / 395 条提及，却都返回 0 条）。
   *
   * ⇒ 「**被抑制**」与「**真的没有**」必须分开说（同 §L1.5 的
   * 「契约违规 vs 真的没标签」——自己犯过的同型错误在检索层复发）。
   */
  suppressedTerms?: string[]
}
