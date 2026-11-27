/**
 * T-148 / CV-06 M17 red-team stability suite.
 *
 * Deterministic stress + hostile-timing + leak assertions over the protocol
 * seams delivered by M17:
 *   - repeated-run stress: child-process crash/restart, TCP close races, HA
 *     partition recovery and fault-proxy disconnect/reconnect are each run for
 *     three iterations inside ONE test (a loop, not copy-pasted bodies) and
 *     must produce identical observable signatures;
 *   - hostile timing: timeout storms, late-response floods, forged
 *     epoch/term/vote floods, slow-node deadline boundaries, duplicate/out-of-
 *     order frames and repeated illegal-frame injection;
 *   - resource leak gates per section: active connection counts back to zero,
 *     HA resourceStats all-zero, no surviving child PID, no lingering Timeout
 *     resource after cancellation.
 *
 * Discipline: every injected sleep is <= 200ms; process/state convergence waits
 * are capped at 500ms (the whole file still carries the 120s safety timeout).
 * No OS-level partition, physical cluster or SLA is claimed: these are local
 * loopback TCP / in-process protocol-layer exercises only.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import test, { type TestContext } from 'node:test';
import { ulid } from '../../src/core/ulid.ts';
import { Ledger } from '../../src/ledger/ledger.ts';
import { hashEvent, ledgerEventSchema, type LedgerEvent } from '../../src/ledger/event.ts';
import { exportCommittedEvents } from '../../src/memory/replication.ts';
import {
  ChildProcessReplicaTransport,
  ReplicaTransportError,
  type ReplicaHandle,
} from '../../src/memory/replica-transport.ts';
import {
  HaProtocolError,
  MWHA_PROTOCOL_SCHEMA_VERSION,
  type MwhaLeaderLease,
} from '../../src/memory/ha-protocol.ts';
import { HaCluster } from '../../src/memory/ha-cluster.ts';
import { LeaderLeaseManager } from '../../src/memory/leader-lease.ts';
import { distributedProbe } from '../../src/memory/distributed-probe.ts';
import {
  ANCHOR_PROBE_REQUEST_SCHEMA_VERSION,
  type AnchorProbeSnapshot,
} from '../../src/memory/probe-contract.ts';
import type { DistributedNodeResponse } from '../../src/memory/distributed-probe.ts';
import type { ProbeStore } from '../../src/memory/probe-store.ts';
import { TcpFaultProxy, type TcpFaultRule } from '../../src/memory/tcp-fault-proxy.ts';
import {
  TCP_REPLICA_MAX_FRAME_BYTES,
  TcpReplicaClient,
  TcpReplicaFrameDecoder,
  TcpReplicaServer,
  type TcpReplicaServerOptions,
  type TcpReplicaService,
  type TcpReplicaStatusView,
} from '../../src/memory/tcp-transport.ts';

// ---------------------------------------------------------------------------
// Bounds and small helpers
// ---------------------------------------------------------------------------

const TEST_TIMEOUT = 120_000;
/** State convergence cap for protocol operations. */
const REAP_MS = 500;
/** Windows child exit + stdio cleanup can trail stop() under full-suite load. */
const PROCESS_REAP_MS = 15_000;
/** No injected sleep in this file exceeds 200ms. */
const MAX_SLEEP_MS = 200;

const SCOPE = 'm17-stability';
const SECRET = 'm17-stability-secret';
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_A = 'a'.repeat(64);
const AT = '2026-11-25T00:00:00.000Z';

