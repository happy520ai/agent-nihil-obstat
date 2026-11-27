# ANO 使用说明（P0–P7 本地 alpha）

> 这是本地 alpha，不是已发布产品。MCP 仍为七工具；原生任务 `track` 仅 task/create，Connect 增加独立的 connection 接入生命周期。接入保留来源业务状态，不等于 ANO 验收或完整主写接管。

## 构建与验证

```sh
npm ci
npm --prefix scripts ci        # Spike 测试工具链（缺失时 npm test 会显式 SKIP 并打印）
npm run typecheck
npm test                       # 根套件 + spike 套件 + 文档一致性
npm run coverage               # 门槛：行 ≥90%、分支 ≥80%
npm run build
node scripts/verify-all.ts     # 全链路：schema/覆盖率/真实 ZCode MCP/打包冒烟
```

启动真实 stdio MCP：

```sh
node dist/surface/mcp.js
```

MCP server 名为 `ano`，恰有 7 个意图工具：`brief`、`explore`、`recall`、`track`、`note`、`verify`、`audit`。
七工具已接通：`brief`、`explore`、`recall`、`track(kind=task,operation=create|update|complete|cancel|reopen)`、`track(kind=connection,...)`、`note`、`verify(task/release/context)`、`audit`。`complete` 必须携带已记录的 Gate `evidence_id`，裸 `done` 被拒绝。
`recall` 默认查询 `.ano/memory/synthetic/**` 合成历史；`source=connected` 查询显式 Connect 接入的 PM 历史，不扫描客户端。release 裁决必须提供真实 `artifact_path`，不是人工放行。
P2 分支（仍在七工具内，旧参数与结果形状不变）：`brief` 可选 `include_memory_context=true` 与 `context_budget`，冻结派生 probe manifest；`recall` 可选 `mode=probe`（只读 AnchorProbe，不冻结、不写账本）；`note` 可选 `operation=revise|relate`；`verify` 可选 `scope=context`（只读校验结构化 draft，不产生 Gate 凭证）。

## 个人模式与 setup（M21）

```sh
ano setup --root "/absolute/path/to/project" --client zcode --yes-dry-run
ano setup --root "/absolute/path/to/project" --client zcode  # 真实 TTY，逐步确认
ano help --all
ano doctor clients --all
```

- 无 `.ano/config.toml` 的旧项目按 `full`，不迁移；setup 新配置为 `profile="personal"`、`hooks.mode="advisory"`。
- 非 TTY 与 `--yes-dry-run` 只输出计划，零写入。TTY 必须填写具名授权人；已有 `.pm` 时依次确认 grant/apply，随后分别确认 hooks 与 config；已处于 `enforced` 的项目保留原授权，不重复接管。
- `doctor` 预检或收尾出现失败时，setup 报告停止，不声称成功。Git 项目无需在根目录放置 `package.json`，缺失仅提示。
- 全局安装的 hooks 只处理绑定项目及其子目录；其他项目的事件不读写该项目账本、不注入上下文、不作权限决定。旧安装需在真实 TTY 重新运行 setup 并确认 hooks 更新，源码更新本身不会改写用户配置。
- 每一步拒绝即停止；失败或中止时，结果中的 `rollback` 给出已完成步骤的 disable/restore 命令，不删除账本历史。

## Connect：接入已有项目

```sh
ano connect ui --root "/absolute/path/to/project"
ano connect plan --root "/absolute/path/to/project"  # 只读预检，不创建 .ano
ano connect --root "/absolute/path/to/project"       # 自动预检并接入
ano connect status --root "/absolute/path/to/project"
ano connect resume --root "/absolute/path/to/project"
ano connect watch --root "/absolute/path/to/project" --interval 1000 # 显式前台持续刷新
ano recall --source connected --query "下一步" --root "/absolute/path/to/project"
ano connect export --root "/absolute/path/to/project"
ano connect handoff --root "/absolute/path/to/project" # 当前报告阻止接管，非零退出
```

### 迁移为 ANO 主导（M7）

```sh
ano migrate plan --root "/absolute/path/to/project"                                  # 只读预检，零写
ano migrate apply --root "/absolute/path/to/project" --expected-source-digest <sha256>
ano migrate status --root "/absolute/path/to/project"                                # 来源与原生任务对账
ano migrate reconcile --root "/absolute/path/to/project"
```

`plan` 只读 `.pm/` 并给出任务映射、来源摘要与冲突；`apply` 必须回传 `plan` 的 `sourceDigest`，来源在计划后变化或摘要不匹配时拒绝且零写。迁移只写 `.ano/ledger`，不改写 `.pm/`。来源 `done` 映射为 `in_progress + verified=false`，不能直接成为 ANO `done`。MCP 侧对应 `track(kind=connection, operation=migrate_plan|migrate_apply|reconcile)`。

备份与人工 cutover：

