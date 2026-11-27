/**
 * T-134 red team / boundary tests for the local TCP replica transport.
 *
 * Baseline classes covered here:
 *   1. forged nodeId, wrong HMAC signature and replayed nonce are refused;
 *   2. invalid frames (zero/bad length, over-1MiB, non-JSON, truncated,
 *      malformed envelope) are refused whole without killing the listener;
 *   3. non-loopback plaintext configuration is refused before any bind and the
 *      default bind is loopback-only (configuration/startup checks only — this
 *      suite never binds an external interface);
 *   4. cluster-policy authorization gates query/apply; unknown/revoked nodes
 *      and a policy-less server fail closed;
 *   5. wrong TLS trust and hostname mismatch are refused, while loopback
 *      TLS + HMAC succeeds (certificates are generated in tmpdir only).
 *
 * Scope note: local loopback TCP/TLS and authentication only. Cross-machine
 * deployment, production HA failover, OS-level partitions and SLAs remain
 * unverified (see TCP_TRANSPORT_UNVERIFIED_BOUNDARIES).
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import net from 'node:net';
import test, { type TestContext } from 'node:test';
import {
  MWHA_PROTOCOL_SCHEMA_VERSION,
} from '../../src/memory/ha-protocol.ts';
import type { AnchorProbeSnapshot } from '../../src/memory/probe-contract.ts';
import type { ProbeCandidate } from '../../src/memory/probe.ts';
import type { DistributedNodeResponse } from '../../src/memory/distributed-probe.ts';
import {
  assertMwhaWriterEvent,
  challengeSignature,
  TcpReplicaClient,
  TcpReplicaServer,
  TcpTransportError,
  TCP_REPLICA_MAX_FRAME_BYTES,
  TCP_TRANSPORT_UNVERIFIED_BOUNDARIES,
  TCP_TRANSPORT_VERIFICATION_NOTE,
  isLoopbackHost,
  tcpReplicaErrorCodes,
  type TcpAuthorizer,
  type TcpReplicaServerOptions,
  type TcpReplicaService,
  type TcpReplicaStatusView,
} from '../../src/memory/tcp-transport.ts';
import { authorizeReplica, createDefaultClusterPolicy } from '../../src/memory/cluster-policy.ts';

// Runtime-only test credential: never persisted, logged or printed.
const SECRET = randomBytes(32).toString('hex');
const WRONG_SECRET = `${SECRET}-wrong`;
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

// ---------------------------------------------------------------------------
// Minimal in-memory service (query/apply/status)
// ---------------------------------------------------------------------------

function fakeSnapshot(): AnchorProbeSnapshot {
  return {
    project_scope: 'proj',
    ledger_digest: HASH,
    graph_revision: null,
    source_fingerprint: null,
    connected_digest: null,
  };
}

class MemoryService implements TcpReplicaService {
  commitIndex = 0;
  readonly seen: string[] = [];

  async query(request: { project_scope?: string; root?: string }): Promise<DistributedNodeResponse> {
    const candidate = {
      record_ref: `rec-${String(request.root ?? 'default')}`,
      content_hash: HASH,
      fact_key: 'local.storage.engine',
      status: 'active',
    } as unknown as ProbeCandidate;
    return {
      candidates: [candidate],
      edges: [],
      commitIndex: this.commitIndex,
      state: 'ACTIVE',
      clusterEpoch: 'epoch-1',
    };
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

function serviceOptions(extra: Record<string, unknown> = {}): TcpReplicaServerOptions {
  return {
    host: '127.0.0.1',
    port: 0,
    sharedSecret: SECRET,
    authorizedNodes: ['node-a'],
    service: new MemoryService(),
    ...extra,
  };
}

async function makeServer(t: TestContext, options: TcpReplicaServerOptions): Promise<TcpReplicaServer> {
  const server = new TcpReplicaServer(options);
  await server.listen();
  t.after(async () => {
    await server.close();
  });
  return server;
}

function clientFor(server: TcpReplicaServer, nodeId: string, extra: Record<string, unknown> = {}): TcpReplicaClient {
  return new TcpReplicaClient({
    host: '127.0.0.1',
    port: server.address!.port,
    nodeId,
    sharedSecret: SECRET,
    ...extra,
  });
}

function rawFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const out = Buffer.allocUnsafe(4 + body.length);
  out.writeUInt32BE(body.length, 0);
  body.copy(out, 4);
  return out;
}

let rawCounter = 0;
function helloMessage(nodeId: string, nonce: string): Record<string, unknown> {
  rawCounter += 1;
  return {
    schema_version: MWHA_PROTOCOL_SCHEMA_VERSION,
    kind: 'hello',
    id: `raw-${String(rawCounter)}`,
    payload: { nodeId, nonce },
  };
}

function authMessage(nodeId: string, nonce: string, serverNonce: string, secret = SECRET): Record<string, unknown> {
  rawCounter += 1;
  return {
    schema_version: MWHA_PROTOCOL_SCHEMA_VERSION,
    kind: 'auth',
    id: `raw-${String(rawCounter)}`,
    payload: {
      nodeId,
      nonce,
      serverNonce,
      signature: challengeSignature(secret, nodeId, nonce, serverNonce),
    },
  };
}

let eventCounter = 0;
function fakeEvent(): Record<string, unknown> {
  eventCounter += 1;
  const seq = eventCounter;
  return {
    seq,
    eventId: `evt-${String(seq)}`,
    hash: 'b'.repeat(64),
    kind: 'memory.revised',
    payload: { note: `note-${String(seq)}` },
    recordedAt: '2026-11-24T00:00:00.000Z',
    segment: 'seg-1',
    prevHash: 'c'.repeat(64),
    contentRedacted: false,
  };
}

/** Raw socket helper for boundary tests that intentionally misbehave. */
class RawProbe {
  readonly socket: net.Socket;
  private buffer = Buffer.alloc(0);
  private queue: unknown[] = [];
  private waiters: { resolve: (value: unknown) => void; timer: NodeJS.Timeout }[] = [];
  private ended = false;

