import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '../ledger/event.ts';

/**
 * AnchorProbe read-only context contract (P0 / AP-02).
 *
 * This module only defines the probe request/response shapes and a
 * distributable JSON Schema. It never reads the ledger, walks the graph or
 * writes memory. The values in the design document are examples, not facts:
 * every field below is a bounded vocabulary, and unknown values are expressed
 * as `null` or `unknown` rather than invented precision.
 *
 * Conventions follow the existing ledger payloads: snake_case fields,
 * `.strict()` objects (unknown keys are rejected), lowercase sha256 for
 * content/digest identity, bounded identifiers and ISO-8601 timestamps.
 * `timestamp_ns` is deliberately absent: this contract does not claim
 * nanosecond precision, and callers must not infer it from `recorded_at`.
 */

export const ANCHOR_PROBE_REQUEST_SCHEMA_VERSION = 'anchorprobe.request.v1';
export const ANCHOR_PROBE_CONTEXT_SCHEMA_VERSION = 'anchorprobe.context.v1';

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u, 'expected a lowercase sha256 hex digest');
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u, 'expected a bounded identifier');
const factKey = z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,127}$/u, 'expected a dotted fact key');
const iso = z.string().datetime();
const aliasRef = z.string().regex(/^[A-Z][0-9]{1,6}$/u, 'expected an in-request alias such as E1');

/** Request-local alias used to keep evidence references stable and unique. */
export const anchorProbeAliasRefSchema = aliasRef;

export const anchorProbeExecutionStatuses = ['OK', 'DEGRADED', 'SNAPSHOT_UNSTABLE', 'FAILED'] as const;
export const anchorProbeTemporalModes = ['CURRENT', 'AS_OF', 'HISTORICAL'] as const;
export const anchorProbeStopReasons = [
  'FRONTIER_EXHAUSTED',
  'BUDGET_EXHAUSTED',
  'DEPTH_LIMIT',
  'TIMEOUT',
  'ENTRY_NOT_FOUND',
  'ERROR',
] as const;
export const anchorProbeRetrievalCompletenesses = [
  'COMPLETE_WITHIN_DECLARED_SCOPE',
  'PARTIAL',
  'UNKNOWN',
] as const;
export const anchorProbeCoverageStatuses = ['SUFFICIENT', 'INSUFFICIENT', 'UNKNOWN'] as const;
export const anchorProbeRequirementsOrigins = ['caller_declared', 'derived', 'unknown'] as const;
export const anchorProbeRecordStatuses = ['active', 'superseded', 'conflicted', 'retracted'] as const;
export const anchorProbeSourceHealthes = ['verified_at_snapshot', 'stale', 'unknown'] as const;
export const anchorProbeSourceKinds = ['native_note', 'code_read', 'connected', 'history', 'unknown'] as const;
export const anchorProbeGapReasons = ['missing', 'ambiguous', 'out_of_scope', 'unknown'] as const;
export const anchorProbeConflictStatuses = ['unresolved', 'resolved'] as const;
export const anchorProbeInvariantStatuses = ['satisfied', 'violated', 'unknown'] as const;

// ---------------------------------------------------------------------------
// Distributed-probe cluster metadata (T-124 / ADR-011 §5, §10)
//
// Additive only: `anchorprobe.context.v1` keeps its exact shape and the
// `cluster` segment below is optional, so every pre-distributed snapshot still
// parses byte-for-byte. Cluster metadata is untrusted remote data: it is
// strictly validated, never executed, and its evidence digest covers a bounded
// record set only (no free text, no unbounded merge).
// ---------------------------------------------------------------------------

export const ANCHOR_PROBE_CLUSTER_SCHEMA_VERSION = 'anchorprobe.cluster.v1';

/**
 * Retrieval consistency modes (ADR-011 §5.1). Orthogonal to the business
 * `temporal_mode`; this describes where evidence came from and how far it is
 * consistent, never the effective-time semantics.
 */
export const anchorProbeConsistencyModes = ['local', 'as_of', 'committed', 'quorum'] as const;
export type AnchorProbeConsistencyMode = (typeof anchorProbeConsistencyModes)[number];