```sh
ano migrate backup --root "/absolute/path/to/project"
ano migrate list-backups --root "/absolute/path/to/project"
ano migrate restore --root "/absolute/path/to/project" --backup-id <id>
ano connect cutover status --root "/absolute/path/to/project"
ano connect cutover confirm --root "/absolute/path/to/project" --name <human> --role <role> --statement <text> --source-digest <migrate-plan-digest> --backup-id <id> --confirm
```

`handoff` 仅在迁移对账干净、存在校验通过的备份且具名确认绑定当前摘要与备份时 `ready=true`；否则返回具体 blocker。确认动作不修改客户端配置、不停用 PM-mcp。

`ano connect ui` 输出仅本机授权地址，打开后点击开始使用；不需要编辑项目配置。Connect 允许非 Node、非 Git 根目录，代码验证功能仍遵守原有环境要求。只读取选定根目录下的 `.pm/`；不修改 `.pm/`、全局配置或 `AGENTS.md`。默认 `connect`/`status` 不自动持续同步；显式运行 `connect watch` 时，ANO 在前台按周期刷新只读快照，不写回 `.pm/`，可用 `--max-cycles` 有界运行或由中止信号停止。

完整说明、数据范围与退出边界见 [connect.md](connect.md)。导出包包含原始历史，视为敏感资料；不要默认发送外部服务或提交版本库。

## 强制接管（M10 / ADR-006）

强制接管把一个**已授权项目**的旧 PM-mcp 主写降级为只读，由 ANO 主写任务、记忆、验收与 DAG。它是一次显式授权 + 六阶段事务 + 三态可恢复状态机；未授权项目仍是 Connect 普通模式（PM-mcp 主写、ANO 只读）。接管不改变宿主权限、不自动批准、不自动发布、不读取秘密。协议见 [takeover.md](takeover.md)。

### 一次授权与接管

```sh
ano takeover grant --root "/absolute/path/to/project" \
  --scope tasks,memory,acceptance,dag \
  --granted-by "具名人工" --role "角色" --statement "授权 ANO 接管本项目"
ano takeover apply --root "/absolute/path/to/project" --authorization-id <64位sha256> --confirm
ano takeover status --root "/absolute/path/to/project"
```

- `grant` 只写 `.ano/takeover/authorization.json`，不改 `.pm/`、`AGENTS.md`、MCP 配置或用户级配置；返回的 `authorization.authorizationId` 用于 `apply`。
- `--scope` 必须是 `tasks|memory|acceptance|dag` 的逗号分隔子集且去重；四项缺一不可，否则 `apply` 因受管 `AGENTS.md` 段无法安装而拒绝（`grant` 本身允许子集）。
- `--granted-by`/`--role`/`--statement` 均必填；`--granted-at <iso>` 可选，默认当前 UTC。
- `apply` 必须同时给出 `--authorization-id`（64 位 sha256 十六进制）与显式 `--confirm`；缺任一即拒绝且零写。六阶段 `prepared→migrated→reconciled→verified→installed→active` 完成后策略为 `enforced`，退出码 0；任一阶段失败记 `aborted`，`active` 之前零主写副作用。
- 授权绑定 canonical root；跨 root 调用拒绝，移动或复制项目后需重新 `grant`。同 `(authorizationId, sourceDigest, backupHash)` 重放返回既有记录，不重复备份。

### 状态检查

```sh
ano takeover status --root "/absolute/path/to/project"
```

输出 `state`、`policy`、`authorization`、`transaction`/`transactions`、`hostCapability`、`baselineDigest`、`enforcedAt`、`artifacts`；`enforced` 时附只读 `drift` 报告。策略或日志损坏时 `state=unknown`（退出码 1），不会猜成 `disabled`。`hostCapability` 在 CLI/MCP 路径固定为 `degraded`。

### 退出、恢复与撤销

```sh
ano takeover disable --root "/absolute/path/to/project" --confirm
ano takeover recover --root "/absolute/path/to/project" --confirm
ano takeover revoke --root "/absolute/path/to/project" --confirm
```

- `disable`：`enforced → recovery`；受管 `AGENTS.md` 段声明先翻转为 `recovery`，权威切换失败时回滚声明。
- `recover`：`recovery → disabled`；用校验通过的备份恢复 `.pm/`、移除受管段（还原原字节）、状态转 `disabled`。接管期间 ledger 事件、备份目录与事务日志保留。
- `revoke`：写 `revokedAt`，授权永久失效；`enforced` 时同时转 `recovery`，`disabled` 时只写 `revokedAt`。已撤销授权不能 `apply`。
- 三者都需要显式 `--confirm`；`recovery` 中不能 `revoke`，需先 `recover`。
- `revoke` 后仍可 `recover`（`allowRevokedRemoval` 仅用于移除受管段）；要再次接管须重新 `grant` 并走完六阶段。

### 权限边界

- 接管授权是项目内本地记录，不是 token：不改变 MCP 工具权限、不代批 PermissionRequest、不改宿主批准策略、不改用户级配置。
- 宿主无输出拦截接口，hooks 是工具级闸门且未用于 ANO，无自动启动/自动批准能力；`hostCapability=degraded`。权限仍需具名人工在宿主处理，新会话权限不能由 ANO 代批。
- 发布 approve、attest、release approve、sync、push 仍是具名人工动作，不暴露给接管工作流，也不由接管自动触发。

