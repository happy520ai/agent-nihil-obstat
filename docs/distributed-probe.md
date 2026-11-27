# 分布式探针实现者参考

任务：T-123 / DC-01（M15）；收口：T-132 / DC-10（M15）
契约来源：[ADR-011](adr/ADR-011-distributed-probe.md)
范围：单主写入、只读副本复制、LOCAL/AS_OF/COMMITTED/QUORUM、异步 scatter/gather、降级与复核、安全与兼容。
读者：T-124~T-132 实现者。

> 本文是 ADR-011 的实现者参考，只给术语、判定表、时序、配置、可执行判据与文件所有权；授权与边界论证以 ADR-011 为准。冲突处一律以 ADR-011 为准。

## 1. 术语表

| 术语 | 定义 | 关键不变量 |
|---|---|---|
| **primary（主写）** | 唯一持有权威账本写权限的 `Ledger`；`<root>/.ano/ledger` | 一个部署恰好一个活跃 primary；只有它能 append |
| **replica（只读副本）** | 独立本地进程 + 独立存储路径 `<root>/.ano/replicas/<replicaId>/`，从 primary 拉取已提交事件并重建只读视图 | 永不写主账本；派生数据可删可重建 |
| **commit point（提交点）** | `(commit_index, view_digest)`；`commit_index` = 事件在 primary 规范序中的 1-based 序号，`view_digest = viewDigest(entries)` | 同提交点必同摘要；可重算 |
| **cursor（游标）** | 副本持久化的 `{cluster_epoch, commit_index, last_event_id, last_hash}` | 单调；重启后从 cursor 续传 |
| **quorum（多数派）** | `Q = ceil((N+1)/2)` 个副本达到同一提交点且 `evidence_digest` 相同 | N≥2；Q 由注册副本数计算 |
| **partial（部分）** | 结论覆盖不完全：有 failed/lagging/gap/conflict 但仍返回已完成部分 | 必须带覆盖度、缺口、停止原因 |
| **cluster_epoch** | 成员/主身份变化时由 primary 递增的不透明标识 | epoch 不等即不可混用证据 |
| **evidence_digest** | 有界候选指纹集的 sha256；用于 QUORUM 比对 | 不含自由文本；确定性排序 |
| **current_snapshot** | 本地或主写重新采样的四摘要快照（`ledger_digest`/`graph_revision`/`source_fingerprint`/`connected_digest`） | 只有本地/主写采样可作当前执行依据 |
| **remote evidence（远程证据）** | 副本返回的任何字节与结论 | 不可信、不可执行、不直接进 Gate |

正交提醒：`retrieval_consistency_mode ∈ {LOCAL, AS_OF, COMMITTED, QUORUM}`（本 ADR）与既有 `temporal_mode ∈ {CURRENT, AS_OF, HISTORICAL}`（`probe-contract.ts`）是两套字段，不得复用同名。

## 2. 四种检索模式判定表

设 `N`=注册副本数，`Q=ceil((N+1)/2)`，`C`=primary 当前 `commit_index`；副本 `r=(commit_index_r, evidence_digest_r, state_r)`。

| 模式 | 输入 | 判定条件 | 证据来源 | 成功返回 | 失败返回 |
|---|---|---|---|---|---|
| `LOCAL` | 本地 store | 本地快照可读且 probe 未降级 | `local` | `CONSISTENT`（限本地声明范围） | `PARTIAL`/`UNKNOWN`，`failed_nodes=['local']` |
| `AS_OF` | 目标提交点 `C*`（或由快照时间映射） | ∃r: `commit_index_r >= C*` 且 `view_digest_r(C*) == primary.view_digest(C*)` | `primary` + `replica` | `CONSISTENT @ C*` | `UNKNOWN`/`PARTIAL`（lag/digest 失配） |
| `COMMITTED` | 当前提交点 `C` | primary 已提交 C，且 ≥1 个 r 满足 `commit_index_r >= C` 且摘要一致 | `primary` + ≥1 `replica` | `CONSISTENT @ C` | `PARTIAL`，`stop_reason=QUORUM_UNMET` |
| `QUORUM` | 当前提交点 `C` | ∃ `Cq <= C`：≥Q 个 r 满足 `commit_index_r == Cq` 且 `evidence_digest_r` 全等 | ≥Q `replica` + primary 上界 | `CONSISTENT @ Cq`（注明 Cq 可能 < C） | `PARTIAL`，列 `failed_nodes`/冲突 |

