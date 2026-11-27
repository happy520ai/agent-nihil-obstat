# T-168：ZCode 钩子实测验收（M19）

结论（前置）：**PASS**。真实 ZCode 宿主进程 + 当前 `dist/surface/cli.js` 在 `os.tmpdir()` 隔离 Git 项目中跑通全链路：新会话自动注入 ANO brief、未 explore 的 TS 文件被 `ask`（advisory）/ `deny`（strict）拦截、完成 file-level outline 后放行、无归属改动触发 Stop 补记且补记后正常结束。按规格将 ZCode `enforcement` 升级为 `hooks-validated`，Claude Code 保持 `hooks-documented`。机器证据：`docs/evidence/m19-zcode-hooks-validation.json`。

## 1. 隔离与合规（无真实项目/配置改动）

| 项 | 事实 |
|---|---|
| 隔离项目 | `os.tmpdir()/ano-t168-work/project`，真实 Git 仓库（初始提交 `f375fbe`），含 `package.json` 与 `src/*.ts` |
| 隔离 HOME | `os.tmpdir()/ano-t168-work/isolated-home`；每次 ZCode CLI 调用均以 `HOME`/`USERPROFILE` 指向此处 |
| 用户真实配置 | `<home>/.zcode/cli/config.json` 与 ANO 仓库配置**从未写入**（仅读取本仓库实现与既有证据） |
| 钩子来源 | 真实 CLI `ano clients install zcode --with-hooks --confirm --home <isolated-home>`；安装回执 `beforeHash=2b3d1324…`、`afterHash=73daab18…`、`backupId=cfg-mwx3emq4-a8b6f11a` |
| 钩子命令 | 绝对 node 路径 `C:\Program Files\nodejs\node.exe` + 绝对 `<repo>\dist\surface\cli.js` + `hook <event> --client zcode --root <isolated project>`，args 数组、无 stdin/shell 拼接（仅 4 事件：`SessionStart`/`UserPromptSubmit`/`PreToolUse`/`Stop`，type=process） |
| 脱敏 | 沿用 `src/clients/redact.ts`：只记非秘密元数据；prompt/响应/工具内容、transcript 路径、env 值、凭证不记录；宿主权限提示正文记为 `[host-permission-message]`，仅保留 ANO 来源的 `ruleId`/`decision`/`reason` |

## 2. 真实会话链路与判定

### Q1 新会话自动 brief — PASS
真实 ZCode headless 会话（`--prompt`）SessionStart 钩子注入 `additionalContext`。模型被要求复述注入内容时原样输出：

```
# ANO brief (最小投影)
## 当前焦点
- （无焦点任务）
## 断点下一步
- （无断点记录）
```

宿主日志：`hook.session_start_context.resolved result=written`（每个新会话均出现）。账本写入 `session.started` 事件（首条 ID 见 JSON `ledgerEventIds.session.started`）。

### Q2 未 explore 的 TS 文件被拦截 — PASS
- advisory（安装默认）：`permissionDecision=ask`，reason：`src/math.ts 在当前 revision 没有结构探查证据。请先 explore 该文件（outline/impact）并把结构证据绑定到当前 revision 4d9f1839…`。工具未执行、无 PostToolUse、文件未改。
- strict：`permissionDecision=deny`，exit code 2；reason `src/other.ts 在当前 revision 没有结构探查证据`。
- 宿主日志：`hook.run.allowed source=config.PreToolUse.0.0` 紧接 `tool.permission.resolved ruleId=hook.PreToolUse.ask decision=deny`。
- 决定计数（脱敏 tee 追踪，见 JSON `decisionCounts`）：advisory 追踪 34 次钩子调用中 pre-tool `ask=5`；strict 追踪 pre-tool `deny=3`。

### Q3 完成 file-level explore 后放行 — PASS
对 `src/math.ts` 执行真实 file-level outline 查询（`structureFileQuery`，同一条服务代码路径），写入 `structure.queried` 事件 `01M8B496ZT09KNHYAAM3RS9PHB`，`graph_revision=4d9f1839…`（随后因新增文件重建到 `f954b721…`，重新记录事件 `01M8B4N2BJ0P5HWAJ780JZZQEG`）。在同一 revision 的新会话里再次 `Edit`：

```
pre-tool Read  src/math.ts → permissionDecision=allow
pre-tool Edit  src/math.ts → permissionDecision=allow
```

模型报告 Edit 成功，真实 `git diff` 显示 `add` → `addTwo`。决定计数：该追踪 pre-tool `allow=23`。
注：`exploredFiles` 绑定 graph revision；新增 `src/other.ts` 使 revision 变化后覆盖失效（如预期），rebuild + 重新 outline 后恢复 allow，符合 ADR-013 §4.3。

