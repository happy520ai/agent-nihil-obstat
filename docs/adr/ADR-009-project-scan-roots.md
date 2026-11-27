# ADR-009：项目根 / 源码扫描根 / PM 根分离契约

日期：2026-11-23
状态：提议（待主控审阅；审阅通过后置"已接受"并开放 `phase-project-scan` 门禁）
任务：T-103 / SCAN-01（M13）
输入契约：`.pm/tasks.json`（T-103~T-110）、`docs/adr/ADR-006-project-takeover.md`、`docs/adr/ADR-007-client-adapters.md`、`docs/adr/ADR-008-full-client-catalog.md`、`docs/takeover.md`、`.pm/decisions/ADR-003`、`ADR-004`、`src/core/fingerprint.ts`、`src/structure/store.ts`、`src/structure/fresh.ts`、`src/surface/service.ts`、`src/ledger/migrate.ts`、`src/connect/takeover.ts`、`.pm/project.json`、`scripts/orchestration/m13-plan.json`、真实项目 `<example-project>` 只读实测事实

> 编号说明：本文件是 `docs/adr/` 系列 ADR-006/007/008 的 M13 后续，不推翻既有 ADR 的授权、接管、客户端目录与记忆语义。冲突处以本 ADR 的「三根分离」与「扫描降级」语义为准。

## 1. 背景与问题定义

现状 `src/surface/service.ts:113` 的 `existingProjectRoot()` 强制要求**传入根本身**同时满足：存在 `package.json` 且是 Git work tree。真实项目 `<example-project>` 的仓库根没有 `package.json`（Node manifest 在 `server/package.json`），于是：

- 直接对仓库根调用 `brief` 被拒；对 `server/` 调用虽能出 brief，却把**源码根**当成了 **PM 根**，导致 `PM tasks=0`、`graph files=0`（`.pm` 与 `.ano` 都落到 `server/`，而权威 PM 数据在仓库根 `.pm`）。
- 仓库根 `.pm/project.json` 已声明 `scan_ignore`（含 `server/data/**`、browser profiles、logs、exports、模型权重等），但扫描器不读取它，用户被迫搬目录或删链接才能扫描。
- 指纹器（`src/core/fingerprint.ts:28`）遇到任何符号链接直接抛错，整树失败；对大文件（safetensors）整读触发 `ERR_FS_FILE_TOO_LARGE`；Chrome profile 占用文件触发 `EBUSY`。
- 约 11.5 万文件使一次 brief 全树重建耗时 3 分 48 秒，超过 MCP 60 秒超时。

一句话问题定义：把「项目根」拆成** Git 根 / PM 根 / 源码扫描根**三个独立语义，并为扫描建立**统一、可复用、可降级、有预算**的配置与状态契约，使扫描器不再依赖「根目录必须有 package.json」这一错误假设，也不再让源码根与 PM 根互相冒充。

「修好了」的判据：T-104~T-110 的实现者不需要再做本 ADR 范围内的语义决策；验收可直接按第 13 节判据与第 12 节文件所有权编写。

## 2. 硬边界（全节为硬边界，实现与测试不得违反）

以下九条是 M13 扫描契约的不可变边界，与 ADR-003/004/006/007/008 一致；任一条被违反即视为实现错误，而不是配置问题：

1. **Git 根 / PM 根 / 源码扫描根分离**：三者语义独立，不得静默混用；角色冲突必须显式报错。
2. **不自动扫描全盘**：发现只从调用方给定的根**向下有限深度**进行，向上只沿祖先链找 `.git`，绝不搜索兄弟目录、其他盘或用户目录。
3. **只读复用用户既有 `scan_ignore`**：`.pm/project.json` 的 `scan_ignore` 必须被读取并优先应用；**不得要求用户搬目录或删除链接**，不得改写该文件。
4. **不删链接、不搬目录、不修改业务数据**：扫描过程对源码树零写（`.ano/` 缓存除外）。
5. **链接不跟随且状态明确**：默认不跟随符号链接/junction，逐条给出 `skipped-link` + 目标路径 + 原因。
6. **大文件流式哈希**：超过阈值必须分块 sha256，不得整文件读入内存。
7. **超时明确返回**：预算耗尽必须返回 `timeout` + 已完成部分 + 耗时，**禁止 `files=0` 冒充正常**。
8. **迁移与接管使用仓库根 `.pm`**：PM 根默认 = Git 根；源码根的 `.pm`（如 `server/.pm`）永远不是主源。
9. **不改变 M10 接管授权语义与 M11/M12 客户端目录**：授权/六阶段/备份/回退、客户端探测与配置写路径均不受本 ADR 影响；不新增第八个 MCP 工具。

