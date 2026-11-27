/**
 * T-153 shard B: reachable branches of `src/memory/consumer.ts`.
 *
 * The existing suite covers the happy path and the two verification outcomes.
 * This file drives the remaining protocol state machine with real injected
 * adapters: adapter failures, every budget exhaustion that is reachable under
 * the positive-integer schema, snapshot re-probe/reconcile loops, repair
 * refusal reasons, caller-envelope misuse and the consistency gate.
 *
 * No Node internals are mocked; model latency is produced by real timers.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONSUMER_FAILURE_CARD_SCHEMA_VERSION,
  ConsumerInputError,
  decideConsumerOutcome,
  runConsumer,
  type ConsumerEvent,
  type ConsumerModelAdapter,
  type ConsumerProbeAdapter,
  type ConsumerProbeRunResult,
  type ConsumerSnapshotSampleInput,
} from '../../src/memory/consumer.ts';
import {
  CONTEXT_DRAFT_SCHEMA_VERSION,
  CONTEXT_VERIFY_SCHEMA_VERSION,
  type ContextVerifyReport,
  type FrozenContextManifest,
} from '../../src/memory/context-verify.ts';
import type { ConsistencyJudgement } from '../../src/memory/cluster-consistency.ts';
import type { AnchorProbeRequest, AnchorProbeResponse, AnchorProbeSnapshot } from '../../src/memory/probe-contract.ts';

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

function twoClaimDraft(): Record<string, unknown> {
  return draft({
    claims: [
      {
        id: 'C1',
        kind: 'CURRENT_FACT',
        fact_key: 'local.storage.engine',
        text: 'SQLite is the storage engine.',
        evidence_refs: ['E1'],
        params: [{ key: 'local.storage.engine', value: 'sqlite' }],
      },
      {
        id: 'C2',
        kind: 'CURRENT_FACT',
        fact_key: 'local.storage.engine',
        text: 'A second supported claim.',
        evidence_refs: ['E1'],
        params: [{ key: 'local.storage.engine', value: 'sqlite' }],
      },
    ],
  });
}

interface FakeProbeOptions {
  readonly runs?: readonly unknown[];
  readonly samples?: readonly AnchorProbeSnapshot[];
  readonly runError?: unknown;
  readonly sampleError?: unknown;
}

function fakeProbe(options: FakeProbeOptions = {}): ConsumerProbeAdapter {
  const runs = options.runs ?? [runResult()];
  const samples = options.samples ?? [snapshot()];
  let run = 0;
  let sample = 0;
  return {
    run(): ConsumerProbeRunResult {
      run += 1;
      if (options.runError !== undefined) throw options.runError;
      return runs[Math.min(run - 1, runs.length - 1)] as ConsumerProbeRunResult;
    },
    sampleSnapshot(_input: ConsumerSnapshotSampleInput): AnchorProbeSnapshot {
      sample += 1;
      if (options.sampleError !== undefined) throw options.sampleError;
      return samples[Math.min(sample - 1, samples.length - 1)]!;
    },
  };
}

interface FakeModelOptions {
  readonly generate?: (input: unknown) => unknown;
  readonly repair?: (input: unknown) => unknown;
  readonly generateDelayMs?: number;
}

function fakeModel(options: FakeModelOptions = {}): ConsumerModelAdapter {
  const adapter: ConsumerModelAdapter = {
    generate(): unknown {
      if (options.generateDelayMs !== undefined) {
        return new Promise((resolve) => setTimeout(() => resolve(options.generate ? options.generate(undefined) : draft()), options.generateDelayMs));
      }
      return options.generate ? options.generate(undefined) : draft();
    },
  };
  if (options.repair !== undefined) adapter.repair = (): unknown => options.repair!(undefined);
  return adapter;
}

function consistency(overrides: Record<string, unknown> = {}): ConsistencyJudgement {
  return {
    status: 'consistent',
    mode: 'LOCAL',
    requested_mode: 'LOCAL',
    code: null,
    lag: null,
    historical: false,
    stale: false,
    reasons: [],
    ...overrides,
  } as ConsistencyJudgement;
}

function report(overrides: Record<string, unknown> = {}): ContextVerifyReport {
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

async function expectFailure(input: Record<string, unknown>, reason: string): Promise<void> {
  const result = await runConsumer(input as never);
  assert.equal(result.outcome, 'FAILED', `expected FAILED for ${reason}, got ${result.outcome}`);
  assert.equal(result.failure?.reason ?? null, reason);
}

// ---------------------------------------------------------------------------
// Adapter failures and probe-run validation
// ---------------------------------------------------------------------------

test('m18b consumer reports a probe adapter throw as probe_error', async () => {
  const result = await runConsumer({
    request: request(),
    probe: fakeProbe({ runError: new Error('transport down') }),
    model: fakeModel(),
    now: NOW,
  });
  assert.equal(result.outcome, 'FAILED');
  assert.match(result.failure!.reason, /probe_error: transport down/u);
});

test('m18b consumer surfaces a non-Error model failure verbatim through errorMessage', async () => {
  const result = await runConsumer({
    request: request(),
    probe: fakeProbe(),
    model: { generate: (): unknown => { throw 'plain string failure'; } },
    now: NOW,
  });
  assert.equal(result.outcome, 'FAILED');
  assert.match(result.failure!.reason, /model_error: plain string failure/u);
});

test('m18b consumer rejects malformed probe results without fabricating a context', async () => {
  const cases: Array<{ name: string; run: unknown; reason: string }> = [
    { name: 'non-object result', run: null, reason: 'probe adapter returned a non-object result' },
    { name: 'invalid manifest', run: { manifest: { context_id: 'x' }, response: response() }, reason: 'probe adapter returned an invalid frozen context manifest' },
    { name: 'invalid response', run: { manifest: manifest(), response: { context_id: CONTEXT_ID } }, reason: 'probe adapter returned an invalid AnchorProbe context response' },
    { name: 'context id mismatch', run: runResult({}, { context_id: 'ctx-other' }), reason: 'probe manifest context_id does not match the probe response' },
    { name: 'scope mismatch', run: { manifest: manifest({ project_scope: 'other' }), response: response() }, reason: 'probe manifest scope does not match the response snapshot scope' },
    { name: 'root mismatch', run: { manifest: manifest({ root: '/elsewhere' }), response: response() }, reason: 'probe manifest root does not match the probe request root' },
    { name: 'status mismatch', run: { manifest: manifest({ execution_status: 'DEGRADED' }), response: response() }, reason: 'probe manifest execution_status does not match the probe response' },
    { name: 'snapshot mismatch', run: { manifest: manifest({ snapshot: snapshot({ ledger_digest: HASH_B }) }), response: response() }, reason: 'probe manifest snapshot does not match the probe response snapshot' },
  ];
  for (const item of cases) {
    const result = await runConsumer({
      request: request(),
      probe: fakeProbe({ runs: [item.run] }),
      model: fakeModel(),
      now: NOW,
    });
    assert.equal(result.outcome, 'FAILED', item.name);
    assert.match(result.failure!.reason, new RegExp(item.reason.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'), item.name);
  }
});

test('m18b consumer fails closed when the frozen probe reports FAILED or SNAPSHOT_UNSTABLE', async () => {
  const degradedBudget = { stop_reason: 'ERROR', retrieval_completeness: 'UNKNOWN', nodes_visited: 0, frontier_remaining: 0 } as const;
  const failed = await runConsumer({
    request: request(),
    probe: fakeProbe({ runs: [runResult({ execution_status: 'FAILED' }, { execution_status: 'FAILED', budget_status: degradedBudget })] }),
    model: fakeModel(),
    now: NOW,
  });
  assert.equal(failed.outcome, 'FAILED');
  assert.match(failed.failure!.reason, /probe_execution_failed/u);

  const unstable = await runConsumer({
    request: request(),
    probe: fakeProbe({ runs: [runResult({ execution_status: 'SNAPSHOT_UNSTABLE' }, { execution_status: 'SNAPSHOT_UNSTABLE', budget_status: degradedBudget })] }),
    model: fakeModel(),
    now: NOW,
    budget: { max_probes: 1 },
  });
  assert.equal(unstable.outcome, 'FAILED');
  assert.match(unstable.failure!.reason, /snapshot_unstable/u);
  assert.equal(unstable.budget.probes_used, 1);
});

test('m18b consumer re-probes once after SNAPSHOT_UNSTABLE and then succeeds', async () => {
  const events: ConsumerEvent[] = [];
  const degradedBudget = { stop_reason: 'ERROR', retrieval_completeness: 'UNKNOWN', nodes_visited: 0, frontier_remaining: 0 } as const;
  const result = await runConsumer({
    request: request(),
    probe: fakeProbe({
      runs: [
        runResult({ execution_status: 'SNAPSHOT_UNSTABLE' }, { execution_status: 'SNAPSHOT_UNSTABLE', budget_status: degradedBudget }),
        runResult(),
      ],
    }),
    model: fakeModel(),
    now: NOW,
    budget: { max_probes: 2 },
    observer: (event) => events.push(event),
  });
  assert.equal(result.outcome, 'NEEDS_REVIEW');
  assert.equal(result.budget.probes_used, 2);
  assert.equal(events.some((event) => event.detail === 'snapshot_unstable_reprobe'), true);
});

// ---------------------------------------------------------------------------
// Budget exhaustion and loop transitions
// ---------------------------------------------------------------------------

test('m18b consumer exhausts model calls only after a re-probe resets the buffered draft', async () => {
  const result = await runConsumer({
    request: request(),
    probe: fakeProbe({
      runs: [runResult(), runResult(), runResult()],
      // drift -> settle -> drift, so the run spends a repair round before the
      // final re-probe finds no model budget left to buffer a draft.
      samples: [snapshot({ ledger_digest: HASH_B }), snapshot({ ledger_digest: HASH_A }), snapshot({ ledger_digest: HASH_B })],
    }),
    model: fakeModel({ generate: () => badDraft(), repair: () => badDraft() }),
    now: NOW,
    budget: { max_probes: 3, max_model_calls: 3, max_resamples: 3 },
  });
  assert.equal(result.outcome, 'FAILED');
  assert.match(result.failure!.reason, /model_budget_exhausted/u);
  assert.equal(result.budget.model_calls_used, 3);
  assert.equal(result.budget.probes_used, 3);
});

test('m18b consumer refuses a second verification when max_verify_calls is spent', async () => {
  const result = await runConsumer({
    request: request(),
    probe: fakeProbe({
      runs: [runResult(), runResult()],
      samples: [snapshot({ ledger_digest: HASH_B }), snapshot({ ledger_digest: HASH_B })],
    }),
    model: fakeModel(),
    now: NOW,
    budget: { max_probes: 2, max_verify_calls: 1 },
  });
  assert.equal(result.outcome, 'FAILED');
  assert.match(result.failure!.reason, /verify_budget_exhausted/u);
  assert.equal(result.budget.verify_calls_used, 1);
});

test('m18b consumer reports resample exhaustion after one repair round', async () => {
  const result = await runConsumer({
    request: request(),
    probe: fakeProbe(),
    model: fakeModel({ generate: () => badDraft(), repair: () => draft() }),
    now: NOW,
    budget: { max_resamples: 1 },
  });
  assert.equal(result.outcome, 'FAILED');
  assert.match(result.failure!.reason, /resample_budget_exhausted/u);
  assert.equal(result.budget.resamples_used, 1);
  assert.equal(result.budget.repairs_used, 1);
});

test('m18b consumer reports a snapshot sampling failure separately from probe failure', async () => {
  const result = await runConsumer({
    request: request(),
    probe: fakeProbe({ sampleError: new Error('sampler offline') }),
    model: fakeModel(),
    now: NOW,
  });
  assert.equal(result.outcome, 'FAILED');
  assert.match(result.failure!.reason, /snapshot_sample_error: sampler offline/u);
});

test('m18b consumer enforces the distinct-claim ceiling on the first buffered draft', async () => {
  const result = await runConsumer({
    request: request(),
    probe: fakeProbe(),
    model: fakeModel({ generate: () => twoClaimDraft() }),
    now: NOW,
    budget: { max_claims: 1 },
  });
  assert.equal(result.outcome, 'FAILED');
  assert.match(result.failure!.reason, /claim_budget_exhausted/u);
  assert.equal(result.budget.claims_seen, 2);
});

test('m18b consumer turns model latency into a timeout failure instead of hanging', async () => {
  const result = await runConsumer({
    request: request(),
    probe: fakeProbe(),
    model: fakeModel({ generate: () => draft(), generateDelayMs: 40 }),
    now: NOW,
    budget: { model_timeout_ms: 1 },
  });
  assert.equal(result.outcome, 'FAILED');
  assert.match(result.failure!.reason, /model_timeout/u);
});

test('m18b consumer expires an overall deadline at the loop boundary', async () => {
  const result = await runConsumer({
    request: request(),
    probe: {
      run: () => new Promise((resolve) => setTimeout(() => resolve(runResult()), 25)),
      sampleSnapshot: () => snapshot(),
    },
    model: fakeModel(),
    now: NOW,
    budget: { deadline_ms: 1 },
  });
  assert.equal(result.outcome, 'FAILED');
  assert.match(result.failure!.reason, /deadline_exceeded/u);
});

test('m18b consumer reports a changed snapshot and re-probes before deciding', async () => {
  const events: ConsumerEvent[] = [];
  const result = await runConsumer({
    request: request(),
    probe: fakeProbe({
      runs: [runResult(), runResult()],
      samples: [snapshot({ ledger_digest: HASH_B }), snapshot({ ledger_digest: HASH_A })],
    }),
    model: fakeModel(),
    now: NOW,
    budget: { max_probes: 2 },
    observer: (event) => events.push(event),
  });
  assert.equal(result.outcome, 'NEEDS_REVIEW');
  assert.equal(result.budget.probes_used, 2);
  assert.equal(events.some((event) => event.phase === 'reconcile' && event.ok === false), true);
});

test('m18b consumer fails closed when a changed snapshot cannot be re-probed', async () => {
  const result = await runConsumer({
    request: request(),
    probe: fakeProbe({
      runs: [runResult()],
      samples: [snapshot({ ledger_digest: HASH_B })],
    }),
    model: fakeModel(),
    now: NOW,
    budget: { max_probes: 1 },
  });
  assert.equal(result.outcome, 'FAILED');
  assert.match(result.failure!.reason, /snapshot_unstable_budget_exhausted/u);
});

// ---------------------------------------------------------------------------
// Repair policy
// ---------------------------------------------------------------------------

test('m18b consumer distinguishes no-repair and repair-budget-exhausted block reasons', async () => {
  const noRepair = await runConsumer({
    request: request(),
    probe: fakeProbe(),
    model: { generate: () => badDraft() },
    now: NOW,
  });
  assert.equal(noRepair.outcome, 'BLOCKED');
  assert.equal(noRepair.failure?.reason, 'verification_blocked_no_repair');

  const exhausted = await runConsumer({
    request: request(),
    probe: fakeProbe(),
    model: fakeModel({ generate: () => badDraft(), repair: () => draft() }),
    now: NOW,
    budget: { max_model_calls: 1 },
  });
  assert.equal(exhausted.outcome, 'BLOCKED');
  assert.equal(exhausted.failure?.reason, 'verification_blocked_repair_budget_exhausted');
});

// ---------------------------------------------------------------------------
// Consistency gate and input envelope
// ---------------------------------------------------------------------------

test('m18b consumer stops before any model call on a blocked consistency judgement', async () => {
  let modelCalls = 0;
  const events: ConsumerEvent[] = [];
  const result = await runConsumer({
    request: request(),
    probe: fakeProbe(),
    model: { generate: () => { modelCalls += 1; return draft(); } },
    consistency: consistency({ status: 'blocked', code: 'SPLIT_BRAIN', reasons: ['two leaders'] }),
    now: NOW,
    observer: (event) => events.push(event),
  });
  assert.equal(result.outcome, 'FAILED');
  assert.match(result.failure!.reason, /consistency_blocked: SPLIT_BRAIN/u);
  assert.equal(modelCalls, 0);
  assert.deepEqual(events.map((event) => event.phase), ['probe', 'budget']);
  assert.equal(result.failure?.schema_version, CONSUMER_FAILURE_CARD_SCHEMA_VERSION);
});

test('m18b consumer rejects caller-envelope misuse with ConsumerInputError', async () => {
  const valid = { request: request(), probe: fakeProbe(), model: fakeModel(), now: NOW };
  const cases: Array<{ name: string; input: unknown }> = [
    { name: 'null input', input: null },
    { name: 'array input', input: [] },
    { name: 'probe missing sampleSnapshot', input: { ...valid, probe: { run: () => runResult() } } },
    { name: 'model missing generate', input: { ...valid, model: {} } },
    { name: 'observer not a function', input: { ...valid, observer: 'nope' } },
    { name: 'consistency not a judgement', input: { ...valid, consistency: { status: 'made-up' } } },
    { name: 'invalid request', input: { ...valid, request: { schema_version: 'nope' } } },
    { name: 'invalid now', input: { ...valid, now: 'not-a-date' } },
    { name: 'budget zero', input: { ...valid, budget: { max_probes: 0 } } },
    { name: 'deadline zero', input: { ...valid, budget: { deadline_ms: 0 } } },
  ];
  for (const item of cases) {
    await assert.rejects(
      () => runConsumer(item.input as never),
      (error: unknown) => {
        assert.ok(error instanceof ConsumerInputError, `${item.name}: expected ConsumerInputError`);
        return true;
      },
      item.name,
    );
  }
});

// ---------------------------------------------------------------------------
// Pure decision seam
// ---------------------------------------------------------------------------

test('m18b decideConsumerOutcome filters block-severity claims out of ALLOW', () => {
  const allowed = decideConsumerOutcome(report({ status: 'ALLOW' }), draft() as never);
  assert.equal(allowed.outcome, 'ALLOWED');
  assert.equal(allowed.displayable_claims.length, 1);

  const filtered = decideConsumerOutcome(
    report({
      status: 'ALLOW',
      violations: [{ code: 'unverifiable_claim', severity: 'block', message: 'blocked', claim_id: 'C1' }],
    }),
    draft() as never,
  );
  assert.equal(filtered.outcome, 'ALLOWED');
  assert.deepEqual(filtered.displayable_claims, []);

  assert.equal(decideConsumerOutcome(report({ status: 'NEEDS_REVIEW' }), draft() as never).outcome, 'NEEDS_REVIEW');
  assert.equal(decideConsumerOutcome(report({ status: 'BLOCK' }), draft() as never).outcome, 'BLOCKED');
  assert.equal(decideConsumerOutcome(report({ status: 'BLOCK' }), null).displayable_claims.length, 0);
});
