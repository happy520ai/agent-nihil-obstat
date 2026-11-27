import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import {
  createDefaultClusterPolicy,
  filterEventsForReplica,
  parseRemotePayload,
  revokeReplica,
  verifyRevoked,
  authorizeReplica,
  containsExecutableMarker,
} from '../../src/memory/cluster-policy.ts';
import { judgeConsistency } from '../../src/memory/cluster-consistency.ts';
import { ProbeStoreCacheError } from '../../src/memory/probe-store.ts';
import { distributedProbe, type DistributedReplicaNode } from '../../src/memory/distributed-probe.ts';
import {
  committedEnvelopeFromEvent,
  exportCommittedEvents,
  ReplicationError,
  type CommittedEventEnvelope,
} from '../../src/memory/replication.ts';
import {
  REPLICA_CURSOR_FILE,
  REPLICA_EVENTS_FILE,
  ReplicaStore,
} from '../../src/memory/replica.ts';
import {
  ChildProcessReplicaTransport,
  RemoteReplicaStore,
  ReplicaTransportError,
  type ReplicaHandle,
} from '../../src/memory/replica-transport.ts';

/**
 * T-130 integration red team: real OS child-process replicas plus real files in
 * a throwaway tmpdir are driven through slow-node, crash, duplicate,
 * out-of-order, permanent-gap, partition, mixed-version, cache-poisoning and
 * forged-replica faults. Every scenario asserts an explicit refusal/degradation
 * marker; no fault may be reported as COMPLETE.
 *
 * Boundaries: only `process.execPath`, repository source and the tmpdir are
 * touched. No network listener, no business project, no docs, no `.pm/`.
 */

const SCOPE = 'chaos';
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const AT = '2026-11-21T00:00:00.000Z';
/** Bounded per-test ceiling so a leaked worker fails fast instead of hanging the runner. */
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
    note_id: sha256(`chaos-note:${label}`),
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
  readonly entries: readonly ViewReplayEntry[];
  readonly envelopes: readonly CommittedEventEnvelope[];
}

/** A real ledger in a tmpdir with committed cross-domain events. */
async function buildFixture(t: TestContext, count = 6): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'ano replica chaos '));
  let tick = 1_000;
  const ledger = await Ledger.open(root, {
    sessionId: `replica-chaos-${ulid().slice(-8)}`,
    clock: () => {
      tick += 1;
      return tick;
    },
  });
  // Close the sqlite handle before unlinking the tree (Windows refuses otherwise).
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
      ? notePayload(`n${index}`, `replica chaos decision ${index}`)
      : memoryGenesis(`local.fact.${index}`, `replica chaos fact ${index}`);
    const kind: LedgerEvent['kind'] = index % 2 === 0 ? 'note.recorded' : 'memory.revised';
    const result = await ledger.append({ kind, payload }, `chaos-note-${index}`);
    assert.ok(result.event !== undefined, `append ${String(index)} produced no event`);
  }

  const entries = replayLedger(join(root, '.ano', 'ledger')).entries;
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
    entries,
    envelopes: exportCommittedEvents(ledger, { projectScope: SCOPE, limit: 1024 }).events,
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

async function startReplica(
  transport: ChildProcessReplicaTransport,
  fixture: Fixture,
  replicaId: string,
): Promise<ReplicaHandle> {
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
    // already gone; the leak assertions are the real check
  }
}

/** A local read-only store rebuilt from the same committed bytes as the replicas. */
function openLocalReplica(fixture: Fixture, t: TestContext, replicaId = 'local-primary'): ReplicaStore {
  const store = ReplicaStore.open({
    root: fixture.root,
    replicaId,
    projectScope: SCOPE,
    clusterEpoch: 'epoch-1',
    snapshot: fixture.snapshot,
  });
  store.rebuildFromEvents(fixture.envelopes);
  t.after(() => store.close());
  return store;
}

function fingerprintDirectory(directory: string): Map<string, string> {
  const files = new Map<string, string>();
  if (!existsSync(directory)) return files;
  const walk = (relative: string): void => {
    const absolute = relative.length === 0 ? directory : join(directory, relative);
    for (const name of readdirSync(absolute).sort()) {
      const childRelative = relative.length === 0 ? name : join(relative, name);
      const childAbsolute = join(directory, childRelative);
      if (statSync(childAbsolute).isDirectory()) walk(childRelative);
      else files.set(childRelative, sha256(readFileSync(childAbsolute).toString('latin1')));
    }
  };
  walk('');
  return files;
}

