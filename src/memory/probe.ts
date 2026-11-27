import { createHash } from 'node:crypto';
import { canonicalJson } from '../ledger/event.ts';
import {
  ANCHOR_PROBE_CONTEXT_SCHEMA_VERSION,
  anchorProbeRequestSchema,
  type AnchorProbeConflict,
  type AnchorProbeEvidence,
  type AnchorProbeGap,
  type AnchorProbeInvariant,
  type AnchorProbeRequest,
  type AnchorProbeResponse,
  type AnchorProbeSnapshot,
  type AnchorProbeSource,
  type AnchorProbeSourceHealth,
  type AnchorProbeSourceKind,
  type AnchorProbeRecordStatus,
  type AnchorProbeStopReason,
  type AnchorProbeTombstone,
} from './probe-contract.ts';
import { toProbeStore, type ProbeStore } from './probe-store.ts';

/**
 * AnchorProbe read-only core (P0 / AP-03).
 *
 * This module routes candidate memory records by fact/task/file/symbol, filters
 * them by version, effective interval, source eligibility and anchor health,
 * walks typed relations under an explicit budget, then freezes a deterministic
 * evidence set with request-local aliases. It never writes the ledger, never
 * builds a manifest and never validates an answer; it only reports what the
 * injected source could prove at the sampled snapshot.
 *
 * Everything is injected: the caller supplies the request, a candidate source
 * and an optional clock/deadline. The same request against the same snapshot
 * therefore produces the same response, which is what makes a probe result
 * reviewable. `now` is part of the input for CURRENT reads, so callers that
 * need reproducibility must pass it explicitly.
 */

export type ProbeEntryDimension = 'fact' | 'task' | 'file' | 'symbol';

/** Routing dimensions. All fields are optional; `{}` means "every record". */
export interface ProbeEntryQuery {
  readonly fact_key?: string;
  readonly task_id?: string;
  readonly file?: string;
  readonly symbol?: string;
}

export type ProbeEdgeKind =
  | 'depends_on'
  | 'explains'
  | 'related_to'
  | 'supersedes'
  | 'conflicts_with'
  | 'unknown';

export type ProbeEdgeProvenance = 'confirmed' | 'heuristic' | 'unknown';

/**
 * A typed relation between two records. `heuristic`/`unknown` provenance is
 * preserved verbatim: a static code relation is never promoted to a confirmed
 * business fact just because traversal reached it.
 */
export interface ProbeEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: ProbeEdgeKind;
  readonly provenance: ProbeEdgeProvenance;
}

export interface ProbeAnchorHealth {
  readonly status: 'exact' | 'relocated' | 'stale' | 'none';
  readonly file: string | null;
}

/**
 * One candidate record as offered by the source. `source_health` is the
 * adapter's claim; the core may only downgrade it to `stale`, never upgrade a
 * history/code/unknown source into an approved fact.
 */
export interface ProbeCandidate {
  readonly record_ref: string;
  readonly fact_key: string | null;
  readonly task_id: string | null;
  readonly file: string | null;
  readonly symbol: string | null;
  readonly source: AnchorProbeSource;
  readonly source_health: AnchorProbeSourceHealth;
  readonly status: AnchorProbeRecordStatus;
  readonly content: string;
  readonly content_hash: string;
  readonly recorded_at: string;
  /** Null means the effective interval is unknown, not that it began at the epoch. */
  readonly effective_from: string | null;
  readonly effective_to: string | null;
  readonly superseded_by: string | null;
  readonly version: number | null;
  readonly anchor: ProbeAnchorHealth;
  /** Read-side provenance qualifiers; they never upgrade business status. */
  readonly qualifiers: readonly string[];
}

/** Thrown by a source when an index lookup fails. Never reported as "no hit". */
export class ProbeIndexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProbeIndexError';
  }
}

/** Thrown when the request itself does not satisfy the AP-02 contract. */
export class ProbeRequestError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProbeRequestError';
  }
}

/**
 * The narrow read port older callers inject. Every probe run reads through a
 * `ProbeStore` (see `probe-store.ts`); a bare candidate source is adapted into
 * that port, so the traversal semantics below are identical for an in-memory
 * test double and for a storage backend. `entries` routes by the supplied
 * dimensions and `entries({})` returns the full record set used for edge
 * resolution and the slow path.
 */
