# 已知限制

## 当前交付阶段

当前为 P0–P7 本地 alpha（库级）：账本、指纹、结构图、Memory、审计、验收基线、Readiness 与部分 Surface 已交付并通过全量测试。P8 发布、真实客户端采样、生产 profile `validated`、远端三平台 CI 未执行。工具 schema 或 CLI 存在不代表对应业务已接通；以 `docs/phase-*-report.md` 的真实验收为准。

## 最终质量收口与维护模式（M18）

- M18 是最后一个质量里程碑；不以新增功能或后继里程碑代替维护债务。收口期间仅允许缺陷修复、测试补齐、必要的可测试性重构与文档核对。
- 真实验收通过后进入维护模式：仅允许缺陷修复、环境适配和文档更新，不自动开启新功能开发。维护变更仍须提供相应回归测试和当前源码匹配的证据。
- 验收目标不是已完成声明；以 `.pm/` 的当前源码质量报告、变异结果、三轮稳定运行记录和主控 Gate 为准。历史覆盖、静态范围清单和合成夹具都不能替代当前运行证据。
- 四纯模块行/分支/函数 100%、枚举安全关键分支 100% 与全仓 ≥97/88/97 不证明 100% 无 Bug，不证明生产 HA、掉电持久性或跨机可用性；既有未验证项不因收口而升级。
- 生产发布和真实项目 cutover 仍需具名人工确认；本地测试通过或维护模式不会自动批准、推送、发布或切换任何项目。

## Python 语言边界（M23 / ADR-014）

- **当前状态最多为 `supported-fixture-only`**：pytest 五类真实隔离场景、四个 Python 夹具金标准、T1 覆盖与结构红队已通过；用户具名指定的真实 Python 项目只读验收尚未执行，因此不得写成“已支持 Python”。`ENABLE_PYTHON_STRUCTURE` 默认关闭，关闭时 `.py`/`.pyi` 不进入结构图，钩子仍按 `UNSUPPORTED_LANGUAGE` 降级放行。
- **pytest 证据不等于任意 Python 测试框架**：只接受绝对路径解释器的 `<interpreter> [-X utf8] -m pytest ...`；拒绝 PATH 裸命令、自定义结果通道、自定义插件、collect/setup/fixtures-only 和根外 `--rootdir`。计数只来自 ANO 独占、读完即删的受限 JUnit XML，并与退出码交叉校验；skipped 与 Node 一样阻止完成。unittest/nose 等没有独立适配器。
- **静态 L0/L1，不是 Python 语义引擎**：只使用 tree-sitter WASM，不执行被分析源码、不调用解释器做解析、不读取 `site-packages`/虚拟环境；不做 L2 调用图、类型推断、跨语言 HTTP 边或运行时 `sys.path` 追踪。动态导入、反射、字符串注册、fixture 注入与未知导入保持盲区/unknown，不计入 value 覆盖。
- **源码根解析有意受限**：优先级为 `python.roots`、pyproject 的两个 setuptools 键、`src/`、项目根；其他布局需显式配置。多根歧义、相对导入越界、语法错误和预算耗尽均 fail-closed，不猜成 value-confirmed。
- **证据信任边界不消失**：`conftest.py` 和测试代码可篡改结果，与 Node 测试执行项目代码的边界相同；证据身份仍不是密码学签名。真实项目验收、生产发布和 cutover 仍需具名人工确认。

## 永久边界

- Verdict 只说明声明的条件是否有相符证据，不证明产品正确、测试写得对、运营安全或合规。
- 影响范围是启发式超集；T1/T2 是静态可达性，不等于运行时覆盖。
- unknown、heuristic、动态加载和未支持语言都是残余风险，必须在结果中报告。
- 基线批准、attestation、release approve 和 push 是具名人工动作，不是 agent 权限。
- 持久 Memory 与可重建会话历史不同；未验证 provider 不宣称支持。
- Gate 证据的“身份”由 `verification` 元数据形状表达，不是密码学签名；账本边界阻断的是无证据 done / 自报 verdict / 源码已变，不替代 Gate 沙箱。

