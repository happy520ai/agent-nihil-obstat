# P0 验收证据索引

| 项 | 文件 | 状态 |
|---|---|---|
| 执行总方案 | `docs/execution-plan.md` | 已交付 |
| 名称查重 | `docs/name-check.md` | 工程查询完成，商标未清 |
| S1 机制 | `docs/spikes/S1.md` + `docs/evidence/s1-search.json` | 22/22；无排序 |
| S2 解析 | `docs/spikes/S2.md` + `docs/evidence/s2-tree-sitter.json` | Node24/Windows 通过 |
| S3 HLC | `docs/spikes/S3.md` + `docs/evidence/s3-hlc.json` | 原型通过 |
| S4 库接入 | `docs/spikes/S4.md` + `docs/evidence/s4-codegraph.json` | 可接入，但不作核心依赖 |
| S5 崩溃 | `docs/spikes/S5.md` + `docs/evidence/s5-atomic-append.json` | 1636/1636；掉电未证 |
| S6 合并 | `docs/spikes/S6.md` + `docs/evidence/s6-segment-merge.json` | 通过 |
| S7 resolver | `docs/spikes/S7.md` + `docs/evidence/s7-module-resolution.json` | 合成通过 |
| 客户端 | `docs/client-compatibility.md` | 全 planned；无隐私采样 |
| 已知限制 | `docs/limitations.md` | 已发布到本地仓库，未公开发布 |

本索引不包含 P1 的“通过”状态；P1 必须另附端到端判定实验。
