import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  ANCHOR_PROBE_CLUSTER_SCHEMA_VERSION,
  ANCHOR_PROBE_REQUEST_SCHEMA_VERSION,
  type AnchorProbeClusterMetadata,
  type AnchorProbeRequest,
  type AnchorProbeSnapshot,
} from '../../src/memory/probe-contract.ts';
import type { ProbeCandidate, ProbeEdge } from '../../src/memory/probe.ts';
import {
  ChildProcessReplicaTransport,
  ReplicaTransportError,
  type ReplicaHandle,
} from '../../src/memory/replica-transport.ts';
import {
  TcpReplicaClient,
  TcpReplicaServer,
  type TcpReplicaService,
  type TcpReplicaServiceContext,
} from '../../src/memory/tcp-transport.ts';

/**
 * T-158 / MNT-02: requestId cancellation across the IPC worker and real TCP.
 *
 * Verified here:
 * - aborting a query rejects with REPLICA_QUERY_CANCELLED / TCP_REQUEST_CANCELLED
 *   and never delivers a late success;
 * - the peer observes the cancellation (worker cancel ack, TCP service signal);
 * - repeated cancel is idempotent and the connection/child stays usable;
 * - a non-cooperative IPC worker is terminated only after the cancellation is
 *   the last outstanding request, and watermarks return to zero.
 *
 * Scope: local loopback TCP and local child processes only; no cross-machine
 * claim is made.
 */

const SCOPE = 'fixture';
const HASH = 'a'.repeat(64);
const SECRET = 'f'.repeat(64);
const PROCESS_TEST_TIMEOUT_MS = 60_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail(`timed out waiting for ${label}`);
}

function clusterMetadata(replicaId: string): AnchorProbeClusterMetadata {
  return {
    schema_version: ANCHOR_PROBE_CLUSTER_SCHEMA_VERSION,
    project_scope: SCOPE,
    cluster_epoch: 'epoch-1',
    commit_index: 0,
    replica_id: replicaId,
    replica_commit_index: 0,
    consistency: 'local',
    max_lag: null,
    partial: false,
    failed_nodes: [],
    evidence_digest: HASH,
  };
}

function snapshot(_replicaId: string): AnchorProbeSnapshot {
  // `init` takes the base AP-02 snapshot; the worker rejects cluster metadata
  // there because it derives that itself.
  return {
    project_scope: SCOPE,
    ledger_digest: HASH,
    graph_revision: null,
    source_fingerprint: null,
    connected_digest: null,
  };
}

function probeRequest(requestId: string): AnchorProbeRequest {
  return {
    schema_version: ANCHOR_PROBE_REQUEST_SCHEMA_VERSION,
    request_id: requestId,
    root: 'F:/project',
    project_scope: SCOPE,
    required_facts: ['local.storage.engine'],
  } as AnchorProbeRequest;
}

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function candidate(recordRef: string): ProbeCandidate {
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
    content_hash: HASH,
    recorded_at: '2026-11-25T00:00:00.000Z',
    effective_from: null,
    effective_to: null,
    superseded_by: null,
    version: null,
    anchor: { status: 'none', file: null },
    qualifiers: [],
  };
}

// ---------------------------------------------------------------------------
// IPC worker cancellation
// ---------------------------------------------------------------------------

test('an aborted IPC query rejects, the worker stays usable and watermarks return to zero', { timeout: PROCESS_TEST_TIMEOUT_MS }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ano cancel ipc '));
  const transport = new ChildProcessReplicaTransport();
  let handle: ReplicaHandle | null = null;
  t.after(async () => {
    if (handle !== null) {
      try {
        await transport.stop(handle);
      } catch {
        // already dead
      }
    }
    await rm(root, { recursive: true, force: true });
  });
  handle = await transport.start({
    root,
    replicaId: 'replica-cancel',
    projectScope: SCOPE,
    clusterEpoch: 'epoch-1',
    snapshot: snapshot('replica-cancel'),
  });

  const controller = new AbortController();
  const query = transport.query(handle, probeRequest('ipc-cancel-1'), { signal: controller.signal });
  controller.abort();
  controller.abort();
  const error = await query.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  assert.ok(error instanceof ReplicaTransportError);
  assert.equal(error.code, 'REPLICA_QUERY_CANCELLED');

  // The cancel ack releases its grace timer; the worker is not killed because
  // the cancel was cooperative.
  await waitFor(() => transport.resourceWatermarks().activeTimers === 0, 2_000, 'cancel ack timer release');
  assert.equal(transport.resourceWatermarks().pendingRequests, 0);
  assert.equal(transport.isAlive(handle), true);
  const status = await transport.status(handle);
  assert.equal(status.replicaId, 'replica-cancel');
  assert.equal(transport.resourceWatermarks().pendingRequests, 0);
});

