import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { projectStore } from './store.ts';
import { completionTaskHash, type OrchestrationPlan } from './dag.ts';

/**
 * Quality reports are produced by pm-mcp's sha256-tree-v1 project fingerprint
 * (SCAN_IGNORE_DIRS + .pm/project.json scan_ignore, PROJECT.md skipped).
 * Verification must hash the exact same scope with the primary implementation
 * or every comparison against report.source.after fails. The provider is loaded
 * lazily so importing this module (for example in tests) never requires the
 * local pm-mcp checkout.
 */
export interface ProjectFingerprint {
  algorithm: 'sha256-tree-v1';
  sha256: string;
  files: number;
  bytes: number;
}

export type FingerprintProvider = (root: string) => ProjectFingerprint;

interface QualityReport {
  ok: true;
  source: {
    stable: true;
    before: { algorithm: 'sha256-tree-v1'; sha256: string };
    after: { algorithm: 'sha256-tree-v1'; sha256: string };
  };
}

interface PmTask {
  id: string;
  status: string;
  result_note: string;
  verification: string;
}

interface CurrentEvidence {
  root: string;
  taskId: string;
  reportAbsolute: string;
  reportSha256: string;
  sourceSha256: string;
  taskSha256: string;
}

export interface GateReleaseRequest {
  root: string;
  gateId: string;
  reportPath: string;
  expectedReportHash?: string;
  planPath?: string;
  fingerprint?: FingerprintProvider;
}

export interface GateReleaseResult {
  gate: string;
  passed: true;
  verification: string;
  report_sha256: string;
  source_sha256: string;
  task_id: string;
  task_sha256: string;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const REFERENCE_BOUNDARIES = new Set([
  ' ', '\t', '\n', '\r',
  '(', ')', '[', ']', '{', '}',
  '（', '）', '【', '】',
  ':', '：', ',', '，', ';', '；', '、', '。',
  '"', "'", '`', '<', '>', '=',
]);

const loadedProviders = new Map<string, FingerprintProvider>();

function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX.test(value);
}

function isProjectFingerprint(value: unknown): value is ProjectFingerprint {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as { algorithm?: unknown; sha256?: unknown; files?: unknown; bytes?: unknown };
  return candidate.algorithm === 'sha256-tree-v1'
    && isSha256Hex(candidate.sha256)
    && typeof candidate.files === 'number' && Number.isSafeInteger(candidate.files) && candidate.files >= 0
    && typeof candidate.bytes === 'number' && Number.isSafeInteger(candidate.bytes) && candidate.bytes >= 0;
}

function providerModulePath(): string {
  const configured = process.env.PM_MCP_DIST;
  const dist = configured === undefined || configured.trim() === '' ? 'D:/DevTools/pm-mcp/dist' : configured;
  return resolve(dist, 'project-fingerprint.js');
}

/**
 * Load the primary pm-mcp fingerprint implementation only when a caller needs
 * it. A configured PM_MCP_DIST never falls back to the developer default: a
 * missing module fails closed so tests and CI cannot silently compare against
 * a different fingerprint algorithm.
 */
function defaultFingerprintProvider(): FingerprintProvider {
  const modulePath = providerModulePath();
  const cached = loadedProviders.get(modulePath);
  if (cached) return cached;
  let loaded: unknown;
  try {
    loaded = createRequire(import.meta.url)(modulePath);
  } catch (error) {
    throw new Error(
      `Project fingerprint provider unavailable at ${modulePath}; set PM_MCP_DIST to the pm-mcp dist directory containing project-fingerprint.js`,
      { cause: error },
    );
  }
  const candidate = (loaded as { fingerprintProject?: unknown } | null)?.fingerprintProject;
  if (typeof candidate !== 'function') {
    throw new Error(`Project fingerprint provider at ${modulePath} does not export fingerprintProject`);
  }
  const fingerprintProject = candidate as (root: string) => unknown;
  const provider: FingerprintProvider = root => {
    const result = fingerprintProject(root);
    if (!isProjectFingerprint(result)) throw new Error('Project fingerprint provider returned invalid sha256-tree-v1 evidence');
    return result;
  };
  loadedProviders.set(modulePath, provider);
  return provider;
}

function currentFingerprint(root: string, fingerprint?: FingerprintProvider): ProjectFingerprint {
  const result = (fingerprint ?? defaultFingerprintProvider())(root);
  if (!isProjectFingerprint(result)) throw new Error('Project fingerprint provider returned invalid sha256-tree-v1 evidence');
  return result;
}

