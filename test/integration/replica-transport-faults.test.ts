import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { AnchorProbeSnapshot } from '../../src/memory/probe-contract.ts';
import {
  ChildProcessReplicaTransport,
  ReplicaTransportError,
  type ReplicaHandle,
  type ReplicaStartOptions,
} from '../../src/memory/replica-transport.ts';

/**
 * T-144 / CV-02: parent-side transport fault injection.
 *
 * A deterministic fake `ChildProcess` covers every malformed-response, size,
 * cancellation, write-failure and stale-handle branch without touching the OS.
 * Only the paths that genuinely need a kernel process (init-time exit, the
 * SIGTERM -> SIGKILL escalation, real pid reaping) use temporary scripts.
 */

const SCOPE = 'fixture';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const SNAPSHOT: AnchorProbeSnapshot = {
  project_scope: SCOPE,
  ledger_digest: HASH_B,
  graph_revision: null,
  source_fingerprint: null,
  connected_digest: null,
};
const BASE_OPTIONS: ReplicaStartOptions = {
  root: '/fake/root',
  replicaId: 'replica-fake',
  projectScope: SCOPE,
  stopTimeoutMs: 30,
};

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

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// ---------------------------------------------------------------------------
// Fake child process
// ---------------------------------------------------------------------------

type FakeHandler = (request: { type: string; id: string; payload: unknown }) => unknown;

/** EventEmitter with the destroy/unref surface the transport expects from a stdio stream. */
class FakeStream extends EventEmitter {
  destroy(): void {
    // no OS handle behind a fake stream
  }
}

class FakeStdin extends FakeStream {
  private readonly child: FakeChild;

  constructor(child: FakeChild) {
    super();
    this.child = child;
  }

  write(chunk: Buffer | string): boolean {
    if (this.child.stdinWriteErrorValue !== null) {
      // The transport exercises both `Error` and bare-value write failures.
      throw this.child.stdinWriteErrorValue;
    }
    const text = chunk.toString('utf8');
    this.child.writes.push(text);
    const request = JSON.parse(text) as { type: string; id: string; payload: unknown };
    this.child.dispatch(request);
    return true;
  }
}

class FakeChild extends EventEmitter {
  readonly pid: number;
  readonly stdin: FakeStdin;
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  /** When set, the next `write` throws it (Error or bare value). */
  stdinWriteErrorValue: unknown = null;
  killedWith: NodeJS.Signals | null = null;
  exitCode: number | null = null;
  readonly writes: string[] = [];
  handler: FakeHandler | null = null;
  killBehavior: 'exit' | 'throwWhileExiting' | 'ignore' = 'exit';

  constructor(pid: number) {
    super();
    this.pid = pid;
    this.stdin = new FakeStdin(this);
  }

  dispatch(request: { type: string; id: string; payload: unknown }): void {
    if (this.handler !== null) {
      const response = this.handler(request);
      if (response !== null && response !== undefined) this.emitLine(response);
      return;
    }
    if (request.type === 'init' || request.type === 'status') {
      this.emitLine({ ok: true, id: request.id, type: request.type, payload: statusPayload() });
      return;
    }
    if (request.type === 'query') {
      this.emitLine({ ok: true, id: request.id, type: 'query', payload: queryPayload() });
      return;
    }
    if (request.type === 'apply') {
      this.emitLine({ ok: true, id: request.id, type: 'apply', payload: { report: reportPayload() } });
    }
  }

  kill(signal?: NodeJS.Signals): boolean {
    // Node's ChildProcess.kill() defaults to SIGTERM; mirror that observable.
    const effective = signal ?? 'SIGTERM';
    this.killedWith = effective;
    if (this.killBehavior === 'ignore') return false;
    if (this.killBehavior === 'throwWhileExiting') {
      // Emulate ESRCH: no handle left, but `kill` itself throws.
      this.emit('exit', null, effective);
      throw new Error('kill ESRCH');
    }
    this.emit('exit', null, effective);
    return true;
  }

