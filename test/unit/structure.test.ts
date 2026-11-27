import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fingerprintTree } from '../../src/core/fingerprint.ts';
import { resolveProjectScan } from '../../src/core/project-scan.ts';
import { GraphStore } from '../../src/structure/store.ts';
import { buildSnapshot, symbolId } from '../../src/structure/extractor.ts';
import { createTsExtractor, type ParsedFile } from '../../src/structure/extractors/ts.ts';
import { resolveExportedName } from '../../src/structure/barrel.ts';
import { resolveSpecifier, createResolutionContext, type ResolutionContext, type WorkspacePackage } from '../../src/structure/imports.ts';

async function writeFixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ano structure unit '));
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, ...path.split('/'));
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  return root;
}

function parsed(file: string, input: Partial<ParsedFile>): ParsedFile {
  return {
    file,
    definitions: [],
    namedExports: [],
    imports: [],
    dynamicLoads: 0,
    unresolvedDynamicLoads: 0,
    ...input,
  };
}

test('tree-sitter extractor records L1 definitions and merges interface+const as value', async () => {
  const extractor = await createTsExtractor();
  try {
    const result = extractor.parse('src/defs.ts', [
      'export interface Mixed { a: string }',
      'export const Mixed = 42;',
      'export type Alias = string;',
      'export const { first, second: renamed } = source;',
      'interface LocalOnly { b: number }',
    ].join('\n'));
    const mixed = result.definitions.find((definition) => definition.name === 'Mixed');
    assert.equal(mixed?.kind, 'value');
    assert.equal(mixed?.startLine, 1);
    assert.equal(result.definitions.find((definition) => definition.name === 'Alias')?.kind, 'type');
    assert.equal(result.definitions.find((definition) => definition.name === 'LocalOnly')?.kind, 'type');
    assert.ok(result.definitions.some((definition) => definition.name === 'first' && definition.kind === 'value'));
    assert.ok(result.definitions.some((definition) => definition.name === 'renamed' && definition.kind === 'value'));
    const exportNames = result.namedExports.map((entry) => entry.exportName);
    assert.deepEqual(exportNames.sort(), ['Alias', 'Mixed', 'first', 'renamed'].sort());
    assert.equal(result.namedExports.find((entry) => entry.exportName === 'Mixed')?.kind, 'value');
    assert.equal(result.namedExports.find((entry) => entry.exportName === 'Mixed')?.typeOnly, false);
  } finally {
    extractor.close();
  }
});

test('symbol identity excludes line numbers and distinguishes kind', async () => {
  const extractor = await createTsExtractor();
  try {
    const first = extractor.parse('src/a.ts', 'export const value = 1;\n');
    const shifted = extractor.parse('src/a.ts', '\n\n\nexport const value = 1;\n');
    const firstDefinition = first.definitions[0]!;
    const shiftedDefinition = shifted.definitions[0]!;
    assert.equal(firstDefinition.startLine, 1);
    assert.equal(shiftedDefinition.startLine, 4);
    assert.equal(
      symbolId('src/a.ts', firstDefinition.kind, firstDefinition.name, firstDefinition.qualifiedName),
      symbolId('src/a.ts', shiftedDefinition.kind, shiftedDefinition.name, shiftedDefinition.qualifiedName),
    );
    assert.notEqual(
      symbolId('src/a.ts', 'type', 'value', 'value'),
      symbolId('src/a.ts', 'value', 'value', 'value'),
    );
  } finally {
    extractor.close();
  }
});

test('extractor covers import forms and counts every dynamic load', async () => {
  const extractor = await createTsExtractor();
  try {
    const result = extractor.parse('src/forms.ts', [
      "import type Def from './def.js';",
      "import { type TypeOnly, value as localValue } from './mixed.js';",
      "import * as ns from './ns.js';",
      "import './side.js';",
      "const target = './dynamic.js';",
      'export async function load() { return import(target); }',
      "export function literal() { return import('./dynamic.js'); }",
      "export function cjs() { return require('./dynamic.js'); }",
      'export function broken() { return require(target); }',
    ].join('\n'));
    assert.equal(result.dynamicLoads, 4);
    assert.equal(result.unresolvedDynamicLoads, 2);
    const statementLevelType = result.imports.find((entry) => entry.specifier === './def.js');
    assert.equal(statementLevelType?.typeOnly, true);
    assert.deepEqual(statementLevelType?.importedNames, ['default']);
    const mixed = result.imports.find((entry) => entry.specifier === './mixed.js');
    assert.deepEqual(mixed?.importedNames, ['TypeOnly', 'value']);
    assert.deepEqual(mixed?.localNames, ['TypeOnly', 'localValue']);
    assert.deepEqual(mixed?.typeOnlyNames, ['TypeOnly']);
    assert.equal(mixed?.typeOnly, false);
    assert.deepEqual(result.imports.find((entry) => entry.specifier === './ns.js')?.importedNames, ['*']);
    assert.equal(result.imports.find((entry) => entry.specifier === './side.js')?.sideEffect, true);
    assert.equal(result.imports.filter((entry) => entry.dynamic).length, 2);
    assert.equal(result.imports.filter((entry) => entry.require).length, 2);
    assert.ok(result.imports.some((entry) => entry.dynamic && entry.specifier === undefined));
    assert.ok(result.imports.some((entry) => entry.require && entry.specifier === undefined));
  } finally {
    extractor.close();
  }
});

