# 多主高可用协议实现者参考

任务：T-133 / M16（契约冻结）；实现：T-134~T-141
契约来源：[ADR-012](adr/ADR-012-multi-writer-ha.md)
范围：quorum、事件身份、fencing、分叉/裁决、逻辑时间、时钟诊断、故障注入语义、Gate 边界与验证边界。
读者：T-134~T-141 实现者。

> 本文是 ADR-012 的实现者参考，只给术语、载荷/状态机、时序、判定表、接口与验收矩阵；决策论证以 ADR-012 为准。冲突处一律以 ADR-012 与 `src/memory/ha-protocol.ts` 的实际导出为准。
>
> **契约现状**：T-133 只交付 `src/memory/ha-protocol.ts`（strict schema + 纯函数 + 单测）。本文提到的 TCP 帧、选举、时钟补偿均为**规划**，不是已实现能力；`ha-protocol.ts` 中不存在的名字不得被当作可调用 API。T-134 若需为消息类型字符串建立版本常量，必须先改契约层并同步单测与本文。

## 1. 术语表

| 术语 | 定义 | 关键不变量 |
|---|---|---|
| **voting-member** | 参与 quorum 投票的成员角色 | N 计入；`role !== 'observer'` |
| **observer（replica）** | 只复制、只读服务的角色 | 永不投票、永不提交、永不自封 leader |
| **writer** | 可发起提案并可竞选 leader 的投票角色 | 同一 `(epoch, term)` 至多一个 leader |
| **N / Q** | N=非观察者成员数；Q=`floor(N/2)+1` | `quorumSize(N)`；手写阈值无效 |
| **identity（身份）** | `(writer_id, epoch, term, local_seq, ledger_event_hash)` | hash 引用既有账本事件，不重算 |
| **conflict key（冲突槽）** | `(writer_id, epoch, local_seq)` | 同槽异 hash 即分叉 |
| **leader lease（租约）** | `(term, leader_id, epoch)` | fencing 的比对基准 |
| **logical version（逻辑版本）** | `(epoch, commit_index, writer_id, local_seq)` | 唯一排序键；无墙钟 |
| **commit_index** | 全局提交序号；未提交为 0 | `committed/adjudicated` 必须 >0 |
| **branch（分支）** | 同一冲突槽的一个相异 hash 提案 | 全量保留，不得截断 |
| **adjudication（裁决）** | 对全部分支的显式处置 | `branch_hashes` 必须覆盖全部分支 |
| **diagnostic（诊断）** | 时钟异常标记 | `diagnostic_only=true`，不影响顺序/版本 |

正交提醒：本协议版本常量（`MWHA_*`）与 ADR-011 的 `cluster_epoch`/`view_digest` 是不同字段，不得复用同名。M15 的 `cluster_epoch` 仍是成员/主身份变化标识。

## 2. 消息 / 帧与状态机（供 T-134）

### 2.1 帧封装约定（规划）

传输层帧由 T-134 定义；本参考只固定**载荷**必须来自以下已存在 schema，且外层信封在 T-134 落地时必须 `.strict()`：

| 用途 | 载荷 schema（已存在） | 关键字段 |
|---|---|---|
| 拓扑/成员交换 | `mwhaTopologySchema` | `members[]`、`quorum_size` |
| 提案 | `mwhaWriterEventSchema` | `identity`、`leader` |
| 提交日志 | `mwhaClusterLogEntrySchema` | `status`、`commit_index`、`conflict_key` |
| 裁决 | `mwhaAdjudicationSchema` | `branches[]`、`branch_hashes[]`、`status` |
| 时钟观测 | `mwhaClockObservationSchema` | `observed_ms`、`previous_observed_ms`、`reference_ms` |
| 故障注入指令 | `mwhaFaultInjectionSchema` | `kind`、`target_member_id`、`probability`、`duration_ms` |
| 租约声明 | `mwhaLeaderLeaseSchema` | `term`、`leader_id`、`epoch` |

建议信封形态（T-134 可实现为严格对象，字段名以实际代码为准）：`{ schema_version: MWHA_PROTOCOL_SCHEMA_VERSION, kind: <消息类型>, payload: <上表 schema> }`。载荷解析失败必须整帧拒绝，不得部分采用。

### 2.2 提交状态机

