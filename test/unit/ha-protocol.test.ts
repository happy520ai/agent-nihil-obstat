import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HaProtocolError,
  MWHA_ADJUDICATION_SCHEMA_VERSION,
  MWHA_CLOCK_DEFAULT_POLICY,
  MWHA_EVENT_SCHEMA_VERSION,
  MWHA_FAULT_INJECTION_SCOPE_NOTE,
  MWHA_PROTOCOL_SCHEMA_VERSION,
  MWHA_PROJECTION_STATE_SCHEMA_VERSION,
  MWHA_UNVERIFIED_CAPABILITIES,
  MWHA_VERIFICATION_SCOPE,
  MWHA_VERIFICATION_SCOPE_NOTE,
  adjudicationProblems,
  assertAdjudicationComplete,
  assertFence,
  assertGateBoundary,
  assertNoWallClockKey,
  assertQuorum,
  classifyClockObservation,
  classifyDelivery,
  classifySequence,
  compareLogicalVersion,
  containsWallClockKey,
  contentKey,
  detectForks,
  detectMultipleLeaders,
  determineVersionOutcome,
  evaluateFence,
  evaluatePartitions,
  gateEvidenceIssue,
  idempotencyKey,
  isQuorum,
  isUnverifiedCapability,
  mwhaAdjudicationSchema,
  mwhaClusterLogEntrySchema,
  mwhaEventIdentitySchema,
  mwhaFaultInjectionSchema,
  mwhaFaultKinds,
  mwhaLeaderLeaseSchema,
  mwhaLogicalVersionSchema,
  mwhaMemberRoles,
  mwhaProjectionStateSchema,
  mwhaTopologySchema,
  mwhaWriterEventSchema,
  mergeSortKey,
  quorumSize,
  sortEntriesByLogicalVersion,
  sortLogicalVersions,
  votingMemberCount,
  type MwhaAdjudication,
  type MwhaBranch,
  type MwhaClockObservation,
  type MwhaEventIdentity,
  type MwhaLeaderLease,
  type MwhaLogicalVersion,
  type MwhaMember,
  type MwhaProjectionState,
  type MwhaTopology,
} from '../../src/memory/ha-protocol.ts';

/**
 * T-133 unit tests: freeze the multi-writer HA contract invariants (quorum,
 * fencing, identity/idempotency, logical order, fork/adjudication, clock
 * diagnostics, fault vocabulary, Gate boundary and the verification scope).
 */

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);

function identity(overrides: Partial<MwhaEventIdentity> = {}): MwhaEventIdentity {
  return {
    writer_id: 'w1',
    epoch: 1,
    term: 1,
    local_seq: 1,
    ledger_event_hash: HASH_A,
    ...overrides,
  };
}

function version(overrides: Partial<MwhaLogicalVersion> = {}): MwhaLogicalVersion {
  return { epoch: 1, commit_index: 1, writer_id: 'w1', local_seq: 1, ...overrides };
}

function members(n: number, role: MwhaMember['role'] = 'voting-member'): MwhaMember[] {
  return Array.from({ length: n }, (_, index) => ({ member_id: `m${String(index)}`, role }));
}

function topology(n: number, overrides: Record<string, unknown> = {}): MwhaTopology {
  return {
    schema_version: MWHA_PROTOCOL_SCHEMA_VERSION,
    cluster_id: 'cluster-1',
    members: members(n),
    quorum_size: quorumSize(n),
    ...overrides,
  };
}

function lease(overrides: Partial<MwhaLeaderLease> = {}): MwhaLeaderLease {
  return { term: 1, leader_id: 'w1', epoch: 1, ...overrides };
}

function branchesOf(count: number, hashes: readonly string[] = [HASH_A, HASH_B, HASH_C]): MwhaBranch[] {
  return hashes.slice(0, count).map((hash) => ({
    branch_id: `branch-${hash.slice(0, 16)}`,
    identity: identity({ ledger_event_hash: hash }),
    ledger_event_hash: hash,
  }));
}

