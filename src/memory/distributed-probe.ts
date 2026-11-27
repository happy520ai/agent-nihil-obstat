import { createHash } from 'node:crypto';
import {
  ANCHOR_PROBE_CONTEXT_SCHEMA_VERSION,
  PROBE_EVIDENCE_DIGEST_MAX_RECORDS,
  anchorProbeRequestSchema,
  computeEvidenceDigestDetailed,
  type AnchorProbeConflict,
  type AnchorProbeRequest,
  type AnchorProbeResponse,
  type AnchorProbeSnapshot,
  type AnchorProbeRecordStatus,
} from './probe-contract.ts';
import {
  ProbeRequestError,
  probe,
  type ProbeCandidate,
  type ProbeEdge,
  type ProbeEntryQuery,
  type ProbeRunOptions,
} from './probe.ts';
import {
  isProbeStore,
  probeSnapshotIdentity,
  type ProbeEvidencePayload,
  type ProbeProvenanceView,
  type ProbeSnapshotIdentity,
  type ProbeStatusView,
  type ProbeStore,
} from './probe-store.ts';
import {
  acquireProbeSlot,
  ProbeCapacityError,
  ProbeSlotCancelledError,
  ProbeSlotTimeoutError,
  type ProbeSchedulerLimits,
  type ProbeSlot,
} from './probe-scheduler.ts';
import {
  DEDUPE_SEPARATOR,
  assignConflictIds,
  assembleAnswer,
  cancelledResponse,
  commitConflicts,
  compareStrings,
  consistencyFromResponse,
  digestCandidates,
  digestOrEmpty,
  fallbackSnapshot,
  gatherCandidates,
  injectDistributedConflicts,
  matchesEntryQuery,
  message,
  nodeReports,
  safeFingerprints,
  uniqueSorted,
} from './probe-merge.ts';
import type {
  NodeFailure,
  NodeInfo,
  NodeOutcome,
  NodeSuccess,
  ScatterResult,
} from './probe-merge.ts';

/**
 * T-126 / ADR-011 §5–§7: asynchronous distributed probe coordinator.
 *
 * One coordinator, one local `ProbeStore` and N read-only replica stores. The
 * coordinator scatters the same query to every in-scope replica in parallel,
 * gathers candidates by `(record_ref, content_hash)`, judges exactly one of the
 * four retrieval-consistency modes (LOCAL / AS_OF / COMMITTED / QUORUM), and
 * falls back to the local store with an explicit degradation marker when the
 * requested mode cannot be met.
 *
 * Hard boundaries honoured here:
 * - replicas are untrusted data sources: their declared commit/digest is
 *   recomputed locally from the returned candidate bytes;
 * - one conclusion carries a single `evidence_origin`; remote evidence is never
 *   merged into a local conclusion and local evidence is never mixed into a
 *   remote one;
 * - no Gate fields (`evidence_id`/`verdict`/`task_id`) are produced and no
 *   completion channel is triggered (ADR-010 §6, ADR-011 §7.3).
 */

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

export const distributedProbeModes = ['LOCAL', 'AS_OF', 'COMMITTED', 'QUORUM'] as const;
export type DistributedProbeMode = (typeof distributedProbeModes)[number];

export const distributedReplicaStates = ['ACTIVE', 'LAGGING', 'JOINING', 'SUSPECT', 'FAILED', 'REVOKED'] as const;
export type DistributedReplicaState = (typeof distributedReplicaStates)[number];

export const distributedProbeConsistencies = ['CONSISTENT', 'PARTIAL', 'UNKNOWN', 'DEGRADED'] as const;
export type DistributedProbeConsistency = (typeof distributedProbeConsistencies)[number];

export const distributedProbeOutcomes = ['CONSISTENT', 'PARTIAL', 'UNKNOWN', 'CANCELLED', 'FAILED'] as const;
export type DistributedProbeOutcome = (typeof distributedProbeOutcomes)[number];

export const distributedProbeStopReasons = [
  'NONE',
  'TIMEOUT',
  'CANCELLED',
  'NODE_UNAVAILABLE',
  'NODE_LAGGING',
  'QUORUM_UNMET',
  'SCOPE_DENIED',
] as const;
export type DistributedProbeStopReason = (typeof distributedProbeStopReasons)[number];

export const distributedNodeOutcomes = [
  'OK',
  'SCOPE_DENIED',
  'CLUSTER_EPOCH_MISMATCH',
  'VIEW_DIGEST_MISMATCH',
  'NODE_UNAVAILABLE',
  'TIMEOUT',
  'CANCELLED',
  'NOT_QUERIED',
  'LATE_DISCARDED',
] as const;
export type DistributedNodeOutcome = (typeof distributedNodeOutcomes)[number];

/** ADR-009 §8.1: scatter/gather budget stays below the 60s MCP timeout. */
export const DISTRIBUTED_PROBE_DEFAULT_DEADLINE_MS = 50_000;
export const DISTRIBUTED_PROBE_DEFAULT_NODE_TIMEOUT_MS = 5_000;
/** Process-wide node-query admission caps (T-157 / MNT-01). */
export const DISTRIBUTED_PROBE_DEFAULT_MAX_CONCURRENT_NODES = 64;
export const DISTRIBUTED_PROBE_DEFAULT_MAX_IN_FLIGHT_PER_NODE = 8;
export const DISTRIBUTED_PROBE_DEFAULT_MAX_QUEUED_NODES = 256;

export class DistributedProbeError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(`[${code}] ${message}`, options);
    this.name = 'DistributedProbeError';
    this.code = code;
  }
}

class DistributedProbeCancelled extends Error {
  constructor() {
    super('distributed probe cancelled');
    this.name = 'DistributedProbeCancelled';
  }
}