function nodeOutcome(answer: Awaited<ReturnType<typeof distributedProbe>>, replicaId: string): string {
  const report = answer.nodes.find((node) => node.replica_id === replicaId);
  assert.ok(report !== undefined, `missing node report for ${replicaId}`);
  return report.outcome;
}

// ---------------------------------------------------------------------------
// 1. Slow node: exceeds its deadline -> partial/degraded, never counted as success
// ---------------------------------------------------------------------------

test('a replica slower than its deadline degrades the probe with failed_nodes instead of being counted healthy', { timeout: PROCESS_TEST_TIMEOUT_MS }, async (t) => {
  const fixture = await buildFixture(t);
  const transport = new ChildProcessReplicaTransport();
  const fast = await startReplica(transport, fixture, 'r-fast');
  const slow = await startReplica(transport, fixture, 'r-slow');
  t.after(async () => {
    await stopQuietly(transport, fast);
    await stopQuietly(transport, slow);
  });
  await transport.apply(fast, fixture.envelopes, { projectScope: SCOPE });
  await transport.apply(slow, fixture.envelopes, { projectScope: SCOPE });

  const fastNode = await transport.toDistributedReplicaNode(fast);
  const slowNode: DistributedReplicaNode = {
    ...(await transport.toDistributedReplicaNode(slow)),
    query: async (request, context) => {
      await delay(150);
      return transport.query(slow, request, { signal: context.signal, nodeTimeoutMs: 5_000 });
    },
  };

  const started = Date.now();
  const answer = await distributedProbe(probeRequest(fixture.root, 'chaos-slow'), {
    localStore: openLocalReplica(fixture, t),
    replicas: [fastNode, slowNode],
    mode: 'QUORUM',
    primaryCommitIndex: fixture.envelopes.length,
    deadlineMs: 600,
    nodeTimeoutMs: 60,
  });
  const elapsed = Date.now() - started;

  assert.equal(nodeOutcome(answer, 'r-slow'), 'TIMEOUT', 'the slow node must not be reported OK');
  assert.equal(nodeOutcome(answer, 'r-fast'), 'OK');
  assert.ok(answer.partial.failed_nodes.includes('r-slow'), 'failed_nodes must name the slow node');
  assert.equal(answer.degraded, true, 'a timed-out node must degrade the answer');
  assert.equal(answer.requested_mode, 'QUORUM');
  assert.notEqual(answer.metadata.consistency, 'CONSISTENT');
  assert.notEqual(answer.outcome, 'CONSISTENT');
  // The healthy replica's bytes still answer the caller.
  assert.ok(answer.candidates.length > 0, 'the healthy replica must still supply usable evidence');
  assert.ok(elapsed < 4_000, `slow-node handling took ${String(elapsed)}ms`);

  const judgement = judgeConsistency(answer, { mode: 'QUORUM', primaryCommitIndex: fixture.envelopes.length });
  assert.equal(judgement.status, 'inconsistent');
  assert.equal(judgement.code, 'MODE_UNMET');
});

// ---------------------------------------------------------------------------
// 2. Process crash: fast REPLICA_NODE_EXITED, no fabricated COMPLETE, restart resumes
// ---------------------------------------------------------------------------

