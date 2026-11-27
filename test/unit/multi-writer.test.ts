import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HaProtocolError,
  MWHA_ADJUDICATION_SCHEMA_VERSION,
  MWHA_EVENT_SCHEMA_VERSION,
  assertGateBoundary,
  gateEvidenceIssue,
  idempotencyKey,
  mwhaProjectionStateSchema,
  type MwhaAdjudication,
  type MwhaBranch,
  type MwhaEventIdentity,
  type MwhaLeaderLease,
  type MwhaWriterEvent,
} from '../../src/memory/ha-protocol.ts';
import { ledgerEventSchema, type LedgerEvent } from '../../src/ledger/event.ts';
import {
  MultiWriterLog,
  HaProtocolError as ReexportedHaProtocolError,
  projectMultiWriterState,
  type MultiWriterEntryRecord,
  type MultiWriterProjection,
} from '../../src/memory/multi-writer.ts';

/**
 * T-135 unit tests: multi-writer envelope binding, duplicate/reorder
 * classification, full fork retention, deterministic replay, explicit
 * adjudication and the Gate boundary.
 */

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function ulidLike(value: number): string {
  let rest = value;
  let out = '';
  for (let index = 0; index < 26; index += 1) {
    out = ULID_ALPHABET[rest % 32] + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}

let ledgerCounter = 0;
function ledgerEvent(label: string): LedgerEvent {
  ledgerCounter += 1;
  const event: LedgerEvent = {
    id: ulidLike(ledgerCounter),
    hlc: { physical: ledgerCounter, logical: 0, actor: 'writer' },
    actor: 'writer',
    kind: 'note.recorded',
    payload: { label, note_id: label },
    prev_hash: '0'.repeat(64),
  };
  assert.equal(ledgerEventSchema.safeParse(event).success, true);
  return event;
}

function identity(overrides: Partial<MwhaEventIdentity> = {}): MwhaEventIdentity {
  return { writer_id: 'w1', epoch: 1, term: 1, local_seq: 1, ledger_event_hash: HASH_A, ...overrides };
}

function lease(overrides: Partial<MwhaLeaderLease> = {}): MwhaLeaderLease {
  return { term: 1, leader_id: 'w1', epoch: 1, ...overrides };
}

function writerEvent(overrides: Partial<MwhaEventIdentity> = {}, leader: MwhaLeaderLease | null = lease()): MwhaWriterEvent {
  return { schema_version: MWHA_EVENT_SCHEMA_VERSION, identity: identity(overrides), leader };
}

function branchOf(identityValue: MwhaEventIdentity): MwhaBranch {
  return {
    branch_id: `branch-${identityValue.ledger_event_hash.slice(0, 16)}`,
    identity: identityValue,
    ledger_event_hash: identityValue.ledger_event_hash,
  };
}

function completeAdjudication(branches: readonly MwhaBranch[], selectedBranchId: string, reason = 'explicit operator ruling'): MwhaAdjudication {
  return {
    schema_version: MWHA_ADJUDICATION_SCHEMA_VERSION,
    conflict_key: { writer_id: branches[0]!.identity.writer_id, epoch: branches[0]!.identity.epoch, local_seq: branches[0]!.identity.local_seq },
    branches: [...branches],
    branch_hashes: branches.map((branch) => branch.ledger_event_hash),
    status: 'resolved',
    selected_branch_id: selectedBranchId,
    resolution_reason: reason,
  };
}

function expectHaError(run: () => unknown, code: string): HaProtocolError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof HaProtocolError, `expected HaProtocolError, got ${String(error)}`);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`expected HaProtocolError ${code}`);
}

function committedStates(projection: MultiWriterProjection) {
  return projection.states.map((state) => ({
    conflict_key: state.conflict_key,
    status: state.status,
    winning_branch_id: state.winning_branch_id,
    evidence_id: state.evidence_id,
    produces_gate_evidence: state.produces_gate_evidence,
    branches: state.branches.map((branch) => branch.ledger_event_hash),
    referenced_branch_hashes: state.referenced_branch_hashes,
  }));
}

