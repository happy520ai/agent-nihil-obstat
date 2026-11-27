import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import test, { type TestContext } from 'node:test';
import { genesisHash, hashEvent, ledgerEventSchema, type LedgerEvent } from '../../src/ledger/event.ts';
import { Ledger } from '../../src/ledger/ledger.ts';
import { replayLedger } from '../../src/ledger/replay.ts';
import { viewDigest, type ViewReplayEntry } from '../../src/ledger/views.ts';
import type { AnchorProbeSnapshot } from '../../src/memory/probe-contract.ts';
import { ProjectedProbeStore } from '../../src/memory/probe-store.ts';
import {
  applyEventBatch,
  assertCursorMatchesState,
  assertReplicaCursor,
  committedEnvelopeFromEvent,
  cursorFromState,
  emptyReplicaApplyState,
  exportCommittedEvents,
  replicaGaps,
  ReplicationError,
  resumeFrom,
  screenSensitiveText,
  sensitivePathReason,
  type CommittedEventEnvelope,
  type ReplicaApplyState,
} from '../../src/memory/replication.ts';
import { ReplicaStore } from '../../src/memory/replica.ts';

/**
 * T-125 (DC-03): committed-event replication and read-only replica rebuild.
 *
 * Unit coverage for the four handling classes (idempotent / out-of-order /
 * gap / corrupt) plus cursor resume and the ReplicaStore write boundary. The
 * projection is always the primary's `src/ledger/views.ts` path, never a
 * replica-local reimplementation.
 */

const ENGINE = 'local.storage.engine';
const RETENTION = 'local.retention.policy';
const BASE_SNAPSHOT: AnchorProbeSnapshot = {
  project_scope: 'fixture',
  ledger_digest: '0'.repeat(64),
  graph_revision: null,
  source_fingerprint: null,
  connected_digest: null,
};

// ---------------------------------------------------------------------------
// Standalone event-chain helpers (no ledger dependency)
// ---------------------------------------------------------------------------

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let ulidCounter = 0;

function nextUlid(): string {
  ulidCounter += 1;
  let bits = (BigInt(Date.now()) << 32n) | BigInt(ulidCounter);
  bits &= (1n << 130n) - 1n;
  let out = '';
  for (let index = 0; index < 26; index += 1) {
    out += ULID_ALPHABET[Number(bits & 31n)];
    bits >>= 5n;
  }
  return out;
}

let physicalTick = 1_000_000;

function makeEvent(
  prevHash: string,
  kind: LedgerEvent['kind'],
  payload: Record<string, unknown>,
  options: { id?: string; idemKey?: string } = {},
): LedgerEvent {
  physicalTick += 1;
  return ledgerEventSchema.parse({
    id: options.id ?? nextUlid(),
    hlc: { physical: physicalTick, logical: 1, actor: 'replica-unit' },
    actor: 'replica-unit',
    kind,
    payload,
    ...(options.idemKey === undefined ? {} : { idem_key: options.idemKey }),
    prev_hash: prevHash,
  });
}

interface ChainStep {
  readonly kind: LedgerEvent['kind'];
  readonly payload: Record<string, unknown>;
  readonly idemKey?: string;
  readonly id?: string;
  /** Payload `supersedes` becomes `[previousEvent.id]` for projection validity. */
  readonly supersedesPrevious?: boolean;
}

/** Events chained from genesis, matching `eventChain`'s per-segment semantics. */
function buildChain(steps: readonly ChainStep[], segment = 'unit-seg'): LedgerEvent[] {
  let previous = genesisHash;
  let previousId: string | undefined;
  const events: LedgerEvent[] = [];
  for (const step of steps) {
    const payload = step.supersedesPrevious && previousId !== undefined
      ? { ...step.payload, supersedes: [previousId] }
      : step.payload;
    const event = makeEvent(previous, step.kind, payload, {
      ...(step.id === undefined ? {} : { id: step.id }),
      ...(step.idemKey === undefined ? {} : { idemKey: step.idemKey }),
    });
    events.push(event);
    previous = hashEvent(event);
    previousId = event.id;
  }
  return events;
}

