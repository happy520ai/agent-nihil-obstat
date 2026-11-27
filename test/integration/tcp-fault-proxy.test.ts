/**
 * T-138 / HA-06 integration tests: a real `node:net` fault proxy sits between
 * the T-134 client and server, so genuine socket traffic (handshake, status,
 * query) traverses it while whole-frame faults are injected deterministically.
 *
 * Covered per fault kind: delay (observed latency floor), drop (timeout +
 * counter), duplicate (idempotent correlation + copy counter), reorder (whole
 * frames permuted, concurrent requests still correlate by id), disconnect
 * (connection cut + reconnect), one-way-partition (one direction blocked, the
 * reverse direction still delivers), bandwidth (throughput limited, message
 * intact), plus fixed-seed reproducibility and bounded clean shutdown.
 *
 * SCOPE: these faults are TCP protocol-layer simulation only. They are not an
 * OS firewall partition, kernel failure or physical link outage, and they say
 * nothing about physical three-machine deployment (see
 * TCP_FAULT_PROXY_FAULT_INJECTION_SCOPE_NOTE).
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import test, { type TestContext } from 'node:test';
import {
  MWHA_FAULT_INJECTION_SCOPE_NOTE,
  mwhaFaultKinds,
} from '../../src/memory/ha-protocol.ts';
import {
  ANCHOR_PROBE_REQUEST_SCHEMA_VERSION,
  type AnchorProbeSnapshot,
} from '../../src/memory/probe-contract.ts';
import type { DistributedNodeResponse } from '../../src/memory/distributed-probe.ts';
import type { ProbeCandidate, ProbeEdge } from '../../src/memory/probe.ts';
import {
  TCP_FAULT_KINDS,
  TCP_FAULT_PROXY_FAULT_INJECTION_SCOPE_NOTE,
  TCP_FAULT_PROXY_UNVERIFIED_BOUNDARIES,
  TcpFaultProxy,
  type TcpFaultRule,
} from '../../src/memory/tcp-fault-proxy.ts';
import {
  encodeTcpReplicaFrame,
  TcpReplicaClient,
  TcpReplicaServer,
  TCP_REPLICA_MAX_FRAME_BYTES,
  type TcpReplicaService,
  type TcpReplicaStatusView,
} from '../../src/memory/tcp-transport.ts';

// Runtime-only test credential: never persisted, logged or printed.
const SECRET = randomBytes(32).toString('hex');
const HASH = 'a'.repeat(64);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition was not reached in time');
    await sleep(10);
  }
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

function safeRef(root: string): string {
  return root.replace(/[^A-Za-z0-9._:-]/gu, '_');
}

function makeRequest(requestId: string, root = 'F:/project'): Record<string, unknown> {
  return {
    schema_version: ANCHOR_PROBE_REQUEST_SCHEMA_VERSION,
    request_id: requestId,
    root,
    project_scope: 'proj',
    required_facts: ['local.storage.engine'],
  };
}

// ---------------------------------------------------------------------------
// Minimal in-memory replica service
// ---------------------------------------------------------------------------

function fakeSnapshot(): AnchorProbeSnapshot {
  return {
    project_scope: 'proj',
    ledger_digest: HASH,
    graph_revision: null,
    source_fingerprint: null,
    connected_digest: null,
  } as AnchorProbeSnapshot;
}

class MemoryReplicaService implements TcpReplicaService {
  commitIndex = 0;
  queryCount = 0;
  statusCount = 0;
  readonly replicaId: string;

  constructor(replicaId: string) {
    this.replicaId = replicaId;
  }

  async query(request: { root?: string }): Promise<DistributedNodeResponse> {
    this.queryCount += 1;
    const root = typeof request.root === 'string' ? request.root : 'default';
    const entry = {
      record_ref: `rec-${safeRef(root)}`,
      fact_key: 'local.storage.engine',
      task_id: null,
      file: null,
      symbol: null,
      source: { kind: 'native_note' },
      source_health: 'verified_at_snapshot',
      status: 'active',
      content: `content of ${safeRef(root)}`,
      content_hash: HASH,
      recorded_at: '2026-11-24T00:00:00.000Z',
      effective_from: null,
      effective_to: null,
      superseded_by: null,
      version: null,
      anchor: { status: 'none', file: null },
      qualifiers: [],
    } as unknown as ProbeCandidate;
    const response: DistributedNodeResponse = {
      candidates: [entry],
      edges: [] as ProbeEdge[],
      commitIndex: this.commitIndex,
      viewDigest: HASH,
      state: 'ACTIVE',
      clusterEpoch: 'epoch-1',
    };
    return response;
  }

  async apply(events: readonly { seq: number }[]): Promise<{ applied: number; duplicates: number; outOfOrder: number; gaps: number[]; corrupt: number; commitIndex: number; viewDigest: string; complete: boolean; pendingCount: number }> {
    this.commitIndex += events.length;
    return {
      applied: events.length,
      duplicates: 0,
      outOfOrder: 0,
      gaps: [],
      corrupt: 0,
      commitIndex: this.commitIndex,
      viewDigest: HASH,
      complete: true,
      pendingCount: 0,
    };
  }

  async status(): Promise<TcpReplicaStatusView> {
    this.statusCount += 1;
    return {
      replicaId: this.replicaId,
      commitIndex: this.commitIndex,
      viewDigest: HASH,
      evidenceDigest: HASH,
      state: 'ACTIVE',
      snapshot: fakeSnapshot(),
      clusterEpoch: 'epoch-1',
      projectScope: 'proj',
    };
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function makeServer(t: TestContext, service: TcpReplicaService): Promise<TcpReplicaServer> {
  const server = new TcpReplicaServer({
    host: '127.0.0.1',
    port: 0,
    sharedSecret: SECRET,
    nodeId: 'node-b',
    authorizedNodes: ['node-a'],
    service,
  });
  await server.listen();
  t.after(async () => {
    await server.close();
  });
  return server;
}

async function makeProxy(
  t: TestContext,
  upstreamPort: number,
  rules: readonly TcpFaultRule[] = [],
  seed: string | number = 't138-seed',
): Promise<TcpFaultProxy> {
  const proxy = await TcpFaultProxy.start({
    listen: { host: '127.0.0.1', port: 0 },
    upstream: { host: '127.0.0.1', port: upstreamPort },
    seed,
    rules,
  });
  t.after(async () => {
    await proxy.close();
  });
  return proxy;
}

function makeClient(port: number, nodeId = 'node-a'): TcpReplicaClient {
  return new TcpReplicaClient({ host: '127.0.0.1', port, nodeId, sharedSecret: SECRET });
}

// ---------------------------------------------------------------------------
// 1. Pass-through over real sockets
// ---------------------------------------------------------------------------

test('real client/server handshake, status and query traverse the proxy', { timeout: 60_000 }, async (t) => {
  const service = new MemoryReplicaService('node-b');
  const server = await makeServer(t, service);
  const proxy = await makeProxy(t, server.address!.port);
  const client = makeClient(proxy.address!.port);
  t.after(async () => {
    await client.close();
  });

  await client.connect();
  assert.equal(client.activeConnectionCount, 1);
  assert.equal(proxy.stats().activeConnections, 1);

  const status = await client.status();
  assert.equal(status.replicaId, 'node-b');
  const response = await client.query(makeRequest('req-through', 'F:/through') as never);
  assert.equal(response.candidates[0]?.record_ref, `rec-${safeRef('F:/through')}`);

  // hello + auth + status + query in both directions = at least 8 whole frames.
  const stats = proxy.stats();
  assert.ok(stats.forwardedFrames >= 8, `expected >=8 forwarded frames, got ${String(stats.forwardedFrames)}`);
  assert.ok(stats.bytesByDirection['client-to-server'] > 0);
  assert.ok(stats.bytesByDirection['server-to-client'] > 0);
  assert.equal(stats.droppedFrames, 0);
  assert.equal(stats.duplicatedFrames, 0);
});

// ---------------------------------------------------------------------------
// 2. delay
// ---------------------------------------------------------------------------

test('delay injects a reproducible per-frame latency floor', { timeout: 60_000 }, async (t) => {
  const service = new MemoryReplicaService('node-b');
  const server = await makeServer(t, service);
  const proxy = await makeProxy(t, server.address!.port, [
    { kind: 'delay', direction: 'client-to-server', delayMs: 200, probability: 1, afterFrames: 2, durationFrames: 1 },
  ]);
  const client = makeClient(proxy.address!.port);
  t.after(async () => {
    await client.close();
  });
  await client.connect();

  const started = Date.now();
  const status = await client.status();
  const elapsed = Date.now() - started;
  assert.equal(status.replicaId, 'node-b');
  assert.ok(elapsed >= 180, `expected >=180ms observed latency, got ${String(elapsed)}ms`);
  assert.equal(proxy.stats().droppedFrames, 0);
});

// ---------------------------------------------------------------------------
// 3. drop
// ---------------------------------------------------------------------------

test('drop discards a whole request frame and surfaces as a client timeout', { timeout: 60_000 }, async (t) => {
  const service = new MemoryReplicaService('node-b');
  const server = await makeServer(t, service);
  const proxy = await makeProxy(t, server.address!.port, [
    { kind: 'drop', direction: 'client-to-server', probability: 1, afterFrames: 2, durationFrames: 1 },
  ]);
  const client = makeClient(proxy.address!.port);
  t.after(async () => {
    await client.close();
  });
  await client.connect();

  await expectCode(() => client.status({ timeoutMs: 300 }), 'TCP_REQUEST_TIMEOUT');
  assert.ok(proxy.stats().droppedFrames >= 1);

  // The rule expires after one frame: the connection stays usable.
  const recovered = await client.status();
  assert.equal(recovered.state, 'ACTIVE');
});

// ---------------------------------------------------------------------------
// 4. duplicate
// ---------------------------------------------------------------------------

test('duplicate multiplies whole frames while the client correlates exactly once', { timeout: 60_000 }, async (t) => {
  const service = new MemoryReplicaService('node-b');
  const server = await makeServer(t, service);
  const proxy = await makeProxy(t, server.address!.port, [
    { kind: 'duplicate', direction: 'client-to-server', duplicateCount: 2, probability: 1, afterFrames: 2, durationFrames: 1 },
  ]);
  const client = makeClient(proxy.address!.port);
  t.after(async () => {
    await client.close();
  });
  await client.connect();
  const before = service.statusCount;

  const status = await client.status();
  assert.equal(status.replicaId, 'node-b');

  // Three identical status frames reach the service; the client settles its
  // single pending id on the first response and ignores the two duplicates.
  assert.equal(service.statusCount - before, 3);
  assert.ok(proxy.stats().duplicatedFrames >= 2);
  assert.equal(client.activeConnectionCount, 1);
  const after = await client.status();
  assert.equal(after.replicaId, 'node-b');
});

// ---------------------------------------------------------------------------
// 5. reorder
// ---------------------------------------------------------------------------

test('reorder permutes whole frames yet concurrent requests correlate by id', { timeout: 60_000 }, async (t) => {
  const service = new MemoryReplicaService('node-b');
  const server = await makeServer(t, service);
  const proxy = await makeProxy(t, server.address!.port, [
    { kind: 'reorder', direction: 'client-to-server', reorderWindow: 4, probability: 1, afterFrames: 2 },
  ]);
  const client = makeClient(proxy.address!.port);
  t.after(async () => {
    await client.close();
  });
  await client.connect();
  const before = service.queryCount;

  const roots = Array.from({ length: 8 }, (_unused, index) => `F:/reorder-${String(index)}`);
  const responses = await Promise.all(
    roots.map((root, index) => client.query(makeRequest(`req-reorder-${String(index)}`, root) as never)),
  );
  assert.equal(responses.length, roots.length);
  responses.forEach((response, index) => {
    const expected = `rec-${safeRef(roots[index]!)}`;
    assert.equal(response.candidates[0]?.record_ref, expected);
  });
  assert.equal(service.queryCount - before, roots.length);
  // Whole frames were permuted, never split: every forwarded frame is one frame.
  assert.ok(proxy.stats().forwardedFrames >= roots.length + 2);
});

// ---------------------------------------------------------------------------
// 6. disconnect
// ---------------------------------------------------------------------------

test('disconnect cuts the pair and the client can reconnect through the same proxy', { timeout: 60_000 }, async (t) => {
  const service = new MemoryReplicaService('node-b');
  const server = await makeServer(t, service);
  const proxy = await makeProxy(t, server.address!.port, [
    { kind: 'disconnect', direction: 'client-to-server', probability: 1, afterFrames: 2, durationFrames: 1 },
  ]);
  const client = makeClient(proxy.address!.port);
  t.after(async () => {
    await client.close();
  });
  await client.connect();
  assert.equal(proxy.stats().activeConnections, 1);

  await expectCode(() => client.status({ timeoutMs: 2_000 }), 'TCP_CONNECTION_CLOSED');
  await waitFor(() => proxy.stats().activeConnections === 0);
  await waitFor(() => server.activeConnectionCount === 0);

  // The proxy is still listening; a fresh socket completes the handshake. (The
  // one-shot rule has already fired, and no third frame is sent here.)
  const reconnected = makeClient(proxy.address!.port);
  t.after(async () => {
    await reconnected.close();
  });
  await reconnected.connect();
  assert.equal(reconnected.activeConnectionCount, 1);
  assert.equal(proxy.stats().activeConnections, 1);
});

// ---------------------------------------------------------------------------
// 7. one-way-partition
// ---------------------------------------------------------------------------

test('one-way-partition blocks one direction while the reverse direction still delivers', { timeout: 60_000 }, async (t) => {
  const service = new MemoryReplicaService('node-b');
  const server = await makeServer(t, service);

  await t.test('client-to-server partition: request dies, later response still returns', async () => {
    const proxy = await makeProxy(t, server.address!.port, [
      { kind: 'one-way-partition', direction: 'client-to-server', probability: 1, afterFrames: 2, durationFrames: 1 },
    ]);
    const client = makeClient(proxy.address!.port);
    t.after(async () => {
      await client.close();
    });
    await client.connect();
    await expectCode(() => client.status({ timeoutMs: 300 }), 'TCP_REQUEST_TIMEOUT');
    assert.ok(proxy.stats().droppedFrames >= 1);

    const recovered = await client.status();
    assert.equal(recovered.replicaId, 'node-b');
    // Reverse-direction bytes flowed (handshake responses + the recovered response).
    assert.ok(proxy.stats().bytesByDirection['server-to-client'] > 0);
  });

  await t.test('server-to-client partition: request lands, response is cut, then recovers', async () => {
    const proxy = await makeProxy(t, server.address!.port, [
      { kind: 'one-way-partition', direction: 'server-to-client', probability: 1, afterFrames: 2, durationFrames: 1 },
    ]);
    const client = makeClient(proxy.address!.port);
    t.after(async () => {
      await client.close();
    });
    await client.connect();
    await expectCode(() => client.status({ timeoutMs: 300 }), 'TCP_REQUEST_TIMEOUT');
    assert.ok(proxy.stats().droppedFrames >= 1);

    const recovered = await client.status();
    assert.equal(recovered.replicaId, 'node-b');
    assert.ok(proxy.stats().bytesByDirection['client-to-server'] > 0);
  });
});

// ---------------------------------------------------------------------------
// 8. bandwidth
// ---------------------------------------------------------------------------

test('bandwidth throttles a large frame but delivers it intact', { timeout: 60_000 }, async (t) => {
  const service = new MemoryReplicaService('node-b');
  const server = await makeServer(t, service);
  const rate = 8_192;
  const burst = 512;
  const proxy = await makeProxy(t, server.address!.port, [
    { kind: 'bandwidth', direction: 'client-to-server', bandwidthBytesPerSecond: rate, burstBytes: burst, probability: 1, afterFrames: 2, durationFrames: 1 },
  ]);
  const client = makeClient(proxy.address!.port);
  t.after(async () => {
    await client.close();
  });
  await client.connect();

  const root = `F:/${'x'.repeat(4_000)}`;
  const started = Date.now();
  const response = await client.query(makeRequest('req-bandwidth', root) as never, { timeoutMs: 20_000 });
  const elapsed = Date.now() - started;
  assert.equal(response.candidates[0]?.record_ref, `rec-${safeRef(root)}`);
  assert.equal(response.candidates[0]?.content, `content of ${safeRef(root)}`);

  // ~4.1 KiB frame with a 512-byte burst at 8 KiB/s must wait well beyond 350ms.
  assert.ok(elapsed >= 350, `expected bandwidth-limited latency >=350ms, got ${String(elapsed)}ms`);
  assert.equal(proxy.stats().droppedFrames, 0);
  assert.ok(proxy.stats().bytesByDirection['client-to-server'] > 4_000);
});

// ---------------------------------------------------------------------------
// 9. Fixed-seed reproducibility
// ---------------------------------------------------------------------------

interface RawRunResult {
  readonly stats: ReturnType<TcpFaultProxy['stats']>;
  readonly receivedIds: readonly string[];
  readonly responseIds: readonly string[];
}

/** Raw upstream that echoes complete 4-byte-prefixed frames and records order. */
class FrameEchoUpstream {
  readonly #server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length < 4) return;
        const length = buffer.readUInt32BE(0);
        if (length <= 0 || length > TCP_REPLICA_MAX_FRAME_BYTES || buffer.length < 4 + length) return;
        const body = buffer.subarray(4, 4 + length);
        buffer = buffer.subarray(4 + length);
        try {
          const parsed = JSON.parse(body.toString('utf8')) as { id?: unknown };
          if (typeof parsed.id === 'string') this.receivedIds.push(parsed.id);
        } catch {
          // Ignore unparsable bodies; the echo still forwards the raw frame.
        }
        const out = Buffer.allocUnsafe(4 + length);
        out.writeUInt32BE(length, 0);
        body.copy(out, 4);
        socket.write(out);
      }
    });
    socket.on('error', () => undefined);
  });
  readonly receivedIds: string[] = [];

  async listen(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen({ host: '127.0.0.1', port: 0 }, () => {
        this.#server.removeListener('error', reject);
        resolve();
      });
    });
    const address = this.#server.address();
    if (address === null || typeof address !== 'object') throw new Error('echo upstream has no address');
    return address.port;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.#server.close(() => resolve());
      const guard = setTimeout(() => resolve(), 2_000);
      guard.unref?.();
    });
  }
}

