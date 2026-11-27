# Agent Nihil Obstat（ANO）：架构设计与落地执行计划（最终版 v1.0）

> 项目名：**Agent Nihil Obstat**，简称 **ANO**（原名 Tribunal，已全文更名）。
> 本版合并 v0.1/v0.2 全文与三轮评审增量（Barrel 穿透与方向性约束、会话切分 Segment、中文检索盲测、
> 三态边与标识符拆分、宿主 TS 加载安全），为唯一执行依据，此前各版作废。
> 依据：对 pm-mcp、obelisk、codegraph 三个项目的源码通读（`three-projects-deep-read.md`）。
> 标注约定：
> - **[已验证]**：读过源码确认。
> - **[待验证]**：推断或记忆，动手前必须做对应 Spike，Spike 不预设结果。
> - **[构想]**：工程常识，无源码依据，必须在真实项目上校准。
>
> 本文是设计，**没有任何一部分经过实测或联调**。不存在"没有死角"的状态；P1 竖切的失败判据必须保留。

---

## 名称

**Agent Nihil Obstat（ANO）**。*Nihil obstat* 是拉丁语"无可阻碍"：出版审查中，审查者确认作品
未发现违反既定标准的内容后签发的"无异议"声明——它不证明作品优秀，只证明**按声明的标准审查过、未发现问题**。
这正是本工具的核心主张：agent 只能"声称"，机器负责"裁决"。任务是否完成、版本是否满足发布条件，
都由证据、源码指纹和代码图计算出裁决（Verdict = 机器签发的 nihil obstat），不由 agent 自报；
最终放行（`release approve`，相当于人的 imprimatur）永远由具名的人在 CLI 上确认。

- CLI：`ano`；MCP server 名：`ano`；项目内目录：`.ano/`。
- **未做名称查重。** Phase 0 Step 0.1 是第一步：查 `ano`、`nihil-obstat`、`agent-nihil-obstat`
  在 npm / GitHub / 商标上的占用。三字母包名 `ano` 极可能已被占用（此为推测，待查重确认），
  预计需要 npm scope（如 `@<scope>/ano`）。有冲突向用户提备选，不得自行改名。

---

# 第一部分：核心架构

## 0. 范围声明

三个项目体量悬殊，"完全取代"必须分档，否则 v1 永远做不完。

| 档位 | 含义 |
|---|---|
| **A 取代** | 能力对等或更强，不再需要原工具 |
| **B 部分取代** | 只覆盖用户实际在用的子集，其余插件化 |
| **C 暂缓** | 明确不做，不假装覆盖 |

| 原项目能力 | 档位 |
|---|---|
| pm-mcp：账本、任务、路线图、断点、幂等、质量/验收门禁、安全/许可证审计 | **A** |
| pm-mcp：自动编排 | **B**：v1 只做轮次账本与租约，不做派发 |
| codegraph：符号图、调用链、影响范围、单入口 explore | **B**：v1 只做 TS/JS，语言走插件 |
| codegraph：41 语言、Rust 内核、Svelte viewer、动态分发合成器 | **C** |
| obelisk：跨 harness 会话索引、检索、持久记忆 | **B**：v1 只做用户实际使用的 2–3 个客户端 |
| obelisk：Electron 桌面端、recap、12 个 provider | **C** |
| 上线就绪评审（三者均无） | **新增**，见第二部分 |

C 档后来发现是刚需，就改档位，不要悄悄加代码。

## 1. 设计原则

1. **账本是唯一事实，其余全是缓存。** 代码图、会话索引、全文索引、物化视图都能删了重建，且永不进 git。
2. **完成由机器计算，不由 agent 自报。** pm-mcp 的完成门禁检查的是 agent 自填的 `task.files` [已验证]；
   ANO 用 git diff 加代码图推导，agent 只能补充，不能缩小。
3. **不确定就降级并标注，不猜，也不静默。** 统一成"置信度 + 来源"词汇。
4. **过估计在两个方向上风险相反（不对称约束，全系统强制）：**
   - `impact`（谁受影响）取**超集**：含 heuristic 边，多算 = 门禁偏严 = 安全。
   - 覆盖计分（哪些文件已被测试覆盖）取**子集**：只计确认的值依赖，多算 = 假放行 = 危险。
   - **禁止两个用途共用同一种边语义。** 这是本设计的安全基石。
5. **工具面按意图收缩。** codegraph 默认只暴露 1 个工具 [已验证]，理由是工具越多 agent 越选错。
   目标 7 个工具，而不是 59 + 17。
6. **规则必须可执行，否则必然腐烂。** pm-mcp 自己的 `install.ps1` 停在 0.6.1、README 数字全过期 [已验证]。
   文档里的版本号、工具数、provider 列表由代码生成，CI 比对。
7. **每个降级路径都有可观测出口。** 索引不完整、历史源缺失、图被截断、动态加载不可解析，
   必须在返回里说出来，不能让标签掩盖"看不见"。
8. **证据只认外部产出，不认自报。** 就绪项只能由机器证据或具名人签字满足，缺失即阻断。

## 2. 分层

```
┌────────────────────────────────────────────────────────────┐
│ Surface    MCP(7 工具) · CLI · 只读面板 · 生成的 dashboard      │
├────────────────────────────────────────────────────────────┤
│ Readiness  Profile · 外部证据 · Attestation · Release Verdict │ ← 第二部分
├────────────────────────────────────────────────────────────┤
│ Gate       Policy · Evidence · Blast-radius · Task Verdict    │
├───────────────┬──────────────────────┬─────────────────────┤
│ Structure     │ Memory               │ Audit                │
│ 代码图(缓存)   │ 会话历史(缓存)         │ 安全/许可证/漂移       │
├───────────────┴──────────────────────┴─────────────────────┤
│ Ledger    追加式事件日志(事实) → 物化视图(缓存)                 │
├────────────────────────────────────────────────────────────┤
│ Core      根解析 · 锁与租约 · 幂等 · 指纹 · 配置 · 日志          │
└────────────────────────────────────────────────────────────┘
```

依赖只能向下。Structure、Memory、Audit 互不依赖，只在 Gate、Readiness 与 Surface 汇合，
所以任何一层坏了，账本和门禁仍然工作（降级而非崩溃）。

## 3. 统一实体与 Anchor

| 实体 | 存放 | 说明 |
|---|---|---|
| Task / Milestone / Checkpoint / Feature | 账本 | 工作单元 |
| Decision（ADR）/ Pitfall | 账本 | 决策与踩坑，带锚点 |
| Memory | 账本 | 经批准的持久记忆，属于账本而非会话库 |
| Evidence | 账本 | 一次可复算的验证结果 |
| Finding | 账本 | 审计发现 |
| Attestation / ReleaseVerdict | 账本 | 见第二部分 |
| Symbol / Edge / File | 图缓存 | 代码结构 |
| Session / Message / ToolCall | 历史缓存 | 过去 agent 做过什么 |

**Anchor 是融合的接缝。** 一条 Decision 锚定到 `src/auth/session.ts::refreshToken` 后，
任何任务触及这个符号，`brief` 就能浮出它。没有 Anchor，三层只是并排放着。

**Anchor 的稳定性**：符号会改名、移动。三级退化：
1. `symbol_id`（稳定 ID，**不得含行号**）→ 精确
2. `qualified_name + file` → 改名后失效但可模糊重定位
3. `file + 内容指纹片段` → 最低保证

重定位失败标 `stale` 并在 `audit` 列出，不静默丢失，也不指向错误符号。
codegraph 的节点 ID 含行号（`kind + sha256(filePath:kind:name:line)`）[已验证]，ANO 不照搬。
**Barrel 穿透后，Anchor 一律以定义文件为准，不锚定转发文件。**

## 4. Ledger 层

### 4.1 追加式事件日志（按会话切分 Segment）

pm-mcp 账本是多个 JSON 文件加账本锁，跨多个文件没有事务原子性，README 自己承认 [已验证]，
靠"最后写 `project.json` 当提交点"补救。ANO 改为追加式事件日志：

