# 客户端兼容性矩阵与验收框架（M11 / MC-01~MC-06）

- 日期：2026-11-22
- 任务：T-079 / MC-01（M11）；下游 T-080~T-090
- 上游契约：`docs/adr/ADR-007-client-adapters.md`（语义与硬边界以 ADR 为准；本文只给清单、矩阵、所有权与验收框架）
- 状态口径：**初始全部 `unverified`**。本表不读取任何真实客户端配置文件内容；路径均为探测候选，实测前不得升级为 `validated`。
- 术语：能力九层 `detected / configured / mcp / tools / brief / instructions / orchestration / history / output-interception`；verdict 三值 `validated / degraded / unavailable`（`unknown` 仅用于客户端身份状态，见 §4）。

## M23 Python 能力对客户端矩阵的影响

M23 只扩展现有 `verify`/`explore`/`brief` 的内部证据与结构能力，**MCP 仍恰为 7 个工具**，不新增客户端、不改变任何客户端的 `validated/degraded/unavailable` 单元格。Python 当前最多为 `supported-fixture-only`，真实项目验收未完成；不得把 pytest 或 Python 夹具证据写成任一客户端已支持 Python。

## 1. 客户端清单（身份来源 / 配置位置 / 初始假设）

| 客户端 | ClientId | 身份识别来源（只读） | 配置位置（候选公开路径，实测前 `unverified`） | 能力层初始假设 |
|---|---|---|---|---|
| Claude Code | `claude-code` | `claude` 可执行文件；`~/.claude/` 目录；项目 `CLAUDE.md` | `~/.claude/settings.json`、`~/.claude.json`（`mcpServers`）、项目 `.mcp.json`；规则 `CLAUDE.md` | 全层 `unverified` |
| cloudcode | `claude-code`（`alias='cloudcode'`） | **按 Claude Code 处理**：同 `claude-code` 来源 | 同 Claude Code | 全层 `unverified` |
| Codex | `codex` | `codex` 可执行文件；`~/.codex/` 目录；`AGENTS.md` | `~/.codex/config.toml`（`[mcp_servers.*]`）；规则 `AGENTS.md` | 全层 `unverified` |
| Cursor | `cursor` | `cursor` 可执行文件；`~/.cursor/` 目录；`.cursor/rules` | `~/.cursor/mcp.json`、项目 `.cursor/mcp.json`；规则 `.cursorrules`、`.cursor/rules/*.mdc` | 全层 `unverified` |
| OpenCode | `opencode` | `opencode` 可执行文件；`~/.config/opencode/`；`AGENTS.md` | `~/.config/opencode/opencode.json`、`opencode.json`、`.opencode.json`；规则 `AGENTS.md` | 全层 `unverified` |
| Qoder | `qoder` | 公开接口待核实（T-084）；不假设配置路径 | 待核实（仅基于真实公开接口） | 全层 `unverified`；实测与配置事实分开记录 |
| DSH | `dsh` | **身份或接口不明确 → `unknown`**；只探测已声明公开来源 | 不声明（不猜路径） | 全层 `unavailable`；`status='unknown'`，上限 `degraded`/`unverified` |
| Pi | `pi` | **身份或接口不明确 → `unknown`**；只探测已声明公开来源 | 不声明（不猜路径） | 全层 `unavailable`；`status='unknown'`，上限 `degraded`/`unverified` |
| ZCode | `zcode` | `~/.zcode/cli/config.json`（生效）、`~/.zcode/v2/config.json`（遗留）、工作区 `.zcode/config.json`、`AGENTS.md` | 用户级/工作区 MCP 注册；规则 `AGENTS.md` | 全层 `unverified`（本机事实已由 T-055 证明宿主层 `degraded`，但客户端契约层仍需实测） |

- 身份来源只能来自：可执行文件探测、进程枚举、环境变量、公开配置文件路径、包管理痕迹。不得从名称相似性推断路径。
- 配置位置以官方公开文档为准；T-082/T-083/T-084 必须用真实公开文档或本机事实核实，未核实前一律 `unverified`。
- 本表不读取真实客户端配置文件内容；探测实现只做只读解析，且不得回显秘密。

## 2. 证据代码（判定证据要求的最小集）

| 代码 | 层 | 最小证据 |
|---|---|---|
| E1 | `detected` | 探测来源 + 可执行路径或版本 + `detectedAt`；找不到即 `unavailable` |
| E2 | `configured` | 配置路径 + 作用域（user/project/workspace）+ 键 + 解析路径可达；条目存在但路径失效为 `degraded` |
| E3 | `mcp` | 真实 stdio `initialize` 响应 + `protocolVersion` + `serverInfo` + 耗时 |
| E4 | `tools` | `tools/list` 恰 7 个且与 `docs/generated/tools.md` 一致（缺 `brief`/`track` 判 `degraded`） |
| E5 | `brief` | `brief` 返回合法 schema + 项目上下文；接管项目含主写/角色/`hostCapability` 投影 |
| E6 | `instructions` | 规则文件路径 + 格式版本 + 是否已含受管段（只读探测，写入需授权） |
| E7 | `orchestration` | 公开派发接口文档或显式工作流映射 + 实测；无公开接口 → `degraded`（主控 harness 降级） |
| E8 | `history` | 授权样本或公开格式 + 解析条数 + 隐私处理；合成 fixture 不升级本层 |
| E9 | `output-interception` | 公开拦截接口枚举或配置扫描；hooks 为工具级闸门，不算本层 |

每层证据必须含**时间、版本、来源、限制**四要素；缺任一项不得判 `validated`。

## 3. 验收矩阵（客户端 × 能力层）

### 3.1 核心五层（决定 `coreVerdict`）

| 客户端 | E1 detected | E2 configured | E3 mcp | E4 tools | E5 brief |
|---|---|---|---|---|---|
| Claude Code / cloudcode | `which claude` + `~/.claude/` 存在性 | `~/.claude.json` 或 `.mcp.json` 含 `ano` 条目且路径可达 | 真实 spawn `claude` MCP 包装，initialize 成功 | `tools/list=7` 一致 | `brief` 含 `CLAUDE.md` 项目上下文 |
| Codex | `which codex` + `~/.codex/` | `~/.codex/config.toml` 含 `[mcp_servers.ano]` | 真实 stdio initialize | 同上 | `brief` 含 `AGENTS.md` 上下文 |
| Cursor | `which cursor` + `~/.cursor/` | `~/.cursor/mcp.json` 或 `.cursor/mcp.json` 含 `ano` | 同上 | 同上 | `brief` 含 `.cursor/rules` 上下文 |
| OpenCode | `which opencode` + `~/.config/opencode/` | `opencode.json` 含 `mcp.ano` | 同上 | 同上 | `brief` 含 `AGENTS.md` 上下文 |
| Qoder | 仅已声明公开来源（待核实） | 待核实，不假设 | 待核实 | 待核实 | 待核实 |
| DSH | 只探测不猜 | 不声明 | 不猜测接口 | 不猜测接口 | 不猜测接口 |
| Pi | 只探测不猜 | 不声明 | 不猜测接口 | 不猜测接口 | 不猜测接口 |
| ZCode | `~/.zcode/cli/config.json` + 进程/env | 用户级或工作区 `mcp.servers.ano` 路径可达 | 真实 stdio（T-055 已验证七工具，需复测） | `tools/list=7` | `brief` 含接管投影与 `hostCapability=degraded` |

