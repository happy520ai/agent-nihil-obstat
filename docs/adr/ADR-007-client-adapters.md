# ADR-007：多客户端能力契约与自适应降级协议

日期：2026-11-22
状态：提议（待主控审阅；审阅通过后置"已接受"并开放 phase-clients 门禁）
任务：T-079 / MC-01（M11）
输入契约：`docs/adr/ADR-006-project-takeover.md`、`docs/takeover.md`、`docs/evidence/host-capability-investigation.md`、`docs/evidence/takeover-host.md`、`docs/anchor-probe-benchmark.md`、`docs/limitations.md`、`docs/client-compatibility.md`、`src/surface/cli.ts`（takeover 命令组）、`src/connect/capabilities.ts`、`src/connect/backup.ts`、`src/surface/doctor.ts`、`.pm/roadmap.json`（M11）、`scripts/orchestration/m11-plan.json`

> 编号说明：本文件是 `docs/adr/` 系列 ADR-006 的后续（Surface/集成实现边界系列）。`.pm/decisions/` 下的 ADR-001~005 是编排决策系列，两者互不覆盖。本 ADR 是 M11「多客户端自适应接入」的语义契约；兼容矩阵与验收框架见 `docs/client-compatibility.md`。

## 1. 背景与问题定义

M5 只接入了 ZCode（用户级 `~/.zcode/cli/config.json` + 工作区 `.zcode/config.json`），M10 把「接管」固定为**项目内**授权 + 三态/六阶段状态机（ADR-006）。两者都没有回答「一个 ANO 包如何被多个编码客户端发现、验证、配置与降级」，也没有统一的能力分层口径。`docs/client-compatibility.md` 当前只把客户端标为 `planned`，`docs/evidence/host-capability-investigation.md` 只调查了 ZCode 宿主，均不足以支撑 T-080~T-090。

一句话问题定义：把「客户端支持」从**宣称**变成**可探测、可验证、可降级、可恢复**的契约——每个客户端的身份来源、配置位置、能力分层、判定证据与失败语义都显式固定，任何一层未实测都不得升级为已验证。

「修好了」的判据：T-080~T-084 的实现者不需要再做本 ADR 范围内的语义决策；验收可直接按第 12 节判据与 `docs/client-compatibility.md` 的所有权表编写；不新增第八个 MCP 工具，不修改用户级配置，不读取真实会话或秘密。

## 2. 硬边界（全节为硬边界，实现与测试不得违反）

以下八条是 M11 的不可变边界，与 ADR-003/004/005/006 一致；任一条被违反即视为实现错误，而不是配置问题：

1. **只读探测默认**：客户端配置默认只读探测与 dry-run；任何真实修改（写配置、装 MCP、写规则文件）必须显式授权 + 备份 + hash 绑定 + 可恢复。
2. **显式授权**：库级与 CLI 的配置修改必须显式 `--confirm` 与授权作用域；不得从环境变量、配置文件或默认值推断授权。授权记录是项目内本地可审计记录，不是 token，不授予宿主权限。
3. **不自动读取真实会话或秘密**：`history` 层与任何会话采样必须由用户明确授权；不采集凭据、令牌、私钥、宿主全局会话或未授权目录。
4. **不得放大证据**：stdio 握手成功 ≠ `configured` ≠ 完整接管；MCP 成功不得放大为 DAG/历史/输出拦截支持；任一层成功不能代替其他层。
5. **不新增第八个 MCP 工具**：MCP 工具数量恒为 7（`brief`/`explore`/`recall`/`track`/`note`/`verify`/`audit`）；客户端能力只经 CLI 子命令（`ano doctor clients` / `clients install|restore`）与既有工具投影暴露。
6. **适配器不可执行配置内容**：配置一律作为数据解析（JSON/TOML 等），不 eval、不 shell、不动态加载配置指向的脚本。
7. **不猜身份与接口**：身份或接口不明确的客户端（明文含 DSH、Pi）一律 `unknown`，只探测已知公开来源，不猜路径、不伪造适配器。
8. **不静默修改其他服务**：配置合并必须保留客户端既有 MCP 服务与未知字段；无法解析的字段原样保留或拒绝，不得丢弃。

