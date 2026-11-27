import assert from 'node:assert/strict';
import test from 'node:test';

import {
  runHaRecoveryBenchmark,
  type HaLatencyStats,
  type HaPhaseMetrics,
  type HaRecoveryBenchmarkResult,
} from '../../scripts/benchmark-ha-recovery.ts';
import {
  HA_CLUSTER_VERIFICATION_NOTE,
  HA_CLUSTER_VERIFICATION_SCOPE,
} from '../../src/memory/ha-cluster.ts';

/**
 * T-141 / HA-09 recovery benchmark gate.
 *
 * Named `.bench.ts`, so the repository core suite glob for `.test.ts` does not
 * pick it up. Run explicitly:
 *   node --test test/benchmark/ha-recovery.bench.ts
 *
 * The gate asserts the acceptance invariants of the local HA recovery
 * benchmark on real loopback TCP:
 *   - every reported RTO / RPO / recovery-time / throughput / P95 / P99 field
 *     is a finite number;
 *   - a follower crash with the majority intact never interrupts commits;
 *   - after rejoin the projection equals the expected fingerprint, RPO is 0
 *     and no committed entry stays missing;
 *   - repeated kill/restore keeps integrity equal to the no-fault baseline and
 *     leaves no listener/proxy/client/socket open after close;
 *   - the frozen verification-scope boundary constant is carried into the run.
 *
 * Set `HA_RECOVERY_BENCH_SCALE=S` to amplify the workload; smoke stays well
 * inside the 180s test budget.
 */

const SCALE = (() => {
  const value = process.env.HA_RECOVERY_BENCH_SCALE;
  return value === 'S' ? 'S' : 'smoke';
})();

const SEED = 20_261_1125;
const TEST_TIMEOUT_MS = 180_000;

function assertFinite(value: number, label: string): void {
  assert.equal(Number.isFinite(value), true, `${label} must be a finite number, got ${String(value)}`);
}

function assertLatencyFinite(stats: HaLatencyStats, label: string): void {
  for (const [key, value] of Object.entries(stats)) {
    if (typeof value === 'number') assertFinite(value, `${label}.${key}`);
  }
}

function assertPhaseFinite(phase: HaPhaseMetrics, label: string): void {
  assertFinite(phase.attempts, `${label}.attempts`);
  assertFinite(phase.committed, `${label}.committed`);
  assertFinite(phase.rejected, `${label}.rejected`);
  assertFinite(phase.errorRate, `${label}.errorRate`);
  assertFinite(phase.durationMs, `${label}.durationMs`);
  assertFinite(phase.throughputPerSec, `${label}.throughputPerSec`);
  assertLatencyFinite(phase.latency, `${label}.latency`);
  assertLatencyFinite(phase.commitLatency, `${label}.commitLatency`);
}

test('HA recovery benchmark carries the frozen local-TCP verification scope', () => {
  assert.equal(HA_CLUSTER_VERIFICATION_SCOPE, 'local-tcp-protocol-only');
  assert.ok(HA_CLUSTER_VERIFICATION_NOTE.includes('≠ OS 真分区'));
  assert.ok(HA_CLUSTER_VERIFICATION_NOTE.includes('未验证'));
});

