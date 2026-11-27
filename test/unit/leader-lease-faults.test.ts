import assert from 'node:assert/strict';
import test from 'node:test';
import { HaProtocolError } from '../../src/memory/ha-protocol.ts';
import {
  InMemoryFaultController,
  InMemoryVoterRpc,
  MWHA_HEARTBEAT_RESPONSE_SCHEMA_VERSION,
  MWHA_VOTE_RESPONSE_SCHEMA_VERSION,
  TcpVoterRpcAdapter,
  type HeartbeatResponse,
  type VoteResponse,
  type VoterRpcTarget,
} from '../../src/memory/leader-lease.ts';

/**
 * T-136 fault-injection seam tests: the deterministic in-memory mesh must
 * validate its inputs fail-closed, expose an honest snapshot of its state and
 * exercise its real (short) delay path. The compile-time TCP adapter shape is
 * covered by a minimal contract test because it is not wired to tcp-transport.
 *
 * No OS-level partition is claimed: these are protocol-layer reachability
 * faults only.
 */

function assertHaCode(fn: () => unknown, expected: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof HaProtocolError, `expected HaProtocolError, got ${String(error)}`);
    assert.equal(error.code, expected);
    return true;
  });
}

function voteResponse(voterId: string): VoteResponse {
  return {
    schema_version: MWHA_VOTE_RESPONSE_SCHEMA_VERSION,
    granted: true,
    term: 1,
    epoch: 1,
    voter_id: voterId,
    leader_id: null,
    detail: 'unit fixture grant',
  };
}

function heartbeatResponse(voterId: string): HeartbeatResponse {
  return {
    schema_version: MWHA_HEARTBEAT_RESPONSE_SCHEMA_VERSION,
    accepted: true,
    term: 1,
    epoch: 1,
    voter_id: voterId,
    leader_id: null,
    detail: 'unit fixture heartbeat',
  };
}

test('T-136 faults: InMemoryFaultController validates partitions, isolation and delays', { timeout: 60_000 }, () => {
  const faults = new InMemoryFaultController();

  assertHaCode(() => faults.partition([[]]), 'HA_INPUT_INVALID');
  assertHaCode(() => faults.partition(['not-an-array' as unknown as readonly string[]]), 'HA_INPUT_INVALID');
  assertHaCode(() => faults.partition([['']]), 'HA_INPUT_INVALID');
  assertHaCode(() => faults.partition([[7 as unknown as string]]), 'HA_INPUT_INVALID');
  assertHaCode(() => faults.partition([['a'], ['a']]), 'HA_INPUT_INVALID');
  assertHaCode(() => faults.isolate(''), 'HA_INPUT_INVALID');
  assertHaCode(() => faults.isolate(7 as unknown as string), 'HA_INPUT_INVALID');
  assertHaCode(() => faults.setDelay(-1), 'HA_INPUT_INVALID');
  assertHaCode(() => faults.setDelay(1.5), 'HA_INPUT_INVALID');
  assertHaCode(() => faults.setDelay(Number.NaN), 'HA_INPUT_INVALID');

  faults.setDelay(0);
  assert.equal(faults.delayMs, 0);

  faults.partition([['b', 'a'], ['c']]);
  faults.isolate('d');
  assert.equal(faults.allows('a', 'b'), true);
  assert.equal(faults.allows('b', 'a'), true);
  assert.equal(faults.allows('a', 'c'), false);
  assert.equal(faults.allows('c', 'a'), false);
  assert.equal(faults.allows('d', 'a'), false);
  assert.equal(faults.allows('a', 'd'), false);
  assert.equal(faults.allows('unlisted', 'a'), false);

  // Snapshot output is deterministically sorted at both levels.
  assert.deepEqual(faults.snapshot(), {
    partitions: [['a', 'b'], ['c']],
    isolated: ['d'],
    delayMs: 0,
  });

  faults.restore();
  assert.equal(faults.allows('a', 'c'), true);
  assert.deepEqual(faults.snapshot(), { partitions: [], isolated: [], delayMs: 0 });
});

