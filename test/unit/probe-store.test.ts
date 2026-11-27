import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { LedgerEvent } from '../../src/ledger/event.ts';
import { Ledger } from '../../src/ledger/ledger.ts';
import { replayLedger } from '../../src/ledger/replay.ts';
import { viewDigest, type ViewReplayEntry } from '../../src/ledger/views.ts';
import {
  ANCHOR_PROBE_REQUEST_SCHEMA_VERSION,
  type AnchorProbeRequest,
  type AnchorProbeSnapshot,
} from '../../src/memory/probe-contract.ts';
import { probe, type ProbeCandidateSource } from '../../src/memory/probe.ts';
import {
  ProjectedProbeStore,
  SqliteProbeStore,
  adaptProbeCandidateSource,
  probeSnapshotIdentity,
  toProbeStore,
  type ProbeStore,
} from '../../src/memory/probe-store.ts';

/**
 * T-057: ProbeStore contract, SQLite baseline, cache rebuild and cross-backend
 * equivalence. The fixture is a real committed ledger, so every assertion runs
 * against facts derived from `memory.*` / `note.recorded` events rather than
 * hand-built rows.
 */

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const AT = '2026-11-21T00:00:00.000Z';
const ENGINE = 'local.storage.engine';
const RETENTION = 'local.retention.policy';
const FUTURE = 'local.future.plan';

interface Fixture {
  root: string;
  entries: readonly ViewReplayEntry[];
  snapshot: AnchorProbeSnapshot;
  /** Stores close before the temp root is removed (Windows file locks). */
  disposers: Array<() => void>;
  refs: {
    note: string;
    g1: string;
    g2: string;
    r1: string;
    f1: string;
  };
}

async function append(
  ledger: Ledger,
  kind: LedgerEvent['kind'],
  payload: Record<string, unknown>,
  idemKey: string,
): Promise<LedgerEvent> {
  const result = await ledger.append({ kind, payload }, idemKey);
  if (result.event === undefined) throw new Error(`append ${kind} produced no event`);
  return result.event;
}

async function buildFixture(t: TestContext): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'ano-probe-store-'));
  const disposers: Array<() => void> = [];
  t.after(async () => {
    for (let index = disposers.length - 1; index >= 0; index -= 1) disposers[index]?.();
    await rm(root, { recursive: true, force: true });
  });

  // An advancing clock keeps recorded_at ordering (and therefore candidate
  // ordering) deterministic; the ledger's own event ids carry random bits.
  let tick = 1000;
  const ledger = await Ledger.open(root, {
    sessionId: 'probe-store-test',
    clock: () => {
      tick += 1;
      return tick;
    },
  });
  try {
    const note = await append(ledger, 'note.recorded', {
      note_id: 'd'.repeat(64),
      kind: 'decision',
      text: 'Legacy lease decision',
      created_at: AT,
      anchor: { file: 'src/a.ts', symbolId: 'sym-a' },
    }, 'ps-note');

    const g1 = await append(ledger, 'memory.revised', {
      intent: 'revise',
      fact_key: ENGINE,
      record: { text: 'SQLite', kind: 'decision', anchor: { file: 'src/a.ts', symbolId: 'sym-a' } },
      supersedes: [],
      reason: 'genesis',
      effective_from: null,
      effective_to: null,
    }, 'ps-g1');
    const g2 = await append(ledger, 'memory.revised', {
      intent: 'revise',
      fact_key: ENGINE,
      record: { text: 'SQLite with FTS5', kind: 'decision', anchor: { file: 'src/a.ts', symbolId: 'sym-a' } },
      supersedes: [g1.id],
      reason: 'add fts',
      effective_from: null,
      effective_to: null,
    }, 'ps-g2');
    const r1 = await append(ledger, 'memory.revised', {
      intent: 'revise',
      fact_key: RETENTION,
      record: { text: 'Keep 30 days', kind: 'decision', anchor: { file: 'src/b.ts', symbolId: 'sym-b' } },
      supersedes: [],
      reason: 'genesis',
      effective_from: null,
      effective_to: null,
    }, 'ps-r1');
    await append(ledger, 'memory.related', {
      edge: 'depends_on',
      from_ref: g2.id,
      to_ref: r1.id,
      reason: 'engine feeds retention',
    }, 'ps-rel');
    // A retraction is a state change by event only; the record keeps its
    // content and becomes a tombstone instead of disappearing.
    await append(ledger, 'memory.revised', {
      intent: 'retract',
      fact_key: RETENTION,
      supersedes: [r1.id],
      reason: 'policy withdrawn',
    }, 'ps-retract');
    const f1 = await append(ledger, 'memory.revised', {
      intent: 'revise',
      fact_key: FUTURE,
      record: { text: 'Plan for 2027', kind: 'decision', anchor: { file: 'src/d.ts', symbolId: 'sym-d' } },
      supersedes: [],
      reason: 'future plan',
      effective_from: '2027-01-01T00:00:00.000Z',
      effective_to: null,
    }, 'ps-f1');

    return {
      root,
      entries: [],
      snapshot: {
        project_scope: 'fixture',
        ledger_digest: '0'.repeat(64),
        graph_revision: HASH_B,
        source_fingerprint: HASH_C,
        connected_digest: null,
      },
      disposers,
      refs: { note: note.id, g1: g1.id, g2: g2.id, r1: r1.id, f1: f1.id },
    };
  } finally {
    ledger.close();
  }
}

