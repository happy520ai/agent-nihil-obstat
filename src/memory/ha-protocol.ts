import { z } from 'zod';
import { canonicalJson } from '../ledger/event.ts';

/**
 * T-133 / ADR-012: multi-writer HA protocol contract layer.
 *
 * This module freezes the invariants that any T-134+ transport, election or
 * clock implementation must satisfy. It is deliberately side-effect free:
 * no sockets, no child processes, no filesystem access and no wall clock.
 * Every semantic decision (quorum, fencing, version order, fork detection,
 * adjudication completeness, duplicate/reorder classification, clock
 * diagnosis) is a pure function over plain data, and every wire/config shape
 * is a `.strict()` zod schema so unknown or missing fields fail closed.
 *
 * Hard boundaries honoured here:
 * - the protocol is an *additional* optional layer. ADR-011's single-primary
 *   deployment stays the implemented default; nothing in this file rewrites
 *   `src/memory/replication.ts`, `probe-contract.ts` or the child-process
 *   transport contract;
 * - `ledger_event_hash` is a reference to an already committed
 *   `hashEvent(LedgerEvent)` value. This module never recomputes or mutates a
 *   ledger event, so historical event bytes and hashes stay untouched;
 * - wall clock is never a comparison key. It appears only in diagnostic
 *   observations, which cannot change commit order or fact versions;
 * - uncommitted and conflicted branches produce no `evidence_id` and can never
 *   be presented as Gate-passing facts;
 * - only local-TCP protocol behaviour is claimed. Physical three-machine
 *   deployments, OS-level partitions, cross-host clock rollback, production
 *   HA failover and availability SLAs are unverified (see
 *   {@link MWHA_VERIFICATION_SCOPE} and {@link MWHA_UNVERIFIED_CAPABILITIES}).
 */

// ---------------------------------------------------------------------------
// Protocol versions
// ---------------------------------------------------------------------------

/** Umbrella version for topology/fence/fault/clock contracts. */
export const MWHA_PROTOCOL_SCHEMA_VERSION = 'mwha.protocol.v1';
/** Multi-writer propose envelope version. */
export const MWHA_EVENT_SCHEMA_VERSION = 'mwha.event.v1';
/** Cluster log record version. */
export const MWHA_CLUSTER_LOG_ENTRY_SCHEMA_VERSION = 'mwha.cluster-log-entry.v1';
/** Fork adjudication record version. */
export const MWHA_ADJUDICATION_SCHEMA_VERSION = 'mwha.adjudication.v1';
/** Projected fact-state version (carries the Gate boundary). */
export const MWHA_PROJECTION_STATE_SCHEMA_VERSION = 'mwha.projection-state.v1';

// ---------------------------------------------------------------------------
// Bounds and defaults
// ---------------------------------------------------------------------------

export const MWHA_MIN_CLUSTER_SIZE = 1;
export const MWHA_MAX_CLUSTER_SIZE = 64;
export const MWHA_MAX_MEMBERS = 64;
export const MWHA_TERM_INIT = 0;
export const MWHA_LOCAL_SEQ_INIT = 1;
/** Commit index of an uncommitted/proposed entry. */
export const MWHA_UNCOMMITTED_COMMIT_INDEX = 0;
export const MWHA_MAX_BRANCHES = 256;

export const MWHA_CLOCK_DEFAULT_SKEW_TOLERANCE_MS = 5_000;
export const MWHA_CLOCK_DEFAULT_FUTURE_TOLERANCE_MS = 5_000;
export const MWHA_CLOCK_DEFAULT_JUMP_THRESHOLD_MS = 60_000;

export const MWHA_CLOCK_DEFAULT_POLICY = Object.freeze({
  skewToleranceMs: MWHA_CLOCK_DEFAULT_SKEW_TOLERANCE_MS,
  futureToleranceMs: MWHA_CLOCK_DEFAULT_FUTURE_TOLERANCE_MS,
  jumpThresholdMs: MWHA_CLOCK_DEFAULT_JUMP_THRESHOLD_MS,
});

/** Verification boundary: only local TCP protocol behaviour is claimed. */
export const MWHA_VERIFICATION_SCOPE = 'local-tcp-protocol-only' as const;
export const MWHA_VERIFICATION_SCOPE_NOTE =
  '本契约仅在 local-tcp-protocol-only 范围验证：真实 TCP 帧只在本地回环或受控进程之间传输。'
  + '物理三机部署、OS 真分区、跨机时钟回拨、生产 HA 故障切换与可用性 SLA 均为未验证能力，不得宣称。';

/** Capabilities explicitly outside the verified boundary. */
export const MWHA_UNVERIFIED_CAPABILITIES = [
  'physical-three-machine-cluster',
  'os-level-network-partition',
  'cross-host-clock-rollback',
  'production-ha-failover',
  'availability-sla',
] as const;
export type MwhaUnverifiedCapability = (typeof MWHA_UNVERIFIED_CAPABILITIES)[number];

