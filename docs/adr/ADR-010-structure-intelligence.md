# ADR-010：结构智能——文件级探查证据、覆盖分类、风险分级与 Gate 边界

日期：2026-11-23
状态：提议（待主控审阅；审阅通过后置"已接受"并开放 phase-structure-intelligence 门禁）
任务：T-111 / SG-01（M14）
输入契约：`.pm/tasks.json`（M14 T-111~T-122）、`.pm/roadmap.json`（M14）、`docs/adr/ADR-005-anchorprobe-memory-revision.md`、`docs/adr/ADR-007-client-adapters.md`、`docs/adr/ADR-009-project-scan-roots.md`、`docs/project-scan-configuration.md`、`docs/limitations.md`、`src/ledger/event.ts`、`src/ledger/payloads.ts`、`src/ledger/views.ts`、`src/structure/types.ts`、`src/structure/store.ts`、`src/structure/extractor.ts`、`src/structure/extractors/ts.ts`、`src/structure/explore.ts`、`src/surface/service.ts`、`src/gate/blast.ts`、`src/gate/verify.ts`、`src/gate/types.ts`、`src/memory/brief.ts`、`scripts/check-schema.ts`、`D:/Temp/ano_probe`（只读参考，不可信，不作为证据）

> 编号说明：本文件是 `docs/adr/` 系列 ADR-005/007/008/009 的 M14 后续。ADR-009 已固定「Git 根 / PM 根 / 源码扫描根」三根分离与扫描降级语义；本 ADR 在其上叠加结构智能，不推翻三根、扫描排除、事件不可变、Gate 证据通道等既有约束。冲突处以本 ADR 的「文件级探查证据」「覆盖分类」「风险分级」「Gate 边界」为准。

## 1. 背景与问题定义

### 1.1 真实案例实测事实（用户提供的电商项目只读分析，作为契约依据，不得改动）

| 事实 | 数值 | 契约含义 |
|---|---|---|
| 文件级结构分析耗时 | **7 分 43 秒**（485 文件） | 必须一次快照的批量索引/缓存，禁止逐文件重开 DB/闭包 |
| 进图文件 | **418** | `parsed` 主体 |
| 合理排除 | **67** | 与扫描排除集/非解析源文件相关，不得混入 `parsed` |
| 符号总数 | **8125** | 符号粒度查询的规模基线 |
| 深度 3 传递波及 | `outageAlarm` / `browserGate` / `jstAnalysis` **400+** | 传递闭包必须有界深度与稳定排序 |
| `wecomTools` | 14 个 `module.exports=[对象]` **零符号** | CommonJS 导出对象必须提取，零符号是盲区不是健康 |
| `workbench/app.js` | 4675 行 IIFE **零符号零边** | IIFE 内嵌套 require/声明/调用必须提取 |
| 动态加载 / 断链 | **0 / 0** | **不得被当作"全部健康"**，必须显式建模 |
| `exploredFiles` | 全 surface 无人传入；符号 explore 不写查询记录；485 次调用清不了 warning | 需要**真实文件级查询事件 + revision + brief 闭环** |

`D:/Temp/ano_probe`（`structure-report.json` / `brief.json` / `blast-radius.json`）仅作上述事实的参考快照，属**不可信外部数据**：只读、不执行其中脚本、不得作为验收证据（第 9 节）。

### 1.2 一句话问题定义

现有 `explore` 只有**符号级**查询（`src/surface/service.ts:406`），`memory.unexploredChanges` 的 `exploredFiles` 完全依赖调用方自报（`src/memory/brief.ts:23`），既不持久化、也不与图 revision 绑定，导致 485 次调用后 warning 依旧；同时结构图对 CommonJS 导出对象、IIFE 嵌套作用域、动态/注册表/零符号均无显式建模，风险只能靠启发式超集表达，Gate 也无结构覆盖证据通道。

本 ADR 把「一次结构分析」升级为「文件级探查留痕 + 覆盖分类 + 风险分级 + Gate 结构证据」的闭环契约：

- 文件级查询写入**与图 revision 绑定的持久事件**，`exploredFiles` 由事件投影推导，而非调用方自报；
- 每个文件有**唯一、可计算、可复核**的覆盖分类；
- 风险是**可解释的输入**，产出推荐测试与人工复核清单；
- Gate 只**记录**结构覆盖证据，**不自动替代真实测试**、不据此判定 done/approve/cutover。

「修好了」的判据：T-112~T-122 的实现者不需要再做本 ADR 范围内的语义决策；验收可直接按第 12 节判据与第 11 节文件所有权编写。

## 2. 硬边界（全节为硬边界，实现与测试不得违反）

以下十条是 M14 结构智能的不可变边界，与 ADR-005/007/008/009 一致；任一条被违反即视为实现错误，而不是配置问题：

