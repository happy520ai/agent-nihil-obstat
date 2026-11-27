# ADR-012：多主高可用协议契约——提交、Fencing、分叉裁决与逻辑时间边界

日期：2026-11-24
状态：提议（T-133 契约冻结；T-134+ 实现前不得宣称任何多主/选举/时钟能力已存在）
任务：T-133 / M16（chore/P0）
输入契约：`.pm/tasks.json`（M16 T-133~T-141 规划）、`AGENTS.md`、`docs/adr/ADR-005-anchorprobe-memory-revision.md`、`docs/adr/ADR-011-distributed-probe.md`、`docs/distributed-probe.md`、`src/memory/probe-contract.ts`、`src/memory/replication.ts`、`src/memory/replica-transport.ts`、`src/memory/cluster-consistency.ts`、`src/memory/cluster-policy.ts`、`src/ledger/event.ts`

> 编号与定位说明：本 ADR 是 ADR-005（事件不可变/Gate 证据通道）与 ADR-011（单主只读副本）之后的 M16 契约层。它**只冻结一个独立可选协议层的语义**（`src/memory/ha-protocol.ts`：类型 + zod `.strict()` schema + 纯函数 + 单测），不实现 TCP、选举或时钟。ADR-011 的单主前提**不被本任务重写**：未启用本协议的部署继续完全按 ADR-011 运行，已验收的 `child-process` 传输、复制、一致性判定与策略模块一律保留、不回退。冲突处，多主规则仅适用于显式启用 `mwha.protocol.v1` 的部署；其余场景以 ADR-011 为准。

## 1. 背景与问题定义

现状：M15 已验收单主写入 + 只读副本复制（ADR-011 §17）。它没有多主写入、leader 租约 fencing、分叉裁决、逻辑版本比较与时钟诊断的契约；`replication.ts` 的 `seq` 只属于单主规范序，`probe-contract.ts` 的 `cluster_epoch` 只是成员/主身份变化标识。

一句话问题定义：在**不实现网络/选举/时钟、不改账本字节与既有 M15 接口**的前提下，把多主提交所需的 quorum、事件身份绑定、`(term, leaderId)` fencing、分叉全分支保留与裁决完整性、逻辑版本比较、时钟诊断和故障注入词汇，冻结为可执行契约（strict schema + 纯函数 + 单测）与实现者参考。

「修好了」的判据：T-134~T-141 的实现者不需要再做本 ADR 范围内的语义决策；所有不变量都能在 `src/memory/ha-protocol.ts` 找到 strict schema 或纯函数，并在 `test/unit/ha-protocol.test.ts` 找到对应断言；旧账本事件字节与 hash、M15 回归测试不受影响；未验证能力在文档中明文列出。

## 2. 硬边界（全节为硬边界，实现与测试不得违反）

1. **契约层无副作用**：`ha-protocol.ts` 不 import `node:net`/`node:tls`/`node:child_process`/`node:fs`，不调用 `Date.now`/墙钟参与语义；所有排序/裁决只用逻辑字段。
2. **不改账本**：不修改 `src/ledger/**`，不重算、不改写旧事件字节与 `hashEvent` 结果；`ledger_event_hash` 只引用既有哈希。
3. **不破坏 M15**：不删除/改写 `ChildProcessReplicaTransport`、`exportCommittedEvents`/`applyEventBatch`、`anchorProbeClusterMetadataSchema`、`judgeConsistency`、`authorizeReplica` 等既有接口；`docs/distributed-probe.md` 的已验收行为不回退。
4. **严格 schema**：所有消息/配置 schema 一律 `.strict()`；未知字段、缺字段一律 fail-closed；不允许静默默认掩盖缺失。
5. **quorum 只能由 N 派生**：`floor(N/2)+1`，N 为非观察者投票参与者数；不接受任意阈值。
6. **墙钟不是比较键**：逻辑版本只含 `(epoch, commit_index, writer_id, local_seq)`；时钟观测只产诊断标记。
7. **同版本冲突不 LWW**：相同逻辑版本出现多个不同 `ledger_event_hash` 时判 conflict，不按到达顺序或时间选胜。
8. **裁决必须完整**：adjudication 必须引用全部分支 hash，缺一即 schema 失败。
9. **Gate 边界**：`proposed/conflicted/uncommitted/unknown` 状态永不产生 `evidence_id`，`produces_gate_evidence=false`；只有 `committed` 才允许携带 `evidence_id`。
10. **验证范围**：只验证 `local-tcp-protocol-only`；物理三机、OS 真分区、跨机时钟回拨、生产 HA/SLA 均为未验证。
11. **不新增依赖、不写真实配置、不打开 socket**：T-134 之前没有任何网络监听或外发。
12. **故障注入语义**：`delay/drop/duplicate/reorder/disconnect/one-way-partition/bandwidth` 只描述 TCP 协议层可控行为，**≠ OS 真分区**。

