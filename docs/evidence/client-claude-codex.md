# T-082 证据报告：Claude Code / Codex 客户端适配器

- 任务：T-082 / MC-04（M11）
- 日期：2026-11-22
- 实现文件：`src/clients/claude-code.ts`、`src/clients/codex.ts`
- 测试文件：`test/unit/client-claude-code.test.ts`、`test/unit/client-codex.test.ts`
- 契约：`docs/adr/ADR-007-client-adapters.md` §2/§4/§5/§6、`docs/client-compatibility.md` §1/§5

## 1. 结论

两个适配器已实现并通过隔离测试：Claude Code（含 `cloudcode` alias）与 Codex 均实现 `detect / inspect / config / verify` 四接口；配置映射按真实公开格式（`mcpServers` / `mcp_servers`）；`CLAUDE.md` / `AGENTS.md` 受管段检测为独立只读能力，最高只判 `degraded`；未实测层一律 `unverified` / `unavailable`，未读取任何真实客户端配置内容，未修改任何真实客户端配置。

本机事实：`claude` 与 `codex` 均不在 PATH；`~/.claude/` 与 `~/.codex/` 目录存在（仅存在性检查）。因此真实环境下的 `configured` / `mcp` / `tools` / `brief` 未实测，保持 `unverified`，本报告不声称真实客户端兼容。

## 2. 交付物与接口清单

| 文件 | 行数 | 主要导出 |
|---|---|---|
| `src/clients/claude-code.ts` | 936 | `createClaudeCodeAdapter`、`claudeCodeAdapter`、`claudeCodeConfigTarget`、`CLAUDE_CODE_IDENTITY_SOURCES`、`CLAUDE_CODE_SERVER_PATH`、`CLAUDE_CODE_SERVER_NAME`、`ClaudeCodeAdapterOptions` |
| `src/clients/codex.ts` | 911 | `createCodexAdapter`、`codexAdapter`、`codexConfigTarget`、`CODEX_IDENTITY_SOURCES`、`CODEX_SERVER_PATH`、`CODEX_SERVER_NAME`、`CodexAdapterOptions` |
| `test/unit/client-claude-code.test.ts` | 423 | 15 个用例 |
| `test/unit/client-codex.test.ts` | 318 | 11 个用例 |
| `docs/evidence/client-claude-codex.md` | 本文件 | 证据报告 |

两适配器实现同一 `ClientAdapter` 形状：

| 接口 | Claude Code | Codex |
|---|---|---|
| `id` | `claude-code` | `codex` |
| `identitySources` | 直接取 `defaultRegistry.get('claude-code').identitySources`（3 项） | 直接取 `defaultRegistry.get('codex').identitySources`（3 项） |
| `detect` | 只读探测 `claude` 可执行、`~/.claude/`、`CLAUDE.md` | 只读探测 `codex` 可执行、`~/.codex/`、`AGENTS.md` |
 |
| `inspect` | 九层报告；`configured` 只读发现；`CLAUDE.md` 受管段检测 | 九层报告；`configured` 只读发现；`AGENTS.md` 受管段检测 |
| `config` | `serverPath=['mcpServers']`、`serverName='ano'`、`format='json'` | `serverPath=['mcp_servers']`、`serverName='ano'`、`format='toml'` |
| `verify` | 委托 T-080 `verifyStdioMcp`（真实 stdio，可注入） | 同左 |

注入选项（两适配器一致）：`home`、`root`、`env`、`probePaths`、`now`。生产默认 `home=homedir()`、`root=process.cwd()`、`probePaths=PATH`；测试必须注入 tmpdir，禁止用真实 home 跑测试。

## 3. 真实公开格式依据

| 依据 | 获取方式 | 证明内容 | 状态 |
|---|---|---|---|
| Claude Code MCP 文档 `https://code.claude.com/docs/en/mcp` | 2026-11-22 实际抓取 | `mcpServers` 位于 `~/.claude.json`（用户级）与项目 `.mcp.json`（项目级）；stdio 条目为 `{command,args,env}`；`~/.claude/settings.json` 承载 `enabledMcpjsonServers`/`disabledMcpjsonServers` 审批键，不是 `mcpServers` 容器 | 已核实（公开文档） |
| Claude Code 记忆文档 `https://code.claude.com/docs/en/memory` | 2026-11-22 实际抓取 | `CLAUDE.md` 读取位置：托管策略、`~/.claude/CLAUDE.md`、`./CLAUDE.md` 或 `./.claude/CLAUDE.md`、`./CLAUDE.local.md`；它是上下文而非强制配置；无 `CLAUDE.md` 时才回退 `AGENTS.md` | 已核实（公开文档） |
| Codex 源码 `codex-rs/config/src/config_toml.rs` | 2026-11-22 经 GitHub raw 实际抓取 | 文档注释 `Base config deserialized from ~/.codex/config.toml`；根字段 `mcp_servers: HashMap<String, McpServerConfig>` | 已核实（main 分支源码，非发行版 tag） |
| Codex 源码 `codex-rs/config/src/mcp_types.rs` | 2026-11-22 经 GitHub raw 实际抓取 | `RawMcpServerConfig` 字段集（`command`/`args`/`env`/`env_vars`/`startup_timeout_ms`/`tool_timeout_sec` 等）；`#[schemars(deny_unknown_fields)]`，未知字段会被 Codex 拒绝 | 已核实（main 分支源码，非发行版 tag） |
| `https://developers.openai.com/codex/mcp` | 自动抓取返回 403 | 未直接取得官方页面正文 | **unverified**（以源码证据替代） |
| ADR-007 §6、`src/clients/registry.ts` | 本地契约 | 路径候选与身份来源登记 | 已核实（本地事实） |
| `src/connect/managed-instructions.ts`（M10） | 本地源码 | 受管段 marker 先例：`MANAGED_INSTRUCTIONS_BEGIN/END`、`MANAGED_INSTRUCTIONS_SCHEMA` | 已核实（本地事实） |

