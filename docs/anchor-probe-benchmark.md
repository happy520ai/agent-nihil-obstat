# AnchorProbe 基准报告（T-060 / AP-23）

- 日期：2026-11-22
- 状态：范围内完成；实验目标未达项已如实标注
- 被测对象：`probe()` 检索核心 + 三个 `ProbeStore` 后端（`ProjectedProbeStore` / `SqliteProbeStore` / `BitChainProbeStore`）+ 关系分类器 + `runConsumer` 端到端 harness
- 复现入口：`node scripts/benchmark-anchor-probe.ts --scale S`（默认输出 JSON/MD 到 `os.tmpdir()/ano-anchor-probe-benchmark/`）
- smoke 门禁：`node --test test/benchmark/anchor-probe.bench.ts`

## 1. 结论

1. **同语义对照成立**：在同一批 `ViewReplayEntry[]`、同一 snapshot、同一预算、同一请求集下，`ProjectedProbeStore` / `SqliteProbeStore` / `BitChainProbeStore` 的 `snapshotIdentity`、`candidates({})`、`adjacency()` 与 `probe()` 完整响应全部 deep-equal（S/M/L 三档均通过，`mismatches=[]`）。
2. **检索性能**：在本地合成夹具上，BitChain 后端 warm-cache 的 `probe()` 全程 p50 最小（S 0.109ms / M 0.403ms / L 2.695ms），SQLite 次之（1.912 / 5.929 / 27.298ms），投影后端最慢（7.844 / 38.594 / 215.776ms）。**这是本地合成、热缓存的引擎对照，不是端到端收益**：真实 Surface 默认路径每次调用都重建投影，L 档 p50 198.686ms，BitChain 未接线，端到端收益未验证。
3. **分类器消融**：规则层在 22 案例标注集上 definitive 16 / needs_review 6，准确率 0.8125，漏召 1、错误放行 1、错误替代 1；脚本化不完美模型把准确率降到 0.625（误废弃 3、漏召 4）。替代阈值 0.75 是编译期常量，**未能直接扫描**，只做了边界探针。
4. **端到端**：S 档真实 harness（probe→manifest→verify→consumer）p50 7.72ms、p95 10.712ms、重试 0；真实模型、真实查询分布、远端成本均为未测项。
5. **不默认启用**：BitChain 仅在基准中显式打开 `.ano/cache/probe-store.bitchain`（实际写入 tmpdir 工作根），未改默认路径，未改 `src/`。

## 2. 口径与指标定义

对照口径照抄 T-059 移交：三个后端使用**同一** `ViewReplayEntry[]`、**同一** `AnchorProbeSnapshot`、**同一** `AnchorProbeBudget`、**同一**请求集。`BitChainProbeStore` 由 `BitChainProbeStore.write(path, entries, snapshot)` 显式重建后 `open`，路径为工作根下的 `.ano/cache/probe-store.bitchain`。

