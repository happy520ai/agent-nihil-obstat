# ADR-005：AnchorProbe P1 记忆修订、关系、冲突与迁移语义

日期：2026-11-21
状态：提议（待主控审阅；审阅通过后置"已接受"并开放 phase-p1 门禁）
任务：T-043 / AP-06（M8）
输入契约：ADR-003、ADR-004、docs/anchor-probe-integration.md 第 4、11 节、T-042 P0 验收基线（报告 quality-20261121-082406-823-0000.json，483/483，src/test 源码态零漂移）

> 编号说明：本文件是 docs/adr/ 系列的 ADR-005（Surface/集成实现边界系列）。`.pm/decisions/ADR-005-AnchorProbe-多模型分阶段任务池与门禁.md` 是编排决策系列的同号文件，两者属于不同系列、互不覆盖。本 ADR 是该编排决策中"P1 前审定事件 ADR"要求所指的审定产物。

## 1. 背景与问题定义

集成方案第 4、11 节给出的是建议事件族与建议语义（"具体命名在实现 ADR 中固定"）。P1 将首次写入会改变持久事件的代码，必须在动手前把事件名、payload、状态机、冲突裁决、备份与回退固定为可审阅契约；否则任何实现选择都会变成隐式语义。

一句话问题定义：把"一次事件完成修订/关联/裁决"的写路径语义固定下来，使得（a）任何已提交事件的原字节与哈希永不变，（b）并发分叉不会被 HLC 顺序静默裁决为真值，（c）六个月后任何误废弃都能从原事件完整恢复。

"修好了"的判据：本 ADR 与集成方案第 4、11 节修订后，P1 实现者不需要再做本 ADR 范围内的语义决策；验收测试可直接按第 12 节夹具契约编写。

## 2. 不可变约束（复核结论，全节为硬边界）

以下事实来自当前源码与既有 ADR，是本 ADR 的前提，P1 及以后不得违反：

1. **已提交事件字节与哈希不可变**。事件哈希为对规范 JSON 的 SHA-256（`src/ledger/event.ts:54`），链式 `prev_hash` 引用前事件哈希；任何"改 payload 再重算哈希"的路径都不存在。
2. **事件词汇追加式**（`src/ledger/event.ts:5-9`）：新增 kind 只能在 `ledgerEventKinds` 数组尾部追加；不插入、不重排、不改名、不删除既有 kind。
3. **note_id 生成规则不变、不重编号**（`src/memory/note.ts:117`）：`note_id = sha256(canonicalJson({kind, text, anchor}))`。历史 note 永远按原规则寻址。
4. **既有 payload 契约不变**（`src/ledger/payloads.ts:16-19`）：`note.recorded` 等既有 kind 的 schema、字段与校验行为保持原样；新增 kind 各自独立 schema。
5. **事件级 schema 严格**（`src/ledger/event.ts:34-42`）：未知字段拒绝；新 payload schema 同样 `.strict()`，且新增 memory.* kind 只接受 snake_case（不走 `normalizeLedgerPayload` 的 camelCase 兼容映射；该映射是既有 readiness/release 的历史兼容，不是新事件的先例）。
6. **幂等语义不变**（`src/ledger/ledger.ts:193` 起）：同 `idem_key` 同参返回原结果（`duplicate:true`），同键不同参拒绝（`IdempotencyConflictError`）。memory.* 事件在此基础上**强制要求** `idem_key`。
7. **视图版本化、可重建、fail-closed**（`src/ledger/views.ts:16`，当前 `VIEW_SCHEMA_VERSION = 4`）：版本不匹配即从事件全量重建；重建中语义完整性违规抛 `LedgerIntegrityError`、拒绝提供视图（先例：`views.ts:223` 对冲突 note payload 的处置）。
8. **`recorded_at` 由 HLC 派生**，不是 payload 字段；`recorded_at` 永不代替或回填 `effective_from/to`。
9. **回退永不删事件**（ADR-004 决定 4）：降级/恢复只使用已验证备份，备份之后的账本分支保留供审计与后续恢复。
10. **业务声明不进入 Gate 完成通道**（ADR-003）：memory 事件不产生 Gate evidence_id，不触发 task done、attestation、release approve 或 cutover。
11. **旧七工具输出形状不变**（T-042 P0 验收基线）：`note.recorded` 的写入路径与既有 note 读取输出保持原样；memory 投影是新增读模型，不是旧读模型的改造。

