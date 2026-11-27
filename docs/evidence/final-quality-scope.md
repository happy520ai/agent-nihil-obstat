# M18 最终质量基线与停止扩展契约（T-150 / QF-01 冻结版）

生成时间：2026-11-25 ｜ 环境：Windows 10.0.19041 x64，Node v24.14.0，Git Bash ｜ 机器可读版：`docs/evidence/m18-quality-baseline.json`
原始产物：`docs/evidence/m18-coverage-raw.txt`（spec 全文）、`docs/evidence/m18-coverage-tap.txt`（原生 TAP coverage report）

## T-153 复核勘误（历史基线不等于当前验收）

以下正文保留 T-150 当时的实测历史，不代表 T-151～T-156 已验收。后续复核发现并纠正：

- 文本 coverage 树的路径层级解析错误，将 `structure/fresh.ts` 等误挂到 `structure/extractors/`，将 `surface/service.ts` 等误挂到 `surface/connect-ui/`；**不是源码迁移**。旧 JSON 的文件路径、按文件排序及路径相关结论不可作为当前分派依据。原始 spec/TAP 全文仍保留，all-files 当时实测百分比未改写。
- Node 的 `test:coverage` 事件可以导出原始分子分母。`scripts/m18-coverage-reporter.mjs` 直接保存该事件，不从文本反推计数；后续报告还记录源码/测试前后哈希和原生测试摘要。
- T-153 中间原生全仓运行（`.pm/m18-t153-baseline-native.json`）exit 0，1743 tests / 1742 pass / 0 fail / 1 已说明环境 skip；行 **74281/77610（95.71%）**、分支 **16700/19669（84.91%）**、函数 **4174/4373（95.45%）**。该报告在后续补测和源码清理前生成，不是最终验收报告。
- `include=src/**/*.ts` 不会自动载入未导入模块。上述运行包含 162 文件，而磁盘有 166 个 `.ts`；遗漏 `src/index.ts`、`src/memory/index.ts`、`src/memory/types.ts`、`src/readiness/test-seams.ts`。已补公开导出身份、纯类型模块无运行时导出及测试 seam 不泄露的行为测试；最终运行必须重新核对磁盘全集，不得沿用 162 文件作为“全仓”证明。
- T-151 四模块当前 scoped 158/158 回归与 typecheck 通过，原生计数均 100/100/100：tcp-frame-codec L306/306 B39/39 F13/13；probe-merge L603/603 B156/156 F41/41；leader-state L153/153 B58/58 F12/12；logical-clock L369/369 B74/74 F22/22。Zod 空 issues 兜底由当前实现的不变量证明后清理；同 `(from,to,kind)` 去重后的 provenance 排序项冗余，已等价清理。无 mock 不可能状态、无 exclude/ignore。
- `distributed-probe.ts` 后置取消检查不能因“中间无 await”判不可达：外部 `ProbeStore` 同步回调能触发标准 `AbortController.abort()`。该防御保留，并用真实回调补测。

安全域、完整分母、全仓 97/88/97、变异与连续稳定矩阵仍待各自最终证据闭合；上述中间结果不得替代最终关单。

## 0. 结论（T-150 历史冻结值）

1. **权威基线已实测**：`npm run coverage` exit 0，1649 tests / 1648 pass / 0 fail / **1 skipped**，全仓 `include=src/**/*.ts` 无排除下为 **行 95.63% / 分支 84.53% / 函数 95.36%**，距 M18 全仓目标 **97 / 88 / 97** 分别差 **1.37 / 3.47 / 1.64 pp**（估算需再覆盖约 **1065 行**）。
2. **四纯模块未达 100%**：`tcp-frame-codec` 100/97.44/100、`probe-merge` 100/87.31/97.56、`leader-state` 100/96.23/100、`logical-clock` 96.22/91.80/90.91。缺口清单见第 1 节。
3. **安全关键分支**已按 8 个域逐项枚举（quorum / epoch / fencing / scope / 伪造证据 / 未提交与历史证据 / 秘密路径 / 认证授权），行号与现有测试见第 2 节；实测仍有确定缺口（如 `cluster-consistency.ts:397-398,401,413-414`、`multi-writer.ts:759-760,618-632`、`ha-protocol.ts:626-627,585-593,552-553`、`tcp-transport.ts:785-787,889`）。
4. **范围不可缩小**：全仓 162 个被统计源文件中 **105 个低于 97/88/97 中至少一项**（其中多数卡在分支 88）；剩余文件按补齐价值排序见第 3 节。
5. **反凑数红线**：不新增 exclude、不加 ignore、不移分支、不新增 skip/todo/only；不可达/环境边界逐项给证据（第 5 节）。
6. **M17 两处不实结论已纠正**：F-1 是基线误报（非真实缺陷）；“TCP 剩余 9 处行号缺失”由本轮实测 44 行 / 12 区间取代（第 9 节）。

### 0.1 权威运行与结构化交叉核对

| 项目 | 值 |
|---|---|
| 权威命令 | `npm run coverage`（等价 `node --test --experimental-test-coverage --test-coverage-lines=90 --test-coverage-branches=80 --test-coverage-include=src/**/*.ts "test/**/*.test.ts"`） |
| exit / 耗时 | 0 / 69s |
| 测试 | 1649 tests，1648 pass，0 fail，0 cancelled，1 skipped，0 todo，duration_ms 57600.1193 |
| 全仓 all files | **行 95.63 / 分支 84.53 / 函数 95.36** |
| 结构化交叉命令 | 同统计范围 + `--test-reporter=tap`（原生 TAP coverage report），exit 0 / 65s |
| 交叉全仓 | 行 95.62 / 分支 84.53 / 函数 95.36 |
| 运行间抖动 | 13 个文件行或分支百分比在两次运行间变化（逐指标绝对差最大 3.77pp，位于 `surface/connect-ui/tool-catalog.ts` 分支项）：`findings.ts`、`governance.ts`、`takeover.ts`、`lock.ts`、`anchor.ts`、`distributed-probe.ts`、`ha-protocol.ts`、`multi-writer.ts`、`probe-merge.ts`、`replication.ts`、`barrel.ts`、`cli.ts`、`tool-catalog.ts` |

