/**
 * T-139 / HA-07 integration: a real 3/4-node local-TCP cluster (every node a
 * real frozen `TcpReplicaServer` plus a real HA TCP endpoint) validates
 * split-brain safety end to end:
 *
 * - fully connected: election + quorum-backed commit;
 * - 2+1 partition: majority elects a fresh epoch/term and commits, the minority
 *   old leader cannot commit, and after restore it demotes and catches up
 *   without overwriting the new leader;
 * - 1+1+1 and 4-node 2+2: no partition reaches quorum, so nothing commits;
 * - same-(epoch,term) dual master is refused;
 * - forks retain every branch, adjudication must be complete, and uncommitted
 *   branches never produce Gate evidence;
 * - close releases every socket/proxy/listener.
 *
 * SCOPE: these are real loopback TCP frames through a real protocol-layer fault
 * proxy. Local TCP + proxy ≠ OS true partition; physical three-machine clusters,
 * kernel partitions and production HA/SLA remain unverified.
 */

import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import {
  hashEvent,
  ledgerEventSchema,
  type LedgerEvent,
} from '../../src/ledger/event.ts';
import {
  HaProtocolError,
  MWHA_ADJUDICATION_SCHEMA_VERSION,
  MWHA_EVENT_SCHEMA_VERSION,
  MWHA_PROJECTION_STATE_SCHEMA_VERSION,
  assertAdjudicationComplete,
  assertGateBoundary,
  detectMultipleLeaders,
  evaluatePartitions,
  mwhaProjectionStateSchema,
  type MwhaAdjudication,
  type MwhaLeaderLease,
  type MwhaProjectionState,
  type MwhaWriterEvent,
} from '../../src/memory/ha-protocol.ts';
import {
  HA_CLUSTER_VERIFICATION_NOTE,
  HaCluster,
  type HaClusterOptions,
  type HaNode,
} from '../../src/memory/ha-cluster.ts';
import { TcpReplicaClient } from '../../src/memory/tcp-transport.ts';
import type { MultiWriterSlotState } from '../../src/memory/multi-writer.ts';

const HASH_A = 'a'.repeat(64);
const WRITER_ID = 'writer-1';
const ID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function ulidLike(seed: number): string {
  let value = seed >>> 0;
  let out = '';
  for (let index = 0; index < 26; index += 1) {
    out += ID_ALPHABET[value % 32];
    value = Math.floor(value / 32) + index * 7 + 1;
  }
  return out;
}

function makeLedgerEvent(label: string, seed: number): LedgerEvent {
  const event = {
    id: ulidLike(seed),
    hlc: { physical: 1_700_000_000_000 + seed, logical: 0, actor: WRITER_ID },
    actor: WRITER_ID,
    kind: 'note.recorded' as const,
    payload: { label, seed },
    idem_key: `t139-${label}`,
    prev_hash: '0'.repeat(64),
  };
  const parsed = ledgerEventSchema.parse(event);
  return parsed;
}

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

async function expectCode(run: () => unknown | Promise<unknown>, code: string): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    assert.equal(codeOf(error), code, `expected ${code}, got ${String(error)}`);
    return error;
  }
  assert.fail(`expected ${code} to be thrown`);
}

async function startCluster(t: TestContext, options: HaClusterOptions = {}): Promise<HaCluster> {
  const cluster = await HaCluster.start({ leaseDurationMs: 5_000, ...options });
  t.after(async () => {
    await cluster.close();
  });
  return cluster;
}

function proposeInput(
  memberId: string,
  event: LedgerEvent,
  epoch: number,
  term: number,
  localSeq: number,
  ledgerEventHash: string = hashEvent(event),
) {
  return {
    memberId,
    writerId: WRITER_ID,
    epoch,
    term,
    localSeq,
    ledgerEvent: event,
    ledgerEventHash,
  };
}

function logHashes(node: HaNode): string[] {
  return node.log.getEntries().map((record) => record.entry.identity.ledger_event_hash);
}

function findState(projection: { states: readonly MultiWriterSlotState[] }, localSeq: number): MultiWriterSlotState {
  const state = projection.states.find((candidate) => candidate.conflict_key.local_seq === localSeq);
  assert.ok(state !== undefined, `projection must expose state for local_seq ${String(localSeq)}`);
  return state;
}

