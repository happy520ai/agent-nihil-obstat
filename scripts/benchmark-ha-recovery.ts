import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir, platform, arch, release, cpus, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import {
  canonicalJson,
  hashEvent,
  ledgerEventSchema,
  type LedgerEvent,
} from '../src/ledger/event.ts';
import {
  HA_CLUSTER_VERIFICATION_NOTE,
  HA_CLUSTER_VERIFICATION_SCOPE,
  HaCluster,
  type HaClusterProjection,
  type HaProposeResult,
  type HaRejoinResult,
  type HaResourceStats,
} from '../src/memory/ha-cluster.ts';

/**
 * T-141 / HA-09: local high availability, RTO/RPO and recovery stress
 * acceptance for the T-139 real loopback-TCP cluster.
 *
 * Honesty rules (mirroring docs/evidence/distributed-probe-benchmark.md):
 * - Every number comes from this real run on this machine over real loopback
 *   TCP frames through the T-138 protocol-layer fault proxy. Nothing here is
 *   extrapolated to a physical three-machine deployment, an OS-level partition
 *   or a production availability SLA.
 * - A node "crash" in this single-process benchmark is a genuine socket-level
 *   cut of every link touching that node (`HaCluster.isolate` rebuilds each
 *   directed link with drop rules). It is NOT an OS process SIGKILL: the three
 *   members live in one test process, so killing one member's OS process would
 *   kill the whole benchmark. The distinction is carried into the report.
 * - There is no automatic failover daemon in ha-cluster.ts: election is driven
 *   by the caller. Therefore RTO below is measured from fault injection to the
 *   first successful commit and explicitly includes the benchmark-driven
 *   re-election; it is not an autonomous-failover SLA.
 * - Definitions are written into `definitions` in the result and rendered in
 *   the Markdown so a reader can never mistake them for vendor SLO wording.
 */

// ---------------------------------------------------------------------------
// Scale profile, seeds and small utilities
// ---------------------------------------------------------------------------

export type HaRecoveryScale = 'smoke' | 'S';

export interface HaRecoveryBenchmarkOptions {
  readonly scale: HaRecoveryScale;
  readonly seed: number;
}

interface ScaleProfile {
  readonly normalCommits: number;
  readonly postFailoverCommits: number;
  readonly followerFaultCommits: number;
  readonly rejoinBaseCommits: number;
  readonly rejoinFaultCommits: number;
  readonly repeatedCycles: number;
  readonly repeatedPerCycle: number;
  readonly repeatedInitial: number;
  readonly loadNormalCommits: number;
  readonly loadFaultCommits: number;
}

const DEFAULT_SEED = 20_261_1125;

const SCALE_PROFILE: Readonly<Record<HaRecoveryScale, ScaleProfile>> = {
  smoke: {
    normalCommits: 24,
    postFailoverCommits: 8,
    followerFaultCommits: 12,
    rejoinBaseCommits: 4,
    rejoinFaultCommits: 10,
    repeatedCycles: 3,
    repeatedPerCycle: 2,
    repeatedInitial: 3,
    loadNormalCommits: 24,
    loadFaultCommits: 12,
  },
  S: {
    normalCommits: 80,
    postFailoverCommits: 24,
    followerFaultCommits: 20,
    rejoinBaseCommits: 8,
    rejoinFaultCommits: 16,
    repeatedCycles: 4,
    repeatedPerCycle: 3,
    repeatedInitial: 6,
    loadNormalCommits: 80,
    loadFaultCommits: 20,
  },
};

/** Loopback-only cluster knobs; the request budget bounds fault-window stalls. */
const CLUSTER_OPTIONS = {
  leaseDurationMs: 30_000,
  heartbeatTimeoutMs: 30_000,
  requestTimeoutMs: 500,
  connectTimeoutMs: 1_000,
} as const;

const WRITER_ID = 'bench-writer';
const ID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveTimer) => setTimeout(resolveTimer, ms));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Deterministic ULID-like id so a fixed seed reproduces the same event bytes. */
function ulidLike(seed: number): string {
  let value = seed >>> 0;
  let out = '';
  for (let index = 0; index < 26; index += 1) {
    out += ID_ALPHABET[value % 32];
    value = Math.floor(value / 32) + index * 7 + 1;
  }
  return out;
}

/**
 * One deterministic ledger event per global sequence number. `prev_hash` stays
 * the genesis hash throughout: this benchmark exercises HA commit/recovery, not
 * ledger chain semantics, so no fake chain is claimed.
 */
function makeEvent(seq: number, seed: number): LedgerEvent {
  const label = `ha-recovery-${String(seq)}`;
  return ledgerEventSchema.parse({
    id: ulidLike(seed + seq),
    hlc: { physical: 1_700_000_000_000 + seq, logical: 0, actor: WRITER_ID },
    actor: WRITER_ID,
    kind: 'note.recorded',
    payload: { label, seq, seed },
    idem_key: `t141-${label}`,
    prev_hash: '0'.repeat(64),
  });
}

function errorCodeOf(error: unknown): string {
  if (error instanceof Error && 'code' in error && typeof (error as { code?: unknown }).code === 'string') {
    return (error as { code: string }).code;
  }
  return 'UNKNOWN';
}

function environmentRecord(): Record<string, unknown> {
  return {
    node: process.version,
    platform: platform(),
    arch: arch(),
    release: release(),
    cpuModel: cpus()[0]?.model ?? 'unknown',
    cpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
  };
}

function zeroResourceStats(): HaResourceStats {
  return {
    nodes_open: 0,
    ha_servers_open: 0,
    replica_servers_open: 0,
    proxies_open: 0,
    clients_open: 0,
    active_connections: 0,
  };
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export interface HaLatencyStats {
  readonly count: number;
  readonly minMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  readonly meanMs: number;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index]!;
}

function latencyStats(samples: readonly number[]): HaLatencyStats {
  if (samples.length === 0) {
    return { count: 0, minMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0, meanMs: 0 };
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    minMs: round(sorted[0]!),
    p50Ms: round(percentile(sorted, 50)),
    p95Ms: round(percentile(sorted, 95)),
    p99Ms: round(percentile(sorted, 99)),
    maxMs: round(sorted[sorted.length - 1]!),
    meanMs: round(sum / sorted.length),
  };
}

export interface HaPhaseMetrics {
  readonly label: string;
  readonly attempts: number;
  readonly committed: number;
  readonly rejected: number;
  /** rejected / attempts; a refused proposal is an explicit failure, not a crash. */
  readonly errorRate: number;
  readonly durationMs: number;
  readonly throughputPerSec: number;
  /** Every attempt (successful or refused), wall-clock around propose(). */
  readonly latency: HaLatencyStats;
  /** Successful commits only. */
  readonly commitLatency: HaLatencyStats;
  readonly rejectionCodes: Readonly<Record<string, number>>;
}

interface AttemptOutcome {
  readonly ok: boolean;
  readonly elapsedMs: number;
  readonly hash: string;
  readonly commitIndex: number;
  readonly code: string;
  readonly replicationFailures: number;
}

class PhaseCollector {
  readonly label: string;
  private readonly latencies: number[] = [];
  private readonly commitLatencies: number[] = [];
  private readonly codes: Record<string, number> = {};
  private attemptsCount = 0;
  private committedCount = 0;
  private rejectedCount = 0;

  constructor(label: string) {
    this.label = label;
  }

  get attempts(): number {
    return this.attemptsCount;
  }

  get committed(): number {
    return this.committedCount;
  }

  get rejected(): number {
    return this.rejectedCount;
  }

  get errorRate(): number {
    return this.attemptsCount === 0 ? 0 : round(this.rejectedCount / this.attemptsCount, 4);
  }