export function isUnverifiedCapability(value: string): boolean {
  return (MWHA_UNVERIFIED_CAPABILITIES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Fault-injection vocabulary (protocol-layer simulation only)
// ---------------------------------------------------------------------------

/**
 * Fault kinds accepted by the protocol simulation. These describe controllable
 * TCP protocol-layer behaviour; they are not claims about OS or physical faults.
 */
export const mwhaFaultKinds = [
  'delay',
  'drop',
  'duplicate',
  'reorder',
  'disconnect',
  'one-way-partition',
  'bandwidth',
] as const;
export type MwhaFaultKind = (typeof mwhaFaultKinds)[number];

export const MWHA_FAULT_INJECTION_LAYER = 'tcp-protocol-simulation' as const;
/**
 * Scope note duplicated into every fault-injection consumer's contract:
 * TCP protocol-layer fault injection is NOT an OS-level partition.
 */
export const MWHA_FAULT_INJECTION_SCOPE_NOTE =
  '故障注入语义边界：delay/drop/duplicate/reorder/disconnect/one-way-partition/bandwidth '
  + '仅描述 TCP 协议层（本地回环或受控传输）的可控行为；TCP 协议层故障注入 ≠ OS 真分区。'
  + 'OS 级网络分区、内核协议栈故障与物理链路中断均未验证。';

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

export const mwhaMemberRoles = ['voting-member', 'observer', 'writer'] as const;
export type MwhaMemberRole = (typeof mwhaMemberRoles)[number];

export const mwhaEntryStatuses = ['proposed', 'committed', 'conflicted', 'adjudicated'] as const;
export type MwhaEntryStatus = (typeof mwhaEntryStatuses)[number];

export const mwhaProjectionStatuses = ['committed', 'conflicted', 'uncommitted', 'unknown'] as const;
export type MwhaProjectionStatus = (typeof mwhaProjectionStatuses)[number];

export const mwhaFenceCodes = [
  'FENCE_OK',
  'FENCE_STALE_TERM',
  'FENCE_SPLIT_BRAIN_SAME_TERM',
  'FENCE_EPOCH_ROLLBACK',
  'FENCE_UNKNOWN_EPOCH',
  'FENCE_INVALID',
] as const;
export type MwhaFenceCode = (typeof mwhaFenceCodes)[number];

export const mwhaSequenceKinds = ['first', 'contiguous', 'duplicate-seq', 'reorder', 'gap'] as const;
export type MwhaSequenceKind = (typeof mwhaSequenceKinds)[number];

export const mwhaDeliveryKinds = ['fresh', 'duplicate', 'conflict'] as const;
export type MwhaDeliveryKind = (typeof mwhaDeliveryKinds)[number];

export const mwhaClockKinds = ['normal', 'skew', 'jump', 'rollback', 'future', 'unknown'] as const;
export type MwhaClockKind = (typeof mwhaClockKinds)[number];

export const mwhaAdjudicationStatuses = ['unresolved', 'resolved'] as const;
export type MwhaAdjudicationStatus = (typeof mwhaAdjudicationStatuses)[number];

export const mwhaErrorCodes = [
  'HA_INPUT_INVALID',
  'QUORUM_INPUT_INVALID',
  'QUORUM_NOT_REACHED',
  'FENCE_REJECTED',
  'EPOCH_ROLLBACK',
  'UNKNOWN_EPOCH',
  'SPLIT_BRAIN',
  'ADJUDICATION_INCOMPLETE',
  'ADJUDICATION_INVALID',
  'FORK_CONFLICT',
  'WALL_CLOCK_FORBIDDEN',
  'CLOCK_OBSERVATION_INVALID',
  'PROJECTION_GATE_FORBIDDEN',
  'TOPOLOGY_INVALID',
] as const;

/** Fail-closed contract error. `code` is stable and assertion-friendly. */
export class HaProtocolError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(`[${code}] ${message}`, options);
    this.name = 'HaProtocolError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Primitive schemas
// ---------------------------------------------------------------------------

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u, 'expected a bounded identifier');
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u, 'expected a lowercase sha256 hex digest');

function boundedInt(min: number, max: number = Number.MAX_SAFE_INTEGER) {
  return z.number().int().min(min).max(max);
}

const epochSchema = boundedInt(0);
const termSchema = boundedInt(0);
const localSeqSchema = boundedInt(1);
const commitIndexSchema = boundedInt(0);

// ---------------------------------------------------------------------------
// Roles and topology
// ---------------------------------------------------------------------------

export const mwhaMemberSchema = z.object({
  member_id: identifier,
  /** voting-member and writer participate in quorum; observer never votes. */
  role: z.enum(mwhaMemberRoles),
}).strict();
export type MwhaMember = z.infer<typeof mwhaMemberSchema>;

/**
 * Static cluster topology. `quorum_size` must equal `floor(N/2)+1` where N is
 * the number of voting participants (every role except `observer`), so a
 * hand-edited majority can never widen or narrow quorum.
 */
export const mwhaTopologySchema = z.object({
  schema_version: z.literal(MWHA_PROTOCOL_SCHEMA_VERSION),
  cluster_id: identifier,
  members: z.array(mwhaMemberSchema).min(1).max(MWHA_MAX_MEMBERS),
  quorum_size: boundedInt(1),
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  for (const [index, member] of value.members.entries()) {
    if (seen.has(member.member_id)) {
      context.addIssue({ code: 'custom', message: `duplicate member_id ${member.member_id}`, path: ['members', index, 'member_id'] });
    }
    seen.add(member.member_id);
  }
  const expected = tryQuorumSize(value.members);
  if (expected === null) {
    context.addIssue({ code: 'custom', message: 'topology needs at least one voting participant (role != observer)', path: ['members'] });
  } else if (value.quorum_size !== expected.quorum) {
    context.addIssue({
      code: 'custom',
      message: `quorum_size ${String(value.quorum_size)} does not match floor(N/2)+1 for N=${String(expected.n)} (expected ${String(expected.quorum)})`,
      path: ['quorum_size'],
    });
  }
});
export type MwhaTopology = z.infer<typeof mwhaTopologySchema>;

// ---------------------------------------------------------------------------
// Event identity, leader lease and envelopes
// ---------------------------------------------------------------------------

/**
 * Identity binding of one writer's proposal to one committed ledger event.
 * `ledger_event_hash` references `hashEvent(existingLedgerEvent)`; this module
 * never recomputes or alters ledger event bytes.
 */
export const mwhaEventIdentitySchema = z.object({
  writer_id: identifier,
  epoch: epochSchema,
  term: termSchema,
  /** 1-based per-writer sequence inside one epoch. */
  local_seq: localSeqSchema,
  ledger_event_hash: sha256,
}).strict();
export type MwhaEventIdentity = z.infer<typeof mwhaEventIdentitySchema>;

/**
 * Fork identity: two entries sharing `(writer_id, epoch, local_seq)` are
 * competing branches of the same logical slot, regardless of payload hash.
 */
export const mwhaConflictKeySchema = z.object({
  writer_id: identifier,
  epoch: epochSchema,
  local_seq: localSeqSchema,
}).strict();
export type MwhaConflictKey = z.infer<typeof mwhaConflictKeySchema>;

/** Leader lease identity used for fencing. */
export const mwhaLeaderLeaseSchema = z.object({
  term: termSchema,
  leader_id: identifier,
  epoch: epochSchema,
}).strict();
export type MwhaLeaderLease = z.infer<typeof mwhaLeaderLeaseSchema>;