```
.ano/
  ledger/
    <ISO时间>-<session_id>.jsonl   # 一个进程/会话一个文件，只由该会话追加，进 git
  cache/                           # 全部可删，.gitignore
    views.db   graph.db   history.db
  config.toml                      # 唯一配置，进 git
```

- 一个 MCP 进程生命周期（或一次会写入的 CLI 调用）= 一个 segment，**懒创建**，只读调用不产生文件。
- 事件：`{id(ULID), hlc, actor, kind, payload, idem_key?, prev_hash}`。
- **每个 segment 内部维护单链 `prev_hash`，从不跨文件。** git 分支合并 = 文件并集，哈希链不会断裂。
- 全局顺序靠 **HLC**，不靠哈希链排序。**[待验证]** HLC 在时钟回拨下的行为（S3）；退路是单 actor 串行日志。
- **一次工具调用 = 一个批次，单次原子追加**：持锁 → 写 `batch.begin` + 事件 + `batch.end`（含校验和）→ fsync。
  恢复时截掉没有 `batch.end` 的残尾。**只有该 segment 自己的写者能截断**；
  合并进来的别人的 segment 一律只读，遇到残尾只忽略，不修改。
- 不可变：只追加；修改是追加新事件，删除是墓碑。
- 物化视图存 `views.db`，由日志重放得到，损坏就全量重放。`PROJECT.md` 是视图的再导出，不是事实。
- **幂等键查重必须走 `views.db` 索引**（跨 segment），不得扫文件。

**本设计的已知代价（如实声明）：**
1. **篡改检测变弱**：单链只能发现单个 segment 内部被改，整个 segment 文件被删除检测不到。
   补救（P2 实施）：每个 segment 的头事件记录启动时观察到的其他 segment 头哈希（`observed`），
   后续引用了已不存在的 segment 即可发现缺失。仍然各写各的文件，不产生合并冲突。
2. **文件数量随会话数增长**（一年可能数千个）。轮转/归档方案**待定**（P2 开放问题）：
   归档会改变文件，必须先确认不破坏哈希与 observed 引用。

### 4.2 幂等与崩溃

沿用 pm-mcp 已被测试验证的语义 [已验证]：写工具带 `idem_key`，同键同参只执行一次，同键异参拒绝。
改进：批次是否提交是日志上可判定的事实，崩溃后重试要么无副作用，要么命中已提交记录返回原结果，
pm-mcp 的 `uncertain` 状态不再需要。外部副作用（如执行测试）不进账本事务：
先记 `verify.started`，结束记 `verify.finished`，崩溃留下的是显式"未完成"。

### 4.3 租约

pm-mcp 的 `active_run_id` 无超时，崩溃后永久占用，且恢复时默认记为"有证据" [已验证，`orchestrator.ts`]。
ANO 的 `Run` 带 `lease_expires_at`，心跳续约，过期可 `reclaim`，事件记 `reclaimed_from`，
被回收的轮次默认 `produced_evidence = false`。

## 5. Structure 层

**目标**：agent 问结构问题时一次拿到"逐字源码 + 调用路径 + 影响范围"。
判断标准照搬 codegraph：答案够不够让 agent 停止 Read。

**少而完整**：codegraph 自己的结论是"部分覆盖比不覆盖更糟" [已验证]。
宣布支持的语言必须通过端到端 flow 验收，不支持的返回"未覆盖"，绝不返回残缺图。

### 5.1 抽取分层

| 层 | 内容 | provenance |
|---|---|---|
| L0 | 文件级 import/依赖 | `parsed` |
| L1 | 符号定义、包含、继承、**导出表（含 symbol_kind）** | `parsed` |
| L2 | 调用边（名称解析后） | `resolved` / `heuristic` |
| L3 | 框架约定、回调、动态分发合成 | `heuristic` + `synthesizedBy` |

### 5.2 重导出三档处理（P1 就做，不硬啃复杂语法）

**总策略：宁可保守标 heuristic，绝不静默漏边。** 穿透写漏产生假阴性（漏算受影响文件 → 门禁误放行），
比不穿透产生假阳性（传染全图 → 门禁误拒）危险得多。

| 档 | 情形 | 处理 |
|---|---|---|
| 1 | `import type` / `export type` / `export { type X }`（内联修饰） | 语法层 100% 明确，标 `type-only`，T1 覆盖计分剪枝 |
| 2 | 显式具名重导出（`export { a as b } from './x'`、default 再导出） | 语法层确定，标 `resolved`，按符号穿透到**定义文件** |
| 3 | `export * from` / `export * as ns` / 动态 `import()` / `require()` / 无法静态确定的解构 | **不猜穿透**，退化为文件级依赖边，标 `heuristic(barrel_wildcard)` / `heuristic(dynamic_import)` |

- `import './polyfill'` 等副作用导入保留文件级 `sideEffect` 边，不穿透。
- 穿透必须有环检测（barrel 互相 re-export）与深度上限，超限标 `heuristic`，不静默丢。
- **模块解析**（相对路径、`tsconfig.paths` 别名、`package.json` 的 `exports/#imports`）tree-sitter 不提供，
  由 S7 决定路线（见执行计划）。

### 5.3 边的三态语义（不对称约束的落地）

每条 import/依赖边最终归入三态之一：

| 态 | 判定 | 计入 impact | 计入覆盖计分 |
|---|---|---|---|
| `value-confirmed` | 确认是运行时值依赖 | ✅ | ✅（唯一可计覆盖的态） |
| `type-only` | 确认纯类型（显式 type 语法，或 L1 导出表判定） | ✅ | ❌ |
| `unknown` | 解析失败 / `export *` 转发 / 外部包来源 / 无法确认 | ✅ | ❌，且计数进 caveats |

**类型擦除的低成本识别（P1 实施）**：普通 `import { User }` 而 `User` 实为 interface 时，
编译产物擦除该依赖，但语法上无 `type` 标记。用双方文件的 tree-sitter L1 导出表交叉比对：

- 纯类型节点：`interface_declaration`、`type_alias_declaration` → `symbol_kind = 'type'`。
- 值或混合节点：`function_declaration`、`class_declaration`、`variable_declarator`、
  `enum_declaration`、`namespace` → `symbol_kind = 'value'`。
- **混合声明保守规则**：同名声明合并（`interface Foo` + `const Foo`）等，
  只要该名字存在**任何**值性质声明，按 value 处理；只有**所有**声明都是纯类型才判 type。
- 一条 import 导入多个名字：**全部**名字纯类型才整条降级；混合则拆成 value 与 type 两条边各自标注。
- **判定只在能确定时发生**：目标符号解析失败、外部包、`export *` 转发 → 归 `unknown`，
  **不降级也不按 value 计覆盖**（unknown 在覆盖计分里不算，方向上安全）。
- 此方法把一部分 unknown 变成 type-only 或 value-confirmed，**缩小 unknown 占比，不能消灭它**。

### 5.4 T1 覆盖的语义口径（barrel 场景）

测试 import barrel 时运行时会加载全部子模块，但"被测试覆盖"采用**语义口径**：
只计测试实际引用的名字所指向的定义文件（且边为 `value-confirmed`）。
仅被 barrel 顺带加载的文件不算覆盖，否则任何测试 import 了 `index.ts` 就等于覆盖全部，门禁假放行。

### 5.5 静态分析的固有盲区（Verdict caveats 必须报告）

1. **运行时才确定的动态加载**（`import(变量)`、`require(拼接字符串)`）连文件级边都产生不出来。
   这不是 heuristic，是**看不见**。按文件统计"含不可解析动态加载的数量"，Verdict 返回它。
2. **type-only 识别依赖 L1 导出表**，unknown 边占比即残余风险，报告数字，不被降级逻辑掩盖。
3. Verdict 始终报告：三态边数量与比例、`unknown` 占比、heuristic 边占比、动态加载计数。

### 5.6 存储与新鲜度

- `graph.db`（SQLite WAL）：`nodes / edges / files / unresolved_refs`。符号 ID 不含行号。
- 增量：`(size, mtime)` 快筛 + 内容哈希确认，只重抽变更文件。
- **扫描失败处理**：pm-mcp 的 `scan.ts:171-175` 在 `readdirSync` 失败时静默返回，
  随后 `index-store.ts:216` 删除没出现的行 [已验证]，I/O 错误被当成文件被删。
  ANO：枚举或读取出错 → 文件标 `unknown`，保留旧数据，图整体标 `degraded`；
  **只有明确的 ENOENT 才写墓碑**。
