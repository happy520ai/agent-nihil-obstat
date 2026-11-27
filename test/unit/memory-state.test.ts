import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { canonicalJson, type LedgerEvent } from '../../src/ledger/event.ts';
import { createHash } from 'node:crypto';
import {
  applyEventToDb,
  IdempotencyConflictError,
  initViews,
  LedgerIntegrityError,
  readMemoryConflicts,
  readMemoryEdges,
  readMemoryHeads,
  readMemoryRecord,
  readNote,
  VIEW_SCHEMA_VERSION,
} from '../../src/ledger/views.ts';
import {
  listMemoryAlternatives,
  listMemoryFactVersions,
  listMemoryRecords,
  listUnresolvedMemoryConflicts,
  readMemoryFactHistory,
  readMemoryRelations,
  resolveMemoryFact,
} from '../../src/memory/state.ts';

/**
 * Unit tests for the ADR-005 §9/§10 read model (src/memory/state.ts) over the
 * versioned memory projection (src/ledger/views.ts). Named scenarios follow the
 * ADR-005 §13 fixture matrix; the full integration matrix lives in
 * test/integration/memory-revision.test.ts.
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

function sha256(value: unknown): string { return createHash('sha256').update(canonicalJson(value)).digest('hex'); }

function noteEvent(fields: { noteId?: string; kind?: string; text?: string; anchor?: Record<string, unknown> } = {}, options: EventOptions = {}): LedgerEvent {
  const kind = fields.kind ?? 'decision';
  const anchor = fields.anchor === undefined && kind !== 'session_summary' ? { file: 'src/a.ts', symbolId: 'id-a' } : fields.anchor;
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

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  initViews(db);
  return db;
}

function apply(db: DatabaseSync, created: LedgerEvent): void {
  applyEventToDb(db, created, 'segment-0001');
}

function expectIntegrity(run: () => unknown, pattern?: RegExp): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof LedgerIntegrityError, `expected LedgerIntegrityError, got ${String(error)}`);
    return pattern ? pattern.test((error as Error).message) : true;
  });
}

test('legacy-unreviewed: note.recorded registers as legacy and never becomes a governed fact', () => {
  const db = freshDb();
  const note = noteEvent();
  apply(db, note);

  const legacy = readMemoryRecord(db, note.id);
  assert.ok(legacy);
  assert.equal(legacy.eligibility, 'legacy_unreviewed');
  assert.equal(legacy.factKey, null);
  assert.equal(legacy.status, 'active');
  assert.equal(legacy.noteId, 'a'.repeat(64));
  assert.equal(legacy.version, 1);
  assert.equal(legacy.contentHash, sha256({ kind: 'decision', text: 'keep the lease', anchor: { file: 'src/a.ts', symbolId: 'id-a' } }));
  // Original identity and content survive untouched in the notes view.
  const noteRow = readNote(db, 'a'.repeat(64));
  assert.ok(noteRow);
  assert.equal(noteRow.text, 'keep the lease');

  // No fact_key exists, so no fact read can return the note's content.
  const fact = resolveMemoryFact(db, FACT);
  assert.equal(fact.found, false);
  assert.equal(fact.reason, 'unknown_fact_key');
  assert.equal(readMemoryHeads(db).length, 0);

  // Eligibility filtering keeps governed queries clean.
  assert.equal(listMemoryRecords(db, { eligibility: 'governed' }).length, 0);
  assert.equal(listMemoryRecords(db, { eligibility: 'legacy_unreviewed' }).length, 1);

  // A session_summary note (no anchor) is also registered as historical material.
  const summary = noteEvent({ noteId: 'b'.repeat(64), kind: 'session_summary', text: 'summary' });
  apply(db, summary);
  assert.equal(readMemoryRecord(db, summary.id)?.eligibility, 'legacy_unreviewed');
  assert.equal(readMemoryRecord(db, summary.id)?.anchor, undefined);
});

test('temporal-unknown: explicit null intervals return with temporal_unknown and no backfill', () => {
  const db = freshDb();
  const genesis = revisedEvent();
  apply(db, genesis);

  const read = resolveMemoryFact(db, FACT, { now: NOW });
  assert.equal(read.found, true);
  assert.equal(read.usage, 'current');
  assert.equal(read.temporalUnknown, true);
  assert.ok(read.record);
  // ADR-005 §9: unknown intervals stay unknown; recorded_at (from HLC) never fills them.
  assert.equal(read.record.effectiveFrom, null);
  assert.equal(read.record.effectiveTo, null);
  assert.equal(read.record.recordedAt, new Date(BASE).toISOString());
});

test('current mode reports effective windows instead of pretending coverage', () => {
  const db = freshDb();
  const notYet = revisedEvent({ fact_key: 'fact.notyet', effective_from: FUTURE, effective_to: null });
  apply(db, notYet);
  const read = resolveMemoryFact(db, 'fact.notyet', { now: NOW });
  assert.equal(read.found, false);
  assert.equal(read.reason, 'not_yet_effective');
  assert.equal(read.status, 'active');
  assert.equal(read.record?.recordRef, notYet.id);

  const expired = revisedEvent({ fact_key: 'fact.expired', effective_from: PAST, effective_to: MID });
  apply(db, expired);
  assert.equal(resolveMemoryFact(db, 'fact.expired', { now: NOW }).reason, 'effective_to_passed');

  const covering = revisedEvent({ fact_key: 'fact.covering', effective_from: PAST, effective_to: FUTURE });
  apply(db, covering);
  const ok = resolveMemoryFact(db, 'fact.covering', { now: NOW });
  assert.equal(ok.found, true);
  assert.equal(ok.temporalUnknown, false);
  assert.equal(ok.record?.recordRef, covering.id);
});

test('current mode never falls back to a superseded record', () => {
  const db = freshDb();
  const v1 = revisedEvent({ effective_from: PAST, effective_to: FUTURE });
  apply(db, v1);
  const v2 = revisedEvent({ supersedes: [v1.id], effective_from: FUTURE, effective_to: null });
  apply(db, v2);
  // v1's interval still covers "now", but it is superseded; the head is not yet
  // effective. The read reports the head with a reason — never v1 as current.
  const read = resolveMemoryFact(db, FACT, { now: NOW });
  assert.equal(read.found, false);
  assert.equal(read.reason, 'not_yet_effective');
  assert.equal(read.record?.recordRef, v2.id);
});

test('historical mode selects the lineage version covering as_of and marks usage', () => {
  const db = freshDb();
  const v1 = revisedEvent({ effective_from: PAST, effective_to: MID });
  apply(db, v1);
  const v2 = revisedEvent({ supersedes: [v1.id], effective_from: MID, effective_to: FUTURE });
  apply(db, v2);

  const early = resolveMemoryFact(db, FACT, { mode: 'historical', asOf: '2026-03-01T00:00:00.000Z' });
  assert.equal(early.found, true);
  assert.equal(early.usage, 'historical');
  assert.equal(early.record?.recordRef, v1.id);

  const later = resolveMemoryFact(db, FACT, { mode: 'historical', asOf: '2026-09-01T00:00:00.000Z' });
  assert.equal(later.record?.recordRef, v2.id);
  assert.equal(later.usage, 'historical');

  const outside = resolveMemoryFact(db, FACT, { mode: 'historical', asOf: '2028-01-01T00:00:00.000Z' });
  assert.equal(outside.found, false);
  assert.equal(outside.reason, 'no_version_covers_as_of');

  // Unknown interval in the lineage returns with temporal_unknown.
  const v3 = revisedEvent({ supersedes: [v2.id], effective_from: null, effective_to: null });
  apply(db, v3);
  const unknown = resolveMemoryFact(db, FACT, { mode: 'historical', asOf: '2026-09-01T00:00:00.000Z' });
  assert.equal(unknown.record?.recordRef, v3.id);
  assert.equal(unknown.temporalUnknown, true);

  assert.throws(() => resolveMemoryFact(db, FACT, { mode: 'historical' }), /requires asOf/);
});

test('retraction reports fact_retracted and forward correction re-enters as a new active head', () => {
  const db = freshDb();
  const v1 = revisedEvent({ fact_key: 'fact.retracted' });
  apply(db, v1);
  const retract = retractEvent('fact.retracted', v1.id);
  apply(db, retract);

  const read = resolveMemoryFact(db, 'fact.retracted');
  assert.equal(read.found, false);
  assert.equal(read.status, 'retracted');
  assert.equal(read.reason, 'fact_retracted');
  assert.equal(read.headRef, v1.id);
  assert.equal(read.record?.status, 'retracted');
  // Distinct from "no such fact".
  assert.equal(resolveMemoryFact(db, 'other.fact').reason, 'unknown_fact_key');

  // A retracted head cannot be retracted again.
  expectIntegrity(() => apply(db, retractEvent('fact.retracted', v1.id, {}, { idem: 'idem:r-again' })), /on a retracted head/);

  // ADR-005 §4.1: forward correction revises from the retracted head.
  const v2 = revisedEvent({ fact_key: 'fact.retracted', supersedes: [v1.id], reason: 'corrected' });
  apply(db, v2);
  const corrected = resolveMemoryFact(db, 'fact.retracted', { now: NOW });
  assert.equal(corrected.found, true);
  assert.equal(corrected.record?.recordRef, v2.id);
  assert.deepEqual(listMemoryAlternatives(db, 'fact.retracted').map((record) => record.recordRef), [v1.id]);
});

test('forks project as unresolved conflicts and only adjudication resolves them', () => {
  const db = freshDb();
  const v1 = revisedEvent({ fact_key: 'fact.forked' });
  apply(db, v1);
  const v2 = revisedEvent({ fact_key: 'fact.forked', supersedes: [v1.id] });
  apply(db, v2);
  const v3 = revisedEvent({ fact_key: 'fact.forked', supersedes: [v1.id] });
  apply(db, v3);

  const conflicted = resolveMemoryFact(db, 'fact.forked');
  assert.equal(conflicted.found, false);
  assert.equal(conflicted.status, 'conflicted');
  assert.equal(conflicted.reason, 'unresolved_conflict');
  assert.deepEqual(conflicted.branches, [v2.id, v3.id]);
  assert.deepEqual(listUnresolvedMemoryConflicts(db).map((conflict) => conflict.factKey), ['fact.forked']);

  // winner outcome: the winning branch survives and the others are superseded.
  const winner = adjudicationEvent('fact.forked', [v2.id, v3.id], { type: 'winner', winner_ref: v3.id });
  apply(db, winner);
  const resolved = resolveMemoryFact(db, 'fact.forked', { now: NOW });
  assert.equal(resolved.found, true);
  assert.equal(resolved.record?.recordRef, v3.id);
  assert.equal(resolved.record?.version, 2);
  assert.equal(readMemoryRecord(db, v2.id)?.status, 'superseded');
  assert.equal(readMemoryRecord(db, v2.id)?.supersededBy, v3.id);
  assert.equal(readMemoryConflicts(db).length, 0);
});

test('adjudication record outcome creates a governed head above the branch depth', () => {
  const db = freshDb();
  const v1 = revisedEvent({ fact_key: 'fact.forked3' });
  apply(db, v1);
  const b1 = revisedEvent({ fact_key: 'fact.forked3', supersedes: [v1.id] });
  apply(db, b1);
  const b2 = revisedEvent({ fact_key: 'fact.forked3', supersedes: [v1.id] });
  apply(db, b2);
  const record = adjudicationEvent('fact.forked3', [b1.id, b2.id], {
    type: 'record',
    record: { text: 'adjudicated version', kind: 'decision' },
    effective_from: null,
    effective_to: null,
  });
  apply(db, record);
  const read = resolveMemoryFact(db, 'fact.forked3', { now: NOW });
  assert.equal(read.found, true);
  assert.equal(read.record?.recordRef, record.id);
  assert.equal(read.record?.version, 3); // max(branch depth 2) + 1
  assert.equal(read.record?.eligibility, 'governed');
  assert.equal(readMemoryRecord(db, b1.id)?.supersededBy, record.id);

  // retract_all outcome: all branches retracted, head vacated, fact marked retracted.
  const vA = revisedEvent({ fact_key: 'fact.forked4' });
  apply(db, vA);
  const c1 = revisedEvent({ fact_key: 'fact.forked4', supersedes: [vA.id] });
  apply(db, c1);
  const c2 = revisedEvent({ fact_key: 'fact.forked4', supersedes: [vA.id] });
  apply(db, c2);
  apply(db, adjudicationEvent('fact.forked4', [c1.id, c2.id], { type: 'retract_all' }));
  const retracted = resolveMemoryFact(db, 'fact.forked4');
  assert.equal(retracted.status, 'retracted');
  assert.equal(retracted.headRef, null);
  assert.equal(retracted.reason, 'fact_retracted');
  assert.equal(readMemoryRecord(db, c1.id)?.status, 'retracted');
  assert.equal(readMemoryRecord(db, c2.id)?.status, 'retracted');
});

test('history and alternatives expose the versioned lineage in deterministic order', () => {
  const db = freshDb();
  const v1 = revisedEvent();
  apply(db, v1);
  const v2 = revisedEvent({ supersedes: [v1.id] });
  apply(db, v2);
  const v3 = revisedEvent({ supersedes: [v2.id] });
  apply(db, v3);

  const history = readMemoryFactHistory(db, FACT);
  assert.deepEqual(history.map((record) => record.recordRef), [v3.id, v2.id, v1.id]);
  assert.deepEqual(history.map((record) => record.version), [3, 2, 1]);
  assert.deepEqual(listMemoryFactVersions(db, FACT).map((record) => record.recordRef), [v1.id, v2.id, v3.id]);
  assert.deepEqual(listMemoryAlternatives(db, FACT).map((record) => record.recordRef), [v1.id, v2.id]);
  // Legacy ancestors stop the walk: they are never presented as governed facts.
  const note = noteEvent({ noteId: 'c'.repeat(64), text: 'origin' });
  apply(db, note);
  const entry = revisedEvent({ fact_key: 'fact.fromnote', supersedes: [note.id] });
  apply(db, entry);
  assert.deepEqual(readMemoryFactHistory(db, 'fact.fromnote').map((record) => record.recordRef), [entry.id]);
});

test('relations are readable from both endpoints and never change fact state', () => {
  const db = freshDb();
  const r1 = revisedEvent({ fact_key: 'fact.one' });
  apply(db, r1);
  const r2 = revisedEvent({ fact_key: 'fact.two' });
  apply(db, r2);
  const note = noteEvent({ noteId: 'd'.repeat(64) });
  apply(db, note);
  apply(db, relatedEvent(r1.id, r2.id, { edge: 'depends_on' }, { idem: 'idem:e1' }));
  apply(db, relatedEvent(note.id, r1.id, { edge: 'explains' }, { idem: 'idem:e2' }));

  const relations = readMemoryRelations(db, r1.id);
  assert.deepEqual(relations.outgoing.map((edge) => edge.edge), ['depends_on']);
  assert.deepEqual(relations.incoming.map((edge) => edge.edge), ['explains']);
  assert.equal(readMemoryEdges(db, note.id).length, 1);
  // Edges do not change any fact's effective state.
  assert.equal(resolveMemoryFact(db, 'fact.one', { now: NOW }).found, true);
  assert.equal(resolveMemoryFact(db, 'fact.two', { now: NOW }).found, true);
});

test('cross-project record refs are structurally unresolvable in this ledger', () => {
  const projectA = freshDb();
  const foreign = revisedEvent({ fact_key: 'project.a.fact' });
  apply(projectA, foreign);

  const projectB = freshDb();
  expectIntegrity(() => apply(projectB, revisedEvent({ fact_key: FACT, supersedes: [foreign.id] })), /unresolvable ref/);
  expectIntegrity(() => apply(projectB, relatedEvent(foreign.id, foreign.id, { edge: 'related_to' }, { idem: 'idem:iso1' })), /self-loop/);
  const local = revisedEvent({ fact_key: FACT });
  apply(projectB, local);
  expectIntegrity(() => apply(projectB, relatedEvent(local.id, foreign.id, { edge: 'related_to' }, { idem: 'idem:iso2' })), /to_ref .* unresolvable/);
});

test('view schema version rebuilds and fails closed on projection violations', () => {
  // A v4-era cache has no memory tables; initViews creates them and the version
  // bump forces the full replay that empties every cache table.
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA user_version = 4');
  initViews(db);
  const version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  assert.equal(version, VIEW_SCHEMA_VERSION);
  // ADR-010 §3.3 bumped the views schema to 6 for structure_queries/explored_files.
  assert.equal(version, 6);
  for (const table of ['memory_records', 'memory_heads', 'memory_edges', 'memory_conflicts']) {
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, 0, table);
  }

  // A memory event without an idem_key is refused even in committed history.
  const db2 = freshDb();
  const noIdem = revisedEvent();
  delete (noIdem as { idem_key?: string }).idem_key;
  expectIntegrity(() => apply(db2, noIdem), /requires an idem_key/);

  // Genesis over an existing fact_key fails closed.
  const db3 = freshDb();
  const first = revisedEvent();
  apply(db3, first);
  expectIntegrity(() => apply(db3, revisedEvent({ record: { text: 'second genesis', kind: 'memory' } }, { idem: 'idem:genesis2' })), /genesis for non-empty fact_key/);
});

test('idempotency at the projection layer: same parameters duplicate, different ones conflict', () => {
  const db = freshDb();
  const first = revisedEvent();
  apply(db, first);
  const result = applyEventToDb(db, first, 'segment-0001');
  assert.equal(result.duplicate, true);
  assert.equal(result.applied, false);

  // Same idem_key, same canonical parameters, fresh event id -> duplicate.
  const retry = event('memory.revised', structuredClone(first.payload), { id: ulid(), idem: first.idem_key! });
  const retryResult = applyEventToDb(db, retry, 'segment-0001');
  assert.equal(retryResult.duplicate, true);

  // Same idem_key, different parameters -> conflict, zero extra events.
  const conflicting = revisedEvent({ reason: 'changed my mind' }, { idem: first.idem_key! });
  assert.throws(() => applyEventToDb(db, conflicting, 'segment-0001'), (error: unknown) => {
    assert.ok(error instanceof IdempotencyConflictError);
    return true;
  });
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM memory_records').get() as { n: number }).n, 1);
});