> 口径：`--test-coverage-include=src/**/*.ts` 的 `all files` 是唯一验收分母；不带 include 会把 test/scripts 计入（68.29/80.56/65.00），**不得作口径**。本命令未使用 `--test-coverage-exclude`，`src/` 未加任何 ignore 注释，统计范围未被修改。
>
> 分母说明：Node 文本/TAP 报告只给百分比与未覆盖行，不给分支/函数的原始分子分母。本文所有“100%”目标均以“枚举分支集合内全部命中”表述；**四模块与安全域的原始分支分母由 T-151/T-152 在各自矩阵中发布后再复核**，本文件不字面声称已 100%。

---

## 1. 四纯模块缺口（行/分支/函数 → 100/100/100）

实测（spec  authoritative）：

| 模块 | 行% | 分支% | 函数% | 行缺口 | 分支缺口 | 函数缺口 | 实测未覆盖行 |
|---|---|---|---|---|---|---|---|
| `src/memory/tcp-frame-codec.ts` | 100.00 | 97.44 | 100.00 | 0 | 2.56 | 0 | — |
| `src/memory/probe-merge.ts` | 100.00 | 87.31 | 97.56 | 0 | 12.69 | 2.44 | — |
| `src/memory/leader-state.ts` | 100.00 | 96.23 | 100.00 | 0 | 3.77 | 0 | — |
| `src/memory/logical-clock.ts` | 96.22 | 91.80 | 90.91 | 3.78 | 8.20 | 9.09 | 132-133, 138-139, 171-172, 179-180, 191-192, 195-196, 277-278 |

### 1.1 logical-clock（唯一三指标均有缺口）

| ID | 位置 | 语义 | 现有测试 | 缺口 / 预期反例 |
|---|---|---|---|---|
| LC-L1 | `logical-clock.ts:132-133` | `parseRemoteSnapshot` 拒绝 null/非对象/数组 | `test/unit/logical-clock.test.ts:356-364` 只测 `physical=Infinity` | 补 `observe(null)` / `observe([])` / `observe(42)`，断言 `HA_INPUT_INVALID` |
| LC-L2 | `logical-clock.ts:138-139` | `remote.nodeId` 非字符串/空串拒绝 | 无 | 补 nodeId 缺失、空串、非字符串反例 |
| LC-L3 | `logical-clock.ts:171-172` | 构造参数 options 为 null/非对象/数组拒绝 | 未覆盖 | 补 `new LogicalClockService(null as never)` 等反例 |
| LC-L4 | `logical-clock.ts:179-180` | `epoch < 0` 拒绝 | 未覆盖 | 补 `epoch=-1`，断言 `HA_INPUT_INVALID` |
| LC-L5 | `logical-clock.ts:191-192,195-196` | `nodeId` / `epoch` getter | 现有用例只读 `policy`/`snapshot` | 补 getter 读取并与构造值断言一致 |
| LC-L6 | `logical-clock.ts:277-278` | `#incrementLogical` 达 `MAX_SAFE_INTEGER` 抛错 | 无 | 注入样本使 logical 逼近上限；若证明不可达则登记防御分支并给不变量证明 |

补充：`tick()`（物理前进/回退/相等）与 `observe()`（四分支）以及 `diagnose/diagnostics` 副本语义，需在逐分支矩阵中确认全部方向命中；行 100% 后仍有 8.20pp 分支缺口，说明缺口在已执行行的条件方向上。

### 1.2 tcp-frame-codec（仅分支缺口）

行/函数 100%，分支 97.44%。候选未命中分支（均为条件方向，非未执行行）：

| ID | 位置 | 语义 | 现有测试 | 缺口 / 预期反例 |
|---|---|---|---|---|
| TFBC-B1 | `tcp-frame-codec.ts:176-177` | `invalid(messageText, cause?)` 的 `cause` 缺省 / 提供两分支 | `test/unit/tcp-frame-codec.test.ts` 全部经 `parseTcp*Payload`，不传 cause | 补带 cause 的解析失败，断言 cause 透传 |
| TFBC-B2 | `tcp-frame-codec.ts:185` | `parsePayload` 中 `issue===undefined` 回退文案 | 同上 | 证明该回退不会吞掉真实 schema 违规（safeParse 失败/成功边界） |
| TFBC-B3 | `tcp-frame-codec.ts:297` | decoder envelope 失败时 `issue===undefined` 回退 | `tcp-frame-codec.test.ts:154-177` | 覆盖 union 解析失败且 issues 为空，或登记防御并给调用方证据 |

### 1.3 leader-state（仅分支缺口）

行/函数 100%，分支 96.23%。候选：`parseOrThrow` 的 `issue===undefined`（35-39）、`positiveInt` 缺省/拒绝（44-49）、`validateTopology` 五个校验与 catch 的 `instanceof HaProtocolError` 两侧（62-83）、`validateVoters` 六分支（86-114）、`compareDeclarations/compareCommitRecords` 的等值 tie（121-128）。现有测试：`test/unit/leader-lease.test.ts:325-347,563-630`。**96.23% 表明至少一个方向缺失**，需以分母矩阵定位；安全相关为 `assertSingleLeader`（SPLIT_BRAIN）与拓扑校验。