```
             propose
   (无) ─────────────────► proposed
                              │
                   classifyDelivery / classifySequence
                              │
              ┌───────────────┼────────────────┐
              ▼               ▼                ▼
          duplicate        fresh           conflict
       (零副作用返回)         │                │
                             ▼                ▼
                     collect votes       detectForks
                     (isQuorum)          (保留全分支)
                             │                │
                   ┌─────────┴─────┐         ▼
                   ▼               ▼   adjudication
              committed       blocked   (assertAdjudicationComplete)
             (commit_index>0) (不得提交)    │
                                          ├─ unresolved → conflicted（投影不产 evidence_id）
                                          └─ resolved   → adjudicated（commit_index>0，投影可产 evidence_id）
```

不变量：

- `proposed/conflicted` 的 `commit_index` 必须为 0；`committed/adjudicated` 必须 >0 且带 leader（schema 强制）。
- `duplicate` 不产生新提交点；`conflict` 进入裁决，不按到达顺序选胜。
- 任何状态下都要先过 `evaluateFence`，fencing 失败不得进入投票。

## 3. 提交时序图（文本）

### 3.1 正常提交（N=3，Q=2）

```
writer(W)            voter(V1)         voter(V2)        observer(O)
   │                    │                 │                │
   ├─ propose(identity, leader=(t,L,e)) ─►│                 │
   ├──────────────────────►│                 │                │
   │                       │ evaluateFence(current,candidate)
   │                       │ FENCE_OK / 拒绝                 │
   │◄──────── grant(t,L,e) ┤                 │                │
   │◄──────────────────────┼────────────────►│                │
   │                       │                 │                │
   │  isQuorum(2,3)=true   │                 │                │
   ├─ commit(entry{status:committed, commit_index:C}) ──────►│（只复制）
   │                       │                 │                │
   │  投影：mwhaProjectionState{status:committed, evidence_id:ev}
```

### 3.2 少数派分区（2-2，永不提交）

```
partition-A {W}        partition-B {V1}      （N=2, Q=2）
   │                        │
   ├─ propose ─────────────X│   （one-way-partition）
   │                        │
   │ 本侧 votes=1 < 2      │ 本侧 votes=1 < 2
   │ evaluatePartitions([1,1],2) → any_commit=false
   ├─ 不进入 committed；投影 uncommitted（evidence_id=null）
```

任一分区若试图继续写：candidate.term < current.term → `FENCE_STALE_TERM`；同 term 换 leader → `FENCE_SPLIT_BRAIN_SAME_TERM`。

### 3.3 分叉与裁决

```
writer(W) 本地序号 7 ──┬─ hash A ─► 节点 X
                       └─ hash B ─► 节点 Y
                                │
                 detectForks(entries)
                 conflict_key=(W,e,7), branches=[A,B]（全量）
                                │
                 adjudication 必须包含 branch_hashes=[hashA,hashB]
                                │
              ├─ unresolved：投影 conflicted，evidence_id=null
              └─ resolved：selected_branch_id∈{branchA,branchB}，
                           committed/adjudicated 才可带 evidence_id
```

## 4. 脑裂判定表

| 场景 | N | 分区 | Q | 结果 | 依据 |
|---|---|---|---|---|---|
| 2-2 对称分区 | 2 | [1,1] | 2 | 两侧均不提交 | `evaluatePartitions([1,1],2).any_commit=false` |
| 3 节点单失效 | 3 | [2] | 2 | 多数侧可提交 | `isQuorum(2,3)=true` |
| 3-3 对称分区 | 6 | [3,3] | 4 | 两侧均不提交（3<4） | `evaluatePartitions([3,3],6)` |
| 5 节点 2-2-1 | 5 | [2,2,1] | 3 | 无提交 | 每侧均 <3 |
| 5 节点 3-2 | 5 | [3,2] | 3 | 3 票侧可提交 | `isQuorum(3,5)=true` |
| 同 term 双主 | 任意 | — | — | 非法 | `detectMultipleLeaders` / `FENCE_SPLIT_BRAIN_SAME_TERM` |
| 未知 epoch | 任意 | — | — | 拒绝 | `FENCE_UNKNOWN_EPOCH` |
| epoch 回退 | 任意 | — | — | 拒绝 | `FENCE_EPOCH_ROLLBACK` |

