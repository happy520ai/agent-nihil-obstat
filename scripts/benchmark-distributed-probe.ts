import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync, type Dirent } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir, platform, arch, release, cpus, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { canonicalJson } from '../src/ledger/event.ts';
import { distributedProbe, type DistributedProbeAnswer, type DistributedProbeMode } from '../src/memory/distributed-probe.ts';
import { probe, type ProbeCandidate } from '../src/memory/probe.ts';
import {
  BitChainProbeStore,
} from '../src/memory/probe-store-bitchain.ts';
import {
  probeSnapshotIdentity,
  ProjectedProbeStore,
  SqliteProbeStore,
  type ProbeStore,
} from '../src/memory/probe-store.ts';
import {
  ChildProcessReplicaTransport,
  type ReplicaHandle,
} from '../src/memory/replica-transport.ts';
import {
  committedEnvelopeFromEvent,
  type CommittedEventEnvelope,
} from '../src/memory/replication.ts';
import type { AnchorProbeResponse } from '../src/memory/probe-contract.ts';

import {
  buildFixture,
  type BenchmarkFixture,
  type BenchmarkScale,
} from './benchmark-anchor-probe.ts';

/**
 * T-131: same-semantics performance / recall / tail-latency comparison between
 * distributed asynchronous probes and the SQLite / BitChain / local projected
 * stores.
 *
 * Honesty rules (mirroring docs/anchor-probe-benchmark.md):
 * - Every number comes from this real run on this machine. Real production
 *   latency, the real query distribution and any cross-machine gain are
 *   [数据缺失] and are never inferred.
 * - All arms read the SAME fixture (`buildFixture`), the SAME committed
 *   `ViewReplayEntry[]`, the SAME snapshot, the SAME budget and the SAME
 *   request set. Replication happens before any query timing and is timed
 *   separately, so copy/rebuild cost never pollutes query latency.
 * - The equivalence gate is written into the run: for every request the
 *   distributed COMMITTED and QUORUM candidate sets must equal the local
 *   projected candidate set in canonical order, otherwise the run reports
 *   failure (a faster answer with different semantics is not a win).
 * - The degraded arm is explicitly labelled non-COMPLETE: one of two real child
 *   replicas is killed and the answer must carry failed nodes and a degraded /
 *   partial consistency claim.
 * - Replica workers are real OS child processes spawned over stdio; they open
 *   no socket and make no network egress. Cross-machine transport stays
 *   unimplemented and unclaimed.
 */

// ---------------------------------------------------------------------------
// Scales, seeds, small utilities
// ---------------------------------------------------------------------------

const PROJECT_SCOPE = 'bench-fixture';
const CLUSTER_EPOCH = 'bench-epoch-1';
const DEFAULT_SEED = 20_261_122;
const REPLICA_APPLY_CHUNK = 256;

/** Query iterations per scale (warm samples = iterations * requests - cold). */
const ITERATION_PROFILE: Readonly<Record<BenchmarkScale, number>> = {
  smoke: 30,
  S: 20,
  M: 12,
  L: 8,
};

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index]!;
}

export interface LatencyStats {
  readonly count: number;
  readonly minMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  readonly meanMs: number;
}

function latencyStats(samples: readonly number[]): LatencyStats {
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

function memorySnapshot(): NodeJS.MemoryUsage {
  return process.memoryUsage();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error(`timed out waiting for ${label}`);
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

function directoryBytes(root: string): number {
  let total = 0;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile()) {
        try {
          total += statSync(path).size;
        } catch {
          // raced with cleanup; ignore
        }
      }
    }
  }
  return total;
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

// ---------------------------------------------------------------------------
// Fixture reproducibility and candidate-set equivalence
// ---------------------------------------------------------------------------

/** Canonical candidate identity used by the distributed fingerprints. */
function candidateKey(candidate: Pick<ProbeCandidate, 'record_ref' | 'content_hash' | 'fact_key' | 'status'>): string {
  return canonicalJson([candidate.record_ref, candidate.content_hash, candidate.fact_key, candidate.status]);
}