### 1.4 probe-merge（分支 87.31 / 函数 97.56，最大相对缺口）

行 100%，但 12.69pp 分支缺口，分布在：

| ID | 位置 | 语义 |
|---|---|---|
| PM-B1 | `probe-merge.ts:169-175` | gather 去重 existing 命中 + sources 含/不含当前 source |
| PM-B2 | `probe-merge.ts:191-201` | byPair 指纹聚合 existing 两分支 |
| PM-B3 | `probe-merge.ts:216-249` | content_hash 冲突与 status 冲突两个独立判定 |
| PM-B4 | `probe-merge.ts:269-297` | commitConflicts 的 commit 分歧 / epoch 分歧 |
| PM-B5 | `probe-merge.ts:306-314` | dedupeEdges 跳过与四段排序 tie-break |
| PM-B6 | `probe-merge.ts:323,558` | `fact_key===null` 条件展开两分支 |
| PM-B7 | `probe-merge.ts:329-334` | matchesEntryQuery 四字段正反向 |
| PM-B8 | `probe-merge.ts:341-345` | consistencyFromResponse 四分支 |
| PM-B9 | `probe-merge.ts:378-438` | assembleAnswer 的 requested===0、partialFlag 六 OR、outcome 四联三元、三个可选展开 |
| PM-B10 | `probe-merge.ts:440-496` | nodeReports NOT_QUERIED / OK / failed 与 usedIds |
| PM-B11 | `probe-merge.ts:497-527` | cancelledResponse 的 `snapshot ?? fallback`、`required ?? []`、requirements_origin 三元 |
| PM-B12 | `probe-merge.ts:533-566` | safeFingerprints 首插；digestOrEmpty 的 try/catch 回退 |
| PM-B13 | `probe-merge.ts:573-604` | injectDistributedConflicts 全分支（安全关键：SUFFICIENT 不得在有未解决冲突时保留） |

现有测试：`test/unit/distributed-probe.test.ts`（399-528、703-737、846-878 等）。函数 97.56% 表示至少一个函数/回调从未执行，T-151 需用 coverage 输出定位具体名称后补测或证明为不可达回调。

---

## 2. 安全关键分支清单（代码级枚举，含现有测试与缺口）

> 口径：下表是**枚举范围**，不是已完成声明。每个域内的分支必须 100%（正反向均验证），并由 T-152 发布逐分支原始分母。`coverage` 列为该文件当前实测行/分支/函数。

### 2.1 quorum（多数派）

| 位置 | 分支语义 | 现有测试 | 缺口 / 预期反例 |
|---|---|---|---|
| `ha-protocol.ts:519-528` | `quorumSize=floor(N/2)+1` | `unit/ha-protocol.test.ts:131-160` | 已覆盖 N=1..5 |
| `ha-protocol.ts:548-566` | `isQuorum` 多数通过/少数拒绝；`assertQuorum` 抛 `QUORUM_NOT_REACHED` | 同上 | 未覆盖行 552-553（votes 越界输入）需补 `QUORUM_INPUT_INVALID` |
| `ha-protocol.ts:575-598` | `evaluatePartitions` 分区数组合法性、2-2 无提交派、commit/block 分类 | `ha-protocol.test.ts:143-160` | 未覆盖 585-586（partitionSizes 非数组）、592-593（尺寸非法）需补 |
| `distributed-probe.ts:920,1039-1082` | QUORUM 分组与 `>=ceil((N+1)/2)` 采纳；不足额显式降级 | `unit/distributed-probe.test.ts:567-590,455-497,1058-1075` | 补“恰好等于阈值”“多组同 commit 不同 digest”“best.commitIndex<primary” |
| `cluster-consistency.ts:395-414` | mode 校验、primary 未知、size 非法、count<size、digests 空/多值、commit>primary | `unit/cluster-consistency.test.ts:385-496` | **实测未覆盖 397-398、401、413-414（安全不变量，必须补）** |
| `leader-lease.ts:660-780` | 续约需心跳多数派；低于多数退位 | `unit/leader-lease.test.ts:419-465,772-785` | 行 100%，分支分母待确认 |
| `ha-cluster.ts:1270-1335` | propose 投票不足 `QUORUM_NOT_REACHED`；proposer 自加一票 | `integration/ha-split-brain.test.ts`、`redteam/ha-split-brain-boundary.test.ts` | 分支分母待确认 |

### 2.2 epoch（纪元单调）

| 位置 | 分支语义 | 现有测试 | 缺口 |
|---|---|---|---|
| `leader-lease.ts:623-629` | 候选 epoch 回退拒绝；term 回退拒绝 | `leader-lease.test.ts:285-323,678-705` | 已覆盖 |
| `multi-writer.ts:754-767` | leader 非空 evaluateFence；leader 空且 epoch<maxEpoch 抛 `FENCE_EPOCH_ROLLBACK` | `unit/multi-writer.test.ts:323-353` | **实测未覆盖 759-760，必须补 epoch 回滚反例** |
| `distributed-probe.ts:516-526,563-574` | 握手 epoch 不匹配；响应 epoch 覆盖后再校验 | `redteam/distributed-probe-boundary.test.ts` 等 | 已覆盖双向 |
| `probe-merge.ts:283-297` | epoch 分歧生成未解决冲突 | `distributed-probe.test.ts:458-476` | 补多 epoch 混合与单 epoch 对照 |
| `ha-cluster.ts:1256-1264` | write epoch/term 超前持租约拒绝 | `ha-split-brain-boundary.test.ts` | 未覆盖 1243-1244 与 1257-1264 方向需补 |