test('SIGKILL crashes a replica, fails the next query, never fakes COMPLETE, and restart resumes the cursor', { timeout: PROCESS_TEST_TIMEOUT_MS }, async (t) => {
  const fixture = await buildFixture(t);
  const transport = new ChildProcessReplicaTransport();
  const replica = await startReplica(transport, fixture, 'r-crash');
  t.after(async () => {
    await stopQuietly(transport, replica);
  });
  await transport.apply(replica, fixture.envelopes, { projectScope: SCOPE });
  const deadNode = await transport.toDistributedReplicaNode(replica);
  const pid = replica.pid as number;
  assert.equal(processExists(pid), true);
  assert.equal(process.kill(pid, 'SIGKILL'), true);
  await waitFor(() => transport.isAlive(replica) === false, 2_000, 'crash detection');
  await waitFor(() => processExists(pid) === false, 2_000, 'OS process reaping');

  const started = Date.now();
  await assert.rejects(
    () => transport.query(replica, probeRequest(fixture.root, 'chaos-dead')),
    (error: unknown) => error instanceof ReplicaTransportError && error.code === 'REPLICA_NODE_EXITED',
  );
  assert.ok(Date.now() - started < 1_000, 'a dead node must fail immediately');

  // The coordinator must degrade, never claim the requested QUORUM was reached.
  const degraded = await distributedProbe(probeRequest(fixture.root, 'chaos-dead-cluster'), {
    localStore: openLocalReplica(fixture, t),
    replicas: [deadNode],
    mode: 'QUORUM',
    primaryCommitIndex: fixture.envelopes.length,
  });
  assert.equal(degraded.requested_mode, 'QUORUM');
  assert.equal(degraded.metadata.mode, 'LOCAL');
  assert.equal(degraded.degraded, true);
  assert.notEqual(degraded.metadata.consistency, 'CONSISTENT');
  assert.ok(degraded.partial.failed_nodes.includes('r-crash'));
  const blocked = judgeConsistency(degraded, { mode: 'QUORUM', primaryCommitIndex: fixture.envelopes.length });
  assert.equal(blocked.status, 'inconsistent');
  assert.equal(blocked.code, 'MODE_UNMET');

  // Restart re-launches a live process against the persisted cursor and catches up.
  const late: ReadonlyArray<[{ readonly kind: LedgerEvent['kind']; readonly payload: Record<string, unknown> }, string]> = [
    [{ kind: 'note.recorded', payload: notePayload('late-0', 'post-crash decision') }, 'chaos-late-0'],
    [{ kind: 'memory.revised', payload: memoryGenesis('local.late', 'post-crash fact') }, 'chaos-late-1'],
  ];
  for (const [input, idemKey] of late) {
    const result = await fixture.ledger.append(input, idemKey);
    assert.ok(result.event !== undefined);
  }
  const primaryEntries = replayEntries(fixture.root);
  const restarted = await transport.restart(replica);
  t.after(async () => {
    await stopQuietly(transport, restarted);
  });
  assert.notEqual(restarted.pid, pid);
  assert.ok(restarted.pid !== null && processExists(restarted.pid));
  await waitFor(() => processExists(pid) === false, 5_000, 'the crashed pid to be reaped');
  assert.equal(processExists(pid), false);

  const resumedStatus = await transport.status(restarted);
  assert.equal(resumedStatus.commitIndex, fixture.envelopes.length, 'the persisted cursor must survive the crash');
  let firstCursor = -1;
  const finalStatus = await transport.resume(restarted, async (cursor) => {
    if (firstCursor === -1) {
      firstCursor = cursor.commitIndex;
      assert.equal(cursor.commitIndex, fixture.envelopes.length, 'resume starts strictly after the restored cursor');
    }
    return exportCommittedEvents(fixture.ledger, { fromCommitIndex: cursor.commitIndex, projectScope: SCOPE, limit: 1024 }).events;
  });
  assert.equal(firstCursor, fixture.envelopes.length);
  assert.equal(finalStatus.commitIndex, primaryEntries.length);
  assert.equal(finalStatus.viewDigest, viewDigest(primaryEntries));
});

// ---------------------------------------------------------------------------
// 3. Duplicate events: byte-level idempotent no-op
// ---------------------------------------------------------------------------

test('re-applying the same committed envelopes is an idempotent no-op with no duplicate file lines', { timeout: PROCESS_TEST_TIMEOUT_MS }, async (t) => {
  const fixture = await buildFixture(t);
  const transport = new ChildProcessReplicaTransport();
  const replica = await startReplica(transport, fixture, 'r-duplicate');
  t.after(async () => {
    await stopQuietly(transport, replica);
  });
  const first = await transport.apply(replica, fixture.envelopes, { projectScope: SCOPE });
  assert.equal(first.applied, fixture.envelopes.length);

  const directory = ReplicaStore.directoryFor(fixture.root, 'r-duplicate');
  const eventsBefore = readFileSync(join(directory, REPLICA_EVENTS_FILE));
  const cursorBefore = readFileSync(join(directory, REPLICA_CURSOR_FILE));

  const second = await transport.apply(replica, fixture.envelopes, { projectScope: SCOPE });
  assert.equal(second.applied, 0);
  assert.equal(second.duplicates, fixture.envelopes.length);
  assert.equal(second.outOfOrder, 0);
  assert.deepEqual(second.gaps, []);
  assert.equal(second.commitIndex, first.commitIndex);
  assert.equal(second.viewDigest, first.viewDigest);

  // A duplicate inside one batch is recognized by id too (one per repeated copy).
  const intra = await transport.apply(replica, [fixture.envelopes[0]!, fixture.envelopes[0]!], { projectScope: SCOPE });
  assert.equal(intra.duplicates, 2);
  assert.equal(intra.applied, 0);

  assert.deepEqual(readFileSync(join(directory, REPLICA_EVENTS_FILE)), eventsBefore, 'no duplicate event line may be persisted');
  assert.deepEqual(readFileSync(join(directory, REPLICA_CURSOR_FILE)), cursorBefore, 'the cursor must not move on duplicates');
});

