# ADR-006：项目级强制接管（enforced takeover）

日期：2026-11-22
状态：提议（待主控审阅；审阅通过后置"已接受"并开放 phase-takeover 门禁）
任务：T-065 / TO-01（M10）
输入契约：ADR-003、ADR-004、ADR-005、`docs/anchor-probe-integration.md` §14/§15/§17、`docs/zcode-integration.md`、`docs/delivery-status.md`、`scripts/orchestration/protocol.md`、`scripts/orchestration/m10-plan.json`、T-055 宿主能力调查（`docs/evidence/host-capability-investigation.md`）

> 编号说明：本文件是 `docs/adr/` 系列的 ADR-006（Surface/集成实现边界系列）。`.pm/decisions/` 下的 ADR-001~005 是编排决策系列，两者属于不同系列、互不覆盖。本 ADR 是 M10「项目级强制接管」的语义契约，实现协议见 `docs/takeover.md`。

## 1. 背景与问题定义

M6 交付的是只读 Connect 快照层，`.pm/` 仍是 PM-mcp 的主写来源（ADR-003）；M7 交付了 `ano migrate` 与证据驱动的 `handoff`，但 `handoff` 的 `ready` 只在证据齐全时为真，且从未进入主写切换（ADR-004）。`docs/delivery-status.md` 明确「完整主写接管、其他来源适配、反向回写和批量向导未完成」，不得把「已接入」解读为「已替换 PM-mcp」。

M10 的目标（`.pm/roadmap.json`）是：在用户明确指定的项目内，一次授权完成备份、迁移、对账、策略安装、宿主默认启动、ANO DAG 接管与旧主写只读降级；支持可验证退出和恢复。

一句话问题定义：把「接管」从隐式能力变成**显式授权 + 可持久化状态机 + 可验证事务阶段 + 可恢复回退**的协议，使得主写切换前后都可审计，且任何失败都不留下部分主写状态。

「修好了」的判据：T-066~T-072 的实现者不需要再做本 ADR 范围内的语义决策；验收可直接按第 11 节判据与第 10 节文件所有权编写。

## 2. 硬边界（全节为硬边界，实现与测试不得违反）

以下七条是 M10 强制接管的不可变边界，与 ADR-003/004 的既有约束一致；任一条被违反即视为实现错误，而不是配置问题：

1. **不绕过宿主权限**：不代替人工批准，不修改 MCP/宿主权限面，不把模型或历史声明升级为已批准权限。宿主权限批准永远是具名的人。
2. **不删除旧账本**：不删除 `.pm/` 历史、不删除已提交 ledger 事件、不删除备份；回退只恢复已验证备份，备份之后的账本分支保留供审计。
3. **不静默接管其他项目**：一次授权只绑定一个规范项目根；跨 root 调用拒绝；移动或复制项目不自动续接授权。
4. **不自动发布**：baseline approve、attest、release approve、sync、push 一律不暴露给接管工作流，也不由接管自动触发。
5. **不自动读取秘密**：接管只读取完成授权范围内任务/记忆/验收/DAG 所必需的项目数据；不采集凭据、令牌、私钥、宿主全局会话或未授权目录。
6. **宿主能力缺失时显式降级而非虚报**：宿主无输出拦截、hooks 未启用、无自动启动/自动批准能力时，必须报告 `degraded` 与具体缺失层，不得把「ANO 侧已切换」表述为「宿主已强制」。
7. **不把历史或模型声明升级为已验证事实**：来源 `done` 仍映射为 `in_progress + verified=false`；记忆声明不进入 Gate 完成通道，不产生 `evidence_id`、不触发 done/approve/cutover（ADR-003/ADR-005 不可变约束 10）。

**自动接管工作流与人工发布/权限的区分**：备份、迁移、对账、证据核验、策略安装、状态切换、漂移检测与报告属于自动工作流；发布、attest、release approve、宿主权限批准、撤销授权、恢复旧主写属于具名人工动作。自动工作流可以写入 ANO 账本与项目内受管文件，但不得代替上述人工动作。

