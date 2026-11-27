# M17 红队、重复运行与资源泄漏稳定性验收（T-148 / CV-06）

- 日期：2026-11-25；环境：Windows 10 x64、Node v24.14.0、Git Bash；仓库：`F:\Agent Nihil Obstat`。
- 范围：仅本地回环 TCP / 进程内协议层红队。跨机部署、OS 真分区、物理集群与 SLA 未验证（沿用 M16/M17 既有边界声明）。
- 交付：新增 `test/redteam/m17-stability.test.ts`（12 用例）+ 本证据文档；`src/` 仅两处真实缺陷最小修复。

## 一、结论

**稳定性验收通过。** 新套件最终代码多次复跑 12/12 全绿并自然退出；10 个关键文件 ×3 共 30 次运行全绿、0 fail、0 skip；全量 `node --test --experimental-test-coverage test/**/*.test.ts` exit 0（1649 tests / 1648 pass / 0 fail / 1 既有条件 skip）；`tsc --noEmit` 0。发现并修复 2 个真实 src 缺陷（并发 restart 双进程、伪造 epoch/term 洪泛无界增长），另修正新套件自身的 tmpdir hook 顺序缺陷（仅测试文件）。

## 二、真实缺陷清单（症状 / 根因 / 修法 / 复跑）

### DEF-1 同一 handle 并发 `restart()` 启动两个子进程

| 项 | 内容 |
|---|---|
| 症状 | `Promise.all([transport.restart(h), transport.restart(h)])` 返回两个不同 PID，两个 worker 进程同时存活；调用方通常只保留一个 handle，另一个成为无人回收的失控进程。 |
| 证据 | 修复前探针：原 pid 8564 死亡后，替换 pid 28124 与 66564 同时 `process.kill(pid,0)` 存在；修复后两次调用返回同一 pid（1660），仅一个存活。 |
| 根因 | `ChildProcessReplicaTransport.restart` = `stop(handle)` + `start(options)`，全程无并发互斥（旧实现 451-476 行）；两个调用各自执行一次停/启。 |
| 修法 | `src/memory/replica-transport.ts`：新增 per-handle `#restarting` promise（408 行），`restart`（451-461）复用 in-flight promise，原主体移入 `#restartFrom(entry)`（463 起）。顺序重启语义、错误码、返回结构不变。 |
| 复跑 | 新增用例「进程竞态：同一 handle 并发 restart 只启动一个替换进程」绿（约 0.5-0.7s）；`replica-process`/`replica-transport-faults` 回归 65/65 绿。 |

### DEF-2 伪造 `(epoch,term)` 投票/心跳洪泛导致声明表无界增长

| 项 | 内容 |
|---|---|
| 症状 | 向 `handleVoteRequest` 连发递增 term/epoch 的伪造投票（loopback HA TCP 端点可达），`collectDeclarations()` 从 0 增至 5000（实测），`#votedByTerm` 同步增长；进程内存随攻击线性上升。 |
| 证据 | 修复前探针：5000 次请求后 declarations=5000、heapUsed 17.3MB；修复后同样 5000 次请求 declarations=256。 |
| 根因 | `src/memory/leader-lease.ts` 的 `#declarations`（356 行）与 `#votedByTerm`（355 行）只增不减；`#votedByTerm` 实际只读取当前 term（621 行），旧 term 条目为死重。 |
| 修法 | 新增内部上限 `LEADER_LEASE_MAX_DECLARATIONS=256`（100 行）；`#recordDeclaration` 后调用 `#pruneDeclarations`（1078/1089）：淘汰最旧声明——冲突组保留 2 个 leader、本地 fencing baseline 永不淘汰、单 leader 历史优先淘汰；全冲突组极端洪泛由兜底 pass（1112-1117）保证硬上限。新增 `#forgetStaleTerms`（1121），在 `requestVote`（537）与 `handleVoteRequest`（640）清理非当前 term。协议、错误码、冲突判定语义不变。 |
| 语义复核 | 同 term rival 仍记录并触发 `SPLIT_BRAIN`；`assertCanCommit` 的 `FENCE_EPOCH_ROLLBACK`/`FENCE_STALE_TERM`/`FENCE_REJECTED` 行为不变（探针 3c/3d + 新用例断言）。 |
| 复跑 | 新用例：1000 次伪造投票 + 200 组双 leader 冲突心跳后 `collectDeclarations().length <= 256` 且最新冲突可见；既有 `leader-lease` 单元/集成 58/58 绿。 |

> 残留（未修，既有行为）：`ChildProcessReplicaTransport.#entries` 不随 stop 删除，长期频繁 start/stop 会保留 entry；与本次两缺陷无关，已在「剩余风险」登记。

### TEST-INFRA 新套件自身的 tmpdir 清理缺陷（已修）