## 3. 决定一：事件词汇

在 `ledgerEventKinds` 尾部追加三个 kind，词汇从此固定：

| 事件 | 用途 | 一次提交完成的事 |
|---|---|---|
| `memory.revised` | 事实版本写入 | 引入一条完整新记录 + 登记替代关系（单事件，不存在"先记新块再废弃旧块"的两次提交窗口） |
| `memory.related` | 有类型关系 | 登记一条源/目标记录间的有类型边；不改变任何事实状态 |
| `memory.conflict.resolved` | 显式冲突裁决 | 引用同一 `fact_key` 的全部分叉分支并给出裁决结果；不新增 `fact_key` 语义 |

无替代关系的新自由文本继续走既有 `note.recorded`，本 ADR 不改变它。同一业务修订只提交一次（幂等键保证重试安全）。

## 4. 决定二：严格 payload 契约

以下为固定形状（实现为 `payloads.ts` 内 `.strict()` Zod schema，逐字段对齐本节；未知字段拒绝）。

共用定义（复用既有定义处不再重复）：

```text
sha256      = /^[a-f0-9]{64}$/                                   // 与 payloads.ts 现有一致
record_ref  = /^[0-9A-HJKMNP-TV-Z]{26}$/                         // 账本事件 id（Crockford ULID，同 event.ts id regex）
fact_key    = /^[a-z0-9][a-z0-9._-]{1,119}$/u                    // 作用域内事实槽位，如 local.storage.engine
reason      = 1..2000 字符
iso_or_null = ISO 8601 datetime 或显式 null
memoryAnchor = payloads.ts 现有 memoryAnchor 形状，原样复用
memoryRecord = { text: 1..100000 字符, kind: 'decision'|'pitfall'|'memory', anchor?: memoryAnchor }
```

`kind` 不含 `session_summary`：会话摘要是历史材料，不进入版本化事实。

### 4.1 `memory.revised`

二选一分支（union，两分支均 strict）：

```jsonc
// 分支 A：修订/首版
{
  "intent": "revise",
  "fact_key": "local.storage.engine",
  "record": { "text": "…完整新记录内容…", "kind": "decision", "anchor": { } },
  "supersedes": ["<当前 head 的 record_ref>"],   // 0 或 1 个元素
  "reason": "为什么修订",
  "effective_from": null,                        // 业务生效起点；未知必须显式 null
  "effective_to": null                           // 业务生效终点；未知必须显式 null
}
// 分支 B：撤回
{
  "intent": "retract",
  "fact_key": "local.storage.engine",
  "supersedes": ["<当前 head 的 record_ref>"],   // 恰好 1 个元素
  "reason": "为什么撤回"
}
```

规则：

- `supersedes` 为空 = 该 `fact_key` 的首版（genesis）；为 1 个 = 线性修订，元素必须是该 `fact_key` 当前 head 的 `record_ref`（这就是"预期前置版本"的声明方式：引用记录即引用版本，不另设版本号字段）。
- `retract` 只能作用于当前 head 且其状态为 `active`；对已撤回 head 的再撤回拒绝。head 已撤回的 `fact_key` 允许用分支 A 再修订（向前纠错，不是状态回写）。
- `effective_from/to` 仅分支 A 携带、必须显式出现（可为 null）；两者都非 null 时 `effective_from <= effective_to`。撤回即时生效，不带生效区间。
- `record_ref` 即引入该记录的 `memory.revised` 事件自身 id；`content_hash = sha256(canonicalJson(record))` 由投影派生，不是 payload 字段（与 note_id 同哲学：内容寻址身份不由调用方自报）。

### 4.2 `memory.related`