function adjudicationFrom(branches: readonly MwhaBranch[], overrides: Record<string, unknown> = {}): MwhaAdjudication {
  return {
    schema_version: MWHA_ADJUDICATION_SCHEMA_VERSION,
    conflict_key: { writer_id: 'w1', epoch: 1, local_seq: 1 },
    branches,
    branch_hashes: branches.map((branch) => branch.ledger_event_hash),
    status: 'resolved',
    selected_branch_id: branches[0]!.branch_id,
    resolution_reason: 'deterministic first-by-hash',
    ...overrides,
  } as MwhaAdjudication;
}

// ---------------------------------------------------------------------------
// Quorum
// ---------------------------------------------------------------------------

test('quorum is floor(N/2)+1 for N=1..5', () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(quorumSize), [1, 2, 2, 3, 3]);
});

test('quorum accepts only majority votes and assertQuorum rejects minorities', () => {
  assert.equal(isQuorum(1, 3), false);
  assert.equal(isQuorum(2, 3), true);
  assert.equal(isQuorum(3, 3), true);
  assert.throws(() => assertQuorum(1, 3), (error: unknown) => error instanceof HaProtocolError && error.code === 'QUORUM_NOT_REACHED');
  assert.throws(() => quorumSize(0), /QUORUM_INPUT_INVALID/);
});

test('a 2-2 split never commits: each side is a minority of an N=2 cluster', () => {
  const split = evaluatePartitions([1, 1], 2);
  assert.equal(split.quorum_size, 2);
  assert.equal(split.any_commit, false);
  assert.deepEqual(split.blocked_partitions, [1, 1]);
  assert.equal(isQuorum(1, 2), false);
  // The only committing shape is both votes together.
  assert.equal(evaluatePartitions([2], 2).any_commit, true);
});

test('minority partitions are refused for N=5 and a majority partition commits', () => {
  const split = evaluatePartitions([1, 2, 2], 5);
  assert.equal(split.quorum_size, 3);
  assert.deepEqual(split.committing_partitions, []);
  assert.deepEqual(split.blocked_partitions, [1, 2, 2]);
  assert.equal(evaluatePartitions([3], 5).any_commit, true);
  assert.throws(() => assertQuorum(2, 5), /QUORUM_NOT_REACHED/);
});

test('topology quorum is derived from voting members and observers never vote', () => {
  const mixed = [...members(2), { member_id: 'obs-1', role: 'observer' as const }];
  assert.equal(votingMemberCount(mixed), 2);
  assert.equal(mwhaTopologySchema.parse(topology(3, { members: mixed })).quorum_size, 2);
  const parsed = mwhaTopologySchema.safeParse(topology(3, { quorum_size: 3 }));
  assert.equal(parsed.success, false);
  const observerOnly = mwhaTopologySchema.safeParse({
    schema_version: MWHA_PROTOCOL_SCHEMA_VERSION,
    cluster_id: 'cluster-1',
    members: [{ member_id: 'obs-1', role: 'observer' }],
    quorum_size: 1,
  });
  assert.equal(observerOnly.success, false);
});

// ---------------------------------------------------------------------------
// Fencing / split brain
// ---------------------------------------------------------------------------

test('stale-term writes are rejected', () => {
  const evaluation = evaluateFence(lease({ term: 5, leader_id: 'w2' }), lease({ term: 4, leader_id: 'w2' }));
  assert.equal(evaluation.allowed, false);
  assert.equal(evaluation.code, 'FENCE_STALE_TERM');
  assert.throws(() => assertFence(lease({ term: 5 }), lease({ term: 4 })), /FENCE_STALE_TERM/);
});

test('an old leader is rejected after a newer term exists', () => {
  const evaluation = evaluateFence(lease({ term: 7, leader_id: 'new' }), lease({ term: 6, leader_id: 'old' }));
  assert.equal(evaluation.allowed, false);
  assert.equal(evaluation.code, 'FENCE_STALE_TERM');
});

test('two leaders in the same term are illegal (split brain)', () => {
  const evaluation = evaluateFence(lease({ term: 3, leader_id: 'A' }), lease({ term: 3, leader_id: 'B' }));
  assert.equal(evaluation.allowed, false);
  assert.equal(evaluation.code, 'FENCE_SPLIT_BRAIN_SAME_TERM');
  assert.throws(() => assertFence(lease({ term: 3, leader_id: 'A' }), lease({ term: 3, leader_id: 'B' })), /SPLIT_BRAIN/);
});

