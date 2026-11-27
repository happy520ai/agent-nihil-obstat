# DeepSeek Harness（`dsh`）适配器证据报告（T-097 / CX-07）

- 日期：2026-11-23
- 任务：T-097（M12 / CX-07，DSH 语义变更换轨）
- 交付：`src/clients/deepseek-harness.ts`、`src/clients/unknown.ts`、`test/unit/client-deepseek-harness.test.ts`、本报告
- 性质：只读探测 + 合成 fixture 验证。未读取真实客户端配置内容，未修改用户级配置，未执行配置内容，未新增第八个 MCP 工具。
- 上游契约：`docs/adr/ADR-008-full-client-catalog.md` §3/§4.3/§4.5/§5/§6/§8/§10、`docs/adr/ADR-007-client-adapters.md`、`src/clients/types.ts`（T-092）、`src/clients/registry.ts`（T-092）、`src/clients/doctor.ts`、`src/clients/config.ts`（T-081）。

## 1. 结论

1. DeepSeek Harness 是真实产品：官方产品页、官方仓库（MIT）、官方文档站三处公开来源可核实（§2）。因此客户端级身份状态为 `declared`，不再是 M11 的 `unknown`；`dsh` 是 `deepseek-harness` 的别名，由 registry 解析，不新增 `ClientId`。
2. 适配器实现 `ClientAdapter` 四接口：`detect` 只读探测声明来源；`inspect` 输出九层报告；`config` 默认 dry-run 零写并拒绝 apply；`verify` 委托 T-080 真实 stdio 握手（可注入）。
3. 能力层按证据判定：本机未实测一律不判 `validated`。未探测时 `detected/configured/mcp/tools/brief` 为 `unavailable`；探测到声明来源但未实测时 `mcp/tools/brief` 为 `degraded` + `evidence='assumed'`（不是旧规则的“永远 `unavailable`”）。
4. **不冒充**：ANO 作为 MCP server 由 DSH 的 MCP 客户端 `@deepseek-ai/dsh-mcp-client` 加载；DSH 的 ACP stdio（`dsh --profile acp`）与 SDK stdio JSON-RPC（`dsh --profile sdk`）是 DSH 自身接口，适配器显式拒绝把它们当作 ANO MCP 七工具验证（`E3_DSH_PROFILE_NOT_MCP`）。
5. **不伪造可写**：DSH 配置载体是 Cordis YAML（`cordis.yml`、`$DSH_HOME/cordis.patch.yml`），T-081 配置服务 v1 仅支持 `json|toml`，因此 `config()` 恒返回 dry-run 零写并声明格式不支持/待核实，不生成伪造的 YAML 写入目标。
6. `pi` 的 M11 unknown 语义不变：`UNKNOWN_CLIENT_IDS=['pi']`，`createUnknownAdapter('pi')` 仍全层 `unavailable`、`status='unknown`；`enforceUnknownReport` 只对仍为 unknown 的客户端生效，对 `deepseek-harness` 不再强制全层 `unavailable`。

## 2. E1 公开来源清单（含本次实测抓取）

| 来源 | 等级 | 本次核实方式 | 结论 |
|---|---|---|---|
| https://deepseek.com/harness | E0/E1 | 2026-11-23 WebFetch 成功 | 产品页存在；DeepSeek Harness（简称 DSH），杭州深度求索人工智能基础技术研究有限公司；MIT 开源；Cordis「一切皆插件」架构；CLI 启动 `npx @deepseek-ai/dsh web`；桌面 App（macOS ARM / Windows 64）+ Web UI；预览版。产品页未明示 MCP/ACP。 |
| https://github.com/deepseek-ai/deepseek-harness | E1 | 2026-11-23 WebFetch 成功 | 仓库存在；owner `deepseek-ai`；license MIT；描述为 DeepSeek AI 开发的开源 agent harness，「everything-is-a-plugin」；README 出现 CLI `dpx @deepseek-ai/dsh web` / `pnpm dsh web`，并说明「powered by Cordis」。 |
| https://deepseek-harness.github.io/deepseek-harness/ | E1 | 2026-11-23 WebFetch 可达但页面为 JS 渲染，正文未提取 | 文档站域名可达；子页正文在本机抓取中不可提取。详细接口清单沿用 ADR-008 §8 已核实条目（见 §4），标注为「E1（ADR-008 §8 清单，本次未逐页复抓）」。 |

- 产品身份结论：**DeepSeek Harness（DeepSeek 官方，MIT，TypeScript 为主）**，别名 `dsh`。
- 名称澄清：`dsh` 是 `deepseek-harness` 的别名，不是独立产品，也不是 `ClientId`。
- 本任务不读取 `$DSH_HOME/.credentials.yaml`，不回显任何凭证。

## 3. 本机真实探测结果（留证）

