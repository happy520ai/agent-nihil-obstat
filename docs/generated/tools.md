# 生成的工具目录

<!-- 由 npm run gen-docs 生成；不要手工修改。 -->

包版本：0.1.0-alpha.0；Node：>=22.18。

MCP 工具数量：**7**。

| 工具 | 访问 | 用途 |
|---|---|---|
| `brief` | read | 恢复项目焦点、断点、锚定知识和缓存新鲜度；附带 Connect 接入状态；接管项目附主写/权限/下一步（ADR-006 §5）。 |
| `explore` | read | 返回符号、调用路径、影响范围及结构降级说明；文件级 outline/impact 查询与九类覆盖分类经结构分析投影提供（ADR-010）。 |
| `recall` | read | 按固定结构化条件检索合成会话历史；source=connected 时检索已接入的 pm-mcp 记录，不执行脚本、不自动记录为 note；结果附接管状态（只读）。 |
| `track` | write | 管理原生任务（create/update/complete/cancel/reopen；complete 必须携带已记录的 Gate evidence_id）与 Connect 接入（plan/connect/status/export/handoff）及 PM→ANO 迁移（migrate_plan/migrate_apply/reconcile，写操作幂等）；接管生命周期 grant/apply/status/recover/disable/revoke（apply/recover/disable/revoke 必须显式 confirm=true）；接管项目按策略路由（enforced=ANO 主写，recovery 拒绝写）。 |
| `note` | write | 记录带 Anchor 的 Decision、Pitfall、Memory 或会话摘要到账本；接管项目按策略路由（enforced=ANO 主写，recovery 拒绝写）。 |
| `verify` | write | 采集外部执行证据并计算任务或发布裁决，不代替人工放行。 |
| `audit` | read+findings | 执行本地漂移、安全、许可证、治理或依赖审计；Finding 只存指纹与位置，联网需 confirm=true。 |

> 当前为本地 alpha：七工具数量不变。`track` 支持原生任务 create/update/complete/cancel/reopen（complete 必须携带已记录的 Gate evidence_id）与 connection 的预检、接入、状态、导出、接管检查，以及 PM→ANO 迁移 plan/apply/reconcile；`recall` 默认查询合成历史，source=connected 查询显式接入的 PM 历史。迁移只读 `.pm/` 并在 `.ano/ledger` 落账，不写回来源； Connect 不代表完整主写接管或双向同步；release 裁决不代替人工批准。签字、放行和同步不暴露为 MCP 工具。