class DistributedProbeNodeTimeout extends Error {
  constructor() {
    super('replica node exceeded its budget');
    this.name = 'DistributedProbeNodeTimeout';
  }
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** One read-only replica participating in scatter. */
export interface DistributedReplicaNode {
  /** Stable node id used in `failed_nodes` and reports. */
  readonly replicaId: string;
  /** Read-only replica store (T-125 `ReplicaStore`, or any ProbeStore). */
  readonly store: ProbeStore;
  /** Declared scope; cross-scope nodes are refused without querying them. */
  readonly projectScope?: string;
  /** Declared cluster epoch; compared with `options.clusterEpoch` when set. */
  readonly clusterEpoch?: string | number;
  /** Explicit commit point override (otherwise read from the store metadata). */
  readonly commitIndex?: number;
  /** View digest at the node's commit point (AS_OF verification). */
  readonly viewDigest?: string;
  /** Explicit replica state override (otherwise derived from cluster metadata). */
  readonly state?: DistributedReplicaState;
  /** Declared evidence digest; always recomputed locally before it is trusted. */
  readonly evidenceDigest?: string;
  /**
   * Optional node query override. Production callers leave it unset and the
   * coordinator reads `store.candidates()`/`store.adjacency()`; tests and future
   * transports (T-127) use it to simulate latency, failures and payloads.
   */
  readonly query?: DistributedNodeQuery;
}

export interface DistributedNodeQueryContext {
  readonly request: AnchorProbeRequest;
  readonly signal: AbortSignal;
  readonly nodeTimeoutMs: number;
}

export type DistributedNodeQuery = (
  request: AnchorProbeRequest,
  context: DistributedNodeQueryContext,
) => DistributedNodeResponse | Promise<DistributedNodeResponse>;

/**
 * Raw node response. Everything here is untrusted: digests and commit points
 * are recomputed locally before they take part in a consistency decision.
 */
export interface DistributedNodeResponse {
  readonly candidates: readonly ProbeCandidate[];
  readonly edges?: readonly ProbeEdge[];
  readonly commitIndex?: number;
  readonly viewDigest?: string;
  readonly evidenceDigest?: string;
  readonly state?: DistributedReplicaState;
  readonly clusterEpoch?: string | number;
}

export interface DistributedProbeOptions {
  /** Requested retrieval-consistency mode. Defaults to LOCAL (current behaviour). */
  readonly mode?: DistributedProbeMode;
  /** Required for AS_OF: the target commit point C*. */
  readonly asOfCommitIndex?: number;
  /** Primary commit point C used by COMMITTED/QUORUM as the upper bound. */
  readonly primaryCommitIndex?: number;
  /** Expected primary view digest at the AS_OF target commit point. */
  readonly expectedViewDigest?: string;
  /** Explicit primary evidence digest override; otherwise recomputed locally. */
  readonly primaryEvidenceDigest?: string;
  /** When set, nodes declaring a different cluster epoch are refused. */
  readonly clusterEpoch?: string | number;
  /** Total scatter/gather wall-clock budget in milliseconds. */
  readonly deadlineMs?: number;
  /** Per-node budget in milliseconds; clamped to the remaining total budget. */
  readonly nodeTimeoutMs?: number;
  /** Cancellation signal; late results are discarded and listeners released. */
  readonly signal?: AbortSignal;
  /** Process-wide cap on node queries running at once (default 64). */
  readonly maxConcurrentNodes?: number;
  /** Per-replica cap on node queries running at once (default 8). */
  readonly maxInFlightPerNode?: number;
  /** Bound on the FIFO admission queue; overflow is refused (default 256). */
  readonly maxQueuedNodes?: number;
  /**
   * Freeze as soon as the requested mode's threshold is met (default true).
   * Only COMMITTED and QUORUM have such a threshold; AS_OF keeps merging every
   * qualifying response. Disable for the full-gather comparison arm.
   */
  readonly earlyFreeze?: boolean;
  /** Clock passed through to the reused `probe()` semantics. */
  readonly now?: string;
  /** Explicit routing dimensions passed through to `probe()`. */
  readonly entries?: readonly ProbeEntryQuery[];
}

/**
 * Alternative call shape: the local store and the replica list travel inside
 * the options object (`distributedProbe(request, { localStore, replicas, mode })`).
 */
export interface DistributedProbeCallOptions extends DistributedProbeOptions {
  readonly localStore: ProbeStore;
  readonly replicas?: readonly DistributedReplicaNode[];
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export interface DistributedProbePartial {
  /** `considered / requested` over distinct `(record_ref, content_hash)` pairs. */
  readonly coverage: number;
  readonly considered: number;
  readonly requested: number;
  /** Fact keys plus explicit distributed gap markers. */
  readonly gaps: readonly string[];
  readonly failed_nodes: readonly string[];
  readonly stop_reason: DistributedProbeStopReason;
}

export interface DistributedProbeConflict {
  readonly conflict_id: string;
  readonly kind: 'content_hash' | 'status' | 'commit' | 'cluster_epoch';
  readonly fact_key: string | null;
  readonly record_ref: string | null;
  readonly nodes: readonly string[];
  readonly content_hashes: readonly string[];
  readonly statuses: readonly string[];
  readonly commits: readonly number[];
  readonly epochs: readonly string[];
  readonly status: 'unresolved';
}

export interface DistributedCandidateFingerprint {
  readonly record_ref: string;
  readonly content_hash: string;
  readonly fact_key: string | null;
  readonly status: AnchorProbeRecordStatus;
  readonly sources: readonly string[];
}

export interface DistributedNodeReport {
  readonly replica_id: string;
  readonly outcome: DistributedNodeOutcome;
  readonly commit_index: number | null;
  readonly evidence_digest: string | null;
  readonly latency_ms: number;
  readonly detail: string;
  readonly used: boolean;
}

export interface DistributedProbeMetadata {
  /** Mode actually achieved (equal to `requested_mode` unless degraded). */
  readonly mode: DistributedProbeMode;
  readonly requested_mode: DistributedProbeMode;
  readonly consistency: DistributedProbeConsistency;
  /** Single origin per conclusion; remote and local evidence are never mixed. */
  readonly evidence_origin: 'local' | 'primary' | 'replica';
  readonly cluster_epoch: string | number;
  readonly commit_index?: number;
  readonly primary_commit_index?: number;
  readonly evidence_digest: string;
  readonly quorum_size: number;
  readonly quorum_count: number;
  readonly quorum_digests: readonly string[];
  readonly stale: boolean;
  /** True for AS_OF answers: historical evidence cannot drive current execution. */
  readonly historical: boolean;
  readonly degraded: boolean;
  readonly degradation_reason?: string;
  /** Max replica lag against the primary commit point; null when unknown. */
  readonly max_lag: number | null;
  readonly partial: boolean;
  readonly stop_reason: DistributedProbeStopReason;
}

export interface DistributedProbeAnswer {
  readonly request_id: string;
  readonly outcome: DistributedProbeOutcome;
  /** Achieved mode (see `metadata.mode`). */
  readonly mode: DistributedProbeMode;
  readonly requested_mode: DistributedProbeMode;
  readonly consistency: DistributedProbeConsistency;
  readonly degraded: boolean;
  readonly evidence_origin: 'local' | 'primary' | 'replica';
  readonly metadata: DistributedProbeMetadata;
  /** Reused AP-02 response; shape unchanged, distributed metadata lives beside it. */
  readonly response: AnchorProbeResponse;
  readonly candidates: readonly DistributedCandidateFingerprint[];
  readonly conflicts: readonly DistributedProbeConflict[];
  readonly partial: DistributedProbePartial;
  readonly nodes: readonly DistributedNodeReport[];
  readonly elapsed_ms: number;
  readonly resources_released: boolean;
}

// ---------------------------------------------------------------------------
// Internals: normalized options and node bookkeeping
// ---------------------------------------------------------------------------

interface NormalizedOptions {
  readonly mode: DistributedProbeMode;
  readonly asOfCommitIndex?: number;
  readonly primaryCommitIndex?: number;
  readonly expectedViewDigest?: string;
  readonly primaryEvidenceDigest?: string;
  readonly clusterEpoch?: string | number;
  readonly deadlineMs: number;
  readonly deadlineSet: boolean;
  readonly nodeTimeoutMs: number;
  readonly signal: AbortSignal;
  readonly limits: ProbeSchedulerLimits;
  readonly earlyFreeze: boolean;
  readonly now?: string;
  readonly entries?: readonly ProbeEntryQuery[];
}


function positiveIntegerOption(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new DistributedProbeError('DISTRIBUTED_PROBE_OPTIONS_INVALID', `${name} must be a positive integer, got ${String(value)}`);
  }
  return value;
}

function nonNegativeIntegerOption(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DistributedProbeError('DISTRIBUTED_PROBE_OPTIONS_INVALID', `${name} must be a non-negative integer, got ${String(value)}`);
  }
  return value;
}

