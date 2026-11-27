import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { canonicalJson, genesisHash, hashEvent, type LedgerEvent } from '../../src/ledger/event.ts';
import { encodeEvents } from '../../src/ledger/segment.ts';
import { replayLedger } from '../../src/ledger/replay.ts';
import { IdempotencyConflictError, Ledger, MemoryPreconditionError } from '../../src/ledger/ledger.ts';
import { sha256 } from '../../src/memory/anchor.ts';
import { ANCHOR_PROBE_REQUEST_SCHEMA_VERSION } from '../../src/memory/probe-contract.ts';
import { validateMemoryNote, toLedgerNotePayload } from '../../src/memory/note.ts';
import { createAuthorization, createPolicy } from '../../src/connect/takeover-policy.ts';
import { savePolicy } from '../../src/connect/takeover-store.ts';
import {
  memoryFactSurface,
  memoryProbeSurface,
  noteRelateSurface,
  noteReviseSurface,
  noteSurface,
  recallSurface,
  type MemoryRelateSurfaceInput,
  type MemoryReviseSurfaceInput,
  type NoteSurfaceInput,
  type RecallSurfaceInput,
} from '../../src/surface/memory.ts';
import { brief, explore, memoryFact, memoryProbe, noteRelate, noteRevise, rebuildGraph } from '../../src/surface/service.ts';

interface BriefResolution {
  status: string;
  level: number;
  reason?: string;
  file: string | null;
}

interface BriefKnowledge {
  relevant: Array<{ id: string; resolution: BriefResolution | null }>;
  stale: Array<{ id: string; resolution: BriefResolution | null }>;
}

function briefKnowledge(summary: Record<string, unknown>): BriefKnowledge {
  return (summary.memory as { knowledge: BriefKnowledge }).knowledge;
}

function git(root: string, args: string[]): void {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
}

async function gitProject(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ano-surface-memory-unit-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await writeFile(join(root, '.gitignore'), '.ano/\n');
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await mkdir(join(root, 'src', 'auth'), { recursive: true });
  await writeFile(join(root, 'src', 'auth', 'session.ts'), 'export function refreshToken() { return 1; }\n');
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'ano@localhost'], ['config', 'user.name', 'ano'], ['add', '.'], ['commit', '-qm', 'base']]) git(root, args);
  return root;
}

const decision: NoteSurfaceInput = {
  idem_key: 'surface-note:decision',
  kind: 'decision',
  text: 'refreshToken must be renewed under a lease',
  anchor: { file: 'src/auth/session.ts', symbol_id: 'symbol-refresh', qualified_name: 'refreshToken' },
};

test('noteSurface appends once per idem_key and verifies the ledger copy', async (t) => {
  const root = await gitProject(t);
  const ledger = await Ledger.open(root);
  try {
    const first = await noteSurface(ledger, decision);
    assert.equal(first.duplicate, false);
    assert.equal(first.status, 'recorded');
    assert.match(first.note.id, /^[a-f0-9]{64}$/u);
    assert.equal(first.get(first.note.id)?.text, decision.text);
    assert.deepEqual(first.recorded.map((note) => note.id), [first.note.id]);
    assert.doesNotMatch(JSON.stringify(first), /"notes":\{\}/u, 'the book journal must not leak into the serialized result');

    const stored = ledger.getNote(first.note.id);
    assert.equal(stored?.kind, 'decision');
    assert.equal(stored?.createdAt, first.note.createdAt);
    assert.deepEqual(stored?.anchor, { file: 'src/auth/session.ts', symbolId: 'symbol-refresh', qualifiedName: 'refreshToken' });
    assert.equal(ledger.listNotes().length, 1);

    const retried = await noteSurface(ledger, decision);
    assert.equal(retried.duplicate, true);
    assert.equal(retried.status, 'duplicate');
    assert.equal(retried.note.createdAt, first.note.createdAt);
    assert.equal(ledger.listNotes().length, 1);

    const otherKey = await noteSurface(ledger, { ...decision, idem_key: 'surface-note:decision-2' });
    assert.equal(otherKey.duplicate, true, 'the same content-derived note is already present');
    assert.equal(otherKey.note.id, first.note.id);
    assert.equal(ledger.listNotes().length, 1);

    const summary = await noteSurface(ledger, { idem_key: 'surface-note:summary', kind: 'session_summary', text: 'Session closed with a green ledger' });
    assert.equal(summary.duplicate, false);
    assert.equal(summary.note.anchor, undefined);
    assert.equal(ledger.getNote(summary.note.id)?.kind, 'session_summary');
    assert.equal(ledger.listNotes().length, 2);
  } finally {
    ledger.close();
  }
});

