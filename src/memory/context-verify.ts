import { z } from 'zod';
import {
  anchorProbeAliasRefSchema,
  anchorProbeBudgetStatusSchema,
  anchorProbeCoverageGateSchema,
  anchorProbeEvidenceSchema,
  anchorProbeExecutionStatuses,
  anchorProbeSnapshotSchema,
  anchorProbeTemporalModes,
  anchorProbeTombstoneSchema,
  type AnchorProbeClusterMetadata,
  type AnchorProbeEvidence,
  type AnchorProbeSnapshot,
  type AnchorProbeTombstone,
} from './probe-contract.ts';
import type { ConsistencyJudgement } from './cluster-consistency.ts';

/**
 * AnchorProbe context answer validation (P2 / AP-12).
 *
 * A deterministic validator for structured answers ("drafts") produced by a
 * consumer against a frozen server-side context manifest. It checks only what
 * can be decided without interpreting language:
 *   - strict draft/manifest schemas, enums and size bounds (unknown fields are
 *     rejected, nothing is defaulted into existence);
 *   - evidence alias references are unique per claim and resolve into the
 *     frozen manifest's evidence set (active evidence + tombstones);
 *   - project scope, bound root, context id, schema versions and expiry must
 *     match; a re-sampled snapshot must equal the frozen one when provided;
 *   - claims may not cite deprecated/retracted evidence as current, may not
 *     mix active and deprecated eras in one claim, and may not assert a fact
 *     the probe reported as missing;
 *   - parameter assertions must be formalized in the manifest rules and match
 *     their canonical value exactly.
 *
 * What it deliberately does NOT do:
 *   - it never verifies that the cited evidence semantically supports the
 *     claim text. Having references is not proof of support; natural-language
 *     support is `unknown` in this first version, so every structurally clean
 *     draft comes back `NEEDS_REVIEW`. `ALLOW` exists in the status enum for a
 *     future replaceable semantic adapter, but v1 never returns it and no
 *     generalized `passed=true` is produced anywhere.
 *   - it never starts a shell, executes draft text or treats claim text as
 *     anything but inert, untrusted bytes;
 *   - it never emits Gate-shaped output: the report carries no `evidence_id`,
 *     no `verdict`, no `task_id` and cannot enter the task/release evidence
 *     channel. It does not set done/approve/cutover state anywhere.
 *
 * The manifest input is the frozen-context view required by the AP-12
 * contract (reference map, content digests, version, scope, source freshness,
 * rules and evidence text). It is parsed as untrusted data; integration with
 * the concrete probe-manifest store adapts to this shape, not vice versa.
 *
 * Integration boundary with T-048 (`src/memory/probe-manifest.ts`): that store
 * owns the on-disk body (binding/rules/freshness/reference_map/response plus a
 * canonical `body_digest`). The adapter that hands a stored body to this
 * validator must project it onto `FrozenContextManifest`: context_id;
 * created_at←freshness.frozen_at; expires_at←freshness.expires_at;
 * root/project_scope←binding; temporal_mode/budget_status/execution_status and
 * snapshot/coverage_gate/active_evidence/deprecated_tombstones←response;
 * formalized parameter rules are not part of the probe request, so v1 supplies
 * none (every asserted parameter is reported as `unformalized_param`).
 *
 * Violations carry a severity: `block` contradictions refuse the draft,
 * `review` findings (for example a parameter with no formalized rule) leave
 * the draft structurally grounded but unverifiable. v1 never returns ALLOW
 * because natural-language support is unknown for every claim.
 *
 * T-128 / ADR-011 §7.2: the optional `consistency` input accepts a
 * `ConsistencyJudgement` (from `cluster-consistency.ts`) or frozen cluster
 * metadata. A blocked/inconsistent judgement is a BLOCK contradiction; stale or
 * explicitly historical evidence is a review finding. The input can only lower
 * the verdict, so the three-state semantics and every pre-T-128 assertion stay
 * intact when it is omitted.
 *
 * Conventions follow `probe-contract.ts`: snake_case fields, `.strict()`
 * objects, lowercase sha256 hex, bounded identifiers, ISO-8601 timestamps.
 */

export const CONTEXT_DRAFT_SCHEMA_VERSION = 'anchorprobe.draft.v1';
export const CONTEXT_VERIFY_SCHEMA_VERSION = 'anchorprobe.context-verify.v1';