// ---------------------------------------------------------------------------
// 4. Out-of-order events: gap buffer, then ordered application, cursor never jumps
// ---------------------------------------------------------------------------

test('out-of-order events buffer behind a gap and apply in order once the missing seq arrives', { timeout: PROCESS_TEST_TIMEOUT_MS }, async (t) => {
  const fixture = await buildFixture(t);
  const transport = new ChildProcessReplicaTransport();
  const replica = await startReplica(transport, fixture, 'r-ooo');
  t.after(async () => {
    await stopQuietly(transport, replica);
  });

  const buffered = await transport.apply(replica, [fixture.envelopes[1]!], { projectScope: SCOPE });
  assert.equal(buffered.outOfOrder, 1);
  assert.equal(buffered.commitIndex, 0, 'a gap must not advance the cursor');
  assert.deepEqual(buffered.gaps, [1]);
  assert.equal(buffered.complete, false);
  const midStatus = await transport.status(replica);
  assert.equal(midStatus.cursor.commitIndex, 0);
  assert.equal(midStatus.clusterMetadata.partial, true);

  const filled = await transport.apply(replica, [fixture.envelopes[0]!], { projectScope: SCOPE });
  assert.equal(filled.applied, 2, 'the buffered event flushes with the missing predecessor');
  assert.equal(filled.commitIndex, 2);
  assert.equal(filled.complete, true);

  // The persisted log matches a clean in-order rebuild byte for byte.
  const reference = ReplicaStore.open({
    root: fixture.root,
    replicaId: 'r-ooo-reference',
    projectScope: SCOPE,
    clusterEpoch: 'epoch-1',
    snapshot: fixture.snapshot,
  });
  t.after(() => reference.close());
  reference.rebuildFromEvents(fixture.envelopes.slice(0, 2));
  assert.deepEqual(
    readFileSync(join(ReplicaStore.directoryFor(fixture.root, 'r-ooo'), REPLICA_EVENTS_FILE)),
    readFileSync(join(reference.directory, REPLICA_EVENTS_FILE)),
  );
});

// ---------------------------------------------------------------------------
// 5. Permanent missing segment: cursor stays at the gap, resume never claims catch-up
// ---------------------------------------------------------------------------

test('a permanently missing segment keeps the cursor at the gap and resume reports exhaustion, not catch-up', { timeout: PROCESS_TEST_TIMEOUT_MS }, async (t) => {
  const fixture = await buildFixture(t);
  const transport = new ChildProcessReplicaTransport();
  const replica = await startReplica(transport, fixture, 'r-gap');
  t.after(async () => {
    await stopQuietly(transport, replica);
  });

  const tail = fixture.envelopes.slice(1);
  const report = await transport.apply(replica, tail, { projectScope: SCOPE });
  assert.equal(report.commitIndex, 0);
  assert.deepEqual(report.gaps, [1]);
  assert.equal(report.complete, false);
  assert.equal(report.pendingCount, tail.length);
  const metadata = (await transport.status(replica)).clusterMetadata;
  assert.equal(metadata.partial, true);
  assert.equal(metadata.commit_index, 0, 'a missing segment must not be reported as caught up');

  // The persisted cursor still refuses to advance after reopen.
  const reopened = ReplicaStore.open({
    root: fixture.root,
    replicaId: 'r-gap',
    projectScope: SCOPE,
    clusterEpoch: 'epoch-1',
    snapshot: fixture.snapshot,
  });
  t.after(() => reopened.close());
  assert.equal(reopened.commitIndex, 0);
  assert.equal(reopened.clusterMetadata().partial, true);
  assert.deepEqual(reopened.candidates(), [], 'a gapped replica must serve no partial Memory view');

  // A pull that can never deliver seq 1 must exhaust, never converge.
  let pulls = 0;
  await assert.rejects(
    () => transport.resume(replica, async (cursor) => {
      assert.equal(cursor.commitIndex, 0, 'resume must not advance past a permanent gap');
      pulls += 1;
      return tail;
    }, { maxChunks: 2 }),
    (error: unknown) => error instanceof ReplicaTransportError && error.code === 'REPLICA_RESUME_EXHAUSTED',
  );
  assert.equal(pulls, 2);
  assert.equal((await transport.status(replica)).commitIndex, 0);
});

// ---------------------------------------------------------------------------
// 6. Partition: unreachable replicas degrade each mode; insufficient QUORUM is MODE_UNMET
// ---------------------------------------------------------------------------

