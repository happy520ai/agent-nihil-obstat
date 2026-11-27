# GitHub Copilot / Zed / JetBrains AI / Tabnine 适配器证据报告（T-093 / CX-03）

- 日期：2026-11-23
- 任务：T-093（M12 / CX-03）
- 交付：`src/clients/github-copilot.ts`、`src/clients/zed.ts`、`src/clients/jetbrains-ai.ts`、`src/clients/tabnine.ts`、`test/unit/client-ide-coding.test.ts`、本报告
- 性质：只读探测 + 合成 fixture 验证。未读取真实客户端配置内容，未修改用户级配置，未执行配置内容，未新增第八个 MCP 工具。
- 上游契约：`docs/adr/ADR-008-full-client-catalog.md` §3/§5/§6/§10、`docs/client-catalog.md` §1/§3、`src/clients/types.ts`（T-092）、`src/clients/registry.ts`（T-092）、`src/clients/config.ts`（T-081）、`src/clients/doctor.ts`（T-080）。
- 核实时点：2026-11-23；本机环境 win32 10.0.19041 x64，Node v24.14.0。

## 1. 结论

1. 四个适配器均实现 `ClientAdapter` 四接口（`detect`/`inspect`/`config`/`verify`），`identitySources` 与 T-092 registry 描述符逐字一致；配置写路径全部委托 `src/clients/config.ts`（T-081），真实 stdio 验证委托 `doctor.verifyStdioMcp`（T-080）。适配器自身不写文件、不执行配置内容。
2. GitHub Copilot 与 Zed 有 E1 公开接口依据，可生成合法 MCP 配置：Copilot 用户级 `~/.copilot/mcp-config.json` 与工作区级 `.mcp.json` 均为顶层 `mcpServers`（官方文档实测抓取）；Zed 为 `context_servers` 容器，本地项 `{command, args, env}`（官方文档实测抓取）。两者在 `inspect` 中最高只判 `degraded`，真实握手须由 `verify()` 完成。
3. JetBrains AI 与 Tabnine 为 IDE 插件（Tabnine 另含云端 Agent），无公开 MCP/本地配置接口（E1 官方文档仅证明插件/产品形态）。适配器 `detect` 判 `unavailable`，`config` 恒 dry-run 零写（即使 `mode:'apply'`），绝不生成无效 MCP 配置。
4. 不支持层已显式降级：`orchestration` 为 `degraded` + `mode='explicit-workflow'`（仅手动回退，不宣称自动 DAG）；`history` 与 `output-interception` 全层 `unavailable`；IDE-only 两工具 `configured/mcp/tools/brief/instructions` 全层 `unavailable`。代码补全/聊天/云端 Agent 能力一律不表述为 ANO Agent 接管。
5. 默认零写、缺授权零写、已有配置保留、未知字段保留、路径逃逸拒绝、握手失败不放大、空 root 零文件均有确定性测试断言；合成 fixture 全部标注 `synthetic:true`，不证明真实客户端兼容。

## 2. 逐工具公开接口来源（E0/E1/E2/E3/E4 分层）