test('module resolution maps .js to .ts, expands indexes, aliases and workspaces', () => {
  const workspace: WorkspacePackage = {
    name: '@fixture/lib',
    dir: 'packages/lib',
    entries: { files: ['packages/lib/src/index.ts'], fallback: false },
    subpaths: new Map([['feature', { files: ['packages/lib/src/feature.ts'], fallback: false }]]),
  };
  const context: ResolutionContext = {
    root: '/project',
    files: new Set([
      'src/a.ts',
      'src/feature/index.ts',
      'src/defs.ts',
      'packages/lib/src/index.ts',
      'packages/lib/src/feature.ts',
    ]),
    aliases: [{ pattern: '@/*', targets: ['src/*'], baseUrl: '.' }],
    workspaces: [workspace],
    workspaceNames: new Set(['@fixture/lib']),
    imports: {},
  };
  assert.deepEqual(resolveSpecifier(context, 'src/user.ts', './a.js'), { status: 'resolved', path: 'src/a.ts' });
  assert.deepEqual(resolveSpecifier(context, 'src/user.ts', './feature'), { status: 'resolved', path: 'src/feature/index.ts' });
  assert.deepEqual(resolveSpecifier(context, 'src/user.ts', '@/defs'), { status: 'resolved', path: 'src/defs.ts' });
  assert.deepEqual(resolveSpecifier(context, 'src/user.ts', '@fixture/lib'), { status: 'resolved', path: 'packages/lib/src/index.ts' });
  assert.deepEqual(resolveSpecifier(context, 'src/user.ts', '@fixture/lib/feature'), { status: 'resolved', path: 'packages/lib/src/feature.ts' });
  assert.equal(resolveSpecifier(context, 'src/user.ts', 'node:fs').status, 'external');
  assert.equal(resolveSpecifier(context, 'src/user.ts', 'zod').status, 'external');
  assert.equal(resolveSpecifier(context, 'src/user.ts', './missing.js').status, 'unresolved');
});

test('barrel chains resolve explicit names to definitions, wildcards heuristically and cycles as depth limits', () => {
  const context: ResolutionContext = {
    root: '/project',
    files: new Set(['src/defs.ts', 'src/wild.ts', 'src/barrel.ts', 'src/ring-a.ts', 'src/ring-b.ts']),
    aliases: [],
    workspaces: [],
    workspaceNames: new Set(),
  imports: {},
  };
  const defs = parsed('src/defs.ts', {
    definitions: [
      { name: 'value', qualifiedName: 'value', kind: 'value', startLine: 1 },
      { name: 'Alias', qualifiedName: 'Alias', kind: 'type', startLine: 2 },
    ],
    namedExports: [
      { exportName: 'value', localName: 'value', kind: 'value', typeOnly: false },
      { exportName: 'Alias', localName: 'Alias', kind: 'type', typeOnly: true },
    ],
  });
  const wild = parsed('src/wild.ts', {
    definitions: [{ name: 'wildValue', qualifiedName: 'wildValue', kind: 'value', startLine: 1 }],
    namedExports: [{ exportName: 'wildValue', localName: 'wildValue', kind: 'value', typeOnly: false }],
  });
  const barrel = parsed('src/barrel.ts', {
    namedExports: [
      { exportName: 'value', kind: 'value', typeOnly: false, from: './defs.js', importedName: 'value' },
      { exportName: 'Alias', kind: 'type', typeOnly: true, from: './defs.js', importedName: 'Alias' },
      { exportName: '*', kind: 'value', typeOnly: false, from: './wild.js', wildcard: true },
    ],
  });
  const ringA = parsed('src/ring-a.ts', {
    namedExports: [{ exportName: '*', kind: 'value', typeOnly: false, from: './ring-b.js', wildcard: true }],
  });
  const ringB = parsed('src/ring-b.ts', {
    namedExports: [{ exportName: '*', kind: 'value', typeOnly: false, from: './ring-a.js', wildcard: true }],
  });
  const modules = new Map([defs, wild, barrel, ringA, ringB].map((module) => [module.file, module]));
  const named = resolveExportedName(modules, context, 'src/barrel.ts', 'value');
  assert.equal(named?.file, 'src/defs.ts');
  assert.equal(named?.kind, 'value');
  assert.equal(named?.provenance, 'resolved');
  const typeOnly = resolveExportedName(modules, context, 'src/barrel.ts', 'Alias');
  assert.equal(typeOnly?.file, 'src/defs.ts');
  assert.equal(typeOnly?.typeOnly, true);
  const wildcard = resolveExportedName(modules, context, 'src/barrel.ts', 'wildValue');
  assert.equal(wildcard?.file, 'src/wild.ts');
  assert.equal(wildcard?.provenance, 'heuristic');
  assert.equal(wildcard?.label, 'barrel_wildcard');
  const cycle = resolveExportedName(modules, context, 'src/ring-a.ts', 'neverDefined');
  assert.equal(cycle?.provenance, 'heuristic');
  assert.equal(cycle?.label, 'depth_limit');
  assert.equal(resolveExportedName(modules, context, 'src/barrel.ts', 'absent'), undefined);
});

test('barrel depth limits become heuristic depth_limit edges', () => {
  const count = 16;
  const fileNames = Array.from({ length: count }, (_, index) => `src/n${index}.ts`);
  const context: ResolutionContext = {
    root: '/project',
    files: new Set(fileNames),
    aliases: [],
    workspaces: [],
    workspaceNames: new Set(),
  imports: {},
  };
  const modules = new Map<string, ParsedFile>();
  for (let index = 0; index < count; index += 1) {
    const file = fileNames[index]!;
    if (index === count - 1) {
      modules.set(file, parsed(file, {
        definitions: [{ name: 'deepValue', qualifiedName: 'deepValue', kind: 'value', startLine: 1 }],
        namedExports: [{ exportName: 'deepValue', localName: 'deepValue', kind: 'value', typeOnly: false }],
      }));
      continue;
    }
    modules.set(file, parsed(file, {
      namedExports: [{ exportName: '*', kind: 'value', typeOnly: false, from: `./n${index + 1}.js`, wildcard: true }],
    }));
  }
  const resolution = resolveExportedName(modules, context, 'src/n0.ts', 'deepValue');
  assert.equal(resolution?.provenance, 'heuristic');
  assert.equal(resolution?.label, 'depth_limit');
});

