import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DistributedProbeError,
  distributedProbe,
  type DistributedNodeQuery,
  type DistributedReplicaNode,
  type DistributedReplicaState,
} from '../../src/memory/distributed-probe.ts';
import {
  ProbeRequestError,
  type ProbeCandidate,
  type ProbeEdge,
  type ProbeEntryQuery,
} from '../../src/memory/probe.ts';
import {
  ANCHOR_PROBE_REQUEST_SCHEMA_VERSION,
  anchorProbeResponseSchema,
  computeEvidenceDigestDetailed,
  type AnchorProbeClusterMetadata,
  type AnchorProbeSnapshot,
} from '../../src/memory/probe-contract.ts';
import {
  probeSnapshotIdentity,
  type ProbeEvidencePayload,
  type ProbeProvenanceView,
  type ProbeStatusView,
  type ProbeStore,
} from '../../src/memory/probe-store.ts';

const HASH = 'a'.repeat(64);
const EMPTY_DIGEST = computeEvidenceDigestDetailed([]).digest;
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);
const AT = '2026-11-21T00:00:00.000Z';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function snap(cluster: Partial<AnchorProbeClusterMetadata> = {}): AnchorProbeSnapshot {
  const metadata: AnchorProbeClusterMetadata = {
    schema_version: 'anchorprobe.cluster.v1',
    project_scope: 'proj',
    cluster_epoch: 'epoch-1',
    commit_index: 0,
    replica_id: 'local',
    replica_commit_index: 0,
    consistency: 'local',
    max_lag: null,
    partial: false,
    failed_nodes: [],
    evidence_digest: HASH,
    ...cluster,
  };
  return {
    project_scope: metadata.project_scope,
    ledger_digest: HASH,
    graph_revision: null,
    source_fingerprint: HASH_B,
    connected_digest: null,
    cluster: metadata,
  };
}

function candidate(overrides: Partial<ProbeCandidate> & { record_ref: string }): ProbeCandidate {
  return {
    fact_key: 'local.storage.engine',
    task_id: null,
    file: null,
    symbol: null,
    source: { kind: 'native_note' },
    source_health: 'verified_at_snapshot',
    status: 'active',
    content: `content of ${overrides.record_ref}`,
    content_hash: HASH,
    recorded_at: AT,
    effective_from: null,
    effective_to: null,
    superseded_by: null,
    version: null,
    anchor: { status: 'none', file: null },
    qualifiers: [],
    ...overrides,
  };
}

function baseRecords(): ProbeCandidate[] {
  return [candidate({ record_ref: 'r-a', content_hash: HASH })];
}

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: ANCHOR_PROBE_REQUEST_SCHEMA_VERSION,
    request_id: 'req-1',
    root: 'F:/project',
    project_scope: 'proj',
    required_facts: ['local.storage.engine'],
    ...overrides,
  };
}

function matches(query: ProbeEntryQuery, record: ProbeCandidate): boolean {
  if (query.fact_key !== undefined && record.fact_key !== query.fact_key) return false;
  if (query.task_id !== undefined && record.task_id !== query.task_id) return false;
  if (query.file !== undefined && record.file !== query.file) return false;
  if (query.symbol !== undefined && record.symbol !== query.symbol) return false;
  return true;
}

class FakeStore implements ProbeStore {
  private readonly snapshotValue: AnchorProbeSnapshot;
  private readonly records: readonly ProbeCandidate[];
  private readonly edgeList: readonly ProbeEdge[];
  private readonly throwOnCandidates: boolean;
  private readonly throwOnSnapshot: boolean;
  private readonly throwOnCommitIndex: boolean;

  constructor(
    records: readonly ProbeCandidate[],
    options: {
      snapshot?: AnchorProbeSnapshot;
      edges?: readonly ProbeEdge[];
      throwOnCandidates?: boolean;
      throwOnSnapshot?: boolean;
      throwOnCommitIndex?: boolean;
    } = {},
  ) {
    this.records = records;
    this.edgeList = options.edges ?? [];
    this.snapshotValue = options.snapshot ?? snap();
    this.throwOnCandidates = options.throwOnCandidates ?? false;
    this.throwOnSnapshot = options.throwOnSnapshot ?? false;
    this.throwOnCommitIndex = options.throwOnCommitIndex ?? false;
  }

  get snapshot(): AnchorProbeSnapshot {
    if (this.throwOnSnapshot) throw new Error('snapshot unavailable');
    return this.snapshotValue;
  }

  replicaCommitIndex(): number | undefined {
    if (this.throwOnCommitIndex) throw new Error('cursor unavailable');
    return this.snapshotValue.cluster?.replica_commit_index;
  }

  candidates(query?: ProbeEntryQuery): readonly ProbeCandidate[] {
    if (this.throwOnCandidates) throw new Error('index unavailable');
    if (query === undefined || Object.keys(query).length === 0) return this.records;
    return this.records.filter((record) => matches(query, record));
  }

  adjacency(): readonly ProbeEdge[] {
    return this.edgeList;
  }

  evidence(recordRef: string): ProbeEvidencePayload | undefined {
    const record = this.find(recordRef);
    return record === undefined
      ? undefined
      : {
        record_ref: record.record_ref,
        content_hash: record.content_hash,
        status: record.status,
        source_health: record.source_health,
        recorded_at: record.recorded_at,
        effective_from: record.effective_from,
        source: record.source,
        content: record.content,
      };
  }

  status(recordRef: string): ProbeStatusView | undefined {
    const record = this.find(recordRef);
    return record === undefined
      ? undefined
      : {
        record_ref: record.record_ref,
        status: record.status,
        eligibility: record.qualifiers.includes('legacy_unreviewed') ? 'legacy_unreviewed' : 'governed',
        version: record.version,
        superseded_by: record.superseded_by,
        effective_from: record.effective_from,
        effective_to: record.effective_to,
      };
  }

  provenance(recordRef: string): ProbeProvenanceView | undefined {
    const record = this.find(recordRef);
    return record === undefined
      ? undefined
      : {
        record_ref: record.record_ref,
        source: record.source,
        source_health: record.source_health,
        qualifiers: record.qualifiers,
        anchor: record.anchor,
      };
  }

  snapshotIdentity() {
    return probeSnapshotIdentity(this.snapshot);
  }