test('a deaf IPC worker is terminated only after its cancelled request was the last one', { timeout: PROCESS_TEST_TIMEOUT_MS }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ano cancel deaf '));
  const statusPayload = {
    replicaId: 'replica-deaf',
    pid: process.pid,
    commitIndex: 0,
    viewDigest: HASH,
    evidenceDigest: HASH,
    state: 'ACTIVE',
    clusterMetadata: clusterMetadata('replica-deaf'),
    cursor: { commitIndex: 0, lastEventId: null, lastEventHash: '', viewDigest: HASH },
    snapshot: snapshot('replica-deaf'),
  };
  const deafWorker = join(root, 'deaf-worker.mjs');
  await writeFile(deafWorker, `
    import { createInterface } from 'node:readline';
    const status = JSON.parse(process.env.ANO_DEAF_STATUS);
    const rl = createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      const request = JSON.parse(line);
      if (request.type === 'init' || request.type === 'status') {
        process.stdout.write(JSON.stringify({ ok: true, id: request.id, type: request.type, payload: status }) + '\\n');
      }
      // 'query' and 'cancel' are deliberately ignored: the worker never
      // cooperates, so only the transport's bounded termination can release it.
      if (request.type === 'shutdown') process.exit(0);
    });
    setInterval(() => {}, 1000);
  `, 'utf8');
  const transport = new ChildProcessReplicaTransport();
  let handle: ReplicaHandle | null = null;
  t.after(async () => {
    if (handle !== null) {
      try {
        await transport.stop(handle);
      } catch {
        // already killed
      }
    }
    await rm(root, { recursive: true, force: true });
  });
  handle = await transport.start({
    root,
    replicaId: 'replica-deaf',
    projectScope: SCOPE,
    clusterEpoch: 'epoch-1',
    snapshot: snapshot('replica-deaf'),
    cancelGraceMs: 40,
    spawn: ((_command: string, _args: readonly string[], options: Parameters<typeof spawn>[2]) =>
      spawn(process.execPath, [deafWorker], {
        ...(options ?? {}),
        env: { ...process.env, ANO_DEAF_STATUS: JSON.stringify(statusPayload) },
      })) as typeof spawn,
  });
  assert.equal(transport.isAlive(handle), true);

  // A timeout is an abandonment too: the transport must send the same cancel
  // frame, and an unacknowledged cancel may release the (now idle) child.
  const query = transport.query(handle, probeRequest('ipc-deaf-1'), { nodeTimeoutMs: 40 });
  const error = await query.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  assert.ok(error instanceof ReplicaTransportError);
  assert.equal(error.code, 'REPLICA_QUERY_TIMEOUT');

  // One outstanding cancel, no other pending request: the unacknowledged
  // cancellation may terminate the child after the grace window.
  await waitFor(() => transport.isAlive(handle as ReplicaHandle) === false, 3_000, 'deaf worker termination');
  await waitFor(() => transport.resourceWatermarks().liveChildren === 0, 2_000, 'child watermark');
  assert.equal(transport.resourceWatermarks().pendingRequests, 0);
  assert.equal(transport.resourceWatermarks().activeTimers, 0);
});

// ---------------------------------------------------------------------------
// TCP cancellation
// ---------------------------------------------------------------------------

class GatedService implements TcpReplicaService {
  started = false;
  observedAbort = false;
  resolvedAfterAbort = false;
  cooperative = true;
  readonly #gate: Promise<void>;
  #release: () => void = () => undefined;

