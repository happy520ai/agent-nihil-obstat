import {
  HaProtocolError,
  MWHA_CLOCK_DEFAULT_POLICY,
  assertNoWallClockKey,
  classifyClockObservation,
  compareLogicalVersion,
  containsWallClockKey,
  logicalVersionOfEntry,
  mwhaClockObservationSchema,
  sortEntriesByLogicalVersion,
  type MwhaClockDiagnosis,
  type MwhaClockKind,
  type MwhaClockObservation,
  type MwhaClockPolicy,
  type MwhaEventIdentity,
  type MwhaLogicalVersion,
} from './ha-protocol.ts';
import {
  projectMultiWriterState,
  type MultiWriterAdjudicationRecord,
  type MultiWriterEntryRecord,
  type MultiWriterProjection,
} from './multi-writer.ts';

/**
 * T-137 / ADR-012 §7: logical clock, clock-skew diagnosis and rollback
 * protection for the optional multi-writer HA layer.
 *
 * Scope and red lines:
 * - fact versions are decided ONLY by `(epoch, commit_index, writer_id,
 *   local_seq)` through `compareLogicalVersion`; a wall clock never enters a
 *   version, a sort key or a conflict decision;
 * - `LogicalClockService` is an HLC-style clock whose `now()` is injected and
 *   used purely as a physical sample. It never changes the OS clock, performs
 *   no I/O and starts no timer;
 * - rollback / future / jump / skew markers come from the frozen
 *   `classifyClockObservation` contract and are diagnostic-only. They are
 *   stored in a separate log that ordering/replay never reads;
 * - `replayOrder` / `replayProjection` are pure functions of the entry set:
 *   any physical-time permutation of one input set yields the same order and
 *   the same projection hash;
 * - local virtual-clock injection models an arbitrary sample sequence. It is
 *   NOT a cross-host clock rollback: real remote clocks, NTP behaviour and
 *   three-machine deployments remain unverified (MWHA_UNVERIFIED_CAPABILITIES).
 */

/** Snapshot/diagnostic schema version for this module. */
export const LOGICAL_CLOCK_SCHEMA_VERSION = 'mwha.logical-clock.v1';

/** Bound of the diagnostic ring buffer; diagnostics never bound ordering. */
export const LOGICAL_CLOCK_MAX_DIAGNOSTICS = 256;

const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

// ---------------------------------------------------------------------------
// Public value types
// ---------------------------------------------------------------------------

/** One HLC-style logical clock snapshot. `physical` never decreases locally. */
export interface LogicalClockSnapshot {
  readonly physical: number;
  readonly logical: number;
  readonly nodeId: string;
}

/** Remote snapshot accepted by {@link LogicalClockService.observe}. */
export type LogicalClockRemote = LogicalClockSnapshot;

export interface LogicalClockOptions {
  /** Stable node identifier; also used as the diagnostic member_id. */
  readonly nodeId: string;
  /**
   * Injectable physical sampler; defaults to `Date.now`. It is a *sample*
   * only: a backwards sample increments `logical`, it never rewinds
   * `physical` and never changes a version/order.
   */
  readonly now?: () => number;
  /** Epoch stamped onto clock observations; diagnostics only. */
  readonly epoch?: number;
  /** Skew/future/jump thresholds for diagnostics. */
  readonly policy?: MwhaClockPolicy;
  /**
   * Optional fixed reference clock (ms) used by skew/future/jump diagnosis.
   * `null`/omitted means "reference unknown"; the previous sample is still
   * used for rollback/jump detection.
   */
  readonly referenceMs?: number | null;
}

/** Where a diagnostic sample came from. */
export type LogicalClockDiagnosticSource = 'tick' | 'observe';

/**
 * One accumulated diagnostic marker. `diagnosis` is the frozen contract
 * result; `diagnostic_only`/`affects_*` are therefore always true/false.
 */
export interface LogicalClockDiagnosticRecord {
  readonly sequence: number;
  readonly source: LogicalClockDiagnosticSource;
  readonly observed_ms: number;
  readonly previous_observed_ms: number | null;
  readonly reference_ms: number | null;
  readonly kind: MwhaClockKind;
  readonly diagnosis: MwhaClockDiagnosis;
}

/** Minimal entry shape needed for a wall-clock-free replay order. */
export interface ReplayableEntry {
  readonly identity: MwhaEventIdentity;
  readonly commit_index: number;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function assertSafeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value)) {
    throw new HaProtocolError('HA_INPUT_INVALID', `${label} must be a safe integer, got ${String(value)}`);
  }
}

