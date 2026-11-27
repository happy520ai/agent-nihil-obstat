import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HaProtocolError,
  compareLogicalVersion,
  type MwhaEventIdentity,
  type MwhaLeaderLease,
  type MwhaMember,
} from '../../src/memory/ha-protocol.ts';
import {
  MWHA_HEARTBEAT_REQUEST_SCHEMA_VERSION,
  MWHA_HEARTBEAT_RESPONSE_SCHEMA_VERSION,
  MWHA_LEADER_LEASE_SCHEMA_VERSION,
  MWHA_VOTE_REQUEST_SCHEMA_VERSION,
  MWHA_VOTE_RESPONSE_SCHEMA_VERSION,
  assertSingleLeader,
  createLeaderLeaseCluster,
  InMemoryFaultController,
  type HeartbeatRequest,
  type HeartbeatResponse,
  type LeaderLeaseCommitAttempt,
  type LeaderLeaseCommitRecord,
  LeaderLeaseManager,
  type LeaderLeaseManagerOptions,
  type LeaderLeaseTransition,
  type VoteRequest,
  type VoteResponse,
  type VoterRpc,
} from '../../src/memory/leader-lease.ts';

/**
 * T-136 unit tests: majority election, lease expiry, term/epoch fencing,
 * single-leader enforcement, heartbeat quorum, rejoin catch-up and the
 * wall-clock-free version ordering. Every lease timer reads an injected
 * clock; no test waits on real time and no timer is left behind.
 */

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);
const HASH_X = 'x'.repeat(64);

interface TestClock {
  t: number;
  now: () => number;
  advance(ms: number): void;
  set(value: number): void;
}

function makeClock(start = 0): TestClock {
  const clock: TestClock = {
    t: start,
    now: () => clock.t,
    advance: (ms) => { clock.t += ms; },
    set: (value) => { clock.t = value; },
  };
  return clock;
}

function member(memberId: string, role: MwhaMember['role'] = 'writer'): MwhaMember {
  return { member_id: memberId, role };
}

function votingMembers(ids: readonly string[]): MwhaMember[] {
  return ids.map((id) => member(id));
}

function identity(
  writerId: string,
  epoch: number,
  term: number,
  localSeq = 1,
  hash = HASH_A,
): MwhaEventIdentity {
  return { writer_id: writerId, epoch, term, local_seq: localSeq, ledger_event_hash: hash };
}

function lease(leaderId: string, epoch: number, term: number): MwhaLeaderLease {
  return { leader_id: leaderId, epoch, term };
}

/** Single-voter manager: quorum is 1, so it is elected without any RPC. */
function soloManager(clock: TestClock, memberId = 'a'): LeaderLeaseManager {
  return new LeaderLeaseManager({
    member_id: memberId,
    members: [member(memberId)],
    voters: [],
    now: clock.now,
    leaseDurationMs: 1_000,
    heartbeatTimeoutMs: 1_000,
  });
}

async function elect(cluster: ReturnType<typeof createLeaderLeaseCluster>, memberId: string) {
  const manager = cluster.managers.get(memberId);
  assert.ok(manager !== undefined, `manager ${memberId} must exist`);
  return manager.requestVote();
}

/** Deterministic outbound channel whose replies are programmed per test. */
class ScriptedVoter implements VoterRpc {
  readonly target_id: string;
  voteHandler: (request: VoteRequest) => VoteResponse | Promise<VoteResponse>;
  heartbeatHandler: (request: HeartbeatRequest) => HeartbeatResponse | Promise<HeartbeatResponse>;

  constructor(
    targetId: string,
    handlers: {
      vote?: (request: VoteRequest) => VoteResponse | Promise<VoteResponse>;
      heartbeat?: (request: HeartbeatRequest) => HeartbeatResponse | Promise<HeartbeatResponse>;
    } = {},
  ) {
    this.target_id = targetId;
    this.voteHandler = handlers.vote ?? ((request) => ({
      schema_version: MWHA_VOTE_RESPONSE_SCHEMA_VERSION,
      granted: true,
      term: request.term,
      epoch: request.epoch,
      voter_id: targetId,
      leader_id: null,
      detail: 'scripted grant',
    }));
    this.heartbeatHandler = handlers.heartbeat ?? (() => ({
      schema_version: MWHA_HEARTBEAT_RESPONSE_SCHEMA_VERSION,
      accepted: true,
      term: 0,
      epoch: 0,
      voter_id: targetId,
      leader_id: null,
      detail: 'scripted heartbeat',
    }));
  }

  requestVote(request: VoteRequest): Promise<VoteResponse> {
    return Promise.resolve(this.voteHandler(request));
  }

  sendHeartbeat(request: HeartbeatRequest): Promise<HeartbeatResponse> {
    return Promise.resolve(this.heartbeatHandler(request));
  }
}

