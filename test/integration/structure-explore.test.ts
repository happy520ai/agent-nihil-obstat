import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { GraphStore } from '../../src/structure/store.ts';
import { explore, exploreFlow, exploreImpact, exploreOutline, exploreSearch, exploreSymbol, searchSymbols } from '../../src/structure/explore.ts';
import { analyzeStructure } from '../../src/structure/analysis.ts';
import { t2Coverage } from '../../src/structure/t2.ts';

const FIXTURE: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'p3-explore-fixture', private: true }, null, 2),
  'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }, null, 2),
  'src/math.ts': [
    'export interface Shape { x: number }',
    'export function add(a: number, b: number): number { return a + b; }',
    'export const double = (n: number): number => add(n, n);',
    'export class Calculator {',
    '  base = 2;',
    '  run(n: number): number { return this.scale(n); }',
    '  runInline = (): number => this.scale(3);',
    '  scale(n: number): number { return n * this.base; }',
    '}',
    'export const sharedCalculator = new Calculator();',
    '',
  ].join('\n'),
  'src/helpers.ts': [
    'export function helper(): number { return 1; }',
    '',
  ].join('\n'),
  'src/leaf.ts': [
    'export function leaf(): number { return 42; }',
    '',
  ].join('\n'),
  'src/types.ts': [
    'export interface OnlyType { value: string }',
    '',
  ].join('\n'),
  'src/entry.ts': [
    "import { double, Calculator } from './math.js';",
    "import * as math from './math.js';",
    "import { helper } from './helpers.js';",
    "import { leaf } from './leaf.js';",
    'export function entryWork(n: number): number {',
    '  if (n < 0) console.log(n);',
    '  const calculator = new Calculator();',
    '  return double(n) + calculator.run(n) + calculator.runInline() + helper() + math.add(n, 1) + leaf();',
    '}',
    'export class Service {',
    '  run(): number { return entryWork(2); }',
    '}',
    '',
  ].join('\n'),
  'test/entry.test.ts': [
    "import { entryWork } from '../src/entry.js';",
    'export function testRoot(): number { return entryWork(1); }',
    '',
  ].join('\n'),
};

async function createFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ano p3 explore '));
  for (const [path, content] of Object.entries(FIXTURE)) {
    const absolute = join(root, ...path.split('/'));
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  return root;
}

test('real fixture: L2 resolves local/imported/method calls and keeps type symbols type-only', async () => {
  const root = await createFixture();
  const store = await GraphStore.open(root);
  await store.build();
  const snapshot = store.snapshot();
  const calls = snapshot.calls ?? [];
  assert.ok(calls.length > 0, 'L2 call edges must be emitted');

  const find = (from: string, callee: string, to?: string) => calls.find((edge) => edge.from === from && edge.callee === callee && (to === undefined || edge.to === to));
  const entryToDouble = find('src/entry.ts', 'double', 'src/math.ts');
  assert.equal(entryToDouble?.provenance, 'resolved');
  assert.equal(entryToDouble?.label, 'imported');
  assert.ok(entryToDouble?.callerSymbolId, 'caller should be tied to entryWork');
  assert.ok(entryToDouble?.calleeSymbolId, 'imported callee should have a symbol id');

  const doubleToAdd = find('src/math.ts', 'add', 'src/math.ts');
  assert.equal(doubleToAdd?.provenance, 'resolved');
  assert.equal(doubleToAdd?.label, 'local');

  const runToScale = find('src/math.ts', 'scale', 'src/math.ts');
  assert.equal(runToScale?.provenance, 'resolved');
  assert.equal(runToScale?.label, 'this');

  const entryToCalculator = find('src/entry.ts', 'Calculator', 'src/math.ts');
  assert.equal(entryToCalculator?.provenance, 'resolved');
  assert.equal(entryToCalculator?.label, 'imported', 'new Calculator() resolves through the explicit import');

  const entryToNamespaceAdd = calls.find((edge) => edge.from === 'src/entry.ts' && edge.callee === 'add' && edge.label === 'namespace' && edge.to === 'src/math.ts');
  assert.equal(entryToNamespaceAdd?.provenance, 'resolved');

  const entryToInline = find('src/entry.ts', 'runInline', 'src/math.ts');
  assert.equal(entryToInline?.provenance, 'resolved');
  assert.equal(entryToInline?.label, 'instance');
  assert.equal(entryToInline?.calleeQualifiedName, 'Calculator.runInline');

  const testRootToEntry = find('test/entry.test.ts', 'entryWork', 'src/entry.ts');
  assert.equal(testRootToEntry?.provenance, 'resolved');

  // An interface is not a callable value: no call edge may point at Shape.
  const shape = snapshot.symbols.find((symbol) => symbol.file === 'src/math.ts' && symbol.name === 'Shape');
  assert.ok(shape);
  assert.equal(calls.some((edge) => edge.calleeSymbolId === shape.id || edge.callee === 'Shape'), false, 'type must never become a value call');

  // T1 import edge stays value-confirmed separately from L2 calls.
  const importEdge = snapshot.edges.find((edge) => edge.from === 'src/entry.ts' && edge.to === 'src/math.ts' && edge.kind === 'value-confirmed');
  assert.ok(importEdge);
  assert.equal(importEdge?.provenance, 'resolved');

  // Methods are symbols with stable qualified names, not exported values.
  assert.ok(snapshot.symbols.some((symbol) => symbol.qualifiedName === 'Calculator.run'));
  assert.ok(snapshot.symbols.some((symbol) => symbol.qualifiedName === 'Calculator.scale'));
  assert.equal(snapshot.symbols.some((symbol) => symbol.qualifiedName === 'Shape' && symbol.symbolKind === 'type'), true);

  const caveats = snapshot.caveats;
  assert.equal(caveats.callEdges, calls.length);
  assert.equal(caveats.resolvedCallEdges, calls.filter((edge) => edge.provenance === 'resolved').length);
  assert.equal(caveats.heuristicCallEdges, calls.filter((edge) => edge.provenance === 'heuristic').length);
  assert.ok((caveats.unresolvedCallSites ?? 0) > 0, 'global calls such as console.* are reported as unresolved, not invented');
  store.close();
});

