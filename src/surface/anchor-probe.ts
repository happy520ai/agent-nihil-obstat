import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRoot, assertSafeRelative } from '../connect/paths.ts';
import { connectionStatus } from '../connect/index.ts';
import { CONNECT_NOTICE } from '../connect/read.ts';
import type { ConnectedTask } from '../connect/types.ts';
import { replayLedger } from '../ledger/replay.ts';
import { viewDigest, type LedgerNote } from '../ledger/views.ts';
import { Ledger } from '../ledger/ledger.ts';
import { GraphStore } from '../structure/store.ts';
import type { GraphSnapshot, SymbolNode } from '../structure/types.ts';
import { HistoryStore } from '../memory/store.ts';
import type { RecallHit } from '../memory/types.ts';
import { anchorSourceFromGraph, resolveAnchor, type AnchorSource, type MemoryAnchor } from '../memory/anchor.ts';
import {
  deriveProbeContextId,
  probe,
  type ProbeAnchorHealth,
  type ProbeCandidate,
  type ProbeCandidateSource,
  type ProbeEdge,
  type ProbeEntryQuery,
} from '../memory/probe.ts';
import {
  ANCHOR_PROBE_CONTEXT_SCHEMA_VERSION,
  anchorProbeEvidenceSchema,
  anchorProbeRequestSchema,
  anchorProbeResponseSchema,
  type AnchorProbeBudgetStatus,
  type AnchorProbeConflict,
  type AnchorProbeCoverageGate,
  type AnchorProbeEvidence,
  type AnchorProbeGap,
  type AnchorProbeInvariant,
  type AnchorProbeRequest,
  type AnchorProbeResponse,
  type AnchorProbeSnapshot,
  type AnchorProbeSourceHealth,
  type AnchorProbeTombstone,
} from '../memory/probe-contract.ts';

/**
 * AnchorProbe read-only Surface (P0 / AP-04).
 *
 * Responsibilities of this module:
 *   - bind an explicit canonical root, project scope and request id;
 *   - sample the ledger commit digest, graph revision/source fingerprint and
 *     the authorized Connect digest before and after the probe core runs;
 *   - re-sample a bounded number of times when a component changes and report
 *     `SNAPSHOT_UNSTABLE` when it keeps changing;
 *   - verify the digest of every file the core actually read;
 *   - refuse evidence whose source path escapes the bound root.
 *
 * It never writes ledger events, never changes the default tool shapes and
 * does not wire a new MCP tool. The retrieval core is an injected port so the
 * P0 integration can connect the AP-03 core without this file owning it.
 */

/** Default bound on how many times a changed snapshot may be re-sampled. */
export const DEFAULT_PROBE_RESAMPLE_ATTEMPTS = 2;

export interface AnchorProbeUsedFile {
  /** Project-relative path; absolute paths and `..` are rejected. */
  readonly path: string;
  /** Lowercase sha256 of the exact bytes the core read. */
  readonly sha256: string;
}

export interface AnchorProbeConnectSample {
  readonly connected: boolean;
  readonly sourceDigest: string | null;
  /** Connect imports are always read-only and unverified. */
  readonly unverified: true;
  readonly notice: string;
  readonly error?: string;
}

export interface AnchorProbeSnapshotSample {
  readonly snapshot: AnchorProbeSnapshot;
  /** Graph content hashes by project-relative path; empty when no graph cache exists. */
  readonly fileHashes: Readonly<Record<string, string>>;
  readonly connect: AnchorProbeConnectSample;
  readonly graphFreshness: string | null;
}

export interface AnchorProbeSnapshotSampler {
  sample(root: string, projectScope: string): Promise<AnchorProbeSnapshotSample>;
}

export interface AnchorProbeReadSources {
  /** Read a project-relative file as text; undefined when unreadable. */
  readFile(path: string): string | undefined;
  /** Lowercase sha256 of a project-relative file; undefined when unreadable. */
  fileSha256(path: string): string | undefined;
}