/** Propose-side multi-writer envelope (T-134 transport frame payload). */
export const mwhaWriterEventSchema = z.object({
  schema_version: z.literal(MWHA_EVENT_SCHEMA_VERSION),
  identity: mwhaEventIdentitySchema,
  leader: mwhaLeaderLeaseSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.leader !== null && value.leader.epoch !== value.identity.epoch) {
    context.addIssue({
      code: 'custom',
      message: `leader lease epoch ${String(value.leader.epoch)} does not match identity epoch ${String(value.identity.epoch)}`,
      path: ['leader', 'epoch'],
    });
  }
});
export type MwhaWriterEvent = z.infer<typeof mwhaWriterEventSchema>;

/**
 * Cluster log record. Uncommitted records carry `commit_index = 0`; a
 * committed/adjudicated record must carry a positive commit index and a lease.
 */
export const mwhaClusterLogEntrySchema = z.object({
  schema_version: z.literal(MWHA_CLUSTER_LOG_ENTRY_SCHEMA_VERSION),
  identity: mwhaEventIdentitySchema,
  status: z.enum(mwhaEntryStatuses),
  leader: mwhaLeaderLeaseSchema.nullable(),
  commit_index: commitIndexSchema,
  /** Present only when this record participates in (or resolves) a fork. */
  conflict_key: mwhaConflictKeySchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.status === 'committed' || value.status === 'adjudicated') {
    if (value.commit_index < 1) {
      context.addIssue({ code: 'custom', message: `${value.status} entry must carry a positive commit_index`, path: ['commit_index'] });
    }
    if (value.leader === null) {
      context.addIssue({ code: 'custom', message: `${value.status} entry must carry a leader lease`, path: ['leader'] });
    }
  } else if (value.commit_index !== MWHA_UNCOMMITTED_COMMIT_INDEX) {
    context.addIssue({ code: 'custom', message: `${value.status} entry must keep commit_index = 0`, path: ['commit_index'] });
  }
  if (value.status === 'conflicted' && value.conflict_key === null) {
    context.addIssue({ code: 'custom', message: 'conflicted entry must name its conflict_key', path: ['conflict_key'] });
  }
  if (value.conflict_key !== null) {
    const actual = conflictKeyOf(value.identity);
    if (conflictKeyText(actual) !== conflictKeyText(value.conflict_key)) {
      context.addIssue({ code: 'custom', message: 'conflict_key does not match identity', path: ['conflict_key'] });
    }
  }
});
export type MwhaClusterLogEntry = z.infer<typeof mwhaClusterLogEntrySchema>;

// ---------------------------------------------------------------------------
// Logical versions
// ---------------------------------------------------------------------------

/**
 * The only ordering key in the protocol. Wall-clock fields are structurally
 * absent: the schema is `.strict()`, so a timestamp cannot ride along.
 */
export const mwhaLogicalVersionSchema = z.object({
  epoch: epochSchema,
  commit_index: commitIndexSchema,
  writer_id: identifier,
  local_seq: localSeqSchema,
}).strict();
export type MwhaLogicalVersion = z.infer<typeof mwhaLogicalVersionSchema>;

// ---------------------------------------------------------------------------
// Forks and adjudication
// ---------------------------------------------------------------------------

export const mwhaBranchSchema = z.object({
  branch_id: identifier,
  identity: mwhaEventIdentitySchema,
  ledger_event_hash: sha256,
}).strict();
export type MwhaBranch = z.infer<typeof mwhaBranchSchema>;

/**
 * Adjudication of one fork. `branch_hashes` must reference *every* branch hash
 * exactly once; a missing branch is a schema failure, not a silent truncation.
 */
export const mwhaAdjudicationSchema = z.object({
  schema_version: z.literal(MWHA_ADJUDICATION_SCHEMA_VERSION),
  conflict_key: mwhaConflictKeySchema,
  branches: z.array(mwhaBranchSchema).min(2).max(MWHA_MAX_BRANCHES),
  /** Full branch-hash set; equality with `branches` is enforced below. */
  branch_hashes: z.array(sha256).min(2).max(MWHA_MAX_BRANCHES),
  status: z.enum(mwhaAdjudicationStatuses),
  selected_branch_id: identifier.nullable(),
  resolution_reason: z.string().min(1).max(2000).nullable(),
}).strict().superRefine((value, context) => {
  const branchIds = new Set<string>();
  const branchHashes: string[] = [];
  for (const [index, branch] of value.branches.entries()) {
    if (branchIds.has(branch.branch_id)) {
      context.addIssue({ code: 'custom', message: `duplicate branch_id ${branch.branch_id}`, path: ['branches', index, 'branch_id'] });
    }
    branchIds.add(branch.branch_id);
    branchHashes.push(branch.ledger_event_hash);
    if (conflictKeyText(conflictKeyOf(branch.identity)) !== conflictKeyText(value.conflict_key)) {
      context.addIssue({ code: 'custom', message: `branch ${branch.branch_id} identity does not match conflict_key`, path: ['branches', index, 'identity'] });
    }
  }
  if (new Set(branchHashes).size !== branchHashes.length) {
    context.addIssue({ code: 'custom', message: 'a branch set cannot contain two branches with the same ledger_event_hash', path: ['branches'] });
  }

  const declared = value.branch_hashes;
  if (new Set(declared).size !== declared.length) {
    context.addIssue({ code: 'custom', message: 'branch_hashes contains duplicates', path: ['branch_hashes'] });
  }
  for (const hash of branchHashes) {
    if (!declared.includes(hash)) {
      context.addIssue({ code: 'custom', message: `branch_hashes is missing branch hash ${hash}`, path: ['branch_hashes'] });
    }
  }
  for (const hash of declared) {
    if (!branchHashes.includes(hash)) {
      context.addIssue({ code: 'custom', message: `branch_hashes references unknown branch hash ${hash}`, path: ['branch_hashes'] });
    }
  }

  if (value.status === 'resolved') {
    if (value.selected_branch_id === null) {
      context.addIssue({ code: 'custom', message: 'resolved adjudication must select a branch', path: ['selected_branch_id'] });
    } else if (!branchIds.has(value.selected_branch_id)) {
      context.addIssue({ code: 'custom', message: `selected_branch_id ${value.selected_branch_id} is not part of the branch set`, path: ['selected_branch_id'] });
    }
    if (value.resolution_reason === null) {
      context.addIssue({ code: 'custom', message: 'resolved adjudication must carry a resolution_reason', path: ['resolution_reason'] });
    }
  } else {
    if (value.selected_branch_id !== null) {
      context.addIssue({ code: 'custom', message: 'unresolved adjudication cannot select a branch', path: ['selected_branch_id'] });
    }
    if (value.resolution_reason !== null) {
      context.addIssue({ code: 'custom', message: 'unresolved adjudication cannot carry a resolution_reason', path: ['resolution_reason'] });
    }
  }
});
export type MwhaAdjudication = z.infer<typeof mwhaAdjudicationSchema>;

