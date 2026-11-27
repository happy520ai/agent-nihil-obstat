/**
 * Synthetic-stream regressions for `scripts/m18-coverage-reporter.mjs`.
 *
 * The reporter is exercised with fabricated `test:coverage`/`test:summary`
 * events instead of a real suite, so these tests stay milliseconds-fast and do
 * not contribute to the repository coverage denominator. Each scenario runs in
 * its own tmpdir and chdir()s there because the reporter resolves `src`/`test`
 * and normalizes paths against `process.cwd()`; cwd and the reporter
 * environment variables are always restored in finally.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const REPORTER_PATH = '../../scripts/m18-coverage-reporter.mjs';

async function loadReporter(): Promise<(source: AsyncIterable<unknown>) => AsyncGenerator<unknown>> {
  // Non-literal specifier keeps this synthetic test out of tsc's module graph.
  const specifier = REPORTER_PATH;
  const module = await import(specifier);
  return module.default as (source: AsyncIterable<unknown>) => AsyncGenerator<unknown>;
}

interface ScenarioEnv {
  dir: string;
  output: string;
  strict: boolean;
}

async function withTempCwd(
  options: { strict?: boolean },
  run: (env: ScenarioEnv) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'ano m18cov '));
  const previousCwd = process.cwd();
  const previousOutput = process.env.M18_COVERAGE_OUTPUT;
  const previousStrict = process.env.M18_COVERAGE_STRICT_MANIFEST;
  await mkdir(join(dir, 'src'), { recursive: true });
  await mkdir(join(dir, 'test'), { recursive: true });
  process.chdir(dir);
  process.env.M18_COVERAGE_OUTPUT = join(dir, 'nested', 'native.json');
  if (options.strict === true) process.env.M18_COVERAGE_STRICT_MANIFEST = '1';
  else delete process.env.M18_COVERAGE_STRICT_MANIFEST;
  try {
    await run({ dir, output: process.env.M18_COVERAGE_OUTPUT!, strict: options.strict === true });
  } finally {
    process.chdir(previousCwd);
    if (previousOutput === undefined) delete process.env.M18_COVERAGE_OUTPUT;
    else process.env.M18_COVERAGE_OUTPUT = previousOutput;
    if (previousStrict === undefined) delete process.env.M18_COVERAGE_STRICT_MANIFEST;
    else process.env.M18_COVERAGE_STRICT_MANIFEST = previousStrict;
    await rm(dir, { recursive: true, force: true });
  }
}

async function consume(generator: AsyncGenerator<unknown>): Promise<void> {
  for await (const _chunk of generator) { void _chunk; }
}

function coverageEvent(paths: readonly string[]): { type: string; data: { summary: { files: Array<{ path: string }> } } } {
  return { type: 'test:coverage', data: { summary: { files: paths.map((path) => ({ path })) } } };
}

function summaryEvent(): { type: string; data: Record<string, unknown> } {
  return { type: 'test:summary', data: { success: true, counts: {} } };
}

async function* stream(events: readonly unknown[], mutateOnFirst?: () => Promise<void> | void): AsyncIterable<unknown> {
  let first = true;
  for (const event of events) {
    if (first && mutateOnFirst !== undefined) {
      first = false;
      await mutateOnFirst();
    }
    yield event;
  }
}

async function readOutput(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, any>;
}

test('a matching manifest round-trips the existing summary format', async () => {
  await withTempCwd({}, async ({ dir, output }) => {
    await writeFile(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
    await writeFile(join(dir, 'test', 't.test.ts'), 'export const t = 1;\n');
    const report = await loadReporter();

    await consume(report(stream([coverageEvent([join(dir, 'src', 'a.ts')]), summaryEvent()])));

    const payload = await readOutput(output);
    assert.deepEqual(Object.keys(payload).sort(), ['node', 'provenance', 'sourceManifestCoverage', 'summary', 'testSummaries']);
    assert.equal(payload.node, process.version);
    assert.equal(payload.provenance.sourceStable, true);
    assert.equal(payload.provenance.testsStable, true);
    assert.equal(payload.diagnostic, undefined);
    assert.deepEqual(payload.summary.files, [{ path: join(dir, 'src', 'a.ts') }]);
    const manifest = payload.sourceManifestCoverage;
    assert.equal(manifest.normalized, true);
    assert.equal(manifest.mode, 'report-only');
    assert.equal(manifest.status, 'complete');
    assert.equal(manifest.manifestGlobs[0], 'src/**/*.ts');
    assert.equal(manifest.total, 1);
    assert.equal(manifest.loaded, 1);
    assert.deepEqual(manifest.missing, []);
    assert.equal(manifest.classifiedMissing, 0);
    assert.equal(manifest.unclassifiedMissing, 0);
    assert.equal(manifest.countsAsFullCoverage, true);
    assert.equal(manifest.complete, true);
    assert.deepEqual(payload.testSummaries, [{ success: true, counts: {} }]);
  });
});