### 旧 PM 只读

- `enforced` 下旧 PM（PM-mcp 与 `.pm/`）是只读角色：`brief`/`handoff` 报告 `legacyPm=read-only`；ANO 的 `track`/`note`/`verify` 写 ANO 账本，不向 `.pm/` 回写。
- `enforced` 下旧源 `migrate apply` 等 Connect 写路径被拒绝并给出提示；外部写入 `.pm/` 只产生漂移报告（`.ano/takeover/drift/`），不自动双写或回写，对账报告转 `stale`。
- PM-mcp 停用仍是用户手动动作；接管不自动停用、不改客户端配置。

## ZCode 接入（用户级唯一登记）

本仓库的 `ano` 只登记一次：用户级 `~/.zcode/cli/config.json` 的 `mcp.servers.ano`。工作区 `.zcode/config.json` 保持空容器，继承用户级登记，避免同名来源冲突：

```json
{
  "mcp": {
    "servers": {}
  }
}
```

如果改走**单项目固定配置**，也可以只在工作区 `.zcode/config.json` 注册 `ano`（以下为可选形态，不能与用户级 `ano` 同时启用）：

```json
{
  "mcp": {
    "servers": {
      "ano": {
        "type": "stdio",
        "command": "C:/Program Files/nodejs/node.exe",
        "args": ["<repo>/dist/surface/mcp.js"],
        "cwd": "<repo>",
        "env": { "ANO_ROOT": "<repo>" },
        "enabled": true,
        "timeoutMs": 60000
      }
    }
  }
}
```

- `command`、`args[0]`、`cwd`、`env.ANO_ROOT` 必须是**绝对路径**；不要写裸 `node` 或相对路径。Windows 的 JSON 反斜杠要写成 `\\`；含空格路径直接作为 JSON 字符串即可。
- 单项目固定配置中 `env.ANO_ROOT` 与 `cwd` 应指向同一工作区，服务器据此决定 `.ano/` 的位置；用户级多项目登记不设置二者。
- 修改配置后必须在 ZCode **Settings → MCP** 中重启/重连 `ano`，必要时重启客户端；否则当前会话仍使用旧进程和旧环境。
- 真实验证：`npm run build && node scripts/verify-zcode-mcp.ts`（解析实际生效的 `ano` 登记、拒绝用户级/工作区双登记、真实 stdio 连接、恰 7 工具、写 `docs/evidence/zcode-mcp.json`）；`node --test test/integration/zcode-config.test.ts`（去重契约 + 临时目录真实启动 + 证据未过期校验）。
- 七工具均已接通声明范围；原生 `track` 仅 `task/create`，接入走 `connection` 分支；release verify 需要真实 `artifact_path`；`audit` 覆盖本地五个 scope，联网需 `confirm=true`。baseline approve、attest、release approve、sync、push 不暴露给 MCP。
- 换机器或移动仓库后必须更新用户级 wrapper、Node 绝对路径（如使用单项目配置则还有 `args[0]`/`cwd`/`ANO_ROOT`）并重新验证。完整说明见 [zcode-integration.md](zcode-integration.md)。

## 多客户端自适应接入（M11 / ADR-007）

`ano` 用统一能力探针按宿主真实能力分层报告并自动降级。客户端接入是 **CLI-only**，不新增第八个 MCP 工具。默认**只读探测**：`doctor clients` / `doctor client <id>` 只读取证，零写、不读真实会话内容、不回显秘密。写配置是单独的显式授权流程。

### 探测（只读，默认零写）

```sh
ano doctor clients [--json] [--root <path>] [--home <path>] [--env KEY=VALUE] [--probe-path <dir>] [--timeout-ms <ms>]
ano doctor client <id>  [--json] [--root <path>] [--home <path>] [--env KEY=VALUE] [--probe-path <dir>] [--timeout-ms <ms>]
```

- `cloudcode` 解析为 `claude-code`（alias）；未知 id 拒绝（exit 2）。
- 输出 `ano.client-doctor-report/1` / `ano.client-report/1`：九层 `detected/configured/mcp/tools/brief/instructions/orchestration/history/output-interception`，每层含 `verdict/evidence/at/version/source/limitations`。
- `inspect` 不做 stdio 握手，因此 `mcp/tools/brief` 在纯 `doctor` 下恒为 `unavailable`；`validated` 只能来自真实 stdio 验证（见下表 ZCode 依据）。

### 安装（显式授权 + 备份 + 原子写）

```sh
ano clients install <id> --granted-by <name> --statement <text> \
  --scope <detect|inspect|config|install|restore>[,...] \
  [--confirm] [--dry-run] [--config-scope <user|project|workspace>] \
  [--config-path <path>] [--home <path>] [--role <role>] [--granted-at <iso>] [--json]
```