export interface AnchorProbeCoreContext {
  readonly request: AnchorProbeRequest;
  readonly root: string;
  readonly snapshot: AnchorProbeSnapshot;
  readonly connect: AnchorProbeConnectSample;
  readonly sources: AnchorProbeReadSources;
}

/**
 * The retrieval core port. AP-03 owns the implementation; the surface only
 * validates the returned shape and the paths it claims to have read.
 */
export interface AnchorProbeCoreResult {
  /** Defaults to `OK`; a core may report `DEGRADED` or `FAILED` honestly. */
  readonly execution_status?: 'OK' | 'DEGRADED' | 'FAILED';
  readonly budget_status: AnchorProbeBudgetStatus;
  readonly coverage_gate: AnchorProbeCoverageGate;
  readonly l1_invariants: readonly AnchorProbeInvariant[];
  readonly active_evidence: readonly AnchorProbeEvidence[];
  readonly deprecated_tombstones: readonly AnchorProbeTombstone[];
  readonly gaps: readonly AnchorProbeGap[];
  readonly conflicts: readonly AnchorProbeConflict[];
  readonly used_files: readonly AnchorProbeUsedFile[];
}

export type AnchorProbeCore = (context: AnchorProbeCoreContext) => Promise<AnchorProbeCoreResult>;

export interface AnchorProbeStoredContext {
  readonly context_id: string;
  readonly root: string;
  readonly project_scope: string;
  readonly snapshot: AnchorProbeSnapshot;
}

export type AnchorProbeContextLookup = (contextId: string) => AnchorProbeStoredContext | undefined;

export interface AnchorProbeSurfaceOptions {
  readonly sampler?: AnchorProbeSnapshotSampler;
  readonly core?: AnchorProbeCore;
  /** P2 will own persistent manifests; P0 accepts an injected lookup only. */
  readonly contexts?: AnchorProbeContextLookup;
  readonly maxResampleAttempts?: number;
  readonly resampleDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface AnchorProbeSurfaceResult {
  readonly response: AnchorProbeResponse;
  readonly connect: AnchorProbeConnectSample;
  /** How many re-samples happened before the snapshot settled. */
  readonly resamples: number;
  readonly graphFreshness: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sha256File(path: string): string | undefined {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return undefined;
  }
}

/**
 * Full commit digest of the append-only ledger. A missing ledger directory is
 * the deterministic empty digest, never a fabricated commit point.
 */
function sampleLedgerDigest(root: string): string {
  const directory = join(root, '.ano', 'ledger');
  if (!existsSync(directory)) return viewDigest([]);
  return viewDigest(replayLedger(directory).entries);
}

async function sampleGraph(root: string): Promise<{ revision: string | null; fingerprint: string | null; fileHashes: Record<string, string>; freshness: string | null }> {
  const database = join(root, '.ano', 'cache', 'graph.db');
  if (!existsSync(database)) return { revision: null, fingerprint: null, fileHashes: {}, freshness: null };
  const graph = await GraphStore.open(root);
  try {
    const snapshot = graph.snapshot();
    const fileHashes: Record<string, string> = {};
    for (const file of Object.values(snapshot.files)) fileHashes[file.path] = file.hash;
    return {
      revision: snapshot.revision || null,
      fingerprint: snapshot.sourceFingerprint || null,
      fileHashes,
      freshness: graph.freshness().status,
    };
  } finally {
    graph.close();
  }
}

async function sampleConnect(root: string): Promise<AnchorProbeConnectSample> {
  try {
    const status = await connectionStatus(root);
    const current = status.connections[0];
    return {
      connected: status.connected,
      sourceDigest: current?.sourceDigest ?? null,
      unverified: true,
      notice: status.notice,
    };
  } catch (error) {
    return {
      connected: false,
      sourceDigest: null,
      unverified: true,
      notice: CONNECT_NOTICE,
      error: errorMessage(error),
    };
  }
}

/** Real adapters over the committed ledger, the structure graph and Connect. */
export const anchorProbeSnapshotSampler: AnchorProbeSnapshotSampler = {
  async sample(root, projectScope) {
    const graph = await sampleGraph(root);
    const connect = await sampleConnect(root);
    return {
      snapshot: {
        project_scope: projectScope,
        ledger_digest: sampleLedgerDigest(root),
        graph_revision: graph.revision,
        source_fingerprint: graph.fingerprint,
        connected_digest: connect.connected ? connect.sourceDigest : null,
      },
      fileHashes: graph.fileHashes,
      connect,
      graphFreshness: graph.freshness,
    };
  },
};

function snapshotEqual(left: AnchorProbeSnapshot, right: AnchorProbeSnapshot): boolean {
  return left.project_scope === right.project_scope
    && left.ledger_digest === right.ledger_digest
    && left.graph_revision === right.graph_revision
    && left.source_fingerprint === right.source_fingerprint
    && left.connected_digest === right.connected_digest;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolveDone) => setTimeout(resolveDone, ms));
}

