import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { withFileLock, withFileLockSync } from '../../src/core/lock.ts';
import { Ledger } from '../../src/ledger/ledger.ts';
import { testCoverage } from '../../src/gate/blast.ts';
import { emptyCaveats } from '../../src/structure/types.ts';
import { fingerprintTree } from '../../src/core/fingerprint.ts';
import { buildSnapshot } from '../../src/structure/extractor.ts';
import { verifyTask } from '../../src/gate/verify.ts';
import { GraphStore } from '../../src/structure/store.ts';
import { completeTaskViaGate } from '../helpers/gate-complete.ts';
import { spawnSync } from 'node:child_process';

async function temp(prefix: string): Promise<string> { return mkdtemp(join(tmpdir(), prefix)); }
async function write(root: string, path: string, source: string): Promise<void> { const file = join(root, path); await mkdir(dirname(file), { recursive: true }); await writeFile(file, source); }
function git(root: string, args: string[]): void { assert.equal(spawnSync('git', ['-C', root, ...args]).status, 0); }

test('T1 coverage cannot propagate through heuristic value edges', () => {
  const graph = { revision: 'r', sourceFingerprint: 'f', files: {}, symbols: [], caveats: emptyCaveats(), edges: [{ from: 'lazy.test.ts', to: 'lazy.ts', kind: 'value-confirmed' as const, provenance: 'heuristic' as const, importedNames: [] }] };
  assert.deepEqual([...testCoverage(graph, ['lazy.test.ts'])], ['lazy.test.ts']);
});

test('HLC replay merges observed events before new writes', async () => {
  const root = await temp('ano hlc boundary ');
  const a = await Ledger.open(root, { sessionId: 'A', actor: 'A', clock: () => 5000 });
  await a.createTask('T', []);
  a.close();
  const b = await Ledger.open(root, { sessionId: 'B', actor: 'B', clock: () => 4000 });
  const c = await Ledger.open(root, { sessionId: 'C', actor: 'C', clock: () => 6000 });
  await c.createTask('C', []);
  c.close();
  await completeTaskViaGate(root, b, 'T');
  b.close();
  await rm(join(root, '.ano', 'cache'), { recursive: true, force: true });
  const replayed = await Ledger.open(root, { sessionId: 'D', clock: () => 1000 });
  assert.equal(replayed.getTask('T')?.status, 'done');
  replayed.close();
});

test('deleting a segment cannot leave ghost tasks in the view cache', async () => {
  const root = await temp('ano ghost cache ');
  const ledger = await Ledger.open(root, { sessionId: 'GHOST' });
  await ledger.createTask('GHOST', []);
  const segment = ledger.segmentPath;
  ledger.close();
  await rm(segment);
  const reopened = await Ledger.open(root, { sessionId: 'NEW' });
  assert.deepEqual(reopened.getTasks(), []);
  const result = await reopened.createTask('GHOST', []);
  assert.equal(result.duplicate, false);
  reopened.close();
});

test('lock does not steal live ownership and operation EEXIST is not retried', async () => {
  const root = await temp('ano lock boundary ');
  const path = join(root, 'mutex');
  let calls = 0;
  assert.throws(() => withFileLockSync(path, () => { calls += 1; const error = new Error('operation') as NodeJS.ErrnoException; error.code = 'EEXIST'; throw error; }), /operation/);
  assert.equal(calls, 1);
  let completed = false;
  const first = withFileLock(path, async () => { await new Promise((resolve) => setTimeout(resolve, 45)); completed = true; }, { staleAfterMs: 1 });
  await new Promise((resolve) => setTimeout(resolve, 12));
  await assert.rejects(withFileLock(path, async () => undefined, { timeoutMs: 30, staleAfterMs: 1 }), /Timed out/);
  await first;
  assert.equal(completed, true);
});

test('external, wildcard and namespace edges are visible but do not claim confirmed coverage', async () => {
  const root = await temp('ano graph boundary ');
  await write(root, 'src/types.ts', 'export interface OnlyType { id: string }\n');
  await write(root, 'src/star.ts', "export * from './types.js';\n");
  await write(root, 'src/ns.ts', "export * as ns from './types.js';\n");
  await write(root, 'src/consumer.ts', "import { OnlyType } from './star.js'; import { ns } from './ns.js'; import { z } from 'zod'; export const x = [OnlyType, ns, z];\n");
  const result = await buildSnapshot({ root, fingerprint: await fingerprintTree(root) });
  assert.ok(result.snapshot.edges.some((edge) => edge.to === 'zod' && edge.kind === 'unknown'));
  assert.ok(result.snapshot.edges.some((edge) => edge.label === 'barrel_wildcard' && edge.kind === 'unknown'));
  assert.ok(!result.snapshot.edges.some((edge) => edge.label === 'barrel_wildcard' && edge.kind === 'value-confirmed'));
});

test('verify rejects TAP-only argv and idempotent retry does not rerun tests', async () => {
  const root = await temp('ano verify boundary ');
  await write(root, '.gitignore', '.ano/\n');
  await write(root, 'src/a.ts', 'export const a = 1;\n');
  await write(root, 'test/a.test.ts', "import test from 'node:test';import assert from 'node:assert/strict';import { a } from '../src/a.ts';import { writeFileSync } from 'node:fs';test('a',()=>{writeFileSync('ran.txt','x');assert.equal(a,1)});\n");
  await write(root, 'package.json', JSON.stringify({ private: true, type: 'module' }));
  for (const args of [['init', '-q'], ['config', 'user.email', 'test@localhost'], ['config', 'user.name', 'test'], ['add', '.'], ['commit', '-qm', 'base']]) git(root, args);
  await write(root, 'src/a.ts', 'export const a = 2;\n');
  await write(root, 'test/a.test.ts', "import test from 'node:test';import assert from 'node:assert/strict';import { a } from '../src/a.ts';import { writeFileSync } from 'node:fs';test('a',()=>{writeFileSync('ran.txt','x');assert.equal(a,2)});\n");
  const ledger = await Ledger.open(root, { sessionId: 'VERIFY' });
  const graph = await GraphStore.open(root);
  try {
    await ledger.createTask('T', ['src/a.ts', 'test/a.test.ts']);
    await ledger.updateTask('T', { status: 'in_progress' });
    await assert.rejects(verifyTask(root, 'T', { argv: [process.execPath, '-e', "console.log('# tests 1\\n# pass 1')"], testFiles: ['test/a.test.ts'], idemKey: 'fake' }, { ledger, graph }), /not selected|does not exist/);
    const first = await verifyTask(root, 'T', { argv: [process.execPath, '--test', 'test/a.test.ts'], testFiles: ['test/a.test.ts'], idemKey: 'real' }, { ledger, graph });
    assert.equal(first.status, 'done');
    await rm(join(root, 'ran.txt'));
    const second = await verifyTask(root, 'T', { argv: [process.execPath, '--test', 'test/a.test.ts'], testFiles: ['test/a.test.ts'], idemKey: 'real' }, { ledger, graph });
    assert.equal(second.evidenceId, first.evidenceId);
    assert.equal(existsSync(join(root, 'ran.txt')), false);
    assert.equal(ledger.listEvidence('T').length, 1);
  } finally { ledger.close(); graph.close(); }
});