function envelopesOf(events: readonly LedgerEvent[], segment = 'unit-seg'): CommittedEventEnvelope[] {
  return events.map((event, index) => committedEnvelopeFromEvent(event, index + 1, segment));
}

function viewEntriesOf(events: readonly LedgerEvent[], segment = 'unit-seg'): ViewReplayEntry[] {
  return events.map((event) => ({ event, segment }));
}

function memoryGenesis(factKey: string, text: string): ChainStep {
  return {
    kind: 'memory.revised',
    idemKey: `unit-${factKey}-genesis`,
    payload: {
      intent: 'revise',
      fact_key: factKey,
      record: { text, kind: 'decision', anchor: { file: 'src/unit.ts', symbolId: 'sym-unit' } },
      supersedes: [],
      reason: 'genesis',
      effective_from: null,
      effective_to: null,
    },
  };
}

function memorySupersede(factKey: string, text: string, supersedes: readonly string[]): ChainStep {
  return {
    kind: 'memory.revised',
    idemKey: `unit-${factKey}-${supersedes.length + 1}`,
    payload: {
      intent: 'revise',
      fact_key: factKey,
      record: { text, kind: 'decision', anchor: { file: 'src/unit.ts', symbolId: 'sym-unit' } },
      supersedes: [...supersedes],
      reason: 'update',
      effective_from: null,
      effective_to: null,
    },
  };
}

function noteStep(text: string): ChainStep {
  return {
    kind: 'note.recorded',
    idemKey: `unit-note-${text}`,
    payload: {
      note_id: createHash('sha256').update(`note:${text}`).digest('hex'),
      kind: 'decision',
      text,
      created_at: '2026-11-21T00:00:00.000Z',
      anchor: { file: 'src/unit.ts', symbolId: 'sym-unit' },
    },
  };
}

function sampleSteps(): ChainStep[] {
  return [
    memoryGenesis(ENGINE, 'SQLite'),
    { ...memorySupersede(ENGINE, 'SQLite with FTS5', []), supersedesPrevious: true },
    memoryGenesis(RETENTION, 'Keep 30 days'),
    noteStep('Legacy lease decision'),
  ];
}

function expectReplicationError(run: () => unknown, code: string): ReplicationError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof ReplicationError, `expected ReplicationError, got ${String(error)}`);
    assert.equal(error.code, code, `expected ${code}, got ${error.code}`);
    return error;
  }
  assert.fail(`expected ${code} to be thrown`);
}

function fingerprintDirectory(directory: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (relative: string): void => {
    const absolute = relative.length === 0 ? directory : join(directory, relative);
    for (const name of readdirSync(absolute).sort()) {
      const childRelative = relative.length === 0 ? name : join(relative, name);
      const childAbsolute = join(directory, childRelative);
      if (statSync(childAbsolute).isDirectory()) walk(childRelative);
      else files.set(childRelative, createHash('sha256').update(readFileSync(childAbsolute)).digest('hex'));
    }
  };
  if (existsSync(directory)) walk('');
  return files;
}

// ---------------------------------------------------------------------------
// Real-ledger fixture for the exporter
// ---------------------------------------------------------------------------

interface LedgerFixture {
  readonly root: string;
  readonly ledger: Ledger;
  readonly entries: readonly ViewReplayEntry[];
  readonly envelopes: readonly CommittedEventEnvelope[];
}

async function buildLedgerFixture(t: TestContext, extraStep?: ChainStep): Promise<LedgerFixture> {
  const root = await mkdtemp(join(tmpdir(), 'ano-replica-export-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  let tick = 1000;
  const ledger = await Ledger.open(root, {
    sessionId: 'replica-export-unit',
    clock: () => {
      tick += 1;
      return tick;
    },
  });
  let lastEventId: string | undefined;
  const append = async (step: ChainStep): Promise<void> => {
    const payload = step.supersedesPrevious && lastEventId !== undefined
      ? { ...step.payload, supersedes: [lastEventId] }
      : step.payload;
    const result = await ledger.append({ kind: step.kind, payload }, step.idemKey ?? 'unit-idem');
    assert.ok(result.event !== undefined, `append ${step.kind} produced no event`);
    lastEventId = result.event.id;
  };
  for (const step of sampleSteps()) await append(step);
  if (extraStep !== undefined) await append(extraStep);
  ledger.close();

  const entries = replayLedger(join(root, '.ano', 'ledger')).entries;
  return {
    root,
    ledger,
    entries,
    envelopes: entries.map((entry, index) => committedEnvelopeFromEvent(entry.event, index + 1, entry.segment)),
  };
}

function tempRoot(t: TestContext, prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix)).then((root) => {
    t.after(async () => {
      await rm(root, { recursive: true, force: true });
    });
    return root;
  });
}