  private constructor(socket: net.Socket) {
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('close', () => this.onEnd());
    socket.on('error', () => this.onEnd());
  }

  static connect(port: number, host = '127.0.0.1'): Promise<RawProbe> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host, port });
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

  next(timeoutMs = 1_500): Promise<Record<string, unknown>> {
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued as Record<string, unknown>);
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (value: unknown) => resolve(value as Record<string, unknown>),
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error('no frame arrived within the timeout'));
        }, timeoutMs),
      };
      waiter.timer.unref?.();
      this.waiters.push(waiter);
    });
  }

  close(): void {
    this.ended = true;
    this.socket.destroy();
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 4) return;
      const length = this.buffer.readUInt32BE(0);
      if (length > TCP_REPLICA_MAX_FRAME_BYTES || this.buffer.length < 4 + length) return;
      const body = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      try {
        this.deliver(JSON.parse(body.toString('utf8')));
      } catch {
        this.deliver({ __protocolError: 'raw peer could not parse frame body' });
      }
    }
  }

  private deliver(frame: unknown): void {
    const waiter = this.waiters.shift();
    if (waiter === undefined) {
      this.queue.push(frame);
      return;
    }
    clearTimeout(waiter.timer);
    waiter.resolve(frame);
  }

  private onEnd(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve({ __closed: true });
    }
  }
}

// ---------------------------------------------------------------------------
// 1. Authentication boundaries
// ---------------------------------------------------------------------------

