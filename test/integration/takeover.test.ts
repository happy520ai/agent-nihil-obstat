import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { listBackups, verifyBackup } from '../../src/connect/backup.ts';
import { MANAGED_INSTRUCTIONS_BEGIN, managedStateDeclaration } from '../../src/connect/managed-instructions.ts';
import { resolveRoot } from '../../src/connect/paths.ts';
import { createAuthorization, type CreateAuthorizationInput, type TakeoverAuthorization } from '../../src/connect/takeover-policy.ts';
import { applyStateTransition, computeTransactionId, loadPolicy, readTransactions, saveAuthorization } from '../../src/connect/takeover-store.ts';
import { runTakeover, takeoverStatus, type TakeoverRunOptions, type TakeoverRunResult, type TakeoverRuntime } from '../../src/connect/takeover.ts';

const NOW = '2026-11-22T00:00:00.000Z';
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
// Snapshot scope excludes only pm-mcp's own bookkeeping (rel is relative to
// .pm), by subtree prefix:
// - `changelog.md` (appended by record_round),
// - `quality-runs/` (quality report registration),
// - `runtime/` and `.runtime/` (idempotency placeholders, watcher settlement,
//   locks — subsumes the former `.runtime/idempotency` and `.runtime` entries;
//   both spellings are kept because pm-mcp has used each across versions),
// - `snapshots/` (snapshot_codebase output),
// - `index.db` plus its `-wal`/`-shm` companions (search index).
// These are the PM matrix's own bookkeeping, mutated by an external process
// during the snapshot window, never takeover artifacts. The takeover contract
// is to leave .pm content files (tasks/roadmap/features/sessions/project/
// decisions, ...) untouched; all of those stay asserted.
// PROJECT.md is a root-level dashboard outside the .pm walk; it is retained
// defensively and matches nothing.
const EXCLUDED_SNAPSHOT_PATHS = new Set([
  'changelog.md',
  'quality-runs',
  'runtime',
  '.runtime',
  'snapshots',
  'index.db',
  'index.db-wal',
  'index.db-shm',
  'PROJECT.md',
]);
function isExcludedSnapshotPath(rel: string): boolean {
  for (const path of EXCLUDED_SNAPSHOT_PATHS) {
    if (rel === path || rel.startsWith(`${path}/`)) return true;
  }
  return false;
}
const AGENTS_ORIGINAL = '<!-- pm-mcp:agents-md:v1:begin -->\npm rules\n<!-- pm-mcp:agents-md:v1:end -->\n\n# User notes\n\nkeep this 字节\n';