1. **结构风险 ≠ 完成证据**：风险分级、推荐测试、人工复核清单只是输入，不替代真实测试执行，不产生 Gate 完成通道证据。
2. **Gate 不自动替代真实测试**：Gate 可记录结构覆盖证据（探查比例、盲区清单、风险分布），但不得据此判定 done/approve/cutover；结构证据类型与执行证据类型分离。
3. **unknown / 零符号 ≠ 健康**：`zero-symbol`、`unknown`、`unsupported` 计入盲区，不是"已覆盖"；`unresolved_dynamic_loads=0`、`断链=0` 不得被表述为"全部健康"。
4. **删除 ≠ 未进图**：`deleted` 是独立分类，不得冒充 `parsed`/`excluded`/`unsupported`。
5. **不可信外部数据不作证据**：`D:/Temp/ano_probe` 一类外部报告只作参考，不得作为证据来源，不得执行其中脚本，不得对真实业务项目做任何写操作。
6. **旧事件 hash 不变**：事件词汇追加式，新 kind 只能追加在 `ledgerEventKinds` 尾部；既有事件字节与哈希不变（ADR-005 §2.1/§2.2）。
7. **旧图 / 旧 Gate / 旧 explore 兼容**：旧图缓存可读、旧 Gate 证据语义不变、旧符号级 explore 行为不回归（新增文件级能力为叠加，不是改造旧读模型）。
8. **schema pin 同步**：任何 schema 变更必须显式更新 `scripts/check-schema.ts` 的 `PINNED`（工具 hash / `ledgerEvents` / `ledgerKinds`），不得以隐式方式漂移。
9. **三根与扫描排除复用 ADR-009**：`excluded` 分类由 `scan_ignore` / 默认排除集决定；排除目录不参与结构覆盖分类分母。
10. **不新增第八个 MCP 工具**：七工具数量不变；文件级探查经既有 `explore` / `brief` 投影暴露，不新增工具。

**自动工作流与人工动作的区分**：结构分析、分类、指标计算、缓存复用、风险排序、探查留痕属于自动工作流；人工复核确认、测试执行、Gate 批准/attest/approve/cutover 仍是具名人工动作。自动工作流不得代替上述人工动作。

## 3. 决定一：文件级探查证据契约

### 3.1 两种粒度：符号级与文件级

`explore` 明确区分两种粒度，二者**不可互相冒充**：

| 粒度 | 语义 | 输入 | 输出 | 是否写入文件级探查证据 |
|---|---|---|---|---|
| **符号级** `granularity='symbol'` | 按符号名/qualifiedName/文件内文本检索符号、调用边、导入边 | `query` 文本或 `symbol.id` | `symbols[]`、`impact[]` | **否**（仅写符号级查询事件，或按需不写） |
| **文件级** `granularity='file'` | 对单个文件做 outline/impact 查询，得出该文件的符号、依赖、波及与分类 | `file` 路径（+可选 `ref`） | `symbols[]`、`impact[]`、`classification` | **是**，写 `structure.queried` 事件（`granularity='file'`） |

`exploredFiles` 的语义 = **文件级已探查集合**，只由 `granularity='file'` 的查询事件推导。符号级查询、`brief` 的 `touchedFiles`、调用方自报的 `exploredFiles` 参数都**不得**计入。

### 3.2 查询事件 `structure.queried`

在 `ledgerEventKinds` 尾部追加一个 kind：`structure.queried`。payload 为 `.strict()` Zod schema，未知字段拒绝：

```jsonc
{
  "granularity": "file",                 // 'file' | 'symbol'
  "file": "server/services/wecomTools/index.js",  // 相对 gitRoot/sourceRoot 的 POSIX 路径
  "ref": "server/services/wecomTools/index.js#default", // 可选：符号级查询的 symbol id 或 qualifiedName
  "graph_revision": "<GraphSnapshot.revision>",
  "query": "wecomTools",                 // 原始查询文本（文件级查询记录 file 或 outline/impact 标识）
  "result": {
    "total": 14,                          // 命中总数
    "returned": 14,                       // 本次返回数
    "truncated": false,
    "impact": ["server/bootstrap.js"],    // 可选：文件级查询的传递/直接波及
    "classification": "parsed"            // 可选：该文件当前覆盖分类（九类之一）
  }
}
```

字段约束：

- `file`：`1..1024` 字符，POSIX 相对路径；不得是绝对路径（跨 root 不可解析即拒绝，ADR-005 的结构绑定哲学）。
- `graph_revision`：必须等于写入时 `GraphSnapshot.revision`；投影据此判断证据是否仍有效。
- `result.classification`：只能取第 4 节九类之一。
- **`time` 与 `actor` 不进入 payload**：`recorded_at` 由 HLC 派生（ADR-005 §2.8），`actor` 在事件信封上（`src/ledger/event.ts`）。查询事件必须携带 `idem_key`，规则与 `memory.*` 一致（同 `idem_key` 同参返回原结果 `duplicate:true`；同键不同参拒绝）。