function scriptedManager(
  clock: TestClock,
  memberId: string,
  ids: readonly string[],
  voters: readonly VoterRpc[],
): LeaderLeaseManager {
  return new LeaderLeaseManager({
    member_id: memberId,
    members: votingMembers(ids),
    voters,
    now: clock.now,
    leaseDurationMs: 1_000,
    heartbeatTimeoutMs: 1_000,
  });
}

function assertHaCode(fn: () => unknown, expected: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof HaProtocolError, `expected HaProtocolError, got ${String(error)}`);
    assert.equal(error.code, expected);
    return true;
  });
}

test('T-136 unit: N=3 majority elects exactly one leader with derived quorum', { timeout: 60_000 }, async () => {
  const clock = makeClock();
  const cluster = createLeaderLeaseCluster({
    members: votingMembers(['a', 'b', 'c']),
    now: clock.now,
    leaseDurationMs: 1_000,
  });

  assert.equal(cluster.votingCount, 3);
  assert.equal(cluster.quorumSize, 2);

  const result = await elect(cluster, 'a');
  assert.equal(result.won, true);
  assert.equal(result.votes, 3);
  assert.equal(result.quorum_size, 2);
  assert.deepEqual(result.granted_by, ['b', 'c']);

  const leader = cluster.managers.get('a');
  assert.ok(leader !== undefined);
  assert.equal(leader.role, 'leader');
  assert.equal(leader.term, 1);
  assert.equal(leader.epoch, 1);
  assert.deepEqual(leader.currentLease, lease('a', 1, 1));
  assert.equal(leader.snapshot().schema_version, MWHA_LEADER_LEASE_SCHEMA_VERSION);
  assert.equal(leader.detectSplitBrain().length, 0);

  for (const followerId of ['b', 'c']) {
    const follower = cluster.managers.get(followerId);
    assert.ok(follower !== undefined);
    assert.equal(follower.role, 'follower');
    assert.equal(follower.isLeader(), false);
    assert.equal(follower.term, 1);
    assert.equal(follower.epoch, 1);
  }
});

test('T-136 unit: N=5 majority derives quorum 3 and elects one leader', { timeout: 60_000 }, async () => {
  const clock = makeClock();
  const cluster = createLeaderLeaseCluster({
    members: votingMembers(['a', 'b', 'c', 'd', 'e']),
    now: clock.now,
    leaseDurationMs: 1_000,
  });

  assert.equal(cluster.votingCount, 5);
  assert.equal(cluster.quorumSize, 3);

  const result = await elect(cluster, 'a');
  assert.equal(result.won, true);
  assert.equal(result.votes, 5);
  assert.deepEqual(result.granted_by, ['b', 'c', 'd', 'e']);
  assert.equal(cluster.managers.get('a')?.role, 'leader');
  assert.equal(cluster.managers.get('b')?.role, 'follower');
});

test('T-136 unit: no majority never yields a leader (isolated node and 2-of-5 minority)', { timeout: 60_000 }, async () => {
  const clock = makeClock();

  const three = createLeaderLeaseCluster({
    members: votingMembers(['a', 'b', 'c']),
    now: clock.now,
    leaseDurationMs: 1_000,
    faults: new InMemoryFaultController(),
  });
  three.faults.isolate('a');
  const isolated = await three.managers.get('a')?.requestVote();
  assert.ok(isolated !== undefined);
  assert.equal(isolated.won, false);
  assert.equal(isolated.votes, 1);
  assert.equal(isolated.unreachable.length, 2);
  assert.equal(three.managers.get('a')?.isLeader(), false);
  assert.equal(three.managers.get('a')?.currentLease, null);
  // A lost campaign still advances the local term so a stale term can never win.
  assert.equal(three.managers.get('a')?.term, 1);

  const five = createLeaderLeaseCluster({
    members: votingMembers(['a', 'b', 'c', 'd', 'e']),
    now: clock.now,
    leaseDurationMs: 1_000,
    faults: new InMemoryFaultController(),
  });
  five.faults.partition([['a', 'b'], ['c', 'd', 'e']]);
  const minority = await five.managers.get('a')?.requestVote();
  assert.ok(minority !== undefined);
  assert.equal(minority.won, false);
  assert.equal(minority.votes, 2);
  assert.equal(minority.quorum_size, 3);
  assert.equal(five.managers.get('a')?.isLeader(), false);

  // The majority partition can still elect.
  const majoritySide = await elect(five, 'c');
  assert.equal(majoritySide.won, true);
  assert.equal(majoritySide.votes, 3);
  assert.equal(five.managers.get('c')?.role, 'leader');
});