## 3. 决定一：显式项目授权模型

### 3.1 授权作用域

- 一次授权 = **一个规范项目根**（`resolveRoot()` 后的 canonical realpath）+ 一个授权记录。授权是**结构绑定**，不是 payload 字段：所有接管读写路径必须解析到该 root，跨 root 一律拒绝。
- 授权绑定 `projectId` / `projectKey`（复用 Connect 既有身份口径，`src/connect/types.ts:13-25`）。项目改名不改变 `projectKey`；移动或复制项目后授权不自动续接，需重新授权。
- 授权范围 `scope` 是显式枚举子集：`tasks`、`memory`、`acceptance`、`dag`。缺省不允许；未授权的范围保持旧源主写或只读。

### 3.2 授权凭证形态

授权记录落在项目内 `.ano/takeover/authorization.json`，形状固定：

```jsonc
{
  "schema": "ano.takeover-authorization/1",
  "authorizationId": "<sha256(canonicalJson({root, projectId, projectKey, scope, grantedBy, role, statement, grantedAt}))>",
  "root": "<repo>",
  "projectId": "…",
  "projectKey": "…",
  "scope": ["tasks", "memory", "acceptance", "dag"],
  "grantedBy": "具名人工",
  "role": "角色",
  "statement": "明确授权语句",
  "grantedAt": "ISO 8601",
  "sourceDigestAtGrant": "<接管开始时旧源摘要，可选>",
  "revokedAt": null
}
```

- `authorizationId` 是审计与幂等身份；同 root、同 scope、同具名确认重放必须解析到同一 id。
- 授权记录是**本地、可审计的项目内记录**，不是 token，不授予任何宿主权限，不写入用户级配置，不注册到 MCP。

### 3.3 授权不等于宿主权限提升

授权只证明「该项目内允许 ANO 接管」。它不改变 MCP 工具权限、不改宿主批准策略、不代批任何人工动作，也不扩大 ANO 读取范围。宿主权限面（PermissionRequest、发布批准、客户端设置）完全不受本 ADR 影响。

### 3.4 撤销与暂停

- `revoke`：使授权永久失效（写 `revokedAt`）。已失效授权不得再执行接管；若当前处于 `enforced`，状态转 `recovery`。
- `disable`：停止当前强制（`enforced → recovery`），不删除授权记录。两者的实现契约见 `docs/takeover.md`。
- 撤销/暂停都不删除已写数据，也不自动删除 `.pm/`。

## 4. 决定二：状态机（三态 + 六阶段）

### 4.1 三态（策略状态，持久化）

| 状态 | 含义 | 旧源（PM-mcp） | ANO |
|---|---|---|---|
| `disabled` | 默认态；无强制 | 主写 | 只读（Connect 普通模式） |
| `enforced` | 强制接管生效 | 只读角色 | 主写（任务/记忆/验收/DAG） |
| `recovery` | 退出强制的过渡态 | 主写恢复中 | 暂停主写 |

状态只能按以下路径前进，禁止跳跃：

```text
disabled --grant + takeover(confirm)--> [prepared→migrated→reconciled→verified→installed→active] --> enforced
enforced --disable(confirm)--> recovery
enforced --revoke(confirm)--> recovery
recovery --recover(confirm + 对账通过)--> disabled
recovery --对账失败--> recovery（不自动前进）
```

- `enforced` 不得直接跳 `disabled`；必须经过 `recovery`。
- `disabled` 不得直接跳 `enforced`；必须重新授权并走完六阶段。
- `recovery` 不得直接回 `enforced`；需重新授权。
- 每次转移都写事务日志与时间戳；崩溃后按最近已提交状态恢复，不重复副作用。

### 4.2 六阶段（一次 takeover 事务）