**自动工作流与人工动作的区分**：扫描、指纹、图构建、缓存复用、降级报告属于自动工作流，全程只读源码树；接管授权、发布、权限批准仍是具名人工动作。本 ADR 不新增任何写用户级配置或业务数据的路径。

## 3. 决定一：三根分离契约

### 3.1 语义表

| 根 | 语义 | 解析来源（优先级从高到低） | 用途 | 默认 |
|---|---|---|---|---|
| **Git 根** `gitRoot` | 版本控制仓库根 | ① 显式 `gitRoot` 参数/配置；② 从给定根向上找 `.git`（文件或多级目录）；③ 显式 `requireGit:false` 时 = 给定根 | 版本控制、PM 数据定位、`.ano/` 存储位置、源码扫描的边界 | 给定根所在的 Git work tree 根 |
| **PM 根** `pmRoot` | 权威 `.pm` 所在目录 | ① 显式 `pmRoot`；② = `gitRoot` | 迁移（tasks/roadmap/features/sessions）、takeover、handoff、Connect 只读 PM 数据、任务计数 | `gitRoot` |
| **源码扫描根** `sourceRoots` | 一个或多个待扫描目录 | ① 显式 `sourceRoots`；② `existingProjectRoot` 发现（第 4 节） | 指纹、图构建、扫描统计、brief/explore 的符号检索 | 发现到的最近层 Node 包集合 |

三者关系：`sourceRoots[*]` 必须位于 `gitRoot` 内（或等于 `gitRoot`）；`pmRoot` 必须包含 `.pm/`；`sourceRoots` 与 `pmRoot` 可以重叠（例如单包项目 `sourceRoots=[gitRoot]`，`.pm` 也在 `gitRoot`），但**重叠不等于同角色**。

### 3.2 解析优先级与冲突错误

- 优先级：**显式参数 > 项目配置（`.ano/project.json` / `.pm/project.json`）> 发现默认**。任何一层被显式覆盖时，必须在 `discovery.overridden=true` 中留痕，不得静默。
- `SOURCE_ROOT_OUTSIDE_GIT_ROOT`：任一 `sourceRoot` 解析后不在 `gitRoot` 内（含符号链接逃逸）→ 拒绝，不做相对路径猜测。
- `PM_ROOT_WITHOUT_PM`：`pmRoot` 下没有 `.pm/`（或显式指定了不存在的 `.pm`）→ 拒绝；迁移/接管/任务计数不得退到源码根的 `.pm`。
- `ROOT_ROLE_CONFLICT`：调用方只给一个 `root`，但该根既非 Git 根、其向上发现的 Git 根又含 `.pm`，而调用方未声明 `sourceRoots`/`pmRoot` 时，必须按「`root` = 源码扫描起点、`pmRoot` = Git 根」解析并在报告中显式记录 `inputRoot != gitRoot`；若调用方显式声明 `root` 同时是 PM 根与源码根且二者不同，则拒绝。
- `server/.pm` 非主源：`pmRoot` 默认取 `gitRoot`，即使 `server/.pm` 存在也不得用于迁移/接管；如显式 `pmRoot=server` 且其 `.pm` 不含任务数据，报 `PM_ROOT_WITHOUT_PM`。

### 3.3 计数语义

- `graph.files` / `graph.symbols`：只统计 `sourceRoots` 内、通过排除集、且非链接的真实文件；排除项与链接**不计入**。
- `PM tasks`：来自 `pmRoot/.pm`（迁移后来自 `pmRoot/.ano/ledger`），**绝不**取自 `sourceRoots` 的 `.pm`。
- 报告必须同时给出 `rootResolution: { inputRoot, gitRoot, pmRoot, sourceRoots }`，使「哪个根产出哪个计数」可审计。