async function rawExchange(proxy: TcpFaultProxy, count: number): Promise<readonly string[]> {
  const socket = net.connect({ host: '127.0.0.1', port: proxy.address!.port });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('raw connect timed out'));
    }, 3_000);
    timer.unref?.();
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  let buffer = Buffer.alloc(0);
  const responseIds: string[] = [];
  const onData = (chunk: Buffer): void => {
    buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 4) return;
      const length = buffer.readUInt32BE(0);
      if (length <= 0 || buffer.length < 4 + length) return;
      const body = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);
      try {
        const parsed = JSON.parse(body.toString('utf8')) as { id?: unknown };
        if (typeof parsed.id === 'string') responseIds.push(parsed.id);
      } catch {
        // Ignore unparsable bodies.
      }
    }
  };
  socket.on('data', onData);

  for (let index = 0; index < count; index += 1) {
    const frame = encodeTcpReplicaFrame({
      schema_version: 'mwha.protocol.v1',
      kind: 'query',
      id: `seed-${String(index)}`,
      payload: {},
    });
    socket.write(frame);
  }

  // Fixed drain window: the largest injected hold is the 100ms partial-reorder
  // flush plus 5ms delays, so 800ms collects every resulting response
  // deterministically regardless of machine speed.
  await sleep(800);
  socket.destroy();
  return responseIds;
}

