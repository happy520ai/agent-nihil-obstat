import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { canonicalJson } from '../../src/ledger/event.ts';
import { probeSnapshotIdentity } from '../../src/memory/probe-store.ts';
import {
  ANCHOR_PROBE_CLUSTER_SCHEMA_VERSION,
  ANCHOR_PROBE_CONTEXT_SCHEMA_VERSION,
  ANCHOR_PROBE_REQUEST_SCHEMA_VERSION,
  PROBE_EVIDENCE_DIGEST_MAX_RECORDS,
  ProbeContractError,
  anchorProbeClusterMetadataSchema,
  anchorProbeDefaultBudget,
  anchorProbeJsonSchemas,
  anchorProbeRequestSchema,
  anchorProbeResponseSchema,
  assertClusterEpochMatch,
  assertClusterPartialConsistency,
  assertClusterProjectScope,
  computeEvidenceDigest,
  computeEvidenceDigestDetailed,
  isClusterPartialConsistent,
  legacySnapshotClusterMetadata,
  type ProbeEvidenceFingerprint,
} from '../../src/memory/probe-contract.ts';

const HASH = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const AT = '2026-11-21T00:00:00.000Z';

interface EvidenceShape {
  ref: string;
  record_ref: string;
  content_hash: string;
  status: string;
  source_health: string;
  recorded_at: string;
  effective_from: string | null;
  source: { kind: string; path?: string };
  content: string;
}

interface ResponseShape {
  schema_version: string;
  request_id: string;
  context_id: string;
  snapshot: {
    project_scope: string;
    ledger_digest: string;
    graph_revision: string | null;
    source_fingerprint: string | null;
    connected_digest: string | null;
  };
  execution_status: string;
  temporal_mode: string;
  budget_status: {
    stop_reason: string;
    retrieval_completeness: string;
    nodes_visited: number;
    frontier_remaining: number;
  };
  coverage_gate: {
    status: string;
    required_facts: string[];
    missing_facts: string[];
    unresolved_conflicts: string[];
    requirements_origin: string;
  };
  l1_invariants: Array<Record<string, unknown>>;
  active_evidence: EvidenceShape[];
  deprecated_tombstones: Array<Record<string, unknown>>;
  gaps: Array<Record<string, unknown>>;
  conflicts: Array<Record<string, unknown>>;
  untrusted: boolean;
}

function validResponse(): ResponseShape {
  return {
    schema_version: ANCHOR_PROBE_CONTEXT_SCHEMA_VERSION,
    request_id: 'req-1',
    context_id: 'ctx-1',
    snapshot: {
      project_scope: 'proj',
      ledger_digest: HASH,
      graph_revision: null,
      source_fingerprint: HASH_B,
      connected_digest: null,
    },
    execution_status: 'OK',
    temporal_mode: 'CURRENT',
    budget_status: {
      stop_reason: 'FRONTIER_EXHAUSTED',
      retrieval_completeness: 'COMPLETE_WITHIN_DECLARED_SCOPE',
      nodes_visited: 2,
      frontier_remaining: 0,
    },
    coverage_gate: {
      status: 'INSUFFICIENT',
      required_facts: ['local.storage.engine', 'local.storage.retention'],
      missing_facts: ['local.storage.retention'],
      unresolved_conflicts: [],
      requirements_origin: 'caller_declared',
    },
    l1_invariants: [],
    active_evidence: [{
      ref: 'E1',
      record_ref: 'evt-1',
      content_hash: HASH_C,
      status: 'active',
      source_health: 'verified_at_snapshot',
      recorded_at: AT,
      effective_from: null,
      source: { kind: 'native_note', path: 'docs/example.md' },
      content: 'interface example, not a project fact',
    }],
    deprecated_tombstones: [],
    gaps: [{ fact_key: 'local.storage.retention', reason: 'missing' }],
    conflicts: [],
    untrusted: true,
  };
}

function request(): Record<string, unknown> {
  return {
    schema_version: ANCHOR_PROBE_REQUEST_SCHEMA_VERSION,
    request_id: 'req-1',
    root: 'F:/project',
    project_scope: 'proj',
  };
}

