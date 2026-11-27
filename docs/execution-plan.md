# ANO 超级详细执行方案

> 基线：`ano-architecture-v1.0.md`，2026-11-18。
> 本文是执行控制面，不替代架构文档；冲突时先记录 ADR，不静默改变安全语义。
> 原则：实测 > 自报；任务完成 > 文档写完；失败判据 > 交付速度。

## 1. 交付定义与边界

### 1.1 最终交付物

1. `agent-nihil-obstat` TypeScript/Node ≥22.18 包，安装后 CLI 为 `ano`。
2. 追加式 segment 账本、可重建 SQLite 视图/图/历史缓存。
3. TS/JS L0/L1 结构图，L2 在完成 Phase 3 验收后交付；重导出三档、三态边、impact 超集与 T1 子集。
4. 可验证的任务 verdict、release verdict；机器裁决与人工批准严格分离。
5. 恰为 7 个 MCP 意图工具及 CLI；目录/配置/provider 文档由代码生成。
6. 热门会话客户端 adapter 框架与逐项实测兼容矩阵；没有真实样本的客户端保持 `planned/unvalidated`。
7. 测试：单元、真实 SQLite/stdio/git 集成、红队、Windows 路径/锁/CRLF、崩溃恢复。
8. 文档：架构、Spike、ADR、每阶段报告、限制、迁移、安装、CI 和证据索引。
9. 发布材料：tarball、SHA-256、CHANGELOG、SECURITY、限制说明；推送和发布须另行授权。

### 1.2 明确不假装完成

- v1 不做 Rust 内核、41 种语言、Electron、obelisk 全 provider/recap、自动任务派发。
- 所有“热门客户端支持”不能靠猜测格式兑现；只给可扩展机制 + 实际验证过的 adapter。
- 不将 profile 的 `defined` 称为 `validated`，不将 T1 启发式称为正确性证明。
- 不读取/复制 obelisk 源码，不加载宿主 TypeScript，不擅自采集真实会话。
- 不将当前架构的 15–20 周线性估算压缩成虚假日历承诺；并行只减少等待，不减少验收。

## 2. 已决策略

| 项 | 执行策略 |
|---|---|
| 包名 | `agent-nihil-obstat`；`ano` 仅 CLI |
| 开源策略 | MIT，独立实现；不进入 obelisk 源码 |
| 语言 | TS/JS，其他语言未覆盖 |
| 模块解析 | 自带、内置 resolver；宿主 TS 禁止；未解析一律 unknown |
| 会话采样 | 未授权；S1 只做机制段；真实采样前逐项询问 |
| 证据来源 | v1 文件适配器，不直连外部 CI/部署/监控 |
| 远程动作 | 本地交付优先，创建远程/push/publish/Release 单独授权 |
| 工作流 | pm-mcp 账本 + 主控集成 + 并行专用 agent；每批独立文件边界 |

## 3. 工作分解与依赖图

```text
G1/G4/G10 ──> P0 脚手架 ──> S1..S7 机制验证 ──> P0 报告
                                            │
                                            ▼
                                      P1 最小账本/指纹
                                            │
                                     TS/JS 图 + 模块解析
                                            │
                                    impact/T1 + task verify
                                            │
                                     P1 判定实验与否决门
                                            │
                         ┌──────────────────┴──────────────────┐
                         ▼                                     ▼
                P2 完整账本/门禁                         P7 数据模型设计
                         │                                     │
             ┌───────────┴───────────┐                        │
             ▼                       ▼                        │
           P3 Structure           P4 Memory                  │
             │                       │                        │
             └───────────┬───────────┘                        │
                         ▼                                     │
                  P5 Audit/Surface                             │
                         │                                     │
                         ▼                                     │
                    P6 硬化 <─────────────────────────────────┘
                         │
                         ▼
              P7 真实 profile 验证（G7）
                         │
                         ▼
                  P8 授权后的发布
```

P7 可以在 P2 稳定后并行实现框架，但不得绕过 P1 否决门，也不得提前标 profile validated。

## 4. 并行执行拓扑

