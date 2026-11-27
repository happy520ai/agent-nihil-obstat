#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MUTATIONS,
  applyExactReplacement,
  classifyRun,
  hashSourceTree,
  validateMutationSpecs,
  type MutationSpec,
  type RunClassification,
  type SourceTreeHash,
  type TapSummary,
} from '../test/helpers/m18-mutation-harness.ts';

/**
 * T-154 / QF-05 isolated mutation runner.
 *
 * Contract:
 * - the working tree is never edited; every mutation lands in a throwaway copy
 *   under `os.tmpdir()` (src/test/package/tsconfig copied, node_modules joined
 *   read-only);
 * - each mutation uses an exact replacement verified to match exactly once in
 *   the pristine copy; zero/multiple matches are harness errors, not kills;
 * - baseline detector tests must pass before any mutation is applied;
 * - a kill requires a real failing TAP assertion; timeout/syntax/import
 *   failures are reported as harness errors;
 * - the temp copy is removed in `finally` and the source hash is compared
 *   before/after.
 *
 * Run manually (never from `npm test`): `node scripts/mutation-check.ts`.
 */

const SCRIPT_ROOT = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_ROOT, '..');

interface CliOptions {
  readonly out: string;
  readonly json: boolean;
  readonly list: boolean;
  readonly baselineTimeoutMs: number;
  readonly mutantTimeoutMs: number;
  readonly maxOutputChars: number;
}

interface DetectorSnapshot {
  readonly file: string;
  readonly sha256: string;
}

interface DetectorRun {
  readonly file: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly counts: TapSummary;
  readonly classification: RunClassification;
  readonly outputTail: string;
}

interface MutationRun {
  readonly id: string;
  readonly category: string;
  readonly file: string;
  readonly detector: string;
  readonly description: string;
  readonly anchorOccurrences: number;
  readonly result: RunKindLabel;
  readonly reason: string;
  readonly failingTests: readonly string[];
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly outputTail: string;
}

type RunKindLabel = 'killed' | 'survived' | 'harness_error' | 'not-run';

interface MutationReport {
  schema: 'ano.mutation-report.v1';
  root: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  copy: {
    tempDir: string;
    copyStartedAt: string;
    nodeModules: 'junction';
    detectorSnapshots: DetectorSnapshot[];
  };
  sourceHashBefore: SourceTreeHash;
  sourceHashAfter: SourceTreeHash;
  sourceUnchanged: boolean;
  baseline: {
    ok: boolean;
    runs: DetectorRun[];
  };
  mutations: MutationRun[];
  summary: {
    total: number;
    killed: number;
    survived: number;
    harnessErrors: number;
    notRun: number;
    detectionRate: number | null;
    baselineOk: boolean;
    sourceUnchanged: boolean;
  };
}

interface SubprocessOutcome {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly output: string;
  readonly truncated: boolean;
}

function parseArgs(argv: readonly string[]): CliOptions | { error: string } {
  let out = join(tmpdir(), `ano-mutation-report-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`);
  let json = false;
  let list = false;
  let baselineTimeoutMs = 240_000;
  let mutantTimeoutMs = 120_000;
  const maxOutputChars = 200_000;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--json') json = true;
    else if (arg === '--list') list = true;
    else if (arg === '--out' || arg.startsWith('--out=')) {
      const value = arg === '--out' ? argv[++index] : arg.slice('--out='.length);
      if (value === undefined || value.length === 0) return { error: '--out requires a path' };
      out = isAbsolute(value) ? value : resolve(PROJECT_ROOT, value);
    } else if (arg === '--baseline-timeout-ms' || arg.startsWith('--baseline-timeout-ms=')) {
      const value = arg === '--baseline-timeout-ms' ? argv[++index] : arg.slice('--baseline-timeout-ms='.length);
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) return { error: '--baseline-timeout-ms requires a positive integer' };
      baselineTimeoutMs = parsed;
    } else if (arg === '--mutant-timeout-ms' || arg.startsWith('--mutant-timeout-ms=')) {
      const value = arg === '--mutant-timeout-ms' ? argv[++index] : arg.slice('--mutant-timeout-ms='.length);
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) return { error: '--mutant-timeout-ms requires a positive integer' };
      mutantTimeoutMs = parsed;
    } else {
      return { error: `unknown argument: ${arg}` };
    }
  }
  return { out, json, list, baselineTimeoutMs, mutantTimeoutMs, maxOutputChars };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function runProcess(args: readonly string[], cwd: string, timeoutMs: number, maxOutputChars: number): Promise<SubprocessOutcome> {
  return new Promise<SubprocessOutcome>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [...args], { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | null = null;
    const append = (chunk: Buffer): void => {
      if (truncated) return;
      const addition = chunk.toString('utf8');
      const combined = `${stdout}\n${stderr}${addition}`;
      if (combined.length > maxOutputChars) {
        truncated = true;
        stdout = `${stdout}${addition}`.slice(0, Math.max(0, maxOutputChars - stderr.length));
        return;
      }
      stdout += addition;
    };
    child.stdout.on('data', append);
    child.stderr.on('data', (chunk: Buffer) => {
      if (truncated) return;
      const addition = chunk.toString('utf8');
      if (`${stdout}\n${stderr}${addition}`.length > maxOutputChars) {
        truncated = true;
        stderr = `${stderr}${addition}`.slice(0, Math.max(0, maxOutputChars - stdout.length));
        return;
      }
      stderr += addition;
    });
    child.once('error', (error) => {
      if (timer !== null) clearTimeout(timer);
      rejectPromise(error);
    });
    child.once('exit', (exitCode, signal) => {
      if (timer !== null) clearTimeout(timer);
      resolvePromise({
        exitCode,
        signal,
        timedOut,
        output: `${stdout}\n${stderr}`,
        truncated,
      });
    });
    timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
  });
}

