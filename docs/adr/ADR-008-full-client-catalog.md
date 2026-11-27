# ADR-008：全 21 工具客户端目录、能力分层与全适配验收协议

日期：2026-11-23
状态：提议（待主控审阅；审阅通过后置"已接受"并开放 M12 phase-clients 门禁）
任务：T-091 / CX-01（M12）
输入契约：`docs/adr/ADR-006-project-takeover.md`、`docs/adr/ADR-007-client-adapters.md`、`docs/client-compatibility.md`（含 §11 M11 最终对账）、`docs/evidence/client-support-matrix.json`、`docs/evidence/client-unknowns.md`、`docs/evidence/client-claude-codex.md`、`docs/evidence/client-cursor-opencode.md`、`docs/evidence/client-history.md`、`docs/evidence/client-orchestration.md`、`src/clients/types.ts`、`src/clients/registry.ts`、`src/clients/unknown.ts`、`src/clients/doctor.ts`、`src/clients/capabilities.ts`、`.pm/roadmap.json`（M12）、T-091~T-102 任务簿

> 编号说明：本文件是 `docs/adr/` 系列 ADR-007 的 M12 扩展，不推翻 ADR-007 的九层能力、verdict 三值、四接口与授权/备份语义。冲突处以本 ADR 的「DSH 语义变更」与「21 工具目录」为准。兼容矩阵与逐工具清单见 `docs/client-catalog.md`。

## 1. 背景与问题定义

M11（ADR-007）把「客户端支持」固定为九层能力、verdict 三值、四接口与授权/备份契约，但只覆盖 8 个客户端（`claude-code/codex/cursor/opencode/qoder/dsh/pi/zcode`），并把 `dsh`/`pi` 明文定为「身份或接口不明确 → `unknown`，全层 `unavailable`，**永远不得 `validated`**」。M12 的目标是把用户指定的 21 个编码工具全部纳入自适应接入体系，同时修正 DSH 语义：DSH 是真实产品 DeepSeek Harness 的别名，必须按证据判定，而不是永久禁令。

一句话问题定义：把 21 个工具逐一固定为「可探测、可验证、可降级、可恢复」的契约——每个工具的稳定身份、产品形态、配置与接口载体、初始 verdict、降级路径与证据缺口都显式固定；未实测不得升级为 `validated`，无公开接口/云端-only/IDE 插件-only 必须显式降级。

「修好了」的判据：T-092~T-097 的实现者不需要再做本 ADR 范围内的语义决策；验收可直接按第 11 节判据与 `docs/client-catalog.md` 的所有权表编写；不新增第八个 MCP 工具，不修改用户级配置，不读取真实会话或秘密，不虚构任何 `validated`。

## 2. 硬边界（全节为硬边界，实现与测试不得违反）

以下十条是 M12 的不可变边界，与 ADR-003/004/005/006/007 一致；任一条被违反即视为实现错误，而不是配置问题：

1. **不虚构 `validated`**：任何能力层 `validated` 必须来自真实探测/调用且证据四要素齐全；产品功能宣传、名称相似、目录存在、合成 fixture 均不得升级为 `validated`。
2. **产品宣传不替代公开接口证据**：营销页/产品首页只证明产品身份与定位（E0），不证明 MCP/规则/CLI/插件接口存在；接口载体必须有公开文档或官方仓库（E1）或本机实测（E3/E4）。
3. **云端-only / IDE 插件-only / 无公开接口明确降级**：无本地 MCP 接口者不得生成无效 MCP 配置，不得把云端能力或插件能力冒充本地接管；必须给出显式降级路径（见 §5.3）。
4. **DSH 证据驱动，不再永久禁令**：废弃 ADR-007 §7 的「DSH/Pi 永远不得 `validated`」硬禁；`dsh` 是 `deepseek-harness` 的别名，按真实产品身份与公开接口证据判定（见 §8）。
5. **`cloudcode` = `claude-code`**：`cloudcode` 只是别名，不新增 `ClientId`，报告在 `clientId='claude-code'` 下以 `alias='cloudcode'` 标注。
6. **默认只读 / dry-run**：探测、`inspect`、`doctor` 默认只读；`config` 默认 `dry-run` 零写；不自动修改真实客户端配置，不读取真实会话或秘密。
7. **授权修改须备份 + 原子写 + 恢复**：任何真实写入必须显式授权 + 内容哈希备份 + `beforeHash` 漂移检查 + 原子合并 + 失败回滚（沿用 ADR-006/007 §5.6）。
8. **不新增第八个 MCP 工具**：MCP 工具数量恒为 7（`brief/explore/recall/track/note/verify/audit`）；客户端能力只经 CLI 子命令与既有工具投影暴露。
9. **适配器不执行配置内容**：配置一律作为数据解析（JSON/YAML/TOML 等），不 eval、不 shell、不动态加载配置指向的脚本。
10. **不猜身份与接口**：身份或接口无法核实的客户端使用 `unknown` 中间状态（见 §4.3），只探测已声明公开来源；核实后按证据升级/降级，不猜路径、不伪造适配器。

