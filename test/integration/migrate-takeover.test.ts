import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../src/surface/mcp.ts';
import { runCli } from '../../src/surface/cli.ts';
import { existingProjectRoot, migratePlanSurface, takeoverGrant } from '../../src/surface/service.ts';
import { connectProject, handoffReadiness } from '../../src/connect/index.ts';
import { backupHash, listBackups } from '../../src/connect/backup.ts';
import { runTakeover } from '../../src/connect/takeover.ts';
import { planMigration, readMigrationSummary, resolveMigrationPmRoot, resolveMigrationRoot } from '../../src/ledger/migrate.ts';
import { ProjectScanError } from '../../src/core/project-scan.ts';

const cliPath = fileURLToPath(new URL('../../src/surface/cli.ts', import.meta.url));
const PASSING = "import test from 'node:test';import assert from 'node:assert/strict';test('a', () => assert.equal(1, 1));\n";

async function gitProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ano takeover '));
  await mkdir(join(root, 'test'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await writeFile(join(root, 'test', 'a.test.ts'), PASSING);
  const { spawnSync } = await import('node:child_process');
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'ano@localhost'], ['config', 'user.name', 'ano'], ['add', '.'], ['commit', '-qm', 'base']]) {
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  return root;
}

async function pmFixture(): Promise<string> {
  const root = await gitProject();
  await mkdir(join(root, '.pm'), { recursive: true });
  await writeFile(join(root, '.pm', 'project.json'), `${JSON.stringify({ name: 'Takeover Fixture' }, null, 2)}\n`);
  await writeFile(join(root, '.pm', 'tasks.json'), `${JSON.stringify({
    seq: 1,
    tasks: [
      { id: 'T-PM-1', title: 'Migrate me', status: 'done', files: ['test/a.test.ts'] },
      { id: 'T-PM-2', title: 'Keep going', status: 'in_progress' },
    ],
  }, null, 2)}\n`);
  await writeFile(join(root, '.pm', 'roadmap.json'), `${JSON.stringify({ seq: 1, milestones: [{ id: 'M1', title: 'One', status: 'active' }] }, null, 2)}\n`);
  await writeFile(join(root, '.pm', 'features.json'), `${JSON.stringify({ seq: 1, features: [{ id: 'F-1', name: 'Feature' }] }, null, 2)}\n`);
  await writeFile(join(root, '.pm', 'sessions.json'), `${JSON.stringify({ seq: 1, sessions: [{ id: 'S-1', summary: 'seed' }] }, null, 2)}\n`);
  return root;
}

async function pmSnapshot(root: string): Promise<string> {
  const dir = join(root, '.pm');
  const names = (await readdir(dir)).sort();
  const entries: Array<Record<string, unknown>> = [];
  for (const name of names) {
    const path = join(dir, name);
    const info = await stat(path);
    if (!info.isFile()) continue;
    entries.push({ name, sha256: createHash('sha256').update(await readFile(path)).digest('hex'), bytes: info.size, mtimeMs: info.mtimeMs });
  }
  return JSON.stringify(entries);
}

/**
 * Synthetic repository matching the ADR-009 nested layout: the Git root has no
 * `package.json`, the authoritative PM data lives in the root `.pm`, and a
 * `server/` Node package carries a decoy `.pm` that must never become the
 * migration/takeover source.
 */