## 3. 决定一：角色、拓扑与 quorum

### 3.1 角色表

| 角色 | 是否投票 | 权限 | 明确禁止 |
|---|---|---|---|
| **voting-member** | 是 | 参与选举/提交投票；可承载 writer | 绕过 fencing 提交 |
| **observer（replica）** | 否 | 复制日志、只读服务 | 投票、提交、自封 leader |
| **writer** | 是 | 发起提案；一个 `(epoch, term)` 至多一个 leader | 同 term 多头 |

- N = 非 `observer` 成员数（`voting-member` + `writer`），由 `votingMemberCount` 计算。
- `quorum_size` 必须等于 `quorumSize(N)=floor(N/2)+1`；`mwhaTopologySchema.superRefine` 强制该等式，手写多数派无效。
- N 范围 `[1, 64]`；越界抛 `QUORUM_INPUT_INVALID`。

### 3.2 quorum 表（N=1..5）

| N | Q=floor(N/2)+1 | 可容忍失效数 N-Q | 说明 |
|---|---|---|---|
| 1 | 1 | 0 | 单节点即可提交（仅契约测试用，生产不推荐） |
| 2 | 2 | 0 | **2-2 永不提交**：任一单边 1 票 < 2 |
| 3 | 2 | 1 | 标准最小容错集群 |
| 4 | 3 | 1 | 少数派 2 票拒绝 |
| 5 | 3 | 2 | 两节点失效仍可提交 |

- `isQuorum(votes, n)`：`votes >= Q` 且 `0 <= votes <= n`。
- `assertQuorum`：少数派抛 `QUORUM_NOT_REACHED`。
- `evaluatePartitions(sizes, n)`：返回 `committing_partitions`/`blocked_partitions` 与 `any_commit`。`[1,1]` 对 N=2 的结果是两侧都 blocked；故障节点不并入任何分区。

### 3.3 与 ADR-011 单主的关系

ADR-011 的 `primary/replica/coordinator/operator` 仍适用于默认单主部署。本协议把「writer」定义为可竞选 leader 的投票角色；在未启用 `mwha.protocol.v1` 时，系统行为不变。T-133 不实现选举，只固定「同一 `(epoch, term)` 出现两个 leader 声明即非法」（`detectMultipleLeaders`）。

## 4. 决定二：事件身份与提交

### 4.1 身份绑定

```ts
mwhaEventIdentitySchema = .strict({
  writer_id: identifier,
  epoch: uint,          // 单调，不可回退
  term: uint,           // leader 选举任期
  local_seq: uint >= 1, // writer 在 epoch 内的 1-based 序号
  ledger_event_hash: sha256, // 引用 hashEvent(LedgerEvent)，不重算
})
```

- `ledger_event_hash` 是**引用**：实现者必须从已提交账本事件取 `hashEvent(event)`，禁止在本协议内重排 payload 后重算，保证历史字节/hash 不变。
- 幂等键：`idempotencyKey(identity) = (writer_id, epoch, local_seq)`；内容键：`contentKey(identity) = idempotencyKey + ledger_event_hash`。
- `conflictKeyOf(identity) = (writer_id, epoch, local_seq)`；`term` 与 hash 不参与冲突槽定义。

### 4.2 提交状态与日志条目

- `mwhaWriterEventSchema`（`mwha.event.v1`）：提案信封 `{identity, leader}`；`leader.epoch` 必须等于 `identity.epoch`。
- `mwhaClusterLogEntrySchema`（`mwha.cluster-log-entry.v1`）：`{identity, status, leader, commit_index, conflict_key}`。
  - `proposed/conflicted` 必须 `commit_index=0`；
  - `committed/adjudicated` 必须 `commit_index>=1` 且带 leader；
  - `conflicted` 必须携带与 identity 一致的 `conflict_key`。

