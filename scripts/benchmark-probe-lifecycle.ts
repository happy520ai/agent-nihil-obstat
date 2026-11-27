import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import {
  distributedProbe,
  type DistributedNodeQuery,
  type DistributedProbeAnswer,
  type DistributedProbeOptions,
  type DistributedReplicaNode,
} from '../src/memory/distributed-probe.ts';
import {
  ANCHOR_PROBE_REQUEST_SCHEMA_VERSION,
  type AnchorProbeRequest,
  type AnchorProbeSnapshot,
} from '../src/memory/probe-contract.ts';
import type { ProbeCandidate, ProbeEdge, ProbeEntryQuery } from '../src/memory/probe.ts';
import {
  probeSnapshotIdentity,
  type ProbeEvidencePayload,
  type ProbeProvenanceView,
  type ProbeStatusView,
  type ProbeStore,
} from '../src/memory/probe-store.ts';

/**
 * T-160 / MNT-04: same-semantics comparison for the T-157/T-158 resource work.
 *
 * Two arms run over identical in-memory stores and the same request set:
 * - baseline: full gather, no admission caps (the pre-T-157 behaviour);
 * - optimized: early freeze plus process-wide/per-node caps (T-157 defaults).
 *
 * The fast arm asserts the two arms produce identical evidence (candidate set,
 * evidence digest, commit point, mode, consistency). The slow-tail arm measures
 * the return time with one 200ms replica. The concurrency arm checks that the
 * caps are actually honoured. Latencies are wall-clock samples from this
 * machine; this is not a production SLA and not a cross-machine measurement.
 */

const SCOPE = 'bench';
const AT = '2026-11-26T00:00:00.000Z';
const COMMIT = 10;
const FAST_ITERATIONS = 30;
const SLOW_ITERATIONS = 8;
const CONCURRENCY_PROBES = 4;
const CONCURRENCY_ITERATIONS = 5;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function candidate(recordRef: string): ProbeCandidate {
  return {
    record_ref: recordRef,
    fact_key: 'bench.fact',
    task_id: null,
    file: null,
    symbol: null,
    source: { kind: 'native_note' },
    source_health: 'verified_at_snapshot',
    status: 'active',
    content: `content of ${recordRef}`,
    content_hash: sha256(recordRef),
    recorded_at: AT,
    effective_from: null,
    effective_to: null,
    superseded_by: null,
    version: null,
    anchor: { status: 'none', file: null },
    qualifiers: [],
  };
}

function matches(query: ProbeEntryQuery, record: ProbeCandidate): boolean {
  if (query.fact_key !== undefined && record.fact_key !== query.fact_key) return false;
  if (query.task_id !== undefined && record.task_id !== query.task_id) return false;
  if (query.file !== undefined && record.file !== query.file) return false;
  if (query.symbol !== undefined && record.symbol !== query.symbol) return false;
  return true;
}

function snapshot(): AnchorProbeSnapshot {
  return {
    project_scope: SCOPE,
    ledger_digest: sha256('ledger'),
    graph_revision: null,
    source_fingerprint: null,
    connected_digest: null,
  };
}

class BenchStore implements ProbeStore {
  readonly #records: readonly ProbeCandidate[];
  readonly #snapshot: AnchorProbeSnapshot = snapshot();

  constructor(records: readonly ProbeCandidate[]) {
    this.#records = records;
  }

  get snapshot(): AnchorProbeSnapshot {
    return this.#snapshot;
  }

  replicaCommitIndex(): number {
    return COMMIT;
  }

  candidates(query?: ProbeEntryQuery): readonly ProbeCandidate[] {
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

interface Instrumentation {
  globalActive: number;
  peakGlobal: number;
  perNode: Map<string, number>;
  peakPerNode: Map<string, number>;
}

function instrument(): Instrumentation {
  return { globalActive: 0, peakGlobal: 0, perNode: new Map(), peakPerNode: new Map() };
}

function replica(id: string, latencyMs: number, stats: Instrumentation): DistributedReplicaNode {
  const store = new BenchStore([candidate('rec-a')]);
  const query: DistributedNodeQuery = async (_request, context) => {
    stats.globalActive += 1;
    stats.peakGlobal = Math.max(stats.peakGlobal, stats.globalActive);
    const active = (stats.perNode.get(id) ?? 0) + 1;
    stats.perNode.set(id, active);
    stats.peakPerNode.set(id, Math.max(stats.peakPerNode.get(id) ?? 0, active));
    try {
      // Cooperative like the real transports: an early freeze aborts the
      // signal and the simulated node stops immediately, so the measured
      // in-flight count is the scheduler's, not an abandoned timer's.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, latencyMs);
        const onAbort = (): void => {
          clearTimeout(timer);
          reject(new Error('node query aborted'));
        };
        if (context.signal.aborted) onAbort();
        else context.signal.addEventListener('abort', onAbort, { once: true });
      });
      return { candidates: store.candidates(), edges: [], commitIndex: COMMIT };
    } finally {
      stats.globalActive -= 1;
      stats.perNode.set(id, (stats.perNode.get(id) ?? 1) - 1);
    }
  };
  return { replicaId: id, store, commitIndex: COMMIT, query };
}

