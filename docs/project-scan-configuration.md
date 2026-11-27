# 项目扫描配置参考（M13 / SCAN）

- 日期：2026-11-23
- 任务：T-103 / SCAN-01（M13）；由 T-110 收口更新
- 上游契约：`docs/adr/ADR-009-project-scan-roots.md`（语义与硬边界以 ADR 为准；本文只给配置参考）
- 适用：T-104~T-110 实现者与真实项目验收

## 1. 目的与范围

本文给出 ANO 项目扫描的配置来源、字段、示例、状态与排查表。扫描指「对源码树做指纹、构建代码图、统计文件/符号」这一类只读操作，覆盖 `brief`、`explore`、`audit`、`rebuild graph` 与底层 `fingerprintTree`/`GraphStore`。

不在本文范围内：具体代码实现、PM 簿记、测试用例细节。任何与 ADR-009 冲突的表述以 ADR 为准。

## 2. 配置来源优先级

从高到低，前者覆盖后者：

| 优先级 | 来源 | 读写 | 说明 |
|---|---|---|---|
| 1 | 显式参数（CLI/MCP/库调用传入） | — | 最高优先级；覆盖一切默认 |
| 2 | `.ano/project.json`（ANO 自有项目配置） | 可读；本工具不主动写真实项目 | 字段见第 3 节 |
| 3 | `.pm/project.json` 的 `scan_ignore` | **只读复用** | 用户已声明的排除优先于默认集；工具不得改写该文件 |
| 4 | 默认安全排除集 | — | 见 ADR-009 第 5.2 节 |

合并规则：

- `exclude` = 默认集 ∪ `scan_ignore` ∪ `.ano/project.json.exclude` ∪ 显式 `exclude`；用户声明与显式参数优先。
- `.pm/project.json` 只贡献 `scan_ignore`（排除合并）；标量配置（`sourceRoots`/`followLinks`/`maxFileBytes`/`timeoutMs`/`maxFiles` 等）只来自显式参数与 `.ano/project.json`，不读 `.pm/project.json`。
- `include`（显式包含）优先于所有排除，但**不得**覆盖秘密目录与符号链接边界（不可用 `include` 重新纳入秘密或链接目标）。
- 任何被显式覆盖的项在 `discovery.overridden=true` 中留痕。

## 3. 字段表

### 3.1 根与发现

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `gitRoot` | string | 向上找 `.git` | Git 仓库根；PM 数据与 `.ano/` 存储位置 |
| `pmRoot` | string | `gitRoot` | 权威 `.pm` 所在；迁移/接管/任务计数使用 |
| `sourceRoots` | string[] | 发现结果 | 一个或多个源码扫描根，必须位于 `gitRoot` 内 |
| `maxDiscoverDepth` | number | `3` | 从 `gitRoot` 向下发现 `package.json` 的最大深度；`0` 只在根找 |
| `onAmbiguity` | `'nearest-layer'` \| `'error'` | `'nearest-layer'` | 多候选时：取最近层全部候选，或报错 |
| `requireGit` | boolean | `true` | `false` 时允许无 `.git`（`gitRoot=startRoot`）；`.ano/project.json.requireGit=false` 亦可在无 `.git` 时回退到 `startRoot` |

### 3.2 排除与包含

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `exclude` | string[] | 默认集 + `scan_ignore` | glob；相对 `gitRoot`（或 `sourceRoot`）的 POSIX 路径匹配 |
| `include` | string[] | `[]` | 显式包含，优先于排除（秘密/链接边界除外） |
| `followLinks` | boolean | `false` | `true` 时跟随链接，但做环路与逃逸检测 |

### 3.3 指纹与预算

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `maxFileBytes` | number | `67108864`（64 MiB） | 超过阈值走流式分块 sha256；`0` 表示不限 |
| `timeoutMs` | number | `50000` | 单次扫描/构建共享预算，小于 MCP 60 秒 |
| `maxFiles` | number | `200000` | 文件数上限，超出截断并标记 |
| `maxTotalBytes` | number | 不限 | 可选，防异常巨型树 |
| `deadline` | number | `now + timeoutMs` | 可选绝对 epoch-ms 截止；给出时覆盖 `timeoutMs` |
| `cache.reuse` | `'auto'` \| `'always'` \| `'never'` | `'auto'` | 缓存复用策略（亦可用顶层 `reuse`） |
| `cache.rebuild` | boolean | `false` | 强制重建图；当前由 `rebuildGraph` / `GraphStore.open({ rebuild:true })` 消费，`brief`/`explore` 的 `scan` 选项不传递该字段 |

