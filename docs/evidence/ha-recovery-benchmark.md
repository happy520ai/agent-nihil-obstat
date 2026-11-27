# 本地高可用 / RTO/RPO 与恢复压力基准（T-141 / HA-09）

- 生成时间：2026-11-25T03:53:56.119Z
- 命令：`node scripts/benchmark-ha-recovery.ts --scale smoke --seed 202611125`
- 环境：node v24.14.0 / win32 x64 10.0.19041 / 12th Gen Intel(R) Core(TM) i7-12700KF x20
- 验证范围：`local-tcp-protocol-only`（本地 TCP + 协议层故障注入；≠ OS 真分区）
- 硬边界：本地 loopback TCP 实测，**非物理三机、非生产 HA、非生产 SLA**。

## 1. 方法学

- 复用面：`HaCluster`（T-139）真实 3 节点 loopback TCP 集群；每个节点含真实 `HaTcpServer`、冻结 `TcpReplicaServer` 与真实 `HaTcpClient`，选举/提案/同步帧走 `TcpFaultProxy`。不新造传输、不改契约。
- 故障模型：`isolate(groups)` 重建每条有向链路并对被隔离方向注入 `drop probability=1`，是真实套接字级断链；单进程内节点对象存活，因此这不是 OS 进程 SIGKILL（见限制）。
- 稳定提交负载：提案循环持续运行，跨越故障注入边界；每次尝试记录墙钟延迟、成功/拒绝与错误码。
- 确定性：事件字节由 `(seed, seq)` 决定；同一种子重放得到同一提交集合。时序数字本身随机器负载波动。
- 规模预算（smoke / S）：正常提交 / 切换后提交 / follower 故障窗 / rejoin 故障窗 / 反复恢复周期×每周期 / 负载正常+故障 = 24/8/12/10/3x2+3/24+12 与 80/24/20/16/4x3+6/80+20。
- 指标口径（写死在 JSON `definitions` 中）：
  - RTO：RTO = 故障注入生效（isolate 完成、链路真实切断）到故障后首次成功提交返回的墙钟时间差；包含基准驱动的重新选举与切换期的失败尝试。本集群无自动故障转移守护进程，故该值不代表自治故障切换 SLA。
  - RPO：RPO = 故障窗口内被拒绝、且到基准结束时仍未被任何节点日志提交的提案数（未获确认写入的丢失代理）；另报 committedMissingAfterRecovery（已提交条目在恢复节点上仍缺失数）。多数派提交不依赖单一副本，follower 故障/rejoin 场景预期为 0。
  - 可用性/错误率：可用性中断 = 故障窗内出现提交拒绝或零提交；错误率 = 拒绝提案数 / 提案尝试数。拒绝是显式失败（QUORUM_NOT_REACHED/FENCE_*），不是静默丢失。
  - 恢复耗时：恢复耗时 = 对应恢复动作的墙钟时间：追平耗时=rejoin() 调用时长（从对等节点拉取已提交记录）；隔离耗时=isolate() 重建全部有向链路时长（不计入 RTO）。

## 2. 本机实测总表

| 场景 | 核心结果 |
|---|---|
| a. leader failover | RTO=2050.058 ms；切换期尝试 2 / 拒绝 1 / 拒绝率 0.5；新主 n2（term 1→2）；旧主追平 9.985 ms，日志一致=true；RPO(未确认丢失)=1 |
| b. follower crash | 可用性中断=false；故障窗提交 12 / 拒绝 0；吞吐比(故障/正常)=0.0017；复制失败累计=12；恢复+追平 13.247 ms |
| c. rejoin catch-up | 落后 commitIndex=10；追平耗时=4.559 ms；ingested/duplicates/conflicts=10/4/0；RPO=0；投影一致=true |
| d. 反复恢复 | 周期=3；最终提交=9；完整性(对无故障基线)=true；close 后资源 open=0 |
| e. 负载 P95/P99 | 正常 p95/p99=2.306/2.998 ms，吞吐 700.196/s；故障窗 p95/p99=1023.727/1023.727 ms，吞吐 0.986/s |

## 3. 分项明细

### 3.1 leader failover（稳定负载下断链 leader）

- 故障模型：leader 全部进出链路经 TcpFaultProxy drop=1 真实断链（单进程内节点对象存活，非 OS SIGKILL）
- 隔离操作耗时 4.047 ms（不计入 RTO）；首次拒绝出现在故障后 508.372 ms；重新选举耗时 503.603 ms。
- RTO=2050.058 ms（故障生效→首次成功提交）。
- 阶段指标（attempts/committed/rejected/errorRate/durationMs/throughputPerSec/latency/commitLatency）：