### 2.3 fencing（任期防旧主）

| 位置 | 分支语义 | 现有测试 | 缺口 |
|---|---|---|---|
| `ha-protocol.ts:620-640` | `evaluateFence`：非法租约 `FENCE_INVALID`；未知 epoch `FENCE_UNKNOWN_EPOCH`；stale term/epoch 拒绝 | `ha-protocol.test.ts:181-220` | **未覆盖 626-627（knownEpochs 不含 candidate epoch），补反例** |
| `leader-lease.ts:620-646` | handleVoteRequest 五分支 | `leader-lease.test.ts:678-705,285-323` | 分支分母待确认 |
| `leader-state.ts:121-151` | `compareDeclarations` 排序键、`assertSingleLeader` SPLIT_BRAIN | `leader-lease.test.ts:325-347`；`ha-protocol.test.ts:194-235` | tie 分支需补（LS-B5） |
| `multi-writer.ts:614-640,765-767` | adjudicate 四校验；#advanceFence 仅在 allowed 时替换 | `multi-writer.test.ts:295-353` | **实测未覆盖 618-619、623-624、627-628、631-632，全部为安全反例** |
| `ha-cluster.ts:1248,1256-1264,1397-1409` | 无租约不得 propose；超前拒绝；同 (epoch,term) 对手拒绝 | `ha-split-brain-boundary.test.ts` | 未覆盖 1243-1244、1405-1406 需补 |

### 2.4 scope / 跨项目访问

| 位置 | 分支语义 | 现有测试 | 缺口 |
|---|---|---|---|
| `distributed-probe.ts:507-515` | scope 路由先于查询；外来 scope 直接 `SCOPE_DENIED` 且不查询 | `distributed-probe.test.ts:678-702` | 补 snapshot.cluster 与 snapshot.project_scope 两个 fallback 来源 |
| `probe-manifest.ts:552-574,776-783` | freeze/read 的 scope 绑定与 `cross_scope` 返回 | `unit/probe-manifest.test.ts:478-575` | **实测未覆盖 771-772、774-775，补读路径反例** |
| `context-verify.ts:557-572` | draft scope 与 manifest 不符、重采样 snapshot scope 不符 | `unit/context-verify.test.ts:204-216,351-379` | 行 98.79；458-459、491-492 需归因补齐 |
| `consumer.ts:804-817` | active manifest scope 与 snapshot scope 必须一致 | `unit/memory-consumer.test.ts` | **实测 804-817 整段未覆盖，跨 scope 消费路径缺口** |
| `cluster-policy.ts:300-360` | authorize 三维矩阵；scope 不在 allowedScopes 拒绝；fail-closed | `unit/cluster-policy.test.ts:143-194` | 319-320、377-378 需核对是否授权分支 |
| `tcp-frame-codec.ts:151,163` | apply/status 的 projectScope 可选有界字段 | `tcp-frame-codec.test.ts` | schema 可选字段两方向需断言 |
| `replica-worker.ts:376-380` | RW-SCOPE-DENIED apply 越权拒绝 | `unit/replica-worker-protocol.test.ts` | 需复核拒绝分支命中（当前未覆盖 238-239 为数组边界） |

### 2.5 伪造证据 / 摘要重算

| 位置 | 分支语义 | 现有测试 | 缺口 |
|---|---|---|---|
| `distributed-probe.ts:606-643` | 摘要必须重算；declared 不符 `VIEW_DIGEST_MISMATCH`；commit_index 未知拒绝；REVOKED/FAILED/SUSPECT/JOINING 不可服务 | `distributed-probe.test.ts:550-566,967-1008` | 主路径已覆盖 |
| `probe-merge.ts:573-604` | 未解决冲突不得让 gate 保持 SUFFICIENT | `distributed-probe.test.ts:500-528` | 逐条补（PM-B13） |
| `ha-protocol.ts:1013-1031` | `gateEvidenceIssue/assertGateBoundary`：committed 必须 evidence_id + produces_gate_evidence；uncommitted/conflicted 不得携带 | `ha-protocol.test.ts:457-484`；`multi-writer.test.ts:354-392` | 四态正反例需补全 |
| `multi-writer.ts:370-390,520-528` | 投影状态结构校验 + `PROJECTION_GATE_FORBIDDEN`；append commitIndex 非负与 status 推导 | `multi-writer.test.ts:354-392,119-150` | **实测 408-409、513-514、524-525 未覆盖** |
| `cluster-consistency.ts:286-287` | answer.metadata.mode/requested_mode 非法时 TypeError fail-fast | `cluster-consistency.test.ts:662-668` | **实测 286-287 未覆盖** |

### 2.6 未提交分支 / 历史证据不得进入当前 Gate

