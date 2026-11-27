# M17 逐文件未覆盖分支基线与补测契约（T-143 / CV-01）

生成时间：2026-11-25 ｜ 环境：Windows 10.0.19041 x64，Node v24.14.0，Git Bash ｜ 机器可读版：`docs/evidence/m17-coverage-baseline.json`

## 0. 结论

当前全量 coverage 实测的 6 个目标文件行/分支百分比与用户给定基线**逐位一致（delta=0.00）**；本次补充了 functions%、全仓 src 分母、未覆盖行号分类与归属。全仓 `all files` 为 **行 94.47% / 分支 82.66% / 函数 93.57%**，距 M17 验收线（95.37 / 83.54 / 95.20）分别差 **0.90 / 0.88 / 1.63** 个百分点。六个模块中仅 `distributed-probe.ts` 已达行≥90，其余均未达模块档；`replica-worker.ts` 分支仅 50.68%，是最大缺口。

## 1. 当前真实基线 vs 用户基线

运行命令（权威）：

```bash
node --test --experimental-test-coverage "test/**/*.test.ts"
# 全仓分母（排除 test/scripts 自身）：
node --test --experimental-test-coverage --test-coverage-include='src/**/*.ts' "test/**/*.test.ts"
```

两次运行均 `exit 0`，1497 tests / 1496 pass / 0 fail / 1 skipped（唯一 skip 是 `scripts/spikes` 工具链缺失的显式 SKIP）。六文件两次运行数字完全一致，未覆盖行号取自报告 `uncovered lines` 列。

| 文件 | 行%（用户→实测） | 分支%（用户→实测） | 函数% | 行差 | 分支差 |
|---|---|---|---|---|---|
| `src/memory/replica-transport.ts` | 80.29 → 80.29 | 60.94 → 60.94 | 74.24 | 0.00 | 0.00 |
| `src/memory/replica-worker.ts` | 88.54 → 88.54 | 50.68 → 50.68 | 88.89 | 0.00 | 0.00 |
| `src/memory/tcp-transport.ts` | 87.47 → 87.47 | 72.89 → 72.89 | 81.30 | 0.00 | 0.00 |
| `src/memory/leader-lease.ts` | 88.15 → 88.15 | 75.49 → 75.49 | 80.72 | 0.00 | 0.00 |
| `src/memory/ha-cluster.ts` | 88.64 → 88.64 | 72.90 → 72.90 | 85.04 | 0.00 | 0.00 |
| `src/memory/distributed-probe.ts` | 90.84 → 90.84 | 79.18 → 79.18 | 86.87 | 0.00 | 0.00 |
| **全仓 src** | — → 94.47 | — → 82.66 | 93.57 | -0.90（对 95.37） | -0.88（对 83.54） |

> 分母说明：不带 `--test-coverage-include` 时 `all files` 会把 test/scripts 自身计入，得到 68.29/80.56/65.00，**不能用作验收口径**。六文件自身百分比与是否加 include 无关，两种运行一致。

### 1.1 阈值与缺口

| 对象 | 行% | 分支% | 函数% | 行缺口 | 分支缺口 |
|---|---|---|---|---|---|
| 全仓 | 94.47 | 82.66 | 93.57 | 0.90 | 0.88（函数缺 1.63） |
| replica-transport | 80.29 | 60.94 | 74.24 | 9.71 | 19.06 |
| replica-worker | 88.54 | 50.68 | 88.89 | 1.46 | 19.32（档 70） |
| tcp-transport | 87.47 | 72.89 | 81.30 | 2.53 | 7.11 |
| leader-lease | 88.15 | 75.49 | 80.72 | 1.85 | 4.51 |
| ha-cluster | 88.64 | 72.90 | 85.04 | 1.36 | 7.10 |
| distributed-probe | 90.84 | 79.18 | 86.87 | 0（已达行 90） | 0.82 |

模块档口径：transport / tcp / leader / ha / probe 行≥90 分支≥80；`replica-worker` 行≥90 分支≥70。原文只点名 transport/tcp/leader，ha-cluster 与 distributed-probe 按同一 90/80 档执行（CV-07 验收口径），如主控另有口径以本文件回写为准。