// ---------------------------------------------------------------------------
// Exporter
// ---------------------------------------------------------------------------

test('exportCommittedEvents exports only committed events in canonical order and writes nothing', async (t) => {
  const fixture = await buildLedgerFixture(t);
  const ledgerDirectory = join(fixture.root, '.ano', 'ledger');
  const before = fingerprintDirectory(ledgerDirectory);

  const exported = exportCommittedEvents(fixture.ledger, { projectScope: 'fixture', limit: 1024 });
  const again = exportCommittedEvents(fixture.ledger, { projectScope: 'fixture', limit: 1024 });

  assert.equal(exported.primary_commit_index, fixture.entries.length);
  assert.equal(exported.view_digest, viewDigest(fixture.entries));
  assert.equal(exported.truncated, false);
  assert.deepEqual(again, exported);
  assert.equal(exported.project_scope, 'fixture');

  assert.equal(exported.events.length, fixture.entries.length);
  for (let index = 0; index < fixture.entries.length; index += 1) {
    const entry = fixture.entries[index]!;
    const envelope = exported.events[index]!;
    assert.equal(envelope.seq, index + 1);
    assert.equal(envelope.eventId, entry.event.id);
    assert.equal(envelope.hash, hashEvent(entry.event));
    assert.equal(envelope.segment, entry.segment);
    assert.equal(envelope.prevHash, entry.event.prev_hash);
    assert.equal(envelope.contentRedacted, false);
    assert.deepEqual(envelope.event, entry.event);
  }

  // Read-only boundary: the ledger directory is byte-for-byte unchanged.
  assert.deepEqual(fingerprintDirectory(ledgerDirectory), before);
});

test('exportCommittedEvents screens sensitive-looking payload text without altering committed bytes', async (t) => {
  const finding = noteStep('read secrets/app.pem before deploy');
  const fixture = await buildLedgerFixture(t, finding);

  const audited = exportCommittedEvents(fixture.ledger, { secretScreen: 'audit' });
  const findings = audited.sensitive_findings;
  assert.ok(findings.length > 0, 'expected a sensitive-path finding');
  assert.ok(findings.every((item) => item.path.endsWith('.payload.text')));
  assert.equal(audited.events.at(-1)!.contentRedacted, false);
  assert.deepEqual(audited.events.at(-1)!.payload, finding.payload);

  const off = exportCommittedEvents(fixture.ledger, { secretScreen: 'off' });
  assert.deepEqual(off.sensitive_findings, []);

  const redacted = exportCommittedEvents(fixture.ledger, { secretScreen: 'redact' });
  const last = redacted.events.at(-1)!;
  assert.equal(last.contentRedacted, true);
  assert.notDeepEqual(last.payload, finding.payload);
  // A redacted envelope can never reproduce the primary view.
  expectReplicationError(() => applyEventBatch(emptyReplicaApplyState(), [last]), 'REPLICA_REDACTED_EVENT');

  assert.equal(sensitivePathReason('certs/server.pem'), 'key material');
  assert.equal(sensitivePathReason('keys/private/key.pem'), 'sensitive directory');
  assert.equal(sensitivePathReason('.env'), 'environment file');
  assert.equal(screenSensitiveText('nothing sensitive here').length, 0);
});