### 3.2 扩展四层（单独报告，不参与 `coreVerdict`）

| 客户端 | E6 instructions | E7 orchestration | E8 history | E9 output-interception |
|---|---|---|---|---|
| Claude Code / cloudcode | `CLAUDE.md` 识别 + 受管段探测 | 公开子代理/技能接口；无则 `explicit-workflow` 降级 | 需授权样本或公开格式；否则 `unavailable` | 无公开接口 → `unavailable` |
| Codex | `AGENTS.md` 识别 | 同上 | 同上 | 同上 |
| Cursor | `.cursorrules` / `.cursor/rules/*.mdc` 识别 | 同上 | 同上 | 同上 |
| OpenCode | `AGENTS.md` / 指令配置识别 | 同上 | 同上 | 同上 |
| Qoder | 待核实（不假设规则文件） | 待核实（仅公开接口） | 待核实（不编造 parser） | 待核实 |
| DSH | 不探测（身份未知） | 不探测 | 不探测 | 不探测 |
| Pi | 不探测（身份未知） | 不探测 | 不探测 | 不探测 |
| ZCode | `AGENTS.md` 受管段（M10 已验证机制，客户端层复测） | M9 显式调度器/`--plan` dry-run；不宣称自动派发 | 需授权样本；合成 fixture 不升级 | T-055 已证明 `unavailable`（hooks 为工具级闸门） |

### 3.3 判定规则（与 ADR-007 §4 一致）

| 证据情形 | verdict | evidence |
|---|---|---|
| 未安装 / 无该机制 / 前置不成立 / 身份未知 | `unavailable` | `absent` |
| 已安装未配置 | `degraded` | `absent` |
| 已配置未实测 | `degraded` | `configured`（`unverified`） |
| 仅公开文档/初始假设 | `degraded` | `assumed` |
| 实测成功但部分缺失 | `degraded` | `measured` |
| 实测成功且完整、四要素齐全 | `validated` | `measured` |

- 核心链路取五层最弱值为 `coreVerdict`；扩展四层单列并进入 `limitations`。
- **不得放大**：`coreVerdict='validated'` 只表示「ANO 包可被发现、配置并调用七工具」，不表示规则已接管、DAG 已接管、历史已支持或输出可拦截。

## 4. DSH / Pi 的 unknown 处理（明文）

- DSH、Pi 的**身份或接口不明确**，客户端级 `status='unknown'`。
- 处理方式：**只探测不猜接口**。只允许探测已声明的公开来源；不声明配置路径、不猜可执行名、不猜规则文件、不伪造适配器。
- verdict 上限：所有能力层默认 `unavailable`；若未来取得公开接口证据，最高只能判 `degraded` 且 `evidence='unverified'`，**永远不得达到 `validated`**（在身份明确之前）。
- 报告必须列出「缺什么才能升级」：明确身份来源、公开配置格式、公开派发/历史接口；缺一即保持 `unknown`。
- 测试要求：DSH/Pi 用例断言「不崩溃、不伪造适配、不猜路径、不读取未授权目录」。

## 5. 文件所有权与接口契约（T-080~T-084 预留）

下表 files 与 M11 任务簿一致；共享文件按依赖串行，不并发写。所有实现必须满足 ADR-007 §5 的 `ClientAdapter` 四接口与 §2 硬边界。

| 任务 | files（M11 任务簿原样） | 独占职责 / 接口契约 |
|---|---|---|
| T-079 | `docs/adr/ADR-007-client-adapters.md`、`docs/client-compatibility.md` | 本契约；已完成 |
| T-080 | `src/clients/types.ts`、`src/clients/registry.ts`、`src/clients/doctor.ts`、`test/unit/client-doctor.test.ts` | **类型与注册表基座**。`types.ts` 定义 `ClientId`、九层、`ClientVerdict`、`ClientEvidence`、`ClientAdapter`、`ClientReport`、`IsolatedError`、授权引用；`registry.ts` 定义注册/校验（未知客户端拒绝）与单客户端失败隔离；`doctor.ts` 产出统一报告（证据/时间/版本/来源/限制）。不依赖具体适配器。 |
| T-081 | `src/clients/config.ts`、`src/clients/install.ts`、`test/unit/client-config.test.ts` | **配置读写与授权**。`config.ts` 定位/解析/备份/hash 绑定/合并（保留其他服务与未知字段）；`install.ts` 实现 `config()` 的 dry-run/apply、原子安装、幂等、恢复。默认 dry-run；缺授权零写；并发漂移拒绝。 |
| T-082 | `src/clients/claude-code.ts`、`src/clients/codex.ts`、`test/unit/client-claude-code.test.ts`、`test/unit/client-codex.test.ts`、`docs/evidence/client-claude-codex.md` | **Claude Code（含 cloudcode）/ Codex 适配器**。实现 `detect/inspect/config/verify`；按真实公开格式生成配置；`CLAUDE.md`/`AGENTS.md` 规则接管检测独立验证；未安装/未知版本不猜测。 |
| T-083 | `src/clients/cursor.ts`、`src/clients/opencode.ts`、`test/unit/client-cursor.test.ts`、`test/unit/client-opencode.test.ts`、`docs/evidence/client-cursor-opencode.md` | **Cursor / OpenCode 适配器**。同上；`.cursorrules`/`.cursor/rules`、OpenCode 指令机制按真实公开格式；已有配置不覆盖；不支持 DAG/拦截时明确 `degraded`。 |
| T-084 | `src/clients/qoder.ts`、`src/clients/unknown.ts`、`test/unit/client-unknown.test.ts`、`docs/evidence/client-unknowns.md` | **Qoder / DSH / Pi 与扩展入口**。`unknown.ts` 实现 `unknown` 标准降级（不崩溃、不伪造、不猜路径）与声明式适配器扩展校验（第三方扩展必须提供探测/能力/验证，不默认信任）；Qoder 仅基于真实公开接口，实测与配置事实分开。 |
| T-085 | `src/surface/cli.ts`、`src/surface/service.ts`、`src/surface/tool-catalog.ts`、`src/index.ts`、`test/integration/cli.test.ts`、`test/integration/mcp.test.ts`、`docs/generated/tools.md` | **CLI 与严格分支**（在其后串行）。`ano doctor clients` / `doctor client <id>` / `clients install|restore`；默认 dry-run；MCP 仍七工具。 |

### 5.1 并行接口边界（实现者必读）

- **类型归属**：`src/clients/types.ts` 拥有全部客户端契约类型；适配器只实现，不改类型。若需扩展类型，先改 T-080。
- **注册表独占**：`registry.ts` 独占注册与校验；适配器不得自行注册或自行决定 ClientId。
- **配置写独占**：`config.ts` / `install.ts` 独占配置读写；适配器只声明 `configTargets`（路径/格式/键），不得自行写文件。
- **Surface 串行**：`src/surface/cli.ts` / `service.ts` / `tool-catalog.ts` 由 T-085 在其后接入；T-082~T-084 不得修改 Surface。
- **证据文档**：`docs/evidence/client-*.md` 由对应适配器任务独占；`docs/client-compatibility.md` 由 T-087 更新（历史层）与 T-090 收口。
- **共享文件冲突**：未声明的共享文件一律串行；发现冲突立即停派并对账（`scripts/orchestration/protocol.md`）。