test('an unreachable replica degrades LOCAL/AS_OF/COMMITTED/QUORUM instead of claiming completeness', { timeout: PROCESS_TEST_TIMEOUT_MS }, async (t) => {
  const fixture = await buildFixture(t);
  const transport = new ChildProcessReplicaTransport();
  const replica = await startReplica(transport, fixture, 'r-partition');
  t.after(async () => {
    await stopQuietly(transport, replica);
  });
  await transport.apply(replica, fixture.envelopes, { projectScope: SCOPE });
  const node = await transport.toDistributedReplicaNode(replica);
  const pid = replica.pid as number;
  assert.equal(process.kill(pid, 'SIGKILL'), true);
  await waitFor(() => transport.isAlive(replica) === false, 2_000, 'partition detection');

  // LOCAL never touches replicas and keeps its local semantics.
  const local = await distributedProbe(probeRequest(fixture.root, 'chaos-partition-local'), {
    localStore: openLocalReplica(fixture, t),
    replicas: [node],
    mode: 'LOCAL',
  });
  assert.equal(local.mode, 'LOCAL');
  assert.equal(local.requested_mode, 'LOCAL');
  assert.equal(local.evidence_origin, 'local');

  // AS_OF cannot reach the target with the only replica gone.
  const asOf = await distributedProbe(probeRequest(fixture.root, 'chaos-partition-asof'), {
    localStore: openLocalReplica(fixture, t, 'local-asof'),
    replicas: [node],
    mode: 'AS_OF',
    asOfCommitIndex: fixture.envelopes.length,
  });
  assert.equal(asOf.requested_mode, 'AS_OF');
  assert.equal(asOf.metadata.mode, 'LOCAL');
  assert.equal(asOf.degraded, true);
  assert.notEqual(asOf.metadata.consistency, 'CONSISTENT');

  // COMMITTED cannot find a caught-up replica.
  const committed = await distributedProbe(probeRequest(fixture.root, 'chaos-partition-committed'), {
    localStore: openLocalReplica(fixture, t, 'local-committed'),
    replicas: [node],
    mode: 'COMMITTED',
    primaryCommitIndex: fixture.envelopes.length,
  });
  assert.equal(committed.requested_mode, 'COMMITTED');
  assert.equal(committed.metadata.mode, 'LOCAL');
  assert.equal(committed.degraded, true);
  assert.equal(committed.metadata.stop_reason, 'NODE_UNAVAILABLE');
  assert.notEqual(committed.metadata.consistency, 'CONSISTENT');
  assert.ok(committed.partial.failed_nodes.includes('r-partition'));
});

test('a QUORUM below the majority threshold downgrades to COMMITTED and judges MODE_UNMET, never COMPLETE', { timeout: PROCESS_TEST_TIMEOUT_MS }, async (t) => {
  const fixture = await buildFixture(t);
  const transport = new ChildProcessReplicaTransport();
  const survivor = await startReplica(transport, fixture, 'r-survivor');
  const victim = await startReplica(transport, fixture, 'r-victim');
  t.after(async () => {
    await stopQuietly(transport, survivor);
    await stopQuietly(transport, victim);
  });
  await transport.apply(survivor, fixture.envelopes, { projectScope: SCOPE });
  await transport.apply(victim, fixture.envelopes, { projectScope: SCOPE });
  const survivorNode = await transport.toDistributedReplicaNode(survivor);
  const victimNode = await transport.toDistributedReplicaNode(victim);
  const victimPid = victim.pid as number;
  assert.equal(process.kill(victimPid, 'SIGKILL'), true);
  await waitFor(() => transport.isAlive(victim) === false, 2_000, 'victim crash');

  const answer = await distributedProbe(probeRequest(fixture.root, 'chaos-quorum-short'), {
    localStore: openLocalReplica(fixture, t),
    replicas: [survivorNode, victimNode],
    mode: 'QUORUM',
    primaryCommitIndex: fixture.envelopes.length,
  });
  assert.equal(answer.requested_mode, 'QUORUM');
  assert.equal(answer.metadata.mode, 'COMMITTED', 'an insufficient quorum must say it downgraded');
  assert.equal(answer.degraded, true);
  assert.equal(answer.metadata.stop_reason, 'QUORUM_UNMET');
  assert.notEqual(answer.metadata.consistency, 'CONSISTENT');
  assert.notEqual(answer.outcome, 'CONSISTENT');
  assert.ok(answer.partial.failed_nodes.includes('r-victim'));

  const judgement = judgeConsistency(answer, { mode: 'QUORUM', primaryCommitIndex: fixture.envelopes.length });
  assert.equal(judgement.status, 'inconsistent');
  assert.equal(judgement.code, 'MODE_UNMET');
});

// ---------------------------------------------------------------------------
// 7. Mixed versions: event conflict, epoch mismatch and diverging commits
// ---------------------------------------------------------------------------