```jsonc
{
  "edge": "depends_on",          // 'depends_on' | 'explains' | 'related_to'，词汇固定为这三种
  "from_ref": "<record_ref>",
  "to_ref": "<record_ref>",
  "reason": "为什么建立该关系"    // 可选，1..2000
}
```

- 两个 ref 必须都可解析为本账本内的记录（`note.recorded` 事件或 `memory.revised` 事件 id）。
- `(from_ref, to_ref, edge)` 三元组在账本内唯一；重复提交同一边被拒绝（重试场景由 `idem_key` 返回原结果，不走重复边）。
- 关系永不改变事实状态：相关性再高也不自动废弃旧记录（集成方案 §4.2 原约束）。
- 自环（`from_ref === to_ref`）拒绝。边允许成环（A→B 且 B→A 合法），读取侧有界遍历负责终止。

### 4.3 `memory.conflict.resolved`

```jsonc
{
  "fact_key": "local.storage.engine",
  "branches": ["<record_ref>", "<record_ref>"],   // >=2，必须恰好等于当前未决冲突的分支集合
  "outcome": { "type": "winner", "winner_ref": "<branches 之一>" },
  // 或 { "type": "record", "record": {…}, "effective_from": null, "effective_to": null }
  // 或 { "type": "retract_all" },
  "reason": "裁决依据"
}
```

三种裁决结果：

1. `winner`：指定一个既有分支存活，该分支成为 head（状态回 `active`），其余分支标记 `superseded`。
2. `record`：裁决者提交一条新记录，全部分支标记 `superseded`，新记录成为 head。
3. `retract_all`：全部分支标记 `retracted`，head 置空，`fact_key` 记为已撤回。

`branches` 与投影中的未决分支集合必须**集合相等**（排序后逐项比较）：少了漏裁决，多了引用不存在的分叉，都拒绝。

## 5. 决定三：身份模型

| 身份 | 固定含义 | 承载位置 |
|---|---|---|
| `project_scope` | 本地命名空间，与账本规范根目录绑定 | **结构绑定，不是 payload 字段**。payload 声明的 scope 不可信；所有 ref 必须在本账本内可解析，跨项目/跨 root 引用结构性不可解析即拒绝 |
| `fact_key` | 作用域内事实槽位 | payload 字段；只有 `memory.*` 事件有；自由文本（note.recorded）没有槽位、不能自动覆写其他记录 |
| `record_ref` | 账本事件 id | 引入记录的事件自身 id；同文不同时间 = 不同事件 = 不同记录（不合并） |
| `note_id` | 既有 note 内容身份 | `note.recorded` payload 原样保留；memory 投影将其作为 legacy 记录的补充身份，不重编号 |
| `content_hash` | 记录内容摘要 | 投影派生 `sha256(canonicalJson(record))`；用于身份/完整性，不用于判断语义正确 |
| `recorded_at` | 记录进入账本时间 | 由事件 HLC 派生；不是 payload 字段；永不回填 effective 区间 |
| `effective_from/to` | 业务生效区间 | payload 显式字段；null = 未知；未知就标记未知，不用记录时间伪装 |

## 6. 决定四：状态机

记录状态：`active / superseded / conflicted / retracted`。来源资格（正交于状态）：`governed`（memory.* 引入）或 `legacy_unreviewed`（既有 note.recorded）。

| 迁移 | 触发事件 | 说明 |
|---|---|---|
| （无）→ active | `memory.revised` intent=revise（supersedes 空） | genesis；要求该 fact_key 此前无任何记录 |
| active → superseded | `memory.revised` intent=revise（supersedes=[head]） | 新记录 active 成为新 head；旧 head 被 `superseded_by` 新记录 |
| active → retracted | `memory.revised` intent=retract | head 指针留在被撤回记录上，读取报告"该事实已撤回"（区别于"无此事实"） |
| active/conflicted → superseded 等 | `memory.conflict.resolved` | 见 §4.3 三种 outcome |
| active → conflicted | 重放层分叉检测（§7） | 分叉全部分支 conflicted，head 置空 |

