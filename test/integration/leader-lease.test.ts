import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HaProtocolError,
  type MwhaEventIdentity,
  type MwhaMember,
} from '../../src/memory/ha-protocol.ts';
import {
  createLeaderLeaseCluster,
  InMemoryFaultController,
  type LeaderLeaseManager,
} from '../../src/memory/leader-lease.ts';

/**
 * T-136 integration tests: three/four-node in-memory VoterRpc meshes with an
 * injected clock and protocol-layer reachability faults. They cover failover,
 * old-leader isolation, rejoin catch-up without overwrite, the 2-2 no-commit
 * split and the fact that commit stays gated on a live majority-backed lease.
 *
 * Boundary: this exercises the abstract/in-memory RPC seam only. Real TCP
 * frames and OS-level partitions belong to T-139 and are not claimed here.
 */

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);

interface TestClock {
  t: number;
  now: () => number;
  advance(ms: number): void;
}

function makeClock(start = 0): TestClock {
  const clock: TestClock = {
    t: start,
    now: () => clock.t,
    advance: (ms) => { clock.t += ms; },
  };
  return clock;
}

function member(memberId: string): MwhaMember {
  return { member_id: memberId, role: 'writer' };
}

function votingMembers(ids: readonly string[]): MwhaMember[] {
  return ids.map(member);
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

function assertHaCode(fn: () => unknown, expected: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof HaProtocolError, `expected HaProtocolError, got ${String(error)}`);
    assert.equal(error.code, expected);
    return true;
  });
}

async function elect(cluster: ReturnType<typeof createLeaderLeaseCluster>, memberId: string) {
  const manager = cluster.managers.get(memberId);
  assert.ok(manager !== undefined, `manager ${memberId} must exist`);
  return manager.requestVote();
}

function managerOf(
  cluster: ReturnType<typeof createLeaderLeaseCluster>,
  memberId: string,
): LeaderLeaseManager {
  const manager = cluster.managers.get(memberId);
  assert.ok(manager !== undefined, `manager ${memberId} must exist`);
  return manager;
}

test('T-136 integration: leader loss elects a new leader that commits', { timeout: 60_000 }, async () => {
  const clock = makeClock();
  const faults = new InMemoryFaultController();
  const cluster = createLeaderLeaseCluster({
    members: votingMembers(['a', 'b', 'c']),
    now: clock.now,
    leaseDurationMs: 5_000,
    faults,
  });

  const first = await elect(cluster, 'a');
  assert.equal(first.won, true);
  const oldLeader = managerOf(cluster, 'a');
  const oldGrant = oldLeader.assertCanCommit(identity('a', 1, 1, 1, HASH_A));
  assert.equal(oldGrant.commit_index, 1);

  // The old leader becomes unreachable.
  faults.isolate('a');
  const won = await elect(cluster, 'b');
  assert.equal(won.won, true);
  assert.equal(won.votes, 2);
  assert.equal(won.quorum_size, 2);
  assert.deepEqual(won.unreachable, ['a']);

  const newLeader = managerOf(cluster, 'b');
  assert.equal(newLeader.role, 'leader');
  assert.ok(won.term > first.term);
  const newGrant = newLeader.assertCanCommit(identity('b', won.epoch, won.term, 1, HASH_B));
  assert.equal(newGrant.allowed, true);
  assert.equal(newGrant.commit_index, 1);
  assert.equal(newLeader.committedCount, 1);

  // The isolated old leader loses heartbeat quorum and is fenced out.
  const oldRenewal = await oldLeader.renewLease();
  assert.equal(oldRenewal.renewed, false);
  assert.equal(oldRenewal.reason, 'QUORUM_LOST');
  assert.equal(oldLeader.role, 'follower');
  assertHaCode(() => oldLeader.assertCanCommit(identity('a', 1, 1, 2, HASH_C)), 'FENCE_REJECTED');
});

