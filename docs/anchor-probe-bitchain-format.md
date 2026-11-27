# AnchorProbe BitChain 物理格式（T-059 / AP-22）

- 日期：2026-11-22
- 状态：实验实现已落地（`src/memory/probe-store-bitchain.ts`），**未接线、未默认启用**
- 范围：可选 `ProbeStore` 后端；SQLite 仍是基线，账本仍是权威
- 适用：需要评估“定长块头 + 有界段 + 跨段关系 + 按需载荷”时的被测后端与导出格式

本文件固定格式字段、校验范围、重建与回退语义。实现与本文不一致时以本文为准并修正实现；
`test/unit/probe-store-bitchain.test.ts` 断言两者一致。

## 1. 定位与硬边界

- BitChain 是**可重建缓存**，不是新的主写真值源。每条记录内容都由同一批已提交
  `ViewReplayEntry[]` 经 `src/ledger/views.ts` 投影重放得到，与
  `ProjectedProbeStore` / `SqliteProbeStore.rebuild` 使用同一输入。
- 删除该文件不丢失任何已提交事实：用同一批事件重放即可重建，同请求同结果。
- 摘要（`content_hash`、`body_hash`、`segment_hash`、`index_hash`）只用于完整性与
  诊断，**不替代原文**：记录尾必须保存完整投影记录，读取时按原文重算
  `content_hash` 并比对固定头。
- 不写入 Surface 默认路径，不注册全局后端，不改变七工具行为。仅测试与显式导出可用。
- 纯 `node:buffer` / `node:fs` 实现，无原生依赖；**不宣称**已具备原生 mmap 或掉电级
  持久性。写路径为临时文件 + `rename`；Windows 目录 fsync 的既有限制仍然适用。

## 2. 文件布局

```
┌──────────────────────────── 0 ────────────────────────────┐
│ Header (128 B, 固定)                                        │
│   magic / version / endian / 参数 / 三区偏移与长度 / 计数    │
│   body_hash (sha256, 32 B)                                  │
├────────────────────────── 128 ─────────────────────────────┤
│ Record region（不可变记录区）                                │
│   Segment 0: header(64 B) + payload                         │
│   Segment 1: header(64 B) + payload                         │
│   ...  段满续段；目录记录精确 (segment, offset, length)       │
├─────────────────────────── ... ────────────────────────────┤
│ Index region（可变索引区）                                   │
│   index header(80 B) + record directory + adjacency list     │
├─────────────────────────── ... ────────────────────────────┤
│ Manifest（canonical JSON，UTF-8）                           │
│   格式版本、计数、source_digest、snapshot、header_hash 等    │
└─────────────────────────── end ───────────────────────────┘
```

所有整数均为**小端**。文件没有自哈希：校验分层如下，合起来覆盖每个字节。

## 3. Header（128 B，偏移 0）

| 偏移 | 长度 | 类型 | 字段 | 说明 |
|---|---|---|---|---|
| 0 | 8 | ASCII | `magic` | 固定 `ANOBITC1` |
| 8 | 2 | u16 | `version` | 固定 `1` |
| 10 | 2 | u16 | `endian` | 固定 `0x1234`；字节颠倒时读作 `0x3412`，直接拒绝 |
| 12 | 4 | u32 | `record_header_bytes` | 记录固定头大小，允许 `64 / 96 / 128` |
| 16 | 8 | u64 | `segment_bytes` | 每段 payload 容量上限（字节） |
| 24 | 8 | u64 | `record_region_offset` | 必须等于 `128` |
| 32 | 8 | u64 | `record_region_length` | |
| 40 | 8 | u64 | `index_region_offset` | 必须等于 `128 + record_region_length` |
| 48 | 8 | u64 | `index_region_length` | |
| 56 | 8 | u64 | `manifest_offset` | 必须等于 `index_region_offset + index_region_length` |
| 64 | 8 | u64 | `manifest_length` | 必须满足 `manifest_offset + manifest_length == file.length` |
| 72 | 8 | u64 | `record_count` | 与 manifest、目录一致 |
| 80 | 8 | u64 | `edge_count` | 与 manifest、邻接表一致 |
| 88 | 32 | bytes | `body_hash` | `sha256(record_region ‖ index_region ‖ manifest)` |
| 120 | 8 | bytes | reserved | 全零 |

