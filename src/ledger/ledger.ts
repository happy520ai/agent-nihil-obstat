import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Hlc } from '../core/hlc.ts';
import type { SourceFingerprint } from '../core/fingerprint.ts';
import { fingerprintProject, resolveProjectSourceScan } from '../core/source-scan.ts';
import type { ResolvedProjectScan } from '../core/project-scan.ts';
import { withFileLock, withFileLockSync, type LockOptions } from '../core/lock.ts';
import { assertProjectPath } from '../core/paths.ts';
import { ulid } from '../core/ulid.ts';
import { hashEvent, lastHash, ledgerEventSchema, type LedgerEvent } from './event.ts';
import { isMemoryEventKind, ledgerPayloadIssues, type MemoryEventKind } from './payloads.ts';
import { encodeBatch, encodeEvents } from './segment.ts';
import { appendAtomically, findSessionSegment, sanitizeSessionId, segmentFileName, truncateSegmentFile } from './append.ts';
import { replayLedger, type ReplayResult } from './replay.ts';
import {
  assertLeaseId,
  assertRunId,
  LeaseExpiredError,
  LeaseHeldError,
  LeaseMismatchError,
  LeaseUnknownError,
  leaseAcquiredPayload,
  leaseHeartbeatPayload,
  leaseReclaimPayload,
  leaseReleasedPayload,
  normalizeTtlMs,
  type AcquireLeaseOptions,
  type LeaseTimingOptions,
  type ReleaseLeaseOptions,
  type RunLease,
} from './lease.ts';
import { IdempotencyConflictError, LedgerIntegrityError, applyEventToDb, canonicalForEvent, findIdempotency, initViews, invalidateViewDigest, isTaskStatus, listEvidence as listEvidenceRows, readAuditFinding, readAuditFindings, readAuditRuns, readEvidence, readEventById, readNote, readNotes, readReadinessAttestation, readReadinessAttestations, readReadinessEvidence, readReadinessEvidenceList, readReleaseApproval, readReleaseApprovals, readReleaseVerdict, readReleaseVerdicts, readRunLease, readRunLeases, readTask, readTaskCreatedEventId, readTaskCreationCanonical, readTasks, syncViews } from './views.ts';
import type { LedgerAuditFinding, LedgerAuditRun, LedgerNote, LedgerReadinessAttestation, LedgerReadinessEvidence, LedgerReleaseApproval, LedgerReleaseVerdict, ViewReplayEntry } from './views.ts';

export { LeaseExpiredError, LeaseHeldError, LeaseMismatchError, LeaseUnknownError } from './lease.ts';
export { DEFAULT_LEASE_TTL_MS, MAX_LEASE_TTL_MS } from './lease.ts';
export type { AcquireLeaseOptions, RunLease } from './lease.ts';

export type TaskStatus = 'todo' | 'in_progress' | 'done' | 'cancelled';
/**
 * Windows can transiently return EPERM/EBUSY/ENOENT for `open(path, 'wx')`
 * while another process is unlinking the same lock file (delete-pending).
 * The lock itself is still correct, so only lock *acquisition* is retried; an
 * operation that already started is never re-run.
 */
const LOCK_RETRY_ATTEMPTS = 20;
function transientLockError(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  return code === 'EPERM' || code === 'EBUSY' || code === 'ENOENT';
}
async function waitForLockRetry(attempt: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, Math.min(5 + attempt * 5, 100)));
}
export interface LedgerTask { id: string; status: TaskStatus; declaredFiles: string[]; title?: string; verdict?: unknown; originalStatus?: string; verified?: boolean; migrationWarning?: string }
export interface LedgerEvidence { id: string; taskId: string; evidence: Record<string, unknown>; testFiles: string[] }
export interface LedgerOpenOptions { actor?: string; sessionId?: string; clock?: () => number; lockTimeoutMs?: number; lockStaleAfterMs?: number }
export interface LedgerAppendInput { kind: LedgerEvent['kind']; payload: Record<string, unknown> }
export interface LedgerAppendResult { event?: LedgerEvent; duplicate: boolean }
export interface LedgerCreateTaskResult extends LedgerAppendResult { task: LedgerTask }
export interface LedgerUpdatePatch { status?: TaskStatus; verdict?: unknown }
export { IdempotencyConflictError, LedgerIntegrityError } from './views.ts';
export type { LedgerAuditFinding, LedgerAuditRun, LedgerNote, LedgerReadinessAttestation, LedgerReadinessEvidence, LedgerReleaseApproval, LedgerReleaseVerdict } from './views.ts';

/**
 * A completion was attempted without a Gate-issued verdict/evidence pair that
 * still matches the current source tree. The ledger never accepts a bare
 * `updateTask(status: 'done')` or a caller-supplied verdict.
 */
export class GateEvidenceError extends Error {
  readonly code = 'GATE_EVIDENCE_REQUIRED';
  constructor(message: string) { super(message); this.name = 'GateEvidenceError'; }
}

/**
 * Extensions that the Gate treats as source for "did the source change during
 * the run" checks. The ledger keeps its own copy so it does not import the
 * Structure extractor (and with it web-tree-sitter) merely to compare paths.
 */
const GATE_SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'] as const;
function isGateSourcePath(path: string): boolean { return GATE_SOURCE_EXTENSIONS.some((extension) => path.toLowerCase().endsWith(extension)); }
interface GateProof { evidenceId: string; fingerprint: string }

/**
 * ADR-005 §7: an append-layer precondition failed inside the locked append
 * transaction. Zero events were written; the caller re-reads state and retries.
 * This is a deterministic rejection, not an integrity failure: competing
 * revisions that depend on the same prior record are rejected here instead of
 * being silently ordered by HLC (HLC never acts as a last-writer-wins truth).
 */
export class MemoryPreconditionError extends Error {
  readonly code = 'MEMORY_PRECONDITION_FAILED';
  constructor(message: string) { super(message); this.name = 'MemoryPreconditionError'; }
}

export type MemoryRecordOrigin = 'governed' | 'legacy_unreviewed';
export type MemoryRecordStatus = 'active' | 'superseded' | 'conflicted' | 'retracted';

export interface DerivedMemoryRecord {
  /** Ledger event id of the event that introduced this record. */
  ref: string;
  /** Which event vocabulary introduced the record (notes are legacy records). */
  kind: 'note.recorded' | 'memory.revised' | 'memory.conflict.resolved';
  factKey: string | null;
  origin: MemoryRecordOrigin;
  status: MemoryRecordStatus;
  /** Record this one replaced, when any. */
  supersedes: string | null;
  /** Record that replaced or adjudicated this one, when any. */
  supersededBy: string | null;
}

export interface DerivedMemoryState {
  records: Map<string, DerivedMemoryRecord>;
  /** fact_key -> current head ref; null = head deliberately emptied (undecided conflict or retract_all). */
  heads: Map<string, string | null>;
  /** fact_key -> every record ref ever introduced for the slot (genesis gate). */
  factKeyRefs: Map<string, Set<string>>;
  /** fact_key -> undecided fork branches; head is null while non-empty. */
  conflicts: Map<string, Set<string>>;
  /** `${from_ref}\u0000${edge}\u0000${to_ref}` triples already committed. */
  edges: Set<string>;
}

