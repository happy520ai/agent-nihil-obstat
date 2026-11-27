import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  distributedReplicaStates,
  type DistributedNodeQuery,
  type DistributedNodeResponse,
  type DistributedReplicaNode,
  type DistributedReplicaState,
} from './distributed-probe.ts';
import {
  anchorProbeClusterMetadataSchema,
  type AnchorProbeClusterMetadata,
  type AnchorProbeRequest,
  type AnchorProbeSnapshot,
} from './probe-contract.ts';
import {
  probeSnapshotIdentity,
  ProbeStoreCacheError,
  type ProbeEvidencePayload,
  type ProbeProvenanceView,
  type ProbeSnapshotIdentity,
  type ProbeStatusView,
  type ProbeStore,
} from './probe-store.ts';
import type { ProbeCandidate, ProbeEdge, ProbeEntryQuery } from './probe.ts';
import {
  REPLICA_WORKER_MAX_MESSAGE_BYTES,
  REPLICA_WORKER_DEFAULT_HEARTBEAT_MS,
  parseWorkerResponse,
  replicaWorkerMessageTypes,
  type ReplicaWorkerMessageType,
  type ReplicaWorkerRequest,
  type ReplicaWorkerResponse,
} from './replica-worker.ts';
import type { CommittedEventEnvelope, ReplicationReport } from './replication.ts';

/**
 * T-127 / ADR-011 §8.2: parent-side transport and replica lifecycle.
 *
 * `ReplicaTransport` is the only seam a future cross-machine implementation
 * would replace. This module ships exactly one implementation,
 * `ChildProcessReplicaTransport`, which hosts each replica in its own OS
 * process over stdio. It opens no listening socket, performs no service
 * discovery and makes no network egress — cross-machine transport stays
 * unimplemented and unclaimed (ADR-011 §8.2/§9.4).
 *
 * Lifecycle guarantees:
 * - explicit `start`/`stop`; `stop` always releases the child handle and never
 *   leaves a live process behind;
 * - a crashed or killed child flips `isAlive` to false and fails pending and
 *   future requests immediately (`REPLICA_NODE_EXITED`), never by hanging;
 * - `restart()` re-launches the worker against the same replica directory, so
 *   the persisted cursor restores the previous commit point, and
 *   `resume(handle, pull)` continues replication strictly after that cursor;
 * - every request is bounded in size and supports `AbortSignal`/node timeout;
 *   cancellation abandons the request without killing the worker.
 */

// ---------------------------------------------------------------------------
// Vocabulary and defaults
// ---------------------------------------------------------------------------

/** The only transports this version implements. `'tcp'`/`'websocket'` are NOT implemented. */
export const REPLICA_TRANSPORT_KINDS = ['in-process', 'child-process'] as const;
export type ReplicaTransportKind = (typeof REPLICA_TRANSPORT_KINDS)[number];

export const REPLICA_TRANSPORT_DEFAULT_START_TIMEOUT_MS = 20_000;
export const REPLICA_TRANSPORT_DEFAULT_NODE_TIMEOUT_MS = 5_000;
export const REPLICA_TRANSPORT_DEFAULT_STOP_TIMEOUT_MS = 4_000;
/** ADR-011 §8.1: response ceiling 16 MiB; the request ceiling matches the worker's 1 MiB. */
export const REPLICA_TRANSPORT_DEFAULT_RESPONSE_BYTES = 16 * 1024 * 1024;
export const REPLICA_TRANSPORT_DEFAULT_REQUEST_BYTES = REPLICA_WORKER_MAX_MESSAGE_BYTES;
/** T-158: how long a cancel may stay unacknowledged before releasing the child. */
export const REPLICA_TRANSPORT_DEFAULT_CANCEL_GRACE_MS = 250;

export class ReplicaTransportError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(`[${code}] ${message}`, options);
    this.name = 'ReplicaTransportError';
    this.code = code;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export interface ReplicaStartOptions {
  /** Project root; the replica writes only `<root>/.ano/replicas/<replicaId>/`. */
  readonly root: string;
  readonly replicaId: string;
  readonly projectScope: string;
  readonly clusterEpoch?: string | number;
  /** Base graph/source/connected digests; `ledger_digest` is always recomputed locally. */
  readonly snapshot?: AnchorProbeSnapshot;
  /** Worker entry; defaults to the sibling `replica-worker` module. */
  readonly workerPath?: string;
  readonly startTimeoutMs?: number;
  readonly nodeTimeoutMs?: number;
  readonly heartbeatMs?: number;
  readonly stopTimeoutMs?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  /** Grace period for a cooperative cancel acknowledgement (default 250ms). */
  readonly cancelGraceMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  /** Test/future seam: override how the child process is created. */
  readonly spawn?: typeof spawn;
}

/** Opaque handle for one live replica process. Never reuse across transports. */
export interface ReplicaHandle {
  readonly replicaId: string;
  readonly pid: number | null;
  readonly kind: ReplicaTransportKind;
}

export interface ReplicaCursorView {
  readonly commitIndex: number;
  readonly lastEventId: string | null;
  readonly lastEventHash: string;
  readonly viewDigest: string;
}

export interface ReplicaStatusView {
  readonly replicaId: string;
  readonly pid: number | null;
  readonly alive: boolean;
  readonly state: DistributedReplicaState;
  readonly commitIndex: number;
  readonly viewDigest: string;
  readonly evidenceDigest: string;
  readonly clusterMetadata: AnchorProbeClusterMetadata;
  readonly snapshot: AnchorProbeSnapshot;
  readonly cursor: ReplicaCursorView;
}

export interface ReplicaQueryOptions {
  readonly signal?: AbortSignal;
  readonly nodeTimeoutMs?: number;
}

