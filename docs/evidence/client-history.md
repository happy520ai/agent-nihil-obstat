# 会话历史适配与隐私边界证据（T-087 / MC-09）

- 日期：2026-11-23
- 任务：T-087 / MC-09（M11），依赖 T-080~T-084
- 执行者：子代理（唯一实现者）；PM 簿记由主控负责
- 交付物：`test/integration/client-history.test.ts`、本报告、`docs/client-compatibility.md` §9
- 性质：只读验证 + `os.tmpdir()` 合成 fixture；未读取任何真实会话目录（`~/.claude/projects`、`~/.codex/sessions`、`~/.cursor` 等），未读取秘密，未修改 `src/**`、真实客户端配置、`.pm/`、`.ano/`
- 上游契约：`docs/adr/ADR-007-client-adapters.md` §2.3 / §3（history 行）/ §7；`docs/client-compatibility.md` §2（E8）、§3.2、§6

## 1. 结论

**范围内完成，真实兼容未验证。** 八客户端 `history` 层在无授权样本、无公开格式时全部 `unavailable`（DSH/Pi 另为客户端 `unknown`），`sampleAuthorized=false`、`parsedRecords=0`、`privacy='not-read'`；授权采样契约 fail-closed（缺授权/作用域错误/根路径无效/路径逃逸/软链/真实会话路径/未知格式/损坏 JSON 均零读取或拒绝）；合成 fixture 只产出结构元数据（条数/时间范围/格式标识），永不升级 `history`；撒谎 adapter 自报 `validated` 被降级为 `degraded`/`assumed`。

- 真实会话样本：**无**（`[数据缺失]`）。本任务未获得任何用户明确授权的真实样本，未读取真实会话目录。
- 公开会话格式：**未知**（`unverified`）。未核实到可据以编写 parser 的公开格式；因此**不编造 parser**。
- 合成 fixture 只证明机制（授权、fail-closed、隐私最小化），**不证明真实客户端兼容**，不升级任何单元格。
- `src/clients/**` 本任务只读；`history` 边界门与采样契约作为可执行契约交付在测试内，并写入 `docs/client-compatibility.md` §9。

## 2. 八客户端 history 矩阵（逐层）

判定口径：verdict 三值 `validated / degraded / unavailable`；`unknown` 仅用于客户端身份状态。`history` 是扩展层（E8），不参与 `coreVerdict`。

| 客户端 | ClientId | history verdict | evidence | 真实样本 | 格式 | 状态口径 |
|---|---|---|---|---|---|---|
| Claude Code | `claude-code` | `unavailable` | `absent` | `[数据缺失]` | 未知 `unverified` | 未读取 |
| cloudcode | `claude-code`（alias） | `unavailable` | `absent` | `[数据缺失]` | 未知 `unverified` | 同 Claude Code |
| Codex | `codex` | `unavailable` | `absent` | `[数据缺失]` | 未知 `unverified` | 未读取 |
| Cursor | `cursor` | `unavailable` | `absent` | `[数据缺失]` | 未知 `unverified` | 未读取 |
| OpenCode | `opencode` | `unavailable` | `absent` | `[数据缺失]` | 未知 `unverified` | 未读取 |
| Qoder | `qoder` | `unavailable` | `absent` | `[数据缺失]` | 未知 `unverified` | 未读取（适配器明示 `never read`） |
| DSH | `dsh` | `unavailable` | `absent` | `[数据缺失]` | 未知 | 客户端 `status='unknown'`，永不 `validated` |
| Pi | `pi` | `unavailable` | `absent` | `[数据缺失]` | 未知 | 客户端 `status='unknown'`，永不 `validated` |
| ZCode | `zcode` | `unavailable` | `absent` | `[数据缺失]` | 未知 `unverified` | 未读取 |

- 全部八客户端 `details = { source: null, formatVersion: null, sampleAuthorized: false, parsedRecords: 0, privacy: 'not-read' }`。
- 任何单元格都**不得**标 `validated`；合成 fixture 通过不改变本表。

## 3. 授权采样契约（可执行，测试内）

采样函数 `HistorySampler.sample` 的显式参数：

| 参数 | 要求 | 缺失/非法后果 |
|---|---|---|
| `authorization` | 必须存在 | `HISTORY_SAMPLE_UNAUTHORIZED`，零读取 |
| `authorization.scope` | 必须包含 `history` | `HISTORY_SAMPLE_SCOPE_MISSING`，零读取 |
| `authorization.sampleRoot` | 必须存在且为目录 | `HISTORY_SAMPLE_ROOT_INVALID`，零读取 |
| `samplePath` | 必须位于 `sampleRoot` 内 | `HISTORY_SAMPLE_PATH_ESCAPE`，零读取 |
| `samplePath` | 不得为软链 | `HISTORY_SAMPLE_SYMLINK_REFUSED`，零读取 |
| `samplePath` | 不得命中真实会话存储（`.claude/projects`、`.codex/sessions`、`.cursor`） | `HISTORY_SAMPLE_REAL_SESSION_REFUSED`，零读取 |
| 扩展名 | 仅 `.json` / `.jsonl`（已知格式） | `HISTORY_SAMPLE_FORMAT_UNKNOWN`，零读取，不编造 parser |
| 内容 | 可解析 | `HISTORY_SAMPLE_PARSE_FAILED` / `HISTORY_SAMPLE_EMPTY`，拒绝 |