补充规则：

- 互斥：一次查询只按请求的模式判定，不用低模式结果冒充高模式（QUORUM 不达标可显式降级为 COMMITTED/LOCAL，但必须标注）。
- 混合禁止：单条结论 `evidence_origin` 唯一；本地与远程证据交叉验证分两步做。
- 未知：任一必需输入缺失 → `UNKNOWN`，不得用 0/空值伪造 `CONSISTENT`。
- 历史隔离：AS_OF 结论标记 `historical=true`，不得升级为当前执行依据。

## 3. scatter / gather 时序图（文本）

### 3.1 正常路径（QUORUM）

```
coordinator                 replica-A        replica-B        primary
     |                          |                |               |
     |-- scatter(query, budget) ->|                |               |
     |--------------------------->|                |               |
     |                          |                |               |
     |<--- ReplicaQueryResponse(A: commit=10,digest=D) ---|        |
     |<--- ReplicaQueryResponse(B: commit=10,digest=D) ------->|   |
     |                          |                |               |
     |-- gather -------------   |                |               |
     |   dedup(record_ref,content_hash)            |               |
     |   quorum: count(commit=10 & digest=D) == 2 >= Q |           |
     |   conflicts: none         |                |               |
     |--> answer{mode=QUORUM, consistent@10, partial=false}        |
     |                          |                |               |
     |-- current_snapshot re-sample (local/primary only) -------->|
     |<--- snapshot matches frozen context -----------------------
     |--> 允许进入消费/Gate（Gate 仍需本地执行证据）
```

### 3.2 降级路径（副本失败）

```
coordinator                 replica-A        replica-B
     |                          |                |
     |-- scatter -------------->|                | (无响应/崩溃)
     |                          |                |
     | deadline 到期            |                |
     |<--- A: commit=8,digest=D1 (部分候选)         |
     |                          X                |
     |-- gather(仅 A)           |                |
     |   quorum(A only)=1 < Q    |                |
     |   mode=QUORUM 不达标 -> 显式降级 COMMITTED? 否(A lag)
     |   -> mode=LOCAL 降级到本地 ProbeStore     |
     |--> answer{mode=LOCAL, degraded=true,
                 failed_nodes=['replica-B'], partial=true,
                 stop_reason=NODE_UNAVAILABLE}
```

### 3.3 冲突路径（版本分歧）

```
coordinator                 replica-A        replica-B
     |                          |                |
     |-- scatter(query fact_key=F) --------------->|
     |<--- A: F -> rev5, hash=H5 ------------------|
     |<--- B: F -> rev4, hash=H4 ------------------|
     |                          |                |
     |-- gather                  |                |
     |   同 record_ref 不同 content_hash -> conflict(unresolved)
     |   不自动选最新           |                |
     |--> answer{mode=COMMITTED, consistency=PARTIAL,
                 conflicts=[{fact_key:F, refs:[A,B]}],
                 coverage_gate.status != SUFFICIENT}
```

### 3.4 取消路径

```
coordinator                 replica-A        replica-B
     |-- scatter -->|           |                |
     | abort 信号触发           |                |
     |-- cancel(targetId) 帧 -->|  worker 确认并停止该 id
     |  未确认且无其他在途请求时受控终止该子进程
     | 关闭子进程句柄（幂等 stop） |                |
     |--> answer{outcome=CANCELLED, completed=[],
                 resources_released=true}
     （副本侧无半边状态：应用是幂等的，未确认批次回滚）
```

取消现在是跨传输的 requestId 协议，而不只是丢弃本地 Promise：

- IPC：`cancel{targetId}` 由 worker 严格校验；重复取消幂等，未执行的 id 被预取消（之后到达也不会执行），已完成 id 回复 `reason=completed`；取消记忆有界（256）。
- TCP：`cancel` 是认证后的帧；服务端按连接维护在途 `AbortController`，取消即中止对应任务并回 ack；处理函数若迟到完成，服务端在发送成功响应前检查已中止状态并改发 `TCP_REQUEST_CANCELLED`。
- 客户端在 abort/超时后发送 cancel 帧，迟到响应因 pending 已移除而无法交付；`cancelGraceMs` 内未获确认时，只有在该连接/子进程已无其他在途请求时才受控关闭，绝不误杀无关请求。
- 重复取消不抛错、不破坏连接；取消后可继续使用同一连接或子进程（除非触发上述受控终止）。