## 6. 验收分层（模拟 / 隔离 / 实测）

| 层 | 范围 | 必须产出 | 不得代替 |
|---|---|---|---|
| 模拟 | 类型/注册表/dry-run/verdict 规则/失败隔离 | 确定性 fixture，零真实配置写入；§3 判定规则逐条可复现 | 不证明真实客户端兼容 |
| 隔离 | 合成配置根 + 临时目录 + 注入式 MCP client | 备份/hash、合并保留、原子安装、恢复、路径逃逸/并发漂移拒绝 | 不证明真实客户端存在或已配置 |
| 实测 | 用户明确授权的客户端与项目 | 真实 `detected/configured/mcp/tools/brief` 证据（时间/版本/来源） | 不自动读取真实会话或秘密 |

- 任一层成功不能代替其他层；合成 fixture 通过不等于真实兼容。
- 实测需用户明确授权；未授权时对应单元格保持 `unverified` 或 `unavailable`，不得伪造。

## 7. 已知限制（不得虚报）

1. 本表初始全部 `unverified`；路径为探测候选，需 T-082/T-083/T-084 用真实公开文档或本机事实核实。
2. DSH/Pi 身份或接口不明确，保持 `unknown`，只探测不猜，永不 `validated`。
3. `history` 层需授权样本或公开格式；无样本时保持 `unavailable`，合成 fixture 不升级。
4. `output-interception` 层：ZCode 已由 T-055 证明 `unavailable`（hooks 为工具级闸门）；其他客户端无公开接口时同样 `unavailable`。
5. `orchestration` 层：无公开派发接口时降级为主控 harness/显式工作流，不复制不存在的自动化。
6. 本框架不读取真实客户端配置文件内容；不修改用户级配置；不把 MCP 成功放大为完整接管。
7. 掉电级持久性、跨 root 授权续接、真实两进程配置竞争未验证（沿用 M10 结论）。

## 8. 交叉引用

- `docs/adr/ADR-007-client-adapters.md`：九层契约、verdict 三值、四接口、授权/备份、硬边界。
- `docs/evidence/host-capability-investigation.md`：ZCode 宿主七层调查（T-055）。
- `docs/evidence/takeover-host.md`：接管宿主能力降级证据（T-073）。
- `docs/takeover.md` §6/§8：M10 文件所有权与验收分层。
- `docs/limitations.md`：未验证项如实单列风格。
- `docs/anchor-probe-benchmark.md`：不以局部证据宣称端到端口径先例。

## 9. 会话历史适配与隐私边界（T-087 / MC-09）

- 日期：2026-11-23；任务：T-087 / MC-09（M11）；证据：`docs/evidence/client-history.md`、`test/integration/client-history.test.ts`
- 口径：`history` 为扩展层（E8），不参与 `coreVerdict`；无授权样本/公开格式时固定 `unavailable`，合成 fixture 不升级。

### 9.1 真实样本与格式状态

| 项 | 状态 |
|---|---|
| 真实会话样本 | **无**（`[数据缺失]`）；未读取 `~/.claude/projects`、`~/.codex/sessions`、`~/.cursor` 等真实会话目录 |
| 公开会话格式 | **未知**（`unverified`）；未编造 parser |
| 八客户端 history | 全部 `unavailable`；DSH/Pi 另为客户端 `status='unknown'`，永不 `validated` |

### 9.2 授权采样契约

- 采样必须显式授权：`authorization.scope` 含 `history` + `authorization.sampleRoot`；不得从环境变量、默认值或路径存在性推断授权。
- 采样根必须存在且为目录；样本路径必须位于授权根内；软链路径拒绝；真实会话存储路径拒绝。
- 仅解析已知格式（`.json` / `.jsonl`）；未知扩展名、损坏 JSON、空样本一律拒绝，不编造 parser。
- fail-closed：缺授权 / 作用域错误 / 路径无效 / 格式未知 / 路径逃逸 / 软链 / 真实会话路径 → 零读取（不得读取内容）。

### 9.3 敏感信息最小化

- 读取输出只保留结构元数据：条数（`recordCount`）、时间范围（`timeRange`）、格式标识（`format`）、合成标记（`synthetic`）。
- 不得输出会话内容、消息、提示词、密钥/令牌等秘密字段；测试对 content/message/api_key/token/prompt/text 标记做零出现断言。

### 9.4 合成 fixture 不升级与防撒谎

- 合成 fixture 必须显式标注 `synthetic: true`；只证明机制，不证明真实客户端兼容。
- `history` 仅当报告携带已授权真实样本（`sampleAuthorized=true`、`formatVersion`/`source` 非空）且样本非合成时才允许维持 `validated`/`measured`；否则降级为 `degraded`/`assumed`。
- 撒谎 adapter 自报 `validated` 必须被降级：外部 adapter 复用 `registerExternalAdapter` 的 `E_EXTERNAL_VERDICT_CAPPED` 封顶；注入式 adapter 由 `history` 边界门降级。测试对两者均做断言。

### 9.5 未验证项

1. 真实会话样本读取未执行（`[数据缺失]`）。
2. 公开会话格式未核实（`unverified`），parser 未实现。
3. 真实客户端历史兼容排序未执行。
4. 客户端历史不接入 `memory.*` / Gate 完成通道（ADR-007 §9），未验证集成。
5. 跨 root 授权续接、移动目录身份续接、掉电持久性未验证（沿用 M10 结论）。

> 本节只覆盖 `history` 层；支持矩阵最终收口由 T-090 完成。

## 10. 集成实测结论（T-089 / MC-11，2026-11-23）

- 日期：2026-11-23；任务：T-089 / MC-11（M11 集成门禁，独占全量质量矩阵）
- 性质：只读实测 + 本机事实 + 文档指针；未读取真实客户端配置内容，未修改用户级配置、`.pm/`、`.ano/`、真实客户端配置。
- 口径：以 ADR-007 §4 判定规则为准；`unknown` 仅用于客户端身份状态；合成 fixture 不升级任何单元格；任一层成功不代替其他层。

### 10.1 M11 十二任务状态（实测时点）

| 任务 | 标题 | 状态 |
|---|---|---|
| T-079 | MC-01 定义多客户端能力契约与自适应降级协议 | done |
| T-080 | MC-02 实现客户端探测、真实 MCP 验证与统一报告 | done |
| T-081 | MC-03 实现授权配置备份、原子安装与恢复 | done |
| T-082 | MC-04 适配 Claude Code 与 Codex MCP 和项目规则 | done |
| T-083 | MC-05 适配 Cursor 与 OpenCode MCP 和项目规则 | done |
| T-084 | MC-06 探测 Qoder、DSH、Pi 并定义未知客户端扩展入口 | done |
| T-085 | MC-07 实现 ano doctor clients/client 与授权接入 CLI | done |
| T-086 | MC-08 验证多客户端项目接管与 DAG 能力映射 | done |
| T-087 | MC-09 验证真实会话历史适配与隐私边界 | done |
| T-088 | MC-10 多客户端配置与能力边界红队 | done |
| T-089 | MC-11 M11 多客户端集成、实测与质量门禁 | in_progress（本任务） |
| T-090 | MC-12 M11 支持矩阵、文档、审计与最终验收 | backlog（待主控派发） |

