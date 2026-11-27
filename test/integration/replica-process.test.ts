import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { ulid } from '../../src/core/ulid.ts';
import { Ledger } from '../../src/ledger/ledger.ts';
import type { LedgerEvent } from '../../src/ledger/event.ts';
import { replayLedger } from '../../src/ledger/replay.ts';
import { viewDigest, type ViewReplayEntry } from '../../src/ledger/views.ts';
import {
  ANCHOR_PROBE_REQUEST_SCHEMA_VERSION,
  type AnchorProbeRequest,
  type AnchorProbeSnapshot,
} from '../../src/memory/probe-contract.ts';
import { ReplicaStore } from '../../src/memory/replica.ts';
import {
  committedEnvelopeFromEvent,
  exportCommittedEvents,
  type CommittedEventEnvelope,
} from '../../src/memory/replication.ts';
import {
  ChildProcessReplicaTransport,
  REPLICA_TRANSPORT_KINDS,
  ReplicaTransportError,
  REPLICA_WORKER_MAX_MESSAGE_BYTES,
  type ReplicaHandle,
} from '../../src/memory/replica-transport.ts';

/**
 * T-127 (DC-05) integration: real OS child processes carry independent read-only
 * replicas. Two workers are started simultaneously, replicated, queried,
 * killed, restarted and stopped against a throwaway ledger in a tmpdir. No
 * business project is touched and no cross-machine capability is claimed.
 */

const SCOPE = 'fixture';
/**
 * A hung child must fail this file in bounded time. Without it a leaked worker
 * held the file's event loop until the runner-wide timeout (900s on
 * 2026-11-24), hiding both the failure and its cleanup.
 */
const PROCESS_TEST_TIMEOUT_MS = 60_000;
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const AT = '2026-11-21T00:00:00.000Z';
const WORKER_PATH = fileURLToPath(new URL('../../src/memory/replica-worker.ts', import.meta.url));
const TRANSPORT_SOURCE = fileURLToPath(new URL('../../src/memory/replica-transport.ts', import.meta.url));
const WORKER_SOURCE = fileURLToPath(new URL('../../src/memory/replica-worker.ts', import.meta.url));

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
    // EPERM means the process exists but belongs to another user/context.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function notePayload(label: string, text: string): Record<string, unknown> {
  return {
    note_id: sha256(`proc-note:${label}`),
    kind: 'decision',
    text,
    created_at: AT,
    anchor: { file: 'src/a.ts', symbolId: `sym-${label}` },
  };
}

function memoryGenesis(factKey: string, text: string): Record<string, unknown> {
  return {
    intent: 'revise',
    fact_key: factKey,
    record: { text, kind: 'decision', anchor: { file: 'src/a.ts', symbolId: 'sym-a' } },
    supersedes: [],
    reason: 'genesis',
    effective_from: null,
    effective_to: null,
  };
}

interface Fixture {
  readonly root: string;
  readonly ledger: Ledger;
  readonly snapshot: AnchorProbeSnapshot;
  readonly initialEnvelopes: readonly CommittedEventEnvelope[];
}

/** A real ledger in a tmpdir with committed cross-domain events. */
async function buildFixture(t: TestContext, count = 6): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'ano replica process '));
  let tick = 1_000;
  const ledger = await Ledger.open(root, {
    sessionId: `replica-process-${ulid().slice(-8)}`,
    clock: () => {
      tick += 1;
      return tick;
    },
  });
  // One cleanup hook with an explicit order: close the ledger handle first,
  // then remove the tree (Windows refuses to unlink a held sqlite file).
  t.after(async () => {
    try {
      ledger.close();
    } catch {
      // already closed
    }
    await delay(50);
    await rm(root, { recursive: true, force: true });
  });

  for (let index = 0; index < count; index += 1) {
    const payload = index % 2 === 0
      ? notePayload(`n${index}`, `replica process decision ${index}`)
      : memoryGenesis(`local.fact.${index}`, `replica fact ${index}`);
    const kind: LedgerEvent['kind'] = index % 2 === 0 ? 'note.recorded' : 'memory.revised';
    const result = await ledger.append({ kind, payload }, `proc-note-${index}`);
    assert.ok(result.event !== undefined, `append ${String(index)} produced no event`);
  }

  const entries = replayEntries(root);
  return {
    root,
    ledger,
    snapshot: {
      project_scope: SCOPE,
      ledger_digest: viewDigest(entries),
      graph_revision: HASH_B,
      source_fingerprint: HASH_C,
      connected_digest: null,
    },
    initialEnvelopes: exportCommittedEvents(ledger, { projectScope: SCOPE, limit: 1024 }).events,
  };
}