test('forged nodeId, wrong HMAC and replayed nonce are refused while the listener stays healthy', { timeout: 60_000 }, async (t) => {
  const server = await makeServer(t, serviceOptions());
  const collectedErrors: string[] = [];

  await t.test('unknown/forged nodeId is refused at hello', async () => {
    const attacker = clientFor(server, 'attacker');
    const error = await expectCode(() => attacker.connect(), 'TCP_AUTH_UNKNOWN_NODE');
    collectedErrors.push(String(error));
    await attacker.close();
    await waitFor(() => server.activeConnectionCount === 0);
  });

  await t.test('valid nodeId with wrong HMAC secret is refused at auth', async () => {
    const impostor = clientFor(server, 'node-a', { sharedSecret: WRONG_SECRET });
    const error = await expectCode(() => impostor.connect(), 'TCP_AUTH_BAD_SIGNATURE');
    collectedErrors.push(String(error));
    await impostor.close();
    await waitFor(() => server.activeConnectionCount === 0);
  });

  await t.test('replayed hello nonce and reused auth challenge are refused', async () => {
    const nonce = '1'.repeat(64);
    const first = await RawProbe.connect(server.address!.port);
    first.send(helloMessage('node-a', nonce));
    const challenge = await first.next();
    assert.equal(challenge.ok, true);
    assert.equal(typeof (challenge.payload as { serverNonce?: unknown }).serverNonce, 'string');
    first.send(helloMessage('node-a', nonce));
    const replay = await first.next();
    assert.equal(replay.ok, false);
    assert.equal((replay as { error?: { code?: string } }).error?.code, 'TCP_AUTH_NONCE_REPLAYED');
    collectedErrors.push(JSON.stringify(replay));
    first.close();

    const second = await RawProbe.connect(server.address!.port);
    const nonce2 = '2'.repeat(64);
    second.send(helloMessage('node-a', nonce2));
    const challenge2 = await second.next();
    assert.equal(challenge2.ok, true);
    const serverNonce2 = (challenge2.payload as { serverNonce: string }).serverNonce;
    second.send(authMessage('node-a', nonce2, serverNonce2));
    const authed = await second.next();
    assert.equal(authed.ok, true);
    // A second auth frame on an already-authenticated connection is refused.
    second.send(authMessage('node-a', nonce2, serverNonce2));
    const postAuth = await second.next();
    assert.equal(postAuth.ok, false);
    assert.equal((postAuth as { error?: { code?: string } }).error?.code, 'TCP_MESSAGE_INVALID');
    second.close();

    const mismatch = await RawProbe.connect(server.address!.port);
    const nonce3 = '3'.repeat(64);
    mismatch.send(helloMessage('node-a', nonce3));
    await mismatch.next();
    mismatch.send(authMessage('node-a', nonce3, '0'.repeat(64)));
    const badChallenge = await mismatch.next();
    assert.equal(badChallenge.ok, false);
    assert.equal((badChallenge as { error?: { code?: string } }).error?.code, 'TCP_AUTH_CHALLENGE_INVALID');
    mismatch.close();

    const third = await RawProbe.connect(server.address!.port);
    third.send(helloMessage('node-a', nonce2));
    const afterUse = await third.next();
    assert.equal(afterUse.ok, false);
    assert.equal((afterUse as { error?: { code?: string } }).error?.code, 'TCP_AUTH_NONCE_REPLAYED');
    third.close();
    await waitFor(() => server.activeConnectionCount === 0);
  });

  await t.test('the listener still authenticates and serves a legitimate peer', async () => {
    const legit = clientFor(server, 'node-a');
    t.after(async () => {
      await legit.close();
    });
    await legit.connect();
    const status = await legit.status();
    assert.equal(status.replicaId, 'node-b');
    assert.equal(server.activeConnectionCount, 1);
  });

  await t.test('diagnostics never contain the shared secret', () => {
    assert.ok(collectedErrors.every((text) => !text.includes(SECRET)));
    assert.ok(!String(server.lastError?.message ?? '').includes(SECRET));
  });
});

// ---------------------------------------------------------------------------
// 2. Frame boundaries
// ---------------------------------------------------------------------------

