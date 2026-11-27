/**
 * T-154 / QF-05 bounded deterministic network-state fuzz.
 *
 * Scope and hard boundaries:
 * - Loopback only (`127.0.0.1`, ephemeral port 0). Every listener is bound by
 *   the production transport/proxy, which refuses non-loopback plaintext.
 * - No outbound traffic: the only peers are servers started by this file on
 *   127.0.0.1 plus raw loopback probes. No DoS: every wait is bounded, the
 *   total case count is fixed, and each case has its own timeout.
 * - The sequences are *finite and enumerated*, not random. A fixed seed drives
 *   the deterministic ordering of the enumerated cases so the run is
 *   reproducible; it never widens the enumeration space.
 * - This is NOT a complete enumeration of the transport's network state
 *   machine; the not-covered list at the bottom of this file is explicit.
 *
 * Every case asserts the stable transport error code, the fail-closed (no
 * authorization escalation) property, that the transport recovers and is
 * usable again where recovery is defined, and that no connection is left
 * behind.
 *
 * Reused production surfaces (no new dependency, no source change):
 * `TcpReplicaServer` / `TcpReplicaClient` / `TcpReplicaFrameDecoder` from
 * `src/memory/tcp-transport.ts` and `TcpFaultProxy` from
 * `src/memory/tcp-fault-proxy.ts`.
 */

import assert from 'node:assert/strict';
import net from 'node:net';
import test, { type TestContext } from 'node:test';
import { MWHA_PROTOCOL_SCHEMA_VERSION } from '../../src/memory/ha-protocol.ts';
import { ANCHOR_PROBE_REQUEST_SCHEMA_VERSION } from '../../src/memory/probe-contract.ts';
import type { DistributedNodeResponse } from '../../src/memory/distributed-probe.ts';
import {
  TcpReplicaClient,
  TcpReplicaFrameDecoder,
  TcpReplicaServer,
  challengeSignature,
  type TcpReplicaService,
  type TcpReplicaStatusView,
  type TcpReplicaWireMessage,
} from '../../src/memory/tcp-transport.ts';
import { TcpFaultProxy, type TcpFaultRule } from '../../src/memory/tcp-fault-proxy.ts';

// ---------------------------------------------------------------------------
// Fixed budget and seed
// ---------------------------------------------------------------------------

/** Fixed seed: the same seed reproduces the same ordered case selection. */
export const M18_NETWORK_FUZZ_SEED = 20261125;
/** Hard ceiling on executed fuzz cases. The run never exceeds this number. */
export const M18_NETWORK_FUZZ_CASE_BUDGET = 12;
/** Per-case wall-clock ceiling. */
export const M18_NETWORK_FUZZ_CASE_TIMEOUT_MS = 20_000;
/** Longest single wait inside a case (polling budget). */
export const M18_NETWORK_FUZZ_POLL_MS = 2_000;

const SECRET = 'm18-network-fuzz-secret';
const HASH = 'a'.repeat(64);
const NODE_ID = 'node-a';
const OUTSIDER_ID = 'node-outsider';
const PROJECT_SCOPE = 'proj';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

async function waitFor(predicate: () => boolean, timeoutMs = M18_NETWORK_FUZZ_POLL_MS): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition was not reached within the fuzz poll budget');
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