test('read failure retains previous file data, degrades, and does not tombstone', async () => {
  const root = await writeFixture({
    'src/defs.ts': "import { z } from './z.js';\nexport const value = z;\n",
    'src/z.ts': 'export const z = 1;\n',
    'src/user.ts': "import { value } from './defs.js';\nexport const v = value;\n",
  });
  const firstFingerprint = await fingerprintTree(root, { onError: () => 'degrade' });
  const first = await buildSnapshot({ root, fingerprint: firstFingerprint });
  assert.equal(first.report.parsed, 3);
  assert.ok(first.snapshot.edges.some((edge) => edge.from === 'src/defs.ts' && edge.to === 'src/z.ts'));

  const secondFingerprint = await fingerprintTree(root, { onError: () => 'degrade' });
  const second = await buildSnapshot({
    root,
    fingerprint: secondFingerprint,
    previous: first.snapshot,
    readFile: async (path) => {
      if (path.endsWith('defs.ts')) {
        const error = Object.assign(new Error('access denied'), { code: 'EACCES' });
        throw error;
      }
      return readFile(path, 'utf8');
    },
  });
  assert.equal(second.report.mode, 'full');
  assert.equal(second.report.retained, 1);
  assert.equal(second.report.degraded, true);
  assert.deepEqual(Object.keys(second.snapshot.files).sort(), ['src/defs.ts', 'src/user.ts', 'src/z.ts']);
  assert.ok(second.snapshot.symbols.some((symbol) => symbol.file === 'src/defs.ts' && symbol.name === 'value'));
  assert.ok(second.snapshot.edges.some((edge) => edge.from === 'src/defs.ts' && edge.to === 'src/z.ts' && edge.kind === 'value-confirmed'));
  assert.ok(second.snapshot.caveats.degradedReasons.some((reason) => reason.includes('unreadable:src/defs.ts:EACCES')));
});

test('caveats report exact edge counts, heuristic edges, unknown ratio and dynamic loads', async () => {
  const root = await writeFixture({
    'src/defs.ts': 'export const value = 1;\nexport interface Shape { x: number }\n',
    'src/barrel.ts': "export { value } from './defs.js';\n",
    'src/wild.ts': 'export const wildValue = 2;\n',
    'src/star.ts': "export * from './wild.js';\n",
    'src/consumer.ts': [
      "import type { Shape } from './defs.js';",
      "import { value } from './barrel.js';",
      "import { wildValue } from './star.js';",
      "import './defs.js';",
      "import { absent } from './missing.js';",
      "const target = './wild.js';",
      'export const load = () => import(target);',
      "export const literal = () => import('./wild.js');",
    ].join('\n'),
  });
  const fingerprint = await fingerprintTree(root, { onError: () => 'degrade' });
  const result = await buildSnapshot({ root, fingerprint });
  const { caveats, edges } = result.snapshot;
  const counted = edges.reduce<Record<string, number>>((counts, edge) => {
    counts[edge.kind] = (counts[edge.kind] ?? 0) + 1;
    return counts;
  }, {});
  assert.equal(caveats.edgeCounts['value-confirmed'], counted['value-confirmed'] ?? 0);
  assert.equal(caveats.edgeCounts['type-only'], counted['type-only'] ?? 0);
  assert.equal(caveats.edgeCounts.unknown, counted.unknown ?? 0);
  assert.equal(caveats.heuristicEdges, edges.filter((edge) => edge.provenance === 'heuristic').length);
  assert.equal(caveats.unknownRatio, caveats.edgeCounts.unknown / edges.length);
  assert.equal(caveats.filesWithUnresolvableDynamicLoads, 1);
  assert.equal(caveats.dynamicLoadCount, 2);
  const wildcardEdge = edges.find((edge) => edge.from === 'src/consumer.ts' && edge.to === 'src/wild.ts' && edge.kind === 'unknown' && edge.label === 'barrel_wildcard');
  assert.ok(wildcardEdge);
  const sideEffect = edges.find((edge) => edge.from === 'src/consumer.ts' && edge.label === 'sideEffect');
  assert.deepEqual(sideEffect?.importedNames, []);
  assert.equal(sideEffect?.kind, 'value-confirmed');
  assert.ok(edges.some((edge) => edge.kind === 'unknown' && edge.label === 'dynamic_import' && edge.to === '<dynamic>'));
  assert.ok(edges.some((edge) => edge.kind === 'unknown' && edge.label === 'unresolved' && edge.to === './missing.js'));
});

test('destructuring defaults never become definitions or exports', async () => {
  const extractor = await createTsExtractor();
  try {
    const result = extractor.parse('src/destructure.ts', [
      'const { a = fallback } = source;',
      'const { b: { c = other } = inner } = source;',
      'const [d = e] = source;',
      'export const { f = fallback2 } = source;',
    ].join('\n'));
    assert.deepEqual(result.definitions.map((definition) => definition.name).sort(), ['a', 'c', 'd', 'f']);
    assert.deepEqual(result.namedExports.map((entry) => entry.exportName).sort(), ['f']);
    for (const leaked of ['fallback', 'other', 'inner', 'e', 'fallback2']) {
      assert.equal(result.definitions.some((definition) => definition.name === leaked), false, `${leaked} 是默认值，不是绑定`);
    }
  } finally {
    extractor.close();
  }
});