**自动工作流与人工动作的区分**：探测、dry-run、备份、hash 校验、原子安装、恢复属于自动工作流；授权授予/撤销、真实配置修改确认、发布/attest/approve/sync/push、宿主权限批准属于具名人工动作。自动工作流可以写项目内受管文件与 `.ano/clients/`，但不得代替上述人工动作。

## 3. 决定一：九层能力分层契约

能力分层是**判定口径**，不是实现模块。层与层之间是前置关系，不是等同关系：

```text
detected → configured → mcp → tools → brief → instructions → orchestration → history → output-interception
  身份        配置声明     握手    工具面   上下文   项目规则       派发/编排      历史          输出拦截
```

| 层 | 判定条件 | 证据形态 | 未实测默认 | 放大禁令（不得宣称） |
|---|---|---|---|---|
| `detected` | 通过明确来源（可执行名 / 进程名 / env / 配置目录 / 包管理痕迹）在本机找到该客户端 | `{ source, executablePath?, version?, detectedAt }` | `unavailable` | 找到配置目录 ≠ 客户端已安装；找到进程 ≠ 该进程使用 ANO |
| `configured` | 客户端配置（用户级 / 项目级 / 工作区级）中存在指向本包的 `ano` MCP server 条目，且解析路径可达 | `{ configPath, scope, key, resolvedEntry, exists }` | `degraded`（已安装未配置） | `configured` ≠ 服务端可启动 ≠ 完整接管；条目存在但路径失效仍为 `degraded` |
| `mcp` | 真实 stdio 子进程 `initialize` 成功，返回 `protocolVersion` 与 `serverInfo` | `{ transport:'stdio', protocolVersion, serverInfo, latencyMs, startedAt }` | `unavailable` | 握手成功 ≠ 配置已生效 ≠ 七工具可用 ≠ 接管生效 |
| `tools` | `tools/list` 恰返回 7 个工具且与 `docs/generated/tools.md` 一致 | `{ count, names[], missing[], extra[] }` | `unavailable` | 数量 7 但缺 `brief`/`track` 不算通过；不得因 7 通过就宣称接管可用 |
| `brief` | 真实调用 `brief` 返回合法 schema，含项目上下文；接管项目另含主写/角色/`hostCapability` 投影 | `{ schema, hasProjectContext, takeoverProjection?, hostCapability }` | `unavailable` | `brief` 成功 ≠ 任务/记忆/验收/DAG 可用；不证明宿主自动启动或自动拦截 |
| `instructions` | 客户端项目规则文件（`CLAUDE.md` / `AGENTS.md` / `.cursorrules` / `.cursor/rules/**` / OpenCode 指令）存在且可被识别；探测是否已含受管 ANO 段 | `{ rulePaths[], formatVersion?, hasManagedSection, readOnly }` | `degraded`（未识别/未配置） | 探测/提议 ≠ 已安装；写入必须显式授权；「文件存在」≠「客户端已读取」 |
| `orchestration` | 客户端是否公开子代理 / 技能 / 任务派发接口，且该接口可被 ANO **显式**调用 | `{ publicApi?, documented, mode:'native'\|'explicit-workflow'\|'none', measured? }` | `degraded`（无公开接口 → 主控 harness / 显式工作流降级） | 不得复制不存在的自动化；不得宣称通用自动派发或无人值守 |
| `history` | 真实会话历史可读取；需公开格式或用户明确授权的样本 | `{ source, formatVersion, sampleAuthorized, parsedRecords, privacy }` | `unavailable`（无授权样本 / 格式未知） | 合成 fixture 只证明机制，不升级本层；不得自动读取真实会话或秘密 |
| `output-interception` | 客户端是否公开面向 MCP 结果 / 模型输出的拦截 / 适配接口（**非**工具级 hooks） | `{ publicApi?, hooksAreToolLevel, configured, measured? }` | `unavailable` | hooks 是工具级闸门，不得表述为输出拦截；ZCode 已由 T-055 证明 `unavailable` |

