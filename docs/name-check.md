# 名称查重：Agent Nihil Obstat / ANO / ano

- 查询日期：2026-11-18（UTC；具体命令输出以本次会话与下列记录为准）
- 范围：npm 公共 registry、GitHub 公共仓库搜索、USPTO 网页可访问性检查。
- 性质：工程命名风险筛查，**不是法律意见或商标清查**。

## 结论

1. 不采用未加 scope 的 npm 包名 `ano`：该名称已经由第三方 Arduino/CMake 工具占用。
2. 用户选择 `agent-nihil-obstat` 作为包名，保留 `ano` 作为本地/安装后的 CLI 命令名。
3. 查询时 `nihil-obstat` 与 `agent-nihil-obstat` 在 npm 返回 E404；这表示 registry 当时未公开返回同名包，不保留永久可用承诺。
4. GitHub 精确搜索 `agent-nihil-obstat` 返回 0；`"nihil obstat"` 返回一个 `NihilObstatGit/NihilObstatGit` 用户配置仓库。
5. USPTO TSDR 页面未执行到商标结果查询，因此**没有完成商标检索，也没有通过商标清查**。发布前仍需由责任人或专业机构按目标司法辖区、商品/服务类别核查。
6. 不创建远程仓库、不注册名称、不发布包；这些动作需单独授权。

## 原始查询与输出

### npm：`ano`

命令：

```sh
npm view ano name version description repository.url license --json
```

输出：

```json
{
  "name": "ano",
  "version": "0.3.1",
  "description": "Ano is an Arduino CMake generator.",
  "repository.url": "https://github.com/taoyuan/ano",
  "license": "MIT"
}
```

npm 公共页面交叉核对显示：包名 `ano`、版本 `0.3.1`，描述为基于 CMake 的 Arduino library manager/toolchain generator，仓库为 `https://github.com/taoyuan/ano`。

### npm：`nihil-obstat`

命令：

```sh
npm view nihil-obstat name version description repository.url license --json
```

关键原始输出（保留错误码；日志本机路径不纳入公开材料）：

```text
npm error code E404
npm error 404 Not Found - GET https://registry.npmjs.org/nihil-obstat - Not found
npm error 404 'nihil-obstat@*' is not in this registry.
```

工具的实际完整消息包含 “The requested resource ... could not be found or you do not have permission to access it.”。因此 E404 本身不能排除私有/权限资源；它只能证明当前匿名公共查询没有返回包。

### npm：`agent-nihil-obstat`

命令：

```sh
npm view agent-nihil-obstat name version description repository.url license --json
```

关键原始输出：

```text
npm error code E404
npm error 404 Not Found - GET https://registry.npmjs.org/agent-nihil-obstat - Not found
npm error 404 'agent-nihil-obstat@*' is not in this registry.
```

同样的权限限制适用。`npm search "nihil obstat" --json` 的实际返回为：

```json
[]
```

### GitHub

通过 HTTPS 公共页面/API 查询：

- `https://github.com/search?q=%22agent-nihil-obstat%22&type=repositories`：显示 `0 results`，无匹配公共仓库；页面同时出现通用限制提示，不能把它解释为对所有私有/不可见资源的证明。
- `https://api.github.com/search/repositories?q=agent-nihil-obstat+in:name`：未发现该精确名称的公开仓库，返回 0。
- `https://github.com/search?q=%22nihil+obstat%22&type=repositories`：1 个结果，`NihilObstatGit/NihilObstatGit`，描述为 GitHub 用户配置仓库。

### 商标来源

访问：`https://tsdr.uspto.gov/#caseNumber=nihil%20obstat&caseSearchType=US_APPLICATION&caseType=DEFAULT&searchType=statusSearch`

实际可见内容是 TSDR 的帮助/查询界面，未返回 `nihil obstat` 的商标记录。**该访问没有发生有效的商标搜索，不记为“0 个商标结果”。** 这是 P0 的未完成查重子项；它不阻塞本地无发布的 `agent-nihil-obstat` 开发，但阻塞对外名称无冲突声明。

## 后续发布前检查

1. 再查 npm 精确名称、GitHub 精确名称与常用代码托管平台。
2. 按发布地区在官方商标数据库执行文字检索，并检查软件/AI 工具相应类别及近似拼写。
3. 保存有日期、查询式、结果页或导出件；无法访问必须保留“未验证”。
4. 真正发布前再次确认包名；此报告不代替注册，也不保证可用。
