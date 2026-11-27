# 企业/中文 AI 组适配器证据报告（T-096 / CX-06）

- 日期：2026-11-23
- 任务：T-096（M12 / CX-06）
- 交付：`src/clients/amazon-q.ts`、`src/clients/codegeex.ts`、`src/clients/tongyi-lingma.ts`、`src/clients/comate.ts`、`test/unit/client-enterprise-ai.test.ts`、本报告
- 性质：公开文档只读核实 + 本机存在性只读探测 + 合成 fixture / tmpdir 注入验证。未读取真实客户端配置内容，未修改用户级配置，未执行配置内容，未新增第八个 MCP 工具。
- 上游契约：`docs/adr/ADR-008-full-client-catalog.md` §2/§3/§4/§5/§6/§10、`docs/client-catalog.md` §1/§3、`src/clients/types.ts`、`src/clients/registry.ts`、`src/clients/doctor.ts`、`src/clients/config.ts`（T-081）。
- 核实时点：2026-11-23；本机 win32 10.0.19041 x64，Node v24.14.0，工作目录 `F:\Agent Nihil Obstat`。

## 1. 结论

1. 四个适配器均实现 `ClientAdapter` 四接口（`detect`/`inspect`/`config`/`verify`）。配置写路径全部委托 `src/clients/config.ts`（T-081），真实 stdio 验证委托 `src/clients/doctor.ts` 的 `verifyStdioMcp`；适配器自身不写文件、不执行配置内容、不新增第八个 MCP 工具。
2. Amazon Q Developer / Kiro、通义灵码（Qoder CN）、Comate 的公开 MCP 配置接口已用官方文档核实（E1），适配器据此生成合法 `mcpServers.ano` 配置（dry-run 提案；apply 需显式授权）。CodeGeeX 官方仓库/插件页无任何 MCP 接口（E1 身份 + 无接口），适配器显式降级，不生成无效配置。
3. 中文名称/企业功能宣传（E0）只用于核实产品身份与定位，不作为任何接口、路径或格式证据；AWS/阿里云/百度云的模型供应商或云端能力不冒充宿主本地接管能力。
4. 通义灵码（Qoder CN，`docs.qoder.cn`）与国际版 Qoder（`docs.qoder.com`）是两个不同产品：官方来源、用户配置路径、CLI 命令均分开；`qoder` 可执行名仅作为 registry 声明的待核实候选保留，不得据此认定通义灵码身份。
5. 本机未安装这四个工具（`kiro`/`kiro-cli`/`qodercn`/`comatecli` 均不在 PATH），因此没有真实客户端握手或真实配置读取；所有能力层默认 `unverified`/`unavailable`，存在性探测（E2）只把 `detected` 升到 `degraded`，绝不 `validated`。

## 2. 逐工具公开来源与证据分级（E0~E4）

