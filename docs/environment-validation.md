# 本机与 Node 版本验证记录

- 系统：Windows 10.0.19041 x64，Git Bash。
- 默认 Node：v24.14.0，npm 11.9.0。
- 最低版本：隔离下载官方 `node-v22.18.0-win-x64.zip`，解压到新的临时目录，只调用该目录的 `node.exe`，不修改系统 Node。

2026-11-18 在源码包含 core/ledger 基础原语和 surface 契约时，Node 22.18.0 的实际命令：

```text
D:\Temp\ano-node22-EItrc1\node-v22.18.0-win-x64\node.exe --test test/**/*.test.ts
```

结果：16 tests / 16 pass / 0 fail / 0 skipped。此后测试集合增加；增加的内容是否已在 Node 22 重跑以最新 phase 报告为准。

S3 虚拟时钟原型也在该 Node 22.18.0 运行通过：1005 事件、0 因果违例、稳定全序需要 actor tie-break。证据：`docs/evidence/s3-hlc.json`。

## 环境问题的如实记录

当前 shell 的 `curl` 是用户 profile 中的别名/函数，会额外指定下载输出路径；因此最初两个临时下载命令未生成预期文件。改为 Node 原生 `fetch` + `fs.writeFileSync` 后下载成功（35,400,406 bytes），再调用 Windows `tar.exe` 解压。该问题不是产品代码测试失败，也不能用于宣称 Node 22 不支持某特性。

pm-mcp `run_quality_matrix` 最初被 S7 生成的嵌套 package.json 阻断。只为这些合成 fixture 声明 `private` 和只检查语法的质量命令，不安装或执行 fixture 项目源码；随后根单元质量矩阵可以运行。

## 未覆盖

- Linux/macOS 未在本机运行；CI 文件存在不等于远端矩阵已通过。
- Node 24 的 tree-sitter 压力结果不外推到 Node 22。
- Node 22 类型检查和构建必须单独通过其 npm CLI 或从 Node 24 调用锁定 tsc 的结果判定，不能由单独 `node --test` 推断。