/** Manifest schema versions this validator accepts; anything newer is blocked. */
export const supportedManifestSchemaVersions = ['anchorprobe.manifest.v1'] as const;
export const SUPPORTED_MANIFEST_SCHEMA_VERSIONS = supportedManifestSchemaVersions;

export const contextClaimKinds = ['CURRENT_FACT', 'HISTORICAL_FACT', 'DERIVED', 'PROPOSAL'] as const;
export const contextVerifyStatuses = ['ALLOW', 'BLOCK', 'NEEDS_REVIEW'] as const;
export const contextVerifyCheckOutcomes = ['pass', 'fail', 'skipped'] as const;

export type ContextClaimKind = (typeof contextClaimKinds)[number];
export type ContextVerifyStatus = (typeof contextVerifyStatuses)[number];
export type ContextVerifyCheckOutcome = (typeof contextVerifyCheckOutcomes)[number];

// Bounded identifiers mirror the private patterns in probe-contract.ts; that
// module does not export them, so they are restated here once, with the same
// shape, instead of weakening to free-form strings.
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const factKeyPattern = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;
const claimIdPattern = /^C[0-9]{1,6}$/u;
const isoTimestamp = z.string().datetime();

const identifier = z.string().regex(identifierPattern, 'expected a bounded identifier');
const factKey = z.string().regex(factKeyPattern, 'expected a dotted fact key');
const claimId = z.string().regex(claimIdPattern, 'expected a claim alias such as C1');

export const contextVerifyViolationCodes = [
  'context_unknown',
  'manifest_invalid',
  'manifest_schema_unsupported',
  'draft_invalid',
  'context_id_mismatch',
  'scope_mismatch',
  'root_mismatch',
  'context_expired',
  'snapshot_scope_mismatch',
  'snapshot_mismatch',
  'duplicate_claim_id',
  'unknown_evidence_ref',
  'duplicate_evidence_ref',
  'current_fact_without_evidence',
  'historical_fact_without_evidence',
  'derived_without_evidence',
  'stale_evidence_in_current_fact',
  'stale_evidence_in_derived',
  'stale_source_cited',
  'retracted_evidence_cited',
  'mixed_active_and_deprecated_refs',
  'fabricated_missing_fact',
  'fact_key_out_of_scope',
  'claim_unresolved_conflict',
  'not_applicable_conflict',
  'unformalized_param',
  'constraint_mismatch',
  'context_unstable',
  'context_degraded',
  'context_incomplete',
  'consistency_blocked',
  'consistency_inconsistent',
  'consistency_stale',
  'consistency_historical',
  'violation_cap_reached',
] as const;
export type ContextViolationCode = (typeof contextVerifyViolationCodes)[number];

/**
 * `block` contradictions refuse the draft outright; `review` findings are
 * deterministic but leave semantics unproven, so the verdict is NEEDS_REVIEW.
 */
export type ContextViolationSeverity = 'block' | 'review';

const contextViolationSchema = z.object({
  code: z.enum(contextVerifyViolationCodes),
  severity: z.enum(['block', 'review']),
  message: z.string().min(1).max(2000),
  claim_id: claimId.optional(),
  ref: anchorProbeAliasRefSchema.optional(),
}).strict();
export type ContextViolation = z.infer<typeof contextViolationSchema>;

/** Formalized parameter binding: the only values a draft may assert. */
const contextRuleSchema = z.object({
  rule_id: identifier,
  fact_key: factKey,
  value: z.string().min(1).max(2000),
  detail: z.string().min(1).max(2000).optional(),
}).strict();
export type ContextRule = z.infer<typeof contextRuleSchema>;

/**
 * Frozen server-side context view. Field names reuse the probe contract
 * schemas so the manifest and the probe response cannot drift apart silently.
 */
