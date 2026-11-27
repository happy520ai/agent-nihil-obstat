# 强制接管实现协议（M10 / TO-01~TO-14）

- 日期：2026-11-22
- 任务：T-065 / TO-01（M10）
- 上游契约：`docs/adr/ADR-006-project-takeover.md`（语义与硬边界以 ADR 为准；本文只给实现协议）
- 适用：T-066~T-078 并行实现者

## 1. 目的与范围

本文把 ADR-006 的接管语义落成可实现、可测试的协议：授权 CLI、状态机、每阶段产物、文件所有权、旧源共存、验收分层。

不在本文范围内：具体代码、PM 簿记、测试用例实现细节、用户级配置修改。任何与 ADR-006 冲突的实现表述以 ADR 为准。

## 2. 术语

| 术语 | 含义 |
|---|---|
| enforced takeover | 强制接管：授权项目内 ANO 主写、旧源只读 |
| 主写 | 某能力（任务/记忆/验收/DAG）的权威写入方 |
| 只读角色 | 允许读取、拒绝写入并给出提示 |
| 旧源 | 被接管的来源，当前为 `.pm/`（PM-mcp） |
| 授权 | 绑定单一项目根的一次性许可记录，不是宿主权限 |
| 漂移 drift | 接管期间旧源被外部写入，导致摘要与基线不一致 |
| 事务 | 一次 `takeover` 执行，含六阶段与幂等记录 |

## 3. 授权 CLI / 流程草案

### 3.1 命令

```text
ano takeover grant  --root <abs> --scope tasks,memory,acceptance,dag \
                     --granted-by <具名> --role <角色> --statement <授权语句> [--granted-at <iso>]
ano takeover apply  --root <abs> --authorization-id <sha256> --confirm
ano takeover status --root <abs>
ano takeover recover --root <abs> --confirm
ano takeover disable --root <abs> --confirm
ano takeover revoke --root <abs> --confirm
```

- `--root` 对六个子命令均必填，解析为 canonical realpath；跨 root 一律拒绝。
- `--scope` 必填枚举子集，逗号分隔、去重；缺省、未知值或重复项拒绝。
- `--confirm` 是**显式**布尔标志，代码路径不得从环境变量、配置文件或默认值推断授权。库级 `takeover` 函数必须要求显式 confirm 参数。
- `apply` 缺 `--authorization-id` 或缺 `--confirm` 直接拒绝，零写；`--authorization-id` 必须是 64 位 sha256 十六进制，且与存储授权重算一致。
- `apply` 要求授权 `scope` 覆盖 `tasks|memory|acceptance|dag` 全部四项（受管 `AGENTS.md` 段安装前提）；缺项的 `grant` 能写入，但 `apply` 拒绝。
- `grant` 只写 `.ano/takeover/authorization.json`，不改 `.pm/`、`AGENTS.md`、MCP 配置或用户级配置。
- `revoke` 写 `revokedAt`；已撤销授权不能执行 `apply`。
- `hostCapability` 在 CLI/MCP 路径固定为 `degraded`，不暴露 `runtime`/`stopAfterPhase` 等内部参数。

### 3.2 授权记录

路径：`<root>/.ano/takeover/authorization.json`（schema `ano.takeover-authorization/1`）。字段与 ADR-006 §3.2 一致，必须严格校验：schema、root（canonical）、projectId/projectKey、scope 枚举、grantedBy/role/statement 非空、grantedAt ISO、authorizationId 重算一致；`sourceDigestAtGrant` 记录授权时旧源摘要（可读不到时为 null），`revokedAt` 初始为 null。

`authorizationId = sha256(canonicalJson({root, projectId, projectKey, scope, grantedBy, role, statement, grantedAt}))`。同参重放返回同一 id；任一字段不同则 id 不同。

### 3.3 事务记录

路径：`<root>/.ano/takeover/transactions.json`（schema `ano.takeover-transactions/1`，append-only 日志）。`txId = sha256(canonicalJson({authorizationId, sourceDigest, backupHash}))`，与阶段幂等键一致。

```jsonc
{
  "schema": "ano.takeover-transaction/1",
  "txId": "<sha256>",
  "authorizationId": "<sha256>",
  "root": "F:/Agent Nihil Obstat",
  "phase": "prepared|migrated|reconciled|verified|installed|active|aborted",
  "sourceDigest": "<接管开始时旧源摘要>",
  "backupId": "<backup id>",
  "backupHash": "<sha256>",
  "evidenceHash": "<sha256 或 null>",
  "prevHash": "<前一条 entryHash 或 null>",
  "entryHash": "<sha256(canonicalJson(除 prevHash/entryHash 外字段))>",
  "startedAt": "ISO 8601",
  "updatedAt": "ISO 8601",
  "error": null
}
```