- **默认 dry-run，零写**。只有同时给出 `--confirm` 且未显式 `--dry-run` 才应用。显式 `--dry-run` 退出码 0；未显式 `--dry-run` 的 dry-run 退出码 1（表示未应用，不是失败）。
- `--scope` 必须包含 `config` 与 `install`；`--granted-by`/`--statement` 均必填；`--granted-at` 必须是 ISO-8601 UTC。
- `--config-scope` 默认 `project`；`--config-path` 显式覆写必须位于声明作用域内（`user`→home，`project`/`workspace`→root），敏感文件名/目录（`.env*`、secrets/credentials/token/private-key、`credentials.json`、`id_rsa`/`id_ed25519` 等）拒绝且零写。
- apply 前：内容哈希备份（`.ano/clients/backups/<clientId>/<id>/` + manifest）、`beforeHash` 漂移检查、原子合并（只增改 `ano`，保留其他 MCP 服务与未知字段）、提交安装记录；失败回滚，不留半写状态。
- 可写客户端：`claude-code`、`codex`、`cursor`、`opencode`。`qoder`/`dsh`/`pi`/`zcode` 如实拒绝写；`codex` 因 TOML v1 只读，即使授权齐备也只返回 dry-run。

### 恢复（只接受校验通过且绑定同一目标的备份）

```sh
ano clients restore <id> --backup-id <id> --granted-by <name> --statement <text> \
  --scope <detect|inspect|config|install|restore>[,...] \
  [--confirm] [--dry-run] [--config-scope <user|project|workspace>] \
  [--config-path <path>] [--home <path>] [--role <role>] [--granted-at <iso>] [--json]
```

- `--scope` 必须包含 `restore`；`--backup-id` 必填。
- 只恢复 manifest 校验通过、且 `targetPath` 与当前解析目标一致的备份；不匹配拒绝。默认 dry-run，`--confirm` 才写。

### 每个客户端的真实支持状态与降级语义

五列口径：MCP = 核心五层最弱值（只表示 ANO 包可配置并调用七工具）；规则接管 = `instructions`（只读上限 `degraded`）；DAG = `orchestration`（无公开派发接口时为 `degraded` + `explicit-workflow`）；历史 = `history`；输出拦截 = `output-interception`。

| 客户端 | MCP | 规则接管 | DAG | 历史 | 输出拦截 | 降级语义 |
|---|---|---|---|---|---|---|
| ZCode | `validated`（限可配置+七工具） | `degraded` | `degraded` | `unavailable` | `unavailable` | 受管段只读；显式工作流；宿主无拦截/自动启动/自动批准（`hostCapability=degraded`） |
| Claude Code / cloudcode | `degraded` | `degraded` | `degraded` | `unavailable` | `unavailable` | 本机无 `claude` 可执行、未读真实配置；`CLAUDE.md` 受管段只读检测 |
| Codex | `degraded` | `degraded` | `degraded` | `unavailable` | `unavailable` | TOML v1 只读，apply 拒绝；`AGENTS.md` 受管段只读检测 |
| Cursor | `unavailable` | `unavailable` | `unavailable` | `unavailable` | `unavailable` | 本机未安装，前置不成立；配置格式仍为 `assumed` |
| OpenCode | `unavailable` | `unavailable` | `unavailable` | `unavailable` | `unavailable` | 本机未安装，前置不成立；路径口径差异保留为限制 |
| Qoder | `degraded` | `unavailable` | `unavailable` | `unavailable` | `unavailable` | 有目录无版本；无 `ano` 条目；规则/派发仅公开假设，未实测 |
| DSH | `unavailable` | `unavailable` | `unavailable` | `unavailable` | `unavailable` | 客户端 `status='unknown'`，只探测不猜，永不 `validated` |
| Pi | `unavailable` | `unavailable` | `unavailable` | `unavailable` | `unavailable` | 同上 |

- ZCode 的 `validated` 依据 T-055 真实 stdio、`test/integration/mcp.test.ts` 9/9 与 `docs/evidence/zcode-mcp.json`，不来自 `doctor` 的 `inspect`。
- 不放大：MCP 握手成功 ≠ `configured` ≠ 完整接管；`brief` 成功 ≠ 宿主自动启动/自动批准。合成 fixture 只证明机制，不证明真实客户端兼容。
- 完整矩阵与机器可读版本见 [client-compatibility.md](client-compatibility.md) §11 与 [evidence/client-support-matrix.json](evidence/client-support-matrix.json)。

## 全 24 工具接入 / 恢复指南（M12 / ADR-008）

M12 把客户端目录扩展到 24 个（ADR-008 的 21 个编码工具 + M11 既有的 `opencode`/`pi`/`zcode`）。接入仍是 **CLI-only**，默认只读 + dry-run；写配置是单独的显式授权流程。完整矩阵见 [client-compatibility.md](client-compatibility.md) §12/§13 与 [evidence/client-support-matrix.json](evidence/client-support-matrix.json)。

### 探测（只读，默认零写）