test('noteSurface rejects invalid keys, anchors and conflicting idem_key reuse', async (t) => {
  const root = await gitProject(t);
  const ledger = await Ledger.open(root);
  try {
    await assert.rejects(noteSurface(ledger, { idem_key: 'bad-1', kind: 'decision', text: 'missing anchor' }), /requires an anchor/);
    await assert.rejects(
      noteSurface(ledger, { idem_key: 'bad-2', kind: 'session_summary', text: 'summary', anchor: { file: 'src/auth/session.ts' } }),
      /must not carry an anchor/,
    );
    await assert.rejects(noteSurface(ledger, { idem_key: '', kind: 'memory', text: 'x', anchor: { file: 'src/auth/session.ts' } }), /idem_key/);
    await assert.rejects(noteSurface(ledger, { ...decision, idem_key: 'bad-3', anchor: { file: 'C:/auth/session.ts' } }), /project-relative/);
    await assert.rejects(noteSurface(ledger, { ...decision, idem_key: 'bad-4', anchor: { file: 'src/auth/session.ts', content_fragment_hash: 'not-a-hash' } }), /SHA-256/);
    await assert.rejects(
      noteSurface(ledger, { ...decision, idem_key: 'bad-5', anchor: { file: 'src/auth/session.ts', content_fragment: 'linked' } } as unknown as NoteSurfaceInput),
      /does not accept field/,
    );
    await assert.rejects(
      noteSurface(ledger, { ...decision, idem_key: 'bad-6', createdAt: '2026-11-19T00:00:00.000Z' } as unknown as NoteSurfaceInput),
      /does not accept field/,
    );

    await noteSurface(ledger, decision);
    await assert.rejects(noteSurface(ledger, { ...decision, text: 'different decision' }), /different parameters|Idempotency/);
    assert.equal(ledger.listNotes().length, 1);
  } finally {
    ledger.close();
  }
});

test('noteSurface never reports success when the ledger holds a mismatched note', async (t) => {
  const root = await gitProject(t);
  const ledger = await Ledger.open(root);
  try {
    const expected = validateMemoryNote({
      kind: 'decision',
      text: 'the honest note',
      anchor: { file: 'src/auth/session.ts', symbolId: 'symbol-refresh' },
    }, '2026-11-19T00:00:00.000Z');
    await ledger.append({
      kind: 'note.recorded',
      payload: {
        note_id: expected.id,
        kind: 'decision',
        text: 'a forged note under the honest id',
        created_at: '2026-11-19T00:00:00.000Z',
        anchor: { file: 'src/auth/session.ts', symbolId: 'symbol-refresh' },
      },
    }, 'forged-note-key');

    await assert.rejects(
      noteSurface(ledger, { idem_key: 'honest-key', kind: 'decision', text: 'the honest note', anchor: { file: 'src/auth/session.ts', symbol_id: 'symbol-refresh' } }),
      /does not match the validated note/,
    );
  } finally {
    ledger.close();
  }
});

test('recallSurface reports not_configured without opening history.db', async (t) => {
  const root = await gitProject(t);
  const missing = await recallSurface(root, {});
  assert.equal(missing.status, 'not_configured');
  assert.equal(missing.untrusted, true);
  assert.equal(missing.summary.configured, false);
  assert.equal(missing.summary.mode, 'none');
  assert.equal(missing.summary.total, 0);
  assert.deepEqual(missing.hits, []);
  assert.equal(missing.provenance.kind, 'ano-memory-recall');
  assert.equal(missing.provenance.historyDb, '.ano/cache/history.db');
  assert.equal(missing.provenance.syntheticRoot, '.ano/memory/synthetic');
  assert.deepEqual(missing.provenance.providers, []);
  assert.ok(missing.degraded.includes('not-configured:synthetic-root-missing'));
  assert.equal(existsSync(join(root, '.ano', 'cache', 'history.db')), false);

  await mkdir(join(root, '.ano', 'memory', 'synthetic'), { recursive: true });
  const empty = await recallSurface(root, {});
  assert.equal(empty.status, 'not_configured');
  assert.ok(empty.degraded.includes('not-configured:no-provider-directories'));
  assert.equal(existsSync(join(root, '.ano', 'cache', 'history.db')), false);
});

test('recallSurface accepts only the tool schema fields and validates values before any scan', async (t) => {
  const root = await gitProject(t);
  await assert.rejects(recallSurface(root, { visibility: 'all' } as unknown as RecallSurfaceInput), /does not accept field/);
  await assert.rejects(recallSurface(root, { script: 'process.exit(1)' } as unknown as RecallSurfaceInput), /does not accept field/);
  await assert.rejects(recallSurface(root, { session: '' } as unknown as RecallSurfaceInput), /non-empty string/);
  await assert.rejects(recallSurface(root, { from: 'not-a-timestamp' } as unknown as RecallSurfaceInput), /ISO timestamp/);
  await assert.rejects(recallSurface(root, { from: '2026-11-02T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z' }), /must not be after/);
});

test('brief resolves note anchors through the real graph symbol table', async (t) => {
  const root = await gitProject(t);
  await rebuildGraph(root);
  const matched = await explore(root, 'refreshToken', 10);
  const symbol = (matched.symbols as Array<{ id: string; file: string; qualifiedName: string }>)[0];
  assert.ok(symbol, 'the fixture symbol is present in the graph');

  const ledger = await Ledger.open(root);
  let noteId: string;
  try {
    const recorded = await noteSurface(ledger, {
      idem_key: 'brief-symbol-anchor',
      kind: 'memory',
      text: 'refreshToken anchor resolves through the graph',
      anchor: { file: symbol.file, symbol_id: symbol.id, qualified_name: symbol.qualifiedName },
    });
    noteId = recorded.note.id;
  } finally { ledger.close(); }

  const fresh = await brief(root);
  assert.equal((fresh.graph as { freshness: { status: string } }).freshness.status, 'fresh');
  const knowledge = briefKnowledge(fresh);
  const hit = knowledge.relevant.find((entry) => entry.id === noteId);
  assert.ok(hit, 'the anchored note is relevant');
  assert.equal(hit?.resolution?.status, 'exact', 'the graph symbol id resolves at level 1');
  assert.equal(hit?.resolution?.level, 1);
});

