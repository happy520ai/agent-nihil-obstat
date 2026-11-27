import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ClusterConsistencyError,
  assertExecutableContext,
  consistencyJudgementSchema,
  judgeConsistency,
  type ClusterConsistencyExpectations,
  type ConsistencyJudgement,
} from '../../src/memory/cluster-consistency.ts';
import type {
  DistributedCandidateFingerprint,
  DistributedNodeReport,
  DistributedProbeAnswer,
  DistributedProbeConflict,
  DistributedProbeMetadata,
  DistributedProbeOutcome,
} from '../../src/memory/distributed-probe.ts';
import type { AnchorProbeResponse, AnchorProbeSnapshot } from '../../src/memory/probe-contract.ts';

/**
 * T-128 unit tests: strict per-mode judgement, the configurable max-lag gate,
 * mixed-commit refusal, current_snapshot fail-closed blocking and the
 * historical-evidence boundary. The fixtures are hand-built answers so each
 * rejection path is reachable deterministically without a live cluster.
 */

const HASH = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);

function snap(overrides: Partial<AnchorProbeSnapshot> = {}): AnchorProbeSnapshot {
  return {
    project_scope: 'proj',
    ledger_digest: HASH,
    graph_revision: null,
    source_fingerprint: HASH_B,
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
  return {
    record_ref: recordRef,
    content_hash: HASH,
    fact_key: 'local.storage.engine',
    status: 'active',
    sources,
  };
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
  readonly commitIndex?: number;
  readonly primaryCommitIndex?: number;
  readonly evidenceDigest?: string;
  readonly quorumSize?: number;
  readonly quorumCount?: number;
  readonly quorumDigests?: readonly string[];
  readonly stale?: boolean;
  readonly historical?: boolean;
  readonly degraded?: boolean;
  readonly maxLag?: number | null;
  readonly partial?: boolean;
  readonly stopReason?: DistributedProbeMetadata['stop_reason'];
  readonly failedNodes?: readonly string[];
  readonly candidates?: readonly DistributedCandidateFingerprint[];
  readonly conflicts?: readonly DistributedProbeConflict[];
  readonly nodes?: readonly DistributedNodeReport[];
  readonly response?: AnchorProbeResponse;
  readonly outcome?: DistributedProbeOutcome;
}

function answer(overrides: AnswerOverrides = {}): DistributedProbeAnswer {
  const mode = overrides.mode ?? 'LOCAL';
  const consistency = overrides.consistency ?? 'CONSISTENT';
  const stale = overrides.stale ?? false;
  const historical = overrides.historical ?? mode === 'AS_OF';
  const partial = overrides.partial ?? false;
  const stopReason = overrides.stopReason ?? 'NONE';
  const failedNodes = overrides.failedNodes ?? [];
  const candidates = overrides.candidates ?? [fingerprint('r-a', ['local'])];
  const conflicts = overrides.conflicts ?? [];
  const nodes = overrides.nodes ?? [node('local', { used: true })];
  const metadata: DistributedProbeMetadata = {
    mode,
    requested_mode: overrides.requestedMode ?? mode,
    consistency,
    evidence_origin: overrides.origin ?? 'local',
    cluster_epoch: 'epoch-1',
    ...(overrides.commitIndex === undefined ? {} : { commit_index: overrides.commitIndex }),
    ...(overrides.primaryCommitIndex === undefined ? {} : { primary_commit_index: overrides.primaryCommitIndex }),
    evidence_digest: overrides.evidenceDigest ?? HASH_C,
    quorum_size: overrides.quorumSize ?? 0,
    quorum_count: overrides.quorumCount ?? 0,
    quorum_digests: overrides.quorumDigests ?? [],
    stale,
    historical,
    degraded: overrides.degraded ?? false,
    max_lag: overrides.maxLag === undefined ? null : overrides.maxLag,
    partial,
    stop_reason: stopReason,
  };
  return {
    request_id: 'req-1',
    outcome: overrides.outcome ?? (consistency === 'CONSISTENT' ? 'CONSISTENT' : 'PARTIAL'),
    mode,
    requested_mode: overrides.requestedMode ?? mode,
    consistency,
    degraded: overrides.degraded ?? false,
    evidence_origin: overrides.origin ?? 'local',
    metadata,
    response: overrides.response ?? response(),
    candidates,
    conflicts,
    partial: {
      coverage: 1,
      considered: candidates.length,
      requested: candidates.length,
      gaps: [],
      failed_nodes: failedNodes,
      stop_reason: stopReason,
    },
    nodes,
    elapsed_ms: 1,
    resources_released: true,
  };
}

function expectations(overrides: Partial<ClusterConsistencyExpectations> = {}): ClusterConsistencyExpectations {
  return { mode: 'LOCAL', ...overrides };
}

const GATE_KEYS = ['evidence_id', 'verdict', 'task_id', 'passed', 'approved', 'gate'] as const;

// ---------------------------------------------------------------------------
// LOCAL
// ---------------------------------------------------------------------------

test('LOCAL accepts a clean local answer and reports no lag', () => {
  const judgement = judgeConsistency(answer(), expectations());
  assert.equal(judgement.status, 'consistent');
  assert.equal(judgement.code, null);
  assert.equal(judgement.lag, null);
  assert.equal(judgement.mode, 'LOCAL');
  assert.equal(consistencyJudgementSchema.safeParse(judgement).success, true);
});

test('LOCAL refuses an answer whose evidence origin is a replica', () => {
  const judgement = judgeConsistency(
    answer({ origin: 'replica', candidates: [fingerprint('r-a', ['replica-0'])] }),
    expectations(),
  );
  assert.equal(judgement.status, 'inconsistent');
  assert.equal(judgement.code, 'LOCAL_ORIGIN_REQUIRED');
});

test('LOCAL declares its staleness range against the primary commit point', () => {
  const judgement = judgeConsistency(
    answer({ commitIndex: 8 }),
    expectations({ primaryCommitIndex: 10 }),
  );
  assert.equal(judgement.status, 'consistent');
  assert.equal(judgement.lag, 2);
  assert.ok(judgement.reasons.some((reason) => reason.includes('trails the primary commit point')));
});

test('LOCAL with max_lag over the threshold is stale, never fresh', () => {
  const judgement = judgeConsistency(
    answer({ commitIndex: 7, maxLag: 3 }),
    expectations({ primaryCommitIndex: 10, maxLagThreshold: 2 }),
  );
  assert.equal(judgement.status, 'stale');
  assert.equal(judgement.code, 'MAX_LAG_EXCEEDED');
  assert.equal(judgement.lag, 3);
});

test('LOCAL cannot claim health for a partial or failed probe', () => {
  const partial = judgeConsistency(
    answer({ consistency: 'PARTIAL', partial: true, stopReason: 'NODE_UNAVAILABLE', failedNodes: ['local'] }),
    expectations(),
  );
  assert.equal(partial.status, 'inconsistent');
  assert.equal(partial.code, 'PARTIAL_EVIDENCE');

  const failed = judgeConsistency(
    answer({ response: response({ execution_status: 'FAILED' }) }),
    expectations(),
  );
  assert.equal(failed.status, 'blocked');
  assert.equal(failed.code, 'PROBE_EXECUTION_FAILED');
});

// ---------------------------------------------------------------------------
// AS_OF
// ---------------------------------------------------------------------------

test('AS_OF accepts an answer bound to the target commit point and marked historical', () => {
  const judgement = judgeConsistency(
    answer({ mode: 'AS_OF', requestedMode: 'AS_OF', commitIndex: 10, historical: true }),
    expectations({ mode: 'AS_OF', asOfCommitIndex: 10 }),
  );
  assert.equal(judgement.status, 'consistent');
  assert.equal(judgement.historical, true);
  assert.equal(judgement.code, null);
});

test('AS_OF accepts a later commit point as long as it stays explicitly historical', () => {
  const judgement = judgeConsistency(
    answer({ mode: 'AS_OF', requestedMode: 'AS_OF', commitIndex: 11, historical: true }),
    expectations({ mode: 'AS_OF', asOfCommitIndex: 10 }),
  );
  assert.equal(judgement.status, 'consistent');
  assert.equal(judgement.historical, true);
});

test('AS_OF behind the target is stale and says the target was not reached', () => {
  const judgement = judgeConsistency(
    answer({ mode: 'AS_OF', requestedMode: 'AS_OF', commitIndex: 9, historical: true }),
    expectations({ mode: 'AS_OF', asOfCommitIndex: 10 }),
  );
  assert.equal(judgement.status, 'stale');
  assert.equal(judgement.code, 'AS_OF_TARGET_UNMET');
  assert.ok(judgement.reasons.some((reason) => reason.includes('C*=10')));
});

test('AS_OF flagged stale by the answer is stale even when its commit reaches the target', () => {
  const judgement = judgeConsistency(
    answer({ mode: 'AS_OF', requestedMode: 'AS_OF', commitIndex: 10, stale: true, historical: true }),
    expectations({ mode: 'AS_OF', asOfCommitIndex: 10 }),
  );
  assert.equal(judgement.status, 'stale');
  assert.equal(judgement.code, 'AS_OF_TARGET_UNMET');
});

test('an AS_OF answer that fails to mark itself historical is stale', () => {
  const judgement = judgeConsistency(
    answer({ mode: 'AS_OF', requestedMode: 'AS_OF', commitIndex: 10, historical: false }),
    expectations({ mode: 'AS_OF', asOfCommitIndex: 10 }),
  );
  assert.equal(judgement.status, 'stale');
  assert.equal(judgement.code, 'AS_OF_HISTORICAL_UNMARKED');
});

test('AS_OF degraded to a local answer does not satisfy AS_OF', () => {
  const judgement = judgeConsistency(
    answer({ mode: 'LOCAL', requestedMode: 'AS_OF', historical: true }),
    expectations({ mode: 'AS_OF', asOfCommitIndex: 10 }),
  );
  assert.equal(judgement.status, 'inconsistent');
  assert.equal(judgement.code, 'MODE_UNMET');
});

// ---------------------------------------------------------------------------
// COMMITTED
// ---------------------------------------------------------------------------

test('COMMITTED accepts a replica caught up to the primary commit with a matching digest', () => {
  const nodes = [
    node('local'),
    node('replica-0', { commit_index: 10, used: true }),
  ];
  const judgement = judgeConsistency(
    answer({
      mode: 'COMMITTED',
      requestedMode: 'COMMITTED',
      origin: 'replica',
      commitIndex: 10,
      primaryCommitIndex: 10,
      evidenceDigest: HASH_D,
      quorumDigests: [HASH_D],
      quorumSize: 1,
      quorumCount: 1,
      maxLag: 0,
      candidates: [fingerprint('r-a', ['replica-0'])],
      nodes,
    }),
    expectations({ mode: 'COMMITTED', primaryCommitIndex: 10, primaryEvidenceDigest: HASH_D }),
  );
  assert.equal(judgement.status, 'consistent');
  assert.equal(judgement.lag, 0);
});

test('COMMITTED refuses a replica behind the primary commit point', () => {
  const judgement = judgeConsistency(
    answer({
      mode: 'COMMITTED',
      requestedMode: 'COMMITTED',
      origin: 'replica',
      commitIndex: 9,
      primaryCommitIndex: 10,
      evidenceDigest: HASH_D,
      quorumDigests: [HASH_D],
      quorumSize: 1,
      quorumCount: 1,
      candidates: [fingerprint('r-a', ['replica-0'])],
      nodes: [node('local'), node('replica-0', { commit_index: 9, used: true })],
    }),
    expectations({ mode: 'COMMITTED', primaryCommitIndex: 10, primaryEvidenceDigest: HASH_D }),
  );
  assert.equal(judgement.status, 'inconsistent');
  assert.equal(judgement.code, 'COMMIT_BEHIND_PRIMARY');
});

test('COMMITTED refuses an evidence digest that disagrees with the primary', () => {
  const judgement = judgeConsistency(
    answer({
      mode: 'COMMITTED',
      requestedMode: 'COMMITTED',
      origin: 'replica',
      commitIndex: 10,
      primaryCommitIndex: 10,
      evidenceDigest: HASH_D,
      quorumDigests: [HASH_D],
      quorumSize: 1,
      quorumCount: 1,
      candidates: [fingerprint('r-a', ['replica-0'])],
      nodes: [node('local'), node('replica-0', { commit_index: 10, used: true })],
    }),
    expectations({ mode: 'COMMITTED', primaryCommitIndex: 10, primaryEvidenceDigest: HASH_C }),
  );
  assert.equal(judgement.status, 'inconsistent');
  assert.equal(judgement.code, 'EVIDENCE_DIGEST_MISMATCH');
});

test('COMMITTED without a known primary commit point is inconsistent', () => {
  const judgement = judgeConsistency(answer({ mode: 'COMMITTED', requestedMode: 'COMMITTED' }), expectations({ mode: 'COMMITTED' }));
  assert.equal(judgement.status, 'inconsistent');
  assert.equal(judgement.code, 'PRIMARY_COMMIT_UNKNOWN');
});

// ---------------------------------------------------------------------------
// QUORUM
// ---------------------------------------------------------------------------

test('QUORUM accepts a majority at one commit point with equal digests', () => {
  const nodes = [
    node('local'),
    node('replica-0', { commit_index: 10, used: true }),
    node('replica-1', { commit_index: 10, used: true }),
  ];
  const judgement = judgeConsistency(
    answer({
      mode: 'QUORUM',
      requestedMode: 'QUORUM',
      origin: 'replica',
      commitIndex: 10,
      primaryCommitIndex: 10,
      evidenceDigest: HASH_D,
      quorumSize: 2,
      quorumCount: 2,
      quorumDigests: [HASH_D],
      maxLag: 0,
      candidates: [fingerprint('r-a', ['replica-0', 'replica-1'])],
      nodes,
    }),
    expectations({ mode: 'QUORUM', primaryCommitIndex: 10 }),
  );
  assert.equal(judgement.status, 'consistent');
  assert.equal(judgement.lag, 0);
});

test('a QUORUM majority with a lagging minority is stale, never fully healthy', () => {
  const judgement = judgeConsistency(
    answer({
      mode: 'QUORUM',
      requestedMode: 'QUORUM',
      origin: 'replica',
      consistency: 'PARTIAL',
      commitIndex: 10,
      primaryCommitIndex: 10,
      evidenceDigest: HASH_D,
      quorumSize: 2,
      quorumCount: 2,
      quorumDigests: [HASH_D],
      stale: true,
      partial: true,
      maxLag: 1,
      candidates: [fingerprint('r-a', ['replica-0', 'replica-1'])],
      nodes: [
        node('local'),
        node('replica-0', { commit_index: 10, used: true }),
        node('replica-1', { commit_index: 10, used: true }),
        node('replica-2', { commit_index: 9 }),
      ],
      conflicts: [{
        conflict_id: 'dist-conflict-1',
        kind: 'commit',
        fact_key: 'distributed.commit',
        record_ref: null,
        nodes: ['replica-0', 'replica-1', 'replica-2'],
        content_hashes: [],
        statuses: [],
        commits: [9, 10],
        epochs: [],
        status: 'unresolved',
      }],
    }),
    expectations({ mode: 'QUORUM', primaryCommitIndex: 10, maxLagThreshold: 0 }),
  );
  assert.equal(judgement.status, 'stale');
  assert.equal(judgement.code, 'QUORUM_LAGGING');
  assert.equal(judgement.lag, 1);
});

test('QUORUM below the majority threshold is inconsistent', () => {
  const judgement = judgeConsistency(
    answer({
      mode: 'QUORUM',
      requestedMode: 'QUORUM',
      origin: 'replica',
      commitIndex: 10,
      primaryCommitIndex: 10,
      evidenceDigest: HASH_D,
      quorumSize: 2,
      quorumCount: 1,
      quorumDigests: [HASH_D],
      candidates: [fingerprint('r-a', ['replica-0'])],
      nodes: [node('local'), node('replica-0', { commit_index: 10, used: true })],
    }),
    expectations({ mode: 'QUORUM', primaryCommitIndex: 10 }),
  );
  assert.equal(judgement.status, 'inconsistent');
  assert.equal(judgement.code, 'QUORUM_DIGEST_DIVERGENCE');
});

test('QUORUM with diverging replica digests is inconsistent', () => {
  const judgement = judgeConsistency(
    answer({
      mode: 'QUORUM',
      requestedMode: 'QUORUM',
      origin: 'replica',
      commitIndex: 10,
      primaryCommitIndex: 10,
      evidenceDigest: HASH_D,
      quorumSize: 2,
      quorumCount: 2,
      quorumDigests: [HASH_D, HASH_C],
      candidates: [fingerprint('r-a', ['replica-0', 'replica-1'])],
      nodes: [node('local'), node('replica-0', { commit_index: 10, used: true }), node('replica-1', { commit_index: 10, used: true })],
    }),
    expectations({ mode: 'QUORUM', primaryCommitIndex: 10 }),
  );
  assert.equal(judgement.status, 'inconsistent');
  assert.equal(judgement.code, 'QUORUM_DIGEST_DIVERGENCE');
});

test('a QUORUM answer downgraded to COMMITTED never satisfies a QUORUM request', () => {
  const judgement = judgeConsistency(
    answer({
      mode: 'COMMITTED',
      requestedMode: 'QUORUM',
      degraded: true,
      origin: 'replica',
      commitIndex: 10,
      primaryCommitIndex: 10,
      evidenceDigest: HASH_D,
      quorumSize: 1,
      quorumCount: 1,
      quorumDigests: [HASH_D],
      candidates: [fingerprint('r-a', ['replica-0'])],
      nodes: [node('local'), node('replica-0', { commit_index: 10, used: true })],
    }),
    expectations({ mode: 'QUORUM', primaryCommitIndex: 10 }),
  );
  assert.equal(judgement.status, 'inconsistent');
  assert.equal(judgement.code, 'MODE_UNMET');
});

// ---------------------------------------------------------------------------
// max_lag gate
// ---------------------------------------------------------------------------

test('max_lag above a configured threshold turns a healthy quorum stale', () => {
  const judgement = judgeConsistency(
    answer({
      mode: 'QUORUM',
      requestedMode: 'QUORUM',
      origin: 'replica',
      commitIndex: 8,
      primaryCommitIndex: 10,
      evidenceDigest: HASH_D,
      quorumSize: 1,
      quorumCount: 1,
      quorumDigests: [HASH_D],
      maxLag: 2,
      candidates: [fingerprint('r-a', ['replica-0'])],
      nodes: [node('local'), node('replica-0', { commit_index: 8, used: true })],
    }),
    expectations({ mode: 'QUORUM', primaryCommitIndex: 10, maxLagThreshold: 1 }),
  );
  assert.equal(judgement.status, 'stale');
  assert.equal(judgement.code, 'MAX_LAG_EXCEEDED');
  assert.equal(judgement.lag, 2);
});

// ---------------------------------------------------------------------------
// mixed commit refusal
// ---------------------------------------------------------------------------

test('one conclusion mixing local and remote candidate origins is rejected', () => {
  const judgement = judgeConsistency(
    answer({ candidates: [fingerprint('r-a', ['local', 'replica-0'])] }),
    expectations(),
  );
  assert.equal(judgement.status, 'blocked');
  assert.equal(judgement.code, 'MIXED_EVIDENCE_REJECTED');
});

test('using both the local store and a replica in one answer is rejected', () => {
  const judgement = judgeConsistency(
    answer({ nodes: [node('local', { used: true }), node('replica-0', { used: true, commit_index: 10 })] }),
    expectations(),
  );
  assert.equal(judgement.status, 'blocked');
  assert.equal(judgement.code, 'MIXED_EVIDENCE_REJECTED');
});

test('divergent replica commits marked CONSISTENT are rejected as an inconsistent commit', () => {
  const judgement = judgeConsistency(
    answer({
      mode: 'QUORUM',
      requestedMode: 'QUORUM',
      origin: 'replica',
      consistency: 'CONSISTENT',
      commitIndex: 10,
      primaryCommitIndex: 10,
      quorumSize: 2,
      quorumCount: 2,
      quorumDigests: [HASH_D],
      candidates: [fingerprint('r-a', ['replica-0', 'replica-1'])],
      nodes: [
        node('local'),
        node('replica-0', { commit_index: 10, used: true }),
        node('replica-1', { commit_index: 9, used: true }),
      ],
    }),
    expectations({ mode: 'QUORUM', primaryCommitIndex: 10 }),
  );
  assert.equal(judgement.status, 'blocked');
  assert.equal(judgement.code, 'INCONSISTENT_COMMIT');
});

// ---------------------------------------------------------------------------
// current_snapshot fail-closed gate
// ---------------------------------------------------------------------------

test('a local/primary current_snapshot that differs from the answer blocks execution', () => {
  const judgement = judgeConsistency(
    answer(),
    expectations({ currentSnapshot: snap({ ledger_digest: HASH_B }) }),
  );
  assert.equal(judgement.status, 'blocked');
  assert.equal(judgement.code, 'CURRENT_SNAPSHOT_MISMATCH');
  assert.ok(judgement.reasons.some((reason) => reason.includes('ledger_digest')));
});

test('a mismatched evidence digest on both snapshots also blocks', () => {
  const frozen = snap({ cluster: { schema_version: 'anchorprobe.cluster.v1', project_scope: 'proj', cluster_epoch: 'epoch-1', commit_index: 10, replica_id: 'local', replica_commit_index: 10, consistency: 'local', max_lag: null, partial: false, failed_nodes: [], evidence_digest: HASH_C } });
  const live = snap({ cluster: { schema_version: 'anchorprobe.cluster.v1', project_scope: 'proj', cluster_epoch: 'epoch-1', commit_index: 10, replica_id: 'local', replica_commit_index: 10, consistency: 'local', max_lag: null, partial: false, failed_nodes: [], evidence_digest: HASH_D } });
  const judgement = judgeConsistency(
    answer({ response: response({ snapshot: frozen }) }),
    expectations({ currentSnapshot: live }),
  );
  assert.equal(judgement.status, 'blocked');
  assert.equal(judgement.code, 'CURRENT_SNAPSHOT_MISMATCH');
});

test('a matching current_snapshot leaves the judgement untouched', () => {
  const judgement = judgeConsistency(answer(), expectations({ currentSnapshot: snap() }));
  assert.equal(judgement.status, 'consistent');
  assert.equal(judgement.code, null);
});

// ---------------------------------------------------------------------------
// historical evidence cannot be upgraded to current execution
// ---------------------------------------------------------------------------

test('historical evidence produced by a non-AS_OF request is refused', () => {
  const judgement = judgeConsistency(answer({ historical: true }), expectations());
  assert.equal(judgement.status, 'blocked');
  assert.equal(judgement.code, 'HISTORICAL_NOT_EXECUTABLE');
});

test('a current-execution basis refuses a historical or stale AS_OF answer', () => {
  const historical = judgeConsistency(
    answer({ mode: 'AS_OF', requestedMode: 'AS_OF', commitIndex: 10, historical: true }),
    expectations({ mode: 'AS_OF', asOfCommitIndex: 10, currentExecution: true }),
  );
  assert.equal(historical.status, 'blocked');
  assert.equal(historical.code, 'HISTORICAL_NOT_EXECUTABLE');

  const stale = judgeConsistency(
    answer({ mode: 'AS_OF', requestedMode: 'AS_OF', commitIndex: 9, stale: true, historical: true }),
    expectations({ mode: 'AS_OF', asOfCommitIndex: 10, currentExecution: true }),
  );
  assert.equal(stale.status, 'blocked');
  assert.equal(stale.code, 'HISTORICAL_NOT_EXECUTABLE');
});

test('an explicit AS_OF read is allowed for historical use', () => {
  const judgement = judgeConsistency(
    answer({ mode: 'AS_OF', requestedMode: 'AS_OF', commitIndex: 10, historical: true }),
    expectations({ mode: 'AS_OF', asOfCommitIndex: 10 }),
  );
  assert.notEqual(judgement.status, 'blocked');
});

// ---------------------------------------------------------------------------
// envelope misuse and Gate boundary
// ---------------------------------------------------------------------------

test('malformed envelopes throw instead of being judged', () => {
  assert.throws(() => judgeConsistency(null as unknown as DistributedProbeAnswer, expectations()), TypeError);
  assert.throws(() => judgeConsistency({} as unknown as DistributedProbeAnswer, expectations()), TypeError);
  assert.throws(() => judgeConsistency(answer(), expectations({ mode: 'EVENTUAL' as never })), TypeError);
});

test('the judgement carries no Gate-shaped field', () => {
  const judgement = judgeConsistency(
    answer({
      mode: 'QUORUM',
      requestedMode: 'QUORUM',
      origin: 'replica',
      commitIndex: 10,
      primaryCommitIndex: 10,
      quorumSize: 1,
      quorumCount: 1,
      quorumDigests: [HASH_D],
      candidates: [fingerprint('r-a', ['replica-0'])],
      nodes: [node('local'), node('replica-0', { commit_index: 10, used: true })],
    }),
    expectations({ mode: 'QUORUM', primaryCommitIndex: 10, maxLagThreshold: -1 }),
  );
  for (const key of GATE_KEYS) assert.equal(key in judgement, false, `judgement must not carry ${key}`);
  const serialized = JSON.stringify(judgement);
  for (const key of GATE_KEYS) assert.equal(serialized.includes(`"${key}"`), false);
});

test('assertExecutableContext passes only consistent judgements and throws otherwise', () => {
  const consistent = judgeConsistency(answer(), expectations());
  assert.doesNotThrow(() => assertExecutableContext(consistent));

  for (const overrides of [
    { mode: 'AS_OF', requestedMode: 'AS_OF', commitIndex: 9, historical: true },
    { origin: 'replica' },
  ] as const) {
    const judgement = judgeConsistency(answer(overrides), expectations(overrides.mode === 'AS_OF' ? { mode: 'AS_OF', asOfCommitIndex: 10 } : {}));
    assert.throws(() => assertExecutableContext(judgement), (error: unknown) => {
      assert.ok(error instanceof ClusterConsistencyError);
      assert.equal(error.code, judgement.code);
      assert.equal(error.judgement.status, judgement.status);
      return true;
    });
  }
});
