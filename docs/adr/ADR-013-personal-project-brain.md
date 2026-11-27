# ADR-013：收敛为个人 vibe coding 项目大脑——钩子强制、收工记忆、个人模式与真实项目闭环

日期：2026-11-26
状态：**已接受**。审阅人：project owner（项目所有者，2026-11-26）；M18 与维护任务 T-157～T-160 已真实验收关闭，授权 M19–M22 开工。
任务：（待登记）ADR 登记任务 + M19–M22
输入契约：`AGENTS.md`、`README.md`、`PROJECT.md`、`ano-architecture-v1.0.md`、`docs/limitations.md`、`docs/adr/ADR-005-anchorprobe-memory-revision.md`、`docs/adr/ADR-006-project-takeover.md`、`docs/adr/ADR-007-client-adapters.md`、`docs/evidence/host-capability-investigation.md`、`docs/evidence/final-quality-scope.md`
实施规格：`docs/m19-m22-implementation-spec.md`（与本 ADR 同批提交）

> 定位说明：本 ADR **修订** README 与 AGENTS.md 中的"停止扩展契约"：M18 仍是最后一个**质量**里程碑；本 ADR 开放且只开放 M19–M22 四个**产品收敛**里程碑。M22 关闭后，停止扩展契约以新的范围重新生效。本 ADR 不改写 ADR-005～ADR-012 的任何已验收语义。

---

## 1. 背景与问题定义

ANO 的初衷：个人做 vibe coding 时，让大模型能持续迭代同一个项目，保留项目的全部记忆，让新会话或新模型很快接手项目，不乱做，不瞎做，随时保持清醒。

按这个初衷对照现状（证据见输入契约）：

| 初衷 | 现状 | 缺口 |
|---|---|---|
| 快速接手 | `brief` 汇总焦点、断点、锚定知识和新鲜度 | 要靠模型**主动**调用；AGENTS.md 只是建议 |
| 不乱做不瞎做 | Gate 机器裁决；`complete` 必须携带 evidence_id；diff 推导 touched | 只在**收尾**生效。过程中"不查结构就改代码"无法阻止，`brief` 只能事后提示 |
| 保持清醒 | 账本为唯一事实；stale/degraded 显式化 | 同上：模型不调用 ANO 时，ANO 看不到它 |
| 项目记忆的全部 | 决策、踩坑、记忆可以锚定进账本 | 全靠模型手动 `note`；会话结束后没有任何自动留痕 |
| 持续迭代 | 任务 DAG、断点、接管已交付 | **从未在用户真实项目上完整闭环**（M13 只做了只读扫描） |
| 个人可用 | 24 客户端、多主 HA、分布式探针 | 个人场景用不上的能力占了大半，认知成本高 |

关键事实（`docs/evidence/host-capability-investigation.md`，已实测）：ZCode **存在** hooks 机制，有 7 个事件：`SessionStart` / `UserPromptSubmit` / `PreToolUse` / `PermissionRequest` / `PostToolUse` / `PostToolUseFailure` / `Stop`。`PreToolUse` 可返回 allow/ask/deny，`Stop` 可请求继续（≤3 次），可以注入 `additionalContext`。当时的结论是"hooks 机制存在但未用于 ANO"，"hooks 拦截实验未验证"。Claude Code 的公开文档也有同类事件，`PreToolUse` 可阻止动作。

**一句话问题定义**：在不新增 MCP 工具、不宣称输出拦截、不越过人工权限的前提下，把 ANO 的纪律从"收尾才裁决"前移到"开工自动注入 + 改前预防 + 收工检测"，补上自动的会话留痕，把默认体验收敛到个人项目，并在用户真实项目上用证据证明初衷成立。

**"修好了"的判据**：在 ZCode 上对用户指定的真实项目连续完成 3 次真实会话：

1. 开工时上下文自动出现 brief；
2. 未查结构就改受支持语言的源码时被拦下或要求确认；
3. 收工时有遗留就被要求补记，并自动留下会话摘要；
4. 第二次和第三次会话的 brief 能浮出上次的断点与摘要；
5. 至少 1 个任务以 Gate evidence_id 完成。