## 2. 分类矩阵（类别 → 行号 → 任务 → 测试文件 → 触发方式）

归属：CV-02 = `replica-transport.ts` + `replica-worker.ts`；CV-03 = `tcp-transport.ts`；CV-04 = `leader-lease.ts` + `ha-cluster.ts` + `distributed-probe.ts`。

### 2.1 `src/memory/replica-transport.ts`（CV-02，行 80.29 / 分支 60.94）

| 类别 | 未覆盖行 | 触发方式 | 预期测试文件 |
|---|---|---|---|
| RT-START-INVALID（启动参数非法） | 233-234, 236-237, 239-240, 242-243, 251-252 | fake-spawn（options.spawn 注入） | `test/integration/replica-process.test.ts`（扩展） |
| RT-STATUS-INVALID（畸形 status 响应） | 279-280, 283-284, 286-287, 289-290, 292-293, 296-297, 300-301 | fake-spawn / 恶意 workerPath | 新建 `test/integration/replica-transport-faults.test.ts` |
| RT-QUERY-INVALID（畸形 query 响应） | 326-327, 330-331, 334-335, 338-339, 341-342, 344-345, 347-348 | fake-spawn / 恶意 workerPath | 同上 |
| RT-APPLY-INVALID（畸形 apply 响应） | 366-367, 370-371, 375-376, 379-380 | fake-spawn / 恶意 workerPath | 同上 |
| RT-START-EXIT（init 期子进程退出） | 425-434 | real-subprocess（立即 exit(1)+stderr） | 同上 |
| RT-RESTART（重启失败/回退） | 466-467, 470-474 | real-subprocess | 同上 |
| RT-RESUME（maxChunks/取消） | 556-557, 562-563 | fake-spawn + AbortSignal | `test/integration/replica-process.test.ts` |
| RT-STDERR-CAPTURE（error/EPIPE） | 639, 646 | real-subprocess | 新建 faults 测试 |
| RT-NODE-EXIT-PENDING（挂起请求遇退出） | 678-681 | real-subprocess（挂起时 SIGKILL） | `replica-process.test.ts`（既有 kill 用例扩展） |
| RT-OVERSIZE-RESPONSE（超限/丢弃复位） | 693-697, 704-707, 709-712 | fake-spawn + 小 maxResponseBytes | 新建 faults 测试 |
| RT-MALFORMED-LINE（非协议行） | 722-730 | fake-spawn | 新建 faults 测试 |
| RT-TYPE-MISMATCH（响应类型错位） | 740-742 | fake-spawn | 新建 faults 测试 |
| RT-CANCEL（dispatch 前取消） | 763-764 | fake-spawn + AbortSignal | `replica-process.test.ts` |
| RT-CHILD-ERROR（ok=false 错误帧） | 781-783 | fake-spawn | 新建 faults 测试 |
| RT-VALIDATE-THROW（resolve 校验抛错） | 787-788 | fake-spawn | 新建 faults 测试 |
| RT-TIMEOUT（node 超时） | 799-801 | fake-spawn + 小 nodeTimeoutMs | `replica-process.test.ts` |
| RT-WRITE-FAIL（stdin 写失败） | 820-824（并覆盖 86-88 message()） | fake-spawn | 新建 faults 测试 |
| RT-VALIDATE-DEFAULT（防御性死分支） | 839 | 不可达 | 不补测试，登记为防御分支 |
| RT-SHUTDOWN-KILL（优雅关停→SIGTERM→SIGKILL→STOP_FAILED） | 848-849, 854-857, 859-862, 866-868 | real-subprocess（忽略 shutdown 的脚本） | 新建 faults 测试 |
| RT-KILL-CLEANUP（#kill/safeKill catch） | 878-891, 899-905 | real-subprocess | 新建 faults 测试 |
| RT-DIAGNOSTIC-GETTER（stderrOf） | 895-896 | fake-spawn | 新建 faults 测试 |
| RT-REMOTE-STORE-READS（RemoteReplicaStore 读接口/过滤） | 961, 965-968, 971-984, 987-999, 1002-1012, 1015-1016, 1030-1036 | fake-store（直接构造 read 回调） | 新建 `test/unit/replica-remote-store.test.ts` |