  private find(recordRef: string): ProbeCandidate | undefined {
    return this.records.find((record) => record.record_ref === recordRef);
  }
}

interface ReplicaOptions {
  readonly latencyMs?: number;
  readonly throwOnQuery?: boolean;
  readonly commitIndex?: number;
  readonly viewDigest?: string;
  readonly state?: DistributedReplicaState;
  readonly scope?: string;
  readonly epoch?: string | number;
  readonly declaredDigest?: string;
  readonly query?: DistributedNodeQuery;
  readonly queries?: { count: number };
}

function replica(id: string, records: readonly ProbeCandidate[], options: ReplicaOptions = {}): DistributedReplicaNode {
  const store = new FakeStore(records, {
    snapshot: snap({
      project_scope: options.scope ?? 'proj',
      replica_id: id,
      commit_index: options.commitIndex ?? 0,
      replica_commit_index: options.commitIndex ?? 0,
      ...(options.state === 'LAGGING' || options.state === 'SUSPECT' ? { partial: true } : {}),
    }),
  });
  const builtInQuery: DistributedNodeQuery = async () => {
    if (options.queries !== undefined) options.queries.count += 1;
    if (options.latencyMs !== undefined && options.latencyMs > 0) await sleep(options.latencyMs);
    if (options.throwOnQuery === true) throw new Error(`replica ${id} is unavailable`);
    return {
      candidates: store.candidates(),
      edges: store.adjacency(),
      ...(options.commitIndex === undefined ? {} : { commitIndex: options.commitIndex }),
      ...(options.viewDigest === undefined ? {} : { viewDigest: options.viewDigest }),
      ...(options.declaredDigest === undefined ? {} : { evidenceDigest: options.declaredDigest }),
      ...(options.state === undefined ? {} : { state: options.state }),
    };
  };
  return {
    replicaId: id,
    store,
    ...(options.scope === undefined ? {} : { projectScope: options.scope }),
    ...(options.epoch === undefined ? {} : { clusterEpoch: options.epoch }),
    ...(options.commitIndex === undefined ? {} : { commitIndex: options.commitIndex }),
    query: options.query ?? builtInQuery,
  };
}

function assertValidResponse(response: ReturnType<typeof anchorProbeResponseSchema.parse>): void {
  const parsed = anchorProbeResponseSchema.safeParse(response);
  assert.equal(parsed.success, true, JSON.stringify(response));
}

// ---------------------------------------------------------------------------
// scatter: parallelism and failure isolation
// ---------------------------------------------------------------------------

test('QUORUM scatters in parallel: elapsed tracks the slowest node, not the sum', async () => {
  const local = new FakeStore(baseRecords());
  const nodes = [
    replica('replica-0', baseRecords(), { commitIndex: 10, latencyMs: 150 }),
    replica('replica-1', baseRecords(), { commitIndex: 10, latencyMs: 100 }),
    replica('replica-2', baseRecords(), { commitIndex: 10, latencyMs: 60 }),
  ];
  const sum = 150 + 100 + 60;
  const answer = await distributedProbe(request(), local, nodes, {
    mode: 'QUORUM',
    primaryCommitIndex: 10,
    // Full-gather arm: this test measures fan-out against the slowest node and
    // the three-node quorum count. Early freeze is covered separately.
    earlyFreeze: false,
    now: AT,
    deadlineMs: 3000,
  });
  assert.ok(answer.elapsed_ms >= 80, `expected parallel fan-out, got ${String(answer.elapsed_ms)}ms`);
  assert.ok(answer.elapsed_ms < sum * 0.75, `serial-like fan-out: ${String(answer.elapsed_ms)}ms for sum ${String(sum)}ms`);
  assert.equal(answer.metadata.mode, 'QUORUM');
  assert.equal(answer.requested_mode, 'QUORUM');
  assert.equal(answer.consistency, 'CONSISTENT');
  assert.equal(answer.degraded, false);
  assert.equal(answer.metadata.quorum_size, 2);
  assert.equal(answer.metadata.quorum_count, 3);
  assert.equal(new Set(answer.metadata.quorum_digests).size, 1);
  assert.deepEqual(answer.partial.failed_nodes, []);
  assert.deepEqual(answer.response.active_evidence.map((item) => item.record_ref), ['r-a']);
  assert.equal(answer.evidence_origin, 'replica');
  assertValidResponse(answer.response);
});

test('a throwing node and a node that exceeds its budget do not block the healthy node', async () => {
  const local = new FakeStore(baseRecords());
  const nodes = [
    replica('replica-good', baseRecords(), { commitIndex: 10, latencyMs: 10 }),
    replica('replica-throw', baseRecords(), { commitIndex: 10, throwOnQuery: true }),
    replica('replica-slow', baseRecords(), { commitIndex: 10, latencyMs: 500 }),
  ];
  const answer = await distributedProbe(request(), local, nodes, {
    mode: 'COMMITTED',
    primaryCommitIndex: 10,
    // Full-gather arm: this test classifies a throwing node and a node that
    // exceeds its budget. An early freeze would discard the slow node instead.
    earlyFreeze: false,
    now: AT,
    nodeTimeoutMs: 40,
    deadlineMs: 2000,
  });
  assert.ok(answer.elapsed_ms < 250, `slow node blocked the scatter: ${String(answer.elapsed_ms)}ms`);
  assert.equal(answer.metadata.mode, 'COMMITTED');
  assert.equal(answer.consistency, 'PARTIAL');
  assert.deepEqual(answer.partial.failed_nodes, ['replica-slow', 'replica-throw']);
  const outcomes = new Map(answer.nodes.filter((node) => node.replica_id !== 'local').map((node) => [node.replica_id, node.outcome]));
  assert.equal(outcomes.get('replica-good'), 'OK');
  assert.equal(outcomes.get('replica-throw'), 'NODE_UNAVAILABLE');
  assert.equal(outcomes.get('replica-slow'), 'TIMEOUT');
  assert.deepEqual(answer.response.active_evidence.map((item) => item.record_ref), ['r-a']);
  assertValidResponse(answer.response);
});