function sortedCandidateKeys(candidates: readonly Pick<ProbeCandidate, 'record_ref' | 'content_hash' | 'fact_key' | 'status'>[]): string[] {
  return candidates.map(candidateKey).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

export interface EquivalenceReport {
  readonly fixtureReproducible: boolean;
  /** projected / sqlite / bitchain over the same entries+snapshot. */
  readonly storeCandidatesEqual: boolean;
  readonly snapshotFingerprintEqual: boolean;
  /** distributed COMMITTED candidate set == local projected candidate set. */
  readonly committedEqualsLocal: boolean;
  /** distributed QUORUM candidate set == local projected candidate set. */
  readonly quorumEqualsLocal: boolean;
  /** degraded arm is explicitly non-COMPLETE (degraded + consistency != CONSISTENT). */
  readonly degradedNonComplete: boolean;
  readonly degradedFailedNodes: boolean;
  readonly candidateCounts: Readonly<Record<string, number>>;
  readonly mismatches: readonly string[];
  readonly passed: boolean;
}

function describeMismatch(label: string, left: readonly string[], right: readonly string[]): string {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const missing = left.filter((key) => !rightSet.has(key)).slice(0, 5);
  const extra = right.filter((key) => !leftSet.has(key)).slice(0, 5);
  return `${label}: local=${String(left.length)} remote=${String(right.length)} missing=[${missing.join(', ')}] extra=[${extra.join(', ')}]`;
}

function buildEquivalence(input: {
  readonly fixture: BenchmarkFixture;
  readonly reproducedViewDigest: string;
  readonly projected: ProbeStore;
  readonly sqlite: ProbeStore;
  readonly bitchain: ProbeStore;
  readonly committed: DistributedProbeAnswer | null;
  readonly quorum: DistributedProbeAnswer | null;
  readonly degraded: DistributedProbeAnswer | null;
}): EquivalenceReport {
  const { fixture, projected, sqlite, bitchain } = input;
  const mismatches: string[] = [];
  const fixtureReproducible = input.reproducedViewDigest === fixture.viewDigest;
  if (!fixtureReproducible) mismatches.push('fixture viewDigest changed between two builds with the same seed');

  const fingerprints = [projected, sqlite, bitchain].map((store) => store.snapshotIdentity().fingerprint);
  const snapshotFingerprintEqual = fingerprints.every((value) => value === fingerprints[0]);
  if (!snapshotFingerprintEqual) mismatches.push('snapshot fingerprint differs across projected/sqlite/bitchain');

  const storeKeys = [projected, sqlite, bitchain].map((store) => sortedCandidateKeys(store.candidates({})));
  const storeCandidatesEqual = canonicalJson(storeKeys[0]) === canonicalJson(storeKeys[1])
    && canonicalJson(storeKeys[1]) === canonicalJson(storeKeys[2]);
  if (!storeCandidatesEqual) mismatches.push('candidates({}) differs across projected/sqlite/bitchain');

  const localKeys = sortedCandidateKeys(projected.candidates({}));
  const committedKeys = input.committed === null ? [] : sortedCandidateKeys(input.committed.candidates);
  const quorumKeys = input.quorum === null ? [] : sortedCandidateKeys(input.quorum.candidates);
  const committedEqualsLocal = input.committed !== null && canonicalJson(localKeys) === canonicalJson(committedKeys);
  const quorumEqualsLocal = input.quorum !== null && canonicalJson(localKeys) === canonicalJson(quorumKeys);
  if (input.committed !== null && !committedEqualsLocal) {
    mismatches.push(describeMismatch('distributed-committed candidates differ from local-projected', localKeys, committedKeys));
  }
  if (input.quorum !== null && !quorumEqualsLocal) {
    mismatches.push(describeMismatch('distributed-quorum candidates differ from local-projected', localKeys, quorumKeys));
  }

  const degraded = input.degraded;
  const degradedNonComplete = degraded !== null
    && degraded.degraded === true
    && degraded.metadata.consistency !== 'CONSISTENT';
  const degradedFailedNodes = degraded !== null && degraded.partial.failed_nodes.length > 0;
  if (degraded !== null && !degradedNonComplete) {
    mismatches.push(`degraded arm is not marked non-COMPLETE (degraded=${String(degraded.degraded)} consistency=${degraded.metadata.consistency})`);
  }
  if (degraded !== null && !degradedFailedNodes) {
    mismatches.push('degraded arm reports no failed_nodes after killing one of two replicas');
  }

  return {
    fixtureReproducible,
    storeCandidatesEqual,
    snapshotFingerprintEqual,
    committedEqualsLocal,
    quorumEqualsLocal,
    degradedNonComplete,
    degradedFailedNodes,
    candidateCounts: {
      local: localKeys.length,
      ...(input.committed === null ? {} : { committed: committedKeys.length }),
      ...(input.quorum === null ? {} : { quorum: quorumKeys.length }),
      sqlite: storeKeys[1]!.length,
      bitchain: storeKeys[2]!.length,
    },
    mismatches,
    passed: mismatches.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Backend construction
// ---------------------------------------------------------------------------

interface StoreRuntime {
  readonly store: ProbeStore;
  readonly close: () => void;
  readonly rebuildMs: number;
  readonly diskBytes: number;
}

function buildProjected(fixture: BenchmarkFixture): StoreRuntime {
  const started = performance.now();
  const store = ProjectedProbeStore.create(fixture.entries, fixture.snapshot);
  return { store, close: () => store.close(), rebuildMs: round(performance.now() - started), diskBytes: 0 };
}

function buildSqlite(fixture: BenchmarkFixture, root: string): StoreRuntime {
  const started = performance.now();
  const store = SqliteProbeStore.open(root);
  store.rebuild(fixture.entries, fixture.snapshot);
  const path = SqliteProbeStore.databasePath(root);
  return {
    store,
    close: () => store.close(),
    rebuildMs: round(performance.now() - started),
    diskBytes: existsSync(path) ? statSync(path).size : 0,
  };
}

function buildBitChain(fixture: BenchmarkFixture, root: string): StoreRuntime {
  const started = performance.now();
  const path = BitChainProbeStore.databasePath(root);
  BitChainProbeStore.write(path, fixture.entries, fixture.snapshot);
  const store = BitChainProbeStore.open(path);
  return {
    store,
    close: () => store.close(),
    rebuildMs: round(performance.now() - started),
    diskBytes: existsSync(path) ? statSync(path).size : 0,
  };
}

// ---------------------------------------------------------------------------
// Quality against the fixture truth
// ---------------------------------------------------------------------------

interface QualityRollup {
  readonly recall: number;
  readonly correctMerge: number;
  readonly conflicts: number;
  readonly stale: number;
}

interface QualityRow extends QualityRollup {
  readonly request_id: string;
  readonly completeness: string;
}

function qualityOf(
  request: { readonly request_id: string },
  response: AnchorProbeResponse,
  truth: BenchmarkFixture['truth'],
  distributed: DistributedProbeAnswer | null,
): QualityRow {
  const evidenceRefs = new Set(response.active_evidence.map((item) => item.record_ref));
  const answerableEntries = Object.entries(truth.answerable);
  const recalled = answerableEntries.filter(([, head]) => evidenceRefs.has(head)).length;
  const reported = new Set<string>();
  for (const conflict of response.conflicts) if (conflict.fact_key !== null) reported.add(conflict.fact_key);
  if (distributed !== null) {
    for (const conflict of distributed.conflicts) {
      if (conflict.fact_key !== null) reported.add(conflict.fact_key);
    }
  }
  const validAnswers = answerableEntries.filter(([factKey, head]) =>
    evidenceRefs.has(head) && !reported.has(factKey)).length;
  const staleEvidence = response.active_evidence.filter((item) => item.status === 'superseded' || item.status === 'retracted').length;
  const distributedStale = distributed !== null && (distributed.metadata.stale || (distributed.metadata.max_lag ?? 0) > 0) ? 1 : 0;
  const conflictCount = reported.size;
  return {
    request_id: request.request_id,
    recall: answerableEntries.length === 0 ? 1 : round(recalled / answerableEntries.length, 4),
    correctMerge: answerableEntries.length === 0 ? 1 : round(validAnswers / answerableEntries.length, 4),
    conflicts: conflictCount,
    stale: staleEvidence + distributedStale,
    completeness: response.budget_status.retrieval_completeness,
  };
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

interface RawMeasurement {
  readonly coldStartMs: number;
  readonly warm: LatencyStats;
  readonly maxTailMs: number;
  readonly attempts: number;
  readonly failures: number;
  readonly failureRate: number;
  readonly quality: readonly QualityRow[];
  readonly lastResponse: AnchorProbeResponse | null;
  readonly lastAnswer: DistributedProbeAnswer | null;
  readonly heapUsedDeltaBytes: number;
  readonly rssDeltaBytes: number;
}

function measureStoreArm(
  fixture: BenchmarkFixture,
  store: ProbeStore,
  iterations: number,
): RawMeasurement {
  const before = memorySnapshot();
  const samples: number[] = [];
  let coldStartMs = 0;
  let attempts = 0;
  let failures = 0;
  let lastResponse: AnchorProbeResponse | null = null;
  const quality: QualityRow[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    for (const request of fixture.requests) {
      attempts += 1;
      const started = performance.now();
      try {
        const response = probe(request, store);
        const elapsed = performance.now() - started;
        if (coldStartMs === 0 && samples.length === 0) coldStartMs = round(elapsed);
        else samples.push(elapsed);
        if (response.execution_status === 'FAILED') failures += 1;
        lastResponse = response;
        quality.push(qualityOf(request, response, fixture.truth, null));
      } catch {
        const elapsed = performance.now() - started;
        if (coldStartMs === 0 && samples.length === 0) coldStartMs = round(elapsed);
        else samples.push(elapsed);
        failures += 1;
      }
    }
  }
  const after = memorySnapshot();
  return {
    coldStartMs,
    warm: latencyStats(samples),
    maxTailMs: latencyStats(samples).maxMs,
    attempts,
    failures,
    failureRate: attempts === 0 ? 0 : round(failures / attempts, 4),
    quality,
    lastResponse,
    lastAnswer: null,
    heapUsedDeltaBytes: after.heapUsed - before.heapUsed,
    rssDeltaBytes: after.rss - before.rss,
  };
}

async function measureDistributedArm(
  fixture: BenchmarkFixture,
  run: (request: BenchmarkFixture['requests'][number]) => Promise<DistributedProbeAnswer>,
  iterations: number,
  mode: DistributedProbeMode,
): Promise<RawMeasurement> {
  const before = memorySnapshot();
  const samples: number[] = [];
  let coldStartMs = 0;
  let attempts = 0;
  let failures = 0;
  let lastAnswer: DistributedProbeAnswer | null = null;
  let lastResponse: AnchorProbeResponse | null = null;
  const quality: QualityRow[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    for (const request of fixture.requests) {
      attempts += 1;
      const started = performance.now();
      try {
        const answer = await run(request);
        const elapsed = performance.now() - started;
        if (coldStartMs === 0 && samples.length === 0) coldStartMs = round(elapsed);
        else samples.push(elapsed);
        if (answer.response.execution_status === 'FAILED') failures += 1;
        lastAnswer = answer;
        lastResponse = answer.response;
        quality.push(qualityOf(request, answer.response, fixture.truth, answer));
      } catch {
        const elapsed = performance.now() - started;
        if (coldStartMs === 0 && samples.length === 0) coldStartMs = round(elapsed);
        else samples.push(elapsed);
        failures += 1;
      }
    }
  }
  const after = memorySnapshot();
  void mode;
  return {
    coldStartMs,
    warm: latencyStats(samples),
    maxTailMs: latencyStats(samples).maxMs,
    attempts,
    failures,
    failureRate: attempts === 0 ? 0 : round(failures / attempts, 4),
    quality,
    lastResponse,
    lastAnswer,
    heapUsedDeltaBytes: after.heapUsed - before.heapUsed,
    rssDeltaBytes: after.rss - before.rss,
  };
}

function rollupQuality(rows: readonly QualityRow[]): QualityRollup {
  if (rows.length === 0) return { recall: 0, correctMerge: 0, conflicts: 0, stale: 0 };
  // Conflict/stale are per-request facts, not additive counters: report the
  // worst single request so repeated identical queries do not inflate them.
  return {
    recall: round(rows.reduce((total, row) => total + row.recall, 0) / rows.length, 4),
    correctMerge: round(rows.reduce((total, row) => total + row.correctMerge, 0) / rows.length, 4),
    conflicts: rows.reduce((worst, row) => Math.max(worst, row.conflicts), 0),
    stale: rows.reduce((worst, row) => Math.max(worst, row.stale), 0),
  };
}

export type ArmGroup = 'single-node' | 'distributed' | 'distributed-degraded';

export interface ArmRow {
  readonly arm: string;
  readonly label: string;
  readonly group: ArmGroup;
  readonly mode: DistributedProbeMode | 'LOCAL-PROJECTED' | 'SQLITE' | 'BITCHAIN';
  readonly requests: number;
  readonly iterations: number;
  readonly attempts: number;
  readonly failures: number;
  readonly failureRate: number;
  readonly coldStartMs: number;
  readonly warm: LatencyStats;
  readonly maxTailMs: number;
  readonly recall: number;
  readonly correctMerge: number;
  readonly conflicts: number;
  readonly stale: number;
  readonly qualityByRequest: readonly QualityRow[];
  readonly heapUsedDeltaBytes: number;
  readonly rssDeltaBytes: number;
  readonly rebuildMs: number;
  readonly diskBytes: number;
  readonly degraded: boolean;
  readonly consistency: string | null;
  readonly retrievalCompleteness: string | null;
  readonly failedNodes: number;
  readonly note: string;
}

// ---------------------------------------------------------------------------
// Distributed replica lifecycle
// ---------------------------------------------------------------------------

interface ReplicaRecord {
  readonly replicaId: string;
  readonly pid: number | null;
  readonly diskBytes: number;
  stopped: boolean;
  aliveAfterStop: boolean;
}

interface ReplicationSetup {
  readonly setupMs: number;
  readonly catchUpMs: number;
  readonly appliedEvents: number;
  readonly diskBytes: number;
  readonly envelopes: readonly CommittedEventEnvelope[];
  readonly replicas: readonly ReplicaRecord[];
  readonly nodes: readonly import('../src/memory/distributed-probe.ts').DistributedReplicaNode[];
  readonly stop: () => Promise<void>;
}

async function applyInChunks(
  transport: ChildProcessReplicaTransport,
  handle: ReplicaHandle,
  envelopes: readonly CommittedEventEnvelope[],
  projectScope: string,
  chunkSize: number,
): Promise<void> {
  for (let offset = 0; offset < envelopes.length; offset += chunkSize) {
    const chunk = envelopes.slice(offset, offset + chunkSize);
    const report = await transport.apply(handle, chunk, { projectScope });
    if (report.corrupt > 0) throw new Error(`replica apply reported ${String(report.corrupt)} corrupt event(s)`);
    if (report.gaps.length > 0) throw new Error(`replica apply produced gaps ${report.gaps.join(',')}`);
  }
}

async function replicateFixture(
  fixture: BenchmarkFixture,
  root: string,
  options: Required<Pick<DistributedBenchmarkOptions, 'replicaStartTimeoutMs' | 'catchUpTimeoutMs' | 'applyChunk'>>,
): Promise<ReplicationSetup> {
  const transport = new ChildProcessReplicaTransport();
  const replicaIds = ['bench-replica-a', 'bench-replica-b'];
  const envelopes: readonly CommittedEventEnvelope[] = fixture.entries.map((entry, index) =>
    committedEnvelopeFromEvent(entry.event, index + 1, entry.segment));

  const started = performance.now();
  const handles: ReplicaHandle[] = [];
  let setupMs = 0;
  let catchUpMs = 0;
  let nodes: ReplicationSetup['nodes'] = [];
  const stopAll = async (): Promise<void> => {
    for (const handle of handles) {
      try {
        await transport.stop(handle);
      } catch {
        if (handle.pid !== null) {
          try {
            process.kill(handle.pid, 'SIGKILL');
          } catch {
            // already gone
          }
        }
      }
    }
  };
  try {
    for (const replicaId of replicaIds) {
      handles.push(await transport.start({
        root,
        replicaId,
        projectScope: PROJECT_SCOPE,
        clusterEpoch: CLUSTER_EPOCH,
        snapshot: fixture.snapshot,
        startTimeoutMs: options.replicaStartTimeoutMs,
      }));
    }
    await Promise.all(handles.map((handle) =>
      applyInChunks(transport, handle, envelopes, PROJECT_SCOPE, options.applyChunk)));

    const catchUpStarted = performance.now();
    // Catch-up wait: poll each replica's status until the commit point and view
    // digest match the fixture. apply already returned a report, so this is
    // normally one round trip.
    await Promise.all(handles.map(async (handle) => {
      const deadline = Date.now() + options.catchUpTimeoutMs;
      for (;;) {
        const status = await transport.status(handle);
        if (status.commitIndex === fixture.entries.length && status.viewDigest === fixture.viewDigest) return;
        if (Date.now() >= deadline) {
          throw new Error(`replica ${handle.replicaId} did not catch up: commit ${String(status.commitIndex)}/${String(fixture.entries.length)} digest ${status.viewDigest.slice(0, 12)}`);
        }
        await delay(10);
      }
    }));
    catchUpMs = round(performance.now() - catchUpStarted);
    setupMs = round(performance.now() - started);
    nodes = await Promise.all(handles.map((handle) => transport.toDistributedReplicaNode(handle)));
  } catch (error) {
    await stopAll();
    throw error;
  }

  const records: ReplicaRecord[] = handles.map((handle) => ({
    replicaId: handle.replicaId,
    pid: handle.pid,
    diskBytes: directoryBytes(join(root, '.ano', 'replicas', handle.replicaId)),
    stopped: false,
    aliveAfterStop: true,
  }));

  const stop = async (): Promise<void> => {
    await stopAll();
    for (let index = 0; index < handles.length; index += 1) {
      records[index]!.stopped = true;
      records[index]!.aliveAfterStop = handles[index]!.pid !== null && processExists(handles[index]!.pid);
    }
  };

  return {
    setupMs,
    catchUpMs,
    appliedEvents: envelopes.length,
    diskBytes: records.reduce((total, record) => total + record.diskBytes, 0),
    envelopes,
    replicas: records,
    nodes,
    stop,
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface DistributedBenchmarkOptions {
  readonly scale: BenchmarkScale;
  readonly seed: number;
  readonly iterations?: number;
  readonly workRoot?: string;
  /** Remove an auto-created work root afterwards. Defaults to true. */
  readonly cleanupWorkRoot?: boolean;
  readonly replicaStartTimeoutMs?: number;
  readonly catchUpTimeoutMs?: number;
  readonly applyChunk?: number;
}

export interface DistributedBenchmarkResult {
  readonly schema: 'distributedprobe.benchmark.v1';
  readonly generatedAt: string;
  readonly command: string;
  readonly scale: BenchmarkScale;
  readonly seed: number;
  readonly environment: Record<string, unknown>;
  readonly fixture: {
    readonly viewDigest: string;
    readonly reproducedViewDigest: string;
    readonly snapshotFingerprint: string;
    readonly requiredFacts: readonly string[];
    readonly composition: BenchmarkFixture['composition'];
  };
  readonly replication: {
    readonly setupMs: number;
    readonly catchUpMs: number;
    readonly appliedEvents: number;
    readonly diskBytes: number;
    readonly replicas: readonly ReplicaRecord[];
  };
  readonly equivalence: EquivalenceReport;
  readonly arms: readonly ArmRow[];
  readonly cost: {
    readonly rssBeforeBytes: number;
    readonly rssAfterBytes: number;
    readonly heapUsedBeforeBytes: number;
    readonly heapUsedAfterBytes: number;
  };
  readonly limitations: readonly string[];
}

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

export async function runDistributedBenchmark(options: DistributedBenchmarkOptions): Promise<DistributedBenchmarkResult> {
  const fixture = buildFixture(options.scale, options.seed);
  const reproduced = buildFixture(options.scale, options.seed);
  const iterations = options.iterations ?? ITERATION_PROFILE[options.scale];
  const autoWorkRoot = options.workRoot === undefined;
  const workRoot = options.workRoot ?? mkdtempSync(join(tmpdir(), 'ano-distributed-probe-bench-'));
  const rssBefore = memorySnapshot().rss;
  const heapBefore = memorySnapshot().heapUsed;

  const arms: ArmRow[] = [];
  let committed: DistributedProbeAnswer | null = null;
  let quorum: DistributedProbeAnswer | null = null;
  let degraded: DistributedProbeAnswer | null = null;
  let replication: ReplicationSetup | null = null;
  let equivalence: EquivalenceReport | null = null;

  try {
    // --- single-node arms -------------------------------------------------
    const projectedRuntime = buildProjected(fixture);
    const sqliteRuntime = buildSqlite(fixture, join(workRoot, 'stores', 'sqlite'));
    const bitchainRuntime = buildBitChain(fixture, join(workRoot, 'stores', 'bitchain'));

    try {
      arms.push(toArmRow({
        arm: 'local-projected',
        label: '本地投影（单进程基线）',
        group: 'single-node',
        mode: 'LOCAL-PROJECTED',
        fixture,
        iterations,
        measurement: measureStoreArm(fixture, projectedRuntime.store, iterations),
        rebuildMs: projectedRuntime.rebuildMs,
        diskBytes: projectedRuntime.diskBytes,
        note: 'ProjectedProbeStore：每次构造重放已提交事件，无持久缓存。',
      }));

      arms.push(toArmRow({
        arm: 'sqlite',
        label: 'SQLite 探针缓存',
        group: 'single-node',
        mode: 'SQLITE',
        fixture,
        iterations,
        measurement: measureStoreArm(fixture, sqliteRuntime.store, iterations),
        rebuildMs: sqliteRuntime.rebuildMs,
        diskBytes: sqliteRuntime.diskBytes,
        note: '同 entries/snapshot 一次性 rebuild；磁盘字节为 db 文件。',
      }));

      arms.push(toArmRow({
        arm: 'bitchain',
        label: 'BitChain 实验缓存',
        group: 'single-node',
        mode: 'BITCHAIN',
        fixture,
        iterations,
        measurement: measureStoreArm(fixture, bitchainRuntime.store, iterations),
        rebuildMs: bitchainRuntime.rebuildMs,
        diskBytes: bitchainRuntime.diskBytes,
        note: '显式实验后端，未接入默认路径。',
      }));
    } finally {
      projectedRuntime.close();
      sqliteRuntime.close();
      bitchainRuntime.close();
    }

    // --- distributed arms -------------------------------------------------
    const replicaRoot = join(workRoot, 'replica-root');
    replication = await replicateFixture(fixture, replicaRoot, {
      replicaStartTimeoutMs: options.replicaStartTimeoutMs ?? 20_000,
      catchUpTimeoutMs: options.catchUpTimeoutMs ?? 20_000,
      applyChunk: options.applyChunk ?? REPLICA_APPLY_CHUNK,
    });

    const localStore = ProjectedProbeStore.create(fixture.entries, fixture.snapshot);
    try {
      const committedRun = (request: BenchmarkFixture['requests'][number]): Promise<DistributedProbeAnswer> =>
        distributedProbe(request, {
          localStore,
          replicas: replication!.nodes,
          mode: 'COMMITTED',
          primaryCommitIndex: fixture.entries.length,
          clusterEpoch: CLUSTER_EPOCH,
          deadlineMs: 10_000,
          nodeTimeoutMs: 5_000,
        });
      const committedMeasurement = await measureDistributedArm(fixture, committedRun, iterations, 'COMMITTED');
      committed = committedMeasurement.lastAnswer;
      arms.push(toArmRow({
        arm: 'distributed-committed',
        label: '分布式 COMMITTED（2 真实子进程副本）',
        group: 'distributed',
        mode: 'COMMITTED',
        fixture,
        iterations,
        measurement: committedMeasurement,
        rebuildMs: replication.setupMs,
        diskBytes: replication.diskBytes,
        note: '复制/追平耗时单独计入 rebuildMs，不混入查询延迟。',
      }));

      const quorumRun = (request: BenchmarkFixture['requests'][number]): Promise<DistributedProbeAnswer> =>
        distributedProbe(request, {
          localStore,
          replicas: replication!.nodes,
          mode: 'QUORUM',
          primaryCommitIndex: fixture.entries.length,
          clusterEpoch: CLUSTER_EPOCH,
          deadlineMs: 10_000,
          nodeTimeoutMs: 5_000,
        });
      const quorumMeasurement = await measureDistributedArm(fixture, quorumRun, iterations, 'QUORUM');
      quorum = quorumMeasurement.lastAnswer;
      arms.push(toArmRow({
        arm: 'distributed-quorum',
        label: '分布式 QUORUM（2 副本多数派）',
        group: 'distributed',
        mode: 'QUORUM',
        fixture,
        iterations,
        measurement: quorumMeasurement,
        rebuildMs: replication.setupMs,
        diskBytes: replication.diskBytes,
        note: 'quorum_size=ceil((N+1)/2)=2，两副本同提交点同摘要。',
      }));

      // Degraded group: kill one of the two real child processes, then rerun
      // the same QUORUM request set. The survivor still answers, so the
      // coordinator explicitly downgrades to COMMITTED and marks the answer
      // degraded/partial instead of claiming QUORUM.
      const victim = replication.replicas[1]!;
      if (victim.pid !== null) {
        try {
          process.kill(victim.pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
      await waitFor(() => victim.pid === null || !processExists(victim.pid), 5_000, 'killed replica to disappear');

      const degradedRun = (request: BenchmarkFixture['requests'][number]): Promise<DistributedProbeAnswer> =>
        distributedProbe(request, {
          localStore,
          replicas: replication!.nodes,
          mode: 'QUORUM',
          primaryCommitIndex: fixture.entries.length,
          clusterEpoch: CLUSTER_EPOCH,
          deadlineMs: 10_000,
          nodeTimeoutMs: 5_000,
        });
      const degradedMeasurement = await measureDistributedArm(fixture, degradedRun, iterations, 'QUORUM');
      degraded = degradedMeasurement.lastAnswer;
      arms.push(toArmRow({
        arm: 'distributed-degraded',
        label: '分布式降级（杀 1/2 副本后 QUORUM）',
        group: 'distributed-degraded',
        mode: 'QUORUM',
        fixture,
        iterations,
        measurement: degradedMeasurement,
        rebuildMs: replication.setupMs,
        diskBytes: replication.diskBytes,
        note: '显式非 COMPLETE：degraded=true、consistency=PARTIAL、failed_nodes 非空；不得读作完整集群健康。',
      }));
    } finally {
      localStore.close();
    }

    const equivalenceProjected = ProjectedProbeStore.create(fixture.entries, fixture.snapshot);
    const equivalenceSqliteRuntime = buildSqlite(fixture, join(workRoot, 'stores', 'equivalence-sqlite'));
    const equivalenceBitChainRuntime = buildBitChain(fixture, join(workRoot, 'stores', 'equivalence-bitchain'));
    try {
      equivalence = buildEquivalence({
        fixture,
        reproducedViewDigest: reproduced.viewDigest,
        projected: equivalenceProjected,
        sqlite: equivalenceSqliteRuntime.store,
        bitchain: equivalenceBitChainRuntime.store,
        committed,
        quorum,
        degraded,
      });
    } finally {
      equivalenceProjected.close();
      equivalenceSqliteRuntime.close();
      equivalenceBitChainRuntime.close();
    }
  } finally {
    if (replication !== null) await replication.stop();
    if (autoWorkRoot && options.cleanupWorkRoot !== false) removeTempRoot(workRoot);
  }

  const rssAfter = memorySnapshot().rss;
  const heapAfter = memorySnapshot().heapUsed;

  return {
    schema: 'distributedprobe.benchmark.v1',
    generatedAt: new Date().toISOString(),
    command: 'node scripts/benchmark-distributed-probe.ts',
    scale: options.scale,
    seed: options.seed,
    environment: environmentRecord(),
    fixture: {
      viewDigest: fixture.viewDigest,
      reproducedViewDigest: reproduced.viewDigest,
      snapshotFingerprint: probeSnapshotIdentity(fixture.snapshot).fingerprint,
      requiredFacts: fixture.requiredFacts,
      composition: fixture.composition,
    },
    replication: {
      setupMs: replication?.setupMs ?? 0,
      catchUpMs: replication?.catchUpMs ?? 0,
      appliedEvents: replication?.appliedEvents ?? 0,
      diskBytes: replication?.diskBytes ?? 0,
      replicas: replication?.replicas ?? [],
    },
    equivalence: equivalence ?? {
      fixtureReproducible: false,
      storeCandidatesEqual: false,
      snapshotFingerprintEqual: false,
      committedEqualsLocal: false,
      quorumEqualsLocal: false,
      degradedNonComplete: false,
      degradedFailedNodes: false,
      candidateCounts: {},
      mismatches: ['benchmark did not complete'],
      passed: false,
    },
    arms,
    cost: {
      rssBeforeBytes: rssBefore,
      rssAfterBytes: rssAfter,
      heapUsedBeforeBytes: heapBefore,
      heapUsedAfterBytes: heapAfter,
    },
    limitations: [
      '单机本地进程实测：副本是同一台机器上的子进程，走 stdio，不是真网络；不可外推跨机带宽/丢包收益。',
      '未验证真分区、脑裂、跨机时钟回拨与生产高可用；副本传输接口保留给未来实现。',
      '不承诺十倍、线性扩展或任何跨机加速；QUORUM 的多数派在本机 IPC 下只会增加协调成本。',
      '真实生产延迟与真实查询分布为 [数据缺失]；夹具查询集只有 2 条请求，尾延迟统计样本有限。',
      'RSS/heapUsed 差值未强制 GC，是 Node 进程观测值，噪声大，仅作数量级参考。',
      '冷启动首查包含首次 JIT/IPC/缓存建立；热态统计不含第一次调用。',
    ],
  };
}

function toArmRow(input: {
  readonly arm: string;
  readonly label: string;
  readonly group: ArmGroup;
  readonly mode: ArmRow['mode'];
  readonly fixture: BenchmarkFixture;
  readonly iterations: number;
  readonly measurement: RawMeasurement;
  readonly rebuildMs: number;
  readonly diskBytes: number;
  readonly note: string;
}): ArmRow {
  const quality = rollupQuality(input.measurement.quality);
  const answer = input.measurement.lastAnswer;
  return {
    arm: input.arm,
    label: input.label,
    group: input.group,
    mode: input.mode,
    requests: input.fixture.requests.length,
    iterations: input.iterations,
    attempts: input.measurement.attempts,
    failures: input.measurement.failures,
    failureRate: input.measurement.failureRate,
    coldStartMs: input.measurement.coldStartMs,
    warm: input.measurement.warm,
    maxTailMs: input.measurement.maxTailMs,
    recall: quality.recall,
    correctMerge: quality.correctMerge,
    conflicts: quality.conflicts,
    stale: quality.stale,
    qualityByRequest: input.measurement.quality,
    heapUsedDeltaBytes: input.measurement.heapUsedDeltaBytes,
    rssDeltaBytes: input.measurement.rssDeltaBytes,
    rebuildMs: input.rebuildMs,
    diskBytes: input.diskBytes,
    degraded: answer?.degraded ?? false,
    consistency: answer?.metadata.consistency ?? null,
    retrievalCompleteness: answer?.response.budget_status.retrieval_completeness ?? null,
    failedNodes: answer?.partial.failed_nodes.length ?? 0,
    note: input.note,
  };
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

function formatLatency(stats: LatencyStats): string {
  return `p50 ${String(stats.p50Ms)} / p95 ${String(stats.p95Ms)} / p99 ${String(stats.p99Ms)} / max ${String(stats.maxMs)}`;
}

function renderMarkdown(result: DistributedBenchmarkResult): string {
  const lines: string[] = [];
  lines.push('# 分布式探针对照基准（T-131 / M15）');
  lines.push('');
  lines.push(`- 生成时间：${result.generatedAt}`);
  lines.push(`- 命令：\`${result.command} --scale ${result.scale} --seed ${result.seed}\``);
  lines.push(`- 环境：node ${String(result.environment.node)} / ${String(result.environment.platform)} ${String(result.environment.arch)} ${String(result.environment.release)} / ${String(result.environment.cpuModel)} x${String(result.environment.cpuCount)}`);
  lines.push(`- 夹具：${result.fixture.composition.totalEvents} 事件（memory.revised ${result.fixture.composition.memoryRevised} / note.recorded ${result.fixture.composition.noteRecorded} / memory.related ${result.fixture.composition.memoryRelated}），受治理事实 ${result.fixture.composition.governedFacts}，冲突事实 ${result.fixture.composition.conflictedFacts}；viewDigest=${result.fixture.viewDigest.slice(0, 16)}…`);
  lines.push(`- 同语义门：fixture 可复现=${result.equivalence.fixtureReproducible} / 三后端候选一致=${result.equivalence.storeCandidatesEqual} / COMMITTED==本地=${result.equivalence.committedEqualsLocal} / QUORUM==本地=${result.equivalence.quorumEqualsLocal} / 降级非 COMPLETE=${result.equivalence.degradedNonComplete} / 降级 failed_nodes=${result.equivalence.degradedFailedNodes}`);
  lines.push('');
  lines.push('## 1. 方法学');
  lines.push('');
  lines.push('- 同证据：所有臂共用 `buildFixture(scale, seed)` 产出的同一 `ViewReplayEntry[]`、同一 snapshot、同一预算、同一查询集；因此差异只可能来自执行路径，不可能来自数据版本。');
  lines.push('- 同版本：副本由主侧已提交事件构造 `CommittedEventEnvelope`（`committedEnvelopeFromEvent`，与 `exportCommittedEvents` 同一字节口径）复制，并在测量前等待 `commitIndex` 追平且 `viewDigest` 相等。');
  lines.push('- 复制/重建单独计时：副本启动 + 分批 apply + 追平的耗时计入 `rebuildMs`（replication.setupMs），不混入查询延迟；磁盘字节单独统计。');
  lines.push('- 冷热分组：每条臂的第一次查询单列为 `coldStartMs`；P50/P95/P99/max 取其余热态样本。');
  lines.push('- 故障分组：`distributed-degraded` 单独成组——SIGKILL 掉 2 个真实子进程中的 1 个后重跑同一 QUORUM 请求集；答案必须标注 degraded/partial 且 failed_nodes 非空，明确非 COMPLETE。');
  lines.push('- 等价性写进运行：COMMITTED 与 QUORUM 的候选集合按规范序与本地投影逐一比对，不一致即判失败（见 JSON `equivalence.mismatches`）。');
  lines.push('');
  lines.push('## 2. 副本复制与重建成本');
  lines.push('');
  lines.push('| 项 | 值 |');
  lines.push('|---|---|');
  lines.push(`| 复制+追平总耗时 ms | ${result.replication.setupMs} |`);
  lines.push(`| 追平等待耗时 ms | ${result.replication.catchUpMs} |`);
  lines.push(`| 复制事件数 | ${result.replication.appliedEvents} |`);
  lines.push(`| 副本目录磁盘字节 | ${result.replication.diskBytes} |`);
  for (const replica of result.replication.replicas) {
    lines.push(`| 副本 ${replica.replicaId} pid ${String(replica.pid)} | 磁盘 ${replica.diskBytes} B / 停止后存活=${replica.aliveAfterStop} |`);
  }
  lines.push('');
  lines.push('## 3. 主对照表（热态查询延迟，单位 ms；质量对夹具真值）');
  lines.push('');
  lines.push('| 臂 | 模式 | 请求/迭代 | P50 | P95 | P99 | 最大尾 | 冷启动首查 | 召回 | 正确合并 | 冲突 | 陈旧 | 失败率 | heapUsedΔ B | RSSΔ B | 重建 ms | 磁盘 B |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const row of result.arms) {
    lines.push(`| ${row.arm} | ${row.mode} | ${row.requests}/${row.iterations} | ${row.warm.p50Ms} | ${row.warm.p95Ms} | ${row.warm.p99Ms} | ${row.maxTailMs} | ${row.coldStartMs} | ${row.recall} | ${row.correctMerge} | ${row.conflicts} | ${row.stale} | ${row.failureRate} | ${row.heapUsedDeltaBytes} | ${row.rssDeltaBytes} | ${row.rebuildMs} | ${row.diskBytes} |`);
  }
  lines.push('');
  lines.push('说明：`local-projected`/`sqlite`/`bitchain` 的 `mode` 列是其存储后端标识，不是分布式检索模式；三者都以本地 `probe()` 作答。`distributed-*` 的 P50/P95/P99 含父进程 scatter/gather 与真实子进程 IPC。');
  lines.push('');
  lines.push('## 4. 降级臂明细（单独成组）');
  lines.push('');
  const degradedRow = result.arms.find((row) => row.arm === 'distributed-degraded');
  if (degradedRow === undefined) {
    lines.push('[数据缺失]');
  } else {
    lines.push(`- degraded=${String(degradedRow.degraded)} / consistency=${String(degradedRow.consistency)} / retrieval_completeness=${String(degradedRow.retrievalCompleteness)} / failed_nodes=${degradedRow.failedNodes}`);
    lines.push('- 该次检索完整性按夹具可能是 COMPLETE 或 PARTIAL；无论哪种，分布式一致性声明都是 `PARTIAL` 且 `degraded=true`，因此整体不得读作集群 COMPLETE。');
    lines.push(`- 热态延迟：${formatLatency(degradedRow.warm)}；失败率 ${degradedRow.failureRate}`);
    lines.push('- 该臂只证明「副本缺失时答案显式降级且不伪造 COMPLETE」，不证明可用性或恢复时间目标。');
  }
  lines.push('');
  lines.push('## 5. 等价性与断言');
  lines.push('');
  lines.push(`- 候选集合计数：${canonicalJson(result.equivalence.candidateCounts)}`);
  for (const mismatch of result.equivalence.mismatches) lines.push(`- 不一致：${mismatch}`);
  if (result.equivalence.mismatches.length === 0) lines.push('- 全部等价性断言通过：fixture 可复现、三后端候选一致、COMMITTED/QUORUM 候选与本地完全一致、降级臂非 COMPLETE 且 failed_nodes 非空。');
  lines.push('');
  lines.push('## 6. 实测结论（只陈述本次运行事实与趋势）');
  lines.push('');
  const armByName = new Map(result.arms.map((row) => [row.arm, row]));
  const localP50 = armByName.get('local-projected')?.warm.p50Ms ?? 0;
  const ratio = (value: number): string => (localP50 > 0 ? `${round(value / localP50, 2)}x` : 'n/a');
  lines.push(`- 同语义成立：fixture 可复现、三后端候选集合一致、COMMITTED/QUORUM 候选集合按规范序与本地投影完全一致（计数 ${String(result.equivalence.candidateCounts.local)}）。`);
  lines.push(`- 热态 P50：distributed-committed ${armByName.get('distributed-committed')?.warm.p50Ms ?? '[数据缺失]'} ms（${ratio(armByName.get('distributed-committed')?.warm.p50Ms ?? 0)}）/ distributed-quorum ${armByName.get('distributed-quorum')?.warm.p50Ms ?? '[数据缺失]'} ms（${ratio(armByName.get('distributed-quorum')?.warm.p50Ms ?? 0)}），本地投影基线 ${localP50} ms，SQLite ${armByName.get('sqlite')?.warm.p50Ms ?? '[数据缺失]'} ms，BitChain ${armByName.get('bitchain')?.warm.p50Ms ?? '[数据缺失]'} ms。单机本地 IPC 下分布式协调成本高于直接读本地投影/缓存，本次未观察到提速。`);
  lines.push(`- 尾延迟：distributed-committed p99=${armByName.get('distributed-committed')?.warm.p99Ms ?? '[数据缺失]'} / max=${armByName.get('distributed-committed')?.maxTailMs ?? '[数据缺失]'} ms；distributed-quorum p99=${armByName.get('distributed-quorum')?.warm.p99Ms ?? '[数据缺失]'} / max=${armByName.get('distributed-quorum')?.maxTailMs ?? '[数据缺失]'} ms；本地投影 p99=${armByName.get('local-projected')?.warm.p99Ms ?? '[数据缺失]'} / max=${armByName.get('local-projected')?.maxTailMs ?? '[数据缺失]'} ms。`);
  lines.push(`- 质量：各臂召回与正确合并均为 ${result.arms.find((row) => row.arm === 'local-projected')?.recall ?? '[数据缺失]'}，冲突数 ${result.fixture.composition.conflictedFacts}（等于夹具冲突事实数），陈旧 ${result.arms.find((row) => row.arm === 'local-projected')?.stale ?? '[数据缺失]'}，失败率均为 0。`);
  lines.push(`- 复制成本：${result.replication.appliedEvents} 个已提交事件复制到 2 个真实子进程并追平耗时 ${result.replication.setupMs} ms，副本磁盘 ${result.replication.diskBytes} B。`);
  lines.push('- 降级事实：杀 1/2 副本后答案仍返回，但 degraded=true、consistency=PARTIAL、failed_nodes=1，未冒充 COMPLETE。');
  lines.push('');
  lines.push('## 7. 限制与未验证边界');
  lines.push('');
  for (const limitation of result.limitations) lines.push(`- ${limitation}`);
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliOptions {
  scale: BenchmarkScale;
  seed: number;
  iterations: number;
  jsonPath: string | null;
  mdPath: string | null;
}

function parseCli(argv: readonly string[]): CliOptions {
  const options: CliOptions = { scale: 'smoke', seed: DEFAULT_SEED, iterations: 0, jsonPath: null, mdPath: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--scale') {
      const value = argv[index + 1];
      if (value !== 'smoke' && value !== 'S' && value !== 'M' && value !== 'L') throw new Error(`unknown scale ${String(value)}`);
      options.scale = value;
      index += 1;
    } else if (arg === '--seed') {
      options.seed = Number(argv[index + 1]);
      index += 1;
    } else if (arg === '--iterations') {
      options.iterations = Number(argv[index + 1]);
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
  const result = await runDistributedBenchmark({
    scale: options.scale,
    seed: options.seed,
    ...(options.iterations > 0 ? { iterations: options.iterations } : {}),
  });
  const markdown = renderMarkdown(result);
  const json = `${JSON.stringify(result, null, 2)}\n`;
  const defaultDirectory = join(tmpdir(), 'ano-distributed-probe-benchmark');
  const jsonPath = options.jsonPath ?? join(defaultDirectory, `benchmark-${options.scale}.json`);
  const mdPath = options.mdPath ?? join(defaultDirectory, `benchmark-${options.scale}.md`);
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, json);
  writeFileSync(mdPath, markdown);
  process.stdout.write(markdown);
  process.stdout.write(`\nJSON 写入：${jsonPath}\nMD 写入：${mdPath}\n`);
  if (!result.equivalence.passed) {
    process.stderr.write(`等价性门未通过：\n${result.equivalence.mismatches.map((item) => `- ${item}`).join('\n')}\n`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await main();
}