test('a non-exported same-name value does not upgrade a type-only export', async () => {
  const extractor = await createTsExtractor();
  try {
    const result = extractor.parse('src/mixed.ts', [
      'export interface Shape { x: number }',
      'const Shape = 1;',
      'export const value = Shape;',
    ].join('\n'));
    const shapeExport = result.namedExports.find((entry) => entry.exportName === 'Shape');
    assert.equal(shapeExport?.kind, 'type');
    assert.equal(shapeExport?.typeOnly, true);
    // 符号本身按 value 合并（有值声明），但导出表保留每个声明自己的语义。
    assert.equal(result.definitions.find((definition) => definition.name === 'Shape')?.kind, 'value');
  } finally {
    extractor.close();
  }
});

test('export of a type-only imported name forwards to the definition file as type-only', async () => {
  const root = await writeFixture({
    'src/defs.ts': 'export interface Shape { x: number }\nexport const value = 1;\n',
    'src/forward.ts': "import type { Shape } from './defs.js';\nexport { Shape };\n",
    'src/value-forward.ts': "import { value } from './defs.js';\nexport { value };\n",
    'src/user.ts': "import { Shape } from './forward.js';\nimport { value } from './value-forward.js';\nexport type S = Shape;\nexport const v = value;\n",
  });
  const fingerprint = await fingerprintTree(root, { onError: () => 'degrade' });
  const { snapshot } = await buildSnapshot({ root, fingerprint });
  const shapeEdges = snapshot.edges.filter((edge) => edge.from === 'src/forward.ts' && edge.importedNames.includes('Shape'));
  assert.equal(shapeEdges.length, 1);
  assert.equal(shapeEdges[0]?.to, 'src/defs.ts');
  assert.equal(shapeEdges[0]?.kind, 'type-only');
  const userShape = snapshot.edges.filter((edge) => edge.from === 'src/user.ts' && edge.importedNames.includes('Shape'));
  assert.equal(userShape.length, 1);
  assert.equal(userShape[0]?.to, 'src/defs.ts');
  assert.equal(userShape[0]?.kind, 'type-only');
  assert.equal(snapshot.edges.some((edge) => edge.from === 'src/user.ts' && edge.to === 'src/forward.ts'), false);
  // 值导入经同文件再导出仍按 value 穿透到定义文件。
  const userValue = snapshot.edges.filter((edge) => edge.from === 'src/user.ts' && edge.importedNames.includes('value'));
  assert.equal(userValue.length, 1);
  assert.equal(userValue[0]?.to, 'src/defs.ts');
  assert.equal(userValue[0]?.kind, 'value-confirmed');
});

test('degraded directories retain previous files and root degradation retains the whole graph', async () => {
  const root = await writeFixture({
    'src/a.ts': 'export const a = 1;\n',
    'src/b.ts': 'export const b = 2;\n',
    'src/nested/c.ts': 'export const c = 3;\n',
  });
  const firstFingerprint = await fingerprintTree(root, { onError: () => 'degrade' });
  const first = await buildSnapshot({ root, fingerprint: firstFingerprint });
  assert.deepEqual(Object.keys(first.snapshot.files).sort(), ['src/a.ts', 'src/b.ts', 'src/nested/c.ts']);

  const subtree = await buildSnapshot({
    root,
    fingerprint: {
      hash: firstFingerprint.hash,
      files: firstFingerprint.files.filter((file) => !file.path.startsWith('src/nested/')),
      degraded: [{ path: 'src/nested', code: 'EACCES' }],
    },
    previous: first.snapshot,
  });
  assert.deepEqual(Object.keys(subtree.snapshot.files).sort(), ['src/a.ts', 'src/b.ts', 'src/nested/c.ts']);
  assert.equal(subtree.report.retained, 1);
  assert.ok(subtree.snapshot.symbols.some((symbol) => symbol.file === 'src/nested/c.ts'));

  const wholeTree = await buildSnapshot({
    root,
    fingerprint: { hash: 'root-degraded', files: [], degraded: [{ path: '.', code: 'EACCES' }] },
    previous: first.snapshot,
  });
  assert.deepEqual(Object.keys(wholeTree.snapshot.files).sort(), ['src/a.ts', 'src/b.ts', 'src/nested/c.ts']);
  assert.equal(wholeTree.report.retained, 3);
  assert.ok(wholeTree.snapshot.caveats.degradedReasons.some((reason) => reason.includes('fingerprint-degraded:.')));
});

