# 多客户端项目接管与 DAG 能力映射证据（T-086 / MC-08）

- 日期：2026-11-23
- 任务：T-086 / MC-08（M11），依赖 T-085（MC-07）
- 交付：`src/clients/capabilities.ts`、`test/integration/client-takeover.test.ts`、本报告
- 性质：只读映射 + 隔离项目实测。全部写操作发生在 `os.tmpdir()` 合成 home/root；未读取真实客户端配置内容，未修改用户级配置、`.pm/`、`.ano/`，未执行配置内容，未新增第八个 MCP 工具。
- 上游契约：`docs/adr/ADR-007-client-adapters.md`（九层/verdict）、`docs/adr/ADR-006-project-takeover.md`（三态/六阶段/备份回滚）、`docs/evidence/host-capability-investigation.md`（T-055 宿主无拦截接口）、`docs/evidence/takeover-host.md`（T-073 harness≠宿主自动拦截）、`docs/anchor-probe-integration.md` §14（harness 只是库级调用协议）。

## 1. 结论

**范围内完成（映射层 + 隔离项目层）。** `src/clients/capabilities.ts` 把 ADR-007 九层报告映射为八客户端 × 四列（MCP / 规则接管 / DAG / 恢复）判定，并经 `doctorClients` 编排产出、逐客户端失败隔离。映射口径固定：

1. **MCP** = `configured → mcp → tools → brief` 四层最弱值，只表示 ANO 包可配置并调用七工具。
2. **规则接管** = `instructions` 层，上限 `degraded`；受管 `AGENTS.md` 段检测是只读事实，写入需显式授权。
3. **DAG** = 通用显式调度器（`--plan` dry-run / 租约 / 恢复）可用性；客户端无公开派发接口时为 `degraded` + `mode:'explicit-workflow'`，绝不 `validated`，也不把 CLI doctor 成功放大为客户端自动派发。
4. **恢复** = M10 备份/回滚路径与客户端配置恢复（T-081 `restoreClientConfig`）分别标注；两者都需显式授权与已验证备份，故为 `degraded`。
5. **输出拦截** 一律 `unavailable`：未发现公开接口，工具级 hooks 不是输出拦截，不声称通用自动输出拦截。
6. **宿主能力** 恒 `degraded`（T-055 三条缺失），权限仍由宿主/具名人工处理。

## 2. 八客户端 × 四列能力矩阵（隔离合成环境实测）

测试环境：`os.tmpdir()` 合成 home/root，空 `PATH` + 空 probe-paths，仅创建目录与 marker 文件；`now` 固定 `2026-11-23T00:00:00.000Z`。

| 客户端 | MCP | 规则接管 | DAG | 恢复 | 状态 |
|---|---|---|---|---|---|
| claude-code（alias cloudcode） | unavailable | degraded | degraded | degraded | degraded |
| codex | unavailable | degraded | degraded | degraded | degraded |
| cursor | unavailable | degraded | degraded | degraded | degraded |
| opencode | unavailable | degraded | degraded | degraded | degraded |
| qoder | unavailable | unavailable | unavailable | unavailable | unavailable |
| dsh | unavailable | unavailable | unavailable | unavailable | unknown |
| pi | unavailable | unavailable | unavailable | unavailable | unknown |
| zcode | unavailable | degraded | degraded | degraded | degraded |

- MCP 全列为 `unavailable`：本合成环境没有真实 stdio 握手（`inspect` 不做握手，未传 `verify`），按 ADR-007 不得用合成 fixture 升级。
- qoder 的 `detected` 在本环境为假（未创建其公开配置候选文件），因此四列全 `unavailable`；这是环境事实，不是对该客户端的真实否定。
- dsh/pi 身份或接口不明确，`status='unknown'`，四列恒 `unavailable`，永不 `validated`。
- zcode 无专用适配器，走 registry 通用探测；`detected` 命中声明的配置路径后为 `degraded`。

### 2.1 MCP 成功不放大（实测）

在合成根写入可达的 `.mcp.json` 条目并注入真实 `initialize` / `tools/list=7` / `brief` 载荷后，`claude-code` 的 MCP 列达到 `validated`，但同一份报告的规则接管 / DAG / 恢复仍分别为 `degraded`，输出拦截仍 `unavailable`。这直接证明 MCP 成功不被放大为接管结论。

