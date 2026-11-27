/**
 * T-139 / HA-07 red-team boundary: attempts to forge a commit, bypass the lease
 * or quorum, overwrite the new leader from an old master, fabricate Gate
 * evidence from an uncommitted branch, or present the TCP proxy fault layer as
 * an OS-level partition are all refused.
 *
 * SCOPE: the boundary text asserted here is load-bearing. The injected faults
 * are TCP protocol-layer simulation only; local TCP + proxy ≠ OS true partition,
 * and physical three-machine deployment / production HA / SLA remain unverified.
 */

import assert from 'node:assert/strict';
import * as net from 'node:net';
import test, { type TestContext } from 'node:test';
import {
  hashEvent,
  ledgerEventSchema,
  type LedgerEvent,
} from '../../src/ledger/event.ts';
import {
  HaProtocolError,
  MWHA_ADJUDICATION_SCHEMA_VERSION,
  MWHA_PROJECTION_STATE_SCHEMA_VERSION,
  MWHA_UNVERIFIED_CAPABILITIES,
  assertAdjudicationComplete,
  assertGateBoundary,
  assertQuorum,
  detectMultipleLeaders,
  isUnverifiedCapability,
  mwhaLeaderLeaseSchema,
  mwhaProjectionStateSchema,
  type MwhaAdjudication,
  type MwhaLeaderLease,
  type MwhaProjectionState,
  type MwhaWriterEvent,
} from '../../src/memory/ha-protocol.ts';
import {
  HA_CLUSTER_FAULT_INJECTION_SCOPE_NOTE,
  HA_CLUSTER_VERIFICATION_NOTE,
  HaCluster,
  verifyProposalAcks,
  type HaClusterOptions,
  type HaNode,
} from '../../src/memory/ha-cluster.ts';
import { MWHA_EVENT_SCHEMA_VERSION } from '../../src/memory/ha-protocol.ts';
import { MWHA_HEARTBEAT_REQUEST_SCHEMA_VERSION } from '../../src/memory/leader-lease.ts';

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
  return ledgerEventSchema.parse({
    id: ulidLike(seed),
    hlc: { physical: 1_700_000_000_000 + seed, logical: 0, actor: WRITER_ID },
    actor: WRITER_ID,
    kind: 'note.recorded',
    payload: { label, seed },
    idem_key: `t139-redteam-${label}`,
    prev_hash: '0'.repeat(64),
  });
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

function proposeInput(memberId: string, event: LedgerEvent, epoch: number, term: number, localSeq: number) {
  return {
    memberId,
    writerId: WRITER_ID,
    epoch,
    term,
    localSeq,
    ledgerEvent: event,
    ledgerEventHash: hashEvent(event),
  };
}

function writerEvent(identity: MwhaWriterEvent['identity'], leader: MwhaLeaderLease): MwhaWriterEvent {
  return { schema_version: MWHA_EVENT_SCHEMA_VERSION, identity, leader };
}

function hashes(node: HaNode): string[] {
  return node.log.getEntries().map((record) => record.entry.identity.ledger_event_hash);
}

test('redteam T-139: stale term/epoch and non-leader writes are refused with precise fencing codes', { timeout: 120_000 }, async (t) => {
  const cluster = await startCluster(t);
  const first = await cluster.elect('n1');
  assert.equal(first.won, true);

  // Force a strictly newer epoch/term through a real election.
  const second = await cluster.elect('n2');
  assert.equal(second.won, true);
  assert.ok(second.epoch > first.epoch);
  assert.ok(second.term > first.term);

  // Old epoch -> FENCE_EPOCH_ROLLBACK even though this node is now the leader.
  await expectCode(
    () => cluster.propose(proposeInput('n2', makeLedgerEvent('stale-epoch', 20), first.epoch, first.term, 1)),
    'FENCE_EPOCH_ROLLBACK',
  );

  // Same epoch, older term -> FENCE_STALE_TERM.
  await expectCode(
    () => cluster.propose(proposeInput('n2', makeLedgerEvent('stale-term', 21), second.epoch, first.term, 1)),
    'FENCE_STALE_TERM',
  );

  // The demoted old leader cannot write under the new lease.
  await expectCode(
    () => cluster.propose(proposeInput('n1', makeLedgerEvent('old-leader', 22), second.epoch, second.term, 1)),
    'FENCE_REJECTED',
  );
  assert.equal(cluster.node('n1').log.size, 0);
});

