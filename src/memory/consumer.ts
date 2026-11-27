import { z } from 'zod';
import {
  anchorProbeAliasRefSchema,
  anchorProbeConflictSchema,
  anchorProbeEvidenceSchema,
  anchorProbeGapSchema,
  anchorProbeRequestSchema,
  anchorProbeResponseSchema,
  type AnchorProbeRequest,
  type AnchorProbeResponse,
  type AnchorProbeSnapshot,
} from './probe-contract.ts';
import {
  contextDraftClaimSchema,
  contextDraftSchema,
  contextVerifyReportSchema,
  contextVerifyViolationCodes,
  frozenContextManifestSchema,
  verifyContextDraft,
  type ContextDraft,
  type ContextDraftClaim,
  type ContextVerifyReport,
  type FrozenContextManifest,
} from './context-verify.ts';
import {
  consistencyJudgementSchema,
  type ConsistencyJudgement,
} from './cluster-consistency.ts';

/**
 * AnchorProbe host-side consumer protocol (P3 / AP-16 / T-053).
 *
 * This is a library-level, model-agnostic state machine that turns one frozen
 * AnchorProbe context plus a structured model draft into a decision about what
 * may be presented or sent to an execution pre-check. It binds no model API and
 * no transport: the probe/freeze side and the model side are injected adapters.
 *
 * Protocol (fixed):
 *   1. probe  — obtain a frozen context manifest for the request;
 *   2. buffer — the model's structured draft is held in memory and never
 *      displayed, executed or forwarded before verification;
 *   3. verify — `verifyContextDraft` with one injected `now`;
 *   4. repair — at most ONE repair round, driven by a failure card fed back to
 *      the model adapter;
 *   5. card   — a second verification failure returns the evidence/gap/conflict
 *      failure card instead of another retry.
 *
 * Snapshot handling: the frozen manifest's snapshot digests are reconciled
 * against a fresh re-sample after every verification. A mismatch means the
 * frozen context no longer describes the world, so the run re-probes under the
 * total budget; when the budget cannot fund another probe the run fails closed
 * with the budget state. This deliberately does not depend on the Surface
 * `verifyContext` wiring (which today neither passes `current_snapshot` nor
 * `currentLedgerDigest`), so the consumer stays fail-closed on its own.
 *
 * Budget: one total envelope bounds probes, snapshot re-samples, model calls,
 * verification calls, distinct claims seen, a per-model-call timeout and an
 * optional overall deadline. Every exhaustion returns a failure card carrying
 * the budget status; nothing is silently truncated.
 *
 * Decision semantics: only an `ALLOW` verification verdict can put claims into
 * `displayable_claims`. `NEEDS_REVIEW` is never treated as permission — v1
 * semantic support is `unknown` for every claim, so an empty "allowed" set is a
 * legal and expected result, never fabricated into `ALLOW`.
 *
 * T-128 / ADR-011 §7.2/§7.3: the optional `consistency` judgement gates the run.
 * A `blocked`/`inconsistent` judgement stops execution before any model call
 * with an explicit failure card; a `stale`/historical judgement is passed to
 * `verifyContextDraft`, which then never allows displayable claims. The
 * `CONSUMER_MAX_REPAIRS=1` budget semantics are unchanged.
 *
 * Boundaries:
 *   - the output is deliberately NOT Gate-shaped: it carries no `evidence_id`,
 *     `verdict` or `task_id` and never triggers done/approve/cutover;
 *   - MCP cannot intercept text a client emits after this call returns; this
 *     module makes no such claim and changes no ZCode/MCP configuration;
 *   - claim/evidence text is untrusted inert input; nothing here executes it.
 *
 * Conventions follow `probe-contract.ts` / `context-verify.ts`: snake_case,
 * `.strict()` objects, bounded identifiers, explicit null for unknown values.
 */

export const CONSUMER_PROTOCOL_SCHEMA_VERSION = 'anchorprobe.consumer.v1';
export const CONSUMER_FAILURE_CARD_SCHEMA_VERSION = 'anchorprobe.consumer-failure.v1';
/** The protocol allows exactly one repair round; a second failure is terminal. */
export const CONSUMER_MAX_REPAIRS = 1;
const CONSUMER_MAX_EVENTS = 128;
const CONSUMER_DEFAULT_MODEL_TIMEOUT_MS = 30_000;

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u, 'expected a bounded identifier');
const claimId = z.string().regex(/^C[0-9]{1,6}$/u, 'expected a claim alias such as C1');

