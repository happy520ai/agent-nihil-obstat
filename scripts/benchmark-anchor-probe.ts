import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir, platform, arch, release, cpus, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { canonicalJson, genesisHash, hashEvent, type LedgerEvent } from '../src/ledger/event.ts';
import { encodeEvents } from '../src/ledger/segment.ts';
import { viewDigest, type ViewReplayEntry } from '../src/ledger/views.ts';
import { probe, type ProbeCandidate, type ProbeEdge } from '../src/memory/probe.ts';
import {
  ProjectedProbeStore,
  SqliteProbeStore,
  probeSnapshotIdentity,
  type ProbeStore,
} from '../src/memory/probe-store.ts';
import { BitChainProbeStore } from '../src/memory/probe-store-bitchain.ts';
import {
  ANCHOR_PROBE_REQUEST_SCHEMA_VERSION,
  type AnchorProbeRequest,
  type AnchorProbeSnapshot,
} from '../src/memory/probe-contract.ts';
import {
  classifyRelation,
  evaluateRelationCalibration,
  relationIndexFromEntries,
  type RelationCalibrationDataset,
  type RelationDecision,
  type RelationLabel,
  type RelationModelAdapter,
  type RelationRecord,
  type RelationEdge,
} from '../src/memory/relation-classifier.ts';
import { tokenizeText } from '../src/memory/tokenizer.ts';
import { Ledger } from '../src/ledger/ledger.ts';
import { memoryProbeSurface } from '../src/surface/memory.ts';
import { CONTEXT_DRAFT_SCHEMA_VERSION } from '../src/memory/context-verify.ts';
import {
  createConsumerHarness,
  createTestModel,
  type TestModelAdapter,
} from '../test/harness/anchor-probe-consumer.ts';

/**
 * AnchorProbe reproducible benchmark (T-060 / AP-23).
 *
 * Scope and honesty rules (see docs/anchor-probe-benchmark.md):
 * - The performance target is an experiment, not a promise. Every number here
 *   comes from a real run on this machine; the real production latency and the
 *   real query distribution are [数据缺失] and are not inferred.
 * - The three ProbeStore backends (Projected / Sqlite / BitChain) are measured
 *   over the SAME committed `ViewReplayEntry[]`, the SAME snapshot, the SAME
 *   budget and the SAME request set. The equivalence assertion is written into
 *   the run, so a state-management difference cannot be misread as an engine
 *   win.
 * - BitChain is never wired into the default path. The script writes its cache
 *   only under an os.tmpdir() work root and opens it explicitly.
 * - The classifier ablation reuses the public calibration API. Thresholds that
 *   are compile-time constants in `relation-classifier.ts` are reported as not
 *   sweepable without a source change (this task may not edit src/).
 * - All temporary artifacts stay under os.tmpdir().
 */

// ---------------------------------------------------------------------------
// Scales, seeds, small utilities
// ---------------------------------------------------------------------------

export type BenchmarkScale = 'smoke' | 'S' | 'M' | 'L';

interface ScaleProfile {
  readonly targetEvents: number;
  readonly governedFacts: number;
  readonly relations: number;
  readonly conflicts: number;
  readonly defaultIterations: number;
  readonly defaultE2EIters: number;
}

const SCALE_PROFILES: Readonly<Record<BenchmarkScale, ScaleProfile>> = {
  smoke: { targetEvents: 60, governedFacts: 6, relations: 10, conflicts: 1, defaultIterations: 5, defaultE2EIters: 2 },
  S: { targetEvents: 200, governedFacts: 24, relations: 36, conflicts: 1, defaultIterations: 10, defaultE2EIters: 3 },
  M: { targetEvents: 1000, governedFacts: 120, relations: 180, conflicts: 2, defaultIterations: 6, defaultE2EIters: 2 },
  L: { targetEvents: 5000, governedFacts: 600, relations: 900, conflicts: 3, defaultIterations: 4, defaultE2EIters: 1 },
};

const PROJECT_SCOPE = 'bench-fixture';
const FIXTURE_NOW = '2026-11-22T00:00:00.000Z';
const BASE_PHYSICAL_MS = 1_700_000_000_000;
const DEFAULT_PROBE_BUDGET = { max_candidates: 16, max_nodes: 12, max_depth: 3 } as const;
const WIDE_PROBE_BUDGET = { max_candidates: 64, max_nodes: 48, max_depth: 5 } as const;
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const WORD_POOL = [
  'ledger', 'storage', 'engine', 'cache', 'proxy', 'session', 'auth', 'config', 'schema',
  'view', 'index', 'queue', 'worker', 'retry', 'timeout', 'snapshot', 'digest', 'anchor',
  'graph', 'probe', 'consumer', 'manifest', 'budget', 'clock', 'segment', 'event', 'record',
];

/** Deterministic PRNG (mulberry32) so a seed reproduces the whole fixture. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic 26-char Crockford ULID from a sequence number. */
function ulidFromSeq(sequence: number): string {
  let value = sequence >>> 0;
  let encoded = '';
  for (let index = 0; index < 26; index += 1) {
    encoded = ULID_ALPHABET[value % 32] + encoded;
    value = Math.floor(value / 32);
  }
  return encoded;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

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
  const sorted = [...samples].sort((left, right) => left - right);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    minMs: round(sorted[0] ?? 0),
    p50Ms: round(percentile(sorted, 50)),
    p95Ms: round(percentile(sorted, 95)),
    p99Ms: round(percentile(sorted, 99)),
    maxMs: round(sorted[sorted.length - 1] ?? 0),
    meanMs: round(sum / (sorted.length === 0 ? 1 : sorted.length)),
  };
}

function measureSync(operation: () => void, iterations: number): LatencyStats {
  const samples: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    operation();
    samples.push(performance.now() - started);
  }
  return latencyStats(samples);
}

function memorySnapshot(): NodeJS.MemoryUsage {
  return process.memoryUsage();
}

// ---------------------------------------------------------------------------
// Synthetic committed ledger fixture
// ---------------------------------------------------------------------------

interface EventSpec {
  readonly event: LedgerEvent;
  readonly segment: 'main' | 'raceA' | 'raceB';
}

interface FixtureTruth {
  /** Answerable fact key -> the active head record ref the probe must return. */
  readonly answerable: Readonly<Record<string, string>>;
  readonly conflicted: readonly string[];
  readonly missing: readonly string[];
  /** Retracted fact key -> the retracted head record ref. */
  readonly retracted: Readonly<Record<string, string>>;
  /** Records that a correct, bounded answer may legitimately surface. */
  readonly truthRefs: readonly string[];
}

interface FixtureComposition {
  readonly totalEvents: number;
  readonly memoryRevised: number;
  readonly noteRecorded: number;
  readonly memoryRelated: number;
  readonly segments: number;
  readonly governedFacts: number;
  readonly conflictedFacts: number;
  readonly legacyNotes: number;
  readonly confirmedEdges: number;
}

export interface BenchmarkFixture {
  readonly scale: BenchmarkScale;
  readonly seed: number;
  readonly entries: readonly ViewReplayEntry[];
  readonly snapshot: AnchorProbeSnapshot;
  readonly viewDigest: string;
  readonly truth: FixtureTruth;
  readonly requests: readonly AnchorProbeRequest[];
  readonly composition: FixtureComposition;
  readonly requiredFacts: string[];
}

class FixtureBuilder {
  readonly seed: number;
  readonly rng: () => number;
  readonly events: EventSpec[] = [];
  readonly factHeads = new Map<string, string>();
  readonly factStatus = new Map<string, 'active' | 'retracted' | 'conflicted'>();
  readonly governedRefs: string[] = [];
  readonly conflictedRefs: string[] = [];
  readonly edges: Array<{ from: string; to: string; kind: string }> = [];
  readonly relationKeys = new Set<string>();
  #seq = 0;
  #physical: number;

  constructor(seed: number) {
    this.seed = seed;
    this.rng = mulberry32(seed);
    this.#physical = BASE_PHYSICAL_MS;
  }

  #nextId(): string {
    const id = ulidFromSeq(this.#seq);
    this.#seq += 1;
    return id;
  }

  #push(segment: EventSpec['segment'], kind: LedgerEvent['kind'], payload: Record<string, unknown>, idemKey?: string): LedgerEvent {
    const event: LedgerEvent = {
      id: this.#nextId(),
      hlc: { physical: this.#physical, logical: 0, actor: 'bench-fixture' },
      actor: 'bench-fixture',
      kind,
      payload,
      ...(idemKey === undefined ? {} : { idem_key: idemKey }),
      prev_hash: genesisHash,
    };
    this.#physical += 1;
    this.events.push({ event, segment });
    return event;
  }