### 3.5 并发上限、队列与提前冻结（T-157）

- 每个节点查询先经过进程级调度器：`maxConcurrentNodes`（全局在途，默认 64）、`maxInFlightPerNode`（同一 `replicaId`，默认 8）、`maxQueuedNodes`（FIFO 等待队列，默认 256）。调度器只做准入，不决定答案。
- 无空位时进入有界队列；队列满立即以 `DISTRIBUTED_PROBE_CAPACITY_EXCEEDED` 拒绝该节点（该节点按失败记录，不阻塞其他节点）。排队中被取消或超过节点预算的请求会释放队列位置。
- COMMITTED 在第一个 `commit_index >= primary` 且摘要等于 primary 的成功响应上冻结；QUORUM 在 `commit_index == primary` 的同一摘要组达到 `Q` 时冻结。`Q = ceil((N+1)/2) > N/2`，因此两个不同摘要组不可能同时达标，冻结结果与响应到达顺序无关。
- 冻结后立即组装答案；其余在途节点通过内部 AbortController 放弃并结算为 `LATE_DISCARDED`，不进入 candidates/conflicts/quorum_count/max_lag/一致性，也不计入 `failed_nodes`（节点报告保留该状态）。
- 低提交点的 quorum 不提前冻结，避免“更快但更旧”；AS_OF 没有 quorum 阈值，仍合并全部合格响应。未达标时保留原有超时/`QUORUM_UNMET` 降级语义。
- `earlyFreeze: false` 可回到完整 gather（对照/诊断臂）；两种路径都不改变提交、证据或 Gate 语义。

## 4. 失败与降级路径

| 场景 | 检测 | 行为 | 返回 |
|---|---|---|---|
| 副本进程崩溃 | 心跳/查询失败 | 剔除 scatter 集合，记 `failed_nodes` | `PARTIAL` + `NODE_UNAVAILABLE` |
| 副本滞后 | `lag>0` | 保留但标注；QUORUM/COMMITTED 可能不达标 | `LAGGING` + `max_lag` |
| 副本 gap | seq 不连续 | 缓冲并按需重 pull；不静默跳 | `PARTIAL` + `gaps[]` |
| 副本 hash/链失配 | `eventChain`/hash 校验失败 | 副本 `SUSPECT`，停止合并 | `SUSPECT` + `VIEW_DIGEST_MISMATCH` |
| 投影摘要失配 | `view_digest != primary` | 该副本不计入 quorum | `PARTIAL` |
| 版本分歧 | 同键不同 hash/version | 显式 conflict，不选最新 | `PARTIAL` + `conflicts` |
| 全部副本不可用 | 全部 failed | 降级本地 `ProbeStore` | `mode=LOCAL, degraded=true` |
| deadline 超时 | 总预算耗尽 | 返回已完成部分 | `PARTIAL` + `TIMEOUT` |
| 用户取消 | AbortSignal | 停止派发、释放句柄 | `CANCELLED` |
| current_snapshot 失配 | 本地/主写重采样不一致 | 阻止当前执行依据 | `SNAPSHOT_MISMATCH` |
| 远程证据试图进 Gate | Gate 入口校验来源 | 拒绝 | `REMOTE_EVIDENCE_GATE_REJECTED` |

## 5. 配置参考

| 参数 | 默认 | 约束 | 说明 |
|---|---|---|---|
| `replica.count` | 2 | ≥2（验收最低），≤64 | 注册副本数 N，决定 `Q` |
| `deadlineMs` | 50,000 | >0 且 < MCP 60s | scatter/gather 总预算（沿用 ADR-009 §8.1） |
| `nodeTimeoutMs` | 5,000 | >0 ≤ deadline | 单节点预算 |
| `maxConcurrentNodes` | 64 | 正整数；进程级共享 | 同时在途节点查询上限（T-157） |
| `maxInFlightPerNode` | 8 | 正整数 | 同一 `replicaId` 在途上限（T-157） |
| `maxQueuedNodes` | 256 | ≥0；0 表示不排队 | FIFO 等待队列上限，满则拒绝（T-157） |
| `earlyFreeze` | true | boolean | COMMITTED/QUORUM 达标即冻结；false 为完整 gather（T-157） |
| `cancelGraceMs` | 250 | 正整数 | 取消确认宽限；仅在无其他在途请求时受控关闭（T-158） |
| `quorum.threshold` | `ceil((N+1)/2)` | 只能由 N 派生；不提供任意值 | 防止手工放宽多数派 |
| `pull.maxEvents` | 256 | 1..1024 | 单次拉取上限 |
| `pull.bufferMax` | 4096 / 16 MiB | 有界 | 乱序缓冲上限 |
| `message.maxRequestBytes` | 8 MiB | 有界 | 传输请求上限 |
| `message.maxResponseBytes` | 16 MiB | 有界 | 传输响应上限 |
| `retry.maxAttempts` | 3 | 有界 | 副本重启/拉取重试 |
| `heartbeatMs` | 0（关闭） | 有界；`>0` 才启用 | 父进程活性心跳；默认关闭，靠 stdin 关闭兜底退出（见 §10.2） |
| `secretScreen.enabled` | true | 默认开 | 事件文本秘密筛查 |
| `networkEgress.allowed` | false | 必须 false | 网络外发默认关闭且未实现 |

