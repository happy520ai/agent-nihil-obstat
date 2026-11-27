# Phase 8 真实 tarball 自举与 Node 矩阵报告

> 所有权：本阶段只新增 `scripts/selfhost.ts`、`scripts/node-matrix.ts`、
> `test/integration/zcode-selfhost.test.ts`，实际运行后生成 `docs/evidence/node-matrix.json`，
> 并写本文档。未修改 `src/**`、其他测试、`package*.json`、其他 docs、
> `.pm/**`、`.ano/**`、`.zcode/**`。`scripts/smoke-packed.ts` 未改。
>
> 说明：本阶段运行期间主控完成了 `note`/`recall` 的 Surface 接线。自举脚本不依赖该状态，
> 未接通时会记 `unimplemented`，接通后按真实结果记 `passed`。本报告引用的是最后一次
> 实际运行的证据。

## 1. 结论

真实 tarball 自举已实现，并在 Node 22.18.0 与 Node 24.14.0 上分别全链路通过：

- 先显式 `npm run build`，再 `npm pack` → 临时目录 `npm install`。
- 安装后的 CLI `--version`、`rebuild graph` 通过。
- 仓库现有 `.zcode/config.json` 的 `ano` stdio 服务被原样启动（仅把 `ANO_ROOT`/cwd
  重定向到临时项目），7 个工具和 `brief(phase=P7)` 通过。
- 安装后的 tarball 用自己的 `.zcode/config.json` 启动 MCP，`track` / `brief` / `explore`
  通过，创建的任务能在 `brief` 中读回。
- `note` / `recall` 的 MCP 与 CLI 路径均通过：
  - `note` 返回 `recorded`，CLI 重放返回 `duplicate`（同一 note id），说明幂等路径有效。
  - `recall` 使用显式导入的合成 fixture，返回 `status=ok`、`mode=fts`、`total=2`。
- 主控随后提供隔离下载的官方 Node 22.18.0，设置 `ANO_NODE22` 后实际重跑；
  Node 22/24 两 target 均 `passed`，总体 `passed`，退出码 0。
  证据 `docs/evidence/node-matrix.json`，生成时间 `2026-11-19T11:04:32.936Z`。

没有 `npm publish`、没有 push、没有读取真实会话；自举项目全部在 `os.tmpdir()` 并已清理。

## 2. 实测环境

| 项 | 值 |
| --- | --- |
| 平台 | win32 10.0.19041 x64 |
| 当前 Node | v24.14.0 |
| npm | 11.9.0 |
| 目标 Node 22 二进制 | 官方 Node 22.18.0，隔离临时目录（本次已实测） |
| 包版本 | `agent-nihil-obstat@0.1.0-alpha.0` |
| 自举项目 | `os.tmpdir()` 下的合成 Git 项目，运行后删除 |
| 证据文件 | `docs/evidence/node-matrix.json`（本次实际运行生成） |

## 3. 实现

### 3.1 `scripts/selfhost.ts`

真实安装后自举，所有检查记录实际状态与本次墙钟耗时：

1. **build**：执行 `npm run build`。
   - 关键发现：仓库 `.npmrc` 设置了 `ignore-scripts=true`，`npm pack` 不会执行
     `prepack`。不显式构建会把陈旧的 `dist/` 打进 tarball。本脚本因此先构建再打包。
2. **pack**：`npm pack --pack-destination <tmp>`，记录 tarball 字节数与 SHA-256。
3. **install**：在 `<tmp>/install` 执行
   `npm install --ignore-scripts --no-audit --no-fund <tarball>`。
4. **合成项目**：`<tmp>/project` 中创建最小 Git 仓库、`src/a.ts`、`test/a.test.ts`、
   `.zcode/config.json`，并把
   `test/fixtures/memory/synthetic-alpha/unit-visible` 复制到
   `.ano/memory/synthetic/synthetic-alpha/`。这是手工合成 fixture，不是真实会话。
