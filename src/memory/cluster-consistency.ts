import { z } from 'zod';
import {
  distributedProbeModes,
  type DistributedProbeAnswer,
  type DistributedProbeMetadata,
  type DistributedProbeMode,
} from './distributed-probe.ts';
import type { AnchorProbeSnapshot } from './probe-contract.ts';

/**
 * T-128 / ADR-011 §5、§7.2/§7.3: retrieval-consistency judgement and the
 * primary/local re-verification gate for current execution.
 *
 * `judgeConsistency` takes one frozen {@link DistributedProbeAnswer} plus the
 * caller's expectations and decides exactly one status:
 *
 * - `consistent`   — the requested mode is met, the evidence origin is single,
 *                    the commit/digest/quorum invariants hold, no lag threshold
 *                    is exceeded and a re-sampled `current_snapshot` (when the
 *                    caller supplies one) matches the answer's snapshot;
 * - `stale`        — self-consistent but not fresh: `max_lag` exceeds the
 *                    configured threshold, or an AS_OF target is explicitly
 *                    reported stale/unmet; never presented as fresh;
 * - `inconsistent` — the requested mode was not achieved, digests/commits/
 *                    epochs disagree, or the answer is partial with failed
 *                    nodes;
 * - `blocked`      — fail-closed refusal: mixed local/remote evidence, a commit
 *                    divergence marked as complete, a `current_snapshot`
 *                    mismatch, or historical evidence offered as current
 *                    execution basis.
 *
 * Hard boundaries honoured here:
 * - the judgement is strictly per the *requested* mode; a degraded answer may
 *   never satisfy a higher mode (ADR-011 §5.1 mutual exclusion);
 * - a remote answer never upgrades into Gate-shaped output: this module emits no
 *   `evidence_id`, no `verdict`, no `task_id` and touches no completion channel
 *   (ADR-011 §7.3);
 * - the only acceptable `current_snapshot` source is the caller's local or
 *   primary re-sample, supplied explicitly; it is compared, never adopted from
 *   the answer's remote snapshot.
 *
 * Conventions follow `probe-contract.ts` / `distributed-probe.ts`: snake_case,
 * `.strict()` objects, bounded identifiers, explicit null for unknown values.
 */

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

export const consistencyJudgementStatuses = ['consistent', 'stale', 'inconsistent', 'blocked'] as const;
export type ConsistencyJudgementStatus = (typeof consistencyJudgementStatuses)[number];

/**
 * Judgement codes. `MIXED_EVIDENCE_REJECTED`, `CLUSTER_EPOCH_MISMATCH`,
 * `QUORUM_UNMET`, `VIEW_DIGEST_MISMATCH`, `SNAPSHOT_MISMATCH` reuse the
 * ADR-011 §11 vocabulary; the rest are the T-128 additions named by the task.
 */
export const consistencyJudgementCodes = [
  'CONSISTENT',
  'CONSISTENCY_STALE',
  'CONSISTENCY_INCONSISTENT',
  'CONSISTENCY_BLOCKED',
  'ANSWER_INVALID',
  'PROBE_EXECUTION_FAILED',
  'LOCAL_ORIGIN_REQUIRED',
  'MODE_UNMET',
  'PRIMARY_COMMIT_UNKNOWN',
  'AS_OF_TARGET_UNMET',
  'AS_OF_HISTORICAL_UNMARKED',
  'COMMIT_BEHIND_PRIMARY',
  'EVIDENCE_DIGEST_MISMATCH',
  'VIEW_DIGEST_MISMATCH',
  'QUORUM_DIGEST_DIVERGENCE',
  'CLUSTER_EPOCH_MISMATCH',
  'MAX_LAG_EXCEEDED',
  'QUORUM_LAGGING',
  'COMMITTED_STALE_MARKED',
  'PARTIAL_EVIDENCE',
  'MIXED_EVIDENCE_REJECTED',
  'INCONSISTENT_COMMIT',
  'CURRENT_SNAPSHOT_MISMATCH',
  'HISTORICAL_NOT_EXECUTABLE',
] as const;
export type ConsistencyJudgementCode = (typeof consistencyJudgementCodes)[number];