async function nestedRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ano nested repo '));
  await mkdir(join(root, '.git'), { recursive: true });
  await mkdir(join(root, '.pm'), { recursive: true });
  await writeFile(join(root, '.pm', 'project.json'), `${JSON.stringify({ name: 'Nested Fixture' }, null, 2)}\n`);
  await writeFile(join(root, '.pm', 'tasks.json'), `${JSON.stringify({
    seq: 1,
    tasks: [
      { id: 'T-ROOT-1', title: 'Root one', status: 'todo' },
      { id: 'T-ROOT-2', title: 'Root two', status: 'in_progress' },
      { id: 'T-ROOT-3', title: 'Root done', status: 'done' },
    ],
  }, null, 2)}\n`);
  await writeFile(join(root, '.pm', 'roadmap.json'), `${JSON.stringify({ seq: 1, milestones: [] }, null, 2)}\n`);
  await writeFile(join(root, '.pm', 'features.json'), `${JSON.stringify({ seq: 1, features: [] }, null, 2)}\n`);
  await writeFile(join(root, '.pm', 'sessions.json'), `${JSON.stringify({ seq: 1, sessions: [] }, null, 2)}\n`);
  await mkdir(join(root, 'server'), { recursive: true });
  await writeFile(join(root, 'server', 'package.json'), `${JSON.stringify({ name: 'server', private: true }, null, 2)}\n`);
  await mkdir(join(root, 'server', '.pm'), { recursive: true });
  await writeFile(join(root, 'server', '.pm', 'tasks.json'), `${JSON.stringify({
    seq: 1,
    tasks: [{ id: 'T-DECOY', title: 'Decoy must never migrate', status: 'todo' }],
  }, null, 2)}\n`);
  return root;
}