### 3.3 与图 revision 绑定（失效 / 降级）

- 投影 `structure_queries`（`VIEW_SCHEMA_VERSION` 递增）保存每条 `structure.queried` 的 `file`、`graph_revision`、`query`、`result`、事件 id、`hlc`。
- 给定当前图 revision `R`，文件 `f` 的**有效探查证据** = `file=f` 且 `graph_revision=R` 的查询事件（取 `hlc` 最大者）。
- **图变了旧证据即失效/降级**：若 `f` 仅有 `graph_revision < R` 的查询记录，则 `exploredFiles` 不含 `f`，并标记 `stale-explore`；warning 重新出现，直到对当前 revision 重新查询。
- 图 revision 未变但文件 hash 变化（增量重建后 revision 变化是常态）：revision 变化即视为失效，不单独追踪 hash。
- 投影可重建、fail-closed：与 `views.ts` 既有投影一致，版本不匹配即全量重建；重建中语义完整性违规抛 `LedgerIntegrityError`，拒绝提供视图。

### 3.4 `exploredFiles` 的真实来源

`brief` 的 `memory.unexploredChanges` 改为：

```
touched        = gitTouchedFiles(pmRoot)                 // 既有语义
exploredFiles  = projection.currentExploredFiles(R)       // 只由 structure.queried(granularity=file, revision=R) 推导
explored       = |touched ∩ exploredFiles|
modifiedWithoutExplore = touched \ exploredFiles
warning        = modifiedWithoutExplore.length > 0 ? "..." : null
```

- `exploredFiles` 不再接受调用方自报（`MemoryBriefInput.exploredFiles` 保留但仅作**只读兼容入参**，且必须与投影取交集；投影为空时不得用自报集合伪造全量探查）。
- `brief` 的 `graph.revision` 即 `R`；`exploredFiles` 必须按 `R` 计算，禁止跨 revision 复用。
- 无真实查询记录时 `explored=0`，warning 必须出现——**禁止伪造全量 explored**。

### 3.5 撤销 / 重探查语义

- **重探查清零 warning 的条件**：对当前 revision `R` 存在 `granularity='file'` 且 `file=f` 的查询事件。再次查询同一文件（同 `idem_key`）返回 `duplicate:true`，不重复计数；不同 `query`/`result` 视为新事件（新 id），`hlc` 更大者生效。
- **撤销**：本 ADR 不提供删除事件（事件不可变）。撤销语义为「对当前 revision 重新查询」：图 revision 变化后旧证据自动失效；若需表达"该文件已不被视为已探查"，只能由revision 失效或人工复核清单表达，不得删事件。
- **符号级查询不计文件覆盖**：`granularity='symbol'` 事件写入但不进入 `exploredFiles` 投影。
- **幂等**：`idem_key = structure:query:<revision>:<granularity>:<file>:<hash(query)[:ref]>`（实现可固化），保证 485 次重复调用不产生 485 条事件。

## 4. 决定二：结构覆盖分类（九类，每文件唯一）

### 4.1 分类表

任务书明列六类为**必备核心**；为完整表达盲区/孤立/动态语义，追加三类，共九类。九类互斥，由第 4.2 节判定树唯一确定。

| # | 分类 | 语义 | 是否盲区 | 计入分母 |
|---|---|---|---|---|
| 1 | `parsed` | 解析成功，符号 > 0，静态边 > 0，无语义未知主判定 | 否 | 是 |
| 2 | `zero-symbol` | 解析成功但符号数 = 0（如 `module.exports=[对象]` 未提取、IIFE 未提取） | **是** | 是 |
| 3 | `zero-edge` | 符号 > 0 但静态导入/调用边 = 0 且无动态加载（孤立文件） | 是（advisory） | 是 |
| 4 | `dynamic-only` | 符号 > 0，静态边 = 0，但 `dynamicLoads > 0`（仅动态依赖） | **是** | 是 |
| 5 | `unsupported` | 扩展名不支持，或语法树无法建立可信符号/边（无法解析的语法） | **是** | 是 |
| 6 | `excluded` | 命中 `scan_ignore` / 默认排除集（ADR-009 §5） | 否（按声明排除） | **否** |
| 7 | `deleted` | 快照/指纹后文件不存在（ENOENT，且不在降级目录） | 否（独立事实） | 是 |
| 8 | `degraded` | 解析部分完成：`source-changed`、占用/权限保留旧数据、超时截断、保留旧符号 | 是（advisory） | 是 |
| 9 | `unknown` | 语义无法静态判定：注册表/反射/`eval`/计算 `require` 为主，静态解析不足以给出可信覆盖结论 | **是** | 是 |

### 4.2 判定优先级（互斥、可计算）

