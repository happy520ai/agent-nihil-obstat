import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CONNECT_HOST_DEGRADATION_REASONS, roleMatrixForState } from '../../src/connect/capabilities.ts';
import {
  MANAGED_INSTRUCTIONS_BEGIN,
  MANAGED_INSTRUCTIONS_END,
  managedStateDeclaration,
  renderDefaultManagedInstructions,
} from '../../src/connect/managed-instructions.ts';
import { resolveRoot } from '../../src/connect/paths.ts';
import { createAuthorization, type TakeoverAuthorization } from '../../src/connect/takeover-policy.ts';
import { loadPolicy, saveAuthorization } from '../../src/connect/takeover-store.ts';
import {
  runTakeover,
  takeoverStatus,
  TAKEOVER_HOST_CAPABILITY_REASONS,
  type TakeoverRunResult,
} from '../../src/connect/takeover.ts';
import {
  brief,
  migrateApplySurface,
  note,
  rebuildGraph,
  trackTask,
  trackTaskUpdate,
  verifySurface,
} from '../../src/surface/service.ts';
import { replayLedger } from '../../src/ledger/replay.ts';

// ============================================================================
// T-073 / TO-09：宿主默认启动、任务派发与能力降级。
//
// 证据分层（ADR-006 §8；与 docs/evidence/host-capability-investigation.md 同口径）：
//   L1 库/隔离项目：本文件全部用例，真实 tmpdir 合成根 + T-067 六阶段编排到 active。
//   L2 stdio：真实 spawn `src/surface/mcp.ts`（ANO_ROOT=合成根）与真实 spawn CLI。
//   L3 会话/主控适配：宿主无公开「自动创建会话/输出拦截/自动批准」接口（T-055），
//      因此会话启动由本 harness 显式调用 brief 模拟；主控侧先例是 scripts/orchestration/pm-bridge.mjs。
//   L4 UI / L5 跨项目：本 harness 不现场验证，测试名与断言显式标注未验证。
//
// 禁止虚报：不得宣称宿主自动调用 verify、不得宣称无人值守 daemon、不得把 harness
// 证据当作宿主证据。权限批准仍由宿主/具名人工处理。
// ============================================================================

const NOW = '2026-11-22T00:00:00.000Z';
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CLI_PATH = fileURLToPath(new URL('../../src/surface/cli.ts', import.meta.url));
const MCP_SERVER_PATH = fileURLToPath(new URL('../../src/surface/mcp.ts', import.meta.url));
const ORCHESTRATION_CLI_PATH = fileURLToPath(new URL('../../scripts/orchestration/cli.ts', import.meta.url));
const PM_BRIDGE_PATH = fileURLToPath(new URL('../../scripts/orchestration/pm-bridge.mjs', import.meta.url));
const HOST_INVESTIGATION_DOC = fileURLToPath(new URL('../../docs/evidence/host-capability-investigation.md', import.meta.url));
const HOST_EVIDENCE_DOC = fileURLToPath(new URL('../../docs/evidence/takeover-host.md', import.meta.url));

// T-055 的结论被编码为 harness 常量：宿主没有这些能力，测试只能显式声明缺失。
const HOST_AUTO_INTERCEPTION_AVAILABLE = false;
const HOST_AUTO_APPROVAL_AVAILABLE = false;
const HOST_AUTO_SESSION_DAEMON_AVAILABLE = false;

const FORBIDDEN_HOST_CLAIMS = [/自动拦截/u, /自动批准/u, /auto.?intercept/iu, /auto.?approve/iu] as const;

const EVIDENCE_LAYERS = [
  { layer: '库（本测试，隔离 tmpdir 项目根）', verified: true },
  { layer: 'stdio（本测试真实 MCP/CLI spawn + mcp.test 引用）', verified: true },
  { layer: '会话/主控适配（显式调用，非宿主自动）', verified: true },
  { layer: 'UI', verified: false },
  { layer: '跨项目', verified: false },
] as const;

