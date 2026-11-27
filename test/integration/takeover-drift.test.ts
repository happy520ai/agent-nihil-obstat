import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  CONNECT_CAPABILITIES,
  ConnectLegacyWriteBlockedError,
  assertLegacyWriteAllowed,
  legacyWriteDecision,
  roleMatrixForState,
} from '../../src/connect/capabilities.ts';
import { connectProject } from '../../src/connect/engine.ts';
import { handoffReadiness } from '../../src/connect/handoff.ts';
import { resolveRoot } from '../../src/connect/paths.ts';
import { createAuthorization, type CreateAuthorizationInput, type TakeoverAuthorization } from '../../src/connect/takeover-policy.ts';
import { applyStateTransition, loadPolicy, saveAuthorization } from '../../src/connect/takeover-store.ts';
import { computeTakeoverSourceDigest, runTakeover, type TakeoverRunOptions, type TakeoverRunResult } from '../../src/connect/takeover.ts';
import type { ConnectDriftReport, ConnectLayerRoleEntry, ConnectRoleMatrix } from '../../src/connect/types.ts';
import {
  CONNECT_DRIFT_WATCH_SCHEMA,
  CONNECT_WATCH_SCHEMA,
  detectLegacyDrift,
  watchConnection,
  watchDrift,
} from '../../src/connect/watch.ts';

const NOW = '2026-11-22T00:00:00.000Z';
const AGENTS_ORIGINAL = '<!-- pm-mcp:agents-md:v1:begin -->\npm rules\n<!-- pm-mcp:agents-md:v1:end -->\n\n# User notes\n\nkeep this\n';