test('only an explicit ENOENT is treated as deletion; other read errors retain old data', async () => {
  const root = await writeFixture({
    'src/defs.ts': "import { z } from './z.js';\nexport const value = z;\n",
    'src/z.ts': 'export const z = 1;\n',
    'src/user.ts': "import { value } from './defs.js';\nexport const v = value;\n",
  });
  const firstFingerprint = await fingerprintTree(root, { onError: () => 'degrade' });
  const first = await buildSnapshot({ root, fingerprint: firstFingerprint });

  const second = await buildSnapshot({
    root,
    fingerprint: firstFingerprint,
    previous: first.snapshot,
    readFile: async (path) => {
      if (path.endsWith('z.ts')) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      if (path.endsWith('defs.ts')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return readFile(path, 'utf8');
    },
  });
  assert.deepEqual(Object.keys(second.snapshot.files).sort(), ['src/defs.ts', 'src/user.ts']);
  assert.equal(second.report.retained, 1);
  assert.equal(second.snapshot.symbols.some((symbol) => symbol.file === 'src/z.ts'), false);
  assert.equal(second.snapshot.caveats.degradedReasons.some((reason) => reason.includes('z.ts')), false);
  assert.ok(second.snapshot.caveats.degradedReasons.some((reason) => reason.includes('unreadable:src/defs.ts:EACCES')));
});

test('package.json#imports resolves exact aliases, wildcard aliases and rejects unknown ones', async () => {
  const root = await writeFixture({
    'package.json': JSON.stringify({
      name: 'imports-fixture',
      imports: {
        '#fixed': './src/defs.ts',
        '#self/*': './src/self/*.ts',
        '#conditional': { import: './src/cond.ts', default: './src/cond.ts' },
        '#external': 'zod',
      },
    }),
    'src/defs.ts': 'export const value = 1;\n',
    'src/self/util.ts': 'export const util = 2;\n',
    'src/cond.ts': 'export const cond = 3;\n',
  });
  const context = await createResolutionContext(root, ['src/defs.ts', 'src/self/util.ts', 'src/cond.ts']);
  assert.deepEqual(resolveSpecifier(context, 'src/user.ts', '#fixed'), { status: 'resolved', path: 'src/defs.ts' });
  assert.deepEqual(resolveSpecifier(context, 'src/user.ts', '#self/util'), { status: 'resolved', path: 'src/self/util.ts' });
  assert.deepEqual(resolveSpecifier(context, 'src/user.ts', '#conditional'), { status: 'resolved', path: 'src/cond.ts' });
  assert.equal(resolveSpecifier(context, 'src/user.ts', '#missing').status, 'unresolved');
  // 指向外部包的 #imports 目前不展开，必须显式 unresolved，而不是静默成功。
  assert.equal(resolveSpecifier(context, 'src/user.ts', '#external').status, 'unresolved');
});

test('namespace imports are visible unknown edges and never value-confirmed', async () => {
  const root = await writeFixture({
    'src/defs.ts': 'export const a = 1;\nexport const b = 2;\n',
    'src/consumer.ts': "import * as ns from './defs.js';\nexport const both = [ns.a, ns.b];\n",
  });
  const { snapshot } = await buildSnapshot({ root, fingerprint: await fingerprintTree(root, { onError: () => 'degrade' }) });
  const edge = snapshot.edges.find((candidate) => candidate.from === 'src/consumer.ts' && candidate.to === 'src/defs.ts');
  assert.equal(edge?.kind, 'unknown');
  assert.equal(edge?.label, 'namespace_import');
  assert.equal(snapshot.edges.some((candidate) => candidate.to === 'src/defs.ts' && candidate.kind === 'value-confirmed'), false);
});


// ============================================================================
// ADR-009 / T-106: unified scan options, cache reuse and timeout degradation.
// ============================================================================

async function writeScanFixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ano structure scan '));
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, ...path.split('/'));
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  return root;
}

const SCAN_FIXTURE = {
  '.git/HEAD': 'ref: refs/heads/main\n',
  '.pm/project.json': JSON.stringify({ name: 'scan-fixture', scan_ignore: ['src/generated/**'] }),
  'package.json': JSON.stringify({ name: 'scan-fixture', private: true }),
  'src/keep.ts': 'export const keep = 1;\n',
  'src/generated/skip.ts': 'export const skip = 2;\n',
};

test('GraphStore build and freshness share the resolved scan exclusion set', async () => {
  const root = await writeScanFixture(SCAN_FIXTURE);
  const scan = await resolveProjectScan({ startRoot: root });
  assert.equal(scan.excludes('src/generated/skip.ts'), true);
  assert.equal(scan.excludes('src/keep.ts'), false);

  const store = await GraphStore.open(root, { scan });
  await store.build();
  assert.deepEqual(store.filesList(), ['src/keep.ts']);
  assert.ok(store.snapshot().symbols.some((symbol) => symbol.file === 'src/keep.ts' && symbol.name === 'keep'));
  store.close();

  const reopened = await GraphStore.open(root, { scan });
  assert.equal(reopened.freshness().status, 'fresh');
  // The excluded file is not part of the fingerprint, so changing it is a no-op.
  await writeFile(join(root, 'src', 'generated', 'skip.ts'), 'export const skip = 3;\n');
  const fresh = await reopened.checkFreshness();
  assert.equal(fresh.status, 'fresh');
  reopened.close();
});

test('a valid graph cache is reused without re-reading source files', async () => {
  const root = await writeScanFixture(SCAN_FIXTURE);
  const scan = await resolveProjectScan({ startRoot: root });
  const first = await GraphStore.open(root, { scan });
  await first.build();
  const revision = first.revision;
  first.close();

  let reads = 0;
  const second = await GraphStore.open(root, {
    scan,
    readFile: async (path) => {
      reads += 1;
      return readFile(path, 'utf8');
    },
  });
  const outcome = await second.ensureFresh();
  assert.equal(outcome.cache, 'hit');
  assert.equal(outcome.status, 'ok');
  assert.equal(reads, 0, 'a cache hit must not traverse file contents');
  assert.equal(second.revision, revision);
  second.close();
});