test('exportCommittedEvents refuses invalid pull bounds', async (t) => {
  const fixture = await buildLedgerFixture(t);
  expectReplicationError(() => exportCommittedEvents(fixture.ledger, { fromCommitIndex: -1 }), 'REPLICATION_EXPORT_INVALID');
  expectReplicationError(() => exportCommittedEvents(fixture.ledger, { limit: 0 }), 'REPLICATION_EXPORT_INVALID');
  expectReplicationError(() => exportCommittedEvents(fixture.ledger, { limit: 5000 }), 'REPLICATION_EXPORT_INVALID');
});

// ---------------------------------------------------------------------------
// Ordered idempotent application
// ---------------------------------------------------------------------------

test('applyEventBatch is idempotent by eventId and hash with zero side effects', () => {
  const events = buildChain(sampleSteps());
  const envelopes = envelopesOf(events);
  const entries = viewEntriesOf(events);
  const empty = emptyReplicaApplyState();

  const first = applyEventBatch(empty, envelopes);
  assert.equal(first.report.applied, envelopes.length);
  assert.equal(first.report.duplicates, 0);
  assert.equal(first.report.outOfOrder, 0);
  assert.deepEqual(first.report.gaps, []);
  assert.equal(first.report.corrupt, 0);
  assert.equal(first.report.commitIndex, envelopes.length);
  assert.equal(first.report.viewDigest, viewDigest(entries));
  assert.equal(first.report.complete, true);

  const repeat = applyEventBatch(first.state, envelopes);
  assert.equal(repeat.report.applied, 0);
  assert.equal(repeat.report.duplicates, envelopes.length);
  assert.equal(repeat.report.commitIndex, first.report.commitIndex);
  assert.equal(repeat.report.viewDigest, first.report.viewDigest);
  assert.deepEqual(repeat.report.gaps, []);
  assert.deepEqual(repeat.state.entries, first.state.entries);
  assert.deepEqual(repeat.state.pending, new Map());

  const subset = applyEventBatch(first.state, [envelopes[1]!]);
  assert.equal(subset.report.applied, 0);
  assert.equal(subset.report.duplicates, 1);

  // Pure transition: the input state is never mutated.
  assert.equal(empty.commitIndex, 0);
  assert.equal(empty.entries.length, 0);
});

test('out-of-order arrivals are buffered with an explicit gap and never skipped', () => {
  const events = buildChain(sampleSteps());
  const envelopes = envelopesOf(events);
  const entries = viewEntriesOf(events);

  const head = applyEventBatch(emptyReplicaApplyState(), [envelopes[0]!]);
  assert.equal(head.report.commitIndex, 1);

  const jumped = applyEventBatch(head.state, [envelopes[2]!]);
  assert.equal(jumped.report.applied, 0);
  assert.equal(jumped.report.outOfOrder, 1);
  assert.deepEqual(jumped.report.gaps, [2]);
  assert.equal(jumped.report.commitIndex, 1);
  assert.equal(jumped.report.complete, false);
  assert.equal(jumped.report.pendingCount, 1);
  assert.equal(jumped.state.entries.length, 1);
  assert.deepEqual(replicaGaps(jumped.state), [2]);

  const filled = applyEventBatch(jumped.state, [envelopes[1]!]);
  assert.equal(filled.report.applied, 2, 'the gap event and the buffered event are both applied');
  assert.deepEqual(filled.report.gaps, []);
  const filledEntries = entries.slice(0, 3);
  assert.equal(filled.report.commitIndex, filledEntries.length);
  assert.equal(filled.report.complete, true);
  assert.equal(filled.report.viewDigest, viewDigest(filledEntries));
  assert.deepEqual(filled.state.entries, filledEntries);
});

