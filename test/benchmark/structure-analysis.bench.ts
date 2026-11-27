import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildFixture,
  renderMarkdown,
  runBenchmark,
  type StructureBenchScale,
} from '../../scripts/bench-structure-analysis.ts';

/**
 * T-119 structure-analysis benchmark smoke gate.
 *
 * Named `.bench.ts` so the core `.test.ts` suite does not pick it up; run with:
 *   node --test test/benchmark/structure-analysis.bench.ts
 *
 * Set `STRUCTURE_BENCH_SCALE=M` (or `L`) for a larger tier locally. The default
 * stays smoke so CI cost is bounded. The test asserts mechanism invariants
 * (incremental reuse, cache equality, one DB open per batch) rather than any
 * speedup target.
 */

const SCALE: StructureBenchScale = (() => {
  const value = process.env.STRUCTURE_BENCH_SCALE;
  if (value === 'S' || value === 'M' || value === 'L' || value === 'smoke') return value;
  return 'smoke';
})();

const ITERATIONS = SCALE === 'smoke' ? 7 : 3;

function removeTempRoot(root: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch {
      if (attempt >= 9) return;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

test('the synthetic structure fixture is reproducible from its seed', () => {
  const left = buildFixture(SCALE, 20_261_124);
  const right = buildFixture(SCALE, 20_261_124);
  try {
    assert.deepEqual(left.files, right.files);
    for (const file of left.files) {
      assert.equal(
        readFileSync(join(left.root, ...file.split('/')), 'utf8'),
        readFileSync(join(right.root, ...file.split('/')), 'utf8'),
        `${file} must be byte-identical across two fixture builds`);
    }
    const other = buildFixture(SCALE, 20_261_125);
    try {
      // A different seed changes the dependency mix; it must not silently
      // produce a second identical fixture.
      const leftDigest = left.files.map((file) => readFileSync(join(left.root, ...file.split('/')), 'utf8')).join('\n');
      const otherDigest = other.files.map((file) => readFileSync(join(other.root, ...file.split('/')), 'utf8')).join('\n');
      assert.notEqual(leftDigest, otherDigest);
    } finally {
      removeTempRoot(other.root);
    }
  } finally {
    removeTempRoot(left.root);
    removeTempRoot(right.root);
  }
});

test('the smoke benchmark satisfies the cache/incrementality/no-N-opens invariants', async (t) => {
  const result = await runBenchmark({ scale: SCALE, seed: 20_261_124, iterations: ITERATIONS });
  t.after(() => removeTempRoot(result.fixture.root));

  assert.ok(result.fixture.inGraphFiles > 0, 'the fixture must enter the graph');
  assert.ok(result.fixture.symbols > 0);
  assert.ok(result.analysis.files > 0);
  assert.ok(result.analysis.risks > 0);

  // Incremental graph build: unchanged files are reused, a changed file is the
  // only one reparsed.
  const incremental = result.builds.find((build) => build.label === 'unchanged-incremental');
  const changed = result.builds.find((build) => build.label === 'one-file-changed');
  assert.ok(incremental !== undefined && changed !== undefined);
  assert.equal(incremental.parsed, 0, 'an unchanged rebuild reparses nothing');
  assert.ok(incremental.reused > 0, 'an unchanged rebuild serves files from the content-hash cache');
  assert.equal(changed.parsed, 1, 'only the modified file is reparsed');
  assert.ok(changed.reused > 0);

  // Cache consistency: hot path returns the exact same shape as an uncached run.
  assert.equal(result.analysis.cachedEqualsUncached, true);
  assert.ok(result.analysis.coldMs.count === ITERATIONS);
  assert.ok(result.analysis.hotMs.count === ITERATIONS);

  // Production path: one DB open and one snapshot per analyzer call, regardless
  // of how many file-level queries follow.
  assert.equal(result.session.opens, ITERATIONS);
  assert.equal(result.session.snapshots, ITERATIONS);
  assert.equal(result.session.cacheHits, ITERATIONS - 1, 'later identical sessions hit the batch cache');

  const markdown = renderMarkdown(result);
  assert.match(markdown, /批量分析/);
  assert.ok(result.limitations.some((item) => item.includes('not a production latency claim')));
});
