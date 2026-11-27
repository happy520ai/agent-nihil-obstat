# Trae / Antigravity / Replit Agent / CodeBuddy 适配器证据报告（T-094 / CX-04）

- 日期：2026-11-23
- 任务：T-094（M12 / CX-04）
- 交付：`src/clients/trae.ts`、`src/clients/antigravity.ts`、`src/clients/replit-agent.ts`、`src/clients/codebuddy.ts`、`test/unit/client-cloud-ide.test.ts`、本报告
- 性质：只读探测 + 公开文档核实 + 合成 fixture 验证。未读取真实客户端配置内容，未修改用户级配置，未执行配置内容，未新增第八个 MCP 工具。
- 上游契约：`docs/adr/ADR-008-full-client-catalog.md` §3/§4/§5/§6/§9/§10、`docs/client-catalog.md` §1/§3.1/§4、`src/clients/types.ts`（T-092）、`src/clients/registry.ts`（T-092）、`src/clients/config.ts`（T-081）、`src/clients/doctor.ts`（T-080）。
- 核实时点：2026-11-23；本机 win32 10.0.19041 x64，Node v24.14.0。

## 1. 结论

1. 四个适配器均实现 `ClientAdapter` 四接口（`detect`/`inspect`/`config`/`verify`）。配置写路径全部委托 `src/clients/config.ts`（T-081），真实 stdio 验证委托 `src/clients/doctor.ts` 的 `verifyStdioMcp`（T-080，可注入）。适配器自身不写文件、不执行配置内容、不 spawn 配置内容中的命令。
2. Trae 与 Antigravity 的公开 MCP 配置格式由官方文档实测确认（E1）：Trae 项目级 `.trae/mcp.json`（`mcpServers`）；Antigravity `~/.gemini/config/mcp_config.json` 与 `<workspace>/.agents/mcp_config.json`（`mcpServers`）。二者可生成合法 dry-run 预览，并在显式授权下 apply（测试断言保留其他服务与未知字段）。
3. Replit Agent 官方文档只描述云端 Web/Project Editor 工作流，未发现本地 MCP 配置、本地 CLI 或公开 agent HTTP API。适配器显式 `cloud-only`：`detect=false`、核心五层与 instructions/history/output-interception 全 `unavailable`、`orchestration=degraded`+`explicit-workflow`，`config` 任何模式都零写且不生成本地配置。
4. Antigravity 的浏览器/代理自动化能力与 MCP 支持是**两个独立文档面**。适配器明文声明「browser automation is not MCP support and MCP support does not imply browser automation」，身份来源中不含任何 browser 路径，测试做否定断言。
5. CodeBuddy 的 CLI 由 npm registry 确认（`@tencent-ai/codebuddy-code` v2.185.0，bin `codebuddy`）；MCP 配置路径与规则路径来自 ADR-008 §3 声明候选，官方文档页本次抓取仅返回标题，故标 `unverified`。`cbc` 只作为 CLI 命令别名探测，不是 `ClientId` 别名（`resolveClientId('cbc')===null`）。
6. 全适配不等于全部 `validated`：四工具初始客户端级证据标签均为 `unverified`；`inspect` 不做握手，`configured` 上限 `degraded`；`mcp/tools/brief` 仅在 `verify` 实测；无公开接口者显式降级。默认 dry-run 零写、缺授权零写、失败隔离均有确定性测试。

## 2. 逐工具公开来源与证据分级（E0~E4）