**自动工作流与人工动作的区分**：探测、dry-run、备份、hash 校验、原子安装、恢复属于自动工作流；授权授予/撤销、真实配置修改确认、发布/attest/approve/sync/push、宿主权限批准属于具名人工动作。自动工作流可以写项目内受管文件与 `.ano/clients/`，但不得代替上述人工动作。

## 3. 决定一：21 工具身份表

稳定 id 一经固定不得改名；别名只映射到稳定 id，不新增 `ClientId`。官方来源为公开产品页/文档 URL；核实时点 2026-11-23；**本机未实测者一律标「待核实」**，本表不声称任何接口已实测。

| # | 工具 | 稳定 id | 别名 | 官方来源（公开） | 产品形态 | 配置与接口载体 |
|---|---|---|---|---|---|---|
| 1 | Claude Code | `claude-code` | `cloudcode` | https://code.claude.com/docs | CLI 工具 | MCP（`~/.claude/settings.json`、`~/.claude.json` 的 `mcpServers`、项目 `.mcp.json`）；规则 `CLAUDE.md` |
| 2 | GitHub Copilot | `github-copilot` | — | https://docs.github.com/en/copilot ；CLI https://docs.github.com/en/copilot/concepts/copilot-surfaces/copilot-cli | IDE 插件 + CLI + 云端 agent | MCP（`~/.copilot/mcp-config.json` 的 `mcpServers`）；规则 `~/.copilot/copilot-instructions.md`、`~/.copilot/instructions/*.instructions.md`；`~/.copilot/agents/*.agent.md`、`skills/`、`hooks/` |
| 3 | Cursor | `cursor` | — | https://cursor.com/docs | 编辑器（VS Code fork） | MCP（`~/.cursor/mcp.json`、项目 `.cursor/mcp.json` 的 `mcpServers`）；规则 `.cursorrules`、`.cursor/rules/*.mdc` |
| 4 | OpenAI Codex | `codex` | — | https://developers.openai.com/codex/cli/ | CLI 工具 | MCP（`~/.codex/config.toml` 的 `[mcp_servers.*]`）；规则 `AGENTS.md` |
| 5 | Trae | `trae` | — | https://www.trae.ai/ ；https://docs.trae.cn/ ；Web https://work.trae.ai | 编辑器（VS Code fork）+ 云端 Web | MCP/规则文件**待核实**（公开文档未确认；只得 IDE/Web 形态，不假设配置路径） |
| 6 | Google Antigravity | `antigravity` | — | https://antigravity.google/ ；MCP https://antigravity.google/docs/mcp/ ；插件 https://antigravity.google/docs/plugins/ | 编辑器 + CLI + SDK + 云端 App | MCP（`~/.gemini/config/mcp_config.json`、`<workspace>/.agents/mcp_config.json` 的 `mcpServers`）；插件 `.agents/plugins/`、`~/.gemini/config/plugins/`；CLI `agy` |
| 7 | Replit Agent | `replit-agent` | — | https://replit.com/site/agent ；https://docs.replit.com/replitai/agent | 云端服务 | **无本地 MCP/配置接口**（cloud-only）；降级为显式 Web 工作流，不生成本地配置 |
| 8 | Cline | `cline` | — | https://cline.bot/ ；MCP https://docs.cline.bot/mcp/mcp-overview | IDE 插件 + CLI | MCP（`~/.cline/data/settings/cline_mcp_settings.json` 的 `mcpServers`；环境变量 `CLINE_MCP_SETTINGS_PATH` 可覆写） |
| 9 | Kilo Code | `kilo-code` | — | https://kilo.ai/ ；https://github.com/Kilo-Org/kilocode ；npm `@kilocode/cli` | IDE 插件（VS Code/JetBrains）+ CLI | MCP（`~/.config/kilo/kilo.jsonc`、项目 `kilo.jsonc` 或 `.kilo/kilo.jsonc` 的 `mcp`）；CLI `kilo` |
| 10 | Hermes Agent | `hermes-agent` | — | https://hermes-agent.nousresearch.com/ ；https://github.com/NousResearch/hermes-agent | CLI + 桌面 App + 云端 Portal | MCP（`~/.hermes/config.yaml` 的 `mcp_servers`）；规则 `~/.hermes/SOUL.md` + context files；CLI `hermes` |
| 11 | OpenClaw | `openclaw` | — | https://openclaw.ai/ ；https://github.com/openclaw/openclaw ；https://docs.openclaw.ai/ | 自托管代理框架 / CLI / 桌面 App | 配置 `~/.openclaw/openclaw.json`；skills/plugins（ClawHub）；MCP **待核实**（官方文档未明示；本机 `openclaw-cn` 发行版含 MCP 配置引用，不作为官方接口证据） |
| 12 | Zed | `zed` | — | https://zed.dev/ ；MCP https://zed.dev/docs/ai/mcp | 编辑器 | MCP（Agent Settings 的 `context_servers`；文件路径候选 `~/.config/zed/settings.json` / `%APPDATA%\Zed\settings.json` / `~/Library/Application Support/Zed/settings.json`，官方未明示，**待核实**） |
| 13 | Tabnine | `tabnine` | — | https://www.tabnine.com/ ；https://docs.tabnine.com/ | IDE 插件 + 云端 Agent | **无公开 MCP 接口**（待核实）；降级为 IDE 插件/云端，不冒充本地接管 |
| 14 | Amazon Q Developer | `amazon-q` | — | https://aws.amazon.com/q/developer/ ；CLI 现 Kiro CLI https://kiro.dev/docs/cli | IDE 插件 + CLI（Kiro 血统）+ 云端 | MCP（`~/.kiro/settings/mcp.json`、项目 `.kiro/settings/mcp.json` 的 `mcpServers`）；steering `~/.kiro/steering/`、`.kiro/steering/`；注意 IDE 插件 2027-04-30 终止支持 |
| 15 | JetBrains AI | `jetbrains-ai` | — | https://www.jetbrains.com/ai/ ；https://www.jetbrains.com/help/ai-assistant/ | IDE 插件 | **无公开 MCP 接口**（待核实）；配置在 IDE 设置内，降级为 IDE 插件 |
| 16 | CodeGeeX | `codegeex` | — | https://codegeex.cn/ ；https://github.com/zai-org/CodeGeeX ；VS Code 插件 https://github.com/CodeGeeX/codegeex-vscode-extension | IDE 插件（VS Code/JetBrains） | **无公开 MCP 接口**（待核实）；降级为 IDE 插件 |
| 17 | 通义灵码 | `tongyi-lingma` | — | https://lingma.aliyun.com/ ；现品牌 Qoder CN https://docs.qoder.cn/ ；https://help.aliyun.com/zh/lingma/ | IDE 插件 + IDE（Lingma IDE）+ CLI（Qoder CN CLI） | MCP（`~/.qoder-cn/settings.json`、项目 `.qoder/settings.json`、项目 `.mcp.json` 的 `mcpServers`）；规则 `AGENTS.md` |
| 18 | 文心快码 Comate | `comate` | — | https://comate.baidu.com/zh ；https://cloud.baidu.com/doc/COMATE/ | IDE（AI IDE）+ IDE 插件 + CLI | MCP（`~/.comate/mcp.json`、项目 `.comate/mcp.json` 的 `mcpServers`）；CLI `comatecli`（npm `@comate/comatecli`）；rules `.comate/` |
| 19 | Qoder | `qoder` | — | https://qoder.com/ ；MCP https://docs.qoder.com/cli/mcp-servers ；https://docs.qoder.com/ | 编辑器 / 代理框架 + CLI + 云端 | MCP（`~/.qoder/settings.json`、项目 `.qoder/settings.json`、`.qoder/settings.local.json`、项目 `.mcp.json` 的 `mcpServers`）；CLI `qoder mcp add|list|remove` |
| 20 | CodeBuddy | `codebuddy` | — | https://www.codebuddy.cn/ ；国际版 https://www.codebuddy.ai/ ；IDE https://copilot.tencent.com/ide/ | IDE + IDE 插件 + CLI | MCP（`~/.codebuddy/.mcp.json` 或 `mcp.json`、项目 `.mcp.json` 的 `mcpServers`）；规则 `CODEBUDDY.md`、`rules/`；CLI `codebuddy`/`cbc`（npm `@tencent-ai/codebuddy-code`） |
| 21 | DeepSeek Harness | `deepseek-harness` | `dsh` | https://deepseek.com/harness ；https://github.com/deepseek-ai/deepseek-harness ；https://deepseek-harness.github.io/deepseek-harness/ | 代理框架（Cordis 插件架构）+ CLI + 桌面 App + Web UI | Cordis `cordis.yml`；用户 patch `$DSH_HOME/cordis.patch.yml`、`$DSH_HOME/profiles/<name>/cordis.patch.yml`；MCP 客户端 `@deepseek-ai/dsh-mcp-client`（`mcp__<server>__<tool>`）；ACP stdio `dsh --profile acp`；SDK stdio JSON-RPC `dsh --profile sdk`；CLI `dsh`（`npx @deepseek-ai/dsh`） |