test('epoch rollback is rejected even when the term advances', () => {
  const evaluation = evaluateFence(lease({ term: 2, epoch: 4 }), lease({ term: 3, epoch: 3 }));
  assert.equal(evaluation.allowed, false);
  assert.equal(evaluation.code, 'FENCE_EPOCH_ROLLBACK');
});

test('unknown epochs fail closed', () => {
  const known = new Set([1, 2]);
  const evaluation = evaluateFence(lease({ epoch: 2 }), lease({ epoch: 99 }), known);
  assert.equal(evaluation.allowed, false);
  assert.equal(evaluation.code, 'FENCE_UNKNOWN_EPOCH');
  assert.throws(() => assertFence(lease({ epoch: 2 }), lease({ epoch: 99 }), known), /UNKNOWN_EPOCH/);
});

test('a newer term or a newer epoch with the same leader is allowed', () => {
  assert.equal(evaluateFence(lease({ term: 2 }), lease({ term: 3 })).code, 'FENCE_OK');
  assert.equal(evaluateFence(lease({ epoch: 2 }), lease({ epoch: 3 })).code, 'FENCE_OK');
  assert.equal(evaluateFence(lease({ term: 2, leader_id: 'A' }), lease({ term: 2, leader_id: 'A' })).code, 'FENCE_OK');
});

test('detectMultipleLeaders reports every same-(epoch,term) split deterministically', () => {
  const conflicts = detectMultipleLeaders([
    lease({ epoch: 1, term: 1, leader_id: 'B' }),
    lease({ epoch: 1, term: 1, leader_id: 'A' }),
    lease({ epoch: 1, term: 1, leader_id: 'A' }),
    lease({ epoch: 1, term: 2, leader_id: 'C' }),
  ]);
  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0]!.leader_ids, ['A', 'B']);
});

// ---------------------------------------------------------------------------
// Identity, idempotency, duplicate/reorder classification
// ---------------------------------------------------------------------------

test('identity keys separate writers/epochs/sequences and bind the ledger hash', () => {
  assert.notEqual(idempotencyKey(identity()), idempotencyKey(identity({ local_seq: 2 })));
  assert.notEqual(idempotencyKey(identity()), idempotencyKey(identity({ writer_id: 'w2' })));
  assert.notEqual(contentKey(identity()), contentKey(identity({ ledger_event_hash: HASH_B })));
  assert.equal(contentKey(identity()).endsWith(HASH_A), true);
});

test('classifyDelivery distinguishes fresh/duplicate/conflict', () => {
  const seen = new Map([[idempotencyKey(identity()), HASH_A]]);
  assert.equal(classifyDelivery(seen, identity()).kind, 'duplicate');
  assert.equal(classifyDelivery(seen, identity({ ledger_event_hash: HASH_B })).kind, 'conflict');
  assert.equal(classifyDelivery(seen, identity({ local_seq: 2 })).kind, 'fresh');
});

test('classifySequence distinguishes first/contiguous/duplicate/reorder/gap', () => {
  assert.equal(classifySequence(null, 1), 'first');
  assert.equal(classifySequence(1, 2), 'contiguous');
  assert.equal(classifySequence(2, 2), 'duplicate-seq');
  assert.equal(classifySequence(3, 2), 'reorder');
  assert.equal(classifySequence(2, 4), 'gap');
  assert.throws(() => classifySequence(1, 0), /HA_INPUT_INVALID/);
});

// ---------------------------------------------------------------------------
// Logical version order and wall-clock exclusion
// ---------------------------------------------------------------------------