function writerEvent(identity: MwhaWriterEvent['identity'], leader: MwhaLeaderLease): MwhaWriterEvent {
  return { schema_version: MWHA_EVENT_SCHEMA_VERSION, identity, leader };
}

test('T-139 integration: a fully connected 3-node cluster elects and commits with real TCP acks', { timeout: 120_000 }, async (t) => {
  const cluster = await startCluster(t);
  const first = await cluster.elect('n1');
  assert.equal(first.won, true);
  assert.equal(first.votes, 3);
  assert.equal(first.quorum_size, 2);

  const event = makeLedgerEvent('baseline', 1);
  const result = await cluster.propose(proposeInput('n1', event, first.epoch, first.term, 1));
  assert.equal(result.committed, true);
  assert.equal(result.commit_index, 1);
  assert.equal(result.acks.length, 3);
  assert.deepEqual([...result.acks].sort(), ['n1', 'n2', 'n3']);
  assert.equal(result.replicated_to.length, 2);

  const status = cluster.status();
  assert.equal(status.leader_id, 'n1');
  assert.equal(status.nodes.find((node) => node.member_id === 'n1')?.role, 'leader');
  assert.ok(result.evidence_id !== null && result.evidence_id.length > 0);

  const projection = cluster.projection();
  assert.equal(projection.gate_ok, true);
  const state = findState(projection, 1);
  assert.equal(state.status, 'committed');
  assert.equal(state.evidence_id, result.evidence_id);
  assert.equal(projection.verification_scope, 'local-tcp-protocol-only');

  // Every node really received the committed entry over its TCP link.
  for (const memberId of cluster.memberIds) {
    assert.deepEqual(logHashes(cluster.node(memberId)), [hashEvent(event)]);
  }
});

test('T-139 integration: 2+1 partition commits on the majority side with a new epoch/term and refuses the isolated old leader', { timeout: 120_000 }, async (t) => {
  const cluster = await startCluster(t);
  const first = await cluster.elect('n1');
  const eventA = makeLedgerEvent('old-leader', 2);
  const commitA = await cluster.propose(proposeInput('n1', eventA, first.epoch, first.term, 1));
  assert.equal(commitA.commit_index, 1);

  await cluster.isolate([['n2', 'n3'], ['n1']]);
  assert.equal(cluster.evaluateCurrentPartitions().any_commit, true);

  // Isolated old leader: proposal gets no real TCP ack from the majority.
  const staleAttempt = makeLedgerEvent('isolated-attempt', 3);
  await expectCode(
    () => cluster.propose(proposeInput('n1', staleAttempt, first.epoch, first.term, 2)),
    'QUORUM_NOT_REACHED',
  );
  assert.equal(cluster.node('n1').log.size, 1, 'an unsuccessful minority proposal must not append');

  // Majority elects a strictly newer epoch/term and commits.
  const second = await cluster.elect('n2');
  assert.equal(second.won, true);
  assert.equal(second.votes, 2);
  assert.ok(second.term > first.term);
  assert.ok(second.epoch > first.epoch);

  const eventB = makeLedgerEvent('new-leader', 4);
  const commitB = await cluster.propose(proposeInput('n2', eventB, second.epoch, second.term, 1));
  assert.equal(commitB.committed, true);
  assert.deepEqual([...commitB.acks].sort(), ['n2', 'n3']);
  assert.deepEqual(logHashes(cluster.node('n3')), [hashEvent(eventA), hashEvent(eventB)]);

  // Restore, then the old leader demotes and catches up without overwriting.
  await cluster.restore();
  const rejoin = await cluster.rejoin('n1');
  assert.equal(rejoin.rejoined, true);
  assert.equal(rejoin.adopted_epoch, second.epoch);
  assert.equal(rejoin.adopted_term, second.term);
  assert.equal(rejoin.adopted_leader_id, 'n2');
  assert.equal(cluster.node('n1').manager.role, 'follower');
  assert.ok(logHashes(cluster.node('n1')).includes(hashEvent(eventB)), 'old leader must catch up the new leader record');

  const n2Hashes = logHashes(cluster.node('n2'));
  assert.deepEqual(n2Hashes, [hashEvent(eventA), hashEvent(eventB)], 'rejoin must not overwrite or reorder the new leader log');

  await expectCode(
    () => cluster.propose(proposeInput('n1', makeLedgerEvent('post-rejoin', 5), second.epoch, second.term, 2)),
    'FENCE_REJECTED',
  );
});