- **M11 既有与 21 清单的关系**：M11 的 `opencode`、`pi`、`zcode` **不在 21 清单**，保留为既有项，不删除、不改名、不并入 21；registry 需同时容纳 M11 既有与 M12 新增（T-092）。
- **名称碰撞澄清**：`qoder`（国际版 Qoder，docs.qoder.com）与 `tongyi-lingma`（阿里通义灵码，现品牌 Qoder CN，docs.qoder.cn）是**两个不同产品**，不得合并；`codebuddy` 的命令别名 `cbc` 是 CLI 命令别名，不是 `ClientId` 别名。
- **产品过渡澄清**：Amazon Q Developer CLI 已转为 Kiro CLI；IDE 插件 2027-04-30 终止支持。`amazon-q` 适配器应同时记录 Kiro 血统与退役时点，不把旧 Q CLI 路径当作唯一来源。
- 表中路径是**探测候选**，不是已验证事实；T-093~T-097 必须用真实公开文档或本机事实核实，未核实前一律 `unverified`。
- 本契约不读取任何真实客户端配置文件内容；实现只做只读探测，且不得把探测结果中的秘密回显到报告。

## 4. 决定二：九层能力、verdict 三值与 `unverified`/`unknown` 定义

### 4.1 九层能力分层（沿用 ADR-007 §3）