/**
 * Snapshot-only core used until the AP-03 retrieval core is connected. It
 * returns no evidence and therefore reports required facts as missing; it
 * never fabricates a complete retrieval.
 */
export const snapshotOnlyProbeCore: AnchorProbeCore = async ({ request }) => {
  const required = request.required_facts ?? [];
  return {
    budget_status: {
      stop_reason: 'FRONTIER_EXHAUSTED',
      retrieval_completeness: required.length > 0 ? 'UNKNOWN' : 'COMPLETE_WITHIN_DECLARED_SCOPE',
      nodes_visited: 0,
      frontier_remaining: 0,
    },
    coverage_gate: {
      status: required.length > 0 ? 'INSUFFICIENT' : 'UNKNOWN',
      required_facts: required,
      missing_facts: required,
      unresolved_conflicts: [],
      requirements_origin: request.required_facts ? 'caller_declared' : 'unknown',
    },
    l1_invariants: [],
    active_evidence: [],
    deprecated_tombstones: [],
    gaps: required.map((fact_key) => ({ fact_key, reason: 'missing' as const })),
    conflicts: [],
    used_files: [],
  };
};

function readSources(root: string): AnchorProbeReadSources {
  return {
    readFile: (path) => {
      let safe: string;
      try {
        safe = assertSafeRelative(path);
      } catch {
        return undefined;
      }
      try {
        return readFileSync(join(root, safe), 'utf8');
      } catch {
        return undefined;
      }
    },
    fileSha256: (path) => {
      let safe: string;
      try {
        safe = assertSafeRelative(path);
      } catch {
        return undefined;
      }
      return sha256File(join(root, safe));
    },
  };
}

/**
 * Validate the core result before it is trusted: unique aliases, schema-valid
 * evidence, and source paths that stay inside the bound root. A forged or
 * cross-root path throws instead of being reported as evidence.
 */
function validateCoreResult(result: AnchorProbeCoreResult): void {
  const refs = new Set<string>();
  for (const evidence of result.active_evidence) {
    anchorProbeEvidenceSchema.parse(evidence);
    if (refs.has(evidence.ref)) throw new Error(`Duplicate AnchorProbe evidence alias ${evidence.ref}`);
    refs.add(evidence.ref);
    if (evidence.source.path !== undefined) assertSafeRelative(evidence.source.path);
  }
  for (const tombstone of result.deprecated_tombstones) {
    if (refs.has(tombstone.ref)) throw new Error(`Duplicate AnchorProbe evidence alias ${tombstone.ref}`);
    refs.add(tombstone.ref);
  }
  const seenFiles = new Set<string>();
  for (const file of result.used_files) {
    const safe = assertSafeRelative(file.path);
    if (seenFiles.has(safe)) throw new Error(`Duplicate AnchorProbe used file ${safe}`);
    seenFiles.add(safe);
    if (!/^[a-f0-9]{64}$/u.test(file.sha256)) throw new Error(`AnchorProbe used file ${safe} has a non-sha256 digest`);
  }
}

/**
 * Re-hash every file the core read. A missing file, a changed file, or a file
 * whose current content no longer matches the sampled graph hash means the
 * snapshot no longer covers the evidence that was read.
 */
