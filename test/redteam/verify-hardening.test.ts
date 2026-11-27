import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { executeEvidence, parseTestCounts } from '../../src/gate/evidence.ts';
import { commandSelectsTests, verifyTask } from '../../src/gate/verify.ts';
import { fingerprintTree } from '../../src/core/fingerprint.ts';
import { Ledger } from '../../src/ledger/ledger.ts';
import { eventChain, hashEvent } from '../../src/ledger/event.ts';
import { parseSegment } from '../../src/ledger/segment.ts';
import { GraphStore } from '../../src/structure/store.ts';
import { emptyCaveats } from '../../src/structure/types.ts';
import { trackTask, trackTaskUpdate } from '../../src/surface/service.ts';

const PASSING = "import test from 'node:test';import assert from 'node:assert/strict';test('a', () => assert.equal(1, 1));\n";
const FAILING = "import test from 'node:test';import assert from 'node:assert/strict';test('a', () => assert.equal(1, 2));\n";
const SKIPPED = "import test from 'node:test';test('a', { skip: 'not ready' }, () => {});\n";
const TODO = "import test from 'node:test';test.todo('later');\n";
const WRITES_ARTIFACT = "import test from 'node:test';import { writeFileSync } from 'node:fs';test('a', () => { writeFileSync('artifact.txt', 'x'); });\n";
const MUTATES_SOURCE = "import test from 'node:test';import { appendFileSync } from 'node:fs';test('a', () => { appendFileSync('src/a.ts', 'export const extra = 1;\\n'); });\n";

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

async function project(testSource: string = PASSING): Promise<string> {
  const root = await temp('ano verify hardening ');
  await write(root, '.gitignore', '.ano/\n');
  await write(root, 'package.json', JSON.stringify({ private: true, type: 'module' }));
  await write(root, 'src/a.ts', 'export const a = 1;\n');
  await write(root, 'test/a.test.ts', testSource);
  await write(root, 'test/b.test.ts', PASSING);
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'ano@localhost'], ['config', 'user.name', 'ano'], ['add', '.'], ['commit', '-qm', 'base']]) git(root, args);
  return root;
}

async function task(root: string, sessionId: string): Promise<{ ledger: Ledger; graph: GraphStore }> {
  const ledger = await Ledger.open(root, { sessionId });
  const graph = await GraphStore.open(root);
  await ledger.createTask('T', ['test/a.test.ts']);
  await ledger.updateTask('T', { status: 'in_progress' });
  return { ledger, graph };
}

const run = (file: string): string[] => [process.execPath, '--test', file];