- 每次结构查询返回 `graph_revision` 与当前源码指纹的差距：`fresh | stale(n) | degraded`。
  Gate 拒绝用 `stale` 的图做完成判定。
- 单写者：沿用 pm-mcp 已测试验证的 SQLite `BEGIN IMMEDIATE` 事务生命周期选主
  （进程被杀后由 OS 释放，不依赖 PID 租约）[已验证]。
  不引入常驻 daemon 与代理，codegraph 的 daemon/proxy/writer-lock 状态机是其自述的高风险区。
- Query 原语只有：`symbol`、`flow`、`impact`、`search`、`outline`。
  `explore` 把它们按任务描述编排成单次返回，输出预算按仓库规模分档。
  **[待验证]** 数值对目标客户端的输出上限实测，不抄 codegraph 的 24K 字符。

## 6. Memory 层

拆成两件事，因为生命周期不同（obelisk 在 force rebuild 时特意把 `memories` 排除在快照外 [已验证]）：

| | 会话历史 | 持久记忆 |
|---|---|---|
| 性质 | 过去发生了什么（证据） | 经人批准的结论（断言） |
| 存放 | `history.db`（缓存，可重建） | **账本**（事实，进 git） |
| 来源 | 各客户端原始会话文件 | `note` 动作，必带 Anchor |
| 丢了 | 从原始文件重建 | 不能丢 |

**Provider adapter**：沿用 obelisk 已验证的设计。adapter 是纯函数，
只做 `discover → IndexUnit[]` 与 `parse(unit, cursor) → TranscriptRecord 流`，不碰数据库，唯一写层共享。
吸收的经验：
- `visibility` 三态（visible / inactive / hidden）：被改写覆盖的历史标 `inactive`，不删除。
- 未知格式版本只跳过该单元并记 `skippedArtifact`，不毒化整个 provider。
- provider marker 版本，bump 触发一次重放；cursor 校验失败退化为全量。

**v1 客户端范围由用户决定（G3）。** 从本机配置看用户在用 ZCode、Qoder、Codex、Claude Code、WorkBuddy。
obelisk 覆盖 zcode/claude/codex，没有 Qoder。Qoder 与 WorkBuddy 的会话格式未读过，
**必须先取真实样本再写 adapter，不得凭 obelisk 先例推断**。

**检索不用脚本。** obelisk 的 `--query` 执行任意 JS，作者自己注释"not a security boundary"，
而 transcript 是不可信输入 [已验证]。`recall` 只接受结构化参数（session / 时间 / 文件 / 符号 / 关键词 / 来源），
内部是固定参数化 SQL，没有"检索文本被拼进脚本 → 代码执行"这条风险链。

### 6.1 中文与混排检索（方案由 S1 盲测拍板，此处只定框架）

候选五方案（全部零第三方 npm 依赖）：

| 方案 | 做法 | 已知短板（待实测确认） |
|---|---|---|
| A | 原生 `fts5(tokenize='trigram')` | [待验证] <3 码点 MATCH 可能静默 0 行（二字词"租约/账本"漏检）；LIKE 加速条件受限；长查询 BM25 失真 |
| B | `Intl.Segmenter('zh',{granularity:'word'})` + `unicode61` | 词粒度排序好；[待验证] UAX #29 把 `refreshToken` 当整词，查 `token` 漏检；分词边界不一致漏召回 |
| B+ | B + 标识符子词拆分 | 修补 B 的标识符短板 |
| C | 词列（高权重）+ CJK 2-gram 列（低权重），`bm25()` 加权 | 体积增大；CJK-only 2-gram 仍漏 `refreshToken` 内子串 |
| C+ | C + 标识符子词拆分（拆出的子词同时进词列与 n-gram 列） | 体积最大；常见子词（get/set/id）倒排变长 |

**标识符拆分函数（B+/C+ 共用，确定性规则，不依赖 ICU）：**
- 对 `isWordLike` 且匹配 `/^[A-Za-z0-9_$]+$/` 的片段：保留原词 + 追加小写子词。
- 拆分规则必须覆盖四类边界并各有测试用例：
  连续大写缩写（`XMLHttpRequest` → XML/Http/Request，不是 X/M/L）、
  驼峰接缩写（`parseHTMLString`）、字母数字边界（`utf8Decode`、`base64`，规则明确并测试）、
  分隔符统一（下划线/连字符/点：`refresh_token`、`kebab-case`、`a.b.c`）。
- 子词统一小写入索引，查询端同样小写化；**原文列保持原样**，展示与高亮不受影响。
- 索引端与查询端必须是**同一份函数**；函数版本 + `process.versions.icu` + `process.versions.unicode`
  写入 `meta`，任一变化即重建缓存（缓存可重建，代价可接受）。
- CJK 与标识符紧邻（`调用refreshToken函数`）的切分行为**记录实测输出，不假设**。

**通用规则：**
- 查询长度按 **Unicode 码点**算（`[...s].length`），不是 UTF-16 码元（`'𠮷'.length === 2` 的坑）。
- 单字符（含单汉字）查询所有方案降级到原文列 `LIKE`，返回标 `degraded: unigram-scan`。
- FTS 列不得用于 snippet（全是切分产物），snippet 从原文列取。
- v1 至少覆盖 Han；日文假名、韩文谚文写进 `limitations.md`。
- **FTS5 本身可用性是所有方案的共同前提**，不可用时备选内存倒排（S1 实测）。

**调用者身份**：吸收 nonce self-search 思路，但仅作标注、不用于过滤，冲突或不确定返回 `unknown`。

## 7. Gate 层（任务级裁决）

### 7.1 完成判定

```
done(task) =
    evidence 存在 ∧ evidence.ok
  ∧ evidence.source_fingerprint == 当前源码指纹              # 防测完又改
  ∧ 覆盖级别(evidence, blast_radius(touched)) ≥ policy.min_level
  ∧ 无 failed / skipped / cancelled / todo
  ∧ graph 新鲜 或 显式声明降级

touched = git_diff ∪ agent_declared        # agent 只能补充，不能缩小
blast_radius = impact 超集（value-confirmed + type-only + unknown + heuristic 边）
覆盖计分     = 仅 value-confirmed 边构成的可达子集
```

**heuristic/unknown 边引入的影响文件的策略（可配置）：**
- `strict`（默认）：这些文件也要求覆盖。
- `advisory`：只进 caveats 不阻断。**这是策略取舍不是实现细节**，报告写明用了哪种；
  切换须由 P1 实测数据触发讨论（见 Step 1.6），不得默认放宽。

### 7.2 覆盖级别（诚实版）

| 级别 | 判定 | 强度 |
|---|---|---|
| T0 | 执行了测试且通过（pm-mcp 现状） | 弱 |
| T1 | 每个受影响文件都被某个已执行测试文件经 **value-confirmed** import 边可达 | 中 |
| T2 | 受影响符号被已执行测试的调用图可达（仅 `resolved` 边） | 较强 |
| T3 | 运行时覆盖率覆盖到受影响行 | 强（可选，需项目能产出覆盖率） |

这是启发式，不是证明。Verdict 说明实际级别、三态比例、unknown 占比、heuristic 占比、动态加载计数。
文档与返回里必须这么写。

### 7.3 Evidence

绑定：源码指纹（目录树哈希）、命令 argv、环境摘要、退出状态、解析出的计数、输出摘要哈希、图 revision。
原始输出不进账本，只留哈希与失败摘录（避免夹具里的假密钥入账，沿用 pm-mcp）。

**修 pm-mcp 的洞**：pm-mcp 的 `roundEvidence` 只比较最新质量报告路径是否变化，
`latestValidQualityReport` 只校验结构、不要求 `ok=true` [已验证]，失败报告也算"有新证据"。
ANO：`ok=false` 的 Evidence 是有效记录（证明"跑过且失败"），**但不得计为"有产出"**。