export interface ProbeCandidateSource {
  readonly snapshot: AnchorProbeSnapshot;
  entries(query?: ProbeEntryQuery): readonly ProbeCandidate[];
  edges(): readonly ProbeEdge[];
}

export interface ProbeRunOptions {
  /** Explicit routing dimensions. Defaults to one query per required fact. */
  readonly entries?: readonly ProbeEntryQuery[];
  /** Clock for CURRENT reads and effective-interval checks. */
  readonly now?: string;
  /** Wall-clock budget. Exceeding it stops traversal with TIMEOUT. */
  readonly deadlineMs?: number;
}

const ALIAS_PREFIX: Readonly<Record<AnchorProbeSourceKind, string>> = {
  native_note: 'E',
  history: 'H',
  code_read: 'I',
  connected: 'C',
  unknown: 'U',
};

const EDGE_KIND_ORDER: readonly ProbeEdgeKind[] = [
  'supersedes',
  'conflicts_with',
  'depends_on',
  'explains',
  'related_to',
  'unknown',
];

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export function probe(
  rawRequest: unknown,
  source: ProbeCandidateSource | ProbeStore,
  options: ProbeRunOptions = {},
): AnchorProbeResponse {
  let request: AnchorProbeRequest;
  try {
    request = anchorProbeRequestSchema.parse(rawRequest);
  } catch (error) {
    throw new ProbeRequestError('AnchorProbe request failed schema validation', { cause: error });
  }

  const store = toProbeStore(source);

  let snapshot: AnchorProbeSnapshot;
  try {
    snapshot = store.snapshot;
  } catch (error) {
    return failedResponse(request, fallbackSnapshot(request), `snapshot unavailable: ${message(error)}`);
  }

  try {
    return runProbe(request, store, snapshot, options);
  } catch (error) {
    return failedResponse(request, snapshot, `probe failed: ${message(error)}`);
  }
}