执行环境：win32 10.0.19041，Node v24.x，工作目录 `F:\Agent Nihil Obstat`。均为只读存在性核对，未执行客户端、未读取配置内容。

| 探测 | 命令 | 结果 |
|---|---|---|
| `dsh` 可执行 | `command -v dsh` | 未找到（not found） |
| `DSH_HOME` 环境变量 | `echo ${DSH_HOME:-<unset>}` | 未设置（unset） |
| `~/.dsh` | `lstat` | missing |
| `~/.deepseek` | `lstat` | missing |
| `~/.config/dsh` | `lstat` | missing |
| npm 全局 deepseek 包 | `npm ls -g --depth=0 \| grep -i deepseek` | 无 |

结论：本机未发现 `dsh` 可执行与 `$DSH_HOME`，因此真实环境下 `detected` 层应判 `unavailable`；合成 fixture 只证明机制，不证明真实客户端兼容。

## 4. MCP / CLI / API / 规则接口分层结论

| 接口 | 结论 | 证据等级 | 来源 |
|---|---|---|---|
| CLI 可执行 `dsh` | 存在（`npx @deepseek-ai/dsh web`；profiles `web/headless/sdk/sdk-minimal/acp`） | E1（ADR-008 §8；产品页 + 仓库 README 实测到 `dsh`/Cordis） | 产品页、仓库 README、docs/cli-help |
| 配置载体 Cordis YAML | `cordis.yml`；用户 patch `$DSH_HOME/cordis.patch.yml`、`$DSH_HOME/profiles/<name>/cordis.patch.yml`；`dsh --dump-config` | E1（ADR-008 §8 清单） | docs/architecture、docs/user/guide/mcp-memory |
| MCP 接口 | DSH 是 MCP **客户端**：`@deepseek-ai/dsh-mcp-client`，暴露 `mcp__<serverName>__<tool>`；ANO 作为 MCP server 被加载 | E1（ADR-008 §8 清单） | docs/user/guide/mcp-memory、docs/tool-catalog |
| ACP / SDK | ACP stdio `dsh --profile acp`；SDK stdio JSON-RPC `dsh --profile sdk` | E1（ADR-008 §8 清单） | docs/cli-help、docs/architecture |
| 插件 API | `dsh plugin`、`plugin.json`、`dsh-plugin` topic | E1（ADR-008 §8 清单） | docs/cli-help、docs/architecture |
| 凭证 | `$DSH_HOME/.credentials.yaml`（write-only，报告不得回显） | E1（ADR-008 §8 清单） | docs/user/guide/providers |
| 项目规则/指令 | 未核实到公开规则文件接口 | 待核实 | 本任务不猜规则路径，`rulePaths` 为空 |

**ANO 接入路径**：在 DSH 的 Cordis 配置层添加 `ano` stdio 行（`mcp__ano__*`），载体为 `cordis.patch.yml`。`configured` 层只验证声明载体存在与路径可达；`mcp`/`tools`/`brief` 验证 ANO 包本身（独立 stdio 握手），与 DSH 进程无关。

**接口不混同**：`verify()` 只做 MCP `initialize` + `tools/list` + `brief`；当 `command` 是 `dsh --profile <acp|sdk|sdk-minimal|web|headless>` 时直接拒绝（`E3_DSH_PROFILE_NOT_MCP`），因为 ACP/SDK 握手不是 ANO MCP 七工具验证。

## 5. dsh 语义变更记录（M11 → M12）

| 维度 | M11（ADR-007 §7，已废弃） | M12（ADR-008 §8，现行） |
|---|---|---|
| 身份状态 | `unknown`（永久） | `declared`（E1 公开来源核实） |
| `UNKNOWN_CLIENT_IDS` | `['dsh','pi']` | `['pi']` |
| `dsh` 别名 | 无（作为独立 unknown id） | `dsh` → `deepseek-harness`（registry 解析） |
| 能力层 | 全层 `unavailable`，`validated` 不可达 | 按证据判定；未实测 `degraded`/`assumed`，实测可升级 |
| `enforceUnknownReport` | 对 dsh 强制全层 `unavailable` | 仅对仍为 unknown 的 `pi` 生效；deepseek-harness 不强制 |
| `dshAdapter` | unknown 降级适配器 | 真实 DeepSeek Harness 适配器的向后兼容再导出 |
| 升级路径 | 无 | E1 公开接口 → E3 本机命令实测 → E4 真实 stdio 握手，逐层升级 |
| 降级路径 | 永久 | 无公开接口/本机不可达的层显式 `unavailable`/`degraded` + limitations |