```sh
ano doctor clients [--json] [--plan] [--root <path>] [--home <path>] [--env KEY=VALUE] [--probe-path <dir>] [--timeout-ms <ms>]
ano doctor client <id> [--json] [--root <path>] [--home <path>] [--env KEY=VALUE] [--probe-path <dir>] [--timeout-ms <ms>]
ano clients plan [--json] [--root <path>] [--home <path>] [--env KEY=VALUE] [--probe-path <dir>] [--timeout-ms <ms>]
```

- `doctor clients` 报告全 24 客户端目录（可加 `--plan` 同时渲染接入计划）；`doctor client <id>` 在九层能力外增加四列：公开来源 / 探测 / 配置候选 / 能力；`clients plan` 渲染统一接入计划，每行给出 `route=mcp|rules|cli|explicit-workflow|skip`。
- 别名：`cloudcode`→`claude-code`，`dsh`→`deepseek-harness`；未知 id 拒绝（exit 2）。
- 探测只读取证：零写、不读真实会话内容、不回显秘密（D3 脱敏）；`inspect` 不做 stdio 握手，`mcp/tools/brief` 在纯 `doctor` 下恒为 `unavailable`。
- 全适配 ≠ 全部 `validated`：路线存在只表示有可执行接入路径或明确降级；仅 `zcode` 为 `validated`。

### 安装（显式授权 + 备份 + 原子写）

```sh
ano clients install <id> --granted-by <name> --statement <text> \
  --scope <detect|inspect|config|install|restore>[,...] \
  [--confirm] [--dry-run] [--config-scope <user|project|workspace>] \
  [--config-path <path>] [--home <path>] [--role <role>] [--granted-at <iso>] [--json]
```

- **默认 dry-run，零写**：只有同时给出 `--confirm` 且未显式 `--dry-run` 才应用。显式 `--dry-run` 退出码 0；未显式 `--dry-run` 的 dry-run 退出码 1（表示未应用，不是失败）。
- **显式授权三要素**：`--granted-by`/`--statement` 均必填，`--scope` 必须包含 `config` 与 `install`；`--granted-at` 必须是 ISO-8601 UTC。
- `--config-scope` 默认 `project`；`--config-path` 显式覆写必须落在声明作用域内（`user`→home，`project`/`workspace`→root，D1 修复），敏感文件名/目录（`.env*`、secrets/credentials/token/private-key、`credentials.json`、`id_rsa`/`id_ed25519` 等）拒绝且零写（D2 修复）。
- **备份 + hash 绑定 + 原子写**：apply 前内容哈希备份到 `.ano/clients/backups/<clientId>/<id>/` + manifest；`beforeHash` 漂移检查；原子合并只增改 `ano`、保留其他 MCP 服务与未知字段；提交安装记录；失败回滚，不留半写状态。
- 可写客户端：`claude-code`、`codex`、`cursor`、`opencode`；`qoder`/`dsh`/`pi`/`zcode` 如实拒绝写；`codex` 因 TOML v1 只读，即使授权齐备也只返回 dry-run。

### 恢复（只接受校验通过且绑定同一目标的备份）

```sh
ano clients restore <id> --backup-id <id> --granted-by <name> --statement <text> \
  --scope <detect|inspect|config|install|restore>[,...] \
  [--confirm] [--dry-run] [--config-scope <user|project|workspace>] \
  [--config-path <path>] [--home <path>] [--role <role>] [--granted-at <iso>] [--json]
```

- `--scope` 必须包含 `restore`；`--backup-id` 必填。
- 只恢复 manifest 校验通过、且 `targetPath` 与当前解析目标一致的备份（hash 绑定）；不匹配拒绝。默认 dry-run，`--confirm` 才写。

### 边界

- **不自动修改真实客户端配置、不读取真实会话或秘密**；任何写操作必须用户显式授权。
- 除 ZCode 外无真实客户端安装，`configured/mcp/tools/brief` 真实兼容未实测；`history` 全层 `unavailable`、输出拦截全 `unavailable`。
- 21 个 ADR-008 工具在 T-091 收口时均为 `unverified`，本终态仍全部为 `unvalidated`；24 行矩阵中唯一 `validated` 是 M11 既有的 `zcode`。

## 真实项目扫描根与只读接入（M13 / ADR-009）

仓库根没有 `package.json`、Node manifest 在 `server/package.json` 的嵌套项目现在可直接扫描。三个根语义独立：

| 根 | 含义 | 默认 | 用途 |
|---|---|---|---|
| `gitRoot` | Git 仓库根 | 从 `--root` 向上找 `.git` | `.ano/` 存储、扫描边界 |
| `pmRoot` | 权威 `.pm` | = `gitRoot` | 迁移、接管、任务计数 |
| `sourceRoots` | 源码扫描根（可多个） | 从 `gitRoot` 向下发现含 `package.json` 的目录 | 指纹、图、brief/explore |

### 指定 Git 根与嵌套包发现

```sh
ano brief --root "/绝对/仓库根"              # 根无 package.json 也可用
ano explore crawler --root "/绝对/仓库根"
ano rebuild graph --root "/绝对/仓库根"
ano connect plan --root "/绝对/仓库根"       # 只读预检，零写
```

