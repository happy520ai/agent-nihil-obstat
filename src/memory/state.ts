import type { DatabaseSync } from 'node:sqlite';
import {
  LedgerIntegrityError,
  readMemoryConflict,
  readMemoryConflicts,
  readMemoryEdges,
  readMemoryHead,
  readMemoryRecord,
  readMemoryRecords,
  type MemoryConflict,
  type MemoryEdge,
  type MemoryEligibility,
  type MemoryRecord,
  type MemoryRecordFilter,
  type MemoryRecordStatus,
} from '../ledger/views.ts';

/**
 * ADR-005 §9/§10 read model over the versioned memory projection in
 * `views.ts`. This module is read-only: it never writes rows and never decides
 * state — every status change comes from a committed memory.* event. Facts are
 * scoped to the ledger this database belongs to (project_scope is structural),
 * so a record from another project's ledger is simply unresolvable here.
 */

export type MemoryTemporalMode = 'current' | 'historical';

export interface MemoryFactReadOptions {
  /** `current` (default) reads as_of now; `historical` requires `asOf`. */
  mode?: MemoryTemporalMode;
  /** ISO datetime for historical reads; must not be backfilled from recorded_at. */
  asOf?: string;
  /** ISO datetime overriding "now" (deterministic reads for tools/tests). */
  now?: string;
}

export interface MemoryFactRead {
  factKey: string;
  found: boolean;
  /** Head-level status; present whenever the fact_key exists in the projection. */
  status?: 'active' | 'retracted' | 'conflicted';
  /** Set on usable reads so historical evidence can never pass as current. */
  usage?: 'current' | 'historical';
  record?: MemoryRecord;
  headRef?: string | null;
  /** True when an effective bound is explicitly null — unknown, never backfilled. */
  temporalUnknown?: boolean;
  /**
   * Why the fact is not currently usable: unknown_fact_key, unresolved_conflict,
   * fact_retracted, not_yet_effective, effective_to_passed, no_version_covers_as_of.
   */
  reason?: string;
  /** Undecided fork branches when status is conflicted (ADR-005 §7). */
  branches?: string[];
  conflict?: MemoryConflict;
}

export interface MemoryConflictReport extends MemoryConflict {
  branchRecords: MemoryRecord[];
}

export interface MemoryRelations {
  ref: string;
  outgoing: MemoryEdge[];
  incoming: MemoryEdge[];
}