### 4.3 重复/乱序归类（纯函数）

- `classifyDelivery(seen, identity)`：同槽同 hash → `duplicate`（零副作用）；同槽异 hash → `conflict`（分叉，不覆盖）；未见 → `fresh`。
- `classifySequence(prev, next)`：`first/contiguous/duplicate-seq/reorder/gap`；gap 只报告不静默跳段。

## 5. 决定三：fencing 与 leader 租约

### 5.1 租约与规则顺序

`mwhaLeaderLeaseSchema = {term, leader_id, epoch}`。`evaluateFence(current, candidate, knownEpochs?)` 固定按以下顺序判定：

| 顺序 | 条件 | code | 语义 |
|---|---|---|---|
| 1 | 租约结构非法 | `FENCE_INVALID` | fail-closed |
| 2 | `knownEpochs` 提供且不含 `candidate.epoch` | `FENCE_UNKNOWN_EPOCH` | 未知 epoch 拒绝 |
| 3 | `candidate.epoch < current.epoch` | `FENCE_EPOCH_ROLLBACK` | epoch 单调不可回退 |
| 4 | `candidate.term < current.term` | `FENCE_STALE_TERM` | 旧 term/旧 leader 写拒绝 |
| 5 | 同 term 不同 leader | `FENCE_SPLIT_BRAIN_SAME_TERM` | 双主非法 |
| 6 | 其余 | `FENCE_OK` | 允许 |

- `assertFence` 在 `allowed=false` 时抛 `HaProtocolError(code)`。
- `detectMultipleLeaders(declarations)` 按 `(epoch, term)` 分组，返回 leader 数 > 1 的组（leader_id 排序，确定性）。

### 5.2 脑裂推论

- N=2 且 1-1 分区：两侧各 1 票 < Q=2，都不能提交；旧 leader 若以新 term 抢写，会撞上 `FENCE_SPLIT_BRAIN_SAME_TERM` 或 `FENCE_STALE_TERM`。
- 任何少于 Q 的分区不得进入 `committed`；未提交内容不得产出 `evidence_id`（第 9 节）。

## 6. 决定四：分叉检测与裁决

### 6.1 分叉定义与全分支保留

- 同一 `(writer_id, epoch, local_seq)` 出现 ≥2 个不同 `ledger_event_hash` 即 conflict。
- `detectForks(entries)` 按冲突槽分组，去重相同 hash，**保留全部相异分支**（`branches` 完整），输出按 hash 代码单元序排序；同时给出 `conflict_keys` 与 `branch_count`。
- 分支 id 由被引用 hash 派生：`makeBranchId(identity, hash) = branch-<hash[0:16]>`，稳定且不可伪造关联。

### 6.2 裁决 schema（缺一即失败）

`mwhaAdjudicationSchema = .strict({ schema_version: mwha.adjudication.v1, conflict_key, branches[], branch_hashes[], status, selected_branch_id, resolution_reason })`，`superRefine` 强制：

1. `branch_id` 唯一；分支 hash 不得重复（相同 hash 是重复不是分支）；
2. `branch_hashes` 无重复，且**恰好等于** `branches[].ledger_event_hash` 集合（缺失/多余都失败）；
3. 每个分支 identity 的冲突槽等于 `conflict_key`；
4. `status=resolved` 必须选择分支且给出 `resolution_reason`；`unresolved` 必须两者皆空。

纯函数 `adjudicationProblems(adjudication, branches?)` / `assertAdjudicationComplete(...)` 提供同一规则的函数式入口（供未过 schema 的进程内对象使用），失败码 `ADJUDICATION_INCOMPLETE`。

### 6.3 确定性合并与 conflicted 投影