## 4. Record region（不可变记录区）

### 4.1 Segment header（64 B）

| 偏移 | 长度 | 类型 | 字段 | 说明 |
|---|---|---|---|---|
| 0 | 8 | ASCII | `magic` | 固定 `ANORSEG1` |
| 8 | 8 | u64 | `segment_index` | 从 0 起严格递增 |
| 16 | 8 | u64 | `record_count` | 本段记录数 |
| 24 | 8 | u64 | `payload_length` | header 之后的 payload 字节数 |
| 32 | 32 | bytes | `segment_hash` | `sha256(payload)` |

### 4.2 Segment payload

重复 `record_count` 次：

| 长度 | 类型 | 字段 | 说明 |
|---|---|---|---|
| 4 | u32 | `frame_length` | 其后记录字节数 |
| `frame_length` | bytes | `record` | 固定头 + 记录尾 |

读取按 `record_count` 逐条消费，结束后 payload 必须恰好用尽（无尾随字节）。

### 4.3 记录固定头（`record_header_bytes` ∈ {64, 96, 128}）

| 偏移 | 长度 | 类型 | 字段 | 说明 |
|---|---|---|---|---|
| 0 | 32 | ASCII | `record_ref` | NUL 填充；26 字符 Crockford ULID |
| 32 | 32 | bytes | `content_hash` | 原始 32 字节，等于 `sha256(canonicalJson({kind,text,anchor?}))` |
| 64 | 8 | u64 | `tail_offset` | 仅 H≥96；必须等于 H |
| 72 | 4 | u32 | `tail_length` | 仅 H≥96；必须等于记录总长减 H |
| 76 | 1 | u8 | `status` | 仅 H≥96：0 active / 1 superseded / 2 conflicted / 3 retracted |
| 77 | 1 | u8 | `eligibility` | 仅 H≥96：0 governed / 1 legacy_unreviewed |
| 78 | 1 | u8 | `source_kind` | 仅 H≥96：0 native_note / 1 code_read / 2 connected / 3 history / 4 unknown |
| 79 | 1 | u8 | reserved | 仅 H≥96；零 |
| 80 | 4 | u32 | `version` | 仅 H≥96；投影派生深度，非身份 |
| 84 | 8 | i64 | `recorded_at` | 仅 H≥96；Unix 毫秒 |
| 92 | 8 | i64 | `effective_from` | 仅 H=128；`null` 编码为 `-1` |
| 100 | 8 | i64 | `effective_to` | 仅 H=128；`null` 编码为 `-1` |
| 108 | 2 | u16 | `flags` | 仅 H=128；保留零 |
| 110 | 18 | bytes | reserved | 仅 H=128；零 |

H=64 时固定头只有 `record_ref` 与 `content_hash`，其余字段全部由记录尾提供；
H=96/128 的字段是记录尾的**缓存**，读取时必须与记录尾一致，冲突即拒绝。

### 4.4 记录尾（canonical JSON，UTF-8）

保存完整投影记录（`MemoryRecord`）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `record_ref` | string | 必须等于固定头 |
| `fact_key` | string \| null | |
| `kind` | string | |
| `text` | string | 原文；`content_hash` 由它和 `kind`/`anchor` 重算 |
| `anchor` | object \| null | 投影记录里的 anchor 或 null |
| `note_id` | string \| null | |
| `status` | string | 状态枚举 |
| `eligibility` | string | 资格枚举 |
| `supersedes_ref` | string \| null | |
| `superseded_by` | string \| null | |
| `content_hash` | string | 必须等于固定头与重算值 |
| `recorded_at` | string | ISO-8601 |
| `effective_from` | string \| null | 显式 null 表示未知，不用 `recorded_at` 回填 |
| `effective_to` | string \| null | |
| `version` | number | 非负整数 |
| `event_id` | string | 引入事件的账本 ID |