格式判定细节：

- Claude Code 的 `ANO` 条目已知字段集：`type,url,headers,headersHelper,timeout,alwaysLoad,command,args,env,oauth`。`url` 存在但缺 `type` 时按公开文档判 `degraded`（Claude Code 会当作 stdio 并跳过）。
- Codex 的 `ANO` 条目已知字段集：`command,args,env,env_vars,cwd,http_headers,env_http_headers,url,bearer_token,bearer_token_env_var,http_headers_helper,environment_id,auth,startup_timeout_sec,startup_timeout_ms,tool_timeout_sec,enabled,required,startup_readiness,supports_parallel_tool_calls,tool_input_schema_max_bytes,omit_tools_from,default_tools_approval_mode,enabled_tools,disabled_tools,scopes,oauth,oauth_resource,name,tools`。未知字段判 `degraded` 并列出字段名（源码对未知字段是拒绝语义）。
- 两适配器均不解析客户端版本；`version` 仅取配置格式版本（`config-format:json` / `config-format:toml`）或 `null`，不猜版本。

## 4. 本机事实（仅存在性，未读配置内容）

| 检查 | 结果 |
|---|---|
| `command -v claude` | 未找到 |
| `command -v codex` | 未找到 |
| `~/.claude/` | 存在 |
| `~/.codex/` | 存在 |
| 真实 `~/.claude/settings.json` / `~/.claude.json` / `~/.codex/config.toml` 内容 | **未读取** |
| 真实客户端配置修改 | **未发生** |

推论：若用默认 home 运行 `detect`，会经 `config-path` 来源报 `detected=true`，但 `executablePath=null`、`version=null`，`detected` 层只能是 `degraded`；`configured` 需要读取真实配置文件，本任务未做，故真实环境 `configured` 为 **unverified**。

## 5. 安装 / 未安装分别报告样例

以下来自隔离测试（tmpdir 注入），非真实环境。

未安装（空 home、空 PATH）：

```json
{
  "clientId": "claude-code",
  "detected": false,
  "executablePath": null,
  "version": null,
  "sources": [],
  "errors": []
}
```

已安装（tmp bin 中有 `claude`，home 有 `.claude/`，root 有 `CLAUDE.md`）：`detected=true`，`executablePath=<tmp>/bin/claude`，`sources` 含 `executable:claude` 与两条 `config-path`。

`inspect` 判定汇总：

| 环境 | detected | configured | mcp/tools/brief | instructions | status / coreVerdict |
|---|---|---|---|---|---|
| 未安装 | `unavailable` | `unavailable` | `unavailable` | `unavailable` | `unavailable` / `unavailable` |
| 已安装未配置 | `validated`（有可执行）或 `degraded`（仅目录） | `degraded`（evidence `absent`） | `unavailable` | `degraded`（无规则文件时 evidence `absent`） | `degraded` / `unavailable` |
| 已配置未实测 | `validated`/`degraded` | `degraded`（evidence `configured`） | `unavailable` | `degraded` | `degraded` / `unavailable` |
| 实测完整（仅 verify 注入） | 由 doctor 覆盖 | 由 doctor 覆盖 | `validated` | `degraded` | 由 doctor 覆盖 |

`inspect` 不做握手，因此 `coreVerdict` 最高只能到 `unavailable`（核心链含 `mcp/tools/brief`）；`mcp/tools/brief` 的 `validated` 只能由真实 stdio 验证产生。

## 6. 规则文件接管能力独立验证

检测逻辑（两适配器各自实现，常量复用 M10）：

- 规则文件：Claude Code 仅探测 `<root>/CLAUDE.md`；Codex 仅探测 `<root>/AGENTS.md`（与 registry `rulePaths` 一致，不猜额外路径）。
- 受管 marker：`<!-- ano:takeover:managed:v1:begin -->` / `<!-- ano:takeover:managed:v1:end -->`，body 内 `schema: ano.takeover-managed-instructions/1`。
- 判定：marker 恰好一对且顺序正确 → `hasManagedSection=true`，`formatVersion=ano.takeover-managed-instructions/1`；marker 缺失、多对、顺序错误或 schema 不符 → `hasManagedSection=false` 并写入 `limitations`。
-  verdict 上限：只要 `detected`，`instructions` 恒为 `degraded`（`evidence` 在有规则文件时 `measured`，否则 `absent`），`readOnly=true`。文件存在不等于客户端已读取；受管段存在也不等于已安装/已强制。
- 独立于 `configured`：规则检测不依赖配置发现结果，配置缺失时仍独立报告。