### 2.2 撒谎 adapter 不升级（实测）

注入自报全层 `validated`/`measured` 的 adapter 后，原始报告的 `orchestration`/`instructions` 确实出现 `validated`，但映射后规则接管为 `degraded`、DAG 为 `degraded`、恢复为 `degraded`、MCP 列不因扩展层谎言升级。对 dsh/pi 注入同一撒谎 adapter，`doctorClient` 仍强制 `unknown` 降级，四列 `unavailable`。

## 3. 隔离项目可用路径实测

| # | 分层 | 场景 | 关键断言 | 结果 |
|---|---|---|---|---|
| 1 | 映射 | 八客户端报告经 `doctorClients` 编排 | `schema=ano.client-takeover-capabilities/1`；八客户端顺序与 `CLIENT_IDS` 一致；每列有 verdict/limitations；`output-interception` 恒 `unavailable`；`hostCapability=degraded` | 通过 |
| 2 | 隔离 | 单客户端 `detect`/`inspect` 抛错 | 该客户端四列 `unavailable`，其余七客户端报告完整，整份报告不抛错 | 通过 |
| 3 | 防放大 | 撒谎 adapter（正常客户端 + dsh/pi） | 规则/DAG/恢复均不 `validated`；dsh/pi 保持 `unknown` | 通过 |
| 4 | 防放大 | 注入真实七工具 stdio 载荷 | MCP 列可 `validated`，规则/DAG/恢复仍 `degraded`，输出拦截 `unavailable` | 通过 |
| 5 | DAG 可用路径 | 真实 spawn `scripts/orchestration/cli.ts --plan <plan>`（cwd=隔离根） | 退出码 0；`mode=dry-run`；对 todo 任务产出 `dispatch`；不创建 `.pm/orchestration-state.json`；`.pm` 快照不变 | 通过 |
| 6 | 接管可用路径 | 隔离根 `createAuthorization` + `runTakeover(confirm, hostCapability='degraded')` | 六阶段到 `active`；`state=enforced`；`.ano/takeover/policy.json` 存在；`policy.state=enforced`、`hostCapability=degraded`；受管 `AGENTS.md` 段安装 | 通过 |
| 7 | 恢复 | 恢复列标签 + `restoreClientConfig(target, { mode:'dry-run' })` | 每客户端同时标注 `takeoverRecovery` 与 `clientConfigRestore`；dry-run 不建备份、不写目标文件 | 通过 |
| 8 | 无宿主能力 | 常量 / 文档交叉引用 | `HOST_AUTO_INTERCEPTION_AVAILABLE=false`、`HOST_AUTO_APPROVAL_AVAILABLE=false`、`HOST_AUTO_SESSION_DAEMON_AVAILABLE=false`；宿主调查报告含「未发现/输出拦截/hooks/批准」；`pm-bridge.mjs` 是显式 `spawn` stdio 桥；本报告含「不声称/自动拦截/HOST_AUTO_INTERCEPTION/degraded」 | 通过 |
| 9 | 分层明示 | UI / 跨项目未现场验证 | 本报告含 `\| UI \|`、`\| 跨项目 \|`、`未现场验证`、`host-capability-investigation.md` 交叉引用 | 通过 |

命令：`node --test test/integration/client-takeover.test.ts`

## 4. DAG / 接管 / 恢复三层证据指针

| 层 | 证据来源 | 已验证内容 | 状态 |
|---|---|---|---|
| DAG 调度器 | `scripts/orchestration/dag.ts` / `store.ts` / `cli.ts`（T-069）；本测试场景 5 | `--plan` 显式 dry-run、租约/恢复动作、零写入 | 已验证（隔离根真实 spawn） |
| DAG 会话/主控适配 | `scripts/orchestration/pm-bridge.mjs`（显式 stdio 桥）；`docs/evidence/takeover-host.md` L3 | 会话启动读取策略由显式调用驱动；主控适配不是宿主 daemon | 已验证（ANO 侧行为）；宿主自动启动未验证且不存在公开接口 |
| 项目接管 | `src/connect/takeover.ts` 六阶段；`docs/evidence/takeover-recovery.json`、`docs/evidence/takeover-host.md` | 三态/六阶段、受管段、`hostCapability=degraded`、备份回滚 | 已验证（隔离根复用 `runTakeover`） |
| 客户端配置恢复 | `src/clients/config.ts` `restoreClientConfig`（T-081） | 校验备份 manifest + `beforeHash`，dry-run 零写，需 `restore` scope 授权 | 已验证（dry-run 路径）；apply 真实恢复未在本任务执行 |
| 客户端规则接管 | 六个适配器 `instructions` 层；`src/connect/managed-instructions.ts` marker 先例 | 规则文件与受管段只读检测，上限 `degraded` | 已验证（合成 fixture）；真实客户端规则读取未验证 |