以上全部要有账本与日志证据，并由具名人工确认。

---

## 2. 硬边界（全节为硬边界，实现与测试不得违反）

1. **七工具不变**：不新增第八个 MCP 工具。钩子入口只走 CLI（`ano hook <event>`），由宿主以子进程调用。
2. **不宣称输出拦截**：`output-interception` 对全部客户端维持 `unavailable`。钩子是**工具级闸门**，文档和 doctor 中必须用这个词。
3. **不越权**：钩子不代批 `PermissionRequest`，不自动批准，不修改宿主权限策略。`release approve`、`attest`、`baseline approve`、`push`、真实项目 cutover 仍是具名人工动作。
4. **写客户端配置走既有授权链**：钩子配置只能经 `ano clients install … --with-hooks` 写入，沿用 dry-run 默认、`--confirm`、`--granted-by`/`--statement`/`--scope`、内容哈希备份、`beforeHash` 漂移检查、原子合并和可恢复。默认零写。
5. **不读取真实会话内容**：自动会话摘要只来自 git 状态、ANO 账本事件和钩子 stdin 的元数据（会话 ID、工具名、目标路径），**不读取 transcript**，不采集提示词或模型回答正文。
6. **会话摘要不是事实**：自动摘要以 `note` 的 `session_summary` 种类入账，来源标 `hook:auto`。按 ADR-005 §4 / §8，会话摘要是历史材料，不进入版本化事实，不得作为 Gate 证据，不得产生 `evidence_id`。
7. **钩子失败不静默放行**：钩子出错、超时或输入无法解析时，`advisory` 模式返回 `ask`（交给人），`strict` 模式返回 `deny`。两者都记降级原因，**绝不**静默 `allow`。
8. **钩子只读优先**：`pre-tool` 与 `prompt` 路径**零账本写入**（沿用"只读调用不产生 segment"），只有 `session-start` 与 `stop` 两个路径允许写账本，且必须带幂等键。
9. **延迟预算**：`pre-tool` P95 ≤ 300 ms，硬超时 1500 ms；`session-start` 硬超时 5000 ms；`stop` 硬超时 10000 ms。超时按第 7 条降级。
10. **能力分级如实**：只有实测通过的客户端可标 `hooks-validated`。其余客户端（含 Claude Code，本机未安装）最多标 `hooks-documented`/`unverified`，退化为仅指令模式。
11. **不删除已验收能力**：个人模式只调整**默认可见性**，不删除、不改写 M11–M17 的代码、接口与测试。
12. **范围冻结**：本 ADR 只授权 M19–M22。向量检索、新语言结构分析、更多客户端、跨机部署不在本 ADR 范围（见 §8）。

---

## 3. 决定一：三道防线模型（预防、检测、裁决）

ANO 无法截获模型输出，也无法拦住所有写文件途径（例如 shell 重定向）。因此不追求"绝对拦截"，而是建立三道互补的防线，每道防线都如实标出自己的覆盖面：

| 防线 | 时机 | 机制 | 覆盖 | 已知绕过 |
|---|---|---|---|---|
| **预防** | 改动前 | `PreToolUse` 钩子：对编辑/写入类工具检查目标文件是否已在当前 graph revision 被探查过 | 宿主内置的编辑/写入工具 | Shell 命令写文件；宿主未声明的写入工具 |
| **检测** | 收工时 | `Stop` 钩子：用 git 状态对比会话开始时的基线，发现无任务归属的改动、未 checkpoint 的进行中任务、失败的 verify | **所有**途径产生的工作区改动 | 会话中途被强杀（下次 `session-start` 补检） |
| **裁决** | 宣称完成时 | 既有 Gate：`complete` 必须携带 evidence_id；touched = git diff ∪ 声明 | 所有任务完成声明 | 无（既有 Gate 边界） |

`PreToolUse` 对 shell 类工具**不做内容猜测拦截**（误报成本高，且容易被绕过），只把它记为"预防覆盖不到"，交给检测防线兜底。该取舍写入 limitations。