| 工具 | 公开来源（2026-11-23 抓取） | 等级 | 能证明 | 不能证明 |
|---|---|---|---|---|
| Trae | `https://docs.trae.cn/ide_add-mcp-servers`；`https://docs.trae.cn/ide_model-context-protocol`；`https://www.trae.ai/`；`https://work.trae.ai` | E1（接口文档实测抓取）+ E0（产品页） | 项目级 MCP 配置文件 `.trae/mcp.json`；容器 `mcpServers`；stdio `command`/`args`/`env`；HTTP `url`/`headers`；`${workspaceFolder}` 替换；全局设置中存在 `mcp.json` _raw config_ 入口 | 本机已安装/已配置；全局 `mcp.json` 的目录；规则文件路径；云端 Web 能力等同于本地接管 |
| Google Antigravity | `https://antigravity.google/docs/mcp/`；`https://antigravity.google/docs/plugins/`；`https://antigravity.google/docs/getting-started?tab=cli`；`https://antigravity.google/docs/sdk/mcp` | E1（官方文档实测抓取） | 全局 `~/.gemini/config/mcp_config.json`、工作区 `<workspace>/.agents/mcp_config.json`，容器 `mcpServers`；stdio `command`/`args`/`env`/`cwd`；远程 Streamable HTTP `serverUrl`/`url`（`httpUrl`/SSE 不支持）；插件目录 `.agents/plugins/`、`~/.gemini/config/plugins/`、`<plugin-root>/mcp_config.json`；CLI `agy`（v1.2+，`agy --version`，`-p` 非交互）；Python SDK `google.antigravity` `LocalAgentConfig(mcp_servers=[McpStdioServer...])`，仓库 `google-antigravity/antigravity-sdk-python` | 本机已安装/已配置；浏览器自动化 = MCP；SDK 是公开 dispatch API；ANTIGRAVITY 客户端自动派发 |
| Replit Agent | `https://docs.replit.com/replitai/agent`；`https://replit.com/site/agent` | E1（官方文档实测抓取，仅证明云端形态） | 云端 Web/Project Editor chat 工作流；构建/部署在 Replit 托管环境；通过 Web UI 使用 Agent | 本地 MCP 配置；本地 CLI；公开 agent HTTP API；任何本地接管 |
| CodeBuddy | `https://registry.npmjs.org/@tencent-ai/codebuddy-code`（实测）；`https://www.codebuddy.cn/ide/docs`、`https://www.codebuddy.ai/docs/mcp`（实测抓取仅返回标题）；ADR-008 §3 / `docs/client-catalog.md` §1 声明候选 | E1（npm registry 实测：bin `codebuddy`、包 `@tencent-ai/codebuddy-code` v2.185.0、homepage `https://cnb.cool/codebuddy/codebuddy-code`）；MCP/规则候选为 ADR 声明（未独立实测，标 `unverified`） | CLI 命令 `codebuddy` 存在；包名与版本 | MCP 容器/路径的官方确认；规则文件官方确认；`cbc` 别名官方确认；本机已安装/已配置 |

补充口径：

- Trae 全局 MCP 配置只公开了文件名 `mcp.json`，未公开目录；适配器**不声明**该用户级路径，`user` 作用域一律拒绝并零写（见 §3）。
- Antigravity 文档对 stdio `args` 的描述为「array of arrays」，与 SDK 示例的 `string[]` 写法存在文档内部不一致；适配器写入标准 `string[]`，并在证据层标注该不一致，不升级为实测。
- CodeBuddy 官方文档页本次不可解析（仅标题），因此 ADR-008 §3 的 `~/.codebuddy/.mcp.json`、`~/.codebuddy/mcp.json`、项目 `.mcp.json`、`mcpServers`、`CODEBUDDY.md`、`rules/` 均按「声明候选 + unverified」处理；CLI bin `codebuddy` 与包元数据为实测 E1。

## 3. 本机事实（仅存在性，未读内容）

执行环境：win32 10.0.19041，Node v24.14.0，工作目录 `<repo>`。

| 探测 | 结果 |
|---|---|
| `command -v trae` | not found |
| `command -v agy` | not found |
| `command -v codebuddy` | not found |
| `command -v cbc` | not found |
| `~/.gemini` | missing |
| `~/.trae` | missing |
| `~/.codebuddy` | EXISTS（未读内容） |
| `~/.agents` | EXISTS（未读内容；非本任务声明的 Antigravity 工作区路径，不作产品证据） |

结论：本机无可实测的 Trae/Antigravity/Replit Agent 安装；`~/.codebuddy` 目录存在但内容未读、未解析。因此真实客户端握手与真实配置读取均未发生，能力层不升级为 `measured/validated`。合成 fixture 只证明机制。

