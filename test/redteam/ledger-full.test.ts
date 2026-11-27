import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { parseSegment } from '../../src/ledger/segment.ts';
import { scanSegment } from '../../src/ledger/append.ts';
import { eventChain, type LedgerEvent } from '../../src/ledger/event.ts';
import { IdempotencyConflictError, Ledger, LedgerIntegrityError } from '../../src/ledger/ledger.ts';
import { VIEW_SCHEMA_VERSION } from '../../src/ledger/views.ts';
import { LeaseExpiredError, LeaseHeldError, LeaseMismatchError } from '../../src/ledger/lease.ts';
import { executeEvidence } from '../../src/gate/evidence.ts';
import { runConcurrencyBench } from '../../scripts/bench-concurrency.ts';

async function rootFor(t: TestContext, prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function ledgerDir(root: string): string { return join(root, '.ano', 'ledger'); }
async function segmentNames(root: string): Promise<string[]> {
  return (await readdir(ledgerDir(root)).catch(() => [] as string[])).filter((name) => name.endsWith('.jsonl')).sort();
}
async function committedEvents(root: string): Promise<LedgerEvent[]> {
  const events: LedgerEvent[] = [];
  for (const name of await segmentNames(root)) {
    const scanned = scanSegment(await readFile(join(ledgerDir(root), name)));
    assert.equal(scanned.ignoredTail, false, `${name} must not have an uncommitted tail`);
    assert.equal(eventChain(scanned.events), true, `${name} must have a valid hash chain`);
    events.push(...scanned.events);
  }
  return events;
}
async function write(root: string, path: string, source: string): Promise<void> {
  const target = join(root, ...path.split('/'));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, source);
}
function git(root: string, args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

// ---------------------------------------------------------------------------
// Run lease lifecycle: acquire, heartbeat, expiry, reclaim, evidence credit
// ---------------------------------------------------------------------------

test('run lease heartbeat extends expiry; reclaim records reclaimed_from and clears evidence credit', async (t) => {
  const root = await rootFor(t, 'ano-p2-lease-');
  let clock = 1_000;
  const ledger = await Ledger.open(root, { sessionId: 'LEASE', actor: 'owner-a', clock: () => clock });
  try {
    await ledger.createTask('T1', ['src/a.ts'], 'Lease task');
    const first = await ledger.acquireRunLease('run-1', { owner: 'owner-a', ttlMs: 100, leaseId: 'lease-1', idemKey: 'lease-acquire-1' });
    assert.equal(first.duplicate, false);
    assert.equal(first.lease.status, 'active');
    assert.equal(first.lease.leaseId, 'lease-1');
    assert.equal(first.lease.producedEvidence, false);
    assert.equal(first.lease.expiresAt, 1_100);

    await assert.rejects(ledger.acquireRunLease('run-1', { leaseId: 'other' }), LeaseHeldError);
    assert.equal(ledger.getRunLease('run-1')?.leaseId, 'lease-1', 'a live lease must not be replaced');

    clock = 1_050;
    const beat = await ledger.heartbeatRunLease('run-1', 'lease-1', { ttlMs: 100, idemKey: 'lease-heartbeat-1' });
    assert.equal(beat.duplicate, false);
    assert.equal(beat.lease.expiresAt, 1_150, 'heartbeat must extend the expiry');
    assert.equal(beat.lease.heartbeatAt, 1_050);
    await assert.rejects(ledger.heartbeatRunLease('run-1', 'wrong-lease'), LeaseMismatchError);

    // Evidence written under the active lease is credited to it.
    await ledger.append({
      kind: 'evidence.recorded',
      payload: { task_id: 'T1', evidence: { id: 'lease-evidence-1', ok: true }, test_files: ['test/a.test.ts'], run_id: 'run-1', lease_id: 'lease-1' },
    }, 'lease-evidence-key-1');
    assert.equal(ledger.getRunLease('run-1')?.producedEvidence, true, 'active lease must own its evidence');

    clock = 1_200;
    await assert.rejects(ledger.heartbeatRunLease('run-1', 'lease-1', { ttlMs: 100 }), LeaseExpiredError);
    const reclaimed = await ledger.reclaimRunLease('run-1', { owner: 'owner-b', ttlMs: 200, leaseId: 'lease-2' });
    assert.equal(reclaimed.duplicate, false);
    assert.equal(reclaimed.lease.leaseId, 'lease-2');
    assert.equal(reclaimed.lease.reclaimedFrom, 'lease-1');
    assert.equal(reclaimed.lease.status, 'active');
    assert.equal(reclaimed.lease.producedEvidence, false, 'a reclaimed lease must not keep evidence credit');
    assert.equal(reclaimed.lease.expiresAt, 1_400);

    const events = await committedEvents(root);
    const reclaim = events.find((event) => event.kind === 'run.lease.reclaimed');
    assert.ok(reclaim);
    assert.equal(reclaim.payload.reclaimed_from, 'lease-1');
    assert.equal(reclaim.payload.produced_evidence, false);
    assert.equal(reclaim.payload.expired_at, 1_150);

    // Releasing makes the run available to a fresh acquire.
    await ledger.releaseRunLease('run-1', 'lease-2', { idemKey: 'lease-release-1' });
    assert.equal(ledger.getRunLease('run-1')?.status, 'released');
    const reacquired = await ledger.acquireRunLease('run-1', { owner: 'owner-c', leaseId: 'lease-3', ttlMs: 50 });
    assert.equal(reacquired.lease.leaseId, 'lease-3');
    assert.equal(reacquired.lease.reclaimedFrom, undefined);
    assert.equal(reacquired.lease.producedEvidence, false);
  } finally {
    ledger.close();
  }
});

test('acquire auto-reclaims an expired lease; retries with the same key append once', async (t) => {
  const root = await rootFor(t, 'ano-p2-lease-retry-');
  let clock = 10_000;
  const ledger = await Ledger.open(root, { sessionId: 'LEASE-RETRY', actor: 'a', clock: () => clock });
  try {
    const first = await ledger.acquireRunLease('run-crash', { ttlMs: 100, leaseId: 'crash-lease', idemKey: 'crash-acquire' });
    assert.equal(first.duplicate, false);
    // Retry after a process crash: the same key returns the committed lease and
    // must not append a second event even though the clock moved.
    clock = 99_999;
    const retry = await ledger.acquireRunLease('run-crash', { ttlMs: 100, leaseId: 'crash-lease', idemKey: 'crash-acquire' });
    assert.equal(retry.duplicate, true);
    assert.equal(retry.lease.leaseId, 'crash-lease');
    assert.equal((await committedEvents(root)).filter((event) => event.kind === 'run.lease.acquired' && event.payload.run_id === 'run-crash').length, 1);

    // A live retry must not let a different lease id reuse the same key.
    await assert.rejects(ledger.acquireRunLease('run-crash', { leaseId: 'different', idemKey: 'crash-acquire' }), IdempotencyConflictError);

    clock = 200_000;
    const auto = await ledger.acquireRunLease('run-crash', { ttlMs: 100, leaseId: 'crash-lease-2' });
    assert.equal(auto.duplicate, false);
    assert.equal(auto.lease.reclaimedFrom, 'crash-lease', 'acquire must reclaim an expired lease automatically');
    const reclaim = (await committedEvents(root)).find((event) => event.kind === 'run.lease.reclaimed');
    assert.ok(reclaim);
    assert.equal(reclaim.payload.produced_evidence, false);

    // A heartbeat retry with the same key returns the same lease state.
    const heartbeat = await ledger.heartbeatRunLease('run-crash', 'crash-lease-2', { ttlMs: 500, idemKey: 'crash-heartbeat' });
    assert.equal(heartbeat.duplicate, false);
    clock += 10;
    const heartbeatRetry = await ledger.heartbeatRunLease('run-crash', 'crash-lease-2', { ttlMs: 500, idemKey: 'crash-heartbeat' });
    assert.equal(heartbeatRetry.duplicate, true);
    assert.equal((await committedEvents(root)).filter((event) => event.kind === 'run.lease.heartbeat').length, 1);
  } finally {
    ledger.close();
  }
});

test('deleting the whole ledger directory removes tasks, evidence, leases and idempotency keys', async (t) => {
  const root = await rootFor(t, 'ano-p2-delete-ledger-');
  const ledger = await Ledger.open(root, { sessionId: 'DELETE', actor: 'delete', clock: () => 1_000 });
  await ledger.createTask('T1', ['src/a.ts'], 'Delete me', 'delete-key');
  await ledger.append({ kind: 'evidence.recorded', payload: { task_id: 'T1', evidence: { id: 'delete-evidence', ok: true }, test_files: ['test/a.test.ts'] } }, 'delete-evidence-key');
  await ledger.acquireRunLease('run-delete', { leaseId: 'delete-lease', ttlMs: 1_000 });
  ledger.close();

  await rm(ledgerDir(root), { recursive: true, force: true });
  const reopened = await Ledger.open(root, { sessionId: 'DELETE-NEW', actor: 'delete', clock: () => 2_000 });
  try {
    assert.deepEqual(reopened.getTasks(), []);
    assert.deepEqual(reopened.listEvidence(), []);
    assert.deepEqual(reopened.listRunLeases(), []);
    const recreated = await reopened.createTask('T1', ['src/a.ts'], 'Delete me', 'delete-key');
    assert.equal(recreated.duplicate, false, 'a deleted ledger must not keep its idempotency keys hot');
    const evidence = await reopened.append({ kind: 'evidence.recorded', payload: { task_id: 'T1', evidence: { id: 'delete-evidence', ok: true }, test_files: ['test/a.test.ts'] } }, 'delete-evidence-key');
    assert.equal(evidence.duplicate, false);
    assert.equal((await committedEvents(root)).filter((event) => event.kind === 'task.created').length, 1);
  } finally {
    reopened.close();
  }
});

// ---------------------------------------------------------------------------
// Input hygiene: empty title, tautological assertion, skip growth
// ---------------------------------------------------------------------------

test('empty or whitespace-only task titles and declared files are rejected', async (t) => {
  const root = await rootFor(t, 'ano-p2-title-');
  const ledger = await Ledger.open(root, { sessionId: 'TITLE', clock: () => 1_000 });
  try {
    await assert.rejects(ledger.createTask('T1', [], '   '), /title must be a non-empty string/);
    await assert.rejects(ledger.createTask('T1', [], ''), /title must be a non-empty string/);
    await assert.rejects(ledger.createTask('', []), /Task id and declared files must be non-empty/);
    await assert.rejects(ledger.createTask('T2', ['']), /Task id and declared files must be non-empty/);
    await assert.rejects(ledger.createTask('T3', [], 'x'.repeat(501)), /at most 500 characters/);
    assert.deepEqual(await segmentNames(root), [], 'rejected creation must not write a segment');
    const created = await ledger.createTask('T4', [], undefined);
    assert.equal(created.task.title, undefined);
  } finally {
    ledger.close();
  }
});

test('tautological assertions and skipped tests are recorded verbatim but never complete a task', async (t) => {
  const root = await rootFor(t, 'ano-p2-tautology-');
  await write(root, 'tautology.test.ts', "import test from 'node:test';import assert from 'node:assert/strict';test('always true', () => assert.ok(true));\n");
  await write(root, 'skipped.test.ts', "import test from 'node:test';test('skipped', { skip: 'not ready' }, () => {});\n");
  const tautology = await executeEvidence({ argv: [process.execPath, '--test', 'tautology.test.ts'], cwd: root, timeoutMs: 20_000 }, 'a'.repeat(64), 'graph');
  const skipped = await executeEvidence({ argv: [process.execPath, '--test', 'skipped.test.ts'], cwd: root, timeoutMs: 20_000 }, 'b'.repeat(64), 'graph');
  assert.equal(tautology.ok, true, 'a tautological test runs green at the process level');
  assert.deepEqual(tautology.counts, { tests: 1, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0 });
  assert.equal(skipped.ok, false, 'skips are not green evidence');
  assert.equal(skipped.counts.skipped, 1);

  const ledger = await Ledger.open(root, { sessionId: 'TAUTOLOGY', clock: () => 2_000 });
  try {
    await ledger.createTask('T1', ['tautology.test.ts'], 'Tautology');
    await ledger.append({ kind: 'evidence.recorded', payload: { task_id: 'T1', evidence: { ...tautology, tautological: true, assertions: 0 }, test_files: ['tautology.test.ts'] } }, 'tautology-evidence');
    await ledger.append({ kind: 'evidence.recorded', payload: { task_id: 'T1', evidence: { ...skipped, skip_growth: true }, test_files: ['skipped.test.ts'] } }, 'skip-evidence');
    assert.equal(ledger.getTask('T1')?.status, 'todo', 'the ledger records evidence, it does not infer completion');
    const records = ledger.listEvidence('T1');
    assert.equal(records.length, 2);
    const tautologyRecord = records.find((record) => record.evidence.id === tautology.id);
    const skipRecord = records.find((record) => record.evidence.id === skipped.id);
    assert.ok(tautologyRecord);
    assert.ok(skipRecord);
    assert.equal(tautologyRecord.evidence.tautological, true);
    assert.equal(tautologyRecord.evidence.assertions, 0);
    assert.deepEqual(skipRecord.evidence.counts, skipped.counts);
    assert.equal(skipRecord.evidence.skip_growth, true);
    assert.equal(records.some((record) => record.evidence.ok === true && record.evidence.assertions === 0), true, 'tautological evidence remains visible as a fact');
  } finally {
    ledger.close();
  }
});

// ---------------------------------------------------------------------------
// Ledger directory ignore and touched-file derivation
// ---------------------------------------------------------------------------

test('the ledger directory is git-ignored and never appears in touched files', async (t) => {
  const root = await rootFor(t, 'ano-p2-ignore-');
  assert.equal(spawnSync('git', ['--version'], { windowsHide: true }).status, 0, 'git is required for this test; it must not be skipped silently');
  await write(root, '.gitignore', '.ano/\n');
  await write(root, 'package.json', JSON.stringify({ private: true, type: 'module' }));
  await write(root, 'src/a.ts', 'export const a = 1;\n');
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'ano@localhost'], ['config', 'user.name', 'ano'], ['add', '.'], ['commit', '-qm', 'base']]) git(root, args);

  const ledger = await Ledger.open(root, { sessionId: 'IGNORE', clock: () => 3_000 });
  try {
    await ledger.createTask('T1', ['src/a.ts'], 'Ignored ledger');
    await ledger.append({ kind: 'evidence.recorded', payload: { task_id: 'T1', evidence: { id: 'ignore-evidence', ok: true }, test_files: ['test/a.test.ts'] } }, 'ignore-evidence');
    assert.deepEqual(ledger.getTouchedFiles(), [], 'ledger writes must not dirty the work tree');
    assert.equal(git(root, ['status', '--porcelain']).trim(), '', 'git status must be clean after ledger writes');
    await write(root, 'src/a.ts', 'export const a = 2;\n');
    assert.deepEqual(ledger.getTouchedFiles(), ['src/a.ts'], 'real changes are still reported');
    assert.equal(ledger.getTouchedFiles().some((path) => path.startsWith('.ano/')), false);
  } finally {
    ledger.close();
  }
  assert.equal(existsSync(join(root, '.ano', 'ledger')), true);
});

