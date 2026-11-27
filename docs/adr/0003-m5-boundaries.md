# ADR-0003：M5 Surface 接通边界

日期：2026-11-19

## 背景

ANO 已有账本、Memory 和 Readiness 库实现，但 Surface 仍有未接通工具。用户要求接入 ZCode 并接管项目。此时不能通过自动采样真实会话或绕过证据绑定来制造“已接管”的表象。

## 决定

- MCP/CLI `note` 使用 `MemoryNoteBook`，sink 写入同一项目的 `note.recorded` 账本事件；同一 `idem_key` 只做一次写入。
- MCP/CLI `recall` 只读 `.ano/cache/history.db` 和已显式 ingest 的合成 provider 数据；没有 provider 时如实返回 `not_configured`，不读取 ZCode 全局会话、不扫描用户目录。
- `verify(scope=release)` 使用真实 tarball/artifact 计算 SHA-256；不允许 agent 自己提供 `artifact_hash` 来声称制品已核验。`target` 仅接受单一版本号。没有制品时返回输入错误，不是 `ready`。
- 外部证据必须显式指定并位于项目内；attestation 必须带已经验证的人工 CLI 来源，不能凭 JSON 自签。缺证据仍由 Readiness 计算为 blocked/conditional。
- MCP 不暴露 attest、release approve、sync、push；agent 不代替人完成批准。
- ANO 自己管理任务与证据；pm-mcp 管理本次开发过程。两者并存，不混写存储。

## 后果

M5 可验证 ZCode 中的七工具闭环和真实制品裁决，但不等于真实客户端支持或生产 readiness validated。未安装 tarball、没有外部证据时，发布裁决应诚实阻断。
