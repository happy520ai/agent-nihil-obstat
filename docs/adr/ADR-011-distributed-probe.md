# ADR-011：分布式探针——单主写入、只读副本复制与一致性协议

日期：2026-11-24
状态：提议（待主控审阅；审阅通过后置"已接受"并开放 `phase-distributed-probe` 门禁）
任务：T-123 / DC-01（M15）
输入契约：`.pm/tasks.json`（M15 T-123~T-132）、`.pm/roadmap.json`（M15）、`docs/adr/ADR-005-anchorprobe-memory-revision.md`、`docs/adr/ADR-009-project-scan-roots.md`、`docs/adr/ADR-010-structure-intelligence.md`、`docs/structure-intelligence.md`、`src/ledger/event.ts`、`src/ledger/ledger.ts`、`src/ledger/views.ts`、`src/memory/probe-contract.ts`、`src/memory/probe-manifest.ts`、`src/memory/probe-store.ts`、`src/memory/probe.ts`、`src/memory/context-verify.ts`、`src/memory/consumer.ts`、`src/gate/verify.ts`

> 编号说明：本文件是 `docs/adr/` 系列 ADR-005/007/008/009/010 的 M15 后续。ADR-009 固定三根分离与扫描降级；ADR-010 固定结构探查证据与 Gate 边界；本 ADR 在其上叠加「单主写入 + 只读副本复制 + 四种检索模式 + 异步检索契约」，不推翻事件不可变、Gate 证据通道、旧快照兼容等既有约束。冲突处以本 ADR 的「单主写入」「副本只读」「远程证据不进 Gate」为准。

## 1. 背景与问题定义

现状是单节点只读探针：`probe()`（`src/memory/probe.ts`）只消费一个注入的 `ProbeStore`；`SqliteProbeStore`/`ProjectedProbeStore` 都从本地已提交账本重建（`src/memory/probe-store.ts:288/446`）；`ProbeManifestStore` 冻结单份上下文（`src/memory/probe-manifest.ts`）；`verifyContextDraft` 只做本地/调用方注入的 `current_snapshot` 比对（`src/memory/context-verify.ts:474-488`）。它没有副本概念，也没有「多节点对同一事实给出不同版本时如何合并」的契约。

一句话问题定义：在**不改写现有单主账本字节与哈希**的前提下，增加 N≥2 个独立本地进程的只读副本，把「已提交事件」复制到副本，定义 LOCAL/AS_OF/COMMITTED/QUORUM 四种可测试的一致性判定，并用一套明确的异步 scatter/gather/deadline/取消/去重/版本冲突/partial 契约对外提供检索；任何时刻副本都不写权威账本，任何远程证据都不得直接进 Gate。

「修好了」的判据：T-124~T-132 的实现者不需要再做本 ADR 范围内的语义决策；验收可直接按第 12 节矩阵与 `docs/distributed-probe.md` 的可执行断言编写；跨机、生产高可用、多主写、远程证据进 Gate 明确标注为**未支持且不宣称**。

## 2. 硬边界（全节为硬边界，实现与测试不得违反）

以下 12 条来自用户首版硬边界与 M15 目标，与 ADR-005/009/010 一致；任一条被违反即视为实现错误，而不是配置问题：

1. **单主写入**：一个部署内只有一个主 Ledger 写入者（primary）；副本只读，**永不写权威账本**；拒绝第二主写者声明与任何副本写请求。
2. **复制对象**：只复制**已提交事件**（committed events），不复制未提交/在途批次；每个部署至少 **2 个独立本地进程**只读副本，副本使用独立存储路径。
3. **检索模式**：LOCAL / AS_OF / COMMITTED / QUORUM 四种，语义可测试且互斥可判定；不一致时返回 partial/unknown，**禁止返回「全量健康」**。
4. **异步语义**：异步 ≠ 实时一致；必须支持 scatter、gather、deadline、取消、去重、版本冲突、partial 七项。
5. **降级**：副本不可用时降级到本地 `ProbeStore`；一致性复核只用**本地或主写的 `current_snapshot`**；Gate 只信本地/主写复核结论。
6. **禁止**：多主写；混合 commit（本地与远程证据混入同一结论）；远程证据**直接进 Gate**。
7. **跨机器**：只留传输扩展接口，**不宣称支持跨机**，**不宣称生产高可用**。
8. **安全**：项目/副本授权；秘密路径与内容最小化；副本撤销与清理；远程 payload 不可信且**不可执行**；**默认不外发**；不读取或上传真实秘密。
9. **兼容**：现有账本事件字节与 hash 不变；旧快照/旧 Gate/旧 explore 兼容；schema pin 同步。
10. **不新增第八个 MCP 工具**：七工具数量与输入 schema 不变；副本/一致性能力经既有 `recall`/`explore`/`brief` 投影或库级 API 暴露。
11. **不宣称实时一致**：副本可落后；落后量必须显式报告为 `max_lag`/partial 原因。
12. **只读源码树**：复制只读已提交账本事件，不读磁盘源文件、不读 `.env/keys/secrets`、不写业务项目；集群元数据只落 `.ano/cluster/`。

**自动工作流与人工动作的区分**：复制、重建、scatter/gather、一致性判定、降级、撤销属于自动工作流；主写授权、副本注册/撤销批准、Gate 批准/attest/approve/cutover 仍是具名人工动作。本 ADR 不新增任何写用户级配置或业务数据的路径。

## 3. 决定一：角色与写入模型

### 3.1 角色表