  emitStdout(text: string): void {
    this.stdout.emit('data', Buffer.from(text, 'utf8'));
  }

  emitLine(value: unknown): void {
    this.emitStdout(`${JSON.stringify(value)}\n`);
  }

  unref(): void {
    // no OS handle behind a fake process
  }
}

let fakePidCounter = 400_000;

function makeHarness(handler?: FakeHandler): { readonly fn: typeof spawn; readonly children: FakeChild[] } {
  const children: FakeChild[] = [];
  const fn = ((_command: string, _args: readonly string[], _options?: unknown) => {
    const child = new FakeChild((fakePidCounter += 1));
    if (handler !== undefined) child.handler = handler;
    children.push(child);
    return child as unknown as ChildProcess;
  }) as unknown as typeof spawn;
  return { fn, children };
}

function breakNextWrite(child: FakeChild, error: unknown): void {
  child.stdinWriteErrorValue = error;
}

async function startFake(
  startOverrides: Partial<ReplicaStartOptions> = {},
  handler?: FakeHandler,
): Promise<{ transport: ChildProcessReplicaTransport; handle: ReplicaHandle; child: FakeChild }> {
  const harness = makeHarness(handler);
  const transport = new ChildProcessReplicaTransport();
  const handle = await transport.start({ ...BASE_OPTIONS, ...startOverrides, spawn: harness.fn });
  const child = harness.children.at(-1);
  assert.ok(child !== undefined, 'fake spawn must produce a child');
  return { transport, handle, child };
}

async function stopQuietly(transport: ChildProcessReplicaTransport, handle: ReplicaHandle | null): Promise<void> {
  if (handle === null) return;
  try {
    await transport.stop(handle);
  } catch {
    // already gone; leak assertions below are the authoritative check
  }
}

/**
 * `restart()` deliberately rebuilds its start options from the resolved entry
 * and therefore does not replay the test-only `spawn` seam. This subclass
 * re-injects a fake spawn for the restart's internal second `start`, keeping
 * the branch deterministic without launching a real worker.
 */
class RestartSeamTransport extends ChildProcessReplicaTransport {
  readonly firstSpawn: typeof spawn;
  readonly restartSpawn: typeof spawn;
  private startCount = 0;

  constructor(firstSpawn: typeof spawn, restartSpawn: typeof spawn) {
    super();
    this.firstSpawn = firstSpawn;
    this.restartSpawn = restartSpawn;
  }

  override async start(options: ReplicaStartOptions): Promise<ReplicaHandle> {
    this.startCount += 1;
    const spawn = this.startCount >= 2 ? this.restartSpawn : this.firstSpawn;
    return super.start({ ...options, spawn });
  }
}

// ---------------------------------------------------------------------------
// Valid protocol payloads
// ---------------------------------------------------------------------------

function clusterMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 'anchorprobe.cluster.v1',
    project_scope: SCOPE,
    cluster_epoch: 'epoch-1',
    commit_index: 0,
    replica_id: 'replica-fake',
    replica_commit_index: 0,
    consistency: 'local',
    max_lag: null,
    partial: false,
    failed_nodes: [],
    evidence_digest: HASH_A,
    ...overrides,
  };
}

function statusPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    replicaId: 'replica-fake',
    pid: 4321,
    alive: true,
    state: 'ACTIVE',
    commitIndex: 0,
    viewDigest: 'view-digest',
    evidenceDigest: 'evidence-digest',
    clusterMetadata: clusterMetadata(),
    snapshot: SNAPSHOT,
    cursor: { commitIndex: 0, lastEventId: null, lastEventHash: 'head', viewDigest: 'cursor-view' },
    ...overrides,
  };
}

function queryPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    candidates: [],
    edges: [],
    commitIndex: 0,
    viewDigest: 'view-digest',
    evidenceDigest: 'evidence-digest',
    state: 'ACTIVE',
    clusterEpoch: 'epoch-1',
    replicaId: 'replica-fake',
    snapshot: SNAPSHOT,
    ...overrides,
  };
}

function reportPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    applied: 0,
    duplicates: 0,
    outOfOrder: 0,
    gaps: [],
    corrupt: 0,
    commitIndex: 0,
    viewDigest: 'view-digest',
    complete: true,
    pendingCount: 0,
    ...overrides,
  };
}

function initResponder(): FakeHandler {
  return (request) => {
    if (request.type !== 'init') return null;
    return { ok: true, id: request.id, type: 'init', payload: statusPayload() };
  };
}

// ---------------------------------------------------------------------------
// Start-option validation
// ---------------------------------------------------------------------------

test('start rejects invalid option shapes before spawning a child', { timeout: 60_000 }, async () => {
  const invalid: ReadonlyArray<[unknown, string]> = [
    [null, 'null options'],
    [[], 'array options'],
    [{ root: '', replicaId: 'r', projectScope: 's' }, 'empty root'],
    [{ root: '/r', replicaId: '', projectScope: 's' }, 'empty replicaId'],
    [{ root: '/r', replicaId: 'x'.repeat(129), projectScope: 's' }, 'long replicaId'],
    [{ root: '/r', replicaId: 'r', projectScope: '' }, 'empty scope'],
    [{ root: '/r', replicaId: 'r', projectScope: 'x'.repeat(129) }, 'long scope'],
    [{ ...BASE_OPTIONS, startTimeoutMs: 0 }, 'zero start timeout'],
    [{ ...BASE_OPTIONS, nodeTimeoutMs: 1.5 }, 'fractional node timeout'],
    [{ ...BASE_OPTIONS, heartbeatMs: -1 }, 'negative heartbeat'],
    [{ ...BASE_OPTIONS, stopTimeoutMs: 0 }, 'zero stop timeout'],
    [{ ...BASE_OPTIONS, maxRequestBytes: 0 }, 'zero request bytes'],
    [{ ...BASE_OPTIONS, maxResponseBytes: 0 }, 'zero response bytes'],
  ];
  for (const [options, label] of invalid) {
    const transport = new ChildProcessReplicaTransport();
    await assert.rejects(
      () => transport.start(options as ReplicaStartOptions),
      (error: unknown) => error instanceof ReplicaTransportError && error.code === 'REPLICA_START_FAILED',
      label,
    );
  }
});

// ---------------------------------------------------------------------------
// Malformed child responses
// ---------------------------------------------------------------------------

test('malformed init payloads are refused with REPLICA_RESPONSE_INVALID', { timeout: 60_000 }, async () => {
  const cases: ReadonlyArray<[Record<string, unknown>, string]> = [
    [null as unknown as Record<string, unknown>, 'non-object payload'],
    [{ ...statusPayload(), replicaId: 7 }, 'missing replicaId/pid'],
    [{ ...statusPayload(), commitIndex: -1 }, 'negative commitIndex'],
    [{ ...statusPayload(), viewDigest: 7, evidenceDigest: 'e' }, 'bad digests'],
    [{ ...statusPayload(), state: 'BOGUS' }, 'unknown state'],
    [{ ...statusPayload(), clusterMetadata: {} }, 'bad cluster metadata'],
    [{ ...statusPayload(), cursor: undefined }, 'missing cursor'],
  ];
  for (const [payload, label] of cases) {
    const harness = makeHarness((request) => ({ ok: true, id: request.id, type: 'init', payload }));
    const transport = new ChildProcessReplicaTransport();
    await assert.rejects(
      () => transport.start({ ...BASE_OPTIONS, spawn: harness.fn }),
      (error: unknown) => error instanceof ReplicaTransportError && error.code === 'REPLICA_RESPONSE_INVALID',
      label,
    );
  }
});

