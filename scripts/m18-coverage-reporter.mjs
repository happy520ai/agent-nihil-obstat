import { createHash } from 'node:crypto';
import { globSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

/**
 * Coverage denominator policy.
 *
 * Node counts only modules that were actually loaded during the test run, both
 * through the programmatic API and through the CLI `--test-coverage-include`
 * flag. An empty exclusion list removes the built-in default exclusions but
 * does NOT enumerate unloaded files. Therefore a run can report 100% while
 * include-matched source files never entered the run. The reporter closes that
 * evidence gap by diffing the on-disk source manifest (recursive `src` glob)
 * against the loaded files reported by Node.
 *
 * Two modes:
 * - report-only (default, manual/scoped consumers): absences are recorded with
 *   an explicit category/reason and `status: "incomplete"`; they never throw.
 * - strict (M18_COVERAGE_STRICT_MANIFEST=1, set by the full runner): any absent
 *   source file fails the run after the evidence JSON is written.
 */
const MANIFEST_GLOBS = ['src/**/*.ts'];
const STRICT_ENV = 'M18_COVERAGE_STRICT_MANIFEST';

/**
 * Observed categories for files that have historically been absent from the
 * native denominator. These describe what the files actually are (verified by
 * reading them); they are NOT a permanent exemption. Strict full runs still
 * require zero absences, and report-only consumers can classify differently.
 */
const KNOWN_ABSENCES = new Map([
  ['src/index.ts', {
    category: 'barrel',
    reason: 'package-root public re-export barrel; exercised indirectly through surface/connect call sites, no dedicated direct-import test in the baseline run',
  }],
  ['src/memory/index.ts', {
    category: 'barrel',
    reason: 'memory public re-export barrel over modules/types that are individually tested; no dedicated direct-import test in the baseline run',
  }],
  ['src/memory/types.ts', {
    category: 'type-only',
    reason: 'pure TypeScript interface/type declarations with no runtime exports; erased at compile time, no executable lines to cover',
  }],
  ['src/readiness/test-seams.ts', {
    category: 'test-seam',
    reason: 'deliberately TEST-ONLY interactive-stream seam, intentionally not exported from the public barrel; production approval paths never reach it',
  }],
]);

function toPosixRelative(path) {
  return relative(process.cwd(), resolve(process.cwd(), path)).replaceAll('\\', '/');
}

function snapshot(directory) {
  const files = [];
  function walk(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = resolve(path, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.ts')) {
        files.push({
          path: relative(process.cwd(), full).replaceAll('\\', '/'),
          sha256: createHash('sha256').update(readFileSync(full)).digest('hex'),
        });
      }
    }
  }
  walk(resolve(directory));
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return { sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'), files };
}

function enumerateSourceManifest() {
  const files = [];
  for (const pattern of MANIFEST_GLOBS) {
    for (const entry of globSync(pattern)) {
      if (statSync(entry).isFile()) files.push(toPosixRelative(entry));
    }
  }
  return [...new Set(files)].sort();
}

/**
 * Compare the real source manifest with the files Node actually loaded.
 * Missing files are returned with an explicit category/reason. Unclassified
 * absences make `status` incomplete; strict callers additionally fail on any
 * absence at all (classification is documentation, never an exemption).
 */
export function sourceManifestCoverage(summaryFiles, options = {}) {
  const strict = options.strict === true;
  const manifest = enumerateSourceManifest();
  const loaded = new Set();
  for (const file of summaryFiles ?? []) {
    const normalized = toPosixRelative(file.path);
    if (normalized.startsWith('src/')) loaded.add(normalized);
  }
  const missing = [];
  let classifiedMissing = 0;
  for (const path of manifest) {
    if (loaded.has(path)) continue;
    const known = KNOWN_ABSENCES.get(path);
    if (known !== undefined) classifiedMissing += 1;
    missing.push({
      path,
      ...(known ?? { category: 'unclassified', reason: 'not loaded by this run; classify explicitly or add coverage' }),
    });
  }
  return {
    normalized: true,
    mode: strict ? 'strict' : 'report-only',
    status: missing.length === 0 ? 'complete' : 'incomplete',
    manifestGlobs: [...MANIFEST_GLOBS],
    total: manifest.length,
    loaded: manifest.filter((path) => loaded.has(path)).length,
    reportedFiles: (summaryFiles ?? []).length,
    missing,
    classifiedMissing,
    unclassifiedMissing: missing.length - classifiedMissing,
    countsAsFullCoverage: missing.length === 0,
    complete: missing.length === 0,
  };
}

function writeOutput(output, payload) {
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(payload, null, 2)}\n`);
}

export default async function* m18CoverageReporter(source) {
  const output = resolve(process.env.M18_COVERAGE_OUTPUT ?? '.pm/m18-coverage-raw.json');
  const strictManifest = process.env[STRICT_ENV] === '1';
  const startedAt = new Date().toISOString();
  const before = { source: snapshot('src'), tests: snapshot('test') };
  const summaries = [];
  const testSummaries = [];
  for await (const event of source) {
    if (event?.type === 'test:coverage') summaries.push(event.data.summary);
    if (event?.type === 'test:summary') testSummaries.push(event.data);
  }
  const after = { source: snapshot('src'), tests: snapshot('test') };
  const provenance = {
    startedAt,
    finishedAt: new Date().toISOString(),
    argv: process.argv,
    sourceStable: before.source.sha256 === after.source.sha256,
    testsStable: before.tests.sha256 === after.tests.sha256,
    before,
    after,
  };

  const summary = summaries.length > 0 ? summaries[0] : null;
  const manifestCoverage = sourceManifestCoverage(summary?.files ?? [], { strict: strictManifest });
  const payload = {
    node: process.version,
    provenance,
    testSummaries,
    summary,
    sourceManifestCoverage: manifestCoverage,
  };

  let failure = null;
  if (summaries.length !== 1) {
    failure = `expected one native test:coverage summary, received ${summaries.length}`;
  } else if (!provenance.sourceStable) {
    failure = 'source changed while collecting native coverage';
  } else if (!provenance.testsStable) {
    failure = 'test tree changed while collecting native coverage';
  } else if (strictManifest && manifestCoverage.missing.length > 0) {
    failure = `${String(manifestCoverage.missing.length)} source file(s) absent from the strict full native coverage run`;
  }
  if (failure !== null) {
    payload.diagnostic = {
      message: failure,
      summariesReceived: summaries.length,
      testSummariesReceived: testSummaries.length,
    };
  }

  // Always persist evidence first; abnormal event streams still leave a
  // machine-readable artifact before the non-zero exit.
  writeOutput(output, payload);
  if (failure !== null) throw new Error(failure);
}
