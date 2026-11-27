# 宿主能力调查（T-055 / AP-18）

- 日期：2026-11-22
- 任务：T-055 AP-18 实测 ZCode 宿主拦截能力与跨项目消费证据
- 性质：只读调查。未修改用户级 MCP 注册（`<home>/.zcode/cli/config.json` 只读），未固定全局 root 为 ANO 源码目录，未安装依赖、未发布、未执行写实验。
- 执行者：子代理（唯一执行者）；PM 簿记由主控负责。

## 1. 结论

**未发现 ZCode 宿主公开面向 MCP 结果 / 模型输出的「输出拦截 / 适配」接口。**

依据（均来自实际可见工具与配置）：

- 本会话可见 MCP 工具面中不存在 host-interception / approval-automation 类工具：`mcp__ano__*`（7）、`mcp__pm-mcp__*`、`mcp__zcode-internal__*`（13：chat / chat_stream / computer_use / forge_* / knowledge_* / models_library / providers_list / system_health / workforce_*）与插件工具，无一提供拦截或自动放行能力。
- 三份配置（用户级 `cli/config.json`、遗留 `v2/config.json`、工作区 `.zcode/config.json`）均无 `hooks` 键；`setting.json` 无 permission / approve / autoApprove / intercept 键。
- 宿主确实存在 hooks 机制（7 个事件：`SessionStart` / `UserPromptSubmit` / `PreToolUse` / `PermissionRequest` / `PostToolUse` / `PostToolUseFailure` / `Stop`），`PreToolUse` / `PermissionRequest` 可返回 allow/ask/deny，`Stop` 可请求继续（≤3 次），`additionalContext` 可注入。但这是**工具级闸门**，不是回答输出适配器；当前未针对 ANO 配置，且 MCP 调用返回后客户端自行渲染的文字不在其截获范围内。

因此维持「显式 verify 工具流 + 本地 harness」现状，**不宣称自动拦截**。

## 2. 分层证据表

| 层 | 证据来源 | 结果 | 状态 |
|---|---|---|---|
| 库 | `test/integration/anchor-probe-consumer.test.ts`（9 用例）+ `test/harness/anchor-probe-consumer.ts` | 真实 probe→freeze→read→verify 闭环；v1 恒 `NEEDS_REVIEW`；展示/模拟执行门控；输出非 Gate 形状（无 evidence_id/verdict/task_id） | 已验证（T-054 交付，本报告引用，不重复断言） |
| stdio | `test/integration/mcp.test.ts` | 真实 stdio `tools/list=7`；AP-13 分发（note revise、brief memory_context、recall probe、verify context=`NEEDS_REVIEW` 且无 evidence_id） | 已验证（T-050/T-052 交付，本报告引用） |
| 当前会话 | 本会话工具列表；实时调用 `mcp__ano__brief`；主机日志 | 7 个 `mcp__ano__*` 可见；brief 返回 `phase=P7`、`tools=7`、真实任务 `ANO-M5-001`；日志记录 tool.call.started/completed | 已验证（本次实测） |
| Settings/UI | `cli/config.json`、`v2/config.json`、工作区 `.zcode/config.json`、`setting.json`、zcode-guide 的 zcode-configuration-guide / diagnosing-hooks 技能 | 注册作用域与合并规则（user 覆盖 workspace）；MCP 默认受信并自动连接；hooks 机制存在但配置未启用；无自动批准键 | 配置事实已验证；UI 点击未验证 |
| 第二项目 | `cli/config.json` 用户级注册；主机日志 `zcode-2026-11-22.jsonl` | ano 今日在 5 个工作区连接（含 4 个非 ANO 项目）；日志仅见 ANO 工作区有 `mcp__ano__brief` 调用 | 注册与连接已验证；跨项目工具消费未现场验证 |
| 输出拦截 | 工具面枚举 + 配置关键字扫描 + 主机日志 + zcode-internal 打包 | 无 MCP 拦截 API；hooks 机制存在但未用于 ANO | 已验证（未发现公开接口）；hooks 拦截实验未验证 |
| 真实模型 | `test/harness/anchor-probe-consumer.ts` 的 `createTestModel` | 脚本化模型（clean / bad / 挂起 / 抛错），未接真实模型 API | 单列未验证 |