  #anchor(index: number): Record<string, unknown> {
    return { file: `src/module-${index}.ts`, qualifiedName: `symbol${index}` };
  }

  #text(prefix: string, index: number): string {
    const a = WORD_POOL[Math.floor(this.rng() * WORD_POOL.length)]!;
    const b = WORD_POOL[Math.floor(this.rng() * WORD_POOL.length)]!;
    const c = WORD_POOL[Math.floor(this.rng() * WORD_POOL.length)]!;
    return `${prefix} ${index}: the ${a} ${b} governs the ${c} behavior.`;
  }

  genesis(factKey: string, index: number): string {
    const event = this.#push('main', 'memory.revised', {
      intent: 'revise',
      fact_key: factKey,
      record: { kind: 'decision', text: this.#text('Decision', index), anchor: this.#anchor(index) },
      supersedes: [],
      reason: `genesis ${factKey}`,
      effective_from: null,
      effective_to: null,
    }, `idem:revise:${factKey}:genesis`);
    this.factHeads.set(factKey, event.id);
    this.factStatus.set(factKey, 'active');
    this.governedRefs.push(event.id);
    return event.id;
  }

  revise(factKey: string, priorRef: string, index: number): string {
    const event = this.#push('main', 'memory.revised', {
      intent: 'revise',
      fact_key: factKey,
      record: { kind: 'decision', text: this.#text('Revision', index), anchor: this.#anchor(index) },
      supersedes: [priorRef],
      reason: `revise ${factKey}`,
      effective_from: null,
      effective_to: null,
    }, `idem:revise:${factKey}:${priorRef}`);
    this.factHeads.set(factKey, event.id);
    this.factStatus.set(factKey, 'active');
    this.governedRefs.push(event.id);
    return event.id;
  }

  retract(factKey: string, headRef: string): void {
    this.#push('main', 'memory.revised', {
      intent: 'retract',
      fact_key: factKey,
      supersedes: [headRef],
      reason: `retract ${factKey}`,
    }, `idem:retract:${factKey}:${headRef}`);
    this.factStatus.set(factKey, 'retracted');
  }

  /** Two revisions racing on the same prior, committed in two segments. */
  fork(factKey: string, genesisRef: string, index: number): void {
    const branchA = this.#push('raceA', 'memory.revised', {
      intent: 'revise',
      fact_key: factKey,
      record: { kind: 'decision', text: this.#text('Branch A', index), anchor: this.#anchor(index) },
      supersedes: [genesisRef],
      reason: `branch A ${factKey}`,
      effective_from: null,
      effective_to: null,
    }, `idem:revise:${factKey}:branchA`);
    const branchB = this.#push('raceB', 'memory.revised', {
      intent: 'revise',
      fact_key: factKey,
      record: { kind: 'decision', text: this.#text('Branch B', index), anchor: this.#anchor(index) },
      supersedes: [genesisRef],
      reason: `branch B ${factKey}`,
      effective_from: null,
      effective_to: null,
    }, `idem:revise:${factKey}:branchB`);
    this.factStatus.set(factKey, 'conflicted');
    this.governedRefs.push(branchA.id, branchB.id);
    this.conflictedRefs.push(branchA.id, branchB.id);
  }

  relate(fromRef: string, toRef: string): void {
    if (fromRef === toRef) return;
    const kinds = ['depends_on', 'explains', 'related_to'] as const;
    const kind = kinds[Math.floor(this.rng() * kinds.length)]!;
    const key = `${fromRef}|${toRef}|${kind}`;
    if (this.relationKeys.has(key)) return;
    this.relationKeys.add(key);
    this.#push('main', 'memory.related', {
      edge: kind,
      from_ref: fromRef,
      to_ref: toRef,
      reason: 'benchmark relation',
    }, `idem:relate:${key}`);
    this.edges.push({ from: fromRef, to: toRef, kind });
  }

  note(index: number): void {
    const text = this.#text('Note', index);
    this.#push('main', 'note.recorded', {
      note_id: sha256Hex(`bench-note:${this.seed}:${index}:${text}`),
      kind: 'memory',
      text,
      created_at: new Date(BASE_PHYSICAL_MS + index).toISOString(),
      anchor: this.#anchor(index),
    });
  }
}

function chainSegment(events: readonly LedgerEvent[]): LedgerEvent[] {
  let previous = genesisHash;
  return events.map((event) => {
    const chained: LedgerEvent = { ...event, prev_hash: previous };
    previous = hashEvent(chained);
    return chained;
  });
}

/**
 * Build the deterministic fixture. The event order is: every `main` event in
 * creation order, then the `raceA` branch events, then the `raceB` branch
 * events. HLC timestamps follow that order, so replay sees each fork's genesis
 * (main) before branch A (raceA) before branch B (raceB).
 */
export function buildFixture(scale: BenchmarkScale, seed: number): BenchmarkFixture {
  const profile = SCALE_PROFILES[scale];
  const builder = new FixtureBuilder(seed);

  // Governed facts: genesis plus probabilistic linear revisions / retractions.
  const factKeys: string[] = [];
  for (let index = 0; index < profile.governedFacts; index += 1) {
    const factKey = `local.fact.${index}`;
    factKeys.push(factKey);
    const genesisRef = builder.genesis(factKey, index);
    if (builder.rng() < 0.5) {
      const revisionRef = builder.revise(factKey, genesisRef, index + 1_000);
      if (builder.rng() < 0.2) builder.retract(factKey, revisionRef);
    } else if (builder.rng() < 0.15) {
      builder.retract(factKey, genesisRef);
    }
  }

  // Conflicted facts: a real two-segment race on one prior.
  const conflictedFacts: string[] = [];
  for (let index = 0; index < profile.conflicts; index += 1) {
    const factKey = `local.conflict.${index}`;
    conflictedFacts.push(factKey);
    const genesisRef = builder.genesis(factKey, index + 5_000);
    builder.fork(factKey, genesisRef, index + 5_000);
  }

  // Confirmed relations among non-conflicted governed records only: a relation
  // in the main segment must resolve when it is replayed, before the race
  // segments are applied.
  const conflictedRefSet = new Set(builder.conflictedRefs);
  const relationPool = builder.governedRefs.filter((ref) => !conflictedRefSet.has(ref));
  let relationsCreated = 0;
  let attempts = 0;
  while (relationsCreated < profile.relations && attempts < profile.relations * 20) {
    attempts += 1;
    const from = relationPool[Math.floor(builder.rng() * relationPool.length)];
    const to = relationPool[Math.floor(builder.rng() * relationPool.length)];
    if (from === undefined || to === undefined) break;
    const before = builder.edges.length;
    builder.relate(from, to);
    if (builder.edges.length > before) relationsCreated += 1;
  }

  // Pad with legacy notes so the scale target is met exactly. Notes are cheap,
  // deterministic and keep the governed/legacy mix explicit.
  const notesNeeded = profile.targetEvents - builder.events.length;
  for (let index = 0; index < notesNeeded; index += 1) builder.note(index + 9_000);
  if (builder.events.length !== profile.targetEvents) {
    throw new Error(`fixture for scale ${scale} produced ${builder.events.length} events, expected ${profile.targetEvents}`);
  }

  const ordered: EventSpec[] = [
    ...builder.events.filter((item) => item.segment === 'main'),
    ...builder.events.filter((item) => item.segment === 'raceA'),
    ...builder.events.filter((item) => item.segment === 'raceB'),
  ];
  const segmentNames: Readonly<Record<EventSpec['segment'], string>> = {
    main: 'bench-main.jsonl',
    raceA: 'bench-race-a.jsonl',
    raceB: 'bench-race-b.jsonl',
  };
  const bySegment = new Map<string, LedgerEvent[]>();
  for (const item of ordered) {
    const name = segmentNames[item.segment];
    const list = bySegment.get(name) ?? [];
    list.push(item.event);
    bySegment.set(name, list);
  }
  const entries: ViewReplayEntry[] = [];
  for (const [name, events] of bySegment) {
    for (const event of chainSegment(events)) entries.push({ event, segment: name });
  }

  const snapshot: AnchorProbeSnapshot = {
    project_scope: PROJECT_SCOPE,
    ledger_digest: viewDigest(entries),
    graph_revision: null,
    source_fingerprint: null,
    connected_digest: null,
  };

  // Request set: answerable + conflicted + missing + retracted facts.
  const answerable: Record<string, string> = {};
  for (const factKey of factKeys) {
    if (Object.keys(answerable).length >= 4) break;
    const status = builder.factStatus.get(factKey);
    const head = builder.factHeads.get(factKey);
    if (status === 'active' && head !== undefined) answerable[factKey] = head;
  }
  const retracted: Record<string, string> = {};
  for (const factKey of factKeys) {
    if (Object.keys(retracted).length >= 1) break;
    const status = builder.factStatus.get(factKey);
    const head = builder.factHeads.get(factKey);
    if (status === 'retracted' && head !== undefined) retracted[factKey] = head;
  }
  const missing = ['local.missing.alpha', 'local.missing.beta'];
  const requiredFacts = [...new Set([
    ...Object.keys(answerable),
    ...conflictedFacts,
    ...Object.keys(retracted),
    ...missing,
  ])];

  const truthRefs = new Set<string>(Object.values(answerable));
  for (const edge of builder.edges) {
    if (truthRefs.has(edge.from)) truthRefs.add(edge.to);
    if (truthRefs.has(edge.to)) truthRefs.add(edge.from);
  }

  const composition: FixtureComposition = {
    totalEvents: entries.length,
    memoryRevised: entries.filter((entry) => entry.event.kind === 'memory.revised').length,
    noteRecorded: entries.filter((entry) => entry.event.kind === 'note.recorded').length,
    memoryRelated: entries.filter((entry) => entry.event.kind === 'memory.related').length,
    segments: bySegment.size,
    governedFacts: factKeys.length,
    conflictedFacts: conflictedFacts.length,
    legacyNotes: entries.filter((entry) => entry.event.kind === 'note.recorded').length,
    confirmedEdges: builder.edges.length,
  };

  const requests: AnchorProbeRequest[] = [
    {
      schema_version: ANCHOR_PROBE_REQUEST_SCHEMA_VERSION,
      request_id: 'bench-req-default',
      root: 'bench-placeholder',
      project_scope: PROJECT_SCOPE,
      required_facts: requiredFacts,
      temporal_mode: 'CURRENT',
      budget: { ...DEFAULT_PROBE_BUDGET },
    },
    {
      schema_version: ANCHOR_PROBE_REQUEST_SCHEMA_VERSION,
      request_id: 'bench-req-wide',
      root: 'bench-placeholder',
      project_scope: PROJECT_SCOPE,
      required_facts: requiredFacts,
      temporal_mode: 'CURRENT',
      budget: { ...WIDE_PROBE_BUDGET },
    },
  ];

  return {
    scale,
    seed,
    entries,
    snapshot,
    viewDigest: viewDigest(entries),
    truth: {
      answerable,
      conflicted: conflictedFacts,
      missing,
      retracted,
      truthRefs: [...truthRefs],
    },
    requests,
    composition,
    requiredFacts,
  };
}