test('malformed query payloads are refused with REPLICA_RESPONSE_INVALID', { timeout: 60_000 }, async (t) => {
  const cases: ReadonlyArray<[Record<string, unknown>, string]> = [
    [null as unknown as Record<string, unknown>, 'null payload'],
    [{ ...queryPayload(), candidates: 'nope' }, 'candidates not array'],
    [{ ...queryPayload(), candidates: [{ fact_key: 'x' }] }, 'malformed candidate'],
    [{ ...queryPayload(), edges: {} }, 'edges not array'],
    [{ ...queryPayload(), commitIndex: -1 }, 'negative commitIndex'],
    [{ ...queryPayload(), viewDigest: 7, evidenceDigest: 'e' }, 'bad digests'],
    [{ ...queryPayload(), state: 'BOGUS' }, 'unknown state'],
  ];
  for (const [payload, label] of cases) {
    const harness = makeHarness((request) => {
      if (request.type === 'init') return { ok: true, id: request.id, type: 'init', payload: statusPayload() };
      return { ok: true, id: request.id, type: 'query', payload };
    });
    const transport = new ChildProcessReplicaTransport();
    const handle = await transport.start({ ...BASE_OPTIONS, spawn: harness.fn });
    t.after(async () => {
      await stopQuietly(transport, handle);
    });
    await assert.rejects(
      () => transport.query(handle, { schema_version: 'anchorprobe.request.v1' } as never),
      (error: unknown) => error instanceof ReplicaTransportError && error.code === 'REPLICA_RESPONSE_INVALID',
      label,
    );
  }
});

test('malformed apply payloads are refused with REPLICA_RESPONSE_INVALID', { timeout: 60_000 }, async (t) => {
  const cases: ReadonlyArray<[Record<string, unknown>, string]> = [
    [null as unknown as Record<string, unknown>, 'null payload'],
    [{ report: null }, 'null report'],
    [{ report: reportPayload({ applied: 'x' }) }, 'non-numeric report field'],
    [{ report: reportPayload({ gaps: 'x', complete: 3 }) }, 'bad report shape'],
  ];
  for (const [payload, label] of cases) {
    const harness = makeHarness((request) => {
      if (request.type === 'init') return { ok: true, id: request.id, type: 'init', payload: statusPayload() };
      return { ok: true, id: request.id, type: 'apply', payload };
    });
    const transport = new ChildProcessReplicaTransport();
    const handle = await transport.start({ ...BASE_OPTIONS, spawn: harness.fn });
    t.after(async () => {
      await stopQuietly(transport, handle);
    });
    await assert.rejects(
      () => transport.apply(handle, []),
      (error: unknown) => error instanceof ReplicaTransportError && error.code === 'REPLICA_RESPONSE_INVALID',
      label,
    );
  }
});

test('a response type that does not match the request is refused', { timeout: 60_000 }, async (t) => {
  const harness = makeHarness((request) => {
    if (request.type === 'init') return { ok: true, id: request.id, type: 'init', payload: statusPayload() };
    return { ok: true, id: request.id, type: 'status', payload: statusPayload() };
  });
  const transport = new ChildProcessReplicaTransport();
  const handle = await transport.start({ ...BASE_OPTIONS, spawn: harness.fn });
  t.after(async () => {
    await stopQuietly(transport, handle);
  });
  await assert.rejects(
    () => transport.query(handle, { schema_version: 'anchorprobe.request.v1' } as never),
    (error: unknown) => error instanceof ReplicaTransportError && error.code === 'REPLICA_RESPONSE_INVALID',
  );
});

