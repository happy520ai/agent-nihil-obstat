import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { GraphStore } from '../../src/structure/store.ts';
import { exploreFlow, exploreSearch } from '../../src/structure/explore.ts';
import { t2Coverage } from '../../src/structure/t2.ts';

async function writeFixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ano p3 full '));
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, ...path.split('/'));
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  return root;
}

test('a call to a type-only export is skipped and never becomes a value call', async () => {
  const root = await writeFixture({
    'package.json': JSON.stringify({ name: 'type-call', private: true }),
    'src/types.ts': 'export interface Thing { value: string }\n',
    'src/user.ts': [
      "import { Thing } from './types.js';",
      'export function make(): void { Thing(); }',
      'export function good(): number { return 1; }',
      '',
    ].join('\n'),
    'test/user.test.ts': [
      "import { good } from '../src/user.js';",
      'export function run(): number { return good(); }',
      '',
    ].join('\n'),
  });
  const store = await GraphStore.open(root);
  await store.build();
  const snapshot = store.snapshot();
  const thing = snapshot.symbols.find((symbol) => symbol.file === 'src/types.ts' && symbol.name === 'Thing');
  assert.ok(thing);
  assert.equal(thing.symbolKind, 'type');

  assert.equal((snapshot.calls ?? []).some((edge) => edge.callee === 'Thing' || edge.calleeSymbolId === thing.id), false);
  assert.ok((snapshot.caveats.typeOnlyCallSites ?? 0) >= 1, 'the skipped type call must be reported, not silently dropped');
  assert.equal(snapshot.edges.some((edge) => edge.from === 'src/user.ts' && edge.to === 'src/types.ts' && edge.kind === 'value-confirmed'), false);
  assert.ok(snapshot.edges.some((edge) => edge.from === 'src/user.ts' && edge.to === 'src/types.ts' && edge.kind === 'type-only'));

  const report = t2Coverage(snapshot, ['test/user.test.ts'], ['src/types.ts']);
  assert.equal(report.applicable, false);
  assert.equal(report.satisfied, false);
  store.close();
});

test('heuristic call edges are visible but cannot satisfy T2; only resolved calls do', async () => {
  const root = await writeFixture({
    'package.json': JSON.stringify({ name: 'heuristic-call', private: true }),
    'src/cache.ts': [
      'export class Cache {',
      '  get(): number { return 1; }',
      '}',
      'export function use(thing: Cache): number { return thing.get(); }',
      'export function direct(): number { const c = new Cache(); return c.get(); }',
      '',
    ].join('\n'),
    'test/use.test.ts': [
      "import { use, Cache } from '../src/cache.js';",
      'export function run(): number { return use(new Cache()); }',
      '',
    ].join('\n'),
    'test/direct.test.ts': [
      "import { direct } from '../src/cache.js';",
      'export function run(): number { return direct(); }',
      '',
    ].join('\n'),
  });
  const store = await GraphStore.open(root);
  await store.build();
  const snapshot = store.snapshot();
  const get = snapshot.symbols.find((symbol) => symbol.file === 'src/cache.ts' && symbol.qualifiedName === 'Cache.get');
  assert.ok(get);

  const heuristic = (snapshot.calls ?? []).filter((edge) => edge.callee === 'get' && edge.provenance === 'heuristic');
  assert.ok(heuristic.length >= 1, 'untyped receiver method should be recorded as heuristic');
  assert.ok((snapshot.calls ?? []).some((edge) => edge.callee === 'get' && edge.provenance === 'resolved'));

  const useOnly = t2Coverage(snapshot, ['test/use.test.ts'], ['src/cache.ts']);
  assert.equal(useOnly.applicable, true);
  assert.equal(useOnly.coveredSymbols.includes(get.id), false, 'heuristic call must not reach Cache.get');
  assert.ok(useOnly.uncoveredSymbols.includes(get.id));

  const directOnly = t2Coverage(snapshot, ['test/direct.test.ts'], ['src/cache.ts']);
  assert.equal(directOnly.coveredSymbols.includes(get.id), true, 'resolved instance call reaches Cache.get');

  const options = { root, freshness: store.freshness() };
  const resolvedFlow = await exploreFlow(snapshot, { from: 'test/use.test.ts', to: 'Cache.get' }, options);
  assert.equal(resolvedFlow.data.paths.length, 0, 'flow defaults to resolved call edges only');
  assert.ok(resolvedFlow.meta.notes.includes('resolved-call-edges-only'));
  const heuristicFlow = await exploreFlow(snapshot, { from: 'test/use.test.ts', to: 'Cache.get' }, { ...options, includeHeuristicCalls: true });
  assert.ok(heuristicFlow.data.paths.length >= 1);
  assert.ok(heuristicFlow.data.paths[0]?.steps.some((step) => step.provenance === 'heuristic'));
  store.close();
});

