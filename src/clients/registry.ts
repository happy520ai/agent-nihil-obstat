/**
 * Client registry (T-080, extended by T-092 / ADR-008).
 *
 * Registers the 24 canonical clients: the 21 ADR-008 §3 tools plus the three
 * M11 legacy non-catalog clients (`opencode`/`pi`/`zcode`). The registry is
 * pure metadata: it never probes the filesystem, spawns processes or reads
 * configuration content. Unknown ids are rejected.
 *
 * ADR-008 §3/§4: every descriptor records the product form, interface carriers,
 * official sources and the initial client-level evidence label. Nothing here
 * claims a measurement; the 21 tools start `unverified` and their paths are
 * probe candidates, not facts.
 */

import {
  CLIENT_ALIAS_TARGET,
  CLIENT_IDS,
  type ClientDescriptor,
  type ClientId,
  type ConfigCandidate,
  type ConfigFormat,
  type ConfigScope,
  type IdentitySource,
  type IdentitySourceKind,
} from './types.ts';

export class UnknownClientError extends Error {
  readonly clientId: string;

  constructor(clientId: string) {
    super(`unknown client id: ${clientId}`);
    this.name = 'UnknownClientError';
    this.clientId = clientId;
  }
}

function executable(value: string, detail: string | null = null): IdentitySource {
  return { kind: 'executable' as IdentitySourceKind, value, detail };
}

function configPath(value: string, detail: string | null = null): IdentitySource {
  return { kind: 'config-path' as IdentitySourceKind, value, detail };
}

function env(name: string, detail: string | null = null): IdentitySource {
  return { kind: 'env' as IdentitySourceKind, value: name, detail };
}

function candidate(
  path: string,
  scope: ConfigScope,
  format: ConfigFormat,
  key: string,
): ConfigCandidate {
  return { path, scope, format, key };
}

/**
 * Declared sources only. Every entry is a probe candidate, not a verified
 * fact; local verification stays `unverified` until a real probe runs.
 *
 * Order matches `CLIENT_IDS` so the default doctor report and the id list stay
 * aligned. The 21 ADR-008 tools are marked 待核实 / 未实测 in their notes.
 */
