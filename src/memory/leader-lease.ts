import { z } from 'zod';
import {
  HaProtocolError,
  MWHA_CLOCK_DEFAULT_POLICY,
  classifyClockObservation,
  compareLogicalVersion,
  contentKey,
  detectMultipleLeaders,
  evaluateFence,
  idempotencyKey,
  isQuorum,
  mwhaEventIdentitySchema,
  mwhaLeaderLeaseSchema,
  votingMemberCount,
  type MwhaClockDiagnosis,
  type MwhaEventIdentity,
  type MwhaLeaderLease,
  type MwhaLogicalVersion,
  type MwhaMember,
  type MwhaMultipleLeader,
} from './ha-protocol.ts';
import {
  assertSingleLeader,
  compareCommitRecords,
  compareDeclarations,
  declarationKey,
  logicalVersionOf,
  parseOrThrow,
  positiveInt,
  validateTopology,
  validateVoters,
} from './leader-state.ts';

export { assertSingleLeader } from './leader-state.ts';

/**
 * T-136 / ADR-012 §5: majority leader lease, term/epoch fencing, failover and
 * old-leader isolation/rejoin semantics.
 *
 * Scope (explicit, do not overclaim):
 * - this module implements the *in-process / abstract-RPC* lease and fencing
 *   semantics only. It opens no socket, binds no port and reads no secret;
 * - {@link VoterRpc} is the single communication seam. {@link InMemoryVoterRpc}
 *   is the deterministic test/cluster implementation; {@link TcpVoterRpcAdapter}
 *   is a compile-time adapter shape for T-139's real local-TCP wiring, which
 *   owns frame kinds and transport registration;
 * - physical three-machine clusters, OS-level partitions, cross-host clock
 *   rollback, production HA failover and availability SLAs are NOT verified
 *   here (see MWHA_UNVERIFIED_CAPABILITIES / MWHA_VERIFICATION_SCOPE).
 *
 * Invariants enforced:
 * 1. quorum is always derived as floor(N/2)+1 from the voting members; an
 *    arbitrary threshold cannot be configured;
 * 2. no majority -> never elected, never commit;
 * 3. at most one leader per (epoch, term): `detectMultipleLeaders` is applied
 *    to every observed declaration and a same-term rival is refused;
 * 4. stale-term / old-epoch / same-term-rival writes are rejected with the
 *    frozen ha-protocol fencing codes;
 * 5. a new leader commits only after a majority confirms a strictly newer
 *    term (and a strictly newer epoch in this implementation);
 * 6. a leader whose lease expires stops committing immediately on the next
 *    local check, without waiting for any network confirmation;
 * 7. a reconnected old leader demotes itself, adopts the newer epoch and can
 *    only catch up; it can never overwrite the new leader;
 * 8. epoch never decreases.
 *
 * Clock discipline: the injectable {@link LeaderLeaseManagerOptions.now} is
 * used ONLY for the lease expiry mechanism and clock diagnostics. Version
 * ordering never reads it; commits are ordered by `compareLogicalVersion`.
 */

// ---------------------------------------------------------------------------
// Constants and vocabularies
// ---------------------------------------------------------------------------

/** Snapshot/observation schema version for this module. */
export const MWHA_LEADER_LEASE_SCHEMA_VERSION = 'mwha.leader-lease.v1';
/** Vote request envelope version. */
export const MWHA_VOTE_REQUEST_SCHEMA_VERSION = 'mwha.vote-request.v1';
/** Vote response envelope version. */
export const MWHA_VOTE_RESPONSE_SCHEMA_VERSION = 'mwha.vote-response.v1';
/** Heartbeat request envelope version. */
export const MWHA_HEARTBEAT_REQUEST_SCHEMA_VERSION = 'mwha.heartbeat-request.v1';
/** Heartbeat response envelope version. */
export const MWHA_HEARTBEAT_RESPONSE_SCHEMA_VERSION = 'mwha.heartbeat-response.v1';

/** Default lease duration; tests inject short values and a manual clock. */
export const LEADER_LEASE_DEFAULT_DURATION_MS = 5_000;
/** Default per-voter RPC budget for one heartbeat. */
export const LEADER_LEASE_DEFAULT_HEARTBEAT_TIMEOUT_MS = 5_000;
/** Bound of the in-memory transition log. */
export const LEADER_LEASE_MAX_TRANSITIONS = 256;
/**
 * Bound of retained leader declarations. A forged `(epoch, term)` flood over a
 * voter channel must not grow memory without limit. Pruning keeps the newest
 * declarations; a detected multi-leader conflict is never dropped while any
 * single-leader history can be evicted instead, and the local fencing baseline
 * is always retained.
 */
const LEADER_LEASE_MAX_DECLARATIONS = 256;

export const leaderLeaseRoles = ['follower', 'leader'] as const;
export type LeaderLeaseRole = (typeof leaderLeaseRoles)[number];

export const leaderStepDownReasons = [
  'LEASE_EXPIRED',
  'HEARTBEAT_QUORUM_LOST',
  'NEWER_TERM',
  'NEWER_EPOCH_OR_TERM',
  'SPLIT_BRAIN',
  'REJOIN_NEWER_EPOCH',
  'MANUAL',
] as const;
export type LeaderStepDownReason = (typeof leaderStepDownReasons)[number];

export const leaderLeaseTransitionKinds = [
  'elected',
  'election-lost',
  'step-down',
  'lease-adopted',
  'lease-observed',
  'lease-refreshed',
  'renewed',
  'rejoined',
  'split-brain-detected',
  'commit',
] as const;
export type LeaderLeaseTransitionKind = (typeof leaderLeaseTransitionKinds)[number];

export const leaderLeaseRenewReasons = [
  'RENEWED',
  'NOT_LEADER',
  'LEASE_EXPIRED',
  'NEWER_LEADER',
  'QUORUM_LOST',
] as const;
export type LeaderLeaseRenewReason = (typeof leaderLeaseRenewReasons)[number];

// ---------------------------------------------------------------------------
// Strict wire schemas (fail closed)
// ---------------------------------------------------------------------------

const MEMBER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const uintSchema = z.number().int().min(0);
const memberIdSchema = z.string().regex(MEMBER_ID_PATTERN, 'expected a bounded member identifier');
const detailSchema = z.string().min(1).max(500);

/** Candidate request. `epoch`/`term` are the candidate's proposed values. */
export const mwhaVoteRequestSchema = z.object({
  schema_version: z.literal(MWHA_VOTE_REQUEST_SCHEMA_VERSION),
  term: uintSchema,
  epoch: uintSchema,
  candidate_id: memberIdSchema,
}).strict();
export type VoteRequest = z.infer<typeof mwhaVoteRequestSchema>;

/** Voter decision plus the voter's current fencing view. */
export const mwhaVoteResponseSchema = z.object({
  schema_version: z.literal(MWHA_VOTE_RESPONSE_SCHEMA_VERSION),
  granted: z.boolean(),
  term: uintSchema,
  epoch: uintSchema,
  voter_id: memberIdSchema,
  leader_id: memberIdSchema.nullable(),
  detail: detailSchema,
}).strict();
export type VoteResponse = z.infer<typeof mwhaVoteResponseSchema>;

