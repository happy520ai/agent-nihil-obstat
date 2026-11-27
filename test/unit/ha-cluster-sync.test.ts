/**
 * T-139 HA wire unit tests: the frozen length-prefixed framing, the strict sync
 * schemas and the real loopback TCP server/client state machines, driven without
 * a full cluster.
 *
 * Every socket binds 127.0.0.1:0 only. The tests assert deterministic failure
 * paths (bad frames, refused binds, forged replies, timeouts) and release every
 * listener/client in `t.after`.
 */

import assert from 'node:assert/strict';
import * as net from 'node:net';
import test, { type TestContext } from 'node:test';
import {
  HaProtocolError,
  mwhaLeaderLeaseSchema,
} from '../../src/memory/ha-protocol.ts';
import {
  HaCluster,
  haSyncItemSchema,
  haSyncPushResponseSchema,
  haSyncPushSchema,
  haSyncRequestSchema,
  haSyncResponseSchema,
  HaTcpClient,
  HaTcpServer,
  verifyProposalAcks,
  type HaEndpoint,
} from '../../src/memory/ha-cluster.ts';
import { TCP_REPLICA_MAX_FRAME_BYTES } from '../../src/memory/tcp-transport.ts';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const AT = '2026-11-21T00:00:00.000Z';

function ledgerEvent() {
  return {
    id: '0'.repeat(26),
    hlc: { physical: 1_700_000_000_000, logical: 0, actor: 'writer-1' },
    actor: 'writer-1',
    kind: 'note.recorded' as const,
    payload: { label: 'sync' },
    idem_key: 'sync-item',
    prev_hash: '0'.repeat(64),
  };
}

function syncItem(overrides: Record<string, unknown> = {}) {
  return {
    entry: {
      schema_version: 'mwha.cluster-log-entry.v1' as const,
      identity: {
        writer_id: 'writer-1',
        epoch: 1,
        term: 1,
        local_seq: 1,
        ledger_event_hash: HASH_A,
      },
      status: 'committed' as const,
      leader: { term: 1, leader_id: 'n1', epoch: 1 },
      commit_index: 1,
      conflict_key: null,
    },
    ledger_event: ledgerEvent(),
    ledger_event_hash: HASH_A,
    ...overrides,
  };
}

function frameOf(body: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32BE(payload.length, 0);
  return Buffer.concat([head, payload]);
}

function lengthPrefix(length: number): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(length, 0);
  return head;
}

