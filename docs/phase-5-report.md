# Phase 5 报告：Audit、验收基线与 Surface 收尾

日期：2026-11-19。范围：`src/audit/**`、`src/readiness/baseline.ts`、`src/surface/**`、`src/index.ts`、`scripts/check-schema.ts`、P5 测试与生成文档。
明确不做：release approve / sync / push、`ano attest`、任何 MCP 批准/签字工具；不冒充 attestation 已可用。

## 交付

### 1. Audit（本地、只读、Finding 仅指纹与位置）

- 五个 scope：`drift`、`security`、`license`、`governance`、`deps`。
- `Finding` 只含 `rule/severity/message/path/line/column/fingerprint`；秘密匹配值立即 SHA-256 化后丢弃，消息、持久化、事件都不含明文。红队测试对 AWS key、密码、私钥逐项断言输出中不存在原文。
- `security`：私钥块、AWS/GitHub/Slack/Stripe/JWT、通用凭据、`.env` 字面量；危险模式含 `eval`、`new Function`、shell 执行、关闭 TLS 校验、`rm -rf /`、远程内容管道到 shell；排除占位符与变量引用。
- `license`：本地 `package-lock.json`（v1/v2/v3）与 `node_modules` 元数据；SPDX `OR/AND/WITH` 分类，强 copyleft/proprietary/unknown 产生 Finding；项目自身为强 copyleft 时降级强 copyleft 告警。
- `governance`：直接消费 Structure 图（`AuditGraphView` 可注入），按策略检查 denied/undeclared 依赖、模块环、unknown 占比；缺失策略/图时给 info + degraded，不崩溃。测试用注入图，不依赖真实解析。
- `deps`：离线 manifest/lock 审计（moving tag、非 registry 来源、未固定范围、lock 缺失/缺条目、install script、重复版本）。不做 OSV 查询。
- 联网：`online=true` 必须 `confirm=true`，否则抛 `AuditNetworkRefusedError`；没有注入 scanner 时明确记 `network.performed=false, refused=not-configured`，绝不发请求。注入 scanner 才执行，测试验证 `confirm=true` 与包清单传入。
- Finding 持久化 `.ano/audit/findings.json`：按位置 + 指纹稳定 id；已 resolved 的 Finding 再次出现自动 `reopened`；完整扫描后消失的 open Finding 标记 resolved，不删除历史。
- 审计事件接口：`AuditEventSink`、`InMemoryAuditEventSink`、`JsonlAuditEventSink`、`ledgerAuditInputs()`。当前 `src/ledger/event.ts` 的 kind 枚举不含 audit 事件且不在本任务可改范围，因此未写账本，事件载荷已按未来 `audit.finding` / `audit.completed` 形式准备，主控可直接接。

### 2. 验收基线（`src/readiness/baseline.ts`）

- 严格 zod schema：`schemaVersion=1`、正整数版本、criteria 唯一 id、三个报告必须是不同文件；未知字段拒绝，`../`/绝对路径/指向基线目录的报告路径拒绝。
- 版本化：`000001.draft.json` / `000001.approved.json`；批准后 exclusive create（`wx`）且内容 SHA-256 自校验；同一版本再次保存/批准一律 `BASELINE_IMMUTABLE`；新版本必须大于最新已批准版本。
- 证据：保存时、批准前、批准中前后、复核时都重新计算 SHA-256；声明 hash 与实际不符即拒绝。
- 手填 PASS：baseline 不保存 PASS 字段；评价时从真实证据 JSON 取数值指标，字符串/布尔（如 `"result":"PASS"`）明确报 `machine-pass-must-be-numeric` 并判无效；伪造 64 位 hash 在保存阶段即失败。
- 三件套：quality/coverage/build 仅引用，本模块从不写入或覆盖；批准后任一报告被改，复核返回 `report-hash-mismatch` 并 invalid；批准文件被改，`loadApprovedBaseline` 返回 `BASELINE_INTEGRITY`。
- 批准：必须 human attestation（`human:true`、具名、role、scope、statement）且 TTY；默认读取真实 `process.stdin/stdout.isTTY`，非 TTY 拒绝；CLI 走真实检查。库调用可用 `{tty:true}` 注入仅用于测试，MCP 无任何批准/签字工具，schema pin 测试也禁止 approve/attest/sync/push 工具名。

### 3. CLI / Surface

