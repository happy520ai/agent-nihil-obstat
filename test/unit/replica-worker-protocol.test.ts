import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PassThrough, Writable } from 'node:stream';
import test, { type TestContext } from 'node:test';
import {
  REPLICA_WORKER_MAX_ARRAY_LENGTH,
  REPLICA_WORKER_MAX_NESTING_DEPTH,
  REPLICA_WORKER_MAX_STRING_CHARS,
  checkPayloadShape,
  parseWorkerRequest,
  parseWorkerResponse,
  runReplicaWorker,
  type ReplicaWorkerRunner,
} from '../../src/memory/replica-worker.ts';

/**
 * T-144 / CV-02: worker protocol boundary coverage.
 *
 * Two deterministic seams are used:
 * - pure `parseWorkerRequest`/`parseWorkerResponse` calls for validator branches;
 * - `runReplicaWorker` against in-memory streams (PassThrough in, capturing
 *   writable out) for the stream loop. `terminate()` is stubbed at
 *   `process.exit` so an in-process worker can be unwired without killing the
 *   test runner; every listener/timer it installed is removed first.
 *
 * The only unavoidable real wait is the heartbeat probe: the worker's liveness
 * tick is clamped to >=250ms by design, so that one child process waits ~250ms.
 */

const WORKER_SOURCE = pathToFileURL(join(process.cwd(), 'src', 'memory', 'replica-worker.ts')).href;

class WorkerExit extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`worker exit ${code}`);
    this.code = code;
  }
}

interface Waiter {
  readonly resolve: (line: string) => void;
  timer: NodeJS.Timeout;
}

/** Writable that records stdout and hands complete lines to awaiting readers. */
class LineSink extends Writable {
  private buffer = '';
  private readonly lines: string[] = [];
  private readonly waiters: Waiter[] = [];

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.buffer += chunk.toString('utf8');
    this.drain();
    callback();
  }

  private drain(): void {
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline === -1) return;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      const waiter = this.waiters.shift();
      if (waiter === undefined) {
        this.lines.push(line);
      } else {
        clearTimeout(waiter.timer);
        waiter.resolve(line);
      }
    }
  }

  /** Resolve with the next raw protocol line; rejects after `timeoutMs` (bounded). */
  nextRaw(timeoutMs = 200): Promise<string> {
    const queued = this.lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise<string>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error('timed out waiting for a worker protocol line'));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  async next(timeoutMs = 200): Promise<Record<string, unknown>> {
    return JSON.parse(await this.nextRaw(timeoutMs)) as Record<string, unknown>;
  }
}

interface WorkerSession {
  readonly input: PassThrough;
  readonly output: LineSink;
  readonly errorOutput: LineSink;
  readonly runner: ReplicaWorkerRunner;
  readonly root: string;
}

async function startWorker(
  t: TestContext,
  options: {
    readonly output?: NodeJS.WritableStream;
    readonly maxMessageBytes?: number;
  } = {},
): Promise<WorkerSession> {
  const root = await mkdtemp(join(tmpdir(), 'ano worker protocol '));
  t.after(async () => {
    await delay(20);
    await rm(root, { recursive: true, force: true });
  });
  const input = new PassThrough();
  const output = options.output ?? new LineSink();
  const errorOutput = new LineSink();
  const runner = runReplicaWorker({
    input,
    output,
    errorOutput,
    ...(options.maxMessageBytes === undefined ? {} : { maxMessageBytes: options.maxMessageBytes }),
  });
  return { input, output: output as LineSink, errorOutput, runner, root };
}