function parseNodeId(nodeId: unknown): string {
  if (typeof nodeId !== 'string' || !NODE_ID_PATTERN.test(nodeId)) {
    throw new HaProtocolError('HA_INPUT_INVALID', 'nodeId must be a bounded identifier matching [A-Za-z0-9][A-Za-z0-9._:-]{0,127}');
  }
  return nodeId;
}

function parseRemoteSnapshot(remote: unknown): LogicalClockSnapshot {
  if (remote === null || typeof remote !== 'object' || Array.isArray(remote)) {
    throw new HaProtocolError('HA_INPUT_INVALID', 'remote clock snapshot must be an object');
  }
  const record = remote as Record<string, unknown>;
  assertSafeInteger(record['physical'], 'remote.physical');
  assertSafeInteger(record['logical'], 'remote.logical');
  if (typeof record['nodeId'] !== 'string' || record['nodeId'].length === 0) {
    throw new HaProtocolError('HA_INPUT_INVALID', 'remote.nodeId must be a non-empty string');
  }
  return { physical: record['physical'], logical: record['logical'], nodeId: record['nodeId'] };
}

// ---------------------------------------------------------------------------
// Logical clock service
// ---------------------------------------------------------------------------

/**
 * HLC-style logical clock with an injected physical sampler.
 *
 * `tick()` samples `now()`; `observe(remote)` merges a remote snapshot with
 * the standard HLC rule (max physical, and `max(local, remote) + 1` when the
 * physical parts tie). Every observation is classified by the frozen
 * `classifyClockObservation` contract and appended to a diagnostic-only ring
 * buffer. Nothing in this class is consulted by version ordering or replay.
 */
export class LogicalClockService {
  readonly #nodeId: string;
  readonly #now: () => number;
  readonly #epoch: number;
  readonly #policy: MwhaClockPolicy;
  readonly #referenceMs: number | null;

  #physical = 0;
  #logical = 0;
  #lastObservedMs: number | null = null;
  #diagnosticSequence = 0;
  readonly #diagnostics: LogicalClockDiagnosticRecord[] = [];

  constructor(options: LogicalClockOptions) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new HaProtocolError('HA_INPUT_INVALID', 'logical clock options must be an object');
    }
    this.#nodeId = parseNodeId(options.nodeId);
    if (options.now !== undefined && typeof options.now !== 'function') {
      throw new HaProtocolError('HA_INPUT_INVALID', 'now must be a function when provided');
    }
    if (options.epoch !== undefined) assertSafeInteger(options.epoch, 'epoch');
    if (options.epoch !== undefined && options.epoch < 0) {
      throw new HaProtocolError('HA_INPUT_INVALID', `epoch must be nonnegative, got ${String(options.epoch)}`);
    }
    if (options.referenceMs !== undefined && options.referenceMs !== null) {
      assertSafeInteger(options.referenceMs, 'referenceMs');
    }
    this.#now = options.now ?? Date.now;
    this.#epoch = options.epoch ?? 0;
    this.#policy = options.policy ?? MWHA_CLOCK_DEFAULT_POLICY;
    this.#referenceMs = options.referenceMs ?? null;
  }

  get nodeId(): string {
    return this.#nodeId;
  }

  get epoch(): number {
    return this.#epoch;
  }

  get policy(): MwhaClockPolicy {
    return this.#policy;
  }

  /** Current HLC-style snapshot. A copy; callers cannot mutate the clock. */
  snapshot(): LogicalClockSnapshot {
    return { physical: this.#physical, logical: this.#logical, nodeId: this.#nodeId };
  }

  /**
   * Advance the clock from one local physical sample. A sample that moved
   * backwards is diagnosed as a rollback but cannot rewind `physical`: the
   * clock keeps `physical` and increments `logical`.
   */
  tick(): LogicalClockSnapshot {
    const sampled = this.#sampleNow();
    if (sampled > this.#physical) {
      this.#physical = sampled;
      this.#logical = 0;
    } else {
      this.#incrementLogical();
    }
    this.#recordDiagnostic('tick', sampled);
    return this.snapshot();
  }

  /**
   * Merge one remote snapshot. `physical` is the max of local/remote; when the
   * physical parts tie the logical part is `max(local, remote) + 1`. A remote
   * clock that is behind never rewinds the local physical time.
   */
  observe(remote: LogicalClockRemote): LogicalClockSnapshot {
    const parsed = parseRemoteSnapshot(remote);
    const physical = Math.max(this.#physical, parsed.physical);
    if (physical === this.#physical && physical === parsed.physical) {
      this.#incrementLogical(Math.max(this.#logical, parsed.logical));
    } else if (physical === this.#physical) {
      this.#incrementLogical();
    } else {
      // Both physical values are safe integers, so max must equal one of them.
      this.#incrementLogical(parsed.logical);
    }
    this.#physical = physical;
    this.#recordDiagnostic('observe', parsed.physical);
    return this.snapshot();
  }

  /**
   * Read-only diagnosis of an arbitrary observation against the configured
   * policy. Does not mutate the clock or the diagnostic buffer.
   */
  diagnose(observation: MwhaClockObservation): MwhaClockDiagnosis {
    return classifyClockObservation(observation, this.#policy);
  }

  /**
   * Diagnostic markers recorded by {@link tick}/{@link observe}, oldest first.
   * Read-only view; ordering/replay never reads this buffer.
   */
  diagnostics(): readonly LogicalClockDiagnosticRecord[] {
    return this.#diagnostics.map((record) => ({
      ...record,
      diagnosis: { ...record.diagnosis },
    }));
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  #sampleNow(): number {
    const sampled = this.#now();
    assertSafeInteger(sampled, 'now() sample');
    return sampled;
  }

  #incrementLogical(base = this.#logical): void {
    if (base >= Number.MAX_SAFE_INTEGER) {
      throw new HaProtocolError('HA_INPUT_INVALID', 'logical counter reached Number.MAX_SAFE_INTEGER');
    }
    this.#logical = base + 1;
  }

  #recordDiagnostic(source: LogicalClockDiagnosticSource, observedMs: number): void {
    const observation = mwhaClockObservationSchema.parse({
      member_id: this.#nodeId,
      epoch: this.#epoch,
      observed_ms: observedMs,
      previous_observed_ms: this.#lastObservedMs,
      reference_ms: this.#referenceMs,
    });
    const diagnosis = classifyClockObservation(observation, this.#policy);
    this.#lastObservedMs = observedMs;
    this.#diagnosticSequence += 1;
    this.#diagnostics.push({
      sequence: this.#diagnosticSequence,
      source,
      observed_ms: observation.observed_ms,
      previous_observed_ms: observation.previous_observed_ms,
      reference_ms: observation.reference_ms,
      kind: diagnosis.kind,
      diagnosis,
    });
    while (this.#diagnostics.length > LOGICAL_CLOCK_MAX_DIAGNOSTICS) this.#diagnostics.shift();
  }
}

