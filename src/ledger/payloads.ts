import { z } from 'zod';
import type { LedgerEvent } from './event.ts';

/**
 * Per-kind payload validation for the event kinds that carry cross-domain
 * facts (memory notes, audit findings, readiness evidence/attestations and
 * release verdicts/approvals).
 *
 * These branches deliberately do not share the `task_id` shape: a note is
 * addressed by `note_id` and an anchor, an audit finding by its SHA-256
 * identity/fingerprint, readiness evidence by `evidence_ref`, a release
 * approval by `approval_ref`. Validation runs both when an event is appended
 * and when committed segments are replayed, so a hand-edited payload cannot
 * slip into the views cache.
 *
 * The legacy kinds (task/evidence/verify/lease/migration/segment) are not
 * re-validated here: their committed payloads predate this module and their
 * branches already validate what they consume. Adding this file therefore does
 * not change the hash of any existing event.
 */

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u, 'expected a lowercase sha256 hex digest');
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u, 'expected a bounded identifier');
const requirementId = z.string().regex(/^[a-z0-9][a-z0-9._-]{1,80}$/u, 'expected a readiness requirement id');
const iso = z.string().datetime();
const auditScope = z.enum(['drift', 'security', 'license', 'governance', 'deps']);
const evidenceLevel = z.enum(['machine', 'attested', 'declaration', 'missing']);
const releaseStatus = z.enum(['ready', 'conditional', 'blocked']);
export const COVERAGE_CLASSIFICATIONS = [
  'parsed',
  'zero-symbol',
  'zero-edge',
  'dynamic-only',
  'unsupported',
  'excluded',
  'deleted',
  'degraded',
  'unknown',
] as const;
const coverageClassification = z.enum(COVERAGE_CLASSIFICATIONS);

const memoryAnchor = z.object({
  file: z.string().min(1).max(1024),
  symbolId: z.string().min(1).max(256).optional(),
  qualifiedName: z.string().min(1).max(512).optional(),
  contentFragmentHash: sha256.optional(),
  contentFragment: z.string().min(1).max(10_000).optional(),
}).strict();

const noteRecorded = z.object({
  note_id: sha256,
  kind: z.enum(['decision', 'pitfall', 'memory', 'session_summary']),
  text: z.string().min(1).max(100_000),
  created_at: iso,
  anchor: memoryAnchor.optional(),
}).strict().superRefine((value, context) => {
  if (value.kind === 'session_summary' && value.anchor !== undefined) {
    context.addIssue({ code: 'custom', message: 'session_summary must not carry an anchor' });
  }
  if (value.kind !== 'session_summary' && value.anchor === undefined) {
    context.addIssue({ code: 'custom', message: `${value.kind} requires a memory anchor` });
  }
});

const auditFinding = z.object({
  id: sha256,
  scope: auditScope,
  rule: z.string().min(1).max(200),
  severity: z.enum(['high', 'medium', 'low', 'info']),
  message: z.string().min(1).max(2000),
  fingerprint: sha256,
  path: z.string().min(1).max(1024).optional(),
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
  status: z.enum(['open', 'resolved']),
  reopened: z.boolean().optional(),
  firstSeen: iso.optional(),
  lastSeen: iso.optional(),
}).strict();

const auditFindingRecorded = z.object({
  scope: auditScope,
  at: iso,
  finding: auditFinding,
}).strict();

const auditCompleted = z.object({
  scope: auditScope,
  at: iso,
  ok: z.boolean(),
  summary: z.object({
    high: z.number().int().nonnegative(),
    medium: z.number().int().nonnegative(),
    low: z.number().int().nonnegative(),
    info: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }).strict(),
}).strict();

const evidenceKinds = z.enum([
  'ci_run', 'deploy_record', 'artifact_scan', 'drill_record', 'monitor_export', 'load_test',
  'api_diff', 'build_repro', 'smoke_test', 'dependency_audit', 'docs_check', 'secret_scan',
  'rollback_drill', 'backup_drill', 'capacity_test',
]);