---

## 4. 决定二：钩子事件与行为契约

### 4.1 统一入口

```
ano hook <event> --client <id> [--root <abs>] [--mode advisory|strict]
event ∈ session-start | prompt | pre-tool | stop
```

- stdin 是宿主提供的 JSON，按客户端 adapter 归一化为 `HookInput`（zod `.strict()`，未知顶层字段放进 `host_extra` 但不参与判定）。
- stdout 是宿主要求的格式，由客户端 adapter 从统一的 `HookDecision` 渲染：

```ts
type HookDecision =
  | { kind: 'context'; additionalContext: string }               // session-start / prompt
  | { kind: 'allow' }
  | { kind: 'ask'; reason: string }
  | { kind: 'deny'; reason: string; remedy: string }             // pre-tool
  | { kind: 'continue'; reason: string; checklist: string[] }    // stop，请求模型继续补记
  | { kind: 'stop-ok' };
// 全部分支附带 degraded?: { code: string; detail: string }
```

- `root` 解析沿用既有规则（显式 `--root` > 宿主 cwd > 失败）。无法唯一确定时 fail-closed（按 §2 第 7 条）。

### 4.2 各事件行为

| 事件 | 读/写 | 行为 | 失败时 |
|---|---|---|---|
| `session-start` | 写（幂等） | ① 写 `session.started`：`host_session_id`、client、`head_commit`、工作区脏文件指纹基线、hook 模式；② 调用 `brief` 的紧凑投影，作为 `additionalContext` 返回（预算 ≤ 6000 字符），包含：当前焦点任务、断点下一步、上次会话摘要、上次未满足的收工检查、stale 锚点数、图新鲜度 | 返回一段简短提示："ANO 未能注入 brief（原因），请先手动调用 brief" |
| `prompt` | 只读 | 可选（默认关）。没有 in_progress 任务时注入一行提示：先 `track` 建任务再动手 | 不注入 |
| `pre-tool` | 只读 | 仅对编辑/写入类工具生效（工具名清单由客户端 adapter 声明）。见 §4.3 | §2 第 7 条 |
| `stop` | 写（幂等） | 见 §4.4 和 §5 | 仍尝试写机械摘要；写不了则放行，在下次 `session-start` 补检 |

### 4.3 `pre-tool` 判定规则（确定性，按顺序）

1. 目标路径在项目根之外，或无法解析 → `ask`（不猜）。
2. 目标路径命中豁免清单（默认：`*.md`、`docs/**`、`.ano/**` 之外的非源码文件、`config.toml` 的 `hooks.exempt` 声明项）→ `allow`。
3. 目标文件不存在（新建文件）→ `allow`。新文件的覆盖由 Gate 在收尾时裁决。
4. 目标文件不是受支持语言（当前只有 TS/JS）→ `allow`，附带 `degraded={code:'UNSUPPORTED_LANGUAGE'}`。这是如实降级，不假装覆盖。
5. 代码图状态为 `stale`/`degraded` → `ask`，理由"结构图不新鲜，先 rebuild graph 或确认继续"。
6. 目标文件在**当前 graph revision** 的 `exploredFiles` 投影中（由 `structure.queried`、`granularity=file` 推导，沿用 ADR-010）→ `allow`。
7. 其余情况 → `advisory` 返回 `ask`，`strict` 返回 `deny`，并给出补救动作：`explore` 该文件的 outline/impact。

规则 6 绑定 revision 而不绑定会话：其他会话在同一 revision 下已探查过的文件同样视为已探查。这样一致、可复算，不需要把 MCP 进程和宿主会话做关联。代价是"别人看过不等于我看过"，这一点作为已知取舍写入 limitations。

### 4.4 `stop` 收工检查（确定性）

对比 `session.started` 的基线，计算本次会话：