export const frozenContextManifestSchema = z.object({
  schema_version: z.string().regex(/^anchorprobe\.manifest\.v[1-9][0-9]*$/u, 'expected an anchorprobe.manifest.vN version'),
  context_id: identifier,
  created_at: isoTimestamp,
  /** TTL is mandatory: frozen contexts are derived material, not archives. */
  expires_at: isoTimestamp,
  /** Canonical root the context was sampled under. */
  root: z.string().min(1).max(4096),
  project_scope: identifier,
  temporal_mode: z.enum(anchorProbeTemporalModes),
  /** Frozen execution/completeness state; a failed context cannot ground answers. */
  execution_status: z.enum(anchorProbeExecutionStatuses),
  budget_status: anchorProbeBudgetStatusSchema,
  snapshot: anchorProbeSnapshotSchema,
  coverage_gate: anchorProbeCoverageGateSchema,
  rules: z.array(contextRuleSchema).max(256),
  active_evidence: z.array(anchorProbeEvidenceSchema).max(10_000),
  deprecated_tombstones: z.array(anchorProbeTombstoneSchema).max(10_000),
}).strict().superRefine((value, context) => {
  const aliases = new Set<string>();
  for (const [group, items] of [
    ['active_evidence', value.active_evidence],
    ['deprecated_tombstones', value.deprecated_tombstones],
  ] as const) {
    items.forEach((item, index) => {
      if (aliases.has(item.ref)) {
        context.addIssue({ code: 'custom', message: `duplicate alias ${item.ref}`, path: [group, index, 'ref'] });
      }
      aliases.add(item.ref);
    });
  }

  const ruleIds = new Set<string>();
  const ruleKeys = new Set<string>();
  value.rules.forEach((rule, index) => {
    if (ruleIds.has(rule.rule_id)) {
      context.addIssue({ code: 'custom', message: `duplicate rule_id ${rule.rule_id}`, path: ['rules', index, 'rule_id'] });
    }
    ruleIds.add(rule.rule_id);
    // One canonical value per fact key; two disagreeing rules would make the
    // constraint check ambiguous, so the manifest is rejected instead.
    if (ruleKeys.has(rule.fact_key)) {
      context.addIssue({ code: 'custom', message: `duplicate rule fact_key ${rule.fact_key}`, path: ['rules', index, 'fact_key'] });
    }
    ruleKeys.add(rule.fact_key);
  });
});
export type FrozenContextManifest = z.infer<typeof frozenContextManifestSchema>;

const contextDraftParamSchema = z.object({
  key: factKey,
  value: z.string().min(1).max(1000),
}).strict();
export type ContextDraftParam = z.infer<typeof contextDraftParamSchema>;

export const contextDraftClaimSchema = z.object({
  id: claimId,
  kind: z.enum(contextClaimKinds),
  /** The declared fact this claim answers; absent for untagged statements. */
  fact_key: factKey.optional(),
  /** Inert untrusted text; never executed, never matched semantically in v1. */
  text: z.string().min(1).max(4000),
  /** Alias refs into the frozen manifest's evidence set; unique per claim. */
  evidence_refs: z.array(anchorProbeAliasRefSchema).max(32),
  /** Formalized parameter assertions, each bound to a manifest rule. */
  params: z.array(contextDraftParamSchema).max(32).default([]),
}).strict();
export type ContextDraftClaim = z.infer<typeof contextDraftClaimSchema>;

const contextNotApplicableSchema = z.object({
  fact_key: factKey,
  reason: z.string().min(1).max(1000),
}).strict();
export type ContextNotApplicable = z.infer<typeof contextNotApplicableSchema>;

export const contextDraftSchema = z.object({
  schema_version: z.literal(CONTEXT_DRAFT_SCHEMA_VERSION),
  context_id: identifier,
  project_scope: identifier,
  claims: z.array(contextDraftClaimSchema).max(64),
  not_applicable: z.array(contextNotApplicableSchema).max(64).default([]),
  unresolved: z.array(factKey).max(256).default([]),
}).strict();
export type ContextDraft = z.infer<typeof contextDraftSchema>;

const contextVerifyChecksSchema = z.object({
  schema: z.enum(contextVerifyCheckOutcomes),
  manifest: z.enum(contextVerifyCheckOutcomes),
  binding: z.enum(contextVerifyCheckOutcomes),
  snapshot: z.enum(contextVerifyCheckOutcomes),
  refs: z.enum(contextVerifyCheckOutcomes),
  facts: z.enum(contextVerifyCheckOutcomes),
  params: z.enum(contextVerifyCheckOutcomes),
  aggregate: z.enum(contextVerifyCheckOutcomes),
}).strict();
export type ContextVerifyChecks = z.infer<typeof contextVerifyChecksSchema>;

export const contextVerifyReportSchema = z.object({
  schema_version: z.literal(CONTEXT_VERIFY_SCHEMA_VERSION),
  status: z.enum(contextVerifyStatuses),
  /** Null when neither the manifest nor the draft names a bounded context id. */
  context_id: identifier.nullable(),
  checks: contextVerifyChecksSchema,
  violations: z.array(contextViolationSchema).max(256),
  /**
   * v1 constant: semantic support between claim text and cited evidence is
   * unknown, so a clean draft is NEEDS_REVIEW, never ALLOW. The field is the
   * seam where a replaceable semantic adapter will plug in later.
   */
  semantic_support: z.literal('unknown'),
  /** Claim text is untrusted input; the report must never say otherwise. */
  untrusted: z.literal(true),
}).strict();
export type ContextVerifyReport = z.infer<typeof contextVerifyReportSchema>;