const AGENTS_ORIGINAL = '<!-- pm-mcp:agents-md:v1:begin -->\npm rules\n<!-- pm-mcp:agents-md:v1:end -->\n\n# User notes\n\nkeep this 字节\n';
const PASSING_TEST = "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('a', () => assert.equal(1, 1));\n";

interface TakeoverField {
  readonly state: string;
  readonly primaryWriter: string;
  readonly legacyRole: string;
  readonly hostCapability: string | null;
  readonly permissions: Record<string, string>;
  readonly workflow: string[];
  readonly nextStep: string;
}

function takeoverFieldOf(result: Record<string, unknown>): TakeoverField {
  return result.takeover as TakeoverField;
}

async function makeRoot(t: TestContext, prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function writeText(root: string, relative: string, content: string): Promise<void> {
  const target = join(root, ...relative.split('/'));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function git(root: string, args: string[]): void {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
}

async function initGit(root: string): Promise<void> {
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'ano@localhost'], ['config', 'user.name', 'ano'], ['add', '.'], ['commit', '-qm', 'base']]) {
    git(root, args);
  }
}

/** 合成项目根：package.json + Git work tree + .pm 来源 + 一个可通过 Gate 的测试文件。 */
async function makeHostProject(t: TestContext): Promise<string> {
  const root = await makeRoot(t, 'ano-takeover-host-');
  await writeText(root, '.gitignore', '.ano/\n');
  await writeText(root, 'package.json', `${JSON.stringify({ private: true, type: 'module' }, null, 2)}\n`);
  await writeText(root, 'src/alpha.ts', 'export const alpha = 1;\nexport function beta() { return alpha; }\n');
  await writeText(root, 'test/a.test.ts', PASSING_TEST);
  await mkdir(join(root, '.pm'), { recursive: true });
  await writeText(root, '.pm/project.json', `${JSON.stringify({ name: 'Host Harness Fixture' }, null, 2)}\n`);
  await writeText(root, '.pm/tasks.json', `${JSON.stringify({
    seq: 1,
    tasks: [
      { id: 'T-PM-1', title: 'Migrate me', status: 'done', files: ['test/a.test.ts'] },
      { id: 'T-PM-2', title: 'Keep going', status: 'in_progress' },
      // 供 T-069 泛化调度器 dry-run 使用；milestone 与 host-plan.json 对齐。
      { id: 'T-PM-3', title: 'Dispatch me', status: 'todo', milestone: 'MFIX' },
    ],
  }, null, 2)}\n`);
  await writeText(root, '.pm/roadmap.json', `${JSON.stringify({ seq: 1, milestones: [{ id: 'M1', title: 'One', status: 'active' }] }, null, 2)}\n`);
  await writeText(root, '.pm/features.json', `${JSON.stringify({ seq: 1, features: [{ id: 'F-1', name: 'Feature' }] }, null, 2)}\n`);
  await writeText(root, '.pm/sessions.json', `${JSON.stringify({ seq: 1, sessions: [{ id: 'S-1', summary: 'seed' }] }, null, 2)}\n`);
  await writeFile(join(root, 'AGENTS.md'), AGENTS_ORIGINAL);
  await initGit(root);
  return root;
}

async function grant(root: string): Promise<TakeoverAuthorization> {
  const authorization = createAuthorization({
    root: resolveRoot(root),
    projectId: 'host-harness-project',
    projectKey: 'host-harness-key',
    scope: ['tasks', 'memory', 'acceptance', 'dag'],
    grantedBy: 'Harness Operator',
    role: 'owner',
    statement: 'I explicitly authorize ANO takeover of this isolated fixture project.',
    grantedAt: NOW,
  });
  saveAuthorization(resolveRoot(root), authorization);
  return authorization;
}