| 角色 | 数量 | 存储 | 权限 | 明确禁止 |
|---|---|---|---|---|
| **primary（主写）** | 恰好 1 | `<root>/.ano/ledger`（权威）+ `<root>/.ano/cache/views.db` | 读已提交事件；写事件（唯一）；导出已提交事件；签发副本能力 | 把副本声明当授权；跳过幂等/锁 |
| **replica（只读副本）** | N ≥ 2 | 各自独立 `<root>/.ano/cluster/replicas/<replica_id>/`（含副本 DB 与 cursor） | 接收已提交事件；本地重建 Memory/Probe 视图；响应只读查询；上报 cursor/摘要 | 调用 `Ledger.append`；写主账本段；自封 primary |
| **coordinator（协调器）** | 0..1（可内嵌 primary 进程） | 内存 + 只读集群快照 | scatter/gather；判定四模式；执行降级；生成 `evidence_digest` | 把远程证据当本地证据；自动选最新分歧版本 |
| **operator（具名人工）** | — | `.ano/cluster/cluster.json` 策略记录 | 注册/撤销副本；批准主写；审计 | 由远程 payload 代批 |

### 3.2 单主唯一性如何保证（三层，明确拒绝第二主写者）

1. **结构层（代码面）**：副本侧 API 不暴露写路径。`ReplicaTransport`/`ReplicaHandler` 只接受 `handshake`、`pull-events`、`query`、`status`、`close` 五类消息；不存在 `append`/`write` 消息类型。收到写意图消息一律返回 `REPLICA_WRITE_REFUSED`，且不落任何字节。
2. **策略层（注册面）**：primary 身份 = `{ root: canonical realpath, actor, session_id }`，登记于 `.ano/cluster/cluster.json` 的 `primary` 字段；`cluster_epoch` 在成员/主身份变化时由 primary 递增（新 ULID）。任何节点以 `role='primary'` 发起 `cluster.primary.register` 时，若已有不同 `{actor, session_id}` 的活跃 primary 且其心跳未过期，则拒绝并报 `PRIMARY_ALREADY_ACTIVE`；相同身份重连视为续租（幂等）。
3. **检测层（对账面）**：副本每次拉取都校验 `cluster_epoch` 与 primary 声明；发现 `cluster_epoch` 变化或 `segment.started` 的 `observed` 头集合出现非本簇写入者时，标记 `cluster_state=FOREIGN_WRITER_SEEN` 并停止自动合并，等待 operator 处理。这是**检测与拒绝**，不是加密学证明：本 ADR 不声称能阻止同机同用户恶意进程直接打开账本目录写入（该边界沿用 M10「不承诺防御同用户恶意进程」）。

> 与既有账本并发模型的关系：`Ledger.append` 仍保留多会话分段与 `BEGIN IMMEDIATE`（`src/ledger/ledger.ts:494/527`）。本 ADR 的「单主」是**集群部署策略**，不改造账本为单写者；它约束的是「分布式探针集群声明的主写者唯一」，不是「全机任何进程只能有一个 Ledger 实例」。

### 3.3 副本只读（永不写回）

- 副本从 primary 导出流读取 `{ event, seq }`，只写入自己的 `<replica_dir>/replica.db`（缓存/派生数据），绝不写 `<root>/.ano/ledger`。
- 副本对外查询返回的是**派生投影**，带 `evidence_origin='replica'` 与 `replica_id`；它不能产生 `evidence.recorded`/`verify.finished` 等 Gate 完成通道事件。
- 副本重启/重建只影响自身 cursor；重建后 `view_digest` 必须等于 primary 同 `commit_index` 的 `viewDigest(entries)`，否则 fail-closed（第 4.4 节）。
- 副本数据是**可删除派生物**：位于 `.ano/cluster/replicas/`，不属于权威备份；删除不影响主账本（与 `SqliteProbeStore` 同为可重建缓存，见 `src/memory/probe-store.ts:440-445`）。

## 4. 决定二：复制协议

### 4.1 复制单位与提交点

复制单位 = **单个已提交事件**，信封字段固定为：

```ts
interface CommittedEvent {
  event: LedgerEvent;   // 原样字节，含 id/hlc/actor/kind/payload/idem_key/prev_hash
  seq: number;          // 1-based，主写规范序中的提交序号
}
```

「已提交」的判据（与 `Ledger.append` 语义一致）：

- 事件已出现在 primary 的 `replayLedger` 结果中（`.ano/ledger` 段已完成原子追加），或在 primary 当前已提交的内存批次中且对应视图已 `COMMIT`；
- **不含**仅写入 SQLite 视图但未落段的在途状态；
- 导出动作在 primary 的 views 锁内读取，避免读到半截尾批（沿用 `src/ledger/ledger.ts:466-480` 的双锁次序）。

主写规范序定义：`entries = replay.entries`（`ViewReplayEntry[]`，HLC 规范序）。`seq = index + 1`。该序与 `viewDigest(entries)`（`src/ledger/views.ts:167`）一一对应，因此 `(commit_index, view_digest)` 是唯一、可重算的提交点。

### 4.2 游标与增量导出

副本 cursor（持久化于 `<replica_dir>/cursor.json`）：

```ts
interface ReplicaCursor {
  replica_id: string;
  cluster_epoch: string;
  commit_index: number;      // 已应用的最大 seq
  last_event_id: string;     // Crockford ULID
  last_hash: string;         // hashEvent(已应用最后事件)
  updated_at: string;        // ISO-8601
}
```

导出请求：

