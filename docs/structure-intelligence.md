# 结构智能实现者参考

任务：T-111 / SG-01（M14）；收口：T-122 / SG-12（M14）
契约来源：[ADR-010](adr/ADR-010-structure-intelligence.md)
范围：文件级探查证据、九类覆盖分类、六项风险指标、风险分级与推荐测试、人工复核、Gate 边界、提取增强、性能与兼容。
读者：T-112~T-122 实现者。

> 本文是 ADR-010 的实现者参考，不重复 ADR 的授权与边界论证，只给数据模型、公式、接口与验收对照。冲突处以 ADR-010 为准。

## 1. 数据模型

### 1.1 覆盖分类（九类，每文件唯一）

```ts
export type CoverageClassification =
  | 'parsed'        // 解析成功，symbols>0，staticEdges>0，无 unknown 主判定
  | 'zero-symbol'   // 解析成功，symbols==0
  | 'zero-edge'     // symbols>0，staticEdges==0，dynamicLoads==0
  | 'dynamic-only'  // symbols>0，staticEdges==0，dynamicLoads>0
  | 'unsupported'   // 扩展名不支持或语法无法建立可信符号/边
  | 'excluded'      // 命中 scan_ignore/默认排除集（不计入分母）
  | 'deleted'       // 快照后文件不存在（ENOENT，非降级目录）
  | 'degraded'      // source-changed/占用/权限/超时/保留旧符号
  | 'unknown';      // 注册表/反射/eval/计算 require 为主，静态语义不足
```

判定树（按序第一个命中，互斥）：

```
excluded → deleted → unsupported → degraded → zero-symbol
        → dynamic-only → zero-edge → unknown → parsed
```

辅助量：

```ts
interface FileCoverage {
  file: string;                    // 相对 gitRoot 的 POSIX 路径
  classification: CoverageClassification;
  symbols: number;
  staticEdges: number;             // 不含 <dynamic> 占位
  dynamicLoads: number;
  unresolvedDynamicLoads: number;
  semanticGaps: SemanticGap[];     // { line, pattern, reason }
  inScope: boolean;                // false 仅当 excluded
  evidenceRevision: string;        // 分类所依据的 graph revision
}
```

### 1.2 六项指标

```ts
interface StructureMetrics {
  inScope: number;
  touched: number;
  direct: number;          // |directDependents(T) \ T|
  transitive: number;      // |closure(T, maxDepth) \ T|
  unchanged: number;       // |inScope| - |closure(T, maxDepth) ∪ T|
  fanout: FanoutTop[];     // 单文件扇出 top-N
  blindness: number;       // (#zero-symbol + #unknown + #unsupported) / |inScope|
  explored: number;        // |exploredFiles ∩ inScope| / |inScope|
  maxDepth: number;        // 默认 3
  depthLimited: boolean;
}
```

### 1.3 查询事件与投影

事件 kind：`structure.queried`（追加在 `ledgerEventKinds` 尾部）。

```ts
const structureQueried = z.object({
  granularity: z.enum(['file', 'symbol']),
  file: z.string().min(1).max(1024),
  ref: z.string().max(512).optional(),
  graph_revision: z.string().min(1),
  query: z.string().min(1).max(2000),
  result: z.object({
    total: z.number().int().nonnegative(),
    returned: z.number().int().nonnegative(),
    truncated: z.boolean(),
    impact: z.array(z.string()).max(10_000).optional(),
    classification: z.enum(COVERAGE_CLASSIFICATIONS).optional(),
  }).strict(),
}).strict();
```

投影（`VIEW_SCHEMA_VERSION` 递增）：

```ts
interface StructureQueryRow {
  eventId: string;
  file: string;
  granularity: 'file' | 'symbol';
  ref?: string;
  graphRevision: string;
  query: string;
  result: object;
  hlc: HlcTimestamp;       // 用于取同 revision 内最新
  actor: string;           // 事件信封
}

function currentExploredFiles(revision: string): string[];  // 仅 granularity='file' 且 graph_revision=revision
function exploredState(revision: string): { explored: string[]; stale: string[] };
```

- `time` 与 `actor` 取自事件信封（`hlc`/`actor`），不进 payload。
- `idem_key` 强制；建议 `structure:query:<revision>:<granularity>:<file>:<hash(query)[:ref]>`。
- `exploredFiles` 只由 `granularity='file'` 且 `graph_revision=revision` 的事件推导。

### 1.4 风险

