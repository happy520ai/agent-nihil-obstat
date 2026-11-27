# Phase 3 Structure 阶段性报告

日期：2026-11-19
范围：`src/structure/**`、`test/redteam/structure-full.test.ts`、`test/integration/structure-explore.test.ts`、`scripts/bench-graph.ts`、`docs/phase-3-report.md`、`docs/evidence/p3-graph-bench.json`。
未修改 `src/gate`、`src/ledger`、`src/surface`、`src/memory`、`src/audit`、`src/readiness`。

## 结论

在已有 L0/L1 图（import/export 三态边、符号定义、SQLite 重放、freshness）之上，补齐了 L2 调用边、T2 纯函数、内容哈希增量缓存、单写者事务和 explore 五个原语的库 API，并用本仓库真实源码生成了本机基准数据。当前实现可被主控 Gate/Surface 直接引用，但不能据此宣布多语言支持或客户端预算已经实测。

## 实现内容

### 1. L2 调用边

- `src/structure/extractors/ts.ts`：tree-sitter 解析调用点（`foo()`、`recv.foo()`、`this.foo()`、`new Foo()`）、类方法、`const x = new Class()` 实例绑定和调用者作用域（`Class.method`、`outer.inner`）。
- `src/structure/extractor.ts`：在全部模块解析完成后做名称解析，只接受：
  - 同文件顶层/局部函数、类方法或类字段箭头函数；
  - 明确命名导入（含 alias、barrel 显式重导出）；
  - namespace 导入的静态成员 `ns.fn()`；
  - 导入类/本地类实例方法、`this.method()`、`new Class()`。
- 无法确定的同名方法（例如未标注类型的 receiver）只记为 `heuristic`；类型/`import type` 目标不产生调用边，并计入 `typeOnlyCallSites`。无法解析的全局/外部/动态调用不伪造边，计入 `unresolvedCallSites`。
- `CallEdge` 独立存放在 `GraphSnapshot.calls`，与 `snapshot.edges` 分开。调用边不会把 import 边升级为 `value-confirmed`；T1 语义保持不变。
- 符号新增类方法（`Calculator.run` 等），符号 ID 仍由 `file + kind + name + qualifiedName` 生成，不含行号。

### 2. T2 查询

- `src/structure/t2.ts`：
  - `affectedSymbols(snapshot, touchedFiles)`：只取受影响文件中的 value 符号。
  - `reachableSymbolsViaCalls(snapshot, executedTests)`：只遍历 `provenance === 'resolved'` 的 L2 调用边；根是已执行测试文件与其符号，文件级根只允许已执行测试文件，避免“目标文件被加载 = 全部符号可达”。
  - `t2Coverage(snapshot, executedTests, touchedFiles)`：返回 `applicable / satisfied / affected / covered / uncovered / reachable / coveredFiles / edgesUsed / resolvedCallEdges`。
- T2 完全不读取 `snapshot.edges`（T1 import 语义）；heuristic 调用边不参与可达性。无可调用 value 符号时返回 `applicable: false`，不会把 T2 报成通过。

### 3. 增量、单写者与 degraded 恢复

- `GraphStore` 持久化 `parsed_files(path, hash, version, source_json)` 内容哈希缓存。文件哈希与上次快照、缓存都相同时跳过读取与 tree-sitter 解析，只重算依赖边/调用边；`BuildReport` 增加 `reused`，`mode` 为 `full | incremental`。缓存带 `EXTRACTOR_VERSION`，抽取语义升级后旧缓存自动失效并重解析。
- 未变化调用方在依赖变化时会重新解析其 import/call 边：删掉被导入的导出后，旧调用边会消失（红队测试覆盖）。
- SQLite schema 升级到 2：新增 `calls`、`parsed_files` 表；v1 缓存原地迁移，保留 files/symbols/edges 行，不删数据，并将 freshness 标为 stale 直到重建。未知版本才显式重建表。
- 写入使用 `BEGIN IMMEDIATE` + `busy_timeout = 5000`，整个 snapshot 在同一事务内替换；写失败 `ROLLBACK`，旧图保留。
- 读取 I/O 错误（非 ENOENT）保留旧文件、符号、import 边和调用边，图标 degraded；只有明确 ENOENT 才删墓碑。缓存 JSON 损坏只当 cache miss，不删图。

### 4. explore 原语

`src/structure/explore.ts` 提供库 API：

- `exploreSymbol`：按 id/name/qualifiedName/file 查找，可选源码片段、入/出调用和 import 关系。
- `exploreFlow`：在调用图上做有界路径搜索，默认只用 resolved 边；每步给出调用文件/行、callee、provenance/label、调用点源码片段和 callee 定义源码片段。
- `exploreImpact`：import 反向闭包 + 调用反向闭包，分别返回 `impactedFiles`、`callerFiles`、`callerSymbols`。
- `exploreSearch`：符号名/限定名/file 路径搜索；`totalSymbols`/`totalFiles`/`totalMatches` 是真实命中数。
- `exploreOutline`：单文件符号（含方法）按行排序，可选单行片段。
- `explore`：按任务文本提取候选符号/文件，编排 search/symbol/outline/impact/flow。
- 所有返回都带 `graphRevision`、`freshness`、`caveats`、`budget`。`budget` 明确是 `unit: characters`、`semantics: output-size`；`totalMatches` 在裁剪前计算，预算不参与命中总数。0 字符预算下仍报告真实命中数而 `returned = 0`（红队测试覆盖）。