| 工作流 | 责任 | 独立文件域 | 主控集成点 |
|---|---|---|---|
| 检索 | S1 机制、tokenizer、recall 红队 | `src/memory`、S1 文档/脚本 | SQL 注入、CJK/标识符、ICU 重建 |
| 结构 | S2/S4/S7、TS/JS extractor、图查询 | `src/structure`、相关 fixture | 三态、重导出、freshness |
| 账本 | S3/S5/S6、append/replay/idempotency | `src/ledger`、`src/core` | 崩溃、并发、分支合并 |
| 控制面 | CLI/MCP、docs、CI、发布材料 | `src/surface`、根配置 | 7 工具、人工边界、安装 |
| 主控 | 架构一致性、质量证据、pm-mcp、验收 | 可跨域但不在并行时争写 | 合并、真实执行、最终裁决 |

每个并行批次遵守：先读接口契约、预写验收、只动自己的文件、返回实际命令和失败；主控不接受“应该能跑”作为完成证据。

## 5. Phase 0：准备与 Spike

### Step 0.1 名称查重

- 执行 `npm view` 精确名称与 `npm search`；保存实际 JSON/E404。
- 查 GitHub 公共页面/API，记录可见结果与不可见资源限制。
- 尝试官方商标来源；若未发生有效检索，标未完成而不是“零冲突”。
- 产出 `docs/name-check.md`。
- 验收：有查询式、日期、原始结果、范围限制；不执行注册或发布。

### Step 0.2 脚手架

- 根：`package.json`、锁文件、严格 `tsconfig`、MIT LICENSE、README、`.gitignore`。
- 源目录：core/ledger/structure/memory/gate/audit/readiness/surface。
- 测试目录：unit/integration/redteam/fixtures。
- 文档生成：唯一工具目录、版本、Node engines 从代码读取。
- 验收：`npm ci && npm run typecheck && npm test && npm run build && npm run check-docs`。
- 反假交付：CLI 未实现命令退出 2；不得返回“已就绪”。

### Step 0.3 CI

- GitHub Actions 矩阵：Ubuntu/Windows/macOS × Node 22.18/24。
- 顺序：类型 → 测试 → 构建 → 文档防腐 → `npm pack --dry-run`。
- 本地无远程时标“workflow 已编写，远端矩阵未运行”；不得声称三平台已绿。

### Step 0.4 Spike 统一规程

每份 `docs/spikes/Sx.md` 必须包含：问题、预写判定标准、环境、脚本路径、实际命令、原始输出位置、实测结论、失败备选、不能推断的事项。失败不修改判定标准凑绿。

#### S1 检索机制

1. 记录 Node/ICU/Unicode 与 SQLite 编译能力。
2. 实际建 FTS5 trigram 表；二字、三字、中英混排、非 BMP fixture。
3. 对 1/2/3 Unicode 码点查询 MATCH、LIKE 和 EXPLAIN QUERY PLAN；记录行数与扫描方式。
4. 检查 ESCAPE、大小写、标识符/CJK 紧邻的 Segmenter 行为。
5. 同一确定性拆分函数处理连续大写、驼峰接缩写、数字边界、分隔符；用例固化。
6. 记录 FTS 不可用时内存倒排、Segmenter 不足时 2-gram 的退路。
7. 无真实样本：不计算/不宣称 P@5、Recall@20 排序结论。

#### S2 tree-sitter

- Node 24.14 + Windows 实测，web-tree-sitter 与 TS/JS WASM 版本固定。
- 连续解析 5000 份生成源码；记录吞吐、RSS/heap 峰值与末值、异常、GC 条件。
- 增长“有界”按预写阈值与最后窗口趋势判定；不在看到数据后改阈值。
- 仅测 Node 24 就明确 Node 22 待 CI，不外推。

#### S3 HLC

- 原型实现 `tick/recv`，使用虚拟时钟，不依靠 sleep 模拟回拨。
- 测同 actor 回拨 5 秒、跨 actor 消息、因果序、稳定 tie-break、重放合并。
- 断言事件唯一、无丢失、父先于子、排序确定。
- 记录 HLC 不证明真实时间、不防止恶意 actor 的边界。