test('T-136 unit: lease expiry stops commits immediately on the injected clock', { timeout: 60_000 }, async () => {
  const clock = makeClock(1_000);
  const manager = soloManager(clock);
  await manager.requestVote();

  const grant = manager.assertCanCommit(identity('w', 1, 1));
  assert.equal(grant.allowed, true);
  assert.equal(grant.commit_index, 1);
  assert.equal(manager.isLeaseExpired(), false);
  assert.equal(manager.leaseExpiresAtMs, 2_000);

  clock.set(2_000);
  assert.equal(manager.isLeaseExpired(), true);
  assertHaCode(() => manager.assertCanCommit(identity('w', 1, 1, 2, HASH_B)), 'QUORUM_NOT_REACHED');

  assert.equal(manager.role, 'follower');
  assert.equal(manager.leaseExpiresAtMs, null);
  assert.equal(manager.snapshot().last_step_down_reason, 'LEASE_EXPIRED');
  assert.equal(manager.committedCount, 1);
});

test('T-136 unit: fencing rejects stale term, epoch rollback and ahead-of-lease writes', { timeout: 60_000 }, async () => {
  const clock = makeClock();
  const manager = soloManager(clock);
  await manager.requestVote();
  assert.deepEqual(manager.currentLease, lease('a', 1, 1));

  assertHaCode(() => manager.assertCanCommit(identity('w', 0, 0)), 'FENCE_EPOCH_ROLLBACK');
  assertHaCode(() => manager.assertCanCommit(identity('w', 1, 0)), 'FENCE_STALE_TERM');
  assertHaCode(() => manager.assertCanCommit(identity('w', 2, 2)), 'FENCE_REJECTED');

  // A follower (even one that still remembers its old lease) may not commit.
  manager.stepDown('MANUAL');
  assertHaCode(() => manager.assertCanCommit(identity('w', 1, 1)), 'FENCE_REJECTED');

  // Malformed identities fail closed at the schema boundary.
  assertHaCode(() => manager.assertCanCommit({ ...identity('w', 1, 1), ledger_event_hash: 'not-a-hash' }), 'HA_INPUT_INVALID');
});

test('T-136 unit: same-(epoch,term) rival leader is refused and blocks commits', { timeout: 60_000 }, async () => {
  const clock = makeClock();
  const manager = soloManager(clock);
  await manager.requestVote();

  const observed = manager.observeLease(lease('b', 1, 1));
  assert.equal(observed.action, 'split-brain');
  assert.equal(observed.adopted, false);
  assert.equal(observed.code, 'FENCE_SPLIT_BRAIN_SAME_TERM');
  assert.deepEqual(manager.detectSplitBrain(), [{ epoch: 1, term: 1, leader_ids: ['a', 'b'] }]);

  const heartbeatResponse = manager.handleHeartbeat({
    schema_version: MWHA_HEARTBEAT_REQUEST_SCHEMA_VERSION,
    lease: lease('b', 1, 1),
  });
  assert.equal(heartbeatResponse.accepted, false);
  assert.match(heartbeatResponse.detail, /illegal/u);
  assert.equal(manager.detectSplitBrain().length, 1);

  assertHaCode(() => manager.assertCanCommit(identity('w', 1, 1)), 'SPLIT_BRAIN');
});

test('T-136 unit: assertSingleLeader separates same-term rivals from distinct terms', { timeout: 60_000 }, () => {
  // Distinct terms are sequential leaders, not a split brain.
  assert.doesNotThrow(() => assertSingleLeader([
    lease('a', 1, 1),
    lease('b', 1, 2),
    lease('c', 2, 1),
  ]));
  // One declaration repeated is idempotent.
  assert.doesNotThrow(() => assertSingleLeader([lease('a', 1, 1), lease('a', 1, 1)]));

  assert.throws(
    () => assertSingleLeader([lease('a', 1, 1), lease('b', 1, 1)]),
    (error: unknown) => {
      assert.ok(error instanceof HaProtocolError);
      assert.equal(error.code, 'SPLIT_BRAIN');
      assert.match(error.message, /\(epoch=1, term=1\): a, b/u);
      return true;
    },
  );

  assertHaCode(() => assertSingleLeader([{ ...lease('a', 1, 1), term: -1 }]), 'HA_INPUT_INVALID');
});

test('T-136 unit: a new leader needs a strictly newer term confirmed by a majority', { timeout: 60_000 }, async () => {
  const clock = makeClock();
  const faults = new InMemoryFaultController();
  const cluster = createLeaderLeaseCluster({
    members: votingMembers(['a', 'b', 'c']),
    now: clock.now,
    leaseDurationMs: 1_000,
    faults,
  });
  const first = await elect(cluster, 'a');
  assert.equal(first.won, true);
  assert.equal(first.term, 1);

  // b cannot win while isolated: only its own vote exists.
  faults.isolate('b');
  const failed = await cluster.managers.get('b')?.requestVote();
  assert.ok(failed !== undefined);
  assert.equal(failed.won, false);
  assert.equal(failed.votes, 1);
  assert.equal(failed.quorum_size, 2);
  assert.equal(cluster.managers.get('b')?.isLeader(), false);

  // Once reachable, the same candidate wins with a majority on a newer term.
  faults.restore();
  const won = await cluster.managers.get('b')?.requestVote();
  assert.ok(won !== undefined);
  assert.equal(won.won, true);
  assert.equal(won.votes, 3);
  assert.ok(won.term > first.term);

  const oldLeader = cluster.managers.get('a');
  assert.ok(oldLeader !== undefined);
  assert.equal(oldLeader.role, 'follower');
  assert.equal(oldLeader.isLeader(), false);
  assert.equal(oldLeader.term, won.term);
  assert.equal(oldLeader.epoch, won.epoch);
});