test('an ok=false child frame fails the request with the child error code', { timeout: 60_000 }, async (t) => {
  const harness = makeHarness((request) => {
    if (request.type === 'init') return { ok: true, id: request.id, type: 'init', payload: statusPayload() };
    return { ok: false, id: request.id, error: { code: 'REPLICA_INTERNAL_ERROR', message: 'boom' } };
  });
  const transport = new ChildProcessReplicaTransport();
  const handle = await transport.start({ ...BASE_OPTIONS, spawn: harness.fn });
  t.after(async () => {
    await stopQuietly(transport, handle);
  });
  await assert.rejects(
    () => transport.query(handle, { schema_version: 'anchorprobe.request.v1' } as never),
    (error: unknown) => error instanceof ReplicaTransportError && error.code === 'REPLICA_INTERNAL_ERROR',
  );
});

test('a routable-but-unparseable line fails the oldest pending request', { timeout: 60_000 }, async (t) => {
  const harness = makeHarness((request) => {
    if (request.type === 'init') return { ok: true, id: request.id, type: 'init', payload: statusPayload() };
    return null; // never answer queries
  });
  const transport = new ChildProcessReplicaTransport();
  const handle = await transport.start({ ...BASE_OPTIONS, spawn: harness.fn });
  const child = harness.children.at(-1)!;
  t.after(async () => {
    await stopQuietly(transport, handle);
  });

  const pending = transport.query(handle, { schema_version: 'anchorprobe.request.v1' } as never);
  child.emitStdout('this is not a protocol line\n');
  await assert.rejects(
    () => pending,
    (error: unknown) => error instanceof ReplicaTransportError && error.code === 'REPLICA_RESPONSE_INVALID',
  );

  // With no pending request the same stray line is ignored, not fatal.
  child.emitStdout('still not protocol\n');
});

// ---------------------------------------------------------------------------
// Timing, cancellation, write failure
// ---------------------------------------------------------------------------

test('a request that outlives its budget fails with REPLICA_QUERY_TIMEOUT and cleans up', { timeout: 60_000 }, async (t) => {
  const harness = makeHarness(initResponder());
  const transport = new ChildProcessReplicaTransport();
  const handle = await transport.start({ ...BASE_OPTIONS, spawn: harness.fn });
  t.after(async () => {
    await stopQuietly(transport, handle);
  });
  const started = Date.now();
  await assert.rejects(
    () => transport.query(handle, { schema_version: 'anchorprobe.request.v1' } as never, { nodeTimeoutMs: 20 }),
    (error: unknown) => error instanceof ReplicaTransportError && error.code === 'REPLICA_QUERY_TIMEOUT',
  );
  assert.ok(Date.now() - started < 1_000, 'timeout must fire near its 20ms budget');
  assert.equal(transport.stderrOf(handle), '');
});

