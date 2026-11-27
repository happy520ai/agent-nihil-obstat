# ANO 交付状态

## 交付定位

本项目当前交付为 **P0–P7 + M5 本地 alpha + Connect 接入基础 + M10 项目级强制接管 + M11 多客户端自适应接入**：新增本地 PM-mcp 只读接入、来源历史与业务状态保真、CLI/MCP 生命周期和独立向导，显式授权/六阶段/可恢复的强制接管，以及按宿主真实能力分层报告并自动降级的多客户端接入。不是完整 v1、不是公开发布、不是对 pm-mcp/codegraph/obelisk 的全量替代。

## ADR-013 产品收敛状态（2026-11-26）

- **M19 已完成 8/8**：ZCode 真实 SessionStart/PreToolUse/Stop 钩子验证通过；工具级 enforcement 已接入，输出拦截仍不可用。
- **M20 已完成 3/3**：机械会话摘要、最近会话/未解决检查 brief、Unicode 码点预算紧凑投影和真实三会话连续性通过；最终报告 `quality-20261126-070542-062-0000.json`，2200/2200、零跳过、源码稳定，覆盖率 97.74/88.42/97.62。
- **M21 已完成 3/3**：personal/full 配置、核心帮助与 doctor 可见性、非 TTY 零写/TTY 逐步确认 setup、七工具精简描述通过；最终报告 `quality-20261126-073548-525-0000.json`，2212/2212、零跳过、源码稳定，真实 ZCode stdio 握手仍为七工具。
- **M22 已由具名人工判定闭环（2026-11-27，project owner）**：接管 enforced（授权人 project owner）、两项切换任务有有效 Gate evidence、两个候选真实工作会话（`<session-1>`、`<session-2>`）经 ReadSession 核实同属 `<example-project>` 并在执行真实 M0 整改；三次会话的量化指标与误拦标注**未采集**，停止判据为 `insufficient-data`，闭环依据是项目所有者的具名判定而非指标。如实记录见 内部 M22 证据（未公开）。M22 与 M23 均关闭，停止扩展契约复位为「M23 为最后一个产品里程碑」。

## ADR-014 / M23 Python 语言包状态（2026-11-27）

- **实现与自动化证据已完成，用户选择夹具级收口**：EvidenceAdapter 抽取保持 Node Evidence/Verdict 字节级一致；pytest 适配器、受限 JUnit XML、Python L1、导入三态、分派接线、四个夹具金标准与红队均已落地。project owner 于 2026-11-27 明确选择 PM 证据验收与 `supported-fixture-only`，不伪造 `evidence_id`。
- **真实 pytest 五场景通过**：全通过、有失败、有 skip、无测试、收集错误在本机真实 Python/pytest 上运行，零环境 skip；解释器不走 PATH，结果 XML 由 ANO 独占并在读取后删除。
- **当前严格全量覆盖**：2506/2506，fail=0、skip=0；行/分支/函数 **97.89/88.91/97.67**，186/186 源码文件进入严格清单，不低于 M18 实际基线。机器证据为 `.pm/m18-coverage-raw.json`。
- **能力状态为 `supported-fixture-only`**：用户明确选择不提供真实项目并按 ADR-014 §6 降级路径关闭 PY-11；真实项目读取/写入均为 0，不得宣称“已支持 Python”。`ENABLE_PYTHON_STRUCTURE` 保持默认关闭，MCP 工具数仍为 7。证据：[m23-python-real-project.md](evidence/m23-python-real-project.md)。
- **M22（具名判定）与 M23（夹具级收口）均已关闭，停止扩展契约已复位为「M23 为最后一个产品里程碑」**；本节不构成真实项目 cutover、生产发布或 Python 支持声明。

## ZCode 接管状态

- 用户级配置：`~/.zcode/cli/config.json` 的 `mcp.servers.ano` 通过无空格 wrapper `~/.zcode/ano-mcp.mjs` 启动 `dist/surface/mcp.js`；不固定 ANO_ROOT，其他项目可显式传 `root`，各自使用独立账本。
- 2026-11-22 复核：用户目录独立 stdio、当前会话 `mcp__ano__brief` 和多个非 ANO 项目的宿主连接均已验证；Settings GUI 截图及跨项目现场工具消费未验证。
- 工作区 `.zcode/config.json` 保持 `mcp.servers={}`，不重复声明 `ano`；唯一登记在用户级，避免同名来源错配（D-0019）。
- 配置指定的真实 stdio 命令已完成 initialize、恰 7 工具 tools/list、当前项目 `brief`；证据：[zcode-mcp.json](evidence/zcode-mcp.json)（记录工作区哈希、生效作用域与生效 server 指纹）。
- ANO 自身账本已登记 `ANO-M5-001`，并持久化一条接入 Decision；`brief` 能恢复该任务和 note。
- `note`、`recall`、`verify(scope=release)` 已接通 MCP/CLI；recall 默认查询合成历史，`source=connected` 查询显式接入的 PM 历史，不自动读取真实 ZCode 会话。
- 已在本机用真实 tarball 对 Node 22.18.0 和 24.14.0 各自完成安装后自举，14 项检查全通过；证据：[node-matrix.json](evidence/node-matrix.json)。
- 已运行的 ZCode 会话需要人工在 **Settings → MCP** 重启/重连 `ano`，才能加载新工具；脚本验证不代替该客户端动作。

## 已交付并已验收

- 追加式 segment 账本：单链哈希、批次校验和、CRLF 容错、幂等、租约、崩溃恢复、可重建视图、observed 段头 fail-closed、只读 `.pm` 迁移。
- 确定性源码指纹；TS/JS L0/L1/L2 图、三态边、barrel、调用边、T2、增量缓存、freshness 与降级保留。
- 任务裁决：impact 超集、T1/T2 覆盖子集、真实子进程证据、Gate 完成证据、图/源码漂移拒绝。
- Memory：合成 provider、参数化 recall、中文/标识符检索、Anchor、持久化 note 与 brief 恢复。
- 本地审计（drift/security/license/governance/deps）、版本化验收基线、Readiness 证据分级与 release 三态裁决。
- release 从真实 `artifact_path` 计算 SHA-256，制品/证据/人工 attestation 分开验证；attest、release approve、sync、push 不暴露给 agent。

## Connect 接入（M6）

已交付本地 PM-mcp 来源接入：来源业务状态与 Gate 验收分离，内容寻址原始资料、不可变快照、版本变更、故障恢复与退出导出；CLI、七工具 MCP 中的 connection 分支及独立本机授权向导共用同一引擎。