/** Hard upper bound on records mixed into one evidence digest (ADR-011 §5.2). */
export const PROBE_EVIDENCE_DIGEST_MAX_RECORDS = 1024;

const clusterEpoch = z.union([
  z.string().max(128),
  z.number().int().nonnegative(),
]);

/**
 * The `cluster` segment of an AnchorProbe snapshot. All fields are required
 * when the segment is present: a half-declared cluster is worse than none
 * because it invites mixing stale/foreign identity with local conclusions.
 * `schema_version` stays optional so a bare metadata block remains readable,
 * but when present it must name `anchorprobe.cluster.v1`.
 */
export const anchorProbeClusterMetadataSchema = z.object({
  schema_version: z.literal(ANCHOR_PROBE_CLUSTER_SCHEMA_VERSION).optional(),
  /** Must equal the snapshot/request scope; cross-scope evidence is refused. */
  project_scope: identifier,
  cluster_epoch: clusterEpoch,
  commit_index: z.number().int().nonnegative(),
  replica_id: identifier,
  replica_commit_index: z.number().int().nonnegative(),
  consistency: z.enum(anchorProbeConsistencyModes),
  /** Null when the lag is unknown (ADR-011 §4.2); never a fabricated 0. */
  max_lag: z.number().int().nonnegative().nullable(),
  partial: z.boolean(),
  failed_nodes: z.array(identifier).max(1024),
  evidence_digest: sha256,
}).strict().superRefine((value, context) => {
  if (value.partial === false && value.failed_nodes.length > 0) {
    context.addIssue({
      code: 'custom',
      message: 'partial=false cannot carry failed_nodes: execution state and partial flag must agree',
      path: ['failed_nodes'],
    });
  }
});
export type AnchorProbeClusterMetadata = z.infer<typeof anchorProbeClusterMetadataSchema>;

/** Fail-closed contract violation carrying an ADR-011 §11 error code. */
export class ProbeContractError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(`[${code}] ${message}`, options);
    this.name = 'ProbeContractError';
    this.code = code;
  }
}

/**
 * One bounded candidate fingerprint. Free text (`content`) is deliberately not
 * part of the input: the digest must stay bounded and must never leak event
 * bodies (ADR-011 §5.2, §9.2).
 */
export interface ProbeEvidenceFingerprint {
  readonly record_ref: string;
  readonly content_hash: string;
  readonly fact_key?: string;
  readonly status?: AnchorProbeRecordStatus;
}

export interface EvidenceDigestOptions {
  /** Records kept after sorting; defaults to the hard bound. */
  readonly limit?: number;
  /** Opt-in truncation marker; by default an over-limit set is refused. */
  readonly allowTruncation?: boolean;
}

export interface EvidenceDigestResult {
  readonly digest: string;
  readonly considered: number;
  readonly total: number;
  readonly truncated: boolean;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Project a fingerprint onto the four stable identity keys. Unknown keys (in
 * particular any free-text `content`) are dropped, so two callers cannot make
 * the same record set hash differently by attaching extra fields.
 */
function projectFingerprint(record: ProbeEvidenceFingerprint): Record<string, unknown> {
  const projected: Record<string, unknown> = {
    record_ref: record.record_ref,
    content_hash: record.content_hash,
  };
  if (record.fact_key !== undefined) projected.fact_key = record.fact_key;
  if (record.status !== undefined) projected.status = record.status;
  return projected;
}

function fingerprintSortKey(record: ProbeEvidenceFingerprint): string {
  return canonicalJson(projectFingerprint(record));
}

/**
 * Recompute the bounded evidence digest:
 * `sha256(canonicalJson(sortedProjection))`, sorted by `record_ref`, then
 * `content_hash`, then `fact_key`, then `status`. Duplicate fingerprints are
 * collapsed first, so insertion order never changes the result.
 *
 * Bounded by construction: at most `limit` (<= PROBE_EVIDENCE_DIGEST_MAX_RECORDS)
 * records are mixed. Over-limit input is refused unless `allowTruncation` is
 * explicitly set, in which case the result reports `truncated: true` instead of
 * silently widening the compared set.
 */
export function computeEvidenceDigestDetailed(
  records: readonly ProbeEvidenceFingerprint[],
  options: EvidenceDigestOptions = {},
): EvidenceDigestResult {
  if (!Array.isArray(records)) {
    throw new ProbeContractError('EVIDENCE_DIGEST_INPUT_INVALID', 'evidence digest input must be an array of record fingerprints');
  }
  const limit = options.limit ?? PROBE_EVIDENCE_DIGEST_MAX_RECORDS;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > PROBE_EVIDENCE_DIGEST_MAX_RECORDS) {
    throw new ProbeContractError(
      'EVIDENCE_DIGEST_LIMIT_INVALID',
      `evidence digest limit must be an integer in [1, ${PROBE_EVIDENCE_DIGEST_MAX_RECORDS}], got ${String(limit)}`,
    );
  }