// ---------------------------------------------------------------------------
// Quality metrics (each formula is documented next to the field)
// ---------------------------------------------------------------------------

export interface QualityMetrics {
  readonly request_id: string;
  readonly evidenceCount: number;
  readonly tombstoneCount: number;
  /** answerable facts whose expected active head appears in active_evidence / answerable facts. */
  readonly entryRecall: number | null;
  /** active_evidence record_refs inside truthRefs / active_evidence length. */
  readonly entryPrecision: number | null;
  /** true when the probe stopped before exhausting the frontier or hit a bound. */
  readonly truncated: boolean;
  /** expected conflicted fact keys absent from response.conflicts. */
  readonly conflictMiss: number;
  /** response conflict fact keys absent from the expected conflicted set. */
  readonly conflictFalse: number;
  /** answerable expected heads that appear in deprecated_tombstones. */
  readonly wronglyDeprecated: number;
  /** active_evidence records whose status is superseded/retracted. */
  readonly staleUse: number;
  /** l1 invariants violated + coverage-gate contract violations. */
  readonly constraintViolations: number;
  /** answerable facts with their head in evidence and no unresolved conflict. */
  readonly validAnswers: number;
  readonly coverageStatus: string;
  readonly stopReason: string;
  readonly completeness: string;
}

const TRUNCATING_STOP_REASONS = new Set(['BUDGET_EXHAUSTED', 'DEPTH_LIMIT', 'TIMEOUT', 'ENTRY_NOT_FOUND', 'ERROR']);

function computeQuality(request: AnchorProbeRequest, response: ReturnType<typeof probe>, truth: FixtureTruth): QualityMetrics {
  const evidenceRefs = new Set(response.active_evidence.map((item) => item.record_ref));
  const answerableEntries = Object.entries(truth.answerable);
  const recalled = answerableEntries.filter(([, head]) => evidenceRefs.has(head)).length;
  const precisionDenominator = response.active_evidence.length;
  const precisionNumerator = response.active_evidence.filter((item) => truth.truthRefs.includes(item.record_ref)).length;
  const reportedConflicts = new Set(response.conflicts.map((conflict) => conflict.fact_key));
  const expectedConflicts = new Set(truth.conflicted);
  const tombstoneRefs = new Set(response.deprecated_tombstones.map((item) => item.record_ref));
  const wronglyDeprecated = answerableEntries.filter(([, head]) => tombstoneRefs.has(head)).length;
  const staleUse = response.active_evidence.filter((item) => item.status === 'superseded' || item.status === 'retracted').length;
  const invariantViolations = response.l1_invariants.filter((item) => item.status === 'violated').length;
  const coverageViolation =
    (response.coverage_gate.status === 'SUFFICIENT' && response.coverage_gate.missing_facts.length > 0 ? 1 : 0)
    + (response.budget_status.retrieval_completeness === 'COMPLETE_WITHIN_DECLARED_SCOPE'
      && TRUNCATING_STOP_REASONS.has(response.budget_status.stop_reason) ? 1 : 0);
  const validAnswers = answerableEntries.filter(([factKey, head]) =>
    evidenceRefs.has(head) && !reportedConflicts.has(factKey)).length;
  const truncated = response.budget_status.retrieval_completeness !== 'COMPLETE_WITHIN_DECLARED_SCOPE'
    || TRUNCATING_STOP_REASONS.has(response.budget_status.stop_reason);
  void request;
  return {
    request_id: request.request_id,
    evidenceCount: response.active_evidence.length,
    tombstoneCount: response.deprecated_tombstones.length,
    entryRecall: answerableEntries.length === 0 ? null : round(recalled / answerableEntries.length, 4),
    entryPrecision: precisionDenominator === 0 ? null : round(precisionNumerator / precisionDenominator, 4),
    truncated,
    conflictMiss: [...expectedConflicts].filter((key) => !reportedConflicts.has(key)).length,
    conflictFalse: [...reportedConflicts].filter((key) => !expectedConflicts.has(key)).length,
    wronglyDeprecated,
    staleUse,
    constraintViolations: invariantViolations + coverageViolation,
    validAnswers,
    coverageStatus: response.coverage_gate.status,
    stopReason: response.budget_status.stop_reason,
    completeness: response.budget_status.retrieval_completeness,
  };
}

// ---------------------------------------------------------------------------
// Backend construction and retrieval measurement
// ---------------------------------------------------------------------------

export type BackendKey = 'projected' | 'sqlite' | 'bitchain' | 'surface';

interface BackendRuntime {
  readonly store: ProbeStore;
  readonly close: () => void;
  readonly rebuildMs: number;
  readonly diskBytes: number;
  readonly rssDeltaBytes: number;
  readonly fileBytes: number;
}

interface RetrievalRow {
  readonly backend: BackendKey;
  readonly label: string;
  readonly recordCount: number;
  readonly edgeCount: number;
  readonly rebuildMs: number;
  readonly diskBytes: number;
  readonly rssDeltaBytes: number;
  readonly candidatesAll: LatencyStats;
  readonly candidatesRouted: LatencyStats;
  readonly adjacencyAll: LatencyStats;
  readonly adjacencyRef: LatencyStats;
  readonly evidenceRef: LatencyStats;
  readonly statusRef: LatencyStats;
  readonly provenanceRef: LatencyStats;
  readonly probeFull: LatencyStats;
  readonly quality: readonly QualityMetrics[];
}

interface EquivalenceReport {
  readonly snapshotFingerprintEqual: boolean;
  readonly candidatesEqual: boolean;
  readonly adjacencyEqual: boolean;
  readonly probeResponsesEqual: boolean;
  readonly recordCounts: Readonly<Record<string, number>>;
  readonly mismatches: readonly string[];
}

function buildProjected(fixture: BenchmarkFixture): BackendRuntime {
  const before = memorySnapshot();
  const started = performance.now();
  const store = ProjectedProbeStore.create(fixture.entries, fixture.snapshot);
  const rebuildMs = performance.now() - started;
  return { store, close: () => store.close(), rebuildMs: round(rebuildMs), diskBytes: 0, rssDeltaBytes: memorySnapshot().rss - before.rss, fileBytes: 0 };
}

