import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  applyEventToDb,
  findIdempotency,
  IdempotencyConflictError,
  initViews,
  invalidateViewDigest,
  LedgerIntegrityError,
  listEvidence,
  readAuditFinding,
  readAuditFindings,
  readAuditRuns,
  readEventById,
  readEvidence,
  readNote,
  readNotes,
  readReadinessAttestation,
  readReadinessAttestations,
  readReadinessEvidence,
  readReadinessEvidenceList,
  readReleaseApproval,
  readReleaseApprovals,
  readReleaseVerdict,
  readReleaseVerdicts,
  readRunLease,
  readRunLeases,
  readTask,
  readTaskCreatedEventId,
  readTaskCreationCanonical,
  readTasks,
  syncViews,
  type ViewReplayEntry,
} from '../../src/ledger/views.ts';
import type { LedgerEvent } from '../../src/ledger/event.ts';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let counter = 0;

function ulid(): string {
  counter += 1;
  let encoded = '';
  let value = counter;
  do {
    encoded = ALPHABET[value % 32] + encoded;
    value = Math.floor(value / 32);
  } while (value > 0);
  return `01J${encoded}`.padEnd(26, '0');
}

const ISO = '2026-01-01T00:00:00.000Z';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);

function event(kind: LedgerEvent['kind'], payload: Record<string, unknown>, options: { id?: string; idem?: string; prev?: string } = {}): LedgerEvent {
  const id = options.id ?? ulid();
  return {
    id,
    hlc: { physical: 1, logical: counter, actor: 'tester' },
    actor: 'tester',
    kind,
    payload,
    ...(options.idem === undefined ? {} : { idem_key: options.idem }),
    prev_hash: options.prev ?? '0'.repeat(64),
  };
}

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  initViews(db);
  return db;
}

function apply(db: DatabaseSync, kind: LedgerEvent['kind'], payload: Record<string, unknown>, options?: { id?: string; idem?: string }): LedgerEvent {
  const created = event(kind, payload, options);
  applyEventToDb(db, created, 'segment-0001');
  return created;
}

function expectIntegrity(run: () => unknown, pattern?: RegExp): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof LedgerIntegrityError, `expected LedgerIntegrityError, got ${String(error)}`);
    return pattern ? pattern.test((error as Error).message) : true;
  });
}

function notePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    note_id: HASH_A,
    kind: 'decision',
    text: 'keep the lease',
    created_at: ISO,
    anchor: { file: 'src/a.ts', symbolId: 'id-a' },
    ...overrides,
  };
}

function findingPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scope: 'security',
    at: ISO,
    finding: {
      id: HASH_B, scope: 'security', rule: 'secret/x', severity: 'high', message: 'm', fingerprint: HASH_C, status: 'open', reopened: false,
    },
    ...overrides,
  };
}

test('views initialize idempotently and syncViews rebuilds or rolls back atomically', () => {
  const db = freshDb();
  try {
    initViews(db); // second call sees the same schema version
    assert.deepEqual(syncViews(db, []), undefined);
    const entries: ViewReplayEntry[] = [{ event: event('segment.started', {}, { id: 'a' }), segment: 's1' }];
    // Placeholder id is not a ULID, so the digest path must surface the failure and roll back.
    expectIntegrity(() => syncViews(db, entries), /Invalid event a/);

    const noteA = event('note.recorded', notePayload({ text: 'one' }));
    const good: ViewReplayEntry[] = [{ event: noteA, segment: 's1' }];
    syncViews(db, good);
    syncViews(db, good); // unchanged digest short-circuits
    assert.equal(readNotes(db).length, 1);

    const noteB = event('note.recorded', notePayload({ text: 'two' }));
    expectIntegrity(() => syncViews(db, [...good, { event: noteB, segment: 's1' }]), /Conflicting note\.recorded/);
    assert.equal(readNotes(db).length, 1, 'a failed sync rolls back and keeps the prior cache');
  } finally { db.close(); }
});