| 检查项 | 判定 | 未满足时 |
|---|---|---|
| C1 改动有归属 | 新增或改动的源码文件 ⊆ 本会话涉及的 in_progress/新建任务的声明文件 ∪ 已 complete 任务的 touched | `continue`：列出无归属文件，要求 `track` 建任务或说明 |
| C2 进行中任务有断点 | 本会话有改动的 in_progress 任务，在本会话内有 checkpoint | `continue`：要求写 checkpoint（进展 + 下一步） |
| C3 失败的 verify 有交代 | 本会话最后一次 verify 为 `ok=false` 的任务有后续 checkpoint 或 note | `continue`：要求记录失败原因 |
| C4 决策留痕（软） | 改动跨越 ≥2 个模块且本会话没有 decision/pitfall note | 只写进 checklist 作提示，不单独触发 `continue` |

- 同一 `host_session_id` 最多触发 `continue` **2 次**（低于 ZCode 的 3 次上限，留 1 次余量），之后一律 `stop-ok`，未满足项写入摘要的 `unmet_checks`，下次 `session-start` 置顶显示。
- 宿主提供"已处于 stop 钩子继续中"之类标志时，必须尊重，防止循环。

---

## 5. 决定三：自动会话摘要（项目记忆补全）

- `stop` 钩子**始终**（无论检查是否满足）写一条机械摘要：`note`，`kind=session_summary`，`source=hook:auto`，幂等键为 `session-summary:<host_session_id>:<seq>`。
- 内容只来自 §2 第 5 条允许的来源，结构固定：

```jsonc
{
  "host_session_id": "…", "client": "zcode", "started_at": "…", "ended_at": "…",
  "head_before": "<sha>", "head_after": "<sha>",
  "files_changed": ["src/a.ts", "…"],             // 上限 200，超限给计数
  "tasks": [{ "id": "T-…", "from": "backlog", "to": "in_progress", "checkpoint": true }],
  "verifies": [{ "task": "T-…", "ok": false, "evidence_id": null }],
  "notes_recorded": { "decision": 1, "pitfall": 0, "memory": 0 },
  "pre_tool": { "allow": 12, "ask": 2, "deny": 1, "degraded": 0 },
  "unmet_checks": ["C2:T-…"],
  "untrusted": true
}
```

- 模型自写叙述：`stop` 的 `continue` 清单里可以请求模型补一条叙述性 `session_summary` note。它与机械摘要并存、互相独立，同样只是历史材料。
- `brief` 新增"上次会话"段：最近 1 条机械摘要全文 + 最近 3 条一行摘要 + 全部 `unmet_checks`。
- 中途强杀补检：`session-start` 发现上一个 `session.started` 没有对应摘要时，先按 git 现状补一条 `interrupted=true` 的摘要，再注入 brief。

---

## 6. 决定四：个人模式（默认收敛）

- `.ano/config.toml` 新增 `profile = "personal" | "full"`，新项目默认 `personal`，已有项目保持原样（不迁移、不改写）。
- `personal` 下：
  - CLI `--help` 只列核心命令：`setup`、`brief`、`explore`、`track`、`note`、`verify`、`audit`、`doctor`、`hook`、`connect`、`takeover`、`clients install/restore`、`export`。其余命令照常可用，通过 `ano help --all` 查看。
  - `doctor` 默认只报告当前项目实际使用的客户端，不铺开 24 行矩阵（`--all` 可查看全部）。
  - MCP 七工具 schema 不变。工具 description 使用精简版文案，降低每轮上下文成本（schema hash 不变；description 不纳入 hash，需确认现状，见规格）。
- 新增一键入口 `ano setup --root <abs> --client <id>`（TTY 交互，非 TTY 只做 dry-run 计划）：顺序执行 预检 → （存在 `.pm/` 时）接管授权与 apply → 钩子 dry-run 展示 diff → 人工确认 → 写入 → `doctor` 自检 → 打印"第一次会话该说什么"。每个写步骤**单独确认**，不合并授权。

---

## 7. 决定五：真实项目闭环（初衷的实证）