## 范围限制

- 默认结构语言仅 TS/JS；Python L0/L1 仅有隔离与夹具证据且开关默认关闭，真实项目未验收；不提供 Rust 内核和 codegraph 全语言能力。
- L2 调用图只覆盖同文件定义、明确命名导入、namespace 静态成员、可确定的类/实例方法、`this`、`new`；动态 receiver 只给 heuristic，回调/框架分发属 L3。
- 客户端 adapter 以真实格式样本逐项验证；无授权样本时只完成机制，不完成真实排序评估。
- 禁止加载宿主项目 TypeScript；模块无法静态解析时降级为 unknown。
- Readiness profile 分 `defined` 和 `validated`；清单存在不代表真实项目通过。
- Memory 与 Readiness 已接入 MCP/CLI；`recall` 默认只读合成历史，`source=connected` 显式查询 Connect 导入的本地 PM 历史。二者都不会自动采集客户端会话。release verify 必须绑定真实制品哈希，不代表生产 profile validated。
- 原生 `track` 支持 task/create/update/cancel/reopen；`complete` 必须携带已记录的 Gate evidence_id，裸 `done` 被拒绝。attest、sync、push 未接通，调用返回明确错误且不写状态。
- 不读取/复制 obelisk 源码，保持 MIT 独立实现。
- T1 执行测试清单由调用方提供，当前没有独立 runner 清单证明；不得伪造或默认全量执行。
- 证据解析支持 Node TAP 风格计数与受限 pytest JUnit XML；其他测试框架需独立 adapter，Python 适配器不覆盖 unittest/nose 的直接入口。
- 非 Git 根、源码在执行期间变化、图 stale/degraded 均拒绝完成；这是安全取舍而非可绕过选项。
- 多进程并发有真实测试，但 Windows 目录 fsync 未通过，因此不承诺掉电持久性。
- 审计 `deps` 无 OSV/registry 查询；`security` 不扫 git 历史与二进制；联网只在注入 scanner 且 `confirm=true` 时执行。
- 审计事件可通过 sink 接账本；当前 Surface 仍写 `.ano/audit/findings.json`，默认不启用 ledger sink。
- release 的源码指纹与制品哈希分别计算；源码指纹有意排除 `dist/`、`.ano/` 等缓存/制品，不能用源码指纹代替 tarball SHA-256。
- 远端三平台 CI 未实际运行，商标清查未完成，真实会话排序未执行。

## Connect 接入边界

- 仅支持选定根目录的本地 PM-mcp 来源，不自动扫描磁盘，不支持其他工具或 CSV 导入。
- 本版为来源只读接入；默认 `connect`/`status` 不自动刷新。显式运行 `connect watch` 可在前台按周期持续刷新快照。M7 的 `migrate` 把任务/里程碑/功能/会话迁入 `.ano/ledger`，`handoff` 按迁移对账、备份与人工确认计算 readiness；但里程碑/功能仍是迁移记录、不是可编辑原生实体；无后台守护进程、无来源回写、无自动停用 PM-mcp。
- 来源任务 `done` 保留业务完成分类，ANO 验收始终未验证；导入状态不能用于任务完成或发布裁决。
- 原始资料、未知字段和二进制归档可导出；可重建索引缓存明确列为排除项，不宣称整个 `.pm/` 字节级备份。二进制不文本检索。
- 来源权限不足、畸形数据、重复 ID、symlink/junction、超限或读取期间变更都明确拒绝，不静默丢记录。
- 历史可能包含敏感信息，存储与导出不自动脱敏；MCP 查询会把选中内容返回宿主客户端，不承诺其后续处理永远在本机。
- 接入目录无需 Node/Git，但代码验证仍受原环境要求约束。移动目录后的身份续接、批量多项目向导、增量 API 适配和来源回写尚未实现。
- Connect 退出包不是原生 ANO 账本、验收证据或整个项目的备份。停止接入不等于自动恢复来源，不得删除已有 ANO 历史来模拟回滚。
- 不承诺 Windows 掉电级持久性或防御同用户恶意进程的路径替换。详情见 [connect.md](connect.md)。