```text
detected → configured → mcp → tools → brief → instructions → orchestration → history → output-interception
  身份        配置声明     握手    工具面   上下文   项目规则       派发/编排      历史          输出拦截
```

层间前置：`configured` 需要 `detected`；`mcp`/`tools`/`brief` 需要 `configured` 或显式注入命令；`instructions`/`orchestration`/`history`/`output-interception` 需要 `detected`。前置不成立时该层直接 `unavailable`，不进入判定。每层证据必须含**时间**、**版本**、**来源**、**限制**四要素；缺任一项不得判 `validated`。单层失败必须隔离。

### 4.2 verdict 三值（固定，不得扩展）

```ts
type ClientVerdict = 'validated' | 'degraded' | 'unavailable';
```

弱序固定：`unavailable < degraded < validated`。`unknown` **不是**能力层 verdict。

### 4.3 `unverified` 与 `unknown` 的精确定义（M12 变更）

| 标签 | 层级 | 含义 | 处置 |
|---|---|---|---|
| `unverified` | 客户端级**证据标签**（不是能力层 verdict） | 身份或接口**未核实或未实测**：只有产品宣传（E0）、只有本机存在性（E2）、或未跑真实握手/调用。 | 能力层默认 `unavailable`；`detected`/`configured` 可 `degraded`。报告必须标注「未实测」与证据缺口；不得报 `measured/validated`。 |
| `unknown` | 客户端级**身份状态**（`ClientIdentityStatus`） | 产品身份**未核实**：无法确认官方产品/来源。这是**中间状态**，不是禁令。 | 只探测已声明公开来源；不猜路径、不伪造适配器；核实后按证据升级为 `declared`/`unverified`，或因无公开接口降级为 `unavailable`。**不再永久禁止 `validated`**。 |
| `declared` | 客户端级身份状态 | 官方身份已公开核实（有官方产品页/仓库/文档）。 | 可进入正常适配；能力层仍按证据判定。 |

- **M12 初始口径**：21 工具的身份均已由官方来源核实（§3），因此客户端级身份状态为 `declared`；但**能力层未实测**，故初始证据标签为 `unverified`，能力层默认 `unavailable`（`detected`/`configured` 在有本机存在性时可 `degraded`）。
- **M11 旧规则的废弃**：ADR-007 §4.3/§7 中「身份/接口不明确（DSH/Pi）→ 全层 `unavailable`，`validated` 不可达，**永远不得 `validated`**」的硬禁规则**自本 ADR 起废弃**。`unknown` 不再是「永不 validated」的禁令，而是「产品身份未核实」的中间状态。
- **Pi 的处置**：`pi` 保留为既有非 21 项，当前仍无公开身份/接口证据，按新语义保持 `unknown`/`unavailable`；其身份核实不在 M12 范围，但不再适用永久禁令。

### 4.4 证据强度（与 verdict 正交）

```ts
type ClientEvidence = 'measured' | 'configured' | 'assumed' | 'absent';
```

- `measured`：真实探测/真实调用成功，带时间与版本。
- `configured`：配置存在但未实测。
- `assumed`：仅来自公开文档或初始假设，未探测。
- `absent`：无证据。

### 4.5 判定规则（无歧义）

| 证据情形 | verdict | evidence | 说明 |
|---|---|---|---|
| 未安装 / 无该机制 / 明确不支持 / 前置层不成立 | `unavailable` | `absent` | 不进入该层判定 |
| 已安装但未配置 | `degraded` | `absent` | 需要配置动作 |
| 已配置但未实测 | `degraded` | `configured`（`unverified`） | 上限 `unverified` |
| 仅公开文档/初始假设，未探测 | `degraded` | `assumed` | 必须标注「未实测」 |
| 实测成功但该层能力部分缺失 | `degraded` | `measured` | 显式列出缺失能力 |
| 实测成功且该层完整、四要素齐全 | `validated` | `measured` | 缺一要素即降 `degraded` |
| 无公开接口 / 云端-only / IDE 插件-only | `unavailable`（或 `degraded`+显式工作流） | `absent`/`assumed` | 见 §5.3；绝不 `validated` |

### 4.6 聚合与五列独立报告

- **核心链路**（`detected → configured → mcp → tools → brief`）取五层最弱值为 `coreVerdict`。
- **扩展层**（`instructions`/`orchestration`/`history`/`output-interception`）单独报告，不参与 `coreVerdict`，但任一扩展层 `unavailable` 时必须列入 `limitations`。
- **五列独立报告**（M12 固定口径，与 `docs/client-compatibility.md` §11.1 一致）：

| 列 | 对应层 | 口径（不得放大） |
|---|---|---|
| MCP | 核心五层最弱值 | 只表示「ANO 包可被发现、配置并调用七工具」 |
| 项目接管 | `instructions` | 上限 `degraded`；受管段检测是只读事实，写入需显式授权；文件存在 ≠ 客户端已读取 |
| DAG | `orchestration` | 无公开派发接口时 `degraded` + `mode='explicit-workflow'`；绝不 `validated`；不把 CLI doctor 成功放大为客户端自动派发 |
| 历史 | `history` | 无授权样本或公开格式时 `unavailable`；合成 fixture 不升级 |
| 输出拦截 | `output-interception` | 全客户端 `unavailable`；工具级 hooks 不算输出拦截 |