function outputTail(output: string, limit = 600): string {
  return output.length <= limit ? output : `…${output.slice(-limit)}`;
}

function uniqueDetectors(specs: readonly MutationSpec[]): readonly string[] {
  return [...new Set(specs.map((spec) => spec.detector))];
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  if ('error' in options) {
    console.error(`mutation-check: ${options.error}`);
    return 2;
  }

  if (options.list) {
    for (const spec of MUTATIONS) {
      console.log(`${spec.id}\t${spec.category}\t${spec.file}\t${spec.detector}`);
    }
    return 0;
  }

  const outPath = options.out;
  const outAbsolute = resolve(outPath);
  const forbiddenPrefixes = [join(PROJECT_ROOT, 'docs'), join(PROJECT_ROOT, '.pm')];
  if (forbiddenPrefixes.some((prefix) => outAbsolute === prefix || outAbsolute.startsWith(`${prefix}${'/'}`))) {
    console.error(`mutation-check: refusing to write report under ${outAbsolute} (docs/.pm are off-limits)`);
    return 2;
  }

  const startedAt = new Date().toISOString();
  const startedMs = Date.now();

  const validation = validateMutationSpecs(PROJECT_ROOT);
  if (!validation.ok) {
    const report = {
      schema: 'ano.mutation-report.v1',
      root: PROJECT_ROOT,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
      validationProblems: validation.problems,
      baseline: { ok: false, runs: [] },
      mutations: [],
      summary: { total: MUTATIONS.length, killed: 0, survived: 0, harnessErrors: MUTATIONS.length, notRun: 0, detectionRate: null, baselineOk: false, sourceUnchanged: true },
    };
    writeFileSync(outAbsolute, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.error(`mutation-check: mutation catalogue invalid:\n${validation.problems.join('\n')}`);
    return 2;
  }

  const sourceHashBefore = hashSourceTree(PROJECT_ROOT);
  const tempDir = mkdtempSync(join(tmpdir(), 'ano-mutation-'));
  const copyStartedAt = new Date().toISOString();
  const nodeModulesLink = join(tempDir, 'node_modules');
  let sourceHashAfter: SourceTreeHash = sourceHashBefore;
  let sourceUnchanged = true;

  const detectorSnapshots: DetectorSnapshot[] = uniqueDetectors(MUTATIONS).map((file) => ({
    file,
    sha256: sha256(readFileSync(resolve(PROJECT_ROOT, file), 'utf8')),
  }));

  const report: MutationReport = {
    schema: 'ano.mutation-report.v1',
    root: PROJECT_ROOT,
    startedAt,
    finishedAt: '',
    durationMs: 0,
    copy: {
      tempDir,
      copyStartedAt,
      nodeModules: 'junction',
      detectorSnapshots,
    },
    sourceHashBefore,
    sourceHashAfter,
    sourceUnchanged,
    baseline: { ok: false, runs: [] },
    mutations: [],
    summary: {
      total: MUTATIONS.length,
      killed: 0,
      survived: 0,
      harnessErrors: 0,
      notRun: 0,
      detectionRate: null,
      baselineOk: false,
      sourceUnchanged: true,
    },
  };

  const baselineRuns: DetectorRun[] = [];
  const mutationRuns: MutationRun[] = [];
  let baselineOk = true;

  try {
    // Isolated copy: source, tests and module config only. node_modules is a
    // read-only junction, so the copy stays small and dependency resolution is
    // identical to the working tree.
    cpSync(resolve(PROJECT_ROOT, 'src'), join(tempDir, 'src'), { recursive: true });
    cpSync(resolve(PROJECT_ROOT, 'test'), join(tempDir, 'test'), { recursive: true });
    cpSync(resolve(PROJECT_ROOT, 'package.json'), join(tempDir, 'package.json'));
    cpSync(resolve(PROJECT_ROOT, 'tsconfig.json'), join(tempDir, 'tsconfig.json'));
    cpSync(resolve(PROJECT_ROOT, 'tsconfig.build.json'), join(tempDir, 'tsconfig.build.json'));
    symlinkSync(resolve(PROJECT_ROOT, 'node_modules'), nodeModulesLink, 'junction');

    const nodeArgs = (detector: string): string[] => ['--test', '--test-reporter=tap', detector];

    for (const detector of uniqueDetectors(MUTATIONS)) {
      const outcome = await runProcess(nodeArgs(detector), tempDir, options.baselineTimeoutMs, options.maxOutputChars);
      const classification = classifyRun(outcome);
      const passed = !outcome.timedOut && outcome.exitCode === 0;
      if (!passed) baselineOk = false;
      baselineRuns.push({
        file: detector,
        exitCode: outcome.exitCode,
        timedOut: outcome.timedOut,
        counts: classification.tap,
        classification,
        outputTail: outputTail(outcome.output),
      });
    }
    report.baseline = { ok: baselineOk, runs: baselineRuns };

    for (const spec of MUTATIONS) {
      // Restore the pristine file before applying the next mutation.
      cpSync(resolve(PROJECT_ROOT, spec.file), join(tempDir, spec.file));
      const targetPath = join(tempDir, spec.file);
      const pristine = readFileSync(targetPath, 'utf8');
      const replacement = applyExactReplacement(pristine, spec.from, spec.to);

      if (replacement.occurrences !== 1) {
        mutationRuns.push({
          id: spec.id,
          category: spec.category,
          file: spec.file,
          detector: spec.detector,
          description: spec.description,
          anchorOccurrences: replacement.occurrences,
          result: 'harness_error',
          reason: `anchor-match-count-${String(replacement.occurrences)}`,
          failingTests: [],
          exitCode: null,
          timedOut: false,
          outputTail: '',
        });
        continue;
      }

      writeFileSync(targetPath, replacement.output, 'utf8');
      const outcome = await runProcess(nodeArgs(spec.detector), tempDir, options.mutantTimeoutMs, options.maxOutputChars);
      const classification = classifyRun(outcome);
      mutationRuns.push({
        id: spec.id,
        category: spec.category,
        file: spec.file,
        detector: spec.detector,
        description: spec.description,
        anchorOccurrences: 1,
        result: classification.kind,
        reason: classification.reason,
        failingTests: classification.failingTests,
        exitCode: outcome.exitCode,
        timedOut: outcome.timedOut,
        outputTail: outputTail(outcome.output),
      });

      // Always restore before the next mutation, even if the run failed.
      cpSync(resolve(PROJECT_ROOT, spec.file), targetPath);
    }

    sourceHashAfter = hashSourceTree(PROJECT_ROOT);
    sourceUnchanged = sourceHashAfter.hash === sourceHashBefore.hash && sourceHashAfter.files === sourceHashBefore.files;
    report.sourceHashAfter = sourceHashAfter;
    report.sourceUnchanged = sourceUnchanged;
  } finally {
    try {
      unlinkSync(nodeModulesLink);
    } catch {
      // The junction may already be gone; the recursive removal below is authoritative.
    }
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch (error) {
      console.error(`mutation-check: failed to remove temp copy ${tempDir}: ${String(error)}`);
    }
  }

  const killed = mutationRuns.filter((run) => run.result === 'killed').length;
  const survived = mutationRuns.filter((run) => run.result === 'survived').length;
  const harnessErrors = mutationRuns.filter((run) => run.result === 'harness_error').length;
  const notRun = mutationRuns.filter((run) => run.result === 'not-run').length;
  const classified = killed + survived + harnessErrors;
  report.mutations = mutationRuns;
  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - startedMs;
  report.summary = {
    total: MUTATIONS.length,
    killed,
    survived,
    harnessErrors,
    notRun,
    detectionRate: classified === 0 ? null : killed / classified,
    baselineOk,
    sourceUnchanged,
  };

  mkdirSync(dirname(outAbsolute), { recursive: true });
  writeFileSync(outAbsolute, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log(`mutation-check: report ${outAbsolute}`);
  console.log(`source hash before ${sourceHashBefore.hash} (${String(sourceHashBefore.files)} files)`);
  console.log(`source hash after  ${sourceHashAfter.hash} (${String(sourceHashAfter.files)} files)`);
  console.log(`baseline detectors: ${baselineOk ? 'PASS' : 'FAIL'} (${String(baselineRuns.length)} files, copied at ${copyStartedAt})`);
  console.log('');
  console.log('id\tcategory\tdetector\tresult\treason');
  for (const run of mutationRuns) {
    console.log(`${run.id}\t${run.category}\t${run.detector}\t${run.result}\t${run.reason}`);
  }
  console.log('');
  console.log(`killed ${String(killed)} / survived ${String(survived)} / harness-error ${String(harnessErrors)} / total ${String(MUTATIONS.length)}`);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }

  if (!baselineOk || !sourceUnchanged) return 3;
  if (survived > 0 || harnessErrors > 0) return 1;
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error: unknown) => {
    console.error(`mutation-check: unexpected failure: ${String(error)}`);
    process.exitCode = 2;
  });
}

export { main };
