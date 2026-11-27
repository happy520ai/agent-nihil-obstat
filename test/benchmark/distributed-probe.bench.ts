import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  runDistributedBenchmark,
  type ArmRow,
} from '../../scripts/benchmark-distributed-probe.ts';
import {
  buildFixture,
  type BenchmarkScale,
} from '../../scripts/benchmark-anchor-probe.ts';

/**
 * Distributed probe benchmark smoke gate (T-131 / M15).
 *
 * Named `.bench.ts`, so the repository core suite glob for `.test.ts` does not
 * pick it up. Run explicitly:
 *   node --test test/benchmark/distributed-probe.bench.ts
 *
 * The gate asserts the acceptance invariants of the T-131 comparison:
 *   - the fixture is reproducible from its seed;
 *   - the distributed COMMITTED / QUORUM candidate sets are exactly equal to
 *     the local projected candidate set over the same entries/snapshot/budget/
 *     request set (a faster answer with different semantics must fail here);
 *   - the degraded arm is explicitly non-COMPLETE and carries failed nodes;
 *   - every reported metric is a finite number;
 *   - two real child processes were started and none survives the test.
 *
 * Set `DISTRIBUTED_PROBE_BENCH_SCALE=M` (or `L`) to run a larger tier locally.
 */

const SCALE: BenchmarkScale = (() => {
  const value = process.env.DISTRIBUTED_PROBE_BENCH_SCALE;
  if (value === 'S' || value === 'M' || value === 'L' || value === 'smoke') return value;
  return 'smoke';
})();

const ITERATIONS = SCALE === 'smoke' ? 10 : SCALE === 'S' ? 6 : 4;
const TEST_TIMEOUT_MS = SCALE === 'smoke' || SCALE === 'S' ? 120_000 : 240_000;