test('brief demotes symbol anchors on a stale graph but keeps current content evidence', async (t) => {
  const root = await gitProject(t);
  await rebuildGraph(root);
  const matched = await explore(root, 'refreshToken', 10);
  const symbol = (matched.symbols as Array<{ id: string; file: string; qualifiedName: string }>)[0];
  assert.ok(symbol, 'the fixture symbol is present in the graph');

  const ledger = await Ledger.open(root);
  let symbolNoteId: string;
  let fragmentNoteId: string;
  try {
    const symbolNote = await noteSurface(ledger, {
      idem_key: 'brief-stale-symbol',
      kind: 'memory',
      text: 'symbol anchor demoted by a stale graph',
      anchor: { file: symbol.file, symbol_id: symbol.id, qualified_name: symbol.qualifiedName },
    });
    symbolNoteId = symbolNote.note.id;
    const fragmentNote = validateMemoryNote({
      kind: 'memory',
      text: 'content fragment read from the current file',
      anchor: { file: symbol.file, symbolId: symbol.id, contentFragment: 'export function refreshToken()' },
    }, '2026-11-19T00:00:00.000Z');
    fragmentNoteId = fragmentNote.id;
    await ledger.append({ kind: 'note.recorded', payload: toLedgerNotePayload(fragmentNote) }, 'brief-fragment-anchor');
  } finally { ledger.close(); }

  // Mutate the source without rebuilding: the persisted graph is now stale.
  await writeFile(join(root, 'src', 'auth', 'session.ts'), 'export function refreshToken() { return 2; }\n// touched after the graph build\n');

  const stale = await brief(root);
  assert.equal((stale.graph as { freshness: { status: string } }).freshness.status, 'stale');
  const knowledge = briefKnowledge(stale);

  const symbolEntry = knowledge.stale.find((entry) => entry.id === symbolNoteId);
  assert.ok(symbolEntry, 'the symbol-table anchor is not reported as fresh');
  assert.equal(symbolEntry?.resolution?.status, 'stale');
  assert.equal(symbolEntry?.resolution?.reason, 'stale-symbol-table');

  const fragmentEntry = knowledge.relevant.find((entry) => entry.id === fragmentNoteId);
  assert.ok(fragmentEntry, 'the content fragment still resolves from the current file');
  assert.equal(fragmentEntry?.resolution?.status, 'relocated');
  assert.equal(fragmentEntry?.resolution?.level, 3);
  assert.equal(fragmentEntry?.resolution?.reason, 'fragment-match');
});

// ============================================================================
// ADR-005 P1 surface wiring: explicit revise/relate, the governed fact read
// path and the Probe integration. The legacy note branch above keeps its own
// semantics; these tests never change its expectations.
// ============================================================================

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let ulidCounter = 0;
function testUlid(): string {
  ulidCounter += 1;
  let encoded = '';
  let value = ulidCounter;
  do {
    encoded = ULID_ALPHABET[value % 32] + encoded;
    value = Math.floor(value / 32);
  } while (value > 0);
  return `01J${encoded}`.padEnd(26, '0');
}

/** Syntactically valid ULID that names no committed event in these fixtures. */
const UNKNOWN_REF = `01J${'0'.repeat(23)}`;

function reviseInput(overrides: Partial<MemoryReviseSurfaceInput> = {}): MemoryReviseSurfaceInput {
  return {
    idem_key: 'revise:genesis',
    fact_key: 'probe.storage.engine',
    kind: 'decision',
    text: 'storage engine is sqlite',
    anchor: { file: 'src/auth/session.ts', symbol_id: 'symbol-refresh' },
    supersedes: [],
    reason: 'first version',
    effective_from: null,
    effective_to: null,
    ...overrides,
  };
}

function relateInput(overrides: Partial<MemoryRelateSurfaceInput> = {}): MemoryRelateSurfaceInput {
  return {
    idem_key: 'relate:edge',
    edge: 'depends_on',
    from_ref: UNKNOWN_REF,
    to_ref: UNKNOWN_REF,
    ...overrides,
  };
}

function probeRequest(root: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: ANCHOR_PROBE_REQUEST_SCHEMA_VERSION,
    request_id: 'req-surface-memory',
    root,
    project_scope: 'surface-memory-test',
    ...overrides,
  };
}

function committedEventIds(root: string): string[] {
  return replayLedger(join(root, '.ano', 'ledger')).entries.map((entry) => entry.event.id);
}

