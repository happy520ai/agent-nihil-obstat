import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { canonicalJson } from '../../src/connect/canonical.ts';
import { ConnectSourceError, ConnectTamperError } from '../../src/connect/errors.ts';
import { resolveRoot } from '../../src/connect/paths.ts';
import {
  computePolicyStateHash,
  computeTransactionEntryHash,
  createAuthorization,
  createPolicy,
  type CreateAuthorizationInput,
  type CreatePolicyInput,
  type TakeoverAuthorization,
  type TakeoverPolicy,
} from '../../src/connect/takeover-policy.ts';
import {
  TakeoverStore,
  appendTransaction,
  applyStateTransition,
  authorizationPath,
  computeTransactionId,
  defaultTakeoverIo,
  loadAuthorization,
  loadPolicy,
  loadState,
  policyPath,
  readTransactions,
  saveAuthorization,
  savePolicy,
  takeoverDir,
  transactionsPath,
} from '../../src/connect/takeover-store.ts';

const GRANTED_AT = '2026-11-22T00:00:00.000Z';
const HASH_A = 'a'.repeat(64);
const KEY = {
  authorizationId: '1'.repeat(64),
  sourceDigest: '2'.repeat(64),
  backupHash: '3'.repeat(64),
};

async function makeRoot(t: TestContext): Promise<string> {
  const root = resolveRoot(await mkdtemp(join(tmpdir(), 'ano-takeover-store-')));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

function authFor(root: string, overrides: Partial<CreateAuthorizationInput> = {}): TakeoverAuthorization {
  return createAuthorization({
    root,
    projectId: 'proj-1',
    projectKey: 'key-1',
    scope: ['tasks', 'memory'],
    grantedBy: 'Alice',
    role: 'owner',
    statement: 'I explicitly authorize ANO takeover of this project.',
    grantedAt: GRANTED_AT,
    ...overrides,
  });
}

function policyFor(root: string, overrides: Partial<CreatePolicyInput> = {}): TakeoverPolicy {
  return createPolicy({
    root,
    projectId: 'proj-1',
    projectKey: 'key-1',
    authorization: authFor(root),
    updatedAt: GRANTED_AT,
    ...overrides,
  });
}

test('policy roundtrips through the atomic document store', async (t) => {
  const root = await makeRoot(t);
  assert.equal(loadPolicy(root), null, 'absence is not corruption');

  const doc = policyFor(root);
  savePolicy(root, doc);
  assert.deepEqual(loadPolicy(root), doc);
  assert.equal(loadState(root).state, 'disabled');

  const parsed = JSON.parse(readFileSync(policyPath(root), 'utf8')) as Record<string, unknown>;
  assert.equal(parsed['schema'], 'ano.takeover-policy/1');
});

test('corrupt or foreign policy documents fail closed and are never reset', async (t) => {
  const root = await makeRoot(t);
  const good = policyFor(root);
  savePolicy(root, good);

  const cases: Array<[string, string]> = [
    ['truncated json', '{"schema":'],
    ['wrong magic', JSON.stringify({ ...good, schema: 'ano.takeover-policy/2' })],
    ['unknown field', JSON.stringify({ ...good, surprise: true })],
    ['unknown version', JSON.stringify({ ...good, schemaVersion: 2 })],
  ];
  for (const [label, contents] of cases) {
    const before = Buffer.from(contents, 'utf8');
    await writeFile(policyPath(root), contents);
    assert.throws(() => loadPolicy(root), ConnectTamperError, label);
    assert.deepEqual(readFileSync(policyPath(root)), before, `${label} must not be rewritten`);
  }

  await writeFile(policyPath(root), JSON.stringify({ ...good, schemaVersion: 2 }));
  assert.throws(() => loadPolicy(root), /unsupported schemaVersion/u);
});

test('a failed atomic rename leaves the target intact and no temp file behind', async (t) => {
  const root = await makeRoot(t);
  savePolicy(root, policyFor(root));
  const before = readFileSync(policyPath(root));

  const failing = {
    ...defaultTakeoverIo,
    rename: (): void => {
      throw new Error('injected rename failure');
    },
  };
  const store = new TakeoverStore(root, failing);
  assert.throws(() => store.savePolicy(policyFor(root, { baselineDigest: HASH_A })), /injected rename failure/u);
  assert.deepEqual(readFileSync(policyPath(root)), before, 'target bytes must be untouched');
  const leftovers = readdirSync(takeoverDir(root)).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], 'temp file must be cleaned up');
});