5. **cliVersion / graphRebuild**：用目标 Node 运行安装后的 CLI。
6. **workspaceConfig**：只读仓库 `.zcode/config.json` 的登记状态；若工作区声明 `ano` 则按其
   command/args 启动，否则按去重后的用户级继承形态启动；覆盖 `ANO_ROOT` 与 cwd 到临时项目，
   校验 7 个工具和 `brief.phase=P7`。（2026-11-27 起工作区改为空 `mcp.servers` 去重继承，
   见 [zcode-integration.md](zcode-integration.md) 与 D-0019。）
7. **tarballWorkspaceConfig**：用临时项目的 `.zcode/config.json`（指向安装包）启动 MCP。
8. **track / brief / explore**：MCP 调用链，`track` 创建 `SELFHOST-T1`，`brief` 读回，
   `explore(query=greet)` 返回 1 个符号。
9. **note / recall**（MCP）与 **cliNote / cliRecall**（CLI）：
   - `note` 成功必须是 `recorded`/`duplicate`，否则不记通过。
   - `recall` 必须解析出 `status=ok|degraded` 且 `summary.total > 0` 才记 `passed`；
     `not_configured` 记 `not-configured`；明确未实现文案记 `unimplemented`；
     其他错误记 `failed`。
10. 任一 wiring 检查为 `unimplemented`/`not-configured` 时，总体降为
    `passed-with-limitations`；全部真实成功才是 `passed`。
11. 默认递归删除临时目录；`--keep` / `ANO_SELFHOST_KEEP=1` 保留现场。

脚本不启动仓库 cwd 下的 ANO 服务，不向仓库 `.ano` 写入。本轮运行前后仓库 `.ano`
文件时间未变化（最新仍为 18:52，运行发生在 19:01–19:02）。

### 3.2 `scripts/node-matrix.ts`

- 目标：`node-22`（期望 `>=22.18 <23`）与 `node-24`（期望 `>=24 <25`）。
- 二进制来源：`ANO_NODE22` / `ANO_NODE24`；未设置时仅当当前运行时满足该 major
  才复用 `process.execPath`。
- 缺失、无法执行或无法读取版本 → `missing`；版本越界 → `failed`；满足要求才自举。
- 自举结果原样作为 target 状态；`passed-with-limitations` 会让矩阵总体 `incomplete`。
- 退出码：`passed=0`、`incomplete=2`、`failed=1`。
- 默认写 `docs/evidence/node-matrix.json`。

### 3.3 `test/integration/zcode-selfhost.test.ts`

两个测试：

1. `planNodeTargets`：当前 v24 且未给 `ANO_NODE22` 时，`node-22.path` 必须为 `null`，
   reason 明确说明缺失。
2. 真实执行一次 `runSelfHost()`：断言 build/pack/install/CLI/图重建/两种 workspace
   配置启动/track/brief/explore/note/recall/cliNote/cliRecall 全部 `passed`；临时工作区
   必须在 `os.tmpdir()` 且不在仓库内；`tempRemoved=true`。

## 4. 实测结果

### 4.1 自举（Node 24.14.0）

`docs/evidence/node-matrix.json` 的 `node-24` target，自举生成时间
`2026-11-19T11:01:51.181Z`：

| 检查 | 状态 | 本次实测耗时 (ms) | 关键结果 |
| --- | --- | ---: | --- |
| build | passed | 2635.3 | `npm run build` |
| pack | passed | 756.3 | tarball 326,372 bytes |
| install | passed | 2529.8 | `node_modules/agent-nihil-obstat` |
| cliVersion | passed | 196.3 | `0.1.0-alpha.0` |
| graphRebuild | passed | 833.3 | 2 files / 1 symbol / fresh |
| workspaceConfig | passed | 358.4 | 仓库 config 启动，7 tools，`phase=P7` |
| tarballWorkspaceConfig | passed | 6.1 | 安装包 config 启动，7 tools |
| track | passed | 108.2 | `SELFHOST-T1`，`taskStatus=in_progress` |
| brief | passed | 56.5 | `phase=P7`，读回 `SELFHOST-T1` |
| explore | passed | 35.7 | `query=greet`，total=1 |
| note (MCP) | passed | 41.7 | `status=recorded`，返回 eventId |
| recall (MCP) | passed | 95.8 | `status=ok`，`mode=fts`，total=2 |
| cliNote | passed | 235.8 | `status=duplicate`（幂等重放） |
| cliRecall | passed | 285.3 | `status=ok`，`mode=fts`，total=2 |