test('applyEventToDb enforces event identity and idempotency conflicts', () => {
  const db = freshDb();
  try {
    const first = event('segment.started', {}, { idem: 'idem-1' });
    assert.deepEqual(applyEventToDb(db, first, 's1'), { applied: true, duplicate: false });
    assert.deepEqual(applyEventToDb(db, first, 's1'), { applied: false, duplicate: true });
    assert.equal(readEventById(db, first.id)?.id, first.id);
    assert.equal(readEventById(db, 'missing'), undefined);

    const samePayload = event('segment.started', {}, { idem: 'idem-1' });
    assert.deepEqual(applyEventToDb(db, samePayload, 's1'), { applied: false, duplicate: true });
    assert.equal(findIdempotency(db, 'idem-1')?.event.id, first.id);
    assert.equal(findIdempotency(db, 'idem-missing'), undefined);

    const conflicting = event('verify.started', { task_id: 'T-1' }, { idem: 'idem-1' });
    assert.throws(() => applyEventToDb(db, conflicting, 's1'), IdempotencyConflictError);

    const conflictingId = event('segment.started', {}, { id: first.id });
    expectIntegrity(() => applyEventToDb(db, conflictingId, 's1'), /Conflicting event id/);

    expectIntegrity(() => applyEventToDb(db, { ...event('segment.started', {}), id: 'not-a-ulid' }, 's1'), /Invalid event/);
  } finally { db.close(); }
});

test('note.recorded views keep anchors optional and reject conflicting payloads', () => {
  const db = freshDb();
  try {
    apply(db, 'note.recorded', notePayload());
    const stored = readNote(db, HASH_A)!;
    assert.equal(stored.kind, 'decision');
    assert.deepEqual(stored.anchor, { file: 'src/a.ts', symbolId: 'id-a' });

    apply(db, 'note.recorded', notePayload()); // identical payload under a new event id is not a conflict
    assert.equal(readNotes(db).length, 1);

    const summary = apply(db, 'note.recorded', { note_id: HASH_B, kind: 'session_summary', text: 'summary', created_at: ISO });
    assert.equal(readNote(db, HASH_B)!.anchor, undefined);
    assert.equal(readNotes(db).some((note) => note.id === summary.id), false);

    expectIntegrity(() => apply(db, 'note.recorded', notePayload({ text: 'changed' })), /Conflicting note\.recorded/);
    expectIntegrity(() => apply(db, 'note.recorded', notePayload({ note_id: HASH_C, anchor: undefined })), /payload is invalid|requires a memory anchor/);
  } finally { db.close(); }
});

test('audit.finding views update status in place and reject identity changes', () => {
  const db = freshDb();
  try {
    apply(db, 'audit.finding', findingPayload());
    assert.equal(readAuditFinding(db, HASH_B)?.status, 'open');
    assert.equal(readAuditFinding(db, 'missing'), undefined);
    assert.equal(readAuditFindings(db, 'security').length, 1);
    assert.equal(readAuditFindings(db, 'license').length, 0);
    assert.equal(readAuditFindings(db).length, 1);

    apply(db, 'audit.finding', findingPayload({ finding: { ...findingPayload().finding as Record<string, unknown>, status: 'resolved', reopened: true } }));
    const resolved = readAuditFinding(db, HASH_B)!;
    assert.equal(resolved.status, 'resolved');
    assert.equal(resolved.reopened, true);

    expectIntegrity(
      () => apply(db, 'audit.finding', findingPayload({ finding: { ...findingPayload().finding as Record<string, unknown>, severity: 'low' } })),
      /Conflicting audit\.finding/,
    );
    expectIntegrity(
      () => apply(db, 'audit.finding', findingPayload({ finding: { id: HASH_B, scope: 'security', rule: 'r', severity: 'high', message: 'm', status: 'open' } })),
      /payload is invalid/,
    );
  } finally { db.close(); }
});

test('audit.completed records only boolean verdicts', () => {
  const db = freshDb();
  try {
    const completed = apply(db, 'audit.completed', { scope: 'license', at: ISO, ok: true, summary: { high: 0, medium: 0, low: 0, info: 0, total: 0 } });
    const runs = readAuditRuns(db);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.eventId, completed.id);
    assert.equal(runs[0]!.ok, true);
    assert.deepEqual(runs[0]!.summary, { high: 0, medium: 0, low: 0, info: 0, total: 0 });
    expectIntegrity(
      () => apply(db, 'audit.completed', { scope: 'license', at: ISO, ok: 'yes', summary: { high: 0, medium: 0, low: 0, info: 0, total: 0 } }),
      /payload is invalid|requires ok/,
    );
  } finally { db.close(); }
});

