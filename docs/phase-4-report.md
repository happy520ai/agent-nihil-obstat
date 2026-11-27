# Phase 4 报告：Memory

日期：2026-11-19。基线：`ano-architecture-v1.0.md` §3、§6、Phase 4；S1 结论：`docs/spikes/S1.md`。
范围：`src/memory/**`、`test/integration/memory.test.ts`、`test/redteam/memory-full.test.ts`、
`test/fixtures/memory/**`（全部手工合成）。未修改 `src/ledger`、`src/structure`、`src/gate`、`src/surface`、
`src/audit`、`src/readiness` 或其它 docs。

## 1. 隐私与真实性边界（先声明）

- **没有读取、采集、复制或推导任何真实客户端会话**：ZCode / Qoder / Codex / Claude Code / WorkBuddy
  一律未碰；**没有读取 obelisk 源码**。
- `test/fixtures/memory/**` 全部为手写合成 JSON/JSONL，每个 `unit.json` 都带 `"synthetic": true`；
  adapter 对未声明 synthetic 的单元直接跳过（`not-synthetic-fixture`）。
- 没有真实客户端格式的 adapter，也没有声称支持任何真实客户端。`src/memory/compat.ts` 的矩阵只有
  `synthetic-jsonl` 一项，状态固定为 `synthetic-only`；ZCode/Qoder/Codex/Claude Code/WorkBuddy 只列为
  `planned`，不是已支持。
- S1 排序盲测仍未执行（G3 未授权），本阶段不产出任何召回率、排序、延迟或索引体积结论。

运行环境（真实值，非抄写）：Node `24.14.0`、ICU `78.2`、Unicode `17.0`、SQLite `3.51.2`、
`ENABLE_FTS5='true'`；`node:sqlite` 打印 experimental warning。

## 2. 交付内容

### 2.1 Adapter：纯发现/解析，唯一写层

`src/memory/types.ts`、`src/memory/adapter.ts`、`src/memory/cursor.ts`

- `discover(root) -> { units: IndexUnit[], skipped: SkippedArtifact[] }`：只读文件系统，不碰数据库。
- `parse(unit, cursor) -> { records, cursor, fullReplay, skipped }`：纯读取；同一份解析逻辑还提供
  `parseTranscriptStream(unit, transcript, cursor)` 惰性 `record / skipped` 事件流。
  `parseTranscriptText` 只是把流收集成数组，供唯一写层使用。
- 唯一写层：`HistoryStore`（`src/memory/store.ts`）写 `.ano/cache/history.db`，真实 `node:sqlite`。
- `visibility` 三态 `visible | inactive | hidden` 存库；默认 recall 只返回 `visible`，`inactive`/`hidden`
  保留且可用显式过滤取回，不删除。
- 未知格式版本只跳过该单元（`unknown-format-version`）；坏行只跳过该行
  （`unknown-record-version` / `invalid-record-json`），不毒化 provider。
- 每单元 cursor 绑定 `unitId + contentHash`；结构损坏、哈希变化或身份不匹配都退化为全量重放。
- provider marker 版本变化只清空该 provider 并重放；provider 之间的数据、失败状态和 marker 相互隔离。
- 单元级 parse 失败只记录 `parse-error`，保留该 provider 其它单元与上次成功数据，provider 标
  `degraded`；发现阶段失败标 `failed`，不清空其它 provider。

### 2.2 history.db 与 recall

`src/memory/store.ts`

- 表：`meta / providers / units / sessions / messages / message_tags / skipped_artifacts`，以及 FTS5
  `message_fts(tokens, tokenize='unicode61')`。`history.db` 是可重建缓存。
- `meta` 记录 `schema_version / tokenizer_version / identifier_split_version / fts_configuration / icu /
  unicode / segmenter / fts_available`；任一变化触发重建（实测见 §3.4）。FTS5 表缺失或可用性变化也触发重建。
- recall 只接受以下结构化字段：`session / from / to / file / symbol / keyword / provider / visibility /
  limit / offset`。未知字段直接报 `RecallQueryError`；`script`、`sql`、`exec` 等均被拒绝。
- 所有外部值使用 `?` 绑定；表名/列名只来自代码常量。没有任何字符串拼接成 SQL 或脚本。
- `file`/`symbol` 走 `message_tags` 精确匹配（参数化 `EXISTS`）；时间按毫秒参数比较。
- transcript 文本只作为 SQLite TEXT 存储和返回；snippet 取自**原文列**，不是切分后的 token 文本。
- 恶意 transcript 的 `$(...)`、`require(...)`、`DROP TABLE` 等只被回显，测试验证未执行且表未被破坏。