配置来源优先级：显式参数 > 本地集群策略（`createDefaultClusterPolicy`/`loadClusterPolicy(text)`，由调用方注入或落本地文件）> 上表默认。策略与审计只落本地 `.ano/`（审计默认 `<root>/.ano/cluster/audit.jsonl`），不写 `.pm/`、不改用户级配置；`networkEgress` 仅接受 `'disabled'`。

## 6. 可测试判据（每个语义一个可执行断言样例）

以下为断言语义示例（伪 TypeScript，实际测试按任务簿文件名落地）。

```ts
// 1) LOCAL 判定
const ans = await distributedProbe(req, { mode: 'LOCAL' });
assert.equal(ans.metadata.mode, 'LOCAL');
assert.equal(ans.metadata.consistency, 'CONSISTENT');
assert.equal(ans.metadata.evidenceOrigin, 'local');

// 2) AS_OF 绑定提交点
const at = await distributedProbe(req, { mode: 'AS_OF', commitIndex: 10 });
assert.ok(at.metadata.commitIndex <= 10);
assert.equal(at.metadata.stale, false);           // 副本在 10 的 view_digest == primary

// 3) AS_OF 落后即 unknown
const slow = await distributedProbe(req, { mode: 'AS_OF', commitIndex: 20 });
assert.equal(slow.metadata.consistency, 'UNKNOWN');
assert.ok(slow.partial.failedNodes.length > 0 || slow.partial.gaps.length > 0);

// 4) COMMITTED 需要 >=1 副本追平
const one = await distributedProbe(req, { mode: 'COMMITTED' });
assert.ok(one.metadata.quorumCount >= 1);

// 5) QUORUM 需要 ceil((N+1)/2) 同提交点同摘要
const q = await distributedProbe(req, { mode: 'QUORUM' });
assert.equal(q.metadata.mode, 'QUORUM');
assert.ok(q.metadata.quorumCount >= Math.ceil((N + 1) / 2));
assert.ok(new Set(q.metadata.quorumDigests).size === 1);

// 6) QUORUM 不达标不得报健康
const noQuorum = await distributedProbe(req, { mode: 'QUORUM' });  // 制造 1/3 失败
assert.equal(noQuorum.metadata.consistency, 'PARTIAL');
assert.notEqual(noQuorum.budgetStatus.retrievalCompleteness, 'COMPLETE_WITHIN_DECLARED_SCOPE');

// 7) scatter 并行而非串行
const elapsed = await timed(() => distributedProbe(req, { mode: 'QUORUM' }));
assert.ok(elapsed < sumOfPerNodeLatencies * 0.75);   // 允许少量开销

// 8) 去重：同 record_ref+content_hash 多副本只计一次
const merged = gather([respA, respB]);
assert.equal(merged.candidates.length, new Set(all.map(c => c.record_ref + c.content_hash)).size);

// 9) 版本冲突显式且不自动选最新
const conflict = gather([{factKey:'F', version:5}, {factKey:'F', version:4}]);
assert.equal(conflict.conflicts.some(c => c.fact_key === 'F' && c.status === 'unresolved'), true);
assert.equal(conflict.winner, undefined);

// 10) deadline 超时返回 partial
const to = await distributedProbe(req, { mode: 'QUORUM', deadlineMs: 30 }, { nodeDelayMs: 200 });
assert.equal(to.budgetStatus.stop_reason, 'TIMEOUT');
assert.equal(to.partial, true);

// 11) 取消不泄漏进程
const controller = new AbortController();
const p = distributedProbe(req, { mode: 'QUORUM', signal: controller.signal });
controller.abort();
const cancelled = await p;
assert.equal(cancelled.outcome, 'CANCELLED');
assert.equal(countReplicaChildren(), 0);

// 12) 副本写被拒
await assert.rejects(() => transport.send(handle, { type: 'append', event }), /REPLICA_WRITE_REFUSED/);

// 13) 缺段不静默跳
const applied = replica.apply(seq1); const gap = replica.apply(seq3);
assert.deepEqual(replica.cursorGaps(), [2]);
assert.equal(replica.state, 'LAGGING');
assert.equal(applied.contiguousThrough, 1);

// 14) 降级本地 ProbeStore
const deg = await distributedProbe(req, { mode: 'QUORUM' }, { killAllReplicas: true });
assert.equal(deg.metadata.mode, 'LOCAL');
assert.equal(deg.degraded, true);
assert.deepEqual(deg.partial.failedNodes.sort(), ['replica-0','replica-1']);

// 15) 远程证据不进 Gate
const remoteSnapshot = replica.snapshot;
const report = verifyContextDraft({ manifest, draft, root, now, current_snapshot: remoteSnapshot });
assert.equal(report.violations.some(v => v.code === 'snapshot_mismatch' || v.code === 'remote_evidence_gate_rejected'), true);
assert.equal(report.status === 'ALLOW', false);   // v1 本就从不 ALLOW；此处证明远程不能放行
assert.equal(gate.lastEvidenceId, undefined);

// 16) 秘密不外发
const outbound = replicationPayloadFor(events);
assert.equal(containsEnvOrKeyContent(outbound), false);
assert.ok(outbound.every(e => e.content === undefined || e.content_redacted === true || !looksSecret(e.content)));
```