/** Leader liveness/lease claim. The lease itself is the frozen contract type. */
export const mwhaHeartbeatRequestSchema = z.object({
  schema_version: z.literal(MWHA_HEARTBEAT_REQUEST_SCHEMA_VERSION),
  lease: mwhaLeaderLeaseSchema,
}).strict();
export type HeartbeatRequest = z.infer<typeof mwhaHeartbeatRequestSchema>;

/** Receiver's decision plus its current view (used for adoption/rejoin). */
export const mwhaHeartbeatResponseSchema = z.object({
  schema_version: z.literal(MWHA_HEARTBEAT_RESPONSE_SCHEMA_VERSION),
  accepted: z.boolean(),
  term: uintSchema,
  epoch: uintSchema,
  voter_id: memberIdSchema,
  leader_id: memberIdSchema.nullable(),
  detail: detailSchema,
}).strict();
export type HeartbeatResponse = z.infer<typeof mwhaHeartbeatResponseSchema>;

/** Read-only observable snapshot (wall-clock fields are diagnostics only). */
export const leaderLeaseSnapshotSchema = z.object({
  schema_version: z.literal(MWHA_LEADER_LEASE_SCHEMA_VERSION),
  member_id: memberIdSchema,
  role: z.enum(leaderLeaseRoles),
  voting_count: uintSchema,
  quorum_size: uintSchema,
  epoch: uintSchema,
  term: uintSchema,
  leader: mwhaLeaderLeaseSchema.nullable(),
  lease_expires_at_ms: z.number().int().nullable(),
  lease_expired: z.boolean(),
  voted_for_term: uintSchema.nullable(),
  committed_count: uintSchema,
  max_commit_index: uintSchema,
  split_brain_count: uintSchema,
  last_step_down_reason: z.string().nullable(),
}).strict();
export type LeaderLeaseSnapshot = z.infer<typeof leaderLeaseSnapshotSchema>;

// ---------------------------------------------------------------------------
// Public value types
// ---------------------------------------------------------------------------

/** Outbound channel to exactly one remote voter. */
export interface VoterRpc {
  readonly target_id: string;
  requestVote(request: VoteRequest): Promise<VoteResponse> | VoteResponse;
  sendHeartbeat(request: HeartbeatRequest): Promise<HeartbeatResponse> | HeartbeatResponse;
}

/** One commit attempt. `commit_index` omitted means "next local index". */
export interface LeaderLeaseCommitAttempt extends MwhaEventIdentity {
  readonly commit_index?: number;
}

export interface LeaderLeaseCommitGrant {
  readonly allowed: true;
  readonly lease: MwhaLeaderLease;
  readonly commit_index: number;
  readonly version: MwhaLogicalVersion;
  readonly committed_count: number;
}

/** Retained commit record (also used as the rejoin catch-up unit). */
export interface LeaderLeaseCommitRecord {
  readonly identity: MwhaEventIdentity;
  readonly commit_index: number;
  readonly leader: MwhaLeaderLease;
  readonly version: MwhaLogicalVersion;
}

export interface LeaderLeaseElectionResult {
  readonly won: boolean;
  readonly term: number;
  readonly epoch: number;
  readonly votes: number;
  readonly quorum_size: number;
  readonly granted_by: readonly string[];
  readonly denied_by: readonly string[];
  readonly unreachable: readonly string[];
  readonly lease: MwhaLeaderLease | null;
}

export interface LeaderLeaseRenewResult {
  readonly renewed: boolean;
  readonly reason: LeaderLeaseRenewReason;
  readonly acks: number;
  readonly quorum_size: number;
  readonly lease: MwhaLeaderLease | null;
  readonly lease_expires_at_ms: number | null;
}

export interface LeaderLeaseStateView {
  readonly role: LeaderLeaseRole;
  readonly epoch: number;
  readonly term: number;
  readonly leader_id: string | null;
}

export interface LeaderLeaseTransition {
  readonly sequence: number;
  readonly kind: LeaderLeaseTransitionKind;
  readonly detail: string;
  readonly from: LeaderLeaseStateView;
  readonly to: LeaderLeaseStateView;
}

export interface PeerLeaseView {
  readonly member_id: string;
  readonly epoch: number;
  readonly term: number;
  readonly leader_id: string | null;
}

export interface LeaderLeaseRejoinOptions {
  /**
   * Fetch committed records from the winning peer. T-139 wires this to log
   * replication; omitting it performs lease/epoch adoption only.
   */
  readonly fetchCommitted?: (
    peer: PeerLeaseView,
  ) => Promise<readonly LeaderLeaseCommitRecord[]> | readonly LeaderLeaseCommitRecord[];
  /** Apply fetched records to local state. Defaults to a read-only merge. */
  readonly apply?: (
    records: readonly LeaderLeaseCommitRecord[],
    peer: PeerLeaseView,
  ) => Promise<void> | void;
}

export interface LeaderLeaseRejoinReport {
  readonly rejoined: boolean;
  readonly previous_epoch: number;
  readonly adopted_epoch: number;
  readonly previous_term: number;
  readonly adopted_term: number;
  readonly adopted_leader_id: string | null;
  readonly records_seen: number;
  readonly records_applied: number;
  readonly caught_up: boolean;
}

export interface LeaderLeaseObservation {
  readonly action: 'adopted' | 'refreshed' | 'ignored-stale' | 'split-brain' | 'unchanged';
  readonly adopted: boolean;
  readonly code: string;
  readonly lease: MwhaLeaderLease | null;
  readonly detail: string;
}

export interface LeaderLeaseManagerOptions {
  readonly member_id: string;
  /** Full topology; quorum is derived from the voting participants. */
  readonly members: readonly MwhaMember[];
  /** One outbound channel per *remote* voting member. */
  readonly voters: readonly VoterRpc[];
  /** Injectable clock; default `Date.now`. Lease expiry/diagnostics only. */
  readonly now?: () => number;
  readonly leaseDurationMs?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly onStateChange?: (snapshot: LeaderLeaseSnapshot) => void;
}

// ---------------------------------------------------------------------------
// Leader lease manager
// ---------------------------------------------------------------------------

/**
 * One node's lease/fencing state machine.
 *
 * Not a transport: all remote effects go through {@link VoterRpc}. No timers
 * are started; lease expiry is evaluated lazily against the injected clock so
 * tests never wait on real time.
 */
export class LeaderLeaseManager {
  readonly #memberId: string;
  readonly #members: readonly MwhaMember[];
  readonly #votingMembers: readonly MwhaMember[];
  readonly #voters: readonly VoterRpc[];
  readonly #quorumSize: number;
  readonly #votingCount: number;
  readonly #leaseDurationMs: number;
  readonly #heartbeatTimeoutMs: number;
  readonly #now: () => number;
  readonly #onStateChange?: (snapshot: LeaderLeaseSnapshot) => void;