test('noteReviseSurface commits the genesis version once and reads it back', async (t) => {
  const root = await gitProject(t);
  const ledger = await Ledger.open(root);
  try {
    const first = await noteReviseSurface(ledger, reviseInput());
    assert.equal(first.status, 'recorded');
    assert.equal(first.duplicate, false);
    assert.match(first.eventId, /^[0-9A-HJKMNP-TV-Z]{26}$/u);
    assert.equal(first.record.recordRef, first.eventId);
    assert.equal(first.record.status, 'active');
    assert.equal(first.record.version, 1);
    assert.equal(first.record.eligibility, 'governed');
    assert.equal(first.record.contentHash, sha256(canonicalJson({
      kind: 'decision',
      text: 'storage engine is sqlite',
      anchor: { file: 'src/auth/session.ts', symbolId: 'symbol-refresh' },
    })));
    assert.equal(first.fact.found, true);
    assert.equal(first.fact.usage, 'current');
    assert.equal(first.fact.headRef, first.eventId);
    assert.equal(first.fact.temporalUnknown, true, 'unknown effective bounds are marked, never backfilled');
    assert.equal(ledger.listNotes().length, 0, 'the legacy note branch stays untouched');

    const retried = await noteReviseSurface(ledger, reviseInput());
    assert.equal(retried.status, 'duplicate');
    assert.equal(retried.duplicate, true);
    assert.equal(retried.eventId, first.eventId);
    assert.equal(retried.record.status, 'active');
    const versions = (await memoryFactSurface(ledger, { fact_key: 'probe.storage.engine' })).versions;
    assert.equal(versions.length, 1, 'a retried revision commits nothing new');

    // A different key is a different business revision: genesis needs an
    // unused fact_key, so the second attempt is rejected with zero writes.
    const eventsBeforeReject = committedEventIds(root);
    await assert.rejects(noteReviseSurface(ledger, reviseInput({ idem_key: 'revise:other' })), MemoryPreconditionError);
    assert.equal(committedEventIds(root).length, eventsBeforeReject.length, 'a precondition rejection leaves zero ledger rows');
  } finally {
    ledger.close();
  }
});

test('noteReviseSurface moves the head on a linear revision and keeps prior events intact', async (t) => {
  const root = await gitProject(t);
  const ledger = await Ledger.open(root);
  try {
    const v1 = await noteReviseSurface(ledger, reviseInput());
    const before = committedEventIds(root);
    const v2 = await noteReviseSurface(ledger, reviseInput({
      idem_key: 'revise:v2',
      text: 'storage engine is the views projection',
      supersedes: [v1.eventId],
      reason: 'clarify the storage engine',
    }));
    assert.equal(v2.record.version, 2);
    assert.equal(v2.record.status, 'active');
    assert.equal(v2.record.supersedesRef, v1.eventId);
    assert.equal(v2.fact.headRef, v2.eventId);

    assert.deepEqual(committedEventIds(root).slice(0, before.length), before, 'prior event ids are untouched');
    const versions = (await memoryFactSurface(ledger, { fact_key: 'probe.storage.engine' })).versions;
    assert.deepEqual(versions.map((record) => record.recordRef), [v1.eventId, v2.eventId]);
    assert.equal(versions[0]?.status, 'superseded');
    assert.equal(versions[0]?.supersededBy, v2.eventId);

    await assert.rejects(
      noteReviseSurface(ledger, reviseInput({ idem_key: 'revise:stale', text: 'stale revision', supersedes: [v1.eventId], reason: 'late' })),
      MemoryPreconditionError,
      'a stale prior is rejected, never reordered',
    );
    assert.equal((await memoryFactSurface(ledger, { fact_key: 'probe.storage.engine' })).fact.headRef, v2.eventId);
    assert.equal(committedEventIds(root).length, before.length + 1);
  } finally {
    ledger.close();
  }
});

test('noteReviseSurface validates inputs and leaves zero rows on rejection', async (t) => {
  const root = await gitProject(t);
  const ledger = await Ledger.open(root);
  try {
    await noteReviseSurface(ledger, reviseInput());
    const before = committedEventIds(root).length;
    await assert.rejects(noteReviseSurface(ledger, reviseInput({ idem_key: 'bad:1', supersedes: [UNKNOWN_REF] })), /unknown record/);
    await assert.rejects(noteReviseSurface(ledger, reviseInput({ idem_key: 'bad:2', fact_key: 'BAD KEY' })), /fact_key/);
    await assert.rejects(noteReviseSurface(ledger, reviseInput({ idem_key: 'bad:3', reason: '' })), /reason/);
    await assert.rejects(
      noteReviseSurface(ledger, { ...reviseInput({ idem_key: 'bad:4' }), supersedes: undefined } as unknown as MemoryReviseSurfaceInput),
      /supersedes/,
      'the prior-version declaration must be present, even for genesis',
    );
    await assert.rejects(
      noteReviseSurface(ledger, { ...reviseInput({ idem_key: 'bad:5' }), effective_from: undefined } as unknown as MemoryReviseSurfaceInput),
      /effective_from/,
    );
    await assert.rejects(
      noteReviseSurface(ledger, { ...reviseInput({ idem_key: 'bad:6' }), kind: 'session_summary', anchor: undefined } as unknown as MemoryReviseSurfaceInput),
      /Unknown fact record kind/,
    );
    await assert.rejects(
      noteReviseSurface(ledger, { ...reviseInput({ idem_key: 'bad:7' }), not_a_field: 1 } as unknown as MemoryReviseSurfaceInput),
      /does not accept field/,
    );
    await assert.rejects(
      noteReviseSurface(ledger, reviseInput({ effective_from: '2026-12-01T00:00:00.000Z', effective_to: '2026-01-01T00:00:00.000Z' })),
      /effective_from must not be after/,
    );
    await assert.rejects(
      noteReviseSurface(ledger, reviseInput({ text: 'a different revision under the same key' })),
      IdempotencyConflictError,
    );
    assert.equal(committedEventIds(root).length, before, 'every rejection above left zero ledger rows');
    const read = await memoryFactSurface(ledger, { fact_key: 'probe.storage.engine' });
    assert.equal(read.fact.headRef, read.versions[0]?.recordRef, 'no pseudo current fact was left behind');
  } finally {
    ledger.close();
  }
});

