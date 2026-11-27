/**
 * T-151 / QF-02 complete input x state x error matrix for
 * `src/memory/leader-state.ts`.
 *
 * Every case asserts an observable result: a returned topology/voter list, a
 * thrown `HaProtocolError` code and message fragment, or an ordering sign.
 *
 * T-153 follow-up (headers only; assertions unchanged): the former
 * `parseOrThrow` empty-issues fallback (`issue === undefined`) was removed by
 * the main-control cleanup because Zod only returns a failed parse when at
 * least one issue exists, so `issues[0]!` is now unconditional. This module is
 * expected at 100/100/100 after that cleanup; no mock was ever used to force
 * the old branch.
 *
 * Coverage map (scoped: leader-lease.test.ts + this file):
 * - parseOrThrow success/path/label:
 *     "parseOrThrow returns parsed data on success and reports the failing path on failure"
 *   - positiveInt all directions:
 *     "positiveInt returns the fallback for undefined and validates supplied values"
 *   - validateTopology array/empty/member/duplicate/quorum/catch-both-sides:
 *     "validateTopology derives quorum from voting participants",
 *     "validateTopology rejects non-arrays, empty arrays and invalid members",
 *     "validateTopology rejects duplicate member ids before parsing the topology",
 *     "validateTopology rethrows HaProtocolError from the frozen contract unchanged",
 *     "validateTopology wraps a non-HaProtocolError contract violation with its cause"
 *   - validateVoters every guard and count direction:
 *     "validateVoters accepts exactly one channel per remote voting member",
 *     "validateVoters rejects malformed channel lists and channels",
 *     "validateVoters refuses self-dials, outsiders, duplicates and wrong counts"
 *   - comparators/assertion:
 *     "declarationKey and compareDeclarations order by epoch, term then leader id",
 *     "compareCommitRecords orders by logical version then ledger hash",
 *     "logicalVersionOf maps identity plus commit index into the four-field version",
 *     "assertSingleLeader accepts sequential leaders and repeats, rejects split brains"
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import {
  HaProtocolError,
  MWHA_PROTOCOL_SCHEMA_VERSION,
  type MwhaEventIdentity,
  type MwhaLeaderLease,
  type MwhaMember,
} from '../../src/memory/ha-protocol.ts';
import type { LeaderLeaseCommitRecord, VoterRpc } from '../../src/memory/leader-lease.ts';
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
} from '../../src/memory/leader-state.ts';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function member(memberId: string, role: MwhaMember['role'] = 'voting-member'): MwhaMember {
  return { member_id: memberId, role };
}

function lease(leaderId: string, epoch: number, term: number): MwhaLeaderLease {
  return { leader_id: leaderId, epoch, term };
}

function identity(writerId: string, epoch: number, term: number, localSeq = 1, hash = HASH_A): MwhaEventIdentity {
  return { writer_id: writerId, epoch, term, local_seq: localSeq, ledger_event_hash: hash };
}

function commitRecord(overrides: Partial<LeaderLeaseCommitRecord> = {}): LeaderLeaseCommitRecord {
  return {
    identity: identity('w1', 1, 1),
    commit_index: 1,
    leader: lease('a', 1, 1),
    version: { epoch: 1, commit_index: 1, writer_id: 'w1', local_seq: 1 },
    ...overrides,
  };
}

function voter(targetId: string): VoterRpc {
  // validateVoters only inspects target_id; the RPC methods are never invoked.
  return {
    target_id: targetId,
    requestVote: () => ({}),
    sendHeartbeat: () => ({}),
  } as unknown as VoterRpc;
}

function assertHaCode(run: () => unknown, code: string): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof HaProtocolError, `expected HaProtocolError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

// ---------------------------------------------------------------------------
// parseOrThrow
// ---------------------------------------------------------------------------

test('parseOrThrow returns parsed data on success and reports the failing path on failure', () => {
  const schema = z.object({ nested: z.object({ count: z.number().int() }) }).strict();
  const value = { nested: { count: 3 } };
  assert.deepEqual(parseOrThrow(schema, value, 'payload'), value);

  assert.throws(
    () => parseOrThrow(schema, { nested: { count: 'x' } }, 'payload'),
    (error: unknown) => {
      assert.ok(error instanceof HaProtocolError);
      assert.equal(error.code, 'HA_INPUT_INVALID');
      assert.match(error.message, /payload\.nested\.count/u);
      return true;
    },
  );

  // An empty issue path on a scalar failure keeps the bare label prefix.
  assert.throws(
    () => parseOrThrow(z.string(), 42, 'field-name'),
    (error: unknown) => {
      assert.ok(error instanceof HaProtocolError);
      assert.match(error.message, /field-name\./u);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// positiveInt
// ---------------------------------------------------------------------------

test('positiveInt returns the fallback for undefined and validates supplied values', () => {
  assert.equal(positiveInt(undefined, 7, 'leaseDurationMs'), 7);
  assert.equal(positiveInt(1, 7, 'leaseDurationMs'), 1);
  assert.equal(positiveInt(Number.MAX_SAFE_INTEGER, 7, 'leaseDurationMs'), Number.MAX_SAFE_INTEGER);

  for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '5']) {
    assert.throws(
      () => positiveInt(value as unknown as number | undefined, 7, 'leaseDurationMs'),
      (error: unknown) => {
        assert.ok(error instanceof HaProtocolError);
        assert.equal(error.code, 'HA_INPUT_INVALID');
        assert.match(error.message, /leaseDurationMs must be a positive integer/u);
        return true;
      },
    );
  }
});

// ---------------------------------------------------------------------------
// validateTopology
// ---------------------------------------------------------------------------

test('validateTopology derives quorum from voting participants', () => {
  const topology = validateTopology([member('a'), member('b'), member('obs', 'observer')]);
  assert.equal(topology.schema_version, MWHA_PROTOCOL_SCHEMA_VERSION);
  assert.equal(topology.cluster_id, 'cluster');
  assert.equal(topology.members.length, 3);
  assert.equal(topology.quorum_size, 2, 'observers do not vote: floor(2/2)+1');

  const single = validateTopology([member('a')]);
  assert.equal(single.quorum_size, 1);
});

test('validateTopology rejects non-arrays, empty arrays and invalid members', () => {
  for (const members of [null, undefined, {}, 'members', 42]) {
    assertHaCode(() => validateTopology(members as never), 'TOPOLOGY_INVALID');
  }
  assertHaCode(() => validateTopology([]), 'TOPOLOGY_INVALID');

  const invalidMembers: readonly unknown[] = [
    {},
    { member_id: 'a' },
    { member_id: 'a', role: 'bogus' },
    { member_id: '', role: 'voting-member' },
    { member_id: 'bad id', role: 'writer' },
    { member_id: 'a', role: 'voting-member', extra: true },
    null,
    'a',
  ];
  for (const bad of invalidMembers) {
    assert.throws(
      () => validateTopology([bad] as never),
      (error: unknown) => error instanceof HaProtocolError && error.code === 'TOPOLOGY_INVALID',
    );
  }
});

test('validateTopology rejects duplicate member ids before parsing the topology', () => {
  assert.throws(
    () => validateTopology([member('a'), member('a', 'observer')]),
    (error: unknown) => {
      assert.ok(error instanceof HaProtocolError);
      assert.equal(error.code, 'TOPOLOGY_INVALID');
      assert.match(error.message, /duplicate member_id a/u);
      return true;
    },
  );
});

test('validateTopology rethrows HaProtocolError from the frozen contract unchanged', () => {
  // No voting participant: quorumSizeForMembers throws inside the try block and
  // must propagate as the same HaProtocolError (no wrapping).
  assert.throws(
    () => validateTopology([member('o1', 'observer'), member('o2', 'observer')]),
    (error: unknown) => {
      assert.ok(error instanceof HaProtocolError);
      assert.equal(error.code, 'TOPOLOGY_INVALID');
      assert.match(error.message, /at least one voting participant/u);
      return true;
    },
  );
});

test('validateTopology wraps a non-HaProtocolError contract violation with its cause', () => {
  // Hostile input: the per-member schema read succeeds once, then the property
  // throws during quorum derivation inside the try block. This exercises the
  // documented catch-all wrap without mocking Zod's parse result.
  let reads = 0;
  const hostile = {
    member_id: 'a',
    get role(): MwhaMember['role'] {
      reads += 1;
      if (reads >= 2) throw new Error('hostile role read');
      return 'voting-member';
    },
  };
  assert.throws(
    () => validateTopology([hostile as unknown as MwhaMember]),
    (error: unknown) => {
      assert.ok(error instanceof HaProtocolError);
      assert.equal(error.code, 'TOPOLOGY_INVALID');
      assert.match(error.message, /topology violates the frozen contract/u);
      assert.match(error.message, /hostile role read/u);
      assert.ok(error.cause instanceof Error, 'the original error must be preserved as cause');
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// validateVoters
// ---------------------------------------------------------------------------

test('validateVoters accepts exactly one channel per remote voting member', () => {
  // `votingMembers` here is the voting-participant list: observers are not
  // passed to this helper by LeaderLeaseManager.
  const members = [member('a'), member('b'), member('c')];
  const voters = [voter('b'), voter('c')];
  const result = validateVoters(voters, members, 'a');
  assert.equal(result, voters, 'valid channels are returned unchanged');
});

test('validateVoters rejects malformed channel lists and channels', () => {
  const members = [member('a'), member('b'), member('c')];

  for (const voters of [null, undefined, {}, 'voters', 42]) {
    assert.throws(
      () => validateVoters(voters as never, members, 'a'),
      (error: unknown) => error instanceof HaProtocolError && error.code === 'TOPOLOGY_INVALID',
    );
  }
  for (const bad of [null, undefined, 'channel', 42]) {
    assert.throws(
      () => validateVoters([bad as unknown as VoterRpc], members, 'a'),
      (error: unknown) => {
        assert.ok(error instanceof HaProtocolError);
        assert.equal(error.code, 'TOPOLOGY_INVALID');
        assert.match(error.message, /each voter must be a VoterRpc object/u);
        return true;
      },
    );
  }
});

test('validateVoters refuses self-dials, outsiders, duplicates and wrong counts', () => {
  const members = [member('a'), member('b'), member('c')];

  assert.throws(
    () => validateVoters([voter('a'), voter('b')], members, 'a'),
    (error: unknown) => {
      assert.ok(error instanceof HaProtocolError);
      assert.match(error.message, /must not dial itself/u);
      return true;
    },
  );
  assert.throws(
    () => validateVoters([voter('z'), voter('b')], members, 'a'),
    (error: unknown) => {
      assert.ok(error instanceof HaProtocolError);
      assert.match(error.message, /is not a voting member/u);
      return true;
    },
  );
  // Non-member targets are rejected as outsiders before the count check.
  assert.throws(
    () => validateVoters([voter('obs'), voter('b')], members, 'a'),
    (error: unknown) => {
      assert.ok(error instanceof HaProtocolError);
      assert.match(error.message, /is not a voting member/u);
      return true;
    },
  );
  assert.throws(
    () => validateVoters([voter('b'), voter('b')], members, 'a'),
    (error: unknown) => {
      assert.ok(error instanceof HaProtocolError);
      assert.match(error.message, /duplicate voter channel for b/u);
      return true;
    },
  );

  // Too few and too many channels both fail closed with the derived count.
  assert.throws(
    () => validateVoters([voter('b')], members, 'a'),
    (error: unknown) => {
      assert.ok(error instanceof HaProtocolError);
      assert.match(error.message, /expected 2 remote voter channel\(s\) for a 3-voter cluster, got 1/u);
      return true;
    },
  );
  // The count guard's failure direction is also reached with zero channels;
  // a duplicate third channel is rejected earlier as a duplicate.
  assert.throws(
    () => validateVoters([], members, 'a'),
    (error: unknown) => {
      assert.ok(error instanceof HaProtocolError);
      assert.match(error.message, /expected 2 remote voter channel\(s\) for a 3-voter cluster, got 0/u);
      return true;
    },
  );
  assert.throws(
    () => validateVoters([voter('b'), voter('c'), voter('b')], members, 'a'),
    (error: unknown) => {
      assert.ok(error instanceof HaProtocolError);
      assert.match(error.message, /duplicate voter channel for b/u);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Declaration ordering keys
// ---------------------------------------------------------------------------

test('declarationKey and compareDeclarations order by epoch, term then leader id', () => {
  assert.equal(declarationKey(lease('b', 1, 2)), 'b\u00001\u00002');
  assert.equal(declarationKey(lease('a', 1, 1)), declarationKey(lease('a', 1, 1)));
  assert.notEqual(declarationKey(lease('a', 1, 1)), declarationKey(lease('b', 1, 1)));

  assert.equal(compareDeclarations(lease('a', 1, 1), lease('a', 1, 1)), 0);
  assert.equal(compareDeclarations(lease('z', 2, 1), lease('a', 1, 9)), 1, 'epoch dominates');
  assert.equal(compareDeclarations(lease('a', 1, 2), lease('a', 1, 1)), 1, 'term dominates');
  assert.equal(compareDeclarations(lease('a', 1, 1), lease('b', 1, 1)), -1, 'leader id breaks the tie');
  assert.equal(compareDeclarations(lease('b', 1, 1), lease('a', 1, 1)), 1);
});

test('compareCommitRecords orders by logical version then ledger hash', () => {
  const base = commitRecord();
  assert.equal(compareCommitRecords(base, base), 1, 'equal hashes still yield a deterministic sign');

  const newerEpoch = commitRecord({
    identity: identity('w1', 2, 1),
    version: { epoch: 2, commit_index: 1, writer_id: 'w1', local_seq: 1 },
  });
  assert.equal(compareCommitRecords(newerEpoch, base), 1);
  assert.equal(compareCommitRecords(base, newerEpoch), -1);

  const newerIndex = commitRecord({ commit_index: 2, version: { epoch: 1, commit_index: 2, writer_id: 'w1', local_seq: 1 } });
  assert.equal(compareCommitRecords(newerIndex, base), 1);

  const newerWriter = commitRecord({
    identity: identity('w2', 1, 1),
    version: { epoch: 1, commit_index: 1, writer_id: 'w2', local_seq: 1 },
  });
  assert.equal(compareCommitRecords(newerWriter, base), 1);
  assert.equal(compareCommitRecords(base, newerWriter), -1);

  const newerSeq = commitRecord({
    identity: identity('w1', 1, 1, 2),
    version: { epoch: 1, commit_index: 1, writer_id: 'w1', local_seq: 2 },
  });
  assert.equal(compareCommitRecords(newerSeq, base), 1);

  // Same version, different hashes: hash decides deterministically.
  const otherHash = commitRecord({ identity: identity('w1', 1, 1, 1, HASH_B) });
  assert.equal(compareCommitRecords(otherHash, base), 1, 'hash b > hash a');
  assert.equal(compareCommitRecords(base, otherHash), -1);
});

test('logicalVersionOf maps identity plus commit index into the four-field version', () => {
  assert.deepEqual(logicalVersionOf(identity('w1', 3, 2, 5, HASH_A), 11), {
    epoch: 3,
    commit_index: 11,
    writer_id: 'w1',
    local_seq: 5,
  });
});

// ---------------------------------------------------------------------------
// Single-leader assertion
// ---------------------------------------------------------------------------

test('assertSingleLeader accepts sequential leaders and repeats, rejects split brains', () => {
  assert.doesNotThrow(() => assertSingleLeader([]));
  assert.doesNotThrow(() => assertSingleLeader([lease('a', 1, 1)]));
  assert.doesNotThrow(() => assertSingleLeader([lease('a', 1, 1), lease('a', 1, 1)]));
  assert.doesNotThrow(() => assertSingleLeader([lease('a', 1, 1), lease('b', 1, 2), lease('c', 2, 1)]));

  assert.throws(
    () => assertSingleLeader([lease('b', 1, 1), lease('a', 1, 1)]),
    (error: unknown) => {
      assert.ok(error instanceof HaProtocolError);
      assert.equal(error.code, 'SPLIT_BRAIN');
      assert.match(error.message, /\(epoch=1, term=1\): a, b/u);
      return true;
    },
  );

  // Multiple conflicting (epoch, term) groups are summarised in epoch/term order.
  assert.throws(
    () => assertSingleLeader([
      lease('z', 2, 5),
      lease('y', 2, 5),
      lease('m', 1, 3),
      lease('k', 1, 3),
    ]),
    (error: unknown) => {
      assert.ok(error instanceof HaProtocolError);
      assert.equal(error.code, 'SPLIT_BRAIN');
      assert.match(error.message, /\(epoch=1, term=3\): k, m; \(epoch=2, term=5\): y, z/u);
      return true;
    },
  );

  assertHaCode(() => assertSingleLeader([{ ...lease('a', 1, 1), term: -1 }]), 'HA_INPUT_INVALID');
});