```ts
interface ReplicationPullRequest {
  replica_id: string;
  cluster_epoch: string;
  from_commit_index: number;   //  exclusive：请求 seq > from_commit_index
  max_events: number;          // 有界，默认 256，上限 1024
}
interface ReplicationPullResponse {
  cluster_epoch: string;
  primary_commit_index: number;
  events: CommittedEvent[];    // 严格按 seq 升序，最多 max_events
  truncated: boolean;          // 还有更多事件
}
```

复制是**惰性/异步**的：primary 不主动推送；副本按自身节奏 pull，允许落后任意多个事件。滞后量 `lag = primary_commit_index - replica.commit_index`，聚合为 `max_lag = max(lag)`；`lag` 未知时置 `null` 并标 `partial=true`。

### 4.3 幂等、缺段、乱序、损坏

副本应用算法（确定性、可重入）：

1. **幂等去重**：同 `event.id` 已应用且 `hashEvent(event)` 相同 → 零副作用返回 `duplicate:true`；同 id 不同 hash → `REPLICA_EVENT_CONFLICT`，副本进入 `SUSPECT` 并停止续传。
2. **链校验**：`prev_hash` 必须等于本地已应用前缀的最后哈希（复用 `eventChain` 语义，`src/ledger/event.ts:70`）；不符 → `REPLICA_CHAIN_BREAK`，fail-closed。
3. **乱序**：收到 `seq` 大于本地下一期望值时，**缓冲**该事件并标记 `gap=[expected..seq-1]`；**不静默跳段**、不按到达顺序覆盖。缓冲区有界（默认 4096 事件 / 16 MiB），超限 → `REPLICA_BUFFER_EXCEEDED`，停止并报告。
4. **缺段**：只要存在未填的 gap，副本对外状态为 `LAGGING`/`PARTIAL`，查询结果的 `retrieval_completeness` 不得为 `COMPLETE_WITHIN_DECLARED_SCOPE`；缺口清单进入 `partial.gaps`。
5. **续传**：副本用 `from_commit_index = 已应用最大连续 seq` 重新 pull，直到 gap 填满；恢复后重算 `view_digest` 并与 primary 同提交点比对。
6. **损坏**：hash 不匹配、payload strict 校验失败、投影重放抛 `LedgerIntegrityError` → 副本 `SUSPECT`，丢弃未提交批次（只回滚副本自身缓存），保留现场供审计；**不得**把损坏事件并入视图后继续服务。

### 4.4 副本重建（视图等价）

副本重建只使用已提交事件，路径与既有 P0 完全一致：

- `initViews(db)` / `applyEventToDb(db, entry.event, entry.segment)` 重放（`src/ledger/views.ts:169/232`）；
- 或 `ProjectedProbeStore.create(entries, snapshot)`（`src/memory/probe-store.ts:298`）。

等价判据：副本在 `commit_index=C` 时的 `viewDigest(entries[0..C])` 必须等于 primary 在 C 的 `view_digest`；不等即 `VIEW_DIGEST_MISMATCH`，副本视图不可用于 QUORUM 计数。副本的 `snapshot`（四摘要）必须由自己应用的事件重新采样，**不得直接采信 primary 下发的 snapshot 字段**，除非逐字段与本地重算一致。

### 4.5 复制方向与默认不外发

- 方向：primary → replica 单向 pull；副本永不 write-back（第 3.3 节）。
- 默认传输：本机子进程 stdio（`child-process`）或同进程注入（`in-process`，仅测试）。**无监听端口、无网络外发**；任何网络 transport 均为未实现且不启用。
- 复制内容最小化：只复制已提交 ledger 事件；不读取磁盘源码、manifest 文件、`.pm/`、Connect 历史；事件内的自由文本按第 9 节秘密筛查后再决定是否随副本下发。

## 5. 决定三：一致性模型（四模式）

### 5.1 模式判定表（互斥、可计算）

设 `N` = 已注册副本数，`Q = ceil((N+1)/2)`，`C` = primary 当前 `commit_index`。每个副本 `r` 有 `(r.commit_index, r.evidence_digest, r.state)`。`evidence_digest` 是对**有界候选集**计算的 sha256（见 5.2），同提交点同视图必同摘要。

| 模式 | 判定条件 | 证据来源 | 允许的结论 | 不一致时的返回 |
|---|---|---|---|---|
| **LOCAL** | 不依赖任何副本；只看本地 `ProbeStore`/`ProjectedProbeStore` 的 `snapshot` 四摘要 | 本地存储快照（`local`） | 「本地在该快照内完整/不完整」；**不声称**与 primary 一致或新鲜 | 本地不可用/降级 → `PARTIAL`/`UNKNOWN` + `failed_nodes=['local']` |
| **AS_OF** | 指定提交位置 `C*`（或快照时间映射到 `C*`）；至少一个副本 `r.commit_index >= C*` 且其 `view_digest` == primary 在 `C*` 的 `view_digest` | primary 提交点 + 达标副本（`replica`） | 「在 C* 这一点，副本与主写视图一致」 | 无副本达到 C* 或 digest 失配 → `UNKNOWN`/`PARTIAL`，标注 `stale`/`lag` |
| **COMMITTED** | primary 提交点 `C` 已落盘；至少 **1** 个副本 `r.commit_index >= C` 且 `evidence_digest` 与 primary 重算一致 | primary + ≥1 副本 | 「已提交且至少一份副本达到该提交点」 | 无副本追平 → `PARTIAL`，`stop_reason=QUORUM_UNMET`（此处即 lag 不足），不得报「全量健康」 |
| **QUORUM** | ≥ `Q` 个副本满足 `r.commit_index == C_q` 且 `evidence_digest` 完全相同（`C_q <= C`）；primary 提供 `C` 作为上界 | ≥Q 副本 + primary 上界 | 「多数副本在同一提交点达成一致」 | 达标副本 < Q、或同提交点 digest 分歧、或有节点 failed/lagging → `PARTIAL` + `failed_nodes`/`conflicts`，**不自动选最新** |