/**
 * Local restatement of the AP-12 violation shape: `context-verify.ts` does not
 * export its violation schema, and that file is not ours to change. The shape
 * is kept identical so a failure card can embed violations even when the
 * report itself is unavailable.
 */
const consumerViolationSchema = z.object({
  code: z.enum(contextVerifyViolationCodes),
  severity: z.enum(['block', 'review']),
  message: z.string().min(1).max(2000),
  claim_id: claimId.optional(),
  ref: anchorProbeAliasRefSchema.optional(),
}).strict();

export const consumerOutcomeSchema = z.enum(['ALLOWED', 'NEEDS_REVIEW', 'BLOCKED', 'FAILED']);
export type ConsumerOutcome = z.infer<typeof consumerOutcomeSchema>;

const consumerEventPhaseSchema = z.enum(['probe', 'model', 'verify', 'reconcile', 'decision', 'budget']);
export type ConsumerEventPhase = z.infer<typeof consumerEventPhaseSchema>;

export const consumerEventSchema = z.object({
  seq: z.number().int().nonnegative(),
  phase: consumerEventPhaseSchema,
  ok: z.boolean(),
  detail: z.string().min(1).max(2000),
}).strict();
export type ConsumerEvent = z.infer<typeof consumerEventSchema>;

/**
 * Total run budget. Every knob is a hard ceiling, not a suggestion: hitting one
 * ends the run with a failure card instead of quietly continuing.
 */
export const consumerBudgetSchema = z.object({
  /** Full probe runs (the initial probe plus any snapshot-driven re-probe). */
  max_probes: z.number().int().positive().max(256),
  /** Snapshot re-samples used for staleness reconciliation. */
  max_resamples: z.number().int().positive().max(256),
  /** Model calls (generations plus repairs). */
  max_model_calls: z.number().int().positive().max(256),
  /** Verification calls. */
  max_verify_calls: z.number().int().positive().max(256),
  /** Distinct claims observed across every buffered draft. */
  max_claims: z.number().int().positive().max(10_000),
  /** Per model-call timeout; a exceeded call is a failure, never a hang. */
  model_timeout_ms: z.number().int().positive().max(3_600_000).optional(),
  /** Overall wall-clock budget measured from run start. */
  deadline_ms: z.number().int().positive().max(86_400_000).optional(),
}).strict();
export type ConsumerBudget = z.infer<typeof consumerBudgetSchema>;

/** Partial overrides merged over {@link CONSUMER_DEFAULT_BUDGET}. */
export const consumerBudgetOverridesSchema = z.object({
  max_probes: z.number().int().positive().max(256).optional(),
  max_resamples: z.number().int().positive().max(256).optional(),
  max_model_calls: z.number().int().positive().max(256).optional(),
  max_verify_calls: z.number().int().positive().max(256).optional(),
  max_claims: z.number().int().positive().max(10_000).optional(),
  model_timeout_ms: z.number().int().positive().max(3_600_000).optional(),
  deadline_ms: z.number().int().positive().max(86_400_000).optional(),
}).strict();
export type ConsumerBudgetOverrides = z.infer<typeof consumerBudgetOverridesSchema>;

/**
 * Defaults are protocol-shaped, not measured optima: one re-probe and one
 * repair fit inside them, with headroom for a re-probe plus repair.
 */
export const CONSUMER_DEFAULT_BUDGET: ConsumerBudget = {
  max_probes: 2,
  max_resamples: 2,
  max_model_calls: 3,
  max_verify_calls: 4,
  max_claims: 64,
  model_timeout_ms: CONSUMER_DEFAULT_MODEL_TIMEOUT_MS,
};

export const consumerBudgetStatusSchema = z.object({
  max_probes: z.number().int().nonnegative(),
  probes_used: z.number().int().nonnegative(),
  max_resamples: z.number().int().nonnegative(),
  resamples_used: z.number().int().nonnegative(),
  max_model_calls: z.number().int().nonnegative(),
  model_calls_used: z.number().int().nonnegative(),
  max_verify_calls: z.number().int().nonnegative(),
  verify_calls_used: z.number().int().nonnegative(),
  max_claims: z.number().int().nonnegative(),
  claims_seen: z.number().int().nonnegative(),
  max_repairs: z.number().int().nonnegative(),
  repairs_used: z.number().int().nonnegative(),
  deadline_ms: z.number().int().positive().nullable(),
  elapsed_ms: z.number().int().nonnegative(),
  exhausted: z.boolean(),
  reason: z.string().min(1).max(2000).nullable(),
}).strict();
export type ConsumerBudgetStatus = z.infer<typeof consumerBudgetStatusSchema>;