### 2.2 `src/memory/replica-worker.ts`（CV-02，行 88.54 / 分支 50.68）

| 类别 | 未覆盖行 | 触发方式 | 预期测试文件 |
|---|---|---|---|
| RW-VALIDATION-HELPER（fail() 未命中） | 149-151 | stream-loop 写非法入站 | 新建 `test/unit/replica-worker-protocol.test.ts` |
| RW-INIT-SNAPSHOT-INVALID | 225-226 | stream-loop | 同上 |
| RW-APPLY-BOUNDS（数组/scope） | 238-239, 242-243 | stream-loop | 同上 |
| RW-QUERY-SCHEMA（查询 schema 违规） | 251-254 | stream-loop | 同上 |
| RW-PARSE-REQUEST（坏 JSON/未知 type/payload 非对象） | 264-265, 273-274, 283-284 | pure-function | 同上 |
| RW-PARSE-RESPONSE（父侧解析器五分支） | 303-304, 309-310, 314-315, 321-322, 325 | pure-function | 同上 |
| RW-DOUBLE-INIT | 343-344 | stream-loop | 同上 |
| RW-SCOPE-DENIED | 376-380 | stream-loop | 同上 |
| RW-STDOUT-WRITE-FAIL | 467-469 | stream-loop（output 抛错） | 同上 |
| RW-FATAL（uncaught/unhandled） | 508-509 | stream-loop（子进程隔离） | 同上 |
| RW-HANDLELINE-INVALID | 515-517 | stream-loop | 同上 |
| RW-UNSUPPORTED-TYPE（防御性死分支） | 541-542 | 不可达 | 不补测试，登记 |
| RW-MESSAGE-TOO-LARGE（超限+discarding） | 550-557, 571-575, 582-585, 587-590 | stream-loop + 小 maxMessageBytes | 同上 |
| RW-HEARTBEAT-LOST（心跳丢失退出） | 608-613 | stream-loop（heartbeatMs>0，最小 tick 250ms） | `test/integration/replica-process.test.ts` |
| RW-DIRECT-GUARD-FALSE（argv[1] 缺失） | 629-630 | pure-function | 新建 protocol 测试 |

### 2.3 `src/memory/tcp-transport.ts`（CV-03，行 87.47 / 分支 72.89）