test(`HA recovery benchmark passes RTO/RPO/recovery gates (scale=${SCALE})`, { timeout: TEST_TIMEOUT_MS }, async () => {
  const result: HaRecoveryBenchmarkResult = await runHaRecoveryBenchmark({ scale: SCALE, seed: SEED });
  const { leaderFailover: lf, followerCrash: fc, rejoinCatchUp: rc, repeatedRecovery: rr, loadLatency: ll } = result.scenarios;

  // 1. Boundary, command and honesty metadata.
  assert.equal(result.schema, 'ha-recovery.benchmark.v1');
  assert.equal(result.scale, SCALE);
  assert.equal(result.seed, SEED);
  assert.equal(result.verificationScope, HA_CLUSTER_VERIFICATION_SCOPE);
  assert.ok(result.verificationNote.includes('未验证'));
  assert.ok(result.definitions.rto.startsWith('RTO ='));
  assert.ok(result.definitions.rpo.startsWith('RPO ='));
  assert.ok(result.limitations.some((item) => item.includes('[数据缺失]')));
  assert.ok(result.limitations.some((item) => item.includes('≠ OS 真分区')));

  // 2. Every metric field is a finite number (no NaN/Infinity silently shipped).
  assertPhaseFinite(lf.normal, 'leaderFailover.normal');
  assertPhaseFinite(lf.switchWindow, 'leaderFailover.switchWindow');
  assertPhaseFinite(lf.postFailover, 'leaderFailover.postFailover');
  assertPhaseFinite(fc.normal, 'followerCrash.normal');
  assertPhaseFinite(fc.faultWindow, 'followerCrash.faultWindow');
  assertPhaseFinite(rc.faultWindow, 'rejoinCatchUp.faultWindow');
  assertPhaseFinite(ll.normal, 'loadLatency.normal');
  assertPhaseFinite(ll.faultWindow, 'loadLatency.faultWindow');
  for (const [label, value] of Object.entries({
    'leaderFailover.rtoMs': lf.rtoMs,
    'leaderFailover.switchRejectionRate': lf.switchRejectionRate,
    'leaderFailover.oldLeaderRejoinMs': lf.oldLeaderRejoinMs,
    'followerCrash.throughputRatioFaultToNormal': fc.throughputRatioFaultToNormal,
    'rejoinCatchUp.catchUpMs': rc.catchUpMs,
    'rejoinCatchUp.lagCommitIndexBeforeRejoin': rc.lagCommitIndexBeforeRejoin,
    'rejoinCatchUp.recordsSeen': rc.recordsSeen,
    'rejoinCatchUp.ingested': rc.ingested,
    'repeatedRecovery.cycles': rr.cycles,
    'repeatedRecovery.committedTotal': rr.committedTotal,
    'loadLatency.p95DeltaMs': ll.p95DeltaMs,
    'loadLatency.p99DeltaMs': ll.p99DeltaMs,
    'loadLatency.throughputRatioFaultToNormal': ll.throughputRatioFaultToNormal,
  })) {
    assertFinite(value, label);
  }

  // 3. Leader failover: recovery happened, new epoch/term won, old leader caught
  //    up without overwriting the new leader.
  assert.equal(lf.recovered, true);
  assert.ok(lf.rtoMs > 0, 'RTO must be positive once a commit recovers');
  assert.ok(lf.switchAttempts >= 1);
  assert.ok(lf.switchRejected >= 1, 'the isolated old leader must refuse at least one proposal during the switch');
  assert.notEqual(lf.leaderAfter, lf.leaderBefore);
  assert.ok(lf.termAfter > lf.termBefore || lf.epochAfter > lf.epochBefore);
  assert.equal(lf.oldLeaderLogEqual, true, 'old leader must catch up the new leader log');
  assert.equal(lf.switchWindow.rejectionCodes['QUORUM_NOT_REACHED'] ?? 0, lf.switchRejected);
  // The only unacknowledged loss allowed here is the refused switch proposal(s).
  assert.equal(lf.rpoUnacknowledgedLost, lf.switchRejected);

  // 4. Follower crash with an intact majority: no availability interruption.
  assert.equal(fc.victim, 'n3');
  assert.equal(fc.quorumReachableDuringFault, true);
  assert.equal(fc.availabilityInterrupted, false, 'majority commits must not be interrupted by one follower loss');
  assert.equal(fc.faultWindow.rejected, 0);
  assert.ok(fc.commitsDuringFault > 0);
  assert.equal(fc.faultWindow.errorRate, 0);
  assert.ok(fc.replicationFailuresDuringFault > 0, 'the dead follower must surface as replication failures');
  assert.equal(fc.logEqualAfterRejoin, true);
  assert.equal(fc.rpoUnacknowledgedLost, 0);
  assert.equal(fc.resourceCleanAfterClose, true);

  // 5. Rejoin catch-up: lag observed, catch-up fast, RPO=0, projection exact.
  assert.ok(rc.lagCommitIndexBeforeRejoin > 0, 'the downed follower must lag behind before rejoin');
  assert.ok(rc.catchUpMs > 0);
  assert.ok(rc.recordsSeen > 0 && rc.recordsApplied > 0);
  assert.equal(rc.rpoUnacknowledgedLost, 0, 'majority commits must not depend on the dead replica');
  assert.equal(rc.committedMissingAfterRecovery, 0);
  assert.equal(rc.projectionEqual, true, 'projection fingerprint must match the deterministic expected set');
  assert.equal(rc.logEqualAfterRejoin, true);
  assert.equal(rc.faultWindow.rejected, 0);

  // 6. Repeated kill/restore: integrity equals the no-fault baseline, no leak.
  assert.ok(rr.cycles > 0);
  assert.equal(rr.perCycle.length, rr.cycles);
  assert.ok(rr.perCycle.every((cycle) => cycle.logEqualAfterRejoin));
  assert.ok(rr.perCycle.every((cycle) => cycle.rejoinMs > 0));
  assert.equal(rr.integrityEqual, true, 'stress projection must equal the no-fault baseline projection');
  assert.equal(rr.noLeak, true);
  assert.equal(rr.baselineClosedClean, true);
  assert.deepEqual(rr.resourceAfterClose, {
    nodes_open: 0,
    ha_servers_open: 0,
    replica_servers_open: 0,
    proxies_open: 0,
    clients_open: 0,
    active_connections: 0,
  });

  // 7. Load windows report separately and stay finite.
  assert.ok(ll.normal.committed > 0 && ll.faultWindow.committed > 0);
  assert.equal(ll.normal.errorRate, 0);
  assert.equal(ll.faultWindow.errorRate, 0);

  // 8. The benchmark's own acceptance checks are green.
  assert.ok(result.checks.length >= 6);
  for (const check of result.checks) {
    assert.equal(check.passed, true, `${check.name}: ${check.detail}`);
  }
  assert.equal(result.passed, true);
});