test('corrupt batches fail closed before any state is published', () => {
  const events = buildChain(sampleSteps());
  const envelopes = envelopesOf(events);
  const empty = emptyReplicaApplyState();

  const badHash = { ...envelopes[1]!, hash: 'f'.repeat(64) };
  const hashFailure = expectReplicationError(() => applyEventBatch(empty, [envelopes[0]!, badHash]), 'REPLICA_CORRUPT_EVENT');
  assert.equal(hashFailure.report?.corrupt, 1);
  assert.equal(empty.commitIndex, 0);

  const badStructure = { ...envelopes[1]!, seq: 0 };
  expectReplicationError(() => applyEventBatch(empty, [badStructure]), 'REPLICA_CORRUPT_EVENT');

  const badEvent = { ...envelopes[1]!, eventId: '' };
  expectReplicationError(() => applyEventBatch(empty, [badEvent]), 'REPLICA_CORRUPT_EVENT');

  const redacted = { ...envelopes[1]!, contentRedacted: true };
  expectReplicationError(() => applyEventBatch(empty, [redacted]), 'REPLICA_REDACTED_EVENT');

  // The rejected batch left no half-applied view behind.
  assert.equal(empty.commitIndex, 0);
  assert.deepEqual(empty.entries, []);
});

test('identity, sequence and hash-chain violations are refused', () => {
  const events = buildChain(sampleSteps());
  const envelopes = envelopesOf(events);
  const head = applyEventBatch(emptyReplicaApplyState(), envelopes);

  // Same eventId, different committed bytes: an identity conflict.
  const conflicting = makeEvent(genesisHash, 'note.recorded', noteStep('a different body').payload, { id: events[1]!.id });
  const conflictEnvelope = committedEnvelopeFromEvent(conflicting, envelopes.length, 'unit-seg');
  expectReplicationError(() => applyEventBatch(head.state, [conflictEnvelope]), 'REPLICA_EVENT_CONFLICT');

  // Two distinct events claiming the same seq.
  const first = applyEventBatch(emptyReplicaApplyState(), [envelopes[0]!]);
  const squatter = committedEnvelopeFromEvent(makeEvent(genesisHash, noteStep('squatter').kind, noteStep('squatter').payload), 1, 'unit-seg');
  expectReplicationError(() => applyEventBatch(first.state, [squatter]), 'REPLICA_SEQ_CONFLICT');

  // Within one batch, a repeated seq is rejected up front.
  const otherAtSeqOne = committedEnvelopeFromEvent(makeEvent(genesisHash, noteStep('other').kind, noteStep('other').payload), 1, 'unit-seg');
  expectReplicationError(() => applyEventBatch(emptyReplicaApplyState(), [envelopes[0]!, otherAtSeqOne]), 'REPLICA_SEQ_CONFLICT');

  // Broken segment chain: seq 2 does not extend the segment head.
  const brokenLink = makeEvent(genesisHash, noteStep('broken link').kind, noteStep('broken link').payload);
  const brokenEnvelope = committedEnvelopeFromEvent(brokenLink, 2, 'unit-seg');
  expectReplicationError(() => applyEventBatch(first.state, [brokenEnvelope]), 'REPLICA_CHAIN_BREAK');

  // A new segment's first event must also chain from genesis.
  const foreignLink = makeEvent('c'.repeat(64), noteStep('foreign segment').kind, noteStep('foreign segment').payload);
  const foreignSegment = committedEnvelopeFromEvent(foreignLink, 1, 'other-seg');
  expectReplicationError(() => applyEventBatch(emptyReplicaApplyState(), [foreignSegment]), 'REPLICA_CHAIN_BREAK');
});

test('the out-of-order buffer is bounded', () => {
  const events = buildChain(sampleSteps());
  const envelopes = envelopesOf(events);
  const options = { bufferMaxEvents: 1 };

  const head = applyEventBatch(emptyReplicaApplyState(), [envelopes[0]!], options);
  const buffered = applyEventBatch(head.state, [envelopes[2]!], options);
  assert.equal(buffered.report.outOfOrder, 1);
  expectReplicationError(() => applyEventBatch(buffered.state, [envelopes[3]!], options), 'REPLICA_BUFFER_EXCEEDED');
  assert.equal(buffered.state.pending.size, 1);
});

// ---------------------------------------------------------------------------
// Cursor and resume
// ---------------------------------------------------------------------------

