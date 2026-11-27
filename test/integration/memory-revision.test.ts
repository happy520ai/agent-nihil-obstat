import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { eventChain, genesisHash, hashEvent, ledgerEventKinds, type LedgerEvent } from '../../src/ledger/event.ts';
import { segmentFileName } from '../../src/ledger/append.ts';
import { encodeEvents } from '../../src/ledger/segment.ts';
import { replayLedger } from '../../src/ledger/replay.ts';
import { Ledger, MemoryPreconditionError, type LedgerAppendResult } from '../../src/ledger/ledger.ts';
import {
  applyEventToDb,
  IdempotencyConflictError,
  initViews,
  LedgerIntegrityError,
  readMemoryHeads,
  readMemoryRecord,
  readMemoryRecords,
  readNote,
  syncViews,
  VIEW_SCHEMA_VERSION,
  type ViewApplyResult,
  type ViewReplayEntry,
} from '../../src/ledger/views.ts';
import { listUnresolvedMemoryConflicts, readMemoryFactHistory, readMemoryRelations, resolveMemoryFact } from '../../src/memory/state.ts';
import { memoryFactSurface } from '../../src/surface/memory.ts';

/**
 * ADR-005 §13 named fixture matrix for the versioned memory projection
 * (src/ledger/views.ts) and its read model (src/memory/state.ts).
 *
 * These tests drive the projection/replay layer directly (applyEventToDb /
 * syncViews): that layer re-derives state from committed event bytes and fails
 * closed on every violation. The append-layer precondition rejections named by
 * the same matrix (stale priors, unknown refs, duplicate edges) are enforced
 * inside the locked write path (ledger.ts, AP-07) and are additionally covered
 * here by their ADR-005 §7 replay-layer semantics.
 *
 * The `p1-integration` drills at the end of this file drive the real on-disk
 * persistence protocol end to end (Ledger.open → locked append → replay →
 * views): concurrent replay races, the §11 backup/rollback drill with its
 * compatible-version boundary, and the §12 mis-retirement forward-correction
 * drill — each asserting that committed bytes and hashes never change.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let counter = 0;
function ulid(): string {
  counter += 1;
  let encoded = '';
  let value = counter;
  do {
    encoded = ALPHABET[value % 32] + encoded;
    value = Math.floor(value / 32);
  } while (value > 0);
  return `01J${encoded}`.padEnd(26, '0');
}

const BASE = 1_795_219_200_000; // 2026-11-21T00:00:00.000Z
const NOW = '2026-11-21T00:00:00.000Z';
const PAST = '2026-01-01T00:00:00.000Z';
const MID = '2026-06-01T00:00:00.000Z';
const FUTURE = '2027-01-01T00:00:00.000Z';
const ISO = '2026-01-01T00:00:00.000Z';
const FACT = 'local.storage.engine';

interface EventOptions { id?: string; idem?: string; prev?: string; physical?: number; logical?: number }

function event(kind: LedgerEvent['kind'], payload: Record<string, unknown>, options: EventOptions = {}): LedgerEvent {
  counter += 1;
  return {
    id: options.id ?? ulid(),
    hlc: { physical: options.physical ?? BASE, logical: options.logical ?? counter, actor: 'tester' },
    actor: 'tester',
    kind,
    payload,
    ...(options.idem === undefined ? {} : { idem_key: options.idem }),
    prev_hash: options.prev ?? '0'.repeat(64),
  };
}

function noteEvent(fields: { noteId?: string; kind?: string; text?: string } = {}, options: EventOptions = {}): LedgerEvent {
  const kind = fields.kind ?? 'decision';
  const anchor = kind === 'session_summary' ? undefined : { file: 'src/a.ts', symbolId: 'id-a' };
  return event('note.recorded', {
    note_id: fields.noteId ?? 'a'.repeat(64),
    kind,
    text: fields.text ?? 'keep the lease',
    created_at: ISO,
    ...(anchor === undefined ? {} : { anchor }),
  }, options);
}

function revisedEvent(overrides: Record<string, unknown> = {}, options: EventOptions = {}): LedgerEvent {
  counter += 1;
  const payload: Record<string, unknown> = {
    intent: 'revise',
    fact_key: FACT,
    record: { text: `storage engine v${counter}`, kind: 'decision' },
    supersedes: [],
    reason: 'initial version',
    effective_from: null,
    effective_to: null,
    ...overrides,
  };
  return event('memory.revised', payload, { idem: `idem:${counter}`, ...options });
}

function retractEvent(factKey: string, headRef: string, overrides: Record<string, unknown> = {}, options: EventOptions = {}): LedgerEvent {
  counter += 1;
  return event('memory.revised', {
    intent: 'retract',
    fact_key: factKey,
    supersedes: [headRef],
    reason: 'wrong content',
    ...overrides,
  }, { ...options, idem: options.idem ?? `idem:r${counter}` });
}

function relatedEvent(fromRef: string, toRef: string, overrides: Record<string, unknown> = {}, options: EventOptions = {}): LedgerEvent {
  counter += 1;
  return event('memory.related', {
    edge: 'depends_on',
    from_ref: fromRef,
    to_ref: toRef,
    reason: 'relation',
    ...overrides,
  }, { ...options, idem: options.idem ?? `idem:e${counter}` });
}

function adjudicationEvent(factKey: string, branches: string[], outcome: Record<string, unknown>, overrides: Record<string, unknown> = {}, options: EventOptions = {}): LedgerEvent {
  counter += 1;
  return event('memory.conflict.resolved', {
    fact_key: factKey,
    branches,
    outcome,
    reason: 'adjudication',
    ...overrides,
  }, { ...options, idem: options.idem ?? `idem:a${counter}` });
}

function entries(events: readonly LedgerEvent[], segment = 'segment-0001'): ViewReplayEntry[] {
  return events.map((item) => ({ event: item, segment }));
}

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  initViews(db);
  return db;
}

function apply(db: DatabaseSync, created: LedgerEvent): ViewApplyResult {
  return applyEventToDb(db, created, 'segment-0001');
}

function expectIntegrity(run: () => unknown, pattern?: RegExp): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof LedgerIntegrityError, `expected LedgerIntegrityError, got ${String(error)}`);
    return pattern ? pattern.test((error as Error).message) : true;
  });
}

function memoryDump(db: DatabaseSync): Record<string, unknown[]> {
  const dump: Record<string, unknown[]> = {};
  for (const table of ['memory_records', 'memory_heads', 'memory_edges', 'memory_conflicts']) {
    dump[table] = (db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return dump;
}

test('revise-linear: head moves, old record superseded, committed event hashes unchanged', () => {
  const db = freshDb();
  const note = noteEvent();
  const genesis = revisedEvent({}, { prev: hashEvent(note) });
  apply(db, note);
  const hashesBefore = [note, genesis].map((item) => hashEvent(item));
  apply(db, genesis);
  const revise = revisedEvent({ supersedes: [genesis.id], reason: 'switch engine' }, { prev: hashEvent(genesis) });
  apply(db, revise);

  const head = readMemoryHeads(db);
  assert.equal(head.length, 1);
  assert.equal(head[0]?.headRef, revise.id);
  assert.equal(head[0]?.status, 'active');
  assert.equal(head[0]?.version, 2);
  assert.equal(readMemoryRecord(db, genesis.id)?.status, 'superseded');
  assert.equal(readMemoryRecord(db, genesis.id)?.supersededBy, revise.id);
  assert.equal(readMemoryRecord(db, revise.id)?.version, 2);
  // Pre-existing committed events keep their bytes and hashes (ADR-005 §2.1).
  assert.deepEqual([note, genesis].map((item) => hashEvent(item)), hashesBefore);
  const stored = (db.prepare('SELECT event_id, hash FROM events ORDER BY event_id').all() as { event_id: string; hash: string }[])
    .map((row) => row.hash);
  assert.ok(stored.includes(hashEvent(note)));
  assert.ok(stored.includes(hashEvent(genesis)));
  assert.equal(eventChain([note, genesis, revise]), true);
  // Re-applying a committed event is a no-op duplicate.
  assert.equal(apply(db, note).duplicate, true);
  assert.equal(apply(db, genesis).duplicate, true);

  const read = resolveMemoryFact(db, FACT, { now: NOW });
  assert.equal(read.found, true);
  assert.equal(read.record?.recordRef, revise.id);
});

test('revise-idempotent: same idem_key duplicates, different parameters conflict, zero extra events', () => {
  const db = freshDb();
  const first = revisedEvent();
  apply(db, first);
  const retry = event('memory.revised', structuredClone(first.payload), { id: ulid(), idem: first.idem_key! });
  const result = apply(db, retry);
  assert.equal(result.duplicate, true);
  assert.equal(result.applied, false);
  // Same idem_key with different parameters is rejected; zero extra events.
  assert.throws(() => apply(db, revisedEvent({ reason: 'different' }, { idem: first.idem_key! })), (error: unknown) => {
    assert.ok(error instanceof IdempotencyConflictError);
    return true;
  });
  assert.equal(readMemoryRecords(db).length, 1);
  // Zero extra events at the ledger level is enforced by the append layer;
  // what the projection guarantees is that neither the duplicate nor the
  // conflicting replay adds any memory state (heads, edges, conflicts).
  assert.equal(readMemoryHeads(db).length, 1);
  assert.equal(readMemoryHeads(db)[0]?.headRef, first.id);
});

test('revise-stale-prior: stale middle refs fail closed at replay', () => {
  const db = freshDb();
  const v1 = revisedEvent();
  apply(db, v1);
  const v2 = revisedEvent({ supersedes: [v1.id] });
  apply(db, v2);
  const v3 = revisedEvent({ supersedes: [v2.id] });
  apply(db, v3);
  // A committed history that claims a revision of v1 while v3 is head cannot be
  // projected: the append layer would have rejected it, so replay fails closed.
  const stale = revisedEvent({ supersedes: [v1.id], reason: 'stale dependency' });
  expectIntegrity(() => apply(db, stale), /stale ref/);
  assert.equal(readMemoryHeads(db)[0]?.headRef, v3.id);
});

test('revise-unknown-ref and revise-self-loop are rejected', () => {
  const db = freshDb();
  const unknown = revisedEvent({ supersedes: [ulid()] });
  expectIntegrity(() => apply(db, unknown), /unresolvable ref/);
  // A true self-reference: the event names its own id as the prior version,
  // which by construction cannot exist yet.
  const selfId = ulid();
  const self = event('memory.revised', {
    intent: 'revise',
    fact_key: FACT,
    record: { text: 'self', kind: 'decision' },
    supersedes: [selfId],
    reason: 'self',
    effective_from: null,
    effective_to: null,
  }, { id: selfId, idem: 'idem:self' });
  expectIntegrity(() => apply(db, self), /unresolvable ref/);
  assert.equal(readMemoryRecords(db).length, 0);
});

test('revise-legacy-entry: note bytes and legacy read output stay intact while governance transitions', () => {
  const db = freshDb();
  const note = noteEvent();
  apply(db, note);
  const noteHash = hashEvent(note);
  const noteRow = readNote(db, 'a'.repeat(64));
  assert.ok(noteRow);

  const entry = revisedEvent({
    fact_key: FACT,
    supersedes: [note.id],
    record: { text: 'governed version of the note', kind: 'decision' },
    reason: 'adopting the legacy note into governance',
  });
  apply(db, entry);

  // ADR-005 §8: the note event, its view row and the old read output are unchanged.
  assert.equal(hashEvent(note), noteHash);
  const after = readNote(db, 'a'.repeat(64));
  assert.deepEqual(after, noteRow);
  const legacy = readMemoryRecord(db, note.id);
  assert.equal(legacy?.status, 'superseded');
  assert.equal(legacy?.eligibility, 'legacy_unreviewed');
  assert.equal(legacy?.supersededBy, entry.id);
  const governed = readMemoryRecord(db, entry.id);
  assert.equal(governed?.eligibility, 'governed');
  assert.equal(governed?.status, 'active');
  assert.equal(governed?.version, 1);
  const read = resolveMemoryFact(db, FACT, { now: NOW });
  assert.equal(read.found, true);
  assert.equal(read.record?.recordRef, entry.id);
  // The superseded legacy record is not part of the governed lineage read.
  assert.equal(readMemoryRecords(db, { factKey: FACT }).length, 1);
});

test('related-edge: registration keeps fact state; duplicate triples and self-loops rejected', () => {
  const db = freshDb();
  const r1 = revisedEvent({ fact_key: 'fact.one' });
  apply(db, r1);
  const r2 = revisedEvent({ fact_key: 'fact.two' });
  apply(db, r2);
  const edges = readMemoryRelations(db, r1.id);
  assert.equal(edges.outgoing.length, 0);

  apply(db, relatedEvent(r1.id, r2.id));
  assert.equal(readMemoryRelations(db, r1.id).outgoing.length, 1);
  assert.equal(readMemoryRelations(db, r2.id).incoming.length, 1);
  // Relations never change fact state (ADR-005 §4.2).
  assert.equal(resolveMemoryFact(db, 'fact.one', { now: NOW }).found, true);
  assert.equal(resolveMemoryFact(db, 'fact.two', { now: NOW }).found, true);

  // Same triple via a different event -> duplicate registration is refused.
  expectIntegrity(() => apply(db, relatedEvent(r1.id, r2.id, {}, { idem: 'idem:duplicate' })), /already registered/);
  // Self-loop -> refused.
  expectIntegrity(() => apply(db, relatedEvent(r1.id, r1.id, { edge: 'related_to' }, { idem: 'idem:loop' })), /self-loop/);
  // Unknown endpoint -> refused (cross-project refs are unresolvable here).
  expectIntegrity(() => apply(db, relatedEvent(r1.id, ulid(), { edge: 'explains' }, { idem: 'idem:unknown' })), /unresolvable/);
});

test('fork-replay: same-prior revisions project as an undecided conflict without a winner', () => {
  // Two segments each commit a revision depending on the same prior — exactly
  // the future multi-segment merge case ADR-005 §7 defends against.
  const v1 = revisedEvent({ fact_key: 'fact.forked' });
  const branchA = revisedEvent({ fact_key: 'fact.forked', supersedes: [v1.id], reason: 'from segment A' });
  const branchB = revisedEvent({ fact_key: 'fact.forked', supersedes: [v1.id], reason: 'from segment B' });
  const db = freshDb();
  apply(db, v1);
  apply(db, branchA);
  apply(db, branchB);

  const read = resolveMemoryFact(db, 'fact.forked');
  assert.equal(read.found, false);
  assert.equal(read.status, 'conflicted');
  assert.equal(read.reason, 'unresolved_conflict');
  assert.deepEqual(read.branches, [branchA.id, branchB.id]);
  assert.equal(readMemoryHeads(db)[0]?.headRef, null);
  assert.equal(readMemoryHeads(db)[0]?.status, 'conflicted');
  const conflicts = listUnresolvedMemoryConflicts(db);
  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0]?.branches, [branchA.id, branchB.id]);
  // No branch may masquerade as the current fact, and no winner was chosen.
  assert.ok(conflicts[0]?.branchRecords.every((record) => record.status === 'conflicted'));
  // A third revision naming the same prior joins the branch set.
  const branchC = revisedEvent({ fact_key: 'fact.forked', supersedes: [v1.id], reason: 'from segment C' });
  apply(db, branchC);
  assert.equal(listUnresolvedMemoryConflicts(db)[0]?.branches.length, 3);
  // And a revision naming anything else fails closed while the conflict stands.
  expectIntegrity(() => apply(db, revisedEvent({ fact_key: 'fact.forked', supersedes: [branchA.id], reason: 'too late' })), /while its conflict is undecided/);
});

test('adjudicate-winner: winner survives as head, losers superseded; mismatched branch sets fail closed', () => {
  const db = freshDb();
  const v1 = revisedEvent({ fact_key: 'fact.adjudicated' });
  apply(db, v1);
  const b1 = revisedEvent({ fact_key: 'fact.adjudicated', supersedes: [v1.id] });
  apply(db, b1);
  const b2 = revisedEvent({ fact_key: 'fact.adjudicated', supersedes: [v1.id] });
  apply(db, b2);

  // Missing a branch fails at the payload schema (min 2); inventing a branch
  // reaches the projection's set equality check. Both fail closed.
  expectIntegrity(() => apply(db, adjudicationEvent('fact.adjudicated', [b1.id], { type: 'winner', winner_ref: b1.id }, {}, { idem: 'idem:few' })), /payload is invalid/);
  expectIntegrity(() => apply(db, adjudicationEvent('fact.adjudicated', [b1.id, b2.id, ulid()], { type: 'winner', winner_ref: b1.id }, {}, { idem: 'idem:many' })), /do not match/);
  // The reversed-order declaration is the same set — the adjudication applies.
  const winner = adjudicationEvent('fact.adjudicated', [b2.id, b1.id], { type: 'winner', winner_ref: b2.id });
  apply(db, winner);
  const read = resolveMemoryFact(db, 'fact.adjudicated', { now: NOW });
  assert.equal(read.found, true);
  assert.equal(read.record?.recordRef, b2.id);
  assert.equal(readMemoryRecord(db, b1.id)?.status, 'superseded');
  assert.equal(readMemoryRecord(db, b1.id)?.supersededBy, b2.id);
  assert.equal(readMemoryRecord(db, v1.id)?.status, 'superseded');
  // Adjudicating a settled fact_key fails: there is no undecided conflict left.
  expectIntegrity(() => apply(db, adjudicationEvent('fact.adjudicated', [b1.id, b2.id], { type: 'winner', winner_ref: b1.id }, {}, { idem: 'idem:twice' })), /without an undecided conflict/);
});

test('adjudicate-record and adjudicate-retract_all apply their ADR-005 §4.3 outcomes', () => {
  const db = freshDb();
  const v1 = revisedEvent({ fact_key: 'fact.record' });
  apply(db, v1);
  const b1 = revisedEvent({ fact_key: 'fact.record', supersedes: [v1.id] });
  apply(db, b1);
  const b2 = revisedEvent({ fact_key: 'fact.record', supersedes: [v1.id] });
  apply(db, b2);
  const record = adjudicationEvent('fact.record', [b1.id, b2.id], {
    type: 'record',
    record: { text: 'adjudicated version', kind: 'pitfall' },
    effective_from: PAST,
    effective_to: null,
  });
  apply(db, record);
  const read = resolveMemoryFact(db, 'fact.record', { now: NOW });
  assert.equal(read.found, true);
  assert.equal(read.record?.recordRef, record.id);
  assert.equal(read.record?.version, 3);
  assert.equal(read.record?.kind, 'pitfall');
  assert.equal(read.record?.effectiveFrom, PAST);
  assert.equal(readMemoryRecord(db, b1.id)?.supersededBy, record.id);
  assert.equal(readMemoryRecord(db, b2.id)?.supersededBy, record.id);

  const vA = revisedEvent({ fact_key: 'fact.retractall' });
  apply(db, vA);
  const c1 = revisedEvent({ fact_key: 'fact.retractall', supersedes: [vA.id] });
  apply(db, c1);
  const c2 = revisedEvent({ fact_key: 'fact.retractall', supersedes: [vA.id] });
  apply(db, c2);
  apply(db, adjudicationEvent('fact.retractall', [c1.id, c2.id], { type: 'retract_all' }));
  const retracted = resolveMemoryFact(db, 'fact.retractall');
  assert.equal(retracted.status, 'retracted');
  assert.equal(retracted.headRef, null);
  assert.equal(readMemoryRecord(db, c1.id)?.status, 'retracted');
  assert.equal(readMemoryRecord(db, c2.id)?.status, 'retracted');
  // Unknown outcome types are refused (strict schema -> payload is invalid).
  expectIntegrity(() => apply(db, adjudicationEvent('fact.record', [b1.id, b2.id], { type: 'nuclear' }, {}, { idem: 'idem:nuclear' })));
});

test('legacy-unreviewed: a note-only ledger stays outside governed facts after rebuild', () => {
  const note = noteEvent();
  const summary = noteEvent({ noteId: 'b'.repeat(64), kind: 'session_summary', text: 'weekly summary' });
  const db = freshDb();
  syncViews(db, entries([note, summary]));
  assert.equal(readMemoryRecords(db).length, 2);
  assert.ok(readMemoryRecords(db).every((record) => record.eligibility === 'legacy_unreviewed' && record.factKey === null));
  assert.equal(readMemoryHeads(db).length, 0);
  const fact = resolveMemoryFact(db, FACT);
  assert.equal(fact.found, false);
  assert.equal(fact.reason, 'unknown_fact_key');
  // Old note read output is byte-stable across the projection change.
  const row = readNote(db, 'a'.repeat(64));
  assert.equal(row?.text, 'keep the lease');
  assert.equal(row?.createdAt, ISO);
});

test('temporal-unknown: rebuild reports unknown intervals and never backfills recorded_at', () => {
  const genesis = revisedEvent({ effective_from: null, effective_to: null });
  const db = freshDb();
  syncViews(db, entries([genesis]));
  const read = resolveMemoryFact(db, FACT, { now: NOW });
  assert.equal(read.found, true);
  assert.equal(read.temporalUnknown, true);
  assert.equal(read.record?.effectiveFrom, null);
  assert.equal(read.record?.recordedAt, new Date(BASE).toISOString());
  // Historical read of the same unknown interval also stays marked.
  const historical = resolveMemoryFact(db, FACT, { mode: 'historical', asOf: NOW });
  assert.equal(historical.found, true);
  assert.equal(historical.usage, 'historical');
  assert.equal(historical.temporalUnknown, true);
});

test('rebuild-fail-closed: tampered committed events abort the whole rebuild', () => {
  const note = noteEvent();
  const genesis = revisedEvent({}, { prev: hashEvent(note) });
  const validRevise = revisedEvent({ supersedes: [genesis.id] }, { prev: hashEvent(genesis) });
  // Tamper: point the committed revision at an unresolvable ref.
  const tampered = structuredClone(validRevise) as LedgerEvent & { payload: Record<string, unknown> };
  tampered.payload = { ...tampered.payload, supersedes: [ulid()] };

  const db = freshDb();
  expectIntegrity(() => syncViews(db, entries([note, genesis, tampered])), /unresolvable ref/);
  // The failed rebuild left no partial state behind (transactional rollback).
  for (const table of ['memory_records', 'memory_heads', 'memory_edges', 'memory_conflicts', 'notes', 'events']) {
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, 0, table);
  }
  // The untampered history rebuilds cleanly.
  syncViews(db, entries([note, genesis, validRevise]));
  assert.equal(resolveMemoryFact(db, FACT, { now: NOW }).found, true);

  // Tampered adjudication branch sets fail closed as well (ADR-005 §13).
  const v1 = revisedEvent({ fact_key: 'fact.tamper2' });
  const b1 = revisedEvent({ fact_key: 'fact.tamper2', supersedes: [v1.id] });
  const b2 = revisedEvent({ fact_key: 'fact.tamper2', supersedes: [v1.id] });
  const validAdjudication = adjudicationEvent('fact.tamper2', [b1.id, b2.id], { type: 'winner', winner_ref: b1.id });
  const tamperedAdjudication = structuredClone(validAdjudication) as LedgerEvent & { payload: Record<string, unknown> };
  // Two entries pass the schema but invent a branch that was never undecided.
  tamperedAdjudication.payload = { ...tamperedAdjudication.payload, branches: [b1.id, ulid()] };
  const db2 = freshDb();
  expectIntegrity(() => syncViews(db2, entries([v1, b1, b2, tamperedAdjudication])), /do not match/);
  const db3 = freshDb();
  syncViews(db3, entries([v1, b1, b2, validAdjudication]));
  assert.equal(resolveMemoryFact(db3, 'fact.tamper2', { now: NOW }).record?.recordRef, b1.id);
});

test('rebuild from an empty view equals the incrementally projected state', () => {
  const note = noteEvent();
  const genesis = revisedEvent({ effective_from: PAST, effective_to: null }, { prev: hashEvent(note) });
  const revise = revisedEvent({ supersedes: [genesis.id], effective_from: MID, effective_to: null }, { prev: hashEvent(genesis) });
  const edge = relatedEvent(note.id, genesis.id, { edge: 'explains' }, { prev: hashEvent(revise) });
  const v2 = revisedEvent({ fact_key: 'fact.fork', supersedes: [] }, { prev: hashEvent(edge) });
  const b1 = revisedEvent({ fact_key: 'fact.fork', supersedes: [v2.id] }, { prev: hashEvent(v2) });
  const b2 = revisedEvent({ fact_key: 'fact.fork', supersedes: [v2.id] }, { prev: hashEvent(b1) });
  const adjudication = adjudicationEvent('fact.fork', [b1.id, b2.id], { type: 'winner', winner_ref: b1.id }, {}, { prev: hashEvent(b2) });
  const history = [note, genesis, revise, edge, v2, b1, b2, adjudication];

  const incremental = freshDb();
  for (const item of history) apply(incremental, item);
  const rebuilt = freshDb();
  syncViews(rebuilt, entries(history, 'segment-0001'));

  assert.deepEqual(memoryDump(rebuilt), memoryDump(incremental));
  // And a second full replay of the same log is stable (digest short-circuit).
  syncViews(rebuilt, entries(history, 'segment-0001'));
  assert.deepEqual(memoryDump(rebuilt), memoryDump(incremental));
});

test('downgrade-branch: pre-memory segments replay on the old vocabulary, branch files preserved and re-adoptable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ano-memory-downgrade-'));
  try {
    const ledgerDir = join(dir, 'ledger');
    mkdirSync(ledgerDir, { recursive: true });
    // Backup era: only pre-memory kinds (an old binary's vocabulary can replay this).
    const note = noteEvent();
    const segmentA = join(ledgerDir, segmentFileName(1000, 'SEGA'));
    writeFileSync(segmentA, encodeEvents([note]));

    const db = freshDb();
    const before = replayLedger(ledgerDir);
    assert.equal(before.entries.length, 1);
    syncViews(db, before.entries);
    const oldKinds = ledgerEventKinds.filter((kind) => !kind.startsWith('memory.'));
    assert.ok(before.entries.every((entry) => (oldKinds as string[]).includes(entry.event.kind)));
    assert.equal(eventChain([note]), true);

    // A memory.* branch is appended by the new writer. Segment hash chains are
    // per segment and start at genesisHash, so the branch event chains from
    // there; global ordering comes from the HLC.
    const revised = revisedEvent({ fact_key: FACT }, { prev: genesisHash, physical: BASE + 1_000 });
    const segmentB = join(ledgerDir, segmentFileName(2000, 'SEGB'));
    writeFileSync(segmentB, encodeEvents([revised]));
    const after = replayLedger(ledgerDir);
    assert.equal(after.entries.length, 2);
    syncViews(db, after.entries);
    assert.equal(resolveMemoryFact(db, FACT, { now: NOW }).found, true);

    // Restoring the backup era rebuilds the pre-memory projection…
    syncViews(db, before.entries);
    assert.equal(resolveMemoryFact(db, FACT).reason, 'unknown_fact_key');
    assert.equal(readMemoryRecords(db).length, 1);
    // …while the post-backup branch file is preserved byte-for-byte (ADR-005 §11.4:
    // the branch stays for audit and later re-adoption; no event is deleted).
    assert.deepEqual(readFileSync(segmentB), encodeEvents([revised]));
    // Both branches stay internally valid, so a new version can re-adopt them.
    assert.equal(eventChain([note]), true);
    assert.equal(eventChain([revised]), true);
    // Re-adopting the branch reproduces the identical deterministic projection.
    syncViews(db, after.entries);
    assert.equal(resolveMemoryFact(db, FACT, { now: NOW }).found, true);
    assert.equal(readMemoryHeads(db)[0]?.headRef, revised.id);
    assert.equal(Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version), VIEW_SCHEMA_VERSION);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P1 integration acceptance drills (AP-10): the real on-disk persistence
// protocol, exercising ADR-005 §11 (backup/rollback) and §12 (mis-retirement
// recovery) against committed bytes and hashes.
// ---------------------------------------------------------------------------

/**
 * Best-effort temp cleanup: a just-closed SQLite views handle can linger on
 * Windows (delete-pending), so a cleanup failure must not flip a test whose
 * assertions already passed.
 */