- 发现从 `gitRoot` 向下 BFS，默认最大深度 3；跳过 `node_modules`/`.git`/`.pm`/`dist`/`.venv` 等排除目录与符号链接。
- 多候选默认取最近层全部（monorepo 语义，如 `client`/`server`/`workbench`）；`onAmbiguity='error'` 或要求单根时报 `AMBIGUOUS_SOURCE_ROOTS`。
- 从 `server/` 等源码根进入，`gitRoot`/`pmRoot` 仍解析到仓库根，`server/.pm` 记入 `ignoredPmRoots`，不会把源码根当 PM 根。
- 显式把同一根同时当 PM 根与源码根报 `ROOT_ROLE_CONFLICT`；`sourceRoot` 越出 Git 根报 `SOURCE_ROOT_OUTSIDE_GIT_ROOT`。

### 只读探测与排除复用

- 扫描默认只读：读取 `.pm/project.json` 的 `scan_ignore` 并优先于默认排除集，**不改写该文件**；可用 `.ano/project.json` 声明 `sourceRoots`/`exclude`/`include`/`followLinks`/`maxFileBytes`/`timeoutMs`/`maxDiscoverDepth` 等。
- 符号链接默认不跟随、不读目标、不删除，逐条记 `skipped-link`；`followLinks=true` 时做环路与逃逸检测，越界记 `LINK_ESCAPE`。
- 大文件（默认 >64 MiB）走 4 MiB 分块流式 sha256；`EBUSY`/`EACCES` 分别记 `busy-file`/`permission-denied`，顶层 `degraded`，不抛整树。
- `brief`/`explore`/`rebuild graph` 共享同一扫描配置与预算；缓存命中不全扫，构建超时保留旧快照并标 `stale`。

### 超时行为

- 默认 `timeoutMs=50000`（< MCP 60 秒），与 `maxFiles=200000` 共享同一 `deadline`。
- 预算耗尽返回 `status='timeout'` + `partial=true` + `completed{files,bytes,elapsedMs}` + `budget` + `reason`；`status='ok'` 时文件数必须 > 0，禁止 `files=0` 冒充正常。
- 图构建超时保留旧快照并标 `stale=true`，绝不返回空快照；刷新需显式 `ano rebuild graph`。

### 迁移与接管的显式授权流程

迁移与接管一律读仓库根 `.pm`（`pmRoot=gitRoot`）：

```sh
ano migrate plan --root "/绝对/仓库根"        # 只读预检
ano migrate apply --root "/绝对/仓库根" --expected-source-digest <sha256>
ano takeover grant --root "/绝对/仓库根" --scope tasks,memory,acceptance,dag \
  --granted-by "具名人工" --role "角色" --statement "授权 ANO 接管本项目"
ano takeover apply --root "/绝对/仓库根" --authorization-id <64位sha256> --confirm
```

- `grant` 只写 `.ano/takeover/authorization.json`；`apply` 必须回传 `grant` 返回的 `authorizationId` 与显式 `--confirm`，四个 scope 缺一不可。
- 授权绑定 canonical 项目根（仓库根）；源码根的 `.pm` 不参与迁移/接管。接管完整语义见 [takeover.md](takeover.md)。
- **真实项目未被接管**：M13 对真实电商项目仅做只读扫描验收；未执行 `takeover grant/apply/revoke/disable/recover`，也未执行迁移写路径。接管需具名人工显式授权与 `--confirm`。

## 结构智能使用（M14 / ADR-010）

结构能力经**服务层入口**提供；七工具 schema 与 CLI 未为新能力增设参数（MCP `explore` 仍是符号级 `query`，`track`/`verify` 的 strict schema 不接受 `with_structure_risk`/`structure`/`review_items`）。文件级查询、批量分析与风险计划由集成方/脚本直接调用 `src/surface/service.ts` 的导出函数。

### 文件级查询与探查留痕

```ts
import { structureFileQuery } from './src/surface/service.ts';
await structureFileQuery(root, { file: 'server/services/outageAlarm.js', kind: 'outline' });
await structureFileQuery(root, { file: 'server/services/outageAlarm.js', kind: 'impact', maxDepth: 3 });
// 符号级：ref 指向 symbol id/qualifiedName；写事件但不计入文件覆盖
await structureFileQuery(root, { file: 'src/a.ts', kind: 'outline', ref: 'a' });
```

- `kind='outline'|'impact'`；`file` 必须是相对 POSIX 路径（1..1024），绝对路径拒绝。
- 每次真实文件级查询追加一条 `structure.queried` 事件（绑定 `graph_revision`、强制 `idem_key`）；同键同参返回 `duplicate:true`，不重复计数。
- `brief` 的 `memory.unexploredChanges.exploredFiles` 只取当前 revision 的 `granularity=file` 投影；符号级查询不计覆盖；revision 变化后旧证据转 `stale`、warning 复现，需重新查询。
- 留痕写入失败以 `evidenceError` 暴露，不影响查询结果返回。

### 批量分析与风险计划