test('an exhausted deadline returns partial with elapsed_ms instead of waiting forever', async () => {
  const local = new FakeStore(baseRecords());
  const nodes = [
    replica('replica-0', baseRecords(), { commitIndex: 10, latencyMs: 400 }),
    replica('replica-1', baseRecords(), { commitIndex: 10, latencyMs: 400 }),
  ];
  const answer = await distributedProbe(request(), local, nodes, {
    mode: 'QUORUM',
    primaryCommitIndex: 10,
    now: AT,
    deadlineMs: 50,
  });
  assert.ok(answer.elapsed_ms >= 40, `deadline not respected: ${String(answer.elapsed_ms)}ms`);
  assert.ok(answer.elapsed_ms < 300, `returned too late: ${String(answer.elapsed_ms)}ms`);
  assert.equal(answer.outcome, 'PARTIAL');
  assert.equal(answer.metadata.stop_reason, 'TIMEOUT');
  assert.equal(answer.partial.stop_reason, 'TIMEOUT');
  assert.equal(answer.metadata.partial, true);
  assert.equal(answer.resources_released, true);
  assert.deepEqual(answer.partial.failed_nodes, ['replica-0', 'replica-1']);
});

test('AbortSignal cancels the scatter and late results are never adopted', async () => {
  const local = new FakeStore(baseRecords());
  let nodeFinished = false;
  const nodes: DistributedReplicaNode[] = [{
    replicaId: 'replica-late',
    store: new FakeStore(baseRecords()),
    commitIndex: 10,
    query: async () => {
      await sleep(300);
      nodeFinished = true;
      return { candidates: baseRecords(), commitIndex: 10 };
    },
  }];
  const controller = new AbortController();
  const pending = distributedProbe(request(), local, nodes, {
    mode: 'COMMITTED',
    primaryCommitIndex: 10,
    now: AT,
    signal: controller.signal,
  });
  await sleep(20);
  controller.abort();
  const answer = await pending;
  assert.equal(answer.outcome, 'CANCELLED');
  assert.equal(answer.metadata.stop_reason, 'CANCELLED');
  assert.equal(answer.resources_released, true);
  assert.ok(answer.elapsed_ms < 250, `cancel was not prompt: ${String(answer.elapsed_ms)}ms`);
  assert.equal(answer.response.execution_status, 'FAILED');
  assert.deepEqual(answer.response.active_evidence, []);
  // The late node settles afterwards; the already returned answer is untouched.
  await sleep(350);
  assert.equal(nodeFinished, true);
  assert.equal(answer.outcome, 'CANCELLED');
  assert.deepEqual(answer.response.active_evidence, []);
});

test('an already aborted signal returns CANCELLED without querying any replica', async () => {
  const local = new FakeStore(baseRecords());
  const queries = { count: 0 };
  const nodes = [replica('replica-0', baseRecords(), { commitIndex: 10, queries })];
  const controller = new AbortController();
  controller.abort();
  const answer = await distributedProbe(request(), local, nodes, {
    mode: 'QUORUM',
    primaryCommitIndex: 10,
    signal: controller.signal,
  });
  assert.equal(answer.outcome, 'CANCELLED');
  assert.equal(queries.count, 0);
  assert.equal(answer.resources_released, true);
});

// ---------------------------------------------------------------------------
// gather: dedup, explicit conflicts, version/commit divergence
// ---------------------------------------------------------------------------

test('gather dedups identical candidates across replicas and counts them once', async () => {
  const local = new FakeStore(baseRecords());
  const records = [
    candidate({ record_ref: 'r-a', content_hash: HASH }),
    candidate({ record_ref: 'r-b', fact_key: 'local.storage.retention', content_hash: HASH_B }),
  ];
  const nodes = [
    replica('replica-0', records, { commitIndex: 10 }),
    replica('replica-1', records, { commitIndex: 10 }),
  ];
  const answer = await distributedProbe(
    request({ required_facts: ['local.storage.engine', 'local.storage.retention'] }),
    local,
    nodes,
    { mode: 'QUORUM', primaryCommitIndex: 10, now: AT },
  );
  assert.equal(answer.partial.considered, 2);
  assert.equal(answer.partial.requested, 2);
  assert.equal(answer.partial.coverage, 1);
  assert.equal(answer.candidates.length, 2);
  for (const fingerprint of answer.candidates) {
    assert.deepEqual(fingerprint.sources, ['replica-0', 'replica-1']);
  }
  assert.equal(answer.response.active_evidence.length, 2);
  assert.match(answer.metadata.evidence_digest, /^[a-f0-9]{64}$/u);
  assertValidResponse(answer.response);
});

test('dedup does not swallow a conflict: same record_ref with different content_hash stays explicit', async () => {
  const local = new FakeStore([]);
  const left = [candidate({ record_ref: 'r-x', fact_key: 'local.x', content_hash: HASH_C, content: 'sqlite' })];
  const right = [candidate({ record_ref: 'r-x', fact_key: 'local.x', content_hash: HASH_D, content: 'postgres' })];
  const nodes = [
    replica('replica-a', left, { commitIndex: 10 }),
    replica('replica-b', right, { commitIndex: 10 }),
  ];
  const answer = await distributedProbe(request({ required_facts: ['local.x'] }), local, nodes, {
    mode: 'AS_OF',
    asOfCommitIndex: 5,
    now: AT,
  });
  assert.equal(answer.metadata.historical, true);
  assert.equal(answer.metadata.commit_index, 5);
  assert.equal(answer.consistency, 'PARTIAL');
  const conflict = answer.conflicts.find((entry) => entry.kind === 'content_hash');
  assert.ok(conflict !== undefined, JSON.stringify(answer.conflicts));
  assert.equal(conflict?.record_ref, 'r-x');
  assert.equal(conflict?.status, 'unresolved');
  assert.deepEqual([...conflict?.content_hashes ?? []].sort(), [HASH_C, HASH_D].sort());
  assert.deepEqual(conflict?.nodes, ['replica-a', 'replica-b']);
  assert.equal(answer.candidates.length, 2);
  // No winner is picked and coverage cannot be SUFFICIENT while unresolved.
  assert.notEqual(answer.response.coverage_gate.status, 'SUFFICIENT');
  assert.ok(answer.response.conflicts.some((entry) => entry.conflict_id.startsWith('dist-conflict-')));
  assert.ok(answer.response.coverage_gate.unresolved_conflicts.length > 0);
  assert.match(answer.metadata.evidence_digest, /^[a-f0-9]{64}$/u);
  assertValidResponse(answer.response);
});

