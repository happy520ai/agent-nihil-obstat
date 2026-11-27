# M18 变异测试与有界 fuzz 报告（T-154 / QF-05）

## 结论

代表性变异 **6/6 全部被真实断言检出**（detectionRate = 1.0），0 survived、0 harness-error；源码树前后哈希一致（166 文件），变异只在 `os.tmpdir()` 独立副本中进行，副本已清理。有界确定性 fuzz 覆盖帧/状态与真实回环网络序列，均为固定种子、固定预算。

**边界**：变异集是代表性样本，不是穷举；fuzz 是有界子集，不是网络状态机的完整枚举；不含跨机/OS 真分区/TLS 内部帧注入。

## 方法与可复现命令

```sh
# 隔离变异（手工执行，不进入 npm test）
node scripts/mutation-check.ts --out <临时目录>/mutation.json

# harness 纯逻辑 + 帧/状态有界 fuzz（毫秒级，进普通套件）
node --test test/mutation/critical-semantics.mutation.test.ts

# 真实回环网络序列 fuzz（固定种子/预算）
node --test test/integration/m18-network-fuzz.test.ts
```

隔离机制（`scripts/mutation-check.ts` + `test/helpers/m18-mutation-harness.ts`）：
- 复制 `src/test/package/tsconfig` 到 tmpdir，`node_modules` 用 junction 共享只读；
- 每个 anchor 必须先验证在工作树中**唯一匹配**，0/多次匹配记为 harness-error 而非 kill；
- 基线 detector 测试必须先全绿；kill 只认真实 TAP 断言失败；超时/语法/导入失败一律 harness-error；
- `finally` 清理副本，并对源码树 hash 前后比对。

## 本次实测结果

| ID | 类别 | 变异 | 目标不变量 | 检出测试 |
|---|---|---|---|---|
| M1 | 比较符 | `leader-state.compareDeclarations` 去掉 term tie-break | 声明顺序 (epoch, term, leader) | `test/unit/leader-state-complete.test.ts` — declarationKey/compareDeclarations order |
| M2 | epoch | `leader-lease` 投票 epoch `<` → `<=` | epoch 回退拒绝 | `test/unit/leader-lease.test.ts` — inbound vote requests refuse epoch rollback |
| M3 | 去重 | `probe-merge.dedupeKey` 去掉 status | 同 ref 异状态保留为冲突 | `test/unit/probe-merge-complete.test.ts` — status variants separate |
| M4 | 错误码 | 超帧 `TCP_FRAME_TOO_LARGE` → `TCP_FRAME_INVALID` | 帧大小错误码稳定 | `test/unit/tcp-frame-codec.test.ts` — refuses bodies above the ceiling |
| M5 | 清理 | `tcp-transport.rememberBounded` 去掉淘汰 | 有界表淘汰最旧 challenge | `test/integration/tcp-transport.test.ts` — evicts the oldest pending challenge |
| M6 | 授权 | `cluster-policy` scope includes 取反 | 跨 scope 拒绝、允许 scope 放行 | `test/unit/cluster-policy.test.ts` — T-129/01、T-129/18 |

汇总：`killed 6 / survived 0 / harness-error 0 / total 6`，`detectionRate 1.0`，`baselineOk true`，`sourceUnchanged true`。

## 有界确定性 fuzz

| 范围 | 种子 | 预算 | 结果 |
|---|---|---|---|
| 帧编解码（真实 `encodeTcpReplicaFrame` / `TcpReplicaFrameDecoder`） | 154 | 96 例 | 通过；断言边界拒绝码与往返一致 |
| leader/HLC 状态（真实 `compareDeclarations` / `Hlc`） | 154 | 96 组 | 通过；断言反对称性、相等为 0、物理时间单调 |
| 真实回环网络序列（`TcpReplicaServer/Client` + `TcpFaultProxy`） | 20261125 | 12 固定 case / 每例 20s / poll 2s | 17 断言全通过，覆盖 7 种稳定错误码 |

网络序列清单：handshake-timeout-server/client、idle-timeout-reconnect、half-close-peer、reset-peer、oversized-frame-interleaved、malformed-frame-interleaved、nonce-replay、challenge-mismatch、repeated-challenge-mismatch、proxy-disconnect-reconnect、proxy-one-way-partition。每例断言：稳定错误码、未越权（outsider 恒 `TCP_AUTH_UNKNOWN_NODE`）、可恢复处恢复可用、连接清理为 0。

## 未覆盖（明确不宣称）

- TLS 内部帧级注入（TLS 记录对代理不透明）；
- OS 真分区、内核协议栈故障、物理链路中断；
- 带宽/IP 层乱序/多主机复制；
- 并发多 peer 握手；
- 已完成认证后 challenge 的真实重放（现用例只重复 challenge 不匹配）；
- 传输层网络状态机的完整枚举。