test('transaction journal appends phases and replays identical idempotency keys', async (t) => {
  const root = await makeRoot(t);
  const base = { ...KEY, backupId: 'backup-1' };

  const first = appendTransaction(root, { ...base, phase: 'prepared', now: '2026-11-22T00:00:00.000Z' });
  assert.equal(first.created, true);
  assert.equal(
    first.txId,
    createHash('sha256').update(canonicalJson(KEY)).digest('hex'),
  );
  assert.equal(computeTransactionId(KEY), first.txId);

  const replay = appendTransaction(root, { ...base, phase: 'prepared', now: '2026-11-22T00:05:00.000Z' });
  assert.equal(replay.created, false, 'same key and parameters must replay');
  assert.deepEqual(replay.entry, first.entry);
  assert.equal(readTransactions(root).length, 1);

  // Same key, different parameters: reject rather than overwrite.
  assert.throws(() => appendTransaction(root, { ...base, phase: 'prepared', backupId: 'backup-2' }), /idempotency conflict/u);
  assert.throws(() => appendTransaction(root, { ...base, phase: 'prepared', error: 'boom' }), /idempotency conflict/u);
  assert.throws(() => appendTransaction(root, { ...base, phase: 'prepared', evidenceHash: HASH_A }), /idempotency conflict/u);

  const forward = appendTransaction(root, { ...base, phase: 'migrated', now: '2026-11-22T00:01:00.000Z' });
  assert.equal(forward.created, true);
  // A completed earlier phase replays its own record on crash re-entry.
  const preparedAgain = appendTransaction(root, { ...base, phase: 'prepared', now: '2026-11-22T00:03:00.000Z' });
  assert.equal(preparedAgain.created, false);
  assert.deepEqual(preparedAgain.entry, first.entry);
  assert.equal(readTransactions(root).length, 2);
  // A phase that skips the fixed sequence is still rejected.
  assert.throws(() => appendTransaction(root, { ...base, phase: 'verified' }), /illegal takeover phase advance/u);

  for (const phase of ['reconciled', 'verified', 'installed', 'active', 'aborted'] as const) {
    const step = appendTransaction(root, { ...base, phase, now: '2026-11-22T00:02:00.000Z' });
    assert.equal(step.created, true, phase);
  }
  const activeReplay = appendTransaction(root, { ...base, phase: 'active', now: '2026-11-22T00:04:00.000Z' });
  assert.equal(activeReplay.created, false, 'completed phases replay even after abort');
  assert.throws(() => appendTransaction(root, { ...base, phase: 'installed', backupId: 'other-backup' }), /idempotency conflict/u);
  assert.deepEqual(readTransactions(root, first.txId).map((entry) => entry.phase), [
    'prepared', 'migrated', 'reconciled', 'verified', 'installed', 'active', 'aborted',
  ]);
});

test('journal refuses unknown transaction ids, non-prepared first records and corrupt logs', async (t) => {
  const root = await makeRoot(t);
  const base = { ...KEY, backupId: 'backup-1' };

  assert.throws(() => appendTransaction(root, { ...base, phase: 'prepared', txId: 'f'.repeat(64) }), /txId mismatch/u);
  assert.throws(() => appendTransaction(root, { ...base, phase: 'verified' }), /must have phase prepared/u);
  assert.equal(readTransactions(root).length, 0);

  await writeFile(transactionsPath(root), 'not json at all');
  const corrupted = readFileSync(transactionsPath(root));
  assert.throws(() => readTransactions(root), ConnectTamperError);
  assert.deepEqual(readFileSync(transactionsPath(root)), corrupted, 'corrupt log must not be reset');

  const emptyLog = JSON.stringify({ schema: 'ano.takeover-transactions/1', schemaVersion: 2, root, entries: [] });
  await writeFile(transactionsPath(root), emptyLog);
  assert.throws(() => readTransactions(root), ConnectTamperError);

  const foreignLog = JSON.stringify({ schema: 'ano.takeover-transactions/1', schemaVersion: 1, root: 'F:/Other Project', entries: [] });
  await writeFile(transactionsPath(root), foreignLog);
  assert.throws(() => readTransactions(root), /is bound to/u);
});