export interface ReplicaApplyOptions {
  readonly projectScope?: string;
  readonly signal?: AbortSignal;
}

/**
 * ADR-011 §8.2 transport seam. `apply` carries already-committed events to the
 * replica (the pull side is expressed by handing the caller's exported batch
 * to `apply`); it never exposes a write path to the authoritative ledger.
 */
export interface ReplicaTransport {
  readonly kind: ReplicaTransportKind;
  start(options: ReplicaStartOptions): Promise<ReplicaHandle>;
  stop(handle: ReplicaHandle): Promise<void>;
  query(handle: ReplicaHandle, request: AnchorProbeRequest, options?: ReplicaQueryOptions): Promise<DistributedNodeResponse>;
  apply(handle: ReplicaHandle, events: readonly CommittedEventEnvelope[], options?: ReplicaApplyOptions): Promise<ReplicationReport>;
  status(handle: ReplicaHandle): Promise<ReplicaStatusView>;
  restart(handle: ReplicaHandle): Promise<ReplicaHandle>;
  isAlive(handle: ReplicaHandle): boolean;
}

interface ResolvedStartOptions {
  readonly root: string;
  readonly replicaId: string;
  readonly projectScope: string;
  readonly clusterEpoch?: string | number;
  readonly snapshot?: AnchorProbeSnapshot;
  readonly workerPath: string;
  readonly startTimeoutMs: number;
  readonly nodeTimeoutMs: number;
  readonly heartbeatMs: number;
  readonly stopTimeoutMs: number;
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  readonly cancelGraceMs: number;
  readonly env: NodeJS.ProcessEnv;
  readonly spawn: typeof spawn;
}

interface PendingRequest {
  readonly resolve: (response: ReplicaWorkerResponse) => void;
  readonly reject: (error: ReplicaTransportError) => void;
  readonly expectedType: ReplicaWorkerMessageType;
  timer: NodeJS.Timeout | undefined;
  readonly signal: AbortSignal | undefined;
  abortListener: (() => void) | undefined;
  abandoned: boolean;
}

interface ChildEntry {
  readonly handle: ReplicaHandle;
  readonly options: ResolvedStartOptions;
  child: ChildProcess;
  alive: boolean;
  closed: boolean;
  exit: { code: number | null; signal: NodeJS.Signals | null } | null;
  stderrTail: string;
  pending: Map<string, PendingRequest>;
  /** T-158: cancel-frame id -> grace timer awaiting the worker's ack. */
  readonly cancels: Map<string, NodeJS.Timeout>;
  buffer: Buffer;
  discarding: boolean;
  lastStatus: ReplicaStatusView | null;
  cache: RemoteReplicaCache | null;
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
  onError: (error: Error) => void;
}

interface RemoteReplicaCache {
  snapshot: AnchorProbeSnapshot;
  candidates: readonly ProbeCandidate[];
  edges: readonly ProbeEdge[];
}

const DEFAULT_WORKER_MODULE = './replica-worker';

function defaultWorkerPath(): string {
  const directory = fileURLToPath(new URL('.', import.meta.url));
  const compiled = join(directory, 'replica-worker.js');
  if (existsSync(compiled)) return compiled;
  return join(directory, 'replica-worker.ts');
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function assertStartOptions(options: ReplicaStartOptions): void {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new ReplicaTransportError('REPLICA_START_FAILED', 'start options must be an object');
  }
  if (typeof options.root !== 'string' || options.root.length === 0) {
    throw new ReplicaTransportError('REPLICA_START_FAILED', 'root must be a non-empty path');
  }
  if (typeof options.replicaId !== 'string' || options.replicaId.length === 0 || options.replicaId.length > 128) {
    throw new ReplicaTransportError('REPLICA_START_FAILED', 'replicaId must be a bounded identifier');
  }
  if (typeof options.projectScope !== 'string' || options.projectScope.length === 0 || options.projectScope.length > 128) {
    throw new ReplicaTransportError('REPLICA_START_FAILED', 'projectScope must be a bounded non-empty string');
  }
}

function resolveStartOptions(options: ReplicaStartOptions): ResolvedStartOptions {
  assertStartOptions(options);
  const positive = (value: number | undefined, fallback: number, field: string): number => {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new ReplicaTransportError('REPLICA_START_FAILED', `${field} must be a positive integer, got ${String(value)}`);
    }
    return value;
  };
  return {
    root: options.root,
    replicaId: options.replicaId,
    projectScope: options.projectScope,
    ...(options.clusterEpoch === undefined ? {} : { clusterEpoch: options.clusterEpoch }),
    ...(options.snapshot === undefined ? {} : { snapshot: options.snapshot }),
    workerPath: options.workerPath ?? defaultWorkerPath(),
    startTimeoutMs: positive(options.startTimeoutMs, REPLICA_TRANSPORT_DEFAULT_START_TIMEOUT_MS, 'startTimeoutMs'),
    nodeTimeoutMs: positive(options.nodeTimeoutMs, REPLICA_TRANSPORT_DEFAULT_NODE_TIMEOUT_MS, 'nodeTimeoutMs'),
    heartbeatMs: options.heartbeatMs === undefined
      ? REPLICA_WORKER_DEFAULT_HEARTBEAT_MS
      : options.heartbeatMs === 0
        ? 0
        : positive(options.heartbeatMs, REPLICA_WORKER_DEFAULT_HEARTBEAT_MS, 'heartbeatMs'),
    stopTimeoutMs: positive(options.stopTimeoutMs, REPLICA_TRANSPORT_DEFAULT_STOP_TIMEOUT_MS, 'stopTimeoutMs'),
    maxRequestBytes: positive(options.maxRequestBytes, REPLICA_TRANSPORT_DEFAULT_REQUEST_BYTES, 'maxRequestBytes'),
    maxResponseBytes: positive(options.maxResponseBytes, REPLICA_TRANSPORT_DEFAULT_RESPONSE_BYTES, 'maxResponseBytes'),
    cancelGraceMs: positive(options.cancelGraceMs, REPLICA_TRANSPORT_DEFAULT_CANCEL_GRACE_MS, 'cancelGraceMs'),
    env: options.env ?? process.env,
    spawn: options.spawn ?? spawn,
  };
}