| 位置 | 分支语义 | 现有测试 | 缺口 |
|---|---|---|---|
| `ha-protocol.ts:57-58,1013-1031` | `MWHA_UNCOMMITTED_COMMIT_INDEX=0`；非 committed 状态携带 evidence_id/Gate 证据即拒绝 | `ha-protocol.test.ts:457-484`；`multi-writer.test.ts:354` | 逐状态分母待补 |
| `multi-writer.ts:370-390` | uncommitted/conflicted 必须 evidence_id=null、produces_gate_evidence=false | `multi-writer.test.ts:354-392` | 结构校验 408-409 未覆盖 |
| `cluster-consistency.ts:325-329,354-369` | 非 AS_OF 产出 historical 即 `HISTORICAL_NOT_EXECUTABLE`；currentExecution 拒绝 historical/stale；AS_OF 必须标记 historical | `cluster-consistency.test.ts:285-306,628-660` | **实测 334-335 未覆盖** |
| `distributed-probe.ts:1088-1117` | 取消应答整段：CANCELLED + UNKNOWN，不采纳迟到结果 | `distributed-probe.test.ts:343-398,905-966` | **实测 1088-1117 未覆盖** |
| `gate/verify.ts:221-233`；`gate/evidence.ts:84-86` | 图 freshness：stale/degraded 不得支持完成；证据计数与 skip 语义 | `redteam/verify-hardening.test.ts`、`verify-evidence.test.ts` | **verify.ts 行 100% 但分支 81.15**，逐分支补齐；evidence.ts:84-86 补 |

### 2.7 秘密路径 / 脱敏

| 位置 | 分支语义 | 现有测试 | 缺口 |
|---|---|---|---|
| `core/project-scan.ts:257,320-322` | secret 目录始终排除；include 不得重新纳入；followLinks 不跟随 secret | `redteam/project-scan-boundary.test.ts:353-441,757-804` | 142-143、161-162、212-214 等未覆盖需归因（平台/缓存分支） |
| `clients/redact.ts:37-53` | 白名单复制 + `redacted` 标记；敏感字段名捕获 | client-* 测试 | **实测 39-40 未覆盖（非对象/数组输入分支）** |
| `clients/config.ts` | 配置 secret 字段处理 | `unit/client-config.test.ts` | 130 行未覆盖，全仓最大绝对缺口（见第 3 节） |

### 2.8 认证 / 授权（传输层）

| 位置 | 分支语义 | 现有测试 | 缺口 |
|---|---|---|---|
| `tcp-transport.ts:785-787` | 未握手连接 dispatch 直接 `TCP_AUTH_REQUIRED` | `redteam/tcp-transport-boundary.test.ts` | **实测未覆盖，安全分支必须补** |
| `tcp-transport.ts:881-889` | 无 policy/allow-list 时 fail-closed `REPLICA_NOT_AUTHORIZED` | 同上 | **实测 889 未覆盖，必须补** |
| `ha-cluster.ts:1248-1264,1397-1409` | 只有持租约者可 propose；超前拒绝；同 (epoch,term) 对手拒绝 | `ha-split-brain-boundary.test.ts` | 1243-1244 未覆盖需补 |
| `tcp-frame-codec.ts:123-129` | auth payload 严格 schema | `tcp-frame-codec.test.ts:102-124` | 畸形输入已覆盖，保持正反向 |

---

## 3. 其余文件覆盖缺口（按补齐价值排列，供 T-153 分派）

“补齐价值”= 绝对未覆盖行数 × 安全权重（安全关键文件即使行数少也优先）。全仓 3394 行未覆盖，估算分母 77666 行。前 45 名：