test('readiness.evidence accepts flat, nested and camelCase payloads', () => {
  const db = freshDb();
  try {
    apply(db, 'readiness.evidence', {
      evidence_ref: HASH_A, requirement_id: 'common.code-gate', kind: 'ci_run', timestamp: ISO, result: 'pass',
      source_fingerprint: HASH_B, artifact_hash: HASH_C, id: 'evidence-1', expires_at: '2026-02-01T00:00:00.000Z',
    });
    const flat = readReadinessEvidence(db, HASH_A)!;
    assert.equal(flat.result, 'pass');
    assert.equal(flat.evidenceId, 'evidence-1');
    assert.equal(flat.sourceFingerprint, HASH_B);
    assert.equal(flat.artifactHash, HASH_C);
    assert.equal(flat.expiresAt, '2026-02-01T00:00:00.000Z');
    assert.equal(readReadinessEvidence(db, 'missing'), undefined);
    assert.equal(readReadinessEvidenceList(db, 'common.code-gate').length, 1);
    assert.equal(readReadinessEvidenceList(db, 'other.requirement').length, 0);
    assert.equal(readReadinessEvidenceList(db).length, 1);

    apply(db, 'readiness.evidence', { evidence_ref: HASH_B, requirement_id: 'a.build', kind: 'ci_run', timestamp: ISO, status: 'machine' });
    assert.equal(readReadinessEvidence(db, HASH_B)!.result, 'pass');
    assert.equal(readReadinessEvidence(db, HASH_B)!.evidenceId, undefined);

    apply(db, 'readiness.evidence', { evidence_ref: HASH_C, evidence: { requirement_id: 'a.build', kind: 'docs_check', timestamp: ISO, result: 'fail' } });
    assert.equal(readReadinessEvidence(db, HASH_C)!.result, 'fail');

    apply(db, 'readiness.evidence', { evidenceRef: 'd'.repeat(64), requirementId: 'a.build', kind: 'ci_run', timestamp: ISO, result: 'pass' });
    assert.equal(readReadinessEvidence(db, 'd'.repeat(64))!.requirementId, 'a.build');

    expectIntegrity(
      () => apply(db, 'readiness.evidence', { evidence_ref: HASH_A, requirement_id: 'common.code-gate', kind: 'ci_run', timestamp: ISO, result: 'fail' }),
      /Conflicting readiness\.evidence/,
    );
    expectIntegrity(
      () => apply(db, 'readiness.evidence', { evidence_ref: 'e'.repeat(64), requirement_id: 'a.build', kind: 'ci_run', timestamp: ISO }),
      /payload is invalid/,
    );
  } finally { db.close(); }
});

test('readiness.attestation accepts flat and nested shapes and keeps optional fields', () => {
  const db = freshDb();
  try {
    apply(db, 'readiness.attestation', {
      attestation_ref: HASH_A, requirement_id: 'a.build', signer: { name: 'Reviewer', role: 'owner' },
      signed_at: ISO, expires_at: '2026-02-01T00:00:00.000Z', artifact_hash: HASH_B, release_target: 'npm',
      requirement_ids: ['a.build', 'a.types'], id: 'attestation-1',
    });
    const flat = readReadinessAttestation(db, HASH_A)!;
    assert.deepEqual(flat.signer, { name: 'Reviewer', role: 'owner' });
    assert.equal(flat.requirementId, 'a.build');
    assert.deepEqual(flat.requirementIds, ['a.build', 'a.types']);
    assert.equal(flat.attestationId, 'attestation-1');
    assert.equal(readReadinessAttestation(db, 'missing'), undefined);
    assert.equal(readReadinessAttestations(db).length, 1);

    apply(db, 'readiness.attestation', {
      attestation_ref: HASH_B,
      attestation: {
        signer: { name: 'Other', role: 'owner' }, signed_at: ISO, expires_at: '2026-03-01T00:00:00.000Z',
        artifact_hash: HASH_C, release_target: 'docker', requirement_ids: ['common.code-gate'],
      },
    });
    const nested = readReadinessAttestation(db, HASH_B)!;
    assert.equal(nested.requirementId, undefined);
    assert.deepEqual(nested.requirementIds, ['common.code-gate']);
    assert.equal(nested.attestationId, undefined);

    expectIntegrity(
      () => apply(db, 'readiness.attestation', {
        attestation_ref: HASH_A, requirement_id: 'a.build', signer: { name: 'Reviewer', role: 'owner' },
        signed_at: '2026-09-01T00:00:00.000Z', expires_at: '2026-02-01T00:00:00.000Z', artifact_hash: HASH_B, release_target: 'npm',
      }),
      /Conflicting readiness\.attestation/,
    );
  } finally { db.close(); }
});