test('compareLogicalVersion orders by (epoch, commit_index, writer_id, local_seq)', () => {
  const base = version();
  assert.equal(compareLogicalVersion(base, version({ epoch: 2 })), -1);
  assert.equal(compareLogicalVersion(version({ epoch: 2 }), base), 1);
  assert.equal(compareLogicalVersion(base, version({ commit_index: 2 })), -1);
  assert.equal(compareLogicalVersion(version({ writer_id: 'a' }), version({ writer_id: 'b' })), -1);
  assert.equal(compareLogicalVersion(base, version({ local_seq: 2 })), -1);
  assert.equal(compareLogicalVersion(base, version()), 0);
});

test('extreme wall-clock values never change the logical comparison', () => {
  const withClock = (wallClock: number): MwhaLogicalVersion =>
    ({ ...version(), wall_clock: wallClock }) as unknown as MwhaLogicalVersion;
  assert.equal(compareLogicalVersion(withClock(0), withClock(Number.MAX_SAFE_INTEGER)), 0);
  assert.equal(compareLogicalVersion(withClock(Number.MAX_SAFE_INTEGER), withClock(0)), 0);
  assert.equal(mergeSortKey(withClock(0)), mergeSortKey(withClock(Number.MAX_SAFE_INTEGER)));
});

test('wall-clock keys are detectable and refusable', () => {
  assert.equal(containsWallClockKey({ timestamp: 1 }), true);
  assert.equal(containsWallClockKey({ wallClock: 1 }), true);
  assert.equal(containsWallClockKey({ epoch: 1, commit_index: 1 }), false);
  assert.throws(() => assertNoWallClockKey({ recorded_at: 'x' }), /WALL_CLOCK_FORBIDDEN/);
  assert.doesNotThrow(() => assertNoWallClockKey({ epoch: 1, writer_id: 'w1' }));
});

test('deterministic sorting is independent of input order', () => {
  const entries = [
    { identity: identity({ writer_id: 'w2', local_seq: 1, ledger_event_hash: HASH_B }), commit_index: 5 },
    { identity: identity({ writer_id: 'w1', local_seq: 2, ledger_event_hash: HASH_C }), commit_index: 5 },
    { identity: identity({ writer_id: 'w1', local_seq: 1, ledger_event_hash: HASH_A }), commit_index: 9 },
  ];
  const forward = sortEntriesByLogicalVersion(entries).map((entry) => entry.identity.ledger_event_hash);
  const backward = sortEntriesByLogicalVersion([...entries].reverse()).map((entry) => entry.identity.ledger_event_hash);
  assert.deepEqual(forward, backward);
  assert.deepEqual(forward, [HASH_C, HASH_B, HASH_A]);
  const versions = [version({ epoch: 2 }), version({ epoch: 1, commit_index: 9 }), version({ epoch: 1, commit_index: 8 })];
  assert.deepEqual(sortLogicalVersions(versions).map((entry) => entry.epoch), [1, 1, 2]);
});

test('same-version hash disagreement is a conflict, never last-write-wins', () => {
  const outcome = determineVersionOutcome([
    { version: version(), ledger_event_hash: HASH_A },
    { version: version(), ledger_event_hash: HASH_B },
  ]);
  assert.equal(outcome.status, 'conflicted');
  assert.deepEqual(outcome.conflicting_hashes, [HASH_A, HASH_B]);
  const single = determineVersionOutcome([
    { version: version({ commit_index: 2 }), ledger_event_hash: HASH_B },
    { version: version({ commit_index: 1 }), ledger_event_hash: HASH_A },
  ]);
  assert.equal(single.status, 'committed');
  assert.equal(single.winning_version!.commit_index, 2);
  assert.equal(determineVersionOutcome([]).status, 'empty');
});

// ---------------------------------------------------------------------------
// Forks and adjudication
// ---------------------------------------------------------------------------

test('fork detection retains every competing branch', () => {
  const report = detectForks([
    { identity: identity({ ledger_event_hash: HASH_A }) },
    { identity: identity({ ledger_event_hash: HASH_B }) },
    { identity: identity({ ledger_event_hash: HASH_C }) },
    { identity: identity({ ledger_event_hash: HASH_A }) }, // duplicate collapses
    { identity: identity({ local_seq: 2, ledger_event_hash: HASH_D }) },
  ]);
  assert.equal(report.conflicts.length, 1);
  assert.equal(report.conflicts[0]!.branch_count, 3);
  assert.deepEqual(
    report.conflicts[0]!.branches.map((branch) => branch.ledger_event_hash),
    [HASH_A, HASH_B, HASH_C],
  );
  assert.equal(report.branch_count, 3);
});