/** Fail-closed judgement error carrying the same code vocabulary. */
export class ClusterConsistencyError extends Error {
  readonly code: string;
  readonly judgement: ConsistencyJudgement;

  constructor(code: string, message: string, judgement: ConsistencyJudgement) {
    super(`[${code}] ${message}`, undefined);
    this.name = 'ClusterConsistencyError';
    this.code = code;
    this.judgement = judgement;
  }
}

// ---------------------------------------------------------------------------
// Inputs / outputs
// ---------------------------------------------------------------------------

/**
 * Caller-supplied expectations for one judgement. Every field except `mode` is
 * optional so an existing single-store caller can adopt the gate incrementally;
 * when omitted the corresponding check is simply not applied.
 */
export interface ClusterConsistencyExpectations {
  /** The retrieval-consistency mode the answer was requested under. Strict. */
  readonly mode: DistributedProbeMode;
  /** AS_OF target commit point C*. Required for a meaningful AS_OF judgement. */
  readonly asOfCommitIndex?: number;
  /** Expected primary view digest at C* (advisory; the answer carries no view digest). */
  readonly expectedViewDigest?: string;
  /** Primary commit point C, the upper bound for COMMITTED/QUORUM. */
  readonly primaryCommitIndex?: number;
  /** Primary evidence digest recomputed locally by the caller (COMMITTED/QUORUM). */
  readonly primaryEvidenceDigest?: string;
  /** Explicit quorum threshold; defaults to the answer's `quorum_size`. */
  readonly quorumSize?: number;
  /**
   * Configurable maximum lag. When `max_lag` is strictly greater than this
   * threshold the judgement is `stale`, never `consistent`. Omitted means no
   * lag ceiling (the lag is still reported).
   */
  readonly maxLagThreshold?: number;
  /**
   * Current snapshot re-sampled by the local store or the primary. When present
   * it must match the answer's snapshot (four digests, plus the evidence digest
   * when both sides declare one) or the judgement is `blocked`
   * (`CURRENT_SNAPSHOT_MISMATCH`).
   */
  readonly currentSnapshot?: AnchorProbeSnapshot;
  /**
   * True when the answer is intended as the basis for *current* execution
   * (`temporal_mode=CURRENT`). Historical or stale answers are then refused
   * (`HISTORICAL_NOT_EXECUTABLE`). Defaults to false.
   */
  readonly currentExecution?: boolean;
}

export interface ConsistencyJudgement {
  readonly status: ConsistencyJudgementStatus;
  /** Mode actually achieved by the answer (never the requested mode by default). */
  readonly mode: DistributedProbeMode;
  readonly requested_mode: DistributedProbeMode;
  /** Primary refusal/degradation code; null only for a clean `consistent` verdict. */
  readonly code: string | null;
  /** Reported lag against the primary commit point; null when unknown. */
  readonly lag: number | null;
  /** Echo of `metadata.historical`: an AS_OF answer can never ground current execution. */
  readonly historical: boolean;
  /** Echo of `metadata.stale`: the answer itself declares a staleness range. */
  readonly stale: boolean;
  /** Deterministic, human-readable reasons; never free-text claim content. */
  readonly reasons: readonly string[];
}

export const consistencyJudgementSchema = z.object({
  status: z.enum(consistencyJudgementStatuses),
  mode: z.enum(distributedProbeModes),
  requested_mode: z.enum(distributedProbeModes),
  code: z.string().min(1).max(2000).nullable(),
  lag: z.number().int().nonnegative().nullable(),
  historical: z.boolean(),
  stale: z.boolean(),
  reasons: z.array(z.string().min(1).max(2000)).max(64).readonly(),
}).strict();

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const STATUS_SEVERITY: Record<ConsistencyJudgementStatus, number> = {
  consistent: 0,
  stale: 1,
  inconsistent: 2,
  blocked: 3,
};

