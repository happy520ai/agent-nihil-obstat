# 全 21 工具客户端目录与验收框架（M12 / CX-01~CX-12）

- 日期：2026-11-23
- 任务：T-091 / CX-01（M12）；下游 T-092~T-102
- 上游契约：`docs/adr/ADR-008-full-client-catalog.md`（语义与硬边界以 ADR 为准；本文只给清单、所有权与验收框架）
- 状态口径：**21 工具身份已由官方来源核实（`declared`），能力层初始全部 `unverified`**。本表不读取任何真实客户端配置文件内容；路径均为探测候选，实测前不得升级为 `validated`。
- 术语：能力九层 `detected / configured / mcp / tools / brief / instructions / orchestration / history / output-interception`；verdict 三值 `validated / degraded / unavailable`；`unverified` 是客户端级证据标签，`unknown` 是「产品身份未核实」的中间状态（不再是永久禁令，见 ADR-008 §4.3/§8）。
- 核实时点：2026-11-23；本机环境 win32 10.0.19041 x64。本机仅做可执行名/目录**存在性**核对，未读取配置内容。

## 1. 21 工具目录（逐工具）

初始 verdict 列：`unverified` = 身份/接口已公开核实但本机未实测；能力层默认 `unavailable`（`detected`/`configured` 在有本机存在性时可 `degraded`）。**无任何工具初始为 `validated`。**

