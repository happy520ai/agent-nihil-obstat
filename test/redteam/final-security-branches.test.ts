/**
 * T-152 / QF-03 final security branches (red team).
 *
 * Covers the security-critical enumeration of docs/evidence/final-quality-scope.md
 * §2 that lives outside the four pure-logic modules: quorum input validation,
 * epoch rollback without a lease, fencing/split-brain, the Gate evidence
 * boundary, forged projection/adjudication material, historical/uncommitted
 * evidence refusal, secret-path redaction and transport/workers authorization.
 *
 * Every assertion is positive AND negative: each guard is shown to refuse the
 * hostile input and to admit the matching legitimate input. No skip/todo/only.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import test, { type TestContext } from 'node:test';
import {
  HaProtocolError,
  MWHA_PROJECTION_STATE_SCHEMA_VERSION,
  assertFence,
  assertGateBoundary,
  assertQuorum,
  evaluateFence,
  evaluatePartitions,
  gateEvidenceIssue,
  isQuorum,
  makeBranchId,
  mwhaProjectionStateSchema,
  quorumSize,
  type MwhaAdjudication,
  type MwhaBranch,
  type MwhaEventIdentity,
  type MwhaLeaderLease,
  type MwhaProjectionState,
  type MwhaWriterEvent,
} from '../../src/memory/ha-protocol.ts';
import { compareDeclarations, assertSingleLeader } from '../../src/memory/leader-state.ts';
import {
  MultiWriterLog,
  projectMultiWriterState,
  type MultiWriterAdjudicationRecord,
  type MultiWriterEntryRecord,
} from '../../src/memory/multi-writer.ts';
import { injectDistributedConflicts } from '../../src/memory/probe-merge.ts';
import { judgeConsistency, type ClusterConsistencyExpectations } from '../../src/memory/cluster-consistency.ts';
import type {
  DistributedCandidateFingerprint,
  DistributedNodeReport,
  DistributedProbeAnswer,
  DistributedProbeMetadata,
} from '../../src/memory/distributed-probe.ts';
import type { AnchorProbeResponse, AnchorProbeSnapshot } from '../../src/memory/probe-contract.ts';
import { anchorProbeResponseSchema } from '../../src/memory/probe-contract.ts';
import { isSecretPath, shouldFollowLink } from '../../src/core/project-scan.ts';
import { executeEvidence } from '../../src/gate/evidence.ts';
import { authorizeReplica, createDefaultClusterPolicy } from '../../src/memory/cluster-policy.ts';
import { redactClientConfigEntry } from '../../src/clients/redact.ts';
import {
  ClientConfigError,
  assertSafeConfigPath,
  assertSafeServerPath,
  assertSafeTargetPath,
  sensitiveConfigPathReason,
} from '../../src/clients/config.ts';
import { runReplicaWorker } from '../../src/memory/replica-worker.ts';
import { ReplicationError } from '../../src/memory/replication.ts';
import {
  TcpReplicaClient,
  TcpReplicaServer,
  TcpTransportError,
  type TcpReplicaService,
} from '../../src/memory/tcp-transport.ts';
import { verifyTask } from '../../src/gate/verify.ts';
import { Ledger } from '../../src/ledger/ledger.ts';
import { GraphStore } from '../../src/structure/store.ts';
import {
  T152_AT,
  T152_HASH_A,
  T152_HASH_B,
  T152_HASH_C,
  T152_HASH_D,
  t152CodeOf,
  t152LedgerEvent,
} from '../helpers/t152-security-fixtures.ts';

const HASH = T152_HASH_A;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function identity(overrides: Partial<MwhaEventIdentity> = {}): MwhaEventIdentity {
  return { writer_id: 'w1', epoch: 1, term: 1, local_seq: 1, ledger_event_hash: HASH, ...overrides };
}

function lease(overrides: Partial<MwhaLeaderLease> = {}): MwhaLeaderLease {
  return { term: 1, leader_id: 'w1', epoch: 1, ...overrides };
}

function writerEvent(overrides: Partial<MwhaEventIdentity> = {}, leader: MwhaLeaderLease | null = lease()): MwhaWriterEvent {
  return { schema_version: 'mwha.event.v1', identity: identity(overrides), leader };
}

function branch(identityValue: MwhaEventIdentity): MwhaBranch {
  return {
    branch_id: makeBranchId(identityValue, identityValue.ledger_event_hash),
    identity: identityValue,
    ledger_event_hash: identityValue.ledger_event_hash,
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

function snap(overrides: Partial<AnchorProbeSnapshot> = {}): AnchorProbeSnapshot {
  return {
    project_scope: 'proj',
    ledger_digest: HASH,
    graph_revision: null,
    source_fingerprint: T152_HASH_B,
    connected_digest: null,
    ...overrides,
  };
}

function response(overrides: Record<string, unknown> = {}): AnchorProbeResponse {
  return {
    schema_version: 'anchorprobe.context.v1',
    request_id: 'req-1',
    context_id: 'ctx-1',
    snapshot: snap(),
    execution_status: 'OK',
    temporal_mode: 'CURRENT',
    budget_status: {
      stop_reason: 'FRONTIER_EXHAUSTED',
      retrieval_completeness: 'COMPLETE_WITHIN_DECLARED_SCOPE',
      nodes_visited: 1,
      frontier_remaining: 0,
    },
    coverage_gate: {
      status: 'SUFFICIENT',
      required_facts: ['local.storage.engine'],
      missing_facts: [],
      unresolved_conflicts: [],
      requirements_origin: 'caller_declared',
    },
    l1_invariants: [],
    active_evidence: [],
    deprecated_tombstones: [],
    gaps: [],
    conflicts: [],
    untrusted: true,
    ...overrides,
  } as AnchorProbeResponse;
}

function fingerprint(recordRef: string, sources: readonly string[]): DistributedCandidateFingerprint {
  return { record_ref: recordRef, content_hash: HASH, fact_key: 'local.storage.engine', status: 'active', sources };
}

function node(replicaId: string, overrides: Partial<DistributedNodeReport> = {}): DistributedNodeReport {
  return {
    replica_id: replicaId,
    outcome: 'OK',
    commit_index: null,
    evidence_digest: null,
    latency_ms: 0,
    detail: '',
    used: false,
    ...overrides,
  };
}

interface AnswerOverrides {
  readonly mode?: DistributedProbeMetadata['mode'];
  readonly requestedMode?: DistributedProbeMetadata['requested_mode'];
  readonly consistency?: DistributedProbeMetadata['consistency'];
  readonly origin?: DistributedProbeMetadata['evidence_origin'];
  readonly commitIndex?: number | undefined;
  readonly primaryCommitIndex?: number | undefined;
  readonly quorumSize?: number;
  readonly quorumCount?: number;
  readonly quorumDigests?: readonly string[];
  readonly stale?: boolean;
  readonly historical?: boolean;
  readonly partial?: boolean;
  readonly stopReason?: DistributedProbeMetadata['stop_reason'];
  readonly failedNodes?: readonly string[];
  readonly candidates?: readonly DistributedCandidateFingerprint[];
  readonly nodes?: readonly DistributedNodeReport[];
  readonly response?: AnchorProbeResponse;
  readonly metaMode?: string;
  readonly answerRequestedMode?: string;
}

function answer(overrides: AnswerOverrides = {}): DistributedProbeAnswer {
  const mode = overrides.mode ?? 'LOCAL';
  const metadata: DistributedProbeMetadata = {
    mode: (overrides.metaMode ?? mode) as DistributedProbeMetadata['mode'],
    requested_mode: (overrides.answerRequestedMode ?? overrides.requestedMode ?? mode) as DistributedProbeMetadata['requested_mode'],
    consistency: overrides.consistency ?? 'CONSISTENT',
    evidence_origin: overrides.origin ?? 'local',
    cluster_epoch: 'epoch-1',
    ...(overrides.commitIndex === undefined ? {} : { commit_index: overrides.commitIndex }),
    ...(overrides.primaryCommitIndex === undefined ? {} : { primary_commit_index: overrides.primaryCommitIndex }),
    evidence_digest: T152_HASH_C,
    quorum_size: overrides.quorumSize ?? 0,
    quorum_count: overrides.quorumCount ?? 0,
    quorum_digests: overrides.quorumDigests ?? [],
    stale: overrides.stale ?? false,
    historical: overrides.historical ?? mode === 'AS_OF',
    degraded: false,
    max_lag: null,
    partial: overrides.partial ?? false,
    stop_reason: overrides.stopReason ?? 'NONE',
  };
  const candidates = overrides.candidates ?? [fingerprint('r-a', ['local'])];
  const nodes = overrides.nodes ?? [node('local', { used: true })];
  return {
    request_id: 'req-1',
    outcome: 'CONSISTENT',
    mode: metadata.mode,
    requested_mode: metadata.requested_mode,
    consistency: metadata.consistency,
    degraded: false,
    evidence_origin: metadata.evidence_origin,
    metadata,
    response: overrides.response ?? response(),
    candidates,
    conflicts: [],
    partial: { coverage: 1, considered: candidates.length, requested: candidates.length, gaps: [], failed_nodes: overrides.failedNodes ?? [], stop_reason: metadata.stop_reason },
    nodes,
    elapsed_ms: 1,
    resources_released: true,
  };
}

function expectations(overrides: Partial<ClusterConsistencyExpectations> = {}): ClusterConsistencyExpectations {
  return { mode: 'QUORUM', ...overrides };
}

function quorumAnswer(overrides: AnswerOverrides = {}): DistributedProbeAnswer {
  return answer({
    mode: 'QUORUM',
    requestedMode: 'QUORUM',
    origin: 'replica',
    commitIndex: 10,
    primaryCommitIndex: 10,
    quorumSize: 2,
    quorumCount: 2,
    quorumDigests: [T152_HASH_D],
    candidates: [fingerprint('r-a', ['replica-0', 'replica-1'])],
    nodes: [node('local'), node('replica-0', { commit_index: 10, used: true }), node('replica-1', { commit_index: 10, used: true })],
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// 1. quorum
// ---------------------------------------------------------------------------

test('T-152 quorum: out-of-range or non-integer votes are refused, majority boundaries hold', () => {
  for (const votes of [-1, 4, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => isQuorum(votes, 3), (error: unknown) => error instanceof HaProtocolError && error.code === 'QUORUM_INPUT_INVALID', String(votes));
  }
  // Positive control: in-range minority and majority.
  assert.equal(isQuorum(0, 3), false);
  assert.equal(isQuorum(2, 3), true);
  // N=2 needs both votes; a single vote is a minority and never commits.
  assert.equal(isQuorum(1, 2), false);
  assert.throws(() => assertQuorum(1, 2), /QUORUM_NOT_REACHED/);
  assert.doesNotThrow(() => assertQuorum(2, 2));
  assert.equal(quorumSize(2), 2);
});

test('T-152 quorum: partition evaluation refuses malformed sizes and keeps the exact-quorum boundary', () => {
  assert.throws(
    () => evaluatePartitions('nope' as unknown as readonly number[], 3),
    (error: unknown) => error instanceof HaProtocolError && error.code === 'QUORUM_INPUT_INVALID',
  );
  for (const sizes of [[0], [4], [1.5], [Number.NaN]]) {
    assert.throws(
      () => evaluatePartitions(sizes as number[], 3),
      (error: unknown) => error instanceof HaProtocolError && error.code === 'QUORUM_INPUT_INVALID',
      JSON.stringify(sizes),
    );
  }
  const split = evaluatePartitions([1, 2, 2], 3);
  assert.deepEqual(split.committing_partitions, [2, 2]);
  assert.deepEqual(split.blocked_partitions, [1]);
  assert.equal(split.any_commit, true);
  const minority = evaluatePartitions([1, 1], 3);
  assert.equal(minority.any_commit, false);
  assert.deepEqual(minority.blocked_partitions, [1, 1]);
  assert.equal(evaluatePartitions([3], 3).any_commit, true);
});

test('T-152 quorum: QUORUM judgement refuses an unknown primary, invalid size, empty digests and a commit above the primary', () => {
  const base = quorumAnswer();
  // Positive control.
  const ok = judgeConsistency(base, expectations({ primaryCommitIndex: 10 }));
  assert.equal(ok.status, 'consistent');

  // No primary commit point anywhere: fail closed instead of assuming a bound.
  const noPrimary = judgeConsistency(
    quorumAnswer({ primaryCommitIndex: undefined, commitIndex: undefined }),
    expectations(),
  );
  assert.equal(noPrimary.status, 'inconsistent');
  assert.equal(noPrimary.code, 'PRIMARY_COMMIT_UNKNOWN');

  // Invalid explicit quorum threshold directions.
  for (const quorumSize of [0, -1, 1.5, Number.NaN]) {
    const judgement = judgeConsistency(
      quorumAnswer({ quorumSize: 2 }),
      expectations({ primaryCommitIndex: 10, quorumSize }),
    );
    assert.equal(judgement.status, 'inconsistent', String(quorumSize));
    assert.equal(judgement.code, 'QUORUM_DIGEST_DIVERGENCE', String(quorumSize));
    assert.ok(judgement.reasons.some((reason) => reason.includes('not a positive integer')), String(quorumSize));
  }

  // Empty digest set cannot establish a majority at one version.
  const empty = judgeConsistency(quorumAnswer({ quorumDigests: [] }), expectations({ primaryCommitIndex: 10 }));
  assert.equal(empty.code, 'QUORUM_DIGEST_DIVERGENCE');
  assert.ok(empty.reasons.some((reason) => reason.includes('quorum digests are empty')));

  // A quorum commit above the primary upper bound is contradictory.
  const ahead = judgeConsistency(
    quorumAnswer({ commitIndex: 11, primaryCommitIndex: 10, quorumDigests: [T152_HASH_D] }),
    expectations({ primaryCommitIndex: 10 }),
  );
  assert.equal(ahead.status, 'inconsistent');
  assert.equal(ahead.code, 'COMMIT_BEHIND_PRIMARY');
  assert.ok(ahead.reasons.some((reason) => reason.includes('exceeds the primary commit point')));
});

// ---------------------------------------------------------------------------
// 2. epoch
// ---------------------------------------------------------------------------

test('T-152 epoch: a lease-less candidate cannot roll the multi-writer epoch backwards', () => {
  const log = new MultiWriterLog();
  const accepted = log.append({
    event: writerEvent({ epoch: 3 }, lease({ term: 1, leader_id: 'w1', epoch: 3 })),
    ledgerEvent: t152LedgerEvent('epoch-advance', 1),
    ledgerEventHash: HASH,
    commitIndex: 1,
  });
  assert.equal(accepted.kind, 'fresh');

  // Same writer, no lease attached, older epoch: FENCE_EPOCH_ROLLBACK.
  expectHaError(
    () => log.append({
      event: writerEvent({ ledger_event_hash: T152_HASH_B }, null),
      ledgerEvent: t152LedgerEvent('epoch-rollback', 2),
      ledgerEventHash: T152_HASH_B,
      commitIndex: 2,
    }),
    'FENCE_EPOCH_ROLLBACK',
  );
  assert.equal(log.size, 1, 'a fenced append must not mutate the log');

  // Positive control: an equal-or-newer lease-less epoch is admitted as a proposal.
  const newer = log.append({
    event: writerEvent({ ledger_event_hash: T152_HASH_C, epoch: 4 }, null),
    ledgerEvent: t152LedgerEvent('epoch-newer', 3),
    ledgerEventHash: T152_HASH_C,
    commitIndex: 0,
    status: 'proposed',
  });
  assert.equal(newer.kind, 'fresh');
});

test('T-152 evidence: append refuses an invalid commit index and derives the entry status from it', () => {
  const log = new MultiWriterLog();
  for (const [index, commitIndex] of [[1, -1], [2, 1.5], [3, Number.NaN], [4, Number.POSITIVE_INFINITY]] as const) {
    expectHaError(
      () => log.append({
        event: writerEvent({ ledger_event_hash: String(index).repeat(64).slice(0, 64) }),
        ledgerEvent: t152LedgerEvent(`bad-commit-${String(index)}`, index),
        ledgerEventHash: String(index).repeat(64).slice(0, 64),
        commitIndex,
      }),
      'HA_INPUT_INVALID',
    );
  }
  assert.equal(log.size, 0, 'refused appends must not mutate the log');

  // Positive control: zero derives `proposed`, a positive index derives `committed`.
  const proposed = log.append({
    event: writerEvent({ ledger_event_hash: HASH }, lease()),
    ledgerEvent: t152LedgerEvent('proposed', 11),
    ledgerEventHash: HASH,
    commitIndex: 0,
  });
  assert.equal(proposed.entry.entry.status, 'proposed');
  const committed = log.append({
    event: writerEvent({ ledger_event_hash: T152_HASH_B }),
    ledgerEvent: t152LedgerEvent('committed', 12),
    ledgerEventHash: T152_HASH_B,
    commitIndex: 3,
  });
  assert.equal(committed.entry.entry.status, 'committed');
});

// ---------------------------------------------------------------------------
// 3. fencing / split brain
// ---------------------------------------------------------------------------

test('T-152 fencing: malformed leases are refused as FENCE_INVALID before any epoch comparison', () => {
  const valid = lease();
  const malformedCurrent = evaluateFence({ ...valid, term: Number.NaN }, valid);
  assert.equal(malformedCurrent.allowed, false);
  assert.equal(malformedCurrent.code, 'FENCE_INVALID');
  const malformedCandidate = evaluateFence(valid, { ...valid, leader_id: '' });
  assert.equal(malformedCandidate.allowed, false);
  assert.equal(malformedCandidate.code, 'FENCE_INVALID');
  assert.throws(() => assertFence(valid, { ...valid, epoch: -1 }), /FENCE_INVALID/);
  // Positive control: the same lease is allowed.
  assert.equal(evaluateFence(valid, valid).code, 'FENCE_OK');
});

test('T-152 fencing: declaration ordering tie-breaks deterministically and assertSingleLeader refuses two masters', () => {
  const left = lease({ leader_id: 'A' });
  const right = lease({ leader_id: 'B' });
  assert.equal(compareDeclarations(left, right), -1);
  assert.equal(compareDeclarations(right, left), 1);
  assert.equal(compareDeclarations(left, lease({ leader_id: 'A' })), 0);
  assert.equal(compareDeclarations(lease({ epoch: 2 }), lease({ epoch: 1 })), 1);

  assert.doesNotThrow(() => assertSingleLeader([left]));
  assert.throws(
    () => assertSingleLeader([left, right]),
    (error: unknown) => error instanceof HaProtocolError && error.code === 'SPLIT_BRAIN',
  );
  // Different terms are not a split brain.
  assert.doesNotThrow(() => assertSingleLeader([left, lease({ leader_id: 'B', term: 2 })]));
});

test('T-152 fencing: adjudication cannot invent, rename or partially describe retained branches', () => {
  const log = new MultiWriterLog();
  for (const hash of [HASH, T152_HASH_B, T152_HASH_C]) {
    log.append({
      event: writerEvent({ ledger_event_hash: hash }),
      ledgerEvent: t152LedgerEvent(`adj-${hash.slice(0, 1)}`, hash.charCodeAt(0)),
      ledgerEventHash: hash,
      commitIndex: 1,
    });
  }
  const actual = log.forkReport().conflicts[0]!.branches;
  assert.equal(actual.length, 3);

  const baseAdjudication = (branches: readonly MwhaBranch[], selected: string): MwhaAdjudication => ({
    schema_version: 'mwha.adjudication.v1',
    conflict_key: { writer_id: 'w1', epoch: 1, local_seq: 1 },
    branches: [...branches],
    branch_hashes: branches.map((entry) => entry.ledger_event_hash),
    status: 'resolved',
    selected_branch_id: selected,
    resolution_reason: 't152 forged adjudication',
  });

  // No committed branch exists for this slot at all: fail before describing branches.
  const absentKey = { writer_id: 'w1', epoch: 1, local_seq: 99 } as const;
  expectHaError(
    () => log.adjudicate({
      schema_version: 'mwha.adjudication.v1',
      conflict_key: absentKey,
      branches: [
        branch(identity({ local_seq: 99, ledger_event_hash: T152_HASH_D })),
        branch(identity({ local_seq: 99, ledger_event_hash: 'e'.repeat(64) })),
      ],
      branch_hashes: [T152_HASH_D, 'e'.repeat(64)],
      status: 'resolved',
      selected_branch_id: makeBranchId(identity({ local_seq: 99 }), T152_HASH_D),
      resolution_reason: 't152 forged adjudication for an absent slot',
    }),
    'ADJUDICATION_INVALID',
  );
  assert.equal(log.getAdjudications().length, 0);

  // A branch_id that is not derived from its ledger hash is rejected.
  const renamed = actual.map((entry, index) => (index === 0 ? { ...entry, branch_id: 'branch-forged' } : entry));
  expectHaError(() => log.adjudicate(baseAdjudication(renamed, renamed[0]!.branch_id)), 'ADJUDICATION_INVALID');

  // A branch whose identity disagrees with the retained branch is rejected.
  const mismatched = actual.map((entry, index) => (
    index === 0 ? { ...entry, identity: { ...entry.identity, term: 99 } } : entry
  ));
  expectHaError(() => log.adjudicate(baseAdjudication(mismatched, mismatched[0]!.branch_id)), 'ADJUDICATION_INVALID');

  // Positive control: the genuine complete branch set still resolves.
  const genuine = baseAdjudication(actual, actual[0]!.branch_id);
  const stored = log.adjudicate(genuine);
  assert.equal(stored.branches.length, 3);
});

// ---------------------------------------------------------------------------
// 4. forged evidence / Gate boundary
// ---------------------------------------------------------------------------

test('T-152 Gate: every projection state satisfies the evidence boundary in both directions', () => {
  const committed = {
    schema_version: MWHA_PROJECTION_STATE_SCHEMA_VERSION,
    conflict_key: { writer_id: 'w1', epoch: 1, local_seq: 1 },
    status: 'committed',
    winning_branch_id: 'branch-x',
    evidence_id: 'ev-1',
    produces_gate_evidence: true,
  } as MwhaProjectionState;
  assert.equal(gateEvidenceIssue(committed), null);
  assert.doesNotThrow(() => assertGateBoundary(committed));

  const committedNoEvidence = { ...committed, evidence_id: null } as MwhaProjectionState;
  assert.match(gateEvidenceIssue(committedNoEvidence) ?? '', /must carry an evidence_id/);
  assert.throws(() => assertGateBoundary(committedNoEvidence), /PROJECTION_GATE_FORBIDDEN/);

  const committedNoFlag = { ...committed, produces_gate_evidence: false } as MwhaProjectionState;
  assert.match(gateEvidenceIssue(committedNoFlag) ?? '', /produces_gate_evidence=true/);

  for (const status of ['uncommitted', 'conflicted'] as const) {
    const clean = { ...committed, status, winning_branch_id: null, evidence_id: null, produces_gate_evidence: false } as MwhaProjectionState;
    assert.equal(gateEvidenceIssue(clean), null);
    assert.doesNotThrow(() => assertGateBoundary(clean));

    const withEvidence = { ...clean, evidence_id: 'ev-forged' } as MwhaProjectionState;
    assert.match(gateEvidenceIssue(withEvidence) ?? '', /never enter Gate/);
    assert.throws(() => assertGateBoundary(withEvidence), /PROJECTION_GATE_FORBIDDEN/);

    const withFlag = { ...clean, produces_gate_evidence: true } as MwhaProjectionState;
    assert.match(gateEvidenceIssue(withFlag) ?? '', /cannot produce Gate evidence/);
  }

  // The schema independently rejects the same forgery shapes.
  assert.equal(mwhaProjectionStateSchema.safeParse(committedNoEvidence).success, false);
  assert.equal(mwhaProjectionStateSchema.safeParse({ ...committed, status: 'conflicted', evidence_id: 'ev-1' }).success, false);
});

test('T-152 Gate: injectDistributedConflicts can never leave SUFFICIENT while a divergence is unresolved', () => {
  const sufficient = response();
  assert.equal(sufficient.coverage_gate.status, 'SUFFICIENT');

  const injected = injectDistributedConflicts(sufficient, [{
    conflict_id: 't152-conflict-1',
    kind: 'commit',
    fact_key: null,
    record_ref: null,
    nodes: ['replica-0', 'replica-1'],
    content_hashes: [],
    statuses: [],
    commits: [9, 10],
    epochs: [],
    status: 'unresolved',
  }]);
  assert.equal(injected.coverage_gate.status, 'INSUFFICIENT');
  assert.equal(injected.conflicts.length, 1);
  assert.equal(injected.conflicts[0]!.record_refs.join(','), 'replica-0,replica-1');
  assert.equal(injected.conflicts[0]!.fact_key, 'distributed.commit');
  assert.ok(injected.coverage_gate.unresolved_conflicts.includes(injected.conflicts[0]!.conflict_id));

  // An already-non-SUFFICIENT gate keeps its status but still records the conflict.
  const alreadyInsufficient = injectDistributedConflicts(
    { ...sufficient, coverage_gate: { ...sufficient.coverage_gate, status: 'INSUFFICIENT' } },
    [{ conflict_id: 't152-conflict-2', kind: 'cluster_epoch', fact_key: null, record_ref: 'rec-1', nodes: [], content_hashes: [], statuses: [], commits: [], epochs: ['epoch-1', 'epoch-2'], status: 'unresolved' }],
  );
  assert.equal(alreadyInsufficient.coverage_gate.status, 'INSUFFICIENT');
  assert.equal(alreadyInsufficient.conflicts[0]!.fact_key, 'distributed.cluster_epoch');
  assert.deepEqual(alreadyInsufficient.conflicts[0]!.record_refs, ['rec-1']);

  // Null record_ref with no nodes falls back to the literal "distributed" ref.
  const noNodes = injectDistributedConflicts(sufficient, [{
    conflict_id: 't152-conflict-3', kind: 'content_hash', fact_key: null, record_ref: null, nodes: [], content_hashes: [], statuses: [], commits: [], epochs: [], status: 'unresolved',
  }]);
  assert.deepEqual(noNodes.conflicts[0]!.record_refs, ['distributed']);
  assert.equal(noNodes.conflicts[0]!.fact_key, 'distributed.record');

  // Duplicate conflict ids are injected once, and an empty conflict set is a no-op.
  const conflict = { conflict_id: 't152-conflict-4', kind: 'commit' as const, fact_key: null, record_ref: null, nodes: ['r'], content_hashes: [], statuses: [], commits: [1], epochs: [], status: 'unresolved' as const };
  const first = injectDistributedConflicts(sufficient, [conflict]);
  const second = injectDistributedConflicts(first, [conflict]);
  assert.equal(second.conflicts.length, 1);
  assert.equal(injectDistributedConflicts(sufficient, []).coverage_gate.status, 'SUFFICIENT');
});

test('T-152 Gate: a forged committed projection without evidence is refused even when injected directly', () => {
  const record: MultiWriterEntryRecord = {
    entry: {
      schema_version: 'mwha.cluster-log-entry.v1',
      identity: identity({ local_seq: 1 }),
      leader: lease(),
      status: 'committed',
      commit_index: 1,
      conflict_key: null,
    },
    ledgerEvent: t152LedgerEvent('projection', 4),
    ledgerEventHash: HASH,
    evidenceId: null,
    delivery: 'fresh',
  };
  const forged: MultiWriterAdjudicationRecord = {
    adjudication: {
      schema_version: 'mwha.adjudication.v1',
      conflict_key: { writer_id: 'w1', epoch: 1, local_seq: 1 },
      branches: [branch(identity({ local_seq: 1 }))],
      branch_hashes: [HASH],
      status: 'resolved',
      selected_branch_id: null,
      resolution_reason: 'forged',
    },
    conflict_key: { writer_id: 'w1', epoch: 1, local_seq: 1 },
    branches: [branch(identity({ local_seq: 1 }))],
    evidenceId: null,
  };
  assert.throws(
    () => projectMultiWriterState([record], [forged]),
    (error: unknown) => t152CodeOf(error) === 'PROJECTION_GATE_FORBIDDEN',
  );

  // Positive control: a genuine resolved adjudication with evidence projects.
  const genuine: MultiWriterAdjudicationRecord = { ...forged, adjudication: { ...forged.adjudication, selected_branch_id: makeBranchId(identity({ local_seq: 1 }), HASH) }, evidenceId: 'ev-real' };
  const projection = projectMultiWriterState([record], [genuine]);
  assert.equal(projection.states[0]!.status, 'committed');
  assert.equal(projection.states[0]!.evidence_id, 'ev-real');
  assertGateBoundary(projection.states[0]!);
});

test('T-152 evidence: consistency judgement refuses answers carrying unknown probe modes', () => {
  assert.throws(
    () => judgeConsistency(answer({ metaMode: 'EVENTUAL' }), expectations({ mode: 'LOCAL' })),
    TypeError,
  );
  assert.throws(
    () => judgeConsistency(answer({ answerRequestedMode: 'WHEN' }), expectations({ mode: 'LOCAL' })),
    TypeError,
  );
});

// ---------------------------------------------------------------------------
// 5. uncommitted / historical evidence must not upgrade a Gate
// ---------------------------------------------------------------------------

test('T-152 history: requested-mode mismatch and partial-without-failure stay visible', () => {
  // The answer was requested under a different mode than the caller expects.
  const wrongRequest = judgeConsistency(quorumAnswer({ requestedMode: 'COMMITTED' }), expectations({ mode: 'QUORUM', primaryCommitIndex: 10 }));
  assert.equal(wrongRequest.status, 'inconsistent');
  assert.equal(wrongRequest.code, 'MODE_UNMET');
  assert.ok(wrongRequest.reasons.some((reason) => reason.includes('requested as COMMITTED')));

  // partial=true with neither failed nodes nor a stop reason is reported, not hidden.
  const quietPartial = judgeConsistency(quorumAnswer({ partial: true }), expectations({ primaryCommitIndex: 10 }));
  assert.ok(quietPartial.reasons.some((reason) => reason.includes('partial coverage without a failed node')));

  // Historical evidence from a non-AS_OF request is blocked; current-execution basis refuses historical/stale.
  const historical = judgeConsistency(quorumAnswer({ historical: true, stale: false }), expectations({ mode: 'QUORUM', primaryCommitIndex: 10 }));
  assert.equal(historical.status, 'blocked');
  assert.equal(historical.code, 'HISTORICAL_NOT_EXECUTABLE');

  const staleAsOf = judgeConsistency(
    answer({ mode: 'AS_OF', requestedMode: 'AS_OF', commitIndex: 10, historical: true, stale: true }),
    expectations({ mode: 'AS_OF', asOfCommitIndex: 10, currentExecution: true }),
  );
  assert.equal(staleAsOf.status, 'blocked');
  assert.equal(staleAsOf.code, 'HISTORICAL_NOT_EXECUTABLE');

  // Positive control: an explicit AS_OF read may use historical evidence.
  const asOf = judgeConsistency(
    answer({ mode: 'AS_OF', requestedMode: 'AS_OF', commitIndex: 10, historical: true }),
    expectations({ mode: 'AS_OF', asOfCommitIndex: 10 }),
  );
  assert.notEqual(asOf.status, 'blocked');
});

test('T-152 gate: a source file created during the test run makes the graph stale and blocks the task', { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 't152-verify-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'test'), { recursive: true });
  writeFileSync(join(root, '.gitignore'), '.ano/\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  // The fixture creates a NEW source file while the verification runs: the
  // graph must become stale and the task must not be completed.
  writeFileSync(
    join(root, 'test', 'a.test.ts'),
    "import test from 'node:test';import { writeFileSync } from 'node:fs';test('a', () => { writeFileSync('src/added-during-run.ts', 'export const added = 1;\\n'); });\n",
  );
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'ano@localhost'], ['config', 'user.name', 'ano'], ['add', '.'], ['commit', '-qm', 'base']]) {
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  }

  const ledger = await Ledger.open(root, { sessionId: 'T152-VERIFY' });
  const graph = await GraphStore.open(root);
  try {
    await ledger.createTask('T', ['test/a.test.ts']);
    await ledger.updateTask('T', { status: 'in_progress' });

    const verdict = await verifyTask(root, 'T', {
      argv: [process.execPath, '--test', 'test/a.test.ts'],
      testFiles: ['test/a.test.ts'],
      idemKey: 't152-added-source',
    }, { ledger, graph });

    assert.equal(verdict.freshness.status, 'stale', 'a source file added during the run must make the graph stale');
    assert.equal(verdict.status, 'blocked');
    assert.equal(ledger.getTask('T')?.status, 'in_progress', 'a run that changes the source tree must not complete the task');
  } finally {
    ledger.close();
    graph.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('T-152 authz: an authorize denial without a code falls back to the operator default reason', { timeout: 60_000 }, async (t) => {
  const SECRET = randomBytes(32).toString('hex');
  const HASH = 'a'.repeat(64);

  class MinimalService implements TcpReplicaService {
    async query(): Promise<never> {
      throw new Error('the query must never run: authorization refuses first');
    }
  }

  // The decision type allows {allowed:false} without code/reason; the server
  // must then fall back to the operator-facing default code and reason.
  const server = new TcpReplicaServer({
    host: '127.0.0.1',
    port: 0,
    sharedSecret: SECRET,
    authorize: () => ({ allowed: false }),
    service: new MinimalService(),
  });
  await server.listen();
  t.after(async () => {
    await server.close();
  });

  const client = new TcpReplicaClient({ host: '127.0.0.1', port: server.address!.port, nodeId: 'node-a', sharedSecret: SECRET });
  t.after(async () => {
    await client.close();
  });
  await client.connect();

  await assert.rejects(
    () => client.query({ schema_version: 'anchorprobe.request.v1', request_id: 't152-fallback', root: 'F:/p', project_scope: 'proj' } as never),
    (error: unknown) => {
      assert.ok(error instanceof TcpTransportError);
      assert.equal(error.code, 'OPERATION_FORBIDDEN');
      assert.match(error.message, /authorize callback refused the operation/u);
      return true;
    },
  );
  assert.equal(server.activeConnectionCount, 1, 'a refused operation must not kill the listener');
});

test('T-152 authz: an unknown operation throws and a scoped allow-list denies cross-project reads', () => {
  const policy = createDefaultClusterPolicy('proj', {
    replicas: [{ replicaId: 'r-t152', allowedScopes: ['proj'], operations: ['read'] }],
  });
  // Unknown operation vocabulary is refused deterministically (cluster-policy:318-320).
  assert.throws(
    () => authorizeReplica(policy, 'r-t152', 'bogus' as never, 'proj'),
    (error: unknown) => t152CodeOf(error) === 'OPERATION_FORBIDDEN',
  );
  // Known operation the replica does not hold.
  const forbidden = authorizeReplica(policy, 'r-t152', 'apply', 'proj');
  assert.equal(forbidden.allowed, false);
  assert.equal(forbidden.allowed === false ? forbidden.code : '', 'OPERATION_FORBIDDEN');
  // Cross-project scope on a known read.
  const crossScope = authorizeReplica(policy, 'r-t152', 'read', 'other-project');
  assert.equal(crossScope.allowed, false);
  assert.equal(crossScope.allowed === false ? crossScope.code : '', 'SCOPE_DENIED');
});

test('T-152 evidence: a command whose spawn throws synchronously is captured as an error, never an unhandled rejection', async () => {
  const sourceFingerprint = 'a'.repeat(64);
  const cases: ReadonlyArray<{ argv: string[]; timeoutMs: number; marker: string }> = [
    { argv: ['node\u0000'], timeoutMs: 1_000, marker: 'null bytes' },
    { argv: ['node', '--eval', '1'], timeoutMs: -1, marker: 'out-of-range timeout' },
  ];
  for (const item of cases) {
    const evidence = await executeEvidence({ argv: item.argv, cwd: process.cwd(), timeoutMs: item.timeoutMs }, sourceFingerprint, 't152-rev');
    assert.equal(evidence.exitCode, null, item.marker);
    assert.equal(evidence.timedOut, false, item.marker);
    assert.equal(evidence.ok, false, item.marker);
    assert.equal(typeof evidence.error, 'string', item.marker);
    assert.ok((evidence.error ?? '').length > 0, item.marker);
    assert.equal(evidence.counts.tests ?? 0, 0, item.marker);
  }
});

// ---------------------------------------------------------------------------
// 6. secret paths / redaction
// ---------------------------------------------------------------------------

test('T-152 secrets: project-scan never re-admits secret paths and never follows secret links', () => {
  const secretPaths = [
    '.env',
    '.env.local',
    'config/.env.production',
    'id_rsa',
    'id_ed25519',
    'keys/server.pem',
    'keys/server.key',
    'secrets/value.ts',
    'credentials.json',
    'nested/secret/file.txt',
  ];
  for (const path of secretPaths) assert.equal(isSecretPath(path), true, path);
  for (const path of ['src/index.ts', 'docs/env.md', 'public/keyhole.ts', 'credentials.example.json', 'my-secrets-notes.md']) {
    assert.equal(isSecretPath(path), false, path);
  }

  // followLinks=true still refuses a secret link; non-secret links follow only when opted in.
  assert.equal(shouldFollowLink('.env', true), false);
  assert.equal(shouldFollowLink('secrets/value.ts', true), false);
  assert.equal(shouldFollowLink('src/index.ts', true), true);
  assert.equal(shouldFollowLink('src/index.ts', false), false);
  assert.equal(shouldFollowLink('src/index.ts'), false);
});

test('T-152 secrets: client-config entry redaction copies only safe fields and names secret containers', () => {
  const redacted = redactClientConfigEntry({
    type: 'stdio',
    command: 'ano',
    args: ['x'],
    env: { API_KEY: 'super-secret', OTHER: 'value' },
    headers: { Authorization: 'Bearer secret' },
    authentication: { token: 'secret' },
    enabled: true,
  });
  assert.equal(redacted['type'], 'stdio');
  assert.equal(redacted['command'], 'ano');
  assert.deepEqual(redacted['args'], ['x']);
  assert.equal(redacted['enabled'], true);
  assert.deepEqual(redacted['envKeys'], ['API_KEY', 'OTHER']);
  assert.deepEqual(redacted['headersKeys'], ['Authorization']);
  assert.deepEqual(redacted['authenticationKeys'], ['token']);
  assert.equal(redacted['redacted'], true);
  const serialized = JSON.stringify(redacted);
  for (const marker of ['super-secret', 'Bearer secret', 'secret']) assert.equal(serialized.includes(marker), false, marker);

  // Non-object inputs are reported by kind and never throw.
  assert.deepEqual(redactClientConfigEntry(null), { valueKind: 'object' });
  assert.deepEqual(redactClientConfigEntry([]), { valueKind: 'array' });
  assert.deepEqual(redactClientConfigEntry('text'), { valueKind: 'string' });
  assert.deepEqual(redactClientConfigEntry(42), { valueKind: 'number' });
  assert.deepEqual(redactClientConfigEntry(true), { valueKind: 'boolean' });

  // A secret container with a non-object value contributes no keys.
  const weird = redactClientConfigEntry({ env: 'RAW', headers: null, type: 'http' });
  assert.equal(weird['envKeys'], undefined);
  assert.equal(weird['headersKeys'], undefined);
  assert.equal(weird['type'], 'http');
  assert.equal(weird['redacted'], true);
});

test('T-152 secrets: client config path safety refuses environment/credential/key targets', () => {
  const sensitive = [
    ['.env', 'environment file'],
    ['.env.local', 'environment file'],
    ['config/secrets/app.json', 'sensitive directory'],
    ['config/credentials/app.json', 'sensitive directory'],
    ['tokens/store.json', 'sensitive directory'],
    ['private-keys/app.json', 'sensitive directory'],
    ['credentials.json', 'credential store'],
    ['client_secret', 'sensitive file name'],
    ['my.api_key', 'sensitive file name'],
    ['private_key', 'sensitive file name'],
    ['keys/server.pem', 'key material'],
    ['keys/id_rsa', 'ssh private key'],
  ] as const;
  for (const [path, reason] of sensitive) {
    assert.equal(sensitiveConfigPathReason(path), reason, path);
    assert.throws(() => assertSafeConfigPath(path), (error: unknown) => error instanceof ClientConfigError && error.code === 'CLIENT_CONFIG_PATH', path);
  }
  for (const path of ['src/index.ts', 'package.json', 'config/claude.json', 'docs/api-key.md']) {
    assert.equal(sensitiveConfigPathReason(path), null, path);
    assert.doesNotThrow(() => assertSafeConfigPath(path), path);
  }

  // Reserved object keys and malformed server paths are refused.
  for (const serverPath of [[], ['__proto__'], ['prototype'], ['constructor'], [''], ['a\0b'], [42] as unknown as string[]]) {
    assert.throws(() => assertSafeServerPath(serverPath), (error: unknown) => error instanceof ClientConfigError && error.code === 'CLIENT_CONFIG_PATH', JSON.stringify(serverPath));
  }
  assert.doesNotThrow(() => assertSafeServerPath(['servers', 'ano']));

  const root = mkdtempSync(join(tmpdir(), 't152-config-'));
  try {
    const target = (path: string, allowedRoot: string, serverPath: readonly string[] = ['servers', 'ano']) =>
      ({ clientId: 'claude-code', scope: 'project' as const, path, format: 'json' as const, allowedRoot, serverPath, serverName: 'ano' });
    // Escaping the declared scope is refused.
    assert.throws(() => assertSafeTargetPath(target(join(root, '..', 'outside.json'), root)), /escapes the declared scope/u);
    // A sensitive target is refused even inside the scope.
    assert.throws(() => assertSafeTargetPath(target(join(root, '.env'), root)), /sensitive location/u);
    // A benign existing file inside the scope is accepted.
    const benign = join(root, 'config.json');
    writeFileSync(benign, '{}\n');
    assert.equal(assertSafeTargetPath(target(benign, root)), benign);
    // Caller-envelope directions: empty path/root/serverName are refused.
    assert.throws(() => assertSafeTargetPath(target('', root)), /Config path must be a non-empty string/u);
    assert.throws(() => assertSafeTargetPath(target(benign, '')), /allowedRoot must be a non-empty string/u);
    assert.throws(() => assertSafeTargetPath({ ...target(benign, root), serverName: '' }), /serverName must be a non-empty string/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 7. authorization (worker transport)
// ---------------------------------------------------------------------------

test('T-152 authz: a replica worker refuses a cross-scope query with SCOPE_DENIED and serves its own scope', { timeout: 60_000 }, async (t: TestContext) => {
  const root = mkdtempSync(join(tmpdir(), 't152-worker-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const input = new PassThrough();
  const output = new PassThrough();
  // `terminate()` calls `process.exit`; stub it so an in-process worker cannot
  // kill the test runner, then end stdin to trigger the deterministic shutdown.
  const originalExit = process.exit.bind(process);
  (process as unknown as { exit: (code?: number) => void }).exit = () => {};
  let buffer = '';
  const lines: Record<string, unknown>[] = [];
  output.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim().length === 0) continue;
      lines.push(JSON.parse(line) as Record<string, unknown>);
    }
  });

  runReplicaWorker({ input, output, heartbeatMs: 0, maxMessageBytes: 1_048_576 });

  const waitForLines = (count: number): Promise<void> => {
    if (lines.length >= count) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${String(count)} worker response lines`)), 5_000);
      timer.unref?.();
      const onData = (): void => {
        if (lines.length < count) return;
        clearTimeout(timer);
        output.off('data', onData);
        resolve();
      };
      output.on('data', onData);
    });
  };

  input.write(`${JSON.stringify({
    type: 'init',
    id: 't152-init',
    payload: { root, replicaId: 'r-t152', projectScope: 'proj' },
  })}\n`);
  await waitForLines(1);
  assert.equal(lines.at(-1)!.ok, true);

  const query = (scope: string): Record<string, unknown> => ({
    type: 'query',
    id: `t152-query-${scope}`,
    payload: {
      schema_version: 'anchorprobe.request.v1',
      request_id: `req-${scope}`,
      root: 'F:/project',
      project_scope: scope,
      required_facts: ['local.storage.engine'],
    },
  });

  // Positive control: the replica's own scope is served.
  input.write(`${JSON.stringify(query('proj'))}\n`);
  await waitForLines(2);
  assert.equal(lines.at(-1)!.ok, true);
  const served = lines.at(-1)!.payload as { snapshot?: { project_scope?: string } };
  assert.equal(served.snapshot?.project_scope, 'proj');

  // Negative control: a foreign scope is refused before any candidate is returned.
  input.write(`${JSON.stringify(query('other'))}\n`);
  await waitForLines(3);
  const denied = lines.at(-1)!;
  assert.equal(denied.ok, false);
  assert.equal((denied.error as { code?: string }).code, 'SCOPE_DENIED');
  assert.ok(((denied.error as { message?: string }).message ?? '').includes('does not match replica scope'));

  assert.ok(new ReplicationError('SCOPE_DENIED', 'x') instanceof ReplicationError);

  input.end();
  await new Promise((resolve) => setTimeout(resolve, 30));
  (process as unknown as { exit: (code?: number) => never }).exit = originalExit;
});