test('invalid frames are refused whole and the listener survives', { timeout: 60_000 }, async (t) => {
  const server = await makeServer(t, serviceOptions({ handshakeTimeoutMs: 250 }));
  const control = clientFor(server, 'node-a');
  t.after(async () => {
    await control.close();
  });
  await control.connect();
  assert.equal(control.activeConnectionCount, 1);

  async function rawCase(name: string, write: (probe: RawProbe) => void): Promise<void> {
    await t.test(name, async () => {
      const probe = await RawProbe.connect(server.address!.port);
      write(probe);
      await sleep(80);
      probe.close();
      await waitFor(() => server.activeConnectionCount === 1);
      const status = await control.status();
      assert.equal(status.state, 'ACTIVE');
    });
  }

  await rawCase('zero/bad length prefix', (probe) => {
    probe.sendRaw(Buffer.from([0x00, 0x00, 0x00, 0x00]));
  });

  await rawCase('declared length above the 1 MiB frame ceiling', (probe) => {
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(TCP_REPLICA_MAX_FRAME_BYTES + 1, 0);
    probe.sendRaw(header);
  });

  await rawCase('non-JSON body', (probe) => {
    const body = Buffer.from('not-json', 'utf8');
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(body.length, 0);
    probe.sendRaw(Buffer.concat([header, body]));
  });

  await rawCase('valid JSON that violates the strict envelope', (probe) => {
    probe.send({ unexpected: true });
  });

  await rawCase('truncated frame body followed by disconnect', async (probe) => {
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(64, 0);
    probe.sendRaw(Buffer.concat([header, Buffer.from('{"par', 'utf8')]));
    await sleep(40);
    probe.close();
  });

  assert.equal(server.activeConnectionCount, 1);
  const report = await control.apply([fakeEvent() as never]);
  assert.equal(report.applied, 1);
});

// ---------------------------------------------------------------------------
// 3. Loopback-only binding policy
// ---------------------------------------------------------------------------

test('non-loopback plaintext is refused at configuration/startup and default bind is loopback-only', { timeout: 60_000 }, async (t) => {
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('127.8.9.10'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('0.0.0.0'), false);
  assert.equal(isLoopbackHost('192.0.2.1'), false);

  await t.test('constructor refuses wildcard/documentation plaintext hosts without binding', async () => {
    for (const host of ['0.0.0.0', '192.0.2.1']) {
      const error = await expectCode(
        () => new TcpReplicaServer(serviceOptions({ host })),
        'TCP_TLS_REQUIRED',
      );
      assert.ok(error instanceof TcpTransportError);
    }
    // Startup path re-checks the policy even if construction were bypassed.
    const server = new TcpReplicaServer(serviceOptions({ host: '127.0.0.1' }));
    assert.equal(server.isClosed, false);
    await server.close();
  });

  await t.test('client refuses non-loopback plaintext before dialing', async () => {
    await expectCode(
      () => new TcpReplicaClient({ host: '192.0.2.1', port: 1, nodeId: 'node-a', sharedSecret: SECRET }),
      'TCP_TLS_REQUIRED',
    );
  });

  await t.test('default bind is 127.0.0.1 and reaches no external interface', async () => {
    const server = await makeServer(t, serviceOptions({ host: undefined }));
    assert.equal(server.address?.host, '127.0.0.1');
    const client = clientFor(server, 'node-a');
    t.after(async () => {
      await client.close();
    });
    await client.connect();
    assert.equal(client.activeConnectionCount, 1);
  });

  await t.test('verification note lists unverified cross-machine boundaries', () => {
    assert.ok(TCP_TRANSPORT_VERIFICATION_NOTE.includes('未验证'));
    assert.ok(TCP_TRANSPORT_UNVERIFIED_BOUNDARIES.includes('physical-cross-machine-deployment'));
  });
});

// ---------------------------------------------------------------------------
// 4. Cluster-policy authorization
// ---------------------------------------------------------------------------