#### S4 codegraph 库接入

- 只读公开 README/package/Library Usage；核实真实包名与版本。
- 用不超过 50 行调用公开 API；记录导出、配置耦合、Node/OS 约束。
- 若 API 不适合，P1 默认自写最小 L0/L1，不为复用而绕过降级要求。

#### S5 原子追加

- 在 `batch.begin` 至 `batch.end` 每个字节边界生成崩溃点。
- 子进程真实被强杀；恢复方验证无未提交事件。
- 自己 segment 可截断；他人 segment 只忽略，前后 SHA-256 不变。
- 检查幂等已提交重试、文件锁、fsync 顺序；失败则考虑 SQLite WAL 账本。

#### S6 分支合并

- 本地合成 git 仓库，三分支各自创建 segment。
- 合并文件并集；重放总数 = 三分支总和，各单链校验通过。
- observed 指向存在/缺失的 segment 分别有测试；不虚构跨 segment 全链。
- 冲突或断链不通过；必要时每 actor 独立目录。

#### S7 模块解析

- 比较：A 内置轻量 resolver；B 自带 pinned `typescript` resolver；C 宿主 TS（已禁止，不执行）。
- 合成相对路径、扩展名/index、`tsconfig.paths`、package exports/#imports、workspace 引用。
- 记录解析结果、未知降级、启动/内存/耗时；微型 fixture 数据不外推成规模基准。
- P1 至少实现相对路径及目标 fixture 中验证过的形态，其他显式 unknown。

### P0 完成门

- 名称报告和决策记录落盘；商标未查清项明确。
- 脚手架真实质量命令绿。
- S1 机制 + S2–S7 报告和原始结构化结果齐全。
- S5/S6 失败：暂停并改账本设计；其它失败按备选路线，留 ADR。
- S1 排序、远端 CI、法律清查不能暗中标完成。

## 6. Phase 1：融合竖切

### 1.1 最小账本

- 事件：ULID/HLC/actor/kind/payload/idem_key/prev_hash。
- 只实现 task.created/task.updated/evidence.recorded；segment 头、begin/end、checksum。
- 视图仅任务/证据表；拒绝重复键异参，返回已提交同参结果。
- 测试：追加、重放、残尾、他人只读、同参/异参幂等。

### 1.2 指纹

- 按规范化相对路径排序；文件字节 SHA-256，再算目录树哈希。
- 排除 `.ano` 缓存、VCS/依赖/构建产物与项目 ignore 项；账本事实是否参与指纹必须固定并测试，避免“写证据改变证据指纹”循环。
- 默认拒绝 symlink/非普通文件；stat/read 前后大小、mtime 或 hash 不一致报 unstable。
- 中文/空格/CRLF 路径；同内容一致、改字节变化、读取时改变失败。

### 1.3 TS/JS 最小图

- 节点 ID = 内容/语义身份，不含行号；Anchor 定位定义文件。
- L0：静态 import、side effect、动态/require 未知。
- L1：定义、包含、导出表、symbol_kind；同名混合声明任一 value 即 value。
- 显式 type → type-only；具名 re-export 穿到定义；wildcard/dynamic → heuristic/unknown。
- barrel 环检测和深度上限；超限不静默丢边。
- 扫描 I/O 异常保留旧数据并 degraded；只有明确 ENOENT 墓碑。
- freshness：fresh/stale(n)/degraded；Gate 禁用过期图裁决。

### 1.4 impact/T1

- impact 反向可达超集：value + type + unknown + heuristic。
- T1 只从实际执行测试沿 value-confirmed 到定义文件。
- barrel 的其他导出、纯类型、unknown 均不算覆盖。
- strict 默认要求 unknown/heuristic 引入文件也覆盖；advisory 只能显式配置并显示。

### 1.5 最小任务裁决

