import assert from 'node:assert/strict';
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { GraphStore } from '../../src/structure/store.ts';
import { verdictForTask } from '../../src/gate/verdict.ts';
import type { Evidence } from '../../src/gate/types.ts';

const FIXTURE: Record<string, string> = {
  'package.json': JSON.stringify({
    name: 'structure-fixture',
    private: true,
    workspaces: ['packages/*'],
    imports: { '#self/*': './src/self/*.ts', '#fixed': './src/self/util.ts' },
  }, null, 2),
  'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }, null, 2),
  'packages/lib/package.json': JSON.stringify({ name: '@fixture/lib', exports: { '.': './src/index.ts' } }, null, 2),
  'packages/lib/src/index.ts': 'export const libValue = 3;\n',
  'src/defs.ts': [
    'export interface Shape { x: number }',
    'export const shapeValue = 1;',
    'export interface Mixed { a: string }',
    'export const Mixed = 42;',
    'export type Alias = string;',
    'export function fn(): number { return shapeValue; }',
    '',
  ].join('\n'),
  'src/wild.ts': [
    'export const wildValue = 2;',
    'export interface WildThing { y: string }',
    '',
  ].join('\n'),
  'src/barrel.ts': [
    "export { shapeValue } from './defs.js';",
    "export type { Alias as Renamed } from './defs.js';",
    "export * from './wild.js';",
    '',
  ].join('\n'),
  'src/ring-a.ts': "export * from './ring-b.js';\n",
  'src/ring-b.ts': "export * from './ring-a.js';\n",
  'src/dynamic-target.ts': 'export const dynamicValue = 5;\n',
  'src/self/util.ts': 'export const selfValue = 7;\nexport const fixedValue = 8;\n',
  'src/star-external.ts': "export * from 'zod';\nexport * as lodash from 'lodash';\n",
  'src/type-forward.ts': "import type { Shape } from './defs.js';\nexport { Shape };\n",
  'src/type-user.ts': "import { Shape } from './type-forward.js';\nexport type ShapeUser = Shape;\n",
  'src/features/index.ts': 'export const featureValue = 6;\n',
  'src/cycle-user.ts': [
    "import { never } from './ring-a.js';",
    'export const n = never;',
    '',
  ].join('\n'),
  'src/consumer.ts': [
    "import type { Shape } from './defs.js';",
    "import { Shape as PlainShape } from './defs.js';",
    "import { Mixed } from './defs.js';",
    "import { shapeValue } from './barrel.js';",
    "import { WildThing as Wild } from './barrel.js';",
    "import { Renamed } from './barrel.js';",
    "import { featureValue } from './features';",
    "import { libValue } from '@fixture/lib';",
    "import { fn } from '@/defs';",
    "import './defs.js';",
    "import { absent } from './missing.js';",
    "import { z } from 'zod';",
    "import * as wild from './wild.js';",
    "import { selfValue } from '#self/util';",
    "import { fixedValue } from '#fixed';",
    "const target = './dynamic-target.js';",
    'export const lazy = () => import(target);',
    "export const literal = () => import('./dynamic-target.js');",
    "export const legacy = () => require('./dynamic-target.js');",
    'export const all = [shapeValue, Mixed, featureValue, libValue, fn, PlainShape, Wild, Renamed, lazy, literal, legacy, z, wild, selfValue, fixedValue];',
    '',
  ].join('\n'),
};

async function createFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ano structure integration '));
  for (const [path, content] of Object.entries(FIXTURE)) {
    const absolute = join(root, ...path.split('/'));
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  return root;
}

function fakeEvidence(store: GraphStore): Evidence {
  return {
    id: '00000000-0000-4000-8000-000000000000',
    argv: ['node', '--test'],
    cwd: 'fixture',
    sourceFingerprint: store.sourceFingerprint,
    graphRevision: store.revision,
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    startedAt: new Date(0).toISOString(),
    finishedAt: new Date(1).toISOString(),
    durationMs: 1,
    exitCode: 0,
    signal: null,
    timedOut: false,
    counts: { tests: 1, pass: 1, fail: 0 },
    ok: true,
    outputDigest: 'a'.repeat(64),
  };
}

