# Qoder / DSH / Pi 探测与未知客户端扩展入口证据（T-084 / MC-06）

- 日期：2026-11-22
- 任务：T-084 / MC-06（M11），依赖 T-080/T-081
- 执行者：子代理（唯一实现者）；PM 簿记由主控负责
- 交付物：`src/clients/qoder.ts`、`src/clients/unknown.ts`、`test/unit/client-unknown.test.ts`、本报告
- 性质：只读探测 + 合成 fixture；未读取真实会话或秘密，未修改真实客户端配置、`.pm/`、`.ano/`

## 1. 结论

**范围内完成。** Qoder 适配器只使用可核实的公开文档来源与显式本机只读探测；实测事实与配置事实分层标注；DSH/Pi 固定为 `unknown` 降级，全层 `unavailable`，永不 `validated`；第三方扩展入口 `registerExternalAdapter` 严格校验声明，缺字段拒绝，自报 `validated` 在无可信实测证据时被降级。

- Qoder 公开接口已核实：MCP 配置路径、`mcpServers` 键、stdio 条目字段、CLI 管理命令（来源见 §2）。
- Qoder 未核实：版本探测、内部 JSON schema 细节、编排/历史/输出拦截公开接口；这些层在 `inspect` 中全部 `unavailable`。
- DSH/Pi：身份或接口不明确，`status='unknown'`，无路径猜测、无伪造适配、无崩溃；即使注入撒谎 adapter 也保持全层 `unavailable`。
- 第三方扩展：必须提供 `detect/inspect/config/verify` 四实现 + 身份来源 + 能力声明 + 验证证据来源；缺任一拒绝；注册后仍受 ADR-007 verdict 约束；`apply` 一律拒绝；配置内容不执行。

## 2. Qoder 公开接口核实结论

### 2.1 已核实（公开文档）

来源：`https://docs.qoder.com/cli/mcp-servers.md`、`https://docs.qoder.com/cli/mcp-reference.md`、`https://docs.qoder.com/plugins/introduction.md`（均于 2026-11-22 只读获取）。

| 事实 | 结论 | 来源 |
|---|---|---|
| MCP 支持 | 支持；MCP 是集成层，可连接外部数据源 | plugins/introduction |
| 用户级配置 | `~/.qoder/settings.json`，JSON | cli/mcp-servers、cli/mcp-reference |
| 项目级配置 | `<project>/.qoder/settings.json`；`<project>/.mcp.json`，JSON | 同上 |
| 本地级配置 | `<project>/.qoder/settings.local.json`，JSON | 同上 |
| 配置键 | 顶层 `mcpServers`；`.mcp.json` 必须含 `mcpServers` | cli/mcp-reference |
| stdio 条目字段 | `command`、`args`、`env`、`cwd`；`type` 可选，默认 stdio | cli/mcp-reference |
| CLI 管理 | `qoder mcp add <name> -- <command>`、`qoder mcp list`、`qoder mcp remove <name>` | cli/mcp-servers |
| 作用域优先级 | user → project settings.json → project .mcp.json → local → CLI 参数 | cli/mcp-reference |

适配器把这些路径声明为探测候选（`QODER_CONFIG_CANDIDATES`），键固定为 `mcpServers.ano`；未核实的路径一律不声明、不猜测。

### 2.2 本机实测事实（只读，与配置事实分开）

在本机（win32）以只读方式核对：

| 事实 | 观测 |
|---|---|
| Qoder 用户目录 | `~/.qoder/` 存在 |
| 用户级 MCP 配置 | `~/.qoder/settings.json` 存在，顶层含 `mcpServers` |
| 现有 MCP 服务 | `bazhuayu`、`lighthouse-ops`、`chatcut`；未发现 `ano` 条目 |
| CLI 入口 | `~/.qoder/entry/qoder.cmd` 存在（本地事实，非公开文档路径，未纳入声明来源） |

这些是本机实测事实，不等于公开接口承诺；报告用 `measured-fact:` 前缀标注。配置文件中可能出现的环境变量值只保留键名（`envKeys`），值从不进入报告。

### 2.3 未核实（保持 unavailable / unverified）

| 项 | 状态 |
|---|---|
| 客户端版本探测 | 未运行；`version=null`，detected 层因此不超过 `degraded` |
| 内部 JSON schema 细节 | 文档未给出完整 schema；只使用文档明示的 `mcpServers` 键 |
| `instructions`（`.qoder/rules`） | 公开文档提及，但未实测 → `unavailable` + `public-assumption:` |
| `orchestration` | 公开文档描述 CLI scheduled tasks/loop/agent teams，但无公开 MCP 派发接口实测 → `unavailable` |
| `history` | 无授权样本、无实测公开格式 → `unavailable`，不读取 |
| `output-interception` | 无公开接口实测；工具级 hooks 不算输出拦截 → `unavailable` |
| 真实 `qoder mcp add` 安装 ANO | 未执行（会写真实配置，需显式授权） |

## 3. DSH / Pi unknown 结论

- 身份或接口不明确：`getDescriptor('dsh').identityStatus === 'unknown'`，`pi` 同理（registry 只读引用）。
- 处理：只探测不猜接口。`createUnknownAdapter` 的 `identitySources=[]`，`detect` 不读取任何路径，`inspect` 固定 `status='unknown'`、九层 `unavailable`、`evidence='absent'`。
- 上限：verdict 上限 `degraded`，当前实现全层 `unavailable`；`validated` 不可达。
- 防伪造：`enforceUnknownReport` 把任何报告强制回未知降级；`doctorClient` 对 `identityStatus==='unknown'` 的客户端在 adapter 之前直接返回 unknown 报告，注入撒谎 adapter 无效。
- 升级所需（缺一不可）：明确身份来源、公开配置格式、公开派发/历史接口。

