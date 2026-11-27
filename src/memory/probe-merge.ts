import { createHash } from 'node:crypto';
import {
  ANCHOR_PROBE_CONTEXT_SCHEMA_VERSION,
  PROBE_EVIDENCE_DIGEST_MAX_RECORDS,
  computeEvidenceDigestDetailed,
  type AnchorProbeConflict,
  type AnchorProbeRecordStatus,
  type AnchorProbeRequest,
  type AnchorProbeResponse,
  type AnchorProbeSnapshot,
} from './probe-contract.ts';
import type { ProbeCandidate, ProbeEdge, ProbeEntryQuery } from './probe.ts';
import type {
  DistributedCandidateFingerprint,
  DistributedNodeOutcome,
  DistributedNodeReport,
  DistributedProbeAnswer,
  DistributedProbeConflict,
  DistributedProbeConsistency,
  DistributedProbeMetadata,
  DistributedProbeMode,
  DistributedProbeOutcome,
  DistributedProbePartial,
  DistributedProbeStopReason,
  DistributedReplicaNode,
  DistributedReplicaState,
} from './distributed-probe.ts';

/**
 * T-147 / CV-05 extraction: scatter/gather merge, dedupe, conflict detection,
 * consistency/degradation computation and answer assembly.
 *
 * Pure boundary: the functions here take values in and return values out; the
 * only I/O primitive is `createHash` for context ids/digests. The store
 * adapter (`MergedProbeStore`) and the socket/transport-free coordinator live
 * in `distributed-probe.ts`, which re-exports nothing from here because these
 * helpers were never part of its public surface.
 */

export interface NodeInfo {
  readonly node: DistributedReplicaNode;
  readonly id: string;
}

export interface NodeSuccess {
  readonly id: string;
  readonly snapshot: AnchorProbeSnapshot;
  readonly candidates: readonly ProbeCandidate[];
  readonly edges: readonly ProbeEdge[];
  readonly commitIndex: number;
  readonly digest: string;
  readonly viewDigest: string | null;
  readonly state: DistributedReplicaState;
  readonly epoch: string | number;
  readonly latencyMs: number;
}

export interface NodeFailure {
  readonly id: string;
  readonly code: Exclude<DistributedNodeOutcome, 'OK' | 'NOT_QUERIED'>;
  readonly detail: string;
  readonly latencyMs: number;
}

export type NodeOutcome =
  | { readonly status: 'ok'; readonly success: NodeSuccess }
  | { readonly status: 'failed'; readonly failure: NodeFailure };

export interface ScatterResult {
  readonly outcomes: readonly NodeOutcome[];
  readonly aborted: boolean;
  readonly elapsedMs: number;
}

// ---------------------------------------------------------------------------
// Small value helpers
// ---------------------------------------------------------------------------

export function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function fallbackSnapshot(request: AnchorProbeRequest): AnchorProbeSnapshot {
  return {
    project_scope: request.project_scope,
    ledger_digest: '0'.repeat(64),
    graph_revision: null,
    source_fingerprint: null,
    connected_digest: null,
  };
}

function contextIdFor(request: AnchorProbeRequest, snapshot: AnchorProbeSnapshot): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([request.request_id, request.project_scope, snapshot.ledger_digest, snapshot.graph_revision, snapshot.source_fingerprint, snapshot.connected_digest]))
    .digest('hex');
  return `ctx-${digest.slice(0, 32)}`;
}
// ---------------------------------------------------------------------------
// Candidate gathering: dedup, stable order, explicit conflicts
// ---------------------------------------------------------------------------

interface Observation {
  readonly candidate: ProbeCandidate;
  readonly source: string;
}

interface DedupedObservation {
  readonly candidate: ProbeCandidate;
  sources: string[];
}

interface GatherResult {
  readonly merged: readonly ProbeCandidate[];
  readonly fingerprints: readonly DistributedCandidateFingerprint[];
  readonly conflicts: readonly DistributedProbeConflict[];
  readonly requested: number;
  readonly considered: number;
  readonly edges: readonly ProbeEdge[];
}

export const DEDUPE_SEPARATOR = '\u0000';

function observationSortKey(observation: Observation): string {
  return [
    observation.candidate.record_ref,
    observation.candidate.content_hash,
    observation.candidate.status,
    observation.source,
  ].join(DEDUPE_SEPARATOR);
}

