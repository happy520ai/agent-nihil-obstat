import { createHash } from 'node:crypto';
import { canonicalJson, ledgerEventSchema, type LedgerEvent } from '../ledger/event.ts';
import {
  HaProtocolError,
  MWHA_CLUSTER_LOG_ENTRY_SCHEMA_VERSION,
  MWHA_PROJECTION_STATE_SCHEMA_VERSION,
  MWHA_UNCOMMITTED_COMMIT_INDEX,
  assertAdjudicationComplete,
  assertFence,
  assertGateBoundary,
  classifyDelivery,
  classifySequence,
  conflictKeyOf,
  contentKey,
  detectForks,
  determineVersionOutcome,
  evaluateFence,
  idempotencyKey,
  logicalVersionOfEntry,
  makeBranchId,
  mwhaAdjudicationSchema,
  mwhaClusterLogEntrySchema,
  mwhaProjectionStateSchema,
  mwhaWriterEventSchema,
  sortEntriesByLogicalVersion,
  type MwhaAdjudication,
  type MwhaBranch,
  type MwhaClusterLogEntry,
  type MwhaConflictKey,
  type MwhaDeliveryClassification,
  type MwhaDeliveryKind,
  type MwhaEntryStatus,
  type MwhaEventIdentity,
  type MwhaForkConflict,
  type MwhaLeaderLease,
  type MwhaProjectionState,
  type MwhaProjectionStatus,
  type MwhaSequenceKind,
  type MwhaVersionOutcome,
  type MwhaWriterEvent,
} from './ha-protocol.ts';

/**
 * T-135 / ADR-012 §4-§9: multi-writer event log over already committed ledger
 * events.
 *
 * The log is an additional optional protocol layer. It never opens a socket,
 * never touches `src/ledger/**`, never calls `hashEvent` and never mutates the
 * `LedgerEvent` object a caller supplies: `ledger_event_hash` is a reference to
 * the caller's own `hashEvent(LedgerEvent)` result. Historical ledger bytes and
 * hashes therefore stay byte-for-byte identical.
 *
 * Invariants implemented here:
 * - identity binding `(writer_id, epoch, term, local_seq, ledger_event_hash)`;
 * - duplicate / reorder / gap classification via `classifyDelivery` and
 *   `classifySequence`; duplicates have zero side effects;
 * - per-writer `local_seq` continuity tracking (gaps are reported, never
 *   silently skipped);
 * - every competing branch of a `(writer_id, epoch, local_seq)` slot is kept
 *   (`detectForks`); nothing is overwritten by arrival order or wall clock;
 * - deterministic replay: projection ordering uses only
 *   `sortEntriesByLogicalVersion`, so any arrival permutation of one input set
 *   yields the same projection hash;
 * - explicit adjudication: `adjudicate` requires the complete branch-hash set
 *   (`assertAdjudicationComplete`), records all referenced branches, and only
 *   then converges the projection on the selected branch;
 * - Gate boundary: every projected state passes `assertGateBoundary`;
 *   conflicted/uncommitted states always carry `evidence_id = null`.
 *
 * Wall-clock time is never read. `commit_index` is supplied by the caller (it
 * belongs to the T-137 commit protocol); this module never invents one from
 * arrival order, which is what keeps replay independent of arrival order.
 */

// ---------------------------------------------------------------------------
// Public value types
// ---------------------------------------------------------------------------

export interface MultiWriterLogOptions {
  /** Fencing baseline. Later writes are checked against it with {@link assertFence}. */
  readonly lease?: MwhaLeaderLease;
  /** When present, an epoch outside this set fails closed with `FENCE_UNKNOWN_EPOCH`. */
  readonly knownEpochs?: Iterable<number>;
}

export interface MultiWriterAppendInput {
  /** Propose-side envelope; parsed with the strict `mwhaWriterEventSchema`. */
  readonly event: MwhaWriterEvent;
  /** The already committed ledger event referenced by `identity.ledger_event_hash`. Stored verbatim. */
  readonly ledgerEvent: LedgerEvent;
  /**
   * The caller-computed `hashEvent(ledgerEvent)`. This module never recomputes
   * it; a mismatch with `identity.ledger_event_hash` is rejected as tampering.
   */
  readonly ledgerEventHash: string;
  /** Global commit index. `> 0` makes the entry committed; omitted means proposed (`0`). */
  readonly commitIndex?: number;
  /** Explicit status; defaults to `committed` when `commitIndex > 0`, else `proposed`. */
  readonly status?: MwhaEntryStatus;
  /** Gate evidence reference for a committed fact; derived deterministically when omitted. */
  readonly evidenceId?: string | null;
}