/** Current source digest, using the same sha256-tree-v1 scope as quality reports. */
export function readCurrentFingerprint(root: string, fingerprint?: FingerprintProvider): string {
  return currentFingerprint(root, fingerprint).sha256;
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function reportHash(path: string): string {
  return sha256(readFileSync(path));
}

function assertQualityReport(value: unknown): asserts value is QualityReport {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Quality report must be a JSON object');
  const report = value as { ok?: unknown; source?: unknown };
  if (report.ok !== true) throw new Error('Quality report is not successful and source-stable');
  const source = report.source;
  if (source === null || typeof source !== 'object' || Array.isArray(source)) throw new Error('Quality report is not successful and source-stable');
  const candidate = source as { stable?: unknown; before?: unknown; after?: unknown };
  if (candidate.stable !== true) throw new Error('Quality report is not successful and source-stable');
  if (candidate.before === null || typeof candidate.before !== 'object' || candidate.after === null || typeof candidate.after !== 'object') {
    throw new Error('Quality report is not successful and source-stable');
  }
  const before = candidate.before as { algorithm?: unknown; sha256?: unknown };
  const after = candidate.after as { algorithm?: unknown; sha256?: unknown };
  if (before.algorithm !== 'sha256-tree-v1'
    || after.algorithm !== 'sha256-tree-v1'
    || !isSha256Hex(before.sha256)
    || !isSha256Hex(after.sha256)
    || before.sha256 !== after.sha256) {
    throw new Error('Quality report is not successful and source-stable');
  }
}

function readQualityReport(root: string, reportPath: string, expectedReportHash: string | undefined, mismatchMessage: string): {
  absolute: string;
  digest: string;
  report: QualityReport;
} {
  const absolute = resolve(root, reportPath);
  const bytes = readFileSync(absolute);
  const digest = sha256(bytes);
  if (expectedReportHash !== undefined && digest !== expectedReportHash) throw new Error(mismatchMessage);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`Quality report is not valid JSON: ${reportPath}`, { cause: error });
  }
  assertQualityReport(parsed);
  return { absolute, digest, report: parsed };
}

function readPmTask(root: string, taskId: string): PmTask {
  const tasksPath = resolve(root, '.pm', 'tasks.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(tasksPath, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read PM tasks at ${tasksPath}`, { cause: error });
  }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray((parsed as { tasks?: unknown }).tasks)) {
    throw new Error('PM tasks file is malformed');
  }
  const candidate = (parsed as { tasks: unknown[] }).tasks.find(item => (
    item !== null && typeof item === 'object' && (item as { id?: unknown }).id === taskId
  ));
  if (candidate === undefined || candidate === null || typeof candidate !== 'object') throw new Error(`PM task ${taskId} not found`);
  const task = candidate as { id?: unknown; status?: unknown; result_note?: unknown; verification?: unknown };
  if (typeof task.id !== 'string' || typeof task.status !== 'string' || typeof task.result_note !== 'string' || typeof task.verification !== 'string') {
    throw new Error(`PM task ${taskId} has malformed completion fields`);
  }
  return { id: task.id, status: task.status, result_note: task.result_note, verification: task.verification };
}

function assertPmCompletion(task: PmTask): void {
  if (task.status !== 'done' || task.result_note.trim() === '' || task.verification.trim() === '') {
    throw new Error('PM task lacks completion evidence');
  }
}

function referencesPath(verification: string, reportPath: string): boolean {
  const text = verification.replaceAll('\\', '/');
  const normalized = reportPath.replaceAll('\\', '/');
  const candidates = new Set([normalized]);
  if (normalized.startsWith('./')) candidates.add(normalized.slice(2));
  for (const candidate of candidates) {
    if (candidate === '') continue;
    let offset = 0;
    for (;;) {
      const index = text.indexOf(candidate, offset);
      if (index < 0) break;
      const before = index === 0 ? '' : text[index - 1]!;
      const after = text[index + candidate.length] ?? '';
      if ((index === 0 || REFERENCE_BOUNDARIES.has(before)) && (after === '' || REFERENCE_BOUNDARIES.has(after))) return true;
      offset = index + 1;
    }
  }
  return false;
}

function referencesDigest(verification: string, digest: string): boolean {
  if (!isSha256Hex(digest)) return false;
  return new RegExp(`(?<![0-9a-f])${digest}(?![0-9a-f])`).test(verification.toLowerCase());
}