| Connect 验收 | 结果 |
|---|---|
| 引擎、CLI/MCP、向导专项 | **69/69 通过，0 跳过** |
| 全量回归 | 根 **402/402**、Spike **22/22**、文档检查通过，0 跳过 |
| 源码覆盖率 | 行 **95.61%** / 分支 **86.76%** / 函数 **94.68%** |
| 类型检查与构建 | 通过；MCP schema pin 显式更新，仅 recall/track，七工具与账本事件不变 |
| 当前源码质量矩阵 | `quality-20261120-045224-969-0000.json` 六项通过，source.stable=true |
| 真实 tarball 安装 | Connect 预检零写、接入、幂等恢复、状态、导出、接管阻止及 MCP 查询通过；证据 `docs/evidence/package-smoke.json` |
| 本机安全审计 | 无未处理安全发现；14 条既有已接受风险再次列出 |
| 浏览器 | 隔离项目真实 GUI 点击已通过：向导正确显示项目名和任务摘要；点击“开始使用”导航到“接入成功”，版本 1、任务 `verification=unverified` 且不回写 pm-mcp；返回向导显示历史版本 1，再次“刷新接入”显示幂等重复、版本仍为 1、变更 0/0/0。诊断捕获的请求为同源 `Origin`/`Referer`，`Host=127.0.0.1:<port>`，Fetch Metadata=`same-origin/navigate/document/?1`。 |
| 真实项目接入 | **未执行**；没有修改正式 `.pm/`、全局配置或项目 `AGENTS.md` |

M6 当时完整主写接管、其他来源适配、反向回写和批量向导未完成（M10 已另行交付强制接管，见下文）；显式前台 `connect watch` 已实现，但不创建后台守护进程、不写回 `.pm/`，不得把“已接入”解读为“已替换 PM-mcp”。

使用与退出边界见 [connect.md](connect.md)。

## ANO 主导迁移（M7，已完成）

| M7 验收 | 结果 |
|---|---|
| 迁移预检 | `ano migrate plan` 只读 `.pm/`，零写、不创建 `.ano/`；返回任务映射、来源摘要与冲突 |
| 迁移应用 | `ano migrate apply --expected-source-digest` 绑定计划摘要；来源漂移拒绝且零写；只写 `.ano/ledger` |
| 幂等与对账 | 二次 apply 零新增；`migrate status/reconcile` 报告 matched/missing/conflicts |
| 原生任务工作流 | MCP `track` 支持 task create/update/cancel/reopen；`complete` 必须携带已记录 Gate evidence_id，裸 `done` 被拒 |
| 边界 | `.pm/` 不被改写；来源 `done` → `in_progress + verified=false`；里程碑/功能仍是迁移记录；无来源回写、无 PM-mcp 停用 |
| 备份/回退 | `ano migrate backup/restore/list-backups` 内容哈希清单；恢复前逐文件校验，篡改备份拒绝；回退不删 ledger |
| cutover readiness | `handoff` 按证据计算：迁移对账、备份校验、具名人工确认；缺证据给 blocker |
| 专项测试 | `test/integration/migrate-takeover.test.ts` 6/6 通过；迁移专项 5/5、类型检查通过 |

## 项目级强制接管（M10）

M10 目标：在用户明确指定的项目内，一次授权完成备份、迁移、对账、策略安装、宿主默认启动、ANO DAG 接管与旧主写只读降级，并支持可验证退出与恢复；不绕过宿主授权、不自动读取秘密、不把历史记录升级为已验证事实。功能已登记为 **F-029 项目级强制接管与可恢复退出**（`implemented`）。

| M10 任务 | 状态 |
|---|---|
| T-065 协议 / T-066 策略与存储 / T-067 事务编排 / T-068 受管 AGENTS 段 / T-069 DAG 泛化 / T-070 Surface 接入 / T-071 旧源只读与漂移 / T-072 CLI 与 MCP / T-073 宿主能力降级证据 / T-074 隔离项目回退演练 / T-075 安全红队 / T-076 集成门禁 | 12/12 done |
| T-077 用户指南与恢复文档 | 交付中 |
| T-078 最终对账、审计与接管能力验收 | 待办 |

| 集成门禁（T-076） | 结果 |
|---|---|
| 全量质量矩阵 | `quality-20261122-122424-232-0000.json` 六项全 passed，`ok=true`、`source.stable=true`，源码 `6d223a02…` |
| 回归 | `npm test` 根 788/788 + scripts 22/22；`check-docs` 0；覆盖率 行 95.61% / 分支 85.41% / 函数 95.39% |
| 接管专项 | `takeover` 14/14、`policy` 10/10、`store` 12/12、`managed-instructions` 15/15、红队 11/11、恢复演练 1/1（聚合 8 场景）、相邻回归 56/56 |
| 缺陷修复 | F-01 受管段拒绝活跃 HTML；F-02 备份敏感过滤 + `skippedSensitive`；F-03 `policy.stateHash` 完整性；F-04 事务日志 `prevHash`/`entryHash` 哈希链 |
| 撤销/恢复语义 | T-074 三 gap 关闭：`revoke→recover` 经 `allowRevokedRemoval` 成功；同根再接管经 `ensureDisabledPolicy` 重绑开新事务；`disable` 声明先翻转 `recovery` |

已验证分层：库级、真实 CLI/MCP 与 `os.tmpdir()` 隔离项目全链路（含回退、漂移、撤销、敏感过滤）通过。**未验证/降级**：宿主无输出拦截、hooks 未用于 ANO、无自动启动/自动批准，`hostCapability` 固定 `degraded`；UI 人工确认与跨项目现场工具消费未现场验证；真实项目层未执行；掉电级持久性未验证。证据见 [takeover-host.md](evidence/takeover-host.md)、[takeover-recovery.json](evidence/takeover-recovery.json)、[host-capability-investigation.md](evidence/host-capability-investigation.md)。

用户指南与恢复步骤见 [usage.md](usage.md)，协议与状态机见 [takeover.md](takeover.md)。

## 多客户端自适应接入（M11）

M11 目标：统一能力探针 + 客户端适配器，按宿主真实能力分层报告并自动降级；写配置需显式授权、备份与可恢复。功能登记为 **F-030 多客户端自适应接入与能力分层降级（M11）**（`implemented`，module `clients`）。支持矩阵最终版见 [client-compatibility.md](client-compatibility.md) §11 与机器可读 [evidence/client-support-matrix.json](evidence/client-support-matrix.json)。

| M11 任务 | 状态 |
|---|---|
| T-079 契约 / T-080 探测与报告 / T-081 配置备份与恢复 / T-082 Claude Code+Codex / T-083 Cursor+OpenCode / T-084 Qoder+DSH+Pi / T-085 CLI / T-086 接管与 DAG 映射 / T-087 历史隐私 / T-088 红队 / T-089 集成门禁 | 11/11 done |
| T-090 支持矩阵、文档、审计与最终验收 | in_progress（本任务，待主控验收） |

