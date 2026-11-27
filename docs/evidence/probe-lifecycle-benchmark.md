# 分布式探针资源优化同语义对照（T-160 / MNT-04）

生成时间：2026-11-26T01:37:36.517Z · 平台：win32/x64 · Node v24.14.0

方法：同一进程内使用相同的内存 `ProbeStore`、相同请求与提交点；baseline 关闭提前冻结并使用宽松上限，optimized 使用 T-157 默认早冻结与上限。每个样本都是本机墙钟，不包含跨机网络，不代表生产 SLA。

## 1. 同语义校验

| 校验项 | 结果 |
|---|---|
| fast-consistent 两臂 evidence_digest/candidates/commit/mode/consistency 完全一致 | PASS |
| baseline 慢尾样本确实等待 200ms 节点（p50 >= 150ms） | PASS |
| optimized 慢尾样本提前冻结（p50 <= 120ms） | PASS |
| 并发上限生效（global <= 2, per-node <= 1） | PASS |

## 2. 延迟与吞吐（毫秒；P50 | P95 | P99 | Max）

| 场景 | 臂 | 样本 | P50 | P95 | P99 | Max | 吞吐/秒 | heap Δ (MiB) |
|---|---|---|---|---|---|---|---|---|
| fast-consistent | baseline | 30 | 15.84 | 16.25 | 16.36 | 16.36 | 65.8 | 2.43 |
| fast-consistent | optimized | 30 | 15.12 | 16.16 | 16.21 | 16.21 | 64.96 | -1.48 |
| slow-tail (late nodes last=0) | baseline | 8 | 203.78 | 216.28 | 216.28 | 216.28 | 4.83 | 1.22 |
| slow-tail (late nodes last=1) | optimized | 8 | 15.76 | 16.03 | 16.03 | 16.03 | 64 | 1 |
| 4 concurrent probes x 6 nodes | baseline | 5 | 15.66 | 16.19 | 16.19 | 16.19 | 256.74 | -1.27 |
| 4 concurrent probes x 6 nodes | optimized | 5 | 126.26 | 126.72 | 126.72 | 126.72 | 31.84 | -1.02 |

## 3. 并发峰值与慢节点尾延迟

- 并发上限臂：global peak=2，per-node peak=1；baseline global peak=24。
- 慢节点（200ms）尾延迟：baseline P50=203.78ms / P99=216.28ms；optimized P50=15.76ms / P99=16.03ms。
- 快路径（全部 3–4ms）吞吐：baseline 65.8/s，optimized 64.96/s；差异包含提前冻结少等一个节点与上限开销两方向，样本有限，不作容量承诺。

## 4. 边界（不得外推）

- 仅内存 store，无线程/子进程/TCP；测量的是协调器调度与冻结收益，不是跨机带宽或副本 I/O。
- 延迟样本来自本机单进程，未固定 CPU 频率/隔离核，也未强制 GC；heap Δ 只是数量级参考。
- Windows 默认定时器粒度约 15.6ms，3–5ms 的模拟延迟会被量化到约 15ms；因此快路径绝对值不代表真实跨机 RTT，慢尾对照（200ms vs 冻结）仍是有效信号。
- 并发上限以吞吐换有界负载：上限臂每个批次串行 24 个节点查询，吞吐低于不受限臂是预期结果，不是性能回退。
- 提前冻结只对 COMMITTED/QUORUM 生效；QUORUM 只在 primary commit 的唯一多数派组上冻结，低提交点仍完整 gather；AS_OF 不冻结。
- 迟到结果标记 `LATE_DISCARDED` 且不进入证据；这不是“忽略故障”，而是显式丢弃并保留节点报告。
- 上限是有界队列加拒绝，不是动态负载均衡/EWMA/线程池；没有生产 SLA、跨机或自动故障切换声明。