function normalizeOptions(options: DistributedProbeOptions): NormalizedOptions {
  const mode = options.mode ?? 'LOCAL';
  if (!(distributedProbeModes as readonly string[]).includes(mode)) {
    throw new DistributedProbeError('DISTRIBUTED_PROBE_OPTIONS_INVALID', `unknown retrieval consistency mode ${JSON.stringify(mode)}`);
  }
  const deadlineMs = options.deadlineMs ?? DISTRIBUTED_PROBE_DEFAULT_DEADLINE_MS;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) {
    throw new DistributedProbeError('DISTRIBUTED_PROBE_OPTIONS_INVALID', `deadlineMs must be a positive integer, got ${String(options.deadlineMs)}`);
  }
  const nodeTimeoutMs = options.nodeTimeoutMs ?? DISTRIBUTED_PROBE_DEFAULT_NODE_TIMEOUT_MS;
  if (!Number.isSafeInteger(nodeTimeoutMs) || nodeTimeoutMs <= 0) {
    throw new DistributedProbeError('DISTRIBUTED_PROBE_OPTIONS_INVALID', `nodeTimeoutMs must be a positive integer, got ${String(options.nodeTimeoutMs)}`);
  }
  if (mode === 'AS_OF') {
    if (options.asOfCommitIndex === undefined) {
      throw new DistributedProbeError('DISTRIBUTED_PROBE_OPTIONS_INVALID', 'AS_OF mode requires asOfCommitIndex');
    }
    if (!Number.isSafeInteger(options.asOfCommitIndex) || options.asOfCommitIndex < 0) {
      throw new DistributedProbeError(
        'DISTRIBUTED_PROBE_OPTIONS_INVALID',
        `asOfCommitIndex must be a nonnegative integer, got ${String(options.asOfCommitIndex)}`,
      );
    }
  }
  const primaryCommitIndex = options.primaryCommitIndex;
  if (primaryCommitIndex !== undefined && (!Number.isSafeInteger(primaryCommitIndex) || primaryCommitIndex < 0)) {
    throw new DistributedProbeError(
      'DISTRIBUTED_PROBE_OPTIONS_INVALID',
      `primaryCommitIndex must be a nonnegative integer, got ${String(primaryCommitIndex)}`,
    );
  }
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
    throw new DistributedProbeError('DISTRIBUTED_PROBE_OPTIONS_INVALID', 'signal must be an AbortSignal');
  }
  if (options.earlyFreeze !== undefined && typeof options.earlyFreeze !== 'boolean') {
    throw new DistributedProbeError('DISTRIBUTED_PROBE_OPTIONS_INVALID', 'earlyFreeze must be a boolean');
  }
  return {
    mode,
    ...(options.asOfCommitIndex === undefined ? {} : { asOfCommitIndex: options.asOfCommitIndex }),
    ...(primaryCommitIndex === undefined ? {} : { primaryCommitIndex }),
    ...(options.expectedViewDigest === undefined ? {} : { expectedViewDigest: options.expectedViewDigest }),
    ...(options.primaryEvidenceDigest === undefined ? {} : { primaryEvidenceDigest: options.primaryEvidenceDigest }),
    ...(options.clusterEpoch === undefined ? {} : { clusterEpoch: options.clusterEpoch }),
    deadlineMs,
    deadlineSet: options.deadlineMs !== undefined,
    nodeTimeoutMs,
    signal: options.signal ?? new AbortController().signal,
    limits: {
      maxConcurrentNodes: positiveIntegerOption('maxConcurrentNodes', options.maxConcurrentNodes, DISTRIBUTED_PROBE_DEFAULT_MAX_CONCURRENT_NODES),
      maxInFlightPerNode: positiveIntegerOption('maxInFlightPerNode', options.maxInFlightPerNode, DISTRIBUTED_PROBE_DEFAULT_MAX_IN_FLIGHT_PER_NODE),
      maxQueuedNodes: nonNegativeIntegerOption('maxQueuedNodes', options.maxQueuedNodes, DISTRIBUTED_PROBE_DEFAULT_MAX_QUEUED_NODES),
    },
    earlyFreeze: options.earlyFreeze ?? true,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.entries === undefined ? {} : { entries: options.entries }),
  };
}



// ---------------------------------------------------------------------------
// Merged store handed back to the reused probe() core
// ---------------------------------------------------------------------------


class MergedProbeStore implements ProbeStore {
  readonly #snapshot: AnchorProbeSnapshot;
  readonly #candidates: readonly ProbeCandidate[];
  readonly #edges: readonly ProbeEdge[];

  constructor(snapshot: AnchorProbeSnapshot, candidates: readonly ProbeCandidate[], edges: readonly ProbeEdge[]) {
    this.#snapshot = snapshot;
    this.#candidates = candidates;
    this.#edges = edges;
  }

  get snapshot(): AnchorProbeSnapshot {
    return this.#snapshot;
  }

  candidates(query?: ProbeEntryQuery): readonly ProbeCandidate[] {
    if (query === undefined || Object.keys(query).length === 0) return this.#candidates;
    return this.#candidates.filter((candidate) => matchesEntryQuery(candidate, query));
  }

  adjacency(ref?: string): readonly ProbeEdge[] {
    if (ref === undefined) return this.#edges;
    return this.#edges.filter((edge) => edge.from === ref || edge.to === ref);
  }

  evidence(recordRef: string): ProbeEvidencePayload | undefined {
    const candidate = this.find(recordRef);
    return candidate === undefined
      ? undefined
      : {
        record_ref: candidate.record_ref,
        content_hash: candidate.content_hash,
        status: candidate.status,
        source_health: candidate.source_health,
        recorded_at: candidate.recorded_at,
        effective_from: candidate.effective_from,
        source: candidate.source,
        content: candidate.content,
      };
  }

  status(recordRef: string): ProbeStatusView | undefined {
    const candidate = this.find(recordRef);
    return candidate === undefined
      ? undefined
      : {
        record_ref: candidate.record_ref,
        status: candidate.status,
        eligibility: candidate.qualifiers.includes('legacy_unreviewed') ? 'legacy_unreviewed' : 'governed',
        version: candidate.version,
        superseded_by: candidate.superseded_by,
        effective_from: candidate.effective_from,
        effective_to: candidate.effective_to,
      };
  }