- 症状：前几轮运行后 `%TEMP%` 残留 47 个 `ano m17 stability *` 目录（`.ano/cache/views.db` 仍在）。
- 根因：实测 `node:test` 的 `t.after` 按**注册顺序（FIFO）**执行，而本文件先注册 `rm(root)`、后注册 `ledger.close()`，导致 sqlite 仍持有 views.db 时unlink（EBUSY）；且 `removeTree` 重试耗尽后静默返回，把失败藏成泄漏。
- 修法（仅测试文件）：close hook 先注册、rm 后注册；`removeTree` 8 次重试后抛出最后一个错误，泄漏不再静默。
- 复验：清理旧残留后连续运行，`residualTmpDirs=0`、套件内所有断言绿。

## 三、新增测试覆盖的红队类别

| # | 用例 | 红队类别 |
|---|---|---|
| 1 | 重复运行压力：崩溃重启副本三次迭代行为一致 | 进程崩溃/重启、cursor 恢复、重复运行一致性、PID 差集 |
| 2 | 进程竞态：同一 handle 并发 restart 只启动一个替换进程 | 进程竞态（DEF-1 回归） |
| 3 | 重复运行压力：TCP 关闭竞态三次迭代收敛一致 | close/request 竞态、端口释放、重复运行一致性 |
| 4 | 重复运行压力：HA 分区恢复三次迭代行为一致 | 分区/恢复、epoch/term 演进、rejoin、resourceStats 归零 |
| 5 | 重复运行压力：TCP 故障代理断链重连三次迭代收敛一致 | 断链、重连/链路重建、listener 端口释放 |
| 6 | 时序红队：恶意超时风暴与取消后连接存活且定时器归零 | 并发超时风暴、pre/mid-flight 取消、Timer 资源回收 |
| 7 | 时序红队：迟到响应洪泛不崩不泄漏且相关不错位 | 已结算请求的迟到帧/重复帧/错 kind/未知 id 洪泛 |
| 8 | 时序红队：乱序与重复响应按 id 相关且不串档 | 乱序到达、重复响应、id 相关不错位 |
| 9 | 伪造 epoch/term 提交被 fencing 拒绝且投票洪泛后声明表有界 | 伪造 epoch/term 提交、投票/心跳洪泛、内存有界（DEF-2 回归） |
| 10 | 时序红队：慢节点 deadline 边界收敛且不悬挂 | 整体预算 vs 节点预算边界、abort、Timer 回收 |
| 11 | 非法帧：零长度/超帧/非 JSON/缺字段连续注入后监听存活 | 非法帧连续注入、listener/控制连接存活 |
| 12 | 资源泄漏总闸：混合负载后连接、定时器与 PID 均归零 | 连接/定时器/PID/句柄综合泄漏闸 |

设计纪律：注入 sleep ≤200ms；状态/进程收敛等待上限 500ms；每节 `activeConnectionCount===0`、HA `resourceStats` 全零、`process.kill(pid,0)` ESRCH 差集为空、`process.getActiveResourcesInfo()` 的 Timeout 计数不高于基线；tmpdir 全部 `t.after` 清理。测试级 `{ timeout: 120_000 }`。

## 四、关键文件 3 连跑（真实命令）

命令（循环）：`for f in <files>; do for i in 1 2 3; do node --test --test-timeout=60000 "$f"; done; done`

| 文件 | RUN1 | RUN2 | RUN3 | tests/pass/fail/skip |
|---|---|---|---|---|
| test/integration/replica-process.test.ts | 9719.15ms | 9609.87ms | 9474.74ms | 11/11/0/0 |
| test/integration/replica-transport-faults.test.ts | 1516.66ms | 1586.86ms | 1501.82ms | 19/19/0/0 |
| test/integration/tcp-transport.test.ts | 562.59ms | 606.16ms | 569.46ms | 13/13/0/0 |
| test/integration/tcp-connection-lifecycle.test.ts | 1360.93ms | 1370.88ms | 1458.36ms | 31/31/0/0 |
| test/integration/tcp-fault-proxy.test.ts | 4477.60ms | 4338.49ms | 4358.43ms | 13/13/0/0 |
| test/integration/ha-split-brain.test.ts | 18661.03ms | 18627.26ms | 18659.01ms | 9/9/0/0 |
| test/unit/leader-lease.test.ts | 229.88ms | 209.32ms | 230.26ms | 25/25/0/0 |
| test/unit/leader-lease-faults.test.ts | 230.05ms | 225.20ms | 226.00ms | 4/4/0/0 |
| test/unit/distributed-probe.test.ts | 937.70ms | 932.08ms | 941.51ms | 35/35/0/0 |
| test/redteam/tcp-transport-boundary.test.ts | 904.30ms | 852.47ms | 945.49ms | 36/36/0/0 |

波动：ha-split-brain 三次极差 33.8ms（0.18%），replica-process 极差 244ms（2.5%），均由真实 TCP/进程调度噪声引起，无失败、无 skip，行为断言逐次一致。

## 五、新稳定性套件复跑（最终代码）

| 运行 | 结果 | 时长 | 墙钟 | 退出方式 |
|---|---|---|---|---|
| FINAL 1 | 12/12 pass | 8416.08ms | 9s | 自然退出 rc=0 |
| FINAL 2 | 12/12 pass | 8148.50ms | 8s | 自然退出 rc=0 |
| SAMPLE 4 | 12/12 pass | 8405.13ms | ~9s | 自然退出 rc=0 |