/** Dedup key required by the contract: record_ref + content_hash (+ status for fact semantics). */
function dedupeKey(observation: Observation): string {
  return [
    observation.candidate.record_ref,
    observation.candidate.content_hash,
    observation.candidate.status,
  ].join(DEDUPE_SEPARATOR);
}

export function gatherCandidates(successes: readonly NodeSuccess[]): GatherResult {
  const observations: Observation[] = [];
  const edges: ProbeEdge[] = [];
  for (const success of successes) {
    for (const candidate of success.candidates) observations.push({ candidate, source: success.id });
    edges.push(...success.edges);
  }

  const requested = new Set<string>();
  for (const observation of observations) {
    requested.add(`${observation.candidate.record_ref}${DEDUPE_SEPARATOR}${observation.candidate.content_hash}`);
  }

  // Stable order first so dedup keeps a deterministic variant regardless of
  // node completion order; exact duplicates collapse, conflicting variants stay.
  observations.sort((left, right) => compareStrings(observationSortKey(left), observationSortKey(right)));
  const byTriple = new Map<string, DedupedObservation>();
  for (const observation of observations) {
    const key = dedupeKey(observation);
    const existing = byTriple.get(key);
    if (existing === undefined) {
      byTriple.set(key, { candidate: observation.candidate, sources: [observation.source] });
    } else if (!existing.sources.includes(observation.source)) {
      existing.sources.push(observation.source);
    }
  }
  const deduped = [...byTriple.values()];
  const merged = deduped.map((entry) => entry.candidate);

  const fingerprints: DistributedCandidateFingerprint[] = [];
  const byPair = new Map<string, {
    record_ref: string;
    content_hash: string;
    fact_key: string | null;
    status: AnchorProbeRecordStatus;
    sources: string[];
  }>();
  for (const entry of deduped) {
    const candidate = entry.candidate;
    const key = `${candidate.record_ref}${DEDUPE_SEPARATOR}${candidate.content_hash}`;
    const existing = byPair.get(key);
    if (existing === undefined) {
      byPair.set(key, {
        record_ref: candidate.record_ref,
        content_hash: candidate.content_hash,
        fact_key: candidate.fact_key,
        status: candidate.status,
        sources: [...entry.sources],
      });
    } else if (!existing.sources.includes(entry.sources[0] as string)) {
      existing.sources.push(entry.sources[0] as string);
    }
  }
  for (const fingerprint of byPair.values()) {
    fingerprints.push({ ...fingerprint, sources: uniqueSorted(fingerprint.sources) });
  }
  fingerprints.sort((left, right) =>
    compareStrings(left.record_ref, right.record_ref) || compareStrings(left.content_hash, right.content_hash));

  const conflicts: DistributedProbeConflict[] = [];
  const byRef = new Map<string, DedupedObservation[]>();
  for (const entry of deduped) {
    const list = byRef.get(entry.candidate.record_ref);
    if (list === undefined) byRef.set(entry.candidate.record_ref, [entry]);
    else list.push(entry);
  }
  for (const [recordRef, variants] of [...byRef.entries()].sort((left, right) => compareStrings(left[0], right[0]))) {
    const hashes = uniqueSorted(variants.map((variant) => variant.candidate.content_hash));
    const statuses = uniqueSorted(variants.map((variant) => variant.candidate.status));
    const factKeys = uniqueSorted(variants.map((variant) => variant.candidate.fact_key).filter((key): key is string => key !== null));
    const nodes = uniqueSorted(variants.flatMap((variant) => variant.sources));
    const factKey = factKeys.length === 1 ? (factKeys[0] as string) : null;
    if (hashes.length > 1) {
      conflicts.push({
        conflict_id: '',
        kind: 'content_hash',
        fact_key: factKey,
        record_ref: recordRef,
        nodes,
        content_hashes: hashes,
        statuses,
        commits: [],
        epochs: [],
        status: 'unresolved',
      });
    }
    if (statuses.length > 1) {
      conflicts.push({
        conflict_id: '',
        kind: 'status',
        fact_key: factKey,
        record_ref: recordRef,
        nodes,
        content_hashes: hashes,
        statuses,
        commits: [],
        epochs: [],
        status: 'unresolved',
      });
    }
  }

  return {
    merged,
    fingerprints,
    conflicts: assignConflictIds(conflicts),
    requested: requested.size,
    considered: deduped.length,
    edges: dedupeEdges(edges),
  };
}