### 7.4 沿用的门禁

验收基线：版本化、批准后不可变、证据 SHA-256 复算、手填更高数值被拒、报告三件套不可覆盖
[已验证，经红队测试]。ISO 25010/25040 做成可选 profile，默认精简基线。
反投机检测（skip 增长、恒真断言、测试蒸发、预算自肥）迁入 `audit`。

## 8. Audit 层

按需运行，读为主，结果以 Finding 事件写账本：
- 漂移：登记入口、Anchor、任务文件是否仍存在。
- 安全：离线秘密/危险模式扫描，账本只存指纹与位置、不存明文，fixed 复现自动重开。
- 许可证：SPDX 分类、copyleft 冲突。
- 治理：模块边界、禁止依赖、循环，**直接复用 Structure 的图**，不再维护 pm-mcp 那套重复的 semantic-graph。
- 联网项（OSV、公开代码反查）必须显式 `confirm`，默认关闭。

## 9. Surface：7 个工具

按意图分。所有写工具带 `idem_key`；所有读工具返回 `freshness` 与降级说明。

| 工具 | 读/写 | 作用 |
|---|---|---|
| `brief` | 读 | 开工恢复：焦点、断点、与焦点锚定的 Decision/Pitfall/Memory、近期会话、各缓存新鲜度 |
| `explore` | 读 | 结构问题：符号/调用链/影响范围（含三态与 caveats），一次返回 |
| `recall` | 读 | 历史检索，结构化参数 |
| `track` | 写 | 任务/里程碑/断点/功能的增删改 |
| `note` | 写 | 记 Decision / Pitfall / Memory（均带 Anchor）、会话摘要 |
| `verify` | 写 | `scope=task`：执行门禁、采集 Evidence、尝试置 done 并返回 Verdict；`scope=release`：见第二部分，**只出裁决，不放行** |
| `audit` | 读(+写 Finding) | 按 `scope` 选：drift / security / license / governance / deps |

内部用 `kind`/`scope` 判别联合分派，每个分支独立严格校验，防止退化成万能入口。
参数 schema 才是 7 个工具的真正复杂度所在。

**CLI**（偶发、需人类确认）：`init` · `doctor` · `rebuild <cache>` · `migrate`（导入 pm-mcp 的 `.pm/`）·
`baseline`（验收基线起草/批准）· `attest`（签字声明）· `release approve`（放行）·
`sync`（带安全门的 push）· `ui` · `export`。
**批准基线、签字、放行、push 只放 CLI，要求人类 TTY 确认，不暴露给 agent。**

**判断类规矩的局限**：AGENTS.md 里"编码前先 `explore`"工具强制不了。
缓解：`brief` 附带可观测提示"本会话尚未做结构查询就修改了 N 个文件"。这仍然不是门禁，文档如实写。

## 10. 进程与并发

- 每个 MCP 客户端一个 stdio 进程，无常驻 daemon。一个进程 = 一个 ledger segment（§4.1）。
- 账本写：文件锁 + 批次原子追加。缓存写：每个缓存库一个 leader，其余只读。
  读合并：同 revision 同参的并行读合并。
- **多工作区客户端**（如 Qoder 共享一个常驻子进程）：沿用 pm-mcp 每次调用重新认领工作区的设计
  [已验证，有测试]——显式 `root` > 请求指纹 > 唯一活跃会话 > 启动提示；
  歧义时写操作 fail-closed、读操作返回候选，绝不猜。原样迁移，不重新发明。

## 11. 技术选型

| 决策 | 选择 | 理由 / 未决 |
|---|---|---|
| 语言 | TypeScript，Node ≥22 | MCP SDK 一等支持；`node:sqlite` 免原生依赖 |
| 解析 | tree-sitter（WASM）起步 | codegraph 已验证可行。**[待验证]** 启动/内存（S2） |
| 模块解析 | S7 拍板：自写轻量 vs `ts.resolveModuleName` vs 借用宿主项目 TS | 借用宿主 TS = 执行项目 node_modules 代码，安全取舍见 G10，默认关闭 |
| 中文分词 | `Intl.Segmenter`（Node 内置 ICU）+ 确定性标识符拆分，方案 S1 拍板 | 零第三方依赖；**[待验证]** 目标环境 ICU 完整性与切分质量 |
| Rust 内核 | **v1 不做** | codegraph 的内核是 70k 文件规模暴露瓶颈后才加，带"双实现逐字节 parity"长期税；没有规模证据前不付 |
| 存储 | JSONL 账本 + SQLite 缓存 | 见第 4 节 |
| 校验 | zod | pm-mcp 已验证 |
| 测试 | `node:test`，真实 SQLite、真实 stdio 拉起、真实 git | 三项目共同做法：不 mock 数据库 |

## 12. 迁移与共存

- `ano migrate`：读 `.pm/` 转为事件，以旧 ID 做幂等键，单向可重复，不改旧目录。
- pm-mcp 迁移期继续只读可用，其验收基线保持冻结（59 个工具被基线固定）。
- `.codegraph`、`~/.obelisk` 是缓存，不迁移，自行重建。
- 已有 obelisk `memories` 可一次性导入为 Memory，**必须补 Anchor**，补不出的标 `unanchored`。

## 13. 许可证

- pm-mcp、codegraph 是 MIT，可参考复用，保留版权声明。
- **obelisk 是 AGPL-3.0。** 复制其代码会使整体适用 AGPL（含网络服务条款）。
  本设计只吸收思想（canonical record、writer lease、nonce 身份、visibility 三态），
  实现独立编写，只参照其公开的 ADR/spec，不读不抄源码。
  若用户接受 AGPL（G4），约束可放宽，**执行方不得自行假设**。

## 14. 测试策略

1. 红队用例从第一天写：每个防投机机制配"先尝试钻、再断言钻不进"。
2. 真实依赖，fixture 用真实采集数据。
3. Windows（含中文+空格路径、CRLF、文件锁）从第一阶段就进 CI。
4. **自举**：ANO 用自己管理自己的仓库，门禁对自己生效。
5. 文档由代码生成（工具目录、配置项、provider 列表），CI 比对。
6. 契约钉死：账本事件 schema 与工具参数 schema 做 hash 钉住，改动必须显式升版
   （obelisk 的 schema-hash 做法 [已验证]）。
7. 新增专项 fixture：barrel 三档与 type-only；多分支 segment 合并；
   CJK 单字/二字词/混排/标识符四类边界；ICU 版本变化重建。

---

# 第二部分：上线就绪层（Readiness）[构想]

## 15. 边界声明

代码门禁回答"这份代码是否按声明的标准完成"。上线运营还要回答"跑起来之后，
出了问题能不能发现、止血、恢复"。这些大部分在代码之外。

- 本层**完全是工程常识，没有源码依据**，三个项目里都没有对应实现。
- 一次设计出覆盖所有项目类型的框架与清单，**不能一步验证所有类型**。
  每个 profile 两种状态：`defined`（只有清单）、`validated`（真实项目跑通，记录项目名）。
  **发版时不允许把 `defined` 宣传成"已支持"。**
- 运营中的真实风险只能靠上线后的监控和人应对，没有任何门禁能事先证明。
- Verdict 里永远不出现"safe"或"可放心运营"，它只证明"声明的发布条件被证据满足"——
  这正是 nihil obstat 的本义：无异议，不是保证。

## 16. 框架

```
Readiness
├─ Profile       某类项目"必须具备什么"，数据定义，随仓库进 git，schema 钉 hash
├─ Evidence 来源  外部系统产出的证据
├─ Attestation   机器证明不了的项，由具名角色在 CLI TTY 签字，带范围与有效期
└─ Release Verdict
```

每个就绪项只能由三类状态之一满足：

| 状态 | 说明 | 强度 |
|---|---|---|
| **machine** | 外部系统产出，绑定源码指纹或制品哈希，可复算 | 强 |
| **attested** | 具名人签字，写明范围与过期时间，进账本 | 中，只证明"有人负责声明" |
| **missing** | 无证据 | 阻断 |

Verdict 分别列出三类各多少项，不得汇总成一个"通过"。