function runProbe(
  request: AnchorProbeRequest,
  store: ProbeStore,
  snapshot: AnchorProbeSnapshot,
  options: ProbeRunOptions,
): AnchorProbeResponse {
  const now = options.now ?? new Date().toISOString();
  const asOf = request.temporal_mode === 'CURRENT' ? now : (request.as_of ?? now);
  const budget = request.budget;
  const deadline = options.deadlineMs === undefined ? undefined : Date.now() + options.deadlineMs;

  const entryQueries: ProbeEntryQuery[] = options.entries !== undefined && options.entries.length > 0
    ? [...options.entries]
    : (request.required_facts ?? []).map((fact_key) => ({ fact_key }));

  const indexErrors: Array<{ dimension: ProbeEntryDimension | 'records' | 'edges'; fact_key?: string; message: string }> = [];

  let allRecords: readonly ProbeCandidate[] = [];
  try {
    allRecords = store.candidates({});
  } catch (error) {
    indexErrors.push({ dimension: 'records', message: message(error) });
  }

  // Route entries. A dimension that resolves to nothing enters the slow path:
  // broaden to the full index and match any requested dimension locally. The
  // candidates keep a `slow_path` qualifier so the broadening stays visible.
  const pool: ProbeCandidate[] = [];
  const seen = new Set<string>();
  let slowPathUsed = false;
  for (const query of entryQueries) {
    let matches: readonly ProbeCandidate[];
    try {
      matches = store.candidates(query);
    } catch (error) {
      indexErrors.push({
        dimension: dimensionOf(query),
        ...(query.fact_key === undefined ? {} : { fact_key: query.fact_key }),
        message: message(error),
      });
      continue;
    }
    if (matches.length === 0) {
      matches = allRecords.filter((candidate) => matchesQuery(candidate, query));
      if (matches.length > 0) {
        slowPathUsed = true;
        matches = matches.map((candidate) => withQualifier(candidate, 'slow_path'));
      }
    }
    for (const candidate of matches) {
      if (seen.has(candidate.record_ref)) continue;
      seen.add(candidate.record_ref);
      pool.push(candidate);
    }
  }

  pool.sort(compareCandidates);
  const candidateOverflow = pool.length > budget.max_candidates;
  const cappedPool = candidateOverflow ? pool.slice(0, budget.max_candidates) : pool;

  const recordMap = new Map<string, ProbeCandidate>();
  for (const candidate of allRecords) if (!recordMap.has(candidate.record_ref)) recordMap.set(candidate.record_ref, candidate);
  for (const candidate of cappedPool) if (!recordMap.has(candidate.record_ref)) recordMap.set(candidate.record_ref, candidate);

  let edgeList: readonly ProbeEdge[] = [];
  try {
    edgeList = store.adjacency();
  } catch (error) {
    indexErrors.push({ dimension: 'edges', message: message(error) });
  }
  const edgeMap = new Map<string, ProbeEdge[]>();
  for (const edge of edgeList) {
    const list = edgeMap.get(edge.from);
    if (list === undefined) edgeMap.set(edge.from, [edge]);
    else list.push(edge);
  }
  for (const list of edgeMap.values()) {
    list.sort((left, right) =>
      compareStrings(edgeRank(left.kind), edgeRank(right.kind)) || compareStrings(left.to, right.to));
  }

  // Source health is only ever downgraded: a stale anchor makes the source
  // stale regardless of the adapter's claim.
  const scoped = new Map<string, { candidate: ProbeCandidate; health: AnchorProbeSourceHealth; inScope: boolean }>();
  for (const candidate of recordMap.values()) {
    const health: AnchorProbeSourceHealth = candidate.source_health === 'stale' || candidate.anchor.status === 'stale'
      ? 'stale'
      : candidate.source_health;
    scoped.set(candidate.record_ref, { candidate, health, inScope: withinInterval(candidate, asOf) });
  }

  // Read-side version projection: at one fact slot, a strictly lower version is
  // superseded by the highest version. Equal versions with different content
  // stay active and surface as a conflict instead of being silently resolved.
  const versionSuperseded = new Map<string, string>();
  const byFactKey = new Map<string, ProbeCandidate[]>();
  for (const candidate of recordMap.values()) {
    if (candidate.fact_key === null) continue;
    const list = byFactKey.get(candidate.fact_key);
    if (list === undefined) byFactKey.set(candidate.fact_key, [candidate]);
    else list.push(candidate);
  }
  for (const list of byFactKey.values()) {
    const versioned = list.filter((candidate) => candidate.version !== null);
    if (versioned.length < 2) continue;
    const highest = Math.max(...versioned.map((candidate) => candidate.version as number));
    const head = versioned
      .filter((candidate) => candidate.version === highest)
      .sort((left, right) => compareStrings(left.record_ref, right.record_ref))[0];
    if (head === undefined) continue;
    for (const candidate of versioned) {
      if (candidate.version !== highest) versionSuperseded.set(candidate.record_ref, head.record_ref);
    }
  }

  // Bounded breadth-first traversal over typed edges.
  const visited = new Set<string>();
  const queued = new Set<string>();
  const frontier: Array<{ ref: string; depth: number }> = [];
  let nodeBudgetHit = false;
  let depthLimitHit = false;
  let timedOut = false;

  const push = (ref: string, depth: number): void => {
    if (visited.has(ref) || queued.has(ref)) return;
    if (visited.size + frontier.length >= budget.max_nodes) {
      nodeBudgetHit = true;
      return;
    }
    queued.add(ref);
    frontier.push({ ref, depth });
  };

  for (const candidate of cappedPool) {
    if (isActiveLike(candidate) && scoped.get(candidate.record_ref)?.inScope === true) push(candidate.record_ref, 0);
  }

  while (frontier.length > 0) {
    if (deadline !== undefined && Date.now() >= deadline) {
      timedOut = true;
      break;
    }
    const item = frontier.shift();
    if (item === undefined) break;
    if (visited.has(item.ref)) continue;
    visited.add(item.ref);
    const neighbours = edgeMap.get(item.ref) ?? [];
    const unvisited = neighbours.filter((edge) => !visited.has(edge.to) && recordMap.has(edge.to));
    if (item.depth >= budget.max_depth && unvisited.length > 0) {
      depthLimitHit = true;
      continue;
    }
    for (const edge of unvisited) push(edge.to, item.depth + 1);
  }

  const considered: ProbeCandidate[] = [...cappedPool];
  const consideredRefs = new Set(cappedPool.map((candidate) => candidate.record_ref));
  for (const ref of visited) {
    if (consideredRefs.has(ref)) continue;
    const candidate = recordMap.get(ref);
    if (candidate !== undefined) {
      considered.push(candidate);
      consideredRefs.add(ref);
    }
  }

  let invalidCandidates = 0;
  const active: ProbeCandidate[] = [];
  const tombstones: AnchorProbeTombstone[] = [];
  const aliasCounters = new Map<string, number>();
  const aliases = new Map<string, string>();

  for (const candidate of considered) {
    if (!isWellFormed(candidate)) {
      invalidCandidates += 1;
      continue;
    }
    const state = scoped.get(candidate.record_ref);
    if (state === undefined || !state.inScope) continue;
    const versionHead = versionSuperseded.get(candidate.record_ref);
    if (versionHead !== undefined) {
      const ref = nextAlias(aliasCounters, ALIAS_PREFIX[candidate.source.kind] ?? 'U');
      aliases.set(candidate.record_ref, ref);
      tombstones.push({
        ref,
        record_ref: candidate.record_ref,
        content_hash: candidate.content_hash,
        status: 'superseded',
        superseded_by: versionHead,
        recorded_at: candidate.recorded_at,
        reason: 'a higher version is active at the same fact slot',
      });
      continue;
    }
    if (isActiveLike(candidate)) {
      active.push(candidate);
    } else if (candidate.status === 'superseded' || candidate.status === 'retracted') {
      const ref = nextAlias(aliasCounters, ALIAS_PREFIX[candidate.source.kind] ?? 'U');
      aliases.set(candidate.record_ref, ref);
      tombstones.push({
        ref,
        record_ref: candidate.record_ref,
        content_hash: candidate.content_hash,
        status: candidate.status,
        superseded_by: candidate.superseded_by,
        recorded_at: candidate.recorded_at,
      });
    }
  }

  active.sort(compareCandidates);
  tombstones.sort((left, right) =>
    compareStrings(right.recorded_at, left.recorded_at) || compareStrings(left.record_ref, right.record_ref));

  for (const candidate of active) {
    const ref = nextAlias(aliasCounters, ALIAS_PREFIX[candidate.source.kind] ?? 'U');
    aliases.set(candidate.record_ref, ref);
  }

  const evidence: AnchorProbeEvidence[] = active.map((candidate) => ({
    ref: aliases.get(candidate.record_ref) as string,
    record_ref: candidate.record_ref,
    content_hash: candidate.content_hash,
    status: candidate.status,
    source_health: scoped.get(candidate.record_ref)?.health ?? candidate.source_health,
    recorded_at: candidate.recorded_at,
    effective_from: candidate.effective_from,
    source: candidate.source,
    content: candidate.content,
  }));

  const conflicts: AnchorProbeConflict[] = [];
  const ambiguousFacts = new Set<string>();
  const activeByFact = new Map<string, ProbeCandidate[]>();
  for (const candidate of active) {
    if (candidate.fact_key === null) continue;
    const list = activeByFact.get(candidate.fact_key);
    if (list === undefined) activeByFact.set(candidate.fact_key, [candidate]);
    else list.push(candidate);
  }
  for (const factKey of [...activeByFact.keys()].sort(compareStrings)) {
    const group = activeByFact.get(factKey) as ProbeCandidate[];
    if (new Set(group.map((candidate) => candidate.content_hash)).size > 1) {
      ambiguousFacts.add(factKey);
      conflicts.push({
        conflict_id: `conflict-${conflicts.length + 1}`,
        fact_key: factKey,
        record_refs: group.map((candidate) => candidate.record_ref).sort(compareStrings),
        status: 'unresolved',
      });
    }
  }

  const required = request.required_facts ?? [];
  const activeFacts = new Set(active.map((candidate) => candidate.fact_key).filter((key): key is string => key !== null));
  const consideredFacts = new Set(
    considered.map((candidate) => candidate.fact_key).filter((key): key is string => key !== null));

  const gaps: AnchorProbeGap[] = [];
  for (const factKey of [...new Set(required)]) {
    let reason: AnchorProbeGap['reason'];
    if (indexErrors.some((error) => error.fact_key === factKey)) reason = 'unknown';
    else if (!consideredFacts.has(factKey)) reason = 'missing';
    else if (!activeFacts.has(factKey)) reason = 'out_of_scope';
    else if (ambiguousFacts.has(factKey)) reason = 'ambiguous';
    else continue;
    gaps.push({ fact_key: factKey, reason });
  }

  const missingFacts = gaps
    .filter((gap) => gap.reason === 'missing' || gap.reason === 'out_of_scope')
    .map((gap) => gap.fact_key);
  const requirementsOrigin = required.length > 0
    ? 'caller_declared'
    : (entryQueries.length > 0 ? 'derived' : 'unknown');

  let coverageStatus: 'SUFFICIENT' | 'INSUFFICIENT' | 'UNKNOWN';
  if (indexErrors.length > 0 || gaps.some((gap) => gap.reason === 'unknown')) coverageStatus = 'UNKNOWN';
  else if (required.length === 0) coverageStatus = conflicts.length > 0 ? 'INSUFFICIENT' : 'UNKNOWN';
  else coverageStatus = missingFacts.length === 0 && conflicts.length === 0 ? 'SUFFICIENT' : 'INSUFFICIENT';

  const stopReason: AnchorProbeStopReason = indexErrors.length > 0
    ? 'ERROR'
    : timedOut
      ? 'TIMEOUT'
      : (nodeBudgetHit || candidateOverflow)
        ? 'BUDGET_EXHAUSTED'
        : depthLimitHit
          ? 'DEPTH_LIMIT'
          : (entryQueries.length > 0 && visited.size === 0)
            ? 'ENTRY_NOT_FOUND'
            : 'FRONTIER_EXHAUSTED';

  const retrievalCompleteness = stopReason === 'FRONTIER_EXHAUSTED'
    ? 'COMPLETE_WITHIN_DECLARED_SCOPE'
    : stopReason === 'ERROR'
      ? 'UNKNOWN'
      : 'PARTIAL';

  const aliasRefs = [...aliases.values()];
  const invariants: AnchorProbeInvariant[] = [
    {
      invariant_id: 'probe.snapshot_bound',
      status: 'satisfied',
      detail: 'response is bound to the sampled ledger/graph/source digests',
    },
    {
      invariant_id: 'probe.aliases_unique',
      status: new Set(aliasRefs).size === aliasRefs.length ? 'satisfied' : 'violated',
      detail: `${aliasRefs.length} request-local aliases were allocated`,
    },
    {
      invariant_id: 'probe.traversal_acyclic',
      status: 'satisfied',
      detail: 'the visited set prevented re-expansion of a record',
    },
    {
      invariant_id: 'probe.entry_routing',
      status: slowPathUsed ? 'unknown' : 'satisfied',
      detail: slowPathUsed
        ? 'at least one entry was resolved through the broadened slow path'
        : 'every requested entry resolved through its own dimension',
    },
    {
      invariant_id: 'probe.index_errors_surfaced',
      status: indexErrors.length === 0 ? 'satisfied' : 'violated',
      detail: indexErrors.length === 0 ? 'no index error occurred' : `${indexErrors.length} index error(s) reported, not hidden as no-hit`,
    },
    {
      invariant_id: 'probe.candidates_well_formed',
      status: invalidCandidates === 0 ? 'satisfied' : 'violated',
      detail: invalidCandidates === 0 ? 'every considered candidate was well formed' : `${invalidCandidates} malformed candidate(s) dropped`,
    },
  ];

  const response: Omit<AnchorProbeResponse, 'context_id'> = {
    schema_version: ANCHOR_PROBE_CONTEXT_SCHEMA_VERSION,
    request_id: request.request_id,
    snapshot,
    execution_status: indexErrors.length > 0 ? 'DEGRADED' : 'OK',
    temporal_mode: request.temporal_mode,
    budget_status: {
      stop_reason: stopReason,
      retrieval_completeness: retrievalCompleteness,
      nodes_visited: visited.size,
      frontier_remaining: frontier.length,
    },
    coverage_gate: {
      status: coverageStatus,
      required_facts: required,
      missing_facts: missingFacts,
      unresolved_conflicts: conflicts.map((conflict) => conflict.conflict_id),
      requirements_origin: requirementsOrigin,
    },
    l1_invariants: invariants,
    active_evidence: evidence,
    deprecated_tombstones: tombstones,
    gaps,
    conflicts,
    untrusted: true,
  };
  return { ...response, context_id: deriveProbeContextId(request, response) };
}