test('T-139 integration: a 1+1+1 split reaches no quorum and commits nothing', { timeout: 120_000 }, async (t) => {
  const cluster = await startCluster(t);
  // Elect a real leader while connected, then cut every link so even the
  // lease holder is alone on a 1-vote side.
  const first = await cluster.elect('n2');
  assert.equal(first.won, true);

  await cluster.isolate([['n1'], ['n2'], ['n3']]);
  assert.equal(cluster.evaluateCurrentPartitions().any_commit, false);
  assert.deepEqual([...cluster.evaluateCurrentPartitions().blocked_partitions].sort(), [1, 1, 1]);
  assert.deepEqual(evaluatePartitions([1, 1, 1], 3).committing_partitions, []);

  // The isolated old leader holds a live lease but cannot reach any voter.
  const event = makeLedgerEvent('no-quorum', 6);
  await expectCode(
    () => cluster.propose(proposeInput('n2', event, first.epoch, first.term, 1)),
    'QUORUM_NOT_REACHED',
  );
  assert.equal(cluster.node('n2').log.size, 0);

  const election = await cluster.elect('n1');
  assert.equal(election.won, false);
  assert.equal(election.votes, 1);
  assert.deepEqual([...election.unreachable].sort(), ['n2', 'n3']);

  await cluster.restore();
  const restored = await cluster.elect('n3');
  assert.equal(restored.won, true, 'connectivity restoration must allow a fresh election');
});

test('T-139 integration: a 4-node 2+2 split never commits on either side', { timeout: 120_000 }, async (t) => {
  const cluster = await startCluster(t, { memberIds: ['n1', 'n2', 'n3', 'n4'] });
  assert.equal(cluster.quorumSize, 3);
  // A real leader exists before the symmetric split.
  const first = await cluster.elect('n1');
  assert.equal(first.won, true);

  await cluster.isolate([['n1', 'n2'], ['n3', 'n4']]);
  assert.equal(cluster.evaluateCurrentPartitions().any_commit, false);
  assert.deepEqual(evaluatePartitions([2, 2], 4).blocked_partitions, [2, 2]);

  // The old leader's side has exactly 2 votes: below Q=3, so no commit.
  await expectCode(
    () => cluster.propose(proposeInput('n1', makeLedgerEvent('left', 7), first.epoch, first.term, 1)),
    'QUORUM_NOT_REACHED',
  );

  const left = await cluster.elect('n1');
  assert.equal(left.won, false);
  assert.equal(left.votes, 2);
  const right = await cluster.elect('n3');
  assert.equal(right.won, false);
  assert.equal(right.votes, 2);

  await expectCode(
    () => cluster.propose(proposeInput('n3', makeLedgerEvent('right', 8), 1, 1, 1)),
    'FENCE_REJECTED',
  );
  assert.equal(cluster.node('n1').log.size, 0);
  assert.equal(cluster.node('n3').log.size, 0);
});

test('T-139 integration: two leaders claiming the same (epoch, term) are refused', { timeout: 120_000 }, async (t) => {
  const cluster = await startCluster(t);
  const first = await cluster.elect('n1');
  assert.equal(first.won, true);
  // Real leader heartbeats make n2/n3 adopt the n1 lease before the rival claim.
  const renewal = await cluster.node('n1').manager.renewLease();
  assert.equal(renewal.renewed, true);

  const rivalLease: MwhaLeaderLease = { term: first.term, leader_id: 'n2', epoch: first.epoch };
  await expectCode(() => cluster.assertNoRivalLeader('n2', rivalLease), 'SPLIT_BRAIN');

  const observation = cluster.node('n2').manager.observeLease(rivalLease);
  assert.equal(observation.action, 'split-brain');
  assert.equal(observation.code, 'FENCE_SPLIT_BRAIN_SAME_TERM');
  assert.equal(observation.adopted, false);

  assert.equal(detectMultipleLeaders(cluster.node('n2').manager.collectDeclarations()).length, 1);
  assert.equal(cluster.status().multiple_leaders.length, 1);

  await expectCode(
    () => cluster.propose(proposeInput('n2', makeLedgerEvent('dual-master', 9), first.epoch, first.term, 1)),
    'FENCE_REJECTED',
  );
});