function removeTempRoot(root: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= 9) {
        console.warn(`memory-revision: temp root not removable (kept for inspection): ${root} — ${String(error)}`);
        return;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

function revisePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    intent: 'revise',
    fact_key: FACT,
    record: { text: 'governed storage engine', kind: 'decision' },
    supersedes: [],
    reason: 'initial governed version',
    effective_from: null,
    effective_to: null,
    ...overrides,
  };
}

function retractPayload(supersedes: string[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { intent: 'retract', fact_key: FACT, supersedes, reason: 'automatic retirement', ...overrides };
}

function notePayload(noteId: string): Record<string, unknown> {
  return { note_id: noteId, kind: 'decision', text: 'keep the lease', created_at: ISO, anchor: { file: 'src/a.ts' } };
}

/** sha256 of every committed segment file in the ledger directory. */
function segmentManifest(directory: string): Map<string, string> {
  const manifest = new Map<string, string>();
  for (const name of readdirSync(directory).filter((file) => file.endsWith('.jsonl')).sort()) {
    manifest.set(name, createHash('sha256').update(readFileSync(join(directory, name))).digest('hex'));
  }
  return manifest;
}

/** ADR-005 §11.1: the backup manifest verifies per file, or writes stay disabled. */
function manifestVerifies(directory: string, manifest: Map<string, string>): boolean {
  for (const [name, hash] of manifest) {
    const path = join(directory, name);
    if (!existsSync(path) || createHash('sha256').update(readFileSync(path)).digest('hex') !== hash) return false;
  }
  return true;
}

function onDiskBytes(directory: string): Map<string, string> {
  const bytes = new Map<string, string>();
  for (const name of readdirSync(directory).filter((file) => file.endsWith('.jsonl')).sort()) {
    bytes.set(name, readFileSync(join(directory, name)).toString('base64'));
  }
  return bytes;
}

test('p1-integration: concurrent sessions replay one log, race a single prior, and the loser writes nothing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ano-memory-p1-race-'));
  try {
    const ledgerDir = join(root, '.ano', 'ledger');
    const first = await Ledger.open(root, { sessionId: 'SESA', actor: 'writer-a', clock: () => 1_000 });
    const genesis = (await first.append({ kind: 'memory.revised', payload: revisePayload() }, 'p1:genesis')).event!;
    const prior = genesis.id;

    const beforeRace = onDiskBytes(ledgerDir);

    // Two sessions replay the same committed log concurrently (both rebuild
    // the views under the shared cache lock).
    const [left, right] = await Promise.all([
      Ledger.open(root, { sessionId: 'SESB', actor: 'writer-b', clock: () => 2_000 }),
      Ledger.open(root, { sessionId: 'SESC', actor: 'writer-c', clock: () => 3_000 }),
    ]);

    // Both race to revise the same prior: exactly one commits, the other is
    // rejected inside BEGIN IMMEDIATE with zero writes.
    const attempts = [
      { key: 'p1:race-b', clock: 2_000, session: 'SESB', ledger: left, payload: revisePayload({ supersedes: [prior], reason: 'from B' }) },
      { key: 'p1:race-c', clock: 3_000, session: 'SESC', ledger: right, payload: revisePayload({ supersedes: [prior], reason: 'from C' }) },
    ];
    const race = await Promise.allSettled(attempts.map((attempt) => attempt.ledger.append({ kind: 'memory.revised', payload: attempt.payload }, attempt.key)));
    const winnerIndex = race.findIndex((item) => item.status === 'fulfilled');
    assert.notEqual(winnerIndex, -1, 'exactly one racer must commit');
    const loserIndex = 1 - winnerIndex;
    assert.equal(race[loserIndex]!.status, 'rejected');
    assert.ok((race[loserIndex] as PromiseRejectedResult).reason instanceof MemoryPreconditionError, `expected MemoryPreconditionError, got ${String((race[loserIndex] as PromiseRejectedResult).reason)}`);
    const winnerAttempt = attempts[winnerIndex]!;
    const loserAttempt = attempts[loserIndex]!;
    const winnerEvent = (race[winnerIndex] as PromiseFulfilledResult<LedgerAppendResult>).value.event!;
    assert.equal(winnerEvent.payload.reason, winnerAttempt.payload.reason);

    // The loser's append left zero bytes: its session segment never appears
    // and every pre-race segment is byte-identical.
    assert.equal(existsSync(join(ledgerDir, segmentFileName(loserAttempt.clock, loserAttempt.session))), false, 'the losing append must not create a segment');
    const afterRace = onDiskBytes(ledgerDir);
    for (const [name, bytes] of beforeRace) assert.equal(afterRace.get(name), bytes, name);

    // Cross-session idempotency (durable protocol): a brand-new session
    // replaying the winner's exact parameters under the same idem key gets the
    // original event back and writes nothing.
    const third = await Ledger.open(root, { sessionId: 'SESD', actor: 'writer-d', clock: () => 4_000 });
    const replayed = await third.append({ kind: 'memory.revised', payload: winnerEvent.payload }, winnerAttempt.key);
    assert.equal(replayed.duplicate, true);
    assert.equal(replayed.event?.id, winnerEvent.id);
    // The loser's own parameters are still rejected: its key was never
    // committed and the prior is taken.
    await assert.rejects(
      () => loserAttempt.ledger.append({ kind: 'memory.revised', payload: loserAttempt.payload }, loserAttempt.key),
      MemoryPreconditionError,
    );

    // Convergence: the surface read (its own replay + projection) and an
    // independent from-scratch rebuild agree on the committed state.
    const viaSurface = await memoryFactSurface(third, { fact_key: FACT, now: NOW });
    assert.equal(viaSurface.fact.found, true);
    assert.equal(viaSurface.fact.record?.recordRef, winnerEvent.id);
    assert.equal(viaSurface.fact.record?.version, 2);
    assert.equal(viaSurface.versions.length, 2);
    const entries = replayLedger(ledgerDir).entries;
    assert.equal(entries.length, 4); // two segment.started headers + genesis + winner
    const rebuilt = freshDb();
    syncViews(rebuilt, entries);
    const read = resolveMemoryFact(rebuilt, FACT, { now: NOW });
    assert.equal(read.found, true);
    assert.equal(read.record?.recordRef, winnerEvent.id);
    assert.equal(listUnresolvedMemoryConflicts(rebuilt).length, 0);

    first.close();
    left.close();
    right.close();
    third.close();
  } finally {
    removeTempRoot(root);
  }
});