test('release verdicts and approvals preserve optional fields and reject conflicts', () => {
  const db = freshDb();
  try {
    apply(db, 'release.verdict', {
      target: 'npm', artifact_hash: HASH_A, verdict: 'ready', verdict_hash: HASH_B,
      summary: { machine: 3, attested: 1, declaration: 0, missing: 0 }, source_fingerprint: HASH_C, caveats: ['ci'],
    });
    const verdict = readReleaseVerdict(db, HASH_B)!;
    assert.equal(verdict.verdict, 'ready');
    assert.equal(verdict.sourceFingerprint, HASH_C);
    assert.deepEqual(verdict.caveats, ['ci']);
    assert.equal(readReleaseVerdict(db, 'missing'), undefined);
    assert.equal(readReleaseVerdicts(db).length, 1);

    apply(db, 'release.verdict', {
      target: 'docker', artifact_hash: HASH_A, verdict: 'blocked', verdict_hash: HASH_C,
      summary: { machine: 0, attested: 0, missing: 4 },
    });
    const bare = readReleaseVerdict(db, HASH_C)!;
    assert.equal(bare.sourceFingerprint, undefined);
    assert.equal(bare.caveats, undefined);

    expectIntegrity(
      () => apply(db, 'release.verdict', {
        target: 'other', artifact_hash: HASH_A, verdict: 'ready', verdict_hash: HASH_B,
        summary: { machine: 3, attested: 1, missing: 0 },
      }),
      /Conflicting release\.verdict/,
    );

    apply(db, 'release.approved', { approval_ref: HASH_A, target: 'npm', artifact_hash: HASH_A, verdict_hash: HASH_B, approver: 'human', approved_at: ISO });
    const approval = readReleaseApproval(db, HASH_A)!;
    assert.equal(approval.approver, 'human');
    assert.equal(readReleaseApproval(db, 'missing'), undefined);
    assert.equal(readReleaseApprovals(db).length, 1);
    expectIntegrity(
      () => apply(db, 'release.approved', { approval_ref: HASH_A, target: 'npm', artifact_hash: HASH_A, verdict_hash: HASH_B, approver: 'other-human', approved_at: ISO }),
      /Conflicting release\.approved/,
    );
  } finally { db.close(); }
});