function validCluster(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: ANCHOR_PROBE_CLUSTER_SCHEMA_VERSION,
    project_scope: 'proj',
    cluster_epoch: 'ep-1',
    commit_index: 7,
    replica_id: 'replica-0',
    replica_commit_index: 5,
    consistency: 'quorum',
    max_lag: 2,
    partial: true,
    failed_nodes: ['replica-1'],
    evidence_digest: HASH,
    ...overrides,
  };
}

test('a complete response round-trips through JSON and parses', () => {
  const value = validResponse();
  const parsed = anchorProbeResponseSchema.parse(JSON.parse(JSON.stringify(value)));
  assert.deepEqual(parsed, value);
});

test('unknown fields are rejected at every nesting level', () => {
  const base = validResponse();
  assert.equal(anchorProbeResponseSchema.safeParse({ ...base, extra: 1 }).success, false);
  assert.equal(anchorProbeResponseSchema.safeParse({
    ...base,
    snapshot: { ...base.snapshot, extra: 1 },
  }).success, false);
  assert.equal(anchorProbeResponseSchema.safeParse({
    ...base,
    budget_status: { ...base.budget_status, extra: 1 },
  }).success, false);
  assert.equal(anchorProbeResponseSchema.safeParse({
    ...base,
    active_evidence: [{ ...base.active_evidence[0], source: { kind: 'native_note', extra: 1 } }],
  }).success, false);
  assert.equal(anchorProbeResponseSchema.safeParse({
    ...base,
    coverage_gate: { ...base.coverage_gate, extra: 1 },
  }).success, false);
});

test('illegal enum values are rejected', () => {
  const base = validResponse();
  const mutate = (path: Array<string | number>, value: unknown): ResponseShape => {
    const clone = JSON.parse(JSON.stringify(base)) as ResponseShape;
    let cursor: Record<string, unknown> = clone as unknown as Record<string, unknown>;
    for (const key of path.slice(0, -1)) cursor = cursor[key as string] as Record<string, unknown>;
    cursor[path[path.length - 1] as string] = value;
    return clone;
  };
  assert.equal(anchorProbeResponseSchema.safeParse(mutate(['execution_status'], 'PENDING')).success, false);
  assert.equal(anchorProbeResponseSchema.safeParse(mutate(['temporal_mode'], 'NOW')).success, false);
  assert.equal(anchorProbeResponseSchema.safeParse(mutate(['budget_status', 'stop_reason'], 'DONE')).success, false);
  assert.equal(anchorProbeResponseSchema.safeParse(mutate(['budget_status', 'retrieval_completeness'], 'FULL')).success, false);
  assert.equal(anchorProbeResponseSchema.safeParse(mutate(['coverage_gate', 'status'], 'PASS')).success, false);
  assert.equal(anchorProbeResponseSchema.safeParse(mutate(['coverage_gate', 'requirements_origin'], 'guessed')).success, false);
  assert.equal(anchorProbeResponseSchema.safeParse(mutate(['active_evidence', 0, 'status'], 'deleted')).success, false);
  assert.equal(anchorProbeResponseSchema.safeParse(mutate(['active_evidence', 0, 'source_health'], 'fresh')).success, false);
  assert.equal(anchorProbeResponseSchema.safeParse(mutate(['active_evidence', 0, 'source', 'kind'], 'hearsay')).success, false);
  assert.equal(anchorProbeResponseSchema.safeParse(mutate(['gaps', 0, 'reason'], 'lost')).success, false);
});

test('budget truncation can never be reported as complete', () => {
  const base = validResponse();
  for (const stop_reason of ['BUDGET_EXHAUSTED', 'DEPTH_LIMIT', 'TIMEOUT', 'ENTRY_NOT_FOUND', 'ERROR']) {
    const truncated: ResponseShape = {
      ...base,
      budget_status: { ...base.budget_status, stop_reason, retrieval_completeness: 'COMPLETE_WITHIN_DECLARED_SCOPE' },
    };
    const result = anchorProbeResponseSchema.safeParse(truncated);
    assert.equal(result.success, false, `${stop_reason} must not be COMPLETE`);
  }

  // Honest truncation states are accepted.
  for (const retrieval_completeness of ['PARTIAL', 'UNKNOWN']) {
    const honest: ResponseShape = {
      ...base,
      budget_status: { ...base.budget_status, stop_reason: 'BUDGET_EXHAUSTED', retrieval_completeness },
    };
    assert.equal(anchorProbeResponseSchema.safeParse(honest).success, true);
  }

  // FRONTIER_EXHAUSTED is a normal finish, so COMPLETE within scope is allowed.
  assert.equal(anchorProbeResponseSchema.safeParse(base).success, true);
});

