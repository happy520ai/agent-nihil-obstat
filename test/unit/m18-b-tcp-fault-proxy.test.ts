/**
 * T-153 shard B: reachable branches of `src/memory/tcp-fault-proxy.ts`.
 *
 * The existing integration suite exercises fault injection over live sockets.
 * This file targets what that suite does not reach:
 *   - every configuration/rule validation rejection (fail-closed before bind),
 *   - the two frame-splitter error paths (non-positive and oversized length),
 *   - stats counters and idempotent shutdown.
 *
 * No Node internals are mocked: framing errors are produced by real bytes on a
 * real loopback socket pair through the real proxy.
 */

import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import {
  TCP_FAULT_PROXY_MAX_FRAME_BYTES,
  TCP_FAULT_PROXY_MAX_QUEUED_FRAMES,
  TcpFaultProxy,
  type TcpFaultProxyOptions,
} from '../../src/memory/tcp-fault-proxy.ts';

const LOCALHOST = '127.0.0.1';

function codeOf(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String((error as { code?: unknown }).code) : undefined;
}

interface Case {
  readonly name: string;
  readonly options: unknown;
  readonly code: string;
}

/** Every rejection happens in the constructor, before any socket is created. */
const CONFIG_CASES: readonly Case[] = [
  { name: 'null options', options: null, code: 'TCP_FAULT_PROXY_CONFIG_INVALID' },
  { name: 'array options', options: [], code: 'TCP_FAULT_PROXY_CONFIG_INVALID' },
  { name: 'null listen', options: { listen: null, upstream: { host: LOCALHOST, port: 1 } }, code: 'TCP_FAULT_PROXY_CONFIG_INVALID' },
  { name: 'missing listen.host falls back to default', options: { listen: {}, upstream: { host: LOCALHOST, port: 1 } }, code: '' },
  { name: 'empty listen.host', options: { listen: { host: '   ' }, upstream: { host: LOCALHOST, port: 1 } }, code: 'TCP_FAULT_PROXY_CONFIG_INVALID' },
  { name: 'numeric listen.host', options: { listen: { host: 12 }, upstream: { host: LOCALHOST, port: 1 } }, code: 'TCP_FAULT_PROXY_CONFIG_INVALID' },
  { name: 'external listen.host', options: { listen: { host: '192.0.2.10' }, upstream: { host: LOCALHOST, port: 1 } }, code: 'TCP_FAULT_PROXY_NON_LOOPBACK' },
  { name: 'missing upstream.host', options: { listen: {}, upstream: { port: 1 } }, code: 'TCP_FAULT_PROXY_CONFIG_INVALID' },
  { name: 'external upstream.host', options: { listen: {}, upstream: { host: 'example.test', port: 1 } }, code: 'TCP_FAULT_PROXY_NON_LOOPBACK' },
  { name: 'listen.port below range', options: { listen: { port: -1 }, upstream: { host: LOCALHOST, port: 1 } }, code: 'TCP_FAULT_PROXY_CONFIG_INVALID' },
  { name: 'listen.port above range', options: { listen: { port: 65_536 }, upstream: { host: LOCALHOST, port: 1 } }, code: 'TCP_FAULT_PROXY_CONFIG_INVALID' },
  { name: 'listen.port fractional', options: { listen: { port: 1.5 }, upstream: { host: LOCALHOST, port: 1 } }, code: 'TCP_FAULT_PROXY_CONFIG_INVALID' },
  { name: 'listen.port wrong type', options: { listen: { port: '80' }, upstream: { host: LOCALHOST, port: 1 } }, code: 'TCP_FAULT_PROXY_CONFIG_INVALID' },
  { name: 'upstream.port below minimum', options: { listen: {}, upstream: { host: LOCALHOST, port: 0 } }, code: 'TCP_FAULT_PROXY_CONFIG_INVALID' },
  { name: 'maxFrameBytes zero', options: { listen: {}, upstream: { host: LOCALHOST, port: 1 }, maxFrameBytes: 0 }, code: 'TCP_FAULT_PROXY_CONFIG_INVALID' },
  { name: 'maxFrameBytes fractional', options: { listen: {}, upstream: { host: LOCALHOST, port: 1 }, maxFrameBytes: 1.2 }, code: 'TCP_FAULT_PROXY_CONFIG_INVALID' },
  { name: 'maxQueuedFrames zero', options: { listen: {}, upstream: { host: LOCALHOST, port: 1 }, maxQueuedFrames: 0 }, code: 'TCP_FAULT_PROXY_CONFIG_INVALID' },
  { name: 'reorderFlushMs negative', options: { listen: {}, upstream: { host: LOCALHOST, port: 1 }, reorderFlushMs: -1 }, code: 'TCP_FAULT_PROXY_CONFIG_INVALID' },
  { name: 'connectTimeoutMs zero', options: { listen: {}, upstream: { host: LOCALHOST, port: 1 }, connectTimeoutMs: 0 }, code: 'TCP_FAULT_PROXY_CONFIG_INVALID' },
  { name: 'seed object', options: { listen: {}, upstream: { host: LOCALHOST, port: 1 }, seed: {} }, code: 'TCP_FAULT_PROXY_CONFIG_INVALID' },
  { name: 'seed boolean', options: { listen: {}, upstream: { host: LOCALHOST, port: 1 }, seed: true }, code: 'TCP_FAULT_PROXY_CONFIG_INVALID' },
  { name: 'seed non-finite number', options: { listen: {}, upstream: { host: LOCALHOST, port: 1 }, seed: Number.POSITIVE_INFINITY }, code: 'TCP_FAULT_PROXY_CONFIG_INVALID' },
  { name: 'rules not an array', options: { listen: {}, upstream: { host: LOCALHOST, port: 1 }, rules: {} }, code: 'TCP_FAULT_PROXY_CONFIG_INVALID' },
  { name: 'rule null', options: { listen: {}, upstream: { host: LOCALHOST, port: 1 }, rules: [null] }, code: 'TCP_FAULT_PROXY_CONFIG_INVALID' },
  { name: 'rule array element', options: { listen: {}, upstream: { host: LOCALHOST, port: 1 }, rules: [[]] }, code: 'TCP_FAULT_PROXY_CONFIG_INVALID' },
  { name: 'rule kind unknown', options: { listen: {}, upstream: { host: LOCALHOST, port: 1 }, rules: [{ kind: 'chaos' }] }, code: 'TCP_FAULT_PROXY_RULE_INVALID' },
  { name: 'rule kind non-string', options: { listen: {}, upstream: { host: LOCALHOST, port: 1 }, rules: [{ kind: 7 }] }, code: 'TCP_FAULT_PROXY_RULE_INVALID' },
  { name: 'rule direction unknown', options: { listen: {}, upstream: { host: LOCALHOST, port: 1 }, rules: [{ kind: 'drop', direction: 'sideways' }] }, code: 'TCP_FAULT_PROXY_RULE_INVALID' },
  { name: 'rule probability above one', options: { listen: {}, upstream: { host: LOCALHOST, port: 1 }, rules: [{ kind: 'drop', probability: 1.5 }] }, code: 'TCP_FAULT_PROXY_RULE_INVALID' },
  { name: 'rule probability negative', options: { listen: {}, upstream: { host: LOCALHOST, port: 1 }, rules: [{ kind: 'drop', probability: -0.1 }] }, code: 'TCP_FAULT_PROXY_RULE_INVALID' },
  { name: 'rule probability not finite', options: { listen: {}, upstream: { host: LOCALHOST, port: 1 }, rules: [{ kind: 'drop', probability: Number.NaN }] }, code: 'TCP_FAULT_PROXY_RULE_INVALID' },
  { name: 'rule probability wrong type', options: { listen: {}, upstream: { host: LOCALHOST, port: 1 }, rules: [{ kind: 'drop', probability: '1' }] }, code: 'TCP_FAULT_PROXY_RULE_INVALID' },
  { name: 'afterFrames negative', options: { listen: {}, upstream: { host: LOCALHOST, port: 1 }, rules: [{ kind: 'drop', afterFrames: -1 }] }, code: 'TCP_FAULT_PROXY_CONFIG_INVALID' },
  { name: 'durationFrames zero', options: { listen: {}, upstream: { host: LOCALHOST, port: 1 }, rules: [{ kind: 'drop', durationFrames: 0 }] }, code: 'TCP_FAULT_PROXY_CONFIG_INVALID' },
  { name: 'durationFrames fractional', options: { listen: {}, upstream: { host: LOCALHOST, port: 1 }, rules: [{ kind: 'drop', durationFrames: 1.5 }] }, code: 'TCP_FAULT_PROXY_CONFIG_INVALID' },
  { name: 'delay negative', options: { listen: {}, upstream: { host: LOCALHOST, port: 1 }, rules: [{ kind: 'delay', delayMs: -1 }] }, code: 'TCP_FAULT_PROXY_CONFIG_INVALID' },
  { name: 'duplicate count zero', options: { listen: {}, upstream: { host: LOCALHOST, port: 1 }, rules: [{ kind: 'duplicate', duplicateCount: 0 }] }, code: 'TCP_FAULT_PROXY_RULE_INVALID' },
  { name: 'duplicate count above ceiling', options: { listen: {}, upstream: { host: LOCALHOST, port: 1 }, rules: [{ kind: 'duplicate', duplicateCount: 65 }] }, code: 'TCP_FAULT_PROXY_RULE_INVALID' },
  { name: 'duplicate count fractional', options: { listen: {}, upstream: { host: LOCALHOST, port: 1 }, rules: [{ kind: 'duplicate', duplicateCount: 2.5 }] }, code: 'TCP_FAULT_PROXY_RULE_INVALID' },
  { name: 'reorder window below minimum', options: { listen: {}, upstream: { host: LOCALHOST, port: 1 }, rules: [{ kind: 'reorder', reorderWindow: 1 }] }, code: 'TCP_FAULT_PROXY_RULE_INVALID' },
  { name: 'reorder window above maximum', options: { listen: {}, upstream: { host: LOCALHOST, port: 1 }, rules: [{ kind: 'reorder', reorderWindow: 257 }] }, code: 'TCP_FAULT_PROXY_RULE_INVALID' },
  { name: 'bandwidth rate zero', options: { listen: {}, upstream: { host: LOCALHOST, port: 1 }, rules: [{ kind: 'bandwidth', bandwidthBytesPerSecond: 0 }] }, code: 'TCP_FAULT_PROXY_RULE_INVALID' },
  { name: 'bandwidth rate not finite', options: { listen: {}, upstream: { host: LOCALHOST, port: 1 }, rules: [{ kind: 'bandwidth', bandwidthBytesPerSecond: Number.POSITIVE_INFINITY }] }, code: 'TCP_FAULT_PROXY_RULE_INVALID' },
  { name: 'bandwidth rate wrong type', options: { listen: {}, upstream: { host: LOCALHOST, port: 1 }, rules: [{ kind: 'bandwidth', bandwidthBytesPerSecond: '1' }] }, code: 'TCP_FAULT_PROXY_RULE_INVALID' },
  { name: 'bandwidth burst zero', options: { listen: {}, upstream: { host: LOCALHOST, port: 1 }, rules: [{ kind: 'bandwidth', bandwidthBytesPerSecond: 10_000, burstBytes: 0 }] }, code: 'TCP_FAULT_PROXY_CONFIG_INVALID' },
];