- 合并排序键 `mergeSortKey(version) = canonicalJson({epoch, commit_index, writer_id, local_seq})`；`sortLogicalVersions`/`sortEntriesByLogicalVersion` 只用它（同版本再按 hash 代码单元序做稳定展示序）。
- 排序**不代表胜选**：`determineVersionOutcome` 先取最大逻辑版本；若最大版本上出现多个不同 hash，则返回 `conflicted` 与全部冲突 hash，绝不按到达顺序或墙钟选胜。
- `mwhaProjectionStateSchema` 把冲突槽投影为 `{status, winning_branch_id, evidence_id, produces_gate_evidence}`，规则见第 9 节。

## 7. 决定五：逻辑时间与时钟诊断

### 7.1 逻辑版本比较

- `compareLogicalVersion(a,b)` 按 `(epoch, commit_index, writer_id, local_seq)` 字典序返回 `-1/0/1`；相等返回 0。
- 比较函数只读取这四个字段，额外字段（包括 `wall_clock`/`timestamp`）被忽略；`containsWallClockKey`/`assertNoWallClockKey` 提供防御性检查，`mwhaLogicalVersionSchema` 本身 `.strict()`，timestamp 类字段无法进入版本结构。
- 同版本异 hash 由 `determineVersionOutcome` 判 conflict，而不是「最后写入获胜」。

### 7.2 时钟诊断（只读标记）

`classifyClockObservation(observation, policy=MWHA_CLOCK_DEFAULT_POLICY)`，默认阈值：skew 5,000ms、future 5,000ms、jump 60,000ms。

| kind | 判据（固定优先序） | 处理 |
|---|---|---|
| `rollback` | `observed < previous_observed` | 仅诊断 |
| `jump` | 与 reference/previous 的差值 > jump 阈值 | 仅诊断 |
| `future` | `observed > reference + futureTolerance` | 仅诊断 |
| `skew` | 与 reference 差值 > skew 容差且未触发未来/跳变 | 仅诊断 |
| `normal` | 在容差内 | 仅诊断 |
| `unknown` | previous 与 reference 均缺失 | 仅诊断 |

每次输出都带 `diagnostic_only=true`、`affects_commit_order=false`、`affects_fact_version=false`。时钟异常**不改变**提交顺序或事实版本；需要重启/对时时由 T-138 处理，不在本协议内补偿。

## 8. 决定六：故障注入语义

- 固定词汇：`mwhaFaultKinds = ['delay','drop','duplicate','reorder','disconnect','one-way-partition','bandwidth']`。
- `mwhaFaultInjectionSchema.strict({kind, target_member_id, probability, duration_ms})`；未知 kind、概率越界、非正时长一律拒绝。
- 层级常量：`MWHA_FAULT_INJECTION_LAYER='tcp-protocol-simulation'`；`MWHA_FAULT_INJECTION_SCOPE_NOTE` 明示「TCP 协议层故障注入 ≠ OS 真分区」，OS 级分区/内核栈故障/物理链路中断未验证。

## 9. Gate 边界（未提交/冲突不假放行）

`mwhaProjectionStateSchema.superRefine` 结构化强制：

| status | winning_branch_id | evidence_id | produces_gate_evidence |
|---|---|---|---|
| `committed` | 必填 | 必填 | 必须 true |
| `conflicted` | 必须 null | 必须 null | 必须 false |
| `uncommitted` | 必须 null | 必须 null | 必须 false |
| `unknown` | 必须 null | 必须 null | 必须 false |

- `gateEvidenceIssue(state)` / `assertGateBoundary(state)` 提供纯函数入口，失败码 `PROJECTION_GATE_FORBIDDEN`。
- 含义：**未提交提案、少数派分区产物、冲突分支都不产生 `evidence_id`**；远程/多主证据与 ADR-011 §7.3 一样，不能绕过本地或主写复核进入完成通道。

## 10. 验证边界（明确未验证）

- `MWHA_VERIFICATION_SCOPE = 'local-tcp-protocol-only'`。
- `MWHA_VERIFICATION_SCOPE_NOTE` 明示：真实 TCP 帧只在本地回环或受控进程间传输；以下能力**未验证、不得宣称**：
  `physical-three-machine-cluster`、`os-level-network-partition`、`cross-host-clock-rollback`、`production-ha-failover`、`availability-sla`（`MWHA_UNVERIFIED_CAPABILITIES`，`isUnverifiedCapability` 查询）。