  const seen = new Set<string>();
  const fingerprints: ProbeEvidenceFingerprint[] = [];
  for (const entry of records) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ProbeContractError('EVIDENCE_DIGEST_INPUT_INVALID', 'each evidence fingerprint must be an object');
    }
    const record = entry as ProbeEvidenceFingerprint;
    if (typeof record.record_ref !== 'string' || !identifier.safeParse(record.record_ref).success) {
      throw new ProbeContractError('EVIDENCE_DIGEST_INPUT_INVALID', `invalid record_ref fingerprint: ${JSON.stringify(record.record_ref)}`);
    }
    if (typeof record.content_hash !== 'string' || !sha256.safeParse(record.content_hash).success) {
      throw new ProbeContractError('EVIDENCE_DIGEST_INPUT_INVALID', `invalid content_hash fingerprint: ${JSON.stringify(record.content_hash)}`);
    }
    if (record.fact_key !== undefined && (typeof record.fact_key !== 'string' || !factKey.safeParse(record.fact_key).success)) {
      throw new ProbeContractError('EVIDENCE_DIGEST_INPUT_INVALID', `invalid fact_key fingerprint: ${JSON.stringify(record.fact_key)}`);
    }
    if (record.status !== undefined && !z.enum(anchorProbeRecordStatuses).safeParse(record.status).success) {
      throw new ProbeContractError('EVIDENCE_DIGEST_INPUT_INVALID', `invalid status fingerprint: ${JSON.stringify(record.status)}`);
    }
    const key = fingerprintSortKey(record);
    if (seen.has(key)) continue;
    seen.add(key);
    fingerprints.push(record);
  }

  fingerprints.sort((a, b) => compareText(a.record_ref, b.record_ref)
    || compareText(a.content_hash, b.content_hash)
    || compareText(a.fact_key ?? '', b.fact_key ?? '')
    || compareText(a.status ?? '', b.status ?? ''));

  const total = fingerprints.length;
  if (total > limit && options.allowTruncation !== true) {
    throw new ProbeContractError(
      'EVIDENCE_RECORD_LIMIT_EXCEEDED',
      `evidence digest received ${total} distinct records, above the bounded limit of ${limit}; refusing to mix an unbounded set`,
    );
  }
  const considered = Math.min(total, limit);
  const digest = createHash('sha256')
    .update(canonicalJson(fingerprints.slice(0, considered).map(projectFingerprint)))
    .digest('hex');
  return { digest, considered, total, truncated: considered < total };
}

/** Digest-only convenience wrapper; throws on over-limit input by default. */
export function computeEvidenceDigest(
  records: readonly ProbeEvidenceFingerprint[],
  options: EvidenceDigestOptions = {},
): string {
  return computeEvidenceDigestDetailed(records, options).digest;
}

/**
 * Execution-state consistency for cluster metadata (ADR-011 §5.3, §11):
 * - `partial=true` needs a cause: non-empty `failed_nodes` or a `stop_reason`;
 * - `partial=false` cannot carry `failed_nodes`.
 */
