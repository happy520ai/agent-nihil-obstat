import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test, { type TestContext } from 'node:test';
import { hashEvent, type LedgerEvent } from '../../src/ledger/event.ts';
import { Ledger } from '../../src/ledger/ledger.ts';
import { replayLedger } from '../../src/ledger/replay.ts';
import { viewDigest, type ViewReplayEntry } from '../../src/ledger/views.ts';
import { assertClusterProjectScope, type AnchorProbeSnapshot } from '../../src/memory/probe-contract.ts';
import { ProjectedProbeStore } from '../../src/memory/probe-store.ts';
import {
  committedEnvelopeFromEvent,
  exportCommittedEvents,
  ReplicationError,
  resumeFrom,
  type CommittedEventEnvelope,
} from '../../src/memory/replication.ts';
import { ReplicaStore } from '../../src/memory/replica.ts';

/**
 * T-125 (DC-03) integration: a real ledger in a tmpdir is exported as committed
 * events and rebuilt into an independent read-only replica. The projection is
 * the primary's `src/ledger/views.ts` path; equivalence is asserted on the
 * digest, on ProbeStore query results and on persisted bytes.
 */

const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const AT = '2026-11-21T00:00:00.000Z';
const SCOPE = 'fixture';

async function rootFor(t: TestContext, prefix = 'ano-memory-replication-'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function notePayload(label: string, text: string): Record<string, unknown> {
  return {
    note_id: sha256(`int-note:${label}`),
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

/** Byte fingerprint of every file under `directory`, keyed by relative path. */
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

function expectReplicationError(run: () => unknown, code: string): ReplicationError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof ReplicationError, `expected ReplicationError, got ${String(error)}`);
    assert.equal(error.code, code, `expected ${code}, got ${String(error)}`);
    return error;
  }
  assert.fail(`expected ${code} to be thrown`);
}

interface Fixture {
  readonly root: string;
  readonly ledgerDir: string;
  readonly ledger: Ledger;
  readonly entries: readonly ViewReplayEntry[];
  readonly envelopes: readonly CommittedEventEnvelope[];
  readonly snapshot: AnchorProbeSnapshot;
}

/** A real ledger with six committed cross-domain events in one session. */
async function buildRealLedger(t: TestContext): Promise<Fixture> {
  const root = await rootFor(t);
  let tick = 1000;
  const ledger = await Ledger.open(root, {
    sessionId: 'replication-A',
    clock: () => {
      tick += 1;
      return tick;
    },
  });

  const append = async (kind: LedgerEvent['kind'], payload: Record<string, unknown>, idemKey: string): Promise<LedgerEvent> => {
    const result = await ledger.append({ kind, payload }, idemKey);
    if (result.event === undefined) throw new Error(`append ${kind} produced no event`);
    return result.event;
  };

  const note1 = await append('note.recorded', notePayload('one', 'Legacy lease decision'), 'int-note-one');
  const engineV1 = await append('memory.revised', memoryGenesis('local.storage.engine', 'SQLite'), 'int-engine-v1');
  const engineV2 = await append('memory.revised', {
    intent: 'revise',
    fact_key: 'local.storage.engine',
    record: { text: 'SQLite with FTS5', kind: 'decision', anchor: { file: 'src/a.ts', symbolId: 'sym-a' } },
    supersedes: [engineV1.id],
    reason: 'add fts',
    effective_from: null,
    effective_to: null,
  }, 'int-engine-v2');
  await append('memory.related', {
    edge: 'depends_on',
    from_ref: engineV2.id,
    to_ref: note1.id,
    reason: 'engine decision explains the legacy lease',
  }, 'int-related-engine-note');
  await append('memory.revised', memoryGenesis('local.retention.policy', 'Keep 30 days'), 'int-retention-v1');
  await append('note.recorded', notePayload('two', 'Do not replicate secret material verbatim'), 'int-note-two');
  ledger.close();

  const ledgerDir = join(root, '.ano', 'ledger');
  const entries = replayLedger(ledgerDir).entries;
  return {
    root,
    ledgerDir,
    ledger,
    entries,
    envelopes: entries.map((entry, index) => committedEnvelopeFromEvent(entry.event, index + 1, entry.segment)),
    snapshot: {
      project_scope: SCOPE,
      ledger_digest: viewDigest(entries),
      graph_revision: HASH_B,
      source_fingerprint: HASH_C,
      connected_digest: null,
    },
  };
}