async function committedFixture(t: TestContext): Promise<Fixture> {
  const fixture = await buildFixture(t);
  const entries = replayLedger(join(fixture.root, '.ano', 'ledger')).entries;
  return {
    ...fixture,
    entries,
    snapshot: { ...fixture.snapshot, ledger_digest: viewDigest(entries) },
  };
}

function request(fixture: Fixture, overrides: Partial<AnchorProbeRequest> = {}): AnchorProbeRequest {
  return {
    schema_version: ANCHOR_PROBE_REQUEST_SCHEMA_VERSION,
    request_id: 'req-ps-1',
    root: fixture.root,
    project_scope: 'fixture',
    temporal_mode: 'CURRENT',
    ...overrides,
  } as AnchorProbeRequest;
}

function openSqlite(fixture: Fixture, t: TestContext): SqliteProbeStore {
  const store = SqliteProbeStore.open(fixture.root);
  fixture.disposers.push(() => store.close());
  return store;
}

function openProjected(fixture: Fixture, t: TestContext): ProjectedProbeStore {
  const store = ProjectedProbeStore.create(fixture.entries, fixture.snapshot);
  fixture.disposers.push(() => store.close());
  return store;
}

test('the SQLite baseline answers every ProbeStore query family over a real committed ledger', async (t) => {
  const fixture = await committedFixture(t);
  const store = openSqlite(fixture, t);
  store.rebuild(fixture.entries, fixture.snapshot);

  const candidates = store.candidates();
  assert.equal(candidates.length, 5);
  const g2 = candidates.find((candidate) => candidate.record_ref === fixture.refs.g2);
  assert.ok(g2);
  assert.equal(g2.fact_key, ENGINE);
  assert.equal(g2.version, 2);
  assert.equal(g2.status, 'active');
  assert.equal(g2.source_health, 'verified_at_snapshot');
  assert.deepEqual(g2.qualifiers, []);

  const g1 = store.status(fixture.refs.g1);
  assert.ok(g1);
  assert.equal(g1.status, 'superseded');
  assert.equal(g1.superseded_by, fixture.refs.g2);
  assert.equal(g1.eligibility, 'governed');
  const retracted = store.status(fixture.refs.r1);
  assert.ok(retracted);
  assert.equal(retracted.status, 'retracted');
  assert.equal(retracted.superseded_by, null);

  const noteProvenance = store.provenance(fixture.refs.note);
  assert.ok(noteProvenance);
  assert.ok(noteProvenance.qualifiers.includes('legacy_unreviewed'));

  const evidence = store.evidence(fixture.refs.g2);
  assert.ok(evidence);
  assert.equal(evidence.content, 'SQLite with FTS5');
  assert.equal(evidence.source.kind, 'native_note');
  assert.equal(store.evidence('missing-ref'), undefined);
  assert.equal(store.status('missing-ref'), undefined);
  assert.equal(store.provenance('missing-ref'), undefined);

  const relations = store.adjacency();
  assert.ok(relations.some((edge) => edge.from === fixture.refs.g2 && edge.to === fixture.refs.r1 && edge.kind === 'depends_on' && edge.provenance === 'confirmed'));
  assert.ok(store.adjacency(fixture.refs.r1).some((edge) => edge.from === fixture.refs.g2));
  assert.equal(store.adjacency(fixture.refs.g1).length, 0);

  const identity = store.snapshotIdentity();
  assert.equal(identity.fingerprint, probeSnapshotIdentity(fixture.snapshot).fingerprint);
  assert.match(identity.fingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(identity.graph_revision, HASH_B);
  assert.equal(identity.connected_digest, null);
  const other = probeSnapshotIdentity({ ...fixture.snapshot, graph_revision: HASH_A });
  assert.notEqual(other.fingerprint, identity.fingerprint);
  assert.equal(other.graph_revision, HASH_A);
});

test('the SQLite baseline preserves P0-P3 probe semantics', async (t) => {
  const fixture = await committedFixture(t);
  const store = openSqlite(fixture, t);
  store.rebuild(fixture.entries, fixture.snapshot);

  const routed = probe(request(fixture, { required_facts: [ENGINE] }), store, { now: AT });
  assert.equal(routed.execution_status, 'OK');
  assert.equal(routed.budget_status.stop_reason, 'FRONTIER_EXHAUSTED');
  assert.equal(routed.budget_status.retrieval_completeness, 'COMPLETE_WITHIN_DECLARED_SCOPE');
  assert.deepEqual([...routed.active_evidence].map((item) => item.record_ref), [fixture.refs.g2]);
  const tombstone = routed.deprecated_tombstones.find((item) => item.record_ref === fixture.refs.g1);
  assert.ok(tombstone);
  assert.equal(tombstone.status, 'superseded');
  assert.equal(tombstone.superseded_by, fixture.refs.g2);
  // The retracted retention record is reached through the typed edge and is
  // reported as a tombstone, never as active evidence.
  const retractedTombstone = routed.deprecated_tombstones.find((item) => item.record_ref === fixture.refs.r1);
  assert.ok(retractedTombstone);
  assert.equal(retractedTombstone.status, 'retracted');
  assert.equal(routed.coverage_gate.status, 'SUFFICIENT');

  const missing = probe(request(fixture, { required_facts: ['local.absent.fact'] }), store, { now: AT });
  assert.deepEqual(missing.gaps, [{ fact_key: 'local.absent.fact', reason: 'missing' }]);
  assert.equal(missing.coverage_gate.status, 'INSUFFICIENT');

  const capped = probe(
    request(fixture, { required_facts: [ENGINE], budget: { max_candidates: 1, max_nodes: 12, max_depth: 3 } }),
    store,
    { now: AT },
  );
  assert.equal(capped.budget_status.stop_reason, 'BUDGET_EXHAUSTED');
  assert.equal(capped.budget_status.retrieval_completeness, 'PARTIAL');
  // The pool is newest-first, so the single slot keeps the current revision;
  // traversal still reaches the retracted neighbour through the typed edge.
  assert.deepEqual(capped.active_evidence.map((item) => item.record_ref), [fixture.refs.g2]);
  assert.deepEqual(capped.deprecated_tombstones.map((item) => item.record_ref), [fixture.refs.r1]);

  const notYetEffective = probe(request(fixture, { required_facts: [FUTURE] }), store, { now: AT });
  assert.equal(notYetEffective.active_evidence.length, 0);
  assert.deepEqual(notYetEffective.gaps, [{ fact_key: FUTURE, reason: 'out_of_scope' }]);

  const retractedFact = probe(request(fixture, { required_facts: [RETENTION] }), store, { now: AT });
  assert.equal(retractedFact.active_evidence.length, 0);
  assert.deepEqual(retractedFact.gaps, [{ fact_key: RETENTION, reason: 'out_of_scope' }]);
});

test('cross-backend responses are equivalent: SQLite cache vs event-rebuilt projection', async (t) => {
  const fixture = await committedFixture(t);
  const sqlite = openSqlite(fixture, t);
  sqlite.rebuild(fixture.entries, fixture.snapshot);
  const projected = openProjected(fixture, t);

  assert.deepEqual(projected.candidates(), sqlite.candidates());
  assert.deepEqual(projected.adjacency(), sqlite.adjacency());
  assert.deepEqual(projected.adjacency(fixture.refs.g2), sqlite.adjacency(fixture.refs.g2));
  for (const backend of [sqlite, projected]) {
    assert.equal(backend.evidence('missing-ref'), undefined);
    assert.equal(backend.status('missing-ref'), undefined);
    assert.equal(backend.provenance('missing-ref'), undefined);
  }

  const requests: AnchorProbeRequest[] = [
    request(fixture, { required_facts: [ENGINE] }),
    request(fixture, { required_facts: [ENGINE, RETENTION] }),
    request(fixture, { required_facts: [RETENTION] }),
    request(fixture, { required_facts: [FUTURE] }),
    request(fixture, { required_facts: ['local.absent.fact'] }),
    request(fixture, { request_id: 'req-ps-broad' }),
  ];
  for (const current of requests) {
    const fromSqlite = probe(current, sqlite, { now: AT });
    const fromProjection = probe(current, projected, { now: AT });
    assert.deepEqual(fromProjection, fromSqlite);
  }

  // A narrow injected source is adapted into the same port, so it cannot drift.
  const narrow: ProbeCandidateSource = {
    snapshot: fixture.snapshot,
    entries: (query) => projected.candidates(query),
    edges: () => projected.adjacency(),
  };
  const adapted = probe(requests[0] as AnchorProbeRequest, narrow, { now: AT });
  assert.deepEqual(adapted, probe(requests[0] as AnchorProbeRequest, sqlite, { now: AT }));
  assert.ok(toProbeStore(sqlite) === sqlite);
  assert.ok(toProbeStore(narrow).snapshot === fixture.snapshot);
});

test('repeated queries over an intact cache are deterministic', async (t) => {
  const fixture = await committedFixture(t);
  const store = openSqlite(fixture, t);
  store.rebuild(fixture.entries, fixture.snapshot);
  const current = request(fixture, { required_facts: [ENGINE, RETENTION, FUTURE] });
  const first = probe(current, store, { now: AT });
  const second = probe(current, store, { now: AT });
  assert.deepEqual(second, first);
});

test('an intact cache refreshes as fresh; a damaged row count triggers a rebuild to the same answer', async (t) => {
  const fixture = await committedFixture(t);
  const store = openSqlite(fixture, t);
  store.rebuild(fixture.entries, fixture.snapshot);
  assert.equal(store.refresh(fixture.entries, fixture.snapshot), 'fresh');

  const baseline = probe(request(fixture, { required_facts: [ENGINE] }), store, { now: AT });

  const intruder = new DatabaseSync(store.databasePath);
  try {
    intruder.prepare('DELETE FROM probe_records WHERE record_ref = ?').run(fixture.refs.r1);
  } finally {
    intruder.close();
  }
  assert.equal(store.refresh(fixture.entries, fixture.snapshot), 'rebuilt');
  assert.deepEqual(probe(request(fixture, { required_facts: [ENGINE] }), store, { now: AT }), baseline);
});

test('edited cache content is detected by the checksum and rebuilt from committed events', async (t) => {
  const fixture = await committedFixture(t);
  const store = openSqlite(fixture, t);
  store.rebuild(fixture.entries, fixture.snapshot);

  const intruder = new DatabaseSync(store.databasePath);
  try {
    intruder.prepare('UPDATE probe_records SET content = ? WHERE record_ref = ?').run('tampered', fixture.refs.g2);
  } finally {
    intruder.close();
  }
  assert.equal(store.refresh(fixture.entries, fixture.snapshot), 'rebuilt');
  assert.equal(store.evidence(fixture.refs.g2)?.content, 'SQLite with FTS5');
});

test('a dropped cache table is corruption, never an empty answer', async (t) => {
  const fixture = await committedFixture(t);
  const store = openSqlite(fixture, t);
  store.rebuild(fixture.entries, fixture.snapshot);

  const intruder = new DatabaseSync(store.databasePath);
  try {
    intruder.exec('DROP TABLE probe_edges');
  } finally {
    intruder.close();
  }
  assert.equal(store.refresh(fixture.entries, fixture.snapshot), 'rebuilt');
  assert.ok(store.adjacency().some((edge) => edge.from === fixture.refs.g2 && edge.to === fixture.refs.r1));
});

test('the cache is disposable: deleting the file loses no committed fact', async (t) => {
  const fixture = await committedFixture(t);
  const first = openSqlite(fixture, t);
  first.rebuild(fixture.entries, fixture.snapshot);
  const baseline = probe(request(fixture, { required_facts: [ENGINE, RETENTION] }), first, { now: AT });
  assert.equal(first.databasePath, SqliteProbeStore.databasePath(fixture.root));
  first.close();

  await rm(first.databasePath, { force: true });

  const second = SqliteProbeStore.open(fixture.root);
  fixture.disposers.push(() => second.close());
  assert.equal(second.refresh(fixture.entries, fixture.snapshot), 'rebuilt');
  assert.deepEqual(probe(request(fixture, { required_facts: [ENGINE, RETENTION] }), second, { now: AT }), baseline);
});

test('the cache follows the committed log instead of freezing the first build', async (t) => {
  const fixture = await committedFixture(t);
  const store = openSqlite(fixture, t);
  store.rebuild(fixture.entries, fixture.snapshot);
  assert.equal(store.candidates().length, 5);

  const ledger = await Ledger.open(fixture.root, { sessionId: 'probe-store-test-2', clock: () => 2000 });
  let late: LedgerEvent | undefined;
  try {
    late = await append(ledger, 'memory.revised', {
      intent: 'revise',
      fact_key: RETENTION,
      record: { text: 'Keep 7 days', kind: 'decision', anchor: { file: 'src/b.ts', symbolId: 'sym-b' } },
      supersedes: [fixture.refs.r1],
      reason: 'shorten retention',
      effective_from: null,
      effective_to: null,
    }, 'ps-late');
  } finally {
    ledger.close();
  }

  const entries = replayLedger(join(fixture.root, '.ano', 'ledger')).entries;
  const snapshot = { ...fixture.snapshot, ledger_digest: viewDigest(entries) };
  assert.equal(store.refresh(entries, snapshot), 'rebuilt');
  const candidates = store.candidates();
  assert.equal(candidates.length, 6);
  assert.ok(candidates.some((candidate) => candidate.record_ref === late?.id));
  assert.equal(store.snapshot.ledger_digest, viewDigest(entries));
});

test('adaptProbeCandidateSource keeps narrow sources on the same ProbeStore contract', async (t) => {
  const fixture = await committedFixture(t);
  const projected = openProjected(fixture, t);
  const narrow: ProbeCandidateSource = {
    snapshot: fixture.snapshot,
    entries: (query) => projected.candidates(query),
    edges: () => projected.adjacency(),
  };
  const store = adaptProbeCandidateSource(narrow);
  assert.equal(store.candidates().length, 5);
  assert.equal(store.evidence(fixture.refs.g2)?.content, 'SQLite with FTS5');
  assert.equal(store.status(fixture.refs.g1)?.superseded_by, fixture.refs.g2);
  assert.equal(store.snapshotIdentity().fingerprint, probeSnapshotIdentity(fixture.snapshot).fingerprint);
  assert.ok(store.adjacency(fixture.refs.r1).length > 0);
});

test('a store without a built cache reports unavailability instead of empty facts', async (t) => {
  const fixture = await committedFixture(t);
  const store = openSqlite(fixture, t);
  assert.throws(() => store.snapshot, /not been rebuilt/);
  const projected = ProjectedProbeStore.create(fixture.entries, fixture.snapshot);
  fixture.disposers.push(() => projected.close());
  assert.doesNotThrow(() => projected.snapshot);
});