test('noteReviseSurface governs a legacy note through its event id without touching the note branch', async (t) => {
  const root = await gitProject(t);
  const ledger = await Ledger.open(root);
  try {
    const note = await noteSurface(ledger, decision);
    const noteEventId = note.eventId;
    assert.ok(noteEventId);
    const notesBefore = ledger.listNotes();

    const governed = await noteReviseSurface(ledger, reviseInput({
      idem_key: 'revise:govern-note',
      fact_key: 'lease.refresh.rule',
      text: 'refreshToken must be renewed under a lease',
      supersedes: [noteEventId],
      reason: 'promote the reviewed note into a governed fact',
    }));
    assert.equal(governed.record.version, 1, 'the governed fact starts its own version line');
    assert.equal(governed.record.status, 'active');
    assert.equal(governed.fact.found, true);

    // The note branch output is byte-identical: same rows, same read shape.
    assert.deepEqual(ledger.listNotes(), notesBefore);
    const stored = ledger.getNote(note.note.id);
    assert.equal(stored?.kind, decision.kind);
    assert.equal(stored?.text, decision.text);
    assert.equal(stored?.createdAt, note.note.createdAt);

    const { fact, versions } = await memoryFactSurface(ledger, { fact_key: 'lease.refresh.rule' });
    assert.equal(fact.found, true);
    assert.equal(fact.headRef, governed.eventId);
    // The prior read-back proves the legacy record was only marked, never rewritten.
    assert.equal(governed.prior?.noteId, note.note.id);
    assert.equal(governed.prior?.eligibility, 'legacy_unreviewed');
    assert.equal(governed.prior?.status, 'superseded');
    assert.equal(governed.prior?.supersededBy, governed.eventId);
    assert.equal(versions.length, 1, 'only the governed record carries the fact_key; the legacy record stays fact-less');

    // Governing the same note into a second fact slot is rejected (one shot).
    await assert.rejects(
      noteReviseSurface(ledger, reviseInput({
        idem_key: 'revise:govern-note-2',
        fact_key: 'lease.refresh.rule.two',
        text: 'second governance',
        supersedes: [noteEventId],
        reason: 'one-shot governance',
      })),
      /already been governed/,
    );

    // Legacy notes never surface as probe evidence for a fact slot.
    const noteProbe = memoryProbeSurface(ledger, probeRequest(root, { required_facts: [] }), { now: '2026-11-21T00:00:00.000Z' });
    assert.equal(noteProbe.active_evidence.length, 0);
  } finally {
    ledger.close();
  }
});

test('noteRelateSurface registers a typed relation once and never changes fact state', async (t) => {
  const root = await gitProject(t);
  const ledger = await Ledger.open(root);
  try {
    const a = await noteReviseSurface(ledger, reviseInput({ fact_key: 'relate.fact.a', idem_key: 'relate:a' }));
    const b = await noteReviseSurface(ledger, reviseInput({ fact_key: 'relate.fact.b', idem_key: 'relate:b', text: 'second fact', reason: 'second fact' }));
    const edge = await noteRelateSurface(ledger, relateInput({
      from_ref: a.eventId,
      to_ref: b.eventId,
      reason: 'the storage decision shapes the second fact',
    }));
    assert.equal(edge.status, 'recorded');
    assert.equal(edge.edge.edge, 'depends_on');
    assert.equal(edge.edge.fromRef, a.eventId);
    assert.equal(edge.edge.toRef, b.eventId);
    assert.equal(edge.edge.eventId, edge.eventId);

    // A byte-identical retry under the same key returns the original result.
    const retried = await noteRelateSurface(ledger, relateInput({ from_ref: a.eventId, to_ref: b.eventId, reason: 'the storage decision shapes the second fact' }));
    assert.equal(retried.status, 'duplicate');
    assert.equal(retried.duplicate, true);
    assert.equal(retried.eventId, edge.eventId);

    await assert.rejects(noteRelateSurface(ledger, relateInput({ idem_key: 'relate:edge-2', from_ref: a.eventId, to_ref: b.eventId })), /already recorded/);
    await assert.rejects(noteRelateSurface(ledger, relateInput({ idem_key: 'relate:edge-3', edge: 'related_to', from_ref: a.eventId, to_ref: a.eventId })), /self-loop/);
    await assert.rejects(noteRelateSurface(ledger, relateInput({ idem_key: 'relate:edge-4', edge: 'related_to', to_ref: UNKNOWN_REF })), /does not resolve in this ledger/);
    await assert.rejects(
      noteRelateSurface(ledger, relateInput({ idem_key: 'relate:edge-5', edge: 'supersedes' as unknown as 'depends_on', from_ref: a.eventId, to_ref: b.eventId })),
      /one of depends_on/,
    );

    const relations = (await memoryFactSurface(ledger, { fact_key: 'relate.fact.a' })).relations;
    assert.ok(relations);
    assert.deepEqual(relations.outgoing.map((item) => item.toRef), [b.eventId]);
    assert.deepEqual(relations.incoming, []);
    assert.equal((await memoryFactSurface(ledger, { fact_key: 'relate.fact.a' })).fact.headRef, a.eventId, 'relations never change fact state');
    assert.equal((await memoryFactSurface(ledger, { fact_key: 'relate.fact.b' })).fact.headRef, b.eventId);
  } finally {
    ledger.close();
  }
});

