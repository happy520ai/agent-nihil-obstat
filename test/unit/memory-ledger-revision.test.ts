import assert from 'node:assert/strict';
import fs, { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { describe } from 'node:test';
import { ulid } from '../../src/core/ulid.ts';
import { scanSegment, segmentFileName } from '../../src/ledger/append.ts';
import { encodeBatch } from '../../src/ledger/segment.ts';
import { canonicalJson, eventChain, genesisHash, hashEvent, ledgerEventKinds, ledgerEventSchema, type LedgerEvent } from '../../src/ledger/event.ts';
import { isMemoryEventKind, ledgerPayloadIssues } from '../../src/ledger/payloads.ts';
import {
  IdempotencyConflictError,
  Ledger,
  LedgerIntegrityError,
  MemoryPreconditionError,
  assertMemoryAppendPreconditions,
  deriveMemoryProjection,
} from '../../src/ledger/ledger.ts';
import type { DerivedMemoryState } from '../../src/ledger/ledger.ts';
import { readMemoryHead, readMemoryRecord, readMemoryConflict } from '../../src/ledger/views.ts';
import type { ViewReplayEntry } from '../../src/ledger/views.ts';

// ---------------------------------------------------------------------------
// Deterministic fixtures. ULIDs are pinned by seeding the randomness so every
// run (and every hash pin below) is reproducible.
// ---------------------------------------------------------------------------
const deterministicBytes = (seed: number): Uint8Array => Uint8Array.from({ length: 10 }, (_, index) => (index * 7 + seed * 31 + 3) % 256);
let ulidSeed = 0;
const nextRef = (now = 1000): string => ulid(now, deterministicBytes(++ulidSeed + 100));

const FACT_KEY = 'local.storage.engine';

const genesisPayload = (): Record<string, unknown> => ({
  intent: 'revise',
  fact_key: FACT_KEY,
  record: { text: 'v1: sqlite ledger', kind: 'decision' },
  supersedes: [],
  reason: 'first governed version',
  effective_from: null,
  effective_to: null,
});
const revisePayload = (supersedes: string[], overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  intent: 'revise',
  fact_key: FACT_KEY,
  record: { text: 'v2: sqlite ledger, segment dedup', kind: 'decision' },
  supersedes,
  reason: 'correction with more detail',
  effective_from: null,
  effective_to: null,
  ...overrides,
});
const retractPayload = (supersedes: string[]): Record<string, unknown> => ({
  intent: 'retract',
  fact_key: FACT_KEY,
  supersedes,
  reason: 'the recorded fact is wrong',
});
const relatedPayload = (fromRef: string, toRef: string, edge = 'related_to'): Record<string, unknown> => ({
  edge,
  from_ref: fromRef,
  to_ref: toRef,
});
const resolvedPayload = (branches: string[], outcome: Record<string, unknown>): Record<string, unknown> => ({
  fact_key: FACT_KEY,
  branches,
  outcome,
  reason: 'adjudicated by the maintainer',
});

const entryOf = (event: LedgerEvent): ViewReplayEntry => ({ event, segment: 'fixture.jsonl' });
const stateWith = (...events: LedgerEvent[]): DerivedMemoryState => deriveMemoryProjection(events.map(entryOf));

/**
 * Best-effort temp cleanup. A just-closed SQLite handle can linger on Windows
 * (delete-pending), and a leaked view connection from a parallel-session
 * change holds the directory longer; a cleanup failure must not flip a test
 * whose assertions passed, so it retries briefly and then warns.
 */