## 强制接管边界（M10）

- **接管不等于绕过权限**：授权是项目内本地记录，不是 token。它不改变 MCP 工具权限、不代批 PermissionRequest、不改宿主批准策略、不改用户级配置；权限仍需具名人工在宿主处理，新会话权限不能由 ANO 代批。
- **接管不等于读取一切**：只在授权范围内读取任务/记忆/验收/DAG 所需数据，不采集凭据、令牌、私钥或未授权目录；备份对敏感文件采用保守过滤（见下）。
- **接管不等于自动发布**：baseline approve、attest、release approve、sync、push 仍是具名人工动作，不暴露给接管工作流，也不由接管自动触发。
- **宿主能力 degraded**：宿主无面向 MCP 结果/模型输出的输出拦截接口，hooks 是工具级闸门且未用于 ANO，无自动启动/自动批准能力。`hostCapability` 固定为 `degraded`；「强制」只覆盖 ANO 可执行面，不表示宿主已自动拦截或自动启动。
- **未现场验证的层**：UI 人工确认、跨项目现场工具消费、真实项目层（用户指定项目 + 宿主会话）均未验证；库级与 `os.tmpdir()` 隔离项目证据不能代替这些层。
- **掉电持久性未验证**：多进程并发有真实测试，但 Windows 目录 fsync 未通过，不承诺掉电级持久性。
- **`revoke → recover` 语义**：`revoke` 写 `revokedAt` 使授权永久失效；此后仍可 `recover`（`removeManagedInstructions` 的 `allowRevokedRemoval` 退出维护 opt-in，仅 `recover` 使用，`install`/`update` 不接受），完成 `recovery → disabled`。要再次接管必须重新 `grant` 并走完六阶段。`recovery` 中不能 `revoke`。
- **备份敏感过滤是保守列表**：`.env*`、secrets/credentials/passwords/tokens/private-keys 目录、`credentials.json`、secret/token/api_key/private_key 文件名、`.pem/.key/.p12/.pfx/.kdbx/.ppk`、`id_rsa`/`id_ed25519` 不采集，命中项记入 manifest 的 `skippedSensitive`。列表偏保守，可能误判同名普通文件；被跳过的文件不在备份内，恢复时以当前磁盘内容为准。
- **证据快照时效**：`docs/evidence/takeover-recovery.json` 是 T-074 首次运行的隔离项目快照，`known_gaps` 3 条为 T-076 修复前记录（T-076 已关闭）。默认回退演练只写临时目录，不重写提交快照；刷新快照必须显式设置 `ANO_TAKEOVER_EVIDENCE_WRITE=1`。
- **真实项目接管未执行**：没有在正式 `.pm/`、全局配置或真实 `AGENTS.md` 上执行接管；首次真实项目使用需用户明确指定项目与授权。

## 多客户端接入边界（M11）