- **恢复（backup/restore）是横切能力**，不是第五列；按 ADR-006/007 §5.6 独立报告，不参与 `coreVerdict`。
- **禁止放大**：`coreVerdict='validated'` 只表示「ANO 包可被该客户端发现、配置并调用七工具」，不表示项目规则已接管、DAG 已接管、历史已支持或输出可拦截。

## 5. 决定三：全适配定义

### 5.1 全适配的判据

**全适配 = 每个工具都进入 `detect`/`inspect`/`config`/`verify` 四接口与备份/恢复体系**，并满足：

1. 有稳定 id 与别名映射，registry 可寻址，未知 id 拒绝。
2. 有声明的身份来源与配置候选路径（或明确「无公开接口」）。
3. 输出五列独立报告（MCP/项目接管/DAG/历史/输出拦截），每格带证据指针与 `unverified`/`assumed` 标注。
4. 无公开接口/云端-only/IDE 插件-only 有明确降级路径，绝不 `validated`。
5. 真实写入需显式授权 + 备份 + 原子写 + 恢复；默认 dry-run。

**全适配不等于全部 `validated`**：全适配是「每个工具有可执行接入路径或明确降级」，不是「每个工具都支持全部能力」。

### 5.2 四接口与备份/恢复

沿用 ADR-007 §5 的 `ClientAdapter` 四接口（`detect`/`inspect`/`config`/`verify`）与授权/备份模型：

- `detect`：只读；来源不可读/超时/版本不可解析 → `detected=false` 或 `version=null` + 隔离错误；不猜路径。
- `inspect`：恒只读；单层失败隔离；不读真实会话内容或秘密。
- `config`：默认 `dry-run` 零写；`apply` 需显式授权 + 备份 + hash 绑定 + 原子写 + 失败恢复；保留其他服务与未知字段。
- `verify`：真实 stdio 握手 + `tools/list` + `brief`；握手失败即停止后续层，不放缓存/假设。
- 备份/恢复：`<root>/.ano/clients/backups/<clientId>/<id>/`，内容哈希清单，`backupHash` 绑定授权与安装记录；恢复前逐文件校验。

### 5.3 降级路径（按产品形态）

| 形态 | detected | configured / mcp / tools / brief | DAG | 历史 | 输出拦截 |
|---|---|---|---|---|---|
| CLI + MCP | 可 `degraded`（无版本）/ `validated`（实测） | 依证据：有公开 MCP 配置 → `degraded`（未实测）/ `validated`（真实握手+七工具+brief） | 无公开派发接口 → `degraded`+`explicit-workflow`；有公开接口 → 依证据，绝不 `validated`（除非实测） | 无授权样本/公开格式 → `unavailable` | `unavailable` |
| 编辑器 + MCP | 同上 | 同上 | 同上 | 同上 | `unavailable` |
| IDE 插件-only | 可 `degraded`（IDE/插件存在） | 无公开 MCP → `unavailable`；配置格式仅 `assumed` | `unavailable` 或 `degraded`+`explicit-workflow` | `unavailable` | `unavailable` |
| 云端-only | 可 `degraded`（Web/账号存在） | `unavailable`（无本地接口）；**不得生成无效 MCP 配置** | `degraded`+`explicit-workflow`（经 Web/API 手动） | `unavailable` | `unavailable` |
| 代理框架 / 插件架构 | 可 `degraded`/`validated` | 若作为 MCP 宿主：`configured` 依证据；`mcp`/`tools`/`brief` 验证 ANO 包本身 | 无公开派发接口 → `degraded`+`explicit-workflow` | `unavailable` | `unavailable` |
| 无公开接口 | `degraded`（若本机存在） | `unavailable` | `degraded`+`explicit-workflow` 或 `unavailable` | `unavailable` | `unavailable` |

**绝不 `validated` 的情形**：无公开接口；云端-only；IDE 插件-only 且无 MCP；仅产品宣传；仅本机安装/配置存在性；仅合成 fixture；身份未核实且无升级路径。

## 6. 决定四：证据分级

| 级别 | 证据形态 | 能证明什么 | 不能证明什么 | 判定规则 |
|---|---|---|---|---|
| E0 | 产品功能宣传/营销页/首页 | 产品身份与定位 | 任何接口存在或格式 | 只用于身份核实；不得作为接口证据 |
| E1 | 公开文档/官方仓库（接口文档、配置参考、CLI reference、README） | 接口载体、配置路径/键、CLI 命令、插件机制 | 本机已安装/已配置/已实测 | 可支持 `assumed` 与配置候选；不得升级为 `measured` |
| E2 | 本机安装/配置存在性（可执行名、目录、配置文件存在） | `detected` 候选 | 接口实测、配置已生效 | `detected` 最高 `degraded`（无版本）；不得报「已支持」 |
| E3 | 本机命令实测（`--help`/`--version`、只读探测、dry-run、CLI 子命令） | `detected`/`configured` 的 `measured` 证据、格式可达 | MCP 七工具可用、完整接管 | 可升级 `detected`/`configured` 到 `degraded`+`measured`；不放大 |
| E4 | 真实 stdio 握手 + `tools/list=7` + `brief` 调用 | `mcp`/`tools`/`brief` 的 `measured` 证据 | DAG/历史/输出拦截 | 四要素齐全才 `validated`；任一层成功不代替其他层 |
| — | 合成 fixture | 机制正确性 | 真实客户端兼容 | 显式标 `synthetic:true`；不升级任何真实单元格 |