function failedResponse(
  request: AnchorProbeRequest,
  snapshot: AnchorProbeSnapshot,
  detail: string,
): AnchorProbeResponse {
  const required = request.required_facts ?? [];
  const response: Omit<AnchorProbeResponse, 'context_id'> = {
    schema_version: ANCHOR_PROBE_CONTEXT_SCHEMA_VERSION,
    request_id: request.request_id,
    snapshot,
    execution_status: 'FAILED',
    temporal_mode: request.temporal_mode,
    budget_status: {
      stop_reason: 'ERROR',
      retrieval_completeness: 'UNKNOWN',
      nodes_visited: 0,
      frontier_remaining: 0,
    },
    coverage_gate: {
      status: 'UNKNOWN',
      required_facts: required,
      missing_facts: [],
      unresolved_conflicts: [],
      requirements_origin: required.length > 0 ? 'caller_declared' : 'unknown',
    },
    l1_invariants: [{ invariant_id: 'probe.execution', status: 'violated', detail }],
    active_evidence: [],
    deprecated_tombstones: [],
    gaps: [],
    conflicts: [],
    untrusted: true,
  };
  return { ...response, context_id: deriveProbeContextId(request, response) };
}

function fallbackSnapshot(request: AnchorProbeRequest): AnchorProbeSnapshot {
  return {
    project_scope: request.project_scope,
    ledger_digest: '0'.repeat(64),
    graph_revision: null,
    source_fingerprint: null,
    connected_digest: null,
  };
}