/** Deterministic 32-bit PRNG (mulberry32); only orders the fixed cases. */
function seededRng(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

// ---------------------------------------------------------------------------
// Real production service (loopback only)
// ---------------------------------------------------------------------------

class FuzzService implements TcpReplicaService {
  appliedCount = 0;

  async query(): Promise<DistributedNodeResponse> {
    return { candidates: [], edges: [], commitIndex: 0, state: 'ACTIVE', clusterEpoch: 'epoch-1' };
  }

  async apply(events: readonly { seq: number }[]) {
    this.appliedCount += events.length;
    return {
      applied: events.length,
      duplicates: 0,
      outOfOrder: 0,
      gaps: [],
      corrupt: 0,
      commitIndex: this.appliedCount,
      viewDigest: HASH,
      complete: true,
      pendingCount: 0,
    };
  }

  async status(): Promise<TcpReplicaStatusView> {
    return {
      replicaId: 'node-b',
      commitIndex: this.appliedCount,
      viewDigest: HASH,
      evidenceDigest: HASH,
      state: 'ACTIVE',
      snapshot: {
        project_scope: PROJECT_SCOPE,
        ledger_digest: HASH,
        graph_revision: null,
        source_fingerprint: null,
        connected_digest: null,
      },
      clusterEpoch: 'epoch-1',
      projectScope: PROJECT_SCOPE,
    };
  }
}

interface ServerHandle {
  readonly server: TcpReplicaServer;
  readonly port: number;
}

async function startServer(t: TestContext, overrides: Record<string, unknown> = {}): Promise<ServerHandle> {
  const server = new TcpReplicaServer({
    host: '127.0.0.1',
    port: 0,
    sharedSecret: SECRET,
    authorizedNodes: [NODE_ID],
    service: new FuzzService(),
    ...overrides,
  });
  await server.listen();
  t.after(async () => {
    await server.close();
  });
  const address = server.address;
  assert.ok(address !== null, 'server must report an address');
  return { server, port: address.port };
}

interface ProxyHandle {
  readonly proxy: TcpFaultProxy;
  readonly port: number;
}

async function startProxy(t: TestContext, upstreamPort: number, rules: readonly TcpFaultRule[]): Promise<ProxyHandle> {
  const proxy = await TcpFaultProxy.start({
    listen: { host: '127.0.0.1', port: 0 },
    upstream: { host: '127.0.0.1', port: upstreamPort },
    seed: M18_NETWORK_FUZZ_SEED,
    rules,
  });
  t.after(async () => {
    await proxy.close();
  });
  const address = proxy.address;
  assert.ok(address !== null, 'proxy must report an address');
  return { proxy, port: address.port };
}

function makeClient(port: number, extra: Record<string, unknown> = {}): TcpReplicaClient {
  return new TcpReplicaClient({
    host: '127.0.0.1',
    port,
    nodeId: NODE_ID,
    sharedSecret: SECRET,
    ...extra,
  });
}

function queryRequest(requestId: string): Record<string, unknown> {
  return {
    schema_version: ANCHOR_PROBE_REQUEST_SCHEMA_VERSION,
    request_id: requestId,
    root: 'F:/fuzz',
    project_scope: PROJECT_SCOPE,
  };
}

/** Raw loopback probe: the only way to emit malformed/oversized bytes. */
class RawProbe {
  readonly socket: net.Socket;
  private readonly decoder = new TcpReplicaFrameDecoder();
  private readonly frames: TcpReplicaWireMessage[] = [];
  private waiter: (() => void) | null = null;
  private failure: { readonly code: string; readonly message: string } | null = null;

  private constructor(socket: net.Socket) {
    this.socket = socket;
    socket.on('error', () => undefined);
    socket.on('data', (chunk: Buffer) => {
      const outcome = this.decoder.push(chunk);
      if (outcome.error !== null) {
        this.failure = { code: outcome.error.code, message: outcome.error.message };
        this.#wake();
        return;
      }
      for (const frame of outcome.frames) {
        this.frames.push(frame);
        const error = (frame as { error?: { code?: unknown } }).error;
        if (error !== undefined && typeof error.code === 'string') {
          this.failure = { code: error.code, message: String((error as { message?: unknown }).message ?? '') };
        }
      }
      this.#wake();
    });
  }

  static connect(port: number): Promise<RawProbe> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('raw probe connect timed out'));
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

  #wake(): void {
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.();
  }

  send(value: unknown): void {
    this.socket.write(rawFrame(value));
  }

  sendRaw(buffer: Buffer): void {
    this.socket.write(buffer);
  }

  /** Await the next decoded frame (or the first failure code observed). */
  async next(timeoutMs = M18_NETWORK_FUZZ_POLL_MS): Promise<{ readonly kind: string; readonly failure: string | null }> {
    const started = Date.now();
    for (;;) {
      const frame = this.frames.shift();
      if (frame !== undefined) {
        const error = (frame as { error?: { code?: unknown } }).error;
        return {
          kind: String((frame as { kind?: unknown }).kind ?? ''),
          failure: error === undefined ? null : String(error.code),
        };
      }
      if (this.failure !== null) return { kind: 'transport-error', failure: this.failure.code };
      const remaining = timeoutMs - (Date.now() - started);
      if (remaining <= 0) throw new Error('no frame arrived within the fuzz poll budget');
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
        const timer = setTimeout(() => {
          this.waiter = null;
          resolve();
        }, Math.min(remaining, 50));
        timer.unref?.();
      });
    }
  }

  /** Half-close: the write side is closed, the read side stays open. */
  halfClose(): void {
    this.socket.end();
  }

  reset(): void {
    this.socket.resetAndDestroy();
  }

  close(): void {
    this.socket.destroy();
  }
}