test('memoryFactSurface resolves current, historical and retracted states without backfilling', async (t) => {
  const root = await gitProject(t);
  const ledger = await Ledger.open(root);
  try {
    const future = await noteReviseSurface(ledger, reviseInput({
      idem_key: 'time:future',
      fact_key: 'time.future.rule',
      text: 'takes effect later',
      effective_from: '2027-01-01T00:00:00.000Z',
      effective_to: '2027-06-01T00:00:00.000Z',
    }));
    const current = await memoryFactSurface(ledger, { fact_key: 'time.future.rule', now: '2026-11-21T00:00:00.000Z' });
    assert.equal(current.fact.found, false);
    assert.equal(current.fact.reason, 'not_yet_effective');
    assert.equal(current.fact.usage, undefined, 'an ineffective head is never passed off as a current basis');
    const historical = await memoryFactSurface(ledger, { fact_key: 'time.future.rule', mode: 'historical', as_of: '2027-06-01T00:00:00.000Z' });
    assert.equal(historical.fact.found, true);
    assert.equal(historical.fact.usage, 'historical');
    assert.equal(historical.fact.record?.recordRef, future.eventId);
    const uncovered = await memoryFactSurface(ledger, { fact_key: 'time.future.rule', mode: 'historical', as_of: '2026-01-01T00:00:00.000Z' });
    assert.equal(uncovered.fact.found, false);
    assert.equal(uncovered.fact.reason, 'no_version_covers_as_of');
    await assert.rejects(memoryFactSurface(ledger, { fact_key: 'time.future.rule', mode: 'historical' }), /requires as_of/);
    await assert.rejects(memoryFactSurface(ledger, { fact_key: 'time.future.rule', as_of: '2027-01-01T00:00:00.000Z' }), /requires mode historical/);

    await noteReviseSurface(ledger, reviseInput({ fact_key: 'time.unknown.rule', idem_key: 'time:unknown', text: 'unknown bounds', reason: 'unknown bounds' }));
    const unknown = await memoryFactSurface(ledger, { fact_key: 'time.unknown.rule', now: '2026-11-21T00:00:00.000Z' });
    assert.equal(unknown.fact.temporalUnknown, true);

    // Retraction through the ledger's own event path: the head stays on the
    // retracted record and reads report "retracted", never "no such fact".
    const headRef = unknown.fact.headRef;
    assert.ok(headRef);
    await ledger.append({
      kind: 'memory.revised',
      payload: { intent: 'retract', fact_key: 'time.unknown.rule', supersedes: [headRef], reason: 'wrong content' },
    }, 'time:retract');
    const retracted = await memoryFactSurface(ledger, { fact_key: 'time.unknown.rule' });
    assert.equal(retracted.fact.found, false);
    assert.equal(retracted.fact.status, 'retracted');
    assert.equal(retracted.fact.reason, 'fact_retracted');

    // The probe agrees: no current evidence, the retracted record is a tombstone.
    const probe = memoryProbeSurface(ledger, probeRequest(root, { required_facts: ['time.unknown.rule'] }), { now: '2026-11-21T00:00:00.000Z' });
    assert.equal(probe.active_evidence.length, 0);
    assert.ok(probe.deprecated_tombstones.some((item) => item.record_ref === headRef && item.status === 'retracted'));
  } finally {
    ledger.close();
  }
});