## 4. 决定二：`existingProjectRoot` 发现策略

### 4.1 输入与 Git 根判定

- 输入 `startRoot` 必须存在且是目录（否则 `ENOENT`/`ENOTDIR` 明确报错）。
- Git 根：从 `startRoot` 沿**祖先链**向上找 `.git`（Windows 下 `.git` 可能是文件——`gitdir` 指针——或目录），命中即 `gitRoot`；找不到且 `requireGit !== false` → `NOT_A_GIT_WORK_TREE`（沿用现状语义）；`requireGit:false` 才允许 `gitRoot=startRoot`。
- 向上查找只访问祖先链，**不搜索整盘**；向下发现只从 `gitRoot` 开始，深度受限。

### 4.2 嵌套 Node 包发现

- 从 `gitRoot` 向下 BFS，最大深度 `maxDiscoverDepth`（默认 **3**，可配置；0 表示只在 `gitRoot` 找）。
- 遍历跳过默认排除集与 `scan_ignore` 命中的目录（`node_modules`、`.git`、`.pm`、`dist`、`.venv` 等），避免在依赖树里发现伪包。
- 候选 = 含 `package.json` 的目录。候选记录：`{ relativePath, absolutePath, depth, name? }`。
- 排序固定：**深度升序**（最近的 `package.json` 优先），同深度按相对路径 `Buffer` 字典序（确定性，无平台歧义）。

### 4.3 选择规则与歧义处理

1. **显式 `sourceRoots`**：校验每个根存在、是真实目录、在 `gitRoot` 内、不跟随链接越界后直接使用，`discovery.overridden=true`。
2. **单一候选**：`sourceRoots = [该候选]`。
3. **多个候选**：默认 `onAmbiguity='nearest-layer'`，取**最近深度层**的全部候选（monorepo 语义，例如 `server/`、`client/`、`workbench/` 同为 depth 1），并在 `discovery.ambiguous=true` 中列出全部候选。
   - `onAmbiguity='error'` 或调用方显式要求**单根**（如 `packageRoot` 参数）时，多候选 → `AMBIGUOUS_SOURCE_ROOTS`，错误信息列出候选相对路径与深度，绝不随机选一个。
4. **零候选**：`NO_NODE_PACKAGE`，明确提示「仓库根与有限深度内无 `package.json`」；`brief` 保留既有 connected-only 只读回退，绝不创建 Graph/Ledger 或扫描其它目录。
5. **普通单包项目兼容**：`gitRoot` 自身含 `package.json` 时候选就是 `gitRoot`，`sourceRoots=[gitRoot]`，行为与现状一致。

### 4.4 发现报告字段

```
discovery: {
  startRoot, gitRoot,
  candidates: [{ relativePath, depth, name? }],
  selected: string[],          // 绝对路径
  depth: number,               // 实际达到的最大深度
  truncated: boolean,          // 是否因深度/预算截断
  ambiguous: boolean,
  overridden: boolean          // 显式 sourceRoots 覆盖了发现结果
}
```

## 5. 决定三：扫描配置与排除

### 5.1 配置来源优先级

| 优先级 | 来源 | 读写 | 说明 |
|---|---|---|---|
| 1 | 显式参数（`sourceRoots`/`exclude`/`include`/`followLinks`/`maxFileBytes`/`timeoutMs` 等） | — | 最高，覆盖一切 |
| 2 | `.ano/project.json`（ANO 自有项目配置） | 可读可写（本 ADR 不写真实项目） | 字段见配置参考文档 |
| 3 | `.pm/project.json` 的 `scan_ignore` | **只读复用** | 用户已声明，优先于默认集；不得改写 |
| 4 | 默认安全排除集 | — | 见 5.2 |

### 5.2 默认安全排除集（含依据）