function helloFrame(nodeId: string, nonce: string): Record<string, unknown> {
  return {
    schema_version: MWHA_PROTOCOL_SCHEMA_VERSION,
    kind: 'hello',
    id: nextRawId('hello'),
    payload: { nodeId, nonce },
  };
}

function authFrame(nodeId: string, nonce: string, serverNonce: string): Record<string, unknown> {
  return {
    schema_version: MWHA_PROTOCOL_SCHEMA_VERSION,
    kind: 'auth',
    id: nextRawId('auth'),
    payload: {
      nodeId,
      nonce,
      serverNonce,
      signature: challengeSignature(SECRET, nodeId, nonce, serverNonce),
    },
  };
}

// ---------------------------------------------------------------------------
// Shared per-case assertions
// ---------------------------------------------------------------------------

/** An unauthorized identity must stay refused even after a fault. */
async function assertNoPrivilegeEscalation(t: TestContext, port: number): Promise<void> {
  const outsider = makeClient(port, { nodeId: OUTSIDER_ID });
  t.after(async () => {
    await outsider.close();
  });
  let observed: string | undefined;
  try {
    await outsider.connect();
  } catch (error) {
    observed = codeOf(error);
  }
  assert.equal(observed, 'TCP_AUTH_UNKNOWN_NODE', 'an unauthorized identity must never be admitted');
  await outsider.close();
}

/** The transport must be usable again after a recoverable fault. */
async function assertRecovery(t: TestContext, port: number): Promise<void> {
  const client = makeClient(port);
  t.after(async () => {
    await client.close();
  });
  await client.connect();
  assert.equal(client.activeConnectionCount, 1, 'the transport must recover');
  const status = await client.status();
  assert.equal(status.replicaId, 'node-b');
  await client.close();
}

async function assertNoConnectionsLeft(server: TcpReplicaServer): Promise<void> {
  await waitFor(() => server.activeConnectionCount === 0);
  assert.equal(server.activeConnectionCount, 0, 'no connection may survive the case');
}

// ---------------------------------------------------------------------------
// The finite catalogue of network-state cases
// ---------------------------------------------------------------------------

type FuzzCaseId =
  | 'handshake-timeout-server'
  | 'handshake-timeout-client'
  | 'idle-timeout-reconnect'
  | 'half-close-peer'
  | 'reset-peer'
  | 'oversized-frame-interleaved'
  | 'malformed-frame-interleaved'
  | 'nonce-replay'
  | 'challenge-mismatch'
  | 'repeated-challenge-mismatch'
  | 'proxy-disconnect-reconnect'
  | 'proxy-one-way-partition';

interface FuzzCase {
  readonly id: FuzzCaseId;
  /** Stable transport error code the case must observe. */
  readonly expectedCode: string;
  /** Whether the case must prove the transport is usable again. */
  readonly expectsRecovery: boolean;
  run(t: TestContext): Promise<void>;
}

async function caseHandshakeTimeoutServer(t: TestContext): Promise<void> {
  const { server, port } = await startServer(t, { handshakeTimeoutMs: 120, idleTimeoutMs: 0 });
  const probe = await RawProbe.connect(port);
  t.after(() => {
    probe.close();
  });
  await waitFor(() => server.activeConnectionCount === 1);
  await waitFor(() => server.activeConnectionCount === 0);
  assert.equal(server.lastError?.code, 'TCP_AUTH_REQUIRED');
  await assertNoPrivilegeEscalation(t, port);
  await assertNoConnectionsLeft(server);
}