> 分区判定是**逻辑判定**，不等同于物理网络分区；TCP 协议层故障注入（含 `one-way-partition`）不能代表 OS 真分区。

## 5. 分叉 / 裁决流程（实现步骤）

1. 收集条目，按 `idempotencyKey(identity)` 分组。
2. 组内按 `ledger_event_hash` 去重；相异 hash ≥2 时用 `detectForks` 生成完整 `MwhaForkConflict`。
3. 为每个冲突构造 `mwhaAdjudicationSchema` 实例：`branches` 必须来自 `detectForks` 的全部分支；`branch_hashes` 必须逐项等于 `branches[].ledger_event_hash`。
4. 用 `assertAdjudicationComplete(adjudication, branches)` 复核；缺分支/多 hash/选择越界都会抛 `ADJUDICATION_INCOMPLETE`。
5. 依据裁决更新投影：`unresolved → conflicted`；`resolved → adjudicated`（携带 `winning_branch_id` 与 `commit_index>0`）。
6. 投影经 `assertGateBoundary` 校验：仅 `committed` 允许 `evidence_id` 与 `produces_gate_evidence=true`。
7. 合并展示顺序用 `sortEntriesByLogicalVersion`；**排序不是胜选**，胜选看 `determineVersionOutcome`。

## 6. 时钟诊断

输入 `mwhaClockObservationSchema`，策略默认 `MWHA_CLOCK_DEFAULT_POLICY`（skew 5,000ms / future 5,000ms / jump 60,000ms），调用 `classifyClockObservation`。

| kind | 判据 | 实现要求 |
|---|---|---|
| `rollback` | `observed < previous_observed` | 只记录诊断；不得回退逻辑版本 |
| `jump` | 与 reference/previous 差值 > jump 阈值 | 只记录诊断；不得重置 epoch |
| `future` | `observed > reference + futureTolerance` | 只记录诊断；不得据此改提交顺序 |
| `skew` | 与 reference 差值 > skew 容差且未触发未来/跳变 | 只记录诊断 |
| `normal` | 在容差内 | 无动作 |
| `unknown` | previous/reference 均缺失 | 显式 unknown，不得伪造正常 |

强制检查：输出对象必须带 `diagnostic_only=true`、`affects_commit_order=false`、`affects_fact_version=false`（由契约层保证）。T-139 若做时钟补偿，只能在诊断之上做运维动作，禁止反向影响 `compareLogicalVersion`/`mergeSortKey`。

## 7. T-134~T-141 接口与验收矩阵

| 任务 | 独占文件 | 必须使用的契约（已存在） | 验收要点 | 并行关系 |
|---|---|---|---|---|
| T-134 传输/帧 | `src/memory/ha-transport.ts`、`test/integration/ha-transport.test.ts` | `mwhaWriterEventSchema`、`mwhaClusterLogEntrySchema`、`mwhaLeaderLeaseSchema`、`mwhaFaultInjectionSchema` | 帧有界、strict 解析、拒未知字段；本地回环收发；无监听端口外发 | 与 T-135 并行 |
| T-135 成员/拓扑 | `src/memory/ha-membership.ts`、`test/unit/ha-membership.test.ts` | `mwhaTopologySchema`、`votingMemberCount`、`quorumSizeForMembers`、`evaluatePartitions` | 手写 quorum 被拒；observer 不投票；重复 member 被拒 | 与 T-134 并行 |
| T-136 选举/fencing | `src/memory/ha-election.ts`、`test/unit/ha-election.test.ts` | `evaluateFence`、`assertFence`、`detectMultipleLeaders` | 旧 term/旧 leader/同 term 双主/epoch 回退/未知 epoch 全拒绝 | 依赖 T-133；与 T-137 分文件可并行 |
| T-137 提交/复制 | `src/memory/ha-commit.ts`、`test/unit/ha-commit.test.ts` | `isQuorum`、`assertQuorum`、`classifyDelivery`、`classifySequence`、`logicalVersionOfEntry` | 少数派不提交；重复零副作用；gap 不静默跳；同版本异 hash 判冲突 | 依赖 T-134/T-136 |
| T-138 分叉/裁决 | `src/memory/ha-adjudication.ts`、`test/unit/ha-adjudication.test.ts` | `detectForks`、`adjudicationProblems`、`assertAdjudicationComplete`、`determineVersionOutcome`、`sortEntriesByLogicalVersion` | 全分支保留；缺 hash 拒绝；排序与输入顺序无关 | 与 T-139 并行 |
| T-139 时钟诊断 | `src/memory/ha-clock.ts`、`test/unit/ha-clock.test.ts` | `classifyClockObservation`、`mwhaClockObservationSchema`、`MWHA_CLOCK_DEFAULT_POLICY` | 六类判定正确；任何诊断都不改版本/顺序 | 与 T-138 并行 |
| T-140 红队/混沌 | `test/redteam/ha-boundary.test.ts`、`test/integration/ha-chaos.test.ts` | `mwhaFaultKinds`、`MWHA_FAULT_INJECTION_SCOPE_NOTE`、`gateEvidenceIssue`、`assertGateBoundary` | 故障词汇只表示 TCP 协议层；冲突/未提交不产 evidence_id；伪造分支不能放行 | 依赖 T-134~T-139；红队文件独占 |
| T-141 收口 | `README.md`、`docs/usage.md`、`docs/multi-writer-ha.md`、`docs/limitations.md` | `MWHA_VERIFICATION_SCOPE`、`MWHA_UNVERIFIED_CAPABILITIES`、`isUnverifiedCapability` | 未验证能力明文；不宣称跨机/生产 HA/SLA | 串行收口 |