**判定规则（硬性）**：

1. 产品功能宣传 ≠ 公开接口证据。
2. 本机安装/配置存在性 ≠ 接口实测。
3. 真实 stdio 握手/公开文档/本机命令实测 = 可升级证据（分别对应 E4/E1/E3）。
4. 每层证据必须含时间、版本、来源、限制；缺任一项不得判 `validated`。
5. 实测与推断必须分列；报告不得把 `assumed` 表述为 `measured`。

## 7. 决定五：授权、备份与恢复边界（沿用 ADR-006/007）

- **只读探测默认**：`detect`/`inspect`/`doctor` 默认只读；`config` 默认 `dry-run` 零写。
- **显式授权**：库级与 CLI 的配置修改必须显式 `--confirm` 与授权作用域；不得从环境变量、配置文件或默认值推断授权。授权记录是项目内本地可审计记录，不是 token，不授予宿主权限。
- **授权作用域**：`<root>/.ano/clients/authorization.json`，schema `ano.client-authorization/1`；绑定单一规范项目根与单一 `clientId`；跨 root / 跨客户端一律拒绝。
- **备份**：`<root>/.ano/clients/backups/<clientId>/<id>/`，复用 `src/connect/backup.ts` 的内容哈希清单模式；`backupHash` 绑定授权与安装记录。
- **原子写与恢复**：`beforeHash` 漂移拒绝；原子合并保留其他 MCP 服务与未知字段；失败回滚到 `beforeHash` 并报告 `restoredOnFailure=true`；`restore` 只使用校验通过的已验证备份，不删除备份目录。
- **不读真实会话或秘密**：`history` 层与任何会话采样必须由用户明确授权；不采集凭据、令牌、私钥、宿主全局会话或未授权目录；探测结果不得回显秘密。
- **写路径独占**：`src/clients/config.ts` / `install.ts` 独占配置读写；适配器只声明 `configTargets`（路径/格式/键），不得自行写文件。

## 8. 决定六：DSH 语义变更专节

### 8.1 废弃条款（明文）

**废弃 ADR-007 §7 的 DSH 硬禁规则**：原规则为「DSH 身份或接口不明确 → `status='unknown'`，全层 `unavailable`，verdict 上限 `degraded`/`unverified`，**永远不得达到 `validated`**」。该规则自本 ADR 起**整体废弃**，不再适用于 `dsh`，也不再作为通用 `unknown` 语义。

### 8.2 新语义（明文）

- `dsh` 是 `deepseek-harness` 的**别名**（`alias='dsh'`），映射到稳定 id `deepseek-harness`；不新增第 22 个 `ClientId`。
- DSH 是**真实产品 DeepSeek Harness**：官方产品页 https://deepseek.com/harness ，官方仓库 https://github.com/deepseek-ai/deepseek-harness（MIT，TypeScript，「Everything is a Plugin」），官方文档 https://deepseek-harness.github.io/deepseek-harness/ 。
- DSH 的身份与公开接口已核实（E1），因此客户端级身份状态为 `declared`，**不再是 `unknown`**；能力层按证据判定，未实测一律 `unverified`，绝不因旧规则被压低，也不得无证据抬高。
- 若未来核实不出真实产品身份或公开接口，则保持 `unverified`/`degraded`（不是「永不 validated」的硬禁），并写明证据缺口与升级路径。

### 8.3 核实清单（DSH 专用，逐项留证）

| 项 | 结论 | 来源 |
|---|---|---|
| 真实产品身份 | DeepSeek Harness（DeepSeek 官方，MIT，TypeScript） | deepseek.com/harness ；github.com/deepseek-ai/deepseek-harness |
| 官方文档 | 存在，含 CLI/插件/配置/SDK/ACP 文档 | deepseek-harness.github.io/deepseek-harness/ |
| CLI 可执行 | `dsh`（`npx @deepseek-ai/dsh web`）；profiles `web/headless/sdk/sdk-minimal/acp` | 官方 README + docs/cli-help |
| 配置载体 | Cordis `cordis.yml`；用户 patch `$DSH_HOME/cordis.patch.yml`、`$DSH_HOME/profiles/<name>/cordis.patch.yml`；`dsh --dump-config` | docs/architecture + docs/user/guide/mcp-memory |
| MCP 接口 | DSH 是 MCP **客户端**：`@deepseek-ai/dsh-mcp-client`，暴露 `mcp__<serverName>__<tool>` | docs/user/guide/mcp-memory + docs/tool-catalog |
| 其他公开接口 | ACP stdio（`dsh --profile acp`）、SDK stdio JSON-RPC（`dsh --profile sdk`）、插件 API（`dsh plugin`、`plugin.json`、`dsh-plugin` topic） | docs/cli-help + docs/architecture |
| 凭证 | `$DSH_HOME/.credentials.yaml`（write-only，报告不得回显） | docs/user/guide/providers |
| 本机可执行/配置路径 | 本机未发现 `dsh` 可执行与 `$DSH_HOME`（**待核实**，不在本机实测） | 本机 PATH/目录只读存在性核对（2026-11-23） |

