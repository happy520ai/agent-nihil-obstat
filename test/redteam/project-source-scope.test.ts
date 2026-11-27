import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createScanBudget } from '../../src/core/project-scan.ts';
import { fingerprintProject, fingerprintSourceRoots, resolveProjectSourceScan } from '../../src/core/source-scan.ts';
import { verifyTask } from '../../src/gate/verify.ts';
import { Ledger } from '../../src/ledger/ledger.ts';
import { GraphStore } from '../../src/structure/store.ts';

async function write(root: string, path: string, content: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

function git(root: string, ...args: string[]): void {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
}

async function project(t: TestContext, action = '', multiRoot = false, extraScan: Record<string, unknown> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ano-source-scope-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await write(root, 'package.json', JSON.stringify({ name: 'scope-fixture', type: 'module' }));
  await write(root, '.pm/project.json', JSON.stringify({ name: 'scope', scan_ignore: ['**/generated/**', '**/scratch/**'] }));
  await write(root, '.ano/project.json', JSON.stringify({ sourceRoots: multiRoot ? ['client', 'server'] : ['.'], ...extraScan }));
  const prefix = multiRoot ? 'server/' : '';
  if (multiRoot) await write(root, 'client/src/b.ts', 'export const b = 1;\n');
  await write(root, `${prefix}src/a.ts`, extraScan.include !== undefined
    ? "import { retained } from '../dist/keep/retained.ts';\nexport const a = retained;\n"
    : 'export const a = 1;\n');
  await write(root, `${prefix}test/a.test.ts`, `import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { a } from '../src/a.ts';
test('selected source is covered', () => {
  ${action}
  assert.equal(a, 1);
});
`);
  await write(root, `${prefix}generated/old.ts`, 'export const ignored = 1;\n');
  if (extraScan.include !== undefined) {
    await write(root, `${prefix}dist/keep/retained.ts`, 'export const retained = 1;\n');
    await write(root, `${prefix}dist/other/ignored.ts`, 'export const ignored = 1;\n');
  }
  git(root, 'init', '--quiet');
  git(root, 'add', '.');
  git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'fixture');
  return root;
}

async function services(root: string, multiRoot = false): Promise<{ ledger: Ledger; graph: GraphStore }> {
  const ledger = await Ledger.open(root, { sessionId: 'SOURCE-SCOPE' });
  const graph = await GraphStore.open(root);
  const prefix = multiRoot ? 'server/' : '';
  await ledger.createTask('T', [`${prefix}src/a.ts`, `${prefix}test/a.test.ts`]);
  await ledger.updateTask('T', { status: 'in_progress' });
  return { ledger, graph };
}

const request = (multiRoot = false) => {
  const path = `${multiRoot ? 'server/' : ''}test/a.test.ts`;
  return { argv: [process.execPath, '--test', path], testFiles: [path] };
};

test('Gate and Ledger ignore configured generated source and retain identical fingerprints', async (t) => {
  const root = await project(t, "writeFileSync('generated/old.ts', 'export const ignored = 2;\\n'); mkdirSync('scratch', { recursive: true }); writeFileSync('scratch/output.ts', 'export const output = 1;\\n');");
  const config = await readFile(join(root, '.pm/project.json'), 'utf8');
  const { ledger, graph } = await services(root);
  try {
    const verdict = await verifyTask(root, 'T', request(), { ledger, graph });
    assert.equal(verdict.status, 'done', JSON.stringify(verdict.reasons));
    assert.equal(ledger.getTask('T')?.status, 'done');
    assert.equal(graph.sourceFingerprint, verdict.sourceFingerprint);
    assert.equal(Object.hasOwn(graph.snapshot().files, 'generated/old.ts'), false);
    assert.equal(await readFile(join(root, '.pm/project.json'), 'utf8'), config, 'scan configuration remains read-only');
    const reused = await verifyTask(root, 'T', request(), { ledger, graph });
    assert.equal(reused.evidenceId, verdict.evidenceId, 'ignored output must not change evidence identity');
  } finally { ledger.close(); graph.close(); }
});

