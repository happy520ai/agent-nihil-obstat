# Profile C：后端服务 / API

状态：`defined`，不是 `validated`。

没有真实服务项目完成预发布部署、回滚、备份恢复或告警演练。本项目不能把自己当作验证项目；任何 `validated` 声明都必须带外部项目的验证记录（项目名、日期、profile schema hash、真实 verdict hash），否则加载直接失败。

清单包含：

- `c.alerts-runbooks`
- `c.backup-restore-drill`
- `c.db-migration-rehearsal`
- `c.health-endpoints`
- `c.least-privilege`
- `c.load-test-capacity`
- `c.prestage-deploy-rollback`
- `c.resilience-config`
- `c.secrets-managed`
- `c.structured-logs-tracing`

本地只实现三项静态/合成检查：

- `c.health-endpoints`：`deploy/service.json` 必须声明 `health` 与 `ready` 路径。
- `c.resilience-config`：必须声明正的 `timeouts.requestMs`、`rateLimit.rps`、`circuitBreaker.failures`。
- `c.secrets-managed`：`env` 值必须引用 `secretRef:`、`vault:`、`${...}` 一类托管来源，字面量视为失败。

以下项目无法由本工具真实证明，只能由外部文件证据或具名人 attestation 满足：

- 预发布部署与回滚记录、数据库迁移演练、备份恢复演练、压测结果、监控导出、告警 runbook 演练、最小权限声明。
- 没有 `deploy/service.json` 时，本地检查返回 skipped，对应需求在裁决中仍是 missing，而不是伪造通过。
- 本地检查不连接预发布环境、不执行部署、不读取云账号、不验证真实监控。

要升为 `validated`，必须在一个真实服务项目上跑完整 release 流程并记录：真实 verdict、被拒绝的证据、无法机器证明的项、以及这些项由谁 attest。当前所有测试都是 `os.tmpdir()` 合成 fixture，不能作为验证记录。