```ts
interface FileRisk {
  file: string;
  classification: CoverageClassification;
  direct: number;
  transitive: number;
  fanout: number;
  symbols: number;
  riskScore: number;
  level: 'high' | 'medium' | 'low';
  // 可解释分项
  parts: { direct: number; transitive: number; touched: number; coveragePenalty: number; fanoutTerm: number; complexityTerm: number };
}

interface RecommendedTest {
  testFile: string;
  covers: string[];        // 被覆盖的风险文件
  reason: string;          // 如 'transitive dependency on outageAlarm.js'
}

interface ReviewItem {
  kind: 'blind-spot' | 'dynamic-load' | 'registry' | 'zero-symbol' | 'zero-edge' | 'deleted' | 'test-gap' | 'high-fanout';
  file: string;
  line?: number;
  classification?: CoverageClassification;
  reason: string;
  evidenceRevision: string;
}
```

### 1.5 Gate 接入语义（T-118 实现后固定）

`verify` 服务层接受可选 `structure`（`true` 或 `{...}`）与 `review_items`，**opt-in**；未传时结果键集与旧版一致。

```ts
interface StructureEvidence {
  riskSummary?: BlastRiskSummary;         // revision/levels/counts/highCenters/testGaps/reviewCount
  coverageGap?: StructureCoverageGap;    // executedTests/highRiskFiles/coveredHighRisk/uncoveredHighRisk/testGaps
  reviewItems?: ReviewItem[];            // 权威清单：由当前图 analyzeStructure+assessRisk 重算
  untrustedReviewItems?: number;         // 调用方传入的复核声明计数，不参与判定
  policyEffect?: 'blocked' | 'warned' | 'recorded';
}
```

- `strict`（沿用 `policy.unknown`）：未处理的高风险 manual-review 盲点或 `uncoveredHighRisk` 非空 → **阻止**，理由含 file/kind/pattern/line；`advisory`：同项只进 `warnings`，不改变 status。
- 结构证据只出现在 `verdict.structure` 与 `warnings`，不产生 `evidence_id`，不替代执行证据；`skip`/`todo`/`fail` 仍由真实执行证据拒绝。
- 不可伪造：权威 `reviewItems` 绑定 `evidenceRevision`；调用方传入仅计 `untrustedReviewItems`（红队伪造 `handled:true` 仍 blocked）。
- 人工复核「已处理」通道尚未设计：high 文件存在 manual-review 项且开 strict 即阻止（ADR-010 §5.4 只定义清单、未定义载体）。

## 2. 字段计算公式

| 字段 | 公式 |
|---|---|
| `symbols(f)` | `snapshot.symbols.filter(s => s.file === f).length` |
| `staticEdges(f)` | `edges.filter(e => e.from === f && e.to !== '<dynamic>').length + calls.filter(c => c.from === f && c.provenance === 'resolved').length` |
| `fanout(f)` | `|{ e.to : e.from=f, e.to !== '<dynamic>' } ∪ { c.to : c.from=f, c.provenance='resolved' }|` |
| `directDependents(T)` | `{ f ∈ inScope : ∃ e, e.from=f, e.to ∈ T }`（含 resolved 调用边） |
| `closure(T, d)` | 反向 BFS，深度 ≤ d；含依赖边与 resolved 调用边；超限标 `depth_limit` |
| `direct` | `|directDependents(T) \ T|` |
| `transitive` | `|closure(T, d) \ T|` |
| `unchanged` | `|inScope| - |closure(T, d) ∪ T|` |
| `blindness` | `(count(zero-symbol) + count(unknown) + count(unsupported)) / |inScope|` |
| `explored` | `|currentExploredFiles(R) ∩ inScope| / |inScope|` |
| `impactScore` | `direct + 2*transitive + 3*(f ∈ T ? 1 : 0)` |
| `coveragePenalty` | `2` if `zero-symbol`/`unknown`/`unsupported`；`1` if `zero-edge`/`dynamic-only`/`degraded`；`0` otherwise |
| `fanoutTerm` | `min(fanout, 50) / 10` |
| `complexityTerm` | `min(symbols, 200) / 50` |
| `riskScore` | `impactScore + coveragePenalty + fanoutTerm + complexityTerm` |

分级：

| 级别 | 判据 |
|---|---|
| `high` | `riskScore >= 20`，或 `coveragePenalty == 2 && impactScore > 0`，或 `fanout >= 50 && transitive > 0` |
| `medium` | `riskScore >= 8` |
| `low` | 其余 |

排序：`riskScore` 降序 → `fanout` 降序 → 路径 `Buffer` 字典序。

推荐测试：

```
testFile(f) = 匹配 *.test.* | *.spec.* | tests/** | test/** | __tests__/** | 测试目录内 *.cjs
recommended(f) = { t : testFile(t) && f ∈ forwardClosure(t) }，按 |covers| 降序、路径升序
```

## 3. 与 M13 扫描配置的关系