| 类别 | 目录/模式 | 依据 |
|---|---|---|
| 版本控制 | `.git`、`.hg`、`.svn` | 元数据，非源码，体积大 |
| 依赖 | `node_modules`、`bower_components`、`jspm_packages` | 可再生，含大量链接与平台二进制 |
| 构建产物 | `dist`、`dist*`、`build`、`out`、`output`、`.next`、`.nuxt`、`.output`、`.turbo`、`.svelte-kit`、`.angular`、`coverage`、`.nyc_output`、`.tsbuildinfo` | 生成物，变化频繁且非源码 |
| Python 运行时 | `__pycache__`、`.pytest_cache`、`.mypy_cache`、`.ruff_cache`、`.tox`、`.venv`、`venv`、`env`、`site-packages` | 字节码/虚拟环境，含链接与二进制 |
| JVM/缓存 | `target`、`.gradle`、`.mvn`、`.cache` | 构建缓存 |
| IDE/编辑器 | `.idea`、`.vscode`、`.vs` | 本地设置，含机器相关路径 |
| Agent/运行时 | `.pm`、`.ano`、`.zcode`、`.runtime`、`.zwork`、`.workbuddy`、`.lintenv*` | PM/ANO/客户端运行时数据，敏感且非源码 |
| 浏览器 profile | `chrome-cdp-profile`、`chromium-profile`、`browser-profile`、`.chrome` | 含登录会话（敏感），文件常被占用（EBUSY） |
| 日志/导出 | `logs`、`log`、`exports`、`export`、`*.log`、`_reg_*.log`、`*.tmp` | 运行产物，体积大且变化频繁 |
| 备份/归档 | `backups`、`archive`、`*.bak` | 历史副本，非源码 |
| 模型权重（文件扩展名） | `*.safetensors`、`*.gguf`、`*.ckpt`、`*.pt`、`*.pth`、`*.onnx`、`*.h5`、`*.bin`（模型目录下）、`*.tflite` | 大文件，整读会 `ERR_FS_FILE_TOO_LARGE`；由扫描器流式处理或排除 |
| 秘密/敏感 | `.env*`、`*.pem`、`*.key`、`*.p12`、`*.pfx`、`*.kdbx`、`*.ppk`、`id_rsa*`、`id_ed25519*`、`credentials.json`、`secrets/` | 沿用 `src/connect/backup.ts` 敏感策略，默认不采集 |

> `data/` **不**默认排除：它可能含源码或配置，是否排除由 `.pm/project.json` 的 `scan_ignore` 声明（真实项目已声明 `data/**`、`server/data/**`）。默认集只排除上面列出的、有明确依据的类别。

### 5.3 `scan_ignore` 复用规则

- 读取 `<pmRoot>/.pm/project.json` 的 `scan_ignore` 数组（只读），并合并 `.ano/project.json` 的 `exclude`（若存在）。
- 语法：标准 glob，支持 `**`（跨段）、`*`（段内）、`?`；目录声明（如 `server/data/**`）等价于「该目录及其全部子内容」。
- 匹配基准：对文件的**相对 `gitRoot` POSIX 路径**匹配（与用户声明习惯一致，如 `server/data/**`）；当 `sourceRoot != gitRoot` 时同时匹配相对 `sourceRoot` 的路径。命中任一基准即排除。
- 用户声明优先于默认集；`include`（显式包含）优先于所有排除，但**不得**用 `include` 把秘密目录或链接目标重新纳入（秘密/链接边界不可被 `include` 覆盖）。
- **排除生效点三处一致**：指纹（`fingerprintTree`）、图构建（`GraphStore.build` 使用的同一指纹配置）、扫描统计（文件/符号/字节计数）必须消费**同一个解析后的排除集**；禁止各自遍历或各自维护排除列表。

## 6. 决定四：符号链接策略