- **除 ZCode 外无真实客户端安装**：本机 `claude`、`codex`、`cursor`、`opencode`、`qoder` 均不在 PATH，`~/.cursor`、`~/.config/opencode` 缺失。因此除 ZCode 外没有真实客户端 stdio 握手，`configured/mcp/tools/brief` 的真实兼容结论为 `unverified`/`unavailable`，不把目录存在性或合成 fixture 当作真实兼容。
- **真实会话样本缺失**：`history` 层无授权真实样本（`[数据缺失]`），公开会话格式 `unverified` 且未实现 parser；合成 fixture 只证明机制，不升级任何单元格。八客户端 `history` 全为 `unavailable`。
- **输出拦截全 unavailable**：全客户端（含 ZCode，T-055 已证明无公开接口）`output-interception=unavailable`；工具级 hooks 不是输出拦截，不声称通用自动输出拦截。
- **Cursor 格式为 assumed**：官方文档本机不可达，`mcpServers`/`.cursor/mcp.json`/`~/.cursor/mcp.json` 格式来自 ADR-007 与 registry 声明候选，未实测。
- **OpenCode 路径口径差异保留**：registry/adapter 候选为 `opencode.json` 与 `.opencode.json`，官方文档为 `.opencode/opencode.json` 目录形式；本版本只在已声明候选间择优，不新增未声明来源，差异保留为限制。
- **Codex TOML v1 只读**：即使授权齐备也拒绝写配置，只返回 dry-run；`codex` 安装不可用。
- **Qoder 未实测**：`detected/configured=degraded`（有目录无版本、无 `ano` 条目），`instructions/orchestration/history/output-interception` 无实测依据；真实安装（`qoder mcp add`）未执行。
- **DSH / Pi 身份未知**：`status='unknown'`，只探测不猜路径，全层 `unavailable`，永不 `validated`；升级需先补齐公开身份/配置格式/派发或历史接口证据。
- **不自动修改其他真实客户端配置**：`doctor` 默认只读；`clients install/restore` 默认 dry-run 零写，写路径必须显式 `--confirm` + 授权三元组 + 声明作用域 + 内容哈希备份。Qoder/DSH/Pi/ZCode 如实拒绝写。
- **不虚构 daemon / 输出拦截**：不创建后台守护进程，不声称宿主自动启动、自动批准、自动派发或自动拦截输出；权限与发布动作仍是具名人工。
- **未验证项沿用**：跨 root 授权续接、移动目录身份续接、掉电级持久性未验证（沿用 M10 结论）；`hostCapability` 固定 `degraded`。
- **第三方扩展边界**：`registerExternalAdapter` 严格校验声明，自报 `validated` 在无可信实测证据时降级；但声明内任意 JS 的副作用无法由包装层阻止，注册方需自行审计。

## 全 24 工具客户端边界（M12 / ADR-008）

- **除 ZCode 外无真实客户端安装**：24 客户端中仅 `zcode` 有真实 stdio 七工具握手（`measured`）；其余 23 个为 `assumed`（6 个：`claude-code`/`codex`/`openclaw`/`tongyi-lingma`/`qoder`/`codebuddy`，仅公开文档或本机存在性）或 `absent`（17 个）。真实配置未安装/未授权实测者一律写「未验证」，不写支持。
- **21 工具初始 unverified**：T-091 收口时 21 个 ADR-008 编码工具均为 `unverified`；本终态这 21 个工具**仍全部为 `unvalidated`**，24 行中唯一 `validated` 是 M11 既有的 `zcode`。**「全适配」≠ 全部 `validated`**：路线存在只表示有可执行接入路径或明确降级。
- **history 全层 unavailable**：无真实会话样本、公开会话格式未核实；24 客户端 `history` 全为 `unavailable`。
- **输出拦截全 unavailable**：24 客户端 `output-interception` 全为 `unavailable`（T-055）；工具级 hooks 不算。
- **Cursor 格式为 assumed**：官方文档本机不可达，配置格式来自 ADR-007/registry 声明候选，未实测。
- **OpenClaw 仅 E2 存在性**：未授权实测；仅证明本机存在声明候选路径，不证明可写或可握手。
- **OpenCode 路径口径差异保留**：registry/adapter 候选为 `opencode.json` 与 `.opencode.json`，官方文档为 `.opencode/opencode.json` 目录形式；本版本只在已声明候选间择优，不新增未声明来源。
- **真实宿主是否读取所写配置未实测**：D1/D2/D3 为库级修复并已加红队回归，但真实客户端宿主对写入配置的消费行为未验证。
- **未验证项沿用**：跨 root 授权续接、移动目录身份续接、掉电级持久性未验证（沿用 M10 结论）。
- **不自动扩大授权**：本版本不自动修改真实客户端配置、不读取真实会话或秘密；任何写操作必须用户显式 `--confirm` + `--granted-by`/`--statement`/`--scope`，默认只读 + dry-run。

## 真实项目扫描边界（M13 / ADR-009）