export function assignConflictIds(conflicts: readonly DistributedProbeConflict[]): DistributedProbeConflict[] {
  return conflicts.map((conflict, index) => ({ ...conflict, conflict_id: `dist-conflict-${index + 1}` }));
}

export function commitConflicts(successes: readonly NodeSuccess[]): DistributedProbeConflict[] {
  const conflicts: DistributedProbeConflict[] = [];
  const commits = [...new Set(successes.map((success) => success.commitIndex))].sort((left, right) => left - right);
  if (commits.length > 1) {
    conflicts.push({
      conflict_id: '',
      kind: 'commit',
      fact_key: 'distributed.commit',
      record_ref: null,
      nodes: uniqueSorted(successes.map((success) => success.id)),
      content_hashes: [],
      statuses: [],
      commits,
      epochs: [],
      status: 'unresolved',
    });
  }
  const epochs = uniqueSorted(successes.map((success) => String(success.epoch)));
  if (epochs.length > 1) {
    conflicts.push({
      conflict_id: '',
      kind: 'cluster_epoch',
      fact_key: 'distributed.cluster_epoch',
      record_ref: null,
      nodes: uniqueSorted(successes.map((success) => success.id)),
      content_hashes: [],
      statuses: [],
      commits: [],
      epochs,
      status: 'unresolved',
    });
  }
  return conflicts;
}