同代码另有 5 次运行（8194.84 / 8380.05 / 8364.13 / 8701.98 / 8144.71 ms）全绿，合计 8 次；更早的 5 连跑（8.80-9.56s，全绿）为定稿前版本。墙钟 ≈ 测试时长 + 0.3-0.7s（Node 启动/runner 收尾），无 `--test-force-exit`，说明事件循环即时排空。

## 六、泄漏检查结论

| 维度 | 方法 | 结论 |
|---|---|---|
| 进程 PID | 套件内记录每个 start/restart 的 pid，结束用 `process.kill(pid,0)`（ESRCH）断言；DEF-1 用例显式断言原/新 pid 均消亡 | 0 幸存 |
| socket/连接 | 每节 `TcpReplicaClient/TcpReplicaServer.activeConnectionCount===0`；HA `resourceStats()` 全零；代理/服务端 listener 关闭后重绑同端口成功 | 0 泄漏 |
| 定时器 | `process.getActiveResourcesInfo()` 过滤 `Timeout`，超时风暴/取消/慢节点后计数 ≤ 基线 | 0 遗留 |
| tmpdir | 所有 `mkdtemp` 目录经 `removeTree`（EBUSY 重试后抛出）在 `t.after` 清理；运行后 PowerShell 清点 `%TEMP%` | `residualTmpDirs=0` |
| 进程句柄 | PowerShell 对运行中 node 采样（CIM 定位）：maxHandles=633、进程持有 TCP 连接峰值 36（尾部窗口 6 个样本，含子进程活动期） | 运行后 `residualNodeProcesses=0`，主进程自然退出 |
| 事件循环退出 | 墙钟 − 测试时长 ≈ 启动开销，rc=0 自然退出 | 即时 |

> 句柄/连接采样是在套件后段捕获的粗粒度快照（PowerShell 启动延迟约 1-2s）；精确的连接与定时器归零证据来自测试内逐节断言（可重复、确定性）。

## 七、偶发 skip 排查

- 全量 TAP：`# skipped 1`，唯一 skip 为既有环境条件分支 `test/unit/fingerprint.test.ts:143`（`filesystem does not enforce read permission in this environment`，Windows 不强制读权限触发）。
- symlink 相关条件 skip（`takeover-boundary`/`project-scan-boundary`/`client-adapters-boundary`/`surface-release`）在本机可创建符号链接，未触发；git 可用，`ledger-store` 的 git skip 未触发。
- 新增 `test/redteam/m17-stability.test.ts` 0 skip；既有 spike 机制（`scripts/run-tests.ts` 在无 scripts/node_modules 时打印 SKIP）不在本次直接命令范围内。**无新增 skip。**

## 八、五条验证输出摘要

1. `node --test test/redteam/m17-stability.test.ts` → **12/12 pass，0 fail，0 skip，rc=0**（最终代码 8 次运行 8.14-8.70s）。
2. 关键 10 文件 ×3 → **30/30 rc=0**，全绿（见第四节表格）。
3. `node --test --experimental-test-coverage test/**/*.test.ts` → **exit 0**（墙钟 61s，报告时长 52718.44ms）；tests 1649 / pass 1648 / fail 0 / skipped 1（既有指纹权限条件 skip）。关键模块：`leader-lease.ts` 100.00 行 / 93.87 分支，`replica-transport.ts` 98.97 / 91.25，`tcp-transport.ts` 96.96 / 90.39，`ha-cluster.ts` 97.97 / 86.95，`distributed-probe.ts` 93.07 / 94.48。
4. `npx tsc -p tsconfig.json --noEmit` → **exit 0**。
5. 泄漏复核 → 进程即时退出（墙钟−时长 <1s，无 force-exit）、PID 差集为空、Timeout 计数不增、句柄采样 maxHandles=633 / TCP 峰值 36 且运行后残留 node 进程 0、tmpdir 0。

## 九、剩余风险

1. **时序用例对环境负载敏感**：`ha-split-brain`（真实 3 节点 TCP，约 18.6s）、`tcp-fault-proxy`（约 4.4s）、崩溃重启（约 9.6s）在 CI 高负载下可能先超时而非泄漏；建议 CI 连续多次运行并以「失败即调查」处理。
2. **进程回收窗口 500ms**：Windows 极端负载下若 pid 回收超过 500ms，测试会以超时失败暴露（有界设计使然），需区分调度延迟与真实泄漏。
3. **`#entries` 既有增长**：transport 每次 start 保留 entry（含 stderr/cache），长期高频启停需另行治理；本次未改（避免触碰 stale-handle 既有断言语义）。
4. **本地回环边界**：HA/TCP 红队是协议层与 loopback 真实套接字，不等价 OS 防火墙分区/物理三机；生产跨机行为仍未验证。
5. **leader 声明上限的极端兜底**：当洪泛全部由「每组两个 leader」构成且超过上限时，最旧冲突组会被淘汰（内存 bound 优先）；正常与常见攻击规模（<256 组）不受影响。