function sameEvidencePath(root: string, left: string, right: string): boolean {
  const a = resolve(root, left);
  const b = resolve(root, right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function inspectCompletion(
  root: string,
  taskId: string,
  reportPath: string,
  expectedReportHash: string | undefined,
  fingerprint: FingerprintProvider | undefined,
  mismatchMessage: string,
): CurrentEvidence {
  const { absolute, digest, report } = readQualityReport(root, reportPath, expectedReportHash, mismatchMessage);
  const task = readPmTask(root, taskId);
  assertPmCompletion(task);
  if (!referencesPath(task.verification, reportPath) && !referencesDigest(task.verification, digest)) {
    throw new Error('PM verification does not reference this report path or hash');
  }
  const current = currentFingerprint(root, fingerprint);
  if (current.sha256 !== report.source.after.sha256) {
    throw new Error(`Historical report does not match current source: ${current.sha256} != ${report.source.after.sha256}`);
  }
  return {
    root,
    taskId,
    reportAbsolute: absolute,
    reportSha256: digest,
    sourceSha256: current.sha256,
    taskSha256: completionTaskHash({ result_note: task.result_note, verification: task.verification }),
  };
}

/**
 * Re-read the report digest and PM completion evidence, then fingerprint the
 * source again. This runs immediately before the orchestrator state write so a
 * time-of-check/time-of-use change cannot be recorded as accepted evidence.
 */
function assertEvidenceStillCurrent(evidence: CurrentEvidence, fingerprint?: FingerprintProvider): void {
  if (sha256(readFileSync(evidence.reportAbsolute)) !== evidence.reportSha256) {
    throw new Error('Quality report changed before state update');
  }
  const task = readPmTask(evidence.root, evidence.taskId);
  assertPmCompletion(task);
  if (completionTaskHash({ result_note: task.result_note, verification: task.verification }) !== evidence.taskSha256) {
    throw new Error('PM completion evidence changed before state update');
  }
  const current = currentFingerprint(evidence.root, fingerprint);
  if (current.sha256 !== evidence.sourceSha256) {
    throw new Error('Source changed before state update');
  }
  // The report and PM files live under .pm, which the sha256-tree-v1 scope
  // excludes, so re-check them after the expensive source walk as well.
  if (sha256(readFileSync(evidence.reportAbsolute)) !== evidence.reportSha256) {
    throw new Error('Quality report changed before state update');
  }
  const after = readPmTask(evidence.root, evidence.taskId);
  assertPmCompletion(after);
  if (completionTaskHash({ result_note: after.result_note, verification: after.verification }) !== evidence.taskSha256) {
    throw new Error('PM completion evidence changed before state update');
  }
}

function planGateTask(plan: OrchestrationPlan, gateId: string): string | undefined {
  return Object.entries(plan.tasks).find(([, entry]) => entry.gate === gateId && entry.mutex_group)?.[0];
}

function loadGatePlan(root: string, gateId: string, explicitPlanPath?: string): OrchestrationPlan {
  if (explicitPlanPath) {
    const plan = JSON.parse(readFileSync(resolve(root, explicitPlanPath), 'utf8')) as OrchestrationPlan;
    if (!planGateTask(plan, gateId)) throw new Error(`Unknown phase gate ${gateId}`);
    return plan;
  }
  // No explicit plan: locate the plan that defines this gate. Historical invocations
  // keep working while the lookup stays milestone-agnostic; ambiguity fails closed.
  const dir = resolve(root, 'scripts/orchestration');
  let candidates: string[] = [];
  try { candidates = readdirSync(dir).filter(name => name.endsWith('-plan.json')).sort(); } catch { candidates = []; }
  const matches = candidates.filter(name => {
    try { return planGateTask(JSON.parse(readFileSync(resolve(dir, name), 'utf8')) as OrchestrationPlan, gateId) !== undefined; } catch { return false; }
  });
  if (matches.length === 0) throw new Error(`Unknown phase gate ${gateId}`);
  if (matches.length > 1) throw new Error(`Phase gate ${gateId} is declared by multiple plans (${matches.join(', ')}); pass --plan <path>`);
  return JSON.parse(readFileSync(resolve(dir, matches[0]!), 'utf8')) as OrchestrationPlan;
}

export async function verifyCompletion(
  root: string,
  taskId: string,
  reportPath: string,
  expectedReportHash?: string,
  fingerprint?: FingerprintProvider,
) {
  const evidence = inspectCompletion(
    root,
    taskId,
    reportPath,
    expectedReportHash,
    fingerprint,
    'Quality report hash differs from expected evidence',
  );
  projectStore(root).update(state => {
    assertEvidenceStillCurrent(evidence, fingerprint);
    state.completed[taskId] = {
      acceptance_verified: true,
      verified_at: new Date().toISOString(),
      verification: reportPath,
      source_sha256: evidence.sourceSha256,
      report_sha256: evidence.reportSha256,
      task_sha256: evidence.taskSha256,
    };
    delete state.leases[taskId];
  });
  return {
    task_id: taskId,
    report_sha256: evidence.reportSha256,
    source_sha256: evidence.sourceSha256,
    task_sha256: evidence.taskSha256,
  };
}

/**
 * Open a phase gate only after re-verifying the current report, source tree and
 * PM completion identity. A historical runtime.completed record is required but
 * never trusted on its own: every digest and the PM task are re-read, and the
 * gate write is preceded by a second stability check.
 */
export function releaseGate(request: GateReleaseRequest): GateReleaseResult {
  const plan = loadGatePlan(request.root, request.gateId, request.planPath);
  const gateTask = planGateTask(plan, request.gateId);
  if (!gateTask) throw new Error(`Unknown phase gate ${request.gateId}`);
  const evidence = inspectCompletion(
    request.root,
    gateTask,
    request.reportPath,
    request.expectedReportHash,
    request.fingerprint,
    'Gate evidence hash mismatch',
  );
  const store = projectStore(request.root);
  return store.update(state => {
    const completion = state.completed[gateTask];
    if (!completion || completion.acceptance_verified !== true || typeof completion.verification !== 'string') {
      throw new Error(`Gate ${request.gateId} requires current verified integration task ${gateTask}`);
    }
    if (!sameEvidencePath(request.root, completion.verification, request.reportPath)) {
      throw new Error(`Gate ${request.gateId} requires current verified integration task ${gateTask}`);
    }
    if (completion.report_sha256 !== evidence.reportSha256) {
      throw new Error(`Gate ${request.gateId} report attestation is missing or stale`);
    }
    if (completion.source_sha256 !== evidence.sourceSha256) {
      throw new Error(`Gate ${request.gateId} source attestation is missing or stale`);
    }
    if (completion.task_sha256 !== evidence.taskSha256) {
      throw new Error(`Gate ${request.gateId} task attestation is missing or changed`);
    }
    assertEvidenceStillCurrent(evidence, request.fingerprint);
    state.gates[request.gateId] = {
      passed: true,
      verified_at: new Date().toISOString(),
      verification: request.reportPath,
      report_sha256: evidence.reportSha256,
      source_sha256: evidence.sourceSha256,
      task_id: gateTask,
    };
    return {
      gate: request.gateId,
      passed: true as const,
      verification: request.reportPath,
      report_sha256: evidence.reportSha256,
      source_sha256: evidence.sourceSha256,
      task_id: gateTask,
      task_sha256: evidence.taskSha256,
    };
  });
}

export function adoptTask(root: string, taskId: string, sessionId: string) {
  const task = readPmTask(root, taskId);
  if (task.status !== 'in_progress') throw new Error(`Adopt requires PM task ${taskId} to be in_progress`);
  const store = projectStore(root);
  // The claim is against the real PM status, not a synthesized snapshot. An
  // existing lease is only adopted when store.claim can prove it is fresh and
  // belongs to this session; an expired or foreign lease is refused instead of
  // being promoted by a second, unfenced heartbeat write.
  const result = store.claim({ id: taskId, status: 'in_progress' } as never, sessionId, Date.now(), true);
  if (!result.acquired) throw new Error(`Task ${taskId} already has a non-claimable lease; refusing to adopt it`);
  store.bind(taskId, result.lease.lease_id, sessionId);
  return result;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const root = process.cwd();
  if (command === 'adopt') {
    const [taskId, sessionId] = args;
    if (!taskId || !sessionId) throw new Error('adopt requires task_id and session_id');
    console.log(JSON.stringify(adoptTask(root, taskId, sessionId), null, 2));
  } else if (command === 'verify') {
    const [taskId, reportPath, expectedHash] = args;
    if (!taskId || !reportPath) throw new Error('verify requires task_id and report_path');
    console.log(JSON.stringify(await verifyCompletion(root, taskId, reportPath, expectedHash), null, 2));
  } else if (command === 'gate') {
    const rest = [...args];
    let planPath: string | undefined;
    for (let i = 0; i < rest.length; i += 1) {
      const arg = rest[i]!;
      if (arg === '--plan') {
        const value = rest[i + 1];
        if (value === undefined) throw new Error('Missing value for --plan');
        planPath = value;
        rest.splice(i, 2);
        break;
      }
      if (arg.startsWith('--plan=')) { planPath = arg.slice('--plan='.length); rest.splice(i, 1); break; }
    }
    const [gateId, reportPath, expectedHash] = rest;
    if (!gateId || !reportPath) throw new Error('gate requires gate_id and report_path [--plan <path>]');
    const result = releaseGate({
      root,
      gateId,
      reportPath,
      ...(expectedHash !== undefined ? { expectedReportHash: expectedHash } : {}),
      ...(planPath !== undefined ? { planPath } : {}),
    });
    console.log(JSON.stringify(result, null, 2));
  } else {
    throw new Error('Usage: state-command.ts adopt <task> <session> | verify <task> <report> [sha256] | gate <gate> <report> [sha256] [--plan <path>]');
  }
}

if (process.argv[1]?.endsWith('state-command.ts')) await main();
