/**
 * T-153 shard B: reachable branches of `src/memory/probe.ts`.
 *
 * The existing suite covers ordinary retrieval. This file drives the honest
 * degradation paths: an unavailable snapshot, a throwing index/edge lookup,
 * routing-dimension errors, an unknown edge kind, and a core failure that must
 * surface as FAILED rather than an exception.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { probe, ProbeRequestError, type ProbeCandidate, type ProbeCandidateSource, type ProbeEdge } from '../../src/memory/probe.ts';
import type { AnchorProbeRequest, AnchorProbeSnapshot } from '../../src/memory/probe-contract.ts';

const HASH_A = 'a'.repeat(64);
const SCOPE = 'fixture';
const AT = '2026-11-21T00:00:00.000Z';

function request(overrides: Record<string, unknown> = {}): AnchorProbeRequest {
  return {
    schema_version: 'anchorprobe.request.v1',
    request_id: 'req-1',
    root: '/fixtures/root',
    project_scope: SCOPE,
    required_facts: ['local.storage.engine'],
    temporal_mode: 'CURRENT',
    budget: { max_candidates: 8, max_nodes: 8, max_depth: 2 },
    ...overrides,
  } as AnchorProbeRequest;
}

function snapshot(overrides: Record<string, unknown> = {}): AnchorProbeSnapshot {
  return {
    project_scope: SCOPE,
    ledger_digest: HASH_A,
    graph_revision: null,
    source_fingerprint: null,
    connected_digest: null,
    ...overrides,
  } as AnchorProbeSnapshot;
}

function candidate(overrides: Record<string, unknown> = {}): ProbeCandidate {
  return {
    record_ref: 'rec-1',
    fact_key: 'local.storage.engine',
    task_id: null,
    file: 'docs/example.md',
    symbol: null,
    source: { kind: 'native_note', path: 'docs/example.md' },
    source_health: 'verified_at_snapshot',
    status: 'active',
    content: 'SQLite is the storage engine.',
    content_hash: HASH_A,
    recorded_at: AT,
    effective_from: null,
    effective_to: null,
    superseded_by: null,
    version: null,
    anchor: { status: 'exact', file: 'docs/example.md' },
    qualifiers: [],
    ...overrides,
  };
}

interface SourceOptions {
  readonly entries?: (query?: Record<string, unknown>) => readonly ProbeCandidate[];
  readonly edges?: () => readonly ProbeEdge[];
  readonly snapshotValue?: AnchorProbeSnapshot;
  readonly snapshotError?: unknown;
}

function source(options: SourceOptions = {}): ProbeCandidateSource {
  const value: Record<string, unknown> = {
    entries: (query?: Record<string, unknown>) => {
      if (options.entries !== undefined) return options.entries(query);
      if (query === undefined || Object.keys(query).length === 0) return [candidate()];
      return [];
    },
    edges: () => (options.edges !== undefined ? options.edges() : []),
  };
  if (options.snapshotError === undefined) {
    value['snapshot'] = options.snapshotValue ?? snapshot();
  } else {
    Object.defineProperty(value, 'snapshot', {
      enumerable: true,
      get: (): AnchorProbeSnapshot => { throw options.snapshotError; },
    });
  }
  return value as unknown as ProbeCandidateSource;
}

test('m18b probe reports an unavailable snapshot as FAILED with a zeroed fallback snapshot', () => {
  const response = probe(request(), source({ snapshotError: new Error('cache closed') }));
  assert.equal(response.execution_status, 'FAILED');
  assert.equal(response.snapshot.project_scope, SCOPE);
  assert.equal(response.snapshot.ledger_digest, '0'.repeat(64));
  assert.equal(response.snapshot.graph_revision, null);
  assert.equal(response.snapshot.source_fingerprint, null);
  assert.equal(response.snapshot.connected_digest, null);
  assert.ok(response.l1_invariants.some((item) => item.invariant_id === 'probe.execution'));
});

test('m18b probe turns a throwing records lookup into an explicit records index error', () => {
  const response = probe(request(), source({
    entries: (query?: Record<string, unknown>) => {
      if (query === undefined || Object.keys(query).length === 0) throw new Error('index unavailable');
      return [];
    },
    edges: () => [],
  }));
  assert.equal(response.execution_status, 'DEGRADED');
  const invariant = response.l1_invariants.find((item) => item.invariant_id === 'probe.index_errors_surfaced');
  assert.equal(invariant?.status, 'violated');
  assert.match(String(invariant?.detail), /1 index error/u);
});

test('m18b probe routes task/file/symbol dimensions through dimensionOf on index failure', () => {
  const calls: string[] = [];
  const response = probe(
    request({ required_facts: [] }),
    source({
      entries: (query?: Record<string, unknown>) => {
        if (query === undefined || Object.keys(query).length === 0) return [candidate()];
        calls.push(Object.keys(query)[0]!);
        throw new Error(`${Object.keys(query)[0]} index down`);
      },
      edges: () => [],
    }),
    { entries: [{ task_id: 'task-1' }, { file: 'docs/a.md' }, { symbol: 'sym' }] },
  );
  assert.equal(response.execution_status, 'DEGRADED');
  assert.deepEqual(calls, ['task_id', 'file', 'symbol']);
  const invariant = response.l1_invariants.find((item) => item.invariant_id === 'probe.index_errors_surfaced');
  assert.match(String(invariant?.detail), /3 index error/u);
});

test('m18b probe records a throwing edge lookup instead of hiding it', () => {
  const response = probe(request(), source({
    entries: () => [candidate()],
    edges: () => { throw new Error('adjacency unavailable'); },
  }));
  assert.equal(response.execution_status, 'DEGRADED');
  const invariant = response.l1_invariants.find((item) => item.invariant_id === 'probe.index_errors_surfaced');
  assert.equal(invariant?.status, 'violated');
  assert.match(String(invariant?.detail), /1 index error/u);
});

test('m18b probe ranks an unknown edge kind after every known kind', () => {
  const weird = { from: 'rec-1', to: 'rec-2', kind: 'bogus', provenance: 'unknown' } as unknown as ProbeEdge;
  const known: ProbeEdge = { from: 'rec-1', to: 'rec-3', kind: 'depends_on', provenance: 'confirmed' };
  const response = probe(request(), source({
    entries: () => [candidate(), candidate({ record_ref: 'rec-2', fact_key: null }), candidate({ record_ref: 'rec-3', fact_key: null })],
    edges: () => [weird, known],
  }));
  assert.equal(response.execution_status, 'OK');
  assert.equal(response.active_evidence.length >= 1, true);
});

test('m18b probe falls back to the broadened slow path when a dimension resolves nothing', () => {
  const response = probe(
    request({ required_facts: ['local.storage.engine'] }),
    source({
      entries: (query?: Record<string, unknown>) => {
        if (query === undefined || Object.keys(query).length === 0) return [candidate()];
        return [];
      },
      edges: () => [],
    }),
  );
  const invariant = response.l1_invariants.find((item) => item.invariant_id === 'probe.entry_routing');
  assert.equal(invariant?.status, 'unknown');
  assert.equal(response.execution_status, 'OK');
  assert.ok(response.active_evidence.some((item) => item.record_ref === 'rec-1'));
});

test('m18b probe converts a core crash into a FAILED response, never an exception', () => {
  const broken = source({ entries: (() => ({})) as unknown as () => readonly ProbeCandidate[] });
  const response = probe(request(), broken);
  assert.equal(response.execution_status, 'FAILED');
  assert.ok(response.l1_invariants.some((item) => item.status === 'violated'));
});

test('m18b probe rejects an invalid request with ProbeRequestError before touching the source', () => {
  let touched = false;
  assert.throws(
    () => probe({ schema_version: 'nope' }, source({ entries: () => { touched = true; return []; } })),
    (error: unknown) => {
      assert.ok(error instanceof ProbeRequestError);
      return true;
    },
  );
  assert.equal(touched, false);
});