test('cluster_epoch divergence is an explicit unresolved conflict', async () => {
  const local = new FakeStore(baseRecords());
  const nodes = [
    replica('replica-epoch-a', baseRecords(), { commitIndex: 10, epoch: 'epoch-1' }),
    replica('replica-epoch-b', baseRecords(), { commitIndex: 10, epoch: 'epoch-2' }),
  ];
  const answer = await distributedProbe(request(), local, nodes, {
    mode: 'QUORUM',
    primaryCommitIndex: 10,
    now: AT,
  });
  const conflict = answer.conflicts.find((entry) => entry.kind === 'cluster_epoch');
  assert.ok(conflict !== undefined);
  assert.equal(conflict?.status, 'unresolved');
  assert.deepEqual(conflict?.epochs, ['epoch-1', 'epoch-2']);
  assert.equal(answer.consistency, 'PARTIAL');
  assert.notEqual(answer.response.coverage_gate.status, 'SUFFICIENT');
  assertValidResponse(answer.response);
});

test('different statuses at one record_ref are an explicit unresolved conflict', async () => {
  const local = new FakeStore([]);
  const active = [candidate({ record_ref: 'r-s', fact_key: 'local.s', status: 'active' })];
  const retracted = [candidate({ record_ref: 'r-s', fact_key: 'local.s', status: 'retracted' })];
  const nodes = [
    replica('replica-a', active, { commitIndex: 10 }),
    replica('replica-b', retracted, { commitIndex: 10 }),
  ];
  const answer = await distributedProbe(request({ required_facts: ['local.s'] }), local, nodes, {
    mode: 'AS_OF',
    asOfCommitIndex: 5,
    now: AT,
  });
  const conflict = answer.conflicts.find((entry) => entry.kind === 'status');
  assert.ok(conflict !== undefined);
  assert.equal(conflict?.record_ref, 'r-s');
  assert.equal(conflict?.status, 'unresolved');
  assert.deepEqual(conflict?.statuses, ['active', 'retracted']);
  assert.notEqual(answer.response.coverage_gate.status, 'SUFFICIENT');
  assertValidResponse(answer.response);
});

test('commit divergence between replicas is unresolved and blocks a SUFFICIENT coverage gate', async () => {
  const local = new FakeStore(baseRecords());
  const nodes = [
    replica('replica-0', baseRecords(), { commitIndex: 10 }),
    replica('replica-1', baseRecords(), { commitIndex: 10 }),
    replica('replica-2', baseRecords(), { commitIndex: 9 }),
  ];
  const answer = await distributedProbe(request(), local, nodes, {
    mode: 'QUORUM',
    primaryCommitIndex: 10,
    now: AT,
  });
  assert.equal(answer.metadata.mode, 'QUORUM');
  assert.equal(answer.metadata.quorum_size, 2);
  assert.equal(answer.metadata.quorum_count, 2);
  assert.equal(new Set(answer.metadata.quorum_digests).size, 1);
  const conflict = answer.conflicts.find((entry) => entry.kind === 'commit');
  assert.ok(conflict !== undefined);
  assert.deepEqual(conflict?.commits, [9, 10]);
  assert.equal(conflict?.status, 'unresolved');
  assert.equal(answer.consistency, 'PARTIAL');
  assert.notEqual(answer.response.coverage_gate.status, 'SUFFICIENT');
  assertValidResponse(answer.response);
});

// ---------------------------------------------------------------------------
// mode judgment and degradation
// ---------------------------------------------------------------------------

test('COMMITTED needs at least one replica at the primary commit with a matching digest', async () => {
  const local = new FakeStore(baseRecords());
  const caughtUp = [candidate({ record_ref: 'r-y', fact_key: 'local.storage.engine', content_hash: HASH_D, content: 'other' })];
  const nodes = [replica('replica-0', caughtUp, { commitIndex: 10 })];
  const answer = await distributedProbe(request(), local, nodes, {
    mode: 'COMMITTED',
    primaryCommitIndex: 10,
    now: AT,
  });
  assert.equal(answer.metadata.mode, 'LOCAL');
  assert.equal(answer.degraded, true);
  assert.equal(answer.metadata.degradation_reason, 'NO_REPLICA_CAUGHT_UP');
  assert.equal(answer.metadata.stop_reason, 'QUORUM_UNMET');
  assert.equal(answer.consistency, 'PARTIAL');
  assert.ok(answer.partial.gaps.includes('committed:10'));
  // Local fact semantics survive the degradation.
  assert.deepEqual(answer.response.active_evidence.map((item) => item.record_ref), ['r-a']);
  assert.equal(answer.evidence_origin, 'local');
  assertValidResponse(answer.response);
});

test('a remote evidence_digest declaration that disagrees with recomputation disqualifies the node', async () => {
  const local = new FakeStore(baseRecords());
  const nodes = [replica('replica-lying', baseRecords(), { commitIndex: 10, declaredDigest: HASH_D })];
  const answer = await distributedProbe(request(), local, nodes, {
    mode: 'COMMITTED',
    primaryCommitIndex: 10,
    now: AT,
  });
  const report = answer.nodes.find((node) => node.replica_id === 'replica-lying');
  assert.equal(report?.outcome, 'VIEW_DIGEST_MISMATCH');
  assert.deepEqual(answer.partial.failed_nodes, ['replica-lying']);
  assert.equal(answer.metadata.mode, 'LOCAL');
  assert.equal(answer.degraded, true);
  assert.equal(answer.consistency, 'PARTIAL');
  assertValidResponse(answer.response);
});