- 排除集来源：`.pm/project.json.scan_ignore`（只读复用，优先）+ `.ano/project.json.exclude` + 默认安全排除集（ADR-009 §5.2），由 `resolveProjectScan()` 一次解析。
- 命中排除集的文件分类为 `excluded`，**不计入 `inScope` 分母**，不参与风险/盲区计算。
- 指纹、图构建、扫描统计、结构覆盖分类消费**同一解析后排除集**。
- `inScope` = 进入扫描集且非 `excluded` 的文件（含 `deleted` 历史条目）。
- 三根（gitRoot/pmRoot/sourceRoots）语义不变；`file` 路径相对 `gitRoot` POSIX。

## 4. 真实案例验收矩阵（T-112~T-122 产出对照）

参考事实来源：`D:/Temp/ano_probe`（不可信，仅对照，不作为证据）。

| 任务 | 产出 | 对照基线（参考） | 验收要点 |
|---|---|---|---|
| T-111 | 本文 + ADR-010 | 485/418/67/8125；16 零符号；8 个 `.js` 未解析 | 九类/六指标可计算；删除≠未进图；零符号/未知≠健康；探查与 revision 绑定；风险≠完成证据 |
| T-112 | `structure.queried` 事件 + 投影 + brief 闭环 + schema pin | `brief.json` 中 `explored=0`、warning 列 485 文件 | 文件级查询后 explored 增加、warning 按文件消除；符号查询不计覆盖；revision 变化失效；幂等；无伪造全量 |
| T-113 | 单快照批量分析 + 文件级 Surface | 7 分 43 秒 / 485 文件 | 同快照批量与逐文件基线一致；无 N 次 open；支持 deleted/unsupported/excluded；排序稳定；旧 explore 兼容 |
| T-114 | CommonJS 导出对象/工具元数据提取 | `wecomTools` 14 个 `module.exports=[对象]` 零符号 | 可查询导出与合法成员；元数据与可执行符号区分；图 cache/schema 升级重放正确；普通 TS/ESM 不回归 |
| T-115 | IIFE/嵌套作用域提取 | `workbench/app.js` 4675 行 IIFE 零符号零边 | 不再零边；局部函数/require/call 可检索；不泄露局部为 export；命名稳定；零声明/零依赖分别报告 |
| T-116 | 动态/注册表/盲区显式建模 | 动态加载=0、断链=0 | 盲区有类型/位置/原因；无 unresolved≠无动态风险；报告不漏 deleted/excluded；静态可判定与人工复核分开 |
| T-117 | 风险分级 + 推荐测试 + 人工复核 | `outageAlarm`/`browserGate`/`jstAnalysis` 深度 3 波及 400+ | 高风险中心排序稳定可解释；推荐精确到文件/原因；零符号/IIFE/动态产生复核项；不一刀切 |
| T-118 | Gate 接入 | 既有 `evidence.recorded`/`verify.finished` | 任务可消费风险计划；verify 含执行覆盖与结构覆盖差集；高风险盲点有阻止/警告；旧证据与 hash 兼容；人工复核不可伪造 |
| T-119 | 增量缓存 + 性能 | 418 进图规模 | 同输入走缓存；revision 失效正确；无 N 次 open；结果与无缓存一致；报告 P50/P95 与内存，不预写承诺 |
| T-120 | 真实案例证据（受控副本） | 14 对象/IIFE/高波及对照 | 改善有具体数值；高风险/推荐可复核；exploredFiles 闭环；批量一次快照完成；未知与复核不消失 |
| T-121 | 红队 | 恶意 AST/超大对象/循环/深度/伪造记录 | 有预算与明确错误；不执行分析对象；伪造探查/缓存/复核不被接受；旧图/Gate/explore 回归通过 |
| T-122 | 最终文档与验收 | 全量质量/安全/许可 | 12 任务 done；真实案例/探查/风险 Gate/缓存有证据；全量 test/typecheck/coverage/build/check-docs 通过；限制明确 |

## 5. 实现速查（建议接口，非强制签名）

| 能力 | 建议位置 | 依赖 |
|---|---|---|
| `classifyFile(snapshot, fingerprint, file)` | `src/structure/analysis.ts` | T-113 |
| `analyzeStructure(snapshot, { touched, maxDepth })` | `src/structure/analysis.ts` | T-113 |
| `computeRisk(analysis)` | `src/structure/risk.ts` | T-117 |
| `recommendTests(snapshot, riskFiles)` | `src/structure/risk.ts` + `src/gate/blast.ts` | T-117 |
| `buildReviewItems(analysis, risk)` | `src/structure/risk.ts` | T-117 |
| `structure.queried` schema | `src/ledger/payloads.ts` | T-112 |
| `structure_queries` 投影 + `currentExploredFiles` | `src/ledger/views.ts` | T-112 |
| `brief` 接入投影 | `src/memory/brief.ts`、`src/surface/service.ts` | T-112 |
| 文件级 outline/impact 查询 | `src/surface/service.ts`（`explore`） | T-112/T-113 |
| CJS 导出对象提取 | `src/structure/extractors/ts.ts`、`src/structure/extractor.ts` | T-114 |
| IIFE 作用域提取 | `src/structure/extractors/ts.ts`、`src/structure/extractor.ts` | T-115 |
| 动态/注册表 unknown | `src/structure/extractors/ts.ts`、`src/structure/types.ts` | T-116 |
| 结构证据类型 | `src/gate/types.ts`、`src/gate/verify.ts`、`src/gate/verdict.ts` | T-118 |
| 批量缓存 | `src/structure/analysis.ts`、`src/structure/store.ts` | T-119 |