对每个文件按顺序取**第一个命中**：

```
1. excluded      : 命中解析后的排除集（scan_ignore/默认集），未进入扫描集
2. deleted       : 不在当前指纹/快照中，且上一快照存在（ENOENT，非降级目录）
3. unsupported   : 扩展名不在 SUPPORTED_EXTENSIONS，或解析器失败/不完整
4. degraded      : 命中 fingerprint.degraded（source-changed/busy/permission）或解析降级
5. zero-symbol   : 解析成功且 symbols == 0
6. dynamic-only  : symbols > 0 且 staticEdges == 0 且 dynamicLoads > 0
7. zero-edge     : symbols > 0 且 staticEdges == 0 且 dynamicLoads == 0
8. unknown       : 主判定为注册表/反射/eval/计算 require（静态语义不足）
9. parsed        : 其余（symbols > 0 且 staticEdges > 0 且无 unknown 主判定）
```

- `staticEdges` = 该文件作为 `from` 的真实文件依赖边（不含 `<dynamic>` 占位）+ 调用边中 `provenance='resolved'` 的边。
- `unknown` 主判定必须**有位置证据**（文件 + 行号 + 模式），不得仅凭 `unresolvedDynamicLoads>0` 就把 `parsed` 降级为 `unknown`；后者记录为 `semanticGaps`，不改变分类。
- 分类结果与位置证据一并写入 `structure_queries` / 结构报告，可复核。

### 4.3 删除文件不冒充"未进图"

- `deleted` 独立分类，**不得**归入 `parsed`/`excluded`/`unsupported`。
- 增量重建中 ENOENT 的文件从快照移除（既有 `extractor.ts` 语义），但必须在结构覆盖报告中保留 `deleted` 条目（路径 + 原分类 + 删除时点 revision），供人工复核"是否有意删除"。
- `deleted` 不计入 `parsed` 分母的分子，但计入 `inScope` 分母（用于覆盖率与风险分母的一致性）；其风险单独标记 `deleted-file`。

### 4.4 零符号与未知不是健康

- `zero-symbol`、`unknown`、`unsupported` 一律计入**盲区**（第 5.1 节 `blindness`），不得计入"已覆盖"。
- `unresolved_dynamic_loads=0`、`断链=0` 只表示"未发现"，报告必须同时给出 `dynamicLoads`、`semanticGaps`、`unknown` 分类数；健康结论必须表述为"未发现 X"，不得表述为"无 X 风险"。
- 结构覆盖结论必须区分**静态可判定**与**人工复核**（第 5.4 节）。

### 4.5 `unsupported` 单列

- `unsupported` 与 `zero-symbol` 分离：前者是"无法解析"（语法/扩展名），后者是"解析成功但无符号"（提取能力缺口）。二者都进盲区，但人工复核动作不同（前者需语言/语法支持，后者需提取器增强）。
- `SUPPORTED_EXTENSIONS` 之外的真实源码（如 `.js` 探测脚本在参考报告中 `reason=not-a-parsed-source-file`）按扩展名/内容判定，不得静默并入 `parsed`。

### 4.6 与 M13 扫描配置的关系

- 排除目录**不参与结构覆盖分类**：`excluded` 由 ADR-009 §5 的解析后排除集（`.pm/project.json.scan_ignore` + 默认安全排除集 + `.ano/project.json.exclude`）决定，且**不计入分母**。
- 三处排除生效点一致（指纹、图构建、扫描统计）的既有约束不变；结构覆盖分类消费**同一解析后排除集**，禁止各自维护。
- `inScope` = 进入扫描集且非 `excluded` 的文件（含 `deleted` 的历史条目）。

## 5. 决定三：风险指标、分级、推荐测试与人工复核

### 5.1 六项指标（可计算/可复核）

前五项为任务书明列；第六项 `explored` 为探查证据契约的覆盖率指标。`riskScore` 为派生聚合，不计入六项。

| 指标 | 定义（公式） | 口径 |
|---|---|---|
| `direct` | `directDependents(T) = { f ∈ inScope : ∃ 边/调用 e, e.from=f, e.to ∈ T }`，报告 `\|directDependents(T) \\ T\|` | 直接依赖被影响文件的文件数 |
| `transitive` | 有界反向闭包 `closure(T, maxDepth)`，报告 `\|closure(T, maxDepth) \\ T\|` | 传递波及；`maxDepth` 默认 3（实测深度 3 波及 400+） |
| `unchanged` | `\|inScope\| - \|closure(T, maxDepth) ∪ T\|` | 未受影响、可跳过测试的文件数 |
| `fanout` | 单文件 `\|{ e.to : e.from=f, e 为真实依赖边/resolved 调用 }\|`；聚合报告 top-N | 扇出度 |
| `blindness` | `(\#zero-symbol + \#unknown + \#unsupported) / \|inScope\|` | 盲区占比（0..1） |
| `explored` | `\|exploredFiles ∩ inScope\| / \|inScope\|`，`exploredFiles` 只由当前 revision 的文件级查询事件推导 | 文件级探查覆盖率（0..1） |