test('redteam T-139: an expired lease cannot bypass the commit gate', { timeout: 120_000 }, async (t) => {
  // Frozen local gate: an expired lease stops commits immediately.
  const direct = await startCluster(t, { leaseDurationMs: 5_000 });
  const directElection = await direct.elect('n1');
  direct.advanceClock(5_001);
  assert.equal(direct.node('n1').manager.isLeaseExpired(), true);
  await expectCode(
    () => direct.node('n1').manager.assertCanCommit({
      writer_id: WRITER_ID,
      epoch: directElection.epoch,
      term: directElection.term,
      local_seq: 1,
      ledger_event_hash: 'd'.repeat(64),
    }),
    'QUORUM_NOT_REACHED',
  );

  // Cluster gate: the quorum round trip completes, then the frozen lease gate
  // refuses and demotes before any log append happens.
  const cluster = await startCluster(t, { leaseDurationMs: 5_000 });
  const first = await cluster.elect('n1');
  assert.equal(first.won, true);
  assert.equal(cluster.node('n1').manager.isLeaseExpired(), false);

  cluster.advanceClock(5_001);
  assert.equal(cluster.node('n1').manager.isLeaseExpired(), true);

  await expectCode(
    () => cluster.propose(proposeInput('n1', makeLedgerEvent('expired-lease', 23), first.epoch, first.term, 1)),
    'QUORUM_NOT_REACHED',
  );
  assert.equal(cluster.node('n1').manager.role, 'follower', 'the frozen lease manager must demote on expiry');
  assert.equal(cluster.node('n1').log.size, 0);
});

test('redteam T-139: forged, duplicated, unexpected or absent majority acks are rejected', { timeout: 120_000 }, async (t) => {
  const cluster = await startCluster(t);
  const expected = ['n2', 'n3'];

  await expectCode(() => verifyProposalAcks(['ghost'], expected, 3), 'HA_INPUT_INVALID');
  await expectCode(() => verifyProposalAcks(['n2', 'n2'], expected, 3), 'HA_INPUT_INVALID');
  await expectCode(() => verifyProposalAcks(['n1'], expected, 3), 'HA_INPUT_INVALID');
  await expectCode(() => verifyProposalAcks([], expected, 3), 'QUORUM_NOT_REACHED');
  await expectCode(() => verifyProposalAcks(['n2'], expected, 4), 'QUORUM_NOT_REACHED');
  assert.doesNotThrow(() => verifyProposalAcks(['n2'], expected, 3));

  // A real commit counts exactly the real voters that answered over TCP.
  const first = await cluster.elect('n1');
  const result = await cluster.propose(proposeInput('n1', makeLedgerEvent('real-acks', 24), first.epoch, first.term, 1));
  assert.deepEqual([...result.acks].sort(), ['n1', 'n2', 'n3']);
  assert.equal(result.replication_failures.length, 0);
});

test('redteam T-139: bypassing quorum is refused by every guarded entry point', { timeout: 120_000 }, async (t) => {
  const cluster = await startCluster(t);
  await expectCode(() => assertQuorum(1, 3), 'QUORUM_NOT_REACHED');
  await expectCode(() => assertQuorum(2, 4), 'QUORUM_NOT_REACHED');
  assert.doesNotThrow(() => assertQuorum(2, 3));

  // Isolate the current lease holder: the network round trip, not a local
  // boolean, is what denies the commit.
  const first = await cluster.elect('n1');
  await cluster.isolate([['n1'], ['n2'], ['n3']]);
  await expectCode(
    () => cluster.propose(proposeInput('n1', makeLedgerEvent('bypass-quorum', 25), first.epoch, first.term, 1)),
    'QUORUM_NOT_REACHED',
  );
  assert.equal(cluster.node('n1').log.size, 0);
  assert.equal(cluster.projection().entries.length, 0);
});