test('mixed replica versions are refused: event conflict, epoch mismatch and divergent commits never look healthy', { timeout: PROCESS_TEST_TIMEOUT_MS }, async (t) => {
  const fixture = await buildFixture(t);
  const transport = new ChildProcessReplicaTransport();

  // (a) Same event id, different committed bytes -> REPLICA_EVENT_CONFLICT, commit point unchanged.
  const conflicted = await startReplica(transport, fixture, 'r-conflict');
  t.after(async () => {
    await stopQuietly(transport, conflicted);
  });
  await transport.apply(conflicted, fixture.envelopes, { projectScope: SCOPE });
  const tamperedEvent = structuredClone(fixture.envelopes[0]!.event) as LedgerEvent;
  tamperedEvent.payload = { ...tamperedEvent.payload, text: 'a different committed decision' };
  const conflictingEnvelope = committedEnvelopeFromEvent(tamperedEvent, 1, fixture.envelopes[0]!.segment);
  await assert.rejects(
    () => transport.apply(conflicted, [conflictingEnvelope], { projectScope: SCOPE }),
    (error: unknown) => error instanceof ReplicaTransportError && error.code === 'REPLICA_EVENT_CONFLICT',
  );
  assert.equal((await transport.status(conflicted)).commitIndex, fixture.envelopes.length);

  // (b) Diverging replica commits -> explicit commit conflict + downgraded/inconsistent judgement.
  const full = await startReplica(transport, fixture, 'r-full');
  const lagging = await startReplica(transport, fixture, 'r-lagging');
  t.after(async () => {
    await stopQuietly(transport, full);
    await stopQuietly(transport, lagging);
  });
  await transport.apply(full, fixture.envelopes, { projectScope: SCOPE });
  await transport.apply(lagging, fixture.envelopes.slice(0, 4), { projectScope: SCOPE });
  const fullNode = await transport.toDistributedReplicaNode(full);
  const laggingNode = await transport.toDistributedReplicaNode(lagging);
  const mixed = await distributedProbe(probeRequest(fixture.root, 'chaos-mixed-commit'), {
    localStore: openLocalReplica(fixture, t),
    replicas: [fullNode, laggingNode],
    mode: 'QUORUM',
    primaryCommitIndex: fixture.envelopes.length,
  });
  assert.ok(mixed.conflicts.some((conflict) => conflict.kind === 'commit'), 'divergent commits must surface as a conflict');
  assert.equal(mixed.metadata.mode, 'COMMITTED');
  assert.notEqual(mixed.metadata.consistency, 'CONSISTENT');
  const mixedJudgement = judgeConsistency(mixed, { mode: 'QUORUM', primaryCommitIndex: fixture.envelopes.length });
  assert.equal(mixedJudgement.status, 'inconsistent');
  assert.equal(mixedJudgement.code, 'MODE_UNMET');

  // (c) Epoch mismatch refuses the node before any of its bytes are trusted.
  const epochNode = await transport.toDistributedReplicaNode(full);
  const epochAnswer = await distributedProbe(probeRequest(fixture.root, 'chaos-epoch'), {
    localStore: openLocalReplica(fixture, t, 'local-epoch'),
    replicas: [epochNode],
    mode: 'QUORUM',
    primaryCommitIndex: fixture.envelopes.length,
    clusterEpoch: 'epoch-2',
  });
  assert.equal(nodeOutcome(epochAnswer, 'r-full'), 'CLUSTER_EPOCH_MISMATCH');
  assert.equal(epochAnswer.metadata.mode, 'LOCAL');
  assert.equal(epochAnswer.degraded, true);
  assert.notEqual(epochAnswer.metadata.consistency, 'CONSISTENT');
});

// ---------------------------------------------------------------------------
// 8. Cache poisoning: tampered files fail closed with zero writes; remote cache freshness
// ---------------------------------------------------------------------------