test('T2 uses only resolved call edges and never T1 import reachability', async () => {
  const root = await createFixture();
  const store = await GraphStore.open(root);
  await store.build();
  const snapshot = store.snapshot();

  const leafReport = t2Coverage(snapshot, ['test/entry.test.ts'], ['src/leaf.ts']);
  assert.equal(leafReport.applicable, true);
  assert.equal(leafReport.satisfied, true);
  assert.deepEqual(leafReport.uncoveredSymbols, []);
  assert.equal(leafReport.edgesUsed, 'resolved-call-edges');
  assert.ok(leafReport.coveredFiles.includes('src/leaf.ts'));

  // src/math.ts also exports sharedCalculator, which no executed test calls.
  const mathReport = t2Coverage(snapshot, ['test/entry.test.ts'], ['src/math.ts']);
  assert.equal(mathReport.applicable, true);
  assert.equal(mathReport.satisfied, false);
  assert.ok(mathReport.uncoveredSymbols.length > 0);
  const shared = snapshot.symbols.find((symbol) => symbol.file === 'src/math.ts' && symbol.name === 'sharedCalculator');
  assert.ok(shared && mathReport.uncoveredSymbols.includes(shared.id));

  // A touched type-only file has no callable symbols: T2 is not applicable, not a pass.
  const typeReport = t2Coverage(snapshot, ['test/entry.test.ts'], ['src/types.ts']);
  assert.equal(typeReport.applicable, false);
  assert.equal(typeReport.satisfied, false);
  assert.deepEqual(typeReport.affectedSymbols, []);

  // No executed tests means nothing is reachable through the call graph.
  const noTests = t2Coverage(snapshot, [], ['src/leaf.ts']);
  assert.equal(noTests.satisfied, false);
  assert.equal(noTests.coveredSymbols.length, 0);

  // T1 import edge alone would make entry.ts reachable; T2 must use the call path.
  assert.ok(snapshot.edges.some((edge) => edge.from === 'test/entry.test.ts' && edge.to === 'src/entry.ts' && edge.kind === 'value-confirmed'));
  const helperReport = t2Coverage(snapshot, ['test/entry.test.ts'], ['src/helpers.ts']);
  assert.equal(helperReport.satisfied, true, 'helper() is called transitively through entryWork');
  store.close();
});