| 集成门禁（T-089） | 结果 |
|---|---|
| 全量质量矩阵 | `quality-20261123-015125-901-0000.json`（SHA-256 `ab66d4a842bd38114a0fac03b97b93d0c729f022aa6b8b3ce4672ca743d84f20`），ok=true、六项全 passed、source.stable=true，源码 `9da20189…`（382 文件） |
| 回归 | root coverage 937/937（行 95.13% / 分支 83.71% / 函数 95.27%）；scripts 22/22；typecheck/build 通过；`npm run check-docs` current |
| 定向回归 | client 单测 111/111、takeover 9/9、history 13/13、red-team 12/12、cli 14/14、mcp 9/9 |
| 缺陷修复 | F-01 库级原型污染（`assertSafeServerPath` + `Object.hasOwn`/`Object.create(null)`）；O-01 `--config-path` 敏感路径硬化 |
| 真实客户端留证 | 见 [client-compatibility.md](client-compatibility.md) §10.2 与 `docs/evidence/client-*.md` |

| T-090 终对账（本任务） | 结果 |
|---|---|
| 全量质量矩阵（独占） | 见下文「T-090 质量门禁」 |
| 三审计 | structure：无硬性失败（警告见下）；security：新增 7 个中危（均在 M11 测试文件，0 高危）；license：MIT、0 冲突、无 GPL 头 |
| 结构快照 | `.pm/snapshots/snap-20261123-020306.json`（384 文件 / 112230 行 / 122 测试文件） |
| 文档 | README / usage / client-compatibility §11 / delivery-status / limitations 已追加 M11 章节；既有五份证据报告字节未改 |

审计处置（T-090）：

- **structure**：无硬性失败。警告项——M11 重构类任务占比 0%（低于 20% 配额）；`src/surface/service.ts`、`src/surface/cli.ts` 等 churn 热点；`src/clients/doctor.ts`、`src/clients/config.ts`、`src/surface/service.ts` 超复杂度预算；`docs/evidence/s5-atomic-append.json` 超扫描上限；F-014 无 entry_files 无法对账；用途索引覆盖率 0%。处置建议：由主控决定是否登记 refactor/annotate 任务；本任务不改 `src/**`。
- **security**：新发现 7 个中危（`test/integration/client-history.test.ts`、`test/redteam/client-adapters-boundary.test.ts` 的 `secret.generic-assignment` 与 `danger.eval`），均为测试内故意构造的敏感标记/注入载荷，用于验证拒绝与脱敏；0 高危。既有 21 条已接受风险再次列出，M8 SEC-038~044 维持 accepted。因 `test/**` 属本任务只读边界，处置（`resolve_finding` 留理由接受）移交主控。
- **license**：项目 MIT，LICENSE 存在；直接 6 + 传递 90 依赖无 copyleft 冲突；源码无 GPL 家族头。无需处置。

### T-090 质量门禁

- 独占全量矩阵：`.pm/quality-runs/quality-20261123-020552-482-0000.json`，SHA-256 `61e965888cb372a39fc43307aac2d86206212cf3c29c793d2bf4fd1131d05cb3`。
- 结果：`ok=true`、`source.stable=true`，typecheck/build/test/coverage 六项全 passed；源码指纹 `061ca1fc26df17f5403f09ddb0974db52ab325d2e06a01bac6860f824b200b65`（383 文件 / 68786613 字节，before==after）；root coverage 937/937（行 95.15% / 分支 83.66% / 函数 95.27%）；`npm run check-docs` 通过。
- 本行于矩阵运行后回填，仅改文档字节、不改文件数；主控按当前树重跑一次即可复核。

## M12 全 24 工具客户端目录交付状态（2026-11-23）

### 12 任务

| 任务 | 标题 | 状态 | verification 报告 | 源码指纹（sha256-tree-v1） |
|---|---|---|---|---|
| T-091 | 全客户端目录与 registry 收口 | done | `quality-20261123-025301-212-0000.json` | `12c086da6c20…` |
| T-092 | 能力探针与分层降级 | done | `quality-20261123-034225-015-0000.json` | `75e064ee7bc0…` |
| T-093 | 客户端配置与写路径 | done | `quality-20261123-034225-015-0000.json` | `75e064ee7bc0…` |
| T-094 | 备份与原子写 | done | `quality-20261123-034225-015-0000.json` | `75e064ee7bc0…` |
| T-095 | doctor 与 plan 渲染 | done | `quality-20261123-034225-015-0000.json` | `75e064ee7bc0…` |
| T-096 | 红队边界与秘密面 | done | `quality-20261123-034225-015-0000.json` | `75e064ee7bc0…` |
| T-097 | 文档与机器可读矩阵 | done | `quality-20261123-034225-015-0000.json` | `75e064ee7bc0…` |
| T-098 | registry 口径修正移交 | done | `quality-20261123-043128-246-0000.json` | `56cbeafe376b…` |
| T-099 | ZCode 真机复测 | done | `quality-20261123-045132-895-0000.json` | `4718806252dd…` |
| T-100 | T-100 探针与缺陷定位 | done | `quality-20261123-052726-799-0000.json` | `0dffed42dad5…` |
| T-101 | CX-11 集成验收与三缺陷修复 | done | `quality-20261123-055704-585-0000.json` | `70eab1406243…` |
| T-102 | CX-12 全工具支持矩阵、文档与最终验收 | in_progress（待主控验收） | `quality-20261123-060457-393-0000.json` | `70eab1406243…` |

- T-091～T-101 全部 `done`、`acceptance_verified=true`；引用报告均存在且 `ok=true`。gates：`phase-full-clients` `passed=true`（`verified_at` 2026-11-23T06:00:39.219Z）；`phase-full-clients-final` 待主控以 T-102 报告开启。

### T-101 集成门禁

- 报告 `quality-20261123-055704-585-0000.json`（`ok=true`，源码 `70eab140…`，416 文件，coverage 1065/1065 行 95.21% / 分支 82.77% / 函数 95.04%）。
- 修复 D1（user-scope 路径逃逸）、D2（库级敏感路径）、D3（doctor 回显秘密），均加红队回归。

### F-031 登记

- `F-031`（M12 全 24 工具客户端目录与分层接入，module `clients`，status `implemented`）已在 `.pm/features.json` 登记，`entry_files` 8 个、`test_files` 5 个，无缺失。

### T-102 质量门禁