test('redteam T-139: an old master cannot overwrite the new master after rejoin', { timeout: 120_000 }, async (t) => {
  const cluster = await startCluster(t);
  const first = await cluster.elect('n1');
  const eventA = makeLedgerEvent('before-split', 26);
  await cluster.propose(proposeInput('n1', eventA, first.epoch, first.term, 1));

  await cluster.isolate([['n2', 'n3'], ['n1']]);
  const second = await cluster.elect('n2');
  const eventB = makeLedgerEvent('new-master-record', 27);
  const hashB = hashEvent(eventB);
  const commitB = await cluster.propose(proposeInput('n2', eventB, second.epoch, second.term, 1));
  assert.equal(commitB.committed, true);

  await cluster.restore();
  await cluster.rejoin('n1');

  // The old master may not propose any more.
  await expectCode(
    () => cluster.propose(proposeInput('n1', makeLedgerEvent('post-rejoin-write', 28), second.epoch, second.term, 2)),
    'FENCE_REJECTED',
  );

  // An overwrite attempt against the new master's exact slot becomes a retained
  // competing branch, never a replacement; the new leader's copy is untouched.
  const staleEvent = makeLedgerEvent('overwrite-attempt', 29);
  const staleHash = hashEvent(staleEvent);
  const newLeaderLease = cluster.node('n2').manager.currentLease;
  assert.ok(newLeaderLease !== null);
  cluster.node('n1').log.append({
    event: writerEvent(
      { writer_id: WRITER_ID, epoch: second.epoch, term: second.term, local_seq: 1, ledger_event_hash: staleHash },
      newLeaderLease,
    ),
    ledgerEvent: staleEvent,
    ledgerEventHash: staleHash,
    commitIndex: 99,
  });

  const oldLog = cluster.node('n1').log;
  assert.equal(oldLog.forkReport().conflicts.length, 1);
  const conflict = oldLog.forkReport().conflicts[0]!;
  assert.equal(conflict.branch_count, 2);
  const retainedHashes = conflict.branches.map((branch) => branch.ledger_event_hash);
  assert.ok(retainedHashes.includes(hashB), 'the new master branch must be retained');
  assert.ok(retainedHashes.includes(staleHash), 'a competing branch is retained, not applied as an overwrite');

  const projected = cluster.projection();
  assert.equal(projected.gate_ok, true);
  const conflictState = projected.states.find((state) => state.conflict_key.local_seq === 1 && state.conflict_key.epoch === second.epoch);
  assert.ok(conflictState !== undefined);
  assert.equal(conflictState.status, 'conflicted');
  assert.equal(conflictState.evidence_id, null, 'an unresolved fork cannot become a Gate fact');

  // The new leader's log was never modified by the old master's write.
  assert.deepEqual(hashes(cluster.node('n2')), [hashEvent(eventA), hashB]);

  // Explicit, complete adjudication may converge the slot; the new master's
  // branch is selectable without dropping the old one.
  const branches = [...conflict.branches];
  const selectB = branches.find((branch) => branch.ledger_event_hash === hashB)!;
  const adjudication: MwhaAdjudication = {
    schema_version: MWHA_ADJUDICATION_SCHEMA_VERSION,
    conflict_key: { writer_id: WRITER_ID, epoch: second.epoch, local_seq: 1 },
    branches,
    branch_hashes: branches.map((branch) => branch.ledger_event_hash),
    status: 'resolved',
    selected_branch_id: selectB.branch_id,
    resolution_reason: 'red-team fixture resolves to the new master branch explicitly',
  };
  assertAdjudicationComplete(adjudication, branches);
  oldLog.adjudicate(adjudication);
  const resolved = cluster.projection();
  const resolvedState = resolved.states.find((state) => state.conflict_key.local_seq === 1 && state.conflict_key.epoch === second.epoch);
  assert.equal(resolvedState?.status, 'committed');
  assert.equal(resolvedState?.winning_branch_id, selectB.branch_id);
  assert.ok(resolvedState?.evidence_id !== null && resolvedState?.evidence_id !== undefined);
});

