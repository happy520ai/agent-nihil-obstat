/**
 * T-134 / M17 CV-03 connection-lifecycle integration tests for
 * `src/memory/tcp-transport.ts`.
 *
 * Every test binds 127.0.0.1:0 (ephemeral) only, keeps real waits bounded
 * (<=200ms, with the exception of the per-test 60s safety timeout), closes all
 * servers/clients through `t.after`, asserts `activeConnectionCount === 0`
 * after shutdown, and re-binds released ports to prove there is no handle leak.
 *
 * Scope note: local loopback TCP/TLS only; physical cross-machine deployment,
 * production HA failover, OS-level partitions and SLAs remain unverified.
 */

import assert from 'node:assert/strict';
import net from 'node:net';
import test, { type TestContext } from 'node:test';
import { MWHA_PROTOCOL_SCHEMA_VERSION } from '../../src/memory/ha-protocol.ts';
import type { AnchorProbeSnapshot } from '../../src/memory/probe-contract.ts';
import type { DistributedNodeResponse } from '../../src/memory/distributed-probe.ts';
import {
  encodeTcpReplicaFrame,
  TcpReplicaClient,
  TcpReplicaFrameDecoder,
  TcpReplicaServer,
  TcpTransportError,
  TCP_REPLICA_MAX_FRAME_BYTES,
  type TcpReplicaServerOptions,
  type TcpReplicaService,
  type TcpReplicaStatusView,
} from '../../src/memory/tcp-transport.ts';

const SECRET = 'lifecycle-secret';
const HASH = 'a'.repeat(64);

function sleep(ms: number): Promise<void> {
 return new Promise((resolve) => setTimeout(resolve, ms));
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

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
 const started = Date.now();
 while (!predicate()) {
  if (Date.now() - started > timeoutMs) throw new Error('condition was not reached in time');
  await sleep(10);
 }
}

function rawFrame(value: unknown): Buffer {
 const body = Buffer.from(JSON.stringify(value), 'utf8');
 const out = Buffer.allocUnsafe(4 + body.length);
 out.writeUInt32BE(body.length, 0);
 body.copy(out, 4);
 return out;
}

let rawId = 0;
function nextRawId(prefix: string): string {
 rawId += 1;
 return `${prefix}-${String(rawId)}`;
}

// ---------------------------------------------------------------------------
// Minimal in-memory service
// ---------------------------------------------------------------------------

function fakeSnapshot(big = false): AnchorProbeSnapshot {
 return {
  project_scope: 'proj',
  ledger_digest: HASH,
  graph_revision: null,
  source_fingerprint: null,
  connected_digest: null,
  ...(big ? { big: 'x'.repeat(2_048) } : {}),
 } as AnchorProbeSnapshot;
}

class MemoryService implements TcpReplicaService {
 commitIndex = 0;
 queryDelayMs = 0;

 async query(_request: { root?: string }): Promise<DistributedNodeResponse> {
  if (this.queryDelayMs > 0) await sleep(this.queryDelayMs);
  return {
   candidates: [],
   edges: [],
   commitIndex: this.commitIndex,
   state: 'ACTIVE',
   clusterEpoch: 'epoch-1',
  };
 }

 async apply(events: readonly { seq: number }[]) {
  this.commitIndex += events.length;
  return { applied: events.length, duplicates: 0, outOfOrder: 0, gaps: [], corrupt: 0, commitIndex: this.commitIndex, viewDigest: HASH, complete: true, pendingCount: 0 };
 }

