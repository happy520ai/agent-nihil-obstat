import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { withFileLockSync } from '../../src/core/lock.ts';
import { compareHlc } from '../../src/core/hlc.ts';
import { scanSegment } from '../../src/ledger/append.ts';
import { eventChain, type LedgerEvent } from '../../src/ledger/event.ts';
import { IdempotencyConflictError, Ledger, LedgerIntegrityError } from '../../src/ledger/ledger.ts';
import { parseSegment } from '../../src/ledger/segment.ts';
import { completeTaskViaGate, recordGateEvidence } from '../helpers/gate-complete.ts';

async function rootFor(t: TestContext, prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function ledgerDir(root: string): string { return join(root, '.ano', 'ledger'); }

async function segmentFiles(root: string): Promise<string[]> {
  const names = await readdir(ledgerDir(root)).catch(() => [] as string[]);
  return names.filter((name) => name.endsWith('.jsonl')).sort();
}

async function readAll(root: string): Promise<string> {
  let text = '';
  for (const name of await segmentFiles(root)) text += await readFile(join(ledgerDir(root), name), 'utf8');
  return text;
}

async function committedEvents(root: string): Promise<LedgerEvent[]> {
  const events: LedgerEvent[] = [];
  for (const name of await segmentFiles(root)) events.push(...scanSegment(await readFile(join(ledgerDir(root), name))).events);
  return events;
}

function viewsDb(root: string): DatabaseSync {
  const db = new DatabaseSync(join(root, '.ano', 'cache', 'views.db'));
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

function toCrlf(text: string): string { return text.replaceAll('\n', '\r\n'); }

// ---------------------------------------------------------------------------
// 1. cross-segment HLC merge and view rebuild order
// ---------------------------------------------------------------------------

test('a later writer with a regressed clock still wins across segments', async (t) => {
  const root = await rootFor(t, 'ano-hard-hlc-');
  const first = await Ledger.open(root, { sessionId: 'HLC_A', actor: 'SAME', clock: () => 9000 });
  await first.createTask('T', ['src/a.ts'], 'HLC');
  await completeTaskViaGate(root, first, 'T');
  first.close();

  // Same actor, wall clock jumped backwards. Without merging the observed HLC
  // during replay this write would sort before the 'done' event.
  const second = await Ledger.open(root, { sessionId: 'HLC_B', actor: 'SAME', clock: () => 5 });
  await second.updateTask('T', { status: 'cancelled' });
  second.close();

  const updates = (await committedEvents(root)).filter((event) => event.kind === 'task.updated');
  assert.equal(updates.length, 2);
  const cancelledWrite = updates.find((event) => event.payload.status === 'cancelled');
  assert.ok(cancelledWrite, 'the regressed-clock write must be committed');
  assert.ok(cancelledWrite.hlc.physical >= 9000, 'observed HLC must be merged before ticking');
  const doneWrite = updates.find((event) => event.payload.status === 'done')!;
  assert.ok(compareHlc(cancelledWrite.hlc, doneWrite.hlc) > 0, 'the later write must sort after the earlier one');

  const reopened = await Ledger.open(root, { sessionId: 'HLC_C', clock: () => 1 });
  assert.equal(reopened.getTask('T')?.status, 'cancelled');
  reopened.close();

  // Rebuilding the view from scratch must agree with the incremental view.
  await rm(join(root, '.ano', 'cache'), { recursive: true, force: true });
  const rebuilt = await Ledger.open(root, { sessionId: 'HLC_D', clock: () => 1 });
  assert.equal(rebuilt.getTask('T')?.status, 'cancelled');
  rebuilt.close();
});

test('same-millisecond same-actor writes stay strictly ordered for the rebuild', async (t) => {
  const root = await rootFor(t, 'ano-hard-hlc-tie-');
  const a = await Ledger.open(root, { sessionId: 'TIE_A', actor: 'SAME', clock: () => 7100 });
  const b = await Ledger.open(root, { sessionId: 'TIE_B', actor: 'SAME', clock: () => 7100 });
  await a.createTask('T', ['src/a.ts']);
  const gate = await recordGateEvidence(root, a, 'T');
  await Promise.all([
    a.updateTask('T', { status: 'done', verdict: gate.verdict }),
    b.updateTask('T', { status: 'cancelled' }),
  ]);
  a.close();
  b.close();

  const updates = (await committedEvents(root)).filter((event) => event.kind === 'task.updated');
  assert.equal(updates.length, 2);
  // The views lock serializes appends, so each actor's logical counter advances.
  assert.equal(new Set(updates.map((event) => `${event.hlc.physical}:${event.hlc.logical}`)).size, 2, 'concurrent same-ms writes must not tie');
  const greatest = [...updates].sort((left, right) => compareHlc(left.hlc, right.hlc)).at(-1)!;
  assert.equal(typeof greatest.payload.status, 'string');

  const fresh = await Ledger.open(root, { sessionId: 'TIE_FRESH', clock: () => 7100 });
  assert.equal(fresh.getTask('T')?.status, greatest.payload.status as string, 'rebuilt view must match the greatest HLC writer');
  fresh.close();
});

// ---------------------------------------------------------------------------
// 2. lock ownership
// ---------------------------------------------------------------------------

test('a lock owned by a live pid is never reclaimed, and no side effect runs', async (t) => {
  const root = await rootFor(t, 'ano-hard-lock-live-');
  const path = join(root, 'mutex');
  const held = JSON.stringify({ lease: 'a', pid: process.pid, startedAt: 0 });
  writeFileSync(path, held);
  let calls = 0;
  assert.throws(() => withFileLockSync(path, () => { calls += 1; }, { timeoutMs: 60, staleAfterMs: 1 }), /Timed out acquiring lock/);
  assert.equal(calls, 0);
  assert.equal(await readFile(path, 'utf8'), held);
});

test('a stale lock from a dead pid is reclaimed so the next writer proceeds', async (t) => {
  const root = await rootFor(t, 'ano-hard-lock-dead-');
  const path = join(root, 'mutex');
  const child = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
  assert.equal(child.status, 0);
  assert.throws(() => process.kill(child.pid, 0), 'the child pid must be reaped before the test');
  writeFileSync(path, JSON.stringify({ lease: 'b', pid: child.pid, startedAt: Date.now() - 60_000 }));

  const value = withFileLockSync(path, () => 'acquired', { timeoutMs: 5_000, staleAfterMs: 1 });
  assert.equal(value, 'acquired');
  assert.equal(existsSync(path), false, 'the new owner releases its own lease');
});

test('releasing a lease never deletes a lock that changed ownership', async (t) => {
  const root = await rootFor(t, 'ano-hard-lock-token-');
  const path = join(root, 'mutex');
  withFileLockSync(path, () => {
    writeFileSync(path, JSON.stringify({ token: 'thief', pid: process.pid, startedAt: Date.now() }));
  }, { timeoutMs: 1_000 });
  const after = JSON.parse(await readFile(path, 'utf8')) as { token?: string };
  assert.equal(after.token, 'thief', 'the foreign lock must survive our release');
  assert.throws(() => withFileLockSync(path, () => undefined, { timeoutMs: 60, staleAfterMs: 1 }), /Timed out acquiring lock/);
});

test('an operation that fails with EEXIST is reported once, not retried', async (t) => {
  const root = await rootFor(t, 'ano-hard-lock-eexist-');
  const path = join(root, 'mutex');
  const sideEffects: number[] = [];
  assert.throws(() => withFileLockSync(path, () => {
    sideEffects.push(sideEffects.length);
    const error = new Error('duplicate key from the operation itself') as NodeJS.ErrnoException;
    error.code = 'EEXIST';
    throw error;
  }), /duplicate key from the operation itself/);
  assert.equal(sideEffects.length, 1, 'EEXIST from the operation must not be treated as lock contention');
  assert.equal(existsSync(path), false, 'the lease is still released on failure');
});

// ---------------------------------------------------------------------------
// 3. CRLF-normalized committed data
// ---------------------------------------------------------------------------

test('a CRLF checkout of a segment parses and validates like its LF form', async (t) => {
  const root = await rootFor(t, 'ano-hard-crlf-');
  const ledger = await Ledger.open(root, { sessionId: 'CRLF', actor: 'CRLF', clock: () => 21000 });
  await ledger.createTask('T1', ['src/a.ts'], 'CRLF task');
  await completeTaskViaGate(root, ledger, 'T1');
  const evidence = { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', ok: true };
  await ledger.append({ kind: 'evidence.recorded', payload: { task_id: 'T1', evidence, test_files: ['test/crlf.test.ts'] } }, 'ev-crlf');
  ledger.close();

  const name = (await segmentFiles(root))[0]!;
  const path = join(ledgerDir(root), name);
  const lf = await readFile(path);
  const lfScanned = scanSegment(lf);
  assert.equal(lfScanned.ignoredTail, false);
  assert.equal(lfScanned.events.length, 5);

  const crlf = Buffer.from(toCrlf(lf.toString('utf8')), 'utf8');
  const crlfScanned = scanSegment(crlf);
  assert.deepEqual(crlfScanned.events, lfScanned.events, 'CRLF and LF must yield identical committed events');
  assert.equal(crlfScanned.ignoredTail, false, 'CRLF bytes must still count as committed');
  assert.equal(crlfScanned.committedBytes, crlf.length, 'committedBytes must be raw byte offsets');
  assert.deepEqual(parseSegment(crlf).events, parseSegment(lf).events);
  assert.equal(parseSegment(crlf).errors.length, 0);
  assert.equal(eventChain(crlfScanned.events), true);

  await writeFile(path, crlf);
  const reopened = await Ledger.open(root, { sessionId: 'CRLF', actor: 'CRLF', clock: () => 21001 });
  assert.equal(reopened.getTask('T1')?.status, 'done');
  assert.equal(reopened.getEvidence(evidence.id)?.taskId, 'T1');
  assert.deepEqual(await readFile(path), crlf, 'reading a CRLF segment must not rewrite it');

  // Mixed endings after the next append still replay cleanly.
  await reopened.updateTask('T1', { status: 'in_progress' });
  reopened.close();
  const mixed = await Ledger.open(root, { sessionId: 'CRLF_MIXED', clock: () => 21002 });
  assert.equal(mixed.getTask('T1')?.status, 'in_progress');
  assert.equal(mixed.listEvidence('T1').length, 2);
  mixed.close();
});

test('CRLF normalization does not weaken tamper detection', async (t) => {
  const root = await rootFor(t, 'ano-hard-crlf-tamper-');
  const ledger = await Ledger.open(root, { sessionId: 'TAMPER', actor: 'TAMPER', clock: () => 22000 });
  await ledger.createTask('T1', ['src/a.ts'], 'Tamper');
  ledger.close();

  const name = (await segmentFiles(root))[0]!;
  const path = join(ledgerDir(root), name);
  const crlf = toCrlf(await readFile(path, 'utf8'));
  const lines = crlf.split('\r\n').filter((line) => line.length > 0);
  const index = lines.findIndex((line) => line.includes('"kind":"task.created"'));
  assert.ok(index >= 0);
  const event = JSON.parse(lines[index]!) as Record<string, unknown>;
  event.payload = { task_id: 'T1', declared_files: ['tampered.ts'] };
  lines[index] = JSON.stringify(event);
  const tampered = `${lines.join('\r\n')}\r\n`;
  assert.notEqual(tampered, crlf);
  await writeFile(path, tampered);

  assert.throws(() => scanSegment(Buffer.from(tampered, 'utf8')), LedgerIntegrityError);
  await assert.rejects(Ledger.open(root, { sessionId: 'TAMPER', clock: () => 22001 }), (error: unknown) => {
    assert.ok(error instanceof LedgerIntegrityError, `expected integrity error, got ${String(error)}`);
    assert.match(error.message, /checksum mismatch|Invalid hash chain/);
    return true;
  });

  // Rewriting the original content as CRLF again is accepted: only the byte
  // form changed, not the committed data.
  await writeFile(path, crlf);
  const restored = await Ledger.open(root, { sessionId: 'TAMPER_OK', clock: () => 22002 });
  assert.equal(restored.getTask('T1')?.title, 'Tamper');
  restored.close();
});

// ---------------------------------------------------------------------------
// 4. deleted segments must not leave ghosts in views.db
// ---------------------------------------------------------------------------

test('deleting the only segment drops ghost tasks, evidence and idempotency keys', async (t) => {
  const root = await rootFor(t, 'ano-hard-ghost-');
  const ledger = await Ledger.open(root, { sessionId: 'GHOST', actor: 'GHOST', clock: () => 30000 });
  const evidence = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ok: true };
  await ledger.createTask('G1', ['src/a.ts'], 'Ghost', 'ghost-create');
  await ledger.append({ kind: 'evidence.recorded', payload: { task_id: 'G1', evidence, test_files: ['test/ghost.test.ts'] } }, 'ghost-evidence');
  const segment = ledger.segmentPath;
  ledger.close();

  // Prove the ghosts really were materialized before deleting the log.
  const before = viewsDb(root);
  try {
    assert.equal((before.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n, 1);
    assert.equal((before.prepare('SELECT COUNT(*) AS n FROM evidence').get() as { n: number }).n, 1);
    assert.equal((before.prepare('SELECT COUNT(*) AS n FROM idempotency').get() as { n: number }).n, 2);
  } finally { before.close(); }

  await rm(segment);
  const reopened = await Ledger.open(root, { sessionId: 'GHOST_NEW', actor: 'GHOST_NEW', clock: () => 30001 });
  assert.deepEqual(reopened.getTasks(), []);
  assert.equal(reopened.getTask('G1'), undefined);
  assert.equal(reopened.getEvidence(evidence.id), undefined);
  assert.deepEqual(reopened.listEvidence('G1'), []);

  const recreated = await reopened.createTask('G1', ['src/a.ts'], 'Ghost', 'ghost-create');
  assert.equal(recreated.duplicate, false, 'a deleted segment must not keep its idempotency key hot');
  const reEvidence = await reopened.append({ kind: 'evidence.recorded', payload: { task_id: 'G1', evidence, test_files: ['test/ghost.test.ts'] } }, 'ghost-evidence');
  assert.equal(reEvidence.duplicate, false);

  const after = viewsDb(root);
  try {
    const keys = (after.prepare('SELECT idem_key FROM idempotency ORDER BY idem_key').all() as { idem_key: string }[]).map((row) => row.idem_key);
    assert.deepEqual(keys, ['ghost-create', 'ghost-evidence']);
    assert.equal((after.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n, 3, 'events of the deleted segment must be gone');
  } finally { after.close(); }
  reopened.close();

  const fresh = await Ledger.open(root, { sessionId: 'GHOST_FRESH', clock: () => 30002 });
  assert.deepEqual(fresh.getTasks().map((task) => task.id), ['G1']);
  assert.equal(fresh.listEvidence('G1').length, 1);
  fresh.close();
});

test('a segment with a single append is also dropped without leaving a hot key', async (t) => {
  // Regression: the first append stores its rows incrementally while the
  // replay digest still describes an empty log, so deleting that one segment
  // used to leave a "digest matches" empty cache with a live idempotency key.
  const root = await rootFor(t, 'ano-hard-ghost-single-');
  const ledger = await Ledger.open(root, { sessionId: 'SINGLE', clock: () => 32000 });
  await ledger.createTask('ONLY', ['src/only.ts'], 'Only');
  const segment = ledger.segmentPath;
  ledger.close();

  await rm(segment);
  const reopened = await Ledger.open(root, { sessionId: 'SINGLE_NEW', clock: () => 32001 });
  assert.deepEqual(reopened.getTasks(), []);
  const recreated = await reopened.createTask('ONLY', ['src/only.ts'], 'Only');
  assert.equal(recreated.duplicate, false);
  reopened.close();
});

test('an externally deleted segment is not served from a warm cache on the next write', async (t) => {
  const root = await rootFor(t, 'ano-hard-ghost-warm-');
  const ledger = await Ledger.open(root, { sessionId: 'WARM', clock: () => 33000 });
  await ledger.createTask('WARM', ['src/w.ts']);
  await rm(ledger.segmentPath);

  // The open handle still holds the old rows; the next write must reconcile
  // with the files instead of treating the cached task as an existing one.
  const recreated = await ledger.createTask('WARM', ['src/w.ts']);
  assert.equal(recreated.duplicate, false);
  assert.deepEqual(ledger.getTasks().map((task) => task.id), ['WARM']);
  ledger.close();
});

test('deleting an observed segment fails closed instead of serving a smaller history', async (t) => {
  const root = await rootFor(t, 'ano-hard-ghost-multi-');
  const first = await Ledger.open(root, { sessionId: 'DEL_A', clock: () => 31000 });
  await first.createTask('T1', ['src/a.ts'], 'First', 'key-a');
  const victim = first.segmentPath;
  first.close();
  const second = await Ledger.open(root, { sessionId: 'DEL_B', clock: () => 31001 });
  await second.createTask('T2', ['src/b.ts'], undefined, 'key-b');
  const survivorPath = second.segmentPath;
  second.close();

  await rm(victim);

  // DEL_B's header observed DEL_A's head. Losing that segment means the
  // remaining history is incomplete, so replay refuses to open rather than
  // silently reporting only T2.
  await assert.rejects(
    Ledger.open(root, { sessionId: 'DEL_C', clock: () => 31002 }),
    /degraded: observed segment/,
  );
  const scanned = scanSegment(await readFile(survivorPath));
  assert.equal(scanned.ignoredTail, false);
  assert.ok(scanned.events.some((event) => event.kind === 'task.created' && event.payload.task_id === 'T2'));
  assert.ok(!scanned.events.some((event) => event.payload.task_id === 'T1'));
});

// ---------------------------------------------------------------------------
// 5. createTask check-then-append races
// ---------------------------------------------------------------------------

test('concurrent createTask for the same id and key appends exactly one event', async (t) => {
  const root = await rootFor(t, 'ano-hard-race-same-key-');
  const a = await Ledger.open(root, { sessionId: 'RACE_A', clock: () => 40000 });
  const b = await Ledger.open(root, { sessionId: 'RACE_B', clock: () => 40000 });
  const [first, second] = await Promise.all([
    a.createTask('T1', ['src/a.ts'], 'Race', 'shared-key'),
    b.createTask('T1', ['src/a.ts'], 'Race', 'shared-key'),
  ]);
  assert.notEqual(first.duplicate, second.duplicate, 'exactly one call must be the real creation');
  assert.equal(first.task.id, 'T1');
  assert.equal(second.task.id, 'T1');
  assert.deepEqual(first.task, second.task);
  a.close();
  b.close();

  const created = (await committedEvents(root)).filter((event) => event.kind === 'task.created');
  assert.equal(created.length, 1);
  const fresh = await Ledger.open(root, { sessionId: 'RACE_FRESH', clock: () => 40001 });
  assert.deepEqual(fresh.getTasks().map((task) => task.id), ['T1']);
  fresh.close();
});

test('concurrent createTask for the same id and different keys is a duplicate, not an integrity error', async (t) => {
  const root = await rootFor(t, 'ano-hard-race-diff-key-');
  const a = await Ledger.open(root, { sessionId: 'DK_A', clock: () => 41000 });
  const b = await Ledger.open(root, { sessionId: 'DK_B', clock: () => 41000 });
  const settled = await Promise.allSettled([
    a.createTask('T1', ['src/a.ts'], 'Race', 'key-one'),
    b.createTask('T1', ['src/a.ts'], 'Race', 'key-two'),
  ]);
  a.close();
  b.close();

  for (const outcome of settled) {
    assert.equal(outcome.status, 'fulfilled', `unexpected rejection: ${outcome.status === 'rejected' ? String(outcome.reason) : ''}`);
  }
  const results = settled as PromiseFulfilledResult<Awaited<ReturnType<Ledger['createTask']>>>[];
  assert.notEqual(results[0]!.value.duplicate, results[1]!.value.duplicate);
  assert.equal((await committedEvents(root)).filter((event) => event.kind === 'task.created').length, 1);

  const fresh = await Ledger.open(root, { sessionId: 'DK_FRESH', clock: () => 41001 });
  assert.deepEqual(fresh.getTasks().map((task) => task.id), ['T1']);
  // Both keys now alias the single creation event, so neither replays.
  const replayOne = await fresh.createTask('T1', ['src/a.ts'], 'Race', 'key-one');
  assert.equal(replayOne.duplicate, true);
  const replayTwo = await fresh.createTask('T1', ['src/a.ts'], 'Race', 'key-two');
  assert.equal(replayTwo.duplicate, true);
  fresh.close();
});

test('concurrent createTask for the same id with different parameters conflicts cleanly', async (t) => {
  const root = await rootFor(t, 'ano-hard-race-conflict-');
  const a = await Ledger.open(root, { sessionId: 'CF_A', clock: () => 42000 });
  const b = await Ledger.open(root, { sessionId: 'CF_B', clock: () => 42000 });
  const settled = await Promise.allSettled([
    a.createTask('T1', ['src/a.ts'], 'Conflict', 'cf-one'),
    b.createTask('T1', ['src/different.ts'], 'Conflict', 'cf-two'),
  ]);
  a.close();
  b.close();

  const fulfilled = settled.filter((outcome) => outcome.status === 'fulfilled');
  const rejected = settled.filter((outcome) => outcome.status === 'rejected') as PromiseRejectedResult[];
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0]!.reason instanceof IdempotencyConflictError, `expected IdempotencyConflictError, got ${String(rejected[0]!.reason)}`);
  assert.equal((await committedEvents(root)).filter((event) => event.kind === 'task.created').length, 1);
});

test('concurrent createTask for different ids both persist', async (t) => {
  const root = await rootFor(t, 'ano-hard-race-distinct-');
  const a = await Ledger.open(root, { sessionId: 'DI_A', clock: () => 43000 });
  const b = await Ledger.open(root, { sessionId: 'DI_B', clock: () => 43000 });
  const [first, second] = await Promise.all([
    a.createTask('T1', ['src/a.ts'], 'One', 'di-key-one'),
    b.createTask('T2', ['src/b.ts'], 'Two', 'di-key-two'),
  ]);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, false);
  a.close();
  b.close();

  const fresh = await Ledger.open(root, { sessionId: 'DI_FRESH', clock: () => 43001 });
  assert.deepEqual(fresh.getTasks().map((task) => task.id).sort(), ['T1', 'T2']);
  // One key across two different creations is a real conflict.
  await assert.rejects(fresh.createTask('T3', ['src/c.ts'], 'Three', 'di-key-one'), IdempotencyConflictError);
  fresh.close();
});

// ---------------------------------------------------------------------------
// 6. closed handle behaviour and 7. evidence for an unknown task
// ---------------------------------------------------------------------------

test('reads on a fresh ledger return empty, reads after close throw like writes', async (t) => {
  const root = await rootFor(t, 'ano-hard-close-');
  const ledger = await Ledger.open(root, { sessionId: 'CLOSED', clock: () => 50000 });
  assert.deepEqual(ledger.getTasks(), []);
  assert.equal(ledger.getTask('T1'), undefined);
  assert.equal(ledger.getEvidence('missing'), undefined);
  assert.deepEqual(ledger.listEvidence('T1'), []);

  const evidence = { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', ok: true };
  await ledger.createTask('T1', ['src/a.ts'], 'Close');
  await ledger.append({ kind: 'evidence.recorded', payload: { task_id: 'T1', evidence, test_files: ['test/close.test.ts'] } }, 'close-ev');
  ledger.close();

  assert.throws(() => ledger.getTask('T1'), /Ledger is closed/);
  assert.throws(() => ledger.getTasks(), /Ledger is closed/);
  assert.throws(() => ledger.getEvidence(evidence.id), /Ledger is closed/);
  assert.throws(() => ledger.listEvidence('T1'), /Ledger is closed/);
  await assert.rejects(ledger.append({ kind: 'task.updated', payload: { task_id: 'T1', status: 'done' } }, 'after-close'), /Ledger is closed/);
  await assert.rejects(ledger.createTask('T2', ['src/b.ts']), /Ledger is closed/);
  await assert.rejects(ledger.updateTask('T1', { status: 'done' }), /Ledger is closed/);
  const text = await readAll(root);
  assert.equal(text.split('\n').filter((line) => line.includes('"kind":"task.updated"')).length, 0);

  const reopened = await Ledger.open(root, { sessionId: 'CLOSED', clock: () => 50001 });
  assert.equal(reopened.getTask('T1')?.status, 'todo');
  reopened.close();
});

test('evidence for an unknown task is rejected before anything is committed', async (t) => {
  const root = await rootFor(t, 'ano-hard-evidence-task-');
  const ledger = await Ledger.open(root, { sessionId: 'EV', actor: 'EV', clock: () => 51000 });
  const evidence = { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', ok: true };
  await assert.rejects(
    ledger.append({ kind: 'evidence.recorded', payload: { task_id: 'NOPE', evidence, test_files: ['test/ev.test.ts'] } }, 'orphan-evidence'),
    (error: unknown) => {
      assert.ok(error instanceof LedgerIntegrityError, `expected LedgerIntegrityError, got ${String(error)}`);
      assert.match(error.message, /Evidence for unknown task NOPE/);
      return true;
    },
  );
  assert.deepEqual(await segmentFiles(root), [], 'a rejected append must not leave a segment behind');
  assert.deepEqual(ledger.getTasks(), []);
  assert.deepEqual(ledger.listEvidence('NOPE'), []);

  await ledger.createTask('LATER', ['src/a.ts']);
  const retried = await ledger.append({ kind: 'evidence.recorded', payload: { task_id: 'LATER', evidence, test_files: ['test/ev.test.ts'] } }, 'orphan-evidence');
  assert.equal(retried.duplicate, false, 'the rejected attempt must not reserve the idempotency key');
  assert.equal(ledger.listEvidence('LATER').length, 1);
  ledger.close();

  const fresh = await Ledger.open(root, { sessionId: 'EV_FRESH', clock: () => 51001 });
  assert.equal(fresh.getEvidence(evidence.id)?.taskId, 'LATER');
  assert.equal((await committedEvents(root)).filter((event) => event.kind === 'evidence.recorded').length, 1);
  fresh.close();
});