| 排名 | 未覆盖行 | 行% | 分支% | 函数% | 文件 | 分派建议 |
|---|---|---|---|---|---|---|
| 1 | 130 | 90.73 | 77.65 | 100.00 | `src/clients/config.ts` | T-153 高优先（secret 处理，安全权重） |
| 2 | 116 | 88.94 | 79.82 | 86.36 | `src/memory/tcp-fault-proxy.ts` | 故障注入路径 |
| 3 | 111 | 93.26 | 75.79 | 90.00 | `src/clients/doctor.ts` | 诊断分支 |
| 4 | 106 | 90.30 | 86.93 | 87.50 | `src/surface/cli.ts` | CLI 入口分支 |
| 5 | 95 | 92.06 | 66.44 | 94.94 | `src/memory/probe-store-bitchain.ts` | bitchain 读写分支（安全） |
| 6 | 93 | 95.31 | 71.91 | 96.39 | `src/surface/connect-ui/service.ts` | Connect UI |
| 7 | 90 | 92.27 | 81.73 | 97.10 | `src/memory/cluster-policy.ts` | **安全关键：授权/脱敏** |
| 8 | 85 | 89.09 | 73.33 | 86.84 | `src/surface/anchor-probe.ts` | Surface 适配 |
| 9 | 81 | 93.07 | 94.81 | 84.48 | `src/memory/distributed-probe.ts` | **安全关键：scope/quorum/取消** |
| 10 | 80 | 94.27 | 85.42 | 92.59 | `src/structure/extractors/ts.ts` | TS 提取器 |
| 11 | 72 | 91.59 | 73.72 | 86.00 | `src/clients/tongyi-lingma.ts` | 客户端适配 |
| 12 | 69 | 92.43 | 76.07 | 97.78 | `src/clients/codex.ts` | 客户端适配 |
| 13 | 65 | 93.06 | 83.17 | 97.92 | `src/clients/claude-code.ts` | 客户端适配 |
| 14 | 64 | 92.41 | 73.91 | 88.24 | `src/clients/comate.ts` | 客户端适配 |
| 15 | 63 | 92.35 | 80.00 | 89.74 | `src/clients/deepseek-harness.ts` | 客户端适配 |
| 16 | 60 | 92.22 | 67.97 | 94.44 | `src/clients/antigravity.ts` | 客户端适配 |
| 17 | 59 | 93.99 | 86.34 | 92.86 | `src/memory/store.ts` | 存储层 |
| 18 | 58 | 93.32 | 72.67 | 88.24 | `src/clients/amazon-q.ts` | 客户端适配 |
| 19 | 58 | 93.23 | 82.29 | 96.00 | `src/memory/consumer.ts` | **安全：跨 scope 消费 804-817** |
| 20 | 55 | 83.38 | 79.22 | 100.00 | `src/readiness/attestation.ts` | 就绪证明 |
| 21 | 54 | 85.71 | 81.17 | 96.15 | `src/structure/extractors/imports.ts` | imports 提取 |
| 22 | 51 | 93.94 | 71.58 | 97.44 | `src/clients/codebuddy.ts` | 客户端适配 |
| 23 | 50 | 93.12 | 70.67 | 95.12 | `src/clients/openclaw.ts` | 客户端适配 |
| 24 | 48 | 93.47 | 66.92 | 94.74 | `src/clients/zed.ts` | 客户端适配 |
| 25 | 48 | 95.62 | 80.11 | 97.78 | `src/connect/takeover.ts` | Connect takeover |
| 26 | 45 | 93.64 | 71.43 | 97.14 | `src/clients/trae.ts` | 客户端适配 |
| 27 | 45 | 88.13 | 77.23 | 86.67 | `src/surface/connect-ui/http.ts` | HTTP 层 |
| 28 | 45 | 96.13 | 82.59 | 94.83 | `src/surface/connect-ui/memory.ts` | Connect memory |
| 29 | 44 | 96.96 | 90.39 | 97.17 | `src/memory/tcp-transport.ts` | **安全：44 行 12 区间（见第 9 节）** |
| 30 | 43 | 95.46 | 76.79 | 96.15 | `src/clients/kilo-code.ts` | 客户端适配 |
| 31 | 43 | 87.71 | 70.93 | 100.00 | `src/connect/store.ts` | Connect store |
| 32 | 40 | 91.11 | 66.67 | 100.00 | `src/connect/watch.ts` | 监听 |
| 33 | 40 | 92.57 | 72.73 | 97.44 | `src/readiness/checks.ts` | 就绪检查 |
| 34 | 39 | 95.17 | 75.15 | 97.37 | `src/clients/opencode.ts` | 客户端适配 |
| 35 | 39 | 82.27 | 73.33 | 100.00 | `src/readiness/toml.ts` | TOML 解析 |
| 36 | 37 | 95.58 | 75.00 | 97.44 | `src/clients/cursor.ts` | 客户端适配 |
| 37 | 37 | 93.85 | 78.50 | 94.44 | `src/clients/hermes-agent.ts` | 客户端适配 |
| 38 | 36 | 95.67 | 74.86 | 93.48 | `src/clients/cline.ts` | 客户端适配 |
| 39 | 36 | 89.25 | 80.17 | 87.10 | `src/connect/records.ts` | Connect records |
| 40 | 36 | 91.24 | 90.91 | 100.00 | `src/core/fingerprint.ts` | 指纹 |
| 41 | 36 | 96.55 | 82.73 | 92.22 | `src/ledger/ledger.ts` | 账本 |
| 42 | 36 | 96.69 | 89.53 | 98.36 | `src/memory/ha-protocol.ts` | **安全：36 行未覆盖** |
| 43 | 35 | 97.97 | 86.95 | 97.66 | `src/memory/ha-cluster.ts` | **安全：35 行未覆盖** |
| 44 | 34 | 96.26 | 77.72 | 97.62 | `src/clients/github-copilot.ts` | 客户端适配 |
| 45 | 34 | 95.85 | 92.47 | 92.31 | `src/structure/extractor.ts` | 结构抽取 |

**行已 100% 但分支仍 <88 的文件**（分支分母型缺口，需补条件方向而非新行）：`connect/export.ts`(76.92)、`connect/read.ts`(77.78)、`connect/status.ts`(78.57)、`gate/verify.ts`(81.15)、`memory/relation-classifier.ts`(82.18)、`memory/cursor.ts`(83.33)、`core/lock.ts`(84.38)、`surface/connect-ui/readiness.ts`(84.62)、`audit/security.ts`(85.00)、`clients/qoder.ts`(85.85)、`surface/connect-ui/render.ts`(86.75)、`memory/ha-cluster.ts`(86.95)、`memory/probe-merge.ts`(87.31)。

完整 162 文件数据见 `m18-quality-baseline.json` 的 `files` 与 `residualRanking`（含每文件 `uncoveredLines` 原始区间）。

---

## 4. 现有 skip 标记与真正运行 skip 的区分

| 类别 | 数量 | 明细 |
|---|---|---|
| 条件 skip 标记（源码） | 13 | `integration/ledger-store.test.ts:118`（git 不可用）；`redteam/client-adapters-boundary.test.ts:620`、`redteam/project-scan-boundary.test.ts:308,359`、`redteam/takeover-boundary.test.ts:290`、`unit/fingerprint.test.ts:58,87`、`unit/project-scan.test.ts:234`、`unit/surface-release.test.ts:107`（symlink 权限）；`project-scan-boundary.test.ts:482,498`（独占锁平台） |
| 本轮真实触发 skip | **1** | `test/unit/fingerprint.test.ts:143` — “filesystem does not enforce read permission in this environment”（打印可见，非静默） |
| 实测 todo | 0 | `todo 0` |
| 静态 skip 字符串（测试夹具，非真实 skip） | 2 | `redteam/ledger-full.test.ts:197`、`redteam/verify-hardening.test.ts:20-21` |
| coverage 命令之外的显式 SKIP | 1 类 | `scripts/run-tests.ts` 在 `scripts/node_modules` 缺失时 SKIP spike 测试并打印；不属于本次 1649 测试 |

结论：**无静默 skip、无 only、无隐藏失败**。既有 1 个环境 skip 必须保持可见；禁止为凑覆盖率新增 skip/todo/only。