function buildSqlite(fixture: BenchmarkFixture, root: string): BackendRuntime {
  const before = memorySnapshot();
  const started = performance.now();
  const store = SqliteProbeStore.open(root);
  store.rebuild(fixture.entries, fixture.snapshot);
  const rebuildMs = performance.now() - started;
  const path = SqliteProbeStore.databasePath(root);
  const fileBytes = existsSync(path) ? statSync(path).size : 0;
  return { store, close: () => store.close(), rebuildMs: round(rebuildMs), diskBytes: fileBytes, rssDeltaBytes: memorySnapshot().rss - before.rss, fileBytes };
}

function buildBitChain(fixture: BenchmarkFixture, root: string): BackendRuntime {
  const before = memorySnapshot();
  const started = performance.now();
  const path = BitChainProbeStore.databasePath(root);
  BitChainProbeStore.write(path, fixture.entries, fixture.snapshot);
  const store = BitChainProbeStore.open(path);
  const rebuildMs = performance.now() - started;
  const fileBytes = existsSync(path) ? statSync(path).size : 0;
  return { store, close: () => store.close(), rebuildMs: round(rebuildMs), diskBytes: fileBytes, rssDeltaBytes: memorySnapshot().rss - before.rss, fileBytes };
}

function assertEquivalence(fixture: BenchmarkFixture, runtimes: Readonly<Record<'projected' | 'sqlite' | 'bitchain', BackendRuntime>>): EquivalenceReport {
  const mismatches: string[] = [];
  const stores = [runtimes.projected.store, runtimes.sqlite.store, runtimes.bitchain.store];
  const fingerprints = stores.map((store) => store.snapshotIdentity().fingerprint);
  const snapshotFingerprintEqual = fingerprints.every((value) => value === fingerprints[0]);
  if (!snapshotFingerprintEqual) mismatches.push('snapshot fingerprint differs across backends');

  const candidateBlobs = stores.map((store) => canonicalJson(store.candidates({})));
  const candidatesEqual = candidateBlobs.every((value) => value === candidateBlobs[0]);
  if (!candidatesEqual) mismatches.push('candidates({}) differs across backends');

  const adjacencyBlobs = stores.map((store) => canonicalJson(store.adjacency()));
  const adjacencyEqual = adjacencyBlobs.every((value) => value === adjacencyBlobs[0]);
  if (!adjacencyEqual) mismatches.push('adjacency() differs across backends');

  const responseBlobs = stores.map((store) =>
    fixture.requests.map((request) => canonicalJson(probe(request, store))));
  const probeResponsesEqual = responseBlobs.every((value) => canonicalJson(value) === canonicalJson(responseBlobs[0]));
  if (!probeResponsesEqual) mismatches.push('probe() response differs across backends');

  return {
    snapshotFingerprintEqual,
    candidatesEqual,
    adjacencyEqual,
    probeResponsesEqual,
    recordCounts: {
      projected: runtimes.projected.store.candidates({}).length,
      sqlite: runtimes.sqlite.store.candidates({}).length,
      bitchain: runtimes.bitchain.store.candidates({}).length,
    },
    mismatches,
  };
}

function measureStoreBackend(
  fixture: BenchmarkFixture,
  key: 'projected' | 'sqlite' | 'bitchain',
  runtime: BackendRuntime,
  iterations: number,
): RetrievalRow {
  const store = runtime.store;
  const candidatesAll = measureSync(() => { store.candidates({}); }, iterations);
  const candidatesRouted = measureSync(() => {
    for (const factKey of fixture.requiredFacts) store.candidates({ fact_key: factKey });
  }, iterations);
  const adjacencyAll = measureSync(() => { store.adjacency(); }, iterations);
  const sampleRefs = store.candidates({}).slice(0, 8).map((item) => item.record_ref);
  const adjacencyRef = measureSync(() => {
    for (const ref of sampleRefs) store.adjacency(ref);
  }, iterations);
  const evidenceRef = measureSync(() => {
    for (const ref of sampleRefs) store.evidence(ref);
  }, iterations);
  const statusRef = measureSync(() => {
    for (const ref of sampleRefs) store.status(ref);
  }, iterations);
  const provenanceRef = measureSync(() => {
    for (const ref of sampleRefs) store.provenance(ref);
  }, iterations);
  const probeFull = measureSync(() => {
    for (const request of fixture.requests) probe(request, store);
  }, iterations);
  const quality = fixture.requests.map((request) => computeQuality(request, probe(request, store), fixture.truth));
  return {
    backend: key,
    label: key,
    recordCount: store.candidates({}).length,
    edgeCount: store.adjacency().length,
    rebuildMs: runtime.rebuildMs,
    diskBytes: runtime.diskBytes,
    rssDeltaBytes: runtime.rssDeltaBytes,
    candidatesAll,
    candidatesRouted,
    adjacencyAll,
    adjacencyRef,
    evidenceRef,
    statusRef,
    provenanceRef,
    probeFull,
    quality,
  };
}

// ---------------------------------------------------------------------------
// Classifier ablation
// ---------------------------------------------------------------------------

interface ClassifierLayerSummary {
  readonly evaluated: number;
  readonly definitive: number;
  readonly needs_review: number;
  readonly abstention_rate: number | null;
  readonly accuracy: number | null;
  readonly false_supersede: number;
  readonly missed_relation: number;
  readonly wrong_pass: number;
  readonly wrong_block: number;
  readonly overconfident_definitive: number;
  readonly by_label: Readonly<Record<string, number>>;
}

function summarizeLayer(metrics: {
  evaluated: number;
  definitive: number;
  needs_review: number;
  abstention_rate: number | null;
  accuracy: number | null;
  false_supersede: number;
  missed_relation: number;
  wrong_pass: number;
  wrong_block: number;
  overconfident_definitive: number;
  by_label: Readonly<Record<RelationLabel, number>>;
}): ClassifierLayerSummary {
  return {
    evaluated: metrics.evaluated,
    definitive: metrics.definitive,
    needs_review: metrics.needs_review,
    abstention_rate: metrics.abstention_rate === null ? null : round(metrics.abstention_rate, 4),
    accuracy: metrics.accuracy === null ? null : round(metrics.accuracy, 4),
    false_supersede: metrics.false_supersede,
    missed_relation: metrics.missed_relation,
    wrong_pass: metrics.wrong_pass,
    wrong_block: metrics.wrong_block,
    overconfident_definitive: metrics.overconfident_definitive,
    by_label: { ...metrics.by_label },
  };
}

/** Mirrors `buildLayerMetrics` in relation-classifier.ts; formulas documented there. */
function summarizeDecisions(layer: string, entries: ReadonlyArray<{ expected: RelationLabel | 'needs_review'; decision: RelationDecision }>): ClassifierLayerSummary {
  const byLabel: Record<RelationLabel, number> = { unrelated: 0, continuation: 0, cross_link: 0, supersede_candidate: 0 };
  let definitive = 0;
  let needsReview = 0;
  let correct = 0;
  let falseSupersede = 0;
  let missedRelation = 0;
  let wrongPass = 0;
  let wrongBlock = 0;
  let overconfident = 0;
  for (const entry of entries) {
    const truth = entry.expected;
    const decision = entry.decision;
    if (decision.label === null) {
      needsReview += 1;
      continue;
    }
    definitive += 1;
    byLabel[decision.label] += 1;
    if (decision.label === truth) correct += 1;
    if (truth === 'needs_review') overconfident += 1;
    else if (decision.label === 'supersede_candidate' && truth !== 'supersede_candidate') falseSupersede += 1;
    else if (decision.label === 'unrelated' && truth !== 'unrelated') {
      missedRelation += 1;
      if (truth === 'supersede_candidate') wrongBlock += 1;
    } else if (decision.label !== 'unrelated' && truth === 'unrelated') wrongPass += 1;
  }
  const evaluated = entries.length;
  void layer;
  return {
    evaluated,
    definitive,
    needs_review: needsReview,
    abstention_rate: evaluated === 0 ? null : round(needsReview / evaluated, 4),
    accuracy: definitive === 0 ? null : round(correct / definitive, 4),
    false_supersede: falseSupersede,
    missed_relation: missedRelation,
    wrong_pass: wrongPass,
    wrong_block: wrongBlock,
    overconfident_definitive: overconfident,
    by_label: byLabel,
  };
}