test('a source change invalidates the cache and is reported instead of rebuilt', async () => {
  const root = await writeScanFixture(SCAN_FIXTURE);
  const scan = await resolveProjectScan({ startRoot: root });
  const first = await GraphStore.open(root, { scan });
  await first.build();
  const revision = first.revision;
  first.close();

  await writeFile(join(root, 'src', 'keep.ts'), 'export const keep = 2;\n');
  let reads = 0;
  const second = await GraphStore.open(root, {
    scan,
    readFile: async (path) => {
      reads += 1;
      return readFile(path, 'utf8');
    },
  });
  assert.equal(second.freshness().status, 'stale');
  const outcome = await second.ensureFresh();
  assert.equal(outcome.cache, 'miss');
  assert.equal(outcome.stale, true);
  assert.equal(reads, 0, 'a stale cache is reported, not silently rebuilt into fresh evidence');
  assert.equal(second.revision, revision, 'the persisted snapshot is retained until an explicit build');
  await second.build();
  assert.ok(reads > 0);
  assert.notEqual(second.revision, revision);
  second.close();
});

test('content changed with size and mtime preserved is not reported fresh', async () => {
  const root = await writeScanFixture(SCAN_FIXTURE);
  const scan = await resolveProjectScan({ startRoot: root });
  // Pin mtime to an exact millisecond so utimes can restore it bit-for-bit;
  // otherwise the sub-millisecond part alone would already break the match.
  const target = join(root, 'src', 'keep.ts');
  const pinnedMtime = new Date(1_700_000_000_000);
  await utimes(target, pinnedMtime, pinnedMtime);
  const before = await stat(target);
  assert.equal(before.mtimeMs, pinnedMtime.getTime());

  const first = await GraphStore.open(root, { scan });
  await first.build();
  first.close();

  // Same byte count, different content, mtime restored: size+mtime are intact.
  await writeFile(target, 'export const keep = 2;\n');
  await utimes(target, pinnedMtime, pinnedMtime);
  const after = await stat(target);
  assert.equal(after.size, before.size, 'the rewrite keeps the byte count');
  assert.equal(after.mtimeMs, before.mtimeMs, 'the rewrite restores mtime exactly');

  const reopened = await GraphStore.open(root, { scan });
  assert.equal(reopened.freshness().status, 'stale', 'a preserved size/mtime must not prove fresh');
  const check = await reopened.checkFreshness();
  assert.notEqual(check.status, 'fresh', 'a content change must not be hidden as fresh');
  assert.equal(check.status, 'stale');
  reopened.close();
});

test('a scan configuration change invalidates a valid source cache', async () => {
  const root = await writeScanFixture(SCAN_FIXTURE);
  const scan = await resolveProjectScan({ startRoot: root });
  const first = await GraphStore.open(root, { scan });
  await first.build();
  first.close();

  await writeFile(join(root, '.pm', 'project.json'), JSON.stringify({ name: 'scan-fixture', scan_ignore: ['src/generated/**', 'src/keep.ts'] }));
  const nextScan = await resolveProjectScan({ startRoot: root });
  const second = await GraphStore.open(root, { scan: nextScan });
  assert.equal(second.freshness().status, 'stale');
  const outcome = await second.ensureFresh();
  assert.equal(outcome.cache, 'miss');
  assert.deepEqual(second.filesList(), [], 'the new exclusion set is applied on rebuild');
  assert.equal(outcome.status, 'degraded');
  second.close();
});

test('a build timeout retains the previous snapshot and reports timeout/stale', async () => {
  const root = await writeScanFixture(SCAN_FIXTURE);
  const scan = await resolveProjectScan({ startRoot: root });
  const first = await GraphStore.open(root, { scan });
  await first.build();
  const revision = first.revision;
  first.close();

  const timedScan = await resolveProjectScan({ startRoot: root, timeoutMs: 0 });
  const store = await GraphStore.open(root, { scan: timedScan, rebuild: true });
  await store.build();
  const outcome = store.buildOutcome!;
  assert.equal(outcome.status, 'timeout');
  assert.equal(outcome.partial, true);
  assert.equal(outcome.stale, true);
  assert.equal(outcome.files, 1);
  assert.ok(outcome.completed !== undefined);
  assert.ok(outcome.budget !== undefined);
  assert.equal(store.revision, revision, 'the old snapshot is retained, not replaced by an empty one');
  assert.deepEqual(store.filesList(), ['src/keep.ts']);
  assert.equal(store.freshness().status, 'stale');
  store.close();
});

test('an empty scan is degraded and never reports ok', async () => {
  const root = await writeScanFixture({
    '.git/HEAD': 'ref: refs/heads/main\n',
    '.pm/project.json': JSON.stringify({ name: 'empty-scan', scan_ignore: ['**/*'] }),
    'package.json': JSON.stringify({ name: 'empty-scan' }),
  });
  const scan = await resolveProjectScan({ startRoot: root });
  const store = await GraphStore.open(root, { scan });
  await store.build();
  const outcome = store.buildOutcome!;
  assert.equal(outcome.files, 0);
  assert.equal(outcome.status, 'degraded');
  assert.notEqual(outcome.status, 'ok');
  assert.equal(store.freshness().status, 'degraded');
  store.close();
});

test('multiple source roots are combined while non-packages stay outside the graph', async () => {
  const root = await writeScanFixture({
    '.git/HEAD': 'ref: refs/heads/main\n',
    '.pm/project.json': JSON.stringify({ name: 'monorepo' }),
    'server/package.json': JSON.stringify({ name: 'server' }),
    'server/src/a.ts': 'export const a = 1;\n',
    'client/package.json': JSON.stringify({ name: 'client' }),
    'client/src/b.ts': 'export const b = 2;\n',
    'other/src/c.ts': 'export const c = 3;\n',
  });
  const scan = await resolveProjectScan({ startRoot: root });
  assert.deepEqual(scan.sourceRoots, [join(root, 'client'), join(root, 'server')]);
  const store = await GraphStore.open(root, { scan });
  await store.build();
  const files = store.filesList();
  assert.ok(files.includes('server/src/a.ts'));
  assert.ok(files.includes('client/src/b.ts'));
  assert.equal(files.some((file) => file.startsWith('other/')), false);
  assert.ok(store.snapshot().symbols.length > 0);
  store.close();
});