test('T-136 integration: an isolated old leader cannot write while the new majority leads', { timeout: 60_000 }, async () => {
  const clock = makeClock();
  const faults = new InMemoryFaultController();
  const cluster = createLeaderLeaseCluster({
    members: votingMembers(['a', 'b', 'c']),
    now: clock.now,
    leaseDurationMs: 5_000,
    faults,
  });

  await elect(cluster, 'a');
  const oldLeader = managerOf(cluster, 'a');
  oldLeader.assertCanCommit(identity('a', 1, 1, 1, HASH_A));

  // a is cut off from the b/c majority.
  faults.partition([['a'], ['b', 'c']]);
  const won = await elect(cluster, 'b');
  assert.equal(won.won, true);
  assert.equal(won.votes, 2);
  const newLeader = managerOf(cluster, 'b');

  // The majority-backed lease renews; the partitioned old leader cannot.
  const renewal = await newLeader.renewLease();
  assert.equal(renewal.renewed, true);
  assert.equal(renewal.acks, 2);
  const oldRenewal = await oldLeader.renewLease();
  assert.equal(oldRenewal.renewed, false);
  assert.equal(oldRenewal.reason, 'QUORUM_LOST');
  assert.equal(oldLeader.snapshot().last_step_down_reason, 'HEARTBEAT_QUORUM_LOST');

  assertHaCode(() => oldLeader.assertCanCommit(identity('a', 1, 1, 2, HASH_C)), 'FENCE_REJECTED');
  assert.equal(oldLeader.committedCount, 1);

  // The new leader commits while the old one is fenced out.
  const grant = newLeader.assertCanCommit(identity('b', won.epoch, won.term, 1, HASH_B));
  assert.equal(grant.allowed, true);
  assert.equal(newLeader.committedCount, 1);
});

test('T-136 integration: a recovered old leader adopts the newer lease, catches up and does not overwrite', { timeout: 60_000 }, async () => {
  const clock = makeClock();
  const faults = new InMemoryFaultController();
  const cluster = createLeaderLeaseCluster({
    members: votingMembers(['a', 'b', 'c']),
    now: clock.now,
    leaseDurationMs: 5_000,
    faults,
  });

  await elect(cluster, 'a');
  const oldLeader = managerOf(cluster, 'a');
  oldLeader.assertCanCommit(identity('a', 1, 1, 1, HASH_A));

  faults.partition([['a'], ['b', 'c']]);
  const won = await elect(cluster, 'b');
  const newLeader = managerOf(cluster, 'b');
  newLeader.assertCanCommit(identity('b', won.epoch, won.term, 1, HASH_B));

  faults.restore();
  const report = await oldLeader.rejoin({
    fetchCommitted: () => [...newLeader.committedRecords()],
  });

  assert.equal(report.rejoined, true);
  assert.equal(report.adopted_term, won.term);
  assert.equal(report.adopted_leader_id, 'b');
  assert.equal(report.records_seen, 1);
  assert.equal(report.records_applied, 1);
  assert.equal(report.caught_up, true);

  assert.equal(oldLeader.role, 'follower');
  assert.equal(oldLeader.isLeader(), false);
  assert.equal(oldLeader.leaderId, 'b');

  const records = oldLeader.committedRecords();
  assert.equal(records.length, 2);
  // The surviving record is preserved byte-for-byte; the new one is appended
  // in logical order (epoch, commit_index, writer_id) - never wall clock.
  assert.deepEqual(records.map((record) => record.identity.ledger_event_hash), [HASH_A, HASH_B]);
  assert.equal(records[0]!.identity.writer_id, 'a');

  // The old leader's epoch-1 write is fenced out after adopting epoch 2.
  assertHaCode(() => oldLeader.assertCanCommit(identity('a', 1, 1, 2, HASH_C)), 'FENCE_EPOCH_ROLLBACK');
});

