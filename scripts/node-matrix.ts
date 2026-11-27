#!/usr/bin/env node
/**
 * Node runtime matrix for the real tarball self-host check.
 *
 * Node 24 is the current runtime by default. Node 22.18 is the declared engine
 * floor; its actual binary must be supplied through ANO_NODE22. When that
 * binary is absent the matrix records `missing` and exits 2 — it never reports
 * the Node 22 leg as passed. No full test suite or quality matrix is run here.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runSelfHost, type SelfHostReport } from './selfhost.ts';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

export type NodeTargetId = 'node-22' | 'node-24';

export interface PlannedTarget {
  readonly id: NodeTargetId;
  readonly path: string | null;
  readonly reason: string | null;
}

export interface MatrixEntry {
  readonly id: NodeTargetId;
  readonly expected: string;
  readonly status: 'passed' | 'passed-with-limitations' | 'failed' | 'missing';
  readonly nodePath: string | null;
  readonly nodeVersion: string | null;
  readonly reason: string | null;
  readonly durationMs: number;
  readonly selfhost: SelfHostReport | null;
}

export interface NodeMatrixReport {
  schema: 'ano.node-matrix.v1';
  generatedAt: string;
  verdict: 'passed' | 'incomplete' | 'failed';
  currentRuntime: string;
  targets: MatrixEntry[];
  missing: string[];
  limitations: string[];
}

/** Pure target planner so tests can assert that an absent Node 22 is missing, not passed. */
export function planNodeTargets(env: Record<string, string | undefined>, execPath: string, currentNodeVersion: string): PlannedTarget[] {
  const major = Number(currentNodeVersion.replace(/^v/u, '').split('.')[0]);
  const node22 = env.ANO_NODE22?.trim();
  const node24 = env.ANO_NODE24?.trim();
  return [
    {
      id: 'node-22',
      path: node22 && node22.length > 0 ? node22 : major === 22 ? execPath : null,
      reason: node22 || major === 22
        ? null
        : 'ANO_NODE22 is not set and the current runtime is not Node 22; Node 22.18 binary was not supplied',
    },
    {
      id: 'node-24',
      path: node24 && node24.length > 0 ? node24 : major === 24 ? execPath : null,
      reason: node24 || major === 24
        ? null
        : 'ANO_NODE24 is not set and the current runtime is not Node 24; Node 24 binary was not supplied',
    },
  ];
}

function parseVersion(output: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/u.exec(output.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function satisfies(id: NodeTargetId, version: [number, number, number]): boolean {
  const [major, minor] = version;
  if (id === 'node-22') return major === 22 && minor >= 18;
  return major === 24;
}

function errorText(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

export async function runNodeMatrix(options: { readonly log?: (message: string) => void } = {}): Promise<NodeMatrixReport> {
  const log = options.log ?? (() => {});
  const targets = planNodeTargets(process.env, process.execPath, process.version);
  const entries: MatrixEntry[] = [];
  for (const target of targets) {
    log(`target ${target.id}`);
    if (!target.path) {
      entries.push({
        id: target.id,
        expected: target.id === 'node-22' ? '>=22.18 <23' : '>=24 <25',
        status: 'missing',
        nodePath: null,
        nodeVersion: null,
        reason: target.reason,
        durationMs: 0,
        selfhost: null,
      });
      continue;
    }
    const nodePath = target.path;
    if (!existsSync(nodePath)) {
      entries.push({
        id: target.id,
        expected: target.id === 'node-22' ? '>=22.18 <23' : '>=24 <25',
        status: 'missing',
        nodePath,
        nodeVersion: null,
        reason: `configured ${target.id} binary does not exist: ${nodePath}`,
        durationMs: 0,
        selfhost: null,
      });
      continue;
    }
    const started = performance.now();
    let nodeVersion: string | null = null;
    let versionError: string | null = null;
    try {
      const version = spawnSync(nodePath, ['--version'], { encoding: 'utf8', shell: false, windowsHide: true });
      if (version.status === 0) nodeVersion = version.stdout.trim();
      else versionError = version.stderr.trim() || `exit ${String(version.status)}`;
    } catch (error) {
      versionError = errorText(error);
    }
    const parsed = nodeVersion ? parseVersion(nodeVersion) : null;
    if (!parsed) {
      entries.push({
        id: target.id,
        expected: target.id === 'node-22' ? '>=22.18 <23' : '>=24 <25',
        status: 'missing',
        nodePath,
        nodeVersion,
        reason: `could not read ${target.id} version: ${versionError ?? 'no version output'}`,
        durationMs: performance.now() - started,
        selfhost: null,
      });
      continue;
    }
    if (!satisfies(target.id, parsed)) {
      entries.push({
        id: target.id,
        expected: target.id === 'node-22' ? '>=22.18 <23' : '>=24 <25',
        status: 'failed',
        nodePath,
        nodeVersion,
        reason: `${target.id} binary is ${nodeVersion}, outside the expected range`,
        durationMs: performance.now() - started,
        selfhost: null,
      });
      continue;
    }
    try {
      const selfhost = await runSelfHost({ nodePath, log });
      entries.push({
        id: target.id,
        expected: target.id === 'node-22' ? '>=22.18 <23' : '>=24 <25',
        status: selfhost.verdict,
        nodePath: target.path,
        nodeVersion,
        reason: selfhost.verdict === 'passed' ? null : `self-host verdict: ${selfhost.verdict}`,
        durationMs: performance.now() - started,
        selfhost,
      });
    } catch (error) {
      entries.push({
        id: target.id,
        expected: target.id === 'node-22' ? '>=22.18 <23' : '>=24 <25',
        status: 'failed',
        nodePath: target.path,
        nodeVersion,
        reason: errorText(error),
        durationMs: performance.now() - started,
        selfhost: null,
      });
    }
  }

  const missing = entries.filter((entry) => entry.status === 'missing').map((entry) => entry.id);
  const failed = entries.some((entry) => entry.status === 'failed');
  const limited = entries.some((entry) => entry.status === 'passed-with-limitations');
  const verdict: NodeMatrixReport['verdict'] = failed ? 'failed' : missing.length > 0 || limited ? 'incomplete' : 'passed';
  const limitations = [
    'matrix measures installed tarball behavior only; it is not a full test suite or quality matrix',
    'note/recall are exercised by the self-host run; recall reads only an explicitly imported synthetic fixture, never real sessions',
    'timings are wall-clock measurements from this machine and this run; they are not performance claims',
    'the self-host project is synthetic and isolated under os.tmpdir(); no real session data is read',
  ];
  if (missing.length > 0) limitations.push(`missing runtime legs: ${missing.join(', ')}`);
  return {
    schema: 'ano.node-matrix.v1',
    generatedAt: new Date().toISOString(),
    verdict,
    currentRuntime: process.version,
    targets: entries,
    missing,
    limitations,
  };
}

function value(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const report = await runNodeMatrix({ log: (message) => console.error(`[node-matrix] ${message}`) });
  const out = resolve(value(process.argv.slice(2), '--out') ?? resolve(repoRoot, 'docs', 'evidence', 'node-matrix.json'));
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.verdict === 'failed' ? 1 : report.verdict === 'incomplete' ? 2 : 0;
}

const invokedPath = process.argv[1];
if (invokedPath && pathToFileURL(resolve(invokedPath)).href === import.meta.url) await main();