function expectScanError(promise: Promise<unknown>, code: string): Promise<void> {
  return assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ProjectScanError, `expected ProjectScanError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

function payload(result: unknown): Record<string, unknown> {
  const text = (result as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? '';
  try { return JSON.parse(text) as Record<string, unknown>; } catch { return {}; }
}

async function mcp(root: string): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createMcpServer(root);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'ano-takeover-test', version: '1.0.0' });
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

test('migrate plan is zero-write and apply is idempotent without touching .pm', async () => {
  const root = await pmFixture();
  try {
    const before = await pmSnapshot(root);
    const plan = await runCli(['migrate', 'plan', '--root', root]);
    assert.equal(plan.code, 0, plan.output);
    const planned = JSON.parse(plan.output) as { canApply: boolean; sourceDigest: string; tasks: Array<Record<string, unknown>>; records: Record<string, number> };
    assert.equal(planned.canApply, true);
    assert.equal(existsSync(join(root, '.ano')), false, 'plan must not create .ano');
    assert.equal(planned.tasks.length, 2);
    assert.equal(planned.tasks[0]?.ledgerStatus, 'in_progress', 'legacy done is never an ANO done');
    assert.equal(planned.tasks[0]?.sourceStatus, 'done');
    assert.equal(planned.records.sessions, 1);

    const applied = await runCli(['migrate', 'apply', '--root', root, '--expected-source-digest', planned.sourceDigest]);
    assert.equal(applied.code, 0, applied.output);
    const result = JSON.parse(applied.output) as { tasks: Record<string, number>; sessions: number; sourceUnchanged: boolean; reconciled: Record<string, unknown> };
    assert.equal(result.tasks.created, 2);
    assert.equal(result.sessions, 1);
    assert.equal(result.sourceUnchanged, true);
    assert.equal(result.reconciled.matched, 2);
    assert.equal(await pmSnapshot(root), before, 'apply must not modify .pm bytes or mtimes');

    const again = await runCli(['migrate', 'apply', '--root', root, '--expected-source-digest', planned.sourceDigest]);
    assert.equal(again.code, 0, again.output);
    assert.equal((JSON.parse(again.output) as { tasks: Record<string, number> }).tasks.created, 0);

    const stale = await runCli(['migrate', 'apply', '--root', root, '--expected-source-digest', '0'.repeat(64)]);
    assert.equal(stale.code, 1);
    assert.match(stale.output, /expected-source-digest|source/i);

    const status = await runCli(['migrate', 'status', '--root', root]);
    assert.equal(status.code, 0, status.output);
    const statusPayload = JSON.parse(status.output) as { matched: number; conflicts: string[] };
    assert.equal(statusPayload.matched, 2);
    assert.deepEqual(statusPayload.conflicts, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native task update/cancel/reopen are exposed and done requires Gate evidence', async () => {
  const root = await gitProject();
  const { client, close } = await mcp(root);
  try {
    const created = payload(await client.callTool({
      name: 'track',
      arguments: { root, idem_key: 't1:create', kind: 'task', operation: 'create', payload: { id: 'T-1', title: 'Work', files: ['test/a.test.ts'] } },
    }));
    assert.equal((created.task as { id: string }).id, 'T-1');

    const badDone = await client.callTool({
      name: 'track',
      arguments: { root, idem_key: 't1:bad', kind: 'task', operation: 'update', payload: { id: 'T-1', status: 'done' } },
    });
    assert.equal(badDone.isError, true, 'schema must reject a bare done update');

    const badEvidence = await client.callTool({
      name: 'track',
      arguments: { root, idem_key: 't1:bad-ev', kind: 'task', operation: 'complete', payload: { id: 'T-1', evidence_id: 'nope' } },
    });
    assert.equal(badEvidence.isError, true);

    const cancelled = payload(await client.callTool({
      name: 'track',
      arguments: { root, idem_key: 't1:cancel', kind: 'task', operation: 'cancel', payload: { id: 'T-1' } },
    }));
    assert.equal((cancelled.task as { status: string }).status, 'cancelled');

    const reopenCancelled = await client.callTool({
      name: 'track',
      arguments: { root, idem_key: 't1:reopen-cancelled', kind: 'task', operation: 'reopen', payload: { id: 'T-1' } },
    });
    assert.equal(reopenCancelled.isError, true, 'only a done task can be reopened');

    const update = payload(await client.callTool({
      name: 'track',
      arguments: { root, idem_key: 't1:update', kind: 'task', operation: 'update', payload: { id: 'T-1', status: 'in_progress' } },
    }));
    assert.equal((update.task as { status: string }).status, 'in_progress');

    const verified = payload(await client.callTool({
      name: 'verify',
      arguments: { root, idem_key: 't1:verify', scope: 'task', task_id: 'T-1', argv: [process.execPath, '--test', 'test/a.test.ts'], test_files: ['test/a.test.ts'] },
    }));
    const verdict = verified.verdict as { status: string; evidenceId: string };
    assert.equal(verdict.status, 'done');

    const reopened = payload(await client.callTool({
      name: 'track',
      arguments: { root, idem_key: 't1:reopen', kind: 'task', operation: 'reopen', payload: { id: 'T-1' } },
    }));
    assert.equal((reopened.task as { status: string }).status, 'in_progress');

    const completed = payload(await client.callTool({
      name: 'track',
      arguments: { root, idem_key: 't1:complete', kind: 'task', operation: 'complete', payload: { id: 'T-1', evidence_id: verdict.evidenceId } },
    }));
    assert.equal((completed.task as { status: string }).status, 'done');

    const wrongEvidence = await client.callTool({
      name: 'track',
      arguments: { root, idem_key: 't1:wrong-ev', kind: 'task', operation: 'complete', payload: { id: 'T-1', evidence_id: 'x'.repeat(64) } },
    });
    assert.equal(wrongEvidence.isError, true);
  } finally {
    await close();
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI help and migrate surface reject unknown actions and missing digests', async () => {
  const help = await runCli(['--help']);
  assert.match(help.output, /ano migrate \[plan\|apply\|status\|reconcile\|backup\|restore\|list-backups\]/);
  assert.match(help.output, /ano track complete --id <task-id> --evidence-id/);

  const root = await pmFixture();
  try {
    const bad = await runCli(['migrate', 'apply', '--root', root]);
    assert.equal(bad.code, 2);
    assert.match(bad.output, /--expected-source-digest/);

    const unknown = await runCli(['migrate', 'nope', '--root', root]);
    assert.equal(unknown.code, 2);
    assert.match(unknown.output, /migrate supports/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('spawn CLI binary still reports the same surface without breaking argv boundaries', () => {
  const result = spawnSync(process.execPath, [cliPath, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ano migrate/);
});

test('handoff stays blocked until migration, backup and named cutover evidence all exist', async () => {
  const root = await pmFixture();
  try {
    const beforeConnection = await handoffReadiness(root);
    assert.equal(beforeConnection.ready, false);
    assert.ok(beforeConnection.blockers.some((item) => /Connect connection/.test(item)));

    const connected = await connectProject(root);
    assert.equal(connected.report.connected, true);

    const blockedNoMigration = await handoffReadiness(root);
    assert.equal(blockedNoMigration.ready, false);
    assert.ok(blockedNoMigration.blockers.some((item) => /not migrated/.test(item)));

    const planOutput = await runCli(['migrate', 'plan', '--root', root]);
    const planDigest = (JSON.parse(planOutput.output) as { sourceDigest: string }).sourceDigest;
    const applied = await runCli(['migrate', 'apply', '--root', root, '--expected-source-digest', planDigest]);
    assert.equal(applied.code, 0, applied.output);

    const blockedNoBackup = await handoffReadiness(root);
    assert.equal(blockedNoBackup.ready, false);
    assert.ok(blockedNoBackup.blockers.some((item) => /backup/.test(item)));

    const backup = await runCli(['migrate', 'backup', '--root', root]);
    assert.equal(backup.code, 0, backup.output);
    const manifest = JSON.parse(backup.output) as { id: string; hash: string };

    const blockedNoCutover = await handoffReadiness(root);
    assert.equal(blockedNoCutover.ready, false);
    assert.ok(blockedNoCutover.blockers.some((item) => /cutover confirmation/.test(item)));

    const confirmed = await runCli([
      'connect', 'cutover', 'confirm', '--root', root,
      '--name', 'Ada', '--role', 'owner', '--statement', 'ANO leads this project',
      '--source-digest', planDigest, '--backup-id', manifest.id, '--confirm',
    ]);
    assert.equal(confirmed.code, 0, confirmed.output);

    const ready = await handoffReadiness(root);
    assert.equal(ready.ready, true, JSON.stringify(ready.blockers));
    assert.ok(ready.capabilities.includes('handoff'));

    // A tampered backup must remove the verified-backup evidence and block handoff.
    const backups = await listBackups(root);
    const target = backups.find((item) => item.id === manifest.id)!;
    const tamperedPath = join(root, '.ano', 'backup', target.id, '.pm', 'tasks.json');
    await writeFile(tamperedPath, '{tampered}\n');
    const blockedTampered = await handoffReadiness(root);
    assert.equal(blockedTampered.ready, false);
    assert.ok(blockedTampered.blockers.some((item) => /backup/.test(item)));
    assert.equal(backupHash(target).length, 64);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('backup restore verifies hashes and refuses a corrupted backup', async () => {
  const root = await pmFixture();
  try {
    const before = await pmSnapshot(root);
    const backup = await runCli(['migrate', 'backup', '--root', root]);
    assert.equal(backup.code, 0, backup.output);
    const manifest = JSON.parse(backup.output) as { id: string };

    await writeFile(join(root, '.pm', 'tasks.json'), '{"tasks":[]}\n');
    const restored = await runCli(['migrate', 'restore', '--root', root, '--backup-id', manifest.id]);
    assert.equal(restored.code, 0, restored.output);
    assert.equal(await pmSnapshot(root), before, 'restore returns .pm to the backed-up bytes');

    await writeFile(join(root, '.ano', 'backup', manifest.id, '.pm', 'tasks.json'), '{broken}\n');
    const refused = await runCli(['migrate', 'restore', '--root', root, '--backup-id', manifest.id]);
    assert.equal(refused.code, 1);
    assert.match(refused.output, /verification|hash|missing/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('migration binds to the repository-root .pm and ignores a nested server/.pm decoy', async () => {
  const root = await nestedRepo();
  try {
    const plan = await runCli(['migrate', 'plan', '--root', root]);
    assert.equal(plan.code, 0, plan.output);
    const planned = JSON.parse(plan.output) as {
      tasks: Array<{ id: string }>;
      sourceDigest: string;
      rootResolution: { inputRoot: string; gitRoot: string; pmRoot: string; sourceRoots: string[] };
      ignoredPmRoots: string[];
    };
    assert.equal(planned.tasks.length, 3, 'only the repository-root tasks migrate');
    assert.equal(planned.tasks.some((task) => task.id === 'T-DECOY'), false, 'server/.pm must not contribute tasks');
    assert.equal(planned.rootResolution.pmRoot, root);
    assert.equal(planned.rootResolution.gitRoot, root);
    assert.ok(planned.rootResolution.sourceRoots.includes(join(root, 'server')));
    assert.ok(planned.ignoredPmRoots.includes(join(root, 'server')), 'server/.pm is reported as ignored');

    // A nested package input resolves to the same repository-root PM source.
    const fromServer = await runCli(['migrate', 'plan', '--root', join(root, 'server')]);
    assert.equal(fromServer.code, 0, fromServer.output);
    const nested = JSON.parse(fromServer.output) as { tasks: Array<{ id: string }>; rootResolution: { inputRoot: string; pmRoot: string } };
    assert.equal(nested.tasks.length, 3);
    assert.equal(nested.tasks.some((task) => task.id === 'T-DECOY'), false);
    assert.equal(nested.rootResolution.inputRoot, join(root, 'server'));
    assert.equal(nested.rootResolution.pmRoot, root);

    const serverBefore = await pmSnapshot(join(root, 'server'));
    const applied = await runCli(['migrate', 'apply', '--root', root, '--expected-source-digest', planned.sourceDigest]);
    assert.equal(applied.code, 0, applied.output);
    const result = JSON.parse(applied.output) as {
      tasks: { total: number; created: number };
      ledgerTasks: number;
      rootResolution: { pmRoot: string };
    };
    assert.equal(result.tasks.total, 3);
    assert.equal(result.tasks.created, 3);
    assert.equal(result.ledgerTasks, 3);
    assert.equal(result.rootResolution.pmRoot, root);
    assert.equal(existsSync(join(root, '.ano', 'ledger')), true, 'ledger lives at the repository root');
    assert.equal(existsSync(join(root, 'server', '.ano')), false, 'no ledger is created below the source root');
    assert.equal(await pmSnapshot(join(root, 'server')), serverBefore, 'the decoy .pm is never read or written');

    // existingProjectRoot accepts both the Git root and the nested package.
    assert.equal(await existingProjectRoot(root), root);
    assert.equal(await existingProjectRoot(join(root, 'server')), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a repository without any package.json reports NO_NODE_PACKAGE', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ano no package '));
  try {
    await mkdir(join(root, '.git'), { recursive: true });
    await mkdir(join(root, '.pm'), { recursive: true });
    await writeFile(join(root, '.pm', 'tasks.json'), '{"seq":1,"tasks":[]}\n');
    await expectScanError(resolveMigrationRoot(root), 'NO_NODE_PACKAGE');
    await expectScanError(migratePlanSurface(root), 'NO_NODE_PACKAGE');
    await assert.rejects(runCli(['migrate', 'plan', '--root', root]), /No package\.json/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('multi-package discovery is deterministic and can be forced to AMBIGUOUS_SOURCE_ROOTS', async () => {
  const root = await nestedRepo();
  try {
    await mkdir(join(root, 'client'), { recursive: true });
    await writeFile(join(root, 'client', 'package.json'), `${JSON.stringify({ name: 'client', private: true }, null, 2)}\n`);

    const resolved = await resolveMigrationRoot(root);
    assert.deepEqual(resolved.sourceRoots, [join(root, 'client'), join(root, 'server')]);
    assert.equal(resolved.pmRoot, root);
    assert.equal(resolved.discovery.ambiguous, true);

    await expectScanError(resolveMigrationRoot(root, { onAmbiguity: 'error' }), 'AMBIGUOUS_SOURCE_ROOTS');
    // The default nearest-layer policy keeps migration deterministic and working.
    const plan = await migratePlanSurface(root);
    assert.equal((plan['tasks'] as Array<{ id: string }>).length, 3);
    assert.equal((plan['rootResolution'] as { pmRoot: string }).pmRoot, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a source subdirectory .pm is never the PM root and role conflicts are explicit', async () => {
  const root = await nestedRepo();
  try {
    await mkdir(join(root, 'plain'), { recursive: true });
    await expectScanError(resolveMigrationRoot(root, { pmRoot: join(root, 'plain') }), 'PM_ROOT_WITHOUT_PM');
    await expectScanError(resolveMigrationRoot(join(root, 'server'), { pmRoot: join(root, 'server') }), 'ROOT_ROLE_CONFLICT');

    // No repository-root .pm: the nested server/.pm must be refused, not used.
    const trap = await mkdtemp(join(tmpdir(), 'ano nested trap '));
    try {
      await mkdir(join(trap, '.git'), { recursive: true });
      await mkdir(join(trap, 'server', '.pm'), { recursive: true });
      await writeFile(join(trap, 'server', 'package.json'), '{"name":"server"}\n');
      await writeFile(join(trap, 'server', '.pm', 'tasks.json'), '{"seq":1,"tasks":[{"id":"T-DECOY","status":"todo"}]}\n');
      assert.throws(() => resolveMigrationPmRoot(join(trap, 'server')), (error: unknown) => {
        assert.ok(error instanceof ProjectScanError);
        assert.equal(error.code, 'PM_ROOT_WITHOUT_PM');
        return true;
      });
      assert.throws(() => planMigration(join(trap, 'server')), (error: unknown) => {
        assert.ok(error instanceof ProjectScanError);
        assert.equal(error.code, 'PM_ROOT_WITHOUT_PM');
        return true;
      });
    } finally {
      await rm(trap, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('takeover binds to the repository-root .pm and audits the root resolution', async () => {
  const root = await nestedRepo();
  try {
    const granted = await takeoverGrant(root, {
      scope: ['tasks', 'memory', 'acceptance', 'dag'],
      grantedBy: 'Alice',
      role: 'owner',
      statement: 'I explicitly authorize ANO takeover of this project.',
      grantedAt: '2026-11-23T00:00:00.000Z',
    });
    const authorizationId = (granted.authorization as { authorizationId: string }).authorizationId;
    const serverBefore = await pmSnapshot(join(root, 'server'));

    // Applying from the nested package root must bind to the repository root.
    const result = await runTakeover(join(root, 'server'), {
      confirm: true,
      authorizationId,
      now: '2026-11-23T00:00:01.000Z',
      hostCapability: 'degraded',
    });
    assert.equal(result.active, true, JSON.stringify(result));
    assert.equal(result.root, root);
    assert.equal(result.rootResolution?.pmRoot, root);
    assert.equal(result.rootResolution?.gitRoot, root);
    assert.ok(result.rootResolution?.sourceRoots.includes(join(root, 'server')));
    assert.ok(result.ignoredPmRoots?.includes(join(root, 'server')));
    assert.equal(await pmSnapshot(join(root, 'server')), serverBefore, 'the decoy .pm is never touched');

    const summary = readMigrationSummary(root) as { source_records?: { tasks?: number } };
    assert.equal(summary.source_records?.tasks, 3, 'takeover migrated the repository-root tasks');
    assert.equal(existsSync(join(root, 'server', '.ano')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