硬性规定：

- **状态只由已提交事件改变**。时钟不改变状态：没有按时间自动过期/自动撤回；`effective_to` 只影响读时可见性（§9），不回写状态。
- 替代关系构成森林（每记录至多替代一个前驱），加上"只能引用提交时已存在的事件"这一前置条件，替代环结构性不可能；重放层复核，违规即 `LedgerIntegrityError`。
- 模型置信度不获得批准权限：分类器/模型输出（P4 研究路线）只能**提议**候选修订，提交必须经显式操作（surface 显式分支，actor 为执行操作的主体）。P1 不存在任何自动提交 memory.* 事件的路径。

## 7. 决定五：竞争分叉与显式冲突裁决

**追加层（主路径，锁内）**：前置检查在共享视图锁 + 会话锁内、`BEGIN IMMEDIATE` 事务中完成（沿用 `src/ledger/ledger.ts:168` 的锁内检查-后追加次序，禁止先查后写竞争窗口）：

1. payload schema 通过（strict，未知字段拒绝）；
2. memory.* 必带 `idem_key`；同键同参返回原结果，同键不同参拒绝；
3. `supersedes` 声明与投影当前状态匹配（§6 表）；`fact_key` 处于未决冲突时，除 `memory.conflict.resolved` 外一切写入拒绝；
4. 所有 ref 在本账本可解析且指向已提交事件；
5. 无自环；边三元组未占用；裁决 branches 集合恰好等于未决分支集合；
6. 任一不满足 → 前置拒绝、零写入，调用方重读后重试。

依赖相同旧版本的并发修订因此**在追加层被拒绝**（先提交者留下 head，后到者前置失败）。这是 P1 单账本串行写现实的确定性行为。

**重放层（防御性规定）**：若已提交历史中仍出现同前置分叉（多段合并、备份恢复边界等未来场景），重放不得整体失败、也不得按 HLC 末条静默选真值：

- 线性 `memory.revised` 的 `supersedes[0]` 等于当前 head → 正常移动 head；
- `supersedes[0]` 不等于当前 head，但等于当前 head 的父记录（即与本 head 依赖同一前置）→ 投影为分叉：该 fact_key 进入 `conflicted`，分支集合 = {当前 head 记录, 本记录}，head 置空，**不自动选真值**；其后再有引用同一前置的修订并入分支集合；
- 其余情形（引用陈旧中间版本、未知 ref、genesis 落在非空 fact_key、分支/边引用缺失、边三元组重复、裁决集合与未决分支不等）→ `LedgerIntegrityError`，视图重建 fail-closed。

**裁决是唯一出口**：fact_key 处于 conflicted 时，读取必须报告未决冲突（进入载荷 `coverage_gate.unresolved_conflicts` 语义，P2 接线），不得返回任一分支冒充当前事实；唯一解除途径是 `memory.conflict.resolved`。

## 8. 决定六：legacy_unreviewed 与旧 note 兼容

- 每条 `note.recorded` 事件在 memory 投影中登记为 `legacy_unreviewed` 资格记录：`fact_key = null`、状态 `active`、不可作为已治理事实返回。仅有代码锚点不意味着其业务内容仍有效。
- 旧 note 进入治理的唯一路径：`memory.revised` 以该 note 事件的 id 为 `supersedes` 目标——原 note 事件字节不动、notes 视图不动、旧读取输出不变，仅 memory 投影把该 legacy 记录标记为 `superseded`，新记录为 `governed`。
- `memory.related` 可引用 legacy 记录作边的端点；legacy 记录不能成为冲突分支（无 fact_key）。
- Connect 来源材料不自动复制为原生已批准记忆（ADR-003/集成方案 §11.3）；P1 事件不含 Connect 来源接入，其 provenance 接线留待 P2 载荷阶段，且永远带未验证标记。

## 9. 决定七：时间语义与读取过滤