function usedFilesDrifted(result: AnchorProbeCoreResult, sample: AnchorProbeSnapshotSample, root: string): boolean {
  for (const file of result.used_files) {
    const safe = assertSafeRelative(file.path);
    const actual = sha256File(join(root, safe));
    if (actual === undefined || actual !== file.sha256) return true;
    const graphHash = sample.fileHashes[safe];
    if (graphHash !== undefined && graphHash !== actual) return true;
  }
  return false;
}

function baseResponse(request: AnchorProbeRequest, sample: AnchorProbeSnapshotSample): Omit<AnchorProbeResponse, 'context_id'> {
  return {
    schema_version: ANCHOR_PROBE_CONTEXT_SCHEMA_VERSION,
    request_id: request.request_id,
    snapshot: sample.snapshot,
    execution_status: 'OK',
    temporal_mode: request.temporal_mode,
    budget_status: {
      stop_reason: 'FRONTIER_EXHAUSTED',
      retrieval_completeness: 'UNKNOWN',
      nodes_visited: 0,
      frontier_remaining: 0,
    },
    coverage_gate: {
      status: 'UNKNOWN',
      required_facts: request.required_facts ?? [],
      missing_facts: [],
      unresolved_conflicts: [],
      requirements_origin: request.required_facts ? 'caller_declared' : 'unknown',
    },
    l1_invariants: [],
    active_evidence: [],
    deprecated_tombstones: [],
    gaps: [],
    conflicts: [],
    untrusted: true,
  };
}

function coreResponse(request: AnchorProbeRequest, sample: AnchorProbeSnapshotSample, coreResult: AnchorProbeCoreResult): AnchorProbeResponse {
  const response = {
    ...baseResponse(request, sample),
    execution_status: coreResult.execution_status ?? ('OK' as const),
    budget_status: coreResult.budget_status,
    coverage_gate: coreResult.coverage_gate,
    l1_invariants: [...coreResult.l1_invariants],
    active_evidence: [...coreResult.active_evidence],
    deprecated_tombstones: [...coreResult.deprecated_tombstones],
    gaps: [...coreResult.gaps],
    conflicts: [...coreResult.conflicts],
  };
  return anchorProbeResponseSchema.parse({ ...response, context_id: request.context_id ?? deriveProbeContextId(request, response) });
}

function failedResponse(request: AnchorProbeRequest, sample: AnchorProbeSnapshotSample, error: unknown): AnchorProbeResponse {
  const response = {
    ...baseResponse(request, sample),
    execution_status: 'FAILED' as const,
    budget_status: { stop_reason: 'ERROR' as const, retrieval_completeness: 'UNKNOWN' as const, nodes_visited: 0, frontier_remaining: 0 },
    l1_invariants: [{ invariant_id: 'probe.core', status: 'unknown' as const, detail: errorMessage(error).slice(0, 2000) }],
  };
  return anchorProbeResponseSchema.parse({ ...response, context_id: request.context_id ?? deriveProbeContextId(request, response) });
}

function unstableResponse(request: AnchorProbeRequest, sample: AnchorProbeSnapshotSample): AnchorProbeResponse {
  const response = {
    ...baseResponse(request, sample),
    execution_status: 'SNAPSHOT_UNSTABLE' as const,
    budget_status: { stop_reason: 'ERROR' as const, retrieval_completeness: 'UNKNOWN' as const, nodes_visited: 0, frontier_remaining: 0 },
    l1_invariants: [{
      invariant_id: 'snapshot.stable',
      status: 'violated' as const,
      detail: 'Component digests changed during the probe and did not settle within the re-sample bound.',
    }],
  };
  return anchorProbeResponseSchema.parse({ ...response, context_id: request.context_id ?? deriveProbeContextId(request, response) });
}

/**
 * Run one read-only AnchorProbe request. The returned response is validated
 * against the AP-02 contract; the wrapper additionally exposes the Connect
 * sample (always unverified) and the re-sample count.
 */