写入使用项目内文件锁 + 原子 rename（与 `scripts/orchestration/store.ts` 同口径）。同 `(authorizationId, sourceDigest, backupHash)` 重放返回既有记录；同键不同参、跳阶段或首条非 `prepared` 一律拒绝。损坏记录 fail-closed，不猜测。

`prevHash`/`entryHash` 构成 append-only 哈希链：每条 `prevHash` 必须等于前一条 `entryHash`，`entryHash` 绑定自身字节；改写历史会断裂并被 `ConnectTamperError` 拒绝。

### 3.4 流程

```text
grant ──> disabled + authorization
apply(confirm):
  校验授权 ──> prepared(备份+校验) ──> migrated(ledger) ──> reconciled(对账)
  ──> verified(证据) ──> installed(受管段) ──> active(enforced)
disable(confirm): enforced ──> recovery
recover(confirm): recovery ──> 恢复旧源主写 + 对账 ──> disabled
revoke(confirm): enforced ──> recovery（并写 revokedAt）
revoke(confirm): disabled ──> 仅写 revokedAt（授权永久失效）
```

## 4. 状态机

### 4.1 文本图

```text
                 grant + apply --confirm
   ┌──────────┐  六阶段事务（active 前零主写副作用）   ┌──────────┐
   │ disabled │ ─────────────────────────────────────▶ │ enforced │
   └──────────┘ ◀───────────────────────────────────── └──────────┘
        ▲            recover --confirm                     │
        │                                                    │ disable --confirm
        │                                                    │ revoke --confirm
        │                                                ┌──────────┐
        └────────────────────────────────────────────── │ recovery │
                     recover --confirm                   └──────────┘
```

非法路径（拒绝）：`enforced→disabled` 直达、`disabled→enforced` 跳过六阶段、`recovery→enforced`、`recovery` 中 `revoke`、任何未知状态。

### 4.2 三态

| 状态 | 旧源 PM-mcp | ANO | 进入 | 退出 |
|---|---|---|---|---|
| `disabled` | 主写 | 只读 | 初始；`recover` 完成 | `apply` 六阶段完成 |
| `enforced` | 只读角色 | 主写 | 事务 `active` | `disable` / `revoke` |
| `recovery` | 主写恢复中 | 暂停主写 | `disable` / `revoke` | `recover` 对账通过 |

`disable`/`revoke` 会先把受管 `AGENTS.md` 段声明翻转为 `recovery`，再切换权威策略；切换失败时声明回滚为 `enforced`，保证声明与策略不长期不一致。

### 4.3 六阶段（进入 / 失败 / 幂等）

| 阶段 | 进入条件 | 失败 | 幂等重入 |
|---|---|---|---|
| `prepared` | `disabled` + 有效授权 + `--confirm` + 来源可读 | 缺授权/备份校验失败/来源漂移/确认缺失 → 中止，零写，保持 `disabled` | 同 `(authorizationId, sourceDigest, backupHash)` 返回既有记录，不重复备份 |
| `migrated` | `prepared` 完成且摘要未漂移 | 来源漂移 → 拒绝且零写；ledger 写入失败 → 中止 | 迁移对未变来源零新增事件；读 migration summary 判定 |
| `reconciled` | `migrated` 完成 | missing/conflict/漂移 → 停止，不进 `verified` | 重算对账，报告绑定当次 sourceDigest |
| `verified` | `reconciled` 通过 | 任一证据缺失/失败 → 停止，不安装、不切换 | 重算证据清单；证据哈希不变则结论不变 |
| `installed` | `verified` 通过 | 路径逃逸/恶意内容/部分写入 → 回滚该阶段写入（恢复原字节），中止 | 同策略重放零变更；用户其他内容字节不变 |
| `active` | `installed` 完成 | 状态写入失败 → 回滚 `disabled` 并报告；无主写副作用 | 已 `active` 返回同一记录 |

### 4.4 完整性与撤销语义（T-076 修复）

T-076 集成期修复了四类真实缺陷，本文的持久化与撤销语义以此为准：