test('explore primitives expose revision, freshness, caveats and an output-char budget', async () => {
  const root = await createFixture();
  const store = await GraphStore.open(root);
  await store.build();
  const snapshot = store.snapshot();
  const options = { root, freshness: store.freshness() };

  const symbol = await exploreSymbol(snapshot, { text: 'double', includeEdges: true }, options);
  assert.equal(symbol.meta.graphRevision, snapshot.revision);
  assert.equal(symbol.meta.freshness.status, 'fresh');
  assert.equal(symbol.meta.caveats.callEdges, snapshot.caveats.callEdges);
  assert.ok(symbol.meta.totalMatches >= 1);
  assert.ok(symbol.meta.returned >= 1);
  assert.ok(symbol.meta.budget.limitChars > 0);
  assert.equal(symbol.meta.budget.semantics, 'output-size');
  assert.equal(symbol.data.symbols[0]?.name, 'double');
  assert.ok(symbol.data.symbols[0]?.snippet?.text.includes('double'));
  assert.ok(symbol.data.symbols[0]?.relations?.incomingCalls.some((edge) => edge.from === 'src/entry.ts'));

  const search = await exploreSearch(snapshot, { query: 'e' }, { ...options, maxOutputChars: 220 });
  const expected = searchSymbols(snapshot, 'e').length + Object.keys(snapshot.files).filter((file) => file.includes('e')).length;
  assert.equal(search.meta.totalMatches, expected, 'totalMatches is the real hit count, not the budget');
  assert.ok(search.meta.returned < search.meta.totalMatches, 'small budget trims returned entries');
  assert.ok(search.meta.budget.truncated);
  assert.equal(search.meta.budget.limitChars, 220);
  assert.ok(search.meta.budget.usedChars <= 220);

  const outline = await exploreOutline(snapshot, { file: 'src/math.ts' }, options);
  assert.equal(outline.meta.graphRevision, snapshot.revision);
  const outlineNames = outline.data.symbols.map((symbol) => symbol.qualifiedName);
  assert.ok(outlineNames.includes('add'));
  assert.ok(outlineNames.includes('Calculator.run'));
  assert.ok(outlineNames.includes('Calculator.runInline'));

  const impact = await exploreImpact(snapshot, { touched: ['src/leaf.ts'] }, options);
  assert.ok(impact.data.impactedFiles.includes('src/entry.ts'));
  assert.ok(impact.data.impactedFiles.includes('test/entry.test.ts'));
  assert.ok(impact.meta.totalMatches >= impact.data.impactedFiles.length);

  const flow = await exploreFlow(snapshot, { from: 'test/entry.test.ts', to: 'src/leaf.ts' }, options);
  assert.ok(flow.data.paths.length >= 1, 'flow must find the test -> entry -> leaf call path');
  const first = flow.data.paths[0]!;
  assert.ok(first.steps.length >= 2);
  assert.equal(first.steps[0]?.callee, 'entryWork');
  assert.equal(first.steps[first.steps.length - 1]?.callee, 'leaf');
  assert.ok(first.steps.every((step) => step.provenance === 'resolved'));
  assert.ok(first.steps.some((step) => step.callSnippet?.text.includes('entryWork')));
  assert.ok(first.steps.some((step) => step.definitionSnippet?.text.includes('leaf')));
  assert.equal(flow.meta.totalMatches, flow.data.paths.length);
  store.close();
});

test('explore orchestration keeps section totals above the budget and does not count budget as hits', async () => {
  const root = await createFixture();
  const store = await GraphStore.open(root);
  await store.build();
  const snapshot = store.snapshot();
  const result = await explore(snapshot, {
    task: 'trace entryWork to leaf and inspect Calculator helpers',
    touchedFiles: ['src/leaf.ts'],
    flow: { from: 'test/entry.test.ts', to: 'src/leaf.ts' },
  }, { root, freshness: store.freshness(), maxOutputChars: 1500 });

  assert.equal(result.meta.graphRevision, snapshot.revision);
  assert.equal(result.meta.budget.limitChars, 1500);
  assert.ok(result.meta.totalMatches > 0);
  assert.ok(result.meta.totalMatches >= result.meta.returned);
  assert.ok((result.data.totals.flow ?? 0) >= 1);
  assert.ok(result.data.search !== undefined);
  assert.ok(result.data.symbols !== undefined);
  store.close();
});

