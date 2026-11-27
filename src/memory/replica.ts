import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { viewDigest, type ViewReplayEntry } from '../ledger/views.ts';
import type { LedgerEvent } from '../ledger/event.ts';
import {
  ANCHOR_PROBE_CLUSTER_SCHEMA_VERSION,
  computeEvidenceDigestDetailed,
  PROBE_EVIDENCE_DIGEST_MAX_RECORDS,
  type AnchorProbeClusterMetadata,
  type AnchorProbeSnapshot,
} from './probe-contract.ts';
import {
  probeSnapshotIdentity,
  ProbeStoreCacheError,
  ProjectedProbeStore,
  type ProbeEvidencePayload,
  type ProbeProvenanceView,
  type ProbeSnapshotIdentity,
  type ProbeStatusView,
  type ProbeStore,
} from './probe-store.ts';
import type { ProbeCandidate, ProbeEdge, ProbeEntryQuery } from './probe.ts';
import {
  applyEventBatch,
  assertCursorMatchesState,
  assertReplicaCursor,
  committedEnvelopeFromEvent,
  committedEnvelopeIssue,
  cursorFromState,
  emptyReplicaApplyState,
  ReplicationError,
  resumeFrom,
  type CommittedEventEnvelope,
  type ReplicaApplyOptions,
  type ReplicaApplyState,
  type ReplicaCursor,
  type ReplicationReport,
  type ReplicationResume,
} from './replication.ts';

/**
 * T-125 / ADR-011 §3.3/§4.4: a read-only local replica.
 *
 * The replica keeps its own derived material under `<root>/.ano/replicas/<id>/`
 * (events + cursor) and rebuilds Memory/Probe views by replaying the committed
 * events through `src/ledger/views.ts` — the exact projection the primary uses;
 * no second projection semantics exist here. It never opens or writes
 * `<root>/.ano/ledger`, and every write-shaped API is absent or refuses with
 * `REPLICA_WRITE_FORBIDDEN`.
 */

export const REPLICA_EVENTS_FILE = 'events.jsonl';
export const REPLICA_CURSOR_FILE = 'cursor.json';
const REPLICA_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export interface ReplicaStoreOptions {
  /** Project root; the replica directory is `<root>/.ano/replicas/<replicaId>`/ */
  readonly root: string;
  readonly replicaId: string;
  /** Declared project scope; foreign batches are refused with SCOPE_DENIED. */
  readonly projectScope: string;
  readonly clusterEpoch?: string | number;
  /**
   * Optional base snapshot (graph/source/connected digests) sampled from the
   * primary. `ledger_digest` is always recomputed locally from the applied
   * events, never copied from the primary.
   */
  readonly snapshot?: AnchorProbeSnapshot;
  readonly bufferMaxEvents?: number;
  readonly bufferMaxBytes?: number;
}

export interface ReplicaApplyInput {
  /** When supplied, must equal the replica's declared scope. */
  readonly projectScope?: string;
}

interface PersistedCommittedEvent {
  readonly seq: number;
  readonly segment: string;
  readonly event: unknown;
}

export class ReplicaStore implements ProbeStore {
  readonly root: string;
  readonly replicaId: string;
  readonly projectScope: string;
  readonly clusterEpoch: string | number | undefined;
  readonly directory: string;
  readonly eventsPath: string;
  readonly cursorPath: string;

  readonly #applyOptions: ReplicaApplyOptions;
  readonly #baseSnapshot: AnchorProbeSnapshot | null;
  #state: ReplicaApplyState;
  #probe: ProjectedProbeStore | null = null;
  #closed = false;

