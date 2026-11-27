import { globSync, readFileSync } from 'node:fs';
import { run } from 'node:test';
import report from './m18-coverage-reporter.mjs';

// Node counts only modules actually loaded during the run. This holds both for
// this programmatic API and for the CLI `--test-coverage-include` flag: an
// empty exclusion list removes the built-in default exclusions, but it does not
// enumerate unloaded files, so it cannot widen the denominator here. The
// reporter therefore diffs the on-disk source manifest (recursive `src` glob)
// against the loaded set (`sourceManifestCoverage`).
//
// Strictness is intentional: the default full-suite selection requires every
// source file to be loaded (zero absences). Explicit file arguments are a
// manual scoped run; those only get report-only `status: "incomplete"` marking
// so existing scoped consumers keep working.
const args = process.argv.slice(2);
const baseline = args.includes('--baseline');
const files = args.filter((arg) => arg !== '--baseline');
const fullRun = files.length === 0;
if (fullRun) process.env.M18_COVERAGE_STRICT_MANIFEST = '1';
const selected = fullRun ? [...globSync('test/**/*.test.ts')].sort() : files;
if (selected.length === 0) throw new Error('no test files selected');
const tests = run({
  files: selected,
  coverage: true,
  coverageIncludeGlobs: ['src/**/*.ts'],
  coverageExcludeGlobs: [],
  lineCoverage: baseline ? 90 : 97,
  branchCoverage: baseline ? 80 : 88,
  functionCoverage: baseline ? 0 : 97,
});
tests.on('test:fail', (failure) => {
  console.error('Native test failure:', failure);
  process.exitCode = 1;
});
tests.on('test:summary', (summary) => {
  if (!summary.success) process.exitCode = 1;
});
try {
  for await (const chunk of report(tests)) process.stdout.write(chunk);
} catch (error) {
  // Unstable source/test trees, malformed event streams and strict full-run
  // manifest absences must never pass silently.
  console.error(`m18 native coverage failed: ${String(error instanceof Error ? error.message : error)}`);
  process.exitCode = 1;
}

// pm-mcp's completion policy requires an observed test summary. Emit the same
// native counters the reporter just persisted, in TAP form, so the quality
// matrix sees a real tests/pass/fail/skipped summary instead of bare exit 0.
{
  const native = JSON.parse(readFileSync(process.env.M18_COVERAGE_OUTPUT ?? '.pm/m18-coverage-raw.json', 'utf8'));
  const summary = native.testSummaries?.find((entry) => entry.file === undefined);
  const counts = summary?.counts;
  if (counts === undefined) {
    console.error('m18 native coverage: no top-level test summary was captured');
    process.exitCode = 1;
  } else {
    const lines = [
      'TAP version 13',
      `# tests ${String(counts.tests)}`,
      `# pass ${String(counts.passed)}`,
      `# fail ${String(counts.failed)}`,
      `# skipped ${String(counts.skipped)}`,
      `# cancelled ${String(counts.cancelled)}`,
      `# todo ${String(counts.todo)}`,
    ];
    const totals = native.summary?.totals;
    if (totals !== undefined) {
      const pct = (covered, total) => (total === 0 ? '100.00' : (covered / total * 100).toFixed(2));
      lines.push('', `all files | ${pct(totals.coveredLineCount, totals.totalLineCount)} | ${pct(totals.coveredBranchCount, totals.totalBranchCount)} | ${pct(totals.coveredFunctionCount, totals.totalFunctionCount)}`);
    }
    process.stdout.write(`${lines.join('\n')}\n`);
    if (counts.failed !== 0) process.exitCode = 1;
  }
}