test('T-136 faults: InMemoryVoterRpc exposes voter_id, validates latency and refuses unregistered targets', { timeout: 60_000 }, async () => {
  const target: VoterRpcTarget = {
    member_id: 'target',
    handleVoteRequest: () => voteResponse('target'),
    handleHeartbeat: () => heartbeatResponse('target'),
  };

  const rpc = new InMemoryVoterRpc({
    voter_id: 'source',
    target_id: 'target',
    resolveTarget: () => target,
    faults: new InMemoryFaultController(),
  });
  assert.equal(rpc.target_id, 'target');
  assert.equal(rpc.voter_id, 'source');
  const granted = await rpc.requestVote({ schema_version: 'mwha.vote-request.v1', term: 1, epoch: 1, candidate_id: 'source' });
  assert.equal(granted.granted, true);

  assertHaCode(() => new InMemoryVoterRpc({
    voter_id: 'source',
    target_id: 'target',
    resolveTarget: () => target,
    latencyMs: 0.5,
  }), 'HA_INPUT_INVALID');
  // `latencyMs` may be omitted (meaning zero) but an explicit non-positive or
  // fractional value is refused rather than silently clamped.
  assertHaCode(() => new InMemoryVoterRpc({
    voter_id: 'source',
    target_id: 'target',
    resolveTarget: () => target,
    latencyMs: 0,
  }), 'HA_INPUT_INVALID');

  const unregistered = new InMemoryVoterRpc({
    voter_id: 'source',
    target_id: 'ghost',
    resolveTarget: () => undefined,
  });
  await assert.rejects(
    () => unregistered.sendHeartbeat({
      schema_version: 'mwha.heartbeat-request.v1',
      lease: { term: 1, leader_id: 'source', epoch: 1 },
    }),
    (error: unknown) => error instanceof HaProtocolError && error.code === 'QUORUM_NOT_REACHED',
  );
});

test('T-136 faults: a real short artificial delay is honoured without leaving a timer behind', { timeout: 60_000 }, async () => {
  const faults = new InMemoryFaultController();
  faults.setDelay(25);
  const rpc = new InMemoryVoterRpc({
    voter_id: 'source',
    target_id: 'target',
    resolveTarget: () => ({
      member_id: 'target',
      handleVoteRequest: () => voteResponse('target'),
      handleHeartbeat: () => heartbeatResponse('target'),
    }),
    faults,
  });

  const started = Date.now();
  await rpc.requestVote({ schema_version: 'mwha.vote-request.v1', term: 1, epoch: 1, candidate_id: 'source' });
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 15, `artificial delay was not applied: ${String(elapsed)}ms`);
  assert.ok(elapsed < 200, `artificial delay overran its budget: ${String(elapsed)}ms`);
});

test('T-136 faults: TcpVoterRpcAdapter is a parse-or-throw contract seam', { timeout: 60_000 }, async () => {
  const sent: { kind: string; payload: unknown }[] = [];
  const adapter = new TcpVoterRpcAdapter({
    voter_id: 'source',
    target_id: 'target',
    send: async (kind, payload) => {
      sent.push({ kind, payload });
      return voteResponse('target');
    },
  });
  assert.equal(adapter.target_id, 'target');
  assert.equal(adapter.voter_id, 'source');

  const vote = await adapter.requestVote({ schema_version: 'mwha.vote-request.v1', term: 1, epoch: 1, candidate_id: 'source' });
  assert.equal(vote.granted, true);
  assert.equal(sent[0]!.kind, 'vote-request');

  const heartbeatAdapter = new TcpVoterRpcAdapter({
    voter_id: 'source',
    target_id: 'target',
    send: async (kind, payload) => {
      sent.push({ kind, payload });
      return heartbeatResponse('target');
    },
  });
  const heartbeat = await heartbeatAdapter.sendHeartbeat({
    schema_version: 'mwha.heartbeat-request.v1',
    lease: { term: 1, leader_id: 'source', epoch: 1 },
  });
  assert.equal(heartbeat.accepted, true);
  assert.equal(sent[1]!.kind, 'heartbeat');

  // Malformed wire payloads are refused, never trusted.
  const liar = new TcpVoterRpcAdapter({
    voter_id: 'source',
    target_id: 'target',
    send: async () => ({ unexpected: true }),
  });
  await assert.rejects(
    () => liar.requestVote({ schema_version: 'mwha.vote-request.v1', term: 1, epoch: 1, candidate_id: 'source' }),
    (error: unknown) => error instanceof HaProtocolError && error.code === 'HA_INPUT_INVALID',
  );
});