/**
 * Projected state of one fact slot. The Gate boundary is structural:
 * only `committed` may carry an `evidence_id` or set `produces_gate_evidence`.
 */
export const mwhaProjectionStateSchema = z.object({
  schema_version: z.literal(MWHA_PROJECTION_STATE_SCHEMA_VERSION),
  conflict_key: mwhaConflictKeySchema,
  status: z.enum(mwhaProjectionStatuses),
  winning_branch_id: identifier.nullable(),
  /** Null for every non-committed state; never fabricated. */
  evidence_id: identifier.nullable(),
  produces_gate_evidence: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.status === 'committed') {
    if (value.winning_branch_id === null) {
      context.addIssue({ code: 'custom', message: 'committed state must name a winning branch', path: ['winning_branch_id'] });
    }
    if (value.evidence_id === null) {
      context.addIssue({ code: 'custom', message: 'committed state must carry an evidence_id', path: ['evidence_id'] });
    }
    if (value.produces_gate_evidence !== true) {
      context.addIssue({ code: 'custom', message: 'committed state must set produces_gate_evidence=true', path: ['produces_gate_evidence'] });
    }
    return;
  }
  if (value.winning_branch_id !== null) {
    context.addIssue({ code: 'custom', message: `${value.status} state cannot name a winning branch`, path: ['winning_branch_id'] });
  }
  if (value.evidence_id !== null) {
    context.addIssue({ code: 'custom', message: `${value.status} state cannot carry an evidence_id (Gate boundary)`, path: ['evidence_id'] });
  }
  if (value.produces_gate_evidence !== false) {
    context.addIssue({ code: 'custom', message: `${value.status} state cannot produce Gate evidence`, path: ['produces_gate_evidence'] });
  }
});
export type MwhaProjectionState = z.infer<typeof mwhaProjectionStateSchema>;

// ---------------------------------------------------------------------------
// Clock observation (diagnostic only)
// ---------------------------------------------------------------------------

export const mwhaClockObservationSchema = z.object({
  member_id: identifier,
  epoch: epochSchema,
  /** Observed local wall clock in ms; diagnostics only, never a version key. */
  observed_ms: z.number().int(),
  previous_observed_ms: z.number().int().nullable(),
  /** Reference clock (e.g. remote/leader sample) in ms; null when unknown. */
  reference_ms: z.number().int().nullable(),
}).strict();
export type MwhaClockObservation = z.infer<typeof mwhaClockObservationSchema>;

export interface MwhaClockPolicy {
  readonly skewToleranceMs: number;
  readonly futureToleranceMs: number;
  readonly jumpThresholdMs: number;
}

export interface MwhaClockDiagnosis {
  readonly member_id: string;
  readonly epoch: number;
  readonly kind: MwhaClockKind;
  /** Always true: a diagnosis is a marker, never a commit-order input. */
  readonly diagnostic_only: true;
  readonly affects_commit_order: false;
  readonly affects_fact_version: false;
  readonly detail: string;
}

// ---------------------------------------------------------------------------
// Fault injection schema
// ---------------------------------------------------------------------------

export const mwhaFaultInjectionSchema = z.object({
  schema_version: z.literal(MWHA_PROTOCOL_SCHEMA_VERSION),
  kind: z.enum(mwhaFaultKinds),
  target_member_id: identifier,
  /** 0..1; a deterministic test may set 1. */
  probability: z.number().min(0).max(1),
  duration_ms: boundedInt(1),
}).strict();
export type MwhaFaultInjection = z.infer<typeof mwhaFaultInjectionSchema>;

// ---------------------------------------------------------------------------
// Quorum (pure)
// ---------------------------------------------------------------------------

function assertClusterSize(n: number): void {
  if (!Number.isSafeInteger(n) || n < MWHA_MIN_CLUSTER_SIZE || n > MWHA_MAX_CLUSTER_SIZE) {
    throw new HaProtocolError(
      'QUORUM_INPUT_INVALID',
      `cluster size must be an integer in [${String(MWHA_MIN_CLUSTER_SIZE)}, ${String(MWHA_MAX_CLUSTER_SIZE)}], got ${String(n)}`,
    );
  }
}

/** Majority quorum: floor(N/2)+1. N=2 therefore needs both votes. */
export function quorumSize(n: number): number {
  assertClusterSize(n);
  return Math.floor(n / 2) + 1;
}

/** Observers replicate but never vote; voting participants are all other roles. */
export function isVotingRole(role: MwhaMemberRole): boolean {
  return role !== 'observer';
}

export function votingMemberCount(members: readonly MwhaMember[]): number {
  return members.reduce((total, member) => total + (isVotingRole(member.role) ? 1 : 0), 0);
}

function tryQuorumSize(members: readonly MwhaMember[]): { n: number; quorum: number } | null {
  const n = votingMemberCount(members);
  if (!Number.isSafeInteger(n) || n < MWHA_MIN_CLUSTER_SIZE || n > MWHA_MAX_CLUSTER_SIZE) return null;
  return { n, quorum: quorumSize(n) };
}

/** Quorum implied by a topology's voting participants. */
export function quorumSizeForMembers(members: readonly MwhaMember[]): number {
  const result = tryQuorumSize(members);
  if (result === null) {
    throw new HaProtocolError('TOPOLOGY_INVALID', 'topology needs at least one voting participant (role != observer)');
  }
  return result.quorum;
}