- 本 ADR 不承诺 RTO/RPO、不承诺掉电级持久性（沿用 M10/M13 结论）、不防同用户恶意进程（沿用 M10）。

## 11. 验收矩阵（T-133 → 测试名）

| 验收不变量 | 测试名（`test/unit/ha-protocol.test.ts`） |
|---|---|
| N=1..5 quorum=floor(N/2)+1 | `quorum is floor(N/2)+1 for N=1..5` |
| 2-2 永不提交 | `a 2-2 split never commits: each side is a minority of an N=2 cluster` |
| 少数派拒绝 | `minority partitions are refused for N=5 and a majority partition commits` |
| quorum 由拓扑派生、观察者不投票 | `topology quorum is derived from voting members and observers never vote` |
| 旧 term 拒绝 | `stale-term writes are rejected` |
| 旧 leader 写拒绝 | `an old leader is rejected after a newer term exists` |
| 同 term 双主非法 | `two leaders in the same term are illegal (split brain)`、`detectMultipleLeaders reports every same-(epoch,term) split deterministically` |
| epoch 单调 | `epoch rollback is rejected even when the term advances` |
| 未知 epoch fail-closed | `unknown epochs fail closed` |
| 合法续租/升 term 允许 | `a newer term or a newer epoch with the same leader is allowed` |
| 幂等/重复/冲突归类 | `classifyDelivery distinguishes fresh/duplicate/conflict`、`identity keys separate writers/epochs/sequences and bind the ledger hash` |
| 重复/乱序归类 | `classifySequence distinguishes first/contiguous/duplicate/reorder/gap` |
| 逻辑版本字典序 | `compareLogicalVersion orders by (epoch, commit_index, writer_id, local_seq)` |
| 墙钟极端值不改比较 | `extreme wall-clock values never change the logical comparison`、`wall-clock keys are detectable and refusable` |
| 确定性排序与输入顺序无关 | `deterministic sorting is independent of input order` |
| 同版本冲突非 LWW | `same-version hash disagreement is a conflict, never last-write-wins` |
| 分叉保留全分支 | `fork detection retains every competing branch` |
| 裁决完整通过 | `a complete adjudication passes schema and completeness checks` |
| 裁决缺分支拒绝 | `an adjudication missing one branch hash is rejected by the schema`、`adjudication completeness assertion rejects missing or foreign branches` |
| 裁决状态不变量 | `adjudication status/selection invariants are enforced` |
| schema 未知/缺字段/篡改 hash 拒绝 | `event identity schema rejects unknown fields, missing fields and tampered hashes`、`topology schema rejects duplicate members and unknown fields` |
| 日志条目提交/fence/conflict 一致 | `cluster log entry schema enforces commit/fence/conflict consistency`、`writer event schema binds the lease epoch to the identity epoch` |
| Gate 边界 | `projection schema enforces the Gate boundary for every state`、`gate assertions never let a conflicted/uncommitted branch produce evidence` |
| 时钟只产诊断 | `rollback, future, jump, skew and unknown classify without side effects`、`extreme clock values stay diagnostic and invalid observations fail closed` |
| 故障词汇与语义边界 | `fault-injection vocabulary is fixed and scoped to the TCP protocol layer` |
| 边界常量文案含「未验证」 | `verification boundary constants exist and state the unverified capabilities` |

## 12. 文件所有权与 T-134~T-141 并行约束