### 3.4 解析结果（只读输出）

`resolveProjectScan(startRoot, params)` 返回：

```ts
{
  startRoot: string;
  gitRoot: string;
  pmRoot: string;
  sourceRoots: string[];
  excludes: (relativePath: string) => boolean;   // 秘密恒排除；include 覆盖 glob
  includes: (relativePath: string) => boolean;   // 对秘密路径恒为 false
  shouldFollowLink: (relativePath: string) => boolean;
  excludeGlobs: string[];       // 合并并规范化后的最终排除 glob
  includeGlobs: string[];
  followLinks: boolean;
  maxFileBytes: number;
  timeoutMs: number;
  maxFiles: number;
  maxTotalBytes: number | undefined;
  maxDiscoverDepth: number;
  onAmbiguity: 'nearest-layer' | 'error';
  requireGit: boolean;
  reuse: 'auto' | 'always' | 'never';
  budgets: ScanBudget;          // 指纹/图构建共享的同一预算
  discovery: {
    startRoot: string;
    gitRoot: string;
    candidates: { relativePath: string; absolutePath: string; depth: number; name?: string }[];
    selected: string[];
    depth: number;
    truncated: boolean;
    ambiguous: boolean;
    overridden: boolean;
  };
  configSource: {
    projectConfig?: string;
    pmProjectConfig?: string;
    pmScanIgnore: string[];
    defaults: string[];
    explicit: string[];
    ignoredPmRoots: string[];
  };
  rootResolution: { inputRoot: string; gitRoot: string; pmRoot: string; sourceRoots: string[] };
  ignoredPmRoots: string[];
}
```

## 4. 示例

### 4.1 嵌套 `server/` 布局 + 复用 `.pm/project.json` 的 `scan_ignore`

仓库根无 `package.json`，Node manifest 在 `server/package.json`，权威 PM 在仓库根 `.pm`：

```text
<repo>/
  .git/
  .pm/project.json        # scan_ignore: ["server/data/**", "chrome-cdp-profile/**", "logs/**", ...]
  server/package.json
  client/package.json
  workbench/package.json
```

解析结果（默认 `onAmbiguity='nearest-layer'`）：

```jsonc
{
  "gitRoot": "<repo>",
  "pmRoot": "<repo>",              // = gitRoot；迁移/接管读这里
  "sourceRoots": ["<repo>/client", "<repo>/server", "<repo>/workbench"],
  "discovery": {
    "candidates": [
      { "relativePath": "client", "depth": 1 },
      { "relativePath": "server", "depth": 1 },
      { "relativePath": "workbench", "depth": 1 }
    ],
    "selected": ["<repo>/client", "<repo>/server", "<repo>/workbench"],
    "ambiguous": true,
    "overridden": false
  }
}
```

- `graph.files/symbols` 统计 `server/client/workbench` 内的源码文件。
- `tasks` 来自 `<repo>/.pm`，绝不来自 `server/.pm`。
- `server/data/**`、`chrome-cdp-profile/**`、`logs/**` 由 `scan_ignore` 排除，工具不要求用户搬目录或删链接。

### 4.2 显式覆盖（单包或指定子集）

```jsonc
// .ano/project.json（ANO 自有配置）
{
  "sourceRoots": ["server"],
  "exclude": ["server/tools/tmp/**", "**/*.log"],
  "maxFileBytes": 33554432,
  "timeoutMs": 45000,
  "followLinks": false,
  "onAmbiguity": "error"
}
```

效果：只扫描 `server/`；额外排除 `server/tools/tmp/**` 与日志；大文件阈值降到 32 MiB；超时 45 秒；若发现多候选则报错。

### 4.3 普通单包项目兼容

```text
<repo>/{.git, package.json, src/}
```

`gitRoot == pmRoot == sourceRoots[0] == <repo>`，`discovery.candidates=[{relativePath:".", depth:0}]`，行为与现状一致。

### 4.4 大文件与链接

```jsonc
// 显式包含一个大文件（例如需要指纹完整）
{ "include": ["server/data/llm-local/base-2b/model-00000-of-00001.safetensors"] }
```

该文件仍走流式哈希（`streamed=true`），不全读入内存。符号链接默认 `skipped-link`，不跟随、不删除。

## 5. 错误与降级状态表

### 5.1 顶层状态

| status | 含义 | 返回内容 |
|---|---|---|
| `ok` | 完整扫描 | 完整文件集 + 统计 |
| `degraded` | 部分完成（链接/占用/权限/变化） | 部分文件集 + `degradedReasons[]` |
| `timeout` | 预算耗尽 | `partial=true` + `completed{files,bytes,elapsedMs}` + `budget` |