- **宿主无拦截沿用**：宿主无面向 MCP 结果/模型输出的输出拦截接口，hooks 是工具级闸门且未用于 ANO；`hostCapability` 固定 `degraded`，权限与发布仍是具名人工动作。
- **真实项目未接管**：M13 对真实电商项目 `<example-project>` 仅做只读扫描验收；未执行 `takeover grant/apply/revoke/disable/recover`，未执行迁移写路径，未写该项目 `.ano/` 或 `.pm/`。接管需具名人工显式授权与 `--confirm`。
- **真实项目内未执行 `brief`/`explore`/`rebuildGraph`**：`GraphStore.open` 会创建 `<root>/.ano/cache`、`Ledger.open` 写 `<root>/.ano/ledger`，在真实项目执行会写入项目内 `.ano/`，与只读边界冲突。验收改用同配置临时副本（相同 `scan_ignore`、相同排除谓词、真实源码文件）验证可用性；真实项目内可用性未现场执行。
- **旧哈希一次性重建**：图缓存 `scan_key` 绑定源根/排除集/阈值等；默认排除集扩展（新增 `.env*`/`secrets/**`/`*.pem|key|p12|pfx`/`id_rsa*`/`id_ed25519*`/`credentials.json`/`keys/**`/`logs/**`/`build|out|dist/**`/`*.bin`）会让旧 legacy 缓存失效并按新口径重建一次，带 `scan` 的构建文件集不变。
- **未声明目录不排除**：默认集只含 `.venv`/`venv`；真实项目的 `server/.venv-scrapling/**`（20 文件 / 305,333 字节，0 个受支持扩展名）因用户未在 `scan_ignore` 声明而被扫描。按 ADR-009 §5.2「未声明即不排除」处理，会轻微抬高文件计数。
- **真实规模耗时口径**：全树约 11.5 万文件（含排除项）；只读指纹实测的是**非排除源码子集**（2026-11-23T18:5x 为 1354 文件 / 81,383,632 字节，50s 预算下 1.15s，未超时）。含排除全树未单独计时；真实大模型文件（`server/data/llm-local/**`，7.83 GiB，最大单文件 4800.4 MiB）由 `scan_ignore` 与默认集排除，未参与哈希，流式哈希用合成 72 MiB 文件独立验证。
- **并发活跃树数值漂移**：真实项目在验收期间被其他会话并发写入，任务活跃数（56→54）、指纹文件数（1352→1354）与 `tree_hash` 均为时点值，不改变结论。
- **显式误配 `pmRoot` 的 fail-closed 强度不足（G3）**：实现只校验 `pmRoot/.pm` 目录存在，不校验任务数据；显式 `pmRoot=<源码根>`（其 `.pm` 无 `tasks.json`）暂不报 `PM_ROOT_WITHOUT_PM`，且会丢失仓库根 `scan_ignore`。默认路径（`pmRoot=gitRoot`）不受影响。
- **未验证层沿用**：跨 root 授权续接、移动目录身份续接、掉电级持久性、真实两进程账本竞争、真实模型层均未验证；库级与 `os.tmpdir()` 隔离证据不能代替真实项目层。

## 结构智能边界（M14 / ADR-010）