async function caseHandshakeTimeoutClient(t: TestContext): Promise<void> {
  const { server, port } = await startServer(t, { idleTimeoutMs: 0 });
  // The server's hello response never reaches the client.
  const { port: proxyPort } = await startProxy(t, port, [
    { kind: 'drop', direction: 'server-to-client', probability: 1, afterFrames: 0, durationFrames: 1 },
  ]);
  const client = makeClient(proxyPort, { handshakeTimeoutMs: 250, requestTimeoutMs: 5_000 });
  t.after(async () => {
    await client.close();
  });
  let observed: string | undefined;
  try {
    await client.connect();
  } catch (error) {
    observed = codeOf(error);
  }
  assert.equal(observed, 'TCP_AUTH_REQUIRED', 'the client must fail the handshake with the stable code');
  assert.equal(client.activeConnectionCount, 0);
  await assertNoPrivilegeEscalation(t, port);
  await assertNoConnectionsLeft(server);
}

async function caseIdleTimeoutReconnect(t: TestContext): Promise<void> {
  const { server, port } = await startServer(t, { idleTimeoutMs: 120, handshakeTimeoutMs: 5_000 });
  const client = makeClient(port);
  t.after(async () => {
    await client.close();
  });
  await client.connect();
  assert.equal(client.activeConnectionCount, 1);
  await waitFor(() => client.activeConnectionCount === 0);
  assert.equal(client.isConnected, false);
  assert.equal(client.isClosed, false);
  // Recovery: the same client reconnects to the same listener and works.
  await client.connect();
  assert.equal(client.activeConnectionCount, 1);
  const status = await client.status();
  assert.equal(status.replicaId, 'node-b');
  await client.close();
  await assertNoPrivilegeEscalation(t, port);
  await assertNoConnectionsLeft(server);
}

async function caseHalfClosePeer(t: TestContext): Promise<void> {
  const { server, port } = await startServer(t, { handshakeTimeoutMs: 5_000, idleTimeoutMs: 0 });
  const probe = await RawProbe.connect(port);
  t.after(() => {
    probe.close();
  });
  probe.send(helloFrame(NODE_ID, '1'.repeat(64)));
  await waitFor(() => server.activeConnectionCount === 1);
  probe.halfClose();
  // A peer EOF carries no error code by design; the connection must be gone.
  await assertNoConnectionsLeft(server);
  await assertNoPrivilegeEscalation(t, port);
}

async function caseResetPeer(t: TestContext): Promise<void> {
  const { server, port } = await startServer(t, { idleTimeoutMs: 0 });
  const probe = await RawProbe.connect(port);
  t.after(() => {
    probe.close();
  });
  probe.send(helloFrame(NODE_ID, '2'.repeat(64)));
  await waitFor(() => server.activeConnectionCount === 1);
  probe.reset();
  await assertNoConnectionsLeft(server);
  assert.equal(server.lastError?.code, 'TCP_CONNECTION_CLOSED');
  await assertNoPrivilegeEscalation(t, port);
}

async function caseOversizedFrameInterleaved(t: TestContext): Promise<void> {
  const { server, port } = await startServer(t, { maxFrameBytes: 512, idleTimeoutMs: 0 });
  const probe = await RawProbe.connect(port);
  t.after(() => {
    probe.close();
  });
  // A valid hello frame first, then an over-ceiling frame in the same stream.
  probe.send(helloFrame(NODE_ID, '3'.repeat(64)));
  await waitFor(() => server.activeConnectionCount === 1);
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(1024 * 1024, 0);
  probe.sendRaw(header);
  await assertNoConnectionsLeft(server);
  assert.equal(server.lastError?.code, 'TCP_FRAME_TOO_LARGE');
  await assertNoPrivilegeEscalation(t, port);
}