| # | 工具 | id | 别名 | 形态 | 配置候选路径（未核实标「待核实」） | 公开接口依据（未核实标「待核实」） | 初始 verdict | 降级路径 |
|---|---|---|---|---|---|---|---|---|
| 1 | Claude Code | `claude-code` | `cloudcode` | CLI 工具 | `~/.claude/settings.json`、`~/.claude.json`（`mcpServers`）、项目 `.mcp.json`；规则 `CLAUDE.md` | MCP 配置与规则格式（M11 已核实文档/本机存在性） | `unverified`（M11 复用；本机 `claude` 不在 PATH） | 已安装未配置 → `configured=degraded`；未安装 → 全层 `unavailable` |
| 2 | GitHub Copilot | `github-copilot` | — | IDE 插件 + CLI + 云端 agent | `~/.copilot/mcp-config.json`（`mcpServers`）；规则 `~/.copilot/copilot-instructions.md`、`~/.copilot/instructions/`；`~/.copilot/agents/`、`skills/`、`hooks/` | Copilot CLI 配置目录参考（官方文档，E1） | `unverified` | 无 CLI/IDE → `detected=unavailable`；云端 agent 能力不冒充本地接管 |
| 3 | Cursor | `cursor` | — | 编辑器 | `~/.cursor/mcp.json`、项目 `.cursor/mcp.json`（`mcpServers`）；规则 `.cursorrules`、`.cursor/rules/*.mdc` | MCP 配置格式（M11 已核实；官方文档本机不可达，格式 `assumed`） | `unverified`（M11 复用；本机未安装） | 未安装 → 全层 `unavailable`；配置格式保持 `assumed`，不升级 `measured` |
| 4 | OpenAI Codex | `codex` | — | CLI 工具 | `~/.codex/config.toml`（`[mcp_servers.*]`）；规则 `AGENTS.md` | TOML v1 只读（M11 已核实） | `unverified`（M11 复用；本机 `codex` 不在 PATH） | `apply` 一律降级 dry-run 零写；未安装 → 全层 `unavailable` |
| 5 | Trae | `trae` | — | 编辑器 + 云端 Web | **待核实**（公开文档未确认 MCP/规则路径；不得假设） | 产品页/文档（E0/E1 仅身份） | `unverified`（接口待核实） | 无公开接口 → `configured/mcp/tools/brief=unavailable`；DAG `degraded`+`explicit-workflow`；不生成无效配置 |
| 6 | Google Antigravity | `antigravity` | — | 编辑器 + CLI + SDK + 云端 App | `~/.gemini/config/mcp_config.json`、`<workspace>/.agents/mcp_config.json`（`mcpServers`）；插件 `.agents/plugins/`、`~/.gemini/config/plugins/` | MCP 文档 + 插件文档（官方，E1）；CLI `agy` | `unverified` | 未安装 → `detected=unavailable`；云端 App 能力不冒充本地接管 |
| 7 | Replit Agent | `replit-agent` | — | 云端服务 | **无本地 MCP/配置接口**（cloud-only） | 产品文档（仅证明云端形态，无本地接口） | `unverified`（云端-only） | `configured/mcp/tools/brief=unavailable`；DAG `degraded`+`explicit-workflow`（经 Web 手动）；历史/输出拦截 `unavailable`；**不生成本地配置** |
| 8 | Cline | `cline` | — | IDE 插件 + CLI | `~/.cline/data/settings/cline_mcp_settings.json`（`mcpServers`；`CLINE_MCP_SETTINGS_PATH` 可覆写） | MCP overview（官方文档，E1） | `unverified` | 未安装 → `detected=unavailable`；IDE 插件-only 时不冒充本地接管 |
| 9 | Kilo Code | `kilo-code` | — | IDE 插件 + CLI | `~/.config/kilo/kilo.jsonc`、项目 `kilo.jsonc` 或 `.kilo/kilo.jsonc`（`mcp`）；CLI `kilo` | MCP 使用文档（官方，E1） | `unverified` | 未安装 → `detected=unavailable`；IDE 插件-only 时降级 |
| 10 | Hermes Agent | `hermes-agent` | — | CLI + 桌面 App + 云端 Portal | `~/.hermes/config.yaml`（`mcp_servers`）；规则 `~/.hermes/SOUL.md` + context files；CLI `hermes` | MCP 文档 + 配置文档（官方，E1） | `unverified` | 未安装 → `detected=unavailable`；桌面/云端能力不冒充本地接管 |
| 11 | OpenClaw | `openclaw` | — | 自托管代理框架 / CLI / 桌面 App | `~/.openclaw/openclaw.json`；skills/plugins | 官方文档（配置路径 E1）；**MCP 待核实**（官方未明示；本机 `openclaw-cn` 发行版含 MCP 引用，不作官方证据） | `unverified` | MCP 未核实前 `mcp/tools/brief=unavailable`；可经 skills/plugins 显式工作流；不猜接口 |
| 12 | Zed | `zed` | — | 编辑器 | settings 文件（**路径待核实**：候选 `~/.config/zed/settings.json` / `%APPDATA%\Zed\settings.json` / `~/Library/Application Support/Zed/settings.json`），键 `context_servers` | MCP 文档（键 `context_servers`，官方 E1；文件路径官方未明示） | `unverified` | 路径未核实前 `configured=unavailable`；未安装 → `detected=unavailable` |
| 13 | Tabnine | `tabnine` | — | IDE 插件 + 云端 Agent | **无公开 MCP 接口（待核实）** | 官方文档（仅产品/Agent 形态，无 MCP 证据） | `unverified`（IDE 插件-only） | `configured/mcp/tools/brief=unavailable`；DAG `degraded`+`explicit-workflow`；不冒充本地接管 |
| 14 | Amazon Q Developer | `amazon-q` | — | IDE 插件 + CLI（Kiro 血统）+ 云端 | `~/.kiro/settings/mcp.json`、项目 `.kiro/settings/mcp.json`（`mcpServers`）；steering `~/.kiro/steering/`、`.kiro/steering/`；`KIRO_HOME` 可覆写 | Kiro CLI 配置文档（官方，E1）；Amazon Q 产品页（E0） | `unverified` | IDE 插件 2027-04-30 终止支持；CLI 未安装 → `detected=unavailable`；旧 Q CLI 路径不单独假设 |
| 15 | JetBrains AI | `jetbrains-ai` | — | IDE 插件 | IDE 设置内（**无公开 MCP 接口，待核实**） | 官方文档（仅插件形态，无 MCP 证据） | `unverified`（IDE 插件-only） | `configured/mcp/tools/brief=unavailable`；DAG `degraded`+`explicit-workflow`；不冒充本地接管 |
| 16 | CodeGeeX | `codegeex` | — | IDE 插件（VS Code/JetBrains） | **无公开 MCP 接口（待核实）** | 官方站点/仓库/插件页（E0/E1 仅身份） | `unverified`（IDE 插件-only） | `configured/mcp/tools/brief=unavailable`；DAG `degraded`+`explicit-workflow`；不冒充本地接管 |
| 17 | 通义灵码 | `tongyi-lingma` | — | IDE 插件 + IDE + CLI（Qoder CN） | `~/.qoder-cn/settings.json`、项目 `.qoder/settings.json`、项目 `.mcp.json`（`mcpServers`）；规则 `AGENTS.md`；`QODERCN_CONFIG_DIR` 可覆写 | Qoder CN CLI 设置/MCP 参考（官方，E1） | `unverified` | 未安装 → `detected=unavailable`；与 `qoder`（国际版）区分，不合并 |
| 18 | 文心快码 Comate | `comate` | — | IDE + IDE 插件 + CLI | `~/.comate/mcp.json`、项目 `.comate/mcp.json`（`mcpServers`）；rules `.comate/`；CLI `comatecli` | MCP 文档 + CLI 快速入门（官方，E1） | `unverified` | 未安装 → `detected=unavailable`；企业/云权限限制明示 |
| 19 | Qoder | `qoder` | — | 编辑器 / 代理框架 + CLI + 云端 | `~/.qoder/settings.json`、项目 `.qoder/settings.json`、`.qoder/settings.local.json`、项目 `.mcp.json`（`mcpServers`）；CLI `qoder mcp add|list|remove` | MCP servers/reference 文档（官方，E1；M11 已核实） | `unverified`（M11 复用；本机 `~/.qoder/` 存在、无 `ano`、无版本） | 已安装未配置 → `configured=degraded`；未安装 → 全层 `unavailable`；与 `tongyi-lingma` 区分 |
| 20 | CodeBuddy | `codebuddy` | — | IDE + IDE 插件 + CLI | `~/.codebuddy/.mcp.json` 或 `~/.codebuddy/mcp.json`、项目 `.mcp.json`（`mcpServers`）；规则 `CODEBUDDY.md`、`rules/`；CLI `codebuddy`/`cbc` | CLI 目录结构 + MCP 文档（官方，E1） | `unverified` | 未安装 → `detected=unavailable`；`~/.codebuddy/` 存在性本机已见（未读内容） |
| 21 | DeepSeek Harness | `deepseek-harness` | `dsh` | 代理框架（Cordis 插件架构）+ CLI + 桌面 App + Web UI | Cordis `cordis.yml`；`$DSH_HOME/cordis.patch.yml`、`$DSH_HOME/profiles/<name>/cordis.patch.yml`；凭证 `$DSH_HOME/.credentials.yaml`；CLI `dsh` | 官方产品页/仓库/文档（E1）；CLI `dsh`、profiles `web/headless/sdk/sdk-minimal/acp`、MCP 客户端 `@deepseek-ai/dsh-mcp-client`、ACP/SDK/插件 API | `unverified`（身份已核实为 `declared`；接口已核实，未实测；**不再是 `unknown`**） | 未安装 → `detected=unavailable`；ACP/SDK 握手不得当作 ANO MCP 七工具验证；无接口层显式降级 |

