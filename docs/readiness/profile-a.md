# Profile A：库 / SDK / npm 包

状态：`defined`，不是 `validated`。

当前没有任何真实库项目完成端到端验证，因此不得把本 profile 描述成“已支持库发布就绪”。本项目自身也不能自证为验证项目；`loadProfileText` 和 `loadReadinessProfiles` 会拒绝无外部验证记录的 `validated` 声明。

清单包含：

- `a.breaking-change-notes`
- `a.public-api-semver`
- `a.runtime-matrix`
- `a.tarball-allowlist`
- `a.types-exports`

本地能真实计算的项目只有：

- API diff：比较 `api/baseline.json` 与 `api/current.json`，破坏性变化要求 major 版本升级。
- tarball allowlist：检查 artifact 目录内容是否被 `package.json` 的 `files` 覆盖，并拒绝 `.env`、source map、`test/` 等。
- types/exports：检查声明的类型文件在 artifact 中存在。

`a.runtime-matrix` 需要外部 CI 在声明的最低/最高运行时上执行并导出文件证据；本工具不联网，也不会把缺失证据说成通过。`a.breaking-change-notes` 可用迁移说明证据满足，也可由具名人 attested；没有二者时保持 missing。

要升为 `validated`，必须在一个真实外部库上：

1. 对真实制品执行构建、干净安装、API diff、类型/导出和 tarball 检查。
2. 生成真实 release verdict，而不是合成 fixture。
3. 记录项目名、日期、profile schema hash 和 verdict hash。
4. 把缺口、误拒和无法机器证明的项写回本文档。

当前测试全部使用 `os.tmpdir()` 合成项目，只证明清单和拒绝路径可运行，不证明该 profile 已在生产库上校准。