- **`policy.stateHash`**：`stateHash = sha256(canonicalJson({state, stateChangedAt, enforcedAt, recoveredAt, baselineDigest, hostCapability}))`。写入时重算，读取时校验；不匹配报 `ConnectTamperError`。即使攻击者连同哈希一起重算，状态机仍只接受合法转移，属分层防御。
- **事务哈希链**：`transactions.json` 每条记录含 `prevHash`/`entryHash`；`prevHash` 绑定前一条 `entryHash`，改写历史会断裂并被拒绝。
- **`allowRevokedRemoval`**：`removeManagedInstructions` 的退出维护 opt-in，仅 `recover` 使用；授权被 `revoke` 后仍可移除受管段、完成 `recovery→disabled`。`install`/`update` 不接受该 opt-in。
- **`ensureDisabledPolicy`**：`disabled` 状态下若存储策略绑定的是另一授权，则重绑当前授权、开启新的六阶段事务（新 txId/新备份），不再重放旧授权的 journal；非 `disabled` 的异授权一律拒绝。
- **备份敏感过滤（`skippedSensitive`）**：`backup.ts` 对 `.pm/` 与 `.ano/ledger` 采用保守敏感策略（`.env*`、secrets/credentials/passwords/tokens/private-keys 目录、`credentials.json`、secret/token/api_key/private_key 文件名、`.pem/.key/.p12/.pfx/.kdbx/.ppk`、`id_rsa`/`id_ed25519`），命中项不采集并在 manifest 的 `skippedSensitive` 显式列出，`backupHash` 纳入该清单。
- **受管段活跃内容拒绝**：`managed-instructions` 写入前 `assertNoActiveContent`，拒绝 `script/iframe/object/embed`、`on*=` 事件属性、`javascript:` 与 `data:text/html`；默认段为固定渲染文本，不接纳调用方提供的段正文。

## 5. 每阶段文件 / 目录产物

| 阶段 | 产物路径 | 内容 |
|---|---|---|
| 授权 | `.ano/takeover/authorization.json` | 授权记录（ADR-006 §3.2） |
| `prepared` | `.ano/backup/<id>/`（复用 `backup.ts`） | `.pm/` + `.ano/ledger` 内容哈希清单；敏感文件记入 `skippedSensitive`，不采集 |
| `prepared` | `.ano/takeover/transactions.json` | append-only 事务日志（初始 phase=prepared，含 prevHash/entryHash） |
| `migrated` | `.ano/ledger/**` | 迁移事件（既有迁移语义） |
| `migrated` | `.ano/takeover/migration-summary.json` | sourceDigest、任务映射摘要 |
| `reconciled` | `.ano/takeover/reconcile.json` | matched/missing/conflicts、sourceUnchanged |
| `verified` | `.ano/takeover/verification.json` | 证据清单与各自 ok、host_capability、baseline digest |
| `installed` | 项目 `AGENTS.md` 受管段 | marker 包裹的 ANO 工作流段 |
| `installed` | `.ano/takeover/installed.json` | 策略指纹、段位置、原字节哈希 |
| `active` | `.ano/takeover/policy.json` | 状态 `enforced`、enforcedAt、角色矩阵、baseline digest、stateHash |
| 漂移 | `.ano/takeover/drift/<ts>.json` | 文件级差异、来源摘要、检测时间 |

普通模式下 `.ano/takeover/` 不创建；`disabled` 时若目录存在，只读展示历史，不自动清除。

## 6. 文件所有权划分（T-066~T-078）

下表 files 与 M10 任务簿一致；共享文件按依赖串行，不并发写。

