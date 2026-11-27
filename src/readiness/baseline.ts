import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { canonicalJson } from '../ledger/event.ts';

/**
 * Versioned acceptance baseline.
 *
 * Invariants:
 * - the on-disk schema is strict and versioned; unknown fields are rejected;
 * - an approved baseline file is created exclusively and never overwritten;
 * - every evidence reference is recomputed as SHA-256, never trusted from input;
 * - a machine PASS can only come from a numeric metric in a real evidence file,
 *   not from a hand-written status/pass field;
 * - the three review reports (quality/coverage/build) are referenced, never
 *   written or overwritten by this module;
 * - approval requires a human attestation, an interactive TTY and an
 *   independent proof anchored to a controlled-ledger `release.approved` event.
 *
 * Proof format (what counts as approval evidence):
 * - `proof.approver` and `proof.approvedAt` must equal the human attestation;
 * - `proof.approvalRef` is SHA-256 over the canonical approval claim, which
 *   binds human/name/role/scope/statement/approvedAt/target/baseline identity;
 * - `proof.artifactSha256` is SHA-256 over the canonical draft being accepted;
 * - `proof.subjectSha256` is SHA-256 over the canonical approved verdict record
 *   (draft + status/approval), i.e. the "verdict/baseline content hash";
 * - `proof.ledgerEventId` names the controlled-ledger `release.approved` event.
 *
 * A file that merely carries internally consistent hashes is *not* approval:
 * both save and load call the injected verifier and refuse when no matching
 * ledger event exists. The secure default is to refuse when no verifier is
 * injected. The verifier is the orchestrator/master-control integration point;
 * it is deliberately not exposed as an MCP tool, and MCP/Node stream objects
 * are never accepted as approval evidence.
 *
 * Limitation: a TTY plus a ledger event is a *format* for human approval, not
 * cryptographic non-repudiation. The ledger records who/where/when under the
 * ledger's trust boundary; it cannot prove a natural person pressed a key.
 */

export const BASELINE_SCHEMA_VERSION = 1 as const;
export const BASELINE_ID = 'acceptance-baseline' as const;
export const APPROVAL_PROOF_SCHEMA = 'ano.baseline.approval-proof.v1' as const;
export const APPROVAL_CLAIM_SCHEMA = 'ano.baseline.approval-claim.v1' as const;

const HASH = /^[a-f0-9]{64}$/;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const OPERATORS = ['>=', '<=', '>', '<', '==', '!='] as const;
const EVIDENCE_KINDS = ['test', 'build', 'coverage', 'report', 'artifact'] as const;

export class BaselineError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'BaselineError';
    this.code = code;
  }
}

const evidenceRefSchema = z.object({
  path: z.string().min(1).max(1024),
  sha256: z.string().regex(HASH),
  kind: z.enum(EVIDENCE_KINDS),
}).strict();

const criterionSchema = z.object({
  id: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  metric: z.string().min(1).max(256).regex(/^[A-Za-z0-9_.]+$/),
  operator: z.enum(OPERATORS),
  target: z.number().finite(),
  evidence: evidenceRefSchema,
}).strict();

const reportsSchema = z.object({
  quality: evidenceRefSchema,
  coverage: evidenceRefSchema,
  build: evidenceRefSchema,
}).strict();

const draftSchema = z.object({
  schemaVersion: z.literal(BASELINE_SCHEMA_VERSION),
  version: z.number().int().positive().max(1_000_000),
  createdAt: z.string().datetime(),
  criteria: z.array(criterionSchema).min(1).max(500),
  reports: reportsSchema,
  notes: z.string().max(4000).optional(),
}).strict();

const approvalSchema = z.object({
  human: z.literal(true),
  tty: z.literal(true),
  name: z.string().min(1).max(200),
  role: z.string().min(1).max(200),
  scope: z.string().min(1).max(500),
  statement: z.string().min(1).max(4000),
  approvedAt: z.string().datetime(),
}).strict();

const approvalInputSchema = approvalSchema.omit({ approvedAt: true });