### 5.2 证据摘要（bounded，可重算）

`evidence_digest = sha256(canonicalJson(X))`，其中 `X` 为**有界**结构：

```ts
X = {
  mode,                 // LOCAL | AS_OF | COMMITTED | QUORUM
  cluster_epoch,
  commit_index,
  view_digest,          // viewDigest(entries) at commit_index
  candidate_fingerprints: [   // 排序后取前 K（K=min(1024, budget.max_candidates)）
    { record_ref, content_hash, fact_key, status }
  ],
  failed_nodes,
}
```

- 摘要输入**不含**自由文本内容，避免无界与敏感外泄（满足 T-124「副本摘要不能混合无界」）。
- 副本必须能用本地投影重算同一摘要；QUORUM 比较只比 `evidence_digest` + `commit_index`，不比未截断的全量内容。
- `candidate_fingerprints` 排序固定：`record_ref` 字典序；同 `record_ref` 取 `content_hash` 字典序，保证确定性。

### 5.3 不一致与 partial/unknown

- 任一模式在无法满足判定条件时，返回 `consistency_status` 为 `PARTIAL` 或 `UNKNOWN`，并携带 `reason`（枚举见第 11 节）与 `partial.coverage`/`partial.gaps`/`partial.failed_nodes`。
- **禁止**把「部分副本健康」表述成「全量健康」；`COMPLETE_WITHIN_DECLARED_SCOPE` 只在 LOCAL 且无降级、或 QUORUM 达标且无 failed 节点时允许。
- **混合 commit 禁止**：一条结论必须有单一 `evidence_origin`（`local` | `primary` | `replica`）；同一结论同时引用本地与远程证据 → `MIXED_EVIDENCE_REJECTED`。需要交叉验证时，分两阶段：先各自出结论，再由本地/主写复核（第 7 节），不在同一结论里混用。

## 6. 决定四：异步检索契约（七项）

### 6.1 契约表

| 契约 | 定义 | 失败/边界行为 |
|---|---|---|
| **scatter** | 协调器向所有 `ACTIVE` 副本（可选含本地/primary）**并行**发出同一查询；单节点预算独立计时 | 单节点超时不阻塞其他节点；返回已完成部分 |
| **gather** | 按 `(record_ref, content_hash)` 归并；同一键多副本只计一次；输出稳定排序（`record_ref`、`content_hash` 字典序） | 归并不吞冲突；冲突进入 `conflicts` |
| **deadline** | 总墙钟预算（默认 50s，必须小于 MCP 60s 超时，沿用 ADR-009 §8.1）；超时返回 `partial` + 已完成部分 + `elapsed_ms` | 不得无限等待；`files/candidates=0` 不得冒充正常 |
| **取消** | 接受 `AbortSignal`；取消后停止派发新请求、中断在飞请求、关闭本轮子进程句柄；不得泄漏半边状态或孤儿进程 | 取消结果可返回 `CANCELLED`，但必须报告已释放的资源 |
| **去重** | 同一 `event.id` 多副本只计一次；候选去重键 = `record_ref + content_hash` | 重复不得放大计数或重复计入 quorum |
| **版本冲突** | 不同副本对同一 `fact_key`/`record_ref` 给出不同 `content_hash` 或不同 `version` → 显式 `conflict`（`unresolved`），列出来源副本与摘要；**不自动选最新** | 冲突未解时 `coverage_gate.status` 不得为 `SUFFICIENT` |
| **partial** | 输出覆盖度（`considered/requested`）、缺口（`gaps`）、停止原因（`stop_reason`）；`retrieval_completeness ∈ {COMPLETE_WITHIN_DECLARED_SCOPE, PARTIAL, UNKNOWN}` | 任何截断必须显式；禁止静默删减后声称完整 |

### 6.2 与既有 probe 语义的关系

- 协调器**复用** `probe()` 的路由、版本投影、覆盖门与别名语义（`src/memory/probe.ts`）；分布式层只增加 scatter/gather/一致性元数据，不重写遍历。
- 单副本查询仍可走既有 `ProbeStore` 接口（`snapshot/candidates/adjacency/evidence/status/provenance/snapshotIdentity`，`src/memory/probe-store.ts:100-119`）；副本即一个 `ProbeStore` 实现。
- AP-02 响应（`anchorprobe.context.v1`）保持形状不变；分布式信息放在新增的 `DistributedProbeAnswer.metadata` 中，旧消费者忽略该字段仍可解析。
- 既有 `temporal_mode`（CURRENT/AS_OF/HISTORICAL，`src/memory/probe-contract.ts:32`）与新增 `retrieval_consistency_mode`（LOCAL/AS_OF/COMMITTED/QUORUM）**正交**：后者描述证据来自哪里、一致到什么程度；前者描述业务生效时间语义。命名冲突在文档中显式区分，字段名不得复用。

## 7. 决定五：降级与复核

### 7.1 副本不可用 → 本地 ProbeStore

- 任一副本 `FAILED`/`SUSPECT`/心跳超时 → 从 scatter 集合剔除，记入 `failed_nodes`。
- 全部副本不可用 → 降级到本地 `ProbeStore`（`SqliteProbeStore.open(root)` 或 `ProjectedProbeStore`），结果 `mode=LOCAL`、`degraded=true`、`failed_nodes=[...]`。
- QUORUM 因节点失败无法满足时，允许**显式降级**为 COMMITTED（仍有 ≥1 副本）或 LOCAL（无副本），但结论必须标注实际达到的模式与降级原因；**不得**用降级后的结果冒充原请求模式。