  record(outcome: AttemptOutcome): void {
    this.attemptsCount += 1;
    this.latencies.push(outcome.elapsedMs);
    if (outcome.ok) {
      this.committedCount += 1;
      this.commitLatencies.push(outcome.elapsedMs);
    } else {
      this.rejectedCount += 1;
      const code = outcome.code.length === 0 ? 'UNKNOWN' : outcome.code;
      this.codes[code] = (this.codes[code] ?? 0) + 1;
    }
  }

  metrics(durationMs: number): HaPhaseMetrics {
    return {
      label: this.label,
      attempts: this.attemptsCount,
      committed: this.committedCount,
      rejected: this.rejectedCount,
      errorRate: this.attemptsCount === 0 ? 0 : round(this.rejectedCount / this.attemptsCount, 4),
      durationMs: round(durationMs),
      throughputPerSec: durationMs > 0 ? round(this.committedCount / (durationMs / 1_000), 3) : 0,
      latency: latencyStats(this.latencies),
      commitLatency: latencyStats(this.commitLatencies),
      rejectionCodes: { ...this.codes },
    };
  }
}

// ---------------------------------------------------------------------------
// Cluster helpers
// ---------------------------------------------------------------------------

async function startBenchCluster(): Promise<HaCluster> {
  return await HaCluster.start(CLUSTER_OPTIONS);
}

async function electLeader(cluster: HaCluster, memberId: string) {
  const result = await cluster.elect(memberId);
  if (!result.won || result.lease === null) {
    throw new Error(`T-141 benchmark: election of ${memberId} did not win (votes=${String(result.votes)})`);
  }
  return result;
}

/**
 * Normal steady-state lease refresh. A follower that never held a lease answers
 * rejoin probes with itself as leader, which peers record as a same-term rival
 * and which makes the next commit refuse under SPLIT_BRAIN. Real operation
 * renews the lease with followers, so the benchmark does the same before any
 * follower rejoin. This uses only public manager APIs; no frozen code changes.
 */
async function refreshLeaderLease(cluster: HaCluster, leaderId: string): Promise<void> {
  const renewal = await cluster.node(leaderId).manager.renewLease();
  if (!renewal.renewed) {
    throw new Error(`T-141 benchmark: lease renewal on ${leaderId} failed (${renewal.reason} acks=${String(renewal.acks)})`);
  }
}

async function attemptPropose(
  cluster: HaCluster,
  memberId: string,
  lease: { epoch: number; term: number },
  seq: number,
  seed: number,
): Promise<AttemptOutcome> {
  const event = makeEvent(seq, seed);
  const hash = hashEvent(event);
  const started = performance.now();
  try {
    const result: HaProposeResult = await cluster.propose({
      memberId,
      writerId: WRITER_ID,
      epoch: lease.epoch,
      term: lease.term,
      localSeq: seq,
      ledgerEvent: event,
      ledgerEventHash: hash,
    });
    return {
      ok: true,
      elapsedMs: performance.now() - started,
      hash,
      commitIndex: result.commit_index,
      code: '',
      replicationFailures: result.replication_failures.length,
    };
  } catch (error) {
    return {
      ok: false,
      elapsedMs: performance.now() - started,
      hash,
      commitIndex: 0,
      code: errorCodeOf(error),
      replicationFailures: 0,
    };
  }
}

function logHashes(cluster: HaCluster, memberId: string): string[] {
  return cluster.node(memberId).log.getEntries().map((record) => record.entry.identity.ledger_event_hash);
}

function committedHashes(cluster: HaCluster): Set<string> {
  const set = new Set<string>();
  for (const memberId of cluster.memberIds) {
    for (const record of cluster.node(memberId).log.getEntries()) {
      if (record.entry.status === 'committed' || record.entry.status === 'adjudicated') {
        set.add(record.entry.identity.ledger_event_hash);
      }
    }
  }
  return set;
}

function unacknowledgedLostCount(rejectedHashes: readonly string[], committed: ReadonlySet<string>): number {
  let lost = 0;
  for (const hash of new Set(rejectedHashes)) {
    if (!committed.has(hash)) lost += 1;
  }
  return lost;
}

interface FingerprintEntry {
  readonly h: string;
  readonly s: string;
  readonly c: number;
}

function sortFingerprintEntries(entries: readonly FingerprintEntry[]): FingerprintEntry[] {
  return [...entries].sort((left, right) => {
    if (left.h !== right.h) return compareText(left.h, right.h);
    return left.c - right.c;
  });
}

/** Deterministic projection fingerprint over retained entries + adjudications. */
function projectionFingerprint(projection: HaClusterProjection): string {
  const entries = sortFingerprintEntries(
    projection.entries.map((entry) => ({
      h: entry.identity.ledger_event_hash,
      s: entry.status,
      c: entry.commit_index,
    })),
  );
  const adjudications = projection.adjudications
    .map((item) => ({
      key: item.conflict_key,
      status: item.status,
      selected: item.selected_branch_id,
      branch_hashes: [...item.branch_hashes].sort(compareText),
    }))
    .sort((left, right) => compareText(canonicalJson(left.key), canonicalJson(right.key)));
  return canonicalJson({ entries, adjudications });
}

function expectedCommittedFingerprint(
  committed: readonly { readonly hash: string; readonly commitIndex: number; readonly status: string }[],
): string {
  return canonicalJson({
    entries: sortFingerprintEntries(committed.map((item) => ({ h: item.hash, s: item.status, c: item.commitIndex }))),
    adjudications: [],
  });
}

function listsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function resourceIsZero(stats: HaResourceStats): boolean {
  return stats.nodes_open === 0
    && stats.ha_servers_open === 0
    && stats.replica_servers_open === 0
    && stats.proxies_open === 0
    && stats.clients_open === 0
    && stats.active_connections === 0;
}

// ---------------------------------------------------------------------------
// Scenario A: leader failover under stable submit load
// ---------------------------------------------------------------------------

export interface LeaderFailoverScenario {
  readonly leaderBefore: string;
  readonly leaderAfter: string;
  readonly epochBefore: number;
  readonly termBefore: number;
  readonly epochAfter: number;
  readonly termAfter: number;
  /** Wall-clock spent applying the socket-level isolation (excluded from RTO). */
  readonly isolateMs: number;
  /** Fault injection -> first refused proposal returned. */
  readonly timeToFirstFailureMs: number;
  /** Wall-clock of the benchmark-driven re-election call. */
  readonly electionMs: number;
  /** RTO: fault injection complete -> first successful commit returned. */
  readonly rtoMs: number;
  /** Proposals attempted between fault injection and that first success. */
  readonly switchAttempts: number;
  readonly switchRejected: number;
  readonly switchRejectionRate: number;
  readonly recovered: boolean;
  readonly normal: HaPhaseMetrics;
  readonly switchWindow: HaPhaseMetrics;
  readonly postFailover: HaPhaseMetrics;
  readonly rpoUnacknowledgedLost: number;
  readonly oldLeaderRejoinMs: number;
  readonly oldLeaderAdoptedTerm: number;
  readonly oldLeaderLogEqual: boolean;
  readonly faultModel: string;
}