function validateStatusPayload(payload: unknown): ReplicaStatusView {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ReplicaTransportError('REPLICA_RESPONSE_INVALID', 'status response payload must be an object');
  }
  const value = payload as Record<string, unknown>;
  if (typeof value.replicaId !== 'string' || !Number.isInteger(value.pid)) {
    throw new ReplicaTransportError('REPLICA_RESPONSE_INVALID', 'status response must carry replicaId and pid');
  }
  if (!Number.isSafeInteger(value.commitIndex) || (value.commitIndex as number) < 0) {
    throw new ReplicaTransportError('REPLICA_RESPONSE_INVALID', 'status response commitIndex is invalid');
  }
  if (typeof value.viewDigest !== 'string' || typeof value.evidenceDigest !== 'string') {
    throw new ReplicaTransportError('REPLICA_RESPONSE_INVALID', 'status response digests are invalid');
  }
  if (!(distributedReplicaStates as readonly string[]).includes(value.state as string)) {
    throw new ReplicaTransportError('REPLICA_RESPONSE_INVALID', 'status response state is invalid');
  }
  const metadata = anchorProbeClusterMetadataSchema.safeParse(value.clusterMetadata);
  if (!metadata.success) {
    throw new ReplicaTransportError('REPLICA_RESPONSE_INVALID', 'status response cluster metadata is invalid');
  }
  const cursor = value.cursor as Record<string, unknown> | undefined;
  if (cursor === undefined || !Number.isSafeInteger(cursor.commitIndex) || typeof cursor.lastEventHash !== 'string' || typeof cursor.viewDigest !== 'string') {
    throw new ReplicaTransportError('REPLICA_RESPONSE_INVALID', 'status response cursor is invalid');
  }
  return {
    replicaId: value.replicaId,
    pid: typeof value.pid === 'number' ? value.pid : null,
    alive: true,
    state: value.state as DistributedReplicaState,
    commitIndex: value.commitIndex as number,
    viewDigest: value.viewDigest,
    evidenceDigest: value.evidenceDigest,
    clusterMetadata: metadata.data,
    snapshot: value.snapshot as AnchorProbeSnapshot,
    cursor: {
      commitIndex: cursor.commitIndex as number,
      lastEventId: typeof cursor.lastEventId === 'string' ? cursor.lastEventId : null,
      lastEventHash: cursor.lastEventHash,
      viewDigest: cursor.viewDigest,
    },
  };
}

function validateQueryPayload(payload: unknown): DistributedNodeResponse & {
  readonly replicaId: string;
  readonly snapshot: AnchorProbeSnapshot;
} {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ReplicaTransportError('REPLICA_RESPONSE_INVALID', 'query response payload must be an object');
  }
  const value = payload as Record<string, unknown>;
  if (!Array.isArray(value.candidates)) {
    throw new ReplicaTransportError('REPLICA_RESPONSE_INVALID', 'query response must carry a candidates array');
  }
  for (const candidate of value.candidates) {
    if (candidate === null || typeof candidate !== 'object' || typeof (candidate as ProbeCandidate).record_ref !== 'string') {
      throw new ReplicaTransportError('REPLICA_RESPONSE_INVALID', 'query response contains a malformed candidate');
    }
  }
  if (value.edges !== undefined && !Array.isArray(value.edges)) {
    throw new ReplicaTransportError('REPLICA_RESPONSE_INVALID', 'query response edges must be an array');
  }
  if (!Number.isSafeInteger(value.commitIndex) || (value.commitIndex as number) < 0) {
    throw new ReplicaTransportError('REPLICA_RESPONSE_INVALID', 'query response commitIndex is invalid');
  }
  if (typeof value.viewDigest !== 'string' || typeof value.evidenceDigest !== 'string') {
    throw new ReplicaTransportError('REPLICA_RESPONSE_INVALID', 'query response digests are invalid');
  }
  if (!(distributedReplicaStates as readonly string[]).includes(value.state as string)) {
    throw new ReplicaTransportError('REPLICA_RESPONSE_INVALID', 'query response state is invalid');
  }
  return {
    candidates: value.candidates as readonly ProbeCandidate[],
    ...(value.edges === undefined ? {} : { edges: value.edges as readonly ProbeEdge[] }),
    commitIndex: value.commitIndex as number,
    viewDigest: value.viewDigest,
    evidenceDigest: value.evidenceDigest,
    state: value.state as DistributedReplicaState,
    ...(typeof value.clusterEpoch === 'string' || typeof value.clusterEpoch === 'number'
      ? { clusterEpoch: value.clusterEpoch }
      : {}),
    replicaId: typeof value.replicaId === 'string' ? value.replicaId : '',
    snapshot: value.snapshot as AnchorProbeSnapshot,
  };
}