- 进度：10/12 done；T-089 收口后主控核验，T-090 做终对账与最终收口。

### 10.2 真实客户端结果逐条留证（本机实测 + 文档指针）

本机环境：win32 10.0.19041 x64，Node v24.14.0。探测命令与存在性结果（2026-11-23）：

| 客户端 | 本机事实（可执行 / 目录） | 能力结论（核心五层） | 扩展层 | 证据指针 |
|---|---|---|---|---|
| ZCode | `~/.zcode/cli/config.json` 唯一登记 `ano`；工作区 `.zcode/config.json` 保留空 `mcp.servers` 去重继承；M8 真实会话可见 `mcp__ano__*` 7 工具 | `detected/configured/mcp/tools/brief = validated`（限「ANO 包可配置并调用七工具」） | `instructions=degraded`（受管段只读）、`orchestration=degraded`（显式工作流）、`history=unavailable`、`output-interception=unavailable`、`hostCapability=degraded` | `docs/evidence/host-capability-investigation.md` §2/§3、`docs/evidence/zcode-mcp.json`、`test/integration/mcp.test.ts`（9/9）、`test/integration/zcode-config.test.ts` |
| Claude Code（含 cloudcode） | `claude` 不在 PATH；`~/.claude/`、`~/.claude.json` 存在（仅存在性，未读内容） | `detected=degraded`（仅配置目录/文件，无 `executablePath`/`version`）；`configured` 未实测（unverified）；`mcp/tools/brief=unavailable` | `instructions=degraded`、`orchestration=degraded`、`history=unavailable`、`output-interception=unavailable` | `docs/evidence/client-claude-codex.md` §4/§5 |
| Codex | `codex` 不在 PATH；`~/.codex/`、`~/.codex/config.toml` 存在（未读内容） | 同 Claude Code；TOML v1 只读 | 同上 | `docs/evidence/client-claude-codex.md` §4/§5 |
| Cursor | `cursor` 不在 PATH；`~/.cursor`、`~/.cursor/mcp.json` 均 missing | `detected=unavailable`（前置不成立）；全层 `unavailable` | 全层 `unavailable` | `docs/evidence/client-cursor-opencode.md` §3 |
| OpenCode | `opencode` 不在 PATH；`~/.config/opencode` missing | `detected=unavailable`；全层 `unavailable` | 全层 `unavailable` | `docs/evidence/client-cursor-opencode.md` §3 |
| Qoder | `qoder` 不在 PATH；`~/.qoder/` 存在（T-084 实测 `~/.qoder/settings.json` 顶层含 `mcpServers`、无 `ano`，未读值） | `detected=degraded`（无版本）；`configured` 未实测（unverified）；`mcp/tools/brief=unavailable` | `history/output-interception=unavailable` | `docs/evidence/client-unknowns.md` §2.2/§2.3 |
| DSH | 身份或接口不明确；不在 PATH | 客户端 `status='unknown'`；全层 `unavailable`，永不 `validated` | 全层 `unavailable` | `docs/evidence/client-unknowns.md` §3 |
| Pi | 身份或接口不明确；不在 PATH | 客户端 `status='unknown'`；全层 `unavailable`，永不 `validated` | 全层 `unavailable` | `docs/evidence/client-unknowns.md` §3 |

**未安装清单（本机 PATH 事实，2026-11-23）**：`claude`、`codex`、`cursor`、`opencode`、`qoder` 均 `NOT_FOUND`；`~/.cursor` 与 `~/.config/opencode` 缺失；`~/.claude`、`~/.codex`、`~/.qoder` 仅目录存在（未读配置内容）。因此除 ZCode 外没有任何真实客户端握手，`mcp/tools/brief` 的真实兼容结论为 `unverified`/`unavailable`，不将合成 fixture 或目录存在性当作真实兼容。

### 10.3 F-01 / O-01 修复与回归证据

| 项 | 症状 | 修法 | 回归证据 |
|---|---|---|---|
| F-01（真实缺陷，库级原型污染） | `src/clients/config.ts` 的 `mergeServerEntry` 以裸属性访问导航 `serverPath`；`serverPath:['__proto__']` 时 `planClientConfig`/`applyClientConfig` 会写穿到 `Object.prototype`（独立进程探针实证） | 新增 `assertSafeServerPath`，在 `assertSafeTargetPath` 与 `mergeServerEntry` 双重拒绝 `__proto__`/`prototype`/`constructor`；merge 改用 `Object.hasOwn` 导航与 `Object.create(null)` 建容器 | `test/redteam/client-adapters-boundary.test.ts` T-089/01（红队 11/11→12/12）；独立进程探针：`THREW code=CLIENT_CONFIG_PATH msg=Refusing reserved serverPath segment: __proto__`、`Object.prototype.ano=undefined`、`hasOwn=false` |
| O-01（低危硬化） | `src/surface/service.ts` 的 `resolveClientTarget` 对 `--config-path` 覆写未拒敏感文件名 | 新增 `sensitiveConfigPathReason`，口径对齐 `src/connect/backup.ts`（ADR-006 §2.5），对显式覆写拒绝 `.env*`/secrets/credentials/token/private-key 名与 `id_rsa`/`id_ed25519`/key material | `test/integration/cli.test.ts`「rejects unknown/unsupported clients and invalid paths」新增敏感路径断言（14/14）；`resolveClientTarget` 返回 `ok:false`、CLI exit 2、零写 |

### 10.4 集成一致性审查（T-085 收口后）

- 授权 statement/env 注入覆盖：CLI `clients install|restore` 经 `createClientAuthorization` 生成含 `statement` 的完整凭证，`clientInstallSurface`/`clientRestoreSurface` 注入 `home`/`root`/`configPath`；适配器 `config()` 默认 dry-run，写路径唯一委托 `src/clients/config.ts`。
- 七工具不变：`src/surface/tool-catalog.ts` 仍为 `brief/explore/recall/track/note/verify/audit`；客户端能力只经 CLI 子命令与既有工具投影暴露，未新增第八工具。
- 只读探测：`doctor clients/client` 在隔离 root 字节不变；未读真实会话或秘密；`history` 固定 `unavailable`（无授权样本/公开格式）。
- 失败隔离：单客户端/adapter 抛错只影响该客户端，其余继续（红队 T-088/09）。

### 10.5 不放大声明

- ZCode 的 `coreVerdict='validated'` 只表示「ANO 包可被发现、配置并调用七工具」，不表示项目规则已接管、DAG 已接管、历史已支持或输出可拦截。
- 未安装客户端（Claude Code/Codex/Cursor/OpenCode/Qoder）不写「已支持」；DSH/Pi 保持 `unknown`，永不 `validated`。
- 合成 fixture 只证明机制，不证明真实客户端兼容；真实会话样本缺失标 `[数据缺失]`，公开格式未知标 `unverified`。
- MCP 握手成功 ≠ `configured` ≠ 完整接管；`brief` 成功 ≠ 宿主自动启动/自动批准。

### 10.6 未验证项 / 移交 T-090

