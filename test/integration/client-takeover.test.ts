import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import {
  CLIENT_ACCESS_PLAN_SCHEMA,
  CLIENT_ACCESS_ROUTES,
  CLIENT_CAPABILITY_COLUMNS,
  CLIENT_TAKEOVER_CAPABILITIES_SCHEMA,
  HOST_AUTO_APPROVAL_AVAILABLE,
  HOST_AUTO_INTERCEPTION_AVAILABLE,
  HOST_AUTO_SESSION_DAEMON_AVAILABLE,
  clientAccessPlans,
  clientTakeoverCapabilities,
  mapClientCapabilities,
  type ClientAccessPlan,
  type ClientCapabilityJudgement,
} from '../../src/clients/capabilities.ts';
import { createClaudeCodeAdapter } from '../../src/clients/claude-code.ts';
import { createCodexAdapter } from '../../src/clients/codex.ts';
import { restoreClientConfig, type ClientConfigTarget } from '../../src/clients/config.ts';
import { cursorAdapter } from '../../src/clients/cursor.ts';
import { doctorClients, registerAllClientAdapters, unavailableLayerReports } from '../../src/clients/doctor.ts';
import { createQoderAdapter } from '../../src/clients/qoder.ts';
import { opencodeAdapter } from '../../src/clients/opencode.ts';
import { dshAdapter, piAdapter } from '../../src/clients/unknown.ts';
import {
  CAPABILITY_LAYERS,
  CLIENT_IDS,
  CLIENT_REPORT_SCHEMA,
  MCP_TOOL_NAMES,
  type ClientAdapter,
  type ClientId,
  type ClientReport,
  type ClientVerdict,
  type DetectResult,
  type McpClientLike,
  type MutableLayerReports,
  type VerifyResult,
} from '../../src/clients/types.ts';
import { MANAGED_INSTRUCTIONS_BEGIN } from '../../src/connect/managed-instructions.ts';
import { resolveRoot } from '../../src/connect/paths.ts';
import { createAuthorization } from '../../src/connect/takeover-policy.ts';
import { loadPolicy, saveAuthorization } from '../../src/connect/takeover-store.ts';
import {
  runTakeover,
  takeoverStatus,
  TAKEOVER_HOST_CAPABILITY_REASONS,
} from '../../src/connect/takeover.ts';

// ============================================================================
// T-086 / MC-08：多客户端项目接管与 DAG 能力映射（隔离项目实测）。
//
// 证据分层（ADR-006 §8；与 docs/evidence/host-capability-investigation.md 同口径）：
//   L1 库/隔离项目：本文件全部用例，真实 os.tmpdir() 合成 home/root + 真实适配器。
//   L2 可用路径：真实 spawn scripts/orchestration/cli.ts --plan dry-run（零写入）。
//   L3 会话/主控适配：M10 runTakeover 六阶段到 enforced；宿主无自动建会话/拦截/
//      批准接口（T-055），因此会话启动由显式调用驱动，主控先例是 pm-bridge.mjs。
//   L4 UI / L5 跨项目：本 harness 不现场验证，测试名与断言显式标注未验证。
//
// 禁止虚报：不得宣称客户端自动派发、不得宣称通用自动输出拦截、不得把 CLI doctor
// 成功或合成 adapter 放大为 validated。恢复路径需显式授权与已验证备份。
// ============================================================================

const NOW = '2026-11-23T00:00:00.000Z';
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ORCHESTRATION_CLI_PATH = fileURLToPath(new URL('../../scripts/orchestration/cli.ts', import.meta.url));
const PM_BRIDGE_PATH = fileURLToPath(new URL('../../scripts/orchestration/pm-bridge.mjs', import.meta.url));
const HOST_INVESTIGATION_DOC = fileURLToPath(new URL('../../docs/evidence/host-capability-investigation.md', import.meta.url));
const CLIENT_ORCHESTRATION_DOC = fileURLToPath(new URL('../../docs/evidence/client-orchestration.md', import.meta.url));

const FORBIDDEN_HOST_CLAIMS = [/自动拦截/u, /自动批准/u, /auto.?intercept/iu, /auto.?approve/iu] as const;

const AGENTS_ORIGINAL = '<!-- pm-mcp:agents-md:v1:begin -->\npm rules\n<!-- pm-mcp:agents-md:v1:end -->\n\n# User notes\n\nkeep this 字节\n';