export interface MultiWriterAppendResult {
  readonly kind: MwhaDeliveryKind;
  readonly sequence: MwhaSequenceKind;
  /** The retained record; on a duplicate this is the previously stored record. */
  readonly entry: MultiWriterEntryRecord;
  readonly commitIndex: number;
  readonly evidenceId: string | null;
}

export interface MultiWriterIngestItem {
  /** Cluster-log record replicated from another node (already carries its commit index). */
  readonly entry: MwhaClusterLogEntry;
  readonly ledgerEvent: LedgerEvent;
  readonly ledgerEventHash: string;
  readonly evidenceId?: string | null;
}

export interface MultiWriterIngestReport {
  readonly applied: number;
  readonly duplicates: number;
  readonly conflicts: number;
  readonly entries: readonly MultiWriterEntryRecord[];
}

export interface MultiWriterAdjudicateOptions {
  /** Evidence reference carried by the converged committed state. */
  readonly evidenceId?: string | null;
}

/** One retained log record. `ledgerEvent` is the caller's immutable object. */
export interface MultiWriterEntryRecord {
  readonly entry: MwhaClusterLogEntry;
  readonly ledgerEvent: LedgerEvent;
  readonly ledgerEventHash: string;
  readonly evidenceId: string | null;
  readonly delivery: MwhaDeliveryKind;
}

/** One stored adjudication plus the actual branch set it resolved. */
export interface MultiWriterAdjudicationRecord {
  readonly adjudication: MwhaAdjudication;
  readonly conflict_key: MwhaConflictKey;
  /** Every retained branch referenced by the adjudication, sorted by hash. */
  readonly branches: readonly MwhaBranch[];
  readonly evidenceId: string | null;
}

/** Flattened adjudication material stored inside the projection digest. */
export interface MultiWriterAdjudicationRef {
  readonly conflict_key: MwhaConflictKey;
  readonly status: 'resolved' | 'unresolved';
  readonly selected_branch_id: string | null;
  readonly resolution_reason: string | null;
  readonly branch_hashes: readonly string[];
  readonly branches: readonly MwhaBranch[];
  readonly evidence_id: string | null;
}

export interface MultiWriterEntryRef {
  readonly identity: MwhaEventIdentity;
  readonly status: MwhaEntryStatus;
  readonly leader: MwhaLeaderLease | null;
  readonly commit_index: number;
  readonly conflict_key: MwhaConflictKey | null;
  readonly evidence_id: string | null;
}

/**
 * Projected state of one conflict slot. `MwhaProjectionState` is the Gate-bound
 * core; `branches`/`referenced_branch_hashes`/`adjudication` record the full
 * branch material that the projection must never truncate.
 */
export interface MultiWriterSlotState extends MwhaProjectionState {
  readonly branches: readonly MwhaBranch[];
  readonly referenced_branch_hashes: readonly string[];
  readonly adjudication: MultiWriterAdjudicationRecord | null;
  /** Diagnostic result of `determineVersionOutcome`; never used to drop a branch. */
  readonly version_outcome: MwhaVersionOutcome;
}

export interface MultiWriterProjection {
  readonly schema_version: typeof MWHA_PROJECTION_STATE_SCHEMA_VERSION;
  /** One state per observed slot, sorted by conflict key. */
  readonly states: readonly MultiWriterSlotState[];
  /** Committed/adjudicated entries in logical-version order. Uncommitted entries never appear here. */
  readonly entries: readonly MultiWriterEntryRef[];
  readonly adjudications: readonly MultiWriterAdjudicationRef[];
  readonly forks: readonly MwhaForkConflict[];
  /** SHA-256 over the canonical projection material; identical for any arrival order of one input set. */
  readonly hash: string;
}