test('GraphStore builds the real TS graph, persists to SQLite and replays it', async () => {
  const root = await createFixture();
  const store = await GraphStore.open(root);
  await store.build();
  assert.equal(store.lastBuild?.mode, 'full');
  assert.equal(store.lastBuild?.degraded, false);
  await stat(join(root, '.ano', 'cache', 'graph.db'));

  const snapshot = store.snapshot();
  assert.ok(store.filesList().includes('src/consumer.ts'));
  assert.deepEqual(store.filesList(), [...store.filesList()].sort());
  assert.equal(store.freshness().status, 'fresh');
  assert.equal(snapshot.sourceFingerprint.length, 64);
  assert.equal(snapshot.revision.length, 64);

  const mixedSymbols = snapshot.symbols.filter((symbol) => symbol.file === 'src/defs.ts' && symbol.name === 'Mixed');
  assert.equal(mixedSymbols.length, 1);
  assert.equal(mixedSymbols[0]?.symbolKind, 'value');
  assert.equal(snapshot.symbols.find((symbol) => symbol.file === 'src/defs.ts' && symbol.name === 'Shape')?.symbolKind, 'type');

  const edges = snapshot.edges;
  const edge = (from: string, to: string, kind: string, label?: string): typeof edges[number] | undefined =>
    edges.find((candidate) => candidate.from === from && candidate.to === to && candidate.kind === kind && (label === undefined || candidate.label === label));

  const typeEdge = edge('src/consumer.ts', 'src/defs.ts', 'type-only');
  assert.ok(typeEdge);
  assert.ok(typeEdge.importedNames.includes('Shape'));
  assert.ok(typeEdge.importedNames.includes('Renamed'));
  assert.equal(typeEdge.label, undefined);
  const valueEdge = edge('src/consumer.ts', 'src/defs.ts', 'value-confirmed');
  assert.ok(valueEdge);
  assert.ok(valueEdge.importedNames.includes('Mixed'));
  assert.ok(valueEdge.importedNames.includes('shapeValue'));
  assert.ok(valueEdge.importedNames.includes('fn'));

  const barrelWildcard = edge('src/consumer.ts', 'src/wild.ts', 'type-only', 'barrel_wildcard');
  assert.equal(barrelWildcard?.provenance, 'heuristic');
  assert.deepEqual(barrelWildcard?.importedNames, ['WildThing']);
  assert.ok(edge('src/barrel.ts', 'src/wild.ts', 'unknown', 'barrel_wildcard'));

  assert.ok(edge('src/consumer.ts', 'src/features/index.ts', 'value-confirmed'));
  assert.ok(edge('src/consumer.ts', 'packages/lib/src/index.ts', 'value-confirmed'));

  const cycle = edge('src/cycle-user.ts', 'src/ring-a.ts', 'unknown', 'depth_limit');
  assert.equal(cycle?.provenance, 'heuristic');

  const sideEffect = edge('src/consumer.ts', 'src/defs.ts', 'value-confirmed', 'sideEffect');
  assert.deepEqual(sideEffect?.importedNames, []);

  const unresolved = edge('src/consumer.ts', './missing.js', 'unknown', 'unresolved');
  assert.deepEqual(unresolved?.importedNames, ['absent']);

  const dynamicVariable = edge('src/consumer.ts', '<dynamic>', 'unknown', 'dynamic_import');
  assert.ok(dynamicVariable);
  // 架构 §5.2/§5.3：动态 import 即使是字面量也只退化为文件级 heuristic 边，绝不记 value-confirmed。
  const dynamicLiteral = edge('src/consumer.ts', 'src/dynamic-target.ts', 'unknown', 'dynamic_import');
  assert.equal(dynamicLiteral?.provenance, 'heuristic');
  assert.equal(edge('src/consumer.ts', 'src/dynamic-target.ts', 'value-confirmed', 'dynamic_import'), undefined);

  // 外部包与外部 re-export 必须留下可见的 unknown 边（绝不静默漏边）。
  const externalImport = edge('src/consumer.ts', 'zod', 'unknown');
  assert.ok(externalImport);
  assert.deepEqual(externalImport?.importedNames, ['z']);
  const externalStar = edge('src/star-external.ts', 'zod', 'unknown', 'unresolved');
  assert.ok(externalStar);
  const externalNamespace = edge('src/star-external.ts', 'lodash', 'unknown');
  assert.ok(externalNamespace);

  // package.json#imports 别名要能解析到项目内文件。
  const importsAlias = edge('src/consumer.ts', 'src/self/util.ts', 'value-confirmed');
  assert.deepEqual(importsAlias?.importedNames, ['fixedValue', 'selfValue']);

  // `import * as ns` 只证明模块被加载，不证明任何名字被使用。
  const namespaceImport = edge('src/consumer.ts', 'src/wild.ts', 'unknown', 'namespace_import');
  assert.equal(namespaceImport?.provenance, 'resolved');
  assert.equal(edge('src/consumer.ts', 'src/wild.ts', 'value-confirmed'), undefined);

  // `import type { X }` 后 `export { X }`：按 type-only 穿透到定义文件，不指向转发文件。
  const forwarded = edges.filter((candidate) => candidate.from === 'src/type-user.ts' && candidate.importedNames.includes('Shape'));
  assert.equal(forwarded.length, 1, 'Shape 只应有一条边，且不是指向转发文件');
  assert.equal(forwarded[0]?.to, 'src/defs.ts');
  assert.equal(forwarded[0]?.kind, 'type-only');
  assert.equal(forwarded[0]?.provenance, 'resolved');

  const caveats = snapshot.caveats;
  assert.equal(caveats.edgeCounts['value-confirmed'] + caveats.edgeCounts['type-only'] + caveats.edgeCounts.unknown, edges.length);
  assert.equal(caveats.heuristicEdges, edges.filter((candidate) => candidate.provenance === 'heuristic').length);
  assert.equal(caveats.unknownRatio, caveats.edgeCounts.unknown / edges.length);
  assert.ok(caveats.dynamicLoadCount >= 3);
  assert.equal(caveats.filesWithUnresolvableDynamicLoads, 1);
  assert.deepEqual(caveats.degradedReasons, []);

  const firstRevision = snapshot.revision;
  await store.build();
  assert.equal(store.snapshot().revision, firstRevision);
  store.close();

  const replayed = await GraphStore.open(root);
  assert.deepEqual(replayed.snapshot(), snapshot);
  assert.equal(replayed.freshness().status, 'fresh');
  replayed.close();
});