function validateApplyPayload(payload: unknown): ReplicationReport {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ReplicaTransportError('REPLICA_RESPONSE_INVALID', 'apply response payload must be an object');
  }
  const report = (payload as { report?: unknown }).report;
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    throw new ReplicaTransportError('REPLICA_RESPONSE_INVALID', 'apply response must carry a replication report');
  }
  const value = report as Record<string, unknown>;
  for (const field of ['applied', 'duplicates', 'outOfOrder', 'corrupt', 'commitIndex', 'pendingCount']) {
    if (!Number.isSafeInteger(value[field])) {
      throw new ReplicaTransportError('REPLICA_RESPONSE_INVALID', `apply report.${field} is invalid`);
    }
  }
  if (!Array.isArray(value.gaps) || typeof value.viewDigest !== 'string' || typeof value.complete !== 'boolean') {
    throw new ReplicaTransportError('REPLICA_RESPONSE_INVALID', 'apply report shape is invalid');
  }
  return {
    applied: value.applied as number,
    duplicates: value.duplicates as number,
    outOfOrder: value.outOfOrder as number,
    gaps: value.gaps as number[],
    corrupt: value.corrupt as number,
    commitIndex: value.commitIndex as number,
    viewDigest: value.viewDigest,
    complete: value.complete,
    pendingCount: value.pendingCount as number,
  };
}

// ---------------------------------------------------------------------------
// Transport implementation
// ---------------------------------------------------------------------------

export class ChildProcessReplicaTransport implements ReplicaTransport {
  readonly kind: ReplicaTransportKind = 'child-process';

  readonly #entries = new Map<ReplicaHandle, ChildEntry>();
  /**
   * In-flight restarts keyed by the original handle. Two concurrent
   * `restart(handle)` calls must converge on ONE replacement process; without
   * this guard each caller stops the old child and starts its own, leaving a
   * duplicate live replica the caller never received a handle for.
   */
  readonly #restarting = new Map<ReplicaHandle, Promise<ReplicaHandle>>();

  // -- lifecycle ---------------------------------------------------------

