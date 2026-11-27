# Connect：接入现有项目

Connect 是来源只读的接入层，不要求先放弃原项目管理工具。当前参考适配器为本地 PM-mcp；不宣称支持 Jira、Linear、GitHub、CSV 或其他来源，也不是完整管理功能替代品。

## 开始使用

构建 ANO 后运行：

```sh
node dist/surface/cli.js connect ui --root "/absolute/path/to/project"
```

打开命令输出的本机授权地址，检查识别到的项目和预检结果，再点击开始使用。地址含进程级访问凭据，不要转发。目标项目不需要 `package.json` 或 Git；ANO 运行时仍需要 Node.js 22.18 及以上。

非交互入口：

```sh
ano connect plan --root "/absolute/path/to/project"
ano connect --root "/absolute/path/to/project"
ano connect status --root "/absolute/path/to/project"
ano connect resume --root "/absolute/path/to/project"
ano connect watch --root "/absolute/path/to/project" --interval 1000
ano recall --source connected --query "下一步" --root "/absolute/path/to/project"
ano connect export --root "/absolute/path/to/project"
ano connect handoff --root "/absolute/path/to/project"
```

- `plan` 零写入，不创建 `.ano/`；读不到或无法一致读取来源会明确报错。
- `connect` 自动预检并接入。`--expected-digest <sha256>` 可要求来源仍与先前计划相同。
- `resume` 可在中断后重跑；相同来源不产生重复版本，不同来源产生新版本。
- `watch` 是显式启用的前台持续刷新；按周期重新预检，来源变化时追加版本，未变化时跳过提交，可用 `--max-cycles` 有界运行并响应中止信号。它不写回 `.pm/`，不创建后台守护进程。
- `status` 读取最后完整提交，不自动刷新来源。
- `export` 向标准输出写 JSON 退出包，包含各接入版本、原始资料及变更，不自动上传。
- `handoff` 仅检查接管条件；当前返回未就绪、阻止原因和非零退出码，不改写原工具。

## 数据范围

| 数据 | 处理 |
|---|---|
| 任务 | 提取来源身份、标题、原始业务状态及原始字段；不创建 Gate 已完成任务 |
| 里程碑、功能、会话、决策 | 保留原始资料，提取可识别记录供查询；不等于原生可编辑实体 |
| 未识别字段、其他普通文件、二进制资料 | 原样按内容哈希归档，可在退出包中恢复；二进制不做文本检索 |
| 已知可重建索引缓存 | 明确列入排除清单和警告；不宣称逐字节备份整个 `.pm/` |
| 符号链接、junction、特殊文件 | 拒绝，不跟随到项目外 |
| 读取权限不足、超限、畸形记录、重复 ID | 明确失败，不静默跳过并宣称成功 |

来源只限所选项目根目录下 `.pm/`；不会遍历整台机器、读取客户端目录或自动联网。默认限制单文件 32 MiB、总计 512 MiB、20,000 个文件、32 层目录；超限时报错，不截断导入。来源在读取或确认期间变化时拒绝提交，请重新预检。

### 两种状态不可混淆

来源 `done` 保留为业务“已完成”，独立标记 `verification: unverified`。历史完成事实不会变成当前待办，但不能用来证明 ANO Gate 或发布条件已经通过。`brief` 分开报告原生任务与接入任务；来源资料始终标记为不可信内容，不作为执行指令。

## 存储、对账与恢复

接入资料放在项目 `.ano/connect/`，与已有 `.ano/ledger/` 隔离：

- 原始资料采用 SHA-256 内容寻址，快照保存文件清单、来源记录和版本变更。
- 暂存与检查点允许重跑恢复；读取只暴露完整提交的快照。
- 重复相同数据不会创建重复任务；更新和删除在新版本中反映，旧版本继续保留。
- 对账区分转换记录、原始归档和明确排除项，不仅比较总数。
- 哈希校验发现损坏会报错，不将损坏资料当作空项目。

不承诺操作系统断电级持久性或抵御同一用户进程恶意并发替换路径。身份隔离以项目根目录为边界，移动或复制项目后的身份续接不是自动功能。

## 接入不等于完整接管

本版不改 `.pm/`、项目 `AGENTS.md`、MCP 配置或全局配置。原工具仍是主写入口；默认 `connect`/`status` 不自动刷新来源，`watch` 仅在用户显式启动的前台进程中持续刷新快照，不是后台持续同步。

M7 新增 `ano migrate`（CLI）与 `track(kind=connection, operation=migrate_plan|migrate_apply|reconcile)`（MCP）：`plan` 零写预检，`apply` 必须绑定 `plan.sourceDigest`，只读 `.pm/` 并把任务/里程碑/功能/会话写入 `.ano/ledger`。来源 `done` 仍映射为 `in_progress + verified=false`。迁移成功不等于完整接管：里程碑/功能仍是迁移记录而非可编辑原生实体，来源回写与 PM-mcp 停用均未实现。

原生任务修改已通过 `track(kind=task, operation=update|cancel|reopen)` 接通；`complete` 必须携带已记录的 Gate `evidence_id`，由 ledger 重新校验证据与当前源码指纹，裸 `done` 被拒绝。

cutover 状态机为 `prepared → imported → reconciled → backed_up → cutover_confirmed`；`handoff` 现在按证据计算 `ready`：一致快照、迁移摘要与计划摘要一致、对账无 missing/conflict、校验通过的备份、绑定该摘要与备份哈希的具名人工确认。缺任一项都会给出可行动 blocker。备份/恢复见 `ano migrate backup|restore|list-backups`，人工确认见 `ano connect cutover confirm`。PM-mcp 停用仍由用户手动执行。协议见 ADR-004。

退出包覆盖 Connect 保存的来源版本和变更，不是 `.ano/ledger/`、验收证据或整个项目的全量备份。使用 ANO 原生功能产生的数据需要另行备份；不要恢复旧备份后丢掉新增数据。停止使用 Connect 不会影响原工具，不必删除任何历史。

## MCP

工具数量保持七个；接入能力复用 `track`：

```json
{
  "kind": "connection",
  "operation": "plan",
  "root": "/absolute/path/to/project",
  "idem_key": "connect:project:plan",
  "payload": {}
}
```

`operation` 为 `plan`、`connect`、`status`、`export`、`handoff`、`migrate_plan`、`migrate_apply` 或 `reconcile`；`connect` 的 payload 可带 `expected_digest`，`migrate_apply` 必须带 `expected_source_digest`（来自 `migrate_plan`）。相同来源版本的重复接入由核心引擎去重；迁移重复 apply 对未变来源零新增事件。不要把 `idem_key` 理解为跨来源版本的同步锁。`recall` 通过 `source: "connected"` 和 `query` 查询历史，默认合成历史模式保持不变。

## 本机向导安全

向导与旧只读面板独立，仅绑定 `127.0.0.1`。访问需进程级凭据，写操作还校验同源请求与 CSRF token；固定服务器项目范围，不接受网页参数覆盖 root。来源文本进行 HTML 转义，不加载来源脚本或外部资源。关闭进程后访问凭据失效。

导入资料和退出包可包含完整会话、私有路径或其他敏感信息，**并非脱敏数据**。默认仅存本地；不要提交版本库、共享授权地址或在未经确认时发送外部服务。通过 MCP 查询返回给宿主客户端的内容遵守该客户端的数据处理边界，不能宣称永远不会离开本机。