- 层间前置：`configured` 需要 `detected`；`mcp`/`tools`/`brief` 需要 `configured` 或显式注入命令；`instructions` 需要 `detected`；`orchestration`/`history`/`output-interception` 需要 `detected`。前置不成立时该层直接 `unavailable`，不进入判定。
- 每层证据必须含**时间**（`detectedAt`/`measuredAt`）、**版本**（客户端版本或配置格式版本）、**来源**（探测来源或文件路径）、**限制**（`limitations[]`）。缺任一项时该层不得判 `validated`。
- 单层失败必须隔离：一层超时/异常只影响该层 verdict 与错误列表，不得中断其他层，也不得让整份报告失败。

## 4. 决定二：verdict 三值与判定规则

### 4.1 枚举（固定，不得扩展）

能力层 verdict 只有三值：

```ts
type ClientVerdict = 'validated' | 'degraded' | 'unavailable';
```

弱序固定：`unavailable < degraded < validated`。

`unknown` **不是**能力层 verdict，而是**客户端级身份状态**（见 §6/§7）。任何文档、JSON 报告或 CLI 输出都不得把 `unknown` 当作能力层 verdict 使用。

### 4.2 证据强度（与 verdict 正交）

```ts
type ClientEvidence = 'measured' | 'configured' | 'assumed' | 'absent';
```

- `measured`：真实探测/真实调用成功，带时间与版本。
- `configured`：配置存在但未实测。
- `assumed`：仅来自公开文档或初始假设，未探测。
- `absent`：无证据。

`unverified` 不是 verdict，而是「配置存在但未实测」的证据标签（`evidence='configured'` 时的报告文案）。客户端级 `evidence` 上限为 `unverified` 的含义即：永远不得报 `measured/validated`。

### 4.3 判定规则（无歧义）

| 证据情形 | verdict | evidence | 说明 |
|---|---|---|---|
| 未安装 / 无该机制 / 明确不支持 / 前置层不成立 | `unavailable` | `absent` | 不进入该层判定 |
| 已安装但未配置（`configured` 层无条目） | `degraded` | `absent` | 需要配置动作，不得报「已支持」 |
| 已配置但未实测（未跑握手/未调用） | `degraded` | `configured` | 上限 `unverified`；不得报 `validated` |
| 仅公开文档/初始假设，未探测 | `degraded` | `assumed` | 必须标注「未实测」 |
| 实测成功但该层能力部分缺失 | `degraded` | `measured` | 缺 DAG/历史/拦截等必须显式列出 |
| 实测成功且该层完整、证据四要素齐全 | `validated` | `measured` | 缺一要素即降 `degraded` |
| 身份/接口不明确的客户端（DSH/Pi） | 该层 `unavailable` | `absent` | 客户端级 `status='unknown'`，见 §7 |

### 4.4 聚合规则

- **核心链路**（`detected → configured → mcp → tools → brief`）取五层最弱值作为客户端 `coreVerdict`。
- **扩展层**（`instructions`/`orchestration`/`history`/`output-interception`）单独报告，不参与 `coreVerdict`，但任一扩展层为 `unavailable` 时必须在报告的 `limitations` 中列出。
- 客户端 `status`：`coreVerdict='validated'` 且无未处理错误 → `ready`；否则 `degraded`；核心链路 `unavailable` 且无任何探测痕迹 → `unavailable`；身份/接口不明确 → `unknown`。
- **禁止放大**：`coreVerdict='validated'` 只表示「ANO 包可被该客户端发现、配置并调用七工具」，**不表示**项目规则已接管、DAG 已接管、历史已支持或输出可拦截。任何文案不得把 MCP 成功表述为完整接管。