  provenance(recordRef: string): ProbeProvenanceView | undefined {
    const candidate = this.find(recordRef);
    return candidate === undefined
      ? undefined
      : {
        record_ref: candidate.record_ref,
        source: candidate.source,
        source_health: candidate.source_health,
        qualifiers: candidate.qualifiers,
        anchor: candidate.anchor,
      };
  }

  snapshotIdentity(): ProbeSnapshotIdentity {
    return probeSnapshotIdentity(this.#snapshot);
  }

  private find(recordRef: string): ProbeCandidate | undefined {
    return this.#candidates.find((candidate) => candidate.record_ref === recordRef);
  }
}

// ---------------------------------------------------------------------------
// Scatter
// ---------------------------------------------------------------------------

function defaultNodeResponse(node: DistributedReplicaNode): DistributedNodeResponse {
  return {
    candidates: node.store.candidates(),
    edges: node.store.adjacency(),
  };
}

async function runNode(
  info: NodeInfo,
  request: AnchorProbeRequest,
  options: NormalizedOptions,
  deadlineAt: number,
  controller: AbortController,
): Promise<NodeOutcome> {
  const started = Date.now();
  const latency = (): number => Date.now() - started;

  let snapshot: AnchorProbeSnapshot;
  try {
    snapshot = info.node.store.snapshot;
  } catch (error) {
    return failedOutcome(info.id, 'NODE_UNAVAILABLE', `snapshot unavailable: ${message(error)}`, latency());
  }

  // Scope routing happens before any query: a foreign-scope replica is never asked.
  const scope = info.node.projectScope ?? snapshot.cluster?.project_scope ?? snapshot.project_scope;
  if (scope !== request.project_scope) {
    return failedOutcome(
      info.id,
      'SCOPE_DENIED',
      `replica scope ${JSON.stringify(scope)} does not match request scope ${JSON.stringify(request.project_scope)}`,
      latency(),
    );
  }
  if (options.clusterEpoch !== undefined) {
    const epoch = info.node.clusterEpoch ?? snapshot.cluster?.cluster_epoch;
    if (epoch !== options.clusterEpoch) {
      return failedOutcome(
        info.id,
        'CLUSTER_EPOCH_MISMATCH',
        `replica cluster_epoch ${JSON.stringify(epoch)} does not match ${JSON.stringify(options.clusterEpoch)}`,
        latency(),
      );
    }
  }

  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) {
    return failedOutcome(info.id, 'TIMEOUT', 'overall deadline already exhausted before dispatch', latency());
  }
  if (options.signal.aborted) {
    return failedOutcome(info.id, 'CANCELLED', 'cancelled before dispatch', latency());
  }
  const waitBudget = Math.max(1, Math.min(options.nodeTimeoutMs, remaining));
  let slot: ProbeSlot;
  try {
    slot = await acquireProbeSlot({
      nodeId: info.id,
      limits: options.limits,
      signal: options.signal,
      waitTimeoutMs: waitBudget,
    });
  } catch (error) {
    if (error instanceof ProbeSlotCancelledError) {
      return failedOutcome(info.id, 'CANCELLED', 'cancelled while waiting for a scheduler slot', latency());
    }
    if (error instanceof ProbeSlotTimeoutError) {
      return failedOutcome(info.id, 'TIMEOUT', `waited ${String(waitBudget)}ms for a scheduler slot`, latency());
    }
    if (error instanceof ProbeCapacityError) {
      return failedOutcome(info.id, 'NODE_UNAVAILABLE', `scheduler refused the node query: ${error.message}`, latency());
    }
    throw error;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  let signal: AbortSignal | undefined;
  let nodeBudget = 1;
  try {
    // Admission waiting counts against the same node and overall budgets; the
    // clamped budget below turns an exhausted one into an immediate timeout.
    const afterAdmission = deadlineAt - Date.now();
    nodeBudget = Math.max(1, Math.min(options.nodeTimeoutMs, afterAdmission));
    // The internal controller lets an early freeze abandon this node query
    // without touching the caller's signal; the caller signal still wins.
    signal = AbortSignal.any([options.signal, controller.signal]);
    const combined = signal;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new DistributedProbeNodeTimeout()), nodeBudget);
    });
    const abortPromise = new Promise<never>((_resolve, reject) => {
      if (combined.aborted) {
        reject(new DistributedProbeCancelled());
        return;
      }
      const onAbort = (): void => reject(new DistributedProbeCancelled());
      abortListener = onAbort;
      combined.addEventListener('abort', onAbort, { once: true });
    });

    const query = info.node.query ?? (() => defaultNodeResponse(info.node));
    const raw = query(request, { request, signal: combined, nodeTimeoutMs: nodeBudget });
    const response = await Promise.race([Promise.resolve(raw), timeoutPromise, abortPromise]);
    if (options.signal.aborted) {
      return failedOutcome(info.id, 'CANCELLED', 'node result discarded after cancellation', latency());
    }
    // A response that races an early freeze is ignored on purpose: the frozen
    // set was pinned before the internal controller was aborted, so this node
    // could never be adopted anyway. Its slot is released by the finally block.
    // The response's declared epoch overrides the node/snapshot declaration in
    // `successOutcome`, so admission must check it too: otherwise a node could
    // pass the handshake on one epoch and answer for another, joining a quorum
    // it does not belong to (ADR-011 §11 CLUSTER_EPOCH_MISMATCH).
    if (
      options.clusterEpoch !== undefined
      && response.clusterEpoch !== undefined
      && response.clusterEpoch !== options.clusterEpoch
    ) {
      return failedOutcome(
        info.id,
        'CLUSTER_EPOCH_MISMATCH',
        `replica response cluster_epoch ${JSON.stringify(response.clusterEpoch)} does not match ${JSON.stringify(options.clusterEpoch)}`,
        latency(),
      );
    }
    return successOutcome(info, snapshot, response, latency());
  } catch (error) {
    if (options.signal.aborted) {
      return failedOutcome(info.id, 'CANCELLED', 'cancelled by caller', latency());
    }
    if (controller.signal.aborted) {
      return failedOutcome(info.id, 'CANCELLED', 'node query abandoned after early freeze', latency());
    }
    if (error instanceof DistributedProbeNodeTimeout) {
      return failedOutcome(info.id, 'TIMEOUT', `replica exceeded its ${nodeBudget}ms node budget`, latency());
    }
    return failedOutcome(info.id, 'NODE_UNAVAILABLE', message(error), latency());
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abortListener !== undefined && signal !== undefined) signal.removeEventListener('abort', abortListener);
    slot.release();
  }
}