function loadRelationDataset(): RelationCalibrationDataset {
  const path = fileURLToPath(new URL('../test/fixtures/anchor-probe-relations.json', import.meta.url));
  const raw = JSON.parse(readFileSync(path, 'utf8')) as {
    name: string;
    cases: Array<{
      id: string;
      expected: string;
      source: RelationRecord;
      target: RelationRecord;
      edges?: Array<{ from_ref: string; to_ref: string; kind: RelationEdge['kind'] }>;
    }>;
  };
  return {
    name: raw.name,
    cases: raw.cases.map((item) => ({
      id: item.id,
      expected: item.expected as RelationLabel | 'needs_review',
      source: item.source,
      target: item.target,
      ...(item.edges === undefined ? {} : { edges: item.edges }),
    })),
  };
}

/** Scripted imperfect model: misses explicit supersede proposals, abstains on needs_review, otherwise agrees. */
const imperfectModel: RelationModelAdapter = {
  name: 'bench-scripted-imperfect-model',
  classify: ({ source, target, rule }) => {
    if (source.explicit?.supersedes?.includes(target.record_ref) === true) {
      return { label: 'unrelated', confidence: 0.9, reason: 'model_misses_supersede' };
    }
    if (rule.label === null) return { label: null, confidence: null, reason: 'model_abstain' };
    return { label: rule.label, confidence: 0.8, reason: 'model_agrees' };
  },
};

interface BudgetTierResult {
  readonly label: string;
  readonly budget: Readonly<Record<string, number>>;
  readonly layer: ClassifierLayerSummary;
  readonly selection: {
    readonly considered: number;
    readonly candidates: number;
    readonly truncatedCases: number;
    readonly noCandidateCases: number;
    readonly targetDropped: number;
  };
}

export interface ClassifierAblation {
  readonly dataset: { readonly name: string; readonly size: number };
  readonly ruleOnly: ClassifierLayerSummary;
  readonly thresholdSweep: ReadonlyArray<{ readonly low_confidence_threshold: number; readonly layer: ClassifierLayerSummary }>;
  readonly modelLayer: ClassifierLayerSummary | null;
  readonly modelName: string | null;
  readonly budgetTiers: readonly BudgetTierResult[];
  readonly supersedeThresholdProbe: {
    readonly constant: 0.75;
    readonly sameFactProposedActiveSameKind: number;
    readonly atOrAboveConstant: number;
    readonly belowConstant: number;
    readonly observedLabels: Readonly<Record<string, number>>;
    readonly note: string;
  };
  readonly tokenEstimate: {
    readonly modelComparisons: number;
    readonly estimatedTokens: number;
    readonly formula: string;
  };
  readonly notes: readonly string[];
}

async function runClassifierAblation(dataset: RelationCalibrationDataset): Promise<ClassifierAblation> {
  const now = FIXTURE_NOW;
  const ruleOnlyReport = await evaluateRelationCalibration(dataset, { now });
  const ruleOnly = summarizeLayer(ruleOnlyReport.rule_layer);

  const thresholds = [0.6, 0.7, 0.75, 0.8];
  const thresholdSweep: Array<{ low_confidence_threshold: number; layer: ClassifierLayerSummary }> = [];
  for (const threshold of thresholds) {
    const report = await evaluateRelationCalibration(dataset, { low_confidence_threshold: threshold, now });
    thresholdSweep.push({ low_confidence_threshold: threshold, layer: summarizeLayer(report.rule_layer) });
  }

  const modelReport = await evaluateRelationCalibration(dataset, { model: imperfectModel, now });
  const modelLayer = modelReport.model_layer === null ? null : summarizeLayer(modelReport.model_layer);

  // Budget tiers go through classifyRelation (the calibration API is pair-level
  // and does not accept a budget). The metric formulas mirror buildLayerMetrics.
  const indexEntries: RelationRecord[] = [];
  const indexEdges: Array<{ from_ref: string; to_ref: string; kind: 'depends_on' | 'explains' | 'related_to' | 'supersedes' | 'conflicts_with' | 'unknown' }> = [];
  for (const item of dataset.cases) {
    indexEntries.push(item.source, item.target);
    for (const edge of item.edges ?? []) {
      indexEdges.push({ from_ref: edge.from_ref, to_ref: edge.to_ref, kind: edge.kind as RelationEdge['kind'] });
    }
  }
  const index = relationIndexFromEntries(indexEntries, indexEdges);
  const budgetTiers: BudgetTierResult[] = [];
  const tierSpecs: Array<{ label: string; budget: Readonly<Record<string, number>> }> = [
    { label: 'tight', budget: { max_candidates: 4, max_per_fact_key: 2, max_lexical_matches: 4, max_model_comparisons: 2 } },
    { label: 'default', budget: {} },
    { label: 'wide', budget: { max_candidates: 32, max_per_fact_key: 8, max_lexical_matches: 64, max_model_comparisons: 16 } },
  ];
  for (const spec of tierSpecs) {
    const entries: Array<{ expected: RelationLabel | 'needs_review'; decision: RelationDecision }> = [];
    let considered = 0;
    let candidates = 0;
    let truncatedCases = 0;
    let noCandidateCases = 0;
    let targetDropped = 0;
    for (const item of dataset.cases) {
      const result = await classifyRelation(item.source, index, { budget: spec.budget, scope: item.source.scope });
      considered += result.selection.considered;
      candidates += result.selection.candidates.length;
      if (result.selection.truncated) truncatedCases += 1;
      const targetIndex = result.selection.candidates.findIndex((candidate) => candidate.record_ref === item.target.record_ref);
      if (result.selection.candidates.length === 0) noCandidateCases += 1;
      if (targetIndex < 0) {
        // The true target never entered the bounded candidate slice, so the
        // classifier had no chance to label it. This is the budget effect the
        // tier comparison is meant to expose.
        targetDropped += 1;
        continue;
      }
      const decision = result.decisions[targetIndex] ?? result.rule_decisions[targetIndex];
      if (decision === undefined) {
        targetDropped += 1;
        continue;
      }
      entries.push({ expected: item.expected, decision });
    }
    budgetTiers.push({
      label: spec.label,
      budget: { ...spec.budget },
      layer: summarizeDecisions(spec.label, entries),
      selection: {
        considered,
        candidates,
        truncatedCases,
        noCandidateCases,
        targetDropped,
      },
    });
  }

  // The supersede heuristic threshold (0.75) is a compile-time constant. This
  // probe measures where the fixture's same-fact proposed/active/same-kind pairs
  // fall relative to it, rather than pretending a sweep that the public API
  // cannot perform.
  const observedLabels: Record<string, number> = {};
  let sameFactPairs = 0;
  let atOrAbove = 0;
  let below = 0;
  for (const item of dataset.cases) {
    const { source, target } = item;
    if (source.status !== 'proposed' || target.status !== 'active' || source.fact_key === null || source.fact_key !== target.fact_key || source.kind === null || source.kind !== target.kind) continue;
    sameFactPairs += 1;
    const left = new Set(tokenizeText(source.text));
    const right = new Set(tokenizeText(target.text));
    let intersection = 0;
    for (const token of left) if (right.has(token)) intersection += 1;
    const union = left.size + right.size - intersection;
    const lexical = union === 0 ? 0 : intersection / union;
    if (lexical >= 0.75) atOrAbove += 1;
    else below += 1;
    const label = lexical >= 0.75 ? 'supersede_candidate' : 'continuation';
    observedLabels[label] = (observedLabels[label] ?? 0) + 1;
  }

  const comparisons = dataset.cases.length;
  const averageChars = dataset.cases.reduce((total, item) => total + item.source.text.length + item.target.text.length, 0) / Math.max(1, dataset.cases.length);
  const perCallTokens = Math.ceil((averageChars + 120) / 4);
  const estimatedTokens = comparisons * perCallTokens;

  return {
    dataset: { name: dataset.name, size: dataset.cases.length },
    ruleOnly,
    thresholdSweep,
    modelLayer,
    modelName: modelReport.model?.name ?? null,
    budgetTiers,
    supersedeThresholdProbe: {
      constant: 0.75,
      sameFactProposedActiveSameKind: sameFactPairs,
      atOrAboveConstant: atOrAbove,
      belowConstant: below,
      observedLabels,
      note: 'HEURISTIC_SUPERSEDE_THRESHOLD (0.75) is a compile-time constant in src/memory/relation-classifier.ts; a full sweep requires a source change outside this task\'s file boundary.',
    },
    tokenEstimate: {
      modelComparisons: comparisons,
      estimatedTokens,
      formula: 'comparisons * ceil((average source+target chars + 120 prompt-overhead chars) / 4); tokens are an estimate, not a measured model bill.',
    },
    notes: [
      'The dataset is synthetic calibration material; these metrics are not accuracy claims about any real model.',
      'The model layer is a scripted imperfect adapter, not a real model.',
      'thresholdSweep varies the public low_confidence_threshold only; the 0.75 supersede constant is not exposed.',
      'budgetTiers use classifyRelation because evaluateRelationCalibration is pair-level and accepts no budget.',
    ],
  };
}

