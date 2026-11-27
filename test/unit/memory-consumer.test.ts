import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONSUMER_FAILURE_CARD_SCHEMA_VERSION,
  CONSUMER_MAX_REPAIRS,
  CONSUMER_PROTOCOL_SCHEMA_VERSION,
  ConsumerInputError,
  consumerFailureCardSchema,
  consumerRunResultSchema,
  decideConsumerOutcome,
  runConsumer,
  type ConsumerEvent,
  type ConsumerModelAdapter,
  type ConsumerProbeAdapter,
  type ConsumerProbeRunInput,
  type ConsumerProbeRunResult,
  type ConsumerSnapshotSampleInput,
} from '../../src/memory/consumer.ts';
import {
  CONTEXT_DRAFT_SCHEMA_VERSION,
  CONTEXT_VERIFY_SCHEMA_VERSION,
  type ContextVerifyReport,
  type FrozenContextManifest,
} from '../../src/memory/context-verify.ts';
import type { AnchorProbeRequest, AnchorProbeResponse, AnchorProbeSnapshot } from '../../src/memory/probe-contract.ts';

// Fixtures follow the AP-02 request/context contracts and the AP-12 frozen
// manifest shape. Identity literals are fixed so assertions stay deterministic.

const AT = '2026-11-21T00:00:00.000Z';
const NOW = '2026-11-21T12:00:00.000Z';
const EXPIRES = '2026-11-21T18:00:00.000Z';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const ROOT = '/fixtures/ano-root';
const SCOPE = 'fixture';
const CONTEXT_ID = 'ctx-fixture';

function request(overrides: Record<string, unknown> = {}): AnchorProbeRequest {
  return {
    schema_version: 'anchorprobe.request.v1',
    request_id: 'req-1',
    root: ROOT,
    project_scope: SCOPE,
    required_facts: ['local.storage.engine'],
    temporal_mode: 'CURRENT',
    budget: { max_candidates: 16, max_nodes: 12, max_depth: 3 },
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

function evidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ref: 'E1',
    record_ref: 'probe-record-1',
    content_hash: HASH_A,
    status: 'active',
    source_health: 'verified_at_snapshot',
    recorded_at: AT,
    effective_from: null,
    source: { kind: 'native_note', path: 'docs/example.md' },
    content: 'Interface example text; not a project fact.',
    ...overrides,
  };
}

function manifest(overrides: Record<string, unknown> = {}): FrozenContextManifest {
  return {
    schema_version: 'anchorprobe.manifest.v1',
    context_id: CONTEXT_ID,
    created_at: AT,
    expires_at: EXPIRES,
    root: ROOT,
    project_scope: SCOPE,
    temporal_mode: 'CURRENT',
    execution_status: 'OK',
    budget_status: {
      stop_reason: 'FRONTIER_EXHAUSTED',
      retrieval_completeness: 'COMPLETE_WITHIN_DECLARED_SCOPE',
      nodes_visited: 1,
      frontier_remaining: 0,
    },
    snapshot: snapshot(),
    coverage_gate: {
      status: 'SUFFICIENT',
      required_facts: ['local.storage.engine'],
      missing_facts: [],
      unresolved_conflicts: [],
      requirements_origin: 'caller_declared',
    },
    rules: [{ rule_id: 'rule-storage', fact_key: 'local.storage.engine', value: 'sqlite' }],
    active_evidence: [evidence()],
    deprecated_tombstones: [],
    ...overrides,
  } as unknown as FrozenContextManifest;
}

function response(overrides: Record<string, unknown> = {}): AnchorProbeResponse {
  return {
    schema_version: 'anchorprobe.context.v1',
    request_id: 'req-1',
    context_id: CONTEXT_ID,
    snapshot: snapshot(),
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
      required_facts: ['local.storage.engine'],
      missing_facts: [],
      unresolved_conflicts: [],
      requirements_origin: 'caller_declared',
    },
    l1_invariants: [],
    active_evidence: [evidence()],
    deprecated_tombstones: [],
    gaps: [],
    conflicts: [],
    untrusted: true,
    ...overrides,
  } as unknown as AnchorProbeResponse;
}

function runResult(
  manifestOverrides: Record<string, unknown> = {},
  responseOverrides: Record<string, unknown> = {},
): ConsumerProbeRunResult {
  return { manifest: manifest(manifestOverrides), response: response(responseOverrides) };
}