export interface ClusterPartialConsistencyInput {
  readonly partial: boolean;
  readonly failed_nodes: readonly string[];
  readonly stop_reason?: string | null;
}

export function isClusterPartialConsistent(value: ClusterPartialConsistencyInput): boolean {
  if (value.partial) {
    const hasStopReason = typeof value.stop_reason === 'string' && value.stop_reason.length > 0;
    return value.failed_nodes.length > 0 || hasStopReason;
  }
  return value.failed_nodes.length === 0;
}

export function assertClusterPartialConsistency(value: ClusterPartialConsistencyInput): void {
  if (value.partial) {
    const hasStopReason = typeof value.stop_reason === 'string' && value.stop_reason.length > 0;
    if (value.failed_nodes.length === 0 && !hasStopReason) {
      throw new ProbeContractError('PARTIAL_WITHOUT_CAUSE', 'partial=true requires failed_nodes or a stop_reason');
    }
    return;
  }
  if (value.failed_nodes.length > 0) {
    throw new ProbeContractError('FAILED_NODES_WITHOUT_PARTIAL', 'partial=false cannot carry failed_nodes');
  }
}

/**
 * Cross-scope refusal (ADR-011 §9.1, §11 `SCOPE_DENIED`): cluster metadata must
 * name the same project scope as the snapshot/request it travels with. A
 * missing scope is refused too; it can never be assumed to match.
 */
export function assertClusterProjectScope(
  cluster: { readonly project_scope?: string } | null | undefined,
  expectedProjectScope: string,
): void {
  if (cluster === null || cluster === undefined || cluster.project_scope !== expectedProjectScope) {
    throw new ProbeContractError(
      'SCOPE_DENIED',
      `cluster project_scope ${JSON.stringify(cluster?.project_scope)} does not match the snapshot/request scope ${JSON.stringify(expectedProjectScope)}`,
    );
  }
}

/** Epoch mismatch is fail-closed: unequal epochs may never merge evidence. */
export function assertClusterEpochMatch(actual: string | number, expected: string | number): void {
  if (actual !== expected) {
    throw new ProbeContractError(
      'CLUSTER_EPOCH_MISMATCH',
      `cluster_epoch ${JSON.stringify(actual)} does not match the expected epoch ${JSON.stringify(expected)}`,
    );
  }
}

/**
 * Adapter for a legacy (pre-distributed) snapshot: project it onto the cluster
 * shape with explicit "unknown/local" defaults. `partial=true` with no
 * `failed_nodes` is allowed here because there is no stop reason to cite; the
 * adapter marks the projection honestly rather than inventing a commit point.
 */
export function legacySnapshotClusterMetadata(snapshot: AnchorProbeSnapshot): AnchorProbeClusterMetadata {
  return {
    schema_version: ANCHOR_PROBE_CLUSTER_SCHEMA_VERSION,
    project_scope: snapshot.project_scope,
    cluster_epoch: '',
    commit_index: 0,
    replica_id: 'local',
    replica_commit_index: 0,
    consistency: 'local',
    max_lag: null,
    partial: true,
    failed_nodes: [],
    evidence_digest: computeEvidenceDigest([]),
  };
}

/**
 * Stop reasons that mean the probe could not finish its declared work. These
 * can never be paired with `COMPLETE_WITHIN_DECLARED_SCOPE`.
 */
export const anchorProbeTruncatingStopReasons = [
  'BUDGET_EXHAUSTED',
  'DEPTH_LIMIT',
  'TIMEOUT',
  'ENTRY_NOT_FOUND',
  'ERROR',
] as const;

/**
 * Budget knobs are experiment starting points, not measured optima. They are
 * defaults so a caller may omit them; the probe still has to report truncation
 * honestly when a bound is hit.
 */
export const anchorProbeDefaultBudget = {
  max_candidates: 16,
  max_nodes: 12,
  max_depth: 3,
} as const;

export const anchorProbeBudgetSchema = z.object({
  max_candidates: z.number().int().positive().max(10_000),
  max_nodes: z.number().int().positive().max(10_000),
  max_depth: z.number().int().positive().max(100),
}).strict();
export type AnchorProbeBudget = z.infer<typeof anchorProbeBudgetSchema>;