## 5. degraded / unavailable 层清单

| 层 | degraded | unavailable |
|---|---|---|
| MCP | 已安装未配置 / 已配置未实测 / 实测部分缺失（合成环境属此类） | 前置不成立或未做握手 |
| 规则接管 | 规则文件存在但未含受管段 / 仅公开假设 | 前置不成立（qoder/dsh/pi） |
| DAG | 客户端无公开派发接口 → 主控 harness / 显式工作流 | 前置不成立（qoder/dsh/pi） |
| 恢复 | 路径存在但需显式授权 + 已验证备份 | 前置不成立 |
| 输出拦截 | ——（不适用：该层无 degraded 中间态） | 全部客户端恒 `unavailable` |
| 宿主能力 | 恒 `degraded`（T-055 三条缺失） | —— |

- 扩展层为 `unavailable` 时全部进入报告 `limitations`（由 `doctorClients` 保证）。
- 任何一列都不得因其他列成功而升级；任一层成功不能代替其他层。

## 6. 不声称通用自动输出拦截声明

- 本任务与交付物**不声称通用自动输出拦截**：`output-interception` 在八客户端报告中恒为 `unavailable`，并携带 limitation（无公开接口；工具级 hooks 不是输出拦截）。
- 宿主无面向 MCP 结果 / 模型输出的拦截/适配接口（T-055）；hooks 是工具级闸门，当前未用于 ANO，即使启用也不构成回答输出适配。
- 「宿主默认启动」只能降级为受管 `AGENTS.md` 段提示 + 人工确认；不得声称宿主自动读取策略、自动启动 ANO、自动批准或自动建会话。
- CLI doctor 成功、MCP 七工具可用、`brief` 成功均不得表述为已接管 / DAG 已接管 / 历史已支持 / 输出可拦截。
- 权限批准（PermissionRequest）、发布 approve/sync/push、撤销授权、恢复旧主写、宿主 hooks 配置仍是具名人工动作。

## 7. 分层证据表（不得互相替代）

| 层 | 证据来源 | 已验证内容 | 状态 |
|---|---|---|---|
| 库/映射 | 本测试全部用例 + `src/clients/capabilities.ts` | 八客户端四列映射、失败隔离、防放大 | 已验证（隔离 tmpdir home/root） |
| 可用路径 | 本测试真实 spawn 调度器 dry-run + `runTakeover` | DAG 显式可用；M10 状态机可达 | 已验证（隔离根） |
| 会话/主控适配 | `pm-bridge.mjs` 显式 stdio 桥；显式 `brief`/`track` 调用 | 会话启动读取策略由 ANO 侧投影证明 | 已验证（ANO 侧行为）；宿主自动启动未验证 |
| UI | 无（需人工点击 Settings → MCP / Plugin Management） | —— | 未现场验证 |
| 跨项目 | 无（需在非 ANO 项目用真实客户端会话调用工具并核对独立账本） | —— | 未现场验证 |
| 输出拦截 | T-055 调查（工具面枚举 + 配置扫描 + hooks 事实） | 未发现公开接口；hooks 为工具级闸门 | 已验证（未发现公开接口）；hooks 拦截实验未验证 |

与 `docs/evidence/host-capability-investigation.md` §2、`docs/evidence/takeover-host.md` §3 同口径：任一层成功不能代替其他层；harness 成功不等于宿主自动闭环。

## 8. 复现步骤

```bash
cd "<repo>"
node --test test/integration/client-takeover.test.ts
node --test test/unit/client-doctor.test.ts test/unit/client-config.test.ts
npx tsc -p tsconfig.json --noEmit
```

约束：TypeScript strict + exactOptionalPropertyTypes；除仓库既有依赖外无新增第三方依赖；合成根使用 `os.tmpdir()`；除隔离 root 外零写。