## 7. 接口速查（建议签名，非最终强制）

| 能力 | 建议位置 | 依赖 |
|---|---|---|
| `ClusterSnapshot` / `ReplicaCursor` / `evidence_digest()` | `src/memory/probe-contract.ts`、`probe-store.ts`（T-124） | T-124 |
| 旧快照 adapter、严格校验 | `src/memory/probe-contract.ts`（T-124） | T-124 |
| `listCommittedEvents()`、`pullEvents()` | `src/memory/replication.ts`（T-125） | T-124 |
| `class ReplicaStore`（apply/cursor/rebuild） | `src/memory/replica.ts`（T-125） | T-124 |
| `distributedProbe()` / gather / partial | `src/memory/distributed-probe.ts`（T-126） | T-124/T-125 |
| `ReplicaTransport` 实现（child/in-process） | `src/memory/replica-transport.ts`、`replica-worker.ts`（T-127） | T-126 接口 |
| `judgeConsistency()` / `current_snapshot` 复核 | `src/memory/cluster-consistency.ts`、`context-verify.ts`、`consumer.ts`（T-128） | T-124/T-126 |
| `authorize()` / `screenSecrets()` / `revoke()` | `src/memory/cluster-policy.ts`（T-129） | T-123/T-126 |
| 基准脚本 | `scripts/benchmark-distributed-probe.ts`（T-131） | T-127/T-130 |

核心类型草图：

```ts
// T-124
interface ClusterSnapshot {
  schema_version: 'anchorprobe.cluster.v1';
  cluster_epoch: string;
  primary: { root: string; actor: string; session_id: string };
  commit_index: number;
  ledger_digest: string;
  view_digest: string;
  consistency: 'LOCAL' | 'AS_OF' | 'COMMITTED' | 'QUORUM';
  replicas: Array<{ replica_id: string; state: ReplicaState; replica_commit_index: number; evidence_digest: string; updated_at: string }>;
  quorum_size: number;
  max_lag: number | null;
  partial: boolean;
  failed_nodes: string[];
}

// T-125
interface CommittedEvent { event: LedgerEvent; seq: number }
interface ReplicaCursor { replica_id: string; cluster_epoch: string; commit_index: number; last_event_id: string; last_hash: string; updated_at: string }

// T-126
interface DistributedProbeAnswer {
  metadata: {
    mode: 'LOCAL' | 'AS_OF' | 'COMMITTED' | 'QUORUM';
    consistency: 'CONSISTENT' | 'PARTIAL' | 'UNKNOWN' | 'DEGRADED';
    evidence_origin: 'local' | 'primary' | 'replica';
    cluster_epoch: string;
    commit_index: number;
    evidence_digest: string;
    quorum_count?: number;
    stale: boolean;
  };
  candidates: ProbeCandidate[];
  conflicts: AnchorProbeConflict[];
  partial: { coverage: number; gaps: string[]; failed_nodes: string[]; stop_reason: string };
}
```

