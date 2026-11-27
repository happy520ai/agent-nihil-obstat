# Cursor / OpenCode 适配器证据报告（T-083 / MC-05）

- 日期：2026-11-22
- 任务：T-083（M11 / MC-05）
- 交付：`src/clients/cursor.ts`、`src/clients/opencode.ts`、`test/unit/client-cursor.test.ts`、`test/unit/client-opencode.test.ts`、本报告
- 性质：只读探测 + 合成 fixture 验证。未读取真实客户端配置内容，未修改用户级配置，未执行配置内容，未新增第八个 MCP 工具。
- 上游契约：`docs/adr/ADR-007-client-adapters.md` §2/§3/§5、`docs/client-compatibility.md` §1/§5、`src/clients/types.ts`（T-080）、`src/clients/config.ts`（T-081）。

## 1. 结论

1. 两个适配器均实现 `ClientAdapter` 四接口，配置写路径全部委托 `src/clients/config.ts`（T-081），真实 stdio 验证委托 `src/clients/doctor.ts` 的 `verifyStdioMcp`（T-080）。适配器自身不写文件、不执行配置内容。
2. OpenCode 的公开配置格式有实测文档依据：`mcp.servers.<name>` + 本地项 `{ "type": "local", "command": ["exe", ...] }`（官方文档抓取成功）。Cursor 官方文档在本机不可达，其 `mcpServers` / `.cursor/mcp.json` / `~/.cursor/mcp.json` 格式来自 ADR-007 §6 与 T-080 registry 的声明候选，标注为 `assumed`（未实测）。
3. 本机（win32，Node v24.14.0）未安装 Cursor 与 OpenCode，且不存在 `~/.cursor/`、`~/.config/opencode/`，因此没有任何真实客户端握手或真实配置读取；对应层保持 `unavailable` / `degraded`，不升级为 `validated`。
4. 不支持层已显式降级：`orchestration` 为 `degraded`（`mode='explicit-workflow'`，DAG/自动派发不宣称），`history` 与 `output-interception` 为 `unavailable`，并全部进入报告 `limitations`。
5. 默认零写、已有配置不覆盖、未知字段保留、缺授权零写、路径逃逸拒绝均有确定性测试断言。

## 2. 公开格式依据（实测 / 假设分层）

| 客户端 | 格式字段 | 依据等级 | 依据 |
|---|---|---|---|
| OpenCode | `mcp.servers.<name>`，本地项 `type:"local"` + `command:[exe,...args]` | 实测（公开文档抓取） | `https://opencode.ai/docs/config/`、`https://opencode.ai/docs/mcp-servers/`（2026-11-22 抓取） |
| OpenCode | 全局 `~/.config/opencode/opencode.json(c)`；项目 `opencode.json(c)` 或 `.opencode/opencode.json(c)` | 实测（公开文档抓取） | 同上；注意 T-080 registry 声明的是 `<root>/.opencode.json`，与官方 `.opencode/opencode.json` 不一致，见 §7 |
| OpenCode | 本地项可选 `cwd` / `environment` / `disabled` / `codemode` / `timeout` / `protocol` / `pool`；无 `enabled` 字段 | 实测（公开文档抓取） | `https://opencode.ai/docs/mcp-servers/` |
| Cursor | `mcpServers.<name>`（`command` + `args`） | 假设（未实测） | ADR-007 §6、`docs/client-compatibility.md` §1、T-080 registry 声明候选；官方文档本机不可达（见 §3） |
| Cursor | 用户级 `~/.cursor/mcp.json`、项目级 `.cursor/mcp.json` | 假设（未实测） | 同上 |
| Cursor | 规则 `.cursorrules`、`.cursor/rules/*.mdc` | 假设（未实测） | ADR-007 §6、registry `rulePaths`；`.mdc` frontmatter 解析为最小实现 |
| Cursor | 规则 `AGENTS.md` | 假设（未实测） | T-083 任务指令要求独立检测；registry `rulePaths` 未声明该文件，Cursor 官方支持未核实 |
| OpenCode | 规则 `AGENTS.md` | 假设（未实测） | registry `rulePaths` 声明；OpenCode 官方 instructions 页面未抓取到路径级说明 |

写入条目（数据，非执行）：

