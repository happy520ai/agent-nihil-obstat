# Phase 7 Readiness 阶段报告

> 所有权：本阶段只修改 `src/readiness/**`（`baseline.ts` 归 P5，未改）、
> `test/redteam/readiness-evidence.test.ts`、`test/integration/readiness.test.ts`、
> `test/redteam/readiness-full.test.ts`、`test/fixtures/readiness/support.ts`（共享 fixture，
> 必须随新语义更新）、`docs/phase-7-report.md`。
> 未修改 `src/ledger`、`src/structure`、`src/gate`、`src/surface`、`src/audit`、`src/memory`。

## 1. 结论

P7 框架已实现并完成一轮安全加固：Profile / Requirement / Evidence / Attestation /
ReleaseVerdict 数据模型、严格 TOML profile、文件证据适配器、TTY 人工批准、三类裁决
和本地通用/A/C 检查器。

本轮修复的五个问题：

1. **本地静态声明不再冒充 machine。** `checks.ts` 产生的记录标记为
   `origin = "local_check"`，加载器按来源命名空间 `ano://readiness/checks/` 或该标记
   一律归为 `declaration`。`ReleaseVerdict` 的 `status` 可以是 `declaration`，但 `gap`
   仍是 `machine_missing` / `attested_missing`，裁决绝不因此升级。
2. **过期时间只能缩短。** 生效期 = `min(record.expires_at, timestamp + record.freshness_days,
   timestamp + requirement.freshness_days)`。记录不能自报更长有效期；requirement 没有
   freshness 窗口（0）时，记录必须自带正 `freshness_days`，否则 `no_freshness` 失败关闭。
   attestation 同样被 requirement 窗口封顶。`validated` 不再接受调用方内存 Map，只接受
   独立目录里的外部验证文件，且项目不能自证。
3. **批准/签字不可无 streams 完成，attestation 需要账本来源。**
   `approveRelease` / `signAttestation` 的 `streams` 变为必填，没有 ambient `process`
   回退；测试只能用 `src/readiness/test-seams.ts` 的显式 seam，而该模块刻意不从
   `index.ts` 导出。`collectFileAttestations` 默认拒绝一切无来源证明的 JSON：必须注入
   `AttestationProvenanceSource`，确认真实的 `readiness.attestation` 账本事件且
   `attestationRef` 与磁盘记录哈希一致。这是证明格式，不是密码学抗抵赖。
4. **profile 资源可打包。** `defaultProfilesDirectory()` 只取模块相邻的
   `./profiles/`（源码 `src/readiness/profiles`，构建后 `dist/readiness/profiles`），
   不再探测 `process.cwd()` 或 `../../src`，因此安装后的工具不会误读宿主项目的源码。
   构建复制由主控负责（见第 7 节）。
5. **红队覆盖补齐。** 机器伪装、自报过期、静态声明升级、无 streams、来源证明缺失/
   不匹配、项目自证均有自动化测试。

**没有任何 profile 是 `validated`。** A–I 全部为 `defined`，包括 A（库）和 C（服务）。
原因是尚未在真实外部项目上跑完整流程（架构 G7 未解决），而本项目不能自证 profile。

## 2. 实现

### 2.1 数据模型与 profile

- `src/readiness/types.ts`：Profile、Requirement、EvidenceRecord、AttestationRecord、
  ReleaseVerdict、ReleaseApproval 及严格 zod schema。新增
  `EvidenceOrigin = external | local_check`、`ValidatedEvidence.classification = machine | declaration`、
  `EvidenceLevel` 增加 `declaration`，`summary` 增加 `declaration` 计数。
- `src/readiness/toml.ts`：只支持表、带引号键、字符串、整数、布尔和扁平数组；
  拒绝重复键/表、数组表、浮点数、未加引号的值、未闭合字符串、`__proto__` 等危险键。
- `src/readiness/profile.ts`：
  - 每个 profile 固定 `schema_hash`，加载时重算并比对。
  - `defined` 只是清单。`validated` 必须带 `[validation]`，并由
    `loadReadinessProfiles(dir, { validationDirectory })` 从**独立目录**读取
    `<id>.validation.json`（严格 schema：profile_id、project、validated_at、
    verdict_hash、profile_schema_hash）。旧的 `validationRecords: Map` 参数已删除；
    `loadProfileText` 对任何 `validated` 声明一律失败关闭。validation 目录不能是
    profile 目录本身或其后代。
  - 自证保护：`agent-nihil-obstat`、`Nihil Obstat`、`ANO` 等项目名不能作为验证项目；
    `selfProjectNames` 可追加禁名。
  - 无 freshness 窗口的规则显式化：`freshness_days = 0` 只允许
    `evidence = "machine"`；接受 attestation 的需求必须 ≥ 1，否则加载失败。