function waitForEvent(emitter: NodeJS.EventEmitter, event: string, timeoutMs = 500): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.removeListener(event, onEvent);
      reject(new Error(`timed out waiting for ${event}`));
    }, timeoutMs);
    timer.unref?.();
    const onEvent = (): void => {
      clearTimeout(timer);
      resolve();
    };
    emitter.once(event, onEvent);
  });
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${label}`);
}

async function closedSocket(port: number, chunk: Buffer): Promise<void> {
  const socket = net.connect({ host: '127.0.0.1', port });
  await waitForEvent(socket, 'connect');
  socket.write(chunk);
  await waitForEvent(socket, 'close');
  socket.destroy();
}

function assertHaCode(fn: () => unknown, expected: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof HaProtocolError, `expected HaProtocolError, got ${String(error)}`);
    assert.equal(error.code, expected);
    return true;
  });
}

test('T-139 sync: committed/adjudicated items require a positive index and a lease, others keep zero', { timeout: 60_000 }, () => {
  assert.equal(haSyncItemSchema.safeParse(syncItem()).success, true);

  const noIndex = syncItem({ entry: { ...syncItem().entry, commit_index: 0 } });
  const noIndexResult = haSyncItemSchema.safeParse(noIndex);
  assert.equal(noIndexResult.success, false);
  assert.match(noIndexResult.error!.issues[0]!.message, /positive commit_index/u);

  const noLeader = syncItem({ entry: { ...syncItem().entry, leader: null } });
  const noLeaderResult = haSyncItemSchema.safeParse(noLeader);
  assert.equal(noLeaderResult.success, false);
  assert.match(noLeaderResult.error!.issues[0]!.message, /leader lease/u);

  const adjudicated = syncItem({ entry: { ...syncItem().entry, status: 'adjudicated' } });
  assert.equal(haSyncItemSchema.safeParse(adjudicated).success, true);
  assert.equal(haSyncItemSchema.safeParse(syncItem({ entry: { ...syncItem().entry, status: 'proposed', commit_index: 0, leader: null } })).success, true);
  assert.equal(haSyncItemSchema.safeParse(syncItem({ entry: { ...syncItem().entry, status: 'conflicted', commit_index: 0 } })).success, true);

  const nonzeroUncommitted = syncItem({ entry: { ...syncItem().entry, status: 'proposed', commit_index: 3 } });
  const nonzeroResult = haSyncItemSchema.safeParse(nonzeroUncommitted);
  assert.equal(nonzeroResult.success, false);
  assert.match(nonzeroResult.error!.issues[0]!.message, /commit_index = 0/u);

  assert.equal(haSyncItemSchema.safeParse(syncItem({ ledger_event_hash: 'not-a-hash' })).success, false);
  assert.equal(haSyncRequestSchema.safeParse({ member_id: 'n1' }).success, true);
  assert.equal(haSyncRequestSchema.safeParse({ member_id: '' }).success, false);
  assert.equal(haSyncResponseSchema.safeParse({ items: [] }).success, true);
  assert.equal(haSyncPushSchema.safeParse({ items: [] }).success, true);
  assert.equal(haSyncPushResponseSchema.safeParse({ applied: 1, duplicates: 0, conflicts: 0 }).success, true);
});

test('T-139 sync: malformed length prefixes, oversized frames, bad JSON and envelope violations drop the link', { timeout: 60_000 }, async (t) => {
  const server = new HaTcpServer(() => ({ ok: true, payload: {} }));
  const address = await server.listen('127.0.0.1', 0);
  t.after(async () => { await server.close(); });

  // Zero length.
  await closedSocket(address.port, lengthPrefix(0));
  assert.equal(server.activeConnectionCount, 0);

  // Length beyond the frozen frame limit.
  await closedSocket(address.port, lengthPrefix(TCP_REPLICA_MAX_FRAME_BYTES + 1));

  // Body is not valid JSON.
  const badJson = Buffer.concat([lengthPrefix(8), Buffer.from('{not json', 'utf8')]);
  await closedSocket(address.port, badJson);

  // Valid JSON but not a valid HA envelope (unknown kind).
  await closedSocket(address.port, frameOf({
    schema_version: 'mwha.protocol.v1',
    kind: 'bogus-kind',
    id: 'frame-1',
    payload: {},
  }));

  // Valid JSON, known kind, but wrong envelope shape (missing payload).
  await closedSocket(address.port, frameOf({
    schema_version: 'mwha.protocol.v1',
    kind: 'vote-request',
    id: 'frame-2',
  }));
  assert.equal(server.activeConnectionCount, 0);
});

test('T-139 sync: the HA TCP server validates its listen lifecycle', { timeout: 60_000 }, async (t) => {
  const server = new HaTcpServer(() => ({ ok: true, payload: {} }));
  t.after(async () => { await server.close(); });
  assert.equal(server.address, null);
  assert.equal(server.isClosed, false);

  const address = await server.listen('127.0.0.1', 0);
  assert.equal(address.host, '127.0.0.1');
  assert.ok(address.port > 0);
  assert.deepEqual(server.address, address);
  // The getter returns a copy.
  const exposed = server.address as { host: string; port: number };
  exposed.port = 1;
  assert.equal((server.address as HaEndpoint).port, address.port);

  // Listening twice returns the same endpoint.
  assert.deepEqual(await server.listen('127.0.0.1', 0), address);

  // Non-loopback binds are refused before any socket exists.
  const remote = new HaTcpServer(() => ({ ok: true, payload: {} }));
  t.after(async () => { await remote.close(); });
  await assert.rejects(
    () => remote.listen('192.0.2.1', 0),
    (error: unknown) => error instanceof HaProtocolError && error.code === 'HA_INPUT_INVALID',
  );

  // A port already bound fails asynchronously and leaves that server unusable
  // for the conflicting endpoint (it never claimed the port).
  const blocker = net.createServer();
  await new Promise<void>((resolve) => blocker.listen({ host: '127.0.0.1', port: 0 }, resolve));
  const blockedPort = (blocker.address() as net.AddressInfo).port;
  t.after(() => new Promise<void>((resolve) => blocker.close(() => resolve())));
  const binder = new HaTcpServer(() => ({ ok: true, payload: {} }));
  t.after(async () => { await binder.close(); });
  await assert.rejects(
    () => binder.listen('127.0.0.1', blockedPort),
    (error: unknown) => error instanceof HaProtocolError && error.code === 'HA_INPUT_INVALID',
  );
  assert.equal(binder.address, null);
  // The original server is untouched by the failed bind elsewhere.
  assert.deepEqual(server.address, address);

  // An out-of-range port throws synchronously inside the listen promise.
  const invalidPort = new HaTcpServer(() => ({ ok: true, payload: {} }));
  t.after(async () => { await invalidPort.close(); });
  await assert.rejects(
    () => invalidPort.listen('127.0.0.1', 70_000),
    (error: unknown) => error instanceof HaProtocolError && error.code === 'HA_INPUT_INVALID',
  );

  await server.close();
  assert.equal(server.isClosed, true);
  assert.equal(server.address, null);
  assert.equal(server.activeConnectionCount, 0);
  // Close is idempotent.
  await server.close();
  await assert.rejects(
    () => server.listen('127.0.0.1', 0),
    (error: unknown) => error instanceof HaProtocolError && error.code === 'HA_INPUT_INVALID',
  );
});

test('T-139 sync: the HA TCP server turns a throwing handler into a failure reply', { timeout: 60_000 }, async (t) => {
  const server = new HaTcpServer(() => { throw new Error('handler exploded'); });
  const address = await server.listen('127.0.0.1', 0);
  t.after(async () => { await server.close(); });

  const client = new HaTcpClient(() => address);
  t.after(async () => { await client.close(); });
  await assert.rejects(
    () => client.request('sync-request', { member_id: 'n1' }),
    (error: unknown) => error instanceof HaProtocolError && error.code === 'HA_INPUT_INVALID',
  );

  // An explicit failure reply keeps its code and does not crash the link.
  const failing = new HaTcpServer(() => ({ ok: false, code: 'FENCE_REJECTED', message: 'no lease' }));
  const failingAddress = await failing.listen('127.0.0.1', 0);
  t.after(async () => { await failing.close(); });
  const second = new HaTcpClient(() => failingAddress);
  t.after(async () => { await second.close(); });
  await assert.rejects(
    () => second.request('proposal', {}),
    (error: unknown) => error instanceof HaProtocolError && error.code === 'FENCE_REJECTED',
  );
});

test('T-139 sync: a client request that outlives its budget times out honestly', { timeout: 60_000 }, async (t) => {
  let releaseGate: () => void = () => {};
  const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
  const server = new HaTcpServer(() => gate.then(() => ({ ok: true, payload: {} })));
  const address = await server.listen('127.0.0.1', 0);
  t.after(async () => { releaseGate(); await server.close(); });

  const client = new HaTcpClient(() => address, { requestTimeoutMs: 25 });
  t.after(async () => { await client.close(); });
  const started = Date.now();
  await assert.rejects(
    () => client.request('sync-request', { member_id: 'n1' }, 25),
    (error: unknown) => error instanceof HaProtocolError && error.code === 'QUORUM_NOT_REACHED',
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 15, `timeout fired too early: ${String(elapsed)}ms`);
  assert.ok(elapsed < 200, `timeout overran: ${String(elapsed)}ms`);
});

test('T-139 sync: a closed client, an unavailable target and a non-loopback target fail fast', { timeout: 60_000 }, async (t) => {
  const client = new HaTcpClient(() => undefined);
  t.after(async () => { await client.close(); });
  await assert.rejects(
    () => client.request('sync-request', {}),
    (error: unknown) => error instanceof HaProtocolError && error.code === 'QUORUM_NOT_REACHED',
  );
  await client.close();
  assert.equal(client.isClosed, true);
  await client.close();
  await assert.rejects(
    () => client.request('sync-request', {}),
    (error: unknown) => error instanceof HaProtocolError && error.code === 'QUORUM_NOT_REACHED',
  );

  const remote = new HaTcpClient(() => ({ host: '192.0.2.1', port: 80 }));
  t.after(async () => { await remote.close(); });
  await assert.rejects(
    () => remote.request('sync-request', {}),
    (error: unknown) => error instanceof HaProtocolError && error.code === 'QUORUM_NOT_REACHED',
  );

  assertHaCode(() => new HaTcpClient(() => undefined, { connectTimeoutMs: 0 }), 'HA_INPUT_INVALID');
  assertHaCode(() => new HaTcpClient(() => undefined, { connectTimeoutMs: -5 }), 'HA_INPUT_INVALID');
  assertHaCode(() => new HaTcpClient(() => undefined, { requestTimeoutMs: 1.5 }), 'HA_INPUT_INVALID');
  assertHaCode(() => new HaTcpClient('nope' as unknown as () => undefined), 'HA_INPUT_INVALID');
  assert.equal(new HaTcpClient(() => undefined).activeConnectionCount, 0);
});

test('T-139 sync: a refused connect and an oversized outbound frame are mapped to explicit failures', { timeout: 60_000 }, async (t) => {
  // Reserve then release an ephemeral port; connecting to it is refused.
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen({ host: '127.0.0.1', port: 0 }, resolve));
  const deadPort = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  const refused = new HaTcpClient(() => ({ host: '127.0.0.1', port: deadPort }), { connectTimeoutMs: 50 });
  t.after(async () => { await refused.close(); });
  await assert.rejects(
    () => refused.request('sync-request', {}),
    (error: unknown) => error instanceof HaProtocolError && error.code === 'QUORUM_NOT_REACHED',
  );

  const server = new HaTcpServer(() => ({ ok: true, payload: {} }));
  const address = await server.listen('127.0.0.1', 0);
  t.after(async () => { await server.close(); });
  const encoder = new HaTcpClient(() => address);
  t.after(async () => { await encoder.close(); });
  await assert.rejects(
    () => encoder.request('sync-push', { items: [], blob: 'x'.repeat(TCP_REPLICA_MAX_FRAME_BYTES) }),
    (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'TCP_FRAME_TOO_LARGE',
  );
});

test('T-139 sync: a malformed inbound frame fails the pending request and tears the link down', { timeout: 60_000 }, async (t) => {
  const upstream = net.createServer((socket) => {
    socket.on('data', () => {
      socket.write(lengthPrefix(0));
    });
  });
  await new Promise<void>((resolve) => upstream.listen({ host: '127.0.0.1', port: 0 }, resolve));
  const listened = upstream.address() as net.AddressInfo;
  const endpoint = { host: '127.0.0.1', port: listened.port };
  t.after(() => new Promise<void>((resolve) => upstream.close(() => resolve())));

  const client = new HaTcpClient(() => endpoint, { requestTimeoutMs: 1_000 });
  t.after(async () => { await client.close(); });
  await assert.rejects(
    () => client.request('sync-request', { member_id: 'n1' }, 1_000),
    (error: unknown) => error instanceof HaProtocolError && error.code === 'HA_INPUT_INVALID',
  );
  await waitFor(() => client.activeConnectionCount === 0, 200, 'client teardown');
});

test('T-139 sync: a client that vanishes mid-handler is released without a write', { timeout: 60_000 }, async (t) => {
  let releaseGate: () => void = () => {};
  const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
  const server = new HaTcpServer(() => gate.then(() => ({ ok: true, payload: {} })));
  const address = await server.listen('127.0.0.1', 0);
  t.after(async () => { releaseGate(); await server.close(); });

  const client = new HaTcpClient(() => address);
  const pending = client.request('sync-request', { member_id: 'n1' }, 1_000);
  // Give the server a tick to enter the handler, then disappear.
  await new Promise((resolve) => setTimeout(resolve, 10));
  await client.close();
  releaseGate();
  await assert.rejects(() => pending, (error: unknown) => error instanceof HaProtocolError);
  await waitFor(() => server.activeConnectionCount === 0, 200, 'server connection release');
});

test('T-139 sync: proposal ack verification refuses forged, duplicated and unexpected voters', { timeout: 60_000 }, () => {
  const expected = ['n2', 'n3'];
  assertHaCode(() => verifyProposalAcks(['ghost'], expected, 3), 'HA_INPUT_INVALID');
  assertHaCode(() => verifyProposalAcks(['n2', 'n2'], expected, 3), 'HA_INPUT_INVALID');
  assertHaCode(() => verifyProposalAcks(['n1'], expected, 3), 'HA_INPUT_INVALID');
  assertHaCode(() => verifyProposalAcks([], expected, 3), 'QUORUM_NOT_REACHED');
  assert.doesNotThrow(() => verifyProposalAcks(['n2', 'n3'], expected, 3));
  assert.doesNotThrow(() => verifyProposalAcks(['n3', 'n2'], expected, 3));
});

test('T-139 sync: cluster construction validates member ids, hosts and numeric options', { timeout: 60_000 }, async () => {
  const expectInvalid = async (options: Parameters<typeof HaCluster.start>[0]): Promise<void> => {
    await assert.rejects(
      () => HaCluster.start(options),
      (error: unknown) => error instanceof HaProtocolError && error.code === 'HA_INPUT_INVALID',
    );
  };
  await expectInvalid({ memberIds: [] });
  await expectInvalid({ memberIds: ['n1', 'n1'] });
  await expectInvalid({ memberIds: ['bad id'] });
  await expectInvalid({ host: '192.0.2.1' });
  await expectInvalid({ leaseDurationMs: 0 });
  await expectInvalid({ heartbeatTimeoutMs: -1 });
  await expectInvalid({ requestTimeoutMs: 1.5 });
  await expectInvalid({ connectTimeoutMs: 0 });
  assert.equal(mwhaLeaderLeaseSchema.safeParse({ term: 1, leader_id: 'n1', epoch: 1 }).success, true);
});

test('T-139 sync: a peer that closes or dies mid-request fails the pending request once', { timeout: 60_000 }, async (t) => {
  // Destroy right after accepting: the connect may complete or not, but the
  // request must reject exactly once with QUORUM_NOT_REACHED.
  const dying = net.createServer((socket) => { socket.destroy(); });
  await new Promise<void>((resolve) => dying.listen({ host: '127.0.0.1', port: 0 }, resolve));
  const dyingPort = (dying.address() as net.AddressInfo).port;
  t.after(() => new Promise<void>((resolve) => dying.close(() => resolve())));
  const dyingClient = new HaTcpClient(() => ({ host: '127.0.0.1', port: dyingPort }));
  t.after(async () => { await dyingClient.close(); });
  await assert.rejects(
    () => dyingClient.request('sync-request', {}),
    (error: unknown) => error instanceof HaProtocolError && error.code === 'QUORUM_NOT_REACHED',
  );
  await waitFor(() => dyingClient.activeConnectionCount === 0, 200, 'dead link teardown');

  // Established link that is cut after receiving the request frame.
  const cutter = net.createServer((socket) => {
    socket.on('data', () => socket.destroy());
  });
  await new Promise<void>((resolve) => cutter.listen({ host: '127.0.0.1', port: 0 }, resolve));
  const cutterPort = (cutter.address() as net.AddressInfo).port;
  t.after(() => new Promise<void>((resolve) => cutter.close(() => resolve())));
  const cutClient = new HaTcpClient(() => ({ host: '127.0.0.1', port: cutterPort }));
  t.after(async () => { await cutClient.close(); });
  await assert.rejects(
    () => cutClient.request('sync-request', {}),
    (error: unknown) => error instanceof HaProtocolError && error.code === 'QUORUM_NOT_REACHED',
  );
  await waitFor(() => cutClient.activeConnectionCount === 0, 200, 'cut link teardown');
});

test('T-139 sync: changing the resolved target rebuilds the link instead of reusing a stale socket', { timeout: 60_000 }, async (t) => {
  const first = new HaTcpServer(() => ({ ok: true, payload: { server: 'first' } }));
  const second = new HaTcpServer(() => ({ ok: true, payload: { server: 'second' } }));
  const firstAddress = await first.listen('127.0.0.1', 0);
  const secondAddress = await second.listen('127.0.0.1', 0);
  t.after(async () => { await first.close(); await second.close(); });

  let target: { host: string; port: number } = firstAddress;
  const client = new HaTcpClient(() => target);
  t.after(async () => { await client.close(); });

  const firstReply = await client.request('sync-request', { member_id: 'n1' });
  assert.deepEqual(firstReply, { server: 'first' });
  target = secondAddress;
  const secondReply = await client.request('sync-request', { member_id: 'n1' });
  assert.deepEqual(secondReply, { server: 'second' });
});