function draft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: CONTEXT_DRAFT_SCHEMA_VERSION,
    context_id: CONTEXT_ID,
    project_scope: SCOPE,
    claims: [{
      id: 'C1',
      kind: 'CURRENT_FACT',
      fact_key: 'local.storage.engine',
      text: 'SQLite is the storage engine.',
      evidence_refs: ['E1'],
      params: [{ key: 'local.storage.engine', value: 'sqlite' }],
    }],
    not_applicable: [],
    unresolved: [],
    ...overrides,
  };
}

function badDraft(): Record<string, unknown> {
  return draft({
    claims: [{
      id: 'C1',
      kind: 'CURRENT_FACT',
      fact_key: 'local.storage.engine',
      text: 'An unverifiable statement.',
      evidence_refs: ['E9'],
      params: [],
    }],
  });
}

interface FakeProbeOptions {
  readonly runs?: readonly ConsumerProbeRunResult[];
  readonly samples?: readonly AnchorProbeSnapshot[];
  readonly runError?: Error;
  readonly sampleError?: Error;
}

function fakeProbe(options: FakeProbeOptions = {}): { readonly adapter: ConsumerProbeAdapter; readonly calls: { run: number; sample: number } } {
  const runs = options.runs ?? [runResult()];
  const samples = options.samples ?? [snapshot()];
  const calls = { run: 0, sample: 0 };
  const adapter: ConsumerProbeAdapter = {
    run(input: ConsumerProbeRunInput): ConsumerProbeRunResult {
      calls.run += 1;
      if (options.runError !== undefined) throw options.runError;
      return runs[Math.min(calls.run - 1, runs.length - 1)]!;
    },
    sampleSnapshot(_input: ConsumerSnapshotSampleInput): AnchorProbeSnapshot {
      calls.sample += 1;
      if (options.sampleError !== undefined) throw options.sampleError;
      return samples[Math.min(calls.sample - 1, samples.length - 1)]!;
    },
  };
  return { adapter, calls };
}

interface FakeModelOptions {
  readonly generate?: (input: unknown) => unknown | Promise<unknown>;
  readonly repair?: (input: unknown) => unknown | Promise<unknown>;
  readonly generateError?: Error;
}

function fakeModel(options: FakeModelOptions = {}): { readonly adapter: ConsumerModelAdapter; readonly calls: { generate: number; repair: number } } {
  const calls = { generate: 0, repair: 0 };
  const adapter: ConsumerModelAdapter = {
    generate(_input: unknown): unknown {
      calls.generate += 1;
      if (options.generateError !== undefined) throw options.generateError;
      return options.generate ? options.generate(_input) : draft();
    },
  };
  if (options.repair !== undefined) {
    adapter.repair = (input: unknown): unknown => {
      calls.repair += 1;
      return options.repair!(input);
    };
  }
  return { adapter, calls };
}

function baseReport(overrides: Record<string, unknown> = {}): ContextVerifyReport {
  return {
    schema_version: CONTEXT_VERIFY_SCHEMA_VERSION,
    status: 'NEEDS_REVIEW',
    context_id: CONTEXT_ID,
    checks: {
      schema: 'pass',
      manifest: 'pass',
      binding: 'pass',
      snapshot: 'skipped',
      refs: 'pass',
      facts: 'pass',
      params: 'pass',
      aggregate: 'pass',
    },
    violations: [],
    semantic_support: 'unknown',
    untrusted: true,
    ...overrides,
  } as ContextVerifyReport;
}

test('clean draft is buffered, verified and returned as NEEDS_REVIEW with no displayable claims', async () => {
  const probe = fakeProbe();
  const model = fakeModel();
  const events: ConsumerEvent[] = [];
  const result = await runConsumer({
    request: request(),
    probe: probe.adapter,
    model: model.adapter,
    now: NOW,
    observer: (event) => events.push(event),
  });

  assert.equal(result.schema_version, CONSUMER_PROTOCOL_SCHEMA_VERSION);
  assert.equal(result.outcome, 'NEEDS_REVIEW');
  assert.equal(result.semantic_support, 'unknown');
  assert.equal(result.untrusted, true);
  assert.deepEqual(result.displayable_claims, []);
  assert.equal(result.failure, null);
  assert.equal(result.report?.status, 'NEEDS_REVIEW');
  assert.equal(result.report?.semantic_support, 'unknown');
  assert.equal(result.context_id, CONTEXT_ID);

  // The draft was buffered and verified exactly once; no repair, no display.
  assert.equal(model.calls.generate, 1);
  assert.equal(model.calls.repair, 0);
  assert.equal(probe.calls.run, 1);
  assert.equal(probe.calls.sample, 1);
  assert.deepEqual(events.map((event) => event.phase), ['probe', 'model', 'verify', 'reconcile', 'decision']);

  // The output is deliberately not Gate-shaped.
  assert.equal('evidence_id' in result, false);
  assert.equal('verdict' in result, false);
  assert.equal('task_id' in result, false);
  assert.equal(consumerRunResultSchema.safeParse(result).success, true);
});