| 任务 | files（M10 任务簿原样） | 独占职责 / 接口契约 |
|---|---|---|
| T-065 | `docs/adr/ADR-006-project-takeover.md`、`docs/takeover.md` | 本契约；已完成 |
| T-066 | `src/connect/takeover-policy.ts`、`src/connect/takeover-store.ts`、`test/unit/takeover-policy.test.ts` | **策略与存储基座**。`takeover-policy.ts` 定义 `TAKEOVER_POLICY_SCHEMA`、`TakeoverState='disabled'\|'enforced'\|'recovery'`、scope 枚举、授权字段严格校验、原子写；不依赖 store。`takeover-store.ts` 定义事务日志读写、文件锁、txId/幂等键、损坏 fail-closed；只依赖 policy 类型。 |
| T-067 | `src/connect/takeover.ts`、`test/integration/takeover.test.ts` | **事务编排**。实现六阶段、进入/失败/幂等、`active` 切换；依赖 policy/store/managed-instructions/backup/migrate/handoff/watch。独占 `takeover.ts`。 |
| T-068 | `src/connect/managed-instructions.ts`、`test/unit/managed-instructions.test.ts` | **受管 AGENTS.md 段**。定义 marker、段识别/幂等/更新/移除、原字节保持；独占该文件。T-067 只调用，不改它。 |
| T-069 | `scripts/orchestration/dag.ts`、`store.ts`、`cli.ts`、`state-command.ts`、`protocol.md`、`test/unit/orchestration-dag.test.ts`、`test/unit/orchestration-cli.test.ts` | **DAG 泛化**。同一引擎支持 M8 与 M10 计划，路径隔离；`scripts/orchestration/**` 由本任务独占（T-076 在其后集成）。 |
| T-070 | `src/surface/service.ts`、`src/surface/memory.ts`、`src/surface/tool-catalog.ts`、`test/unit/surface-service.test.ts`、`test/unit/surface-memory.test.ts` | **Surface 接管状态接入**。`brief/track/note/recall` 按策略分支；普通项目输出兼容。独占 Surface 业务分支（T-072 在其后接入 CLI/MCP）。 |
| T-071 | `src/connect/handoff.ts`、`src/connect/watch.ts`、`src/connect/capabilities.ts`、`src/connect/types.ts`、`test/integration/takeover-drift.test.ts` | **旧源只读与漂移**。`handoff.ts` 扩展 readiness 输出含 takeover 状态（不改旧 handoff 阻止语义）；`watch.ts` 扩展 drift 报告且保留普通 watch 语义；`capabilities.ts` 增加 takeover 能力声明；`types.ts` 独占扩展类型。 |
| T-072 | `src/surface/cli.ts`、`src/surface/service.ts`、`src/surface/mcp.ts`、`src/surface/tool-catalog.ts`、`src/index.ts`、`test/integration/cli.test.ts`、`test/integration/mcp.test.ts`、`docs/generated/tools.md` | **CLI 与 MCP 接口**。`takeover/status/recover/disable` 严格参数（缺 `--confirm`/越 root/非法状态拒绝）；MCP 仍七工具；普通 Connect 命令不变。依赖 T-070/T-071 完成。 |
| T-073 | `docs/evidence/takeover-host.md`、`test/integration/takeover-host.test.ts` | 宿主默认启动与能力降级证据；分层记录。 |
| T-074 | `test/integration/takeover-recovery.test.ts`、`docs/evidence/takeover-recovery.json` | 隔离项目全链路 + 回退演练。 |
| T-075 | `test/redteam/takeover-boundary.test.ts` | 越权/跨项目/篡改/伪造授权红队。 |
| T-076 | `src/connect/takeover.ts`、`src/surface/service.ts`、`src/surface/cli.ts`、`scripts/orchestration`、`test/integration/takeover.test.ts`、`test/integration/takeover-recovery.test.ts` | M10 集成与门禁；在所有前置完成后独占集成。 |
| T-077 | `README.md`、`docs/usage.md`、`docs/delivery-status.md`、`docs/limitations.md`、`docs/takeover.md` | 用户指南与恢复文档；与实际 CLI/策略一致。 |
| T-078 | `docs/takeover.md`、`docs/evidence/takeover-recovery.json`、`docs/evidence/takeover-host.md` | 最终对账、审计与验收。 |

### 6.1 并行接口边界（实现者必读）

- **类型归属**：`takeover-policy.ts` 与 `takeover-store.ts` 拥有 takeover 自有类型；`src/connect/types.ts` 归 T-071。T-067 不得要求改 `types.ts`，如需 HandoffReadiness 扩展通过 T-071 交付。
- **handoff 语义**：`handoff.ts` 的旧 `handoffReadiness` 语义（Connect 迁移就绪）保留；接管状态作为附加字段输出，不得让旧调用方误判「已接管」。
- **watch 语义**：`watch.ts` 普通 `watchConnection` 行为与输出形状不变；drift 报告是新增分支/新函数，不改变既有调用方。
- **Surface 串行**：`src/surface/service.ts`、`tool-catalog.ts` 由 T-070 先改，T-072 后改；`m10-plan.json` 已声明 `T-072 depends_on T-070`。
- **DAG 独占**：`scripts/orchestration/**` 由 T-069 独占；T-076 仅做集成与门禁，不重写引擎。
- **共享文件冲突**：未声明的共享文件一律串行；发现冲突立即停派并对账（`scripts/orchestration/protocol.md` 验收与并发约定）。

## 7. 与旧 PM-mcp 的只读 / 恢复共存方案