## 8. T-124~T-132 文件所有权与并行约束

| 任务 | 独占文件 | 共享/串行约束 |
|---|---|---|
| T-124 | `probe-contract.ts`、`probe-manifest.ts`、`probe-store.ts` + 对应单测 | 先于 T-125/T-126/T-128；不改旧 AP-02 字段语义 |
| T-125 | `replica.ts`、`replication.ts` + 单测/集成 | 消费 T-124 类型；只读账本导出 |
| T-126 | `distributed-probe.ts`、`probe.ts` + 单测 | 面向 T-127 冻结的 `ReplicaTransport` 编程，可与 T-127 并行 |
| T-127 | `replica-worker.ts`、`replica-transport.ts` + 集成 | 依赖 T-126 接口；真实 ≥2 子进程 |
| T-128 | `cluster-consistency.ts`、`context-verify.ts`、`consumer.ts` + 单测/集成 | 依赖 T-124/T-126；不改 Gate 证据语义 |
| T-129 | `cluster-policy.ts` + 单测 | 红队文件与 T-130 串行 |
| T-130 | `replica-chaos.test.ts` | 追加 T-129 的红队文件，禁止并发写 |
| T-131 | `benchmark-distributed-probe.ts`、benchmark 测试、证据文档 | 依赖 T-127/T-130 |
| T-132 | `README.md`、`docs/usage.md`、`docs/distributed-probe.md`、`docs/limitations.md`、`docs/evidence` | 收口本文（T-123 创建，串行更新） |

并行要点：

1. **T-124 是唯一契约入口**：集群类型/摘要/cursor 未定前，T-125/T-126/T-128 不得开工。
2. **T-126 与 T-127 可并行**：以第 7 节 `ReplicaTransport` 签名为界；T-126 写 fake transport 单测，T-127 写真实子进程。
3. **共享文件串行**：`probe-contract.ts`/`probe-manifest.ts`/`probe-store.ts` 归 T-124；`distributed-probe.ts`/`probe.ts` 归 T-126；`context-verify.ts`/`consumer.ts` 归 T-128。
4. **红队共享文件**：`test/redteam/distributed-probe-boundary.test.ts` 由 T-129 创建、T-130 只追加 describe 区块。
5. **文档收口**：`docs/distributed-probe.md` 由 T-123 建、T-132 改；其余文档 T-132 统一更新。

## 9. 实现红线自查（提交前逐条核对）

- [ ] 单主：第二主注册被拒；副本写消息被拒；副本目录无 `.ano/ledger` 写入。
- [ ] 复制：只复制已提交事件；同 id 幂等；乱序/缺段不静默跳；损坏 fail-closed；视图摘要可重算。
- [ ] 四模式：判定条件互斥且完整；不一致返回 PARTIAL/UNKNOWN；QUORUM 阈值由 N 派生。
- [ ] 异步七项：scatter/gather/deadline/取消/去重/版本冲突/partial 均有测试。
- [ ] 降级：副本全挂 → 本地 ProbeStore；当前执行依据只用本地/主写 current_snapshot。
- [ ] Gate：远程证据无 `evidence_id`，不进完成通道。
- [ ] 远程不可信：payload 严格解析、不可执行、大小有界、远程声明不提升权限。
- [ ] 安全四项：授权、最小化、撤销清理、默认不外发。
- [ ] 兼容：旧事件 hash 不变；旧快照可解析；旧 Gate/explore 回归；schema pin 同步；七工具不变。
- [ ] 未支持项在文档中明文：跨机、生产高可用、多主、远程证据进 Gate。

## 10. 交付状态与运维（M15 收口）

> T-132 收口。默认值/路径一律以代码为准。本节修正正文旧表述：副本路径 `.ano/cluster/replicas/` → `.ano/replicas/`；`heartbeatMs` 默认 5,000 → `0`（关闭）；配置来源不再写死 `.ano/cluster/policy.json`，改为本地注入策略。ADR-011 若保留旧写法，以代码与本节为准。全部 API 名、错误码均可在 `src/memory/` 与测试中核对。

