import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  anchorProbeRequestSchema,
  type AnchorProbeClusterMetadata,
  type AnchorProbeSnapshot,
} from './probe-contract.ts';
import {
  distributedReplicaStates,
  type DistributedNodeResponse,
  type DistributedReplicaState,
} from './distributed-probe.ts';
import { ReplicaStore } from './replica.ts';
import {
  committedEnvelopeIssue,
  ReplicationError,
  type CommittedEventEnvelope,
  type ReplicationReport,
} from './replication.ts';

/**
 * T-127 / ADR-011 §8.2: child-process replica entry point.
 *
 * One OS process hosts exactly one read-only replica. The parent speaks a
 * newline-delimited JSON protocol over stdin/stdout; stderr stays reserved for
 * diagnostics so it can never corrupt the protocol stream. Every inbound
 * message is strictly validated (type/id/payload shape, byte size, array
 * length, nesting depth, string length) and every failure becomes an explicit
 * error response instead of a crash.
 *
 * Hard boundaries honoured here:
 * - replicas are read-only: the only store writes land in
 *   `<root>/.ano/replicas/<replicaId>/` through the frozen `ReplicaStore`;
 * - remote payload bytes are data: nothing in a message is `eval`'d,
 *   `require`'d, `spawn`ed or otherwise executed;
 * - no network listener, no port binding, no cross-machine claim;
 * - the worker exits when the parent disappears (stdin close or heartbeat
 *   timeout), so an orphaned replica cannot outlive its coordinator.
 */

// ---------------------------------------------------------------------------
// Protocol vocabulary and bounds
// ---------------------------------------------------------------------------

export const replicaWorkerMessageTypes = ['init', 'apply', 'query', 'status', 'shutdown', 'cancel'] as const;
export type ReplicaWorkerMessageType = (typeof replicaWorkerMessageTypes)[number];

/** ADR-011 §8.1: one inbound protocol message is bounded at 1 MiB. */
export const REPLICA_WORKER_MAX_MESSAGE_BYTES = 1_048_576;
/** Array length bound (ADR-011 §4.2 pull chunk bound is 1024). */
export const REPLICA_WORKER_MAX_ARRAY_LENGTH = 1_024;
/** Nesting-depth bound so a hostile deeply-nested payload cannot exhaust the parser. */
export const REPLICA_WORKER_MAX_NESTING_DEPTH = 24;
/** Per-string bound inside any payload. */
export const REPLICA_WORKER_MAX_STRING_CHARS = 65_536;
/**
 * Parent-liveness heartbeat in milliseconds; `0` (the default) disables it.
 *
 * Disabling is safe because stdin closing already proves the parent is gone.
 * Enabling it is only meaningful when the parent also produces periodic
 * traffic (a ping/status at least as often as the heartbeat): an idle-but-
 * healthy replica would otherwise conclude that its parent died.
 */
export const REPLICA_WORKER_DEFAULT_HEARTBEAT_MS = 0;

export const replicaWorkerErrorCodes = [
  'REPLICA_MESSAGE_TOO_LARGE',
  'REPLICA_MESSAGE_INVALID',
  'REPLICA_MESSAGE_UNKNOWN_TYPE',
  'REPLICA_NOT_INITIALIZED',
  'REPLICA_ALREADY_INITIALIZED',
  'PROBE_REQUEST_INVALID',
  'REPLICA_INTERNAL_ERROR',
  'REPLICA_QUERY_CANCELLED',
] as const;
export type ReplicaWorkerErrorCode = (typeof replicaWorkerErrorCodes)[number];

export interface ReplicaWorkerRequest {
  readonly type: ReplicaWorkerMessageType;
  readonly id: string;
  readonly payload: unknown;
}

export interface ReplicaWorkerError {
  readonly code: string;
  readonly message: string;
}

export interface ReplicaWorkerSuccess {
  readonly ok: true;
  readonly id: string;
  readonly type: ReplicaWorkerMessageType;
  readonly payload: unknown;
}

export interface ReplicaWorkerFailure {
  readonly ok: false;
  readonly id: string;
  readonly error: ReplicaWorkerError;
}

export type ReplicaWorkerResponse = ReplicaWorkerSuccess | ReplicaWorkerFailure;

// ---------------------------------------------------------------------------
// Init payload
// ---------------------------------------------------------------------------