| 工具 | 依据等级 | 公开来源（2026-11-23 抓取/引用） | 能证明 | 不能证明 |
|---|---|---|---|---|
| GitHub Copilot | E1 | `https://code.visualstudio.com/docs/agents/reference/mcp-configuration`（实测抓取）：native Copilot 用户配置 `$COPILOT_HOME/mcp-config.json`（默认 `~/.copilot/mcp-config.json`）、工作区 `.mcp.json`，两者顶层键 `mcpServers`；`.vscode/mcp.json` 为已弃用的 editor-managed 格式（顶层键 `servers`） | 用户/工作区配置路径与容器键 | 本机已安装/已配置 |
| GitHub Copilot | E1 | `https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/overview`（实测抓取）：MCP 配置默认位于 `~/.copilot` 的 `mcp-config.json`，可用 `COPILOT_HOME` 覆写；`copilot mcp add` | 配置目录、CLI 子命令 | JSON 结构（该页未展开） |
| GitHub Copilot | E1 | `https://docs.github.com/en/copilot/customizing-copilot/adding-repository-custom-instructions-for-github-copilot`（实测抓取）：仓库级 `.github/copilot-instructions.md`、路径级 `.github/instructions/NAME.instructions.md` | 规则文件路径 | 本机存在 |
| GitHub Copilot | E1（引用） | ADR-008 §3 列出的 `~/.copilot/copilot-instructions.md`、`~/.copilot/instructions/*.instructions.md`（本次未独立抓取该用户级路径） | 用户级规则候选 | 用户级路径实测 |
| GitHub Copilot | E0/E1 | `https://docs.github.com/en/copilot/concepts/copilot-surfaces/copilot-cli`（实测抓取）：仅证明产品身份/定位（IDE 插件 + CLI + 云端 agent），未给配置路径 | 产品形态 | 任何接口/格式 |
| Zed | E1 | `https://zed.dev/docs/ai/mcp`（实测抓取）：顶层键 `context_servers`；本地项 `{ "command": "...", "args": [...], "env": {} }`；设置经 `zed: open settings file` 打开 | 容器键与本地项结构 | settings 文件绝对路径 |
| Zed | E1（引用） | ADR-008 §3 的 settings 路径候选 `~/.config/zed/settings.json` / `%APPDATA%\Zed\settings.json` / `~/Library/Application Support/Zed/settings.json`（官方页未明示路径，标待核实） | 候选路径 | 路径事实 |
| JetBrains AI | E1 | `https://www.jetbrains.com/help/ai-assistant/`（实测抓取）：“AI Assistant is a collection of AI-powered features and coding agents integrated into JetBrains IDEs”，以插件安装；全页无 MCP、无指令文件、无 CLI 派发 | 产品形态为 IDE 插件 | 任何本地接口 |
| Tabnine | E1 | `https://docs.tabnine.com/`、`https://docs.tabnine.com/getting-started/tabnine-agent`（实测抓取）：文档未提 MCP、未提本地配置文件；Agent 概念上经 CLI 或 IDE 使用，但无技术集成细节 | 产品形态为 IDE 插件 + 云端 Agent | 任何本地接口/配置格式 |

- E0 宣传页/产品首页只用于身份核实，未作为接口证据。
- 本机存在性（E2）见 §3；本机命令实测（E3）与真实 stdio 握手（E4）在本机均无对象，见 §7。

## 3. 本机真实探测结果（留证）

执行环境：win32 10.0.19041，Node v24.14.0，工作目录 `<repo>`。仅做可执行名/路径存在性探测，未读取任何真实客户端配置内容。

| 探测 | 命令 | 结果 |
|---|---|---|
| Copilot CLI | `command -v copilot` | 未找到（not found） |
| Zed CLI | `command -v zed` | 未找到（not found） |
| Copilot 用户目录 | `lstat ~/.copilot` | missing |
| Copilot MCP 配置 | `lstat ~/.copilot/mcp-config.json` | missing |
| Copilot 用户指令 | `lstat ~/.copilot/copilot-instructions.md` | missing |
| Copilot 仓库指令 | `lstat ~/.github/copilot-instructions.md` | missing |
| Zed Linux settings | `lstat ~/.config/zed/settings.json` | missing |
| Zed Windows settings | `lstat ~/AppData/Roaming/Zed/settings.json` | missing |
| Zed macOS settings | `lstat ~/Library/Application Support/Zed/settings.json` | missing |
| Zed 项目 settings | `lstat ~/.zed/settings.json` | missing |
| VS Code 工作区 MCP | `lstat ~/.vscode/mcp.json` | missing |

