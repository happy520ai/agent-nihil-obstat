# Phase 1 报告：融合竖切

日期：2026-11-19。基线：`ano-architecture-v1.0.md`。
范围：最小账本、源码指纹、TS/JS L0/L1、barrel/type-only、impact/T1、实际执行证据与任务裁决。

## 交付范围

- `Ledger`：按会话 segment、段内 SHA-256 链、批次校验和、fsync、幂等视图、真实 SQLite 重放、任务/证据视图。
- `fingerprintTree`：稳定路径排序、逐文件与树 SHA-256、缓存排除、符号链接拒绝、读取变化检测与错误降级。
- `GraphStore`：tree-sitter TS/TSX/JS/JSX/MJS/CJS L0/L1、导出表、具名 barrel 穿透、wildcard/环/深度降级、三态边、真实 SQLite 缓存与 freshness。
- `impact` 为反向超集；T1 只沿已执行测试的 value-confirmed 边正向计算。
- `verifyTask`：真实 argv 子进程（不经 shell）、显式实际测试清单、执行前后指纹、图 revision/freshness、证据事件与机器 verdict。
- Surface：真实 MCP stdio 恰为 7 工具；`brief/explore/track(task)/verify(task)` 接通。`recall/note/audit/release` 的未实现路径明确拒绝；无 MCP 批准能力。

## 合成判定实验

脚本：`scripts/p1-experiment.ts`；机器证据：`docs/evidence/p1-experiment.json`。
执行：Node 24.14.0，临时目录真实 Node/Git 项目，实际 `node --test` 子进程，真实 ledger/SQLite 图。

### A/B/C 覆盖缺口

修改 A，执行 B 测试。A 经 B 测试沿 value-confirmed 可达；C 没有已执行测试可达。

```text
verdict = blocked
level = T0
impact = [src/a.ts, src/b.ts, src/c.ts, test/b.test.ts]
covered = [src/a.ts, src/b.ts, test/b.test.ts]
uncovered = [src/c.ts]
reason = Files lack value-confirmed test reachability: src/c.ts
```

这是 P1 的核心证明：只声明 A 不能缩小 Git 推导范围，依赖 A 但未覆盖的 C 阻断完成。

### 补齐 C 后

新增并实际执行 C 测试，再运行 B+C 测试：

```text
verdict = done
level = T1
uncovered = []
reasons = []
ledger task status = done
```

### 图过期

成功运行 B+C 后修改 A，不重建图：

```text
freshness = stale(1)
verdict = blocked
```

即使覆盖集合已满足，旧图和旧证据也不能完成新源码任务。

### barrel 与 type-only

`index.ts` 分别转发 A 的 `a/User`、B 的 `b`、C 的 `c`。改 A：

```text
impact = [src/a.ts, src/index.ts, src/user-consumer.ts]
```

B 消费者不进入 A 的影响范围。B 测试通过 barrel 实际引用 b，只把 B 记为覆盖；A、index 和 type-only 消费者没有被误覆盖。普通 `import { Shape }` 指向 interface 时也归 type-only；同名 interface+const 合并归 value，见结构专项测试。

### 失败尝试与修正

1. 初版实验把 A 错设为必须未覆盖，实际 A 经 B 已覆盖；保留该失败，按 T1 既定语义改为断言 C 缺口。
2. 补覆盖实验曾同时失败于旧测试断言、未执行的额外测试和输出证据；没有修改门禁放过。隔离每个场景并修正测试输入后重跑。
3. 早期断言失败伴随 Windows 异步句柄异常；将每个场景独立、显式关闭 SQLite、收集失败而非提前中止。最终运行无该异常。
4. 运行时中断曾使抽取器文件变为空字节；现场保存在 `D:/Temp/ano-ts-extractor-corrupt-20261119.bin`，按项目自身接口和测试重建，所有结构测试重新通过。

## 真实项目组

选定本地已有 `D:/DevTools/pm-mcp`，仅静态读取 TS/JS 源码并写可重建 `.ano/cache/graph.db`；不执行其代码/测试，不读取 obelisk。

- 源文件 74，确定排序后 stride=2，样本 37。
- `full impact` 中位数 17，p90 70（不是百分比）。
- 边：value-confirmed 494、type-only 62、unknown 5，总 561。
- unknown 比例 `5/561 = 0.008912655971479501`（约 0.891%）。
- heuristic 15；动态加载 11，含不可解析动态加载的文件 1。
- freshness=fresh，无 degraded reasons。
- 未触发人为设定的 80% 警戒线；不自动改 strict 为 advisory。
- 这是单项目抽样，不证明任意仓库的精度或性能，未声称全面误报率已知。

完整逐样本分布见证据 JSON。

## 门禁与边界