function openReplica(fixture: Fixture, t: TestContext, replicaId = 'replica-a', projectScope = SCOPE): ReplicaStore {
  const replica = ReplicaStore.open({
    root: fixture.root,
    replicaId,
    projectScope,
    clusterEpoch: 'epoch-1',
    snapshot: fixture.snapshot,
  });
  t.after(() => replica.close());
  return replica;
}

test('a real ledger rebuilds an equivalent read-only replica from empty', async (t) => {
  const fixture = await buildRealLedger(t);
  const ledgerBefore = fingerprintDirectory(fixture.ledgerDir);
  const hashesBefore = fixture.entries.map((entry) => hashEvent(entry.event));

  const exported = exportCommittedEvents(fixture.ledger, { projectScope: SCOPE, limit: 1024 });
  assert.equal(exported.project_scope, SCOPE);
  assert.equal(exported.primary_commit_index, fixture.entries.length);
  assert.equal(exported.view_digest, viewDigest(fixture.entries));
  assert.equal(exported.truncated, false);
  assert.deepEqual(exported.events.map((envelope) => envelope.seq), fixture.entries.map((_, index) => index + 1));
  for (let index = 0; index < fixture.entries.length; index += 1) {
    const entry = fixture.entries[index]!;
    const envelope = exported.events[index]!;
    assert.equal(envelope.eventId, entry.event.id);
    assert.equal(envelope.hash, hashEvent(entry.event));
    assert.equal(envelope.kind, entry.event.kind);
    assert.equal(envelope.segment, entry.segment);
    assert.equal(envelope.prevHash, entry.event.prev_hash);
    assert.equal(envelope.recordedAt, new Date(entry.event.hlc.physical).toISOString());
  }

  // Export alone is read-only.
  assert.deepEqual(fingerprintDirectory(fixture.ledgerDir), ledgerBefore);

  const replica = openReplica(fixture, t);
  const report = replica.rebuildFromEvents(exported.events);
  assert.equal(report.applied, fixture.entries.length);
  assert.equal(report.duplicates, 0);
  assert.equal(report.commitIndex, fixture.entries.length);
  assert.equal(report.complete, true);
  assert.equal(replica.commitIndex, fixture.entries.length);
  assert.equal(replica.viewDigest, viewDigest(fixture.entries));
  assert.equal(replica.maxLag(fixture.entries.length + 5), 5);
  assert.equal(replica.replicaCommitIndex(), fixture.entries.length);

  // Same projection semantics as the primary backend.
  const projected = ProjectedProbeStore.create(fixture.entries, fixture.snapshot);
  try {
    assert.deepEqual(replica.candidates(), projected.candidates());
    assert.deepEqual(replica.adjacency(), projected.adjacency());
    assert.equal(replica.evidence(projected.candidates()[0]!.record_ref)?.record_ref, projected.candidates()[0]!.record_ref);
    assert.equal(replica.status(projected.candidates()[0]!.record_ref)?.record_ref, projected.candidates()[0]!.record_ref);
    assert.equal(replica.provenance(projected.candidates()[0]!.record_ref)?.record_ref, projected.candidates()[0]!.record_ref);
  } finally {
    projected.close();
  }

  const metadata = replica.clusterMetadata();
  assert.equal(metadata.project_scope, SCOPE);
  assert.equal(metadata.cluster_epoch, 'epoch-1');
  assert.equal(metadata.commit_index, fixture.entries.length);
  assert.equal(metadata.replica_id, 'replica-a');
  assert.equal(metadata.replica_commit_index, fixture.entries.length);
  assert.equal(metadata.consistency, 'local');
  assert.equal(metadata.partial, false);
  assert.match(metadata.evidence_digest, /^[a-f0-9]{64}$/u);

  const identity = replica.snapshotIdentity();
  assert.equal(identity.ledger_digest, viewDigest(fixture.entries));
  assert.equal(identity.replica_id, 'replica-a');
  assert.equal(identity.replica_commit_index, fixture.entries.length);
  assert.equal(identity.commit_index, fixture.entries.length);
  assert.equal(identity.cluster_epoch, 'epoch-1');
  assert.equal(identity.evidence_digest, metadata.evidence_digest);

  // Replica construction never touched the authoritative ledger.
  assert.deepEqual(fingerprintDirectory(fixture.ledgerDir), ledgerBefore);
  assert.deepEqual(replayLedger(fixture.ledgerDir).entries.map((entry) => hashEvent(entry.event)), hashesBefore);
});