// ---------------------------------------------------------------------------
// Wall-clock-free ordering API
// ---------------------------------------------------------------------------

/**
 * Refuse to order by anything that carries a wall-clock-looking key. Accepts
 * either one key object or a list; unknown/non-object entries fail closed.
 * Cleaning logical-version objects pass.
 */
export function assertLogicalOnlyOrdering(keys: Record<string, unknown> | readonly Record<string, unknown>[]): void {
  const list = Array.isArray(keys) ? keys : [keys];
  for (const [index, entry] of list.entries()) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new HaProtocolError('HA_INPUT_INVALID', `ordering key at index ${String(index)} must be an object`);
    }
    assertNoWallClockKey(entry);
  }
}

/** Derive the comparable logical version of one committed entry. */
export function versionOf(entry: ReplayableEntry): MwhaLogicalVersion {
  return logicalVersionOfEntry(entry);
}

/** Compare two entries strictly by `(epoch, commit_index, writer_id, local_seq)`. */
export function compareLogicalEntries(left: ReplayableEntry, right: ReplayableEntry): -1 | 0 | 1 {
  return compareLogicalVersion(versionOf(left), versionOf(right));
}

/**
 * Deterministic replay order for one entry multiset. Pure: the injected clock
 * of any service is not consulted, so an arbitrary physical-time permutation
 * of the same entries yields exactly this order.
 */
export function replayOrder<T extends ReplayableEntry>(entries: readonly T[]): T[] {
  return sortEntriesByLogicalVersion(entries);
}

/**
 * Deterministic projection for one entry/adjudication multiset. Delegates to
 * `projectMultiWriterState`; the hash is a pure function of the input set and
 * is therefore independent of every wall-clock sample.
 */
export function replayProjection(
  entries: readonly MultiWriterEntryRecord[],
  adjudications: readonly MultiWriterAdjudicationRecord[] = [],
): MultiWriterProjection {
  return projectMultiWriterState(entries, adjudications);
}

// ---------------------------------------------------------------------------
// Contract re-exports for T-139/T-140/T-141 consumers
// ---------------------------------------------------------------------------

export {
  HaProtocolError,
  assertNoWallClockKey,
  compareLogicalVersion,
  containsWallClockKey,
  type MwhaClockDiagnosis,
  type MwhaClockKind,
  type MwhaClockPolicy,
  type MwhaEventIdentity,
  type MwhaLogicalVersion,
};