export interface ReplicaWorkerInitPayload {
  readonly root: string;
  readonly replicaId: string;
  readonly projectScope: string;
  readonly clusterEpoch?: string | number;
  readonly snapshot?: AnchorProbeSnapshot;
}

export interface ReplicaWorkerApplyPayload {
  readonly events: readonly CommittedEventEnvelope[];
  readonly projectScope?: string;
}

/**
 * T-158 (MNT-02): the `cancel` message asks the worker to abandon the request
 * identified by `targetId`. It carries no authority of its own: it can only
 * cancel a request the parent already issued to this worker.
 */
export interface ReplicaWorkerCancelPayload {
  readonly targetId: string;
}

/**
 * T-158 (MNT-02): bounded memory for the cancellation ledger.
 *
 * The worker only needs to remember *whether* an id was seen, cancelled,
 * completed or blocked, never why. The ledger is an insertion-ordered LRU so
 * a hostile parent cannot grow the worker's memory without bound.
 */
export const REPLICA_WORKER_CANCEL_MEMORY = 256;

class BoundedIdSet {
  readonly #ids = new Set<string>();
  readonly #limit: number;

  constructor(limit: number) {
    this.#limit = limit;
  }

  has(id: string): boolean {
    return this.#ids.has(id);
  }

  add(id: string): void {
    this.#ids.delete(id);
    this.#ids.add(id);
    while (this.#ids.size > this.#limit) {
      const oldest = this.#ids.values().next().value;
      if (oldest === undefined) break;
      this.#ids.delete(oldest);
    }
  }
}

/** Why a cancel could not stop a request. */
export const replicaWorkerCancelReasons = ['unknown', 'completed'] as const;
export type ReplicaWorkerCancelReason = (typeof replicaWorkerCancelReasons)[number];

/**
 * Answer to a `cancel` message. `cancelled: true` means the target will not
 * run (or was aborted); `cancelled: false` with a `reason` means the target is
 * unknown or had already completed. Repeated cancels are idempotent.
 */
export interface ReplicaWorkerCancelResult {
  readonly cancelled: boolean;
  readonly targetId: string;
  readonly reason?: ReplicaWorkerCancelReason;
}

export interface ReplicaWorkerStatus {
  readonly replicaId: string;
  readonly pid: number;
  readonly commitIndex: number;
  readonly viewDigest: string;
  readonly evidenceDigest: string;
  readonly state: DistributedReplicaState;
  readonly clusterMetadata: AnchorProbeClusterMetadata;
  readonly snapshot: AnchorProbeSnapshot;
  readonly cursor: {
    readonly commitIndex: number;
    readonly lastEventId: string | null;
    readonly lastEventHash: string;
    readonly viewDigest: string;
  };
}

export interface ReplicaWorkerApplyResult {
  readonly report: ReplicationReport;
  readonly commitIndex: number;
  readonly viewDigest: string;
}

type Validation =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly code: string; readonly message: string };

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function fail(code: string, message: string): Validation {
  return { ok: false, code, message };
}

/** Byte/shape guard shared by the transport and the worker. */
export function checkPayloadShape(value: unknown, location = 'payload'): Validation {
  const result = walk(value, location, 0);
  return result === null ? { ok: true, value } : fail('REPLICA_MESSAGE_INVALID', result);
}