test('task and evidence views cover creation, updates, metadata and lease attribution', () => {
  const db = freshDb();
  try {
    apply(db, 'task.created', { task_id: 'T-1', declared_files: ['src/a.ts'], title: 'first' });
    const task = readTask(db, 'T-1')!;
    assert.equal(task.title, 'first');
    assert.equal(readTasks(db).length, 1);
    assert.equal(readTaskCreationCanonical(db, 'T-1')?.includes('T-1'), true);
    assert.equal(readTaskCreatedEventId(db, 'T-1')?.length, 26);
    assert.equal(readTask(db, 'missing'), undefined);

    apply(db, 'task.created', { task_id: 'T-2', declared_files: [] });
    assert.equal(readTask(db, 'T-2')!.title, undefined);
    expectIntegrity(() => apply(db, 'task.created', { task_id: 'T-1', declared_files: [] }), /Duplicate task\.created/);
    expectIntegrity(() => apply(db, 'task.created', { task_id: 'T-3', declared_files: 'nope' }), /declared_files array/);
    expectIntegrity(() => apply(db, 'task.created', { task_id: 'T-4', declared_files: [], status: 'bogus' }), /Invalid task status/);

    expectIntegrity(() => apply(db, 'task.updated', { task_id: 'unknown' }), /Update for unknown task/);
    expectIntegrity(() => apply(db, 'task.updated', { task_id: 'T-1', status: 'bogus' }), /Invalid task status/);

    apply(db, 'task.updated', {
      task_id: 'T-1', status: 'done', verdict: { status: 'done' }, original_status: 'in_progress', verified: true, migration_warning: 'legacy',
    });
    const updated = readTask(db, 'T-1')!;
    assert.equal(updated.status, 'done');
    assert.deepEqual(updated.verdict, { status: 'done' });
    assert.equal(updated.originalStatus, 'in_progress');
    assert.equal(updated.verified, true);
    assert.equal(updated.migrationWarning, 'legacy');

    apply(db, 'task.updated', { task_id: 'T-1', verdict: null });
    const reopened = readTask(db, 'T-1')!;
    assert.equal(reopened.status, 'done', 'status is preserved when omitted');
    assert.equal(reopened.verdict, undefined);
    assert.equal(reopened.originalStatus, 'in_progress', 'migration metadata survives an ordinary update');
    assert.equal(reopened.verified, true);

    expectIntegrity(() => apply(db, 'evidence.recorded', { task_id: 'unknown', evidence: { id: 'e' } }), /Evidence for unknown task/);
    expectIntegrity(() => apply(db, 'evidence.recorded', { task_id: 'T-1', evidence: 'not-an-object' }), /requires evidence object/);
    apply(db, 'evidence.recorded', { task_id: 'T-1', evidence: { id: 'e1', ok: true }, test_files: ['test/a.test.ts'] });
    assert.deepEqual(readEvidence(db, 'e1')?.testFiles, ['test/a.test.ts']);
    assert.equal(readEvidence(db, 'missing'), undefined);
    assert.equal(listEvidence(db, 'T-1').length, 1);
    assert.equal(listEvidence(db).length, 1);
    assert.equal(listEvidence(db, 'T-2').length, 0);
    apply(db, 'evidence.recorded', { task_id: 'T-2', evidence: { id: 'e2', ok: true } });
    assert.deepEqual(readEvidence(db, 'e2')?.testFiles, []);

    expectIntegrity(() => apply(db, 'evidence.recorded', { task_id: 'T-1', evidence: { id: 'e3' }, run_id: 'run-1' }), /provided together/);
    expectIntegrity(() => apply(db, 'evidence.recorded', { task_id: 'T-1', evidence: { id: 'e4' }, run_id: 'run-1', lease_id: 'lease-1' }), /active run lease/);

    apply(db, 'run.lease.acquired', { run_id: 'run-1', lease_id: 'lease-1', owner: 'tester', acquired_at: 1, heartbeat_at: 1, expires_at: 100 });
    assert.equal(readRunLease(db, 'run-1')?.status, 'active');
    expectIntegrity(
      () => apply(db, 'run.lease.acquired', { run_id: 'run-1', lease_id: 'lease-2', owner: 'tester', acquired_at: 1, heartbeat_at: 1, expires_at: 100 }),
      /already leased/,
    );
    apply(db, 'evidence.recorded', { task_id: 'T-1', evidence: { id: 'e5', ok: true }, run_id: 'run-1', lease_id: 'lease-1' });
    assert.equal(readRunLease(db, 'run-1')?.producedEvidence, true);
    expectIntegrity(() => apply(db, 'run.lease.heartbeat', { run_id: 'missing', lease_id: 'lease-1', heartbeat_at: 2, expires_at: 200 }), /unknown run/);
    expectIntegrity(() => apply(db, 'run.lease.heartbeat', { run_id: 'run-1', lease_id: 'other', heartbeat_at: 2, expires_at: 200 }), /lease id mismatch/);
    apply(db, 'run.lease.heartbeat', { run_id: 'run-1', lease_id: 'lease-1', heartbeat_at: 2, expires_at: 200 });
    assert.equal(readRunLease(db, 'run-1')?.heartbeatAt, 2);

    apply(db, 'run.lease.reclaimed', { run_id: 'run-1', lease_id: 'lease-2', reclaimed_from: 'lease-1', owner: 'tester', acquired_at: 3, heartbeat_at: 3, expires_at: 300 });
    const reclaimed = readRunLease(db, 'run-1')!;
    assert.equal(reclaimed.leaseId, 'lease-2');
    assert.equal(reclaimed.reclaimedFrom, 'lease-1');
    assert.equal(reclaimed.producedEvidence, false);
    expectIntegrity(
      () => apply(db, 'run.lease.reclaimed', { run_id: 'run-1', lease_id: 'lease-3', reclaimed_from: 'lease-1', owner: 'tester', acquired_at: 4, heartbeat_at: 4, expires_at: 400 }),
      /reclaimed_from mismatch/,
    );

    apply(db, 'run.lease.released', { run_id: 'run-1', lease_id: 'lease-2' });
    assert.equal(readRunLease(db, 'run-1')?.status, 'released');
    expectIntegrity(() => apply(db, 'run.lease.released', { run_id: 'run-1', lease_id: 'lease-2' }), /non-active/);
    apply(db, 'run.lease.acquired', { run_id: 'run-1', lease_id: 'lease-9', owner: 'tester', acquired_at: 5, heartbeat_at: 5, expires_at: 500 });
    const reacquired = readRunLease(db, 'run-1')!;
    assert.equal(reacquired.leaseId, 'lease-9');
    assert.equal(reacquired.reclaimedFrom, undefined);
    assert.equal(readRunLease(db, 'missing'), undefined);
    assert.equal(readRunLeases(db).length, 1);

    expectIntegrity(() => apply(db, 'run.lease.heartbeat', { run_id: 'run-1', lease_id: 'lease-9', heartbeat_at: -1, expires_at: 500 }), /nonnegative integer/);
    expectIntegrity(() => apply(db, 'run.lease.acquired', { run_id: 'run-2', lease_id: 'l', owner: '', acquired_at: 1, heartbeat_at: 1, expires_at: 1 }), /requires owner/);

    db.prepare("UPDATE tasks SET status = 'bogus' WHERE id = 'T-2'").run();
    expectIntegrity(() => readTask(db, 'T-2'), /Invalid cached task status/);
    db.prepare("UPDATE run_leases SET status = 'bogus' WHERE run_id = 'run-1'").run();
    expectIntegrity(() => readRunLease(db, 'run-1'), /Invalid cached run lease status/);
  } finally { db.close(); }
});