- **只读角色落地**：`enforced` 时 Surface 拒绝向 `.pm/` 的写操作并给出提示；`handoff`/drift 读取照旧。PM-mcp 的停用是用户手动动作（ADR-004），ANO 不自动停用、不改客户端配置。
- **无双主写**：`recovery` 期间 ANO 先停止主写，再恢复旧源主写；不允许双方同时主写。
- **恢复**：`recover` 用校验通过的备份恢复 `.pm/`，移除受管段（还原原字节），状态转 `disabled`；ledger 接管期间事件保留，备份保留。
- **重授权**：`revoke` 后授权失效，需重新 `grant` 才能再次接管；不自动续接。

## 8. 验收分层与已知限制

### 8.1 分层

| 层 | 范围 | 必须产出 |
|---|---|---|
| 模拟 | 策略/六阶段/幂等/失败中止 | 确定性 fixture 测试，零真实项目写入 |
| 隔离项目 | 真实 CLI 全链路 + 回退 | 备份哈希、迁移对账、AGENTS.md 字节保持、回退证据 |
| 真实项目 | 用户指定项目 + 宿主会话层 | 宿主能力层级如实标注；未验证层明示 |
| 安全红队 | 跨项目/越权/篡改/伪造授权 | 全部拒绝；fail-closed |

任一层成功不能代替其他层；库级/隔离项目通过不等于宿主层已验证。

### 8.2 已知限制（不得虚报）

1. 宿主无输出拦截接口（T-055 七层调查）；hooks 为工具级闸门、当前未用于 ANO。
2. 宿主无自动启动/自动批准能力；新会话权限不能由 ANO 代批。
3. 跨项目现场工具消费、UI 人工确认未验证。
4. 掉电级持久性未验证；Windows 目录 fsync 限制沿用既有结论。
5. 真实两进程账本竞争/强杀接管未验证。
6. `enforced` 的强制范围限于 ANO 可执行面，不含宿主自动拦截；缺失能力时必须报 `degraded`。
7. 既有接入文档存在用户级配置路径漂移（`docs/zcode-integration.md` / `docs/delivery-status.md` 写 `~/.zcode/v2/config.json`，实际生效为 `~/.zcode/cli/config.json`，见 T-055 证据 §4）；实现不得依据 v2 路径推断宿主能力，接管不得修改用户级配置。

## 9. 实现约束（移交 T-066/T-067/T-068）

1. **先存储后编排**：T-066 必须先交付 policy/store 契约，T-067 才实现六阶段；不得反向依赖。
2. **显式授权**：库级与 CLI 的 takeover 功能必须显式 `--confirm` 与授权作用域；禁止从环境/默认值推断。
3. **失败零主写**：`active` 之前失败不得留下部分主写状态；`active` 后退出必须走 `recovery`。
4. **幂等键固定**：`(authorizationId, sourceDigest, backupHash)`；同键同参重放，同键不同参拒绝。
5. **回退不删数据**：恢复只用已验证备份；ledger 分支、备份目录、`.pm` 历史均保留。
6. **受管段字节保持**：`managed-instructions` 更新/移除不得改动用户其他内容；部分写入必须可回滚。
7. **漂移不对账污染**：检测即标 `stale`，禁止自动双写/回写。
8. **文档同步**：T-072 改 CLI/MCP 时同步 `docs/generated/tools.md`；T-077/T-078 同步本文与用户文档。

## 10. M10 最终对账（T-078 / TO-14）

- 日期：2026-11-22
- 执行者：子代理（唯一执行者）；PM 簿记由主控负责。
- 性质：只读对账 + 两项主控授权最小修改 + 一次授权证据刷新。未创建/修改 PM 任务状态（done/complete_goal 由主控执行）。
- 文件边界（本次实际改动）：`docs/takeover.md`（本节）、`docs/evidence/takeover-recovery.json`（授权刷新）、`src/surface/cli.ts`（help 文案最小修正）。未改其他 `src/**`、账本冻结件、`.pm/`（PM 工具除外）、`.ano/`、用户级配置。

### 10.1 十四任务证据链（T-065~T-078）

`list_tasks(milestone=M10, include_done=true)` 返回 14 条；T-065~T-077 均 `done` 且 `orchestration-state.completed.acceptance_verified=true`。逐任务 verification 引用报告均存在，`ok=true`、`source.stable=true`（报告 `source.before == source.after`）。