- 默认 `followLinks=false`。
- 扫描树内遇到符号链接/junction：**不跟随、不读取目标、不删除、不修改**。
- 逐条状态：`status='skipped-link'`，记录 `path`（相对扫描根）、`target`（`lstat`/`readlink` 读到的原始目标字符串，**不解析 realpath**，避免越界读取）、`reason='follow-links-disabled'`。
- 目录链接：不递归；计入 `stats.skippedLinks`，**不计入文件集**。
- 文件链接：同样跳过（不读目标内容），状态 `skipped-link`。
- 根本身可以是链接：`resolveRoot()` 沿用了「根链接跟随一次到 realpath」的既有语义（`src/connect/paths.ts:9`）；一旦进入扫描树，不再跟随。
- 显式 `followLinks=true`（opt-in）：必须做 realpath 环路检测与 root 逃逸检测；越界 → `LINK_ESCAPE`，按 `degraded`/`error` 处理。默认关闭，因为真实项目已证实链接会导致整树失败。
- 既有测试 `test/unit/fingerprint.test.ts` 的「链接即抛错」用例（`symbolic links are rejected rather than followed outside root`）由 T-105 更新为「链接跳过且状态明确」；该文件归 T-105 独占。

## 7. 决定五：大文件策略

- 阈值 `maxFileBytes`，默认 **64 MiB**（67,108,864 字节），可配置；`0` 表示不限（仍建议保留默认）。
- 超过阈值：**流式分块 sha256**（默认块 4 MiB），逐块 `hash.update()`，不把整文件读入内存，避免 `ERR_FS_FILE_TOO_LARGE` 与 OOM。
- 默认排除集已覆盖模型权重；若用户显式 `include` 某个大文件，则仍执行流式哈希以保证指纹完整，并标记 `streamed=true`（不是错误）。
- 占用文件（`EBUSY`/`ETXTBSY`）与权限不足（`EACCES`/`EPERM`）：跳过，分别记 `busy-file` / `permission-denied` 与原始 `code`，计入 `degraded` 指标；**不是整树错误**。
- 稳定性：读前/读后 `stat` 对比（`size`/`mtimeMs`/`ino`），不一致 → `source-changed`，计入 `degraded`，不静默纳入。

## 8. 决定六：超时与降级语义

### 8.1 预算

| 参数 | 默认 | 说明 |
|---|---|---|
| `timeoutMs` | 50,000 | 单次扫描/构建共享预算，必须小于 MCP 60 秒超时 |
| `maxFiles` | 200,000 | 文件数上限，超出即截断并标记 |
| `maxTotalBytes` | 不限 | 可选，防止异常巨型树 |
| `maxDiscoverDepth` | 3 | 包发现深度上限 |

- 扫描/图构建共享同一 `deadline`；每处理若干条目检查一次是否超时。

### 8.2 状态与返回

- 顶层状态：`ok`（完整）/ `degraded`（部分完成，含跳过/占用/不可读）/ `timeout`（预算耗尽）。
- **超时返回必须包含**：`status='timeout'`、`partial=true`，以及 `completed: { files, bytes, elapsedMs }`、`budget`、`reason`。
- **`files=0` 冒充正常被禁止**：`status='ok'` 时文件数必须 > 0（`sourceRoots` 为空是 error）；`files=0` 只能出现在 `timeout`/`degraded`/`error` 且带明确原因。

### 8.3 缓存复用与重建降级

- `GraphStore.open` 命中有效缓存（`freshness=fresh`，或 `degraded` 但 `sourceFingerprint` 与当前树一致）→ **直接用缓存**，不重建；`brief`/`explore` 默认 `rebuild:false`。
- 缓存无效/缺失 → 按预算构建；若构建超时 → **保留旧快照**，返回 `status='timeout'` + 旧快照并标注 `stale=true`，绝不返回空快照。
- `checkFreshness` 本身走同一预算；超时 → `freshness.status='degraded'` + `timeout:true`，不得把「未知」当 `fresh`。
- 重建降级策略：`cache.reuse='auto'`（默认，命中即用）/ `'always'`（强制用缓存，缺失则报错）/ `'never'`（强制重建）；`cache.rebuild` 仅显式 `true` 时触发。
- 计数语义：`brief.graph.files` 为实际纳入文件数；缓存命中时标注 `cache:'hit'` 与 `freshness`，重建时标注 `cache:'miss'` 与耗时。

## 9. 决定七：图 / freshness / brief 共享扫描选项