function successOutcome(
  info: NodeInfo,
  snapshot: AnchorProbeSnapshot,
  response: DistributedNodeResponse,
  latencyMs: number,
): NodeOutcome {
  if (response === null || typeof response !== 'object' || !Array.isArray(response.candidates)) {
    return failedOutcome(info.id, 'NODE_UNAVAILABLE', 'node response must carry a candidates array', latencyMs);
  }
  if (response.edges !== undefined && !Array.isArray(response.edges)) {
    return failedOutcome(info.id, 'NODE_UNAVAILABLE', 'node response edges must be an array', latencyMs);
  }
  const candidates = response.candidates as readonly ProbeCandidate[];
  if (candidates.some((candidate) => candidate === null || typeof candidate !== 'object' || typeof candidate.record_ref !== 'string')) {
    return failedOutcome(info.id, 'NODE_UNAVAILABLE', 'node response contains a malformed candidate', latencyMs);
  }
  let digest: string;
  try {
    digest = digestCandidates(candidates);
  } catch (error) {
    return failedOutcome(info.id, 'NODE_UNAVAILABLE', `node candidates failed digest recomputation: ${message(error)}`, latencyMs);
  }
  // Remote declarations are untrusted: a declared digest that disagrees with
  // the recomputed one disqualifies the node (VIEW_DIGEST_MISMATCH).
  const declaredDigest = response.evidenceDigest ?? info.node.evidenceDigest;
  if (declaredDigest !== undefined && declaredDigest !== digest) {
    return failedOutcome(
      info.id,
      'VIEW_DIGEST_MISMATCH',
      `declared evidence_digest ${declaredDigest} does not match recomputed ${digest}`,
      latencyMs,
    );
  }

  let storeCommitIndex: number | undefined;
  try {
    storeCommitIndex = info.node.store.replicaCommitIndex?.();
  } catch {
    storeCommitIndex = undefined;
  }
  const commitIndex = response.commitIndex
    ?? info.node.commitIndex
    ?? storeCommitIndex
    ?? snapshot.cluster?.replica_commit_index
    ?? snapshot.cluster?.commit_index;
  if (commitIndex === undefined) {
    return failedOutcome(info.id, 'NODE_UNAVAILABLE', 'replica commit_index is unknown', latencyMs);
  }

  const state = response.state
    ?? info.node.state
    ?? (snapshot.cluster?.partial === true ? 'LAGGING' : 'ACTIVE');
  if (state === 'REVOKED' || state === 'FAILED' || state === 'SUSPECT' || state === 'JOINING') {
    return failedOutcome(info.id, 'NODE_UNAVAILABLE', `replica state ${state} is not serviceable`, latencyMs);
  }

  return {
    status: 'ok',
    success: {
      id: info.id,
      snapshot,
      candidates,
      edges: response.edges ?? [],
      commitIndex,
      digest,
      viewDigest: response.viewDigest ?? info.node.viewDigest ?? null,
      state,
      epoch: response.clusterEpoch ?? info.node.clusterEpoch ?? snapshot.cluster?.cluster_epoch ?? '',
      latencyMs,
    },
  };
}

function failedOutcome(
  id: string,
  code: Exclude<DistributedNodeOutcome, 'OK' | 'NOT_QUERIED'>,
  detail: string,
  latency: number,
): NodeOutcome {
  return { status: 'failed', failure: { id, code, detail, latencyMs: latency } };
}

interface FreezeContext {
  readonly enabled: boolean;
  readonly mode: DistributedProbeMode;
  readonly primaryCommitIndex?: number;
  readonly primaryDigest?: string;
  readonly quorumSize: number;
}

interface DistributedScatterResult extends ScatterResult {
  readonly frozen?: boolean;
}

function lateOutcome(id: string): NodeOutcome {
  return {
    status: 'failed',
    failure: {
      id,
      code: 'LATE_DISCARDED',
      detail: 'late result discarded after early freeze',
      latencyMs: 0,
    },
  };
}

/**
 * The two thresholds that can be met before every node answers. QUORUM is safe
 * because `quorumSize = ceil((N+1)/2) > N/2`: two groups with distinct digests
 * can never both reach it. Freezing only on a group at the full primary commit
 * also preserves the "freshest achievable commit" rule — a lagging quorum seen
 * now could be replaced by a fresher one later, so those keep gathering.
 */
function freezeReached(freeze: FreezeContext, successes: readonly NodeSuccess[]): boolean {
  if (!freeze.enabled) return false;
  if (freeze.mode === 'QUORUM') {
    if (freeze.primaryCommitIndex === undefined) return false;
    const counts = new Map<string, number>();
    for (const success of successes) {
      if (success.commitIndex !== freeze.primaryCommitIndex) continue;
      const next = (counts.get(success.digest) ?? 0) + 1;
      if (next >= freeze.quorumSize) return true;
      counts.set(success.digest, next);
    }
    return false;
  }
  if (freeze.mode === 'COMMITTED') {
    const commit = freeze.primaryCommitIndex;
    const digest = freeze.primaryDigest;
    if (commit === undefined || digest === undefined) return false;
    return successes.some((success) => success.commitIndex >= commit && success.digest === digest);
  }
  // AS_OF has no quorum threshold: its answer merges every qualifying node.
  return false;
}

async function scatterNodes(
  infos: readonly NodeInfo[],
  request: AnchorProbeRequest,
  options: NormalizedOptions,
  deadlineAt: number,
  freeze: FreezeContext,
): Promise<DistributedScatterResult> {
  if (infos.length === 0) return { outcomes: [], aborted: false, elapsedMs: 0 };
  if (options.signal.aborted) return { outcomes: [], aborted: true, elapsedMs: 0 };
  const started = Date.now();
  const settled = new Map<string, NodeOutcome>();
  const successes: NodeSuccess[] = [];
  const controllers = new Map<string, AbortController>();
  let frozen = false;
  let resolveFrozen!: () => void;
  const frozenPromise = new Promise<'frozen'>((resolve) => {
    resolveFrozen = () => resolve('frozen');
  });
  let abortListener: (() => void) | undefined;
  const abortPromise = new Promise<'aborted'>((resolve) => {
    if (options.signal.aborted) {
      resolve('aborted');
      return;
    }
    const onAbort = (): void => resolve('aborted');
    abortListener = onAbort;
    options.signal.addEventListener('abort', onAbort, { once: true });
  });
  const tasks = infos.map((info) => {
    const controller = new AbortController();
    controllers.set(info.id, controller);
    return runNode(info, request, options, deadlineAt, controller)
      .then((outcome) => {
        settled.set(info.id, outcome);
        if (outcome.status === 'ok') {
          successes.push(outcome.success);
          if (!frozen && freezeReached(freeze, successes)) {
            frozen = true;
            resolveFrozen();
          }
        }
      })
      .finally(() => {
        controllers.delete(info.id);
      });
  });
  let result: 'all' | 'aborted' | 'frozen';
  try {
    result = await Promise.race<'all' | 'aborted' | 'frozen'>([
      Promise.all(tasks).then(() => 'all' as const),
      abortPromise,
      frozenPromise,
    ]);
  } finally {
    if (abortListener !== undefined) options.signal.removeEventListener('abort', abortListener);
  }
  const elapsedMs = Date.now() - started;
  if (result === 'aborted') {
    // Late settlements are still handled inside runNode (it never rejects); the
    // coordinator deliberately does not adopt them.
    return { outcomes: [], aborted: true, elapsedMs };
  }
  if (result === 'frozen') {
    // Pin the frozen set before aborting: a node that settles during the abort
    // must not turn into a used success or a real failure.
    const pinned = new Map(settled);
    for (const info of infos) {
      if (pinned.has(info.id)) continue;
      controllers.get(info.id)?.abort();
    }
    return {
      outcomes: infos.map((info) => pinned.get(info.id) ?? lateOutcome(info.id)),
      aborted: false,
      elapsedMs,
      frozen: true,
    };
  }
  return { outcomes: infos.map((info) => settled.get(info.id) ?? lateOutcome(info.id)), aborted: false, elapsedMs };
}