function memoryPayloadOf(event: LedgerEvent): Record<string, unknown> {
  const payload = event.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new LedgerIntegrityError(`Event ${event.id} (${event.kind}) has a non-object payload`);
  }
  return payload;
}
function memoryPayloadString(event: LedgerEvent, payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || !value) throw new LedgerIntegrityError(`Event ${event.id} (${event.kind}) has an invalid ${key}`);
  return value;
}
function memoryPayloadArray(event: LedgerEvent, payload: Record<string, unknown>, key: string): string[] {
  const value = payload[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new LedgerIntegrityError(`Event ${event.id} (${event.kind}) has an invalid ${key}`);
  }
  return value as string[];
}
function addDerivedRecord(state: DerivedMemoryState, event: LedgerEvent, kind: DerivedMemoryRecord['kind'], factKey: string | null, origin: MemoryRecordOrigin, status: MemoryRecordStatus, supersedes: string | null): DerivedMemoryRecord {
  const record: DerivedMemoryRecord = { ref: event.id, kind, factKey, origin, status, supersedes, supersededBy: null };
  state.records.set(event.id, record);
  if (factKey !== null) {
    let refs = state.factKeyRefs.get(factKey);
    if (!refs) { refs = new Set(); state.factKeyRefs.set(factKey, refs); }
    refs.add(event.id);
  }
  return record;
}
/** Every branch of a fork supersedes the same predecessor; forks never arise from genesis records. */
function memoryBranchPredecessor(state: DerivedMemoryState, branches: Set<string>): string {
  for (const ref of branches) {
    const record = state.records.get(ref);
    if (record?.supersedes) return record.supersedes;
  }
  throw new LedgerIntegrityError('Conflict branches without a common predecessor');
}

/**
 * Replay the memory state machine (ADR-005 §6) over committed events. The
 * entries are the same HLC-ordered list the views consume, so the append-layer
 * preconditions always evaluate the same state the projection shows. Replay
 * order never picks a fork winner (§7): branches are collected into an
 * undecided conflict, and structural violations fail closed.
 */
export function deriveMemoryProjection(entries: readonly ViewReplayEntry[]): DerivedMemoryState {
  const state: DerivedMemoryState = { records: new Map(), heads: new Map(), factKeyRefs: new Map(), conflicts: new Map(), edges: new Set() };
  for (const { event } of entries) {
    if (event.kind === 'note.recorded') {
      addDerivedRecord(state, event, 'note.recorded', null, 'legacy_unreviewed', 'active', null);
    } else if (event.kind === 'memory.revised') {
      const payload = memoryPayloadOf(event);
      const factKey = memoryPayloadString(event, payload, 'fact_key');
      const supersedes = memoryPayloadArray(event, payload, 'supersedes');
      const intent = memoryPayloadString(event, payload, 'intent');
      const branches = state.conflicts.get(factKey);
      if (branches && branches.size > 0) {
        // §7: while a fork is undecided, only revisions naming the same common
        // predecessor join the branch set; everything else fails closed.
        const predecessor = memoryBranchPredecessor(state, branches);
        if (intent !== 'revise' || supersedes.length !== 1 || supersedes[0] !== predecessor) {
          throw new LedgerIntegrityError(`memory.revised ${event.id} writes into the undecided conflict of ${factKey}`);
        }
        addDerivedRecord(state, event, 'memory.revised', factKey, 'governed', 'conflicted', supersedes[0]!);
        branches.add(event.id);
        continue;
      }
      if (intent === 'revise') {
        if (supersedes.length === 0) {
          if ((state.factKeyRefs.get(factKey)?.size ?? 0) > 0) {
            throw new LedgerIntegrityError(`Genesis memory.revised ${event.id} landed on non-empty fact_key ${factKey}`);
          }
          addDerivedRecord(state, event, 'memory.revised', factKey, 'governed', 'active', null);
          state.heads.set(factKey, event.id);
          continue;
        }
        const target = supersedes[0]!;
        const prior = state.records.get(target);
        if (!prior) throw new LedgerIntegrityError(`memory.revised ${event.id} supersedes unknown record ${target}`);
        if ((state.factKeyRefs.get(factKey)?.size ?? 0) > 0) {
          const head = state.heads.get(factKey);
          if (head === undefined || head !== target) {
            // §7 fork rule: same predecessor as the current head projects as an
            // explicit conflict with both branches; no auto winner.
            const headRecord = head !== undefined && head !== null ? state.records.get(head) : undefined;
            if (headRecord && headRecord.supersedes === target) {
              headRecord.status = 'conflicted';
              state.conflicts.set(factKey, new Set([headRecord.ref, event.id]));
              state.heads.set(factKey, null);
              addDerivedRecord(state, event, 'memory.revised', factKey, 'governed', 'conflicted', target);
              continue;
            }
            throw new LedgerIntegrityError(`memory.revised ${event.id} supersedes ${target} which is not the head of ${factKey}`);
          }
          if (prior.status !== 'active' && prior.status !== 'retracted') {
            throw new LedgerIntegrityError(`memory.revised ${event.id} supersedes ${target} in status ${prior.status}`);
          }
          // A retracted head stays retracted (states only change via events);
          // an active head is superseded by the new record.
          if (prior.status === 'active') { prior.status = 'superseded'; prior.supersededBy = event.id; }
          addDerivedRecord(state, event, 'memory.revised', factKey, 'governed', 'active', target);
          state.heads.set(factKey, event.id);
          continue;
        }
        // ADR-005 §8: governing a legacy note is the only path where a
        // superseded target is not the head of the fact_key; note event bytes
        // are untouched, only the projection marks the note superseded. A note
        // is governed once: re-governing it into another fact slot would fork
        // its identity.
        if (prior.kind !== 'note.recorded') {
          throw new LedgerIntegrityError(`memory.revised ${event.id} supersedes ${target} which is not a legacy note record`);
        }
        if (prior.status !== 'active') {
          throw new LedgerIntegrityError(`Legacy note ${target} has already been governed`);
        }
        prior.status = 'superseded';
        prior.supersededBy = event.id;
        addDerivedRecord(state, event, 'memory.revised', factKey, 'governed', 'active', target);
        state.heads.set(factKey, event.id);
        continue;
      }
      // intent === 'retract': must name the current active head; the head
      // pointer stays on the retracted record so reads report "retracted".
      if (supersedes.length !== 1) throw new LedgerIntegrityError(`memory.revised ${event.id} retract must name exactly one head`);
      const target = supersedes[0]!;
      const prior = state.records.get(target);
      if (!prior || prior.factKey !== factKey || state.heads.get(factKey) !== target || prior.status !== 'active') {
        throw new LedgerIntegrityError(`memory.revised ${event.id} retract must name the active head of ${factKey}`);
      }
      prior.status = 'retracted';
      continue;
    }
    if (event.kind === 'memory.related') {
      const payload = memoryPayloadOf(event);
      const fromRef = memoryPayloadString(event, payload, 'from_ref');
      const toRef = memoryPayloadString(event, payload, 'to_ref');
      const edge = memoryPayloadString(event, payload, 'edge');
      if (!state.records.has(fromRef) || !state.records.has(toRef)) {
        throw new LedgerIntegrityError(`memory.related ${event.id} references a record outside this ledger`);
      }
      if (fromRef === toRef) throw new LedgerIntegrityError(`memory.related ${event.id} is a self-loop`);
      const key = `${fromRef}\u0000${edge}\u0000${toRef}`;
      if (state.edges.has(key)) throw new LedgerIntegrityError(`memory.related ${event.id} repeats the edge ${edge} ${fromRef}->${toRef}`);
      state.edges.add(key);
      continue;
    }
    if (event.kind === 'memory.conflict.resolved') {
      const payload = memoryPayloadOf(event);
      const factKey = memoryPayloadString(event, payload, 'fact_key');
      const branchRefs = memoryPayloadArray(event, payload, 'branches');
      const outcome = payload.outcome;
      if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) {
        throw new LedgerIntegrityError(`memory.conflict.resolved ${event.id} has no outcome`);
      }
      const undecided = state.conflicts.get(factKey);
      if (!undecided || undecided.size === 0) {
        throw new LedgerIntegrityError(`memory.conflict.resolved ${event.id} adjudicates ${factKey} without an undecided conflict`);
      }
      const declared = [...branchRefs].sort();
      const expected = [...undecided].sort();
      if (declared.length !== expected.length || declared.some((ref, index) => ref !== expected[index]!)) {
        throw new LedgerIntegrityError(`memory.conflict.resolved ${event.id} branches do not equal the undecided branches of ${factKey}`);
      }
      state.conflicts.delete(factKey);
      const outcomeRecord = outcome as Record<string, unknown>;
      if (outcomeRecord.type === 'winner') {
        const winnerRef = memoryPayloadString(event, outcomeRecord, 'winner_ref');
        if (!undecided.has(winnerRef)) {
          throw new LedgerIntegrityError(`memory.conflict.resolved ${event.id} names a winner outside the branches of ${factKey}`);
        }
        const winner = state.records.get(winnerRef)!;
        winner.status = 'active';
        for (const ref of undecided) {
          if (ref === winnerRef) continue;
          const record = state.records.get(ref)!;
          record.status = 'superseded';
          record.supersededBy = winnerRef;
        }
        state.heads.set(factKey, winnerRef);
        continue;
      }
      if (outcomeRecord.type === 'retract_all') {
        for (const ref of undecided) state.records.get(ref)!.status = 'retracted';
        state.heads.set(factKey, null);
        continue;
      }
      // outcome.type === 'record': the resolution event itself introduces the
      // new head record; record_ref is this event's id (ADR-005 §5).
      const introduced = addDerivedRecord(state, event, 'memory.conflict.resolved', factKey, 'governed', 'active', null);
      for (const ref of undecided) {
        const record = state.records.get(ref)!;
        record.status = 'superseded';
        record.supersededBy = introduced.ref;
      }
      state.heads.set(factKey, introduced.ref);
    }
  }
  return state;
}