### 5.2 条目状态

| status | 触发 | 计数 |
|---|---|---|
| `ok` | 正常文件 | 计入文件集 |
| `skipped-link` | 符号链接/junction，默认不跟随 | 不计入文件集，计入 `skippedLinks` |
| `permission-denied` | `EACCES`/`EPERM` | 不计入文件集，计入 `degraded` |
| `busy-file` | `EBUSY`/`ETXTBSY` 等占用 | 不计入文件集，计入 `degraded` |
| `source-changed` | 读前后 `stat` 不一致 | 不计入文件集，计入 `degraded` |
| `streamed` | 大文件流式哈希 | 计入文件集（正常） |

### 5.3 错误码

| 错误码 | 触发 | 处理 |
|---|---|---|
| `NO_NODE_PACKAGE` | 有限深度内无 `package.json` | 明确报错；brief 保留 connected-only 回退 |
| `AMBIGUOUS_SOURCE_ROOTS` | 多候选且要求单根 / `onAmbiguity='error'` | 列出候选，拒绝 |
| `SOURCE_ROOT_OUTSIDE_GIT_ROOT` | sourceRoot 越出 Git 根 | 拒绝 |
| `PM_ROOT_WITHOUT_PM` | pmRoot 无 `.pm` 目录，或非 Git 根的 pmRoot 无 PM 任务库 | 拒绝解析，不静默回退；判定范围见 §5.5 |
| `ROOT_ROLE_CONFLICT` | 同一 root 被要求扮演不同角色 | 拒绝，要求显式声明 |
| `LINK_ESCAPE` | `followLinks=true` 时链接越界 | 拒绝/降级 |
| `SCAN_BUDGET_EXCEEDED` | 超过 `timeoutMs`/`maxFiles` | 返回 `timeout` + 部分 |
| `CONFIG_INVALID` | 非法 glob、未知字段、路径穿越 | 拒绝，不静默忽略 |

### 5.4 `files=0` 约束

- `status='ok'` 时文件数必须 > 0（`sourceRoots` 为空是 error）。
- `files=0` 只能出现在 `timeout`/`degraded`/`error` 且带明确原因，禁止冒充正常。

### 5.5 实现现状与已知偏差（诚实标注）

- **`PM_ROOT_WITHOUT_PM` 判定范围**：T-179（2026-11-27）补齐 T-108 的 G3：除要求 `pmRoot/.pm` 目录存在，非 Git 根的显式 PM 根还必须提供 `.pm/tasks.json`，且其中 `tasks` 为数组；缺失或不是数组时拒绝为 `PM_ROOT_WITHOUT_PM`，JSON 损坏时报 `CONFIG_INVALID`。合法空任务数组仍可使用，不要求复制仓库根配置；默认 `pmRoot=gitRoot` 的行为保持不变。这样仅含 `.gitignore` / `.runtime/` 的 `server/.pm` 不会冒充权威 PM 根并静默丢弃原 `scan_ignore`。历史 T-108 证据保留原始观测，回归见 `test/unit/project-scan.test.ts` 与 `test/redteam/project-scan-boundary.test.ts`。
- **`cache.rebuild`**：`ProjectScanOptions.cache.rebuild` 已声明，但 `brief`/`explore` 的 `scan` 透传不消费它；强制重建走 `rebuild graph` / `GraphStore.open({ rebuild:true })`。
- **排除谓词基准**：`excludes()` 同时按相对 `gitRoot` 与相对各 `sourceRoot` 的 POSIX 路径匹配，命中任一基准即排除；秘密路径在任意基准下命中即恒排除。

## 6. 常见失败排查