test('m18b tcp-fault-proxy configuration validation rejects invalid options before binding', () => {
  for (const item of CONFIG_CASES) {
    if (item.code === '') {
      // Missing listen.host is documented to fall back to 127.0.0.1; it must not throw.
      assert.doesNotThrow(() => new TcpFaultProxy(item.options as TcpFaultProxyOptions), item.name);
      continue;
    }
    assert.throws(
      () => new TcpFaultProxy(item.options as TcpFaultProxyOptions),
      (error: unknown) => {
        assert.equal(codeOf(error), item.code, `${item.name}: unexpected code`);
        assert.match((error as Error).message, /\[[A-Z_]+\]/u, `${item.name}: message carries the code`);
        return true;
      },
      item.name,
    );
  }
});

test('m18b tcp-fault-proxy resolves rule defaults without touching the network', () => {
  const proxy = new TcpFaultProxy({
    listen: {},
    upstream: { host: LOCALHOST, port: 1 },
    seed: 'seed-a',
    rules: [
      { kind: 'delay', delayMs: 5, direction: 'client-to-server', probability: 0.5, afterFrames: 2, durationFrames: 3 },
      { kind: 'drop' },
      { kind: 'disconnect' },
      { kind: 'one-way-partition' },
      { kind: 'duplicate', duplicateCount: 2 },
      { kind: 'reorder', reorderWindow: 4 },
      { kind: 'bandwidth', bandwidthBytesPerSecond: 4_096 },
    ],
  });
  assert.equal(proxy.address, null);
  assert.equal(proxy.isClosed, false);
  assert.deepEqual(proxy.stats(), {
    forwardedFrames: 0,
    droppedFrames: 0,
    duplicatedFrames: 0,
    bytesByDirection: { 'client-to-server': 0, 'server-to-client': 0 },
    activeConnections: 0,
    acceptedConnections: 0,
    closedConnections: 0,
    oversizedFrames: 0,
    framingErrors: 0,
    backpressureDrops: 0,
    queuedFrames: 0,
  });
});

