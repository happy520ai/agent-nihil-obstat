# Agent Nihil Obstat（ANO）

**让证据裁决 Agent 的工作，而不是让 Agent 自己宣布成功。**

ANO 是一个面向 AI 编程智能体的本地任务与发布裁决工具。它结合追加式账本、源码指纹、代码结构图和外部测试证据，判断“任务完成”或“可以发布”的声明是否有当前证据支持。

> 当前状态：本地 alpha，仍处于真实项目验收阶段；不是生产发布版本，也不提供服务等级承诺。

## 为什么需要它

AI Agent 可以很好地描述自己做了什么，但自然语言总结不能替代验收：

| Agent 的声明 | ANO 关注的问题 |
| --- | --- |
| “任务完成了” | 是否有与当前源码匹配的测试和执行证据？ |
| “测试通过了” | 测试是否真的执行？是否存在失败、跳过或源码漂移？ |
| “可以发布了” | 是否绑定真实制品哈希、满足 Readiness 条件并获得人工批准？ |
| “我记得之前的工作” | 是否有显式保存、可检索的历史记录，而不是临时对话印象？ |

**Nihil Obstat** 是拉丁语，意为“没有什么构成阻碍”或“查无妨碍”。在这里，它表示由证据检查是否存在放行阻碍，而不是无条件自动批准。

## 核心能力

- **证据绑定的任务裁决**：任务完成必须引用已记录的 Gate 证据；裸 `done` 不能冒充已验收。
- **追加式账本**：保存任务、记忆、验收和审计历史，支持完整性检查、恢复与视图重建。
- **源码与结构分析**：计算确定性源码指纹，提供 TypeScript/JavaScript 静态结构图、影响范围和新鲜度检查。
- **发布裁决**：分别核验源码、真实制品 SHA-256、证据与人工批准状态。
- **显式记忆与检索**：通过 note、recall 和 brief 恢复已保存的上下文，不自动采集真实客户端会话。
- **PM-mcp 项目接入**：支持只读接入、历史快照和迁移；主写接管必须单独授权并显式确认。
- **本地审计**：提供漂移、安全、许可证、依赖与治理检查。
- **MCP / CLI 接口**：通过七个意图工具提供 `brief`、`explore`、`recall`、`track`、`note`、`verify` 和 `audit`。

## 快速开始

### 环境要求

- Node.js **22.18 或更高版本**
- npm
- 从源码构建；当前不要假设可以直接从 npm 安装已发布版本

### 构建

```sh
git clone https://github.com/happy520ai/agent-nihil-obstat.git
cd agent-nihil-obstat
npm ci
npm run build
node dist/surface/cli.js --help
```

开发验证命令：

```sh
npm run typecheck
npm test
npm run coverage
npm run check-docs
```

### 先查看接入计划，不写入目标项目

```sh
node dist/surface/cli.js setup \
  --root "/absolute/path/to/target-project" \
  --client zcode \
  --yes-dry-run
```

确认计划后，可在真实交互终端中去掉 `--yes-dry-run`，逐步检查并确认每个写入步骤：

```sh
node dist/surface/cli.js setup \
  --root "/absolute/path/to/target-project" \
  --client zcode
```

已有 PM-mcp 项目可以先执行只读预检：

```sh
node dist/surface/cli.js connect plan \
  --root "/absolute/path/to/target-project"
```

### 启动 MCP 服务

```sh
node dist/surface/mcp.js
```

将上述命令按所用客户端的 MCP 配置格式注册即可。**目前只有 ZCode 完成了真实 stdio 七工具握手验证；其他客户端的接入路线或配置映射不等于已经实测支持。**

## 权限与安全边界

ANO 的设计原则是默认收敛权限，而不是替用户扩大授权：

- 非交互模式和 dry-run 只输出计划，不写入目标项目。
- 配置写入、项目接管和恢复需要显式确认；真实项目切换仍需具名人工授权。
- 不自动批准发布，不自动 push、publish 或停用原有 PM-mcp。
- 不自动读取客户端会话，不主动采集凭据、令牌或私钥。
- 默认数据保存在本地；但导入的历史和导出包可能含敏感信息，分享前仍应人工检查。
- 最终发布批准始终属于人，测试通过或 Gate 通过不等于生产发布授权。

## 已知限制

- 当前是本地 alpha，不应直接视为生产级任务系统或发布平台。
- 默认结构分析面向 TypeScript/JavaScript；Python 目前仅有 pytest 与 L0/L1 的隔离夹具证据，相关结构开关默认关闭，不能表述为已全面支持 Python。
- 静态覆盖和影响范围是启发式结果，不证明业务语义正确，也不能替代真实测试。
- 分布式探针和多主高可用属于可选实验模块；现有验证不等同于跨机部署、真实网络分区或生产 SLA。
- 除已明确验证的客户端外，不宣称真实兼容；配置目录存在或命令可生成不代表宿主已经验证。
- 证据身份不是密码学签名，账本与 Gate 也不能防御所有同用户恶意进程。
- Windows 掉电级持久性尚未得到承诺。
- `attest`、`sync`、`push` 等能力未作为 Agent 可执行工作流接通。

## 适合谁

- 希望给 AI 编程工作增加可复核验收证据的开发者；
- 需要保留任务、决策和验证历史的个人或团队；
- 正在研究 Agent 工作流、代码结构分析和证据门禁的工程师。

如果你只是想快速理解这个项目，可以记住一句话：

> **ANO 不替人批准一切；它负责把“为什么可以完成或发布”变成可检查的证据链。**

## License

MIT