- 结论：本机未安装四工具的可探测身份来源，真实环境 `detected` 应判 `unavailable`；合成 fixture 只证明机制，不证明真实客户端兼容。
- 公开文档抓取：GitHub/VS Code/Zed/JetBrains/Tabnine 官方页均可访问（HTTP 200；JetBrains/Tabnine 有 302/307 跳转后取到内容），抓取时间 2026-11-23。

## 4. 配置 / 规则 / MCP 降级清单

| 工具 | 配置候选（适配器声明） | 规则候选 | MCP 容器 | 是否生成配置 | 降级/限制 |
|---|---|---|---|---|---|
| GitHub Copilot | 用户 `~/.copilot/mcp-config.json`（`mcpServers.ano`）；工作区 `<root>/.mcp.json`（`mcpServers.ano`） | 用户 `~/.copilot/copilot-instructions.md`、`~/.copilot/instructions/`；项目 `.github/copilot-instructions.md`、`.github/instructions/` | `mcpServers` | 是（dry-run 默认；apply 需授权 + 已存在文件） | `.vscode/mcp.json` 为弃用 `servers` 格式，刻意不写；`COPILOT_HOME` 覆写未探测 |
| Zed | 用户平台 settings（`~/.config/zed/settings.json` / `~/AppData/Roaming/Zed/settings.json` / `~/Library/Application Support/Zed/settings.json`，默认取平台路径）；项目 `<root>/.zed/settings.json` | 无声明（不猜） | `context_servers` | 是（dry-run 默认；apply 需授权 + 已存在文件） | settings 路径待核实；条目形状为 E1 但未在真实 Zed 实测 |
| JetBrains AI | 无（IDE 设置内，无公开接口） | 无（不猜） | 无 | 否（恒零写） | IDE 插件-only；插件宣传不作接口证据 |
| Tabnine | 无（无公开接口） | 无（不猜） | 无 | 否（恒零写） | IDE 插件 + 云端；云端能力不冒充本地接管 |

写入条目（数据，非执行）：

- Copilot：`{ "command": "node", "args": ["<package-root>/dist/surface/mcp.js"] }`，`serverPath=['mcpServers']`，`serverName='ano'`。
- Zed：`{ "command": "node", "args": ["<package-root>/dist/surface/mcp.js"], "env": {} }`，`serverPath=['context_servers']`，`serverName='ano'`。
- `<package-root>` 由 `import.meta.url` 上推两级得到，条目来源为 `package.json` 的 `mcp` 字段。
- T-081 不创建配置父目录：目标文件父目录缺失时 `plan`/`apply` 返回零写（测试与实现一致）。

## 5. 能力分层与降级矩阵

四适配器 `inspect` 恒产出九层报告；`verify` 只实测 `mcp`/`tools`/`brief`。

| 层 | GitHub Copilot | Zed | JetBrains AI | Tabnine |
|---|---|---|---|---|
| detected | 有声明来源时可 `degraded`（E2 存在性，无版本）；否则 `unavailable` | 同左（settings 存在性） | `unavailable`（无声明来源） | `unavailable`（无声明来源） |
| configured | 最高 `degraded`（`evidence='configured'`） | 同左 | `unavailable` | `unavailable` |
| mcp / tools / brief | `inspect` 中 `unavailable`；`verify` 实测 | 同左 | `unavailable` | `unavailable` |
| instructions | `degraded`；检测用户/仓库指令与受管段 marker（只读） | `unavailable`（无声明规则文件） | `unavailable` | `unavailable` |
| orchestration | `degraded`，`mode='explicit-workflow'`，`evidence='assumed'` | 同左 | `degraded`，`mode='explicit-workflow'` | `degraded`，`mode='explicit-workflow'` |
| history | `unavailable`，`evidence='absent'` | 同左 | 同左 | 同左 |
| output-interception | `unavailable`，`hooksAreToolLevel=true` | 同左 | 同左 | 同左 |