async function runSeeded(t: TestContext, seed: string): Promise<RawRunResult> {
  const upstream = new FrameEchoUpstream();
  const upstreamPort = await upstream.listen();
  t.after(async () => {
    await upstream.close();
  });
  const rules: readonly TcpFaultRule[] = [
    { kind: 'delay', direction: 'both', probability: 0.25, delayMs: 5 },
    { kind: 'drop', direction: 'both', probability: 0.25 },
    { kind: 'duplicate', direction: 'both', probability: 0.25, duplicateCount: 1 },
    { kind: 'reorder', direction: 'client-to-server', probability: 0.5, reorderWindow: 4 },
    { kind: 'bandwidth', direction: 'both', bandwidthBytesPerSecond: 1_000_000, burstBytes: 65_536 },
  ];
  const proxy = await makeProxy(t, upstreamPort, rules, seed);
  const responseIds = await rawExchange(proxy, 24);
  return { stats: proxy.stats(), receivedIds: [...upstream.receivedIds], responseIds };
}

test('fixed seed reproduces the exact injection counts and server-side sequence', { timeout: 60_000 }, async (t) => {
  const first = await runSeeded(t, 'repro-A');
  const second = await runSeeded(t, 'repro-A');
  assert.deepEqual(second.stats, first.stats);
  assert.deepEqual(second.receivedIds, first.receivedIds);
  assert.deepEqual([...second.responseIds].sort(), [...first.responseIds].sort());

  // A different seed is allowed to differ; it must still produce a valid run.
  const third = await runSeeded(t, 'repro-B');
  assert.ok(third.stats.forwardedFrames > 0);
  assert.ok(third.receivedIds.length > 0);
});