/** Unwire a worker without letting its terminate() call the real process.exit. */
function disposeWorker(session: WorkerSession): void {
  const original = process.exit;
  process.exit = ((code?: string | number | null): never => {
    throw new WorkerExit(String(code));
  }) as typeof process.exit;
  try {
    session.runner.terminate(0);
  } catch (error) {
    assert.ok(error instanceof WorkerExit, `unexpected terminate error: ${String(error)}`);
  } finally {
    process.exit = original;
  }
  session.input.destroy();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function initPayload(root: string, projectScope = 'fixture'): Record<string, unknown> {
  return { root, replicaId: 'replica-proto', projectScope };
}

async function initSession(session: WorkerSession): Promise<Record<string, unknown>> {
  session.input.write(`${JSON.stringify({ type: 'init', id: 'init-1', payload: initPayload(session.root) })}\n`);
  const ready = await session.output.next();
  assert.equal(ready.ok, true, JSON.stringify(ready));
  return ready;
}

// ---------------------------------------------------------------------------
// Pure request parser: rejection branches
// ---------------------------------------------------------------------------

test('parseWorkerRequest rejects malformed framing and hostile shapes', () => {
  const badJson = parseWorkerRequest('{ not json');
  assert.equal(badJson.ok, false);
  assert.equal(badJson.error.code, 'REPLICA_MESSAGE_INVALID');

  const nonObject = parseWorkerRequest('[1,2]');
  assert.equal(nonObject.ok, false);

  const unknownField = parseWorkerRequest(JSON.stringify({ type: 'status', id: 's1', payload: {}, extra: 1 }));
  assert.equal(unknownField.ok, false);

  const badId = parseWorkerRequest(JSON.stringify({ type: 'status', id: 'not a valid id!', payload: {} }));
  assert.equal(badId.ok, false);

  const unknownType = parseWorkerRequest(JSON.stringify({ type: 'append', id: 's1', payload: {} }));
  assert.equal(unknownType.ok, false);
  assert.equal(unknownType.error.code, 'REPLICA_MESSAGE_UNKNOWN_TYPE');

  const statusScalarPayload = parseWorkerRequest(JSON.stringify({ type: 'status', id: 's1', payload: 7 }));
  assert.equal(statusScalarPayload.ok, false);

  const missingInitPayload = parseWorkerRequest(JSON.stringify({ type: 'init', id: 'i1' }));
  assert.equal(missingInitPayload.ok, false);

  // Byte-shape guard (fail() helper): depth, array length, string length, key length.
  let deep: Record<string, unknown> = {};
  for (let level = 0; level <= REPLICA_WORKER_MAX_NESTING_DEPTH; level += 1) {
    const nested: Record<string, unknown> = {};
    nested.child = deep;
    deep = nested;
  }
  assert.equal(checkPayloadShape(deep).ok, false);
  assert.equal(parseWorkerRequest(JSON.stringify({ type: 'query', id: 'q1', payload: { schema_version: 'anchorprobe.request.v1', request_id: 'r', root: '/', project_scope: 's', nested: deep } })).ok, false);

  const longArray = parseWorkerRequest(JSON.stringify({
    type: 'apply',
    id: 'a1',
    payload: { events: new Array(REPLICA_WORKER_MAX_ARRAY_LENGTH + 1).fill(0) },
  }));
  assert.equal(longArray.ok, false);

  const longString = parseWorkerRequest(JSON.stringify({
    type: 'init',
    id: 'i1',
    payload: { root: '/'.repeat(REPLICA_WORKER_MAX_STRING_CHARS + 1), replicaId: 'r', projectScope: 's' },
  }));
  assert.equal(longString.ok, false);

  const longKey = parseWorkerRequest(JSON.stringify({
    type: 'init',
    id: 'i1',
    payload: { root: '/', replicaId: 'r', projectScope: 's', ['k'.repeat(REPLICA_WORKER_MAX_STRING_CHARS + 1)]: 1 },
  }));
  assert.equal(longKey.ok, false);
});

test('parseWorkerRequest enforces init/apply/query payload validation', () => {
  const cases: ReadonlyArray<[Record<string, unknown>, string]> = [
    [{ type: 'init', id: 'i1', payload: { root: '/', replicaId: 'r', projectScope: 's', nope: 1 } }, 'unknown field'],
    [{ type: 'init', id: 'i1', payload: { root: '', replicaId: 'r', projectScope: 's' } }, 'root'],
    [{ type: 'init', id: 'i1', payload: { root: '/', replicaId: '', projectScope: 's' } }, 'replicaId'],
    [{ type: 'init', id: 'i1', payload: { root: '/', replicaId: 'r', projectScope: '' } }, 'scope'],
    [{ type: 'init', id: 'i1', payload: { root: '/', replicaId: 'r', projectScope: 's', clusterEpoch: [] } }, 'epoch'],
    [{ type: 'init', id: 'i1', payload: { root: '/', replicaId: 'r', projectScope: 's', snapshot: 3 } }, 'snapshot object'],
    [{ type: 'init', id: 'i1', payload: { root: '/', replicaId: 'r', projectScope: 's', snapshot: { nope: 1 } } }, 'snapshot extras'],
    [{ type: 'init', id: 'i1', payload: { root: '/', replicaId: 'r', projectScope: 's', snapshot: { graph_revision: 9 } } }, 'snapshot digest'],
    [{ type: 'apply', id: 'a1', payload: 3 }, 'apply object'],
    [{ type: 'apply', id: 'a1', payload: { events: [], nope: 1 } }, 'apply extras'],
    [{ type: 'apply', id: 'a1', payload: { events: 'nope' } }, 'events array'],
    [{ type: 'apply', id: 'a1', payload: { events: [], projectScope: '' } }, 'projectScope'],
    [{ type: 'query', id: 'q1', payload: { schema_version: 'nope' } }, 'query schema'],
  ];
  for (const [message, label] of cases) {
    const parsed = parseWorkerRequest(JSON.stringify(message));
    assert.equal(parsed.ok, false, label);
    assert.ok(typeof parsed.error.code === 'string', label);
  }
  // A request that passes the shape guard but fails the query schema reports
  // the first zod issue, proving the detail-assembly branch ran.
  const queryFailure = parseWorkerRequest(JSON.stringify({ type: 'query', id: 'q1', payload: { schema_version: 'nope' } }));
  assert.match(JSON.stringify(queryFailure), /query payload does not satisfy anchorprobe.request.v1/);
});

test('parseWorkerResponse covers every parent-side rejection branch', () => {
  const invalidJson = parseWorkerResponse('{ nope');
  assert.equal(invalidJson.ok, false);

  const nonObject = parseWorkerResponse('"text"');
  assert.equal(nonObject.ok, false);

  const extra = parseWorkerResponse(JSON.stringify({ ok: true, id: 'r1', type: 'status', payload: {}, nope: 1 }));
  assert.equal(extra.ok, false);

  const badId = parseWorkerResponse(JSON.stringify({ ok: true, id: 'x'.repeat(129), type: 'status', payload: {} }));
  assert.equal(badId.ok, false);

  const badType = parseWorkerResponse(JSON.stringify({ ok: true, id: 'r1', type: 'bogus', payload: {} }));
  assert.equal(badType.ok, false);
  assert.equal(badType.error.code, 'REPLICA_RESPONSE_INVALID');

  const badError = parseWorkerResponse(JSON.stringify({ ok: false, id: 'r1', error: { code: 1, message: 2 } }));
  assert.equal(badError.ok, false);

  const badOk = parseWorkerResponse(JSON.stringify({ ok: 'yes', id: 'r1' }));
  assert.equal(badOk.ok, false);

  // Valid shapes prove the accept paths and the nested array walker.
  const validInit = parseWorkerRequest(JSON.stringify({
    type: 'init',
    id: 'i-valid',
    payload: {
      root: '/tmp/root',
      replicaId: 'r',
      projectScope: 's',
      clusterEpoch: 3,
      snapshot: {
        project_scope: 's',
        ledger_digest: 'b'.repeat(64),
        graph_revision: null,
        source_fingerprint: null,
        connected_digest: null,
      },
    },
  }));
  assert.equal(validInit.ok, true);

  const validApply = parseWorkerRequest(JSON.stringify({ type: 'apply', id: 'a-valid', payload: { events: [{}] } }));
  assert.equal(validApply.ok, true);

  const good = parseWorkerResponse(JSON.stringify({ ok: true, id: 'r1', type: 'status', payload: {} }));
  assert.equal(good.ok, true);

  const goodFailure = parseWorkerResponse(JSON.stringify({ ok: false, id: 'r1', error: { code: 'X', message: 'm' } }));
  assert.equal(goodFailure.ok, true);
  assert.equal(goodFailure.response.ok, false);
});

// ---------------------------------------------------------------------------
// Stream loop
// ---------------------------------------------------------------------------

test('the stream loop answers malformed lines without dying', { timeout: 60_000 }, async (t) => {
  const session = await startWorker(t);
  try {
    session.input.write('{ not a protocol line\n');
    const rejected = await session.output.next();
    assert.equal(rejected.ok, false);
    assert.equal(rejected.id, '');
    assert.equal((rejected.error as { code: string }).code, 'REPLICA_MESSAGE_INVALID');

    // Still serving afterwards.
    session.input.write(`${JSON.stringify({ type: 'status', id: 's-after', payload: {} })}\n`);
    const after = await session.output.next();
    assert.equal(after.ok, false);
    assert.equal((after.error as { code: string }).code, 'REPLICA_NOT_INITIALIZED');
  } finally {
    disposeWorker(session);
  }
});

test('double init and cross-scope queries are refused explicitly', { timeout: 60_000 }, async (t) => {
  const session = await startWorker(t);
  try {
    await initSession(session);
    session.input.write(`${JSON.stringify({ type: 'init', id: 'init-2', payload: initPayload(session.root) })}\n`);
    const doubleInit = await session.output.next();
    assert.equal(doubleInit.ok, false);
    assert.equal((doubleInit.error as { code: string }).code, 'REPLICA_ALREADY_INITIALIZED');

    session.input.write(`${JSON.stringify({
      type: 'query',
      id: 'q-scope',
      payload: {
        schema_version: 'anchorprobe.request.v1',
        request_id: 'req-scope',
        root: session.root,
        project_scope: 'other-scope',
        required_facts: [],
      },
    })}\n`);
    const denied = await session.output.next();
    assert.equal(denied.ok, false);
    assert.equal((denied.error as { code: string }).code, 'SCOPE_DENIED');
  } finally {
    disposeWorker(session);
  }
});

test('a failing stdout is swallowed into stderr instead of crashing the worker', { timeout: 60_000 }, async (t) => {
  const throwing = { write(): boolean { throw new Error('stdout is gone'); } } as unknown as NodeJS.WritableStream;
  const session = await startWorker(t, { output: throwing });
  try {
    const originalWrite = process.stderr.write;
    let captured = '';
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      captured += chunk.toString();
      return true;
    }) as typeof process.stderr.write;
    try {
      session.input.write(`${JSON.stringify({ type: 'status', id: 's-write-fail', payload: {} })}\n`);
      const deadline = Date.now() + 200;
      while (captured.length === 0 && Date.now() < deadline) await delay(10);
      assert.match(captured, /failed to write response/);
    } finally {
      process.stderr.write = originalWrite;
    }
  } finally {
    disposeWorker(session);
  }
});