### Q4 无归属改动 → Stop 补记 → 正常结束 — PASS
1. 无归属改动会话：Stop 输出 `decision=block` + `systemMessage`「ANO 收工检查未满足，请补记后再收工 / C1: 为无归属改动建任务或说明：src/math.ts」；账本 `session.stop_checked` seq=1 `C1.ok=false, decision=continue`（事件 ID `01M8B4A1W435R30C8HQ2TWB4H9`）。
2. 不无限循环：宿主以 `stop_hook_active=true` 再次 Stop，钩子返回 `{}`（stop-ok）；账本 seq=2 `decision=stop-ok, continuations_used=1`（`01M8B4D2M0NGDA0P631096F97Z`），没有第三次 continue。符合「最多 2 次 continue + 尊重 stopContinuation」。
3. 补记后正常结束：真实 CLI 创建归属任务 `T168-OWN-3`（`declared_files=[src/math.ts]`，事件 `01M8B4HA06AZ47TPRFSBC1F9CS`）与 checkpoint note（`01M8B4HZQNNNCC0WS1M1K39JRS`）。后续会话的 `session.stop_checked` seq=3（事件 `01M8B4KEDC20V51XQNKCXVXD27`）`C1.ok=true`，Stop 正常结束。

## 3. 钩子决定计数汇总（脱敏，来源：JSON `decisionCounts`）

| 追踪文件 | 钩子调用 | session-start | pre-tool | stop |
|---|---|---|---|---|
| hook-trace.jsonl | 34 | context-injected 1 | allow 23 / ask 5 / 降级 ask 2 | continue 1 / stop-ok 1 |
| hook-trace-strict.jsonl | 6 | context-injected 1 | deny 3 | stop-ok 1 |
| hook-trace2.jsonl | 5 | context-injected 1 | ask 2 | stop-ok 1 |
| hook-trace3.jsonl | 3 | context-injected 1 | — | stop-ok 1 |

> 计数仅表示钩子进程实际返回值；宿主权限层先行拦截且未到钩子的调用不计入。2 条「降级 ask」为无 `file_path` 的 Bash 工具调用触发的 `HOOK_INPUT_INVALID` fail-closed，符合 ADR-013 §2.7。

## 4. 账本事件 ID（隔离项目，真实写入）

| 事件类型 | 条数 | 关键 ID |
|---|---|---|
| `session.started` | 9 | 见 JSON `ledgerEventIds.session.started` |
| `session.stop_checked` | 11 | `01M8B4A1W435R30C8HQ2TWB4H9`（C1 fail→continue）、`01M8B4D2M0NGDA0P631096F97Z`（降级 stop-ok）、`01M8B4KEDC20V51XQNKCXVXD27`（补记后 C1 ok） |
| `structure.queried` | 2 | `01M8B496ZT09KNHYAAM3RS9PHB`、`01M8B4N2BJ0P5HWAJ780JZZQEG` |
| `task.created` / `task.updated` | 2 / 3 | `T168-OWN-3` = `01M8B4HA06AZ47TPRFSBC1F9CS` |
| `note.recorded` | 1 | `01M8B4HZQNNNCC0WS1M1K39JRS` |

## 5. 验收判定与能力矩阵

- ZCode：`enforcement = hooks-validated`（Q1/Q2 ask+deny/Q3/Q4 均有真实宿主日志 + 钩子 stdout + 账本事件 ID；无合成样本冒充实测）。
- Claude Code：`enforcement = hooks-documented`（仅公开文档，无本任务实测；保持不升级）。
- `output-interception` 仍 `unavailable`，本任务不改变该层（钩子为工具级闸门）。
- 限制见 JSON `limits`：PermissionRequest 无头子进程样本缺失沿用 S8 例外；无头写权限偶发被宿主权限层先行拦截；strict deny 时宿主把 CLI stderr 的 Node ExperimentalWarning 显示为 `hook error`，但 `deny`/exit 2 决定正确送达，属展示层行为。

## 6. 测试与报告

本任务为 chore 验收，核心证据为真实会话链路（本文件 + JSON + 宿主日志/账本），不要求 feature 质量门。相关测试/typecheck 与质量报告的运行结果记录在 PM 任务 T-168 的会话账本中。

## 7. 本次运行的验证记录（chore 验收）

| 命令 | 结果 |
|---|---|
| `npm run check-docs` | exit 0（Generated tool catalog is current） |
| `npm run typecheck` | exit 0（tsc --noEmit 无错误） |
| hooks 相关测试（6 文件：unit/hook-adapters、unit/hook-contract、unit/hook-pre-tool、integration/hook-session、integration/clients-install-hooks、redteam/hooks-boundary） | 81/81 pass，0 fail |
| `npm run test`（全量） | exit 0（含脚本 spike 跳过提示与 docs check） |
| 编译产物能力映射核验 | `buildEnforcementLevel({clientId:'zcode'})='hooks-validated'`、`claude-code='hooks-documented'`，与 §5 文档一致 |

> chore 验收以真实会话链路证据为主；上述测试/类型检查为回归确认，未运行 feature 质量门，未生成新的 `.pm/quality-runs` 报告。