test('identity binding includes the caller-computed ledger hash and rejects tampering', { timeout: 60_000 }, () => {
  const log = new MultiWriterLog();
  const event = ledgerEvent('bound');
  const result = log.append({ event: writerEvent(), ledgerEvent: event, ledgerEventHash: HASH_A, commitIndex: 1 });

  assert.equal(result.kind, 'fresh');
  assert.equal(result.entry.ledgerEvent, event, 'the supplied ledger object must be retained by reference');
  assert.equal(result.entry.ledgerEventHash, HASH_A);
  assert.equal(result.entry.entry.identity.ledger_event_hash, HASH_A);
  assert.deepEqual(log.replay().entries.map((entry) => entry.identity.ledger_event_hash), [HASH_A]);

  // Tampered reference: the declared hashEvent result does not match the identity.
  expectHaError(
    () => log.append({ event: writerEvent({ ledger_event_hash: HASH_A }), ledgerEvent: ledgerEvent('tampered'), ledgerEventHash: HASH_B, commitIndex: 2 }),
    'HA_INPUT_INVALID',
  );

  // Structurally invalid ledger event.
  const broken = { ...ledgerEvent('broken'), hlc: { physical: -1, logical: 0, actor: 'writer' } };
  expectHaError(
    () => log.append({ event: writerEvent({ ledger_event_hash: HASH_A }), ledgerEvent: broken, ledgerEventHash: HASH_A, commitIndex: 3 }),
    'HA_INPUT_INVALID',
  );

  // Unknown field in the writer envelope is rejected by the strict schema.
  expectHaError(
    () => log.append({ event: { ...writerEvent(), extra: true } as unknown as MwhaWriterEvent, ledgerEvent: ledgerEvent('extra'), ledgerEventHash: HASH_A }),
    'HA_INPUT_INVALID',
  );
});

test('duplicate append is idempotent with zero side effects', { timeout: 60_000 }, () => {
  const log = new MultiWriterLog();
  const first = log.append({ event: writerEvent(), ledgerEvent: ledgerEvent('one'), ledgerEventHash: HASH_A, commitIndex: 1 });
  const before = log.replay();

  const second = log.append({ event: writerEvent(), ledgerEvent: ledgerEvent('one-again'), ledgerEventHash: HASH_A, commitIndex: 1 });
  const after = log.replay();

  assert.equal(first.kind, 'fresh');
  assert.equal(second.kind, 'duplicate');
  assert.equal(second.entry, first.entry, 'a duplicate returns the already stored record');
  assert.equal(log.size, 1);
  assert.equal(log.maxCommitIndex, 1);
  assert.equal(log.duplicateDeliveryCount, 1);
  assert.equal(after.hash, before.hash);
  assert.deepEqual(committedStates(after), committedStates(before));

  // Duplicate across a non-first branch is still a duplicate, never a conflict.
  log.append({ event: writerEvent({ ledger_event_hash: HASH_B }), ledgerEvent: ledgerEvent('two'), ledgerEventHash: HASH_B, commitIndex: 2 });
  const third = log.append({ event: writerEvent({ ledger_event_hash: HASH_B }), ledgerEvent: ledgerEvent('two-again'), ledgerEventHash: HASH_B, commitIndex: 2 });
  assert.equal(third.kind, 'duplicate');
  assert.equal(log.size, 2);
  assert.equal(log.duplicateDeliveryCount, 2);

  // Ingest reports duplicates without mutating the log.
  const report = log.ingest([{ entry: third.entry.entry, ledgerEvent: ledgerEvent('two-ingest'), ledgerEventHash: HASH_B }]);
  assert.equal(report.duplicates, 1);
  assert.equal(report.applied, 0);
  assert.equal(log.size, 2);
  assert.equal(log.duplicateDeliveryCount, 3);
});

test('out-of-order and gapped local sequences are classified without silent skips', { timeout: 60_000 }, () => {
  const log = new MultiWriterLog();
  const kinds = [1, 3, 2, 5].map((seq, index) =>
    log.append({
      event: writerEvent({ local_seq: seq, ledger_event_hash: [HASH_A, HASH_B, HASH_C, HASH_D][index]! }),
      ledgerEvent: ledgerEvent(`seq-${String(seq)}`),
      ledgerEventHash: [HASH_A, HASH_B, HASH_C, HASH_D][index]!,
      commitIndex: seq,
    }).sequence,
  );
  assert.deepEqual(kinds, ['first', 'gap', 'reorder', 'gap']);

  const report = log.sequenceReport('w1', 1);
  assert.ok(report);
  assert.equal(report.last_local_seq, 5);
  assert.equal(report.next_expected_local_seq, 6);
  assert.deepEqual(report.missing_local_seqs, [4]);
  assert.equal(report.seen_count, 4);
  assert.equal(report.last_transition, 'gap');

  // A repeated sequence number is a duplicate-seq delivery and does not move the head.
  const repeat = log.append({ event: writerEvent({ local_seq: 5, ledger_event_hash: HASH_D }), ledgerEvent: ledgerEvent('repeat'), ledgerEventHash: HASH_D, commitIndex: 5 });
  assert.equal(repeat.sequence, 'duplicate-seq');
  assert.equal(repeat.kind, 'duplicate');
  assert.equal(log.size, 4);
});