test('redteam T-139: an uncommitted branch can never produce Gate evidence', { timeout: 120_000 }, async (t) => {
  const cluster = await startCluster(t);
  const first = await cluster.elect('n1');
  const lease = cluster.node('n1').manager.currentLease;
  assert.ok(lease !== null);

  const uncommittedEvent = makeLedgerEvent('uncommitted', 30);
  const uncommittedHash = hashEvent(uncommittedEvent);
  cluster.node('n1').log.append({
    event: writerEvent(
      { writer_id: WRITER_ID, epoch: first.epoch, term: first.term, local_seq: 7, ledger_event_hash: uncommittedHash },
      lease,
    ),
    ledgerEvent: uncommittedEvent,
    ledgerEventHash: uncommittedHash,
    commitIndex: 0,
    status: 'proposed',
  });

  const projection = cluster.projection();
  const state = projection.states.find((candidate) => candidate.conflict_key.local_seq === 7);
  assert.ok(state !== undefined);
  assert.equal(state.status, 'uncommitted');
  assert.equal(state.evidence_id, null);
  assert.equal(state.produces_gate_evidence, false);
  assert.equal(projection.entries.some((entry) => entry.identity.ledger_event_hash === uncommittedHash), false);
  assertGateBoundary(state);

  const fabricatedCommitted = {
    schema_version: MWHA_PROJECTION_STATE_SCHEMA_VERSION,
    conflict_key: { writer_id: WRITER_ID, epoch: first.epoch, local_seq: 7 },
    status: 'committed',
    winning_branch_id: null,
    evidence_id: null,
    produces_gate_evidence: true,
  };
  assert.equal(mwhaProjectionStateSchema.safeParse(fabricatedCommitted).success, false);
  assert.throws(
    () => assertGateBoundary(fabricatedCommitted as unknown as MwhaProjectionState),
    (error: unknown) => codeOf(error) === 'PROJECTION_GATE_FORBIDDEN',
  );

  const fabricatedUncommittedWithEvidence = {
    schema_version: MWHA_PROJECTION_STATE_SCHEMA_VERSION,
    conflict_key: { writer_id: WRITER_ID, epoch: first.epoch, local_seq: 7 },
    status: 'uncommitted',
    winning_branch_id: null,
    evidence_id: 'ev-forged',
    produces_gate_evidence: false,
  };
  assert.equal(mwhaProjectionStateSchema.safeParse(fabricatedUncommittedWithEvidence).success, false);
});

test('redteam T-139: TCP proxy faults are not claimed as OS-level partitions', { timeout: 120_000 }, async (t) => {
  const cluster = await startCluster(t);
  const status = cluster.status();

  for (const text of [HA_CLUSTER_VERIFICATION_NOTE, HA_CLUSTER_FAULT_INJECTION_SCOPE_NOTE, status.verification_note]) {
    assert.ok(text.includes('未验证'), `boundary text must mark unverified capabilities: ${text}`);
    assert.ok(text.includes('≠ OS 真分区'), `boundary text must deny the OS-partition claim: ${text}`);
  }

  assert.equal(status.verification_scope, 'local-tcp-protocol-only');
  assert.ok(MWHA_UNVERIFIED_CAPABILITIES.includes('os-level-network-partition'));
  assert.equal(isUnverifiedCapability('os-level-network-partition'), true);
  assert.equal(isUnverifiedCapability('physical-three-machine-cluster'), true);
  assert.equal(isUnverifiedCapability('production-ha-failover'), true);

  // Exercise the proxy and confirm the proxy layer itself reports the boundary.
  await cluster.isolate([['n1'], ['n2', 'n3']]);
  assert.deepEqual(cluster.status().partitions, [['n1'], ['n2', 'n3']]);
  assert.ok(cluster.resourceStats().proxies_open > 0);
  assert.ok(HA_CLUSTER_VERIFICATION_NOTE.includes('本地 TCP + 代理'));

  // A leader elected on the majority side still carries the same scope marker.
  const won = await cluster.elect('n2');
  assert.equal(won.won, true);
  assert.equal(cluster.status().verification_scope, 'local-tcp-protocol-only');
});

test('redteam T-139: multiple-leader declarations and malformed leases fail closed', { timeout: 120_000 }, async (t) => {
  const cluster = await startCluster(t);
  const first = await cluster.elect('n1');
  await cluster.node('n1').manager.renewLease();

  // The frozen observation path names the exact same-(epoch,term) split brain.
  const rival: MwhaLeaderLease = mwhaLeaderLeaseSchema.parse({ term: first.term, leader_id: 'n3', epoch: first.epoch });
  const observation = cluster.node('n3').manager.observeLease(rival);
  assert.equal(observation.action, 'split-brain');
  assert.equal(observation.code, 'FENCE_SPLIT_BRAIN_SAME_TERM');
  assert.equal(detectMultipleLeaders(cluster.node('n3').manager.collectDeclarations()).length, 1);

  await expectCode(() => cluster.assertNoRivalLeader('n3', rival), 'SPLIT_BRAIN');

  // Malformed lease input is refused, not silently repaired.
  assert.throws(() => mwhaLeaderLeaseSchema.parse({ term: -1, leader_id: 'n1', epoch: 1 }));
});