- `temporal_mode = CURRENT`（as_of=now）：沿当前 head 血缘取生效区间覆盖 as_of 的记录；head 未生效（effective_from 未到）、已过效（effective_to 已过）或区间不含 as_of 时，输出"无当前有效版本"+原因，**不回退展示已替代/已撤回记录冒充当前事实**。
- `HISTORICAL`/显式 as_of：按区间在链上选取并标记历史用途；历史证据永不升级为当前执行依据（集成方案 §6 原约束）。
- 区间未知（显式 null）：记录照常返回并携带 `temporal_unknown` 标记，绝不从 `recorded_at` 回填。
- 硬约束闭包超预算/缺事实时必须显式报告不足，不静默删减后声称完整（§5 读取流程原约束，P2 接线）。

## 10. 决定八：投影、视图重建与 fail-closed

- `VIEW_SCHEMA_VERSION` 4 → 5；升级后从原事件全量重建，不原地修补旧视图。
- 新增逻辑表（设计 §4.3 建议名的固定化）：`memory_records`（记录 + 状态 + 资格 + note_id 映射）、`memory_heads`（fact_key → head_ref/version/status/是否未决冲突）、`memory_edges`（有类型边）、`memory_conflicts`（fact_key → 分支集合）。设计中的 `memory_invariants` 名额保留给已形式化规则落地时（P2+），P1 不建。
- `version` 为投影派生的信息性修订深度（genesis=1，线性修订 +1），不是身份，不进 payload。
- 重建遇到 §7 所列违规 → `LedgerIntegrityError`，拒绝提供视图（fail-closed），与既有 note 冲突处置一致。
- 投影缓存（索引/FTS）可清理重建；权威原始资料永不放入可随意删除的缓存目录（集成方案 §11.4 原约束）。

## 11. 决定九：迁移、备份、关闭功能与软件降级

1. **P1 写入启用前**：对已提交账本段做带内容哈希清单的备份并逐文件校验（复用 ADR-004 `ano migrate backup` 的校验模式）；校验失败不启用新事件写入。不迁移 `.pm/` 主写权限，不自动触发 cutover。
2. **视图迁移**：版本 5 从原事件重建；重建错误 fail-closed（§10）。
3. **关闭功能**：停用 memory.* 写入与 probe 读取后，旧 recall 读取接口恢复；但版本化事实仍须由支持新事件的版本处理——旧二进制的 `ledgerEventSchema` 会拒绝未知 kind（`eventChain` 校验失败），因此"关闭功能"不等于"任意降级软件"（集成方案 §11.5 原约束）。
4. **软件降级**：恢复启用新事件之前的已验证备份；备份之后的账本分支原样保留供审计与后续恢复（可由新版本重新采纳）；**禁止删事件来伪造回滚**（ADR-004 决定 4）。降级期间对旧事件语义的全部读写照旧。

## 12. 决定十：六个月误废弃预演恢复路径

预演场景（集成方案 §11 原设问）：六个月后发现分类器/自动候选持续误废弃。固定恢复路径，按序：

1. 关闭自动候选提交路径（若已存在），杜绝新的误废弃写入；已提交误废弃事件不删不改。
2. 从原事件重建 memory 视图（`VIEW_SCHEMA_VERSION` 重建语义）：所有修订、关系、裁决都在事件里，状态可完整重现。
3. 追加纠错事件向前恢复：对每条被误替代/误撤回的记录，以 `memory.conflict.resolved` outcome=winner 或 `memory.revised`（supersedes=当前错误 head）恢复正确记录为 head；每次纠错引用被裁决分支并写明 reason，审计链完整。
4. 若误废弃源于裁决事件本身，重放层规则（§7）保证从原事件重放出的分支/冲突集合与当年一致，纠错可基于同样的确定性状态进行。

反面规定（因此不进入首版）：只保留摘要而不保留原事件、或修改原哈希块的方案，届时无法完整恢复——这正是不可变约束 1 的存在理由。

## 13. 测试夹具契约（P1 验收测试按此编写）

命名场景矩阵；每项一个夹具、一个确定性期望（实现为 `test/integration/memory-revision.test.ts` 与 `test/unit/memory-state.test.ts` 的用例名）：