## 5. 决定三：适配器四接口

### 5.1 统一接口

```ts
interface ClientAdapter {
  readonly id: ClientId;
  /** 只读探测来源声明；实现不得使用未声明的来源。 */
  readonly identitySources: readonly IdentitySource[];
  detect(input: DetectInput): Promise<DetectResult>;
  inspect(input: InspectInput): Promise<InspectResult>;
  config(input: ConfigInput): Promise<ConfigResult>;
  verify(input: VerifyInput): Promise<VerifyResult>;
}
```

- `ClientId` 固定枚举：`'claude-code' | 'codex' | 'cursor' | 'opencode' | 'qoder' | 'dsh' | 'pi' | 'zcode'`。`cloudcode` 映射到 `claude-code`（§6）。
- 所有接口必须是纯探测/纯计算或显式授权写；不得有隐式副作用。
- 所有接口必须接受 `AbortSignal` 与 `timeoutMs`，超时按该层 `degraded` 隔离，不抛断全局。

### 5.2 `detect`（只读）

- **输入**：`{ env?, cwd?, probePaths?, timeoutMs?, signal? }`。全部可选；不传时使用进程 `env`/`cwd` 与声明来源。
- **输出**：`{ clientId, detected, executablePath?, version?, sources: Evidence[], errors: IsolatedError[] }`。
- **失败语义**：来源不可读、超时、版本不可解析 → `detected=false` 或 `version=null` + 隔离错误；**不得猜测路径**，不得回退到「常见默认路径」当作已探测。找不到即 `detected=false`。

### 5.3 `inspect`（只读，恒只读）

- **输入**：`{ root?, env?, cwd?, timeoutMs?, signal? }`。不得接受任何写开关。
- **输出**：九层能力报告 `{ schema:'ano.client-report/1', clientId, status, coreVerdict, layers: Record<Layer, LayerReport>, generatedAt, limitations }`。
- **失败语义**：单层失败 → 该层 `degraded`/`unavailable` + 原因；其他层继续。**不得读取真实会话内容或秘密**；`history` 层只报告格式可用性，不读取内容。

### 5.4 `config`（默认 dry-run）

- **输入**：
  ```ts
  {
    target: ConfigTarget;                       // 用户级 / 项目级 / 工作区级
    mode: 'dry-run' | 'apply';                  // 默认 'dry-run'
    authorization?: ClientAuthorizationRef;     // apply 时必填
    backup?: boolean;                           // apply 时默认 true
    root?: string;                              // 授权作用域绑定的规范项目根
    signal?;
  }
  ```
- **输出**：
  - dry-run：`{ mode:'dry-run', changes: ProposedChange[], backupPlan?, warnings }`，零写。
  - apply：`{ mode:'apply', backupId, backupHash, beforeHash, afterHash, changes, restoredOnFailure }`。
- **失败语义**（全为零写或可恢复）：
  1. `mode='apply'` 缺显式授权 → 拒绝，零写。
  2. 缺 `--confirm`（CLI 层）→ 拒绝，零写。
  3. 备份创建或 hash 校验失败 → 拒绝，零写。
  4. 目标文件在备份后发生变化（`beforeHash` 漂移）→ 拒绝，零写（防并发修改）。
  5. 写入部分失败 → 用已验证备份恢复到 `beforeHash`，报告 `restoredOnFailure=true`，不得留下损坏配置。
  6. 路径逃逸（解析后超出声明作用域 / 符号链接越界）→ 拒绝。
  7. 无法解析的未知字段 → 拒绝或原样保留并在 `warnings` 列出，**不得丢弃**。
- **合并规则**：只追加/更新 `ano` 条目；保留其他 MCP 服务、其他键与文件内其他内容；幂等重放零变化（`afterHash` 相同）。

### 5.5 `verify`（真实 MCP，可注入）