/**
 * Independent approval proof. It is stored inside the approved record and is
 * covered by `contentSha256`; the ledger event it names is the actual source of
 * truth. An agent can copy every field and recompute every hash, yet still fail
 * because it cannot make the controlled ledger contain the matching event.
 */
const proofSchema = z.object({
  schema: z.literal(APPROVAL_PROOF_SCHEMA),
  approver: z.string().min(1).max(200),
  approvedAt: z.string().datetime(),
  approvalRef: z.string().regex(HASH),
  artifactSha256: z.string().regex(HASH),
  subjectSha256: z.string().regex(HASH),
  target: z.string().min(1).max(200),
  baselineId: z.string().min(1).max(200),
  baselineVersion: z.number().int().positive().max(1_000_000),
  ledgerEventId: z.string().regex(ULID),
}).strict();

/**
 * Ledger `release.approved` payload contract. The event must be written by the
 * controlled ledger (not by an agent) before approval is attempted; the
 * orchestrator can build the exact payload with `releaseApprovedPayload`.
 */
const releaseApprovedPayloadSchema = z.object({
  target: z.string().min(1).max(200),
  artifact_hash: z.string().regex(HASH),
  verdict_hash: z.string().regex(HASH),
  approver: z.string().min(1).max(200),
  approved_at: z.string().datetime(),
  baseline_id: z.string().min(1).max(200),
  baseline_version: z.number().int().positive().max(1_000_000),
  approval_ref: z.string().regex(HASH),
}).strict();

const releaseApprovalEventSchema = z.object({
  event_id: z.string().regex(ULID),
  kind: z.literal('release.approved'),
  payload: releaseApprovedPayloadSchema,
});

const approvedSchema = draftSchema.extend({
  status: z.literal('approved'),
  approval: approvalSchema,
  proof: proofSchema,
  contentSha256: z.string().regex(HASH),
}).strict();

export type EvidenceRef = z.infer<typeof evidenceRefSchema>;
export type AcceptanceCriterion = z.infer<typeof criterionSchema>;
export type BaselineDraft = z.infer<typeof draftSchema>;
export type ApprovalInput = z.infer<typeof approvalInputSchema>;
export type Approval = z.infer<typeof approvalSchema>;
export type BaselineProof = z.infer<typeof proofSchema>;
export type ApprovedBaseline = z.infer<typeof approvedSchema>;
export type ReleaseApprovedPayload = z.infer<typeof releaseApprovedPayloadSchema>;
export type ReleaseApprovalEvent = z.infer<typeof releaseApprovalEventSchema>;

/** Query handed to the master-control/ledger verifier. */
export interface ReleaseApprovalVerifierRequest {
  root: string;
  expected: ReleaseApprovedPayload;
  /** When present the verifier must resolve exactly this ledger event id. */
  eventId?: string;
}

/**
 * Synchronous lookup in the controlled ledger. Return the matching
 * `release.approved` event, or null when no such event exists (refusal).
 *
 * Wiring contract for the orchestrator/master control:
 * - search only the ledger that belongs to `request.root` (never a global or
 *   agent-writable store), so a proof cannot be replayed across projects;
 * - match `request.expected` exactly and, when `request.eventId` is present,
 *   resolve that exact event id;
 * - the event kind must be `release.approved` (added to the controlled ledger
 *   vocabulary by the master; this module does not write ledger events);
 * - never derive the answer from MCP/stdio stream objects or agent input.
 * The baseline module re-validates the returned event and compares the payload;
 * a verifier is trusted configuration, never agent input.
 */
export type ReleaseApprovalVerifier = (request: ReleaseApprovalVerifierRequest) => ReleaseApprovalEvent | null;

export interface BaselineLoadOptions {
  verifier?: ReleaseApprovalVerifier;
}

export interface ApproveOptions extends BaselineLoadOptions {
  tty?: boolean;
  now?: () => number;
  /** Fixed ISO timestamp so the ledger event and the record can agree. */
  approvedAt?: string;
  /** Release target recorded in the ledger event; defaults per baseline version. */
  target?: string;
  /** Optional pin; the verifier must resolve exactly this event id. */
  ledgerEventId?: string;
}