async function runLeaderFailover(profile: ScaleProfile, seed: number): Promise<LeaderFailoverScenario> {
  const cluster = await startBenchCluster();
  try {
    const election = await electLeader(cluster, 'n1');
    let leaderId = 'n1';
    let lease = election.lease!;
    await refreshLeaderLease(cluster, 'n1');
    let seq = 0;

    // Stable submit load before the fault.
    const normal = new PhaseCollector('normal');
    const normalStart = performance.now();
    for (let index = 0; index < profile.normalCommits; index += 1) {
      seq += 1;
      normal.record(await attemptPropose(cluster, leaderId, lease, seq, seed));
    }
    const normalDuration = performance.now() - normalStart;

    // Real socket-level cut of every link touching the leader. The node object
    // stays alive (single process); its TCP links are genuinely torn down.
    const isolateStarted = performance.now();
    await cluster.isolate([['n1'], ['n2', 'n3']]);
    const isolateMs = performance.now() - isolateStarted;
    const faultAt = performance.now();

    const switchWindow = new PhaseCollector('switch-window');
    const postFailover = new PhaseCollector('post-failover');
    const rejectedHashes: string[] = [];
    let firstFailureMs: number | null = null;
    let electionMs = 0;
    let elected = false;
    let recoveryOffsetMs: number | null = null;
    let postPhaseStart = 0;
    let postSuccesses = 0;
    let iterations = 0;
    const maxIterations = profile.postFailoverCommits * 8 + 16;
    while (postSuccesses < profile.postFailoverCommits && iterations < maxIterations) {
      iterations += 1;
      seq += 1;
      const outcome = await attemptPropose(cluster, leaderId, lease, seq, seed);
      if (outcome.ok) {
        if (recoveryOffsetMs === null) {
          recoveryOffsetMs = performance.now() - faultAt;
          postPhaseStart = performance.now();
          switchWindow.record(outcome);
        } else {
          postFailover.record(outcome);
        }
        postSuccesses += 1;
      } else {
        switchWindow.record(outcome);
        rejectedHashes.push(outcome.hash);
        if (firstFailureMs === null) firstFailureMs = performance.now() - faultAt;
        if (!elected) {
          const electionStarted = performance.now();
          const renewed = await electLeader(cluster, 'n2');
          electionMs = performance.now() - electionStarted;
          elected = true;
          leaderId = 'n2';
          lease = renewed.lease!;
        }
      }
      // Yield once so the event loop can service real TCP callbacks; this is a
      // load generator, not a tight CPU spin.
      await delay(0);
    }

    const rtoMs = recoveryOffsetMs;
    if (rtoMs === null || firstFailureMs === null) {
      throw new Error('T-141 leader-failover scenario never recovered a commit after the leader fault');
    }
    const postDuration = performance.now() - postPhaseStart;

    // Restore connectivity and prove the isolated old leader rejoins without
    // overwriting the new leader's committed records.
    await cluster.restore();
    const rejoinStarted = performance.now();
    const rejoin: HaRejoinResult = await cluster.rejoin('n1');
    const oldLeaderRejoinMs = performance.now() - rejoinStarted;
    const oldLeaderLogEqual = listsEqual(logHashes(cluster, 'n1'), logHashes(cluster, 'n2'));

    const committed = committedHashes(cluster);
    const rpoUnacknowledgedLost = unacknowledgedLostCount(rejectedHashes, committed);

    return {
      leaderBefore: 'n1',
      leaderAfter: leaderId,
      epochBefore: election.epoch,
      termBefore: election.term,
      epochAfter: lease.epoch,
      termAfter: lease.term,
      isolateMs: round(isolateMs),
      timeToFirstFailureMs: round(firstFailureMs),
      electionMs: round(electionMs),
      rtoMs: round(rtoMs),
      switchAttempts: switchWindow.attempts,
      switchRejected: switchWindow.rejected,
      switchRejectionRate: switchWindow.errorRate,
      recovered: true,
      normal: normal.metrics(normalDuration),
      switchWindow: switchWindow.metrics(rtoMs),
      postFailover: postFailover.metrics(postDuration),
      rpoUnacknowledgedLost,
      oldLeaderRejoinMs: round(oldLeaderRejoinMs),
      oldLeaderAdoptedTerm: rejoin.adopted_term,
      oldLeaderLogEqual,
      faultModel: 'leader 全部进出链路经 TcpFaultProxy drop=1 真实断链（单进程内节点对象存活，非 OS SIGKILL）',
    };
  } finally {
    await cluster.close();
  }
}

// ---------------------------------------------------------------------------
// Scenario B: follower crash with the majority still intact
// ---------------------------------------------------------------------------

export interface FollowerCrashScenario {
  readonly victim: string;
  readonly leader: string;
  readonly isolateMs: number;
  readonly quorumReachableDuringFault: boolean;
  readonly availabilityInterrupted: boolean;
  readonly commitsDuringFault: number;
  readonly replicationFailuresDuringFault: number;
  readonly normal: HaPhaseMetrics;
  readonly faultWindow: HaPhaseMetrics;
  readonly throughputRatioFaultToNormal: number;
  readonly restoreAndRejoinMs: number;
  readonly logEqualAfterRejoin: boolean;
  readonly rpoUnacknowledgedLost: number;
  readonly resourceAfterClose: HaResourceStats;
  readonly resourceCleanAfterClose: boolean;
  readonly faultModel: string;
}

async function runFollowerCrash(profile: ScaleProfile, seed: number): Promise<FollowerCrashScenario> {
  const cluster = await startBenchCluster();
  let assembled: FollowerCrashScenario | null = null;
  try {
    const election = await electLeader(cluster, 'n1');
    const lease = election.lease!;
    await refreshLeaderLease(cluster, 'n1');
    let seq = 0;

    const normal = new PhaseCollector('normal');
    const normalStart = performance.now();
    for (let index = 0; index < profile.normalCommits; index += 1) {
      seq += 1;
      normal.record(await attemptPropose(cluster, 'n1', lease, seq, seed));
    }
    const normalDuration = performance.now() - normalStart;

    const victim = 'n3';
    const isolateStarted = performance.now();
    await cluster.isolate([['n1', 'n2'], [victim]]);
    const isolateMs = performance.now() - isolateStarted;
    const quorumReachableDuringFault = cluster.evaluateCurrentPartitions().any_commit;

    const faultWindow = new PhaseCollector('follower-fault');
    const faultStart = performance.now();
    let replicationFailuresDuringFault = 0;
    const rejectedHashes: string[] = [];
    for (let index = 0; index < profile.followerFaultCommits; index += 1) {
      seq += 1;
      const outcome = await attemptPropose(cluster, 'n1', lease, seq, seed);
      faultWindow.record(outcome);
      replicationFailuresDuringFault += outcome.replicationFailures;
      if (!outcome.ok) rejectedHashes.push(outcome.hash);
    }
    const faultDuration = performance.now() - faultStart;

    const availabilityInterrupted = faultWindow.rejected > 0 || faultWindow.committed === 0;

    const restoreStarted = performance.now();
    await cluster.restore();
    await refreshLeaderLease(cluster, 'n1');
    await cluster.rejoin(victim);
    const restoreAndRejoinMs = performance.now() - restoreStarted;
    const logEqualAfterRejoin = listsEqual(logHashes(cluster, 'n1'), logHashes(cluster, victim));

    const rpoUnacknowledgedLost = unacknowledgedLostCount(rejectedHashes, committedHashes(cluster));
    const normalMetrics = normal.metrics(normalDuration);
    const faultMetrics = faultWindow.metrics(faultDuration);

    assembled = {
      victim,
      leader: 'n1',
      isolateMs: round(isolateMs),
      quorumReachableDuringFault,
      availabilityInterrupted,
      commitsDuringFault: faultWindow.committed,
      replicationFailuresDuringFault,
      normal: normalMetrics,
      faultWindow: faultMetrics,
      throughputRatioFaultToNormal: normalMetrics.throughputPerSec > 0
        ? round(faultMetrics.throughputPerSec / normalMetrics.throughputPerSec, 4)
        : 0,
      restoreAndRejoinMs: round(restoreAndRejoinMs),
      logEqualAfterRejoin,
      rpoUnacknowledgedLost,
      resourceAfterClose: zeroResourceStats(),
      resourceCleanAfterClose: false,
      faultModel: 'follower 全部进出链路真实断链；多数派 n1+n2 仍可达，提交应无中断',
    };
  } finally {
    await cluster.close();
  }
  const closedStats = cluster.resourceStats();
  if (assembled === null) throw new Error('T-141 follower-crash scenario produced no result');
  return {
    ...assembled,
    resourceAfterClose: closedStats,
    resourceCleanAfterClose: resourceIsZero(closedStats),
  };
}