- **输入**：`{ root?, transport:'stdio', command?, args?, env?, timeoutMs?, signal?, inject?: McpClientLike }`。`inject` 仅用于测试，生产路径必须真实 spawn。
- **输出**：`{ handshake?, tools?, brief?, verdicts: Record<Layer, ClientVerdict>, errors: IsolatedError[] }`。
- **失败语义**：握手失败/超时/非零退出 → `mcp='unavailable'`，并**停止**后续层（`tools`/`brief` 不再尝试），不得用缓存或假设填充。握手成功但 `tools/list` 不符 → `tools='degraded'`，`brief` 仍可尝试但不得升级为接管结论。

### 5.6 授权与备份（复用 ADR-006 模型）

- 授权记录：`<root>/.ano/clients/authorization.json`，schema `ano.client-authorization/1`：
  ```jsonc
  {
    "schema": "ano.client-authorization/1",
    "authorizationId": "<sha256(canonicalJson({root, clientId, scope, grantedBy, role, statement, grantedAt}))>",
    "root": "F:/Agent Nihil Obstat",
    "clientId": "claude-code",
    "scope": ["detect", "inspect", "config", "install", "restore"],
    "grantedBy": "具名人工",
    "role": "角色",
    "statement": "明确授权语句",
    "grantedAt": "ISO 8601",
    "revokedAt": null
  }
  ```
- 授权作用域绑定**单一规范项目根**与单一 `clientId`；跨 root / 跨客户端一律拒绝。
- 备份：`<root>/.ano/clients/backups/<clientId>/<id>/`，复用 `src/connect/backup.ts` 的内容哈希清单模式；`backupHash` 绑定授权与安装记录；恢复前逐文件校验，校验失败拒绝恢复。
- 恢复：`restore` 只使用校验通过的已验证备份；不删除备份目录；不删除其他服务条目。
- 授权是项目内本地记录，不是 token，不改变宿主权限面，不写入用户级配置，不注册到 MCP。

## 6. 决定四：客户端身份与路径来源（不猜）

身份与路径的探测来源必须显式声明，且只能来自下列类别之一：可执行文件探测、进程枚举、环境变量、公开配置文件路径、包管理痕迹。**不得从名称相似性推断路径，不得把「常见默认路径存在」当作已安装证据。**

| 客户端 | 身份来源（只读） | 路径来源（候选，实测前 `unverified`） | 处理 |
|---|---|---|---|
| Claude Code | `claude` 可执行、`~/.claude/`、`CLAUDE.md` | `~/.claude/settings.json`、`~/.claude.json`（`mcpServers`）、项目 `.mcp.json`；规则 `CLAUDE.md` | 正常适配 |
| cloudcode | 同 Claude Code（同一配置与规则格式） | 同 Claude Code | **按 Claude Code 处理**，复用 `claude-code` 适配器，不新建身份 |
| Codex | `codex` 可执行、`~/.codex/`、`AGENTS.md` | `~/.codex/config.toml`（`[mcp_servers.*]`）；规则 `AGENTS.md` | 正常适配 |
| Cursor | `cursor` 可执行、`~/.cursor/`、`.cursor/rules` | `~/.cursor/mcp.json`、`.cursor/mcp.json`；规则 `.cursorrules`、`.cursor/rules/*.mdc` | 正常适配 |
| OpenCode | `opencode` 可执行、`~/.config/opencode/`、`AGENTS.md` | `~/.config/opencode/opencode.json`、`opencode.json`、`.opencode.json`；规则 `AGENTS.md` | 正常适配 |
| Qoder | 公开接口待核实（T-084）；本契约不假设其配置路径 | 待核实 | 只探测已声明的公开来源；实测与配置事实分开记录 |
| DSH | 身份或接口不明确 | 不声明 | **`unknown`：只探测不猜接口**，verdict 上限 `degraded`/`unverified`，默认全部层 `unavailable` |
| Pi | 身份或接口不明确 | 不声明 | **`unknown`：只探测不猜接口**，同上 |
| ZCode | `~/.zcode/cli/config.json`（生效）、`~/.zcode/v2/config.json`（遗留）、工作区 `.zcode/config.json`、`AGENTS.md` | 用户级/工作区 MCP 注册；规则 `AGENTS.md` | 正常适配；不得修改用户级配置 |