// ---------------------------------------------------------------------------
// T-139 red-team additions: forged ack routing, explicit replication failure
// mapping, deterministic multi-fork adjudication and the old-master rejoin
// catch-up path that must converge without overwriting.
// ---------------------------------------------------------------------------

const HA_PROTOCOL_VERSION = 'mwha.protocol.v1';

interface RogueReply {
  readonly payload: unknown;
}

async function startRogueHa(
  t: TestContext,
  respond: (kind: string, payload: any, id: string) => RogueReply,
): Promise<{ port: number; close(): Promise<void> }> {
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on('error', () => {});
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length < 4) return;
        const length = buffer.readUInt32BE(0);
        if (buffer.length < 4 + length) return;
        const body = buffer.subarray(4, 4 + length);
        buffer = buffer.subarray(4 + length);
        const request = JSON.parse(body.toString('utf8')) as { kind: string; id: string; payload: any };
        const replyBody = Buffer.from(JSON.stringify({
          schema_version: HA_PROTOCOL_VERSION,
          kind: request.kind,
          id: request.id,
          ok: true,
          payload: respond(request.kind, request.payload, request.id).payload,
        }), 'utf8');
        const head = Buffer.alloc(4);
        head.writeUInt32BE(replyBody.length, 0);
        socket.write(Buffer.concat([head, replyBody]));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen({ host: '127.0.0.1', port: 0 }, resolve));
  const address = server.address() as net.AddressInfo;
  const close = async (): Promise<void> => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  t.after(close);
  return { port: address.port, close };
}

function pointNodeAtRogue(cluster: Awaited<ReturnType<typeof HaCluster.start>>, memberId: string, targetMemberId: string, port: number): void {
  cluster.node(memberId).remoteTargets.set(targetMemberId, { host: '127.0.0.1', port });
}

test('redteam T-139: a rogue peer cannot forge an ack nonce or a voter id', { timeout: 120_000 }, async (t) => {
  for (const mode of ['nonce', 'voter'] as const) {
    const cluster = await startCluster(t);
    const first = await cluster.elect('n1');

    const rogue = await startRogueHa(t, (kind, payload) => {
      if (kind !== 'proposal') return { payload: { applied: 1, duplicates: 0, conflicts: 0 } };
      return {
        payload: {
          granted: true,
          term: first.term,
          epoch: first.epoch,
          voter_id: mode === 'voter' ? 'ghost' : 'n3',
          leader_id: 'n1',
          ack_nonce: mode === 'nonce' ? 'f'.repeat(64) : payload.ack_nonce,
          detail: 'rogue response',
        },
      };
    });
    pointNodeAtRogue(cluster, 'n1', 'n3', rogue.port);
    await cluster.node('n1').clients.get('n3')!.reset();

    const result = await cluster.propose(proposeInput('n1', makeLedgerEvent(`rogue-${mode}`, 50), first.epoch, first.term, 1));
    assert.equal(result.committed, true);
    assert.deepEqual([...result.acks].sort(), ['n1', 'n2'], `the forged ${mode} must not count as a verified ack`);
    assert.equal(result.replicated_to.includes('n3'), true);
    // The real n3 never saw the proposal because its link was hijacked.
    assert.deepEqual(hashes(cluster.node('n3')), []);
  }
});

