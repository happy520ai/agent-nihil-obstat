import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ProbeIndexError,
  ProbeRequestError,
  probe,
  type ProbeCandidate,
  type ProbeCandidateSource,
  type ProbeEdge,
  type ProbeEntryQuery,
} from '../../src/memory/probe.ts';
import {
  ANCHOR_PROBE_CONTEXT_SCHEMA_VERSION,
  ANCHOR_PROBE_REQUEST_SCHEMA_VERSION,
  anchorProbeDefaultBudget,
  anchorProbeResponseSchema,
  type AnchorProbeSnapshot,
} from '../../src/memory/probe-contract.ts';

const HASH = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);
const AT = '2026-11-21T00:00:00.000Z';
const AT_LATER = '2026-11-22T00:00:00.000Z';

function snapshot(overrides: Partial<AnchorProbeSnapshot> = {}): AnchorProbeSnapshot {
  return {
    project_scope: 'proj',
    ledger_digest: HASH,
    graph_revision: null,
    source_fingerprint: HASH_B,
    connected_digest: null,
    ...overrides,
  };
}

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: ANCHOR_PROBE_REQUEST_SCHEMA_VERSION,
    request_id: 'req-1',
    root: 'F:/project',
    project_scope: 'proj',
    ...overrides,
  };
}

function candidate(overrides: Partial<ProbeCandidate> & { record_ref: string }): ProbeCandidate {
  return {
    fact_key: null,
    task_id: null,
    file: null,
    symbol: null,
    source: { kind: 'native_note' },
    source_health: 'verified_at_snapshot',
    status: 'active',
    content: `content of ${overrides.record_ref}`,
    content_hash: HASH,
    recorded_at: AT,
    effective_from: null,
    effective_to: null,
    superseded_by: null,
    version: null,
    anchor: { status: 'none', file: null },
    qualifiers: [],
    ...overrides,
  };
}

function matches(query: ProbeEntryQuery, candidate: ProbeCandidate): boolean {
  if (query.fact_key !== undefined && candidate.fact_key === query.fact_key) return true;
  if (query.task_id !== undefined && candidate.task_id === query.task_id) return true;
  if (query.file !== undefined && candidate.file === query.file) return true;
  if (query.symbol !== undefined && candidate.symbol === query.symbol) return true;
  return false;
}

class MemorySource implements ProbeCandidateSource {
  readonly snapshot: AnchorProbeSnapshot;
  private readonly records: readonly ProbeCandidate[];
  private readonly edgeList: readonly ProbeEdge[];
  private readonly throwOnQuery: boolean;

  constructor(
    records: readonly ProbeCandidate[],
    edges: readonly ProbeEdge[] = [],
    options: { snapshot?: AnchorProbeSnapshot; throwOnQuery?: boolean } = {},
  ) {
    this.records = records;
    this.edgeList = edges;
    this.snapshot = options.snapshot ?? snapshot();
    this.throwOnQuery = options.throwOnQuery ?? false;
  }

  entries(query?: ProbeEntryQuery): readonly ProbeCandidate[] {
    if (this.throwOnQuery) throw new ProbeIndexError('index unavailable');
    if (query === undefined || Object.keys(query).length === 0) return this.records;
    return this.records.filter((record) => matches(query, record));
  }

  edges(): readonly ProbeEdge[] {
    return this.edgeList;
  }
}

/** A source whose dimension index is empty but whose full index is populated. */
class SlowPathSource extends MemorySource {
  override entries(query?: ProbeEntryQuery): readonly ProbeCandidate[] {
    if (query === undefined || Object.keys(query).length === 0) return super.entries(query);
    return [];
  }
}

function edge(from: string, to: string, kind: ProbeEdge['kind'] = 'related_to', provenance: ProbeEdge['provenance'] = 'confirmed'): ProbeEdge {
  return { from, to, kind, provenance };
}