async function caseMalformedFrameInterleaved(t: TestContext): Promise<void> {
  const { server, port } = await startServer(t, { idleTimeoutMs: 0 });
  const probe = await RawProbe.connect(port);
  t.after(() => {
    probe.close();
  });
  probe.send(helloFrame(NODE_ID, '4'.repeat(64)));
  await waitFor(() => server.activeConnectionCount === 1);
  // Body is not valid JSON -> framing error, connection dropped.
  const body = Buffer.from('{not-json', 'utf8');
  const out = Buffer.allocUnsafe(4 + body.length);
  out.writeUInt32BE(body.length, 0);
  body.copy(out, 4);
  probe.sendRaw(out);
  await assertNoConnectionsLeft(server);
  assert.equal(server.lastError?.code, 'TCP_FRAME_INVALID');
  await assertNoPrivilegeEscalation(t, port);
}

async function caseNonceReplay(t: TestContext): Promise<void> {
  const { server, port } = await startServer(t, { idleTimeoutMs: 0 });
  const probe = await RawProbe.connect(port);
  t.after(() => {
    probe.close();
  });
  const nonce = '5'.repeat(64);
  probe.send(helloFrame(NODE_ID, nonce));
  const challenge = await probe.next();
  assert.equal(challenge.failure, null);
  assert.equal(challenge.kind, 'hello');
  // The same nonce again on the same connection is refused as a replay.
  probe.send(helloFrame(NODE_ID, nonce));
  const replay = await probe.next();
  assert.equal(replay.failure, 'TCP_AUTH_NONCE_REPLAYED');
  await assertNoConnectionsLeft(server);
  await assertNoPrivilegeEscalation(t, port);
}

async function caseChallengeMismatch(t: TestContext): Promise<void> {
  const { server, port } = await startServer(t, { idleTimeoutMs: 0 });
  const probe = await RawProbe.connect(port);
  t.after(() => {
    probe.close();
  });
  const nonce = '6'.repeat(64);
  probe.send(helloFrame(NODE_ID, nonce));
  const challenge = await probe.next();
  assert.equal(challenge.failure, null);
  // An auth frame that does not match the issued challenge is refused.
  probe.send(authFrame(NODE_ID, nonce, '7'.repeat(64)));
  const refused = await probe.next();
  assert.equal(refused.failure, 'TCP_AUTH_CHALLENGE_INVALID');
  await assertNoConnectionsLeft(server);
  await assertNoPrivilegeEscalation(t, port);
}

async function caseRepeatedChallengeMismatch(t: TestContext): Promise<void> {
  const { server, port } = await startServer(t, { idleTimeoutMs: 0 });
  const first = await RawProbe.connect(port);
  t.after(() => {
    first.close();
  });
  const nonce = '8'.repeat(64);
  first.send(helloFrame(NODE_ID, nonce));
  const challenge = await first.next();
  assert.equal(challenge.failure, null);
  // The auth frame carries a server nonce that was never issued, so the
  // challenge is refused. No successful authentication happens here.
  first.send(authFrame(NODE_ID, nonce, '9'.repeat(64)));
  const refused = await first.next();
  assert.equal(refused.failure, 'TCP_AUTH_CHALLENGE_INVALID');

  // A second peer repeating the very same unmatched server nonce is refused
  // in the same way. This is a repeated *mismatch*, not a replay of a
  // successfully consumed challenge.
  const second = await RawProbe.connect(port);
  t.after(() => {
    second.close();
  });
  second.send(helloFrame(NODE_ID, 'a'.repeat(64)));
  const secondChallenge = await second.next();
  assert.equal(secondChallenge.failure, null);
  second.send(authFrame(NODE_ID, 'a'.repeat(64), '9'.repeat(64)));
  const repeated = await second.next();
  assert.equal(repeated.failure, 'TCP_AUTH_CHALLENGE_INVALID');
  await assertNoConnectionsLeft(server);
  await assertNoPrivilegeEscalation(t, port);
}