const readinessEvidenceObject = z.object({
  requirement_id: requirementId,
  kind: evidenceKinds,
  timestamp: iso,
  evidence_ref: sha256.optional(),
  result: z.enum(['pass', 'fail']).optional(),
  // ValidatedEvidence uses status "machine"/"attested" instead of result.
  status: z.enum(['machine', 'attested']).optional(),
  source_fingerprint: sha256.optional(),
  artifact_hash: sha256.optional(),
  expires_at: iso.optional(),
  id: identifier.optional(),
  raw_artifact_hash: sha256.optional(),
}).superRefine((value, context) => {
  if (value.result === undefined && value.status === undefined) {
    context.addIssue({ code: 'custom', message: 'readiness evidence requires result or status', path: ['result'] });
  }
});
const readinessEvidenceFlat = readinessEvidenceObject.superRefine((value, context) => {
  if (value.evidence_ref === undefined) {
    context.addIssue({ code: 'custom', message: 'readiness evidence requires evidence_ref', path: ['evidence_ref'] });
  }
});
const readinessEvidenceNested = z.object({
  evidence_ref: sha256.optional(),
  evidence: readinessEvidenceObject,
}).superRefine((value, context) => {
  if (value.evidence_ref === undefined && value.evidence.evidence_ref === undefined) {
    context.addIssue({ code: 'custom', message: 'readiness evidence requires evidence_ref', path: ['evidence_ref'] });
  }
});
const readinessEvidence = z.union([readinessEvidenceFlat, readinessEvidenceNested]);

const signer = z.object({
  name: z.string().min(1).max(120),
  role: z.string().min(1).max(120),
}).strict();