// ---------------------------------------------------------------------------
// Duplicate keys, crash retry, and explicit view-schema migration
// ---------------------------------------------------------------------------

test('duplicate keys stay single across instances, cache rebuilds and different event kinds', async (t) => {
  const root = await rootFor(t, 'ano-p2-duplicate-');
  const a = await Ledger.open(root, { sessionId: 'DUP-A', clock: () => 4_000 });
  const b = await Ledger.open(root, { sessionId: 'DUP-B', clock: () => 4_000 });
  try {
    const [one, two] = await Promise.all([
      a.append({ kind: 'task.created', payload: { task_id: 'T1', declared_files: ['src/a.ts'] } }, 'dup-key'),
      b.append({ kind: 'task.created', payload: { task_id: 'T1', declared_files: ['src/a.ts'] } }, 'dup-key'),
    ]);
    assert.notEqual(one.duplicate, two.duplicate, 'exactly one append must create the event');
    await assert.rejects(a.append({ kind: 'task.created', payload: { task_id: 'T1', declared_files: ['src/b.ts'] } }, 'dup-key'), IdempotencyConflictError);
    await assert.rejects(a.append({ kind: 'task.updated', payload: { task_id: 'T1', status: 'done' } }, 'dup-key'), IdempotencyConflictError);
  } finally {
    a.close();
    b.close();
  }
  assert.equal((await committedEvents(root)).filter((event) => event.kind === 'task.created').length, 1);

  await rm(join(root, '.ano', 'cache'), { recursive: true, force: true });
  const rebuilt = await Ledger.open(root, { sessionId: 'DUP-C', clock: () => 4_100 });
  try {
    const again = await rebuilt.append({ kind: 'task.created', payload: { declared_files: ['src/a.ts'], task_id: 'T1' } }, 'dup-key');
    assert.equal(again.duplicate, true, 'the rebuilt idempotency view must still dedupe');
    assert.equal(rebuilt.getTask('T1')?.id, 'T1');
  } finally {
    rebuilt.close();
  }
  assert.equal((await committedEvents(root)).filter((event) => event.kind === 'task.created').length, 1);
});