test('a complete adjudication passes schema and completeness checks', () => {
  const branches = branchesOf(3);
  const adjudication = adjudicationFrom(branches);
  const parsed = mwhaAdjudicationSchema.safeParse(adjudication);
  assert.equal(parsed.success, true);
  assert.doesNotThrow(() => assertAdjudicationComplete(parsed.success ? parsed.data : adjudication, branches));
  assert.deepEqual(adjudicationProblems(parsed.success ? parsed.data : adjudication, branches), []);
});

test('an adjudication missing one branch hash is rejected by the schema', () => {
  const branches = branchesOf(3);
  const broken = adjudicationFrom(branches, { branch_hashes: [HASH_A, HASH_B] });
  assert.equal(mwhaAdjudicationSchema.safeParse(broken).success, false);
  const missingBranch = adjudicationFrom(branches, { branches: branches.slice(0, 2) });
  assert.equal(mwhaAdjudicationSchema.safeParse(missingBranch).success, false);
});

test('adjudication completeness assertion rejects missing or foreign branches', () => {
  const branches = branchesOf(3);
  const adjudication = mwhaAdjudicationSchema.parse(adjudicationFrom(branches));
  assert.throws(
    () => assertAdjudicationComplete(adjudication, branches.slice(0, 2)),
    (error: unknown) => error instanceof HaProtocolError && error.code === 'ADJUDICATION_INCOMPLETE',
  );
  const unknownHash = adjudicationFrom(branches, {
    branch_hashes: [HASH_A, HASH_B, HASH_D],
    selected_branch_id: branches[0]!.branch_id,
  });
  assert.throws(() => assertAdjudicationComplete(unknownHash, branches), /ADJUDICATION_INCOMPLETE/);
});

test('adjudication status/selection invariants are enforced', () => {
  const branches = branchesOf(2);
  assert.equal(mwhaAdjudicationSchema.safeParse(adjudicationFrom(branches, { selected_branch_id: 'branch-missing' })).success, false);
  assert.equal(mwhaAdjudicationSchema.safeParse(adjudicationFrom(branches, { resolution_reason: null })).success, false);
  assert.equal(mwhaAdjudicationSchema.safeParse(adjudicationFrom(branches, {
    status: 'unresolved',
    selected_branch_id: null,
    resolution_reason: null,
  })).success, true);
  assert.equal(mwhaAdjudicationSchema.safeParse(adjudicationFrom(branches, {
    status: 'unresolved',
    selected_branch_id: branches[0]!.branch_id,
    resolution_reason: null,
  })).success, false);
});

// ---------------------------------------------------------------------------
// Envelope schemas (strict, fail-closed)
// ---------------------------------------------------------------------------

test('event identity schema rejects unknown fields, missing fields and tampered hashes', () => {
  assert.equal(mwhaEventIdentitySchema.safeParse(identity()).success, true);
  assert.equal(mwhaEventIdentitySchema.safeParse({ ...identity(), extra: 1 }).success, false);
  assert.equal(mwhaEventIdentitySchema.safeParse({ writer_id: 'w1' }).success, false);
  assert.equal(mwhaEventIdentitySchema.safeParse(identity({ ledger_event_hash: 'not-a-hash' })).success, false);
  assert.equal(mwhaLogicalVersionSchema.safeParse({ ...version(), timestamp: 1 }).success, false);
});

test('writer event schema binds the lease epoch to the identity epoch', () => {
  assert.equal(mwhaWriterEventSchema.safeParse({
    schema_version: MWHA_EVENT_SCHEMA_VERSION,
    identity: identity(),
    leader: lease(),
  }).success, true);
  assert.equal(mwhaWriterEventSchema.safeParse({
    schema_version: MWHA_EVENT_SCHEMA_VERSION,
    identity: identity(),
    leader: lease({ epoch: 2 }),
  }).success, false);
});