// ---------------------------------------------------------------------------
// End-to-end harness (probe -> manifest -> verify -> consumer)
// ---------------------------------------------------------------------------

interface EndToEndResult {
  readonly scale: BenchmarkScale;
  readonly iterations: number;
  readonly outcome: string;
  readonly probeMs: LatencyStats;
  readonly manifestFreezeReadMs: LatencyStats;
  readonly endToEndMs: LatencyStats;
  /** Proxy: p50 of the Surface probe call, i.e. time to a response carrying evidence. */
  readonly ttftMs: number | null;
  readonly retries: number;
  readonly modelCalls: number;
  readonly probeRuns: number;
  readonly resamples: number;
  readonly verifyCallsUsed: number;
  readonly tokenEstimate: {
    readonly modelCalls: number;
    readonly estimatedTokens: number;
    readonly formula: string;
  };
  readonly notes: readonly string[];
}

function writeLedgerRoot(root: string, entries: readonly ViewReplayEntry[]): void {
  const directory = join(root, '.ano', 'ledger');
  mkdirSync(directory, { recursive: true });
  const bySegment = new Map<string, LedgerEvent[]>();
  for (const entry of entries) {
    const list = bySegment.get(entry.segment) ?? [];
    list.push(entry.event);
    bySegment.set(entry.segment, list);
  }
  for (const [name, events] of bySegment) {
    writeFileSync(join(directory, name), encodeEvents(events));
  }
}

function removeTempRoot(root: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= 9) {
        console.warn(`benchmark: temp root not removable (kept for inspection): ${root} — ${String(error)}`);
        return;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

async function runEndToEnd(
  fixture: BenchmarkFixture,
  workRoot: string,
  iterations: number,
): Promise<EndToEndResult> {
  const root = join(workRoot, 'ledger');
  mkdirSync(root, { recursive: true });
  writePackageJson(root);
  writeLedgerRoot(root, fixture.entries);

  const ledger = await Ledger.open(root, { sessionId: 'bench-e2e', clock: () => BASE_PHYSICAL_MS + fixture.entries.length + 1_000 });
  const harness = createConsumerHarness({
    ledger,
    projectScope: PROJECT_SCOPE,
    now: FIXTURE_NOW,
    sampler: () => fixture.snapshot,
  });
  const model: TestModelAdapter = createTestModel({
    generate: (input) => {
      const evidence = input.response.active_evidence[0];
      const factKey = input.request.required_facts?.[0] ?? 'local.fact.0';
      return {
        schema_version: CONTEXT_DRAFT_SCHEMA_VERSION,
        context_id: input.manifest.context_id,
        project_scope: input.manifest.project_scope,
        claims: evidence === undefined ? [] : [{
          id: 'C1',
          kind: 'CURRENT_FACT',
          fact_key: factKey,
          text: evidence.content,
          evidence_refs: [evidence.ref],
          params: [],
        }],
        not_applicable: [],
        unresolved: [],
      };
    },
  });

  const request: AnchorProbeRequest = {
    schema_version: ANCHOR_PROBE_REQUEST_SCHEMA_VERSION,
    request_id: 'bench-e2e-req',
    root,
    project_scope: PROJECT_SCOPE,
    required_facts: fixture.requiredFacts,
    temporal_mode: 'CURRENT',
    budget: { ...DEFAULT_PROBE_BUDGET },
  };

  const probeSamples: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    memoryProbeSurface(ledger, request, { snapshot: fixture.snapshot, now: FIXTURE_NOW });
    probeSamples.push(performance.now() - started);
  }

  const manifestSamples: number[] = [];
  const response = memoryProbeSurface(ledger, request, { snapshot: fixture.snapshot, now: FIXTURE_NOW });
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    const frozen = harness.store.freeze({ request, response, now: FIXTURE_NOW });
    harness.store.read(frozen.context_id, PROJECT_SCOPE, { now: FIXTURE_NOW });
    manifestSamples.push(performance.now() - started);
  }

  const e2eSamples: number[] = [];
  let lastResult: Awaited<ReturnType<typeof harness.run>> | null = null;
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    lastResult = await harness.run({ request, model });
    e2eSamples.push(performance.now() - started);
  }

  const result = lastResult!;
  const probeStats = latencyStats(probeSamples);
  const manifestStats = latencyStats(manifestSamples);
  const e2eStats = latencyStats(e2eSamples);
  const modelCalls = model.generateCalls.length;
  const averageEvidenceChars = response.active_evidence.reduce((total, item) => total + item.content.length, 0) / Math.max(1, response.active_evidence.length);
  const estimatedTokens = modelCalls * Math.ceil((averageEvidenceChars + 200) / 4);

  ledger.close();
  removeTempRoot(root);

  return {
    scale: fixture.scale,
    iterations,
    outcome: result.outcome,
    probeMs: probeStats,
    manifestFreezeReadMs: manifestStats,
    endToEndMs: e2eStats,
    ttftMs: probeStats.p50Ms,
    retries: 0,
    modelCalls,
    probeRuns: harness.probe.runCount,
    resamples: harness.probe.sampleCount,
    verifyCallsUsed: result.budget.verify_calls_used,
    tokenEstimate: {
      modelCalls,
      estimatedTokens,
      formula: 'modelCalls * ceil((average evidence content chars + 200 prompt-overhead chars) / 4); tokens are an estimate, not a measured model bill.',
    },
    notes: [
      'The harness uses the real memoryProbeSurface + ProbeManifestStore + context-verify + runConsumer path.',
      'The snapshot sampler is fixed to the fixture snapshot, so no Connect/network path is exercised.',
      'TTFT is a proxy: the p50 wall-clock of the synchronous Surface probe call, not a streaming first-byte time.',
      'retries is 0 because no remote model or network call is made.',
    ],
  };
}

function writePackageJson(root: string): void {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'anchor-probe-bench', private: true, type: 'module' }));
}

// ---------------------------------------------------------------------------
// Benchmark orchestration
// ---------------------------------------------------------------------------

export interface BenchmarkOptions {
  readonly scale: BenchmarkScale;
  readonly seed: number;
  readonly iterations: number;
  readonly e2eIterations: number;
  readonly skipEndToEnd?: boolean;
  readonly workRoot?: string;
}