export async function anchorProbeSurface(
  root: string,
  input: unknown,
  options: AnchorProbeSurfaceOptions = {},
): Promise<AnchorProbeSurfaceResult> {
  const request = anchorProbeRequestSchema.parse(input);
  const projectRoot = resolveRoot(root);
  const sampler = options.sampler ?? anchorProbeSnapshotSampler;
  const core = options.core ?? snapshotOnlyProbeCore;
  const maxResamples = options.maxResampleAttempts ?? DEFAULT_PROBE_RESAMPLE_ATTEMPTS;
  const sleep = options.sleep ?? defaultSleep;

  let sample = await sampler.sample(projectRoot, request.project_scope);

  if (request.context_id !== undefined) {
    const stored = options.contexts?.(request.context_id);
    if (!stored) throw new Error(`Unknown AnchorProbe context_id: ${request.context_id}`);
    if (stored.root !== projectRoot) throw new Error('AnchorProbe context_id belongs to a different root');
    if (stored.project_scope !== request.project_scope) throw new Error('AnchorProbe context_id belongs to a different project_scope');
    if (!snapshotEqual(stored.snapshot, sample.snapshot)) {
      return {
        response: unstableResponse(request, sample),
        connect: sample.connect,
        resamples: 0,
        graphFreshness: sample.graphFreshness,
      };
    }
  }

  let resamples = 0;
  for (;;) {
    let coreResult: AnchorProbeCoreResult;
    try {
      coreResult = await core({
        request,
        root: projectRoot,
        snapshot: sample.snapshot,
        connect: sample.connect,
        sources: readSources(projectRoot),
      });
    } catch (error) {
      return {
        response: failedResponse(request, sample, error),
        connect: sample.connect,
        resamples,
        graphFreshness: sample.graphFreshness,
      };
    }

    validateCoreResult(coreResult);

    const post = await sampler.sample(projectRoot, request.project_scope);
    const drifted = !snapshotEqual(sample.snapshot, post.snapshot) || usedFilesDrifted(coreResult, sample, projectRoot);
    if (!drifted) {
      return {
        response: coreResponse(request, sample, coreResult),
        connect: sample.connect,
        resamples,
        graphFreshness: sample.graphFreshness,
      };
    }

    resamples += 1;
    if (resamples > maxResamples) {
      return {
        response: unstableResponse(request, post),
        connect: post.connect,
        resamples,
        graphFreshness: post.graphFreshness,
      };
    }
    if (options.resampleDelayMs) await sleep(options.resampleDelayMs);
    sample = post;
  }
}

/** Opaque request id helper for hosts that do not have one yet. */
export function newProbeRequestId(): string {
  return `req-${randomBytes(12).toString('hex')}`;
}

async function readGraphSnapshot(root: string): Promise<GraphSnapshot | null> {
  if (!existsSync(join(root, '.ano', 'cache', 'graph.db'))) return null;
  const graph = await GraphStore.open(root);
  try {
    return graph.snapshot();
  } finally {
    graph.close();
  }
}

function noteCandidate(note: LedgerNote, anchorSource: AnchorSource | undefined, now: string): ProbeCandidate {
  const anchor = note.anchor as MemoryAnchor | undefined;
  const resolution = anchor !== undefined && anchorSource !== undefined ? resolveAnchor(anchor, anchorSource) : undefined;
  const health: AnchorProbeSourceHealth = resolution === undefined
    ? 'unknown'
    : resolution.status === 'stale' ? 'stale' : 'verified_at_snapshot';
  const anchorHealth: ProbeAnchorHealth = resolution === undefined
    ? { status: 'none', file: anchor?.file ?? null }
    : {
      status: resolution.status === 'exact' ? 'exact' : resolution.status === 'relocated' ? 'relocated' : 'stale',
      file: resolution.file,
    };
  return {
    record_ref: note.id,
    fact_key: null,
    task_id: null,
    file: anchor?.file ?? null,
    symbol: anchor?.qualifiedName ?? null,
    source: anchor?.file === undefined ? { kind: 'native_note' } : { kind: 'native_note', path: anchor.file },
    source_health: health,
    status: 'active',
    content: note.text,
    content_hash: createHash('sha256').update(note.text).digest('hex'),
    recorded_at: note.createdAt,
    effective_from: null,
    effective_to: null,
    superseded_by: null,
    version: null,
    anchor: anchorHealth,
    // Legacy notes carry no version governance yet; the qualifier keeps them
    // from being promoted to approved facts by traversal alone.
    qualifiers: ['legacy_unreviewed'],
  };
}