### 2.3 S1 机制落地

`src/memory/tokenizer.ts`

- B+：`Intl.Segmenter('zh', {granularity:'word'})` 词段 + 确定性 ASCII 标识符子词拆分；
  索引端和查询端调用**同一个** `tokenizeText`。
- 标识符拆分规则与 S1 一致：驼峰、连续大写缩写、字母数字双向边界、`_ - . $` 分隔符；
  `XMLHttpRequest -> xml/http/request`、`parseHTMLString -> parse/html/string`、
  `utf8Decode -> utf/8/decode`、`base64 -> base/64`、`OAuth2Token -> o/auth/2/token`。
- 长度按 Unicode 码点 `[...s].length`；测试覆盖 `𠮷`（1 码点 / 2 UTF-16 码元）与 `𠮷野家`（3 码点）。
- `<3` 码点的 CJK 查询与单码点查询降级到原文列 `LIKE`，结果标 `mode: 'like'`、
  `degraded: 'unigram-scan'`；`租约`/`死锁` 实测走降级并命中，`数据库`/`𠮷野家`/`refreshToken` 走 FTS。
- FTS 表达式由已切分 token 逐项双引号包裹并用 AND 组合，`%`、引号、SQL 片段不会进入 FTS 语法或 SQL 文本。
- tokenizer/ICU/Unicode/FTS 配置写入 `meta`；变化即重建，不沿用旧索引。

### 2.4 Memory、Anchor 与 brief

`src/memory/anchor.ts`、`src/memory/note.ts`、`src/memory/brief.ts`

- 三级重定位：
  1. `symbol_id` -> `exact`；
  2. `qualified_name + file` -> `relocated(level 2, renamed-symbol-id)`；
  3. `file + contentFragment/contentFragmentHash` -> `relocated(level 3)`；
  4. 文件不存在、片段不匹配、证据不足 -> `stale`，绝不指向另一个文件或无关符号。
- `note(kind=memory/decision/pitfall)` 必须带 Anchor；`session_summary` 必须不带 Anchor。
  Anchor 文件必须是规范化项目相对路径；`symbolId` 不得含行号；`contentFragmentHash` 必须是 64 位小写
  SHA-256，且与提供的片段一致。
- `MemoryNoteBook` 使用内容派生的 `note.id` 去重；`toLedgerNotePayload` 给出账本 `note.recorded` 事件的
  精确 payload 形状。
- `buildMemoryBrief` 聚合：焦点透传、与 touched/focus 文件相关的锚定知识、全部 stale 锚、
  history provider 状态、以及“修改了 N 个文件但没有结构查询”的提示。该接口不修改 surface。

### 2.5 兼容矩阵

`src/memory/compat.ts` 只有 `synthetic-jsonl / synthetic-v1 / hand-authored-synthetic-fixtures`，
状态 `synthetic-only`；没有 `supported` 或 `validated`。

## 3. 验证

### 3.1 类型检查

初次基线（实现前）在 4 GB heap 下通过；最终当前工作树：

```text
> agent-nihil-obstat@0.1.0-alpha.0 typecheck
> tsc -p tsconfig.json --noEmit

npm-typecheck-exit=0
```

仅 P4 范围的独立 typecheck（`src/memory/index.ts` + 两个 P4 测试）同样 exit 0。

### 3.2 自有测试（只跑 P4 两个文件）

命令：

```bash
node --test test/integration/memory.test.ts test/redteam/memory-full.test.ts
```

实际末行输出：

```text
ℹ tests 20
ℹ suites 0
ℹ pass 20
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 570.1166
```

两个 worker 均打印 `ExperimentalWarning: SQLite is an experimental feature`，属运行时警告，不是测试失败。
测试根目录全部在 `os.tmpdir()` 下创建并在 `after` 中关闭、删除；fixture 目录只读。

### 3.3 覆盖的验收点

- **adapter / provider**：未知格式只跳过该单元；未声明 synthetic 的单元被拒；非法/缺失/越界 transcript
  路径被拒；坏记录行逐行跳过；一个 provider 发现失败、一个单元 parse 失败都不影响其它 provider，
  且单元失败可恢复为 `ok`。
- **recall**：`session / from / to / file / symbol / keyword / provider / visibility` 均有用例；
  时间边界、分页上限、非法时间、非法 visibility 有拒绝用例。