测试断言覆盖：有受管段（`hasManagedSection=true`、`formatVersion` 匹配、`readOnly=true`、`verdict=degraded`）、无受管段（`false`、`null`）、marker 畸形（`false` + `malformed` limitation）。

## 7. 未知配置 / 版本不猜测

- 未知条目字段 → `configured=degraded` + `unknown fields: ...` limitation，绝不 `validated`。
- Claude Code `url` 条目缺 `type` → `degraded` + `typeless` limitation。
- JSON 解析失败 → `configured=degraded` + `E2_PARSE_FAILED` 隔离错误。
- TOML 解析失败（T-081 子集不支持的语法）→ `configured=degraded` + `E2_PARSE_FAILED`。
- Codex TOML 为只读：`inspect` 明确 `TOML configs are read-only in v1; apply is refused`；`config` 的 apply 一律降级为 dry-run 报告且零写。
- 不解析、不猜测客户端版本号；未知版本字段不产生 `validated`。

## 8. unverified 层清单

| 层 | 状态 | 原因 |
|---|---|---|
| `mcp` / `tools` / `brief` | `unavailable`（inspect）/ 仅注入验证 | 未对真实客户端执行 stdio 握手；合成/注入 fixture 只证明机制 |
| `configured`（真实环境） | unverified | 未读取真实 `~/.claude.json` / `.mcp.json` / `~/.codex/config.toml` |
| `instructions` | `degraded`（上限） | 只读探测规则文件与受管 marker，未安装、未证明客户端读取 |
| `orchestration` | `degraded` / `unavailable` | 未枚举公开派发接口，显式工作流降级 |
| `history` | `unavailable` | 无授权样本或公开格式；不读真实会话 |
| `output-interception` | `unavailable` | 无公开拦截接口；工具级 hooks 不算 |
| Codex 官方 MCP 文档页 | unverified | 自动抓取 403，仅以 main 分支源码为据 |

## 9. 默认零写与授权边界

- `config` 默认 `mode='dry-run'`：零写，返回 `changes` + `warnings`。
- `mode='apply'` 且授权引用缺少可审计 `statement`（T-080 的 `ClientAuthorizationRef` 无该字段）→ 拒绝，零写，仍报告拟定 `changes`。
- 授权齐备 → 交由 T-081 `applyClientConfig`（`confirm:true`、默认备份、beforeHash 漂移检查、原子写、失败回滚）；适配器自身不写文件。
- Claude Code JSON：授权 apply 成功写入 `mcpServers.ano`，保留其他 MCP 服务与未知字段，并创建 `.ano/clients/backups/claude-code/` 备份；幂等重放为零变化。
- Codex TOML：即使授权齐备也拒绝写（T-081 v1 只读），零写并如实返回 dry-run。
- T-081 约束：apply 要求目标文件已存在（写前会读取原文件）；目标缺失时报 `apply failed: ...; zero write`，不留半写状态。
- 路径边界：`allowedRoot` 按 scope 绑定（user→home，project/workspace→root），逃逸由 T-081 拒绝。

## 10. 验证输出

| 命令 | 结果 |
|---|---|
| `node --test test/unit/client-claude-code.test.ts test/unit/client-codex.test.ts` | 26 pass / 0 fail |
| `node --test test/unit/client-doctor.test.ts test/unit/client-config.test.ts` | 34 pass / 0 fail（13+21 回归） |
| `npx tsc -p tsconfig.json --noEmit` | exit 0 |

## 11. 移交项 / 风险

1. **T-085（CLI 接入）**：`ClientAuthorizationRef`（T-080 冻结）没有 `statement`，而 T-081 写路径要求 `statement`。适配器以窄结构转换读取 `statement`，缺失即拒绝写。CLI 必须提供含 `statement` 的完整授权凭证，并保留 `--confirm` 人工动作。
2. **默认用户级路径选择**：Claude Code 用户级默认写 `~/.claude.json`（公开文档中 `mcpServers` 所在），`~/.claude/settings.json` 仅作只读探测候选；Codex 默认 `~/.codex/config.toml`。若干预期不同，需在 T-085 对账。
3. **T-081 只读 TOML**：Codex 在本版本无法安装配置，只能 dry-run 提议；如未来放开 TOML 写，需先补 T-081 的可写解析与往返保持。
4. **Codex 证据强度**：官方文档页 403，格式依据为 main 分支源码；发行版字段可能变化，实机核验前保持 `unverified`。
5. **真实环境未实测**：本机无 `claude` / `codex` 可执行，未读真实配置；`configured` / `mcp` / `tools` / `brief` 的真实兼容结论仍为 `unverified`。
6. **DSH / Pi 不在本任务**：由 T-084 `unknown.ts` 处理。