test('a second verification failure returns the evidence/gap/conflict card without another repair', async () => {
  const probe = fakeProbe();
  const model = fakeModel({ generate: () => badDraft(), repair: () => badDraft() });

  const result = await runConsumer({ request: request(), probe: probe.adapter, model: model.adapter, now: NOW });

  assert.equal(result.outcome, 'BLOCKED');
  assert.deepEqual(result.displayable_claims, []);
  assert.equal(result.failure !== null, true);
  const card = result.failure!;
  assert.equal(card.schema_version, CONSUMER_FAILURE_CARD_SCHEMA_VERSION);
  assert.equal(card.context_id, CONTEXT_ID);
  assert.equal(card.project_scope, SCOPE);
  assert.ok(card.violations.some((violation) => violation.code === 'unknown_evidence_ref'));
  assert.equal(card.evidence.length, 1);
  assert.deepEqual(card.gaps, []);
  assert.deepEqual(card.conflicts, []);
  assert.equal(card.budget.repairs_used, 1);
  assert.equal(card.budget.max_repairs, CONSUMER_MAX_REPAIRS);
  assert.equal(card.budget.exhausted, false);

  // Exactly one repair round happened; the second failure was terminal.
  assert.equal(model.calls.generate, 1);
  assert.equal(model.calls.repair, 1);
  assert.equal(result.budget.verify_calls_used, 2);
  assert.equal(consumerFailureCardSchema.safeParse(card).success, true);
  assert.equal(consumerRunResultSchema.safeParse(result).success, true);
});

test('one repair round can turn a blocked draft into a clean NEEDS_REVIEW draft', async () => {
  const probe = fakeProbe();
  const model = fakeModel({ generate: () => badDraft(), repair: () => draft() });

  const result = await runConsumer({ request: request(), probe: probe.adapter, model: model.adapter, now: NOW });

  assert.equal(result.outcome, 'NEEDS_REVIEW');
  assert.equal(result.budget.repairs_used, 1);
  assert.equal(result.budget.verify_calls_used, 2);
  assert.equal(model.calls.generate, 1);
  assert.equal(model.calls.repair, 1);
  assert.deepEqual(result.displayable_claims, []);
});

test('the repair call receives the failed draft and the failure card', async () => {
  let captured: unknown;
  const model = fakeModel({
    generate: () => badDraft(),
    repair: (input) => {
      captured = input;
      return draft();
    },
  });

  const result = await runConsumer({ request: request(), probe: fakeProbe().adapter, model: model.adapter, now: NOW });

  assert.equal(result.outcome, 'NEEDS_REVIEW');
  const repairInput = captured as {
    generation: number;
    draft: unknown;
    failure: { reason: string; violations: readonly unknown[] };
  };
  assert.equal(repairInput.generation, 2);
  assert.equal(repairInput.failure.reason, 'verification_blocked');
  assert.ok(repairInput.failure.violations.length > 0);
  assert.deepEqual(repairInput.draft, badDraft());
});

test('a stale snapshot triggers one re-probe and a fresh draft within budget', async () => {
  const stalePair = runResult(
    { snapshot: snapshot({ ledger_digest: HASH_B }) },
    { snapshot: snapshot({ ledger_digest: HASH_B }) },
  );
  const freshPair = runResult();
  const probe = fakeProbe({ runs: [stalePair, freshPair], samples: [snapshot(), snapshot()] });
  const model = fakeModel();

  const result = await runConsumer({ request: request(), probe: probe.adapter, model: model.adapter, now: NOW });

  assert.equal(result.outcome, 'NEEDS_REVIEW');
  assert.equal(probe.calls.run, 2);
  assert.equal(probe.calls.sample, 2);
  assert.equal(model.calls.generate, 2);
  assert.equal(result.budget.probes_used, 2);
  assert.equal(result.budget.resamples_used, 2);
  assert.equal(result.budget.exhausted, false);
});