test('T-136 unit: epoch is monotonic under stale heartbeats and observations', { timeout: 60_000 }, async () => {
  const clock = makeClock();
  const manager = soloManager(clock);
  await manager.requestVote();

  const adopted = manager.handleHeartbeat({
    schema_version: MWHA_HEARTBEAT_REQUEST_SCHEMA_VERSION,
    lease: lease('b', 2, 2),
  });
  assert.equal(adopted.accepted, true);
  assert.equal(manager.epoch, 2);
  assert.equal(manager.term, 2);
  assert.equal(manager.leaderId, 'b');
  assert.equal(manager.role, 'follower');

  const staleHeartbeat = manager.handleHeartbeat({
    schema_version: MWHA_HEARTBEAT_REQUEST_SCHEMA_VERSION,
    lease: lease('z', 1, 1),
  });
  assert.equal(staleHeartbeat.accepted, false);
  assert.equal(manager.epoch, 2);

  const staleObservation = manager.observeLease(lease('z', 1, 1));
  assert.equal(staleObservation.action, 'ignored-stale');
  assert.equal(staleObservation.code, 'FENCE_EPOCH_ROLLBACK');
  assert.equal(manager.epoch, 2);

  // Rejoining cannot lower the epoch either (no peer here, so nothing changes).
  const report = await manager.rejoin();
  assert.equal(report.rejoined, false);
  assert.equal(manager.epoch, 2);
});

test('T-136 unit: losing heartbeat quorum steps down immediately', { timeout: 60_000 }, async () => {
  const clock = makeClock();
  const faults = new InMemoryFaultController();
  const cluster = createLeaderLeaseCluster({
    members: votingMembers(['a', 'b', 'c']),
    now: clock.now,
    leaseDurationMs: 1_000,
    faults,
  });
  await elect(cluster, 'a');
  const leader = cluster.managers.get('a');
  assert.ok(leader !== undefined);
  assert.equal(leader.role, 'leader');

  faults.isolate('b');
  faults.isolate('c');
  const result = await leader.renewLease();
  assert.equal(result.renewed, false);
  assert.equal(result.reason, 'QUORUM_LOST');
  assert.equal(result.acks, 1);
  assert.equal(result.quorum_size, 2);
  assert.equal(leader.role, 'follower');
  assert.equal(leader.leaseExpiresAtMs, null);
  assert.equal(leader.snapshot().last_step_down_reason, 'HEARTBEAT_QUORUM_LOST');
});

test('T-136 unit: renewal requires a majority of heartbeat acks', { timeout: 60_000 }, async () => {
  const clock = makeClock(0);
  const cluster = createLeaderLeaseCluster({
    members: votingMembers(['a', 'b', 'c']),
    now: clock.now,
    leaseDurationMs: 500,
  });
  await elect(cluster, 'a');
  const leader = cluster.managers.get('a');
  assert.ok(leader !== undefined);

  clock.advance(400);
  const renewed = await leader.renewLease();
  assert.equal(renewed.renewed, true);
  assert.equal(renewed.reason, 'RENEWED');
  assert.equal(renewed.acks, 3);
  assert.equal(renewed.lease_expires_at_ms, 900);
  assert.equal(leader.leaseExpiresAtMs, 900);
  assert.equal(leader.isLeaseExpired(), false);
});