| 任务 | 标题 | 状态 | verification 报告 | ok / stable | 报告内源码指纹 |
|---|---|---|---|---|---|
| T-065 | TO-01 定义强制接管协议、授权范围和状态机 | done | quality-20261122-084735-803-0000.json | true / true | cc0f132e…8660a167（339 文件） |
| T-066 | TO-02 实现接管策略、事务日志与恢复状态存储 | done | quality-20261122-091320-145-0000.json | true / true | 0b2f48a7…93bf4103b（345 文件） |
| T-067 | TO-03 实现授权接管事务编排与可恢复执行 | done | quality-20261122-113535-210-0000.json | true / true | 1e585ea0…df06b2cf15a（352 文件） |
| T-068 | TO-04 实现受管 AGENTS.md 段与默认 ANO 工作流安装 | done | quality-20261122-091320-145-0000.json | true / true | 0b2f48a7…93bf4103b（345 文件） |
| T-069 | TO-05 将 DAG 调度器泛化为项目/里程碑无关能力 | done | quality-20261122-091320-145-0000.json | true / true | 0b2f48a7…93bf4103b（345 文件） |
| T-070 | TO-06 将接管策略接入 brief、track、note 与默认工作流 | done | quality-20261122-101045-106-0000.json | true / true | 1bc15c1a…9242dd77f（348 文件） |
| T-071 | TO-07 实现旧 PM-mcp 只读角色与外部写入漂移报告 | done | quality-20261122-101045-106-0000.json | true / true | 1bc15c1a…9242dd77f（348 文件） |
| T-072 | TO-08 实现 takeover/status/recover/disable CLI 与 MCP 接口 | done | quality-20261122-103828-748-0000.json | true / true | 608e4e7d…d03b82d（348 文件） |
| T-073 | TO-09 验证宿主默认启动、任务派发与能力降级 | done | quality-20261122-113535-210-0000.json | true / true | 1e585ea0…df06b2cf15a（352 文件） |
| T-074 | TO-10 在授权隔离项目执行完整接管与回退演练 | done | quality-20261122-113535-210-0000.json | true / true | 1e585ea0…df06b2cf15a（352 文件） |
| T-075 | TO-11 接管安全红队与越权边界验证 | done | quality-20261122-115748-730-0000.json | true / true | eb9fe571…0ae0f09ab（353 文件） |
| T-076 | TO-12 M10 集成与强制接管阶段质量门禁 | done | quality-20261122-122424-232-0000.json | true / true | 6d223a02…73b3e9cd（353 文件） |
| T-077 | TO-13 交付强制接管用户指南与故障恢复文档 | done | quality-20261122-124246-496-0000.json | true / true | 54a25211…8c143aee（353 文件） |
| T-078 | TO-14 M10 最终对账、审计与接管能力验收 | in_progress | 本任务；见 §10.6 全量矩阵 | — | 67f830a3…60d7c16a（353 文件） |

说明：T-066/T-068/T-069 与 T-070/T-071 为同批合并验收，故共用同一报告；T-067/T-073/T-074 为同批合并验收。T-078 由主控在核验后置 done 并开启 `phase-takeover-final`。

### 10.2 Gate 状态

| Gate | 状态 | verified_at | verification |
|---|---|---|---|
| `phase-takeover` | passed | 2026-11-22T12:28:50.398Z | `.pm/quality-runs/quality-20261122-122424-232-0000.json` |
| `phase-takeover-final` | 未开启（待主控以本报告开启） | — | — |

### 10.3 五类接管能力 × 实测指针

均为既有证据引用，本任务不重复实现；全量矩阵（§10.6）已覆盖重跑。

| # | 能力层 | 实测文件 / 证据 | 场景数 | 结果 | 关键指针 |
|---|---|---|---|---|---|
| 1 | 库级六阶段事务、幂等、失败中止、字节保持 | `test/integration/takeover.test.ts` | 14 | 14 pass | L98 六阶段、L150 同键重放、L175 缺授权零写、L187 备份失败、L208 迁移失败、L233 对账失败、L265 源漂移、L291 中断续做、L314 crash 窗口、L342 声明翻转、L372 原字节记录、L393 撤销/错配授权、L408 缺 confirm、L424 不写真实工作区 |
| 2 | 隔离项目全链路 + 回退/恢复 | `test/integration/takeover-recovery.test.ts` + `docs/evidence/takeover-recovery.json` | 8 | 8 pass，`known_gaps=0` | S1 全接管、S2 幂等重放、S3 外部漂移、S4 disable、S5 recover、S6 同根再接管、S7 失败注入、S8 revoke→recover（见 §10.4） |
| 3 | 宿主默认启动 / 任务派发 / 能力降级 | `test/integration/takeover-host.test.ts` + `docs/evidence/takeover-host.md` | 7 | 7 pass | L222 L1 库、L301 L1 旧源只读、L364 L2 stdio、L388 L2 CLI、L405 L3 DAG dry-run、L433 L3 无自动能力、L470 L4/L5 未验证明示 |
| 4 | 安全红队（越权/跨项目/篡改/伪造） | `test/redteam/takeover-boundary.test.ts` | 11 | 11 pass | T-075/01 跨 root、02 路径穿越/符号链接、03 伪造授权、04a/04b 篡改策略/日志、05 篡改备份、06 恶意受管段、07 外部写入漂移、08 不携带 Gate 证据、09 不替代实时授权、10 敏感文件不采集 |
| 5 | 旧源只读角色与外部写入漂移 | `test/integration/takeover-drift.test.ts` | 7 | 7 pass | L111 角色矩阵、L158 handoff 只读、L186 漂移基线、L210 漂移报告零回写、L251 watchDrift 持久化并停止、L289 recovery/disabled 恢复旧路、L313 普通项目语义不变 |

