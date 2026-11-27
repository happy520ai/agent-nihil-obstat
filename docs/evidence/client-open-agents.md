# Cline / Kilo Code / OpenClaw / Hermes Agent 适配器证据报告（T-095 / CX-05）

- 日期：2026-11-23
- 任务：T-095（M12 / CX-05，开源 Agent/IDE 组）
- 交付：`src/clients/cline.ts`、`src/clients/kilo-code.ts`、`src/clients/openclaw.ts`、`src/clients/hermes-agent.ts`、`test/unit/client-open-agents.test.ts`、本报告
- 性质：只读探测 + 合成 fixture 验证。未读取真实客户端配置内容，未修改用户级配置，未执行配置内容，未新增第八个 MCP 工具。
- 上游契约：`docs/adr/ADR-008-full-client-catalog.md` §3/§4/§5/§6/§10、`docs/client-catalog.md` §1、`src/clients/types.ts`（T-092）、`src/clients/registry.ts`（T-092）、`src/clients/doctor.ts`（T-080）、`src/clients/config.ts`（T-081）。
- 核实时点：2026-11-23；本机 win32 10.0.19041 x64，Node v24.14.0。

## 1. 结论

1. 四个适配器均实现 `ClientAdapter` 四接口（`detect`/`inspect`/`config`/`verify`），`identitySources` 与 T-092 registry 描述符逐字一致；配置写路径全部委托 `src/clients/config.ts`（T-081），真实 stdio 验证委托 `src/clients/doctor.ts` 的 `verifyStdioMcp`（T-080）。适配器自身不写文件、不执行配置内容。
2. 四个工具均有 E1 公开接口证据（官方文档/官方仓库），支持声明配置候选与合法条目形状：Cline `mcpServers.ano`、Kilo Code `mcp.ano`、OpenClaw `mcp.servers.ano`。Hermes Agent 的公开配置载体是 YAML（`~/.hermes/config.yaml` 的 `mcp_servers`），而 T-092 的 `configCandidates.format` 仅 `json|toml`，故**不声明 YAML candidate、不读不写 YAML**，只导出惰性条目数据，标「待核实」。
3. 接管与子任务能力分层：四个工具均无公开 DAG 派发接口，`orchestration` 一律 `degraded` + `mode:'explicit-workflow'` + `measured:false`；`instructions` 只读检测规则/上下文文件；`history` 与 `output-interception` 全层 `unavailable`。任何层都不因握手成功而放大。
4. 本机（2026-11-23）仅 OpenClaw 有可执行（`openclaw.cmd`）且 `~/.openclaw/openclaw.json` 存在（E2 存在性，未读内容）；Cline / Kilo Code / Hermes Agent 未安装。故全部能力层初始 `unverified`，未升级为 `measured/validated`。
5. 默认零写、缺授权零写、失败隔离、命令/API 不执行配置内容均有确定性测试断言（28/28 通过）。

## 2. 逐工具公开来源与 E0~E4 分级

E 级定义沿用 ADR-008 §6：E0 产品宣传；E1 公开文档/官方仓库；E2 本机存在性；E3 本机命令实测；E4 真实 stdio 握手+七工具+brief；合成 fixture 单列。

### 2.1 Cline（`cline`，IDE 插件 + CLI）

| 项 | 级别 | 来源（2026-11-23 核实时点） | 能证明 | 不能证明 |
|---|---|---|---|---|
| 产品身份/形态 | E0 | https://cline.bot/ | 真实产品与 IDE/CLI 形态 | 任何接口 |
| MCP 配置路径与键 | E1 | https://docs.cline.bot/mcp/mcp-overview | `~/.cline/data/settings/cline_mcp_settings.json` 的 `mcpServers`；`CLINE_MCP_SETTINGS_PATH` 可覆写 | 本机已安装/已配置 |
| MCP stdio 条目形状 | E1 | 同上 | `{ command, args, env, disabled, autoApprove }` | 真实客户端已加载 |
| MCP remote 条目形状 | E1 | 同上 | `{ type:"streamableHttp", url, headers, ... }` | 同上 |
| 规则文件 | E1 | https://docs.cline.bot/features/memory-bank | `.clinerules/*.md`（示例 `.clinerules/memory-bank.md`）、memory-bank 目录 | 规则已被读取/生效 |
| 子任务/编排接口 | — | 官方 MCP 与 memory-bank 文档均未记载 | 无 | 无公开 DAG 接口 |