test('two writers sharing a prior are retained independently and a same-slot fork keeps every branch', { timeout: 60_000 }, () => {
  const log = new MultiWriterLog();
  const first = log.append({ event: writerEvent({ writer_id: 'w1' }), ledgerEvent: ledgerEvent('w1-a'), ledgerEventHash: HASH_A, commitIndex: 1, evidenceId: 'ev-w1-a' });
  const second = log.append({ event: writerEvent({ writer_id: 'w2', ledger_event_hash: HASH_B }), ledgerEvent: ledgerEvent('w2-b'), ledgerEventHash: HASH_B, commitIndex: 2, evidenceId: 'ev-w2-b' });
  assert.equal(first.kind, 'fresh');
  assert.equal(second.kind, 'fresh');
  assert.notEqual(idempotencyKey(first.entry.entry.identity), idempotencyKey(second.entry.entry.identity));

  // Same writer, same slot, different content: both branches survive.
  const fork = log.append({ event: writerEvent({ writer_id: 'w1', ledger_event_hash: HASH_C }), ledgerEvent: ledgerEvent('w1-c'), ledgerEventHash: HASH_C, commitIndex: 3, evidenceId: 'ev-w1-c' });
  assert.equal(fork.kind, 'conflict');
  assert.equal(log.size, 3);

  const report = log.forkReport();
  assert.equal(report.conflicts.length, 1);
  assert.equal(report.branch_count, 2);
  assert.deepEqual([...report.conflicts[0]!.branches.map((branch) => branch.ledger_event_hash)].sort(), [HASH_A, HASH_C].sort());

  const w1State = log.replay().states.find((state) => state.conflict_key.writer_id === 'w1' && state.conflict_key.epoch === 1 && state.conflict_key.local_seq === 1);
  assert.ok(w1State);
  assert.equal(w1State.status, 'conflicted');
  assert.equal(w1State.winning_branch_id, null);
  assert.equal(w1State.evidence_id, null);
  assert.deepEqual([...w1State.referenced_branch_hashes].sort(), [HASH_A, HASH_C].sort());
});

test('projection is deterministic under input-order permutation', { timeout: 60_000 }, () => {
  const inputs = [
    { identity: identity({ writer_id: 'w1', local_seq: 1, ledger_event_hash: HASH_A }), commitIndex: 1 },
    { identity: identity({ writer_id: 'w1', local_seq: 2, ledger_event_hash: HASH_B }), commitIndex: 2 },
    { identity: identity({ writer_id: 'w2', local_seq: 1, ledger_event_hash: HASH_C }), commitIndex: 3 },
  ];

  const forward = new MultiWriterLog();
  const reverse = new MultiWriterLog();
  for (const input of inputs) {
    forward.append({ event: writerEvent(input.identity), ledgerEvent: ledgerEvent('forward'), ledgerEventHash: input.identity.ledger_event_hash, commitIndex: input.commitIndex });
  }
  for (const input of [...inputs].reverse()) {
    reverse.append({ event: writerEvent(input.identity), ledgerEvent: ledgerEvent('reverse'), ledgerEventHash: input.identity.ledger_event_hash, commitIndex: input.commitIndex });
  }

  const left = forward.replay();
  const right = reverse.replay();
  assert.equal(left.hash, right.hash);
  assert.deepEqual(committedStates(left), committedStates(right));
  assert.deepEqual(left.entries, right.entries);

  // The pure projector agrees on permuted arrays too.
  const records: readonly MultiWriterEntryRecord[] = forward.getEntries();
  assert.equal(projectMultiWriterState([...records].reverse(), []).hash, projectMultiWriterState(records, []).hash);
});