| 类别 | 未覆盖行 | 触发方式 | 预期测试文件 |
|---|---|---|---|
| TCP-CONFIG-NUMERIC | 164-165, 172-173, 446-447 | pure-function | 新建 `test/unit/tcp-frame-codec.test.ts` |
| TCP-PAYLOAD-SCHEMA（parsePayload/invalid/编码超帧） | 321-323, 329-332, 418-422 | pure-function | 同上 |
| TCP-HA-VALIDATORS（六个冻结校验器失败分支） | 369-372, 375-378, 381-384, 387-390, 393-396, 399-402 | pure-function | 同上 |
| TCP-DECODER-GETTER（bufferedBytes） | 453-454 | pure-function | 同上 |
| TCP-SERVER-CONFIG（server options 拒绝） | 642-643, 645-646, 648-649, 652-653, 656-657, 674-675, 678-679 | real-socket | `test/integration/tcp-transport.test.ts` |
| TCP-NONCE-BOUND（重插/淘汰） | 712-715, 718-721 | real-socket（小容量） | `tcp-transport.test.ts`（扩展） |
| TCP-LISTEN-LIFECYCLE（closed/inconsistent/error/sync/address） | 765-766, 768-770, 787-791, 796-801, 812-819, 824-825 | real-socket（端口占用/非法 host） | 新建 `test/integration/tcp-connection-lifecycle.test.ts` |
| TCP-SERVER-CONNECTION（socket error/idle/handshake timeout） | 881-885, 889, 894, 927 | real-socket | 同上 |
| TCP-AUTH-GATE（未握手/nodeId null） | 947-949, 1010-1012 | real-socket | `test/redteam/tcp-transport-boundary.test.ts` |
| TCP-SERVICE-ERROR（handler/结果/超时） | 956-958, 1060-1061, 1070-1076, 1088 | real-socket | `tcp-transport.test.ts` |
| TCP-AUTHORIZE（回调三分支/fail-closed） | 1107-1112, 1114 | real-socket | `tcp-transport-boundary.test.ts` |
| TCP-WRITE-PATH（写失败/sendFailureThenDestroy） | 1132-1137, 1156-1158, 1170-1171 | real-socket | 新建 lifecycle 测试 |
| TCP-CLIENT-CONFIG | 1227-1228, 1230-1231, 1233-1234, 1236-1237, 1240-1241, 1244-1245 | real-socket | `tcp-transport.test.ts` |
| TCP-CLIENT-GETTERS（isConnected/isClosed） | 1294-1295, 1298-1299 | real-socket | 新建 lifecycle 测试 |
| TCP-CONNECT-LIFECYCLE（取消/关闭/超时） | 1305-1307, 1512-1515, 1518-1521, 1528-1533, 1536-1539 | real-socket | 新建 lifecycle 测试 |
| TCP-REQUEST-PATH（未连接/hello 直发/pending 上限/超大帧/写失败） | 1337-1338, 1340-1341, 1346-1347, 1354-1355, 1385-1389 | real-socket | 新建 lifecycle 测试 |
| TCP-RESPONSE-VALIDATE（query/apply 结果） | 1400-1401, 1419-1420 | real-socket | `tcp-transport.test.ts` |
| TCP-NODEQUERY（createNodeQuery 未用） | 1434-1436 | real-socket | `tcp-transport.test.ts` |
| TCP-HANDSHAKE（超时/缺 nonce/socket 不可用/编码写失败） | 1550, 1561-1562, 1576-1577, 1583-1584, 1595-1596, 1604-1607 | real-socket（假 server） | `tcp-transport-boundary.test.ts`（扩展） |
| TCP-FRAMING-FATAL（解码致命/kind 错位/不可归类） | 1616-1619, 1630-1632, 1644-1645 | real-socket | `tcp-transport-boundary.test.ts`（扩展） |

### 2.4 `src/memory/leader-lease.ts`（CV-04，行 88.15 / 分支 75.49）