// ---------------------------------------------------------------------------
// Answer assembly
// ---------------------------------------------------------------------------


function probeOptions(options: NormalizedOptions, deadlineMs?: number): ProbeRunOptions {
  return {
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.entries === undefined ? {} : { entries: options.entries }),
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
  };
}



function localSnapshotOf(localStore: ProbeStore): AnchorProbeSnapshot | null {
  try {
    return localStore.snapshot;
  } catch {
    return null;
  }
}

function localCommitIndex(localStore: ProbeStore, snapshot: AnchorProbeSnapshot | null): number | undefined {
  let fromStore: number | undefined;
  try {
    fromStore = localStore.replicaCommitIndex?.();
  } catch {
    fromStore = undefined;
  }
  return fromStore ?? snapshot?.cluster?.commit_index;
}

function localCandidates(localStore: ProbeStore): readonly ProbeCandidate[] {
  try {
    return localStore.candidates();
  } catch {
    return [];
  }
}

function localEvidenceDigest(localStore: ProbeStore, snapshot: AnchorProbeSnapshot | null): string | undefined {
  try {
    return digestCandidates(localCandidates(localStore));
  } catch {
    return undefined;
  }
}


// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Run one AnchorProbe request against a local store and N replica stores.
 *
 * - `mode` selects the only judgment applied to this query (LOCAL / AS_OF /
 *   COMMITTED / QUORUM); a degraded answer reports the mode actually achieved.
 * - scatter is parallel and per-node bounded; a slow, failing or foreign-scope
 *   node never blocks the others.
 * - gather dedups by `(record_ref, content_hash)` and keeps every conflicting
 *   variant visible instead of picking a winner.
 * - the merged fact set is produced by the unchanged `probe()` core, so LOCAL
 *   and degraded-to-local answers carry identical fact semantics.
 */