## 8. 实现红线自查（提交前逐条核对）

- [ ] 契约层无副作用：`ha-protocol.ts` 无 `net`/`tls`/`child_process`/`fs`/`Date.now`；T-134+ 才允许传输。
- [ ] quorum 只由 N 派生；2-2 不提交；少数派 `QUORUM_NOT_REACHED`。
- [ ] fencing 规则顺序固定；旧 term/旧 leader/同 term 双主/epoch 回退/未知 epoch 全拒绝。
- [ ] `ledger_event_hash` 只引用 `hashEvent(LedgerEvent)`；旧事件字节与 hash 不变。
- [ ] 分叉保留全部分支；裁决 `branch_hashes` 缺一项即失败。
- [ ] 逻辑版本只含 `(epoch, commit_index, writer_id, local_seq)`；墙钟极端值不改变比较。
- [ ] 同版本异 hash 判 conflict，不做 LWW。
- [ ] 时钟观测只产诊断；`diagnostic_only=true` 且 `affects_*=false`。
- [ ] Gate：`committed` 才有 `evidence_id`；`conflicted/uncommitted` 恒 null/false。
- [ ] 故障注入词汇固定；文档明示「TCP 协议层故障注入 ≠ OS 真分区」。
- [ ] 兼容：M15 `ChildProcessReplicaTransport`/复制/一致性/策略接口不回退；`scripts/check-schema.ts` 的 PINNED 未变更（T-133 未动账本 kind/工具 schema）。
- [ ] 未验证能力只列出不宣称：物理三机、OS 真分区、跨机时钟回拨、生产 HA、SLA。

## 9. 与 M15 单主部署的共存

- 未启用 `mwha.protocol.v1`：行为完全按 ADR-011，`primary → replica` 单向 pull、`exportCommittedEvents`/`applyEventBatch`、四模式判定、授权/撤销均不变。
- 启用后：`observer` 对应 ADR-011 只读副本语义；`voting-member/writer` 是新角色。已验收的 `child-process` 传输仍是默认本地承载，替换它是独立后续决策。
- 本契约不修改 `src/memory/replication.ts` 的 `seq` 语义：单主规范序继续存在；多主提交点是独立 `(epoch, commit_index)` 空间。

## 交付状态与运维（M16 收口）

> M16 实现任务（HA-01~HA-09）已完成并通过各自质量验收；本节只给运维视角的启用/关闭/恢复、健康观察、故障处置与拒绝码。语义与判定以 ADR-012 和 `src/memory/*.ts` 实际导出为准。
>
> **文件落地与早期规划名不一致**：实现未新建 `ha-transport.ts`/`ha-election.ts`/`ha-commit.ts` 等独立文件，而是落成 `tcp-transport.ts`、`leader-lease.ts`、`multi-writer.ts`、`logical-clock.ts`、`tcp-fault-proxy.ts`、`ha-cluster.ts`。上文第 7 节矩阵里的规划文件名不得当作现有文件引用。

