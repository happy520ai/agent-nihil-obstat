import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DistributedProbeError,
  distributedProbe,
  type DistributedNodeQuery,
  type DistributedReplicaNode,
} from '../../src/memory/distributed-probe.ts';
import { probeSchedulerStats, resetProbeScheduler } from '../../src/memory/probe-scheduler.ts';
import type { ProbeCandidate, ProbeEdge, ProbeEntryQuery } from '../../src/memory/probe.ts';
import {
  ANCHOR_PROBE_REQUEST_SCHEMA_VERSION,
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

/**
 * T-157 / MNT-01 behaviour branches.
 *
 * These tests pin the two new contracts:
 * - admission caps are process-wide/per-node and the FIFO queue is bounded;
 * - COMMITTED/QUORUM freeze as soon as their threshold is met and late results
 *   are reported as discarded instead of changing evidence;
 * - a lagging (below-primary) quorum and AS_OF still take the full gather, and
 *   an unmet threshold keeps the previous degrade-to-local semantics.
 */

const HASH = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
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

function candidate(recordRef: string, contentHash = HASH): ProbeCandidate {
  return {
    fact_key: 'local.storage.engine',
    task_id: null,
    file: null,
    symbol: null,
    source: { kind: 'native_note' },
    source_health: 'verified_at_snapshot',
    status: 'active',
    content: `content of ${recordRef}`,
    content_hash: contentHash,
    recorded_at: AT,
    effective_from: null,
    effective_to: null,
    superseded_by: null,
    version: null,
    anchor: { status: 'none', file: null },
    qualifiers: [],
    record_ref: recordRef,
  };
}

function baseRecords(): ProbeCandidate[] {
  return [candidate('r-a')];
}

function request(): Record<string, unknown> {
  return {
    schema_version: ANCHOR_PROBE_REQUEST_SCHEMA_VERSION,
    request_id: 'req-1',
    root: 'F:/project',
    project_scope: 'proj',
    required_facts: ['local.storage.engine'],
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
  readonly #snapshot: AnchorProbeSnapshot;
  readonly #records: readonly ProbeCandidate[];
  readonly #throwOnCandidates: boolean;

  constructor(
    records: readonly ProbeCandidate[],
    snapshot: AnchorProbeSnapshot = snap(),
    options: { throwOnCandidates?: boolean } = {},
  ) {
    this.#records = records;
    this.#snapshot = snapshot;
    this.#throwOnCandidates = options.throwOnCandidates ?? false;
  }

  get snapshot(): AnchorProbeSnapshot {
    return this.#snapshot;
  }

  replicaCommitIndex(): number | undefined {
    return this.#snapshot.cluster?.replica_commit_index;
  }

  candidates(query?: ProbeEntryQuery): readonly ProbeCandidate[] {
    if (this.#throwOnCandidates) throw new Error('local index unavailable');
    if (query === undefined || Object.keys(query).length === 0) return this.#records;
    return this.#records.filter((record) => matches(query, record));
  }

  adjacency(): readonly ProbeEdge[] {
    return [];
  }

  evidence(recordRef: string): ProbeEvidencePayload | undefined {
    const record = this.#records.find((entry) => entry.record_ref === recordRef);
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
    const record = this.#records.find((entry) => entry.record_ref === recordRef);
    return record === undefined
      ? undefined
      : {
        record_ref: record.record_ref,
        status: record.status,
        eligibility: 'governed',
        version: record.version,
        superseded_by: record.superseded_by,
        effective_from: record.effective_from,
        effective_to: record.effective_to,
      };
  }

  provenance(recordRef: string): ProbeProvenanceView | undefined {
    const record = this.#records.find((entry) => entry.record_ref === recordRef);
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
    return probeSnapshotIdentity(this.#snapshot);
  }
}

interface ReplicaOptions {
  readonly latencyMs?: number;
  readonly throwOnQuery?: boolean;
  readonly commitIndex?: number;
  readonly query?: DistributedNodeQuery;
}

function replica(id: string, options: ReplicaOptions = {}): DistributedReplicaNode {
  const commitIndex = options.commitIndex ?? 10;
  const store = new FakeStore(baseRecords(), snap({
    replica_id: id,
    commit_index: commitIndex,
    replica_commit_index: commitIndex,
  }));
  const builtIn: DistributedNodeQuery = async () => {
    if (options.latencyMs !== undefined && options.latencyMs > 0) await sleep(options.latencyMs);
    if (options.throwOnQuery === true) throw new Error(`replica ${id} is unavailable`);
    return { candidates: store.candidates(), edges: [], commitIndex };
  };
  return {
    replicaId: id,
    store,
    commitIndex,
    query: options.query ?? builtIn,
  };
}

function nodeOutcome(answer: Awaited<ReturnType<typeof distributedProbe>>, id: string): string | undefined {
  return answer.nodes.find((node) => node.replica_id === id)?.outcome;
}

test('admission caps bound global and per-node fan-out, then release to zero', async () => {
  resetProbeScheduler();
  let active = 0;
  let peak = 0;
  const perNode = new Map<string, number>();
  const peakPerNode = new Map<string, number>();
  const nodes = Array.from({ length: 6 }, (_unused, index) => {
    const id = `replica-${String(index)}`;
    return replica(id, {
      latencyMs: 15,
      query: async () => {
        active += 1;
        peak = Math.max(peak, active);
        const n = (perNode.get(id) ?? 0) + 1;
        perNode.set(id, n);
        peakPerNode.set(id, Math.max(peakPerNode.get(id) ?? 0, n));
        try {
          await sleep(15);
          return { candidates: baseRecords(), edges: [], commitIndex: 10 };
        } finally {
          active -= 1;
          perNode.set(id, (perNode.get(id) ?? 1) - 1);
        }
      },
    });
  });
  const answer = await distributedProbe(request(), new FakeStore(baseRecords()), nodes, {
    mode: 'AS_OF',
    asOfCommitIndex: 0,
    deadlineMs: 5_000,
    maxConcurrentNodes: 2,
    maxInFlightPerNode: 1,
    maxQueuedNodes: 16,
    earlyFreeze: false,
  });
  assert.equal(answer.metadata.mode, 'AS_OF');
  assert.equal(peak, 2, `global cap violated: peak ${String(peak)}`);
  assert.equal(Math.max(...peakPerNode.values()), 1, 'per-node cap violated');
  const stats = probeSchedulerStats();
  assert.equal(stats.inFlight, 0);
  assert.equal(stats.queued, 0);
});

test('the per-node cap is shared by two concurrently running probes', async () => {
  resetProbeScheduler();
  let active = 0;
  let peak = 0;
  const shared = replica('replica-shared', {
    query: async () => {
      active += 1;
      peak = Math.max(peak, active);
      try {
        await sleep(30);
        return { candidates: baseRecords(), edges: [], commitIndex: 10 };
      } finally {
        active -= 1;
      }
    },
  });
  const options = {
    mode: 'AS_OF' as const,
    asOfCommitIndex: 0,
    deadlineMs: 5_000,
    maxConcurrentNodes: 8,
    maxInFlightPerNode: 1,
    maxQueuedNodes: 8,
    earlyFreeze: false,
  };
  const [left, right] = await Promise.all([
    distributedProbe(request(), new FakeStore(baseRecords()), [shared], options),
    distributedProbe(request(), new FakeStore(baseRecords()), [shared], options),
  ]);
  assert.equal(left.metadata.mode, 'AS_OF');
  assert.equal(right.metadata.mode, 'AS_OF');
  assert.equal(peak, 1, `per-node cap not shared across calls: peak ${String(peak)}`);
  assert.equal(probeSchedulerStats().inFlight, 0);
});

test('a queue-full node is refused explicitly and does not hang the probe', async () => {
  resetProbeScheduler();
  let releaseHeld: () => void = () => undefined;
  const heldGate = new Promise<void>((resolve) => {
    releaseHeld = resolve;
  });
  const held = replica('replica-held', {
    query: async () => {
      await heldGate;
      return { candidates: baseRecords(), edges: [], commitIndex: 10 };
    },
  });
  const refused = replica('replica-refused');
  const probe = distributedProbe(request(), new FakeStore(baseRecords()), [held, refused], {
    mode: 'COMMITTED',
    primaryCommitIndex: 10,
    deadlineMs: 5_000,
    nodeTimeoutMs: 2_000,
    maxConcurrentNodes: 1,
    maxInFlightPerNode: 1,
    maxQueuedNodes: 0,
  });
  setTimeout(releaseHeld, 20);
  const answer = await probe;
  assert.equal(answer.metadata.mode, 'COMMITTED');
  assert.equal(nodeOutcome(answer, 'replica-held'), 'OK');
  assert.equal(nodeOutcome(answer, 'replica-refused'), 'NODE_UNAVAILABLE');
  const report = answer.nodes.find((node) => node.replica_id === 'replica-refused');
  assert.match(report?.detail ?? '', /scheduler refused the node query/);
  assert.deepEqual(answer.partial.failed_nodes, ['replica-refused']);
  assert.equal(answer.consistency, 'PARTIAL');
  assert.equal(probeSchedulerStats().inFlight, 0);
});

test('QUORUM freezes at the primary commit and never adopts a late conflicting digest', async () => {
  resetProbeScheduler();
  let releaseSlow: () => void = () => undefined;
  const slowGate = new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });
  let slowStarted = false;
  const fast = [replica('replica-fast-0', { latencyMs: 20 }), replica('replica-fast-1', { latencyMs: 25 })];
  const slow = replica('replica-slow', {
    query: async () => {
      slowStarted = true;
      await slowGate;
      return {
        candidates: [candidate('r-a', 'e'.repeat(64))],
        edges: [],
        commitIndex: 10,
      };
    },
  });
  try {
    const startedAt = Date.now();
    const answer = await distributedProbe(request(), new FakeStore(baseRecords()), [...fast, slow], {
      mode: 'QUORUM',
      primaryCommitIndex: 10,
      deadlineMs: 5_000,
      nodeTimeoutMs: 4_000,
    });
    const elapsed = Date.now() - startedAt;
    assert.equal(slowStarted, true);
    assert.ok(elapsed < 400, `early freeze did not skip the slow node: ${String(elapsed)}ms`);
    assert.equal(answer.metadata.mode, 'QUORUM');
    assert.equal(answer.metadata.quorum_size, 2);
    assert.equal(answer.metadata.quorum_count, 2, 'quorum_count is frozen at freeze time');
    assert.deepEqual(answer.metadata.quorum_digests, [answer.metadata.evidence_digest]);
    assert.equal(answer.consistency, 'CONSISTENT');
    assert.deepEqual(answer.conflicts, []);
    assert.deepEqual(answer.partial.failed_nodes, []);
    assert.equal(nodeOutcome(answer, 'replica-slow'), 'LATE_DISCARDED');
    assert.equal(answer.nodes.find((node) => node.replica_id === 'replica-slow')?.used, false);
    const frozen = structuredClone(answer);
    const frozenDigest = answer.metadata.evidence_digest;

    releaseSlow();
    await sleep(50);
    assert.deepEqual(answer, frozen, 'a late result must not rewrite the frozen answer');
    assert.equal(answer.metadata.evidence_digest, frozenDigest);
    assert.deepEqual(answer.conflicts, []);
    assert.equal(probeSchedulerStats().inFlight, 0);
  } finally {
    releaseSlow();
  }
});

test('COMMITTED freezes on the first qualifying node but keeps a real pre-freeze failure', async () => {
  resetProbeScheduler();
  let releaseSlow: () => void = () => undefined;
  const slowGate = new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });
  const good = replica('replica-good', { latencyMs: 30 });
  const throwing = replica('replica-throw', { throwOnQuery: true });
  const slow = replica('replica-slow', {
    query: async () => {
      await slowGate;
      return { candidates: baseRecords(), edges: [], commitIndex: 10 };
    },
  });
  try {
    const startedAt = Date.now();
    const answer = await distributedProbe(request(), new FakeStore(baseRecords()), [good, throwing, slow], {
      mode: 'COMMITTED',
      primaryCommitIndex: 10,
      deadlineMs: 5_000,
      nodeTimeoutMs: 4_000,
    });
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 400, `COMMITTED did not freeze: ${String(elapsed)}ms`);
    assert.equal(answer.metadata.mode, 'COMMITTED');
    assert.deepEqual(answer.partial.failed_nodes, ['replica-throw']);
    assert.equal(answer.consistency, 'PARTIAL');
    assert.equal(nodeOutcome(answer, 'replica-good'), 'OK');
    assert.equal(nodeOutcome(answer, 'replica-throw'), 'NODE_UNAVAILABLE');
    assert.equal(nodeOutcome(answer, 'replica-slow'), 'LATE_DISCARDED');
  } finally {
    releaseSlow();
  }
});