test('T-139 integration: forks keep every branch, adjudication is complete, and uncommitted branches yield no Gate evidence', { timeout: 120_000 }, async (t) => {
  const cluster = await startCluster(t);
  const first = await cluster.elect('n1');

  const eventA = makeLedgerEvent('branch-a', 10);
  const hashA = hashEvent(eventA);
  const committed = await cluster.propose(proposeInput('n1', eventA, first.epoch, first.term, 1));
  assert.equal(committed.evidence_id !== null, true);

  const eventB = makeLedgerEvent('branch-b', 11);
  const hashB = hashEvent(eventB);
  const leaderLease = cluster.node('n1').manager.currentLease;
  assert.ok(leaderLease !== null);
  const appendedB = cluster.node('n1').log.append({
    event: writerEvent({ writer_id: WRITER_ID, epoch: first.epoch, term: first.term, local_seq: 1, ledger_event_hash: hashB }, leaderLease),
    ledgerEvent: eventB,
    ledgerEventHash: hashB,
    commitIndex: 2,
  });
  assert.equal(appendedB.kind, 'conflict');

  const conflicted = cluster.projection();
  const conflictState = findState(conflicted, 1);
  assert.equal(conflictState.status, 'conflicted');
  assert.equal(conflictState.branches.length, 2);
  assert.equal(conflictState.evidence_id, null);
  assert.equal(conflictState.produces_gate_evidence, false);
  assertGateBoundary(conflictState);

  const completeBranches = [...conflictState.branches];
  const foreignHash = 'c'.repeat(64);
  const foreignBranch = {
    branch_id: `branch-${foreignHash.slice(0, 16)}`,
    identity: { writer_id: WRITER_ID, epoch: first.epoch, term: first.term, local_seq: 1, ledger_event_hash: foreignHash },
    ledger_event_hash: foreignHash,
  };
  // Schema-valid (two distinct branches), but it does not cover the actual
  // retained branch set, so the frozen completeness assertion must fail.
  const incomplete: MwhaAdjudication = {
    schema_version: MWHA_ADJUDICATION_SCHEMA_VERSION,
    conflict_key: { writer_id: WRITER_ID, epoch: first.epoch, local_seq: 1 },
    branches: [completeBranches[0]!, foreignBranch],
    branch_hashes: [completeBranches[0]!.ledger_event_hash, foreignHash],
    status: 'resolved',
    selected_branch_id: completeBranches[0]!.branch_id,
    resolution_reason: 'incomplete attempt',
  };
  await expectCode(() => assertAdjudicationComplete(incomplete, completeBranches), 'ADJUDICATION_INCOMPLETE');
  await expectCode(() => cluster.node('n1').log.adjudicate(incomplete), 'ADJUDICATION_INCOMPLETE');

  const resolved: MwhaAdjudication = {
    schema_version: MWHA_ADJUDICATION_SCHEMA_VERSION,
    conflict_key: { writer_id: WRITER_ID, epoch: first.epoch, local_seq: 1 },
    branches: completeBranches,
    branch_hashes: completeBranches.map((branch) => branch.ledger_event_hash),
    status: 'resolved',
    selected_branch_id: completeBranches[0]!.branch_id,
    resolution_reason: 'integration fixture resolves the retained fork explicitly',
  };
  assertAdjudicationComplete(resolved, completeBranches);
  cluster.node('n1').log.adjudicate(resolved);

  const resolvedProjection = cluster.projection();
  const resolvedState = findState(resolvedProjection, 1);
  assert.equal(resolvedState.status, 'committed');
  assert.equal(resolvedState.winning_branch_id, completeBranches[0]!.branch_id);
  assert.ok(resolvedState.evidence_id !== null);
  assertGateBoundary(resolvedState);

  // An uncommitted proposal never becomes a fact and never carries evidence.
  const eventC = makeLedgerEvent('uncommitted', 12);
  const hashC = hashEvent(eventC);
  cluster.node('n1').log.append({
    event: writerEvent({ writer_id: WRITER_ID, epoch: first.epoch, term: first.term, local_seq: 2, ledger_event_hash: hashC }, leaderLease),
    ledgerEvent: eventC,
    ledgerEventHash: hashC,
    commitIndex: 0,
    status: 'proposed',
  });
  const withProposed = cluster.projection();
  const uncommittedState = findState(withProposed, 2);
  assert.equal(uncommittedState.status, 'uncommitted');
  assert.equal(uncommittedState.evidence_id, null);
  assert.equal(uncommittedState.produces_gate_evidence, false);
  assert.equal(withProposed.entries.some((entry) => entry.identity.ledger_event_hash === hashC), false);
  assertGateBoundary(uncommittedState);

  const fabricated = {
    schema_version: MWHA_PROJECTION_STATE_SCHEMA_VERSION,
    conflict_key: { writer_id: WRITER_ID, epoch: first.epoch, local_seq: 2 },
    status: 'committed',
    winning_branch_id: null,
    evidence_id: null,
    produces_gate_evidence: true,
  };
  assert.equal(mwhaProjectionStateSchema.safeParse(fabricated).success, false);
  assert.throws(
    () => assertGateBoundary(fabricated as unknown as MwhaProjectionState),
    (error: unknown) => codeOf(error) === 'PROJECTION_GATE_FORBIDDEN',
  );

  assert.ok(hashA !== hashB);
  assert.ok(HA_CLUSTER_VERIFICATION_NOTE.includes('未验证'));
  assert.ok(HA_CLUSTER_VERIFICATION_NOTE.includes('≠ OS 真分区'));
});