const EVIDENCE_LAYERS = [
  { layer: '库（本测试，隔离 tmpdir home/root）', verified: true },
  { layer: '可用路径（真实 spawn 调度器 dry-run / M10 runTakeover）', verified: true },
  { layer: '会话/主控适配（显式调用，非宿主自动）', verified: true },
  { layer: 'UI', verified: false },
  { layer: '跨项目', verified: false },
] as const;

// ---- helpers ------------------------------------------------------------

async function makeTemp(t: TestContext, prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function writeText(root: string, relative: string, content: string): Promise<void> {
  const target = join(root, ...relative.split('/'));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

function isVerdict(value: string): value is ClientVerdict {
  return value === 'validated' || value === 'degraded' || value === 'unavailable';
}

interface IsolatedEnv {
  readonly root: string;
  readonly home: string;
  readonly env: Record<string, string>;
  readonly probePaths: readonly string[];
}

/**
 * Synthetic isolated home/root. Only directories and marker files are created;
 * no real client configuration content is read and nothing outside tmpdir is
 * touched. The empty PATH plus an empty probe-path list keeps executable
 * detection from escaping the fixture.
 */
async function makeIsolatedEnv(t: TestContext): Promise<IsolatedEnv> {
  const root = await makeTemp(t, 'ano-client-takeover-root-');
  const home = await makeTemp(t, 'ano-client-takeover-home-');
  for (const rel of ['.claude', '.codex', '.cursor/rules', '.config/opencode', '.qoder', '.zcode/cli']) {
    await mkdir(join(home, ...rel.split('/')), { recursive: true });
  }
  await writeText(home, '.zcode/cli/config.json', '{}\n');
  await writeText(root, '.zcode/config.json', '{}\n');
  await writeText(root, 'AGENTS.md', '# Fixture rules\n');
  await writeText(root, 'CLAUDE.md', '# Fixture CLAUDE rules\n');
  await writeText(root, '.cursorrules', 'fixture cursor rules\n');
  return {
    root,
    home,
    env: { PATH: '', HOME: home, USERPROFILE: home },
    probePaths: [],
  };
}

function adaptersFor(env: IsolatedEnv): Readonly<Partial<Record<ClientId, ClientAdapter>>> {
  return {
    'claude-code': createClaudeCodeAdapter({
      home: env.home,
      root: env.root,
      env: env.env,
      probePaths: env.probePaths,
    }),
    codex: createCodexAdapter({
      home: env.home,
      root: env.root,
      env: env.env,
      probePaths: env.probePaths,
    }),
    qoder: createQoderAdapter({ home: env.home, root: env.root }),
    dsh: dshAdapter,
    pi: piAdapter,
    cursor: cursorAdapter,
    opencode: opencodeAdapter,
  };
}

function emptyVerdicts(): Record<(typeof CAPABILITY_LAYERS)[number], ClientVerdict> {
  return {
    detected: 'unavailable',
    configured: 'unavailable',
    mcp: 'unavailable',
    tools: 'unavailable',
    brief: 'unavailable',
    instructions: 'unavailable',
    orchestration: 'unavailable',
    history: 'unavailable',
    'output-interception': 'unavailable',
  };
}

function successfulVerify(at: string): VerifyResult {
  return {
    handshake: {
      transport: 'stdio',
      protocolVersion: '2025-06-18',
      serverInfo: { name: 'fake-ano', version: '1.0.0' },
      latencyMs: 1,
      startedAt: at,
    },
    tools: { count: MCP_TOOL_NAMES.length, names: [...MCP_TOOL_NAMES], missing: [], extra: [] },
    brief: {
      schema: { phase: 'P7', project_scope: 'local', memory_context: { context_id: 'ctx-1' }, hostCapability: 'degraded' },
      hasProjectContext: true,
      takeoverProjection: true,
      hostCapability: 'degraded',
    },
    verdicts: { ...emptyVerdicts(), mcp: 'validated', tools: 'validated', brief: 'validated' },
    errors: [],
  };
}

/** Injected stdio client that really answers initialize/tools/list/brief. */
function fakeMcpClient(): McpClientLike {
  return {
    async initialize() {
      return { protocolVersion: '2025-06-18', serverInfo: { name: 'fake-ano', version: '1.0.0' } };
    },
    async listTools() {
      return { tools: [...MCP_TOOL_NAMES].map((name) => ({ name })) };
    },
    async callTool(request: { name: string }) {
      if (request.name === 'brief') {
        return {
          payload: {
            phase: 'P7',
            project_scope: 'local',
            memory_context: { context_id: 'ctx-1' },
            hostCapability: 'degraded',
          },
        };
      }
      return {};
    },
    async close() {},
  };
}

/** A lying adapter that self-reports every layer validated/measured. */
function lyingAdapter(id: ClientId, at: string): ClientAdapter {
  const base = unavailableLayerReports(at, `liar:${id}`);
  const validatedLayers: MutableLayerReports = {
    detected: { ...base.detected, verdict: 'validated', evidence: 'measured' },
    configured: { ...base.configured, verdict: 'validated', evidence: 'measured' },
    mcp: { ...base.mcp, verdict: 'validated', evidence: 'measured' },
    tools: { ...base.tools, verdict: 'validated', evidence: 'measured' },
    brief: { ...base.brief, verdict: 'validated', evidence: 'measured' },
    instructions: { ...base.instructions, verdict: 'validated', evidence: 'measured' },
    orchestration: { ...base.orchestration, verdict: 'validated', evidence: 'measured' },
    history: { ...base.history, verdict: 'validated', evidence: 'measured' },
    'output-interception': { ...base['output-interception'], verdict: 'validated', evidence: 'measured' },
  };
  return {
    id,
    identitySources: [],
    detect: async (): Promise<DetectResult> => ({
      clientId: id,
      detected: true,
      executablePath: `/fake/${id}`,
      version: '9.9.9',
      sources: [],
      errors: [],
    }),
    inspect: async (): Promise<ClientReport> => ({
      schema: CLIENT_REPORT_SCHEMA,
      clientId: id,
      alias: null,
      status: 'ready',
      coreVerdict: 'validated',
      layers: validatedLayers,
      generatedAt: at,
      limitations: [],
      errors: [],
    }),
    config: async () => ({ mode: 'dry-run', changes: [], backupPlan: null, warnings: [] }),
    verify: async () => successfulVerify(at),
  };
}

async function pmFixture(root: string): Promise<void> {
  await writeText(root, '.pm/project.json', `${JSON.stringify({ id: 'fixture-project', name: 'Takeover Fixture' }, null, 2)}\n`);
  await writeText(root, '.pm/tasks.json', `${JSON.stringify({
    seq: 1,
    tasks: [
      { id: 'T-PM-1', title: 'Migrate me', status: 'done', files: ['test/a.test.ts'] },
      { id: 'T-PM-2', title: 'Keep going', status: 'in_progress' },
    ],
  }, null, 2)}\n`);
  await writeText(root, '.pm/roadmap.json', `${JSON.stringify({ seq: 1, milestones: [{ id: 'M1', title: 'One', status: 'active' }] }, null, 2)}\n`);
  await writeText(root, '.pm/features.json', `${JSON.stringify({ seq: 1, features: [{ id: 'F-1', name: 'Feature' }] }, null, 2)}\n`);
  await writeText(root, '.pm/sessions.json', `${JSON.stringify({ seq: 1, sessions: [{ id: 'S-1', summary: 'seed' }] }, null, 2)}\n`);
}

async function pmSnapshot(root: string): Promise<string> {
  const entries: Array<Record<string, unknown>> = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(dir, entry.name);
      const rel = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(full, rel);
      else if (entry.isFile()) {
        const bytes = await readFile(full);
        entries.push({ path: rel, bytes: bytes.length });
      }
    }
  };
  await walk(join(root, '.pm'), '');
  return JSON.stringify(entries);
}