### 10.4 回滚可用确认（S5 / S8）

引用 `docs/evidence/takeover-recovery.json`（刷新后 SHA-256 `48c5af4935f36b9cf89b69f8fdcdf6034b3f379e8fdf48126a59d591ee40b9e9`）：

- **S5 recover**（34 断言全 ok）：`.pm` 五个文件逐字节恢复为备份哈希；`AGENTS.md` 精确还原为原始字节且受管段 marker 移除；`ledgerEventsPreserved=true`（迁移/任务事件保留，`ledgerEventCountAfterRecover=13`）；`backupPreserved=true` 且备份仍可校验；`journalPreserved=true`（6 条，末条 phase=active）；外部新增文件 `external-note.json` 保留。
- **S8 revoke→recover**（11 断言全 ok）：`revoke` 写 `revokedAt` 并进入 `recovery`；`recover` 在 `allowRevokedRemoval` opt-in 下成功（exit 0、state=disabled、restored=true），移除受管段、还原 AGENTS 字节与 `.pm`、保留备份。事实字段 `revokeRecover` 明确记录该语义。
- 顶层 `preservation`：`pmBytesRestoredFromBackup / ledgerEventsPreserved / backupPreserved / userContentPreserved / journalPreserved` 均为 `true`。

### 10.5 审计结果（structure / security / license）

| 审计 | 结果数量 | 处置 |
|---|---|---|
| structure | 账本完整性通过；漂移对账 1 项（F-014 无 entry_files，已有 planned 标注）；债务 0；重构配额告警 1（M10 重构 7% < 20%）；churn 热点 5；复杂度预算告警 11（含 1 个 >2MB 巨文件）；文件用途索引覆盖率 0%；测试 skip/only 4 处（均为环境条件跳过） | 记录为本任务范围外债务候选；本任务不改 `src/**` 其他文件，不新增登记（F-029 已完整） |
| security | 未处理发现 0；已接受风险再检出 21 条（SEC-011/019/029/038~043 等） | 维持 accepted 留痕（M8 SEC-038~044 已 accepted）；无新增未处理项，不需 resolve |
| license | 项目 MIT；直接依赖 6 + 传递 90；无 GPL 家族头；无来源登记 | 无处置动作；沿用既有结论 |

M10 最终结构快照：`.pm/snapshots/snap-20261122-125045.json`（354 文件，94322 行，测试文件 112，skip 4）。

### 10.6 全量质量矩阵（当前源码）

- 命令：`run_quality_matrix(kinds=[typecheck,build,test,coverage], confirm_execute=true, idempotency_key=T-078:quality-matrix-final)` + `npm run check-docs`
- 报告：`.pm/quality-runs/quality-20261122-125333-502-0000.json`
- 报告 SHA-256：`055cb579348e71b65e45799fc71e2e3864b64e5c85d158f82fad8e959ec1cbb6`
- 源码指纹：`sha256-tree-v1 = 67f830a371fe5074fa312a0070be9bebd82445c184ef3700e23b056e40d7c16a`，before==after（stable=true），353 文件 / 68,019,256 字节
- 结果：root `test` 22/22、`coverage` 788/788（lines 95.62% / branches 85.40% / functions 95.39%，阈值 90/80）、`build` exit 0、`typecheck` exit 0；scripts `test` 22/22、`typecheck` exit 0；`check-docs` exit 0（生成目录 current）
- 说明：本节 `§10` 为矩阵运行后的 docs-only 追加，不改变 `src/**` 或测试代码；矩阵报告指纹为追加前源码。

### 10.7 未验证层清单（不得虚报）