test('a lagging quorum below the primary commit still takes the full gather', async () => {
  resetProbeScheduler();
  const nodes = [
    replica('replica-lag-0', { latencyMs: 20, commitIndex: 9 }),
    replica('replica-lag-1', { latencyMs: 25, commitIndex: 9 }),
    replica('replica-fresh', { latencyMs: 150, commitIndex: 10 }),
  ];
  const startedAt = Date.now();
  const answer = await distributedProbe(request(), new FakeStore(baseRecords()), nodes, {
    mode: 'QUORUM',
    primaryCommitIndex: 10,
    deadlineMs: 5_000,
    nodeTimeoutMs: 4_000,
  });
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= 120, `a lagging quorum must not freeze early: ${String(elapsed)}ms`);
  assert.equal(answer.metadata.mode, 'QUORUM');
  assert.equal(answer.metadata.commit_index, 9);
  assert.equal(answer.metadata.stale, true);
  assert.equal(answer.metadata.quorum_count, 2);
  assert.equal(nodeOutcome(answer, 'replica-fresh'), 'OK');
});

test('AS_OF merges every qualifying response and does not freeze', async () => {
  resetProbeScheduler();
  const nodes = [
    replica('replica-a', { latencyMs: 20 }),
    replica('replica-b', { latencyMs: 150 }),
  ];
  const startedAt = Date.now();
  const answer = await distributedProbe(request(), new FakeStore(baseRecords()), nodes, {
    mode: 'AS_OF',
    asOfCommitIndex: 10,
    deadlineMs: 5_000,
    nodeTimeoutMs: 4_000,
  });
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= 120, `AS_OF must keep gathering: ${String(elapsed)}ms`);
  assert.equal(answer.metadata.mode, 'AS_OF');
  assert.equal(answer.metadata.quorum_count, 2);
  assert.equal(nodeOutcome(answer, 'replica-b'), 'OK');
});

