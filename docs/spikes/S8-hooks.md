# S8：ZCode 钩子实测（T-162 / M19 阻断项）

日期：2026-11-26（UTC 02:39–02:56）｜宿主：ZCode Desktop 4.0.0.10870 / 无头 CLI `zcode.cjs` 0.18.0｜Node v24.14.0 / win32 x64
证据 JSON：`docs/evidence/s8-zcode-hooks.json`

## 0. 结论（前置）

**S8 判定门通过（附 Q2 PermissionRequest 例外，待具名核验）：Q1、Q2、Q4、Q5 机制均有真实 ZCode 宿主日志/钩子 stdin/模型上下文证据；M19 不因机制缺失降级。T-163 仍保持关闭，等待项目所有者核验。**

| 编号 | 问题 | 本次结论 | 状态 |
|---|---|---|---|
| Q1 | 配置位置/键、user 与 workspace 合并 | 用户级 `<HOME>/.zcode/cli/config.json` 顶层 `hooks` + `hooks.enabled:true` 真实生效；项目级 `.zcode/config.json` 被 workspace trust 门禁拦截（但可发现/审阅），两者并存时用户钩子照常执行 | **可用** |
| Q2 | 7 事件 stdin 字段 | 6 个事件取得真实 stdin（双字段命名），`PermissionRequest` 被宿主调用但无头模式取消、无子进程样本 | **可用** |
| Q3 | 编辑/写入/shell 工具名 | `Edit`/`Write`（路径字段 `file_path`）、shell 为 `Bash`；另取到完整工具表 | 已实测 |
| Q4 | PreToolUse deny/ask 输出与模型侧可见性 | deny 阻断工具且理由回显；ask 触发权限提示 | **可用** |
| Q5 | SessionStart additionalContext 是否入上下文/长度上限 | marker 进入模型上下文（rollout + 模型复述）；宿主截断上限 24000 字符 | **可用** |
| Q6 | Stop 继续格式/3 次计数/继续中标志 | `decision:"block"` + additionalContext 触发继续；实测 4 次 Stop（3 次继续），`stop_hook_active` 由 false 变 true | 已实测 |
| Q7 | 超时/非零退出/非 JSON stdout 行为 | `timed_out`/`failed`/静默忽略，会话均继续；宿主不会自动 deny | 已实测 |
| Q8 | 钩子进程 cwd/env、中文与空格路径 | cwd 与项目路径一致，注入 4 个非秘密路径/会话变量，中文空格路径正常 | 已实测 |

所有"已实测"结论都有对应真实会话/日志；无合成样本冒充实测；未读取真实会话 transcript。

> 证据覆盖修正说明：本文件早先一版结论为"判定门未通过（钩子未执行）"。那一版在隔离 HOME 下未让钩子进程运行。后续实测发现，只要隔离 HOME 下用户级 `config.json` 含 `hooks.enabled:true` 且 `events.*` 配 `type:"process"`，真实 CLI 会话就会执行钩子并投递 stdin（证据：隔离日志 `hook.run.allowed`/`hook.run.failed`，钩子侧 JSONL 记录）。本版为经复核后的最终结论。

## 1. 隔离与合规

| 项 | 做法 |
|---|---|
| 项目 | `os.tmpdir()/ano-s8-work/项目 with spaces`，真实 Git 仓库（`git init` + 提交 `eb5dd0e`），路径含中文与空格 |
| 脚本 | 探针放在 `os.tmpdir()/ano-s8-work/scripts/hook-probe.cjs`，与提取的宿主文件分目录 |
| 工作区配置 | 只写 `<isolated>/.zcode/config.json`（`hooks.enabled=true`，7 事件，`type:"process"` + `args[]`，无 shell 拼接） |
| 用户配置 | 只在隔离 HOME `os.tmpdir()/ano-s8-work/isolated-home/.zcode/cli/config.json` 写入；真实 `<home>/.zcode/cli/config.json` 从未写入 |
| ANO 仓库配置 | 只读；仅写入本 spike 与证据 JSON 两个交付文件 |
| 认证 | 复用现有登录态；未读取、打印或复制任何凭证内容 |
| 隐私 | `transcript_path`、prompt 正文、模型响应正文、工具内容字段均按 `src/clients/redact.ts` 脱敏或不记录 |

## 2. Q1：配置位置、键与作用域

用户级配置片段（隔离 HOME，原样）：