test('incremental application reaches the same view as a full rebuild', async (t) => {
  const fixture = await buildRealLedger(t);
  const exported = exportCommittedEvents(fixture.ledger, { projectScope: SCOPE, limit: 1024 });
  const split = Math.floor(exported.events.length / 2);
  const first = exported.events.slice(0, split);
  const second = exported.events.slice(split);

  const incremental = openReplica(fixture, t, 'replica-incremental');
  const firstReport = incremental.applyCommitted(first, { projectScope: SCOPE });
  assert.equal(firstReport.applied, first.length);
  assert.equal(incremental.commitIndex, first.length);
  const resume = incremental.resumePullRequest();
  assert.deepEqual(resume, {
    fromCommitIndex: first.length,
    expectedViewDigest: viewDigest(fixture.entries.slice(0, first.length)),
    lastEventId: first.at(-1)!.eventId,
  });

  const pull = exportCommittedEvents(fixture.ledger, { fromCommitIndex: resume.fromCommitIndex, limit: 1024 });
  assert.equal(pull.events.length, second.length);
  const secondReport = incremental.applyCommitted(pull.events);
  assert.equal(secondReport.applied, second.length);
  assert.equal(incremental.commitIndex, fixture.entries.length);
  assert.equal(incremental.viewDigest, viewDigest(fixture.entries));

  const full = openReplica(fixture, t, 'replica-full');
  full.rebuildFromEvents(exported.events);
  assert.equal(full.viewDigest, incremental.viewDigest);
  assert.deepEqual(full.candidates(), incremental.candidates());
  assert.deepEqual(full.adjacency(), incremental.adjacency());
  const fullIdentity = full.snapshotIdentity();
  const incrementalIdentity = incremental.snapshotIdentity();
  assert.equal(fullIdentity.fingerprint, incrementalIdentity.fingerprint);
  assert.equal(fullIdentity.ledger_digest, incrementalIdentity.ledger_digest);
  assert.equal(fullIdentity.evidence_digest, incrementalIdentity.evidence_digest);
  assert.equal(fullIdentity.commit_index, incrementalIdentity.commit_index);
  assert.equal(fullIdentity.replica_id, 'replica-full');
  assert.equal(incrementalIdentity.replica_id, 'replica-incremental');

  // Resume round-trips through the exported cursor shape.
  assert.deepEqual(resumeFrom(incremental.cursor), {
    fromCommitIndex: fixture.entries.length,
    expectedViewDigest: viewDigest(fixture.entries),
    lastEventId: exported.events.at(-1)!.eventId,
  });
});

test('duplicate batches are a byte-level no-op', async (t) => {
  const fixture = await buildRealLedger(t);
  const exported = exportCommittedEvents(fixture.ledger, { projectScope: SCOPE, limit: 1024 });
  const replica = openReplica(fixture, t);
  replica.rebuildFromEvents(exported.events);

  const eventsBytes = readFileSync(replica.eventsPath);
  const cursorBytes = readFileSync(replica.cursorPath);
  const candidates = replica.candidates();
  const digest = replica.viewDigest;
  const ledgerBefore = fingerprintDirectory(fixture.ledgerDir);

  const duplicate = replica.applyCommitted(exported.events);
  assert.equal(duplicate.applied, 0);
  assert.equal(duplicate.duplicates, exported.events.length);
  assert.equal(duplicate.outOfOrder, 0);
  assert.deepEqual(duplicate.gaps, []);
  assert.equal(duplicate.commitIndex, fixture.entries.length);
  assert.equal(duplicate.viewDigest, digest);
  assert.equal(replica.viewDigest, digest);
  assert.deepEqual(readFileSync(replica.eventsPath), eventsBytes);
  assert.deepEqual(readFileSync(replica.cursorPath), cursorBytes);
  assert.deepEqual(replica.candidates(), candidates);
  assert.deepEqual(fingerprintDirectory(fixture.ledgerDir), ledgerBefore);
});