  #role: LeaderLeaseRole = 'follower';
  #epoch = 0;
  #term = 0;
  /** Fencing baseline (highest accepted lease). */
  #leader: MwhaLeaderLease | null = null;
  /** Local lease authority expiry, injected-clock milliseconds. */
  #leaseExpiresAtMs: number | null = null;
  #lastRenewAtMs: number | null = null;
  #lastStepDownReason: LeaderStepDownReason | null = null;
  readonly #votedByTerm = new Map<number, string>();
  readonly #declarations = new Map<string, MwhaLeaderLease>();
  readonly #committed: LeaderLeaseCommitRecord[] = [];
  readonly #committedByContentKey = new Map<string, LeaderLeaseCommitRecord>();
  #maxCommitIndex = 0;
  readonly #transitions: LeaderLeaseTransition[] = [];

  constructor(options: LeaderLeaseManagerOptions) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new HaProtocolError('TOPOLOGY_INVALID', 'leader lease options must be an object');
    }
    if (typeof options.member_id !== 'string' || !MEMBER_ID_PATTERN.test(options.member_id)) {
      throw new HaProtocolError('TOPOLOGY_INVALID', 'member_id must be a bounded identifier');
    }
    const topology = validateTopology(options.members);
    const votingMembers = topology.members.filter((member) => member.role !== 'observer');
    if (!votingMembers.some((member) => member.member_id === options.member_id)) {
      throw new HaProtocolError('TOPOLOGY_INVALID', `member ${options.member_id} must be a voting participant`);
    }
    if (typeof options.now !== 'undefined' && typeof options.now !== 'function') {
      throw new HaProtocolError('HA_INPUT_INVALID', 'now must be a function when provided');
    }

    this.#memberId = options.member_id;
    this.#members = topology.members;
    this.#votingMembers = votingMembers;
    this.#voters = validateVoters(options.voters, votingMembers, options.member_id);
    this.#quorumSize = topology.quorum_size;
    this.#votingCount = votingMemberCount(topology.members);
    this.#leaseDurationMs = positiveInt(options.leaseDurationMs, LEADER_LEASE_DEFAULT_DURATION_MS, 'leaseDurationMs');
    this.#heartbeatTimeoutMs = positiveInt(options.heartbeatTimeoutMs, LEADER_LEASE_DEFAULT_HEARTBEAT_TIMEOUT_MS, 'heartbeatTimeoutMs');
    this.#now = options.now ?? Date.now;
    if (typeof options.onStateChange === 'function') this.#onStateChange = options.onStateChange;
  }

  get memberId(): string {
    return this.#memberId;
  }

  /** Wire-facing member identifier; makes a manager a {@link VoterRpcTarget}. */
  get member_id(): string {
    return this.#memberId;
  }

  get members(): readonly MwhaMember[] {
    return [...this.#members];
  }

  get votingCount(): number {
    return this.#votingCount;
  }

  get quorumSize(): number {
    return this.#quorumSize;
  }

  get role(): LeaderLeaseRole {
    return this.#role;
  }

  get epoch(): number {
    return this.#epoch;
  }

  get term(): number {
    return this.#term;
  }

  get leaderId(): string | null {
    return this.#leader?.leader_id ?? null;
  }

  /** Current fencing baseline (also the held lease while leader). */
  get currentLease(): MwhaLeaderLease | null {
    return this.#leader;
  }

  get leaseExpiresAtMs(): number | null {
    return this.#leaseExpiresAtMs;
  }

  get committedCount(): number {
    return this.#committed.length;
  }

  isLeader(): boolean {
    return this.#role === 'leader';
  }

  isLeaseExpired(): boolean {
    return this.#leaseExpiresAtMs !== null && this.#now() >= this.#leaseExpiresAtMs;
  }

  /** Read-only observable snapshot. */
  snapshot(): LeaderLeaseSnapshot {
    return parseOrThrow(leaderLeaseSnapshotSchema, {
      schema_version: MWHA_LEADER_LEASE_SCHEMA_VERSION,
      member_id: this.#memberId,
      role: this.#role,
      voting_count: this.#votingCount,
      quorum_size: this.#quorumSize,
      epoch: this.#epoch,
      term: this.#term,
      leader: this.#leader,
      lease_expires_at_ms: this.#leaseExpiresAtMs,
      lease_expired: this.isLeaseExpired(),
      voted_for_term: this.#votedByTerm.has(this.#term) ? this.#term : null,
      committed_count: this.#committed.length,
      max_commit_index: this.#maxCommitIndex,
      split_brain_count: this.detectSplitBrain().length,
      last_step_down_reason: this.#lastStepDownReason,
    }, 'leader-lease-snapshot');
  }

  /** Every retained commit, ordered by logical version (never by wall clock). */
  committedRecords(): readonly LeaderLeaseCommitRecord[] {
    return this.#sortedCommitted();
  }

  transitions(): readonly LeaderLeaseTransition[] {
    return this.#transitions.map((transition) => ({
      ...transition,
      from: { ...transition.from },
      to: { ...transition.to },
    }));
  }

  /** Collected leader declarations (own lease plus every observed lease). */
  collectDeclarations(): readonly MwhaLeaderLease[] {
    return [...this.#declarations.values()].sort(compareDeclarations);
  }

  /** Same-(epoch,term) multiple-leader conflicts visible to this node. */
  detectSplitBrain(): readonly MwhaMultipleLeader[] {
    return detectMultipleLeaders(this.collectDeclarations());
  }

  /**
   * Diagnose a local clock sample. Purely diagnostic: the result never feeds
   * version ordering or fencing decisions.
   */
  diagnoseClock(observedMs: number, previousObservedMs: number | null): MwhaClockDiagnosis {
    return classifyClockObservation(
      {
        member_id: this.#memberId,
        epoch: this.#epoch,
        observed_ms: observedMs,
        previous_observed_ms: previousObservedMs,
        reference_ms: null,
      },
      MWHA_CLOCK_DEFAULT_POLICY,
    );
  }

  // -- election -----------------------------------------------------------

  /**
   * Campaign for a strictly newer `(epoch, term)`. The candidate always votes
   * for itself; it becomes leader only with a derived majority. A lost
   * election still advances the local term so an old leader can never win
   * with a stale term.
   */
  async requestVote(): Promise<LeaderLeaseElectionResult> {
    const candidateTerm = this.#term + 1;
    const candidateEpoch = this.#epoch + 1;
    const request: VoteRequest = {
      schema_version: MWHA_VOTE_REQUEST_SCHEMA_VERSION,
      term: candidateTerm,
      epoch: candidateEpoch,
      candidate_id: this.#memberId,
    };

    const from = this.#stateView();
    this.#term = candidateTerm;
    this.#forgetStaleTerms(candidateTerm);
    this.#votedByTerm.set(candidateTerm, this.#memberId);
    this.#recordDeclaration({ term: candidateTerm, leader_id: this.#memberId, epoch: candidateEpoch });

    const grantedBy: string[] = [];
    const deniedBy: string[] = [];
    const unreachable: string[] = [];
    const outcomes = await Promise.allSettled(
      this.#voters.map(async (voter) => {
        try {
          const response = await voter.requestVote(request);
          return { voter_id: voter.target_id, response: parseOrThrow(mwhaVoteResponseSchema, response, 'vote response') };
        } catch (error) {
          return { voter_id: voter.target_id, response: null as VoteResponse | null, error };
        }
      }),
    );
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        unreachable.push('unknown');
        continue;
      }
      const value = outcome.value;
      if (value.response === null) {
        unreachable.push(value.voter_id);
        continue;
      }
      if (value.response.granted) grantedBy.push(value.voter_id);
      else deniedBy.push(value.voter_id);
    }

    const votes = 1 + grantedBy.length;
    const won = isQuorum(votes, this.#votingCount);
    if (!won) {
      this.#logTransition('election-lost', `${String(votes)}/${String(this.#votingCount)} votes are below quorum ${String(this.#quorumSize)}`, from);
      return {
        won: false,
        term: candidateTerm,
        epoch: this.#epoch,
        votes,
        quorum_size: this.#quorumSize,
        granted_by: grantedBy.sort(),
        denied_by: deniedBy.sort(),
        unreachable: unreachable.sort(),
        lease: null,
      };
    }

    this.#epoch = candidateEpoch;
    const lease: MwhaLeaderLease = { term: candidateTerm, leader_id: this.#memberId, epoch: candidateEpoch };
    this.#leader = lease;
    this.#role = 'leader';
    this.#leaseExpiresAtMs = this.#now() + this.#leaseDurationMs;
    this.#lastRenewAtMs = this.#now();
    this.#recordDeclaration(lease);
    this.#logTransition('elected', `won term ${String(candidateTerm)} epoch ${String(candidateEpoch)} with ${String(votes)} vote(s)`, from);
    return {
      won: true,
      term: candidateTerm,
      epoch: candidateEpoch,
      votes,
      quorum_size: this.#quorumSize,
      granted_by: grantedBy.sort(),
      denied_by: deniedBy.sort(),
      unreachable: unreachable.sort(),
      lease,
    };
  }

  /** Inbound vote request. Malformed input throws; refusals are responses. */
  handleVoteRequest(raw: unknown): VoteResponse {
    const request = parseOrThrow(mwhaVoteRequestSchema, raw, 'vote request');
    // Annotated so `schema_version` keeps its literal type; an unannotated
    // object literal widens the constant to `string` and fails the frozen
    // response contract.
    const base: Pick<VoteResponse, 'schema_version' | 'term' | 'epoch' | 'voter_id' | 'leader_id'> = {
      schema_version: MWHA_VOTE_RESPONSE_SCHEMA_VERSION,
      term: this.#term,
      epoch: this.#epoch,
      voter_id: this.#memberId,
      leader_id: this.#leader?.leader_id ?? null,
    };

    if (request.candidate_id === this.#memberId) {
      return { ...base, granted: true, detail: 'self vote' };
    }
    if (request.epoch < this.#epoch) {
      return { ...base, granted: false, detail: `candidate epoch ${String(request.epoch)} rolls back current epoch ${String(this.#epoch)}` };
    }
    if (request.term < this.#term) {
      return { ...base, granted: false, detail: `candidate term ${String(request.term)} is older than current term ${String(this.#term)}` };
    }
    if (request.term === this.#term) {
      const voted = this.#votedByTerm.get(request.term);
      if (voted === request.candidate_id) {
        return { ...base, granted: true, detail: 'repeat vote for the same candidate is idempotent' };
      }
      return { ...base, granted: false, detail: `term ${String(request.term)} already has a candidate; a same-term rival is illegal` };
    }

    const from = this.#stateView();
    this.#term = request.term;
    if (request.epoch > this.#epoch) this.#epoch = request.epoch;
    this.#forgetStaleTerms(request.term);
    this.#votedByTerm.set(request.term, request.candidate_id);
    this.#recordDeclaration({ term: request.term, leader_id: request.candidate_id, epoch: request.epoch });
    if (this.#role === 'leader') this.#stepDownInternal('NEWER_TERM', from);
    return {
      ...base,
      term: this.#term,
      epoch: this.#epoch,
      granted: true,
      detail: `granted term ${String(request.term)} to ${request.candidate_id}`,
    };
  }

  // -- heartbeat / renewal -----------------------------------------------

  /**
   * Renew the local lease. Requires a majority of accepted heartbeats
   * (self counts as one). Any peer view newer than the local one wins and this
   * node steps down instead of renewing.
   */
  async renewLease(): Promise<LeaderLeaseRenewResult> {
    const lease = this.#leader;
    if (this.#role !== 'leader' || lease === null) {
      return {
        renewed: false,
        reason: 'NOT_LEADER',
        acks: 0,
        quorum_size: this.#quorumSize,
        lease: null,
        lease_expires_at_ms: null,
      };
    }
    if (this.isLeaseExpired()) {
      const from = this.#stateView();
      this.#stepDownInternal('LEASE_EXPIRED', from);
      return {
        renewed: false,
        reason: 'LEASE_EXPIRED',
        acks: 0,
        quorum_size: this.#quorumSize,
        lease: this.#leader,
        lease_expires_at_ms: null,
      };
    }

    const request: HeartbeatRequest = {
      schema_version: MWHA_HEARTBEAT_REQUEST_SCHEMA_VERSION,
      lease,
    };
    const outcomes = await Promise.allSettled(
      this.#voters.map(async (voter) => {
        try {
          const response = await voter.sendHeartbeat(request);
          return { voter_id: voter.target_id, response: parseOrThrow(mwhaHeartbeatResponseSchema, response, 'heartbeat response') };
        } catch {
          return { voter_id: voter.target_id, response: null as HeartbeatResponse | null };
        }
      }),
    );

    let acks = 1;
    let newerView: PeerLeaseView | null = null;
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') continue;
      const value = outcome.value;
      if (value.response === null) continue;
      const view: PeerLeaseView = {
        member_id: value.voter_id,
        epoch: value.response.epoch,
        term: value.response.term,
        leader_id: value.response.leader_id,
      };
      if (
        newerView === null
        || view.epoch > newerView.epoch
        || (view.epoch === newerView.epoch && view.term > newerView.term)
      ) {
        newerView = view;
      }
      if (
        value.response.accepted
        && value.response.leader_id === this.#memberId
        && value.response.term === lease.term
        && value.response.epoch === lease.epoch
      ) {
        acks += 1;
      }
    }

    if (
      newerView !== null
      && (newerView.epoch > this.#epoch || (newerView.epoch === this.#epoch && newerView.term > this.#term))
    ) {
      const from = this.#stateView();
      if (newerView.leader_id !== null) {
        this.#epoch = newerView.epoch;
        this.#term = newerView.term;
        this.#leader = { term: newerView.term, leader_id: newerView.leader_id, epoch: newerView.epoch };
        this.#recordDeclaration(this.#leader);
      }
      this.#stepDownInternal('NEWER_EPOCH_OR_TERM', from);
      return {
        renewed: false,
        reason: 'NEWER_LEADER',
        acks,
        quorum_size: this.#quorumSize,
        lease: this.#leader,
        lease_expires_at_ms: null,
      };
    }

    if (!isQuorum(acks, this.#votingCount)) {
      const from = this.#stateView();
      this.#stepDownInternal('HEARTBEAT_QUORUM_LOST', from);
      return {
        renewed: false,
        reason: 'QUORUM_LOST',
        acks,
        quorum_size: this.#quorumSize,
        lease: this.#leader,
        lease_expires_at_ms: null,
      };
    }

    const from = this.#stateView();
    this.#leaseExpiresAtMs = this.#now() + this.#leaseDurationMs;
    this.#lastRenewAtMs = this.#now();
    this.#logTransition('renewed', `lease renewed with ${String(acks)}/${String(this.#votingCount)} ack(s)`, from);
    return {
      renewed: true,
      reason: 'RENEWED',
      acks,
      quorum_size: this.#quorumSize,
      lease: this.#leader,
      lease_expires_at_ms: this.#leaseExpiresAtMs,
    };
  }

  /** Inbound heartbeat. Refusals are responses; malformed input throws. */
  handleHeartbeat(raw: unknown): HeartbeatResponse {
    const request = parseOrThrow(mwhaHeartbeatRequestSchema, raw, 'heartbeat request');
    const lease = request.lease;
    // Annotated for the same literal-preservation reason as vote responses.
    const base: Pick<HeartbeatResponse, 'schema_version' | 'term' | 'epoch' | 'voter_id' | 'leader_id'> = {
      schema_version: MWHA_HEARTBEAT_RESPONSE_SCHEMA_VERSION,
      term: this.#term,
      epoch: this.#epoch,
      voter_id: this.#memberId,
      leader_id: this.#leader?.leader_id ?? null,
    };

    if (lease.leader_id === this.#memberId) {
      return { ...base, accepted: true, detail: 'self heartbeat' };
    }
    if (lease.epoch < this.#epoch) {
      return { ...base, accepted: false, detail: `lease epoch ${String(lease.epoch)} rolls back current epoch ${String(this.#epoch)}` };
    }
    if (lease.epoch > this.#epoch || (lease.epoch === this.#epoch && lease.term > this.#term)) {
      const from = this.#stateView();
      this.#epoch = lease.epoch;
      this.#term = lease.term;
      this.#leader = lease;
      this.#recordDeclaration(lease);
      this.#logTransition('lease-adopted', `adopted lease term ${String(lease.term)} epoch ${String(lease.epoch)} from ${lease.leader_id}`, from);
      if (this.#role === 'leader') this.#stepDownInternal('NEWER_EPOCH_OR_TERM', from);
      return { ...base, term: this.#term, epoch: this.#epoch, leader_id: this.#leader?.leader_id ?? null, accepted: true, detail: 'adopted a newer lease' };
    }
    if (lease.epoch === this.#epoch && lease.term === this.#term) {
      if (this.#leader !== null && this.#leader.leader_id !== lease.leader_id) {
        this.#recordDeclaration(lease);
        const conflicts = this.detectSplitBrain();
        return {
          ...base,
          accepted: false,
          detail: `term ${String(lease.term)} already belongs to ${this.#leader.leader_id}; rival ${lease.leader_id} is illegal (${String(conflicts.length)} conflict(s))`,
        };
      }
      const from = this.#stateView();
      this.#leader = lease;
      this.#recordDeclaration(lease);
      this.#logTransition('lease-refreshed', `refreshed lease for term ${String(lease.term)} from ${lease.leader_id}`, from);
      // Report the post-refresh leader: a voter that granted the term may not
      // have held a leader before, and the leader needs this field to count
      // the heartbeat as an ack.
      return { ...base, leader_id: lease.leader_id, accepted: true, detail: 'lease refreshed' };
    }
    return { ...base, accepted: false, detail: `lease term ${String(lease.term)} is older than current term ${String(this.#term)}` };
  }

  // -- observation / fencing ---------------------------------------------

  /**
   * Observe a lease declaration (gossip / replica sync). A newer lease is
   * adopted; a stale one is ignored; a same-(epoch,term) rival is recorded as
   * a split-brain conflict and never adopted.
   */
  observeLease(raw: unknown): LeaderLeaseObservation {
    const candidate = parseOrThrow(mwhaLeaderLeaseSchema, raw, 'observed lease');
    if (
      this.#leader !== null
      && candidate.epoch === this.#epoch
      && candidate.term === this.#term
      && candidate.leader_id === this.#leader.leader_id
    ) {
      return {
        action: 'unchanged',
        adopted: false,
        code: 'FENCE_OK',
        lease: this.#leader,
        detail: 'observed lease matches the current lease',
      };
    }

    const fence = this.#leader === null
      ? { allowed: true as const, code: 'FENCE_OK' as const, detail: 'no current lease' }
      : evaluateFence(this.#leader, candidate);
    if (!fence.allowed) {
      if (fence.code === 'FENCE_SPLIT_BRAIN_SAME_TERM') {
        this.#recordDeclaration(candidate);
        this.#logTransition('split-brain-detected', fence.detail, this.#stateView());
        return {
          action: 'split-brain',
          adopted: false,
          code: fence.code,
          lease: this.#leader,
          detail: fence.detail,
        };
      }
      return { action: 'ignored-stale', adopted: false, code: fence.code, lease: this.#leader, detail: fence.detail };
    }

    const from = this.#stateView();
    const newer = candidate.epoch > this.#epoch || (candidate.epoch === this.#epoch && candidate.term > this.#term);
    if (!newer) {
      return { action: 'refreshed', adopted: false, code: fence.code, lease: this.#leader, detail: fence.detail };
    }
    const wasLeader = this.#role === 'leader';
    this.#epoch = candidate.epoch;
    this.#term = candidate.term;
    this.#leader = candidate;
    this.#recordDeclaration(candidate);
    this.#logTransition('lease-adopted', `adopted observed lease term ${String(candidate.term)} epoch ${String(candidate.epoch)} from ${candidate.leader_id}`, from);
    if (wasLeader) this.#stepDownInternal('NEWER_EPOCH_OR_TERM', from);
    return {
      action: 'adopted',
      adopted: true,
      code: fence.code,
      lease: this.#leader,
      detail: `adopted epoch ${String(candidate.epoch)} term ${String(candidate.term)}`,
    };
  }

  /**
   * Fail-closed commit gate. Throws {@link HaProtocolError} with the frozen
   * ha-protocol codes; never returns a soft failure.
   */
  assertCanCommit(write: LeaderLeaseCommitAttempt): LeaderLeaseCommitGrant {
    const identity = parseOrThrow(mwhaEventIdentitySchema, write, 'commit attempt');

    // Precise fencing codes first: a stale term/epoch is named as such even
    // when this node is no longer leader.
    if (this.#leader !== null) {
      if (identity.epoch < this.#leader.epoch) {
        throw new HaProtocolError('FENCE_EPOCH_ROLLBACK', `write epoch ${String(identity.epoch)} rolls back current epoch ${String(this.#leader.epoch)}`);
      }
      if (identity.epoch === this.#leader.epoch && identity.term < this.#leader.term) {
        throw new HaProtocolError('FENCE_STALE_TERM', `write term ${String(identity.term)} is older than current term ${String(this.#leader.term)}`);
      }
    }

    if (this.#role !== 'leader' || this.#leader === null || this.#leaseExpiresAtMs === null) {
      throw new HaProtocolError('FENCE_REJECTED', `${this.#memberId} is not the active lease holder (role=${this.#role})`);
    }
    const lease = this.#leader;
    if (identity.epoch > lease.epoch) {
      throw new HaProtocolError('FENCE_REJECTED', `write epoch ${String(identity.epoch)} is ahead of the held lease epoch ${String(lease.epoch)}`);
    }
    if (identity.term > lease.term) {
      throw new HaProtocolError('FENCE_REJECTED', `write term ${String(identity.term)} is ahead of the held lease term ${String(lease.term)}`);
    }

    const conflicts = this.detectSplitBrain();
    if (conflicts.length > 0) {
      const summary = conflicts.map((conflict) => `(epoch=${String(conflict.epoch)}, term=${String(conflict.term)})`).join(', ');
      throw new HaProtocolError('SPLIT_BRAIN', `commit refused while multiple leaders are visible: ${summary}`);
    }

    // Local, immediate expiry check: no network confirmation is awaited.
    if (this.isLeaseExpired()) {
      const from = this.#stateView();
      this.#stepDownInternal('LEASE_EXPIRED', from);
      throw new HaProtocolError(
        'QUORUM_NOT_REACHED',
        `lease for term ${String(lease.term)} expired at ${String(this.#leaseExpiresAtMs ?? 0)}ms; commits stop until a majority renews it`,
      );
    }

    const requestedIndex = write.commit_index;
    const commitIndex = requestedIndex === undefined ? this.#maxCommitIndex + 1 : requestedIndex;
    if (!Number.isSafeInteger(commitIndex) || commitIndex < 1) {
      throw new HaProtocolError('HA_INPUT_INVALID', `commit_index must be a positive integer, got ${String(commitIndex)}`);
    }

    const version = logicalVersionOf(identity, commitIndex);
    const record: LeaderLeaseCommitRecord = { identity, commit_index: commitIndex, leader: { ...lease }, version };
    this.#insertCommitted(record);
    const from = this.#stateView();
    this.#logTransition('commit', `committed ${identity.writer_id}/${String(identity.local_seq)} at commit_index ${String(commitIndex)}`, from);
    return {
      allowed: true,
      lease: { ...lease },
      commit_index: commitIndex,
      version,
      committed_count: this.#committed.length,
    };
  }

  /** Demote to follower and drop lease authority. Idempotent. */
  stepDown(reason: LeaderStepDownReason = 'MANUAL'): LeaderLeaseSnapshot {
    const from = this.#stateView();
    this.#stepDownInternal(reason, from);
    return this.snapshot();
  }

  /**
   * Reconnect after isolation/partition. Pings every peer, adopts the newest
   * `(epoch, term)` lease it can see, and optionally catches up committed
   * records. Never overwrites a newer leader: adoption is monotonic and the
   * local role becomes follower.
   */
  async rejoin(options: LeaderLeaseRejoinOptions = {}): Promise<LeaderLeaseRejoinReport> {
    const previousEpoch = this.#epoch;
    const previousTerm = this.#term;
    const probeLease: MwhaLeaderLease = this.#leader ?? { term: this.#term, leader_id: this.#memberId, epoch: this.#epoch };
    const request: HeartbeatRequest = {
      schema_version: MWHA_HEARTBEAT_REQUEST_SCHEMA_VERSION,
      lease: probeLease,
    };
    const outcomes = await Promise.allSettled(
      this.#voters.map(async (voter) => {
        try {
          const response = await voter.sendHeartbeat(request);
          return { voter_id: voter.target_id, response: parseOrThrow(mwhaHeartbeatResponseSchema, response, 'heartbeat response') };
        } catch {
          return { voter_id: voter.target_id, response: null as HeartbeatResponse | null };
        }
      }),
    );

    let best: PeerLeaseView | null = null;
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') continue;
      const value = outcome.value;
      if (value.response === null || value.response.leader_id === null) continue;
      const view: PeerLeaseView = {
        member_id: value.voter_id,
        epoch: value.response.epoch,
        term: value.response.term,
        leader_id: value.response.leader_id,
      };
      if (best === null || view.epoch > best.epoch || (view.epoch === best.epoch && view.term > best.term)) {
        best = view;
      }
    }

    const from = this.#stateView();
    let adopted = false;
    if (
      best !== null
      && best.leader_id !== null
      && (best.epoch > this.#epoch || (best.epoch === this.#epoch && best.term > this.#term))
    ) {
      this.#epoch = best.epoch;
      this.#term = best.term;
      this.#leader = { term: best.term, leader_id: best.leader_id, epoch: best.epoch };
      this.#recordDeclaration(this.#leader);
      this.#role = 'follower';
      this.#leaseExpiresAtMs = null;
      this.#lastStepDownReason = 'REJOIN_NEWER_EPOCH';
      adopted = true;
      this.#logTransition('rejoined', `rejoined at epoch ${String(best.epoch)} term ${String(best.term)} under leader ${best.leader_id}`, from);
    } else {
      this.#logTransition('rejoined', 'rejoined without a newer lease; local fencing view is unchanged', from);
    }

    let recordsSeen = 0;
    let recordsApplied = 0;
    if (best !== null && options.fetchCommitted !== undefined) {
      const records = await options.fetchCommitted(best);
      if (!Array.isArray(records)) {
        throw new HaProtocolError('HA_INPUT_INVALID', 'fetchCommitted must return an array of commit records');
      }
      recordsSeen = records.length;
      if (options.apply !== undefined) {
        await options.apply(records, best);
        recordsApplied = records.length;
      } else {
        recordsApplied = this.#mergeCommitted(records);
      }
    }

    return {
      rejoined: adopted,
      previous_epoch: previousEpoch,
      adopted_epoch: this.#epoch,
      previous_term: previousTerm,
      adopted_term: this.#term,
      adopted_leader_id: adopted ? best?.leader_id ?? null : this.leaderId,
      records_seen: recordsSeen,
      records_applied: recordsApplied,
      caught_up: adopted && recordsSeen === recordsApplied,
    };
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  #stateView(): LeaderLeaseStateView {
    return {
      role: this.#role,
      epoch: this.#epoch,
      term: this.#term,
      leader_id: this.#leader?.leader_id ?? null,
    };
  }

  #stepDownInternal(reason: LeaderStepDownReason, from: LeaderLeaseStateView = this.#stateView()): void {
    if (this.#role !== 'leader' && this.#lastStepDownReason === reason) return;
    const wasLeader = this.#role === 'leader';
    this.#role = 'follower';
    this.#leaseExpiresAtMs = null;
    this.#lastStepDownReason = reason;
    this.#logTransition('step-down', wasLeader ? `stepped down: ${reason}` : `step-down reason recorded: ${reason}`, from);
  }

  #recordDeclaration(lease: MwhaLeaderLease): void {
    this.#declarations.set(declarationKey(lease), { ...lease });
    this.#pruneDeclarations();
  }

  /**
   * Evict the oldest declarations once the table exceeds its bound. Entries in
   * a conflicting `(epoch, term)` group are kept while the group still has more
   * than two leaders (two are enough to keep the split-brain signal visible);
   * single-leader history and the local baseline follow the rules documented on
   * {@link LEADER_LEASE_MAX_DECLARATIONS}. The final pass is the memory-bound
   * backstop for an adversarial flood made only of conflicting groups.
   */
  #pruneDeclarations(): void {
    const limit = LEADER_LEASE_MAX_DECLARATIONS;
    if (this.#declarations.size <= limit) return;
    const groupCounts = new Map<string, number>();
    for (const lease of this.#declarations.values()) {
      const groupKey = `${lease.epoch}\u0000${lease.term}`;
      groupCounts.set(groupKey, (groupCounts.get(groupKey) ?? 0) + 1);
    }
    const localKey = this.#leader === null ? null : declarationKey(this.#leader);
    const sorted = [...this.#declarations.entries()].sort((left, right) => compareDeclarations(left[1], right[1]));
    let excess = this.#declarations.size - limit;
    for (const [key, lease] of sorted) {
      if (excess <= 0) break;
      if (key === localKey) continue;
      const groupKey = `${lease.epoch}\u0000${lease.term}`;
      const count = groupCounts.get(groupKey) ?? 0;
      // Keep two leaders per conflicting group; single-leader history is droppable.
      if (count > 2 || count === 1) {
        this.#declarations.delete(key);
        groupCounts.set(groupKey, count - 1);
        excess -= 1;
      }
    }
    for (const [key] of sorted) {
      if (excess <= 0) break;
      if (key === localKey || !this.#declarations.has(key)) continue;
      this.#declarations.delete(key);
      excess -= 1;
    }
  }

  /** Only the current term's grant is ever consulted; stale terms are dead weight. */
  #forgetStaleTerms(currentTerm: number): void {
    for (const term of this.#votedByTerm.keys()) {
      if (term !== currentTerm) this.#votedByTerm.delete(term);
    }
  }

  #logTransition(kind: LeaderLeaseTransitionKind, detail: string, from: LeaderLeaseStateView): void {
    const to = this.#stateView();
    this.#transitions.push({ sequence: this.#transitions.length + 1, kind, detail, from: { ...from }, to });
    while (this.#transitions.length > LEADER_LEASE_MAX_TRANSITIONS) this.#transitions.shift();
    if (this.#onStateChange !== undefined) {
      try {
        this.#onStateChange(this.snapshot());
      } catch {
        // Observability callbacks must never change protocol behaviour.
      }
    }
  }

  #insertCommitted(record: LeaderLeaseCommitRecord): void {
    const key = contentKey(record.identity);
    if (this.#committedByContentKey.has(key)) return;
    this.#committedByContentKey.set(key, record);
    this.#committed.push(record);
    if (record.commit_index > this.#maxCommitIndex) this.#maxCommitIndex = record.commit_index;
  }

  #mergeCommitted(records: readonly LeaderLeaseCommitRecord[]): number {
    const slots = new Map<string, Set<string>>();
    for (const record of this.#committed) {
      const slot = idempotencyKey(record.identity);
      let hashes = slots.get(slot);
      if (hashes === undefined) {
        hashes = new Set<string>();
        slots.set(slot, hashes);
      }
      hashes.add(record.identity.ledger_event_hash);
    }
    let added = 0;
    for (const record of records) {
      const key = contentKey(record.identity);
      if (this.#committedByContentKey.has(key)) continue;
      const slot = idempotencyKey(record.identity);
      const knownHashes = slots.get(slot);
      if (knownHashes !== undefined && !knownHashes.has(record.identity.ledger_event_hash)) {
        // Conflicting branch at a slot we already hold: retain ours, never
        // overwrite the surviving leader's record.
        continue;
      }
      this.#insertCommitted(record);
      let hashes = slots.get(slot);
      if (hashes === undefined) {
        hashes = new Set<string>();
        slots.set(slot, hashes);
      }
      hashes.add(record.identity.ledger_event_hash);
      added += 1;
    }
    return added;
  }

  #sortedCommitted(): readonly LeaderLeaseCommitRecord[] {
    return [...this.#committed].sort(compareCommitRecords);
  }
}

// ---------------------------------------------------------------------------
// In-memory VoterRpc implementation (deterministic test/cluster seam)
// ---------------------------------------------------------------------------

export interface VoterRpcTarget {
  readonly member_id: string;
  handleVoteRequest(request: unknown): VoteResponse | Promise<VoteResponse>;
  handleHeartbeat(request: unknown): HeartbeatResponse | Promise<HeartbeatResponse>;
}

export interface InMemoryFaultSnapshot {
  readonly partitions: readonly (readonly string[])[];
  readonly isolated: readonly string[];
  readonly delayMs: number;
}

/**
 * Controllable TCP-protocol-layer-style fault seam for the in-memory mesh.
 * This models message reachability only; it is NOT an OS-level partition.
 */
export class InMemoryFaultController {
  readonly #groups = new Map<string, number>();
  readonly #isolated = new Set<string>();
  #delayMs = 0;

  /** Assign members to partitions; members not listed are isolated. */
  partition(groups: readonly (readonly string[])[]): void {
    this.#groups.clear();
    this.#isolated.clear();
    for (const [groupIndex, group] of groups.entries()) {
      if (!Array.isArray(group) || group.length === 0) {
        throw new HaProtocolError('HA_INPUT_INVALID', `partition group ${String(groupIndex)} must be a non-empty array`);
      }
      for (const memberId of group) {
        if (typeof memberId !== 'string' || memberId.length === 0) {
          throw new HaProtocolError('HA_INPUT_INVALID', 'partition members must be non-empty identifiers');
        }
        if (this.#groups.has(memberId)) {
          throw new HaProtocolError('HA_INPUT_INVALID', `member ${memberId} appears in more than one partition`);
        }
        this.#groups.set(memberId, groupIndex);
      }
    }
  }

  /** Block every message to/from one member. */
  isolate(memberId: string): void {
    if (typeof memberId !== 'string' || memberId.length === 0) {
      throw new HaProtocolError('HA_INPUT_INVALID', 'isolated member id must be a non-empty identifier');
    }
    this.#isolated.add(memberId);
  }

  setDelay(ms: number): void {
    if (!Number.isSafeInteger(ms) || ms < 0) {
      throw new HaProtocolError('HA_INPUT_INVALID', `fault delay must be a nonnegative integer, got ${String(ms)}`);
    }
    this.#delayMs = ms;
  }

  /** Clear partitions/isolation and the artificial delay. */
  restore(): void {
    this.#groups.clear();
    this.#isolated.clear();
    this.#delayMs = 0;
  }

  allows(source: string, target: string): boolean {
    if (this.#isolated.has(source) || this.#isolated.has(target)) return false;
    if (this.#groups.size === 0) return true;
    return this.#groups.get(source) === this.#groups.get(target);
  }

  get delayMs(): number {
    return this.#delayMs;
  }

  snapshot(): InMemoryFaultSnapshot {
    const groups = new Map<number, string[]>();
    for (const [memberId, groupIndex] of this.#groups) {
      const list = groups.get(groupIndex);
      if (list === undefined) groups.set(groupIndex, [memberId]);
      else list.push(memberId);
    }
    return {
      partitions: [...groups.entries()].sort((left, right) => left[0] - right[0]).map(([, members]) => [...members].sort()),
      isolated: [...this.#isolated].sort(),
      delayMs: this.#delayMs,
    };
  }
}

async function faultDelay(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export interface InMemoryVoterRpcOptions {
  readonly voter_id: string;
  readonly target_id: string;
  /** Late-bound target lookup so the cluster can wire itself in two phases. */
  readonly resolveTarget: () => VoterRpcTarget | undefined;
  readonly faults?: InMemoryFaultController;
  readonly latencyMs?: number;
}

/** Deterministic in-memory {@link VoterRpc} with reachability faults. */
export class InMemoryVoterRpc implements VoterRpc {
  readonly #voterId: string;
  readonly #targetId: string;
  readonly #resolveTarget: () => VoterRpcTarget | undefined;
  readonly #faults: InMemoryFaultController | null;
  readonly #latencyMs: number;

  constructor(options: InMemoryVoterRpcOptions) {
    this.#voterId = options.voter_id;
    this.#targetId = options.target_id;
    this.#resolveTarget = options.resolveTarget;
    this.#faults = options.faults ?? null;
    this.#latencyMs = positiveInt(options.latencyMs, 0, 'latencyMs');
  }

  get target_id(): string {
    return this.#targetId;
  }

  get voter_id(): string {
    return this.#voterId;
  }

  requestVote(request: VoteRequest): Promise<VoteResponse> {
    return this.#deliver('vote', request, mwhaVoteResponseSchema);
  }

  sendHeartbeat(request: HeartbeatRequest): Promise<HeartbeatResponse> {
    return this.#deliver('heartbeat', request, mwhaHeartbeatResponseSchema);
  }

  async #deliver<T>(operation: 'vote' | 'heartbeat', request: unknown, schema: z.ZodType<T>): Promise<T> {
    if (this.#faults !== null && !this.#faults.allows(this.#voterId, this.#targetId)) {
      throw new HaProtocolError(
        'QUORUM_NOT_REACHED',
        `${this.#voterId} cannot reach voter ${this.#targetId} (in-memory fault injection)`,
      );
    }
    const latency = Math.max(this.#latencyMs, this.#faults?.delayMs ?? 0);
    await faultDelay(latency);
    const target = this.#resolveTarget();
    if (target === undefined) {
      throw new HaProtocolError('QUORUM_NOT_REACHED', `voter ${this.#targetId} is not registered in the in-memory mesh`);
    }
    let raw: unknown;
    if (operation === 'vote') raw = await target.handleVoteRequest(request);
    else raw = await target.handleHeartbeat(request);
    return parseOrThrow(schema, raw, `${operation} response`);
  }
}

// ---------------------------------------------------------------------------
// TcpReplicaClient-shaped adapter (compile-time seam for T-139)
// ---------------------------------------------------------------------------

export interface TcpVoterRpcAdapterOptions {
  readonly voter_id: string;
  readonly target_id: string;
  /**
   * Send one framed request. T-139 owns the concrete wire kind and transport
   * registration; this adapter never opens a socket and is untested here.
   */
  readonly send: (kind: string, payload: unknown) => Promise<unknown>;
}

/**
 * Adapter shape over a connected T-134-style client. NOT wired to
 * `tcp-transport.ts` by this task: the frozen `tcpReplicaKinds` vocabulary has
 * no vote/heartbeat kind yet, and T-139 owns that extension. The adapter is a
 * type-compatible seam only.
 */
export class TcpVoterRpcAdapter implements VoterRpc {
  readonly #voterId: string;
  readonly #targetId: string;
  readonly #send: (kind: string, payload: unknown) => Promise<unknown>;

  constructor(options: TcpVoterRpcAdapterOptions) {
    this.#voterId = options.voter_id;
    this.#targetId = options.target_id;
    this.#send = options.send;
  }

  get target_id(): string {
    return this.#targetId;
  }

  get voter_id(): string {
    return this.#voterId;
  }

  async requestVote(request: VoteRequest): Promise<VoteResponse> {
    return parseOrThrow(mwhaVoteResponseSchema, await this.#send('vote-request', request), 'vote response');
  }

  async sendHeartbeat(request: HeartbeatRequest): Promise<HeartbeatResponse> {
    return parseOrThrow(mwhaHeartbeatResponseSchema, await this.#send('heartbeat', request), 'heartbeat response');
  }
}

// ---------------------------------------------------------------------------
// Cluster factory (in-memory, no sockets)
// ---------------------------------------------------------------------------

export interface LeaderLeaseClusterOptions {
  readonly members: readonly MwhaMember[];
  /** Shared injectable clock. */
  readonly now?: () => number;
  /** Per-member injectable clock; overrides `now` for that member. */
  readonly nowForMember?: (memberId: string) => () => number;
  readonly leaseDurationMs?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly faults?: InMemoryFaultController;
  readonly latencyMs?: number;
  readonly onStateChange?: (memberId: string, snapshot: LeaderLeaseSnapshot) => void;
}

export interface LeaderLeaseCluster {
  readonly managers: ReadonlyMap<string, LeaderLeaseManager>;
  readonly faults: InMemoryFaultController;
  readonly members: readonly MwhaMember[];
  readonly votingCount: number;
  readonly quorumSize: number;
}

/**
 * Build a wired in-memory cluster. Observers are validated but get no manager
 * (they never vote, commit or lead). No socket, no timer, no real sleep.
 */
export function createLeaderLeaseCluster(options: LeaderLeaseClusterOptions): LeaderLeaseCluster {
  const topology = validateTopology(options.members);
  const faults = options.faults ?? new InMemoryFaultController();
  const registry = new Map<string, VoterRpcTarget>();
  const managers = new Map<string, LeaderLeaseManager>();

  for (const member of topology.members) {
    if (member.role === 'observer') continue;
    const voters = topology.members
      .filter((other) => other.role !== 'observer' && other.member_id !== member.member_id)
      .map((other) => new InMemoryVoterRpc({
        voter_id: member.member_id,
        target_id: other.member_id,
        resolveTarget: () => registry.get(other.member_id),
        faults,
        ...(options.latencyMs === undefined ? {} : { latencyMs: options.latencyMs }),
      }));
    const clock = options.nowForMember !== undefined
      ? options.nowForMember(member.member_id)
      : options.now;
    const manager = new LeaderLeaseManager({
      member_id: member.member_id,
      members: topology.members,
      voters,
      ...(clock === undefined ? {} : { now: clock }),
      ...(options.leaseDurationMs === undefined ? {} : { leaseDurationMs: options.leaseDurationMs }),
      ...(options.heartbeatTimeoutMs === undefined ? {} : { heartbeatTimeoutMs: options.heartbeatTimeoutMs }),
      ...(options.onStateChange === undefined
        ? {}
        : { onStateChange: (snapshot) => options.onStateChange?.(member.member_id, snapshot) }),
    });
    managers.set(member.member_id, manager);
    registry.set(member.member_id, manager);
  }

  return {
    managers,
    faults,
    members: topology.members,
    votingCount: votingMemberCount(topology.members),
    quorumSize: topology.quorum_size,
  };
}