写入条目（数据，非执行）：`{ command: process.execPath, args: ["<package-root>/dist/surface/mcp.js"] }`，`serverPath=['mcpServers']`，`serverName='ano'`。

### 2.2 Kilo Code（`kilo-code`，IDE 插件 + CLI）

| 项 | 级别 | 来源 | 能证明 | 不能证明 |
|---|---|---|---|---|
| 产品身份/形态 | E0 | https://kilo.ai/ | 真实产品与 IDE/CLI 形态 | 任何接口 |
| MCP 配置路径与键 | E1 | https://kilo.ai/docs/automate/mcp/using-in-kilo-code | 全局 `~/.config/kilo/kilo.jsonc`；项目 `kilo.jsonc` 或 `.kilo/kilo.jsonc`；键 `mcp`；项目优先 | 本机已安装/已配置 |
| MCP local 条目形状 | E1 | 同上 | `{ type:"local", command:[exe,...], environment:{...}, enabled, timeout }` | 真实客户端已加载 |
| MCP remote 条目形状 | E1 | 同上 | `{ type:"remote", url, headers, enabled, timeout }` | 同上 |
| 规则文件 | E1 | https://kilo.ai/docs/customize/custom-rules | `.kilo/rules/*.md`；向后兼容 `.kilocode/rules/`；经 `kilo.jsonc` 的 `instructions` 数组引用 | 规则已被读取/生效 |
| CLI 可执行 | E1 | https://github.com/Kilo-Org/kilocode | `npm i -g @kilocode/cli`，命令 `kilo` | 本机已安装 |
| 编排接口 | E1（反向） | https://kilo.ai/docs/code-with-ai | 「Orchestrator Mode」为旧功能、已内置到所有 agent；无公开 DAG 派发 API | 自动派发 |

写入条目（数据，非执行）：`{ type:"local", command:[process.execPath,"<package-root>/dist/surface/mcp.js"], enabled:true }`，`serverPath=['mcp']`，`serverName='ano'`。

### 2.3 OpenClaw（`openclaw`，自托管代理框架 / CLI / 桌面 App）

| 项 | 级别 | 来源 | 能证明 | 不能证明 |
|---|---|---|---|---|
| 产品身份/形态 | E0 | https://openclaw.ai/ | 真实产品与框架/CLI/桌面形态 | 任何接口 |
| 配置路径与 MCP 键 | E1 | https://docs.openclaw.ai/tools/mcp | `mcp.servers.<name>`（OpenClaw config，如 `openclaw.json`）；`openclaw mcp add|list|show|set|unset|doctor|probe` | 本机已配置 |
| MCP stdio 条目形状 | E1 | 同上 | `{ command, args, cwd, env, transport:"stdio", enabled }` | 真实网关已加载 |
| MCP HTTP 条目形状 | E1 | 同上 | `{ url, transport:"streamable-http"|"sse", headers, ... }` | 同上 |
| `openclaw mcp serve` 语义 | E1 | https://docs.openclaw.ai/cli/mcp | OpenClaw **作为 MCP server** 暴露自身；client-side registry 才是消费外部 server 的载体 | 与 ANO 接入同一方向 |
| skills/plugins | E1 | https://docs.openclaw.ai/tools | `openclaw skills`、`openclaw plugins`；来源 ClawHub/npm/git/本地 | 具体规则文件路径未公开 |
| 多 agent 编排 | E1（反向） | https://docs.openclaw.ai/concepts/multi-agent | `sessions/agents/swarm/subagents` 为 CLI 机制，非公开 DAG 派发 API | 自动派发 |

写入条目（数据，非执行）：`{ transport:"stdio", command:process.execPath, args:["<package-root>/dist/surface/mcp.js"], env:{}, enabled:true }`，`serverPath=['mcp','servers']`，`serverName='ano'`。

### 2.4 Hermes Agent（`hermes-agent`，CLI + 桌面 App + 云端 Portal）