| 类别 | 未覆盖行 | 触发方式 | 预期测试文件 |
|---|---|---|---|
| LL-TOPOLOGY-VALIDATION（拓扑/voter/manager 校验） | 333-334, 342-343, 350-351, 355-356, 367-369, 374-375, 380-381, 383-384, 386-387, 389-390, 395-399, 481-482, 484-485, 489-490, 492-493 | in-memory-clock / fake-voter-rpc | `test/unit/leader-lease.test.ts` |
| LL-UNUSED-GETTERS（member_id/members/votingCount/quorumSize/transitions） | 513-514, 517-518, 521-522, 525-526, 592-597 | in-memory-clock | `test/unit/leader-lease.test.ts` |
| LL-ELECTION-REJECTED-OUTCOME | 664-666 | fake-voter-rpc（rejected Promise） | `test/unit/leader-lease.test.ts`（扩展） |
| LL-VOTE-REFUSALS（自投票/旧 epoch/旧 term） | 729-730, 732-733, 735-736 | fake-voter-rpc | `test/unit/leader-lease.test.ts` |
| LL-RENEW-NOT-LEADER | 770-778 | fake-voter-rpc | 同上 |
| LL-LEASE-EXPIRED（续约时过期） | 780-790 | in-memory-clock | 同上（既有过期用例扩展） |
| LL-NEWER-LEADER（见到新主降级） | 840-856 | fake-voter-rpc | 同上 |
| LL-HEARTBEAT-STALE | 933 | fake-voter-rpc | 同上 |
| LL-OBSERVE（unchanged/refreshed/adopted） | 951-958, 977-978, 981-996 | fake-voter-rpc | 同上 |
| LL-FENCE-AHEAD（term 超前） | 1025-1026 | in-memory-clock | 同上（fencing 扩展） |
| LL-COMMIT-INDEX-INVALID | 1047-1048 | in-memory-clock | 同上 |
| LL-REJOIN-RPC-FAIL | 1091-1092 | fake-voter-rpc | `test/integration/leader-lease.test.ts` |
| LL-FETCH-INVALID | 1137-1138 | fake-voter-rpc | 同上 |
| LL-STATE-CALLBACK（回调抛错被吞） | 1192-1197 | in-memory-clock | `test/unit/leader-lease.test.ts`（扩展） |
| LL-FAULT-VALIDATION（partition/isolate/setDelay） | 1278-1279, 1282-1283, 1285-1286, 1295-1296, 1301-1305 | in-memory-clock | 新建 `test/unit/leader-lease-faults.test.ts` |
| LL-FAULT-SNAPSHOT | 1325-1336 | in-memory-clock | 同上 |
| LL-FAULT-DELAY（真实短延迟） | 1341-1344 | in-memory-clock（≤200ms） | 同上 |
| LL-VOTER-GETTER | 1377-1378 | fake-voter-rpc | 同上 |
| LL-VOTER-UNREGISTERED | 1399-1400 | fake-voter-rpc | 同上 |
| LL-TCP-ADAPTER-UNTESTED（整个类零覆盖） | 1430, 1434-1437, 1440-1441, 1444-1445, 1448-1449, 1452-1453 | compile-time seam（send 注入） | 可选新建 `test/unit/leader-lease-tcp-adapter.test.ts`；否则显式登记为 untested-seam |

### 2.5 `src/memory/ha-cluster.ts`（CV-04，行 88.64 / 分支 72.90）

| 类别 | 未覆盖行 | 触发方式 | 预期测试文件 |
|---|---|---|---|
| HAC-SYNC-VALIDATION（自定义同步项校验/issueText） | 233-234, 236-237, 239-240, 270-272 | pure-function | 新建 `test/unit/ha-cluster-sync.test.ts` |
| HAC-FRAME-DECODE（长度/超帧/JSON/信封） | 304-306, 308-313, 321-323, 326-328 | pure-function | 同上 |
| HAC-SERVER-ADDRESS | 371-372 | real-socket | `test/integration/ha-split-brain.test.ts` |
| HAC-SERVER-LISTEN（重复/非 loopback/失败/无地址） | 385-387, 389-390, 395-398, 411-412, 416-418 | real-socket | 同上（扩展启动失败） |
| HAC-SERVER-CONNECTION（关闭竞态两处） | 451-453, 473-475 | real-socket | 同上 |
| HAC-SERVER-HANDLER（catch/失败应答/drop） | 487-492, 497-501, 506-507 | real-socket | 同上 |
| HAC-CLIENT-STATE（closed/target/socket/编码） | 549-550, 554-555, 558-559, 580-581, 589-590 | real-socket | 同上（客户端负例） |
| HAC-CLIENT-IO（写失败/closed/target 变更/connect 包装） | 607-610, 616-617, 620-622, 626-630 | real-socket | 同上 |
| HAC-CONNECT（非 loopback/超时/error/close） | 641-643, 647-650, 659-662, 665-668 | real-socket | 新建 `test/integration/tcp-connection-lifecycle.test.ts`（可共用） |
| HAC-SOCKET-EVENTS（error/close） | 681-682, 685-686 | real-socket | `ha-split-brain.test.ts` |
| HAC-FRAME-ERROR（坏帧/失败帧/拒绝挂起） | 698-701, 709, 715-717 | real-socket | `test/redteam/ha-split-brain-boundary.test.ts`（扩展） |
| HAC-CONFIG-POSITIVE | 735-736 | real-socket | `ha-split-brain.test.ts` |
| HAC-VOTER-GETTER | 760-761 | real-socket | 同上 |
| HAC-REPLICA-STATUS（HaNode 内置 status 服务未调用） | 870-881 | real-socket（TcpReplicaClient.status） | 同上（replica 服务冒烟） |
| HAC-UNSUPPORTED-KIND | 985 | real-socket（畸形 kind） | `ha-split-brain-boundary.test.ts` |
| HAC-CLUSTER-VALIDATION（memberIds/host） | 1150-1151, 1154-1155 | real-socket | 同上 |
| HAC-PROPOSE-VALIDATION（writerId/哈希不一致） | 1231-1232, 1243-1244 | real-socket | 同上 |
| HAC-PROPOSE-ACK（ack_nonce/voter_id/rejected） | 1283-1284, 1286-1287, 1301 | real-socket（伪造响应） | 同上（伪造多数派扩展） |
| HAC-RIVAL-LEADER | 1405-1406 | real-socket | 同上 |
| HAC-CLOSE-PARTIAL（节点/代理关闭吞错） | 1554-1555, 1561-1562 | real-socket | `ha-split-brain.test.ts` |
| HAC-AGGREGATION（聚合排序比较器） | 1590-1592 | real-socket（≥2 条 adjudication） | 同上 |
| HAC-ERROR-CODE（errorCodeOf UNKNOWN） | 1650-1652 | real-socket | 同上 |
| HAC-ADJUDICATION（adjudicateNewestBranches 整段） | 1655-1657, 1672-1712 | real-socket（rejoin 带回已提交分叉） | `ha-split-brain-boundary.test.ts`（旧主恢复+分叉扩展） |