// ---------------------------------------------------------------------------
// 10. Bounded shutdown / no leaks
// ---------------------------------------------------------------------------

test('close is idempotent, releases the port and leaves zero active connections', { timeout: 60_000 }, async (t) => {
  const service = new MemoryReplicaService('node-b');
  const server = await makeServer(t, service);
  const proxy = await makeProxy(t, server.address!.port);
  const port = proxy.address!.port;
  const client = makeClient(port);
  await client.connect();
  assert.equal(proxy.stats().activeConnections, 1);

  await proxy.close();
  await proxy.close();
  assert.equal(proxy.isClosed, true);
  assert.equal(proxy.address, null);
  assert.equal(proxy.stats().activeConnections, 0);

  await expectCode(() => client.status({ timeoutMs: 1_000 }), 'TCP_CONNECTION_CLOSED');
  await client.close();

  // The released listener port can be bound again: no lingering handle.
  await new Promise<void>((resolve, reject) => {
    const probe = net.createServer();
    const timer = setTimeout(() => {
      probe.close();
      reject(new Error(`port ${String(port)} was not released`));
    }, 3_000);
    timer.unref?.();
    probe.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    probe.listen({ host: '127.0.0.1', port }, () => {
      clearTimeout(timer);
      probe.close(() => resolve());
    });
  });

  assert.equal(proxy.stats().acceptedConnections, 1);
  assert.ok(proxy.stats().closedConnections >= 1);
});