export interface ContextVerifyInput {
  /** Parsed as untrusted data; `null` means the context_id is unknown. */
  readonly manifest: unknown;
  /** Parsed as untrusted data. */
  readonly draft: unknown;
  /** Canonical root the caller is bound to right now. */
  readonly root: string;
  /** ISO-8601 instant used for expiry; injected so checks stay deterministic. */
  readonly now: string;
  /** Optional re-sampled snapshot; when present it must equal the frozen one. */
  readonly current_snapshot?: AnchorProbeSnapshot;
  /**
   * T-128: optional cluster-consistency signal. Either a full
   * {@link ConsistencyJudgement} from `judgeConsistency`, or the frozen
   * cluster metadata block of the snapshot. A `blocked`/`inconsistent`
   * judgement is a BLOCK contradiction; a stale or explicitly historical
   * signal is a review finding, so the report can never reach ALLOW. Omitted
   * keeps the pre-T-128 behaviour byte-for-byte.
   */
  readonly consistency?: ConsistencyJudgement | AnchorProbeClusterMetadata;
}

export interface ContextVerifyJsonSchemas {
  draft: Record<string, unknown>;
  report: Record<string, unknown>;
}

const MAX_VIOLATIONS = 256;

const violationLayer = {
  context_unknown: 'manifest',
  manifest_invalid: 'manifest',
  manifest_schema_unsupported: 'manifest',
  draft_invalid: 'schema',
  context_id_mismatch: 'binding',
  scope_mismatch: 'binding',
  root_mismatch: 'binding',
  context_expired: 'binding',
  snapshot_scope_mismatch: 'snapshot',
  snapshot_mismatch: 'snapshot',
  duplicate_claim_id: 'facts',
  unknown_evidence_ref: 'refs',
  duplicate_evidence_ref: 'refs',
  current_fact_without_evidence: 'refs',
  historical_fact_without_evidence: 'refs',
  derived_without_evidence: 'refs',
  stale_evidence_in_current_fact: 'refs',
  stale_evidence_in_derived: 'refs',
  stale_source_cited: 'refs',
  retracted_evidence_cited: 'refs',
  mixed_active_and_deprecated_refs: 'refs',
  fabricated_missing_fact: 'facts',
  fact_key_out_of_scope: 'facts',
  claim_unresolved_conflict: 'facts',
  not_applicable_conflict: 'facts',
  unformalized_param: 'params',
  constraint_mismatch: 'params',
  context_unstable: 'manifest',
  context_degraded: 'manifest',
  context_incomplete: 'manifest',
  consistency_blocked: 'manifest',
  consistency_inconsistent: 'manifest',
  consistency_stale: 'manifest',
  consistency_historical: 'manifest',
  violation_cap_reached: 'aggregate',
} as const satisfies Record<ContextViolationCode, keyof ContextVerifyChecks>;

type ViolationLayer = keyof ContextVerifyChecks;

const violationSeverity: Record<ContextViolationCode, ContextViolationSeverity> = {
  context_unknown: 'block',
  manifest_invalid: 'block',
  manifest_schema_unsupported: 'block',
  draft_invalid: 'block',
  context_id_mismatch: 'block',
  scope_mismatch: 'block',
  root_mismatch: 'block',
  context_expired: 'block',
  snapshot_scope_mismatch: 'block',
  snapshot_mismatch: 'block',
  duplicate_claim_id: 'block',
  unknown_evidence_ref: 'block',
  duplicate_evidence_ref: 'block',
  current_fact_without_evidence: 'block',
  historical_fact_without_evidence: 'block',
  derived_without_evidence: 'block',
  stale_evidence_in_current_fact: 'block',
  stale_evidence_in_derived: 'block',
  stale_source_cited: 'block',
  retracted_evidence_cited: 'block',
  mixed_active_and_deprecated_refs: 'block',
  fabricated_missing_fact: 'block',
  fact_key_out_of_scope: 'block',
  claim_unresolved_conflict: 'block',
  not_applicable_conflict: 'block',
  unformalized_param: 'review',
  constraint_mismatch: 'block',
  context_unstable: 'block',
  context_degraded: 'review',
  context_incomplete: 'review',
  consistency_blocked: 'block',
  consistency_inconsistent: 'block',
  consistency_stale: 'review',
  consistency_historical: 'review',
  violation_cap_reached: 'block',
};