| 工具 | 来源 | 级别 | 能证明 | 不能证明 |
|---|---|---|---|---|
| Amazon Q Developer | https://aws.amazon.com/q/developer/ | E0/E1 | 产品身份；IDE 插件 2027-04-30 终止支持；CLI 血缘转为 Kiro；CLI 仍可用 | 任何本地接口格式 |
| Amazon Q / Kiro CLI | https://kiro.dev/docs/cli/ | E1 | Kiro CLI v3+ 为单一独立 `kiro-cli` 二进制 | 本机已安装 |
| Amazon Q / Kiro MCP | https://kiro.dev/docs/mcp/configuration/ | E1 | `~/.kiro/settings/mcp.json`（用户）、`.kiro/settings/mcp.json`（工作区）；顶层 `mcpServers`；本地项 `command`/`args`/`env`/`disabled`；工作区优先于用户 | 本机已配置/已实测 |
| Amazon Q / Kiro steering | https://kiro.dev/docs/steering/ | E1 | `~/.kiro/steering/`、`.kiro/steering/`；markdown `.md`，可选 YAML front matter；亦支持 AGENTS.md | 客户端已读取 |
| CodeGeeX | https://codegeex.cn/ | E0 | 产品身份（页面正文抓取为空，仅域名/品牌） | 任何接口 |
| CodeGeeX | https://github.com/zai-org/CodeGeeX | E1 | 产品形态：VS Code/JetBrains 插件、云端 playground、本地推理、Docker；README 无 MCP | MCP 接口存在 |
| CodeGeeX | https://github.com/CodeGeeX/codegeex-vscode-extension | E1 | 插件功能为补全/翻译/提示；无 MCP、无本地配置接口 | Agent 接管、MCP |
| 通义灵码 / Qoder CN | https://lingma.aliyun.com/ ；https://help.aliyun.com/zh/lingma/ | E0 | 产品身份与品牌（通义灵码） | 接口格式 |
| 通义灵码 / Qoder CN | https://docs.qoder.cn/cli/installation | E1 | CLI 命令为 `qodercn`（`qodercn --version`；npm `@qodercn-ai/qoderclicn`），不是 `qoder` | 本机已安装 |
| 通义灵码 / Qoder CN MCP | https://docs.qoder.cn/cli/mcp-reference | E1 | `~/.qoder-cn/settings.json`、`<project>/.qoder/settings.json`、`<project>/.mcp.json`、`<project>/.qoder/settings.local.json`；顶层 `mcpServers`；本地项 `command`/`args`/`env`/`cwd`；`qodercn mcp add|list|remove`；生效顺序 user→project settings→project .mcp.json→local→CLI | 本机已配置/已实测 |
| 通义灵码 / Qoder CN 设置 | https://docs.qoder.cn/cli/settings-reference | E1 | `QODERCN_CONFIG_DIR`（默认 `~/.qoder-cn`）；`context.fileName` 默认 `AGENTS.md` | 规则已生效 |
| Comate | https://comate.baidu.com/zh ；https://cloud.baidu.com/doc/COMATE/ | E0 | 产品身份（百度 Comate） | 接口格式 |
| Comate MCP | https://cloud.baidu.com/doc/COMATE/s/3msr9pbuy | E1 | `~/.comate/mcp.json`（全局）、`.comate/mcp.json`（项目）；顶层 `mcpServers`；STDIO 项 `command`/`args`；SSE 已废弃、Streamable HTTP 可用 | 本机已配置/已实测 |
| Comate Rules | https://cloud.baidu.com/doc/COMATE/s/Zm9l4agw3 | E1 | `.comate/rules/*.mdr`；个人/项目规则与作用域 | 客户端已读取 |
| Comate CLI | https://cloud.baidu.com/doc/COMATE/s/0mrcv8nsa ；npm `@comate/comatecli`（bin `comatecli`） | E1 | CLI 命令 `comatecli`（`npm i -g @comate/comatecli`） | 本机已安装 |

- `cbc` 是 Tencent CodeBuddy 的命令别名（T-094 范围），不是 Comate 来源，也不是 `ClientId` 别名；本组适配器不声明、不探测、不映射 `cbc`。
- `agy`（Antigravity）与 `kiro-cli`（Kiro CLI）是 CLI 命令名，不是 `ClientId` 别名（ADR-008 §10.3）。

## 3. 本机真实探测结果（存在性，留证）

执行环境：win32 10.0.19041，Node v24.14.0，工作目录 `F:\Agent Nihil Obstat`。仅做可执行名/目录存在性核对，未读取任何配置内容。

| 探测 | 结果 |
|---|---|
| `kiro` / `kiro-cli` | 不在 PATH（not found） |
| `qodercn` / `qoder` | 不在 PATH（not found） |
| `comatecli` / `cbc` | 不在 PATH（not found） |
| `~/.kiro` | missing |
| `~/.comate` | missing |
| `~/.codegeex` / `~/.lingma` | missing |
| `~/.qoder` | 存在（国际版 Qoder，M11 既有事实；不属于通义灵码，未读内容） |
| `~/.qoder-cn` | 存在（Qoder CN 用户配置目录，2026-11-22 修改；E2 存在性，未读内容） |