## 5. Index region（可变索引区）

### 5.1 Index header（80 B）

| 偏移 | 长度 | 类型 | 字段 | 说明 |
|---|---|---|---|---|
| 0 | 8 | ASCII | `magic` | 固定 `ANOINX01` |
| 8 | 2 | u16 | `version` | 固定 `1` |
| 10 | 2 | u16 | `flags` | 保留零 |
| 12 | 8 | u64 | `record_count` | |
| 20 | 8 | u64 | `edge_count` | |
| 28 | 8 | u64 | `directory_offset` | 必须等于 `80` |
| 36 | 8 | u64 | `adjacency_offset` | 必须等于 `80 + record_count * 48` |
| 44 | 4 | bytes | reserved | 零 |
| 48 | 32 | bytes | `index_hash` | `sha256(index[0..48] ‖ index[80..end])` |

### 5.2 Record directory entry（48 B，按 `record_ref` 严格升序且唯一）

| 偏移 | 长度 | 类型 | 字段 | 说明 |
|---|---|---|---|---|
| 0 | 32 | ASCII | `record_ref` | NUL 填充 |
| 32 | 8 | u64 | `segment_index` | |
| 40 | 4 | u32 | `offset_in_segment` | 指向 segment payload 中 4 字节帧长前缀 |
| 44 | 4 | u32 | `total_length` | 帧长，必须与记录一致 |

### 5.3 Adjacency entry（72 B，按 `from,to,kind` 升序）

| 偏移 | 长度 | 类型 | 字段 | 说明 |
|---|---|---|---|---|
| 0 | 32 | ASCII | `from_ref` | 必须解析到目录内记录 |
| 32 | 32 | ASCII | `to_ref` | 必须解析到目录内记录 |
| 64 | 1 | u8 | `kind` | 0 depends_on / 1 explains / 2 related_to / 3 supersedes / 4 conflicts_with / 5 unknown |
| 65 | 1 | u8 | `provenance` | 0 confirmed / 1 heuristic / 2 unknown |
| 66 | 6 | bytes | reserved | 零 |

边类型与来源标记按原样保存：本实验由账本投影重建，全部为 `confirmed`；格式本身
不接受把 `heuristic`/`unknown` 升级为 `confirmed` 的路径。

## 6. Manifest（canonical JSON，UTF-8）

| 字段 | 类型 | 说明 |
|---|---|---|
| `format` | string | 固定 `anchorprobe.bitchain.v1` |
| `format_version` | number | 固定 `1` |
| `header_bytes` | number | 固定 `128` |
| `record_header_bytes` | number | 与 header 一致 |
| `segment_bytes` | number | 与 header 一致 |
| `record_count` / `edge_count` | number | 与 header、目录、邻接表一致 |
| `source_digest` | string | `viewDigest(entries)`，绑定已提交事件集合 |
| `snapshot` | object | `AnchorProbeSnapshot`，原样保存 |
| `snapshot_hash` | string | `sha256(canonicalJson(snapshot))` |
| `record_region_sha256` | string | 诊断用区域摘要 |
| `index_region_sha256` | string | 诊断用区域摘要 |
| `header_hash` | string | `sha256(header[0..88] ‖ header[120..128])` |

`header_hash` 覆盖 header 中除 `body_hash` 外的全部字节；`body_hash` 覆盖 manifest。
两者互不循环：写路径先用 64 字符占位 digest 确定 manifest 长度，再写入真实
`header_hash`（长度不变），最后计算 `body_hash`。

## 7. 校验范围与顺序

读取（`BitChainProbeStore.open`）按固定顺序 fail-closed：