- **静态分析 ≠ 业务语义正确**：九类覆盖分类、六项指标与 riskScore 是覆盖口径与启发式输入；`parsed` 仍可能带 `semanticGaps`，风险低不代表业务正确，风险高也不自动等于发布阻塞（除非 Gate 策略显式声明）。
- **结构覆盖 ≠ 测试覆盖完整**：结构证据与执行证据类型分离，Gate 只记录结构覆盖证据（探查比例、盲区清单、风险分布、执行覆盖差集），不据此判定 done/approve/cutover，也不产生 `evidence_id`。
- **人工复核「已处理」通道未设计**：`reviewItems` 只是输入；high 文件存在 manual-review 项且开启 strict 即阻止完成，当前没有持久化的「已复核/已处理」状态载体。调用方传入的复核只计 `untrustedReviewItems`，不参与判定。
- **错误码目前仅会话级**：`STRUCTURE_ERROR_CODES`（QUERY_REVISION_MISMATCH/EVIDENCE_STALE/CLASSIFICATION_INVALID/BUDGET_EXCEEDED/UNSUPPORTED_INPUT）已用于分类校验、revision/stale 信号、预算后缀与会话信号，但账本与 Store 的权威消费尚未接线；不得把它们当作已落盘的强校验。
- **预算有界**：AST 遍历 `MAX_AST_WALK_DEPTH=1000`、嵌套作用域深度 16、节点预算有界；超限记显式 gap（如 `STRUCTURE_BUDGET_EXCEEDED`）而非静默截断或崩溃。恶意 AST 不再抛 RangeError。
- **zero-symbol 口径**：真实副本 50 个 zero-symbol 中含 49 个未被 `scan_ignore` 覆盖的 `client/vite.config.js.timestamp-*.mjs` 构建时间戳产物，另 1 个为 `client/src/main.jsx`；零符号仍是盲区，不因常见于生成物而忽略。
- **批量行数是超集**：一次快照产出 1199 行（非排除受支持文件全集），probe 的 418 基线文件全部命中并以 418 子集对照；不把 1199 描述为「精确 418 条」。
- **性能不可直接比较**：7分43秒是用户逐文件分析工作流（485 文件）口径，本实现是一次快照批量（1199 文件）；只报各自实测 P50/P95 与内存，不承诺提速倍数。
- **符号粒度不可对齐外部 probe**：本实现 SymbolNode 含局部变量/参数/对象成员与嵌套作用域符号（app.js 1302），probe 的 8125 只计顶层 value 符号，两次数值不可直接对齐。
- **传递闭包有界**：默认 `maxDepth=3`，超限标 `depth_limit`；不追求无限精度。
- **语言与执行边界**：M14 验收仅 TS/JS（`SUPPORTED_EXTENSIONS`）；M23 Python L0/L1 是独立、默认关闭的夹具级能力，不回溯升级 M14 证据；其他语言进 `unsupported`。无 GPU/云依赖；不执行被分析源码（静态扫描只读）。

## 分布式探针边界（M15 / ADR-011）

