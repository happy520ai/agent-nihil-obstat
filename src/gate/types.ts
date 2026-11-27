import { z } from 'zod';
import type { BlastRadius, BlastRiskSummary, CoveragePolicy } from './blast.ts';
import type { ReviewItem } from '../structure/risk.ts';
import type { GraphCaveats, Freshness } from '../structure/types.ts';

/**
 * Recorded execution environment. Node fields are always present; Python adds
 * the owned interpreter path/hash and the result-artifact digest (ADR-014 §4.2).
 * The schema stays strict so an adapter cannot smuggle arbitrary payloads in.
 */
export const evidenceEnvironmentSchema = z.object({
  node: z.string(),
  platform: z.string(),
  arch: z.string(),
  interpreter: z.string().min(1).optional(),
  interpreterSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  resultXmlSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
export type EvidenceEnvironment = z.infer<typeof evidenceEnvironmentSchema>;

export const evidenceSchema = z.object({
  id: z.string().uuid(),
  argv: z.array(z.string()).min(1),
  cwd: z.string().min(1),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  graphRevision: z.string().min(1),
  environment: evidenceEnvironmentSchema,
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  durationMs: z.number().nonnegative(),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  timedOut: z.boolean(),
  counts: z.record(z.string(), z.number().int().nonnegative()),
  ok: z.boolean(),
  outputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  failureExcerpt: z.string().max(4000).optional(),
  error: z.string().max(1000).optional(),
}).strict();
export type Evidence = z.infer<typeof evidenceSchema>;
export type EvidenceCommand = { argv: string[]; cwd: string; timeoutMs: number; env?: Record<string, string>; envExclude?: readonly string[] };

export const riskLevelSchema = z.enum(['high', 'medium', 'low']);

/**
 * ADR-010 §6: structural risk is advisory input attached to a blast radius. It
 * never becomes execution evidence and never carries an `evidence_id`. The
 * schema is strict and additive: legacy blast radii without `risk` still parse.
 */
export const blastRiskSummarySchema = z.object({
  revision: z.string().min(1),
  levels: z.record(z.string(), riskLevelSchema),
  counts: z.object({
    high: z.number().int().nonnegative(),
    medium: z.number().int().nonnegative(),
    low: z.number().int().nonnegative(),
  }).strict(),
  /** High-risk centers ordered by fanout desc, then path Buffer order. */
  highCenters: z.array(z.string()),
  /** High/medium files no test reaches through resolved value-confirmed imports. */
  testGaps: z.array(z.string()),
  reviewCount: z.number().int().nonnegative(),
}).strict();

export const blastRadiusSchema = z.object({
  impacted: z.array(z.string()),
  covered: z.array(z.string()),
  uncovered: z.array(z.string()),
  advisory: z.array(z.string()),
  /** Absent unless ADR-010 §5 grading was requested; existing callers are unaffected. */
  risk: blastRiskSummarySchema.optional(),
}).strict();

const coverageClassificationSchema = z.enum([
  'parsed',
  'zero-symbol',
  'zero-edge',
  'dynamic-only',
  'unsupported',
  'excluded',
  'deleted',
  'degraded',
  'unknown',
]);

export const reviewKindSchema = z.enum([
  'blind-spot',
  'dynamic-load',
  'registry',
  'reflection',
  'eval',
  'zero-symbol',
  'zero-edge',
  'deleted',
  'test-gap',
  'high-fanout',
]);
export const reviewOriginSchema = z.enum(['manual-review', 'classification', 'test-gap', 'risk-level']);

/**
 * Manual-review entries are inputs, not Gate evidence. `evidenceRevision` binds
 * them to a graph revision; there is deliberately no `evidence_id` field.
 */
export const reviewItemSchema = z.object({
  kind: reviewKindSchema,
  file: z.string().min(1),
  line: z.number().int().nonnegative().optional(),
  pattern: z.string().optional(),
  classification: coverageClassificationSchema.optional(),
  reason: z.string().min(1),
  suggestedAction: z.string().min(1),
  evidenceRevision: z.string().min(1),
  origin: reviewOriginSchema,
}).strict();

/** Executed tests versus the structurally high-risk set; the gap is explicit. */
export const structureCoverageGapSchema = z.object({
  executedTests: z.array(z.string()),
  highRiskFiles: z.array(z.string()),
  coveredHighRisk: z.array(z.string()),
  /** Difference set: high-risk files no executed test reaches. */
  uncoveredHighRisk: z.array(z.string()),
  testGaps: z.array(z.string()).optional(),
}).strict();

export interface StructureCoverageGap {
  readonly executedTests: readonly string[];
  readonly highRiskFiles: readonly string[];
  readonly coveredHighRisk: readonly string[];
  readonly uncoveredHighRisk: readonly string[];
  readonly testGaps?: readonly string[];
}

export interface StructureEvidence {
  readonly riskSummary?: BlastRiskSummary;
  readonly coverageGap?: StructureCoverageGap;
  readonly reviewItems?: readonly ReviewItem[];
  /** Number of caller-supplied review claims that were ignored as untrusted. */
  readonly untrustedReviewItems?: number;
  /** How the existing coverage policy consumed the structural blind spots. */
  readonly policyEffect?: 'blocked' | 'warned' | 'recorded';
}

export const structureEvidenceSchema = z.object({
  riskSummary: blastRiskSummarySchema.optional(),
  coverageGap: structureCoverageGapSchema.optional(),
  reviewItems: z.array(reviewItemSchema).optional(),
  untrustedReviewItems: z.number().int().nonnegative().optional(),
  policyEffect: z.enum(['blocked', 'warned', 'recorded']).optional(),
}).strict();

export interface TaskVerdict {
  taskId: string;
  status: 'done' | 'blocked';
  level: 'T0' | 'T1' | 'none';
  evidenceId?: string;
  sourceFingerprint: string;
  graphRevision: string;
  freshness: Freshness;
  blastRadius: BlastRadius;
  policy: CoveragePolicy;
  caveats: GraphCaveats;
  reasons: string[];
  /** ADR-010 §6 structural coverage evidence; absent on legacy verdicts. */
  structure?: StructureEvidence;
  /** Non-blocking structural warnings (advisory policy or non-blocking findings). */
  warnings?: string[];
}

/** Stored with an evidence record; the caller-provided verdict is never trusted blindly. */
export const storedVerificationSchema = z.object({
  idem_key: z.string().min(1),
  params: z.string().min(1),
  identity: z.string().min(1),
  task_id: z.string().min(1),
  graph_revision: z.string().min(1),
  test_files: z.array(z.string()).min(1),
  policy: z.object({ minimum: z.enum(['T0', 'T1']), unknown: z.enum(['strict', 'advisory']) }).strict(),
  verdict: z.object({
    taskId: z.string().min(1),
    status: z.enum(['done', 'blocked']),
    level: z.enum(['T0', 'T1', 'none']),
    sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    graphRevision: z.string().min(1),
    freshness: z.union([
      z.object({ status: z.literal('fresh'), stale: z.literal(0) }).strict(),
      z.object({ status: z.enum(['stale', 'degraded']), stale: z.number().int().nonnegative() }).strict(),
    ]),
    blastRadius: blastRadiusSchema,
    policy: z.object({ minimum: z.enum(['T0', 'T1']), unknown: z.enum(['strict', 'advisory']) }).strict(),
    caveats: z.record(z.string(), z.unknown()),
    reasons: z.array(z.string()),
    evidenceId: z.string().uuid().optional(),
    structure: structureEvidenceSchema.optional(),
    warnings: z.array(z.string()).optional(),
  }).strict(),
}).strict();
export type StoredVerification = z.infer<typeof storedVerificationSchema>;