/**
 * ADR-005 §7 append-layer preconditions, evaluated against a freshly derived
 * projection inside the locked append transaction. Any failure rejects with
 * zero writes; competing revisions depending on the same prior are rejected
 * deterministically. Scope is structural: refs resolve within this ledger
 * only, and every memory append must carry an idempotency key.
 */
export function assertMemoryAppendPreconditions(state: DerivedMemoryState, kind: MemoryEventKind, payload: Record<string, unknown>): void {
  if (kind === 'memory.related') {
    const fromRef = typeof payload.from_ref === 'string' ? payload.from_ref : '';
    const toRef = typeof payload.to_ref === 'string' ? payload.to_ref : '';
    const edge = typeof payload.edge === 'string' ? payload.edge : '';
    if (!fromRef || !toRef || !edge) throw new MemoryPreconditionError('memory.related requires edge, from_ref and to_ref');
    if (!state.records.has(fromRef) || !state.records.has(toRef)) {
      throw new MemoryPreconditionError('memory.related references a record that does not resolve in this ledger (cross-scope refs are structurally unresolvable)');
    }
    if (fromRef === toRef) throw new MemoryPreconditionError('memory.related rejects self-loops');
    if (state.edges.has(`${fromRef}\u0000${edge}\u0000${toRef}`)) {
      throw new MemoryPreconditionError(`The edge ${edge} between ${fromRef} and ${toRef} is already recorded; retries reuse the original idempotency key`);
    }
    return;
  }
  const factKey = typeof payload.fact_key === 'string' ? payload.fact_key : '';
  if (!factKey) throw new MemoryPreconditionError(`${kind} requires fact_key`);
  const undecided = state.conflicts.get(factKey);
  if (kind === 'memory.conflict.resolved') {
    if (!undecided || undecided.size === 0) {
      throw new MemoryPreconditionError(`${factKey} has no undecided conflict to adjudicate`);
    }
    const declared = Array.isArray(payload.branches) ? [...payload.branches as string[]].sort() : [];
    const expected = [...undecided].sort();
    if (declared.length !== expected.length || declared.some((ref, index) => ref !== expected[index]!)) {
      throw new MemoryPreconditionError(`branches must exactly equal the undecided branches of ${factKey}`);
    }
    return;
  }
  if (undecided && undecided.size > 0) {
    throw new MemoryPreconditionError(`${factKey} has an undecided conflict; only memory.conflict.resolved may write it`);
  }
  const supersedes = Array.isArray(payload.supersedes) ? payload.supersedes as string[] : [];
  if (kind === 'memory.revised' && typeof payload.intent === 'string' && payload.intent === 'retract') {
    const ref = supersedes.length === 1 ? supersedes[0]! : '';
    const prior = ref ? state.records.get(ref) : undefined;
    if (!prior) throw new MemoryPreconditionError(`retract references unknown record ${ref || '(missing)'}`);
    if (state.heads.get(factKey) !== ref) {
      throw new MemoryPreconditionError(`retract must name the current head of ${factKey}`);
    }
    if (prior.status !== 'active') {
      throw new MemoryPreconditionError(`retract requires an active head; ${ref} is ${prior.status}`);
    }
    return;
  }
  // intent === 'revise'
  if (supersedes.length === 0) {
    if ((state.factKeyRefs.get(factKey)?.size ?? 0) > 0) {
      throw new MemoryPreconditionError(`A genesis revision requires an unused fact_key; ${factKey} already has records`);
    }
    return;
  }
  const ref = supersedes.length === 1 ? supersedes[0]! : '';
  const prior = ref ? state.records.get(ref) : undefined;
  if (!prior) throw new MemoryPreconditionError(`supersedes references unknown record ${ref || '(missing)'}`);
  const head = state.heads.get(factKey);
  if (head === undefined) {
    // ADR-005 §8: governing a legacy note into an unused fact_key. The note
    // must still be unreviewed — an already governed note cannot be superseded
    // into a second fact slot (deterministic one-shot governance).
    if (prior.kind !== 'note.recorded') {
      throw new MemoryPreconditionError(`supersedes must name the current head of ${factKey} or a legacy note.recorded event`);
    }
    if (prior.status !== 'active') {
      throw new MemoryPreconditionError(`The legacy note ${ref} has already been governed`);
    }
    return;
  }
  if (head !== ref) {
    throw new MemoryPreconditionError(head === null
      ? `${factKey} has no current head; supersedes ${ref} does not match its state (re-read and retry)`
      : `supersedes ${ref} does not name the current head of ${factKey} (stale prior; re-read and retry)`);
  }
  // head === ref: an active head is a linear revision; a retracted head is a
  // forward correction (ADR-005 §4.1). Undecided conflicts were rejected above.
}

