# Changelog

## 0.1.0-alpha.0 — local development

### M23 Python L0/L1 接线（PY-09，未声明支持 Python）
- 结构构建按扩展名分派 TS/Python；`ENABLE_PYTHON_STRUCTURE` 默认关闭，关闭时 `.py`/`.pyi` 不进入图，现有 TS 行为与证据数值不变。
- 受支持扩展名单一来源改为 `structure/extractor.ts::SUPPORTED_STRUCTURE_EXTENSIONS`（默认仅 TS/JS），`hooks/pre-tool.ts` 直接派生，不再手写副本；开关关闭时改 `.py` 仍为 `UNSUPPORTED_LANGUAGE` 放行并标降级。
- `EXTRACTOR_VERSION` 升至 `p5-python-l1-v1`；启用 Python 的解析缓存使用 `+python` 版本后缀，避免与 TS-only 缓存互相复用。
- 默认扫描排除 `.pyc`（`__pycache__/**` 已在既有默认排除集中）；freshness 元数据快速路径同步排除，避免缓存快路径与内容指纹不一致。
- 图缓存键加入结构模式、`EXTRACTOR_VERSION` 与启用时的 Python 源根（`python.roots` / pyproject setuptools）；仅配置或源根变化也会触发重建，不静默复用旧图。启用时 freshness 把 `.py` 视为源文件，不会误报为 removed。
- 本条目只描述接线与开关状态，不表示已支持 Python；支持状态以 M23 两级验收门槛结果为准。

### M18 维护模式：分布式探针资源治理（T-157～T-160）
- 新增进程级/单节点在途上限与有界 FIFO 队列；队列满以 `DISTRIBUTED_PROBE_CAPACITY_EXCEEDED` 拒绝该节点，不阻塞其他节点。
- COMMITTED/QUORUM 达标后提前冻结：QUORUM 只在 `commit_index == primary` 的唯一多数派组上生效，低提交点仍完整 gather；迟到结果显式标记 `LATE_DISCARDED`，不进入证据。
- requestId 取消跨 IPC/TCP 传播：worker/服务端协作中止，迟到成功被抑制，重复取消幂等；无法协作时仅在该连接/子进程无其他在途请求时受控终止。
- 新增 `ResourceRegistry` 统一水位与可选进程关闭钩子；正常/取消/超时/崩溃/重复 close 后 pendingRequests/openSockets/liveChildren/activeTimers 归零。`resources_released` 仍是单次答案的逻辑标记，不等于集群关闭。
- 同语义性能对照与边界见 `docs/evidence/probe-lifecycle-benchmark.md` 和 `docs/limitations.md`；不包含 EWMA/动态负载均衡/线程池，不改变提交、证据或 Gate 语义。

### M18 最终质量收口与停止扩展契约
- M18 为最后一个质量里程碑；验收后只接受缺陷修复、环境适配和文档更新，不再自动扩展功能或创建后继功能里程碑。
- 冻结关键纯逻辑与安全分支、全仓覆盖率、代表性变异检错和连续三轮稳定验收要求；目标与已观测结果分开记录，不把历史报告当作当前源码证据。
- 原始基线与剩余边界见 `docs/evidence/final-quality-scope.md`；动态验收结果保存在 `.pm/`，以当前源码报告和主控 Gate 为准。
- 本地质量验收不是生产发布、生产 HA 保证或真实项目 cutover；这些动作仍需具名人工确认。

### P0/P1
- 完成 S1–S7 机制验证、名称与决策记录。
- 交付最小账本、源码指纹、TS/JS 图、三态覆盖和任务裁决。
- 修复账本 CRLF/缓存/并发锁、图覆盖、验证幂等和打包依赖问题。

### P2–P7（验收中）
- 完整账本、租约、迁移与并发验证。
- 调用图与 explore、Memory 合成 provider 与检索、Audit 与基线、Readiness 文件证据。
- 硬化、真实打包与端到端验收。

### Connect v1（M6 接入基础）
- 新增本地 PM-mcp 只读适配器、一键接入 CLI 与独立授权向导；目标项目无需 Node/Git。
- 来源业务完成状态与 ANO Gate 验收独立；原始资料内容寻址、版本保留、故障恢复、幂等对账及敏感退出包。
- MCP 仍为七工具；track 增加 connection 分支，recall 通过 source=connected 显式查询导入历史。
- 显式更新 recall/track schema pin；账本事件及 Gate 契约保持不变。
- 仅接入，不支持完整主写接管；默认不自动同步，新增显式前台 `connect watch` 只读刷新；仍不支持 ANO→PM 回写。

> 本文件随本地实现更新；未发布到 npm，未创建远程 Release。
