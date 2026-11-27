import { join, resolve } from 'node:path';
import { canonicalJson, genesisHash, hashEvent, ledgerEventSchema, type LedgerEvent } from '../ledger/event.ts';
import { replayLedger } from '../ledger/replay.ts';
import { viewDigest, type ViewReplayEntry } from '../ledger/views.ts';
import type { Ledger } from '../ledger/ledger.ts';

/**
 * T-125 / ADR-011 §4: committed-event export, ordered idempotent application,
 * cursor resume and fail-closed integrity reporting for read-only replicas.
 *
 * The exporter is strictly read-only: it reads committed ledger segments through
 * `replayLedger` and never opens the ledger for writing, never touches the
 * views cache and never walks the source tree. Application is deterministic and
 * re-entrant: the same batch applied twice is a duplicate-only no-op, and a
 * corrupted batch throws before any state is published.
 */

// ---------------------------------------------------------------------------
// Bounds and errors
// ---------------------------------------------------------------------------

/** ADR-011 §4.2/§5: pull chunks are bounded; 256 is the documented default. */
export const REPLICATION_DEFAULT_LIMIT = 256;
export const REPLICATION_MAX_LIMIT = 1024;
/** ADR-011 §4.3: out-of-order buffering is bounded so a hostile/faulty stream cannot grow without limit. */
export const REPLICA_BUFFER_MAX_EVENTS = 4096;
export const REPLICA_BUFFER_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Fail-closed replication error. `code` is one of the ADR-011 §11 codes plus
 * the transport-independent `REPLICA_*` codes owned by this module. A `report`
 * is attached when the failure was detected while inspecting a batch, so a
 * caller can still account for the rejected material.
 */
export class ReplicationError extends Error {
  readonly code: string;
  readonly report?: ReplicationReport;