- argv 数组、shell=false、超时、环境摘要、退出码、解析计数、stdout/stderr 摘要 SHA-256。
- 先 `verify.started` 后 `verify.finished`；崩溃留下未完成。
- `done` 必须同时有成功且当前指纹证据、政策覆盖、无失败/跳过/取消/todo、fresh 图或明示降级。
- 失败证据可入账，不得算产出；失败摘录脱敏，不存原始输出。

### 1.6 判定实验

按架构逐条执行，不缩减：A/B/C 覆盖缺口、pm-mcp 对照、补 C 后通过、stale 拒绝、barrel 精确 impact、类型修改仍计 impact、barrel 不误覆盖、隐式 interface 和 interface+const 混合。

真实项目先统计 barrel/export *，再确定 N；报告每文件的 resolved/full blast、中央値/p90、三态、unknown、heuristic、动态计数。80% 是人为触发线，不是安全证明；触发即停下讨论，不自动 advisory。

**失败判据**：步骤 3 误放行/误拒、图与账本新鲜度无法对齐、真实 unknown/heuristic 或误报使门禁不可用。任一成立即停 P2–P8，提交 phase-1-report 和修正设计建议。

## 7. Phase 2：账本与门禁完整化

1. **事件/视图**：完整类型、HLC、observed 头哈希、增量/全量物化；崩溃/合并测试重做。
2. **幂等并发**：views.db 跨 segment 索引；20 进程写，验证零丢失/零重复，记录实际结果。
3. **租约**：Run heartbeat/reclaim/reclaimed_from；回收默认 produced_evidence=false。
4. **Evidence**：T0/T1、输出哈希、脱敏、strict/advisory 显式策略。
5. **工作区**：显式 root > 请求指纹 > 唯一活跃会话 > 启动提示；歧义写 fail-closed。
6. **迁移**：只读 `.pm`，旧 ID 幂等；两次导入第二次零新增、任务一致。
7. **红队**：fixed 复现、恒真断言、skip 增长、预算自肥、删账本、忽略 `.ano`、空洞笔记、并发、旧断点。
8. **文档防腐**：生成 + diff；故意改版本测试 CI 失败。

完成门：实测行覆盖 ≥90%、分支 ≥80%，三平台实际 CI 绿，自举通过。不达标保留红，不通过改阈值掩盖。

## 8. Phase 3：Structure

- L2 调用名称解析，resolved/heuristic 分边。
- unknown 重试与 degraded 恢复；SQLite `BEGIN IMMEDIATE` leader，强杀接管实测。
- `explore` 编排 symbol/flow/impact/search/outline，客户端预算实测而非照搬 24K。
- T2 只走 resolved 调用边，不与 T1 语义混用。
- 每种语言小/中/大真实仓库各至少 3 个 flow；没有通过不宣布支持。
- 基准记录首次/增量/impact 时间和内存，保存原始数据与硬件环境。

## 9. Phase 4：Memory

1. 先列候选客户端（例如 ZCode、Claude Code、Codex、Cursor、Gemini CLI、GitHub Copilot、Qoder、WorkBuddy 等），但每个单独标 `planned`。
2. 获采样授权后，按客户端最小采集、脱敏、格式版本/日期记录；不凭其他客户端猜格式。
3. adapter 纯函数 discover/parse；唯一写层；visibility、skippedArtifact、marker/cursor 退化。
4. 固定参数化 SQL；恶意 transcript 只作为文本处理，永不执行。
5. S1 胜出机制落地；同 tokenize 函数、meta 版本、单字 LIKE 降级、原文 snippet。
6. note memory 必带 Anchor；symbol_id → qualified_name+file → file+片段 hash，失败 stale。
7. brief 汇总焦点、知识、缓存新鲜度与未 explore 修改提示。

兼容矩阵至少包含：客户端、格式版本、样本来源授权、discover/parse/recall 测试、状态、限制。没有真实 fixture 不得标 supported/validated。

## 10. Phase 5：Audit、基线与 Surface