- **别名**：仅 `cloudcode`→`claude-code`、`dsh`→`deepseek-harness`；其余工具无 `ClientId` 别名。
- **名称碰撞**：`qoder`（国际版，docs.qoder.com）与 `tongyi-lingma`（阿里通义灵码，现品牌 Qoder CN，docs.qoder.cn）是不同产品；不得合并。
- **产品过渡**：Amazon Q Developer CLI 已转为 Kiro CLI；IDE 插件 2027-04-30 终止支持。
- 表中「公开接口依据」为 E1（公开文档/官方仓库）或 E0（仅宣传）；**均不构成本机实测**。

## 2. M11 既有覆盖关系表

M11 的 8 个客户端在 M12 中的处置：21 清单内 5 个复用并升级语义；3 个保留为既有非 21 项。

| M11 客户端 | ClientId | 是否在 21 清单 | M12 处置 | 初始 verdict 起点 |
|---|---|---|---|---|
| Claude Code | `claude-code` | 是（#1） | 复用并升级语义；`cloudcode` 别名不变 | `unverified`（M11 事实：detected/configured `degraded`，mcp/tools/brief `unavailable`） |
| Codex | `codex` | 是（#4） | 复用；TOML v1 只读不变 | `unverified`（同 M11） |
| Cursor | `cursor` | 是（#3） | 复用；配置格式保持 `assumed` | `unverified`（本机未安装） |
| Qoder | `qoder` | 是（#19） | 复用；与 `tongyi-lingma`（Qoder CN）区分 | `unverified`（M11 事实：detected/configured `degraded`） |
| DSH | `dsh` | 是（#21，别名） | **升级语义**：`dsh`→`deepseek-harness`；废弃永久禁令，改证据驱动 | `unverified`（身份 `declared`；不再 `unknown`） |
| OpenCode | `opencode` | 否 | 保留为既有非 21 项；不删除、不改名、不并入 21 | 沿用 M11（本机未安装） |
| Pi | `pi` | 否 | 保留为既有非 21 项；`unknown` 语义改为中间状态，当前仍无证据 | `unknown`→`unavailable`（不永久禁，但无升级证据） |
| ZCode | `zcode` | 否 | 保留为既有非 21 项；宿主配置只读；M12 不改变 | 沿用 M11（唯一有真实 stdio 证据者） |