### 2.6 `src/memory/distributed-probe.ts`（CV-04，行 90.84 / 分支 79.18）

| 类别 | 未覆盖行 | 触发方式 | 预期测试文件 |
|---|---|---|---|
| DP-OPTIONS-INVALID | 355-356, 359-360, 363-364, 378-382, 384-385 | fake-node | `test/unit/distributed-probe.test.ts` |
| DP-FALLBACK-SNAPSHOT | 414-422 | fake-node | 同上 |
| DP-EDGE-DEDUPE（去重命中/比较器） | 629-633, 635-637 | fake-node | 同上（gather 扩展） |
| DP-MERGED-STORE（adjacency/evidence/status/provenance/snapshotIdentity/find） | 688, 692-705, 708-720, 723-733, 736-737, 740-741 | fake-node | 同上（store 读接口） |
| DP-NODE-SNAPSHOT-FAIL | 768-769 | fake-node | `test/redteam/distributed-probe-boundary.test.ts` |
| DP-NODE-DEADLINE（dispatch 前耗尽） | 795-796 | fake-node + now 注入 | `test/unit/distributed-probe.test.ts` |
| DP-NODE-CANCELLED（三路径） | 798-799, 809-811, 822-823 | fake-node + AbortSignal | 同上 |
| DP-NODE-RESPONSE-INVALID（四类伪造响应） | 862-863, 865-866, 869-870, 875-876 | fake-node | `distributed-probe-boundary.test.ts` |
| DP-NODE-COMMIT-UNKNOWN | 893-894, 901-902 | fake-node | `test/unit/distributed-probe.test.ts` |
| DP-NODE-UNSERVICEABLE（REVOKED/FAILED/SUSPECT/JOINING） | 908-909 | fake-node | `distributed-probe-boundary.test.ts` |
| DP-SCATTER-ABORT | 949-951 | fake-node | `test/unit/distributed-probe.test.ts` |
| DP-CONSISTENCY（UNKNOWN/PARTIAL） | 978-979 | fake-node | 同上 |
| DP-LOCAL-ACCESS（本地四容错分支） | 1146-1147, 1155-1156, 1164-1165, 1172-1173 | fake-node | 同上 |
| DP-CALL-VALIDATION | 1259-1260, 1262-1263, 1266-1267 | fake-node | 同上 |
| DP-DEGRADE-PRIMARY-UNKNOWN（QUORUM 本地降级） | 1493-1494 | fake-node | 同上（模式矩阵扩展） |
| DP-CANCELLED-ANSWER（整段取消应答） | 1540-1569 | fake-node（scatter 后 abort） | 同上 |
| DP-TIMEOUT-FLAG | 1572-1575 | fake-node | 同上 |
| DP-DIGEST-FALLBACK | 1652-1653 | fake-node | 同上（扩展） |

