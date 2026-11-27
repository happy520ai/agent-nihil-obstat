# P6 硬化执行规范

> 本文先固定验收规则。最终验收数据只能在全量实现后由真实命令生成；未执行的项不标通过。

## 1. 工程完整性

- 所有生产源码必须通过 strict TypeScript、ESM NodeNext 与 Node ≥22.18。
- `npm ci`、根/脚本测试、构建、生成文档一致性、schema hash、打包安装必须真实执行。
- 不允许用 devDependencies 代替运行时依赖，不允许发布缓存、临时样本、真实会话或本机密钥。
- `.ano` 的账本与缓存均不得参与被验证源码指纹；证据输出默认使用系统临时目录。

## 2. 跨层验收

1. 账本：多进程并发、崩溃恢复、迁移幂等、租约过期回收、视图可重建。
2. 结构：L0/L1/L2 分离、三态边、图新鲜度、explore 预算和调用路径。
3. Memory：合成 provider、格式未知隔离、参数化 recall、中文/标识符检索、Anchor 重定位。
4. Gate：当前源码指纹、真实 argv、实际测试清单、T0/T1/T2、无 skip/todo/fail。
5. Audit：秘密只留指纹、许可证明细、联网显式 confirm。
6. Readiness：证据绑定/过期/缺失、attested 与 machine 分开、制品变化使批准失效。
7. Surface：MCP 恰为 7 工具，CLI 与只读面板安全，人工批准不经 agent。

## 3. 制品验收

- 在全新临时目录从 `npm pack` 的 tarball 安装，不能只依赖源码目录 node_modules。
- 验证 `ano --version`、真实 CLI 任务、真实 stdio tools/list、P1 覆盖缺口。
- 证据必须含 tarball SHA-256、版本、生成时间、运行环境和产物哈希。
- 验收脚本不能一边写证据一边改变被测源码指纹。

## 4. 不纳入“完成”的事项

- 真实客户端采样、生产服务 Profile validated、三平台远端 CI、公开名称法律清查。
- 远程仓库/push/publish/GitHub Release、人工 attest/approve。
- 没有真实运行输出的性能、并发、覆盖率或兼容性承诺。