// ---------------------------------------------------------------------------
// Scenario C: rejoin catch-up, lag and RPO proxy
// ---------------------------------------------------------------------------

export interface RejoinCatchUpScenario {
  readonly memberId: string;
  readonly isolateMs: number;
  readonly restoreMs: number;
  /** Rejoin/catch-up call wall-clock (fetch committed records over real TCP). */
  readonly catchUpMs: number;
  readonly lagCommitIndexBeforeRejoin: number;
  readonly recordsSeen: number;
  readonly recordsApplied: number;
  readonly ingested: number;
  readonly duplicates: number;
  readonly conflicts: number;
  /** Lease-adoption flag from the manager (false when the leader epoch is unchanged). */
  readonly managerRejoined: boolean;
  readonly managerCaughtUp: boolean;
  readonly logEqualAfterRejoin: boolean;
  readonly projectionFingerprint: string;
  readonly expectedFingerprint: string;
  readonly projectionEqual: boolean;
  /** RPO proxy: refused during fault and still absent from every log at the end. */
  readonly rpoUnacknowledgedLost: number;
  /** Committed entries that stayed missing on the recovered node. */
  readonly committedMissingAfterRecovery: number;
  readonly committedBeforeFault: number;
  readonly committedAfterRecovery: number;
  readonly faultWindow: HaPhaseMetrics;
  readonly faultModel: string;
}

async function runRejoinCatchUp(profile: ScaleProfile, seed: number): Promise<RejoinCatchUpScenario> {
  const cluster = await startBenchCluster();
  try {
    const election = await electLeader(cluster, 'n1');
    const lease = election.lease!;
    await refreshLeaderLease(cluster, 'n1');
    let seq = 0;
    const committedRecords: { hash: string; commitIndex: number; status: string }[] = [];

    for (let index = 0; index < profile.rejoinBaseCommits; index += 1) {
      seq += 1;
      const outcome = await attemptPropose(cluster, 'n1', lease, seq, seed);
      if (!outcome.ok) throw new Error(`T-141 rejoin base commit ${String(seq)} refused: ${outcome.code}`);
      committedRecords.push({ hash: outcome.hash, commitIndex: outcome.commitIndex, status: 'committed' });
    }
    const committedBeforeFault = committedRecords.length;

    const memberId = 'n2';
    const isolateStarted = performance.now();
    await cluster.isolate([[memberId], ['n1', 'n3']]);
    const isolateMs = performance.now() - isolateStarted;

    const faultWindow = new PhaseCollector('rejoin-fault');
    const faultStart = performance.now();
    const rejectedHashes: string[] = [];
    for (let index = 0; index < profile.rejoinFaultCommits; index += 1) {
      seq += 1;
      const outcome = await attemptPropose(cluster, 'n1', lease, seq, seed);
      faultWindow.record(outcome);
      if (outcome.ok) committedRecords.push({ hash: outcome.hash, commitIndex: outcome.commitIndex, status: 'committed' });
      else rejectedHashes.push(outcome.hash);
    }
    const faultDuration = performance.now() - faultStart;

    const lagCommitIndexBeforeRejoin = cluster.node('n1').log.maxCommitIndex - cluster.node(memberId).log.maxCommitIndex;

    const restoreStarted = performance.now();
    await cluster.restore();
    const restoreMs = performance.now() - restoreStarted;
    await refreshLeaderLease(cluster, 'n1');
    const catchUpStarted = performance.now();
    const rejoin = await cluster.rejoin(memberId);
    const catchUpMs = performance.now() - catchUpStarted;

    const logEqualAfterRejoin = listsEqual(logHashes(cluster, 'n1'), logHashes(cluster, memberId));
    const actualFingerprint = projectionFingerprint(cluster.projection());
    const expectedFingerprint = expectedCommittedFingerprint(committedRecords);
    const projectionEqual = actualFingerprint === expectedFingerprint;

    const allCommitted = committedHashes(cluster);
    const rpoUnacknowledgedLost = unacknowledgedLostCount(rejectedHashes, allCommitted);
    const recoveredHashes = new Set(logHashes(cluster, memberId));
    let committedMissingAfterRecovery = 0;
    for (const record of committedRecords) {
      if (!recoveredHashes.has(record.hash)) committedMissingAfterRecovery += 1;
    }

    return {
      memberId,
      isolateMs: round(isolateMs),
      restoreMs: round(restoreMs),
      catchUpMs: round(catchUpMs),
      lagCommitIndexBeforeRejoin,
      recordsSeen: rejoin.records_seen,
      recordsApplied: rejoin.records_applied,
      ingested: rejoin.ingested,
      duplicates: rejoin.duplicates,
      conflicts: rejoin.conflicts,
      managerRejoined: rejoin.rejoined,
      managerCaughtUp: rejoin.caught_up,
      logEqualAfterRejoin,
      projectionFingerprint: actualFingerprint,
      expectedFingerprint,
      projectionEqual,
      rpoUnacknowledgedLost,
      committedMissingAfterRecovery,
      committedBeforeFault,
      committedAfterRecovery: committedRecords.length,
      faultWindow: faultWindow.metrics(faultDuration),
      faultModel: 'follower n2 断链后恢复；多数派提交不依赖该副本，RPO 预期为 0',
    };
  } finally {
    await cluster.close();
  }
}

// ---------------------------------------------------------------------------
// Scenario D: repeated kill/restore cycles, integrity and resource leak
// ---------------------------------------------------------------------------

export interface RepeatedRecoveryCycle {
  readonly cycle: number;
  readonly isolateMs: number;
  readonly restoreMs: number;
  readonly rejoinMs: number;
  readonly lagBeforeRejoin: number;
  readonly logEqualAfterRejoin: boolean;
  readonly committedTotal: number;
}

export interface RepeatedRecoveryScenario {
  readonly cycles: number;
  readonly committedTotal: number;
  readonly perCycle: readonly RepeatedRecoveryCycle[];
  readonly baselineFingerprint: string;
  readonly finalFingerprint: string;
  readonly integrityEqual: boolean;
  readonly resourceBeforeClose: HaResourceStats;
  readonly resourceAfterClose: HaResourceStats;
  readonly noLeak: boolean;
  readonly baselineClosedClean: boolean;
  readonly faultModel: string;
}