## 3. 测试缝契约

### 3.1 确定性缝（优先，禁止长 sleep）

| 缝 | 位置 | 用途 | 规则 |
|---|---|---|---|
| 可注入时钟 | `LeaderLeaseManagerOptions.now`、`createLeaderLeaseCluster.now/nowForMember`、`HaClusterOptions.now` + `advanceClock()` | 租约过期、续约、墙钟回拨诊断 | 过期必须用 `now()` 推进，不得真实等待 |
| fake VoterRpc / 内存网格 | `leader-lease.ts` `VoterRpc`、`InMemoryVoterRpc` + `InMemoryFaultController`（partition/isolate/setDelay） | 旧 epoch、错误 leader_id、多数派丢失、旧主恢复、重复提案、慢节点 | 确定性优先；`latencyMs/delayMs ≤ 200ms` |
| fake 节点/store | `distributed-probe.ts` `DistributedReplicaNode`/`ProbeStore`/`DistributedProbeOptions.now` | 慢节点、伪造摘要、混合版本、重复冲突、本地降级、取消 | store/query 可控延迟或异常；摘要必须由 `digestCandidates` 重算比对 |
| 纯解析函数 | tcp `encode/decode/parse*/assertMwha*`；worker `parseWorkerRequest/Response`；ha `HaFrameDecoder` | 非法帧/超大帧/畸形负载 | 直接调用，不启 socket/进程 |
| worker 流循环 | `runReplicaWorker({input, output, errorOutput, heartbeatMs, maxMessageBytes})` | 错误帧、非法响应、超限、背压、心跳 | 用 `PassThrough` 驱动；`terminate()` 收尾；`process.exit` 路径放子进程隔离 |
| spawn 覆写 | `ReplicaStartOptions.spawn/workerPath/env` | 启动失败、异常退出、重启、停止竞态 | 能注入伪 spawn 的优先注入；必须真实进程时用临时脚本 |

### 3.2 必须真实 socket / 子进程（集成）

| 场景 | 位置 | 规则 |
|---|---|---|
| TLS/HMAC 失败、非 loopback 明文、断线、关闭竞态、端口复用 | `TcpReplicaServer/Client`、`HaTcpServer/Client`、`tcp-fault-proxy` | 仅 127.0.0.1/::1、端口 0（ephemeral）；结束断言 `activeConnectionCount===0` 且端口可重绑 |
| 子进程退出、pid 回收、Windows 竞态 | `ChildProcessReplicaTransport` | 有界轮询等待 exit，不上无限 sleep |

### 3.3 时序与清理断言

- 单次真实等待上限 **200ms**；优先事件/回调/轮询，步长 ≤20ms。Windows 进程回收单独放宽到 **500ms 有界**。
- 禁止固定长 sleep（>200ms）、禁止直接跑默认 5s/60s 超时来“等结果”。
- 清理断言：`stop` 后 `process.kill(pid,0)` 抛 `ESRCH`；`activeConnectionCount===0`；`close()` 幂等；`server.close()` 后同 host:port 可重新 listen；listener 无残留。
- Windows 竞态：`exit` 可能晚于 pid 回收 → 有界轮询确认消失；管道销毁可能延迟 → 不断言立即 EOF，只断言最终释放 + 句柄可回收；只断言“进程不再存活”，不断言退出码/信号值。

## 4. 指标口径（写入验收）