- `doctor`：通过调用路径识别 `local`（`<packageRoot>/dist/surface/cli.js`）、`npx`（`_npx/<hash>/node_modules/agent-nihil-obstat/...`）、`source`；同时报告 Node engine、项目 Git/`.ano`、ledger 段数、graph/audit 缓存、7 工具、human-only 与网络默认拒绝。不做 registry 查询。
- `rebuild graph`：真实重建 SQLite 图并返回 revision/指纹/文件/符号/边/新鲜度。
- `export`：只读导出任务、证据摘要、变更、图摘要、Finding、基线；不含 SQLite 内部或明文秘密。
- `ui`：`node:http`，强制 `127.0.0.1`，仅 GET（其余 405 + Allow），Host 头只接受 loopback（否则 403），CSP `default-src 'none'; script-src 'none'; ...`，`nosniff`/`DENY`/`no-store`，所有动态值 HTML 转义；`/export.json` 将 `<>&` 转成 unicode 转义。HTTP 集成测试使用真实监听端口、真实临时 Git 项目。
- MCP：`audit` 已接通 service；schema 增加 `online?`，保留 `confirm`。`brief/explore/track/verify` 回归测试通过；`brief` 阶段改为 P5 并更新限制文案。
- `release approve`、`sync`、`push`、`attest` 在 CLI 返回明确 exit 2 “not implemented”，不写任何状态。

### 4. Schema pin

`scripts/check-schema.ts`：规范化（canonical JSON）7 个工具 input schema 与 ledger event schema 的 SHA-256，固定 tool 名单/数量与 ledger kind 列表；变化时 exit 1，`--print` 输出新 pin。当前已验证 7 工具 + 11 个 ledger kind 匹配。

## 验证结果（真实执行）

```text
npm run typecheck
→ pass（0 error）

node --test test/redteam/audit-full.test.ts test/integration/surface-full.test.ts
→ 15 tests / 15 pass / 0 fail

node --test test/integration/cli.test.ts test/unit/tool-catalog.test.ts
→ 11 tests / 11 pass / 0 fail

node scripts/check-schema.ts
→ Schema pins match: 7 tools + ledger event schema (11 kinds).

node scripts/check-docs.ts
→ Generated tool catalog is current.
```

未按指示跑全量 `npm test`。

已知且未掩盖的失败：

```text
node --test test/integration/mcp.test.ts
→ 4 pass / 1 fail
失败用例：unimplemented scopes return isError and never touch a valid project ledger
原因：该用例仍断言 `audit(scope=security)` 必须返回 “not implemented”。P5 已实现 audit，
这是预期的行为变更；该测试文件不在本任务允许修改范围，需主控更新旧的未实现断言。
其余 MCP 测试（7 工具 schema、note/verify 拒绝、root 校验、explore 截断）仍通过。

> 最终交付收口：`unimplemented scopes return isError ...` 旧断言已更新为 audit 已接通，
> 该用例现通过；全量 `npm test` 241/241，`node scripts/verify-all.ts` 8/8。
```

## 文件

新增：
- `src/audit/types.ts`、`util.ts`、`security.ts`、`license.ts`、`governance.ts`、`deps.ts`、`drift.ts`、`findings.ts`、`events.ts`、`index.ts`
- `src/readiness/baseline.ts`
- `src/surface/doctor.ts`、`export.ts`、`ui.ts`
- `scripts/check-schema.ts`
- `test/redteam/audit-full.test.ts`
- `test/integration/surface-full.test.ts`
- `docs/phase-5-report.md`

修改：
- `src/surface/service.ts`（audit/rebuild、P5 brief）
- `src/surface/cli.ts`（doctor/rebuild/export/ui/audit/baseline 与明确拒绝）
- `src/surface/mcp.ts`（audit 分派）
- `src/surface/tool-catalog.ts`（audit 摘要 + online 输入）
- `src/index.ts`（P5 导出）
- `docs/generated/tools.md`（audit 行）

## 限制与未验证

1. `deps` 无 OSV/registry 查询；`security` 不扫 git 历史与二进制。联网只在注入 scanner 时执行，默认拒绝。
2. Audit Finding 未写入 ledger（ledger 事件 schema 不在可改范围）；当前写 `.ano/audit/findings.json`。已提供 sink/`ledgerAuditInputs` 供主控接。
3. `drift` 的 Anchor 来自注入（`context.anchors`）；Memory 尚未落地，且 `contentFragmentHash` 未复算，仅记录 caveat。
4. `governance` 在 service 中若图 revision 为空会执行一次 `graph.build()`；注入图路径不读盘。策略优先 `.ano/governance.json`，其次只读 `.pm/governance.json`。
5. 验收基线只引用三件套，不生成报告本身；“不可覆盖”由 exclusive create、内容 hash 与复核 hash 保证，不是文件系统 ACL。
6. `ui` 的安全边界是 loopback 绑定 + Host 校验 + CSP + 转义；没有登录/鉴权，设计上只允许本机读取。
7. `docs/generated/tools.md` 的固定 footer 与 `docs/usage.md` 仍描述 P1 范围；`scripts/gen-docs.ts`/`check-docs.ts` 不在允许修改范围，需主控同步文案。
8. `scripts/check-schema.ts` 的 pin 包含当前 11 个 ledger kind；P2 若继续改 ledger schema，必须显式更新 pin。
9. 未实现 release approve/sync/push、`ano attest`；未做真实 npx 发布安装验证（doctor 只做本地路径/环境识别），未声称 attestation 可用。