test('T-136 unit: rejoin demotes an old leader, catches up and never overwrites', { timeout: 60_000 }, async () => {
  const clock = makeClock();
  const faults = new InMemoryFaultController();
  const cluster = createLeaderLeaseCluster({
    members: votingMembers(['a', 'b', 'c']),
    now: clock.now,
    leaseDurationMs: 5_000,
    faults,
  });

  await elect(cluster, 'a');
  const oldLeader = cluster.managers.get('a');
  const newLeader = cluster.managers.get('b');
  assert.ok(oldLeader !== undefined);
  assert.ok(newLeader !== undefined);

  const recordA = oldLeader.assertCanCommit(identity('a', 1, 1, 1, HASH_A));
  assert.equal(recordA.commit_index, 1);

  faults.partition([['a'], ['b', 'c']]);
  const won = await newLeader.requestVote();
  assert.equal(won.won, true);
  const recordB = newLeader.assertCanCommit(identity('b', won.epoch, won.term, 1, HASH_B));
  assert.equal(recordB.commit_index, 1);

  faults.restore();
  const report = await oldLeader.rejoin({
    fetchCommitted: () => [...newLeader.committedRecords()],
  });
  assert.equal(report.rejoined, true);
  assert.equal(report.previous_epoch, 1);
  assert.equal(report.adopted_epoch, won.epoch);
  assert.equal(report.previous_term, 1);
  assert.equal(report.adopted_term, won.term);
  assert.equal(report.adopted_leader_id, 'b');
  assert.equal(report.records_seen, 1);
  assert.equal(report.records_applied, 1);
  assert.equal(report.caught_up, true);

  assert.equal(oldLeader.role, 'follower');
  assert.equal(oldLeader.isLeader(), false);
  assert.deepEqual(oldLeader.currentLease, lease('b', won.epoch, won.term));

  const records = oldLeader.committedRecords();
  assert.equal(records.length, 2);
  // Logical order is (epoch, commit_index, writer_id), never wall clock.
  assert.deepEqual(records.map((record) => record.identity.ledger_event_hash), [HASH_A, HASH_B]);
  assert.ok(compareLogicalVersion(records[0]!.version, records[1]!.version) < 0);
  // The surviving leader's earlier record was not replaced.
  assert.equal(records[0]!.identity.writer_id, 'a');

  // A competing branch at a slot this node already holds is retained locally.
  const conflict: LeaderLeaseCommitRecord = {
    identity: { ...records[0]!.identity, ledger_event_hash: HASH_X },
    commit_index: records[0]!.commit_index,
    leader: records[0]!.leader,
    version: records[0]!.version,
  };
  const conflictReport = await oldLeader.rejoin({
    fetchCommitted: () => [conflict],
  });
  assert.equal(conflictReport.records_applied, 0);
  const after = oldLeader.committedRecords();
  assert.equal(after.length, 2);
  assert.equal(after[0]!.identity.ledger_event_hash, HASH_A);
});

test('T-136 unit: wall-clock rollback leaves committed version order untouched', { timeout: 60_000 }, async () => {
  const clock = makeClock(100_000);
  const manager = soloManager(clock);
  await manager.requestVote();

  const first = manager.assertCanCommit(identity('w', 1, 1, 1, HASH_A));
  const second = manager.assertCanCommit(identity('w', 1, 1, 2, HASH_B));
  assert.equal(first.commit_index, 1);
  assert.equal(second.commit_index, 2);

  // Roll the injected clock backwards; diagnostics flag it but it must not
  // influence commit order or versioning.
  clock.set(5_000);
  const diagnosis = manager.diagnoseClock(5_000, 100_000);
  assert.equal(diagnosis.kind, 'rollback');
  assert.equal(diagnosis.diagnostic_only, true);
  assert.equal(diagnosis.affects_commit_order, false);
  assert.equal(diagnosis.affects_fact_version, false);

  const third = manager.assertCanCommit(identity('w', 1, 1, 3, HASH_C));
  assert.equal(third.commit_index, 3);

  const hashes = manager.committedRecords().map((record) => record.identity.ledger_event_hash);
  assert.deepEqual(hashes, [HASH_A, HASH_B, HASH_C]);
  const versions = manager.committedRecords().map((record) => record.version);
  for (let index = 1; index < versions.length; index += 1) {
    assert.ok(compareLogicalVersion(versions[index - 1]!, versions[index]!) < 0);
  }
});