function symbolCandidate(symbol: SymbolNode, fileHash: string | undefined, content: string | undefined, now: string): ProbeCandidate | null {
  if (content === undefined) return null;
  const contentHash = createHash('sha256').update(content).digest('hex');
  return {
    record_ref: symbol.id,
    fact_key: null,
    task_id: null,
    file: symbol.file,
    symbol: symbol.qualifiedName,
    source: { kind: 'code_read', path: symbol.file },
    source_health: fileHash === contentHash ? 'verified_at_snapshot' : 'stale',
    status: 'active',
    content,
    content_hash: contentHash,
    recorded_at: now,
    effective_from: null,
    effective_to: null,
    superseded_by: null,
    version: null,
    anchor: { status: 'exact', file: symbol.file },
    qualifiers: ['code_static'],
  };
}

function historyCandidate(hit: RecallHit): ProbeCandidate | null {
  let safe: string;
  try {
    safe = assertSafeRelative(hit.sourcePath);
  } catch {
    return null;
  }
  return {
    record_ref: hit.id,
    fact_key: null,
    task_id: null,
    file: safe,
    symbol: hit.symbols[0] ?? null,
    source: { kind: 'history', path: safe },
    source_health: 'unknown',
    status: 'active',
    content: hit.text,
    content_hash: createHash('sha256').update(hit.text).digest('hex'),
    recorded_at: hit.timestamp,
    effective_from: null,
    effective_to: null,
    superseded_by: null,
    version: null,
    anchor: { status: 'none', file: safe },
    qualifiers: ['history', 'unverified'],
  };
}

function connectCandidate(task: ConnectedTask, now: string): ProbeCandidate | null {
  let safe: string;
  try {
    safe = assertSafeRelative(task.sourcePath);
  } catch {
    return null;
  }
  return {
    record_ref: task.id,
    fact_key: null,
    task_id: task.id,
    file: safe,
    symbol: null,
    source: { kind: 'connected', path: safe },
    source_health: 'unknown',
    status: 'active',
    content: task.title,
    content_hash: createHash('sha256').update(task.title).digest('hex'),
    recorded_at: now,
    effective_from: null,
    effective_to: null,
    superseded_by: null,
    version: null,
    anchor: { status: 'none', file: safe },
    qualifiers: ['connected', 'unverified'],
  };
}

function matchesQuery(candidate: ProbeCandidate, query: ProbeEntryQuery): boolean {
  if (query.fact_key !== undefined && candidate.fact_key !== query.fact_key) return false;
  if (query.task_id !== undefined && candidate.task_id !== query.task_id) return false;
  if (query.file !== undefined && candidate.file !== query.file) return false;
  if (query.symbol !== undefined && candidate.symbol !== query.symbol) return false;
  return true;
}

export interface AnchorProbeCandidateSourceOptions {
  /** Deterministic clock for CURRENT reads and code/history recorded_at. */
  readonly now?: string;
  readonly includeCode?: boolean;
  readonly includeHistory?: boolean;
  readonly includeConnect?: boolean;
}

/**
 * Real read-only candidate source over the committed ledger, the structure
 * graph, the history index and the authorized Connect connection. It never
 * writes: components that do not exist are skipped rather than created.
 */