阶段序列固定：`prepared → migrated → reconciled → verified → installed → active`。失败记为 `aborted`，并记录失败阶段与原因。

**关键设计点：`active` 之前的所有阶段对旧源零主写副作用。** `migrated` 写的是 ANO 自己的 ledger（可回退、不删事件），`installed` 写的是项目内受管文件（可恢复原字节）。因此 `active` 之前任一阶段失败都可以安全中止并回到 `disabled`，不会污染旧源，也不会产生「部分主写」。

| 阶段 | 进入条件 | 阶段动作 | 失败语义 | 幂等重入语义 |
|---|---|---|---|---|
| `prepared` | `disabled` + 有效授权 + 显式 `--confirm` + 来源可读 | 校验授权作用域；冻结来源摘要；创建并校验备份（`.pm/` + 已提交 ledger）；绑定迁移计划摘要与具名确认 | 缺授权/备份校验失败/来源漂移/确认缺失 → 中止，零写，状态保持 `disabled` | 同 `(authorizationId, sourceDigest, backupHash)` 重放返回既有 `prepared` 记录，不重复备份 |
| `migrated` | `prepared` 完成且摘要未漂移 | 执行 `migrateProject` 到 ANO ledger，绑定 `sourceDigest` | 来源漂移 → 拒绝且零写（沿用迁移语义）；ledger 写入失败 → 中止，无后续阶段 | 迁移对未变来源零新增事件；重入读 migration summary 判定已完成 |
| `reconciled` | `migrated` 完成 | `reconcileMigration` 必须 `sourceUnchanged=true` 且无 missing/conflict；写对账报告 | missing/conflict/漂移 → 停止，不进入 `verified`；状态仍 `disabled` | 重入重算对账，报告可复现；报告绑定当次 sourceDigest |
| `verified` | `reconciled` 通过 | 汇总证据：备份校验、迁移摘要==计划摘要、对账无 missing/conflict、授权确认绑定摘要与备份哈希、宿主能力层级与降级声明、漂移基线 digest | 任一证据缺失/失败 → 停止，不安装、不切换 | 重入重算证据清单；证据哈希不变则结论不变 |
| `installed` | `verified` 通过 | 写入受管 `AGENTS.md` 段与默认 ANO 工作流；不改 `.pm/` 主写权限、不改 MCP 配置 | 路径逃逸/恶意内容/部分写入 → 回滚该阶段写入（恢复原字节），中止 | 同策略重放零变更；用户其他内容字节不变 |
| `active` | `installed` 完成 | 原子切换策略状态为 `enforced`；记录 `enforcedAt`、角色矩阵、漂移基线 | 状态写入失败 → 回滚到 `disabled` 并报告；未产生主写副作用 | 已 `active` 重放返回同一 `active` 记录 |

`active` 是**主写切换点**。此后 ANO 才产生任务/记忆/验收/DAG 主写副作用；此后的退出必须走 `recovery` 恢复路径。

### 4.3 崩溃与幂等

- 每个阶段结束时原子写事务记录（阶段、摘要、证据哈希、时间戳）。
- 重入先读事务记录：同幂等键且阶段已完成 → 直接返回，不重跑；阶段进行中 → 从该阶段最近已验证产物继续；记录损坏 → fail-closed，不猜测。
- 状态回退只能显式（`disable`/`recover`/`revoke`），不允许自动回退掩盖失败。

## 5. 决定三：主写切换与角色矩阵

`active` 后角色固定：

| 能力 | `disabled` | `enforced` | `recovery` |
|---|---|---|---|
| 任务（create/update/cancel/reopen/complete） | PM-mcp 主写；ANO 只读 | ANO 主写；PM-mcp 只读 | PM-mcp 恢复主写；ANO 暂停 |
| 记忆（note/revise/relate） | ANO 原生可用；Connect 只读 | ANO 主写 | ANO 暂停主写 |
| 验收（Gate evidence/verify） | ANO 原生可用 | ANO 主写；来源声明不升级 | ANO 暂停主写 |
| DAG 调度 | PM-mcp 会话/计划 | ANO 泛化 DAG（T-069） | 暂停 |
| 发布/attest/approve/sync/push | 人工 | 人工（不变） | 人工（不变） |