test('QUORUM below the threshold explicitly downgrades to COMMITTED and says so', async () => {
  const local = new FakeStore(baseRecords());
  const nodes = [
    replica('replica-good', baseRecords(), { commitIndex: 10, latencyMs: 10 }),
    replica('replica-bad-0', baseRecords(), { commitIndex: 10, throwOnQuery: true }),
    replica('replica-bad-1', baseRecords(), { commitIndex: 10, throwOnQuery: true }),
  ];
  const answer = await distributedProbe(request(), local, nodes, {
    mode: 'QUORUM',
    primaryCommitIndex: 10,
    now: AT,
  });
  assert.equal(answer.requested_mode, 'QUORUM');
  assert.equal(answer.metadata.mode, 'COMMITTED');
  assert.equal(answer.degraded, true);
  assert.equal(answer.metadata.degradation_reason, 'QUORUM_UNMET');
  assert.equal(answer.metadata.stop_reason, 'QUORUM_UNMET');
  assert.equal(answer.metadata.quorum_count, 1);
  assert.equal(answer.metadata.quorum_size, 1);
  assert.equal(answer.consistency, 'PARTIAL');
  assert.deepEqual(answer.partial.failed_nodes, ['replica-bad-0', 'replica-bad-1']);
  assert.equal(answer.evidence_origin, 'replica');
  assertValidResponse(answer.response);
});

test('all replicas failing degrades to the local store with failed_nodes recorded', async () => {
  const local = new FakeStore(baseRecords());
  const nodes = [
    replica('replica-0', baseRecords(), { commitIndex: 10, throwOnQuery: true }),
    replica('replica-1', baseRecords(), { commitIndex: 10, throwOnQuery: true }),
  ];
  const answer = await distributedProbe(request(), local, nodes, {
    mode: 'QUORUM',
    primaryCommitIndex: 10,
    now: AT,
  });
  assert.equal(answer.metadata.mode, 'LOCAL');
  assert.equal(answer.degraded, true);
  assert.equal(answer.metadata.degradation_reason, 'NODE_UNAVAILABLE');
  assert.equal(answer.metadata.stop_reason, 'NODE_UNAVAILABLE');
  assert.deepEqual(answer.partial.failed_nodes, ['replica-0', 'replica-1']);
  assert.equal(answer.evidence_origin, 'local');
  assert.deepEqual(answer.response.active_evidence.map((item) => item.record_ref), ['r-a']);
  assertValidResponse(answer.response);
});

test('AS_OF binds the answer to the requested commit point', async () => {
  const local = new FakeStore(baseRecords());
  const nodes = [
    replica('replica-0', baseRecords(), { commitIndex: 10 }),
    replica('replica-1', baseRecords(), { commitIndex: 10 }),
  ];
  const answer = await distributedProbe(request(), local, nodes, {
    mode: 'AS_OF',
    asOfCommitIndex: 10,
    now: AT,
  });
  assert.equal(answer.metadata.mode, 'AS_OF');
  assert.equal(answer.metadata.commit_index, 10);
  assert.equal(answer.metadata.historical, true);
  assert.equal(answer.metadata.stale, false);
  assert.equal(answer.consistency, 'CONSISTENT');
  assert.equal(answer.metadata.quorum_count, 2);
  assertValidResponse(answer.response);
});

test('AS_OF with no replica at the target commit is UNKNOWN/stale, never complete', async () => {
  const local = new FakeStore(baseRecords());
  const nodes = [
    replica('replica-0', baseRecords(), { commitIndex: 10 }),
    replica('replica-1', baseRecords(), { commitIndex: 9 }),
  ];
  const answer = await distributedProbe(request(), local, nodes, {
    mode: 'AS_OF',
    asOfCommitIndex: 12,
    now: AT,
  });
  assert.equal(answer.metadata.mode, 'AS_OF');
  assert.equal(answer.consistency, 'UNKNOWN');
  assert.equal(answer.metadata.stale, true);
  assert.equal(answer.metadata.stop_reason, 'NODE_LAGGING');
  assert.ok(answer.partial.gaps.includes('as_of:12'));
  assert.equal(answer.metadata.partial, true);
  assert.equal(answer.partial.failed_nodes.length > 0 || answer.partial.gaps.length > 0, true);
  assertValidResponse(answer.response);
});

test('AS_OF verifies the expected view digest and reports a mismatch explicitly', async () => {
  const local = new FakeStore(baseRecords());
  const nodes = [
    replica('replica-ok', baseRecords(), { commitIndex: 10, viewDigest: HASH_D }),
    replica('replica-divergent', baseRecords(), { commitIndex: 10, viewDigest: HASH_C }),
  ];
  const answer = await distributedProbe(request(), local, nodes, {
    mode: 'AS_OF',
    asOfCommitIndex: 8,
    expectedViewDigest: HASH_D,
    now: AT,
  });
  assert.equal(answer.metadata.mode, 'AS_OF');
  assert.equal(answer.metadata.commit_index, 8);
  assert.equal(answer.metadata.quorum_count, 1);
  assert.equal(answer.consistency, 'PARTIAL');
  assert.ok(answer.partial.gaps.includes('view-digest-mismatch'));
  assertValidResponse(answer.response);
});

// ---------------------------------------------------------------------------
// routing, local behaviour, Gate boundary
// ---------------------------------------------------------------------------

test('cross-scope replicas are refused before any query and local degradation is unaffected', async () => {
  const local = new FakeStore(baseRecords());
  const queries = { count: 0 };
  const foreign = [
    replica('replica-foreign-0', baseRecords(), { commitIndex: 10, scope: 'other-project', queries }),
    replica('replica-foreign-1', baseRecords(), { commitIndex: 10, scope: 'other-project', queries }),
  ];
  const localAnswer = await distributedProbe(request(), local, [], { mode: 'LOCAL', now: AT });
  const answer = await distributedProbe(request(), local, foreign, {
    mode: 'QUORUM',
    primaryCommitIndex: 10,
    now: AT,
  });
  assert.equal(queries.count, 0);
  assert.deepEqual(answer.partial.failed_nodes, ['replica-foreign-0', 'replica-foreign-1']);
  const outcomes = new Map(answer.nodes.filter((node) => node.replica_id !== 'local').map((node) => [node.replica_id, node.outcome]));
  assert.equal(outcomes.get('replica-foreign-0'), 'SCOPE_DENIED');
  assert.equal(outcomes.get('replica-foreign-1'), 'SCOPE_DENIED');
  assert.equal(answer.metadata.mode, 'LOCAL');
  assert.equal(answer.degraded, true);
  assert.equal(answer.metadata.stop_reason, 'NODE_UNAVAILABLE');
  assert.deepEqual(answer.response, localAnswer.response);
  assert.deepEqual(answer.candidates, localAnswer.candidates);
});