export const anchorProbeRequestSchema = z.object({
  schema_version: z.literal(ANCHOR_PROBE_REQUEST_SCHEMA_VERSION),
  request_id: identifier,
  /** Server-issued context id, present only when reusing a frozen context. */
  context_id: identifier.optional(),
  /** Explicit project root the probe is allowed to read. */
  root: z.string().min(1).max(4096),
  project_scope: identifier,
  /** Facts the caller needs answered; the probe reports gaps against these. */
  required_facts: z.array(factKey).max(256).optional(),
  temporal_mode: z.enum(anchorProbeTemporalModes).default('CURRENT'),
  /** Required for AS_OF/HISTORICAL reads; ignored for CURRENT. */
  as_of: iso.optional(),
  budget: anchorProbeBudgetSchema.default(anchorProbeDefaultBudget),
}).strict().superRefine((value, context) => {
  if (value.temporal_mode !== 'CURRENT' && value.as_of === undefined) {
    context.addIssue({ code: 'custom', message: 'as_of is required for AS_OF/HISTORICAL temporal_mode', path: ['as_of'] });
  }
});
export type AnchorProbeRequest = z.infer<typeof anchorProbeRequestSchema>;

export const anchorProbeSnapshotSchema = z.object({
  project_scope: identifier,
  /** Full ledger commit digest at the sampled commit point. */
  ledger_digest: sha256,
  /** Null when the graph is unavailable; never a fabricated revision. */
  graph_revision: sha256.nullable(),
  source_fingerprint: sha256.nullable(),
  connected_digest: sha256.nullable(),
  /**
   * Distributed-probe metadata (T-124). Optional so legacy four-digest
   * snapshots parse unchanged; when present it is strictly validated.
   */
  cluster: anchorProbeClusterMetadataSchema.optional(),
}).strict();
export type AnchorProbeSnapshot = z.infer<typeof anchorProbeSnapshotSchema>;

export const anchorProbeBudgetStatusSchema = z.object({
  stop_reason: z.enum(anchorProbeStopReasons),
  retrieval_completeness: z.enum(anchorProbeRetrievalCompletenesses),
  nodes_visited: z.number().int().nonnegative(),
  frontier_remaining: z.number().int().nonnegative(),
}).strict();
export type AnchorProbeBudgetStatus = z.infer<typeof anchorProbeBudgetStatusSchema>;

export const anchorProbeCoverageGateSchema = z.object({
  status: z.enum(anchorProbeCoverageStatuses),
  required_facts: z.array(factKey),
  missing_facts: z.array(factKey),
  /** References into the response `conflicts` array. */
  unresolved_conflicts: z.array(identifier),
  requirements_origin: z.enum(anchorProbeRequirementsOrigins),
}).strict().superRefine((value, context) => {
  if (value.status === 'SUFFICIENT' && value.missing_facts.length > 0) {
    context.addIssue({ code: 'custom', message: 'SUFFICIENT coverage cannot carry missing_facts', path: ['status'] });
  }
  if (value.status === 'SUFFICIENT' && value.unresolved_conflicts.length > 0) {
    context.addIssue({ code: 'custom', message: 'SUFFICIENT coverage cannot carry unresolved_conflicts', path: ['status'] });
  }
  // A missing fact outside the declared set would silently widen the question
  // the caller asked, so `missing_facts` must stay a subset of `required_facts`.
  const required = new Set(value.required_facts);
  value.missing_facts.forEach((fact, index) => {
    if (!required.has(fact)) {
      context.addIssue({
        code: 'custom',
        message: `missing fact ${fact} is not part of required_facts`,
        path: ['missing_facts', index],
      });
    }
  });
});
export type AnchorProbeCoverageGate = z.infer<typeof anchorProbeCoverageGateSchema>;

export const anchorProbeSourceSchema = z.object({
  kind: z.enum(anchorProbeSourceKinds),
  path: z.string().min(1).max(1024).optional(),
}).strict();
export type AnchorProbeSource = z.infer<typeof anchorProbeSourceSchema>;