  private constructor(options: ReplicaStoreOptions, directory: string) {
    this.root = resolve(options.root);
    this.replicaId = options.replicaId;
    this.projectScope = options.projectScope;
    this.clusterEpoch = options.clusterEpoch;
    this.directory = directory;
    this.eventsPath = join(directory, REPLICA_EVENTS_FILE);
    this.cursorPath = join(directory, REPLICA_CURSOR_FILE);
    this.#baseSnapshot = options.snapshot ?? null;
    this.#applyOptions = {
      ...(options.bufferMaxEvents === undefined ? {} : { bufferMaxEvents: options.bufferMaxEvents }),
      ...(options.bufferMaxBytes === undefined ? {} : { bufferMaxBytes: options.bufferMaxBytes }),
    };
    this.#state = emptyReplicaApplyState();
  }

  static directoryFor(root: string, replicaId: string): string {
    return join(resolve(root), '.ano', 'replicas', assertReplicaId(replicaId));
  }

  /** Open (or create) a replica directory and restore its cursor-consistent state. */
  static open(options: ReplicaStoreOptions): ReplicaStore {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new ReplicationError('REPLICA_CURSOR_INVALID', 'replica store options must be an object');
    }
    if (typeof options.root !== 'string' || options.root.length === 0) {
      throw new ReplicationError('REPLICA_CURSOR_INVALID', 'replica store root must be a non-empty path');
    }
    if (typeof options.projectScope !== 'string' || options.projectScope.length === 0) {
      throw new ReplicationError('REPLICA_CURSOR_INVALID', 'replica store projectScope must be a non-empty string');
    }
    const replicaId = assertReplicaId(options.replicaId);
    if (options.clusterEpoch !== undefined && (typeof options.clusterEpoch !== 'string' && typeof options.clusterEpoch !== 'number')) {
      throw new ReplicationError('REPLICA_CURSOR_INVALID', 'clusterEpoch must be a string or number');
    }
    const directory = ReplicaStore.directoryFor(options.root, replicaId);
    const store = new ReplicaStore({ ...options, replicaId }, directory);
    store.#load();
    return store;
  }

  // -------------------------------------------------------------------------
  // Read-side identity
  // -------------------------------------------------------------------------

  get commitIndex(): number {
    this.#assertOpen();
    return this.#state.commitIndex;
  }

  get viewDigest(): string {
    this.#assertOpen();
    return viewDigest(this.#state.entries);
  }

  get entries(): readonly ViewReplayEntry[] {
    this.#assertOpen();
    return this.#state.entries;
  }

  get cursor(): ReplicaCursor {
    this.#assertOpen();
    return cursorFromState(this.#state, {
      ...(this.clusterEpoch === undefined ? {} : { clusterEpoch: this.clusterEpoch }),
      replicaId: this.replicaId,
    });
  }

  /** Pull plan for resuming after this cursor: strictly after `commitIndex`. */
  resumePullRequest(): ReplicationResume {
    return resumeFrom(this.cursor);
  }

  maxLag(primaryCommitIndex: number): number {
    return Math.max(0, primaryCommitIndex - this.commitIndex);
  }

  // -------------------------------------------------------------------------
  // ProbeStore (ADR-011 §6.2): one replica is a read-only ProbeStore
  // -------------------------------------------------------------------------

  get snapshot(): AnchorProbeSnapshot {
    this.#assertOpen();
    return {
      ...this.#fourDigestSnapshot(),
      cluster: this.clusterMetadata(),
    };
  }

  candidates(query?: ProbeEntryQuery): readonly ProbeCandidate[] {
    return this.#projected().candidates(query);
  }

  adjacency(ref?: string): readonly ProbeEdge[] {
    return this.#projected().adjacency(ref);
  }

  evidence(recordRef: string): ProbeEvidencePayload | undefined {
    return this.#projected().evidence(recordRef);
  }

  status(recordRef: string): ProbeStatusView | undefined {
    return this.#projected().status(recordRef);
  }

  provenance(recordRef: string): ProbeProvenanceView | undefined {
    return this.#projected().provenance(recordRef);
  }

  snapshotIdentity(): ProbeSnapshotIdentity {
    return probeSnapshotIdentity(this.snapshot);
  }

  replicaCommitIndex(): number | undefined {
    return this.commitIndex;
  }

  /**
   * Cluster metadata for this replica. `consistency='local'` and the replica's
   * own commit point; the evidence digest is recomputed from the local
   * projection and is bounded like any other T-124 digest.
   */
  clusterMetadata(): AnchorProbeClusterMetadata {
    const gaps = this.#state.pending.size > 0 ? [...this.#state.pending.keys()].filter((seq) => seq > this.#state.commitIndex + 1) : [];
    const partial = gaps.length > 0 || this.#state.pending.size > 0;
    return {
      schema_version: ANCHOR_PROBE_CLUSTER_SCHEMA_VERSION,
      project_scope: this.projectScope,
      cluster_epoch: this.clusterEpoch ?? '',
      commit_index: this.#state.commitIndex,
      replica_id: this.replicaId,
      replica_commit_index: this.#state.commitIndex,
      consistency: 'local',
      max_lag: null,
      partial,
      failed_nodes: [],
      evidence_digest: this.#evidenceDigest(),
    };
  }

  // -------------------------------------------------------------------------
  // Replication
  // -------------------------------------------------------------------------

  /**
   * Rebuild the whole replica from an ordered committed batch, starting from an
   * empty state. Fails closed unless the batch is contiguous from seq 1: a
   * partial export must go through {@link applyCommitted} instead.
   */
  rebuildFromEvents(events: readonly CommittedEventEnvelope[]): ReplicationReport {
    this.#assertOpen();
    const result = applyEventBatch(emptyReplicaApplyState(), events, this.#applyOptions);
    const report = result.report;
    if (!report.complete || report.pendingCount > 0 || report.gaps.length > 0) {
      throw new ReplicationError(
        'REPLICA_INCOMPLETE_REBUILD',
        `cannot rebuild from a non-contiguous batch: ${report.gaps.length} gap(s), ${report.pendingCount} buffered event(s); pull the full committed history instead`,
        { report },
      );
    }
    if (events.length > 0 && report.commitIndex !== events.length) {
      throw new ReplicationError('REPLICA_INCOMPLETE_REBUILD', 'rebuild batch does not start at seq 1 or is not contiguous', { report });
    }
    this.#state = result.state;
    this.#invalidate();
    this.#persist();
    return report;
  }

  /**
   * Apply one incremental batch. Idempotent by event id/hash; out-of-order
   * events are buffered with an explicit gap report; corrupt or conflicting
   * batches throw before the persisted state changes.
   */
  applyCommitted(batch: readonly CommittedEventEnvelope[], input: ReplicaApplyInput = {}): ReplicationReport {
    this.#assertOpen();
    if (input.projectScope !== undefined && input.projectScope !== this.projectScope) {
      throw new ReplicationError(
        'SCOPE_DENIED',
        `batch scope ${JSON.stringify(input.projectScope)} does not match replica scope ${JSON.stringify(this.projectScope)}`,
      );
    }
    const result = applyEventBatch(this.#state, batch, this.#applyOptions);
    this.#state = result.state;
    this.#invalidate();
    this.#persist();
    return result.report;
  }

  // -------------------------------------------------------------------------
  // Explicit write refusal (ADR-011 §3.3 / §11)
  // -------------------------------------------------------------------------

  append(_input?: unknown, _idemKey?: string): never {
    this.#rejectWrite('append');
  }

  writeNote(..._args: readonly unknown[]): never {
    this.#rejectWrite('writeNote');
  }

  recordTrack(..._args: readonly unknown[]): never {
    this.#rejectWrite('recordTrack');
  }

  close(): void {
    if (this.#closed) return;
    this.#probe?.close();
    this.#probe = null;
    this.#closed = true;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #fourDigestSnapshot(): AnchorProbeSnapshot {
    const base = this.#baseSnapshot;
    return {
      project_scope: this.projectScope,
      ledger_digest: viewDigest(this.#state.entries),
      graph_revision: base?.graph_revision ?? null,
      source_fingerprint: base?.source_fingerprint ?? null,
      connected_digest: base?.connected_digest ?? null,
    };
  }

  #evidenceDigest(): string {
    const fingerprints = this.#projected().candidates().map((candidate) => ({
      record_ref: candidate.record_ref,
      content_hash: candidate.content_hash,
      ...(candidate.fact_key === null ? {} : { fact_key: candidate.fact_key }),
      status: candidate.status,
    }));
    return computeEvidenceDigestDetailed(fingerprints, {
      limit: PROBE_EVIDENCE_DIGEST_MAX_RECORDS,
      allowTruncation: true,
    }).digest;
  }

  #projected(): ProjectedProbeStore {
    this.#assertOpen();
    if (this.#probe === null) this.#probe = ProjectedProbeStore.create(this.#state.entries, this.#fourDigestSnapshot());
    return this.#probe;
  }

  #invalidate(): void {
    this.#probe?.close();
    this.#probe = null;
  }

  #rejectWrite(operation: string): never {
    throw new ReplicationError(
      'REPLICA_WRITE_FORBIDDEN',
      `read-only replica ${this.replicaId} refuses authoritative write operation ${operation}; replicas never write the primary ledger, notes or tracks`,
    );
  }

  #assertOpen(): void {
    if (this.#closed) throw new ProbeStoreCacheError('ReplicaStore is closed');
  }

  #assertInsideReplica(file: string): void {
    const resolved = resolve(file);
    if (resolved !== this.directory && !resolved.startsWith(`${this.directory}${sep}`)) {
      throw new ReplicationError('REPLICA_CURSOR_INVALID', `refusing to operate outside the replica directory: ${resolved}`);
    }
  }

  #atomicWrite(file: string, text: string): void {
    this.#assertInsideReplica(file);
    mkdirSync(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, text, 'utf8');
    renameSync(temporary, file);
  }

  #writeIfChanged(file: string, text: string): void {
    if (existsSync(file) && readFileSync(file, 'utf8') === text) return;
    this.#atomicWrite(file, text);
  }

  /** Persist only what changed, so duplicate batches leave byte-identical files. */
  #persist(): void {
    this.#assertOpen();
    const bySeq = new Map<number, { seq: number; segment: string; event: unknown }>();
    for (let index = 0; index < this.#state.entries.length; index += 1) {
      const entry = this.#state.entries[index]!;
      bySeq.set(index + 1, { seq: index + 1, segment: entry.segment, event: entry.event });
    }
    for (const [seq, envelope] of this.#state.pending) {
      bySeq.set(seq, { seq, segment: envelope.segment, event: envelope.event });
    }
    const lines = [...bySeq.values()]
      .sort((left, right) => left.seq - right.seq)
      .map((entry) => JSON.stringify(entry));
    this.#writeIfChanged(this.eventsPath, lines.length === 0 ? '' : `${lines.join('\n')}\n`);

    const cursorText = `${JSON.stringify(this.cursor, null, 2)}\n`;
    this.#writeIfChanged(this.cursorPath, cursorText);
  }

  #load(): void {
    mkdirSync(this.directory, { recursive: true });
    const hasEvents = existsSync(this.eventsPath);
    const hasCursor = existsSync(this.cursorPath);
    if (!hasEvents && !hasCursor) return;
    if (!hasEvents || !hasCursor) {
      throw new ReplicationError('REPLICA_CURSOR_INVALID', `replica directory ${this.directory} has an incomplete persisted state (events=${String(hasEvents)}, cursor=${String(hasCursor)})`);
    }
    let rawCursor: unknown;
    try {
      rawCursor = JSON.parse(readFileSync(this.cursorPath, 'utf8'));
    } catch (error) {
      throw new ReplicationError('REPLICA_CURSOR_INVALID', 'replica cursor is not valid JSON', { cause: error });
    }
    assertReplicaCursor(rawCursor);
    if (rawCursor.replicaId !== undefined && rawCursor.replicaId !== this.replicaId) {
      throw new ReplicationError('REPLICA_CURSOR_INVALID', `replica cursor belongs to ${rawCursor.replicaId}, not ${this.replicaId}`);
    }
    const envelopes = this.#readEvents();
    if (envelopes.length === 0) {
      if (rawCursor.commitIndex > 0) {
        throw new ReplicationError('REPLICA_CURSOR_INVALID', 'replica cursor claims progress but the event log is empty');
      }
      this.#state = emptyReplicaApplyState();
      return;
    }
    const result = applyEventBatch(emptyReplicaApplyState(), envelopes, this.#applyOptions);
    assertCursorMatchesState(rawCursor, result.state);
    this.#state = result.state;
  }

  #readEvents(): CommittedEventEnvelope[] {
    const text = readFileSync(this.eventsPath, 'utf8');
    const envelopes: CommittedEventEnvelope[] = [];
    const issues: string[] = [];
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line === undefined || line.trim().length === 0) continue;
      let parsed: PersistedCommittedEvent;
      try {
        parsed = JSON.parse(line) as PersistedCommittedEvent;
      } catch {
        issues.push(`line ${index + 1}: invalid JSON`);
        continue;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        issues.push(`line ${index + 1}: entry must be an object`);
        continue;
      }
      if (!Number.isSafeInteger(parsed.seq) || (parsed.seq as number) < 1 || typeof parsed.segment !== 'string' || parsed.segment.length === 0) {
        issues.push(`line ${index + 1}: invalid seq/segment`);
        continue;
      }
      const envelope = committedEnvelopeFromEvent(parsed.event as LedgerEvent, parsed.seq as number, parsed.segment);
      const issue = committedEnvelopeIssue(envelope);
      if (issue !== null) {
        issues.push(`line ${index + 1}: ${issue}`);
        continue;
      }
      envelopes.push(envelope);
    }
    if (issues.length > 0) {
      throw new ReplicationError('REPLICA_CORRUPT_EVENT', `persisted replica event log is corrupt: ${issues.join('; ')}`);
    }
    return envelopes;
  }
}

function assertReplicaId(replicaId: string): string {
  if (typeof replicaId !== 'string' || !REPLICA_ID_PATTERN.test(replicaId) || replicaId.includes('..')) {
    throw new ReplicationError('REPLICA_CURSOR_INVALID', `replicaId ${JSON.stringify(replicaId)} is not a bounded filesystem-safe identifier`);
  }
  return replicaId;
}