test('ReplicaCursor round-trips into a resume request and detects divergence', () => {
  const events = buildChain(sampleSteps());
  const entries = viewEntriesOf(events);
  const applied = applyEventBatch(emptyReplicaApplyState(), envelopesOf(events));

  const cursor = cursorFromState(applied.state, { clusterEpoch: 'epoch-7', replicaId: 'r-unit' });
  assertReplicaCursor(cursor);
  assert.equal(cursor.commitIndex, events.length);
  assert.equal(cursor.lastEventId, events.at(-1)!.id);
  assert.equal(cursor.lastEventHash, hashEvent(events.at(-1)!));
  assert.equal(cursor.viewDigest, viewDigest(entries));
  assert.equal(cursor.clusterEpoch, 'epoch-7');
  assert.equal(cursor.replicaId, 'r-unit');

  assert.deepEqual(resumeFrom(cursor), {
    fromCommitIndex: events.length,
    expectedViewDigest: viewDigest(entries),
    lastEventId: events.at(-1)!.id,
  });

  expectReplicationError(() => assertReplicaCursor({ ...cursor, viewDigest: 'not-a-digest' }), 'REPLICA_CURSOR_INVALID');
  expectReplicationError(() => assertCursorMatchesState({ ...cursor, viewDigest: 'a'.repeat(64) }, applied.state), 'VIEW_DIGEST_MISMATCH');
  expectReplicationError(() => assertCursorMatchesState(cursor, emptyReplicaApplyState()), 'REPLICA_CURSOR_INVALID');
});

// ---------------------------------------------------------------------------
// ReplicaStore
// ---------------------------------------------------------------------------

test('ReplicaStore rebuilds the primary projection and refuses every write-shaped API', async (t) => {
  const root = await tempRoot(t, 'ano-replica-unit-');
  const events = buildChain(sampleSteps());
  const envelopes = envelopesOf(events);
  const entries = viewEntriesOf(events);

  const store = ReplicaStore.open({
    root,
    replicaId: 'r-unit',
    projectScope: 'fixture',
    clusterEpoch: 'epoch-1',
    snapshot: BASE_SNAPSHOT,
  });
  t.after(() => store.close());

  const report = store.rebuildFromEvents(envelopes);
  assert.equal(report.commitIndex, events.length);
  assert.equal(report.viewDigest, viewDigest(entries));
  assert.equal(store.commitIndex, events.length);
  assert.equal(store.viewDigest, viewDigest(entries));
  assert.equal(store.maxLag(events.length + 10), 10);
  assert.deepEqual(store.resumePullRequest(), {
    fromCommitIndex: events.length,
    expectedViewDigest: viewDigest(entries),
    lastEventId: events.at(-1)!.id,
  });

  // Same projection algorithm as the primary: ProjectedProbeStore over the same entries.
  const projected = ProjectedProbeStore.create(entries, BASE_SNAPSHOT);
  assert.deepEqual(store.candidates(), projected.candidates());
  assert.deepEqual(store.adjacency(), projected.adjacency());
  assert.equal(store.evidence(projected.candidates()[0]!.record_ref)?.record_ref, projected.candidates()[0]!.record_ref);
  assert.equal(store.status(projected.candidates()[0]!.record_ref)?.record_ref, projected.candidates()[0]!.record_ref);
  assert.equal(store.provenance(projected.candidates()[0]!.record_ref)?.record_ref, projected.candidates()[0]!.record_ref);
  projected.close();

  const metadata = store.clusterMetadata();
  assert.equal(metadata.project_scope, 'fixture');
  assert.equal(metadata.cluster_epoch, 'epoch-1');
  assert.equal(metadata.commit_index, events.length);
  assert.equal(metadata.replica_id, 'r-unit');
  assert.equal(metadata.replica_commit_index, events.length);
  assert.equal(metadata.consistency, 'local');
  assert.equal(metadata.max_lag, null);
  assert.equal(metadata.partial, false);
  assert.deepEqual(metadata.failed_nodes, []);
  assert.match(metadata.evidence_digest, /^[a-f0-9]{64}$/u);

  const identity = store.snapshotIdentity();
  assert.equal(identity.project_scope, 'fixture');
  assert.equal(identity.ledger_digest, viewDigest(entries));
  assert.equal(identity.replica_id, 'r-unit');
  assert.equal(identity.replica_commit_index, events.length);
  assert.equal(identity.commit_index, events.length);
  assert.equal(identity.cluster_epoch, 'epoch-1');
  assert.equal(identity.evidence_digest, metadata.evidence_digest);
  assert.equal(store.replicaCommitIndex(), events.length);

  // Write boundary: absent APIs exist only to refuse.
  for (const attempt of [
    (): unknown => store.append({ kind: 'note.recorded', payload: {} }),
    (): unknown => store.writeNote('nope'),
    (): unknown => store.recordTrack('a', 'b'),
  ]) {
    expectReplicationError(attempt, 'REPLICA_WRITE_FORBIDDEN');
  }
  assert.equal(store.commitIndex, events.length);
});

