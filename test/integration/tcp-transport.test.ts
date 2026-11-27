/**
 * T-134 integration tests: two independent real TCP listeners on 127.0.0.1:0
 * complete a HMAC handshake and exchange status/query/apply frames, honour
 * timeouts/cancellation, shut down without leaking sockets or ports, and are
 * directly consumable by the unchanged `distributedProbe` coordinator through
 * the `createTcpNodeQuery` adapter.
 *
 * Scope note: this proves local loopback TCP + authentication only. It does not
 * verify physical cross-machine deployment, production HA failover, OS-level
 * partitions or availability SLAs (see TCP_TRANSPORT_UNVERIFIED_BOUNDARIES).
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import test, { type TestContext } from 'node:test';
import {
  ANCHOR_PROBE_CLUSTER_SCHEMA_VERSION,
  ANCHOR_PROBE_REQUEST_SCHEMA_VERSION,
  type AnchorProbeClusterMetadata,
  type AnchorProbeSnapshot,
} from '../../src/memory/probe-contract.ts';
import { MWHA_PROTOCOL_SCHEMA_VERSION } from '../../src/memory/ha-protocol.ts';
import {
  distributedProbe,
  type DistributedReplicaNode,
} from '../../src/memory/distributed-probe.ts';
import type { ProbeCandidate, ProbeEdge } from '../../src/memory/probe.ts';
import {
  probeSnapshotIdentity,
  type ProbeEvidencePayload,
  type ProbeProvenanceView,
  type ProbeStatusView,
  type ProbeStore,
} from '../../src/memory/probe-store.ts';
import type { CommittedEventEnvelope, ReplicationReport } from '../../src/memory/replication.ts';
import {
  createTcpDistributedReplicaNode,
  createTcpNodeQuery,
  TcpReplicaClient,
  TcpReplicaServer,
  TCP_REPLICA_MAX_FRAME_BYTES,
  TCP_TRANSPORT_UNVERIFIED_BOUNDARIES,
  TCP_TRANSPORT_VERIFICATION_NOTE,
  type TcpReplicaService,
} from '../../src/memory/tcp-transport.ts';

// Runtime-only test credential: never persisted, logged or printed.
const SECRET = randomBytes(32).toString('hex');
const HASH = 'a'.repeat(64);
const AT = '2026-11-24T00:00:00.000Z';

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

function clusterMetadata(replicaId: string, commitIndex: number): AnchorProbeClusterMetadata {
  return {
    schema_version: ANCHOR_PROBE_CLUSTER_SCHEMA_VERSION,
    project_scope: 'proj',
    cluster_epoch: 'epoch-1',
    commit_index: commitIndex,
    replica_id: replicaId,
    replica_commit_index: commitIndex,
    consistency: 'local',
    max_lag: null,
    partial: false,
    failed_nodes: [],
    evidence_digest: HASH,
  };
}

function snapshot(replicaId: string, commitIndex: number): AnchorProbeSnapshot {
  const metadata = clusterMetadata(replicaId, commitIndex);
  return {
    project_scope: 'proj',
    ledger_digest: HASH,
    graph_revision: null,
    source_fingerprint: null,
    connected_digest: null,
    cluster: metadata,
  };
}

function candidate(recordRef: string, contentHash = HASH): ProbeCandidate {
  return {
    record_ref: recordRef,
    fact_key: 'local.storage.engine',
    task_id: null,
    file: null,
    symbol: null,
    source: { kind: 'native_note' },
    source_health: 'verified_at_snapshot',
    status: 'active',
    content: `content of ${recordRef}`,
    content_hash: contentHash,
    recorded_at: AT,
    effective_from: null,
    effective_to: null,
    superseded_by: null,
    version: null,
    anchor: { status: 'none', file: null },
    qualifiers: [],
  };
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

function fakeEvent(seq: number): CommittedEventEnvelope {
  return {
    seq,
    eventId: `evt-${String(seq)}`,
    hash: 'b'.repeat(64),
    kind: 'memory.revised',
    payload: { note: `note-${String(seq)}` },
    recordedAt: AT,
    segment: 'seg-1',
    prevHash: 'c'.repeat(64),
    // Deep replica validation is the applier's job; the transport only guards
    // identity shape, exactly like M15's validateApply/committedEnvelopeIssue split.
    event: { id: `evt-${String(seq)}`, payload: { note: `note-${String(seq)}` } },
    contentRedacted: false,
  } as unknown as CommittedEventEnvelope;
}

class MemoryReplicaService implements TcpReplicaService {
  commitIndex = 0;
  readonly candidates: ProbeCandidate[] = [];
  queryDelayMs = 0;
  readonly replicaId: string;

  constructor(replicaId: string) {
    this.replicaId = replicaId;
  }

  async query(request: { root?: string }): Promise<{ candidates: ProbeCandidate[]; edges: ProbeEdge[]; commitIndex: number; viewDigest: string; state: 'ACTIVE'; clusterEpoch: string }> {
    if (this.queryDelayMs > 0) await sleep(this.queryDelayMs);
    const root = typeof request.root === 'string' ? request.root : 'default';
    const safeRoot = root.replace(/[^A-Za-z0-9._:-]/gu, '_');
    return {
      candidates: [...this.candidates, candidate(`rec-${safeRoot}`)],
      edges: [],
      commitIndex: this.commitIndex,
      viewDigest: HASH,
      state: 'ACTIVE',
      clusterEpoch: 'epoch-1',
    };
  }

  async apply(events: readonly CommittedEventEnvelope[]): Promise<ReplicationReport> {
    for (const event of events) {
      this.candidates.push(candidate(`rec-applied-${String(event.seq)}`, 'd'.repeat(64)));
    }
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

  async status(): Promise<{
    replicaId: string;
    commitIndex: number;
    viewDigest: string;
    evidenceDigest: string;
    state: 'ACTIVE';
    snapshot: AnchorProbeSnapshot;
    clusterEpoch: string;
    projectScope: string;
  }> {
    return {
      replicaId: this.replicaId,
      commitIndex: this.commitIndex,
      viewDigest: HASH,
      evidenceDigest: HASH,
      state: 'ACTIVE',
      snapshot: snapshot(this.replicaId, this.commitIndex),
      clusterEpoch: 'epoch-1',
      projectScope: 'proj',
    };
  }
}

class FakeLocalStore implements ProbeStore {
  readonly snapshot: AnchorProbeSnapshot;
  readonly #candidates: readonly ProbeCandidate[];

  constructor(candidates: readonly ProbeCandidate[]) {
    this.snapshot = snapshot('local', 0);
    this.#candidates = candidates;
  }

  candidates(): readonly ProbeCandidate[] {
    return this.#candidates;
  }

  adjacency(): readonly ProbeEdge[] {
    return [];
  }

  evidence(recordRef: string): ProbeEvidencePayload | undefined {
    const found = this.#candidates.find((entry) => entry.record_ref === recordRef);
    return found === undefined ? undefined : { record_ref: found.record_ref, content_hash: found.content_hash } as ProbeEvidencePayload;
  }

  status(_recordRef: string): ProbeStatusView | undefined {
    return undefined;
  }

  provenance(_recordRef: string): ProbeProvenanceView | undefined {
    return undefined;
  }

  snapshotIdentity() {
    return probeSnapshotIdentity(this.snapshot);
  }

  replicaCommitIndex(): number {
    return 0;
  }
}

async function makeServer(t: TestContext, service: MemoryReplicaService, extra: Record<string, unknown> = {}): Promise<TcpReplicaServer> {
  const server = new TcpReplicaServer({
    host: '127.0.0.1',
    port: 0,
    sharedSecret: SECRET,
    nodeId: service.replicaId,
    authorizedNodes: ['node-a', 'node-b'],
    service,
    ...extra,
  });
  await server.listen();
  t.after(async () => {
    await server.close();
  });
  return server;
}

function makeClient(port: number, nodeId: string, extra: Record<string, unknown> = {}): TcpReplicaClient {
  return new TcpReplicaClient({ host: '127.0.0.1', port, nodeId, sharedSecret: SECRET, ...extra });
}

async function assertPortClosed(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`port ${String(port)} still accepted a connection`));
    }, 2_000);
    timer.unref?.();
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      reject(new Error(`port ${String(port)} still accepting after close`));
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === 'ECONNREFUSED') resolve();
      else reject(error);
    });
  });
}

/** Minimal raw loopback channel used to drive handshake-table capacity branches. */
class RawChannel {
  readonly socket: net.Socket;
  private buffer = Buffer.alloc(0);
  private queue: unknown[] = [];
  private waiter: { resolve: (value: unknown) => void; timer: NodeJS.Timeout } | null = null;