| 阶段 | 尝试 | 提交 | 拒绝 | 错误率 | 时长 ms | 吞吐 /s | 全部延迟 | 提交延迟 |
|---|---|---|---|---|---|---|---|---|
| 正常 | 24 | 24 | 0 | 0 | 25.635 | 936.231 | p50 0.756 / p95 1.387 / p99 5.084 / max 5.084 / mean 0.974 ms（n=24） | p50 0.756 / p95 1.387 / p99 5.084 / max 5.084 / mean 0.974 ms（n=24） |
| 切换窗 | 2 | 1 | 1 | 0.5 | 2050.058 | 0.488 | p50 508.268 / p95 1022.345 / p99 1022.345 / max 1022.345 / mean 765.307 ms（n=2） | p50 1022.345 / p95 1022.345 / p99 1022.345 / max 1022.345 / mean 1022.345 ms（n=1） |
| 切换后 | 7 | 7 | 0 | 0 | 7232.621 | 0.968 | p50 1012.815 / p95 1024.583 / p99 1024.583 / max 1024.583 / mean 1015.271 ms（n=7） | p50 1012.815 / p95 1024.583 / p99 1024.583 / max 1024.583 / mean 1015.271 ms（n=7） |

- 切换期拒绝错误码：{"QUORUM_NOT_REACHED":1}。切换窗内那次被拒绝的提案不会被自动重试；它计入 RPO（未确认丢失）=1。
- 切换后阶段仍指向被隔离的旧主 n1：提案与复制请求都要等它的链路超时（各 500ms），故 p95≈1000ms 量级属本次实现代价，不是新主不可用。

### 3.2 follower crash（多数派仍在）

- 故障模型：follower 全部进出链路真实断链；多数派 n1+n2 仍可达，提交应无中断
- 多数派可提交=true；可用性中断=false；故障窗错误率=0（拒绝码 {}）。

| 阶段 | 尝试 | 提交 | 拒绝 | 错误率 | 时长 ms | 吞吐 /s | 全部延迟 | 提交延迟 |
|---|---|---|---|---|---|---|---|---|
| 正常 | 24 | 24 | 0 | 0 | 41.184 | 582.746 | p50 1.562 / p95 2.347 / p99 2.654 / max 2.654 / mean 1.657 ms（n=24） | p50 1.562 / p95 2.347 / p99 2.654 / max 2.654 / mean 1.657 ms（n=24） |
| follower 故障 | 12 | 12 | 0 | 0 | 12241.67 | 0.98 | p50 1018.477 / p95 1030.202 / p99 1030.202 / max 1030.202 / mean 1020.013 ms（n=12） | p50 1018.477 / p95 1030.202 / p99 1030.202 / max 1030.202 / mean 1020.013 ms（n=12） |

- 恢复+追平耗时 13.247 ms；追平后各节点日志一致=true。

### 3.3 rejoin catch-up（恢复追平与 RPO 代理）

- 故障模型：follower n2 断链后恢复；多数派提交不依赖该副本，RPO 预期为 0
- 故障前已提交 4；故障窗提交 10；恢复后累计 14。
- 追平前落后 commitIndex=10；restore 4.866 ms；rejoin 4.559 ms；records seen/applied=14/14；ingested/duplicates/conflicts=10/4/0。
- manager rejoined/caught_up=false/false（leader epoch 未变时租约不更新，追平以日志一致为准）；日志一致=true；投影指纹一致=true（基线 bf3b4f55651a0b7e…165ecc8e / 实际 bf3b4f55651a0b7e…165ecc8e）。
- RPO（未确认丢失）=0；已提交但恢复节点缺失=0。

### 3.4 反复 kill/restore（完整性与资源）

- 故障模型：同一下属节点反复「断链→恢复→追平」；提交由多数派 n1+n3 完成
- 基线指纹 45562a3b8bf0c7f9…ccc512ce / 最终指纹 45562a3b8bf0c7f9…ccc512ce；integrityEqual=true。

| 周期 | 隔离 ms | 恢复 ms | 追平 ms | 追平前落后 | 日志一致 | 累计提交 |
|---|---|---|---|---|---|---|
| 1 | 4.814 | 4.596 | 2.23 | 2 | true | 5 |
| 2 | 4.98 | 4.453 | 2.237 | 2 | true | 7 |
| 3 | 4.762 | 5.677 | 2.772 | 2 | true | 9 |