test('degraded-to-local answers keep LOCAL fact semantics', async () => {
  const local = new FakeStore(baseRecords());
  const localAnswer = await distributedProbe(request(), local, [], { mode: 'LOCAL', now: AT });
  const failing = [replica('replica-0', baseRecords(), { commitIndex: 10, throwOnQuery: true })];
  const degraded = await distributedProbe(request(), local, failing, {
    mode: 'QUORUM',
    primaryCommitIndex: 10,
    now: AT,
  });
  assert.deepEqual(degraded.response, localAnswer.response);
  assert.deepEqual(degraded.candidates, localAnswer.candidates);
  assert.equal(degraded.evidence_origin, 'local');
  assert.equal(localAnswer.evidence_origin, 'local');
  // Only annotation fields differ.
  assert.equal(degraded.degraded, true);
  assert.equal(localAnswer.degraded, false);
  assert.equal(degraded.metadata.mode, 'LOCAL');
  assert.equal(degraded.requested_mode, 'QUORUM');
});

test('LOCAL mode never queries replicas', async () => {
  const local = new FakeStore(baseRecords());
  const queries = { count: 0 };
  const nodes = [replica('replica-0', baseRecords(), { commitIndex: 10, queries })];
  const answer = await distributedProbe(request(), local, nodes, { mode: 'LOCAL', now: AT });
  assert.equal(queries.count, 0);
  assert.equal(answer.metadata.mode, 'LOCAL');
  assert.equal(answer.degraded, false);
  assert.equal(answer.consistency, 'CONSISTENT');
  assert.deepEqual(answer.partial.failed_nodes, []);
  assert.equal(answer.evidence_origin, 'local');
  assertValidResponse(answer.response);
});

test('distributed answers carry no Gate fields (evidence_id/verdict/task_id)', async () => {
  const local = new FakeStore(baseRecords());
  const nodes = [replica('replica-0', baseRecords(), { commitIndex: 10 })];
  const answer = await distributedProbe(request(), local, nodes, {
    mode: 'COMMITTED',
    primaryCommitIndex: 10,
    now: AT,
  });
  const serialized = JSON.stringify(answer);
  assert.equal(serialized.includes('"evidence_id"'), false);
  assert.equal(serialized.includes('"verdict"'), false);
  assert.equal(serialized.includes('"task_id"'), false);
  assert.equal('evidence_id' in answer, false);
  assert.equal('verdict' in answer, false);
  assert.equal('task_id' in answer, false);
  assert.equal(answer.response.schema_version, 'anchorprobe.context.v1');
});

test('the stores-inside-options call shape is also accepted', async () => {
  const local = new FakeStore(baseRecords());
  const nodes = [replica('replica-0', baseRecords(), { commitIndex: 10 })];
  const answer = await distributedProbe(request(), {
    localStore: local,
    replicas: nodes,
    mode: 'COMMITTED',
    primaryCommitIndex: 10,
    now: AT,
  });
  assert.equal(answer.metadata.mode, 'COMMITTED');
  assert.equal(answer.consistency, 'CONSISTENT');
  assertValidResponse(answer.response);
});

test('malformed requests and options fail fast', async () => {
  const local = new FakeStore(baseRecords());
  await assert.rejects(
    () => distributedProbe({ schema_version: ANCHOR_PROBE_REQUEST_SCHEMA_VERSION }, local, [], { mode: 'LOCAL' }),
    ProbeRequestError,
  );
  await assert.rejects(
    () => distributedProbe(request(), local, [], { mode: 'AS_OF' }),
    DistributedProbeError,
  );
});

test('T-146 unit: invalid mode, budgets, commit point and signal are refused deterministically', async () => {
  const local = new FakeStore(baseRecords());
  const cases: Array<Record<string, unknown>> = [
    { mode: 'BOGUS' },
    { deadlineMs: 0 },
    { deadlineMs: 1.5 },
    { nodeTimeoutMs: -1 },
    { mode: 'AS_OF', asOfCommitIndex: -1 },
    { mode: 'AS_OF', asOfCommitIndex: 1.5 },
    { primaryCommitIndex: -1 },
    { primaryCommitIndex: 2.5 },
    { signal: {} },
  ];
  for (const options of cases) {
    await assert.rejects(
      () => distributedProbe(request(), local, [], options),
      (error: unknown) => error instanceof DistributedProbeError && error.code === 'DISTRIBUTED_PROBE_OPTIONS_INVALID',
      JSON.stringify(options),
    );
  }
});

test('T-146 unit: a missing snapshot falls back to an explicit zero-digest snapshot', { timeout: 60_000 }, async () => {
  const local = new FakeStore(baseRecords(), { throwOnSnapshot: true });
  const controller = new AbortController();
  controller.abort();
  const answer = await distributedProbe(request(), local, [], {
    mode: 'QUORUM',
    signal: controller.signal,
  });
  assert.equal(answer.outcome, 'CANCELLED');
  assert.equal(answer.response.execution_status, 'FAILED');
  assert.equal(answer.response.snapshot.ledger_digest, '0'.repeat(64));
  assert.equal(answer.response.snapshot.project_scope, 'proj');
  assert.equal(answer.resources_released, true);
});

test('T-146 unit: local index/cursor faults degrade with the matching consistency marker', { timeout: 60_000 }, async () => {
  // candidates() throws -> indexErrors -> DEGRADED/UNKNOWN completeness.
  const broken = new FakeStore(baseRecords(), { throwOnCandidates: true });
  const unknown = await distributedProbe(request(), broken, [], { mode: 'LOCAL', now: AT });
  assert.equal(unknown.consistency, 'UNKNOWN');
  assert.equal(unknown.response.execution_status, 'DEGRADED');
  assert.equal(unknown.metadata.evidence_digest, EMPTY_DIGEST);

  // A required fact with no index entry and no slow-path record -> PARTIAL.
  const empty = new FakeStore([]);
  const partial = await distributedProbe(request({ required_facts: ['local.missing'] }), empty, [], { mode: 'LOCAL', now: AT });
  assert.equal(partial.consistency, 'PARTIAL');
  assert.equal(partial.response.budget_status.retrieval_completeness, 'PARTIAL');

  // A throwing replicaCommitIndex is tolerated; the commit point falls back to
  // the snapshot metadata instead of failing the answer.
  const noCursor = new FakeStore(baseRecords(), { throwOnCommitIndex: true });
  const answered = await distributedProbe(request(), noCursor, [], { mode: 'LOCAL', now: AT });
  assert.equal(answered.response.execution_status, 'OK');
  assert.equal(answered.metadata.commit_index, 0);

  // A malformed candidate makes digest recomputation fail closed to the empty digest.
  const malformed = new FakeStore([{ record_ref: 'r-x' } as unknown as ProbeCandidate]);
  const fallback = await distributedProbe(request(), malformed, [], { mode: 'LOCAL', now: AT });
  assert.equal(fallback.metadata.evidence_digest, EMPTY_DIGEST);
});

