# M17 协议覆盖率恢复：最终覆盖表与剩余未覆盖清单（T-149 / CV-07）

- 生成时间：2026-11-25；环境：Windows 10.0.19041 x64、Node v24.14.0、Git Bash；仓库：`F:\Agent Nihil Obstat`。
- 数字来源：主控全量 `npm run coverage`（`--test-coverage-include=src/**/*.ts`）与 `npm test` 实测；各任务验收报告 `.pm/quality-runs/quality-20261125-*.json`；基线 `docs/evidence/m17-coverage-baseline.{md,json}`；稳定性 `docs/evidence/m17-stability-runs.md`。
- 本文件只做汇总与清单，**不重跑、不改写任何实测数字**；未单独给出的单文件数字一律标 `[数据缺失]`，不推断。
- 关联文档：[README M17 小节](../../README.md)、[交付状态](delivery-status.md)。

## 1. 全仓三指标 vs 目标

| 指标 | 目标 | 最终实测 | 差值 | 结论 |
|---|---|---|---|---|
| 行 | 95.37 | **95.64** | +0.27 | 达标 |
| 分支 | 83.54 | **84.57** | +1.03 | 达标 |
| 函数 | 95.20 | **95.36** | +0.16 | 达标 |

全量测试：`npm test` **1649 tests / 1648 pass / 0 fail / 1 skipped**（唯一 skip 为既有环境条件分支，非 M17 新增、非静默 skip）。

### 1.1 统计口径声明

1. 分母只含源码：`node --test --experimental-test-coverage --test-coverage-include='src/**/*.ts' "test/**/*.test.ts"` 的 `all files`；不带 include 会把 test/scripts 计入，**不能作验收口径**。
2. **无排除文件**：未使用 `--test-coverage-exclude`；`src/` 未添加 istanbul/等效 ignore 注释，未改变统计口径。
3. 唯一 skip 为既有环境分支（Windows 权限语义触发的条件跳过）；未新增 skip/todo/only，未隐藏既有失败。
4. 真实缺陷先修再计覆盖率（M17 共 5 项，见第 5 节）；拆分为纯搬迁，不改协议/错误码/事件字节。
5. 稳定性口径与覆盖率分开：进程 PID、连接计数、端口可重绑、定时器计数另行断言，不以「覆盖率达标」替代泄漏验收。

## 2. 逐文件最终覆盖

### 2.1 有权威最终数字的文件（10 个，全部达标）

| 文件 | 行% | 分支% | 函数% | 适用阈值（行/分支） | 结论 |
|---|---|---|---|---|---|
| `src/memory/tcp-frame-codec.ts`（新） | 100 | 97.37 | 100 | 90/80 | 达标 |
| `src/memory/tcp-connection.ts`（新） | 100 | 93.33 | 100 | 90/80 | 达标 |
| `src/memory/probe-merge.ts`（新） | 100 | 83.97 | 95.12 | 90/80 | 达标 |
| `src/memory/leader-state.ts`（新） | 98.68 | 89.29 | 100 | 90/80 | 达标 |
| `src/memory/replica-worker.ts` | 99.38 | 88.83 | [数据缺失] | 90/70（放宽档） | 达标 |
| `src/memory/replica-transport.ts` | 98.95 | 91.10 | [数据缺失] | 90/80 | 达标 |
| `src/memory/leader-lease.ts` | 99.36~100 | 93.87~94.60 | [数据缺失] | 90/80 | 达标 |
| `src/memory/ha-cluster.ts` | 97.97 | 86.85 | [数据缺失] | 90/80 | 达标 |
| `src/memory/distributed-probe.ts` | 95.21 | 92.16 | [数据缺失] | 90/80 | 达标 |
| `src/memory/tcp-transport.ts` | 96.96 | 90.39 | [数据缺失] | 90/80 | 达标 |

- `leader-lease.ts` 为给定事实中的多次运行时点区间（拆分前后/不同批次的最终运行），此处按原样并列，不合并成单值。
- 四个新模块为 T-147 拆分产物（纯逻辑搬迁，见第 5 节）；其行数：tcp-frame-codec 304、tcp-connection 104、leader-state 152、probe-merge 604。
- 未列入上表的其余 `src/` 文件没有在本任务证据中给出单文件最终百分比（`[数据缺失]`），不做推断；以主控终矩阵的单文件输出为准。

### 2.2 未达标文件

**无。** 上述 10 个有权威数字的文件全部达到各自阈值（含放宽档）。不存在「已知数字但低于阈值」而被排除或美化的文件。

### 2.3 六个关键模块：基线 → 最终