test('p1-integration rollback drill: manifest-verified backup, compatible recovery, branch preserved without deleting events (ADR-005 §11)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ano-memory-p1-rollback-'));
  try {
    const ledgerDir = join(root, '.ano', 'ledger');

    // Era 1 — pre-memory ledger written through the real append path.
    const legacy = await Ledger.open(root, { sessionId: 'SEGA', actor: 'legacy-writer', clock: () => 1_000 });
    const note = (await legacy.append({ kind: 'note.recorded', payload: notePayload('a'.repeat(64)) }, 'note:1')).event!;
    legacy.close();

    // §11.1 — content-hash manifest of every committed segment, verified per
    // file before any new event kind is enabled.
    const manifest = segmentManifest(ledgerDir);
    assert.ok(manifest.size >= 1);
    assert.equal(manifestVerifies(ledgerDir, manifest), true);
    const backupDir = join(root, 'backup');
    cpSync(ledgerDir, backupDir, { recursive: true });

    // A tampered copy fails verification: the drill aborts instead of writing
    // memory.* events on an unverifiable backup.
    const tamperedDir = join(root, 'tampered');
    cpSync(ledgerDir, tamperedDir, { recursive: true });
    writeFileSync(join(tamperedDir, manifest.keys().next().value!), Buffer.from('corrupted'));
    assert.equal(manifestVerifies(tamperedDir, manifest), false);

    // Era 2 — the new event vocabulary is enabled on the verified root.
    const writer = await Ledger.open(root, { sessionId: 'SEGB', actor: 'memory-writer', clock: () => 5_000 });
    const genesis = (await writer.append({ kind: 'memory.revised', payload: revisePayload() }, 'p1:genesis')).event!;
    const revise = (await writer.append({
      kind: 'memory.revised',
      payload: revisePayload({ supersedes: [genesis.id], reason: 'linear correction' }),
    }, 'p1:revise')).event!;
    writer.close();

    // The post-backup branch: exactly one new segment, byte-captured.
    const branchNames = [...segmentManifest(ledgerDir).keys()].filter((name) => !manifest.has(name));
    assert.equal(branchNames.length, 1);
    const branchName = branchNames[0]!;
    const branchPath = join(ledgerDir, branchName);
    const branchBytes = readFileSync(branchPath);
    const before = replayLedger(ledgerDir).entries;
    const hashesBefore = before.map((entry) => hashEvent(entry.event));
    const totalBefore = before.length;

    // §11.3 compatible-version boundary: the branch carries kinds outside the
    // pre-memory vocabulary, so an old binary refuses it (it does not fail
    // silently); the restored legacy segments stay inside the old vocabulary.
    const oldKinds: readonly string[] = ledgerEventKinds.filter((kind) => !kind.startsWith('memory.'));
    const branchKinds = before.filter((entry) => entry.segment === branchName).map((entry) => entry.event.kind);
    assert.ok(branchKinds.includes('memory.revised'), 'the branch carries the new vocabulary');
    assert.ok(oldKinds.includes('note.recorded') && !oldKinds.includes('memory.revised'));
    const legacyEntries = before.filter((entry) => manifest.has(entry.segment));
    assert.ok(legacyEntries.length >= 1);
    assert.ok(legacyEntries.every((entry) => oldKinds.includes(entry.event.kind)), 'legacy segments replay under the old vocabulary');
    assert.ok(legacyEntries.some((entry) => entry.event.id === note.id), 'the committed note event survives into the drill');

    // §11.4 rollback: restore the verified backup while the post-backup branch
    // segment stays in place — nothing is deleted to fake the rollback.
    for (const name of manifest.keys()) cpSync(join(backupDir, name), join(ledgerDir, name));
    assert.equal(manifestVerifies(ledgerDir, manifest), true, 'the restored backup verifies');
    assert.equal(existsSync(branchPath), true, 'the branch file is preserved for audit');
    assert.deepEqual(readFileSync(branchPath), branchBytes, 'the branch file is byte-for-byte untouched');

    // No committed event was deleted: same ids, same hashes.
    const afterReplay = replayLedger(ledgerDir);
    const after = afterReplay.entries;
    assert.equal(after.length, totalBefore);
    assert.deepEqual(after.map((entry) => hashEvent(entry.event)), hashesBefore);

    // Rolled-back era (legacy-only projection): governed facts are gone and
    // the legacy note recall still serves its original output.
    const rolledBack = freshDb();
    syncViews(rolledBack, after.filter((entry) => manifest.has(entry.segment)));
    const probeRead = resolveMemoryFact(rolledBack, FACT);
    assert.equal(probeRead.found, false);
    assert.equal(probeRead.reason, 'unknown_fact_key');
    const noteRow = readNote(rolledBack, 'a'.repeat(64));
    assert.equal(noteRow?.text, 'keep the lease');

    // Re-adoption (§11.4): a new version replays every branch into the
    // identical deterministic projection.
    const reAdopted = freshDb();
    syncViews(reAdopted, after);
    const read = resolveMemoryFact(reAdopted, FACT, { now: NOW });
    assert.equal(read.found, true);
    assert.equal(read.record?.recordRef, revise.id);
    assert.equal(readMemoryHeads(reAdopted)[0]?.headRef, revise.id);
    assert.equal(Number((reAdopted.prepare('PRAGMA user_version').get() as { user_version: number }).user_version), VIEW_SCHEMA_VERSION);
    // Every segment — restored or preserved — still carries a valid per-segment
    // hash chain (replayLedger already failed closed on any violation).
    for (const name of [...manifest.keys(), branchName]) {
      const segment = afterReplay.segments.find((item) => item.name === name);
      assert.ok(segment);
      assert.equal(eventChain(segment.events), true, name);
    }
  } finally {
    removeTempRoot(root);
  }
});