| 指标 | 计算公式 / 定义 |
|---|---|
| 入口召回 `entryRecall` | 期望活跃 head 出现在 `active_evidence` 的 answerable 事实数 / answerable 事实数 |
| 入口精确 `entryPrecision` | `active_evidence.record_ref ∈ truthRefs` 的条数 / `active_evidence` 条数；`truthRefs` = answerable head ∪ 其直接 confirmed 边邻居 |
| 截断 `truncated` | `retrieval_completeness != COMPLETE_WITHIN_DECLARED_SCOPE` 或 `stop_reason ∈ {BUDGET_EXHAUSTED, DEPTH_LIMIT, TIMEOUT, ENTRY_NOT_FOUND, ERROR}` |
| 冲突漏报 `conflictMiss` | 期望 conflicted 事实中未出现在 `response.conflicts` 的数量 |
| 冲突误报 `conflictFalse` | `response.conflicts` 中不在期望 conflicted 集合的数量 |
| 错误废弃 `wronglyDeprecated` | answerable 期望 head 出现在 `deprecated_tombstones` 的数量 |
| 过时使用 `staleUse` | `active_evidence` 中 status 为 `superseded`/`retracted` 的数量 |
| 约束违反 `constraintViolations` | `l1_invariants` 中 `violated` 数量 + coverage-gate/stop-reason 契约冲突数 |
| 有效回答 `validAnswers` | head 在证据中且该事实无未解决冲突的 answerable 事实数 |
| P50/P95/P99 | 最近秩百分位：`ceil(p/100*n)-1`，升序索引 |
| TTFT | 代理值 = 同步 `memoryProbeSurface` 调用的 p50（非流式首字节） |
| 重试 | 本地无远端调用，固定为 0 |
| token | 估算：分类器 `比较次数 * ceil((平均 source+target 字符 + 120) / 4)`；端到端 `模型调用数 * ceil((平均证据字符 + 200) / 4)`。**是估算，不是真实账单** |
| RSS | `process.memoryUsage().rss` 前后差，未强制 GC |
| 磁盘 | 后端文件字节数（`statSync`） |
| 重建 | 从 `entries` 构造后端并加载的 wall-clock |

## 3. 对照矩阵 × 指标（真实运行数字）

环境：node v24.14.0 / win32 x64 10.0.19041 / 12th Gen Intel(R) Core(TM) i7-12700KF x20。

### 3.1 夹具构成

| 档位 | 事件 | memory.revised | note.recorded | memory.related | 段 | 受治理事实 | 冲突事实 | 投影记录 | confirmed 边 |
|---|---|---|---|---|---|---|---|---|---|
| S | 200 | 44 | 120 | 36 | 3 | 24 | 1 | 158 | 36 |
| M | 1000 | 213 | 607 | 180 | 3 | 120 | 2 | 790 | 180 |
| L | 5000 | 1042 | 3058 | 900 | 3 | 600 | 3 | 3971 | 900 |

三个后端记录数/边数完全一致（S 158/36、M 790/180、L 3971/900），`mismatches=[]`。

夹具的“并发竞争段”= 两个已提交段 `bench-race-a.jsonl` / `bench-race-b.jsonl`，各自的分支 revision 依赖同一个 prior，投影后成为 conflicted 事实。公开 append 路径会用确定性前置条件拒绝 stale prior，因此该形状只能由提交两段（合并/恢复）产生；夹具按此方式构造，不宣称是单进程实时双会话竞争。

### 3.2 检索延迟（ms，p50 / p95 / p99；`candidates({})` / `adjacency()` / `evidence(ref)` / `probe` 全程）

| 档位 | 后端 | 重建 | 磁盘 B | candidates({}) | adjacency() | evidence(ref) | probe 全程 |
|---|---|---|---|---|---|---|---|
| S | projected | 30.27 | 0 | 0.422 / 0.457 / 0.457 | 0.044 / 0.097 / 0.097 | 3.033 / 3.382 / 3.382 | 7.844 / 18.166 / 18.166 |
| S | sqlite | 100.429 | 753664 | 0.430 / 0.568 / 0.568 | 0.045 / 0.064 / 0.064 | 0.290 / 0.524 / 0.524 | 1.912 / 4.241 / 4.241 |
| S | bitchain | 29.672 | 125204 | 0.000 / 0.007 / 0.007 | 0.000 / 0.004 / 0.004 | 0.002 / 0.180 / 0.180 | 0.109 / 0.236 / 0.236 |
| S | surface-default | — | — | 11.205 / 17.965 / 17.965（全程） | 同左 | 同左 | 11.205 / 17.965 / 17.965 |
| M | projected | 134.194 | 0 | 1.760 / 2.226 / 2.226 | 0.177 / 0.268 / 0.268 | 15.908 / 16.618 / 16.618 | 38.594 / 39.150 / 39.150 |
| M | sqlite | 184.454 | 2928640 | 2.035 / 2.124 / 2.124 | 0.141 / 0.174 / 0.174 | 0.237 / 0.329 / 0.329 | 5.929 / 6.240 / 6.240 |
| M | bitchain | 124.140 | 622356 | 0.000 / 0.008 / 0.008 | 0.000 / 0.002 / 0.002 | 0.002 / 0.061 / 0.061 | 0.403 / 3.818 / 3.818 |
| M | surface-default | — | — | 41.782 / 59.829 / 59.829（全程） | 同左 | 同左 | 41.782 / 59.829 / 59.829 |
| L | projected | 536.623 | 0 | 10.429 / 11.881 / 11.881 | 0.782 / 0.956 / 0.956 | 73.086 / 77.987 / 77.987 | 215.776 / 217.435 / 217.435 |
| L | sqlite | 682.745 | 13692928 | 11.177 / 11.528 / 11.528 | 0.616 / 0.681 / 0.681 | 0.233 / 0.338 / 0.338 | 27.298 / 34.050 / 34.050 |
| L | bitchain | 620.964 | 3132922 | 0.000 / 0.016 / 0.016 | 0.000 / 0.002 / 0.002 | 0.002 / 0.071 / 0.071 | 2.695 / 12.188 / 12.188 |
| L | surface-default | — | — | 198.686 / 216.258 / 216.258（全程） | 同左 | 同左 | 198.686 / 216.258 / 216.258 |