### 启用 / 关闭 / 恢复（严格对应 ha-cluster.ts 公开 API）

```ts
import { hashEvent, ledgerEventSchema } from '../src/ledger/event.ts';
import { HaCluster } from '../src/memory/ha-cluster.ts';

const cluster = await HaCluster.start({ memberIds: ['n1', 'n2', 'n3'] }); // 只绑 127.0.0.1:0
await cluster.elect('n1');                                              // 多数派确认后持租约
const event = ledgerEventSchema.parse({ /* ...既有 LedgerEvent... */ });
await cluster.propose({
  memberId: 'n1', writerId: 'writer-1', epoch: 1, term: 1, localSeq: 1,
  ledgerEvent: event, ledgerEventHash: hashEvent(event),
});
await cluster.isolate([['n1'], ['n2', 'n3']]);                           // 真实切断 n1 与其余节点的有向链路
await cluster.restore();                                                // 重建全部干净链路
await cluster.rejoin('n1');                                             // 旧主降级并经 sync-request 追平
cluster.status();                                                       // term/epoch/commitIndex/lease/连接数
cluster.projection().hash;                                              // 确定性投影指纹 + gate_ok
await cluster.close();                                                  // 幂等释放端口/socket/代理/定时器
```

- **启用**：`HaCluster.start(options?)`，默认成员 `['n1','n2','n3']`、host `127.0.0.1`；非 loopback host 在 bind 前以 `HA_INPUT_INVALID` 拒绝。
- **提交**：`propose(input)` 要求调用者是当前租约持有者且 fencing 通过，并收集带 per-attempt nonce 的真实 TCP 多数 ack；少数派得到 `QUORUM_NOT_REACHED`。
- **隔离/恢复**：`isolate(groups)` 逐条关闭并重建有向链路，跨组方向注入 `drop probability=1`；`restore()` 重建干净链路。两者都是真实套接字级操作。
- **rejoin 语义**：`rejoin(memberId)` 先以心跳探测各 peer 的 `(epoch,term)`，发现更新者则本地降级采用并从该 peer 拉取已提交记录追平；没有更新 lease 的 follower 直接 rejoin 会以自身为 leader 探测、被 peer 记为同 term 竞争。**正确顺序是先 `cluster.node(memberId).manager.renewLease()` 再 `cluster.rejoin(memberId)`**（恢复基准即如此）。旧主 rejoin 后只降级、不覆盖新主日志。
- **关闭**：`close()` 幂等；`resourceStats()` 给出 nodes/servers/proxies/clients/activeConnections 计数，可用于核对无泄漏。

### 健康观察项

- 拓扑与领导：`status().leader_id`、`declarations`、`multiple_leaders`（双主信号）、`partitions`、`quorum_size`/`voting_count`。
- 每节点：`role`、`epoch`、`term`、`lease_expires_at_ms`、`lease_expired`、`committed_count`、`max_commit_index`、`active_connection_count`。
- 一致性：`projection().hash`（同一输入集合任意到达顺序下相同）与 `gate_ok=true`；`projection().forks`/`adjudications` 观察冲突与裁决。
- 说明：代码未提供独立的「peer 可达性」布尔字段；可达性只能从 `active_connection_count` 与逐链路代理规则间接观察（[数据缺失]）。

### 故障处置

| 现象 | 处置 |
|---|---|
| 断链（少数派） | `isolate`/`restore` 驱动；被隔离侧 `propose` 抛 `QUORUM_NOT_REACHED`；多数侧继续提交 |
| 旧主恢复 | 必须 `rejoin` 降级并追平；继续提交会被 `FENCE_STALE_TERM`/`FENCE_REJECTED` 拒绝 |
| 双主声明 | `assertNoRivalLeader` 抛 `SPLIT_BRAIN`；`detectMultipleLeaders` 列入 `status().multiple_leaders` |
| 分叉 | `MultiWriterLog.adjudicate` 的 `branch_hashes` 必须覆盖 `detectForks` 全部分支；`unresolved→conflicted`（`evidence_id=null`），`resolved→adjudicated` |

### 拒绝码表（grep `src/memory/` 核实）