| 任务 | 独占文件 | 接口/验收 | 并行约束 |
|---|---|---|---|
| T-133（本任务） | `src/memory/ha-protocol.ts`、`test/unit/ha-protocol.test.ts`、`docs/adr/ADR-012-multi-writer-ha.md`、`docs/multi-writer-ha.md` | 本契约；35 个单测全绿；tsc 0；check-docs 通过；M15 回归通过 | 已完成；后续任务只读引用，不改契约除非新 ADR |
| T-134 | `src/memory/ha-transport.ts`（新）、`test/integration/ha-transport.test.ts` | TCP 帧编解码、有界消息、strict 解析 `mwhaWriterEventSchema`/`mwhaClusterLogEntrySchema`；本地回环集成 | 依赖 T-133 契约；独占新文件，可先于选举实现 |
| T-135 | `src/memory/ha-membership.ts`（新）、`test/unit/ha-membership.test.ts` | `mwhaTopologySchema`/`votingMemberCount`/`evaluatePartitions` 落地；成员注册/观察者分离 | 与 T-134 并行（不同文件） |
| T-136 | `src/memory/ha-election.ts`（新）、`test/unit/ha-election.test.ts` | `evaluateFence`/`assertFence`/`detectMultipleLeaders`；单一 leader per `(epoch,term)` | 依赖 T-133；与 T-137 串行或分文件 |
| T-137 | `src/memory/ha-commit.ts`（新）、`test/unit/ha-commit.test.ts` | `isQuorum`/`assertQuorum`、identity 绑定、`classifyDelivery`/`classifySequence`；提交状态机 | 依赖 T-134/T-136 接口 |
| T-138 | `src/memory/ha-adjudication.ts`（新）、`test/unit/ha-adjudication.test.ts` | `detectForks`/`adjudicationProblems`/`assertAdjudicationComplete`/`determineVersionOutcome` | 依赖 T-137；与 T-139 并行 |
| T-139 | `src/memory/ha-clock.ts`（新）、`test/unit/ha-clock.test.ts` | `classifyClockObservation`；只产诊断，不改版本/顺序 | 与 T-138 并行 |
| T-140 | `test/redteam/ha-boundary.test.ts`、`test/integration/ha-chaos.test.ts` | 故障注入词汇、Gate 边界红队、脑裂判定表 | 依赖 T-134~T-139；红队文件独占 |
| T-141 | `README.md`、`docs/usage.md`、`docs/multi-writer-ha.md`、`docs/limitations.md` | 收口与边界声明；全量质量矩阵 | 串行收口；不得宣称未验证能力 |

要点：

1. **契约先于实现**：T-134~T-141 不得修改 `ha-protocol.ts` 的 schema 语义；确需变更必须另立 ADR 并同步单测。
2. **共享文件串行**：`ha-protocol.ts` 归 T-133；T-134/T-135 可并行（transport vs membership），T-136/T-137 以接口为界，T-138/T-139 可并行。
3. **红队独占**：`test/redteam/ha-boundary.test.ts` 由 T-140 创建，其他任务只读。
4. **账本只读**：任何任务不得改 `.ano/ledger` 字节或 `hashEvent` 结果。
5. **文档收口**：`docs/multi-writer-ha.md` 由 T-133 创建、T-141 收口。

## 13. 与既有 ADR 的边界对账

- **ADR-005**：事件不可变、词汇追加式、`memory.*` 幂等与 fail-closed 重建语义不变；本协议只做引用绑定，不改写账本事件；Gate 证据通道规则由 ADR-005 延续（只有 committed 可产 `evidence_id`）。
- **ADR-011**：单主仍是默认且当前唯一已实现路径；`replication.ts`、`replica-transport.ts`、`probe-contract.ts`、`cluster-consistency.ts`、`cluster-policy.ts` 的接口与行为保留。ADR-011 §5 的四模式（LOCAL/AS_OF/COMMITTED/QUORUM）中的「副本」是只读副本；本协议定义的 `observer` 与其对应，而 `voting-member/writer` 是新协议角色，不改变 ADR-011 的单主提交点语义。
- **schema pin**：本任务未新增账本事件 kind、未改 MCP 工具输入 schema，`scripts/check-schema.ts` 的 `PINNED` 无需变更（T-133 仅新增独立模块）。
- **`docs/limitations.md`**：沿用「Gate 身份非密码学签名」「Windows 掉电持久性未验证」「同用户恶意进程不可防」等永久边界。

## 14. 后果

- 实现者获得固定的 quorum、身份绑定、fencing、分叉/裁决、逻辑时间、时钟诊断、故障词汇与 Gate 边界；T-134~T-141 可按第 12 节并行推进。
- 代价：新增一个纯契约层与两份文档；需要后续传输/选举/裁决实现来兑现。换来的是「多主写入可裁决、脑裂可拒绝、时钟异常可诊断、未提交不假放行」的可审查语义。
- 本 ADR 只冻结契约，不声称 TCP、选举、多主提交、跨机或生产高可用已实现；未验证清单以第 10 节与 `MWHA_UNVERIFIED_CAPABILITIES` 为准。
