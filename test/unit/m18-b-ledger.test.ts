/**
 * T-153 shard B: reachable branches of `src/ledger/ledger.ts`.
 *
 * The existing suites cover successful completion and ordinary appends. This
 * file drives the fail-closed Gate-proof rejections, malformed memory replay
 * inputs, and the idempotent lease reclaim/release retry paths against real
 * temporary ledgers.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  deriveMemoryProjection,
  GateEvidenceError,
  IdempotencyConflictError,
  Ledger,
  LedgerIntegrityError,
} from '../../src/ledger/ledger.ts';
import type { LedgerEvent } from '../../src/ledger/event.ts';
import type { ViewReplayEntry } from '../../src/ledger/views.ts';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const AT = '2026-11-21T00:00:00.000Z';

async function openLedger(t: TestContext, sessionId = 'm18b-ledger'): Promise<{ root: string; ledger: Ledger }> {
  const root = await mkdtemp(join(tmpdir(), 'm18b-ledger-'));
  const ledger = await Ledger.open(root, { sessionId });
  t.after(async () => {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, ledger };
}

const M18B_EVENT_ID = '01AAAAAAAAAAAAAAAAAAAAAAAA';

function entry(kind: LedgerEvent['kind'], payload: Record<string, unknown>, id: string = M18B_EVENT_ID): ViewReplayEntry {
  return {
    segment: 'm18b-segment',
    event: {
      id,
      kind,
      actor: 'm18b',
      hlc: { physical: 1, logical: 0, actor: 'm18b' },
      payload,
      prev_hash: '0'.repeat(64),
    },
  };
}

test('m18b ledger memory replay rejects malformed payloads deterministically', () => {
  assert.throws(
    () => deriveMemoryProjection([entry('memory.revised', null as unknown as Record<string, unknown>, 'e1')]),
    (error: unknown) => error instanceof LedgerIntegrityError && /non-object payload/u.test(error.message),
  );
  assert.throws(
    () => deriveMemoryProjection([entry('memory.revised', { intent: 'revise', fact_key: 'f', supersedes: 'nope' }, 'e2')]),
    (error: unknown) => error instanceof LedgerIntegrityError && /invalid supersedes/u.test(error.message),
  );
});

test('m18b ledger completeTaskWithEvidence refuses evidence without a stored verdict', async (t) => {
  const { ledger } = await openLedger(t);
  const { task } = await ledger.createTask('T-1', ['src/a.ts'], 'Gate task', 'm18b-task');
  await ledger.append({
    kind: 'evidence.recorded',
    payload: {
      task_id: task.id,
      evidence: { id: 'ev-no-verdict', ok: true, sourceFingerprint: HASH_A, verification: {} },
    },
  }, 'm18b-ev-1');

  await assert.rejects(
    () => ledger.completeTaskWithEvidence(task.id, 'ev-no-verdict'),
    (error: unknown) => error instanceof GateEvidenceError && /no stored Gate verdict/u.test(error.message),
  );
});

test('m18b ledger gate proof rejects malformed or mismatched completion claims', async (t) => {
  const { ledger } = await openLedger(t);
  const { task } = await ledger.createTask('T-2', ['src/b.ts'], 'Gate task 2', 'm18b-task-2');
  const { task: other } = await ledger.createTask('T-3', ['src/c.ts'], 'Other task', 'm18b-task-3');

  await ledger.append({
    kind: 'evidence.recorded',
    payload: {
      task_id: task.id,
      evidence: {
        id: 'ev-ok',
        ok: true,
        sourceFingerprint: HASH_A,
        verification: { verdict: { status: 'done', evidenceId: 'ev-ok', sourceFingerprint: HASH_A } },
      },
    },
  }, 'm18b-ev-2');
  await ledger.append({
    kind: 'evidence.recorded',
    payload: { task_id: other.id, evidence: { id: 'ev-other', ok: true, sourceFingerprint: HASH_A } },
  }, 'm18b-ev-3');
  await ledger.append({
    kind: 'evidence.recorded',
    payload: { task_id: task.id, evidence: { id: 'ev-bad-fp', ok: true, sourceFingerprint: 'zz' } },
  }, 'm18b-ev-4');
  await ledger.append({
    kind: 'evidence.recorded',
    payload: {
      task_id: task.id,
      evidence: { id: 'ev-not-done', ok: true, sourceFingerprint: HASH_A, verification: { verdict: { status: 'needs_review', evidenceId: 'ev-not-done' } } },
    },
  }, 'm18b-ev-5');
  await ledger.append({
    kind: 'evidence.recorded',
    payload: {
      task_id: task.id,
      evidence: { id: 'ev-wrong-id', ok: true, sourceFingerprint: HASH_A, verification: { verdict: { status: 'done', evidenceId: 'ev-other-id', sourceFingerprint: HASH_A } } },
    },
  }, 'm18b-ev-6');
  await ledger.append({
    kind: 'evidence.recorded',
    payload: {
      task_id: task.id,
      evidence: { id: 'ev-fp-mismatch', ok: true, sourceFingerprint: HASH_A, verification: { verdict: { status: 'done', evidenceId: 'ev-fp-mismatch', sourceFingerprint: HASH_B } } },
    },
  }, 'm18b-ev-7');

  const cases: Array<{ name: string; patch: Record<string, unknown>; message: RegExp }> = [
    { name: 'missing verdict', patch: { status: 'done' }, message: /cannot be completed without a Gate verdict/u },
    { name: 'verdict not done', patch: { status: 'done', verdict: { status: 'needs_review', evidenceId: 'ev-ok' } }, message: /requires verdict.status "done"/u },
    { name: 'missing evidence id', patch: { status: 'done', verdict: { status: 'done' } }, message: /requires verdict.evidenceId/u },
    { name: 'wrong task id', patch: { status: 'done', verdict: { status: 'done', evidenceId: 'ev-ok', taskId: 'T-OTHER' } }, message: /belongs to T-OTHER/u },
    { name: 'unknown evidence', patch: { status: 'done', verdict: { status: 'done', evidenceId: 'ev-missing' } }, message: /is not recorded/u },
    { name: 'evidence of another task', patch: { status: 'done', verdict: { status: 'done', evidenceId: 'ev-other' } }, message: /belongs to/u },
    { name: 'bad fingerprint', patch: { status: 'done', verdict: { status: 'done', evidenceId: 'ev-bad-fp' } }, message: /does not bind a source fingerprint/u },
    { name: 'stored verdict not done', patch: { status: 'done', verdict: { status: 'done', evidenceId: 'ev-not-done' } }, message: /Stored Gate verdict .* is not done/u },
    { name: 'stored evidence id differs', patch: { status: 'done', verdict: { status: 'done', evidenceId: 'ev-wrong-id' } }, message: /names a different evidence id/u },
    { name: 'stored fingerprint differs', patch: { status: 'done', verdict: { status: 'done', evidenceId: 'ev-fp-mismatch', sourceFingerprint: HASH_A } }, message: /does not match the claimed source fingerprint/u },
  ];
  let index = 0;
  for (const item of cases) {
    index += 1;
    await assert.rejects(
      () => ledger.updateTask(task.id, item.patch as never, `m18b-claim-${String(index)}`),
      (error: unknown) => {
        assert.ok(error instanceof GateEvidenceError, `${item.name}: expected GateEvidenceError`);
        assert.match(error.message, item.message);
        return true;
      },
      item.name,
    );
  }
  // None of the rejected claims materialized a done transition.
  assert.equal(ledger.getTask(task.id)?.status, 'todo');
});

test('m18b ledger reclaim and release retries return the materialized lease once', async (t) => {
  const { ledger } = await openLedger(t);
  const first = await ledger.acquireRunLease('run-1', { leaseId: 'lease-1', ttlMs: 1 });
  assert.equal(first.duplicate, false);
  await new Promise((resolve) => setTimeout(resolve, 20));

  const reclaimed = await ledger.reclaimRunLease('run-1', { leaseId: 'lease-1', idemKey: 'm18b-reclaim' });
  assert.equal(reclaimed.duplicate, false);
  const reclaimedAgain = await ledger.reclaimRunLease('run-1', { leaseId: 'lease-1', idemKey: 'm18b-reclaim' });
  assert.equal(reclaimedAgain.duplicate, true);
  assert.equal(reclaimedAgain.lease.leaseId, reclaimed.lease.leaseId);

  const released = await ledger.releaseRunLease('run-1', reclaimed.lease.leaseId, { idemKey: 'm18b-release' });
  assert.equal(released.duplicate, false);
  const releasedAgain = await ledger.releaseRunLease('run-1', reclaimed.lease.leaseId, { idemKey: 'm18b-release' });
  assert.equal(releasedAgain.duplicate, true);
  assert.equal(releasedAgain.lease.leaseId, reclaimed.lease.leaseId);
});

test('m18b ledger idempotency key conflicts are rejected across different payloads', async (t) => {
  const { ledger } = await openLedger(t);
  await ledger.append({ kind: 'note.recorded', payload: { note_id: HASH_A, kind: 'decision', text: 'first', created_at: AT, anchor: { file: 'src/a.ts', symbolId: 'sym-a' } } }, 'm18b-idem');
  await assert.rejects(
    () => ledger.append({ kind: 'note.recorded', payload: { note_id: HASH_B, kind: 'decision', text: 'second', created_at: AT, anchor: { file: 'src/b.ts', symbolId: 'sym-b' } } }, 'm18b-idem'),
    (error: unknown) => error instanceof IdempotencyConflictError,
  );
});