| 夹具 | 场景 | 期望 |
|---|---|---|
| `revise-linear` | genesis → revise v1→v2 | head 移动；旧记录 superseded；全账本既有事件哈希不变 |
| `revise-idempotent` | 同 idem_key 同参重放 / 同键不同参 | 返回原事件 duplicate / `IdempotencyConflictError`，零额外事件 |
| `revise-stale-prior` | supersedes ≠ 当前 head | 前置拒绝、零写入 |
| `revise-unknown-ref` / `revise-self-loop` | 引用不存在事件 / 自环 | 前置拒绝 |
| `revise-legacy-entry` | memory.revised 替代 note.recorded 事件 | note 事件字节不动、旧输出不变；legacy 记录转 superseded、新记录 governed |
| `related-edge` | 正常边 / 重复边 / 自环边 | 边登记且状态不变 / 拒绝 / 拒绝 |
| `fork-replay` | 两段各提交依赖同一前置的 revised | 重放投影两分支、fact_key conflicted、无自动胜者、读取报告未决冲突 |
| `adjudicate-*` | winner / record / retract_all 三种 outcome | 各按 §4.3 生效；错误 branches 集合前置拒绝；篡改已提交裁决 → 重建 fail-closed |
| `legacy-unreviewed` | 仅 note.recorded | 资格 legacy_unreviewed，不作为治理事实返回 |
| `temporal-unknown` | effective 区间显式 null | 返回并带 temporal_unknown；recorded_at 不回填 |
| `rebuild-fail-closed` | 篡改已提交事件后重建 | `LedgerIntegrityError`，拒绝提供视图 |
| `downgrade-branch` | 启用前备份 → 提交 memory.* → 恢复备份 | 旧二进制可重放；备份后分支文件保留、未删除 |

## 14. P1 并行接口（文件所有权）

P1 实现允许改动/新增：`src/ledger/event.ts`（尾部追加 kind）、`src/ledger/payloads.ts`（新增 schema）、`src/ledger/ledger.ts`（锁内前置检查）、`src/ledger/views.ts`（版本 5 + 新投影）、新增 `src/memory/state.ts`、Surface note 路径的显式 revise/relate 分支、第 13 节测试。

P1 禁止改动：`src/memory/anchor.ts`、`src/memory/probe.ts`、`src/memory/probe-contract.ts`、`src/surface/anchor-probe.ts` 的 P0 已验收语义；旧七工具无新字段调用的输出形状；`src/gate/`；`src/connect/`；用户级 MCP 配置；`.pm/`。并行任务按此划分不共享写文件；共享文件（event/payloads/ledger/views）由单一 P1 写任务独占，编排不得并发派发。

## 15. 与 ADR-003/004 的边界对账

- **ADR-003**：memory 事件是 ANO 原生账本事件，不是 Connect 快照；Connect 材料的 provenance 接线（P2 起）永远带未验证标记、不自动升级为已批准记忆；历史 ledger 哈希与 Gate 约束不变（不可变约束 1、10）。
- **ADR-004**：备份/恢复复用其校验模式；回退永不删事件（不可变约束 9）；单一事实源切换状态机不受本 ADR 影响；不自动 cutover、不改 `.pm/`、AGENTS.md 与 MCP 配置。
- **ADR-005（.pm 编决策系列）**：本 ADR 即其"P1 前审定事件 ADR"门禁产物；P2 前验收持久语义时以本 ADR 为判据。

## 16. 后果

- P1 实现者获得固定词汇、payload、状态机与冲突语义，验收测试可预先编写（第 13 节）；编排可据此安全并行（第 14 节）。
- 代价：`memory.conflict.resolved` 的三 outcome 与重放层分叉投影增加了实现面；但换来了"任何已提交历史都可确定性重建 + 一切冲突显式可裁决"，且不引入任何删除/改写事件的路径。
- 本 ADR 只固定语义与契约，不声称任何实现或测试已存在；P1 实现完成后按第 13 节矩阵与质量矩阵验收。