- `enforced` 时 PM-mcp 是**只读角色**：允许读取，写操作被拒绝并给出可行动提示；不自动停用 PM-mcp（ADR-004 决定 1），停用仍是用户手动动作。
- `enforced` 时 ANO 不向 `.pm/` 回写，不做双向同步；外部写入旧源只产生漂移报告（第 6 节）。
- `recovery` 期间避免双主写：ANO 先停止主写，再恢复旧源主写。

## 6. 决定四：外部漂移

接管期间（`enforced`）外部写入旧源（`.pm/` 或已接入来源）的处理固定为「检测 / 报告 / 不对账污染」：

1. **检测**：drift watch 复用 `src/connect/watch.ts` 的显式前台轮询语义，比较旧源摘要与接管版本绑定的基线摘要。
2. **报告**：产生可定位 drift 报告（文件级差异、时间、来源摘要），写入 `.ano/takeover/drift/`；`takeover status` 必须展示未处理 drift。
3. **不对账污染**：检测到漂移后，原对账报告标记为 `stale`，不得继续作为验收依据；ANO **不自动**把旧源新内容并入 ledger，不自动双写或回写。是否重新迁移必须由人工显式决定（新授权或显式 reconcile 流程）。

漂移不改变策略状态本身（仍 `enforced`），但未处理 drift 是验收 blocker；涉及任务状态的漂移在验收时必须区分来源，不得把旧源新完成状态当作 ANO 已验证。

## 7. 决定五：备份与回退

- **切换前备份**：`prepared` 阶段复用 `src/connect/backup.ts` 的内容哈希清单模式，备份 `.pm/` 与已提交 `.ano/ledger`，逐文件校验；备份哈希绑定授权与 `verified` 证据。
- **回退路径**：`disable/recover` 只使用校验通过的已验证备份。恢复前逐文件校验，校验失败拒绝恢复。
- **回退不删旧数据**：恢复用备份覆盖当前 `.pm/`，但 ANO ledger 在接管期间产生的事件保留、备份目录保留、备份之后的账本分支保留；禁止删事件伪造回滚（ADR-004 决定 4）。
- 受管 `AGENTS.md` 段在恢复时按原字节移除/还原，用户其他内容不动。

## 8. 决定六：宿主能力降级与验收分层

依据 T-055 宿主能力调查（`docs/evidence/host-capability-investigation.md`）与 `docs/anchor-probe-integration.md` §15/§17：

- **未发现宿主公开面向 MCP 结果/模型输出的输出拦截/适配接口**；hooks 机制存在但属工具级闸门、当前未用于 ANO、配置未启用；`setting.json` 无自动批准键；新会话权限不能由 ANO 代批。
- 因此「宿主默认启动」只能降级为：受管 `AGENTS.md` 段提示宿主会话使用 ANO 工作流 + 人工确认。**不得声称宿主会自动读取策略、自动启动 ANO 或自动拦截旧源写入。**

验收分层（任一层成功不能代替其他层）：

| 层 | 范围 | 判据 |
|---|---|---|
| 模拟/库级 | 状态机、六阶段、幂等、失败中止 | 确定性 fixture，无真实项目写入 |
| 隔离项目 | 真实 CLI 全链路 takeover/status/disable/recover | 备份哈希、迁移对账、AGENTS.md 字节保持、回退可复核 |
| 真实项目 | 用户明确指定的真实项目 + 宿主会话层 | 宿主能力层级如实标注；未验证层明示 |

`takeover status` 必须报告宿主能力层级（`host_capability`）与降级原因；缺失能力时状态为 `degraded`，不得虚报 `enforced` 已覆盖宿主面。