- Cursor：`{ "command": "node", "args": ["<package-root>/dist/surface/mcp.js"] }`，`serverPath=['mcpServers']`，`serverName='ano'`。
- OpenCode：`{ "type": "local", "command": ["node", "<package-root>/dist/surface/mcp.js"] }`，`serverPath=['mcp','servers']`，`serverName='ano'`。
- `<package-root>` 由 `import.meta.url` 上推两级得到，源码（`src/clients/`）与构建产物（`dist/clients/`）两种布局下均指向包根；条目来源为 `package.json` 的 `mcp` 字段。

## 3. 本机真实探测结果（留证）

执行环境：win32 10.0.19041，Node v24.14.0，工作目录 `F:\Agent Nihil Obstat`。

| 探测 | 命令 | 结果 |
|---|---|---|
| Cursor 可执行 | `command -v cursor` | 未找到（not found） |
| OpenCode 可执行 | `command -v opencode` | 未找到（not found） |
| Cursor 用户目录 | `lstat <home>\.cursor` | missing |
| Cursor 用户配置 | `lstat <home>\.cursor\mcp.json` | missing |
| OpenCode 用户目录 | `lstat <home>\.config\opencode` | missing |
| OpenCode 用户配置 | `lstat <home>\.config\opencode\opencode.json` | missing |
| Cursor 遗留规则 | `lstat <home>\.cursorrules` | missing |

- 以上仅为存在性探测，未读取任何真实客户端配置文件内容。
- Cursor 官方文档抓取：`https://docs.cursor.com/en/context/mcp` 与 `/en/context/rules` 返回 308 重定向至 `https://cursor.com/docs`；直连 `https://cursor.com/docs/context/mcp`、`https://cursor.com/docs` 均连接超时（curl HTTP 000，20s 超时）。因此 Cursor 格式在本机无公开文档实测，维持 `assumed`。
- OpenCode 官方文档抓取成功（WebFetch），故其格式字段为实测依据。

结论：本机无可实测的 Cursor / OpenCode 安装，`detected` 层在真实环境下应判 `unavailable`；合成 fixture 只证明机制，不证明真实客户端兼容。

## 4. 已有配置保留 / 零写验证（测试断言）

`test/unit/client-cursor.test.ts` 与 `test/unit/client-opencode.test.ts` 覆盖：

| 断言 | Cursor | OpenCode |
|---|---|---|
| 默认 dry-run 零写、无 `.ano/` 备份状态 | 是 | 是 |
| apply 只追加 `ano`，其他 MCP 服务逐字节保留 | 是 | 是 |
| 顶层/嵌套未知字段保留 | 是 | 是 |
| 幂等重放零变化（`changes=[]`） | 是 | 是 |
| 缺授权 apply 零写（返回 dry-run + `apply refused`） | 是 | 是 |
| 授权缺 `statement` 时零写（T-080/T-081 接口缺口，见 §7） | 是 | 是 |
| 目标路径越出声明作用域时拒绝且零写 | 是 | 由 T-081 同一契约保证 |
| 已有 `.opencode.json` 存在时改它而非新建 `opencode.json` | 不适用 | 是 |
| `inspect` 只读：配置字节不变、不建备份 | 是 | 是 |
| 空 root 上 detect/inspect 不产生任何文件 | 是 | 是 |

## 5. 能力分层与降级清单

两个适配器的 `inspect` 均产出九层报告；`verify` 只实测 `mcp`/`tools`/`brief`。

| 层 | Cursor | OpenCode | 说明 |
|---|---|---|---|
| detected | 可 `validated`（有可执行）/ `degraded`（仅目录）/ `unavailable` | 同左 | 仅探测声明来源，不猜测路径 |
| configured | 最高 `degraded`（`evidence='configured'`） | 同左 | `inspect` 不做握手，不得判 `validated` |
| mcp / tools / brief | `inspect` 中 `unavailable`；`verify` 实测 | 同左 | 握手失败即停止放大（E3） |
| instructions | `degraded`；检测规则文件与受管段 marker | `degraded`；检测 `AGENTS.md` 与受管段 marker | 只读；写规则需显式授权 |
| orchestration | `degraded`，`mode='explicit-workflow'`，`evidence='assumed'` | 同左 | 无公开派发接口；DAG/自动派发不宣称 |
| history | `unavailable`，`evidence='absent'` | 同左 | 无授权样本；不读真实会话 |
| output-interception | `unavailable`，`hooksAreToolLevel=true` | 同左 | 无公开接口；工具级 hooks 不算输出拦截 |