/**
 * Failure card: the terminal artifact for BLOCKED/FAILED runs. It carries the
 * verification report, the probe's evidence/gaps/conflicts, the budget state
 * and the bounded event trace. It never carries Gate-shaped fields.
 */
export const consumerFailureCardSchema = z.object({
  schema_version: z.literal(CONSUMER_FAILURE_CARD_SCHEMA_VERSION),
  reason: z.string().min(1).max(2000),
  context_id: identifier.nullable(),
  project_scope: identifier.nullable(),
  report: contextVerifyReportSchema.nullable(),
  violations: z.array(consumerViolationSchema),
  evidence: z.array(anchorProbeEvidenceSchema),
  gaps: z.array(anchorProbeGapSchema),
  conflicts: z.array(anchorProbeConflictSchema),
  budget: consumerBudgetStatusSchema,
  events: z.array(consumerEventSchema),
}).strict();
export type ConsumerFailureCard = z.infer<typeof consumerFailureCardSchema>;

export const consumerRunResultSchema = z.object({
  schema_version: z.literal(CONSUMER_PROTOCOL_SCHEMA_VERSION),
  outcome: consumerOutcomeSchema,
  /** Empty unless the outcome is ALLOWED; the only claims a host may render. */
  displayable_claims: z.array(contextDraftClaimSchema),
  context_id: identifier.nullable(),
  report: contextVerifyReportSchema.nullable(),
  failure: consumerFailureCardSchema.nullable(),
  budget: consumerBudgetStatusSchema,
  events: z.array(consumerEventSchema),
  /**
   * T-128: the cluster-consistency judgement the run was gated on, when the
   * caller supplied one. Null when the run used no distributed gate. Diagnostic
   * only; it never carries Gate-shaped values.
   */
  consistency: consistencyJudgementSchema.nullable(),
  /** v1 constant: semantic support between claim text and evidence is unknown. */
  semantic_support: z.literal('unknown'),
  untrusted: z.literal(true),
}).strict();
export type ConsumerRunResult = z.infer<typeof consumerRunResultSchema>;

export interface ConsumerDecision {
  readonly outcome: ConsumerOutcome;
  readonly displayable_claims: ContextDraftClaim[];
  readonly reason: string;
}

/** Thrown for caller-envelope misuse (invalid request/budget/clock/adapter). */
export class ConsumerInputError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ConsumerInputError';
  }
}

/** Raised internally when a model call exceeds its timeout. */
export class ConsumerTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConsumerTimeoutError';
  }
}

// ============================================================================
// Injected adapters
// ============================================================================

export interface ConsumerProbeRunInput {
  readonly request: AnchorProbeRequest;
  /** The single deterministic clock for the whole run. */
  readonly now: string;
  /** 1-based probe attempt number. */
  readonly attempt: number;
}

export interface ConsumerProbeRunResult {
  /** Frozen server-side context view; never re-submitted client bytes. */
  readonly manifest: FrozenContextManifest;
  /** The raw probe response the manifest was frozen from. */
  readonly response: AnchorProbeResponse;
}

export interface ConsumerSnapshotSampleInput {
  readonly request: AnchorProbeRequest;
  readonly now: string;
}

/**
 * The probe/freeze/transport port. `run` performs one full read-only probe and
 * returns its frozen manifest; `sampleSnapshot` re-samples the current snapshot
 * digests for staleness reconciliation. Implementations adapt the Surface
 * `memoryProbeSurface` + `ProbeManifestStore` path; the consumer stays free of
 * storage and of any specific transport.
 */
export interface ConsumerProbeAdapter {
  run(input: ConsumerProbeRunInput): Promise<ConsumerProbeRunResult> | ConsumerProbeRunResult;
  sampleSnapshot(input: ConsumerSnapshotSampleInput): Promise<AnchorProbeSnapshot> | AnchorProbeSnapshot;
}

export interface ConsumerModelGenerateInput {
  readonly request: AnchorProbeRequest;
  readonly manifest: FrozenContextManifest;
  readonly response: AnchorProbeResponse;
  readonly now: string;
  /** 1 for the first generation, 2 for the single repaired generation. */
  readonly generation: number;
}