本 ADR 不修改用户级配置。注意既有接入文档存在已知路径漂移：`docs/zcode-integration.md` / `docs/delivery-status.md` 仍把 `~/.zcode/v2/config.json` 描述为用户级配置，而 T-055 调查证明实际生效的是 `~/.zcode/cli/config.json`（`docs/evidence/host-capability-investigation.md` §4）。实现与验收以 T-055 的生效配置结论为准，不得依据 v2 路径推断宿主能力，也不得为本 ADR 修改任何用户级配置。

## 9. 决定七：与 Connect 普通模式兼容

- `disabled` 是默认态，既有 Connect 行为完全不变：`connect plan|connect|status|resume|watch|export|handoff`、`recall --source connected` 语义与输出形状不变。
- 接管新增命令只作用于已授权项目；未授权项目走普通模式，不读授权、不写 `.ano/takeover/`。
- `enforced` 项目的 `brief/track/note/recall/verify` 使用接管状态（T-070），但普通项目输出保持兼容；MCP 仍为七工具（T-072）。
- 普通模式不等于「已接管」：`connect handoff` 与 `takeover status` 是两个不同语义，前者是 Connect 迁移就绪，后者是强制接管状态。

## 10. 文件所有权与并行接口（T-066~T-078）

见 `docs/takeover.md` 第 6 节。要点：`takeover-policy.ts` / `takeover-store.ts`（T-066）先固定状态与持久化契约；`takeover.ts`（T-067）独占事务编排；`managed-instructions.ts`（T-068）独占受管段；`handoff.ts` / `watch.ts` / `capabilities.ts` / `types.ts`（T-071）独占旧源只读与漂移；Surface（T-070/T-072）串行接入。共享文件不并发写。

## 11. 测试与验收判据

- **状态机**：三态转移闭合；非法跳跃（`enforced→disabled`、`disabled→enforced` 不经过六阶段、`recovery→enforced`）拒绝；非法状态字段拒绝。
- **六阶段**：每阶段进入/失败/幂等均有确定性用例；`active` 前失败零主写副作用；缺授权/备份/迁移/对账失败均无部分主写状态。
- **幂等**：同参重放返回原结果；同键不同参拒绝；崩溃重入不重复副作用。
- **漂移**：外部写入旧源产生可定位 drift；不自动双写/回写；对账报告转 `stale`。
- **回退**：备份篡改拒绝；回退不删 ledger；用户内容字节保持。
- **安全红队**：跨项目、越权、篡改、伪造授权均拒绝；敏感文件不因接管被自动采集；fail-closed。
- **兼容**：普通项目 connect 命令与七工具 MCP 回归通过。

## 12. 与 ADR-003/004/005 的边界对账

- **ADR-003**：本 ADR 不把 Connect 快照变成主写真值源；`enforced` 后 ANO ledger 是 ANO 侧主写记录，旧源只读。来源 `done` 仍 `in_progress + verified=false`。
- **ADR-004**：备份/恢复复用其校验模式；回退永不删事件；主写切换从「证据就绪」升级为「授权 + 六阶段 + 可恢复状态机」，但 `handoff` 的旧语义保留为 Connect 迁移就绪读数，不被本 ADR 覆盖。
- **ADR-005**：记忆事件语义、不可变约束与 Gate 边界不变；接管不改变 `memory.*` 状态机，记忆声明不获得批准权限。

## 13. 后果

- 实现者获得固定授权模型、三态/六阶段状态机、角色矩阵、漂移与回退语义，T-066~T-072 可并行；验收判据可预先编写。
- 代价：需要新增策略/事务持久化与宿主能力降级报告；`enforced` 的「强制」范围被诚实限定在 ANO 可执行面，不含宿主自动拦截。
- 本 ADR 只固定语义与契约，不声称任何实现或测试已存在；实现完成后按第 11 节与 `docs/takeover.md` 验收。