/** True when `votes` is a majority of an N-member voting cluster. */
export function isQuorum(votes: number, n: number): boolean {
  assertClusterSize(n);
  if (!Number.isSafeInteger(votes) || votes < 0 || votes > n) {
    throw new HaProtocolError('QUORUM_INPUT_INVALID', `votes must be an integer in [0, ${String(n)}], got ${String(votes)}`);
  }
  return votes >= quorumSize(n);
}

/** Fail-closed quorum assertion (minority is always refused). */
export function assertQuorum(votes: number, n: number): void {
  assertClusterSize(n);
  if (!isQuorum(votes, n)) {
    throw new HaProtocolError(
      'QUORUM_NOT_REACHED',
      `${String(votes)} vote(s) are below the ${String(quorumSize(n))}-vote quorum of an ${String(n)}-member cluster`,
    );
  }
}

export interface MwhaPartitionEvaluation {
  readonly n: number;
  readonly quorum_size: number;
  readonly committing_partitions: readonly number[];
  readonly blocked_partitions: readonly number[];
  /** True when at least one partition independently holds a majority. */
  readonly any_commit: boolean;
}

/**
 * Evaluate partition sizes against one cluster. A 2-member cluster split 1-1
 * yields no committing partition: each side is a minority (Q=2). Failed nodes
 * are simply absent from `partitionSizes`; they never help a partition.
 */
export function evaluatePartitions(partitionSizes: readonly number[], n: number): MwhaPartitionEvaluation {
  assertClusterSize(n);
  if (!Array.isArray(partitionSizes)) {
    throw new HaProtocolError('QUORUM_INPUT_INVALID', 'partitionSizes must be an array')
  }
  const q = quorumSize(n);
  const committing: number[] = [];
  const blocked: number[] = [];
  for (const size of partitionSizes) {
    if (!Number.isSafeInteger(size) || size < 1 || size > n) {
      throw new HaProtocolError('QUORUM_INPUT_INVALID', `partition size ${String(size)} must be an integer in [1, ${String(n)}]`);
    }
    (size >= q ? committing : blocked).push(size);
  }
  committing.sort((left, right) => left - right);
  blocked.sort((left, right) => left - right);
  return { n, quorum_size: q, committing_partitions: committing, blocked_partitions: blocked, any_commit: committing.length > 0 };
}

// ---------------------------------------------------------------------------
// Fencing (pure)
// ---------------------------------------------------------------------------

export interface MwhaFenceEvaluation {
  readonly allowed: boolean;
  readonly code: MwhaFenceCode;
  readonly detail: string;
}

/**
 * Fencing rules, evaluated in this fixed order:
 * 1. malformed lease -> `FENCE_INVALID`;
 * 2. candidate epoch unknown to this node -> `FENCE_UNKNOWN_EPOCH` (fail-closed);
 * 3. candidate epoch below current epoch -> `FENCE_EPOCH_ROLLBACK` (monotonic);
 * 4. candidate term below current term -> `FENCE_STALE_TERM` (old leader);
 * 5. same term, different leader -> `FENCE_SPLIT_BRAIN_SAME_TERM` (two masters);
 * 6. otherwise allowed.
 */
export function evaluateFence(
  current: MwhaLeaderLease,
  candidate: MwhaLeaderLease,
  knownEpochs?: ReadonlySet<number>,
): MwhaFenceEvaluation {
  if (!mwhaLeaderLeaseSchema.safeParse(current).success || !mwhaLeaderLeaseSchema.safeParse(candidate).success) {
    return { allowed: false, code: 'FENCE_INVALID', detail: 'current/candidate lease is not a valid mwha leader lease' };
  }
  if (knownEpochs !== undefined && !knownEpochs.has(candidate.epoch)) {
    return { allowed: false, code: 'FENCE_UNKNOWN_EPOCH', detail: `candidate epoch ${String(candidate.epoch)} is not a known epoch` };
  }
  if (candidate.epoch < current.epoch) {
    return { allowed: false, code: 'FENCE_EPOCH_ROLLBACK', detail: `candidate epoch ${String(candidate.epoch)} rolls back current epoch ${String(current.epoch)}` };
  }
  if (candidate.term < current.term) {
    return { allowed: false, code: 'FENCE_STALE_TERM', detail: `candidate term ${String(candidate.term)} is older than current term ${String(current.term)}` };
  }
  if (candidate.term === current.term && candidate.leader_id !== current.leader_id) {
    return {
      allowed: false,
      code: 'FENCE_SPLIT_BRAIN_SAME_TERM',
      detail: `term ${String(current.term)} already belongs to leader ${current.leader_id}; candidate ${candidate.leader_id} is illegal`,
    };
  }
  return { allowed: true, code: 'FENCE_OK', detail: 'candidate lease satisfies the fence' };
}

export function assertFence(current: MwhaLeaderLease, candidate: MwhaLeaderLease, knownEpochs?: ReadonlySet<number>): void {
  const evaluation = evaluateFence(current, candidate, knownEpochs);
  if (!evaluation.allowed) throw new HaProtocolError(evaluation.code, evaluation.detail);
}

export interface MwhaMultipleLeader {
  readonly epoch: number;
  readonly term: number;
  readonly leader_ids: readonly string[];
}

/**
 * Detect two distinct leaders claiming the same `(epoch, term)`. A topology may
 * declare several writers, but at most one may hold a given lease; a second
 * claimant is a split-brain signal, not a tie to break by wall clock.
 */