test('a pre-aborted signal is refused before dispatch', { timeout: 60_000 }, async (t) => {
  const { transport, handle, child } = await startFake({}, initResponder());
  t.after(async () => {
    await stopQuietly(transport, handle);
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => transport.apply(handle, [], { signal: controller.signal }),
    (error: unknown) => error instanceof ReplicaTransportError && error.code === 'REPLICA_QUERY_CANCELLED',
  );
  assert.equal(child.writes.some((line) => line.includes('"apply"')), false, 'no byte may reach the child');
});

test('a stdin write failure fails the request instead of crashing the transport', { timeout: 60_000 }, async (t) => {
  for (const failure of [new Error('write EPIPE'), 'bare write failure']) {
    const { transport, handle, child } = await startFake({}, initResponder());
    t.after(async () => {
      await stopQuietly(transport, handle);
    });
    breakNextWrite(child, failure);
    await assert.rejects(
      () => transport.query(handle, { schema_version: 'anchorprobe.request.v1' } as never),
      (error: unknown) => error instanceof ReplicaTransportError && error.code === 'REPLICA_REQUEST_FAILED',
    );
  }
});

test('child error events are captured in the stderr tail exposed by the diagnostic getter', { timeout: 60_000 }, async (t) => {
  const { transport, handle, child } = await startFake({}, initResponder());
  t.after(async () => {
    await stopQuietly(transport, handle);
  });
  child.emit('error', new Error('spawn boom'));
  child.stdin.emit('error', new Error('stdin EPIPE'));
  assert.match(transport.stderrOf(handle), /spawn boom/);
  assert.match(transport.stderrOf(handle), /stdin EPIPE/);
  assert.equal(transport.stderrOf({ replicaId: 'foreign', pid: null, kind: 'child-process' }), '');
});

test('an oversized inbound stream fails pending requests and the discard state recovers', { timeout: 60_000 }, async (t) => {
  const answering: FakeHandler = (request) => {
    if (request.type === 'init' || request.type === 'status') {
      return { ok: true, id: request.id, type: request.type, payload: statusPayload() };
    }
    return null; // leave queries unanswered so the fault can be injected
  };
  const { transport, handle, child } = await startFake({ maxResponseBytes: 4_096 }, answering);
  t.after(async () => {
    await stopQuietly(transport, handle);
  });
  const first = transport.query(handle, { schema_version: 'anchorprobe.request.v1' } as never);
  child.emitStdout('x'.repeat(5_000)); // no newline: tail limit path
  await assert.rejects(
    () => first,
    (error: unknown) => error instanceof ReplicaTransportError && error.code === 'REPLICA_RESPONSE_TOO_LARGE',
  );

  const second = transport.query(handle, { schema_version: 'anchorprobe.request.v1' } as never);
  child.emitStdout('\n'); // discarding reset
  child.emitStdout(`${'y'.repeat(5_000)}\n`); // complete line over the limit
  await assert.rejects(
    () => second,
    (error: unknown) => error instanceof ReplicaTransportError && error.code === 'REPLICA_RESPONSE_TOO_LARGE',
  );

  // Recovered: a normal status round trip answers.
  const status = await transport.status(handle);
  assert.equal(status.replicaId, 'replica-fake');
});

// ---------------------------------------------------------------------------
// Exit, restart, kill
// ---------------------------------------------------------------------------

test('a pending request is failed when the child exits underneath it', { timeout: 60_000 }, async (t) => {
  const { transport, handle, child } = await startFake({}, initResponder());
  t.after(async () => {
    await stopQuietly(transport, handle);
  });
  const pending = transport.query(handle, { schema_version: 'anchorprobe.request.v1' } as never);
  child.emit('exit', null, 'SIGKILL');
  await assert.rejects(
    () => pending,
    (error: unknown) => error instanceof ReplicaTransportError && error.code === 'REPLICA_NODE_EXITED',
  );
  assert.equal(transport.isAlive(handle), false);
});

test('restart reports a replacement that dies immediately', { timeout: 60_000 }, async () => {
  const firstHarness = makeHarness((request) => ({
    ok: true,
    id: request.id,
    type: request.type,
    payload: statusPayload({ commitIndex: 5 }),
  }));
  const restartHarness = makeHarness((request) => {
    const replacement = restartHarness.children.at(-1)!;
    if (request.type === 'init') {
      // Run after the init response has settled but before start() resumes.
      queueMicrotask(() => replacement.emit('exit', null, 'SIGKILL'));
    }
    return { ok: true, id: request.id, type: request.type, payload: statusPayload({ commitIndex: 5 }) };
  });
  const transport = new RestartSeamTransport(firstHarness.fn, restartHarness.fn);
  const handle = await transport.start({ ...BASE_OPTIONS });
  await assert.rejects(
    () => transport.restart(handle),
    (error: unknown) => error instanceof ReplicaTransportError && error.code === 'REPLICA_RESTART_FAILED',
  );
});

test('restart refuses a worker that resumed behind the previous cursor', { timeout: 60_000 }, async () => {
  const firstHarness = makeHarness((request) => ({
    ok: true,
    id: request.id,
    type: request.type,
    payload: statusPayload({ commitIndex: 5 }),
  }));
  const restartHarness = makeHarness((request) => ({
    ok: true,
    id: request.id,
    type: request.type,
    payload: statusPayload({ commitIndex: 3 }),
  }));
  const transport = new RestartSeamTransport(firstHarness.fn, restartHarness.fn);
  const handle = await transport.start({ ...BASE_OPTIONS });
  await assert.rejects(
    () => transport.restart(handle),
    (error: unknown) => error instanceof ReplicaTransportError && error.code === 'REPLICA_RESTART_INCOMPLETE',
  );
});

test('a start whose stdin write fails runs the kill cleanup and safeKill swallows ESRCH', { timeout: 60_000 }, async () => {
  for (const failure of [new Error('write EPIPE'), 'bare write failure']) {
    const child = new FakeChild((fakePidCounter += 1));
    breakNextWrite(child, failure);
    child.killBehavior = 'throwWhileExiting';
    const fn = (() => child as unknown as ChildProcess) as unknown as typeof spawn;
    const transport = new ChildProcessReplicaTransport();
    await assert.rejects(
      () => transport.start({ ...BASE_OPTIONS, spawn: fn }),
      (error: unknown) => error instanceof ReplicaTransportError && error.code === 'REPLICA_REQUEST_FAILED',
    );
  }
});

test('a shutdown write failure falls back to terminating the child', { timeout: 60_000 }, async (t) => {
  const { transport, handle, child } = await startFake({}, initResponder());
  t.after(async () => {
    await stopQuietly(transport, handle);
  });
  breakNextWrite(child, new Error('shutdown EPIPE'));
  await transport.stop(handle);
  assert.equal(transport.isAlive(handle), false);
  assert.equal(child.killedWith, 'SIGTERM');
});

// ---------------------------------------------------------------------------
// Real subprocesses: init-time exit and SIGTERM -> SIGKILL escalation
// ---------------------------------------------------------------------------

async function tempScript(t: TestContext, name: string, body: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ano transport fault '));
  t.after(async () => {
    await delay(20);
    await rm(directory, { recursive: true, force: true });
  });
  const file = join(directory, name);
  await writeFile(file, body, 'utf8');
  return file;
}

test('a worker that exits during init fails with REPLICA_START_FAILED and its stderr', { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ano transport root '));
  t.after(async () => {
    await delay(20);
    await rm(root, { recursive: true, force: true });
  });
  const workerPath = await tempScript(t, 'exit-worker.mjs', "process.stderr.write('worker exploded\\n');\nprocess.exit(1);\n");
  const transport = new ChildProcessReplicaTransport();
  await assert.rejects(
    () => transport.start({ ...BASE_OPTIONS, root, workerPath, startTimeoutMs: 2_000 }),
    (error: unknown) => error instanceof ReplicaTransportError
      && error.code === 'REPLICA_START_FAILED'
      && error.message.includes('worker exploded'),
  );
});

test('a worker that ignores shutdown is SIGTERM-ed then SIGKILL-ed and leaves no process', { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ano transport root '));
  t.after(async () => {
    await delay(20);
    await rm(root, { recursive: true, force: true });
  });
  const payload = JSON.stringify(statusPayload());
  const workerPath = await tempScript(t, 'stubborn-worker.mjs', `
    import readline from 'node:readline';
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      try {
        const request = JSON.parse(line);
        if (request.type === 'init') {
          process.stdout.write(JSON.stringify({ ok: true, id: request.id, type: 'init', payload: ${payload} }) + '\\n');
        }
      } catch {}
    });
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1_000);
  `);
  const transport = new ChildProcessReplicaTransport();
  const handle = await transport.start({ ...BASE_OPTIONS, root, workerPath, startTimeoutMs: 5_000 });
  const pid = handle.pid as number;
  assert.ok(processExists(pid));
  await transport.stop(handle);
  await waitFor(() => processExists(pid) === false, 500, 'stubborn worker pid to be reaped');
  assert.equal(processExists(pid), false, 'stubborn worker must not survive stop()');
  await transport.stop(handle);
});