test('incremental cache still re-resolves edges when an unchanged caller depends on a changed export', async () => {
  const root = await writeFixture({
    'package.json': JSON.stringify({ name: 'incremental-edges', private: true }),
    'src/lib.ts': 'export function helper(): number { return 1; }\n',
    'src/user.ts': "import { helper } from './lib.js';\nexport function user(): number { return helper(); }\n",
    'test/a.test.ts': "import { user } from '../src/user.js';\nexport function run(): number { return user(); }\n",
  });
  const store = await GraphStore.open(root);
  await store.build();
  const before = store.snapshot();
  assert.ok((before.calls ?? []).some((edge) => edge.from === 'src/user.ts' && edge.callee === 'helper' && edge.provenance === 'resolved'));
  const libBefore = t2Coverage(before, ['test/a.test.ts'], ['src/lib.ts']);
  assert.equal(libBefore.satisfied, true);

  await writeFile(join(root, 'src', 'lib.ts'), 'export function other(): number { return 2; }\n');
  await store.build();
  assert.equal(store.lastBuild?.parsed, 1, 'only lib.ts changed');
  assert.ok((store.lastBuild?.reused ?? 0) >= 1, 'unchanged caller/test parsed data is reused');
  const after = store.snapshot();
  assert.equal((after.calls ?? []).some((edge) => edge.from === 'src/user.ts' && edge.callee === 'helper'), false, 'stale resolved call must disappear');
  assert.ok((after.caveats.unresolvedCallSites ?? 0) > 0);
  const libAfter = t2Coverage(after, ['test/a.test.ts'], ['src/lib.ts']);
  assert.equal(libAfter.satisfied, false);
  const revision = store.revision;
  store.close();

  const reopened = await GraphStore.open(root);
  assert.equal(reopened.revision, revision);
  assert.equal((reopened.snapshot().calls ?? []).some((edge) => edge.from === 'src/user.ts' && edge.callee === 'helper'), false);
  reopened.close();
});