export interface BenchmarkResult {
  readonly schema: 'anchorprobe.benchmark.v1';
  readonly generatedAt: string;
  readonly command: string;
  readonly scale: BenchmarkScale;
  readonly seed: number;
  readonly environment: Record<string, unknown>;
  readonly fixture: {
    readonly viewDigest: string;
    readonly snapshotFingerprint: string;
    readonly requiredFacts: readonly string[];
    readonly composition: FixtureComposition;
  };
  readonly equivalence: EquivalenceReport;
  readonly retrieval: readonly RetrievalRow[];
  readonly classifier: ClassifierAblation;
  readonly endToEnd: EndToEndResult | null;
  readonly cost: {
    readonly rssBeforeBytes: number;
    readonly rssAfterBytes: number;
    readonly rssDeltaBytes: number;
    readonly diskBytes: Readonly<Record<string, number>>;
    readonly rebuildMs: Readonly<Record<string, number>>;
    readonly tokenEstimate: {
      readonly classifier: number;
      readonly endToEnd: number | null;
    };
  };
  readonly limitations: readonly string[];
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

export async function runBenchmark(options: BenchmarkOptions): Promise<BenchmarkResult> {
  const fixture = buildFixture(options.scale, options.seed);
  const profile = SCALE_PROFILES[options.scale];
  const iterations = options.iterations > 0 ? options.iterations : profile.defaultIterations;
  const e2eIterations = options.e2eIterations > 0 ? options.e2eIterations : profile.defaultE2EIters;

  const workRoot = options.workRoot ?? mkdtempSync(join(tmpdir(), 'ano-anchor-probe-bench-'));
  const storeRoot = join(workRoot, 'stores');
  const rssBefore = memorySnapshot().rss;

  const projected = buildProjected(fixture);
  const sqlite = buildSqlite(fixture, storeRoot);
  const bitchain = buildBitChain(fixture, storeRoot);

  const equivalence = assertEquivalence(fixture, { projected, sqlite, bitchain });

  const retrieval: RetrievalRow[] = [
    measureStoreBackend(fixture, 'projected', projected, iterations),
    measureStoreBackend(fixture, 'sqlite', sqlite, iterations),
    measureStoreBackend(fixture, 'bitchain', bitchain, iterations),
  ];

  // The real default Surface path over a real ledger. It is measured separately
  // because it rebuilds the projection on every call and filters conflicted
  // records, so its response is not deep-equal to the ProbeStore backends.
  let surfaceRow: RetrievalRow | null = null;
  let endToEnd: EndToEndResult | null = null;
  if (options.skipEndToEnd !== true) {
    const root = join(workRoot, 'ledger');
    mkdirSync(root, { recursive: true });
    writePackageJson(root);
    writeLedgerRoot(root, fixture.entries);
    const ledger = await Ledger.open(root, { sessionId: 'bench-surface', clock: () => BASE_PHYSICAL_MS + fixture.entries.length + 1_000 });
    try {
      const requests = fixture.requests.map((request) => ({ ...request, root }));
      // The Surface path does not expose sub-operation timings, so the row
      // reports the full Surface probe call in every latency column and says so
      // in the notes. Record/edge counts come from the same projection the
      // Surface path reads.
      const probeFull = measureSync(() => {
        for (const request of requests) memoryProbeSurface(ledger, request, { snapshot: fixture.snapshot, now: FIXTURE_NOW });
      }, iterations);
      const quality = requests.map((request) => computeQuality(
        request,
        memoryProbeSurface(ledger, request, { snapshot: fixture.snapshot, now: FIXTURE_NOW }),
        fixture.truth,
      ));
      surfaceRow = {
        backend: 'surface',
        label: 'surface-default',
        recordCount: projected.store.candidates({}).length,
        edgeCount: projected.store.adjacency().length,
        rebuildMs: 0,
        diskBytes: 0,
        rssDeltaBytes: 0,
        candidatesAll: probeFull,
        candidatesRouted: probeFull,
        adjacencyAll: probeFull,
        adjacencyRef: probeFull,
        evidenceRef: probeFull,
        statusRef: probeFull,
        provenanceRef: probeFull,
        probeFull,
        quality,
      };
      retrieval.push(surfaceRow);
    } finally {
      ledger.close();
    }

    endToEnd = await runEndToEnd(fixture, workRoot, e2eIterations);
  }

  const classifier = await runClassifierAblation(loadRelationDataset());
  const rssAfter = memorySnapshot().rss;

  projected.close();
  sqlite.close();
  bitchain.close();

  if (options.workRoot === undefined) removeTempRoot(workRoot);

  return {
    schema: 'anchorprobe.benchmark.v1',
    generatedAt: new Date().toISOString(),
    command: 'node scripts/benchmark-anchor-probe.ts',
    scale: options.scale,
    seed: options.seed,
    environment: environmentRecord(),
    fixture: {
      viewDigest: fixture.viewDigest,
      snapshotFingerprint: probeSnapshotIdentity(fixture.snapshot).fingerprint,
      requiredFacts: fixture.requiredFacts,
      composition: fixture.composition,
    },
    equivalence,
    retrieval,
    classifier,
    endToEnd,
    cost: {
      rssBeforeBytes: rssBefore,
      rssAfterBytes: rssAfter,
      rssDeltaBytes: rssAfter - rssBefore,
      diskBytes: {
        sqlite: sqlite.fileBytes,
        bitchain: bitchain.fileBytes,
        projected: 0,
      },
      rebuildMs: {
        projected: projected.rebuildMs,
        sqlite: sqlite.rebuildMs,
        bitchain: bitchain.rebuildMs,
      },
      tokenEstimate: {
        classifier: classifier.tokenEstimate.estimatedTokens,
        endToEnd: endToEnd?.tokenEstimate.estimatedTokens ?? null,
      },
    },
    limitations: [
      'Single local machine, single process; timings are not statistically robust and are not a production latency claim.',
      'Real production latency and the real query distribution are [数据缺失]; no target was assumed before measuring.',
      'The classifier model layer is a scripted imperfect adapter, not a real model; token figures are estimates with an explicit formula.',
      'The Surface default path is measured on a synthetic committed fixture, not on a real client ledger.',
      'BitChain is measured as an explicit experimental backend only; it is not wired into the default path.',
      'No forced GC; RSS deltas are Node process observations and are noisy.',
    ],
  };
}

// ---------------------------------------------------------------------------
// Consistency across repeated runs
// ---------------------------------------------------------------------------

interface ConsistencyReport {
  readonly runs: number;
  readonly deterministicEqual: boolean;
  readonly timingWithinBand: boolean;
  readonly compared: ReadonlyArray<{ readonly label: string; readonly left: number; readonly right: number; readonly ratio: number | null }>;
  readonly mismatches: readonly string[];
}

function compareRuns(left: BenchmarkResult, right: BenchmarkResult): ConsistencyReport {
  const mismatches: string[] = [];
  if (left.fixture.viewDigest !== right.fixture.viewDigest) mismatches.push('fixture viewDigest differs');
  if (canonicalJson(left.equivalence) !== canonicalJson(right.equivalence)) mismatches.push('equivalence report differs');
  if (canonicalJson(left.classifier) !== canonicalJson(right.classifier)) mismatches.push('classifier metrics differ');
  const leftQuality = canonicalJson(left.retrieval.map((row) => row.quality));
  const rightQuality = canonicalJson(right.retrieval.map((row) => row.quality));
  if (leftQuality !== rightQuality) mismatches.push('retrieval quality metrics differ');

  const compared: Array<{ label: string; left: number; right: number; ratio: number | null }> = [];
  const leftProbe = new Map(left.retrieval.map((row) => [row.backend, row.probeFull.p50Ms]));
  const rightProbe = new Map(right.retrieval.map((row) => [row.backend, row.probeFull.p50Ms]));
  for (const [backend, leftValue] of leftProbe) {
    const rightValue = rightProbe.get(backend);
    if (rightValue === undefined) continue;
    const ratio = leftValue === 0 || rightValue === 0 ? null : round(Math.max(leftValue, rightValue) / Math.min(leftValue, rightValue), 3);
    compared.push({ label: `${backend}.probeFull.p50Ms`, left: leftValue, right: rightValue, ratio });
  }
  if (left.endToEnd !== null && right.endToEnd !== null) {
    const leftValue = left.endToEnd.endToEndMs.p50Ms;
    const rightValue = right.endToEnd.endToEndMs.p50Ms;
    const ratio = leftValue === 0 || rightValue === 0 ? null : round(Math.max(leftValue, rightValue) / Math.min(leftValue, rightValue), 3);
    compared.push({ label: 'endToEnd.p50Ms', left: leftValue, right: rightValue, ratio });
  }
  const timingWithinBand = compared.every((item) => item.ratio === null || item.ratio <= 2.5);
  if (!timingWithinBand) mismatches.push('a timing p50 differed by more than 2.5x between runs');
  return {
    runs: 2,
    deterministicEqual: mismatches.length === 0,
    timingWithinBand,
    compared,
    mismatches,
  };
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

function formatLatency(stats: LatencyStats): string {
  return `p50 ${stats.p50Ms} / p95 ${stats.p95Ms} / p99 ${stats.p99Ms} / max ${stats.maxMs} ms`;
}

function renderMarkdown(result: BenchmarkResult, consistency: ConsistencyReport | null): string {
  const lines: string[] = [];
  lines.push('# AnchorProbe 基准报告（T-060 / AP-23）');
  lines.push('');
  lines.push(`- 生成时间：${result.generatedAt}`);
  lines.push(`- 命令：\`${result.command} --scale ${result.scale} --seed ${result.seed}\``);
  lines.push(`- 环境：node ${String(result.environment.node)} / ${String(result.environment.platform)} ${String(result.environment.arch)} ${String(result.environment.release)} / ${String(result.environment.cpuModel)} x${String(result.environment.cpuCount)}`);
  lines.push(`- 夹具：${result.fixture.composition.totalEvents} 事件（memory.revised ${result.fixture.composition.memoryRevised} / note.recorded ${result.fixture.composition.noteRecorded} / memory.related ${result.fixture.composition.memoryRelated}），${result.fixture.composition.segments} 段，受治理事实 ${result.fixture.composition.governedFacts}，冲突事实 ${result.fixture.composition.conflictedFacts}。viewDigest=${result.fixture.viewDigest.slice(0, 16)}…`);
  lines.push(`- 同语义对照：snapshot=${result.equivalence.snapshotFingerprintEqual} / candidates=${result.equivalence.candidatesEqual} / adjacency=${result.equivalence.adjacencyEqual} / probe 响应=${result.equivalence.probeResponsesEqual}`);
  lines.push('');
  lines.push('## 1. 检索后端对照（同 ViewReplayEntry[] / 同 snapshot / 同预算 / 同请求集）');
  lines.push('');
  lines.push('| 后端 | 记录数 | 边数 | 重建 ms | 磁盘 B | candidates({}) | adjacency() | evidence(ref) | probe 全程 |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const row of result.retrieval) {
    lines.push(`| ${row.label} | ${row.recordCount} | ${row.edgeCount} | ${row.rebuildMs} | ${row.diskBytes} | ${formatLatency(row.candidatesAll)} | ${formatLatency(row.adjacencyAll)} | ${formatLatency(row.evidenceRef)} | ${formatLatency(row.probeFull)} |`);
  }
  lines.push('');
  lines.push('说明：`surface-default` 是真实 Surface 路径（每次调用重建投影并过滤 conflicted 记录、注入 fork），因此它的响应与三个 ProbeStore 后端不是 deep-equal；同语义断言只针对 projected/sqlite/bitchain 三个后端。');
  lines.push('');
  lines.push('## 2. 检索质量（按夹具真值）');
  lines.push('');
  lines.push('| 后端 | 请求 | 入口召回 | 入口精确 | 截断 | 冲突漏报 | 冲突误报 | 错误废弃 | 过时使用 | 约束违反 | 有效回答 |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const row of result.retrieval) {
    for (const quality of row.quality) {
      lines.push(`| ${row.label} | ${quality.request_id} | ${quality.entryRecall ?? 'n/a'} | ${quality.entryPrecision ?? 'n/a'} | ${quality.truncated} | ${quality.conflictMiss} | ${quality.conflictFalse} | ${quality.wronglyDeprecated} | ${quality.staleUse} | ${quality.constraintViolations} | ${quality.validAnswers} |`);
    }
  }
  lines.push('');
  lines.push('## 3. 分类器消融（22 案例合成标注集）');
  lines.push('');
  lines.push('| 档位 | 判定数 | needs_review | 弃权率 | 准确率 | 误废弃 | 漏召 | 错误放行 | 错误替代 | 过度自信 |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  const classifier = result.classifier;
  const pushRow = (label: string, layer: ClassifierLayerSummary): void => {
    lines.push(`| ${label} | ${layer.definitive} | ${layer.needs_review} | ${layer.abstention_rate ?? 'n/a'} | ${layer.accuracy ?? 'n/a'} | ${layer.wrong_block} | ${layer.missed_relation} | ${layer.wrong_pass} | ${layer.false_supersede} | ${layer.overconfident_definitive} |`);
  };
  pushRow('rule-only (阈值 0.5)', classifier.ruleOnly);
  for (const sweep of classifier.thresholdSweep) pushRow(`阈值 ${String(sweep.low_confidence_threshold)}`, sweep.layer);
  if (classifier.modelLayer !== null) pushRow(`model (${classifier.modelName ?? 'scripted'})`, classifier.modelLayer);
  for (const tier of classifier.budgetTiers) pushRow(`budget:${tier.label}`, tier.layer);
  lines.push('');
  lines.push(`预算档位选择统计：${classifier.budgetTiers.map((tier) => `${tier.label} considered=${tier.selection.considered} candidates=${tier.selection.candidates} truncatedCases=${tier.selection.truncatedCases} noCandidateCases=${tier.selection.noCandidateCases} targetDropped=${tier.selection.targetDropped}`).join('；')}。`);
  lines.push('');
  lines.push(`替代阈值探针（常量 0.75）：同事实 proposed/active 同 kind 对 ${classifier.supersedeThresholdProbe.sameFactProposedActiveSameKind} 个，其中 >=0.75 的 ${classifier.supersedeThresholdProbe.atOrAboveConstant} 个、<0.75 的 ${classifier.supersedeThresholdProbe.belowConstant} 个。${classifier.supersedeThresholdProbe.note}`);
  lines.push('');
  lines.push('## 4. 端到端（harness：probe→manifest→verify→consumer）');
  lines.push('');
  if (result.endToEnd === null) {
    lines.push('未运行（--skip-e2e）。');
  } else {
    const e2e = result.endToEnd;
    lines.push(`- 档位：${e2e.scale}；迭代 ${e2e.iterations}；outcome=${e2e.outcome}`);
    lines.push(`- Surface probe：${formatLatency(e2e.probeMs)}`);
    lines.push(`- manifest freeze+read：${formatLatency(e2e.manifestFreezeReadMs)}`);
    lines.push(`- 端到端：${formatLatency(e2e.endToEndMs)}；TTFT 代理 p50=${e2e.ttftMs ?? 'n/a'} ms；重试 ${e2e.retries}；模型调用 ${e2e.modelCalls}；verify 调用 ${e2e.verifyCallsUsed}`);
  }
  lines.push('');
  lines.push('## 5. 成本');
  lines.push('');
  lines.push(`- RSS：before ${result.cost.rssBeforeBytes} B / after ${result.cost.rssAfterBytes} B / delta ${result.cost.rssDeltaBytes} B（未强制 GC）`);
  lines.push(`- 磁盘：sqlite ${result.cost.diskBytes.sqlite} B / bitchain ${result.cost.diskBytes.bitchain} B / projected 0 B`);
  lines.push(`- 重建 ms：projected ${result.cost.rebuildMs.projected} / sqlite ${result.cost.rebuildMs.sqlite} / bitchain ${result.cost.rebuildMs.bitchain}`);
  lines.push(`- token 估算：分类器 ${result.cost.tokenEstimate.classifier} / 端到端 ${result.cost.tokenEstimate.endToEnd ?? 'n/a'}（估算口径见 JSON tokenEstimate.formula）`);
  lines.push('');
  lines.push('## 6. 一致性（连续两次运行）');
  lines.push('');
  if (consistency === null) {
    lines.push('未启用（--runs 1）。');
  } else {
    lines.push(`- 确定性字段一致：${consistency.deterministicEqual}；时延在噪声带内：${consistency.timingWithinBand}`);
    lines.push('| 指标 | 第一次 | 第二次 | 比值 |');
    lines.push('|---|---|---|---|');
    for (const item of consistency.compared) {
      lines.push(`| ${item.label} | ${item.left} | ${item.right} | ${item.ratio ?? 'n/a'} |`);
    }
    for (const mismatch of consistency.mismatches) lines.push(`- 不一致：${mismatch}`);
  }
  lines.push('');
  lines.push('## 7. 限制与移交');
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
  e2eIterations: number;
  runs: number;
  jsonPath: string | null;
  mdPath: string | null;
  skipEndToEnd: boolean;
}

function parseCli(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    scale: 'S',
    seed: 20_261_122,
    iterations: 0,
    e2eIterations: 0,
    runs: 1,
    jsonPath: null,
    mdPath: null,
    skipEndToEnd: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--scale') {
      const value = argv[index + 1];
      if (value !== 'smoke' && value !== 'S' && value !== 'M' && value !== 'L') throw new Error(`unknown scale ${value}`);
      options.scale = value;
      index += 1;
    } else if (arg === '--seed') {
      options.seed = Number(argv[index + 1]);
      index += 1;
    } else if (arg === '--iterations') {
      options.iterations = Number(argv[index + 1]);
      index += 1;
    } else if (arg === '--e2e-iterations') {
      options.e2eIterations = Number(argv[index + 1]);
      index += 1;
    } else if (arg === '--runs') {
      options.runs = Number(argv[index + 1]);
      index += 1;
    } else if (arg === '--json') {
      options.jsonPath = argv[index + 1]!;
      index += 1;
    } else if (arg === '--md') {
      options.mdPath = argv[index + 1]!;
      index += 1;
    } else if (arg === '--skip-e2e') {
      options.skipEndToEnd = true;
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  const results: BenchmarkResult[] = [];
  for (let run = 0; run < options.runs; run += 1) {
    results.push(await runBenchmark({
      scale: options.scale,
      seed: options.seed,
      iterations: options.iterations,
      e2eIterations: options.e2eIterations,
      skipEndToEnd: options.skipEndToEnd,
    }));
  }
  const primary = results[0]!;
  const consistency = results.length > 1 ? compareRuns(results[0]!, results[1]!) : null;
  const markdown = renderMarkdown(primary, consistency);
  const json = `${JSON.stringify({ ...primary, consistency }, null, 2)}\n`;
  // Default artifacts stay under os.tmpdir(); this repository's docs file is
  // written by the task, not by the runner.
  const defaultDirectory = join(tmpdir(), 'ano-anchor-probe-benchmark');
  const jsonPath = options.jsonPath ?? join(defaultDirectory, `benchmark-${options.scale}.json`);
  const mdPath = options.mdPath ?? join(defaultDirectory, `benchmark-${options.scale}.md`);
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, json);
  writeFileSync(mdPath, markdown);
  process.stdout.write(markdown);
  process.stdout.write(`\nJSON 写入：${jsonPath}\nMD 写入：${mdPath}\n`);
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await main();
}