test('failed or unstable execution cannot be reported as complete', () => {
  const base = validResponse();
  for (const execution_status of ['FAILED', 'SNAPSHOT_UNSTABLE']) {
    const value: ResponseShape = {
      ...base,
      execution_status,
      budget_status: { ...base.budget_status, stop_reason: 'ERROR', retrieval_completeness: 'COMPLETE_WITHIN_DECLARED_SCOPE' },
    };
    assert.equal(anchorProbeResponseSchema.safeParse(value).success, false);
  }
});

test('unknown values stay null/unknown instead of invented precision', () => {
  const base = validResponse();
  const value: ResponseShape = {
    ...base,
    snapshot: { ...base.snapshot, graph_revision: null, source_fingerprint: null, connected_digest: null },
    active_evidence: [{
      ...base.active_evidence[0]!,
      source_health: 'unknown',
      effective_from: null,
    }],
    budget_status: { ...base.budget_status, stop_reason: 'ERROR', retrieval_completeness: 'UNKNOWN' },
    coverage_gate: { ...base.coverage_gate, status: 'UNKNOWN', requirements_origin: 'unknown' },
  };
  assert.equal(anchorProbeResponseSchema.safeParse(value).success, true);
  const parsed = anchorProbeResponseSchema.parse(value);
  assert.equal(parsed.snapshot.graph_revision, null);
  assert.equal(parsed.active_evidence[0]?.source_health, 'unknown');
  assert.equal(parsed.coverage_gate.requirements_origin, 'unknown');
});

test('SUFFICIENT coverage cannot carry missing facts', () => {
  const base = validResponse();
  const value: ResponseShape = {
    ...base,
    coverage_gate: { ...base.coverage_gate, status: 'SUFFICIENT' },
  };
  assert.equal(anchorProbeResponseSchema.safeParse(value).success, false);
});

test('evidence aliases, digests and timestamps use the bounded encodings', () => {
  const base = validResponse();
  const evidence = base.active_evidence[0]!;
  assert.equal(anchorProbeResponseSchema.safeParse({
    ...base,
    active_evidence: [{ ...evidence, ref: 'e1' }],
  }).success, false, 'aliases are uppercase letter plus digits');
  assert.equal(anchorProbeResponseSchema.safeParse({
    ...base,
    active_evidence: [{ ...evidence, content_hash: 'ABC' }],
  }).success, false, 'content_hash must be lowercase sha256');
  assert.equal(anchorProbeResponseSchema.safeParse({
    ...base,
    active_evidence: [{ ...evidence, recorded_at: 'yesterday' }],
  }).success, false, 'recorded_at must be ISO-8601');
  assert.equal(anchorProbeResponseSchema.safeParse({
    ...base,
    active_evidence: [{ ...evidence, content: '' }],
  }).success, false, 'evidence content cannot be empty');
});

test('tombstones, conflicts and invariants have their own strict shapes', () => {
  const base = validResponse();
  const value: ResponseShape = {
    ...base,
    deprecated_tombstones: [{
      ref: 'E2',
      record_ref: 'evt-2',
      content_hash: HASH_C,
      status: 'superseded',
      superseded_by: null,
      recorded_at: AT,
      reason: 'relocated',
    }],
    conflicts: [{
      conflict_id: 'conf-1',
      fact_key: 'local.storage.engine',
      record_refs: ['evt-1', 'evt-2'],
      status: 'unresolved',
    }],
    l1_invariants: [{ invariant_id: 'inv-1', status: 'unknown' }],
  };
  const parsed = anchorProbeResponseSchema.parse(value);
  assert.equal(parsed.deprecated_tombstones[0]?.superseded_by, null);
  assert.equal(parsed.conflicts[0]?.record_refs.length, 2);
  assert.equal(parsed.l1_invariants[0]?.status, 'unknown');

  assert.equal(anchorProbeResponseSchema.safeParse({
    ...value,
    deprecated_tombstones: [{ ...value.deprecated_tombstones[0], status: 'active' }],
  }).success, false);
  assert.equal(anchorProbeResponseSchema.safeParse({
    ...value,
    conflicts: [{ ...value.conflicts[0], record_refs: [] }],
  }).success, false);
  assert.equal(anchorProbeResponseSchema.safeParse({
    ...value,
    l1_invariants: [{ ...value.l1_invariants[0], status: 'passed' }],
  }).success, false);
});