  constructor(code: string, message: string, options: { cause?: unknown; report?: ReplicationReport } = {}) {
    super(`[${code}] ${message}`, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ReplicationError';
    this.code = code;
    if (options.report !== undefined) this.report = options.report;
  }
}

export const replicationErrorCodes = [
  'REPLICA_CORRUPT_EVENT',
  'REPLICA_EVENT_CONFLICT',
  'REPLICA_CHAIN_BREAK',
  'REPLICA_SEQ_CONFLICT',
  'REPLICA_BUFFER_EXCEEDED',
  'REPLICA_BATCH_INVALID',
  'REPLICA_INCOMPLETE_REBUILD',
  'REPLICA_CURSOR_INVALID',
  'REPLICA_WRITE_FORBIDDEN',
  'REPLICA_REDACTED_EVENT',
  'REPLICATION_EXPORT_INVALID',
  'VIEW_DIGEST_MISMATCH',
  'SCOPE_DENIED',
] as const;
export type ReplicationErrorCode = (typeof replicationErrorCodes)[number];

// ---------------------------------------------------------------------------
// Committed-event envelope
// ---------------------------------------------------------------------------

/**
 * One committed event as replicated to a replica. `event` keeps the committed
 * bytes verbatim (needed to rebuild the same projection); the flattened fields
 * are the wire-stable identity a consumer can inspect without re-parsing.
 * `recordedAt` is derived from the event HLC exactly like the views projection.
 */
export interface CommittedEventEnvelope {
  /** 1-based position in the primary's canonical (HLC-ordered) commit sequence. */
  readonly seq: number;
  readonly eventId: string;
  readonly hash: string;
  readonly kind: LedgerEvent['kind'];
  readonly payload: Record<string, unknown>;
  readonly recordedAt: string;
  /** Segment name the event was committed in; required for per-segment chain checks. */
  readonly segment: string;
  readonly prevHash: string;
  readonly event: LedgerEvent;
  /**
   * True only for a `secretScreen: 'redact'` export. Redacted envelopes are
   * for egress audit only and are refused by {@link applyEventBatch}: they can
   * never reproduce the primary view.
   */
  readonly contentRedacted: boolean;
}

/**
 * Build a self-consistent envelope for one committed event. Used by the
 * exporter and by a replica rebuilding its persisted material.
 */
export function committedEnvelopeFromEvent(event: LedgerEvent, seq: number, segment: string): CommittedEventEnvelope {
  return {
    seq,
    eventId: event.id,
    hash: hashEvent(event),
    kind: event.kind,
    payload: event.payload,
    recordedAt: new Date(event.hlc.physical).toISOString(),
    segment,
    prevHash: event.prev_hash,
    event,
    contentRedacted: false,
  };
}

export interface ExportCommittedEventsOptions {
  /** Exclusive lower bound on `seq` (ADR-011 §4.2 `from_commit_index`). */
  readonly fromCommitIndex?: number;
  /** Bounded chunk size; defaults to 256, hard maximum 1024. */
  readonly limit?: number;
  /** Declared project scope, echoed so a replica can refuse a foreign batch. */
  readonly projectScope?: string;
  /** Defaults to `audit`: report sensitive-looking text without altering bytes. */
  readonly secretScreen?: 'off' | 'audit' | 'redact';
}

export interface ReplicationPullResponse {
  readonly primary_commit_index: number;
  /** `viewDigest(entries)` over the primary's full committed prefix. */
  readonly view_digest: string;
  readonly events: readonly CommittedEventEnvelope[];
  readonly truncated: boolean;
  readonly sensitive_findings: readonly SensitiveFinding[];
  readonly project_scope?: string;
}

// ---------------------------------------------------------------------------
// Sensitive-path screening (ADR-006 §2.5 policy, reused verbatim)
//
// The regex vocabulary mirrors src/connect/backup.ts so the backup boundary and
// the replication boundary classify the same paths identically. Replication
// never *reads* those paths; this screen audits event text and can redact it
// before a future transport egress (T-127/T-129).
// ---------------------------------------------------------------------------

const SENSITIVE_DIRECTORY = /^(?:secrets?|credentials?|passwords?|tokens?|private(?:-?keys?)?)$/iu;
const SENSITIVE_FILE_NAME = /(?:^|[._-])(?:secret|secrets|credential|credentials|password|passwords|token|tokens|api[-_]?key|private[-_]?key)$/iu;
const KEY_MATERIAL = /\.(?:pem|key|p12|pfx|kdbx|ppk)$/iu;
const ENV_FILE = /^\.env(?:[.].*)?$/iu;
const CREDENTIAL_STORE = /^credentials\.json$/iu;
const SSH_KEY_NAME = /^(?:id_rsa|id_ed25519)$/iu;
/** A path-like token embedded in free text (before a delimiter or string end). */
const EMBEDDED_SENSITIVE = /(?:^|[\s"'`(=,;:[\]])(?:\.env(?:[.][\w.-]+)?|(?:[\w.-]+\/)*[\w.-]+\.(?:pem|key|p12|pfx|kdbx|ppk)|id_rsa|id_ed25519)(?=$|[\s"'`),;:.[\]])/iu;

export interface SensitiveFinding {
  /** Payload location, e.g. `events[3].payload.text`. */
  readonly path: string;
  readonly reason: string;
}

/** Conservative sensitive-path classification shared with the backup policy. */
export function sensitivePathReason(path: string): string | null {
  const parts = path.split('/');
  const base = parts.at(-1) ?? '';
  if (ENV_FILE.test(base)) return 'environment file';
  if (parts.some((segment) => SENSITIVE_DIRECTORY.test(segment))) return 'sensitive directory';
  if (CREDENTIAL_STORE.test(base)) return 'credential store';
  if (SENSITIVE_FILE_NAME.test(base)) return 'sensitive file name';
  if (KEY_MATERIAL.test(base)) return 'key material';
  if (SSH_KEY_NAME.test(base)) return 'ssh private key';
  return null;
}

function embeddedSensitiveReason(text: string): string | null {
  if (/(?:^|[/\\])\.env(?:[.][\w.-]+)?$/mu.test(text) || ENV_FILE.test(text)) return 'environment file';
  if (KEY_MATERIAL.test(text)) return 'key material';
  if (/(?:^|[/\\])id_(?:rsa|ed25519)$/mu.test(text) || SSH_KEY_NAME.test(text)) return 'ssh private key';
  return null;
}

function containsSensitiveText(text: string): SensitiveFinding['reason'] | null {
  for (const token of text.split(/[\s"'`()\[\]{},;=]+/u)) {
    if (token.length === 0) continue;
    const reason = sensitivePathReason(token);
    if (reason !== null) return reason;
  }
  if (EMBEDDED_SENSITIVE.test(text)) return embeddedSensitiveReason(text);
  return null;
}

/** Recursively screen a payload value for sensitive-looking path text. */
export function screenSensitiveText(value: unknown, location = 'payload'): SensitiveFinding[] {
  const findings: SensitiveFinding[] = [];
  const seen = new Set<string>();
  const push = (path: string, reason: string): void => {
    const key = `${path}\u0000${reason}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ path, reason });
  };
  const visit = (node: unknown, path: string): void => {
    if (typeof node === 'string') {
      const reason = containsSensitiveText(node);
      if (reason !== null) push(path, reason);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) visit(child, path.length === 0 ? key : `${path}.${key}`);
    }
  };
  visit(value, location);
  return findings;
}

function redactNode(node: unknown): unknown {
  if (typeof node === 'string') return containsSensitiveText(node) === null ? node : '[REDACTED]';
  if (Array.isArray(node)) return node.map(redactNode);
  if (node !== null && typeof node === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node)) result[key] = redactNode(child);
    return result;
  }
  return node;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Export the primary's committed events in canonical commit order. Read-only:
 * it replays `<root>/.ano/ledger` and performs no write, lock or cache access.
 * Uncommitted/in-flight tails are not part of `replayLedger`'s committed result.
 */
export function exportCommittedEvents(ledger: Ledger, options: ExportCommittedEventsOptions = {}): ReplicationPullResponse {
  const fromCommitIndex = options.fromCommitIndex ?? 0;
  if (!Number.isSafeInteger(fromCommitIndex) || fromCommitIndex < 0) {
    throw new ReplicationError('REPLICATION_EXPORT_INVALID', `fromCommitIndex must be a nonnegative integer, got ${String(fromCommitIndex)}`);
  }
  const limit = options.limit ?? REPLICATION_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > REPLICATION_MAX_LIMIT) {
    throw new ReplicationError('REPLICATION_EXPORT_INVALID', `limit must be an integer in [1, ${REPLICATION_MAX_LIMIT}], got ${String(limit)}`);
  }
  const ledgerDirectory = join(resolve(ledger.root), '.ano', 'ledger');
  const replay = replayLedger(ledgerDirectory);
  const primaryCommitIndex = replay.entries.length;
  const screen = options.secretScreen ?? 'audit';
  if (screen !== 'off' && screen !== 'audit' && screen !== 'redact') {
    throw new ReplicationError('REPLICATION_EXPORT_INVALID', `unknown secretScreen mode ${JSON.stringify(screen)}`);
  }

  const events: CommittedEventEnvelope[] = [];
  const findings: SensitiveFinding[] = [];
  const stop = Math.min(primaryCommitIndex, fromCommitIndex + limit);
  for (let index = fromCommitIndex; index < stop; index += 1) {
    const entry = replay.entries[index]!;
    const event = entry.event;
    const seq = index + 1;
    if (screen !== 'off') findings.push(...screenSensitiveText(event.payload, `events[${seq}].payload`));
    const contentRedacted = screen === 'redact';
    events.push({
      seq,
      eventId: event.id,
      hash: hashEvent(event),
      kind: event.kind,
      payload: contentRedacted ? redactNode(event.payload) as Record<string, unknown> : event.payload,
      recordedAt: new Date(event.hlc.physical).toISOString(),
      segment: entry.segment,
      prevHash: event.prev_hash,
      event,
      contentRedacted,
    });
  }

  return {
    primary_commit_index: primaryCommitIndex,
    view_digest: viewDigest(replay.entries),
    events,
    truncated: stop < primaryCommitIndex,
    sensitive_findings: findings,
    ...(options.projectScope === undefined ? {} : { project_scope: options.projectScope }),
  };
}

// ---------------------------------------------------------------------------
// Ordered idempotent application
// ---------------------------------------------------------------------------

/** Accumulated replica state. Immutable values; {@link applyEventBatch} returns a new state. */
export interface ReplicaApplyState {
  /** Highest contiguously applied seq; equals the replica commit index. */
  readonly commitIndex: number;
  readonly lastEventId: string | null;
  readonly lastEventHash: string;
  readonly duplicateCount: number;
  readonly outOfOrderCount: number;
  readonly corruptCount: number;
  /** Contiguous applied entries in seq order (the exact projection input). */
  readonly entries: readonly ViewReplayEntry[];
  /** eventId -> hash for every applied event (idempotency by id). */
  readonly applied: ReadonlyMap<string, string>;
  /** Received-but-not-yet-contiguous events keyed by seq. */
  readonly pending: ReadonlyMap<number, CommittedEventEnvelope>;
  /** Cached pending byte size, used by the bounded-buffer check. */
  readonly pendingBytes: number;
  /** Per-segment hash-chain head (same chain semantics `eventChain` enforces). */
  readonly segmentHeads: ReadonlyMap<string, string>;
}

export function emptyReplicaApplyState(): ReplicaApplyState {
  return {
    commitIndex: 0,
    lastEventId: null,
    lastEventHash: genesisHash,
    duplicateCount: 0,
    outOfOrderCount: 0,
    corruptCount: 0,
    entries: [],
    applied: new Map<string, string>(),
    pending: new Map<number, CommittedEventEnvelope>(),
    pendingBytes: 0,
    segmentHeads: new Map<string, string>(),
  };
}

export interface ReplicaApplyOptions {
  readonly bufferMaxEvents?: number;
  readonly bufferMaxBytes?: number;
}

export interface ReplicationReport {
  /** Events newly applied (including buffered events flushed by this batch). */
  readonly applied: number;
  /** Events recognized as already applied (zero side effect). */
  readonly duplicates: number;
  /** Events received beyond the contiguous prefix and therefore buffered. */
  readonly outOfOrder: number;
  /** Missing seq numbers in the current gap window, ascending. */
  readonly gaps: readonly number[];
  /** Corrupt events observed historically; a corrupt batch fails closed instead of being counted into the view. */
  readonly corrupt: number;
  readonly commitIndex: number;
  readonly viewDigest: string;
  /** True only when the applied prefix has no pending/gap event. */
  readonly complete: boolean;
  readonly pendingCount: number;
}

export interface ReplicaApplyResult {
  readonly state: ReplicaApplyState;
  readonly report: ReplicationReport;
}

type WorkingState = {
  -readonly [K in keyof ReplicaApplyState]: ReplicaApplyState[K] extends ReadonlyMap<infer MapKey, infer MapValue>
    ? Map<MapKey, MapValue>
    : ReplicaApplyState[K] extends readonly (infer Element)[]
      ? Element[]
      : ReplicaApplyState[K];
};

function cloneState(state: ReplicaApplyState): WorkingState {
  return {
    commitIndex: state.commitIndex,
    lastEventId: state.lastEventId,
    lastEventHash: state.lastEventHash,
    duplicateCount: state.duplicateCount,
    outOfOrderCount: state.outOfOrderCount,
    corruptCount: state.corruptCount,
    entries: [...state.entries],
    applied: new Map(state.applied),
    pending: new Map(state.pending),
    pendingBytes: state.pendingBytes,
    segmentHeads: new Map(state.segmentHeads),
  };
}

const ISO_RECORDING = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

/** Validate one envelope's structure and self-consistency (hash over bytes). */
export function committedEnvelopeIssue(envelope: unknown): string | null {
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) return 'envelope must be an object';
  const value = envelope as Partial<CommittedEventEnvelope>;
  if (!Number.isSafeInteger(value.seq) || (value.seq as number) < 1) return 'seq must be a positive integer';
  if (typeof value.eventId !== 'string' || value.eventId.length === 0) return 'eventId must be a non-empty string';
  if (typeof value.hash !== 'string' || !SHA256.test(value.hash)) return 'hash must be a lowercase sha256 hex digest';
  if (typeof value.kind !== 'string') return 'kind must be a string';
  if (typeof value.segment !== 'string' || value.segment.length === 0) return 'segment must be a non-empty string';
  if (typeof value.prevHash !== 'string' || !SHA256.test(value.prevHash)) return 'prevHash must be a lowercase sha256 hex digest';
  if (typeof value.recordedAt !== 'string' || !ISO_RECORDING.test(value.recordedAt)) return 'recordedAt must be an ISO-8601 UTC datetime';
  if (typeof value.contentRedacted !== 'boolean') return 'contentRedacted must be a boolean';
  if (value.contentRedacted) return 'contentRedacted envelopes cannot be applied to a replica view';
  const event = value.event;
  if (event === null || typeof event !== 'object' || Array.isArray(event)) return 'event must be an object';
  const parsed = ledgerEventSchema.safeParse(event);
  if (!parsed.success) return 'event does not satisfy ledgerEventSchema';
  if (parsed.data.id !== value.eventId) return 'eventId does not match event.id';
  if (parsed.data.kind !== value.kind) return 'kind does not match event.kind';
  if (parsed.data.prev_hash !== value.prevHash) return 'prevHash does not match event.prev_hash';
  if (canonicalJson(parsed.data.payload) !== canonicalJson(value.payload)) return 'payload does not match event.payload';
  const computed = hashEvent(parsed.data);
  if (computed !== value.hash) return `hash does not match hashEvent(event) (${computed})`;
  if (new Date(parsed.data.hlc.physical).toISOString() !== value.recordedAt) return 'recordedAt does not match the event HLC';
  return null;
}

function envelopeBytes(envelope: CommittedEventEnvelope): number {
  return Buffer.byteLength(JSON.stringify(envelope.event), 'utf8');
}

function missingGaps(commitIndex: number, pending: ReadonlyMap<number, CommittedEventEnvelope>): number[] {
  if (pending.size === 0) return [];
  let max = commitIndex;
  for (const seq of pending.keys()) if (seq > max) max = seq;
  const gaps: number[] = [];
  for (let seq = commitIndex + 1; seq <= max; seq += 1) {
    if (!pending.has(seq)) gaps.push(seq);
  }
  return gaps;
}

function applyContiguous(next: WorkingState, envelope: CommittedEventEnvelope): void {
  const head = next.segmentHeads.get(envelope.segment);
  if (head === undefined) {
    // Same chain semantics as eventChain: a segment's first event chains from genesis.
    if (envelope.prevHash !== genesisHash) {
      throw new ReplicationError('REPLICA_CHAIN_BREAK', `first event ${envelope.eventId} of segment ${envelope.segment} does not chain from the genesis hash`);
    }
  } else if (envelope.prevHash !== head) {
    throw new ReplicationError('REPLICA_CHAIN_BREAK', `event ${envelope.eventId} prev_hash does not match the head of segment ${envelope.segment}`);
  }
  next.segmentHeads.set(envelope.segment, envelope.hash);
  next.entries.push({ event: envelope.event, segment: envelope.segment });
  next.commitIndex = envelope.seq;
  next.lastEventId = envelope.eventId;
  next.lastEventHash = envelope.hash;
  next.applied.set(envelope.eventId, envelope.hash);
}

function drainPending(next: WorkingState): number {
  let flushed = 0;
  for (;;) {
    const envelope = next.pending.get(next.commitIndex + 1);
    if (envelope === undefined) break;
    next.pending.delete(envelope.seq);
    next.pendingBytes -= envelopeBytes(envelope);
    applyContiguous(next, envelope);
    flushed += 1;
  }
  return flushed;
}

function buildReport(state: ReplicaApplyState, applied: number, duplicates: number, outOfOrder: number, corrupt: number): ReplicationReport {
  const gaps = missingGaps(state.commitIndex, state.pending);
  return {
    applied,
    duplicates,
    outOfOrder,
    gaps,
    corrupt,
    commitIndex: state.commitIndex,
    viewDigest: viewDigest(state.entries),
    complete: gaps.length === 0 && state.pending.size === 0,
    pendingCount: state.pending.size,
  };
}

/**
 * Apply one batch deterministically and idempotently.
 *
 * - Same `eventId` with the same hash: duplicate, zero side effect.
 * - Same `eventId` with a different hash: `REPLICA_EVENT_CONFLICT`.
 * - `seq` greater than the next expected value: buffered, reported as
 *   `outOfOrder` plus an explicit `gaps` window; never applied ahead of a hole.
 * - Hash mismatch, invalid structure or a broken segment chain: throws
 *   fail-closed. The input `state` is never mutated, so a rejected batch leaves
 *   no half-applied view behind.
 */
export function applyEventBatch(
  state: ReplicaApplyState,
  batch: readonly CommittedEventEnvelope[],
  options: ReplicaApplyOptions = {},
): ReplicaApplyResult {
  if (!Array.isArray(batch)) throw new ReplicationError('REPLICA_BATCH_INVALID', 'batch must be an array of committed event envelopes');
  const bufferMaxEvents = options.bufferMaxEvents ?? REPLICA_BUFFER_MAX_EVENTS;
  const bufferMaxBytes = options.bufferMaxBytes ?? REPLICA_BUFFER_MAX_BYTES;
  if (!Number.isSafeInteger(bufferMaxEvents) || bufferMaxEvents < 1) {
    throw new ReplicationError('REPLICA_BATCH_INVALID', `bufferMaxEvents must be a positive integer, got ${String(bufferMaxEvents)}`);
  }
  if (!Number.isSafeInteger(bufferMaxBytes) || bufferMaxBytes < 1) {
    throw new ReplicationError('REPLICA_BATCH_INVALID', `bufferMaxBytes must be a positive integer, got ${String(bufferMaxBytes)}`);
  }

  const issues: string[] = [];
  const valid: CommittedEventEnvelope[] = [];
  for (let index = 0; index < batch.length; index += 1) {
    const issue = committedEnvelopeIssue(batch[index]);
    if (issue === null) valid.push(batch[index]!);
    else issues.push(`events[${index}]: ${issue}`);
  }
  if (issues.length > 0) {
    const code = issues.some((issue) => issue.includes('contentRedacted')) ? 'REPLICA_REDACTED_EVENT' : 'REPLICA_CORRUPT_EVENT';
    throw new ReplicationError(
      code,
      `batch contains ${issues.length} rejected event(s): ${issues.join('; ')}`,
      { report: buildReport(state, 0, 0, 0, state.corruptCount + issues.length) },
    );
  }

  const next = cloneState(state);
  let applied = 0;
  let duplicates = 0;
  let outOfOrder = 0;
  const seenInBatch = new Map<string, string>();
  const bySeq = new Map<number, CommittedEventEnvelope>();

  for (const envelope of valid) {
    const batchHash = seenInBatch.get(envelope.eventId);
    if (batchHash !== undefined) {
      if (batchHash !== envelope.hash) {
        throw new ReplicationError('REPLICA_EVENT_CONFLICT', `event ${envelope.eventId} appears twice with different hashes`);
      }
      duplicates += 1;
      continue;
    }
    seenInBatch.set(envelope.eventId, envelope.hash);

    const appliedHash = next.applied.get(envelope.eventId);
    if (appliedHash !== undefined) {
      if (appliedHash !== envelope.hash) {
        throw new ReplicationError('REPLICA_EVENT_CONFLICT', `event ${envelope.eventId} was already applied with a different hash`);
      }
      duplicates += 1;
      continue;
    }

    const buffered = next.pending.get(envelope.seq);
    if (buffered !== undefined) {
      if (buffered.eventId !== envelope.eventId) {
        throw new ReplicationError('REPLICA_SEQ_CONFLICT', `seq ${envelope.seq} is already buffered for event ${buffered.eventId}`);
      }
      if (buffered.hash !== envelope.hash) {
        throw new ReplicationError('REPLICA_EVENT_CONFLICT', `event ${envelope.eventId} was already buffered with a different hash`);
      }
      duplicates += 1;
      continue;
    }

    if (bySeq.has(envelope.seq)) {
      throw new ReplicationError('REPLICA_SEQ_CONFLICT', `seq ${envelope.seq} appears twice in the batch`);
    }
    bySeq.set(envelope.seq, envelope);
  }

  const fresh = [...bySeq.values()].sort((left, right) => left.seq - right.seq);
  for (const envelope of fresh) {
    if (envelope.seq <= next.commitIndex) {
      throw new ReplicationError('REPLICA_SEQ_CONFLICT', `event ${envelope.eventId} has seq ${envelope.seq} at or below the applied commit index ${next.commitIndex}`);
    }
    if (envelope.seq === next.commitIndex + 1) {
      applyContiguous(next, envelope);
      applied += 1 + drainPending(next);
      continue;
    }
    if (next.pending.size + 1 > bufferMaxEvents) {
      throw new ReplicationError('REPLICA_BUFFER_EXCEEDED', `out-of-order buffer exceeds ${bufferMaxEvents} events`);
    }
    const bytes = envelopeBytes(envelope);
    if (next.pendingBytes + bytes > bufferMaxBytes) {
      throw new ReplicationError('REPLICA_BUFFER_EXCEEDED', `out-of-order buffer exceeds ${bufferMaxBytes} bytes`);
    }
    next.pending.set(envelope.seq, envelope);
    next.pendingBytes += bytes;
    next.outOfOrderCount += 1;
    outOfOrder += 1;
  }

  next.duplicateCount += duplicates;
  const report = buildReport(next, applied, duplicates, outOfOrder, next.corruptCount);
  return { state: next, report };
}

// ---------------------------------------------------------------------------
// Cursor and resume
// ---------------------------------------------------------------------------

/**
 * Replica cursor (ADR-011 §4.2). `commitIndex` is the contiguous applied seq;
 * `viewDigest` is `viewDigest(entries)` at that commit point, so resume can
 * detect a diverged local view before pulling more events.
 */
export interface ReplicaCursor {
  readonly commitIndex: number;
  readonly lastEventId: string | null;
  readonly lastEventHash: string;
  readonly viewDigest: string;
  readonly clusterEpoch?: string | number;
  readonly replicaId?: string;
}

export interface ReplicaCursorExtras {
  readonly clusterEpoch?: string | number;
  readonly replicaId?: string;
}

export function cursorFromState(state: ReplicaApplyState, extras: ReplicaCursorExtras = {}): ReplicaCursor {
  return {
    commitIndex: state.commitIndex,
    lastEventId: state.lastEventId,
    lastEventHash: state.lastEventHash,
    viewDigest: viewDigest(state.entries),
    ...(extras.clusterEpoch === undefined ? {} : { clusterEpoch: extras.clusterEpoch }),
    ...(extras.replicaId === undefined ? {} : { replicaId: extras.replicaId }),
  };
}

export function assertReplicaCursor(value: unknown): asserts value is ReplicaCursor {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ReplicationError('REPLICA_CURSOR_INVALID', 'replica cursor must be an object');
  }
  const cursor = value as Partial<ReplicaCursor>;
  if (!Number.isSafeInteger(cursor.commitIndex) || (cursor.commitIndex as number) < 0) {
    throw new ReplicationError('REPLICA_CURSOR_INVALID', 'replica cursor commitIndex must be a nonnegative integer');
  }
  if (cursor.lastEventId !== null && (typeof cursor.lastEventId !== 'string' || cursor.lastEventId.length === 0)) {
    throw new ReplicationError('REPLICA_CURSOR_INVALID', 'replica cursor lastEventId must be null or a non-empty string');
  }
  if (typeof cursor.lastEventHash !== 'string' || !SHA256.test(cursor.lastEventHash)) {
    throw new ReplicationError('REPLICA_CURSOR_INVALID', 'replica cursor lastEventHash must be a lowercase sha256 hex digest');
  }
  if (typeof cursor.viewDigest !== 'string' || !SHA256.test(cursor.viewDigest)) {
    throw new ReplicationError('REPLICA_CURSOR_INVALID', 'replica cursor viewDigest must be a lowercase sha256 hex digest');
  }
  if (cursor.clusterEpoch !== undefined && (typeof cursor.clusterEpoch !== 'string' && typeof cursor.clusterEpoch !== 'number')) {
    throw new ReplicationError('REPLICA_CURSOR_INVALID', 'replica cursor clusterEpoch must be a string or number');
  }
  if (cursor.replicaId !== undefined && (typeof cursor.replicaId !== 'string' || cursor.replicaId.length === 0)) {
    throw new ReplicationError('REPLICA_CURSOR_INVALID', 'replica cursor replicaId must be a non-empty string');
  }
}

/** Resume request derived from a cursor: pull strictly after the applied prefix. */
export function resumeFrom(cursor: ReplicaCursor): ReplicationResume {
  assertReplicaCursor(cursor);
  return {
    fromCommitIndex: cursor.commitIndex,
    expectedViewDigest: cursor.viewDigest,
    lastEventId: cursor.lastEventId,
  };
}

export interface ReplicationResume {
  /** Exclusive pull lower bound, matching `ExportCommittedEventsOptions.fromCommitIndex`. */
  readonly fromCommitIndex: number;
  readonly expectedViewDigest: string;
  readonly lastEventId: string | null;
}

/** Fail closed when a cursor no longer describes the supplied local state. */
export function assertCursorMatchesState(cursor: ReplicaCursor, state: ReplicaApplyState): void {
  assertReplicaCursor(cursor);
  if (cursor.commitIndex !== state.commitIndex || cursor.lastEventHash !== state.lastEventHash) {
    throw new ReplicationError('REPLICA_CURSOR_INVALID', 'cursor does not match the local replica state');
  }
  if (cursor.viewDigest !== viewDigest(state.entries)) {
    throw new ReplicationError('VIEW_DIGEST_MISMATCH', `replica view digest ${viewDigest(state.entries)} does not match cursor digest ${cursor.viewDigest}`);
  }
}

/** Gaps currently known to the state (exported for diagnostics/tests). */
export function replicaGaps(state: ReplicaApplyState): readonly number[] {
  return missingGaps(state.commitIndex, state.pending);
}