test('poisoned replica files fail closed with zero writes and a poisoned view is never served', { timeout: PROCESS_TEST_TIMEOUT_MS }, async (t) => {
  const fixture = await buildFixture(t);
  const directory = ReplicaStore.directoryFor(fixture.root, 'r-poison');
  const seed = ReplicaStore.open({
    root: fixture.root,
    replicaId: 'r-poison',
    projectScope: SCOPE,
    clusterEpoch: 'epoch-1',
    snapshot: fixture.snapshot,
  });
  seed.rebuildFromEvents(fixture.envelopes);
  seed.close();
  const eventsPath = join(directory, REPLICA_EVENTS_FILE);
  const cursorPath = join(directory, REPLICA_CURSOR_FILE);

  const openPoisoned = (): void => {
    ReplicaStore.open({ root: fixture.root, replicaId: 'r-poison', projectScope: SCOPE, clusterEpoch: 'epoch-1', snapshot: fixture.snapshot });
  };

  // (a) Appended forged line.
  const forged = `${readFileSync(eventsPath, 'utf8')}${JSON.stringify({
    seq: fixture.envelopes.length + 1,
    segment: 'evil-segment',
    event: { id: 'NOT-A-ULID', hlc: { physical: 1, logical: 0, actor: 'attacker' }, actor: 'attacker', kind: 'note.recorded', payload: {}, prev_hash: '0'.repeat(64) },
  })}\n`;
  writeFileSync(eventsPath, forged);
  const forgedFingerprint = fingerprintDirectory(directory);
  assert.throws(openPoisoned, (error: unknown) => error instanceof ReplicationError && error.code === 'REPLICA_CORRUPT_EVENT');
  assert.deepEqual(fingerprintDirectory(directory), forgedFingerprint, 'opening a corrupt log must persist nothing');

  // (b) Truncated last line.
  const truncated = readFileSync(eventsPath, 'utf8').slice(0, -40);
  writeFileSync(eventsPath, truncated);
  const truncatedFingerprint = fingerprintDirectory(directory);
  assert.throws(openPoisoned, (error: unknown) => error instanceof ReplicationError && (error as ReplicationError).code === 'REPLICA_CORRUPT_EVENT');
  assert.deepEqual(fingerprintDirectory(directory), truncatedFingerprint, 'opening a truncated log must persist nothing');

  // (c) Cursor claiming progress it does not have.
  writeFileSync(eventsPath, `${fixture.envelopes.map((envelope) => JSON.stringify({ seq: envelope.seq, segment: envelope.segment, event: envelope.event })).join('\n')}\n`);
  const cursor = JSON.parse(readFileSync(cursorPath, 'utf8')) as { commitIndex: number };
  writeFileSync(cursorPath, `${JSON.stringify({ ...cursor, commitIndex: fixture.envelopes.length + 99 }, null, 2)}\n`);
  const cursorFingerprint = fingerprintDirectory(directory);
  assert.throws(openPoisoned, (error: unknown) => error instanceof ReplicationError && error.code === 'REPLICA_CURSOR_INVALID');
  assert.deepEqual(fingerprintDirectory(directory), cursorFingerprint, 'opening a diverged cursor must persist nothing');
});

test('RemoteReplicaStore is a cache: it throws before any round trip and refreshes only on status/query', { timeout: PROCESS_TEST_TIMEOUT_MS }, async (t) => {
  // Before the first status/query there is no remote evidence at all.
  const cold = new RemoteReplicaStore(() => null);
  assert.throws(() => cold.snapshot, (error: unknown) => error instanceof ProbeStoreCacheError);
  assert.throws(() => cold.candidates(), (error: unknown) => error instanceof ProbeStoreCacheError);

  const fixture = await buildFixture(t);
  const transport = new ChildProcessReplicaTransport();
  const replica = await startReplica(transport, fixture, 'r-cache');
  t.after(async () => {
    await stopQuietly(transport, replica);
  });
  await transport.apply(replica, fixture.envelopes, { projectScope: SCOPE });
  const node = await transport.toDistributedReplicaNode(replica);

  // A status round trip yields identity but no candidate bytes (the worker's
  // status body carries no records), so the cache is explicitly not a live view.
  assert.equal(node.store.snapshot.cluster?.replica_commit_index, fixture.envelopes.length);
  assert.deepEqual(node.store.candidates(), []);

  const answered = await distributedProbe(probeRequest(fixture.root, 'chaos-cache-query'), {
    localStore: openLocalReplica(fixture, t),
    replicas: [node],
    mode: 'COMMITTED',
    primaryCommitIndex: fixture.envelopes.length,
  });
  assert.equal(nodeOutcome(answered, 'r-cache'), 'OK');
  assert.ok(node.store.candidates().length > 0, 'only a query/status round trip refreshes the cache');

  // apply() does not refresh the cached snapshot: freshness comes from the most
  // recent status/query, never from an internal mutation.
  const extra = await fixture.ledger.append({ kind: 'note.recorded', payload: notePayload('cache-extra', 'one more decision') }, 'chaos-cache-extra');
  assert.ok(extra.event !== undefined);
  const extraEnvelope = exportCommittedEvents(fixture.ledger, { fromCommitIndex: fixture.envelopes.length, projectScope: SCOPE, limit: 1024 });
  await transport.apply(replica, extraEnvelope.events, { projectScope: SCOPE });
  assert.equal(node.store.snapshot.cluster?.replica_commit_index, fixture.envelopes.length, 'the cache is stale until the next status/query');
  const fresh = await transport.status(replica);
  assert.equal(fresh.commitIndex, fixture.envelopes.length + 1);
  assert.equal(node.store.snapshot.cluster?.replica_commit_index, fixture.envelopes.length + 1);
});