function makeViolation(code: ContextViolationCode, message: string, extra: { claimId?: string; ref?: string } = {}): ContextViolation {
  const out: ContextViolation = { code, severity: violationSeverity[code], message };
  if (extra.claimId !== undefined) out.claim_id = extra.claimId;
  if (extra.ref !== undefined) out.ref = extra.ref;
  return out;
}

function firstIssueMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'invalid payload';
}

function bestEffortContextId(raw: unknown): string | null {
  if (typeof raw === 'object' && raw !== null) {
    const candidate = (raw as { context_id?: unknown }).context_id;
    if (typeof candidate === 'string' && identifierPattern.test(candidate)) return candidate;
  }
  return null;
}

function boundedMessage(parts: readonly string[]): string {
  const message = parts.join('; ');
  return message.length <= 2000 ? message : `${message.slice(0, 1997)}...`;
}

function isConsistencyJudgement(
  value: ConsistencyJudgement | AnchorProbeClusterMetadata,
): value is ConsistencyJudgement {
  return 'status' in value;
}

/**
 * Project the optional cluster-consistency signal onto deterministic
 * violations. A blocked/inconsistent judgement contradicts the draft's
 * grounding, so it is a block; stale/historical signals are review findings.
 * v1 still never returns ALLOW, and this input can only lower the verdict.
 */
function consistencyViolations(
  value: ConsistencyJudgement | AnchorProbeClusterMetadata | undefined,
): ContextViolation[] {
  if (value === undefined || value === null) return [];
  const violations: ContextViolation[] = [];
  if (isConsistencyJudgement(value)) {
    const detail = boundedMessage(value.reasons);
    if (value.status === 'blocked') {
      violations.push(makeViolation('consistency_blocked', boundedMessage([
        `cluster consistency refused the context (${value.code ?? 'BLOCKED'})`,
        detail,
      ])));
    }
    if (value.status === 'inconsistent') {
      violations.push(makeViolation('consistency_inconsistent', boundedMessage([
        `cluster consistency is inconsistent (${value.code ?? 'INCONSISTENT'})`,
        detail,
      ])));
    }
    if (value.status === 'stale') {
      violations.push(makeViolation('consistency_stale', boundedMessage([
        `cluster consistency is stale (${value.code ?? 'STALE'}, lag=${String(value.lag)})`,
        detail,
      ])));
    }
    if (value.historical === true) {
      violations.push(makeViolation('consistency_historical', 'the answer is explicitly historical and cannot ground current execution'));
    }
    return violations;
  }
  if (value.consistency === 'as_of') {
    violations.push(makeViolation('consistency_historical', 'the frozen cluster metadata describes an AS_OF read, which cannot ground current execution'));
  }
  if (value.partial === true) {
    violations.push(makeViolation('consistency_stale', 'the frozen cluster metadata is partial; incomplete coverage cannot pose as healthy'));
  }
  if (typeof value.max_lag === 'number' && value.max_lag > 0) {
    violations.push(makeViolation('consistency_stale', `the frozen cluster metadata reports max_lag=${String(value.max_lag)}; replicas trail the primary commit point`));
  }
  return violations;
}

/**
 * Deterministically validate a structured draft against a frozen context.
 *
 * Untrusted payloads (manifest, draft) never make this function throw: every
 * failure becomes a BLOCK report with a bounded violation code. Only misuse
 * of the internal envelope (malformed `now`/`root`/`current_snapshot`, which
 * are caller-constructed values, not external data) throws a TypeError.
 *
 * Deterministic checks only; the semantic support between text and evidence
 * is unknown in v1, so a draft with zero violations is NEEDS_REVIEW. `ALLOW`
 * is never returned by this version.
 */