function walk(node: unknown, location: string, depth: number): string | null {
  if (depth > REPLICA_WORKER_MAX_NESTING_DEPTH) return `${location} exceeds the nesting depth bound`;
  if (typeof node === 'string') {
    if (node.length > REPLICA_WORKER_MAX_STRING_CHARS) return `${location} exceeds the string length bound`;
    return null;
  }
  if (Array.isArray(node)) {
    if (node.length > REPLICA_WORKER_MAX_ARRAY_LENGTH) return `${location} exceeds the array length bound`;
    for (let index = 0; index < node.length; index += 1) {
      const issue = walk(node[index], `${location}[${index}]`, depth + 1);
      if (issue !== null) return issue;
    }
    return null;
  }
  if (node !== null && typeof node === 'object') {
    for (const [key, child] of Object.entries(node)) {
      if (key.length > REPLICA_WORKER_MAX_STRING_CHARS) return `${location} has an unbounded key`;
      const issue = walk(child, `${location}.${key}`, depth + 1);
      if (issue !== null) return issue;
    }
    return null;
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateId(value: unknown): string | null {
  return typeof value === 'string' && ID_PATTERN.test(value) ? null : 'id must be a bounded request identifier';
}

function validateString(value: unknown, field: string, min = 1, max = 4_096): string | null {
  if (typeof value !== 'string') return `${field} must be a string`;
  if (value.length < min || value.length > max) return `${field} must be between ${String(min)} and ${String(max)} characters`;
  return null;
}

function unknownKeys(value: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(value).filter((key) => !allowed.includes(key));
}

function validateInit(payload: unknown): Validation {
  if (!isPlainObject(payload)) return fail('REPLICA_MESSAGE_INVALID', 'init payload must be an object');
  const extras = unknownKeys(payload, ['root', 'replicaId', 'projectScope', 'clusterEpoch', 'snapshot']);
  if (extras.length > 0) return fail('REPLICA_MESSAGE_INVALID', `init payload carries unknown field(s): ${extras.join(', ')}`);
  const root = validateString(payload.root, 'root');
  if (root !== null) return fail('REPLICA_MESSAGE_INVALID', root);
  const replicaId = validateString(payload.replicaId, 'replicaId', 1, 128);
  if (replicaId !== null) return fail('REPLICA_MESSAGE_INVALID', replicaId);
  const scope = validateString(payload.projectScope, 'projectScope', 1, 128);
  if (scope !== null) return fail('REPLICA_MESSAGE_INVALID', scope);
  const epoch = payload.clusterEpoch;
  if (epoch !== undefined) {
    const valid = typeof epoch === 'string' ? epoch.length <= 128 : typeof epoch === 'number' && Number.isFinite(epoch);
    if (!valid) return fail('REPLICA_MESSAGE_INVALID', 'clusterEpoch must be a bounded string or a finite number');
  }
  const snapshot = payload.snapshot;
  if (snapshot !== undefined) {
    if (!isPlainObject(snapshot)) return fail('REPLICA_MESSAGE_INVALID', 'snapshot must be an object');
    const snapshotExtras = unknownKeys(snapshot, ['project_scope', 'ledger_digest', 'graph_revision', 'source_fingerprint', 'connected_digest']);
    if (snapshotExtras.length > 0) return fail('REPLICA_MESSAGE_INVALID', `snapshot carries unknown field(s): ${snapshotExtras.join(', ')}`);
    for (const field of ['graph_revision', 'source_fingerprint', 'connected_digest'] as const) {
      const digest = snapshot[field];
      if (digest !== undefined && digest !== null && typeof digest !== 'string') {
        return fail('REPLICA_MESSAGE_INVALID', `snapshot.${field} must be a string or null`);
      }
    }
  }
  return { ok: true, value: payload };
}

function validateApply(payload: unknown): Validation {
  if (!isPlainObject(payload)) return fail('REPLICA_MESSAGE_INVALID', 'apply payload must be an object');
  const extras = unknownKeys(payload, ['events', 'projectScope']);
  if (extras.length > 0) return fail('REPLICA_MESSAGE_INVALID', `apply payload carries unknown field(s): ${extras.join(', ')}`);
  if (!Array.isArray(payload.events)) return fail('REPLICA_MESSAGE_INVALID', 'apply payload.events must be an array');
  if (payload.events.length > REPLICA_WORKER_MAX_ARRAY_LENGTH) {
    return fail('REPLICA_MESSAGE_INVALID', `apply payload.events exceeds ${String(REPLICA_WORKER_MAX_ARRAY_LENGTH)} envelopes`);
  }
  const scope = payload.projectScope;
  if (scope !== undefined && (typeof scope !== 'string' || scope.length === 0 || scope.length > 128)) {
    return fail('REPLICA_MESSAGE_INVALID', 'apply payload.projectScope must be a bounded non-empty string');
  }
  return { ok: true, value: payload };
}

function validateCancel(payload: unknown): Validation {
  if (!isPlainObject(payload)) return fail('REPLICA_MESSAGE_INVALID', 'cancel payload must be an object');
  const extras = unknownKeys(payload, ['targetId']);
  if (extras.length > 0) return fail('REPLICA_MESSAGE_INVALID', `cancel payload carries unknown field(s): ${extras.join(', ')}`);
  const targetId = validateId(payload.targetId);
  if (targetId !== null) return fail('REPLICA_MESSAGE_INVALID', `cancel payload ${targetId}`);
  return { ok: true, value: { targetId: payload.targetId as string } };
}

function validateQuery(payload: unknown): Validation {
  if (!isPlainObject(payload)) return fail('PROBE_REQUEST_INVALID', 'query payload must be an object');
  const parsed = anchorProbeRequestSchema.safeParse(payload);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const detail = first === undefined ? 'unknown schema violation' : `${first.path.join('.') || 'payload'}: ${first.message}`;
    return fail('PROBE_REQUEST_INVALID', `query payload does not satisfy anchorprobe.request.v1 (${detail})`);
  }
  return { ok: true, value: parsed.data };
}

/** Parse one inbound line. Size is checked by the caller before parsing. */
export function parseWorkerRequest(line: string): { ok: true; request: ReplicaWorkerRequest } | { ok: false; error: ReplicaWorkerError } {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch (error) {
    return { ok: false, error: { code: 'REPLICA_MESSAGE_INVALID', message: `message is not valid JSON: ${String(error)}` } };
  }
  if (!isPlainObject(raw)) return { ok: false, error: { code: 'REPLICA_MESSAGE_INVALID', message: 'message must be an object' } };
  const extras = unknownKeys(raw, ['type', 'id', 'payload']);
  if (extras.length > 0) return { ok: false, error: { code: 'REPLICA_MESSAGE_INVALID', message: `message carries unknown field(s): ${extras.join(', ')}` } };
  const idIssue = validateId(raw.id);
  if (idIssue !== null) return { ok: false, error: { code: 'REPLICA_MESSAGE_INVALID', message: idIssue } };
  const type = raw.type;
  if (typeof type !== 'string' || !(replicaWorkerMessageTypes as readonly string[]).includes(type)) {
    return { ok: false, error: { code: 'REPLICA_MESSAGE_UNKNOWN_TYPE', message: `unknown message type ${JSON.stringify(type)}` } };
  }
  const payload = raw.payload;
  if (type === 'status' || type === 'shutdown') {
    if (payload !== undefined && !isPlainObject(payload)) {
      return { ok: false, error: { code: 'REPLICA_MESSAGE_INVALID', message: `${type} payload must be an object when present` } };
    }
    return { ok: true, request: { type, id: raw.id as string, payload } };
  }
  if (!isPlainObject(payload)) {
    return { ok: false, error: { code: 'REPLICA_MESSAGE_INVALID', message: `${type} payload must be an object` } };
  }
  // Global byte-shape guard first: nesting depth, array length and string size
  // are bounded before any type-specific interpretation happens (ADR-011 §8.1).
  const shape = checkPayloadShape(payload);
  if (!shape.ok) return { ok: false, error: { code: shape.code, message: shape.message } };
  const validated = type === 'init'
    ? validateInit(payload)
    : type === 'apply'
      ? validateApply(payload)
      : type === 'cancel'
        ? validateCancel(payload)
        : validateQuery(payload);
  if (!validated.ok) return { ok: false, error: { code: validated.code, message: validated.message } };
  return { ok: true, request: { type: type as ReplicaWorkerMessageType, id: raw.id as string, payload: validated.value } };
}

/**
 * Parse one outbound protocol line (parent side). Strictly validated: unknown
 * fields rejected, `id` echoed verbatim, and exactly one of `payload`/`error`.
 */
export function parseWorkerResponse(line: string): { ok: true; response: ReplicaWorkerResponse } | { ok: false; error: ReplicaWorkerError } {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch (error) {
    return { ok: false, error: { code: 'REPLICA_MESSAGE_INVALID', message: `response is not valid JSON: ${String(error)}` } };
  }
  if (!isPlainObject(raw)) return { ok: false, error: { code: 'REPLICA_MESSAGE_INVALID', message: 'response must be an object' } };
  const extras = unknownKeys(raw, ['ok', 'id', 'type', 'payload', 'error']);
  if (extras.length > 0) return { ok: false, error: { code: 'REPLICA_MESSAGE_INVALID', message: `response carries unknown field(s): ${extras.join(', ')}` } };
  if (typeof raw.id !== 'string' || raw.id.length > 128) {
    return { ok: false, error: { code: 'REPLICA_MESSAGE_INVALID', message: 'response id must be a bounded string' } };
  }
  if (raw.ok === true) {
    const type = raw.type;
    if (typeof type !== 'string' || !(replicaWorkerMessageTypes as readonly string[]).includes(type)) {
      return { ok: false, error: { code: 'REPLICA_RESPONSE_INVALID', message: `response type ${JSON.stringify(type)} is invalid` } };
    }
    return { ok: true, response: { ok: true, id: raw.id, type: type as ReplicaWorkerMessageType, payload: raw.payload } };
  }
  if (raw.ok === false) {
    const error = raw.error;
    if (!isPlainObject(error) || typeof error.code !== 'string' || typeof error.message !== 'string') {
      return { ok: false, error: { code: 'REPLICA_MESSAGE_INVALID', message: 'failure response must carry {code,message}' } };
    }
    return { ok: true, response: { ok: false, id: raw.id, error: { code: error.code, message: error.message } } };
  }
  return { ok: false, error: { code: 'REPLICA_MESSAGE_INVALID', message: 'response.ok must be a boolean' } };
}

// ---------------------------------------------------------------------------
// Session: the single replica this process serves
// ---------------------------------------------------------------------------

class ReplicaWorkerSession {
  #store: ReplicaStore | null = null;

  get store(): ReplicaStore {
    const current = this.#store;
    if (current === null) throw new ReplicationError('REPLICA_NOT_INITIALIZED', 'worker has not received an init message yet');
    return current;
  }

  init(payload: unknown): ReplicaWorkerStatus {
    if (this.#store !== null) {
      throw new ReplicationError('REPLICA_ALREADY_INITIALIZED', `worker already serves replica ${this.#store.replicaId}`);
    }
    const initPayload = payload as ReplicaWorkerInitPayload;
    const store = ReplicaStore.open({
      root: initPayload.root,
      replicaId: initPayload.replicaId,
      projectScope: initPayload.projectScope,
      ...(initPayload.clusterEpoch === undefined ? {} : { clusterEpoch: initPayload.clusterEpoch }),
      ...(initPayload.snapshot === undefined ? {} : { snapshot: initPayload.snapshot }),
    });
    this.#store = store;
    return this.status();
  }

  apply(payload: unknown): ReplicaWorkerApplyResult {
    const applyPayload = payload as ReplicaWorkerApplyPayload;
    const events = applyPayload.events;
    for (let index = 0; index < events.length; index += 1) {
      const issue = committedEnvelopeIssue(events[index]);
      if (issue !== null) throw new ReplicationError('REPLICA_CORRUPT_EVENT', `events[${index}]: ${issue}`);
    }
    const store = this.store;
    const report = store.applyCommitted(events, applyPayload.projectScope === undefined ? {} : { projectScope: applyPayload.projectScope });
    return { report, commitIndex: store.commitIndex, viewDigest: store.viewDigest };
  }

  query(payload: unknown): DistributedNodeResponse & {
    readonly replicaId: string;
    readonly snapshot: AnchorProbeSnapshot;
  } {
    const request = payload as ReturnType<typeof anchorProbeRequestSchema.parse>;
    const store = this.store;
    if (request.project_scope !== store.projectScope) {
      throw new ReplicationError(
        'SCOPE_DENIED',
        `query scope ${JSON.stringify(request.project_scope)} does not match replica scope ${JSON.stringify(store.projectScope)}`,
      );
    }
    const metadata = store.clusterMetadata();
    return {
      candidates: store.candidates(),
      edges: store.adjacency(),
      commitIndex: store.commitIndex,
      viewDigest: store.viewDigest,
      evidenceDigest: metadata.evidence_digest,
      state: metadata.partial ? 'LAGGING' : 'ACTIVE',
      clusterEpoch: store.clusterEpoch ?? '',
      replicaId: store.replicaId,
      snapshot: store.snapshot,
    };
  }

  status(): ReplicaWorkerStatus {
    const store = this.store;
    const metadata = store.clusterMetadata();
    return {
      replicaId: store.replicaId,
      pid: process.pid,
      commitIndex: store.commitIndex,
      viewDigest: store.viewDigest,
      evidenceDigest: metadata.evidence_digest,
      state: metadata.partial ? 'LAGGING' : 'ACTIVE',
      clusterMetadata: metadata,
      snapshot: store.snapshot,
      cursor: {
        commitIndex: store.cursor.commitIndex,
        lastEventId: store.cursor.lastEventId,
        lastEventHash: store.cursor.lastEventHash,
        viewDigest: store.cursor.viewDigest,
      },
    };
  }

  shutdown(): { stopped: true; replicaId: string } {
    const store = this.#store;
    if (store === null) throw new ReplicationError('REPLICA_NOT_INITIALIZED', 'worker has no replica to stop');
    const replicaId = store.replicaId;
    store.close();
    this.#store = null;
    return { stopped: true, replicaId };
  }

  close(): void {
    const store = this.#store;
    this.#store = null;
    store?.close();
  }
}

function errorResponse(id: string, error: unknown): ReplicaWorkerFailure {
  if (error instanceof ReplicationError) {
    return { ok: false, id, error: { code: error.code, message: error.message } };
  }
  const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'REPLICA_INTERNAL_ERROR';
  return { ok: false, id, error: { code, message: error instanceof Error ? error.message : String(error) } };
}

function successResponse(id: string, type: ReplicaWorkerMessageType, payload: unknown): ReplicaWorkerSuccess {
  return { ok: true, id, type, payload };
}

// ---------------------------------------------------------------------------
// Stream loop
// ---------------------------------------------------------------------------

export interface ReplicaWorkerRunOptions {
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
  readonly errorOutput?: NodeJS.WritableStream;
  /** Parent-liveness heartbeat; `0` disables it (stdin close still exits). */
  readonly heartbeatMs?: number;
  readonly maxMessageBytes?: number;
}

export interface ReplicaWorkerRunner {
  readonly terminate: (code?: number) => void;
}

function writeLine(output: NodeJS.WritableStream, line: string): void {
  try {
    output.write(`${line}\n`);
  } catch (error) {
    // A broken stdout means the parent is gone; there is nobody left to answer.
    process.stderr.write(`[replica-worker] failed to write response: ${String(error)}\n`);
  }
}

function encode(response: ReplicaWorkerResponse): string {
  return JSON.stringify(response);
}

/**
 * Run the worker protocol against the supplied streams. Returns immediately
 * after wiring listeners; call `terminate()` to leave deterministically.
 */
export function runReplicaWorker(options: ReplicaWorkerRunOptions = {}): ReplicaWorkerRunner {
  const input: NodeJS.ReadableStream = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const errorOutput = options.errorOutput ?? process.stderr;
  const heartbeatMs = options.heartbeatMs ?? REPLICA_WORKER_DEFAULT_HEARTBEAT_MS;
  const maxMessageBytes = options.maxMessageBytes ?? REPLICA_WORKER_MAX_MESSAGE_BYTES;

  const session = new ReplicaWorkerSession();
  const cancelledIds = new BoundedIdSet(REPLICA_WORKER_CANCEL_MEMORY);
  const completedIds = new BoundedIdSet(REPLICA_WORKER_CANCEL_MEMORY);
  let terminated = false;
  let pending = Buffer.alloc(0);
  let discarding = false;
  let lastActivity = Date.now();

  const terminate = (code = 0): void => {
    if (terminated) return;
    terminated = true;
    if (timer !== undefined) clearInterval(timer);
    session.close();
    input.removeAllListeners('data');
    input.removeAllListeners('end');
    input.removeAllListeners('close');
    input.removeAllListeners('error');
    process.removeListener('uncaughtException', onUncaught);
    process.removeListener('unhandledRejection', onUncaught);
    process.exit(code);
  };

  const onUncaught = (error: unknown): void => {
    errorOutput.write(`[replica-worker] fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    terminate(1);
  };

  const handleLine = (text: string): void => {
    const parsed = parseWorkerRequest(text.endsWith('\r') ? text.slice(0, -1) : text);
    if (!parsed.ok) {
      writeLine(output, encode({ ok: false, id: '', error: parsed.error } satisfies ReplicaWorkerFailure));
      return;
    }
    const request = parsed.request;
    try {
      if (request.type === 'cancel') {
        const target = (request.payload as ReplicaWorkerCancelPayload).targetId;
        if (cancelledIds.has(target)) {
          writeLine(output, encode(successResponse(request.id, request.type, { cancelled: true, targetId: target } satisfies ReplicaWorkerCancelResult)));
          return;
        }
        if (completedIds.has(target)) {
          writeLine(output, encode(successResponse(request.id, request.type, {
            cancelled: false,
            targetId: target,
            reason: 'completed',
          } satisfies ReplicaWorkerCancelResult)));
          return;
        }
        cancelledIds.add(target);
        writeLine(output, encode(successResponse(request.id, request.type, { cancelled: true, targetId: target } satisfies ReplicaWorkerCancelResult)));
        return;
      }
      if (cancelledIds.has(request.id)) {
        // A cancel that arrived before this line is binding: never execute it.
        writeLine(output, encode({
          ok: false,
          id: request.id,
          error: { code: 'REPLICA_QUERY_CANCELLED', message: 'request was cancelled before execution' },
        } satisfies ReplicaWorkerFailure));
        return;
      }
      switch (request.type) {
        case 'init':
          writeLine(output, encode(successResponse(request.id, request.type, session.init(request.payload))));
          completedIds.add(request.id);
          return;
        case 'apply':
          writeLine(output, encode(successResponse(request.id, request.type, session.apply(request.payload))));
          completedIds.add(request.id);
          return;
        case 'query':
          writeLine(output, encode(successResponse(request.id, request.type, session.query(request.payload))));
          completedIds.add(request.id);
          return;
        case 'status':
          writeLine(output, encode(successResponse(request.id, request.type, session.status())));
          completedIds.add(request.id);
          return;
        case 'shutdown': {
          const payload = session.shutdown();
          writeLine(output, encode(successResponse(request.id, request.type, payload)));
          // Give the line a chance to flush before leaving; nothing else runs.
          setTimeout(() => terminate(0), 20);
          return;
        }
        default:
          writeLine(output, encode(errorResponse(request.id, new Error(`unsupported message type`))));
          return;
      }
    } catch (error) {
      writeLine(output, encode(errorResponse(request.id, error)));
    }
  };

  const tooLarge = (): void => {
    writeLine(output, encode({
      ok: false,
      id: '',
      error: {
        code: 'REPLICA_MESSAGE_TOO_LARGE',
        message: `message exceeds the ${String(maxMessageBytes)} byte protocol limit`,
      },
    } satisfies ReplicaWorkerFailure));
  };

  const onData = (chunk: Buffer | string): void => {
    if (terminated) return;
    lastActivity = Date.now();
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    let offset = 0;
    for (;;) {
      const newline = buffer.indexOf(0x0a, offset);
      if (newline === -1) {
        const tail = buffer.subarray(offset);
        if (discarding) return;
        if (pending.length + tail.length > maxMessageBytes) {
          discarding = true;
          pending = Buffer.alloc(0);
          tooLarge();
          return;
        }
        pending = pending.length === 0 ? Buffer.from(tail) : Buffer.concat([pending, tail]);
        return;
      }
      const line = buffer.subarray(offset, newline);
      offset = newline + 1;
      if (discarding) {
        discarding = false;
        pending = Buffer.alloc(0);
        continue;
      }
      if (pending.length + line.length > maxMessageBytes) {
        pending = Buffer.alloc(0);
        tooLarge();
        continue;
      }
      const full = pending.length === 0 ? line : Buffer.concat([pending, line]);
      pending = Buffer.alloc(0);
      handleLine(full.toString('utf8'));
    }
  };

  input.on('data', onData);
  const onInputClosed = (): void => terminate(0);
  input.on('end', onInputClosed);
  input.on('close', onInputClosed);
  input.on('error', onInputClosed);

  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUncaught);

  const timer = heartbeatMs > 0
    ? setInterval(() => {
      if (terminated) return;
      if (Date.now() - lastActivity > heartbeatMs) {
        errorOutput.write('[replica-worker] parent heartbeat lost; exiting\n');
        terminate(0);
      }
    }, Math.min(Math.max(heartbeatMs, 250), 1_000))
    : undefined;

  return { terminate };
}

// ---------------------------------------------------------------------------
// Direct-entry guard
// ---------------------------------------------------------------------------

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry.length === 0) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

/** Opt-in heartbeat override for operators and tests (`REPLICA_WORKER_HEARTBEAT_MS`). */
function heartbeatFromEnv(): number {
  const raw = process.env.REPLICA_WORKER_HEARTBEAT_MS;
  if (raw === undefined || raw.trim().length === 0) return REPLICA_WORKER_DEFAULT_HEARTBEAT_MS;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : REPLICA_WORKER_DEFAULT_HEARTBEAT_MS;
}

if (invokedDirectly()) {
  runReplicaWorker({ heartbeatMs: heartbeatFromEnv() });
}

/** Re-exported so a caller can enumerate the states it may receive. */
export { distributedReplicaStates };