| 项 | 级别 | 来源 | 能证明 | 不能证明 |
|---|---|---|---|---|
| 产品身份/形态 | E0 | https://hermes-agent.nousresearch.com/ | 真实产品与 CLI/桌面/云端形态 | 任何接口 |
| MCP 配置路径与键 | E1 | https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp | `~/.hermes/config.yaml` 的 `mcp_servers`；stdio `{command,args,env,cwd}`；HTTP `{url,headers}` | 本机已配置；YAML 读写 |
| 上下文/规则文件 | E1 | https://hermes-agent.nousresearch.com/docs/user-guide/features/context-files | 优先级 `.hermes.md`→`AGENTS.override.md`→`AGENTS.md`→`CLAUDE.md`→`.cursorrules`；`.cursor/rules/*.mdc`；`SOUL.md` 仅从 `HERMES_HOME`（`~/.hermes/SOUL.md`）加载 | 规则已被读取/生效 |
| CLI 与子 agent | E1（反向） | https://github.com/NousResearch/hermes-agent | `hermes` CLI、`hermes config get/set`、spawn isolated subagents、Python RPC 工具访问 | 公开 DAG 派发 API |
| 配置格式 | E1（反向） | 同 MCP 文档 | 载体为 YAML | v1 客户端写路径（json/toml）可写 |

写入条目（数据，非执行，**本适配器不写**）：`{ command: process.execPath, args:["<package-root>/dist/surface/mcp.js"], env:{} }`，`serverPath=['mcp_servers']`，`serverName='ano'`。

## 3. 本机真实存在性探测（E2，未读配置内容）

执行环境：win32 10.0.19041，Node v24.14.0，Git Bash，`HOME=/c/Users/project owner`（即 `<home>`）。仅做可执行名/目录/文件存在性核对。

| 探测 | 结果 |
|---|---|
| `cline` 可执行 | not found |
| `~/.cline/`、`~/.cline/data/settings/cline_mcp_settings.json` | missing |
| `kilo` 可执行 | not found |
| `~/.config/kilo/`、`~/.config/kilo/kilo.jsonc` | missing |
| `hermes` 可执行 | not found |
| `~/.hermes/`、`~/.hermes/config.yaml`、`~/.hermes/SOUL.md` | missing |
| `openclaw` 可执行 | 存在（Git Bash alias 指向 `D:\DevTools\Installs\node_global\openclaw.cmd`，文件存在） |
| `~/.openclaw/openclaw.json` | exists（未读内容） |
| `~/.openclaw/` 目录项 | `agents/ canvas/ completions/ config.yaml credentials/ cron/ delivery-queue/ devices/ extensions/ identity/ logs/ plugins/ skills/ state/` 等（未读内容） |
| `~/.openclaw-autoclaw/` | exists（另一发行版目录，未读内容） |

结论：本机无任何 Cline / Kilo Code / Hermes Agent 安装；OpenClaw 有可执行与用户目录，但本任务未读取其配置内容、未运行其 CLI、未做真实握手。因此四个工具的真实 `configured/mcp/tools/brief` 均未实测，合成 fixture 只证明机制。

## 4. 配置 / 规则 / MCP 降级清单

初始客户端级证据标签：四工具均 `unverified`（身份 `declared`，能力层未实测）。

| 工具 | 配置候选（适配器声明） | 规则/上下文 | MCP 层 | orchestration | history | output-interception |
|---|---|---|---|---|---|---|
| Cline | 用户 `~/.cline/data/settings/cline_mcp_settings.json`（`mcpServers.ano`）；`CLINE_MCP_SETTINGS_PATH` 覆写 | `.clinerules/`、`.cline/rules/`（只读检测） | E1 声明；未实测 → `unavailable`（inspect）/ 由 verify 实测 | `degraded`+`explicit-workflow` | `unavailable` | `unavailable` |
| Kilo Code | 全局 `~/.config/kilo/kilo.jsonc`；项目 `kilo.jsonc` 或 `.kilo/kilo.jsonc`（`mcp.ano`） | `.kilo/rules/`、`.kilocode/rules/`、`instructions` 引用（只读检测） | E1 声明；未实测 → 同上 | `degraded`+`explicit-workflow` | `unavailable` | `unavailable` |
| OpenClaw | 用户 `~/.openclaw/openclaw.json`（`mcp.servers.ano`） | 无公开规则文件路径；skills/plugins 未映射为规则路径 → `evidence:'absent'` | E1 声明（T-091「待核实」由 E1 取代）；未实测 → 同上 | `degraded`+`explicit-workflow` | `unavailable` | `unavailable` |
| Hermes Agent | **不声明 YAML candidate**；不读不写 `~/.hermes/config.yaml` | `.hermes.md`/`AGENTS.override.md`/`AGENTS.md`/`CLAUDE.md`/`.cursorrules`/`.cursor/rules/*.mdc`；`~/.hermes/SOUL.md`（只读检测） | E1 声明 YAML 形状；v1 写路径不支持 → `degraded`/`evidence:'absent'` | `degraded`+`explicit-workflow` | `unavailable` | `unavailable` |

补充降级：