function sleep(ms: number): Promise<void> {
  assert.ok(ms <= MAX_SLEEP_MS, `injected sleep ${String(ms)}ms exceeds the ${String(MAX_SLEEP_MS)}ms discipline`);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out after ${String(timeoutMs)}ms waiting for ${label}`);
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

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user/context.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function alivePids(pids: Iterable<number>): number[] {
  return [...pids].filter((pid) => processExists(pid));
}

/** Number of live Timeout resources (undefined when the platform cannot report). */
function timeoutResourceCount(): number | null {
  const active = (process as NodeJS.Process & { getActiveResourcesInfo?: () => readonly string[] }).getActiveResourcesInfo;
  if (typeof active !== 'function') return null;
  return active.call(process).filter((resource) => resource === 'Timeout').length;
}

function safeRef(root: string): string {
  return root.replace(/[^A-Za-z0-9._:-]/gu, '_');
}

function rawFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const out = Buffer.allocUnsafe(4 + body.length);
  out.writeUInt32BE(body.length, 0);
  body.copy(out, 4);
  return out;
}

function fakeSnapshot(big = false): AnchorProbeSnapshot {
  return {
    project_scope: SCOPE,
    ledger_digest: HASH_A,
    graph_revision: null,
    source_fingerprint: null,
    connected_digest: null,
    ...(big ? { big: 'x'.repeat(2_048) } : {}),
  } as AnchorProbeSnapshot;
}

function probeRequest(requestId: string, root = 'F:/project'): Record<string, unknown> {
  return {
    schema_version: ANCHOR_PROBE_REQUEST_SCHEMA_VERSION,
    request_id: requestId,
    root,
    project_scope: SCOPE,
    required_facts: [],
  };
}

// ---------------------------------------------------------------------------
// In-memory replica service
// ---------------------------------------------------------------------------

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
    return {
      applied: events.length,
      duplicates: 0,
      outOfOrder: 0,
      gaps: [],
      corrupt: 0,
      commitIndex: this.commitIndex,
      viewDigest: HASH_A,
      complete: true,
      pendingCount: 0,
    };
  }

  async status(): Promise<TcpReplicaStatusView> {
    return {
      replicaId: 'node-b',
      commitIndex: this.commitIndex,
      viewDigest: HASH_A,
      evidenceDigest: HASH_A,
      state: 'ACTIVE',
      snapshot: fakeSnapshot(),
      clusterEpoch: 'epoch-1',
      projectScope: SCOPE,
    };
  }
}

function serverOptions(overrides: Record<string, unknown> = {}): TcpReplicaServerOptions {
  return {
    host: '127.0.0.1',
    port: 0,
    sharedSecret: SECRET,
    authorizedNodes: ['node-a'],
    service: new MemoryService(),
    ...overrides,
  };
}

function makeClient(port: number, nodeId = 'node-a', extra: Record<string, unknown> = {}): TcpReplicaClient {
  return new TcpReplicaClient({ host: '127.0.0.1', port, nodeId, sharedSecret: SECRET, ...extra });
}

// ---------------------------------------------------------------------------
// Scripted fake peer: holds/late-floods/out-of-order/duplicate responses
// ---------------------------------------------------------------------------

interface ScriptedQuery {
  readonly id: string;
  readonly payload: unknown;
  readonly socket: net.Socket;
}

type ScriptedQueryHandler = (
  query: ScriptedQuery,
  reply: (payload: unknown) => void,
  raw: (frame: Record<string, unknown>) => void,
) => void;

interface ScriptedTcpServerOptions {
  /** Hold every query until `floodLate()`/`releaseHeld()` is called. */
  readonly holdQueries?: boolean;
  readonly onQuery?: ScriptedQueryHandler;
}

class ScriptedTcpServer {
  readonly server: net.Server;
  address: { host: string; port: number } | null = null;
  private readonly sockets = new Set<net.Socket>();
  private readonly decoders = new Map<net.Socket, TcpReplicaFrameDecoder>();
  private readonly authed = new Set<net.Socket>();
  private readonly heldQueries = new Map<string, ScriptedQuery>();
  private readonly observedRoots = new Set<string>();
  private holdQueries: boolean;
  private readonly onQuery: ScriptedQueryHandler | null;

  constructor(options: ScriptedTcpServerOptions = {}) {
    this.holdQueries = options.holdQueries ?? false;
    this.onQuery = options.onQuery ?? null;
    this.server = net.createServer((socket) => this.onConnection(socket));
  }

  get connectionCount(): number {
    return this.sockets.size;
  }

  get heldQueryIds(): readonly string[] {
    return [...this.heldQueries.keys()];
  }

  /** Stop holding new queries: later queries are answered immediately. */
  setHoldQueries(value: boolean): void {
    this.holdQueries = value;
  }

  get roots(): readonly string[] {
    return [...this.observedRoots];
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
    if (address === null || typeof address !== 'object') throw new Error('scripted server did not report an address');
    this.address = { host: '127.0.0.1', port: address.port };
  }

  async close(): Promise<void> {
    for (const socket of [...this.sockets]) socket.destroy();
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
  }

  /** Answer every held query late (twice), plus wrong-kind and unknown-id noise. */
  floodLate(): void {
    for (const [id, query] of [...this.heldQueries]) {
      for (let copy = 0; copy < 2; copy += 1) {
        this.reply(query.socket, { ok: true, kind: 'query', id, payload: { candidates: [] } });
      }
      this.reply(query.socket, { ok: true, kind: 'status', id, payload: { replicaId: 'node-b' } });
      for (let noise = 0; noise < 8; noise += 1) {
        this.reply(query.socket, { ok: true, kind: 'status', id: `bogus-${id}-${String(noise)}`, payload: {} });
      }
    }
    this.heldQueries.clear();
  }

  releaseHeld(id: string): boolean {
    const query = this.heldQueries.get(id);
    if (query === undefined) return false;
    this.heldQueries.delete(id);
    const root = typeof (query.payload as { root?: unknown }).root === 'string'
      ? String((query.payload as { root: string }).root)
      : 'default';
    this.reply(query.socket, {
      ok: true,
      kind: 'query',
      id,
      payload: {
        candidates: [{ record_ref: `rec-${safeRef(root)}` }],
        edges: [],
        commitIndex: 0,
        state: 'ACTIVE',
        clusterEpoch: 'epoch-1',
      },
    });
    return true;
  }

  private onConnection(socket: net.Socket): void {
    this.sockets.add(socket);
    this.decoders.set(socket, new TcpReplicaFrameDecoder(TCP_REPLICA_MAX_FRAME_BYTES));
    socket.on('close', () => {
      this.sockets.delete(socket);
      this.authed.delete(socket);
      this.decoders.delete(socket);
    });
    socket.on('error', () => undefined);
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
    for (const frame of outcome.frames) this.onFrame(socket, frame as { kind?: unknown; id?: unknown; payload?: unknown });
  }

  private onFrame(socket: net.Socket, frame: { kind?: unknown; id?: unknown; payload?: unknown }): void {
    const kind = typeof frame.kind === 'string' ? frame.kind : '';
    const id = typeof frame.id === 'string' ? frame.id : 'stray';
    if (!this.authed.has(socket)) {
      if (kind === 'hello') {
        this.reply(socket, { ok: true, kind, id, payload: { serverNonce: 'b'.repeat(64) } });
        return;
      }
      if (kind === 'auth') {
        this.authed.add(socket);
        this.reply(socket, { ok: true, kind, id, payload: { nodeId: 'node-a', authenticated: true } });
        return;
      }
      this.reply(socket, { ok: false, kind, id, error: { code: 'TCP_AUTH_REQUIRED', message: 'handshake required' } });
      return;
    }
    if (kind === 'query') {
      const payload = frame.payload;
      const root = typeof (payload as { root?: unknown })?.root === 'string' ? String((payload as { root: string }).root) : '';
      this.observedRoots.add(root);
      const query: ScriptedQuery = { id, payload, socket };
      if (this.onQuery !== null) {
        // Keep the query addressable so releaseHeld() can answer it later.
        this.heldQueries.set(id, query);
        this.onQuery(
          query,
          (replyPayload) => this.reply(socket, { ok: true, kind: 'query', id, payload: replyPayload }),
          (raw) => this.write(socket, raw),
        );
        return;
      }
      if (this.holdQueries) {
        this.heldQueries.set(id, query);
        return;
      }
      this.reply(socket, {
        ok: true,
        kind,
        id,
        payload: { candidates: [], edges: [], commitIndex: 0, state: 'ACTIVE', clusterEpoch: 'epoch-1' },
      });
      return;
    }
    if (kind === 'status') {
      this.reply(socket, {
        ok: true,
        kind,
        id,
        payload: {
          replicaId: 'node-b',
          commitIndex: 0,
          viewDigest: HASH_A,
          evidenceDigest: HASH_A,
          state: 'ACTIVE',
          snapshot: fakeSnapshot(),
          clusterEpoch: 'epoch-1',
          projectScope: SCOPE,
        },
      });
      return;
    }
    this.reply(socket, { ok: false, kind, id, error: { code: 'TCP_MESSAGE_UNKNOWN_TYPE', message: `unsupported ${kind}` } });
  }

  private reply(socket: net.Socket, value: Record<string, unknown>): void {
    this.write(socket, value);
  }

  private write(socket: net.Socket, value: Record<string, unknown>): void {
    socket.write(rawFrame({ schema_version: MWHA_PROTOCOL_SCHEMA_VERSION, ...value }));
  }
}

// ---------------------------------------------------------------------------
// Child-process fixture
// ---------------------------------------------------------------------------

interface Fixture {
  readonly root: string;
  readonly ledger: Ledger;
  readonly snapshot: AnchorProbeSnapshot;
  readonly envelopes: ReturnType<typeof exportCommittedEvents>['events'];
  readonly lateEvents: readonly { readonly kind: LedgerEvent['kind']; readonly payload: Record<string, unknown>; readonly idemKey: string }[];
  readonly totalEvents: number;
}

function notePayload(label: string, text: string): Record<string, unknown> {
  return {
    note_id: createHash('sha256').update(`m17-stab:${label}`).digest('hex'),
    kind: 'decision',
    text,
    created_at: AT,
    anchor: { file: 'src/a.ts', symbolId: `sym-${label}` },
  };
}

async function removeTree(root: string): Promise<void> {
  // Windows releases sqlite file handles a tick after close/process exit.
  let lastError: unknown;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if ((error as NodeJS.ErrnoException).code !== 'EBUSY' && (error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
      await sleep(20);
    }
  }
  throw lastError;
}

async function buildLedgerFixture(t: TestContext, seed: number): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'ano m17 stability '));
  let tick = 1_000 + seed * 100;
  const ledger = await Ledger.open(root, {
    sessionId: `m17-stab-${ulid().slice(-8)}`,
    clock: () => {
      tick += 1;
      return tick;
    },
  });
  // node:test runs t.after hooks in registration order: the ledger must be
  // closed before the tree removal, otherwise Windows still holds
  // .ano/cache/views.db and the unlink fails with EBUSY.
  t.after(async () => {
    try {
      ledger.close();
    } catch {
      // already closed
    }
    await sleep(20);
  });
  t.after(async () => {
    await removeTree(root);
  });

  for (let index = 0; index < 4; index += 1) {
    const result = await ledger.append({ kind: 'note.recorded', payload: notePayload(`init-${seed}-${index}`, `stability ${index}`) }, `stab-init-${seed}-${index}`);
    assert.ok(result.event !== undefined);
  }
  const envelopes = exportCommittedEvents(ledger, { projectScope: SCOPE, limit: 1024 }).events;
  return {
    root,
    ledger,
    snapshot: {
      project_scope: SCOPE,
      ledger_digest: HASH_B,
      graph_revision: HASH_B,
      source_fingerprint: HASH_C,
      connected_digest: null,
    },
    envelopes,
    lateEvents: [
      { kind: 'note.recorded', payload: notePayload(`late-${seed}-0`, 'late 0'), idemKey: `stab-late-${seed}-0` },
      { kind: 'note.recorded', payload: notePayload(`late-${seed}-1`, 'late 1'), idemKey: `stab-late-${seed}-1` },
    ],
    // Ledger.open emits one bootstrap event before the caller's appends.
    totalEvents: envelopes.length + 2,
  };
}

async function stopQuietly(transport: ChildProcessReplicaTransport, handle: ReplicaHandle | null): Promise<void> {
  if (handle === null) return;
  try {
    await transport.stop(handle);
  } catch {
    // already gone; the PID assertions are the real check
  }
}

// ---------------------------------------------------------------------------
// HA helpers
// ---------------------------------------------------------------------------

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

function haEvent(label: string, seed: number): LedgerEvent {
  return ledgerEventSchema.parse({
    id: ulidLike(seed),
    hlc: { physical: 1_700_000_000_000 + seed, logical: 0, actor: 'writer-1' },
    actor: 'writer-1',
    kind: 'note.recorded',
    payload: { label, seed },
    idem_key: `m17-stab-${label}`,
    prev_hash: '0'.repeat(64),
  });
}

interface TestClock {
  t: number;
  now: () => number;
  advance(ms: number): void;
}

function makeClock(start = 1_000_000): TestClock {
  const clock: TestClock = {
    t: start,
    now: () => clock.t,
    advance: (ms) => {
      clock.t += ms;
    },
  };
  return clock;
}

function zeroClusterStats(): ReturnType<HaCluster['resourceStats']> {
  return {
    nodes_open: 0,
    ha_servers_open: 0,
    replica_servers_open: 0,
    proxies_open: 0,
    clients_open: 0,
    active_connections: 0,
  };
}

// ---------------------------------------------------------------------------
// 1. Repeated-run stress: child-process crash / restart
// ---------------------------------------------------------------------------

test('重复运行压力：崩溃重启副本三次迭代行为一致', { timeout: TEST_TIMEOUT }, async (t) => {
  const signatures: Record<string, unknown>[] = [];
  const pids = new Set<number>();

  for (let iteration = 0; iteration < 3; iteration += 1) {
    const fixture = await buildLedgerFixture(t, iteration);
    const transport = new ChildProcessReplicaTransport();
    const replica = await transport.start({
      root: fixture.root,
      replicaId: `stab-restart-${String(iteration)}`,
      projectScope: SCOPE,
      clusterEpoch: 'epoch-1',
      snapshot: fixture.snapshot,
      startTimeoutMs: 3_000,
      nodeTimeoutMs: 500,
      stopTimeoutMs: 500,
    });
    t.after(async () => {
      await stopQuietly(transport, replica);
    });
    assert.ok(replica.pid !== null);
    if (replica.pid !== null) pids.add(replica.pid);

    const applied = await transport.apply(replica, fixture.envelopes, { projectScope: SCOPE });
    assert.equal(applied.applied, fixture.envelopes.length);
    const before = (await transport.status(replica)).commitIndex;
    assert.equal(before, fixture.envelopes.length);

    const deadPid = replica.pid as number;
    assert.equal(processExists(deadPid), true);
    assert.equal(process.kill(deadPid, 'SIGKILL'), true);
    await waitFor(() => transport.isAlive(replica) === false, PROCESS_REAP_MS, 'crash detection');
    await waitFor(() => processExists(deadPid) === false, PROCESS_REAP_MS, 'dead worker pid reaped');

    for (const late of fixture.lateEvents) {
      const appended = await fixture.ledger.append({ kind: late.kind, payload: late.payload }, late.idemKey);
      assert.ok(appended.event !== undefined);
    }

    const restarted = await transport.restart(replica);
    t.after(async () => {
      await stopQuietly(transport, restarted);
    });
    assert.notEqual(restarted.pid, deadPid);
    assert.ok(restarted.pid !== null && processExists(restarted.pid));
    if (restarted.pid !== null) pids.add(restarted.pid);
    await waitFor(() => processExists(deadPid) === false, PROCESS_REAP_MS, 'old worker pid stays dead');

    const resumedCursor = (await transport.status(restarted)).commitIndex;
    assert.equal(resumedCursor, before, 'persisted cursor must survive the restart');
    const finalStatus = await transport.resume(
      restarted,
      async (cursor) => exportCommittedEvents(fixture.ledger, {
        fromCommitIndex: cursor.commitIndex,
        projectScope: SCOPE,
        limit: 1024,
      }).events,
    );
    assert.equal(finalStatus.commitIndex, fixture.totalEvents);

    await transport.stop(restarted);
    const restartedPid = restarted.pid as number;
    await waitFor(() => processExists(restartedPid) === false, PROCESS_REAP_MS, 'replacement worker pid reaped');
    signatures.push({
      applied: applied.applied,
      before,
      resumedCursor,
      finalIndex: finalStatus.commitIndex,
      replacedPid: restarted.pid !== deadPid,
    });
  }

  assert.equal(signatures.length, 3);
  assert.deepEqual(signatures[1], signatures[0]);
  assert.deepEqual(signatures[2], signatures[0]);
  const survivors = alivePids(pids);
  assert.deepEqual(survivors, [], `no child PID may survive the stress run: ${JSON.stringify(survivors)}`);
});

test('进程竞态：同一 handle 并发 restart 只启动一个替换进程', { timeout: TEST_TIMEOUT }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ano m17 stability restart '));
  t.after(async () => {
    await removeTree(root);
  });
  const transport = new ChildProcessReplicaTransport();
  const replica = await transport.start({
    root,
    replicaId: 'stab-concurrent-restart',
    projectScope: SCOPE,
    clusterEpoch: 'epoch-1',
    snapshot: {
      project_scope: SCOPE,
      ledger_digest: HASH_B,
      graph_revision: HASH_B,
      source_fingerprint: HASH_C,
      connected_digest: null,
    },
    startTimeoutMs: 3_000,
    nodeTimeoutMs: 500,
    stopTimeoutMs: 500,
  });
  const originalPid = replica.pid as number;
  t.after(async () => {
    await stopQuietly(transport, replica);
  });

  const [first, second] = await Promise.all([transport.restart(replica), transport.restart(replica)]);
  assert.equal(first.pid, second.pid, 'concurrent restarts must converge on one replacement process');
  assert.notEqual(first.pid, originalPid);
  assert.ok(first.pid !== null && processExists(first.pid));
  await waitFor(() => processExists(originalPid) === false, PROCESS_REAP_MS, 'original worker pid reaped');
  t.after(async () => {
    await stopQuietly(transport, first);
  });

  await transport.stop(first);
  await waitFor(() => processExists(first.pid as number) === false, PROCESS_REAP_MS, 'replacement worker pid reaped');
  assert.equal(alivePids([originalPid, first.pid as number]).length, 0);
});

// ---------------------------------------------------------------------------
// 2. Repeated-run stress: TCP close race
// ---------------------------------------------------------------------------

test('重复运行压力：TCP 关闭竞态三次迭代收敛一致', { timeout: TEST_TIMEOUT }, async (t) => {
  const signatures: Record<string, unknown>[] = [];

  for (let iteration = 0; iteration < 3; iteration += 1) {
    let rounds = 0;
    let deterministicClose = 0;
    let releasedPort = 0;

    for (let round = 0; round < 3; round += 1) {
      const service = new MemoryService();
      const server = new TcpReplicaServer(serverOptions({ service, idleTimeoutMs: 0, handshakeTimeoutMs: 200 }));
      await server.listen();
      const port = server.address!.port;
      const client = makeClient(port, 'node-a', { requestTimeoutMs: 100 });
      await client.connect();
      assert.equal(client.activeConnectionCount, 1);
      assert.equal(server.activeConnectionCount, 1);

      // One in-flight request must be abandoned by whichever side closes first;
      // client.close() rejects pending work synchronously with a stable code.
      const inFlight = client.status().then(
        () => 'ok' as const,
        (error: unknown) => codeOf(error) ?? 'unknown',
      );
      await Promise.allSettled([client.close(), server.close()]);
      assert.equal(await inFlight, 'TCP_CONNECTION_CLOSED');
      assert.equal(client.activeConnectionCount, 0);
      assert.equal(server.activeConnectionCount, 0);
      assert.equal(server.isClosed, true);
      assert.equal(server.address, null);

      // The released listener port must be immediately re-bindable.
      const replacement = new TcpReplicaServer(serverOptions({ service, port }));
      await replacement.listen();
      assert.equal(replacement.address?.port, port);
      await replacement.close();
      rounds += 1;
      deterministicClose += 1;
      releasedPort += 1;
    }

    signatures.push({ rounds, deterministicClose, releasedPort });
  }

  assert.deepEqual(signatures[1], signatures[0]);
  assert.deepEqual(signatures[2], signatures[0]);
  assert.deepEqual(signatures[0], { rounds: 3, deterministicClose: 3, releasedPort: 3 });
});

// ---------------------------------------------------------------------------
// 3. Repeated-run stress: HA partition recovery
// ---------------------------------------------------------------------------

test('重复运行压力：HA 分区恢复三次迭代行为一致', { timeout: TEST_TIMEOUT }, async (t) => {
  const signatures: Record<string, unknown>[] = [];

  for (let iteration = 0; iteration < 3; iteration += 1) {
    const clock = makeClock(1_000_000 + iteration * 10_000);
    const cluster = await HaCluster.start({
      now: clock.now,
      leaseDurationMs: 5_000,
      heartbeatTimeoutMs: 5_000,
      requestTimeoutMs: 300,
      connectTimeoutMs: 300,
    });
    t.after(async () => {
      await cluster.close();
    });

    const first = await cluster.elect('n1');
    assert.equal(first.won, true);
    const eventA = haEvent(`partition-a-${iteration}`, iteration * 10 + 1);
    const commitA = await cluster.propose({
      memberId: 'n1',
      writerId: 'writer-1',
      epoch: first.epoch,
      term: first.term,
      localSeq: 1,
      ledgerEvent: eventA,
      ledgerEventHash: hashEvent(eventA),
    });
    assert.equal(commitA.committed, true);
    assert.equal(commitA.commit_index, 1);

    await cluster.isolate([['n2', 'n3'], ['n1']]);
    const stale = haEvent(`partition-stale-${iteration}`, iteration * 10 + 2);
    await expectCode(
      () => cluster.propose({
        memberId: 'n1',
        writerId: 'writer-1',
        epoch: first.epoch,
        term: first.term,
        localSeq: 2,
        ledgerEvent: stale,
        ledgerEventHash: hashEvent(stale),
      }),
      'QUORUM_NOT_REACHED',
    );

    const second = await cluster.elect('n2');
    assert.equal(second.won, true);
    assert.ok(second.term > first.term);
    assert.ok(second.epoch > first.epoch);
    const eventB = haEvent(`partition-b-${iteration}`, iteration * 10 + 3);
    const commitB = await cluster.propose({
      memberId: 'n2',
      writerId: 'writer-1',
      epoch: second.epoch,
      term: second.term,
      localSeq: 1,
      ledgerEvent: eventB,
      ledgerEventHash: hashEvent(eventB),
    });
    assert.equal(commitB.committed, true);

    await cluster.restore();
    const rejoin = await cluster.rejoin('n1');
    assert.equal(rejoin.rejoined, true);
    assert.equal(rejoin.adopted_epoch, second.epoch);
    assert.equal(rejoin.adopted_term, second.term);
    assert.equal(cluster.node('n1').manager.role, 'follower');

    const postRejoin = haEvent(`partition-post-${iteration}`, iteration * 10 + 4);
    await expectCode(
      () => cluster.propose({
        memberId: 'n1',
        writerId: 'writer-1',
        epoch: second.epoch,
        term: second.term,
        localSeq: 2,
        ledgerEvent: postRejoin,
        ledgerEventHash: hashEvent(postRejoin),
      }),
      'FENCE_REJECTED',
    );

    await cluster.close();
    assert.deepEqual(cluster.resourceStats(), zeroClusterStats());
    assert.equal(cluster.isClosed, true);
    signatures.push({
      first: { epoch: first.epoch, term: first.term, votes: first.votes },
      commitA: commitA.commit_index,
      second: { epoch: second.epoch, term: second.term, votes: second.votes },
      commitB: commitB.commit_index,
      rejoin: { adopted: rejoin.adopted_epoch, term: rejoin.adopted_term },
      postRejoinFence: 'FENCE_REJECTED',
    });
  }

  assert.equal(signatures.length, 3);
  assert.deepEqual(signatures[1], signatures[0]);
  assert.deepEqual(signatures[2], signatures[0]);
});

// ---------------------------------------------------------------------------
// 4. Repeated-run stress: fault-proxy disconnect / reconnect
// ---------------------------------------------------------------------------

test('重复运行压力：TCP 故障代理断链重连三次迭代收敛一致', { timeout: TEST_TIMEOUT }, async (t) => {
  const signatures: Record<string, unknown>[] = [];

  for (let iteration = 0; iteration < 3; iteration += 1) {
    const service = new MemoryService();
    const server = new TcpReplicaServer(serverOptions({ service, idleTimeoutMs: 0 }));
    await server.listen();
    const upstreamPort = server.address!.port;
    const rules: readonly TcpFaultRule[] = [
      { kind: 'disconnect', direction: 'client-to-server', probability: 1, afterFrames: 2, durationFrames: 1 },
    ];
    const proxy = await TcpFaultProxy.start({
      listen: { host: '127.0.0.1', port: 0 },
      upstream: { host: '127.0.0.1', port: upstreamPort },
      seed: `m17-stab-proxy-${String(iteration)}`,
      rules,
    });
    const proxyPort = proxy.address!.port;
    t.after(async () => {
      await server.close();
      await proxy.close();
    });

    const first = makeClient(proxyPort);
    await first.connect();
    const cutCode = await first.status({ timeoutMs: 200 }).then(
      () => 'ok' as const,
      (error: unknown) => codeOf(error) ?? 'unknown',
    );
    assert.equal(cutCode, 'TCP_CONNECTION_CLOSED');
    await waitFor(() => proxy.stats().activeConnections === 0, REAP_MS, 'proxy link teardown');
    await waitFor(() => server.activeConnectionCount === 0, REAP_MS, 'server link teardown');

    // The one-shot rule is per connection: a second handshake through the same
    // listener still succeeds, but its next outbound frame is cut again.
    const sameListener = makeClient(proxyPort);
    await sameListener.connect();
    assert.equal(sameListener.activeConnectionCount, 1);
    await sameListener.close();
    await first.close();

    // Rebuild the link against the same upstream, exactly like HA repartition
    // restore, and prove a full round trip now succeeds.
    const rebuilt = await TcpFaultProxy.start({
      listen: { host: '127.0.0.1', port: 0 },
      upstream: { host: '127.0.0.1', port: upstreamPort },
      seed: `m17-stab-proxy-clean-${String(iteration)}`,
    });
    t.after(async () => {
      await rebuilt.close();
    });
    const second = makeClient(rebuilt.address!.port);
    await second.connect();
    const recovered = await second.status({ timeoutMs: 200 });
    assert.equal(recovered.replicaId, 'node-b');
    assert.equal(second.activeConnectionCount, 1);

    await second.close();
    await rebuilt.close();
    await proxy.close();
    await server.close();
    assert.equal(proxy.stats().activeConnections, 0);
    assert.equal(proxy.isClosed, true);
    assert.equal(proxy.stats().acceptedConnections, 2, 'both handshakes reached the proxy listener');
    assert.ok(proxy.stats().closedConnections >= 1, 'the cut link was accounted for');

    await new Promise<void>((resolve, reject) => {
      const probe = net.createServer();
      const timer = setTimeout(() => {
        probe.close();
        reject(new Error(`listener port ${String(proxyPort)} was not released`));
      }, REAP_MS);
      timer.unref?.();
      probe.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      probe.listen({ host: '127.0.0.1', port: proxyPort }, () => {
        clearTimeout(timer);
        probe.close(() => resolve());
      });
    });

    signatures.push({
      cutCode,
      reconnected: recovered.replicaId,
      sameListenerHandshake: true,
      acceptedConnections: proxy.stats().acceptedConnections,
      portReleased: true,
    });
  }

  assert.deepEqual(signatures[1], signatures[0]);
  assert.deepEqual(signatures[2], signatures[0]);
});

// ---------------------------------------------------------------------------
// 5. Hostile timing: timeout storm + cancellation
// ---------------------------------------------------------------------------

test('时序红队：恶意超时风暴与取消后连接存活且定时器归零', { timeout: TEST_TIMEOUT }, async (t) => {
  const service = new MemoryService();
  service.queryDelayMs = 120;
  const server = new TcpReplicaServer(serverOptions({ service, idleTimeoutMs: 0, requestTimeoutMs: 5_000 }));
  await server.listen();
  const port = server.address!.port;
  const client = makeClient(port, 'node-a', { requestTimeoutMs: 40 });

  const baseline = timeoutResourceCount();
  const rounds: Record<string, number>[] = [];
  try {
    await client.connect();
    for (let round = 0; round < 2; round += 1) {
      const timedOut = await Promise.all(
        Array.from({ length: 64 }, (_unused, index) =>
          client.query(probeRequest(`storm-${String(round)}-${String(index)}`) as never, { timeoutMs: 30 })
            .then(() => 'ok' as const, (error: unknown) => codeOf(error) ?? 'unknown')),
      );
      assert.ok(timedOut.every((code) => code === 'TCP_REQUEST_TIMEOUT'));

      const preAborted = await Promise.all(
        Array.from({ length: 32 }, (_unused, index) => {
          const controller = new AbortController();
          controller.abort();
          return client.query(probeRequest(`pre-${String(round)}-${String(index)}`) as never, { signal: controller.signal })
            .then(() => 'ok' as const, (error: unknown) => codeOf(error) ?? 'unknown');
        }),
      );
      assert.ok(preAborted.every((code) => code === 'TCP_REQUEST_CANCELLED'));

      const abortedMidFlight = await Promise.all(
        Array.from({ length: 32 }, (_unused, index) => {
          const controller = new AbortController();
          setTimeout(() => controller.abort(), 10);
          return client.query(probeRequest(`mid-${String(round)}-${String(index)}`) as never, { signal: controller.signal })
            .then(() => 'ok' as const, (error: unknown) => codeOf(error) ?? 'unknown');
        }),
      );
      assert.ok(abortedMidFlight.every((code) => code === 'TCP_REQUEST_CANCELLED'));
      rounds.push({
        timeouts: timedOut.length,
        preAborted: preAborted.length,
        midFlight: abortedMidFlight.length,
      });
    }

    // Let the server-side delayed handlers settle so no request timer lingers.
    await sleep(160);
    service.queryDelayMs = 0;
    assert.equal(client.activeConnectionCount, 1);
    assert.equal(server.activeConnectionCount, 1);
    const recovered = await client.status();
    assert.equal(recovered.replicaId, 'node-b');
    const answer = await client.query(probeRequest('storm-recovered') as never);
    assert.ok(Array.isArray(answer.candidates));

    if (baseline !== null) {
      const after = timeoutResourceCount();
      assert.ok(after !== null && after <= baseline, `lingering Timeout resources: before=${String(baseline)} after=${String(after)}`);
    }
  } finally {
    await client.close();
    await server.close();
  }
  assert.equal(client.activeConnectionCount, 0);
  assert.equal(server.activeConnectionCount, 0);
  assert.deepEqual(rounds[1], rounds[0]);
});

// ---------------------------------------------------------------------------
// 6. Hostile timing: late-response flood after settlement
// ---------------------------------------------------------------------------

test('时序红队：迟到响应洪泛不崩不泄漏且相关不错位', { timeout: TEST_TIMEOUT }, async (t) => {
  const fake = new ScriptedTcpServer({ holdQueries: true });
  await fake.listen();
  t.after(async () => {
    await fake.close();
  });
  const client = makeClient(fake.address!.port, 'node-a', { requestTimeoutMs: 25 });

  try {
    await client.connect();
    const late = await Promise.all(
      Array.from({ length: 48 }, (_unused, index) =>
        client.query(probeRequest(`late-${String(index)}`, `F:/late/${String(index)}`) as never)
          .then(() => 'ok' as const, (error: unknown) => codeOf(error) ?? 'unknown')),
    );
    assert.ok(late.every((code) => code === 'TCP_REQUEST_TIMEOUT'));
    assert.equal(fake.heldQueryIds.length, 48);

    // Every settled request is answered late, twice, plus wrong-kind/unknown ids.
    fake.floodLate();
    await sleep(30);
    assert.equal(client.activeConnectionCount, 1, 'late frames must not tear down the connection');
    assert.equal(fake.connectionCount, 1);

    fake.setHoldQueries(false);
    const status = await client.status();
    assert.equal(status.replicaId, 'node-b');
    const answer = await client.query(probeRequest('after-flood', 'F:/after-flood') as never);
    assert.ok(Array.isArray(answer.candidates));
    assert.equal(client.activeConnectionCount, 1);
  } finally {
    await client.close();
  }
  await waitFor(() => fake.connectionCount === 0, REAP_MS, 'fake peer sockets closed');
  assert.equal(client.activeConnectionCount, 0);
});

// ---------------------------------------------------------------------------
// 7. Hostile timing: out-of-order + duplicate frames
// ---------------------------------------------------------------------------

test('时序红队：乱序与重复响应按 id 相关且不串档', { timeout: TEST_TIMEOUT }, async (t) => {
  const held: { query: ScriptedQuery | null } = { query: null };
  const fake = new ScriptedTcpServer({
    onQuery: (query, reply, raw) => {
      const root = String((query.payload as { root?: unknown }).root ?? '');
      if (root === 'F:/ooo-a') {
        held.query = query;
        return;
      }
      if (root === 'F:/ooo-b') {
        const payload = { candidates: [{ record_ref: 'rec-b' }], edges: [], commitIndex: 0, state: 'ACTIVE', clusterEpoch: 'epoch-1' };
        reply(payload);
        // Duplicate the settled response; the client must ignore the copy.
        raw({ kind: 'query', id: query.id, ok: true, payload });
        return;
      }
      reply({ candidates: [], edges: [], commitIndex: 0, state: 'ACTIVE', clusterEpoch: 'epoch-1' });
    },
  });
  await fake.listen();
  t.after(async () => {
    await fake.close();
  });
  const client = makeClient(fake.address!.port, 'node-a', { requestTimeoutMs: 200 });

  try {
    await client.connect();
    const pendingA = client.query(probeRequest('ooo-a', 'F:/ooo-a') as never);
    const pendingB = client.query(probeRequest('ooo-b', 'F:/ooo-b') as never);
    await waitFor(() => fake.roots.includes('F:/ooo-b'), REAP_MS, 'second response observed by peer');
    assert.ok(held.query !== null);
    // B's response (and its duplicate) reach the wire before A's; release A now.
    assert.equal(fake.releaseHeld(held.query.id), true);
    const [answerA, answerB] = await Promise.all([pendingA, pendingB]);
    assert.equal(
      (answerA as { candidates: readonly { record_ref: string }[] }).candidates[0]?.record_ref,
      `rec-${safeRef('F:/ooo-a')}`,
    );
    assert.equal((answerB as { candidates: readonly { record_ref: string }[] }).candidates[0]?.record_ref, 'rec-b');
    assert.equal(client.activeConnectionCount, 1);

    const status = await client.status();
    assert.equal(status.replicaId, 'node-b');
  } finally {
    await client.close();
  }
  assert.equal(client.activeConnectionCount, 0);
});

// ---------------------------------------------------------------------------
// 8. Forged epoch/term commit attempts and vote flood bound
// ---------------------------------------------------------------------------

test('伪造 epoch/term 提交被 fencing 拒绝且投票洪泛后声明表有界', { timeout: TEST_TIMEOUT }, async () => {
  const clock = makeClock();
  const manager = new LeaderLeaseManager({
    member_id: 'a',
    members: [{ member_id: 'a', role: 'writer' }],
    voters: [],
    now: clock.now,
    leaseDurationMs: 5_000,
    heartbeatTimeoutMs: 5_000,
  });
  const elected = await manager.requestVote();
  assert.equal(elected.won, true);
  const lease: MwhaLeaderLease = { leader_id: 'a', epoch: elected.epoch, term: elected.term };

  const attempt = (epoch: number, term: number, localSeq: number) => manager.assertCanCommit({
    writer_id: 'w',
    epoch,
    term,
    local_seq: localSeq,
    ledger_event_hash: HASH_A,
  });

  // Epoch rollback / stale term / ahead-of-lease are refused with frozen codes.
  assert.throws(() => attempt(lease.epoch - 1, lease.term, 1), (error: unknown) => error instanceof HaProtocolError && error.code === 'FENCE_EPOCH_ROLLBACK');
  assert.throws(() => attempt(lease.epoch, lease.term - 1, 1), (error: unknown) => error instanceof HaProtocolError && error.code === 'FENCE_STALE_TERM');
  assert.throws(() => attempt(lease.epoch + 1, lease.term + 1, 1), (error: unknown) => error instanceof HaProtocolError && error.code === 'FENCE_REJECTED');
  const granted = attempt(lease.epoch, lease.term, 1);
  assert.equal(granted.allowed, true);

  // A forged term/epoch flood through the inbound vote channel must not grow
  // the declaration table without bound.
  for (let index = 0; index < 1_000; index += 1) {
    manager.handleVoteRequest({
      schema_version: 'mwha.vote-request.v1',
      term: elected.term + 1 + index,
      epoch: elected.epoch + 1 + index,
      candidate_id: `forged-${String(index)}`,
    });
  }
  assert.ok(manager.collectDeclarations().length <= 256, `declaration table grew to ${String(manager.collectDeclarations().length)} entries`);
  assert.equal(manager.snapshot().term, elected.term + 1_000);
  assert.doesNotThrow(() => manager.detectSplitBrain());
  // The flood demoted the node; commit attempts stay fail-closed.
  assert.throws(() => attempt(lease.epoch, lease.term, 2), (error: unknown) => error instanceof HaProtocolError && error.code === 'FENCE_REJECTED');

  // A flood made only of two-leader conflicting groups forces the memory-bound
  // backstop pass: the bound still holds while the newest conflicts survive.
  for (let index = 0; index < 200; index += 1) {
    const epoch = 100_000 + index;
    const term = 100_000 + index;
    manager.handleHeartbeat({ schema_version: 'mwha.heartbeat-request.v1', lease: { term, epoch, leader_id: `left-${String(index)}` } });
    manager.handleHeartbeat({ schema_version: 'mwha.heartbeat-request.v1', lease: { term, epoch, leader_id: `right-${String(index)}` } });
  }
  assert.ok(manager.collectDeclarations().length <= 256, `conflict flood grew the table to ${String(manager.collectDeclarations().length)} entries`);
  assert.ok(manager.detectSplitBrain().length > 0, 'the newest split-brain signal must survive pruning');
});

// ---------------------------------------------------------------------------
// 9. Slow-node deadline boundaries
// ---------------------------------------------------------------------------

function probeStore(): ProbeStore {
  return {
    snapshot: fakeSnapshot(),
    candidates: () => [],
    adjacency: () => [],
    evidence: () => undefined,
    status: () => undefined,
    provenance: () => undefined,
    snapshotIdentity: () => ({ fingerprint: 'fp', snapshot: fakeSnapshot() }),
    replicaCommitIndex: () => 1,
  } as unknown as ProbeStore;
}

test('时序红队：慢节点 deadline 边界收敛且不悬挂', { timeout: TEST_TIMEOUT }, async () => {
  const replicas = [{
    replicaId: 'slow-node',
    store: probeStore(),
    query: async () => {
      await sleep(150);
      return { candidates: [], edges: [], commitIndex: 1, state: 'ACTIVE' as const, clusterEpoch: 'epoch-1' };
    },
  }];
  const baseOptions = {
    localStore: probeStore(),
    replicas,
    mode: 'COMMITTED' as const,
    primaryCommitIndex: 1,
  };

  const before = timeoutResourceCount();
  const first = await distributedProbe(probeRequest('deadline-total') as never, { ...baseOptions, deadlineMs: 50, nodeTimeoutMs: 5_000 });
  assert.equal(first.outcome, 'PARTIAL');
  assert.equal(first.metadata.stop_reason, 'TIMEOUT');
  assert.ok(first.partial.failed_nodes.includes('slow-node'));

  const second = await distributedProbe(probeRequest('deadline-node') as never, { ...baseOptions, deadlineMs: 400, nodeTimeoutMs: 60 });
  assert.equal(second.outcome, 'PARTIAL');
  assert.equal(second.metadata.stop_reason, 'TIMEOUT');

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  const cancelled = await distributedProbe(probeRequest('deadline-abort') as never, {
    ...baseOptions,
    deadlineMs: 5_000,
    nodeTimeoutMs: 5_000,
    signal: controller.signal,
  });
  assert.equal(cancelled.outcome, 'CANCELLED');
  assert.equal(cancelled.metadata.stop_reason, 'CANCELLED');

  // Ten aborted scatter/gathers: every one settles, and no timer is left behind.
  for (let index = 0; index < 10; index += 1) {
    const signal = new AbortController();
    setTimeout(() => signal.abort(), 5);
    const answer = await distributedProbe(probeRequest(`deadline-flood-${String(index)}`) as never, {
      ...baseOptions,
      deadlineMs: 5_000,
      nodeTimeoutMs: 5_000,
      signal: signal.signal,
    });
    assert.equal(answer.outcome, 'CANCELLED');
  }
  await sleep(160);
  if (before !== null) {
    const after = timeoutResourceCount();
    assert.ok(after !== null && after <= before, `lingering Timeout resources: before=${String(before)} after=${String(after)}`);
  }
});

// ---------------------------------------------------------------------------
// 10. Illegal frames repeated, listener survives
// ---------------------------------------------------------------------------

test('非法帧：零长度/超帧/非 JSON/缺字段连续注入后监听存活', { timeout: TEST_TIMEOUT }, async (t) => {
  const server = new TcpReplicaServer(serverOptions({ handshakeTimeoutMs: 200, idleTimeoutMs: 0 }));
  await server.listen();
  const port = server.address!.port;
  const control = makeClient(port);
  t.after(async () => {
    await control.close();
    await server.close();
  });
  await control.connect();

  const hostile: readonly (readonly [string, Buffer])[] = [
    ['zero-length prefix', Buffer.from([0x00, 0x00, 0x00, 0x00])],
    ['above-ceiling length', (() => {
      const header = Buffer.allocUnsafe(4);
      header.writeUInt32BE(TCP_REPLICA_MAX_FRAME_BYTES + 1, 0);
      return header;
    })()],
    ['non-JSON body', (() => {
      const body = Buffer.from('not-json', 'utf8');
      const header = Buffer.allocUnsafe(4);
      header.writeUInt32BE(body.length, 0);
      return Buffer.concat([header, body]);
    })()],
    ['envelope missing fields', rawFrame({ unexpected: true })],
  ];

  for (let round = 0; round < 3; round += 1) {
    for (const [label, bytes] of hostile) {
      const probe = await new Promise<net.Socket>((resolve, reject) => {
        const socket = net.connect({ host: '127.0.0.1', port });
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new Error(`raw connect timed out for ${label}`));
        }, REAP_MS);
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
      probe.write(bytes);
      probe.destroy();
      await sleep(10);
    }
    assert.equal(control.activeConnectionCount, 1, `control connection survived round ${String(round)}`);
    assert.equal((await control.status()).replicaId, 'node-b');
  }

  assert.equal(server.activeConnectionCount, 1, 'only the control connection remains');
  await control.close();
  await waitFor(() => server.activeConnectionCount === 0, REAP_MS, 'server connection released');
  await server.close();
  assert.equal(server.activeConnectionCount, 0);
  assert.equal(server.address, null);
});

// ---------------------------------------------------------------------------
// 11. Leak gate: mixed workload leaves no connections/timers/PIDs
// ---------------------------------------------------------------------------

test('资源泄漏总闸：混合负载后连接、定时器与 PID 均归零', { timeout: TEST_TIMEOUT }, async (t) => {
  const service = new MemoryService();
  const server = new TcpReplicaServer(serverOptions({ service, idleTimeoutMs: 0 }));
  await server.listen();
  const port = server.address!.port;
  const baseline = timeoutResourceCount();
  const clients: TcpReplicaClient[] = [];
  t.after(async () => {
    await server.close();
  });

  for (let round = 0; round < 3; round += 1) {
    const client = makeClient(port, 'node-a', { requestTimeoutMs: 40 });
    clients.push(client);
    await client.connect();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);
    await client.query(probeRequest(`leak-${String(round)}`) as never, { signal: controller.signal }).catch(() => undefined);
    const status = await client.status();
    assert.equal(status.replicaId, 'node-b');
    await client.close();
    await waitFor(() => server.activeConnectionCount === 0, REAP_MS, 'connection drained');
  }

  assert.equal(server.activeConnectionCount, 0);
  for (const client of clients) assert.equal(client.activeConnectionCount, 0);
  await sleep(160);
  if (baseline !== null) {
    const after = timeoutResourceCount();
    assert.ok(after !== null && after <= baseline, `lingering Timeout resources: before=${String(baseline)} after=${String(after)}`);
  }

  // Child-process side of the gate: start/stop leaves no surviving PID.
  const root = await mkdtemp(join(tmpdir(), 'ano m17 stability leak '));
  t.after(async () => {
    await removeTree(root);
  });
  const transport = new ChildProcessReplicaTransport();
  const handle = await transport.start({
    root,
    replicaId: 'stab-leak-gate',
    projectScope: SCOPE,
    clusterEpoch: 'epoch-1',
    snapshot: {
      project_scope: SCOPE,
      ledger_digest: HASH_B,
      graph_revision: HASH_B,
      source_fingerprint: HASH_C,
      connected_digest: null,
    },
    startTimeoutMs: 3_000,
    nodeTimeoutMs: 500,
    stopTimeoutMs: 500,
  });
  const pid = handle.pid as number;
  assert.ok(processExists(pid));
  await transport.stop(handle);
  await waitFor(() => processExists(pid) === false, PROCESS_REAP_MS, 'child pid reaped');
  assert.deepEqual(alivePids([pid]), []);
  await server.close();
  assert.equal(server.activeConnectionCount, 0);
});