### 8.4 DSH 的 ANO 接入与升级/降级路径

- **接入路径**：ANO 作为 MCP server 由 DSH 的 MCP 客户端加载——在 DSH 的 Cordis 配置层添加 `ano` stdio 行（`mcp__ano__*`），配置载体为 `cordis.patch.yml`。`configured` 层验证该配置行存在且路径可达；`mcp`/`tools`/`brief` 验证 ANO 包本身（与 DSH 无关的独立 stdio 握手）。
- **不混同接口**：DSH 的 ACP/SDK 握手是 DSH 自身接口，**不得**当作 ANO 的 MCP 七工具验证，也不得把 ACP 成功放大为 MCP 支持。
- **升级路径**：取得公开接口证据（E1）后，经本机命令实测（E3）与真实 stdio 握手（E4），按 §4.5 逐层升级；`validated` 仅在四要素齐全时允许。
- **降级路径**：若某层无公开接口或本机不可达，该层 `unavailable`/`degraded`，并在 `limitations` 写明缺口；DSH 的 `unknown` 状态不再作为永久禁饵。

### 8.5 `cloudcode` 明文

`cloudcode` 仅为 `claude-code` 的别名，不新增 `ClientId`，不改变 M11 的配置/规则语义；报告在 `clientId='claude-code'` 下以 `alias='cloudcode'` 标注。

## 9. 决定七：MCP 工具不变与适配器边界

- MCP 工具数量恒为 7，与 `docs/generated/tools.md` 一致；客户端能力**不**通过新增工具暴露。
- 客户端能力暴露途径仅限：`ano doctor clients` / `ano doctor client <id>`（只读报告）、`ano clients install|restore`（显式授权写）、以及既有 `brief`/`track` 的接管投影。
- 适配器不得执行配置内容：禁止 `eval`、`new Function`、`child_process` 执行配置中出现的命令、动态 `import()` 配置指向的模块。
- 不得放大的声明（测试与文档均需做否定断言）：
  1. stdio 握手成功不得表述为「已配置」或「已接管」。
  2. MCP 七工具可用不得表述为「DAG 已接管」「历史已支持」「输出可拦截」。
  3. `brief` 成功不得表述为「宿主自动启动」或「自动批准」。
  4. 合成 fixture 通过不得表述为「真实客户端兼容」。
  5. `unknown`/`unverified` 客户端不得表述为「已支持」或「已验证」。

## 10. 决定八：文件所有权与别名语义（T-092~T-097 并行边界）

### 10.1 文件所有权（与 M12 任务簿一致）

| 任务 | files（任务簿原样） | 独占职责 / 接口契约 |
|---|---|---|
| T-091 | `docs/adr/ADR-008-full-client-catalog.md`、`docs/client-catalog.md` | 本契约与目录；已完成 |
| T-092 | `src/clients/types.ts`、`src/clients/registry.ts`、`test/unit/client-doctor.test.ts` | **类型与注册表基座**。扩展 `ClientId`/别名/descriptor 到 21 工具 + 既有；保持 M11 既有 id 与证据语义；未验证不升级；未知 id 拒绝。 |
| T-093 | `src/clients/github-copilot.ts`、`src/clients/zed.ts`、`src/clients/jetbrains-ai.ts`、`src/clients/tabnine.ts`、`test/unit/client-ide-coding.test.ts`、`docs/evidence/client-ide-coding.md` | **IDE/插件/CLI 组**。探测、配置/规则接管、插件/CLI 降级；不把代码补全冒充 Agent 接管。 |
| T-094 | `src/clients/trae.ts`、`src/clients/antigravity.ts`、`src/clients/replit-agent.ts`、`src/clients/codebuddy.ts`、`test/unit/client-cloud-ide.test.ts`、`docs/evidence/client-cloud-ide.md` | **云端/IDE 组**。核实本地/云端公开接口；云端能力不冒充本地控制；无接口给显式工作流。 |
| T-095 | `src/clients/cline.ts`、`src/clients/kilo-code.ts`、`src/clients/openclaw.ts`、`src/clients/hermes-agent.ts`、`test/unit/client-open-agents.test.ts`、`docs/evidence/client-open-agents.md` | **开源 Agent/IDE 组**。公开 MCP/规则/子任务接口；命令/API 不执行配置内容；能力分层。 |
| T-096 | `src/clients/amazon-q.ts`、`src/clients/codegeex.ts`、`src/clients/tongyi-lingma.ts`、`src/clients/comate.ts`、`test/unit/client-enterprise-ai.test.ts`、`docs/evidence/client-enterprise-ai.md` | **企业/中文 AI 组**。核实身份/接口/路径；云/IDE 权限与隐私限制；宣传不替代证据。 |
| T-097 | `src/clients/deepseek-harness.ts`、`src/clients/unknown.ts`、`test/unit/client-deepseek-harness.test.ts`、`docs/evidence/client-deepseek-harness.md` | **DSH 语义变更换轨**。实现 `dsh` 别名映射与证据驱动判定；`unknown.ts` 移除永久禁令、改为中间状态；不猜私有路径或格式。 |