test('verify refuses argv that does not really select the declared test files', async () => {
  const root = await project();
  const { ledger, graph } = await task(root, 'HARD-SELECT');
  try {
    const cases: Array<{ argv: string[]; tests: string[]; pattern: RegExp; label: string }> = [
      { label: 'inline eval with the test path appended', argv: [process.execPath, '-e', "console.log('# tests 1\\n# pass 1')", 'test/a.test.ts'], tests: ['test/a.test.ts'], pattern: /not selected/ },
      { label: 'attached inline eval', argv: [process.execPath, '-econsole.log(1)', 'test/a.test.ts'], tests: ['test/a.test.ts'], pattern: /not selected/ },
      { label: '--eval= form', argv: [process.execPath, '--eval=console.log(1)', 'test/a.test.ts'], tests: ['test/a.test.ts'], pattern: /not selected/ },
      { label: 'unrelated script that receives the test path', argv: [process.execPath, 'forged-runner.mjs', 'test/a.test.ts'], tests: ['test/a.test.ts'], pattern: /not selected/ },
      { label: 'shell wrapper', argv: ['sh', '-c', 'node --test test/a.test.ts'], tests: ['test/a.test.ts'], pattern: /not selected/ },
      { label: 'cmd wrapper', argv: ['cmd', '/c', 'node --test test/a.test.ts'], tests: ['test/a.test.ts'], pattern: /shell|not selected/ },
      { label: 'test-name-pattern consumes the path', argv: [process.execPath, '--test', '--test-name-pattern', 'test/a.test.ts'], tests: ['test/a.test.ts'], pattern: /not selected/ },
      { label: 'a different file is selected', argv: run('test/b.test.ts'), tests: ['test/a.test.ts'], pattern: /not selected/ },
      { label: 'no positional selection', argv: run(''), tests: ['test/a.test.ts'], pattern: /not selected|does not exist/ },
      { label: 'declared file is missing', argv: run('test/missing.test.ts'), tests: ['test/missing.test.ts'], pattern: /does not exist/ },
      { label: 'declared path escapes the project', argv: [process.execPath, '--test', '../outside.test.ts'], tests: ['../outside.test.ts'], pattern: /outside the project/ },
    ];
    for (const [index, item] of cases.entries()) {
      await assert.rejects(
        verifyTask(root, 'T', { argv: item.argv, testFiles: item.tests, idemKey: ["select", String(index)].join("-") }, { ledger, graph }),
        item.pattern,
        `expected rejection for ${item.label}`,
      );
    }
    assert.equal(ledger.listEvidence('T').length, 0, 'refused verification must not write evidence');
    assert.equal(ledger.getTask('T')?.status, 'in_progress');
    // Absolute paths inside the project and ./ prefixes are the same selection.
    commandSelectsTests(root, [process.execPath, '--test', join(root, 'test', 'a.test.ts').replaceAll('/', '\\')], ['./test/a.test.ts']);
    commandSelectsTests(root, run('./test/a.test.ts'), ['test/a.test.ts']);
  } finally { ledger.close(); graph.close(); }
});

test('verify binds evidence to the current source fingerprint and a real graph revision', async () => {
  const root = await project();
  const { ledger, graph } = await task(root, 'HARD-BIND');
  try {
    const before = await fingerprintTree(root);
    const verdict = await verifyTask(root, 'T', { argv: run('test/a.test.ts'), testFiles: ['test/a.test.ts'], idemKey: 'bind' }, { ledger, graph });
    assert.equal(verdict.status, 'done', JSON.stringify(verdict.reasons));
    assert.equal(verdict.level, 'T1');
    const [record] = ledger.listEvidence('T');
    assert.ok(record);
    assert.equal(record.evidence.ok, true, JSON.stringify(record.evidence));
    assert.deepEqual(record.evidence.argv, run('test/a.test.ts'));
    assert.equal(record.evidence.sourceFingerprint, before.hash);
    assert.equal(record.evidence.graphRevision, graph.revision);
    assert.equal(record.evidence.exitCode, 0);
    assert.deepEqual(record.evidence.counts, { tests: 1, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0 });
  } finally { ledger.close(); graph.close(); }
});

test('a graph that was not built from the current fingerprint cannot support a verdict', async () => {
  const root = await project();
  const { ledger } = await task(root, 'HARD-OLDGRAPH');
  try {
    const oldSource = 'a'.repeat(64);
    const stale = {
      build: async () => stale,
      sourceFingerprint: oldSource,
      revision: 'old-revision',
      freshness: () => ({ status: 'fresh' as const, stale: 0 as const }),
      snapshot: () => ({ revision: 'old-revision', sourceFingerprint: oldSource, files: {}, symbols: [], edges: [], caveats: emptyCaveats() }),
      checkFreshness: async () => ({ status: 'fresh' as const, stale: 0 as const }),
    };
    await assert.rejects(
      verifyTask(root, 'T', { argv: run('test/a.test.ts'), testFiles: ['test/a.test.ts'], idemKey: 'oldgraph' }, { ledger, graph: stale as never }),
      /changed between fingerprint and graph build/,
    );
    assert.equal(ledger.listEvidence('T').length, 0);
  } finally { ledger.close(); }
});