test('T-139 integration: close releases every listener, proxy, client socket and timer', { timeout: 120_000 }, async (t) => {
  const cluster = await startCluster(t);
  const node = cluster.node('n1');
  await cluster.elect('n1');
  await cluster.isolate([['n1'], ['n2', 'n3']]);
  assert.ok(node.activeConnectionCount > 0 || cluster.resourceStats().proxies_open > 0);

  await cluster.close();
  assert.equal(cluster.isClosed, true);
  const stats = cluster.resourceStats();
  assert.equal(stats.nodes_open, 0);
  assert.equal(stats.ha_servers_open, 0);
  assert.equal(stats.replica_servers_open, 0);
  assert.equal(stats.proxies_open, 0);
  assert.equal(stats.clients_open, 0);
  assert.equal(stats.active_connections, 0);
  assert.equal(node.isClosed, true);
  assert.equal(node.haAddress, null);
  assert.equal(node.replicaAddress, null);
  assert.equal(node.activeConnectionCount, 0);
  assert.equal(node.manager.memberId, 'n1');

  // A second close is idempotent.
  await cluster.close();
});

test('T-139 integration: the frozen replica status surface reports the real node state', { timeout: 120_000 }, async (t) => {
  const cluster = await startCluster(t, { sharedSecret: 'ha-status-secret' });
  const first = await cluster.elect('n1');
  const event = makeLedgerEvent('status', 40);
  await cluster.propose(proposeInput('n1', event, first.epoch, first.term, 1));

  const node = cluster.node('n1');
  const replicaAddress = node.replicaAddress;
  assert.ok(replicaAddress !== null);
  const client = new TcpReplicaClient({
    host: replicaAddress.host,
    port: replicaAddress.port,
    nodeId: 'n1',
    sharedSecret: 'ha-status-secret',
  });
  t.after(async () => { await client.close(); });
  await client.connect();

  const status = await client.status({ timeoutMs: 1_000 });
  assert.equal(status.replicaId, 'n1');
  assert.equal(status.commitIndex, 1);
  assert.equal(status.state, 'ACTIVE');
  assert.equal(status.viewDigest, 'ha-cluster-view');
  assert.equal(status.snapshot.project_scope, 'ha-cluster');
  assert.equal(client.isConnected, true);
  await client.close();
  assert.equal(client.isConnected, false);
  assert.equal(client.isClosed, true);
});

test('T-139 integration: resourceStats accounts for every open server, proxy and connection', { timeout: 120_000 }, async (t) => {
  const cluster = await startCluster(t);
  await cluster.elect('n1');
  await cluster.isolate([['n1'], ['n2', 'n3']]);

  const during = cluster.resourceStats();
  assert.equal(during.nodes_open, 3);
  assert.equal(during.ha_servers_open, 3);
  assert.equal(during.replica_servers_open, 3);
  assert.ok(during.proxies_open >= 6, `expected a full directed proxy mesh, got ${String(during.proxies_open)}`);
  assert.equal(during.clients_open, 3);

  await cluster.close();
  const after = cluster.resourceStats();
  assert.deepEqual(after, {
    nodes_open: 0,
    ha_servers_open: 0,
    replica_servers_open: 0,
    proxies_open: 0,
    clients_open: 0,
    active_connections: 0,
  });
});