test('same logical version with different hashes is conflicted, never last-write-wins', { timeout: 60_000 }, () => {
  const build = (order: readonly string[]): MultiWriterLog => {
    const log = new MultiWriterLog();
    for (const hash of order) {
      log.append({ event: writerEvent({ ledger_event_hash: hash }), ledgerEvent: ledgerEvent(hash.slice(0, 1)), ledgerEventHash: hash, commitIndex: 1, evidenceId: `ev-${hash.slice(0, 8)}` });
    }
    return log;
  };

  const ab = build([HASH_A, HASH_B]).replay();
  const ba = build([HASH_B, HASH_A]).replay();
  assert.equal(ab.hash, ba.hash);

  const expectedHashes = [HASH_A, HASH_B].sort();
  for (const projection of [ab, ba]) {
    assert.equal(projection.forks.length, 1);
    assert.deepEqual(projection.forks[0]!.branches.map((branch) => branch.ledger_event_hash), expectedHashes);
    const state = projection.states[0]!;
    assert.equal(state.status, 'conflicted');
    assert.equal(state.winning_branch_id, null);
    assert.equal(state.evidence_id, null);
    assert.equal(state.produces_gate_evidence, false);
    assert.deepEqual(state.version_outcome.conflicting_hashes, expectedHashes);
    assert.equal(state.version_outcome.status, 'conflicted');
  }

  // No arrival order may silently elect a winner.
  const winnerA = build([HASH_A, HASH_B]).replay().states[0]!;
  const winnerB = build([HASH_B, HASH_A]).replay().states[0]!;
  assert.equal(winnerA.winning_branch_id, winnerB.winning_branch_id);
  assert.equal(winnerA.winning_branch_id, null);
});

test('adjudication rejects missing or foreign branches and accepts a complete branch set', { timeout: 60_000 }, () => {
  const log = new MultiWriterLog();
  for (const hash of [HASH_A, HASH_B, HASH_C]) {
    log.append({ event: writerEvent({ ledger_event_hash: hash }), ledgerEvent: ledgerEvent(hash.slice(0, 1)), ledgerEventHash: hash, commitIndex: 1 });
  }
  const actual = log.forkReport().conflicts[0]!.branches;

  // Schema-valid but incomplete against the three retained branches.
  const missing = completeAdjudication([branchOf(actual[0]!.identity), branchOf(actual[1]!.identity)], actual[0]!.branch_id);
  expectHaError(() => log.adjudicate(missing), 'ADJUDICATION_INCOMPLETE');
  assert.equal(log.getAdjudications().length, 0);

  // Foreign branch hash.
  const foreign = completeAdjudication([branchOf(actual[0]!.identity), branchOf(identity({ ledger_event_hash: HASH_D }))], actual[0]!.branch_id);
  expectHaError(() => log.adjudicate(foreign), 'ADJUDICATION_INCOMPLETE');

  // Complete resolved adjudication converges on the selected branch while recording all references.
  const complete = completeAdjudication(actual.map((branch) => branchOf(branch.identity)), actual[0]!.branch_id, 'operator picked A');
  const stored = log.adjudicate(complete, { evidenceId: 'ev-final' });
  assert.equal(stored.branches.length, 3);
  const state = log.replay().states.find((candidate) => candidate.status === 'committed');
  assert.ok(state);
  assert.equal(state.winning_branch_id, actual[0]!.branch_id);
  assert.equal(state.evidence_id, 'ev-final');
  assert.deepEqual([...state.referenced_branch_hashes].sort(), [HASH_A, HASH_B, HASH_C].sort());
  assert.equal(state.adjudication?.adjudication.selected_branch_id, actual[0]!.branch_id);
});