test('oversized inbound messages are bounded and the discard state recovers', { timeout: 60_000 }, async (t) => {
  const limit = 64;
  const tail = await startWorker(t, { maxMessageBytes: limit });
  try {
    // No-newline tail over the limit -> TOO_LARGE, discarding latched.
    tail.input.write('x'.repeat(limit + 5));
    const first = await tail.output.next();
    assert.equal(first.ok, false);
    assert.equal((first.error as { code: string }).code, 'REPLICA_MESSAGE_TOO_LARGE');

    // A newline resets discarding; the following normal line is handled.
    tail.input.write('\n');
    tail.input.write(`${JSON.stringify({ type: 'status', id: 's-recover', payload: {} })}\n`);
    const recovered = await tail.output.next();
    assert.equal((recovered.error as { code: string }).code, 'REPLICA_NOT_INITIALIZED');
  } finally {
    disposeWorker(tail);
  }

  const wholeLine = await startWorker(t, { maxMessageBytes: limit });
  try {
    // A complete line over the limit in one chunk -> TOO_LARGE via the line path.
    wholeLine.input.write(`${JSON.stringify({ type: 'status', id: 's-big', payload: { pad: 'p'.repeat(limit) } })}\n`);
    const big = await wholeLine.output.next();
    assert.equal(big.ok, false);
    assert.equal((big.error as { code: string }).code, 'REPLICA_MESSAGE_TOO_LARGE');
  } finally {
    disposeWorker(wholeLine);
  }
});