test('same idempotency key and same parameters reuse evidence without rerunning the command', async () => {
  const root = await project("import test from 'node:test';import { writeFileSync } from 'node:fs';test('a', () => { writeFileSync('ran.txt', 'x'); });\n");
  const { ledger, graph } = await task(root, 'HARD-IDEM');
  try {
    const first = await verifyTask(root, 'T', { argv: run('test/a.test.ts'), testFiles: ['test/a.test.ts'], idemKey: 'idem' }, { ledger, graph });
    assert.equal(first.status, 'done', JSON.stringify(first.reasons));
    assert.equal(existsSync(join(root, 'ran.txt')), true, 'the real subprocess must have executed once');
    await writeFile(join(root, 'ran.txt'), 'deleted');
    const { rm } = await import('node:fs/promises');
    await rm(join(root, 'ran.txt'));
    const second = await verifyTask(root, 'T', { argv: run('test/a.test.ts'), testFiles: ['test/a.test.ts'], idemKey: 'idem' }, { ledger, graph });
    assert.equal(second.evidenceId, first.evidenceId);
    assert.deepEqual(second, first);
    assert.equal(existsSync(join(root, 'ran.txt')), false, 'retry must not rerun the test command');
    assert.equal(ledger.listEvidence('T').length, 1, 'retry must not write a second evidence row');
  } finally { ledger.close(); graph.close(); }
});

test('a derived idempotency key is stable for an unchanged tree and changes with the source', async () => {
  const root = await project("import test from 'node:test';import { writeFileSync } from 'node:fs';test('a', () => { writeFileSync('ran.txt', 'x'); });\n");
  const { ledger, graph } = await task(root, 'HARD-DERIVED');
  try {
    const first = await verifyTask(root, 'T', { argv: run('test/a.test.ts'), testFiles: ['test/a.test.ts'] }, { ledger, graph });
    assert.equal(first.status, 'done', JSON.stringify(first.reasons));
    await rm(join(root, 'ran.txt'));
    const second = await verifyTask(root, 'T', { argv: run('test/a.test.ts'), testFiles: ['test/a.test.ts'] }, { ledger, graph });
    assert.equal(second.evidenceId, first.evidenceId);
    assert.equal(existsSync(join(root, 'ran.txt')), false, 'derived-key retry must reuse evidence');
    assert.equal(ledger.listEvidence('T').length, 1);
  } finally { ledger.close(); graph.close(); }
});

test('a blocked task can be repaired and re-verified under a derived key', async () => {
  const root = await project(FAILING);
  const { ledger, graph } = await task(root, 'HARD-REPAIR');
  try {
    const blocked = await verifyTask(root, 'T', { argv: run('test/a.test.ts'), testFiles: ['test/a.test.ts'] }, { ledger, graph });
    assert.equal(blocked.status, 'blocked');
    assert.equal(ledger.getTask('T')?.status, 'in_progress');
    await write(root, 'test/a.test.ts', PASSING);
    const repaired = await verifyTask(root, 'T', { argv: run('test/a.test.ts'), testFiles: ['test/a.test.ts'] }, { ledger, graph });
    assert.equal(repaired.status, 'done', JSON.stringify(repaired.reasons));
    assert.notEqual(repaired.evidenceId, blocked.evidenceId);
    assert.equal(ledger.listEvidence('T').length, 2);
  } finally { ledger.close(); graph.close(); }
});

