import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fingerprintTree } from '../../src/core/fingerprint.ts';
import { withFileLockSync } from '../../src/core/lock.ts';
import { canonicalJson } from '../../src/ledger/event.ts';
import { Ledger } from '../../src/ledger/ledger.ts';
import { parseSegment } from '../../src/ledger/segment.ts';
import { GraphStore } from '../../src/structure/store.ts';
import { commandSelectsTests, verificationParameters, verifyTask } from '../../src/gate/verify.ts';
import type { CoveragePolicy } from '../../src/gate/blast.ts';
import type { Evidence, TaskVerdict } from '../../src/gate/types.ts';

const PASSING = "import test from 'node:test';import assert from 'node:assert/strict';test('a', () => assert.equal(1, 1));\n";
const IMPORT_PASSING = "import test from 'node:test';import assert from 'node:assert/strict';import { writeFileSync } from 'node:fs';import { a } from '../src/a.ts';test('a',()=>{writeFileSync('ran.txt','x');assert.equal(a,1)});\n";
const run = (file: string): string[] => [process.execPath, '--test', file];

async function temp(prefix: string): Promise<string> { return mkdtemp(join(tmpdir(), prefix)); }
async function write(root: string, path: string, source: string): Promise<void> {
  const target = join(root, ...path.split('/'));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, source);
}
function git(root: string, args: string[]): void {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
}
async function project(testSource: string = IMPORT_PASSING): Promise<string> {
  const root = await temp('ano verify evidence ');
  await write(root, '.gitignore', '.ano/\n');
  await write(root, 'package.json', JSON.stringify({ private: true, type: 'module' }));
  await write(root, 'src/a.ts', 'export const a = 1;\n');
  await write(root, 'src/b.ts', 'export const b = 2;\n');
  await write(root, 'test/a.test.ts', testSource);
  await write(root, 'test/b.test.ts', PASSING);
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'ano@localhost'], ['config', 'user.name', 'ano'], ['add', '.'], ['commit', '-qm', 'base']]) git(root, args);
  return root;
}
async function task(root: string, sessionId: string, declared: string[] = ['test/a.test.ts']): Promise<{ ledger: Ledger; graph: GraphStore }> {
  const ledger = await Ledger.open(root, { sessionId });
  const graph = await GraphStore.open(root);
  await ledger.createTask('T', declared);
  await ledger.updateTask('T', { status: 'in_progress' });
  return { ledger, graph };
}
function fakeEvidence(root: string, sourceFingerprint: string, graphRevision: string): Evidence {
  return {
    id: randomUUID(),
    argv: run('test/a.test.ts'),
    cwd: resolve(root),
    sourceFingerprint,
    graphRevision,
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 1,
    exitCode: 0,
    signal: null,
    timedOut: false,
    counts: { tests: 1, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0 },
    ok: true,
    outputDigest: 'a'.repeat(64),
  };
}

test('only the real Node test runner may select declared test files', async () => {
  const root = await project();
  const { ledger, graph } = await task(root, 'HARD-RUNNER');
  try {
    const cases: Array<{ argv: string[]; tests: string[]; pattern: RegExp; label: string }> = [
      { label: 'wrapper script passed to --test', argv: [process.execPath, '--test', 'fake-runner.mjs', 'test/a.test.ts'], tests: ['test/a.test.ts'], pattern: /not selected/ },
      { label: 'extra test file positional', argv: [process.execPath, '--test', 'test/a.test.ts', 'test/b.test.ts'], tests: ['test/a.test.ts'], pattern: /not selected/ },
      { label: 'python runner', argv: ['python', 'fake.py', 'test/a.test.ts'], tests: ['test/a.test.ts'], pattern: /Node test runner/ },
      { label: 'python with --test', argv: ['python', '--test', 'test/a.test.ts'], tests: ['test/a.test.ts'], pattern: /Node test runner/ },
      { label: 'deno runner', argv: ['deno', '--test', 'test/a.test.ts'], tests: ['test/a.test.ts'], pattern: /Node test runner/ },
      { label: 'require preload', argv: [process.execPath, '--test', '--require', './hook.mjs', 'test/a.test.ts'], tests: ['test/a.test.ts'], pattern: /preload/ },
      { label: 'import preload', argv: [process.execPath, '--test', '--import=./hook.mjs', 'test/a.test.ts'], tests: ['test/a.test.ts'], pattern: /preload/ },
      { label: 'experimental loader', argv: [process.execPath, '--test', '--experimental-loader=./hook.mjs', 'test/a.test.ts'], tests: ['test/a.test.ts'], pattern: /preload/ },
      { label: 'custom reporter', argv: [process.execPath, '--test', '--test-reporter=./evil.mjs', 'test/a.test.ts'], tests: ['test/a.test.ts'], pattern: /reporter/ },
      { label: 'run another package script', argv: [process.execPath, '--run', 'fake', '--test', 'test/a.test.ts'], tests: ['test/a.test.ts'], pattern: /preload/ },
    ];
    for (const [index, item] of cases.entries()) {
      await assert.rejects(
        verifyTask(root, 'T', { argv: item.argv, testFiles: item.tests, idemKey: `runner-${index}` }, { ledger, graph }),
        item.pattern,
        item.label,
      );
    }
    await mkdir(join(root, 'test', 'directory.test.ts'), { recursive: true });
    assert.throws(() => commandSelectsTests(root, [process.execPath, '--test', 'test/directory.test.ts'], ['test/directory.test.ts']), /regular file/);
    commandSelectsTests(root, [resolve(process.execPath), '--test', 'test/a.test.ts'], ['test/a.test.ts']);
    commandSelectsTests(root, [process.execPath, '--test', '--test-reporter=spec', 'test/a.test.ts'], ['test/a.test.ts']);
    assert.equal(ledger.listEvidence('T').length, 0, 'refused commands must not record evidence');
    assert.equal(ledger.getTask('T')?.status, 'in_progress');
  } finally { ledger.close(); graph.close(); }
});