function replayEntries(root: string): readonly ViewReplayEntry[] {
  return replayLedger(join(root, '.ano', 'ledger')).entries;
}

function probeRequest(root: string, requestId: string, overrides: Record<string, unknown> = {}): AnchorProbeRequest {
  return {
    schema_version: ANCHOR_PROBE_REQUEST_SCHEMA_VERSION,
    request_id: requestId,
    root,
    project_scope: SCOPE,
    required_facts: ['local.fact.1'],
    ...overrides,
  } as AnchorProbeRequest;
}

async function startReplica(transport: ChildProcessReplicaTransport, fixture: Fixture, replicaId: string): Promise<ReplicaHandle> {
  return transport.start({
    root: fixture.root,
    replicaId,
    projectScope: SCOPE,
    clusterEpoch: 'epoch-1',
    snapshot: fixture.snapshot,
  });
}

async function stopQuietly(transport: ChildProcessReplicaTransport, handle: ReplicaHandle | null): Promise<void> {
  if (handle === null) return;
  try {
    await transport.stop(handle);
  } catch {
    // already gone; the leak assertions below are the real check
  }
}

// ---------------------------------------------------------------------------
// 1+2: two independent processes really answer, and replication converges
// ---------------------------------------------------------------------------

test('two independent child-process replicas answer the same query and reach one commit point', { timeout: PROCESS_TEST_TIMEOUT_MS }, async (t) => {
  const fixture = await buildFixture(t);
  const transport = new ChildProcessReplicaTransport();
  const replicaA = await startReplica(transport, fixture, 'replica-a');
  const replicaB = await startReplica(transport, fixture, 'replica-b');
  t.after(async () => {
    await stopQuietly(transport, replicaA);
    await stopQuietly(transport, replicaB);
  });

  const reportA = await transport.apply(replicaA, fixture.initialEnvelopes, { projectScope: SCOPE });
  const reportB = await transport.apply(replicaB, fixture.initialEnvelopes, { projectScope: SCOPE });
  assert.equal(reportA.applied, fixture.initialEnvelopes.length);
  assert.equal(reportB.commitIndex, reportA.commitIndex);

  const request = probeRequest(fixture.root, 'proc-query-shared');
  const [answerA, answerB] = await Promise.all([
    transport.query(replicaA, request),
    transport.query(replicaB, request),
  ]);
  const statusA = await transport.status(replicaA);
  const statusB = await transport.status(replicaB);

  // Distinct OS processes and distinct replica identities.
  assert.ok(replicaA.pid !== null && replicaB.pid !== null);
  assert.notEqual(replicaA.pid, replicaB.pid, 'each replica must be its own OS process');
  assert.equal(statusA.pid, replicaA.pid);
  assert.equal(statusB.pid, replicaB.pid);
  assert.notEqual(statusA.pid, statusB.pid);
  assert.notEqual(statusA.replicaId, statusB.replicaId);
  assert.equal(statusA.replicaId, 'replica-a');
  assert.equal(statusB.replicaId, 'replica-b');

  // Both processes returned the same real commit point and the same projection.
  assert.equal(answerA.commitIndex, fixture.initialEnvelopes.length);
  assert.equal(answerB.commitIndex, fixture.initialEnvelopes.length);
  assert.equal(answerA.viewDigest, answerB.viewDigest);
  assert.equal(answerA.evidenceDigest, answerB.evidenceDigest);
  assert.equal(statusA.viewDigest, statusB.viewDigest);
  assert.ok(answerA.candidates.length > 0, 'a real replica projection must answer with candidates');

  // The replica wrote only inside its own directory.
  for (const replicaId of ['replica-a', 'replica-b']) {
    const directory = ReplicaStore.directoryFor(fixture.root, replicaId);
    const files = readdirSync(directory).sort();
    assert.deepEqual(files, ['cursor.json', 'events.jsonl']);
  }
});