test('the same idempotency key with different parameters or different source is refused', async () => {
  const root = await project();
  const { ledger, graph } = await task(root, 'HARD-CONFLICT');
  try {
    const first = await verifyTask(root, 'T', { argv: run('test/a.test.ts'), testFiles: ['test/a.test.ts'], idemKey: 'shared' }, { ledger, graph });
    assert.equal(first.status, 'done');
    await assert.rejects(
      verifyTask(root, 'T', { argv: run('test/b.test.ts'), testFiles: ['test/b.test.ts'], idemKey: 'shared' }, { ledger, graph }),
      /different verification parameters/,
    );
    assert.equal(ledger.listEvidence('T').length, 1);
    await write(root, 'src/a.ts', 'export const a = 2;\n');
    await assert.rejects(
      verifyTask(root, 'T', { argv: run('test/a.test.ts'), testFiles: ['test/a.test.ts'], idemKey: 'shared' }, { ledger, graph }),
      /different source state/,
    );
    assert.equal(ledger.listEvidence('T').length, 1, 'a refused retry must not record new evidence');
  } finally { ledger.close(); graph.close(); }
});

test('test-run artifacts do not make the graph stale, but a source rewrite during the run invalidates evidence', async () => {
  const artifactRoot = await project(WRITES_ARTIFACT);
  const services = await task(artifactRoot, 'HARD-ARTIFACT');
  try {
    const verdict = await verifyTask(artifactRoot, 'T', { argv: run('test/a.test.ts'), testFiles: ['test/a.test.ts'], idemKey: 'artifact' }, services);
    assert.equal(verdict.status, 'done', JSON.stringify(verdict.reasons));
    assert.equal(verdict.freshness.status, 'fresh');
    assert.equal(existsSync(join(artifactRoot, 'artifact.txt')), true);
  } finally { services.ledger.close(); services.graph.close(); }

  const mutationRoot = await project(MUTATES_SOURCE);
  const mutating = await task(mutationRoot, 'HARD-MUTATION');
  try {
    const verdict = await verifyTask(mutationRoot, 'T', { argv: run('test/a.test.ts'), testFiles: ['test/a.test.ts'], idemKey: 'mutation' }, mutating);
    assert.equal(verdict.status, 'blocked');
    assert.equal(verdict.freshness.status, 'stale');
    const [record] = mutating.ledger.listEvidence('T');
    assert.ok(record);
    assert.equal(record.evidence.ok, false);
    assert.match(String(record.evidence.error), /Source changed during test execution: src\/a\.ts/);
    assert.equal(mutating.ledger.getTask('T')?.status, 'in_progress', 'a mutating run must not complete the task');
  } finally { mutating.ledger.close(); mutating.graph.close(); }
});

test('skip, todo, failure and missing counts can never produce a passing verdict', async () => {
  for (const [name, source] of [['skip', SKIPPED], ['todo', TODO], ['failure', FAILING]] as const) {
    const root = await project(source);
    const { ledger, graph } = await task(root, `HARD-${name}`);
    try {
      const verdict = await verifyTask(root, 'T', { argv: run('test/a.test.ts'), testFiles: ['test/a.test.ts'], idemKey: name }, { ledger, graph });
      assert.equal(verdict.status, 'blocked', `${name} must not pass`);
      const [record] = ledger.listEvidence('T');
      assert.ok(record);
      assert.equal(record.evidence.ok, false, `${name}: ${JSON.stringify(record.evidence)}`);
      assert.equal(ledger.getTask('T')?.status, 'in_progress');
    } finally { ledger.close(); graph.close(); }
  }
});

