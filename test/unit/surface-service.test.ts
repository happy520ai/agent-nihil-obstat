import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { replayLedger } from '../../src/ledger/replay.ts';
import { createAuthorization, createPolicy } from '../../src/connect/takeover-policy.ts';
import { savePolicy } from '../../src/connect/takeover-store.ts';
import { runCli } from '../../src/surface/cli.ts';
import { createMcpServer } from '../../src/surface/mcp.ts';
import {
  auditSurface,
  brief,
  defaultRoot,
  displayPath,
  explore,
  note,
  rebuildGraph,
  recall,
  trackTask,
  trackTaskUpdate,
  verifySurface,
} from '../../src/surface/service.ts';
import { exportProject } from '../../src/surface/export.ts';

async function temp(prefix: string): Promise<string> { return mkdtemp(join(tmpdir(), prefix)); }

async function write(root: string, path: string, source: string): Promise<void> {
  const target = join(root, ...path.split('/'));
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, source);
}

function git(root: string, args: string[]): void {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
}

async function gitProject(manifest: Record<string, unknown> = { private: true, type: 'module' }): Promise<string> {
  const root = await temp('ano service ');
  await write(root, '.gitignore', '.ano/\n');
  await write(root, 'package.json', JSON.stringify(manifest));
  await write(root, 'src/alpha.ts', 'export const alpha = 1;\nexport function beta() { return alpha; }\n');
  await write(root, 'test/a.test.ts', "import test from 'node:test';import assert from 'node:assert/strict';test('a', () => assert.equal(1, 1));\n");
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'ano@localhost'], ['config', 'user.name', 'ano'], ['add', '.'], ['commit', '-qm', 'base']]) git(root, args);
  return root;
}