test('cluster log entry schema enforces commit/fence/conflict consistency', () => {
  const base = {
    schema_version: 'mwha.cluster-log-entry.v1',
    identity: identity(),
    leader: lease(),
    conflict_key: null,
  };
  assert.equal(mwhaClusterLogEntrySchema.safeParse({ ...base, status: 'committed', commit_index: 1 }).success, true);
  assert.equal(mwhaClusterLogEntrySchema.safeParse({ ...base, status: 'committed', commit_index: 0 }).success, false);
  assert.equal(mwhaClusterLogEntrySchema.safeParse({ ...base, status: 'committed', commit_index: 1, leader: null }).success, false);
  assert.equal(mwhaClusterLogEntrySchema.safeParse({ ...base, status: 'proposed', commit_index: 0 }).success, true);
  assert.equal(mwhaClusterLogEntrySchema.safeParse({ ...base, status: 'proposed', commit_index: 3 }).success, false);
  assert.equal(mwhaClusterLogEntrySchema.safeParse({ ...base, status: 'conflicted', commit_index: 0 }).success, false);
  assert.equal(mwhaClusterLogEntrySchema.safeParse({
    ...base,
    status: 'conflicted',
    commit_index: 0,
    conflict_key: { writer_id: 'other', epoch: 1, local_seq: 1 },
  }).success, false);
});

test('topology schema rejects duplicate members and unknown fields', () => {
  assert.equal(mwhaTopologySchema.safeParse(topology(3)).success, true);
  const duplicate = topology(2, { members: [{ member_id: 'm0', role: 'voting-member' }, { member_id: 'm0', role: 'writer' }] });
  assert.equal(mwhaTopologySchema.safeParse(duplicate).success, false);
  assert.equal(mwhaTopologySchema.safeParse({ ...topology(3), extra: true }).success, false);
  assert.deepEqual(mwhaMemberRoles, ['voting-member', 'observer', 'writer']);
});

// ---------------------------------------------------------------------------
// Projection / Gate boundary
// ---------------------------------------------------------------------------

function projection(overrides: Partial<MwhaProjectionState> = {}): MwhaProjectionState {
  return {
    schema_version: MWHA_PROJECTION_STATE_SCHEMA_VERSION,
    conflict_key: { writer_id: 'w1', epoch: 1, local_seq: 1 },
    status: 'uncommitted',
    winning_branch_id: null,
    evidence_id: null,
    produces_gate_evidence: false,
    ...overrides,
  };
}

test('projection schema enforces the Gate boundary for every state', () => {
  assert.equal(mwhaProjectionStateSchema.safeParse(projection({ status: 'committed', winning_branch_id: 'branch-x', evidence_id: 'ev-1', produces_gate_evidence: true })).success, true);
  assert.equal(mwhaProjectionStateSchema.safeParse(projection({ status: 'conflicted', evidence_id: 'ev-1' })).success, false);
  assert.equal(mwhaProjectionStateSchema.safeParse(projection({ status: 'uncommitted', produces_gate_evidence: true })).success, false);
  assert.equal(mwhaProjectionStateSchema.safeParse(projection({ status: 'unknown' })).success, true);
});

test('gate assertions never let a conflicted/uncommitted branch produce evidence', () => {
  assert.equal(gateEvidenceIssue(projection()), null);
  assert.equal(gateEvidenceIssue(projection({ status: 'committed', winning_branch_id: 'branch-x', evidence_id: 'ev-1', produces_gate_evidence: true })), null);
  assert.match(gateEvidenceIssue(projection({ status: 'conflicted', evidence_id: 'ev-1' })) ?? '', /never enter Gate/);
  assert.throws(() => assertGateBoundary(projection({ status: 'uncommitted', produces_gate_evidence: true })), /PROJECTION_GATE_FORBIDDEN/);
});

// ---------------------------------------------------------------------------
// Clock diagnostics
// ---------------------------------------------------------------------------

function observation(overrides: Partial<MwhaClockObservation> = {}): MwhaClockObservation {
  return {
    member_id: 'm0',
    epoch: 1,
    observed_ms: 1_000,
    previous_observed_ms: null,
    reference_ms: null,
    ...overrides,
  };
}