| 文件 | 行%（基线→最终） | 分支%（基线→最终） | 阈值 | 结论 |
|---|---|---|---|---|
| `replica-transport.ts` | 80.29 → 98.95 | 60.94 → 91.10 | 90/80 | 达标 |
| `replica-worker.ts` | 88.54 → 99.38 | 50.68 → 88.83 | 90/70 | 达标 |
| `tcp-transport.ts` | 87.47 → 96.96 | 72.89 → 90.39 | 90/80 | 达标 |
| `leader-lease.ts` | 88.15 → 99.36~100 | 75.49 → 93.87~94.60 | 90/80 | 达标 |
| `ha-cluster.ts` | 88.64 → 97.97 | 72.90 → 86.85 | 90/80 | 达标 |
| `distributed-probe.ts` | 90.84 → 95.21 | 79.18 → 92.16 | 90/80 | 达标 |

基线口径见 `m17-coverage-baseline.md` §1/§1.1；基线时为 6 文件 / 119 异常类别 / 300 未覆盖行区间。

## 3. 剩余未覆盖清单

汇总自基线 JSON（`files[].categories` 的 `unreachable-defensive` / `compile-time-seam` 标记）与各任务报告。**完整分类矩阵以基线文档为准**，本节只列 M17 结束时仍未消除或明确不补的部分。

### 3.1 不可达防御分支（2 处，明确不补）

| 位置 | 行号 | 理由 |
|---|---|---|
| `src/memory/replica-transport.ts` | 839 | `#validate` 的 default 分支：调用方 requestType/responseType 仅四种枚举，default 不可达（基线索引 RT-VALIDATE-DEFAULT）。 |
| `src/memory/replica-worker.ts` | 541-542 | `handleLine` 的 default 分支：`parseWorkerRequest` 已把 type 限制在已知集合内（基线索引 RW-UNSUPPORTED-TYPE）。 |

处置：登记为 `accepted-defensive`，不堆砌需要构造不可能输入的测试。

### 3.2 TCP 侧剩余（9 处，类别已确认、逐条行号未随报告落盘）

- 来源：T-145（CV-03）报告原文「剩余未覆盖 9 处均为不可达防御分支或需违反回环测试缝的竞态」。
- 类别分布：不可达防御分支 + 为稳定复现必须违反「仅 127.0.0.1/::1、端口 0、等待 ≤200ms」测试缝的竞态窗口。
- 逐条行号：**[数据缺失]**（该 9 处清单在 T-145 会话内列出，未写入 `.pm/tasks.json` 或证据文件；如需逐条行号，从 T-145 会话记录或终矩阵单文件 uncovered 输出补登）。

### 3.3 已消除的基线缺口（不是剩余）

| 项 | 原状态 | 现状 |
|---|---|---|
| `leader-lease.ts` `TcpVoterRpcAdapter`（1430、1434-1437、1440-1441、1444-1445、1448-1449、1452-1453） | 整类零覆盖的未验证 seam | T-146 补最小契约测试（target_id/voter_id getter、帧 kind、响应解析、畸形抛 `HA_INPUT_INVALID`），不再是无覆盖 seam |
| `ha-cluster.ts` `adjudicateNewestBranches`（1672-1712） | 循环体从未执行的核心承诺缺口 | T-146 构造「同步回来的分叉且两条都 committed」后覆盖 |
| `replica-transport.ts` 畸形行冗余数组构建（722-730） | F-6 性能线索 | T-144 改为单次遍历，语义不变 |

### 3.4 既有行为残留（非行覆盖问题，登记不修）

- `ChildProcessReplicaTransport.#entries` 不随 `stop` 删除，长期高频 start/stop 会保留 entry（含 stderr/cache）；与本次缺陷无关，避免触碰 stale-handle 既有断言语义，见 `m17-stability-runs.md` 第九节。
- `request(timeoutMs:0)` 同步抛出与异步路径的 API 一致性问题：T-145 证据排除为缺陷，仅登记未改语义。

### 3.5 环境/边界受限（不计入行覆盖分母问题）

- Windows 不强制读权限 → 既有指纹权限条件 skip（唯一 skip）。
- TLS 测试自签证书；CI 无证书生成工具时应显式跳过并打印，不得静默。
- 物理跨机、OS 真分区、生产 HA/SLA、跨机时钟回拨不在验证范围（沿用 M16/M17 边界声明）。

**清单规模摘要**：已登记剩余未覆盖 **11 处**（2 处不可达防御 + 9 处 TCP 防御/竞态）；另有 2 项非覆盖率残留（`#entries` 增长、timeoutMs=0 API 一致性）与 3 类环境边界。未发现被掩盖的真实缺陷残留。

## 4. 稳定性与泄漏结论（摘要）