## 17. 通用必备项（所有类型）

| 项 | 证据 |
|---|---|
| 代码门禁全绿（任务 done、覆盖级别达标、无投机） | machine：账本 Verdict |
| 制品可复现构建 | machine：同一指纹两次构建哈希一致；不可复现则声明原因（attested） |
| 在干净环境安装/启动并通过冒烟 | machine：真实制品的冒烟记录 |
| 依赖漏洞与许可证无未处置高危项 | machine：audit Finding（联网扫描需显式 confirm） |
| 无明文密钥进入制品和 git 历史 | machine：对制品与历史的扫描 |
| 版本号、变更日志、文档一致 | machine：文档防腐检查 |
| 回滚/撤回方案存在且演练过 | machine（演练记录）或 attested |
| 已知限制书面公开 | machine：`limitations.md` 存在且被引用 |
| 发布责任人、事故联系人已指定 | attested |
| 隐私与合规审查（涉及用户数据时） | attested，具名人签字，工具不做法律判断 |

## 18. 各类型 Profile（通用项之上的增量，需真实项目校准）

**A. 库 / SDK / npm 包**：公共 API 变更与版本号语义化一致（API diff）；类型声明与导出清单检查；
最低与最高支持运行时版本上的测试；tarball 内容白名单；破坏性变更附迁移说明。

**B. 命令行工具**：各目标平台安装与卸载冒烟；退出码与错误输出契约测试；升级路径；不静默改用户文件。

**C. 后端服务 / API**：预发布环境成功部署与回滚记录；健康/就绪检查端点；结构化日志与请求追踪；
关键指标与告警规则，每条告警对应 runbook；压测结果对应声明容量目标；
数据库迁移预发布演练且可回退；备份恢复演练；限流/超时/熔断配置；密钥来自托管而非仓库；服务账号最小权限。

**D. Web 前端 / SaaS**：C 基础上加：浏览器兼容矩阵端到端测试；可访问性检查；核心页面性能预算；
CSP 与安全头；前端错误上报；灰度或功能开关；CDN 缓存与回退策略。

**E. 移动应用（iOS / Android）**：签名与证书有效期和保管；系统版本与设备矩阵测试记录；崩溃上报；
商店审核材料（隐私清单、权限说明）；分阶段发布；强制升级与最低版本策略。
商店审核结果无法由工具证明，只能 attested。

**F. 桌面应用**：各平台安装包签名与公证；自动更新通道与回滚；更新签名校验；崩溃上报；卸载干净度。

**G. 小程序 / 浏览器扩展**：平台审核与权限声明（attested）；版本灰度；宿主平台 API 变更兼容检查。

**H. 数据 / ML 管道**：数据契约与模式变更检查；幂等重跑与回填演练；数据质量断言；模型版本与回滚；
离线评估指标达到声明门槛；资源与成本上限。

**I. 基础设施即代码**：变更计划（plan）评审记录；隔离环境应用与销毁演练；漂移检测；状态存储备份。

**多类型项目**组合多个 profile，各子系统各自出裁决，总裁决取最弱者。

## 19. Evidence 来源接口

```ts
interface EvidenceProvider {
  kind: 'ci_run' | 'deploy_record' | 'artifact_scan'
      | 'drill_record' | 'monitor_export' | 'load_test' | 'api_diff';
  fetch(scope): Promise<ProviderResult>;   // 只读
  // 结果必须带：来源标识、时间、绑定的源码指纹或制品哈希、原始产物哈希
}
```

规则：
- 证据必须绑定**当前制品哈希或源码指纹**，对不上即作废。
- 证据有新鲜度：演练记录超过声明天数即过期。
- **凭据不进账本。** v1 适配器优先"读文件"：CI 把运行记录导出 JSON 放约定位置，
  工具只校验和绑定，不连云。直连各平台放后面（G8）。
- 适配器拿不到的项退化为 attested 并在 Verdict 标出，不假装是 machine。

## 20. Release Verdict

```
verify(scope=release, target=<version>, profiles=[...])
→ {
  verdict: blocked | conditional | ready,
  per_profile: [...],
  items: [{ id, requirement, status: machine|attested|missing, evidence_ref, expires_at }],
  summary: { machine: n, attested: n, missing: n },
  caveats: [启发式覆盖、三态比例、unknown 占比、动态加载计数、未验证 profile 等]
}
```

- `ready`：无 missing，所有 machine 项绑定当前制品，所有 attested 项未过期。
- `conditional`：只有 attested 缺口或过期项，列出谁要补。
- `blocked`：有 missing，或证据与当前制品不一致。
- **最终放行**：`ano release approve` 只在 CLI，TTY + 具名人确认，裁决摘要哈希写账本。
  agent 不能放行。放行后制品哈希变化，放行记录自动作废。

## 21. 这一层能做到与做不到

| 能做到 | 做不到，也不假装做到 |
|---|---|
| 框架、所有类型的清单、通用项 | 所有类型都经过验证 |
| 两个类型（库、后端服务）真实项目跑通 | 所有外部平台直连 |
| "条件是否被证据满足"算成可复核裁决 | 商店审核、法务、合规的自动判断 |
| 过期/不一致证据自动降级裁决 | 测试写得对不对、需求是否正确 |
| | 运营中突发问题的事前保证 |

---

# 第三部分：执行计划（交给执行模型）

## 执行规则

1. **逐步执行，每步以"验收命令通过"为完成标准**，不以"我写完了"为标准。
   验收失败如实报告输出，不得改验收标准来凑通过。
2. **不得编造数据。** 任何基准数字、覆盖率、耗时都必须来自实际运行输出。
   人为设定的阈值（如 80% 触发线）必须标注"人为设定"。
3. **以下动作必须先停下问用户，同意后才能做，批准只对当次有效**：
   创建远程仓库、`git push`、`npm publish`、创建 GitHub Release、注册域名/商标、
   采集真实会话样本（含隐私数据）、任何付费或对外发布动作。
4. **标 [待验证] 的项必须先做对应 Spike**，结果写入 `docs/spikes/<id>.md`。
   **Spike 不预设结果**，先写判定标准再跑；失败走备选路线，不硬做。
5. **遇到决策门必须停下问用户**，不得自行假设。
6. 每阶段结束写 `docs/phase-<n>-report.md`：做了什么、验收结果原文、未完成项、偏离设计之处。
7. P1 竖切失败判据成立时，**停止后续阶段**，向用户汇报并建议修正设计。
8. 不得读取或复制 obelisk 源码（§13），除非用户在 G4 明确同意 AGPL。
9. 不得因设计文档完备而宣布"没有死角"。所有机制在实测前都是假设。

## 决策门（开工前向用户一次问清）

| # | 问题 | 影响 |
|---|---|---|
| G1 | 名称 **Agent Nihil Obstat / ANO** 查重是否通过（`ano` 三字母包名大概率已占用，预计需 scope）；冲突时向用户提备选 | 包名、CLI 名 |
| G2 | v1 要支持哪些语言 | P3 的 Extractor 范围（默认 TS/JS） |
| G3 | v1 要查历史的客户端是哪几个；能否提供各自会话样本；**是否同意采样用于 S1 排序盲测** | P4 adapter 与 S1 |
| G4 | 能否接受 AGPL | 默认：不复用 obelisk 代码 |
| G5 | 新仓库位置与远程托管方式（HTTPS 被墙，需走 SSH deploy key） | 发版 |
| G6 | npm scope / 包名（如 `@<scope>/ano`） | 发版 |
| G7 | 有哪些真实项目可用于验证 profile（至少一个库类、一个服务类） | P7 |
| G8 | 证据来源用什么 CI/部署/监控（不知道则默认"读文件"方式） | P7 适配器顺序 |
| G9 | 目标项目是否使用 `tsconfig.paths` / monorepo 工作区引用 / `package.json#exports` | S7 路线 |
| G10 | **是否允许加载宿主项目的 TypeScript**（= 执行项目 node_modules 代码；默认关闭，显式启用） | S7 与 §11 |

## Phase 0：准备与 Spike（约 3 天，S1 排序评测可能受 G3 阻塞）