export interface MultiWriterSequenceReport {
  readonly writer_id: string;
  readonly epoch: number;
  readonly seen_count: number;
  readonly last_local_seq: number | null;
  readonly next_expected_local_seq: number | null;
  /** Missing `local_seq` values in `[1, last_local_seq]`, ascending. */
  readonly missing_local_seqs: readonly number[];
  readonly duplicate_delivery_count: number;
  readonly last_transition: MwhaSequenceKind | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface SequenceTracker {
  writer_id: string;
  epoch: number;
  seen: Set<number>;
  last_local_seq: number | null;
  last_transition: MwhaSequenceKind | null;
  duplicates: number;
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function issueText(error: { issues: ReadonlyArray<{ message: string }> }): string {
  return error.issues.map((issue) => issue.message).join('; ');
}

function parseWriterEvent(value: unknown): MwhaWriterEvent {
  const result = mwhaWriterEventSchema.safeParse(value);
  if (!result.success) throw new HaProtocolError('HA_INPUT_INVALID', `writer event is invalid: ${issueText(result.error)}`);
  return result.data;
}

function parseClusterLogEntry(value: unknown): MwhaClusterLogEntry {
  const result = mwhaClusterLogEntrySchema.safeParse(value);
  if (!result.success) throw new HaProtocolError('HA_INPUT_INVALID', `cluster log entry is invalid: ${issueText(result.error)}`);
  return result.data;
}

function parseAdjudication(value: MwhaAdjudication): MwhaAdjudication {
  const result = mwhaAdjudicationSchema.safeParse(value);
  if (!result.success) throw new HaProtocolError('ADJUDICATION_INVALID', `adjudication is invalid: ${issueText(result.error)}`);
  return result.data;
}

/**
 * Deterministic slot key for grouping/projection. Identical to
 * `idempotencyKey(identity)` so delivery classification, branch retention and
 * adjudication lookup all address the same slot.
 */
function slotKeyOfConflictKey(key: MwhaConflictKey): string {
  return `${key.writer_id}\u0000${key.epoch}\u0000${key.local_seq}`;
 }

function slotKeyOfIdentity(identity: MwhaEventIdentity): string {
  return slotKeyOfConflictKey(conflictKeyOf(identity));
}

/** Stable, non-forgeable evidence reference when the caller does not supply one. */
function derivedEvidenceId(ledgerEventHash: string): string {
  return `ev-${ledgerEventHash.slice(0, 32)}`;
}

function uniqueBranches(identities: readonly MwhaEventIdentity[]): MwhaBranch[] {
  const byHash = new Map<string, MwhaEventIdentity>();
  for (const identity of identities) {
    const existing = byHash.get(identity.ledger_event_hash);
    if (existing === undefined || canonicalJson(identity) < canonicalJson(existing)) {
      byHash.set(identity.ledger_event_hash, identity);
    }
  }
  return [...byHash.entries()]
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
    .map(([hash, identity]) => ({ branch_id: makeBranchId(identity, hash), identity, ledger_event_hash: hash }));
}

function buildClusterLogEntry(
  identity: MwhaEventIdentity,
  status: MwhaEntryStatus,
  leader: MwhaLeaderLease | null,
  commitIndex: number,
): MwhaClusterLogEntry {
  const result = mwhaClusterLogEntrySchema.safeParse({
    schema_version: MWHA_CLUSTER_LOG_ENTRY_SCHEMA_VERSION,
    identity,
    status,
    leader,
    commit_index: commitIndex,
    conflict_key: null,
  });
  if (!result.success) {
    throw new HaProtocolError('HA_INPUT_INVALID', `entry status/commit fields are inconsistent: ${issueText(result.error)}`);
  }
  return result.data;
}

function isCommittedStatus(status: MwhaEntryStatus): boolean {
  return status === 'committed' || status === 'adjudicated';
}

function evidenceForHash(records: readonly MultiWriterEntryRecord[], hash: string): string | null {
  const candidates = records
    .filter((record) => record.entry.identity.ledger_event_hash === hash)
    .sort((left, right) => right.entry.commit_index - left.entry.commit_index);
  return candidates[0]?.evidenceId ?? null;
}

function adjudicationRef(record: MultiWriterAdjudicationRecord): MultiWriterAdjudicationRef {
  return {
    conflict_key: record.conflict_key,
    status: record.adjudication.status,
    selected_branch_id: record.adjudication.selected_branch_id,
    resolution_reason: record.adjudication.resolution_reason,
    branch_hashes: [...record.adjudication.branch_hashes],
    branches: record.branches.map((branch) => ({
      branch_id: branch.branch_id,
      ledger_event_hash: branch.ledger_event_hash,
      identity: branch.identity,
    })),
    evidence_id: record.evidenceId,
  };
}

// ---------------------------------------------------------------------------
// Pure projection
// ---------------------------------------------------------------------------

/**
 * Build the deterministic projection for one entry set and its adjudications.
 *
 * Ordering uses only `sortEntriesByLogicalVersion` for entries; every other
 * array is sorted by a structural key. No wall-clock value participates. The
 * returned `hash` is therefore a pure function of the input multiset.
 */
export function projectMultiWriterState(
  entries: readonly MultiWriterEntryRecord[],
  adjudications: readonly MultiWriterAdjudicationRecord[] = [],
): MultiWriterProjection {
  const committed = entries.filter((record) => isCommittedStatus(record.entry.status));

  const bySlot = new Map<string, MultiWriterEntryRecord[]>();
  const conflictKeyBySlot = new Map<string, MwhaConflictKey>();
  for (const record of entries) {
    const slotKey = slotKeyOfIdentity(record.entry.identity);
    const list = bySlot.get(slotKey);
    if (list === undefined) {
      bySlot.set(slotKey, [record]);
      conflictKeyBySlot.set(slotKey, conflictKeyOf(record.entry.identity));
    } else {
      list.push(record);
    }
  }

  const adjudicationBySlot = new Map<string, MultiWriterAdjudicationRecord>();
  for (const record of adjudications) adjudicationBySlot.set(slotKeyOfConflictKey(record.conflict_key), record);

  const forkReport = detectForks(committed.map((record) => ({ identity: record.entry.identity })));

  const states: MultiWriterSlotState[] = [];
  const slotKeys = [...bySlot.keys()].sort();
  for (const slotKey of slotKeys) {
    const records = bySlot.get(slotKey)!;
    const conflictKey = conflictKeyBySlot.get(slotKey)!;
    const committedRecords = records.filter((record) => isCommittedStatus(record.entry.status));
    const branches = uniqueBranches(committedRecords.map((record) => record.entry.identity));
    const adjudication = adjudicationBySlot.get(slotKey) ?? null;
    const resolved = adjudication?.adjudication.status === 'resolved';
    const versionOutcome = determineVersionOutcome(
      committedRecords.map((record) => ({
        version: logicalVersionOfEntry(record.entry),
        ledger_event_hash: record.entry.identity.ledger_event_hash,
      })),
    );

    let status: MwhaProjectionStatus;
    let winningBranchId: string | null = null;
    let evidenceId: string | null = null;

    if (committedRecords.length === 0) {
      // Only proposed/conflicted material: it exists in the log but never as a fact.
      status = 'uncommitted';
    } else if (branches.length >= 2 && !resolved) {
      // Fork: retain every branch, expose no winner, produce no Gate evidence.
      status = 'conflicted';
    } else {
      status = 'committed';
      if (resolved && adjudication !== null) {
        winningBranchId = adjudication.adjudication.selected_branch_id;
        const selected = branches.find((branch) => branch.branch_id === winningBranchId);
        evidenceId = adjudication.evidenceId ?? (selected ? derivedEvidenceId(selected.ledger_event_hash) : null);
      } else {
        const winner = branches[0];
        winningBranchId = winner?.branch_id ?? null;
        evidenceId = winner ? (evidenceForHash(committedRecords, winner.ledger_event_hash) ?? derivedEvidenceId(winner.ledger_event_hash)) : null;
      }
    }

    const parsedState = mwhaProjectionStateSchema.safeParse({
      schema_version: MWHA_PROJECTION_STATE_SCHEMA_VERSION,
      conflict_key: conflictKey,
      status,
      winning_branch_id: winningBranchId,
      evidence_id: evidenceId,
      produces_gate_evidence: status === 'committed',
    });
    if (!parsedState.success) {
      throw new HaProtocolError('PROJECTION_GATE_FORBIDDEN', `projected state is structurally invalid: ${issueText(parsedState.error)}`);
    }
    assertGateBoundary(parsedState.data);
    states.push({
      ...parsedState.data,
      branches,
      referenced_branch_hashes: branches.map((branch) => branch.ledger_event_hash),
      adjudication,
      version_outcome: versionOutcome,
    });
  }

  const ordered = sortEntriesByLogicalVersion(
    committed.map((record) => ({ identity: record.entry.identity, commit_index: record.entry.commit_index, record })),
  );
  const entryRefs: MultiWriterEntryRef[] = ordered.map(({ record }) => ({
    identity: record.entry.identity,
    status: record.entry.status,
    leader: record.entry.leader,
    commit_index: record.entry.commit_index,
    conflict_key: record.entry.conflict_key,
    evidence_id: record.evidenceId,
  }));

  const adjudicationRefs = [...adjudications]
    .sort((left, right) => {
      const leftKey = slotKeyOfConflictKey(left.conflict_key);
      const rightKey = slotKeyOfConflictKey(right.conflict_key);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    })
    .map(adjudicationRef);

  const material = {
    schema_version: MWHA_PROJECTION_STATE_SCHEMA_VERSION,
    states: states.map((state) => ({
      conflict_key: state.conflict_key,
      status: state.status,
      winning_branch_id: state.winning_branch_id,
      evidence_id: state.evidence_id,
      produces_gate_evidence: state.produces_gate_evidence,
      branches: state.branches.map((branch) => ({
        branch_id: branch.branch_id,
        ledger_event_hash: branch.ledger_event_hash,
        identity: branch.identity,
      })),
      referenced_branch_hashes: state.referenced_branch_hashes,
      adjudication: state.adjudication === null ? null : adjudicationRef(state.adjudication),
      version_outcome: state.version_outcome,
    })),
    entries: entryRefs,
    adjudications: adjudicationRefs,
    forks: forkReport.conflicts,
  };

  return {
    schema_version: MWHA_PROJECTION_STATE_SCHEMA_VERSION,
    states,
    entries: entryRefs,
    adjudications: adjudicationRefs,
    forks: forkReport.conflicts,
    hash: sha256Hex(canonicalJson(material)),
  };
}

// ---------------------------------------------------------------------------
// Log
// ---------------------------------------------------------------------------

/**
 * In-memory multi-writer log. Not a transport and not a commit protocol: it
 * retains committed writer events, classifies deliveries, keeps every fork
 * branch, applies explicit adjudications and reproduces a deterministic
 * projection. T-136+ may add leases/election/network on top of this surface.
 */
export class MultiWriterLog {
  readonly #entries: MultiWriterEntryRecord[] = [];
  readonly #bySlot: Map<string, MultiWriterEntryRecord[]> = new Map();
  readonly #hashesBySlot: Map<string, Set<string>> = new Map();
  readonly #sequences: Map<string, SequenceTracker> = new Map();
  readonly #adjudications: Map<string, MultiWriterAdjudicationRecord> = new Map();
  readonly #knownEpochs: Set<number> | null;
  #currentLease: MwhaLeaderLease | null;
  #maxEpoch: number;
  #maxCommitIndex = 0;
  #duplicateDeliveryCount = 0;

  constructor(options: MultiWriterLogOptions = {}) {
    this.#currentLease = options.lease ?? null;
    this.#knownEpochs = options.knownEpochs === undefined ? null : new Set(options.knownEpochs);
    this.#maxEpoch = this.#currentLease?.epoch ?? 0;
  }

  get size(): number {
    return this.#entries.length;
  }

  get duplicateDeliveryCount(): number {
    return this.#duplicateDeliveryCount;
  }

  get maxCommitIndex(): number {
    return this.#maxCommitIndex;
  }

  get conflictCount(): number {
    return this.forkReport().conflicts.length;
  }

  /** Append one writer proposal/commit. Duplicate content is a zero-side-effect no-op. */
  append(input: MultiWriterAppendInput): MultiWriterAppendResult {
    const event = parseWriterEvent(input.event);
    assertLedgerBinding(event.identity, input.ledgerEvent, input.ledgerEventHash);
    this.#assertFence(event.identity.epoch, event.leader);

    const commitIndex = input.commitIndex ?? MWHA_UNCOMMITTED_COMMIT_INDEX;
    if (!Number.isSafeInteger(commitIndex) || commitIndex < 0) {
      throw new HaProtocolError('HA_INPUT_INVALID', `commitIndex must be a nonnegative integer, got ${String(commitIndex)}`);
    }
    const status = input.status ?? (commitIndex > 0 ? 'committed' : 'proposed');
    const entry = buildClusterLogEntry(event.identity, status, event.leader, commitIndex);

    const classification = this.#classify(event.identity);
    const tracker = this.#trackerFor(event.identity);
    const sequence = classifySequence(tracker.last_local_seq, event.identity.local_seq);

    if (classification.kind === 'duplicate') {
      this.#duplicateDeliveryCount += 1;
      tracker.duplicates += 1;
      const existing = this.#findExisting(event.identity);
      return {
        kind: 'duplicate',
        sequence,
        entry: existing ?? { entry, ledgerEvent: input.ledgerEvent, ledgerEventHash: input.ledgerEventHash, evidenceId: input.evidenceId ?? null, delivery: 'duplicate' },
        commitIndex: existing?.entry.commit_index ?? commitIndex,
        evidenceId: existing?.evidenceId ?? input.evidenceId ?? null,
      };
    }

    const record: MultiWriterEntryRecord = {
      entry,
      ledgerEvent: input.ledgerEvent,
      ledgerEventHash: input.ledgerEventHash,
      evidenceId: input.evidenceId ?? null,
      delivery: classification.kind,
    };
    this.#insert(record);
    this.#advanceSequence(tracker, event.identity.local_seq);
    this.#advanceFence(event.identity.epoch, event.leader);
    return { kind: classification.kind, sequence, entry: record, commitIndex, evidenceId: record.evidenceId };
  }

  /**
   * Ingest replicated cluster-log records atomically: every item is validated
   * before any is stored, so a malformed batch leaves the log untouched.
   * Duplicates inside or across batches have zero side effects.
   */
  ingest(items: readonly MultiWriterIngestItem[]): MultiWriterIngestReport {
    if (!Array.isArray(items)) throw new HaProtocolError('HA_INPUT_INVALID', 'ingest items must be an array');
    const prepared = items.map((item) => {
      const entry = parseClusterLogEntry(item.entry);
      assertLedgerBinding(entry.identity, item.ledgerEvent, item.ledgerEventHash);
      this.#assertFence(entry.identity.epoch, entry.leader);
      return {
        record: {
          entry,
          ledgerEvent: item.ledgerEvent,
          ledgerEventHash: item.ledgerEventHash,
          evidenceId: item.evidenceId ?? null,
          delivery: 'fresh' as MwhaDeliveryKind,
        },
      };
    });

    let applied = 0;
    let duplicates = 0;
    let conflicts = 0;
    const stored: MultiWriterEntryRecord[] = [];
    for (const item of prepared) {
      const classification = this.#classify(item.record.entry.identity);
      const tracker = this.#trackerFor(item.record.entry.identity);
      if (classification.kind === 'duplicate') {
        this.#duplicateDeliveryCount += 1;
        tracker.duplicates += 1;
        const existing = this.#findExisting(item.record.entry.identity);
        if (existing !== undefined) {
          duplicates += 1;
          stored.push(existing);
          continue;
        }
      }
      const record: MultiWriterEntryRecord = { ...item.record, delivery: classification.kind };
      this.#insert(record);
      this.#advanceSequence(tracker, item.record.entry.identity.local_seq);
      this.#advanceFence(item.record.entry.identity.epoch, item.record.entry.leader);
      if (classification.kind === 'conflict') conflicts += 1;
      else applied += 1;
      stored.push(record);
    }
    return { applied, duplicates, conflicts, entries: stored };
  }

  /**
   * Apply one explicit adjudication. The declared branch set must exactly equal
   * the retained committed branches of the conflict slot; a missing or foreign
   * branch throws `ADJUDICATION_INCOMPLETE` and nothing is stored.
   */
  adjudicate(adjudication: MwhaAdjudication, options: MultiWriterAdjudicateOptions = {}): MultiWriterAdjudicationRecord {
    const parsed = parseAdjudication(adjudication);
    const actual = this.#committedBranches(parsed.conflict_key);
    if (actual.length === 0) {
      throw new HaProtocolError('ADJUDICATION_INVALID', `no committed branches exist for conflict key ${slotKeyOfConflictKey(parsed.conflict_key)}`);
    }
    assertAdjudicationComplete(parsed, actual);
    for (const branch of parsed.branches) {
      if (branch.branch_id !== makeBranchId(branch.identity, branch.ledger_event_hash)) {
        throw new HaProtocolError('ADJUDICATION_INVALID', `branch_id ${branch.branch_id} is not derived from its ledger_event_hash`);
      }
      const match = actual.find((candidate) => candidate.ledger_event_hash === branch.ledger_event_hash);
      if (match === undefined || canonicalJson(match.identity) !== canonicalJson(branch.identity)) {
        throw new HaProtocolError('ADJUDICATION_INVALID', `branch ${branch.branch_id} does not match a retained branch identity`);
      }
    }
    if (parsed.status === 'resolved' && !actual.some((branch) => branch.branch_id === parsed.selected_branch_id)) {
      throw new HaProtocolError('ADJUDICATION_INVALID', `selected branch ${String(parsed.selected_branch_id)} is not part of the retained branches`);
    }
    const record: MultiWriterAdjudicationRecord = {
      adjudication: parsed,
      conflict_key: parsed.conflict_key,
      branches: actual,
      evidenceId: options.evidenceId ?? null,
    };
    this.#adjudications.set(slotKeyOfConflictKey(parsed.conflict_key), record);
    return record;
  }

  /** Deterministic projection over everything retained so far. */
  replay(): MultiWriterProjection {
    return projectMultiWriterState(this.#entries, [...this.#adjudications.values()]);
  }

  forkReport() {
    return detectForks(this.#entries.filter((record) => isCommittedStatus(record.entry.status)).map((record) => ({ identity: record.entry.identity })));
  }

  getEntries(): readonly MultiWriterEntryRecord[] {
    return [...this.#entries];
  }

  getAdjudications(): readonly MultiWriterAdjudicationRecord[] {
    return [...this.#adjudications.values()];
  }

  sequenceReports(): readonly MultiWriterSequenceReport[] {
    return [...this.#sequences.values()]
      .sort((left, right) => {
        if (left.writer_id !== right.writer_id) return left.writer_id < right.writer_id ? -1 : 1;
        return left.epoch - right.epoch;
      })
      .map((tracker) => toSequenceReport(tracker));
  }

  sequenceReport(writerId: string, epoch: number): MultiWriterSequenceReport | undefined {
    const tracker = this.#sequences.get(`${writerId}\u0000${epoch}`);
    return tracker === undefined ? undefined : toSequenceReport(tracker);
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  #classify(identity: MwhaEventIdentity): MwhaDeliveryClassification {
    // classifyDelivery expects one representative hash per slot. Probe with the
    // lexicographically smallest retained hash, then re-check the full branch
    // set so a repeat of a non-first branch stays a duplicate rather than a
    // spurious conflict.
    const probe = new Map<string, string>();
    for (const [slotKey, hashes] of this.#hashesBySlot) {
      probe.set(slotKey, [...hashes].sort()[0]!);
    }
    const classification = classifyDelivery(probe, identity);
    if (classification.kind === 'conflict') {
      const known = this.#hashesBySlot.get(slotKeyOfIdentity(identity));
      if (known !== undefined && known.has(identity.ledger_event_hash)) {
        return { kind: 'duplicate', idempotency_key: classification.idempotency_key, content_key: classification.content_key };
      }
    }
    return classification;
  }

  #insert(record: MultiWriterEntryRecord): void {
    const identity = record.entry.identity;
    const slotKey = slotKeyOfIdentity(identity);
    this.#entries.push(record);
    const slotEntries = this.#bySlot.get(slotKey);
    if (slotEntries === undefined) this.#bySlot.set(slotKey, [record]);
    else slotEntries.push(record);
    let hashes = this.#hashesBySlot.get(slotKey);
    if (hashes === undefined) {
      hashes = new Set<string>();
      this.#hashesBySlot.set(slotKey, hashes);
    }
    hashes.add(identity.ledger_event_hash);
    if (record.entry.commit_index > this.#maxCommitIndex) this.#maxCommitIndex = record.entry.commit_index;
  }

  #findExisting(identity: MwhaEventIdentity): MultiWriterEntryRecord | undefined {
    const slotKey = slotKeyOfIdentity(identity);
    return this.#bySlot.get(slotKey)?.find((record) => record.entry.identity.ledger_event_hash === identity.ledger_event_hash);
  }

  #committedBranches(conflictKey: MwhaConflictKey): MwhaBranch[] {
    const targetKey = slotKeyOfConflictKey(conflictKey);
    const identities = this.#entries
      .filter((record) => isCommittedStatus(record.entry.status) && slotKeyOfIdentity(record.entry.identity) === targetKey)
      .map((record) => record.entry.identity);
    return uniqueBranches(identities);
  }

  #trackerFor(identity: MwhaEventIdentity): SequenceTracker {
    const key = `${identity.writer_id}\u0000${identity.epoch}`;
    let tracker = this.#sequences.get(key);
    if (tracker === undefined) {
      tracker = {
        writer_id: identity.writer_id,
        epoch: identity.epoch,
        seen: new Set<number>(),
        last_local_seq: null,
        last_transition: null,
        duplicates: 0,
      };
      this.#sequences.set(key, tracker);
    }
    return tracker;
  }

  #advanceSequence(tracker: SequenceTracker, nextLocalSeq: number): void {
    tracker.seen.add(nextLocalSeq);
    const kind = classifySequence(tracker.last_local_seq, nextLocalSeq);
    if (kind === 'first' || kind === 'contiguous' || kind === 'gap') tracker.last_local_seq = nextLocalSeq;
    tracker.last_transition = kind;
  }

  #assertFence(epoch: number, leader: MwhaLeaderLease | null): void {
    if (this.#knownEpochs !== null && !this.#knownEpochs.has(epoch)) {
      throw new HaProtocolError('FENCE_UNKNOWN_EPOCH', `epoch ${String(epoch)} is not a known epoch`);
    }
    if (leader !== null && this.#currentLease !== null) {
      assertFence(this.#currentLease, leader, this.#knownEpochs ?? undefined);
      return;
    }
    if (leader === null && epoch < this.#maxEpoch) {
      throw new HaProtocolError('FENCE_EPOCH_ROLLBACK', `epoch ${String(epoch)} rolls back the current epoch ${String(this.#maxEpoch)}`);
    }
  }

  #advanceFence(epoch: number, leader: MwhaLeaderLease | null): void {
    if (leader !== null && (this.#currentLease === null || evaluateFence(this.#currentLease, leader, this.#knownEpochs ?? undefined).allowed)) {
      this.#currentLease = leader;
    }
    if (epoch > this.#maxEpoch) this.#maxEpoch = epoch;
  }

  /** Exposed for diagnostics: content keys of every retained branch, grouped by slot. */
  contentKeysBySlot(): ReadonlyMap<string, readonly string[]> {
    const result = new Map<string, string[]>();
    for (const [slotKey, records] of this.#bySlot) {
      result.set(slotKey, [...new Set(records.map((record) => contentKey(record.entry.identity)))].sort());
    }
    return result;
  }
}

function toSequenceReport(tracker: SequenceTracker): MultiWriterSequenceReport {
  const missing: number[] = [];
  if (tracker.last_local_seq !== null) {
    for (let seq = 1; seq <= tracker.last_local_seq; seq += 1) {
      if (!tracker.seen.has(seq)) missing.push(seq);
    }
  }
  return {
    writer_id: tracker.writer_id,
    epoch: tracker.epoch,
    seen_count: tracker.seen.size,
    last_local_seq: tracker.last_local_seq,
    next_expected_local_seq: tracker.last_local_seq === null ? null : tracker.last_local_seq + 1,
    missing_local_seqs: missing,
    duplicate_delivery_count: tracker.duplicates,
    last_transition: tracker.last_transition,
  };
}

/**
 * Fail-closed ledger binding check. `ledgerEventHash` is the caller's
 * `hashEvent(ledgerEvent)` result; this module never recomputes or rewrites it.
 */
function assertLedgerBinding(identity: MwhaEventIdentity, ledgerEvent: LedgerEvent, ledgerEventHash: string): void {
  const parsed = ledgerEventSchema.safeParse(ledgerEvent);
  if (!parsed.success) throw new HaProtocolError('HA_INPUT_INVALID', `ledger event is invalid: ${issueText(parsed.error)}`);
  if (identity.ledger_event_hash !== ledgerEventHash) {
    throw new HaProtocolError(
      'HA_INPUT_INVALID',
      `identity ledger_event_hash ${identity.ledger_event_hash} does not match the caller-computed hashEvent(ledgerEvent) ${ledgerEventHash}`,
    );
  }
}

/** Public re-export of the contract vocabulary used by consumers (T-136/T-139/T-141). */
export { contentKey, idempotencyKey, HaProtocolError };