## 4. 第三方扩展契约与拒绝样例

### 4.1 注册契约（`registerExternalAdapter(declaration, validation)`）

声明必须提供：

| 字段 | 要求 | 缺失/非法后果 |
|---|---|---|
| `id` | 已知 `ClientId`；拒绝 `dsh`/`pi` | `ID_UNKNOWN` / `ID_IDENTITY_UNKNOWN` |
| `identitySources` | 非空数组，元素含已知 `kind` 与非空 `value` | `IDENTITY_SOURCES_MISSING` / `IDENTITY_SOURCE_INVALID` |
| `detect`/`inspect`/`config`/`verify` | 均为函数 | `DETECT_MISSING` 等 |
| `capabilities.layers` | 非空、均为九层之一 | `CAPABILITIES_MISSING` / `CAPABILITY_LAYERS_INVALID` |
| `evidence.source` | 非空字符串 | `EVIDENCE_SOURCE_MISSING` |
| `evidence.measured` | 布尔；为 true 时必须有 `measuredAt` 与显式 `version` | `EVIDENCE_MEASURED_INVALID` / `EVIDENCE_MEASURED_AT_MISSING` / `EVIDENCE_VERSION_MISSING` |
| `validation.evidenceSource` | 非空字符串 | `VALIDATION_SOURCE_MISSING` |
| `validation.measured` | 布尔 | `VALIDATION_MEASURED_INVALID` |
| `validation.check`（可选） | 函数；返回 false 拒绝 | `VALIDATION_CHECK_FAILED` |

注册后约束：

- 无可信实测证据（`declaration.evidence.measured && validation.measured && measuredAt`）时，任何自报 `validated` 层降为 `degraded`、`measured` 证据降为 `assumed`，并记录 `E_EXTERNAL_VERDICT_CAPPED`；`status` 不得为 `ready`。
- `verify` 的自报 `validated` verdict 同样被降级。
- `config` 返回 `apply` 时被拒绝，返回零写 dry-run 与 `config-refused` 警告。
- 配置内容只作为数据处理，不 eval、不 shell、不动态加载。

### 4.2 拒绝样例（测试覆盖）

| 场景 | 结果 |
|---|---|
| `declaration = {}` | `DECLARATION_NOT_OBJECT` |
| 删除 `detect`/`inspect`/`config`/`verify` 任一 | 对应 `*_MISSING` |
| `capabilities` 缺失 | `CAPABILITIES_MISSING` |
| `evidence.source=''` | `EVIDENCE_SOURCE_MISSING` |
| `id='not-a-client'` | `ID_UNKNOWN` |
| `id='dsh'` | `ID_IDENTITY_UNKNOWN` |
| `identitySources=[]` | `IDENTITY_SOURCES_MISSING` |
| `measured:true` 但无 `measuredAt`/`version` | `EVIDENCE_MEASURED_AT_MISSING`、`EVIDENCE_VERSION_MISSING` |
| `validation.evidenceSource=''` | `VALIDATION_SOURCE_MISSING` |
| `validation.check=()=>false` | `VALIDATION_CHECK_FAILED` |
| 自报 `validated` 但 `validation.measured=false` | 注册成功但 inspect 层降级为 `degraded`/`assumed`，`status != ready` |
| `config` 返回 `apply` | 包装层返回 dry-run、零 changes、`config-refused` |

## 5. 测试与验证

| 命令 | 结果 |
|---|---|
| `node --test test/unit/client-unknown.test.ts` | 28/28 通过 |
| `node --test test/unit/client-doctor.test.ts test/unit/client-config.test.ts` | 34/34 通过（回归） |
| `npx tsc -p tsconfig.json --noEmit` | 本任务文件 0 错误；并行任务（T-082/T-083）在途文件有错，已注明 |

验收对照：

| 验收项 | 落实 |
|---|---|
| 未知客户端不崩溃/不伪造适配 | `createUnknownAdapter` 全接口无副作用；`doctorClient` 注入撒谎 adapter 仍 unknown |
| DSH/Pi 明确缺身份或接口 | `status='unknown'` 断言 + registry `identityStatus='unknown'` 断言 |
| Qoder 实测与配置事实分开 | `measured-fact:` / `config-fact:` / `public-assumption:` 分层断言；env 值脱敏 |
| 第三方扩展必须提供探测/能力/验证 | 四实现 + capabilities + evidence 缺字段拒绝；自报 validated 被拒/降级 |

## 6. 限制与未验证

1. Qoder 真实安装（`qoder mcp add`）未执行；配置写入能力归 T-081 配置服务，本适配器只提议。
2. Qoder `version` 未探测；`detected` 层上限 `degraded`。
3. Qoder `instructions/orchestration/history/output-interception` 无实测依据，保持 `unavailable`。
4. DSH/Pi 身份与接口未知，未探测任何路径；升级需先补齐公开身份/接口证据。
5. 第三方扩展的 `config` 实现本身若包含副作用，包装层只能拒绝 `apply` 返回，无法阻止声明内任意 JS 的副作用；注册方需自行审计（文档明示）。