export function detectMultipleLeaders(declarations: readonly MwhaLeaderLease[]): readonly MwhaMultipleLeader[] {
  const groups = new Map<string, { epoch: number; term: number; leaders: Set<string> }>();
  for (const declaration of declarations) {
    if (!mwhaLeaderLeaseSchema.safeParse(declaration).success) {
      throw new HaProtocolError('HA_INPUT_INVALID', 'leader declaration is not a valid mwha leader lease');
    }
    const key = `${declaration.epoch}\u0000${declaration.term}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { epoch: declaration.epoch, term: declaration.term, leaders: new Set([declaration.leader_id]) });
    else group.leaders.add(declaration.leader_id);
  }
  const conflicts: MwhaMultipleLeader[] = [];
  for (const group of groups.values()) {
    if (group.leaders.size > 1) {
      conflicts.push({ epoch: group.epoch, term: group.term, leader_ids: [...group.leaders].sort() });
    }
  }
  return conflicts.sort((left, right) => left.epoch - right.epoch || left.term - right.term);
}

// ---------------------------------------------------------------------------
// Identity keys, duplicate/reorder classification (pure)
// ---------------------------------------------------------------------------

/** Slot key: identity without term/hash. Same key with a different hash is a fork. */
export function conflictKeyOf(identity: MwhaEventIdentity): MwhaConflictKey {
  return { writer_id: identity.writer_id, epoch: identity.epoch, local_seq: identity.local_seq };
}

function conflictKeyText(key: MwhaConflictKey): string {
  return `${key.writer_id}\u0000${key.epoch}\u0000${key.local_seq}`;
}

/** Code-unit comparison; never locale-dependent (deterministic ordering). */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Idempotency key of one writer slot. */
export function idempotencyKey(identity: MwhaEventIdentity): string {
  return conflictKeyText(conflictKeyOf(identity));
}

/** Content key: slot + referenced ledger event hash. */
export function contentKey(identity: MwhaEventIdentity): string {
  return `${idempotencyKey(identity)}\u0000${identity.ledger_event_hash}`;
}

export interface MwhaDeliveryClassification {
  readonly kind: MwhaDeliveryKind;
  readonly idempotency_key: string;
  readonly content_key: string;
}

/**
 * Classify one delivery against already-seen slots:
 * - same slot, same hash -> `duplicate` (zero side effect);
 * - same slot, different hash -> `conflict` (fork, never overwrite);
 * - unseen slot -> `fresh`.
 */
export function classifyDelivery(
  seen: ReadonlyMap<string, string>,
  identity: MwhaEventIdentity,
): MwhaDeliveryClassification {
  if (!mwhaEventIdentitySchema.safeParse(identity).success) {
    throw new HaProtocolError('HA_INPUT_INVALID', 'delivery identity is not a valid mwha event identity');
  }
  const key = idempotencyKey(identity);
  const content = contentKey(identity);
  const previous = seen.get(key);
  if (previous === undefined) return { kind: 'fresh', idempotency_key: key, content_key: content };
  return {
    kind: previous === identity.ledger_event_hash ? 'duplicate' : 'conflict',
    idempotency_key: key,
    content_key: content,
  };
}

/** Classify a per-writer local_seq transition. */
export function classifySequence(previousLocalSeq: number | null, nextLocalSeq: number): MwhaSequenceKind {
  if (!Number.isSafeInteger(nextLocalSeq) || nextLocalSeq < MWHA_LOCAL_SEQ_INIT) {
    throw new HaProtocolError('HA_INPUT_INVALID', `nextLocalSeq must be a positive integer, got ${String(nextLocalSeq)}`);
  }
  if (previousLocalSeq !== null && (!Number.isSafeInteger(previousLocalSeq) || previousLocalSeq < MWHA_LOCAL_SEQ_INIT)) {
    throw new HaProtocolError('HA_INPUT_INVALID', `previousLocalSeq must be null or a positive integer, got ${String(previousLocalSeq)}`);
  }
  if (previousLocalSeq === null) return 'first';
  if (nextLocalSeq === previousLocalSeq) return 'duplicate-seq';
  if (nextLocalSeq === previousLocalSeq + 1) return 'contiguous';
  if (nextLocalSeq < previousLocalSeq) return 'reorder';
  return 'gap';
}

// ---------------------------------------------------------------------------
// Logical version order (pure, wall-clock free)
// ---------------------------------------------------------------------------

const WALL_CLOCK_KEYS = new Set([
  'wallclock',
  'clock',
  'timestamp',
  'time',
  'date',
  'now',
  'observedat',
  'recordedat',
  'createdat',
  'updatedat',
]);

/** True when a loose object carries a wall-clock-looking key. Diagnostic aid. */
export function containsWallClockKey(value: Record<string, unknown>): boolean {
  return Object.keys(value).some((key) => WALL_CLOCK_KEYS.has(key.toLowerCase().replace(/[^a-z]/gu, '')));
}

/** Refuse to feed an object whose ordering could depend on wall clock. */
export function assertNoWallClockKey(value: Record<string, unknown>): void {
  const offenders = Object.keys(value).filter((key) => WALL_CLOCK_KEYS.has(key.toLowerCase().replace(/[^a-z]/gu, '')));
  if (offenders.length > 0) {
    throw new HaProtocolError('WALL_CLOCK_FORBIDDEN', `wall clock is not a protocol ordering key; offending field(s): ${offenders.join(', ')}`);
  }
}

function assertLogicalVersionShape(value: MwhaLogicalVersion): void {
  if (
    !Number.isSafeInteger(value.epoch)
    || !Number.isSafeInteger(value.commit_index)
    || typeof value.writer_id !== 'string'
    || value.writer_id.length === 0
    || !Number.isSafeInteger(value.local_seq)
  ) {
    throw new HaProtocolError('HA_INPUT_INVALID', 'logical version must carry integer epoch/commit_index/local_seq and a writer_id');
  }
}

/**
 * Lexicographic order over `(epoch, commit_index, writer_id, local_seq)`.
 * Returns -1/0/1. Extra fields (including a wall clock) are ignored on
 * purpose: they are not comparison keys. Equal versions return 0; resolving a
 * same-version hash conflict is the caller's conflict path, never LWW.
 */
export function compareLogicalVersion(a: MwhaLogicalVersion, b: MwhaLogicalVersion): -1 | 0 | 1 {
  assertLogicalVersionShape(a);
  assertLogicalVersionShape(b);
  if (a.epoch !== b.epoch) return a.epoch < b.epoch ? -1 : 1;
  if (a.commit_index !== b.commit_index) return a.commit_index < b.commit_index ? -1 : 1;
  if (a.writer_id !== b.writer_id) return a.writer_id < b.writer_id ? -1 : 1;
  if (a.local_seq !== b.local_seq) return a.local_seq < b.local_seq ? -1 : 1;
  return 0;
}

/** Deterministic, wall-clock-free sort key for one logical version. */
export function mergeSortKey(version: MwhaLogicalVersion): string {
  assertLogicalVersionShape(version);
  return canonicalJson({
    epoch: version.epoch,
    commit_index: version.commit_index,
    writer_id: version.writer_id,
    local_seq: version.local_seq,
  });
}

/** Ascending deterministic sort; input order never matters. */
export function sortLogicalVersions<T extends MwhaLogicalVersion>(versions: readonly T[]): T[] {
  return [...versions].sort(compareLogicalVersion);
}

/** Derive the comparable version of one cluster log entry. */
export function logicalVersionOfEntry(entry: { readonly identity: MwhaEventIdentity; readonly commit_index: number }): MwhaLogicalVersion {
  return {
    epoch: entry.identity.epoch,
    commit_index: entry.commit_index,
    writer_id: entry.identity.writer_id,
    local_seq: entry.identity.local_seq,
  };
}

/** Deterministic sort of cluster log entries by logical version, then hash. */
export function sortEntriesByLogicalVersion<T extends { readonly identity: MwhaEventIdentity; readonly commit_index: number }>(
  entries: readonly T[],
): T[] {
  return [...entries].sort((left, right) => {
    const order = compareLogicalVersion(logicalVersionOfEntry(left), logicalVersionOfEntry(right));
    if (order !== 0) return order;
    return left.identity.ledger_event_hash < right.identity.ledger_event_hash ? -1 : 1;
  });
}

export interface MwhaVersionOutcome {
  readonly status: 'empty' | 'committed' | 'conflicted';
  readonly winning_version: MwhaLogicalVersion | null;
  /** All distinct hashes tied at the winning version (length > 1 on conflict). */
  readonly conflicting_hashes: readonly string[];
}

/**
 * Pick the winning version. A single highest version commits; a tie at the
 * highest version with more than one distinct hash is a conflict and is never
 * resolved by arrival order or wall clock.
 */
export function determineVersionOutcome(
  candidates: readonly { readonly version: MwhaLogicalVersion; readonly ledger_event_hash: string }[],
): MwhaVersionOutcome {
  if (candidates.length === 0) return { status: 'empty', winning_version: null, conflicting_hashes: [] };
  let winning = candidates[0]!.version;
  for (const candidate of candidates) {
    const order = compareLogicalVersion(candidate.version, winning);
    if (order > 0) winning = candidate.version;
  }
  const tied = candidates.filter((candidate) => compareLogicalVersion(candidate.version, winning) === 0);
  const hashes = [...new Set(tied.map((candidate) => candidate.ledger_event_hash))].sort();
  if (hashes.length > 1) {
    return { status: 'conflicted', winning_version: winning, conflicting_hashes: hashes };
  }
  return { status: 'committed', winning_version: winning, conflicting_hashes: hashes };
}

// ---------------------------------------------------------------------------
// Fork detection (pure)
// ---------------------------------------------------------------------------

export interface MwhaForkEntry {
  readonly identity: MwhaEventIdentity;
}

export interface MwhaForkConflict {
  readonly conflict_key: MwhaConflictKey;
  readonly branches: readonly MwhaBranch[];
  /** Distinct competing hashes; duplicates were collapsed. */
  readonly branch_count: number;
}

export interface MwhaForkReport {
  readonly conflicts: readonly MwhaForkConflict[];
  /** Idempotency keys that carry more than one distinct branch, sorted. */
  readonly conflict_keys: readonly string[];
  /** Total distinct branches retained across all conflicts. */
  readonly branch_count: number;
}

/** Deterministic branch id derived from the referenced ledger hash. */
export function makeBranchId(identity: MwhaEventIdentity, ledgerEventHash: string): string {
  return `branch-${ledgerEventHash.slice(0, 16)}`;
}

/**
 * Group entries by `(writer_id, epoch, local_seq)` and retain every distinct
 * branch. Identical repeats collapse; competing hashes become a conflict whose
 * branch set is complete by construction.
 */
export function detectForks(entries: readonly MwhaForkEntry[]): MwhaForkReport {
  const slots = new Map<string, Map<string, MwhaBranch>>();
  const keyByIdentity = new Map<string, MwhaConflictKey>();
  for (const entry of entries) {
    if (!mwhaEventIdentitySchema.safeParse(entry.identity).success) {
      throw new HaProtocolError('HA_INPUT_INVALID', 'fork entry identity is not a valid mwha event identity');
    }
    const identity = entry.identity;
    const slot = idempotencyKey(identity);
    let branches = slots.get(slot);
    if (branches === undefined) {
      branches = new Map<string, MwhaBranch>();
      slots.set(slot, branches);
      keyByIdentity.set(slot, conflictKeyOf(identity));
    }
    if (!branches.has(identity.ledger_event_hash)) {
      branches.set(identity.ledger_event_hash, {
        branch_id: makeBranchId(identity, identity.ledger_event_hash),
        identity,
        ledger_event_hash: identity.ledger_event_hash,
      });
    }
  }

  const conflicts: MwhaForkConflict[] = [];
  for (const [slot, branches] of slots) {
    if (branches.size < 2) continue;
    const ordered = [...branches.values()].sort((left, right) => compareText(left.ledger_event_hash, right.ledger_event_hash));
    const key = keyByIdentity.get(slot)!;
    conflicts.push({ conflict_key: key, branches: ordered, branch_count: ordered.length });
  }
  conflicts.sort((left, right) => compareText(conflictKeyText(left.conflict_key), conflictKeyText(right.conflict_key)));
  return {
    conflicts,
    conflict_keys: conflicts.map((conflict) => conflictKeyText(conflict.conflict_key)).sort(),
    branch_count: conflicts.reduce((total, conflict) => total + conflict.branch_count, 0),
  };
}

// ---------------------------------------------------------------------------
// Adjudication completeness (pure)
// ---------------------------------------------------------------------------

/**
 * Return every reason an adjudication does not account for its full branch
 * set. An empty array means the adjudication is complete and internally
 * consistent. When `branches` is supplied it is authoritative: the
 * adjudication must reference exactly those hashes.
 */
export function adjudicationProblems(
  adjudication: MwhaAdjudication,
  branches?: readonly MwhaBranch[],
): string[] {
  const problems: string[] = [];
  const branchHashes = adjudication.branches.map((branch) => branch.ledger_event_hash);
  const branchIds = new Set(adjudication.branches.map((branch) => branch.branch_id));

  if (new Set(branchHashes).size !== branchHashes.length) problems.push('branches contain duplicate ledger_event_hash values');
  if (new Set(adjudication.branch_hashes).size !== adjudication.branch_hashes.length) problems.push('branch_hashes contains duplicates');

  const expected = branches === undefined ? branchHashes : branches.map((branch) => branch.ledger_event_hash);
  const expectedSet = new Set(expected);
  const declaredSet = new Set(adjudication.branch_hashes);
  for (const hash of expectedSet) {
    if (!declaredSet.has(hash)) problems.push(`branch_hashes is missing branch hash ${hash}`);
  }
  for (const hash of declaredSet) {
    if (!expectedSet.has(hash)) problems.push(`branch_hashes references unknown branch hash ${hash}`);
  }

  for (const branch of adjudication.branches) {
    if (conflictKeyText(conflictKeyOf(branch.identity)) !== conflictKeyText(adjudication.conflict_key)) {
      problems.push(`branch ${branch.branch_id} identity does not match conflict_key`);
    }
  }

  if (adjudication.status === 'resolved') {
    if (adjudication.selected_branch_id === null) problems.push('resolved adjudication must select a branch');
    else if (!branchIds.has(adjudication.selected_branch_id)) problems.push(`selected_branch_id ${adjudication.selected_branch_id} is not in the branch set`);
    if (adjudication.resolution_reason === null) problems.push('resolved adjudication must carry a resolution_reason');
  } else {
    if (adjudication.selected_branch_id !== null) problems.push('unresolved adjudication cannot select a branch');
    if (adjudication.resolution_reason !== null) problems.push('unresolved adjudication cannot carry a resolution_reason');
  }
  return problems;
}

/** Fail-closed adjudication completeness assertion. */
export function assertAdjudicationComplete(adjudication: MwhaAdjudication, branches?: readonly MwhaBranch[]): void {
  const problems = adjudicationProblems(adjudication, branches);
  if (problems.length > 0) {
    throw new HaProtocolError('ADJUDICATION_INCOMPLETE', `adjudication is incomplete or inconsistent: ${problems.join('; ')}`);
  }
}

// ---------------------------------------------------------------------------
// Projection / Gate boundary (pure)
// ---------------------------------------------------------------------------

/** Null when a projection state respects the Gate boundary; else the reason. */
export function gateEvidenceIssue(state: MwhaProjectionState): string | null {
  if (state.status === 'committed') {
    if (state.evidence_id === null) return 'committed state must carry an evidence_id';
    if (state.produces_gate_evidence !== true) return 'committed state must set produces_gate_evidence=true';
    return null;
  }
  if (state.evidence_id !== null) return `${state.status} state cannot carry an evidence_id (uncommitted/conflicted branches never enter Gate)`;
  if (state.produces_gate_evidence !== false) return `${state.status} state cannot produce Gate evidence`;
  return null;
}

/** Fail-closed Gate-boundary assertion. */
export function assertGateBoundary(state: MwhaProjectionState): void {
  const issue = gateEvidenceIssue(state);
  if (issue !== null) throw new HaProtocolError('PROJECTION_GATE_FORBIDDEN', issue);
}

// ---------------------------------------------------------------------------
// Clock diagnosis (pure, diagnostic only)
// ---------------------------------------------------------------------------

function assertClockPolicy(policy: MwhaClockPolicy): void {
  for (const [name, value] of [
    ['skewToleranceMs', policy.skewToleranceMs],
    ['futureToleranceMs', policy.futureToleranceMs],
    ['jumpThresholdMs', policy.jumpThresholdMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new HaProtocolError('CLOCK_OBSERVATION_INVALID', `${name} must be a nonnegative integer, got ${String(value)}`);
    }
  }
}

/**
 * Classify one clock observation into rollback / jump / future / skew /
 * normal / unknown. The result is a diagnostic marker only: it carries
 * `diagnostic_only=true` and never influences commit order or fact versions.
 * Precedence is fixed so repeated observations classify identically.
 */
export function classifyClockObservation(
  observation: MwhaClockObservation,
  policy: MwhaClockPolicy = MWHA_CLOCK_DEFAULT_POLICY,
): MwhaClockDiagnosis {
  if (!mwhaClockObservationSchema.safeParse(observation).success) {
    throw new HaProtocolError('CLOCK_OBSERVATION_INVALID', 'clock observation is not a valid mwha clock observation');
  }
  assertClockPolicy(policy);

  const base = {
    member_id: observation.member_id,
    epoch: observation.epoch,
    diagnostic_only: true as const,
    affects_commit_order: false as const,
    affects_fact_version: false as const,
  };

  const { observed_ms, previous_observed_ms, reference_ms } = observation;
  if (previous_observed_ms === null && reference_ms === null) {
    return { ...base, kind: 'unknown', detail: 'no previous or reference clock sample; classification unavailable' };
  }
  if (previous_observed_ms !== null && observed_ms < previous_observed_ms) {
    return { ...base, kind: 'rollback', detail: `observed clock ${String(observed_ms)} moved backwards from ${String(previous_observed_ms)}` };
  }
  const referenceDelta = reference_ms === null ? 0 : Math.abs(observed_ms - reference_ms);
  const previousDelta = previous_observed_ms === null ? 0 : Math.abs(observed_ms - previous_observed_ms);
  if (referenceDelta > policy.jumpThresholdMs || previousDelta > policy.jumpThresholdMs) {
    return { ...base, kind: 'jump', detail: `clock discontinuity exceeds jump threshold ${String(policy.jumpThresholdMs)}ms` };
  }
  if (reference_ms !== null && observed_ms > reference_ms + policy.futureToleranceMs) {
    return { ...base, kind: 'future', detail: `observed clock ${String(observed_ms)} is more than ${String(policy.futureToleranceMs)}ms ahead of reference ${String(reference_ms)}` };
  }
  if (reference_ms !== null && referenceDelta > policy.skewToleranceMs) {
    return { ...base, kind: 'skew', detail: `clock skew ${String(referenceDelta)}ms exceeds tolerance ${String(policy.skewToleranceMs)}ms` };
  }
  return { ...base, kind: 'normal', detail: 'clock observation is within the configured tolerances' };
}
