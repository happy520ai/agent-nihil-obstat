/**
 * T-151 / QF-02 complete input x state x side-effect matrix for
 * `src/memory/probe-merge.ts`.
 *
 * Every case asserts an observable value or side effect (returned structure,
 * thrown error, mutated field, sorted order, digest text); no empty invocation
 * is used for coverage.
 *
 * T-153 follow-up (headers only; assertions unchanged): the former
 * `dedupeEdges` provenance tie-break was removed by the main-control cleanup
 * because the `(from,to,kind)` dedupe key makes it unreachable; this module is
 * expected at 100/100/100 after that cleanup. The remaining documented quirk is
 * asserted as-is: `injectDistributedConflicts` never drops a distinct conflict
 * id, so duplicate ids are appended verbatim while `unresolved_conflicts`
 * de-duplicates.
 *
 * Coverage map (scoped: distributed-probe.test.ts + this file):
 * - Reachable branches covered by the new cases:
 *   helpers:
 *     "compareStrings/uniqueSorted/message/fallbackSnapshot behave as pure helpers"
 *   gather/dedupe/conflicts/fingerprints:
 *     "gatherCandidates collapses exact repeats and merges their sources once per node",
 *     "gatherCandidates keeps status variants separate and reports a status conflict",
 *     "gatherCandidates reports content-hash conflicts and resolves fact_key only when unique",
 *     "assignConflictIds numbers conflicts from 1 and rewrites existing ids",
 *     "gatherCandidates dedupes edges and orders them deterministically"
 *   commit divergence:
 *     "commitConflicts reports commit and cluster-epoch divergence exactly"
 *   digest/query:
 *     "digestCandidates maps fingerprints exactly and omits null fact keys",
 *     "matchesEntryQuery honours all four optional fields in both directions",
 *     "consistencyFromResponse maps the four retrieval states"
 *   answer assembly:
 *     "assembleAnswer computes coverage for the zero, partial and clamped ranges",
 *     "assembleAnswer partialFlag is raised independently by each of its six inputs",
 *     "assembleAnswer outcome precedence is CANCELLED, FAILED, DEGRADED, consistency",
 *     "assembleAnswer metadata expands optional fields only when supplied and echoes the rest",
 *     "assembleAnswer records degraded=true without a reason by omitting the field"
 *   node reports / cancellation / fingerprints / injection:
 *     "nodeReports marks local, OK, failed and never-queried replicas distinctly",
 *     "cancelledResponse reuses a supplied snapshot and declared requirements",
 *     "cancelledResponse falls back to the zero snapshot and unknown origin when absent",
 *     "safeFingerprints collapses equal pairs keeping the first variant",
 *     "digestOrEmpty matches the detailed digest and falls back to empty on malformed input",
 *     "injectDistributedConflicts returns the identical response when nothing changes",
 *     "injectDistributedConflicts maps kinds, fact keys, refs and the 64-node cap",
 *     "injectDistributedConflicts de-duplicates unresolved ids but appends duplicate conflicts"
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ANCHOR_PROBE_CONTEXT_SCHEMA_VERSION,
  ANCHOR_PROBE_REQUEST_SCHEMA_VERSION,
  PROBE_EVIDENCE_DIGEST_MAX_RECORDS,
  anchorProbeResponseSchema,
  computeEvidenceDigestDetailed,
  type AnchorProbeConflict,
  type AnchorProbeRequest,
  type AnchorProbeResponse,
  type AnchorProbeSnapshot,
} from '../../src/memory/probe-contract.ts';
import {
  DEDUPE_SEPARATOR,
  assembleAnswer,
  assignConflictIds,
  cancelledResponse,
  commitConflicts,
  compareStrings,
  consistencyFromResponse,
  digestCandidates,
  digestOrEmpty,
  fallbackSnapshot,
  gatherCandidates,
  injectDistributedConflicts,
  matchesEntryQuery,
  message,
  nodeReports,
  safeFingerprints,
  uniqueSorted,
  type NodeInfo,
  type NodeOutcome,
  type NodeSuccess,
} from '../../src/memory/probe-merge.ts';
import type {
  DistributedCandidateFingerprint,
  DistributedProbeConflict,
} from '../../src/memory/distributed-probe.ts';
import type { ProbeCandidate, ProbeEdge, ProbeEntryQuery } from '../../src/memory/probe.ts';

const HASH = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);
const AT = '2026-11-25T00:00:00.000Z';
const EMPTY_DIGEST = computeEvidenceDigestDetailed([]).digest;

function makeSnapshot(overrides: Partial<AnchorProbeSnapshot> = {}): AnchorProbeSnapshot {
  return {
    project_scope: 'proj',
    ledger_digest: HASH,
    graph_revision: null,
    source_fingerprint: HASH_B,
    connected_digest: null,
    ...overrides,
  };
}

function makeRequest(overrides: Partial<AnchorProbeRequest> = {}): AnchorProbeRequest {
  return {
    schema_version: ANCHOR_PROBE_REQUEST_SCHEMA_VERSION,
    request_id: 'req-1',
    root: 'F:/project',
    project_scope: 'proj',
    temporal_mode: 'CURRENT',
    budget: { max_candidates: 16, max_nodes: 12, max_depth: 3 },
    ...overrides,
  };
}

function makeResponse(overrides: Record<string, unknown> = {}): AnchorProbeResponse {
  const base: AnchorProbeResponse = {
    schema_version: ANCHOR_PROBE_CONTEXT_SCHEMA_VERSION,
    request_id: 'req-1',
    context_id: 'ctx-1',
    snapshot: makeSnapshot(),
    execution_status: 'OK',
    temporal_mode: 'CURRENT',
    budget_status: {
      stop_reason: 'FRONTIER_EXHAUSTED',
      retrieval_completeness: 'COMPLETE_WITHIN_DECLARED_SCOPE',
      nodes_visited: 1,
      frontier_remaining: 0,
    },
    coverage_gate: {
      status: 'SUFFICIENT',
      required_facts: [],
      missing_facts: [],
      unresolved_conflicts: [],
      requirements_origin: 'unknown',
    },
    l1_invariants: [],
    active_evidence: [],
    deprecated_tombstones: [],
    gaps: [],
    conflicts: [],
    untrusted: true,
  };
  return { ...base, ...overrides } as AnchorProbeResponse;
}

function candidate(overrides: Partial<ProbeCandidate> & { record_ref: string }): ProbeCandidate {
  return {
    fact_key: 'local.storage.engine',
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

function success(id: string, candidates: readonly ProbeCandidate[] = [], overrides: Partial<NodeSuccess> = {}): NodeSuccess {
  return {
    id,
    snapshot: makeSnapshot(),
    candidates,
    edges: [],
    commitIndex: 10,
    digest: HASH,
    viewDigest: null,
    state: 'ACTIVE',
    epoch: 'epoch-1',
    latencyMs: 0,
    ...overrides,
  };
}

function conflict(overrides: Partial<DistributedProbeConflict> & { conflict_id: string }): DistributedProbeConflict {
  return {
    kind: 'content_hash',
    fact_key: null,
    record_ref: null,
    nodes: [],
    content_hashes: [],
    statuses: [],
    commits: [],
    epochs: [],
    status: 'unresolved',
    ...overrides,
  };
}

function anchorConflict(conflictId: string): AnchorProbeConflict {
  return { conflict_id: conflictId, fact_key: 'local.x', record_refs: ['r1'], status: 'unresolved' };
}

function assembleInput(overrides: Record<string, unknown> = {}): Parameters<typeof assembleAnswer>[0] {
  const base: Parameters<typeof assembleAnswer>[0] = {
    request: makeRequest(),
    response: makeResponse(),
    candidates: [],
    conflicts: [],
    failedNodes: [],
    nodeReports: [],
    mode: 'QUORUM',
    requestedMode: 'QUORUM',
    consistency: 'CONSISTENT',
    degraded: false,
    stopReason: 'NONE',
    origin: 'replica',
    evidenceDigest: HASH,
    clusterEpoch: 'epoch-1',
    quorumSize: 2,
    quorumCount: 2,
    quorumDigests: [HASH],
    stale: false,
    historical: false,
    maxLag: null,
    considered: 0,
    requested: 0,
    gaps: [],
    elapsedMs: 5,
    resourcesReleased: true,
  };
  return { ...base, ...overrides } as Parameters<typeof assembleAnswer>[0];
}

// ---------------------------------------------------------------------------
// Small value helpers
// ---------------------------------------------------------------------------

test('compareStrings/uniqueSorted/message/fallbackSnapshot behave as pure helpers', () => {
  assert.equal(compareStrings('a', 'b'), -1);
  assert.equal(compareStrings('b', 'a'), 1);
  assert.equal(compareStrings('a', 'a'), 0);

  assert.deepEqual(uniqueSorted(['b', 'a', 'b', 'c', 'a']), ['a', 'b', 'c']);
  assert.deepEqual(uniqueSorted([]), []);

  assert.equal(message(new Error('boom')), 'boom');
  assert.equal(message('plain'), 'plain');
  assert.equal(message(42), '42');
  assert.equal(message(null), 'null');

  const request = makeRequest();
  const fallback = fallbackSnapshot(request);
  assert.deepEqual(fallback, {
    project_scope: 'proj',
    ledger_digest: '0'.repeat(64),
    graph_revision: null,
    source_fingerprint: null,
    connected_digest: null,
  });
  fallback.ledger_digest = HASH_C;
  assert.equal(fallbackSnapshot(request).ledger_digest, '0'.repeat(64), 'fallbacks are fresh copies');
});

// ---------------------------------------------------------------------------
// gatherCandidates
// ---------------------------------------------------------------------------

test('gatherCandidates collapses exact repeats and merges their sources once per node', () => {
  const shared = candidate({ record_ref: 'r-a', content_hash: HASH, fact_key: 'local.a' });
  const result = gatherCandidates([
    success('s1', [shared, shared]),
    success('s2', [shared]),
  ]);

  assert.equal(result.merged.length, 1);
  assert.equal(result.requested, 1, 'requested counts distinct (record_ref, content_hash)');
  assert.equal(result.considered, 1);
  assert.deepEqual(result.fingerprints.map((fingerprint) => fingerprint.sources), [['s1', 's2']]);
  assert.deepEqual(result.conflicts, []);
  assert.equal(DEDUPE_SEPARATOR, '\u0000');
});

test('gatherCandidates keeps status variants separate and reports a status conflict', () => {
  const active = candidate({ record_ref: 'r-s', content_hash: HASH, fact_key: 'local.s', status: 'active' });
  const retracted = candidate({ record_ref: 'r-s', content_hash: HASH, fact_key: 'local.s', status: 'retracted' });
  const result = gatherCandidates([
    success('s1', [active]),
    success('s2', [retracted]),
  ]);

  assert.equal(result.merged.length, 2, 'the dedupe key includes status for fact semantics');
  assert.equal(result.requested, 1);
  assert.equal(result.considered, 2);
  assert.equal(result.fingerprints.length, 1);
  assert.deepEqual(result.fingerprints[0]!.sources, ['s1', 's2']);

  const statusConflict = result.conflicts.find((entry) => entry.kind === 'status');
  assert.ok(statusConflict !== undefined);
  assert.equal(statusConflict!.record_ref, 'r-s');
  assert.deepEqual(statusConflict!.statuses, ['active', 'retracted']);
  assert.equal(statusConflict!.status, 'unresolved');
  assert.equal(result.conflicts.some((entry) => entry.kind === 'content_hash'), false);
});

test('gatherCandidates reports content-hash conflicts and resolves fact_key only when unique', () => {
  const left = candidate({ record_ref: 'r-x', content_hash: HASH_C, fact_key: 'local.x' });
  const right = candidate({ record_ref: 'r-x', content_hash: HASH_D, fact_key: 'local.x' });
  const result = gatherCandidates([success('s1', [left]), success('s2', [right])]);

  const hashConflict = result.conflicts.find((entry) => entry.kind === 'content_hash');
  assert.ok(hashConflict !== undefined);
  assert.deepEqual(hashConflict!.content_hashes, [HASH_C, HASH_D]);
  assert.equal(hashConflict!.fact_key, 'local.x');
  assert.deepEqual(hashConflict!.nodes, ['s1', 's2']);

  // All fact keys null -> null.
  const nullKeys = gatherCandidates([
    success('s1', [candidate({ record_ref: 'r-n', content_hash: HASH_C, fact_key: null })]),
    success('s2', [candidate({ record_ref: 'r-n', content_hash: HASH_D, fact_key: null })]),
  ]);
  assert.equal(nullKeys.conflicts.find((entry) => entry.kind === 'content_hash')!.fact_key, null);

  // Two distinct fact keys -> null (no winner is fabricated).
  const splitKeys = gatherCandidates([
    success('s1', [candidate({ record_ref: 'r-m', content_hash: HASH_C, fact_key: 'local.m1' })]),
    success('s2', [candidate({ record_ref: 'r-m', content_hash: HASH_D, fact_key: 'local.m2' })]),
  ]);
  assert.equal(splitKeys.conflicts.find((entry) => entry.kind === 'content_hash')!.fact_key, null);

  // Multiple conflicting record_refs are emitted in deterministic ref order.
  const ordered = gatherCandidates([
    success('s1', [
      candidate({ record_ref: 'r-b', content_hash: HASH_C, fact_key: 'local.b' }),
      candidate({ record_ref: 'r-a', content_hash: HASH_C, fact_key: 'local.a' }),
    ]),
    success('s2', [
      candidate({ record_ref: 'r-b', content_hash: HASH_D, fact_key: 'local.b' }),
      candidate({ record_ref: 'r-a', content_hash: HASH_D, fact_key: 'local.a' }),
    ]),
  ]);
  assert.deepEqual(
    ordered.conflicts.map((entry) => entry.record_ref),
    ['r-a', 'r-b'],
  );
});

test('assignConflictIds numbers conflicts from 1 and rewrites existing ids', () => {
  assert.deepEqual(assignConflictIds([]), []);
  const assigned = assignConflictIds([conflict({ conflict_id: '' }), conflict({ conflict_id: 'old' })]);
  assert.deepEqual(assigned.map((entry) => entry.conflict_id), ['dist-conflict-1', 'dist-conflict-2']);
});

test('gatherCandidates dedupes edges and orders them deterministically', () => {
  const edge = (from: string, to: string, kind: ProbeEdge['kind'], provenance: ProbeEdge['provenance']): ProbeEdge =>
    ({ from, to, kind, provenance });
  const result = gatherCandidates([
    success('s1', [], {
      edges: [
        edge('r-b', 'r-c', 'related_to', 'heuristic'),
        edge('r-a', 'r-b', 'related_to', 'confirmed'),
        edge('r-a', 'r-c', 'related_to', 'confirmed'),
      ],
    }),
    success('s2', [], { edges: [edge('r-b', 'r-c', 'related_to', 'confirmed'), edge('r-a', 'r-b', 'depends_on', 'unknown')] }),
  ]);

  // The repeated (from,to,kind) is dropped; remaining edges sort by from, then
  // to, then kind. Provenance is preserved verbatim on the surviving first copy.
  assert.deepEqual(
    result.edges.map((entry) => `${entry.from}->${entry.to}:${entry.kind}`),
    ['r-a->r-b:depends_on', 'r-a->r-b:related_to', 'r-a->r-c:related_to', 'r-b->r-c:related_to'],
  );
  assert.equal(result.edges[3]!.provenance, 'heuristic', 'first surviving copy wins');
});

// ---------------------------------------------------------------------------
// commitConflicts
// ---------------------------------------------------------------------------

test('commitConflicts reports commit and cluster-epoch divergence exactly', () => {
  assert.deepEqual(commitConflicts([]), []);
  assert.deepEqual(commitConflicts([success('s1')]), []);
  assert.deepEqual(commitConflicts([success('s1'), success('s2', [], { commitIndex: 10, epoch: 'epoch-1' })]), []);

  const commits = commitConflicts([
    success('s2', [], { commitIndex: 10 }),
    success('s1', [], { commitIndex: 9 }),
  ]);
  assert.equal(commits.length, 1);
  assert.equal(commits[0]!.kind, 'commit');
  assert.equal(commits[0]!.fact_key, 'distributed.commit');
  assert.equal(commits[0]!.record_ref, null);
  assert.deepEqual(commits[0]!.commits, [9, 10]);
  assert.deepEqual(commits[0]!.nodes, ['s1', 's2']);

  const epochs = commitConflicts([
    success('s1', [], { epoch: 'epoch-a' }),
    success('s2', [], { epoch: 'epoch-b' }),
  ]);
  assert.equal(epochs.length, 1);
  assert.equal(epochs[0]!.kind, 'cluster_epoch');
  assert.equal(epochs[0]!.fact_key, 'distributed.cluster_epoch');
  assert.deepEqual(epochs[0]!.epochs, ['epoch-a', 'epoch-b']);

  // Numeric 1 and string '1' denote the same epoch text: no divergence.
  assert.deepEqual(commitConflicts([success('s1', [], { epoch: 1 }), success('s2', [], { epoch: '1' })]), []);

  const both = commitConflicts([
    success('s1', [], { commitIndex: 9, epoch: 'epoch-a' }),
    success('s2', [], { commitIndex: 10, epoch: 'epoch-b' }),
  ]);
  assert.deepEqual(both.map((entry) => entry.kind), ['commit', 'cluster_epoch']);
});

// ---------------------------------------------------------------------------
// Digest / query helpers
// ---------------------------------------------------------------------------

test('digestCandidates maps fingerprints exactly and omits null fact keys', () => {
  const candidates = [
    candidate({ record_ref: 'r1', content_hash: HASH, fact_key: 'local.a', status: 'active' }),
    candidate({ record_ref: 'r2', content_hash: HASH_B, fact_key: null, status: 'retracted' }),
  ];
  const expected = computeEvidenceDigestDetailed(
    [
      { record_ref: 'r1', content_hash: HASH, fact_key: 'local.a', status: 'active' },
      { record_ref: 'r2', content_hash: HASH_B, status: 'retracted' },
    ],
    { limit: PROBE_EVIDENCE_DIGEST_MAX_RECORDS, allowTruncation: true },
  ).digest;
  assert.equal(digestCandidates(candidates), expected);
  // The digest is order-independent because the helper sorts fingerprints.
  const reversed = digestCandidates([...candidates].reverse());
  assert.equal(reversed, expected);
  const withFactKey = digestCandidates([
    candidate({ record_ref: 'r1', content_hash: HASH, fact_key: null, status: 'active' }),
    ...candidates.slice(1),
  ]);
  assert.notEqual(withFactKey, expected, 'fact_key presence changes the fingerprint set');
});

test('matchesEntryQuery honours all four optional fields in both directions', () => {
  const record = candidate({
    record_ref: 'r1',
    fact_key: 'local.a',
    task_id: 'task-1',
    file: 'F:/p/a.ts',
    symbol: 'alpha',
  });
  assert.equal(matchesEntryQuery(record, {}), true);
  assert.equal(matchesEntryQuery(record, { fact_key: 'local.a' }), true);
  assert.equal(matchesEntryQuery(record, { fact_key: 'local.b' }), false);
  assert.equal(matchesEntryQuery(record, { task_id: 'task-1' }), true);
  assert.equal(matchesEntryQuery(record, { task_id: 'task-2' }), false);
  assert.equal(matchesEntryQuery(record, { file: 'F:/p/a.ts' }), true);
  assert.equal(matchesEntryQuery(record, { file: 'F:/p/b.ts' }), false);
  assert.equal(matchesEntryQuery(record, { symbol: 'alpha' }), true);
  assert.equal(matchesEntryQuery(record, { symbol: 'beta' }), false);
  assert.equal(
    matchesEntryQuery(record, { fact_key: 'local.a', task_id: 'task-1', file: 'F:/p/a.ts', symbol: 'alpha' }),
    true,
  );
  assert.equal(
    matchesEntryQuery(record, { fact_key: 'local.a', task_id: 'task-1', file: 'F:/p/a.ts', symbol: 'beta' }),
    false,
  );

  // Empty/undefined query objects are wildcards.
  const emptyQuery: ProbeEntryQuery = {};
  assert.equal(matchesEntryQuery(record, emptyQuery), true);
});

test('consistencyFromResponse maps the four retrieval states', () => {
  assert.equal(consistencyFromResponse(makeResponse({ execution_status: 'FAILED' })), 'UNKNOWN');
  assert.equal(
    consistencyFromResponse(makeResponse({
      budget_status: { stop_reason: 'FRONTIER_EXHAUSTED', retrieval_completeness: 'COMPLETE_WITHIN_DECLARED_SCOPE', nodes_visited: 1, frontier_remaining: 0 },
    })),
    'CONSISTENT',
  );
  assert.equal(
    consistencyFromResponse(makeResponse({
      budget_status: { stop_reason: 'ERROR', retrieval_completeness: 'UNKNOWN', nodes_visited: 0, frontier_remaining: 0 },
    })),
    'UNKNOWN',
  );
  assert.equal(
    consistencyFromResponse(makeResponse({
      budget_status: { stop_reason: 'DEPTH_LIMIT', retrieval_completeness: 'PARTIAL', nodes_visited: 1, frontier_remaining: 2 },
    })),
    'PARTIAL',
  );
});

// ---------------------------------------------------------------------------
// assembleAnswer
// ---------------------------------------------------------------------------

test('assembleAnswer computes coverage for the zero, partial and clamped ranges', () => {
  assert.equal(assembleAnswer(assembleInput({ requested: 0, considered: 0 })).partial.coverage, 0);
  const oneOfZero = assembleAnswer(assembleInput({ requested: 0, considered: 2 }));
  assert.equal(oneOfZero.partial.coverage, 1);
  const half = assembleAnswer(assembleInput({ requested: 4, considered: 2 }));
  assert.equal(half.partial.coverage, 0.5);
  const clamped = assembleAnswer(assembleInput({ requested: 2, considered: 5 }));
  assert.equal(clamped.partial.coverage, 1);
  assert.deepEqual(clamped.partial, {
    coverage: 1,
    considered: 5,
    requested: 2,
    gaps: [],
    failed_nodes: [],
    stop_reason: 'NONE',
  });
});

test('assembleAnswer partialFlag is raised independently by each of its six inputs', () => {
  const run = (overrides: Record<string, unknown>): boolean => assembleAnswer(assembleInput(overrides)).metadata.partial;

  assert.equal(run({}), false, 'clean input is not partial');
  assert.equal(run({ degraded: true }), true);
  assert.equal(run({ failedNodes: ['r1'] }), true);
  assert.equal(run({ conflicts: [conflict({ conflict_id: 'c1' })] }), true);
  assert.equal(run({ stopReason: 'TIMEOUT' }), true);
  assert.equal(run({ response: makeResponse({ execution_status: 'DEGRADED' }) }), true);
  assert.equal(
    run({
      response: makeResponse({
        budget_status: { stop_reason: 'DEPTH_LIMIT', retrieval_completeness: 'PARTIAL', nodes_visited: 1, frontier_remaining: 1 },
      }),
    }),
    true,
  );
});

test('assembleAnswer outcome precedence is CANCELLED, FAILED, DEGRADED, consistency', () => {
  const cancelled = assembleAnswer(assembleInput({
    stopReason: 'CANCELLED',
    response: makeResponse({ execution_status: 'FAILED' }),
    consistency: 'DEGRADED',
  }));
  assert.equal(cancelled.outcome, 'CANCELLED');

  const failed = assembleAnswer(assembleInput({
    response: makeResponse({ execution_status: 'FAILED' }),
    consistency: 'DEGRADED',
  }));
  assert.equal(failed.outcome, 'FAILED');

  const degraded = assembleAnswer(assembleInput({ consistency: 'DEGRADED' }));
  assert.equal(degraded.outcome, 'PARTIAL');

  const unknown = assembleAnswer(assembleInput({ consistency: 'UNKNOWN' }));
  assert.equal(unknown.outcome, 'UNKNOWN');

  const consistent = assembleAnswer(assembleInput({ consistency: 'CONSISTENT' }));
  assert.equal(consistent.outcome, 'CONSISTENT');
});

test('assembleAnswer metadata expands optional fields only when supplied and echoes the rest', () => {
  const minimal = assembleAnswer(assembleInput());
  assert.equal('commit_index' in minimal.metadata, false);
  assert.equal('primary_commit_index' in minimal.metadata, false);
  assert.equal('degradation_reason' in minimal.metadata, false);
  assert.equal(minimal.metadata.degraded, false);
  assert.equal(minimal.metadata.partial, false);
  assert.equal(minimal.metadata.stop_reason, 'NONE');

  const full = assembleAnswer(assembleInput({
    commitIndex: 7,
    primaryCommitIndex: 6,
    degraded: true,
    degradationReason: 'QUORUM_UNMET',
    stale: true,
    historical: true,
    maxLag: 3,
    quorumSize: 3,
    quorumCount: 2,
    quorumDigests: [HASH, HASH_B],
    clusterEpoch: 9,
    elapsedMs: 12,
    resourcesReleased: false,
    candidates: [],
    conflicts: [conflict({ conflict_id: 'c9' })],
    failedNodes: ['r1'],
    nodeReports: [],
    gaps: ['committed:10'],
  }));
  assert.equal(full.metadata.commit_index, 7);
  assert.equal(full.metadata.primary_commit_index, 6);
  assert.equal(full.metadata.degradation_reason, 'QUORUM_UNMET');
  assert.equal(full.metadata.stale, true);
  assert.equal(full.metadata.historical, true);
  assert.equal(full.metadata.max_lag, 3);
  assert.equal(full.metadata.quorum_size, 3);
  assert.equal(full.metadata.quorum_count, 2);
  assert.deepEqual(full.metadata.quorum_digests, [HASH, HASH_B]);
  assert.equal(full.metadata.cluster_epoch, 9);
  assert.equal(full.elapsed_ms, 12);
  assert.equal(full.resources_released, false);
  assert.deepEqual(full.conflicts.map((entry) => entry.conflict_id), ['c9']);
  assert.deepEqual(full.partial.gaps, ['committed:10']);
  assert.deepEqual(full.partial.failed_nodes, ['r1']);
  assert.equal(full.request_id, 'req-1');
  assert.equal(full.response.execution_status, 'OK');
});

test('assembleAnswer records degraded=true without a reason by omitting the field', () => {
  const answer = assembleAnswer(assembleInput({ degraded: true }));
  assert.equal(answer.metadata.degraded, true);
  assert.equal('degradation_reason' in answer.metadata, false);
});

// ---------------------------------------------------------------------------
// nodeReports
// ---------------------------------------------------------------------------

test('nodeReports marks local, OK, failed and never-queried replicas distinctly', () => {
  const ok = success('r1', [], { commitIndex: 11, digest: HASH_C, latencyMs: 4, state: 'LAGGING' });
  const failure = {
    status: 'failed' as const,
    failure: { id: 'r2', code: 'NODE_UNAVAILABLE' as const, detail: 'gone', latencyMs: 9 },
  };
  const outcomes: readonly NodeOutcome[] = [
    { status: 'ok', success: ok },
    failure,
  ];
  const infos: readonly NodeInfo[] = [
    { node: {} as never, id: 'r1' },
    { node: {} as never, id: 'r2' },
    { node: {} as never, id: 'r3' },
  ];

  const reports = nodeReports(infos, outcomes, new Set(['r1']), {
    outcome: 'OK',
    detail: 'local ok',
    used: true,
  });
  assert.equal(reports.length, 4);
  assert.deepEqual(reports[0], {
    replica_id: 'local',
    outcome: 'OK',
    commit_index: null,
    evidence_digest: null,
    latency_ms: 0,
    detail: 'local ok',
    used: true,
  });

  assert.deepEqual(reports[1], {
    replica_id: 'r1',
    outcome: 'OK',
    commit_index: 11,
    evidence_digest: HASH_C,
    latency_ms: 4,
    detail: 'commit=11 state=LAGGING',
    used: true,
  });
  assert.deepEqual(reports[2], {
    replica_id: 'r2',
    outcome: 'NODE_UNAVAILABLE',
    commit_index: null,
    evidence_digest: null,
    latency_ms: 9,
    detail: 'gone',
    used: false,
  });
  assert.deepEqual(reports[3], {
    replica_id: 'r3',
    outcome: 'NOT_QUERIED',
    commit_index: null,
    evidence_digest: null,
    latency_ms: 0,
    detail: 'node was not queried',
    used: false,
  });

  const unused = nodeReports([], [], new Set(), { outcome: 'SCOPE_DENIED', detail: 'denied', used: false });
  assert.equal(unused[0]!.used, false);
  assert.equal(unused[0]!.detail, 'denied');
});

// ---------------------------------------------------------------------------
// cancelledResponse
// ---------------------------------------------------------------------------

test('cancelledResponse reuses a supplied snapshot and declared requirements', () => {
  const request = makeRequest({ required_facts: ['local.a', 'local.b'] });
  const snapshot = makeSnapshot({ ledger_digest: HASH_C });
  const response = cancelledResponse(request, snapshot);

  assert.equal(response.snapshot, snapshot);
  assert.equal(response.execution_status, 'FAILED');
  assert.equal(response.budget_status.retrieval_completeness, 'UNKNOWN');
  assert.equal(response.budget_status.stop_reason, 'ERROR');
  assert.deepEqual(response.coverage_gate.required_facts, ['local.a', 'local.b']);
  assert.equal(response.coverage_gate.requirements_origin, 'caller_declared');
  assert.equal(response.untrusted, true);
  assert.deepEqual(response.l1_invariants, [{
    invariant_id: 'probe.execution',
    status: 'violated',
    detail: 'distributed probe cancelled by caller',
  }]);

  const parsed = anchorProbeResponseSchema.safeParse(response);
  assert.equal(parsed.success, true, JSON.stringify(parsed));
  assert.equal(cancelledResponse(request, snapshot).context_id, response.context_id);
});

test('cancelledResponse falls back to the zero snapshot and unknown origin when absent', () => {
  const request = makeRequest();
  const response = cancelledResponse(request, null);
  assert.deepEqual(response.snapshot, fallbackSnapshot(request));
  assert.deepEqual(response.coverage_gate.required_facts, []);
  assert.equal(response.coverage_gate.requirements_origin, 'unknown');

  const other = cancelledResponse(request, makeSnapshot({ ledger_digest: HASH_D }));
  assert.notEqual(other.context_id, response.context_id, 'context id binds to the snapshot');
});

// ---------------------------------------------------------------------------
// Fingerprint helpers
// ---------------------------------------------------------------------------

test('safeFingerprints collapses equal pairs keeping the first variant', () => {
  const fingerprints = safeFingerprints([
    candidate({ record_ref: 'r1', content_hash: HASH_D, status: 'active', fact_key: 'local.a' }),
    candidate({ record_ref: 'r1', content_hash: HASH_C, status: 'active', fact_key: 'local.a' }),
    candidate({ record_ref: 'r1', content_hash: HASH, status: 'superseded', fact_key: 'local.a' }),
    candidate({ record_ref: 'r0', content_hash: HASH_B, status: 'retracted', fact_key: null }),
  ]);
  assert.equal(fingerprints.length, 4);
  assert.deepEqual(
    fingerprints.map((fingerprint) => [fingerprint.record_ref, fingerprint.content_hash]),
    [
      ['r0', HASH_B],
      ['r1', HASH],
      ['r1', HASH_C],
      ['r1', HASH_D],
    ],
  );
  assert.deepEqual(fingerprints[1], {
    record_ref: 'r1',
    content_hash: HASH,
    fact_key: 'local.a',
    status: 'superseded',
    sources: ['local'],
  });
});

test('digestOrEmpty matches the detailed digest and falls back to empty on malformed input', () => {
  const fingerprints: readonly DistributedCandidateFingerprint[] = [
    { record_ref: 'r1', content_hash: HASH, fact_key: 'local.a', status: 'active', sources: ['local'] },
    { record_ref: 'r2', content_hash: HASH_B, fact_key: null, status: 'retracted', sources: ['replica'] },
  ];
  const expected = computeEvidenceDigestDetailed(
    [
      { record_ref: 'r1', content_hash: HASH, fact_key: 'local.a', status: 'active' },
      { record_ref: 'r2', content_hash: HASH_B, status: 'retracted' },
    ],
    { limit: PROBE_EVIDENCE_DIGEST_MAX_RECORDS, allowTruncation: true },
  ).digest;
  assert.equal(digestOrEmpty(fingerprints), expected);
  assert.equal(digestOrEmpty([]), EMPTY_DIGEST);

  const malformed = [{ record_ref: 'r1', content_hash: 'not-a-hash', fact_key: null, status: 'active', sources: [] }] as never;
  assert.equal(digestOrEmpty(malformed), EMPTY_DIGEST, 'malformed input fails closed to the empty digest');

  const mixed = [fingerprints[0]!, { record_ref: 'r3', content_hash: 'bad', fact_key: null, status: 'active', sources: [] }] as never;
  assert.equal(digestOrEmpty(mixed), EMPTY_DIGEST, 'one malformed entry discards the whole batch');
});

// ---------------------------------------------------------------------------
// injectDistributedConflicts
// ---------------------------------------------------------------------------

test('injectDistributedConflicts returns the identical response when nothing changes', () => {
  const response = makeResponse();
  assert.equal(injectDistributedConflicts(response, []), response);

  const alreadyKnown = makeResponse({ conflicts: [anchorConflict('c1')] });
  assert.equal(injectDistributedConflicts(alreadyKnown, [conflict({ conflict_id: 'c1' })]), alreadyKnown);
});

test('injectDistributedConflicts maps kinds, fact keys, refs and the 64-node cap', () => {
  const response = makeResponse();
  const conflicts = [
    conflict({ conflict_id: 'c1', kind: 'content_hash', fact_key: 'local.a', record_ref: 'r1', nodes: ['n1'] }),
    conflict({ conflict_id: 'c2', kind: 'commit', fact_key: null, record_ref: null, nodes: ['n1', 'n2'] }),
    conflict({ conflict_id: 'c3', kind: 'cluster_epoch', fact_key: null, record_ref: null, nodes: [] }),
    conflict({
      conflict_id: 'c4',
      kind: 'status',
      fact_key: null,
      record_ref: null,
      nodes: Array.from({ length: 65 }, (_, index) => `n${String(index)}`),
    }),
  ];

  const injected = injectDistributedConflicts(response, conflicts);
  assert.notEqual(injected, response);
  assert.equal(injected.coverage_gate.status, 'INSUFFICIENT', 'SUFFICIENT cannot survive an unresolved conflict');
  assert.deepEqual(injected.coverage_gate.unresolved_conflicts, ['c1', 'c2', 'c3', 'c4']);
  assert.deepEqual(injected.conflicts.map((entry) => entry.conflict_id), ['c1', 'c2', 'c3', 'c4']);
  assert.deepEqual(injected.conflicts.map((entry) => entry.fact_key), [
    'local.a',
    'distributed.commit',
    'distributed.cluster_epoch',
    'distributed.record',
  ]);
  assert.deepEqual(injected.conflicts[0]!.record_refs, ['r1']);
  assert.deepEqual(injected.conflicts[1]!.record_refs, ['n1', 'n2']);
  assert.deepEqual(injected.conflicts[2]!.record_refs, ['distributed']);
  assert.equal(injected.conflicts[3]!.record_refs.length, 64, 'refs are capped at 64 nodes');
  for (const entry of injected.conflicts) {
    assert.equal(entry.status, 'unresolved');
  }

  // A non-SUFFICIENT gate keeps its own status.
  const alreadyInsufficient = makeResponse({
    coverage_gate: { status: 'INSUFFICIENT', required_facts: [], missing_facts: [], unresolved_conflicts: [], requirements_origin: 'unknown' },
  });
  const kept = injectDistributedConflicts(alreadyInsufficient, [conflict({ conflict_id: 'c9' })]);
  assert.equal(kept.coverage_gate.status, 'INSUFFICIENT');
  assert.equal(kept.execution_status, 'OK');
});

test('injectDistributedConflicts de-duplicates unresolved ids but appends duplicate conflicts', () => {
  const response = makeResponse();
  const injected = injectDistributedConflicts(response, [
    conflict({ conflict_id: 'dup' }),
    conflict({ conflict_id: 'dup' }),
  ]);
  assert.equal(injected.conflicts.length, 2, 'distinct input objects are appended even with a shared id');
  assert.deepEqual(injected.coverage_gate.unresolved_conflicts, ['dup']);
});