1. 除 ZCode 外无真实客户端安装，`configured/mcp/tools/brief` 真实兼容未实测。
2. 真实会话历史样本与公开格式未核实，`history` 全层 `unavailable`。
3. 输出拦截全客户端 `unavailable`（含 ZCode，T-055 已证明无公开接口）。
4. Cursor 官方文档本机不可达，其配置格式仍为 `assumed`；OpenCode 路径口径差异（registry/adapter 候选为 `opencode.json` 与 `.opencode.json`，官方文档为 `.opencode/opencode.json` 目录形式）**保留为限制**，不伪造结论（T-090 收口，见 §11.4）。
5. 跨 root 授权续接、移动目录身份续接、掉电持久性未验证（沿用 M10 结论）。
6. 全量质量矩阵报告路径/SHA-256/源码指纹/coverage 数字由 T-090 终对账复核（见 §11.4）。

## 11. 最终支持矩阵（T-090 / MC-12 收口，2026-11-23）

- 机器可读版本：`docs/evidence/client-support-matrix.json`（`schema=ano.client-support-matrix/1`）。
- 口径：以 ADR-007 §4 判定规则为准；`unknown` 仅用于客户端身份状态；合成 fixture 不升级任何单元格；任一层成功不代替其他层；不把 stdio 握手放大为完整接管。
- 实测时点：2026-11-23T01:57:27Z，win32 x64 / Node v24.14.0。数据来源：`ano doctor clients --json` 只读运行（§11.2）+ M11 五份证据报告 + 既有真实 stdio 证据（T-055、`test/integration/mcp.test.ts`、`docs/evidence/zcode-mcp.json`）。
- 本节为 M11 支持矩阵最终收口；§3 为初始契约（全部 `unverified`），§9 为 history 口径，§10 为 T-089 集成实测，均不被本节改写。

### 11.1 五列真实状态（8 客户端）

| 客户端 | MCP | 规则接管 | DAG | 历史 | 输出拦截 |
|---|---|---|---|---|---|
| ZCode | `validated`（限可配置+七工具） | `degraded` | `degraded` | `unavailable` | `unavailable` |
| Claude Code / cloudcode | `unavailable` | `degraded` | `degraded` | `unavailable` | `unavailable` |
| Codex | `unavailable` | `degraded` | `degraded` | `unavailable` | `unavailable` |
| Cursor | `unavailable` | `unavailable` | `unavailable` | `unavailable` | `unavailable` |
| OpenCode | `unavailable` | `unavailable` | `unavailable` | `unavailable` | `unavailable` |
| Qoder | `unavailable` | `unavailable` | `unavailable` | `unavailable` | `unavailable` |
| DSH | `unavailable` | `unavailable` | `unavailable` | `unavailable` | `unavailable` |
| Pi | `unavailable` | `unavailable` | `unavailable` | `unavailable` | `unavailable` |

> **MCP 列口径统一（T-101）**：按 ADR-008 §4.6，MCP 列＝核心五层 `detected/configured/mcp/tools/brief` 的最弱值。M11 时期 Claude Code/Codex/Qoder 的 MCP 列曾记 `degraded`，但三者 `mcp/tools/brief` 均无真实 stdio 握手（`unavailable`），最弱值应为 `unavailable`；本表已统一，未握手不得记 `degraded`。

单元格口径（不得放大）：

- **MCP** = 核心五层 `detected/configured/mcp/tools/brief` 最弱值，只表示「ANO 包可被发现、配置并调用七工具」。ZCode 的 `validated` 依据 T-055 真实 stdio、`test/integration/mcp.test.ts` 9/9 与 `docs/evidence/zcode-mcp.json`，**不来自 `doctor` 的 `inspect`**；其余客户端 `mcp/tools/brief` 未做真实握手，按 §4.6 最弱值保持 `unavailable`（T-101 统一，见上）。
- **规则接管** = `instructions` 层，上限 `degraded`；受管段检测是只读事实，写入需显式授权。文件存在不等于客户端已读取，受管段存在不等于已安装/已强制。
- **DAG** = `orchestration` 层；客户端无公开派发接口时为 `degraded` + `mode='explicit-workflow'`，绝不 `validated`，也不把 CLI doctor 成功放大为客户端自动派发。
- **历史** = `history` 层；无授权样本或公开格式时 `unavailable`，合成 fixture 不升级。
- **输出拦截** = `output-interception` 层；全客户端 `unavailable`，工具级 hooks 不算输出拦截。

### 11.2 本机 `doctor clients` 逐层快照（2026-11-23T01:57:27Z）

| 客户端 | detected | configured | mcp | tools | brief | instructions | orchestration | history | output-interception | status / core |
|---|---|---|---|---|---|---|---|---|---|---|
| claude-code (cloudcode) | degraded | degraded | unavailable | unavailable | unavailable | degraded | degraded | unavailable | unavailable | degraded / unavailable |
| codex | degraded | degraded | unavailable | unavailable | unavailable | degraded | degraded | unavailable | unavailable | degraded / unavailable |
| cursor | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable / unavailable |
| opencode | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable / unavailable |
| qoder | degraded | degraded | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable | degraded / unavailable |
| dsh | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable | unknown / unavailable |
| pi | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable | unknown / unavailable |
| zcode | degraded | degraded | unavailable | unavailable | unavailable | degraded | degraded | unavailable | unavailable | degraded / unavailable |

- 与 §11.1 的差异仅在 ZCode 的 MCP 列：`inspect` 不做 stdio 握手，故纯 `doctor` 输出为 `unavailable`；§11.1 的 `validated` 来自独立真实 stdio 证据，两者不矛盾。
- Cursor/OpenCode 的 `instructions` 在本机为 `unavailable`（前置 `detected=unavailable`）；适配器机制上限为 `degraded`（合成环境已证），本机未安装故不显示。
- DSH/Pi 客户端级 `status='unknown'`，全层 `unavailable`，永不 `validated`。

### 11.3 写路径与授权边界

- 可写客户端：`claude-code`、`codex`、`cursor`、`opencode`。`qoder`（公开接口未核实）、`dsh`/`pi`（身份/接口不明）、`zcode`（宿主配置只读）如实拒绝写。
- 默认 `dry-run` 零写；`--confirm` 才写，且 `--scope` 必须含 `config,install`（`restore` 含 `restore`）。
- apply 前：内容哈希备份（`.ano/clients/backups/<clientId>/<id>/` + manifest）、`beforeHash` 漂移检查、原子合并（保留其他 MCP 服务与未知字段）、安装记录；失败回滚。
- `restore` 只接受 manifest 校验通过且 `targetPath` 绑定同一目标的备份。
- `codex` TOML v1 只读，即使授权齐备也拒绝写，只返回 dry-run。
- `--config-path` 显式覆写必须位于声明作用域内，敏感文件名/目录拒绝。

### 11.4 §10.6 收口与未验证项

- §10.6-4 收口：Cursor 配置格式维持 `assumed`（官方文档本机不可达），**不升级为 `measured`**；OpenCode 路径口径差异（registry/adapter 候选 `opencode.json`、`.opencode.json` vs 官方 `.opencode/opencode.json` 目录形式）**保留为限制**，适配器只在已存在文件间择优，不新增未声明来源、不伪造结论。
- §10.6-6 收口：T-090 独占全量质量矩阵报告见 §11.5；报告 SHA-256、源码指纹与 coverage 以该报告为准。
- 仍未验证：除 ZCode 外无真实客户端安装，`configured/mcp/tools/brief` 真实兼容未实测；真实会话样本 `[数据缺失]`、公开格式 `unverified`，history 全层 `unavailable`；输出拦截全客户端 `unavailable`；跨 root 授权续接、移动目录身份续接、掉电持久性未验证（沿用 M10 结论）。
- 不自动修改其他真实客户端配置；未授权时对应单元格保持 `unavailable`/`unverified`，不伪造。