- `T`（touched）默认取 `gitTouchedFiles`；调用方可显式给定。
- 反向闭包同时使用依赖边与 `resolved` 调用边；`heuristic`/`unknown` 边只作 advisory，不计入 `direct`/`transitive` 主口径（与 `src/gate/blast.ts` 的 `isAdvisory` 一致）。
- 环、缺文件、深度爆炸必须有界：`maxDepth` 强制上限，超限标记 `depth_limit`。

### 5.2 风险评分与分级（可解释、稳定排序）

单文件风险分（默认权重，可配置）：

```
impactScore    = directDependents + 2 * transitiveDependents + 3 * (f ∈ T ? 1 : 0)
coveragePenalty = 2 if category ∈ {zero-symbol, unknown, unsupported}
               = 1 if category ∈ {zero-edge, dynamic-only, degraded}
               = 0 otherwise
fanoutTerm     = min(fanout, 50) / 10
complexityTerm = min(symbols, 200) / 50
riskScore      = impactScore + coveragePenalty + fanoutTerm + complexityTerm
```

分级（阈值默认，可配置）：

| 级别 | 判据 |
|---|---|
| `high` | `riskScore >= 20`，或 `category ∈ {zero-symbol, unknown, unsupported}` 且 `impactScore > 0`，或 `fanout >= 50` 且 `transitiveDependents > 0` |
| `medium` | `riskScore >= 8` |
| `low` | 其余 |

- **稳定排序**：按 `riskScore` 降序；同分按 `fanout` 降序；再同分按路径 `Buffer` 字典序（确定性，无平台歧义）。
- **可解释**：每个文件的 `riskScore` 必须能展开为上述分项（`direct`/`transitive`/`fanout`/`coveragePenalty`/`complexityTerm`），禁止黑箱总分。
- **不一刀切**：不得把所有 485 文件一律要求全量测试或零验证；`unchanged` 且 `low` 的文件可跳过测试。

### 5.3 推荐测试（按风险给受影响测试候选）

- **反向映射**：测试文件 `testFile(f)` = 路径匹配 `*.test.*` / `*.spec.*` / `tests/**` / `test/**` / `__tests__/**` / `*.cjs`（测试目录内）。
- 对风险文件 `f`，推荐测试 = 能沿依赖边/resolved 调用边**到达 `f`** 的测试文件（即 `t` 满足 `f ∈ forwardClosure(t)`），按覆盖的风险文件数降序、路径字典序排序。
- 输出 `{ testFile, covers: string[], reason }`，精确到文件与原因。
- 无测试文件可达 → 记 `testGap`，进入人工复核清单。
- 复用既有 `src/gate/blast.ts` 的 `testCoverage` 语义，但方向为"测试 → 被测文件"，不重复实现闭包。

### 5.4 人工复核清单

必须生成（不得自动转证据）：

| 项 | 来源 |
|---|---|
| 盲区文件 | `zero-symbol` / `unknown` / `unsupported` |
| 动态加载 | `dynamicLoads > 0` 或 `unresolvedDynamicLoads > 0` 或注册表/反射/`eval` 位置证据 |
| 注册表 | `unknown` 分类 + 注册表模式位置 |
| 零符号文件 | `zero-symbol` 分类 |
| 零边/孤立 | `zero-edge` 分类 |
| 删除文件 | `deleted` 分类（确认是否有意删除） |
| 测试缺口 | `testGap` 的风险文件 |
| 高风险中心 | `high` 级别且 `fanout` 大/被多文件共享的模块 |

### 5.5 风险不直接等于完成证据

- 风险分级、推荐测试、人工复核清单**只是输入**；结构风险低不代表业务语义正确，结构风险高也不自动阻塞发布（除非 Gate 策略显式声明）。
- 完成证据仍只能来自真实测试执行（`evidence.recorded` / `verify.finished`）与具名人工动作。

## 6. 决定四：Gate 边界

- Gate **可记录**结构覆盖证据：文件级探查比例（`explored`）、盲区清单（`zero-symbol`/`unknown`/`unsupported`/`zero-edge`/`dynamic-only`）、风险分布（`high`/`medium`/`low`）、推荐测试与 `testGap`。
- Gate **不得**自动替代真实测试；**不得**据此判定 `done`/`approve`/`cutover`。
- **证据类型分离**：执行证据（`evidence.recorded`，含真实 argv/退出码/测试计数）与结构证据（新增结构覆盖证据类型，或经 `verify` 的 advisory 字段）必须类型不同、字段不混用。结构证据不产生 `evidence_id`，不进入完成通道。
- **策略兼容**：`CoveragePolicy.unknown` 的 `strict`/`advisory` 语义保留；结构盲区在 `strict` 下可产生**警告/阻止**（warn/block），但阻止理由是"结构盲区未人工复核"，不是"测试未执行"的替身；`advisory` 只记录不阻止。
- **不可伪造**：人工复核项必须引用真实结构证据（文件 + 行号 + 分类 + revision）；结构证据必须绑定 graph revision，revision 失效即失效。
- 既有 Gate 策略、`verification` 元数据形状与旧证据语义不变（ADR-005 §2.10）。