- 目标项目由用户**具名指定**（默认候选：M13 已只读扫描过的电商项目）。执行前必须有 `takeover grant`（具名、角色、声明）与 `apply --confirm`。
- 证据：`docs/evidence/m22-real-project-loop.md` 与对应 JSON，记录 3 次会话的指标：
  - brief 注入字符数、首个有效动作前的轮数；
  - `pre-tool` allow/ask/deny 计数，**误拦率**（人工标注的不该拦的 deny/ask 数 ÷ 总 deny+ask）；
  - `stop` 的 `continue` 次数与最终 `unmet_checks`；
  - 以 evidence_id 完成的任务数，以及绕过 Gate 的尝试数（应为 0）；
  - 不受支持语言的改动占比（为是否扩展语言提供数据）。
- **停止判据**：误拦率 > 30% 或单次会话 `continue` 被用满且无实际收益的情况出现 ≥2 次时，`strict` 不得作为默认，个人模式默认值锁定为 `advisory`，并登记调整任务。
- 回退：任何时候可执行 `ano clients restore`（钩子配置）与 `ano takeover disable/recover`（接管），不删除已有 ANO 历史。

---

## 8. 明确不做（本 ADR 范围外）

| 不做 | 理由 | 何时重议 |
|---|---|---|
| 向量/语义检索 | 项目大脑的召回主要靠锚点、任务、fact_key 与结构图；引入嵌入模型会破坏零第三方依赖和可复算原则 | M22 数据显示 brief 召回不足时，另立 ADR |
| 输出拦截 | 宿主无公开接口（T-055 已实测） | 宿主提供公开接口时 |
| 新语言结构分析（如 Python） | 先用 M22 数据量化不受支持语言改动的占比 | M22 占比 > 20% 时另立 ADR |
| 更多客户端 / 更多 validated | 个人场景只需 1–2 个真实在用的客户端 | 用户实际换客户端时 |
| 读取 transcript 生成摘要 | 隐私与 ADR-002 边界 | 用户显式授权并有真实样本时 |

---

## 9. 未验证与风险（如实列出）

1. ZCode 钩子的**配置格式与生效位置**未实测（三份配置均无 `hooks` 键，插件管理中可见插件 hook）。这是 M19 第一个 spike 的阻断项：未测通则 M19 降级为"仅 Claude Code 文档级 + 指令模式"，并如实上报。
2. ZCode `PreToolUse` 的 stdin 字段名、编辑类工具名、deny 回显方式未实测。
3. Claude Code 本机未安装，只能达到 `hooks-documented`。
4. 钩子由宿主以用户权限执行 shell 命令，命令行必须是绝对 Node 路径 + 固定脚本，禁止拼接 stdin 内容（红队覆盖）。
5. revision 绑定的探查判定可能被"别的会话看过"放行（§4.3 取舍）。
6. 摘要依赖 git；非 Git 根项目只能做无 diff 的降级摘要。
7. Windows 掉电持久性未验证（沿用）。

---

## 10. 验收与关闭

- M19–M22 每个任务按 ANO 自身流程：`track` → 实现 → `verify`（含红队）→ `complete`（evidence_id）。
- M22 的完成需要具名人工确认，任务验收**不构成**该授权。
- M22 关闭后：README、AGENTS.md 的停止扩展契约更新为"M22 为最后一个产品里程碑"，`docs/limitations.md` 新增"钩子强制边界"与"个人模式边界"两节。

## 11. Pre-mortem（假设 6 个月后失败，最可能的路径）

1. **误拦太多，用户把钩子关了**。对策：默认 `advisory`；豁免清单可配；M22 停止判据。
2. **ZCode 升级后钩子格式变了，悄悄失效**。对策：`session-start` 每次写 `hook.mode` 进账本；`doctor` 检查"安装了钩子但近 N 次会话没有 session.started"，即报"钩子疑似失效"。
3. **摘要越积越多，brief 变长又没用**。对策：brief 只取最近 1 全文 + 3 行；摘要结构固定，不做自由文本堆积。
4. **又开始加功能**。对策：§2 第 12 条范围冻结 + M22 后恢复停止扩展契约。