- 关键 10 文件 ×3 共 30 次运行全绿（0 fail / 0 skip）；新稳定性套件 12/12 ×8 自然退出（无 force-exit）。
- 泄漏闸：PID 差集为空、`activeConnectionCount===0`、HA `resourceStats` 全零、Timeout 计数不增、tmpdir 残留 0；详见 `m17-stability-runs.md`。
- 时序用例对负载敏感（ha-split-brain ≈18.6s、崩溃重启 ≈9.6s）：CI 高负载下可能先超时而非泄漏，需以「失败即调查」处理。

## 5. M17 缺陷修复汇总

| ID | 严重度 | 位置 | 症状 / 根因 | 修法 | 状态 | 归属 |
|---|---|---|---|---|---|---|
| F-6 | info | `replica-transport.ts:722-730` | 畸形行分支用 `[...entries()].find(...)` 反查 id，冗余 O(n) | 改为单次遍历，语义不变 | 已修 | T-144 |
| DEF-1 | 高 | `replica-transport.ts` `restart()` | 同一 handle 并发 restart 启动两个子进程（stop+start 无互斥） | 新增 per-handle `#restarting` promise 复用 in-flight；顺序/错误码/返回结构不变 | 已修 | T-148 |
| DEF-2 | 高 | `leader-lease.ts` `#declarations`/`#votedByTerm` | 伪造 `(epoch,term)` 投票/心跳洪泛致声明表无界增长（5000 次实测 heap 17.3MB） | 上限 `LEADER_LEASE_MAX_DECLARATIONS=256` + 淘汰策略 + 清理非当前 term；SPLIT_BRAIN/fencing 语义复核不变 | 已修 | T-148 |
| TEST-INFRA | 中 | `test/redteam/m17-stability.test.ts` tmpdir hook | `t.after` FIFO 导致 sqlite 仍持 views.db 时 unlink（EBUSY）静默泄漏 47 目录 | close hook 先注册、rm 后注册；`removeTree` 重试耗尽后抛错 | 已修（仅测试文件） | T-148 |
| F-1 | low | `replica-transport.ts:670` | 基线称 `#requireLive` 错误模板多余字面量 `}` | 逐行 eval 复核为**基线误报**（输出无多余 `}`），按证据不改正确代码 | 复核不修，记录在案 | T-144 |
| D-0014 | — | `doctor` probePaths 隔离泄漏 | M16 期间发现的隔离泄漏 | 已在 M16 修复 | 已修（归属 M16，非 M17） | M16 |

> 真实 src 缺陷 3 个（F-6、DEF-1、DEF-2），测试基础设施缺陷 1 个（TEST-INFRA），误报 1 个（F-1）。修复均先于覆盖率复算完成。

## 6. 验收报告索引

| 任务 | 验收报告 | SHA-256 | 源码树（sha256-tree-v1） | 结论 |
|---|---|---|---|---|
| T-143 / CV-01 | `.pm/quality-runs/quality-20261125-051743-607-0000.json` | `89c4416b7c08c689352825f7e8c2f61cfc4970efc815dee727beed2ab7772b9e` | `f39bc6b4…` / 494 files | ok=true、stable=true |
| T-144 / CV-02 | `.pm/quality-runs/quality-20261125-062222-578-0000.json` | `4559bf98758232209ca5fa7d2f92a83d522485036b778e623013a25d21907a01` | `23fbb5a9…` / 501 files | ok=true、stable=true（与 CV-03/04 合并报告） |
| T-145 / CV-03 | 同上（`quality-20261125-062222-578-0000.json`） | 同上 | 同上 | ok=true、stable=true |
| T-146 / CV-04 | 同上（`quality-20261125-062222-578-0000.json`） | 同上 | 同上 | ok=true、stable=true |
| T-147 / CV-05 | `.pm/quality-runs/quality-20261125-065047-640-0000.json` | `1ff772b10082c844177b0e616d41c915a8be77f0e1f97fbc0fff27082679884a` | `645ad8bd…` / 505 files | ok=true、stable=true |
| T-148 / CV-06 | `.pm/quality-runs/quality-20261125-081803-573-0000.json` | `3cbdda67f179c68af813653d76447b43a6db9452bf08e45a69f4ded418a68f3b` | `af733b37…` / 507 files | ok=true、stable=true |
| T-149 / CV-07 | 待主控终矩阵（本文件只列既有证据索引，不预填终矩阵文件名/哈希） | — | — | 待终矩阵 |

上述实现任务的报告均覆盖各自时点源码，**不等于**当前树的终矩阵；终矩阵由主控在 T-149 文档定稿后运行。

## 7. 边界声明

- 覆盖率是「被执行到的分支」比例，**不等于测试充分性，更不等于无缺陷**；未覆盖清单与已覆盖但语义未验证的路径都可能有风险。
- 单文件最终数字只对第 2.1 节 10 个文件负责；其余文件以终矩阵为准。
- 稳定性与泄漏结论来自 Windows 本机 loopback + 真实子进程，不外推跨机、OS 真分区或生产 SLA。