- 报告 `.pm/quality-runs/quality-20261123-060457-393-0000.json`；SHA-256 `261eafbb524b7435c65bf256f16956748378be5561adc60e4843fe43cf846d6d`。
- 结果：`ok=true`、`reported_ok=true`、`execute=true`、`source.stable=true`；root test 22/22、build、typecheck、coverage 1065/1065（行 95.21% / 分支 82.83% / 函数 95.04%）、scripts test 22/22、scripts typecheck 全 passed；`npm run check-docs` 通过。
- 源码指纹 `70eab1406243f6ee879122ac0edff4d6308058e9d52e2c1cd636b17f18da26f9`（416 文件 / 69,698,687 字节，before==after）。
- 本节于该矩阵运行后追加，仅改文档字节、不改源码/测试；主控按当前树重跑一次即可复核。

### 三审计处置（T-102）

- **structure**：无硬性失败；重构占比 8%<20% 配额；churn 热点 `src/surface/service.ts` 21 次 / `cli.ts` 17 / `mcp.ts` 12；复杂度预算告警；`s5-atomic-append.json` >2MB；F-014 无 `entry_files`；用途索引覆盖 0%。记录为结构观察，不阻塞 M12。
- **security**：0 高危；新发现 5 个中危，全部位于 `test/redteam/full-client-catalog-boundary.test.ts`（3×`secret.generic-assignment`、2×`danger.eval`），逐行核实为合成哨兵/静态守卫字符串（`forbidden` 数组、`SESSION_*_MARKER`、`SECRET_VALUE_MARKER`/`Bearer`），非真实漏洞；28 条已接受风险。因 `test/**` 属只读边界，`resolve_finding accepted` 留痕建议由主控执行。
- **license**：MIT；0 copyleft 冲突；无 GPL 头；直接 6 + 传递 90 依赖。无需处置。

### 结构快照

- `snapshot_codebase`：`.pm/snapshots/snap-20261123-060309.json`，417 文件 / 133,251 行 / 128 测试文件；索引覆盖 0%。

## M15 分布式异步探针检索交付状态（2026-11-24）

M15 目标：单主写入 + ≥2 独立本地只读副本，把已提交事件复制到真实子进程副本，提供 LOCAL/AS_OF/COMMITTED/QUORUM 四模式与异步 scatter/gather/deadline/取消/去重/冲突/partial 契约，并在副本不可用时降级本地 `ProbeStore`、执行前用本地/主写 `current_snapshot` 复核。功能登记（`register_feature`）由主控在终验收时处理，本节不代为宣称。契约见 [ADR-011](adr/ADR-011-distributed-probe.md)，实现者参考见 [distributed-probe.md](distributed-probe.md)。

### 10 任务（DC-01~DC-10）

| 任务 | 标题 | 状态 | 证据文件 | 质量报告 |
|---|---|---|---|---|
| T-123 / DC-01 | 固定单主写入、副本复制与一致性协议 | done | `docs/adr/ADR-011-distributed-probe.md`、`docs/distributed-probe.md` | `.pm/quality-runs/quality-20261124-070212-069-0000.json` |
| T-124 / DC-02 | 扩展集群快照、提交点与证据元数据 | done | `src/memory/probe-contract.ts`、`probe-manifest.ts`、`probe-store.ts` + 2 单测 | `.pm/quality-runs/quality-20261124-072108-773-0000.json` |
| T-125 / DC-03 | 已提交事件复制与只读副本重建 | done | `src/memory/replica.ts`、`replication.ts` + 2 单测/集成 | `.pm/quality-runs/quality-20261124-082038-150-0000.json` |
| T-126 / DC-04 | 异步并行探针协调器与本地降级 | done | `src/memory/distributed-probe.ts` + 单测 | `.pm/quality-runs/quality-20261124-085711-935-0000.json` |
| T-127 / DC-05 | 真实本地多进程副本传输与生命周期 | done | `src/memory/replica-worker.ts`、`replica-transport.ts`、`test/integration/replica-process.test.ts` | `.pm/quality-runs/quality-20261124-100253-875-0000.json` |
| T-128 / DC-06 | 一致性判定与主写/本地复核门 | done | `src/memory/cluster-consistency.ts`、`context-verify.ts`、`consumer.ts` + 3 单测 | 同上合并报告 |
| T-129 / DC-07 | 集群授权、隐私过滤与副本撤销策略 | done | `src/memory/cluster-policy.ts`、`test/unit/cluster-policy.test.ts`、`test/redteam/distributed-probe-boundary.test.ts` | 同上合并报告 |
| T-130 / DC-08 | 集群故障、分区、乱序与缓存投毒红队 | done | `test/integration/replica-chaos.test.ts`、`test/redteam/distributed-probe-boundary.test.ts` | `.pm/quality-runs/quality-20261124-103210-544-0000.json` |
| T-131 / DC-09 | 同语义性能、召回与尾延迟对照 | done | `scripts/benchmark-distributed-probe.ts`、`test/benchmark/distributed-probe.bench.ts`、`docs/evidence/distributed-probe-benchmark.md` | `.pm/quality-runs/quality-20261124-110653-688-0000.json` |
| T-132 / DC-10 | M15 最终质量、使用文档与能力边界验收 | 本任务（仅改 4 个文档，待主控验收） | `README.md`、`docs/distributed-probe.md`、`docs/limitations.md`、`docs/delivery-status.md` | 待终矩阵 |

- 上述 9 个实现任务均已 `done` 且经主控验收；报告 `ok=true`、`source.stable=true`，覆盖各自交付物。

### 测试与红队证据

- 真实多进程集成 `test/integration/replica-process.test.ts`：**9/9**（≥2 真实子进程、SIGKILL、重启续传、幂等、缺段、消息边界）。
- 混沌/故障集成 `test/integration/replica-chaos.test.ts`：**11/11**（慢节点、进程崩溃、重复 apply、乱序、永久缺段、副本不可达、QUORUM 不足、混合版本、投毒文件、缓存、伪造副本）。
- 边界红队 `test/redteam/distributed-probe-boundary.test.ts`：**14/14**（`RB-01`~`RB-14`，含跨 scope、未注册/已撤销副本、秘密不外发、远程声明不提升权限、payload 不执行、默认禁网、审计无秘密、伪造 quorum、混合版本不 COMPLETE、永久缺段、SIGKILL 无残留）。
- 单元：`test/unit/distributed-probe.test.ts`、`memory-replica.test.ts`、`cluster-consistency.test.ts`、`cluster-policy.test.ts`、`memory-probe-contract.test.ts`、`probe-manifest.test.ts` 全部通过（详见各任务质量报告）。

### 基准证据