test('p1-integration mis-retirement drill: rebuild from original events, forward-correct, committed hashes unchanged (ADR-005 §12)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ano-memory-p1-correction-'));
  try {
    const ledgerDir = join(root, '.ano', 'ledger');

    // The erroring writer retires the fact (the mis-deprecation).
    const writer = await Ledger.open(root, { sessionId: 'SESW', actor: 'auto-writer', clock: () => 1_000 });
    const genesis = (await writer.append({ kind: 'memory.revised', payload: revisePayload({ reason: 'first governed version' }) }, 'p1:genesis')).event!;
    const retraction = (await writer.append({
      kind: 'memory.revised',
      payload: retractPayload([genesis.id], { reason: 'mis-classified by the automatic path' }),
    }, 'p1:retract')).event!;
    writer.close();

    // Step 1 — the automatic path is closed: no further writes happen here.
    const committed = replayLedger(ledgerDir).entries;
    const originalHashes = committed.map((entry) => hashEvent(entry.event));
    const originalBytes = onDiskBytes(ledgerDir);

    // Step 2 — views rebuilt from the original events reproduce the retracted
    // state deterministically, twice. The head pointer stays on the retracted
    // record (ADR-005 §4.1); the retraction event itself carries no record row.
    const rebuilt = freshDb();
    syncViews(rebuilt, committed);
    const before = resolveMemoryFact(rebuilt, FACT);
    assert.equal(before.found, false);
    assert.equal(before.status, 'retracted');
    assert.equal(before.headRef, genesis.id);
    assert.equal(before.record?.recordRef, genesis.id);
    const rebuiltAgain = freshDb();
    syncViews(rebuiltAgain, committed);
    assert.deepEqual(memoryDump(rebuiltAgain), memoryDump(rebuilt));

    // Step 3 — forward correction: a revise over the retracted head restores
    // the fact and cites the audited retraction in its reason.
    const fixer = await Ledger.open(root, { sessionId: 'SESF', actor: 'human-operator', clock: () => 9_000 });
    const correction = (await fixer.append({
      kind: 'memory.revised',
      payload: revisePayload({
        supersedes: [genesis.id],
        reason: 'ADR-005 §12 drill: the retirement event ' + retraction.id + ' was a mis-classification; restoring the fact over the retracted head',
      }),
    }, 'p1:correct')).event!;
    fixer.close();

    const after = replayLedger(ledgerDir).entries;
    const projected = freshDb();
    syncViews(projected, after);
    const current = resolveMemoryFact(projected, FACT, { now: NOW });
    assert.equal(current.found, true);
    assert.equal(current.record?.recordRef, correction.id);
    // The retracted record is not rewritten to superseded (ADR-005 §4.1).
    assert.equal(readMemoryRecord(projected, genesis.id)?.status, 'retracted');
    // The governed lineage stays reachable, head first; the retraction event
    // stays in the committed bytes as audit evidence without becoming a
    // record of its own.
    assert.deepEqual(readMemoryFactHistory(projected, FACT).map((record) => record.recordRef), [correction.id, genesis.id]);
    assert.equal(readMemoryRecords(projected, { factKey: FACT }).length, 2);
    assert.ok(after.some((entry) => entry.event.id === retraction.id), 'the retraction event is preserved in the ledger');

    // §9 through the real path: the historical read returns evidence marked as
    // such and never backfills the unknown interval from recorded_at.
    const historical = resolveMemoryFact(projected, FACT, { mode: 'historical', asOf: NOW });
    assert.equal(historical.found, true);
    assert.equal(historical.usage, 'historical');
    assert.equal(historical.temporalUnknown, true);

    // Original bytes and hashes are untouched: only the new segment appeared.
    const afterBytes = onDiskBytes(ledgerDir);
    for (const [name, bytes] of originalBytes) assert.equal(afterBytes.get(name), bytes, name);
    assert.equal(after.length, originalHashes.length + 2); // header + correction
    assert.deepEqual(after.slice(0, originalHashes.length).map((entry) => hashEvent(entry.event)), originalHashes);

    // §12.4 — replaying the same log stays deterministic: incremental apply
    // over the real bytes equals the full rebuild.
    const incremental = freshDb();
    for (const entry of after) applyEventToDb(incremental, entry.event, entry.segment);
    assert.deepEqual(memoryDump(incremental), memoryDump(projected));
  } finally {
    removeTempRoot(root);
  }
});