**Step 0.1 名称查重。** 查 npm（`npm view ano`、`npm view nihil-obstat`、`@<scope>/ano`）、
GitHub 搜索（"nihil obstat"、"agent-nihil-obstat"）、常见商标库。
结果写 `docs/name-check.md`，贴原始输出。有冲突向用户提备选，不得自行改名。
验收：文档含实际查询输出。

**Step 0.2 仓库脚手架**
```
ano/
  package.json  tsconfig.json  .gitignore  LICENSE(MIT)  README.md  AGENTS.md
  src/core/       paths.ts lock.ts fingerprint.ts idem.ts config.ts log.ts
  src/ledger/     event.ts segment.ts append.ts replay.ts views.ts hlc.ts
  src/structure/  extractor.ts store.ts query.ts fresh.ts barrel.ts imports.ts extractors/ts.ts
  src/memory/     provider.ts store.ts recall.ts tokenize.ts adapters/
  src/gate/       evidence.ts blast.ts verdict.ts policy.ts
  src/audit/      drift.ts security.ts license.ts governance.ts
  src/readiness/  profile.ts attest.ts providers/ release.ts profiles/*.toml
  src/surface/    mcp.ts cli.ts tools/{brief,explore,recall,track,note,verify,audit}.ts
  test/           unit/ integration/ redteam/ fixtures/
  scripts/        gen-docs.ts check-docs.ts bench-*.ts
  docs/           spikes/ adr/ readiness/
```
`package.json`：`type: module`，`engines.node >=22.18`，
脚本 `build / typecheck / test / coverage / gen-docs / check-docs`。
`tsconfig`：`strict`、`NodeNext`、`erasableSyntaxOnly`。
运行时依赖仅 `@modelcontextprotocol/sdk`、`zod`、`web-tree-sitter` 与所需 wasm。
验收：`npm ci && npm run typecheck && npm test` 在空项目上通过。

**Step 0.3 CI 骨架。** 矩阵 Ubuntu / Windows / macOS × Node 22.18 与 24；
步骤 `typecheck → test → build → npm pack --dry-run`。验收：三平台绿。
需要远程仓库的部分先本地跑通，推送前走 G5。

**Step 0.4 Spike**

### S1：检索方案盲测（机制测试 + 排序盲测两段）

**第一段：机制测试（不需要样本，不预设结果）**
1. 确认目标环境 `Intl.Segmenter` 存在且对中文返回**词级**切分而非逐字（ICU 完整性）。
   记录 `process.versions.icu` / `unicode`。
2. 确认 `node:sqlite` 是否带 FTS5；确认 trigram 是否可用。
3. 建 3 行 trigram 表（二字词、三字词、中英混排各至少一行），
   对 **1、2、3 个码点**的查询分别跑 `MATCH` 与 `LIKE`，记录**返回行数**；
   每条 LIKE 跑 `EXPLAIN QUERY PLAN` 记录是否走 FTS 索引；
   ESCAPE 与大小写敏感选项各测一次。
   （假设待证：MATCH 短词可能静默 0 行；LIKE 短词可能退化全表扫。**以实测为准。**）
4. 确认 `Intl.Segmenter` 对 `refreshToken` / `refresh_token` 是否整词不拆（UAX #29 假设待证）；
   对 `调用refreshToken函数` 的中英紧邻边界记录实际切分。
5. 标识符拆分函数实现 + 四类边界用例全过（缩写/驼峰接缩写/字母数字/分隔符）。
6. 据 3 的结果决定 A 是否需要"长度分流"（<3 码点走 LIKE 或 2-gram），长度按码点算。

**第二段：排序盲测（需 G3 同意的真实脱敏样本）**
1. 10–20 条真实查询：二字术语（租约/账本/幂等/死锁/回滚）、中英混排符号名
   （`token` 查 `refreshToken`）、长句描述。
2. **跑任何方案之前**，每条查询先标出"应该命中的会话片段"（预写判定），
   并固定选择规则写入 `docs/spikes/S1.md`：
   满足"二字词召回无漏检"的方案中选最简单者，除非更复杂方案 P@5 有明显优势（阈值预先设定）。
3. 五方案 A / B / B+ / C / C+ 同台：记录召回@20、P@5、p50/p95 延迟、
   索引体积（相对原文倍数，实测不预设）、构建时间。
4. 专门构造 ICU/分词边界不一致用例（同一词在长句中与单独查询时切法不同）。
5. 结论限定：10–20 条样本只够**淘汰明显更差的方案**，不足以区分差距小的方案，结论如实这么写。
6. 无样本时只出机制结论，不出排序结论。

**通过标准**：机制段全部行为已钉死并记录原始输出；排序段（若有样本）按预写规则选出方案。
**失败备选**：FTS5 不可用 → 内存倒排；Segmenter 不可用/逐字 → 纯 2-gram（C 退化版）。

### S2–S7

| Spike | 问题 | 通过标准 | 失败备选 |
|---|---|---|---|
| S2 | `web-tree-sitter` 在 Windows + Node 22/24 解析 TS/JS 的稳定性与内存 | 连续解析 5000 文件不崩溃，内存增长有界 | worker 回收（每 N 次解析重启） |
| S3 | HLC 时钟回拨 5 秒下的排序与合并 | 回拨用例事件全序不乱、无丢失 | 单 actor 串行日志 |
| S4 | codegraph 能否作为库接入，API 稳定性 | 读 Library Usage，50 行脚本调用，记录版本耦合 | 自写最小 L0/L1（P1 默认） |
| S5 | 批次原子追加：`batch.begin` 与 `batch.end` 之间每个字节边界杀进程 | 全部注入点恢复后无半批事件；**别人的 segment 残尾只忽略不修改** | SQLite WAL 作账本，JSONL 仅导出 |
| S6 | **三个分支各自新建 segment 后合并**，重放事件数 = 总和，单链校验全过 | 无冲突、无断链、observed 引用可解析 | 每 actor 独立目录 |
| S7 | 模块解析三路线对比：①自写轻量（tsconfig.paths/exports 常见情形）②`ts.resolveModuleName`（自带 typescript 依赖，评估体积/启动/内存）③借用宿主项目 TS（动态 `import('typescript')`，**须 G10 同意，默认关闭**；声明支持的 TS 主版本范围，范围外退化） | 在含别名/exports/monorepo 的真实项目上，三路线的解析成功率与成本实测对比 | 内置相对路径解析 + 未解析标 heuristic/unknown |

每个 Spike 产出 `docs/spikes/Sx.md`（问题、方法、原始输出、结论）。
**S5、S6 不通过则账本设计要改，先报告用户。**

**Phase 0 验收**：脚手架 CI 绿，S1–S7 报告齐全（S1 排序段可因 G3 延后，机制段必须完成），
G1–G4、G9、G10 有答复。

## Phase 1（竖切）：证明融合成立（约 8 天，含模块解析）

目标：只验证最难的接缝，不做完整功能。

- **1.1 最小账本**：`event/append/replay`，只支持 `task.created / task.updated / evidence.recorded`，
  会话切分 segment + 单链 + 批次原子追加，视图只含任务表。
  验收：单测覆盖追加、重放、截断残尾恢复、他人残尾只忽略。
- **1.2 源码指纹**：确定性目录树哈希（目录项排序、拒绝符号链接/非普通文件、
  读取期间文件变化报错、排除 `.ano/` 与项目忽略项）。
  验收：同内容两次一致；改一字节变化；符号链接被拒。
- **1.3 最小图（TS/JS 的 L0/L1 + 重导出三档 + 三态边）**：
  - tree-sitter 抽 import 边、符号定义与 **L1 导出表（symbol_kind）**；符号 ID 不含行号。
  - 三档重导出（§5.2）：显式 type → type-only；显式具名 → resolved 穿透到定义文件；
    `export *`/动态/require → 文件级 heuristic 带标签；副作用导入保留 sideEffect 边；
    环检测 + 深度上限。
  - 类型擦除识别（§5.3）：L1 导出表交叉比对，混合声明按 value，多名字全类型才降级，
    不确定归 unknown。
  - 模块解析按 S7 结论实现（P1 至少覆盖相对路径 + 项目实际用到的别名形态）。
  - I/O 错误标 `unknown`/`degraded`，只有 ENOENT 写墓碑；暴露 `fresh/stale/degraded`。
  - 验收：目录置不可读 → `degraded` 且旧数据保留；改文件不更新图 → `stale(1)`；
    三档与三态各有 fixture 用例。