## 4. 接口清单与配置映射（写入条目为数据，不执行）

| 工具 | 声明身份来源 | 配置候选（scope/format/key） | 写入条目 |
|---|---|---|---|
| Trae | `.trae/mcp.json`（config-path，E1） | `<root>/.trae/mcp.json`（project/json/`mcpServers.ano`） | `{ "command": "node", "args": ["<package-root>/dist/surface/mcp.js"] }` |
| Antigravity | `agy`（executable，E1）；`~/.gemini/config/mcp_config.json`；`<root>/.agents/mcp_config.json`；`.agents/plugins`；`~/.gemini/config/plugins`（config-path，E1） | `~/.gemini/config/mcp_config.json`（user/json/`mcpServers.ano`）；`<root>/.agents/mcp_config.json`（project/json/`mcpServers.ano`） | 同上 |
| Replit Agent | 无（cloud-only，不声明本地来源） | 无（不生成任何本地配置） | 无 |
| CodeBuddy | `codebuddy`（executable，E1）；`cbc`（executable，命令别名，待核实）；`~/.codebuddy/.mcp.json`；`~/.codebuddy/mcp.json`（config-path，待核实） | `~/.codebuddy/.mcp.json` 或 `~/.codebuddy/mcp.json`（user/json/`mcpServers.ano`）；`<root>/.mcp.json`（project/json/`mcpServers.ano`） | 同上 |

- `<package-root>` 由 `import.meta.url` 上推两级得到，条目来源为 `package.json` 的 `mcp` 字段。
- `serverName='ano'`，`serverPath=['mcpServers']`；MCP 工具数量恒为 7（`brief/explore/recall/track/note/verify/audit`），未新增第八工具。
- 所有 apply 均委托 `config.ts`：备份 + hash 绑定 + 原子写 + 失败恢复 + 保留其他服务与未知字段；默认 `dry-run`。

## 5. 能力分层与降级矩阵

| 层 | Trae | Antigravity | Replit Agent | CodeBuddy |
|---|---|---|---|---|
| detected | 有 `.trae/mcp.json` → `degraded`（E2，无版本）；无 → `unavailable` | 有 `agy`/配置/插件目录 → `degraded`；无 → `unavailable` | 恒 `unavailable`（无本地来源，不探测 Web 登录） | 有 `codebuddy`/`cbc`/配置 → `degraded`；无 → `unavailable` |
| configured | 有候选 → `degraded`（`evidence='configured'`，未握手）；无候选/未安装 → `unavailable`/`degraded` | 同左（user 或 workspace） | `unavailable`（不生成配置） | 同左（user 优先复用已存在文件） |
| mcp / tools / brief | `inspect` 中 `unavailable`；`verify` 实测 | 同左 | `unavailable`；`verify` 仅注入机制，不改变报告 | 同左 |
| instructions | `degraded`（无公开规则文件；自定义 agent/skill 不算规则接管） | `degraded`（无公开规则文件；插件是 MCP 载体） | `unavailable` | `degraded`（`CODEBUDDY.md`/`rules/` 声明候选，unverified；检测受管段 marker） |
| orchestration | `degraded`，`mode='explicit-workflow'`；云端 Web 不等于本地派发 | `degraded`，`mode='explicit-workflow'`；**浏览器/代理自动化 ≠ MCP**；SDK 不是公开 dispatch API | `degraded`，`mode='explicit-workflow'`；显式 Web 工作流 | `degraded`，`mode='explicit-workflow'` |
| history | `unavailable` | `unavailable` | `unavailable` | `unavailable` |
| output-interception | `unavailable`（工具级 hooks 不算） | 同左 | 同左 | 同左 |

绝不 `validated` 的情形：Replit 全层；无公开接口；仅产品宣传；仅本机存在性；仅合成 fixture；`inspect` 未握手。

## 6. 测试与验证结果