export interface ConsumerModelRepairInput {
  readonly request: AnchorProbeRequest;
  readonly manifest: FrozenContextManifest;
  readonly response: AnchorProbeResponse;
  readonly now: string;
  readonly generation: number;
  /** The buffered draft that failed, verbatim and untrusted. */
  readonly draft: unknown;
  /** The failure card derived from the failed verification. */
  readonly failure: ConsumerFailureCard;
}

/**
 * The model port. `generate` produces the first structured draft; `repair`
 * optionally produces one repaired draft from a failure card. Returned values
 * are buffered and validated — a garbage value becomes a `draft_invalid`
 * BLOCK, never an exception and never a displayed answer.
 */
export interface ConsumerModelAdapter {
  generate(input: ConsumerModelGenerateInput): Promise<unknown> | unknown;
  repair?(input: ConsumerModelRepairInput): Promise<unknown> | unknown;
}

export interface ConsumerRunInput {
  /** Raw AnchorProbe request; validated against the AP-02 contract. */
  readonly request: unknown;
  readonly probe: ConsumerProbeAdapter;
  readonly model: ConsumerModelAdapter;
  readonly budget?: ConsumerBudgetOverrides;
  /** Single deterministic clock; defaults to the real time. */
  readonly now?: string;
  /**
   * T-128 / ADR-011 §7.2: optional cluster-consistency judgement for the frozen
   * context. A `blocked` or `inconsistent` judgement stops the run before any
   * model call with an explicit failure card; a `stale`/historical judgement is
   * handed to `verifyContextDraft`, which then never allows displayable claims.
   */
  readonly consistency?: ConsistencyJudgement;
  /** Optional observer for the bounded event trace. */
  readonly observer?: (event: ConsumerEvent) => void;
}

interface ConsumerState {
  probesUsed: number;
  resamplesUsed: number;
  modelCallsUsed: number;
  verifyCallsUsed: number;
  claimsSeen: number;
  repairsUsed: number;
}

/**
 * Pure decision seam: map a verification report to an outcome and the only
 * claims a host may display. Exported so the ALLOW path is testable without
 * stubbing the verifier (the runtime always uses the real `verifyContextDraft`).
 */
export function decideConsumerOutcome(
  report: ContextVerifyReport,
  draft: ContextDraft | null,
): ConsumerDecision {
  if (report.status === 'ALLOW') {
    const blockedClaimIds = new Set<string>();
    for (const violation of report.violations) {
      if (violation.severity === 'block' && violation.claim_id !== undefined) {
        blockedClaimIds.add(violation.claim_id);
      }
    }
    const claims = draft?.claims.filter((claim) => !blockedClaimIds.has(claim.id)) ?? [];
    return { outcome: 'ALLOWED', displayable_claims: claims, reason: 'verification_allowed' };
  }
  if (report.status === 'NEEDS_REVIEW') {
    // v1 never returns ALLOW: semantic support is unknown, so nothing may be
    // presented as verified. This is an honest outcome, not a fabricated ALLOW.
    return { outcome: 'NEEDS_REVIEW', displayable_claims: [], reason: 'semantic_support_unknown' };
  }
  return { outcome: 'BLOCKED', displayable_claims: [], reason: 'verification_blocked' };
}

/**
 * Run the consumer protocol once. Caller-envelope misuse throws
 * {@link ConsumerInputError}; every runtime failure (probe, model, timeout,
 * snapshot instability, budget exhaustion) returns a failure card.
 */