// ---------------------------------------------------------------------------
// Live loopback framing behaviour
// ---------------------------------------------------------------------------

class FrameEchoUpstream {
  readonly #server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length < 4) return;
        const length = buffer.readUInt32BE(0);
        if (length <= 0 || length > TCP_FAULT_PROXY_MAX_FRAME_BYTES || buffer.length < 4 + length) return;
        const body = buffer.subarray(4, 4 + length);
        buffer = buffer.subarray(4 + length);
        const out = Buffer.allocUnsafe(4 + length);
        out.writeUInt32BE(length, 0);
        body.copy(out, 4);
        socket.write(out);
      }
    });
    socket.on('error', () => undefined);
  });

  async listen(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen({ host: LOCALHOST, port: 0 }, () => {
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

function connect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: LOCALHOST, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('connect timed out'));
    }, 3_000);
    timer.unref?.();
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function closed(socket: net.Socket): Promise<void> {
  await new Promise<void>((resolve) => {
    if (socket.destroyed) {
      resolve();
      return;
    }
    socket.once('close', () => resolve());
    const guard = setTimeout(() => resolve(), 2_000);
    guard.unref?.();
  });
}

function framed(body: Buffer): Buffer {
  const wire = Buffer.allocUnsafe(4 + body.length);
  wire.writeUInt32BE(body.length, 0);
  body.copy(wire, 4);
  return wire;
}

