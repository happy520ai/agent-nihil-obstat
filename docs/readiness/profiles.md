# Readiness profiles

状态含义：

- `defined`：清单、schema hash 和裁决规则存在，没有任何真实项目被用来验证它。
- `validated`：必须带外部 `validation` 记录（项目名、日期、profile schema hash、真实 verdict hash）。
  本项目不能用自己作为验证项目；当前代码中所有 A–I profile 都是 `defined`。

| Profile | 类型 | 状态 | 需求数 | 当前验证项目 |
|---|---|---|---:|---|
| common | 通用项 | defined | 10 | 无 |
| A | 库 / SDK / npm 包 | defined | 5 | 无 |
| B | 命令行工具 | defined | 4 | 无 |
| C | 后端服务 / API | defined | 10 | 无 |
| D | Web 前端 / SaaS | defined | 7 | 无 |
| E | 移动应用 | defined | 6 | 无 |
| F | 桌面应用 | defined | 5 | 无 |
| G | 小程序 / 浏览器扩展 | defined | 4 | 无 |
| H | 数据 / ML 管道 | defined | 6 | 无 |
| I | 基础设施即代码 | defined | 4 | 无 |

每个需求只能以三种方式满足：

- `machine`：外部或本地计算产生的文件证据，绑定当前制品哈希（发布裁决默认还要求制品绑定）。
- `attested`：具名人在 TTY 动作产生的有效 attestation，带范围、目标和有效期。
- `missing`：没有可用证据，或证据存在但被拒绝。

`ready` 不允许任何 `missing`；`conditional` 只允许 attestation 缺口或过期；机器证据缺失、过期、旧制品或格式伪造会导致 `blocked`。制品哈希变化后，原机器证据和原放行记录同时失效。

清单存在不等于真实支持。尤其见：

- [Profile A 的真实状态](profile-a.md)
- [Profile C 的真实状态](profile-c.md)