test('crash retry truncates an uncommitted own tail and commits the key exactly once', async (t) => {
  const root = await rootFor(t, 'ano-p2-crash-');
  const first = await Ledger.open(root, { sessionId: 'CRASH', clock: () => 5_000 });
  await first.append({ kind: 'task.created', payload: { task_id: 'T1', declared_files: ['src/a.ts'] } }, 'crash-key');
  const segment = first.segmentPath;
  first.close();

  const valid = await readFile(segment);
  await writeFile(segment, Buffer.concat([valid, Buffer.from('{"record":"batch.begin","batch_id":"partial","event_count":2}\n{"id":"')]));
  const crashed = await Ledger.open(root, { sessionId: 'CRASH', clock: () => 5_100 });
  try {
    assert.deepEqual(await readFile(segment), valid, 'the owner must truncate its own uncommitted tail on recovery');
    const retry = await crashed.append({ kind: 'task.created', payload: { task_id: 'T1', declared_files: ['src/a.ts'] } }, 'crash-key');
    assert.equal(retry.duplicate, true, 'a retry after crash must not append a second event');
    assert.equal(crashed.getTask('T1')?.id, 'T1');
  } finally {
    crashed.close();
  }

  const reopened = await Ledger.open(root, { sessionId: 'CRASH-NEW', clock: () => 5_200 });
  try {
    const afterRestart = await reopened.append({ kind: 'task.created', payload: { task_id: 'T1', declared_files: ['src/a.ts'] } }, 'crash-key');
    assert.equal(afterRestart.duplicate, true);
    assert.equal(reopened.getTasks().length, 1);
  } finally {
    reopened.close();
  }
  const events = await committedEvents(root);
  assert.equal(events.filter((event) => event.kind === 'task.created').length, 1);
  assert.equal(events.filter((event) => event.kind === 'segment.started').length, 1);
});