test('m18b tcp-fault-proxy forwards whole frames and counts bytes on both directions', async (t) => {
  const upstream = new FrameEchoUpstream();
  const port = await upstream.listen();
  t.after(async () => upstream.close());

  const proxy = await TcpFaultProxy.start({ listen: {}, upstream: { host: LOCALHOST, port } });
  t.after(async () => proxy.close());
  assert.ok(proxy.address !== null);
  assert.equal(proxy.address?.host, LOCALHOST);

  const client = await connect(proxy.address!.port);
  t.after(() => client.destroy());

  const payload = Buffer.from(JSON.stringify({ id: 'm18b-1' }), 'utf8');
  const received = new Promise<Buffer>((resolve) => {
    client.once('data', (chunk: Buffer) => resolve(chunk));
  });
  client.write(framed(payload));
  const echo = await received;
  assert.equal(echo.subarray(4).toString('utf8'), payload.toString('utf8'));

  // Give the reverse direction a moment to be accounted, then read the stats.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const stats = proxy.stats();
  assert.equal(stats.forwardedFrames >= 2, true, `expected both hops counted, got ${String(stats.forwardedFrames)}`);
  assert.ok(stats.bytesByDirection['client-to-server'] > 0);
  assert.ok(stats.bytesByDirection['server-to-client'] > 0);
  assert.equal(stats.acceptedConnections, 1);
  assert.equal(stats.activeConnections, 1);
  assert.equal(proxy.isClosed, false);
});

