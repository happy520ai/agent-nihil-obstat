import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ledger } from '../src/ledger/ledger.ts';
import { GraphStore } from '../src/structure/store.ts';
import { impact } from '../src/gate/blast.ts';
import { verdictForTask } from '../src/gate/verdict.ts';
import { verifyTask } from '../src/gate/verify.ts';
import { executeEvidence } from '../src/gate/evidence.ts';
import { fingerprintTree } from '../src/core/fingerprint.ts';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const source = await fingerprintTree(projectRoot);
const failures: string[] = [];
const results: Record<string, unknown> = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  sourceFingerprint: source.hash,
  sourceFiles: source.files.length,
  scenarios: {},
  failures,
};
function check(condition: boolean, message: string): void { if (!condition) failures.push(message); }
async function write(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, source] of Object.entries(files)) {
    const target = join(root, ...path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, source);
  }
}
function git(root: string, args: string[]): void {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
}
function baseline(root: string): void {
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'ano-test@localhost'], ['config', 'user.name', 'ANO P1'], ['config', 'core.autocrlf', 'false'], ['add', '.'], ['commit', '-qm', 'baseline']]) git(root, args);
}
async function baseProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ano p1 coverage '));
  await write(root, {
    '.gitignore': '.ano/\n', 'package.json': JSON.stringify({ name: 'p1-synthetic', private: true, type: 'module' }),
    'src/a.ts': 'export function changed(): number { return 1; }\n',
    'src/b.ts': "import { changed } from './a.ts';\nexport function b(): number { return changed(); }\n",
    'src/c.ts': "import { changed } from './a.ts';\nexport function c(): number { return changed(); }\n",
    'test/b.test.ts': "import assert from 'node:assert/strict';import test from 'node:test';import { b } from '../src/b.ts';test('b', () => assert.equal(b(), 2));\n",
  });
  baseline(root);
  return root;
}
async function coverageScenario(): Promise<void> {
  const root = await baseProject();
  const ledger = await Ledger.open(root, { sessionId: 'P1-COVERAGE', actor: 'p1' });
  const graph = await GraphStore.open(root);
  try {
    await write(root, { 'src/a.ts': 'export function changed(): number { return 2; }\n' });
    await ledger.createTask('P1-COVERAGE', ['src/a.ts'], 'Only declare A');
    await ledger.updateTask('P1-COVERAGE', { status: 'in_progress' });
    const blocked = await verifyTask(root, 'P1-COVERAGE', { argv: [process.execPath, '--test', 'test/b.test.ts'], testFiles: ['test/b.test.ts'] }, { ledger, graph });
    (results.scenarios as Record<string, unknown>).coverageGap = blocked;
    check(blocked.status === 'blocked', 'Coverage gap was not blocked');
    check(blocked.blastRadius.uncovered.includes('src/c.ts'), 'C was not reported as uncovered');
    check(blocked.blastRadius.covered.includes('src/a.ts'), 'A must be transitively reachable from executed B test');
    check(ledger.getTask('P1-COVERAGE')?.status === 'in_progress', 'Blocked task must not become done');
  } finally { ledger.close(); graph.close(); }
}
async function coveredScenario(): Promise<void> {
  const root = await baseProject();
  await write(root, { 'test/c.test.ts': "import assert from 'node:assert/strict';import test from 'node:test';import { c } from '../src/c.ts';test('c', () => assert.equal(c(), 2));\n" });
  baseline(root);
  const ledger = await Ledger.open(root, { sessionId: 'P1-COVERED', actor: 'p1' });
  const graph = await GraphStore.open(root);
  try {
    await write(root, { 'src/a.ts': 'export function changed(): number { return 2; }\n' });
    await ledger.createTask('P1-COVERED', ['src/a.ts'], 'Covered A/B/C');
    await ledger.updateTask('P1-COVERED', { status: 'in_progress' });
    const verdict = await verifyTask(root, 'P1-COVERED', { argv: [process.execPath, '--test', 'test/b.test.ts', 'test/c.test.ts'], testFiles: ['test/b.test.ts', 'test/c.test.ts'] }, { ledger, graph });
    (results.scenarios as Record<string, unknown>).covered = verdict;
    check(verdict.status === 'done', `Covered scenario blocked: ${verdict.reasons.join('; ')}`);
    check(verdict.level === 'T1', 'Covered scenario did not reach T1');
    check(ledger.getTask('P1-COVERED')?.status === 'done', 'Done verdict was not committed');
  } finally { ledger.close(); graph.close(); }
}
async function staleScenario(): Promise<void> {
  const root = await baseProject();
  await write(root, { 'test/c.test.ts': "import assert from 'node:assert/strict';import test from 'node:test';import { c } from '../src/c.ts';test('c', () => assert.equal(c(), 2));\n" });
  baseline(root);
  const graph = await GraphStore.open(root);
  try {
    await graph.build();
    const snapshot = graph.snapshot();
    const evidence = await executeEvidence({ argv: [process.execPath, '--test', 'test/b.test.ts', 'test/c.test.ts'], cwd: root, timeoutMs: 10000 }, snapshot.sourceFingerprint, snapshot.revision);
    await write(root, { 'src/a.ts': 'export function changed(): number { return 3; }\n' });
    const freshness = await graph.checkFreshness();
    const verdict = verdictForTask({ task: { id: 'STALE', status: 'in_progress', declaredFiles: ['src/a.ts'] }, touched: ['src/a.ts'], executedTests: ['test/b.test.ts', 'test/c.test.ts'], evidence, graph: snapshot, freshness, policy: { minimum: 'T1', unknown: 'strict' } });
    (results.scenarios as Record<string, unknown>).stale = verdict;
    check(freshness.status === 'stale', 'Changed source was not detected as stale');
    check(verdict.status === 'blocked', 'Stale graph was allowed to pass');
  } finally { graph.close(); }
}
async function barrelScenario(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'ano p1 barrel '));
  await write(root, {
    'package.json': JSON.stringify({ name: 'p1-barrel', private: true, type: 'module' }),
    'src/a.ts': 'export interface User { id: string }\nexport const a = 1;\n',
    'src/b.ts': 'export const b = 2;\n', 'src/c.ts': 'export const c = 3;\n',
    'src/index.ts': "export { a, type User } from './a.ts';\nexport { b } from './b.ts';\nexport { c } from './c.ts';\n",
    'src/user-consumer.ts': "import type { User } from './index.ts';\nexport const show = (user: User) => user.id;\n",
    'src/b-consumer.ts': "import { b } from './index.ts';\nexport const useB = () => b;\n",
    'test/b.test.ts': "import assert from 'node:assert/strict';import test from 'node:test';import { b } from '../src/index.ts';test('b', () => assert.equal(b, 2));\n",
  });
  const graph = await GraphStore.open(root);
  try {
    await graph.build();
    const snapshot = graph.snapshot();
    const affected = impact(snapshot, ['src/a.ts']);
    const verdict = verdictForTask({ task: { id: 'BARREL', status: 'in_progress', declaredFiles: ['src/a.ts'] }, touched: [], executedTests: ['test/b.test.ts'], graph: snapshot, freshness: graph.freshness(), policy: { minimum: 'T1', unknown: 'strict' } });
    (results.scenarios as Record<string, unknown>).barrel = { impact: affected, verdict, edges: snapshot.edges };
    check(affected.includes('src/user-consumer.ts'), 'Type-only importer missing from impact');
    check(affected.includes('src/index.ts'), 'Named barrel missing from impact');
    check(!affected.includes('src/b-consumer.ts'), 'Unrelated B consumer was included in A impact');
    check(!verdict.blastRadius.covered.includes('src/a.ts'), 'Barrel import of B falsely covered A');
    check(verdict.status === 'blocked', 'Barrel false coverage was not blocked');
    check(snapshot.edges.some((edge) => edge.from === 'src/user-consumer.ts' && edge.to === 'src/a.ts' && edge.kind === 'type-only'), 'Implicit interface import was not type-only');
    check(snapshot.edges.some((edge) => edge.from === 'test/b.test.ts' && edge.to === 'src/b.ts' && edge.kind === 'value-confirmed'), 'Test did not resolve B through barrel');
  } finally { graph.close(); }
}
async function realProjectScenario(): Promise<void> {
  const candidate = process.env.ANO_REAL_PROJECT ?? 'D:/DevTools/pm-mcp';
  const result: Record<string, unknown> = { candidate, selected: false };
  try {
    if (!(await readdir(candidate)).includes('package.json')) throw new Error('Candidate package.json is missing');
    const store = await GraphStore.open(candidate);
    try {
      await store.build();
      const snapshot = store.snapshot();
      const files = Object.keys(snapshot.files).filter((path) => path.startsWith('src/')).sort();
      const stride = Math.max(1, Math.floor(files.length / 30));
      const sampled = files.filter((_, index) => index % stride === 0);
      const distributions = sampled.map((file) => {
        const resolvedGraph = { ...snapshot, edges: snapshot.edges.filter((edge) => edge.kind === 'value-confirmed' && edge.provenance === 'resolved') };
        return { file, resolved: impact(resolvedGraph, [file]).length, full: impact(snapshot, [file]).length };
      });
      const values = distributions.map((item) => item.full).sort((a, b) => a - b);
      const median = values.length % 2 ? values[(values.length - 1) / 2]! : (values[values.length / 2 - 1]! + values[values.length / 2]!) / 2;
      const p90 = values[Math.max(0, Math.ceil(values.length * .9) - 1)]!;
      Object.assign(result, { selected: true, files: files.length, sampleSize: sampled.length, stride, distributions, median, p90, caveats: snapshot.caveats, freshness: store.freshness() });
    } finally { store.close(); }
  } catch (error) { result.error = error instanceof Error ? error.message : String(error); }
  results.realProject = result;
}
for (const [name, run] of Object.entries({ coverageScenario, coveredScenario, staleScenario, barrelScenario, realProjectScenario })) {
  try { await run(); } catch (error) { failures.push(`${name}: ${error instanceof Error ? error.stack : String(error)}`); }
}
const realProject = results.realProject as { selected?: boolean } | undefined;
const syntheticPass = failures.length === 0;
results.verdict = !syntheticPass ? 'failed' : realProject?.selected === true ? 'synthetic-pass-real-project-measured' : 'synthetic-pass-real-project-unavailable';
const output = process.env.ANO_P1_OUTPUT ?? fileURLToPath(new URL('../docs/evidence/p1-experiment.json', import.meta.url));
await writeFile(output, JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify(results, null, 2));
if (failures.length) process.exitCode = 1;
