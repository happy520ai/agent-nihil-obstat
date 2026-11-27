import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fingerprintTree } from '../../src/core/fingerprint.ts';
import { impact, testCoverage } from '../../src/gate/blast.ts';
import { buildSnapshot } from '../../src/structure/extractor.ts';
import { checkGraphFreshness } from '../../src/structure/fresh.ts';

async function writeFixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ano structure hardening '));
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, ...path.split('/'));
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  return root;
}

async function snapshotOf(root: string): Promise<Awaited<ReturnType<typeof buildSnapshot>>['snapshot']> {
  const fingerprint = await fingerprintTree(root, { onError: () => 'degrade' });
  return (await buildSnapshot({ root, fingerprint })).snapshot;
}

const UNCONFIRMABLE_LABELS = ['barrel_wildcard', 'namespace_import', 'dynamic_import', 'unresolved', 'depth_limit'];

test('T1 coverage only follows value-confirmed resolved edges, never wildcard/namespace/dynamic edges', async () => {
  const root = await writeFixture({
    'src/defs.ts': 'export const a = 1;\n',
    'src/wild.ts': 'export const w = 2;\n',
    'src/barrel.ts': "export { a } from './defs.js';\nexport * from './wild.js';\n",
    'src/ns-target.ts': 'export const n = 3;\n',
    'src/ns.ts': "export * as ns from './ns-target.js';\n",
    'src/dyn.ts': 'export const d = 4;\n',
    'test/entry.test.ts': [
      "import { a } from '../src/barrel.js';",
      "import { w } from '../src/barrel.js';",
      "import * as namespace from '../src/ns.js';",
      "const target = '../src/dyn.js';",
      'export const loads = () => import(target);',
      "export const literal = () => import('../src/dyn.js');",
      'export const all = [a, w, namespace];',
    ].join('\n'),
  });
  const snapshot = await snapshotOf(root);

  const confirmed = snapshot.edges.filter((edge) => edge.kind === 'value-confirmed');
  assert.ok(confirmed.length > 0);
  for (const edge of confirmed) {
    assert.equal(edge.provenance, 'resolved', `${edge.from}->${edge.to} 只有 resolved 才可计覆盖`);
    assert.equal(UNCONFIRMABLE_LABELS.includes(edge.label ?? ''), false, `${edge.from}->${edge.to} 不可确认的边被判为 value-confirmed`);
  }

  const covered = testCoverage(snapshot, ['test/entry.test.ts']);
  // 只应覆盖测试自身与显式具名重导出的定义文件；wild/ns/dyn 目标都不算覆盖。
  assert.deepEqual([...covered].sort(), ['src/defs.ts', 'test/entry.test.ts']);

  const wildcardEdge = snapshot.edges.find((edge) => edge.from === 'test/entry.test.ts' && edge.to === 'src/wild.ts');
  assert.equal(wildcardEdge?.kind, 'unknown');
  assert.equal(wildcardEdge?.provenance, 'heuristic');
  assert.equal(wildcardEdge?.label, 'barrel_wildcard');
  const namespaceEdge = snapshot.edges.find((edge) => edge.from === 'test/entry.test.ts' && edge.to === 'src/ns.ts');
  assert.equal(namespaceEdge?.kind, 'unknown');
  assert.equal(namespaceEdge?.label, 'namespace_import');
  const dynamicLiteral = snapshot.edges.find((edge) => edge.from === 'test/entry.test.ts' && edge.to === 'src/dyn.ts');
  assert.equal(dynamicLiteral?.kind, 'unknown');
  assert.equal(dynamicLiteral?.provenance, 'heuristic');
});

test('impact is a superset: type-only, unknown, external and barrel edges all propagate', async () => {
  const root = await writeFixture({
    'src/wild.ts': 'export const w = 1;\n',
    'src/star.ts': "export * from './wild.js';\n",
    'src/type.ts': 'export interface T { x: number }\n',
    'src/external.ts': "import { z } from 'zod';\nexport const v = z;\n",
    'src/user.ts': "import type { T } from './type.js';\nimport { w } from './star.js';\nexport const u: T | number = w;\n",
    'src/top.ts': "import { v } from './external.js';\nimport { u } from './user.js';\nexport const all = [v, u];\n",
  });
  const snapshot = await snapshotOf(root);

  const external = impact(snapshot, ['zod']);
  assert.ok(external.includes('src/external.ts'), '外部依赖边必须参与 impact');
  assert.ok(external.includes('src/top.ts'));
  const typeOnly = impact(snapshot, ['src/type.ts']);
  assert.ok(typeOnly.includes('src/user.ts'), 'type-only 边必须参与 impact');
  const wildcard = impact(snapshot, ['src/wild.ts']);
  assert.ok(wildcard.includes('src/star.ts'), 'barrel 边必须参与 impact');
  assert.ok(wildcard.includes('src/user.ts'), '未知/通配 import 边必须参与 impact');
  assert.ok(wildcard.includes('src/top.ts'));
});

test('external imports and external re-exports stay visible as unknown edges', async () => {
  const root = await writeFixture({
    'src/a.ts': [
      "import { z } from 'zod';",
      "export * from 'lodash';",
      "export * as rx from 'rxjs';",
      "export { nope } from 'missing-pkg';",
      "import './gone.js';",
      'export const v = z;',
    ].join('\n'),
  });
  const snapshot = await snapshotOf(root);
  const edges = snapshot.edges.filter((edge) => edge.from === 'src/a.ts');
  const targets = new Set(edges.map((edge) => edge.to));
  for (const target of ['zod', 'lodash', 'rxjs', 'missing-pkg', './gone.js']) {
    assert.ok(targets.has(target), `${target} 被静默丢弃`);
  }
  assert.ok(edges.every((edge) => edge.kind === 'unknown'));
  assert.ok(snapshot.caveats.unknownRatio > 0);
});