---

## 5. 不可达 / 环境边界判据与反作弊规则

### 5.1 已登记不可达防御分支（不得为美化数据删除）

| 位置 | 理由 | 处置 |
|---|---|---|
| `src/memory/replica-transport.ts:839` | `#validate` default：调用方 requestType/responseType 仅四种枚举 | 保留并附调用点证据 |
| `src/memory/replica-worker.ts:541-542` | `handleLine` default：`parseWorkerRequest` 已限定 type | 保留并附调用点证据 |

### 5.2 环境 / 验证边界（不计入覆盖率分母问题）

- Windows 不强制读权限（唯一实测 skip 成因）；symlink 需提升权限；独占锁探针仅 Windows。
- TLS 使用自签证书；CI 无证书工具时应显式跳过并打印，不得静默。
- TCP/TLS 仅 127.0.0.1/::1 与端口 0；单次真实等待 ≤200ms，Windows 进程回收 ≤500ms 有界轮询。
- 物理跨机、OS 真分区、生产 HA 切换、跨机时钟回拨、可用性 SLA 不在验证范围（沿用 M16/M17 边界声明）。

### 5.3 反凑数红线（写入验收）

1. 不得新增 `--test-coverage-exclude` 或任何 exclude。
2. 不得在 `src/` 添加 istanbul/等效 ignore 注释。
3. 不得把分支移出 include 文件或改统计口径美化数据。
4. 不得新增 skip/todo/only；既有条件 skip 必须保持打印可见。
5. 覆盖率必须来自被执行测试；空跑、堆正常路径不算覆盖。
6. 稳定性/泄漏与覆盖率分开验收：进程 PID、连接计数、端口可重绑、定时器计数另行断言。

---

## 6. 变异代表性清单（供 T-154，必须被杀掉）

| # | 变异 | 目标不变量 | 期望检出测试 |
|---|---|---|---|
| M1 | `compareLogicalVersion` 调换成 `local_seq`/`writer_id` 优先级 | 逻辑版本顺序固定 | logical-clock / ha-protocol |
| M2 | 删除 leader-lease / multi-writer 的 epoch 回滚检查 | epoch 单调 | leader-lease、multi-writer |
| M3 | quorum 阈值由 `floor(N/2)+1` 改为 `ceil(N/2)` | 少数派不得提交 | ha-protocol、distributed-probe |
| M4 | distributed-probe 接受 declared digest 不重算 | 伪造摘要拒绝 | distributed-probe boundary |
| M5 | `injectDistributedConflicts` 允许 SUFFICIENT 保留未解决冲突 | Gate 不得假放行 | distributed-probe |
| M6 | `gateEvidenceIssue` 允许 uncommitted 携带 evidence_id | 未提交不进 Gate | ha-protocol、multi-writer |
| M7 | `runNode` 放宽 scope 相等比较 | 跨 scope 拒绝 | distributed-probe |
| M8 | 移除 TCP connect 非 loopback 拒绝 | 仅回环可连 | tcp-transport boundary |
| M9 | 帧长度上限 off-by-one | 超限帧必须拒绝 | tcp-frame-codec |
| M10 | 移除 replayOrder / projection 的哈希 tie-break | 确定性排序 | logical-clock、multi-writer |

要求：临时副本注入，记录检出率；未检出项补测试后再跑；恢复后全绿；变异不得污染真实源码。

---

## 7. 并行所有权拆分（避免写冲突）

### T-151（QF-02 纯逻辑）

- 独占新建：`test/unit/tcp-frame-codec-complete.test.ts`、`test/unit/probe-merge-complete.test.ts`、`test/unit/leader-state-complete.test.ts`、`test/unit/logical-clock-complete.test.ts`。
- 可扩展：`test/unit/logical-clock.test.ts`。
- 不得触碰：`src/**`、`test/redteam/**`、`test/integration/**`、`docs/**`。

### T-152（QF-03 安全关键）

- 独占新建：`test/redteam/final-security-branches.test.ts`、`test/integration/final-consistency-branches.test.ts`。
- 可扩展：`test/unit/cluster-consistency.test.ts`、`test/unit/ha-protocol.test.ts`、`test/unit/multi-writer.test.ts`、`test/unit/distributed-probe.test.ts`、`test/redteam/distributed-probe-boundary.test.ts`、`test/redteam/ha-split-brain-boundary.test.ts`、`test/redteam/tcp-transport-boundary.test.ts`。
- 不得触碰：`src/**`、`test/unit/tcp-frame-codec*.test.ts`、`test/unit/probe-merge*.test.ts`、`test/unit/leader-state*.test.ts`、`test/unit/logical-clock*.test.ts`、`docs/**`。

共享规则：两者只新增/扩展各自测试文件；如需改 `src`（缺陷修复）由主控串行指派；helper 新增放在各自目录前缀下，避免 `test/helpers` 写冲突。

---

## 8. 最终三轮同源码要求与 T-156 前置

1. **三轮矩阵**：T-155 在同一冻结源码快照上连续运行三轮全量质量矩阵（`test`/`typecheck`/`coverage`/`build`/`check-docs` + 关键协议回归），三轮全部通过且结果一致。
2. **快照纪律**：每轮开始前记录源码树哈希；三轮之间不得有 src/test/docs 变更；发现缺陷必须修复并重新开始三轮。
3. **每轮验收线**：全仓 ≥97/88/97；四纯模块 100/100/100；安全关键枚举分支 100%；无未说明 skip；无进程/socket/定时器泄漏。
4. **抖动处理**：本轮实测 13 个文件行/分支百分比两次运行间抖动（逐文件指标最大 3.77pp；不等于全仓波动）；三轮必须**每轮独立达标**，不得取平均。
5. **动态索引位置**：三轮报告索引写在 `.pm/`（不进入源码指纹）。
6. **交付时必须附当前源码的成功矩阵与 verify/gate 通过证据。**