## 7. 决定五：提取增强契约

### 7.1 CommonJS `module.exports=[对象]` 与导出对象

- 支持形态：`module.exports = [ { name, id, description, function, ... } ]`、`module.exports = { ... }`、`exports.x = ...`、`module.exports.x = ...`。
- 对对象数组成员：生成**有来源与置信度**的符号：
  - `export`/`member` 符号：`qualifiedName = <file>#default[<i>].<key>`，`symbolKind='value'`，来源 `commonjs-export-object`，置信度 `heuristic`（元数据字段）/ `resolved`（可执行 `function` 成员）。
  - `function` 成员作为可执行符号（`resolved`），其余 `name`/`id`/`description` 作为元数据符号（`heuristic`），**元数据与可执行符号必须区分**。
- 不得杜撰业务语义：只登记字面量字段与函数体位置，不推断业务含义。
- 目标：`wecomTools` 形态可查询 `module.exports` 与合法成员，14 个对象不再零符号。

### 7.2 IIFE 与嵌套作用域

- 无顶层声明不等于无依赖：提取 IIFE 内 `require`/`import`、局部函数/变量、调用与对象成员。
- `qualifiedName` 保留作用域（如 `<file>:<IIFE>.<local>`），命名稳定（按作用域路径 + 声明序）。
- 局部符号**不得泄露为 export**；导出表只包含真正 `module.exports`/`export` 目标。
- 不能捕获的语义标 `unknown`（有位置证据），不追求虚假语义全知。
- 目标：`workbench/app.js` 形态不再零符号零边。

### 7.3 动态加载 / 注册表 / 零符号 → 显式 unknown

- 动态加载区分：`resolved`（字面量可解析）/ `heuristic`（可推断候选）/ `unknown`（计算表达式、`eval`、反射、注册表）。
- `unresolved_dynamic_loads=0` 不再被当全健康；报告必须给出动态模式类型、位置与原因。
- 零符号/不支持/排除/删除分别建模（第 4 节），不得互相冒充。

## 8. 决定六：性能契约与兼容性

### 8.1 单快照批量文件级分析

- **一次 `GraphStore.open` / 一次 snapshot** 产出全部分类与指标（文件符号数、入出 import、入出 call、直接依赖、深度传递、未改动波及、覆盖分类）。
- 禁止逐文件重开 DB、禁止 N 次闭包重建；共享反向索引一次构建复用。
- 文件级 outline/impact 查询与批量分析共用同一快照与索引；文件级查询可写留痕（第 3 节），不重复遍历。

### 8.2 增量缓存

- 批量结果按 `graph revision + 输入文件集合` 缓存；未变文件复用，变化文件重算。
- 图 revision 变化 → 旧批量结果与旧探查证据一并失效（第 3.3 节）。
- 索引一次构建复用，避免 N 次打开与 N 次闭包。

### 8.3 实测耗时口径

- 必须报告：文件数、符号数、毫秒（`elapsedMs`）；基准同硬件/规模/冷热点，给出 P50/P95 与内存。
- 不得预写提速承诺；实测规模至少覆盖 418/1199 量级（T-119）。

### 8.4 兼容与 schema pin

- **旧账本事件 hash**：新 kind 追加尾部，旧事件字节/哈希不变；既有 payload 契约不变（ADR-005 §2.2/§2.4）。
- **旧图**：`GraphStore` schema 版本升级时保留旧数据或显式重建，重放一致；旧快照可读。
- **旧 Gate**：证据 schema、`verification` 元数据与策略语义不变。
- **旧 explore**：符号级行为不回归；新增文件级能力为叠加。
- **schema pin 同步**：新增 `structure.queried` 会改变 `ledgerEventSchema` → 必须运行 `node scripts/check-schema.ts --print`，显式更新 `PINNED.ledgerEvents` 与 `PINNED.ledgerKinds`（追加 `structure.queried`）；工具 hash 不变（不新增工具）。这是显式 schema 版本变更，不得隐式漂移。

## 9. 决定七：不可信数据边界