test('evidence only passes on a self-consistent summary produced by a real subprocess', async () => {
  const cwd = await temp('ano evidence hardening ');
  const quiet = await executeEvidence({ argv: [process.execPath, '-e', 'process.exit(0)'], cwd, timeoutMs: 10_000 }, 'a'.repeat(64), 'graph-1');
  assert.equal(quiet.ok, false, 'no TAP counts is never success');
  assert.deepEqual(quiet.counts, {});
  const inconsistent = await executeEvidence({ argv: [process.execPath, '-e', "console.log('# tests 5\\n# pass 1')"], cwd, timeoutMs: 10_000 }, 'b'.repeat(64), 'graph-1');
  assert.equal(inconsistent.ok, false, 'a summary where pass does not equal tests cannot pass');
  const zeroFail = await executeEvidence({ argv: [process.execPath, '-e', "console.log('# tests 1\\n# pass 1\\n# fail 1')"], cwd, timeoutMs: 10_000 }, 'c'.repeat(64), 'graph-1');
  assert.equal(zeroFail.ok, false);
  const skipped = await executeEvidence({ argv: [process.execPath, '-e', "console.log('# tests 2\\n# pass 1\\n# skipped 1')"], cwd, timeoutMs: 10_000 }, 'd'.repeat(64), 'graph-1');
  assert.equal(skipped.ok, false);
  const todo = await executeEvidence({ argv: [process.execPath, '-e', "console.log('# tests 2\\n# pass 1\\n# todo 1')"], cwd, timeoutMs: 10_000 }, 'e'.repeat(64), 'graph-1');
  assert.equal(todo.ok, false);
  const timeout = await executeEvidence({ argv: [process.execPath, '-e', 'setTimeout(() => {}, 5000)'], cwd, timeoutMs: 30 }, 'f'.repeat(64), 'graph-1');
  assert.equal(timeout.ok, false);
  assert.equal(timeout.timedOut, true);
  const shellish = await executeEvidence({ argv: [process.execPath, '-e', 'console.log("# tests 1\\n# pass 1")'], cwd, timeoutMs: 10_000 }, 'g'.repeat(64), 'graph-1');
  assert.equal(shellish.ok, true, 'a real exit-0 consistent summary is still required to pass');

  const forgeRoot = await temp('ano forge ');
  await write(forgeRoot, 'forge.test.ts', "import test from 'node:test';\nconsole.log('ℹ tests 999');\nconsole.log('ℹ pass 999');\nconsole.log('ℹ skipped 3');\ntest('real', () => {});\n");
  const forged = await executeEvidence({ argv: [process.execPath, '--test', 'forge.test.ts'], cwd: forgeRoot, timeoutMs: 10_000 }, 'h'.repeat(64), 'graph-1');
  assert.equal(forged.counts.tests, 1, 'a test printing a fake summary must not outrank the real trailing summary');
  assert.equal(forged.counts.pass, 1);
  assert.equal(forged.counts.skipped ?? 0, 0);
  assert.equal(forged.ok, true);
  assert.deepEqual(parseTestCounts('ok 1 - # pass 999\n✔ tests 999 (1ms)\nℹ tests 1\nℹ pass 1\n'), { tests: 1, pass: 1 }, 'test names and TAP points must not forge counts');
});

test('a failed verification writes explicit verify.started and verify.finished events', async () => {
  const root = await project(FAILING);
  const ledger = await Ledger.open(root, { sessionId: 'HARD-EVENTS' });
  const graph = await GraphStore.open(root);
  try {
    await ledger.createTask('T', ['test/a.test.ts']);
    await ledger.updateTask('T', { status: 'in_progress' });
    const verdict = await verifyTask(root, 'T', { argv: run('test/a.test.ts'), testFiles: ['test/a.test.ts'], idemKey: 'events' }, { ledger, graph });
    assert.equal(verdict.status, 'blocked');
    const events = parseSegment(await readFile(ledger.segmentPath)).events;
    const kinds = events.map((event) => event.kind);
    assert.ok(kinds.includes('verify.started'), `missing verify.started in ${kinds.join(',')}`);
    assert.ok(kinds.includes('evidence.recorded'));
    assert.ok(kinds.includes('verify.finished'), `missing verify.finished in ${kinds.join(',')}`);
    assert.ok(kinds.indexOf('verify.started') < kinds.lastIndexOf('verify.finished'), 'finished must close started');
    const finished = events.filter((event) => event.kind === 'verify.finished').at(-1)!;
    assert.equal(finished.payload.ok, false);
    assert.equal(finished.payload.task_id, 'T');
    assert.ok(String(finished.payload.idem_key).startsWith('events'));
    assert.ok(String(finished.payload.evidence_id).length > 0);
  } finally { ledger.close(); graph.close(); }
});