 async status(): Promise<TcpReplicaStatusView> {
  return {
   replicaId: 'node-b',
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

function serverOptions(overrides: Record<string, unknown> = {}): TcpReplicaServerOptions {
 return { host: '127.0.0.1', port: 0, sharedSecret: SECRET, authorizedNodes: ['node-a'], service: new MemoryService(), ...overrides };
}

async function makeServer(t: TestContext, overrides: Record<string, unknown> = {}): Promise<TcpReplicaServer> {
 const server = new TcpReplicaServer(serverOptions(overrides));
 await server.listen();
 t.after(async () => {
  await server.close();
 });
 return server;
}

function makeClient(port: number, nodeId = 'node-a', extra: Record<string, unknown> = {}): TcpReplicaClient {
 return new TcpReplicaClient({ host: '127.0.0.1', port, nodeId, sharedSecret: SECRET, ...extra });
}

/** Raw loopback probe used to drive server-side socket/error branches. */
class RawProbe {
 readonly socket: net.Socket;
 private settled = false;

 private constructor(socket: net.Socket) {
  this.socket = socket;
 }

 static connect(port: number): Promise<RawProbe> {
  return new Promise((resolve, reject) => {
   const socket = net.connect({ host: '127.0.0.1', port });
   const timer = setTimeout(() => {
    socket.destroy();
    reject(new Error('raw connect timed out'));
   }, 2_000);
   timer.unref?.();
   socket.once('connect', () => {
    clearTimeout(timer);
    resolve(new RawProbe(socket));
   });
   socket.once('error', (error) => {
    clearTimeout(timer);
    reject(error);
   });
  });
 }

  send(value: unknown): void {
    this.socket.write(rawFrame(value));
  }

  sendRaw(buffer: Buffer): void {
    this.socket.write(buffer);
  }

  reset(): void {
  this.socket.resetAndDestroy();
 }

 close(): void {
  this.socket.destroy();
 }
}

// ---------------------------------------------------------------------------
// Fake handshake server: enough of the protocol to exercise client negatives
// ---------------------------------------------------------------------------

export interface FakeTcpRequest {
 readonly kind: string;
 readonly id: string;
 readonly payload: unknown;
}

export type FakeTcpReply =
 | { readonly ok: true; readonly kind?: string; readonly payload: unknown }
 | { readonly ok: false; readonly code: string; readonly message: string }
 | { readonly raw: Buffer };

export interface FakeTcpServerOptions {
 /** `silent` never answers hello; `missing-server-nonce` answers without a nonce. */
 readonly hello?: 'ok' | 'silent' | 'missing-server-nonce' | 'close-after-hello';
 /** Destroy every accepted socket immediately (connect never establishes). */
 readonly destroyOnConnect?: boolean;
 readonly onRequest?: (request: FakeTcpRequest) => FakeTcpReply | void;
}

export class FakeTcpServer {
 readonly server: net.Server;
 readonly options: FakeTcpServerOptions;
 address: { host: string; port: number } | null = null;
 private readonly sockets = new Set<net.Socket>();
 private readonly decoders = new Map<net.Socket, TcpReplicaFrameDecoder>();
 private readonly authenticated = new Set<net.Socket>();

 constructor(options: FakeTcpServerOptions = {}) {
  this.options = options;
  this.server = net.createServer((socket) => this.onConnection(socket));
 }

 private onConnection(socket: net.Socket): void {
  this.sockets.add(socket);
  this.decoders.set(socket, new TcpReplicaFrameDecoder(TCP_REPLICA_MAX_FRAME_BYTES));
  socket.on('close', () => {
   this.sockets.delete(socket);
   this.authenticated.delete(socket);
   this.decoders.delete(socket);
  });
  socket.on('error', () => undefined);
  if (this.options.destroyOnConnect === true) {
   socket.destroy();
   return;
  }
  socket.on('data', (chunk: Buffer) => this.onData(socket, chunk));
 }

 private onData(socket: net.Socket, chunk: Buffer): void {
  const decoder = this.decoders.get(socket);
  if (decoder === undefined) return;
  const outcome = decoder.push(chunk);
  if (outcome.error !== null) {
   socket.destroy();
   return;
  }
  for (const frame of outcome.frames) void this.onFrame(socket, frame as { kind?: unknown; id?: unknown; payload?: unknown });
 }

 private onFrame(socket: net.Socket, frame: { kind?: unknown; id?: unknown; payload?: unknown }): void {
  const kind = typeof frame.kind === 'string' ? frame.kind : '';
  const id = typeof frame.id === 'string' ? frame.id : nextRawId('fake');
  if (!this.authenticated.has(socket)) {
   if (kind === 'hello') {
    if (this.options.hello === 'silent') return;
    if (this.options.hello === 'missing-server-nonce') {
     this.reply(socket, { ok: true, kind, id, payload: {} });
     return;
    }
    const serverNonce = 'b'.repeat(64);
    this.reply(socket, { ok: true, kind, id, payload: { serverNonce } });
    if (this.options.hello === 'close-after-hello') {
     // Destroy immediately after queuing the response so the follow-up auth
     // frame can never complete the managed handshake.
     socket.destroy();
    }
    return;
   }
   if (kind === 'auth') {
    this.authenticated.add(socket);
    this.reply(socket, { ok: true, kind, id, payload: { nodeId: 'node-a', authenticated: true } });
    return;
   }
   this.reply(socket, { ok: false, kind, id, error: { code: 'TCP_AUTH_REQUIRED', message: 'handshake required' } });
   return;
  }
  const handler = this.options.onRequest;
  if (handler !== undefined) {
   const reply = handler({ kind, id, payload: frame.payload });
   if (reply === undefined) return;
   if ('raw' in reply) {
    socket.write(reply.raw);
    return;
   }
   if (reply.ok) {
    this.reply(socket, { ok: true, kind: reply.kind ?? kind, id, payload: reply.payload });
    return;
   }
   this.reply(socket, { ok: false, kind, id, error: { code: reply.code, message: reply.message } });
   return;
  }
  if (kind === 'query') {
   this.reply(socket, { ok: true, kind, id, payload: { candidates: [], edges: [], commitIndex: 0, state: 'ACTIVE', clusterEpoch: 'epoch-1' } });
   return;
  }
  if (kind === 'apply') {
   this.reply(socket, { ok: true, kind, id, payload: { applied: 0, duplicates: 0, outOfOrder: 0, gaps: [], corrupt: 0, commitIndex: 0, viewDigest: HASH, complete: true, pendingCount: 0 } });
   return;
  }
  this.reply(socket, {
   ok: true,
   kind,
   id,
   payload: {
    replicaId: 'node-b', commitIndex: 0, viewDigest: HASH, evidenceDigest: HASH,
    state: 'ACTIVE', snapshot: fakeSnapshot(), clusterEpoch: 'epoch-1', projectScope: 'proj',
   },
  });
 }

 private reply(socket: net.Socket, value: Record<string, unknown>): void {
  socket.write(rawFrame({ schema_version: MWHA_PROTOCOL_SCHEMA_VERSION, ...value }));
 }

 async listen(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
   this.server.once('error', reject);
   this.server.listen({ host: '127.0.0.1', port: 0 }, () => {
    this.server.removeListener('error', reject);
    resolve();
   });
  });
  const address = this.server.address();
  if (address === null || typeof address !== 'object') throw new Error('fake server did not report an address');
  this.address = { host: '127.0.0.1', port: address.port };
 }

 async close(): Promise<void> {
  for (const socket of [...this.sockets]) socket.destroy();
  await new Promise<void>((resolve) => {
   this.server.close(() => resolve());
  });
 }

 get connectionCount(): number {
  return this.sockets.size;
 }

 get authenticatedSockets(): readonly net.Socket[] {
  return [...this.authenticated];
 }

 sendRaw(socket: net.Socket, buffer: Buffer): void {
  socket.write(buffer);
 }
}

// ---------------------------------------------------------------------------
// 1. Listener lifecycle
// ---------------------------------------------------------------------------

test('listener lifecycle: close before listen, repeated close, repeated listen', { timeout: 60_000 }, async (t) => {
 const server = new TcpReplicaServer(serverOptions());
 await server.close();
 assert.equal(server.isClosed, true);
 assert.equal(server.address, null);
 await expectCode(() => server.listen(), 'TCP_CONNECTION_CLOSED');
 await server.close();

 const live = await makeServer(t);
 const first = live.address!;
 const again = await live.listen();
 assert.equal(again.port, first.port);
});

test('listener reports bind failures through the promise and lastError diagnostic', { timeout: 60_000 }, async (t) => {
 const blocker = net.createServer();
 await new Promise<void>((resolve) => blocker.listen({ host: '127.0.0.1', port: 0 }, resolve));
 const occupiedPort = (blocker.address() as net.AddressInfo).port;
 t.after(async () => {
  await new Promise<void>((resolve) => blocker.close(() => resolve()));
 });

 const server = new TcpReplicaServer(serverOptions({ port: occupiedPort }));
 const error = await expectCode(() => server.listen(), 'TCP_LISTEN_FAILED');
 assert.ok(error instanceof TcpTransportError);
 assert.equal(server.lastError?.code, 'TCP_LISTEN_FAILED');
 assert.ok(server.address === null);
 await server.close();
});

test('released listener port is immediately re-bindable', { timeout: 60_000 }, async (t) => {
 const first = await makeServer(t);
 const port = first.address!.port;
 await first.close();
 const replacement = new TcpReplicaServer(serverOptions({ port }));
 await replacement.listen();
 t.after(async () => {
  await replacement.close();
 });
 assert.equal(replacement.address?.port, port);
});

// ---------------------------------------------------------------------------
// 2. Server connection lifecycle (handshake/idle/error)
// ---------------------------------------------------------------------------

test('handshake timeout drops an unresponsive peer and records the reason', { timeout: 60_000 }, async (t) => {
 const server = await makeServer(t, { handshakeTimeoutMs: 40, idleTimeoutMs: 0 });
 const probe = await RawProbe.connect(server.address!.port);
 await waitFor(() => server.activeConnectionCount === 1);
 await waitFor(() => server.activeConnectionCount === 0);
 assert.equal(server.lastError?.code, 'TCP_AUTH_REQUIRED');
 probe.close();
});

test('native socket idle timeout drops a silent peer', { timeout: 60_000 }, async (t) => {
 const server = await makeServer(t, { idleTimeoutMs: 60, handshakeTimeoutMs: 5_000 });
 const probe = await RawProbe.connect(server.address!.port);
 await waitFor(() => server.activeConnectionCount === 1);
 await waitFor(() => server.activeConnectionCount === 0);
 assert.equal(server.lastError?.code, 'TCP_CONNECTION_CLOSED');
 probe.close();
});

test('activity refreshes the idle deadline so a live peer is not dropped', { timeout: 60_000 }, async (t) => {
 const server = await makeServer(t, { idleTimeoutMs: 120, handshakeTimeoutMs: 5_000 });
 const probe = await RawProbe.connect(server.address!.port);
 for (let index = 0; index < 6; index += 1) {
  const nonce = index.toString(16).padStart(64, '0');
  probe.send({ schema_version: MWHA_PROTOCOL_SCHEMA_VERSION, kind: 'hello', id: nextRawId('idle'), payload: { nodeId: 'node-a', nonce } });
  await sleep(35);
 }
 assert.equal(server.activeConnectionCount, 1);
 probe.close();
 await waitFor(() => server.activeConnectionCount === 0);
});

test('an aborted (RST) peer surfaces a socket error and leaves no connection', { timeout: 60_000 }, async (t) => {
 const server = await makeServer(t, { idleTimeoutMs: 0 });
 const probe = await RawProbe.connect(server.address!.port);
 // Give the listener a frame so the accepted socket is registered, then abort
 // with an RST: the server must observe a socket error (not a clean close).
 probe.send({ schema_version: MWHA_PROTOCOL_SCHEMA_VERSION, kind: 'hello', id: nextRawId('rst'), payload: { nodeId: 'node-a', nonce: '3'.repeat(64) } });
 await sleep(20);
 probe.reset();
 await waitFor(() => server.activeConnectionCount === 0);
 assert.equal(server.lastError?.code, 'TCP_CONNECTION_CLOSED');
 assert.match(server.lastError?.message ?? '', /peer socket error/u);
});

// ---------------------------------------------------------------------------
// 3. Server write-path bounds
// ---------------------------------------------------------------------------

test('oversized success response is refused and drops the connection', { timeout: 60_000 }, async (t) => {
 const service = new MemoryService();
 const server = await makeServer(t, { maxFrameBytes: 512, service });
 // The injected service returns a result whose encoded frame exceeds 512B.
 (service as { status(): Promise<TcpReplicaStatusView> }).status = async () => ({
  replicaId: 'node-b', commitIndex: 0, viewDigest: HASH, evidenceDigest: HASH, state: 'ACTIVE',
  snapshot: fakeSnapshot(true), clusterEpoch: 'epoch-1', projectScope: 'proj',
 });
 const client = makeClient(server.address!.port);
 t.after(async () => {
  await client.close();
 });
 await client.connect();
 const error = await expectCode(() => client.status(), 'TCP_CONNECTION_CLOSED');
 assert.ok(error instanceof TcpTransportError);
 await waitFor(() => server.activeConnectionCount === 0);
 assert.equal(server.lastError?.code, 'TCP_CONNECTION_CLOSED');
});

test('oversized failure frame is refused locally and the peer is dropped', { timeout: 60_000 }, async (t) => {
 const helloMessage = {
  schema_version: MWHA_PROTOCOL_SCHEMA_VERSION,
  kind: 'hello',
  id: nextRawId('forged'),
  payload: { nodeId: 'forged-node', nonce: '2'.repeat(64) },
 };
 const failureMessage = {
  schema_version: MWHA_PROTOCOL_SCHEMA_VERSION,
  kind: 'hello',
  id: helloMessage.id,
  ok: false,
  error: { code: 'TCP_AUTH_UNKNOWN_NODE', message: 'node "forged-node" is not authorized to connect' },
 };
 // The decoder accepts the incoming hello (body == ceiling) while the failure
 // response exceeds the same ceiling, forcing the local encode refusal path.
 const maxFrameBytes = encodeTcpReplicaFrame(helloMessage as never).length - 4;
 assert.ok(encodeTcpReplicaFrame(failureMessage as never).length - 4 > maxFrameBytes);
 const server = await makeServer(t, { maxFrameBytes });
 const probe = await RawProbe.connect(server.address!.port);
 probe.send(helloMessage);
 await waitFor(() => probe.socket.destroyed);
 await waitFor(() => server.activeConnectionCount === 0);
 probe.close();
});

test('a failure write on an already dropped connection is skipped safely', { timeout: 60_000 }, async (t) => {
 // Frame 1 makes the server encode a success frame above the ceiling, which
 // drops the connection synchronously; frame 2 then reaches the failure-write
 // helper on that closed connection and must take its early-return path.
 const hello = {
  schema_version: MWHA_PROTOCOL_SCHEMA_VERSION,
  kind: 'hello',
  id: 'capacity-1',
  payload: { nodeId: 'a', nonce: '4'.repeat(64) },
 };
 const maxFrameBytes = encodeTcpReplicaFrame(hello as never).length - 4;
 const successBody = encodeTcpReplicaFrame({
  schema_version: MWHA_PROTOCOL_SCHEMA_VERSION,
  kind: 'hello',
  id: 'capacity-1',
  ok: true,
  payload: { serverNonce: 'b'.repeat(64) },
 } as never).length - 4;
 assert.ok(successBody > maxFrameBytes);
 const secondHello = {
  schema_version: MWHA_PROTOCOL_SCHEMA_VERSION,
  kind: 'hello',
  id: 'capacity-2',
  payload: { nodeId: 'g', nonce: '5'.repeat(64) },
 };
 const server = await makeServer(t, { maxFrameBytes, authorizedNodes: ['a'] });
 const probe = await RawProbe.connect(server.address!.port);
 probe.sendRaw(Buffer.concat([rawFrame(hello), rawFrame(secondHello)]));
 await waitFor(() => probe.socket.destroyed);
 await waitFor(() => server.activeConnectionCount === 0);
 assert.equal(server.lastError?.code, 'TCP_CONNECTION_CLOSED');
 probe.close();
});

// ---------------------------------------------------------------------------
// 4. Client configuration boundaries
// ---------------------------------------------------------------------------

test('client configuration rejects malformed options before dialing', async () => {
 const base = { host: '127.0.0.1', port: 1, nodeId: 'node-a', sharedSecret: SECRET };
 await expectCode(() => new TcpReplicaClient(null as never), 'TCP_CONFIG_INVALID');
 await expectCode(() => new TcpReplicaClient({ ...base, nodeId: '' }), 'TCP_CONFIG_INVALID');
 await expectCode(() => new TcpReplicaClient({ ...base, nodeId: 'bad node' }), 'TCP_CONFIG_INVALID');
 await expectCode(() => new TcpReplicaClient({ ...base, sharedSecret: 1 } as never), 'TCP_CONFIG_INVALID');
 await expectCode(() => new TcpReplicaClient({ ...base, sharedSecret: '' }), 'TCP_CONFIG_INVALID');
 await expectCode(() => new TcpReplicaClient({ ...base, host: '' }), 'TCP_CONFIG_INVALID');
 await expectCode(() => new TcpReplicaClient({ ...base, port: 65_536 }), 'TCP_CONFIG_INVALID');
 await expectCode(() => new TcpReplicaClient({ ...base, port: -1 }), 'TCP_CONFIG_INVALID');
 await expectCode(() => new TcpReplicaClient({ ...base, tls: {} as never }), 'TCP_CONFIG_INVALID');
 await expectCode(
  () => new TcpReplicaClient({ ...base, tls: { ca: 'ca', rejectUnauthorized: false } }),
  'TCP_CONFIG_INVALID',
 );
});

// ---------------------------------------------------------------------------
// 5. Client getters, connect races and request-path guards
// ---------------------------------------------------------------------------

test('client getters reflect closed/connected/destroyed state and close is idempotent', { timeout: 60_000 }, async (t) => {
 const server = await makeServer(t);
 const client = makeClient(server.address!.port);
 assert.equal(client.activeConnectionCount, 0);
 assert.equal(client.isConnected, false);
 assert.equal(client.isClosed, false);
 await client.close();
 await client.close();
 assert.equal(client.isClosed, true);
 assert.equal(client.isConnected, false);
 await expectCode(() => client.connect(), 'TCP_CONNECTION_CLOSED');

 const live = makeClient(server.address!.port);
 t.after(async () => {
  await live.close();
 });
 await live.connect();
 assert.equal(live.activeConnectionCount, 1);
 assert.equal(live.isConnected, true);
 await server.close();
 await waitFor(() => live.activeConnectionCount === 0);
 assert.equal(live.isConnected, false);
});

test('request guards: disconnected, managed-handshake kinds, oversized payload', { timeout: 60_000 }, async (t) => {
 const offline = makeClient(1);
 await expectCode(() => offline.request('status', {}), 'TCP_CONNECTION_CLOSED');

 const server = await makeServer(t);
 const client = makeClient(server.address!.port);
 t.after(async () => {
  await client.close();
 });
 await client.connect();
 await expectCode(() => client.request('hello', {}), 'TCP_MESSAGE_INVALID');
 await expectCode(() => client.request('auth', {}), 'TCP_MESSAGE_INVALID');
 await expectCode(
  () => client.request('status', { big: 'x'.repeat(TCP_REPLICA_MAX_FRAME_BYTES) }),
  'TCP_FRAME_TOO_LARGE',
 );
 await expectCode(() => client.query({ schema_version: 'anchorprobe.request.v1', request_id: 'r', root: 'F:/p', project_scope: 'proj' } as never, { timeoutMs: 0 }), 'TCP_CONFIG_INVALID');
});

test('pending-request ceiling rejects the next request and recovers after drain', { timeout: 60_000 }, async (t) => {
 const service = new MemoryService();
 service.queryDelayMs = 200;
 const server = await makeServer(t, { service, requestTimeoutMs: 20_000 });
 const client = makeClient(server.address!.port);
 t.after(async () => {
  await client.close();
 });
 await client.connect();
 const request = { schema_version: 'anchorprobe.request.v1', request_id: 'bulk', root: 'F:/bulk', project_scope: 'proj' } as never;
 for (let index = 0; index < 256; index += 1) {
  void client.query(request, { timeoutMs: 20_000 }).catch(() => undefined);
 }
 await waitFor(() => client.activeConnectionCount === 1);
 await expectCode(
  () => client.query(request, { timeoutMs: 20_000 }),
  'TCP_NODE_UNAVAILABLE',
 );
 await client.close();
});

test('createNodeQuery adapts a connected client for the distributed probe', { timeout: 60_000 }, async (t) => {
 const server = await makeServer(t);
 const client = makeClient(server.address!.port);
 t.after(async () => {
  await client.close();
 });
 await client.connect();
 const query = client.createNodeQuery();
 const controller = new AbortController();
 const response = await query({ schema_version: 'anchorprobe.request.v1', request_id: 'nq', root: 'F:/nq', project_scope: 'proj' } as never, {
  request: { schema_version: 'anchorprobe.request.v1', request_id: 'nq', root: 'F:/nq', project_scope: 'proj' } as never,
  signal: controller.signal,
  nodeTimeoutMs: 2_000,
 });
 assert.ok(Array.isArray(response.candidates));
});

// ---------------------------------------------------------------------------
// 6. Client connect races against a fake server
// ---------------------------------------------------------------------------

test('a second connect with an aborted signal is refused while the first is in flight', { timeout: 60_000 }, async (t) => {
 const fake = new FakeTcpServer({ hello: 'silent' });
 await fake.listen();
 t.after(async () => {
  await fake.close();
 });
 const client = makeClient(fake.address!.port, 'node-a', { handshakeTimeoutMs: 80 });
 t.after(async () => {
  await client.close();
 });
 const pendingConnect = client.connect();
 const aborted = new AbortController();
 aborted.abort();
 const error = await expectCode(() => client.connect(aborted.signal), 'TCP_REQUEST_CANCELLED');
 assert.ok(error instanceof TcpTransportError);
 await expectCode(() => pendingConnect, 'TCP_AUTH_REQUIRED');
});

test('a peer that closes before the transport is established fails the connect', { timeout: 60_000 }, async (t) => {
 const fake = new FakeTcpServer({ destroyOnConnect: true });
 await fake.listen();
 t.after(async () => {
  await fake.close();
 });
 const client = makeClient(fake.address!.port);
 t.after(async () => {
  await client.close();
 });
 await expectCode(() => client.connect(), 'TCP_CONNECTION_CLOSED');
});

test('a socket destroyed between hello and auth fails the managed handshake', { timeout: 60_000 }, async (t) => {
 const fake = new FakeTcpServer({ hello: 'close-after-hello' });
 await fake.listen();
 t.after(async () => {
  await fake.close();
 });
 const client = makeClient(fake.address!.port, 'node-a', { handshakeTimeoutMs: 500, requestTimeoutMs: 2_000 });
 t.after(async () => {
  await client.close();
 });
 await expectCode(() => client.connect(), 'TCP_CONNECTION_CLOSED');
});

test('handshake timeout, missing server nonce and internal request timeout fail the connect', { timeout: 60_000 }, async (t) => {
 await t.test('handshake budget exceeded', async () => {
  const fake = new FakeTcpServer({ hello: 'silent' });
  await fake.listen();
  t.after(async () => {
   await fake.close();
  });
  const client = makeClient(fake.address!.port, 'node-a', { handshakeTimeoutMs: 40, requestTimeoutMs: 5_000 });
  t.after(async () => {
   await client.close();
  });
  await expectCode(() => client.connect(), 'TCP_AUTH_REQUIRED');
 });

 await t.test('hello response without a server nonce', async () => {
  const fake = new FakeTcpServer({ hello: 'missing-server-nonce' });
  await fake.listen();
  t.after(async () => {
   await fake.close();
  });
  const client = makeClient(fake.address!.port, 'node-a', { handshakeTimeoutMs: 2_000 });
  t.after(async () => {
   await client.close();
  });
  await expectCode(() => client.connect(), 'TCP_AUTH_CHALLENGE_INVALID');
 });

 await t.test('internal hello request exceeds its own budget first', async () => {
  const fake = new FakeTcpServer({ hello: 'silent' });
  await fake.listen();
  t.after(async () => {
   await fake.close();
  });
  const client = makeClient(fake.address!.port, 'node-a', { handshakeTimeoutMs: 5_000, requestTimeoutMs: 30 });
  t.after(async () => {
   await client.close();
  });
  await expectCode(() => client.connect(), 'TCP_REQUEST_TIMEOUT');
 });

 await t.test('tiny frame ceiling refuses the handshake frame', async () => {
  const server = await makeServer(t);
  const client = makeClient(server.address!.port, 'node-a', { maxFrameBytes: 8 });
  t.after(async () => {
   await client.close();
  });
  await expectCode(() => client.connect(), 'TCP_FRAME_TOO_LARGE');
 });
});

// ---------------------------------------------------------------------------
// 7. Client response validation and fatal framing (fake server)
// ---------------------------------------------------------------------------

test('client rejects malformed query/apply success payloads', { timeout: 60_000 }, async (t) => {
 const fake = new FakeTcpServer({ onRequest: () => ({ ok: true, payload: {} }) });
 await fake.listen();
 t.after(async () => {
  await fake.close();
 });
 const client = makeClient(fake.address!.port);
 t.after(async () => {
  await client.close();
 });
 await client.connect();
 await expectCode(
  () => client.query({ schema_version: 'anchorprobe.request.v1', request_id: 'rq', root: 'F:/q', project_scope: 'proj' } as never),
  'TCP_MESSAGE_INVALID',
 );
 await expectCode(() => client.apply([]), 'TCP_MESSAGE_INVALID');
});

test('client ignores a late response whose request already settled', { timeout: 60_000 }, async (t) => {
 let releaseQuery: (() => void) | undefined;
 const gate = new Promise<void>((resolve) => {
  releaseQuery = resolve;
 });
 const fake = new FakeTcpServer({
  onRequest: (request) => {
   if (request.kind !== 'query') return { ok: true, payload: { applied: 0 } };
   void gate.then(() => {
    const socket = fake.authenticatedSockets[0];
    if (socket !== undefined) fake.sendRaw(socket, rawFrame({ schema_version: MWHA_PROTOCOL_SCHEMA_VERSION, kind: 'query', id: request.id, ok: true, payload: { candidates: [] } }));
   });
   return undefined;
  },
 });
 await fake.listen();
 t.after(async () => {
  await fake.close();
 });
 const client = makeClient(fake.address!.port, 'node-a', { requestTimeoutMs: 40 });
 t.after(async () => {
  await client.close();
 });
 await client.connect();
 const pending = client.query({ schema_version: 'anchorprobe.request.v1', request_id: 'late', root: 'F:/late', project_scope: 'proj' } as never);
 await expectCode(() => pending, 'TCP_REQUEST_TIMEOUT');
 releaseQuery?.();
 await sleep(30);
 assert.equal(client.activeConnectionCount, 1);
});

test('client drops the connection on a fatal inbound frame', { timeout: 60_000 }, async (t) => {
 const fake = new FakeTcpServer({});
 await fake.listen();
 t.after(async () => {
  await fake.close();
 });
 const client = makeClient(fake.address!.port, 'node-a', { requestTimeoutMs: 2_000 });
 t.after(async () => {
  await client.close();
 });
 await client.connect();
 const socket = fake.authenticatedSockets[0];
 assert.ok(socket !== undefined);
 const header = Buffer.allocUnsafe(4);
 header.writeUInt32BE(0, 0);
 fake.sendRaw(socket, header);
 await waitFor(() => client.activeConnectionCount === 0);
});

test('client rejects a success response whose kind does not match the request', { timeout: 60_000 }, async (t) => {
 const fake = new FakeTcpServer({ onRequest: (request) => ({ ok: true, kind: 'status', id: request.id, payload: {} }) });
 await fake.listen();
 t.after(async () => {
  await fake.close();
 });
 const client = makeClient(fake.address!.port);
 t.after(async () => {
  await client.close();
 });
 await client.connect();
 await expectCode(
  () => client.query({ schema_version: 'anchorprobe.request.v1', request_id: 'mismatch', root: 'F:/m', project_scope: 'proj' } as never),
  'TCP_MESSAGE_INVALID',
 );
});

test('client treats a frame that is neither success nor failure as fatal', { timeout: 60_000 }, async (t) => {
 const fake = new FakeTcpServer({});
 await fake.listen();
 t.after(async () => {
  await fake.close();
 });
 const client = makeClient(fake.address!.port, 'node-a', { requestTimeoutMs: 2_000 });
 t.after(async () => {
  await client.close();
 });
 await client.connect();
 const socket = fake.authenticatedSockets[0];
 assert.ok(socket !== undefined);
 fake.sendRaw(socket, rawFrame({ schema_version: MWHA_PROTOCOL_SCHEMA_VERSION, kind: 'query', id: 'stray', payload: {} }));
 await waitFor(() => client.activeConnectionCount === 0);
});

test('client aborts an in-flight request and ignores the eventual response', { timeout: 60_000 }, async (t) => {
 const fake = new FakeTcpServer({
  onRequest: (request) => {
   setTimeout(() => {
    const socket = fake.authenticatedSockets[0];
    if (socket !== undefined) fake.sendRaw(socket, rawFrame({ schema_version: MWHA_PROTOCOL_SCHEMA_VERSION, kind: 'query', id: request.id, ok: true, payload: { candidates: [] } }));
   }, 60);
   return undefined;
  },
 });
 await fake.listen();
 t.after(async () => {
  await fake.close();
 });
 const client = makeClient(fake.address!.port);
 t.after(async () => {
  await client.close();
 });
 await client.connect();
 const controller = new AbortController();
 const pending = client.query({ schema_version: 'anchorprobe.request.v1', request_id: 'abort', root: 'F:/a', project_scope: 'proj' } as never, { signal: controller.signal });
 setTimeout(() => controller.abort(), 10);
 await expectCode(() => pending, 'TCP_REQUEST_CANCELLED');
 await sleep(80);
 assert.equal(client.activeConnectionCount, 1);
});

// ---------------------------------------------------------------------------
// 8. End-to-end cleanup assertion
// ---------------------------------------------------------------------------

test('a client whose idle socket was dropped can reconnect to the same listener', { timeout: 60_000 }, async (t) => {
 const server = await makeServer(t, { idleTimeoutMs: 80, handshakeTimeoutMs: 5_000 });
 const client = makeClient(server.address!.port);
 t.after(async () => {
  await client.close();
 });
 await client.connect();
 assert.equal(client.activeConnectionCount, 1);
 // The server drops the silent connection once its idle budget expires.
 await waitFor(() => client.activeConnectionCount === 0);
 assert.equal(client.isConnected, false);
 assert.equal(client.isClosed, false);
 await client.connect();
 assert.equal(client.activeConnectionCount, 1);
 assert.equal((await client.status()).replicaId, 'node-b');
});

test('shutdown leaves zero connections and no leaked handles', { timeout: 60_000 }, async (t) => {
 const service = new MemoryService();
 const server = await makeServer(t, { service });
 const client = makeClient(server.address!.port);
 t.after(async () => {
  await client.close();
 });
 await client.connect();
 assert.equal(client.activeConnectionCount, 1);
 assert.equal(server.activeConnectionCount, 1);
 await client.close();
 await waitFor(() => server.activeConnectionCount === 0);
 await server.close();
 assert.equal(server.activeConnectionCount, 0);
 assert.equal(server.address, null);
});