export class Ledger {
  readonly root: string;
  readonly actor: string;
  readonly sessionId: string;
  readonly ledgerDir: string;
  readonly cacheDir: string;
  readonly viewsPath: string;
  #clock: () => number;
  #hlc: Hlc;
  #segmentName: string;
  #segmentPath: string;
  #lockPath: string;
  #viewsLock: string;
  #lockOptions: LockOptions;
  #replay: ReplayResult = { segments: [], entries: [], ignoredTailSegments: [], observedIssues: [] };
  #ownEvents: LedgerEvent[] = [];
  #db: DatabaseSync | undefined;
  #closed = false;

  private constructor(root: string, options: LedgerOpenOptions) {
    this.root = resolve(root);
    this.#clock = options.clock ?? Date.now;
    this.sessionId = options.sessionId ?? ulid(this.#now(), randomBytes(10));
    if (!this.sessionId) throw new Error('sessionId must be non-empty');
    this.actor = options.actor ?? this.sessionId;
    if (!this.actor) throw new Error('actor must be non-empty');
    this.#hlc = new Hlc(this.actor);
    this.ledgerDir = join(this.root, '.ano', 'ledger');
    this.cacheDir = join(this.root, '.ano', 'cache');
    this.viewsPath = join(this.cacheDir, 'views.db');
    this.#segmentName = segmentFileName(this.#now(), this.sessionId);
    this.#segmentPath = join(this.ledgerDir, this.#segmentName);
    this.#lockPath = join(this.ledgerDir, `.${sanitizeSessionId(this.sessionId)}.lock`);
    this.#viewsLock = join(this.cacheDir, '.views.lock');
    this.#lockOptions = {
      ...(options.lockTimeoutMs === undefined ? {} : { timeoutMs: options.lockTimeoutMs }),
      ...(options.lockStaleAfterMs === undefined ? {} : { staleAfterMs: options.lockStaleAfterMs }),
    };
  }

  static async open(root: string, options: LedgerOpenOptions = {}): Promise<Ledger> {
    const ledger = new Ledger(root, options);
    for (let attempt = 0; ; attempt += 1) {
      let started = false;
      try {
        withFileLockSync(ledger.#viewsLock, () => { started = true; ledger.#initialize(); }, ledger.#lockOptions);
        return ledger;
      } catch (error) {
        if (started || attempt >= LOCK_RETRY_ATTEMPTS || !transientLockError(error)) throw error;
        await waitForLockRetry(attempt);
      }
    }
  }

  /** Acquire the session lock and the shared views lock in the canonical order. */
  async #withLocks<T>(operation: () => T): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      let started = false;
      try {
        return await withFileLock(
          this.#lockPath,
          async () => withFileLockSync(this.#viewsLock, () => { started = true; return operation(); }, this.#lockOptions),
          this.#lockOptions,
        );
      } catch (error) {
        if (started || attempt >= LOCK_RETRY_ATTEMPTS || !transientLockError(error)) throw error;
        await waitForLockRetry(attempt);
      }
    }
  }