export async function runConsumer(input: ConsumerRunInput): Promise<ConsumerRunResult> {
  assertEnvelope(input);
  const request = parseRequest(input.request);
  const now = resolveNow(input.now);
  const consistencyJudgement: ConsistencyJudgement | null = input.consistency ?? null;
  const budget = mergeBudget(input.budget);
  const startedAt = Date.now();
  const deadline = budget.deadline_ms === undefined ? null : startedAt + budget.deadline_ms;

  const state: ConsumerState = {
    probesUsed: 0,
    resamplesUsed: 0,
    modelCallsUsed: 0,
    verifyCallsUsed: 0,
    claimsSeen: 0,
    repairsUsed: 0,
  };
  const events: ConsumerEvent[] = [];
  let seq = 0;
  const observe = (phase: ConsumerEventPhase, ok: boolean, detail: string): void => {
    if (events.length >= CONSUMER_MAX_EVENTS) return;
    const event: ConsumerEvent = { seq, phase, ok, detail };
    seq += 1;
    events.push(event);
    input.observer?.(event);
  };

  const makeBudget = (exhausted: boolean, reason: string | null): ConsumerBudgetStatus => ({
    max_probes: budget.max_probes,
    probes_used: state.probesUsed,
    max_resamples: budget.max_resamples,
    resamples_used: state.resamplesUsed,
    max_model_calls: budget.max_model_calls,
    model_calls_used: state.modelCallsUsed,
    max_verify_calls: budget.max_verify_calls,
    verify_calls_used: state.verifyCallsUsed,
    max_claims: budget.max_claims,
    claims_seen: state.claimsSeen,
    max_repairs: CONSUMER_MAX_REPAIRS,
    repairs_used: state.repairsUsed,
    deadline_ms: budget.deadline_ms ?? null,
    elapsed_ms: Date.now() - startedAt,
    exhausted,
    reason,
  });

  const buildCard = (
    reason: string,
    manifest: FrozenContextManifest | null,
    response: AnchorProbeResponse | null,
    report: ContextVerifyReport | null,
    budgetStatus: ConsumerBudgetStatus,
  ): ConsumerFailureCard => ({
    schema_version: CONSUMER_FAILURE_CARD_SCHEMA_VERSION,
    reason,
    context_id: manifest?.context_id ?? report?.context_id ?? null,
    project_scope: manifest?.project_scope ?? null,
    report,
    violations: report?.violations ?? [],
    evidence: response?.active_evidence ?? [],
    gaps: response?.gaps ?? [],
    conflicts: response?.conflicts ?? [],
    budget: budgetStatus,
    events: [...events],
  });

  const fail = (
    reason: string,
    manifest: FrozenContextManifest | null,
    response: AnchorProbeResponse | null,
    report: ContextVerifyReport | null,
    exhausted: boolean,
  ): ConsumerRunResult => {
    observe('budget', false, reason);
    const budgetStatus = makeBudget(exhausted, exhausted ? reason : null);
    return {
      schema_version: CONSUMER_PROTOCOL_SCHEMA_VERSION,
      outcome: 'FAILED',
      displayable_claims: [],
      context_id: manifest?.context_id ?? report?.context_id ?? null,
      report,
      failure: buildCard(reason, manifest, response, report, budgetStatus),
      budget: budgetStatus,
      events: [...events],
      consistency: consistencyJudgement,
      semantic_support: 'unknown',
      untrusted: true,
    };
  };

  const succeed = (
    outcome: 'ALLOWED' | 'NEEDS_REVIEW',
    decision: ConsumerDecision,
    manifest: FrozenContextManifest,
    response: AnchorProbeResponse,
    report: ContextVerifyReport,
  ): ConsumerRunResult => {
    const budgetStatus = makeBudget(false, null);
    return {
      schema_version: CONSUMER_PROTOCOL_SCHEMA_VERSION,
      outcome,
      displayable_claims: decision.displayable_claims,
      context_id: manifest.context_id,
      report,
      failure: null,
      budget: budgetStatus,
      events: [...events],
      consistency: consistencyJudgement,
      semantic_support: 'unknown',
      untrusted: true,
    };
  };

  const blocked = (
    reason: string,
    manifest: FrozenContextManifest,
    response: AnchorProbeResponse,
    report: ContextVerifyReport,
  ): ConsumerRunResult => {
    observe('decision', false, reason);
    const budgetStatus = makeBudget(false, null);
    return {
      schema_version: CONSUMER_PROTOCOL_SCHEMA_VERSION,
      outcome: 'BLOCKED',
      displayable_claims: [],
      context_id: manifest.context_id,
      report,
      failure: buildCard(reason, manifest, response, report, budgetStatus),
      budget: budgetStatus,
      events: [...events],
      consistency: consistencyJudgement,
      semantic_support: 'unknown',
      untrusted: true,
    };
  };

  let manifest: FrozenContextManifest | null = null;
  let response: AnchorProbeResponse | null = null;
  let draftRaw: unknown = null;
  let draftParsed: ContextDraft | null = null;
  let report: ContextVerifyReport | null = null;
  /** The buffered draft that failed verification, fed back to the repair call. */
  let repairDraft: unknown = undefined;
  let generation = 1;
  let repaired = false;
  let repairCard: ConsumerFailureCard | null = null;

  const deadlineReason = (): string | null => (
    deadline !== null && Date.now() >= deadline ? 'deadline_exceeded' : null
  );

  for (;;) {
    const expired = deadlineReason();
    if (expired !== null) return fail(expired, manifest, response, report, true);

    // --- Phase 1: obtain a frozen context -------------------------------
    if (manifest === null || response === null) {
      if (state.probesUsed >= budget.max_probes) {
        return fail('probe_budget_exhausted', manifest, response, report, true);
      }
      let run: ConsumerProbeRunResult;
      try {
        run = await input.probe.run({ request, now, attempt: state.probesUsed + 1 });
      } catch (error) {
        return fail(`probe_error: ${errorMessage(error)}`, null, null, null, false);
      }
      state.probesUsed += 1;
      const validated = validateProbeRun(run, request);
      if (typeof validated === 'string') {
        return fail(validated, null, null, null, false);
      }
      manifest = validated.manifest;
      response = validated.response;
      draftRaw = null;
      draftParsed = null;
      report = null;
      repairCard = null;
      generation = 1;
      observe('probe', true, `probe ${state.probesUsed} returned context ${manifest.context_id}`);
      if (manifest.execution_status === 'FAILED') {
        return fail('probe_execution_failed', manifest, response, null, false);
      }
      if (manifest.execution_status === 'SNAPSHOT_UNSTABLE') {
        if (state.probesUsed < budget.max_probes) {
          observe('probe', false, 'snapshot_unstable_reprobe');
          manifest = null;
          response = null;
          continue;
        }
        return fail('snapshot_unstable', manifest, response, null, true);
      }
    }

    // Narrowing guard: the probe block above either populated both or left the
    // loop, so both are present here. Kept explicit so later closures stay sound.
    if (manifest === null || response === null) {
      return fail('probe_unavailable', manifest, response, report, false);
    }
    const activeManifest: FrozenContextManifest = manifest;
    const activeResponse: AnchorProbeResponse = response;

    // --- T-128 gate: a refused/inconsistent cluster verdict stops execution --
    // The gate runs before any model call so an unusable context can never be
    // turned into a draft, a repair round or a displayed claim (ADR-011 §7.2).
    if (consistencyJudgement !== null
      && (consistencyJudgement.status === 'blocked' || consistencyJudgement.status === 'inconsistent')) {
      const code = consistencyJudgement.code === null ? '' : `: ${consistencyJudgement.code}`;
      return fail(`consistency_${consistencyJudgement.status}${code}`, activeManifest, activeResponse, null, false);
    }

    // --- Phase 2: buffer a draft ----------------------------------------
    if (draftRaw === null) {
      const expiredBeforeModel = deadlineReason();
      if (expiredBeforeModel !== null) return fail(expiredBeforeModel, activeManifest, activeResponse, report, true);
      if (state.modelCallsUsed >= budget.max_model_calls) {
        return fail('model_budget_exhausted', activeManifest, activeResponse, report, true);
      }
      const repairFn = input.model.repair;
      const wantRepair = generation >= 2 && repairCard !== null && typeof repairFn === 'function';
      let raw: unknown;
      try {
        if (wantRepair && repairFn !== undefined && repairCard !== null) {
          const activeRepairCard: ConsumerFailureCard = repairCard;
          raw = await invokeModel('repair', budget.model_timeout_ms ?? CONSUMER_DEFAULT_MODEL_TIMEOUT_MS, () => repairFn({
            request,
            manifest: activeManifest,
            response: activeResponse,
            now,
            generation,
            draft: repairDraft,
            failure: activeRepairCard,
          }));
        } else {
          raw = await invokeModel('generate', budget.model_timeout_ms ?? CONSUMER_DEFAULT_MODEL_TIMEOUT_MS, () => input.model.generate({
            request,
            manifest: activeManifest,
            response: activeResponse,
            now,
            generation,
          }));
        }
      } catch (error) {
        if (error instanceof ConsumerTimeoutError) {
          return fail('model_timeout', activeManifest, activeResponse, report, false);
        }
        return fail(`model_error: ${errorMessage(error)}`, activeManifest, activeResponse, report, false);
      }
      state.modelCallsUsed += 1;
      draftRaw = raw;
      const parsed = contextDraftSchema.safeParse(raw);
      draftParsed = parsed.success ? parsed.data : null;
      const newClaims = draftParsed?.claims.length ?? 0;
      state.claimsSeen += newClaims;
      if (state.claimsSeen > budget.max_claims) {
        return fail('claim_budget_exhausted', activeManifest, activeResponse, null, true);
      }
      observe('model', true, `${wantRepair ? 'repair' : 'generate'} returned ${newClaims} claim(s)`);
    }

    // --- Phase 3: verify the buffered draft -----------------------------
    const expiredBeforeVerify = deadlineReason();
    if (expiredBeforeVerify !== null) return fail(expiredBeforeVerify, activeManifest, activeResponse, report, true);
    if (state.verifyCallsUsed >= budget.max_verify_calls) {
      return fail('verify_budget_exhausted', activeManifest, activeResponse, report, true);
    }
    try {
      report = verifyContextDraft({
        manifest: activeManifest,
        draft: draftRaw,
        root: request.root,
        now,
        ...(consistencyJudgement === null ? {} : { consistency: consistencyJudgement }),
      });
    } catch (error) {
      return fail(`verify_error: ${errorMessage(error)}`, activeManifest, activeResponse, null, false);
    }
    state.verifyCallsUsed += 1;
    observe('verify', report.status !== 'BLOCK', `verify ${state.verifyCallsUsed} -> ${report.status}`);

    // --- Phase 4: reconcile the snapshot after every verification --------
    const expiredBeforeSample = deadlineReason();
    if (expiredBeforeSample !== null) return fail(expiredBeforeSample, activeManifest, activeResponse, report, true);
    if (state.resamplesUsed >= budget.max_resamples) {
      return fail('resample_budget_exhausted', activeManifest, activeResponse, report, true);
    }
    let resample: AnchorProbeSnapshot;
    try {
      resample = await input.probe.sampleSnapshot({ request, now });
    } catch (error) {
      return fail(`snapshot_sample_error: ${errorMessage(error)}`, activeManifest, activeResponse, report, false);
    }
    state.resamplesUsed += 1;
    if (!snapshotsEqual(resample, activeManifest.snapshot)) {
      observe('reconcile', false, 'snapshot_changed');
      if (state.probesUsed < budget.max_probes) {
        manifest = null;
        response = null;
        draftRaw = null;
        draftParsed = null;
        report = null;
        repairCard = null;
        generation = 1;
        continue;
      }
      return fail('snapshot_unstable_budget_exhausted', activeManifest, activeResponse, report, true);
    }
    observe('reconcile', true, 'snapshot_matches');

    // --- Phase 5: decide -------------------------------------------------
    const decision = decideConsumerOutcome(report, draftParsed);
    // Defense in depth: a non-consistent cluster verdict can never release
    // displayable claims, even if a future verifier reports ALLOW. The v1
    // verifier already refuses ALLOW for such inputs; this keeps the contract
    // explicit at the consumer boundary.
    if (consistencyJudgement !== null && consistencyJudgement.status !== 'consistent' && decision.outcome === 'ALLOWED') {
      observe('decision', false, `consistency_${consistencyJudgement.status}`);
      return blocked(`consistency_${consistencyJudgement.status}`, activeManifest, activeResponse, report);
    }
    if (decision.outcome === 'ALLOWED') {
      observe('decision', true, 'allowed');
      return succeed('ALLOWED', decision, activeManifest, activeResponse, report);
    }
    if (decision.outcome === 'NEEDS_REVIEW') {
      observe('decision', true, 'needs_review');
      return succeed('NEEDS_REVIEW', decision, activeManifest, activeResponse, report);
    }

    // BLOCK: one repair round at most, and only when the budget can fund it.
    if (!repaired && typeof input.model.repair === 'function' && state.modelCallsUsed < budget.max_model_calls) {
      repaired = true;
      state.repairsUsed += 1;
      generation = 2;
      repairCard = buildCard(
        'verification_blocked',
        activeManifest,
        activeResponse,
        report,
        makeBudget(false, null),
      );
      repairDraft = draftRaw;
      draftRaw = null;
      draftParsed = null;
      report = null;
      observe('decision', true, 'repair_scheduled');
      continue;
    }
    const reason = typeof input.model.repair !== 'function'
      ? 'verification_blocked_no_repair'
      : (state.modelCallsUsed >= budget.max_model_calls ? 'verification_blocked_repair_budget_exhausted' : 'verification_blocked');
    return blocked(reason, activeManifest, activeResponse, report);
  }
}