test('memoryProbeSurface returns versioned evidence and reaches typed relations through the P0 core', async (t) => {
  const root = await gitProject(t);
  const ledger = await Ledger.open(root);
  try {
    const a1 = await noteReviseSurface(ledger, reviseInput({ fact_key: 'probe.fact.a', idem_key: 'probe:a1' }));
    const a2 = await noteReviseSurface(ledger, reviseInput({
      fact_key: 'probe.fact.a',
      idem_key: 'probe:a2',
      text: 'storage engine is the views projection',
      supersedes: [a1.eventId],
      reason: 'second version',
    }));
    const b = await noteReviseSurface(ledger, reviseInput({ fact_key: 'probe.fact.b', idem_key: 'probe:b', text: 'second fact', reason: 'second fact' }));
    await noteRelateSurface(ledger, relateInput({ idem_key: 'probe:edge', edge: 'explains', from_ref: a2.eventId, to_ref: b.eventId, reason: 'v2 explains b' }));

    const response = memoryProbeSurface(ledger, probeRequest(root, { required_facts: ['probe.fact.a'] }), { now: '2026-11-21T00:00:00.000Z' });
    assert.equal(response.execution_status, 'OK');
    assert.equal(response.coverage_gate.status, 'SUFFICIENT');
    const evidence = response.active_evidence.map((item) => item.record_ref);
    assert.ok(evidence.includes(a2.eventId), 'the head version is the evidence');
    assert.ok(evidence.includes(b.eventId), 'the typed relation reaches the neighbour record');
    assert.ok(!evidence.includes(a1.eventId), 'the superseded version is not evidence');
    const head = response.active_evidence.find((item) => item.record_ref === a2.eventId);
    assert.ok(head);
    assert.equal(head.status, 'active');
    assert.equal(head.content_hash, a2.record.contentHash);
    assert.equal(head.effective_from, null);
    assert.equal(head.source.kind, 'native_note');
    assert.equal(head.source.path, 'src/auth/session.ts');
    const tombstone = response.deprecated_tombstones.find((item) => item.record_ref === a1.eventId);
    assert.ok(tombstone);
    assert.equal(tombstone.status, 'superseded');
    assert.equal(tombstone.superseded_by, a2.eventId);
    assert.deepEqual(response.snapshot.graph_revision, null, 'the ledger-only snapshot does not invent a graph revision');

    // A future-effective head is out of scope for CURRENT reads, never a
    // current fact and never silently dropped as missing.
    const futureFact = await noteReviseSurface(ledger, reviseInput({
      fact_key: 'time.future.rule',
      idem_key: 'probe:future',
      text: 'takes effect later',
      effective_from: '2027-01-01T00:00:00.000Z',
      effective_to: null,
      reason: 'future rule',
    }));
    const ineffective = memoryProbeSurface(ledger, probeRequest(root, { required_facts: ['time.future.rule'] }), { now: '2026-11-21T00:00:00.000Z' });
    assert.equal(ineffective.coverage_gate.status, 'INSUFFICIENT');
    assert.deepEqual(ineffective.coverage_gate.missing_facts, ['time.future.rule']);
    assert.ok(ineffective.gaps.some((gap) => gap.fact_key === 'time.future.rule' && gap.reason === 'out_of_scope'));
    assert.equal(ineffective.active_evidence.length, 0);

    // HISTORICAL reads return the record covering as_of, bounds verbatim.
    const historical = memoryProbeSurface(ledger, probeRequest(root, {
      required_facts: ['time.future.rule'],
      temporal_mode: 'HISTORICAL',
      as_of: '2027-06-01T00:00:00.000Z',
    }), { now: '2026-11-21T00:00:00.000Z' });
    assert.equal(historical.coverage_gate.status, 'SUFFICIENT');
    assert.equal(historical.active_evidence[0]?.record_ref, futureFact.eventId);
    assert.equal(historical.active_evidence[0]?.effective_from, '2027-01-01T00:00:00.000Z');
  } finally {
    ledger.close();
  }
});

test('memoryProbeSurface reports undecided forks and never a branch as current evidence', async (t) => {
  const root = await gitProject(t);
  const factKey = 'fork.fact.rule';
  const record = { text: 'forked record', kind: 'decision' };
  const genesisId = testUlid();
  const branchAId = testUlid();
  const branchBId = testUlid();
  const branchPayload = (): Record<string, unknown> => ({
    intent: 'revise',
    fact_key: factKey,
    record,
    supersedes: [genesisId],
    reason: 'competing revision',
    effective_from: null,
    effective_to: null,
  });
  const forkEvent = (id: string, logical: number, payload: Record<string, unknown>, prev: string): LedgerEvent => ({
    id,
    hlc: { physical: 1_795_219_200_000, logical, actor: 'tester' },
    actor: 'tester',
    kind: 'memory.revised',
    payload,
    idem_key: `fork:${logical}`,
    prev_hash: prev,
  });
  const genesis = forkEvent(genesisId, 1, {
    intent: 'revise',
    fact_key: factKey,
    record,
    supersedes: [],
    reason: 'genesis',
    effective_from: null,
    effective_to: null,
  }, genesisHash);
  const branchA = forkEvent(branchAId, 2, branchPayload(), hashEvent(genesis));
  const branchB = forkEvent(branchBId, 3, branchPayload(), genesisHash);

  // Two merged segments, each depending on the same prior: only the replay
  // layer can see this fork (the append layer rejects competing revisions).
  await mkdir(join(root, '.ano', 'ledger'), { recursive: true });
  await writeFile(join(root, '.ano', 'ledger', 'fork-a.jsonl'), encodeEvents([genesis, branchA]));
  await writeFile(join(root, '.ano', 'ledger', 'fork-b.jsonl'), encodeEvents([branchB]));

  const ledger = await Ledger.open(root);
  try {
    const response = memoryProbeSurface(ledger, probeRequest(root, { required_facts: [factKey] }), { now: '2026-11-21T00:00:00.000Z' });
    assert.equal(response.active_evidence.length, 0, 'a conflicted branch is never returned as evidence');
    // The genesis record was linearly superseded before the fork projected, so
    // it is an honest tombstone; the undecided branches are neither evidence
    // nor tombstones.
    assert.ok(response.deprecated_tombstones.every((item) => item.record_ref === genesisId), 'only the pre-fork record is tombstoned');
    assert.ok(!response.deprecated_tombstones.some((item) => item.record_ref === branchAId || item.record_ref === branchBId), 'undecided branches are not tombstones');
    const fork = response.conflicts.find((item) => item.fact_key === factKey);
    assert.ok(fork, 'the undecided fork is reported');
    assert.equal(fork?.status, 'unresolved');
    assert.deepEqual([...(fork?.record_refs ?? [])].sort(), [branchAId, branchBId].sort());
    assert.ok(response.coverage_gate.unresolved_conflicts.includes(fork?.conflict_id ?? ''));
    assert.equal(response.coverage_gate.status, 'INSUFFICIENT');

    const fact = await memoryFactSurface(ledger, { fact_key: factKey });
    assert.equal(fact.fact.found, false);
    assert.equal(fact.fact.status, 'conflicted');
    assert.deepEqual([...(fact.fact.branches ?? [])].sort(), [branchAId, branchBId].sort());
  } finally {
    ledger.close();
  }
});