- 统一类型 `ProjectScanOptions`（T-104 在 `src/core/project-scan.ts` 实现）：

```ts
interface ProjectScanOptions {
  gitRoot?: string;
  pmRoot?: string;
  sourceRoots?: string[];
  exclude?: string[];
  include?: string[];
  followLinks?: boolean;       // default false
  maxFileBytes?: number;       // default 64 MiB
  timeoutMs?: number;          // default 50_000
  maxFiles?: number;           // default 200_000
  maxDiscoverDepth?: number;   // default 3
  onAmbiguity?: 'nearest-layer' | 'error';
  cache?: { reuse?: 'auto' | 'always' | 'never'; rebuild?: boolean };
}
```

- **一次解析、多处复用**：`resolveProjectScan(startRoot, params)` 返回 `{ gitRoot, pmRoot, sourceRoots, exclude, include, followLinks, maxFileBytes, timeoutMs, discovery }`；`fingerprintTree`、`GraphStore`、`checkGraphFreshness`、`brief`、`explore`、`audit`、`export` 全部消费它，禁止各自重复遍历或各自解析根。
- `GraphStore.open(root, { scan })` 接受统一选项；`build()` 与 `checkFreshness()` 使用同一排除集与预算。
- MCP 与 CLI 同一语义：`src/surface/mcp.ts` 与 `src/surface/cli.ts` 调用同一 `service` 函数，不新增工具、不各自实现扫描。
- 计数：`graph.files/symbols` 来自 `sourceRoots`；`tasks` 来自 `pmRoot`；两者在同一份 `rootResolution` 中可见。

## 10. 决定八：迁移与接管根绑定

- 迁移（`planMigration`/`migrateProject`/`reconcileMigration`）、takeover（`runTakeover`/`takeoverStatus`）、handoff、Connect 只读 PM 数据一律使用 **`pmRoot`（默认 = Git 根）的 `.pm`**。
- 源码根的 `.pm` 不是主源：当 `sourceRoot != gitRoot` 且 `sourceRoot/.pm` 存在时，忽略它（报告 `ignoredPmRoots`），绝不用于迁移/接管。
- 真实项目实测：`<example-project>/server/.pm` 仅含 `.gitignore` 与 `.runtime/`，无 `tasks.json`；权威数据在仓库根 `.pm`（2026-11-23T18:5x 只读实测 338 任务 / 活跃 54，时点值）。这验证了「PM 根必须绑定 Git 根」的必要性。
- 迁移 sources 默认相对 `pmRoot` 的 `.pm/{tasks,roadmap,features,sessions}.json`；路径校验沿用 `assertSafeRelative`，拒绝穿越与符号链接（`src/ledger/migrate.ts:191`）。
- `.ano/` 存储（`cache/graph.db`、`ledger`、`takeover`）落在 **Git 根**，不落在 `sourceRoot`；避免 `root=server` 时把 `.ano` 建到 `server/` 而与仓库根 PM 数据分裂。
- **既有 M10 接管语义不破坏**：takeover 仍用 `resolveRoot(rootInput)` 的 canonical realpath；当 `rootInput` 是源码根时，takeover 必须解析到 `pmRoot`（Git 根）或显式报错；授权绑定 `root` 仍为 canonical 项目根。六阶段、备份、回退、授权撤销语义完全不变。

## 11. 状态枚举与错误码

### 11.1 状态枚举（固定）

| status | 层级 | 含义 |
|---|---|---|
| `ok` | 顶层/条目 | 完整扫描，无跳过 |
| `degraded` | 顶层 | 部分完成（存在链接/占用/权限/变化），文件集可返回 |
| `timeout` | 顶层 | 预算耗尽，返回部分结果 + 耗时 |
| `skipped-link` | 条目（也计入顶层 `degraded`） | 链接未跟随，含目标路径与原因 |
| `permission-denied` | 条目（也计入顶层 `degraded`） | `EACCES`/`EPERM` |
| `busy-file` | 条目（也计入顶层 `degraded`） | `EBUSY`/`ETXTBSY` 等占用 |

