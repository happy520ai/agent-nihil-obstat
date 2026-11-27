# 接管项目的宿主默认启动、任务派发与能力降级（T-073 / TO-09）

- 日期：2026-11-22
- 任务：T-073 / TO-09（M10），依赖 TO-05（T-069）/ TO-08（T-072）
- 性质：隔离项目 harness 验证。全部写操作发生在 `os.tmpdir()` 合成根，不触碰用户真实项目、`.pm/`、`.ano/` 或用户级配置。
- 执行者：子代理（唯一执行者）；PM 簿记由主控负责。
- 交付物：`test/integration/takeover-host.test.ts`、本报告。

## 1. 结论

**范围内完成（harness/隔离项目层）。** 在合成 tmpdir 项目根上，T-067 六阶段接管到 `enforced` 后：

- 会话启动读取策略成立：受管 `AGENTS.md` 段声明「默认工作流使用 ANO + 旧 PM 只读」，`brief` 返回 `takeover.state=enforced / primaryWriter=ano / legacyRole=read-only / hostCapability=degraded`。
- 任务领取与验收回写成立：`track` / `note` / `verify` / `complete` 全部落 ANO ledger，`.pm/` 字节不变且不含新任务。
- 调度器泛化成立：从接管根以 `--plan` spawn 真实 `scripts/orchestration/cli.ts` dry-run，对 `MFIX` 里程碑的 todo 任务产出 `dispatch` 动作，且零写入。
- 能力降级贯穿：policy、verification 证据、brief、CLI status、角色矩阵均报告 `hostCapability=degraded` 与三条 T-055 缺失原因。

**禁止虚报声明**：本任务不宣称宿主自动调用 verify、不宣称无人值守 daemon、不把 harness 证据当作宿主证据。宿主无输出拦截/自动批准/自动建会话的公开接口（T-055），权限仍由宿主/具名人工处理。

## 2. 测试场景 × 结果

命令：`node --test test/integration/takeover-host.test.ts`

| # | 分层 | 场景 | 关键断言 | 结果 |
|---|---|---|---|---|
| 1 | L1 库 | 普通项目 brief 无 takeover 块；接管 active 后受管段与 brief 投影 | 受管段含 `renderDefaultManagedInstructions('enforced')`；`primaryWriter=ano`、`legacyRole=read-only`、四 scope 全 `ano`、`workflow=[brief,track,note,verify]`；`hostCapability=degraded`；文本不出现自动拦截/自动批准 | 通过 |
| 2 | L1 库 | enforced 下领取任务、写记忆、验收回写 | `track`/`note`/`verify`/`complete` 响应携带 `state=enforced`；ANO ledger 有 `evidence.recorded` 与 `task.updated(status=done)`；`.pm` 快照字节不变且不含 `T-HOST-1`；旧源 migrate apply 被拒 | 通过 |
| 3 | L2 stdio | 真实 spawn MCP（`ANO_ROOT=合成根`） | `tools/list` 恰为 `[brief,explore,recall,track,note,verify,audit]`；`brief` 返回 `enforced` 投影 | 通过 |
| 4 | L2 stdio/CLI | 真实 spawn CLI `takeover status` | 退出码 0；`state=enforced`、`hostCapability=degraded`、schema 正确 | 通过 |
| 5 | L3 会话/主控适配 | 真实 spawn 调度器 `--plan` dry-run | `mode=dry-run`、动作 `dispatch T-PM-3`；不创建 `.pm/orchestration-state.json`；`.pm` 快照不变 | 通过 |
| 6 | L3 会话层 | 宿主自动能力缺失的显式声明 | 常量 `HOST_AUTO_INTERCEPTION_AVAILABLE=false`、`HOST_AUTO_APPROVAL_AVAILABLE=false`、`HOST_AUTO_SESSION_DAEMON_AVAILABLE=false`；引用 T-055 结论文档；静态核对 `pm-bridge.mjs` 是显式 stdio 桥 | 通过 |
| 7 | L4/L5 | 分层状态可查 | 本报告含 `\| UI \|`、`\| 跨项目 \|`、`未现场验证` 与交叉引用；harness 常量标注 UI/跨项目未验证 | 通过 |

## 3. 分层证据表