// ============================================================================
// Internal helpers
// ============================================================================

function assertEnvelope(input: ConsumerRunInput): void {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ConsumerInputError('consumer input must be an object');
  }
  const probe = input.probe as Partial<ConsumerProbeAdapter> | undefined;
  if (probe === null || typeof probe !== 'object' || typeof probe.run !== 'function' || typeof probe.sampleSnapshot !== 'function') {
    throw new ConsumerInputError('consumer probe adapter must implement run() and sampleSnapshot()');
  }
  const model = input.model as Partial<ConsumerModelAdapter> | undefined;
  if (model === null || typeof model !== 'object' || typeof model.generate !== 'function') {
    throw new ConsumerInputError('consumer model adapter must implement generate()');
  }
  if (input.observer !== undefined && typeof input.observer !== 'function') {
    throw new ConsumerInputError('consumer observer must be a function');
  }
  if (input.consistency !== undefined && !consistencyJudgementSchema.safeParse(input.consistency).success) {
    throw new ConsumerInputError('consumer consistency must be a ConsistencyJudgement produced by judgeConsistency');
  }
}

function parseRequest(raw: unknown): AnchorProbeRequest {
  try {
    return anchorProbeRequestSchema.parse(raw);
  } catch (error) {
    throw new ConsumerInputError('consumer request failed the AP-02 AnchorProbe request contract', { cause: error });
  }
}