### 7.2 一致性复核只用本地或主写 current_snapshot

- 任何要用于**当前执行依据**的结论，在执行前必须由**本地或主写**重新采样 `current_snapshot`（四摘要：`ledger_digest`/`graph_revision`/`source_fingerprint`/`connected_digest`，`src/memory/probe-contract.ts:106-114`）并比对。
- 失配 → 阻止当前执行依据，返回 `SNAPSHOT_MISMATCH`；历史证据（AS_OF）不能升级为当前执行依据（沿用 ADR-005 §9）。
- 远程副本的 `snapshot` 只用于副本一致性判定（第 5 节），**不得**作为 `current_snapshot` 注入 `verifyContextDraft`；`verifyContextDraft` 的 `current_snapshot` 参数只接受本地/主写来源。

### 7.3 Gate 边界

- Gate 证据通道只接收本地/主写复核结论；远程证据**不产生 `evidence_id`、不进 `verdict.structure` 之外的完成通道**，不触发 done/approve/cutover（沿用 ADR-005 §2.10、ADR-010 §6）。
- 副本查询可用于「候选召回」和「覆盖率对照」，但其结论在进入 Gate 前必须经本地/主写复核；红队须验证伪造副本不能让 Gate 假放行。
- `consumer.runConsumer` 的 re-sample 适配器（`src/memory/consumer.ts:267-270`）只注入本地/主写 sample；禁止把副本 sample 接进该端口。

## 8. 决定六：远程不可信边界与传输扩展接口

### 8.1 远程 payload 不可信、不可执行

- 副本返回的一切字节都是**不可信数据**：只按严格 schema 解析（`.strict()`，未知字段拒绝），只作为数据参与摘要比对；**不可执行、不可直接引用、不解包即用**。
- 禁止 `eval`/`new Function`/`import()`/动态 `require` 处理 payload；禁止把 payload 路径字符串直接拼进文件系统操作（路径必须相对副本根且做穿越校验）。
- 副本声明的 `project_scope`、`authorization`、`commit_index`、`evidence_digest` 一律不与采信：一律用 primary 侧策略与本地重算校验。远程不能提升权限。
- 消息大小有界（默认请求 ≤ 8 MiB、响应 ≤ 16 MiB）、数组长度有界、深度有界；超限 → `PAYLOAD_LIMIT_EXCEEDED`，不静默截断。

### 8.2 传输扩展接口（仅预留）

```ts
export interface ReplicaTransport {
  readonly kind: 'in-process' | 'child-process';   // 本版仅这两种；'tcp'/'websocket' 未实现
  start(options: ReplicaStartOptions): Promise<ReplicaHandle>;
  stop(handle: ReplicaHandle): Promise<void>;      // 幂等；关闭不泄漏进程
  query(handle: ReplicaHandle, request: ReplicaQueryRequest): Promise<ReplicaQueryResponse>;
}
```

- 接口仅为未来跨机实现预留；本版**不提供**网络实现、不监听端口、不做服务发现。
- 消息协议（T-127 实现）必须严格 schema 化，握手先交换 `cluster_epoch` 与副本能力；握手失败即拒绝，不进入查询。
- **不宣称支持跨机**、**不宣称生产高可用**；性能与可用性数字只来自本机多进程实测（T-131）。

## 9. 决定七：安全与隐私（四项）

1. **项目/副本授权**：策略存 `<root>/.ano/cluster/policy.json`，条目含 `principal_id`、`role`、`allowed_scopes`、`allowed_replica_ids`、`operations`、`expires_at`。操作至少分：`cluster.primary.register`、`cluster.replica.register`、`replica.probe.read`、`replica.replicate.pull`、`cluster.replica.revoke`、`cluster.audit.read`。授权判定在 primary/本地完成；副本必须在册且 scope 匹配才被查询；跨 scope → `SCOPE_DENIED`；未授权副本 → `REPLICA_NOT_AUTHORIZED`。
2. **秘密路径与内容最小化**：复制源只读已提交 ledger 事件；**不读取** `.env*`/`*.pem`/`*.key`/secrets/credentials 等路径（沿用 ADR-009 §5.2 与 `src/connect/backup.ts` 敏感策略）；事件内文本先过秘密模式筛查（如私钥头、token 前缀、`credential` 字段），命中则 `content_redacted=true` 并审计；外发只含必要证据（id/hash/seq/摘要/引用），自由文本非必要不下发。
3. **副本撤销与清理**：`revoke(replica_id)` 写审计记录（who/when/reason）、将副本置 `REVOKED`、停止查询、删除 `<root>/.ano/cluster/replicas/<replica_id>/` 下派生数据（主账本不受影响）；已撤销副本的 cursor/摘要立即失效，其历史证据不得再被引用；清理动作可重复（幂等）。
4. **默认不外发**：无网络监听、无自动上传、无后台守护；副本注册与 pull 由本地 operator/协调器显式发起；任何跨机传输能力默认关闭且未实现。

> 与 M10/M12 一致：授权是本地策略记录，不是 token，不改变宿主权限；本 ADR 不读取真实秘密、不写真实业务项目。

## 10. 决定八：兼容与证据

### 10.1 旧账本字节/hash 不变