function columnOf(client: ReturnType<typeof mapClientCapabilities>, column: (typeof CLIENT_CAPABILITY_COLUMNS)[number]): ClientCapabilityJudgement {
  return client[column];
}

// ---- tests --------------------------------------------------------------

test('[映射] 二十四客户端×四列能力报告由 doctorClients 编排产出且失败隔离', async (t) => {
  const env = await makeIsolatedEnv(t);
  const report = await clientTakeoverCapabilities({
    root: env.root,
    home: env.home,
    env: env.env,
    probePaths: env.probePaths,
    adapters: adaptersFor(env),
    now: () => NOW,
  });

  assert.equal(report.schema, CLIENT_TAKEOVER_CAPABILITIES_SCHEMA);
  assert.deepEqual(report.clients.map((client) => client.clientId), [...CLIENT_IDS]);
  assert.equal(CLIENT_IDS.length, 24);
  assert.equal(report.clients.length, 24);

  for (const client of report.clients) {
    assert.equal(client.generatedAt, NOW);
    assert.equal(client.hostCapability, 'degraded');
    assert.equal(client.outputInterception.verdict, 'unavailable');
    for (const column of CLIENT_CAPABILITY_COLUMNS) {
      const judgement = columnOf(client, column);
      assert.ok(isVerdict(judgement.verdict), `${client.clientId}.${column} verdict`);
      assert.ok(judgement.limitations.length > 0, `${client.clientId}.${column} must carry limitations`);
    }
    // 合成环境下规则接管 / DAG / 恢复一律不得升级为 validated。
    assert.notEqual(client.rules.verdict, 'validated');
    assert.notEqual(client.dag.verdict, 'validated');
    assert.notEqual(client.recovery.verdict, 'validated');
    const details = client.recovery.details as Record<string, unknown>;
    assert.ok('takeoverRecovery' in details, 'M10 backup/rollback path must be labelled');
    assert.ok('clientConfigRestore' in details, 'client config restore path must be labelled');
    const detected = client.status === 'degraded' || client.status === 'ready';
    if (detected) {
      assert.equal(client.dag.mode, 'explicit-workflow');
      assert.equal(client.dag.verdict, 'degraded');
      assert.equal(client.recovery.verdict, 'degraded');
    } else {
      assert.equal(client.dag.verdict, 'unavailable');
      assert.equal(client.recovery.verdict, 'unavailable');
    }
  }

  const dsh = report.clients.find((client) => client.clientId === 'deepseek-harness');
  const pi = report.clients.find((client) => client.clientId === 'pi');
  assert.ok(dsh && pi);
  // ADR-008 §8: dsh is the declared deepseek-harness alias, not a permanent
  // unknown; without a local measurement it is still not upgraded.
  assert.equal(dsh.alias, 'dsh');
  assert.notEqual(dsh.status, 'unknown', 'dsh resolves to deepseek-harness declared, not a permanent unknown');
  assert.notEqual(dsh.status, 'ready', 'deepseek-harness is unmeasured here and must not be upgraded');
  assert.equal(pi.status, 'unknown');
  for (const client of [dsh, pi]) {
    for (const column of CLIENT_CAPABILITY_COLUMNS) {
      assert.equal(columnOf(client, column).verdict, 'unavailable', `${client.clientId}.${column}`);
    }
  }
});