## 3. 当前会话层细节

- 可见 `mcp__ano__*` 工具名（7）：`brief`、`explore`、`recall`、`track`、`note`、`verify`、`audit`。
- 实时调用 `mcp__ano__brief`（无参数）成功，返回 `phase=P7`、`tools=[brief,explore,recall,track,note,verify,audit]`、`tasks=[ANO-M5-001]`、`connected.connected=false`。
- 主机日志 `<home>/.zcode/cli/log/zcode-2026-11-22.jsonl`：
  - `mcp.server.connected`：`mcpServerName=ano`、`transport=stdio`、`workspaceKey=F:\Agent Nihil Obstat`、`sessionId=sess_40435b7d-91ff-48d4-93c2-db9ec08ecf6a`（2026-11-22T04:22:14.809Z）。
  - `tool.call.started` / `tool.call.completed`：`toolName=mcp__ano__brief`（2026-11-22T05:12:22.341Z / 05:12:34.138Z，子代理会话 `sess_subagent_agent_fd9184ff-ecd2-49ed-9285-ed91a0c66a95`，`parentSessionId=sess_40435b7d-...`）。
- 作用域推断（基于合并规则，非直接探针）：`pm-mcp` 与 `zcode-internal` 仅注册于 `cli/config.json`，而本会话可见其工具，故 `cli/config.json` 为当前生效用户配置；同名 `ano` 按「user 覆盖 workspace」规则来自用户级注册。

## 4. Settings/UI 与注册作用域（配置事实）

| 文件 | 作用域 | ano 注册 | 其他事实 |
|---|---|---|---|
| `<home>/.zcode/cli/config.json` | 用户级 | `mcp.servers.ano` → `<home>/.zcode/ano-mcp.mjs`（无 `cwd` / `ANO_ROOT`） | 另含 `pm-mcp`、`zcode-internal`；无 `hooks` 键 |
| `<home>/.zcode/v2/config.json` | 遗留（未被配置指南列为生效位置） | `mcpServers.ano` → 同一 wrapper；另有 `aos-memory`（SSE） | 今日主机日志中 `aos` 出现 0 次，判定未加载 |
| `F:/Agent Nihil Obstat/.zcode/config.json` | 工作区 | `mcp.servers.ano` → `dist/surface/mcp.js`，`cwd=ANO_ROOT=F:/Agent Nihil Obstat` | 单项目固定 root |

- 合并规则（zcode-configuration-guide）：CLI → 环境 → 用户 → 工作区 → 系统默认；user 覆盖 workspace 同名 server；各作用域 MCP 默认受信并在会话开始自动连接。
- UI 机制（仅描述，未点击验证）：**Settings → MCP** 查看/修复服务器；**Settings → Plugin Management** 查看插件 hook；`PermissionRequest` 为交互式人工批准（会话内 `AskUserQuestion` 工具）。
- 文档漂移提示：`docs/zcode-integration.md` / `docs/delivery-status.md` 仍把 `~/.zcode/v2/config.json` 描述为用户级配置；实际生效的是 `~/.zcode/cli/config.json`（由本会话可见的 pm-mcp / zcode-internal 工具与主机日志共同证明）。本报告不修改这些文档。

## 5. 第二项目层

