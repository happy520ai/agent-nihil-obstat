# 贡献与维护

ANO 当前是本地 alpha。普通维护以缺陷修复、环境兼容、测试补齐和文档更新为主；较大的功能或架构变更请先讨论，不要与维护修复混在同一个 PR 中。

## 开发环境

- Node.js 24 或更高版本和 npm。
- 当前自动化 CI 只验证 Windows + Node 24；其他平台的完整兼容性尚未验证。
- 安装主项目和独立 `scripts` 工具链的锁定依赖。以下命令禁用依赖安装钩子；构建是后续显式执行的独立步骤。

```sh
npm ci --ignore-scripts
npm --prefix scripts ci --ignore-scripts
npm run build
npm run typecheck
npm test
npm run coverage
node scripts/check-schema.ts
npm run check-docs
npm pack --dry-run
```

必须先构建再运行测试，部分集成测试会调用 `dist/`。没有安装 `scripts` 依赖时，spike 测试会显式跳过；不要把这种结果描述为完整验证通过。

CI 跳过需要临时联网安装依赖的 tarball self-host smoke；发布前仍须按 [README](README.md#已知限制) 中的说明单独验证。以目标提交的 GitHub Actions 结果为准，本地通过不代表线上 CI 已恢复；失败时应保留日志并定位原因，不要静默跳过失败测试。CI 通过不等于生产发布或真实项目切换授权。

## 提交修复

1. 从最新 `main` 建立独立分支，保持变更范围单一。
2. 缺陷报告写明复现步骤、预期与实际行为，以及操作系统、Node.js 和 ANO 版本。提交前删去私有路径、凭据和会话内容。
3. 行为修复应有能区分修复前后的回归测试；命令、配置或支持范围变化应同步文档。
4. PR 中列出实际执行的验证命令、失败和跳过项，不用推测替代证据。
5. Dependabot 每周为根目录 npm、`scripts` npm 和 GitHub Actions 提出更新；这些 PR 仍须人工审查和测试，不自动合并。

可使用以下命令审计两套锁文件。指定官方 registry 是为了避免不支持 npm security API 的镜像返回 404；审计成功且返回零漏洞，才可记录为“未检出已知漏洞”。

```sh
npm audit --package-lock-only --ignore-scripts --registry=https://registry.npmjs.org
npm --prefix scripts audit --package-lock-only --ignore-scripts --registry=https://registry.npmjs.org
```

## 隐私和漏洞报告

公开 PR、Issue 和测试夹具不得包含 `.pm/`、`.ano/`、真实客户项目证据、客户端会话、凭据或本机配置。需要示例时使用隔离夹具和虚构路径。

安全问题请先阅读 [SECURITY.md](SECURITY.md)，不要在公开 Issue 中发布秘密或可直接利用的细节。不要把测试通过当作公开发布敏感材料的授权。
