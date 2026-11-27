import { createHash, randomUUID } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { z } from 'zod';
import type { SourceFingerprint } from '../core/fingerprint.ts';
import { fingerprintProject, resolveProjectSourceScan } from '../core/source-scan.ts';
import { canonicalJson } from '../ledger/event.ts';
import type { Ledger, LedgerEvidence } from '../ledger/ledger.ts';
import type { GraphStore } from '../structure/store.ts';
import type { Freshness, GraphSnapshot } from '../structure/types.ts';
import { nodeEvidenceAdapter, SHELL_EXECUTABLES, validateNodeTestCommand } from './adapters/node.ts';
import { pytestEvidenceAdapter } from './adapters/pytest.ts';
import type { EvidenceAdapter } from './adapters/types.ts';
import { executeEvidence, redactArgv } from './evidence.ts';
import { policySchema } from './policy.ts';
import { verdictForTask } from './verdict.ts';
import { blastRadiusSchema, evidenceSchema, structureEvidenceSchema, type Evidence, type EvidenceCommand, type EvidenceEnvironment, type TaskVerdict } from './types.ts';
import type { CoveragePolicy } from './blast.ts';
import type { RiskThresholdOptions, RiskWeightOptions } from '../structure/risk.ts';

export interface VerifyServices { ledger: Ledger; graph: GraphStore }

/** ADR-010 §5 grading opt-in. Structural evidence is recorded; it never replaces execution evidence. */
export interface VerifyStructureOptions {
  readonly enabled?: boolean;
  readonly weights?: RiskWeightOptions;
  readonly thresholds?: RiskThresholdOptions;
  readonly testFiles?: readonly string[];
}

export interface VerifyRequest {
  argv: string[];
  testFiles?: string[];
  timeoutMs?: number;
  idemKey?: string;
  /**
   * Opt-in structural coverage evidence (ADR-010 §6). Absent/false keeps the
   * exact legacy verdict shape; true enables default grading.
   */
  readonly structure?: boolean | VerifyStructureOptions;
  /**
   * Caller-supplied review claims. They are never trusted: the Gate recomputes
   * the authoritative review list from the current snapshot and records how
   * many forged entries were ignored.
   */
  readonly reviewItems?: readonly unknown[];
}

function structureRequestOptions(value: boolean | VerifyStructureOptions | undefined): VerifyStructureOptions | undefined {
  if (value === undefined || value === false) return undefined;
  if (value === true) return {};
  return value.enabled === false ? undefined : value;
}

/** Registered evidence adapters. detect() sets are disjoint; Node stays first for its exact refusal text. */
const EVIDENCE_ADAPTERS: readonly EvidenceAdapter[] = [nodeEvidenceAdapter, pytestEvidenceAdapter];

/**
 * Chooses the adapter that owns argv before anything runs. Unknown runners keep
 * the pre-migration refusal order and text byte for byte: shells first, then the
 * Node-runner message that remains the single fallback when no adapter matches.
 */
export function selectEvidenceAdapter(argv: readonly string[]): EvidenceAdapter {
  if (!argv.length) throw new Error('Verification requires an argv array');
  const rawExecutable = argv[0]!;
  const executable = basename(rawExecutable).toLowerCase();
  if (SHELL_EXECUTABLES.has(executable)) throw new Error(`Verification must not execute through a shell; the declared test file is not selected by argv: ${executable}`);
  const adapter = EVIDENCE_ADAPTERS.find((candidate) => candidate.detect(argv));
  if (!adapter) throw new Error(`Verification must use the supported Node test runner (node/node.exe); refusing executable: ${rawExecutable}`);
  return adapter;
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Requires a supported real Node test runner (`node`/`node.exe`), the `--test`
 * flag, and exactly the declared test files as positional arguments. A wrapper
 * script (`node --test fake.mjs a.test.ts`), a non-Node interpreter, inline
 * evaluation, a shell, a preload hook, or a custom reporter is refused because
 * the observed summary would not be produced by the declared files.
 */
export function commandSelectsTests(root: string, argv: string[], tests: string[]): void {
  validateNodeTestCommand(root, argv, tests);
}

function isSourcePath(path: string, supportedExtensions: readonly string[]): boolean {
  return supportedExtensions.some((extension) => path.endsWith(extension));
}

/**
 * Python sources are always source drift, independent of ENABLE_PYTHON_STRUCTURE:
 * a test that writes `extra.py` during execution must invalidate the evidence even
 * while the structural extractor is off (ADR-014 §2.4/§4.2).
 */
const PYTHON_SOURCE_EXTENSIONS: readonly string[] = ['.py', '.pyi'];
function isDriftSourcePath(path: string, supportedExtensions: readonly string[]): boolean {
  return isSourcePath(path, supportedExtensions) || PYTHON_SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension));
}