function resolveNow(value: string | undefined): string {
  if (value === undefined) return new Date().toISOString();
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new ConsumerInputError('consumer now must be an ISO-8601 timestamp');
  }
  return value;
}

function mergeBudget(overrides: ConsumerBudgetOverrides | undefined): ConsumerBudget {
  const merged: ConsumerBudget = {
    max_probes: overrides?.max_probes ?? CONSUMER_DEFAULT_BUDGET.max_probes,
    max_resamples: overrides?.max_resamples ?? CONSUMER_DEFAULT_BUDGET.max_resamples,
    max_model_calls: overrides?.max_model_calls ?? CONSUMER_DEFAULT_BUDGET.max_model_calls,
    max_verify_calls: overrides?.max_verify_calls ?? CONSUMER_DEFAULT_BUDGET.max_verify_calls,
    max_claims: overrides?.max_claims ?? CONSUMER_DEFAULT_BUDGET.max_claims,
    model_timeout_ms: overrides?.model_timeout_ms ?? CONSUMER_DEFAULT_BUDGET.model_timeout_ms,
    ...(overrides?.deadline_ms === undefined ? {} : { deadline_ms: overrides.deadline_ms }),
  };
  const parsed = consumerBudgetSchema.safeParse(merged);
  if (!parsed.success) {
    throw new ConsumerInputError(`consumer budget is invalid: ${firstIssueMessage(parsed.error)}`);
  }
  return parsed.data;
}