结论：本机无可实测的 Amazon Q/Kiro、CodeGeeX、Comate 安装；`~/.qoder-cn` 的存在只构成 E2 存在性，不构成接口实测。合成 fixture 只证明机制，不证明真实客户端兼容。

## 4. 公开格式依据与合法配置条目（实测/假设分层）

| 工具 | 格式字段 | 依据等级 | 依据 |
|---|---|---|---|
| Amazon Q / Kiro | `mcpServers.<name>`，本地项 `command`+`args`（可选 `env`/`disabled`） | E1 实测（公开文档抓取） | kiro.dev/docs/mcp/configuration/（2026-11-23 抓取） |
| Amazon Q / Kiro | 用户 `~/.kiro/settings/mcp.json`、工作区 `.kiro/settings/mcp.json` | E1 实测 | 同上 |
| Amazon Q / Kiro | steering `~/.kiro/steering/`、`.kiro/steering/`，`.md` | E1 实测 | kiro.dev/docs/steering/ |
| 通义灵码 / Qoder CN | `mcpServers.<name>`，本地项 `command`+`args`+`env`/`cwd` | E1 实测 | docs.qoder.cn/cli/mcp-reference |
| 通义灵码 / Qoder CN | 用户 `~/.qoder-cn/settings.json`；项目 `.qoder/settings.json`、`.mcp.json`、`.qoder/settings.local.json` | E1 实测 | docs.qoder.cn/cli/mcp-reference、settings-reference |
| 通义灵码 / Qoder CN | 规则 `AGENTS.md`（`context.fileName` 默认） | E1 实测 | docs.qoder.cn/cli/settings-reference |
| Comate | `mcpServers.<name>`，STDIO 项 `command`+`args` | E1 实测 | cloud.baidu.com/doc/COMATE/s/3msr9pbuy |
| Comate | 全局 `~/.comate/mcp.json`、项目 `.comate/mcp.json`；规则 `.comate/rules/*.mdr` | E1 实测 | 同上报 |
| CodeGeeX | 无公开本地 MCP/配置格式 | E1（无接口） | 官方仓库/插件页无 MCP 记载 |

写入条目（数据，非执行；`<package-root>` 由 `import.meta.url` 上推两级得到）：

- Amazon Q / Kiro：`{ "command": "<node>", "args": ["<package-root>/dist/surface/mcp.js"] }`，`serverPath=['mcpServers']`，`serverName='ano'`。
- 通义灵码 / Qoder CN：同上（`type` 缺省即 `stdio`）。
- Comate：同上（STDIO）。
- CodeGeeX：不生成条目。

## 5. 能力分层与降级清单

四个适配器的 `inspect` 均产出九层报告；`verify` 只实测 `mcp`/`tools`/`brief`。

| 层 | Amazon Q / Kiro | 通义灵码 / Qoder CN | Comate | CodeGeeX |
|---|---|---|---|---|
| detected | 有可执行/配置→`degraded`（E2，无版本）；无→`unavailable` | 同左 | 同左 | `unavailable`（无声明来源，IDE 插件-only） |
| configured | 有配置→`degraded`/`configured`；已安装无配置→`degraded`/`absent`；未探测→`unavailable` | 同左 | 同左 | `unavailable`；不生成无效 MCP 配置 |
| mcp / tools / brief | `inspect` 中 `unavailable`；`verify` 实测 | 同左 | 同左 | `unavailable` |
| instructions | `degraded`；扫描 steering/`.md` 与受管段 marker | `degraded`；扫描 `AGENTS.md` 与受管段 marker | `degraded`；扫描 `.comate/rules/*.mdr` 与受管段 marker | `unavailable` |
| orchestration | `degraded`，`mode='explicit-workflow'`，`evidence='assumed'` | 同左（CLI 定时任务是客户端自身调度，不放大为 ANO 派发） | 同左 | `unavailable`（前置不成立） |
| history | `unavailable`，`evidence='absent'` | 同左 | 同左 | `unavailable` |
| output-interception | `unavailable`，`hooksAreToolLevel=true` | 同左 | 同左 | `unavailable` |