test('T-136 unit: constructor rejects invalid topology, voter channels and clocks', { timeout: 60_000 }, () => {
  const clock = makeClock();
  const validVoters = [new ScriptedVoter('b'), new ScriptedVoter('c')];
  const base = {
    member_id: 'a',
    members: votingMembers(['a', 'b', 'c']),
    voters: validVoters,
    now: clock.now,
  } as const;

  // Options object shape.
  assertHaCode(() => new LeaderLeaseManager(null as unknown as LeaderLeaseManagerOptions), 'TOPOLOGY_INVALID');
  assertHaCode(() => new LeaderLeaseManager([] as unknown as LeaderLeaseManagerOptions), 'TOPOLOGY_INVALID');
  assertHaCode(() => new LeaderLeaseManager('nope' as unknown as LeaderLeaseManagerOptions), 'TOPOLOGY_INVALID');

  // member_id must be a bounded identifier.
  assertHaCode(() => new LeaderLeaseManager({ ...base, member_id: '' }), 'TOPOLOGY_INVALID');
  assertHaCode(() => new LeaderLeaseManager({ ...base, member_id: 'bad id' }), 'TOPOLOGY_INVALID');
  assertHaCode(() => new LeaderLeaseManager({ ...base, member_id: 7 as unknown as string }), 'TOPOLOGY_INVALID');

  // Topology validation.
  assertHaCode(() => new LeaderLeaseManager({ ...base, members: [] }), 'TOPOLOGY_INVALID');
  assertHaCode(() => new LeaderLeaseManager({
    ...base,
    members: [{ member_id: 'a', role: 'writer' }, { member_id: 'a', role: 'writer' }] as MwhaMember[],
    voters: [],
  }), 'TOPOLOGY_INVALID');
  assertHaCode(() => new LeaderLeaseManager({
    ...base,
    members: [{ member_id: 'a', role: 'bogus' }] as unknown as MwhaMember[],
  }), 'TOPOLOGY_INVALID');
  // Members pass the per-member schema but violate the frozen topology contract.
  assertHaCode(() => new LeaderLeaseManager({
    ...base,
    members: [member('a', 'observer'), member('b', 'observer')],
    voters: [new ScriptedVoter('b')],
  }), 'TOPOLOGY_INVALID');
  assertHaCode(() => new LeaderLeaseManager({
    ...base,
    members: votingMembers(['a', 'b', 'c']),
    voters: [new ScriptedVoter('b')],
    now: 'not-a-function' as unknown as () => number,
  }), 'HA_INPUT_INVALID');

  // Voter channel validation.
  assertHaCode(() => new LeaderLeaseManager({ ...base, voters: {} as unknown as VoterRpc[] }), 'TOPOLOGY_INVALID');
  assertHaCode(() => new LeaderLeaseManager({ ...base, voters: [null as unknown as VoterRpc] }), 'TOPOLOGY_INVALID');
  assertHaCode(() => new LeaderLeaseManager({ ...base, voters: ['nope' as unknown as VoterRpc] }), 'TOPOLOGY_INVALID');
  assertHaCode(() => new LeaderLeaseManager({ ...base, voters: [new ScriptedVoter('a')] }), 'TOPOLOGY_INVALID');
  assertHaCode(() => new LeaderLeaseManager({ ...base, voters: [new ScriptedVoter('z')] }), 'TOPOLOGY_INVALID');
  assertHaCode(() => new LeaderLeaseManager({
    ...base,
    voters: [new ScriptedVoter('b'), new ScriptedVoter('b')],
  }), 'TOPOLOGY_INVALID');
  assertHaCode(() => new LeaderLeaseManager({ ...base, voters: [new ScriptedVoter('b')] }), 'TOPOLOGY_INVALID');
  assertHaCode(() => new LeaderLeaseManager({
    member_id: 'o',
    members: [member('a'), member('o', 'observer')],
    voters: [new ScriptedVoter('a')],
    now: clock.now,
  }), 'TOPOLOGY_INVALID');

  // Numeric options are positive integers when supplied.
  assertHaCode(() => new LeaderLeaseManager({ ...base, leaseDurationMs: 0 }), 'HA_INPUT_INVALID');
  assertHaCode(() => new LeaderLeaseManager({ ...base, leaseDurationMs: 1.5 }), 'HA_INPUT_INVALID');
  assertHaCode(() => new LeaderLeaseManager({ ...base, heartbeatTimeoutMs: -1 }), 'HA_INPUT_INVALID');
});

test('T-136 unit: public observation getters expose the derived topology', { timeout: 60_000 }, async () => {
  const clock = makeClock();
  const cluster = createLeaderLeaseCluster({
    members: [member('a'), member('b'), member('c'), member('obs', 'observer')],
    now: clock.now,
    leaseDurationMs: 1_000,
  });
  const manager = cluster.managers.get('a');
  assert.ok(manager !== undefined);
  assert.equal(cluster.managers.has('obs'), false, 'observers never receive a manager');
  assert.equal(manager.member_id, 'a');
  assert.equal(manager.memberId, 'a');
  assert.equal(manager.members.length, 4);
  assert.equal(manager.votingCount, 3);
  assert.equal(manager.quorumSize, 2);
  assert.equal(manager.transitions().length, 0);

  await manager.requestVote();
  const transitions = manager.transitions();
  assert.ok(transitions.length >= 1);
  assert.equal(transitions[0]!.kind, 'elected');
  // The returned log is a defensive copy.
  (transitions as unknown as LeaderLeaseTransition[]).push({ ...transitions[0]!, kind: 'commit' });
  assert.equal(manager.transitions().length, transitions.length - 1);
});

test('T-136 unit: a rejecting voter RPC is reported as unreachable, not fatal', { timeout: 60_000 }, async () => {
  const clock = makeClock();
  // The per-voter try/catch converts ordinary throws into a null response; a
  // promise that rejects inside `Promise.allSettled` itself is the remaining
  // path that must still count as one unreachable vote.
  class RejectingVoters extends Array<VoterRpc> {
    override map<U>(_callback: (value: VoterRpc, index: number, array: VoterRpc[]) => U): U[] {
      return [Promise.reject(new Error('transport exploded')) as unknown as U];
    }
  }
  const voters = new RejectingVoters();
  voters.push(new ScriptedVoter('b'), new ScriptedVoter('c'));
  const manager = scriptedManager(clock, 'a', ['a', 'b', 'c'], voters);

  const result = await manager.requestVote();
  assert.equal(result.won, false);
  assert.equal(result.votes, 1);
  assert.deepEqual(result.unreachable, ['unknown']);
  assert.equal(manager.isLeader(), false);
});