- 扩展层为 `unavailable` 时全部进入报告 `limitations`（测试断言 `history unavailable` / `output-interception unavailable`）。
- 报告固定包含不可放大声明：握手成功不得表述为已接管、DAG 已接管、历史已支持或输出可拦截。

## 6. 测试与回归结果

| 命令 | 结果 |
|---|---|
| `node --test test/unit/client-cursor.test.ts test/unit/client-opencode.test.ts` | 23 tests，23 pass，0 fail |
| `node --test test/unit/client-doctor.test.ts test/unit/client-config.test.ts` | 34 tests，34 pass，0 fail |
| `npx tsc -p tsconfig.json --noEmit` | 本任务文件 0 error；最终检查时残余错误来自并行任务 T-082 的 `src/clients/claude-code.ts` / `codex.ts`（`readonly` 修饰符），见 §7 |

新增测试覆盖：身份来源与 registry 一致、detect 只读与不猜测、九层报告形状、configured 只读发现与降级、规则文件与受管段检测、dry-run 零写、apply 合并保留、授权缺失零写、路径逃逸拒绝、真实 stdio 握手与注入握手、握手失败不放大、空 root 零文件。

## 7. 未实测层与移交项

1. **T-080/T-081 授权形状缺口**：`types.ClientAuthorizationRef` 无 `statement` 字段，而 `config.ts` 的 `checkClientConfigAuthorization` 要求非空 `statement`。适配器在 `statement` 缺失时拒绝 apply（零写），不伪造授权语句。T-085 传入完整授权记录（含 `statement`）即可 apply；建议 T-080 扩展 ref 或明确由 CLI 层补全。
2. **`ConfigInput` 无 `env`/`home`**：用户级作用域需要 home。适配器接受运行时注入的 `env`（结构兼容对象），否则回退 `process.env`。测试一律注入 tmpdir，不读真实 home。建议 T-080/T-085 在 `ConfigInput` 增加 `home`/`env` 注入字段。
3. **Cursor 格式未实测**：官方文档本机不可达，`mcpServers` 容器与路径为 `assumed`。需要在装有 Cursor 的机器上运行 `cursorAdapter.inspect`/`detect` 并比对真实 `~/.cursor/mcp.json` 后升级为 `measured`。
4. **OpenCode 路径口径不一致**：T-080 registry 声明 `<root>/.opencode.json`；官方文档为 `opencode.json` 与 `.opencode/opencode.json`。适配器只探测 registry 声明的两个候选（不新增未声明来源），并优先复用已存在文件。建议 T-087/T-090 收口时决定是否把 `.opencode/opencode.json` 加入声明候选。
5. **父目录缺失时 apply 拒绝**：`config.ts` 不创建配置文件的父目录。若 `.cursor/` 或 `~/.config/opencode/` 不存在，apply 返回 dry-run 零写（不新建目录）。真实客户端通常自行创建配置目录；如需自动创建，应由 T-081 统一决定。
6. **规则接管只检测不安装**：`instructions` 层只报告规则文件存在与受管段 marker；写规则文件不在本任务范围（需显式授权，沿用 `src/connect/managed-instructions.ts` 的 marker 先例）。
7. **并行任务在途错误**：T-083 进行期间，T-082（`claude-code.ts` / `codex.ts` 及其测试）与 T-084（`qoder.ts` / `unknown.ts` 及其测试）并行写入，`tsc` 错误集合随其进度变化（曾出现 `readonly` 修饰符、`ConfigResult` 联合窄化、`ExternalAdapterDeclaration` 转换等错误）。本任务文件全程 0 error；最终检查时残余错误仅来自 T-082 的 `claude-code.ts` / `codex.ts`。上述文件不属于 T-083，未修改。
8. **`verify` 委托**：适配器不自带 stdio 实现，直接调用 `doctor.verifyStdioMcp`；真实 spawn 与注入 seam 的语义由 T-080 测试保证，本任务只验证适配器透传与失败隔离。
