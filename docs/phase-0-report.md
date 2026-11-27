# Phase 0 报告：准备与机制验证

日期：2026-11-18。基线：`ano-architecture-v1.0.md`。

## 范围

本报告只声明 Phase 0 的名称/决策、工程脚手架、S1 机制段和 S2–S7 机制验证。不是 P1 竖切通过，不是产品发布，不是所有客户端/语言/profile 的支持证明。

## 完成项

### 1. 项目台账与方案

- 已初始化 pm-mcp，建立 P0/P1/P2/后续里程碑与任务。
- `docs/execution-plan.md` 给出全阶段依赖、并行拓扑、逐条验收和停止条件。
- `docs/decision-gates.md` 记录已答门与未授权动作。
- 包名 `agent-nihil-obstat`，CLI `ano`；用户选择 MIT 独立实现、禁止宿主 TS。
- 用户希望支持热门客户端，但没有明确授权真实会话采样；S1 排序段因此不执行。

### 2. 名称查重

`docs/name-check.md` 保存原始 npm/GitHub 查询与限制：npm `ano@0.3.1` 已由第三方占用；`nihil-obstat` 和 `agent-nihil-obstat` 匿名 npm 查询为 E404；GitHub 完整名称查询为 0 公共结果。USPTO 页面未得到有效商标搜索，**商标清查未完成**。

### 3. 工程脚手架

已建立严格 TypeScript/ESM、锁文件、MIT、CI、文档生成、CLI/MCP 契约和测试。

原始执行记录：

```text
npm run typecheck                    通过（部分后续 P1 模块等待合并时曾失败，见质量台账）
npm test                             通过（包含真实 stdio tools/list 和 argv evidence）
npm run gen-docs                     生成 docs/generated/tools.md
npm run check-docs                   Generated tool catalog is current.
npm run build                        通过（只适用于没有未完成接口的已集成修订）
npm pack --dry-run                   16 files，未发布
```

pm-mcp 质量报告：

- `.pm/quality-runs/quality-20261118-125229-337-0000.json`：根 test/build/typecheck 通过（当时 16 测试的修订）。
- `.pm/quality-runs/quality-20261118-130507-863-0000.json`：S1 scripts typecheck/test 通过，22 测试。
- 中途 P1 接口未到位导致的失败报告也保留在 `.pm/quality-runs/`，不覆盖。

实际 MCP stdio 客户端核验恰为 `brief/explore/recall/track/note/verify/audit` 七工具；未实现写调用返回 isError，不修改账本。目录存在不代表 handler 已完成。

## Spike 结论

### S1：机制段通过，排序段未执行

主控独立重跑：22 pass / 0 fail / 0 skip。报告保留先前 19 pass / 3 fail 与修复原因。

- FTS5、trigram 可用；SQLite 3.51.2，ICU 78.2，Unicode 17.0。
- 1/2 码点 MATCH 的 8 个样例全部静默 0 行；普通 LIKE 在 15 个矩阵样例与真值一致。
- ≥3 码点 MATCH 的 7 个样例与真值一致（含非 BMP）。
- 查询长度必须按 Unicode 码点；<3 码点必须分流并标降级。
- Segmenter 对术语并不总是词级：`幂等/死锁/回滚/调用` 逐字；`refreshToken` 整词不拆。
- 标识符拆分必须补子词，索引/查询共用函数和版本。

结论仅淘汰/约束机制，不选 A/B/B+/C/C+ 排序赢家。详见 `docs/spikes/S1.md`。

### S2：Node 24 + Windows 通过

5220 个 TS/TSX/JS/JSX/MJS/CJS 合成文件、47.7 MB；0 异常、0 `hasError`。一次主测 GC 后 heap 25%→100% 增长 0.15 MB，RSS 峰值 206.88 MB，200.85 files/s，p95 12.968 ms。重复运行有波动，报告已列出；不外推 Node 22/长期 daemon/真实大仓库。每棵树仍显式 delete。

### S3：虚拟时钟原型通过

1005 个事件，回拨无倒退/丢失，多 actor 因果违例 0；8 种合并顺序稳定。200 个 `(physical,logical)` 碰撞必须由 actor 打破；HLC 二元组不是全序。未测真实 NTP/跨进程持久化。

### S4：可嵌入但不做主依赖

46 行公开 API 探针通过 init/indexAll/search/getCallers/impact/context/watch/close。包 1.6.3 实际安装约 263 MB；平台包精确版本耦合；ESM 文档与运行时导出形状不一致。P1 自写最小 L0/L1。

### S5：原型通过

1636/1636 字节边界强杀注入通过；自己截断 1632，别人残尾哈希不变 1636。文件 fsync 和协作锁行为已实测；Windows 目录 fsync EPERM，不能声称掉电持久性。它验证原型，不替代产品实现的恢复测试。

### S6：本地分支合并通过

三分支合并，5 个 segment 总事件 11=11，各段链/observed 全通过，工作树无冲突。不建立跨 segment 全链，不做远端推送。

### S7：合成模块解析通过

内置 resolver 和自带 TS 在 7 用例均 5 resolved + 2 unknown；宿主 TS 明确禁止。微型性能数据不外推。P1 默认内置 resolver。

## 审计

- 许可证：直接/传递依赖元数据未见 copyleft 冲突；源码前 40 行未见 GPL 家族头；不代替法律审查。
- 安全：初扫 S1 动态 SQL 模式 3 个 HIGH。逐行确认是受控表名和权重，仍改为静态语句/参数绑定并重跑 22 测试；重扫结果以最新安全台账为准。
- 不读取 obelisk 源码；codegraph 仅公开文档/API 黑盒。

## 未完成与偏差

1. **S1 排序段未执行**：无明确隐私采样授权；无 P@5/Recall@20 或方案赢家。
2. **商标清查未完成**：网页未返回有效检索结果。
3. **远端三平台 CI 未执行**：本地未创建远程或 push。
4. Node 22.18 曾真实运行 16 项基础测试全过，后续新增 P1 测试须再重跑才可扩展该结论。
5. S2 只测 Node 24 + Windows 合成输入；没有全平台/大仓库保证。
6. S5 只验证原型与进程崩溃，不证明断电安全或生产实现全部正确。
7. P1 的 ledger/graph 实现与 P0 部分并行，但 S5/S6/S7 已通过；它们仍要过 P1 真实验收，不在此报告标完成。

## Phase 0 裁决

**机制与准备阶段可交付，继续 P1 竖切。** 不是最终系统 ready。S5/S6 没有失败，无需更换账本设计；S1 排序和商标清查保留为未完成的公开项。