test('GraphStore accepts raw ProjectScanOptions as well as a resolved scan', async () => {
  const root = await writeScanFixture({
    '.git/HEAD': 'ref: refs/heads/main\n',
    '.pm/project.json': JSON.stringify({ name: 'raw-scan' }),
    'package.json': JSON.stringify({ name: 'raw-scan', private: true }),
    'src/keep.ts': 'export const keep = 1;\n',
    'src/generated/skip.ts': 'export const skip = 2;\n',
  });
  const store = await GraphStore.open(root, { scan: { startRoot: root, exclude: ['src/generated/**'] } });
  await store.build();
  assert.deepEqual(store.filesList(), ['src/keep.ts']);
  store.close();
});

// ============================================================================
// ADR-010 §7.2 / T-115: IIFE and nested-scope extraction
// ============================================================================

test('every IIFE form yields scope-qualified locals without leaking exports', async () => {
  const extractor = await createTsExtractor();
  try {
    const forms: Array<[string, string]> = [
      ['(function () { function alpha() {} const beta = () => alpha(); return beta; })();', 'alpha'],
      ['(function () { var gamma = function () {}; return gamma; }());', 'gamma'],
      ['(() => { const delta = () => 1; return delta; })();', 'delta'],
      ['(async function () { const epsilon = async () => 1; return epsilon; })();', 'epsilon'],
      ['!function () { const zeta = 2; }();', 'zeta'],
      ['+function () { const eta = 3; }();', 'eta'],
      ['void function () { const theta = 4; }();', 'theta'],
      ['(function namedIIFE() { const iota = 5; return iota; })();', 'iota'],
    ];
    for (const [source, name] of forms) {
      const result = extractor.parse('src/iife.js', source);
      const definition = result.definitions.find((candidate) => candidate.name === name);
      assert.ok(definition, `${name} must be extracted from ${source}`);
      assert.equal(definition.qualifiedName, `src/iife.js#<iife>.${name}`, 'locals keep their scope path');
      assert.equal(definition.kind, 'value');
      // Local declarations never enter the ESM export table.
      assert.equal(result.namedExports.length, 0, `${source} must not export locals`);
    }
  } finally {
    extractor.close();
  }
});

test('IIFE locals, object members and internal require are captured and stay non-export', async () => {
  const extractor = await createTsExtractor();
  try {
    const result = extractor.parse('workbench/app.js', [
      '(function () {',
      "  const fs = require('fs');",
      '  function helper(x) { return x + 1; }',
      '  const local = function (y) { return helper(y); };',
      '  const arrow = (z) => local(z);',
      '  const api = { run: function () { return arrow(1); }, note: "n" };',
      '  module.exports = { run: function () { return api.run(); } };',
      '})();',
      '',
    ].join('\n'));

    const qualified = (name: string): string => `workbench/app.js#<iife>.${name}`;
    for (const name of ['fs', 'helper', 'local', 'arrow', 'api']) {
      assert.equal(result.definitions.find((definition) => definition.name === name)?.qualifiedName, qualified(name));
    }
    // Object-literal members are queryable under the binding's scope path.
    assert.equal(result.members?.find((member) => member.name === 'run')?.qualifiedName, qualified('api.run'));
    assert.equal(result.members?.find((member) => member.name === 'note')?.qualifiedName, qualified('api.note'));
    // The internal require stays an import edge source.
    assert.ok(result.imports.some((entry) => entry.require && entry.specifier === 'fs' && entry.literal));
    // Calls carry the scope-qualified caller so L2 resolution can tie them.
    assert.equal(
      result.calls?.find((call) => call.callee === 'helper')?.callerQualifiedName,
      qualified('local'),
    );
    // Only real module.exports assignments become export/member symbols.
    assert.equal(result.commonjsExports?.find((item) => item.qualifiedName === 'workbench/app.js#default')?.role, 'export');
    assert.equal(result.commonjsExports?.find((item) => item.qualifiedName === 'workbench/app.js#default.run')?.role, 'member');
    assert.equal(result.namedExports.length, 0);
    assert.equal(result.scope?.iifeCount, 1);
    assert.equal(result.scope?.zeroDeclaration, false);
    assert.equal(result.scope?.zeroStaticDependency, false);
  } finally {
    extractor.close();
  }
});

test('nested IIFE scope names are stable across parses and content-hash replays', async () => {
  const root = await writeFixture({
    'src/helper.ts': 'export function helper(): number { return 1; }\n',
    'workbench/app.js': [
      "import { helper } from '../src/helper.js';",
      '(function () {',
      '  function outer() {',
      '    function inner() { return helper(); }',
      '    return inner;',
      '  }',
      '  function localHelper() { return outer(); }',
      '  const run = () => localHelper();',
      '  module.exports = { run: function () { return run(); } };',
      '})();',
      '',
    ].join('\n'),
  });
  const fingerprint = await fingerprintTree(root, { onError: () => 'degrade' });
  const first = await buildSnapshot({ root, fingerprint });
  const replayed = await buildSnapshot({ root, fingerprint, previous: first.snapshot, parsedCache: first.parsedFiles });
  assert.equal(replayed.report.reused, 2);
  assert.equal(replayed.snapshot.revision, first.snapshot.revision);
  assert.deepEqual(replayed.snapshot.symbols, first.snapshot.symbols);

  const scoped = (name: string): string => `workbench/app.js#<iife>.${name}`;
  const qualifiedNames = first.snapshot.symbols.filter((symbol) => symbol.file === 'workbench/app.js').map((symbol) => symbol.qualifiedName);
  for (const name of ['outer', 'outer.inner', 'localHelper', 'run']) {
    assert.ok(qualifiedNames.includes(scoped(name)), `${scoped(name)} must survive the replay`);
  }
  // The local `outer`/`inner` helpers are plain symbols, never exports.
  const localSymbols = first.snapshot.symbols.filter((symbol) => symbol.file === 'workbench/app.js' && ['outer', 'inner', 'localHelper'].includes(symbol.name));
  assert.ok(localSymbols.length >= 3);
  assert.equal(localSymbols.every((symbol) => symbol.role === undefined), true);
});