test('out-of-order, gap, corrupt and chain-broken batches fail closed without half state', async (t) => {
  const fixture = await buildRealLedger(t);
  const exported = exportCommittedEvents(fixture.ledger, { projectScope: SCOPE, limit: 1024 });
  const ledgerBefore = fingerprintDirectory(fixture.ledgerDir);
  const total = exported.events.length;

  // Out-of-order / missing segment: pulling only the tail into an empty replica.
  const tail = exported.events.slice(2);
  const gapped = openReplica(fixture, t, 'replica-gapped');
  const tailReport = gapped.applyCommitted(tail);
  assert.equal(tailReport.outOfOrder, tail.length);
  assert.equal(tailReport.commitIndex, 0);
  assert.equal(tailReport.pendingCount, tail.length);
  assert.equal(tailReport.complete, false);
  assert.deepEqual(tailReport.gaps, [1, 2]);
  assert.deepEqual(gapped.candidates(), [], 'no partial Memory/Probe view may be served from a gap');
  assert.equal(gapped.maxLag(total), total);
  assert.equal(existsSync(gapped.eventsPath), true);
  const gapFingerprint = fingerprintDirectory(gapped.directory);

  // Recovery: resuming from the empty cursor pulls the full history and fills it.
  const resumePull = exportCommittedEvents(fixture.ledger, { fromCommitIndex: gapped.cursor.commitIndex, limit: 1024 });
  const recovered = gapped.applyCommitted(resumePull.events);
  assert.equal(recovered.duplicates, tail.length);
  assert.equal(recovered.commitIndex, total);
  assert.equal(gapped.viewDigest, viewDigest(fixture.entries));
  const gapProjected = ProjectedProbeStore.create(fixture.entries, fixture.snapshot);
  try {
    assert.deepEqual(gapped.candidates(), gapProjected.candidates());
    assert.deepEqual(gapped.adjacency(), gapProjected.adjacency());
  } finally {
    gapProjected.close();
  }

  // Corrupt event: valid structure, hash no longer matches the committed bytes.
  const corrupt = openReplica(fixture, t, 'replica-corrupt');
  const corruptEnvelope = { ...exported.events[1]!, event: { ...exported.events[1]!.event, payload: { ...exported.events[1]!.event.payload, text: 'tampered' } }, payload: { ...exported.events[1]!.event.payload, text: 'tampered' } };
  const corruptFingerprint = fingerprintDirectory(corrupt.directory);
  expectReplicationError(() => corrupt.applyCommitted([corruptEnvelope]), 'REPLICA_CORRUPT_EVENT');
  assert.equal(corrupt.commitIndex, 0);
  assert.deepEqual(fingerprintDirectory(corrupt.directory), corruptFingerprint, 'a rejected batch persists nothing');

  // Structural corruption: the event fails the frozen ledger schema.
  const invalid = openReplica(fixture, t, 'replica-invalid');
  const invalidEnvelope = { ...exported.events[1]!, event: { ...exported.events[1]!.event, id: 'not-a-ulid' } };
  expectReplicationError(() => invalid.applyCommitted([invalidEnvelope]), 'REPLICA_CORRUPT_EVENT');

  // Chain break: bytes and hash agree, but prev_hash does not extend seq 1.
  const broken = openReplica(fixture, t, 'replica-chain');
  broken.applyCommitted([exported.events[0]!]);
  const brokenLink = structuredClone(exported.events[1]!.event) as LedgerEvent;
  brokenLink.prev_hash = '0'.repeat(64);
  const brokenEnvelope = committedEnvelopeFromEvent(brokenLink, 2, exported.events[1]!.segment);
  const chainFingerprint = fingerprintDirectory(broken.directory);
  expectReplicationError(() => broken.applyCommitted([brokenEnvelope]), 'REPLICA_CHAIN_BREAK');
  assert.equal(broken.commitIndex, 1);
  assert.deepEqual(fingerprintDirectory(broken.directory), chainFingerprint, 'a chain break leaves no buffered/committed residue');

  // Identity conflict: same event id, different committed bytes/hash.
  const conflicting = openReplica(fixture, t, 'replica-conflict');
  conflicting.applyCommitted(exported.events);
  const sameIdDifferentBytes = structuredClone(exported.events[1]!.event) as LedgerEvent;
  sameIdDifferentBytes.payload = { ...sameIdDifferentBytes.payload, reason: 'a different decision' };
  const conflictEnvelope = committedEnvelopeFromEvent(sameIdDifferentBytes, 2, exported.events[1]!.segment);
  expectReplicationError(() => conflicting.applyCommitted([conflictEnvelope]), 'REPLICA_EVENT_CONFLICT');

  // A tampered attempt never rewrote the main ledger.
  assert.deepEqual(fingerprintDirectory(fixture.ledgerDir), ledgerBefore);
});