async function makeRoot(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ano-takeover-drift-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function pmFixture(root: string): Promise<void> {
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
}

async function ordinaryFixture(root: string): Promise<void> {
  await mkdir(join(root, '.pm'), { recursive: true });
  await writeFile(join(root, '.pm', 'project.json'), `${JSON.stringify({ name: 'Ordinary Fixture' }, null, 2)}\n`);
  await writeFile(join(root, '.pm', 'tasks.json'), `${JSON.stringify({ seq: 1, tasks: [{ id: 'T-1', title: 'one', status: 'todo' }] }, null, 2)}\n`);
  await writeFile(join(root, '.pm', 'roadmap.json'), `${JSON.stringify({ seq: 1, milestones: [{ id: 'M1', title: 'One', status: 'active' }] }, null, 2)}\n`);
}

function writeAgents(root: string, content: string): void {
  writeFileSync(join(root, 'AGENTS.md'), content);
}

async function grant(root: string, overrides: Partial<CreateAuthorizationInput> = {}): Promise<TakeoverAuthorization> {
  const canonical = resolveRoot(root);
  const authorization = createAuthorization({
    root: canonical,
    projectId: 'proj-1',
    projectKey: 'key-1',
    scope: ['tasks', 'memory', 'acceptance', 'dag'],
    grantedBy: 'Alice',
    role: 'owner',
    statement: 'I explicitly authorize ANO takeover of this project.',
    grantedAt: NOW,
    ...overrides,
  });
  saveAuthorization(canonical, authorization);
  return authorization;
}

function run(root: string, authorizationId: string, extra: Partial<TakeoverRunOptions> = {}): Promise<TakeoverRunResult> {
  return runTakeover(root, { confirm: true, authorizationId, now: NOW, hostCapability: 'degraded', ...extra });
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

function layer(matrix: ConnectRoleMatrix, name: ConnectLayerRoleEntry['layer']): ConnectLayerRoleEntry {
  const entry = matrix.layers.find((candidate) => candidate.layer === name);
  assert.ok(entry, `missing layer ${name}`);
  return entry;
}

test('role matrix and legacy-write guard follow the takeover state', () => {
  const disabled = roleMatrixForState('disabled');
  assert.equal(disabled.state, 'disabled');
  assert.equal(layer(disabled, 'tasks').ano, 'read-only');
  assert.equal(layer(disabled, 'tasks').legacyPm, 'primary-write');
  assert.equal(layer(disabled, 'dag').legacyPm, 'primary-write');
  assert.equal(layer(disabled, 'release').ano, 'manual');
  // Unknown/null host capability is fail-closed degraded, never reported as enforced.
  assert.equal(disabled.degraded, true);
  assert.ok(disabled.degradationReasons.length > 0);
  assert.equal(legacyWriteDecision('disabled').allowed, true);
  assert.doesNotThrow(() => assertLegacyWriteAllowed('disabled'));

  const enforced = roleMatrixForState('enforced', 'degraded');
  assert.equal(layer(enforced, 'tasks').ano, 'primary-write');
  assert.equal(layer(enforced, 'tasks').legacyPm, 'read-only');
  assert.equal(layer(enforced, 'memory').ano, 'primary-write');
  assert.equal(layer(enforced, 'acceptance').ano, 'primary-write');
  assert.equal(layer(enforced, 'dag').ano, 'primary-write');
  assert.equal(layer(enforced, 'release').ano, 'manual');
  assert.equal(enforced.degraded, true);
  const blocked = legacyWriteDecision('enforced', 'tasks');
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason ?? '', /read-only/);
  assert.throws(
    () => assertLegacyWriteAllowed('enforced', 'tasks'),
    (error: unknown) => {
      assert.ok(error instanceof ConnectLegacyWriteBlockedError);
      assert.equal(error.code, 'CONNECT_LEGACY_WRITE_BLOCKED');
      assert.equal(error.state, 'enforced');
      assert.equal(error.scope, 'tasks');
      return true;
    },
  );

  const full = roleMatrixForState('enforced', 'full');
  assert.equal(full.degraded, false);
  assert.deepEqual(full.degradationReasons, []);

  const recovery = roleMatrixForState('recovery');
  assert.equal(layer(recovery, 'tasks').ano, 'paused');
  assert.equal(layer(recovery, 'tasks').legacyPm, 'primary-write');
  assert.equal(layer(recovery, 'dag').ano, 'paused');
  assert.equal(legacyWriteDecision('recovery').allowed, true);
  assert.doesNotThrow(() => assertLegacyWriteAllowed('recovery'));
});

test('enforced takeover marks legacy PM-mcp read-only in the handoff projection', async (t) => {
  const root = await makeRoot(t);
  await pmFixture(root);
  writeAgents(root, AGENTS_ORIGINAL);
  const auth = await grant(root);

  const result = await run(root, auth.authorizationId);
  assert.equal(result.state, 'enforced');

  assert.throws(() => assertLegacyWriteAllowed('enforced'));
  const enforced = roleMatrixForState('enforced', 'degraded');
  assert.equal(layer(enforced, 'tasks').legacyPm, 'read-only');

  const handoff = await handoffReadiness(root);
  assert.ok(handoff.takeover, 'handoff must carry the takeover projection');
  assert.equal(handoff.takeover.state, 'enforced');
  assert.equal(handoff.takeover.enforced, true);
  assert.equal(handoff.takeover.legacyPm, 'read-only');
  assert.equal(handoff.takeover.authorizationId, auth.authorizationId);
  assert.match(handoff.takeover.note, /read-only/);
  assert.equal(layer(handoff.takeover.roleMatrix, 'tasks').legacyPm, 'read-only');

  // Old Connect readiness semantics are preserved.
  assert.equal(handoff.ready, false);
  assert.ok(handoff.blockers.length > 0);
  assert.deepEqual(handoff.capabilities, [...CONNECT_CAPABILITIES]);
});

test('drift baseline digest is the takeover transaction digest', async (t) => {
  const root = await makeRoot(t);
  await pmFixture(root);
  writeAgents(root, AGENTS_ORIGINAL);
  const auth = await grant(root);

  const result = await run(root, auth.authorizationId);
  const policy = loadPolicy(root);
  assert.equal(policy?.baselineDigest, result.sourceDigest);
  assert.equal(computeTakeoverSourceDigest(root), result.sourceDigest);

  const report = detectLegacyDrift(root);
  assert.ok(report);
  assert.equal(report.baselineDigest, result.sourceDigest);
  assert.equal(report.currentDigest, computeTakeoverSourceDigest(root));
  assert.equal(report.drifted, false);
  assert.deepEqual(report.files, []);
  assert.equal(report.recommendation, 'none');
  assert.equal(report.reconcileStale, false);
  assert.equal(report.authorizationId, auth.authorizationId);
  assert.equal(report.backupId, result.backupId);
  assert.equal(report.backupHash, result.backupHash);
});

test('external legacy write produces a localizable drift report and never writes back', async (t) => {
  const root = await makeRoot(t);
  await pmFixture(root);
  writeAgents(root, AGENTS_ORIGINAL);
  const auth = await grant(root);
  const result = await run(root, auth.authorizationId);
  const before = await pmSnapshot(root);

  const tasksPath = join(root, '.pm', 'tasks.json');
  const tasks = JSON.parse(readFileSync(tasksPath, 'utf8')) as { seq: number; tasks: Array<Record<string, unknown>> };
  tasks.seq = 2;
  tasks.tasks.push({ id: 'T-PM-3', title: 'External edit', status: 'todo' });
  await writeFile(tasksPath, `${JSON.stringify(tasks, null, 2)}\n`);
  await writeFile(join(root, '.pm', 'external-note.json'), '{"note":"external"}\n');
  const afterExternalWrite = await pmSnapshot(root);
  assert.notEqual(afterExternalWrite, before);

  const report = detectLegacyDrift(root);
  assert.ok(report);
  assert.equal(report.drifted, true);
  assert.equal(report.baselineDigest, result.sourceDigest);
  assert.equal(report.currentDigest, computeTakeoverSourceDigest(root));
  assert.notEqual(report.currentDigest, report.baselineDigest);
  assert.equal(report.recommendation, 'recovery');
  assert.equal(report.reconcileStale, true);
  assert.equal(report.authorizationId, auth.authorizationId);

  const paths = report.files.map((file) => file.path);
  assert.ok(paths.includes('tasks.json'), `expected tasks.json in ${paths.join(', ')}`);
  assert.ok(paths.includes('external-note.json'), `expected external-note.json in ${paths.join(', ')}`);
  const modified = report.files.find((file) => file.path === 'tasks.json');
  assert.equal(modified?.kind, 'modified');
  assert.ok(modified?.baselineSha256 !== undefined && modified?.currentSha256 !== undefined);
  assert.notEqual(modified?.baselineSha256, modified?.currentSha256);
  assert.equal(report.files.find((file) => file.path === 'external-note.json')?.kind, 'added');

  // Detection is read-only: zero write-back to the legacy source and no policy change.
  assert.equal(await pmSnapshot(root), afterExternalWrite);
  assert.equal(loadPolicy(root)?.state, 'enforced');
});

test('watchDrift persists the first drift report and stops without touching .pm', async (t) => {
  const root = await makeRoot(t);
  await pmFixture(root);
  writeAgents(root, AGENTS_ORIGINAL);
  const auth = await grant(root);
  await run(root, auth.authorizationId);

  const tasksPath = join(root, '.pm', 'tasks.json');
  const tasks = JSON.parse(readFileSync(tasksPath, 'utf8')) as { seq: number; tasks: Array<Record<string, unknown>> };
  tasks.seq = 3;
  await writeFile(tasksPath, `${JSON.stringify(tasks, null, 2)}\n`);
  const afterExternalWrite = await pmSnapshot(root);

  const detected: ConnectDriftReport[] = [];
  const watchReport = await watchDrift({
    root,
    intervalMs: 50,
    maxCycles: 3,
    onDetect: (report) => detected.push(report),
  });

  assert.equal(watchReport.schema, CONNECT_DRIFT_WATCH_SCHEMA);
  assert.equal(watchReport.stopped, 'drift');
  assert.equal(watchReport.cycles, 1);
  assert.equal(detected.length, 1);
  assert.ok(watchReport.report);
  assert.equal(watchReport.report.drifted, true);

  const driftDir = join(root, '.ano', 'takeover', 'drift');
  assert.ok(existsSync(driftDir));
  const written = (await readdir(driftDir)).filter((name) => name.endsWith('.json'));
  assert.equal(written.length, 1);
  const persisted = JSON.parse(readFileSync(join(driftDir, written[0] ?? ''), 'utf8')) as ConnectDriftReport;
  assert.equal(persisted.drifted, true);
  assert.ok(persisted.files.length > 0);
  assert.equal(await pmSnapshot(root), afterExternalWrite, 'drift watch must never write back to .pm');
});

test('recovery and disabled allow the legacy path again', async (t) => {
  const root = await makeRoot(t);
  await pmFixture(root);
  writeAgents(root, AGENTS_ORIGINAL);
  const auth = await grant(root);
  await run(root, auth.authorizationId);

  assert.throws(() => assertLegacyWriteAllowed('enforced'));

  applyStateTransition(resolveRoot(root), { from: 'enforced', to: 'recovery', now: NOW });
  assert.equal(loadPolicy(root)?.state, 'recovery');
  assert.doesNotThrow(() => assertLegacyWriteAllowed('recovery', 'tasks'));
  assert.equal(legacyWriteDecision('recovery').allowed, true);
  const recovery = roleMatrixForState('recovery');
  assert.equal(layer(recovery, 'tasks').ano, 'paused');
  assert.equal(layer(recovery, 'tasks').legacyPm, 'primary-write');
  assert.equal(detectLegacyDrift(root), null, 'drift is only reported while enforced');

  applyStateTransition(resolveRoot(root), { from: 'recovery', to: 'disabled', now: NOW });
  assert.equal(loadPolicy(root)?.state, 'disabled');
  assert.doesNotThrow(() => assertLegacyWriteAllowed('disabled'));
  assert.equal(detectLegacyDrift(root), null);
});

test('ordinary projects keep watch and handoff semantics unchanged', async (t) => {
  const root = await makeRoot(t);
  await ordinaryFixture(root);
  const before = await pmSnapshot(root);

  const report = await watchConnection({ root, intervalMs: 50, maxCycles: 2 });

  assert.equal(report.schema, CONNECT_WATCH_SCHEMA);
  assert.equal(report.stopped, 'max-cycles');
  assert.equal(report.cycles, 2);
  assert.deepEqual(report.records.map((record) => record.outcome), ['committed', 'unchanged']);
  assert.equal('drift' in report, false, 'ordinary watch report shape must not gain drift fields');
  assert.equal(await pmSnapshot(root), before, 'watch must never write the source');

  assert.equal(detectLegacyDrift(root), null, 'no takeover policy means no drift report');

  const handoff = await handoffReadiness(root);
  assert.equal(handoff.takeover, undefined);
  assert.equal(handoff.ready, false);
  assert.ok(handoff.blockers.length > 0);
  assert.deepEqual(handoff.capabilities, [...CONNECT_CAPABILITIES]);
  assert.ok(existsSync(join(root, '.ano', 'connect')), 'the ordinary Connect connection still exists');
  assert.equal(existsSync(join(root, '.ano', 'takeover')), false, 'ordinary projects never create .ano/takeover');
});