条目级补充码：`source-changed`（读前后 stat 不一致）、`streamed`（大文件流式哈希，正常）。

### 11.2 错误码

| 错误码 | 触发 | 处理 |
|---|---|---|
| `NO_NODE_PACKAGE` | 有限深度内无 `package.json` | 明确报错；brief 保留 connected-only 回退 |
| `AMBIGUOUS_SOURCE_ROOTS` | 多候选且要求单根 / `onAmbiguity='error'` | 列出候选，拒绝选择 |
| `SOURCE_ROOT_OUTSIDE_GIT_ROOT` | sourceRoot 越出 Git 根 | 拒绝 |
| `PM_ROOT_WITHOUT_PM` | pmRoot 无 `.pm` | 拒绝迁移/接管 |
| `ROOT_ROLE_CONFLICT` | 同一 root 被要求同时扮演不同角色 | 拒绝，要求显式声明 |
| `LINK_ESCAPE` | `followLinks=true` 时链接越界 | 拒绝/降级 |
| `SCAN_BUDGET_EXCEEDED` | 超过 `timeoutMs`/`maxFiles` | 返回 `timeout` + 部分 |
| `CONFIG_INVALID` | 非法 glob、未知字段、路径穿越 | 拒绝，不静默忽略 |

## 12. 文件所有权与并行接口（T-104~T-110）

下表与 `.pm/tasks.json` 的 M13 任务簿一致；共享文件按依赖串行，不并发写。

| 任务 | files（任务簿原样） | 独占职责 / 接口契约 |
|---|---|---|
| T-103 | `docs/adr/ADR-009-project-scan-roots.md`、`docs/project-scan-configuration.md` | 本契约；已完成 |
| T-104 | `src/core/project-scan.ts`、`test/unit/project-scan.test.ts` | **扫描配置基座**。实现 `ProjectScanOptions`、`resolveProjectScan()`、三根解析、`.ano/project.json` 与 `.pm/project.json.scan_ignore` 只读合并、默认排除集、glob 匹配、路径/根限制、状态枚举。不依赖 fingerprint/GraphStore。 |
| T-105 | `src/core/fingerprint.ts`、`test/unit/fingerprint.test.ts` | **指纹语义修复**。符号链接跳过（不跟随/不删）、大文件流式哈希、占用/权限/变化状态；消费 T-104 的扫描选项。独占 `fingerprint.ts`。 |
| T-106 | `src/structure/store.ts`、`src/structure/fresh.ts`、`src/surface/service.ts`、`src/surface/mcp.ts`、`test/unit/structure.test.ts`、`test/unit/surface-service.test.ts` | **图/新鲜度/brief 接入**。GraphStore.open/build/checkFreshness 使用统一扫描选项；缓存复用与超时降级；brief/explore 共享选项；`files=0` 不冒充。依赖 T-104/T-105。 |
| T-107 | `src/surface/service.ts`、`src/ledger/migrate.ts`、`src/connect/takeover.ts`、`test/integration/migrate-takeover.test.ts` | **迁移/接管根绑定**。existingProjectRoot 接受 Git 根 + 嵌套包；迁移读仓库根 `.pm`；Connect/handoff/takeover 不混用 `server/.pm`。依赖 T-103/T-104。 |
| T-108 | `docs/evidence/scan-ecommerce-project.md`、`docs/evidence/scan-ecommerce-project.json` | **真实项目只读验收**。仅对 `<example-project>` 只读；复用其 `scan_ignore`；验证仓库根 PM、源码文件、图符号、超时。依赖 T-106/T-107。 |
| T-109 | `test/redteam/project-scan-boundary.test.ts` | **扫描安全红队**。链接逃逸、秘密目录、巨大文件、运行时锁、恶意 glob、嵌套包 root 绕过、PM/扫描根错配、超时与 Gate 证据边界。依赖 T-104~T-107。 |
| T-110 | `README.md`、`docs/usage.md`、`docs/limitations.md`、`docs/takeover.md`、`docs/project-scan-configuration.md` | **最终质量、文档与真实入口验收**。不自动接管真实项目；更新使用说明。依赖 T-108/T-109。 |