function instantMs(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ISO datetime for ${label}: ${JSON.stringify(value)}`);
  return parsed;
}

/**
 * Governed lineage of a fact, head first, following `supersedes_ref` links.
 * The walk stops before legacy ancestors: a note.recorded record (ADR-005 §8)
 * has no fact_key and is never returned as a governed fact.
 */
function memoryFactLineage(db: DatabaseSync, factKey: string): MemoryRecord[] {
  const head = readMemoryHead(db, factKey);
  if (!head?.headRef) return [];
  const lineage: MemoryRecord[] = [];
  let ref: string | undefined = head.headRef;
  while (ref !== undefined) {
    const record = readMemoryRecord(db, ref);
    if (!record || record.factKey !== factKey) break;
    lineage.push(record);
    ref = record.supersedesRef;
  }
  return lineage;
}

/** Read one fact per ADR-005 §9 temporal semantics. */
export function resolveMemoryFact(db: DatabaseSync, factKey: string, options: MemoryFactReadOptions = {}): MemoryFactRead {
  const mode = options.mode ?? 'current';
  const head = readMemoryHead(db, factKey);
  if (!head) return { factKey, found: false, reason: 'unknown_fact_key' };
  if (head.status === 'conflicted') {
    // ADR-005 §7: an undecided conflict is reported, never resolved by replay
    // order — no branch may be returned as the current fact.
    const conflict = readMemoryConflict(db, factKey);
    return { factKey, found: false, status: 'conflicted', headRef: null, branches: conflict?.branches ?? [], ...(conflict ? { conflict } : {}), reason: 'unresolved_conflict' };
  }
  if (head.status === 'retracted') {
    const record = head.headRef ? readMemoryRecord(db, head.headRef) : undefined;
    return { factKey, found: false, status: 'retracted', headRef: head.headRef, ...(record ? { record } : {}), reason: 'fact_retracted' };
  }
  const headRecord = head.headRef ? readMemoryRecord(db, head.headRef) : undefined;
  if (!headRecord) throw new LedgerIntegrityError(`memory head for ${factKey} references missing record ${String(head.headRef)}`);
  if (mode === 'current') {
    const nowMs = options.now !== undefined ? instantMs(options.now, 'now') : Date.now();
    const fromMs = headRecord.effectiveFrom === null ? null : instantMs(headRecord.effectiveFrom, 'effective_from');
    const toMs = headRecord.effectiveTo === null ? null : instantMs(headRecord.effectiveTo, 'effective_to');
    // ADR-005 §9: if the head's interval does not cover as_of the answer is
    // "no current effective version" plus the reason — a superseded or
    // retracted record is never shown as the current fact.
    if (fromMs !== null && fromMs > nowMs) {
      return { factKey, found: false, status: 'active', headRef: head.headRef, record: headRecord, reason: 'not_yet_effective' };
    }
    if (toMs !== null && toMs < nowMs) {
      return { factKey, found: false, status: 'active', headRef: head.headRef, record: headRecord, reason: 'effective_to_passed' };
    }
    return { factKey, found: true, status: 'active', usage: 'current', headRef: head.headRef, record: headRecord, temporalUnknown: headRecord.effectiveFrom === null || headRecord.effectiveTo === null };
  }
  if (options.asOf === undefined) throw new Error('historical memory read requires asOf');
  const asOfMs = instantMs(options.asOf, 'asOf');
  for (const record of memoryFactLineage(db, factKey)) {
    // Historical evidence is marked as such and never escalates to a current
    // execution basis; unknown intervals are returned with temporal_unknown
    // instead of being resolved from recorded_at.
    if (record.effectiveFrom === null || record.effectiveTo === null) {
      return { factKey, found: true, status: 'active', usage: 'historical', headRef: head.headRef, record, temporalUnknown: true };
    }
    if (instantMs(record.effectiveFrom, 'effective_from') <= asOfMs && asOfMs <= instantMs(record.effectiveTo, 'effective_to')) {
      return { factKey, found: true, status: 'active', usage: 'historical', headRef: head.headRef, record, temporalUnknown: false };
    }
  }
  return { factKey, found: false, status: 'active', headRef: head.headRef, reason: 'no_version_covers_as_of' };
}

/** All governed versions of a fact ordered by projection depth (genesis first). */
export function listMemoryFactVersions(db: DatabaseSync, factKey: string): MemoryRecord[] {
  return readMemoryRecords(db, { factKey })
    .sort((a, b) => a.version - b.version || a.recordRef.localeCompare(b.recordRef));
}

/** Records that exist for a fact but are not its current head (superseded, conflicted, retracted). */
export function listMemoryAlternatives(db: DatabaseSync, factKey: string): MemoryRecord[] {
  const head = readMemoryHead(db, factKey);
  return listMemoryFactVersions(db, factKey).filter((record) => record.recordRef !== head?.headRef);
}

/** Full head-first history of a fact (superseded versions included). */
export function readMemoryFactHistory(db: DatabaseSync, factKey: string): MemoryRecord[] {
  return memoryFactLineage(db, factKey);
}

/** Undecided conflicts with their branch records resolved (for unresolved_conflicts reporting). */
export function listUnresolvedMemoryConflicts(db: DatabaseSync): MemoryConflictReport[] {
  return readMemoryConflicts(db).map((conflict) => ({
    ...conflict,
    branchRecords: conflict.branches.map((ref) => {
      const record = readMemoryRecord(db, ref);
      if (!record) throw new LedgerIntegrityError(`memory conflict branch ${ref} for ${conflict.factKey} is unresolvable`);
      return record;
    }),
  }));
}

/** Relation edges touching a record, split by direction; edges never change fact state. */
export function readMemoryRelations(db: DatabaseSync, ref: string): MemoryRelations {
  const edges = readMemoryEdges(db, ref);
  return {
    ref,
    outgoing: edges.filter((edge) => edge.fromRef === ref),
    incoming: edges.filter((edge) => edge.toRef === ref),
  };
}

export function listMemoryRecords(db: DatabaseSync, filter: MemoryRecordFilter = {}): MemoryRecord[] {
  return readMemoryRecords(db, filter);
}

export type { MemoryConflict, MemoryEdge, MemoryEligibility, MemoryRecord, MemoryRecordStatus };
