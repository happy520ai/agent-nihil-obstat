import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { nodeEvidenceAdapter } from './adapters/node.ts';
import type { EvidenceAdapter } from './adapters/types.ts';
import type { Evidence, EvidenceCommand, EvidenceEnvironment } from './types.ts';

export { parseTestCounts } from './adapters/node.ts';

const summaryLine = /^(?:#\s*|ℹ\s+)(?:tests|pass|fail|failed|skipped|todo|cancelled)\s+\d+\s*$/i;

const SECRET_WORDS = 'token|secret|password|passwd|pwd|api[_-]?key|apikey|access[_-]?key|secret[_-]?access[_-]?key|client[_-]?secret|authorization|auth|bearer|private[_-]?key|credential';
const SECRET_ASSIGNMENT = new RegExp(`([A-Za-z0-9_.-]*(?:${SECRET_WORDS})[A-Za-z0-9_.-]*\\s*[:=]\\s*)(?:"[^"]*"|'[^']*'|[^\\s,&;]+)`, 'gi');
const SECRET_FLAG = new RegExp(`^-{1,2}[A-Za-z0-9_.-]*(?:${SECRET_WORDS})[A-Za-z0-9_.-]*$`, 'i');
const URL_CREDENTIALS = /(\/\/)[^/\s:@]+:[^/\s@]+@/g;
const KNOWN_SECRET_SHAPES: RegExp[] = [
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\b[rs]k_live_[A-Za-z0-9]{16,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
];
const BEARER_TOKEN = /\b(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi;

export function redactSecrets(value: string): string {
  let text = value.replace(URL_CREDENTIALS, '$1[redacted]@');
  text = text.replace(BEARER_TOKEN, '$1[redacted]');
  for (const pattern of KNOWN_SECRET_SHAPES) text = text.replace(pattern, '[redacted]');
  return text.replace(SECRET_ASSIGNMENT, '$1[redacted]');
}

export function redactArgv(argv: string[]): string[] {
  const redacted: string[] = [];
  let redactNext = false;
  for (const token of argv) {
    if (redactNext) {
      redacted.push(token.length ? '[redacted]' : token);
      redactNext = false;
      continue;
    }
    redacted.push(redactSecrets(token));
    if (SECRET_FLAG.test(token) && !token.includes('=')) redactNext = true;
  }
  return redacted;
}

export function normalizeEvidencePath(value: string): string {
  return resolve(value).replaceAll('\\', '/');
}

export function outputDigest(stdout: string, stderr: string): string {
  return createHash('sha256').update(JSON.stringify({ stdout, stderr })).digest('hex');
}

export function failureExcerpt(output: string): string | undefined {
  const lines = redactSecrets(output).split(/\r?\n/).filter((line) => !summaryLine.test(line) && /fail|error|exception/i.test(line));
  if (lines.length === 0) return undefined;
  return lines.join('\n').slice(0, 4000).replace(/(?:[A-Za-z]:\\|\/)[^\s'"`]+/g, '[path]');
}

/**
 * Execution options for the evidence adapter seam (ADR-014 §4.1). Direct callers
 * keep the pre-migration behavior: without an adapter, the Node adapter parses.
 */
export interface EvidenceExecutionOptions {
  readonly adapter?: EvidenceAdapter;
  /** Must match the runId passed to `adapter.prepare` so adapter-owned artifacts resolve. */
  readonly runId?: string;
}

export async function executeEvidence(command: EvidenceCommand, sourceFingerprint: string, graphRevision: string, environment?: EvidenceEnvironment, options: EvidenceExecutionOptions = {}): Promise<Evidence> {
  const adapter = options.adapter ?? nodeEvidenceAdapter;
  const runId = options.runId ?? randomUUID();
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const result = await new Promise<{ stdout: string; stderr: string; exitCode: number | null; signal: string | null; timedOut: boolean; error?: string }>((resolve) => {
    let child;
    try {
      const env = { ...process.env };
      // Adapter-owned sanitization removes inherited variables before the
      // adapter overrides are applied, so its own overrides always win.
      for (const key of command.envExclude ?? []) delete env[key];
      Object.assign(env, command.env);
      delete env.NODE_TEST_CONTEXT;
      delete env.NODE_OPTIONS;
      child = spawn(command.argv[0]!, command.argv.slice(1), { cwd: command.cwd, shell: false, windowsHide: true, timeout: command.timeoutMs, killSignal: 'SIGKILL', env });
    } catch (error) {
      resolve({ stdout: '', stderr: '', exitCode: null, signal: null, timedOut: false, error: String(error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { if (stdout.length < 1_000_000) stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { if (stderr.length < 1_000_000) stderr += chunk; });
    child.once('error', (error) => resolve({ stdout, stderr, exitCode: null, signal: null, timedOut: false, error: String(error) }));
    child.once('close', (exitCode, signal) => {
      const windowsTimeout = process.platform === 'win32' && exitCode === 1 && performance.now() - start >= command.timeoutMs;
      resolve({ stdout, stderr, exitCode, signal, timedOut: signal === 'SIGKILL' || windowsTimeout });
    });
  });
  const parsed = await adapter.parse({
    root: command.cwd,
    runId,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    ...(result.error !== undefined ? { error: result.error } : {}),
  });
  const failure = parsed.failureExcerpt !== undefined
    ? redactSecrets(parsed.failureExcerpt).slice(0, 4000)
    : failureExcerpt(result.stdout + '\n' + result.stderr);
  const parseError = parsed.error ?? result.error;
  const baseEnvironment: EvidenceEnvironment = environment ?? { node: process.version, platform: process.platform, arch: process.arch };
  const recordedEnvironment = parsed.environment === undefined
    ? baseEnvironment
    : { ...baseEnvironment, ...parsed.environment } as EvidenceEnvironment;
  return {
    id: randomUUID(),
    argv: redactArgv(command.argv),
    cwd: normalizeEvidencePath(command.cwd),
    sourceFingerprint,
    graphRevision,
    environment: recordedEnvironment,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: performance.now() - start,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    counts: parsed.counts,
    ok: parsed.ok,
    outputDigest: outputDigest(result.stdout, result.stderr),
    ...(failure ? { failureExcerpt: failure } : {}),
    ...(parseError ? { error: redactSecrets(parseError).slice(0, 1000) } : {}),
  };
}
