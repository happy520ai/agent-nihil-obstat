# 决策门记录

| 门 | 当前决定 | 来源/状态 | 对执行的影响 |
|---|---|---|---|
| G1 | 项目名 Agent Nihil Obstat；`ano` 已被占用 | 用户选择 + 实测查重 | 使用完整 npm 名；CLI 保留 `ano` |
| G2 | TypeScript / JavaScript | 架构默认，用户未另选 | 只声明这两种；其他语言走插件且标未覆盖 |
| G3 | 希望覆盖热门客户端；**未明确同意真实会话采样** | 用户答复 | 建 adapter 与兼容矩阵；没有真实样本不标 validated；S1 只做机制段 |
| G4 | MIT，独立实现 | 用户选择 | 不读取/复制 obelisk 源码；仅公开规格/ADR |
| G5 | 未指定远程仓库或托管方式 | 待需要时询问 | 本地开发继续；不创建远程、不 push |
| G6 | `agent-nihil-obstat` | 用户选择 | 本地包名；发布前重新查重 |
| G7 | 未指定 profile 验证项目 | 待需要时询问 | 自身可作库候选但不能预设通过；服务 profile 不标 validated |
| G8 | 未指定 CI/部署/监控 | 按架构默认文件证据 | 不连云；只读明确指定的外部证据文件 |
| G9 | 内置 resolver；具体真实项目形态待实测 | 用户选择 | 相对路径 + 有测试的 paths/exports/workspace；其余 unknown |
| G10 | 禁止加载宿主项目 TypeScript | 用户选择 | 不使用宿主 node_modules 代码；必要时显式降级 |

## 不可越过的边界

- 不将“任务全部交给你”解释为对外发布、付费、隐私采样或接受其他许可证的授权。
- 不通过 MCP 暴露基线批准、具名 attestation、release approve 或 push。
- 机器 verdict 仅表示声明条件的证据状态，不表示产品正确或运营安全。
- 当 Phase 1 失败判据成立时，停止 Phase 2 及后续功能扩张，保留原始证据并修正设计。