- **不删除**：`opencode`/`pi`/`zcode` 的 id、适配器与报告 schema 保持兼容；registry 同时容纳 M11 既有与 M12 新增（T-092）。
- **不推翻**：M11 的 MCP/规则/DAG/历史/输出拦截五列口径、授权/备份/恢复边界、七工具不变约束全部沿用。

## 3. 五组适配任务（T-093~T-097）文件所有权与接口契约

下表 files 与 M12 任务簿一致；共享文件按依赖串行，不并发写。所有实现必须满足 ADR-008 §4~§7 与 ADR-007 §5 的 `ClientAdapter` 四接口。

| 任务 | 覆盖工具 | files（任务簿原样） | 独占职责 / 接口契约 |
|---|---|---|---|
| T-092 | 全部 21 + 既有 | `src/clients/types.ts`、`src/clients/registry.ts`、`test/unit/client-doctor.test.ts` | **类型与注册表基座**。扩展 `ClientId`/别名/descriptor；保持 M11 id 与证据语义；未验证不升级；未知 id 拒绝；旧报告 schema 兼容。 |
| T-093 | github-copilot、zed、jetbrains-ai、tabnine | `src/clients/github-copilot.ts`、`src/clients/zed.ts`、`src/clients/jetbrains-ai.ts`、`src/clients/tabnine.ts`、`test/unit/client-ide-coding.test.ts`、`docs/evidence/client-ide-coding.md` | **IDE/插件/CLI 组**。实现 `detect/inspect/config/verify`；探测与配置映射；插件/CLI 降级与能力报告；不把代码补全冒充 Agent 接管；隔离测试 + 证据文档。 |
| T-094 | trae、antigravity、replit-agent、codebuddy | `src/clients/trae.ts`、`src/clients/antigravity.ts`、`src/clients/replit-agent.ts`、`src/clients/codebuddy.ts`、`test/unit/client-cloud-ide.test.ts`、`docs/evidence/client-cloud-ide.md` | **云端/IDE 组**。核实本地/云端公开接口；探测/配置/规则或显式降级；云端能力不冒充本地控制；隔离配置与能力报告测试。 |
| T-095 | cline、kilo-code、openclaw、hermes-agent | `src/clients/cline.ts`、`src/clients/kilo-code.ts`、`src/clients/openclaw.ts`、`src/clients/hermes-agent.ts`、`test/unit/client-open-agents.test.ts`、`docs/evidence/client-open-agents.md` | **开源 Agent/IDE 组**。公开 MCP/规则/子任务接口；命令/API 不执行配置内容；接管与子任务能力分层；隔离/本机证据测试。 |
| T-096 | amazon-q、codegeex、tongyi-lingma、comate | `src/clients/amazon-q.ts`、`src/clients/codegeex.ts`、`src/clients/tongyi-lingma.ts`、`src/clients/comate.ts`、`test/unit/client-enterprise-ai.test.ts`、`docs/evidence/client-enterprise-ai.md` | **企业/中文 AI 组**。核实身份/接口/路径；MCP 可用时合法配置；无本地接口明确限制；中文/企业宣传不替代证据。 |
| T-097 | deepseek-harness（`dsh`） | `src/clients/deepseek-harness.ts`、`src/clients/unknown.ts`、`test/unit/client-deepseek-harness.test.ts`、`docs/evidence/client-deepseek-harness.md` | **DSH 换轨**。实现 `dsh` 别名映射与证据驱动判定；`unknown.ts` 移除永久禁令、改中间状态；不猜私有路径或格式；验证真实证据不被旧规则误压。 |

### 3.1 接口契约（所有组共用）

- 适配器实现 `ClientAdapter` 四接口；`identitySources` 只声明已核实来源；`detect` 只读、不猜路径。
- `config` 默认 dry-run；`apply` 委托 `src/clients/config.ts`，不自行写文件。
- `inspect` 恒只读，输出五列独立报告（MCP/项目接管/DAG/历史/输出拦截）+ 证据四要素 + `limitations`。
- `verify` 真实 stdio 握手 + `tools/list=7` + `brief`；握手失败即停止放大。
- 每组证据文档（`docs/evidence/client-*.md`）独占；实测与推断分列；合成 fixture 标 `synthetic:true`。