- **1.4 impact 与覆盖 T1**：impact 取超集；覆盖计分只走 value-confirmed 边；
  barrel 语义口径（§5.4）。
- **1.5 最小 `verify(scope=task)`**：执行测试命令（argv，不经 shell），
  记录 Evidence（指纹、退出码、计数、图 revision），
  返回 Verdict（级别、三态比例、unknown 占比、heuristic 占比、动态加载计数、strict/advisory）。
- **1.6 判定实验（核心验收，必须原样执行并贴出输出）**

  **合成组：**
  1. 真实小项目：A 被 B、C 依赖，测试只覆盖 B。任务 `task.files` 只声明 A，修改 A 的导出函数。
  2. 对照：同样操作在 pm-mcp 现有门禁下记录是否通过（预期通过，证明旧门禁缺口）。
  3. ANO `verify` → **预期拒绝**，指出 C 受影响但无 value-confirmed 测试可达。
  4. 补覆盖 C 的测试后 `verify` → 通过。
  5. 修改 A 后不重建图 `verify` → `stale`，不放行。
  6. **barrel 组**：`index.ts` 转发 A 给 B、C、D。
     改 A 内部函数 → impact 只列真正使用该名字的文件，不列所有 barrel importer；
     只改类型导出 → impact 仍含类型 importer；
     测试 import barrel 但只用 B 引入的别的名字 → 不得判定 A 已覆盖。
  7. **type-only 组**：`import { User }`（无 type 标记）而 User 是 interface →
     边归 type-only，不计覆盖；同名 interface+const 合并 → 按 value。

  **真实项目组：**
  8. 先对候选项目统计 barrel 文件数与 `export *` 数量再选定
     （pm-mcp 的 `src/index.ts` 是装配入口非典型 barrel，**不预设它合适**）。
  9. 随机抽 N 个文件（N 在实验中定，足以看分布），每个分别输出
     `resolved_blast_radius` 与 `full_blast_radius` 文件数及比例，
     报告**中位数与 p90**，不报单值；同时报告三态比例、unknown 占比、动态加载计数。
  10. **触发线（人为设定，非判决线）**：heuristic 占比冲到 80% 以上、
      T1 退化成"每次都要全量测试"时，如实停下讨论：
      引入 TS 程序做精确解析（可选加速层，评估启动/内存），
      或默认降级 `advisory`。**由实测数据拍板，不得默认放宽。**

**失败判据**（任一成立即停止后续阶段，向用户汇报）：
步骤 3 误放行或误拒；图与账本新鲜度无法对齐；
真实项目上 unknown/heuristic 占比或误报率高到门禁不可用（给出实测数字）。

**验收**：判定实验全部输出齐全且符合预期；`docs/phase-1-report.md` 含对照实验、
抽样分布、三态数据与 S4/S7 的路线决定。

## Phase 2：账本与门禁完整化（约 2 周）

- **2.1 事件日志全套**：完整事件类型、HLC、segment 单链、视图全量与增量；
  **observed 头哈希补救**（§4.1）；segment 归档列为开放问题不实施。
  验收：S5 崩溃注入在实际实现上重做；删 `views.db` 重放逐字节一致；S6 三分支合并重做。
- **2.2 幂等**：跨 segment 查重走 views.db；同键同参去重、异参拒绝、崩溃重试语义。
  验收：20 进程并发写零丢失零重复（`bench-concurrency.ts` 实测输出）。
- **2.3 租约与 Run**：心跳、过期回收、`reclaimed_from`、回收轮次默认无产出。
  验收：杀持租约进程，另一进程可回收且 `produced_evidence=false`。
- **2.4 Evidence 与 Verdict 完整**：T0/T1；`ok=false` 不计产出；输出摘要哈希；失败摘录脱敏；
  strict/advisory 配置化。
- **2.5 工作区认领**：迁移 pm-mcp 每次调用重新认领逻辑与测试，歧义 fail-closed。
  验收：移植 `caller-workspace` 测试用例全过。
- **2.6 `ano migrate`**：读 `.pm/` 转事件，幂等键为旧 ID。
  验收：真实 pm-mcp 项目迁移两次，第二次零新增事件，任务数一致。
- **2.7 红队用例迁移**：pm-mcp `exploit.test.ts` 思路（fixed 复现、恒真断言、skip 增长、
  预算自肥、删账本、`.ano` 进 `.gitignore`、空洞完成笔记、空白标题、并发写、旧断点、幂等重放），
  每条"先钻、再断言钻不进"。验收：全过。
- **2.8 文档防腐 CI**：`gen-docs` 生成工具目录与配置文档，`check-docs` 比对。
  验收：故意改版本号，CI 红。

**Phase 2 验收**：行覆盖 ≥90%、分支 ≥80%（实测值入报告，不达标如实说明）；
三平台 CI 绿；自举生效。**此时已能取代 pm-mcp 大部分用途。**

## Phase 3：Structure 完整化（约 2–3 周）

- 3.1 L2 调用边：名称解析，resolved/heuristic 区分。
- 3.2 增量与降级：unknown 文件重试、degraded 恢复。
- 3.3 单写者选主：强杀 leader，standby 限定时间接管（实测）。
- 3.4 `explore`：候选符号抽取 + symbol/flow/impact 编排 + 分档预算（对目标客户端实测定值）。
- 3.5 T2 覆盖级别（仅 resolved 边）。
- 3.6 **语言验收**：每个宣布支持的语言，小/中/大三档真实仓库各 ≥3 个 flow 提示，
  端到端连通、节点数不爆炸、heuristic 边抽样精度记录。**未达标不得宣布支持。**
- 3.7 规模基准：`bench-graph.ts` 记录首次索引、增量、impact 耗时与内存，只写实测值。

**验收**：G2 每种语言过 3.6；基准已记录；explore 返回不被目标客户端截断。

## Phase 4：Memory（约 2–3 周）

- 4.1 取样（需 G3 同意）：真实会话样本脱敏后存 `test/fixtures/<client>/`，
  注明采集日期与客户端版本。不得手写 fixture。
- 4.2 adapter：纯函数、统一写层、visibility 三态、skippedArtifact、marker、cursor 退化。
  验收：未知格式只跳过该单元；一个 provider 出错不影响其他。
- 4.3 `history.db` 与 `recall`：结构化参数、参数化 SQL、**不接受脚本**。
  验收：恶意文本 transcript 被返回但绝不执行。
- 4.4 检索实现：按 S1 胜出方案落地 tokenize.ts（索引/查询同一函数、meta 版本锚定、
  单字降级、原文列 snippet）。验收：二字词命中；标识符子词命中；ICU 变化触发重建。
- 4.5 Memory 与 Anchor：note(kind=memory) 必带 Anchor；三级重定位。
  验收：改名后重定位成功或标 stale，不指向错误符号。
- 4.6 `brief`：焦点 + 锚定知识 + 缓存新鲜度 + "未做结构查询就修改 N 文件"提示。

**验收**：adapter 过真实样本；recall 注入测试过；改符号的任务 brief 浮出该符号 Decision。

## Phase 5：Audit、验收基线与 Surface 收尾（约 2 周）

- 5.1 audit：drift / security（只存指纹与位置）/ license / governance（复用图）/ deps；联网需 confirm。
- 5.2 验收基线：版本化、批准不可变、SHA-256 复算、手填更高值被拒、三件套不可覆盖；
  批准只在 CLI + TTY。验收：移植"伪造 PASS 失败"用例。
- 5.3 CLI 完成。`doctor` **必须同时识别发布版（npx）与本地版配置**
  （修 pm-mcp doctor 只认本地入口的问题 [已验证]）。