/** Bind normalized request rules and final material, never clock ticks or self-referential ids. */
export function deriveProbeContextId(
  request: AnchorProbeRequest,
  response: Omit<AnchorProbeResponse, 'context_id'> & { readonly context_id?: string },
): string {
  const { context_id: _requestContextId, ...effectiveRequest } = request;
  const { context_id: _responseContextId, ...material } = response;
  const digest = createHash('sha256')
    .update(canonicalJson({
      request: { ...effectiveRequest, required_facts: request.required_facts ?? [], as_of: request.as_of ?? null },
      response: material,
    }))
    .digest('hex');
  return `ctx-${digest.slice(0, 32)}`;
}

function dimensionOf(query: ProbeEntryQuery): ProbeEntryDimension {
  if (query.fact_key !== undefined) return 'fact';
  if (query.task_id !== undefined) return 'task';
  if (query.file !== undefined) return 'file';
  return 'symbol';
}

function matchesQuery(candidate: ProbeCandidate, query: ProbeEntryQuery): boolean {
  if (query.fact_key !== undefined && candidate.fact_key === query.fact_key) return true;
  if (query.task_id !== undefined && candidate.task_id === query.task_id) return true;
  if (query.file !== undefined && candidate.file === query.file) return true;
  if (query.symbol !== undefined && candidate.symbol === query.symbol) return true;
  return false;
}

