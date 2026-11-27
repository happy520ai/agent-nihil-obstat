import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildFixture,
  runBenchmark,
  type BenchmarkScale,
} from '../../scripts/benchmark-anchor-probe.ts';

/**
 * AnchorProbe benchmark smoke gate (T-060 / AP-23).
 *
 * This file is deliberately named with a `.bench.ts` suffix, so the
 * repository's core suite glob for `.test.ts` files does not pick it up. Run it
 * explicitly with:
 *   node --test test/benchmark/anchor-probe.bench.ts
 *
 * It exercises the same public entry points as the CLI at the `smoke` scale and
 * asserts the acceptance invariants:
 *   - the fixture is reproducible from its seed;
 *   - the three ProbeStore backends are same-semantics over the same entries,
 *     snapshot, budget and request set (the equivalence assertion is part of the
 *     benchmark, not a separate test);
 *   - retrieval quality is measured against the fixture truth;
 *   - the classifier ablation invariants hold;
 *   - the real probe -> manifest -> verify -> consumer harness completes at the
 *     smoke scale with zero retries.
 *
 * Set `ANCHOR_PROBE_BENCH_SCALE=M` (or `L`) to run a larger tier locally. The
 * default stays smoke so CI cost is bounded.
 */

const SCALE: BenchmarkScale = (() => {
  const value = process.env.ANCHOR_PROBE_BENCH_SCALE;
  if (value === 'S' || value === 'M' || value === 'L' || value === 'smoke') return value;
  return 'smoke';
})();

const ITERATIONS = SCALE === 'smoke' ? 3 : 2;
const E2E_ITERATIONS = SCALE === 'smoke' ? 1 : 1;

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

test('the synthetic fixture is reproducible from its seed', () => {
  const left = buildFixture(SCALE, 20_261_122);
  const right = buildFixture(SCALE, 20_261_122);
  assert.equal(left.viewDigest, right.viewDigest);
  assert.equal(left.entries.length, right.entries.length);
  assert.equal(left.composition.totalEvents, right.composition.totalEvents);
  // A different seed must produce a different fixture.
  const other = buildFixture(SCALE, 20_261_123);
  assert.notEqual(left.viewDigest, other.viewDigest);
});

test('the benchmark runs at the smoke scale and satisfies the acceptance invariants', async (t) => {
  const workRoot = mkdtempSync(join(tmpdir(), 'ano-anchor-probe-bench-'));
  t.after(() => removeTempRoot(workRoot));

  const result = await runBenchmark({
    scale: SCALE,
    seed: 20_261_122,
    iterations: ITERATIONS,
    e2eIterations: E2E_ITERATIONS,
    workRoot,
  });

  // 1. Same-semantics control over the three ProbeStore backends.
  assert.equal(result.equivalence.snapshotFingerprintEqual, true);
  assert.equal(result.equivalence.candidatesEqual, true);
  assert.equal(result.equivalence.adjacencyEqual, true);
  assert.equal(result.equivalence.probeResponsesEqual, true);
  assert.deepEqual(result.equivalence.mismatches, []);
  assert.equal(result.equivalence.recordCounts.projected, result.equivalence.recordCounts.sqlite);
  assert.equal(result.equivalence.recordCounts.sqlite, result.equivalence.recordCounts.bitchain);

  // 2. Retrieval matrix covers the three stores plus the real Surface path.
  const backends = result.retrieval.map((row) => row.backend).sort();
  assert.deepEqual(backends, ['bitchain', 'projected', 'sqlite', 'surface']);

  // 3. Quality invariants per backend/request.
  for (const row of result.retrieval) {
    for (const quality of row.quality) {
      assert.equal(quality.entryRecall, 1, `${row.backend}/${quality.request_id} entry recall`);
      assert.equal(quality.conflictMiss, 0, `${row.backend}/${quality.request_id} conflict miss`);
      assert.equal(quality.staleUse, 0, `${row.backend}/${quality.request_id} stale use`);
      assert.equal(quality.constraintViolations, 0, `${row.backend}/${quality.request_id} constraint violations`);
      assert.equal(quality.wronglyDeprecated, 0, `${row.backend}/${quality.request_id} wrongly deprecated`);
    }
  }

  // 4. Classifier ablation invariants on the 22-case labeled fixture.
  const classifier = result.classifier;
  assert.equal(classifier.dataset.size, 22);
  assert.equal(classifier.ruleOnly.evaluated, 22);
  assert.equal(classifier.ruleOnly.definitive + classifier.ruleOnly.needs_review, 22);
  assert.equal(classifier.thresholdSweep.length, 4);
  assert.ok(classifier.modelLayer !== null);
  assert.equal(classifier.modelLayer.evaluated, 22);
  assert.equal(classifier.budgetTiers.length, 3);
  for (const tier of classifier.budgetTiers) {
    assert.equal(tier.layer.definitive + tier.layer.needs_review, tier.layer.evaluated);
  }

  // 5. End-to-end harness over the real probe/manifest/verify/consumer path.
  assert.ok(result.endToEnd !== null);
  const e2e = result.endToEnd!;
  assert.equal(e2e.outcome, 'NEEDS_REVIEW');
  assert.equal(e2e.retries, 0);
  assert.equal(e2e.iterations, E2E_ITERATIONS);
  assert.ok(e2e.endToEndMs.p50Ms > 0);
  // Generous CI-safe ceiling; the smoke tier is expected to be far below it.
  assert.ok(e2e.endToEndMs.p50Ms < 2_000, `smoke end-to-end p50 ${e2e.endToEndMs.p50Ms}ms exceeds 2000ms`);
  assert.ok(e2e.probeMs.p50Ms < 2_000, `smoke probe p50 ${e2e.probeMs.p50Ms}ms exceeds 2000ms`);

  // 6. Cost fields are present and honestly labelled.
  assert.equal(typeof result.cost.rebuildMs.bitchain, 'number');
  assert.equal(typeof result.cost.diskBytes.bitchain, 'number');
  assert.equal(result.cost.tokenEstimate.classifier > 0, true);
  assert.ok(result.limitations.some((item) => item.includes('[数据缺失]')));
});