export async function createAnchorProbeCandidateSource(
  root: string,
  snapshot: AnchorProbeSnapshot,
  options: AnchorProbeCandidateSourceOptions = {},
): Promise<ProbeCandidateSource> {
  const now = options.now ?? new Date().toISOString();
  const candidates: ProbeCandidate[] = [];
  const edges: ProbeEdge[] = [];

  const graphSnapshot = await readGraphSnapshot(root);
  const readFile = (file: string): string | undefined => {
    let safe: string;
    try {
      safe = assertSafeRelative(file);
    } catch {
      return undefined;
    }
    try {
      return readFileSync(join(root, safe), 'utf8');
    } catch {
      return undefined;
    }
  };
  const anchorSource = graphSnapshot === null ? undefined : anchorSourceFromGraph(graphSnapshot, readFile);

  if (existsSync(join(root, '.ano', 'ledger'))) {
    const ledger = await Ledger.open(root);
    try {
      for (const note of ledger.listNotes()) candidates.push(noteCandidate(note, anchorSource, now));
    } finally {
      ledger.close();
    }
  }

  if (graphSnapshot !== null && options.includeCode !== false) {
    for (const symbol of graphSnapshot.symbols) {
      const candidate = symbolCandidate(symbol, graphSnapshot.files[symbol.file]?.hash, readFile(symbol.file), now);
      if (candidate !== null) candidates.push(candidate);
    }
    for (const edge of graphSnapshot.edges) {
      edges.push({
        from: edge.from,
        to: edge.to,
        kind: edge.kind === 'value-confirmed' ? 'depends_on' : edge.kind === 'type-only' ? 'related_to' : 'unknown',
        // Static code relations stay heuristic; they are never confirmed facts.
        provenance: 'heuristic',
      });
    }
  }

  if (options.includeHistory !== false && existsSync(HistoryStore.databasePath(root))) {
    const history = HistoryStore.open(root);
    try {
      for (const hit of history.recall({ limit: 200 }).hits) {
        const candidate = historyCandidate(hit);
        if (candidate !== null) candidates.push(candidate);
      }
    } finally {
      history.close();
    }
  }

  if (options.includeConnect !== false) {
    try {
      const status = await connectionStatus(root);
      for (const task of status.tasks) {
        const candidate = connectCandidate(task, now);
        if (candidate !== null) candidates.push(candidate);
      }
    } catch {
      // Connect is an optional independent source; its absence is not hidden.
    }
  }

  return {
    snapshot,
    entries: (query?: ProbeEntryQuery) => {
      if (query === undefined) return candidates;
      return candidates.filter((candidate) => matchesQuery(candidate, query));
    },
    edges: () => edges,
  };
}

function runProbeCore(request: AnchorProbeRequest, source: ProbeCandidateSource, sources: AnchorProbeReadSources): AnchorProbeCoreResult {
  const response = probe(request, source);
  const usedFiles: AnchorProbeUsedFile[] = [];
  const seen = new Set<string>();
  for (const evidence of response.active_evidence) {
    const path = evidence.source.path;
    if (path === undefined || seen.has(path)) continue;
    const sha256 = sources.fileSha256(path);
    if (sha256 === undefined) continue;
    seen.add(path);
    usedFiles.push({ path, sha256 });
  }
  return {
    // SNAPSHOT_UNSTABLE is the Surface's verdict, never the core's.
    execution_status: response.execution_status === 'FAILED' ? 'FAILED' : response.execution_status === 'DEGRADED' ? 'DEGRADED' : 'OK',
    budget_status: response.budget_status,
    coverage_gate: response.coverage_gate,
    l1_invariants: response.l1_invariants,
    active_evidence: response.active_evidence,
    deprecated_tombstones: response.deprecated_tombstones,
    gaps: response.gaps,
    conflicts: response.conflicts,
    used_files: usedFiles,
  };
}

/**
 * Bridge the AP-03 read-only core into the Surface port. The core's own
 * snapshot/context id are re-derived by the Surface; only its retrieval result
 * is consumed.
 */
export function anchorProbeCoreFromProbe(source: ProbeCandidateSource): AnchorProbeCore {
  return async ({ request, sources }) => runProbeCore(request, source, sources);
}

/**
 * Surface core over the real host sources. The candidate source is rebuilt for
 * every sampled snapshot, so a re-sample after drift cannot report evidence
 * taken from the previous snapshot.
 */
export function createAnchorProbeCore(root: string, options: AnchorProbeCandidateSourceOptions = {}): AnchorProbeCore {
  return async ({ request, snapshot, sources }) =>
    runProbeCore(request, await createAnchorProbeCandidateSource(root, snapshot, options), sources);
}