// ---------------------------------------------------------------------------
// 9. Forged replica: authorization, revocation, inert remote payloads, disabled egress
// ---------------------------------------------------------------------------

test('forged replicas are unauthorized/revoked/cross-scope and malicious remote payloads stay inert data', { timeout: PROCESS_TEST_TIMEOUT_MS }, async (t) => {
  const fixture = await buildFixture(t);
  const root = fixture.root;
  const base = createDefaultClusterPolicy(SCOPE, {
    root,
    replicas: [{ replicaId: 'r-chaos', allowedScopes: [SCOPE], operations: ['read', 'apply'] }],
  });
  assert.equal(base.networkEgress, 'disabled');

  const ghost = authorizeReplica(base, 'r-ghost', 'read', SCOPE);
  assert.equal(ghost.allowed, false);
  assert.equal(ghost.allowed === false ? ghost.code : '', 'REPLICA_NOT_AUTHORIZED');

  const foreign = authorizeReplica(base, 'r-chaos', 'read', 'other-project');
  assert.equal(foreign.allowed, false);
  assert.equal(foreign.allowed === false ? foreign.code : '', 'SCOPE_DENIED');

  const revoked = revokeReplica(base, 'r-chaos', { reason: 'compromise', actor: 'operator', at: '2026-11-24T01:02:03.000Z' });
  const revokedDecision = authorizeReplica(revoked, 'r-chaos', 'read', SCOPE);
  assert.equal(revokedDecision.allowed, false);
  assert.equal(revokedDecision.allowed === false ? revokedDecision.code : '', 'REPLICA_REVOKED');
  assert.deepEqual(verifyRevoked(revoked, 'r-chaos'), { revoked: true, revokedAt: '2026-11-24T01:02:03.000Z' });

  // A remote payload carrying executable-looking strings is data, never code.
  const sentinel = join(root, 'PWNED');
  const hostile = `require('child_process').execSync('node -e "require(\\'fs\\').writeFileSync(\\'${sentinel}\\', \\'pwned\\')\")'); process.exit(1)`;
  const remote = parseRemotePayload({ script: hostile, exit: 'process.exit(1)' });
  assert.equal(Object.isFrozen(remote), true, 'parseRemotePayload returns a frozen copy');
  assert.equal(containsExecutableMarker(remote), true);
  const filtered = filterEventsForReplica(
    [{ seq: 1, eventId: 'EV1', hash: 'a'.repeat(64), kind: 'note.recorded', payload: { text: hostile } }],
    base,
  );
  assert.equal(filtered.kept.length, 1, 'hostile text is carried as data, not executed');
  assert.equal(existsSync(sentinel), false, 'remote payload produced a filesystem side effect');

  // The real child process enforces the same boundary on an inbound batch.
  const transport = new ChildProcessReplicaTransport();
  const replica = await startReplica(transport, fixture, 'r-chaos-real');
  t.after(async () => {
    await stopQuietly(transport, replica);
  });
  await assert.rejects(
    () => transport.apply(replica, fixture.envelopes, { projectScope: 'other-project' }),
    (error: unknown) => error instanceof ReplicaTransportError && error.code === 'SCOPE_DENIED',
  );
  // A refused foreign batch leaves the replica empty and usable for its own scope.
  await transport.apply(replica, fixture.envelopes, { projectScope: SCOPE });
  assert.equal((await transport.status(replica)).commitIndex, fixture.envelopes.length);

  const hostileResult = await fixture.ledger.append({
    kind: 'note.recorded',
    payload: notePayload('hostile', hostile),
  }, 'chaos-hostile-note');
  assert.ok(hostileResult.event !== undefined);
  const hostileBatch = exportCommittedEvents(fixture.ledger, { fromCommitIndex: fixture.envelopes.length, projectScope: SCOPE, limit: 1024 });
  await transport.apply(replica, hostileBatch.events, { projectScope: SCOPE });
  const reread = await transport.query(replica, probeRequest(fixture.root, 'chaos-hostile-read', { required_facts: [] }));
  const contents = reread.candidates.map((candidate) => candidate.content);
  assert.ok(contents.some((content) => content.includes('process.exit(1)')), 'hostile text must round-trip as inert data');
  assert.equal(existsSync(sentinel), false, 'replica ingestion must never execute payload text');
});