test('freshness detects modified source and the gate rejects a stale graph', async () => {
  const root = await createFixture();
  const store = await GraphStore.open(root);
  await store.build();
  const freshRevision = store.revision;
  store.close();

  const reopened = await GraphStore.open(root);
  assert.equal(reopened.freshness().status, 'fresh');
  await writeFile(join(root, 'src', 'wild.ts'), 'export const wildValue = 9;\nexport interface WildThing { y: string }\n');

  assert.equal(reopened.freshness().status, 'fresh', 'sync freshness reflects the last build/open scan');
  const stale = await reopened.checkFreshness();
  assert.equal(stale.status, 'stale');
  assert.ok(stale.stale >= 1);

  const blocked = verdictForTask({
    task: { id: 'T-stale', status: 'in_progress', declaredFiles: ['src/wild.ts'] },
    touched: ['src/wild.ts'],
    executedTests: ['test/x.test.ts'],
    evidence: fakeEvidence(reopened),
    graph: reopened.snapshot(),
    freshness: stale,
    policy: { minimum: 'T0', unknown: 'advisory' },
  });
  assert.equal(blocked.status, 'blocked');
  assert.ok(blocked.reasons.some((reason) => reason.includes('stale')));

  await reopened.build();
  assert.equal(reopened.freshness().status, 'fresh');
  assert.notEqual(reopened.revision, freshRevision);
  reopened.close();

  const final = await GraphStore.open(root);
  assert.equal(final.freshness().status, 'fresh');
  final.close();
});

test('freshness compares the source fingerprint so tsconfig/package.json changes go stale', async () => {
  const root = await createFixture();
  const store = await GraphStore.open(root);
  await store.build();
  assert.equal(store.freshness().status, 'fresh');

  // 配置文件变化不改变任何源码哈希，但指纹必须变化 → stale。
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'], '~/*': ['src/*'] } },
  }, null, 2));
  const afterTsconfig = await store.checkFreshness();
  assert.equal(afterTsconfig.status, 'stale');

  await store.build();
  assert.equal(store.freshness().status, 'fresh');

  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'structure-fixture',
    private: true,
    workspaces: ['packages/*'],
    imports: { '#self/*': './src/self/*.ts' },
  }, null, 2));
  const afterPackage = await store.checkFreshness();
  assert.equal(afterPackage.status, 'stale');
  store.close();
});