function validateProbeRun(
  run: ConsumerProbeRunResult,
  request: AnchorProbeRequest,
): { readonly manifest: FrozenContextManifest; readonly response: AnchorProbeResponse } | string {
  if (run === null || typeof run !== 'object' || Array.isArray(run)) {
    return 'probe adapter returned a non-object result';
  }
  const manifest = frozenContextManifestSchema.safeParse(run.manifest);
  if (!manifest.success) return 'probe adapter returned an invalid frozen context manifest';
  const response = anchorProbeResponseSchema.safeParse(run.response);
  if (!response.success) return 'probe adapter returned an invalid AnchorProbe context response';
  const activeManifest = manifest.data;
  const activeResponse = response.data;
  if (activeManifest.context_id !== activeResponse.context_id) {
    return 'probe manifest context_id does not match the probe response';
  }
  if (activeManifest.project_scope !== activeResponse.snapshot.project_scope) {
    return 'probe manifest scope does not match the response snapshot scope';
  }
  if (activeManifest.root !== request.root) {
    return 'probe manifest root does not match the probe request root';
  }
  if (activeManifest.execution_status !== activeResponse.execution_status) {
    return 'probe manifest execution_status does not match the probe response';
  }
  if (!snapshotsEqual(activeManifest.snapshot, activeResponse.snapshot)) {
    return 'probe manifest snapshot does not match the probe response snapshot';
  }
  return { manifest: activeManifest, response: activeResponse };
}

function snapshotsEqual(left: AnchorProbeSnapshot, right: AnchorProbeSnapshot): boolean {
  return left.project_scope === right.project_scope
    && left.ledger_digest === right.ledger_digest
    && left.graph_revision === right.graph_revision
    && left.source_fingerprint === right.source_fingerprint
    && left.connected_digest === right.connected_digest;
}

async function invokeModel<T>(
  label: string,
  timeoutMs: number,
  thunk: () => Promise<T> | T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(thunk),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new ConsumerTimeoutError(`${label} exceeded the ${timeoutMs}ms model timeout`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function firstIssueMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue === undefined ? 'invalid payload' : `${issue.path.join('.')}: ${issue.message}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