function dedupeEdges(edges: readonly ProbeEdge[]): ProbeEdge[] {
  const seen = new Set<string>();
  const result: ProbeEdge[] = [];
  for (const edge of edges) {
    const key = `${edge.from}${DEDUPE_SEPARATOR}${edge.to}${DEDUPE_SEPARATOR}${edge.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(edge);
  }
  result.sort((left, right) =>
    compareStrings(left.from, right.from)
    || compareStrings(left.to, right.to)
    || compareStrings(left.kind, right.kind));
  return result;
}

export function digestCandidates(candidates: readonly ProbeCandidate[]): string {
  return computeEvidenceDigestDetailed(
    candidates.map((candidate) => ({
      record_ref: candidate.record_ref,
      content_hash: candidate.content_hash,
      ...(candidate.fact_key === null ? {} : { fact_key: candidate.fact_key }),
      status: candidate.status,
    })),
    { limit: PROBE_EVIDENCE_DIGEST_MAX_RECORDS, allowTruncation: true },
  ).digest;
}
export function matchesEntryQuery(candidate: ProbeCandidate, query: ProbeEntryQuery): boolean {
  if (query.fact_key !== undefined && candidate.fact_key !== query.fact_key) return false;
  if (query.task_id !== undefined && candidate.task_id !== query.task_id) return false;
  if (query.file !== undefined && candidate.file !== query.file) return false;
  if (query.symbol !== undefined && candidate.symbol !== query.symbol) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Answer assembly
// ---------------------------------------------------------------------------

export function consistencyFromResponse(response: AnchorProbeResponse): DistributedProbeConsistency {
  if (response.execution_status === 'FAILED') return 'UNKNOWN';
  if (response.budget_status.retrieval_completeness === 'COMPLETE_WITHIN_DECLARED_SCOPE') return 'CONSISTENT';
  if (response.budget_status.retrieval_completeness === 'UNKNOWN') return 'UNKNOWN';
  return 'PARTIAL';
}
interface AssembleInput {
  readonly request: AnchorProbeRequest;
  readonly response: AnchorProbeResponse;
  readonly candidates: readonly DistributedCandidateFingerprint[];
  readonly conflicts: readonly DistributedProbeConflict[];
  readonly failedNodes: readonly string[];
  readonly nodeReports: readonly DistributedNodeReport[];
  readonly mode: DistributedProbeMode;
  readonly requestedMode: DistributedProbeMode;
  readonly consistency: DistributedProbeConsistency;
  readonly degraded: boolean;
  readonly degradationReason?: string;
  readonly stopReason: DistributedProbeStopReason;
  readonly origin: 'local' | 'primary' | 'replica';
  readonly evidenceDigest: string;
  readonly clusterEpoch: string | number;
  readonly commitIndex?: number;
  readonly primaryCommitIndex?: number;
  readonly quorumSize: number;
  readonly quorumCount: number;
  readonly quorumDigests: readonly string[];
  readonly stale: boolean;
  readonly historical: boolean;
  readonly maxLag: number | null;
  readonly considered: number;
  readonly requested: number;
  readonly gaps: readonly string[];
  readonly elapsedMs: number;
  readonly resourcesReleased: boolean;
}

export function assembleAnswer(input: AssembleInput): DistributedProbeAnswer {
  const coverage = input.requested === 0
    ? (input.considered === 0 ? 0 : 1)
    : Math.min(1, input.considered / input.requested);
  const partialFlag = input.degraded
    || input.failedNodes.length > 0
    || input.conflicts.length > 0
    || input.stopReason !== 'NONE'
    || input.response.execution_status !== 'OK'
    || input.response.budget_status.retrieval_completeness !== 'COMPLETE_WITHIN_DECLARED_SCOPE';
  const outcome: DistributedProbeOutcome = input.stopReason === 'CANCELLED'
    ? 'CANCELLED'
    : input.response.execution_status === 'FAILED'
      ? 'FAILED'
      : input.consistency === 'DEGRADED'
        ? 'PARTIAL'
        : input.consistency;
  const metadata: DistributedProbeMetadata = {
    mode: input.mode,
    requested_mode: input.requestedMode,
    consistency: input.consistency,
    evidence_origin: input.origin,
    cluster_epoch: input.clusterEpoch,
    ...(input.commitIndex === undefined ? {} : { commit_index: input.commitIndex }),
    ...(input.primaryCommitIndex === undefined ? {} : { primary_commit_index: input.primaryCommitIndex }),
    evidence_digest: input.evidenceDigest,
    quorum_size: input.quorumSize,
    quorum_count: input.quorumCount,
    quorum_digests: input.quorumDigests,
    stale: input.stale,
    historical: input.historical,
    degraded: input.degraded,
    ...(input.degradationReason === undefined ? {} : { degradation_reason: input.degradationReason }),
    max_lag: input.maxLag,
    partial: partialFlag,
    stop_reason: input.stopReason,
  };
  return {
    request_id: input.request.request_id,
    outcome,
    mode: input.mode,
    requested_mode: input.requestedMode,
    consistency: input.consistency,
    degraded: input.degraded,
    evidence_origin: input.origin,
    metadata,
    response: input.response,
    candidates: input.candidates,
    conflicts: input.conflicts,
    partial: {
      coverage,
      considered: input.considered,
      requested: input.requested,
      gaps: input.gaps,
      failed_nodes: input.failedNodes,
      stop_reason: input.stopReason,
    },
    nodes: input.nodeReports,
    elapsed_ms: input.elapsedMs,
    resources_released: input.resourcesReleased,
  };
}
export function nodeReports(
  infos: readonly NodeInfo[],
  outcomes: readonly NodeOutcome[],
  usedIds: ReadonlySet<string>,
  local: { outcome: DistributedNodeOutcome; detail: string; used: boolean },
): DistributedNodeReport[] {
  const byId = new Map(outcomes.map((outcome) => [
    outcome.status === 'ok' ? outcome.success.id : outcome.failure.id,
    outcome,
  ]));
  const reports: DistributedNodeReport[] = [{
    replica_id: 'local',
    outcome: local.outcome,
    commit_index: null,
    evidence_digest: null,
    latency_ms: 0,
    detail: local.detail,
    used: local.used,
  }];
  for (const info of infos) {
    const outcome = byId.get(info.id);
    if (outcome === undefined) {
      reports.push({
        replica_id: info.id,
        outcome: 'NOT_QUERIED',
        commit_index: null,
        evidence_digest: null,
        latency_ms: 0,
        detail: 'node was not queried',
        used: false,
      });
      continue;
    }
    if (outcome.status === 'ok') {
      reports.push({
        replica_id: info.id,
        outcome: 'OK',
        commit_index: outcome.success.commitIndex,
        evidence_digest: outcome.success.digest,
        latency_ms: outcome.success.latencyMs,
        detail: `commit=${String(outcome.success.commitIndex)} state=${outcome.success.state}`,
        used: usedIds.has(info.id),
      });
    } else {
      reports.push({
        replica_id: info.id,
        outcome: outcome.failure.code,
        commit_index: null,
        evidence_digest: null,
        latency_ms: outcome.failure.latencyMs,
        detail: outcome.failure.detail,
        used: false,
      });
    }
  }
  return reports;
}
export function cancelledResponse(request: AnchorProbeRequest, snapshot: AnchorProbeSnapshot | null): AnchorProbeResponse {
  const resolved = snapshot ?? fallbackSnapshot(request);
  const required = request.required_facts ?? [];
  return {
    schema_version: ANCHOR_PROBE_CONTEXT_SCHEMA_VERSION,
    request_id: request.request_id,
    context_id: contextIdFor(request, resolved),
    snapshot: resolved,
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
    l1_invariants: [{ invariant_id: 'probe.execution', status: 'violated', detail: 'distributed probe cancelled by caller' }],
    active_evidence: [],
    deprecated_tombstones: [],
    gaps: [],
    conflicts: [],
    untrusted: true,
  };
}

// ---------------------------------------------------------------------------
// Fingerprint helpers and distributed-conflict injection
// ---------------------------------------------------------------------------

export function safeFingerprints(candidates: readonly ProbeCandidate[]): DistributedCandidateFingerprint[] {
  const byPair = new Map<string, DistributedCandidateFingerprint>();
  for (const candidate of candidates) {
    const key = `${candidate.record_ref}${DEDUPE_SEPARATOR}${candidate.content_hash}`;
    const existing = byPair.get(key);
    if (existing === undefined) {
      byPair.set(key, {
        record_ref: candidate.record_ref,
        content_hash: candidate.content_hash,
        fact_key: candidate.fact_key,
        status: candidate.status,
        sources: ['local'],
      });
    }
  }
  return [...byPair.values()].sort((left, right) =>
    compareStrings(left.record_ref, right.record_ref) || compareStrings(left.content_hash, right.content_hash));
}

export function digestOrEmpty(fingerprints: readonly DistributedCandidateFingerprint[]): string {
  try {
    return computeEvidenceDigestDetailed(
      fingerprints.map((fingerprint) => ({
        record_ref: fingerprint.record_ref,
        content_hash: fingerprint.content_hash,
        ...(fingerprint.fact_key === null ? {} : { fact_key: fingerprint.fact_key }),
        status: fingerprint.status,
      })),
      { limit: PROBE_EVIDENCE_DIGEST_MAX_RECORDS, allowTruncation: true },
    ).digest;
  } catch {
    return computeEvidenceDigestDetailed([], { limit: PROBE_EVIDENCE_DIGEST_MAX_RECORDS, allowTruncation: true }).digest;
  }
}

/**
 * Surface distributed conflicts inside the unchanged AP-02 response so the
 * coverage gate can never report SUFFICIENT while a version/commit divergence
 * is unresolved. Shape and field vocabulary stay identical.
 */
export function injectDistributedConflicts(response: AnchorProbeResponse, conflicts: readonly DistributedProbeConflict[]): AnchorProbeResponse {
  if (conflicts.length === 0) return response;
  const known = new Set(response.conflicts.map((conflict) => conflict.conflict_id));
  const additions: AnchorProbeConflict[] = [];
  for (const conflict of conflicts) {
    if (known.has(conflict.conflict_id)) continue;
    const refs = conflict.record_ref === null
      ? (conflict.nodes.length > 0 ? conflict.nodes.slice(0, 64) : ['distributed'])
      : [conflict.record_ref];
    additions.push({
      conflict_id: conflict.conflict_id,
      fact_key: conflict.fact_key ?? (conflict.kind === 'commit' ? 'distributed.commit' : conflict.kind === 'cluster_epoch' ? 'distributed.cluster_epoch' : 'distributed.record'),
      record_refs: refs,
      status: 'unresolved',
    });
  }
  if (additions.length === 0) return response;
  const unresolved = [...response.coverage_gate.unresolved_conflicts];
  for (const addition of additions) {
    if (!unresolved.includes(addition.conflict_id)) unresolved.push(addition.conflict_id);
  }
  const status = response.coverage_gate.status === 'SUFFICIENT' ? 'INSUFFICIENT' : response.coverage_gate.status;
  return {
    ...response,
    conflicts: [...response.conflicts, ...additions],
    coverage_gate: {
      ...response.coverage_gate,
      status,
      unresolved_conflicts: unresolved,
    },
  };
}