- 路径：[docs/evidence/distributed-probe-benchmark.md](evidence/distributed-probe-benchmark.md)；命令 `node scripts/benchmark-distributed-probe.ts --scale M --seed 20261122`。
- 同语义等价成立：fixture 可复现、三后端候选集合一致、COMMITTED/QUORUM 候选与本地投影逐一相等（计数 790）、降级臂非 COMPLETE 且 `failed_nodes` 非空。
- 单机实测：distributed-committed P50 52.36ms（约 2.53x 本地投影 20.705ms）、distributed-quorum 50.764ms；复制 1000 事件到 2 副本并追平 659.707ms、磁盘 1,132,244B。仅陈述本次运行事实，不外推跨机或线性收益。

### 质量门禁

- 阶段门禁 `phase-distributed-probe`：**待主控在 T-132 文档定稿后运行终矩阵并开启**；本节不预先写入终矩阵文件名或哈希。
- 既有合并质量报告与源码指纹见上表；最新一次为 T-131 的 `quality-20261124-110653-688-0000.json`（源码 `3378328d…` / 463 文件，`ok=true`、`stable=true`），仅覆盖 T-131 时点源码，不等于终矩阵。

### 明确未实现边界（不得宣称）

- 跨机传输与真网络分区、脑裂、跨机时钟回拨：未实现/未验证。
- 生产高可用、故障切换、RTO：未验证；无 daemon、无自动接管。
- 多主写、混合 commit、远程证据直接进 Gate：不支持。
- 性能仅单机 stdio smoke/M 档实测；真实生产负载与查询分布为 **[数据缺失]**。
- HLC 物理时钟篡改、掉电级持久性：未覆盖（沿用 M10/M13 结论）。

## M16 多主安全协议交付状态（2026-11-25）

M16 目标：把多主提交所需的 quorum、事件身份、`(term, leader_id, epoch)` fencing、分叉全分支保留与裁决完整性、逻辑时间、时钟诊断与故障注入语义冻结为可执行契约，并在本地 loopback TCP 上完成真实传输、脑裂与恢复验证；不改账本事件字节，不回退 M15 单主接口。契约见 [ADR-012](adr/ADR-012-multi-writer-ha.md)，实现者参考与运维见 [multi-writer-ha.md](multi-writer-ha.md)。功能登记（`register_feature`）由主控在终验收时处理，本节不代为宣称。

### 10 任务（HA-01~HA-10）

| 任务 | 标题 | 状态 | 证据文件 | 质量报告 |
|---|---|---|---|---|
| T-133 / HA-01 | 固定多主提交、epoch/fencing 与脑裂安全协议 | done | `src/memory/ha-protocol.ts`、`test/unit/ha-protocol.test.ts`、`docs/adr/ADR-012-multi-writer-ha.md`、`docs/multi-writer-ha.md` | `.pm/quality-runs/quality-20261124-121117-021-0000.json` |
| T-134 / HA-02 | 实现认证真实 TCP 副本传输与安全监听 | done | `src/memory/tcp-transport.ts`、`test/integration/tcp-transport.test.ts`、`test/redteam/tcp-transport-boundary.test.ts` | `.pm/quality-runs/quality-20261124-124906-376-0000.json` |
| T-135 / HA-03 | 实现多主事件信封、分叉合并与确定性裁决 | done | `src/memory/multi-writer.ts`、`test/unit/multi-writer.test.ts`、`test/integration/multi-writer-fork.test.ts` | `.pm/quality-runs/quality-20261124-124906-376-0000.json`（合并报告） |
| T-136 / HA-04 | 实现多数派 leader 租约、故障切换与旧主隔离 | done | `src/memory/leader-lease.ts`、`test/unit/leader-lease.test.ts`、`test/integration/leader-lease.test.ts` | `.pm/quality-runs/quality-20261125-011303-399-0000.json` |
| T-137 / HA-05 | 实现逻辑时钟、时钟偏差与回拨防护 | done | `src/memory/logical-clock.ts`、`test/unit/logical-clock.test.ts`、`test/integration/logical-clock-replay.test.ts` | `.pm/quality-runs/quality-20261125-013652-293-0000.json` |
| T-138 / HA-06 | 实现真实 TCP 故障代理与网络异常注入 | done | `src/memory/tcp-fault-proxy.ts`、`test/integration/tcp-fault-proxy.test.ts` | `.pm/quality-runs/quality-20261125-011303-399-0000.json`（合并报告） |
| T-139 / HA-07 | 验证脑裂、多数派隔离与旧主写拒绝 | done | `src/memory/ha-cluster.ts`、`test/integration/ha-split-brain.test.ts`、`test/redteam/ha-split-brain-boundary.test.ts` | `.pm/quality-runs/quality-20261125-032915-648-0000.json` |
| T-140 / HA-08 | 验证时钟回拨、偏差与逻辑排序恢复 | done | `test/harness/ha-clock.ts`、`test/integration/ha-clock-injection.test.ts`、`test/redteam/ha-clock-boundary.test.ts` | `.pm/quality-runs/quality-20261125-032915-648-0000.json`（合并报告） |
| T-141 / HA-09 | 本地高可用、RTO/RPO 与恢复压力验收 | done | `scripts/benchmark-ha-recovery.ts`、`test/benchmark/ha-recovery.bench.ts`、`docs/evidence/ha-recovery-benchmark.md` | `.pm/quality-runs/quality-20261125-035939-632-0000.json` |
| T-142 / HA-10 | M16 最终质量、文档与真实边界交付 | 本任务（仅改 4 个文档，待主控验收） | `README.md`、`docs/multi-writer-ha.md`、`docs/limitations.md`、`docs/delivery-status.md` | 待终矩阵 |

- 上述 9 个实现任务均已 `done`；引用报告均存在于 `.pm/quality-runs/`，`ok=true`、`source.stable=true`，覆盖各自时点源码。实现文件名与早期规划（`ha-transport.ts`/`ha-election.ts` 等）不一致，实际以表内文件为准。
- T-142 只做文档收口，不改 `src/`、`test/`、`scripts/`、`.pm/`；终矩阵由主控在本任务完成后运行。

### 测试与红队计数

下表为本次子代理在文档收口时对 14 个证据 `.test.ts` 文件的实跑结果（命令 `node --test <file>`，Node v24；全部 exit 0）：

| 类别 | 文件 | 通过/总数 |
|---|---|---|
| 单元 | `test/unit/ha-protocol.test.ts` | 35/35 |
| 单元 | `test/unit/multi-writer.test.ts` | 10/10 |
| 单元 | `test/unit/leader-lease.test.ts` | 13/13 |
| 单元 | `test/unit/logical-clock.test.ts` | 17/17 |
| 集成 | `test/integration/tcp-transport.test.ts` | 10/10 |
| 集成 | `test/integration/tcp-fault-proxy.test.ts` | 13/13 |
| 集成 | `test/integration/ha-split-brain.test.ts` | 7/7 |
| 集成 | `test/integration/multi-writer-fork.test.ts` | 1/1 |
| 集成 | `test/integration/leader-lease.test.ts` | 5/5 |
| 集成 | `test/integration/ha-clock-injection.test.ts` | 2/2 |
| 集成 | `test/integration/logical-clock-replay.test.ts` | 1/1 |
| 红队 | `test/redteam/tcp-transport-boundary.test.ts` | 31/31 |
| 红队 | `test/redteam/ha-split-brain-boundary.test.ts` | 8/8 |
| 红队 | `test/redteam/ha-clock-boundary.test.ts` | 4/4 |