async function makeRoot(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ano-takeover-'));
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

function writeAgents(root: string, content: string): void {
  writeFileSync(join(root, 'AGENTS.md'), content);
}

function readAgents(root: string): string {
  return readFileSync(join(root, 'AGENTS.md'), 'utf8');
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

async function pmSnapshot(root: string): Promise<string> {
  const entries: Array<Record<string, unknown>> = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(dir, entry.name);
      const rel = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name;
      // skip pm-mcp's self-managed bookkeeping (see EXCLUDED_SNAPSHOT_PATHS);
      // not takeover artifacts
      if (isExcludedSnapshotPath(rel)) continue;
      if (entry.isDirectory()) await walk(full, rel);
      else if (entry.isFile()) {
        const bytes = await readFile(full);
        entries.push({ path: rel, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
      }
    }
  };
  // The public snapshot does not ship private PM state; an absent directory is
  // an empty snapshot, not an error.
  if (!existsSync(join(root, '.pm'))) return '[]';
  await walk(join(root, '.pm'), '');
  return JSON.stringify(entries);
}

function run(root: string, authorizationId: string, extra: Partial<TakeoverRunOptions> = {}): Promise<TakeoverRunResult> {
  return runTakeover(root, { confirm: true, authorizationId, now: NOW, hostCapability: 'degraded', ...extra });
}

test('full takeover advances through all six phases and enforces only with complete evidence', async (t) => {
  const root = await makeRoot(t);
  await pmFixture(root);
  writeAgents(root, AGENTS_ORIGINAL);
  const auth = await grant(root);
  const pmBefore = await pmSnapshot(root);

  const result = await run(root, auth.authorizationId);

  assert.equal(result.active, true);
  assert.equal(result.aborted, false);
  assert.equal(result.failedPhase, null);
  assert.equal(result.error, null);
  assert.equal(result.phase, 'active');
  assert.equal(result.state, 'enforced');
  assert.equal(result.created, true);
  assert.equal(result.resumed, false);
  assert.equal(
    result.txId,
    computeTransactionId({ authorizationId: auth.authorizationId, sourceDigest: result.sourceDigest, backupHash: result.backupHash }),
  );

  const entries = readTransactions(root);
  assert.deepEqual(entries.map((entry) => entry.phase), ['prepared', 'migrated', 'reconciled', 'verified', 'installed', 'active']);
  assert.equal(entries.every((entry) => entry.txId === result.txId), true);

  const policy = loadPolicy(root);
  assert.equal(policy?.state, 'enforced');
  assert.equal(policy?.enforcedAt, NOW);
  assert.equal(policy?.baselineDigest, result.sourceDigest);
  assert.equal(policy?.hostCapability, 'degraded');

  const agents = readAgents(root);
  assert.equal(agents.startsWith(AGENTS_ORIGINAL), true, 'user AGENTS.md bytes must be preserved');
  assert.equal(agents.includes(MANAGED_INSTRUCTIONS_BEGIN), true);
  assert.equal(agents.includes(managedStateDeclaration('enforced')), true);

  assert.equal(await pmSnapshot(root), pmBefore, '.pm bytes must never change');

  const verification = await verifyBackup(root, result.backupId);
  assert.equal(verification.ok, true);
  assert.equal((await listBackups(root)).length, 1);

  const status = takeoverStatus(root);
  assert.equal(status.state, 'enforced');
  assert.equal(status.transaction?.phase, 'active');
  assert.equal(status.transactions, 6);
  for (const name of ['prepared.json', 'migration-summary.json', 'reconcile.json', 'verification.json', 'installed.json']) {
    assert.equal(status.artifacts.includes(name), true, name);
  }
});

test('same-key replay is idempotent and adds no journal entries', async (t) => {
  const root = await makeRoot(t);
  await pmFixture(root);
  writeAgents(root, AGENTS_ORIGINAL);
  const auth = await grant(root);

  const first = await run(root, auth.authorizationId);
  const journalLength = readTransactions(root).length;
  const agentsAfterFirst = readFileSync(join(root, 'AGENTS.md'));

  const second = await run(root, auth.authorizationId);

  assert.equal(readTransactions(root).length, journalLength, 'replay must not append');
  assert.equal(second.txId, first.txId);
  assert.equal(second.phase, 'active');
  assert.equal(second.state, 'enforced');
  assert.equal(second.evidenceHash, first.evidenceHash);
  assert.equal(second.sourceDigest, first.sourceDigest);
  assert.equal(second.backupHash, first.backupHash);
  assert.equal(second.created, false);
  assert.equal(second.resumed, true);
  assert.deepEqual(readFileSync(join(root, 'AGENTS.md')), agentsAfterFirst);
  assert.equal((await listBackups(root)).length, 1, 'replay must not create a second backup');
});

test('missing authorization is refused with zero writes', async (t) => {
  const root = await makeRoot(t);
  await pmFixture(root);
  writeAgents(root, AGENTS_ORIGINAL);
  const before = readFileSync(join(root, 'AGENTS.md'));

  await assert.rejects(run(root, 'a'.repeat(64)), /authorization/);

  assert.deepEqual(readFileSync(join(root, 'AGENTS.md')), before);
  assert.equal(existsSync(join(root, '.ano')), false);
});

test('backup failure leaves no policy, no managed section and no journal records', async (t) => {
  const root = await makeRoot(t);
  await pmFixture(root);
  writeAgents(root, AGENTS_ORIGINAL);
  const auth = await grant(root);
  const pmBefore = await pmSnapshot(root);
  const runtime: TakeoverRuntime = {
    backupProject: async () => {
      throw new Error('injected backup failure');
    },
  };

  await assert.rejects(run(root, auth.authorizationId, { runtime }), /injected backup failure/);

  assert.equal(loadPolicy(root), null);
  assert.equal(readTransactions(root).length, 0);
  assert.equal(readAgents(root), AGENTS_ORIGINAL);
  assert.equal(await pmSnapshot(root), pmBefore);
  assert.equal(existsSync(join(root, '.ano', 'takeover', 'prepared.json')), false);
});

test('migration failure aborts without touching AGENTS.md or the policy state', async (t) => {
  const root = await makeRoot(t);
  await pmFixture(root);
  writeAgents(root, AGENTS_ORIGINAL);
  const auth = await grant(root);
  const runtime: TakeoverRuntime = {
    migrateProject: async () => {
      throw new Error('injected migration failure');
    },
  };

  const result = await run(root, auth.authorizationId, { runtime });

  assert.equal(result.aborted, true);
  assert.equal(result.failedPhase, 'migrated');
  assert.equal(result.active, false);
  assert.equal(result.phase, 'aborted');
  assert.equal(result.state, 'disabled');
  assert.match(result.error ?? '', /injected migration failure/);
  assert.equal(loadPolicy(root)?.state, 'disabled');
  assert.deepEqual(readTransactions(root).map((entry) => entry.phase), ['prepared', 'aborted']);
  assert.equal(readAgents(root), AGENTS_ORIGINAL);
  assert.equal(readAgents(root).includes(MANAGED_INSTRUCTIONS_BEGIN), false);
});

test('reconcile failure stops before verified and leaves no managed section', async (t) => {
  const root = await makeRoot(t);
  await pmFixture(root);
  writeAgents(root, AGENTS_ORIGINAL);
  const auth = await grant(root);
  const runtime: TakeoverRuntime = {
    reconcileMigration: () => ({
      schema: 'ano.migration-reconcile/1',
      root,
      sourceDigest: '0'.repeat(64),
      sourceUnchanged: true,
      canApply: false,
      sourceTasks: 2,
      ledgerTasks: 1,
      matched: 1,
      missing: ['T-PM-1'],
      conflicts: [],
      records: {},
    }),
  };

  const result = await run(root, auth.authorizationId, { runtime });

  assert.equal(result.aborted, true);
  assert.equal(result.failedPhase, 'reconciled');
  assert.equal(result.state, 'disabled');
  assert.deepEqual(readTransactions(root).map((entry) => entry.phase), ['prepared', 'migrated', 'aborted']);
  assert.equal(readAgents(root).includes(MANAGED_INSTRUCTIONS_BEGIN), false);
  assert.equal(existsSync(join(root, '.ano', 'takeover', 'verification.json')), false);
  assert.equal(loadPolicy(root)?.state, 'disabled');
});

test('source drift stops the next phase and preserves the disabled state', async (t) => {
  const root = await makeRoot(t);
  await pmFixture(root);
  writeAgents(root, AGENTS_ORIGINAL);
  const auth = await grant(root);

  const prepared = await run(root, auth.authorizationId, { stopAfterPhase: 'prepared' });
  assert.equal(prepared.phase, 'prepared');
  const journalAfterPrepare = readTransactions(root).length;

  await writeFile(join(root, '.pm', 'tasks.json'), `${JSON.stringify({
    seq: 2,
    tasks: [
      { id: 'T-PM-1', title: 'Migrate me', status: 'done', files: ['test/a.test.ts'] },
      { id: 'T-PM-2', title: 'Keep going', status: 'in_progress' },
      { id: 'T-PM-3', title: 'New', status: 'todo' },
    ],
  }, null, 2)}\n`);

  await assert.rejects(run(root, auth.authorizationId), /source changed|drift/);

  assert.equal(readTransactions(root).length, journalAfterPrepare, 'drift must not append a phase');
  assert.equal(loadPolicy(root)?.state, 'disabled');
  assert.equal(readAgents(root), AGENTS_ORIGINAL);
});

test('interruption after prepare resumes from the journal without a second backup', async (t) => {
  const root = await makeRoot(t);
  await pmFixture(root);
  writeAgents(root, AGENTS_ORIGINAL);
  const auth = await grant(root);

  const prepared = await run(root, auth.authorizationId, { stopAfterPhase: 'prepared' });
  assert.equal(prepared.phase, 'prepared');
  assert.equal((await listBackups(root)).length, 1);

  const resumed = await run(root, auth.authorizationId);

  assert.equal(resumed.resumed, true);
  assert.equal(resumed.txId, prepared.txId);
  assert.equal(resumed.active, true);
  assert.equal(resumed.phase, 'active');
  assert.equal((await listBackups(root)).length, 1, 'resume must reuse the prepared backup');
  assert.deepEqual(
    readTransactions(root).map((entry) => entry.phase),
    ['prepared', 'migrated', 'reconciled', 'verified', 'installed', 'active'],
  );
});

test('crash window with enforced policy but no active record re-appends active', async (t) => {
  const root = await makeRoot(t);
  await pmFixture(root);
  writeAgents(root, AGENTS_ORIGINAL);
  const auth = await grant(root);

  const installed = await run(root, auth.authorizationId, { stopAfterPhase: 'installed' });
  // Simulate the crash window: the policy switched, the active record was lost.
  applyStateTransition(resolveRoot(root), {
    from: 'disabled',
    to: 'enforced',
    baselineDigest: installed.sourceDigest,
    hostCapability: 'degraded',
    now: NOW,
  });

  const recovered = await run(root, auth.authorizationId);

  assert.equal(recovered.active, true);
  assert.equal(recovered.txId, installed.txId);
  assert.equal(recovered.state, 'enforced');
  assert.deepEqual(
    readTransactions(root).map((entry) => entry.phase),
    ['prepared', 'migrated', 'reconciled', 'verified', 'installed', 'active'],
  );
  assert.equal(readAgents(root).includes(managedStateDeclaration('enforced')), true);
});

test('installed records the disabled declaration and active flips it to enforced', async (t) => {
  const root = await makeRoot(t);
  await pmFixture(root);
  writeAgents(root, AGENTS_ORIGINAL);
  const auth = await grant(root);

  const installed = await run(root, auth.authorizationId, { stopAfterPhase: 'installed' });

  assert.equal(installed.phase, 'installed');
  assert.equal(installed.active, false);
  assert.equal(installed.state, 'disabled');
  assert.equal(loadPolicy(root)?.state, 'disabled');
  assert.deepEqual(
    readTransactions(root).map((entry) => entry.phase),
    ['prepared', 'migrated', 'reconciled', 'verified', 'installed'],
  );
  let agents = readAgents(root);
  assert.equal(agents.includes(managedStateDeclaration('disabled')), true);
  assert.equal(agents.startsWith(AGENTS_ORIGINAL), true);

  const active = await run(root, auth.authorizationId);

  assert.equal(active.active, true);
  assert.equal(active.state, 'enforced');
  agents = readAgents(root);
  assert.equal(agents.includes(managedStateDeclaration('enforced')), true);
  assert.equal(agents.includes(managedStateDeclaration('disabled')), false);
  assert.equal(loadPolicy(root)?.state, 'enforced');
});

test('AGENTS.md original bytes are recorded in prepared and installed evidence', async (t) => {
  const root = await makeRoot(t);
  await pmFixture(root);
  writeAgents(root, AGENTS_ORIGINAL);
  const auth = await grant(root);
  const original = Buffer.from(AGENTS_ORIGINAL, 'utf8');
  const expectedHash = createHash('sha256').update(original).digest('hex');

  await run(root, auth.authorizationId);

  const prepared = JSON.parse(readFileSync(join(root, '.ano', 'takeover', 'prepared.json'), 'utf8')) as {
    agents: { exists: boolean; bytes: number; sha256: string | null };
  };
  const installed = JSON.parse(readFileSync(join(root, '.ano', 'takeover', 'installed.json'), 'utf8')) as {
    agentsOriginal: { exists: boolean; bytes: number; sha256: string | null };
  };
  assert.deepEqual(prepared.agents, { exists: true, bytes: original.length, sha256: expectedHash });
  assert.deepEqual(installed.agentsOriginal, prepared.agents);
  assert.equal(readAgents(root).startsWith(AGENTS_ORIGINAL), true);
});

test('revoked and mismatched authorizations are refused without writes', async (t) => {
  const root = await makeRoot(t);
  await pmFixture(root);
  writeAgents(root, AGENTS_ORIGINAL);
  const auth = await grant(root);
  saveAuthorization(resolveRoot(root), { ...auth, revokedAt: NOW });

  await assert.rejects(run(root, auth.authorizationId), /revoked/);
  await assert.rejects(run(root, 'b'.repeat(64)), /does not match/);

  assert.equal(readAgents(root), AGENTS_ORIGINAL);
  assert.equal(readTransactions(root).length, 0);
  assert.equal(loadPolicy(root), null);
});

test('missing confirm is refused without writes', async (t) => {
  const root = await makeRoot(t);
  await pmFixture(root);
  writeAgents(root, AGENTS_ORIGINAL);
  const auth = await grant(root);

  await assert.rejects(
    runTakeover(root, { confirm: false, authorizationId: auth.authorizationId, now: NOW }),
    /confirm/,
  );

  assert.equal(loadPolicy(root), null);
  assert.equal(readTransactions(root).length, 0);
  assert.equal(readAgents(root), AGENTS_ORIGINAL);
});

test('simulated takeover stays in the tmpdir root and never writes the real workspace', async (t) => {
  const root = await makeRoot(t);
  assert.equal(root.toLowerCase().startsWith(tmpdir().toLowerCase()), true);
  await pmFixture(root);
  writeAgents(root, AGENTS_ORIGINAL);
  const auth = await grant(root);
  const repoPmBefore = await pmSnapshot(REPO_ROOT);

  const result = await run(root, auth.authorizationId);

  assert.equal(result.active, true);
  assert.equal(await pmSnapshot(REPO_ROOT), repoPmBefore, 'the real .pm tree must be untouched');
  assert.equal(existsSync(join(REPO_ROOT, '.ano', 'takeover')), false, 'the real .ano/takeover must not be created');
});