test('service memory wrappers bind the project root and keep the probe contract', async (t) => {
  const root = await gitProject(t);
  const a = await noteRevise(root, reviseInput({ fact_key: 'service.fact.rule', idem_key: 'service:a' }));
  const b = await noteRevise(root, reviseInput({ fact_key: 'service.fact.b', idem_key: 'service:b', text: 'second fact', reason: 'second fact' }));
  await noteRelate(root, relateInput({ from_ref: String(a.eventId), to_ref: String(b.eventId), reason: 'service relation' }));

  const fact = await memoryFact(root, { fact_key: 'service.fact.rule' });
  assert.equal((fact.fact as { found: boolean }).found, true);
  assert.equal(((fact.relations as { outgoing: unknown[] }).outgoing).length, 1);

  const probe = await memoryProbe(root, probeRequest(root, { required_facts: ['service.fact.rule'] }), { now: '2026-11-21T00:00:00.000Z' });
  assert.equal(probe.coverage_gate.status, 'SUFFICIENT');
  assert.ok(probe.active_evidence.some((item) => item.record_ref === String(a.eventId)));

  await assert.rejects(memoryProbe(root, probeRequest(join(root, 'elsewhere'), { required_facts: ['service.fact.rule'] })), /does not match the open ledger/);
});

// ============================================================================
// ADR-006 / T-070: memory write paths route through the takeover state.
// ============================================================================

type ManagedTakeoverState = 'disabled' | 'enforced' | 'recovery';

function installTakeover(root: string, state: ManagedTakeoverState): void {
  const authorization = createAuthorization({
    root,
    projectId: 'fixture-project',
    projectKey: 'fixture-key',
    scope: ['tasks', 'memory', 'acceptance', 'dag'],
    grantedBy: 'Tester',
    role: 'Owner',
    statement: 'authorize the fixture project takeover',
    grantedAt: '2026-11-22T00:00:00.000Z',
  });
  const policy = createPolicy({
    root,
    projectId: 'fixture-project',
    projectKey: 'fixture-key',
    authorization,
    state,
    enforcedAt: state === 'disabled' ? null : '2026-11-22T00:00:01.000Z',
    baselineDigest: state === 'disabled' ? null : 'a'.repeat(64),
    hostCapability: state === 'disabled' ? null : 'degraded',
  });
  savePolicy(root, policy);
}

test('noteSurface and the governed write paths refuse recovery writes', async (t) => {
  const root = await gitProject(t);
  installTakeover(root, 'recovery');
  const ledger = await Ledger.open(root);
  try {
    await assert.rejects(noteSurface(ledger, decision), /recovery/);
    await assert.rejects(noteReviseSurface(ledger, reviseInput({ idem_key: 'rec:revise' })), /recovery/);
    await assert.rejects(noteRelateSurface(ledger, relateInput({ idem_key: 'rec:relate' })), /recovery/);
    assert.equal(ledger.listNotes().length, 0);
    assert.equal(existsSync(join(root, '.ano', 'ledger')), false, 'no ledger rows were committed');
  } finally {
    ledger.close();
  }
});

test('enforced memory writes stay on the ANO path and report ano-primary', async (t) => {
  const root = await gitProject(t);
  installTakeover(root, 'enforced');
  const a = await noteRevise(root, reviseInput({ idem_key: 'eno:a', fact_key: 'eno.fact.a' }));
  const b = await noteRevise(root, reviseInput({ idem_key: 'eno:b', fact_key: 'eno.fact.b', text: 'second fact', reason: 'second fact' }));
  const edge = await noteRelate(root, relateInput({ idem_key: 'eno:edge', from_ref: String(a.eventId), to_ref: String(b.eventId) }));
  assert.equal(a.status, 'recorded');
  assert.equal(b.status, 'recorded');
  assert.equal(edge.status, 'recorded');
  assert.equal((a.takeover as { state: string }).state, 'enforced');
  assert.equal((edge.takeover as { state: string }).state, 'enforced');
  assert.equal(existsSync(join(root, '.pm')), false, 'no legacy PM source was written');
});

test('corrupt takeover policy fails closed for memory writes and reports unknown in recall', async (t) => {
  const root = await gitProject(t);
  installTakeover(root, 'enforced');
  await writeFile(join(root, '.ano', 'takeover', 'policy.json'), '{ not json');
  const ledger = await Ledger.open(root);
  try {
    await assert.rejects(noteSurface(ledger, decision), /unreadable/);
    await assert.rejects(noteReviseSurface(ledger, reviseInput({ idem_key: 'bad:revise' })), /unreadable/);
    await assert.rejects(noteRelateSurface(ledger, relateInput({ idem_key: 'bad:relate' })), /unreadable/);
  } finally {
    ledger.close();
  }
  const recalled = await recallSurface(root, {});
  assert.equal(recalled.status, 'not_configured');
  assert.equal((recalled.takeover as { state: string }).state, 'unknown');
});