- 合计 **155/155**（单元 75 / 集成 37 / 红队 43）；另有时钟夹具 `test/harness/ha-clock.ts`（非测试文件）。基准门禁 `test/benchmark/ha-recovery.bench.ts` 为 2/2，引自 T-141 记录，本任务未重跑。
- 红队覆盖：伪造 ack/绕过 quorum/过期 lease/旧主覆盖/未提交 `evidence_id`/把代理故障说成 OS 分区/边界词汇冻结/模块源码不含 `utimes`/`setSystemTime` 等；细节见各红队文件。

### RTO/RPO 实测（本地 loopback，固定种子）

证据：[docs/evidence/ha-recovery-benchmark.md](evidence/ha-recovery-benchmark.md)；命令 `node scripts/benchmark-ha-recovery.ts --scale smoke --seed 202611125`（环境 node v24.14.0 / win32 x64）。

| 场景 | 实测 |
|---|---|
| a. leader failover | RTO=2050.058 ms；切换窗尝试 2 / 拒绝 1（错误率 0.5，拒绝码 `QUORUM_NOT_REACHED`）；新主 n2（term 1→2）；旧主追平 9.985 ms 且不覆盖新主；RPO（未确认丢失）=1 |
| b. follower crash | 可用性中断=false；故障窗提交 12 / 拒绝 0；恢复+追平 13.247 ms；吞吐 582.746/s→0.98/s |
| c. rejoin catch-up | 落后 commitIndex=10；追平 4.559 ms；ingested/duplicates/conflicts=10/4/0；RPO=0；投影指纹一致 |
| d. 反复恢复 | 3 周期；最终提交 9；完整性与无故障基线一致；close 后 open 资源计数全 0 |
| e. 负载 P95/P99 | 正常 p95/p99=2.306/2.998 ms、700.196/s；故障窗 p95/p99=1023.727/1023.727 ms、0.986/s |

- `--scale S` 复跑 exit 0（95.9s）：RTO=2064.674 ms、RPO=0、4 周期完整（引自 T-141 记录）。
- 口径：RTO=故障生效到故障后首次成功提交返回的墙钟差（含基准驱动的重新选举）；RPO=故障窗内被拒且到基准结束仍未被任何节点日志提交的提案数。RTO/RPO 只描述本次本机运行，**不是生产 SLA**。

### 质量门禁

- 阶段门禁：M16 的 phase gate 拟用名 `phase-multi-writer-ha`，**当前尚未在 `.pm/orchestration-state.json` 的 `gates` 中登记**；由主控在本任务文档定稿后运行终矩阵并开启。本节不预先写入终矩阵文件名或哈希。
- 最新一次实现任务报告为 T-141 的 `quality-20261125-035939-632-0000.json`（源码 `18312126…` / 491 文件，`ok=true`、`stable=true`），只覆盖 T-141 时点源码，不等于终矩阵。

### 明确未实现边界（不得宣称）

- 物理三机部署、OS 真分区、跨机时钟回拨、生产 HA/SLA：未验证；本地 loopback TCP + 代理协议层注入 ≠ OS 真分区。
- 自动 failover / daemon / 自动接管：未实现；恢复动作需调用方显式执行。
- 跨机传输与真网络成员管理：未实现。
- mTLS（客户端证书双向认证）、受信 CA/证书轮换：未集成测试。
- RTO/RPO 仅为单机 smoke/S 档实测；真实生产延迟与写入分布为 **[数据缺失]**。

## M17 协议覆盖率恢复交付状态（2026-11-25）

M17 目标：把全仓 `src/` 覆盖率恢复到行≥95.37 / 分支≥83.54 / 函数≥95.20，transport/tcp/leader/ha/probe 行≥90 分支≥80、replica-worker 行≥90 分支≥70；先修真实缺陷再计覆盖率，且不得用排除源码或 ignore 注释抬高指标。逐文件基线与剩余清单见 [m17-coverage-final.md](evidence/m17-coverage-final.md)，稳定性与泄漏证据见 [m17-stability-runs.md](evidence/m17-stability-runs.md)。

### 7 任务（CV-01~CV-07）

| 任务 | 标题 | 状态 | 验收报告（SHA-256） | 主要文件 |
|---|---|---|---|---|
| T-143 / CV-01 | 建立逐文件未覆盖分支基线与补测契约 | done | `.pm/quality-runs/quality-20261125-051743-607-0000.json`（`89c4416b…`） | `docs/evidence/m17-coverage-baseline.md`、`.json` |
| T-144 / CV-02 | 补齐 replica-transport 与 replica-worker 异常分支 | done | `.pm/quality-runs/quality-20261125-062222-578-0000.json`（`4559bf98…`，合并报告） | `test/integration/replica-transport-faults.test.ts`、`test/unit/replica-worker-protocol.test.ts`、`test/unit/replica-remote-store.test.ts`、`test/integration/replica-process.test.ts`、`src/memory/replica-transport.ts` |
| T-145 / CV-03 | 补齐 TCP/TLS/帧与连接生命周期异常分支 | done | 同上（合并报告 `4559bf98…`） | `test/unit/tcp-frame-codec.test.ts`、`test/integration/tcp-connection-lifecycle.test.ts`、`test/integration/tcp-transport.test.ts`、`test/redteam/tcp-transport-boundary.test.ts` |
| T-146 / CV-04 | 补齐 leader、HA 与异步探针状态机异常分支 | done | 同上（合并报告 `4559bf98…`） | `test/unit/leader-lease.test.ts`、`test/unit/leader-lease-faults.test.ts`、`test/integration/leader-lease.test.ts`、`test/unit/ha-cluster-sync.test.ts`、`test/integration/ha-split-brain.test.ts`、`test/redteam/ha-split-brain-boundary.test.ts`、`test/unit/distributed-probe.test.ts`、`test/redteam/distributed-probe-boundary.test.ts` |
| T-147 / CV-05 | 在行为测试保护下拆分协议大模块 | done | `.pm/quality-runs/quality-20261125-065047-640-0000.json`（`1ff772b1…`） | `src/memory/tcp-frame-codec.ts`、`tcp-connection.ts`、`leader-state.ts`、`probe-merge.ts`（+原三模块 re-export） |
| T-148 / CV-06 | 覆盖红队、重复运行与资源泄漏稳定性验收 | done | `.pm/quality-runs/quality-20261125-081803-573-0000.json`（`3cbdda67…`） | `test/redteam/m17-stability.test.ts`、`docs/evidence/m17-stability-runs.md`、`src/memory/replica-transport.ts`、`src/memory/leader-lease.ts` |
| T-149 / CV-07 | 全仓覆盖恢复、最终质量与交付验收 | 本任务（仅改文档，待主控终矩阵） | 待终矩阵（本节不预填文件名/哈希） | `README.md`、`docs/delivery-status.md`、`docs/evidence/m17-coverage-final.md` |