test('scoped report-only consumers get an incomplete marker instead of a failure', async () => {
  await withTempCwd({}, async ({ dir, output, strict }) => {
    await writeFile(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
    await writeFile(join(dir, 'src', 'b.ts'), 'export const b = 2;\n');
    await writeFile(join(dir, 'test', 't.test.ts'), 'export const t = 1;\n');
    const report = await loadReporter();

    await consume(report(stream([coverageEvent([join(dir, 'src', 'a.ts')])])));

    assert.equal(strict, false);
    const payload = await readOutput(output);
    const manifest = payload.sourceManifestCoverage;
    assert.equal(manifest.mode, 'report-only');
    assert.equal(manifest.status, 'incomplete');
    assert.equal(manifest.total, 2);
    assert.equal(manifest.loaded, 1);
    assert.equal(manifest.unclassifiedMissing, 1);
    assert.equal(manifest.countsAsFullCoverage, false);
    assert.equal(manifest.complete, false);
    assert.deepEqual(manifest.missing.map((entry: any) => entry.path), ['src/b.ts']);
    assert.equal(manifest.missing[0]!.category, 'unclassified');
    assert.equal(payload.diagnostic, undefined, 'manual scoped runs must not fail on absences');
  });
});

test('strict full runs fail on any absence, classification is not an exemption', async () => {
  await withTempCwd({ strict: true }, async ({ dir, output }) => {
    await writeFile(join(dir, 'src', 'index.ts'), "export * from './missing.ts';\n");
    await writeFile(join(dir, 'test', 't.test.ts'), 'export const t = 1;\n');
    const report = await loadReporter();

    await assert.rejects(
      () => consume(report(stream([coverageEvent([])]))),
      /absent from the strict full native coverage run/u,
    );

    const payload = await readOutput(output);
    const manifest = payload.sourceManifestCoverage;
    assert.equal(manifest.mode, 'strict');
    assert.equal(manifest.status, 'incomplete');
    assert.equal(manifest.missing.length, 1);
    assert.equal(manifest.classifiedMissing, 1, 'the observed category is recorded');
    assert.equal(manifest.countsAsFullCoverage, false);
    assert.equal(manifest.complete, false);
    assert.equal(manifest.missing[0]!.path, 'src/index.ts');
    assert.equal(manifest.missing[0]!.category, 'barrel');
    assert.match(payload.diagnostic.message, /1 source file\(s\) absent/u);
    assert.equal(payload.diagnostic.summariesReceived, 1);
  });
});

test('abnormal coverage event counts persist a diagnostic JSON then fail', async () => {
  await withTempCwd({}, async ({ dir, output }) => {
    await writeFile(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
    await writeFile(join(dir, 'test', 't.test.ts'), 'export const t = 1;\n');
    const report = await loadReporter();
    const file = join(dir, 'src', 'a.ts');

    await assert.rejects(
      () => consume(report(stream([coverageEvent([file]), coverageEvent([file])]))),
      /received 2/u,
    );
    const two = await readOutput(output);
    assert.equal(two.diagnostic.summariesReceived, 2);
    assert.equal(two.summary.files.length, 1);
    assert.match(two.diagnostic.message, /received 2/u);

    await assert.rejects(
      () => consume(report(stream([]))),
      /received 0/u,
    );
    const zero = await readOutput(output);
    assert.equal(zero.diagnostic.summariesReceived, 0);
    assert.equal(zero.summary, null);
    assert.equal(zero.sourceManifestCoverage.total, 1);
    assert.equal(zero.sourceManifestCoverage.mode, 'report-only');
  });
});

test('source or test tree changes are persisted and fail explicitly', async () => {
  await withTempCwd({}, async ({ dir, output }) => {
    const source = join(dir, 'src', 'a.ts');
    const testFile = join(dir, 'test', 't.test.ts');
    await writeFile(source, 'export const a = 1;\n');
    await writeFile(testFile, 'export const t = 1;\n');
    const report = await loadReporter();

    await assert.rejects(
      () => consume(report(stream([coverageEvent([source])], async () => {
        await writeFile(source, 'export const a = 2;\n');
      }))),
      /source changed/u,
    );
    const sourceChanged = await readOutput(output);
    assert.equal(sourceChanged.provenance.sourceStable, false);
    assert.match(sourceChanged.diagnostic.message, /source changed/u);

    await assert.rejects(
      () => consume(report(stream([coverageEvent([source])], async () => {
        await writeFile(testFile, 'export const t = 2;\n');
      }))),
      /test tree changed/u,
    );
    const testsChanged = await readOutput(output);
    assert.equal(testsChanged.provenance.testsStable, false);
    assert.match(testsChanged.diagnostic.message, /test tree changed/u);
  });
});