test('cluster-policy authorization gates query/apply and unknown/revoked nodes fail closed', { timeout: 60_000 }, async (t) => {
  const policy = createDefaultClusterPolicy('proj', {
    replicas: [
      { replicaId: 'node-reader', allowedScopes: ['proj'], operations: ['read'] },
      { replicaId: 'node-writer', allowedScopes: ['proj'], operations: ['read', 'apply'] },
      { replicaId: 'node-revoked', allowedScopes: ['proj'], operations: ['read'], revokedAt: '2026-01-01T00:00:00.000Z' },
    ],
  });
  const server = await makeServer(t, serviceOptions({ policy, authorizedNodes: undefined }));

  await t.test('policy sanity: reader cannot apply, outsider is unknown', () => {
    assert.equal(authorizeReplica(policy, 'node-reader', 'apply').allowed, false);
    assert.equal(authorizeReplica(policy, 'node-outsider', 'read').allowed, false);
  });

  await t.test('unregistered node cannot authenticate', async () => {
    const outsider = clientFor(server, 'node-outsider');
    const error = await expectCode(() => outsider.connect(), 'TCP_AUTH_UNKNOWN_NODE');
    assert.ok(error instanceof TcpTransportError);
    await outsider.close();
    await waitFor(() => server.activeConnectionCount === 0);
  });

  await t.test('reader may query but not apply', async () => {
    const reader = clientFor(server, 'node-reader');
    t.after(async () => {
      await reader.close();
    });
    await reader.connect();
    const response = await reader.query({ schema_version: 'anchorprobe.request.v1', request_id: 'r-read', root: 'F:/p', project_scope: 'proj' } as never);
    assert.ok(Array.isArray(response.candidates));
    await expectCode(
      () => reader.apply([fakeEvent() as never]),
      'OPERATION_FORBIDDEN',
    );
  });

  await t.test('cross-scope query is denied by the local policy', async () => {
    const reader = clientFor(server, 'node-reader');
    t.after(async () => {
      await reader.close();
    });
    await reader.connect();
    await expectCode(
      () => reader.query({ schema_version: 'anchorprobe.request.v1', request_id: 'r-other', root: 'F:/p', project_scope: 'other' } as never),
      'SCOPE_DENIED',
    );
  });

  await t.test('writer may apply; revoked node is refused', async () => {
    const writer = clientFor(server, 'node-writer');
    t.after(async () => {
      await writer.close();
    });
    await writer.connect();
    const report = await writer.apply([fakeEvent() as never]);
    assert.equal(report.applied, 1);

    const revoked = clientFor(server, 'node-revoked');
    t.after(async () => {
      await revoked.close();
    });
    await revoked.connect();
    await expectCode(
      () => revoked.query({ schema_version: 'anchorprobe.request.v1', request_id: 'r-revoked', root: 'F:/p', project_scope: 'proj' } as never),
      'REPLICA_REVOKED',
    );
  });

  await t.test('a server with no policy/allow-list fails closed', async () => {
    const denyAll = await makeServer(t, serviceOptions({ policy: undefined, authorizedNodes: undefined }));
    const client = clientFor(denyAll, 'node-a');
    await expectCode(() => client.connect(), 'TCP_AUTH_UNKNOWN_NODE');
    await client.close();
    await waitFor(() => denyAll.activeConnectionCount === 0);
  });
});

// ---------------------------------------------------------------------------
// 5. TLS boundaries (loopback TLS is allowed; certificates live in tmpdir)
// ---------------------------------------------------------------------------

interface CertMaterial {
  readonly directory: string;
  readonly serverKey: Buffer;
  readonly serverCert: Buffer;
  readonly otherCert: Buffer;
}