const FALLBACK_CODE: Record<ConsistencyJudgementStatus, string> = {
  consistent: 'CONSISTENT',
  stale: 'CONSISTENCY_STALE',
  inconsistent: 'CONSISTENCY_INCONSISTENT',
  blocked: 'CONSISTENCY_BLOCKED',
};

interface JudgmentAccumulator {
  status: ConsistencyJudgementStatus;
  code: string | null;
  reasons: string[];
}

function escalate(
  accumulator: JudgmentAccumulator,
  status: ConsistencyJudgementStatus,
  code: string | null,
  reason: string,
): void {
  if (STATUS_SEVERITY[status] > STATUS_SEVERITY[accumulator.status]) {
    accumulator.status = status;
    accumulator.code = code;
  }
  if (accumulator.reasons.length < 64) accumulator.reasons.push(reason);
}

function isMode(value: unknown): value is DistributedProbeMode {
  return typeof value === 'string' && (distributedProbeModes as readonly string[]).includes(value);
}

function snapshotDifferences(expected: AnchorProbeSnapshot, actual: AnchorProbeSnapshot): string[] {
  const differing: string[] = [];
  if (expected.project_scope !== actual.project_scope) differing.push('project_scope');
  if (expected.ledger_digest !== actual.ledger_digest) differing.push('ledger_digest');
  if (expected.graph_revision !== actual.graph_revision) differing.push('graph_revision');
  if (expected.source_fingerprint !== actual.source_fingerprint) differing.push('source_fingerprint');
  if (expected.connected_digest !== actual.connected_digest) differing.push('connected_digest');
  return differing;
}

/** Candidate sources mixing the local store with replica nodes. */
function mixesCandidateOrigins(answer: DistributedProbeAnswer): boolean {
  const sources = answer.candidates.flatMap((fingerprint) => fingerprint.sources);
  let local = false;
  let remote = false;
  for (const source of sources) {
    if (source === 'local') local = true;
    else remote = true;
  }
  return local && remote;
}

/** Node reports claiming that both the local store and a replica were used. */
function mixesNodeUsage(answer: DistributedProbeAnswer): boolean {
  let localUsed = false;
  let remoteUsed = false;
  for (const node of answer.nodes) {
    if (!node.used) continue;
    if (node.replica_id === 'local') localUsed = true;
    else remoteUsed = true;
  }
  return localUsed && remoteUsed;
}

/** Replicas whose declared commit points diverge while the answer claims health. */
function commitDivergenceMarkedHealthy(answer: DistributedProbeAnswer): boolean {
  if (answer.consistency !== 'CONSISTENT') return false;
  // A commit conflict the coordinator already reported cannot coexist with a
  // CONSISTENT claim: the answer contradicts itself.
  if (answer.conflicts.some((conflict) => conflict.kind === 'commit')) return true;
  // Unreported divergence (no conflict entry, no partial marker, no stop
  // reason) is a hidden inconsistency and is refused fail-closed.
  const commits = new Set<number>();
  for (const node of answer.nodes) {
    if (node.outcome === 'OK' && node.commit_index !== null) commits.add(node.commit_index);
  }
  return commits.size > 1 && answer.metadata.partial === false && answer.metadata.stop_reason === 'NONE';
}

function localCommitOf(answer: DistributedProbeAnswer): number | null {
  const meta = answer.metadata;
  if (meta.commit_index !== undefined && Number.isSafeInteger(meta.commit_index)) return meta.commit_index;
  const clusterCommit = answer.response.snapshot.cluster?.commit_index;
  return typeof clusterCommit === 'number' && Number.isSafeInteger(clusterCommit) ? clusterCommit : null;
}

/**
 * Judge one distributed-probe answer against the caller's expectations.
 * Never throws for answer content: every defect becomes a deterministic status
 * and reason. Only a malformed envelope (non-object answer/metadata, unknown
 * mode) throws {@link ClusterConsistencyError}-shaped TypeError.
 */