- 扩展层为 `unavailable` 时全部进入报告 `limitations`。
- 报告固定包含不可放大声明：stdio 握手成功不得表述为已配置/已接管；七工具可用不得表述为 DAG/历史/输出拦截已接管；合成 fixture 不得表述为真实客户端兼容。
- 明确否定声明：Copilot/Tabnine/JetBrains 的代码补全或云端 Agent 能力不得表述为 ANO Agent 接管（测试对 Copilot/Tabnine/JetBrains 断言 `completion` 相关限制行）。

## 6. 测试与回归结果

| 命令 | 结果 |
|---|---|
| `node --test test/unit/client-ide-coding.test.ts` | 15 tests，15 pass，0 fail |
| `node --test test/unit/client-doctor.test.ts` | 19 tests，19 pass，0 fail（回归） |
| `npx tsc -p tsconfig.json --noEmit` | 本任务文件 0 error；残余错误来自并行任务在途文件（`src/clients/deepseek-harness.ts` 与 `test/unit/client-open-agents.test.ts`、`test/unit/client-enterprise-ai.test.ts`） |

新增测试覆盖：四适配器身份来源与 registry 一致、初始 `unverified`；detect 只读且不猜路径（含项目配置/设置文件不是身份来源）；九层报告形状；configured 只读发现与降级；规则文件与受管段检测；dry-run 零写；apply 合并保留未知字段/其他服务；缺授权与缺 statement 零写；路径逃逸拒绝；畸形 JSON 隔离为 `E2_PARSE_FAILED`；注入握手与七工具/缺工具/握手失败隔离；IDE-only 全层不 `validated` 且 apply 恒零写；空 root 零文件。合成 fixture 标 `synthetic:true`。

## 7. 未实测层与移交项

1. **无真实安装**：本机四工具均未安装，`detected/configured/mcp/tools/brief` 真实兼容未实测；所有真实单元格保持 `unavailable`/`degraded`，无 `validated`。
2. **Zed settings 路径待核实**：官方页只给 `zed: open settings file`，未明示绝对路径；适配器按平台取候选路径并显式标注 `unverified`。需在装有 Zed 的机器上运行 `zedAdapter.inspect`/`detect` 比对真实 settings 路径后升级。
3. **Copilot 用户级指令路径未独立抓取**：`~/.copilot/copilot-instructions.md` 来自 ADR-008 §3；仓库级 `.github/copilot-instructions.md` 与 `.github/instructions/` 已抓取确认。
4. **`COPILOT_HOME` 覆写未探测**：官方文档记载用户配置位置可经 `COPILOT_HOME` 覆写；本适配器未读取该环境变量（registry 未声明），如 T-098/T-102 需要可统一加入声明来源。
5. **`.vscode/mcp.json` 刻意不写**：该文件是已弃用的 editor-managed 格式（顶层 `servers`），与 native Copilot 的 `mcpServers` 容器不同；为避免生成无效配置，适配器只写 native 用户/工作区文件。
6. **JetBrains AI / Tabnine 无本地接口**：保持 `detect` 无声明来源的 `unavailable` 与 `config` 恒零写；若后续公开文档出现 MCP/CLI 接口，需先在 T-092 registry 声明身份来源再升级适配器。
7. **`ConfigInput` 无 `env`/`home`**：适配器接受运行时注入的 `env`（结构兼容对象），否则回退 `process.env`；测试一律注入 tmpdir，不读真实 home。建议 T-080/T-085 在 `ConfigInput` 增加 `home`/`env` 注入字段。
8. **生产装配不在本任务范围**：`src/surface/service.ts` 的 `createClientAdapters` 与 `src/index.ts` 导出属冻结/他任务文件，本任务未修改；四适配器当前由单元测试直接实例化验证，生产接线由后续任务（如 T-098/T-101）收口。
9. **并行任务在途错误**：验证时 `tsc` 残余错误仅来自 `src/clients/deepseek-harness.ts` 与 `test/unit/client-open-agents.test.ts`、`test/unit/client-enterprise-ai.test.ts`（T-095/T-096/T-097 在途），本任务文件全程 0 error，未修改上述文件。