```json
{"hooks":{"enabled":true,"timeoutMs":3000,"maxOutputBytes":16384,
  "events":{"SessionStart":[{"hooks":[{"type":"process",
    "command":"C:\\Program Files\\nodejs\\node.exe",
    "args":["<PROBE>","USER-SessionStart","<LOG>","<BEHAVIOUR_DIR>"],
    "timeoutMs":3000}]}],
  "...其余事件同构..."}}}
```

- 顶层 `hooks` 键；`events.<Event>` 为数组，元素 `{matcher?, hooks:[{type,command,args,timeoutMs}]}`；7 个事件名与规格一致。
- 项目级 `.zcode/config.json` 同样结构可发现，但每次启动日志都报 `config.project_hooks.pending_trust`（`configScope=project`：`Project hooks are pending workspace trust and remain blocked`），项目钩子不执行。
- 宿主代码佐证（`D:/zcode/resources/glm/zcode.cjs`）：`C4e` 为 7 事件枚举，`wle`/`iA` 解析配置路径，`R4e` 从 `<HOME>/.zcode/security/workspace-hook-trust-v1.json` 读取持久信任，`ple()` 按 digest 判 `trusted_persistent`/`pending_trust`。
- **与技能的偏差（以实测为准）**：`diagnosing-hooks` 说非插件配置 hooks 无信任门；本机 4.0.0.10870 上用户级无门、项目级有门。安装器/文档必须如实处理。

## 3. Q2：7 事件 stdin 字段

6 个事件取得真实样本（逐字段脱敏版见证据 JSON 的 `evidence.stdinSamples`）：

| 事件 | 触发 | 关键字段 | 首样本时间(UTC) |
|---|---|---|---|
| SessionStart | 会话启动 | `source:"startup"`、`cwd`、`session_id`、`model`、`permission_mode` | 02:45:23.154Z |
| UserPromptSubmit | 用户提问 | `prompt`（脱敏）、`cwd`、`session_id` | 02:45:23.281Z |
| PreToolUse | 工具调用前 | `tool_name`/`toolName`、`tool_input`/`toolInput`、`tool_use_id`、`riskLevel`、`sideEffectScope` | 02:45:59.123Z |
| PostToolUse | 工具成功 | `tool_input`、`tool_response`（脱敏）、`tool_use_id` | 02:46:00.672Z |
| PostToolUseFailure | 读不存在文件 | `error`、`error_details`、`is_interrupt`、`tool_name` | 02:54:51.113Z |
| Stop | 会话结束 | `stop_hook_active`/`stopHookActive`、`responsePreview`（脱敏）、`toolCallCount` | 02:45:29.809Z |
| PermissionRequest | ask 决策 | 无 stdin（日志 `hook.run.failed outcome=cancelled`）；schema 由宿主代码确认 | 02:55:41.414Z |

所有样本同时含驼峰与 snake_case；`cwd` 均为含中文空格的隔离项目路径；`tool_input` 中路径字段是 `file_path`。宿主会写 `transcript_path` 临时文件，本 spike 按 ADR-013 §2.5 未读取。

## 4. Q3：工具名

实测工具事件：`Bash`（`tool_input:{command,description}`）、`Read`、`Write`、`Edit`（`tool_input.file_path`；Write 另有 `content`，Edit 另有 `old_string`/`new_string`/`replace_all`）。宿主 model-io rollout 的 `toolNames` 还含 `Agent`、`AskUserQuestion`、`TaskOutput`、`TaskStop`、`Skill`、`WebFetch`、`TodoWrite` 等（完整清单见证据 JSON）。未见 `Glob`/`Grep`/`ApplyPatch`；不得把其他客户端别名当作 ZCode 实测。

## 5. Q4：PreToolUse deny/ask

输出格式（`O5r`/`jBs` schema 确认）：

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse",
  "permissionDecision":"deny|ask|allow","permissionDecisionReason":"..."}}
```

顶层另有 `decision:"approve"|"block"`、`continue`、`systemMessage`；退出码 2 等价 deny。

- deny：对 `Read src.ts` 返回 deny 后该次调用无 PostToolUse（工具未执行）；模型回答中出现理由 `S8-TEST-DENY from isolated probe`。
- ask：模型收到 `ZCode requested permissions to use Read, but you haven't granted it yet`，未读到文件；随后 PermissionRequest 钩子被宿主调用，但无头模式无交互授权 → outcome=cancelled。

限制：PermissionRequest 的 stdin 未取得，桌面 GUI 的提示形式未截图。

## 6. Q5：additionalContext

钩子输出 `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"S8-CONTEXT-INJECTED-MARKER-7781: ..."}}` 后：