test('an older views schema is rebuilt from segments when the run-lease table appears', async (t) => {
  const root = await rootFor(t, 'ano-p2-schema-');
  const ledger = await Ledger.open(root, { sessionId: 'SCHEMA', clock: () => 6_000 });
  await ledger.createTask('T1', ['src/a.ts'], 'Schema');
  await ledger.append({ kind: 'evidence.recorded', payload: { task_id: 'T1', evidence: { id: 'schema-evidence', ok: true }, test_files: ['test/a.test.ts'] } }, 'schema-evidence');
  ledger.close();

  const viewsPath = join(root, '.ano', 'cache', 'views.db');
  const db = new DatabaseSync(viewsPath);
  try {
    db.exec('DROP TABLE run_leases');
    db.exec('PRAGMA user_version = 2');
  } finally {
    db.close();
  }

  const migrated = await Ledger.open(root, { sessionId: 'SCHEMA-NEW', clock: () => 6_100 });
  try {
    assert.equal(migrated.getTask('T1')?.title, 'Schema');
    assert.equal(migrated.listEvidence('T1').length, 1);
    const versionDb = new DatabaseSync(viewsPath);
    try {
      assert.equal(Number((versionDb.prepare('PRAGMA user_version').get() as { user_version: number }).user_version), VIEW_SCHEMA_VERSION);
      assert.equal((versionDb.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'run_leases'").get() as { n: number }).n, 1);
    } finally {
      versionDb.close();
    }
  } finally {
    migrated.close();
  }
});

test('a lease mismatch or integrity breach is rejected without appending', async (t) => {
  const root = await rootFor(t, 'ano-p2-integrity-');
  const ledger = await Ledger.open(root, { sessionId: 'INTEGRITY', clock: () => 7_000 });
  try {
    const lease = await ledger.acquireRunLease('run-int', { leaseId: 'int-lease', ttlMs: 1_000 });
    await assert.rejects(ledger.heartbeatRunLease('run-int', 'not-ours'), LeaseMismatchError);
    await assert.rejects(ledger.releaseRunLease('run-int', 'not-ours'), LeaseMismatchError);
    await ledger.createTask('T1', []);
    const before = await committedEvents(root);
    // Evidence must not claim a lease that does not exist for the run.
    await assert.rejects(
      ledger.append({ kind: 'evidence.recorded', payload: { task_id: 'T1', evidence: { id: 'bad-lease-evidence', ok: true }, test_files: [], run_id: 'run-int', lease_id: 'forged' } }, 'bad-lease-evidence'),
      LedgerIntegrityError,
    );
    assert.deepEqual(await committedEvents(root), before, 'a rejected evidence event must not be committed');
    assert.equal(ledger.listEvidence('T1').length, 0);
    assert.equal(lease.lease.leaseId, 'int-lease');
  } finally {
    ledger.close();
  }
});

// ---------------------------------------------------------------------------
// Real multi-process concurrency (not Promise.all in one instance)
// ---------------------------------------------------------------------------

test('real worker processes write without lost events or duplicate idempotency keys', async (t) => {
  const outputRoot = await rootFor(t, 'ano-p2-bench-output-');
  const output = join(outputRoot, 'p2-concurrency-test.json');
  const result = await runConcurrencyBench({ workers: 6, uniquePerWorker: 2, sharedTasks: 2, output, workerTimeoutMs: 180_000 });
  assert.equal(result.verdict, 'pass', result.failures.join('\n'));
  assert.equal(result.segments, 6);
  assert.equal(result.kinds['task.created'], 2 + 6 * 2);
  assert.equal(result.kinds['evidence.recorded'], 6 * 2);
  assert.equal(result.kinds['run.lease.acquired'], 7);
  assert.equal(result.idempotency.duplicated.length, 0);
  assert.equal(result.ledger.tasks, 14);
  assert.equal(result.ledger.evidence, 12);
  assert.equal(result.ledger.sharedLeaseStatus, 'active');
  const written = JSON.parse(await readFile(output, 'utf8')) as { verdict: string };
  assert.equal(written.verdict, 'pass');
  assert.ok(output.startsWith(outputRoot), 'the test must write its bench output under the temp root');
});

test('parseSegment still accepts the events produced by the full ledger test run', async (t) => {
  const root = await rootFor(t, 'ano-p2-parse-');
  const ledger = await Ledger.open(root, { sessionId: 'PARSE', clock: () => 8_000 });
  await ledger.createTask('T1', [], 'Parse');
  await ledger.acquireRunLease('run-parse', { leaseId: 'parse-lease' });
  ledger.close();
  for (const name of await segmentNames(root)) {
    const parsed = parseSegment(await readFile(join(ledgerDir(root), name)));
    assert.equal(parsed.errors.length, 0, `${name}: ${parsed.errors.join('; ')}`);
    assert.equal(parsed.ignoredTail, false);
  }
});