export function judgeConsistency(
  answer: DistributedProbeAnswer,
  expectations: ClusterConsistencyExpectations,
): ConsistencyJudgement {
  if (answer === null || typeof answer !== 'object' || answer.metadata === null || typeof answer.metadata !== 'object') {
    throw new TypeError('cluster consistency answer must be a DistributedProbeAnswer carrying metadata');
  }
  if (!isMode(expectations?.mode)) {
    throw new TypeError(`cluster consistency expectations.mode must be one of ${distributedProbeModes.join('/')}`);
  }
  const mode = expectations.mode;
  const meta: DistributedProbeMetadata = answer.metadata;
  if (!isMode(meta.mode) || !isMode(answer.requested_mode)) {
    throw new TypeError('cluster consistency answer carries an unknown distributed probe mode');
  }

  const accumulator: JudgmentAccumulator = {
    status: 'consistent',
    code: null,
    reasons: [],
  };

  // --- fail-closed boundary checks (ADR-011 §5.3, §7.2, §7.3) -------------
  if (answer.response === null || typeof answer.response !== 'object' || answer.response.execution_status === 'FAILED') {
    escalate(accumulator, 'blocked', 'PROBE_EXECUTION_FAILED', 'the probe response is missing or its execution_status is FAILED');
  }

  if (mixesCandidateOrigins(answer) || mixesNodeUsage(answer)) {
    escalate(accumulator, 'blocked', 'MIXED_EVIDENCE_REJECTED', 'one conclusion mixes local and remote evidence origins; cross-validation must be two-phase');
  }

  if (commitDivergenceMarkedHealthy(answer)) {
    escalate(accumulator, 'blocked', 'INCONSISTENT_COMMIT', 'replica commit points diverge while the answer is marked CONSISTENT');
  }

  if (expectations.currentSnapshot !== undefined) {
    const expected = expectations.currentSnapshot;
    const actual = answer.response.snapshot;
    const differing = actual === undefined ? ['snapshot'] : snapshotDifferences(expected, actual);
    const expectedDigest = expected.cluster?.evidence_digest;
    const actualDigest = actual?.cluster?.evidence_digest;
    const digestMismatch = expectedDigest !== undefined && actualDigest !== undefined && expectedDigest !== actualDigest;
    if (differing.length > 0 || digestMismatch) {
      escalate(
        accumulator,
        'blocked',
        'CURRENT_SNAPSHOT_MISMATCH',
        `the local/primary current_snapshot does not match the answer snapshot (${differing.length > 0 ? differing.join(',') : 'evidence_digest'})`,
      );
    }
  }

  if (meta.historical === true && mode !== 'AS_OF') {
    escalate(accumulator, 'blocked', 'HISTORICAL_NOT_EXECUTABLE', 'a non-AS_OF request produced historical evidence, which cannot ground current execution');
  }
  if (expectations.currentExecution === true && (meta.historical === true || meta.stale === true)) {
    escalate(accumulator, 'blocked', 'HISTORICAL_NOT_EXECUTABLE', 'historical or stale evidence is not executable for a current-execution basis');
  }

  // --- strict per-mode judgement (ADR-011 §5.1) ---------------------------
  if (answer.requested_mode !== mode) {
    escalate(accumulator, 'inconsistent', 'MODE_UNMET', `answer was requested as ${answer.requested_mode}, not the expected ${mode}`);
  }

  let lag: number | null = typeof meta.max_lag === 'number' && Number.isSafeInteger(meta.max_lag) ? meta.max_lag : null;

  if (mode === 'LOCAL') {
    if (answer.evidence_origin !== 'local') {
      escalate(accumulator, 'inconsistent', 'LOCAL_ORIGIN_REQUIRED', `LOCAL mode requires evidence_origin 'local', got '${answer.evidence_origin}'`);
    }
    if (meta.consistency !== 'CONSISTENT') {
      escalate(accumulator, 'inconsistent', 'PARTIAL_EVIDENCE', `LOCAL answer consistency is ${meta.consistency}, not CONSISTENT within the local declared scope`);
    }
    const localCommit = localCommitOf(answer);
    if (expectations.primaryCommitIndex !== undefined && localCommit !== null) {
      const localLag = Math.max(0, expectations.primaryCommitIndex - localCommit);
      if (lag === null) lag = localLag;
      if (localLag > 0) {
        accumulator.reasons.push(`local commit ${String(localCommit)} trails the primary commit point ${String(expectations.primaryCommitIndex)} by ${String(localLag)} (LOCAL staleness range)`);
      }
    }
  } else if (mode === 'AS_OF') {
    if (meta.mode !== 'AS_OF') {
      escalate(accumulator, 'inconsistent', 'MODE_UNMET', `AS_OF was requested but the answer achieved mode ${meta.mode}`);
    }
    const target = expectations.asOfCommitIndex;
    const commit = localCommitOf(answer);
    if (target === undefined) {
      escalate(accumulator, 'inconsistent', 'AS_OF_TARGET_UNMET', 'AS_OF judgement requires asOfCommitIndex in the expectations');
    } else if (commit === null || commit < target) {
      escalate(accumulator, 'stale', 'AS_OF_TARGET_UNMET', `no answer commit point reaches the AS_OF target C*=${String(target)}${commit === null ? ' (unknown)' : ` (answer commit ${String(commit)})`}`);
    } else if (meta.stale === true) {
      escalate(accumulator, 'stale', 'AS_OF_TARGET_UNMET', `the answer itself marks the AS_OF target C*=${String(target)} as stale`);
    }
    if (meta.historical !== true) {
      escalate(accumulator, 'stale', 'AS_OF_HISTORICAL_UNMARKED', 'an AS_OF answer must be explicitly marked historical so it can never be upgraded to current execution');
    }
  } else if (mode === 'COMMITTED') {
    if (meta.mode !== 'COMMITTED') {
      escalate(accumulator, 'inconsistent', 'MODE_UNMET', `COMMITTED was requested but the answer achieved mode ${meta.mode}`);
    }
    const primary = expectations.primaryCommitIndex ?? meta.primary_commit_index ?? null;
    if (primary === null) {
      escalate(accumulator, 'inconsistent', 'PRIMARY_COMMIT_UNKNOWN', 'COMMITTED judgement requires the primary commit point');
    } else {
      const commit = localCommitOf(answer);
      if (commit === null || commit < primary) {
        escalate(accumulator, 'inconsistent', 'COMMIT_BEHIND_PRIMARY', `answer commit ${commit === null ? 'unknown' : String(commit)} is behind the primary commit point ${String(primary)}`);
      }
      const primaryDigest = expectations.primaryEvidenceDigest ?? meta.quorum_digests[0] ?? null;
      if (primaryDigest !== null && meta.evidence_digest !== primaryDigest) {
        escalate(accumulator, 'inconsistent', 'EVIDENCE_DIGEST_MISMATCH', 'answer evidence_digest does not match the primary evidence digest');
      }
      if (meta.stale === true) {
        escalate(accumulator, 'stale', 'COMMITTED_STALE_MARKED', 'the COMMITTED answer marks itself stale against the primary commit point');
      }
    }
  } else {
    // QUORUM
    if (meta.mode !== 'QUORUM') {
      escalate(accumulator, 'inconsistent', 'MODE_UNMET', `QUORUM was requested but the answer achieved mode ${meta.mode}`);
    }
    const primary = expectations.primaryCommitIndex ?? meta.primary_commit_index ?? null;
    if (primary === null) {
      escalate(accumulator, 'inconsistent', 'PRIMARY_COMMIT_UNKNOWN', 'QUORUM judgement requires the primary commit point as the upper bound');
    }
    const size = expectations.quorumSize ?? meta.quorum_size;
    if (!(Number.isSafeInteger(size) && (size as number) >= 1)) {
      escalate(accumulator, 'inconsistent', 'QUORUM_DIGEST_DIVERGENCE', `quorum threshold is not a positive integer: ${String(size)}`);
    } else if (meta.quorum_count < (size as number)) {
      escalate(accumulator, 'inconsistent', 'QUORUM_DIGEST_DIVERGENCE', `quorum count ${String(meta.quorum_count)} is below the required ${String(size)}`);
    }
    const digests = new Set(meta.quorum_digests);
    if (digests.size === 0) {
      escalate(accumulator, 'inconsistent', 'QUORUM_DIGEST_DIVERGENCE', 'quorum digests are empty; a majority at one commit point was not established');
    } else if (digests.size > 1) {
      escalate(accumulator, 'inconsistent', 'QUORUM_DIGEST_DIVERGENCE', `${String(digests.size)} distinct quorum digests; replicas do not agree on one version`);
    }
    const commit = localCommitOf(answer);
    if (primary !== null && commit !== null && commit > primary) {
      escalate(accumulator, 'inconsistent', 'COMMIT_BEHIND_PRIMARY', `quorum commit ${String(commit)} exceeds the primary commit point ${String(primary)}`);
    }
    if (meta.stale === true) {
      escalate(accumulator, 'stale', 'QUORUM_LAGGING', `the QUORUM answer marks itself stale against the primary commit point ${String(primary)}`);
    }
  }

  // --- partial coverage / failed nodes can never pose as healthy ----------
  const failedNodes = answer.partial.failed_nodes.length > 0;
  const unfinished = meta.stop_reason === 'TIMEOUT'
    || meta.stop_reason === 'CANCELLED'
    || meta.stop_reason === 'NODE_UNAVAILABLE'
    || meta.stop_reason === 'SCOPE_DENIED'
    || meta.stop_reason === 'QUORUM_UNMET';
  if (failedNodes || unfinished) {
    escalate(
      accumulator,
      'inconsistent',
      'PARTIAL_EVIDENCE',
      `answer is partial (stop_reason=${meta.stop_reason}, failed_nodes=${String(answer.partial.failed_nodes.length)})`,
    );
  } else if (meta.partial === true) {
    // Lagging/commit divergence with no failed node and no stop reason is an
    // honest staleness range, not a contradiction: report it in reasons so it
    // can never be read as full-cluster health.
    accumulator.reasons.push('answer reports partial coverage without a failed node or stop reason');
  }

  // --- configurable maximum lag ------------------------------------------
  if (expectations.maxLagThreshold !== undefined && lag !== null && lag > expectations.maxLagThreshold) {
    escalate(accumulator, 'stale', 'MAX_LAG_EXCEEDED', `max_lag ${String(lag)} exceeds the configured threshold ${String(expectations.maxLagThreshold)}`);
  }

  const code = accumulator.status === 'consistent' ? null : (accumulator.code ?? FALLBACK_CODE[accumulator.status]);
  const judgement: ConsistencyJudgement = {
    status: accumulator.status,
    mode: meta.mode,
    requested_mode: answer.requested_mode,
    code,
    lag,
    historical: meta.historical,
    stale: meta.stale,
    reasons: [...accumulator.reasons],
  };
  return consistencyJudgementSchema.parse(judgement);
}

/**
 * Execution gate: only a `consistent` judgement may ground current execution.
 * Stale, inconsistent and blocked judgements throw with the ADR-011 §11 /
 * T-128 vocabulary and carry the full judgement for the failure card.
 */
export function assertExecutableContext(judgement: ConsistencyJudgement): void {
  if (judgement.status === 'consistent') return;
  const code = judgement.code ?? FALLBACK_CODE[judgement.status];
  const detail = judgement.reasons.length > 0 ? judgement.reasons.join('; ') : 'no further reason recorded';
  throw new ClusterConsistencyError(code, `context is ${judgement.status} and cannot ground execution: ${detail}`, judgement);
}