- 模型准确复述 marker；宿主 rollout 显示 `<system-reminder>\nSessionStart hook additional context: \n#1\n<marker>\n</system-reminder>`；
- 宿主代码：`Kmc()` 编号 `#1..`，`Yai(text, Gmc=24e3)` 单条截断 24000 字符；`Gai()` 对相同 SessionStart 锚点去重。

来源：`model-io-sess_*.jsonl`（仅结构片段）、`zcode.cjs`。

## 7. Q6：Stop 继续

有效格式：`{"decision":"block","reason":"...","systemMessage":"..."}` 或 `hookSpecificOutput.Stop.additionalContext`。仅 `{"continue":true,"reason":"..."}` **不触发**继续：宿主 `Kai()` 要求 `stopShouldContinue && additionalContexts.length>0 && count<3`。

实测单次会话 Stop 子进程 4 次，`stop_hook_active` 依次 `false,true,true,true`；宿主常量 `Hmc=3`（最多 3 次继续）。rollout 显示继续指令以 `Stop hook additional context: #1 ... #2 ...` 注入。ADR-013 §4.4 的"最多 2 次 continue"实现方案可行，但必须提供 additionalContext/systemMessage。

## 8. Q7：异常行为

| 场景 | 实测结果 | 时间(UTC) |
|---|---|---|
| 超时（process timeoutMs=3000，脚本 sleep 8s） | `hook.run.failed outcome=timed_out durationMs=3002`，输出未注入，会话继续 | 02:52:37.433Z |
| 非零退出（exit 7 + stderr） | `hook.run.failed outcome=failed`，stderr preview 入日志，会话继续 | 02:53:35.520Z |
| stdout 非 JSON | `uja()` 静默忽略，无失败日志，marker 未入模型上下文，会话继续 | ~02:54:00Z |
| 合法 JSON 含未知字段/错误事件名 | 源码显示 `Hook stdout failed HookJSONOutput schema validation`（非实测触发，注明来源） | — |

宿主异常时是"忽略输出并继续"，**不自动 deny**。ADR-013 §2.7 的 fail-closed 必须由 `ano hook` CLI 自己实现。

## 9. Q8：cwd / env / 中文空格路径

钩子进程 cwd = `D:\Temp\ano-s8-work\项目 with spaces`（与 stdin.cwd 一致）；宿主注入 `ZCODE_PROJECT_DIR`/`CLAUDE_PROJECT_DIR`（项目路径）、`ZCODE_SESSION_ID`/`CLAUDE_SESSION_ID`。其余环境变量按 `redact.ts` 只记数量（93）不记值。中文+空格路径在 command、参数数组与 stdin 中均正确传递。

## 10. 判定与后续约束

- Q1/Q4/Q5 与 Q2 的 6 个事件机制可用；Q2 的 `PermissionRequest` 在无头模式下被宿主在授权交互前取消，未产生子进程样本（6/7）。
- 按规格严格口径，这一项是可核验的例外而非“已测通过”；**T-163 保持关闭，等待具名所有者核验后放行**，不自动启动。
- T-166：不能假设写工作区配置即生效（有 workspace trust 门禁）；路径字段以 `file_path` 为准；Stop 继续必须带 additionalContext/systemMessage。
- `ano hook` CLI 自身负责 fail-closed。
- 脱敏：env 仅白名单非秘密键；prompt/响应/工具内容替为 `[redacted]`；transcript 路径不记录；证据 JSON 可安全入库。

## 11. 控制器独立复核（2026-11-26T03:04–03:10Z）

为避免采信单一执行者，主控在另一个隔离 HOME 上独立重跑（仅复制真实 `~/.zcode/cli` 的 `db` 与 `plugins` 状态用于启用 runner；未复制凭证、未改真实配置）：

- 首版探针因换行转义错误导致 `hook.run.failed`；修正后 `SessionStart`/`UserPromptSubmit`/`Stop` 均产生真实 stdin 日志，cwd 为含中文与空格的隔离路径，session_id 为真实 `sess_...`。
- Q5：SessionStart 注入 `S8-VERIFY-MARKER-1795662320`，模型原样复述；additionalContext 进入模型上下文成立。
- Q4：PreToolUse 对 `Read` 返回 deny，模型收到 `S8-VERIFY-DENY` 理由，Read 未执行、无 PostToolUse；deny 阻断成立。
- Q2 缺口复核：`guarded` 模式分别用 `Bash` 与 `Write` 尝试，均未触发 PermissionRequest 子进程；与前一执行的“无头授权前取消”一致。
- 真实用户配置 mtime 保持 2026-11-19 20:48，ANO 配置保持 2026-11-19 19:33；隔离目录在证据固定后清理。