- tarball：`agent-nihil-obstat-0.1.0-alpha.0.tgz`
- SHA-256：`3c52625b8dc2399e49d19d6d85b741194aee3f7e97d015cad2209b6d1773bb66`
- 单个 target 总耗时（含 build/pack/install）：9,282.8 ms
- 自举总体裁决：`passed`

`recall` 的 `summary`：1 个 provider（`synthetic-alpha`）、1 个 unit、4 条消息、
visible 4、skippedArtifacts 0；命中 `alpha-m2` 等 2 条。

以上数字是这台机器、这一次运行的墙钟时间；build/install 受本机与 npm 缓存影响，
不能作为性能承诺。

### 4.2 集成测试

```text
node --test test/integration/zcode-selfhost.test.ts

✔ node matrix plans a missing Node 22 leg instead of passing it (0.6388ms)
✔ real tarball self-host launches workspace MCP config and exercises track/brief/explore/note/recall (9027.2976ms)
ℹ tests 2
ℹ pass 2
ℹ fail 0
ℹ duration_ms 9282.5779
```

### 4.3 类型检查

```text
npx tsc -p tsconfig.json --noEmit
exit=0
```

本阶段三个文件的独立严格 typecheck 也通过（exit 0）。

### 4.4 Node 矩阵

```text
ANO_NODE22=<隔离的官方 Node 22.18.0> node scripts/node-matrix.ts
exit=0
```

| target | 期望 | 状态 | 实测 Node | 耗时 (ms) |
| --- | --- | --- | --- | ---: |
| node-22 | >=22.18 <23 | passed | v22.18.0 | 9558.4 |
| node-24 | >=24 <25 | passed | v24.14.0 | 9585.8 |

- 矩阵生成时间：`2026-11-19T11:04:32.936Z`
- 总体：`passed`
- 两 target 的自举均 14/14 passed；tarball SHA-256 `3c52625b…1773bb66`。
- 早先缺 Node 22 的 `incomplete` 历史保留在本节演进记录中，不用最新通过覆盖旧失败。

## 10. 主控统一收口（2026-11-19）

- `verify:all` 12/12：typecheck/test/coverage/build/assets/schema/docs/ZCode/P1/package/证据。
- 完整测试 333/333，Spike 22/22；覆盖率行 96.14%、分支 87.64%、函数 94.77%。
- pm-mcp 质量矩阵 `quality-20261119-111827-255-0000.json` 全绿且源码稳定。
- 覆盖率限定本仓库 `src/**`，排除被测临时项目的源码副本；不降低 90/80 门槛。
- ANO 自身接管任务 `ANO-M5-001` 的 Gate 返回 blocked：仓库尚无 Git 基线提交，全部文件进入变更，
  不能凭专项测试宣称全部覆盖；该裁决未被手工改成 done。


## 5. note / recall 证据

| 路径 | 结果 | 证据摘要 |
| --- | --- | --- |
| MCP note | passed | `status=recorded`、`duplicate=false`、eventId `01M7S...` |
| CLI note | passed | `status=duplicate`、`duplicate=true`，同一 note id |
| MCP recall | passed | `status=ok`、`mode=fts`、`total=2`、`degraded=[]` |
| CLI recall | passed | `status=ok`、`mode=fts`、`total=2`、`exit=0` |