  #initialize(): void {
    const existing = findSessionSegment(this.ledgerDir, this.sessionId);
    if (existing) {
      this.#segmentName = existing;
      this.#segmentPath = join(this.ledgerDir, existing);
    }
    this.#replay = replayLedger(this.ledgerDir, { ...(existing ? { ownSegment: existing, truncateOwn: true } : {}) });
    this.#ownEvents = [...(this.#replay.segments.find((segment) => segment.name === this.#segmentName)?.events ?? [])];
    for (const entry of this.#replay.entries) this.#hlc.receive(entry.event.hlc, this.#now());
    if (this.#replay.entries.length) this.#ensureViewsUnlocked();
  }

  async append(input: LedgerAppendInput, idemKey?: string): Promise<LedgerAppendResult> {
    this.#assertOpen();
    if (input.kind === 'segment.started') throw new Error('segment.started is automatic');
    if (idemKey !== undefined && (!idemKey || idemKey.length > 128)) throw new Error('Invalid idempotency key');
    const payload = normalizePayload(input.payload);
    // ADR-005 §2.6/§7: memory appends must carry an idempotency key, and their
    // strict payload contract is checked before any lock is taken; the same
    // schema is enforced again inside the append transaction by the views.
    if (isMemoryEventKind(input.kind)) {
      if (idemKey === undefined) throw new MemoryPreconditionError(`${input.kind} requires an idempotency key (ADR-005 §2.6)`);
      const issues = ledgerPayloadIssues(input.kind, payload);
      if (issues.length > 0) throw new MemoryPreconditionError(`${input.kind} payload is invalid: ${issues.join('; ')}`);
    }
    // Completion is the one transition that needs a Gate proof. A retry of an
    // already-committed event is resolved by the locked append below; the proof
    // itself is recomputed here because it is the only asynchronous step and
    // must not be awaited while the session/views locks are held.
    let gate: GateProof | undefined;
    // A null verdict is an explicit clear (reopenTask), not a completion claim.
    if (input.kind === 'task.updated' && (payload.status === 'done' || (payload.verdict !== undefined && payload.verdict !== null))) {
      const prior = idemKey !== undefined && this.#db ? findIdempotency(this.#db, idemKey) : undefined;
      if (!prior) gate = await this.#gateCompletionProof(payload);
    }
    const canonical = canonicalForEvent(input.kind, payload);
    return this.#withLocks(() => this.#appendUnlocked(input.kind, payload, canonical, idemKey, gate));
  }

  /**
   * Caller must hold both the session lock and the shared views lock. Keeping
   * the check-then-append sequence of createTask inside one acquisition is
   * what prevents a concurrent creator from turning a legitimate duplicate
   * into a LedgerIntegrityError.
   */
  #appendUnlocked(kind: LedgerEvent['kind'], payload: Record<string, unknown>, canonical: string, idemKey: string | undefined, gate?: GateProof): LedgerAppendResult {
    this.#resyncViewsUnlocked();
    const db = this.#ensureViewsUnlocked();
    const memory = isMemoryEventKind(kind);
    db.exec('BEGIN IMMEDIATE');
    let written = false;
    try {
      if (idemKey) {
        const prior = findIdempotency(db, idemKey);
        if (prior) {
          if (prior.canonical !== canonical) throw new IdempotencyConflictError(`Idempotency key ${JSON.stringify(idemKey)} has different parameters`);
          db.exec('ROLLBACK');
          return { event: prior.event, duplicate: true };
        }
      }
      if (gate) this.#assertGateEvidenceUnlocked(db, payload, gate);
      if (memory) {
        // ADR-005 §7: preconditions (target exists / same scope / expected
        // prior version / no undecided conflict / no self-loop or reused edge /
        // adjudication branch equality) run against the freshly resynced
        // replay inside BEGIN IMMEDIATE, so check-then-append has no race
        // window: the second of two competing revisions is rejected here.
        assertMemoryAppendPreconditions(deriveMemoryProjection(this.#replay.entries), kind, payload);
      }
      const now = this.#now();
      let previous = lastHash(this.#ownEvents);
      let header: LedgerEvent | undefined;
      if (!this.#ownEvents.length) {
        header = this.#event('segment.started', {
          session_id: this.sessionId,
          started_at: new Date(now).toISOString(),
          actor: this.actor,
          // The head hash of every segment this writer could see. Replay uses
          // it to fail closed if an observed segment is later deleted or its
          // first event is replaced. Segments created later are not listed (and
          // are not errors): only what this writer actually observed is
          // promised.
          observed: this.#observedHeads(),
        }, previous, undefined, now);
        previous = hashEvent(header);
        applyEventToDb(db, header, this.#segmentName);
      }
      const event = this.#event(kind, payload, previous, idemKey, now);
      applyEventToDb(db, event, this.#segmentName);
      // The incremental rows above are not represented by the replay digest
      // any more; invalidating it here (inside the transaction, so a rollback
      // restores it) makes the next syncViews rebuild from the log.
      invalidateViewDigest(db);
      if (memory) {
        // SQLite is a cache: keep its changes private until the log batch is
        // durable. A pre-commit failure must not leave visible rows behind.
        this.#appendMemoryBatch(header, event, now);
        written = true;
        db.exec('COMMIT');
      } else {
        db.exec('COMMIT');
        const batch = encodeBatch(ulid(now, randomBytes(10)), [event]);
        appendAtomically(this.#segmentPath, header ? Buffer.concat([encodeEvents([header]), batch]) : batch);
        written = true;
      }
      this.#ownEvents.push(...(header ? [header, event] : [event]));
      return { event, duplicate: false };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* retain original error */ }
      if (written) this.#resyncViewsUnlocked();
      throw error;
    }
  }

  #appendMemoryBatch(header: LedgerEvent | undefined, event: LedgerEvent, now: number): void {
    const batch = encodeBatch(ulid(now, randomBytes(10)), [event]);
    const committedBytes = this.#replay.segments.find((segment) => segment.name === this.#segmentName)?.committedBytes ?? 0;
    try {
      appendAtomically(this.#segmentPath, header ? Buffer.concat([encodeEvents([header]), batch]) : batch);
    } catch (error) {
      // A short write or failed fsync can leave bytes behind, including a
      // complete header or batch. Restore the old boundary while still locked.
      try {
        const current = statSync(this.#segmentPath, { throwIfNoEntry: false });
        if (current?.isFile() && current.size > committedBytes) truncateSegmentFile(this.#segmentPath, committedBytes);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'Memory append failed and the ledger segment could not be restored');
      }
      throw error;
    }
  }

  async createTask(id: string, declaredFiles: string[], title?: string, idemKey?: string): Promise<LedgerCreateTaskResult> {
    this.#assertOpen();
    if (!id || declaredFiles.some((file) => !file)) throw new Error('Task id and declared files must be non-empty');
    if (title !== undefined && (typeof title !== 'string' || title.trim().length === 0 || title.length > 500)) {
      throw new Error('Task title must be a non-empty string of at most 500 characters when provided');
    }
    const payload = normalizePayload({ task_id: id, declared_files: [...declaredFiles], ...(title === undefined ? {} : { title }) });
    const canonical = canonicalForEvent('task.created', payload);
    const key = idemKey ?? `ano:task.create:v1:${id}`;
    const result = await this.#withLocks((): LedgerCreateTaskResult | LedgerAppendResult => {
      this.#resyncViewsUnlocked();
      const db = this.#ensureViewsUnlocked();
      const existing = readTask(db, id);
      if (existing) {
        if (readTaskCreationCanonical(db, id) !== canonical) throw new IdempotencyConflictError(`Task ${id} exists with different creation parameters`);
        const prior = findIdempotency(db, key);
        if (prior) {
          if (prior.canonical !== canonical) throw new IdempotencyConflictError(`Idempotency key ${key} has different parameters`);
          return { duplicate: true, task: existing, event: prior.event };
        }
        // An earlier actor may have used another idempotency key. Preserve that
        // fact's key rather than making an unreplayable duplicate alias.
        const eventId = readTaskCreatedEventId(db, id);
        const event = eventId ? readEventById(db, eventId) : undefined;
        if (!event?.idem_key || !eventId) throw new IdempotencyConflictError(`Task ${id} already exists`);
        db.prepare('INSERT INTO idempotency (idem_key, canonical, event_id, event, segment, kind) VALUES (?, ?, ?, ?, ?, ?)')
          .run(key, canonical, event.id, JSON.stringify(event), eventId, event.kind);
        return { duplicate: true, task: existing, event };
      }
      return this.#appendUnlocked('task.created', payload, canonical, key);
    });
    const task = this.getTask(id);
    if (!task) throw new LedgerIntegrityError(`Task ${id} was not materialized`);
    return { ...result, task };
  }

  async updateTask(id: string, patch: LedgerUpdatePatch, idemKey?: string): Promise<LedgerTask> {
    if (patch.status !== undefined && !isTaskStatus(patch.status)) throw new Error('Invalid task status');
    if (patch.status === undefined && patch.verdict === undefined) throw new Error('updateTask requires status or verdict');
    await this.append({ kind: 'task.updated', payload: { task_id: id, ...(patch.status === undefined ? {} : { status: patch.status }), ...(patch.verdict === undefined ? {} : { verdict: patch.verdict }) } }, idemKey);
    const task = this.getTask(id);
    if (!task) throw new Error(`Unknown task: ${id}`);
    return task;
  }

  /**
   * Complete a task by reusing an already-recorded Gate evidence id.
   *
   * The Gate proof is recomputed from the recorded evidence and the current
   * source fingerprint, so a stale evidence id, a changed source tree or a
   * verdict belonging to another task is rejected. This is the only Surface
   * path that may append a `done` transition; a bare status update cannot.
   */
  async completeTaskWithEvidence(id: string, evidenceId: string, idemKey?: string): Promise<LedgerTask> {
    this.#assertOpen();
    if (!id) throw new Error('Task id must be non-empty');
    if (!evidenceId) throw new Error('Gate evidence id must be non-empty');
    const task = this.getTask(id);
    if (!task) throw new Error(`Unknown task: ${id}`);
    const record = this.#recordedEvidence(evidenceId);
    if (!record) throw new GateEvidenceError(`Gate evidence ${evidenceId} is not recorded`);
    if (record.taskId !== id) throw new GateEvidenceError(`Gate evidence ${evidenceId} belongs to ${record.taskId}, not ${id}`);
    const verification = record.evidence.verification;
    const verdict = verification && typeof verification === 'object' ? (verification as Record<string, unknown>).verdict : undefined;
    if (!verdict || typeof verdict !== 'object') {
      throw new GateEvidenceError(`Gate evidence ${evidenceId} has no stored Gate verdict`);
    }
    if (task.status === 'done') return task;
    return this.updateTask(id, { status: 'done', verdict }, idemKey);
  }

  /**
   * Reopen a completed task so Surface can edit source and verify again.
   * Completion is not silently invalidated by a source rewrite: the ledger
   * keeps the done event and its Gate evidence until an explicit reopen, which
   * clears the verdict and returns the task to in_progress.
   */
  async reopenTask(id: string, idemKey?: string): Promise<LedgerTask> {
    this.#assertOpen();
    if (!id) throw new Error('Task id must be non-empty');
    const task = this.getTask(id);
    if (!task) throw new Error(`Unknown task: ${id}`);
    if (task.status === 'in_progress') return task;
    if (task.status !== 'done') throw new Error(`Only a done task can be reopened: ${id} is ${task.status}`);
    await this.append({
      kind: 'task.updated',
      payload: { task_id: id, status: 'in_progress', reopened: true, reopened_from: 'done', verdict: null },
    }, idemKey);
    const reopened = this.getTask(id);
    if (!reopened) throw new Error(`Unknown task: ${id}`);
    return reopened;
  }

  /**
   * Verify the caller's completion claim against Gate-issued evidence.
   *
   * Accepted only when all of the following hold:
   * - the patch carries a verdict with `status: "done"` and an `evidenceId`;
   * - that evidence is recorded for the same task and has `ok: true`;
   * - the evidence carries Gate verification metadata (a `verification.verdict`
   *   that names the same evidence) — a bare `{ ok: true }` row is not enough;
   * - the current source tree, recomputed with the Gate's resolved project scan,
   *   still matches the fingerprint bound into the evidence.
   *
   * The last comparison ignores only untracked non-source artifacts (test
   * output that the Gate's own source-drift check also permits); every tracked
   * file and every source file must still match.
   */
  async #gateCompletionProof(payload: Record<string, unknown>): Promise<GateProof> {
    const taskId = typeof payload.task_id === 'string' ? payload.task_id : '';
    if (!taskId) throw new GateEvidenceError('task.updated completion requires a task_id');
    const verdict = payload.verdict;
    if (!verdict || typeof verdict !== 'object' || Array.isArray(verdict)) {
      throw new GateEvidenceError(`Task ${taskId} cannot be completed without a Gate verdict; updateTask(status: "done") is rejected`);
    }
    const claim = verdict as Record<string, unknown>;
    if (claim.status !== 'done') throw new GateEvidenceError(`Task ${taskId} completion requires verdict.status "done"`);
    if (typeof claim.evidenceId !== 'string' || !claim.evidenceId) throw new GateEvidenceError(`Task ${taskId} completion requires verdict.evidenceId`);
    if (claim.taskId !== undefined && claim.taskId !== taskId) throw new GateEvidenceError(`Task ${taskId} completion verdict belongs to ${String(claim.taskId)}`);
    const record = this.#recordedEvidence(claim.evidenceId);
    if (!record) throw new GateEvidenceError(`Gate evidence ${claim.evidenceId} is not recorded`);
    if (record.taskId !== taskId) throw new GateEvidenceError(`Gate evidence ${claim.evidenceId} belongs to ${record.taskId}, not ${taskId}`);
    const evidence = record.evidence;
    if (evidence.ok !== true) throw new GateEvidenceError(`Gate evidence ${claim.evidenceId} is not ok`);
    const claimed = evidence.sourceFingerprint;
    if (typeof claimed !== 'string' || !/^[a-f0-9]{64}$/u.test(claimed)) {
      throw new GateEvidenceError(`Gate evidence ${claim.evidenceId} does not bind a source fingerprint`);
    }
    this.#assertGateVerdict(taskId, claim.evidenceId, evidence, claim);
    const scan = await resolveProjectSourceScan(this.root);
    const current = await fingerprintProject(this.root, scan);
    if (current.degraded.length > 0 || current.status !== 'ok') {
      throw new GateEvidenceError(`Current source fingerprint is degraded: ${current.degraded.map((item) => item.path).join(', ')}`);
    }
    if (current.hash !== claimed) {
      const filtered = await this.#fingerprintWithoutUntrackedArtifacts(scan);
      if (!filtered || filtered.status !== 'ok' || filtered.degraded.length > 0 || filtered.hash !== claimed) {
        throw new GateEvidenceError(`Task ${taskId} source changed after Gate evidence ${claim.evidenceId}; reopen and verify again`);
      }
    }
    return { evidenceId: claim.evidenceId, fingerprint: claimed };
  }

  /**
   * Lock-free, log-derived lookup so a completion in one process sees evidence
   * appended by another process without trusting a possibly stale view cache.
   */
  #recordedEvidence(evidenceId: string): { taskId: string; evidence: Record<string, unknown> } | undefined {
    const replay = replayLedger(this.ledgerDir, { ownSegment: this.#segmentName });
    let found: { taskId: string; evidence: Record<string, unknown> } | undefined;
    for (const entry of replay.entries) {
      if (entry.event.kind !== 'evidence.recorded') continue;
      const candidate = entry.event.payload.evidence;
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
      if ((candidate as Record<string, unknown>).id !== evidenceId) continue;
      const taskId = entry.event.payload.task_id;
      if (typeof taskId === 'string') found = { taskId, evidence: candidate as Record<string, unknown> };
    }
    return found;
  }

  #assertGateVerdict(taskId: string, evidenceId: string, evidence: Record<string, unknown>, claim: Record<string, unknown>): void {
    const verification = evidence.verification;
    if (!verification || typeof verification !== 'object' || Array.isArray(verification)) {
      throw new GateEvidenceError(`Evidence ${evidenceId} has no Gate verification metadata`);
    }
    const stored = (verification as Record<string, unknown>).verdict;
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
      throw new GateEvidenceError(`Evidence ${evidenceId} has no stored Gate verdict`);
    }
    const verdict = stored as Record<string, unknown>;
    if (verdict.status !== 'done') throw new GateEvidenceError(`Stored Gate verdict for ${evidenceId} is not done`);
    if (verdict.evidenceId !== evidenceId) throw new GateEvidenceError(`Stored Gate verdict for ${evidenceId} names a different evidence id`);
    if (verdict.taskId !== undefined && verdict.taskId !== taskId) throw new GateEvidenceError(`Stored Gate verdict for ${evidenceId} belongs to another task`);
    if (typeof verdict.sourceFingerprint === 'string' && typeof claim.sourceFingerprint === 'string'
      && verdict.sourceFingerprint !== claim.sourceFingerprint) {
      throw new GateEvidenceError(`Stored Gate verdict for ${evidenceId} does not match the claimed source fingerprint`);
    }
  }

  /** The locked append re-reads the evidence row and proves it has not been swapped since the async fingerprint check. */
  #assertGateEvidenceUnlocked(db: DatabaseSync, payload: Record<string, unknown>, gate: GateProof): void {
    const taskId = typeof payload.task_id === 'string' ? payload.task_id : '';
    const record = readEvidence(db, gate.evidenceId);
    if (!record) throw new GateEvidenceError(`Gate evidence ${gate.evidenceId} disappeared before append`);
    if (record.taskId !== taskId) throw new GateEvidenceError(`Gate evidence ${gate.evidenceId} no longer belongs to ${taskId}`);
    if (record.evidence.ok !== true) throw new GateEvidenceError(`Gate evidence ${gate.evidenceId} is no longer ok`);
    if (record.evidence.sourceFingerprint !== gate.fingerprint) {
      throw new GateEvidenceError(`Gate evidence ${gate.evidenceId} fingerprint changed before append`);
    }
    const claim = payload.verdict;
    if (!claim || typeof claim !== 'object' || Array.isArray(claim)) throw new GateEvidenceError('Gate verdict disappeared before append');
    this.#assertGateVerdict(taskId, gate.evidenceId, record.evidence, claim as Record<string, unknown>);
  }

