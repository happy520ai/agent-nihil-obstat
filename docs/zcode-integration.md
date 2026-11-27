# ZCode 用户级接入（ANO MCP）

> 状态（2026-11-27 复核）：用户级配置、真实 stdio、当前会话 `mcp__ano__brief` 与多个非 ANO 项目的宿主连接已验证。每个项目仍使用自己的 `.ano/` 账本。工作区 `.zcode/config.json` 保持 `mcp.servers={}`，不重复声明 `ano`（用户级唯一登记，见 D-0019）。Settings 面板未直接截图确认；跨项目工具消费与独立账本现场核验未执行。

## 1. 接入目标与边界

- 在**用户级配置** `~/.zcode/cli/config.json` 的 `mcp.servers` 注册 `ano` stdio MCP server。
- server 由绝对路径的 Node 启动无空格 wrapper `~/.zcode/ano-mcp.mjs`，wrapper 再启动构建产物 `dist/surface/mcp.js`，工具面恰为 7 个意图工具。
- **同一 `ano` 只登记一次**：本仓库采用用户级唯一登记；工作区 `.zcode/config.json` 只保留空的 `mcp.servers` 容器。两个作用域同时声明会触发客户端来源错配（D-0019）。
- 不注册 HTTP/SSE、不读取 ZCode 全局会话、不申请任何人工批准权限。
- ANO 自己管理任务与证据（`.ano/`），pm-mcp 管理开发过程；两者不混写存储。

## 2. 前置条件

```sh
npm ci
npm run build        # 生成 dist/surface/mcp.js（用户级 wrapper 指向该文件）
node --version       # 需 ≥ 22.18；本机证据为 v24.14.0
```

- 被接入项目必须是 Git 工作树且含 `package.json`；`brief`、`explore` 等读工具会先校验，不满足时返回错误而不是创建 `.ano/`。
- `git` 必须在 `PATH` 中可用。
- 源码调试可用 `src/surface/mcp.ts`（依赖 Node 原生类型擦除），但用户级 wrapper 与正式工作区配置应指向 `dist/`，避免把源码布局当成发布接口。

## 3. 用户级配置

文件：`<home>\.zcode\cli\config.json`，`mcp.servers.ano`：

```json
{
  "mcp": {
    "servers": {
      "ano": {
        "type": "stdio",
        "command": "C:/Program Files/nodejs/node.exe",
        "args": ["<home>/.zcode/ano-mcp.mjs"],
        "timeoutMs": 60000
      }
    }
  }
}
```

编辑时保留同一 `mcp.servers` 中已有的其他服务。

不设置 `cwd` 或 `ANO_ROOT` 来固定项目。无 `root` 参数时使用当前工作目录；传 `root` 时
明确选择目标 Git 项目，读写该项目自己的 `.ano/`。本仓库的工作区 `.zcode/config.json` 只保留
`{"mcp":{"servers":{}}}`，继承这条用户级登记，**不要**再写入 `mcp.servers.ano`。只有在不使用
用户级登记、改走单项目固定配置时，才在工作区写 `ano`；两种方式二选一，不能同时启用。

字段说明：

| 字段 | 要求 | 说明 |
|---|---|---|
| `type` | `stdio` | 当前只接 stdio；不配置 URL/HTTP。 |
| `command` | **绝对路径** | 指向 `node` 可执行文件。不要写裸 `node`：客户端进程不一定继承交互 shell 的 `PATH`。Windows 用 `node.exe`。 |
| `args` | 单个**绝对路径** | 用户级使用 `<home>/.zcode/ano-mcp.mjs`。`args` 是 JSON 数组而非 shell 字符串；无空格 wrapper 避免桌面表单拆分路径。 |
| `cwd` | 可选 | 用户级多项目模式不固定；留空跟随客户端当前目录。 |
| `env.ANO_ROOT` | 可选 | 用户级多项目模式不设置；仅单项目固定配置使用。 |
| `enabled` | `true` | 显式启用。 |
| `timeoutMs` | 正整数，建议 `60000` | 首次 `brief` 可能触发图缓存构建，过小会超时。 |

### 绝对路径与平台注意