- 5.4 只读面板：node:http、仅 127.0.0.1、仅 GET、CSP、全转义。
- 5.5 AGENTS.md 生成：process/judgment 两段，增量合并，不覆盖用户内容。
- 5.6 schema 钉死：7 工具参数 schema + 账本事件 schema 哈希入测试，改动显式升版。

**验收**：红队全过；doctor 两种形态可核验；schema hash 测试在位。

## Phase 6：硬化（约 1–2 周）

- 6.1 全量门禁：typecheck && coverage && build 三平台绿；gen-docs/check-docs 过；自举对自身过。
- 6.2 真实试运行：用户 1–2 个真实项目跑一周，记录误拒/误放行、噪声、性能，修复后重跑。
  `docs/phase-6-report.md` **如实含未解决问题**。
- 6.3 包安装冒烟：npm pack → 三平台干净目录安装 → `ano probe`
  （直连 stdio 做 tools/list）核验恰为 7 个工具。

## Phase 7：上线就绪层（约 3–4 周，框架可在 P2 稳定后并行）

- **7.1 Profile 与 Attestation 数据模型**：事件 `readiness.profile / readiness.item /
  attestation.signed / release.verdict / release.approved`；Profile TOML 进 git，schema 钉 hash。
  验收：hash 测试在位；非法 profile 被拒。
- **7.2 Evidence 文件适配器**：读约定目录外部证据，校验绑定与新鲜度，写 `evidence.external`。
  验收（红队）：指纹不匹配拒；过期拒；缺原始产物哈希的伪造 JSON 拒。
- **7.3 Attestation**：`ano attest`，CLI/TTY/具名人/范围/有效期。
  验收：非 TTY 拒；过期自动降级；MCP 侧无法调用。
- **7.4 通用就绪项**：§17 全部；干净安装冒烟、可复现构建、制品密钥扫描必须真实执行。
  验收：植入假密钥的 tarball → `blocked`。
- **7.5 Profile A（库）与 C（后端服务）做到 validated**（需 G7）：
  各在一个真实项目跑完整流程，`docs/readiness/<profile>.md` 记录真实 verdict 与问题。
  **跑不通不得标 validated。**
- **7.6 其余 profile（B、D–I）以 defined 发布**：数据形式提供，文档标"未经真实项目验证"；
  每走通一个才升 validated 并记录项目名。
- **7.7 `verify(scope=release)` 与 `release approve`**：
  验收：任一证据过期 ready→conditional；制品哈希变化 → 绑定证据与放行记录全部作废。
- **7.8 红队**：手填 machine 拒；attested 伪装 machine 拒；复用旧版本证据拒；放行后制品变化放行作废。

**验收**：两个 validated profile 有真实裁决记录；其余标 defined；
`limitations.md` 写明"不判断产品是否正确、不替代法务、不保证运营安全"。

## Phase 8：发版

**Step 8.1 发版材料**：CHANGELOG；README（数字全部 gen-docs 生成）；SECURITY.md；
`docs/limitations.md`（必须写明：影响范围是启发式、三态边与 unknown 残余风险、
哪些语言/客户端/profile 未验证、AGPL 隔离策略、宿主 TS 加载默认关闭、
segment 删除不可检测的边界与 observed 补救范围）。

**Step 8.2 发布（每步先问用户）**
1. 版本号：首发 `0.1.0`（alpha）；`1.0.0` 需用户确认满足验收后再升。
2. 创建远程仓库并推送（用户已配置的 SSH deploy key，HTTPS 被墙）。
3. 打 tag，GitHub Release 附 tarball 与 SHA-256。
4. npm 发布仿 pm-mcp 流程 [已验证]：手动触发、仅 main、下载固定 release tarball、
   校验 SHA-256、npm OIDC trusted publishing、发布后轮询 registry 校验 `dist.integrity`。
5. 发布后冒烟：干净环境 `npx -y <包>@<版本>` 安装，核验恰为 7 个工具。

**验收**：npm 包干净环境可装且过 probe；Release SHA-256 与 registry integrity 一致；
limitations.md 已发布。

## 里程碑总览

| 阶段 | 产出 | 预计 | 可独立交付 |
|---|---|---|---|
| P0 | 脚手架 + Spike（S1 机制段必须完成） | 3 天 | 否 |
| P1 | 竖切证明（含三档穿透/三态边/模块解析） | **8 天** | 是（也是否决点） |
| P2 | 账本与门禁 | 2 周 | 是（已能取代 pm-mcp 大部分用途） |
| P3 | Structure | 2–3 周 | 是 |
| P4 | Memory | 2–3 周 | 是 |
| P5 | Audit/基线/Surface | 2 周 | 是 |
| P6 | 硬化 | 1–2 周 | 否 |
| P7 | 上线就绪层 | 3–4 周 | 是 |
| P8 | 发版 | 1 周 | 发版 |

总计约 **15–20 周**，单人线性粗估，不是承诺。P2 完成即可取代 pm-mcp，后续不做也不浪费。

## 风险

| 风险 | 影响 | 处理 |
|---|---|---|
| 核心假设（blast radius 提升门禁质量）未验证 | 全部 | P1 竖切带失败判据 |
| 穿透写漏 → 假阴性误放行 | 高 | 三档策略"绝不静默漏边"；impact 超集/覆盖子集不对称约束 |
| unknown 边占比过高 → 覆盖计分不可用 | 高 | P1 实测占比；80% 触发线（人为设定）停下讨论 |
| 运行时动态加载完全不可见 | 高 | 按文件计数进 caveats，不被 heuristic 标签掩盖 |
| 模块解析准确性（别名/exports/条件导出） | 中 | S7 三路线实测；未解析归 unknown |
| 二字词/标识符检索行为与记忆不符 | 中 | S1 机制段不预设结果，逐条钉死 |
| ICU 版本/分词边界不一致 | 中 | meta 锚定 + 变化重建 + 专项用例 |
| segment 被整体删除不可检测 | 中 | observed 头哈希补救（P2）；limitations 如实声明 |
| segment 数量增长 | 低-中 | 归档方案 P2 开放问题，不仓促实施 |
| 借用宿主 TS = 执行项目代码 | 中 | G10 默认关闭，显式启用，版本范围声明 |
| Anchor 改名失效 | 中 | 三级退化 + stale 可见 |
| Qoder/WorkBuddy 格式未知 | 中 | 先取真样本 |
| 工具参数 schema 膨胀成万能入口 | 中 | 判别联合 + 每分支独立验收 |
| 就绪层清单无源码依据 | 高 | defined/validated 分级，真实项目校准 |
| 演练证据走过场 | 中 | 工具只确认有记录不确认有意义，文档声明 |
| 外部系统适配量大 | 中 | v1 只读文件不连云 |
| HLC/多分支合并边界 | 低-中 | S3/S6 专项，退路单 actor |
| 一人维护工作量 | 高 | 档位声明 + 每阶段独立交付 |

## 最终诚实评估

- 设计上，ANO 在 A 档取代 pm-mcp，在 B 档取代 codegraph 与 obelisk 中用户真正会用到的部分，
  并新增三者都没有的跨层门禁与上线就绪裁决。
- v1 不取代 codegraph 的全部语言覆盖与性能内核，也不取代 obelisk 的桌面端与 12 个 provider；
  就绪层只有两个 profile 经过真实验证。
- 工具能证明"声明的发布条件被证据满足"（nihil obstat：无异议），
  **不能**证明产品正确、测试写得对、运营安全。放行（imprimatur）永远是人。
- **本文所有机制在实测前都是假设**：二字词行为、Segmenter 表现、三态占比、穿透覆盖率、
  HLC 边界，全部待验证。更可能的情况是 P1 暴露现在想不到的问题——失败判据因此必须保留，
  不得提前宣布设计完备。

## 交给执行模型的第一条指令

> 先完成 Phase 0 的 Step 0.1（对 Agent Nihil Obstat / ANO / ano 查重）与全部 Spike 的机制段
> （S1 排序段待 G3 样本），并向用户一次性问完决策门 G1–G10。在 G1–G4、G9、G10 得到答复前，
> 不要写任何业务代码，不要执行任何对外发布动作，不要读取 obelisk 源码，
> 不要加载任何宿主项目的 TypeScript。