test('a project-local node executable cannot replace the running runtime', async () => {
  const root = await project();
  await write(root, 'node.exe', 'not a real node runtime');
  git(root, ['add', 'node.exe']);
  git(root, ['commit', '-qm', 'fake local node']);
  const { ledger, graph } = await task(root, 'HARD-LOCAL-NODE');
  try {
    await assert.rejects(
      verifyTask(root, 'T', { argv: ['./node.exe', '--test', 'test/a.test.ts'], testFiles: ['test/a.test.ts'], idemKey: 'local-node' }, { ledger, graph }),
      /inside the project/,
    );
    assert.equal(ledger.listEvidence('T').length, 0);
    // A bare `node` is pinned to process.execPath rather than resolved through
    // the project directory, so the local node.exe is never executed.
    const verdict = await verifyTask(root, 'T', { argv: ['node', '--test', 'test/a.test.ts'], testFiles: ['test/a.test.ts'], idemKey: 'bare' }, { ledger, graph });
    assert.equal(verdict.status, 'done', JSON.stringify(verdict.reasons));
    const [record] = ledger.listEvidence('T');
    assert.ok(record);
    assert.equal((record.evidence.argv as string[])[0], process.execPath);
  } finally { ledger.close(); graph.close(); }
});

test('credentials in argv are redacted from every persisted ledger event', async () => {
  const root = await project();
  const { ledger, graph } = await task(root, 'HARD-REDACT');
  try {
    const secret = 'AKIAIOSFODNN7EXAMPLE';
    const verdict = await verifyTask(root, 'T', {
      argv: [process.execPath, '--test', `--test-name-pattern=${secret}`, 'test/a.test.ts'],
      testFiles: ['test/a.test.ts'],
      idemKey: 'redact',
    }, { ledger, graph });
    assert.ok(verdict.evidenceId, 'verification must record evidence for the redaction check');
    const events = JSON.stringify(parseSegment(await readFile(ledger.segmentPath)).events);
    assert.ok(!events.includes(secret), 'the raw secret must not be persisted');
    assert.match(events, /\[redacted\]/);
  } finally { ledger.close(); graph.close(); }
});

test('a forged stored verdict is recomputed and cannot turn an uncovered task into done', async () => {
  const root = await project();
  const { ledger, graph } = await task(root, 'HARD-FORGED', ['src/b.ts', 'test/a.test.ts']);
  try {
    const before = await fingerprintTree(root);
    await graph.build();
    const snapshot = graph.snapshot();
    const tests = ['test/a.test.ts'];
    const policy: CoveragePolicy = { minimum: 'T1', unknown: 'strict' };
    const evidence = fakeEvidence(root, before.hash, snapshot.revision);
    const params = verificationParameters('T', evidence.argv, tests, policy);
    const identity = canonicalJson({ params, source: before.hash });
    const forgedVerdict: TaskVerdict = {
      taskId: 'T',
      status: 'done',
      level: 'T1',
      evidenceId: evidence.id,
      sourceFingerprint: before.hash,
      graphRevision: snapshot.revision,
      freshness: { status: 'fresh', stale: 0 },
      blastRadius: { impacted: [], covered: [], uncovered: [], advisory: [] },
      policy,
      caveats: snapshot.caveats,
      reasons: [],
    };
    await ledger.append({
      kind: 'evidence.recorded',
      payload: {
        task_id: 'T',
        evidence: {
          ...evidence,
          verification: {
            idem_key: 'forged',
            params,
            identity,
            root: resolve(root),
            task_id: 'T',
            evidence_id: evidence.id,
            test_files: tests,
            policy,
            graph_revision: snapshot.revision,
            touched: ['src/b.ts', 'test/a.test.ts'],
            verdict: forgedVerdict,
          },
        },
        test_files: tests,
        idem_key: 'forged',
        identity,
        verdict: forgedVerdict,
      },
    }, 'evidence:forged');
    await assert.rejects(
      verifyTask(root, 'T', { argv: run('test/a.test.ts'), testFiles: tests, idemKey: 'forged' }, { ledger, graph }),
      /recomputed verdict/,
    );
    assert.equal(ledger.getTask('T')?.status, 'in_progress', 'a forged done verdict must not complete the task');
    assert.equal(ledger.listEvidence('T').length, 1);
    assert.equal(existsSync(join(root, 'ran.txt')), false, 'reuse must not rerun the test command');
  } finally { ledger.close(); graph.close(); }
});