test('T-136 unit: inbound vote requests refuse self-duplication, epoch rollback and stale term', { timeout: 60_000 }, async () => {
  const clock = makeClock();
  const cluster = createLeaderLeaseCluster({
    members: votingMembers(['a', 'b', 'c']),
    now: clock.now,
    leaseDurationMs: 1_000,
  });
  await elect(cluster, 'a');
  const follower = cluster.managers.get('b');
  assert.ok(follower !== undefined);
  const envelope = { schema_version: MWHA_VOTE_REQUEST_SCHEMA_VERSION };

  const selfVote = follower.handleVoteRequest({ ...envelope, term: 5, epoch: 5, candidate_id: 'b' });
  assert.equal(selfVote.granted, true);
  assert.match(selfVote.detail, /self vote/u);

  const epochRollback = follower.handleVoteRequest({ ...envelope, term: 1, epoch: 0, candidate_id: 'c' });
  assert.equal(epochRollback.granted, false);
  assert.match(epochRollback.detail, /rolls back current epoch/u);

  const staleTerm = follower.handleVoteRequest({ ...envelope, term: 0, epoch: 1, candidate_id: 'c' });
  assert.equal(staleTerm.granted, false);
  assert.match(staleTerm.detail, /older than current term/u);

  // Malformed vote input fails closed at the schema boundary.
  assertHaCode(() => follower.handleVoteRequest({ ...envelope, term: -1, epoch: 1, candidate_id: 'c' }), 'HA_INPUT_INVALID');
});

test('T-136 unit: renewal refuses a follower and an already-expired lease', { timeout: 60_000 }, async () => {
  const clock = makeClock(1_000);
  const cluster = createLeaderLeaseCluster({
    members: votingMembers(['a', 'b', 'c']),
    now: clock.now,
    leaseDurationMs: 500,
  });
  await elect(cluster, 'a');

  const followerRenewal = await cluster.managers.get('b')!.renewLease();
  assert.equal(followerRenewal.renewed, false);
  assert.equal(followerRenewal.reason, 'NOT_LEADER');
  assert.equal(followerRenewal.acks, 0);
  assert.equal(followerRenewal.lease, null);

  const leader = cluster.managers.get('a')!;
  clock.advance(600);
  assert.equal(leader.isLeaseExpired(), true);
  const expired = await leader.renewLease();
  assert.equal(expired.renewed, false);
  assert.equal(expired.reason, 'LEASE_EXPIRED');
  assert.equal(expired.lease_expires_at_ms, null);
  assert.equal(leader.role, 'follower');
  assert.equal(leader.snapshot().last_step_down_reason, 'LEASE_EXPIRED');
});

test('T-136 unit: a newer peer lease observed during renewal demotes the leader', { timeout: 60_000 }, async () => {
  const clock = makeClock();
  const voters = [
    new ScriptedVoter('b', {
      heartbeat: () => ({
        schema_version: MWHA_HEARTBEAT_RESPONSE_SCHEMA_VERSION,
        accepted: false,
        term: 2,
        epoch: 2,
        voter_id: 'b',
        leader_id: 'b',
        detail: 'newer lease',
      }),
    }),
    new ScriptedVoter('c', {
      heartbeat: () => ({
        schema_version: MWHA_HEARTBEAT_RESPONSE_SCHEMA_VERSION,
        accepted: false,
        term: 2,
        epoch: 2,
        voter_id: 'c',
        leader_id: 'b',
        detail: 'newer lease',
      }),
    }),
  ];
  const manager = scriptedManager(clock, 'a', ['a', 'b', 'c'], voters);
  assert.equal((await manager.requestVote()).won, true);

  const renewal = await manager.renewLease();
  assert.equal(renewal.renewed, false);
  assert.equal(renewal.reason, 'NEWER_LEADER');
  assert.equal(renewal.lease_expires_at_ms, null);
  assert.equal(manager.role, 'follower');
  assert.equal(manager.leaderId, 'b');
  assert.equal(manager.term, 2);
  assert.equal(manager.epoch, 2);
  assert.equal(manager.snapshot().last_step_down_reason, 'NEWER_EPOCH_OR_TERM');
});

test('T-136 unit: a heartbeat older than the current term is refused', { timeout: 60_000 }, async () => {
  const clock = makeClock();
  const manager = soloManager(clock);
  await manager.requestVote();

  const stale = manager.handleHeartbeat({
    schema_version: MWHA_HEARTBEAT_REQUEST_SCHEMA_VERSION,
    lease: lease('b', 1, 0),
  });
  assert.equal(stale.accepted, false);
  assert.match(stale.detail, /older than current term/u);
  assert.equal(manager.leaderId, 'a');
});