- **单机 stdio，非真网络**：副本是同一台机器上的 `child_process` 子进程，走行分隔 JSON stdio；`ReplicaTransport` 仅 `in-process`/`child-process`，不监听端口、不外发。不得把本机多进程实测外推为跨机带宽、丢包或延迟收益。
- **跨机/真分区/脑裂未实现未验证**：没有网络传输、服务发现与跨机成员管理；真网络分区、脑裂、跨机时钟回拨均未验证。也不提供跨机写入者检测，不能阻止同机同用户恶意进程直接打开账本目录写入（沿用 M10/M13 既有边界）。
- **生产 HA / RTO 未验证**：没有故障切换、自动选主或恢复时间目标承诺；协调器不会自动拉起副本，无 daemon、无自动接管。
- **心跳默认关闭**：`heartbeatMs` 默认 `0`（关闭），父进程活性由 stdin 关闭兜底；因此不能把「无心跳超时报错」当作活性检测缺失，需要显式设置 `heartbeatMs>0` 才有活性探测。
- **HLC 物理时钟篡改未覆盖**：一致性判定只报告滞后（`max_lag`）与摘要分歧，不补偿时钟；未验证物理时钟回拨/篡改场景。
- **性能样本有限**：M 档夹具查询集只有 2 条请求，尾延迟样本有限；真实生产延迟与真实查询分布为 **[数据缺失]**。RSS/heapUsed 差值未强制 GC，仅作数量级参考。
- **同语义 ≠ 提速**：本次单机 IPC 下分布式协调成本高于直接读本地投影/缓存，未观察到提速；不承诺十倍、线性或任何跨机加速。
- **远程 payload 不可信且不可执行**：副本返回字节只按严格 schema 解析、只作数据参与摘要比对，不执行、不直接引用；远程声明的 scope/auth/commit/digest 一律不采信，本地重算为准。
- **`COMPLETE_WITHIN_DECLARED_SCOPE` 不是集群 COMPLETE**：该完整性只在 LOCAL 且无降级、或 QUORUM 达标且无 failed 节点时允许；副本缺失时答案即使检索完整也标注 `degraded=true`、`consistency=PARTIAL`，不得读作集群健康。
- **秘密最小化是策略而非绝对保证**：默认 `deny` 模式按保守路径/文本模式筛查并拒绝复制命中事件；列表可能误判同名普通文件，且不声称捕获所有敏感信息形态。
- **提前冻结会丢弃迟到结果（T-157）**：COMMITTED 在首个达标副本、QUORUM 在 `commit_index == primary` 的唯一多数派组达标时立即冻结；此后到达的成功/失败/冲突标记为 `LATE_DISCARDED`，不进入 candidates、conflicts、quorum 计数、`max_lag`、一致性或 `failed_nodes`。这是“不等待无关慢节点”的显式语义，不是忽略故障；低提交点 quorum 与 AS_OF 仍完整 gather，避免以更快换更旧。
- **并发上限是进程级准入，不是动态调度（T-157）**：`maxConcurrentNodes`/`maxInFlightPerNode`/`maxQueuedNodes` 只做有界队列与直接拒绝；队列满表现为该节点 `NODE_UNAVAILABLE`（含 `scheduler refused` 详情）。没有 EWMA、动态权重、抢占或线程池；上限臂会用吞吐换有界负载，不能读作提速承诺。
- **取消只在本地 IPC/TCP 内传播（T-158）**：requestId cancel 需要 worker/服务端协作；迟到成功被抑制，重复取消幂等。若对端在 `cancelGraceMs` 内不确认，只有在该连接/子进程已无其他在途请求时才受控终止；跨机/跨进程管理域取消未验证。受控终止会结束该连接或子进程上尚未完成的请求，这一点已通过“无其他在途请求才终止”的规则限定。
- **进程退出钩子的平台边界（T-159）**：`installProcessCleanup` 是可选项，逻辑用 `ProcessCleanupTarget` seam 单测（关闭 registry、重发原信号、dispose）。本机实测 Windows 上 `process.kill(pid,'SIGTERM')` 会直接终止进程而不触发 JS 处理器，因此 Windows 的信号驱动清理不保证执行；POSIX 真信号投递未在本环境验证。资源水位只汇总显式注册的 source，不是全机进程/socket 清单。
- **性能对照是内存合成基准（T-160）**：`docs/evidence/probe-lifecycle-benchmark.md` 的 P50/P95/P99、吞吐与 heap Δ 来自单进程内存 store，不含跨机 RTT、副本 I/O 或真实查询分布；Windows 定时器粒度约 15.6ms，3–5ms 模拟延迟会被量化。慢尾对照（200ms 节点 vs 提前冻结）是有效信号，但不得外推为生产 SLA 或容量承诺。

## 多主高可用边界（M16 / ADR-012）