- **必须绝对**：`command`、`args[]`、`cwd`、`env.ANO_ROOT` 都不能写成 `node`、`./dist/...`、`~/...` 或依赖环境变量展开。ZCode 不保证在当前工作目录启动子进程。
- **Windows**：
  - `C:/Program Files/nodejs/node.exe` 或 `C:\\Program Files\\nodejs\\node.exe` 均可；JSON 中的反斜杠必须写成 `\\`，单个 `\` 会产生非法转义（例如 `\A`）。
  - 盘符路径 `F:/...` 是绝对路径；Git Bash 下的 `/f/...` 不是客户端可用的 Windows 路径。
  - 含空格目录（如 `<repo>`）放在 JSON 数组/字符串中即可，不要手动加引号。
  - 可用 `where node` 确认 node 绝对路径。
- **POSIX**：如 `command: "/usr/local/bin/node"`、`args: ["/srv/ano/dist/surface/mcp.js"]`，并确保 node 可执行。
- **UNC**：`\\server\share\...` 在 JSON 中写成 `\\\\server\\share\\...`。
- **配置与本机绑定**：用户级配置记录当前机器的 Node 与 ANO 安装绝对路径；移动 ANO 或换 Node 后必须更新并重验。
- **项目隔离**：每次调用使用显式 `root` 或当前 cwd 的项目内 `.ano/`，不写入 ZCode 安装目录，不把另一个项目的账本混入当前项目。

## 4. 启用与重启（Settings → MCP）

**用户级多项目（2026-11-22 复核）**：`ano` 注册在用户级 `mcp.servers`，无固定
`ANO_ROOT`。当前 ZCode 会话的真实 `brief` 已调用成功；宿主日志证明多个非 ANO 项目已连接。跨项目现场工具消费与独立账本核验仍未执行。

修改这些配置后，**已运行的客户端不会热加载**：

1. 保存配置（确认 JSON 可解析、无尾逗号）。
2. 打开 ZCode 的 **Settings → MCP**（MCP Servers 面板），对 `ano` 执行重启/重连；若面板没有单独的重启按钮，重启 ZCode 客户端。
3. 确认工具列表出现 `mcp__ano__brief`、`mcp__ano__explore`、`mcp__ano__recall`、`mcp__ano__track`、`mcp__ano__note`、`mcp__ano__verify`、`mcp__ano__audit`，共 7 个。
4. 先调用 `brief`（无需参数）确认返回 `phase: "P7"` 和 7 工具清单。

若跳过重启，当前会话可能仍连着旧进程：工具列表、`env.ANO_ROOT`、代码版本都可能是旧的。真实连接证据中的 `clientRestartRequired: true` 就是提醒这一步必须由人完成。

## 5. 真实验证

```sh
npm run build
node scripts/verify-zcode-mcp.ts
node --test test/integration/zcode-config.test.ts
```

- `scripts/verify-zcode-mcp.ts`：解析**真实生效的** `ano` 登记（工作区优先，否则用户级 `~/.zcode/cli/config.json`；可用 `ANO_ZCODE_USER_CONFIG` 指向隔离配置），两个作用域同时声明时直接失败；按生效条目的 `command`/`args`/`cwd`/`env` 启动 stdio server，断言工具名恰为 7 个且顺序一致，再调用 `brief` 断言 `phase === "P7"`；最后写入 `docs/evidence/zcode-mcp.json`，记录工作区 `configSha256`、生效作用域、生效配置路径、生效 server 指纹、`serverPid`、Node/平台信息和工具清单。
- `test/integration/zcode-config.test.ts`：
  - 校验工作区 `.zcode/config.json` 不重复声明 `ano`（用户级唯一登记），并校验 effective resolver 在“仅用户级 / 双登记 / 仅工作区”三种输入下的选择与重复标记；
  - 在临时目录写入一份 ZCode 形状的配置，**读回文件内容**后再启动真实 MCP（优先 `dist/surface/mcp.js`，未构建时用源码入口），断言恰好 7 个工具，并用配置里的 `ANO_ROOT` 调用 `brief`，确认读的是临时项目而不是本仓库；
  - 校验 `docs/evidence/zcode-mcp.json` 的工作区哈希与当前配置一致、证据只记录一个 `ano` 登记、工具清单为 7 个；本机仍能解析出生效登记时，还要求生效作用域、配置路径与 server 指纹完全匹配，防止证据过期或伪造。
- 证据过期（改了工作区配置或生效 server 条目但没重跑脚本）时，测试会失败并提示重跑 `node scripts/verify-zcode-mcp.ts`。这是有意的：证据必须对应当前生效登记。

上述验证不需要启动 ZCode GUI；第 4 步的客户端重启/工具可见性仍需人工确认。

## 6. 七工具边界

| 工具 | 访问 | 已接通的输入 | 未接通/行为 |
|---|---|---|---|
| `brief` | read | 无参数或 `root` | 读取任务、触碰文件、图新鲜度与限制；要求 `package.json` + Git 工作树 |
| `explore` | read | `query`、可选 `budget` | 返回符号、影响范围、图 revision/新鲜度与降级说明；超出 budget 标记 `truncated` |
| `recall` | read | `session/from/to/file/symbol/keyword/provider` | 仅 `.ano/memory/synthetic/**` 显式导入的合成历史；未配置返回 `not_configured`，不读取 ZCode 真实会话 |
| `track` | write | `kind="task"` + `operation="create"`（`payload.id/title/files/status`） | `milestone`/`checkpoint`/`feature` 及 `update`/`complete`/`cancel` 未实现，返回明确错误 |
| `note` | write | `kind/text/idem_key`；非 session_summary 需 `anchor.file` | 写入 ANO 账本，支持重放与幂等；非法 Anchor 不落账 |
| `verify` | write | task 需真实 argv/test_files；release 需 `target/profiles/artifact_path` | release 对真实制品计算哈希，缺机器证据保持 blocked；不自报 verdict/制品哈希 |
| `audit` | read + findings | `scope` 为 `drift`/`security`/`license`/`governance`/`deps` | 本地只读；Finding 只存规则/严重级/指纹/位置；`online` 必须同时 `confirm: true` |

- 所有工具使用严格输入 schema：未知字段会被拒绝，不会“尽力猜测”。
- 未接通的工具/范围统一返回 `isError` 与 `not implemented`，不写账本、不创建 `.ano/`。
- **不暴露为 MCP 工具的人工动作**：baseline approve、attest、release approve、sync、push。发布批准永远属于具名的人；MCP 不能代替人工放行。
- 工具失败时先看 `isError` 与文本原因，不要把“未实现”误读为“已执行但没有结果”。

## 7. 排障

| 现象 | 检查 |
|---|---|
| Settings → MCP 没有 `ano` | 用户级 `~/.zcode/cli/config.json` 是否有 `mcp.servers.ano` 且 `enabled !== false`；工作区 `.zcode/config.json` 是否误留重复 `ano`（应保持空 `mcp.servers`） |
| 两个 `ano` 条目 / 项目信任不可用 | 同一 `ano` 同时出现在用户级与工作区：删除工作区条目，只保留用户级登记（D-0019） |
| server 显示 failed / 立即退出 | `command` 是否为存在的绝对路径；`args[0]` 是否指向存在的 `dist/surface/mcp.js`；Node 是否 ≥22.18 |
| 工具数量不是 7 | 是否连到旧进程（未重启）；`args` 是否指向旧构建或源码旧版本；重新 `npm run build` |
| `brief` 报 `No package.json` / `Git work tree` | `ANO_ROOT`/`cwd` 是否指向真实项目根；该项目是否已 `git init` 并有 `package.json` |
| 改了配置但行为不变 | 重启/重连 Settings → MCP 中的 `ano`，必要时重启客户端 |
| 证据校验失败 `stale` | 重跑 `node scripts/verify-zcode-mcp.ts`，提交新的 `docs/evidence/zcode-mcp.json` |
| 路径含空格启动失败 | `args` 必须保持单个 JSON 字符串，不要用 shell 转义或拆成多个参数 |

## 8. 明确不声称

- 不声称已用真实 ZCode 会话完成客户端 `validated` 采样；客户端状态见 `docs/client-compatibility.md`，目前没有客户端达到 `validated`。
- 不声称已读取真实客户端会话或完成生产 Readiness 验证；`recall` 仅使用显式导入的合成历史。
- 不声称 attest、release approve、sync、push 已接通；release verify 是机器裁决，不是人工批准。
- 不声称 Linux/macOS 的该份 Windows 绝对路径配置可直接复用；换平台必须改配置并重跑验证。
- 证据只覆盖“当前工作区配置 + 当前生效 `ano` 条目 + 当前构建产物”的一次真实连接；配置或源码变化后证据即过期。工作区哈希用于仓库内新鲜度校验，生效条目指纹用于本机真实登记校验，二者都不代表已获得客户端 GUI 可见性。