test('[隔离] 单个客户端探测抛错只降级该客户端，其余客户端报告完整', async (t) => {
  const env = await makeIsolatedEnv(t);
  const throwing: ClientAdapter = {
    id: 'codex',
    identitySources: [],
    detect: async () => {
      throw new Error('injected codex probe failure');
    },
    inspect: async () => {
      throw new Error('injected codex inspect failure');
    },
    config: async () => ({ mode: 'dry-run', changes: [], backupPlan: null, warnings: [] }),
    verify: async () => ({ handshake: null, tools: null, brief: null, verdicts: emptyVerdicts(), errors: [] }),
  };

  const report = await clientTakeoverCapabilities({
    root: env.root,
    home: env.home,
    env: env.env,
    probePaths: env.probePaths,
    adapters: { ...adaptersFor(env), codex: throwing },
    now: () => NOW,
  });

  assert.equal(report.clients.length, 24);
  const codex = report.clients.find((client) => client.clientId === 'codex');
  assert.ok(codex);
  for (const column of CLIENT_CAPABILITY_COLUMNS) {
    assert.equal(columnOf(codex, column).verdict, 'unavailable', `failed codex ${column} must degrade`);
  }
  const claude = report.clients.find((client) => client.clientId === 'claude-code');
  assert.ok(claude);
  assert.equal(claude.dag.verdict, 'degraded');
  assert.equal(claude.rules.verdict, 'degraded');
});

