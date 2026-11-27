# 交付说明（P0–P7 + M5 本地 alpha）

## 交付内容

一个可安装、可测试、可复核的 ANO 本地 alpha：

- **账本**：追加式 segment 账本（单链哈希、批次校验和、CRLF 容错、幂等、租约、崩溃恢复、可重建 SQLite 视图、observed 段头哈希 fail-closed、只读 `.pm` 迁移）。
- **源码指纹**：确定性树哈希（稳定排序、缓存排除、symlink 拒绝、读取变化检测）。
- **结构图**：TS/JS L0/L1/L2（导出表、三档重导出、三态边、barrel、调用边、T2、内容哈希增量、单写者、freshness 与降级保留）。
- **任务裁决**：impact 超集、T1 仅 `value-confirmed + resolved`、T2 仅 resolved 调用边、真实子进程证据、图/源码漂移拒绝；`done` 必须由 Gate 证据证明。
- **Memory**：纯合成 provider adapter、参数化 recall、中文/标识符检索、Anchor 三级重定位、brief（库级，不采集真实会话）。
- **Audit**：drift/security/license/governance/deps 本地只读审计，Finding 仅指纹与位置，联网显式 confirm，open findings 阻断 `ok`。
- **验收基线**：版本化、SHA-256 复算、不可变批准、TTY 人工背书。
- **Readiness**：profile `defined/validated`、证据四级分级、文件证据过期与制品哈希绑定、release 三态裁决。
- **Surface**：MCP 恰 7 工具且全部接通声明范围，CLI 支持 brief/explore/track/verify task+release/audit/doctor/rebuild/export/ui/baseline/note/recall。

## 如何验收（一条命令）

```sh
npm ci
npm --prefix scripts ci        # Spike 测试工具链（缺失时 npm test 会显式 SKIP 并打印）
node scripts/verify-all.ts
```

它依次执行 typecheck、全量测试、覆盖率门槛、build、schema pin、文档一致性、真实 ZCode stdio 接入、P1 判定实验、真实 tarball 安装冒烟，并校验证据 verdict。Node 22/24 的安装自举证据见 `docs/evidence/node-matrix.json`。

## 已知边界（不要越过）

- 不是完整 v1：P8 发布、真实客户端采样、生产 profile `validated`、三平台远端 CI 未执行。
- `track` 只支持 task/create；`recall` 只查显式导入的合成历史；release verify 不是人工批准。attest、sync、push 返回明确错误，不写状态。
- T1/T2 是静态可达性，不是运行时覆盖；unknown/heuristic/动态加载均在 caveats 中报告。
- 语言仅 TS/JS；不提供 Rust 内核与 codegraph 全语言能力。
- 禁止加载宿主项目 TypeScript；模块无法静态解析时降级为 unknown。
- 仅在 Windows 实测；Node 22.18/24 的真实 tarball 自举已通过，完整测试矩阵仍以最新报告为准。
- 未创建远程仓库、未 push、未 publish、未采集真实会话。
- 商标清查未完成；名称使用 `agent-nihil-obstat` 是工程决定，不是法律结论。

## 关键证据

| 文件 | 内容 |
|---|---|
| `docs/phase-0-report.md` … `docs/phase-7-report.md` | 各阶段实现、验收原文与限制 |
| `docs/evidence/p1-experiment.json` | 含 `generatedAt`、`sourceFingerprint`、场景 verdict |
| `docs/evidence/package-smoke.json` | 含 tarball sha256、版本、dist 哈希、CLI done/T1、MCP 7 工具 |
| `docs/evidence/node-matrix.json` | Node 22.18/24 的真实 tarball 自举与工具闭环 |
| `docs/evidence/zcode-mcp.json` | 当前生效 `ano` 登记（用户级唯一，工作区不重复）的真实 stdio 连接、工作区配置哈希与生效 server 指纹 |
| `docs/zcode-integration.md` | ZCode 接入、重启与安全边界 |
| `docs/evidence/p3-graph-bench.json` | 结构图本机基准原始数据 |
| `docs/limitations.md` | 全部限制 |
| `.pm/quality-runs/` | 质量矩阵成功与失败历史 |

## 下一步（需要你决定）

1. 是否授权创建远程仓库与发布（P8），以及商标清查。
2. 是否提供真实项目用于 profile `validated`（G7）与 Memory 客户端样本授权（G3）。
3. 是否扩展 `track` 的 update/complete/cancel 与里程碑/断点操作。
