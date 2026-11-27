# 参考资料盘点与使用边界

用户提供：

- `<home>\ZCodeProject\.pm`
- `<home>\ZCodeProject\_research`

## 实际观察

### `.pm`

2026-11-18 的目录盘点只看到 `.gitignore` 和 `.runtime/ledger-lock.db`，没有任务、项目、验收基线等可迁移业务 JSON。因此目前没有从该目录导入 ANO 的样本账本；不根据目录名称推断存在数据。

### `_research/codegraph`

有完整 Git 工作树及公开 README、package.json、文档和测试。仅用于 codegraph 公开接口、MIT 许可兼容性和 S4/S7 参考。其本地 manifest 显示包名 `@colbymchenry/codegraph`、版本 `1.6.3`、MIT；不能把 npm 上同名但不相关的 `codegraph` 包当成同一实现。

### `_research/obelisk`

存在公开规格文档，例如 `docs/dsh-context-window-extra-plugin-spec.md`、`docs/usf-spec.md`。项目保持 MIT 独立实现；**不读取 obelisk 源码、不复制实现**，只在需要时阅读公开 ADR/spec 并保留思想与实现的边界。

## 隐私与测试

上述参考目录不等于真实会话样本，也不构成隐私采样授权。S1 当前仅做合成机制测试。后续 Memory adapter 需先取得具体客户端采样授权，记录来源、客户端版本、格式版本、采集日期和脱敏方式。

## 可复用与不可复用

| 项目 | 可吸收 | 不可做 |
|---|---|---|
| pm-mcp | 已验证语义、迁移契约、红队思路；实际用户目录无业务账本 | 把 agent 自报当机器证据 |
| codegraph | MIT 公开 API/设计；实测验证 | 预设包 API 稳定或覆盖全语言 |
| obelisk | 公开 ADR/spec 的思想 | 读取/复制源代码、擅自接受 AGPL |