export const anchorProbeEvidenceSchema = z.object({
  /** In-request alias (E1/I1/H1...); unique within one response. */
  ref: aliasRef,
  record_ref: identifier,
  content_hash: sha256,
  status: z.enum(anchorProbeRecordStatuses),
  /** Source health is independent of the business status. */
  source_health: z.enum(anchorProbeSourceHealthes),
  recorded_at: iso,
  /** Null means the effective interval is unknown, not that it began at the epoch. */
  effective_from: iso.nullable(),
  source: anchorProbeSourceSchema,
  content: z.string().min(1).max(100_000),
}).strict();
export type AnchorProbeEvidence = z.infer<typeof anchorProbeEvidenceSchema>;

export const anchorProbeTombstoneSchema = z.object({
  ref: aliasRef,
  record_ref: identifier,
  content_hash: sha256,
  status: z.enum(['superseded', 'retracted']),
  /** Null when no replacement record is known. */
  superseded_by: identifier.nullable(),
  recorded_at: iso,
  reason: z.string().min(1).max(2000).optional(),
}).strict();
export type AnchorProbeTombstone = z.infer<typeof anchorProbeTombstoneSchema>;

export const anchorProbeGapSchema = z.object({
  fact_key: factKey,
  reason: z.enum(anchorProbeGapReasons),
}).strict();
export type AnchorProbeGap = z.infer<typeof anchorProbeGapSchema>;

export const anchorProbeConflictSchema = z.object({
  conflict_id: identifier,
  fact_key: factKey,
  record_refs: z.array(identifier).min(1).max(64),
  status: z.enum(anchorProbeConflictStatuses),
  resolution: z.string().min(1).max(2000).optional(),
}).strict();
export type AnchorProbeConflict = z.infer<typeof anchorProbeConflictSchema>;

export const anchorProbeInvariantSchema = z.object({
  invariant_id: identifier,
  status: z.enum(anchorProbeInvariantStatuses),
  detail: z.string().min(1).max(2000).optional(),
}).strict();
export type AnchorProbeInvariant = z.infer<typeof anchorProbeInvariantSchema>;