test('routes entries by fact, task, file and symbol and conforms to the contract', () => {
  const records = [
    candidate({ record_ref: 'r-fact', fact_key: 'local.storage.engine' }),
    candidate({ record_ref: 'r-task', task_id: 'T-1' }),
    candidate({ record_ref: 'r-file', file: 'src/a.ts' }),
    candidate({ record_ref: 'r-symbol', symbol: 'parse' }),
  ];
  const source = new MemorySource(records);
  for (const [query, expected] of [
    [{ fact_key: 'local.storage.engine' }, 'r-fact'],
    [{ task_id: 'T-1' }, 'r-task'],
    [{ file: 'src/a.ts' }, 'r-file'],
    [{ symbol: 'parse' }, 'r-symbol'],
  ] as const) {
    const response = probe(request(), source, { entries: [query], now: AT });
    assert.equal(anchorProbeResponseSchema.safeParse(response).success, true);
    assert.deepEqual(response.active_evidence.map((item) => item.record_ref), [expected]);
    assert.equal(response.budget_status.stop_reason, 'FRONTIER_EXHAUSTED');
    assert.equal(response.budget_status.retrieval_completeness, 'COMPLETE_WITHIN_DECLARED_SCOPE');
    assert.equal(response.execution_status, 'OK');
  }
});

test('filters by version: a lower version becomes a superseded tombstone', () => {
  const records = [
    candidate({ record_ref: 'r-old', fact_key: 'local.storage.engine', version: 1, content_hash: HASH_C }),
    candidate({ record_ref: 'r-new', fact_key: 'local.storage.engine', version: 2, content_hash: HASH_D, recorded_at: AT_LATER }),
  ];
  const response = probe(request({ required_facts: ['local.storage.engine'] }), new MemorySource(records), { now: AT });
  assert.deepEqual(response.active_evidence.map((item) => item.record_ref), ['r-new']);
  assert.equal(response.deprecated_tombstones.length, 1);
  assert.equal(response.deprecated_tombstones[0]?.record_ref, 'r-old');
  assert.equal(response.deprecated_tombstones[0]?.superseded_by, 'r-new');
  assert.equal(response.deprecated_tombstones[0]?.status, 'superseded');
  assert.equal(anchorProbeResponseSchema.safeParse(response).success, true);
});

test('filters by effective interval and reports an out-of-scope gap', () => {
  const records = [
    candidate({ record_ref: 'r-future', fact_key: 'local.storage.engine', effective_from: AT_LATER }),
    candidate({ record_ref: 'r-expired', fact_key: 'local.storage.retention', effective_to: AT }),
  ];
  const response = probe(
    request({ required_facts: ['local.storage.engine', 'local.storage.retention'], temporal_mode: 'AS_OF', as_of: AT }),
    new MemorySource(records),
    { now: AT },
  );
  assert.equal(response.active_evidence.length, 0);
  assert.deepEqual(response.gaps, [
    { fact_key: 'local.storage.engine', reason: 'out_of_scope' },
    { fact_key: 'local.storage.retention', reason: 'out_of_scope' },
  ]);
  assert.equal(response.coverage_gate.status, 'INSUFFICIENT');
  assert.equal(response.coverage_gate.missing_facts.length, 2);
});

test('a stale anchor downgrades source health but never hides the record', () => {
  const records = [
    candidate({ record_ref: 'r-1', fact_key: 'local.storage.engine', source_health: 'verified_at_snapshot', anchor: { status: 'stale', file: 'src/gone.ts' } }),
    candidate({ record_ref: 'r-2', fact_key: 'local.storage.retention', source: { kind: 'history' }, source_health: 'unknown' }),
  ];
  const response = probe(
    request({ required_facts: ['local.storage.engine', 'local.storage.retention'] }),
    new MemorySource(records),
    { now: AT },
  );
  assert.equal(response.active_evidence.length, 2);
  const first = response.active_evidence.find((item) => item.record_ref === 'r-1');
  const second = response.active_evidence.find((item) => item.record_ref === 'r-2');
  assert.equal(first?.source_health, 'stale');
  assert.equal(second?.source_health, 'unknown');
  assert.equal(second?.source.kind, 'history');
});

test('walks typed edges and stops at the depth limit', () => {
  const records = [
    candidate({ record_ref: 'r1', fact_key: 'local.storage.engine' }),
    candidate({ record_ref: 'r2' }),
    candidate({ record_ref: 'r3' }),
  ];
  const edges = [edge('r1', 'r2', 'depends_on'), edge('r2', 'r3', 'depends_on')];
  const response = probe(
    request(),
    new MemorySource(records, edges),
    { entries: [{ fact_key: 'local.storage.engine' }], now: AT, deadlineMs: 1000 },
  );
  // Default max_depth is 3, so the whole chain is reachable.
  assert.deepEqual(response.active_evidence.map((item) => item.record_ref), ['r1', 'r2', 'r3']);
  assert.equal(response.budget_status.stop_reason, 'FRONTIER_EXHAUSTED');

  const shallow = probe(
    request(),
    new MemorySource(records, edges),
    { entries: [{ fact_key: 'local.storage.engine' }], now: AT },
  );
  assert.equal(shallow.budget_status.stop_reason, 'FRONTIER_EXHAUSTED');
});