test('guarded transitions persist legal edges and reject jumps/stale reads', async (t) => {
  const root = await makeRoot(t);
  savePolicy(root, policyFor(root));

  const enforced = applyStateTransition(root, {
    from: 'disabled', to: 'enforced', now: '2026-11-22T01:00:00.000Z', baselineDigest: HASH_A,
  });
  assert.equal(enforced.state, 'enforced');
  assert.equal(enforced.enforcedAt, '2026-11-22T01:00:00.000Z');
  assert.equal(loadPolicy(root)?.state, 'enforced');

  const recovery = applyStateTransition(root, { from: 'enforced', to: 'recovery', now: '2026-11-22T02:00:00.000Z' });
  assert.equal(recovery.state, 'recovery');
  assert.equal(recovery.enforcedAt, '2026-11-22T01:00:00.000Z', 'exit keeps the enforcement history');

  const disabled = applyStateTransition(root, { from: 'recovery', to: 'disabled', now: '2026-11-22T03:00:00.000Z' });
  assert.equal(disabled.state, 'disabled');
  assert.equal(disabled.recoveredAt, '2026-11-22T03:00:00.000Z');

  assert.throws(() => applyStateTransition(root, { from: 'disabled', to: 'recovery' }), /illegal takeover state transition/u);
  assert.equal(loadPolicy(root)?.state, 'disabled', 'rejected jump must not change state');

  assert.throws(
    () => applyStateTransition(root, { from: 'enforced', to: 'recovery', now: '2026-11-22T04:00:00.000Z' }),
    /state is disabled, expected enforced/u,
  );

  const fresh = await makeRoot(t);
  savePolicy(fresh, policyFor(fresh));
  assert.throws(
    () => applyStateTransition(fresh, { from: 'disabled', to: 'enforced', now: '2026-11-22T05:00:00.000Z' }),
    /baselineDigest/u,
  );

  const revokedRoot = await makeRoot(t);
  const revokedPolicy = policyFor(revokedRoot);
  saveAuthorization(revokedRoot, { ...revokedPolicy.authorization, revokedAt: '2026-11-22T04:30:00.000Z' });
  savePolicy(revokedRoot, { ...revokedPolicy, authorization: { ...revokedPolicy.authorization, revokedAt: '2026-11-22T04:30:00.000Z' } });
  assert.throws(
    () => applyStateTransition(revokedRoot, { from: 'disabled', to: 'enforced', baselineDigest: HASH_A, now: '2026-11-22T05:30:00.000Z' }),
    /authorization is revoked/u,
  );
});

test('cross-root documents are rejected for both policy and journal', async (t) => {
  const rootA = await makeRoot(t);
  const rootB = await makeRoot(t);
  savePolicy(rootA, policyFor(rootA));
  appendTransaction(rootA, { ...KEY, backupId: 'backup-1', phase: 'prepared' });

  await mkdir(join(rootB, '.ano', 'takeover'), { recursive: true });
  await writeFile(policyPath(rootB), readFileSync(policyPath(rootA)));
  await writeFile(transactionsPath(rootB), readFileSync(transactionsPath(rootA)));

  assert.throws(() => loadPolicy(rootB), ConnectSourceError);
  assert.throws(() => loadState(rootB), /is bound to/u);
  assert.throws(() => readTransactions(rootB), /is bound to/u);
});

test('authorization persistence validates the id binding fail-closed', async (t) => {
  const root = await makeRoot(t);
  const authorization = authFor(root);
  saveAuthorization(root, authorization);
  assert.deepEqual(loadAuthorization(root), authorization);

  const tampered = { ...authorization, grantedBy: 'Eve' };
  await writeFile(authorizationPath(root), JSON.stringify(tampered));
  assert.throws(() => loadAuthorization(root), /does not match/u);
  assert.throws(() => saveAuthorization(root, tampered), /does not match/u);
});

