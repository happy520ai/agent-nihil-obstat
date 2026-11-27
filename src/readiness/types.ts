import { z } from 'zod';

export const PROFILE_IDS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'] as const;
export type ProfileId = (typeof PROFILE_IDS)[number];
export const ALL_SCOPES = ['common', ...PROFILE_IDS] as const;
export type RequirementScope = (typeof ALL_SCOPES)[number];

export const PROFILE_KINDS = [
  'common',
  'library',
  'cli',
  'service',
  'web',
  'mobile',
  'desktop',
  'mini_program',
  'data_ml',
  'iac',
] as const;
export type ProfileKind = (typeof PROFILE_KINDS)[number];

export const EVIDENCE_KINDS = [
  'ci_run',
  'deploy_record',
  'artifact_scan',
  'drill_record',
  'monitor_export',
  'load_test',
  'api_diff',
  'build_repro',
  'smoke_test',
  'dependency_audit',
  'docs_check',
  'secret_scan',
  'rollback_drill',
  'backup_drill',
  'capacity_test',
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const EVIDENCE_LEVELS = ['machine', 'attested', 'declaration', 'missing'] as const;
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];

/**
 * Where an evidence record came from.
 *
 * `local_check` is written by this tool's own static checks. Such records are
 * declarations about files that happened to be present in the project; they are
 * never machine evidence and can never satisfy a machine requirement.
 */
export const EVIDENCE_ORIGINS = ['external', 'local_check'] as const;
export type EvidenceOrigin = (typeof EVIDENCE_ORIGINS)[number];

export const REQUIREMENT_EVIDENCE = ['machine', 'attested', 'machine_or_attested'] as const;
export type RequirementEvidence = (typeof REQUIREMENT_EVIDENCE)[number];

export const PROFILE_STATUSES = ['defined', 'validated'] as const;
export type ProfileStatus = (typeof PROFILE_STATUSES)[number];

export const RELEASE_STATUSES = ['ready', 'conditional', 'blocked'] as const;
export type ReleaseStatus = (typeof RELEASE_STATUSES)[number];

export const GAP_KINDS = [
  'none',
  'attested_missing',
  'attested_expired',
  'machine_missing',
  'machine_invalid',
  'attestation_invalid',
] as const;
export type GapKind = (typeof GAP_KINDS)[number];

const sha256 = z.string().regex(/^[a-f0-9]{64}$/, 'expected a lowercase sha256 hex digest');
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, 'expected a bounded identifier');

export interface ValidationRecord {
  project: string;
  validatedAt: string;
  verdictHash: string;
}

export interface Requirement {
  id: string;
  title: string;
  scope: RequirementScope;
  evidence: RequirementEvidence;
  freshnessDays: number;
  check: string | null;
  kinds: EvidenceKind[];
}

export interface Profile {
  schema: number;
  id: RequirementScope;
  name: string;
  kind: ProfileKind;
  status: ProfileStatus;
  schemaHash: string;
  requirements: Requirement[];
  notes: string | null;
  validation: ValidationRecord | null;
}

export const evidenceRecordSchema = z.object({
  schema: z.literal(1),
  id: identifier,
  requirement_id: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,80}$/),
  kind: z.enum(EVIDENCE_KINDS),
  source_id: z.string().min(1).max(256),
  timestamp: z.string().datetime(),
  artifact_hash: sha256.optional(),
  source_fingerprint: sha256.optional(),
  raw_artifact: z.string().min(1).max(512),
  raw_artifact_hash: sha256,
  result: z.enum(['pass', 'fail']),
  /** Marks tool-generated local check output. Absent means "external file provider". */
  origin: z.enum(EVIDENCE_ORIGINS).optional(),
  expires_at: z.string().datetime().optional(),
  freshness_days: z.number().int().positive().max(3650).optional(),
}).strict();
export type EvidenceRecord = z.infer<typeof evidenceRecordSchema>;

export const attestationSchema = z.object({
  schema: z.literal(1),
  id: identifier,
  requirement_ids: z.array(z.string().regex(/^[a-z0-9][a-z0-9._-]{1,80}$/)).min(1),
  profile_ids: z.array(z.enum(ALL_SCOPES)).min(1),
  release_target: z.string().min(1).max(128),
  signer: z.object({
    name: z.string().min(1).max(120),
    role: z.string().min(1).max(120),
  }).strict(),
  signed_at: z.string().datetime(),
  expires_at: z.string().datetime(),
  artifact_hash: sha256,
  statement: z.string().min(1).max(2000),
}).strict();
export type AttestationRecord = z.infer<typeof attestationSchema>;

export interface ValidatedEvidence {
  /**
   * `machine` only for records accepted by the strict external file provider.
   * Records from this tool's own static checks are `declaration` and are never
   * counted as machine evidence by a release verdict.
   */
  classification: 'machine' | 'declaration';
  id: string;
  requirementId: string;
  kind: EvidenceKind;
  sourceId: string;
  timestamp: string;
  artifactHash: string | null;
  sourceFingerprint: string | null;
  rawArtifactDigest: string;
  rawArtifactBytes: number;
  expiresAt: string;
  evidenceRef: string;
}

export interface RejectedEvidence {
  file: string;
  id: string | null;
  requirementId: string | null;
  reason: string;
  detail: string;
}

export interface ValidatedAttestation {
  status: 'attested';
  id: string;
  requirementId: string;
  profileIds: RequirementScope[];
  signer: { name: string; role: string };
  signedAt: string;
  expiresAt: string;
  artifactHash: string;
  releaseTarget: string;
  attestationRef: string;
}

export interface RejectedAttestation {
  file: string;
  id: string | null;
  requirementId: string | null;
  reason: string;
  detail: string;
}

export interface ReleaseItem {
  id: string;
  requirement: string;
  scope: RequirementScope;
  status: EvidenceLevel;
  evidenceRef: string | null;
  expiresAt: string | null;
  gap: GapKind;
  reason: string;
}

export interface EvidenceSummary {
  machine: number;
  attested: number;
  declaration: number;
  missing: number;
}

export interface ProfileVerdict {
  profileId: RequirementScope;
  name: string;
  status: ReleaseStatus;
  summary: EvidenceSummary;
  itemIds: string[];
}

export interface ReleaseVerdict {
  schema: 1;
  target: string;
  artifactHash: string;
  sourceFingerprint: string | null;
  verdict: ReleaseStatus;
  perProfile: ProfileVerdict[];
  items: ReleaseItem[];
  summary: EvidenceSummary;
  caveats: string[];
  verdictHash: string;
}

export const releaseApprovalSchema = z.object({
  schema: z.literal(1),
  target: z.string().min(1).max(128),
  artifactHash: sha256,
  verdictHash: sha256,
  approver: z.string().min(2).max(120),
  approvedAt: z.string().datetime(),
  approvalRef: sha256,
}).strict();
export type ReleaseApproval = z.infer<typeof releaseApprovalSchema>;

export interface ReleaseApprovalCheck {
  valid: boolean;
  reasons: string[];
}