test('[防放大] 撒谎 adapter 自报 validated 仍被降级；Pi 注入无效且 deepseek-harness 未实测不升级', async (t) => {
  const env = await makeIsolatedEnv(t);
  const raw = await doctorClients({
    root: env.root,
    home: env.home,
    env: env.env,
    probePaths: env.probePaths,
    adapters: { ...adaptersFor(env), 'claude-code': lyingAdapter('claude-code', NOW) },
    now: () => NOW,
  });
  const rawClaude = raw.clients.find((client) => client.clientId === 'claude-code');
  assert.ok(rawClaude);
  // 证明撒谎 adapter 确实把 validated 塞进了原始报告的扩展层。
  assert.equal(rawClaude.layers.orchestration.verdict, 'validated');
  assert.equal(rawClaude.layers.instructions.verdict, 'validated');

  const mapped = mapClientCapabilities(rawClaude);
  assert.equal(mapped.rules.verdict, 'degraded', 'rules must cap a lying validated instructions layer');
  assert.equal(mapped.dag.verdict, 'degraded', 'dag must never become validated');
  assert.equal(mapped.recovery.verdict, 'degraded');
  assert.notEqual(mapped.mcp.verdict, 'validated');
  assert.equal(mapped.outputInterception.verdict, 'unavailable');

  // Pi：即使注入撒谎 adapter，doctor 也强制 unknown 降级。
  const piRaw = await doctorClients({
    clientIds: ['pi'],
    root: env.root,
    home: env.home,
    env: env.env,
    probePaths: env.probePaths,
    adapters: { pi: lyingAdapter('pi', NOW) },
    now: () => NOW,
  });
  const mappedPi = mapClientCapabilities(piRaw.clients[0]!);
  assert.equal(mappedPi.status, 'unknown');
  for (const column of CLIENT_CAPABILITY_COLUMNS) {
    assert.equal(columnOf(mappedPi, column).verdict, 'unavailable', `pi.${column}`);
  }

  // deepseek-harness（dsh 别名）：身份已声明，不再被 unknown 闸门拦截；但未实测
  // 不得升级为 validated，四列一律 unavailable。
  const dshRaw = await doctorClients({
    clientIds: ['deepseek-harness'],
    root: env.root,
    home: env.home,
    env: env.env,
    probePaths: env.probePaths,
    adapters: adaptersFor(env),
    now: () => NOW,
  });
  const dshClient = dshRaw.clients[0]!;
  assert.equal(dshClient.clientId, 'deepseek-harness');
  assert.equal(dshClient.alias, 'dsh');
  assert.notEqual(dshClient.status, 'unknown');
  assert.notEqual(dshClient.status, 'ready');
  const mappedDsh = mapClientCapabilities(dshClient);
  for (const column of CLIENT_CAPABILITY_COLUMNS) {
    assert.equal(columnOf(mappedDsh, column).verdict, 'unavailable', `deepseek-harness.${column}`);
  }
});

test('[防放大] MCP 七工具实测成功也不升级为规则/DAG/恢复接管', async (t) => {
  const env = await makeIsolatedEnv(t);
  // Synthetic project config with a reachable stdio command so `configured`
  // can reach `validated`; the point is that MCP success still does not imply
  // rule takeover, DAG takeover or recovery.
  await writeText(env.root, '.mcp.json', `${JSON.stringify({
    mcpServers: { ano: { command: process.execPath, args: ['--version'] } },
  }, null, 2)}\n`);

  const raw = await doctorClients({
    root: env.root,
    home: env.home,
    env: env.env,
    probePaths: env.probePaths,
    adapters: adaptersFor(env),
    verify: { transport: 'stdio', command: process.execPath, inject: fakeMcpClient() },
    now: () => NOW,
  });
  const claude = raw.clients.find((client) => client.clientId === 'claude-code');
  assert.ok(claude);
  assert.equal(claude.layers.mcp.verdict, 'validated');
  assert.equal(claude.layers.tools.verdict, 'validated');
  assert.equal(claude.layers.brief.verdict, 'validated');

  const mapped = mapClientCapabilities(claude);
  assert.equal(mapped.mcp.verdict, 'validated', 'the MCP column may reflect a real measured handshake');
  assert.equal(mapped.rules.verdict, 'degraded', 'rules must not be amplified by MCP success');
  assert.equal(mapped.dag.verdict, 'degraded', 'dag must not be amplified by MCP success');
  assert.equal(mapped.recovery.verdict, 'degraded', 'recovery must not be amplified by MCP success');
  assert.equal(mapped.outputInterception.verdict, 'unavailable');
});