async function runRepeatedRecovery(profile: ScaleProfile, seed: number): Promise<RepeatedRecoveryScenario> {
  const total = profile.repeatedInitial + profile.repeatedCycles * profile.repeatedPerCycle;

  // No-fault baseline: the exact same deterministic sequence committed on a
  // healthy cluster. The stress arm must reproduce this projection byte-for-byte.
  const baseline = await startBenchCluster();
  let baselineFingerprint = '';
  let baselineClosedClean = false;
  try {
    const election = await electLeader(baseline, 'n1');
    const lease = election.lease!;
    await refreshLeaderLease(baseline, 'n1');
    for (let seq = 1; seq <= total; seq += 1) {
      const outcome = await attemptPropose(baseline, 'n1', lease, seq, seed);
      if (!outcome.ok) throw new Error(`T-141 baseline commit ${String(seq)} refused: ${outcome.code}`);
    }
    baselineFingerprint = projectionFingerprint(baseline.projection());
  } finally {
    await baseline.close();
    baselineClosedClean = resourceIsZero(baseline.resourceStats());
  }

  const stress = await startBenchCluster();
  let assembled: Omit<RepeatedRecoveryScenario, 'resourceAfterClose' | 'noLeak'> | null = null;
  let resourceBeforeClose: HaResourceStats = zeroResourceStats();
  try {
    const election = await electLeader(stress, 'n1');
    const lease = election.lease!;
    await refreshLeaderLease(stress, 'n1');
    let seq = 0;
    for (let index = 0; index < profile.repeatedInitial; index += 1) {
      seq += 1;
      const outcome = await attemptPropose(stress, 'n1', lease, seq, seed);
      if (!outcome.ok) throw new Error(`T-141 stress warmup commit ${String(seq)} refused: ${outcome.code}`);
    }

    const perCycle: RepeatedRecoveryCycle[] = [];
    for (let cycle = 1; cycle <= profile.repeatedCycles; cycle += 1) {
      const isolateStarted = performance.now();
      await stress.isolate([['n2'], ['n1', 'n3']]);
      const isolateMs = performance.now() - isolateStarted;

      for (let inner = 0; inner < profile.repeatedPerCycle; inner += 1) {
        seq += 1;
        const outcome = await attemptPropose(stress, 'n1', lease, seq, seed);
        if (!outcome.ok) throw new Error(`T-141 stress cycle ${String(cycle)} commit ${String(seq)} refused: ${outcome.code}`);
      }

      const lagBeforeRejoin = stress.node('n1').log.maxCommitIndex - stress.node('n2').log.maxCommitIndex;

      const restoreStarted = performance.now();
      await stress.restore();
      const restoreMs = performance.now() - restoreStarted;
      await refreshLeaderLease(stress, 'n1');

      const rejoinStarted = performance.now();
      await stress.rejoin('n2');
      const rejoinMs = performance.now() - rejoinStarted;

      const logEqualAfterRejoin = listsEqual(logHashes(stress, 'n1'), logHashes(stress, 'n2'))
        && listsEqual(logHashes(stress, 'n1'), logHashes(stress, 'n3'));
      perCycle.push({
        cycle,
        isolateMs: round(isolateMs),
        restoreMs: round(restoreMs),
        rejoinMs: round(rejoinMs),
        lagBeforeRejoin,
        logEqualAfterRejoin,
        committedTotal: seq,
      });
    }

    const finalFingerprint = projectionFingerprint(stress.projection());
    resourceBeforeClose = stress.resourceStats();
    assembled = {
      cycles: profile.repeatedCycles,
      committedTotal: seq,
      perCycle,
      baselineFingerprint,
      finalFingerprint,
      integrityEqual: finalFingerprint === baselineFingerprint,
      resourceBeforeClose,
      baselineClosedClean,
      faultModel: '同一下属节点反复「断链→恢复→追平」；提交由多数派 n1+n3 完成',
    };
  } finally {
    await stress.close();
  }
  if (assembled === null) throw new Error('T-141 repeated-recovery scenario produced no result');
  const closedStats = stress.resourceStats();
  return {
    ...assembled,
    resourceAfterClose: closedStats,
    noLeak: resourceIsZero(closedStats),
  };
}

// ---------------------------------------------------------------------------
// Scenario E: P95/P99 and throughput, normal vs fault-injection window
// ---------------------------------------------------------------------------

export interface LoadLatencyScenario {
  readonly normal: HaPhaseMetrics;
  readonly faultWindow: HaPhaseMetrics;
  readonly p95DeltaMs: number;
  readonly p99DeltaMs: number;
  readonly meanDeltaMs: number;
  readonly throughputRatioFaultToNormal: number;
  readonly faultModel: string;
}