test('an unmet QUORUM keeps the previous degrade-to-local semantics', async () => {
  resetProbeScheduler();
  let releaseLeft: () => void = () => undefined;
  let releaseRight: () => void = () => undefined;
  const leftGate = new Promise<void>((resolve) => {
    releaseLeft = resolve;
  });
  const rightGate = new Promise<void>((resolve) => {
    releaseRight = resolve;
  });
  const nodes = [
    replica('replica-up', { latencyMs: 10 }),
    replica('replica-held-0', { query: async () => { await leftGate; return { candidates: baseRecords(), edges: [], commitIndex: 10 }; } }),
    replica('replica-held-1', { query: async () => { await rightGate; return { candidates: baseRecords(), edges: [], commitIndex: 10 }; } }),
  ];
  try {
    const startedAt = Date.now();
    const answer = await distributedProbe(request(), new FakeStore(baseRecords()), nodes, {
      mode: 'QUORUM',
      primaryCommitIndex: 10,
      deadlineMs: 5_000,
      nodeTimeoutMs: 40,
    });
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= 35, `the unmet path must wait for its node budget: ${String(elapsed)}ms`);
    assert.equal(answer.degraded, true);
    assert.equal(answer.metadata.mode, 'COMMITTED');
    assert.equal(answer.partial.stop_reason, 'QUORUM_UNMET');
    assert.deepEqual(answer.partial.failed_nodes, ['replica-held-0', 'replica-held-1']);
    assert.equal(nodeOutcome(answer, 'replica-up'), 'OK');
  } finally {
    releaseLeft();
    releaseRight();
  }
});

