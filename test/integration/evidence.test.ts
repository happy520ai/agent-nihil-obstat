import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { executeEvidence, parseTestCounts } from '../../src/gate/evidence.ts';

test('evidence executes real argv without a shell and binds source/graph', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ano evidence '));
  await writeFile(join(cwd, 'result.txt'), 'source output');
  const evidence = await executeEvidence({ argv: [process.execPath, '-e', 'console.log("# tests 2\\n# pass 2")'], cwd, timeoutMs: 10_000 }, 'a'.repeat(64), 'graph-1');
  assert.equal(evidence.ok, true);
  assert.equal(evidence.exitCode, 0);
  assert.deepEqual(evidence.counts, { tests: 2, pass: 2 });
  assert.equal(evidence.sourceFingerprint, 'a'.repeat(64));
});

test('nonzero execution is valid evidence but cannot be a passing result', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ano evidence '));
  const evidence = await executeEvidence({ argv: [process.execPath, '-e', 'console.error("Error: failure");process.exit(4)'], cwd, timeoutMs: 10_000 }, 'b'.repeat(64), 'graph-1');
  assert.equal(evidence.exitCode, 4);
  assert.equal(evidence.ok, false);
  assert.match(evidence.failureExcerpt ?? '', /failure/);
});

test('test summary fields cannot be forged by test names or Unicode paths', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ano 判定 '));
  await writeFile(join(cwd, 'path.test.ts'), "import test from 'node:test';test('pass 999', () => {});\n");
  const evidence = await executeEvidence({ argv: [process.execPath, '--test', 'path.test.ts'], cwd, timeoutMs: 10_000 }, 'd'.repeat(64), 'graph-1');
  assert.equal(evidence.ok, true, JSON.stringify(evidence));
  assert.equal(evidence.counts.pass, 1);
  assert.deepEqual(parseTestCounts('✔ pass 999 (1ms)\nℹ tests 1\nℹ pass 1\n'), { tests: 1, pass: 1 });
});

test('an explicitly empty TAP test plan is not success', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ano no-tests '));
  await writeFile(join(cwd, 'one.test.ts'), "import test from 'node:test';test('one', () => {});\n");
  const evidence = await executeEvidence({ argv: [process.execPath, '--test', '--test-reporter=tap', '--test-name-pattern=__no_match__', 'one.test.ts'], cwd, timeoutMs: 10_000 }, 'e'.repeat(64), 'graph-1');
  assert.equal(evidence.ok, false);
});
test('timeout produces a failing result without shell interpolation', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ano evidence '));
  const evidence = await executeEvidence({ argv: [process.execPath, '-e', 'setTimeout(()=>{},10000)'], cwd, timeoutMs: 30 }, 'c'.repeat(64), 'graph-1');
  assert.equal(evidence.ok, false);
  assert.equal(evidence.timedOut, true);
});