| 现象 | 可能原因 | 处理 |
|---|---|---|
| `No package.json at <root>` | 根无 package.json 且未向下发现 | 确认 `maxDiscoverDepth`；检查 `.pm/project.json.scan_ignore` 是否误伤候选目录；显式 `sourceRoots` |
| `PM tasks=0` | 用源码根当 PM 根（如 `root=server`） | 以仓库根调用，或显式 `pmRoot`；确认 `.pm/` 在 Git 根 |
| `graph files=0` | 缓存为空且构建失败/超时，或根选错 | 看 `status` 与 `discovery.selected`；确认 `sourceRoots` 正确、排除集未误伤 |
| 整树指纹失败（符号链接） | 默认 `followLinks` 变更前行为 | 升级到本契约后链接记 `skipped-link`；确认未开启 `followLinks=true` 时越界 |
| `ERR_FS_FILE_TOO_LARGE` | 大文件整读 | 确认 `maxFileBytes` 生效、走流式哈希；模型权重应在排除集 |
| `EBUSY` / `EACCES` | 浏览器 profile 占用 / 权限 | 预期行为：记 `busy-file`/`permission-denied`，顶层 `degraded`，不抛整树 |
| brief 超过 60 秒 | 全树重建、无缓存 | 用缓存（`cache.reuse='auto'`）；调低 `timeoutMs`；缩小 `sourceRoots`；确认排除集生效 |
| `AMBIGUOUS_SOURCE_ROOTS` | 多包且要求单根 | 显式 `sourceRoots` 或改 `onAmbiguity='nearest-layer'` |
| `scan_ignore` 未生效 | 基准路径或 glob 写法 | 确认声明相对 Git 根；目录用 `dir/**`；确认来源是 `.pm/project.json` |

## 7. 与 `<example-project>` 的对照（只读描述）

> 本节仅描述布局与配置事实，不含业务数据；验收证据见 `docs/evidence/scan-ecommerce-project.md`（T-108）。工具对该项目的任何操作均为只读。

| 事实 | 观测（2026-11-23，只读） | 契约对应 |
|---|---|---|
| 仓库根无 `package.json` | 根目录未找到 `package.json` | `existingProjectRoot` 必须向下发现嵌套包 |
| Node manifest 位置 | `server/package.json`（另有 `client/`、`workbench/`、`scheduler-tool/` 同深度） | 多候选 → 默认取最近层全部候选 |
| 权威 PM 数据 | 仓库根 `.pm`（2026-11-23T18:5x 只读实测 338 任务 / 活跃 54；T-108 10:17Z 同为 338/54，更早 338/56） | `pmRoot = gitRoot`，迁移/接管读仓库根 `.pm` |
| `server/.pm` | 仅 `.gitignore` 与 `.runtime/`，无 `tasks.json` | 源码根的 `.pm` 非主源，不得误用 |
| 既有 `scan_ignore` | `.pm/project.json` 声明 `server/data/**`、`chrome-cdp-profile/**`、`logs/**`、`exports/**`、模型权重、`.pm/**` 等 | 只读复用，优先于默认集；不要求搬目录/删链接 |
| 大模型文件 | `server/data/llm-local/**` 下 `*.safetensors`、`*.gguf`、`*.pt` | 默认排除 + 大文件流式哈希 |
| 浏览器 profile | `chrome-cdp-profile/`、`server/chrome-cdp-profile/` | 默认排除，避免 `EBUSY` 与登录会话采集 |
| 源码包 | `server/`、`client/`、`workbench/`、`scheduler-tool/` | `sourceRoots` 多根扫描 |
| 项目规模 | 全树约 11.5 万文件（含排除项）；非排除源码实测 1354 文件 / 81,383,632 字节（2026-11-23T18:5x，并发漂移） | 预算 + 缓存复用 + 超时降级，避免超过 MCP 60 秒 |

## 8. 实现映射（供并行实现）

| 任务 | 归属文件 | 关键接口 |
|---|---|---|
| T-104 | `src/core/project-scan.ts` | `ProjectScanOptions`、`resolveProjectScan()`、排除合并、glob、状态枚举 |
| T-105 | `src/core/fingerprint.ts` | 链接跳过、流式哈希、`busy-file`/`permission-denied`/`source-changed` |
| T-106 | `src/structure/store.ts`、`fresh.ts`、`src/surface/service.ts`、`mcp.ts` | 统一扫描选项、缓存复用、超时降级、`files=0` 约束 |
| T-107 | `src/surface/service.ts`、`src/ledger/migrate.ts`、`src/connect/takeover.ts` | 嵌套包根、仓库根 `.pm` 绑定、不混用 `server/.pm` |
| T-108 | `docs/evidence/scan-ecommerce-project.*` | 真实项目只读验收 |
| T-109 | `test/redteam/project-scan-boundary.test.ts` | 链接逃逸/秘密/大文件/锁/恶意 glob/根错配/超时 |
| T-110 | `README.md`、`docs/usage.md`、`docs/limitations.md`、`docs/takeover.md`、`docs/adr/ADR-009-project-scan-roots.md`（事实校正）、本文 | 文档收口与最终验收 |

依赖顺序：T-104 →（T-105 ∥ T-107）→ T-106 → T-108 → T-109 → T-110，见 `scripts/orchestration/m13-plan.json`。