- `src/readiness/profiles/common.toml` + `A.toml`–`I.toml`：全部 `status = "defined"`。

### 2.2 文件证据

`src/readiness/evidence.ts` 只读取约定目录顶层的 `*.json`，并校验：

- 严格 schema：未知字段（包括手填的 `status: "machine"`、`machine: true`）直接拒绝。
- `source_id`、`timestamp`、`kind`、`result = "pass"`。
- **machine 证据必须绑定当前 artifact hash**（没有 `requireArtifactBinding: false` 的
  逃生开关），可选绑定 `source_fingerprint`，两者都给时必须都匹配。
- 缺少 hash、旧制品、旧源码、未来时间、失败结果、kind 不在需求白名单、重复 id 都拒绝。
- 原始输出必须是证据目录内的普通文件（拒绝绝对路径、`..`、反斜杠、符号链接和超大文件）；
  重新计算 `raw_artifact_hash`，不匹配即拒绝。
- 过期：`expires_at` 不能延长有效期，见第 1 节公式；`expires_at` 单独存在且没有
  freshness 窗口时 `no_freshness` 失败关闭。
- 分类：`source_id` 以 `ano://readiness/checks/` 开头或 `origin = "local_check"` 的
  记录是 `declaration`，即使它把 `origin` 改成 `external` 或换了来源字符串也一样
  （来源命名空间优先；自报 `local_check` 只会降级，不会升级）。
- 校验后的记录只保留 `rawArtifactDigest` 和字节数；原始输出内容不进入 evidence record。

### 2.3 Attestation

- 严格记录：具名签署人/角色、需求与 scope 列表、release target、artifact hash、签署时间、过期时间、声明文本。
- 过期、旧制品、错误 target、scope 不匹配、未来签署时间、重复/未知需求都拒绝。
- **machine-only 需求永远不能被 attestation 满足**；伪装以 `machine_requirement` 拒绝，
  裁决变 `blocked`。
- **来源证明（默认拒绝）**：`collectFileAttestations` 需要注入
  `AttestationProvenanceSource.lookup(record)`，返回 `readiness.attestation` 账本事件
  （`kind`、26 位 ULID `eventId`、`actor`、`recordedAt`、`attestationRef`）。
  没有来源 → `provenance_missing`；哈希不匹配 → `provenance_mismatch`；事件类型错误、
  时间非法/晚于签署/在未来 → `provenance_invalid`；查询异常 → `provenance_unavailable`。
  任意目录里的 JSON 因此不再是“签字”。
- 有效期：`min(record.expires_at, signed_at + requirement.freshness_days)`。
- `signAttestation` 是 TTY-only 函数，`streams` 必填，非 TTY 在提示前拒绝。
  MCP/Surface 未接线，agent 没有入口。
- 当前没有密码学签名：attestation 是证明格式，真实性依赖账本事件和访问控制；
  这是明确限制，不能当作身份认证或抗抵赖。

### 2.4 Release verdict

`src/readiness/release.ts`：

- 每个需求状态为 `machine | attested | declaration | missing`，并记录 `gap`。
- `ready`：无 missing，机器证据绑定当前制品，attestation 未过期。
- `conditional`：没有阻断项，仅存在 attestation 缺口或过期。
- `blocked`：机器证据缺失/不可用/伪造、attestation 不可用、或证据与当前制品不一致。
- **declaration 永不升级**：本地检查结果只以 `status = "declaration"` 出现，
  对应 `gap` 仍是 `machine_missing` 或 `attested_missing`，裁决与“没有证据”一致。
- `perProfile` 和总裁决都按最弱项计算；`summary` 分开统计
  machine/attested/declaration/missing，不汇总成单一“通过”。
- `verdictHash` 覆盖裁决内容；caveats 明确“本地检查只是声明”“attestation 依赖账本
  来源且不是密码学抗抵赖”“未验证 profile”“本地检查不代表生产行为”等说明。

### 2.5 人工放行

`src/readiness/approve.ts`：