## 6. 已知限制

- 语言仅 TS/JS（`SUPPORTED_EXTENSIONS`）；其他语言进 `unsupported`，不静默并入。
- 九类分类是**覆盖口径**，不是语义正确性判定；`parsed` 仍可能有 `semanticGaps`。
- 风险分是启发式输入，权重/阈值可配置；不承诺业务语义正确。
- 传递闭包有界（默认深度 3）；超界标 `depth_limit`，不追求无限精度。
- 动态加载/注册表只能给 `resolved`/`heuristic`/`unknown`，不追求静态全知。
- `exploredFiles` 只反映文件级查询留痕，不反映符号级阅读深度。
- 结构证据与执行证据分离，结构覆盖高不等于测试通过。
- 外部报告（`D:/Temp/ano_probe`）不可信，仅对照；真实验收须在受控副本重跑。
- 性能数字为同硬件/规模实测，不预写提速承诺。
- 不新增第八个 MCP 工具；文件级能力经既有 `explore`/`brief` 投影。

## 7. G1 口径修正、预算与错误码（T-120/T-121 修复后）

### 7.1 G1：字面量 resolved require 进入主口径（预期修正，不是新增缺陷）

- 修复：`src/structure/extractor.ts` 的 `addImportEdges` 对 `entry.require && entry.literal && resolution.status === 'resolved'` 的字面量 CommonJS `require()` 记为 `kind='value-confirmed'`、`provenance='resolved'`、`label='require'`；`isAdvisory()` 不再将其排除出 direct/transitive 主口径。动态 `import()` 字面量与 heuristic/unresolved/external 保持 advisory。
- 影响：真实副本四个 CJS 高波及中心主口径 direct/transitive 由 0/0 变为 **48/450、53/410、54/372、79/273**；全局 value-confirmed 85→3415、heuristicEdges 3365→35、unknownRatio 0.9862→0.4450。
- **风险分布 high 75→500 属预期口径修正**：此前直接入边被当 advisory 而未计入 impactScore，修复后同一批真实依赖进入主口径；不是新增缺陷，也不表示代码变差。既有实测数字见 `docs/evidence/structure-ecommerce-intelligence.md/.json`（不得回填篡改）。

### 7.2 F1：AST 预算闸

- `MAX_AST_WALK_DEPTH=1000`，节点/深度预算统一移植到 `extractNestedObject`/`extractNestedNode` 与全树 walker（collectIifeScopes/collectBlindSpots/calls/analyzeAst/analyzeMethod/extractCommonjsExports/extractObjectMembers）。
- 超限记显式 gap `AST walk deeper than 1000 [STRUCTURE_BUDGET_EXCEEDED]`（或嵌套作用域 `nested scope deeper than 16`），不再抛 RangeError；3000 层嵌套/50k 项链实测 parsed+indexed 带 gap。

### 7.3 F2：错误码词汇

- `src/structure/types.ts` 固定 `STRUCTURE_ERROR_CODES`：`QUERY_REVISION_MISMATCH`/`EVIDENCE_STALE`/`CLASSIFICATION_INVALID`/`BUDGET_EXCEEDED`/`UNSUPPORTED_INPUT`。
- 消费点：`assertValidClassification`（分类 fail-closed）、`structureQueryRevisionCode`/`structureEvidenceStaleCode`（revision/stale 信号）、`budgetReason`/parse-failed 后缀、会话 `structureErrorCodes`。
- 边界：目前主要作会话级可观测词汇，账本/Store 的权威校验消费待后续；不宣称已全面强校验。

## 8. 最终验收对账（T-122）

- 12 任务（T-111~T-122）状态与 verification 报告指针见 `docs/evidence/structure-intelligence-final-acceptance.json`；T-122 本身由主控验收。
- 四项能力证据：真实案例（T-120）、探查闭环（T-112/T-120）、风险驱动 Gate（T-117/T-118）、批量缓存（T-113/T-119）。
- 三审计与全量质量矩阵结果同见该 JSON；不宣称静态分析等于业务语义正确或测试覆盖完整。