- **本地注入 ≠ 跨机真实回拨**：时钟验证用的是进程内可注入虚拟时钟（每节点 offset/回拨/jump 序列注入 `now()`），不改系统时钟；跨机时钟回拨、NTP 跳变与物理机房间时钟偏移均未验证。墙钟只用于租约计时与诊断，不参与版本排序。
- **代理注入 ≠ OS 真分区**：`isolate(groups)` 是对经过 `TcpFaultProxy` 的真实 loopback TCP 链路做整帧 `drop` 重建，属于 TCP 协议层故障注入；OS 防火墙规则、内核协议栈故障与物理链路中断未验证。
- **RTO/RPO 仅单机实测，无生产 SLA**：RTO=2050.058 ms（leader failover，切换窗拒绝率 0.5、RPO(未确认丢失)=1）、follower/rejoin 场景 RPO=0 等数值来自同一测试进程内的 3 节点 loopback 集群、固定种子 smoke/S 档；真实生产检测时间、写入分布与跨机带宽为 **[数据缺失]**，不承诺任何 SLA。
- **集群无自动 failover 守护**：没有 daemon、没有自动接管；恢复依赖调用方显式执行 `elect()`/`rejoin()`/`restore()`。基准 RTO 包含被驱动的 `elect()` 调用，不是自治故障切换时间。
- **rejoin 语义限制**：无租约的 follower 直接 `rejoin()` 会以自身为 leader 探测，被 peer 记为同 term 竞争；安全顺序是先 `manager.renewLease()` 再 `rejoin()`。旧主 rejoin 后只降级并从新主追平，不覆盖新主日志——该行为已验证，但「自动选主并恢复」未实现。
- **TLS 仅 loopback + 自签测试**：传输测试只在 `127.0.0.1`/`::1` 上使用临时生成的自签证书，验证服务端证书校验、错误 trust 与 hostname 不匹配拒绝；没有受信 CA、证书轮换与跨主机名部署验证。
- **mTLS 接口未集成测试**：`TcpReplicaServerOptions.tls.requestCert`/`rejectUnauthorized` 选项存在，但客户端证书（双向认证）路径没有任何集成测试覆盖，不得宣称已验证。
- **打包未公开 HA 子路径**：包 `exports` 只公开 `.` 与 `./package.json`；HA 模块（`src/memory/*` → `dist/memory/*`）当前只能仓库内/深路径使用，非稳定公开 API。

## 钩子强制边界（M19）

- **三道防线不是全知拦截**：`PreToolUse` 在声明的文件编辑工具前判定，`Stop` 用 Git 基线补检，`track complete` 仍要求 Gate evidence。Shell 间接写文件可绕过 pre-tool，但会进入 stop 的 C1；宿主若未安装/未触发钩子，ANO 无法代替宿主强制执行。
- **工具级闸门 ≠ 输出拦截**：`output-interception` 仍为 `unavailable`。ZCode 为真实验证的 `hooks-validated`，Claude Code 仅为公开文档映射的 `hooks-documented`，其他客户端不因此升级。
- **revision 绑定是显式取舍**：结构探查证据绑定当前图 revision；同 revision 下其他会话的探查可满足放行，不能证明当前操作者理解过文件。图 stale/degraded 时 advisory 返回 ask、strict 返回 deny，失败不静默 allow。
- **路径与隐私边界**：越界、不可解析和 symlink/junction 逃逸不 allow；pre-tool 不写账本、不重建图。机械摘要只来自 Git、账本与 hook 元数据，不读取 transcript、提示词、模型回答或文件正文，也不产生 Gate `evidence_id`。

## 个人模式边界（M21）

- **无配置不迁移**：既有项目没有 `.ano/config.toml` 时保持 `full`；`personal` 只改变默认帮助、doctor 可见性和 setup 新配置，不删除高级命令、不降低 Gate 要求。
- **配置解析有意受限**：只解释 `profile`、`hooks.mode`、`hooks.exempt`、`hooks.prompt_hint` 与 M23 的 `python.interpreter`、`python.roots`，未知键/段给出警告而不执行任意 TOML 内容；配置不是授权，不能替代 takeover、安装或发布的人工确认。
- **setup 默认零写**：非 TTY 只输出计划，即使带 `--yes-dry-run` 也不写。真实写入要求 TTY 逐步确认；任一步拒绝即停止，已完成的接管/钩子步骤需用对应 disable/recover/restore 回退，历史不删除。
- **真实个人闭环未由单测替代**：隔离夹具与三会话连续性证明机制，不构成 `<example-project>` 的 setup、cutover、误拦率或三次真实工作会话验收；这些仍以 M22 具名人工证据为准。
- **M22 按具名人工判定闭环（2026-11-27，project owner）**：接管 enforced、两项切换任务有有效 Gate 证据、两个候选真实工作会话已核实；三次会话的量化指标与误拦标注未采集、停止判据 insufficient-data。该闭环是项目所有者的主观决定，不是指标达标声明；复核须按 `docs/evidence/m22-real-project-loop.md` 补齐，不得回填。