test('brief and explore cover empty, name-matched and qualified-name-matched queries', async () => {
  const root = await gitProject();
  try {
    await rebuildGraph(root);

    const summary = await brief(root);
    assert.equal(summary.phase, 'P7');
    assert.ok(Array.isArray(summary.tools));

    const unmatched = await explore(root, 'no-such-symbol-anywhere');
    assert.equal(unmatched.total, 0);
    assert.deepEqual(unmatched.impact, []);
    assert.equal(unmatched.truncated, false);

    const matched = await explore(root, 'alpha', 1);
    assert.equal(typeof matched.total, 'number');
    assert.ok((matched.total as number) >= 1);
    assert.equal(matched.query, 'alpha');

    const qualified = await explore(root, 'beta', 100);
    assert.ok((qualified.total as number) >= 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('trackTask generates ids, filters unusable file entries and starts in-progress tasks', async () => {
  const root = await gitProject();
  try {
    const created = await trackTask(root, { title: 'generated id', status: 'in_progress', files: ['src/alpha.ts', 7, '', null] }, 'svc:track:1');
    assert.equal(created.duplicate, false);
    const task = created.task as { id: string; declaredFiles: string[]; status: string };
    assert.match(task.id, /^T-/);
    assert.deepEqual(task.declaredFiles, ['src/alpha.ts']);
    assert.equal(task.status, 'in_progress');

    const repeated = await trackTask(root, { id: 'T-fixed', files: ['src/alpha.ts'] }, 'svc:track:2');
    assert.equal(repeated.duplicate, false);
    const duplicate = await trackTask(root, { id: 'T-fixed', files: ['src/alpha.ts'] }, 'svc:track:2');
    assert.equal(duplicate.duplicate, true);
    assert.equal((duplicate.task as { id: string }).id, 'T-fixed');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('verifySurface rejects incomplete requests before touching the ledger', async () => {
  const root = await gitProject();
  try {
    await assert.rejects(verifySurface(root, { task_id: 'T-1', argv: ['node', '--test'] }), /required/);
    await assert.rejects(verifySurface(root, { argv: ['node', '--test'], test_files: ['test/a.test.ts'] }), /required/);
    await assert.rejects(verifySurface(root, { task_id: 'T-1', test_files: ['test/a.test.ts'] }), /required/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('auditSurface rejects unknown scopes and injects ledger/graph for drift and governance', async () => {
  const root = await gitProject();
  try {
    await assert.rejects(auditSurface(root, {}), /audit requires one of/);
    await assert.rejects(auditSurface(root, { scope: 'nonsense' }), /audit requires one of/);

    await trackTask(root, { id: 'T-DRIFT', files: ['src/alpha.ts', 'src/gone.ts'] }, 'svc:drift:1');
    const drift = await auditSurface(root, { scope: 'drift' });
    assert.equal(drift.scope, 'drift');
    assert.equal(drift.counts.tasks, 1);
    assert.ok(drift.findings.some((finding) => finding.rule === 'drift/task-file-missing'));

    await write(root, '.ano/governance.json', JSON.stringify({
      schemaVersion: 1,
      modules: [{ id: 'core', roots: ['src'], allowedDependencies: ['core'] }],
      policies: { enforceDeclaredDependencies: true, failOnCycles: true },
    }));
    const governance = await auditSurface(root, { scope: 'governance' });
    assert.equal(governance.scope, 'governance');
    assert.equal(Array.isArray(governance.findings), true);
    assert.ok(governance.caveats.some((caveat) => caveat.startsWith('policy:')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('defaultRoot honours ANO_ROOT and displayPath falls back to the absolute path', () => {
  const previous = process.env.ANO_ROOT;
  try {
    delete process.env.ANO_ROOT;
    assert.equal(defaultRoot(), process.cwd());
    process.env.ANO_ROOT = '.';
    assert.equal(defaultRoot(), process.cwd());
    assert.equal(displayPath(process.cwd()), displayPath(process.cwd()));
    assert.equal(displayPath('/'), '/');
  } finally {
    if (previous === undefined) delete process.env.ANO_ROOT; else process.env.ANO_ROOT = previous;
  }
});

test('exportProject omits absent manifest name and version without failing', async () => {
  const root = await gitProject({});
  try {
    const snapshot = await exportProject(root);
    assert.equal(snapshot.schema, 'ano.export.v1');
    assert.equal(snapshot.project.name, undefined);
    assert.equal(snapshot.project.version, undefined);
    assert.equal(snapshot.project.phase, 'P7');
    assert.deepEqual(snapshot.tasks, []);

    const named = await gitProject({ name: 'named-fixture', version: '9.9.9' });
    try {
      const withName = await exportProject(named);
      assert.equal(withName.project.name, 'named-fixture');
      assert.equal(withName.project.version, '9.9.9');
    } finally { await rm(named, { recursive: true, force: true }); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

// ============================================================================
// ADR-006 / T-070: brief/track/note/recall takeover-state wiring.
// ============================================================================

type ManagedTakeoverState = 'disabled' | 'enforced' | 'recovery';

function installTakeover(root: string, state: ManagedTakeoverState): void {
  const authorization = createAuthorization({
    root,
    projectId: 'fixture-project',
    projectKey: 'fixture-key',
    scope: ['tasks', 'memory', 'acceptance', 'dag'],
    grantedBy: 'Tester',
    role: 'Owner',
    statement: 'authorize the fixture project takeover',
    grantedAt: '2026-11-22T00:00:00.000Z',
  });
  const policy = createPolicy({
    root,
    projectId: 'fixture-project',
    projectKey: 'fixture-key',
    authorization,
    state,
    enforcedAt: state === 'disabled' ? null : '2026-11-22T00:00:01.000Z',
    baselineDigest: state === 'disabled' ? null : 'a'.repeat(64),
    hostCapability: state === 'disabled' ? null : 'degraded',
  });
  savePolicy(root, policy);
}

interface TakeoverField {
  state: string;
  primaryWriter: string;
  legacyRole: string;
  hostCapability: string | null;
  enforcedAt: string | null;
  permissions: Record<string, string>;
  workflow: string[];
  nextStep: string;
}

function takeoverFieldOf(result: Record<string, unknown>): TakeoverField {
  return result.takeover as TakeoverField;
}

test('brief omits the takeover field for an ordinary project', async () => {
  const root = await gitProject();
  try {
    const summary = await brief(root);
    assert.equal('takeover' in summary, false, 'the legacy brief shape is unchanged');
    assert.equal(summary.phase, 'P7');
    assert.ok(Array.isArray(summary.tools));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('brief reports ano-primary and legacy read-only for an enforced project', async () => {
  const root = await gitProject();
  try {
    installTakeover(root, 'enforced');
    const summary = await brief(root);
    const takeover = takeoverFieldOf(summary);
    assert.equal(takeover.state, 'enforced');
    assert.equal(takeover.primaryWriter, 'ano');
    assert.equal(takeover.legacyRole, 'read-only');
    assert.equal(takeover.permissions.tasks, 'ano');
    assert.equal(takeover.permissions.memory, 'ano');
    assert.equal(takeover.permissions.acceptance, 'ano');
    assert.equal(takeover.permissions.dag, 'ano');
    assert.equal(takeover.hostCapability, 'degraded');
    assert.ok(takeover.workflow.includes('track'));
    assert.match(takeover.nextStep, /ANO/);
    assert.equal(summary.phase, 'P7', 'the legacy brief fields are unchanged');
    assert.ok(Array.isArray(summary.tools));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('brief reports the disabled and recovery role matrices', async () => {
  const root = await gitProject();
  try {
    installTakeover(root, 'disabled');
    const disabled = takeoverFieldOf(await brief(root));
    assert.equal(disabled.state, 'disabled');
    assert.equal(disabled.primaryWriter, 'legacy');
    assert.equal(disabled.legacyRole, 'write');
    assert.equal(disabled.permissions.tasks, 'legacy');

    installTakeover(root, 'recovery');
    const recovery = takeoverFieldOf(await brief(root));
    assert.equal(recovery.state, 'recovery');
    assert.equal(recovery.primaryWriter, 'legacy');
    assert.equal(recovery.legacyRole, 'recovering');
    assert.equal(recovery.permissions.tasks, 'suspended');
    assert.match(recovery.nextStep, /recover/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('enforced track and note write ANO and leave the legacy PM source untouched', async () => {
  const root = await gitProject();
  try {
    const pmProject = JSON.stringify({ id: 'fixture-project', name: 'fixture' });
    const pmTasks = JSON.stringify({ tasks: [] });
    await write(root, '.pm/project.json', pmProject);
    await write(root, '.pm/tasks.json', pmTasks);
    installTakeover(root, 'enforced');

    const tracked = await trackTask(root, { id: 'T-ENO', files: ['src/alpha.ts'], status: 'in_progress' }, 'svc:eno:track');
    assert.equal((tracked.task as { id: string }).id, 'T-ENO');
    assert.equal(takeoverFieldOf(tracked).state, 'enforced');

    const noted = await note(root, { idem_key: 'svc:eno:note', kind: 'memory', text: 'enforced note', anchor: { file: 'src/alpha.ts' } });
    assert.equal(noted.status, 'recorded');
    assert.equal(takeoverFieldOf(noted).state, 'enforced');

    assert.equal(readFileSync(join(root, '.pm/project.json'), 'utf8'), pmProject);
    assert.equal(readFileSync(join(root, '.pm/tasks.json'), 'utf8'), pmTasks, 'the legacy PM store is byte-identical');
    assert.ok(replayLedger(join(root, '.ano', 'ledger')).entries.length >= 2, 'the writes landed in the ANO ledger');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('recovery pauses ANO writes with an explicit prompt and zero mutations', async () => {
  const root = await gitProject();
  try {
    const pmTasks = JSON.stringify({ tasks: [] });
    await write(root, '.pm/tasks.json', pmTasks);
    installTakeover(root, 'recovery');

    await assert.rejects(trackTask(root, { id: 'T-REC', files: ['src/alpha.ts'] }, 'svc:rec:track'), /recovery/);
    await assert.rejects(trackTaskUpdate(root, { operation: 'update', id: 'T-REC', status: 'todo' }, 'svc:rec:update'), /recovery/);
    await assert.rejects(note(root, { idem_key: 'svc:rec:note', kind: 'memory', text: 'x', anchor: { file: 'src/alpha.ts' } }), /recovery/);
    assert.equal(readFileSync(join(root, '.pm/tasks.json'), 'utf8'), pmTasks);
    assert.equal(existsSync(join(root, '.ano', 'ledger')), false, 'no ANO ledger was created');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('disabled managed projects keep the legacy write path', async () => {
  const root = await gitProject();
  try {
    installTakeover(root, 'disabled');
    const tracked = await trackTask(root, { id: 'T-DIS', files: ['src/alpha.ts'] }, 'svc:dis:track');
    assert.equal((tracked.task as { id: string }).id, 'T-DIS');
    const takeover = takeoverFieldOf(tracked);
    assert.equal(takeover.state, 'disabled');
    assert.equal(takeover.primaryWriter, 'legacy');
    assert.equal(takeover.legacyRole, 'write');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('corrupt takeover policy degrades brief and fails closed for writes', async () => {
  const root = await gitProject();
  try {
    installTakeover(root, 'enforced');
    await write(root, '.ano/takeover/policy.json', '{ not json');
    const summary = await brief(root);
    assert.equal((summary.takeover as { state: string }).state, 'unknown');
    assert.ok((summary.limitations as string[]).some((item) => /unreadable/.test(item)));
    await assert.rejects(trackTask(root, { id: 'T-BAD', files: ['src/alpha.ts'] }, 'svc:bad:track'), /unreadable/);
    await assert.rejects(note(root, { idem_key: 'svc:bad:note', kind: 'memory', text: 'x', anchor: { file: 'src/alpha.ts' } }), /unreadable/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('enforced takeover does not grant Gate completion', async () => {
  const root = await gitProject();
  try {
    installTakeover(root, 'enforced');
    const tracked = await trackTask(root, { id: 'T-GATE', files: ['src/alpha.ts'] }, 'svc:gate:track');
    assert.equal((tracked.task as { status: string }).status, 'todo');
    const takeover = tracked.takeover as Record<string, unknown>;
    assert.equal('evidence_id' in takeover, false);
    assert.equal('verdict' in takeover, false);
    await assert.rejects(
      trackTaskUpdate(root, { operation: 'complete', id: 'T-GATE', evidence_id: '' }, 'svc:gate:complete'),
      /Gate evidence id must be non-empty/,
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('recall reports the takeover state without changing recall semantics', async () => {
  const root = await gitProject();
  try {
    installTakeover(root, 'enforced');
    const recalled = await recall(root, {});
    assert.equal(recalled.status, 'not_configured');
    assert.equal(takeoverFieldOf(recalled).state, 'enforced');
  } finally { await rm(root, { recursive: true, force: true }); }
});

// ============================================================================
// ADR-009 / T-106: brief/explore graph cache reuse, unified status, timeout.
// ============================================================================

async function nestedGitProject(): Promise<string> {
  const root = await temp('ano nested brief ');
  await write(root, '.gitignore', '.ano/\n');
  await write(root, '.pm/project.json', JSON.stringify({ name: 'nested-fixture' }));
  await write(root, 'server/package.json', JSON.stringify({ name: 'server', private: true }));
  await write(root, 'server/src/alpha.ts', 'export const alpha = 1;\n');
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'ano@localhost'], ['config', 'user.name', 'ano'], ['add', '.'], ['commit', '-qm', 'base']]) git(root, args);
  return root;
}

test('brief reuses the graph cache and reports unified status and root resolution', async () => {
  const root = await gitProject();
  try {
    const first = await brief(root);
    const firstGraph = first.graph as Record<string, unknown>;
    assert.equal(firstGraph.status, 'ok');
    assert.equal(firstGraph.cache, 'miss');
    assert.ok((firstGraph.files as number) >= 1);
    const revision = firstGraph.revision;

    const second = await brief(root);
    const secondGraph = second.graph as Record<string, unknown>;
    assert.equal(secondGraph.cache, 'hit', 'the second brief must not rebuild the tree');
    assert.equal(secondGraph.revision, revision);
    assert.equal(secondGraph.status, 'ok');
    assert.deepEqual(secondGraph.rootResolution, { inputRoot: root, gitRoot: root, pmRoot: root, sourceRoots: [root] });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('brief binds PM and graph roots to the repository root for a nested package', async () => {
  const root = await nestedGitProject();
  try {
    const summary = await brief(root);
    const graph = summary.graph as Record<string, unknown>;
    const resolution = graph.rootResolution as { pmRoot: string; gitRoot: string; sourceRoots: string[] };
    assert.equal(resolution.pmRoot, root);
    assert.equal(resolution.gitRoot, root);
    assert.ok(resolution.sourceRoots.includes(join(root, 'server')));
    assert.ok((graph.files as number) >= 1, 'the nested source file is part of the graph');
    assert.equal(graph.status, 'ok');
    assert.ok(Array.isArray(summary.tasks));

    // Calling through the nested package resolves to the same repository roots.
    const fromServer = await brief(join(root, 'server'));
    const serverGraph = fromServer.graph as Record<string, unknown>;
    const serverResolution = serverGraph.rootResolution as { pmRoot: string; gitRoot: string; sourceRoots: string[] };
    assert.equal(serverResolution.pmRoot, root);
    assert.equal(serverResolution.gitRoot, root);
    assert.ok(serverResolution.sourceRoots.includes(join(root, 'server')));
    assert.equal(serverGraph.files, graph.files);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rebuildGraph reports timeout and keeps the previous snapshot instead of files=0', async () => {
  const root = await gitProject();
  try {
    await write(root, '.pm/project.json', JSON.stringify({ name: 'fixture' }));
    const first = await rebuildGraph(root);
    assert.equal(first.status, 'ok');
    const files = first.files as number;
    assert.ok(files >= 1);
    const revision = first.revision;

    const timedOut = await rebuildGraph(root, { timeoutMs: 0 });
    assert.equal(timedOut.status, 'timeout');
    assert.equal(timedOut.partial, true);
    assert.equal(timedOut.stale, true);
    assert.equal(timedOut.files, files, 'the previous snapshot survives a timeout');
    assert.equal(timedOut.revision, revision);
    assert.ok(timedOut.completed !== undefined);
    assert.ok(timedOut.budget !== undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('brief never reports files=0 as a healthy scan', async () => {
  const root = await gitProject();
  try {
    await write(root, '.pm/project.json', JSON.stringify({ name: 'empty', scan_ignore: ['**/*'] }));
    const summary = await brief(root);
    const graph = summary.graph as Record<string, unknown>;
    assert.equal(graph.files, 0);
    assert.equal(graph.status, 'degraded');
    assert.notEqual(graph.status, 'ok');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('MCP, CLI and the shared service expose the same unified graph status', async () => {
  const root = await gitProject();
  try {
    const cliResult = await runCli(['brief', '--root', root]);
    assert.equal(cliResult.code, 0, cliResult.output);
    const cliGraph = (JSON.parse(cliResult.output) as Record<string, unknown>).graph as Record<string, unknown>;

    const serviceBrief = await brief(root);
    const serviceGraph = serviceBrief.graph as Record<string, unknown>;
    assert.equal(serviceGraph.status, cliGraph.status);
    assert.equal(serviceGraph.files, cliGraph.files);
    assert.deepEqual(serviceGraph.rootResolution, cliGraph.rootResolution);

    const server = createMcpServer(root);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'ano-surface-unit', version: '1.0.0' });
    await client.connect(clientTransport);
    try {
      const mcpResult = await client.callTool({ name: 'brief', arguments: { root } });
      assert.equal(mcpResult.isError, undefined, JSON.stringify(mcpResult));
      const mcpGraph = (JSON.parse((mcpResult.content as { text: string }[])[0]!.text) as Record<string, unknown>).graph as Record<string, unknown>;
      assert.equal(mcpGraph.status, serviceGraph.status);
      assert.equal(mcpGraph.files, serviceGraph.files);
      assert.equal(mcpGraph.cache, serviceGraph.cache);
      assert.deepEqual(mcpGraph.rootResolution, serviceGraph.rootResolution);
    } finally {
      await client.close();
      await server.close();
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