- 扩展层为 `unavailable` 时全部进入报告 `limitations`。
- 报告固定包含不可放大声明：握手成功不得表述为已接管、DAG 已接管、历史已支持或输出可拦截。
- Amazon Q 报告固定包含：IDE 插件 2027-04-30 终止支持；AWS/云端模型供应商能力不是 Amazon Q 宿主接管能力。
- 通义灵码报告固定包含：与国际版 Qoder 是不同产品；`qodercn` 为官方 CLI，`qoder` 候选待核实。
- Comate 报告固定包含：`comatecli` 为官方 CLI，`cbc` 属于 CodeBuddy；企业/云端权限与隐私限制，云端能力不冒充本地接管。
- CodeGeeX 报告固定包含：IDE 插件-only、无公开本地 MCP 接口、中文/企业宣传为 E0 身份证据、降级为显式 IDE/云端工作流。

## 6. 测试与回归结果

| 命令 | 结果 |
|---|---|
| `node --test test/unit/client-enterprise-ai.test.ts` | 11 tests，11 pass，0 fail |
| `node --test test/unit/client-doctor.test.ts` | 19 tests，19 pass，0 fail |
| `npx tsc -p tsconfig.json --noEmit` | 本任务文件 0 error；残余错误来自并行任务在途文件（见 §7） |

新增测试覆盖：四适配器身份/来源/registry 一致性、官方来源引用、`qoder`≠`tongyi-lingma`、Amazon Q 的 IDE/Kiro/云端区分与 E1 配置、CodeGeeX 无接口显式降级与零写、通义灵码 `qodercn` 探测与合法配置、Comate `comatecli` 探测/`.mdr` 规则/`cbc` 排除、四适配器 MCP 验证委托与失败不放大、真实 stdio 握手、doctor 失败隔离、空 root 零文件。

## 7. 未实测层、口径差异与移交项

1. **registry 候选与实测命令不一致（需 T-092/T-102 收口）**：`src/clients/registry.ts` 为 T-092 冻结件，本组只读未改。`amazon-q` 的 `kiro` 候选与当前官方 `kiro-cli` 不一致；`tongyi-lingma` 的 `qoder` 候选与国际版 Qoder CLI 命令相同，真正官方命令为 `qodercn`。适配器已声明实测来源并保留待核实候选，建议后续修正 registry（或明确候选语义）。
2. **`~/.qoder` 与 `~/.qoder-cn` 并存**：本机两者都存在。`~/.qoder` 属国际版 Qoder（M11），`~/.qoder-cn` 属通义灵码（Qoder CN）。适配器只探测各自声明的路径，不互相读取，不合并身份。
3. **项目级 `.qoder/settings.json` 路径碰撞**：Qoder CN 与国际版 Qoder 文档都使用 `<project>/.qoder/settings.json`。本适配器按 Qoder CN 官方文档声明该候选，并在限制中明示碰撞；实际写入时按 `clientId='tongyi-lingma'` 归属记录，不据此推断另一产品。
4. **CodeGeeX 无公开本地接口**：官方仓库/插件页无 MCP 记载，但“无记载”不等于“绝对不存在”。当前按“无公开接口”显式降级；若后续出现官方 MCP/CLI 文档，可按 E1→E3→E4 升级。
5. **`inspect` 不握手**：`mcp`/`tools`/`brief` 在 `inspect` 中恒 `unavailable`；真实握手须调用 `verify()` 并提供真实或注入 stdio 命令。
6. **规则接管只检测不安装**：`instructions` 只报告规则文件存在与受管段 marker；写规则不在本任务范围（需显式授权）。
7. **并行任务在途错误**：T-096 进行期间，T-095（`test/unit/client-open-agents.test.ts`）与 T-097（`src/clients/deepseek-harness.ts`）并行写入，`tsc` 残余错误来自这些在途文件；本任务文件全程 0 error。上述文件不属于 T-096，未修改。
8. **`verify` 委托**：适配器不自带 stdio 实现，直接调用 `doctor.verifyStdioMcp`；真实 spawn 与注入 seam 的语义由 T-080/T-092 测试保证，本任务只验证适配器透传与失败隔离。