/**
 * Canonical idempotency parameters. Only the redacted argv is persisted; a
 * SHA-256 of the raw argv preserves the distinction between two different
 * secrets without writing either secret to the ledger.
 */
export function verificationParameters(taskId: string, argv: string[], tests: string[], policy: CoveragePolicy): string {
  const argvDigest = createHash('sha256').update(canonicalJson(argv)).digest('hex');
  return canonicalJson({ task_id: taskId, argv: redactArgv(argv), argv_digest: argvDigest, test_files: tests, policy });
}

/** Files that existed before execution must be byte-identical afterwards; new non-source artifacts (test output) are allowed. */
export function sourceDrift(before: SourceFingerprint, after: SourceFingerprint, supportedExtensions: readonly string[]): string[] {
  const previous = new Set(before.files.map((file) => file.path));
  const afterwards = new Map(after.files.map((file) => [file.path, file.hash]));
  const changed = before.files.filter((file) => afterwards.get(file.path) !== file.hash).map((file) => file.path);
  const added = after.files.filter((file) => isDriftSourcePath(file.path, supportedExtensions) && !previous.has(file.path)).map((file) => file.path);
  const degraded = after.degraded.map((entry) => entry.path);
  const incomplete = after.status !== 'ok' ? [`[source scan ${after.status ?? 'incomplete'}]`] : [];
  return [...new Set([...changed, ...added, ...degraded, ...incomplete])].sort();
}

/** Graph freshness uses the active extractor extensions and ignores non-source test artifacts. */
export function sourceFreshness(snapshot: GraphSnapshot, after: SourceFingerprint, supportedExtensions: readonly string[]): Freshness {
  if (after.status !== 'ok' || after.degraded.length > 0) {
    return { status: 'degraded', stale: 0, reasons: [after.reason ?? `source-scan-${after.status ?? 'incomplete'}`, ...after.degraded.map((entry) => `${entry.path}:${entry.code}`)] };
  }
  const current = new Map(after.files.filter((file) => isSourcePath(file.path, supportedExtensions)).map((file) => [file.path, file.hash]));
  let stale = 0;
  for (const [path, file] of Object.entries(snapshot.files)) if (current.get(path) !== file.hash) stale += 1;
  for (const path of current.keys()) if (!Object.hasOwn(snapshot.files, path)) stale += 1;
  return stale === 0 ? { status: 'fresh', stale: 0 } : { status: 'stale', stale };
}

const freshnessSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('fresh'), stale: z.literal(0) }).strict(),
  z.object({ status: z.literal('stale'), stale: z.number().int().nonnegative() }).strict(),
  z.object({ status: z.literal('degraded'), stale: z.number().int().nonnegative(), reasons: z.array(z.string()) }).strict(),
]);
const graphCaveatsSchema = z.object({
  edgeCounts: z.object({
    'value-confirmed': z.number().int().nonnegative(),
    'type-only': z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative(),
  }).strict(),
  heuristicEdges: z.number().int().nonnegative(),
  unknownRatio: z.number().nonnegative(),
  filesWithUnresolvableDynamicLoads: z.number().int().nonnegative(),
  dynamicLoadCount: z.number().int().nonnegative(),
  degradedReasons: z.array(z.string()),
  callEdges: z.number().int().nonnegative().optional(),
  resolvedCallEdges: z.number().int().nonnegative().optional(),
  heuristicCallEdges: z.number().int().nonnegative().optional(),
  typeOnlyCallSites: z.number().int().nonnegative().optional(),
  unresolvedCallSites: z.number().int().nonnegative().optional(),
  // Symbols produced by CommonJS export extraction (ADR-010 §7.1); counts only, no payload data.
  commonjsExports: z.number().int().nonnegative().optional(),
  // ADR-010 §7.3 blind-spot evidence: zero unresolved loads never implies zero blind spots.
  semanticGaps: z.array(z.object({
    file: z.string(),
    line: z.number().int().nonnegative(),
    pattern: z.string(),
    reason: z.string(),
  }).strict()).optional(),
  dynamicLoadKinds: z.object({
    resolved: z.number().int().nonnegative(),
    heuristic: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative(),
  }).strict().optional(),
  dynamicLoadSites: z.array(z.object({
    file: z.string(),
    line: z.number().int().nonnegative(),
    pattern: z.enum(['dynamic-import', 'require', 'computed-require', 'registry-scan', 'reflection', 'eval']),
    tier: z.enum(['resolved', 'heuristic', 'unknown']),
    reason: z.string(),
    target: z.string().optional(),
  }).strict()).optional(),
  registryFiles: z.array(z.string()).optional(),
  reflectionFiles: z.array(z.string()).optional(),
  zeroSymbolFiles: z.array(z.string()).optional(),
}).strict();
// The schema validates the wire shape strictly; the cast only aligns zod's
// optional-field inference (`T | undefined`) with the interface under
// exactOptionalPropertyTypes. Runtime validation is unchanged.
const taskVerdictSchema = z.object({
  taskId: z.string().min(1),
  status: z.enum(['done', 'blocked']),
  level: z.enum(['T0', 'T1', 'none']),
  evidenceId: z.string().uuid().optional(),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  graphRevision: z.string().min(1),
  freshness: freshnessSchema,
  blastRadius: blastRadiusSchema,
  policy: policySchema,
  caveats: graphCaveatsSchema,
  reasons: z.array(z.string()),
  structure: structureEvidenceSchema.optional(),
  warnings: z.array(z.string()).optional(),
}).strict() as unknown as z.ZodType<TaskVerdict>;

/**
 * Metadata persisted with the evidence so a retry can reuse the exact run.
 * Every field is revalidated against the current ledger, source, graph and
 * policy before reuse; a stored verdict is never returned on its own.
 */
const storedVerificationSchema = z.object({
  idem_key: z.string().min(1).max(128),
  params: z.string().min(1),
  identity: z.string().min(1),
  root: z.string().min(1),
  task_id: z.string().min(1),
  evidence_id: z.string().uuid(),
  test_files: z.array(z.string().min(1)),
  policy: policySchema,
  graph_revision: z.string().min(1),
  touched: z.array(z.string()),
  verdict: taskVerdictSchema,
}).strict();
const recordedEvidenceSchema = evidenceSchema.extend({ verification: storedVerificationSchema }).strict();

type StoredVerification = z.infer<typeof storedVerificationSchema>;
type RecordedEvidence = Evidence & { verification: StoredVerification };
interface PriorEvidence { record: LedgerEvidence; evidence: Evidence; verification: StoredVerification }