test('redteam T-139: a non-protocol replication failure is reported as UNKNOWN, never hidden', { timeout: 120_000 }, async (t) => {
  const cluster = await startCluster(t);
  const first = await cluster.elect('n1');

  const rogue = await startRogueHa(t, (kind, payload) => {
    if (kind === 'proposal') {
      return {
        payload: {
          granted: true,
          term: first.term,
          epoch: first.epoch,
          voter_id: 'n3',
          leader_id: 'n1',
          ack_nonce: payload.ack_nonce,
          detail: 'rogue accepts',
        },
      };
    }
    // sync-push gets a payload that does not satisfy haSyncPushResponseSchema.
    return { payload: { bogus: true } };
  });
  pointNodeAtRogue(cluster, 'n1', 'n3', rogue.port);
  await cluster.node('n1').clients.get('n3')!.reset();

  const result = await cluster.propose(proposeInput('n1', makeLedgerEvent('rogue-replication', 51), first.epoch, first.term, 1));
  assert.equal(result.committed, true);
  assert.deepEqual([...result.acks].sort(), ['n1', 'n2', 'n3']);
  const failure = result.replication_failures.find((entry) => entry.member_id === 'n3');
  assert.ok(failure !== undefined);
  assert.equal(failure.code, 'UNKNOWN');
});

test('redteam T-139: propose rejects out-of-bounds writer ids and rival-leader assertions', { timeout: 120_000 }, async (t) => {
  const cluster = await startCluster(t);
  const first = await cluster.elect('n1');
  const event = makeLedgerEvent('writer-validation', 52);

  await expectCode(
    () => cluster.propose({ ...proposeInput('n1', event, first.epoch, first.term, 1), writerId: '' }),
    'HA_INPUT_INVALID',
  );
  await expectCode(
    () => cluster.propose({ ...proposeInput('n1', event, first.epoch, first.term, 1), writerId: 'x'.repeat(129) }),
    'HA_INPUT_INVALID',
  );

  const rival: MwhaLeaderLease = { term: first.term, leader_id: 'n2', epoch: first.epoch };
  await expectCode(() => cluster.assertNoRivalLeader('n1', rival), 'HA_INPUT_INVALID');
  // The node's own lease is accepted and simply observed.
  const own: MwhaLeaderLease = { term: first.term, leader_id: 'n1', epoch: first.epoch };
  assert.doesNotThrow(() => cluster.assertNoRivalLeader('n1', own));
});

test('redteam T-139: voters that already adopted a newer lease refuse an old-leader proposal', { timeout: 120_000 }, async (t) => {
  const cluster = await startCluster(t);
  const first = await cluster.elect('n1');
  const eventA = makeLedgerEvent('pre-split-record', 53);
  await cluster.propose(proposeInput('n1', eventA, first.epoch, first.term, 1));

  // n2/n3 move to a strictly newer epoch while n1 stays on the old lease.
  await cluster.isolate([['n1'], ['n2', 'n3']]);
  const second = await cluster.elect('n2');
  assert.equal(second.won, true);
  // Make sure n3 really adopted the newer lease (granting a vote is not enough).
  const renewal = await cluster.node('n2').manager.renewLease();
  assert.equal(renewal.renewed, true);
  const eventB = makeLedgerEvent('new-epoch-record', 54);
  await cluster.propose(proposeInput('n2', eventB, second.epoch, second.term, 1));

  // Restore connectivity but do NOT rejoin n1: its stale proposal must be
  // refused by the voters' fence instead of silently granted.
  await cluster.restore();
  await expectCode(
    () => cluster.propose(proposeInput('n1', makeLedgerEvent('stale-proposal', 55), first.epoch, first.term, 2)),
    'QUORUM_NOT_REACHED',
  );
  assert.deepEqual(hashes(cluster.node('n2')), [hashEvent(eventA), hashEvent(eventB)]);
  assert.equal(cluster.node('n1').log.size, 1);
});