- Kilo Code 的 `.jsonc` 允许注释/尾逗号。适配器发现层做容错只读解析；但 T-081 写路径是严格 JSON，故带注释的 JSONC 在 `apply` 时计划失败并返回 dry-run 零写（测试断言），不擅自重写用户注释。
- Hermes Agent 桌面/云端能力一律不表述为本地接管；`output-interception` 明示桌面/云端不是本地输出拦截。
- 四个工具均未提供公开 DAG 接口，故 `orchestration` 绝不 `validated`，`coreVerdict` 在 `inspect` 中恒非 `validated`。

## 5. 文档声明 ≠ 实测的分层标注

| 层 | 内容 | 标注 |
|---|---|---|
| 公开文档核实（E1） | 配置路径、键、条目形状、规则文件路径、CLI 命令、MCP 客户端注册键 | 支持 `assumed`/`configured` 候选；**不得**升级为 `measured` |
| 本机存在性（E2） | OpenClaw 可执行与 `openclaw.json` 存在 | `detected` 最高 `degraded`（无版本）；**不得**报「已支持」 |
| 合成 fixture | 临时 root/home + 注入式 MCP client | `synthetic:true` 语义；只证明机制，不证明真实客户端兼容 |
| 真实实测（E4） | 真实 stdio 握手 + 七工具 + brief | 本任务**未执行**（OpenClaw 未握手；其余未安装） |
| YAML 配置 | Hermes `config.yaml` | **待核实**；不声明 candidate、不读不写 |

报告固定包含不可放大声明：握手成功不得表述为已配置/已接管；MCP 七工具可用不得表述为 DAG 已接管/历史已支持/输出可拦截；`unverified` 客户端不得表述为已支持。

## 6. 测试与回归结果

| 命令 | 结果 |
|---|---|
| `node --test test/unit/client-open-agents.test.ts` | 28 tests，28 pass，0 fail |
| `node --test test/unit/client-doctor.test.ts` | 19 tests，19 pass，0 fail |
| `npx tsc -p tsconfig.json --noEmit` | 0 error（最终检查时无并行任务在途错误） |

新增测试覆盖：registry 身份/来源/形态/初始 `unverified`；四适配器 `identitySources` 与 registry 一致与 server 映射；detect 只读、env 覆写、不猜路径；九层报告形状与 `unavailable` 降级；Cline `mcpServers.ano` 与 `.clinerules` 受管段检测；Kilo `mcp.ano` 与 `.kilo/rules`/`instructions`；OpenClaw `mcp.servers.ano` 与规则/编排显式降级；Hermes YAML 拒绝与上下文文件检测；三工具合法配置生成与授权门控；默认零写；缺授权零写；幂等重放；恶意命令注入不执行；源码静态扫描（无 `child_process`/`spawn`/`exec`/`eval`/`new Function`/动态 `import`）；失败隔离；abort 隔离；verify 委托与握手失败不放大。

## 7. 未实测层与移交项

1. **OpenClaw 本机实测**：可执行与 `openclaw.json` 存在，但未读内容、未运行 `openclaw mcp doctor/probe`、未做真实握手。建议后续在用户授权下执行只读实测，核实 `mcp.servers` 键与 stdio 条目是否被网关加载。
2. **Kilo Code JSONC 写路径**：T-081 仅支持严格 JSON。带注释的 `.jsonc` 会被只读发现但 `apply` 零写。如需支持，应由 T-081 统一扩展 JSONC 合并（保留注释）或明确由调用方预处理。
3. **Hermes Agent YAML**：需扩展 `config.ts` 的 `ClientConfigFormat`（新增 yaml）与对应解析/写回，或由 CLI 层提供 YAML writer；在此之前保持「待核实 + 零写」。
4. **Cline CLI 可执行**：ADR-008 §3 将 Cline 记为「IDE 插件 + CLI」，但 T-092 registry 的 `cline` 身份来源仅声明 config-path 与环境变量，未声明 CLI 可执行。适配器遵循「不使用未声明来源」，故未探测 `cline` 可执行。建议 T-102 收口时决定是否补声明。
5. **规则写入不在范围**：`instructions` 只报告文件存在与受管段 marker；写规则需显式授权，沿用 `src/connect/managed-instructions.ts` 的 marker 先例。
6. **并行任务边界**：本任务最终检查时 `tsc` 为 0 error；若并行任务（T-093/T-094/T-096/T-097 及在途测试修复）后续引入错误，按其文件归属处理，本任务不修改其文件。