function activate(root: string, authorizationId: string): Promise<TakeoverRunResult> {
  // hostCapability 固定 degraded：宿主无输出拦截/自动批准能力（ADR-006 §8）。
  return runTakeover(root, { confirm: true, authorizationId, now: NOW, hostCapability: 'degraded' });
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
        entries.push({ path: rel, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
      }
    }
  };
  await walk(join(root, '.pm'), '');
  return JSON.stringify(entries);
}

interface SpawnOutcome {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runProcess(args: readonly string[], options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv } = {}): SpawnOutcome {
  const result = spawnSync(process.execPath, [...args], {
    encoding: 'utf8',
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

async function connectStdio(root: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_SERVER_PATH],
    env: { ...process.env, ANO_ROOT: root },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'ano-host-harness', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

function parseToolText(result: unknown): Record<string, unknown> {
  const text = (result as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? '';
  return JSON.parse(text) as Record<string, unknown>;
}

// ============================================================================
// L1 库层：隔离 tmpdir 项目根上的接管、启动读取策略、任务领取与验收回写。
// ============================================================================

test('[L1 库] 接管 active 后会话启动读取到 enforced 策略与默认 ANO 工作流提示', async (t) => {
  const root = await makeHostProject(t);
  await rebuildGraph(root);

  // 接管前：普通项目保持兼容形态（无 takeover 块、无受管段）。
  const before = await brief(root);
  assert.equal('takeover' in before, false, 'ordinary project brief must keep the legacy shape');
  assert.equal(readFileSync(join(root, 'AGENTS.md'), 'utf8').includes(MANAGED_INSTRUCTIONS_BEGIN), false);

  const auth = await grant(root);
  const result = await activate(root, auth.authorizationId);
  assert.equal(result.active, true);
  assert.equal(result.aborted, false);
  assert.equal(result.state, 'enforced');
  assert.equal(result.phase, 'active');
  assert.equal(result.root, resolveRoot(root));
  assert.ok(resolveRoot(root).toLowerCase().startsWith(tmpdir().toLowerCase()), 'the fixture root must be an isolated tmpdir');

  // 宿主会话启动时读取的受管 AGENTS.md 段：默认 ANO 工作流 + 旧源只读声明。
  const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  assert.equal(agents.startsWith(AGENTS_ORIGINAL), true, 'user AGENTS.md bytes must be preserved');
  assert.equal(agents.includes(MANAGED_INSTRUCTIONS_BEGIN), true);
  assert.equal(agents.includes(MANAGED_INSTRUCTIONS_END), true);
  assert.equal(agents.includes(renderDefaultManagedInstructions('enforced')), true, 'default managed workflow prompt must be installed verbatim');
  assert.equal(agents.includes(managedStateDeclaration('enforced')), true);
  assert.match(agents, /旧 PM（PM-mcp 与 \.pm\/）在接管生效期间为只读来源/);

  // brief 的 takeover 投影：ano-primary / 旧源只读 / 降级宿主能力。
  const summary = await brief(root);
  const takeover = takeoverFieldOf(summary);
  assert.equal(takeover.state, 'enforced');
  assert.equal(takeover.primaryWriter, 'ano');
  assert.equal(takeover.legacyRole, 'read-only');
  assert.equal(takeover.hostCapability, 'degraded');
  assert.deepEqual(takeover.permissions, { tasks: 'ano', memory: 'ano', acceptance: 'ano', dag: 'ano' });
  assert.ok(takeover.workflow.includes('brief'));
  assert.ok(takeover.workflow.includes('track'));
  assert.ok(takeover.workflow.includes('note'));
  assert.ok(takeover.workflow.includes('verify'));
  assert.match(takeover.nextStep, /ANO/);
  assert.match(takeover.nextStep, /只读/);
  assert.equal(summary.phase, 'P7', 'legacy brief fields stay compatible');

  // 明示：不得宣称宿主自动拦截或自动批准。
  const serializedBrief = JSON.stringify(summary);
  for (const pattern of FORBIDDEN_HOST_CLAIMS) {
    assert.equal(pattern.test(serializedBrief), false, `brief must not claim host automation: ${pattern}`);
    assert.equal(pattern.test(agents), false, `managed instructions must not claim host automation: ${pattern}`);
  }

  // 持久化状态、事务证据与角色矩阵都携带 degraded 声明。
  const status = takeoverStatus(root);
  assert.equal(status.state, 'enforced');
  assert.equal(status.hostCapability, 'degraded');
  assert.equal(status.enforcedAt, NOW);
  assert.equal(status.transaction?.phase, 'active');
  const policy = loadPolicy(root);
  assert.equal(policy?.state, 'enforced');
  assert.equal(policy?.hostCapability, 'degraded');
  assert.equal(policy?.baselineDigest, result.sourceDigest);

  const verification = readJson(join(root, '.ano', 'takeover', 'verification.json')) as {
    hostCapability: string;
    hostCapabilityReasons: string[];
    evidence: Array<{ kind: string; detail: Record<string, unknown> }>;
  };
  assert.equal(verification.hostCapability, 'degraded');
  assert.deepEqual(verification.hostCapabilityReasons, [...TAKEOVER_HOST_CAPABILITY_REASONS]);
  const hostEvidence = verification.evidence.find((entry) => entry.kind === 'hostCapability');
  assert.equal(hostEvidence?.detail.capability, 'degraded');

  const matrix = roleMatrixForState('enforced', 'degraded');
  assert.equal(matrix.degraded, true);
  assert.deepEqual(matrix.degradationReasons, [...CONNECT_HOST_DEGRADATION_REASONS]);

  // 真实工作区不得被合成根实验触碰。
  assert.equal(existsSync(join(REPO_ROOT, '.ano', 'takeover')), false);
});

test('[L1 库] enforced 下任务领取与验收回写走 ANO，旧源只读且不被双写', async (t) => {
  const root = await makeHostProject(t);
  const auth = await grant(root);
  const result = await activate(root, auth.authorizationId);
  assert.equal(result.state, 'enforced');
  const pmBefore = await pmSnapshot(root);

  // 受管段安装后，宿主侧人工接受该改动（提交），使工作树干净；否则 git status
  // 会把 AGENTS.md 计入 touched 集合并阻断 T1 覆盖判定。.pm 仍不变。
  git(root, ['add', 'AGENTS.md']);
  git(root, ['commit', '-qm', 'accept ANO managed section']);

  // 领取任务：track 走 ANO ledger，响应携带接管投影。
  const tracked = await trackTask(root, { id: 'T-HOST-1', files: ['test/a.test.ts'], status: 'in_progress' }, 'host:claim:1');
  assert.equal((tracked.task as { id: string }).id, 'T-HOST-1');
  assert.equal((tracked.task as { status: string }).status, 'in_progress');
  assert.equal(takeoverFieldOf(tracked).state, 'enforced');

  // 记忆写入同样走 ANO。
  const noted = await note(root, { idem_key: 'host:note:1', kind: 'memory', text: 'host harness note', anchor: { file: 'test/a.test.ts' } });
  assert.equal(noted.status, 'recorded');
  assert.equal(takeoverFieldOf(noted).state, 'enforced');

  // 验收回写：verify 在 enforced 下写 ANO acceptance evidence。
  const verified = await verifySurface(root, {
    task_id: 'T-HOST-1',
    argv: [process.execPath, '--test', 'test/a.test.ts'],
    test_files: ['test/a.test.ts'],
    idem_key: 'host:verify:1',
  });
  const verdict = verified.verdict as { status: string; evidenceId: string };
  assert.equal(verdict.status, 'done', JSON.stringify(verdict));
  assert.ok(verdict.evidenceId, 'acceptance evidence id must be recorded by ANO');

  // 旧源迁移写入路径在 enforced 下被拒（门禁），ANO 原生写入不受影响。
  await assert.rejects(
    migrateApplySurface(root, { expected_source_digest: result.sourceDigest }, 'host:migrate:refused'),
    /legacy PM-mcp write refused|CONNECT_LEGACY_WRITE_BLOCKED/iu,
  );

  // 完成回写绑定 Gate evidence，走 ANO complete 路径。
  const completed = await trackTaskUpdate(root, { operation: 'complete', id: 'T-HOST-1', evidence_id: verdict.evidenceId }, 'host:complete:1');
  assert.equal((completed.task as { status: string }).status, 'done');
  assert.equal(takeoverFieldOf(completed).state, 'enforced');

  const entries = replayLedger(join(root, '.ano', 'ledger')).entries;
  assert.ok(entries.some((entry) => entry.event.kind === 'evidence.recorded'), 'acceptance evidence must land in the ANO ledger');
  assert.ok(
    entries.some((entry) => entry.event.kind === 'task.updated'
      && (entry.event.payload as Record<string, unknown>).status === 'done'),
    'completion transition must land in the ANO ledger',
  );

  // 旧源字节不变，且新任务只存在于 ANO（不双写）。
  assert.equal(await pmSnapshot(root), pmBefore, '.pm must stay byte-identical under enforced writes');
  const pmTasks = readJson(join(root, '.pm', 'tasks.json')) as { tasks: Array<{ id: string }> };
  assert.equal(pmTasks.tasks.some((task) => task.id === 'T-HOST-1'), false, 'the new task must not be written back to .pm');
});

// ============================================================================
// L2 stdio 层：真实 MCP stdio 进程与真实 CLI 进程对已接管根的行为。
// ============================================================================

test('[L2 stdio] 真实 MCP stdio 会话对已接管根列出七工具并返回 takeover 投影', async (t) => {
  const root = await makeHostProject(t);
  const auth = await grant(root);
  await activate(root, auth.authorizationId);

  const client = await connectStdio(root);
  try {
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name),
      ['brief', 'explore', 'recall', 'track', 'note', 'verify', 'audit'],
      'the taken-over project is still served by the seven-tool MCP surface',
    );
    const payload = parseToolText(await client.callTool({ name: 'brief', arguments: { root } }));
    const takeover = takeoverFieldOf(payload);
    assert.equal(takeover.state, 'enforced');
    assert.equal(takeover.primaryWriter, 'ano');
    assert.equal(takeover.legacyRole, 'read-only');
    assert.equal(takeover.hostCapability, 'degraded');
  } finally {
    await client.close();
  }
});

test('[L2 stdio/CLI] 真实 CLI 进程 takeover status 从 active 项目报告 degraded 宿主能力', async (t) => {
  const root = await makeHostProject(t);
  const auth = await grant(root);
  await activate(root, auth.authorizationId);

  const status = runProcess([CLI_PATH, 'takeover', 'status', '--root', root]);
  assert.equal(status.status, 0, status.stderr);
  const payload = JSON.parse(status.stdout) as Record<string, unknown>;
  assert.equal(payload.state, 'enforced');
  assert.equal(payload.hostCapability, 'degraded');
  assert.equal(payload.schema, 'ano.takeover-status/1');
});

// ============================================================================
// L3 会话/主控适配层：宿主无自动建会话/拦截/批准；调度器泛化真实可用。
// ============================================================================

test('[L3 主控适配] 泛化 DAG 调度器从接管根以 --plan dry-run 可用（真实 spawn cli.ts）', async (t) => {
  const root = await makeHostProject(t);
  const auth = await grant(root);
  await activate(root, auth.authorizationId);

  const planPath = join(root, 'host-plan.json');
  await writeText(root, 'host-plan.json', `${JSON.stringify({
    schema_version: 1,
    milestone: 'MFIX',
    description: 'T-073 host harness scheduler plan',
    tasks: { 'T-PM-3': { depends_on: [] } },
  }, null, 2)}\n`);

  const pmBefore = await pmSnapshot(root);
  const planned = runProcess([ORCHESTRATION_CLI_PATH, '--plan', planPath], { cwd: root });
  assert.equal(planned.status, 0, planned.stderr);
  const output = JSON.parse(planned.stdout) as { mode: string; actions: Array<Record<string, unknown>> };
  assert.equal(output.mode, 'dry-run');
  const action = output.actions.find((candidate) => candidate.task_id === 'T-PM-3');
  assert.ok(action, `expected a scheduling action for T-PM-3 in ${planned.stdout}`);
  assert.equal(action.kind, 'dispatch');
  assert.equal(typeof action.prompt, 'string');

  // dry-run 只读：不写运行时状态，也不改 .pm。
  assert.equal(existsSync(join(root, '.pm', 'orchestration-state.json')), false, 'dry-run must not create runtime state');
  assert.equal(await pmSnapshot(root), pmBefore, 'dry-run must not modify the PM source');
});

test('[L3 会话层] 无宿主自动建会话/输出拦截/自动批准能力；主控适配是显式 stdio 桥（T-055）', async (t) => {
  assert.equal(HOST_AUTO_INTERCEPTION_AVAILABLE, false);
  assert.equal(HOST_AUTO_APPROVAL_AVAILABLE, false);
  assert.equal(HOST_AUTO_SESSION_DAEMON_AVAILABLE, false);

  // 交叉引用 T-055 调查结论：未发现公开拦截接口、hooks 未用于 ANO、权限不能代批。
  const investigation = readFileSync(HOST_INVESTIGATION_DOC, 'utf8');
  assert.match(investigation, /未发现/);
  assert.match(investigation, /输出拦截/);
  assert.match(investigation, /hooks/);
  assert.match(investigation, /批准/);

  // 主控适配先例：pm-bridge.mjs 显式 spawn pm-mcp stdio，不是宿主 daemon。
  const bridge = readFileSync(PM_BRIDGE_PATH, 'utf8');
  assert.match(bridge, /spawn\(/);
  assert.match(bridge, /pm-mcp|PM_MCP_ENTRY/u);

  // ADR-006 §8 的降级原因与 T-055 三层缺失一致。
  assert.deepEqual([...CONNECT_HOST_DEGRADATION_REASONS], [...TAKEOVER_HOST_CAPABILITY_REASONS]);
  assert.ok(TAKEOVER_HOST_CAPABILITY_REASONS.length >= 3);

  // 在一个 active 合成根上再次确认：受管段与 brief 都不宣称宿主自动能力。
  const root = await makeHostProject(t);
  const auth = await grant(root);
  await activate(root, auth.authorizationId);
  const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  const summary = await brief(root);
  for (const pattern of FORBIDDEN_HOST_CLAIMS) {
    assert.equal(pattern.test(agents), false, `managed instructions must not claim: ${pattern}`);
    assert.equal(pattern.test(JSON.stringify(summary)), false, `brief must not claim: ${pattern}`);
  }
});

// ============================================================================
// L4 UI / L5 跨项目：本 harness 不现场验证；分层状态必须显式可查。
// ============================================================================

test('[L4 UI / L5 跨项目] 证据分层明示：UI 与跨项目在本 harness 中未现场验证', () => {
  const doc = readFileSync(HOST_EVIDENCE_DOC, 'utf8');
  assert.match(doc, /\| UI \|/u);
  assert.match(doc, /\| 跨项目 \|/u);
  assert.match(doc, /未现场验证/u);
  assert.match(doc, /host-capability-investigation\.md/u);

  const verifiedLayers = EVIDENCE_LAYERS.filter((layer) => layer.verified).map((layer) => layer.layer);
  const unverifiedLayers = EVIDENCE_LAYERS.filter((layer) => !layer.verified).map((layer) => layer.layer);
  assert.equal(verifiedLayers.length, 3);
  assert.deepEqual(unverifiedLayers, ['UI', '跨项目']);
});