test('depth limit is explicit when the budget is tightened', () => {
  const records = [
    candidate({ record_ref: 'r1', fact_key: 'local.storage.engine' }),
    candidate({ record_ref: 'r2' }),
    candidate({ record_ref: 'r3' }),
    candidate({ record_ref: 'r4' }),
  ];
  const edges = [
    edge('r1', 'r2', 'depends_on'),
    edge('r2', 'r3', 'depends_on'),
    edge('r3', 'r4', 'depends_on'),
  ];
  const response = probe(
    request({ budget: { max_candidates: 16, max_nodes: 12, max_depth: 1 } }),
    new MemorySource(records, edges),
    { entries: [{ fact_key: 'local.storage.engine' }], now: AT },
  );
  assert.equal(response.budget_status.stop_reason, 'DEPTH_LIMIT');
  assert.equal(response.budget_status.retrieval_completeness, 'PARTIAL');
  assert.equal(response.budget_status.nodes_visited, 2);
  assert.equal(anchorProbeResponseSchema.safeParse(response).success, true);
});

test('node budget truncates traversal and never claims completeness', () => {
  const records = Array.from({ length: 5 }, (_, index) =>
    candidate({ record_ref: `r${index + 1}`, fact_key: index === 0 ? 'local.storage.engine' : null }));
  const edges = records.slice(1).map((record, index) => edge(records[index]?.record_ref as string, record.record_ref, 'depends_on'));
  const response = probe(
    request({ budget: { max_candidates: 16, max_nodes: 2, max_depth: 3 } }),
    new MemorySource(records, edges),
    { entries: [{ fact_key: 'local.storage.engine' }], now: AT },
  );
  assert.equal(response.budget_status.stop_reason, 'BUDGET_EXHAUSTED');
  assert.equal(response.budget_status.retrieval_completeness, 'PARTIAL');
  assert.equal(response.budget_status.nodes_visited, 2);
  assert.equal(anchorProbeResponseSchema.safeParse(response).success, true);
});

test('candidate budget truncates the initial pool', () => {
  const records = Array.from({ length: 4 }, (_, index) =>
    candidate({ record_ref: `r${index + 1}`, fact_key: 'local.storage.engine' }));
  const response = probe(
    request({ required_facts: ['local.storage.engine'], budget: { max_candidates: 2, max_nodes: 12, max_depth: 3 } }),
    new MemorySource(records),
    { now: AT },
  );
  assert.equal(response.budget_status.stop_reason, 'BUDGET_EXHAUSTED');
  assert.equal(response.budget_status.retrieval_completeness, 'PARTIAL');
  assert.equal(response.active_evidence.length, 2);
});

test('a cycle terminates and keeps aliases unique', () => {
  const records = [
    candidate({ record_ref: 'r1', fact_key: 'local.storage.engine' }),
    candidate({ record_ref: 'r2' }),
  ];
  const edges = [edge('r1', 'r2'), edge('r2', 'r1')];
  const response = probe(
    request(),
    new MemorySource(records, edges),
    { entries: [{ fact_key: 'local.storage.engine' }], now: AT },
  );
  assert.equal(response.budget_status.stop_reason, 'FRONTIER_EXHAUSTED');
  assert.equal(response.budget_status.retrieval_completeness, 'COMPLETE_WITHIN_DECLARED_SCOPE');
  assert.equal(response.budget_status.nodes_visited, 2);
  const refs = [...response.active_evidence, ...response.deprecated_tombstones].map((item) => item.ref);
  assert.equal(new Set(refs).size, refs.length);
});

