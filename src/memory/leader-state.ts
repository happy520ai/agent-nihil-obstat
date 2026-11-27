import { z } from 'zod';
import {
  HaProtocolError,
  MWHA_PROTOCOL_SCHEMA_VERSION,
  compareLogicalVersion,
  detectMultipleLeaders,
  mwhaMemberSchema,
  mwhaTopologySchema,
  quorumSizeForMembers,
  type MwhaEventIdentity,
  type MwhaLeaderLease,
  type MwhaLogicalVersion,
  type MwhaMember,
  type MwhaMultipleLeader,
  type MwhaTopology,
} from './ha-protocol.ts';
import type { LeaderLeaseCommitRecord, VoterRpc } from './leader-lease.ts';

/**
 * T-147 / CV-05 extraction: pure leader-lease state computations.
 *
 * Input/output are plain values: topology/voter validation, declaration
 * ordering keys/comparators, logical version derivation and the fail-closed
 * single-leader assertion. `leader-lease.ts` keeps the mutable
 * `LeaderLeaseManager` state machine and re-exports the public helper
 * (`assertSingleLeader`) unchanged.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    // Zod only returns a failed parse when at least one issue exists.
    const issue = result.error.issues[0]!;
    const path = `${label}.${issue.path.join('.')}`;
    const text = issue.message;
    throw new HaProtocolError('HA_INPUT_INVALID', `${path}: ${text}`);
  }
  return result.data;
}

export function positiveInt(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new HaProtocolError('HA_INPUT_INVALID', `${field} must be a positive integer, got ${String(value)}`);
  }
  return value;
}

function assertNoDuplicateMembers(members: readonly MwhaMember[]): void {
  const seen = new Set<string>();
  for (const member of members) {
    if (seen.has(member.member_id)) {
      throw new HaProtocolError('TOPOLOGY_INVALID', `duplicate member_id ${member.member_id}`);
    }
    seen.add(member.member_id);
  }
}

export function validateTopology(members: readonly MwhaMember[]): MwhaTopology {
  if (!Array.isArray(members) || members.length === 0) {
    throw new HaProtocolError('TOPOLOGY_INVALID', 'members must be a non-empty array');
  }
  for (const member of members) {
    const parsed = mwhaMemberSchema.safeParse(member);
    if (!parsed.success) {
      throw new HaProtocolError('TOPOLOGY_INVALID', `member is not a valid mwha member: ${JSON.stringify(member)}`);
    }
  }
  assertNoDuplicateMembers(members);
  try {
    return mwhaTopologySchema.parse({
      schema_version: MWHA_PROTOCOL_SCHEMA_VERSION,
      cluster_id: 'cluster',
      members,
      quorum_size: quorumSizeForMembers(members),
    });
  } catch (error) {
    if (error instanceof HaProtocolError) throw error;
    throw new HaProtocolError('TOPOLOGY_INVALID', `topology violates the frozen contract: ${String(error)}`, { cause: error });
  }
}

export function validateVoters(voters: readonly VoterRpc[], votingMembers: readonly MwhaMember[], selfId: string): readonly VoterRpc[] {
  if (!Array.isArray(voters)) {
    throw new HaProtocolError('TOPOLOGY_INVALID', 'voters must be an array of VoterRpc channels');
  }
  const votingIds = new Set(votingMembers.map((member) => member.member_id));
  const seen = new Set<string>();
  for (const voter of voters) {
    if (voter === null || typeof voter !== 'object') {
      throw new HaProtocolError('TOPOLOGY_INVALID', 'each voter must be a VoterRpc object');
    }
    if (voter.target_id === selfId) {
      throw new HaProtocolError('TOPOLOGY_INVALID', `member ${selfId} must not dial itself`);
    }
    if (!votingIds.has(voter.target_id)) {
      throw new HaProtocolError('TOPOLOGY_INVALID', `voter target ${voter.target_id} is not a voting member`);
    }
    if (seen.has(voter.target_id)) {
      throw new HaProtocolError('TOPOLOGY_INVALID', `duplicate voter channel for ${voter.target_id}`);
    }
    seen.add(voter.target_id);
  }
  const expected = votingMembers.length - 1;
  if (voters.length !== expected) {
    throw new HaProtocolError(
      'TOPOLOGY_INVALID',
      `expected ${String(expected)} remote voter channel(s) for a ${String(votingMembers.length)}-voter cluster, got ${String(voters.length)}`,
    );
  }
  return voters;
}

export function declarationKey(lease: MwhaLeaderLease): string {
  return `${lease.leader_id}\u0000${lease.epoch}\u0000${lease.term}`;
}

export function compareDeclarations(left: MwhaLeaderLease, right: MwhaLeaderLease): number {
  return left.epoch - right.epoch || left.term - right.term || (left.leader_id < right.leader_id ? -1 : left.leader_id > right.leader_id ? 1 : 0);
}

export function compareCommitRecords(left: LeaderLeaseCommitRecord, right: LeaderLeaseCommitRecord): number {
  const order = compareLogicalVersion(left.version, right.version);
  if (order !== 0) return order;
  return left.identity.ledger_event_hash < right.identity.ledger_event_hash ? -1 : 1;
}

export function logicalVersionOf(identity: MwhaEventIdentity, commitIndex: number): MwhaLogicalVersion {
  return {
    epoch: identity.epoch,
    commit_index: commitIndex,
    writer_id: identity.writer_id,
    local_seq: identity.local_seq,
  };
}

/**
 * Fail-closed single-leader assertion over collected declarations. A topology
 * may declare several writers, but one (epoch, term) may have one leader only.
 */
export function assertSingleLeader(declarations: readonly MwhaLeaderLease[]): void {
  const conflicts = detectMultipleLeaders(declarations);
  if (conflicts.length > 0) {
    const summary = conflicts
      .map((conflict) => `(epoch=${String(conflict.epoch)}, term=${String(conflict.term)}): ${conflict.leader_ids.join(', ')}`)
      .join('; ');
    throw new HaProtocolError('SPLIT_BRAIN', `multiple leaders declared for one (epoch, term): ${summary}`);
  }
}