test('redteam T-139: multiple retained forks are adjudicated in deterministic slot order', { timeout: 120_000 }, async (t) => {
  const cluster = await startCluster(t);
  const first = await cluster.elect('n1');
  const lease = cluster.node('n1').manager.currentLease;
  assert.ok(lease !== null);
  const log = cluster.node('n1').log;

  const branches: string[] = [];
  for (const [seq, commitIndex, seed] of [[1, 1, 60], [1, 2, 61], [2, 3, 62], [2, 4, 63]] as const) {
    const event = makeLedgerEvent(`fork-${String(seq)}-${String(commitIndex)}`, seed);
    const hash = hashEvent(event);
    const appended = log.append({
      event: writerEvent({ writer_id: WRITER_ID, epoch: first.epoch, term: first.term, local_seq: seq, ledger_event_hash: hash }, lease),
      ledgerEvent: event,
      ledgerEventHash: hash,
      commitIndex,
    });
    assert.notEqual(appended.kind, 'duplicate');
    branches.push(hash);
  }

  const conflicts = log.forkReport().conflicts;
  assert.equal(conflicts.length, 2);
  for (const conflict of conflicts) {
    const actual = [...conflict.branches];
    const winner = actual.reduce((left, right) => (left.ledger_event_hash > right.ledger_event_hash ? left : right));
    const adjudication: MwhaAdjudication = {
      schema_version: MWHA_ADJUDICATION_SCHEMA_VERSION,
      conflict_key: conflict.conflict_key,
      branches: actual,
      branch_hashes: actual.map((branch) => branch.ledger_event_hash),
      status: 'resolved',
      selected_branch_id: winner.branch_id,
      resolution_reason: 'fixture resolves each retained fork explicitly',
    };
    assertAdjudicationComplete(adjudication, actual);
    log.adjudicate(adjudication);
  }

  // Two adjudications on one node force the aggregation comparator to run.
  const projection = cluster.projection();
  assert.equal(projection.gate_ok, true);
  assert.equal(projection.states.filter((state) => state.status === 'committed').length >= 2, true);
});

test('redteam T-139: rejoin converges a synced fork with two committed branches without overwriting', { timeout: 120_000 }, async (t) => {
  const cluster = await startCluster(t);
  const first = await cluster.elect('n1');
  const n1 = cluster.node('n1');
  const n2 = cluster.node('n2');

  // Branch A lives only on the old master; branch B is the synced peer branch.
  const eventA = makeLedgerEvent('rejoin-a', 70);
  const hashA = hashEvent(eventA);
  const lease = n1.manager.currentLease;
  assert.ok(lease !== null);
  n1.log.append({
    event: writerEvent({ writer_id: WRITER_ID, epoch: first.epoch, term: first.term, local_seq: 1, ledger_event_hash: hashA }, lease),
    ledgerEvent: eventA,
    ledgerEventHash: hashA,
    commitIndex: 1,
  });

  const eventB = makeLedgerEvent('rejoin-b', 71);
  const hashB = hashEvent(eventB);
  n2.log.append({
    event: writerEvent({ writer_id: WRITER_ID, epoch: first.epoch, term: first.term, local_seq: 1, ledger_event_hash: hashB }, lease),
    ledgerEvent: eventB,
    ledgerEventHash: hashB,
    commitIndex: 1,
  });
  // The peer answers heartbeats as a follower of n1.
  n2.manager.handleHeartbeat({
    schema_version: MWHA_HEARTBEAT_REQUEST_SCHEMA_VERSION,
    lease: { term: first.term, leader_id: 'n1', epoch: first.epoch },
  });

  assert.equal(n1.log.forkReport().conflicts.length, 0);
  // The peer holds only branch B; the fork materialises on the old master when
  // it ingests B next to its own retained A.
  assert.equal(n2.log.getEntries().length, 1);
  assert.equal(n2.log.getEntries()[0]!.entry.identity.ledger_event_hash, hashB);

  const report = await cluster.rejoin('n1');
  // B is a conflicting branch, so it is retained (conflicts=1) rather than
  // counted as a freshly applied record.
  assert.equal(report.conflicts, 1);
  assert.equal(report.ingested, 0);
  assert.equal(report.duplicates, 0);
  assert.equal(report.adjudications.length, 1);
  const adjudication = report.adjudications[0]!;
  assert.equal(adjudication.adjudication.status, 'resolved');
  assert.equal(adjudication.adjudication.selected_branch_id!.endsWith(hashB.slice(0, 16)), true);

  // Both branches survive; the peer's newer-by-preference branch wins the slot.
  const retained = n1.log.getEntries().map((record) => record.entry.identity.ledger_event_hash).sort();
  assert.deepEqual(retained, [hashA, hashB].sort());
  const projection = cluster.projection();
  const state = projection.states.find((candidate) => candidate.conflict_key.local_seq === 1);
  assert.ok(state !== undefined);
  assert.equal(state.status, 'committed');
  assert.equal(state.winning_branch_id!.endsWith(hashB.slice(0, 16)), true);
  assert.ok(state.evidence_id !== null && state.evidence_id !== undefined);
});