test('an init that fails inside the store maps to a generic internal error frame', { timeout: 60_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ano worker init fault '));
  t.after(async () => {
    await delay(20);
    await rm(directory, { recursive: true, force: true });
  });
  const blocker = join(directory, 'not-a-directory');
  await writeFile(blocker, 'occupied', 'utf8');

  const session = await startWorker(t);
  try {
    session.input.write(`${JSON.stringify({
      type: 'init',
      id: 'init-bad-root',
      payload: { root: blocker, replicaId: 'replica-proto', projectScope: 'fixture' },
    })}\n`);
    const rejected = await session.output.next();
    assert.equal(rejected.ok, false);
    // A bare fs failure carries its own uppercase `code`, proving the generic
    // error-mapping branch ran instead of the ReplicationError fast path.
    const error = rejected.error as { code: string; message: string };
    assert.match(error.code, /^[A-Z][A-Z0-9_]*$/u);
    assert.ok(error.message.length > 0);
  } finally {
    disposeWorker(session);
  }
});

test('shutdown requires an initialized session and then retires the worker', { timeout: 60_000 }, async (t) => {
  const session = await startWorker(t);
  const input = session.input;
  try {
    input.write(`${JSON.stringify({ type: 'shutdown', id: 'stop-0', payload: {} })}\n`);
    const stopped = await session.output.next();
    assert.equal(stopped.ok, false);
    assert.equal((stopped.error as { code: string }).code, 'REPLICA_NOT_INITIALIZED');
  } finally {
    disposeWorker(session);
  }
  assert.equal(input.destroyed, true);
});