/**
 * Reads only the real process streams. There is deliberately no parameter for
 * injecting stream objects: `{ stdin: { isTTY: true } }` is not approval
 * evidence and is rejected by `approveBaseline` when passed as an option.
 */
export function isInteractiveTty(): boolean {
  return process.stdin?.isTTY === true && process.stdout?.isTTY === true;
}

export function baselinesDirectory(root: string): string {
  return join(root, '.ano', 'readiness', 'baselines');
}

function padded(version: number): string {
  return String(version).padStart(6, '0');
}

export function draftPath(root: string, version: number): string {
  return join(baselinesDirectory(root), `${padded(version)}.draft.json`);
}

export function approvedPath(root: string, version: number): string {
  return join(baselinesDirectory(root), `${padded(version)}.approved.json`);
}

function safeProjectPath(root: string, path: string): string {
  const normalized = path.replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.split('/').includes('..')) {
    throw new BaselineError('BASELINE_INVALID', `Evidence path must stay inside the project: ${path}`);
  }
  return normalized;
}

function readEvidence(root: string, path: string): Buffer {
  const normalized = safeProjectPath(root, path);
  const absolute = resolve(root, normalized);
  const relativePath = relative(resolve(root), absolute).replaceAll('\\', '/');
  if (!relativePath || relativePath.startsWith('..')) throw new BaselineError('BASELINE_INVALID', `Evidence path escapes the project: ${path}`);
  if (!existsSync(absolute)) throw new BaselineError('BASELINE_EVIDENCE_MISMATCH', `Evidence file is missing: ${normalized}`);
  const info = statSync(absolute);
  if (!info.isFile()) throw new BaselineError('BASELINE_EVIDENCE_MISMATCH', `Evidence path is not a regular file: ${normalized}`);
  if (info.size > 64 * 1024 * 1024) throw new BaselineError('BASELINE_EVIDENCE_MISMATCH', `Evidence file is too large: ${normalized}`);
  return readFileSync(absolute);
}

export interface EvidenceCheck { ref: EvidenceRef; actual: string; ok: boolean }

export function hashEvidence(root: string, ref: EvidenceRef): EvidenceCheck {
  const bytes = readEvidence(root, ref.path);
  const actual = createHash('sha256').update(bytes).digest('hex');
  return { ref, actual, ok: actual === ref.sha256 };
}

function validateStructure(draft: BaselineDraft): void {
  const ids = new Set<string>();
  for (const criterion of draft.criteria) {
    if (ids.has(criterion.id)) throw new BaselineError('BASELINE_INVALID', `Duplicate criterion id: ${criterion.id}`);
    ids.add(criterion.id);
    safeProjectPath('', criterion.evidence.path);
  }
  const reports = [draft.reports.quality, draft.reports.coverage, draft.reports.build];
  const paths = new Set<string>();
  for (const report of reports) {
    safeProjectPath('', report.path);
    if (paths.has(report.path)) throw new BaselineError('BASELINE_INVALID', `The three review reports must be distinct files: ${report.path}`);
    paths.add(report.path);
    if (report.path.startsWith('.ano/readiness/baselines/')) {
      throw new BaselineError('BASELINE_INVALID', `A review report cannot point at the baseline store: ${report.path}`);
    }
  }
  if (draft.reports.quality.kind !== 'report') throw new BaselineError('BASELINE_INVALID', 'reports.quality.kind must be "report"');
  if (draft.reports.coverage.kind !== 'coverage') throw new BaselineError('BASELINE_INVALID', 'reports.coverage.kind must be "coverage"');
  if (draft.reports.build.kind !== 'build') throw new BaselineError('BASELINE_INVALID', 'reports.build.kind must be "build"');
}

function verifyEvidenceSet(root: string, draft: BaselineDraft): Map<string, string> {
  const actual = new Map<string, string>();
  const refs = [...draft.criteria.map((criterion) => criterion.evidence), draft.reports.quality, draft.reports.coverage, draft.reports.build];
  const mismatches: string[] = [];
  for (const ref of refs) {
    const check = hashEvidence(root, ref);
    actual.set(safeProjectPath(root, ref.path), check.actual);
    if (!check.ok) mismatches.push(`${check.ref.path} (declared ${check.ref.sha256.slice(0, 12)}…, actual ${check.actual.slice(0, 12)}…)`);
  }
  if (mismatches.length) {
    throw new BaselineError('BASELINE_EVIDENCE_MISMATCH', `Evidence SHA-256 does not match; refusing to trust declared hashes: ${mismatches.join('; ')}`);
  }
  return actual;
}