- 表中路径是**探测候选**，不是已验证事实；T-082/T-083/T-084 必须用真实公开文档或本机事实核实，未核实前一律 `unverified`。
- 本契约不读取任何真实客户端配置文件内容；实现只做只读探测，且不得把探测结果中的秘密回显到报告。
- `cloudcode` 不新增ClientId；其报告在 `clientId='claude-code'` 下以 `alias='cloudcode'` 标注。

## 7. 决定五：未知、缺失与失败语义

| 情况 | 语义 | verdict / status | 报告要求 |
|---|---|---|---|
| 未安装 | 前置不成立 | 全层 `unavailable`；`status='unavailable'` | 列出已探测来源与「未找到」 |
| 已安装未配置 | 机制存在、配置缺失 | `configured='degraded'`，`coreVerdict` 不超过 `degraded` | 给出配置位置与 dry-run 提议 |
| 已配置未实测 | 配置存在、未跑握手 | 该层 `degraded`，`evidence='configured'`（`unverified`） | 必须标注「未实测」 |
| 实测部分能力缺失 | 有实测、有缺失 | 该层 `degraded`，`evidence='measured'` | 显式列出缺失能力 |
| 探测超时 / 权限不足 / 格式损坏 | 失败隔离 | 该层 `degraded` 或 `unavailable` + 原因 | 记录错误码与时间，不伪造通过 |
| 身份/接口不明确 | 无法进入判定 | 客户端 `status='unknown'`；全层 `unavailable` | 只探测已知公开来源；不得猜路径 |
| 明确不支持 | 无该机制 | 该层 `unavailable` | 引用公开文档或本机事实 |

**DSH / Pi 明文约束**：身份或接口不明确时 `status='unknown'`，只探测不猜接口；所有能力层默认 `unavailable`，verdict 上限为 `degraded` 且 `evidence='unverified'`，**永远不得达到 `validated`**；不得自动猜路径、不得伪造适配器、不得因「找到了某个同名文件」就升级。

## 8. 决定六：七工具不变约束与不得放大的声明

- MCP 工具数量恒为 7，与 `docs/generated/tools.md` 一致；客户端能力**不**通过新增工具暴露。
- 客户端能力暴露途径仅限：`ano doctor clients` / `ano doctor client <id>`（只读报告）、`ano clients install|restore`（显式授权写）、以及既有 `brief`/`track` 的接管投影。
- 适配器不得执行配置内容：配置解析只产生数据结构；禁止 `eval`、`new Function`、`child_process` 执行配置中出现的命令、动态 `import()` 配置指向的模块。
- 不得放大的声明（测试与文档均需做否定断言）：
  1. stdio 握手成功不得表述为「已配置」或「已接管」。
  2. MCP 七工具可用不得表述为「DAG 已接管」「历史已支持」「输出可拦截」。
  3. `brief` 成功不得表述为「宿主自动启动」或「自动批准」。
  4. 合成 fixture 通过不得表述为「真实客户端兼容」。
  5. `unknown` 客户端不得表述为「已支持」或「已验证」。

## 9. 决定七：ZCode / Connect / M8 / M9 / M10 回归承诺