- `approveRelease` 只接受 `ready` 裁决，要求**显式传入** stdin/stdout 都是 TTY 的
  streams、具名 approver、`APPROVE <target>` 精确确认。没有 streams 直接
  `TTY_REQUIRED`，不提示、不生成记录；不存在 `process` 隐式回退。
- `src/readiness/tty.ts` 的 `assertInteractiveTty` 同样要求显式 streams。
- `src/readiness/test-seams.ts` 是显式 test-only seam（`testOnlyInteractiveStreams()`），
  刻意不从 `index.ts` 导出，生产 surface 无法通过模块 API 取得。
- 批准记录绑定 target、制品哈希、verdict 哈希；任一变化或记录被篡改，`checkApproval` 判定失效。
- 该函数未接入 CLI、MCP 或七个 agent 工具；`src/surface` 不在本阶段所有权内。
- 限制：这是证明格式，不是密码学抗抵赖。拥有进程内代码执行能力的调用方总能伪造对象；
  模块保证的是产品代码不会提供 ambient TTY 或 seam，且任意目录 JSON 不能当签字使用。

### 2.6 本地检查器

`src/readiness/checks.ts` 只做可复算的本地检查：

- 通用：制品与 git 历史的有限密钥模式扫描、`docs/limitations.md` 存在且被 README 引用、
  package 版本出现在 CHANGELOG。
- Profile A：tarball allowlist、类型/导出文件存在、API diff 与 major 版本一致性。
- Profile C：health/ready 端点声明、timeout/rate-limit/circuit-breaker 配置、
  env 是否引用托管 secret。
- 无本地实现或缺少配置时返回 skipped，对应需求保持 missing；检查执行异常时 fail closed。
- `writeCheckEvidence` 仍写文件供定义/评估和审计，但记录 `origin = "local_check"`，
  加载器分类为 `declaration`；**不代表部署、监控或生产行为**。

## 3. 红队覆盖（已自动测试）

`test/redteam/readiness-full.test.ts` 与 `test/redteam/readiness-evidence.test.ts` 覆盖：

- 手填 `status: "machine"`、`machine: true` 被拒。
- attestation 伪装 machine 被拒；machine-only 需求出现 attestation 时裁决 blocked。
- **静态声明升级**：`writeCheckEvidence` 输出全部是 `declaration`；改 `origin`/来源字符串
  都不能变成 machine；只有声明的机器需求 gap 仍为 `machine_missing`，裁决 blocked。
- **自报过期**：`expires_at` 远未来被 requirement/record freshness 截断；超过窗口的记录
  判 `expired`；无 freshness 窗口且只有 `expires_at` 判 `no_freshness`；attestation
  逾窗同样 `expired`。
- **无 streams**：不传 streams 的 approve/sign 直接 `TTY_REQUIRED` 且不触发确认；
  非 TTY 流被拒；`testOnlyInteractiveStreams` 不在 `index.ts` 导出面。
- **来源证明缺失/错误**：无 provenance → `provenance_missing`；哈希不符 →
  `provenance_mismatch`；事件类型/时间错误 → `provenance_invalid`；查询异常 →
  `provenance_unavailable`；缺口裁决为 `attestation_invalid` 且 blocked。
- 旧制品、旧源码被拒；缺 artifact hash、缺 raw hash、raw 文件缺失、raw hash 不符被拒。
- 原始路径穿越、重复 evidence id 被拒。
- 放行后制品/裁决变化使批准失效；批准记录篡改被拒。
- 植入假密钥的 tarball 被真实本地检查判失败，最终裁决 `blocked`。
- 没有验证记录却声明 `validated`、项目自证 `validated`、内存伪造 `validationRecords`、
  把 validation 目录指向 profile bundle 本身，全部被拒。
- profile 资源定位：在 cwd 放置伪造 `src/readiness/profiles` 的子进程中，
  `defaultProfilesDirectory()` 仍指向模块目录并成功加载 9 个 profile。

## 4. 真实命令与结果

开工基线（修改前）：

```text
npm run typecheck
> tsc -p tsconfig.json --noEmit
(通过，无输出)

node --test test/integration/readiness.test.ts test/redteam/readiness-full.test.ts
ℹ tests 14
ℹ pass 14
ℹ fail 0
```

修改后：