// ---------------------------------------------------------------------------
// 3: crash detection fails fast instead of hanging
// ---------------------------------------------------------------------------

test('killing a replica child flips isAlive and fails the next query in under a second', { timeout: PROCESS_TEST_TIMEOUT_MS }, async (t) => {
  const fixture = await buildFixture(t);
  const transport = new ChildProcessReplicaTransport();
  const replica = await startReplica(transport, fixture, 'replica-kill');
  t.after(async () => {
    await stopQuietly(transport, replica);
  });
  await transport.apply(replica, fixture.initialEnvelopes, { projectScope: SCOPE });
  assert.equal(transport.isAlive(replica), true);

  const pid = replica.pid as number;
  assert.equal(processExists(pid), true);
  assert.equal(process.kill(pid, 'SIGKILL'), true);

  await waitFor(() => transport.isAlive(replica) === false, 2_000, 'crash detection');
  await waitFor(() => processExists(pid) === false, 2_000, 'OS process reaping');

  const started = Date.now();
  await assert.rejects(
    () => transport.query(replica, probeRequest(fixture.root, 'proc-query-dead')),
    (error: unknown) => error instanceof ReplicaTransportError && error.code === 'REPLICA_NODE_EXITED',
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1_000, `dead-node query took ${String(elapsed)}ms`);

  // A stopped/killed handle is not revived by a stray request.
  await assert.rejects(() => transport.status(replica), /REPLICA_NODE_EXITED|REPLICA_STALE_HANDLE/);
});

// ---------------------------------------------------------------------------
// 4: restart restores the cursor and resume catches up from it
// ---------------------------------------------------------------------------

test('restart relaunches the worker, restores the cursor and resumes from it', { timeout: PROCESS_TEST_TIMEOUT_MS }, async (t) => {
  const fixture = await buildFixture(t);
  const transport = new ChildProcessReplicaTransport();
  const replica = await startReplica(transport, fixture, 'replica-restart');
  t.after(async () => {
    await stopQuietly(transport, replica);
  });
  await transport.apply(replica, fixture.initialEnvelopes, { projectScope: SCOPE });
  const commitBefore = (await transport.status(replica)).commitIndex;
  assert.equal(commitBefore, fixture.initialEnvelopes.length);
  const deadPid = replica.pid as number;

  // Crash the worker; the replica directory keeps the applied prefix + cursor.
  assert.equal(process.kill(deadPid, 'SIGKILL'), true);
  await waitFor(() => transport.isAlive(replica) === false, 2_000, 'crash detection before restart');

  // The primary commits two more events while the replica is down.
  const latePayloads: ReadonlyArray<[{ readonly kind: LedgerEvent['kind']; readonly payload: Record<string, unknown> }, string]> = [
    [{ kind: 'note.recorded', payload: notePayload('late-0', 'late decision 0') }, 'proc-late-0'],
    [{ kind: 'memory.revised', payload: memoryGenesis('local.late', 'late fact') }, 'proc-late-1'],
  ];
  for (const [input, idemKey] of latePayloads) {
    const result = await fixture.ledger.append(input, idemKey);
    assert.ok(result.event !== undefined);
  }
  const primaryEntries = replayEntries(fixture.root);
  const late = exportCommittedEvents(fixture.ledger, { fromCommitIndex: commitBefore, projectScope: SCOPE, limit: 1024 });
  assert.equal(late.events.length, 2);

  const restarted = await transport.restart(replica);
  t.after(async () => {
    await stopQuietly(transport, restarted);
  });
  assert.notEqual(restarted.pid, deadPid, 'restart must launch a new OS process');
  assert.ok(restarted.pid !== null && processExists(restarted.pid));
  await waitFor(() => processExists(deadPid) === false, 5_000, 'the dead pid to be reaped');
  assert.equal(processExists(deadPid), false, 'the dead pid must stay dead');

  const resumed = await transport.status(restarted);
  assert.equal(resumed.commitIndex, commitBefore, 'the persisted cursor must survive the restart');
  assert.equal(resumed.cursor.lastEventId, fixture.initialEnvelopes.at(-1)!.eventId);

  let firstCursor = -1;
  const finalStatus = await transport.resume(restarted, async (cursor) => {
    if (firstCursor === -1) {
      firstCursor = cursor.commitIndex;
      assert.equal(cursor.commitIndex, commitBefore, 'resume pulls strictly after the restored cursor');
    } else {
      assert.ok(cursor.commitIndex > commitBefore, 'resume advances past the restored cursor');
    }
    return exportCommittedEvents(fixture.ledger, { fromCommitIndex: cursor.commitIndex, projectScope: SCOPE, limit: 1024 }).events;
  });
  assert.equal(firstCursor, commitBefore);
  assert.equal(finalStatus.commitIndex, primaryEntries.length);
  assert.equal(finalStatus.viewDigest, viewDigest(primaryEntries));

  const finalQuery = await transport.query(restarted, probeRequest(fixture.root, 'proc-query-restarted'));
  assert.equal(finalQuery.commitIndex, primaryEntries.length);
});