### 10.1 启用（库级，显式调用）

没有 CLI 命令、MCP 工具或配置文件开关：不调用即不启用。典型最小流程（签名取自源码）：

```ts
import { Ledger } from 'src/ledger/ledger.ts';
import { exportCommittedEvents, type CommittedEventEnvelope } from 'src/memory/replication.ts';
import { ChildProcessReplicaTransport } from 'src/memory/replica-transport.ts';
import { distributedProbe } from 'src/memory/distributed-probe.ts';

const transport = new ChildProcessReplicaTransport();
// 至少启动 2 个独立子进程副本，才能满足 QUORUM（N≥2）
const handleA = await transport.start({ root, replicaId: 'replica-a', projectScope: 'proj', clusterEpoch: 'epoch-1' });
const handleB = await transport.start({ root, replicaId: 'replica-b', projectScope: 'proj', clusterEpoch: 'epoch-1' });

// 只导出已提交事件并复制给副本（副本永不写主账本）
const pull = exportCommittedEvents(ledger, { projectScope: 'proj', limit: 256 });
await transport.apply(handleA, pull.events, { projectScope: 'proj' });
await transport.apply(handleB, pull.events, { projectScope: 'proj' });

// 组装只读节点后检索；mode 缺省为 LOCAL（不 scatter 副本）
const nodeA = await transport.toDistributedReplicaNode(handleA);
const nodeB = await transport.toDistributedReplicaNode(handleB);
const answer = await distributedProbe(request, {
  localStore,
  replicas: [nodeA, nodeB],
  mode: 'QUORUM',
  primaryCommitIndex: pull.primary_commit_index,
  deadlineMs: 50_000,
});
```

`distributedProbe` 也接受位置参数形式 `distributedProbe(request, localStore, replicas, options)`。`LOCAL` 模式不依赖任何副本，行为与既有 `probe()` 一致。

### 10.2 副本健康观察项

用 `await transport.status(handle)`（返回 `ReplicaStatusView`）与 `answer` 交叉观察：

| 观察 | 字段 | 含义 |
|---|---|---|
| 落后 | `status.commitIndex`、`answer.metadata.max_lag`、`answer.partial.stop_reason=NODE_LAGGING` | 副本未到主写提交点；`max_lag=null` 表示未知 |
| 摘要不一致 | `status.viewDigest` / `status.evidenceDigest` 与主写同提交点重算值 | 失配则该副本不计入 QUORUM，节点报 `VIEW_DIGEST_MISMATCH` |
| 部分覆盖 | `answer.partial.coverage` / `considered` / `requested`、`gaps`、`failed_nodes` | 任一非 100% 都不得读作全量健康 |
| 缺段 | `ReplicationReport.gaps` / `pendingCount` / `complete` | 乱序缓冲未填满；续传用 `resumePullRequest()` |
| 节点结果 | `answer.nodes[].outcome`、`answer.outcome`、`answer.degraded` | `TIMEOUT`/`NODE_UNAVAILABLE`/`CANCELLED` 等显式失败 |
| 判定 | `judgeConsistency(answer, expectations)` 的 `status`/`code` | `consistent`/`stale`/`inconsistent`/`blocked`；执行前用 `assertExecutableContext` |

心跳默认关闭（`heartbeatMs=0`），因此不要把「无心跳超时报错」当作活性检测缺失；父进程消失由 stdin 关闭兜底使 worker 退出。需要活性探测时显式设置 `heartbeatMs>0`。

### 10.3 关闭、恢复、撤销与清理

```ts
// 关闭：幂等；对已退出句柄重复调用安全
await transport.stop(handle);

// 崩溃/需重建进程：从持久化 cursor 续传（events.jsonl + cursor.json）
const next = await transport.restart(handle);

// 需要从零重建视图时（派生数据可删可重建）
const store = ReplicaStore.open({ root, replicaId, projectScope: 'proj', clusterEpoch: 'epoch-1' });
store.rebuildFromEvents(allEnvelopes);

// 撤销 + 清理派生数据（顺序固定：先 revoke，再 cleanup）
const policy = createDefaultClusterPolicy('proj', { root, replicas: [{ replicaId: 'replica-a', allowedScopes: ['proj'], operations: ['read', 'apply'] }] });
const revoked = revokeReplica(policy, 'replica-a', { reason: 'decommissioned', actor: 'operator' });
const report = cleanupReplica(root, 'replica-a', revoked, { actor: 'operator', reason: 'decommissioned' });
```