`recall` 只读取临时项目中显式复制的 `.ano/memory/synthetic/synthetic-alpha/unit-visible`。
`brief.limitations` 同步声明 `recall reads only explicitly imported synthetic fixtures`。
本结果证明路径与结构化检索可用，不证明真实客户端格式、真实会话排序或 provider 兼容性。

## 6. 隔离与安全边界

- 自举项目、install 目录、tarball 全在 `os.tmpdir()`；运行后删除（`tempRemoved=true`）。
- 仓库 `.zcode/config.json` 只读；启动时覆盖 `ANO_ROOT` 与 cwd 到临时项目。
- 未执行 `npm publish`、`git push`、远端发布。
- 未读取任何真实会话目录；只有手工合成 fixture（含一条带提示注入文本的合成消息，
  用于确认它是 untrusted 数据，不会被当作指令执行）。
- 未运行全量 `npm test`、覆盖率或 `run_quality_matrix`；只跑了本阶段脚本与本文件两个测试。
- 安装使用 `--ignore-scripts`，没有执行依赖安装脚本。
- 仓库 `.ano` 未被本阶段脚本写入；本轮前后文件时间未变化。

## 7. 未完成 / 限制

1. **历史缺口已补齐**：主控已提供官方 Node 22.18.0 并执行矩阵；最新证据两 target 均 passed。
   早期缺二进制的 `incomplete` 仅作历史记录，不是当前状态。
2. **recall 只验证合成 fixture**。不是真实客户端会话，不证明真实格式解析、排序质量或
   provider 兼容性；没有读取真实会话。
3. **工作区配置检查使用仓库配置中的 Node 24**。对 `node-22` target，只有安装后的
   tarball CLI/MCP 使用目标 Node；仓库 `.zcode/config.json` 的 command 原样使用，
   因此该检查不能替代 Node 22 的 workspace 启动验证。
4. **合成项目很小**。2 个文件、1 个符号、1 个合成会话（4 条消息），不代表真实项目规模。
5. **性能数字仅本次观测**。build 首次包含 TypeScript 全量编译；install 受 npm 缓存影响，
   不能横向比较。
6. **未验证 ZCode 客户端 UI**。验证的是 workspace `.zcode/config.json` 的 stdio 启动契约，
   不是客户端实际加载、重启或权限提示。
7. **未验证发布流程**。没有 publish、远端 tag、三平台 CI 或安装后 postinstall。
8. **wiring 状态是动态的**。如果后续源码把 note/recall 改回未实现，脚本会记
   `unimplemented` 并把总体降为 `passed-with-limitations`，不会沿用本次 `passed`。
9. **`.npmrc` 的 `ignore-scripts=true` 是打包陷阱**。任何只跑 `npm pack` 的流程都会带上
   现有 `dist/`；本脚本显式 build 规避，但其他打包脚本仍需注意。

## 8. 复现

```bash
# 仅自举（当前 Node）
node scripts/selfhost.ts

# 自举并保留临时现场
node scripts/selfhost.ts --keep

# 指定目标 Node 二进制
node scripts/selfhost.ts --node "C:/path/to/node.exe"

# Node 矩阵（缺 Node 22 时退出 2，并写 docs/evidence/node-matrix.json）
node scripts/node-matrix.ts

# 提供 Node 22 实际二进制后
ANO_NODE22="C:/path/to/node22/node.exe" node scripts/node-matrix.ts

# 本阶段集成测试
node --test test/integration/zcode-selfhost.test.ts
```

## 9. 给主控的下一步

1. Node 22/24 自举已实测；后续变更应重跑 `node scripts/node-matrix.ts` 与完整验收，不能沿用旧哈希。
2. 用真实（授权）客户端样本替换 recall 的合成 fixture 之前，不要把当前 `recall`
   结果扩展解释为真实会话检索能力。
3. 若后续修改 note/recall surface，重跑 `node scripts/selfhost.ts` 与本测试；
   脚本会自动降级或恢复，不需要改断言。