test('conflicting active records at one fact slot produce an unresolved conflict', () => {
  const records = [
    candidate({ record_ref: 'r-a', fact_key: 'local.storage.engine', content_hash: HASH_C, content: 'sqlite' }),
    candidate({ record_ref: 'r-b', fact_key: 'local.storage.engine', content_hash: HASH_D, content: 'postgres' }),
  ];
  const response = probe(request({ required_facts: ['local.storage.engine'] }), new MemorySource(records), { now: AT });
  assert.equal(response.conflicts.length, 1);
  assert.equal(response.conflicts[0]?.fact_key, 'local.storage.engine');
  assert.equal(response.conflicts[0]?.status, 'unresolved');
  assert.deepEqual(response.conflicts[0]?.record_refs, ['r-a', 'r-b']);
  assert.deepEqual(response.gaps, [{ fact_key: 'local.storage.engine', reason: 'ambiguous' }]);
  assert.equal(response.coverage_gate.status, 'INSUFFICIENT');
  assert.deepEqual(response.coverage_gate.unresolved_conflicts, ['conflict-1']);
  assert.equal(anchorProbeResponseSchema.safeParse(response).success, true);
});

test('a missing required fact is a gap while the declared scope stays complete', () => {
  const records = [candidate({ record_ref: 'r-a', fact_key: 'local.storage.engine' })];
  const response = probe(
    request({ required_facts: ['local.storage.engine', 'local.storage.retention'] }),
    new MemorySource(records),
    { now: AT },
  );
  assert.equal(response.budget_status.stop_reason, 'FRONTIER_EXHAUSTED');
  assert.equal(response.budget_status.retrieval_completeness, 'COMPLETE_WITHIN_DECLARED_SCOPE');
  assert.deepEqual(response.gaps, [{ fact_key: 'local.storage.retention', reason: 'missing' }]);
  assert.equal(response.coverage_gate.status, 'INSUFFICIENT');
  assert.deepEqual(response.coverage_gate.missing_facts, ['local.storage.retention']);
  assert.equal(anchorProbeResponseSchema.safeParse(response).success, true);
});

test('no entry at all is ENTRY_NOT_FOUND, not a silent empty result', () => {
  const response = probe(request({ required_facts: ['local.storage.engine'] }), new MemorySource([]), { now: AT });
  assert.equal(response.budget_status.stop_reason, 'ENTRY_NOT_FOUND');
  assert.equal(response.budget_status.retrieval_completeness, 'PARTIAL');
  assert.deepEqual(response.gaps, [{ fact_key: 'local.storage.engine', reason: 'missing' }]);
  assert.equal(anchorProbeResponseSchema.safeParse(response).success, true);
});

test('an empty declared scope is complete without inventing coverage', () => {
  const response = probe(request(), new MemorySource([]), { now: AT });
  assert.equal(response.budget_status.stop_reason, 'FRONTIER_EXHAUSTED');
  assert.equal(response.budget_status.retrieval_completeness, 'COMPLETE_WITHIN_DECLARED_SCOPE');
  assert.equal(response.coverage_gate.status, 'UNKNOWN');
  assert.equal(response.coverage_gate.requirements_origin, 'unknown');
});

test('the slow path broadens an unrouted dimension and stays visible', () => {
  const records = [candidate({ record_ref: 'r-a', fact_key: 'local.storage.engine' })];
  const response = probe(request(), new SlowPathSource(records), {
    entries: [{ fact_key: 'local.storage.engine' }],
    now: AT,
  });
  assert.equal(response.active_evidence.length, 1);
  assert.equal(response.budget_status.stop_reason, 'FRONTIER_EXHAUSTED');
  const routing = response.l1_invariants.find((item) => item.invariant_id === 'probe.entry_routing');
  assert.equal(routing?.status, 'unknown');
});

test('an index error is surfaced instead of masquerading as no hit', () => {
  const response = probe(request({ required_facts: ['local.storage.engine'] }), new MemorySource([], [], { throwOnQuery: true }), { now: AT });
  assert.equal(response.execution_status, 'DEGRADED');
  assert.equal(response.budget_status.stop_reason, 'ERROR');
  assert.equal(response.budget_status.retrieval_completeness, 'UNKNOWN');
  assert.equal(response.coverage_gate.status, 'UNKNOWN');
  assert.deepEqual(response.gaps, [{ fact_key: 'local.storage.engine', reason: 'unknown' }]);
  const surfaced = response.l1_invariants.find((item) => item.invariant_id === 'probe.index_errors_surfaced');
  assert.equal(surfaced?.status, 'violated');
  assert.equal(anchorProbeResponseSchema.safeParse(response).success, true);
});