function request(requestId: string): AnchorProbeRequest {
  return {
    schema_version: ANCHOR_PROBE_REQUEST_SCHEMA_VERSION,
    request_id: requestId,
    root: 'F:/bench',
    project_scope: SCOPE,
    required_facts: ['bench.fact'],
  } as AnchorProbeRequest;
}

const BASELINE: DistributedProbeOptions = {
  mode: 'QUORUM',
  primaryCommitIndex: COMMIT,
  deadlineMs: 5_000,
  nodeTimeoutMs: 4_000,
  earlyFreeze: false,
  maxConcurrentNodes: 64,
  maxInFlightPerNode: 8,
  maxQueuedNodes: 256,
};

const OPTIMIZED: DistributedProbeOptions = {
  mode: 'QUORUM',
  primaryCommitIndex: COMMIT,
  deadlineMs: 5_000,
  nodeTimeoutMs: 4_000,
  earlyFreeze: true,
  maxConcurrentNodes: 8,
  maxInFlightPerNode: 2,
  maxQueuedNodes: 256,
};

interface Stats {
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
  return sorted[index] as number;
}

function statsOf(samples: readonly number[]): Stats {
  if (samples.length === 0) return { count: 0, minMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0, meanMs: 0 };
  const sorted = [...samples].sort((left, right) => left - right);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    minMs: sorted[0] as number,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
    maxMs: sorted[sorted.length - 1] as number,
    meanMs: sum / sorted.length,
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatStats(stats: Stats): string {
  return [stats.p50Ms, stats.p95Ms, stats.p99Ms, stats.maxMs].map((value) => String(round(value))).join(' | ');
}

function evidenceOf(answer: DistributedProbeAnswer): string {
  return JSON.stringify({
    digest: answer.metadata.evidence_digest,
    candidates: [...answer.candidates]
      .map((entry) => [entry.record_ref, entry.content_hash, entry.status])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
    commit: answer.metadata.commit_index ?? null,
    mode: answer.metadata.mode,
    consistency: answer.consistency,
  });
}

interface ScenarioResult {
  readonly arm: string;
  readonly scenario: string;
  readonly stats: Stats;
  readonly throughputPerSecond: number;
  readonly heapDeltaBytes: number;
  readonly peakGlobal: number;
  readonly peakPerNode: number;
  readonly equivalence: string;
}

async function runFastScenario(name: string, options: DistributedProbeOptions): Promise<{ result: ScenarioResult; evidence: string }> {
  const stats = instrument();
  const nodes = ['r0', 'r1', 'r2'].map((id) => replica(id, 3, stats));
  const local = new BenchStore([candidate('rec-a')]);
  const heapBefore = process.memoryUsage().heapUsed;
  const samples: number[] = [];
  let evidence = '';
  const started = performance.now();
  for (let index = 0; index < FAST_ITERATIONS; index += 1) {
    const before = performance.now();
    const answer = await distributedProbe(request(`fast-${name}-${String(index)}`), local, nodes, options);
    samples.push(performance.now() - before);
    evidence = evidenceOf(answer);
  }
  const elapsedSeconds = (performance.now() - started) / 1_000;
  return {
    evidence,
    result: {
      arm: name,
      scenario: 'fast-consistent',
      stats: statsOf(samples),
      throughputPerSecond: FAST_ITERATIONS / elapsedSeconds,
      heapDeltaBytes: process.memoryUsage().heapUsed - heapBefore,
      peakGlobal: stats.peakGlobal,
      peakPerNode: Math.max(...stats.peakPerNode.values()),
      equivalence: evidence,
    },
  };
}

async function runSlowScenario(name: string, options: DistributedProbeOptions): Promise<ScenarioResult> {
  const stats = instrument();
  const nodes = [replica('r0', 3, stats), replica('r1', 4, stats), replica('r2', 200, stats)];
  const local = new BenchStore([candidate('rec-a')]);
  const heapBefore = process.memoryUsage().heapUsed;
  const samples: number[] = [];
  let late = 0;
  const started = performance.now();
  for (let index = 0; index < SLOW_ITERATIONS; index += 1) {
    const before = performance.now();
    const answer = await distributedProbe(request(`slow-${name}-${String(index)}`), local, nodes, options);
    samples.push(performance.now() - before);
    late = answer.nodes.filter((node) => node.outcome === 'LATE_DISCARDED').length;
  }
  const elapsedSeconds = (performance.now() - started) / 1_000;
  return {
    arm: name,
    scenario: `slow-tail (late nodes last=${String(late)})`,
    stats: statsOf(samples),
    throughputPerSecond: SLOW_ITERATIONS / elapsedSeconds,
    heapDeltaBytes: process.memoryUsage().heapUsed - heapBefore,
    peakGlobal: stats.peakGlobal,
    peakPerNode: Math.max(...stats.peakPerNode.values()),
    equivalence: 'fast-quorum evidence only',
  };
}

async function runConcurrencyScenario(name: string, options: DistributedProbeOptions): Promise<ScenarioResult> {
  const stats = instrument();
  const nodes = Array.from({ length: 6 }, (_unused, index) => replica(`c${String(index)}`, 5, stats));
  const local = new BenchStore([candidate('rec-a')]);
  const heapBefore = process.memoryUsage().heapUsed;
  const samples: number[] = [];
  const started = performance.now();
  for (let batch = 0; batch < CONCURRENCY_ITERATIONS; batch += 1) {
    const before = performance.now();
    await Promise.all(Array.from({ length: CONCURRENCY_PROBES }, (_unused, index) =>
      distributedProbe(request(`conc-${name}-${String(batch)}-${String(index)}`), local, nodes, options)));
    samples.push(performance.now() - before);
  }
  const elapsedSeconds = (performance.now() - started) / 1_000;
  return {
    arm: name,
    scenario: `${String(CONCURRENCY_PROBES)} concurrent probes x 6 nodes`,
    stats: statsOf(samples),
    throughputPerSecond: (CONCURRENCY_PROBES * CONCURRENCY_ITERATIONS) / elapsedSeconds,
    heapDeltaBytes: process.memoryUsage().heapUsed - heapBefore,
    peakGlobal: stats.peakGlobal,
    peakPerNode: Math.max(...stats.peakPerNode.values()),
    equivalence: 'capped fan-out',
  };
}

const fastBaseline = await runFastScenario('baseline', BASELINE);
const fastOptimized = await runFastScenario('optimized', OPTIMIZED);
if (fastBaseline.evidence !== fastOptimized.evidence) {
  throw new Error(`fast-arm evidence diverged: ${fastBaseline.evidence} != ${fastOptimized.evidence}`);
}

const slowBaseline = await runSlowScenario('baseline', BASELINE);
const slowOptimized = await runSlowScenario('optimized', OPTIMIZED);
if (slowBaseline.stats.p50Ms < 150) {
  throw new Error(`baseline slow arm did not wait for the 200ms node: p50=${String(slowBaseline.stats.p50Ms)}`);
}
if (slowOptimized.stats.p50Ms > 120) {
  throw new Error(`optimized slow arm did not freeze early: p50=${String(slowOptimized.stats.p50Ms)}`);
}

const concurrencyBaseline = await runConcurrencyScenario('baseline', BASELINE);
const concurrencyOptimized = await runConcurrencyScenario('optimized', {
  ...OPTIMIZED,
  maxConcurrentNodes: 2,
  maxInFlightPerNode: 1,
});
if (concurrencyOptimized.peakGlobal > 2) {
  throw new Error(`global cap violated: peak=${String(concurrencyOptimized.peakGlobal)}`);
}
if (concurrencyOptimized.peakPerNode > 1) {
  throw new Error(`per-node cap violated: peak=${String(concurrencyOptimized.peakPerNode)}`);
}

const rows = [fastBaseline.result, fastOptimized.result, slowBaseline, slowOptimized, concurrencyBaseline, concurrencyOptimized];
const lines: string[] = [
  '# 分布式探针资源优化同语义对照（T-160 / MNT-04）',
  '',
  `生成时间：${new Date().toISOString()} · 平台：${process.platform}/${process.arch} · Node ${process.version}`,
  '',
  '方法：同一进程内使用相同的内存 `ProbeStore`、相同请求与提交点；baseline 关闭提前冻结并使用宽松上限，optimized 使用 T-157 默认早冻结与上限。每个样本都是本机墙钟，不包含跨机网络，不代表生产 SLA。',
  '',
  '## 1. 同语义校验',
  '',
  '| 校验项 | 结果 |',
  '|---|---|',
  `| fast-consistent 两臂 evidence_digest/candidates/commit/mode/consistency 完全一致 | ${fastBaseline.evidence === fastOptimized.evidence ? 'PASS' : 'FAIL'} |`,
  `| baseline 慢尾样本确实等待 200ms 节点（p50 >= 150ms） | ${slowBaseline.stats.p50Ms >= 150 ? 'PASS' : 'FAIL'} |`,
  `| optimized 慢尾样本提前冻结（p50 <= 120ms） | ${slowOptimized.stats.p50Ms <= 120 ? 'PASS' : 'FAIL'} |`,
  `| 并发上限生效（global <= 2, per-node <= 1） | ${concurrencyOptimized.peakGlobal <= 2 && concurrencyOptimized.peakPerNode <= 1 ? 'PASS' : 'FAIL'} |`,
  '',
  '## 2. 延迟与吞吐（毫秒；P50 | P95 | P99 | Max）',
  '',
  '| 场景 | 臂 | 样本 | P50 | P95 | P99 | Max | 吞吐/秒 | heap Δ (MiB) |',
  '|---|---|---|---|---|---|---|---|---|',
];
for (const row of rows) {
  lines.push(`| ${row.scenario} | ${row.arm} | ${String(row.stats.count)} | ${formatStats(row.stats)} | ${round(row.throughputPerSecond)} | ${round(row.heapDeltaBytes / (1024 * 1024))} |`);
}
lines.push(
  '',
  '## 3. 并发峰值与慢节点尾延迟',
  '',
  `- 并发上限臂：global peak=${String(concurrencyOptimized.peakGlobal)}，per-node peak=${String(concurrencyOptimized.peakPerNode)}；baseline global peak=${String(concurrencyBaseline.peakGlobal)}。`,
  `- 慢节点（200ms）尾延迟：baseline P50=${round(slowBaseline.stats.p50Ms)}ms / P99=${round(slowBaseline.stats.p99Ms)}ms；optimized P50=${round(slowOptimized.stats.p50Ms)}ms / P99=${round(slowOptimized.stats.p99Ms)}ms。`,
  `- 快路径（全部 3–4ms）吞吐：baseline ${round(fastBaseline.result.throughputPerSecond)}/s，optimized ${round(fastOptimized.result.throughputPerSecond)}/s；差异包含提前冻结少等一个节点与上限开销两方向，样本有限，不作容量承诺。`,
  '',
  '## 4. 边界（不得外推）',
  '',
  '- 仅内存 store，无线程/子进程/TCP；测量的是协调器调度与冻结收益，不是跨机带宽或副本 I/O。',
  '- 延迟样本来自本机单进程，未固定 CPU 频率/隔离核，也未强制 GC；heap Δ 只是数量级参考。',
  '- Windows 默认定时器粒度约 15.6ms，3–5ms 的模拟延迟会被量化到约 15ms；因此快路径绝对值不代表真实跨机 RTT，慢尾对照（200ms vs 冻结）仍是有效信号。',
  '- 并发上限以吞吐换有界负载：上限臂每个批次串行 24 个节点查询，吞吐低于不受限臂是预期结果，不是性能回退。',
  '- 提前冻结只对 COMMITTED/QUORUM 生效；QUORUM 只在 primary commit 的唯一多数派组上冻结，低提交点仍完整 gather；AS_OF 不冻结。',
  '- 迟到结果标记 `LATE_DISCARDED` 且不进入证据；这不是“忽略故障”，而是显式丢弃并保留节点报告。',
  '- 上限是有界队列加拒绝，不是动态负载均衡/EWMA/线程池；没有生产 SLA、跨机或自动故障切换声明。',
  '',
);
writeFileSync('docs/evidence/probe-lifecycle-benchmark.md', `${lines.join('\n')}\n`);
console.log(lines.slice(0, 30).join('\n'));
console.log(`\nwrote docs/evidence/probe-lifecycle-benchmark.md (${String(rows.length)} arms)`);