test('T-136 unit: observeLease reports unchanged, refreshed and adopted declarations', { timeout: 60_000 }, async () => {
  const clock = makeClock();
  const cluster = createLeaderLeaseCluster({
    members: votingMembers(['a', 'b', 'c']),
    now: clock.now,
    leaseDurationMs: 1_000,
    faults: new InMemoryFaultController(),
  });
  const manager = cluster.managers.get('a')!;
  await manager.requestVote();

  const unchanged = manager.observeLease(lease('a', 1, 1));
  assert.equal(unchanged.action, 'unchanged');
  assert.equal(unchanged.adopted, false);
  assert.equal(unchanged.code, 'FENCE_OK');

  // A campaign that lost quorum still advances the local term without a lease:
  // observing that exact (epoch, term) is a refresh, and a newer one is adopted.
  const isolatedCluster = createLeaderLeaseCluster({
    members: votingMembers(['x', 'y', 'z']),
    now: clock.now,
    leaseDurationMs: 1_000,
    faults: new InMemoryFaultController(),
  });
  isolatedCluster.faults.isolate('x');
  const loser = isolatedCluster.managers.get('x')!;
  assert.equal((await loser.requestVote()).won, false);
  assert.equal(loser.leaderId, null);

  const refreshed = loser.observeLease(lease('y', 0, 1));
  assert.equal(refreshed.action, 'refreshed');
  assert.equal(refreshed.adopted, false);
  assert.equal(refreshed.code, 'FENCE_OK');

  const adopted = loser.observeLease(lease('y', 1, 2));
  assert.equal(adopted.action, 'adopted');
  assert.equal(adopted.adopted, true);
  assert.equal(loser.role, 'follower');
  assert.equal(loser.leaderId, 'y');
  assert.equal(loser.term, 2);
});

test('T-136 unit: fencing names a term ahead of the held lease', { timeout: 60_000 }, async () => {
  const clock = makeClock();
  const manager = soloManager(clock);
  await manager.requestVote();
  assertHaCode(() => manager.assertCanCommit(identity('w', 1, 2)), 'FENCE_REJECTED');
});

test('T-136 unit: a non-positive or fractional commit_index fails closed', { timeout: 60_000 }, async () => {
  const clock = makeClock();
  const manager = soloManager(clock);
  await manager.requestVote();

  const withHiddenIndex = (commitIndex: number): LeaderLeaseCommitAttempt => {
    const write = identity('w', 1, 1);
    Object.defineProperty(write, 'commit_index', { value: commitIndex, enumerable: false });
    return write as LeaderLeaseCommitAttempt;
  };
  assertHaCode(() => manager.assertCanCommit(withHiddenIndex(0)), 'HA_INPUT_INVALID');
  assertHaCode(() => manager.assertCanCommit(withHiddenIndex(-1)), 'HA_INPUT_INVALID');
  assertHaCode(() => manager.assertCanCommit(withHiddenIndex(1.5)), 'HA_INPUT_INVALID');
  assert.equal(manager.committedCount, 0);
});

test('T-136 unit: rejoin survives unreachable voters and rejects a non-array fetch result', { timeout: 60_000 }, async () => {
  const clock = makeClock();
  const faults = new InMemoryFaultController();
  const cluster = createLeaderLeaseCluster({
    members: votingMembers(['a', 'b', 'c']),
    now: clock.now,
    leaseDurationMs: 1_000,
    faults,
  });

  // Every outbound heartbeat throws under the injected partition and must be
  // caught per voter instead of failing the whole rejoin.
  faults.isolate('b');
  faults.isolate('c');
  const isolatedReport = await cluster.managers.get('a')!.rejoin();
  assert.equal(isolatedReport.rejoined, false);
  assert.equal(isolatedReport.records_seen, 0);

  // With a reachable winning peer, a malformed fetchCommitted result throws.
  faults.restore();
  await elect(cluster, 'b');
  await assert.rejects(
    () => cluster.managers.get('a')!.rejoin({ fetchCommitted: () => 'not-an-array' as unknown as readonly LeaderLeaseCommitRecord[] }),
    (error: unknown) => error instanceof HaProtocolError && error.code === 'HA_INPUT_INVALID',
  );
});

test('T-136 unit: a throwing state-change callback never changes protocol behaviour', { timeout: 60_000 }, async () => {
  const clock = makeClock();
  let calls = 0;
  const manager = new LeaderLeaseManager({
    member_id: 'a',
    members: [member('a')],
    voters: [],
    now: clock.now,
    leaseDurationMs: 1_000,
    onStateChange: () => {
      calls += 1;
      throw new Error('observer crashed');
    },
  });

  await manager.requestVote();
  assert.equal(manager.role, 'leader');
  assert.ok(calls >= 1);
  assert.doesNotThrow(() => manager.stepDown('MANUAL'));
  assert.equal(manager.role, 'follower');
  assert.ok(calls >= 2);
  assert.doesNotThrow(() => manager.snapshot());
});
