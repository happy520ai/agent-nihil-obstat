import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ANCHOR_PROBE_REQUEST_SCHEMA_VERSION,
  type AnchorProbeRequest,
  type AnchorProbeSnapshot,
} from '../../src/memory/probe-contract.ts';
import type { ProbeCandidate, ProbeEdge } from '../../src/memory/probe.ts';
import {
  probeSnapshotIdentity,
  type ProbeEvidencePayload,
  type ProbeProvenanceView,
  type ProbeStatusView,
  type ProbeStore,
} from '../../src/memory/probe-store.ts';
import { distributedProbe } from '../../src/memory/distributed-probe.ts';
import { ChildProcessReplicaTransport, type ReplicaHandle } from '../../src/memory/replica-transport.ts';
import { installProcessCleanup, ResourceRegistry } from '../../src/memory/resource-lifecycle.ts';
import {
  TcpReplicaClient,
  TcpReplicaServer,
  type TcpReplicaService,
  type TcpReplicaServiceContext,
} from '../../src/memory/tcp-transport.ts';

/**
 * T-159 / MNT-03: one registry aggregates the transport, server and client
 * watermarks. Normal work, cancellation, a crashed child and repeated close
 * must all leave pendingRequests/openSockets/liveChildren/activeTimers at zero.
 * Scope: local process/socket/TCP only.
 */

const SCOPE = 'fixture';
const HASH = 'a'.repeat(64);
const SECRET = 'e'.repeat(64);
const TIMEOUT_MS = 60_000;

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

function snapshot(): AnchorProbeSnapshot {
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

class LocalStore implements ProbeStore {
  readonly snapshot: AnchorProbeSnapshot = snapshot();

  candidates(): readonly ProbeCandidate[] {
    return [];
  }

  adjacency(): readonly ProbeEdge[] {
    return [];
  }

  evidence(_recordRef: string): ProbeEvidencePayload | undefined {
    return undefined;
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
}

test('IPC watermarks return to zero through normal, cancel, crash and repeated close', { timeout: TIMEOUT_MS }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ano resource ipc '));
  const registry = new ResourceRegistry();
  const transport = new ChildProcessReplicaTransport();
  let handle: ReplicaHandle | null = null;
  t.after(async () => {
    try {
      await registry.close();
    } catch {
      // assertions below already pin the expected behaviour
    }
    await rm(root, { recursive: true, force: true });
  });
  handle = await transport.start({
    root,
    replicaId: 'replica-resource',
    projectScope: SCOPE,
    clusterEpoch: 'epoch-1',
    snapshot: snapshot(),
  });
  registry.register(transport);
  registry.registerCleanup(() => transport.stop(handle as ReplicaHandle));

  await transport.status(handle);
  assert.equal(registry.snapshot().liveChildren, 1);
  assert.equal(registry.snapshot().pendingRequests, 0);

  const controller = new AbortController();
  const cancelled = transport.query(handle, probeRequest('resource-cancel'), { signal: controller.signal });
  controller.abort();
  assert.equal(codeOf(await cancelled.then(() => undefined, (error: unknown) => error)), 'REPLICA_QUERY_CANCELLED');
  await waitFor(() => registry.snapshot().activeTimers === 0, 2_000, 'cancel timer release');
  assert.equal(registry.snapshot().pendingRequests, 0);

  const pid = handle.pid as number;
  assert.equal(process.kill(pid, 'SIGKILL'), true);
  await waitFor(() => transport.isAlive(handle as ReplicaHandle) === false, 3_000, 'crash detection');
  await waitFor(() => registry.snapshot().liveChildren === 0, 2_000, 'child reaping');
  assert.equal(registry.snapshot().pendingRequests, 0);
  assert.equal(registry.snapshot().activeTimers, 0);

  await registry.close();
  await registry.close();
  assert.equal(registry.closed, true);
  assert.deepEqual(registry.snapshot(), {
    pendingRequests: 0,
    openSockets: 0,
    liveChildren: 0,
    activeTimers: 0,
  });
});

class GatedService implements TcpReplicaService {
  started = false;

  async query(_request: AnchorProbeRequest, context: TcpReplicaServiceContext): Promise<{
    candidates: readonly ProbeCandidate[];
    edges: readonly ProbeEdge[];
    commitIndex: number;
  }> {
    this.started = true;
    await new Promise<void>((resolve) => {
      if (context.signal?.aborted === true) resolve();
      else context.signal?.addEventListener('abort', () => resolve(), { once: true });
    });
    return { candidates: [], edges: [], commitIndex: 0 };
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
      replicaId: 'tcp-resource',
      commitIndex: 0,
      viewDigest: HASH,
      evidenceDigest: HASH,
      state: 'ACTIVE',
      snapshot: snapshot(),
      clusterEpoch: 'epoch-1',
      projectScope: SCOPE,
    };
  }
}