// ---------------------------------------------------------------------------
// 11. Configuration boundaries
// ---------------------------------------------------------------------------

test('non-loopback listen/upstream is refused before bind/dial and the vocabulary is frozen', { timeout: 60_000 }, async () => {
  await expectCode(
    () => TcpFaultProxy.start({
      listen: { host: '192.0.2.1', port: 0 },
      upstream: { host: '127.0.0.1', port: 1 },
    }),
    'TCP_FAULT_PROXY_NON_LOOPBACK',
  );
  await expectCode(
    () => TcpFaultProxy.start({
      listen: { host: '127.0.0.1', port: 0 },
      upstream: { host: '0.0.0.0', port: 1 },
    }),
    'TCP_FAULT_PROXY_NON_LOOPBACK',
  );

  assert.deepEqual(TCP_FAULT_KINDS, mwhaFaultKinds);
  assert.ok(TCP_FAULT_PROXY_FAULT_INJECTION_SCOPE_NOTE.includes(MWHA_FAULT_INJECTION_SCOPE_NOTE));
  assert.ok(TCP_FAULT_PROXY_FAULT_INJECTION_SCOPE_NOTE.includes('≠ OS 真分区'));
  assert.ok(TCP_FAULT_PROXY_UNVERIFIED_BOUNDARIES.includes('physical-three-machine-cluster'));
});