### 10.2 并行接口边界（实现者必读）

- **类型归属**：`src/clients/types.ts` 拥有全部客户端契约类型；适配器只实现，不改类型。若需扩展类型，先改 T-092。
- **注册表独占**：`registry.ts` 独占注册与校验；适配器不得自行注册或自行决定 `ClientId`。
- **配置写独占**：`config.ts` / `install.ts` 独占配置读写；适配器只声明 `configTargets`。
- **unknown 语义**：`unknown.ts` 由 T-097 独占改造；其他组不得各自实现 unknown 逻辑。
- **证据文档**：`docs/evidence/client-*.md` 由对应组独占；`docs/client-catalog.md` 由 T-091 拥有，T-102 收口。
- **共享文件冲突**：未声明的共享文件一律串行；发现冲突立即停派并对账（`scripts/orchestration/protocol.md`）。

### 10.3 别名语义

- `cloudcode` → `claude-code`（M11 既有，不变）。
- `dsh` → `deepseek-harness`（M12 新增别名；`dsh` 不再是独立未知身份）。
- 其余 19 工具无 `ClientId` 别名；CLI 命令别名（如 `cbc`、`comatecli`、`agy`、`kiro-cli`）不是客户端别名。
- 别名解析统一走 `resolveClientId`；未知 id 由 registry 拒绝（`UnknownClientError`）。
- 别名不改变配置路径、规则格式或能力语义。

## 11. 测试与验收判据

- **21 工具身份**：每个工具有稳定 id/别名/官方来源/形态/接口载体；registry 可寻址；未知 id 拒绝；旧客户端/报告 schema 兼容。
- **九层与 verdict**：§4.5 规则逐条可复现；未实测不得 `validated`；`unknown` 不再是永久禁令；无歧义用例（同输入同输出）。
- **五列独立报告**：MCP/项目接管/DAG/历史/输出拦截分别报告；任一层成功不代替其他层；`coreVerdict='validated'` 不放大为完整接管。
- **降级路径**：无公开接口/云端-only/IDE 插件-only 明确降级，绝不 `validated`；不生成无效 MCP 配置。
- **证据分级**：E0 宣传不作接口证据；E2 存在性不作实测；E3/E4 才可升级；合成 fixture 不升级。
- **DSH 专项**：`dsh` 别名映射到 `deepseek-harness`；身份为 `declared`；不再使用永久 `unknown` 规则；核实清单逐项可复核；不猜私有路径或格式。
- **硬边界**：路径穿越/命令注入/未授权写/秘密采集/执行配置内容全部拒绝；七工具数量断言。
- **授权/备份/恢复**：默认 dry-run 零写；缺授权零写；并发漂移拒绝；失败恢复；保留其他服务与未知字段。
- **回归**：ZCode/Connect/M8/M9/M10 既有测试与 `verify:zcode` 通过；`docs/generated/tools.md` 仍为 7 工具。
- **兼容矩阵**：`docs/evidence/client-support-matrix.json` schema 稳定并扩展；`docs/client-catalog.md` 逐格有证据要求与初始 `unverified` 标注。

## 12. 与 ADR-006/007 的边界对账

- **ADR-006**：授权模型、备份/hash 绑定、七工具不变、宿主能力 `degraded` 与「不把 ANO 侧切换表述为宿主已强制」沿用；客户端配置安装与项目接管仍是两个独立动作。
- **ADR-007**：九层能力、verdict 三值、四接口、身份来源、失败语义沿用；**唯一语义变更**是 §8 的 DSH/`unknown` 规则——废弃「永远不得 `validated`」硬禁，改为证据驱动；`cloudcode=claude-code` 不变。
- **ADR-003/004/005**：不把客户端声明升级为已验证事实；备份/恢复复用校验模式；记忆事件语义不变，客户端历史不进入 Gate 完成通道。

## 13. 后果

- 实现者获得 21 工具的稳定身份、形态、接口载体、初始 verdict 与降级路径，T-092~T-097 可并行；验收判据可预先编写。
- 代价：需要为每个工具补齐只读探测、配置候选、证据文档与降级路径；「全适配」被收紧为「可执行接入路径或明确降级」，初始全部 `unverified`。
- DSH 从「永久未知」升级为「证据驱动的真实产品」，是 M12 相对 M11 的唯一语义变更；`pi`/`opencode`/`zcode` 作为既有项保留，不删除、不改名。
- 本 ADR 只固定语义与契约，不声称任何实现或测试已存在；实现完成后按第 11 节与 `docs/client-catalog.md` 验收。