### 11.5 质量门禁（T-090 独占全量矩阵）

- 报告：`.pm/quality-runs/quality-20261123-020552-482-0000.json`，SHA-256 `61e965888cb372a39fc43307aac2d86206212cf3c29c793d2bf4fd1131d05cb3`。
- 结果：`ok=true`、`reported_ok=true`、`source.stable=true`；typecheck/build/test/coverage 六项全 passed（root coverage 937/937），`npm run check-docs` 通过。
- 源码指纹：`sha256-tree-v1` = `061ca1fc26df17f5403f09ddb0974db52ab325d2e06a01bac6860f824b200b65`（383 文件 / 68786613 字节，before==after）。
- coverage：行 **95.15%** / 分支 **83.66%** / 函数 **95.27%**（937/937 通过）。
- 矩阵期间零源码编辑；本节数字于矩阵运行后回填，仅改文档字节、不改文件数，源码指纹会随之变化——主控按当前树重跑一次即可复核。

## 12. M12 全 24 工具最终支持矩阵（T-101 / CX-11 集成验收，2026-11-23）

- 机器可读版本：`docs/evidence/client-support-matrix.json`（`schema=ano.client-support-matrix/1`，24 客户端，T-101 复测回填 `generatedAt`/`liveVerification`）。
- 口径：ADR-008 §4.5/§4.6；MCP 列＝核心五层最弱值，未握手者一律 `unavailable`；规则接管上限 `degraded`；DAG 绝不 `validated`；历史无授权样本/公开格式 `unavailable`；输出拦截全 `unavailable`。
- 证据分层：`measured` 仅 ZCode（真实 stdio 七工具握手，T-101 复测 `tools=7`、`briefPhase=P7`）；`assumed` 为公开文档（E1）或本机存在性（E2），未运行命令/未握手；`absent` 为未安装/未探测到声明来源。**实测与推断分列，未安装/未实测不写成支持。**
- 「全适配」＝每个工具有可执行接入路径或明确降级，**不等于全部 `validated`**。

### 12.1 五列支持矩阵（实测时点 2026-11-23T05:52:12Z，win32 x64 / Node v24.14.0）

| 工具 | id | MCP | 规则接管 | DAG | 历史 | 输出拦截 | 路线 | 证据层 |
|---|---|---|---|---|---|---|---|---|
| Claude Code（cloudcode） | `claude-code` | unavailable | degraded | degraded | unavailable | unavailable | mcp | assumed |
| GitHub Copilot | `github-copilot` | unavailable | unavailable | degraded | unavailable | unavailable | mcp | absent |
| Cursor | `cursor` | unavailable | unavailable | unavailable | unavailable | unavailable | mcp | absent |
| OpenAI Codex | `codex` | unavailable | degraded | degraded | unavailable | unavailable | mcp | assumed |
| Trae | `trae` | unavailable | unavailable | unavailable | unavailable | unavailable | mcp | absent |
| Google Antigravity | `antigravity` | unavailable | unavailable | unavailable | unavailable | unavailable | mcp | absent |
| Replit Agent | `replit-agent` | unavailable | unavailable | degraded | unavailable | unavailable | skip | absent |
| Cline | `cline` | unavailable | unavailable | unavailable | unavailable | unavailable | mcp | absent |
| Kilo Code | `kilo-code` | unavailable | unavailable | unavailable | unavailable | unavailable | mcp | absent |
| Hermes Agent | `hermes-agent` | unavailable | unavailable | unavailable | unavailable | unavailable | rules | absent |
| OpenClaw | `openclaw` | unavailable | degraded | degraded | unavailable | unavailable | explicit-workflow | assumed |
| Zed | `zed` | unavailable | unavailable | degraded | unavailable | unavailable | mcp | absent |
| Tabnine | `tabnine` | unavailable | unavailable | degraded | unavailable | unavailable | skip | absent |
| Amazon Q（Kiro） | `amazon-q` | unavailable | unavailable | unavailable | unavailable | unavailable | mcp | absent |
| JetBrains AI | `jetbrains-ai` | unavailable | unavailable | degraded | unavailable | unavailable | skip | absent |
| CodeGeeX | `codegeex` | unavailable | unavailable | unavailable | unavailable | unavailable | skip | absent |
| 通义灵码（Qoder CN） | `tongyi-lingma` | unavailable | degraded | degraded | unavailable | unavailable | mcp | assumed |
| 文心快码 Comate | `comate` | unavailable | unavailable | unavailable | unavailable | unavailable | mcp | absent |
| Qoder（国际版） | `qoder` | unavailable | unavailable | unavailable | unavailable | unavailable | cli | assumed |
| CodeBuddy | `codebuddy` | unavailable | unavailable | unavailable | unavailable | unavailable | mcp | assumed |
| DeepSeek Harness（dsh） | `deepseek-harness` | unavailable | unavailable | unavailable | unavailable | unavailable | explicit-workflow | absent |
| OpenCode（M11 既有） | `opencode` | unavailable | unavailable | unavailable | unavailable | unavailable | mcp | absent |
| Pi（M11 既有） | `pi` | unavailable | unavailable | unavailable | unavailable | unavailable | skip | absent |
| ZCode（M11 既有） | `zcode` | validated | degraded | degraded | unavailable | unavailable | skip | measured |

- 路线统计：`mcp` 14 / `rules` 1（hermes-agent）/ `cli` 1（qoder）/ `explicit-workflow` 2（openclaw、deepseek-harness）/ `skip` 6（replit-agent、tabnine、jetbrains-ai、codegeex、pi、zcode）。
- `skip` 表示无本地可写接口或云端/IDE 插件-only，**不生成无效 MCP 配置**；`mcp` 表示有公开 MCP 接口与声明候选，默认 dry-run，apply 需显式授权。
- `codex` 为 TOML v1 只读，`mcp` 路线但 apply 恒 dry-run 零写。

### 12.2 实测与推断分层

| 层 | 工具 | 说明 |
|---|---|---|
| measured（E4） | `zcode` | 真实 stdio 握手：`initialize` 成功、`tools/list=7`、`brief` phase=P7（T-099 现场 + T-101 `npm run verify:zcode` 复测）；仅证明 ANO 包可配置并调用七工具，不放大为规则/DAG/历史/输出拦截接管。 |
| assumed（E1/E2） | `claude-code`、`codex`、`openclaw`、`tongyi-lingma`、`qoder`、`codebuddy` | 有公开接口文档（E1）或本机存在性（E2），未运行命令/未握手；`detected/configured` 最高 `degraded`，`mcp/tools/brief` 保持 `unavailable`。 |
| absent | 其余 17 工具 | 本机未安装或未探测到声明来源；能力层 `unavailable`，不写支持。 |

### 12.3 T-101 集成验收修复（D1/D2/D3）