async function runLoadLatency(profile: ScaleProfile, seed: number): Promise<LoadLatencyScenario> {
  const cluster = await startBenchCluster();
  try {
    const election = await electLeader(cluster, 'n1');
    const lease = election.lease!;

    const normal = new PhaseCollector('load-normal');
    const normalStart = performance.now();
    let seq = 0;
    for (let index = 0; index < profile.loadNormalCommits; index += 1) {
      seq += 1;
      normal.record(await attemptPropose(cluster, 'n1', lease, seq, seed));
    }
    const normalDuration = performance.now() - normalStart;

    await cluster.isolate([['n1', 'n2'], ['n3']]);

    const faultWindow = new PhaseCollector('load-fault');
    const faultStart = performance.now();
    for (let index = 0; index < profile.loadFaultCommits; index += 1) {
      seq += 1;
      faultWindow.record(await attemptPropose(cluster, 'n1', lease, seq, seed));
    }
    const faultDuration = performance.now() - faultStart;

    await cluster.restore();

    const normalMetrics = normal.metrics(normalDuration);
    const faultMetrics = faultWindow.metrics(faultDuration);
    return {
      normal: normalMetrics,
      faultWindow: faultMetrics,
      p95DeltaMs: round(faultMetrics.commitLatency.p95Ms - normalMetrics.commitLatency.p95Ms),
      p99DeltaMs: round(faultMetrics.commitLatency.p99Ms - normalMetrics.commitLatency.p99Ms),
      meanDeltaMs: round(faultMetrics.commitLatency.meanMs - normalMetrics.commitLatency.meanMs),
      throughputRatioFaultToNormal: normalMetrics.throughputPerSec > 0
        ? round(faultMetrics.throughputPerSec / normalMetrics.throughputPerSec, 4)
        : 0,
      faultModel: '注入期内隔离 follower n3；提交路径会等待失效副本的复制请求至超时，故延迟含一次请求超时',
    };
  } finally {
    await cluster.close();
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface HaRecoveryBenchmarkResult {
  readonly schema: 'ha-recovery.benchmark.v1';
  readonly generatedAt: string;
  readonly command: string;
  readonly scale: HaRecoveryScale;
  readonly seed: number;
  readonly environment: Record<string, unknown>;
  readonly definitions: {
    readonly rto: string;
    readonly rpo: string;
    readonly availability: string;
    readonly recoveryTime: string;
    readonly scope: string;
  };
  readonly verificationScope: typeof HA_CLUSTER_VERIFICATION_SCOPE;
  readonly verificationNote: string;
  readonly scenarios: {
    readonly leaderFailover: LeaderFailoverScenario;
    readonly followerCrash: FollowerCrashScenario;
    readonly rejoinCatchUp: RejoinCatchUpScenario;
    readonly repeatedRecovery: RepeatedRecoveryScenario;
    readonly loadLatency: LoadLatencyScenario;
  };
  readonly checks: readonly { readonly name: string; readonly passed: boolean; readonly detail: string }[];
  readonly passed: boolean;
  readonly limitations: readonly string[];
}

export async function runHaRecoveryBenchmark(options: HaRecoveryBenchmarkOptions): Promise<HaRecoveryBenchmarkResult> {
  const profile = SCALE_PROFILE[options.scale];
  if (profile === undefined) throw new Error(`unknown HA recovery scale ${String(options.scale)}`);

  const leaderFailover = await runLeaderFailover(profile, options.seed);
  const followerCrash = await runFollowerCrash(profile, options.seed);
  const rejoinCatchUp = await runRejoinCatchUp(profile, options.seed);
  const repeatedRecovery = await runRepeatedRecovery(profile, options.seed);
  const loadLatency = await runLoadLatency(profile, options.seed);

  const checks = [
    {
      name: 'leader-failover-recovers-with-measurable-rto',
      passed: leaderFailover.recovered && Number.isFinite(leaderFailover.rtoMs) && leaderFailover.rtoMs > 0,
      detail: `RTO=${String(leaderFailover.rtoMs)}ms；切换期拒绝率=${String(leaderFailover.switchRejectionRate)}`,
    },
    {
      name: 'follower-crash-majority-keeps-committing',
      passed: !followerCrash.availabilityInterrupted
        && followerCrash.faultWindow.rejected === 0
        && followerCrash.commitsDuringFault > 0,
      detail: `故障窗提交=${String(followerCrash.commitsDuringFault)} 拒绝=${String(followerCrash.faultWindow.rejected)}`,
    },
    {
      name: 'rejoin-catch-up-rpo-zero-and-projection-equal',
      passed: rejoinCatchUp.rpoUnacknowledgedLost === 0
        && rejoinCatchUp.projectionEqual
        && rejoinCatchUp.logEqualAfterRejoin
        && rejoinCatchUp.committedMissingAfterRecovery === 0,
      detail: `落后 commitIndex=${String(rejoinCatchUp.lagCommitIndexBeforeRejoin)} RPO=${String(rejoinCatchUp.rpoUnacknowledgedLost)} 投影一致=${String(rejoinCatchUp.projectionEqual)}`,
    },
    {
      name: 'repeated-recovery-integrity-equals-baseline',
      passed: repeatedRecovery.integrityEqual,
      detail: `cycles=${String(repeatedRecovery.cycles)} 最终提交=${String(repeatedRecovery.committedTotal)}`,
    },
    {
      name: 'no-resource-leak-after-close',
      passed: repeatedRecovery.noLeak
        && repeatedRecovery.baselineClosedClean
        && followerCrash.resourceCleanAfterClose,
      detail: `循环集群 close 后 open=${resourceOpenSum(repeatedRecovery.resourceAfterClose)}（各场景集群均已 close）`,
    },
    {
      name: 'all-metrics-finite',
      passed: [
        leaderFailover.rtoMs,
        leaderFailover.switchRejectionRate,
        followerCrash.faultWindow.commitLatency.p95Ms,
        followerCrash.faultWindow.commitLatency.p99Ms,
        rejoinCatchUp.catchUpMs,
        rejoinCatchUp.lagCommitIndexBeforeRejoin,
        loadLatency.faultWindow.commitLatency.p95Ms,
        loadLatency.faultWindow.commitLatency.p99Ms,
        loadLatency.normal.throughputPerSec,
      ].every((value) => Number.isFinite(value)),
      detail: 'RTO/RPO/恢复耗时/吞吐/P95/P99 均为有限数字',
    },
  ];

  return {
    schema: 'ha-recovery.benchmark.v1',
    generatedAt: new Date().toISOString(),
    command: 'node scripts/benchmark-ha-recovery.ts',
    scale: options.scale,
    seed: options.seed,
    environment: environmentRecord(),
    definitions: {
      rto: 'RTO = 故障注入生效（isolate 完成、链路真实切断）到故障后首次成功提交返回的墙钟时间差；包含基准驱动的重新选举与切换期的失败尝试。本集群无自动故障转移守护进程，故该值不代表自治故障切换 SLA。',
      rpo: 'RPO = 故障窗口内被拒绝、且到基准结束时仍未被任何节点日志提交的提案数（未获确认写入的丢失代理）；另报 committedMissingAfterRecovery（已提交条目在恢复节点上仍缺失数）。多数派提交不依赖单一副本，follower 故障/rejoin 场景预期为 0。',
      availability: '可用性中断 = 故障窗内出现提交拒绝或零提交；错误率 = 拒绝提案数 / 提案尝试数。拒绝是显式失败（QUORUM_NOT_REACHED/FENCE_*），不是静默丢失。',
      recoveryTime: '恢复耗时 = 对应恢复动作的墙钟时间：追平耗时=rejoin() 调用时长（从对等节点拉取已提交记录）；隔离耗时=isolate() 重建全部有向链路时长（不计入 RTO）。',
      scope: HA_CLUSTER_VERIFICATION_NOTE,
    },
    verificationScope: HA_CLUSTER_VERIFICATION_SCOPE,
    verificationNote: HA_CLUSTER_VERIFICATION_NOTE,
    scenarios: {
      leaderFailover,
      followerCrash,
      rejoinCatchUp,
      repeatedRecovery,
      loadLatency,
    },
    checks,
    passed: checks.every((check) => check.passed),
    limitations: [
      '本地 loopback TCP 实测：三节点均为同一测试进程内的真实 node:net 端点与 TcpReplicaServer，帧经真实 TCP 往返；不可外推物理三机部署、跨机带宽/丢包或生产 HA。',
      '节点故障以链路级 drop 注入模拟（TcpFaultProxy 协议层故障注入 ≠ OS 真分区）；未做 OS 进程 SIGKILL、内核协议栈故障、防火墙规则或物理链路中断。',
      '跨机时钟回拨、时钟偏移补偿与物理机房间的网络分区均未验证；本基准使用注入时钟且不参与版本排序。',
      '不承诺生产 SLA：RTO/RPO 只描述本次本机运行，真实生产延迟、真实故障检测时间与真实写入分布为 [数据缺失]。',
      '切换期提交路径会等待失效副本的请求直到 requestTimeoutMs（本基准 500ms），因此故障窗延迟/吞吐包含该超时，不是异步复制的生产表现。',
      '无自动故障转移守护进程：RTO 含基准驱动的 elect() 调用；真实编排系统的检测与触发时延未测量。',
      'P95/P99 样本量受 smoke/S 规模限制，尾延迟统计仅作数量级参考。',
    ],
  };
}

function resourceOpenSum(stats: HaResourceStats): number {
  return stats.nodes_open
    + stats.ha_servers_open
    + stats.replica_servers_open
    + stats.proxies_open
    + stats.clients_open
    + stats.active_connections;
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

function latencyLine(stats: HaLatencyStats): string {
  return `p50 ${String(stats.p50Ms)} / p95 ${String(stats.p95Ms)} / p99 ${String(stats.p99Ms)} / max ${String(stats.maxMs)} / mean ${String(stats.meanMs)} ms（n=${String(stats.count)}）`;
}

function phaseRow(label: string, phase: HaPhaseMetrics): string {
  return `| ${label} | ${phase.attempts} | ${phase.committed} | ${phase.rejected} | ${phase.errorRate} | ${phase.durationMs} | ${phase.throughputPerSec} | ${latencyLine(phase.latency)} | ${latencyLine(phase.commitLatency)} |`;
}

function shortHash(text: string): string {
  const digest = createHash('sha256').update(text).digest('hex');
  return `${digest.slice(0, 16)}…${digest.slice(-8)}`;
}

function renderMarkdown(result: HaRecoveryBenchmarkResult): string {
  const lines: string[] = [];
  const { leaderFailover: lf, followerCrash: fc, rejoinCatchUp: rc, repeatedRecovery: rr, loadLatency: ll } = result.scenarios;
  const env = result.environment;
  lines.push('# 本地高可用 / RTO/RPO 与恢复压力基准（T-141 / HA-09）');
  lines.push('');
  lines.push(`- 生成时间：${result.generatedAt}`);
  lines.push(`- 命令：\`${result.command} --scale ${result.scale} --seed ${String(result.seed)}\``);
  lines.push(`- 环境：node ${String(env.node)} / ${String(env.platform)} ${String(env.arch)} ${String(env.release)} / ${String(env.cpuModel)} x${String(env.cpuCount)}`);
  lines.push(`- 验证范围：\`${result.verificationScope}\`（本地 TCP + 协议层故障注入；≠ OS 真分区）`);
  lines.push('- 硬边界：本地 loopback TCP 实测，**非物理三机、非生产 HA、非生产 SLA**。');
  lines.push('');
  lines.push('## 1. 方法学');
  lines.push('');
  lines.push('- 复用面：`HaCluster`（T-139）真实 3 节点 loopback TCP 集群；每个节点含真实 `HaTcpServer`、冻结 `TcpReplicaServer` 与真实 `HaTcpClient`，选举/提案/同步帧走 `TcpFaultProxy`。不新造传输、不改契约。');
  lines.push('- 故障模型：`isolate(groups)` 重建每条有向链路并对被隔离方向注入 `drop probability=1`，是真实套接字级断链；单进程内节点对象存活，因此这不是 OS 进程 SIGKILL（见限制）。');
  lines.push('- 稳定提交负载：提案循环持续运行，跨越故障注入边界；每次尝试记录墙钟延迟、成功/拒绝与错误码。');
  lines.push('- 确定性：事件字节由 `(seed, seq)` 决定；同一种子重放得到同一提交集合。时序数字本身随机器负载波动。');
  lines.push('- 规模预算（smoke / S）：正常提交 / 切换后提交 / follower 故障窗 / rejoin 故障窗 / 反复恢复周期×每周期 / 负载正常+故障 = '
    + `${String(SCALE_PROFILE.smoke.normalCommits)}/${String(SCALE_PROFILE.smoke.postFailoverCommits)}/${String(SCALE_PROFILE.smoke.followerFaultCommits)}/${String(SCALE_PROFILE.smoke.rejoinFaultCommits)}/`
    + `${String(SCALE_PROFILE.smoke.repeatedCycles)}x${String(SCALE_PROFILE.smoke.repeatedPerCycle)}+${String(SCALE_PROFILE.smoke.repeatedInitial)}/${String(SCALE_PROFILE.smoke.loadNormalCommits)}+${String(SCALE_PROFILE.smoke.loadFaultCommits)}`
    + ` 与 ${String(SCALE_PROFILE.S.normalCommits)}/${String(SCALE_PROFILE.S.postFailoverCommits)}/${String(SCALE_PROFILE.S.followerFaultCommits)}/${String(SCALE_PROFILE.S.rejoinFaultCommits)}/`
    + `${String(SCALE_PROFILE.S.repeatedCycles)}x${String(SCALE_PROFILE.S.repeatedPerCycle)}+${String(SCALE_PROFILE.S.repeatedInitial)}/${String(SCALE_PROFILE.S.loadNormalCommits)}+${String(SCALE_PROFILE.S.loadFaultCommits)}。`);
  lines.push('- 指标口径（写死在 JSON `definitions` 中）：');
  lines.push(`  - RTO：${result.definitions.rto}`);
  lines.push(`  - RPO：${result.definitions.rpo}`);
  lines.push(`  - 可用性/错误率：${result.definitions.availability}`);
  lines.push(`  - 恢复耗时：${result.definitions.recoveryTime}`);
  lines.push('');
  lines.push('## 2. 本机实测总表');
  lines.push('');
  lines.push('| 场景 | 核心结果 |');
  lines.push('|---|---|');
  lines.push(`| a. leader failover | RTO=${String(lf.rtoMs)} ms；切换期尝试 ${String(lf.switchAttempts)} / 拒绝 ${String(lf.switchRejected)} / 拒绝率 ${String(lf.switchRejectionRate)}；新主 ${lf.leaderAfter}（term ${String(lf.termBefore)}→${String(lf.termAfter)}）；旧主追平 ${String(lf.oldLeaderRejoinMs)} ms，日志一致=${String(lf.oldLeaderLogEqual)}；RPO(未确认丢失)=${String(lf.rpoUnacknowledgedLost)} |`);
  lines.push(`| b. follower crash | 可用性中断=${String(fc.availabilityInterrupted)}；故障窗提交 ${String(fc.commitsDuringFault)} / 拒绝 ${String(fc.faultWindow.rejected)}；吞吐比(故障/正常)=${String(fc.throughputRatioFaultToNormal)}；复制失败累计=${String(fc.replicationFailuresDuringFault)}；恢复+追平 ${String(fc.restoreAndRejoinMs)} ms |`);
  lines.push(`| c. rejoin catch-up | 落后 commitIndex=${String(rc.lagCommitIndexBeforeRejoin)}；追平耗时=${String(rc.catchUpMs)} ms；ingested/duplicates/conflicts=${String(rc.ingested)}/${String(rc.duplicates)}/${String(rc.conflicts)}；RPO=${String(rc.rpoUnacknowledgedLost)}；投影一致=${String(rc.projectionEqual)} |`);
  lines.push(`| d. 反复恢复 | 周期=${String(rr.cycles)}；最终提交=${String(rr.committedTotal)}；完整性(对无故障基线)=${String(rr.integrityEqual)}；close 后资源 open=${String(resourceOpenSum(rr.resourceAfterClose))} |`);
  lines.push(`| e. 负载 P95/P99 | 正常 p95/p99=${String(ll.normal.commitLatency.p95Ms)}/${String(ll.normal.commitLatency.p99Ms)} ms，吞吐 ${String(ll.normal.throughputPerSec)}/s；故障窗 p95/p99=${String(ll.faultWindow.commitLatency.p95Ms)}/${String(ll.faultWindow.commitLatency.p99Ms)} ms，吞吐 ${String(ll.faultWindow.throughputPerSec)}/s |`);
  lines.push('');
  lines.push('## 3. 分项明细');
  lines.push('');
  lines.push('### 3.1 leader failover（稳定负载下断链 leader）');
  lines.push('');
  lines.push(`- 故障模型：${lf.faultModel}`);
  lines.push(`- 隔离操作耗时 ${String(lf.isolateMs)} ms（不计入 RTO）；首次拒绝出现在故障后 ${String(lf.timeToFirstFailureMs)} ms；重新选举耗时 ${String(lf.electionMs)} ms。`);
  lines.push(`- RTO=${String(lf.rtoMs)} ms（故障生效→首次成功提交）。`);
  lines.push(`- 阶段指标（attempts/committed/rejected/errorRate/durationMs/throughputPerSec/latency/commitLatency）：`);
  lines.push('');
  lines.push('| 阶段 | 尝试 | 提交 | 拒绝 | 错误率 | 时长 ms | 吞吐 /s | 全部延迟 | 提交延迟 |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  lines.push(phaseRow('正常', lf.normal));
  lines.push(phaseRow('切换窗', lf.switchWindow));
  lines.push(phaseRow('切换后', lf.postFailover));
  lines.push('');
  lines.push(`- 切换期拒绝错误码：${canonicalJson(lf.switchWindow.rejectionCodes)}。切换窗内那次被拒绝的提案不会被自动重试；它计入 RPO（未确认丢失）=${String(lf.rpoUnacknowledgedLost)}。`);
  lines.push(`- 切换后阶段仍指向被隔离的旧主 n1：提案与复制请求都要等它的链路超时（各 ${CLUSTER_OPTIONS.requestTimeoutMs}ms），故 p95≈1000ms 量级属本次实现代价，不是新主不可用。`);
  lines.push('');
  lines.push('### 3.2 follower crash（多数派仍在）');
  lines.push('');
  lines.push(`- 故障模型：${fc.faultModel}`);
  lines.push(`- 多数派可提交=${String(fc.quorumReachableDuringFault)}；可用性中断=${String(fc.availabilityInterrupted)}；故障窗错误率=${String(fc.faultWindow.errorRate)}（拒绝码 ${canonicalJson(fc.faultWindow.rejectionCodes)}）。`);
  lines.push('');
  lines.push('| 阶段 | 尝试 | 提交 | 拒绝 | 错误率 | 时长 ms | 吞吐 /s | 全部延迟 | 提交延迟 |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  lines.push(phaseRow('正常', fc.normal));
  lines.push(phaseRow('follower 故障', fc.faultWindow));
  lines.push('');
  lines.push(`- 恢复+追平耗时 ${String(fc.restoreAndRejoinMs)} ms；追平后各节点日志一致=${String(fc.logEqualAfterRejoin)}。`);
  lines.push('');
  lines.push('### 3.3 rejoin catch-up（恢复追平与 RPO 代理）');
  lines.push('');
  lines.push(`- 故障模型：${rc.faultModel}`);
  lines.push(`- 故障前已提交 ${String(rc.committedBeforeFault)}；故障窗提交 ${String(rc.faultWindow.committed)}；恢复后累计 ${String(rc.committedAfterRecovery)}。`);
  lines.push(`- 追平前落后 commitIndex=${String(rc.lagCommitIndexBeforeRejoin)}；restore ${String(rc.restoreMs)} ms；rejoin ${String(rc.catchUpMs)} ms；records seen/applied=${String(rc.recordsSeen)}/${String(rc.recordsApplied)}；ingested/duplicates/conflicts=${String(rc.ingested)}/${String(rc.duplicates)}/${String(rc.conflicts)}。`);
  lines.push(`- manager rejoined/caught_up=${String(rc.managerRejoined)}/${String(rc.managerCaughtUp)}（leader epoch 未变时租约不更新，追平以日志一致为准）；日志一致=${String(rc.logEqualAfterRejoin)}；投影指纹一致=${String(rc.projectionEqual)}（基线 ${shortHash(rc.expectedFingerprint)} / 实际 ${shortHash(rc.projectionFingerprint)}）。`);
  lines.push(`- RPO（未确认丢失）=${String(rc.rpoUnacknowledgedLost)}；已提交但恢复节点缺失=${String(rc.committedMissingAfterRecovery)}。`);
  lines.push('');
  lines.push('### 3.4 反复 kill/restore（完整性与资源）');
  lines.push('');
  lines.push(`- 故障模型：${rr.faultModel}`);
  lines.push(`- 基线指纹 ${shortHash(rr.baselineFingerprint)} / 最终指纹 ${shortHash(rr.finalFingerprint)}；integrityEqual=${String(rr.integrityEqual)}。`);
  lines.push('');
  lines.push('| 周期 | 隔离 ms | 恢复 ms | 追平 ms | 追平前落后 | 日志一致 | 累计提交 |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const cycle of rr.perCycle) {
    lines.push(`| ${String(cycle.cycle)} | ${String(cycle.isolateMs)} | ${String(cycle.restoreMs)} | ${String(cycle.rejoinMs)} | ${String(cycle.lagBeforeRejoin)} | ${String(cycle.logEqualAfterRejoin)} | ${String(cycle.committedTotal)} |`);
  }
  lines.push('');
  lines.push(`- close 前资源：${canonicalJson(rr.resourceBeforeClose)}`);
  lines.push(`- close 后资源：${canonicalJson(rr.resourceAfterClose)}（noLeak=${String(rr.noLeak)}）；无故障基线 close 干净=${String(rr.baselineClosedClean)}。`);
  lines.push('');
  lines.push('### 3.5 负载下 P95/P99 与吞吐（正常 vs 故障注入）');
  lines.push('');
  lines.push(`- 故障模型：${ll.faultModel}`);
  lines.push('');
  lines.push('| 阶段 | 尝试 | 提交 | 拒绝 | 错误率 | 时长 ms | 吞吐 /s | 全部延迟 | 提交延迟 |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  lines.push(phaseRow('正常', ll.normal));
  lines.push(phaseRow('故障注入', ll.faultWindow));
  lines.push('');
  lines.push(`- Δp95=${String(ll.p95DeltaMs)} ms；Δp99=${String(ll.p99DeltaMs)} ms；Δmean=${String(ll.meanDeltaMs)} ms；吞吐比=${String(ll.throughputRatioFaultToNormal)}。`);
  lines.push('');
  lines.push('## 4. 完整性与资源泄漏断言');
  lines.push('');
  lines.push('| 断言 | 结果 | 明细 |');
  lines.push('|---|---|---|');
  for (const check of result.checks) {
    lines.push(`| ${check.name} | ${check.passed ? 'PASS' : 'FAIL'} | ${check.detail} |`);
  }
  lines.push('');
  lines.push('## 5. 实测结论（只陈述本次运行事实）');
  lines.push('');
  lines.push(`- leader 断链后可恢复提交，本次实测 RTO=${String(lf.rtoMs)} ms，切换期提交拒绝率=${String(lf.switchRejectionRate)}（${String(lf.switchRejected)}/${String(lf.switchAttempts)}）；旧主恢复后不覆盖新主日志（一致=${String(lf.oldLeaderLogEqual)}）。`);
  lines.push(`- follower 断链且多数派仍在时，故障窗提交 ${String(fc.commitsDuringFault)} 笔、拒绝 ${String(fc.faultWindow.rejected)} 笔，可用性中断=${String(fc.availabilityInterrupted)}；代价是每笔提交多等一次失效副本超时（提交延迟 p95 ${String(fc.normal.commitLatency.p95Ms)}→${String(fc.faultWindow.commitLatency.p95Ms)} ms，吞吐 ${String(fc.normal.throughputPerSec)}→${String(fc.faultWindow.throughputPerSec)}/s）。`);
  lines.push(`- 恢复追平耗时 ${String(rc.catchUpMs)} ms（落后 ${String(rc.lagCommitIndexBeforeRejoin)} 个提交），RPO=${String(rc.rpoUnacknowledgedLost)}，追平后投影与期望指纹一致=${String(rc.projectionEqual)}。`);
  lines.push(`- 反复 ${String(rr.cycles)} 次 kill/restore 后最终投影与无故障基线一致=${String(rr.integrityEqual)}；close 后 open 资源计数=${String(resourceOpenSum(rr.resourceAfterClose))}，无泄漏=${String(rr.noLeak)}。`);
  lines.push(`- 以上均为本地 loopback 单机实测，不外推物理三机、OS 真分区或生产 SLA。`);
  lines.push('');
  lines.push('## 6. 限制与未验证边界');
  lines.push('');
  for (const limitation of result.limitations) lines.push(`- ${limitation}`);
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliOptions {
  scale: HaRecoveryScale;
  seed: number;
  jsonPath: string | null;
  mdPath: string | null;
}

function parseCli(argv: readonly string[]): CliOptions {
  const options: CliOptions = { scale: 'smoke', seed: DEFAULT_SEED, jsonPath: null, mdPath: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--scale') {
      const value = argv[index + 1];
      if (value !== 'smoke' && value !== 'S') throw new Error(`unknown scale ${String(value)}`);
      options.scale = value;
      index += 1;
    } else if (arg === '--seed') {
      options.seed = Number(argv[index + 1]);
      index += 1;
    } else if (arg === '--json') {
      options.jsonPath = argv[index + 1]!;
      index += 1;
    } else if (arg === '--md') {
      options.mdPath = argv[index + 1]!;
      index += 1;
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  const result = await runHaRecoveryBenchmark({ scale: options.scale, seed: options.seed });
  const markdown = renderMarkdown(result);
  const json = `${JSON.stringify(result, null, 2)}\n`;
  const defaultDirectory = join(tmpdir(), 'ano-ha-recovery-benchmark');
  const jsonPath = options.jsonPath ?? join(defaultDirectory, `ha-recovery-${options.scale}.json`);
  const mdPath = options.mdPath ?? join(defaultDirectory, `ha-recovery-${options.scale}.md`);
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, json);
  writeFileSync(mdPath, markdown);
  process.stdout.write(markdown);
  process.stdout.write(`\nJSON 写入：${jsonPath}\nMD 写入：${mdPath}\n`);
  if (!result.passed) {
    process.stderr.write(`T-141 基准断言未全部通过：\n${result.checks.filter((check) => !check.passed).map((check) => `- ${check.name}: ${check.detail}`).join('\n')}\n`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await main();
}