- **注入**：keyword/provider/session/file/symbol 五类字段的 SQL/FTS 注入载荷均只影响匹配结果，
  `messages` 表与行数不变；`script/sql/exec` 字段直接拒绝。
- **恶意 transcript**：运行时生成的合成文本含 `$(touch ...)`、`require('node:fs').writeFileSync(...)`、
  `DROP TABLE messages`、`process.exit(99)`；召回返回原文，标记文件不存在，数据库仍可查询。
- **cursor / marker**：未变化单元复用 cursor（第二次 ingest `records=0`）；损坏 cursor 只对该单元全量重放；
  marker bump 清空并重放该 provider；beta 数据与 marker 完全不变。
- **ICU/FTS 元数据**：直接改 `meta.icu` 或 `meta.fts_configuration` 后重新打开，`wasRebuilt=true`、消息数归零、
  新 meta 写入当前环境值；真实 SQLite `sqlite_version()` 与 `message_fts` 表存在性被断言。
- **S1 语义**：标识符四类边界、`refreshToken`/`token` 子词命中、`租约`/`死锁` LIKE 降级、
  `数据库`/`𠮷野家` FTS、码点长度均有断言。
- **Anchor / brief**：缺 Anchor、session_summary 带 Anchor、行号 symbolId、绝对路径/反斜杠路径均被拒；
  exact / relocated(level 2/3) / stale 均有断言；改名后 brief 浮出 Decision，并输出未 explore 修改提示。
- **兼容声明**：矩阵状态只能是 `synthetic-only`，planned 客户端列表不作为支持声明。

### 3.4 失败与修正记录

首轮测试确有失败，未隐瞒：

1. `visibility` 单元级 `hidden/inactive` 被记录级默认值 `visible` 覆盖，导致默认 recall 多返回 2 行。
   根因：`parseVisibility` 对 `undefined` 返回 `'visible'`，使 `?? unit.visibility` 永远不生效。
   修法：单元发现默认 `visible`，记录解析默认 `null` 并回退到单元 visibility；测试后 20/20。
2. meta 重建时先 `DROP TABLE meta` 再写 meta，触发 `no such table: meta`。
   修法：重建后重新创建 meta（并让 `createTables` 自带 meta），验证重建仍归零。
3. brief 测试中“改名后 relocated”最初得到 `exact`：测试锚点源仍返回旧 symbol_id，而非代码缺陷。
   修法：测试源只保留新 symbol id，使旧 id 不存在，从而验证 level 3 片段重定位。
4. snippet 断言最初要求完整原文：实现按码点截取 160 字符的原文窗口并加省略号，不是 token 文本。
   修法：断言 snippet 是原文片段且包含关键词，不要求完整 payload。

这些修正后没有任何测试被跳过或放宽到“无断言”。

## 4. 明确未完成 / 限制

1. **没有真实客户端 adapter**：Qoder、WorkBuddy、ZCode、Codex、Claude Code 的真实格式未读、未采样；
   兼容矩阵只能写 `synthetic-only/planned`。
2. **note 尚未写入账本**：当前 `src/ledger/event.ts` 没有 `note.recorded` 事件 kind，且本任务禁止修改
   `src/ledger`。本阶段交付了校验、去重、`toLedgerNotePayload` 和 `NoteSink` 注入点；实际账本持久化、
   以及 surface 的 `note`/`brief` 接线仍需主控在允许修改账本时完成。
3. **brief 未接入 surface**：按要求只提供聚合接口，`src/surface` 未改。
4. **重建后需重新 ingest**：tokenizer/ICU/FTS 元数据变化会按设计丢弃可重建缓存；本模块不会自行扫描源目录
   重建，调用方需再次执行 adapter ingest。
5. **cursor 只覆盖“未变化单元复用/失效全量重放”**：没有实现按字节前缀的增量 append；
   文件内容哈希变化一律全量重放。
6. **FTS5 不可用时只有 LIKE 退路**：没有实现 S1 提到的内存倒排备选；会标 `fts5-unavailable` 并扫描原文列。
7. **中文分词质量依赖本机 ICU**：只对 S1 列出的样本与测试语料负责；日文假名、韩文谚文未做覆盖声明。
   B+ 的 3 字部分查询（例如跨词边界的片段）仍可能漏检，本阶段不声称完整召回。
8. **file/symbol 过滤是精确匹配**，不做模糊、前缀或路径归一化别名。
9. **没有排序质量结论**：没有真实样本，未计算召回率、P@k、延迟或索引体积。
10. 只运行了 P4 自有测试；未以本阶段名义运行全量 `npm test` 或宣称 P4 以外阶段通过。