- CV-02/03/04 共用同一份合并质量报告；六个实现任务报告均 `ok=true`、`source.stable=true`，只覆盖各自时点源码，不等于终矩阵。

### 指标对照表

| 对象 | 行%（目标→实测） | 分支%（目标→实测） | 结论 |
|---|---|---|---|
| 全仓 src | 95.37 → **95.64** | 83.54 → **84.57** | 达标（函数 95.20 → 95.36） |
| replica-transport | 90 → 98.95 | 80 → 91.10 | 达标 |
| replica-worker（放宽档） | 90 → 99.38 | 70 → 88.83 | 达标 |
| tcp-transport | 90 → 96.96 | 80 → 90.39 | 达标 |
| leader-lease | 90 → 99.36~100 | 80 → 93.87~94.60 | 达标 |
| ha-cluster | 90 → 97.97 | 80 → 86.85 | 达标 |
| distributed-probe | 90 → 95.21 | 80 → 92.16 | 达标 |
| tcp-frame-codec（新） | 90 → 100 | 80 → 97.37 | 达标 |
| tcp-connection（新） | 90 → 100 | 80 → 93.33 | 达标 |
| leader-state（新） | 90 → 98.68 | 80 → 89.29 | 达标 |
| probe-merge（新） | 90 → 100 | 80 → 83.97 | 达标 |

- 口径：`npm run coverage`（`--test-coverage-include=src/**/*.ts`），无 `--test-coverage-exclude`、无 src ignore 注释；`npm test` 1649 tests / 1648 pass / 0 fail / 1 既有环境条件 skip（未新增 skip/todo/only）。

### 缺陷修复表

| ID | 位置 | 症状 / 根因 | 修法 | 归属 |
|---|---|---|---|---|
| F-6 | `replica-transport.ts:722-730` | 畸形行分支冗余 O(n) 反查 id | 单次遍历，语义不变 | T-144 |
| DEF-1 | `replica-transport.ts` `restart()` | 并发 restart 启动两个子进程 | per-handle `#restarting` promise 复用 in-flight | T-148 |
| DEF-2 | `leader-lease.ts` `#declarations`/`#votedByTerm` | 伪造 `(epoch,term)` 洪泛致声明表无界增长 | 上限 256 + 淘汰 + 清理非当前 term，fencing 语义复核不变 | T-148 |
| TEST-INFRA | `test/redteam/m17-stability.test.ts` tmpdir hook | hook FIFO 顺序导致 EBUSY 静默泄漏 | close 先注册、rm 后注册；`removeTree` 重试耗尽抛错 | T-148 |
| F-1 | `replica-transport.ts:670` | 基线称错误模板多余字面量 `}` | 逐行 eval 复核为误报，按证据不修，记录在案 | T-144 |
| D-0014 | doctor `probePaths` | 隔离泄漏 | M16 期间已修（归属 M16，非 M17） | M16 |

### 质量门禁

- 阶段 gate 拟用名 **`phase-coverage-recovery`**，当前尚未在 `.pm/orchestration-state.json` 的 `gates` 中登记；由主控在 T-149 文档定稿后运行终矩阵并开启。本节不预先写入终矩阵文件名或哈希。
- 稳定性前置结论：关键 10 文件 ×3 共 30 次全绿、新稳定性套件 12/12 ×8 自然退出、PID/连接/定时器/tmpdir 泄漏闸全零（见稳定性证据）。

### 剩余未覆盖与维护建议

- 已登记剩余未覆盖 **11 处**：不可达防御分支 2 处（`replica-transport.ts:839`、`replica-worker.ts:541-542`）+ TCP 侧不可达防御/需违反回环测试缝的竞态窗口 9 处（T-145 已确认类别，逐条行号未随报告落盘，标 `[数据缺失]`）。另有非覆盖率残留 2 项（`#entries` 不随 stop 删除、`request(timeoutMs:0)` API 一致性）。
- 维护建议：新增分支必须带确定性测试（注入时钟/fake rpc/纯函数直调优先）；不可达防御分支走登记制度（`accepted-defensive` + 行号 + 理由），不堆砌不可能输入的测试；真实 socket/子进程竞态只在 127.0.0.1/::1、端口 0、等待有界（≤200ms，Windows 进程回收 ≤500ms）下验证，超范围须显式登记；不得以 exclude/include 口径调整或 ignore 注释抬高指标。

## M18 最终质量收口与停止扩展交付状态（2026-11-25）

M18 目标：把 ANO 收口为可停止功能开发的稳定版本。四纯模块与枚举安全分支达到 100%，全仓 ≥97/88/97，变异能检出代表性缺陷，同源码连续三轮全绿；验收后进入维护模式，只允许缺陷修复、环境适配和文档更新。

### 七任务交付状态

| 任务 | 标题 | 交付物 |
|---|---|---|
| T-150 / QF-01 | 冻结最终缺口与停止扩展契约 | `docs/evidence/final-quality-scope.md`、`m18-quality-baseline.json`、原始覆盖产物 |
| T-151 / QF-02 | 四纯模块行/分支/函数 100% | 四个 `test/unit/*-complete.test.ts`；tcp-frame-codec 306/306·40/40·13/13、probe-merge 603/603·158/158·41/41、leader-state 153/153·59/59·12/12、logical-clock 369/369·74/74·22/22 |
| T-152 / QF-03 | 安全关键分支 100%（三分口径） | `test/redteam/final-security-branches.test.ts`、`test/integration/final-consistency-branches.test.ts`；八域 457 分母 / 451 已执行 / 6 已登记不可达 / 0 剩余可达未补 |
| T-153 / QF-04 | 剩余缺口清理与全仓指标 | `scripts/m18-native-coverage.mjs`、`scripts/m18-coverage-reporter.mjs`；166/166 清单，行 97.86% / 分支 88.60% / 函数 97.67% |
| T-154 / QF-05 | 变异与有界 fuzz | `scripts/mutation-check.ts`、`test/mutation/critical-semantics.mutation.test.ts`、`test/integration/m18-network-fuzz.test.ts`、`docs/evidence/mutation-report.md`；6/6 killed、detectionRate 1.0、源码树未变 |
| T-155 / QF-06 | 连续三轮稳定性 | `docs/evidence/final-stability.md`；同源码 5eb391c9… 三轮全绿，2067/2067/0/0 |
| T-156 / QF-07 | 最终对账与维护模式 | 本节与 `docs/evidence/final-quality-acceptance.json`、README/CHANGELOG/limitations 维护边界 |