test('[可用路径] 通用 DAG 调度器在隔离根以 --plan dry-run 可执行且零写入', async (t) => {
  const root = await makeTemp(t, 'ano-client-takeover-scheduler-');
  await writeText(root, '.pm/tasks.json', `${JSON.stringify({
    seq: 1,
    tasks: [
      { id: 'T-PM-1', title: 'Done task', status: 'done', files: [] },
      { id: 'T-PM-3', title: 'Dispatch me', status: 'todo', milestone: 'MFIX', files: ['test/a.test.ts'] },
    ],
  }, null, 2)}\n`);
  const planPath = join(root, 'host-plan.json');
  await writeText(root, 'host-plan.json', `${JSON.stringify({
    schema_version: 1,
    milestone: 'MFIX',
    description: 'T-086 isolated scheduler plan',
    tasks: { 'T-PM-3': { depends_on: [] } },
  }, null, 2)}\n`);

  const before = await pmSnapshot(root);
  const planned = spawnSync(process.execPath, [ORCHESTRATION_CLI_PATH, '--plan', planPath], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(planned.status, 0, planned.stderr);
  const output = JSON.parse(planned.stdout) as { mode: string; actions: Array<{ task_id: string; kind: string }> };
  assert.equal(output.mode, 'dry-run');
  const action = output.actions.find((candidate) => candidate.task_id === 'T-PM-3');
  assert.ok(action, `expected a scheduling action for T-PM-3 in ${planned.stdout}`);
  assert.equal(action.kind, 'dispatch');

  assert.equal(existsSync(join(root, '.pm', 'orchestration-state.json')), false, 'dry-run must not create runtime state');
  assert.equal(await pmSnapshot(root), before, 'dry-run must not modify the PM source');
});

test('[可用路径] M10 接管状态机在隔离根可达：六阶段到 enforced 且策略文件落盘', async (t) => {
  const root = await makeTemp(t, 'ano-client-takeover-m10-');
  await pmFixture(root);
  await writeText(root, 'AGENTS.md', AGENTS_ORIGINAL);

  const authorization = createAuthorization({
    root: resolveRoot(root),
    projectId: 'client-takeover-fixture',
    projectKey: 'client-takeover-key',
    scope: ['tasks', 'memory', 'acceptance', 'dag'],
    grantedBy: 'Harness Operator',
    role: 'owner',
    statement: 'I explicitly authorize ANO takeover of this isolated fixture project.',
    grantedAt: NOW,
  });
  saveAuthorization(resolveRoot(root), authorization);
  assert.equal(loadPolicy(root), null, 'grant alone must not flip policy');

  const result = await runTakeover(root, {
    confirm: true,
    authorizationId: authorization.authorizationId,
    now: NOW,
    hostCapability: 'degraded',
  });
  assert.equal(result.active, true);
  assert.equal(result.state, 'enforced');
  assert.equal(result.phase, 'active');
  assert.equal(result.aborted, false);

  assert.equal(existsSync(join(root, '.ano', 'takeover', 'policy.json')), true, 'M10 policy file must exist');
  const policy = loadPolicy(root);
  assert.equal(policy?.state, 'enforced');
  assert.equal(policy?.hostCapability, 'degraded');
  const status = takeoverStatus(root);
  assert.equal(status.state, 'enforced');
  assert.equal(status.hostCapability, 'degraded');
  assert.ok(TAKEOVER_HOST_CAPABILITY_REASONS.length >= 3);
  assert.equal(readFileSync(join(root, 'AGENTS.md'), 'utf8').includes(MANAGED_INSTRUCTIONS_BEGIN), true);

  // 真实仓库不得被合成根实验触碰。
  assert.equal(existsSync(join(REPO_ROOT, '.ano', 'takeover')), false);
  assert.equal(resolveRoot(REPO_ROOT) !== resolveRoot(root), true);
});

test('[恢复] M10 备份/回滚与客户端配置恢复分别标注；restoreClientConfig dry-run 可达且零写', async (t) => {
  const env = await makeIsolatedEnv(t);
  const report = await clientTakeoverCapabilities({
    root: env.root,
    home: env.home,
    env: env.env,
    probePaths: env.probePaths,
    adapters: adaptersFor(env),
    now: () => NOW,
  });
  for (const client of report.clients) {
    const details = client.recovery.details as Record<string, unknown>;
    assert.ok('takeoverRecovery' in details, `${client.clientId} labels the M10 path`);
    assert.ok('clientConfigRestore' in details, `${client.clientId} labels the client-config path`);
    assert.equal(details['requiresAuthorization'], true);
    assert.equal(details['confirm'], true);
  }

  const target: ClientConfigTarget = {
    clientId: 'claude-code',
    scope: 'project',
    path: join(env.root, '.mcp.json'),
    format: 'json',
    serverPath: ['mcpServers'],
    serverName: 'ano',
    allowedRoot: env.root,
  };
  const backupDir = join(env.root, '.ano', 'clients', 'backups', 'claude-code');
  const before = existsSync(backupDir);
  const restored = restoreClientConfig(target, { root: env.root, mode: 'dry-run' });
  assert.equal(restored.mode, 'dry-run');
  assert.equal(existsSync(backupDir), before, 'dry-run restore must not create backups');
  assert.equal(existsSync(join(env.root, '.mcp.json')), false, 'dry-run restore must not write the target');
});

test('[无宿主能力] 显式常量 / 文档交叉引用 HOST_AUTO_INTERCEPTION=false；harness≠自动拦截', async (t) => {
  assert.equal(HOST_AUTO_INTERCEPTION_AVAILABLE, false);
  assert.equal(HOST_AUTO_APPROVAL_AVAILABLE, false);
  assert.equal(HOST_AUTO_SESSION_DAEMON_AVAILABLE, false);

  const investigation = readFileSync(HOST_INVESTIGATION_DOC, 'utf8');
  assert.match(investigation, /未发现/u);
  assert.match(investigation, /输出拦截/u);
  assert.match(investigation, /hooks/u);
  assert.match(investigation, /批准/u);

  const bridge = readFileSync(PM_BRIDGE_PATH, 'utf8');
  assert.match(bridge, /spawn\(/);
  assert.match(bridge, /pm-mcp|PM_MCP_ENTRY/u);

  const doc = readFileSync(CLIENT_ORCHESTRATION_DOC, 'utf8');
  assert.match(doc, /不声称/u);
  assert.match(doc, /自动.*拦截/u);
  assert.match(doc, /HOST_AUTO_INTERCEPTION/u);
  assert.match(doc, /degraded/u);

  const env = await makeIsolatedEnv(t);
  const report = await clientTakeoverCapabilities({
    root: env.root,
    home: env.home,
    env: env.env,
    probePaths: env.probePaths,
    adapters: adaptersFor(env),
    now: () => NOW,
  });
  const serialized = JSON.stringify(report);
  for (const pattern of FORBIDDEN_HOST_CLAIMS) {
    assert.equal(pattern.test(serialized), false, `capability report must not claim host automation: ${pattern}`);
  }
  for (const client of report.clients) {
    assert.equal(client.outputInterception.verdict, 'unavailable');
    assert.equal(client.hostCapability, 'degraded');
  }
});

test('[L4 UI / L5 跨项目] 证据分层明示：UI 与跨项目在本 harness 中未现场验证', () => {
  const doc = readFileSync(CLIENT_ORCHESTRATION_DOC, 'utf8');
  assert.match(doc, /\| UI \|/u);
  assert.match(doc, /\| 跨项目 \|/u);
  assert.match(doc, /未现场验证/u);
  assert.match(doc, /host-capability-investigation\.md/u);

  const verifiedLayers = EVIDENCE_LAYERS.filter((layer) => layer.verified).map((layer) => layer.layer);
  const unverifiedLayers = EVIDENCE_LAYERS.filter((layer) => !layer.verified).map((layer) => layer.layer);
  assert.equal(verifiedLayers.length, 3);
  assert.deepEqual(unverifiedLayers, ['UI', '跨项目']);
});

// ---------------------------------------------------------------------------
// T-098 / CX-08：统一能力计划与批量授权接入
// ---------------------------------------------------------------------------

test('[T-098] 统一能力计划：21 工具逐个输出可执行计划；无 MCP 接口跳过；dsh canonical 命中', async (t) => {
  const env = await makeIsolatedEnv(t);
  const assembly = registerAllClientAdapters({
    home: env.home,
    root: env.root,
    env: env.env,
    probePaths: env.probePaths,
    now: () => NOW,
  });
  assert.equal('deepseek-harness' in assembly, true, 'the assembly registers the canonical id');
  assert.equal('dsh' in assembly, false, 'dsh is an alias, never an assembly key');
  const report = await clientAccessPlans({
    root: env.root,
    home: env.home,
    env: env.env,
    probePaths: env.probePaths,
    adapters: assembly,
    now: () => NOW,
  });

  assert.equal(report.schema, CLIENT_ACCESS_PLAN_SCHEMA);
  assert.equal(report.clients.length, CLIENT_IDS.length);
  assert.deepEqual(report.clients.map((client) => client.clientId), [...CLIENT_IDS]);

  const specified = report.clients.filter((client) => !['opencode', 'pi', 'zcode'].includes(client.clientId));
  assert.equal(specified.length, 21, 'the 21 ADR-008 tools each need a plan');

  for (const plan of report.clients) {
    assert.ok((CLIENT_ACCESS_ROUTES as readonly string[]).includes(plan.route), `${plan.clientId} route`);
    assert.ok(plan.actions.length > 0, `${plan.clientId} must carry executable actions`);
    assert.ok(plan.limitations.length > 0, `${plan.clientId} must carry limitations`);
    const details = plan.details as Record<string, unknown>;
    assert.notEqual(details['rulesVerdict'], 'validated', `${plan.clientId} rules must not be amplified`);
    assert.notEqual(details['dagVerdict'], 'validated', `${plan.clientId} dag must not be amplified`);
    assert.notEqual(details['recoveryVerdict'], 'validated', `${plan.clientId} recovery must not be amplified`);

    if (plan.route === 'mcp') {
      assert.ok(plan.target !== null, `${plan.clientId} mcp route needs a target`);
      assert.ok(plan.backup !== null, `${plan.clientId} mcp route needs a backup plan`);
      assert.equal(plan.needsAuthorization, true);
      assert.equal(plan.confirm, true);
      assert.equal(plan.target.allowedRoot, plan.target.scope === 'user' ? env.home : env.root);
    } else {
      assert.equal(plan.target, null, `${plan.clientId} non-mcp route must not generate a config target`);
      assert.equal(plan.backup, null);
      assert.ok(plan.reason !== null && plan.reason.length > 0, `${plan.clientId} must explain the non-mcp route`);
    }
  }

  // 无 MCP 接口不生成无效配置。
  for (const id of ['replit-agent', 'tabnine', 'jetbrains-ai', 'codegeex', 'pi', 'zcode'] as const) {
    const plan = report.clients.find((client) => client.clientId === id);
    assert.ok(plan);
    assert.equal(plan.route, 'skip', `${id} must skip`);
    assert.equal(plan.target, null);
  }
  const openclaw = report.clients.find((client) => client.clientId === 'openclaw');
  assert.ok(openclaw);
  assert.equal(openclaw.route, 'explicit-workflow');
  assert.equal(openclaw.target, null);

  // dsh 是 deepseek-harness 的别名，计划只出现 canonical id。
  const dshPlan = report.clients.find((client) => client.clientId === 'deepseek-harness');
  assert.ok(dshPlan);
  assert.equal(dshPlan.alias, 'dsh');
  assert.equal(dshPlan.route, 'explicit-workflow');
  assert.equal(report.clients.some((client) => client.clientId === 'dsh'), false, 'dsh must never appear as a canonical id');

  // 旧客户端兼容：opencode 走 MCP 批量安装路径，pi/zcode 明确跳过。
  const opencode = report.clients.find((client) => client.clientId === 'opencode');
  assert.ok(opencode);
  assert.equal(opencode.route, 'mcp');
  assert.equal(opencode.target?.path, join(env.root, 'opencode.json'));
});

test('[T-098] 批量能力计划在 MCP 七工具 validated 时仍不放大规则/DAG/恢复', async (t) => {
  const env = await makeIsolatedEnv(t);
  await writeText(env.root, '.mcp.json', `${JSON.stringify({
    mcpServers: { ano: { command: process.execPath, args: ['--version'] } },
  }, null, 2)}\n`);

  const report = await clientAccessPlans({
    root: env.root,
    home: env.home,
    env: env.env,
    probePaths: env.probePaths,
    adapters: registerAllClientAdapters({
      home: env.home,
      root: env.root,
      env: env.env,
      probePaths: env.probePaths,
      now: () => NOW,
    }),
    verify: { transport: 'stdio', command: process.execPath, inject: fakeMcpClient() },
    now: () => NOW,
  });

  const claude = report.clients.find((client) => client.clientId === 'claude-code');
  assert.ok(claude);
  assert.equal(claude.route, 'mcp');
  const details = claude.details as Record<string, unknown>;
  assert.equal(details['mcpVerdict'], 'validated', 'a real handshake may validate the MCP column');
  assert.equal(details['rulesVerdict'], 'degraded', 'rules must not be amplified by MCP success');
  assert.equal(details['dagVerdict'], 'degraded', 'dag must not be amplified by MCP success');
  assert.equal(details['recoveryVerdict'], 'degraded', 'recovery must not be amplified by MCP success');
});