test('invalid admission limits and earlyFreeze are rejected', async () => {
  resetProbeScheduler();
  const cases: Array<Record<string, unknown>> = [
    { maxConcurrentNodes: 0 },
    { maxConcurrentNodes: 1.5 },
    { maxInFlightPerNode: -1 },
    { maxQueuedNodes: Number.NaN },
    { earlyFreeze: 'yes' },
  ];
  for (const overrides of cases) {
    await assert.rejects(
      () => distributedProbe(request(), new FakeStore(baseRecords()), [replica('replica-0')], {
        mode: 'QUORUM',
        primaryCommitIndex: 10,
        ...overrides,
      } as Parameters<typeof distributedProbe>[3]),
      (error: unknown) => error instanceof DistributedProbeError
        && error.code === 'DISTRIBUTED_PROBE_OPTIONS_INVALID',
      JSON.stringify(overrides),
    );
  }
});

test('a response that completes after caller cancellation is discarded', async () => {
  resetProbeScheduler();
  const controller = new AbortController();
  const node = replica('replica-0', {
    query: async () => {
      // Abort the caller signal and still answer: the coordinator must not
      // adopt a response that raced cancellation.
      controller.abort();
      return { candidates: baseRecords(), edges: [], commitIndex: 10 };
    },
  });
  const answer = await distributedProbe(request(), new FakeStore(baseRecords()), [node], {
    mode: 'COMMITTED',
    primaryCommitIndex: 10,
    signal: controller.signal,
    deadlineMs: 5_000,
  });
  assert.equal(answer.outcome, 'CANCELLED');
  assert.equal(answer.partial.stop_reason, 'CANCELLED');
});