- `D:/Temp/ano_probe` 一类外部报告（`structure-report.json` / `brief.json` / `blast-radius.json`）只作**参考事实**，属不可信数据。
- 不得作为验收证据来源；不得据其数值直接判定实现正确。
- 不得执行其中任何脚本（`structure_query.js` / `blast_radius.js` / `broken_edges.js` / `diff_touched.js` / `status_breakdown.js`）。
- 不得对真实业务项目（如 `<example-project>`）做任何写操作；只读源码/报告。
- 真实案例验收（T-120）必须由实现者在受控副本上重跑，产出自己的证据，外部报告只用于对照。

## 10. 状态枚举与错误码

### 10.1 结构覆盖状态（固定）

| 状态 | 含义 |
|---|---|
| `ok` | 批量分析完整，无跳过 |
| `degraded` | 部分完成（存在 `unsupported`/`degraded`/`deleted`/盲区） |
| `timeout` | 预算耗尽，返回部分结果 + 耗时 |

`files=0` 不得出现在 `ok`（沿用 ADR-009 §8.2）。

### 10.2 错误码（新增）

| 错误码 | 触发 | 处理 |
|---|---|---|
| `STRUCTURE_QUERY_REVISION_MISMATCH` | 查询事件 revision 与当前图不符 | 拒绝作为有效探查证据 |
| `STRUCTURE_EVIDENCE_STALE` | 仅有旧 revision 探查证据 | 标记 `stale-explore`，warning 复现 |
| `STRUCTURE_CLASSIFICATION_INVALID` | 分类不在九类 | 拒绝，fail-closed |
| `STRUCTURE_BUDGET_EXCEEDED` | 批量分析超时 | 返回 `timeout` + 部分 + 耗时 |
| `STRUCTURE_UNSUPPORTED_INPUT` | 恶意/巨大 AST、循环引用、深度爆炸 | 预算内明确错误，不静默截断 |

## 11. 文件所有权与并行接口（T-112~T-122）

下表与 `.pm/tasks.json` 的 M14 任务簿一致；共享文件按依赖串行，不并发写。

| 任务 | files（任务簿原样） | 独占职责 / 本 ADR 接口 |
|---|---|---|
| T-111 | `docs/adr/ADR-010-structure-intelligence.md`、`docs/structure-intelligence.md` | 本契约；已完成 |
| T-112 | `src/ledger/event.ts`、`src/ledger/payloads.ts`、`src/ledger/views.ts`、`src/memory/brief.ts`、`src/surface/service.ts`、`scripts/check-schema.ts`、`test/integration/memory.test.ts` | **文件级查询事件与 exploredFiles 闭环**：追加 `structure.queried`（第 3.2 节）、strict payload、投影 `structure_queries`、revision 失效、`brief` 接入投影、schema pin 更新。依赖 SG-01。 |
| T-113 | `src/structure/analysis.ts`、`src/surface/service.ts`、`src/surface/tool-catalog.ts`、`test/unit/structure-analysis.test.ts` | **单快照批量分析 + 文件级 Surface**：第 4/5.1 节分类与指标、共享反向索引、文件级 outline/impact、旧接口兼容。依赖 SG-01，可与 SG-02 并行。 |
| T-114 | `src/structure/extractors/ts.ts`、`src/structure/extractor.ts`、`src/structure/types.ts`、`test/unit/structure.test.ts`、`test/integration/structure.test.ts` | **CommonJS 导出对象与工具元数据提取**：第 7.1 节。依赖 SG-01。 |
| T-115 | `src/structure/extractors/ts.ts`、`src/structure/extractor.ts`、`test/unit/structure.test.ts`、`test/integration/structure-explore.test.ts` | **IIFE/嵌套作用域**：第 7.2 节。依赖 SG-01，可与 SG-04 并行（与 T-114 共享 `ts.ts`/`extractor.ts`，须串行或约定分区）。 |
| T-116 | `src/structure/extractors/ts.ts`、`src/structure/analysis.ts`、`src/structure/types.ts`、`test/unit/structure-analysis.test.ts` | **动态/注册表/盲区显式建模**：第 4.5/7.3 节。依赖 SG-04/05。 |
| T-117 | `src/structure/risk.ts`、`src/gate/blast.ts`、`test/unit/blast.test.ts`、`test/unit/structure-risk.test.ts` | **风险分级 + 推荐测试 + 人工复核**：第 5 节。依赖 SG-03/06。 |
| T-118 | `src/surface/service.ts`、`src/gate/verify.ts`、`src/gate/verdict.ts`、`src/ledger/payloads.ts`、`test/integration/verify-hardening.test.ts`、`test/redteam/verify-hardening.test.ts` | **Gate 接入**：第 6 节；结构证据类型与执行证据分离、unknown/advisory/strict 兼容、不可伪造。依赖 SG-02/07。 |
| T-119 | `src/structure/analysis.ts`、`src/structure/store.ts`、`scripts/bench-structure-analysis.ts`、`test/benchmark/structure-analysis.bench.ts` | **增量缓存与性能**：第 8 节；共享索引、revision 失效、基准口径。依赖 SG-03/06。 |
| T-120 | `docs/evidence/structure-ecommerce-intelligence.md`、`docs/evidence/structure-ecommerce-intelligence.json` | **真实案例只读验收**：第 9 节的不可信边界；对 14 对象/IIFE/高波及做前后对照。依赖 SG-02~09。 |
| T-121 | `test/redteam/structure-intelligence-boundary.test.ts` | **红队**：恶意 AST/超大对象/循环引用/深度爆炸/伪造查询记录/缓存错 revision/盲点绕过 Gate。依赖 SG-02~09。 |
| T-122 | `README.md`、`docs/usage.md`、`docs/limitations.md`、`docs/structure-intelligence.md`、`docs/evidence` | **最终质量与交付**：收口 `docs/structure-intelligence.md`（本 ADR 的实现者参考）、限制与最终验收。依赖 SG-10/11。 |