function parsePrior(records: LedgerEvidence[], key: string, params: string, identity: string): PriorEvidence | undefined {
  const candidates: PriorEvidence[] = [];
  for (const record of records) {
    const raw = record.evidence.verification;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    if ((raw as Record<string, unknown>).idem_key !== key) continue;
    const parsed = recordedEvidenceSchema.safeParse(record.evidence);
    if (!parsed.success) {
      throw new Error(`Evidence ${record.id} for idempotency key ${key} failed strict verification validation: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
    }
    if (record.id !== parsed.data.id) throw new Error(`Evidence ${record.id} does not match its recorded id ${parsed.data.id}`);
    const { verification: _verification, ...base } = parsed.data;
    candidates.push({ record, evidence: evidenceSchema.parse(base), verification: parsed.data.verification });
  }
  if (!candidates.length) return undefined;
  const sameParameters = candidates.filter((candidate) => candidate.verification.params === params);
  if (!sameParameters.length) throw new Error(`Idempotency key ${key} was already used with different verification parameters`);
  const exact = sameParameters.filter((candidate) => candidate.verification.identity === identity);
  if (!exact.length) throw new Error(`Idempotency key ${key} was already used against different source state; use a new idempotency key`);
  if (exact.length > 1) throw new Error(`Idempotency key ${key} has multiple evidence records; refusing an ambiguous reuse`);
  return exact[0];
}

function validatePrior(prior: PriorEvidence, expected: { root: string; taskId: string; tests: string[]; params: string; identity: string; policy: CoveragePolicy; source: string; ledger: Ledger }): void {
  const { evidence, verification, record } = prior;
  if (verification.params !== expected.params) throw new Error(`Idempotency key ${verification.idem_key} was already used with different verification parameters`);
  if (verification.identity !== expected.identity) throw new Error(`Idempotency key ${verification.idem_key} was already used against different source state; use a new idempotency key`);
  if (!samePath(verification.root, expected.root)) throw new Error('Prior evidence belongs to a different project root');
  if (verification.task_id !== expected.taskId || record.taskId !== expected.taskId) throw new Error('Prior evidence belongs to a different task');
  if (verification.evidence_id !== evidence.id || record.id !== evidence.id) throw new Error('Prior evidence id does not match the recorded verification');
  if (verification.graph_revision !== evidence.graphRevision) throw new Error('Prior verification graph revision does not match its evidence');
  if (!sameStrings(verification.test_files, expected.tests) || !sameStrings(record.testFiles, expected.tests)) throw new Error('Prior evidence does not match the declared test files');
  if (canonicalJson(verification.policy) !== canonicalJson(expected.policy)) throw new Error('Prior evidence was produced under a different coverage policy');
  if (evidence.sourceFingerprint !== expected.source) throw new Error('Prior evidence was produced against different source state');
  if (!evidence.ok || evidence.exitCode !== 0 || evidence.timedOut || evidence.error !== undefined) throw new Error('Prior evidence is not a passing execution');
  const tests = evidence.counts.tests ?? 0;
  const pass = evidence.counts.pass ?? 0;
  const fail = evidence.counts.fail ?? 0;
  const skipped = evidence.counts.skipped ?? 0;
  const todo = evidence.counts.todo ?? 0;
  const cancelled = evidence.counts.cancelled ?? 0;
  if (!(tests > 0 && pass === tests && fail === 0 && skipped === 0 && todo === 0 && cancelled === 0)) throw new Error('Prior evidence summary is not self-consistent');
  const stored = expected.ledger.getEvidence(evidence.id);
  if (!stored || stored.id !== evidence.id || stored.taskId !== expected.taskId) throw new Error('Prior evidence is not present in the current ledger replay');
}

export async function verifyTask(root: string, taskId: string, request: VerifyRequest, services: VerifyServices, policy: CoveragePolicy = { minimum: 'T1', unknown: 'strict' }): Promise<TaskVerdict> {
  const task = services.ledger.getTask(taskId);
  if (!task) throw new Error(`Unknown task: ${taskId}`);
  if (policy.minimum === 'T1' && request.testFiles === undefined) throw new Error('T1 requires the actual test file list from the runner');
  const tests = [...new Set(request.testFiles ?? [])].sort();
  if (!request.argv.length || !tests.length) throw new Error('Verification requires argv and actual test files');
  const adapter = selectEvidenceAdapter(request.argv);
  const runId = randomUUID();
  const prepared = adapter.prepare({ root, argv: request.argv, testFiles: tests, runId });
  const argv = prepared.argv;
  // ANO-appended result artifacts (pytest --junitxml=verify-<runId>.xml) must not
  // enter the persisted params: a retry carries a fresh runId but must resolve to
  // the same verification parameters and idempotency identity.
  const persistedArgv = prepared.persistedArgv ?? prepared.argv;

  // Fingerprint first, then build: the graph must be derived from exactly the
  // fingerprint bound into the evidence, otherwise the verdict would describe an
  // older graph than the source it claims to verify.
  const scan = await resolveProjectSourceScan(root);
  const before = await fingerprintProject(root, scan);
  if (before.degraded.length || before.status !== 'ok') throw new Error('Source fingerprint is degraded');
  const recordedArgv = redactArgv(persistedArgv);
  const argvDigest = createHash('sha256').update(canonicalJson(persistedArgv)).digest('hex');
  const params = verificationParameters(taskId, persistedArgv, tests, policy);
  // Bind the structural-evidence option into the idempotency identity so a retry
  // cannot silently reuse a legacy verdict recorded without structure coverage.
  const structureRequest = structureRequestOptions(request.structure);
  const identity = canonicalJson({ params, source: before.hash, ...(structureRequest !== undefined ? { structure: true } : {}) });
  const key = request.idemKey ?? `verify:${createHash('sha256').update(identity).digest('hex')}`;
  const prior = parsePrior(services.ledger.listEvidence(taskId), key, params, identity);
  if (prior) {
    if (task.status === 'cancelled') throw new Error(`Task ${taskId} is not active: ${task.status}`);
    validatePrior(prior, { root, taskId, tests, params, identity, policy, source: before.hash, ledger: services.ledger });
    if (structureRequest !== undefined && prior.verification.verdict.structure === undefined) {
      throw new Error('Prior evidence predates structure coverage evidence; use a new idempotency key');
    }
    // Rebuild the graph from the current source and recompute the verdict. The
    // stored verdict is only used as a tamper check, never as the result.
    await services.graph.build(scan !== undefined ? { scan } : {});
    if (services.graph.sourceFingerprint !== before.hash) throw new Error('Source changed between fingerprint and graph build; verification rejected');
    const snapshot = services.graph.snapshot();
    if (snapshot.revision !== prior.verification.graph_revision) throw new Error('Prior evidence graph revision does not match the current graph');
    const after = await fingerprintProject(root, scan);
    if (after.degraded.length || after.status !== 'ok') throw new Error('Source fingerprint is degraded');
    if (after.hash !== before.hash) throw new Error('Source changed while reusing evidence; verification rejected');
    const freshness = sourceFreshness(snapshot, after, services.graph.supportedExtensions);
    const recomputed = verdictForTask({
      task,
      touched: prior.verification.touched,
      executedTests: prior.verification.test_files,
      evidence: prior.evidence,
      graph: snapshot,
      freshness,
      policy,
      ...(structureRequest !== undefined ? { structure: structureRequest } : {}),
      ...(request.reviewItems !== undefined ? { untrustedReviewItems: request.reviewItems } : {}),
    });
    if (canonicalJson(recomputed) !== canonicalJson(prior.verification.verdict)) {
      throw new Error('Stored verification verdict does not match the recomputed verdict; refusing to trust it');
    }
    // A previous attempt may have recorded evidence and then failed to mark the
    // task done. Reuse is allowed to finish that one missing step idempotently.
    if (recomputed.status === 'done' && task.status !== 'done') {
      await services.ledger.updateTask(taskId, { status: 'done', verdict: recomputed }, `verify.done:${key}`);
    }
    return recomputed;
  }

  if (task.status === 'done' || task.status === 'cancelled') throw new Error(`Task ${taskId} is not active: ${task.status}`);
  await services.graph.build(scan !== undefined ? { scan } : {});
  if (services.graph.sourceFingerprint !== before.hash) throw new Error('Source changed between fingerprint and graph build; verification rejected');
  const builtFreshness = services.graph.freshness();
  if (builtFreshness.status !== 'fresh') throw new Error(`Graph is ${builtFreshness.status} before verification`);
  const snapshot = services.graph.snapshot();
  // Capture the touched set before running tests: a test writing an artifact into
  // the work tree must not be mistaken for a task change.
  const touched = [...new Set([...task.declaredFiles, ...services.ledger.getTouchedFiles()])].sort();

  await services.ledger.append({ kind: 'verify.started', payload: { task_id: taskId, argv: recordedArgv, argv_digest: argvDigest, idem_key: key, identity, source: before.hash } }, `verify.started:${key}`);
  let evidence: Evidence | undefined;
  let finished = false;
  try {
    const environment: EvidenceEnvironment | undefined = prepared.environment === undefined
      ? undefined
      : { node: process.version, platform: process.platform, arch: process.arch, ...prepared.environment } as EvidenceEnvironment;
    const command: EvidenceCommand = {
      argv,
      cwd: root,
      timeoutMs: request.timeoutMs ?? 120_000,
      ...(prepared.env !== undefined ? { env: { ...prepared.env } } : {}),
      ...(prepared.envExclude !== undefined ? { envExclude: prepared.envExclude } : {}),
    };
    const executed = await executeEvidence(command, before.hash, snapshot.revision, environment, { adapter, runId });
    const after = await fingerprintProject(root, scan);
    const drift = sourceDrift(before, after, services.graph.supportedExtensions);
    evidence = drift.length
      ? { ...executed, ok: false, error: `Source changed during test execution: ${drift.slice(0, 8).join(', ')}`.slice(0, 1000) }
      : executed;
    evidence = evidenceSchema.parse(evidence);
    const freshness = sourceFreshness(snapshot, after, services.graph.supportedExtensions);
    const verdict = verdictForTask({
      task,
      touched,
      executedTests: tests,
      evidence,
      graph: snapshot,
      freshness,
      policy,
      ...(structureRequest !== undefined ? { structure: structureRequest } : {}),
      ...(request.reviewItems !== undefined ? { untrustedReviewItems: request.reviewItems } : {}),
    });
    taskVerdictSchema.parse(verdict);
    const recorded: RecordedEvidence = {
      ...evidence,
      verification: {
        idem_key: key,
        params,
        identity,
        root: resolve(root),
        task_id: taskId,
        evidence_id: evidence.id,
        test_files: tests,
        policy,
        graph_revision: snapshot.revision,
        touched,
        verdict,
      },
    };
    await services.ledger.append({ kind: 'evidence.recorded', payload: { task_id: taskId, evidence: recorded, test_files: tests, idem_key: key, identity, verdict } }, `evidence:${key}`);
    await services.ledger.append({ kind: 'verify.finished', payload: { task_id: taskId, idem_key: key, evidence_id: evidence.id, ok: evidence.ok, verdict } }, `verify.finished:${key}`);
    finished = true;
    if (verdict.status === 'done') await services.ledger.updateTask(taskId, { status: 'done', verdict }, `verify.done:${key}`);
    return verdict;
  } catch (error) {
    // A hard crash may leave verify.started without verify.finished by design; the
    // started event is the explicit marker. Runtime failures record a terminal event.
    if (!finished) await services.ledger.append({ kind: 'verify.finished', payload: { task_id: taskId, idem_key: key, evidence_id: evidence?.id ?? null, ok: false, error: error instanceof Error ? error.message : String(error) } }, `verify.finished.error:${key}`);
    throw error;
  }
}
export function fingerprintExecutionGraph(value: unknown): string { return createHash('sha256').update(canonicalJson(value)).digest('hex'); }