const attestationFields = {
  signer,
  signed_at: iso,
  expires_at: iso,
  artifact_hash: sha256,
  release_target: z.string().min(1).max(128),
  profile_ids: z.array(z.enum(['common', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'])).min(1).optional(),
  statement: z.string().min(1).max(2000).optional(),
  id: identifier.optional(),
};
const readinessAttestationFlat = z.object({
  ...attestationFields,
  attestation_ref: sha256,
  requirement_id: requirementId,
  requirement_ids: z.array(requirementId).min(1).optional(),
});
const readinessAttestationNested = z.object({
  attestation_ref: sha256,
  attestation: z.object({
    ...attestationFields,
    requirement_ids: z.array(requirementId).min(1),
  }),
});
const readinessAttestation = z.union([readinessAttestationFlat, readinessAttestationNested]);

const releaseVerdict = z.object({
  target: z.string().min(1).max(128),
  artifact_hash: sha256,
  verdict: releaseStatus,
  verdict_hash: sha256,
  summary: z.object({
    machine: z.number().int().nonnegative(),
    attested: z.number().int().nonnegative(),
    declaration: z.number().int().nonnegative().optional(),
    missing: z.number().int().nonnegative(),
  }).strict(),
  source_fingerprint: sha256.nullable().optional(),
  items: z.array(z.object({
    id: z.string().min(1),
    requirement: z.string().min(1),
    status: evidenceLevel,
    evidenceRef: z.string().nullable().optional(),
    expiresAt: z.string().nullable().optional(),
  })).optional(),
  caveats: z.array(z.string()).optional(),
});

const releaseApproved = z.object({
  target: z.string().min(1).max(128),
  artifact_hash: sha256,
  verdict_hash: sha256,
  approver: z.string().min(2).max(120),
  approved_at: iso,
  approval_ref: sha256,
});

/**
 * ADR-005 §4: versioned memory payload contracts. Every field below is fixed
 * by the ADR; the schemas are strict so unknown fields are rejected, and they
 * only accept snake_case — memory kinds deliberately bypass
 * `normalizeLedgerPayload`'s camelCase compatibility mapping, which exists for
 * the historical readiness/release payloads and must not become a precedent.
 */
const memoryEventKinds = ['memory.revised', 'memory.related', 'memory.conflict.resolved'] as const;
export type MemoryEventKind = (typeof memoryEventKinds)[number];

export function isMemoryEventKind(kind: LedgerEvent['kind']): kind is MemoryEventKind {
  return (memoryEventKinds as readonly string[]).includes(kind);
}

/**
 * Snake-case-only kinds bypass the historical camelCase compatibility map:
 * memory facts (ADR-005 §2.5) and structure queries (ADR-010 §3.2). The map
 * stays a legacy-compatibility path, never a precedent for new kinds.
 */
export function isSnakeCaseOnlyEventKind(kind: LedgerEvent['kind']): boolean {
  return isMemoryEventKind(kind) || kind === 'structure.queried';
}

/** Ledger event id: a Crockford ULID (same shape as `event.ts` ids). */
const recordRef = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u, 'expected a Crockford ULID record ref');
const factKey = z.string().regex(/^[a-z0-9][a-z0-9._-]{1,119}$/u, 'expected a fact_key such as local.storage.engine');
const memoryReason = z.string().min(1).max(2000);
/** Business effective bounds: explicit ISO datetime or explicit null (unknown). */
const isoOrNull = z.union([iso, z.null()]);

// ADR-005 §4: `session_summary` is historical material and never becomes a
// versioned fact, so the record kind vocabulary is narrower than note.recorded's.
const memoryRecord = z.object({
  text: z.string().min(1).max(100_000),
  kind: z.enum(['decision', 'pitfall', 'memory']),
  anchor: memoryAnchor.optional(),
}).strict();

const memoryRevisedBranches = z.discriminatedUnion('intent', [
  z.object({
    intent: z.literal('revise'),
    fact_key: factKey,
    record: memoryRecord,
    // Empty = genesis; exactly one element = linear revision naming the current
    // head. The referenced record IS the expected prior version (ADR-005 §4.1):
    // there is no separate version-number field to drift out of sync.
    supersedes: z.array(recordRef).max(1),
    reason: memoryReason,
    effective_from: isoOrNull,
    effective_to: isoOrNull,
  }).strict(),
  z.object({
    intent: z.literal('retract'),
    fact_key: factKey,
    // A retraction must name the current head; a retracted head cannot be
    // retracted again (ledger.ts precondition checks).
    supersedes: z.array(recordRef).length(1),
    reason: memoryReason,
  }).strict(),
]);
const memoryRevised = memoryRevisedBranches.superRefine((value, context) => {
  if (value.intent !== 'revise') return;
  if (value.effective_from === null || value.effective_to === null) return;
  if (Date.parse(value.effective_from) > Date.parse(value.effective_to)) {
    context.addIssue({ code: 'custom', message: 'effective_from must not be after effective_to', path: ['effective_from'] });
  }
});

const memoryRelated = z.object({
  edge: z.enum(['depends_on', 'explains', 'related_to']),
  from_ref: recordRef,
  to_ref: recordRef,
  reason: memoryReason.optional(),
}).strict();

const memoryOutcome = z.discriminatedUnion('type', [
  z.object({ type: z.literal('winner'), winner_ref: recordRef }).strict(),
  z.object({
    type: z.literal('record'),
    record: memoryRecord,
    effective_from: isoOrNull,
    effective_to: isoOrNull,
  }).strict(),
  z.object({ type: z.literal('retract_all') }).strict(),
]);

const memoryConflictResolved = z.object({
  fact_key: factKey,
  // Must be set-equal to the undecided conflict branches at append time
  // (ledger.ts precondition); fewer omits a branch, more invents one.
  branches: z.array(recordRef).min(2),
  outcome: memoryOutcome,
  reason: memoryReason,
}).strict().superRefine((value, context) => {
  if (value.outcome.type === 'winner' && !value.branches.includes(value.outcome.winner_ref)) {
    context.addIssue({ code: 'custom', message: 'winner_ref must be one of branches', path: ['outcome', 'winner_ref'] });
  }
});

/**
 * ADR-010 §3.2: `structure.queried` is snake_case only and strict. The query
 * event is the durable evidence that a real file/symbol structure query ran;
 * `recorded_at` is derived from the event envelope (HLC), never carried in the
 * payload, and `idem_key` is enforced at append/projection time.
 */
const structureQueryResult = z.object({
  total: z.number().int().nonnegative(),
  returned: z.number().int().nonnegative(),
  truncated: z.boolean(),
  impact: z.array(z.string().min(1).max(1024)).max(10_000).optional(),
  classification: coverageClassification.optional(),
}).strict();

const structureQueried = z.object({
  granularity: z.enum(['file', 'symbol']),
  file: z.string().min(1).max(1024),
  ref: z.string().min(1).max(512).optional(),
  graph_revision: z.string().min(1).max(256),
  query: z.string().min(1).max(2000),
  result: structureQueryResult,
}).strict();

const schemas: Partial<Record<LedgerEvent['kind'], z.ZodType>> = {
  'note.recorded': noteRecorded,
  'audit.finding': auditFindingRecorded,
  'audit.completed': auditCompleted,
  'readiness.evidence': readinessEvidence,
  'readiness.attestation': readinessAttestation,
  'release.verdict': releaseVerdict,
  'release.approved': releaseApproved,
  'memory.revised': memoryRevised,
  'memory.related': memoryRelated,
  'memory.conflict.resolved': memoryConflictResolved,
  'structure.queried': structureQueried,
};

/** Readiness/release payloads are accepted in either snake_case or camelCase. */
const camelToSnake: Record<string, string> = {
  artifactHash: 'artifact_hash',
  verdictHash: 'verdict_hash',
  sourceFingerprint: 'source_fingerprint',
  requirementId: 'requirement_id',
  requirementIds: 'requirement_ids',
  releaseTarget: 'release_target',
  signedAt: 'signed_at',
  expiresAt: 'expires_at',
  approvedAt: 'approved_at',
  approvalRef: 'approval_ref',
  attestationRef: 'attestation_ref',
  evidenceRef: 'evidence_ref',
  rawArtifactHash: 'raw_artifact_hash',
  profileIds: 'profile_ids',
};

function normalizeKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    normalized[camelToSnake[key] ?? key] = entry;
  }
  return normalized;
}