function withinInterval(candidate: ProbeCandidate, asOf: string): boolean {
  if (candidate.effective_from !== null && candidate.effective_from > asOf) return false;
  if (candidate.effective_to !== null && asOf >= candidate.effective_to) return false;
  return true;
}

function isActiveLike(candidate: ProbeCandidate): boolean {
  return candidate.status === 'active' || candidate.status === 'conflicted';
}

function isWellFormed(candidate: ProbeCandidate): boolean {
  return candidate.record_ref.length > 0
    && candidate.content.length > 0
    && SHA256_PATTERN.test(candidate.content_hash)
    && !Number.isNaN(Date.parse(candidate.recorded_at));
}

function withQualifier(candidate: ProbeCandidate, qualifier: string): ProbeCandidate {
  if (candidate.qualifiers.includes(qualifier)) return candidate;
  return { ...candidate, qualifiers: [...candidate.qualifiers, qualifier] };
}

function nextAlias(counters: Map<string, number>, prefix: string): string {
  const next = (counters.get(prefix) ?? 0) + 1;
  counters.set(prefix, next);
  return `${prefix}${next}`;
}

function edgeRank(kind: ProbeEdgeKind): string {
  const index = EDGE_KIND_ORDER.indexOf(kind);
  return index === -1 ? String(EDGE_KIND_ORDER.length) : String(index);
}

function compareCandidates(left: ProbeCandidate, right: ProbeCandidate): number {
  return compareStrings(right.recorded_at, left.recorded_at)
    || compareStrings(left.record_ref, right.record_ref)
    || compareStrings(left.content_hash, right.content_hash);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