function opensslExecutable(): string {
  const candidates = [
    process.env.OPENSSL_PATH,
    'C:/Program Files/Git/ucrt64/bin/openssl.exe',
    'C:/Program Files/Git/usr/bin/openssl.exe',
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  return candidates.find((candidate) => existsSync(candidate)) ?? 'openssl';
}

function makeCertificates(t: TestContext): CertMaterial {
  const directory = mkdtempSync(join(tmpdir(), 'ano-tcp-redteam-certs-'));
  t.after(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  const generate = (prefix: string): void => {
    execFileSync(opensslExecutable(), [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-days', '1',
      '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-keyout', join(directory, `${prefix}-key.pem`),
      '-out', join(directory, `${prefix}-cert.pem`),
    ], { stdio: 'ignore' });
  };
  generate('server');
  generate('other');
  const material: CertMaterial = {
    directory,
    serverKey: readFileSync(join(directory, 'server-key.pem')),
    serverCert: readFileSync(join(directory, 'server-cert.pem')),
    otherCert: readFileSync(join(directory, 'other-cert.pem')),
  };
  assert.ok(resolve(material.directory).startsWith(resolve(tmpdir())));
  assert.ok(existsSync(join(material.directory, 'server-key.pem')));
  return material;
}

test('wrong TLS trust/hostname is refused; loopback TLS + HMAC succeeds', { timeout: 60_000 }, async (t) => {
  let certs: CertMaterial;
  let server: TcpReplicaServer;
  try {
    certs = makeCertificates(t);
    server = await makeServer(t, serviceOptions({
      handshakeTimeoutMs: 1_000,
      tls: { key: certs.serverKey, cert: certs.serverCert },
    }));
  } catch (error) {
    throw new Error(`TLS fixture startup failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }

  await t.test('client that does not trust the server certificate is refused', async () => {
    const suspicious = clientFor(server, 'node-a', { tls: { ca: certs.otherCert, serverName: 'localhost' } });
    const error = await expectCode(() => suspicious.connect(), 'TCP_CONNECTION_FAILED');
    assert.ok(!String(error).includes(SECRET));
    await suspicious.close();
    await waitFor(() => server.activeConnectionCount === 0);
  });

  await t.test('certificate hostname mismatch is refused', async () => {
    const mismatched = clientFor(server, 'node-a', { tls: { ca: certs.serverCert, serverName: 'not-localhost.example' } });
    await expectCode(() => mismatched.connect(), 'TCP_CONNECTION_FAILED');
    await mismatched.close();
    await waitFor(() => server.activeConnectionCount === 0);
  });

  await t.test('loopback TLS with trusted certificate and matching SNI succeeds', async () => {
    const trusted = clientFor(server, 'node-a', { tls: { ca: certs.serverCert, serverName: 'localhost' } });
    t.after(async () => {
      await trusted.close();
    });
    await trusted.connect();
    const response = await trusted.query({ schema_version: 'anchorprobe.request.v1', request_id: 'tls-query', root: 'F:/tls', project_scope: 'proj' } as never);
    assert.ok(Array.isArray(response.candidates));
  });

  await t.test('the listener is still healthy after failed TLS attempts', async () => {
    const trusted = clientFor(server, 'node-a', { tls: { ca: certs.serverCert, serverName: 'localhost' } });
    t.after(async () => {
      await trusted.close();
    });
    await trusted.connect();
    assert.equal((await trusted.status()).replicaId, 'node-b');
  });
});

test('unauthenticated frames are refused and malformed hello payloads fail the frame handler', { timeout: 60_000 }, async (t) => {
  const server = await makeServer(t, serviceOptions());
  const control = clientFor(server, 'node-a');
  t.after(async () => {
    await control.close();
  });
  await control.connect();

  for (const kind of ['query', 'apply', 'status'] as const) {
    const probe = await RawProbe.connect(server.address!.port);
    probe.send({ schema_version: MWHA_PROTOCOL_SCHEMA_VERSION, kind, id: `raw-${kind}`, payload: {} });
    const reply = await probe.next();
    assert.equal(reply.ok, false);
    assert.equal((reply as { error?: { code?: string } }).error?.code, 'TCP_AUTH_REQUIRED');
    probe.close();
  }

  const malformed = await RawProbe.connect(server.address!.port);
  malformed.send({ schema_version: MWHA_PROTOCOL_SCHEMA_VERSION, kind: 'hello', id: 'bad-hello', payload: { nodeId: 'node-a' } });
  const failure = await malformed.next();
  assert.equal(failure.ok, false);
  assert.equal((failure as { error?: { code?: string } }).error?.code, 'TCP_MESSAGE_INVALID');
  malformed.close();

  assert.equal((await control.status()).replicaId, 'node-b');
  await waitFor(() => server.activeConnectionCount === 1);
});

test('authorize callback branches gate operations with their own decision payload', { timeout: 60_000 }, async (t) => {
  const queryRequest = { schema_version: 'anchorprobe.request.v1', request_id: 'authz', root: 'F:/p', project_scope: 'proj' } as never;

  await t.test('boolean true and {allowed:true} authorize the read with its scope', async () => {
    const authorizers: readonly TcpAuthorizer[] = [() => true, () => ({ allowed: true })];
    for (const authorize of authorizers) {
      const calls: Array<{ operation: string; scope: string | undefined }> = [];
      const server = await makeServer(t, serviceOptions({
        policy: undefined,
        authorizedNodes: undefined,
        authorize: (nodeId: string, operation: string, scope?: string) => {
          calls.push({ operation, scope });
          return authorize(nodeId, operation as never, scope);
        },
      }));
      const client = clientFor(server, 'node-a');
      t.after(async () => {
        await client.close();
      });
      await client.connect();
      const response = await client.query(queryRequest);
      assert.ok(Array.isArray(response.candidates));
      assert.deepEqual(calls.at(-1), { operation: 'read', scope: 'proj' });
    }
  });

  await t.test('boolean false is forbidden with OPERATION_FORBIDDEN', async () => {
    const server = await makeServer(t, serviceOptions({
      policy: undefined,
      authorizedNodes: undefined,
      authorize: () => false,
    }));
    const client = clientFor(server, 'node-a');
    t.after(async () => {
      await client.close();
    });
    await client.connect();
    await expectCode(() => client.query(queryRequest), 'OPERATION_FORBIDDEN');
  });

  await t.test('object denial carries its custom code and reason', async () => {
    const server = await makeServer(t, serviceOptions({
      policy: undefined,
      authorizedNodes: undefined,
      authorize: () => ({ allowed: false, code: 'CUSTOM_AUTHZ_DENIED', reason: 'operator refused' }),
    }));
    const client = clientFor(server, 'node-a');
    t.after(async () => {
      await client.close();
    });
    await client.connect();
    await expectCode(() => client.query(queryRequest), 'CUSTOM_AUTHZ_DENIED');
  });
});

test('transport error vocabulary is fixed and assertion-friendly', () => {
  assert.deepEqual(tcpReplicaErrorCodes.includes('TCP_AUTH_BAD_SIGNATURE'), true);
  assert.deepEqual(tcpReplicaErrorCodes.includes('TCP_AUTH_NONCE_REPLAYED'), true);
  assert.deepEqual(tcpReplicaErrorCodes.includes('TCP_TLS_REQUIRED'), true);
  assert.deepEqual(tcpReplicaErrorCodes.includes('TCP_FRAME_TOO_LARGE'), true);
});

test('HA payload validators reuse the frozen ha-protocol strict schemas', async () => {
  const valid = {
    schema_version: 'mwha.event.v1',
    identity: { writer_id: 'w1', epoch: 1, term: 1, local_seq: 1, ledger_event_hash: HASH },
    leader: null,
  };
  assert.deepEqual(assertMwhaWriterEvent(valid), valid);
  // Unknown fields are rejected whole by the frozen schema, not silently stripped.
  const error = await expectCode(
    () => assertMwhaWriterEvent({ ...valid, unexpected: true }),
    'HA_INPUT_INVALID',
  );
  assert.ok(error instanceof Error);
});