| 层 | 证据来源 | 已验证内容 | 状态 |
|---|---|---|---|
| 库 | `test/integration/takeover-host.test.ts` L1 用例 | 合成根六阶段接管到 active；启动读取策略；任务领取与验收回写走 ANO；`.pm` 零改 | 已验证（隔离 tmpdir 项目根） |
| stdio | 本测试 L2 真实 spawn `src/surface/mcp.ts`（7 工具 + brief 投影）；`test/integration/mcp.test.ts`（tools/list=7）；`test/integration/migrate-takeover.test.ts`（takeover 分支 track kind=takeover） | 真实 stdio 传输与七工具面在接管前后可用；takeover 分支存在 | 已验证 |
| 会话 | 主控适配先例 `scripts/orchestration/pm-bridge.mjs`（显式 spawn pm-mcp stdio JSON-RPC）；本测试以显式 `brief` 调用模拟会话启动 | 「会话启动读取策略」由 ANO 侧投影证明；宿主自动创建会话不存在 | 已验证（ANO 侧行为）；宿主自动启动未验证且不存在公开接口 |
| UI | 无（需人工点击 Settings → MCP / Plugin Management） | —— | 未现场验证 |
| 跨项目 | 无（需在非 ANO 项目用真实 ZCode 会话调用工具并核对独立账本） | —— | 未现场验证 |
| 输出拦截 | T-055 调查（工具面枚举 + 配置扫描 + hooks 事实） | 未发现公开接口；hooks 为工具级闸门且未用于 ANO | 已验证（未发现公开接口）；hooks 拦截实验未验证 |

分层口径与 `docs/evidence/host-capability-investigation.md` §2 一致：任一层成功不能代替其他层；harness 成功不等于宿主自动闭环。

## 4. 能力边界与宿主限制陈述

### 4.1 宿主能力缺失（T-055 实证，ADR-006 §8 固定为 degraded）

`TAKEOVER_HOST_CAPABILITY_REASONS` / `CONNECT_HOST_DEGRADATION_REASONS` 三条：

1. 宿主无面向 MCP 结果/模型输出的输出拦截接口；
2. hooks 是工具级闸门，当前未针对 ANO 启用；
3. 无自动启动/自动批准能力，新会话权限不能由 ANO 代批。

因此「宿主默认启动」只能降级为：受管 `AGENTS.md` 段提示 + 人工确认；不得声称宿主自动读取策略、自动启动 ANO 或自动拦截旧源写入。测试与文档均不得出现「自动拦截 / 自动批准 / auto-intercept / auto-approve」类声明（L1/L3 用例做否定断言）。

### 4.2 权限仍需宿主处理的能力清单

以下动作在本任务与接管工作流中一律保持人工/宿主处理，ANO 不代批：

| 能力 | 处理方 | 说明 |
|---|---|---|
| MCP 工具权限 / PermissionRequest | 具名人工（宿主交互） | 接管授权记录不是 token，不改变宿主权限面 |
| 发布 approve / attest / release approve / sync / push | 具名人工 | ADR-006 §2 硬边界 4；未暴露给接管工作流 |
| 撤销授权 / 恢复旧主写 | 具名人工（`takeover revoke/recover --confirm`） | 状态切换仍需显式 confirm |
| 宿主 hooks 配置 | 具名人工（用户级/工作区配置） | ANO 不修改用户级配置 |
| 跨项目读写目标 `.ano/` 账本 | 需单独授权 | 未现场验证 |

### 4.3 证据边界

- 本任务的 L1/L2/L3 证据来自 `os.tmpdir()` 合成根，属 ADR-006 §8 的「隔离项目」层，不是用户真实项目层。
- 合成根中没有后台 daemon：所有进程都是测试显式 spawn 的短命子进程。
- UI 与跨项目两层在本 harness 中未现场验证；真实项目层需用户明确指定项目与授权后另行验收。

## 5. 交叉引用

- `docs/evidence/host-capability-investigation.md`：T-055 七层宿主能力调查（本报告沿用其口径；本报告不重复其实时主机日志/配置事实）。
- `docs/adr/ADR-006-project-takeover.md` §8：宿主能力降级与验收分层判据。
- `docs/takeover.md`：接管协议与文件所有权。
- `scripts/orchestration/pm-bridge.mjs`：主控适配先例（显式 stdio 桥，非宿主自动能力）。
- `scripts/orchestration/protocol.md` / `scripts/orchestration/cli.ts`：T-069 泛化调度器契约与 `--plan` 只读 dry-run。

## 6. 复现步骤

```bash
cd "<repo>"
node --test test/integration/takeover-host.test.ts
node --test test/integration/takeover.test.ts test/integration/takeover-drift.test.ts
npx tsc -p tsconfig.json --noEmit
```

约束：TypeScript strict；合成根使用 `os.tmpdir()`；除仓库既有依赖外无新增第三方依赖。