test('T-146 unit: duplicate edges across replicas are deduplicated once', { timeout: 60_000 }, async () => {
  const local = new FakeStore([]);
  const edge = (from: string, to: string, kind: 'related_to'): ProbeEdge => ({ from, to, kind, provenance: 'confirmed' });
  const nodes = [
    replica('replica-0', baseRecords(), { commitIndex: 10 }),
    replica('replica-1', baseRecords(), { commitIndex: 10 }),
  ];
  for (const node of nodes) {
    const store = node.store as FakeStore;
    void store;
  }
  const shared: DistributedReplicaNode[] = [
    {
      replicaId: 'edge-a',
      store: new FakeStore(baseRecords()),
      query: async () => ({ candidates: baseRecords(), edges: [edge('r-a', 'r-b', 'related_to')], commitIndex: 10 }),
    },
    {
      replicaId: 'edge-b',
      store: new FakeStore(baseRecords()),
      query: async () => ({
        candidates: baseRecords(),
        edges: [edge('r-a', 'r-b', 'related_to'), edge('r-b', 'r-c', 'related_to')],
        commitIndex: 10,
      }),
    },
  ];
  const answer = await distributedProbe(request(), local, shared, { mode: 'QUORUM', primaryCommitIndex: 10, now: AT });
  assert.equal(answer.metadata.mode, 'QUORUM');
  assert.equal(answer.partial.failed_nodes.length, 0);
  assert.equal(answer.resources_released, true);
});

test('T-146 unit: a deadline exhausted before dispatch marks the node TIMEOUT', { timeout: 60_000 }, async () => {
  const local = new FakeStore(baseRecords());
  const spinning = {
    replicaId: 'replica-spin',
    store: {
      get snapshot(): AnchorProbeSnapshot {
        const deadline = Date.now() + 5;
        while (Date.now() < deadline) { /* deterministic busy wait */ }
        return snap({ replica_id: 'replica-spin', commit_index: 10, replica_commit_index: 10 });
      },
      candidates: () => baseRecords(),
      adjacency: () => [],
    } as unknown as ProbeStore,
    commitIndex: 10,
  };
  const answer = await distributedProbe(request(), local, [spinning], {
    mode: 'COMMITTED',
    primaryCommitIndex: 10,
    deadlineMs: 1,
    now: AT,
  });
  const report = answer.nodes.find((node) => node.replica_id === 'replica-spin');
  assert.equal(report?.outcome, 'TIMEOUT');
  assert.match(report?.detail ?? '', /already exhausted/u);
});

test('T-146 unit: cancellation observed before dispatch and during a query both yield CANCELLED', { timeout: 60_000 }, async () => {
  const local = new FakeStore(baseRecords());

  // The scope check happens before the query: aborting while the snapshot is
  // read must refuse the node without ever invoking its query.
  const controller = new AbortController();
  let queried = false;
  const abortingSnapshot: DistributedReplicaNode = {
    replicaId: 'replica-aborting-snapshot',
    store: {
      get snapshot(): AnchorProbeSnapshot {
        controller.abort();
        return snap({ replica_id: 'replica-aborting-snapshot', commit_index: 10, replica_commit_index: 10 });
      },
      candidates: () => baseRecords(),
      adjacency: () => [],
    } as unknown as ProbeStore,
    commitIndex: 10,
    query: async () => {
      queried = true;
      return { candidates: baseRecords(), commitIndex: 10 };
    },
  };
  const cancelled = await distributedProbe(request(), local, [abortingSnapshot], {
    mode: 'COMMITTED',
    primaryCommitIndex: 10,
    signal: controller.signal,
    now: AT,
  });
  assert.equal(queried, false);
  assert.equal(cancelled.outcome, 'CANCELLED');
  // The scatter-level abort also fires, so the coordinator reports the node as
  // never queried rather than adopting the per-node cancellation report.
  const preDispatch = cancelled.nodes.find((node) => node.replica_id === 'replica-aborting-snapshot');
  assert.equal(preDispatch?.outcome, 'NOT_QUERIED');

  // A node that only answers on abort has its late result discarded.
  const secondController = new AbortController();
  const lateAnswer: DistributedReplicaNode = {
    replicaId: 'replica-late-answer',
    store: new FakeStore(baseRecords()),
    commitIndex: 10,
    query: (_request, context) => new Promise((resolve) => {
      context.signal.addEventListener('abort', () => resolve({ candidates: baseRecords(), commitIndex: 10 }));
    }),
  };
  const pending = distributedProbe(request(), local, [lateAnswer], {
    mode: 'COMMITTED',
    primaryCommitIndex: 10,
    signal: secondController.signal,
    now: AT,
  });
  await sleep(5);
  secondController.abort();
  const second = await pending;
  assert.equal(second.outcome, 'CANCELLED');
  // The scatter-level abort wins before the node result can be adopted, so the
  // coordinator deliberately reports the node as never queried.
  const late = second.nodes.find((node) => node.replica_id === 'replica-late-answer');
  assert.equal(late?.outcome, 'NOT_QUERIED');
});

test('T-146 unit: an unknown commit point disqualifies the node', { timeout: 60_000 }, async () => {
  const local = new FakeStore(baseRecords());
  const bareSnapshot: AnchorProbeSnapshot = {
    project_scope: 'proj',
    ledger_digest: HASH,
    graph_revision: null,
    source_fingerprint: HASH_B,
    connected_digest: null,
  };
  const node: DistributedReplicaNode = {
    replicaId: 'replica-no-commit',
    store: new FakeStore(baseRecords(), { snapshot: bareSnapshot }),
    query: async () => ({ candidates: baseRecords() }),
  };
  const answer = await distributedProbe(request(), local, [node], { mode: 'QUORUM', now: AT });
  const report = answer.nodes.find((entry) => entry.replica_id === 'replica-no-commit');
  assert.equal(report?.outcome, 'NODE_UNAVAILABLE');
  assert.match(report?.detail ?? '', /commit_index is unknown/u);
});