test('policy stateHash mismatch fails closed and store writes reseal the document', async (t) => {
  const root = await makeRoot(t);
  savePolicy(root, policyFor(root));
  const edited = { ...policyFor(root), baselineDigest: HASH_A };
  await writeFile(policyPath(root), JSON.stringify(edited, null, 2));
  assert.throws(() => loadPolicy(root), (error: unknown) => {
    assert.ok(error instanceof ConnectTamperError);
    assert.match(error.message, /stateHash/u);
    return true;
  });

  // Writes always recompute the hash; the tampered-but-schema-valid record can
  // be persisted again only through the store, which seals it.
  const resealed = savePolicy(root, edited);
  assert.equal(resealed.stateHash, computePolicyStateHash(edited));
  assert.equal(loadPolicy(root)?.stateHash, resealed.stateHash);
});

test('transaction journal hash chain binds history and detects rewrites/broken links', async (t) => {
  const root = await makeRoot(t);
  const base = { ...KEY, backupId: 'backup-1' };
  appendTransaction(root, { ...base, phase: 'prepared', now: '2026-11-22T00:00:00.000Z' });
  appendTransaction(root, { ...base, phase: 'migrated', now: '2026-11-22T00:01:00.000Z' });
  const entries = readTransactions(root);
  assert.equal(entries[0]?.prevHash ?? null, null, 'genesis has no predecessor');
  assert.equal(entries[1]?.prevHash ?? null, entries[0]?.entryHash ?? null, 'each entry links its predecessor');
  for (const entry of entries) {
    assert.equal(computeTransactionEntryHash(entry), entry.entryHash);
  }

  const logPath = transactionsPath(root);
  const valid = readFileSync(logPath, 'utf8');

  // Rewriting historical bytes without recomputing both hashes.
  const rewritten = JSON.parse(valid) as { entries: Array<Record<string, unknown>> };
  rewritten.entries[0]!['error'] = 'rewritten';
  await writeFile(logPath, JSON.stringify(rewritten, null, 2));
  assert.throws(() => readTransactions(root), (error: unknown) => {
    assert.ok(error instanceof ConnectTamperError);
    assert.match(error.message, /entry hash/u);
    return true;
  });

  // Recomputing only the local entry hash still leaves a broken chain link.
  const relinked = JSON.parse(valid) as { entries: Array<Record<string, unknown>> };
  relinked.entries[1]!['prevHash'] = '0'.repeat(64);
  await writeFile(logPath, JSON.stringify(relinked, null, 2));
  assert.throws(() => readTransactions(root), (error: unknown) => {
    assert.ok(error instanceof ConnectTamperError);
    assert.match(error.message, /chain is broken/u);
    return true;
  });

  await writeFile(logPath, valid);
  assert.equal(readTransactions(root).length, 2, 'a restored chain verifies again');
});

test('loadState combines policy state with the latest transaction phase', async (t) => {
  const root = await makeRoot(t);
  const initial = loadState(root);
  assert.equal(initial.state, 'disabled');
  assert.equal(initial.policy, null);
  assert.equal(initial.phase, null);
  assert.equal(initial.transactions, 0);

  savePolicy(root, policyFor(root));
  const first = appendTransaction(root, { ...KEY, backupId: 'backup-1', phase: 'prepared' });
  let state = loadState(root);
  assert.equal(state.state, 'disabled');
  assert.equal(state.phase, 'prepared');
  assert.equal(state.txId, first.txId);
  assert.equal(state.transactions, 1);
  assert.notEqual(state.policy, null);

  applyStateTransition(root, { from: 'disabled', to: 'enforced', baselineDigest: HASH_A, now: '2026-11-22T06:00:00.000Z' });
  state = loadState(root);
  assert.equal(state.state, 'enforced');
  assert.equal(state.policy?.enforcedAt, '2026-11-22T06:00:00.000Z');
});

test('saved documents remain readable byte-for-byte through stable formatting', async (t) => {
  const root = await makeRoot(t);
  const doc = policyFor(root);
  savePolicy(root, doc);
  const raw = await readFile(policyPath(root), 'utf8');
  assert.match(raw, /\n$/u);
  assert.deepEqual(JSON.parse(raw) as unknown, doc);
});