### 12.1 并行接口边界（实现者必读）

- **配置先于指纹**：T-104 先固定 `ProjectScanOptions`/`resolveProjectScan` 与状态枚举，T-105/T-106/T-107 才接入；不得反向依赖。
- **`src/core/project-scan.ts` 归 T-104 独占**；T-105/T-106/T-107 只调用，不改它。
- **`src/core/fingerprint.ts` 归 T-105 独占**；T-106 只消费其返回，不改它。
- **`src/structure/store.ts`/`fresh.ts` 归 T-106**；`src/surface/service.ts` 由 T-106/T-107 串行接入（T-106 先做图/freshness/brief，T-107 后做迁移/接管根绑定）。
- **`src/ledger/migrate.ts`/`src/connect/takeover.ts` 归 T-107**；T-106 不得要求改这两个文件。
- **共享文件冲突**：未声明的共享文件一律串行；发现冲突立即停派并对账（`scripts/orchestration/protocol.md`）。
- **文档**：`docs/project-scan-configuration.md` 由 T-103 创建、T-110 收口更新；其他文档由 T-110 统一更新。

## 13. 测试与验收判据

- **三根解析**：单包（根有 package.json）、嵌套（根无 package.json、`server/package.json`）、多包（monorepo 最近层）、无包（`NO_NODE_PACKAGE`）确定性用例；`rootResolution` 字段完整。
- **发现**：深度上限生效（超过 `maxDiscoverDepth` 的包不被选中）、不扫描全盘（不访问兄弟/其他盘）、候选排序确定性、歧义 `onAmbiguity` 两态。
- **排除**：`.pm/project.json.scan_ignore` 只读复用且优先于默认集；默认集覆盖第 5.2 节类别；指纹/图构建/统计三处结果一致；秘密目录与路径逃逸拒绝。
- **链接**：默认不跟随、不读目标、不删链接、状态 `skipped-link` 含目标路径；`followLinks=true` 时环路/逃逸被拒。
- **大文件**：> `maxFileBytes` 走流式哈希；哈希结果与整读一致（小文件对照）；无 `ERR_FS_FILE_TOO_LARGE`。
- **占用/权限**：`EBUSY`/`EACCES` → `busy-file`/`permission-denied`，顶层 `degraded`，不抛整树。
- **超时**：注入超时返回 `timeout` + `completed` + `elapsedMs`；`files=0` 不得出现在 `ok`。
- **共享选项**：brief/explore/freshness 使用同一排除集；缓存命中不全扫；缓存缺失重建；超时保留旧快照并标 `stale`。
- **迁移/接管**：迁移读仓库根 `.pm`；`server/.pm` 不被当主源；既有 takeover 测试与备份/回退回归通过。
- **回归**：`node scripts/run-tests.ts`、`npx tsc -p tsconfig.json --noEmit`、`node scripts/check-docs.ts` 全绿；七工具数量不变。

## 14. 与既有 ADR 的边界对账

- **ADR-003**：本 ADR 不把 Connect 快照变成主写真值源；`recall source=connected` 语义不变。
- **ADR-004**：迁移来源 `done → in_progress + verified=false` 不变；备份/回退不删数据；本 ADR 只固定迁移使用的根。
- **ADR-006**：接管授权/三态/六阶段/备份/撤销语义不变；本 ADR 只固定 `pmRoot` 绑定与 `.ano` 存储位置。
- **ADR-007/008**：客户端探测、配置写路径与 21 工具目录不变；不新增第八个 MCP 工具；扫描根发现不影响客户端身份判定。

## 15. 后果

- 实现者获得固定的三根语义、发现规则、排除/链接/大文件/超时契约与状态枚举，T-104~T-110 可并行；验收判据可预先编写。
- 代价：新增 `src/core/project-scan.ts` 配置层，指纹/图/brief 需接入统一选项；`brief` 在超大项目上仍可能走降级/缓存路径，但不再返回 `files=0` 冒充正常。
- 本 ADR 只固定语义与契约，不声称任何实现或测试已存在；实现完成后按第 13 节与 `docs/project-scan-configuration.md` 验收。