// ---------------------------------------------------------------------------
// 5: explicit stop releases the child handle and leaks no process
// ---------------------------------------------------------------------------

test('stopping replicas releases their handles and leaves no live process', { timeout: PROCESS_TEST_TIMEOUT_MS }, async (t) => {
  const fixture = await buildFixture(t);
  const transport = new ChildProcessReplicaTransport();
  const replicaA = await startReplica(transport, fixture, 'replica-stop-a');
  const replicaB = await startReplica(transport, fixture, 'replica-stop-b');
  await transport.apply(replicaA, fixture.initialEnvelopes, { projectScope: SCOPE });
  await transport.apply(replicaB, fixture.initialEnvelopes, { projectScope: SCOPE });
  const pids = [replicaA.pid as number, replicaB.pid as number];

  await transport.stop(replicaA);
  await transport.stop(replicaB);
  assert.equal(transport.isAlive(replicaA), false);
  assert.equal(transport.isAlive(replicaB), false);
  for (const pid of pids) {
    // The 'exit' event fires before Windows removes the pid from the process
    // table; poll briefly so reaping latency is not misread as a leak. A real
    // survivor still fails the final assertion.
    await waitFor(() => processExists(pid) === false, 5_000, `pid ${String(pid)} to be reaped after stop()`);
    assert.equal(processExists(pid), false, `pid ${String(pid)} must not survive stop()`);
  }

  // stop is idempotent.
  await transport.stop(replicaA);
  await transport.stop(replicaB);

  // A handle from another transport instance is refused, never misused.
  const stranger = new ChildProcessReplicaTransport();
  await assert.rejects(() => stranger.status(replicaA), /REPLICA_STALE_HANDLE/);
});

// ---------------------------------------------------------------------------
// 6: message schema/size limits reject hostile input without killing the worker
// ---------------------------------------------------------------------------