function removeTempRoot(root: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch {
      if (attempt >= 9) return;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

function processExists(pid: number | null): boolean {
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user/context.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function assertFinite(value: number, label: string): void {
  assert.equal(Number.isFinite(value), true, `${label} must be a finite number, got ${String(value)}`);
}

function assertArmMetricsFinite(row: ArmRow): void {
  assertFinite(row.coldStartMs, `${row.arm}.coldStartMs`);
  for (const [key, value] of Object.entries(row.warm)) {
    if (typeof value === 'number') assertFinite(value, `${row.arm}.warm.${key}`);
  }
  assertFinite(row.maxTailMs, `${row.arm}.maxTailMs`);
  assertFinite(row.recall, `${row.arm}.recall`);
  assertFinite(row.correctMerge, `${row.arm}.correctMerge`);
  assertFinite(row.conflicts, `${row.arm}.conflicts`);
  assertFinite(row.stale, `${row.arm}.stale`);
  assertFinite(row.failureRate, `${row.arm}.failureRate`);
  assertFinite(row.heapUsedDeltaBytes, `${row.arm}.heapUsedDeltaBytes`);
  assertFinite(row.rssDeltaBytes, `${row.arm}.rssDeltaBytes`);
  assertFinite(row.rebuildMs, `${row.arm}.rebuildMs`);
  assertFinite(row.diskBytes, `${row.arm}.diskBytes`);
}

test('the synthetic fixture is reproducible from its seed', () => {
  const left = buildFixture(SCALE, 20_261_122);
  const right = buildFixture(SCALE, 20_261_122);
  assert.equal(left.viewDigest, right.viewDigest);
  assert.equal(left.entries.length, right.entries.length);
  assert.equal(left.composition.totalEvents, right.composition.totalEvents);
  const other = buildFixture(SCALE, 20_261_123);
  assert.notEqual(left.viewDigest, other.viewDigest);
});

test('the distributed probe benchmark passes the same-semantics and cleanup gates', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const workRoot = mkdtempSync(join(tmpdir(), 'ano-distributed-probe-bench-'));
  const livePids: Array<number | null> = [];
  t.after(() => {
    for (const pid of livePids) {
      if (processExists(pid)) {
        try {
          process.kill(pid as number, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    }
    removeTempRoot(workRoot);
  });

  const result = await runDistributedBenchmark({
    scale: SCALE,
    seed: 20_261_122,
    iterations: ITERATIONS,
    workRoot,
  });
  livePids.push(...result.replication.replicas.map((replica) => replica.pid));

  // 1. Same-semantics equivalence gate over the same fixture/requests/budget.
  assert.equal(result.equivalence.fixtureReproducible, true);
  assert.equal(result.equivalence.snapshotFingerprintEqual, true);
  assert.equal(result.equivalence.storeCandidatesEqual, true);
  assert.equal(result.equivalence.committedEqualsLocal, true);
  assert.equal(result.equivalence.quorumEqualsLocal, true);
  assert.deepEqual(result.equivalence.mismatches, []);
  assert.equal(result.equivalence.passed, true);
  assert.equal(result.equivalence.candidateCounts.local, result.equivalence.candidateCounts.committed);
  assert.equal(result.equivalence.candidateCounts.local, result.equivalence.candidateCounts.quorum);
  assert.ok((result.equivalence.candidateCounts.local ?? 0) > 0, 'the fixture must produce candidates');

  // 2. Arm matrix covers single-node and distributed groups.
  const arms = result.arms;
  assert.deepEqual(arms.map((row) => row.arm), [
    'local-projected',
    'sqlite',
    'bitchain',
    'distributed-committed',
    'distributed-quorum',
    'distributed-degraded',
  ]);

  // 3. Every metric field is a finite number.
  for (const row of arms) assertArmMetricsFinite(row);
  assertFinite(result.replication.setupMs, 'replication.setupMs');
  assertFinite(result.replication.catchUpMs, 'replication.catchUpMs');
  assertFinite(result.replication.appliedEvents, 'replication.appliedEvents');
  assertFinite(result.replication.diskBytes, 'replication.diskBytes');
  assertFinite(result.cost.heapUsedBeforeBytes, 'cost.heapUsedBeforeBytes');
  assertFinite(result.cost.heapUsedAfterBytes, 'cost.heapUsedAfterBytes');
  assertFinite(result.cost.rssBeforeBytes, 'cost.rssBeforeBytes');
  assertFinite(result.cost.rssAfterBytes, 'cost.rssAfterBytes');

  // 4. Quality against the fixture truth: recall 1, conflict count equals the
  // fixture's conflicted-fact count, no stale/superseded evidence use.
  const expectedConflicts = result.fixture.composition.conflictedFacts;
  for (const row of arms) {
    assert.equal(row.recall, 1, `${row.arm} recall`);
    assert.equal(row.correctMerge, 1, `${row.arm} correct merge`);
    assert.equal(row.conflicts, expectedConflicts, `${row.arm} conflict count`);
    assert.equal(row.stale, 0, `${row.arm} stale evidence`);
    assert.equal(row.failureRate, 0, `${row.arm} failure rate`);
  }

  // 5. Degraded group is explicitly non-COMPLETE and reports failed nodes.
  const degraded = arms.find((row) => row.arm === 'distributed-degraded');
  assert.ok(degraded !== undefined, 'degraded arm missing');
  assert.equal(degraded!.degraded, true, 'degraded arm must be marked degraded');
  assert.notEqual(degraded!.consistency, 'CONSISTENT', 'degraded arm must not claim CONSISTENT');
  assert.ok(degraded!.failedNodes > 0, 'degraded arm must carry failed_nodes');
  assert.ok(
    degraded!.retrievalCompleteness === 'PARTIAL' || degraded!.retrievalCompleteness === 'COMPLETE_WITHIN_DECLARED_SCOPE',
    'degraded retrieval completeness must be an explicit non-UNKNOWN value',
  );
  assert.equal(result.equivalence.degradedNonComplete, true);
  assert.equal(result.equivalence.degradedFailedNodes, true);

  // 6. Two real child processes were started and none survives the run.
  assert.equal(result.replication.replicas.length, 2, 'exactly two replica processes');
  assert.equal(result.replication.appliedEvents, result.fixture.composition.totalEvents);
  for (const replica of result.replication.replicas) {
    assert.ok(replica.pid !== null, `${replica.replicaId} must carry a real pid`);
    assert.equal(replica.stopped, true, `${replica.replicaId} must be stopped by the benchmark`);
    assert.equal(replica.aliveAfterStop, false, `${replica.replicaId} must not survive stop`);
    assert.equal(processExists(replica.pid), false, `${replica.replicaId} pid ${String(replica.pid)} is an orphan`);
  }

  // 7. Replication cost is timed separately from query latency.
  assert.ok(result.replication.setupMs > 0);
  assert.ok(result.replication.diskBytes > 0);
  assert.ok(result.replication.replicas.every((replica) => replica.diskBytes > 0));

  // 8. Limitations stay honest and the run reports no missing data silently.
  assert.ok(result.limitations.some((item) => item.includes('[数据缺失]')));
});