### 8.1 阈值升级与机械核对契约（T-153 执行，T-150 仅冻结，不改脚本）

**A. coverage 命令阈值升级（由 T-153 主控或子代理改 `package.json`，本任务不动脚本）**

| 项 | 当前值 | 冻结目标 |
|---|---|---|
| `--test-coverage-lines` | 90 | **97** |
| `--test-coverage-branches` | 80 | **88** |
| `--test-coverage-functions` | 未设置 | **97**（Node CLI 原生支持该 flag） |
| include / exclude | `src/**/*.ts` / 无 | 不变；**不得新增任何 exclude** |

升级后命令形如：
```bash
node --test --experimental-test-coverage \
  --test-coverage-lines=97 --test-coverage-branches=88 --test-coverage-functions=97 \
  --test-coverage-include=src/**/*.ts "test/**/*.test.ts"
```
验收：该命令在冻结源码快照上自身 exit 0（阈值即验收线），且与机械核对的原始计数一致。

**B. 四纯模块必须用原始计数判定，禁止文本四舍五入**

- 判定源必须是机器可读的原始计数（每文件 total/covered/uncovered 的 lines、branches、functions），**不得用 spec/TAP 文本表的 100.00% 作为证据**（两位小数可掩盖极小缺口）。
- 四个模块各自要求：`uncoveredLines == 0 && uncoveredBranches == 0 && uncoveredFunctions == 0`，且 `covered == total`（分母 > 0）。
- 证据须绑定当轮源码树哈希；输出写入 `.pm/` 或 `docs/evidence/`，含每模块四元组 `(total, covered, uncovered, sourceHash)`。
- 本轮文本实测为 tcp-frame-codec 100/97.44/100、probe-merge 100/87.31/97.56、leader-state 100/96.23/100、logical-clock 96.22/91.80/90.91，均为**待升级对象**，不构成达标声明。

**C. 安全关键清单必须有分母与执行证据关联**

- 第 2 节每个枚举分支需要三项机器可读数据：`branchDenominator`（该分支点方向总数）、`executedCount`（已执行方向数，须等于分母）、`evidence`（触发该分支的测试文件 + 测试名映射）。
- 仅有覆盖率计数而无测试→分支映射，视为**证据不足**，不得判入“已覆盖”。
- 机械核对：导出分支级计数（位置 + count），与安全清单的证据映射表做 join；任一`.executedCount < branchDenominator` 或缺少 evidence 即失败。
- 允许改动：新增独立核对脚本或附加 flag/报告导出；**不强制改核心运行逻辑**，但不得改统计范围、不得加 ignore/exclude 凑数。
- 分母来源须与四模块一致（原始计数），并随三轮报告一同归档于 `.pm/`。

### T-156 文档前置（控主补充约束）

- 指纹范围：`docs/README/CHANGELOG/AGENTS/.ano` 进入 pm-mcp 源码指纹；`.pm/` 与 `PROJECT.md` 不进入（控主口径）。
- 因此 **T-156 文档定稿（README/CHANGELOG/`docs/limitations.md` 等）应前置到 T-155 三轮同源码之前完成草稿并冻结**；依赖链不改，T-156 对账任务不阻止主控提前定稿。
- 若更新 `docs/evidence/final-quality-acceptance.json`：只写契约与指向 `.pm` 结果路径的引用，**不得自引用报告哈希**；动态三轮报告索引写 `.pm`，避免三轮后改 docs 导致源码指纹过期。
- **不得新增任何 exclude。**

---

## 9. M17 历史结论纠正

| 项 | M17 原结论 | 本轮纠正 |
|---|---|---|
| F-1 | `replica-transport.ts:670` `#requireLive` 错误模板多余字面量 `}`，计为 low 缺陷 | **基线误报**：逐行 eval 复核输出无多余 `}`；代码正确，不再计入缺陷数 |
| TCP 剩余 9 处 | “剩余未覆盖 9 处，逐条行号数据缺失” | 由实测取代：`src/memory/tcp-transport.ts` 当前未覆盖 **44 行、12 区间**（487-490, 587-594, 599-600, 785-787, 889, 1135-1137, 1254-1257, 1260-1263, 1270-1275, 1278-1281, 1318-1319, 1340-1342）。其中 **785-787（未握手 dispatch）与 889（fail-closed 授权）为安全分支**，必须由 T-152 覆盖。原“9 处”不得再作为逐条行号结论引用 |

---

## 10. 复现命令

```bash
# 权威覆盖（本报告基线）
npm run coverage
# 等价：node --test --experimental-test-coverage --test-coverage-lines=90 \
#   --test-coverage-branches=80 --test-coverage-include=src/**/*.ts "test/**/*.test.ts"

# 结构化交叉核对（原生 TAP coverage report）
node --test --experimental-test-coverage --test-coverage-lines=90 \
  --test-coverage-branches=80 --test-coverage-include='src/**/*.ts' \
  --test-reporter=tap "test/**/*.test.ts"

# 类型 / 文档（证明未改源码时）
npx tsc -p tsconfig.json --noEmit
node scripts/check-docs.ts
```

本轮实测：`npm run coverage` exit 0（1649/1648/0/1）；TAP 交叉 exit 0（全仓 95.62/84.53/95.36）；两次运行 13 文件轻微抖动。