test('T-136 integration: a 2-2 split produces no committing partition', { timeout: 60_000 }, async () => {
  const clock = makeClock();
  const faults = new InMemoryFaultController();
  const cluster = createLeaderLeaseCluster({
    members: votingMembers(['a', 'b', 'c', 'd']),
    now: clock.now,
    leaseDurationMs: 5_000,
    faults,
  });
  assert.equal(cluster.quorumSize, 3);

  await elect(cluster, 'a');
  const oldLeader = managerOf(cluster, 'a');
  oldLeader.assertCanCommit(identity('a', 1, 1, 1, HASH_A));

  faults.partition([['a', 'b'], ['c', 'd']]);

  // Each side has only two votes: below the derived quorum of three.
  const oldRenewal = await oldLeader.renewLease();
  assert.equal(oldRenewal.renewed, false);
  assert.equal(oldRenewal.acks, 2);
  assert.equal(oldRenewal.reason, 'QUORUM_LOST');
  assertHaCode(() => oldLeader.assertCanCommit(identity('a', 1, 1, 2, HASH_B)), 'FENCE_REJECTED');

  const challenger = await managerOf(cluster, 'd').requestVote();
  assert.equal(challenger.won, false);
  assert.equal(challenger.votes, 2);
  assert.equal(challenger.quorum_size, 3);

  for (const id of ['a', 'b', 'c', 'd']) {
    assert.equal(managerOf(cluster, id).isLeader(), false, `${id} must not lead in a 2-2 split`);
  }
  assert.equal(managerOf(cluster, 'd').committedCount, 0);
  assert.equal(oldLeader.committedCount, 1);
});

test('T-136 integration: commit stays gated on a live majority-backed lease', { timeout: 60_000 }, async () => {
  const clock = makeClock();
  const faults = new InMemoryFaultController();
  const cluster = createLeaderLeaseCluster({
    members: votingMembers(['a', 'b', 'c']),
    now: clock.now,
    leaseDurationMs: 5_000,
    faults,
  });

  // Election itself required a majority: three granted votes.
  const won = await elect(cluster, 'a');
  assert.equal(won.votes, 3);
  const leader = managerOf(cluster, 'a');
  const grant = leader.assertCanCommit(identity('a', 1, 1, 1, HASH_A));
  assert.equal(grant.allowed, true);

  // Lose the majority and the lease dies immediately; commit is revoked
  // without waiting for any network confirmation.
  faults.isolate('b');
  faults.isolate('c');
  const renewal = await leader.renewLease();
  assert.equal(renewal.renewed, false);
  assert.equal(renewal.acks, 1);
  assertHaCode(() => leader.assertCanCommit(identity('a', 1, 1, 2, HASH_B)), 'FENCE_REJECTED');
  assert.equal(leader.committedCount, 1);
});

test('T-136 integration: rejoin tolerates one dead link and applies fetched records through the caller callback', { timeout: 60_000 }, async () => {
  const clock = makeClock();
  const faults = new InMemoryFaultController();
  const cluster = createLeaderLeaseCluster({
    members: votingMembers(['a', 'b', 'c']),
    now: clock.now,
    leaseDurationMs: 5_000,
    faults,
  });

  await elect(cluster, 'a');
  const oldLeader = managerOf(cluster, 'a');
  oldLeader.assertCanCommit(identity('a', 1, 1, 1, HASH_A));

  faults.partition([['a'], ['b', 'c']]);
  const won = await elect(cluster, 'b');
  const newLeader = managerOf(cluster, 'b');
  newLeader.assertCanCommit(identity('b', won.epoch, won.term, 1, HASH_B));

  // Restore connectivity except one direction so the rejoin probe still hits a
  // throwing channel while adopting from the reachable majority.
  faults.restore();
  faults.isolate('c');

  let appliedWith: string | null = null;
  const report = await oldLeader.rejoin({
    fetchCommitted: (peer) => {
      assert.equal(peer.member_id, 'b');
      return [...newLeader.committedRecords()];
    },
    apply: (records, peer) => {
      appliedWith = peer.member_id;
      assert.equal(records.length, 1);
    },
  });

  assert.equal(report.rejoined, true);
  assert.equal(report.adopted_leader_id, 'b');
  assert.equal(report.records_seen, 1);
  assert.equal(report.records_applied, 1);
  assert.equal(appliedWith, 'b');
  // A caller-supplied apply callback owns the merge; the manager does not also
  // apply the fetched records locally.
  assert.deepEqual(oldLeader.committedRecords().map((record) => record.identity.ledger_event_hash), [HASH_A]);
});