| 既有面 | 承诺 | 不得破坏 |
|---|---|---|
| ZCode（M5） | 用户级 `~/.zcode/cli/config.json` 注册与七工具 stdio 不回退；工作区 `.zcode/config.json` 语义不变 | 不修改用户级配置；不新增第八工具；不动 M5 已验证的 `verify:zcode` 路径 |
| Connect（M6） | `connect plan/connect/status/resume/watch/export/handoff` 语义与输出形状不变 | 客户端适配器不读写 `.pm/` 主写；不改快照/导出语义 |
| M8 AnchorProbe | `recall`（含 `source=connected`）、probe、记忆事件语义不变 | 不把客户端历史采样接入记忆声明通道；不产生 `evidence_id` |
| M9 多会话 DAG | 调度器/租约/会话契约不变 | 客户端 `orchestration` 层只映射既有显式接口，不新建调度协议 |
| M10 强制接管 | 三态/六阶段/角色矩阵/七工具/备份恢复不变 | 客户端配置安装不得触发接管；`enforced` 语义不被客户端能力放大 |

- 回归判据：`node scripts/run-tests.ts`、`npx tsc -p tsconfig.json --noEmit`、`node scripts/check-docs.ts` 与 `node scripts/verify-zcode-mcp.ts` 全绿；七工具数量断言 `tools/list=7` 不回归。
- 客户端适配器只读探测不写用户级配置；M10 的 `.pm/` 与 `.ano/takeover/` 不被客户端工作流修改。

## 10. 文件所有权与并行接口（T-080~T-084）

见 `docs/client-compatibility.md` 第 5 节。要点：`src/clients/types.ts` + `registry.ts` + `doctor.ts`（T-080）先固定类型与四接口；`config.ts` + `install.ts`（T-081）独占配置写路径；客户端适配器（T-082/T-083/T-084）只实现 `ClientAdapter`，不改 registry/types/doctor；共享文件不并发写。`src/surface/cli.ts` / `service.ts` / `tool-catalog.ts` 由 T-085 在其后串行接入。

## 11. 测试与验收判据

- **九层**：每层有「未安装/已安装未配置/已配置未实测/实测部分缺失/实测完整」确定性用例；每层证据含时间/版本/来源/限制。
- **verdict**：§4.3 规则逐条可复现；未实测不得 `validated`；`unknown` 客户端不得 `validated`；无歧义用例（同输入同输出）。
- **四接口**：`detect` 只读；`inspect` 无写开关且错误隔离；`config` 默认 dry-run 零写、缺授权零写、并发漂移拒绝、失败恢复、保留其他服务；`verify` 握手失败即停止放大。
- **身份来源**：每客户端身份/路径来源可追溯到声明来源；DSH/Pi 明文 `unknown`，无路径猜测。
- **硬边界**：路径穿越/命令注入/未授权写/秘密采集/执行配置内容全部拒绝；七工具数量断言。
- **回归**：ZCode/Connect/M8/M9/M10 既有测试与 `verify:zcode` 通过；`docs/generated/tools.md` 仍为 7 工具。
- **兼容矩阵**：`docs/client-compatibility.md` 的客户端×能力层矩阵逐格有证据要求与初始 `unverified` 标注。

## 12. 与 ADR-003/004/005/006 的边界对账

- **ADR-003**：本 ADR 不把客户端声明升级为已验证事实；历史采样不进入 Gate 完成通道。
- **ADR-004**：备份/恢复复用其校验模式；回退不删数据。
- **ADR-005**：记忆事件语义与不可变约束不变；客户端历史不改变 `memory.*` 状态机。
- **ADR-006**：授权模型、备份/hash 绑定、七工具不变、宿主能力 `degraded` 与「不把 ANO 侧切换表述为宿主已强制」沿用；本 ADR 的「客户端配置安装」与「项目接管」是两个独立动作，前者不得自动触发后者。

## 13. 后果

- 实现者获得固定九层、verdict 三值、四接口、授权/备份与失败语义，T-080~T-084 可并行；验收判据可预先编写。
- 代价：需要新增只读探测、dry-run 与授权/备份路径；「支持」的定义被收紧为「实测证据」，初始全部客户端为 `unverified`。
- 本 ADR 只固定语义与契约，不声称任何实现或测试已存在；实现完成后按第 11 节与 `docs/client-compatibility.md` 验收。