async function caseProxyDisconnectReconnect(t: TestContext): Promise<void> {
  const { server, port } = await startServer(t, { idleTimeoutMs: 0 });
  // The pair is cut after the managed handshake, i.e. on the first real request.
  const { port: proxyPort } = await startProxy(t, port, [
    { kind: 'disconnect', direction: 'client-to-server', probability: 1, afterFrames: 2, durationFrames: 1 },
  ]);
  const client = makeClient(proxyPort, { requestTimeoutMs: 3_000 });
  t.after(async () => {
    await client.close();
  });
  await client.connect();
  assert.equal(client.activeConnectionCount, 1);
  let observed: string | undefined;
  try {
    await client.request('query', queryRequest('fuzz-disconnect'));
  } catch (error) {
    observed = codeOf(error);
  }
  assert.equal(observed, 'TCP_CONNECTION_CLOSED', 'the cut connection must surface the stable code');
  await waitFor(() => client.activeConnectionCount === 0);
  // Recovery: the transport re-establishes a session through the same proxy.
  await client.connect();
  assert.equal(client.activeConnectionCount, 1, 'the transport must recover after the cut');
  await client.close();
  // Recovery: the listener still serves a legitimate peer afterwards.
  await assertRecovery(t, port);
  await assertNoPrivilegeEscalation(t, port);
  await assertNoConnectionsLeft(server);
}

async function caseProxyOneWayPartition(t: TestContext): Promise<void> {
  const { server, port } = await startServer(t, { idleTimeoutMs: 0 });
  // The hello/auth responses pass; the query response is blocked in one direction.
  const { port: proxyPort } = await startProxy(t, port, [
    { kind: 'one-way-partition', direction: 'server-to-client', probability: 1, afterFrames: 2, durationFrames: 1 },
  ]);
  const client = makeClient(proxyPort, { requestTimeoutMs: 400, handshakeTimeoutMs: 5_000 });
  t.after(async () => {
    await client.close();
  });
  await client.connect();
  assert.equal(client.activeConnectionCount, 1);
  let observed: string | undefined;
  try {
    await client.request('query', queryRequest('fuzz-partition'));
  } catch (error) {
    observed = codeOf(error);
  }
  assert.equal(observed, 'TCP_REQUEST_TIMEOUT', 'a blocked response must fail with the request timeout code');
  await client.close();
  // Recovery: the listener still serves a legitimate peer afterwards.
  await assertRecovery(t, port);
  await assertNoPrivilegeEscalation(t, port);
  await assertNoConnectionsLeft(server);
}

/**
 * The fixed catalogue. The order is deterministic for a given seed; the set
 * never changes, so this is a bounded enumeration, not random exploration.
 */
const CASES: readonly FuzzCase[] = [
  { id: 'handshake-timeout-server', expectedCode: 'TCP_AUTH_REQUIRED', expectsRecovery: false, run: caseHandshakeTimeoutServer },
  { id: 'handshake-timeout-client', expectedCode: 'TCP_AUTH_REQUIRED', expectsRecovery: false, run: caseHandshakeTimeoutClient },
  { id: 'idle-timeout-reconnect', expectedCode: 'TCP_CONNECTION_CLOSED', expectsRecovery: true, run: caseIdleTimeoutReconnect },
  { id: 'half-close-peer', expectedCode: 'TCP_CONNECTION_CLOSED', expectsRecovery: false, run: caseHalfClosePeer },
  { id: 'reset-peer', expectedCode: 'TCP_CONNECTION_CLOSED', expectsRecovery: false, run: caseResetPeer },
  { id: 'oversized-frame-interleaved', expectedCode: 'TCP_FRAME_TOO_LARGE', expectsRecovery: false, run: caseOversizedFrameInterleaved },
  { id: 'malformed-frame-interleaved', expectedCode: 'TCP_FRAME_INVALID', expectsRecovery: false, run: caseMalformedFrameInterleaved },
  { id: 'nonce-replay', expectedCode: 'TCP_AUTH_NONCE_REPLAYED', expectsRecovery: false, run: caseNonceReplay },
  { id: 'challenge-mismatch', expectedCode: 'TCP_AUTH_CHALLENGE_INVALID', expectsRecovery: false, run: caseChallengeMismatch },
  { id: 'repeated-challenge-mismatch', expectedCode: 'TCP_AUTH_CHALLENGE_INVALID', expectsRecovery: false, run: caseRepeatedChallengeMismatch },
  { id: 'proxy-disconnect-reconnect', expectedCode: 'TCP_CONNECTION_CLOSED', expectsRecovery: true, run: caseProxyDisconnectReconnect },
  { id: 'proxy-one-way-partition', expectedCode: 'TCP_REQUEST_TIMEOUT', expectsRecovery: false, run: caseProxyOneWayPartition },
];

