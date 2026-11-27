/**
 * PY-10 / M23b: Python structure gold standard and T1 coverage.
 *
 * The four on-disk fixtures under `test/fixtures/python/` are parsed with the
 * real tree-sitter-python WASM and the real Python resolver. Every project-file
 * edge is compared byte-for-byte with the hand-authored
 * `test/fixtures/python/expected-edges.json`: tri-state, provenance, label and
 * imported names. T1 reachability is recomputed from the graph, never from the
 * gold file, and only `value-confirmed` + `resolved` edges may traverse.
 *
 * Nothing here executes Python, reads a venv or claims supported status. The
 * feature flag stays closed by default; the opt-in here is the documented
 * `enablePythonStructure` test seam owned by PY-09.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { fingerprintProject } from '../../src/core/source-scan.ts';
import { blastRadius, testCoverage } from '../../src/gate/blast.ts';
import { buildSnapshot, ENABLE_PYTHON_STRUCTURE } from '../../src/structure/extractor.ts';
import { createPythonResolutionContext, pythonModuleName } from '../../src/structure/imports-python.ts';
import { exploreImpact, exploreOutline, exploreSymbol } from '../../src/structure/explore.ts';
import type { Freshness, GraphEdge, GraphSnapshot } from '../../src/structure/types.ts';

const FIXTURE_ROOT = fileURLToPath(new URL('../fixtures/python/', import.meta.url));
const FRESH: Freshness = { status: 'fresh', stale: 0 };

interface GoldEdge {
  from: string;
  to: string;
  kind: GraphEdge['kind'];
  provenance: GraphEdge['provenance'];
  label: string | null;
  importedNames: string[];
}
interface GoldFixture {
  roots: string[];
  pythonFiles: string[];
  edges: GoldEdge[];
  tsEdges?: GoldEdge[];
  caveats: { patterns: string[]; dynamicLoadSites: Array<{ file: string; line: number; pattern: string; tier: string; target?: string }> };
  t1: { executed: string[]; covered: string[]; notCovered: string[] };
}
interface GoldFile {
  schemaVersion: number;
  fixtures: Record<string, GoldFixture>;
}

const GOLD = JSON.parse(await readFile(join(FIXTURE_ROOT, 'expected-edges.json'), 'utf8')) as GoldFile;

function isPythonPath(path: string): boolean {
  return path.endsWith('.py') || path.endsWith('.pyi');
}
function normalizeEdge(edge: GraphEdge): GoldEdge {
  return {
    from: edge.from,
    to: edge.to,
    kind: edge.kind,
    provenance: edge.provenance,
    label: edge.label ?? null,
    importedNames: [...edge.importedNames].sort(),
  };
}
function edgeKey(edge: GoldEdge): string {
  return [edge.from, edge.to, edge.kind, edge.label ?? '', edge.provenance, edge.importedNames.join(',')].join('\u0000');
}
function sortEdges(edges: GoldEdge[]): GoldEdge[] {
  return [...edges].sort((left, right) => edgeKey(left).localeCompare(edgeKey(right)));
}
function projectPythonEdges(snapshot: GraphSnapshot): GoldEdge[] {
  return sortEdges(snapshot.edges.filter((edge) => isPythonPath(edge.to)).map(normalizeEdge));
}

async function buildFixture(name: string): Promise<{ root: string; snapshot: GraphSnapshot; report: Awaited<ReturnType<typeof buildSnapshot>>['report'] }> {
  const root = join(FIXTURE_ROOT, name);
  const fingerprint = await fingerprintProject(root, undefined);
  const output = await buildSnapshot({ root, fingerprint, enablePythonStructure: true });
  return { root, snapshot: output.snapshot, report: output.report };
}

async function writeProject(t: test.TestContext, files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ano-python-gold-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, ...path.split('/'));
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  return root;
}

for (const [name, gold] of Object.entries(GOLD.fixtures)) {
  test(`gold edges: ${name} matches every tri-state exactly`, async () => {
    const { root, snapshot, report } = await buildFixture(name);
    assert.equal(report.degraded, false);
    assert.equal(snapshot.caveats.degradedReasons.length, 0);
    assert.deepEqual(
      Object.keys(snapshot.files).filter(isPythonPath).sort(),
      gold.pythonFiles,
      'every fixture Python file is in the snapshot and no extra one is invented',
    );
    const context = await createPythonResolutionContext(root, Object.keys(snapshot.files));
    assert.deepEqual(context.roots, gold.roots);
    assert.deepEqual(projectPythonEdges(snapshot), sortEdges(gold.edges));

    for (const edge of snapshot.edges.filter((candidate) => isPythonPath(candidate.to))) {
      if (edge.kind === 'value-confirmed') {
        assert.equal(edge.provenance, 'resolved', `${edge.from} -> ${edge.to} confirmed without resolved provenance`);
        assert.equal(edge.label, undefined, `${edge.from} -> ${edge.to} confirmed with a heuristic label`);
      }
      if (edge.to.endsWith('.pyi')) assert.equal(edge.kind, 'type-only', `${edge.to} may never be runtime coverage`);
    }

    const patterns = [...new Set((snapshot.caveats.semanticGaps ?? []).map((gap) => gap.pattern).filter((pattern) => pattern.startsWith('python-')))].sort();
    assert.deepEqual(patterns, gold.caveats.patterns);
    const dynamicSites = (snapshot.caveats.dynamicLoadSites ?? [])
      .map((site) => ({ file: site.file, line: site.line, pattern: site.pattern, tier: site.tier, ...(site.target !== undefined ? { target: site.target } : {}) }))
      .sort((left, right) => `${left.file}:${left.line}:${left.pattern}`.localeCompare(`${right.file}:${right.line}:${right.pattern}`));
    assert.deepEqual(dynamicSites, gold.caveats.dynamicLoadSites);

    // Same fingerprint + same flag => same revision and edge bytes.
    const fingerprint = await fingerprintProject(root, undefined);
    const repeated = await buildSnapshot({ root, fingerprint, enablePythonStructure: true });
    assert.equal(repeated.snapshot.revision, snapshot.revision);
    assert.deepEqual(projectPythonEdges(repeated.snapshot), projectPythonEdges(snapshot));
  });
}

for (const [name, gold] of Object.entries(GOLD.fixtures)) {
  test(`T1 coverage: ${name} only follows value-confirmed resolved edges`, async () => {
    const { snapshot } = await buildFixture(name);
    const covered = [...testCoverage(snapshot, gold.t1.executed)].sort();
    assert.deepEqual(covered, gold.t1.covered);
    for (const file of gold.t1.notCovered) assert.ok(!covered.includes(file), `${file} must not be covered`);
    for (const file of covered) assert.ok(isPythonPath(file), `coverage leaked outside Python files: ${file}`);
    assert.ok(!covered.some((file) => file.endsWith('.pyi')), 'a .pyi stub is never runtime coverage');
  });
}

test('T1: type-only, wildcard, conditional, lazy, conftest and .pyi never bridge coverage', async (t) => {
  const { snapshot } = await buildFixture('src-layout');
  const alone = (file: string): string[] => [...testCoverage(snapshot, [file])].sort();
  assert.deepEqual(alone('src/app/tests/test_type.py'), ['src/app/tests/test_type.py'], 'TYPE_CHECKING edge is type-only');
  assert.deepEqual(alone('src/app/tests/test_stub.py'), ['src/app/tests/test_stub.py'], '.pyi target is type-only');
  assert.deepEqual(alone('src/app/tests/test_wildcard.py'), ['src/app/tests/test_wildcard.py'], 'wildcard edge is heuristic');
  assert.deepEqual(alone('src/app/tests/test_conditional.py'), ['src/app/tests/test_conditional.py'], 'conditional import is heuristic');
  assert.deepEqual(alone('src/app/tests/conftest.py'), ['src/app/tests/conftest.py'], 'a conftest fixture is not an import');
  const lazy = alone('src/app/tests/test_lazy.py');
  assert.ok(lazy.includes('src/app/lazy.py'));
  assert.ok(!lazy.includes('src/app/late.py'), 'the lazy import inside load() stays heuristic');

  const value = alone('src/app/tests/test_value.py');
  for (const expected of ['src/app/service.py', 'src/app/models.py', 'src/app/types.py']) assert.ok(value.includes(expected), expected);

  const typeBlast = blastRadius(snapshot, ['src/app/types.py'], ['src/app/tests/test_type.py'], { minimum: 'T1', unknown: 'strict' });
  assert.ok(typeBlast.uncovered.includes('src/app/types.py'), 'a type-only edge cannot mark the typed target covered');
  const stubBlast = blastRadius(snapshot, ['src/app/api.pyi'], ['src/app/tests/test_stub.py'], { minimum: 'T1', unknown: 'strict' });
  assert.ok(stubBlast.uncovered.includes('src/app/api.pyi'));
  const wildcardBlast = blastRadius(snapshot, ['src/app/wildcard.py'], ['src/app/tests/test_wildcard.py'], { minimum: 'T1', unknown: 'strict' });
  assert.ok(wildcardBlast.uncovered.includes('src/app/wildcard.py'));
  const serviceBlast = blastRadius(snapshot, ['src/app/service.py'], ['src/app/tests/test_value.py'], { minimum: 'T1', unknown: 'strict' });
  assert.ok(serviceBlast.covered.includes('src/app/service.py'));
  assert.ok(!serviceBlast.uncovered.includes('src/app/service.py'));
  assert.ok(serviceBlast.uncovered.includes('src/app/main.py'), 'an unimported dependent stays uncovered');

  // ADR-014 §5.4: even treating conftest as executed must not reach a fixture-only module.
  const withConftest = testCoverage(snapshot, ['src/app/tests/conftest.py']);
  assert.ok(!withConftest.has('src/app/fixture_only.py'));
  assert.ok(!withConftest.has('src/app/service.py'));

  // The dynamic loader never becomes an edge to the module it names at runtime.
  const dynamicOnly = [...testCoverage(snapshot, ['src/app/tests/test_dynamic.py'])].sort();
  assert.ok(dynamicOnly.includes('src/app/dynamic.py'));
  assert.ok(!dynamicOnly.includes('src/app/models.py'));
});

test('explore projects Python symbols, impact and caveats from the same snapshot', async () => {
  const { snapshot } = await buildFixture('src-layout');
  const outline = await exploreOutline(snapshot, { file: 'src/app/service.py' }, { freshness: FRESH });
  assert.deepEqual(outline.data.symbols.map((symbol) => symbol.qualifiedName), [
    'app.service',
    'app.service:Service',
    'app.service:Service.load',
  ]);
  assert.equal(outline.data.symbols.find((symbol) => symbol.name === 'load')?.startLine, 6);

  const symbol = await exploreSymbol(snapshot, { text: 'app.service:Service.load', includeEdges: true }, { freshness: FRESH });
  assert.equal(symbol.data.symbols.length, 1);
  assert.equal(symbol.data.symbols[0]?.file, 'src/app/service.py');
  const relations = symbol.data.symbols[0]?.relations;
  assert.ok(relations?.importEdges.some((edge) => edge.from === 'src/app/service.py' && edge.to === 'src/app/models.py'));
  assert.ok(relations?.importEdges.some((edge) => edge.from === 'src/app/service.py' && edge.to === 'src/app/types.py'));

  const impact = await exploreImpact(snapshot, { touched: ['src/app/service.py'] }, { freshness: FRESH });
  for (const file of ['src/app/__init__.py', 'src/app/main.py', 'src/app/tests/conftest.py', 'src/app/tests/test_value.py']) {
    assert.ok(impact.data.impactedFiles.includes(file), file);
  }

  assert.equal(symbol.meta.freshness.status, 'fresh');
  assert.equal(symbol.meta.graphRevision, snapshot.revision);
  const gapPatterns = (symbol.meta.caveats.semanticGaps ?? []).map((gap) => gap.pattern);
  assert.ok(gapPatterns.includes('python-import-external'));
  assert.ok(gapPatterns.includes('python-reexport'));
  assert.ok((symbol.meta.caveats.dynamicLoadSites ?? []).some((site) => site.file === 'src/app/dynamic.py' && site.pattern === 'dynamic-import'));
  assert.ok(symbol.meta.budget.limitChars > 0);

  const pyi = await exploreSymbol(snapshot, { file: 'src/app/api.pyi' }, { freshness: FRESH });
  assert.ok(pyi.data.symbols.some((hit) => hit.qualifiedName === 'app.api:Protocol'));
});

test('flag-off builds exclude .py and leave the TS graph unchanged', async () => {
  assert.equal(ENABLE_PYTHON_STRUCTURE, false);
  const mixedRoot = join(FIXTURE_ROOT, 'mixed-ts-py');
  const mixedFingerprint = await fingerprintProject(mixedRoot, undefined);
  const disabled = await buildSnapshot({ root: mixedRoot, fingerprint: mixedFingerprint });
  assert.equal(Object.keys(disabled.snapshot.files).some(isPythonPath), false);
  assert.equal(disabled.snapshot.symbols.some((symbol) => isPythonPath(symbol.file)), false);
  assert.equal(disabled.snapshot.edges.some((edge) => isPythonPath(edge.from) || isPythonPath(edge.to)), false);
  const tsEdges = sortEdges(disabled.snapshot.edges.map(normalizeEdge));
  assert.deepEqual(tsEdges, sortEdges(GOLD.fixtures['mixed-ts-py']!.tsEdges ?? []));

  const enabled = await buildSnapshot({ root: mixedRoot, fingerprint: mixedFingerprint, enablePythonStructure: true });
  assert.deepEqual(sortEdges(enabled.snapshot.edges.filter((edge) => edge.from.endsWith('.ts') || edge.to.endsWith('.ts')).map(normalizeEdge)), tsEdges);

  const pythonOnlyRoot = join(FIXTURE_ROOT, 'src-layout');
  const pythonOnlyFingerprint = await fingerprintProject(pythonOnlyRoot, undefined);
  const pythonOff = await buildSnapshot({ root: pythonOnlyRoot, fingerprint: pythonOnlyFingerprint });
  assert.deepEqual(Object.keys(pythonOff.snapshot.files), []);
  assert.deepEqual(pythonOff.snapshot.edges, []);
  assert.deepEqual(pythonOff.snapshot.symbols, []);
  assert.equal(pythonOff.report.degraded, false);
});

test('mixed TS+Python graph keeps languages separate and emits no Python L2 calls', async () => {
  const { root, snapshot } = await buildFixture('mixed-ts-py');
  assert.deepEqual(projectPythonEdges(snapshot), sortEdges(GOLD.fixtures['mixed-ts-py']!.edges));
  assert.deepEqual(
    sortEdges(snapshot.edges.filter((edge) => edge.from.endsWith('.ts') || edge.to.endsWith('.ts')).map(normalizeEdge)),
    sortEdges(GOLD.fixtures['mixed-ts-py']!.tsEdges ?? []),
  );
  for (const edge of snapshot.edges) {
    if (isPythonPath(edge.from)) assert.ok(isPythonPath(edge.to), `Python edge crossed into TS: ${edge.from} -> ${edge.to}`);
    if (edge.from.endsWith('.ts')) assert.ok(edge.to.endsWith('.ts'), `TS edge crossed into Python: ${edge.from} -> ${edge.to}`);
  }
  assert.deepEqual(snapshot.calls ?? [], [], 'ADR-014 §8 keeps Python L2 out');

  const context = await createPythonResolutionContext(root, Object.keys(snapshot.files));
  assert.equal(pythonModuleName(context, 'src/py/main.py'), 'py.main');
  assert.equal(pythonModuleName(context, 'src/py/tests/test_main.py'), 'py.tests.test_main');
  const qualified = new Set(snapshot.symbols.map((symbol) => symbol.qualifiedName));
  assert.ok(qualified.has('py.bridge'));
  assert.ok(qualified.has('py.bridge:VALUE'));
  assert.ok(qualified.has('py.helper:helper_value'));
  assert.ok(qualified.has('py.tests.test_main:test_main'));
  assert.ok(qualified.has('consumed'), 'the TS symbol projection is untouched');
});

test('class-local imports and conditional definitions cannot be reexport-confirmed end to end', async (t) => {
  const root = await writeProject(t, {
    'pkg/__init__.py': [
      'class C:',
      '    from .impl import run',
      'from .impl import base',
      'PUBLIC = 1',
      '',
    ].join('\n'),
    'pkg/impl.py': 'def base(): ...\ndef run(): ...\n',
    'app.py': 'from pkg import run\nfrom pkg import base\nfrom pkg import PUBLIC\n',
    'maybe_mod.py': 'if flag:\n    def maybe(): ...\n',
    'consumer.py': 'from maybe_mod import maybe\n',
  });
  const fingerprint = await fingerprintProject(root, undefined);
  const { snapshot } = await buildSnapshot({ root, fingerprint, enablePythonStructure: true });
  const appEdges = snapshot.edges.filter((edge) => edge.from === 'app.py');
  assert.deepEqual(
    appEdges.filter((edge) => edge.provenance === 'resolved').map((edge) => [edge.to, edge.kind, edge.importedNames.join(',')]).sort(),
    [
      ['pkg/__init__.py', 'value-confirmed', 'PUBLIC'],
      ['pkg/impl.py', 'value-confirmed', 'base'],
    ],
  );
  const runEdge = appEdges.find((edge) => edge.importedNames.includes('run'));
  assert.equal(runEdge?.kind, 'unknown');
  assert.equal(runEdge?.provenance, 'parsed');
  assert.equal(runEdge?.to, 'pkg/__init__.py');
  assert.ok(!appEdges.some((edge) => edge.kind === 'value-confirmed' && edge.importedNames.includes('run')));
  // The class-body load edge is retained, but only as a load (both names), never
  // as proof that `pkg.run` is a module attribute.
  const load = snapshot.edges.find((edge) => edge.from === 'pkg/__init__.py' && edge.to === 'pkg/impl.py');
  assert.equal(load?.kind, 'value-confirmed');
  assert.deepEqual(load?.importedNames, ['base', 'run']);

  const maybe = snapshot.edges.find((edge) => edge.from === 'consumer.py');
  assert.equal(maybe?.kind, 'unknown');
  assert.equal(maybe?.provenance, 'heuristic');
  assert.equal(maybe?.label, 'conditional_import');
  assert.ok((snapshot.caveats.semanticGaps ?? []).some((gap) => gap.pattern === 'python-reexport'));
});

test('pyproject source roots are part of the source fingerprint', async (t) => {
  const root = await writeProject(t, {
    'pyproject.toml': '[tool.setuptools.packages.find]\nwhere = ["src"]\n',
    'src/pkg/mod.py': 'VALUE = 1\n',
    'app.py': 'from pkg.mod import VALUE\n',
  });
  const before = await fingerprintProject(root, undefined);
  const first = await buildSnapshot({ root, fingerprint: before, enablePythonStructure: true });
  assert.ok(first.snapshot.edges.some((edge) => edge.from === 'app.py' && edge.to === 'src/pkg/mod.py' && edge.kind === 'value-confirmed'));

  await writeFile(join(root, 'pyproject.toml'), '[tool.setuptools.packages.find]\nwhere = ["."]\n');
  const after = await fingerprintProject(root, undefined);
  assert.notEqual(after.hash, before.hash, 'pyproject.toml must invalidate the source fingerprint');
  const second = await buildSnapshot({ root, fingerprint: after, enablePythonStructure: true });
  const appEdge = second.snapshot.edges.find((edge) => edge.from === 'app.py');
  assert.equal(appEdge?.kind, 'unknown');
  assert.equal(appEdge?.provenance, 'parsed');
  assert.equal(appEdge?.label, 'unresolved');
  assert.ok(!second.snapshot.edges.some((edge) => edge.kind === 'value-confirmed' && edge.from === 'app.py'));
});