/** High-risk hub with an unreviewable dynamic require, plus 20 static consumers. */
async function projectWithHub(): Promise<string> {
  const root = await temp('ano structure gate ');
  await write(root, '.gitignore', '.ano/\n');
  await write(root, 'package.json', JSON.stringify({ private: true, type: 'module' }));
  await write(root, 'src/hub.js', "export function load(name) { return require('./' + name); }\n");
  for (let index = 0; index < 20; index += 1) {
    await write(root, `src/consumer${String(index).padStart(2, '0')}.js`, `import { load } from './hub.js';\nexport const c${index} = load('x${index}');\n`);
  }
  await write(root, 'test/a.test.ts', PASSING);
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'ano@localhost'], ['config', 'user.name', 'ano'], ['add', '.'], ['commit', '-qm', 'base']]) git(root, args);
  return root;
}

async function taskWithId(root: string, sessionId: string, id: string): Promise<{ ledger: Ledger; graph: GraphStore }> {
  const ledger = await Ledger.open(root, { sessionId });
  const graph = await GraphStore.open(root);
  await ledger.createTask(id, ['test/a.test.ts']);
  await ledger.updateTask(id, { status: 'in_progress' });
  return { ledger, graph };
}

test('task planning can consume a structural risk plan without inventing evidence ids', async () => {
  const root = await projectWithHub();
  const planned = await trackTask(root, { id: 'PLAN-1', title: 'structure', files: ['test/a.test.ts'], with_structure_risk: true }, 'plan-key');
  assert.equal(planned.duplicate, false);
  const plan = planned.structureRisk as { rows?: unknown[]; recommendations?: unknown[]; reviewItems?: Array<Record<string, unknown>>; counts?: Record<string, number> };
  assert.ok(Array.isArray(plan.rows) && plan.rows.length > 0, 'the plan must grade the snapshot');
  assert.ok(Array.isArray(plan.recommendations), 'recommended tests must be exposed');
  assert.ok(Array.isArray(plan.reviewItems) && plan.reviewItems.length > 0, 'manual review items must be exposed');
  assert.ok((plan.counts?.high ?? 0) >= 1, 'the dynamic-require hub must be high risk');
  assert.ok(plan.reviewItems.some((item) => item.file === 'src/hub.js' && item.kind === 'dynamic-load'));
  assert.equal(JSON.stringify(plan).includes('evidence_id'), false);
  assert.equal(JSON.stringify(plan).includes('evidenceId'), false);

  const plain = await trackTask(root, { id: 'PLAN-2', title: 'plain', files: ['test/a.test.ts'] }, 'plain-key');
  assert.equal('structureRisk' in plain, false, 'legacy track results keep their exact shape');

  const updated = await trackTaskUpdate(root, { operation: 'update', id: 'PLAN-1', status: 'in_progress', with_structure_risk: true }, 'plan-update-key');
  assert.equal((updated.task as { status?: string }).status, 'in_progress');
  const updatePlan = updated.structureRisk as { reviewItems?: Array<Record<string, unknown>> };
  assert.ok(Array.isArray(updatePlan.reviewItems) && updatePlan.reviewItems.length > 0, 'task update can also consume the risk plan');
  assert.equal(JSON.stringify(updatePlan).includes('evidence_id'), false);
});