```ts
import { structureAnalysis, structureRiskPlan } from './src/surface/service.ts';
const report = await structureAnalysis(root, { touched: ['src/a.ts'], maxDepth: 3, fanoutTop: 10 });
const plan = await structureRiskPlan(root /*, touched? */);
```

- 一次 `GraphStore.open` + 一次 snapshot 产出 `metrics`（direct/transitive/unchanged/fanout/blindness/explored）、`counts`（九类）、`rows`、`risks`；文件级查询不增加 DB open。
- 增量缓存键含 revision、touched、maxDepth、排除集、degraded、explored、semanticGaps/blindSpots 内容与权重/阈值；同输入命中缓存并返回同对象语义，revision 变化即失效。
- `plan` 含 `rows`（可解释 riskScore 与分项）、`recommendations`（推荐测试，无覆盖显式标记）、`reviewItems`（人工复核清单）、`testGaps`；只是输入，不产生 Gate `evidence_id`。

### 任务与 Gate 的结构证据

- 服务层 `trackTask`/`trackTaskUpdate` 在 `with_structure_risk:true`（或 `structure_risk:true`）时附 `structureRisk`；未请求时结果键集与旧版一致。
- 服务层 `verifySurface` 接受 `structure:true`（或 `{...}`）与 `review_items`：前者记录结构覆盖差集（执行测试前向闭包 vs 高风险文件），后者只计为 `untrustedReviewItems`，不参与判定。
- `strict`（沿用 `policy.unknown`）：未处理的高风险 manual-review 盲点或未覆盖高风险文件**阻止**完成；`advisory`：只记入 `warnings`，不改变裁决；结构证据只出现在 reasons/warnings，不替代执行证据。
- 不可伪造：权威复核清单由当前图重算并绑定 `evidenceRevision`；伪造 `handled:true` 不被接受。

## CLI

构建后使用 `dist/surface/cli.js`（开发期可用 `node --experimental-strip-types src/surface/cli.ts`）：

```sh
ano --help | --version
ano brief [--memory-context] [--context-budget <n>] [--root <path>]
ano explore <symbol> [--root <path>]
ano connect [plan|status|resume|export|handoff|ui|watch] [--root <path>]
ano track create --id <task-id> [--title <text>] [--file <path>]...
ano track <update|cancel|reopen> --id <task-id> [--status <todo|in_progress|cancelled>]
ano track complete --id <task-id> --evidence-id <evidence-id>
ano migrate [plan|apply|status|reconcile] [--root <path>] [--expected-source-digest <sha256>] [--on-conflict skip]
ano verify <task-id> [--tier T0|T1] --test <path> [--test <path>]... -- <command> [args...]
ano verify release --target <version> --profile <A-I> [--profile <A-I>]... --artifact <path>
ano verify context --context-id <id> --project-scope <id> --draft <path.json>
ano recall [--session <id>] [--from <iso>] [--to <iso>] [--file <path>] [--symbol <name>] [--keyword <text>] [--provider <id>]
ano recall --source connected [--query <text>] [--limit <n>] [--root <path>]
ano recall --mode probe --project-scope <id> (--requirement <text>)... [--query <fact-key>] [--temporal-mode CURRENT|AS_OF|HISTORICAL] [--as-of <iso>] [--budget <json>]
ano note <decision|pitfall|memory|session_summary> --text <text> [--file <path>] [--symbol <id>] [--qualified-name <name>]
ano note revise --fact-key <key> --kind <decision|pitfall|memory> --text <text> --supersedes <json> --reason <text> --effective-from <iso|null> --effective-to <iso|null> [--file <path>] [--symbol <id>] [--qualified-name <name>]
ano note relate --edge <depends_on|explains|related_to> --from-ref <id> --to-ref <id> [--reason <text>]
ano audit <drift|security|license|governance|deps> [--online --confirm] [--root <path>]
ano doctor [--root <path>]
ano doctor clients [--json] [--plan] [--root <path>] [--home <path>] [--env KEY=VALUE] [--probe-path <dir>] [--timeout-ms <ms>]
ano doctor client <id> [--json] [--root <path>] [--home <path>] [--env KEY=VALUE] [--probe-path <dir>] [--timeout-ms <ms>]
ano clients plan [--json] [--root <path>] [--home <path>] [--env KEY=VALUE] [--probe-path <dir>] [--timeout-ms <ms>]
ano clients install <id> --granted-by <name> --statement <text> --scope <detect|inspect|config|install|restore>[,...] [--confirm] [--dry-run] [--config-scope <user|project|workspace>] [--config-path <path>] [--home <path>] [--role <role>] [--granted-at <iso>] [--json]
ano clients restore <id> --backup-id <id> --granted-by <name> --statement <text> --scope <detect|inspect|config|install|restore>[,...] [--confirm] [--dry-run] [--config-scope <user|project|workspace>] [--config-path <path>] [--home <path>] [--role <role>] [--granted-at <iso>] [--json]
ano rebuild graph [--root <path>]
ano export [--root <path>]
ano ui [--port <port>] [--root <path>]
ano baseline list [--root <path>]
ano baseline verify <version> [--root <path>]
ano baseline draft <spec.json> [--root <path>]
ano baseline approve <version> --name <human> --role <role> --statement <text> --confirm [--root <path>]
```