function parseDraft(value: unknown): BaselineDraft {
  const parsed = draftSchema.safeParse(value);
  if (!parsed.success) throw new BaselineError('BASELINE_INVALID', `Invalid baseline draft: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  validateStructure(parsed.data);
  return parsed.data;
}

function approvedVersions(root: string): number[] {
  const directory = baselinesDirectory(root);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .map((name) => /^(\d{6})\.approved\.json$/.exec(name)?.[1])
    .filter((value): value is string => value !== undefined)
    .map((value) => Number(value))
    .sort((a, b) => a - b);
}

function ensureVersionCanBeWritten(root: string, version: number): void {
  if (existsSync(approvedPath(root, version))) throw new BaselineError('BASELINE_IMMUTABLE', `Baseline v${version} is approved and cannot be changed`);
  const latest = approvedVersions(root).at(-1);
  if (latest !== undefined && version <= latest) throw new BaselineError('BASELINE_VERSION', `Baseline v${version} must be greater than the latest approved version v${latest}`);
}

function atomicWrite(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, contents, 'utf8');
  renameSync(temporary, path);
}

/** Validates and stores a draft. Drafts may be revised until that version is approved. */
export function saveBaselineDraft(root: string, input: unknown): BaselineDraft {
  const draft = parseDraft(input);
  ensureVersionCanBeWritten(root, draft.version);
  verifyEvidenceSet(root, draft);
  atomicWrite(draftPath(root, draft.version), JSON.stringify(draft, null, 2) + '\n');
  return draft;
}

export function loadBaselineDraft(root: string, version: number): BaselineDraft {
  const path = draftPath(root, version);
  if (!existsSync(path)) throw new BaselineError('BASELINE_INVALID', `Baseline draft v${version} does not exist`);
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new BaselineError('BASELINE_INVALID', `Baseline draft v${version} is not valid JSON`); }
  return parseDraft(raw);
}

function canonicalSha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function resolveTarget(version: number, target: string | undefined): string {
  const value = target ?? `${BASELINE_ID}@v${version}`;
  if (typeof value !== 'string' || value.length < 1 || value.length > 200) {
    throw new BaselineError('BASELINE_INVALID', 'Baseline approval target must be a non-empty string of at most 200 characters');
  }
  return value;
}

function approvalClaim(version: number, approval: Approval, target: string): Record<string, unknown> {
  return {
    schema: APPROVAL_CLAIM_SCHEMA,
    human: approval.human,
    name: approval.name,
    role: approval.role,
    scope: approval.scope,
    statement: approval.statement,
    approvedAt: approval.approvedAt,
    target,
    baselineId: BASELINE_ID,
    baselineVersion: version,
  };
}

/**
 * Builds the exact payload the controlled ledger must contain. The
 * orchestrator calls this before writing `release.approved`, then passes the
 * same `approvedAt`/`target` to `approveBaseline` together with the verifier.
 */
export function releaseApprovedPayload(draft: BaselineDraft, approval: Approval, target?: string): ReleaseApprovedPayload {
  const resolved = resolveTarget(draft.version, target);
  return {
    target: resolved,
    artifact_hash: canonicalSha256(draft),
    verdict_hash: canonicalSha256({ ...draft, status: 'approved' as const, approval }),
    approver: approval.name,
    approved_at: approval.approvedAt,
    baseline_id: BASELINE_ID,
    baseline_version: draft.version,
    approval_ref: canonicalSha256(approvalClaim(draft.version, approval, resolved)),
  };
}

function requireVerifier(value: unknown): ReleaseApprovalVerifier {
  if (typeof value !== 'function') {
    throw new BaselineError(
      'BASELINE_LEDGER_VERIFIER_REQUIRED',
      'Approval and load require an injected verifier for the controlled ledger release.approved event; without one the baseline is refused (secure default). No MCP tool can approve or verify baselines.',
    );
  }
  return value as ReleaseApprovalVerifier;
}

function verifiedLedgerEvent(
  root: string,
  expected: ReleaseApprovedPayload,
  verifier: ReleaseApprovalVerifier,
  eventId: string | undefined,
): ReleaseApprovalEvent {
  let result: unknown;
  try {
    result = eventId === undefined ? verifier({ root, expected }) : verifier({ root, expected, eventId });
  } catch (error) {
    throw new BaselineError('BASELINE_LEDGER_UNVERIFIED', `The release.approved ledger verifier failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (result === null || result === undefined) {
    throw new BaselineError('BASELINE_LEDGER_UNVERIFIED', 'No matching release.approved event exists in the controlled ledger; the proof has no ledger provenance and is refused');
  }
  const parsed = releaseApprovalEventSchema.safeParse(result);
  if (!parsed.success) {
    throw new BaselineError('BASELINE_LEDGER_MISMATCH', `Ledger verifier returned a malformed release.approved event: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  }
  if (eventId !== undefined && parsed.data.event_id !== eventId) {
    throw new BaselineError('BASELINE_LEDGER_MISMATCH', `Ledger event ${parsed.data.event_id} does not match the proof event id ${eventId}`);
  }
  if (canonicalJson(parsed.data.payload) !== canonicalJson(expected)) {
    throw new BaselineError('BASELINE_LEDGER_MISMATCH', 'The release.approved ledger event payload does not match the baseline approval subject');
  }
  return parsed.data;
}

function rejectStreamEvidence(options: unknown): void {
  if (typeof options !== 'object' || options === null) return;
  for (const key of ['stdin', 'stdout', 'stderr', 'streams', 'ttyStreams']) {
    if (Object.hasOwn(options, key)) {
      throw new BaselineError('BASELINE_INVALID', 'TTY stream objects are not approval evidence; approval requires human attestation plus a ledger-proven release.approved event');
    }
  }
}

/**
 * Approves a draft. Requires:
 * - a human attestation;
 * - an interactive TTY (a non-interactive discovery is always refused);
 * - an injected verifier that finds the matching `release.approved` event in
 *   the controlled ledger. Without a verifier the call is refused.
 */
export function approveBaseline(
  root: string,
  version: number,
  attestation: ApprovalInput,
  options: ApproveOptions = {},
): ApprovedBaseline {
  rejectStreamEvidence(options);
  const tty = options.tty === undefined ? isInteractiveTty() : options.tty;
  if (typeof tty !== 'boolean') throw new BaselineError('BASELINE_INVALID', 'options.tty must be a boolean assertion, not a stream object');
  if (!tty) throw new BaselineError('BASELINE_TTY_REQUIRED', 'Baseline approval requires an interactive human TTY; non-TTY approval is refused');
  const approval = approvalInputSchema.safeParse(attestation);
  if (!approval.success) {
    throw new BaselineError('BASELINE_APPROVAL_REQUIRED', `Human attestation is required: ${approval.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  }
  const verifier = requireVerifier(options.verifier);
  ensureVersionCanBeWritten(root, version);
  const draft = loadBaselineDraft(root, version);
  const before = verifyEvidenceSet(root, draft);
  const approvedAt = options.approvedAt ?? new Date(options.now?.() ?? Date.now()).toISOString();
  if (!z.string().datetime().safeParse(approvedAt).success) {
    throw new BaselineError('BASELINE_INVALID', 'Approved-at must be an ISO-8601 datetime');
  }
  const approvalRecord: Approval = { ...approval.data, approvedAt };
  const target = resolveTarget(version, options.target);
  const expected = releaseApprovedPayload(draft, approvalRecord, target);
  const event = verifiedLedgerEvent(root, expected, verifier, options.ledgerEventId);
  const after = verifyEvidenceSet(root, draft);
  for (const [path, hash] of before) if (after.get(path) !== hash) throw new BaselineError('BASELINE_EVIDENCE_MISMATCH', `Evidence changed during approval: ${path}`);

  const subject = { ...draft, status: 'approved' as const, approval: approvalRecord };
  const proof: BaselineProof = {
    schema: APPROVAL_PROOF_SCHEMA,
    approver: expected.approver,
    approvedAt: expected.approved_at,
    approvalRef: expected.approval_ref,
    artifactSha256: expected.artifact_hash,
    subjectSha256: expected.verdict_hash,
    target: expected.target,
    baselineId: expected.baseline_id,
    baselineVersion: expected.baseline_version,
    ledgerEventId: event.event_id,
  };
  const record: ApprovedBaseline = { ...subject, proof, contentSha256: canonicalSha256({ ...subject, proof }) };
  const path = approvedPath(root, version);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(record, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'UNKNOWN';
    if (code === 'EEXIST') throw new BaselineError('BASELINE_IMMUTABLE', `Baseline v${version} is already approved and cannot be overwritten`);
    throw error;
  }
  // The approved artifact supersedes the draft; the draft can no longer be
  // edited once its version has an immutable approved record.
  try { unlinkSync(draftPath(root, version)); } catch { /* a missing draft is already superseded */ }
  return record;
}

function draftFromApproved(record: ApprovedBaseline): BaselineDraft {
  return {
    schemaVersion: record.schemaVersion,
    version: record.version,
    createdAt: record.createdAt,
    criteria: record.criteria,
    reports: record.reports,
    ...(record.notes === undefined ? {} : { notes: record.notes }),
  };
}

function assertProof(root: string, record: ApprovedBaseline, verifier: unknown): void {
  const draft = draftFromApproved(record);
  const expected = releaseApprovedPayload(draft, record.approval, record.proof.target);
  const mismatch = (field: string): never => {
    throw new BaselineError('BASELINE_INTEGRITY', `Approved baseline v${record.version} proof field ${field} does not match the recomputed approval subject; the file was modified`);
  };
  if (record.proof.baselineId !== BASELINE_ID || record.proof.baselineVersion !== record.version) mismatch('baseline');
  if (record.proof.approver !== record.approval.name) mismatch('approver');
  if (record.proof.approvedAt !== record.approval.approvedAt) mismatch('approvedAt');
  if (record.proof.approvalRef !== expected.approval_ref) mismatch('approvalRef');
  if (record.proof.artifactSha256 !== expected.artifact_hash) mismatch('artifactSha256');
  if (record.proof.subjectSha256 !== expected.verdict_hash) mismatch('subjectSha256');
  if (record.proof.target !== expected.target) mismatch('target');
  const resolvedVerifier = requireVerifier(verifier);
  verifiedLedgerEvent(root, expected, resolvedVerifier, record.proof.ledgerEventId);
}

/**
 * Loads an approved baseline. Besides the strict schema and `contentSha256`,
 * the proof must name a matching `release.approved` event in the controlled
 * ledger; loading without a verifier is refused.
 */
export function loadApprovedBaseline(root: string, version: number, options: BaselineLoadOptions = {}): ApprovedBaseline {
  const path = approvedPath(root, version);
  if (!existsSync(path)) throw new BaselineError('BASELINE_INVALID', `Approved baseline v${version} does not exist`);
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new BaselineError('BASELINE_INTEGRITY', `Approved baseline v${version} is not valid JSON`); }
  const parsed = approvedSchema.safeParse(raw);
  if (!parsed.success) throw new BaselineError('BASELINE_INTEGRITY', `Approved baseline v${version} fails its strict schema`);
  const { contentSha256, ...withoutHash } = parsed.data;
  if (canonicalSha256(withoutHash) !== contentSha256) throw new BaselineError('BASELINE_INTEGRITY', `Approved baseline v${version} content hash does not match; the file was modified`);
  assertProof(root, parsed.data, options.verifier);
  return parsed.data;
}

function metricValue(document: unknown, metric: string): unknown {
  let current: unknown = document;
  for (const part of metric.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    if (!Object.hasOwn(current, part)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function compare(actual: number, operator: typeof OPERATORS[number], target: number): boolean {
  switch (operator) {
    case '>=': return actual >= target;
    case '<=': return actual <= target;
    case '>': return actual > target;
    case '<': return actual < target;
    case '==': return actual === target;
    case '!=': return actual !== target;
  }
}

export interface CriterionEvaluation {
  id: string;
  status: 'machine' | 'invalid';
  actual?: number;
  pass: boolean;
}

export interface BaselineVerification {
  valid: boolean;
  version: number;
  contentSha256: string;
  approvalVerified: boolean;
  ledgerEventId: string;
  approver: string;
  proofTarget: string;
  reportsValid: boolean;
  criteria: CriterionEvaluation[];
  problems: string[];
}

/**
 * Recomputes every SHA-256 and every numeric metric. A string/boolean metric
 * such as a hand-written "PASS" is refused instead of being treated as true.
 * The approved file's proof is checked against the controlled ledger first.
 */
export function verifyBaseline(root: string, version: number, options: BaselineLoadOptions = {}): BaselineVerification {
  const approved = loadApprovedBaseline(root, version, options);
  const problems: string[] = [];
  const reportRefs = [approved.reports.quality, approved.reports.coverage, approved.reports.build];
  let reportsValid = true;
  for (const ref of reportRefs) {
    try {
      if (!hashEvidence(root, ref).ok) { reportsValid = false; problems.push(`report-hash-mismatch:${ref.path}`); }
    } catch (error) {
      reportsValid = false;
      problems.push(`report-invalid:${ref.path}:${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const criteria: CriterionEvaluation[] = [];
  for (const criterion of approved.criteria) {
    try {
      const check = hashEvidence(root, criterion.evidence);
      if (!check.ok) {
        criteria.push({ id: criterion.id, status: 'invalid', pass: false });
        problems.push(`evidence-hash-mismatch:${criterion.id}:${criterion.evidence.path}`);
        continue;
      }
      let document: unknown;
      try { document = JSON.parse(readEvidence(root, criterion.evidence.path).toString('utf8')); }
      catch {
        criteria.push({ id: criterion.id, status: 'invalid', pass: false });
        problems.push(`evidence-not-json:${criterion.id}`);
        continue;
      }
      const value = metricValue(document, criterion.metric);
      if (value === undefined) {
        criteria.push({ id: criterion.id, status: 'invalid', pass: false });
        problems.push(`metric-missing:${criterion.id}:${criterion.metric}`);
        continue;
      }
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        criteria.push({ id: criterion.id, status: 'invalid', pass: false });
        problems.push(`machine-pass-must-be-numeric:${criterion.id}: hand-written verdict strings are refused`);
        continue;
      }
      const pass = compare(value, criterion.operator, criterion.target);
      criteria.push({ id: criterion.id, status: 'machine', actual: value, pass });
      if (!pass) problems.push(`criterion-failed:${criterion.id}: ${criterion.metric}=${value} ${criterion.operator} ${criterion.target}`);
    } catch (error) {
      criteria.push({ id: criterion.id, status: 'invalid', pass: false });
      problems.push(`evidence-invalid:${criterion.id}:${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    valid: problems.length === 0 && reportsValid && criteria.every((criterion) => criterion.pass && criterion.status === 'machine'),
    version,
    contentSha256: approved.contentSha256,
    approvalVerified: true,
    ledgerEventId: approved.proof.ledgerEventId,
    approver: approved.proof.approver,
    proofTarget: approved.proof.target,
    reportsValid,
    criteria,
    problems,
  };
}

export interface BaselineListing { version: number; status: 'draft' | 'approved'; path: string }

export function listBaselines(root: string): BaselineListing[] {
  const directory = baselinesDirectory(root);
  if (!existsSync(directory)) return [];
  const listings: BaselineListing[] = [];
  for (const name of readdirSync(directory)) {
    const match = /^(\d{6})\.(draft|approved)\.json$/.exec(name);
    if (!match) continue;
    const version = Number(match[1]);
    const status = match[2] === 'approved' ? 'approved' as const : 'draft' as const;
    listings.push({ version, status, path: join(directory, name) });
  }
  return listings.sort((a, b) => a.version - b.version || a.status.localeCompare(b.status));
}