| 码 | 出处 | 含义 |
|---|---|---|
| `FENCE_OK` | `evaluateFence` | 候选租约通过 fencing |
| `FENCE_INVALID` / `FENCE_UNKNOWN_EPOCH` / `FENCE_EPOCH_ROLLBACK` / `FENCE_STALE_TERM` / `FENCE_SPLIT_BRAIN_SAME_TERM` | `evaluateFence` | 非法租约 / 未知 epoch / epoch 回退 / 旧 term / 同 term 双主 |
| `FENCE_REJECTED` | `HaCluster.propose` | 非租约持有者、无租约，或写入领先于持有租约 |
| `SPLIT_BRAIN` | `assertSingleLeader`/`LeaderLeaseManager` | 同一 `(epoch,term)` 出现多个 leader 声明 |
| `QUORUM_NOT_REACHED` / `QUORUM_INPUT_INVALID` / `TOPOLOGY_INVALID` | quorum 纯函数 | 未达 `floor(N/2)+1` / 非法票数 / 无投票成员 |
| `UNKNOWN_EPOCH` / `EPOCH_ROLLBACK` / `FENCE_UNKNOWN_EPOCH` / `FENCE_EPOCH_ROLLBACK` | `MultiWriterLog.append` | 未知 epoch / epoch 回退 |
| `ADJUDICATION_INCOMPLETE` / `ADJUDICATION_INVALID` | `assertAdjudicationComplete`/`adjudicate` | 分支覆盖不全 / 分支或选择非法 |
| `PROJECTION_GATE_FORBIDDEN` | `assertGateBoundary` | 非 committed 状态携带 Gate 证据 |
| `WALL_CLOCK_FORBIDDEN` / `CLOCK_OBSERVATION_INVALID` | `assertLogicalOnlyOrdering`/时钟诊断 | 墙钟键进入排序 / 观测样本非法 |
| `LEASE_EXPIRED`、`HEARTBEAT_QUORUM_LOST`、`NEWER_TERM`、`NEWER_EPOCH_OR_TERM`、`SPLIT_BRAIN`、`REJOIN_NEWER_EPOCH`、`MANUAL` | `leaderStepDownReasons` | leader 降级原因 |
| `RENEWED`、`NOT_LEADER`、`LEASE_EXPIRED`、`NEWER_LEADER`、`QUORUM_LOST` | `leaderLeaseRenewReasons` | `renewLease()` 结果原因 |
| `TCP_CONFIG_INVALID`、`TCP_TLS_REQUIRED`、`TCP_AUTH_UNKNOWN_NODE`、`TCP_AUTH_CHALLENGE_INVALID`、`TCP_AUTH_BAD_SIGNATURE`、`TCP_AUTH_NONCE_REPLAYED`、`TCP_FRAME_INVALID`、`TCP_FRAME_TOO_LARGE`、`TCP_REQUEST_TIMEOUT`、`TCP_NODE_UNAVAILABLE` 等 | `tcpReplicaErrorCodes` | 完整表见 `tcp-transport.ts` |
| `TCP_FAULT_PROXY_CONFIG_INVALID`、`TCP_FAULT_PROXY_NON_LOOPBACK`、`TCP_FAULT_PROXY_RULE_INVALID`、`TCP_FAULT_PROXY_LISTEN_FAILED`、`TCP_FAULT_PROXY_FRAME_INVALID`、`TCP_FAULT_PROXY_FRAME_TOO_LARGE` | `tcpFaultProxyErrorCodes` | 配置/监听/帧边界错误 |

### 明确未实现 / 不得宣称

- **无 daemon、无自动 failover、无自动接管**：恢复动作由调用方显式执行（`elect`/`rejoin`/`restore`）；基准 RTO 含被驱动的 `elect()` 调用，不代表自治切换 SLA。
- **无跨机部署**：所有节点只绑 `127.0.0.1:0`；本地 loopback TCP + 代理协议层注入 ≠ OS 真分区。
- **无跨机时钟回拨验证**：注入时钟只用于租约计时与诊断，不参与版本排序。
- **mTLS**：`TcpReplicaServerOptions.tls.requestCert`/`rejectUnauthorized` 选项存在，但集成测试只覆盖服务端证书校验与错误 trust/hostname 拒绝，未覆盖客户端证书（mTLS）双向认证路径。
- **打包边界**：包 `exports` 只公开 `.` 与 `./package.json`；HA 模块当前是仓库内/深路径库模块（`src/memory/*`，构建到 `dist/memory/*`），不是已发布的稳定公开子路径。