test('content-hash incremental build reuses parsed files, persists calls, and replays', async () => {
  const root = await createFixture();
  const store = await GraphStore.open(root);
  await store.build();
  assert.equal(store.lastBuild?.mode, 'full');
  const firstRevision = store.revision;
  const firstCalls = store.snapshot().calls ?? [];
  assert.ok(firstCalls.length > 0);

  await store.build();
  assert.equal(store.lastBuild?.mode, 'incremental');
  assert.equal(store.lastBuild?.parsed, 0);
  assert.ok((store.lastBuild?.reused ?? 0) > 0);
  assert.equal(store.revision, firstRevision, 'unchanged content must not change the revision');
  assert.deepEqual(store.snapshot().calls, firstCalls);

  await writeFile(join(root, 'src', 'extra.ts'), 'export function extra(): number { return leafValue(); }\nexport function leafValue(): number { return 1; }\n');
  await store.build();
  assert.equal(store.lastBuild?.mode, 'full');
  assert.equal(store.lastBuild?.parsed, 1, 'only the new file is parsed');
  assert.ok((store.lastBuild?.reused ?? 0) > 0);
  assert.notEqual(store.revision, firstRevision);
  const extraCall = store.snapshot().calls?.find((edge) => edge.from === 'src/extra.ts' && edge.callee === 'leafValue');
  assert.equal(extraCall?.provenance, 'resolved');
  const finalCalls = store.snapshot().calls;
  store.close();

  const reopened = await GraphStore.open(root);
  assert.deepEqual(reopened.snapshot().calls, finalCalls);
  assert.equal(reopened.freshness().status, 'fresh');
  reopened.close();
});

// ============================================================================
// ADR-010 §7.2 / T-115: IIFE and nested-scope extraction
// ============================================================================

async function createIifeFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ano p3 iife '));
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'p3-iife-fixture', private: true }, null, 2),
    'src/helper.ts': 'export function helper(x: number): number { return x + 1; }\n',
    'workbench/app.js': [
      "import { helper } from '../src/helper.js';",
      '(function () {',
      "  const fs = require('fs');",
      '  function localHelper(x) { return helper(x); }',
      '  const localArrow = (y) => localHelper(y);',
      '  const api = { run: function () { return localArrow(1); }, note: "n" };',
      '  module.exports = { run: function () { return api.run(); } };',
      '})();',
      '',
    ].join('\n'),
  };
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, ...path.split('/'));
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  return root;
}

test('IIFE locals are searchable with scope-qualified names and never leak as exports', async () => {
  const root = await createIifeFixture();
  const store = await GraphStore.open(root);
  await store.build();
  const snapshot = store.snapshot();
  const file = 'workbench/app.js';

  const scoped = (name: string): string => `${file}#<iife>.${name}`;
  const localHelper = snapshot.symbols.find((symbol) => symbol.file === file && symbol.name === 'localHelper');
  assert.ok(localHelper, 'the IIFE-local function must be a graph symbol');
  assert.equal(localHelper?.qualifiedName, scoped('localHelper'));

  const hits = searchSymbols(snapshot, 'localHelper');
  assert.ok(hits.some((symbol) => symbol.file === file && symbol.qualifiedName === scoped('localHelper')));
  const outline = await exploreOutline(snapshot, { file }, { root, freshness: store.freshness() });
  const outlineNames = outline.data.symbols.map((symbol) => symbol.qualifiedName);
  assert.ok(outlineNames.includes(scoped('localHelper')));
  assert.ok(outlineNames.includes(scoped('api.run')));
  assert.ok(outlineNames.includes(scoped('api.note')));

  // The internal require/import stay real dependency edges.
  const importEdge = snapshot.edges.find((edge) => edge.from === file && edge.to === 'src/helper.ts');
  assert.equal(importEdge?.kind, 'value-confirmed');
  assert.equal(importEdge?.provenance, 'resolved');
  assert.ok(snapshot.edges.some((edge) => edge.from === file && edge.label === 'dynamic_import'));

  // Calls resolve: imported helper plus same-file local helper.
  const importedCall = snapshot.calls?.find((edge) => edge.from === file && edge.callee === 'helper' && edge.to === 'src/helper.ts');
  assert.equal(importedCall?.provenance, 'resolved');
  const localCall = snapshot.calls?.find((edge) => edge.from === file && edge.callee === 'localHelper' && edge.to === file);
  assert.equal(localCall?.provenance, 'resolved');

  // Only the real module.exports target is an export; locals stay role-free.
  const exportRoles = snapshot.symbols.filter((symbol) => symbol.file === file && symbol.role === 'export').map((symbol) => symbol.qualifiedName);
  assert.deepEqual(exportRoles, [`${file}#default`]);
  assert.equal(snapshot.symbols.some((symbol) => symbol.file === file && symbol.name === 'localHelper' && symbol.role === 'export'), false);
  assert.equal(snapshot.symbols.find((symbol) => symbol.file === file && symbol.qualifiedName === `${file}#default.run`)?.role, 'member');
  store.close();
});