- T1 是静态可达性，不是运行时行覆盖或正确性证明。
- 测试清单必须由实际 runner/调用方提供；不默认“所有测试都执行过”。
- 测试计数缺失、无通过、失败、跳过、取消、todo、超时均不通过。
- 图 stale/degraded 或源码在执行期间变化均拒绝。
- 失败证据仍是事实记录，但不能算完成。
- 当前图全量重建，未完成增量性能优化。
- 非 Git 工作树不能推导 touched，verify 明确失败。
- 不能据此声称完整取代 pm-mcp/codegraph/obelisk 或完成 P2–P8。

## 裁决

**本次 P1 合成与真实项目判定实验无失败项，未触发架构 P1 失败判据。**

后续 P2 可以规划，但不在本报告宣称完成。最终系统验收仍需迁移、并发压力、Memory、Audit、完整 CLI、真实试运行、三平台 CI 与 Readiness 等独立证据。

## 2026-11-19 复审与修复记录

首轮实现通过原有测试后，四路独立审查发现并修复了以下真实缺陷（每项均有回归测试）：

**账本**
1. CRLF 转换会让 committed batch checksum 失配、账本永久打不开 → 读入时只把 `\r\n` 视作 `\n` 参与解析/校验，字节偏移仍按原始字节，truncate 仍正确。
2. 删除 segment 后 `view_meta.digest` 命中"空日志"摘要，导致幽灵任务/证据/幂等残留 → 追加事务内失效 digest，空 replay 也执行重建。
3. `createTask` 查重与追加分离，并发下抛 `LedgerIntegrityError` → 合并进同一次双锁持有。
4. `close()` 后读接口静默返回空 → 统一抛错。
5. `evidence.recorded` 接受未知任务 → 拒绝。
6. 锁可能抢走活进程的锁、或把操作自身抛的 `EEXIST` 当竞争重试 → token 所有权 + 只回收"进程已死且超时"，`EPERM` 视为存活。

**结构图**
7. `import * as ns` 与 barrel heuristic 边被记成 `value-confirmed` → 会造成 T1 假放行；改为 `unknown`，覆盖只沿 `value-confirmed + resolved`。
8. 外部包 import/re-export 被静默丢弃 → 显式 `unknown` 边。
9. `export { X }` 中 X 来自 `import type` 被当 value 且指向转发文件 → 两遍解析，穿透到定义文件并保持 type-only。
10. 解构默认值（`{ a = fallback }`）把 fallback 误登记为导出符号 → 只取左侧绑定。
11. `package.json#imports` 未解析 → 支持 exact/wildcard/条件对象；指向裸包时显式 unresolved。
12. 配置（tsconfig/package.json）变化不触发 stale；根目录 I/O 失败被当删除 → 比较 sourceFingerprint；ENOENT 才删除，其它错误保留旧数据。

**验证与表面**
13. `verify` 的 `idem_key` 未接线，重试会重复执行命令并重复记账 → 参数+源码派生幂等，同参复用 verdict、异参拒绝。
14. 任意 argv 只要输出自洽 TAP 即可把任务标 done → 要求 argv 实际选中声明的 test_files、文件存在、拒绝 shell/内联求值。
15. MCP 的 `note`/`verify` 因 discriminatedUnion 在 `tools/list` 中暴露空 schema → 改为对象 + superRefine，客户端可见真实字段。
16. CLI 把 `--` 之后的参数当作自身参数（可跨项目写）→ 只解析第一个 `--` 之前。
17. MCP/CLI 的 root 未校验，读工具会在无效路径创建 `.ano` → 要求存在且为 Git 工作树。

**交付链路**
18. CI 硬编码 `D:/DevTools/pm-mcp` 会让任意干净机器 `npm test` 失败 → 改为可注入 `ANO_REAL_PROJECT`，缺失时 verdict 明确降级为 `synthetic-pass-real-project-unavailable`。
19. 缺 `prepack` 导致干净 checkout 的 tarball 没有 `dist`、安装即坏 → 加 `prepack: npm run build`，并把使用/状态文档纳入包内。
20. 打包证据无 tarball 哈希/版本/时间 → 记录 tarball sha256、字节数、packedVersion、dist 哈希、生成时间、平台。

最终验收（本机 Node 24.14.0 / Windows）：

```text
npm run typecheck            通过
npm test                     核心 121/121，Spike 22/22
覆盖率                       行 94.95% / 分支 85.37% / 函数 93.51%
npm run build                通过
npm run check-docs           通过
P1 实验                      verdict=synthetic-pass-real-project-measured, failures=[]
真实 tarball 安装             CLI done/T1，MCP 恰 7 工具
scripts/verify-all.ts        8/8 checks passed
pm-mcp 质量矩阵              quality-20261119-035518-602-0000，source stable
```

证据绑定：`docs/evidence/p1-experiment.json` 现含 `generatedAt` 与 `sourceFingerprint`（5343 文件）；`docs/evidence/package-smoke.json` 含 tarball sha256 与产物哈希。注意 pm-mcp 矩阵的测试计数 22 来自最后运行的 Spike 套件，核心套件计数以 `npm test` 输出为准。