- 用户级注册（`cli/config.json` 的 `mcp.servers.ano`，无 `cwd`/`ANO_ROOT`）→ 跨项目能力成立，不固定全局 root。
- 主机日志：今日 `ano` 在 5 个工作区连接：`F:\Agent Nihil Obstat`、`F:\云服务器`、`F:\星驰任务`、`<example-project>`、`F:\token管理工厂`（11 次 `mcp.server.connected`）。
- 但日志中 `mcp__ano__*` 工具调用仅见 ANO 工作区的 `brief`（2 条，含本次调查调用）。**跨项目「消费」（在另一项目真实调用工具并读写该项目 `.ano/` 账本）未现场验证。**
- 仓库既有证据：`docs/zcode-integration.md`、`docs/delivery-status.md`、`README.md`、`.pm/changelog.md` T-028（真实 stdio initialize / tools=list 恰 7 工具、跨项目独立账本测试）、`test/integration/zcode-config.test.ts`（临时工作区配置启动真实 MCP，`brief` 断言读临时项目而非本仓库）。
- 后续所需步骤（需授权）：在非 ANO 项目（如 `F:\星驰任务`）用真实 ZCode 会话调用 `mcp__ano__brief` / `explore`，核对该项目的独立 `.ano/` 账本与 `phase`，并记录工具名与返回。

## 6. 输出拦截层

- 工具面：无。`mcp__zcode-internal__*` 13 个工具中无 interception / approval-automation 接口；zcode-internal 打包内 `intercept` / `autoApprove` / `permissionDecision` 字符串检索为空。
- hooks 机制：存在（见 §1）。配置式 hooks 需 `hooks.enabled: true`（默认禁用）；插件 hooks 自动启用。
- 当前 hooks 事实：`cli/config.json` 无 `hooks` 键；工作区 `.zcode/config.json` 无 `hooks` 键；已启用插件中 `superpowers` 注册 `SessionStart`，`video-agent-kit` 注册 `SessionStart` / `UserPromptSubmit` / `Stop`（均非 ANO、非输出拦截）；`android-emulator` / `ios-simulator` 的 `hooks.json` 为空对象。
- 结论：**未发现公开接口**。hooks 是工具级机制，不能截获 MCP 调用返回后客户端自行生成的文字；即使为 ANO 配置 hooks，也不构成「回答输出适配」。

## 7. 真实模型层

- harness 使用 `createTestModel` 脚本化模型；未接真实模型 API。
- 后续验收需要：授权后注入真实模型 API（generate / repair），记录端到端延迟、token/成本、修复率与失败卡片，并与库层 harness 结果对照。

## 8. 与 harness 证据的分离声明

`docs/anchor-probe-integration.md` §14 的 harness 证据只覆盖库级调用协议（probe → 缓冲 draft → 真实校验 → 最多一次修复 → 失败卡片）与展示门控，**不是宿主能力证据**。本报告只调查宿主能力与跨项目 / 拦截事实，不重复也不放大 harness 结论；两层证据互不替代，任一层成功不能代替其他层。

## 9. 限制陈述（不得宣称自动拦截）

- MCP 服务无法截获客户端在本次调用返回之后生成的文字。
- 提示词要求 agent 自觉调用工具 ≠ 已验证的自动拦截。
- hooks 为工具级闸门，需显式配置启用，当前未用于 ANO；即使启用也不构成回答输出适配。
- 未修改用户级 MCP 注册、未固定全局 root、未安装依赖、未发布。
- 跨项目工具消费、hooks 拦截、真实模型三层为未验证项。

## 10. 后续授权才可进行的实验清单

1. 真实第二项目消费：授权后在非 ANO 项目会话调用 `mcp__ano__brief` / `explore`，核对独立 `.ano/` 账本（需授权读取/写入目标项目）。
2. hooks 拦截实验：授权后在隔离配置中设置 `hooks.enabled: true` 与 `PreToolUse` / `Stop` hook，观察对 `mcp__ano__*` 或 `verify` 的阻断 / 续跑（需修改用户级或工作区配置）。
3. 真实模型适配：授权后把真实模型 API 注入 consumer harness，记录端到端延迟 / 成本 / 修复率。
4. UI 层人工确认：在 Settings → MCP / Plugin Management 人工核对 ano 状态与 hook 列表（需人工操作，非只读）。
5. 依赖 / 发布类实验：需单独授权。