export function distributedProbe(rawRequest: unknown, options: DistributedProbeCallOptions): Promise<DistributedProbeAnswer>;
export function distributedProbe(
  rawRequest: unknown,
  localStore: ProbeStore,
  replicas?: readonly DistributedReplicaNode[],
  options?: DistributedProbeOptions,
): Promise<DistributedProbeAnswer>;
export async function distributedProbe(
  rawRequest: unknown,
  localOrOptions: ProbeStore | DistributedProbeCallOptions,
  replicas: readonly DistributedReplicaNode[] = [],
  options: DistributedProbeOptions = {},
): Promise<DistributedProbeAnswer> {
  const startedAt = Date.now();
  let localStore: ProbeStore;
  let nodes: readonly DistributedReplicaNode[];
  let effectiveOptions: DistributedProbeOptions;
  const maybeStore = localOrOptions as ProbeStore;
  if (isProbeStore(maybeStore)) {
    localStore = maybeStore;
    nodes = replicas;
    effectiveOptions = options;
  } else {
    const call = localOrOptions as DistributedProbeCallOptions;
    localStore = call.localStore;
    nodes = call.replicas ?? [];
    effectiveOptions = call;
  }
  let request: AnchorProbeRequest;
  try {
    request = anchorProbeRequestSchema.parse(rawRequest);
  } catch (error) {
    throw new ProbeRequestError('AnchorProbe request failed schema validation', { cause: error });
  }
  if (localStore === null || typeof localStore !== 'object' || typeof localStore.candidates !== 'function') {
    throw new DistributedProbeError('DISTRIBUTED_PROBE_OPTIONS_INVALID', 'localStore must be a ProbeStore');
  }
  if (!Array.isArray(nodes)) {
    throw new DistributedProbeError('DISTRIBUTED_PROBE_OPTIONS_INVALID', 'replicas must be an array');
  }
  const infos: NodeInfo[] = nodes.map((node, index) => {
    if (node === null || typeof node !== 'object' || node.store === null || typeof node.store !== 'object') {
      throw new DistributedProbeError('DISTRIBUTED_PROBE_OPTIONS_INVALID', `replicas[${String(index)}] must carry a ProbeStore`);
    }
    return { node, id: node.replicaId || `replica-${String(index)}` };
  });
  const ids = infos.map((info) => info.id);
  if (new Set(ids).size !== ids.length) {
    throw new DistributedProbeError('DISTRIBUTED_PROBE_OPTIONS_INVALID', 'replica ids must be unique');
  }

  const normalized = normalizeOptions(effectiveOptions);
  const localSnap = localSnapshotOf(localStore);
  const requestedMode = normalized.mode;

  // LOCAL never touches a replica: current behaviour is preserved exactly.
  if (requestedMode === 'LOCAL') {
    const response = probe(rawRequest, localStore, probeOptions(normalized, normalized.deadlineSet ? normalized.deadlineMs : undefined));
    const candidates = safeFingerprints(localCandidates(localStore));
    const failedNodes = response.execution_status === 'FAILED' ? ['local'] : [];
    const consistency = consistencyFromResponse(response);
    const localCommit = localCommitIndex(localStore, localSnap);
    return assembleAnswer({
      request,
      response,
      candidates,
      conflicts: [],
      failedNodes,
      nodeReports: nodeReports(infos, [], new Set<string>(), {
        outcome: response.execution_status === 'FAILED' ? 'NODE_UNAVAILABLE' : 'OK',
        detail: 'local store answered the request',
        used: true,
      }),
      mode: 'LOCAL',
      requestedMode: 'LOCAL',
      consistency,
      degraded: false,
      stopReason: 'NONE',
      origin: 'local',
      evidenceDigest: digestOrEmpty(candidates),
      clusterEpoch: localSnap?.cluster?.cluster_epoch ?? '',
      ...(localCommit === undefined ? {} : { commitIndex: localCommit }),
      quorumSize: 0,
      quorumCount: 0,
      quorumDigests: [],
      stale: false,
      historical: false,
      maxLag: null,
      considered: candidates.length,
      requested: candidates.length,
      gaps: response.gaps.map((gap) => gap.fact_key),
      elapsedMs: Date.now() - startedAt,
      resourcesReleased: true,
    });
  }

  const primaryCommitIndex = normalized.primaryCommitIndex ?? localCommitIndex(localStore, localSnap);
  const primaryDigest = normalized.primaryEvidenceDigest ?? localEvidenceDigest(localStore, localSnap);
  const replicaCount = infos.length;
  const quorumSize = Math.ceil((replicaCount + 1) / 2);
  const freeze: FreezeContext = {
    enabled: normalized.earlyFreeze,
    mode: requestedMode,
    ...(primaryCommitIndex === undefined ? {} : { primaryCommitIndex }),
    ...(primaryDigest === undefined ? {} : { primaryDigest }),
    quorumSize,
  };
  const deadlineAt = startedAt + normalized.deadlineMs;
  const scatter = await scatterNodes(infos, request, normalized, deadlineAt, freeze);
  const elapsedMs = Date.now() - startedAt;

  if (scatter.aborted || normalized.signal.aborted) {
    const response = cancelledResponse(request, localSnap);
    return assembleAnswer({
      request,
      response,
      candidates: [],
      conflicts: [],
      failedNodes: [],
      nodeReports: nodeReports(infos, [], new Set<string>(), { outcome: 'CANCELLED', detail: 'cancelled before adoption', used: false }),
      mode: requestedMode,
      requestedMode,
      consistency: 'UNKNOWN',
      degraded: false,
      stopReason: 'CANCELLED',
      origin: 'local',
      evidenceDigest: digestCandidates([]),
      clusterEpoch: normalized.clusterEpoch ?? localSnap?.cluster?.cluster_epoch ?? '',
      quorumSize: 0,
      quorumCount: 0,
      quorumDigests: [],
      stale: false,
      historical: requestedMode === 'AS_OF',
      maxLag: null,
      considered: 0,
      requested: 0,
      gaps: ['cancelled'],
      elapsedMs,
      resourcesReleased: true,
    });
  }

  const outcomes = scatter.outcomes;
  const failures: NodeFailure[] = [];
  const successes: NodeSuccess[] = [];
  for (const outcome of outcomes) {
    if (outcome.status === 'ok') successes.push(outcome.success);
    else failures.push(outcome.failure);
  }
  const failedNodes = uniqueSorted(
    failures.filter((failure) => failure.code !== 'LATE_DISCARDED').map((failure) => failure.id),
  );

  const allGather = gatherCandidates(successes);
  const contentConflicts = allGather.conflicts;
  const epochConflicts = commitConflicts(successes);
  const conflicts = assignConflictIds([...contentConflicts, ...epochConflicts]);

  const maxLag = successes.length === 0 || primaryCommitIndex === undefined
    ? null
    : Math.max(0, ...successes.map((success) => primaryCommitIndex - success.commitIndex));

  // Degradation helper: reuse the local store and annotate, never silently claim
  // the requested mode was reached.
  const degradeToLocal = (reason: string, stopReason: DistributedProbeStopReason, extraGaps: readonly string[] = []): DistributedProbeAnswer => {
    const response = probe(rawRequest, localStore, probeOptions(normalized));
    const candidates = safeFingerprints(localCandidates(localStore));
    const localFailed = response.execution_status === 'FAILED';
    const degradedNodes = localFailed ? [...failedNodes, 'local'] : failedNodes;
    const consistency: DistributedProbeConsistency = response.execution_status === 'FAILED' ? 'UNKNOWN' : 'PARTIAL';
    const degradedCommit = localCommitIndex(localStore, localSnap);
    return assembleAnswer({
      request,
      response,
      candidates,
      conflicts,
      failedNodes: uniqueSorted(degradedNodes),
      nodeReports: nodeReports(infos, outcomes, new Set<string>(), {
        outcome: localFailed ? 'NODE_UNAVAILABLE' : 'OK',
        detail: 'degraded to the local store',
        used: true,
      }),
      mode: 'LOCAL',
      requestedMode,
      consistency,
      degraded: true,
      degradationReason: reason,
      stopReason,
      origin: 'local',
      evidenceDigest: digestOrEmpty(candidates),
      clusterEpoch: normalized.clusterEpoch ?? localSnap?.cluster?.cluster_epoch ?? '',
      ...(degradedCommit === undefined ? {} : { commitIndex: degradedCommit }),
      ...(primaryCommitIndex === undefined ? {} : { primaryCommitIndex }),
      quorumSize,
      quorumCount: 0,
      quorumDigests: [],
      stale: false,
      historical: requestedMode === 'AS_OF',
      maxLag,
      considered: candidates.length,
      requested: candidates.length,
      gaps: [...response.gaps.map((gap) => gap.fact_key), ...extraGaps],
      elapsedMs: Date.now() - startedAt,
      resourcesReleased: true,
    });
  };

  if (successes.length === 0) {
    const deadlineHit = Date.now() >= deadlineAt || failures.some((failure) => failure.code === 'TIMEOUT');
    return degradeToLocal(
      deadlineHit ? 'TIMEOUT' : (replicaCount === 0 ? 'NO_REPLICA_CONFIGURED' : 'NODE_UNAVAILABLE'),
      deadlineHit ? 'TIMEOUT' : 'NODE_UNAVAILABLE',
      replicaCount === 0 ? ['no-replica'] : [],
    );
  }

  let used = successes;
  let achievedMode: DistributedProbeMode = requestedMode;
  let degraded = false;
  let degradationReason: string | undefined;
  let stopReason: DistributedProbeStopReason = 'NONE';
  let consistency: DistributedProbeConsistency = 'CONSISTENT';
  let commitIndex: number | undefined;
  let achievedQuorumSize = 0;
  let achievedQuorumCount = successes.length;
  let achievedQuorumDigests: string[] = uniqueSorted(successes.map((success) => success.digest));
  let stale = false;
  let gaps: string[] = [];

  if (requestedMode === 'AS_OF') {
    const target = normalized.asOfCommitIndex as number;
    const expected = normalized.expectedViewDigest;
    const qualifying = successes.filter((success) =>
      success.commitIndex >= target && (expected === undefined || success.viewDigest === expected));
    if (qualifying.length === 0) {
      used = successes;
      commitIndex = Math.max(...successes.map((success) => success.commitIndex));
      achievedQuorumCount = 0;
      achievedQuorumDigests = [];
      stale = true;
      consistency = 'UNKNOWN';
      stopReason = 'NODE_LAGGING';
      gaps = [`as_of:${String(target)}`];
    } else {
      used = qualifying;
      commitIndex = target;
      achievedQuorumCount = qualifying.length;
      achievedQuorumDigests = uniqueSorted(qualifying.map((success) => success.digest));
      stale = false;
      consistency = failedNodes.length === 0 && conflicts.length === 0 ? 'CONSISTENT' : 'PARTIAL';
      if (expected !== undefined) {
        const digestMismatch = successes.some((success) =>
          success.commitIndex >= target && success.viewDigest !== expected);
        if (digestMismatch) {
          consistency = 'PARTIAL';
          gaps = [...gaps, 'view-digest-mismatch'];
        }
      }
    }
  } else if (requestedMode === 'COMMITTED') {
    if (primaryCommitIndex === undefined) {
      return degradeToLocal('PRIMARY_COMMIT_UNKNOWN', 'QUORUM_UNMET', ['primary-commit-unknown']);
    }
    const qualifying = successes.filter((success) => success.commitIndex >= primaryCommitIndex && success.digest === primaryDigest);
    if (qualifying.length === 0) {
      return degradeToLocal('NO_REPLICA_CAUGHT_UP', 'QUORUM_UNMET', [`committed:${String(primaryCommitIndex)}`]);
    }
    used = qualifying;
    commitIndex = primaryCommitIndex;
    achievedQuorumSize = 1;
    achievedQuorumCount = qualifying.length;
    achievedQuorumDigests = primaryDigest === undefined ? [] : [primaryDigest];
    stale = false;
    consistency = failedNodes.length === 0 && conflicts.length === 0 ? 'CONSISTENT' : 'PARTIAL';
  } else {
    // QUORUM: >= ceil((N+1)/2) replicas at one commit point with equal digests.
    if (primaryCommitIndex === undefined) {
      return degradeToLocal('PRIMARY_COMMIT_UNKNOWN', 'QUORUM_UNMET', ['primary-commit-unknown']);
    }
    const groups = new Map<string, { commitIndex: number; digest: string; members: NodeSuccess[] }>();
    for (const success of successes) {
      if (success.commitIndex > primaryCommitIndex) continue;
      const key = `${String(success.commitIndex)}${DEDUPE_SEPARATOR}${success.digest}`;
      const group = groups.get(key);
      if (group === undefined) groups.set(key, { commitIndex: success.commitIndex, digest: success.digest, members: [success] });
      else group.members.push(success);
    }
    const eligible = [...groups.values()]
      .filter((group) => group.members.length >= quorumSize)
      .sort((left, right) => right.commitIndex - left.commitIndex || compareStrings(left.digest, right.digest));
    const best = eligible[0];
    if (best !== undefined) {
      used = best.members;
      achievedMode = 'QUORUM';
      commitIndex = best.commitIndex;
      achievedQuorumSize = quorumSize;
      achievedQuorumCount = best.members.length;
      achievedQuorumDigests = [best.digest];
      stale = best.commitIndex < primaryCommitIndex;
      consistency = failedNodes.length === 0 && conflicts.length === 0 ? 'CONSISTENT' : 'PARTIAL';
    } else {
      const committed = successes.filter((success) => success.commitIndex >= primaryCommitIndex && success.digest === primaryDigest);
      if (committed.length > 0) {
        // Explicit QUORUM -> COMMITTED downgrade; the answer says so.
        achievedMode = 'COMMITTED';
        degraded = true;
        degradationReason = 'QUORUM_UNMET';
        stopReason = 'QUORUM_UNMET';
        used = committed;
        commitIndex = primaryCommitIndex;
        achievedQuorumSize = 1;
        achievedQuorumCount = committed.length;
        achievedQuorumDigests = primaryDigest === undefined ? [] : [primaryDigest];
        consistency = 'PARTIAL';
        gaps = [`quorum:${String(primaryCommitIndex)}`];
      } else {
        return degradeToLocal('QUORUM_UNMET', 'QUORUM_UNMET', [`quorum:${String(primaryCommitIndex)}`]);
      }
    }
  }

  // Overall deadline: if the budget was exhausted, the answer must say TIMEOUT
  // and stay partial even when some nodes finished.
  if (normalized.signal.aborted) {
    const response = cancelledResponse(request, localSnap);
    return assembleAnswer({
      request,
      response,
      candidates: [],
      conflicts: [],
      failedNodes,
      nodeReports: nodeReports(infos, outcomes, new Set<string>(), { outcome: 'CANCELLED', detail: 'cancelled before adoption', used: false }),
      mode: achievedMode,
      requestedMode,
      consistency: 'UNKNOWN',
      degraded,
      stopReason: 'CANCELLED',
      origin: 'local',
      evidenceDigest: digestCandidates([]),
      clusterEpoch: normalized.clusterEpoch ?? localSnap?.cluster?.cluster_epoch ?? '',
      ...(primaryCommitIndex === undefined ? {} : { primaryCommitIndex }),
      quorumSize: achievedQuorumSize,
      quorumCount: achievedQuorumCount,
      quorumDigests: achievedQuorumDigests,
      stale,
      historical: requestedMode === 'AS_OF',
      maxLag,
      considered: 0,
      requested: 0,
      gaps: ['cancelled'],
      elapsedMs: Date.now() - startedAt,
      resourcesReleased: true,
    });
  }
  const timedOut = Date.now() >= deadlineAt;
  if (timedOut && stopReason === 'NONE') {
    stopReason = 'TIMEOUT';
    consistency = 'PARTIAL';
    gaps = [...gaps, 'deadline'];
  }

  const usedGather = gatherCandidates(used);
  const representative = [...used].sort((left, right) => compareStrings(left.id, right.id))[0];
  const responseSnapshot = representative?.snapshot ?? localSnap ?? fallbackSnapshot(request);
  const store = new MergedProbeStore(responseSnapshot, usedGather.merged, usedGather.edges);
  const remaining = deadlineAt - Date.now();
  const response = injectDistributedConflicts(
    probe(rawRequest, store, probeOptions(normalized, remaining <= 0 ? 0 : remaining)),
    conflicts,
  );

  const usedIds = new Set(used.map((success) => success.id));
  const partialGaps = [...response.gaps.map((gap) => gap.fact_key), ...gaps];
  return assembleAnswer({
    request,
    response,
    candidates: usedGather.fingerprints,
    conflicts,
    failedNodes,
    nodeReports: nodeReports(infos, outcomes, usedIds, { outcome: 'OK', detail: 'local store supplied the primary commit point', used: false }),
    mode: achievedMode,
    requestedMode,
    consistency,
    degraded,
    ...(degradationReason === undefined ? {} : { degradationReason }),
    stopReason,
    origin: 'replica',
    evidenceDigest: digestCandidates(usedGather.merged),
    clusterEpoch: normalized.clusterEpoch ?? representative?.epoch ?? localSnap?.cluster?.cluster_epoch ?? '',
    ...(commitIndex === undefined ? {} : { commitIndex }),
    ...(primaryCommitIndex === undefined ? {} : { primaryCommitIndex }),
    quorumSize: achievedQuorumSize,
    quorumCount: achievedQuorumCount,
    quorumDigests: achievedQuorumDigests,
    stale,
    historical: requestedMode === 'AS_OF',
    maxLag,
    considered: usedGather.considered,
    requested: usedGather.requested,
    gaps: partialGaps,
    elapsedMs: Date.now() - startedAt,
    resourcesReleased: true,
  });
}

