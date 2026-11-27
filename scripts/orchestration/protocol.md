# PM 多会话 DAG 调度协议

## 边界

- PM-mcp 是任务状态、checkpoint、测试和验收的真值来源。
- `scripts/orchestration/<milestone>-plan.json`（例如 M8 的 `m8-plan.json`）是派生的机器可读依赖/会话绑定，不修改 PM 任务正文。plan 的 `milestone` 字段必须与派发时传入的 `--milestone` 一致。
- `.pm/orchestration-state.json` 保存调度器租约、attempt 历史、主控验收与阶段门禁。写操作使用项目文件锁和原子 rename。该状态文件按项目唯一，与 plan 文件路径无关。
- 宿主主控会话执行 CreateSession、ListSessions、WaitSessions、SendToSession；本地 Node CLI 不直接调用宿主内部工具。
- 原子 claim 是**本调度器状态**的文件锁操作。CreateSession 与 PM update_task 之间没有已验证的跨服务事务；主控必须串行执行 claim→create→bind→PM claim，并在每一步后对账。若中途崩溃，以已有 session/PM/checkpoint 恢复，不重复建任务。

## 主控每轮

1. 用 `record_round(action=begin, run_kind=manual)` 开轮，run_id 固定写入本轮日志。
2. `list_tasks(milestone=<当前里程碑>, include_done=true)`，读取 PM 状态，禁止直接修改 `.pm/tasks.json`。
3. `ListSessions`，把 `scripts/orchestration/<milestone>-plan.json` 的绑定会话与宿主状态对照。
4. 本地 `node scripts/orchestration/cli.ts --plan scripts/orchestration/<milestone>-plan.json --milestone <里程碑> --max-concurrency 4` 产生 dry-run 动作。`--plan` 必填；`--milestone` 可省略，此时以 plan 文件声明的 milestone 为准，显式传入时必须一致。
5. `dispatch`：先 `store.claim`，再 CreateSession（每任务一个新会话），成功后 bind，最后 `update_task(id, status=in_progress, author=orchestrator/session)`；错误则停止派发并对账。
6. `adopt`：绑定已有会话，不重复 CreateSession。idle 且任务未完成时发送恢复 prompt，running 则监听。
7. `wait`：仅记录 CreateSession/SendToSession 返回的 operation，使用 WaitSessions(mode=any, timeoutMs<=300000)。不能凭旧 session_id 编造 commandId。仅等待当前操作；新一轮重新 ListSessions。
8. `attention`：通知用户批准或处理，不替用户批准权限，不新建替代会话。
9. `recover`：先重新核验全部已验收依赖、阶段门禁、task_specs.blocked_by、execution_policy、并发上限和集成互斥。只有宿主明确观测为 idle/missing 才建议恢复；缺少会话观测、只有过期 heartbeat 或只有 PM in_progress 都不能证明会话可恢复。无真实绑定的 in_progress 保持 blocked，主控先查宿主并建立真实绑定，不能使用 task id 伪造 session id。idle 复用原会话，明确 missing 才在同一任务下创建替代会话；每任务最多 2 次自动恢复，仍失败置 blocked 并写明证据。
10. `verify`：PM done 仍不自动放行；读取质量报告文件，要求严格 `ok===true`、`source.stable===true`、前后均为 sha256-tree-v1 且摘要相等，任务 verification 必须按完整路径边界或完整摘要引用该报告。核验当前源码指纹后写 runtime.completed 的 source_sha256、report_sha256、task_sha256 并 release lease。每轮 dry-run 会重新比较当前源码、报告字节和 PM 完成证据；任一变化或旧记录缺少摘要都回到 verify，绝不复用历史快照放行下游。
11. 阶段集成任务完成后才打开相应 runtime gate（例如 M8 的 T-042/T-047/T-052/T-056/T-061 对应 phase-p0..p4；M10 的 T-076/T-078 对应 takeover 门禁）。所有依赖按 all_done 处理。`state-command.ts gate <gate> <report> [--plan <path>]` 从指定 plan 解析 gate 对应的集成任务；省略 `--plan` 时按 gate id 在各 `*-plan.json` 中唯一匹配，多义或未知均 fail-closed。
12. `record_round(action=end, produced_evidence=<真实结果>, tokens_unknown=true)`；能取得真实 token 时改用 tokens_used。

## 验收与并发

- 子任务运行范围内测试/typecheck；不在多个会话并发跑全量质量矩阵。
- 全量质量矩阵由阶段集成独占执行，先停止该阶段写入，避免 source.stable=false。
- `done` 必须带 result_note、verification 和主控核验。会话 completed 不等于验收通过。
- 不依赖子会话彼此等待；未满足依赖或具名人工条件时动作是 blocked，不创建或恢复会话。open_now 不能覆盖 never_auto_start 或人工 blocked_by。
- 已观测 running/idle/needs_attention 的绑定会话先占用容量，即使 heartbeat 过期或该任务当前被门禁阻塞，也不能因排序靠后而漏计。无观测的已知绑定同样保守预留容量；只有明确 missing 释放宿主占位。
- 跨会话共享文件依任务 files 与互斥组协调；冲突未声明时串行。集成互斥任务启动前要求没有其他活动任务，恢复路径使用同一规则。

## 当前限制

- 这是宿主主控适配器，不是独立的 ZCode 后台 daemon。主控进程停止后，重新启动主控从 PM/租约/session 绑定恢复。
- ListSessions 的 idle 不能区分“正在等待权限”和“已完成但未写 PM”；需要 ReadSession/WaitSessions 补充判断。
- 源码快照和质量报告的语义核验由主控执行，脚本不会把旧报告冒充当前源码报告。