### 终局指标

| 对象 | 实测 | 目标 |
|---|---|---|
| 全仓行（strict 166/166） | 97.87% | ≥97 |
| 全仓分支 | 88.55% | ≥88 |
| 全仓函数 | 97.67% | ≥97 |
| 四纯模块 | 100/100/100（原始 covered==total） | 100 |
| 安全域 | 可达方向全部执行；6 项不可达有源码约束证据 | 100%（可达） |
| 变异检出 | 6/6 killed，0 survived | 代表性全检出 |
| 稳定性 | 三轮同源码全绿、零 skip | 三轮一致 |

### 边界与未宣称

- 四模块 100% 与全仓指标**不证明 100% 无 Bug**，不证明生产 HA、掉电持久性、跨机可用性或业务语义正确。
- 覆盖率由 Node 原生 `test:coverage` 计数导出；`include=src/**/*.ts`、无 exclude/ignore、无新增 skip/todo/only。166 个源文件全部加载，缺席会使严格模式失败。
- 安全清单把"已登记不可达"与"可达已执行"分开统计，不以行执行或全文件百分比冒充域 100%。
- 变异集与 fuzz 均为有界代表性样本；不含 TLS 内部帧注入、OS 真分区、带宽/IP 层乱序、多主机、并发多 peer 握手、已认证后 challenge 真实重放。
- 生产发布与真实项目 cutover 仍需具名人工确认；本地验收不构成该授权。

## M18 维护任务交付状态（2026-11-26）

M18 收口后的维护轮次只处理分布式探针资源正确性，不新建功能里程碑。四个维护任务均以当前源码测试/矩阵为证据，动态状态以 `.pm/` 为准。

| 任务 | 交付 | 关键证据 |
|---|---|---|
| T-157 / MNT-01 | `src/memory/probe-scheduler.ts`；`distributed-probe.ts` 增加在途上限、有界队列与 COMMITTED/QUORUM 提前冻结 | 定向 56/56；调度器 262/262 行、44/44 分支、21/21 函数；迟到结果 `LATE_DISCARDED` 不进入证据；低提交点/AS_OF 仍完整 gather |
| T-158 / MNT-02 | worker `cancel` 协议、IPC 取消帧、TCP 认证 cancel 帧、服务端 in-flight AbortController、迟到成功抑制 | 新增取消测试 4/4、worker 协议 14/14、pending table 4/4；TCP/副本回归 145/145；受控终止仅在无其他在途请求时发生 |
| T-159 / MNT-03 | `src/memory/resource-lifecycle.ts`、服务端水位、可选 `installProcessCleanup` | 单元 8/8、集成 4/4；正常/取消/崩溃/重复 close 后四项水位归零；`resources_released` 与集群关闭解耦 |
| T-160 / MNT-04 | `scripts/benchmark-probe-lifecycle.ts`、`docs/evidence/probe-lifecycle-benchmark.md`、本节与 distributed-probe/limitations/CHANGELOG 更新 | 同语义两臂 evidence 一致；慢尾 P50 203.78→15.76ms；上限臂 global/per-node peak=2/1；全量矩阵与 build/check-docs 见 `.pm/` 最新报告 |

边界：性能数字来自单进程内存 store（Windows 定时器粒度约 15.6ms），不是跨机 RTT、生产 SLA 或容量承诺；并发上限以吞吐换有界负载；Windows 上 `process.kill(pid,'SIGTERM')` 不触发 JS 处理器，因此信号驱动清理只在可测 seam 上验证，不能宣称 Windows 真信号清理已实现；取消与清理均限于本地 IPC/TCP，不跨机。

## M5 历史本机验收证据（2026-11-19）

| 项 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm test` | 根 333/333，Spike 22/22，文档检查通过 |
| `npm run coverage` | 行 96.14% / 分支 87.64% / 函数 94.77%（只统计本仓库 `src/`，退出 0） |
| `npm run verify:all` | **12/12**（typecheck/test/coverage/build/assets/schema/docs/ZCode/P1/打包/证据） |
| Node 22.18/24 自举 | 两target均 passed；各自 14 项 passed |
| 真实 tarball 安装 | CLI `done/T1`，MCP 恰 7 工具；证据 `package-smoke.json` |
| pm-mcp 质量矩阵 | `quality-20261119-111827-255-0000.json` 全绿，源码稳定 |

环境：Windows 10 x64。未运行远端三平台 CI。

## 不应解读为已完成

- P8 对外发布、远端三平台 CI 实际运行、真实客户端采样、生产 profile `validated`、商标法律清查。
- `track` 的里程碑/断点操作；attest、release approve、sync、push。
- 掉电持久性与全语言/全测试框架支持。
- ANO 自身 `ANO-M5-001` 的 Gate 曾返回 blocked：当前仓库尚无 Git 基线提交，所有文件均纳入变更，少数专项测试不足以证明全量 T1 覆盖。该独立裁决未被手工改成 done；功能验收以 M5 全量/自举/质量矩阵为准。

## 关键证据

- `docs/phase-0-report.md` … `docs/phase-8-report.md`。
- `docs/evidence/p1-experiment.json`、`package-smoke.json`、`zcode-mcp.json`、`node-matrix.json`。
- `docs/zcode-integration.md`、`docs/limitations.md`。
- `.pm/quality-runs/` 的成功和失败历史。

成功证据不覆盖失败历史；最新矩阵与 `verify-all` 结果为准。

## M19 钩子强制更新（T-168，2026-11-26）

- ZCode `enforcement=hooks-validated`（实测）：`os.tmpdir()` 隔离 Git 项目真实 ZCode 会话验证自动 brief、未 explore 的 TS 文件被 ask/deny、file-level outline 后 allow、无归属改动触发 Stop 补记且补记后正常结束；证据 `docs/evidence/m19-zcode-hooks-validation.md`/`.json`。Claude Code 仍 `hooks-documented`。
- 此更新仅涉及工具级钩子强制层；上述历史段落中「hooks 未用于 ANO」为 M10/M11 时点描述，宿主 `output-interception` 仍 `unavailable`、`hostCapability=degraded` 的结论不变。