test('strict structure evidence blocks an unreviewed high-risk blind spot even when T0 would pass', async () => {
  const root = await projectWithHub();
  const { ledger, graph } = await taskWithId(root, 'STRUCT-STRICT', 'T');
  try {
    const control = await ledger.createTask('T-CTRL', ['test/a.test.ts']);
    assert.ok(control);
    await ledger.updateTask('T-CTRL', { status: 'in_progress' });
    const legacy = await verifyTask(root, 'T-CTRL', { argv: run('test/a.test.ts'), testFiles: ['test/a.test.ts'], idemKey: 'struct-control' }, { ledger, graph }, { minimum: 'T0', unknown: 'strict' });
    assert.equal(legacy.status, 'done', 'without structure evidence T0 still completes');
    assert.equal('structure' in legacy, false);

    const verdict = await verifyTask(root, 'T', { argv: run('test/a.test.ts'), testFiles: ['test/a.test.ts'], idemKey: 'struct-strict', structure: true }, { ledger, graph }, { minimum: 'T0', unknown: 'strict' });
    assert.equal(verdict.status, 'blocked', JSON.stringify(verdict.reasons));
    assert.ok(verdict.structure, 'structure coverage evidence must be recorded');
    const gap = verdict.structure.coverageGap;
    assert.ok(gap, 'coverage gap is required');
    assert.deepEqual(gap.executedTests, ['test/a.test.ts']);
    assert.ok(gap.highRiskFiles.includes('src/hub.js'));
    assert.ok(gap.uncoveredHighRisk.includes('src/hub.js'), 'the difference set must name the uncovered high-risk file');
    assert.equal(gap.coveredHighRisk.includes('src/hub.js'), false);
    assert.ok(verdict.reasons.some((reason) => reason.includes('src/hub.js') && /dynamic-load/.test(reason)), JSON.stringify(verdict.reasons));
    assert.equal(verdict.structure.policyEffect, 'blocked');
    assert.ok(verdict.structure.riskSummary, 'risk summary comes from blast.risk');
    assert.equal(verdict.structure.riskSummary.levels['src/hub.js'], 'high');
    assert.ok(verdict.structure.reviewItems?.some((item) => item.file === 'src/hub.js' && item.origin === 'manual-review' && item.kind === 'dynamic-load'));
    assert.equal(JSON.stringify(verdict.structure).includes('evidence_id'), false);
    assert.equal(JSON.stringify(verdict.structure).includes('evidenceId'), false);
  } finally { ledger.close(); graph.close(); }
});

test('advisory policy records the same blind spot as a warning instead of blocking', async () => {
  const root = await projectWithHub();
  const { ledger, graph } = await taskWithId(root, 'STRUCT-ADVISORY', 'T');
  try {
    const verdict = await verifyTask(root, 'T', { argv: run('test/a.test.ts'), testFiles: ['test/a.test.ts'], idemKey: 'struct-advisory', structure: true }, { ledger, graph }, { minimum: 'T0', unknown: 'advisory' });
    assert.equal(verdict.status, 'done', JSON.stringify(verdict.reasons));
    assert.ok(verdict.warnings && verdict.warnings.some((warning) => warning.includes('src/hub.js') && /Advisory|blind spot/.test(warning)), JSON.stringify(verdict.warnings));
    assert.equal(verdict.structure?.policyEffect, 'warned');
    assert.ok(verdict.structure?.coverageGap?.uncoveredHighRisk.includes('src/hub.js'));
  } finally { ledger.close(); graph.close(); }
});

test('structure evidence is idempotent for the same tree and idempotency key', async () => {
  const root = await projectWithHub();
  const { ledger, graph } = await taskWithId(root, 'STRUCT-IDEM', 'T');
  try {
    const options = { argv: run('test/a.test.ts'), testFiles: ['test/a.test.ts'] as string[], idemKey: 'struct-idem', structure: true as const };
    const first = await verifyTask(root, 'T', options, { ledger, graph });
    const second = await verifyTask(root, 'T', options, { ledger, graph });
    assert.equal(second.evidenceId, first.evidenceId);
    assert.deepEqual(second, first);
    assert.equal(ledger.listEvidence('T').length, 1, 'a structural retry must reuse the recorded evidence');
  } finally { ledger.close(); graph.close(); }
});