test('request defaults the experiment budget and rejects unknown fields', () => {
  const parsed = anchorProbeRequestSchema.parse(request());
  assert.equal(parsed.temporal_mode, 'CURRENT');
  assert.deepEqual(parsed.budget, anchorProbeDefaultBudget);

  assert.equal(anchorProbeRequestSchema.safeParse({ ...request(), extra: 1 }).success, false);
  assert.equal(anchorProbeRequestSchema.safeParse({
    ...request(),
    budget: { max_candidates: 0, max_nodes: 12, max_depth: 3 },
  }).success, false);
  assert.equal(anchorProbeRequestSchema.safeParse({
    ...request(),
    required_facts: ['Local.Storage'],
  }).success, false);
});

test('AS_OF and HISTORICAL requests require an explicit as_of timestamp', () => {
  assert.equal(anchorProbeRequestSchema.safeParse({
    ...request(),
    temporal_mode: 'AS_OF',
  }).success, false);
  assert.equal(anchorProbeRequestSchema.safeParse({
    ...request(),
    temporal_mode: 'AS_OF',
    as_of: 'not-a-date',
  }).success, false);
  const parsed = anchorProbeRequestSchema.parse({
    ...request(),
    temporal_mode: 'AS_OF',
    as_of: AT,
  });
  assert.equal(parsed.as_of, AT);
});