### 11.1 并行接口边界（实现者必读）

- **契约先于实现**：T-111 固定九类/六指标/事件/分级/Gate 边界，T-112~T-119 才实现；不得反向改契约。
- **共享文件串行**：`src/surface/service.ts` 由 T-112/T-113/T-118 串行接入；`src/structure/extractors/ts.ts` 由 T-114/T-115/T-116 串行；`src/structure/analysis.ts` 由 T-113/T-116/T-119 串行。
- **事件与投影**：`structure.queried` 的 kind/payload/投影归 T-112 独占；其他任务只读投影，不改事件契约。
- **文档**：`docs/structure-intelligence.md` 由 T-111 创建、T-122 收口更新。

## 12. 测试与验收判据

- **分类**：九类判定树对每个文件唯一命中；删除文件为 `deleted` 且不被冒充未进图；零符号/未知/不支持计入盲区；`unsupported` 单列；排除不计入分母。
- **指标**：`direct`/`transitive`/`unchanged`/`fanout`/`blindness`/`explored` 全部可计算且与公式一致；深度有界、环/缺文件不爆炸；排序稳定。
- **探查闭环**：真实文件级查询后 `explored` 增加且 warning 按文件消除；普通符号搜索不计文件覆盖；图 revision 变化需重新查询；重放/幂等通过；无伪造全量 explored。
- **风险**：高风险中心排序稳定且可解释（分项可展开）；推荐测试精确到文件/原因；零符号/IIFE/动态盲区产生人工复核项；不一刀切。
- **Gate**：结构覆盖证据可记录；不自动替代真实测试；不据此判定 done/approve/cutover；结构证据与执行证据类型分离；旧证据与事件 hash 兼容；人工复核不可伪造。
- **提取**：`module.exports=[对象]` 可查询导出与合法成员；元数据与可执行符号有区分；IIFE 局部 require/声明/调用可检索且不泄露为 export；动态/注册表/零符号显式 unknown；普通 TS/ESM 不回归。
- **性能**：同一快照批量结果与逐文件基线一致；无 N 次 open；缓存命中/失效正确；报告 418/1199 规模实测 P50/P95 与内存。
- **兼容**：旧账本事件 hash 不变；旧图/旧 Gate/旧 explore 回归通过；schema pin 同步。
- **不可信数据**：不执行外部脚本；真实案例验收用受控副本重跑证据。
- **回归**：`node scripts/run-tests.ts`、`npx tsc -p tsconfig.json --noEmit`、`node scripts/check-docs.ts`、`node scripts/check-schema.ts` 全绿；七工具数量不变。

## 13. 与既有 ADR 的边界对账

- **ADR-005**：本 ADR 追加 `structure.queried` 到事件词汇尾部，旧事件字节/哈希不变；`recorded_at` 仍由 HLC 派生；结构探查事件不进入 Gate 完成通道（结构证据不产生 `evidence_id`）。
- **ADR-007/008**：不新增第八个 MCP 工具；七工具输入 schema 不变（文件级探查经 `explore` 投影）。
- **ADR-009**：三根分离、扫描排除、链接/大文件/超时降级语义不变；`excluded` 分类由 `scan_ignore`/默认集决定，排除不参与分类分母。
- **docs/limitations.md**：既有永久边界（影响范围是启发式超集、unknown/零符号是残余风险、Gate 证据身份非密码学签名）不变；本 ADR 不放大为"静态分析等于业务语义正确"。

## 14. 后果

- 实现者获得固定的九类分类、六项指标、文件级探查事件、风险分级与 Gate 边界契约，T-112~T-122 可并行；验收判据可预先编写。
- 代价：新增结构分析层与查询事件投影；`explore`/`brief`/`verify` 需接入；图 schema 与 schema pin 需显式升级。
- 本 ADR 只固定语义与契约，不声称任何实现或测试已存在；实现完成后按第 12 节与 `docs/structure-intelligence.md` 验收。