| 命令 | 结果 |
|---|---|
| `node --test test/unit/client-cloud-ide.test.ts` | 26 tests，26 pass，0 fail |
| `node --test test/unit/client-doctor.test.ts` | 19 tests，19 pass，0 fail |
| `npx tsc -p tsconfig.json --noEmit` | T-094 文件 0 error；残余 1 error 来自并行任务 T-097 的 `src/clients/deepseek-harness.ts`（见 §7） |

测试覆盖：

- 身份/接口：四 id 稳定、七工具面、`identitySources` 声明、registry 可寻址、`cbc` 非 `ClientId` 别名。
- 只读探测：空 root `detected=false`；只探测声明来源（Trae 不探测未声明的 `trae` 可执行）；Antigravity 探测 `agy`/配置/插件目录且不含 browser 路径。
- 九层报告形状与四要素（时间/来源/限制/版本）。
- Trae：项目配置发现、configured 降级、user 作用域拒绝、dry-run 零写、apply 合并保留其他服务与未知字段、缺授权零写。
- Antigravity：workspace/user 配置、dry-run/apply、真实 stdio 握手（7 工具/6 工具/退出码）与注入握手、握手失败不放大；`ANTIGRAVITY_AUTOMATION_NOTE` 进入 orchestration 限制。
- Replit：全层不 `validated`、coreVerdict `unavailable`、config 任何模式零写且不生成 `.mcp.json`、注入 verify 通过也不污染报告。
- CodeBuddy：`codebuddy`/`cbc` 探测、规则文件与受管段检测、user/project dry-run/apply、缺授权零写。
- 跨适配器：空注入 root 上 detect/inspect/dry-run 零文件；握手失败隔离。

## 7. 未实测层与移交项

1. **无真实客户端安装/握手**：四工具均无本机安装（`~/.codebuddy` 仅目录存在，未读）。`detected/configured` 的 `measured` 升级、`mcp/tools/brief` 的真实兼容、规则是否被宿主读取，均需授权本机实测。
2. **registry 与适配器候选口径**：`registry.ts` 由 T-092 拥有且本任务只读。Trae 在 registry 中 `identitySources`/`configCandidates` 为空，Antigravity/CodeBuddy 的 registry 候选是适配器声明来源的子集；`doctorClient` 的配置发现走 registry 候选，适配器 `inspect` 走自身候选。建议 T-102 收口时对齐候选来源（Trae 项目候选、Antigravity 插件目录、CodeBuddy 用户双候选）。
3. **未接入 surface 装配**：`src/surface/service.ts` 的 `createClientAdapters` 未注册本组适配器（该文件不在 T-094 文件边界）。需由 T-098/T-102 或主控在收口时加入四个 adapter；否则 `ano doctor clients` 仍走 generic 探测。
4. **Trae 全局路径缺口**：官方仅公开文件名 `mcp.json`，目录未公开。当前 user 作用域拒绝零写；拿到官方目录后应补声明候选。
5. **CodeBuddy 公开文档未解析**：官方 docs 页本次仅返回标题，MCP 容器/路径与规则文件仍是 ADR 声明候选。需要能访问官方文档的环境复核，再决定是否升级证据等级。
6. **Antigravity `args` 文档不一致**：MCP 页写「array of arrays」，SDK 示例为 `string[]`。当前写入 `string[]`；真实配置实测前不升级为 `measured`。
7. **Replit 云端 API 未核实**：公开文档无 agent HTTP API。若后续发现公开 API，应作为独立 E1 证据补充，但仍不得表述为本地接管。
8. **并行任务在途错误**：T-094 进行期间 `npx tsc --noEmit` 仅有 `src/clients/deepseek-harness.ts` 的 1 个错误（T-097 在途），本任务文件全程 0 error；`test/unit/client-deepseek-harness.test.ts` 的错误已在检查过程中消失。未修改上述文件。
9. **授权形状沿用 T-083 结论**：`types.ClientAuthorizationRef` 无 `statement`，`config.ts` 要求非空 `statement`；适配器在缺失时拒绝 apply（零写），不伪造授权语句。