- close 前资源：{"active_connections":12,"clients_open":3,"ha_servers_open":3,"nodes_open":3,"proxies_open":6,"replica_servers_open":3}
- close 后资源：{"active_connections":0,"clients_open":0,"ha_servers_open":0,"nodes_open":0,"proxies_open":0,"replica_servers_open":0}（noLeak=true）；无故障基线 close 干净=true。

### 3.5 负载下 P95/P99 与吞吐（正常 vs 故障注入）

- 故障模型：注入期内隔离 follower n3；提交路径会等待失效副本的复制请求至超时，故延迟含一次请求超时

| 阶段 | 尝试 | 提交 | 拒绝 | 错误率 | 时长 ms | 吞吐 /s | 全部延迟 | 提交延迟 |
|---|---|---|---|---|---|---|---|---|
| 正常 | 24 | 24 | 0 | 0 | 34.276 | 700.196 | p50 1.255 / p95 2.306 / p99 2.998 / max 2.998 / mean 1.379 ms（n=24） | p50 1.255 / p95 2.306 / p99 2.998 / max 2.998 / mean 1.379 ms（n=24） |
| 故障注入 | 12 | 12 | 0 | 0 | 12166.648 | 0.986 | p50 1012.989 / p95 1023.727 / p99 1023.727 / max 1023.727 / mean 1013.768 ms（n=12） | p50 1012.989 / p95 1023.727 / p99 1023.727 / max 1023.727 / mean 1013.768 ms（n=12） |

- Δp95=1021.421 ms；Δp99=1020.729 ms；Δmean=1012.389 ms；吞吐比=0.0014。

## 4. 完整性与资源泄漏断言

| 断言 | 结果 | 明细 |
|---|---|---|
| leader-failover-recovers-with-measurable-rto | PASS | RTO=2050.058ms；切换期拒绝率=0.5 |
| follower-crash-majority-keeps-committing | PASS | 故障窗提交=12 拒绝=0 |
| rejoin-catch-up-rpo-zero-and-projection-equal | PASS | 落后 commitIndex=10 RPO=0 投影一致=true |
| repeated-recovery-integrity-equals-baseline | PASS | cycles=3 最终提交=9 |
| no-resource-leak-after-close | PASS | 循环集群 close 后 open=0（各场景集群均已 close） |
| all-metrics-finite | PASS | RTO/RPO/恢复耗时/吞吐/P95/P99 均为有限数字 |

## 5. 实测结论（只陈述本次运行事实）

- leader 断链后可恢复提交，本次实测 RTO=2050.058 ms，切换期提交拒绝率=0.5（1/2）；旧主恢复后不覆盖新主日志（一致=true）。
- follower 断链且多数派仍在时，故障窗提交 12 笔、拒绝 0 笔，可用性中断=false；代价是每笔提交多等一次失效副本超时（提交延迟 p95 2.347→1030.202 ms，吞吐 582.746→0.98/s）。
- 恢复追平耗时 4.559 ms（落后 10 个提交），RPO=0，追平后投影与期望指纹一致=true。
- 反复 3 次 kill/restore 后最终投影与无故障基线一致=true；close 后 open 资源计数=0，无泄漏=true。
- 以上均为本地 loopback 单机实测，不外推物理三机、OS 真分区或生产 SLA。

## 6. 限制与未验证边界

- 本地 loopback TCP 实测：三节点均为同一测试进程内的真实 node:net 端点与 TcpReplicaServer，帧经真实 TCP 往返；不可外推物理三机部署、跨机带宽/丢包或生产 HA。
- 节点故障以链路级 drop 注入模拟（TcpFaultProxy 协议层故障注入 ≠ OS 真分区）；未做 OS 进程 SIGKILL、内核协议栈故障、防火墙规则或物理链路中断。
- 跨机时钟回拨、时钟偏移补偿与物理机房间的网络分区均未验证；本基准使用注入时钟且不参与版本排序。
- 不承诺生产 SLA：RTO/RPO 只描述本次本机运行，真实生产延迟、真实故障检测时间与真实写入分布为 [数据缺失]。
- 切换期提交路径会等待失效副本的请求直到 requestTimeoutMs（本基准 500ms），因此故障窗延迟/吞吐包含该超时，不是异步复制的生产表现。
- 无自动故障转移守护进程：RTO 含基准驱动的 elect() 调用；真实编排系统的检测与触发时延未测量。
- P95/P99 样本量受 smoke/S 规模限制，尾延迟统计仅作数量级参考。