- `pi` 行为不变：仍为 `unknown`，全层 `unavailable`，`validated` 不可达（其身份核实不在 M12 范围，但不再适用永久禁令语义）。
- 第三方扩展严格校验保持：四接口 + 能力声明 + 证据来源齐全；自报 `validated`/`measured` 无受信实测证据时降级；`apply` 一律拒绝。`pi` 仍拒绝外部适配器认领（`ID_IDENTITY_UNKNOWN`）。

## 6. 不猜私有路径/格式声明

1. `detect` 只遍历 `DEEPSEEK_HARNESS_IDENTITY_SOURCES`（registry 声明的 `dsh` 可执行、`DSH_HOME` 环境变量、`cordis.yml`、`$DSH_HOME/cordis.patch.yml`）。`$DSH_HOME` 未设置时跳过对应候选，不退化猜测 `~/.dsh` 等私有路径。
2. 不探测 `%APPDATA%`、npm 全局目录、`node_modules` 深度等未声明位置；`npx @deepseek-ai/dsh` 作为公开 CLI 身份记录，不在本机做 npx 解析。
3. 不解析 Cordis YAML：`cordis.patch.yml` 的具体 patch schema 标 `待核实`，`configCandidates.key=null`；报告只声明文件存在性，不回显内容。
4. 不生成伪造的 YAML 写入目标；T-081 仅支持 `json|toml`，故 `config()` 恒 dry-run 零写。
5. 不把产品宣传（E0）当作接口证据；接口载体均来自 ADR-008 §8 的 E1 清单或本机实测。

## 7. 降级与不冒充声明

- 本机未探测到声明来源：`detected/configured/mcp/tools/brief` = `unavailable`，`status='unavailable'`，limitations 明示「本机未发现 dsh 可执行与 $DSH_HOME」。
- 探测到声明来源但未实测：`mcp/tools/brief` = `degraded` + `evidence='assumed'`，绝不 `validated`；`coreVerdict` 最弱值，`status='degraded'`。
- `inspect` 不做握手；`mcp/tools/brief` 的 `validated` 只能来自 `verify()` 的真实/注入 stdio 握手（ANO MCP 包本身）。
- 握手成功不得表述为「已配置」或「已接管」；七工具可用不得表述为「DAG 已接管」「历史已支持」「输出可拦截」。
- `history` 恒 `unavailable`（无授权样本，不读真实会话）；`output-interception` 恒 `unavailable`（工具级 hooks 不算输出拦截）。
- ACP/SDK 握手不得当作 ANO MCP 七工具验证（`E3_DSH_PROFILE_NOT_MCP`）。

## 8. 测试与回归结果

| 命令 | 结果 |
|---|---|
| `node --test test/unit/client-deepseek-harness.test.ts` | 16 tests，16 pass，0 fail |
| `node --test test/unit/client-doctor.test.ts` | 19 tests，19 pass，0 fail |
| `npx tsc -p tsconfig.json --noEmit` | 本任务文件 0 error；残余错误来自并行任务（T-094 `test/unit/client-cloud-ide.test.ts` 等）在途文件 |

新增测试覆盖：产品身份与公开接口来源、`dsh` 别名可用且非 unknown、未实测不 `validated` 但非永久禁令、`enforceUnknownReport` 不再强制 deepseek-harness、ACP/SDK 不冒充 MCP、ANO MCP 七工具注入握手、默认零写与 apply 拒绝、不猜私有路径、`pi` 仍 unknown、第三方扩展拒绝语义保持、九层报告形状。

## 9. 移交项

1. **表面 wiring 键位**：`src/surface/service.ts` 与 `test/integration/client-takeover.test.ts` 仍以 `dsh: dshAdapter` 键控。doctor 按 `descriptor.id='deepseek-harness` 查 `adapters`，故 `dsh` 键不会被命中。建议 T-085/收口任务把键改为 `deepseek-harness` 并传入带注入路径的适配器实例；本任务受文件边界限制未改这两个文件。
2. **Cordis YAML 写入**：T-081 v1 不支持 YAML。若后续要支持 DSH 配置安装，需先在 T-081 增加 YAML 读写与 patch 合并，并核实 `cordis.patch.yml` 的 patch schema（当前 `key=null`、待核实）。本任务不伪造该能力。
3. **文档站复抓**：官方文档站为 JS 渲染，本机 WebFetch 未能提取子页正文；ADR-008 §8 的接口清单需在有浏览器渲染的环境中逐页复核后再升级为本地 `measured`。
4. **真实环境升级路径**：在装有 DSH 的机器上运行 `dsh --version`/`dsh --dump-config`（E3）与 ANO MCP stdio 握手（E4），按 §4.5 逐层升级；当前一律 `unverified`。
5. **`npx` 包探测**：未在本机探测 `@deepseek-ai/dsh` 的 npx 解析；如需 E2 证据，应在声明来源中显式加入包管理器探测，而不是猜测安装目录。