输出结构元数据（仅此四项）：

```json
{ "recordCount": 3, "timeRange": { "start": "...", "end": "..." }, "format": "json", "synthetic": true }
```

- 不输出会话内容、消息、提示词、密钥/令牌字段；测试断言六个敏感标记（content/message/api_key/token/prompt/text）均不出现在输出 JSON。
- `timeRange` 仅取记录的时间戳字段（`timestamp`/`ts`/`time`/`createdAt`/`created_at`/`updatedAt`），无时间戳则 `null`。

## 4. 隐私最小化与 fail-closed 证据（测试断言）

| 场景 | 断言 | 结果 |
|---|---|---|
| 缺授权 / scope 无 `history` | 错误码正确且 `reads=[]` | 通过 |
| 根路径不存在 | `HISTORY_SAMPLE_ROOT_INVALID`，`reads=[]` | 通过 |
| 路径逃逸出授权根 | `HISTORY_SAMPLE_PATH_ESCAPE`，`reads=[]` | 通过 |
| 软链样本 | `HISTORY_SAMPLE_SYMLINK_REFUSED`，`reads=[]` | 通过 |
| 真实会话路径（合成 `.claude/projects` 与真实 `~/.claude/projects` 字符串） | `HISTORY_SAMPLE_REAL_SESSION_REFUSED`，`reads=[]` | 通过 |
| 未知扩展名 `.xml` | `HISTORY_SAMPLE_FORMAT_UNKNOWN`，`reads=[]` | 通过 |
| 损坏 JSON | `HISTORY_SAMPLE_PARSE_FAILED`，仅一次内容读取，无元数据 | 通过 |
| 合成 fixture 成功 | 仅结构元数据；敏感标记零出现；`synthetic=true` | 通过 |
| 合成样本 + 自报 validated 报告 | 边界门降级 `degraded`/`assumed` | 通过 |
| 撒谎外部 adapter（`registerExternalAdapter`，`validation.measured=false`） | `history='degraded'`、`evidence='assumed'`、`E_EXTERNAL_VERDICT_CAPPED`、`status!='ready'` | 通过 |
| 撒谎注入 adapter + 边界门 | 原始透传 `validated` → 门后 `degraded`/`assumed` | 通过 |

## 5. 合成 fixture 标注与不升级声明

- 本报告与测试中的 fixture 全部为 `os.tmpdir()` 下合成数据，并显式标注 `synthetic: true`。
- 合成 fixture 只验证机制：授权参数、路径/格式 fail-closed、隐私最小化、边界门。
- **不升级声明**：合成 fixture 通过 ≠ 真实客户端兼容；`history` 层在合成路径下仍不得为 `validated`（`enforceHistoryBoundary` 断言）。
- 真实样本缺失标 `[数据缺失]`，格式未知标 `unverified`；未编造 parser，未读取真实会话或秘密。

## 6. 未验证项清单

1. 真实会话样本读取：未执行（无授权样本，`[数据缺失]`）。
2. 真实公开会话格式：未核实，`unverified`；parser 未实现。
3. 真实客户端历史兼容排序：未执行；本任务只验证边界与隐私契约。
4. `history` 层与记忆声明通道的集成：未验证（ADR-007 §9 明示不把客户端历史接入 `memory.*` / Gate 完成通道）。
5. 跨 root 授权续接、移动目录后的身份续接：未验证（沿用 M10 结论）。
6. 掉电级持久性：未验证（沿用 M10 结论）。

## 7. 测试与验证

| 命令 | 结果 |
|---|---|
| `node --test test/integration/client-history.test.ts` | 13/13 通过 |
| `node --test test/unit/client-doctor.test.ts` | 13/13 通过（回归） |
| `npx tsc -p tsconfig.json --noEmit` | 0 错误 |

## 8. 实现说明与移交项

- `src/clients/doctor.ts` 对适配器提供的扩展层（含 `history`）原样透传：无适配器时 `buildHistoryLayer` 固定 `unavailable`；有适配器时采用适配器结果。T-087 未修改 `src/**`，边界门作为可执行契约与文档口径交付。
- `registerExternalAdapter`（T-084）已在无信任实测证据时把自报 `validated`/`measured` 降级，本任务复用该机制做防撒谎断言。
- 观察（非本任务缺陷）：`registry.ts` 中裸相对身份来源（如 `AGENTS.md`）在 `doctor.ts` 的 `expandPath` 中按进程 cwd 解析，仓库内存在 `AGENTS.md` 时会使 Codex/OpenCode/ZCode 的 `detected` 变为 `degraded`；只影响 `detected`/`status`，不影响 `history` 判定。已在测试注释中标注，未改 src。
- 移交 T-090 收口：把 §9 口径并入支持矩阵最终版；若后续取得授权真实样本与公开格式，再实现 parser 并按四层证据（时间/版本/来源/限制）升级。