test('a read I/O error retains old call data in memory and in SQLite instead of deleting it', async () => {
  const fixture = {
    'package.json': JSON.stringify({ name: 'retain-calls', private: true }),
    'src/a.ts': [
      'export class A {',
      '  run(): number { return this.step(); }',
      '  step(): number { return 1; }',
      '}',
      'export function entry(): number { const a = new A(); return a.run(); }',
      '',
    ].join('\n'),
  };
  const root = await writeFixture(fixture);
  let failSource = false;
  const store = await GraphStore.open(root, {
    readFile: async (path) => {
      if (failSource && path.endsWith('a.ts')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      const { readFile } = await import('node:fs/promises');
      return readFile(path, 'utf8');
    },
  });
  await store.build();
  const before = store.snapshot();
  const oldCalls = before.calls ?? [];
  assert.ok(oldCalls.some((edge) => edge.callee === 'step' && edge.provenance === 'resolved'));

  // Change the file so the fingerprint hash no longer matches; the read seam now
  // fails, forcing the degraded retention path rather than the parse cache path.
  await writeFile(join(root, 'src', 'a.ts'), 'export function replaced(): number { return 9; }\n');
  failSource = true;
  await store.build();
  assert.equal(store.lastBuild?.degraded, true);
  assert.equal(store.lastBuild?.retained, 1);
  const retained = store.snapshot();
  assert.deepEqual(retained.files['src/a.ts']?.hash, before.files['src/a.ts']?.hash, 'old file manifest is retained');
  assert.ok((retained.calls ?? []).some((edge) => edge.callee === 'step'), 'old call edge is retained, not tombstoned');
  assert.ok((retained.calls ?? []).some((edge) => edge.callee === 'A'), 'old constructor call is retained');
  assert.ok(retained.caveats.degradedReasons.some((reason) => reason.includes('unreadable:src/a.ts:EACCES')));
  store.close();

  const reopened = await GraphStore.open(root);
  assert.deepEqual(reopened.snapshot().calls, retained.calls, 'SQLite was not wiped by the failed build');
  assert.ok(reopened.snapshot().symbols.some((symbol) => symbol.file === 'src/a.ts' && symbol.qualifiedName === 'A.step'));
  reopened.close();
});

test('schema v1 cache migrates in place: old files/edges survive, calls table is added, freshness is stale', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ano p3 migrate '));
  const cacheDirectory = join(root, '.ano', 'cache');
  await mkdir(cacheDirectory, { recursive: true });
  const db = new DatabaseSync(join(cacheDirectory, 'graph.db'));
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE files (path TEXT PRIMARY KEY, hash TEXT NOT NULL, dynamic_loads INTEGER NOT NULL, unresolved_dynamic_loads INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE symbols (id TEXT PRIMARY KEY, file TEXT NOT NULL, name TEXT NOT NULL, qualified_name TEXT NOT NULL, symbol_kind TEXT NOT NULL, start_line INTEGER NOT NULL);
    CREATE TABLE edges (from_path TEXT NOT NULL, to_path TEXT NOT NULL, kind TEXT NOT NULL, provenance TEXT NOT NULL, imported_names TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', PRIMARY KEY (from_path, to_path, kind, provenance, label, imported_names));
    CREATE TABLE caveats (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const insertMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
  insertMeta.run('schema_version', '1');
  insertMeta.run('revision', 'legacy-revision');
  insertMeta.run('source_fingerprint', 'legacy-fingerprint');
  insertMeta.run('caveats', JSON.stringify({
    edgeCounts: { 'value-confirmed': 1, 'type-only': 0, unknown: 0 },
    heuristicEdges: 0,
    unknownRatio: 0,
    filesWithUnresolvableDynamicLoads: 0,
    dynamicLoadCount: 0,
    degradedReasons: [],
  }));
  db.prepare('INSERT INTO files (path, hash, dynamic_loads, unresolved_dynamic_loads) VALUES (?, ?, 0, 0)').run('src/legacy.ts', 'legacy-hash');
  db.prepare('INSERT INTO symbols (id, file, name, qualified_name, symbol_kind, start_line) VALUES (?, ?, ?, ?, ?, ?)').run('legacy-symbol', 'src/legacy.ts', 'legacy', 'legacy', 'value', 1);
  db.prepare('INSERT INTO edges (from_path, to_path, kind, provenance, imported_names, label) VALUES (?, ?, ?, ?, ?, ?)').run('test/a.test.ts', 'src/legacy.ts', 'value-confirmed', 'resolved', '["legacy"]', '');
  db.close();

  const store = await GraphStore.open(root);
  const snapshot = store.snapshot();
  assert.ok(store.filesList().includes('src/legacy.ts'), 'v1 file row survived migration');
  assert.equal(snapshot.revision, 'legacy-revision');
  assert.equal(snapshot.sourceFingerprint, 'legacy-fingerprint');
  assert.ok(snapshot.symbols.some((symbol) => symbol.id === 'legacy-symbol'));
  assert.ok(snapshot.edges.some((edge) => edge.from === 'test/a.test.ts' && edge.to === 'src/legacy.ts' && edge.kind === 'value-confirmed'));
  assert.deepEqual(snapshot.calls, [], 'L2 calls start empty until rebuild');
  assert.equal(store.freshness().status, 'stale', 'migrated caches are not falsely fresh');
  store.close();

  const check = new DatabaseSync(join(cacheDirectory, 'graph.db'));
  const version = check.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value: string } | undefined;
  const callsTable = check.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'calls'").get() as { name: string } | undefined;
  const fileCount = check.prepare('SELECT COUNT(*) AS count FROM files').get() as { count: number };
  check.close();
  assert.equal(version?.value, '2');
  assert.equal(callsTable?.name, 'calls');
  assert.equal(fileCount.count, 1, 'migration did not delete rows');
});

test('a zero-char budget still reports real totalMatches; budget is output size, not hit count', async () => {
  const root = await writeFixture({
    'package.json': JSON.stringify({ name: 'budget-hits', private: true }),
    'src/many.ts': [
      'export const alpha = 1;',
      'export const beta = 2;',
      'export const gamma = 3;',
      'export function delta(): number { return alpha + beta + gamma; }',
      '',
    ].join('\n'),
  });
  const store = await GraphStore.open(root);
  await store.build();
  const snapshot = store.snapshot();
  const result = await exploreSearch(snapshot, { query: 'a' }, { freshness: store.freshness(), maxOutputChars: 0 });
  assert.ok(result.meta.totalMatches > 0);
  assert.equal(result.meta.returned, 0);
  assert.equal(result.meta.budget.limitChars, 0);
  assert.equal(result.meta.budget.semantics, 'output-size');
  assert.ok(result.meta.totalMatches !== result.meta.budget.limitChars);
  assert.equal(result.meta.budget.truncated, true);
  store.close();
});