  async #fingerprintWithoutUntrackedArtifacts(scan: ResolvedProjectScan | undefined): Promise<SourceFingerprint | undefined> {
    const result = spawnSync('git', ['-C', scan?.gitRoot ?? this.root, 'ls-files', '--others', '--exclude-standard', '-z'], {
      encoding: 'buffer', maxBuffer: 16 * 1024 * 1024, windowsHide: true,
    });
    if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) return undefined;
    const untracked = result.stdout.toString('utf8').split('\0').filter(Boolean).map((path) => path.replaceAll('\\', '/'));
    const artifacts = new Set(untracked.filter((path) => !isGateSourcePath(path)));
    if (artifacts.size === 0) return undefined;
    return fingerprintProject(this.root, scan, (path) => artifacts.has(path));
  }

  #observedHeads(): Record<string, string> {
    const observed: Record<string, string> = {};
    for (const segment of this.#replay.segments) {
      if (segment.name === this.#segmentName) continue;
      const head = segment.events[0];
      if (head) observed[segment.name] = hashEvent(head);
    }
    return observed;
  }

  /**
   * Acquire the single lease for a run. If a previous lease exists but has
   * expired, this emits `run.lease.reclaimed` (with `reclaimed_from` and
   * `produced_evidence: false`) and returns the new lease. A live lease is never
   * stolen. Passing `leaseId` + `idemKey` makes a crash retry return the
   * already-committed lease instead of writing a second event.
   */
  async acquireRunLease(runId: string, options: AcquireLeaseOptions = {}): Promise<{ lease: RunLease; duplicate: boolean }> {
    this.#assertOpen();
    const run = assertRunId(runId);
    const ttlMs = normalizeTtlMs(options.ttlMs);
    const owner = options.owner ?? this.actor;
    if (!owner) throw new Error('Lease owner must be non-empty');
    return this.#withLocks(() => {
      this.#resyncViewsUnlocked();
      const db = this.#ensureViewsUnlocked();
      const retried = this.#priorLeaseEvent(db, options.idemKey, run, options.leaseId, new Set(['run.lease.acquired', 'run.lease.reclaimed']));
      if (retried) {
        const lease = readRunLease(db, run);
        if (!lease) throw new LedgerIntegrityError(`Retried lease event for ${run} is not materialized`);
        return { lease, duplicate: true };
      }
      const now = this.#now();
      const leaseId = assertLeaseId(options.leaseId ?? ulid(now, randomBytes(10)));
      const existing = readRunLease(db, run);
      let kind: 'run.lease.acquired' | 'run.lease.reclaimed';
      let payload: Record<string, unknown>;
      if (existing?.status === 'active') {
        if (existing.expiresAt > now) throw new LeaseHeldError(`Run ${run} is leased by ${existing.leaseId} until ${existing.expiresAt}`);
        kind = 'run.lease.reclaimed';
        payload = leaseReclaimPayload({ runId: run, leaseId, owner, ttlMs, now, reclaimedFrom: existing.leaseId, expiredAt: existing.expiresAt });
      } else {
        kind = 'run.lease.acquired';
        payload = leaseAcquiredPayload({ runId: run, leaseId, owner, ttlMs, now });
      }
      this.#appendUnlocked(kind, payload, canonicalForEvent(kind, payload), options.idemKey);
      const lease = readRunLease(db, run);
      if (!lease) throw new LedgerIntegrityError(`Run lease ${run} was not materialized`);
      return { lease, duplicate: false };
    });
  }

  /** Explicitly reclaim an expired lease without waiting for a new acquirer. */
  async reclaimRunLease(runId: string, options: AcquireLeaseOptions = {}): Promise<{ lease: RunLease; duplicate: boolean }> {
    this.#assertOpen();
    const run = assertRunId(runId);
    const ttlMs = normalizeTtlMs(options.ttlMs);
    const owner = options.owner ?? this.actor;
    if (!owner) throw new Error('Lease owner must be non-empty');
    return this.#withLocks(() => {
      this.#resyncViewsUnlocked();
      const db = this.#ensureViewsUnlocked();
      const retried = this.#priorLeaseEvent(db, options.idemKey, run, options.leaseId, new Set(['run.lease.reclaimed']));
      if (retried) {
        const lease = readRunLease(db, run);
        if (!lease) throw new LedgerIntegrityError(`Retried reclaim event for ${run} is not materialized`);
        return { lease, duplicate: true };
      }
      const now = this.#now();
      const existing = readRunLease(db, run);
      if (!existing) throw new LeaseUnknownError(`Run ${run} has no lease to reclaim`);
      if (existing.status !== 'active') throw new LeaseMismatchError(`Run ${run} lease is ${existing.status}, not active`);
      if (existing.expiresAt > now) throw new LeaseHeldError(`Run ${run} lease has not expired (expires at ${existing.expiresAt})`);
      const leaseId = assertLeaseId(options.leaseId ?? ulid(now, randomBytes(10)));
      const payload = leaseReclaimPayload({ runId: run, leaseId, owner, ttlMs, now, reclaimedFrom: existing.leaseId, expiredAt: existing.expiresAt });
      this.#appendUnlocked('run.lease.reclaimed', payload, canonicalForEvent('run.lease.reclaimed', payload), options.idemKey);
      const lease = readRunLease(db, run);
      if (!lease) throw new LedgerIntegrityError(`Reclaimed run lease ${run} was not materialized`);
      return { lease, duplicate: false };
    });
  }

  /** Extend a live lease. An expired lease must be reclaimed, not heartbeated. */
  async heartbeatRunLease(runId: string, leaseId: string, options: LeaseTimingOptions = {}): Promise<{ lease: RunLease; duplicate: boolean }> {
    this.#assertOpen();
    const run = assertRunId(runId);
    const id = assertLeaseId(leaseId);
    const ttlMs = normalizeTtlMs(options.ttlMs);
    return this.#withLocks(() => {
      this.#resyncViewsUnlocked();
      const db = this.#ensureViewsUnlocked();
      const retried = this.#priorLeaseEvent(db, options.idemKey, run, id, new Set(['run.lease.heartbeat']));
      if (retried) {
        const lease = readRunLease(db, run);
        if (!lease) throw new LedgerIntegrityError(`Retried heartbeat for ${run} is not materialized`);
        return { lease, duplicate: true };
      }
      const now = this.#now();
      const existing = readRunLease(db, run);
      if (!existing) throw new LeaseUnknownError(`Run ${run} has no lease`);
      if (existing.leaseId !== id) throw new LeaseMismatchError(`Run ${run} is leased by ${existing.leaseId}, not ${id}`);
      if (existing.status !== 'active') throw new LeaseMismatchError(`Run ${run} lease is ${existing.status}, not active`);
      if (existing.expiresAt <= now) throw new LeaseExpiredError(`Run ${run} lease expired at ${existing.expiresAt}; reclaim it instead`);
      const payload = leaseHeartbeatPayload({ runId: run, leaseId: id, ttlMs, now });
      this.#appendUnlocked('run.lease.heartbeat', payload, canonicalForEvent('run.lease.heartbeat', payload), options.idemKey);
      const lease = readRunLease(db, run);
      if (!lease) throw new LedgerIntegrityError(`Heartbeated run lease ${run} was not materialized`);
      return { lease, duplicate: false };
    });
  }

  async releaseRunLease(runId: string, leaseId: string, options: ReleaseLeaseOptions = {}): Promise<{ lease: RunLease; duplicate: boolean }> {
    this.#assertOpen();
    const run = assertRunId(runId);
    const id = assertLeaseId(leaseId);
    return this.#withLocks(() => {
      this.#resyncViewsUnlocked();
      const db = this.#ensureViewsUnlocked();
      const retried = this.#priorLeaseEvent(db, options.idemKey, run, id, new Set(['run.lease.released']));
      if (retried) {
        const lease = readRunLease(db, run);
        if (!lease) throw new LedgerIntegrityError(`Retried release for ${run} is not materialized`);
        return { lease, duplicate: true };
      }
      const existing = readRunLease(db, run);
      if (!existing) throw new LeaseUnknownError(`Run ${run} has no lease`);
      if (existing.leaseId !== id) throw new LeaseMismatchError(`Run ${run} is leased by ${existing.leaseId}, not ${id}`);
      if (existing.status === 'released') return { lease: existing, duplicate: true };
      if (existing.status !== 'active') throw new LeaseMismatchError(`Run ${run} lease is ${existing.status}, not active`);
      const now = this.#now();
      const payload = leaseReleasedPayload({ runId: run, leaseId: id, now });
      this.#appendUnlocked('run.lease.released', payload, canonicalForEvent('run.lease.released', payload), options.idemKey);
      const lease = readRunLease(db, run);
      if (!lease) throw new LedgerIntegrityError(`Released run lease ${run} was not materialized`);
      return { lease, duplicate: false };
    });
  }

  getRunLease(runId: string): RunLease | undefined { this.#assertOpen(); return this.#db ? readRunLease(this.#db, assertRunId(runId)) : undefined; }
  listRunLeases(): RunLease[] { this.#assertOpen(); return this.#db ? readRunLeases(this.#db) : []; }

  #priorLeaseEvent(db: DatabaseSync, key: string | undefined, runId: string, leaseId: string | undefined, kinds: ReadonlySet<LedgerEvent['kind']>): LedgerEvent | undefined {
    if (!key) return undefined;
    const prior = findIdempotency(db, key);
    if (!prior) return undefined;
    if (!kinds.has(prior.event.kind) || prior.event.payload.run_id !== runId || (leaseId !== undefined && prior.event.payload.lease_id !== leaseId)) {
      throw new IdempotencyConflictError(`Idempotency key ${JSON.stringify(key)} was used for a different lease operation`);
    }
    return prior.event;
  }

  getTask(id: string): LedgerTask | undefined { this.#assertOpen(); return this.#db ? readTask(this.#db, id) : undefined; }
  getTasks(): LedgerTask[] { this.#assertOpen(); return this.#db ? readTasks(this.#db) : []; }
  getEvidence(id: string): LedgerEvidence | undefined { this.#assertOpen(); return this.#db ? readEvidence(this.#db, id) : undefined; }
  listEvidence(taskId?: string): LedgerEvidence[] { this.#assertOpen(); return this.#db ? listEvidenceRows(this.#db, taskId) : []; }
  getNote(id: string): LedgerNote | undefined { this.#assertOpen(); return this.#db ? readNote(this.#db, id) : undefined; }
  listNotes(): LedgerNote[] { this.#assertOpen(); return this.#db ? readNotes(this.#db) : []; }
  getAuditFinding(id: string): LedgerAuditFinding | undefined { this.#assertOpen(); return this.#db ? readAuditFinding(this.#db, id) : undefined; }
  listAuditFindings(scope?: string): LedgerAuditFinding[] { this.#assertOpen(); return this.#db ? readAuditFindings(this.#db, scope) : []; }
  listAuditRuns(): LedgerAuditRun[] { this.#assertOpen(); return this.#db ? readAuditRuns(this.#db) : []; }
  getReadinessEvidence(ref: string): LedgerReadinessEvidence | undefined { this.#assertOpen(); return this.#db ? readReadinessEvidence(this.#db, ref) : undefined; }
  listReadinessEvidence(requirementId?: string): LedgerReadinessEvidence[] { this.#assertOpen(); return this.#db ? readReadinessEvidenceList(this.#db, requirementId) : []; }
  getReadinessAttestation(ref: string): LedgerReadinessAttestation | undefined { this.#assertOpen(); return this.#db ? readReadinessAttestation(this.#db, ref) : undefined; }
  listReadinessAttestations(): LedgerReadinessAttestation[] { this.#assertOpen(); return this.#db ? readReadinessAttestations(this.#db) : []; }
  getReleaseVerdict(hash: string): LedgerReleaseVerdict | undefined { this.#assertOpen(); return this.#db ? readReleaseVerdict(this.#db, hash) : undefined; }
  listReleaseVerdicts(): LedgerReleaseVerdict[] { this.#assertOpen(); return this.#db ? readReleaseVerdicts(this.#db) : []; }
  getReleaseApproval(ref: string): LedgerReleaseApproval | undefined { this.#assertOpen(); return this.#db ? readReleaseApproval(this.#db, ref) : undefined; }
  listReleaseApprovals(): LedgerReleaseApproval[] { this.#assertOpen(); return this.#db ? readReleaseApprovals(this.#db) : []; }
  get segmentName(): string { return this.#segmentName; }
  get segmentPath(): string { return this.#segmentPath; }

  getTouchedFiles(): string[] {
    const result = spawnSync('git', ['-C', this.root, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) throw new Error('Cannot derive touched files without a working git work tree');
    const entries = result.stdout.toString('utf8').split('\0').filter(Boolean);
    const files = new Set<string>();
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      const path = entry.slice(3).replaceAll('\\', '/');
      if (entry.startsWith('R') || entry.startsWith('C')) index += 1;
      if (['.ano/', '.pm/', '.git/', 'node_modules/', 'dist/', 'coverage/'].some((prefix) => path.startsWith(prefix))) continue;
      assertProjectPath(path);
      files.add(path);
    }
    return [...files].sort();
  }

  close(): void { this.#db?.close(); this.#db = undefined; this.#closed = true; }
  #assertOpen(): void { if (this.#closed) throw new Error('Ledger is closed'); }
  #now(): number { const value = this.#clock(); if (!Number.isFinite(value) || value < 0) throw new Error('Invalid clock'); return Math.floor(value); }
  #event(kind: LedgerEvent['kind'], payload: Record<string, unknown>, prev_hash: string, idem_key: string | undefined, now: number): LedgerEvent {
    const event: LedgerEvent = { id: ulid(now, randomBytes(10)), hlc: this.#hlc.tick(now), actor: this.actor, kind, payload, prev_hash, ...(idem_key ? { idem_key } : {}) };
    return ledgerEventSchema.parse(event);
  }
  #resyncViewsUnlocked(): void {
    this.#replay = replayLedger(this.ledgerDir, { ownSegment: this.#segmentName, truncateOwn: true });
    this.#ownEvents = [...(this.#replay.segments.find((segment) => segment.name === this.#segmentName)?.events ?? [])];
    for (const entry of this.#replay.entries) this.#hlc.receive(entry.event.hlc, this.#now());
    // Sync even for an empty replay: when the last segment disappeared the
    // cache must be rebuilt (and cleared), not left with ghost rows.
    syncViews(this.#ensureViewsUnlocked(), this.#replay.entries);
  }
  #ensureViewsUnlocked(): DatabaseSync {
    if (this.#db) return this.#db;
    mkdirSync(this.cacheDir, { recursive: true });
    const db = new DatabaseSync(this.viewsPath);
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      initViews(db);
      syncViews(db, this.#replay.entries);
      this.#db = db;
      return db;
    } catch (error) {
      db.close();
      this.#db = undefined;
      throw error;
    }
  }
}

function normalizePayload(payload: Record<string, unknown>): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Payload must be a JSON object');
  const result = JSON.parse(JSON.stringify(payload)) as unknown;
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Payload must serialize to an object');
  return result as Record<string, unknown>;
}