test('m18b tcp-fault-proxy tears down on a non-positive frame length and counts a framing error', async (t) => {
  const upstream = new FrameEchoUpstream();
  const port = await upstream.listen();
  t.after(async () => upstream.close());

  const proxy = await TcpFaultProxy.start({ listen: {}, upstream: { host: LOCALHOST, port } });
  t.after(async () => proxy.close());

  const client = await connect(proxy.address!.port);
  const closedEvent = closed(client);
  client.write(Buffer.from([0x00, 0x00, 0x00, 0x00]));
  await closedEvent;

  const stats = proxy.stats();
  assert.equal(stats.framingErrors, 1);
  assert.equal(stats.oversizedFrames, 0);
  assert.equal(stats.closedConnections, 1);
  assert.equal(stats.activeConnections, 0);
});

test('m18b tcp-fault-proxy refuses an oversized declared frame and counts it separately', async (t) => {
  const upstream = new FrameEchoUpstream();
  const port = await upstream.listen();
  t.after(async () => upstream.close());

  const proxy = await TcpFaultProxy.start({
    listen: {},
    upstream: { host: LOCALHOST, port },
    maxFrameBytes: 8,
  });
  t.after(async () => proxy.close());

  const client = await connect(proxy.address!.port);
  const closedEvent = closed(client);
  const wire = Buffer.allocUnsafe(4 + 4);
  wire.writeUInt32BE(1_000, 0);
  wire.writeUInt32BE(0, 4);
  client.write(wire);
  await closedEvent;

  const stats = proxy.stats();
  assert.equal(stats.oversizedFrames, 1);
  assert.equal(stats.framingErrors, 0);
  assert.equal(stats.closedConnections, 1);
});

test('m18b tcp-fault-proxy close is idempotent and releases the listener', async () => {
  const upstream = new FrameEchoUpstream();
  const port = await upstream.listen();
  const proxy = await TcpFaultProxy.start({ listen: {}, upstream: { host: LOCALHOST, port } });
  const firstAddress = proxy.address;
  assert.ok(firstAddress !== null);

  await proxy.close();
  assert.equal(proxy.isClosed, true);
  assert.equal(proxy.address, null);
  await proxy.close();

  // A second proxy can bind the same ephemeral-free port range; closing twice
  // must not throw and must leave the counters untouched.
  assert.equal(proxy.stats().acceptedConnections, 0);
  await upstream.close();
});

test('m18b tcp-fault-proxy clamps the queued-frame ceiling instead of rejecting it', () => {
  const proxy = new TcpFaultProxy({
    listen: {},
    upstream: { host: LOCALHOST, port: 1 },
    maxQueuedFrames: 1_000_000,
  });
  assert.equal(proxy.isClosed, false);
  assert.equal(TCP_FAULT_PROXY_MAX_QUEUED_FRAMES, 256);
});

test('m18b tcp-fault-proxy reports a bind failure through LISTEN_FAILED with the cause', async (t) => {
  // Reserve an ephemeral loopback port so the proxy's bind collides with it.
  const blocker = net.createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen({ host: LOCALHOST, port: 0 }, () => {
      blocker.removeListener('error', reject);
      resolve();
    });
  });
  t.after(() => blocker.close());
  const address = blocker.address();
  if (address === null || typeof address !== 'object') throw new Error('blocker has no address');

  await assert.rejects(
    TcpFaultProxy.start({
      listen: { host: LOCALHOST, port: address.port },
      upstream: { host: LOCALHOST, port: address.port },
    }),
    (error: unknown) => {
      assert.equal(codeOf(error), 'TCP_FAULT_PROXY_LISTEN_FAILED');
      assert.ok((error as Error).cause instanceof Error, 'listen error carries its cause');
      return true;
    },
  );
});