- 不新增必需事件字段、不重排事件词汇；如确需新 kind，只能在 `ledgerEventKinds`（`src/ledger/event.ts:10-44`）**尾部追加**，并同步 `scripts/check-schema.ts` 的 `PINNED.ledgerEvents`/`PINNED.ledgerKinds`。本 ADR 优先把集群元数据放在 `.ano/cluster/*.json` 与快照扩展块中，**尽量避免**新增事件 kind。
- 复制只读事件，不改写 `.ano/ledger` 任何字节；`hashEvent`/`canonicalJson` 结果对历史事件完全不变。

### 10.2 旧快照/旧 Gate/旧 explore 兼容

- 既有 `anchorProbeSnapshotSchema` 四摘要字段保持不变；新集群字段放在 `ClusterSnapshot`（新版本号 `anchorprobe.cluster.v1`）中，旧快照经 adapter 投影为新结构时补默认值（`cluster_epoch=''`、`consistency='LOCAL'`、`partial=true`），旧消费者行为不变。
- 既有 AP-02 请求/响应 schema 不变；分布式元数据为叠加字段，缺省即旧语义。
- 旧 Gate 证据语义、`verification` 元数据形状、`CoveragePolicy` 不变（ADR-010 §6）。
- 旧符号级 `explore` 行为不回归（ADR-009/010）；文件级探查投影不受影响。

### 10.3 schema pin 同步

任何 payload/schema/kind 变更必须运行 `node scripts/check-schema.ts --print`，显式更新 `PINNED`；工具 hash 不变（不新增工具）。这是显式 schema 变更，不得隐式漂移。

## 11. 状态枚举与错误码

### 11.1 集群状态（固定）

| 状态 | 含义 |
|---|---|
| `ACTIVE` | 副本可达且 cursor 有效 |
| `LAGGING` | 可达但 `lag>0` 或有未填 gap |
| `JOINING` | 正在首次重建，尚不可服务 |
| `SUSPECT` | 检测到 hash/链/投影失配，已停止合并 |
| `FAILED` | 心跳/查询失败 |
| `REVOKED` | 已撤销，不再被查询，等待清理 |

顶层一致性结论：`CONSISTENT` / `PARTIAL` / `UNKNOWN` / `DEGRADED`。

### 11.2 错误码（新增，均 fail-closed）

| 错误码 | 触发 | 处理 |
|---|---|---|
| `PRIMARY_ALREADY_ACTIVE` | 第二主写者注册 | 拒绝，保留原 primary |
| `REPLICA_WRITE_REFUSED` | 副本发起写 | 拒绝，零字节落盘 |
| `CLUSTER_EPOCH_MISMATCH` | 副本 epoch 与 primary 不同 | 拒绝合并，要求重新握手 |
| `FOREIGN_WRITER_SEEN` | 观察到非本簇写入者 | 停止自动合并，等待 operator |
| `REPLICA_EVENT_CONFLICT` | 同 id 不同 hash | 副本 SUSPECT |
| `REPLICA_CHAIN_BREAK` | `prev_hash` 断裂 | 副本 SUSPECT |
| `REPLICA_BUFFER_EXCEEDED` | 乱序缓冲超限 | 停止续传，报 gap |
| `VIEW_DIGEST_MISMATCH` | 副本视图摘要与 primary 不符 | 该副本不计入 quorum |
| `MIXED_EVIDENCE_REJECTED` | 同一结论混入本地/远程证据 | 拒绝该结论 |
| `QUORUM_UNMET` | 达标副本数 < Q | 返回 PARTIAL + failed_nodes |
| `SCOPE_DENIED` / `REPLICA_NOT_AUTHORIZED` | 跨 scope / 未授权副本 | 拒绝查询 |
| `PAYLOAD_LIMIT_EXCEEDED` | 消息/数组/深度越界 | 拒绝，不截断 |
| `SNAPSHOT_MISMATCH` | 本地/主写 current_snapshot 失配 | 阻止当前执行依据 |
| `REMOTE_EVIDENCE_GATE_REJECTED` | 试图把远程证据送入 Gate | 拒绝，不产生 evidence_id |

## 12. 验收矩阵（T-124~T-132）

| 任务 | 交付 | 证据类型 | 本 ADR 对应条款 | 未验证边界 |
|---|---|---|---|---|
| T-124 | 集群快照/提交点/证据元数据（probe-contract/manifest/store + 单测） | 单元 | §5.1/5.2、§10.2 | 不改旧 AP-02 形状；摘要有界 |
| T-125 | 已提交事件复制与只读副本重建（replica/replication + 单测/集成） | 单元 + 集成（同机导出导入） | §4.1-4.4 | 真实跨进程崩溃恢复留 T-127 |
| T-126 | 异步协调器 + 本地降级（distributed-probe/probe + 单测） | 单元（模拟慢/坏节点） | §6、§7.1 | 真实进程故障留 T-127/T-130 |
| T-127 | 真实本地多进程副本传输与生命周期（worker/transport + 集成） | 集成多进程（≥2 真实子进程） | §8.2、§3.2 | 跨机、端口监听未实现 |
| T-128 | 一致性判定与主写/本地复核门（cluster-consistency/context-verify/consumer + 单测/集成） | 单元 + 集成（分区/多数派） | §5、§7.2/7.3 | 无网络分区（本机进程级模拟） |
| T-129 | 授权/隐私/撤销（cluster-policy + 单测 + 红队） | 单元 + 红队 | §9 | 非密码学授权；不防同用户恶意进程 |
| T-130 | 故障/分区/乱序/投毒红队（chaos + 红队） | 集成混沌 + 红队 | §4.3、§6、§8.1 | 不掉电持久性沿用未验证 |
| T-131 | 同语义性能/召回/尾延迟对照（benchmark + 证据文档） | 基准 | §6、§8.2 | 不承诺倍数/线性扩展/跨机收益 |
| T-132 | 最终质量/文档/能力边界（README/usage/distributed-probe/limitations/evidence） | 文档 + 全量质量矩阵 | 全文 | 跨机/多主/生产高可用/远程进 Gate 明确未实现 |