test('unknown epochs, stale terms and split-brain leaders are fenced out', { timeout: 60_000 }, () => {
  const unknownEpoch = new MultiWriterLog({ knownEpochs: [1] });
  expectHaError(
    () => unknownEpoch.append({ event: writerEvent({ epoch: 2 }, lease({ epoch: 2 })), ledgerEvent: ledgerEvent('e2'), ledgerEventHash: HASH_A, commitIndex: 1 }),
    'FENCE_UNKNOWN_EPOCH',
  );

  const staleTerm = new MultiWriterLog({ lease: lease({ term: 5, leader_id: 'w1', epoch: 1 }) });
  expectHaError(
    () => staleTerm.append({ event: writerEvent({ term: 1 }, lease({ term: 1, leader_id: 'w0', epoch: 1 })), ledgerEvent: ledgerEvent('stale'), ledgerEventHash: HASH_A, commitIndex: 1 }),
    'FENCE_STALE_TERM',
  );

  const splitBrain = new MultiWriterLog({ lease: lease({ term: 1, leader_id: 'w1', epoch: 1 }) });
  expectHaError(
    () => splitBrain.append({ event: writerEvent({ term: 1 }, lease({ term: 1, leader_id: 'w2', epoch: 1 })), ledgerEvent: ledgerEvent('sb'), ledgerEventHash: HASH_A, commitIndex: 1 }),
    'FENCE_SPLIT_BRAIN_SAME_TERM',
  );

  const rollback = new MultiWriterLog({ lease: lease({ term: 1, leader_id: 'w1', epoch: 3 }) });
  expectHaError(
    () => rollback.append({ event: writerEvent({ epoch: 2 }, lease({ term: 1, leader_id: 'w1', epoch: 2 })), ledgerEvent: ledgerEvent('rb'), ledgerEventHash: HASH_A, commitIndex: 1 }),
    'FENCE_EPOCH_ROLLBACK',
  );

  // A valid newer term/epoch is accepted and advances the fence.
  const advancing = new MultiWriterLog({ lease: lease({ term: 1, leader_id: 'w1', epoch: 1 }) });
  const accepted = advancing.append({ event: writerEvent({ epoch: 2, term: 2 }, lease({ term: 2, leader_id: 'w1', epoch: 2 })), ledgerEvent: ledgerEvent('adv'), ledgerEventHash: HASH_A, commitIndex: 1 });
  assert.equal(accepted.kind, 'fresh');
});

test('every projection state respects the Gate boundary and uncommitted entries stay out of facts', { timeout: 60_000 }, () => {
  const log = new MultiWriterLog();
  log.append({ event: writerEvent({ ledger_event_hash: HASH_A }), ledgerEvent: ledgerEvent('proposed'), ledgerEventHash: HASH_A });
  const proposedOnly = log.replay();
  assert.equal(proposedOnly.entries.length, 0, 'uncommitted entries never enter the fact projection');
  assert.equal(proposedOnly.states.length, 1);
  assert.equal(proposedOnly.states[0]!.status, 'uncommitted');
  assert.equal(proposedOnly.states[0]!.evidence_id, null);
  assert.equal(proposedOnly.states[0]!.produces_gate_evidence, false);
  assert.equal(gateEvidenceIssue(proposedOnly.states[0]!), null);
  assertGateBoundary(proposedOnly.states[0]!);

  log.append({ event: writerEvent({ ledger_event_hash: HASH_B }), ledgerEvent: ledgerEvent('committed'), ledgerEventHash: HASH_B, commitIndex: 1, evidenceId: 'ev-b' });
  log.append({ event: writerEvent({ ledger_event_hash: HASH_C }), ledgerEvent: ledgerEvent('fork'), ledgerEventHash: HASH_C, commitIndex: 2 });
  const mixed = log.replay();
  assert.deepEqual(mixed.entries.map((entry) => entry.identity.ledger_event_hash).sort(), [HASH_B, HASH_C].sort());
  for (const state of mixed.states) {
    const parsed = mwhaProjectionStateSchema.safeParse({
      schema_version: state.schema_version,
      conflict_key: state.conflict_key,
      status: state.status,
      winning_branch_id: state.winning_branch_id,
      evidence_id: state.evidence_id,
      produces_gate_evidence: state.produces_gate_evidence,
    });
    assert.equal(parsed.success, true);
    assert.equal(gateEvidenceIssue(state), null, `state ${state.status} must satisfy the Gate boundary`);
    assertGateBoundary(state);
    if (state.status !== 'committed') {
      assert.equal(state.evidence_id, null);
      assert.equal(state.produces_gate_evidence, false);
      assert.equal(state.winning_branch_id, null);
    }
  }
  const conflicted = mixed.states.find((state) => state.status === 'conflicted');
  assert.ok(conflicted);
  assert.equal(conflicted.evidence_id, null);
});

test('module vocabulary re-exports stay assertion-friendly', { timeout: 60_000 }, () => {
  assert.equal(ReexportedHaProtocolError, HaProtocolError);
  assert.equal(typeof projectMultiWriterState, 'function');
});