export function verifyContextDraft(input: ContextVerifyInput): ContextVerifyReport {
  const parsedNow = isoTimestamp.safeParse(input.now);
  if (!parsedNow.success) throw new TypeError('context verify input.now must be an ISO-8601 timestamp');
  const root = input.root;
  if (typeof root !== 'string' || root.length < 1 || root.length > 4096) {
    throw new TypeError('context verify input.root must be a non-empty string of at most 4096 characters');
  }
  let currentSnapshot: AnchorProbeSnapshot | null = null;
  if (input.current_snapshot !== undefined) {
    const parsed = anchorProbeSnapshotSchema.safeParse(input.current_snapshot);
    if (!parsed.success) throw new TypeError('context verify input.current_snapshot must be a valid AnchorProbe snapshot');
    currentSnapshot = parsed.data;
  }

  const violations: ContextViolation[] = [];
  let capReached = false;
  const push = (violation: ContextViolation): void => {
    if (capReached) return;
    if (violations.length >= MAX_VIOLATIONS - 1) {
      capReached = true;
      violations.push(makeViolation('violation_cap_reached', `violation list truncated at ${MAX_VIOLATIONS} entries`));
      return;
    }
    violations.push(violation);
  };

  // Layer: manifest. The frozen context is untrusted data until parsed.
  let manifest: FrozenContextManifest | null = null;
  if (input.manifest === null || input.manifest === undefined) {
    push(makeViolation('context_unknown', 'no frozen context manifest exists for this context_id'));
  } else {
    const parsedManifest = frozenContextManifestSchema.safeParse(input.manifest);
    if (!parsedManifest.success) {
      push(makeViolation('manifest_invalid', `frozen context manifest failed schema validation: ${firstIssueMessage(parsedManifest.error)}`));
    } else {
      manifest = parsedManifest.data;
      if (!(supportedManifestSchemaVersions as readonly string[]).includes(manifest.schema_version)) {
        push(makeViolation('manifest_schema_unsupported', `manifest schema_version ${manifest.schema_version} is not supported by ${CONTEXT_VERIFY_SCHEMA_VERSION}`));
        manifest = null;
      } else if (manifest.execution_status === 'FAILED' || manifest.execution_status === 'SNAPSHOT_UNSTABLE') {
        // A context that failed or sampled an unstable snapshot cannot ground
        // any answer, even when the individual evidence entries look intact.
        push(makeViolation('context_unstable', `frozen context execution_status is ${manifest.execution_status}`));
      } else if (manifest.execution_status === 'DEGRADED') {
        push(makeViolation('context_degraded', 'frozen context completed in DEGRADED mode'));
      }
      if (manifest !== null && manifest.budget_status.retrieval_completeness !== 'COMPLETE_WITHIN_DECLARED_SCOPE') {
        push(makeViolation('context_incomplete', `frozen context retrieval_completeness is ${manifest.budget_status.retrieval_completeness}`));
      }
    }
  }

  // Layer: cluster consistency (T-128 / ADR-011 §5, §7.2). Optional input; a
  // blocked/inconsistent judgement contradicts the draft's grounding, while a
  // stale or explicitly historical signal forces NEEDS_REVIEW. Never omitted
  // behaviour changes for callers that do not supply the signal.
  for (const violation of consistencyViolations(input.consistency)) push(violation);

  // Layer: schema (the draft).
  const parsedDraft = contextDraftSchema.safeParse(input.draft);
  const draft: ContextDraft | null = parsedDraft.success ? parsedDraft.data : null;
  if (!parsedDraft.success) {
    push(makeViolation('draft_invalid', `structured draft failed schema validation: ${firstIssueMessage(parsedDraft.error)}`));
  }

  // Layer: binding — context identity, scope, root and expiry.
  if (manifest !== null) {
    if (draft !== null) {
      if (draft.context_id !== manifest.context_id) {
        push(makeViolation('context_id_mismatch', `draft context_id ${draft.context_id} does not match the frozen context ${manifest.context_id}`));
      }
      if (draft.project_scope !== manifest.project_scope) {
        push(makeViolation('scope_mismatch', `draft project_scope ${draft.project_scope} does not match the frozen context scope ${manifest.project_scope}`));
      }
    }
    if (root !== manifest.root) {
      push(makeViolation('root_mismatch', 'the frozen context was sampled under a different canonical root'));
    }
    if (parsedNow.data >= manifest.expires_at) {
      push(makeViolation('context_expired', `the frozen context expired at ${manifest.expires_at}`));
    }
  }

  // Layer: snapshot — a re-sampled snapshot must equal the frozen one exactly.
  if (manifest !== null && currentSnapshot !== null) {
    if (currentSnapshot.project_scope !== manifest.snapshot.project_scope) {
      push(makeViolation('snapshot_scope_mismatch', `re-sampled snapshot scope ${currentSnapshot.project_scope} does not match the frozen context scope ${manifest.snapshot.project_scope}`));
    } else {
      const differing: string[] = [];
      if (currentSnapshot.ledger_digest !== manifest.snapshot.ledger_digest) differing.push('ledger_digest');
      if (currentSnapshot.graph_revision !== manifest.snapshot.graph_revision) differing.push('graph_revision');
      if (currentSnapshot.source_fingerprint !== manifest.snapshot.source_fingerprint) differing.push('source_fingerprint');
      if (currentSnapshot.connected_digest !== manifest.snapshot.connected_digest) differing.push('connected_digest');
      if (differing.length > 0) {
        push(makeViolation('snapshot_mismatch', `re-sampled snapshot differs from the frozen context in: ${differing.join(', ')}`));
      }
    }
  }

  // Layers: refs, facts, params — need both a usable manifest and draft.
  const activeByAlias = new Map<string, AnchorProbeEvidence>();
  const tombstonesByAlias = new Map<string, AnchorProbeTombstone>();
  const rulesByKey = new Map<string, ContextRule>();
  if (manifest !== null) {
    manifest.active_evidence.forEach((item) => activeByAlias.set(item.ref, item));
    manifest.deprecated_tombstones.forEach((item) => tombstonesByAlias.set(item.ref, item));
    manifest.rules.forEach((rule) => rulesByKey.set(rule.fact_key, rule));
  }

  if (manifest !== null && draft !== null) {
    const requiredFacts = new Set(manifest.coverage_gate.required_facts);
    const missingFacts = new Set(manifest.coverage_gate.missing_facts);
    const notApplicableKeys = new Set(draft.not_applicable.map((entry) => entry.fact_key));
    const seenClaimIds = new Set<string>();

    for (const claim of draft.claims) {
      if (seenClaimIds.has(claim.id)) {
        push(makeViolation('duplicate_claim_id', `claim id ${claim.id} is used more than once`, { claimId: claim.id }));
      }
      seenClaimIds.add(claim.id);

      // Refs layer: aliases must resolve into the frozen evidence set, stay
      // unique per claim and respect era/health rules per claim kind.
      const seenRefs = new Set<string>();
      let activeRefs = 0;
      let tombstonedRefs = 0;
      let retractedRefs = 0;
      let staleSourceRefs = 0;
      for (const ref of claim.evidence_refs) {
        if (seenRefs.has(ref)) {
          push(makeViolation('duplicate_evidence_ref', `evidence ref ${ref} is cited more than once by claim ${claim.id}`, { claimId: claim.id, ref }));
        }
        seenRefs.add(ref);

        const active = activeByAlias.get(ref);
        const tombstone = tombstonesByAlias.get(ref);
        if (active === undefined && tombstone === undefined) {
          push(makeViolation('unknown_evidence_ref', `evidence ref ${ref} does not exist in the frozen context`, { claimId: claim.id, ref }));
          continue;
        }
        if (active !== undefined) {
          activeRefs += 1;
          if (active.source_health === 'stale') staleSourceRefs += 1;
        }
        if (tombstone !== undefined) {
          tombstonedRefs += 1;
          if (tombstone.status === 'retracted') retractedRefs += 1;
        }
      }

      if (claim.kind === 'CURRENT_FACT') {
        if (claim.evidence_refs.length === 0) {
          push(makeViolation('current_fact_without_evidence', `current-fact claim ${claim.id} cites no evidence`, { claimId: claim.id }));
        }
        if (tombstonedRefs > 0) {
          push(makeViolation('stale_evidence_in_current_fact', `current-fact claim ${claim.id} cites deprecated evidence`, { claimId: claim.id }));
        }
      }
      if (claim.kind === 'HISTORICAL_FACT' && claim.evidence_refs.length === 0) {
        push(makeViolation('historical_fact_without_evidence', `historical claim ${claim.id} cites no evidence`, { claimId: claim.id }));
      }
      if (claim.kind === 'DERIVED') {
        if (claim.evidence_refs.length === 0) {
          push(makeViolation('derived_without_evidence', `derived claim ${claim.id} cites no evidence`, { claimId: claim.id }));
        }
        if (tombstonedRefs > 0) {
          push(makeViolation('stale_evidence_in_derived', `derived claim ${claim.id} builds on deprecated evidence`, { claimId: claim.id }));
        }
      }
      if (claim.kind !== 'HISTORICAL_FACT' && staleSourceRefs > 0) {
        push(makeViolation('stale_source_cited', `claim ${claim.id} cites stale-source evidence for a non-historical use`, { claimId: claim.id }));
      }
      if (retractedRefs > 0) {
        push(makeViolation('retracted_evidence_cited', `claim ${claim.id} cites retracted evidence`, { claimId: claim.id }));
      }
      if (activeRefs > 0 && tombstonedRefs > 0) {
        push(makeViolation('mixed_active_and_deprecated_refs', `claim ${claim.id} mixes active and deprecated evidence`, { claimId: claim.id }));
      }

      // Facts layer: no fabrication, no scope widening, no contradictions.
      if (claim.fact_key !== undefined) {
        if (missingFacts.has(claim.fact_key)) {
          push(makeViolation('fabricated_missing_fact', `claim ${claim.id} asserts ${claim.fact_key}, which the frozen context reports as missing`, { claimId: claim.id }));
        }
        if (claim.kind !== 'PROPOSAL' && !requiredFacts.has(claim.fact_key)) {
          push(makeViolation('fact_key_out_of_scope', `claim ${claim.id} answers ${claim.fact_key}, which is not part of the declared required facts`, { claimId: claim.id }));
        }
        if (draft.unresolved.includes(claim.fact_key)) {
          push(makeViolation('claim_unresolved_conflict', `claim ${claim.id} answers ${claim.fact_key} while the draft also lists it as unresolved`, { claimId: claim.id }));
        }
        if (notApplicableKeys.has(claim.fact_key)) {
          push(makeViolation('not_applicable_conflict', `claim ${claim.id} answers ${claim.fact_key} while the draft also marks it not applicable`, { claimId: claim.id }));
        }
      }

      // Params layer: only formalized values, matched exactly.
      for (const param of claim.params) {
        const rule = rulesByKey.get(param.key);
        if (rule === undefined) {
          push(makeViolation('unformalized_param', `claim ${claim.id} asserts parameter ${param.key}, which has no formalized rule in the frozen context`, { claimId: claim.id }));
        } else if (rule.value !== param.value) {
          push(makeViolation('constraint_mismatch', `claim ${claim.id} asserts ${param.key}=${param.value}, which contradicts the formalized value ${rule.value}`, { claimId: claim.id }));
        }
      }
    }
  }

  const layerOf = (code: ContextViolationCode): ViolationLayer => violationLayer[code];
  // Only block-severity contradictions fail a check layer; review findings
  // stay visible in `violations` and force NEEDS_REVIEW without calling the
  // layer "failed".
  const failedLayers = new Set<ViolationLayer>(
    violations.filter((violation) => violation.severity === 'block').map((violation) => layerOf(violation.code)),
  );
  const outcomeFor = (layer: ViolationLayer, runnable: boolean): ContextVerifyCheckOutcome => {
    if (!runnable) return 'skipped';
    return failedLayers.has(layer) ? 'fail' : 'pass';
  };
  const checks: ContextVerifyChecks = {
    schema: parsedDraft.success ? 'pass' : 'fail',
    manifest: manifest !== null ? outcomeFor('manifest', true) : 'fail',
    binding: outcomeFor('binding', manifest !== null),
    snapshot: outcomeFor('snapshot', manifest !== null && currentSnapshot !== null),
    refs: outcomeFor('refs', manifest !== null && draft !== null),
    facts: outcomeFor('facts', manifest !== null && draft !== null),
    params: outcomeFor('params', manifest !== null && draft !== null),
    aggregate: capReached ? 'fail' : 'pass',
  };

  const report: ContextVerifyReport = {
    schema_version: CONTEXT_VERIFY_SCHEMA_VERSION,
    // v1 never returns ALLOW: semantic support is unknown, so even a draft
    // with zero violations is NEEDS_REVIEW. Review-severity findings (for
    // example an unformalized parameter) also resolve to NEEDS_REVIEW; only
    // block-severity contradictions produce BLOCK.
    status: violations.some((violation) => violation.severity === 'block') ? 'BLOCK' : 'NEEDS_REVIEW',
    context_id: manifest !== null ? manifest.context_id : bestEffortContextId(input.draft),
    checks,
    violations,
    semantic_support: 'unknown',
    untrusted: true,
  };
  return report;
}

/**
 * Distributable JSON Schema for the draft (input mode: callers may omit the
 * defaulted arrays) and the report (output mode: every field is present).
 * Zod remains the authoritative validator for the cross-field rules.
 */
export function contextVerifyJsonSchemas(): ContextVerifyJsonSchemas {
  return {
    draft: z.toJSONSchema(contextDraftSchema, { io: 'input' }) as unknown as Record<string, unknown>,
    report: z.toJSONSchema(contextVerifyReportSchema, { io: 'output' }) as unknown as Record<string, unknown>,
  };
}