| 缺陷 | 症状（T-100 探针） | 修法 | 回归证据 |
|---|---|---|---|
| D1 user-scope 路径逃逸 | 适配器 `config()` 对 home 外显式 path 返回 `dirname(path)`，`assertSafeTargetPath` 认定其在自身父目录内 → 逃逸文件被 apply 写出（cline/kilo-code/openclaw） | 新增 `src/clients/scope.ts`，三适配器统一 `allowedRootForPath(scope, ctx)`：user→home，其余→root；显式路径必须落在声明作用域内 | `test/redteam/full-client-catalog-boundary.test.ts` T-101/12：24 工具 user-scope 逃逸全部 `mode=dry-run`、零写、outside 树不变；in-scope 路径仍可写 |
| D2 库级敏感路径可写 | `config.ts`/`install.ts` 不拒 `.env`/secrets/credentials/key material，以 `~/.env` 为目标 `applied=true` | `config.ts` 新增 `sensitiveConfigPathReason`/`assertSafeConfigPath`（口径同 `surface/service.ts` O-01 与 ADR-006 §2.5），在 `assertSafeTargetPath` 拒绝；install/restore 经同一写路径继承 | `test/unit/client-config.test.ts` T-101/D2：`.env`/`secrets/id_rsa`/`secrets/credentials.json`/`id_ed25519` 在 plan/apply/install/restore 全部抛 `CLIENT_CONFIG_PATH (sensitive location)` 且零写 |
| D3 doctor 回显 env 秘密值 | 12 适配器把 `resolvedEntry` 原样放入 configured 层，报告 `leak=true` | 新增 `src/clients/redact.ts` 统一 `redactClientConfigEntry`（env/environment/headers 只留键名，安全字段白名单），全部适配器与 `doctor.ts` discovery 使用；口径与 qoder 一致 | `test/redteam/full-client-catalog-boundary.test.ts` T-101/13：24 工具 configured 报告不含 `SECRET_VALUE_MARKER`/`Bearer`，且保留 `envKeys`/`headersKeys`/`environmentKeys` 键名 |

### 12.4 registry 口径修正（T-098 移交 6 项）

| 项 | 修正 |
|---|---|
| amazon-q CLI 名 | `kiro`→`kiro-cli` 为主（E1），`kiro` 保留为待核实旧名 |
| tongyi-lingma CLI 名 | `qoder`→`qodercn` 为主（E1），`qoder` 保留为待核实歧名；补 `<root>/.qoder/settings.local.json` workspace 候选 |
| trae 候选 | 补 `configPath('.trae/mcp.json')` 与 `<root>/.trae/mcp.json`（project/json/`mcpServers.ano`），interfaceCarriers 补 `mcp` |
| github-copilot 候选 | 补工作区 `<root>/.mcp.json` 与仓库级 `.github/copilot-instructions.md`、`.github/instructions` 规则路径 |
| openclaw 候选 | 补 `~/.openclaw/openclaw.json`（user/json/`mcp.servers.ano`）；notes 标注 E1 已核实、未实测、绝不 validated |
| codebuddy `cbc` | 保持为 CLI 命令别名（非 ClientId 别名）；`resolveClientId('cbc')===null`；`cloudcode`/`dsh` 别名不变 |

- 回归：`test/redteam/full-client-catalog-boundary.test.ts` T-101/14 断言上述 registry 口径。

### 12.5 未验证项 / 风险

1. 除 ZCode 外无真实客户端安装，`configured/mcp/tools/brief` 真实兼容未实测；所有非 ZCode 的 MCP 列按 §4.6 为 `unavailable`。
2. 真实会话样本 `[数据缺失]`、公开会话格式 `unverified`，`history` 全层 `unavailable`。
3. 输出拦截全客户端 `unavailable`（T-055；工具级 hooks 不算）。
4. OpenClaw 仅 E2 存在性，未授权实测；Cursor 配置格式仍为 `assumed`；OpenCode 路径口径差异保留为限制。
5. D1/D2/D3 为库级修复，已加红队回归；但真实客户端宿主是否读取所写配置仍未实测。
6. 跨 root 授权续接、移动目录身份续接、掉电持久性未验证（沿用 M10 结论）。

## 13. M12 终对账与最终验收（T-102 / CX-12，2026-11-23）

本节为 T-102 的终对账记录：只做证据链、矩阵、命令一致性、审计与质量门禁的核对与回填，**不新增能力声明**。12 任务证据链、21 工具矩阵口径均沿用 §12 与 `docs/evidence/client-support-matrix.json`；本节与源码/测试字节无关。

### 13.1 12 任务证据链

| 任务 | 标题 | 状态 | verification 报告 | ok | 源码指纹（sha256-tree-v1） |
|---|---|---|---|---|---|
| T-091 | 全客户端目录与 registry 收口 | done | `quality-20261123-025301-212-0000.json` | true | `12c086da6c20…` |
| T-092 | 能力探针与分层降级 | done | `quality-20261123-034225-015-0000.json` | true | `75e064ee7bc0…` |
| T-093 | 客户端配置与写路径 | done | `quality-20261123-034225-015-0000.json` | true | `75e064ee7bc0…` |
| T-094 | 备份与原子写 | done | `quality-20261123-034225-015-0000.json` | true | `75e064ee7bc0…` |
| T-095 | doctor 与 plan 渲染 | done | `quality-20261123-034225-015-0000.json` | true | `75e064ee7bc0…` |
| T-096 | 红队边界与秘密面 | done | `quality-20261123-034225-015-0000.json` | true | `75e064ee7bc0…` |
| T-097 | 文档与机器可读矩阵 | done | `quality-20261123-034225-015-0000.json` | true | `75e064ee7bc0…` |
| T-098 | registry 口径修正移交 | done | `quality-20261123-043128-246-0000.json` | true | `56cbeafe376b…` |
| T-099 | ZCode 真机复测 | done | `quality-20261123-045132-895-0000.json` | true | `4718806252dd…` |
| T-100 | T-100 探针与缺陷定位 | done | `quality-20261123-052726-799-0000.json` | true | `0dffed42dad5…` |
| T-101 | CX-11 集成验收与三缺陷修复 | done | `quality-20261123-055704-585-0000.json` | true | `70eab1406243…` |
| T-102 | CX-12 全工具支持矩阵、文档与最终验收 | in_progress（待主控验收） | `quality-20261123-060457-393-0000.json` | true | `70eab1406243…` |

- T-091～T-101 全部 `done` 且 `acceptance_verified=true`（`.pm/orchestration-state.json`），verification 引用报告均存在且 `ok=true/reported_ok=true`；T-102 由主控按本报告置 done 与验收。
- gates：`phase-full-clients` `passed=true`（`verified_at` 2026-11-23T06:00:39.219Z，verification `quality-20261123-055704-585-0000.json`）；`phase-full-clients-final` 尚未开启，由主控以本报告开启。

### 13.2 21 工具五列矩阵摘要