function removeTempRoot(root: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= 9) {
        console.warn(`memory-ledger-revision: temp root not removable (kept for inspection): ${root} — ${String(error)}`);
        return;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

function envelope(id: string, kind: LedgerEvent['kind'], payload: Record<string, unknown>, prevHash = genesisHash, physical = 1000, actor = 'A', idemKey?: string): LedgerEvent {
  // Committed memory events always carry an idempotency key (ADR-005 §2.6);
  // hand-crafted segment fixtures must satisfy the same invariant.
  return { id, hlc: { physical, logical: 0, actor }, actor, kind, payload, prev_hash: prevHash, ...(idemKey ? { idem_key: idemKey } : {}) };
}
const revisedEvent = (id: string, payload: Record<string, unknown>, prevHash?: string, physical?: number): LedgerEvent => envelope(id, 'memory.revised', payload, prevHash, physical);
const noteEvent = (id: string, payload: Record<string, unknown>, prevHash?: string, physical?: number): LedgerEvent => envelope(id, 'note.recorded', payload, prevHash, physical);
const notePayload = (noteId: string): Record<string, unknown> => ({
  note_id: noteId,
  kind: 'decision',
  text: 'legacy note body',
  created_at: '2026-01-01T00:00:00.000Z',
  anchor: { file: 'src/legacy.ts' },
});

function assertRejected(state: DerivedMemoryState, kind: Parameters<typeof assertMemoryAppendPreconditions>[1], payload: Record<string, unknown>, messagePart?: string): void {
  assert.throws(() => assertMemoryAppendPreconditions(state, kind, payload), (error: unknown) => {
    assert.ok(error instanceof MemoryPreconditionError, `expected MemoryPreconditionError, got ${String(error)}`);
    if (messagePart) assert.match(error.message, new RegExp(messagePart, 'u'));
    return true;
  });
}

// ---------------------------------------------------------------------------
// Part 1 — event vocabulary and hash invariance (ADR-005 §2/§3)
// ---------------------------------------------------------------------------
test('memory kinds are appended at the vocabulary tail without reordering existing kinds', () => {
  const legacy = [
    'segment.started', 'task.created', 'task.updated', 'evidence.recorded', 'verify.started', 'verify.finished',
    'run.lease.acquired', 'run.lease.heartbeat', 'run.lease.reclaimed', 'run.lease.released', 'migration.recorded',
    'note.recorded', 'audit.finding', 'audit.completed', 'readiness.evidence', 'readiness.attestation',
    'release.verdict', 'release.approved',
  ];
  assert.deepEqual(ledgerEventKinds.slice(0, legacy.length), legacy);
  // ADR-005 appended the three memory kinds; ADR-010 §3.2 appended
  // `structure.queried`; ADR-013 appended the two session events at the tail.
  assert.deepEqual([...ledgerEventKinds].slice(legacy.length), ['memory.revised', 'memory.related', 'memory.conflict.resolved', 'structure.queried', 'session.started', 'session.stop_checked']);
  assert.equal(isMemoryEventKind('memory.revised'), true);
  assert.equal(isMemoryEventKind('note.recorded'), false);
});

test('committed legacy events keep their canonical bytes and SHA-256 (ADR-005 §2.1)', () => {
  // These hashes were computed from the same events before the memory
  // vocabulary was appended; any change to the canonical serialization or the
  // hashing of already committed events fails here.
  const taskCreated = envelope('00000000Z848MK0DSY8N656PK1', 'task.created', { task_id: 'T-legacy', declared_files: ['src/a.ts'] });
  const noteRecorded = noteEvent('00000001YG8544YNJXCHNQ4YC0', notePayload('a'.repeat(64)), hashEvent(taskCreated), 2000);
  assert.equal(ledgerEventSchema.safeParse(taskCreated).success, true);
  assert.equal(ledgerEventSchema.safeParse(noteRecorded).success, true);
  assert.equal(hashEvent(taskCreated), 'd44a88cc30d027dddf1e532341ac1c1b2612e04e8b217c0780d20dc28d2e400b');
  assert.equal(hashEvent(noteRecorded), 'a82a566a94960f572fa643c43b2c2c3a4df7d0fa841e01224696e5a8b58540f8');
  // A chain that already contains a memory event still validates with the
  // appended vocabulary.
  const revised = revisedEvent(nextRef(), genesisPayload(), hashEvent(noteRecorded), 3000);
  assert.equal(eventChain([taskCreated, noteRecorded, revised]), true);
  assert.equal(canonicalJson(revised).includes('"intent":"revise"'), true);
});

// ---------------------------------------------------------------------------
// Part 2 — strict payload contracts (ADR-005 §4)
// ---------------------------------------------------------------------------
test('strict payload schemas accept the ADR-005 §4 shapes', () => {
  assert.deepEqual(ledgerPayloadIssues('memory.revised', genesisPayload()), []);
  assert.deepEqual(ledgerPayloadIssues('memory.revised', revisePayload([nextRef()])), []);
  assert.deepEqual(ledgerPayloadIssues('memory.revised', revisePayload([nextRef()], { record: { text: 'x', kind: 'memory', anchor: { file: 'src/a.ts' } } })), []);
  assert.deepEqual(ledgerPayloadIssues('memory.revised', retractPayload([nextRef()])), []);
  assert.deepEqual(ledgerPayloadIssues('memory.related', relatedPayload(nextRef(), nextRef())), []);
  assert.deepEqual(ledgerPayloadIssues('memory.related', relatedPayload(nextRef(), nextRef(), 'depends_on')), []);
  const branchA = nextRef();
  const branchB = nextRef();
  assert.deepEqual(ledgerPayloadIssues('memory.conflict.resolved', resolvedPayload([branchA, branchB], { type: 'winner', winner_ref: branchA })), []);
  assert.deepEqual(ledgerPayloadIssues('memory.conflict.resolved', resolvedPayload([branchA, branchB], { type: 'record', record: { text: 'merged', kind: 'pitfall' }, effective_from: null, effective_to: null })), []);
  assert.deepEqual(ledgerPayloadIssues('memory.conflict.resolved', resolvedPayload([branchA, branchB], { type: 'retract_all' })), []);
});

test('strict payload schemas reject unknown fields and camelCase variants (ADR-005 §2.5)', () => {
  assert.ok(ledgerPayloadIssues('memory.revised', { ...genesisPayload(), recorded_at: '2026-01-01T00:00:00.000Z' }).length > 0, 'recorded_at is HLC-derived, never a payload field');
  assert.ok(ledgerPayloadIssues('memory.revised', { ...genesisPayload(), factKey: FACT_KEY }).length > 0, 'camelCase factKey is an unknown field');
  assert.ok(ledgerPayloadIssues('memory.related', { ...relatedPayload(nextRef(), nextRef()), fromRef: nextRef() }).length > 0);
  // The camelCase compatibility mapping for readiness/release must not be
  // applied to memory payloads even where a mapping key collides.
  assert.ok(ledgerPayloadIssues('memory.conflict.resolved', { ...resolvedPayload([nextRef(), nextRef()], { type: 'retract_all' }), sourceFingerprint: 'x'.repeat(64) }).length > 0);
});

test('strict payload schemas reject malformed revisions', () => {
  const missingEffective = { ...genesisPayload() } as Record<string, unknown>;
  delete missingEffective.effective_from;
  assert.ok(ledgerPayloadIssues('memory.revised', missingEffective).length > 0, 'effective bounds must be explicit, even when unknown');
  assert.ok(ledgerPayloadIssues('memory.revised', revisePayload([], { effective_from: '2026-02-01T00:00:00.000Z', effective_to: '2026-01-01T00:00:00.000Z' })).length > 0, 'effective_from must not be after effective_to');
  assert.ok(ledgerPayloadIssues('memory.revised', { ...retractPayload([nextRef()]), supersedes: [] }).length > 0, 'retract names exactly one head');
  assert.ok(ledgerPayloadIssues('memory.revised', retractPayload([nextRef(), nextRef()])).length > 0);
  assert.ok(ledgerPayloadIssues('memory.revised', { ...retractPayload([nextRef()]), record: { text: 'x', kind: 'memory' } }).length > 0, 'retract carries no record');
  assert.ok(ledgerPayloadIssues('memory.revised', revisePayload([], { record: { text: 'x', kind: 'session_summary' } })).length > 0, 'session_summary never becomes a versioned fact');
  assert.ok(ledgerPayloadIssues('memory.revised', revisePayload([], { record: { text: '', kind: 'memory' } })).length > 0);
  assert.ok(ledgerPayloadIssues('memory.revised', revisePayload([], { fact_key: 'LOCAL.engine' })).length > 0, 'fact_key is lowercase only');
  assert.ok(ledgerPayloadIssues('memory.revised', revisePayload([], { fact_key: '.leading.dot' })).length > 0);
  assert.ok(ledgerPayloadIssues('memory.revised', revisePayload([], { fact_key: 'a'.repeat(121) })).length > 0);
  assert.ok(ledgerPayloadIssues('memory.revised', revisePayload([], { reason: '' })).length > 0);
  assert.ok(ledgerPayloadIssues('memory.revised', revisePayload([], { reason: 'x'.repeat(2001) })).length > 0);
  assert.ok(ledgerPayloadIssues('memory.revised', { ...genesisPayload(), supersedes: ['not-a-ulid'] }).length > 0);
});

test('strict payload schemas reject malformed edges and adjudications', () => {
  assert.ok(ledgerPayloadIssues('memory.related', relatedPayload(nextRef(), nextRef(), 'depends')).length > 0, 'edge vocabulary is fixed to three kinds');
  assert.ok(ledgerPayloadIssues('memory.related', relatedPayload('01arz3ndektsv4rrffq69g5fav', nextRef())).length > 0, 'record refs are Crockford ULIDs');
  assert.ok(ledgerPayloadIssues('memory.related', { ...relatedPayload(nextRef(), nextRef()), reason: 'x'.repeat(2001) }).length > 0);
  const only = [nextRef()];
  assert.ok(ledgerPayloadIssues('memory.conflict.resolved', resolvedPayload(only, { type: 'retract_all' })).length > 0, 'adjudication needs at least two branches');
  const branchA = nextRef();
  const branchB = nextRef();
  assert.ok(ledgerPayloadIssues('memory.conflict.resolved', resolvedPayload([branchA, branchB], { type: 'winner', winner_ref: nextRef() })).length > 0, 'winner_ref must be one of the branches');
  assert.ok(ledgerPayloadIssues('memory.conflict.resolved', resolvedPayload([branchA, branchB], { type: 'pause' })).length > 0, 'outcome type is a closed set');
  assert.ok(ledgerPayloadIssues('memory.conflict.resolved', { fact_key: FACT_KEY, branches: [branchA, branchB], outcome: { type: 'record', record: { text: 'x', kind: 'memory' } }, reason: 'r' }).length > 0, 'record outcome must carry explicit effective bounds');
});

// ---------------------------------------------------------------------------
// Part 3 — derivation and append-layer preconditions (ADR-005 §6/§7)
// ---------------------------------------------------------------------------
test('genesis and linear revisions move the head; stale priors are rejected', () => {
  const genesis = nextRef();
  const v2 = nextRef();
  const state = stateWith(revisedEvent(genesis, genesisPayload()), revisedEvent(v2, revisePayload([genesis]), undefined, 2000));
  assert.equal(state.heads.get(FACT_KEY), v2);
  assert.equal(state.records.get(genesis)?.status, 'superseded');
  assert.equal(state.records.get(genesis)?.supersededBy, v2);
  assert.equal(state.records.get(v2)?.status, 'active');
  // The new head is a valid prior; the old one is a stale prior.
  assertMemoryAppendPreconditions(state, 'memory.revised', revisePayload([v2]));
  assertRejected(state, 'memory.revised', revisePayload([genesis]), 'stale prior');
  assertRejected(state, 'memory.revised', genesisPayload(), 'unused fact_key');
});

test('a revision that depends on the same prior as the head replays as an undecided conflict', () => {
  const genesis = nextRef();
  const genesisEvent = revisedEvent(genesis, genesisPayload(), undefined, 1000);
  const branchA = revisedEvent(nextRef(), revisePayload([genesis]), undefined, 2000);
  const branchB = revisedEvent(nextRef(), revisePayload([genesis]), hashEvent(branchA), 3000);
  // Fork detection must not depend on replay order: both orders yield the same
  // undecided branch set and no auto winner (HLC is never last-writer-wins).
  for (const [first, second] of [[branchA, branchB], [branchB, branchA]] as const) {
    const state = stateWith(genesisEvent, first, second);
    const branches = state.conflicts.get(FACT_KEY);
    assert.ok(branches, 'a fork projects an undecided conflict');
    assert.equal(branches.size, 2);
    assert.equal(branches.has(branchA.id), true);
    assert.equal(branches.has(branchB.id), true);
    assert.equal(state.heads.get(FACT_KEY), null);
    assert.equal(state.records.get(branchA.id)?.status, 'conflicted');
    assert.equal(state.records.get(branchB.id)?.status, 'conflicted');
    // Append layer: everything but adjudication is rejected while undecided.
    assertRejected(state, 'memory.revised', revisePayload([branchA.id]), 'undecided conflict');
    assertRejected(state, 'memory.revised', retractPayload([branchA.id]), 'undecided conflict');
    assertRejected(state, 'memory.conflict.resolved', resolvedPayload([branchA.id], { type: 'retract_all' }), 'exactly equal');
    assertRejected(state, 'memory.conflict.resolved', resolvedPayload([branchA.id, branchB.id, nextRef()], { type: 'retract_all' }), 'exactly equal');
    assertMemoryAppendPreconditions(state, 'memory.conflict.resolved', resolvedPayload([branchA.id, branchB.id], { type: 'winner', winner_ref: branchA.id }));
    // Edges are fact-neutral: relating two records stays legal during a conflict.
    assertMemoryAppendPreconditions(state, 'memory.related', relatedPayload(branchA.id, branchB.id));
  }
  // A third revision on the same predecessor joins the branch set; one that
  // references a branch instead of the common predecessor fails closed.
  const branchC = revisedEvent(nextRef(), revisePayload([genesis]), undefined, 4000);
  const joined = stateWith(genesisEvent, branchA, branchB, branchC);
  assert.equal(joined.conflicts.get(FACT_KEY)!.size, 3);
  assert.throws(() => stateWith(genesisEvent, branchA, branchB, revisedEvent(nextRef(), revisePayload([branchA.id]), undefined, 5000)), LedgerIntegrityError);
});

test('adjudication outcomes transition exactly the undecided branches', () => {
  const genesis = nextRef();
  const genesisEvent = revisedEvent(genesis, genesisPayload());
  const branchA = revisedEvent(nextRef(), revisePayload([genesis]), undefined, 2000);
  const branchB = revisedEvent(nextRef(), revisePayload([genesis]), hashEvent(branchA), 3000);
  const branchRefs = [branchA.id, branchB.id];

  const winnerState = stateWith(
    genesisEvent, branchA, branchB,
    envelope(nextRef(), 'memory.conflict.resolved', resolvedPayload(branchRefs, { type: 'winner', winner_ref: branchB.id }), undefined, 4000),
  );
  assert.equal(winnerState.heads.get(FACT_KEY), branchB.id);
  assert.equal(winnerState.records.get(branchB.id)?.status, 'active');
  assert.equal(winnerState.records.get(branchA.id)?.status, 'superseded');
  assert.equal(winnerState.conflicts.has(FACT_KEY), false);
  assertMemoryAppendPreconditions(winnerState, 'memory.revised', revisePayload([branchB.id]));

  const recordOutcome = stateWith(
    genesisEvent, branchA, branchB,
    envelope(nextRef(), 'memory.conflict.resolved', resolvedPayload(branchRefs, { type: 'record', record: { text: 'merged truth', kind: 'memory' }, effective_from: null, effective_to: null }), undefined, 4000),
  );
  const introduced = [...recordOutcome.records.values()].find((record) => record.kind === 'memory.conflict.resolved');
  assert.ok(introduced, 'the resolution event itself introduces the new head record');
  assert.equal(recordOutcome.heads.get(FACT_KEY), introduced.ref);
  assert.equal(recordOutcome.records.get(branchA.id)?.status, 'superseded');
  assert.equal(recordOutcome.records.get(branchA.id)?.supersededBy, introduced.ref);

  const retractAll = stateWith(
    genesisEvent, branchA, branchB,
    envelope(nextRef(), 'memory.conflict.resolved', resolvedPayload(branchRefs, { type: 'retract_all' }), undefined, 4000),
  );
  assert.equal(retractAll.heads.get(FACT_KEY), null);
  assert.equal(retractAll.records.get(branchA.id)?.status, 'retracted');
  assert.equal(retractAll.records.get(branchB.id)?.status, 'retracted');
  // The fact slot is withdrawn: no head exists to supersede and genesis is
  // blocked by the existing records, so the fact_key is terminal.
  assertRejected(retractAll, 'memory.revised', revisePayload([branchA.id]), 'no current head');
  assertRejected(retractAll, 'memory.revised', genesisPayload(), 'already has records');
  assertRejected(retractAll, 'memory.conflict.resolved', resolvedPayload(branchRefs, { type: 'retract_all' }), 'no undecided conflict');
});

test('retraction requires the active head and allows forward correction', () => {
  const genesis = nextRef();
  const retracted = nextRef();
  const retractingEvent = envelope(nextRef(), 'memory.revised', retractPayload([retracted]), undefined, 3000);
  const state = stateWith(
    revisedEvent(genesis, genesisPayload()),
    revisedEvent(retracted, revisePayload([genesis]), undefined, 2000),
    retractingEvent,
  );
  assert.equal(state.records.get(retracted)?.status, 'retracted');
  assert.equal(state.heads.get(FACT_KEY), retracted, 'the head pointer stays on the retracted record');
  assertRejected(state, 'memory.revised', retractPayload([retracted]), 'active head');
  assertRejected(state, 'memory.revised', retractPayload([genesis]), 'current head');
  // ADR-005 §4.1: a retracted head may be revised over (forward correction),
  // and the retracted record is not rewritten to superseded.
  assertMemoryAppendPreconditions(state, 'memory.revised', revisePayload([retracted]));
  const corrected = nextRef();
  const after = stateWith(
    revisedEvent(genesis, genesisPayload()),
    revisedEvent(retracted, revisePayload([genesis]), undefined, 2000),
    retractingEvent,
    revisedEvent(corrected, revisePayload([retracted]), undefined, 4000),
  );
  assert.equal(after.records.get(retracted)?.status, 'retracted');
  assert.equal(after.heads.get(FACT_KEY), corrected);
});

test('legacy notes enter governance through supersedes and stay one-shot', () => {
  const note = noteEvent(nextRef(), notePayload('b'.repeat(64)));
  const governed = nextRef();
  const state = stateWith(note, revisedEvent(governed, revisePayload([note.id]), undefined, 2000));
  assert.equal(state.records.get(note.id)?.origin, 'legacy_unreviewed');
  assert.equal(state.records.get(note.id)?.status, 'superseded');
  assert.equal(state.records.get(governed)?.origin, 'governed');
  assert.equal(state.heads.get(FACT_KEY), governed);
  // An unused fact_key may govern an unreviewed note; a used one must name its
  // head, and only a note may be superseded into an unused slot.
  const unused = stateWith(note);
  assertMemoryAppendPreconditions(unused, 'memory.revised', revisePayload([note.id]));
  assertRejected(state, 'memory.revised', revisePayload([note.id]), 'current head');
  // A record that is not a legacy note cannot be superseded into an unused slot.
  assertRejected(state, 'memory.revised', { ...revisePayload([governed]), fact_key: 'other.fact.slot' }, 'legacy note.recorded event');
  // An already governed note cannot govern a second fact slot (ADR-005 §8,
  // deterministic one-shot reading: a note is superseded exactly once).
  assertRejected(state, 'memory.revised', { ...revisePayload([note.id]), fact_key: 'other.fact.slot' }, 'already been governed');
});

test('related edges resolve in-ledger refs, reject duplicates and self-loops, and never change fact state', () => {
  const genesis = nextRef();
  const v2 = nextRef();
  const revised = stateWith(revisedEvent(genesis, genesisPayload()), revisedEvent(v2, revisePayload([genesis]), undefined, 2000));
  assertMemoryAppendPreconditions(revised, 'memory.related', relatedPayload(genesis, v2, 'explains'));
  assertRejected(revised, 'memory.related', relatedPayload(genesis, nextRef()), 'does not resolve in this ledger');
  assertRejected(revised, 'memory.related', relatedPayload(genesis, genesis), 'self-loop');
  const edges = stateWith(
    revisedEvent(genesis, genesisPayload()), revisedEvent(v2, revisePayload([genesis]), undefined, 2000),
    envelope(nextRef(), 'memory.related', relatedPayload(genesis, v2, 'explains'), undefined, 3000),
  );
  assertRejected(edges, 'memory.related', relatedPayload(genesis, v2, 'explains'), 'already recorded');
  // The reverse direction is a different triple; superseded records remain
  // valid endpoints because edges never change fact state.
  assertMemoryAppendPreconditions(edges, 'memory.related', relatedPayload(v2, genesis, 'explains'));
  assertMemoryAppendPreconditions(edges, 'memory.related', relatedPayload(genesis, v2, 'depends_on'));
  // Replay-side integrity: unknown refs, self-loops and reused triples fail closed.
  assert.throws(() => stateWith(revisedEvent(genesis, genesisPayload()), envelope(nextRef(), 'memory.related', relatedPayload(genesis, nextRef()), undefined, 3000)), LedgerIntegrityError);
  assert.throws(() => stateWith(revisedEvent(genesis, genesisPayload()), envelope(nextRef(), 'memory.related', relatedPayload(genesis, genesis), undefined, 3000)), LedgerIntegrityError);
  assert.throws(() => stateWith(
    revisedEvent(genesis, genesisPayload()), revisedEvent(v2, revisePayload([genesis]), undefined, 2000),
    envelope(nextRef(), 'memory.related', relatedPayload(genesis, v2, 'explains'), undefined, 3000),
    envelope(nextRef(), 'memory.related', relatedPayload(genesis, v2, 'explains'), undefined, 4000),
  ), LedgerIntegrityError);
});

test('replay fails closed on genesis into a non-empty fact_key and on unknown supersedes refs', () => {
  const genesis = nextRef();
  assert.throws(() => stateWith(revisedEvent(genesis, genesisPayload()), revisedEvent(nextRef(), genesisPayload(), undefined, 2000)), LedgerIntegrityError);
  assert.throws(() => stateWith(revisedEvent(nextRef(), revisePayload([nextRef()]))), LedgerIntegrityError);
});

test('a clean multi-event history replays without integrity errors', () => {
  const genesis = nextRef();
  const v2 = nextRef();
  const v3 = nextRef();
  const state = stateWith(
    revisedEvent(genesis, genesisPayload()),
    revisedEvent(v2, revisePayload([genesis]), undefined, 2000),
    envelope(nextRef(), 'memory.revised', retractPayload([v2]), undefined, 3000),
    revisedEvent(v3, revisePayload([v2]), undefined, 4000),
  );
  // Retraction introduces no record; three records exist (v1, v2, v3).
  assert.equal(state.records.size, 3);
  assert.equal(state.records.get(v2)?.status, 'retracted');
  assert.equal(state.heads.get(FACT_KEY), v3);
  assert.equal(state.conflicts.size, 0);
});

// End-to-end atomic writes through the real ledger and its rebuilt views.
async function committedEvents(root: string): Promise<LedgerEvent[]> {
  const dir = join(root, '.ano', 'ledger');
  const names = readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort();
  const events: LedgerEvent[] = [];
  for (const name of names) events.push(...scanSegment(readFileSync(join(dir, name))).events);
  return events;
}

describe('memory ledger end-to-end atomic revision', () => {
  test('revise-linear moves the head and keeps every prior event byte-identical', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ano-memory-e2e-linear-'));
    try {
      const ledger = await Ledger.open(root, { sessionId: 'M1', actor: 'A', clock: () => 1000 });
      const genesis = await ledger.append({ kind: 'memory.revised', payload: genesisPayload() }, 'rev:1');
      assert.equal(genesis.duplicate, false);
      const before = await committedEvents(root);
      const hashesBefore = new Map(before.map((event) => [event.id, hashEvent(event)]));
      const v2 = await ledger.append({ kind: 'memory.revised', payload: revisePayload([genesis.event!.id]) }, 'rev:2');
      assert.equal(v2.duplicate, false);
      const after = await committedEvents(root);
      assert.equal(after.length, before.length + 1);
      for (const event of before) assert.equal(hashEvent(after.find((committed) => committed.id === event.id)!), hashesBefore.get(event.id));
      assert.equal(eventChain(after), true);
      ledger.close();
    } finally {
      removeTempRoot(root);
    }
  });

  test('same idempotency key replays the original event; different parameters are rejected', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ano-memory-e2e-idem-'));
    try {
      const ledger = await Ledger.open(root, { sessionId: 'M1', actor: 'A', clock: () => 1000 });
      const genesis = await ledger.append({ kind: 'memory.revised', payload: genesisPayload() }, 'rev:1');
      const replay = await ledger.append({ kind: 'memory.revised', payload: genesisPayload() }, 'rev:1');
      assert.equal(replay.duplicate, true);
      assert.equal(replay.event!.id, genesis.event!.id);
      assert.equal((await committedEvents(root)).length, 2, 'segment.started plus one memory event, no duplicates');
      await assert.rejects(() => ledger.append({ kind: 'memory.revised', payload: { ...genesisPayload(), reason: 'different parameters' } }, 'rev:1'), IdempotencyConflictError);
      assert.equal((await committedEvents(root)).length, 2);
      ledger.close();
    } finally {
      removeTempRoot(root);
    }
  });

  test('a competing revision on the same prior is rejected with zero writes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ano-memory-e2e-compete-'));
    try {
      const ledger = await Ledger.open(root, { sessionId: 'M1', actor: 'A', clock: () => 1000 });
      try {
        const genesis = await ledger.append({ kind: 'memory.revised', payload: genesisPayload() }, 'rev:1');
        const second = await Ledger.open(root, { sessionId: 'M2', actor: 'B', clock: () => 2000 });
        try {
          const prior = genesis.event!.id;
          const [firstResult, secondResult] = await Promise.allSettled([
            ledger.append({ kind: 'memory.revised', payload: revisePayload([prior]) }, 'rev:first'),
            second.append({ kind: 'memory.revised', payload: revisePayload([prior], { reason: 'competing revision' }) }, 'rev:second'),
          ]);
          const results = [firstResult, secondResult];
          assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
          const rejected = results.find((result) => result.status === 'rejected');
          assert.ok(rejected?.reason instanceof MemoryPreconditionError);
          assert.match(rejected.reason.message, /stale prior/u);
          const events = await committedEvents(root);
          assert.equal(events.filter((event) => event.idem_key === 'rev:first' || event.idem_key === 'rev:second').length, 1);
        } finally {
          second.close();
        }
      } finally {
        ledger.close();
      }
    } finally {
      removeTempRoot(root);
    }
  });

  test('failed memory appends leave no partial state and keep the chain intact', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ano-memory-e2e-atomic-'));
    try {
      const ledger = await Ledger.open(root, { sessionId: 'M1', actor: 'A', clock: () => 1000 });
      const genesis = await ledger.append({ kind: 'memory.revised', payload: genesisPayload() }, 'rev:1');
      const bytesBefore = readFileSync(ledger.segmentPath);
      await assert.rejects(() => ledger.append({ kind: 'memory.revised', payload: { ...genesisPayload(), unknown_field: true } }, 'rev:bad'), MemoryPreconditionError);
      await assert.rejects(() => ledger.append({ kind: 'memory.revised', payload: genesisPayload() }), MemoryPreconditionError, 'memory appends require an idempotency key');
      await assert.rejects(() => ledger.append({ kind: 'memory.revised', payload: genesisPayload() }, ''), Error, 'empty idempotency keys are invalid');
      assert.equal(readFileSync(ledger.segmentPath).compare(bytesBefore), 0);
      assert.equal(eventChain(await committedEvents(root)), true);
      const ok = await ledger.append({ kind: 'memory.revised', payload: revisePayload([genesis.event!.id]) }, 'rev:2');
      assert.equal(ok.duplicate, false);
      ledger.close();
    } finally {
      removeTempRoot(root);
    }
  });

  test('a failed segment fsync restores the log and rolls back the revision', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'ano-memory-e2e-fsync-'));
    try {
      const ledger = await Ledger.open(root, { sessionId: 'M1', clock: () => 1000 });
      try {
        const genesis = await ledger.append({ kind: 'memory.revised', payload: genesisPayload() }, 'rev:1');
        const prior = genesis.event!.id;
        const bytesBefore = readFileSync(ledger.segmentPath);
        const input = { kind: 'memory.revised', payload: revisePayload([prior]) } as const;
        const open = fs.openSync;
        const fsync = fs.fsyncSync;
        let appendFd: number | undefined;
        let faulted = false;
        const openMock = t.mock.method(fs, 'openSync', (...args: Parameters<typeof open>) => {
          const fd = open(...args);
          if (args[0] === ledger.segmentPath && args[1] === 'a') appendFd = fd;
          return fd;
        });
        const fsyncMock = t.mock.method(fs, 'fsyncSync', (fd: number) => {
          if (fd === appendFd && !faulted) {
            faulted = true;
            throw new Error('injected segment fsync failure');
          }
          fsync(fd);
        });
        syncBuiltinESMExports();
        try {
          await assert.rejects(ledger.append(input, 'rev:2'), /injected segment fsync failure/u);
        } finally {
          fsyncMock.mock.restore();
          openMock.mock.restore();
          syncBuiltinESMExports();
        }
        assert.ok(faulted);
        assert.deepEqual(readFileSync(ledger.segmentPath), bytesBefore);
        const db = new DatabaseSync(ledger.viewsPath, { readOnly: true });
        try {
          assert.equal(readMemoryHead(db, FACT_KEY)?.headRef, prior);
          assert.equal(readMemoryRecord(db, prior)?.status, 'active');
          assert.equal(db.prepare('SELECT 1 FROM idempotency WHERE idem_key = ?').get('rev:2'), undefined);
          assert.equal(db.prepare('SELECT 1 FROM events WHERE idem_key = ?').get('rev:2'), undefined);
        } finally {
          db.close();
        }
        assert.equal((await ledger.append(input, 'rev:2')).duplicate, false);
      } finally {
        ledger.close();
      }
      const reopened = await Ledger.open(root, { sessionId: 'M1', clock: () => 2000 });
      try {
        assert.equal((await committedEvents(root)).filter((event) => event.idem_key === 'rev:2').length, 1);
      } finally {
        reopened.close();
      }
    } finally {
      removeTempRoot(root);
    }
  });

  test('related edges register once; duplicates and self-loops are rejected', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ano-memory-e2e-related-'));
    try {
      const ledger = await Ledger.open(root, { sessionId: 'M1', actor: 'A', clock: () => 1000 });
      const genesis = await ledger.append({ kind: 'memory.revised', payload: genesisPayload() }, 'rev:1');
      const v2 = await ledger.append({ kind: 'memory.revised', payload: revisePayload([genesis.event!.id]) }, 'rev:2');
      const edge = await ledger.append({ kind: 'memory.related', payload: relatedPayload(genesis.event!.id, v2.event!.id, 'explains') }, 'edge:1');
      assert.equal(edge.duplicate, false);
      const bytesBefore = readFileSync(ledger.segmentPath);
      await assert.rejects(() => ledger.append({ kind: 'memory.related', payload: relatedPayload(genesis.event!.id, v2.event!.id, 'explains') }, 'edge:duplicate'), MemoryPreconditionError);
      await assert.rejects(() => ledger.append({ kind: 'memory.related', payload: relatedPayload(genesis.event!.id, genesis.event!.id) }, 'edge:self'), MemoryPreconditionError);
      assert.equal(readFileSync(ledger.segmentPath).compare(bytesBefore), 0);
      const reverse = await ledger.append({ kind: 'memory.related', payload: relatedPayload(v2.event!.id, genesis.event!.id, 'explains') }, 'edge:reverse');
      assert.equal(reverse.duplicate, false);
      ledger.close();
    } finally {
      removeTempRoot(root);
    }
  });

  test('governing a legacy note keeps the note event bytes untouched', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ano-memory-e2e-legacy-'));
    try {
      const ledger = await Ledger.open(root, { sessionId: 'M1', actor: 'A', clock: () => 1000 });
      const noteId = 'c'.repeat(64);
      const note = await ledger.append({ kind: 'note.recorded', payload: notePayload(noteId) }, 'note:1');
      const before = await committedEvents(root);
      await ledger.append({ kind: 'memory.revised', payload: { ...revisePayload([note.event!.id]), record: { text: 'governed version', kind: 'decision' } } }, 'gov:1');
      const after = await committedEvents(root);
      const noteAfter = after.find((event) => event.id === note.event!.id)!;
      assert.deepEqual(noteAfter, before.find((event) => event.id === note.event!.id));
      assert.ok(ledger.getNote(noteId), 'the notes view is untouched by governance');
      const bytesBefore = readFileSync(ledger.segmentPath);
      await assert.rejects(
        () => ledger.append({ kind: 'memory.revised', payload: { ...revisePayload([note.event!.id]), fact_key: 'other.fact.slot' } }, 'gov:2'),
        /already been governed/u,
      );
      assert.deepEqual(readFileSync(ledger.segmentPath), bytesBefore);
      ledger.close();
    } finally {
      removeTempRoot(root);
    }
  });

  for (const outcome of ['winner', 'retract_all'] as const) {
    test(`forked history stays undecided until adjudication: ${outcome}`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'ano-memory-e2e-fork-'));
      try {
        const first = await Ledger.open(root, { sessionId: 'F1', actor: 'A', clock: () => 1000 });
        let prior: string;
        try {
          prior = (await first.append({ kind: 'memory.revised', payload: genesisPayload() }, 'fork:genesis')).event!.id;
        } finally {
          first.close();
        }
        // Committed restore input can contain a fork the append layer would reject.
        const branchA = envelope(nextRef(), 'memory.revised', revisePayload([prior]), genesisHash, 3000, 'F', 'fork:branch-a');
        const branchB = envelope(nextRef(), 'memory.revised', revisePayload([prior]), hashEvent(branchA), 4000, 'F', 'fork:branch-b');
        const ledgerDir = join(root, '.ano', 'ledger');
        writeFileSync(join(ledgerDir, segmentFileName(5000, 'FORK')), encodeBatch('fork-batch', [branchA, branchB]));
        const ledger = await Ledger.open(root, { sessionId: 'F2', actor: 'B', clock: () => 6000 });
        const branches = [branchA.id, branchB.id];
        try {
          await assert.rejects(() => ledger.append({ kind: 'memory.revised', payload: revisePayload([branchA.id]) }, 'fork:late'), /undecided conflict/u);
          await ledger.append({ kind: 'memory.related', payload: relatedPayload(branchA.id, branchB.id) }, 'fork:edge');
          const db = new DatabaseSync(ledger.viewsPath, { readOnly: true });
          try {
            assert.equal(readMemoryHead(db, FACT_KEY)?.headRef, null);
            assert.equal(readMemoryHead(db, FACT_KEY)?.status, 'conflicted');
            assert.deepEqual([...readMemoryConflict(db, FACT_KEY)!.branches].sort(), [...branches].sort());
          } finally {
            db.close();
          }
          const ruling = outcome === 'winner' ? { type: outcome, winner_ref: branchA.id } : { type: outcome };
          await ledger.append({ kind: 'memory.conflict.resolved', payload: resolvedPayload(branches, ruling) }, 'fork:resolve');
          if (outcome === 'winner') {
            const next = await ledger.append({ kind: 'memory.revised', payload: revisePayload([branchA.id]) }, 'fork:v3');
            assert.equal(next.event?.prev_hash, hashEvent((await committedEvents(root)).find((event) => event.idem_key === 'fork:resolve')!));
          } else {
            await assert.rejects(() => ledger.append({ kind: 'memory.revised', payload: genesisPayload() }, 'fork:genesis-again'), /unused fact_key/u);
            await assert.rejects(() => ledger.append({ kind: 'memory.revised', payload: revisePayload([branchA.id]) }, 'fork:revise-again'), /no current head/u);
          }
        } finally {
          ledger.close();
        }
        for (const name of readdirSync(ledgerDir).filter((entry) => entry.endsWith('.jsonl'))) {
          assert.ok(eventChain(scanSegment(readFileSync(join(ledgerDir, name))).events), `segment ${name} keeps a valid chain`);
        }
        const committed = await committedEvents(root);
        assert.equal(committed.filter((event) => event.kind === 'memory.conflict.resolved').length, 1);
        if (outcome === 'retract_all') {
          const reopened = await Ledger.open(root);
          try {
            const db = new DatabaseSync(reopened.viewsPath, { readOnly: true });
            try {
              assert.equal(readMemoryHead(db, FACT_KEY)?.status, 'retracted');
              assert.equal(readMemoryHead(db, FACT_KEY)?.headRef, null);
              assert.equal(readMemoryConflict(db, FACT_KEY), undefined);
              for (const branch of branches) assert.equal(readMemoryRecord(db, branch)?.status, 'retracted');
            } finally {
              db.close();
            }
          } finally {
            reopened.close();
          }
        }
      } finally {
        removeTempRoot(root);
      }
    });
  }
});