## 13. 文件所有权与并行约束（T-124~T-132）

| 任务 | files（任务簿原样） | 独占职责 / 本 ADR 接口 |
|---|---|---|
| T-123 | `docs/adr/ADR-011-distributed-probe.md`、`docs/distributed-probe.md` | 本契约；T-123 创建实现者参考，T-132 收口更新（串行） |
| T-124 | `src/memory/probe-contract.ts`、`src/memory/probe-manifest.ts`、`src/memory/probe-store.ts`、`test/unit/memory-probe-contract.test.ts`、`test/unit/probe-manifest.test.ts` | 集群快照类型与 adapter；`cluster_epoch/commit_index/replica_id/replica_commit_index/consistency/max_lag/partial/failed_nodes/evidence_digest`；旧快照兼容 |
| T-125 | `src/memory/replica.ts`、`src/memory/replication.ts`、`test/unit/memory-replica.test.ts`、`test/integration/memory-replication.test.ts` | 提交点导出、cursor、幂等/乱序/缺段/损坏、副本重建 |
| T-126 | `src/memory/distributed-probe.ts`、`src/memory/probe.ts`、`test/unit/distributed-probe.test.ts` | scatter/gather/deadline/取消/去重/版本冲突/partial；本地降级；路由 |
| T-127 | `src/memory/replica-worker.ts`、`src/memory/replica-transport.ts`、`test/integration/replica-process.test.ts` | 子进程承载副本、生命周期、传输接口实现、消息边界 |
| T-128 | `src/memory/cluster-consistency.ts`、`src/memory/context-verify.ts`、`src/memory/consumer.ts`、`test/unit/cluster-consistency.test.ts`、`test/integration/replica-consistency.test.ts` | 四模式判定、max_lag、mixed-commit 拒绝、current_snapshot 复核、Gate 边界 |
| T-129 | `src/memory/cluster-policy.ts`、`test/unit/cluster-policy.test.ts`、`test/redteam/distributed-probe-boundary.test.ts` | 授权/最小化/撤销清理；红队共同文件与 T-130 串行或分区 |
| T-130 | `test/integration/replica-chaos.test.ts`、`test/redteam/distributed-probe-boundary.test.ts` | 故障/分区/乱序/投毒红队；依赖 T-129 |
| T-131 | `scripts/benchmark-distributed-probe.ts`、`test/benchmark/distributed-probe.bench.ts`、`docs/evidence/distributed-probe-benchmark.md` | 同语义对照与实测 |
| T-132 | `README.md`、`docs/usage.md`、`docs/distributed-probe.md`、`docs/limitations.md`、`docs/evidence` | 终对账与文档收口；不宣称跨机/多主/生产高可用 |

### 13.1 并行约束（实现者必读）

- **契约先于实现**：T-124 先固定集群快照/摘要/游标类型与旧快照 adapter，T-125/T-126/T-128 才可实现；不得反向改契约。
- **共享文件串行**：`src/memory/probe.ts` 归 T-126；`context-verify.ts`/`consumer.ts` 归 T-128；`probe-contract.ts`/`probe-manifest.ts`/`probe-store.ts` 归 T-124。
- **传输接口由本 ADR 冻结**（§8.2 签名）；T-126 与 T-127 可并行：T-126 面向 `ReplicaTransport` 编程，T-127 实现 `child-process`/`in-process`。
- **红队文件共享**：`test/redteam/distributed-probe-boundary.test.ts` 由 T-129 创建、T-130 追加；须串行或按 describe 区块约定，禁止并发写。
- **文档**：`docs/distributed-probe.md` 由 T-123 创建、T-132 收口；其余文档由 T-132 统一更新。
- **账本只读**：任何任务不得改 `.ano/ledger` 字节；T-125 的导出器只读。

## 14. 测试与验收判据（含明确未验证边界）

- **单主**：第二 primary 注册被拒（`PRIMARY_ALREADY_ACTIVE`）；副本写消息被拒（`REPLICA_WRITE_REFUSED`）；副本目录无主账本段写入。
- **复制**：空副本重建到同一 `commit_index` 时 `view_digest` 等于 primary；重复事件零副作用；乱序/缺段报告 gap 且不静默跳；篡改 hash/链 fail-closed；断点续传恢复。
- **四模式**：LOCAL 不依赖副本；AS_OF 绑定指定提交点；COMMITTED 需 ≥1 副本追平；QUORUM 需 ≥Q 同提交点同摘要；任一不满足返回 PARTIAL/UNKNOWN，绝不报全量健康。
- **异步七项**：scatter 并行（总耗时接近最慢节点而非累加）；gather 去重不吞冲突；deadline 超时返回 partial；取消不泄漏进程；去重计数正确；版本冲突显式不选最新；partial 覆盖度/缺口/原因完整。
- **降级与复核**：副本全挂降级本地且 `mode=LOCAL`；当前执行依据只用本地/主写 current_snapshot；远程证据不进 Gate（无 evidence_id）。
- **安全**：跨 scope/未授权副本拒绝；秘密路径不复制；文本命中筛查被脱敏；撤销后不可查询且派生数据被清理；无网络监听。
- **兼容**：旧账本事件 hash 不变；旧快照可解析；旧 Gate/explore 回归通过；schema pin 同步；七工具数量不变。
- **回归**：`node scripts/run-tests.ts`、`npx tsc -p tsconfig.json --noEmit`、`node scripts/check-docs.ts`、`node scripts/check-schema.ts` 全绿。