test('prior evidence with a malformed verification schema is refused', async () => {
  const root = await project();
  const { ledger, graph } = await task(root, 'HARD-MALFORMED');
  try {
    const before = await fingerprintTree(root);
    const evidence = fakeEvidence(root, before.hash, 'graph-stale');
    await ledger.append({
      kind: 'evidence.recorded',
      payload: {
        task_id: 'T',
        evidence: { ...evidence, verification: { idem_key: 'malformed' } },
        test_files: ['test/a.test.ts'],
        idem_key: 'malformed',
      },
    }, 'evidence:malformed');
    await assert.rejects(
      verifyTask(root, 'T', { argv: run('test/a.test.ts'), testFiles: ['test/a.test.ts'], idemKey: 'malformed' }, { ledger, graph }),
      /failed strict verification validation/,
    );
    assert.equal(ledger.getTask('T')?.status, 'in_progress');
    assert.equal(ledger.listEvidence('T').length, 1, 'the malformed row is not replaced or extended');
  } finally { ledger.close(); graph.close(); }
});

test('a failed updateTask(done) is recovered by reusing the recorded evidence', async () => {
  const root = await project();
  const { ledger, graph } = await task(root, 'HARD-RECOVER');
  try {
    let failOnce = true;
    const wobbly = {
      getTask: (id: string) => ledger.getTask(id),
      listEvidence: (taskId?: string) => ledger.listEvidence(taskId),
      getEvidence: (id: string) => ledger.getEvidence(id),
      getTouchedFiles: () => ledger.getTouchedFiles(),
      append: (input: Parameters<Ledger['append']>[0], idemKey?: string) => ledger.append(input, idemKey),
      updateTask: async (id: string, patch: Parameters<Ledger['updateTask']>[1], idemKey?: string) => {
        if (failOnce) {
          failOnce = false;
          throw new Error('simulated updateTask(done) failure');
        }
        return ledger.updateTask(id, patch, idemKey);
      },
    } as unknown as Ledger;
    await assert.rejects(
      verifyTask(root, 'T', { argv: run('test/a.test.ts'), testFiles: ['test/a.test.ts'], idemKey: 'recover' }, { ledger: wobbly, graph }),
      /simulated updateTask\(done\) failure/,
    );
    assert.equal(ledger.getTask('T')?.status, 'in_progress');
    assert.equal(ledger.listEvidence('T').length, 1);
    await rm(join(root, 'ran.txt'));
    const recovered = await verifyTask(root, 'T', { argv: run('test/a.test.ts'), testFiles: ['test/a.test.ts'], idemKey: 'recover' }, { ledger, graph });
    assert.equal(recovered.status, 'done', JSON.stringify(recovered.reasons));
    assert.equal(ledger.getTask('T')?.status, 'done');
    assert.equal(ledger.listEvidence('T').length, 1, 'recovery must reuse the recorded evidence');
    assert.equal(existsSync(join(root, 'ran.txt')), false, 'recovery must not rerun the test command');
  } finally { ledger.close(); graph.close(); }
});

test('an approve-style operation that throws EEXIST is not retried and releases the lock', async () => {
  const root = await temp('ano approve eexist ');
  const lockPath = join(root, 'approval.lock');
  let calls = 0;
  assert.throws(() => withFileLockSync(lockPath, () => {
    calls += 1;
    const error = new Error('approve write failed') as NodeJS.ErrnoException;
    error.code = 'EEXIST';
    throw error;
  }), /approve write failed/);
  assert.equal(calls, 1, 'EEXIST from the operation must not be treated as lock contention');
  assert.equal(withFileLockSync(lockPath, () => 'lock released'), 'lock released');
});