1. 宿主输出拦截 / 自动批准 / 自动建会话：无公开接口（T-055 七层调查；`HOST_AUTO_INTERCEPTION_AVAILABLE=false` 等常量）。
2. UI 人工确认（Settings → MCP / Plugin Management）未现场验证。
3. 跨项目现场工具消费（在非 ANO 项目真实调用并读写独立 `.ano/`）未现场验证。
4. 真实模型层（consumer harness 仅脚本化模型）未验证。
5. 掉电级持久性、Windows 目录 fsync 限制、真实两进程账本竞争 / 强杀接管未验证。
6. 真实项目层（用户指定真实项目 + 宿主会话层）未验收；现有证据为库/stdio/隔离 tmpdir 层。

### 10.8 不自动扩大授权声明

M10 完成不自动扩大授权范围：不修改用户级配置（含 `~/.zcode/cli/config.json`）、不自动接管其他真实项目、不自动停用 PM-mcp、不自动批准权限、不自动创建会话、不自动拦截输出。接管仍需显式 `takeover grant` + `takeover apply --confirm`，权限与发布动作仍由具名人工/宿主处理。

### 10.9 遗留风险

1. `docs/evidence/takeover-recovery.json` 中 S8 场景名仍沿用旧语义「post-revoke recovery is fail-closed」，与刷新后实际行为（recover 成功）不符；仅标签滞后，断言与 `known_gaps=0` 不受影响（受「一次性授权刷新」约束未再跑测试改名）。
2. 复杂度预算告警：`src/connect/takeover.ts` 1042 行、`docs/evidence/takeover-recovery.json` 1596 行等超 500 行预算。
3. 文件用途索引覆盖率 0%，后续会话 token 成本偏高。
4. M10 重构类任务占比 7%，低于 20% 配额（audit 提示，非阻塞）。
5. 4 处测试 skip 为环境条件跳过（git/symlink 不可用），非投机性禁用。

## 11. M13 根绑定与真实项目接管入口（T-110 / SCAN-08）

M13（ADR-009）把「项目根」拆成 Git 根 / PM 根 / 源码扫描根，接管与迁移的根绑定据此固定：

- **根绑定 = 仓库根 `.pm`**：迁移（`planMigration`/`migrateProject`/`reconcileMigration`）、接管（`runTakeover`/`takeoverStatus`）、handoff 与 Connect 只读 PM 数据一律使用 `pmRoot`（默认 = Git 根）的 `.pm`。
- **源码根的 `.pm` 非主源**：`sourceRoot != gitRoot` 且 `sourceRoot/.pm` 存在时忽略它，并报告 `ignoredPmRoots`；绝不用于迁移/接管。`server/.pm` 只有 `.gitignore`/`.runtime`、无 `tasks.json`，不是权威数据。
- **`.ano/` 存储落 Git 根**：`cache/graph.db`、ledger、takeover 记录都在 Git 根，不落在源码根，避免 `root=server` 时与仓库根 PM 数据分裂。
- **从源码根进入也解析到仓库根**：`resolveProjectScan({startRoot:'<repo>/server'})` 返回 `pmRoot=<repo>`（Git 根）、`ignoredPmRoots=[<repo>/server]`；显式 `pmRoot=<repo>/server` 报 `ROOT_ROLE_CONFLICT`。默认路径不读源码子目录 `.pm`。

### 真实电商项目接管入口与前置条件

- **真实入口 = 仓库根 `<example-project>`**（Git 根 = PM 根，`.pm` 在此）；`sourceRoots` 为 `client`/`server`/`workbench`（`scheduler-tool` 被用户 `scan_ignore` 排除）。
- **不自动接管**：M13 未对该项目执行 `takeover grant/apply/revoke/disable/recover`，也未执行迁移写路径；该项目当前无 `.ano/`。
- **接管前置条件（需显式授权）**：
  1. 具名人工执行 `ano takeover grant --root "<example-project>" --scope tasks,memory,acceptance,dag --granted-by <具名> --role <角色> --statement <授权语句>`（只写 `.ano/takeover/authorization.json`）；
  2. 用 `grant` 返回的 64 位 `authorizationId` 执行 `ano takeover apply --root "<example-project>" --authorization-id <id> --confirm`，四个 scope 缺一不可；
  3. 六阶段事务（备份→迁移→对账→核验→受管段→切换）完成前零主写副作用；宿主权限仍由具名人工处理，ANO 不代批、不自动发布。
- 证据：`docs/evidence/scan-ecommerce-project.md` / `.json`（T-108 只读验收，`pass_with_gaps`）；三根解析、排除零泄漏、PM 计数来源与耗时均为只读实测。