test('multi-root Gate, Graph and completion use the same project-relative file set', async (t) => {
  const root = await project(t, "writeFileSync('server/generated/old.ts', 'export const ignored = 2;\\n');", true);
  const { ledger, graph } = await services(root, true);
  try {
    const verdict = await verifyTask(root, 'T', request(true), { ledger, graph });
    assert.equal(verdict.status, 'done', JSON.stringify(verdict.reasons));
    assert.equal(ledger.getTask('T')?.status, 'done');
    assert.equal(graph.sourceFingerprint, verdict.sourceFingerprint);
    assert.ok(graph.snapshot().files['client/src/b.ts']);
    assert.ok(graph.snapshot().files['server/src/a.ts']);
    await write(root, 'client/src/b.ts', 'export const b = 2;\n');
    await assert.rejects(ledger.updateTask('T', { status: 'done', verdict }), /source changed/);
  } finally { ledger.close(); graph.close(); }
});

test('include overrides default build exclusions in Graph, Gate and Ledger', async (t) => {
  const root = await project(t, '', false, { include: ['dist/keep/**'] });
  const { ledger, graph } = await services(root);
  try {
    const verdict = await verifyTask(root, 'T', request(), { ledger, graph });
    assert.equal(verdict.status, 'done', JSON.stringify(verdict.reasons));
    assert.ok(graph.snapshot().files['dist/keep/retained.ts']);
    assert.equal(Object.hasOwn(graph.snapshot().files, 'dist/other/ignored.ts'), false);
    const scan = await resolveProjectSourceScan(root);
    assert.ok(scan);
    const reopened = await GraphStore.open(root, { scan });
    try { assert.equal((await reopened.checkFreshness()).status, 'fresh'); }
    finally { reopened.close(); }
    await write(root, 'dist/keep/retained.ts', 'export const retained = 2;\n');
    await assert.rejects(ledger.updateTask('T', { status: 'done', verdict }), /source changed/);
  } finally { ledger.close(); graph.close(); }
});

test('a configured scan still rejects real source mutations during execution', async (t) => {
  const root = await project(t, "writeFileSync('src/a.ts', 'export const a = 2;\\n');");
  const { ledger, graph } = await services(root);
  try {
    const verdict = await verifyTask(root, 'T', request(), { ledger, graph });
    assert.equal(verdict.status, 'blocked');
    assert.equal(verdict.freshness.status, 'stale');
    assert.equal(ledger.getTask('T')?.status, 'in_progress');
    assert.match(String(ledger.listEvidence('T')[0]?.evidence.error), /Source changed during test execution: src\/a\.ts/);
  } finally { ledger.close(); graph.close(); }
});

test('Ledger artifact filtering preserves configured roots and include rules', async (t) => {
  const root = await project(t, "writeFileSync('server/artifact.txt', 'output');", true, { include: ['server/dist/keep/**'] });
  const { ledger, graph } = await services(root, true);
  try {
    const verdict = await verifyTask(root, 'T', request(true), { ledger, graph });
    assert.equal(verdict.status, 'done', JSON.stringify(verdict.reasons));
    assert.equal(ledger.getTask('T')?.status, 'done');
    assert.ok(graph.snapshot().files['server/dist/keep/retained.ts']);
  } finally { ledger.close(); graph.close(); }
});

test('partial budgets cannot be combined into an ok fingerprint', async (t) => {
  const root = await project(t);
  const scan = await resolveProjectSourceScan(root);
  assert.ok(scan);
  const partial = await fingerprintSourceRoots(scan.gitRoot, scan.sourceRoots, {
    scan, budgets: createScanBudget({ maxFiles: 1 }),
  });
  assert.equal(partial.status, 'timeout');
  assert.equal(partial.partial, true);
  assert.equal(partial.degraded.length, 0, 'timeout must be checked even without degraded entries');
});

test('Gate refuses an exhausted source scan before running the test command', async (t) => {
  const root = await project(t, '', false, { maxFiles: 1 });
  const { ledger, graph } = await services(root);
  try {
    await assert.rejects(verifyTask(root, 'T', request(), { ledger, graph }), /fingerprint is degraded/);
    assert.equal(ledger.listEvidence('T').length, 0);
    assert.equal(ledger.getTask('T')?.status, 'in_progress');
  } finally { ledger.close(); graph.close(); }
});

test('native projects without PM retain their scan-free fingerprint contract', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ano-native-scope-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await write(root, 'src/a.ts', 'export const a = 1;\n');
  assert.equal(await resolveProjectSourceScan(root), undefined);
  assert.equal((await fingerprintProject(root, undefined)).status, 'ok');
});