- audit drift/security/license/governance/deps；Finding 只存秘密指纹和位置。
- 联网 OSV/反查必须显式 confirm；离线默认。
- 基线版本化、批准不可变、SHA-256 复算、三件套不可覆盖；伪造 PASS 红队。
- CLI 完整；doctor 同时识别 npx 发布入口和本地入口。
- 面板仅 127.0.0.1、GET、CSP、输出转义；不新增未经批准的远程端口暴露。
- AGENTS.md 增量合并；schema hash 测试，改动显式升版。

## 11. Phase 6：硬化

- 三平台 typecheck/coverage/build/docs/self-host 全绿。
- 真实项目试运行记录误拒、误放行、噪声、性能；不能将一周试运行压缩成未执行的报告。
- `npm pack` → 干净目录安装 → `ano probe` 真实 stdio tools/list 恰为 7。
- 安装包不带测试 fixture 秘密、Spike 临时产物、缓存或本机路径。
- 报告所有未解决问题，不能为了发布删掉失败记录。

## 12. Phase 7：Readiness

- 数据：profile/item、attestation.signed、release.verdict/approved；TOML schema hash。
- 文件 EvidenceProvider：来源、时间、源码/制品绑定、原始哈希、新鲜度。
- CLI TTY 具名 attest；非 TTY 拒绝，MCP 无此能力，过期自动降级。
- 通用项全部真实执行或标 attested/missing；植入假密钥 tarball 必须 blocked。
- 库和服务各用一个真实项目验证后才标 validated；其余 defined。
- ready/conditional/blocked 按证据计算；制品变更使证据和批准失效。
- 红队：手填 machine、attested 伪装 machine、旧证据、过期、制品变化。

## 13. Phase 8：发布

1. README/CHANGELOG/SECURITY/limitations，所有数字生成并核对。
2. 版本先 0.1.0 alpha；升 1.0 需另行确认。
3. 创建远程、push、tag、GitHub Release、npm publish 每一步单独授权。
4. 固定 release tarball + SHA-256 + npm OIDC；发布后 registry integrity 核验。
5. 干净环境 `npx -y agent-nihil-obstat@<version>` probe，核验 7 工具。
6. 发布失败如实保留；不重试成不同包、不更改名称绕冲突。

## 14. 验收与证据台账

| 层级 | 必存证据 | 不允许的替代 |
|---|---|---|
| 源码 | 类型、构建、测试、覆盖率原始输出 | “代码看起来正确” |
| 图 | fixture、revision、三态/动态统计 | 只验证能建库 |
| 账本 | 崩溃注入、哈希、重放、并发日志 | 单进程 happy path |
| 检索 | 机制输出、脱敏真实样本指标（若授权） | 从记忆宣称分词器行为 |
| 任务裁决 | 当前源码指纹、argv、退出码、图 revision | 新报告文件存在即通过 |
| 发布 | tarball/哈希/冒烟/人工批准 | agent 自己宣布 ready |

pm-mcp 管理本次开发过程，不证明 ANO 自身功能已经实现。每项 feature 只有关联实现与测试、最新成功报告匹配源码才转 done；文档/chore 完成也不等于系统 ready。

## 15. 风险处置与停止条件

- S5/S6 核心账本验证失败：停止相应实现，评估 SQLite WAL 或 actor 目录。
- P1 任一失败判据：停止后续阶段，保留输出，先做设计修正。
- 外部样本未授权：Memory 只交付框架/合成机制，不进入真实采样。
- 真实 profile 缺失：Readiness 仅 defined，不标 validated。
- 商标未查清：不得声明名称无冲突，发布前解决。
- CI 无法远端运行：只声称本地已验证平台/Node 版本。
- 任何安全扫描高危项：阻断发布；修复后复扫，不接受无记录风险。

## 16. 当前可核验进度

- 已初始化 pm-mcp，建立 M1–M4 和 T-001–T-004。
- 用户已决 G1/G4/G6/G10；G2 按 TS/JS 默认；G3 未包含采样授权。
- 根目录原始状态只有架构文档；实现和验证从本次执行开始。
- 具体 Spike 的通过与否只以各自报告及 `docs/evidence/` 实际结果为准。