const DESCRIPTORS: readonly ClientDescriptor[] = [
  {
    id: 'claude-code',
    alias: 'cloudcode',
    identityStatus: 'declared',
    identitySources: [
      executable('claude', 'Claude Code CLI on PATH'),
      configPath('~/.claude/', 'user configuration directory'),
      configPath('CLAUDE.md', 'project instruction file'),
    ],
    configCandidates: [
      candidate('~/.claude/settings.json', 'user', 'json', 'mcpServers.ano'),
      candidate('~/.claude.json', 'user', 'json', 'mcpServers.ano'),
      candidate('<root>/.mcp.json', 'project', 'json', 'mcpServers.ano'),
    ],
    rulePaths: ['CLAUDE.md'],
    notes: ['cloudcode is reported under claude-code with alias=cloudcode'],
    productForms: ['cli'],
    interfaceCarriers: ['mcp', 'rules'],
    officialSources: ['https://code.claude.com/docs'],
    initialVerdict: 'unverified',
  },
  {
    id: 'github-copilot',
    alias: null,
    identityStatus: 'declared',
    identitySources: [
      executable('copilot', 'GitHub Copilot CLI（待核实）'),
      configPath('~/.copilot/mcp-config.json', 'MCP 配置候选（待核实）'),
      configPath('~/.copilot/copilot-instructions.md', '指令文件候选（待核实）'),
    ],
    configCandidates: [
      candidate('~/.copilot/mcp-config.json', 'user', 'json', 'mcpServers.ano'),
      candidate('<root>/.mcp.json', 'project', 'json', 'mcpServers.ano'),
    ],
    rulePaths: [
      '~/.copilot/copilot-instructions.md',
      '~/.copilot/instructions',
      '.github/copilot-instructions.md',
      '.github/instructions',
    ],
    notes: [
      'ADR-008 §3：IDE 插件 + CLI + 云端 agent；配置路径为探测候选，待核实',
      'T-101 修正：补齐工作区 `.mcp.json` 候选与仓库级 `.github/` 指令路径（E1）',
      '初始 verdict=unverified：未实测，能力层默认 unavailable',
    ],
    productForms: ['ide-plugin', 'cli', 'cloud-service'],
    interfaceCarriers: ['mcp', 'rules'],
    officialSources: [
      'https://docs.github.com/en/copilot',
      'https://docs.github.com/en/copilot/concepts/copilot-surfaces/copilot-cli',
    ],
    initialVerdict: 'unverified',
  },
  {
    id: 'cursor',
    alias: null,
    identityStatus: 'declared',
    identitySources: [
      executable('cursor', 'Cursor CLI on PATH'),
      configPath('~/.cursor/', 'user configuration directory'),
      configPath('.cursor/rules', 'project rule directory'),
    ],
    configCandidates: [
      candidate('~/.cursor/mcp.json', 'user', 'json', 'mcpServers.ano'),
      candidate('<root>/.cursor/mcp.json', 'project', 'json', 'mcpServers.ano'),
    ],
    rulePaths: ['.cursorrules', '.cursor/rules'],
    notes: [],
    productForms: ['editor'],
    interfaceCarriers: ['mcp', 'rules'],
    officialSources: ['https://cursor.com/docs'],
    initialVerdict: 'unverified',
  },
  {
    id: 'codex',
    alias: null,
    identityStatus: 'declared',
    identitySources: [
      executable('codex', 'Codex CLI on PATH'),
      configPath('~/.codex/', 'user configuration directory'),
      configPath('AGENTS.md', 'project instruction file'),
    ],
    configCandidates: [candidate('~/.codex/config.toml', 'user', 'toml', 'mcp_servers.ano')],
    rulePaths: ['AGENTS.md'],
    notes: [],
    productForms: ['cli'],
    interfaceCarriers: ['mcp', 'rules'],
    officialSources: ['https://developers.openai.com/codex/cli/'],
    initialVerdict: 'unverified',
  },
  {
    id: 'trae',
    alias: null,
    identityStatus: 'declared',
    identitySources: [configPath('.trae/mcp.json', 'project MCP config（官方 Trae 文档，E1）')],
    configCandidates: [candidate('<root>/.trae/mcp.json', 'project', 'json', 'mcpServers.ano')],
    rulePaths: [],
    notes: [
      'ADR-008 §3：编辑器 + 云端 Web；T-101 按官方文档补齐项目级 `.trae/mcp.json` 候选（E1）',
      '全局 `mcp.json` 目录未公开，不声明 user 候选、不猜路径',
      '初始 verdict=unverified：接口已公开核实（E1），未实测',
    ],
    productForms: ['editor', 'cloud-service'],
    interfaceCarriers: ['mcp'],
    officialSources: ['https://www.trae.ai/', 'https://docs.trae.cn/', 'https://work.trae.ai'],
    initialVerdict: 'unverified',
  },
  {
    id: 'antigravity',
    alias: null,
    identityStatus: 'declared',
    identitySources: [
      executable('agy', 'Antigravity CLI（待核实）'),
      configPath('~/.gemini/config/mcp_config.json', 'MCP 配置候选（待核实）'),
      configPath('<root>/.agents/mcp_config.json', '工作区 MCP 配置候选（待核实）'),
    ],
    configCandidates: [
      candidate('~/.gemini/config/mcp_config.json', 'user', 'json', 'mcpServers.ano'),
      candidate('<root>/.agents/mcp_config.json', 'project', 'json', 'mcpServers.ano'),
    ],
    rulePaths: [],
    notes: [
      'ADR-008 §3：编辑器 + CLI + SDK + 云端 App；CLI `agy` 与配置路径待核实',
      '初始 verdict=unverified：未实测，能力层默认 unavailable',
    ],
    productForms: ['editor', 'cli', 'cloud-service'],
    interfaceCarriers: ['mcp', 'plugin', 'cli'],
    officialSources: [
      'https://antigravity.google/',
      'https://antigravity.google/docs/mcp/',
      'https://antigravity.google/docs/plugins/',
    ],
    initialVerdict: 'unverified',
  },
  {
    id: 'replit-agent',
    alias: null,
    identityStatus: 'declared',
    identitySources: [],
    configCandidates: [],
    rulePaths: [],
    notes: [
      'ADR-008 §3：云端服务（cloud-only），无本地 MCP/配置接口；不生成本地配置',
      '初始 verdict=unverified：未实测，云端能力不冒充本地接管',
    ],
    productForms: ['cloud-service'],
    interfaceCarriers: ['none'],
    officialSources: ['https://replit.com/site/agent', 'https://docs.replit.com/replitai/agent'],
    initialVerdict: 'unverified',
  },
  {
    id: 'cline',
    alias: null,
    identityStatus: 'declared',
    identitySources: [
      configPath('~/.cline/data/settings/cline_mcp_settings.json', 'MCP 设置候选（待核实）'),
      env('CLINE_MCP_SETTINGS_PATH', 'MCP 设置路径覆写环境变量（待核实）'),
    ],
    configCandidates: [
      candidate('~/.cline/data/settings/cline_mcp_settings.json', 'user', 'json', 'mcpServers.ano'),
    ],
    rulePaths: [],
    notes: [
      'ADR-008 §3：IDE 插件 + CLI；配置路径待核实',
      '初始 verdict=unverified：未实测，能力层默认 unavailable',
    ],
    productForms: ['ide-plugin', 'cli'],
    interfaceCarriers: ['mcp'],
    officialSources: ['https://cline.bot/', 'https://docs.cline.bot/mcp/mcp-overview'],
    initialVerdict: 'unverified',
  },
  {
    id: 'kilo-code',
    alias: null,
    identityStatus: 'declared',
    identitySources: [
      executable('kilo', 'Kilo Code CLI（待核实）'),
      configPath('~/.config/kilo/kilo.jsonc', 'MCP 配置候选（待核实）'),
    ],
    configCandidates: [
      candidate('~/.config/kilo/kilo.jsonc', 'user', 'json', 'mcp.ano'),
      candidate('<root>/kilo.jsonc', 'project', 'json', 'mcp.ano'),
      candidate('<root>/.kilo/kilo.jsonc', 'project', 'json', 'mcp.ano'),
    ],
    rulePaths: [],
    notes: [
      'ADR-008 §3：IDE 插件 + CLI；配置路径待核实',
      '初始 verdict=unverified：未实测，能力层默认 unavailable',
    ],
    productForms: ['ide-plugin', 'cli'],
    interfaceCarriers: ['mcp', 'cli'],
    officialSources: ['https://kilo.ai/', 'https://github.com/Kilo-Org/kilocode'],
    initialVerdict: 'unverified',
  },
  {
    id: 'hermes-agent',
    alias: null,
    identityStatus: 'declared',
    identitySources: [
      executable('hermes', 'Hermes Agent CLI（待核实）'),
      configPath('~/.hermes/config.yaml', '配置候选（YAML，待核实）'),
      configPath('~/.hermes/SOUL.md', '规则文件候选（待核实）'),
    ],
    configCandidates: [],
    rulePaths: ['~/.hermes/SOUL.md'],
    notes: [
      'ADR-008 §3：CLI + 桌面 App + 云端 Portal；配置为 YAML，v1 配置读写仅支持 json/toml，暂不声明 configCandidate',
      '初始 verdict=unverified：未实测，能力层默认 unavailable',
    ],
    productForms: ['cli', 'desktop-app', 'cloud-service'],
    interfaceCarriers: ['mcp', 'rules', 'cli'],
    officialSources: [
      'https://hermes-agent.nousresearch.com/',
      'https://github.com/NousResearch/hermes-agent',
    ],
    initialVerdict: 'unverified',
  },
  {
    id: 'openclaw',
    alias: null,
    identityStatus: 'declared',
    identitySources: [
      executable('openclaw', 'OpenClaw CLI on PATH'),
      configPath('~/.openclaw/openclaw.json', 'OpenClaw 用户配置（E1: docs.openclaw.ai/tools/mcp）'),
    ],
    configCandidates: [candidate('~/.openclaw/openclaw.json', 'user', 'json', 'mcp.servers.ano')],
    rulePaths: [],
    notes: [
      'ADR-008 §3：自托管代理框架 / CLI / 桌面 App；T-095 E1 核实 `mcp.servers.<name>` 键，未实测',
      'T-101 修正：补配置候选；接口按 E1 记录但能力层未握手，绝不 validated',
      '初始 verdict=unverified：未实测，能力层默认 unavailable',
    ],
    productForms: ['agent-framework', 'cli', 'desktop-app'],
    interfaceCarriers: ['mcp', 'plugin'],
    officialSources: [
      'https://openclaw.ai/',
      'https://github.com/openclaw/openclaw',
      'https://docs.openclaw.ai/',
    ],
    initialVerdict: 'unverified',
  },
  {
    id: 'zed',
    alias: null,
    identityStatus: 'declared',
    identitySources: [
      configPath('~/.config/zed/settings.json', 'Agent Settings 候选（路径待核实）'),
      configPath('~/AppData/Roaming/Zed/settings.json', 'Windows Agent Settings 候选（路径待核实）'),
      configPath('~/Library/Application Support/Zed/settings.json', 'macOS Agent Settings 候选（路径待核实）'),
    ],
    configCandidates: [candidate('~/.config/zed/settings.json', 'user', 'json', 'context_servers.ano')],
    rulePaths: [],
    notes: [
      'ADR-008 §3：编辑器；settings 文件路径官方未明示，待核实',
      '初始 verdict=unverified：未实测，能力层默认 unavailable',
    ],
    productForms: ['editor'],
    interfaceCarriers: ['mcp'],
    officialSources: ['https://zed.dev/', 'https://zed.dev/docs/ai/mcp'],
    initialVerdict: 'unverified',
  },
  {
    id: 'tabnine',
    alias: null,
    identityStatus: 'declared',
    identitySources: [],
    configCandidates: [],
    rulePaths: [],
    notes: [
      'ADR-008 §3：IDE 插件 + 云端 Agent；无公开 MCP 接口（待核实），不冒充本地接管',
      '初始 verdict=unverified：未实测，能力层默认 unavailable',
    ],
    productForms: ['ide-plugin', 'cloud-service'],
    interfaceCarriers: ['none'],
    officialSources: ['https://www.tabnine.com/', 'https://docs.tabnine.com/'],
    initialVerdict: 'unverified',
  },
  {
    id: 'amazon-q',
    alias: null,
    identityStatus: 'declared',
    identitySources: [
      executable('kiro-cli', 'Kiro CLI v3+ standalone binary（E1: kiro.dev/docs/cli）'),
      executable('kiro', 'registry 旧名/待核实候选'),
      configPath('~/.kiro/settings/mcp.json', 'Kiro 用户级 MCP 配置（E1: kiro.dev/docs/mcp/configuration）'),
      configPath('<root>/.kiro/settings/mcp.json', 'Kiro 工作区 MCP 配置（E1: kiro.dev/docs/mcp/configuration）'),
      env('KIRO_HOME', 'Kiro home 覆写环境变量（待核实）'),
    ],
    configCandidates: [
      candidate('~/.kiro/settings/mcp.json', 'user', 'json', 'mcpServers.ano'),
      candidate('<root>/.kiro/settings/mcp.json', 'project', 'json', 'mcpServers.ano'),
    ],
    rulePaths: ['~/.kiro/steering', '<root>/.kiro/steering'],
    notes: [
      'ADR-008 §3：IDE 插件 + CLI（Kiro 血统）+ 云端；IDE 插件 2027-04-30 终止支持',
      'T-101 修正：CLI 主名 kiro→kiro-cli（E1），kiro 保留为待核实旧名',
      '初始 verdict=unverified：未实测，能力层默认 unavailable',
    ],
    productForms: ['ide-plugin', 'cli', 'cloud-service'],
    interfaceCarriers: ['mcp', 'cli', 'rules'],
    officialSources: ['https://aws.amazon.com/q/developer/', 'https://kiro.dev/docs/cli'],
    initialVerdict: 'unverified',
  },
  {
    id: 'jetbrains-ai',
    alias: null,
    identityStatus: 'declared',
    identitySources: [],
    configCandidates: [],
    rulePaths: [],
    notes: [
      'ADR-008 §3：IDE 插件；无公开 MCP 接口（待核实），配置在 IDE 设置内，不冒充本地接管',
      '初始 verdict=unverified：未实测，能力层默认 unavailable',
    ],
    productForms: ['ide-plugin'],
    interfaceCarriers: ['none'],
    officialSources: ['https://www.jetbrains.com/ai/', 'https://www.jetbrains.com/help/ai-assistant/'],
    initialVerdict: 'unverified',
  },
  {
    id: 'codegeex',
    alias: null,
    identityStatus: 'declared',
    identitySources: [],
    configCandidates: [],
    rulePaths: [],
    notes: [
      'ADR-008 §3：IDE 插件（VS Code/JetBrains）；无公开 MCP 接口（待核实），不冒充本地接管',
      '初始 verdict=unverified：未实测，能力层默认 unavailable',
    ],
    productForms: ['ide-plugin'],
    interfaceCarriers: ['none'],
    officialSources: [
      'https://codegeex.cn/',
      'https://github.com/zai-org/CodeGeeX',
      'https://github.com/CodeGeeX/codegeex-vscode-extension',
    ],
    initialVerdict: 'unverified',
  },
  {
    id: 'tongyi-lingma',
    alias: null,
    identityStatus: 'declared',
    identitySources: [
      executable('qodercn', 'Qoder CN CLI 官方命令（E1: docs.qoder.cn/cli/installation）'),
      executable('qoder', 'registry 候选；与国际版 Qoder CLI 命令相同，待核实'),
      configPath('~/.qoder-cn/settings.json', 'Qoder CN 用户级设置（E1: docs.qoder.cn/cli/settings-reference）'),
      configPath('<root>/.qoder/settings.json', 'Qoder CN 项目级设置（E1；与国际版 Qoder 共用路径）'),
      configPath('<root>/.mcp.json', 'Qoder CN 项目级 MCP 设置（E1: docs.qoder.cn/cli/mcp-reference）'),
      env('QODERCN_CONFIG_DIR', 'Qoder CN 配置目录覆写变量（E1）'),
    ],
    configCandidates: [
      candidate('~/.qoder-cn/settings.json', 'user', 'json', 'mcpServers.ano'),
      candidate('<root>/.qoder/settings.json', 'project', 'json', 'mcpServers.ano'),
      candidate('<root>/.mcp.json', 'project', 'json', 'mcpServers.ano'),
      candidate('<root>/.qoder/settings.local.json', 'workspace', 'json', 'mcpServers.ano'),
    ],
    rulePaths: ['AGENTS.md'],
    notes: [
      'ADR-008 §3：IDE 插件 + IDE + CLI（Qoder CN）；与国际版 qoder 是不同产品，不得合并',
      'T-101 修正：CLI 主名 qoder→qodercn（E1），qoder 保留为待核实歧名',
      '初始 verdict=unverified：未实测，能力层默认 unavailable',
    ],
    productForms: ['ide-plugin', 'editor', 'cli'],
    interfaceCarriers: ['mcp', 'rules', 'cli'],
    officialSources: [
      'https://lingma.aliyun.com/',
      'https://docs.qoder.cn/',
      'https://help.aliyun.com/zh/lingma/',
    ],
    initialVerdict: 'unverified',
  },
  {
    id: 'comate',
    alias: null,
    identityStatus: 'declared',
    identitySources: [
      executable('comatecli', 'Comate CLI（待核实）'),
      configPath('~/.comate/mcp.json', 'MCP 配置候选（待核实）'),
    ],
    configCandidates: [
      candidate('~/.comate/mcp.json', 'user', 'json', 'mcpServers.ano'),
      candidate('<root>/.comate/mcp.json', 'project', 'json', 'mcpServers.ano'),
    ],
    rulePaths: ['.comate'],
    notes: [
      'ADR-008 §3：IDE + IDE 插件 + CLI；配置路径待核实；企业/云权限限制明示',
      '初始 verdict=unverified：未实测，能力层默认 unavailable',
    ],
    productForms: ['editor', 'ide-plugin', 'cli'],
    interfaceCarriers: ['mcp', 'cli', 'rules'],
    officialSources: ['https://comate.baidu.com/zh', 'https://cloud.baidu.com/doc/COMATE/'],
    initialVerdict: 'unverified',
  },
  {
    id: 'qoder',
    alias: null,
    identityStatus: 'unverified',
    // Public interface unconfirmed (T-084); no path may be assumed.
    identitySources: [],
    configCandidates: [],
    rulePaths: [],
    notes: [
      'public interface pending verification (T-084); no config path assumed',
      'measured facts and configuration facts are recorded separately',
    ],
    productForms: ['editor', 'agent-framework', 'cli', 'cloud-service'],
    interfaceCarriers: ['mcp', 'cli'],
    officialSources: ['https://qoder.com/', 'https://docs.qoder.com/cli/mcp-servers', 'https://docs.qoder.com/'],
    initialVerdict: 'unverified',
  },
  {
    id: 'codebuddy',
    alias: null,
    identityStatus: 'declared',
    identitySources: [
      executable('codebuddy', 'CodeBuddy CLI（待核实）'),
      executable('cbc', 'CodeBuddy CLI 命令别名 cbc（待核实）'),
      configPath('~/.codebuddy/.mcp.json', 'MCP 配置候选（待核实）'),
      configPath('~/.codebuddy/mcp.json', 'MCP 配置候选（待核实）'),
    ],
    configCandidates: [
      candidate('~/.codebuddy/.mcp.json', 'user', 'json', 'mcpServers.ano'),
      candidate('~/.codebuddy/mcp.json', 'user', 'json', 'mcpServers.ano'),
      candidate('<root>/.mcp.json', 'project', 'json', 'mcpServers.ano'),
    ],
    rulePaths: ['CODEBUDDY.md', 'rules'],
    notes: [
      'ADR-008 §3：IDE + IDE 插件 + CLI；`cbc` 是 CLI 命令别名，不是 ClientId 别名',
      '初始 verdict=unverified：未实测，能力层默认 unavailable',
    ],
    productForms: ['editor', 'ide-plugin', 'cli'],
    interfaceCarriers: ['mcp', 'cli', 'rules'],
    officialSources: ['https://www.codebuddy.cn/', 'https://www.codebuddy.ai/', 'https://copilot.tencent.com/ide/'],
    initialVerdict: 'unverified',
  },
  {
    id: 'deepseek-harness',
    alias: 'dsh',
    identityStatus: 'declared',
    identitySources: [
      executable('dsh', 'DeepSeek Harness CLI on PATH'),
      env('DSH_HOME', 'DeepSeek Harness home directory'),
      configPath('cordis.yml', 'Cordis 配置候选（待核实）'),
      configPath('$DSH_HOME/cordis.patch.yml', '用户 patch 候选（待核实）'),
    ],
    configCandidates: [],
    rulePaths: [],
    notes: [
      'ADR-008 §8：dsh 是 deepseek-harness 的别名；身份与公开接口已核实（declared），不再是 unknown',
      '能力层按证据判定：未实测一律 unverified，绝不因旧规则压低，也不得无证据抬高',
      '本机未发现 dsh 可执行与 $DSH_HOME（待核实）；配置载体为 Cordis cordis.patch.yml',
      'ACP/SDK 握手不得当作 ANO MCP 七工具验证',
    ],
    productForms: ['agent-framework', 'cli', 'desktop-app', 'web-ui'],
    interfaceCarriers: ['cordis', 'mcp', 'acp', 'sdk', 'cli'],
    officialSources: [
      'https://deepseek.com/harness',
      'https://github.com/deepseek-ai/deepseek-harness',
      'https://deepseek-harness.github.io/deepseek-harness/',
    ],
    initialVerdict: 'unverified',
  },
  {
    id: 'opencode',
    alias: null,
    identityStatus: 'declared',
    identitySources: [
      executable('opencode', 'OpenCode CLI on PATH'),
      configPath('~/.config/opencode/', 'user configuration directory'),
      configPath('AGENTS.md', 'project instruction file'),
    ],
    configCandidates: [
      candidate('~/.config/opencode/opencode.json', 'user', 'json', 'mcp.ano'),
      candidate('<root>/opencode.json', 'project', 'json', 'mcp.ano'),
      candidate('<root>/.opencode.json', 'project', 'json', 'mcp.ano'),
    ],
    rulePaths: ['AGENTS.md'],
    notes: [],
    productForms: ['cli'],
    interfaceCarriers: ['mcp', 'rules'],
    officialSources: [],
    initialVerdict: 'unverified',
  },
  {
    id: 'pi',
    alias: null,
    identityStatus: 'unknown',
    identitySources: [],
    configCandidates: [],
    rulePaths: [],
    notes: [
      'identity or interface unclear: probe declared public sources only',
      'never guess paths, never fabricate an adapter, never validate',
    ],
    productForms: ['unknown'],
    interfaceCarriers: [],
    officialSources: [],
    initialVerdict: 'unavailable',
  },
  {
    id: 'zcode',
    alias: null,
    identityStatus: 'declared',
    identitySources: [
      configPath('~/.zcode/cli/config.json', 'effective user configuration'),
      configPath('~/.zcode/v2/config.json', 'legacy user configuration'),
      configPath('<root>/.zcode/config.json', 'workspace configuration'),
      configPath('AGENTS.md', 'project instruction file'),
    ],
    configCandidates: [
      candidate('~/.zcode/cli/config.json', 'user', 'json', 'mcp.servers.ano'),
      candidate('~/.zcode/v2/config.json', 'user', 'json', 'mcp.servers.ano'),
      candidate('<root>/.zcode/config.json', 'workspace', 'json', 'mcp.servers.ano'),
    ],
    rulePaths: ['AGENTS.md'],
    notes: [
      'user-level configuration is read-only for clients; never modified',
      'host capability was proven degraded by T-055',
    ],
    productForms: ['cli'],
    interfaceCarriers: ['mcp', 'rules'],
    officialSources: [],
    initialVerdict: 'unverified',
  },
];