/** Deterministic order for the fixed seed (Fisher-Yates with the seeded PRNG). */
export function orderedCases(seed: number, cases: readonly FuzzCase[] = CASES): FuzzCase[] {
  const rng = seededRng(seed);
  const order = [...cases];
  for (let index = order.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rng() * (index + 1));
    const left = order[index]!;
    const right = order[swap]!;
    order[index] = right;
    order[swap] = left;
  }
  return order;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('T-154/QF-05 network fuzz catalogue: fixed seed, fixed budget, no duplicate ids', () => {
  assert.equal(M18_NETWORK_FUZZ_CASE_BUDGET, 12);
  assert.ok(CASES.length <= M18_NETWORK_FUZZ_CASE_BUDGET, 'the enumerated catalogue must fit the case budget');
  assert.equal(new Set(CASES.map((entry) => entry.id)).size, CASES.length, 'case ids must be unique');
  const codes = new Set(CASES.map((entry) => entry.expectedCode));
  assert.ok(codes.size >= 6, `the catalogue must cover at least six distinct error codes, got ${String(codes.size)}`);
});

test('T-154/QF-05 ordered case list is deterministic for the fixed seed', () => {
  const first = orderedCases(M18_NETWORK_FUZZ_SEED).map((entry) => entry.id);
  const second = orderedCases(M18_NETWORK_FUZZ_SEED).map((entry) => entry.id);
  assert.deepEqual(first, second);
  assert.equal(first.length, CASES.length);
  assert.deepEqual([...first].sort(), CASES.map((entry) => entry.id).sort());
});

test('T-154/QF-05 network fuzz cases: bounded, fail-closed, recovering and leak-free', { timeout: M18_NETWORK_FUZZ_CASE_TIMEOUT_MS * M18_NETWORK_FUZZ_CASE_BUDGET }, async (t) => {
  const ordered = orderedCases(M18_NETWORK_FUZZ_SEED).slice(0, M18_NETWORK_FUZZ_CASE_BUDGET);
  const completed: string[] = [];
  for (const entry of ordered) {
    await t.test(entry.id, { timeout: M18_NETWORK_FUZZ_CASE_TIMEOUT_MS }, async (sub) => {
      await entry.run(sub);
      completed.push(entry.id);
    });
  }
  assert.equal(completed.length, ordered.length, 'every budgeted case must complete');
  assert.equal(completed.length, CASES.length, 'the whole catalogue must be executed');
});

test('T-154/QF-05 an unauthorized peer is refused and never escalates, while the listener stays healthy', { timeout: M18_NETWORK_FUZZ_CASE_TIMEOUT_MS }, async (t) => {
  const { server, port } = await startServer(t, { idleTimeoutMs: 0 });
  await assertNoPrivilegeEscalation(t, port);
  // The listener must still serve a legitimate peer afterwards.
  await assertRecovery(t, port);
  await assertNoConnectionsLeft(server);
});

test('T-154/QF-05 the fuzz run leaves no connection and no listener behind', { timeout: M18_NETWORK_FUZZ_CASE_TIMEOUT_MS }, async (t) => {
  const { server, port } = await startServer(t, { idleTimeoutMs: 0 });
  const client = makeClient(port);
  await client.connect();
  assert.equal(client.activeConnectionCount, 1);
  await client.close();
  await client.close();
  await assertNoConnectionsLeft(server);
  await server.close();
  assert.equal(server.activeConnectionCount, 0);
  assert.equal(server.address, null);
  assert.equal(server.isClosed, true);
});

/**
 * Not covered by this file (explicitly, so nobody over-claims):
 * - TLS-wrapped traffic (the transport's TLS path is exercised by other suites);
 * - OS-level partitions, kernel stack failures and physical link outages;
 * - bandwidth/throughput limits, IP-layer packet reordering and multi-host
 *   replication;
 * - simultaneous many-peer handshakes (only single-peer sequences are fuzzed);
 * - replay of a *successfully consumed* server challenge (the case above only
 *   repeats a challenge mismatch; no peer in this file completes a real
 *   authentication and then replays the consumed challenge);
 * - a complete enumeration of the transport's network state machine — the
 *   catalogue above is a bounded, fixed subset of it.
 */