  constructor() {
    this.#gate = new Promise<void>((resolve) => {
      this.#release = resolve;
    });
  }

  release(): void {
    this.#release();
  }

  async query(_request: AnchorProbeRequest, context: TcpReplicaServiceContext): Promise<{
    candidates: readonly ProbeCandidate[];
    edges: readonly ProbeEdge[];
    commitIndex: number;
  }> {
    this.started = true;
    if (this.cooperative) {
      await new Promise<void>((resolve) => {
        const onAbort = (): void => {
          this.observedAbort = true;
          resolve();
        };
        if (context.signal?.aborted === true) onAbort();
        else context.signal?.addEventListener('abort', onAbort, { once: true });
      });
    } else {
      await this.#gate;
    }
    if (context.signal?.aborted === true) this.resolvedAfterAbort = true;
    return { candidates: [candidate('rec-cancelled')], edges: [], commitIndex: 0 };
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
      replicaId: 'tcp-cancel',
      commitIndex: 0,
      viewDigest: HASH,
      evidenceDigest: HASH,
      state: 'ACTIVE',
      snapshot: snapshot('tcp-cancel'),
      clusterEpoch: 'epoch-1',
      projectScope: SCOPE,
    };
  }
}

async function startServer(t: TestContext, service: TcpReplicaService): Promise<{ server: TcpReplicaServer; port: number }> {
  const server = new TcpReplicaServer({
    host: '127.0.0.1',
    port: 0,
    sharedSecret: SECRET,
    nodeId: 'tcp-cancel',
    authorizedNodes: ['node-a'],
    service,
  });
  const address = await server.listen();
  t.after(async () => {
    await server.close();
  });
  return { server, port: address.port };
}

function clientFor(port: number, extra: Record<string, unknown> = {}): TcpReplicaClient {
  return new TcpReplicaClient({
    host: '127.0.0.1',
    port,
    nodeId: 'node-a',
    sharedSecret: SECRET,
    ...extra,
  });
}

test('TCP cancellation aborts the service, rejects the caller and keeps the connection usable', { timeout: PROCESS_TEST_TIMEOUT_MS }, async (t) => {
  const service = new GatedService();
  const { port } = await startServer(t, service);
  const client = clientFor(port, { cancelGraceMs: 100 });
  t.after(async () => {
    await client.close();
  });
  await client.connect();

  const controller = new AbortController();
  const query = client.query(probeRequest('tcp-cancel-1'), { signal: controller.signal, timeoutMs: 5_000 });
  await waitFor(() => service.started, 2_000, 'service entry');
  controller.abort();
  controller.abort();
  const error = await query.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  assert.equal(codeOf(error), 'TCP_REQUEST_CANCELLED');
  await waitFor(() => service.observedAbort, 2_000, 'cooperative abort');
  await waitFor(() => client.resourceWatermarks().pendingRequests === 0, 2_000, 'pending release');
  await waitFor(() => client.resourceWatermarks().activeTimers === 0, 2_000, 'cancel ack timer release');

  // Repeated cancel and a subsequent request prove the connection survived.
  const status = await client.status();
  assert.equal(status.replicaId, 'tcp-cancel');
  assert.equal(client.resourceWatermarks().pendingRequests, 0);
});

test('a non-cooperative TCP handler never delivers a late success after cancellation', { timeout: PROCESS_TEST_TIMEOUT_MS }, async (t) => {
  const service = new GatedService();
  service.cooperative = false;
  const { port } = await startServer(t, service);
  const client = clientFor(port, { cancelGraceMs: 100 });
  t.after(async () => {
    await client.close();
  });
  await client.connect();

  const controller = new AbortController();
  let resolved = false;
  const query = client.query(probeRequest('tcp-cancel-2'), { signal: controller.signal, timeoutMs: 5_000 })
    .then((value) => {
      resolved = true;
      return value;
    });
  await waitFor(() => service.started, 2_000, 'service entry');
  // A live request owns one request timer (watermark observable).
  assert.ok(client.resourceWatermarks().activeTimers >= 1);
  controller.abort();
  const error = await query.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  assert.equal(codeOf(error), 'TCP_REQUEST_CANCELLED');
  // Wait for the peer's cancel ack before releasing the handler: otherwise the
  // handler could finish before the cancel frame is even read, which would be a
  // different (and still valid) interleaving.
  await waitFor(() => client.resourceWatermarks().activeTimers === 0, 2_000, 'cancel ack');

  // The handler ignores the signal and finishes later; the client must not
  // turn that into a success, and the server must refuse to emit it as one.
  service.release();
  await delay(200);
  assert.equal(resolved, false);
  assert.equal(service.resolvedAfterAbort, true, 'the handler did observe the abort before answering');
  const status = await client.status();
  assert.equal(status.replicaId, 'tcp-cancel');
  await waitFor(() => client.resourceWatermarks().activeTimers === 0, 2_000, 'no cancel timer survives');
});