export const DEFAULT_REGISTRY_DESCRIPTORS: readonly ClientDescriptor[] = Object.freeze(DESCRIPTORS);

export function isClientId(value: string): value is ClientId {
  return (CLIENT_IDS as readonly string[]).includes(value);
}

/** Resolves a known id or alias (`cloudcode` -> `claude-code`, `dsh` -> `deepseek-harness`); null otherwise. */
export function resolveClientId(value: string): ClientId | null {
  if (isClientId(value)) return value;
  if ((CLIENT_ALIAS_TARGET as Readonly<Record<string, ClientId>>)[value] !== undefined) {
    return (CLIENT_ALIAS_TARGET as Readonly<Record<string, ClientId>>)[value] ?? null;
  }
  return null;
}

export interface ClientRegistry {
  readonly descriptors: readonly ClientDescriptor[];
  list(): readonly ClientDescriptor[];
  get(id: string): ClientDescriptor;
  has(id: string): boolean;
}

export function createRegistry(descriptors: readonly ClientDescriptor[] = DEFAULT_REGISTRY_DESCRIPTORS): ClientRegistry {
  const byId = new Map<string, ClientDescriptor>();
  for (const descriptor of descriptors) {
    byId.set(descriptor.id, descriptor);
    if (descriptor.alias !== null) byId.set(descriptor.alias, descriptor);
  }
  return {
    descriptors,
    list: () => descriptors,
    get: (id: string): ClientDescriptor => {
      const found = byId.get(id);
      if (!found) throw new UnknownClientError(id);
      return found;
    },
    has: (id: string): boolean => byId.has(id),
  };
}

export const defaultRegistry: ClientRegistry = createRegistry();

/** Convenience wrapper over the default registry; rejects unknown ids. */
export function getDescriptor(id: string): ClientDescriptor {
  return defaultRegistry.get(id);
}

export function listDescriptors(): readonly ClientDescriptor[] {
  return defaultRegistry.list();
}