test('generated JSON Schema is distributable and does not claim timestamp_ns precision', () => {
  const schemas = anchorProbeJsonSchemas();
  const response = schemas.response as {
    $schema?: string;
    additionalProperties?: boolean;
    required?: string[];
    properties?: Record<string, unknown>;
  };
  const request = schemas.request as {
    $schema?: string;
    additionalProperties?: boolean;
    required?: string[];
    properties?: Record<string, unknown>;
  };

  assert.equal(response.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(request.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(response.additionalProperties, false);
  assert.equal(request.additionalProperties, false);
  assert.ok(response.required?.includes('request_id'));
  assert.ok(response.required?.includes('context_id'));
  assert.ok(response.required?.includes('untrusted'));
  assert.ok(response.required?.includes('coverage_gate'));
  assert.ok(request.required?.includes('request_id'));
  assert.ok(request.required?.includes('root'));
  assert.ok(request.required?.includes('project_scope'));

  const responseProperties = Object.keys(response.properties ?? {}).sort();
  for (const key of ['snapshot', 'execution_status', 'budget_status', 'coverage_gate', 'active_evidence', 'deprecated_tombstones', 'gaps', 'conflicts']) {
    assert.ok(responseProperties.includes(key), `response schema must describe ${key}`);
  }
  assert.equal(responseProperties.includes('timestamp_ns'), false);

  // Input/output modes: the request schema validates what callers may omit,
  // the response schema validates what the probe must always emit.
  const requestRequired = request.required ?? [];
  assert.equal(requestRequired.includes('temporal_mode'), false, 'request schema must let defaults be omitted');
  assert.equal(requestRequired.includes('budget'), false, 'request schema must let defaults be omitted');
  const evidenceSchema = (response.properties?.active_evidence as { items?: { required?: string[]; additionalProperties?: boolean } } | undefined);
  assert.ok(evidenceSchema?.items?.required?.includes('effective_from'), 'response schema must require effective_from');
  assert.equal(evidenceSchema?.items?.additionalProperties, false);
});

test('the generated JSON Schema and Zod agree on accept and reject cases', async () => {
  const schemas = anchorProbeJsonSchemas();
  const { z } = await import('zod');
  const fromSchema = z.fromJSONSchema(schemas.response as never);

  const accepted = validResponse();
  assert.equal(fromSchema.safeParse(accepted).success, true, 'JSON Schema must accept a valid response');
  assert.equal(anchorProbeResponseSchema.safeParse(accepted).success, true);

  const rejected = [
    { ...validResponse(), extra: 1 },
    { ...validResponse(), execution_status: 'PENDING' },
    { ...validResponse(), snapshot: { ...validResponse().snapshot, ledger_digest: 'not-a-digest' } },
    { ...validResponse(), active_evidence: [{ ...validResponse().active_evidence[0], source: { kind: 'native_note', extra: 1 } }] },
  ];
  for (const value of rejected) {
    assert.equal(fromSchema.safeParse(value).success, false, 'JSON Schema must reject what Zod rejects');
    assert.equal(anchorProbeResponseSchema.safeParse(value).success, false);
  }

  const requestSchema = z.fromJSONSchema(schemas.request as never);
  assert.equal(requestSchema.safeParse(request()).success, true, 'request schema accepts omitted defaults');
  assert.equal(requestSchema.safeParse({ ...request(), extra: 1 }).success, false);
});

test('aliases are unique across evidence and tombstones', () => {
  const base = validResponse();
  const tombstone = {
    ref: 'E1',
    record_ref: 'evt-2',
    content_hash: HASH_C,
    status: 'superseded',
    superseded_by: null,
    recorded_at: AT,
  };
  assert.equal(anchorProbeResponseSchema.safeParse({
    ...base,
    deprecated_tombstones: [tombstone],
  }).success, false, 'an alias may not be reused by a tombstone');

  const duplicated: ResponseShape = {
    ...base,
    active_evidence: [base.active_evidence[0]!, { ...base.active_evidence[0]!, record_ref: 'evt-3' }],
  };
  assert.equal(anchorProbeResponseSchema.safeParse(duplicated).success, false);

  assert.equal(anchorProbeResponseSchema.safeParse({
    ...base,
    deprecated_tombstones: [{ ...tombstone, ref: 'E2' }],
  }).success, true);
});

test('coverage, gaps and conflicts must cross-reference each other', () => {
  const base = validResponse();
  assert.equal(anchorProbeResponseSchema.safeParse({
    ...base,
    gaps: [{ fact_key: 'local.undeclared.fact', reason: 'missing' }],
  }).success, false, 'gaps may only describe required facts');

  assert.equal(anchorProbeResponseSchema.safeParse({
    ...base,
    coverage_gate: { ...base.coverage_gate, missing_facts: ['local.undeclared.fact'] },
  }).success, false, 'missing_facts must be a subset of required_facts');

  assert.equal(anchorProbeResponseSchema.safeParse({
    ...base,
    coverage_gate: { ...base.coverage_gate, unresolved_conflicts: ['conf-missing'] },
  }).success, false, 'unresolved_conflicts must name a real conflict');

  assert.equal(anchorProbeResponseSchema.safeParse({
    ...base,
    conflicts: [{ conflict_id: 'conf-1', fact_key: 'local.storage.engine', record_refs: ['evt-1'], status: 'resolved' }],
    coverage_gate: { ...base.coverage_gate, unresolved_conflicts: ['conf-1'] },
  }).success, false, 'a resolved conflict is not unresolved');

  const withConflict: ResponseShape = {
    ...base,
    conflicts: [{ conflict_id: 'conf-1', fact_key: 'local.storage.engine', record_refs: ['evt-1', 'evt-2'], status: 'unresolved' }],
    coverage_gate: { ...base.coverage_gate, unresolved_conflicts: ['conf-1'] },
  };
  assert.equal(anchorProbeResponseSchema.safeParse(withConflict).success, true);

  assert.equal(anchorProbeResponseSchema.safeParse({
    ...base,
    coverage_gate: { ...base.coverage_gate, status: 'SUFFICIENT', missing_facts: [], unresolved_conflicts: ['conf-1'] },
    conflicts: [{ conflict_id: 'conf-1', fact_key: 'local.storage.engine', record_refs: ['evt-1'], status: 'unresolved' }],
  }).success, false, 'SUFFICIENT coverage cannot carry unresolved conflicts');
});

test('untrusted evidence cannot claim trust', () => {
  const base = validResponse();
  assert.equal(anchorProbeResponseSchema.safeParse({
    ...base,
    untrusted: false,
  }).success, false, 'a response carrying evidence text is untrusted by definition');

  assert.equal(anchorProbeResponseSchema.safeParse({
    ...base,
    active_evidence: [],
    gaps: [],
    coverage_gate: { status: 'UNKNOWN', required_facts: [], missing_facts: [], unresolved_conflicts: [], requirements_origin: 'unknown' },
    untrusted: false,
  }).success, true, 'an evidence-free payload may declare itself trusted');
});

test('legacy snapshots stay parseable and the cluster segment is additive', () => {
  const base = validResponse();
  const legacy = anchorProbeResponseSchema.parse(base);
  assert.equal(legacy.snapshot.cluster, undefined, 'old fixtures carry no cluster and must parse unchanged');

  const clustered = anchorProbeResponseSchema.parse({
    ...base,
    snapshot: { ...base.snapshot, cluster: validCluster() },
  });
  assert.deepEqual(clustered.snapshot.cluster, validCluster());
  // Unknown fields are rejected at the new nesting level too.
  assert.equal(anchorProbeResponseSchema.safeParse({
    ...base,
    snapshot: { ...base.snapshot, cluster: { ...validCluster(), extra: 1 } },
  }).success, false);
});

test('cluster metadata is strictly validated with closed enums and bounded encodings', () => {
  const cluster = validCluster();
  assert.equal(anchorProbeClusterMetadataSchema.safeParse(cluster).success, true);
  assert.equal(anchorProbeClusterMetadataSchema.safeParse({ ...cluster, extra: 1 }).success, false, 'unknown fields rejected');
  assert.equal(anchorProbeClusterMetadataSchema.safeParse({ ...cluster, schema_version: 'anchorprobe.cluster.v2' }).success, false);
  assert.equal(anchorProbeClusterMetadataSchema.safeParse({ ...cluster, consistency: 'EVENTUAL' }).success, false, 'enum is closed');
  assert.equal(anchorProbeClusterMetadataSchema.safeParse({ ...cluster, consistency: 'LOCAL' }).success, false, 'mode casing is part of the contract');
  assert.equal(anchorProbeClusterMetadataSchema.safeParse({ ...cluster, evidence_digest: HASH.slice(0, 63) }).success, false, 'digest must be 64 hex');
  assert.equal(anchorProbeClusterMetadataSchema.safeParse({ ...cluster, evidence_digest: HASH.toUpperCase() }).success, false, 'digest must be lowercase');
  assert.equal(anchorProbeClusterMetadataSchema.safeParse({ ...cluster, commit_index: 1.5 }).success, false);
  assert.equal(anchorProbeClusterMetadataSchema.safeParse({ ...cluster, replica_commit_index: -1 }).success, false);
  assert.equal(anchorProbeClusterMetadataSchema.safeParse({ ...cluster, partial: 'yes' }).success, false);
  assert.equal(anchorProbeClusterMetadataSchema.safeParse({ ...cluster, failed_nodes: 'replica-1' }).success, false);
  assert.equal(anchorProbeClusterMetadataSchema.safeParse({ ...cluster, failed_nodes: ['bad id!'] }).success, false);
  assert.equal(anchorProbeClusterMetadataSchema.safeParse({ ...cluster, cluster_epoch: { nested: true } }).success, false);
  assert.equal(anchorProbeClusterMetadataSchema.safeParse({ ...cluster, replica_id: 'bad id!' }).success, false);

  const { replica_id: _omitted, ...withoutReplica } = cluster;
  assert.equal(anchorProbeClusterMetadataSchema.safeParse(withoutReplica).success, false, 'all listed identity fields are required');

  // Cross-field: partial=false can never carry failed nodes.
  assert.equal(anchorProbeClusterMetadataSchema.safeParse({ ...cluster, partial: false, failed_nodes: ['replica-1'] }).success, false);
  assert.equal(anchorProbeClusterMetadataSchema.safeParse({ ...cluster, partial: false, failed_nodes: [] }).success, true);

  // epoch may be a string or an opaque non-negative number; unknown lag is null.
  assert.equal(anchorProbeClusterMetadataSchema.safeParse({ ...cluster, cluster_epoch: 3 }).success, true);
  assert.equal(anchorProbeClusterMetadataSchema.safeParse({ ...cluster, max_lag: null }).success, true);
  assert.equal(anchorProbeClusterMetadataSchema.safeParse({ ...cluster, max_lag: -1 }).success, false);
});

test('evidence digest is recomputable, order-stable and bounded', () => {
  const records: ProbeEvidenceFingerprint[] = [
    { record_ref: 'evt-b', content_hash: HASH_B, fact_key: 'fact.b', status: 'active' },
    { record_ref: 'evt-a', content_hash: HASH_C, fact_key: 'fact.a', status: 'superseded' },
    { record_ref: 'evt-a', content_hash: HASH },
  ];
  const shuffled = [records[2]!, records[0]!, records[1]!];
  assert.equal(computeEvidenceDigest(records), computeEvidenceDigest(shuffled), 'record order must not matter');

  // Independent recomputation over the documented deterministic projection.
  const expected = [
    { record_ref: 'evt-a', content_hash: HASH },
    { record_ref: 'evt-a', content_hash: HASH_C, fact_key: 'fact.a', status: 'superseded' },
    { record_ref: 'evt-b', content_hash: HASH_B, fact_key: 'fact.b', status: 'active' },
  ];
  const recomputed = createHash('sha256').update(canonicalJson(expected)).digest('hex');
  assert.equal(computeEvidenceDigest(records), recomputed);

  // Duplicates collapse instead of changing the compared set.
  assert.equal(computeEvidenceDigest([...records, records[0]!]), computeEvidenceDigest(records));

  // Free text is not part of the input: attaching it cannot change the digest.
  const noisy = { ...records[0]!, content: 'unbounded secret text' } as unknown as ProbeEvidenceFingerprint;
  assert.equal(computeEvidenceDigest([noisy]), computeEvidenceDigest([records[0]!]));

  // Bounded: over-limit sets are refused unless truncation is explicit.
  const many: ProbeEvidenceFingerprint[] = Array.from({ length: PROBE_EVIDENCE_DIGEST_MAX_RECORDS + 1 }, (_unused, index) => ({
    record_ref: `r${String(index).padStart(4, '0')}`,
    content_hash: HASH,
  }));
  assert.throws(
    () => computeEvidenceDigest(many),
    (error: unknown) => error instanceof ProbeContractError && error.code === 'EVIDENCE_RECORD_LIMIT_EXCEEDED',
    'an unbounded record set must never be mixed',
  );
  const truncated = computeEvidenceDigestDetailed(many, { allowTruncation: true });
  assert.equal(truncated.truncated, true);
  assert.equal(truncated.total, PROBE_EVIDENCE_DIGEST_MAX_RECORDS + 1);
  assert.equal(truncated.considered, PROBE_EVIDENCE_DIGEST_MAX_RECORDS);
  assert.equal(truncated.digest, computeEvidenceDigest(many, { allowTruncation: true }));
  assert.equal(truncated.digest, computeEvidenceDigest(many.slice(0, PROBE_EVIDENCE_DIGEST_MAX_RECORDS)), 'truncation keeps the lexicographically bounded prefix');

  // Malformed fingerprints and limits fail closed.
  assert.throws(() => computeEvidenceDigest([{ record_ref: 'evt-1', content_hash: 'ABC' }]), /EVIDENCE_DIGEST_INPUT_INVALID/);
  assert.throws(() => computeEvidenceDigest([{ record_ref: 'bad id!', content_hash: HASH }]), /EVIDENCE_DIGEST_INPUT_INVALID/);
  assert.throws(() => computeEvidenceDigest([], { limit: 0 }), /EVIDENCE_DIGEST_LIMIT_INVALID/);
  assert.throws(() => computeEvidenceDigest('nope' as unknown as ProbeEvidenceFingerprint[]), /EVIDENCE_DIGEST_INPUT_INVALID/);
});

test('partial and failed_nodes must agree with execution state', () => {
  assert.equal(isClusterPartialConsistent({ partial: true, failed_nodes: ['replica-1'] }), true);
  assert.equal(isClusterPartialConsistent({ partial: true, failed_nodes: [], stop_reason: 'QUORUM_UNMET' }), true);
  assert.equal(isClusterPartialConsistent({ partial: true, failed_nodes: [] }), false, 'partial without a cause is dishonest');
  assert.equal(isClusterPartialConsistent({ partial: false, failed_nodes: [] }), true);
  assert.equal(isClusterPartialConsistent({ partial: false, failed_nodes: ['replica-1'] }), false);

  assert.doesNotThrow(() => assertClusterPartialConsistency({ partial: true, failed_nodes: ['replica-1'] }));
  assert.doesNotThrow(() => assertClusterPartialConsistency({ partial: true, failed_nodes: [], stop_reason: 'TIMEOUT' }));
  assert.throws(
    () => assertClusterPartialConsistency({ partial: true, failed_nodes: [] }),
    (error: unknown) => error instanceof ProbeContractError && error.code === 'PARTIAL_WITHOUT_CAUSE',
  );
  assert.throws(
    () => assertClusterPartialConsistency({ partial: false, failed_nodes: ['replica-1'] }),
    (error: unknown) => error instanceof ProbeContractError && error.code === 'FAILED_NODES_WITHOUT_PARTIAL',
  );
});

test('cross-scope cluster metadata is refused with explicit error codes', () => {
  const cluster = validCluster();
  assert.doesNotThrow(() => assertClusterProjectScope(cluster, 'proj'));
  assert.throws(
    () => assertClusterProjectScope(cluster, 'other'),
    (error: unknown) => error instanceof ProbeContractError && error.code === 'SCOPE_DENIED',
  );
  assert.throws(() => assertClusterProjectScope({}, 'proj'), /SCOPE_DENIED/, 'a missing scope never matches by assumption');

  assert.doesNotThrow(() => assertClusterEpochMatch('ep-1', 'ep-1'));
  assert.doesNotThrow(() => assertClusterEpochMatch(7, 7));
  assert.throws(() => assertClusterEpochMatch('ep-1', 'ep-2'), /CLUSTER_EPOCH_MISMATCH/);
});

test('the legacy snapshot adapter fills honest cluster defaults', () => {
  const adapted = legacySnapshotClusterMetadata(validResponse().snapshot);
  assert.equal(anchorProbeClusterMetadataSchema.safeParse(adapted).success, true);
  assert.equal(adapted.schema_version, ANCHOR_PROBE_CLUSTER_SCHEMA_VERSION);
  assert.equal(adapted.project_scope, 'proj');
  assert.equal(adapted.cluster_epoch, '');
  assert.equal(adapted.commit_index, 0);
  assert.equal(adapted.replica_id, 'local');
  assert.equal(adapted.consistency, 'local');
  assert.equal(adapted.max_lag, null);
  assert.equal(adapted.partial, true);
  assert.deepEqual(adapted.failed_nodes, []);
  assert.equal(adapted.evidence_digest, computeEvidenceDigest([]));
});

test('snapshot identity carries cluster metadata only when present', () => {
  const legacy = validResponse().snapshot;
  const legacyIdentity = probeSnapshotIdentity(legacy);
  // No phantom optional keys: old backends keep an identical identity shape.
  assert.deepEqual(legacyIdentity, {
    project_scope: 'proj',
    ledger_digest: HASH,
    graph_revision: null,
    source_fingerprint: HASH_B,
    connected_digest: null,
    fingerprint: legacyIdentity.fingerprint,
  });

  const cluster = anchorProbeClusterMetadataSchema.parse(validCluster());
  const clusteredIdentity = probeSnapshotIdentity({ ...legacy, cluster });
  assert.equal(clusteredIdentity.fingerprint, legacyIdentity.fingerprint, 'the four-digest fingerprint is unchanged');
  assert.equal(clusteredIdentity.cluster_epoch, 'ep-1');
  assert.equal(clusteredIdentity.commit_index, 7);
  assert.equal(clusteredIdentity.replica_id, 'replica-0');
  assert.equal(clusteredIdentity.replica_commit_index, 5);
  assert.equal(clusteredIdentity.evidence_digest, HASH);
});