test('T-146 unit: QUORUM without any known primary commit point degrades explicitly', { timeout: 60_000 }, async () => {
  const bareSnapshot: AnchorProbeSnapshot = {
    project_scope: 'proj',
    ledger_digest: HASH,
    graph_revision: null,
    source_fingerprint: HASH_B,
    connected_digest: null,
  };
  const local = new FakeStore(baseRecords(), { snapshot: bareSnapshot });
  const node: DistributedReplicaNode = {
    replicaId: 'replica-no-primary',
    store: new FakeStore(baseRecords(), { snapshot: bareSnapshot }),
    query: async () => ({ candidates: baseRecords(), commitIndex: 10 }),
  };
  const answer = await distributedProbe(request(), local, [node], { mode: 'QUORUM', now: AT });
  assert.equal(answer.metadata.mode, 'LOCAL');
  assert.equal(answer.degraded, true);
  assert.equal(answer.metadata.degradation_reason, 'PRIMARY_COMMIT_UNKNOWN');
  assert.equal(answer.metadata.stop_reason, 'QUORUM_UNMET');
  assert.ok(answer.partial.gaps.includes('primary-commit-unknown'));
});

test('T-146 unit: the object call shape validates its local store and replica list', { timeout: 60_000 }, async () => {
  const local = new FakeStore(baseRecords());
  await assert.rejects(
    () => distributedProbe(request(), { localStore: null as unknown as ProbeStore, replicas: [] }),
    (error: unknown) => error instanceof DistributedProbeError && error.code === 'DISTRIBUTED_PROBE_OPTIONS_INVALID',
  );
  await assert.rejects(
    () => distributedProbe(request(), { localStore: local, replicas: 'nope' as unknown as DistributedReplicaNode[] }),
    (error: unknown) => error instanceof DistributedProbeError && error.code === 'DISTRIBUTED_PROBE_OPTIONS_INVALID',
  );
  await assert.rejects(
    () => distributedProbe(request(), {
      localStore: local,
      replicas: [{ replicaId: 'broken' } as unknown as DistributedReplicaNode],
    }),
    (error: unknown) => error instanceof DistributedProbeError && error.code === 'DISTRIBUTED_PROBE_OPTIONS_INVALID',
  );
  await assert.rejects(
    () => distributedProbe(request(), {
      localStore: local,
      replicas: [
        { replicaId: 'dup', store: local },
        { replicaId: 'dup', store: local },
      ],
    }),
    (error: unknown) => error instanceof DistributedProbeError && error.code === 'DISTRIBUTED_PROBE_OPTIONS_INVALID',
  );
});

test('T-146 unit: a node whose commit cursor throws and exposes no commit point is refused', { timeout: 60_000 }, async () => {
  const bareSnapshot: AnchorProbeSnapshot = {
    project_scope: 'proj',
    ledger_digest: HASH,
    graph_revision: null,
    source_fingerprint: HASH_B,
    connected_digest: null,
  };
  const local = new FakeStore(baseRecords());
  const node: DistributedReplicaNode = {
    replicaId: 'replica-cursor-fault',
    store: new FakeStore(baseRecords(), { snapshot: bareSnapshot, throwOnCommitIndex: true }),
    query: async () => ({ candidates: baseRecords() }),
  };
  const answer = await distributedProbe(request(), local, [node], { mode: 'QUORUM', now: AT });
  const report = answer.nodes.find((entry) => entry.replica_id === 'replica-cursor-fault');
  assert.equal(report?.outcome, 'NODE_UNAVAILABLE');
  assert.match(report?.detail ?? '', /commit_index is unknown/u);
});

test('T-146 unit: unmet quorum with no caught-up replica degrades with QUORUM_UNMET', { timeout: 60_000 }, async () => {
  // The local primary digest cannot be computed (malformed local candidate),
  // so no remote digest can match it and the QUORUM branch must say so.
  const local = new FakeStore([{ record_ref: 'r-local' } as unknown as ProbeCandidate]);
  const node: DistributedReplicaNode = {
    replicaId: 'replica-good',
    store: new FakeStore(baseRecords()),
    commitIndex: 10,
    query: async () => ({ candidates: baseRecords(), commitIndex: 10 }),
  };
  const answer = await distributedProbe(request(), local, [node], { mode: 'QUORUM', now: AT });
  assert.equal(answer.metadata.mode, 'LOCAL');
  assert.equal(answer.degraded, true);
  assert.equal(answer.metadata.degradation_reason, 'QUORUM_UNMET');
  assert.equal(answer.metadata.stop_reason, 'QUORUM_UNMET');
  assert.ok(answer.partial.gaps.includes('quorum:0'));
});

test('T-146 unit: a deadline that expires after scatter still marks the answer TIMEOUT', { timeout: 60_000 }, async () => {
  const local = new FakeStore(baseRecords());
  const node: DistributedReplicaNode = {
    replicaId: 'replica-fast',
    store: new FakeStore(baseRecords()),
    commitIndex: 10,
    query: async () => {
      offsetMs = 50;
      return { candidates: baseRecords(), commitIndex: 10 };
    },
  };

  // Advance the wall clock only once the node has answered, so the scatter
  // succeeds and the post-scatter deadline check observes an expired budget.
  const realNow = Date.now;
  let offsetMs = 0;
  Date.now = () => realNow() + offsetMs;
  let answer: Awaited<ReturnType<typeof distributedProbe>>;
  try {
    answer = await distributedProbe(request(), local, [node], {
      mode: 'COMMITTED',
      primaryCommitIndex: 10,
      deadlineMs: 10,
      now: AT,
    });
  } finally {
    Date.now = realNow;
  }

  assert.equal(answer!.metadata.stop_reason, 'TIMEOUT');
  assert.equal(answer!.consistency, 'PARTIAL');
  assert.ok(answer!.partial.gaps.includes('deadline'));
  assert.equal(answer!.resources_released, true);
});