test('snapshot instability with no probe budget fails closed and reports the budget state', async () => {
  const stalePair = runResult(
    { snapshot: snapshot({ ledger_digest: HASH_B }) },
    { snapshot: snapshot({ ledger_digest: HASH_B }) },
  );
  const probe = fakeProbe({ runs: [stalePair], samples: [snapshot()] });

  const result = await runConsumer({
    request: request(),
    probe: probe.adapter,
    model: fakeModel().adapter,
    now: NOW,
    budget: { max_probes: 1 },
  });

  assert.equal(result.outcome, 'FAILED');
  assert.deepEqual(result.displayable_claims, []);
  const card = result.failure!;
  assert.equal(card.reason, 'snapshot_unstable_budget_exhausted');
  assert.equal(card.budget.exhausted, true);
  assert.equal(card.budget.reason, 'snapshot_unstable_budget_exhausted');
  assert.equal(card.budget.probes_used, 1);
  assert.equal(card.budget.max_probes, 1);
  assert.equal(card.evidence.length, 1);
  assert.equal(consumerFailureCardSchema.safeParse(card).success, true);
});

test('the total claim budget is enforced across drafts', async () => {
  const claims = Array.from({ length: 5 }, (_, index) => ({
    id: `C${index + 1}`,
    kind: 'CURRENT_FACT',
    fact_key: 'local.storage.engine',
    text: 'A statement.',
    evidence_refs: ['E1'],
    params: [],
  }));
  const model = fakeModel({ generate: () => draft({ claims }) });

  const result = await runConsumer({
    request: request(),
    probe: fakeProbe().adapter,
    model: model.adapter,
    now: NOW,
    budget: { max_claims: 3 },
  });

  assert.equal(result.outcome, 'FAILED');
  assert.equal(result.failure!.reason, 'claim_budget_exhausted');
  assert.equal(result.failure!.budget.claims_seen, 5);
  assert.equal(result.failure!.budget.exhausted, true);
  assert.equal(result.budget.verify_calls_used, 0);
});

test('only ALLOW releases displayable claims, and a block violation excludes its claim', () => {
  const parsedDraft = {
    schema_version: CONTEXT_DRAFT_SCHEMA_VERSION,
    context_id: CONTEXT_ID,
    project_scope: SCOPE,
    claims: [{ id: 'C1', kind: 'CURRENT_FACT', text: 'x', evidence_refs: ['E1'], params: [] }],
    not_applicable: [],
    unresolved: [],
  } as never;

  const allowed = decideConsumerOutcome(baseReport({ status: 'ALLOW' }), parsedDraft);
  assert.equal(allowed.outcome, 'ALLOWED');
  assert.deepEqual(allowed.displayable_claims.map((claim) => claim.id), ['C1']);

  const blockedClaim = decideConsumerOutcome(baseReport({
    status: 'ALLOW',
    violations: [{ code: 'constraint_mismatch', severity: 'block', message: 'contradicts the formalized value', claim_id: 'C1' }],
  }), parsedDraft);
  assert.equal(blockedClaim.outcome, 'ALLOWED');
  assert.deepEqual(blockedClaim.displayable_claims, []);

  const review = decideConsumerOutcome(baseReport({ status: 'NEEDS_REVIEW' }), parsedDraft);
  assert.equal(review.outcome, 'NEEDS_REVIEW');
  assert.deepEqual(review.displayable_claims, []);
  assert.equal(review.reason, 'semantic_support_unknown');
});

test('a throwing model adapter becomes a failure card, not an exception', async () => {
  const probe = fakeProbe();
  const model = fakeModel({ generateError: new Error('model backend unavailable') });

  const result = await runConsumer({ request: request(), probe: probe.adapter, model: model.adapter, now: NOW });

  assert.equal(result.outcome, 'FAILED');
  assert.match(result.failure!.reason, /^model_error: model backend unavailable$/);
  assert.equal(result.failure!.evidence.length, 1);
  assert.deepEqual(result.displayable_claims, []);
});

test('a hanging model adapter is cut off by the model timeout', async () => {
  const model = fakeModel({ generate: () => new Promise(() => {}) });

  const result = await runConsumer({
    request: request(),
    probe: fakeProbe().adapter,
    model: model.adapter,
    now: NOW,
    budget: { model_timeout_ms: 5 },
  });

  assert.equal(result.outcome, 'FAILED');
  assert.equal(result.failure!.reason, 'model_timeout');
  assert.equal(result.failure!.budget.exhausted, false);
});