test('cancel is idempotent, pre-empts an unread id and reports completed ids', { timeout: 60_000 }, async (t) => {
  const session = await startWorker(t);
  try {
    session.input.write(`${JSON.stringify({ type: 'cancel', id: 'c-1', payload: { targetId: 'q-1' } })}\n`);
    const first = await session.output.next();
    assert.equal(first.ok, true);
    assert.equal(first.type, 'cancel');
    assert.deepEqual(first.payload, { cancelled: true, targetId: 'q-1' });

    session.input.write(`${JSON.stringify({ type: 'cancel', id: 'c-2', payload: { targetId: 'q-1' } })}\n`);
    assert.deepEqual((await session.output.next()).payload, { cancelled: true, targetId: 'q-1' });

    // The cancelled id must never execute.
    session.input.write(`${JSON.stringify({ type: 'status', id: 'q-1', payload: {} })}\n`);
    const blocked = await session.output.next();
    assert.equal(blocked.ok, false);
    assert.equal((blocked.error as { code: string }).code, 'REPLICA_QUERY_CANCELLED');

    session.input.write(`${JSON.stringify({ type: 'init', id: 'init-1', payload: initPayload(session.root) })}\n`);
    assert.equal((await session.output.next()).ok, true);
    session.input.write(`${JSON.stringify({ type: 'status', id: 's-done', payload: {} })}\n`);
    assert.equal((await session.output.next()).ok, true);

    session.input.write(`${JSON.stringify({ type: 'cancel', id: 'c-3', payload: { targetId: 's-done' } })}\n`);
    assert.deepEqual((await session.output.next()).payload, {
      cancelled: false,
      targetId: 's-done',
      reason: 'completed',
    });

    // An unseen id becomes pre-cancelled: it will never run, so the ack says
    // cancelled=true and a later request with that id is refused.
    session.input.write(`${JSON.stringify({ type: 'cancel', id: 'c-4', payload: { targetId: 'never-seen' } })}\n`);
    assert.deepEqual((await session.output.next()).payload, {
      cancelled: true,
      targetId: 'never-seen',
    });
  } finally {
    disposeWorker(session);
  }
});