test('a deadline stop is explicit TIMEOUT/PARTIAL', () => {
  const records = Array.from({ length: 3 }, (_, index) =>
    candidate({ record_ref: `r${index + 1}`, fact_key: index === 0 ? 'local.storage.engine' : null }));
  const edges = [edge('r1', 'r2'), edge('r2', 'r3')];
  const response = probe(
    request(),
    new MemorySource(records, edges),
    { entries: [{ fact_key: 'local.storage.engine' }], now: AT, deadlineMs: 0 },
  );
  assert.equal(response.budget_status.stop_reason, 'TIMEOUT');
  assert.equal(response.budget_status.retrieval_completeness, 'PARTIAL');
  assert.equal(anchorProbeResponseSchema.safeParse(response).success, true);
});

test('superseded and retracted records become tombstones', () => {
  const records = [
    candidate({ record_ref: 'r-live', fact_key: 'local.storage.engine' }),
    candidate({ record_ref: 'r-sup', status: 'superseded', superseded_by: 'r-live' }),
    candidate({ record_ref: 'r-ret', status: 'retracted' }),
  ];
  const response = probe(request(), new MemorySource(records), { entries: [{}], now: AT });
  assert.deepEqual(response.active_evidence.map((item) => item.record_ref), ['r-live']);
  assert.deepEqual(response.deprecated_tombstones.map((item) => item.record_ref), ['r-ret', 'r-sup']);
  const superseded = response.deprecated_tombstones.find((item) => item.record_ref === 'r-sup');
  assert.equal(superseded?.superseded_by, 'r-live');
  assert.equal(superseded?.status, 'superseded');
  assert.equal(response.deprecated_tombstones.find((item) => item.record_ref === 'r-ret')?.status, 'retracted');
});

test('aliases are source-prefixed, unique and stable for the same snapshot', () => {
  const records = [
    candidate({ record_ref: 'r-note', fact_key: 'local.storage.engine', source: { kind: 'native_note' } }),
    candidate({ record_ref: 'r-history', fact_key: 'local.storage.retention', source: { kind: 'history' } }),
    candidate({ record_ref: 'r-code', fact_key: 'local.storage.engine', source: { kind: 'code_read' }, content_hash: HASH_C }),
  ];
  const source = new MemorySource(records);
  const first = probe(request(), source, { entries: [{}], now: AT });
  const second = probe(request(), source, { entries: [{}], now: AT });
  assert.deepEqual(first, second);
  const refs = [...first.active_evidence, ...first.deprecated_tombstones].map((item) => item.ref);
  assert.equal(new Set(refs).size, refs.length);
  assert.ok(first.active_evidence.some((item) => item.ref.startsWith('E')));
  assert.ok(first.active_evidence.some((item) => item.ref.startsWith('H')));
  assert.ok(first.active_evidence.some((item) => item.ref.startsWith('I')));
  assert.equal(first.context_id, second.context_id);
});

test('input order does not change the frozen evidence set', () => {
  const records = [
    candidate({ record_ref: 'r-a', fact_key: 'local.storage.engine', recorded_at: AT }),
    candidate({ record_ref: 'r-b', fact_key: 'local.storage.retention', recorded_at: AT_LATER }),
    candidate({ record_ref: 'r-c', fact_key: 'local.storage.engine', recorded_at: AT, content_hash: HASH_C }),
  ];
  const forward = probe(
    request({ required_facts: ['local.storage.engine', 'local.storage.retention'] }),
    new MemorySource(records),
    { now: AT },
  );
  const reversed = probe(
    request({ required_facts: ['local.storage.engine', 'local.storage.retention'] }),
    new MemorySource([...records].reverse()),
    { now: AT },
  );
  assert.deepEqual(forward.active_evidence, reversed.active_evidence);
  assert.deepEqual(forward.deprecated_tombstones, reversed.deprecated_tombstones);
});

test('context identity includes normalized request rules even when evidence is unchanged', () => {
  const source = new MemorySource([]);
  const first = probe(request(), source, { now: AT });
  const explicitDefaults = probe(request({ budget: { ...anchorProbeDefaultBudget }, temporal_mode: 'CURRENT' }), source, { now: AT_LATER });
  assert.deepEqual(explicitDefaults, first);
  assert.equal(probe(request({ context_id: 'ctx-reuse' }), source, { now: AT }).context_id, first.context_id);
  for (const overrides of [
    { budget: { ...anchorProbeDefaultBudget, max_nodes: 20 } },
    { budget: { ...anchorProbeDefaultBudget, max_candidates: 20 } },
    { budget: { ...anchorProbeDefaultBudget, max_depth: 4 } },
    { root: 'F:/other-project' },
    { required_facts: ['local.storage.engine'] },
    { request_id: 'req-other' },
  ]) {
    assert.notEqual(probe(request(overrides), source, { now: AT }).context_id, first.context_id);
  }
  const asOf = probe(request({ temporal_mode: 'AS_OF', as_of: AT }), source, { now: AT });
  const laterAsOf = probe(request({ temporal_mode: 'AS_OF', as_of: AT_LATER }), source, { now: AT });
  assert.notEqual(asOf.context_id, first.context_id);
  assert.notEqual(laterAsOf.context_id, asOf.context_id);
});