1. **全仓**：`node --test --experimental-test-coverage --test-coverage-include='src/**/*.ts' "test/**/*.test.ts"` 的 `all files` 必须 行≥**95.37%**、分支≥**83.54%**、函数≥**95.20%**。
2. **模块**：transport / tcp / leader / ha / probe 行≥**90** 分支≥**80**；`replica-worker` 行≥**90** 分支≥**70**（其余如实报告）。当前仅 `distributed-probe` 行达标。
3. **不计入作弊**：不得 `--test-coverage-exclude` 排除源码；不得在 src 添加 ignore 注释或改统计口径；不得新增 skip/todo 或隐藏既有失败；既有 1 个 spike skip 必须保持可见；不得堆正常路径充数——每个未覆盖类别必须有对应异常断言。
4. **稳定性**：关键测试连续 **3 次**通过；红队/竞态类测试重复运行不得偶发失败。
5. **缺陷优先**：测试暴露真实缺陷时先修缺陷再重算覆盖率。

### 4.1 无 skip / 无泄漏口径

- 覆盖率只认“被执行到的分支”，skip 的测试不算覆盖；新增测试不得使用 `skip`/`todo`/`only` 规避。
- 资源泄漏判据与覆盖率分开记录：进程存活、连接计数、端口可重绑、监听器数量。任何“覆盖率达标但仍有句柄/进程残留”的测试不得判绿。
- 本任务只做基线，不新增测试；CV-06 负责重复运行与泄漏验收，CV-07 负责全仓复算。

## 5. 已知边界（Windows / 本机环境）

- 本机 Windows 10.0.19041 + Node v24.14.0，Git Bash；npm 脚本在 Windows 下运行。
- Windows 子进程 `exit` 事件与 pid 回收存在竞态，进程断言必须有界轮询。
- TCP/TLS 仅验证 127.0.0.1/::1；物理跨机、生产 HA 故障切换、OS 真分区、可用性 SLA 不在范围内（见 `TCP_TRANSPORT_UNVERIFIED_BOUNDARIES` / `MWHA_UNVERIFIED_CAPABILITIES`）。
- TLS 使用测试自签证书；CI 若无证书生成工具，相关用例应显式跳过并打印，不得静默。
- 本文件数字为 2026-11-25 快照，后续 CV 任务会改变覆盖率。

## 6. 初步发现（本任务不修，仅登记）

| ID | 严重度 | 位置 | 线索 |
|---|---|---|---|
| F-1 | low | `replica-transport.ts:670` | `#requireLive` 错误模板有多余字面量 `}`：实际消息会出现 `)}; pending=0`。仅诊断文本，建议 CV-02 修。 |
| F-2 | info | `replica-worker.ts:540-542` | `handleLine` default 分支不可达（parseWorkerRequest 已限定 type）。防御性死分支，不宜堆测试。 |
| F-3 | info | `replica-transport.ts:838-839` | `#validate` default 分支不可达（调用方只传四种 type）。防御性死分支。 |
| F-4 | info | `leader-lease.ts:1428-1454` | `TcpVoterRpcAdapter` 整类零覆盖且注释声明 T-139 才接线；属未验证 seam，建议最小契约测试或显式登记。 |
| F-5 | info | `ha-cluster.ts:1672-1712` | `adjudicateNewestBranches` 循环体从未执行；rejoin 未构造“同步回来的分叉且两条都 committed”。核心承诺测试缺口。 |
| F-6 | info | `replica-transport.ts:722-730` | 畸形行分支用 `[...entries()].find(...)` 反查 id，已有 oldest 引用，冗余 O(n)。性能线索，非缺陷。 |

## 7. 复现命令与验证输出

```bash
# 覆盖率（六文件行/分支/函数 + uncovered lines；全仓 all files 用第二条）
node --test --experimental-test-coverage "test/**/*.test.ts"
node --test --experimental-test-coverage --test-coverage-include='src/**/*.ts' "test/**/*.test.ts"

# 类型检查（证明未改源码）
npx tsc -p tsconfig.json --noEmit

# 文档一致性
node scripts/check-docs.ts
```

实测摘要（2026-11-25）：coverage 两次 exit 0（1497 tests / 1496 pass / 0 fail / 1 skip）；`tsc --noEmit` exit 0；`check-docs` 输出 “Generated tool catalog is current.” 且 exit 0。