说明：`surface-default` 是真实 Surface 路径，每次调用重建投影并过滤 conflicted 记录、注入 fork，因此与三个 `ProbeStore` 后端不是 deep-equal；同语义断言只针对 projected/sqlite/bitchain。Surface 行不暴露子操作耗时，表中各列重复全程值。

### 3.3 检索质量（按夹具真值）

| 档位 | 后端 | 请求 | 入口召回 | 入口精确 | 截断 | 冲突漏报 | 冲突误报 | 错误废弃 | 过时使用 | 约束违反 | 有效回答 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| S | projected/sqlite/bitchain | default | 1 | 0.6667 | false | 0 | 0 | 0 | 0 | 0 | 4 |
| S | projected/sqlite/bitchain | wide | 1 | 0.6667 | false | 0 | 0 | 0 | 0 | 0 | 4 |
| S | surface | default/wide | 1 | 0.8571 | false | 0 | 0 | 0 | 0 | 0 | 4 |
| M | projected/sqlite/bitchain | default | 1 | 0.6000 | true | 0 | 0 | 0 | 0 | 0 | 4 |
| M | projected/sqlite/bitchain | wide | 1 | 0.4706 | true | 0 | 0 | 0 | 0 | 0 | 4 |
| M | surface | default | 1 | 1.0000 | true | 0 | 0 | 0 | 0 | 0 | 4 |
| M | surface | wide | 1 | 0.6154 | true | 0 | 0 | 0 | 0 | 0 | 4 |
| L | projected/sqlite/bitchain | default | 1 | 0.4545 | true | 0 | 0 | 0 | 0 | 0 | 4 |
| L | projected/sqlite/bitchain | wide | 1 | 0.3478 | true | 0 | 0 | 0 | 0 | 0 | 4 |
| L | surface | default | 1 | 1.0000 | true | 0 | 0 | 0 | 0 | 0 | 4 |
| L | surface | wide | 1 | 0.4706 | true | 0 | 0 | 0 | 0 | 0 | 4 |

要点：入口召回恒为 1，冲突漏报/误报、错误废弃、过时使用、约束违反均为 0；精确率随规模下降（默认预算 `max_candidates=16` / `max_nodes=12` 在 M/L 触发 `truncated=true`），这是预算截断的真实表现，不是后端差异。

### 3.4 端到端（harness：probe→manifest→verify→consumer）

| 档位 | Surface probe p50 / p95 | manifest freeze+read p50 / p95 | 端到端 p50 / p95 / p99 | TTFT 代理 | 重试 | 模型调用 | verify 调用 |
|---|---|---|---|---|---|---|---|
| S | 5.335 / 5.883 | 1.583 / 4.253 | 7.720 / 10.712 / 10.712 | 5.335 | 0 | 3 | 1 |
| M | 19.702 / — | 3.994 / — | 24.649 / — / — | 19.702 | 0 | 1 | 1 |
| L | 97.964 / — | 4.074 / — | 97.595 / — / — | 97.964 | 0 | 1 | 1 |