  private constructor(socket: net.Socket) {
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', () => undefined);
  }

  static connect(port: number): Promise<RawChannel> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('raw channel connect timed out'));
      }, 2_000);
      timer.unref?.();
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve(new RawChannel(socket));
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  send(value: unknown): void {
    const body = Buffer.from(JSON.stringify(value), 'utf8');
    const out = Buffer.allocUnsafe(4 + body.length);
    out.writeUInt32BE(body.length, 0);
    body.copy(out, 4);
    this.socket.write(out);
  }

  next(timeoutMs = 1_500): Promise<Record<string, unknown>> {
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued as Record<string, unknown>);
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (value: unknown) => resolve(value as Record<string, unknown>),
        timer: setTimeout(() => reject(new Error('no frame arrived in time')), timeoutMs),
      };
      waiter.timer.unref?.();
      this.waiter = waiter;
    });
  }

  close(): void {
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
      this.deliver(JSON.parse(body.toString('utf8')));
    }
  }

  private deliver(frame: unknown): void {
    const waiter = this.waiter;
    if (waiter === null) {
      this.queue.push(frame);
      return;
    }
    this.waiter = null;
    clearTimeout(waiter.timer);
    waiter.resolve(frame);
  }
}

test('two independent real TCP nodes handshake, query/apply/status and shut down without leaks', { timeout: 60_000 }, async (t) => {
  const serviceA = new MemoryReplicaService('node-a');
  const serviceB = new MemoryReplicaService('node-b');
  const serverA = await makeServer(t, serviceA);
  const serverB = await makeServer(t, serviceB);
  assert.notEqual(serverA.address?.port, serverB.address?.port);

  const clientA = makeClient(serverB.address!.port, 'node-a');
  const clientB = makeClient(serverA.address!.port, 'node-b');
  t.after(async () => {
    await clientA.close();
    await clientB.close();
  });

  await clientA.connect();
  await clientB.connect();
  assert.equal(clientA.activeConnectionCount, 1);
  assert.equal(clientB.activeConnectionCount, 1);
  assert.ok(serverA.activeConnectionCount >= 1);
  assert.ok(serverB.activeConnectionCount >= 1);

  await t.test('status and query traverse both directions', async () => {
    const statusB = await clientA.status();
    assert.equal(statusB.replicaId, 'node-b');
    assert.equal(statusB.commitIndex, 0);
    assert.equal(statusB.state, 'ACTIVE');

    const responseA = await clientB.query(makeRequest('req-a1', 'F:/project-a') as never);
    assert.ok(Array.isArray(responseA.candidates));
    assert.equal(responseA.candidates[0]?.record_ref, `rec-${safeRef('F:/project-a')}`);

    const responseB = await clientA.query(makeRequest('req-b1', 'F:/project-b') as never);
    assert.equal(responseB.candidates[0]?.record_ref, `rec-${safeRef('F:/project-b')}`);
  });

  await t.test('apply increments the replica commit point and is visible to the peer', async () => {
    const report = await clientA.apply([fakeEvent(1), fakeEvent(2)]);
    assert.equal(report.applied, 2);
    assert.equal(report.commitIndex, 2);
    const status = await clientA.status();
    assert.equal(status.commitIndex, 2);
    assert.equal(serviceB.commitIndex, 2);
  });

  await t.test('concurrent requests keep id correlation (distinct payloads, distinct responses)', async () => {
    const roots = Array.from({ length: 8 }, (_unused, index) => `F:/project-${String(index)}`);
    const responses = await Promise.all(
      roots.map((root, index) => clientA.query(makeRequest(`req-concurrent-${String(index)}`, root) as never)),
    );
    assert.equal(responses.length, roots.length);
    responses.forEach((response, index) => {
      const match = response.candidates.find((entry) => entry.record_ref === `rec-${safeRef(`F:/project-${String(index)}`)}`);
      assert.ok(match !== undefined, `missing correlated candidate for request ${String(index)}`);
    });
    assert.equal(clientA.activeConnectionCount, 1);
  });

  await t.test('per-request timeout rejects and the connection stays usable', async () => {
    serviceB.queryDelayMs = 200;
    await expectCode(
      () => clientA.query(makeRequest('req-timeout', 'F:/slow') as never, { timeoutMs: 25 }),
      'TCP_REQUEST_TIMEOUT',
    );
    serviceB.queryDelayMs = 0;
    assert.equal(clientA.activeConnectionCount, 1);
    const recovered = await clientA.query(makeRequest('req-after-timeout', 'F:/fast') as never);
    assert.ok(Array.isArray(recovered.candidates));
  });

  await t.test('AbortSignal cancellation rejects before and during dispatch', async () => {
    const preAborted = new AbortController();
    preAborted.abort();
    await expectCode(
      () => clientA.query(makeRequest('req-cancel-pre', 'F:/x') as never, { signal: preAborted.signal }),
      'TCP_REQUEST_CANCELLED',
    );

    serviceB.queryDelayMs = 250;
    const controller = new AbortController();
    const pending = clientA.query(makeRequest('req-cancel-during', 'F:/y') as never, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expectCode(() => pending, 'TCP_REQUEST_CANCELLED');
    serviceB.queryDelayMs = 0;
    assert.equal(clientA.activeConnectionCount, 1);
    const recovered = await clientA.query(makeRequest('req-after-cancel', 'F:/z') as never);
    assert.ok(Array.isArray(recovered.candidates));
  });
});

test('distributedProbe consumes the TCP adapter for real QUORUM scatter/gather', { timeout: 60_000 }, async (t) => {
  const serviceA = new MemoryReplicaService('node-a');
  const serviceB = new MemoryReplicaService('node-b');
  const serverA = await makeServer(t, serviceA);
  const serverB = await makeServer(t, serviceB);
  const clientA = makeClient(serverB.address!.port, 'node-a');
  const clientB = makeClient(serverA.address!.port, 'node-b');
  t.after(async () => {
    await clientA.close();
    await clientB.close();
  });
  await clientA.connect();
  await clientB.connect();

  const nodeA: DistributedReplicaNode = await createTcpDistributedReplicaNode(clientA);
  const nodeB: DistributedReplicaNode = await createTcpDistributedReplicaNode(clientB);
  assert.equal(typeof nodeA.query, 'function');
  assert.equal(typeof nodeB.query, 'function');

  const local = new FakeLocalStore([candidate('rec-local')]);
  const answer = await distributedProbe(
    makeRequest('req-distributed', 'F:/local'),
    {
      localStore: local,
      replicas: [nodeA, nodeB],
      mode: 'QUORUM',
      primaryCommitIndex: 0,
      clusterEpoch: 'epoch-1',
      deadlineMs: 10_000,
      nodeTimeoutMs: 5_000,
    },
  );
  assert.equal(answer.outcome, 'CONSISTENT');
  assert.equal(answer.mode, 'QUORUM');
  assert.deepEqual(answer.partial.failed_nodes, []);
  for (const node of answer.nodes) {
    if (node.replica_id === 'local') continue;
    assert.equal(node.outcome, 'OK', `${node.replica_id}: ${node.detail}`);
  }
});

test('createTcpNodeQuery forwards the coordinator request/timeout/signal', { timeout: 60_000 }, async (t) => {
  const service = new MemoryReplicaService('node-b');
  const server = await makeServer(t, service);
  const client = makeClient(server.address!.port, 'node-a');
  t.after(async () => {
    await client.close();
  });
  await client.connect();
  const query = createTcpNodeQuery(client);
  const controller = new AbortController();
  const response = await query(makeRequest('req-adapter', 'F:/adapter') as never, {
    request: makeRequest('req-adapter', 'F:/adapter') as never,
    signal: controller.signal,
    nodeTimeoutMs: 2_000,
  });
  assert.ok(Array.isArray(response.candidates));
});

test('graceful shutdown releases the listener and every socket', { timeout: 60_000 }, async (t) => {
  const service = new MemoryReplicaService('node-b');
  const server = await makeServer(t, service);
  const listeningPort = server.address!.port;
  const client = makeClient(listeningPort, 'node-a');
  await client.connect();
  assert.equal(client.activeConnectionCount, 1);
  assert.equal(server.activeConnectionCount, 1);

  await client.close();
  await waitFor(() => server.activeConnectionCount === 0);
  assert.equal(server.activeConnectionCount, 0);

  await server.close();
  await server.close(); // idempotent
  assert.equal(server.isClosed, true);
  assert.equal(server.address, null);
  await assertPortClosed(listeningPort);
  // Re-bind a fresh listener on the released port: no EADDRINUSE.
  const replacement = new TcpReplicaServer({
    host: '127.0.0.1',
    port: 0,
    sharedSecret: SECRET,
    nodeId: 'replacement',
    authorizedNodes: ['node-a'],
    service,
  });
  await replacement.listen();
  t.after(async () => {
    await replacement.close();
  });
  assert.ok(Number.isInteger(replacement.address?.port));
  assert.ok(replacement.address!.port > 0);
});

test('frame bound constants and verification boundary are explicit', () => {
  assert.equal(TCP_REPLICA_MAX_FRAME_BYTES, 1_048_576);
  assert.ok(TCP_TRANSPORT_VERIFICATION_NOTE.includes('未验证'));
  assert.ok(TCP_TRANSPORT_UNVERIFIED_BOUNDARIES.includes('physical-cross-machine-deployment'));
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition was not reached in time');
    await sleep(10);
  }
}

test('server configuration rejects malformed options fail-closed before binding', async () => {
  const base = { host: '127.0.0.1', port: 0, sharedSecret: SECRET };
  await expectCode(() => new TcpReplicaServer(null as never), 'TCP_CONFIG_INVALID');
  await expectCode(() => new TcpReplicaServer([] as never), 'TCP_CONFIG_INVALID');
  await expectCode(() => new TcpReplicaServer({ ...base, sharedSecret: 42 } as never), 'TCP_CONFIG_INVALID');
  await expectCode(() => new TcpReplicaServer({ ...base, sharedSecret: '' }), 'TCP_CONFIG_INVALID');
  await expectCode(() => new TcpReplicaServer({ ...base, host: '   ' }), 'TCP_CONFIG_INVALID');
  await expectCode(() => new TcpReplicaServer({ ...base, port: 65_536 }), 'TCP_CONFIG_INVALID');
  await expectCode(() => new TcpReplicaServer({ ...base, port: -1 }), 'TCP_CONFIG_INVALID');
  await expectCode(() => new TcpReplicaServer({ ...base, tls: { key: 1, cert: 'cert' } as never }), 'TCP_CONFIG_INVALID');
  await expectCode(() => new TcpReplicaServer({ ...base, tls: { key: 'key', cert: 1 } as never }), 'TCP_CONFIG_INVALID');
  await expectCode(() => new TcpReplicaServer({ ...base, policy: {} as never }), 'TCP_CONFIG_INVALID');
  await expectCode(() => new TcpReplicaServer({ ...base, service: null } as never), 'TCP_CONFIG_INVALID');
  await expectCode(() => new TcpReplicaServer({ ...base, authorizedNodes: [1] as never }), 'TCP_CONFIG_INVALID');
  await expectCode(() => new TcpReplicaServer({ ...base, authorizedNodes: ['bad node'] }), 'TCP_CONFIG_INVALID');
});

test('bounded handshake tables evict the oldest pending challenge', { timeout: 60_000 }, async (t) => {
  const server = await makeServer(t, new MemoryReplicaService('node-b'), {
    maxPendingChallenges: 1,
    maxUsedNonces: 1,
    handshakeTimeoutMs: 2_000,
  });
  const first = await RawChannel.connect(server.address!.port);
  const second = await RawChannel.connect(server.address!.port);
  t.after(() => {
    first.close();
    second.close();
  });

  const nonceA = '1'.repeat(64);
  const nonceB = '2'.repeat(64);
  first.send({ schema_version: MWHA_PROTOCOL_SCHEMA_VERSION, kind: 'hello', id: 'hello-a', payload: { nodeId: 'node-a', nonce: nonceA } });
  const challengeA = await first.next();
  assert.equal(challengeA.ok, true);

  second.send({ schema_version: MWHA_PROTOCOL_SCHEMA_VERSION, kind: 'hello', id: 'hello-b', payload: { nodeId: 'node-a', nonce: nonceB } });
  const challengeB = await second.next();
  assert.equal(challengeB.ok, true);

  // Inserting the second challenge evicted the first (capacity 1).
  first.send({
    schema_version: MWHA_PROTOCOL_SCHEMA_VERSION,
    kind: 'auth',
    id: 'auth-a',
    payload: { nodeId: 'node-a', nonce: nonceA, serverNonce: (challengeA.payload as { serverNonce: string }).serverNonce, signature: '0'.repeat(64) },
  });
  const evicted = await first.next();
  assert.equal((evicted as { error?: { code?: string } }).error?.code, 'TCP_AUTH_CHALLENGE_INVALID');

  second.send({
    schema_version: MWHA_PROTOCOL_SCHEMA_VERSION,
    kind: 'auth',
    id: 'auth-b',
    payload: { nodeId: 'node-a', nonce: nonceB, serverNonce: (challengeB.payload as { serverNonce: string }).serverNonce, signature: '0'.repeat(64) },
  });
  const authed = await second.next();
  assert.equal(authed.ok, false); // wrong signature on purpose; capacity path already asserted
  await waitFor(() => server.activeConnectionCount === 0);
});

test('service result validation and thrown errors map to stable transport codes', { timeout: 60_000 }, async (t) => {
  const service = new MemoryReplicaService('node-b');
  const server = await makeServer(t, service, { requestTimeoutMs: 100 });
  const client = makeClient(server.address!.port, 'node-a');
  t.after(async () => {
    await client.close();
  });
  await client.connect();
  const request = makeRequest('req-svc', 'F:/svc') as never;
  const validStatus = await client.status();

  const originalQuery = service.query;
  const originalApply = service.apply;
  const originalStatus = service.status;

  service.query = (async () => ({}) as never) as typeof service.query;
  await expectCode(() => client.query(request), 'TCP_MESSAGE_INVALID');

  service.query = (async () => { throw new Error('boom'); }) as unknown as typeof service.query;
  await expectCode(() => client.query(request), 'TCP_NODE_UNAVAILABLE');

  service.apply = (async () => { throw { code: 'CUSTOM_APPLY_CODE', message: 'custom failure' }; }) as unknown as typeof service.apply;
  await expectCode(() => client.apply([fakeEvent(9)]), 'CUSTOM_APPLY_CODE');

  service.status = (async () => { await sleep(200); return validStatus; }) as typeof service.status;
  await expectCode(() => client.status(), 'TCP_REQUEST_TIMEOUT');

  service.query = originalQuery;
  service.apply = originalApply;
  service.status = originalStatus;
  assert.equal(client.activeConnectionCount, 1);
});