## 4. 验收分层与已知限制

| 层 | 范围 | 必须产出 | 不得代替 |
|---|---|---|---|
| 模拟 | 类型/注册表/dry-run/verdict 规则/失败隔离 | 确定性 fixture，零真实配置写入；§4.5 判定规则逐条可复现 | 不证明真实客户端兼容 |
| 隔离 | 合成配置根 + 临时目录 + 注入式 MCP client | 备份/hash、合并保留、原子安装、恢复、路径逃逸/并发漂移拒绝 | 不证明真实客户端存在或已配置 |
| 本机实测 | 用户明确授权的客户端与项目 | 真实 `detected/configured/mcp/tools/brief` 证据（时间/版本/来源） | 不自动读取真实会话或秘密 |
| 公开文档核实 | 官方文档/仓库只读获取 | 接口载体与配置候选证据（E1），标注核实时点 | 不升级为 `measured/validated` |

**已知限制（不得虚报）**：

1. 21 工具能力层初始全部 `unverified`；路径为探测候选，需 T-093~T-097 用真实公开文档或本机事实核实。
2. 本机（2026-11-23）仅 `openclaw` 可执行在 PATH；`~/.claude`、`~/.claude.json`、`~/.codex`、`~/.codex/config.toml`、`~/.qoder`、`~/.qoder/settings.json`、`~/.codebuddy`、`~/.openclaw`、`~/.openclaw-autoclaw` 存在（未读内容）；其余工具未安装或未探测。
3. 除 ZCode 外无真实客户端安装，`configured/mcp/tools/brief` 真实兼容未实测。
4. 真实会话样本 `[数据缺失]`，公开会话格式 `unverified`，`history` 全层 `unavailable`。
5. 输出拦截全客户端 `unavailable`（工具级 hooks 不算）。
6. `orchestration` 无公开派发接口时降级为 `degraded`+`explicit-workflow`，不复制不存在的自动化。
7. 产品接口可能随时间变化；所有 E1 证据以 2026-11-23 核实时点为准。
8. 跨 root 授权续接、移动目录身份续接、掉电持久性未验证（沿用 M10 结论）。

## 5. 全 21 工具支持矩阵最终交付口径（T-102 收口）

- **机器可读**：`docs/evidence/client-support-matrix.json`，schema `ano.client-support-matrix/1`，扩展为 21 工具（另列 M11 既有 `opencode`/`pi`/`zcode`，标注「非 21 清单既有项」）。
- **五列**：每工具固定输出 MCP / 项目接管 / DAG / 历史 / 输出拦截，取值 `validated|degraded|unavailable`；每格带证据指针与 `unverified`/`assumed` 标注，实测与推断分列。
- **不放大**：MCP 列只表示「ANO 包可被发现、配置并调用七工具」；项目接管上限 `degraded`；DAG 绝不 `validated`（无公开派发接口时 `degraded`+`explicit-workflow`）；历史无授权样本/公开格式 `unavailable`；输出拦截全 `unavailable`。
- **全适配口径**：21 工具均有可执行接入路径或明确降级；**全适配 ≠ 全部 `validated`**；未验证项明示。
- **边界**：不自动修改真实客户端配置；不读取真实会话或秘密；授权修改备份 + 原子写 + 恢复。
- **收口任务**：T-098（统一能力计划与批量授权）、T-099（命令/矩阵/现场验证）、T-100（红队）、T-101（集成门禁）、T-102（矩阵/文档/审计/最终验收）。

## 6. 交叉引用

- `docs/adr/ADR-008-full-client-catalog.md`：21 工具身份、九层/verdict、全适配、证据分级、DSH 语义变更、硬边界。
- `docs/adr/ADR-007-client-adapters.md`：九层契约、四接口、授权/备份、硬边界（M11）。
- `docs/adr/ADR-006-project-takeover.md`：授权模型、备份/恢复、宿主能力降级（M10）。
- `docs/client-compatibility.md` §11：M11 最终支持矩阵与五列口径。
- `docs/evidence/client-support-matrix.json`：M11 机器可读矩阵 schema。
- `docs/evidence/client-unknowns.md`：M11 Qoder/DSH/Pi 旧结论（DSH 部分由 ADR-008 §8 取代）。