test('garbage model output is a draft_invalid BLOCK followed by a failure card', async () => {
  const model = fakeModel({ generate: () => '{"broken":', repair: () => '{"broken":' });

  const result = await runConsumer({ request: request(), probe: fakeProbe().adapter, model: model.adapter, now: NOW });

  assert.equal(result.outcome, 'BLOCKED');
  assert.ok(result.failure!.violations.some((violation) => violation.code === 'draft_invalid'));
  assert.equal(result.budget.repairs_used, 1);
  assert.equal(result.budget.verify_calls_used, 2);
});

test('a throwing probe adapter becomes a failure card', async () => {
  const probe = fakeProbe({ runError: new Error('ledger unavailable') });

  const result = await runConsumer({ request: request(), probe: probe.adapter, model: fakeModel().adapter, now: NOW });

  assert.equal(result.outcome, 'FAILED');
  assert.match(result.failure!.reason, /^probe_error: ledger unavailable$/);
  assert.equal(result.failure!.context_id, null);
  assert.deepEqual(result.failure!.evidence, []);
});

test('a FAILED probe context cannot ground answers', async () => {
  const failedBudget = {
    stop_reason: 'ERROR',
    retrieval_completeness: 'UNKNOWN',
    nodes_visited: 0,
    frontier_remaining: 0,
  };
  const pair = runResult(
    { execution_status: 'FAILED', budget_status: failedBudget },
    { execution_status: 'FAILED', budget_status: failedBudget },
  );
  const probe = fakeProbe({ runs: [pair] });

  const result = await runConsumer({ request: request(), probe: probe.adapter, model: fakeModel().adapter, now: NOW });

  assert.equal(result.outcome, 'FAILED');
  assert.equal(result.failure!.reason, 'probe_execution_failed');
});

test('without a repair method a blocked draft is terminal', async () => {
  const model = fakeModel({ generate: () => badDraft() });

  const result = await runConsumer({ request: request(), probe: fakeProbe().adapter, model: model.adapter, now: NOW });

  assert.equal(result.outcome, 'BLOCKED');
  assert.equal(result.failure!.reason, 'verification_blocked_no_repair');
  assert.equal(model.calls.repair, 0);
  assert.equal(result.budget.repairs_used, 0);
});

test('a blocked draft with no model budget for repair is terminal', async () => {
  const model = fakeModel({ generate: () => badDraft(), repair: () => draft() });

  const result = await runConsumer({
    request: request(),
    probe: fakeProbe().adapter,
    model: model.adapter,
    now: NOW,
    budget: { max_model_calls: 1 },
  });

  assert.equal(result.outcome, 'BLOCKED');
  assert.equal(result.failure!.reason, 'verification_blocked_repair_budget_exhausted');
  assert.equal(model.calls.repair, 0);
  assert.equal(result.budget.model_calls_used, 1);
});

test('the overall deadline is enforced', async () => {
  const model = fakeModel({
    generate: () => new Promise((resolve) => setTimeout(() => resolve(draft()), 30)),
  });

  const result = await runConsumer({
    request: request(),
    probe: fakeProbe().adapter,
    model: model.adapter,
    now: NOW,
    budget: { deadline_ms: 5 },
  });

  assert.equal(result.outcome, 'FAILED');
  assert.equal(result.failure!.reason, 'deadline_exceeded');
  assert.equal(result.failure!.budget.exhausted, true);
});

test('the snapshot re-sample budget is enforced', async () => {
  const stalePair = runResult(
    { snapshot: snapshot({ ledger_digest: HASH_B }) },
    { snapshot: snapshot({ ledger_digest: HASH_B }) },
  );
  const freshPair = runResult();
  const probe = fakeProbe({ runs: [stalePair, freshPair], samples: [snapshot(), snapshot()] });

  const result = await runConsumer({
    request: request(),
    probe: probe.adapter,
    model: fakeModel().adapter,
    now: NOW,
    budget: { max_resamples: 1, max_probes: 2 },
  });

  assert.equal(result.outcome, 'FAILED');
  assert.equal(result.failure!.reason, 'resample_budget_exhausted');
  assert.equal(result.failure!.budget.resamples_used, 1);
  assert.equal(result.failure!.budget.max_resamples, 1);
});

test('an invalid probe request is caller misuse, not a failure card', async () => {
  await assert.rejects(
    runConsumer({ request: { schema_version: 'nope' }, probe: fakeProbe().adapter, model: fakeModel().adapter }),
    ConsumerInputError,
  );
});
