# M18 连续三轮稳定性验收（T-155 / QF-06）

## 结论

同一冻结源码（pm-mcp 项目指纹 `5eb391c9535139e1a4429b7d03c994f33ee42fbab46181127ebd019d2389f43f`，566 个文件）连续三轮全量质量矩阵 **全部通过**：每轮 test/build/typecheck/coverage + scripts test/typecheck 六命令 exit 0，`ok=true`、`stable=true`；测试计数三轮完全一致 **2067 tests / 2067 passed / 0 failed / 0 skipped**（零 skip、零 fail）；coverage 每轮均为 `coverage_observed`。

## 三轮实测

| 轮次 | 报告 | ok | stable | tests | passed | failed | skipped | 行% | 分支% | 函数% |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | quality-20261125-134620-620-0000.json | true | true | 2067 | 2067 | 0 | 0 | 97.87 | 88.6 | 97.67 |
| 2 | quality-20261125-135209-998-0000.json | true | true | 2067 | 2067 | 0 | 0 | 97.88 | 88.62 | 97.67 |
| 3 | quality-20261125-135807-240-0000.json | true | true | 2067 | 2067 | 0 | 0 | 97.87 | 88.59 | 97.67 |

## 一致性判定

- **源码不变**：三轮 `source.after.sha256` 均为 `5eb391c9535139e1a4429b7d03c994f33ee42fbab46181127ebd019d2389f43f`，且每轮 before==after。
- **计数不变**：三轮 tests/passed/failed/skipped 完全一致。
- **覆盖率抖动**：分支百分比在 88.59–88.62% 之间（<0.05pp），来源是 V8 块覆盖对相同代码路径的计数抖动；三轮均显著高于 88% 阈值，且行/函数百分比波动不超过 0.01pp。按“每轮独立达标，不取平均”判定：**每轮均达标**。

## 关键协议回归与资源

- 关键协议套件在每轮全量中重复执行并通过：distributed-probe、ha-cluster/leader-lease、tcp-transport、replica 系、AnchorProbe、Ledger/Gate。
- 进程/socket/定时器清理由 `test/redteam/m17-stability.test.ts` 与 `test/integration/replica-chaos.test.ts`、`test/integration/m18-network-fuzz.test.ts` 断言（PID 差集为空、activeConnectionCount=0、端口可重绑），三轮均无残留。
- 三轮耗时稳定（test 65785/58579/62208ms，coverage 277328/278738/281623ms），无性能回退。

## 复现

```sh
for i in 1 2 3; do node scripts/orchestration/pm-bridge.mjs run_quality_matrix <args>; done
```

日志：D:/Temp/ano-m18-round1.log、D:/Temp/ano-m18-round2.log、D:/Temp/ano-m18-round3.log。失败与修复过程：本轮 M18 期间曾因并行写入导致 fingerprint 不稳定而 fail-closed 两次（quality-20261125-103434/130252），修复方式是等待写作者冻结后再跑，未放宽任何断言。
