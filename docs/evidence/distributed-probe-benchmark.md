# 分布式探针对照基准（T-131 / M15）

- 生成时间：2026-11-24T10:53:29.229Z
- 命令：`node scripts/benchmark-distributed-probe.ts --scale M --seed 20261122`
- 环境：node v24.14.0 / win32 x64 10.0.19041 / 12th Gen Intel(R) Core(TM) i7-12700KF x20
- 夹具：1000 事件（memory.revised 213 / note.recorded 607 / memory.related 180），受治理事实 120，冲突事实 2；viewDigest=cd0eaba00dd17697…
- 同语义门：fixture 可复现=true / 三后端候选一致=true / COMMITTED==本地=true / QUORUM==本地=true / 降级非 COMPLETE=true / 降级 failed_nodes=true

## 1. 方法学

- 同证据：所有臂共用 `buildFixture(scale, seed)` 产出的同一 `ViewReplayEntry[]`、同一 snapshot、同一预算、同一查询集；因此差异只可能来自执行路径，不可能来自数据版本。
- 同版本：副本由主侧已提交事件构造 `CommittedEventEnvelope`（`committedEnvelopeFromEvent`，与 `exportCommittedEvents` 同一字节口径）复制，并在测量前等待 `commitIndex` 追平且 `viewDigest` 相等。
- 复制/重建单独计时：副本启动 + 分批 apply + 追平的耗时计入 `rebuildMs`（replication.setupMs），不混入查询延迟；磁盘字节单独统计。
- 冷热分组：每条臂的第一次查询单列为 `coldStartMs`；P50/P95/P99/max 取其余热态样本。
- 故障分组：`distributed-degraded` 单独成组——SIGKILL 掉 2 个真实子进程中的 1 个后重跑同一 QUORUM 请求集；答案必须标注 degraded/partial 且 failed_nodes 非空，明确非 COMPLETE。
- 等价性写进运行：COMMITTED 与 QUORUM 的候选集合按规范序与本地投影逐一比对，不一致即判失败（见 JSON `equivalence.mismatches`）。

## 2. 副本复制与重建成本

| 项 | 值 |
|---|---|
| 复制+追平总耗时 ms | 659.707 |
| 追平等待耗时 ms | 205.112 |
| 复制事件数 | 1000 |
| 副本目录磁盘字节 | 1132244 |
| 副本 bench-replica-a pid 27856 | 磁盘 566122 B / 停止后存活=false |
| 副本 bench-replica-b pid 9260 | 磁盘 566122 B / 停止后存活=false |

## 3. 主对照表（热态查询延迟，单位 ms；质量对夹具真值）

| 臂 | 模式 | 请求/迭代 | P50 | P95 | P99 | 最大尾 | 冷启动首查 | 召回 | 正确合并 | 冲突 | 陈旧 | 失败率 | heapUsedΔ B | RSSΔ B | 重建 ms | 磁盘 B |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| local-projected | LOCAL-PROJECTED | 2/12 | 20.705 | 26.481 | 26.899 | 26.899 | 23.178 | 1 | 1 | 2 | 0 | 0 | 41033168 | 51204096 | 114.861 | 0 |
| sqlite | SQLITE | 2/12 | 3.082 | 4.995 | 5.654 | 5.654 | 4.411 | 1 | 1 | 2 | 0 | 0 | -5328448 | 4919296 | 200.44 | 2957312 |
| bitchain | BITCHAIN | 2/12 | 0.322 | 0.751 | 4.633 | 4.633 | 1.459 | 1 | 1 | 2 | 0 | 0 | -29052840 | 3825664 | 128.261 | 622356 |
| distributed-committed | COMMITTED | 2/12 | 52.36 | 64.47 | 64.728 | 64.728 | 70.762 | 1 | 1 | 2 | 0 | 0 | 8066312 | 72011776 | 659.707 | 1132244 |
| distributed-quorum | QUORUM | 2/12 | 50.764 | 56.083 | 68.781 | 68.781 | 54.479 | 1 | 1 | 2 | 0 | 0 | 46378544 | 18907136 | 659.707 | 1132244 |
| distributed-degraded | QUORUM | 2/12 | 41.997 | 44.547 | 45.3 | 45.3 | 42.63 | 1 | 1 | 2 | 0 | 0 | -2641896 | 26853376 | 659.707 | 1132244 |

说明：`local-projected`/`sqlite`/`bitchain` 的 `mode` 列是其存储后端标识，不是分布式检索模式；三者都以本地 `probe()` 作答。`distributed-*` 的 P50/P95/P99 含父进程 scatter/gather 与真实子进程 IPC。

## 4. 降级臂明细（单独成组）

- degraded=true / consistency=PARTIAL / retrieval_completeness=PARTIAL / failed_nodes=1
- 该次检索完整性按夹具可能是 COMPLETE 或 PARTIAL；无论哪种，分布式一致性声明都是 `PARTIAL` 且 `degraded=true`，因此整体不得读作集群 COMPLETE。
- 热态延迟：p50 41.997 / p95 44.547 / p99 45.3 / max 45.3；失败率 0
- 该臂只证明「副本缺失时答案显式降级且不伪造 COMPLETE」，不证明可用性或恢复时间目标。

## 5. 等价性与断言

- 候选集合计数：{"bitchain":790,"committed":790,"local":790,"quorum":790,"sqlite":790}
- 全部等价性断言通过：fixture 可复现、三后端候选一致、COMMITTED/QUORUM 候选与本地完全一致、降级臂非 COMPLETE 且 failed_nodes 非空。

## 6. 实测结论（只陈述本次运行事实与趋势）

- 同语义成立：fixture 可复现、三后端候选集合一致、COMMITTED/QUORUM 候选集合按规范序与本地投影完全一致（计数 790）。
- 热态 P50：distributed-committed 52.36 ms（2.53x）/ distributed-quorum 50.764 ms（2.45x），本地投影基线 20.705 ms，SQLite 3.082 ms，BitChain 0.322 ms。单机本地 IPC 下分布式协调成本高于直接读本地投影/缓存，本次未观察到提速。
- 尾延迟：distributed-committed p99=64.728 / max=64.728 ms；distributed-quorum p99=68.781 / max=68.781 ms；本地投影 p99=26.899 / max=26.899 ms。
- 质量：各臂召回与正确合并均为 1，冲突数 2（等于夹具冲突事实数），陈旧 0，失败率均为 0。
- 复制成本：1000 个已提交事件复制到 2 个真实子进程并追平耗时 659.707 ms，副本磁盘 1132244 B。
- 降级事实：杀 1/2 副本后答案仍返回，但 degraded=true、consistency=PARTIAL、failed_nodes=1，未冒充 COMPLETE。

## 7. 限制与未验证边界

- 单机本地进程实测：副本是同一台机器上的子进程，走 stdio，不是真网络；不可外推跨机带宽/丢包收益。
- 未验证真分区、脑裂、跨机时钟回拨与生产高可用；副本传输接口保留给未来实现。
- 不承诺十倍、线性扩展或任何跨机加速；QUORUM 的多数派在本机 IPC 下只会增加协调成本。
- 真实生产延迟与真实查询分布为 [数据缺失]；夹具查询集只有 2 条请求，尾延迟统计样本有限。
- RSS/heapUsed 差值未强制 GC，是 Node 进程观测值，噪声大，仅作数量级参考。
- 冷启动首查包含首次 JIT/IPC/缓存建立；热态统计不含第一次调用。