`--` 之后的所有参数都属于被验证的命令，不会被 CLI 自身解析（`--root`/`--test`/`--help` 在 `--` 后只是测试参数）。

### 上下文校验（P2）

`ano brief --memory-context` 会冻结一份派生 probe manifest（`.ano/memory/probes/<context_id>.json`，有 TTL 与容量上限，可过期/清理，不是权威账本），并在 `memory_context` 中返回 `context_id`、`body_digest`、`project_scope`、`root`、`frozen_at`/`expires_at`。

```sh
ano brief --memory-context --context-budget 20 --root <path>
ano verify context --context-id <id> --project-scope <id> --draft draft.json --root <path>
```

`--draft` 是结构化 JSON（`anchorprobe.draft.v1`），只被读取和校验，永不执行；其中 `claims[].text` 是不受信输入。校验只覆盖可判定项：Schema/枚举/大小、引用是否属于冻结证据集合、项目/根/context/版本/过期、快照摘要、缺失填造、形式化参数。语义支持度在 v1 恒为 `unknown`，因此结构干净的 draft 也返回 `NEEDS_REVIEW`，绝不返回 `ALLOW` 或泛化 `passed=true`。

退出码：参数解析/缺参/未知字段/非法 JSON = 2；服务层拒绝（未知/过期/跨项目 context、manifest 摘要不符）或 `BLOCK` = 1；`NEEDS_REVIEW` = 0。`verify context` 不写账本、不产生 `evidence_id`/`verdict`/`task_id`，不改变任务或发布状态。`recall --mode probe --query <fact-key>` 把 `query` 当作单个精确 fact key（不是自由文本检索）；自由文本请用默认 `recall --keyword`。

## 验证输入约定

- 项目必须是 Git 工作树且含 `package.json`；变更集合来自 `git status` 与任务声明的并集。
- `--test` 和 MCP `test_files` 必须列出本次 argv **实际执行的测试文件**；它们不是运行结果推断器。
- `--tier T0`（MCP `tier`）是任务验证的显式 opt-in，供明确选择的维护任务使用（不按任务类型强制限制）；仍要求真实测试与证据绑定，但不提供 T1 的静态可达覆盖保证。缺省保持 T1 strict，`policy.unknown` 保持 `strict`。release/context 分支拒绝 `tier`，非法值报参数错误，同一 idempotency key 不能跨 tier 复用。
- 当前支持 Node TAP 风格计数；测试计数/通过缺失、失败、跳过、todo、cancelled、超时都不能完成任务。
- `done` 只接受 Gate 证据：真实子进程证据 + stored verdict + 当前源码指纹一致；裸 `status:'done'` 或自报 verdict 被拒绝。
- 验证前会全量重建图；验证后再次检查源码和图新鲜度。源码变化会拒绝完成，需重新 verify。
- 所有 ledger 在 `.ano/ledger`，SQLite 缓存在 `.ano/cache`，缓存可删除重建。

## 审计与基线

- `ano audit` 是本地只读审计；Finding 只保留规则、严重级、指纹与位置，永不保留明文秘密。
- `--online` 必须与 `--confirm` 同时给出，默认拒绝联网；没有注入 scanner 时明确记录未执行。
- `.ano/audit/findings.json` 中未解决的 high/medium Finding 会让 `ok=false`，降级扫描同样失败关闭。
- `ano baseline` 管理版本化验收基线：`draft` 只引用 quality/coverage/build 三份报告；`approve` 必须由具名人工在交互 TTY 上背书，agent 无法代批。

## Memory 与 Readiness（已接通）

- `src/memory` 提供纯合成 provider adapter、参数化 recall、中文/标识符检索、Anchor 三级重定位与 brief；不采集真实会话，未验证的客户端不标支持。
- `src/readiness` 提供 profile `defined/validated`、`machine/attested/declaration/missing` 证据分级、文件证据过期与制品哈希绑定、release 三态裁决。
- 这两层已接入 MCP/CLI；默认模式无合成历史时 recall 返回 `not_configured`，不会扫描真实客户端目录。`source=connected` 查询显式接入的 PM 历史，不改变默认来源。release 证据目录限定项目内，attestation 必须有账本来源证明。

## 人工边界

基线批准、attestation、release approve、sync、push 是具名人工动作，不是 agent 权限；MCP 不暴露这些工具，CLI 中 `attest`/`release approve`/`sync`/`push` 返回明确 exit 2。

## 证据

- `docs/phase-1-report.md` 与 `docs/evidence/p1-experiment.json`：P1 判定实验（含源码指纹与时间戳）。
- `docs/evidence/package-smoke.json`：真实 tarball 的 sha256、版本、产物哈希、CLI verdict 与 MCP 7 工具。
- `docs/phase-2-report.md` … `docs/phase-7-report.md`：各阶段实现与验收原文。
- `docs/limitations.md`：必须同时阅读的限制说明。