**明确未验证边界（不得宣称）**：跨机器传输与真网络分区；生产高可用/故障切换；多主写；远程证据进 Gate；掉电级持久性（沿用 M10/M13 未验证结论）；时钟偏差下的强一致（只报告滞后，不补偿时钟）。

## 15. 与既有 ADR 的边界对账

- **ADR-005**：已提交事件字节/hash 不可变、词汇追加式、memory.* 幂等与 fail-closed 重建语义不变；副本只是同一投影语义的第二个读取端，不引入删除/改写路径；memory 事件仍不产生 Gate 完成证据。
- **ADR-009**：三根分离、扫描排除、链接/大文件/超时降级不变；集群元数据落 `.ano/cluster/`，不混淆 Git 根/PM 根/源码扫描根。
- **ADR-010**：结构探查证据与执行证据分离、Gate 只记录不替代不变；副本的结构摘要只用于覆盖率对照，不产生 `evidence_id`；`exploredFiles` 投影语义不变。
- **ADR-008/客户端目录**：不新增第八个 MCP 工具；不读取真实秘密；不外发。
- **`docs/limitations.md`**：沿用「Gate 身份非密码学签名」「Windows 掉电持久性未验证」「同用户恶意进程不可防」等永久边界。

## 16. 后果

- 实现者获得固定的单主/副本角色、复制单位与 cursor、四模式判定、异步七项契约、降级与 Gate 边界、安全与兼容约束；T-124~T-132 可并行，验收判据可预先编写。
- 代价：新增集群元数据层、副本重建与协调器；需要额外的授权/撤销/红队面。换来的是「多副本可读 + 一致性可判定 + 分歧显式 + 远程不可信」的可审查行为，而不触碰权威账本与 Gate 通道。
- 本 ADR 只固定语义与契约，不声称任何实现、跨机能力或生产高可用已存在；实现完成后按第 12/14 节与 `docs/distributed-probe.md` 验收，跨机与生产高可用保持未实现且不宣称。

## 17. 实现勘误（2026-11-24 收口，以下以实现为准）

本节记录 ADR 正文与已验收实现（T-123~T-131）的命名/路径差异，避免把设计期命名当成可调用契约。正文其余语义（单主、≥2 只读副本、四模式、异步七项、远程不可信、Gate 边界）保持不变；凡本节与正文冲突处，以本节和 `src/memory/` 为准。

| 正文位置 | 设计期写法 | 已实现（可调用） |
|---|---|---|
| §1/§2/§9 | `<root>/.ano/cluster/replicas/<replica_id>/` | `<root>/.ano/replicas/<replicaId>/{events.jsonl,cursor.json}`（`ReplicaStore.directoryFor`；`cleanupReplica` 清理同一路径） |
| §3 副本消息 | `handshake` / `pull-events` / `query` / `status` / `close` | `init` / `apply` / `query` / `status` / `shutdown`（行分隔 JSON；未知类型拒绝）。`apply` 仅接收**已提交事件包**并只写副本派生文件，不写权威账本 |
| §3 写拒绝 | `REPLICA_WRITE_REFUSED` | `REPLICA_WRITE_FORBIDDEN`（`ReplicaStore` 写方法，`src/memory/replica.ts`） |
| §3 外部写入者 | `FOREIGN_WRITER_SEEN` | **未实现**：没有 observed 头集合跟踪；本 ADR 不宣称该检测能力 |
| §7 快照失配 | `SNAPSHOT_MISMATCH` | `CURRENT_SNAPSHOT_MISMATCH`（`judgeConsistency`；上下文 violation 名 `snapshot_mismatch`） |
| §9 单主拒绝 | `PRIMARY_ALREADY_ACTIVE` | **无运行时拒绝码**：不存在第二 primary 注册 API，单主由构造保证（没有代码路径可注册第二个 primary）；不以该码作为验收断言 |
| §5 心跳 | 默认 5,000ms | `REPLICA_WORKER_DEFAULT_HEARTBEAT_MS = 0`（默认关闭；父进程 stdin 关闭为兜底，空闲副本不应被误判死亡） |
| §10 策略存放 | `<root>/.ano/cluster/policy.json` | 策略为注入/本地对象（`createDefaultClusterPolicy`/`loadClusterPolicy`），默认审计落 `<root>/.ano/cluster/audit.jsonl`；不默认读取固定 policy 文件 |

补充事实：`REPLICA_EVENT_CONFLICT`（同序号异哈希/分叉）、`REPLICA_CORRUPT_EVENT`（事件行损坏，零写）、`REPLICA_CURSOR_INVALID`（cursor 与事件不一致）、`CLUSTER_EPOCH_MISMATCH`（epoch 不一致，含响应侧 epoch 与请求不符）、`REPLICA_NOT_AUTHORIZED`/`SCOPE_DENIED`/`EGRESS_FORBIDDEN`、`REPLICA_RESUME_EXHAUSTED`（缺段续传耗尽）均为已实现并已有测试覆盖的拒绝码。红队覆盖见 `test/redteam/distributed-probe-boundary.test.ts`（14 条）与 `test/integration/replica-chaos.test.ts`（11 条）；同语义实测见 `docs/evidence/distributed-probe-benchmark.md`。