### 5. 基准

`scripts/bench-graph.ts` 将本仓库 `src/`、`test/`、`package.json`、`tsconfig.json` 复制到 `os.tmpdir()`，使用真实 SQLite 图跑：
首次全量、无变化增量、单文件变化增量、impact、T2、explore search、explore 编排；记录环境、计数、耗时和 RSS/heap 观测值。原始数据写入 `docs/evidence/p3-graph-bench.json`。

## 验证结果

执行命令：

```text
npm run typecheck
node --test test/integration/structure.test.ts test/redteam/structure-hardening.test.ts test/unit/structure.test.ts test/integration/structure-explore.test.ts test/redteam/structure-full.test.ts
node scripts/bench-graph.ts
```

实际结果：

- `npm run typecheck`：通过。
- structure 相关测试：37/37 通过（5 个文件；其中新增 integration 5 项、redteam 6 项）。
- 基准（本机 Windows x64，Node v24.14.0，i7-12700KF，20 逻辑 CPU，约 31.8 GiB）：

| 指标 | 实测 |
|---|---:|
| 文件数 | 103 |
| 符号数 | 1,184 |
| import/export 边 | 689 |
| L2 调用边 | 2,375（resolved 2,359 / heuristic 16） |
| 首次全量构建 | 736.88 ms |
| 无变化增量构建 | 141.43 ms（parsed 0 / reused 103） |
| 单文件变化增量 | 131.22 ms（parsed 1 / reused 102） |
| impact（20 次中位数） | 0.065 ms（结果 40 个文件） |
| T2（20 次中位数） | 0.356 ms（affected 1 / satisfied true） |
| explore search（10 次中位数） | 0.466 ms（真实命中 249，预算内返回 17） |
| explore 编排单次 | 10.87 ms（预算 4,000 字符，真实命中 112，返回 6） |
| 首次构建 RSS 增量 | 约 59.9 MB（heap 增量约 12.7 MB） |
| 增量构建 RSS 增量 | 约 25.1 MB（heap 增量约 25.8 MB，未强制 GC） |

caveats：value-confirmed 268、type-only 121、unknown 300、heuristic import 边 1、unknownRatio 0.435、动态加载 3、不可解析动态加载文件 0、unresolved 调用点 7,359、type-only 调用点 0（本仓库源码）。

## 限制与未验证项

1. **语言支持**：只声明并测试 TS/JS 语法（`.ts/.tsx/.js/.jsx/.mjs/.cjs`）。没有执行“每种语言小/中/大三档真实仓库各 ≥3 个 flow”的 G2 验收，因此不能宣布全语言支持。
2. **L2 精度**：只解析同文件定义、明确命名导入、namespace 静态成员、可确定的类/实例方法、`this`、`new`。未标注类型的动态 receiver 只给 heuristic；跨文件对象字面量方法、复杂链式 receiver、回调/框架分发未做（属于 L3）。
3. **T2 是符号级静态可达，不是运行时覆盖率**：只证明受影响 value 符号在已执行测试的 resolved 调用图中可达；不覆盖动态分派、反射、回调注入。无可调用 value 符号时 T2 不适用，不能当作通过。
4. **单写者只做了 SQLite 事务级实现**：`BEGIN IMMEDIATE` + 5s busy timeout，未做“强杀 leader 后 standby 限时接管”的多进程实测；没有常驻 daemon。
5. **缓存限制**：内容哈希缓存存的是 parse JSON，没有淘汰/压缩策略；文件删除会清对应缓存行，损坏缓存按 miss 处理。依赖变化会重算边，但未做大规模仓库缓存体积基准。
6. **预算**：字符预算是库内输出裁剪（4,000 字符实测），没有对具体客户端输出上限做实测，也没有验证客户端截断行为；flow 有 `maxDepth`（上限 12）和路径枚举上限（500）。
7. **基准环境**：单机、单次/少量重复，Windows 本机数据，不代表 Linux/macOS CI；内存为进程 RSS/heap 观测，未强制 GC。
8. **explore 编排**：任务文本候选符号是启发式抽取；预算按 section 分配并在超限时裁剪，section 的 `totalMatches` 保持裁剪前数值。

## 主控接入建议

- Gate 侧可直接调用 `t2Coverage(...)`，把 `satisfied && applicable` 作为 T2 通过条件；`applicable: false` 不得升级为 T2。
- Surface 的 explore 可直接复用 `src/structure/explore.ts` 的五个原语和 `explore` 编排；把 store 的 `freshness()` 传入 `ExploreOptions`。
- 下一步补多进程强杀/接管测试和目标客户端预算实测后，再更新 P3 的验收表述。