test('the worker cancel memory is bounded and evicts the oldest id', { timeout: 60_000 }, async (t) => {
  const session = await startWorker(t);
  try {
    // 300 distinct targets exceed the bounded ledger (256), exercising the
    // eviction loop without letting a hostile parent grow memory.
    for (let index = 0; index < 300; index += 1) {
      session.input.write(`${JSON.stringify({ type: 'cancel', id: `bulk-${String(index)}`, payload: { targetId: `target-${String(index)}` } })}\n`);
      const ack = await session.output.next();
      assert.equal(ack.ok, true);
      assert.equal((ack.payload as { cancelled: boolean }).cancelled, true);
    }
  } finally {
    disposeWorker(session);
  }
});

test('cancel payloads are strictly validated', () => {
  const parse = (payload: unknown) => parseWorkerRequest(JSON.stringify({ type: 'cancel', id: 'c-1', payload }));
  assert.equal(parse({ targetId: 'req-1' }).ok, true);
  for (const payload of [{}, { targetId: '' }, { targetId: 42 }, { targetId: 'req-1', extra: true }]) {
    const parsed = parse(payload);
    assert.equal(parsed.ok, false, JSON.stringify(payload));
    if (!parsed.ok) assert.equal(parsed.error.code, 'REPLICA_MESSAGE_INVALID');
  }
});

// ---------------------------------------------------------------------------
// Child-isolated fatal paths
// ---------------------------------------------------------------------------

async function tempScript(t: TestContext, name: string, body: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ano worker probe '));
  t.after(async () => {
    await delay(20);
    await rm(directory, { recursive: true, force: true });
  });
  const file = join(directory, name);
  await writeFile(file, body, 'utf8');
  return file;
}

interface ProbeResult {
  readonly code: number | null;
  readonly stderr: string;
}

function runProcess(arguments_: readonly string[], env: NodeJS.ProcessEnv = process.env, timeoutMs = 4_000): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...arguments_], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-4_000);
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`probe timed out; stderr=${stderr.slice(-300)}`));
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      resolve({ code, stderr });
    });
  });
}

function runProbe(script: string, timeoutMs = 4_000): Promise<ProbeResult> {
  return runProcess([script], process.env, timeoutMs);
}

test('an uncaught failure inside the worker reports fatal and exits 1', { timeout: 60_000 }, async (t) => {
  const script = await tempScript(t, 'fatal.mjs', `
    const { runReplicaWorker } = await import(${JSON.stringify(WORKER_SOURCE)});
    runReplicaWorker({});
    setTimeout(() => { throw new Error('fatal-probe'); }, 10);
  `);
  const result = await runProbe(script);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /\[replica-worker\] fatal:/);
});

test('a missing argv[1] path falls through the direct-entry guard without starting', { timeout: 60_000 }, async (t) => {
  const script = await tempScript(t, 'guard.mjs', `
    process.argv[1] = '/definitely/not/a/real/replica-worker-path.ts';
    await import(${JSON.stringify(WORKER_SOURCE)});
  `);
  const result = await runProbe(script);
  assert.equal(result.code, 0, result.stderr);
});

test('an invoked-with-no-argv process never starts the worker loop', { timeout: 60_000 }, async () => {
  // `node --input-type=module -e` leaves argv[1] undefined, hitting the
  // typeof-guard branch of invokedDirectly().
  const result = await runProcess(['--input-type=module', '-e', `await import(${JSON.stringify(WORKER_SOURCE)});`]);
  assert.equal(result.code, 0, result.stderr);
});