test('ReplicaStore duplicates are a zero-side-effect no-op across reopen', async (t) => {
  const root = await tempRoot(t, 'ano-replica-dup-');
  const events = buildChain(sampleSteps());
  const envelopes = envelopesOf(events);

  const store = ReplicaStore.open({ root, replicaId: 'r-dup', projectScope: 'fixture', snapshot: BASE_SNAPSHOT });
  t.after(() => store.close());
  store.rebuildFromEvents(envelopes);
  const digest = store.viewDigest;
  const eventsBytes = readFileSync(store.eventsPath);
  const cursorBytes = readFileSync(store.cursorPath);

  const duplicate = store.applyCommitted(envelopes);
  assert.equal(duplicate.applied, 0);
  assert.equal(duplicate.duplicates, envelopes.length);
  assert.equal(duplicate.commitIndex, events.length);
  assert.equal(duplicate.viewDigest, digest);
  assert.deepEqual(readFileSync(store.eventsPath), eventsBytes);
  assert.deepEqual(readFileSync(store.cursorPath), cursorBytes);

  const candidatesBeforeClose = store.candidates();
  store.close();
  const reopened = ReplicaStore.open({ root, replicaId: 'r-dup', projectScope: 'fixture', snapshot: BASE_SNAPSHOT });
  t.after(() => reopened.close());
  assert.equal(reopened.commitIndex, events.length);
  assert.equal(reopened.viewDigest, digest);
  assert.deepEqual(reopened.candidates(), candidatesBeforeClose);
});

test('ReplicaStore keeps its material isolated and refuses foreign scopes and partial rebuilds', async (t) => {
  const root = await tempRoot(t, 'ano-replica-iso-');
  const events = buildChain(sampleSteps());
  const envelopes = envelopesOf(events);

  const store = ReplicaStore.open({ root, replicaId: 'r-iso', projectScope: 'fixture', snapshot: BASE_SNAPSHOT });
  t.after(() => store.close());
  store.rebuildFromEvents(envelopes);

  assert.equal(store.directory, ReplicaStore.directoryFor(root, 'r-iso'));
  assert.ok(store.eventsPath.startsWith(`${store.directory}${sep}`));
  assert.ok(store.cursorPath.startsWith(`${store.directory}${sep}`));
  assert.notEqual(store.directory, join(root, '.ano', 'ledger'));
  assert.equal(existsSync(join(root, '.ano', 'ledger')), false, 'replica must never create the main ledger directory');
  assert.throws(() => ReplicaStore.open({ root, replicaId: '..', projectScope: 'fixture' }), ReplicationError);

  expectReplicationError(() => store.applyCommitted([envelopes[0]!], { projectScope: 'other-project' }), 'SCOPE_DENIED');
  assert.equal(store.commitIndex, events.length);

  const partialRoot = await tempRoot(t, 'ano-replica-partial-');
  const partial = ReplicaStore.open({ root: partialRoot, replicaId: 'r-partial', projectScope: 'fixture', snapshot: BASE_SNAPSHOT });
  t.after(() => partial.close());
  expectReplicationError(() => partial.rebuildFromEvents([envelopes[2]!]), 'REPLICA_INCOMPLETE_REBUILD');
  expectReplicationError(() => partial.rebuildFromEvents([envelopes[0]!, envelopes[2]!]), 'REPLICA_INCOMPLETE_REBUILD');
  assert.equal(partial.commitIndex, 0);
  assert.deepEqual(partial.entries, []);
});