- 副本目录固定在 `<root>/.ano/replicas/<replicaId>/`；`cleanupReplica` 未撤销时拒绝（`REVOKE_REQUIRED`），删除后校验目录不存在并写审计。直接删除该目录同样只影响副本派生物，**主账本 `.ano/ledger` 不受影响**。
- **无 daemon、无自动接管、无后台守护**：进程只在调用方持有句柄期间存活；协调器不会自动拉起副本，也不会自动把副本结论升级为执行依据。
- **无跨机**：传输仅 `in-process`/`child-process`；`networkEgress` 只接受 `'disabled'`，不监听端口、不外发。

### 10.4 降级与拒绝码含义（fail-closed）

| 码 | 来源 | 含义与处置 |
|---|---|---|
| `TIMEOUT` / `REPLICA_QUERY_TIMEOUT` | 检索 / 传输 | 单节点或总预算耗尽；返回 partial，不冒充完整 |
| `CANCELLED` / `REPLICA_QUERY_CANCELLED` | 检索 / 传输 | `AbortSignal` 触发；停止派发并释放句柄 |
| `NODE_UNAVAILABLE` / `REPLICA_NODE_EXITED` | 检索 / 传输 | 副本进程不可达或已退出；记入 `failed_nodes`，必要时 `restart` |
| `QUORUM_UNMET` / `MODE_UNMET` | 检索 / 一致性 | 达标副本不足或多模式不符；显式降级并标注实际模式 |
| `SCOPE_DENIED` | 复制 / 策略 / 检索 | 跨项目 scope；查询前拒绝，不发起远程调用 |
| `CLUSTER_EPOCH_MISMATCH` | 检索 / 一致性 | epoch 不等，证据不可混用；需重新握手 |
| `VIEW_DIGEST_MISMATCH` / `EVIDENCE_DIGEST_MISMATCH` / `QUORUM_DIGEST_DIVERGENCE` | 复制 / 一致性 | 副本视图或摘要与主写不符；不计入 quorum |
| `MIXED_EVIDENCE_REJECTED` | 一致性 | 同一结论混入本地与远程证据；必须两阶段复核 |
| `CURRENT_SNAPSHOT_MISMATCH` | 一致性 | 本地或主写 `current_snapshot` 复核失配；阻止当前执行依据（`context-verify` 的 violation 名为 `snapshot_mismatch`/`SNAPSHOT_UNSTABLE`） |
| `HISTORICAL_NOT_EXECUTABLE` | 一致性 | AS_OF 历史证据被当作当前执行依据；拒绝 |
| `REPLICA_WRITE_FORBIDDEN` | 副本 | 副本侧任何写路径恒拒绝（append/writeNote/recordTrack） |
| `REPLICA_EVENT_CONFLICT` / `REPLICA_CHAIN_BREAK` / `REPLICA_CORRUPT_EVENT` | 复制 | 同 id 异 hash、链断裂、批内损坏；零落盘并 fail-closed |
| `REPLICA_BUFFER_EXCEEDED` / `REPLICA_SEQ_CONFLICT` / `REPLICA_RESUME_EXHAUSTED` | 复制 | 乱序缓冲超限、seq 冲突、永久缺段；报告 gap 而非跳段 |
| `REPLICA_NOT_AUTHORIZED` / `REPLICA_REVOKED` / `OPERATION_FORBIDDEN` | 策略 | 未注册、已撤销或操作未授权；拒绝且不影响其他节点 |
| `EGRESS_FORBIDDEN` | 策略 | 试图启用网络外发；唯一合法值为 `disabled` |
| `REMOTE_PAYLOAD_INVALID` / `PAYLOAD_LIMIT_EXCEEDED` | 策略 | 远程 payload 结构非法或越界；当数据拒收，不执行、不截断 |

### 10.5 未实现边界（不得宣称）

- 跨机传输、真网络分区、脑裂、跨机时钟回拨：未实现/未验证。
- 生产高可用、故障切换、RTO：未验证。
- 多主写、混合 commit、远程证据进 Gate：明确不支持。
- HLC 物理时钟篡改、掉电级持久性：未覆盖（沿用 M10/M13 结论）。