  async start(options: ReplicaStartOptions): Promise<ReplicaHandle> {
    const resolved = resolveStartOptions(options);
    const child = resolved.spawn(process.execPath, [resolved.workerPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: workerEnv(resolved),
      windowsHide: true,
    });
    const entry = this.#attach(child, resolved);
    try {
      const ready = await this.#request<ReplicaStatusView>(entry, 'init', 'init', {
        root: resolved.root,
        replicaId: resolved.replicaId,
        projectScope: resolved.projectScope,
        ...(resolved.clusterEpoch === undefined ? {} : { clusterEpoch: resolved.clusterEpoch }),
        ...(resolved.snapshot === undefined ? {} : { snapshot: resolved.snapshot }),
      }, resolved.startTimeoutMs);
      entry.lastStatus = ready;
      entry.cache = statusCache(ready);
      return entry.handle;
    } catch (error) {
      await this.#kill(entry);
      if (error instanceof ReplicaTransportError && error.code === 'REPLICA_NODE_EXITED') {
        throw new ReplicaTransportError(
          'REPLICA_START_FAILED',
          `replica ${resolved.replicaId} exited during init: ${entry.stderrTail.trim() || 'no stderr captured'}`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  async stop(handle: ReplicaHandle): Promise<void> {
    const entry = this.#requireEntry(handle);
    if (entry.closed) return;
    await this.#shutdown(entry);
    entry.closed = true;
  }

  async restart(handle: ReplicaHandle): Promise<ReplicaHandle> {
    const entry = this.#requireEntry(handle);
    const inFlight = this.#restarting.get(handle);
    if (inFlight !== undefined) return await inFlight;
    const pending = this.#restartFrom(entry)
      .finally(() => {
        this.#restarting.delete(handle);
      });
    this.#restarting.set(handle, pending);
    return await pending;
  }

  async #restartFrom(entry: ChildEntry): Promise<ReplicaHandle> {
    const options: ReplicaStartOptions = {
      root: entry.options.root,
      replicaId: entry.options.replicaId,
      projectScope: entry.options.projectScope,
      ...(entry.options.clusterEpoch === undefined ? {} : { clusterEpoch: entry.options.clusterEpoch }),
      ...(entry.options.snapshot === undefined ? {} : { snapshot: entry.options.snapshot }),
      workerPath: entry.options.workerPath,
      startTimeoutMs: entry.options.startTimeoutMs,
      nodeTimeoutMs: entry.options.nodeTimeoutMs,
      heartbeatMs: entry.options.heartbeatMs,
      stopTimeoutMs: entry.options.stopTimeoutMs,
      maxRequestBytes: entry.options.maxRequestBytes,
      maxResponseBytes: entry.options.maxResponseBytes,
    };
    const previousCommitIndex = entry.lastStatus?.commitIndex ?? 0;
    await this.stop(entry.handle);
    const next = await this.start(options);
    // The replica directory persists its cursor, so a restarted worker resumes
    // at the last applied commit point instead of rebuilding from zero.
    if (this.isAlive(next) === false) {
      throw new ReplicaTransportError('REPLICA_RESTART_FAILED', 'restarted replica is not alive');
    }
    const status = await this.status(next);
    if (status.commitIndex < previousCommitIndex) {
      throw new ReplicaTransportError(
        'REPLICA_RESTART_INCOMPLETE',
        `restarted replica resumed at commit ${String(status.commitIndex)}, expected at least ${String(previousCommitIndex)}`,
      );
    }
    return next;
  }

  isAlive(handle: ReplicaHandle): boolean {
    const entry = this.#entries.get(handle);
    if (entry === undefined) return false;
    if (!entry.alive || entry.exit !== null) return false;
    return true;
  }

  /**
   * Observable transport watermarks (T-158/T-159). `liveChildren` counts child
   * processes this transport still owns, not every process on the machine.
   */
  resourceWatermarks(): { pendingRequests: number; liveChildren: number; activeTimers: number } {
    let pendingRequests = 0;
    let liveChildren = 0;
    let activeTimers = 0;
    for (const entry of this.#entries.values()) {
      pendingRequests += entry.pending.size;
      if (entry.alive && !entry.closed && entry.exit === null) liveChildren += 1;
      for (const pending of entry.pending.values()) {
        if (pending.timer !== undefined) activeTimers += 1;
      }
      activeTimers += entry.cancels.size;
    }
    return { pendingRequests, liveChildren, activeTimers };
  }

  // -- request paths -----------------------------------------------------

  async query(handle: ReplicaHandle, request: AnchorProbeRequest, options: ReplicaQueryOptions = {}): Promise<DistributedNodeResponse> {
    const entry = this.#requireLive(handle);
    const budget = options.nodeTimeoutMs === undefined
      ? entry.options.nodeTimeoutMs
      : Math.max(1, Math.min(options.nodeTimeoutMs, entry.options.nodeTimeoutMs));
    if (options.signal?.aborted === true) {
      throw new ReplicaTransportError('REPLICA_QUERY_CANCELLED', 'query was cancelled before dispatch');
    }
    const payload = await this.#request<DistributedNodeResponse & { replicaId: string; snapshot: AnchorProbeSnapshot }>(
      entry,
      'query',
      'query',
      request,
      budget,
      options.signal,
    );
    if (entry.cache !== null) {
      entry.cache = {
        snapshot: payload.snapshot,
        candidates: payload.candidates,
        edges: payload.edges ?? [],
      };
    }
    const { replicaId: _replicaId, snapshot: _snapshot, ...nodeResponse } = payload;
    return nodeResponse;
  }

  async apply(handle: ReplicaHandle, events: readonly CommittedEventEnvelope[], options: ReplicaApplyOptions = {}): Promise<ReplicationReport> {
    const entry = this.#requireLive(handle);
    const payload = await this.#request<{ report: ReplicationReport }>(
      entry,
      'apply',
      'apply',
      {
        events,
        ...(options.projectScope === undefined ? {} : { projectScope: options.projectScope }),
      },
      entry.options.nodeTimeoutMs,
      options.signal,
    );
    const report = validateApplyPayload(payload);
    entry.lastStatus = entry.lastStatus === null
      ? entry.lastStatus
      : { ...entry.lastStatus, commitIndex: payload.report.commitIndex, viewDigest: payload.report.viewDigest };
    return report;
  }

  async status(handle: ReplicaHandle): Promise<ReplicaStatusView> {
    const entry = this.#requireLive(handle);
    const payload = await this.#request<ReplicaStatusView>(entry, 'status', 'status', {}, entry.options.nodeTimeoutMs);
    const status = validateStatusPayload(payload);
    entry.lastStatus = status;
    entry.cache = statusCache(status);
    return status;
  }

  /**
   * Continue replication strictly after the replica cursor. `pull` mirrors
   * `resumeFrom`: it receives the current cursor and returns committed events
   * with `seq > cursor.commitIndex`. Bounded so a misbehaving pull cannot spin.
   */
  async resume(
    handle: ReplicaHandle,
    pull: (cursor: ReplicaCursorView) => Promise<readonly CommittedEventEnvelope[]> | readonly CommittedEventEnvelope[],
    options: { maxChunks?: number; signal?: AbortSignal } = {},
  ): Promise<ReplicaStatusView> {
    const entry = this.#requireLive(handle);
    const maxChunks = options.maxChunks ?? 64;
    if (!Number.isSafeInteger(maxChunks) || maxChunks < 1) {
      throw new ReplicaTransportError('REPLICA_RESUME_INVALID', 'maxChunks must be a positive integer');
    }
    let chunks = 0;
    for (;;) {
      const status = await this.status(handle);
      if (options.signal?.aborted === true) {
        throw new ReplicaTransportError('REPLICA_QUERY_CANCELLED', 'resume was cancelled');
      }
      const events = await pull(status.cursor);
      if (events.length === 0) return status;
      await this.apply(handle, events, options.signal === undefined ? {} : { signal: options.signal });
      chunks += 1;
      if (chunks >= maxChunks) {
        throw new ReplicaTransportError('REPLICA_RESUME_EXHAUSTED', `resume did not converge within ${String(maxChunks)} chunk(s)`);
      }
    }
  }

  // -- coordinator integration ------------------------------------------

  /** Build a `DistributedNodeQuery`-shaped function over a live handle. */
  createNodeQuery(handle: ReplicaHandle): DistributedNodeQuery {
    return (request, context) =>
      this.query(handle, request, { signal: context.signal, nodeTimeoutMs: context.nodeTimeoutMs });
  }

  /**
   * Wrap a live handle as a `DistributedReplicaNode`. Snapshot/candidate reads
   * come from the last completed status/query round trip, because a replica's
   * bytes only exist inside its own process; a stale cache is never presented
   * as fresh and `snapshot` throws until the first round trip completes.
   */
  async toDistributedReplicaNode(handle: ReplicaHandle, overrides: { commitIndex?: number; state?: DistributedReplicaState } = {}): Promise<DistributedReplicaNode> {
    const status = await this.status(handle);
    const store = new RemoteReplicaStore(() => {
      const entry = this.#entries.get(handle);
      return entry?.cache ?? null;
    });
    return {
      replicaId: status.replicaId,
      store,
      projectScope: status.clusterMetadata.project_scope,
      clusterEpoch: status.clusterMetadata.cluster_epoch,
      ...(overrides.commitIndex === undefined ? {} : { commitIndex: overrides.commitIndex }),
      ...(overrides.state === undefined ? {} : { state: overrides.state }),
      query: this.createNodeQuery(handle),
    };
  }

  // -- internals --------------------------------------------------------

  #attach(child: ChildProcess, resolved: ResolvedStartOptions): ChildEntry {
    const handle: ReplicaHandle = {
      replicaId: resolved.replicaId,
      pid: child.pid ?? null,
      kind: 'child-process',
    };
    const entry: ChildEntry = {
      handle,
      options: resolved,
      child,
      alive: true,
      closed: false,
      exit: null,
      stderrTail: '',
      pending: new Map(),
      cancels: new Map(),
      buffer: Buffer.alloc(0),
      discarding: false,
      lastStatus: null,
      cache: null,
      onExit: () => undefined,
      onError: () => undefined,
    };
    entry.onExit = (code, signal): void => {
      entry.alive = false;
      entry.exit = { code, signal };
      for (const timer of entry.cancels.values()) clearTimeout(timer);
      entry.cancels.clear();
      const error = new ReplicaTransportError(
        'REPLICA_NODE_EXITED',
        `replica ${handle.replicaId} (pid ${String(handle.pid)}) exited before answering (code=${String(code)} signal=${String(signal)})`,
      );
      this.#failPending(entry, error);
    };
    entry.onError = (error: Error): void => {
      entry.stderrTail = `${entry.stderrTail}${error.message}\n`.slice(-4_000);
    };
    child.on('exit', entry.onExit);
    child.on('error', entry.onError);
    // A dead child's stdin raises EPIPE asynchronously; swallow it here so the
    // parent never crashes because a replica was killed underneath it.
    const onStdinError = (error: Error): void => {
      entry.stderrTail = `${entry.stderrTail}${error.message}\n`.slice(-4_000);
    };
    child.stdin?.on('error', onStdinError);
    child.stdout?.on('data', (chunk: Buffer) => this.#onStdout(entry, chunk));
    child.stderr?.on('data', (chunk: Buffer) => {
      entry.stderrTail = `${entry.stderrTail}${chunk.toString('utf8')}`.slice(-8_000);
    });
    this.#entries.set(handle, entry);
    return entry;
  }

  #requireEntry(handle: ReplicaHandle): ChildEntry {
    const entry = handle === null || typeof handle !== 'object' ? undefined : this.#entries.get(handle);
    if (entry === undefined) {
      throw new ReplicaTransportError('REPLICA_STALE_HANDLE', 'handle does not belong to this transport (already stopped or foreign)');
    }
    return entry;
  }

  #requireLive(handle: ReplicaHandle): ChildEntry {
    const entry = this.#requireEntry(handle);
    if (!this.isAlive(handle)) {
      throw new ReplicaTransportError(
        'REPLICA_NODE_EXITED',
        `replica ${handle.replicaId} is not alive${entry.exit === null ? '' : ` (code=${String(entry.exit.code)} signal=${String(entry.exit.signal)})`}; pending=${String(entry.pending.size)}`,
      );
    }
    return entry;
  }

  #failPending(entry: ChildEntry, error: ReplicaTransportError): void {
    for (const [id, pending] of entry.pending) {
      this.#settle(entry, pending, id);
      pending.abandoned = true;
      pending.reject(error);
    }
    entry.pending.clear();
  }

  #onStdout(entry: ChildEntry, chunk: Buffer): void {
    let offset = 0;
    for (;;) {
      const newline = chunk.indexOf(0x0a, offset);
      if (newline === -1) {
        const tail = chunk.subarray(offset);
        if (entry.discarding) return;
        if (entry.buffer.length + tail.length > entry.options.maxResponseBytes) {
          entry.discarding = true;
          entry.buffer = Buffer.alloc(0);
          this.#failPending(entry, new ReplicaTransportError('REPLICA_RESPONSE_TOO_LARGE', `response exceeds the ${String(entry.options.maxResponseBytes)} byte limit`));
          return;
        }
        entry.buffer = entry.buffer.length === 0 ? Buffer.from(tail) : Buffer.concat([entry.buffer, tail]);
        return;
      }
      const line = chunk.subarray(offset, newline);
      offset = newline + 1;
      if (entry.discarding) {
        entry.discarding = false;
        entry.buffer = Buffer.alloc(0);
        continue;
      }
      if (entry.buffer.length + line.length > entry.options.maxResponseBytes) {
        entry.buffer = Buffer.alloc(0);
        this.#failPending(entry, new ReplicaTransportError('REPLICA_RESPONSE_TOO_LARGE', `response exceeds the ${String(entry.options.maxResponseBytes)} byte limit`));
        continue;
      }
      const full = entry.buffer.length === 0 ? line : Buffer.concat([entry.buffer, line]);
      entry.buffer = Buffer.alloc(0);
      this.#onResponseLine(entry, full.toString('utf8'));
    }
  }

  #onResponseLine(entry: ChildEntry, text: string): void {
    const parsed = parseWorkerResponse(text.endsWith('\r') ? text.slice(0, -1) : text);
    if (!parsed.ok) {
      // A line that is not a protocol response cannot be routed; fail the
      // oldest pending request rather than letting it hang silently.
      const oldest = entry.pending.values().next().value;
      if (oldest === undefined) return;
      // Map preserves insertion order, so the first key whose value is the
      // oldest pending entry is its id; no need to build an entries array.
      let oldestId = '';
      for (const [key, value] of entry.pending) {
        if (value === oldest) {
          oldestId = key;
          break;
        }
      }
      this.#settle(entry, oldest, oldestId);
      oldest.reject(new ReplicaTransportError('REPLICA_RESPONSE_INVALID', parsed.error.message));
      return;
    }
    const { id } = parsed.response;
    const cancelTimer = entry.cancels.get(id);
    if (cancelTimer !== undefined) {
      clearTimeout(cancelTimer);
      entry.cancels.delete(id);
      return;
    }
    const pending = entry.pending.get(id);
    if (pending === undefined) return; // late/abandoned response: deliberately ignored
    this.#settle(entry, pending, id);
    if (!parsed.response.ok) {
      pending.reject(new ReplicaTransportError(parsed.response.error.code, parsed.response.error.message));
      return;
    }
    if (parsed.response.type !== pending.expectedType) {
      pending.reject(new ReplicaTransportError('REPLICA_RESPONSE_INVALID', `unexpected response type ${String(parsed.response.type)}`));
      return;
    }
    pending.resolve(parsed.response);
  }

  #settle(entry: ChildEntry, pending: PendingRequest, id: string): void {
    entry.pending.delete(id);
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    if (pending.signal !== undefined && pending.abortListener !== undefined) {
      pending.signal.removeEventListener('abort', pending.abortListener);
    }
  }

  #request<T>(
    entry: ChildEntry,
    requestType: ReplicaWorkerMessageType,
    responseType: ReplicaWorkerMessageType,
    payload: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted === true) {
      return Promise.reject(new ReplicaTransportError('REPLICA_QUERY_CANCELLED', `${requestType} was cancelled before dispatch`));
    }
    const id = `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const request: ReplicaWorkerRequest = { type: requestType, id, payload };
    const text = JSON.stringify(request);
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > entry.options.maxRequestBytes) {
      return Promise.reject(new ReplicaTransportError(
        'REPLICA_REQUEST_TOO_LARGE',
        `${requestType} message is ${String(bytes)} bytes, above the ${String(entry.options.maxRequestBytes)} byte limit`,
      ));
    }
    return new Promise<T>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      let abortListener: (() => void) | undefined;
      const pending: PendingRequest = {
        resolve: (response) => {
          if (response.ok === false) {
            reject(new ReplicaTransportError(response.error.code, response.error.message));
            return;
          }
          try {
            resolve(this.#validate(response.type, response.payload) as T);
          } catch (error) {
            reject(error);
          }
        },
        reject,
        expectedType: responseType,
        timer: undefined,
        signal,
        abortListener: undefined,
        abandoned: false,
      };
      const abandon = (error: ReplicaTransportError): void => {
        if (pending.abandoned) return;
        pending.abandoned = true;
        entry.pending.delete(id);
        if (timer !== undefined) clearTimeout(timer);
        if (abortListener !== undefined) signal?.removeEventListener('abort', abortListener);
        // Cooperative stop: the worker may still be holding this id even though
        // the caller stopped waiting for it.
        this.#sendCancel(entry, id);
        reject(error);
      };
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          abandon(new ReplicaTransportError('REPLICA_QUERY_TIMEOUT', `${requestType} exceeded its ${String(timeoutMs)}ms budget`));
        }, timeoutMs);
        timer.unref?.();
      }
      if (signal !== undefined) {
        abortListener = (): void => {
          abandon(new ReplicaTransportError('REPLICA_QUERY_CANCELLED', `${requestType} was cancelled`));
        };
        signal.addEventListener('abort', abortListener, { once: true });
      }
      pending.timer = timer;
      pending.abortListener = abortListener;
      entry.pending.set(id, pending);
      try {
        entry.child.stdin?.write(`${text}\n`);
      } catch (error) {
        entry.pending.delete(id);
        if (timer !== undefined) clearTimeout(timer);
        if (abortListener !== undefined) signal?.removeEventListener('abort', abortListener);
        reject(new ReplicaTransportError('REPLICA_REQUEST_FAILED', `failed to write to replica stdin: ${message(error)}`));
      }
    });
  }

  /**
   * Ask the worker to abandon `targetId`. Best effort: the caller already
   * settled. If the worker does not acknowledge within the grace window and
   * this was the last outstanding request, the child is terminated; while other
   * requests are pending it is left alone, so a cancel never kills unrelated
   * work.
   */
  #sendCancel(entry: ChildEntry, targetId: string): void {
    if (entry.closed || !entry.alive || entry.child.stdin === null || entry.child.stdin.destroyed) return;
    const id = `cancel-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const text = JSON.stringify({ type: 'cancel', id, payload: { targetId } } satisfies ReplicaWorkerRequest);
    const timer = setTimeout(() => {
      entry.cancels.delete(id);
      if (entry.pending.size === 0 && !entry.closed && entry.alive) {
        safeKill(entry.child, 'SIGKILL');
      }
    }, entry.options.cancelGraceMs);
    timer.unref?.();
    entry.cancels.set(id, timer);
    try {
      entry.child.stdin.write(`${text}\n`);
    } catch {
      clearTimeout(timer);
      entry.cancels.delete(id);
    }
  }

  #validate(type: ReplicaWorkerMessageType, payload: unknown): unknown {
    switch (type) {
      case 'status':
      case 'init':
        // `init` answers with the same status body as `status`.
        return validateStatusPayload(payload);
      case 'query':
        return validateQueryPayload(payload);
      case 'apply':
        return payload;
      default:
        return payload;
    }
  }

  async #shutdown(entry: ChildEntry): Promise<void> {
    if (entry.child.stdin !== null && entry.alive) {
      try {
        entry.child.stdin.write(`${JSON.stringify({ type: 'shutdown', id: `stop-${Date.now().toString(36)}`, payload: {} } satisfies ReplicaWorkerRequest)}\n`);
      } catch {
        // fall through to kill
      }
    }
    const gracefulDeadline = Date.now() + Math.min(1_000, entry.options.stopTimeoutMs);
    while (entry.exit === null && Date.now() < gracefulDeadline) await delay(20);
    if (entry.exit === null) {
      safeKill(entry.child);
      const terminateDeadline = Date.now() + Math.max(500, entry.options.stopTimeoutMs - 1_000);
      while (entry.exit === null && Date.now() < terminateDeadline) await delay(20);
    }
    if (entry.exit === null) {
      safeKill(entry.child, 'SIGKILL');
      const hardDeadline = Date.now() + 2_000;
      while (entry.exit === null && Date.now() < hardDeadline) await delay(20);
    }
    this.#failPending(entry, new ReplicaTransportError('REPLICA_NODE_EXITED', `replica ${entry.handle.replicaId} was stopped`));
    entry.alive = false;
    if (entry.exit === null) {
      releaseChildStdio(entry.child);
      throw new ReplicaTransportError('REPLICA_STOP_FAILED', `replica ${entry.handle.replicaId} (pid ${String(entry.handle.pid)}) did not exit`);
    }
    entry.child.stdout?.removeAllListeners('data');
    entry.child.stderr?.removeAllListeners('data');
    entry.child.stdin?.removeAllListeners('error');
    entry.child.removeListener('exit', entry.onExit);
    entry.child.removeListener('error', entry.onError);
    releaseChildStdio(entry.child);
  }

  async #kill(entry: ChildEntry): Promise<void> {
    if (entry.exit === null) {
      safeKill(entry.child, 'SIGKILL');
      const deadline = Date.now() + 2_000;
      while (entry.exit === null && Date.now() < deadline) await delay(20);
    }
    this.#failPending(entry, new ReplicaTransportError('REPLICA_START_FAILED', `replica ${entry.handle.replicaId} failed to start`));
    entry.alive = false;
    entry.child.stdout?.removeAllListeners('data');
    entry.child.stderr?.removeAllListeners('data');
    entry.child.stdin?.removeAllListeners('error');
    entry.child.removeListener('exit', entry.onExit);
    entry.child.removeListener('error', entry.onError);
    releaseChildStdio(entry.child);
  }

  /** Diagnostic: last captured stderr of a child (never part of the protocol). */
  stderrOf(handle: ReplicaHandle): string {
    return this.#entries.get(handle)?.stderrTail ?? '';
  }
}