test('package.json#imports aliases resolve end to end and unknown aliases stay visible', async () => {
  const root = await writeFixture({
    'package.json': JSON.stringify({ name: 'imports-redteam', imports: { '#api/*': './src/api/*.ts' } }, null, 2),
    'src/api/user.ts': 'export const user = 1;\n',
    'src/consumer.ts': "import { user } from '#api/user';\nimport { missing } from '#api/missing';\nexport const all = [user, missing];\n",
  });
  const snapshot = await snapshotOf(root);
  const resolved = snapshot.edges.find((edge) => edge.from === 'src/consumer.ts' && edge.to === 'src/api/user.ts');
  assert.equal(resolved?.kind, 'value-confirmed');
  assert.equal(resolved?.provenance, 'resolved');
  assert.deepEqual(resolved?.importedNames, ['user']);
  const unresolved = snapshot.edges.find((edge) => edge.from === 'src/consumer.ts' && edge.to === '#api/missing');
  assert.equal(unresolved?.kind, 'unknown');
  assert.equal(unresolved?.label, 'unresolved');
});

test('tsconfig/package.json changes make the graph stale even when no source file changed', async () => {
  const root = await writeFixture({
    'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.' } }, null, 2),
    'package.json': JSON.stringify({ name: 'freshness-redteam', private: true }, null, 2),
    'src/a.ts': 'export const a = 1;\n',
  });
  const snapshot = await snapshotOf(root);
  assert.equal((await checkGraphFreshness(root, snapshot)).freshness.status, 'fresh');

  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }, null, 2));
  const tsconfigCheck = await checkGraphFreshness(root, snapshot);
  assert.equal(tsconfigCheck.freshness.status, 'stale');

  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'freshness-redteam', private: true, type: 'module' }, null, 2));
  const packageCheck = await checkGraphFreshness(root, snapshot);
  assert.equal(packageCheck.freshness.status, 'stale');
});

test('a degraded scan retains old files instead of treating them as deleted', async () => {
  const root = await writeFixture({
    'src/a.ts': 'export const a = 1;\n',
    'src/nested/b.ts': 'export const b = 2;\n',
  });
  const firstFingerprint = await fingerprintTree(root, { onError: () => 'degrade' });
  const first = await buildSnapshot({ root, fingerprint: firstFingerprint });

  for (const degradedPath of ['src/nested', '.']) {
    const result = await buildSnapshot({
      root,
      fingerprint: {
        hash: `degraded:${degradedPath}`,
        files: degradedPath === '.' ? [] : firstFingerprint.files.filter((file) => !file.path.startsWith('src/nested/')),
        degraded: [{ path: degradedPath, code: 'EACCES' }],
      },
      previous: first.snapshot,
    });
    assert.deepEqual(Object.keys(result.snapshot.files).sort(), ['src/a.ts', 'src/nested/b.ts'], `${degradedPath} 降级时旧文件被当成删除`);
    assert.ok(result.report.retained >= 1);
    assert.equal(result.report.degraded, true);
    assert.ok(result.snapshot.caveats.degradedReasons.some((reason) => reason.includes('fingerprint-degraded')));
  }
});

test('exporting an import-type name forwards to the definition file and never counts as value coverage', async () => {
  const root = await writeFixture({
    'src/defs.ts': 'export interface Shape { x: number }\nexport const value = 1;\n',
    'src/forward.ts': "import type { Shape } from './defs.js';\nexport { Shape };\n",
    'test/shape.test.ts': "import { Shape } from '../src/forward.js';\nexport type Uses = Shape;\n",
  });
  const snapshot = await snapshotOf(root);
  const edge = snapshot.edges.find((candidate) => candidate.from === 'test/shape.test.ts' && candidate.importedNames.includes('Shape'));
  assert.equal(edge?.to, 'src/defs.ts', '应收敛到定义文件而不是转发文件');
  assert.equal(edge?.kind, 'type-only');
  assert.equal(edge?.provenance, 'resolved');
  assert.equal(snapshot.edges.some((candidate) => candidate.from === 'test/shape.test.ts' && candidate.to === 'src/forward.ts'), false);
  assert.equal(testCoverage(snapshot, ['test/shape.test.ts']).has('src/defs.ts'), false);
});

test('destructuring defaults are not exported symbols and cannot be imported', async () => {
  const root = await writeFixture({
    'src/destructure.ts': 'const source = { real: 1 };\nexport const { real = fallback } = source;\n',
    'src/consumer.ts': "import { real } from './destructure.js';\nimport { fallback } from './destructure.js';\nexport const all = [real, fallback];\n",
  });
  const snapshot = await snapshotOf(root);
  const names = snapshot.symbols.filter((symbol) => symbol.file === 'src/destructure.ts').map((symbol) => symbol.name);
  assert.ok(names.includes('real'));
  assert.equal(names.includes('fallback'), false, '默认值不是绑定，不能成为符号');
  const realEdge = snapshot.edges.find((edge) => edge.from === 'src/consumer.ts' && edge.to === 'src/destructure.ts' && edge.importedNames.includes('real'));
  assert.equal(realEdge?.kind, 'value-confirmed');
  const fallbackEdge = snapshot.edges.find((edge) => edge.from === 'src/consumer.ts' && edge.to === 'src/destructure.ts' && edge.importedNames.includes('fallback'));
  assert.equal(fallbackEdge?.kind, 'unknown');
});