test('cross-scope batches are refused and the replica directory never writes the ledger', async (t) => {
  const fixture = await buildRealLedger(t);
  const exported = exportCommittedEvents(fixture.ledger, { projectScope: SCOPE, limit: 1024 });
  const ledgerBefore = fingerprintDirectory(fixture.ledgerDir);

  const foreign = ReplicaStore.open({ root: fixture.root, replicaId: 'replica-foreign', projectScope: 'other-project', snapshot: fixture.snapshot });
  t.after(() => foreign.close());
  expectReplicationError(() => foreign.applyCommitted(exported.events, { projectScope: SCOPE }), 'SCOPE_DENIED');
  assert.equal(foreign.commitIndex, 0);
  assert.throws(() => assertClusterProjectScope(foreign.clusterMetadata(), SCOPE), /SCOPE_DENIED/);

  // Write-shaped APIs do not exist except to refuse.
  const replica = openReplica(fixture, t);
  replica.rebuildFromEvents(exported.events);
  for (const attempt of [
    (): unknown => replica.append({ kind: 'note.recorded', payload: {} }),
    (): unknown => replica.writeNote('nope'),
    (): unknown => replica.recordTrack('a', 'b'),
  ]) {
    expectReplicationError(attempt, 'REPLICA_WRITE_FORBIDDEN');
  }
  assert.equal(replica.commitIndex, fixture.entries.length);

  // Isolation: replica material lives only under .ano/replicas/<id>/.
  assert.equal(replica.directory, ReplicaStore.directoryFor(fixture.root, 'replica-a'));
  assert.ok(replica.eventsPath.startsWith(`${replica.directory}${sep}`));
  assert.ok(replica.cursorPath.startsWith(`${replica.directory}${sep}`));
  const replicaFiles = [...fingerprintDirectory(replica.directory).keys()];
  assert.ok(replicaFiles.length >= 2, 'events and cursor are persisted');
  for (const relative of replicaFiles) {
    const absolute = resolve(replica.directory, relative);
    assert.ok(absolute.startsWith(`${replica.directory}${sep}`), `replica file escaped its directory: ${absolute}`);
    assert.ok(!relative.split(/[\\/]/u).includes('ledger'), 'replica material must not impersonate the ledger directory');
  }
  assert.deepEqual(fingerprintDirectory(fixture.ledgerDir), ledgerBefore);
});

test('resume survives reopen and the original ledger stays byte-identical', async (t) => {
  const fixture = await buildRealLedger(t);
  const exported = exportCommittedEvents(fixture.ledger, { projectScope: SCOPE, limit: 1024 });
  const ledgerBefore = fingerprintDirectory(fixture.ledgerDir);
  const hashesBefore = fixture.entries.map((entry) => hashEvent(entry.event));

  const firstHalf = exported.events.slice(0, 3);
  const replica = ReplicaStore.open({
    root: fixture.root,
    replicaId: 'replica-resume',
    projectScope: SCOPE,
    clusterEpoch: 'epoch-1',
    snapshot: fixture.snapshot,
  });
  replica.applyCommitted(firstHalf);
  const cursorBeforeClose = replica.cursor;
  replica.close();

  const reopened = ReplicaStore.open({
    root: fixture.root,
    replicaId: 'replica-resume',
    projectScope: SCOPE,
    clusterEpoch: 'epoch-1',
    snapshot: fixture.snapshot,
  });
  t.after(() => reopened.close());
  assert.equal(reopened.commitIndex, firstHalf.length);
  assert.deepEqual(reopened.cursor, cursorBeforeClose);

  const remaining = exportCommittedEvents(fixture.ledger, { fromCommitIndex: reopened.cursor.commitIndex, limit: 1024 });
  assert.equal(remaining.events.length, exported.events.length - firstHalf.length);
  reopened.applyCommitted(remaining.events);
  assert.equal(reopened.viewDigest, viewDigest(fixture.entries));
  assert.deepEqual(reopened.cursor, {
    commitIndex: fixture.entries.length,
    lastEventId: exported.events.at(-1)!.eventId,
    lastEventHash: exported.events.at(-1)!.hash,
    viewDigest: viewDigest(fixture.entries),
    clusterEpoch: 'epoch-1',
    replicaId: 'replica-resume',
  });

  // Every operation above was read-only with respect to the authoritative ledger.
  assert.deepEqual(fingerprintDirectory(fixture.ledgerDir), ledgerBefore);
  assert.deepEqual(replayLedger(fixture.ledgerDir).entries.map((entry) => hashEvent(entry.event)), hashesBefore);
});