export const anchorProbeResponseSchema = z.object({
  schema_version: z.literal(ANCHOR_PROBE_CONTEXT_SCHEMA_VERSION),
  request_id: identifier,
  context_id: identifier,
  snapshot: anchorProbeSnapshotSchema,
  execution_status: z.enum(anchorProbeExecutionStatuses),
  temporal_mode: z.enum(anchorProbeTemporalModes),
  budget_status: anchorProbeBudgetStatusSchema,
  coverage_gate: anchorProbeCoverageGateSchema,
  l1_invariants: z.array(anchorProbeInvariantSchema),
  active_evidence: z.array(anchorProbeEvidenceSchema),
  deprecated_tombstones: z.array(anchorProbeTombstoneSchema),
  gaps: z.array(anchorProbeGapSchema),
  conflicts: z.array(anchorProbeConflictSchema),
  /**
   * Evidence text is untrusted input. Consumers must never execute it, and a
   * claim may only be shown after the context validator accepts it.
   */
  untrusted: z.boolean(),
}).strict().superRefine((value, context) => {
  const { stop_reason, retrieval_completeness } = value.budget_status;
  if (retrieval_completeness === 'COMPLETE_WITHIN_DECLARED_SCOPE'
      && (anchorProbeTruncatingStopReasons as readonly string[]).includes(stop_reason)) {
    context.addIssue({
      code: 'custom',
      message: `stop_reason ${stop_reason} cannot be paired with COMPLETE_WITHIN_DECLARED_SCOPE`,
      path: ['budget_status', 'retrieval_completeness'],
    });
  }
  if (retrieval_completeness === 'COMPLETE_WITHIN_DECLARED_SCOPE'
      && (value.execution_status === 'FAILED' || value.execution_status === 'SNAPSHOT_UNSTABLE')) {
    context.addIssue({
      code: 'custom',
      message: `execution_status ${value.execution_status} cannot be paired with COMPLETE_WITHIN_DECLARED_SCOPE`,
      path: ['budget_status', 'retrieval_completeness'],
    });
  }

  // Aliases are the only stable handle a consumer has, so they must be unique
  // across both live evidence and tombstones within one response.
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

  // Coverage may only report gaps for facts it actually declared, otherwise a
  // probe could widen the question and still look sufficient.
  const declared = new Set(value.coverage_gate.required_facts);
  value.gaps.forEach((gap, index) => {
    if (!declared.has(gap.fact_key)) {
      context.addIssue({
        code: 'custom',
        message: `gap fact ${gap.fact_key} is not part of coverage_gate.required_facts`,
        path: ['gaps', index, 'fact_key'],
      });
    }
  });

  // unresolved_conflicts must point at real, still-unresolved conflicts.
  const unresolved = new Set(
    value.conflicts.filter((conflict) => conflict.status === 'unresolved').map((conflict) => conflict.conflict_id),
  );
  value.coverage_gate.unresolved_conflicts.forEach((ref, index) => {
    if (!unresolved.has(ref)) {
      context.addIssue({
        code: 'custom',
        message: `unresolved_conflicts entry ${ref} does not name an unresolved conflict`,
        path: ['coverage_gate', 'unresolved_conflicts', index],
      });
    }
  });

  // Evidence text is untrusted by definition; a payload carrying any cannot
  // advertise itself as trusted.
  if ((value.active_evidence.length > 0 || value.deprecated_tombstones.length > 0) && value.untrusted === false) {
    context.addIssue({
      code: 'custom',
      message: 'untrusted must be true when the response carries evidence text',
      path: ['untrusted'],
    });
  }
});
export type AnchorProbeResponse = z.infer<typeof anchorProbeResponseSchema>;

// Singular element types, so consumers can name one enum member without
// re-deriving it from the readonly tuple.
export type AnchorProbeExecutionStatus = (typeof anchorProbeExecutionStatuses)[number];
export type AnchorProbeTemporalMode = (typeof anchorProbeTemporalModes)[number];
export type AnchorProbeStopReason = (typeof anchorProbeStopReasons)[number];
export type AnchorProbeRetrievalCompleteness = (typeof anchorProbeRetrievalCompletenesses)[number];
export type AnchorProbeCoverageStatus = (typeof anchorProbeCoverageStatuses)[number];
export type AnchorProbeRequirementsOrigin = (typeof anchorProbeRequirementsOrigins)[number];
export type AnchorProbeRecordStatus = (typeof anchorProbeRecordStatuses)[number];
export type AnchorProbeSourceHealth = (typeof anchorProbeSourceHealthes)[number];
export type AnchorProbeSourceKind = (typeof anchorProbeSourceKinds)[number];
export type AnchorProbeGapReason = (typeof anchorProbeGapReasons)[number];
export type AnchorProbeConflictStatus = (typeof anchorProbeConflictStatuses)[number];
export type AnchorProbeInvariantStatus = (typeof anchorProbeInvariantStatuses)[number];

export interface AnchorProbeJsonSchemas {
  request: Record<string, unknown>;
  response: Record<string, unknown>;
}

/**
 * Distributable JSON Schema for both contract sides. The JSON Schema describes
 * structure and enums only; Zod remains the authoritative validator for the
 * cross-field rules (budget truncation, coverage consistency, temporal mode).
 *
 * The request is generated in `input` mode because it validates what callers
 * send: `temporal_mode` and `budget` carry defaults and may be omitted. The
 * response is generated in `output` mode because it validates what the probe
 * emits, where every defaulted field is present.
 */
export function anchorProbeJsonSchemas(): AnchorProbeJsonSchemas {
  return {
    request: z.toJSONSchema(anchorProbeRequestSchema, { io: 'input' }) as unknown as Record<string, unknown>,
    response: z.toJSONSchema(anchorProbeResponseSchema, { io: 'output' }) as unknown as Record<string, unknown>,
  };
}
