import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('../../scripts/p1-experiment.ts', import.meta.url));
const evidence = join(await mkdtemp(join(tmpdir(), 'ano p1 evidence ')), 'p1-experiment.json');

test('P1 decision experiments pass against real ledger, graph and test subprocesses', { timeout: 120_000 }, async () => {
  await mkdir(dirname(evidence), { recursive: true });
  // The report now carries bounded semantic-gap evidence (ADR-010 §7.3); the default
  // 1 MiB maxBuffer truncates it, so allow a generous ceiling while keeping the timeout.
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ANO_P1_OUTPUT: evidence } });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const data = JSON.parse(await readFile(evidence, 'utf8'));
  // The synthetic verdict must never be inflated by an unavailable external project.
  assert.ok(['synthetic-pass-real-project-measured', 'synthetic-pass-real-project-unavailable'].includes(data.verdict), data.verdict);
  assert.deepEqual(data.failures, []);
  assert.equal(data.scenarios.coverageGap.status, 'blocked');
  assert.equal(data.scenarios.covered.status, 'done');
  assert.equal(data.scenarios.stale.freshness.status, 'stale');
  if (data.realProject?.selected === true) {
    assert.ok(data.realProject.sampleSize > 0);
    assert.equal(typeof data.realProject.median, 'number');
    assert.equal(typeof data.realProject.p90, 'number');
  } else {
    // Portability: a machine without the local reference project is not a failure,
    // but the evidence must say the real-project sample was not taken.
    assert.equal(data.verdict, 'synthetic-pass-real-project-unavailable');
  }
});