interface RawReply {
  readonly ok: boolean;
  readonly id: string;
  readonly type?: string;
  readonly payload?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

interface RawWorker {
  readonly child: ChildProcess;
  send(value: unknown): void;
  sendLine(text: string): void;
  next(timeoutMs?: number): Promise<RawReply>;
  stop(): Promise<void>;
}

interface RawWaiter {
  readonly resolve: (reply: RawReply) => void;
  readonly reject: (error: Error) => void;
}

function spawnRawWorker(root: string, replicaId: string): RawWorker {
  const child = spawn(process.execPath, [WORKER_PATH], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let exit: { readonly code: number | null; readonly signal: NodeJS.Signals | null } | null = null;
  let stderrTail = '';
  const waiters: RawWaiter[] = [];
  const exited = new Promise<void>((resolve) => {
    child.on('exit', (code, signal) => {
      exit = { code, signal };
      // A dead worker can never answer: fail every waiter instead of letting a
      // test hang until the runner-wide timeout (the 2026-11-24 17:33 matrix
      // hung for 900s exactly this way).
      const diagnostic = `raw worker exited (code ${String(code)}, signal ${String(signal)})${stderrTail.trim() === '' ? '' : `: ${stderrTail.trim().slice(-400)}`}`;
      while (waiters.length > 0) waiters.shift()?.reject(new Error(diagnostic));
      resolve();
    });
  });
  // EPIPE/ECONNRESET on a dying child must surface as a test failure, never as
  // an uncaught 'error' event that leaves the body awaiting forever.
  child.stdin.on('error', () => {});
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-4_096);
  });
  let buffer = '';
  const queued: RawReply[] = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline === -1) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim().length === 0) continue;
      const reply = JSON.parse(line) as RawReply;
      const waiter = waiters.shift();
      if (waiter === undefined) queued.push(reply);
      else waiter.resolve(reply);
    }
    if (buffer.length > 8 * 1024 * 1024) buffer = '';
  });
  return {
    child,
    send(value: unknown): void {
      if (exit !== null) throw new Error(`raw worker already exited (code ${String(exit.code)})`);
      child.stdin.write(`${JSON.stringify(value)}\n`);
    },
    sendLine(text: string): void {
      if (exit !== null) throw new Error(`raw worker already exited (code ${String(exit.code)})`);
      child.stdin.write(`${text}\n`);
    },
    next(timeoutMs = 5_000): Promise<RawReply> {
      const immediate = queued.shift();
      if (immediate !== undefined) return Promise.resolve(immediate);
      if (exit !== null) {
        return Promise.reject(new Error(`raw worker already exited (code ${String(exit.code)})`));
      }
      return new Promise<RawReply>((resolve, reject) => {
        const waiter: RawWaiter = {
          resolve: (reply) => {
            clearTimeout(timer);
            resolve(reply);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        };
        const timer = setTimeout(() => {
          // Drop the waiter on timeout: a stale waiter would otherwise consume
          // the next reply and shift every later read by one message.
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error('raw worker reply timed out'));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
    async stop(): Promise<void> {
      if (!child.killed) child.kill('SIGKILL');
      const deadline = Date.now() + 2_000;
      while (child.exitCode === null && Date.now() < deadline) await delay(10);
      // Windows reports a signal-terminated child with exitCode === null, so
      // the observable "process is gone" evidence is the exit event.
      await Promise.race([exited, delay(500)]);
      // Release the pipe handles even on the failure path: a leaked stdio
      // stream keeps this test file's event loop alive and the whole
      // quality-matrix run would wait for the runner-wide timeout.
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      await waitFor(() => processExists(child.pid as number) === false, 5_000, 'raw worker pid to be reaped');
      assert.equal(processExists(child.pid as number), false, 'raw worker process must be gone');
    },
  };
}

test('oversized and malformed protocol messages are rejected and the worker survives', { timeout: PROCESS_TEST_TIMEOUT_MS }, async (t) => {
  const fixture = await buildFixture(t);
  const worker = spawnRawWorker(fixture.root, 'replica-raw-limits');
  t.after(async () => {
    await worker.stop();
  });

  worker.send({ type: 'init', id: 'init-1', payload: { root: fixture.root, replicaId: 'replica-raw-limits', projectScope: SCOPE, clusterEpoch: 'epoch-1' } });
  const ready = await worker.next();
  assert.equal(ready.ok, true, JSON.stringify(ready));

  // Malformed JSON.
  worker.sendLine('{ this is not json');
  const malformed = await worker.next();
  assert.equal(malformed.ok, false);
  assert.equal(malformed.error?.code, 'REPLICA_MESSAGE_INVALID');

  // Unknown (and write-shaped) message types are refused, not executed.
  worker.send({ type: 'append', id: 'w-append', payload: { event: {} } });
  const write = await worker.next();
  assert.equal(write.ok, false);
  assert.equal(write.error?.code, 'REPLICA_MESSAGE_UNKNOWN_TYPE');

  // Invalid AP-02 request payload.
  worker.send({ type: 'query', id: 'w-query', payload: { schema_version: 'anchorprobe.request.v1', request_id: 'r' } });
  const invalidQuery = await worker.next();
  assert.equal(invalidQuery.ok, false);
  assert.equal(invalidQuery.error?.code, 'PROBE_REQUEST_INVALID');

  // Oversized message: above the 1 MiB protocol ceiling.
  const oversized = `${JSON.stringify({ type: 'status', id: 'w-big', payload: { pad: 'a'.repeat(REPLICA_WORKER_MAX_MESSAGE_BYTES) } })}\n`;
  assert.ok(Buffer.byteLength(oversized, 'utf8') > REPLICA_WORKER_MAX_MESSAGE_BYTES);
  worker.sendLine(oversized.trimEnd());
  const tooLarge = await worker.next();
  assert.equal(tooLarge.ok, false);
  assert.equal(tooLarge.error?.code, 'REPLICA_MESSAGE_TOO_LARGE');

  // The worker is still alive and serving after every rejection.
  worker.send({ type: 'status', id: 'w-after', payload: {} });
  const after = await worker.next();
  assert.equal(after.ok, true, JSON.stringify(after));
  assert.equal((after.payload as { commitIndex: number }).commitIndex, 0);

  // The parent-side transport refuses to serialize an over-limit request at all.
  const transport = new ChildProcessReplicaTransport();
  const replica = await startReplica(transport, fixture, 'replica-parent-limit');
  t.after(async () => {
    await stopQuietly(transport, replica);
  });
  const hugeEnvelope: CommittedEventEnvelope = {
    ...committedEnvelopeFromEvent(structuredClone(fixture.initialEnvelopes[0]!.event) as LedgerEvent, 1, 'seg'),
    payload: { text: 'x'.repeat(REPLICA_WORKER_MAX_MESSAGE_BYTES) },
  };
  await assert.rejects(
    () => transport.apply(replica, [hugeEnvelope]),
    (error: unknown) => error instanceof ReplicaTransportError && error.code === 'REPLICA_REQUEST_TOO_LARGE',
  );
  assert.equal(transport.isAlive(replica), true, 'a locally rejected request must not disturb the child');
});

// ---------------------------------------------------------------------------
// 7: hostile payload strings are data, never instructions
// ---------------------------------------------------------------------------

test('hostile payload strings are stored as data and never executed', { timeout: PROCESS_TEST_TIMEOUT_MS }, async (t) => {
  const fixture = await buildFixture(t);
  const marker = join(fixture.root, 'PWNED');
  const hostile = [
    'process.exit(1)',
    'while(true){}',
    "require('child_process').execSync('calc')",
    `require('fs').writeFileSync(${JSON.stringify(marker)}, 'pwned')`,
  ].join('; ');

  const worker = spawnRawWorker(fixture.root, 'replica-malice');
  t.after(async () => {
    await worker.stop();
  });
  worker.send({ type: 'init', id: 'm-init', payload: { root: fixture.root, replicaId: 'replica-malice', projectScope: SCOPE } });
  assert.equal((await worker.next()).ok, true);

  // Hostile text inside a valid AP-02 request field: answered, not executed.
  const query = probeRequest(fixture.root, 'm-query', { root: `${fixture.root} ${hostile}`, required_facts: ['local.hostile'] });
  worker.send({ type: 'query', id: 'm-query', payload: query });
  const answered = await worker.next();
  assert.equal(answered.ok, true, JSON.stringify(answered));

  // A committed hostile note applied as pure data.
  const hostileEvent: LedgerEvent = {
    id: ulid(),
    hlc: { physical: 1_700_000_000_000, logical: 0, actor: 'redteam' },
    actor: 'redteam',
    kind: 'note.recorded',
    payload: { note_id: sha256('hostile-1'), kind: 'decision', text: hostile, created_at: AT, anchor: { file: 'src/evil.ts', symbolId: 'sym-evil' } },
    prev_hash: '0'.repeat(64),
  };
  const envelope = committedEnvelopeFromEvent(hostileEvent, 1, 'segment-hostile');
  worker.send({ type: 'apply', id: 'm-apply', payload: { events: [envelope], projectScope: SCOPE } });
  const applied = await worker.next();
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal((applied.payload as { commitIndex: number }).commitIndex, 1);

  // Nothing was executed: no marker, and the replica directory holds only its
  // own derived files.
  assert.equal(existsSync(marker), false, 'a payload string must never become a filesystem side effect');
  const directory = ReplicaStore.directoryFor(fixture.root, 'replica-malice');
  assert.deepEqual(readdirSync(directory).sort(), ['cursor.json', 'events.jsonl']);

  // The hostile text comes back as inert data through the read path.
  worker.send({ type: 'query', id: 'm-query-2', payload: probeRequest(fixture.root, 'm-query-2', { required_facts: [] }) });
  const reread = await worker.next();
  assert.equal(reread.ok, true);
  const contents = (reread.payload as { candidates: Array<{ content: string }> }).candidates.map((candidate) => candidate.content);
  assert.ok(contents.some((content) => content.includes('process.exit(1)')), 'hostile text must round-trip as data');

  worker.send({ type: 'status', id: 'm-status', payload: {} });
  const status = await worker.next();
  assert.equal(status.ok, true);
});

// ---------------------------------------------------------------------------
// 7b: cancellation abandons the request, and parent death retires the worker
// ---------------------------------------------------------------------------

test('AbortSignal abandons a replica query without killing the worker', { timeout: PROCESS_TEST_TIMEOUT_MS }, async (t) => {
  const fixture = await buildFixture(t);
  const transport = new ChildProcessReplicaTransport();
  const replica = await startReplica(transport, fixture, 'replica-cancel');
  t.after(async () => {
    await stopQuietly(transport, replica);
  });
  await transport.apply(replica, fixture.initialEnvelopes, { projectScope: SCOPE });

  const controller = new AbortController();
  const pending = transport.query(replica, probeRequest(fixture.root, 'proc-query-abort'), {
    signal: controller.signal,
    nodeTimeoutMs: 5_000,
  });
  controller.abort();
  await assert.rejects(
    () => pending,
    (error: unknown) => error instanceof ReplicaTransportError && error.code === 'REPLICA_QUERY_CANCELLED',
  );
  assert.equal(transport.isAlive(replica), true, 'cancelling one request must not terminate the replica');

  // A pre-aborted signal is refused before any byte reaches the child.
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    () => transport.query(replica, probeRequest(fixture.root, 'proc-query-abort-2'), { signal: aborted.signal }),
    /REPLICA_QUERY_CANCELLED/,
  );

  // The worker still serves afterwards; the late response was discarded.
  const status = await transport.status(replica);
  assert.equal(status.commitIndex, fixture.initialEnvelopes.length);
  const answer = await transport.query(replica, probeRequest(fixture.root, 'proc-query-after-abort'));
  assert.equal(answer.candidates.length > 0, true);
});

test('a worker whose parent disappears retires itself instead of lingering', { timeout: PROCESS_TEST_TIMEOUT_MS }, async (t) => {
  const fixture = await buildFixture(t);
  const child = spawn(process.execPath, [WORKER_PATH], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pid = child.pid as number;
  child.stdin.write(`${JSON.stringify({
    type: 'init',
    id: 'orphan-init',
    payload: { root: fixture.root, replicaId: 'replica-orphan', projectScope: SCOPE },
  })}\n`);
  await waitFor(() => processExists(pid), 3_000, 'worker startup');
  assert.equal(processExists(pid), true);

  // Closing stdin is the parent-death signal; no kill is involved.
  child.stdin.end();
  await waitFor(() => processExists(pid) === false, 3_000, 'worker exit on parent disappearance');
  assert.equal(processExists(pid), false);
});

// ---------------------------------------------------------------------------
// 8: capability boundary — no cross-machine claim
// ---------------------------------------------------------------------------
test('the transport declares child-process/in-process only and states cross-machine is unverified', async () => {
  assert.deepEqual([...REPLICA_TRANSPORT_KINDS], ['in-process', 'child-process']);
  const transportSource = readFileSync(TRANSPORT_SOURCE, 'utf8');
  assert.match(transportSource, /cross-machine/im, 'transport must name the cross-machine boundary');
  assert.match(transportSource, /unimplemented/i, 'cross-machine transport must be declared unimplemented');
  assert.doesNotMatch(transportSource, /createServer|net\.connect|\.listen\(/u, 'no listening socket may be opened');

  const workerSource = readFileSync(WORKER_PATH, 'utf8');
  assert.match(workerSource, /no network listener/u, 'worker must state it binds no port');

  const adr = readFileSync(fileURLToPath(new URL('../../docs/adr/ADR-011-distributed-probe.md', import.meta.url)), 'utf8');
  assert.match(adr, /明确未验证边界/u);
  assert.match(adr, /跨机器传输与真网络分区/u, 'cross-machine transport stays explicitly unverified');
});

// ---------------------------------------------------------------------------
// 9: resume bounds/cancellation and parent-liveness heartbeat
// ---------------------------------------------------------------------------

test('resume validates its bounds, honours cancellation and reports exhaustion', { timeout: PROCESS_TEST_TIMEOUT_MS }, async (t) => {
  const fixture = await buildFixture(t);
  const transport = new ChildProcessReplicaTransport();
  const replica = await startReplica(transport, fixture, 'replica-resume-faults');
  t.after(async () => {
    await stopQuietly(transport, replica);
  });
  await transport.apply(replica, fixture.initialEnvelopes, { projectScope: SCOPE });

  await assert.rejects(
    () => transport.resume(replica, async () => [], { maxChunks: 0 }),
    (error: unknown) => error instanceof ReplicaTransportError && error.code === 'REPLICA_RESUME_INVALID',
  );
  await assert.rejects(
    () => transport.resume(replica, async () => [], { maxChunks: 1.5 }),
    /REPLICA_RESUME_INVALID/,
  );

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => transport.resume(replica, async () => [], { signal: controller.signal }),
    (error: unknown) => error instanceof ReplicaTransportError && error.code === 'REPLICA_QUERY_CANCELLED',
  );

  // A pull that keeps returning events hits the chunk bound instead of looping forever.
  await assert.rejects(
    () => transport.resume(replica, async () => fixture.initialEnvelopes, { maxChunks: 1 }),
    (error: unknown) => error instanceof ReplicaTransportError && error.code === 'REPLICA_RESUME_EXHAUSTED',
  );
  assert.equal(transport.isAlive(replica), true, 'a resumed-but-unconverged call must not kill the replica');
});

test('an enabled heartbeat retires a quiet worker instead of letting it linger', { timeout: PROCESS_TEST_TIMEOUT_MS }, async (t) => {
  const child = spawn(process.execPath, [WORKER_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, REPLICA_WORKER_HEARTBEAT_MS: '250' },
  });
  const pid = child.pid as number;
  let stderrTail = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-2_000);
  });
  t.after(() => {
    try {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
    } catch {
      // already gone
    }
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('heartbeat worker did not retire itself')), 2_000);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  assert.match(stderrTail, /parent heartbeat lost/);
  await waitFor(() => processExists(pid) === false, 500, 'heartbeat worker pid to be reaped');
  assert.equal(processExists(pid), false);
});