1. 文件长度 ≥ 128，否则 `truncated`。
2. `magic` / `version` / `endian` / `record_header_bytes`，否则 `bad_magic` / `bad_version` / `bad_endian` / `bad_header`。
3. 三区偏移、长度、计数边界与连续性，否则 `bad_bounds`。
4. manifest 可解析，且 `header_hash` 匹配，否则 `bad_manifest` / `bad_header_hash`。
5. `body_hash` 匹配，否则 `bad_body_hash`。
6. manifest 格式、参数、计数、区域摘要、`snapshot_hash`、`source_digest`，否则 `bad_manifest`。
7. 逐段：magic、段序、payload 边界、`segment_hash`、帧消费，否则 `bad_segment` / `bad_segment_hash` / `bad_record`。
8. 每条记录：固定头与记录尾一致、`content_hash` 重算一致，否则 `bad_record` / `bad_record_hash`。
9. 索引区：magic、版本、`index_hash`、偏移、目录排序与唯一，否则 `bad_index` / `bad_index_hash`。
10. 目录定位到真实记录、长度一致、边端点可解析、计数一致，否则 `bad_index` / `bad_edge`。

### 错误码

| code | 含义 |
|---|---|
| `truncated` | 文件短于 header |
| `bad_magic` / `bad_version` / `bad_endian` | 头部标识不匹配 |
| `bad_header` | 记录头大小等参数非法 |
| `bad_bounds` | 偏移/长度/计数越界或不连续 |
| `bad_body_hash` | 三区拼接摘要不匹配 |
| `bad_manifest` | manifest 不可解析或字段自相矛盾 |
| `bad_header_hash` | header 摘要不匹配 |
| `bad_segment` / `bad_segment_hash` | 段结构或段摘要不匹配 |
| `bad_record` / `bad_record_hash` | 记录结构或内容摘要不匹配 |
| `bad_index` / `bad_index_hash` | 索引结构或索引摘要不匹配 |
| `bad_edge` | 边枚举非法或端点不可解析 |

## 8. 重建、 freshness 与回退

- `BitChainProbeStore.write(path, entries, snapshot, options)`：从 `entries` 重放投影，
  重新生成记录区与索引区，原子替换文件。记录区是已提交事件的纯函数，绝不原地补丁。
- `isFresh(entries, snapshot)`：比较 `source_digest` 与 `snapshot_hash`。
- `refresh(entries, snapshot)`：fresh 直接返回；否则用同一参数重写并重新加载。
- `openProbeStoreWithFallback(root, entries, snapshot)`：
  - 文件缺失或 stale → 重建 BitChain，返回 `backend: 'bitchain'`；
  - 文件损坏 → 抛出原因并**回退 SQLite 基线**，返回
    `{ backend: 'sqlite', fallbackReason: "<code>: <reason>" }`，不静默、不回答损坏缓存。
- `candidates` 按 `record_ref` 升序，`adjacency` 按 `from,to,kind` 升序，与 SQLite /
  投影后端一致，因此 `probe()` 完整响应可 deepEqual。

## 9. 测量参数与未验证目标

- `record_header_bytes`（64/96/128）与 `segment_bytes` 只是测量参数，不预先宣称
  64B 最优；三者读取语义等价由测试保证。
- 性能结论必须分别报告入口、扫描、缺页、解压、证据装配、验证和模型调用，并注明
  硬件、数据规模与冷热路径。当前延迟基线为 `[数据缺失]`。
- 未引入 mmap、压缩库或原生扩展；未验证掉电级持久性。Windows 目录 fsync 限制适用。

## 10. 集成期风险 / 移交项（给 T-060 基准）

- 可作为被测后端：`BitChainProbeStore` 已实现 `ProbeStore`，可注入 `probe()` 做同语义
  对照；默认路径与 Surface 未接线，基准脚本需显式指定 `.ano/cache/probe-store.bitchain`。
- 基准必须与 SQLite/投影后端使用同一批 `ViewReplayEntry[]`、同一 snapshot、同一预算与
  同一请求集，避免把状态管理差异误记为二进制引擎收益。
- 损坏回退路径已具备显式原因，可直接用于基准的故障注入；不要宣称“静默自愈”。
- 若后续要默认启用，需先补齐真实延迟/成本/质量对照与掉电恢复验证，并单独审批依赖与
  Windows 支持；本任务不做。