test('zero-declaration and zero-static-dependency are reported as distinct signals', async () => {
  const root = await writeFixture({
    'src/empty.js': "console.log('nothing');\n",
    'src/isolated.js': 'function isolated() { return 1; }\n',
    'src/x.js': 'export const x = 1;\n',
    'src/wired.js': "import { x } from './x.js';\nexport const w = x;\n",
  });
  const fingerprint = await fingerprintTree(root, { onError: () => 'degrade' });
  const { report, parsedFiles } = await buildSnapshot({ root, fingerprint });
  const emptyScope = parsedFiles['src/empty.js']?.parsed.scope;
  const isolatedScope = parsedFiles['src/isolated.js']?.parsed.scope;
  assert.equal(emptyScope?.zeroDeclaration, true, 'a file with no declaration at any level is zero-declaration');
  assert.equal(emptyScope?.zeroStaticDependency, false, 'zero-declaration is not reported as zero-dependency');
  assert.equal(isolatedScope?.zeroDeclaration, false, 'a file with a declaration is not zero-declaration');
  assert.equal(isolatedScope?.zeroStaticDependency, true, 'declarations with no import/require/local call are zero-dependency');
  assert.equal(report.zeroDeclarationFiles, 1);
  assert.equal(report.zeroStaticDependencyFiles, 2, 'isolated.js and x.js both have declarations but no dependency');
});

test('uncapturable nested semantics become located unknown gaps, never invented edges', async () => {
  const root = await writeFixture({
    'src/dynamic.js': [
      '(function () {',
      "  const key = 'x';",
      '  const obj = { x: 1 };',
      '  const value = obj[key];',
      '  eval(value);',
      '  obj[key]();',
      '  missingFn();',
      '})();',
      '',
    ].join('\n'),
  });
  const fingerprint = await fingerprintTree(root, { onError: () => 'degrade' });
  const { snapshot, parsedFiles } = await buildSnapshot({ root, fingerprint });
  const gaps = parsedFiles['src/dynamic.js']?.parsed.scope?.semanticGaps ?? [];
  const patterns = new Set(gaps.map((gap) => gap.pattern));
  for (const pattern of ['dynamic-property', 'eval', 'computed-member', 'unresolved-identifier'] as const) {
    assert.ok(patterns.has(pattern), `${pattern} must be recorded as unknown evidence`);
  }
  assert.ok(gaps.every((gap) => gap.line > 0 && gap.reason.length > 0));
  // Nothing is guessed: no symbol or resolved call edge exists for the uncapturable target.
  assert.equal(snapshot.symbols.some((symbol) => symbol.file === 'src/dynamic.js' && symbol.name === 'missingFn'), false);
  assert.equal(snapshot.calls?.some((call) => call.from === 'src/dynamic.js' && call.callee === 'missingFn'), false);
});

test('multiple IIFEs use ordered scope names, block scopes recurse, and depth stays bounded', async () => {
  const extractor = await createTsExtractor();
  try {
    const multi = extractor.parse('src/multi.js', [
      '(function () { function first() {} })();',
      '(function () { if (true) { const inBlock = () => first; } function second() {} })();',
      '',
    ].join('\n'));
    assert.equal(multi.definitions.find((definition) => definition.name === 'first')?.qualifiedName, 'src/multi.js#<iife>.first');
    assert.equal(multi.definitions.find((definition) => definition.name === 'second')?.qualifiedName, 'src/multi.js#<iife2>.second');
    assert.equal(multi.definitions.find((definition) => definition.name === 'inBlock')?.qualifiedName, 'src/multi.js#<iife2>.inBlock');
    assert.equal(multi.scope?.iifeCount, 2);

    // 40 nested function scopes exceed the bound: extraction stops with a
    // located depth-limit gap instead of recursing without end.
    const depth = 40;
    const lines = ['(function () {'];
    for (let index = 0; index < depth; index += 1) lines.push(`${'  '.repeat(index + 1)}function level${index}() {`);
    lines.push(`${'  '.repeat(depth + 1)}return level${depth - 1};`);
    for (let index = depth - 1; index >= 0; index -= 1) lines.push(`${'  '.repeat(index + 1)}}`);
    lines.push('})();');
    const nested = extractor.parse('src/deep.js', `${lines.join('\n')}\n`);
    assert.ok(nested.definitions.some((definition) => definition.name === 'level0'));
    assert.ok(nested.definitions.some((definition) => definition.name === 'level16'));
    assert.equal(nested.definitions.some((definition) => definition.name === 'level39'), false);
    assert.ok(nested.scope?.semanticGaps.some((gap) => gap.pattern === 'depth-limit'));
  } finally {
    extractor.close();
  }
});