- 全量 24 客户端逐项五列见 §12.1；路线统计见 §12.1（`mcp` 14 / `rules` 1 / `cli` 1 / `explicit-workflow` 2 / `skip` 6）。
- 证据分层（按机器可读 `localMeasurement.tier`，24 行）：`measured` 1（`zcode`）；`assumed` 6（`claude-code`、`codex`、`openclaw`、`tongyi-lingma`、`qoder`、`codebuddy`）；`absent` 17。
- 21 工具 = ADR-008 目录（`catalog=adr-008-21` 的 21 行）；`opencode`/`pi`/`zcode` 为 M11 既有（`catalog=legacy-m11`），registry 同时容纳，故矩阵为 24 行。**21 个 ADR-008 工具全部为 `unvalidated`**（`unavailable`/`unverified`/`absent`）；24 行中唯一 `validated` 是 `zcode`（M11 既有，真实 stdio 七工具握手）。
- 「全适配」≠ 全部 `validated`：路线存在只表示有可执行接入路径或明确降级。

### 13.3 命令一致性核对表（对照 `src/surface/cli.ts` 帮助文本）

| 命令 | cli.ts 帮助（行） | usage.md / README.md | 一致 |
|---|---|---|---|
| `ano doctor clients [--json] [--plan] [--root] [--home] [--env] [--probe-path] [--timeout-ms]` | 62 | 已列（M12 更新 `--plan`） | 是 |
| `ano doctor client <id> [--json] [--root] [--home] [--env] [--probe-path] [--timeout-ms]` | 63 | 已列 | 是 |
| `ano clients plan [--json] [--root] [--home] [--env] [--probe-path] [--timeout-ms]` | 64 | 已列（M12 新增） | 是 |
| `ano clients install <id> --granted-by --statement --scope ... [--confirm] [--dry-run] [--config-scope] [--config-path] [--home] [--role] [--granted-at] [--json]` | 65 | 已列 | 是 |
| `ano clients restore <id> --backup-id ... --granted-by --statement --scope ... [--confirm] [--dry-run] [--config-scope] [--config-path] [--home] [--role] [--granted-at] [--json]` | 66 | 已列 | 是 |

- 语义：`doctor clients` 报告全 24 客户端目录；`doctor client <id>` 增加四列（公开来源/探测/配置候选/能力）；`clients plan` 渲染统一接入计划（`route=mcp|rules|cli|explicit-workflow|skip`）；`cloudcode`→`claude-code`、`dsh`→`deepseek-harness`；未知 id 拒绝；`clients install` 默认 dry-run；`clients restore` 只恢复校验通过且绑定同一目标的备份；Qoder/DSH/Pi/ZCode 如实拒绝写；Codex 因 TOML v1 只读保持 `degraded`。
- 授权口径：写配置必须显式 `--confirm` + `--granted-by`/`--statement`/`--scope`；默认只读 + dry-run。

### 13.4 三审计处置

| 审计 | 结论 | 处置 |
|---|---|---|
| `audit_structure` | 无硬性失败；重构占比 8%<20% 配额；churn 热点 `src/surface/service.ts` 21 次 / `cli.ts` 17 / `mcp.ts` 12；复杂度预算告警；`s5-atomic-append.json` >2MB；F-014 无 `entry_files`；用途索引覆盖 0% | 记录为结构观察，不阻塞 M12 |
| `audit_security` | 0 高危；新发现 5 个中危，全部位于 `test/redteam/full-client-catalog-boundary.test.ts`（3×`secret.generic-assignment`、2×`danger.eval`）；28 条已接受风险 | 逐行核实为合成哨兵/静态守卫字符串（`forbidden` 数组、`SESSION_*_MARKER`、`SECRET_VALUE_MARKER`/`Bearer`），非真实漏洞；因 `test/**` 属只读边界，`resolve_finding accepted` 留痕建议由主控执行 |
| `audit_license` | MIT；0 copyleft 冲突；无 GPL 头；直接 6 + 传递 90 依赖 | 无处置 |

### 13.5 T-102 质量门禁

- 报告：`.pm/quality-runs/quality-20261123-060457-393-0000.json`；SHA-256 `261eafbb524b7435c65bf256f16956748378be5561adc60e4843fe43cf846d6d`（6016 字节）；`ok=true`、`reported_ok=true`、`execute=true`、`evidence_level=tests_observed`。
- 源码指纹 `sha256-tree-v1` `70eab1406243f6ee879122ac0edff4d6308058e9d52e2c1cd636b17f18da26f9`（416 文件 / 69,698,687 字节），`before==after`、`stable=true`。
- 6 项结果全 `passed`（exit 0）：root test 22/22、root build、root typecheck、root coverage 1065/1065（lines 95.21 / branches 82.83 / functions 95.04）、scripts test 22/22、scripts typecheck。`npm run check-docs` exit 0。
- **标注**：本节于该矩阵运行**之后**追加，仅改文档字节、不改源码/测试；源码指纹仍为 `70eab140…`。主控按当前树重跑一次即可复核。

### 13.6 F-031 登记确认

`F-031`（M12 全 24 工具客户端目录与分层接入，module `clients`，status `implemented`）已在 `.pm/features.json` 登记，`entry_files` 覆盖 `src/clients/{registry,doctor,capabilities,config,install,scope,redact}.ts` 与 `src/surface/cli.ts`，`test_files` 5 个；无缺失。

### 13.7 未验证项 / 不自动扩大授权

- 除 ZCode 外无真实客户端安装；真实配置未安装/未授权实测者一律写「未验证」。
- `history` 全层 `unavailable`（无真实会话样本、公开格式未核实）；输出拦截全客户端 `unavailable`。
- 21 个 ADR-008 工具全部仍为 `unvalidated`（`unavailable`/`unverified`/`absent`）；24 行中唯一 `validated` 为 M11 既有的 `zcode`。不因「全适配」把任何工具升级为 `validated`。
- 本任务**不自动修改真实客户端配置、不读取真实会话或秘密**；任何写操作必须用户显式授权（`--confirm` + `--statement` + `--scope`）。


---

## 14. M19 钩子强制层（T-168 实测更新，2026-11-26）

规格：`docs/m19-m22-implementation-spec.md` T-168；源码事实：`src/clients/capabilities.ts::buildEnforcementLevel`（`zcode → hooks-validated`，`claude-code → hooks-documented`）；实测证据：`docs/evidence/m19-zcode-hooks-validation.md` + `.json`。

| 客户端 | enforcement | 证据等级 | 依据 |
|---|---|---|---|
| ZCode (`zcode`) | `hooks-validated` | `measured`（T-168 真实宿主实测） | os.tmpdir 隔离 Git 项目真实 ZCode headless 会话：SessionStart 自动注入 ANO brief；未 explore 的 TS 文件 PreToolUse `ask`（advisory）/`deny`（strict, exit 2）；file-level outline 后 `allow`；无归属改动 Stop 要求补记且补记后正常结束。宿主日志、钩子决定计数、账本事件 ID 见 T-168 证据。 |
| Claude Code (`claude-code`，含 `cloudcode`) | `hooks-documented` | `documented`（仅公开文档） | 无本任务实测；按规格保持不升级。 |

- 该层独立于既有九层能力矩阵；`output-interception` 全客户端仍 `unavailable`（钩子是工具级闸门，不构成输出拦截），不因本节改变。
- 判定门槛：Q1/Q2（ask+deny）/Q3/Q4 均有真实 ZCode 宿主日志 + 钩子 stdout + 账本事件 ID；无合成样本冒充实测。未通过的项（PermissionRequest 无头子进程样本）沿用 S8 Q2 例外，不影响本层判定。