function normalizeNested(value: Record<string, unknown>): Record<string, unknown> {
  const top = normalizeKeys(value) as Record<string, unknown>;
  for (const key of ['evidence', 'attestation', 'finding', 'summary']) {
    if (top[key] !== undefined && top[key] !== null && typeof top[key] === 'object' && !Array.isArray(top[key])) {
      top[key] = normalizeKeys(top[key]);
    }
  }
  return top;
}

/**
 * Snake-case view of a payload for the cross-domain kinds. Callers that persist
 * the fields (views) and the validator see the same keys, so a camelCase
 * readiness/release payload is accepted without teaching every branch both
 * spellings. Memory kinds (ADR-005 §2.5) are snake_case only and pass through
 * untouched: the camelCase map is historical compatibility, not a precedent.
 */
export function normalizeLedgerPayload(kind: LedgerEvent['kind'], payload: Record<string, unknown>): Record<string, unknown> {
  if (isSnakeCaseOnlyEventKind(kind)) return payload;
  if (!schemas[kind]) return payload;
  return normalizeNested(payload);
}

/** Returns human-readable validation issues; an empty array means the payload is accepted. */
export function ledgerPayloadIssues(kind: LedgerEvent['kind'], payload: Record<string, unknown>): string[] {
  const schema = schemas[kind];
  if (!schema) return [];
  const result = schema.safeParse(isSnakeCaseOnlyEventKind(kind) ? payload : normalizeNested(payload));
  if (result.success) return [];
  return result.error.issues.map((issue) => `${issue.path.map(String).join('.') || '<payload>'}: ${issue.message}`);
}