function safeKill(child: ChildProcess, signal?: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    // already gone
  }
}

/**
 * A stopped replica must hold no event-loop handle. On Windows a terminated
 * child's pipes can stay open briefly; destroying them and dropping the ref
 * keeps the host (test file or CLI) free to exit instead of waiting on a dead
 * process that will never emit anything again.
 */
function releaseChildStdio(child: ChildProcess): void {
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
}

function statusCache(status: ReplicaStatusView): RemoteReplicaCache {
  return { snapshot: status.snapshot, candidates: [], edges: [] };
}

/** Pass the resolved heartbeat to the child without mutating the caller's env. */
function workerEnv(resolved: ResolvedStartOptions): NodeJS.ProcessEnv {
  const env = { ...resolved.env };
  if (env.REPLICA_WORKER_HEARTBEAT_MS === undefined) env.REPLICA_WORKER_HEARTBEAT_MS = String(resolved.heartbeatMs);
  return env;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Remote read-only ProbeStore adapter (coordinator integration)
// ---------------------------------------------------------------------------

/**
 * Presents a replica's last observed bytes as a `ProbeStore`. It is a cache,
 * not a live connection: reads reflect the most recent completed status/query
 * round trip and throw before the first one. The coordinator therefore never
 * treats a stale cache as fresh remote evidence.
 */
export class RemoteReplicaStore implements ProbeStore {
  readonly #read: () => RemoteReplicaCache | null;

  constructor(read: () => RemoteReplicaCache | null) {
    this.#read = read;
  }

  get snapshot(): AnchorProbeSnapshot {
    const cache = this.#read();
    if (cache === null) throw new ProbeStoreCacheError('remote replica has not completed a status/query round trip yet');
    return cache.snapshot;
  }

  candidates(query?: ProbeEntryQuery): readonly ProbeCandidate[] {
    const cache = this.#require();
    if (query === undefined || Object.keys(query).length === 0) return cache.candidates;
    return cache.candidates.filter((candidate) => matchesQuery(candidate, query));
  }

  adjacency(ref?: string): readonly ProbeEdge[] {
    const edges = this.#require().edges;
    if (ref === undefined) return edges;
    return edges.filter((edge) => edge.from === ref || edge.to === ref);
  }

  evidence(recordRef: string): ProbeEvidencePayload | undefined {
    const candidate = this.#require().candidates.find((entry) => entry.record_ref === recordRef);
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
    const candidate = this.#require().candidates.find((entry) => entry.record_ref === recordRef);
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
    const candidate = this.#require().candidates.find((entry) => entry.record_ref === recordRef);
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
    return probeSnapshotIdentity(this.snapshot);
  }

  replicaCommitIndex(): number | undefined {
    const cache = this.#read();
    return cache?.snapshot.cluster?.replica_commit_index ?? cache?.snapshot.cluster?.commit_index;
  }

  #require(): RemoteReplicaCache {
    const cache = this.#read();
    if (cache === null) throw new ProbeStoreCacheError('remote replica has not completed a status/query round trip yet');
    return cache;
  }
}

function matchesQuery(candidate: ProbeCandidate, query: ProbeEntryQuery): boolean {
  if (query.fact_key !== undefined && candidate.fact_key !== query.fact_key) return false;
  if (query.task_id !== undefined && candidate.task_id !== query.task_id) return false;
  if (query.file !== undefined && candidate.file !== query.file) return false;
  if (query.symbol !== undefined && candidate.symbol !== query.symbol) return false;
  return true;
}

/** Re-exported for callers that build protocol frames directly. */
export { replicaWorkerMessageTypes, REPLICA_WORKER_MAX_MESSAGE_BYTES };
export type { ReplicaWorkerRequest, ReplicaWorkerResponse };