test('identical cross-domain payloads are accepted as no-ops and the view digest can be invalidated', () => {
  const db = freshDb();
  try {
    const evidence = { evidence_ref: HASH_A, requirement_id: 'a.build', kind: 'ci_run', timestamp: ISO, result: 'pass' };
    apply(db, 'readiness.evidence', evidence);
    apply(db, 'readiness.evidence', evidence); // same row, different event id
    assert.equal(readReadinessEvidenceList(db).length, 1);

    const attestation = {
      attestation_ref: HASH_B, requirement_id: 'a.build', signer: { name: 'Reviewer', role: 'owner' },
      signed_at: ISO, expires_at: ISO, artifact_hash: HASH_C, release_target: 'npm',
    };
    apply(db, 'readiness.attestation', attestation);
    apply(db, 'readiness.attestation', attestation);
    assert.equal(readReadinessAttestations(db).length, 1);

    const verdict = { target: 'npm', artifact_hash: HASH_A, verdict: 'ready', verdict_hash: HASH_B, summary: { machine: 1, attested: 0, missing: 0 } };
    apply(db, 'release.verdict', verdict);
    apply(db, 'release.verdict', verdict);
    assert.equal(readReleaseVerdicts(db).length, 1);

    const approval = { approval_ref: HASH_C, target: 'npm', artifact_hash: HASH_A, verdict_hash: HASH_B, approver: 'human', approved_at: ISO };
    apply(db, 'release.approved', approval);
    apply(db, 'release.approved', approval);
    assert.equal(readReleaseApprovals(db).length, 1);

    const entries: ViewReplayEntry[] = [
      { event: event('note.recorded', notePayload()), segment: 's1' },
      { event: event('readiness.evidence', evidence), segment: 's1' },
    ];
    syncViews(db, entries);
    invalidateViewDigest(db);
    syncViews(db, entries);
    assert.equal(readNotes(db).length, 1);
  } finally { db.close(); }
});