test('CURRENT context identity changes at effective boundaries, not on every clock tick', () => {
  const source = new MemorySource([candidate({ record_ref: 'r-expiring', fact_key: 'local.storage.engine', effective_to: AT_LATER })]);
  const input = request({ required_facts: ['local.storage.engine'] });
  const first = probe(input, source, { now: AT });
  const sameMaterial = probe(input, source, { now: '2026-11-21T00:00:01.000Z' });
  assert.deepEqual(sameMaterial, first);
  const expired = probe(input, source, { now: AT_LATER });
  assert.equal(first.active_evidence.length, 1);
  assert.equal(expired.active_evidence.length, 0);
  assert.equal(expired.coverage_gate.status, 'INSUFFICIENT');
  assert.notEqual(expired.context_id, first.context_id);
});

test('context identity covers actual evidence, routing, failure and truncation material', () => {
  const records = [candidate({ record_ref: 'r-a', fact_key: 'local.storage.engine' }), candidate({ record_ref: 'r-b', fact_key: 'local.storage.retention' })];
  const source = new MemorySource(records);
  const first = probe(request(), source, { entries: [{}], now: AT });
  for (const options of [
    { entries: [{ fact_key: 'local.storage.engine' }], now: AT },
    { entries: [{}], now: AT, deadlineMs: 0 },
  ]) {
    assert.notEqual(probe(request(), source, options).context_id, first.context_id);
  }
  const changed = new MemorySource([candidate({ ...records[0]!, content: 'changed material', content_hash: HASH_C }), records[1]!]);
  assert.notEqual(probe(request(), changed, { entries: [{}], now: AT }).context_id, first.context_id);
  const degraded = probe(request(), new MemorySource([], [], { throwOnQuery: true }), { now: AT });
  const failed = probe(request(), {
    get snapshot(): AnchorProbeSnapshot { throw new Error('fixture snapshot failure'); },
    entries: () => [],
    edges: () => [],
  }, { now: AT });
  const empty = probe(request(), new MemorySource([]), { now: AT });
  assert.equal(degraded.execution_status, 'DEGRADED');
  assert.equal(failed.execution_status, 'FAILED');
  assert.equal(new Set([empty.context_id, degraded.context_id, failed.context_id]).size, 3);
});

test('a malformed request is rejected before any source read', () => {
  const source = new MemorySource([]);
  assert.throws(() => probe({ schema_version: ANCHOR_PROBE_REQUEST_SCHEMA_VERSION }, source), ProbeRequestError);
  assert.throws(() => probe(request({ temporal_mode: 'AS_OF' }), source), ProbeRequestError);
  assert.throws(() => probe(request({ extra: 1 }), source), ProbeRequestError);
});

test('every generated response satisfies the AP-02 response schema', () => {
  const records = [
    candidate({ record_ref: 'r-a', fact_key: 'local.storage.engine' }),
    candidate({ record_ref: 'r-b', fact_key: 'local.storage.retention', source: { kind: 'history' } }),
  ];
  const responses = [
    probe(request({ required_facts: ['local.storage.engine'] }), new MemorySource(records), { now: AT }),
    probe(request({ required_facts: ['local.storage.engine'] }), new MemorySource(records, [], { throwOnQuery: true }), { now: AT }),
    probe(request(), new MemorySource([]), { now: AT }),
    probe(request({ budget: { max_candidates: 1, max_nodes: 1, max_depth: 1 } }), new MemorySource(records), { now: AT }),
  ];
  for (const response of responses) {
    const parsed = anchorProbeResponseSchema.safeParse(response);
    assert.equal(parsed.success, true, JSON.stringify(response));
    assert.equal(response.schema_version, ANCHOR_PROBE_CONTEXT_SCHEMA_VERSION);
    assert.equal(response.untrusted, true);
  }
});