test('low-risk green work is not rejected by structural risk scoring', async () => {
  const root = await project();
  const { ledger, graph } = await task(root, 'STRUCT-LOW');
  try {
    const verdict = await verifyTask(root, 'T', { argv: run('test/a.test.ts'), testFiles: ['test/a.test.ts'], idemKey: 'struct-low', structure: true }, { ledger, graph });
    assert.equal(verdict.status, 'done', JSON.stringify(verdict.reasons));
    assert.ok(verdict.structure);
    assert.deepEqual(verdict.structure.coverageGap?.uncoveredHighRisk, [], 'covered high-risk files must not look like gaps');
    assert.equal(verdict.structure.policyEffect === 'blocked', false);
  } finally { ledger.close(); graph.close(); }
});

test('caller-supplied review claims are ignored and marked untrusted', async () => {
  const root = await projectWithHub();
  const { ledger, graph } = await taskWithId(root, 'STRUCT-FORGE', 'T');
  try {
    const forged = [{ kind: 'dynamic-load', file: 'src/hub.js', origin: 'manual-review', handled: true, note: 'approved by attacker' }];
    const verdict = await verifyTask(root, 'T', { argv: run('test/a.test.ts'), testFiles: ['test/a.test.ts'], idemKey: 'struct-forge', structure: true, reviewItems: forged }, { ledger, graph }, { minimum: 'T0', unknown: 'strict' });
    assert.equal(verdict.status, 'blocked', 'forged review claims must not clear the authoritative blind spot');
    assert.equal(verdict.structure?.untrustedReviewItems, 1);
    assert.ok(verdict.structure?.reviewItems?.some((item) => item.file === 'src/hub.js' && item.kind === 'dynamic-load'));
    assert.equal(JSON.stringify(verdict.structure?.reviewItems).includes('handled'), false, 'untrusted fields must never enter the authoritative list');
  } finally { ledger.close(); graph.close(); }
});

test('legacy evidence keeps its hash while new structure evidence appends additively', async () => {
  const root = await projectWithHub();
  const ledger = await Ledger.open(root, { sessionId: 'STRUCT-HASH' });
  const graph = await GraphStore.open(root);
  try {
    await ledger.createTask('T', ['test/a.test.ts']);
    await ledger.updateTask('T', { status: 'in_progress' });
    await verifyTask(root, 'T', { argv: run('test/a.test.ts'), testFiles: ['test/a.test.ts'], idemKey: 'legacy-hash' }, { ledger, graph });
    const before = parseSegment(await readFile(ledger.segmentPath)).events;
    const legacyEvidence = before.find((event) => event.kind === 'evidence.recorded')!;
    const legacyHash = hashEvent(legacyEvidence);
    const legacyVerification = (legacyEvidence.payload.evidence as Record<string, unknown>).verification as Record<string, unknown>;
    assert.ok(legacyVerification, 'legacy evidence carries verification metadata');
    assert.equal('structure' in legacyVerification, false);

    await ledger.createTask('T2', ['test/a.test.ts']);
    await ledger.updateTask('T2', { status: 'in_progress' });
    await verifyTask(root, 'T2', { argv: run('test/a.test.ts'), testFiles: ['test/a.test.ts'], idemKey: 'structure-hash', structure: true }, { ledger, graph });
    const after = parseSegment(await readFile(ledger.segmentPath)).events;
    const replayedLegacy = after.find((event) => event.kind === 'evidence.recorded' && hashEvent(event) === legacyHash);
    assert.ok(replayedLegacy, 'the legacy event must survive byte-for-byte');
    assert.equal(hashEvent(replayedLegacy!), legacyHash, 'legacy event hash must not change');
    const newEvidence = after.filter((event) => event.kind === 'evidence.recorded').at(-1)!;
    const newVerification = (newEvidence.payload.evidence as Record<string, unknown>).verification as Record<string, unknown>;
    assert.ok(newVerification.verdict && typeof newVerification.verdict === 'object' && 'structure' in newVerification.verdict, 'new evidence carries the structure segment');
    assert.equal(eventChain(after), true, 'append-only chain stays valid');
  } finally { ledger.close(); graph.close(); }
});