test('COMMITTED without a known primary digest never freezes and keeps its degrade path', async () => {
  resetProbeScheduler();
  const local = new FakeStore(baseRecords(), snap(), { throwOnCandidates: true });
  const answer = await distributedProbe(request(), local, [replica('replica-0', { latencyMs: 10 })], {
    mode: 'COMMITTED',
    primaryCommitIndex: 10,
    deadlineMs: 5_000,
  });
  assert.equal(answer.degraded, true);
  assert.equal(answer.metadata.mode, 'LOCAL');
  assert.equal(answer.partial.stop_reason, 'QUORUM_UNMET');
  assert.equal(answer.nodes.find((node) => node.replica_id === 'replica-0')?.outcome, 'OK');
});

test('LOCAL mode never queries a replica and ignores the scheduler caps', async () => {
  resetProbeScheduler();
  let queries = 0;
  const node = replica('replica-0', {
    query: async () => {
      queries += 1;
      return { candidates: baseRecords(), edges: [], commitIndex: 10 };
    },
  });
  const answer = await distributedProbe(request(), new FakeStore(baseRecords()), [node], {
    mode: 'LOCAL',
    maxConcurrentNodes: 1,
    maxInFlightPerNode: 1,
    maxQueuedNodes: 1,
  });
  assert.equal(answer.mode, 'LOCAL');
  assert.equal(queries, 0);
  assert.equal(nodeOutcome(answer, 'replica-0'), 'NOT_QUERIED');
  assert.equal(probeSchedulerStats().inFlight, 0);
});