test('rollback, future, jump, skew and unknown classify without side effects', () => {
  const policy = MWHA_CLOCK_DEFAULT_POLICY;
  const rollback = classifyClockObservation(observation({ observed_ms: 900, previous_observed_ms: 1_000 }));
  assert.equal(rollback.kind, 'rollback');
  const future = classifyClockObservation(observation({ observed_ms: 1_000 + policy.futureToleranceMs + 1, reference_ms: 1_000 }));
  assert.equal(future.kind, 'future');
  const jump = classifyClockObservation(observation({ observed_ms: policy.jumpThresholdMs + 1, reference_ms: 0 }));
  assert.equal(jump.kind, 'jump');
  const skew = classifyClockObservation(observation({ observed_ms: -(policy.skewToleranceMs + 1), reference_ms: 0 }));
  assert.equal(skew.kind, 'skew');
  const normal = classifyClockObservation(observation({ observed_ms: 1_000, reference_ms: 1_000 }));
  assert.equal(normal.kind, 'normal');
  const unknown = classifyClockObservation(observation());
  assert.equal(unknown.kind, 'unknown');
  for (const diagnosis of [rollback, future, jump, skew, normal, unknown]) {
    assert.equal(diagnosis.diagnostic_only, true);
    assert.equal(diagnosis.affects_commit_order, false);
    assert.equal(diagnosis.affects_fact_version, false);
  }
});

test('extreme clock values stay diagnostic and invalid observations fail closed', () => {
  const extreme = classifyClockObservation(observation({ observed_ms: Number.MAX_SAFE_INTEGER, reference_ms: 0 }));
  assert.equal(extreme.diagnostic_only, true);
  assert.equal(extreme.affects_commit_order, false);
  assert.throws(() => classifyClockObservation(observation({ member_id: '' })), /CLOCK_OBSERVATION_INVALID/);
  assert.throws(
    () => classifyClockObservation(observation(), { ...MWHA_CLOCK_DEFAULT_POLICY, skewToleranceMs: -1 }),
    /CLOCK_OBSERVATION_INVALID/,
  );
});

// ---------------------------------------------------------------------------
// Fault injection vocabulary and verification boundary
// ---------------------------------------------------------------------------

test('fault-injection vocabulary is fixed and scoped to the TCP protocol layer', () => {
  assert.deepEqual(mwhaFaultKinds, ['delay', 'drop', 'duplicate', 'reorder', 'disconnect', 'one-way-partition', 'bandwidth']);
  for (const kind of mwhaFaultKinds) {
    assert.equal(mwhaFaultInjectionSchema.safeParse({
      schema_version: MWHA_PROTOCOL_SCHEMA_VERSION,
      kind,
      target_member_id: 'm0',
      probability: 1,
      duration_ms: 10,
    }).success, true);
  }
  assert.equal(mwhaFaultInjectionSchema.safeParse({
    schema_version: MWHA_PROTOCOL_SCHEMA_VERSION,
    kind: 'kernel-panic',
    target_member_id: 'm0',
    probability: 1,
    duration_ms: 10,
  }).success, false);
  assert.equal(MWHA_FAULT_INJECTION_SCOPE_NOTE.includes('TCP 协议层故障注入 ≠ OS 真分区'), true);
  assert.equal(MWHA_FAULT_INJECTION_SCOPE_NOTE.includes('未验证'), true);
});

test('verification boundary constants exist and state the unverified capabilities', () => {
  assert.equal(MWHA_VERIFICATION_SCOPE, 'local-tcp-protocol-only');
  assert.equal(MWHA_VERIFICATION_SCOPE_NOTE.includes('未验证'), true);
  assert.deepEqual(MWHA_UNVERIFIED_CAPABILITIES, [
    'physical-three-machine-cluster',
    'os-level-network-partition',
    'cross-host-clock-rollback',
    'production-ha-failover',
    'availability-sla',
  ]);
  assert.equal(isUnverifiedCapability('production-ha-failover'), true);
  assert.equal(isUnverifiedCapability('local-tcp-protocol-only'), false);
});