test('synthetic workbench shape (4000+ line IIFE) yields symbols and edges', async () => {
  const lines: string[] = [
    "import { helper } from './src/helper.js';",
    '(function () {',
    "  const fs = require('fs');",
  ];
  for (let index = 0; index < 1400; index += 1) {
    lines.push(`  function fn${index}(x) { return helper(x) + ${index}; }`);
    lines.push(`  function helperFn${index}(x) { return x * 2; }`);
    lines.push(`  const arrow${index} = () => helperFn${index}(${index});`);
  }
  lines.push('  module.exports = { run: function () { return arrow0(); } };');
  lines.push('})();');
  const source = `${lines.join('\n')}\n`;
  assert.ok(lines.length > 4000, `fixture must exceed 4000 lines (got ${lines.length})`);

  const root = await mkdtemp(join(tmpdir(), 'ano p3 workbench '));
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'p3-workbench-fixture', private: true }, null, 2),
    'src/helper.ts': 'export function helper(x: number): number { return x + 1; }\n',
    'workbench/app.js': source,
  };
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, ...path.split('/'));
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }

  const store = await GraphStore.open(root);
  await store.build();
  const snapshot = store.snapshot();
  const file = 'workbench/app.js';
  const fileSymbols = snapshot.symbols.filter((symbol) => symbol.file === file);
  const fileEdges = snapshot.edges.filter((edge) => edge.from === file);
  const resolvedCalls = (snapshot.calls ?? []).filter((edge) => edge.from === file && edge.provenance === 'resolved');
  assert.ok(fileSymbols.length > 0, 'an IIFE-only module must no longer produce zero symbols');
  assert.ok(fileEdges.length > 0, 'an IIFE-only module must no longer produce zero edges');
  assert.ok(resolvedCalls.length > 0, 'internal calls must resolve to scoped definitions');

  const tail = searchSymbols(snapshot, 'fn1399');
  assert.ok(tail.some((symbol) => symbol.file === file && symbol.qualifiedName === `${file}#<iife>.fn1399`));

  // The synthetic shape is classified as parsed, not zero-symbol/zero-edge.
  const analysis = analyzeStructure(snapshot);
  const row = analysis.files.find((candidate) => candidate.file === file);
  assert.equal(row?.classification, 'parsed');
  assert.ok((row?.symbols ?? 0) > 4000 / 3);
  store.close();
});

test('zero-declaration vs zero-dependency stay distinguishable through analysis', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ano p3 zero signal '));
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'p3-zero-signal', private: true }, null, 2),
    'src/empty.js': "console.log('nothing');\n",
    'src/isolated.js': 'function isolated() { return 1; }\n',
    'src/iife.js': [
      '(function () {',
      "  const fs = require('fs');",
      '  function local() { return 1; }',
      '  const run = () => local();',
      '  module.exports = { run: function () { return run(); } };',
      '})();',
      '',
    ].join('\n'),
  };
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, ...path.split('/'));
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  const store = await GraphStore.open(root);
  await store.build();
  const analysis = analyzeStructure(store.snapshot());
  const byFile = new Map(analysis.files.map((row) => [row.file, row]));
  assert.equal(byFile.get('src/empty.js')?.classification, 'zero-symbol');
  assert.equal(byFile.get('src/isolated.js')?.classification, 'zero-edge');
  assert.equal(byFile.get('src/iife.js')?.classification, 'parsed');
  assert.equal(analysis.counts['zero-symbol'], 1);
  assert.equal(analysis.counts['zero-edge'], 1);
  store.close();
});