test('TCP client and server watermarks return to zero after a cancelled query and close', { timeout: TIMEOUT_MS }, async (t) => {
  const service = new GatedService();
  const server = new TcpReplicaServer({
    host: '127.0.0.1',
    port: 0,
    sharedSecret: SECRET,
    nodeId: 'tcp-resource',
    authorizedNodes: ['node-a'],
    service,
  });
  const address = await server.listen();
  const client = new TcpReplicaClient({
    host: '127.0.0.1',
    port: address.port,
    nodeId: 'node-a',
    sharedSecret: SECRET,
  });
  await client.connect();
  const registry = new ResourceRegistry();
  registry.register(server);
  registry.register(client);
  registry.registerCleanup(() => server.close());
  registry.registerCleanup(() => client.close());
  t.after(async () => {
    await registry.close();
  });

  await client.status();
  // One socket on the client side and one accepted socket on the server side.
  assert.equal(registry.snapshot().openSockets, 2);
  assert.equal(registry.snapshot().pendingRequests, 0);

  const controller = new AbortController();
  const query = client.query(probeRequest('tcp-resource-cancel'), { signal: controller.signal, timeoutMs: 5_000 });
  await waitFor(() => service.started, 2_000, 'service entry');
  controller.abort();
  assert.equal(codeOf(await query.then(() => undefined, (error: unknown) => error)), 'TCP_REQUEST_CANCELLED');
  await waitFor(() => registry.snapshot().pendingRequests === 0, 2_000, 'server in-flight release');
  // The server legitimately keeps an idle timer per open socket; the client's
  // request/cancel timers must be gone.
  await waitFor(() => client.resourceWatermarks().activeTimers === 0, 2_000, 'client cancel ack timer release');

  await registry.close();
  await registry.close();
  assert.deepEqual(registry.snapshot(), {
    pendingRequests: 0,
    openSockets: 0,
    liveChildren: 0,
    activeTimers: 0,
  });
  assert.equal(server.activeConnectionCount, 0);
});

test('resources_released is a per-answer flag and never proves cluster shutdown', async (t) => {
  const registry = new ResourceRegistry();
  registry.register({ resourceWatermarks: () => ({ liveChildren: 1 }) });
  t.after(async () => {
    await registry.close();
  });
  const answer = await distributedProbe(probeRequest('resource-local'), new LocalStore(), []);
  assert.equal(answer.resources_released, true);
  assert.equal(registry.closed, false);
  assert.equal(registry.snapshot().liveChildren, 1);
});

test('the real process installer adds and removes its handlers without sending a signal', () => {
  const registry = new ResourceRegistry();
  const beforeInt = process.listenerCount('SIGINT');
  const beforeTerm = process.listenerCount('SIGTERM');
  const dispose = installProcessCleanup(registry);
  assert.equal(process.listenerCount('SIGINT'), beforeInt + 1);
  assert.equal(process.listenerCount('SIGTERM'), beforeTerm + 1);
  dispose();
  assert.equal(process.listenerCount('SIGINT'), beforeInt);
  assert.equal(process.listenerCount('SIGTERM'), beforeTerm);
  assert.equal(registry.closed, false);
});