S 档迭代 3 次，M/L 各 1 次（可选档）。outcome 均为 `NEEDS_REVIEW`（v1 验证器诚实结果）。

### 3.5 成本

| 档位 | RSS before / after / delta (B) | 磁盘 sqlite / bitchain (B) | 重建 projected / sqlite / bitchain (ms) | token 估算 分类器 / 端到端 |
|---|---|---|---|---|
| S | 97660928 / 150147072 / 52486144 | 753664 / 125204 | 30.270 / 100.429 / 29.672 | 1122 / 195 |
| M | 114262016 / 309792768 / 195530752 | 2928640 / 622356 | 134.194 / 184.454 / 124.140 | 1122 / 65 |
| L | 155058176 / 513642496 / 358584320 | 13692928 / 3132922 | 536.623 / 682.745 / 620.964 | 1122 / 65 |

## 4. 消融结论（如实）

### 4.1 检索后端

- **观察**：warm-cache `probe()` 全程 p50：L 档 BitChain 2.695ms < SQLite 27.298ms < 投影 215.776ms；磁盘 BitChain 3.13MB < SQLite 13.69MB。
- **未达/未验证**：
  - 端到端收益**未验证**。真实 Surface 默认路径每次调用重建投影（L 档 198.686ms），BitChain 未接线；即使接线，也需先改 Surface 的投影构建方式，本任务未做。
  - 重建时间 BitChain 并未更快（L：620.964ms vs 投影 536.623ms），冷启动无优势。
  - 真实查询分布 `[数据缺失]`，合成夹具的 note/memory 比例（L：3058/1042）不代表生产。
  - 因此**不宣称端到端十倍**，不默认启用 BitChain。

### 4.2 分类器（22 案例合成标注集）

| 档位 | 判定数 | needs_review | 弃权率 | 准确率 | 误废弃 | 漏召 | 错误放行 | 错误替代 | 过度自信 |
|---|---|---|---|---|---|---|---|---|---|
| rule-only（阈值 0.5） | 16 | 6 | 0.2727 | 0.8125 | 0 | 1 | 1 | 1 | 0 |
| 阈值 0.6 | 16 | 6 | 0.2727 | 0.8125 | 0 | 1 | 1 | 1 | 0 |
| 阈值 0.7 | 15 | 7 | 0.3182 | 0.8000 | 0 | 1 | 1 | 1 | 0 |
| 阈值 0.75 | 13 | 9 | 0.4091 | 0.7692 | 0 | 1 | 1 | 1 | 0 |
| 阈值 0.8 | 12 | 10 | 0.4545 | 0.8333 | 0 | 0 | 1 | 1 | 0 |
| model（脚本化不完美） | 16 | 6 | 0.2727 | 0.6250 | 3 | 4 | 1 | 1 | 0 |
| budget:tight | 7 | 2 | 0.2222 | 0.8571 | 0 | 0 | 1 | 0 | 0 |
| budget:default | 8 | 3 | 0.2727 | 0.7500 | 0 | 0 | 1 | 1 | 0 |
| budget:wide | 9 | 4 | 0.3077 | 0.7778 | 0 | 0 | 1 | 1 | 0 |