```text
npm run typecheck
> tsc -p tsconfig.json --noEmit
(通过，无输出)

node --test test/integration/readiness.test.ts test/redteam/readiness-full.test.ts test/redteam/readiness-evidence.test.ts
ℹ tests 23
ℹ pass 23
ℹ fail 0
ℹ skipped 0
ℹ duration_ms 1462.5203
```

测试全部使用 `os.tmpdir()` 合成项目；未运行全量套件（其他模块由并发智能体维护）。

## 5. 未完成 / 限制

- **A、C 未 validated**。没有任何真实库或服务项目完成端到端验证；没有真实裁决记录。
  其余 B、D–I 也没有真实项目验证。
- **没有账本集成**。`src/ledger` 的 kind 枚举没有 `readiness.attestation`，不在本阶段
  所有权内。当前通过 `AttestationProvenanceSource` 注入点对接；主控在接入 `src/ledger`
  时必须实现“按 attestation 记录哈希查找 `readiness.attestation` 事件”，默认不注入即拒绝。
- **没有 CLI/MCP 接线**。TTY 保护是函数级实现，不是完整产品入口；`src/surface` 未改，
  且既有 surface 明确不提供 approve/attest 工具。
- **profile 资源复制未在构建中实现**。代码只从模块相邻目录读取；`tsc` 不复制 `.toml`。
  主控需在构建/打包阶段把 `src/readiness/profiles/*.toml` 复制到
  `dist/readiness/profiles/`，并增加打包冒烟测试（见第 7 节）。
- **attestation/approval 无密码学签名**。靠具名、TTY、artifact/verdict hash 绑定和
  `readiness.attestation` 账本事件；拥有证据目录写权限的人仍可写文件，只是在没有
  账本事件时不会被接受。生产使用前必须把批准/签字追加进受控账本。
- **证据只来自文件**。不直连 CI、部署、监控、压测或云平台；适配器拿不到就是
  missing/attested/declaration，不会假装 machine。完全伪造的“外部来源”记录仍受
  文件 provider 严格校验约束（artifact 绑定、raw hash、有效期），但文件 provider
  本身无法证明记录真的来自外部系统；这是已知信任边界。
- **密钥扫描有限**：固定模式，不含通用熵/凭据提供商扫描；git 历史通过
  `git log -p --all` 且有 16 MiB 上限，非 git 仓库失败关闭。
- **本地检查是静态/合成的**。它不证明安装冒烟、可复现构建、部署、回滚、监控或容量声明。
- Verdict 永远不表示“安全”或“可放心运营”。

## 6. 升 validated 的必要条件

对每个 profile：

1. 选一个真实外部项目（不能是 ANO 自身）。
2. 用真实制品运行完整 release 流程，保留被拒绝证据和缺口。
3. 生成真实 verdict，记录项目名、日期、profile schema hash 和 verdict hash。
4. 把验证记录写成**独立目录**中的 `<profile>.validation.json`（不是 profile bundle）。
5. 用 `loadReadinessProfiles(dir, { validationDirectory })` 加载并通过
   hash/日期/自证检查后，才允许把状态升为 `validated`。

在此之前，所有文档和接口都只能称 A–I 为 `defined`。

## 7. 给主控的接口与构建建议

- **资源路径契约**：`defaultProfilesDirectory()` 返回 `dist/readiness/profiles/`
  （源码运行时为 `src/readiness/profiles/`）。不再有 cwd / `../../src` 回退。
- **构建复制**：在 `npm run build`（或 prepack）中增加一步，把
  `src/readiness/profiles/*.toml` 复制到 `dist/readiness/profiles/`；
  `package.json` 的 `files` 已包含 `dist`，复制后即进入发布包。
- **打包测试建议**：`npm pack` 后在临时目录安装，以无 `src/` 的安装目录为 cwd，
  调用公开入口加载 profiles（或后续 CLI 的 `ano readiness profiles`），
  断言 9 个 profile 可加载且目录位于 `node_modules` 内。
- **provenance 接线**：主控实现 `AttestationProvenanceSource`，从只追加账本读取
  `readiness.attestation` 事件；payload 至少包含 attestation 记录的规范哈希。
  未注入该来源时所有 attestation 按 `provenance_missing` 拒绝（当前默认行为）。
- **批准入口**：`approveRelease` / `signAttestation` 必须由真实 CLI TTY 传入
  `process.stdin/stdout`；不要从 MCP 工具或 agent surface 接线，也不要导出
  `src/readiness/test-seams.ts`。