- **规则层开关 / 模型层开关**：模型层复用脚本化不完美适配器（漏掉显式 supersede、对 needs_review 弃权、其余同意）。它把准确率从 0.8125 降到 0.625，并产生 3 个误废弃、4 个漏召——与 `test/unit/relation-classifier.test.ts` 的期望一致。
- **替代阈值 0.75 敏感性**：`HEURISTIC_SUPERSEDE_THRESHOLD=0.75` 是 `src/memory/relation-classifier.ts` 的编译期常量，公开校准 API 未暴露。**直接扫描未执行**（文件边界禁止改 `src/`）。替代探针：同事实 / proposed→active / 同 kind 对 7 个，词面 Jaccard ≥0.75 的 4 个（判 supersede_candidate）、<0.75 的 3 个（判 continuation）。词面阈值 `LEXICAL_RELATION_THRESHOLD=0.45` / `LEXICAL_STRONG_THRESHOLD=0.7` 同样未暴露。
- **预算档位**：`targetDropped` 随预算放宽下降（tight 13 → default 11 → wide 9），但准确率非单调（0.8571 / 0.7500 / 0.7778）——紧预算丢掉的样本本身较难，不能据此宣称放宽预算提高准确率。预算档位的 `evaluated` 只统计真目标进入候选切片的情况。

## 5. 验证命令真实输出摘要

| 命令 | 结果 |
|---|---|
| `node --test test/benchmark/anchor-probe.bench.ts` | `tests 2 / pass 2 / fail 0 / duration_ms 642.0275`（smoke 档；`ANCHOR_PROBE_BENCH_SCALE=M` 亦可全绿，duration_ms 1594.7019） |
| `node scripts/benchmark-anchor-probe.ts --scale S` | 退出 0；stdout 输出 MD；`JSON 写入：D:\Temp\ano-anchor-probe-benchmark\benchmark-S.json`、`MD 写入：...\benchmark-S.md` |
| `npx tsc -p tsconfig.json --noEmit` | 退出 0，无输出 |

**两次运行一致性证据**（`--scale S --runs 2`，同种子 20261122）：

| 指标 | 第一次 | 第二次 | 比值 |
|---|---|---|---|
| projected.probeFull.p50Ms | 7.844 | 7.253 | 1.081 |
| sqlite.probeFull.p50Ms | 1.912 | 1.896 | 1.008 |
| bitchain.probeFull.p50Ms | 0.109 | 0.106 | 1.028 |
| surface.probeFull.p50Ms | 11.205 | 11.045 | 1.014 |
| endToEnd.p50Ms | 7.720 | 6.954 | 1.110 |

确定性字段（fixture viewDigest、三后端等价报告、分类器指标、质量指标）两次完全一致；时延 p50 比值均 ≤1.11（噪声带 2.5x 内）。`deterministicEqual=true`、`timingWithinBand=true`。

## 6. 限制与移交项（给 T-061 最终对账）

- **真实模型未测**：分类器模型层与端到端模型都是脚本化适配器；token 为字符估算（公式见 §2），不是真实账单。
- **真实查询分布未测**：`[数据缺失]`。基准使用固定合成请求集，未采样真实客户端查询。
- **远端成本未测**：无网络/远端模型调用，重试固定 0；真实部署的重试与远端延迟未知。
- **端到端性能收益未验证**：BitChain 只在显式注入下测量；默认 Surface 路径仍是每次重建投影，L 档 p50 198.686ms。
- **掉电持久性 / Windows 目录 fsync 限制**：未验证（沿用 T-059 结论）。
- **统计稳健性**：单机单进程，S 档迭代 10 次、端到端 3 次；M/L 为可选档，端到端各 1 次。
- **默认启用条件未满足**：真实延迟/成本/质量对照与掉电恢复验证未完成，BitChain 不应默认启用。

## 7. 文件与复现

- 运行器：`scripts/benchmark-anchor-probe.ts`（导出 `buildFixture` / `runBenchmark`，CLI 参数 `--scale/--seed/--iterations/--e2e-iterations/--runs/--json/--md/--skip-e2e`）
- 门禁：`test/benchmark/anchor-probe.bench.ts`（默认 smoke；`ANCHOR_PROBE_BENCH_SCALE=M|L` 可跑大档）
- 本报告：`docs/anchor-probe-benchmark.md`
- 临时产物：全部写入 `os.tmpdir()`；仓库内未改 `src/`、既有 `test/`、账本冻结件、`.pm/`、`.ano/`。
