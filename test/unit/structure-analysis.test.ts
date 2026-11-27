import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { resolveProjectScan, type ResolvedProjectScan } from '../../src/core/project-scan.ts';
import { GraphStore, type GraphStoreOpenOptions } from '../../src/structure/store.ts';
import {
  analyzeFileBaseline,
  analyzeStructure,
  collectDegradedFiles,
  createStructureAnalysisCache,
  openStructureAnalyzer,
  reverseClosure,
  structureAnalysisCacheKey,
  type FileAnalysis,
  type StructureAnalysisStore,
  type StructureAnalysisStoreSeam,
} from '../../src/structure/analysis.ts';
import { emptyCaveats, type BlindSpotType, type CallEdge, type DynamicLoadTier, type GraphEdge, type GraphSnapshot, type SymbolNode } from '../../src/structure/types.ts';
import { caveatEvidenceFromParsed, createTsExtractor } from '../../src/structure/extractors/ts.ts';
import { explore, structureAnalysis, structureFileQuery } from '../../src/surface/service.ts';

async function writeFixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ano structure analysis '));
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, ...path.split('/'));
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  return root;
}

const BASE_FIXTURE = {
  '.git/HEAD': 'ref: refs/heads/main\n',
  '.pm/project.json': JSON.stringify({ name: 'analysis-fixture', scan_ignore: ['src/generated/**'] }),
  'package.json': JSON.stringify({ name: 'analysis-fixture', private: true }),
};

function fileEntry(path: string): { path: string; hash: string; dynamicLoads: number } {
  return { path, hash: `${path.length}${'0'.repeat(63)}`, dynamicLoads: 0 };
}

function symbol(id: string, file: string, name: string, startLine: number): SymbolNode {
  return { id, file, name, qualifiedName: name, symbolKind: 'value', startLine };
}

/** a -> b -> c, d isolated; resolved import and call edges on both links. */
function handSnapshot(): GraphSnapshot {
  return {
    revision: 'rev-hand',
    sourceFingerprint: 'f'.repeat(64),
    files: {
      'src/a.ts': fileEntry('src/a.ts'),
      'src/b.ts': fileEntry('src/b.ts'),
      'src/c.ts': fileEntry('src/c.ts'),
      'src/d.ts': fileEntry('src/d.ts'),
    },
    symbols: [
      symbol('id-a', 'src/a.ts', 'alpha', 1),
      symbol('id-b', 'src/b.ts', 'beta', 1),
      symbol('id-c', 'src/c.ts', 'gamma', 1),
      symbol('id-d', 'src/d.ts', 'delta', 1),
    ],
    edges: [
      { from: 'src/a.ts', to: 'src/b.ts', kind: 'value-confirmed', provenance: 'resolved', importedNames: ['beta'] },
      { from: 'src/b.ts', to: 'src/c.ts', kind: 'value-confirmed', provenance: 'resolved', importedNames: ['gamma'] },
    ],
    calls: [
      { from: 'src/a.ts', to: 'src/b.ts', callee: 'beta', line: 2, provenance: 'resolved', label: 'imported', callerSymbolId: 'id-a', calleeSymbolId: 'id-b' },
      { from: 'src/b.ts', to: 'src/c.ts', callee: 'gamma', line: 2, provenance: 'resolved', label: 'imported', callerSymbolId: 'id-b', calleeSymbolId: 'id-c' },
    ],
    caveats: emptyCaveats(),
  };
}

test('batch rows equal the independent per-file baseline and the six metrics match the formulas', () => {
  const snapshot = handSnapshot();
  const analysis = analyzeStructure(snapshot, {
    touched: ['src/c.ts'],
    exploredFiles: ['src/a.ts', 'src/c.ts'],
    maxDepth: 3,
  });

  assert.equal(analysis.metrics.inScope, 4);
  assert.equal(analysis.metrics.touched, 1);
  assert.equal(analysis.metrics.direct, 1);
  assert.equal(analysis.metrics.transitive, 2);
  assert.equal(analysis.metrics.unchanged, 1);
  // blindness counts zero-symbol + unknown + unsupported only; zero-edge is advisory.
  assert.equal(analysis.metrics.blindness, 0);
  assert.equal(analysis.metrics.explored, 0.5);
  assert.equal(analysis.metrics.depthLimited, false);
  assert.deepEqual(analysis.metrics.fanout, [{ file: 'src/a.ts', fanout: 1 }, { file: 'src/b.ts', fanout: 1 }]);

  assert.deepEqual(analysis.counts, {
    parsed: 2,
    'zero-symbol': 0,
    'zero-edge': 2,
    'dynamic-only': 0,
    unsupported: 0,
    excluded: 0,
    deleted: 0,
    degraded: 0,
    unknown: 0,
  });

  for (const row of analysis.files) {
    const baseline: FileAnalysis = analyzeFileBaseline(snapshot, row.file, { touched: ['src/c.ts'], maxDepth: 3 });
    assert.deepEqual(row, baseline, `batch row ${row.file} must equal its single-file baseline`);
  }

  // Closure over the touched set: c -> b -> a, d unchanged.
  assert.deepEqual(analysis.closure.touched, ['src/c.ts']);
  assert.deepEqual(analysis.closure.direct, ['src/b.ts']);
  assert.deepEqual(analysis.closure.transitive, ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(analysis.closure.unchanged, ['src/d.ts']);

  const byFile = new Map(analysis.files.map((row) => [row.file, row]));
  assert.equal(byFile.get('src/a.ts')?.staticEdges, 2);
  assert.equal(byFile.get('src/a.ts')?.imports.outgoing, 1);
  assert.equal(byFile.get('src/a.ts')?.imports.resolvedOutgoing, 1);
  assert.equal(byFile.get('src/a.ts')?.calls.outgoing, 1);
  assert.equal(byFile.get('src/a.ts')?.directDependents, 0);
  assert.equal(byFile.get('src/b.ts')?.directDependents, 1);
  assert.equal(byFile.get('src/b.ts')?.transitiveDependents, 1);
  assert.equal(byFile.get('src/c.ts')?.directDependents, 1);
  assert.equal(byFile.get('src/c.ts')?.transitiveDependents, 2);

  // Risk order: c(9.02) > b(3.12) > d(1.02) > a(0.12).
  assert.deepEqual(analysis.risks.map((risk) => risk.file), ['src/c.ts', 'src/b.ts', 'src/d.ts', 'src/a.ts']);
  assert.equal(analysis.risks[0]?.level, 'medium');
  assert.equal(analysis.risks[0]?.parts.coveragePenalty, 1);
  assert.equal(analysis.risks[0]?.riskScore, 9.02);
});

test('risk ordering is stable: score desc, then fanout desc, then path Buffer order', () => {
  const leaves = Array.from({ length: 10 }, (_, index) => `src/leaf${String(index).padStart(2, '0')}.ts`);
  const files: GraphSnapshot['files'] = {
    'src/core.ts': fileEntry('src/core.ts'),
    'src/mid.ts': fileEntry('src/mid.ts'),
    'src/x.ts': fileEntry('src/x.ts'),
    'src/y.ts': fileEntry('src/y.ts'),
  };
  const symbols: SymbolNode[] = [symbol('id-core', 'src/core.ts', 'core', 1), symbol('id-mid', 'src/mid.ts', 'mid', 1), symbol('id-x', 'src/x.ts', 'x', 1), symbol('id-y', 'src/y.ts', 'y', 1)];
  const edges: GraphEdge[] = [{ from: 'src/mid.ts', to: 'src/core.ts', kind: 'value-confirmed', provenance: 'resolved', importedNames: ['core'] }];
  const calls: CallEdge[] = [{ from: 'src/mid.ts', to: 'src/core.ts', callee: 'core', line: 1, provenance: 'resolved', label: 'imported' }];
  for (const leaf of leaves) {
    files[leaf] = fileEntry(leaf);
    symbols.push(symbol(`id-${leaf}`, leaf, 'leaf', 1));
    edges.push({ from: leaf, to: 'src/mid.ts', kind: 'value-confirmed', provenance: 'resolved', importedNames: ['mid'] });
    calls.push({ from: leaf, to: 'src/mid.ts', callee: 'mid', line: 1, provenance: 'resolved', label: 'imported' });
  }
  const snapshot: GraphSnapshot = {
    revision: 'rev-risk',
    sourceFingerprint: 'r'.repeat(64),
    files,
    symbols,
    edges,
    calls,
    caveats: emptyCaveats(),
  };

  const first = analyzeStructure(snapshot, { touched: ['src/core.ts'], maxDepth: 3 });
  const second = analyzeStructure(snapshot, { touched: ['src/core.ts'], maxDepth: 3 });
  assert.deepEqual(first.risks, second.risks, 'risk ordering must be deterministic across runs');

  assert.equal(first.risks[0]?.file, 'src/mid.ts');
  assert.equal(first.risks[0]?.level, 'high');
  assert.equal(first.risks[1]?.file, 'src/core.ts');
  assert.equal(first.risks[1]?.level, 'high');
  // Equal score and fanout: path Buffer order decides.
  const xIndex = first.risks.findIndex((risk) => risk.file === 'src/x.ts');
  const yIndex = first.risks.findIndex((risk) => risk.file === 'src/y.ts');
  assert.ok(xIndex >= 0 && yIndex >= 0 && xIndex < yIndex, 'src/x.ts must precede src/y.ts on a tie');
  assert.equal(first.risks[xIndex]?.riskScore, first.risks[yIndex]?.riskScore);

  const leafOrder = first.risks.filter((risk) => risk.file.startsWith('src/leaf')).map((risk) => risk.file);
  assert.deepEqual(leafOrder, [...leaves].sort());
});

test('reverse closure is depth-bounded and cycle-safe', () => {
  const reverse = new Map<string, Set<string>>([
    ['src/a.ts', new Set(['src/c.ts'])],
    ['src/b.ts', new Set(['src/a.ts'])],
    ['src/c.ts', new Set(['src/b.ts'])],
  ]);
  const inScope = new Set(['src/a.ts', 'src/b.ts', 'src/c.ts']);

  const shallow = reverseClosure(reverse, ['src/a.ts'], 1, inScope);
  assert.deepEqual([...shallow.found].sort(), ['src/a.ts', 'src/c.ts']);
  assert.equal(shallow.depthLimited, true, 'a predecessor below the depth bound must be reported');

  const deep = reverseClosure(reverse, ['src/a.ts'], 3, inScope);
  assert.deepEqual([...deep.found].sort(), ['src/a.ts', 'src/b.ts', 'src/c.ts']);
  assert.equal(deep.depthLimited, false);
});

test('nine-way classification covers parsed/zero-symbol/zero-edge/dynamic-only/unsupported/excluded/deleted/degraded/unknown', async () => {
  const root = await writeFixture({
    ...BASE_FIXTURE,
    'src/main.ts': "import { p } from './parsed.js';\nexport const m = p;\n",
    'src/parsed.ts': 'export const p = 1;\n',
    'src/empty.ts': 'export {};\n',
    'src/isolated.ts': 'export const i = 1;\n',
    'src/dyn.ts': "const target = './missing';\nexport const load = () => import(target);\n",
    'src/registry.ts': "import { p } from './parsed.js';\nexport const reg = p;\n",
    'src/generated/skip.ts': 'export const skip = 1;\n',
    'src/gone.ts': 'export const gone = 1;\n',
    'src/broken.ts': 'export const broken = 1;\n',
  });
  const scan: ResolvedProjectScan = await resolveProjectScan({ startRoot: root });

  const first = await GraphStore.open(root, { scan });
  await first.build();
  const previous = first.snapshot();
  first.close();

  await rm(join(root, 'src', 'gone.ts'));
  // Change broken.ts so the content-hash parse cache misses and the read seam
  // is actually exercised; the EACCES then retains the previous data.
  await writeFile(join(root, 'src', 'broken.ts'), 'export const broken = 2;\n');
  const second = await GraphStore.open(root, {
    scan,
    readFile: async (path) => {
      if (path.endsWith('broken.ts')) throw Object.assign(new Error('access denied'), { code: 'EACCES' });
      return readFile(path, 'utf8');
    },
  });
  await second.build();
  const snapshot = second.snapshot();
  second.close();

  assert.ok(collectDegradedFiles(snapshot).has('src/broken.ts'), 'the EACCES retention must be visible as degraded');
  assert.equal(snapshot.files['src/gone.ts'], undefined, 'an ENOENT rebuild drops the file');

  const analysis = analyzeStructure(snapshot, {
    previous,
    excluded: scan.excludes,
    excludedFiles: ['src/generated/skip.ts'],
    unsupportedFiles: ['src/raw.py'],
    semanticGaps: {
      'src/registry.ts': [{ line: 2, pattern: 'registry', reason: 'service registry dispatches by name' }],
    },
  });

  const byFile = new Map(analysis.files.map((row) => [row.file, row]));
  assert.equal(byFile.get('src/main.ts')?.classification, 'parsed');
  assert.equal(byFile.get('src/parsed.ts')?.classification, 'zero-edge');
  assert.equal(byFile.get('src/empty.ts')?.classification, 'zero-symbol');
  assert.equal(byFile.get('src/isolated.ts')?.classification, 'zero-edge');
    // T-116 wiring: `import(target)` is a located `computed-require`, so the
    // main judgment is undecidable and the row is `unknown`, not `dynamic-only`.
    assert.equal(byFile.get('src/dyn.ts')?.classification, 'unknown');
  assert.equal(byFile.get('src/registry.ts')?.classification, 'unknown');
  assert.equal(byFile.get('src/generated/skip.ts')?.classification, 'excluded');
  assert.equal(byFile.get('src/raw.py')?.classification, 'unsupported');
  assert.equal(byFile.get('src/gone.ts')?.classification, 'deleted');
  assert.equal(byFile.get('src/broken.ts')?.classification, 'degraded');

  assert.equal(byFile.get('src/generated/skip.ts')?.inScope, false, 'excluded never enters the denominator');
  assert.equal(byFile.get('src/raw.py')?.inScope, true);
  assert.equal(byFile.get('src/gone.ts')?.inScope, true, 'deleted stays in the in-scope denominator');
  assert.deepEqual(byFile.get('src/gone.ts')?.flags, ['deleted-file']);

  assert.deepEqual(analysis.counts, {
    parsed: 1,
    'zero-symbol': 1,
    'zero-edge': 2,
    'dynamic-only': 0,
    unsupported: 1,
    excluded: 1,
    deleted: 1,
    degraded: 1,
    unknown: 2,
  });
  assert.equal(analysis.metrics.inScope, 9);
  assert.equal(analysis.metrics.blindness, 4 / 9);

  // Every row, including the non-parsed classes, matches its independent baseline.
  for (const row of analysis.files) {
    assert.deepEqual(row, analyzeFileBaseline(snapshot, row.file, {
      previous,
      excluded: scan.excludes,
      excludedFiles: ['src/generated/skip.ts'],
      unsupportedFiles: ['src/raw.py'],
      semanticGaps: { 'src/registry.ts': [{ line: 2, pattern: 'registry', reason: 'service registry dispatches by name' }] },
    }), `batch row ${row.file} must equal its single-file baseline`);
  }
});

test('one store open and one snapshot serve the batch analysis and every file query', async () => {
  const root = await writeFixture({
    ...BASE_FIXTURE,
    'src/main.ts': "import { p } from './parsed.js';\nexport const m = p;\n",
    'src/parsed.ts': 'export const p = 1;\n',
  });
  const scan = await resolveProjectScan({ startRoot: root });
  const counter = { opens: 0, snapshots: 0 };
  const seam: StructureAnalysisStoreSeam = {
    async open(openRoot: string, options?: GraphStoreOpenOptions): Promise<StructureAnalysisStore> {
      counter.opens += 1;
      const store = await GraphStore.open(openRoot, options);
      return {
        async ensureFresh() { return store.ensureFresh(); },
        snapshot() { counter.snapshots += 1; return store.snapshot(); },
        get revision() { return store.revision; },
        close() { store.close(); },
        freshness: () => store.freshness(),
        get buildOutcome() { return store.buildOutcome; },
      };
    },
  };

  const session = await openStructureAnalyzer(root, { seam, storeOptions: { scan } });
  try {
    assert.equal(counter.opens, 1, 'the analyzer must open the graph store exactly once');
    assert.equal(counter.snapshots, 1, 'the analyzer must take exactly one snapshot');
    assert.ok(session.outcome !== undefined);

    const outline = session.outline('src/main.ts');
    assert.equal(outline?.classification, 'parsed');
    assert.equal(outline?.symbols.length, 1);
    assert.equal(outline?.imports.outgoing, 1);
    assert.equal(outline?.dependents.direct, 0);

    const impact = session.impact('src/parsed.ts');
    assert.equal(impact?.classification, 'zero-edge', 'a leaf with symbols but no outgoing edges is advisory zero-edge');
    assert.deepEqual(impact?.direct, ['src/main.ts']);
    assert.deepEqual(impact?.unchanged, []);

    const sets = session.impactSets(['src/parsed.ts']);
    assert.deepEqual(sets.direct, ['src/main.ts']);
    assert.deepEqual(sets.transitive, ['src/main.ts']);

    assert.equal(counter.opens, 1, 'file queries must not reopen the store');
    assert.equal(counter.snapshots, 1, 'file queries must not retake the snapshot');
  } finally {
    session.close();
  }
  assert.equal(session.isClosed, true);
});

test('surface exposes file-level outline/impact and the legacy explore query still works', async () => {
  const root = await writeFixture({
    ...BASE_FIXTURE,
    'src/main.ts': "import { p } from './parsed.js';\nexport const m = p;\n",
    'src/parsed.ts': 'export const p = 1;\n',
  });

  const outline = await structureFileQuery(root, { file: 'src/main.ts', kind: 'outline' });
  assert.equal(outline.query, 'outline:src/main.ts');
  assert.equal(outline.classification, 'parsed');
  assert.equal(outline.total, 1);
  assert.equal(outline.returned, 1);
  assert.equal(outline.truncated, false);
  assert.equal(outline.graphRevision.length > 0, true);
  assert.ok(outline.outline !== undefined);
  assert.deepEqual(outline.impact, []);

  const impactQuery = await structureFileQuery(root, { file: 'src/parsed.ts', kind: 'impact' });
  assert.equal(impactQuery.classification, 'zero-edge');
  assert.deepEqual(impactQuery.impact, ['src/main.ts']);
  assert.ok(impactQuery.impactDetail !== undefined);
  assert.deepEqual(impactQuery.impactDetail?.direct, ['src/main.ts']);

  const report = await structureAnalysis(root, { touched: ['src/parsed.ts'], maxDepth: 3 });
  assert.equal(report['revision'] !== undefined, true);
  const metrics = report['metrics'] as { inScope: number; direct: number; transitive: number; unchanged: number };
  assert.equal(metrics.inScope, 2);
  assert.equal(metrics.direct, 1);
  assert.equal(metrics.transitive, 1);
  assert.equal(metrics.unchanged, 0);
  const risks = report['risks'] as Array<{ file: string }>;
  assert.equal(risks.length, 2);

  const legacy = await explore(root, 'p', 100);
  for (const key of ['query', 'total', 'symbols', 'impact', 'graphRevision', 'freshness', 'caveats', 'truncated', 'status', 'cache', 'stale', 'partial', 'rootResolution']) {
    assert.equal(key in legacy, true, `legacy explore must keep the ${key} field`);
  }
  assert.equal(legacy['query'], 'p');
  assert.ok((legacy['symbols'] as unknown[]).length > 0);
});

test('analysis cache keys on revision plus the exact input set', () => {
  const snapshot = handSnapshot();
  const analysis = analyzeStructure(snapshot, { touched: ['src/c.ts'] });
  const cache = createStructureAnalysisCache();
  const input = { touched: ['src/c.ts'] };
  cache.set(snapshot.revision, input, analysis);
  assert.equal(cache.size, 1);
  assert.equal(cache.get(snapshot.revision, input), analysis);
  assert.equal(cache.get(snapshot.revision, { touched: ['src/b.ts'] }), undefined);
  assert.equal(cache.get('rev-other', input), undefined);
  cache.invalidate(snapshot.revision);
  assert.equal(cache.size, 0);
  assert.equal(cache.get(snapshot.revision, input), undefined);
  assert.equal(structureAnalysisCacheKey(input), structureAnalysisCacheKey({ touched: ['src/c.ts'] }));
  assert.notEqual(structureAnalysisCacheKey(input), structureAnalysisCacheKey({ touched: ['src/b.ts'] }));
  // The key covers the output-affecting options, not just the touched set.
  assert.notEqual(structureAnalysisCacheKey({}), structureAnalysisCacheKey({ weights: { direct: 5 } }));
  assert.equal(structureAnalysisCacheKey({ weights: { direct: 1 } }), structureAnalysisCacheKey({}));
  assert.notEqual(
    structureAnalysisCacheKey({ semanticGaps: { 'src/a.ts': [{ line: 1, pattern: 'registry', reason: 'r' }] } }),
    structureAnalysisCacheKey({ semanticGaps: { 'src/a.ts': [{ line: 2, pattern: 'registry', reason: 'r' }] } }),
  );
});

test('batch analysis reuses the cache for an identical request and invalidates on revision change', async () => {
  const root = await writeFixture({
    ...BASE_FIXTURE,
    'src/main.ts': "import { p } from './parsed.js';\nexport const m = p;\n",
    'src/parsed.ts': 'export const p = 1;\n',
  });
  const scan = await resolveProjectScan({ startRoot: root });
  const counter = { opens: 0, snapshots: 0 };
  let lastSnapshot: GraphSnapshot | undefined;
  const seam: StructureAnalysisStoreSeam = {
    async open(openRoot: string, options?: GraphStoreOpenOptions): Promise<StructureAnalysisStore> {
      counter.opens += 1;
      const store = await GraphStore.open(openRoot, options);
      return {
        async ensureFresh() { return store.ensureFresh(); },
        snapshot() { counter.snapshots += 1; const snapshot = store.snapshot(); lastSnapshot = snapshot; return snapshot; },
        get revision() { return store.revision; },
        close() { store.close(); },
        freshness: () => store.freshness(),
        get buildOutcome() { return store.buildOutcome; },
      };
    },
  };
  const cache = createStructureAnalysisCache();
  const request = { touched: ['src/parsed.ts'], maxDepth: 3, now: () => 1_000_000 };

  const first = await openStructureAnalyzer(root, { ...request, seam, storeOptions: { scan }, cache });
  const firstAnalysis = first.analysis;
  assert.equal(cache.size, 1);
  assert.ok(lastSnapshot !== undefined);
  first.close();

  // Identical input on the same revision: same cached object, no recompute.
  const second = await openStructureAnalyzer(root, { ...request, seam, storeOptions: { scan }, cache });
  assert.equal(second.analysis, firstAnalysis, 'an identical request must be served from the cache');
  assert.equal(cache.size, 1);
  second.outline('src/main.ts');
  second.impact('src/parsed.ts');
  second.impactSets(['src/parsed.ts']);
  assert.equal(counter.opens, 2, 'two analyzer calls open twice; file queries never reopen');
  assert.equal(counter.snapshots, 2, 'file queries never retake the snapshot');
  second.close();

  // A source change produces a new revision; the old entry cannot be reused.
  await writeFile(join(root, 'src', 'added.ts'), 'export const added = 1;\n');
  const builder = await GraphStore.open(root, { scan });
  await builder.build();
  builder.close();
  const third = await openStructureAnalyzer(root, { ...request, seam, storeOptions: { scan }, cache });
  assert.notEqual(third.analysis.revision, firstAnalysis.revision);
  assert.notEqual(third.analysis, firstAnalysis);
  assert.ok(third.analysis.files.some((row) => row.file === 'src/added.ts'));
  assert.equal(cache.size, 2, 'the new revision is cached alongside the old one');
  assert.equal(cache.get(firstAnalysis.revision, request) === firstAnalysis, true, 'the old revision stays valid until explicitly invalidated');
  third.outline('src/added.ts');
  third.close();

  // Cache-miss result equals an uncached analysis field for field (fixed clock).
  const uncached = analyzeStructure(lastSnapshot!, request);
  assert.deepEqual(third.analysis, uncached);
  cache.invalidate(firstAnalysis.revision);
  assert.equal(cache.size, 1);
});

test('registry and eval blind spots are reported while unresolved dynamic loads stay zero', async () => {
  const extractor = await createTsExtractor();
  try {
    const registry = extractor.parse('src/registry.js', [
      "import { p } from './parsed.js';",
      "const fs = require('fs');",
      "const dir = path.join(__dirname, 'plugins');",
      'fs.readdirSync(dir);',
      'eval(userCode);',
      'export const reg = p;',
      '',
    ].join('\n'));
    const evidence = caveatEvidenceFromParsed([registry]);
    // The only dynamic load is a literal require: the unresolved counter is zero.
    assert.equal(registry.dynamicLoads, 1);
    assert.equal(registry.unresolvedDynamicLoads, 0);

    const snapshot: GraphSnapshot = {
      revision: 'rev-registry',
      sourceFingerprint: 'f'.repeat(64),
      files: {
        'src/registry.js': { path: 'src/registry.js', hash: 'h'.repeat(64), dynamicLoads: registry.dynamicLoads },
        'src/parsed.js': fileEntry('src/parsed.js'),
      },
      symbols: [symbol('id-reg', 'src/registry.js', 'reg', 6), symbol('id-parsed', 'src/parsed.js', 'p', 1)],
      edges: [{ from: 'src/registry.js', to: 'src/parsed.js', kind: 'value-confirmed', provenance: 'resolved', importedNames: ['p'] }],
      calls: [],
      caveats: { ...emptyCaveats(), ...evidence, dynamicLoadCount: registry.dynamicLoads },
    };

    const analysis = analyzeStructure(snapshot);
    const row = analysis.files.find((item) => item.file === 'src/registry.js');
    assert.equal(row?.classification, 'unknown', 'registry/reflection evidence must not be judged parsed');
    assert.equal(row?.unresolvedDynamicLoads, 0, 'zero unresolved loads do not erase the blind spot');
    assert.ok(analysis.metrics.blindness > 0, 'blindness must include registry/reflection blind spots');

    const types = new Set(analysis.blindSpots?.map((spot) => spot.type));
    assert.ok(types.has('registry-scan'), 'the directory registry must be an explicit blind-spot type');
    assert.ok(types.has('eval'), 'eval must be an explicit blind-spot type');
    const registrySpot = analysis.blindSpots?.find((spot) => spot.type === 'registry-scan');
    assert.equal(registrySpot?.line, 4);
    assert.ok((registrySpot?.reason.length ?? 0) > 0);
    const evalSpot = analysis.blindSpots?.find((spot) => spot.type === 'eval');
    assert.equal(evalSpot?.line, 5);
    for (const spot of analysis.blindSpots ?? []) {
      assert.equal(spot.file.length > 0, true);
      assert.equal(spot.reason.length > 0, true);
    }

    const manualTypes = new Set(analysis.manualReview?.map((finding) => finding.type));
    assert.ok(manualTypes.has('registry-scan'));
    assert.ok(manualTypes.has('eval'));
    assert.equal(
      analysis.staticFindings?.some((finding) => finding.type === 'registry-scan' || finding.type === 'eval'),
      false,
      'registry/reflection belongs to manual review, not static findings',
    );
    for (const finding of analysis.manualReview ?? []) {
      assert.equal(finding.line !== undefined, true, 'manual-review entries carry a location');
      assert.equal(finding.reason.length > 0, true);
    }

    assert.equal(analysis.dynamicLoads?.resolved, 1);
    assert.ok(((analysis.dynamicLoads?.resolved ?? 0) + (analysis.dynamicLoads?.heuristic ?? 0) + (analysis.dynamicLoads?.unknown ?? 0)) >= 1);
    assert.equal(analysis.coverageConclusion?.unresolvedDynamicLoads, 0);
    assert.ok(analysis.notes.includes(`dynamic-risk-without-unresolved:${analysis.blindSpots?.length ?? 0}`));
    assert.match(analysis.coverageConclusion?.statement ?? '', /not a clean bill of health/);
  } finally {
    extractor.close();
  }
});

test('dynamic loads are counted in resolved/heuristic/unknown tiers with locations', async () => {
  const extractor = await createTsExtractor();
  try {
    const parsed = extractor.parse('src/dynamic.js', [
      "require('./a.js');",
      "require('./mods/' + name);",
      'require(name);',
      "import('./b.js');",
      'import(`./c/${token}`);',
      'export const d = 1;',
      '',
    ].join('\n'));
    const evidence = caveatEvidenceFromParsed([parsed]);
    assert.deepEqual({ ...evidence.dynamicLoadKinds }, { resolved: 2, heuristic: 2, unknown: 1 });

    const snapshot: GraphSnapshot = {
      revision: 'rev-dynamic-tiers',
      sourceFingerprint: 'f'.repeat(64),
      files: { 'src/dynamic.js': { path: 'src/dynamic.js', hash: 'd'.repeat(64), dynamicLoads: parsed.dynamicLoads } },
      symbols: [symbol('id-d', 'src/dynamic.js', 'd', 6)],
      edges: [],
      calls: [],
      caveats: { ...emptyCaveats(), ...evidence, dynamicLoadCount: parsed.dynamicLoads },
    };
    const analysis = analyzeStructure(snapshot);
    assert.equal(analysis.dynamicLoads?.resolved, 2);
    assert.equal(analysis.dynamicLoads?.heuristic, 2);
    assert.equal(analysis.dynamicLoads?.unknown, 1);
    assert.equal((analysis.dynamicLoads?.resolved ?? 0) + (analysis.dynamicLoads?.heuristic ?? 0) + (analysis.dynamicLoads?.unknown ?? 0), 5);
    assert.equal(analysis.sourceDynamicLoads, parsed.dynamicLoads);
    // The fully computed specifier is a located `computed-require`, so the file
    // is `unknown` rather than advisory `dynamic-only` (ADR-010 §4.2).
    assert.equal(analysis.files[0]?.classification, 'unknown');

    const sites = analysis.blindSpots?.filter((spot) => spot.type === 'dynamic-load') ?? [];
    assert.deepEqual(sites.map((site) => site.line), [1, 2, 3, 4, 5]);
    assert.equal(sites.find((site) => site.line === 3)?.pattern, 'computed-require');
    assert.equal(sites.every((site) => site.reason.length > 0 && site.tier !== undefined), true);
    assert.deepEqual(analysis.staticFindings?.filter((finding) => finding.type === 'dynamic-load').map((finding) => finding.tier), ['resolved', 'resolved']);
    assert.deepEqual(analysis.manualReview?.filter((finding) => finding.type === 'dynamic-load').map((finding) => finding.tier), ['heuristic', 'unknown', 'heuristic']);
  } finally {
    extractor.close();
  }
});

test('deleted/excluded/unsupported files are explicitly listed in the coverage report', () => {
  const current: GraphSnapshot = {
    revision: 'rev-deleted',
    sourceFingerprint: 'f'.repeat(64),
    files: { 'src/keep.ts': fileEntry('src/keep.ts'), 'src/dep.ts': fileEntry('src/dep.ts') },
    symbols: [symbol('id-keep', 'src/keep.ts', 'keep', 1), symbol('id-dep', 'src/dep.ts', 'dep', 1)],
    edges: [{ from: 'src/keep.ts', to: 'src/dep.ts', kind: 'value-confirmed', provenance: 'resolved', importedNames: ['dep'] }],
    calls: [],
    caveats: emptyCaveats(),
  };
  const previous: GraphSnapshot = {
    ...current,
    files: { ...current.files, 'src/gone.ts': fileEntry('src/gone.ts') },
  };
  const analysis = analyzeStructure(current, {
    previous,
    excludedFiles: ['src/generated/skip.ts'],
    unsupportedFiles: ['src/raw.py'],
  });

  assert.deepEqual(analysis.deletedFiles, ['src/gone.ts']);
  assert.deepEqual(analysis.excludedFiles, ['src/generated/skip.ts']);
  assert.deepEqual(analysis.unsupportedFiles, ['src/raw.py']);
  assert.equal(analysis.counts.deleted, 1);
  assert.equal(analysis.counts.excluded, 1);
  assert.equal(analysis.counts.unsupported, 1);
  assert.equal(analysis.metrics.inScope, 4);
  assert.ok(analysis.blindSpots?.some((spot) => spot.type === 'deleted' && spot.file === 'src/gone.ts' && spot.reason.length > 0));
  assert.ok(analysis.blindSpots?.some((spot) => spot.type === 'unsupported' && spot.file === 'src/raw.py' && spot.reason.length > 0));
  assert.ok(analysis.notes.includes('deleted-history:1'));
  assert.ok(analysis.notes.includes('excluded-out-of-denominator:1'));
  assert.equal(analysis.staticFindings?.some((finding) => finding.type === 'deleted' && finding.file === 'src/gone.ts'), true);
  assert.equal(analysis.staticFindings?.some((finding) => finding.type === 'unsupported' && finding.file === 'src/raw.py'), true);
  assert.equal(
    analysis.staticFindings?.every((finding) => finding.type !== 'registry-scan' && finding.type !== 'reflection' && finding.type !== 'eval'),
    true,
    'static findings never contain judgment-dependent blind spots',
  );
  assert.equal(analysis.manualReview?.length, 0);
  assert.equal(analysis.coverageConclusion?.unresolvedDynamicLoads, 0);
  assert.ok((analysis.coverageConclusion?.blindSpotCount ?? 0) > 0, 'deletions/unsupported files are still blind spots');
});

test('staticFindings and manualReview are separated by evidence kind', () => {
  const snapshot: GraphSnapshot = {
    revision: 'rev-findings',
    sourceFingerprint: 'f'.repeat(64),
    files: {
      'src/mixed.ts': { path: 'src/mixed.ts', hash: 'm'.repeat(64), dynamicLoads: 3 },
      'src/dep.ts': fileEntry('src/dep.ts'),
    },
    symbols: [symbol('id-mixed', 'src/mixed.ts', 'mixed', 1), symbol('id-dep', 'src/dep.ts', 'dep', 1)],
    edges: [{ from: 'src/mixed.ts', to: 'src/dep.ts', kind: 'value-confirmed', provenance: 'resolved', importedNames: ['dep'] }],
    calls: [],
    caveats: emptyCaveats(),
  };
  const analysis = analyzeStructure(snapshot, {
    blindSpots: {
      'src/mixed.ts': [
        { type: 'dynamic-load', tier: 'resolved', line: 1, pattern: 'require', reason: 'literal specifier' },
        { type: 'dynamic-load', tier: 'heuristic', line: 2, pattern: 'require', reason: 'literal prefix' },
        { type: 'dynamic-load', tier: 'unknown', line: 3, pattern: 'computed-require', reason: 'computed specifier' },
        { type: 'registry-scan', line: 4, pattern: 'registry-scan', reason: 'directory scan registers modules at runtime' },
        { type: 'reflection', line: 5, pattern: 'eval', reason: 'eval cannot be captured statically' },
      ],
    },
  });

  const row = analysis.files.find((item) => item.file === 'src/mixed.ts');
  assert.equal(row?.classification, 'unknown');
  assert.deepEqual(analysis.dynamicLoads, { resolved: 1, heuristic: 1, unknown: 1 });
  assert.equal(analysis.sourceDynamicLoads, 3);
  assert.equal(analysis.staticFindings?.length, 1);
  assert.equal(analysis.staticFindings?.[0]?.type, 'dynamic-load');
  assert.equal(analysis.staticFindings?.[0]?.tier, 'resolved');
  assert.equal(analysis.staticFindings?.[0]?.line, 1);
  assert.deepEqual(analysis.manualReview?.map((finding) => finding.type), ['dynamic-load', 'dynamic-load', 'registry-scan', 'reflection']);
  assert.deepEqual(analysis.manualReview?.map((finding) => finding.line), [2, 3, 4, 5]);
  for (const finding of [...(analysis.staticFindings ?? []), ...(analysis.manualReview ?? [])]) {
    assert.equal(finding.file, 'src/mixed.ts');
    assert.equal(finding.reason.length > 0, true);
  }
});

test('a registry-only file with no static edges still counts toward blindness', () => {
  const snapshot: GraphSnapshot = {
    revision: 'rev-registry-only',
    sourceFingerprint: 'f'.repeat(64),
    files: { 'src/regonly.ts': { path: 'src/regonly.ts', hash: 'r'.repeat(64), dynamicLoads: 0 } },
    symbols: [symbol('id-r', 'src/regonly.ts', 'r', 1)],
    edges: [],
    calls: [],
    caveats: emptyCaveats(),
  };
  const analysis = analyzeStructure(snapshot, {
    blindSpots: {
      'src/regonly.ts': [{ type: 'registry-scan', line: 1, pattern: 'registry-scan', reason: 'readdirSync registers modules at runtime' }],
    },
  });
  assert.equal(analysis.files[0]?.classification, 'unknown', 'a located registry signal is undecidable even without static edges');
  assert.equal(analysis.metrics.inScope, 1);
  assert.equal(analysis.metrics.blindness, 1, 'registry/reflection blind spots belong in the blindness numerator');
  assert.equal(analysis.manualReview?.[0]?.type, 'registry-scan');
  assert.equal(analysis.staticFindings?.length, 0);
});

test('the real buildSnapshot -> analysis chain reports blind spots without injected evidence', async () => {
  const root = await writeFixture({
    ...BASE_FIXTURE,
    'src/main.ts': "import { p } from './parsed.js';\nexport const m = p;\n",
    'src/parsed.ts': 'export const p = 1;\n',
    'src/registry.js': [
      "import { p } from './parsed.js';",
      "const fs = require('fs');",
      "const dir = path.join(__dirname, 'plugins');",
      'fs.readdirSync(dir);',
      'eval(userCode);',
      'export const reg = p;',
      '',
    ].join('\n'),
    'src/dynamic.ts': "const target = './missing';\nexport const load = () => import(target);\n",
  });
  const scan = await resolveProjectScan({ startRoot: root });
  const store = await GraphStore.open(root, { scan });
  await store.build();
  const snapshot = store.snapshot();
  store.close();

  // T-116 wiring: the extractor evidence is on the persisted snapshot itself.
  assert.ok((snapshot.caveats.registryFiles ?? []).includes('src/registry.js'));
  assert.ok((snapshot.caveats.reflectionFiles ?? []).includes('src/registry.js'));
  assert.ok((snapshot.caveats.dynamicLoadKinds?.unknown ?? 0) >= 1);
  assert.ok((snapshot.caveats.dynamicLoadSites ?? []).some((site) => site.file === 'src/dynamic.ts'));

  const analysis = analyzeStructure(snapshot);
  const registry = analysis.files.find((row) => row.file === 'src/registry.js');
  assert.equal(registry?.classification, 'unknown');
  assert.ok(analysis.blindSpots?.some((spot) =>
    spot.type === 'registry-scan' && spot.file === 'src/registry.js' && spot.line === 4 && spot.reason.length > 0));
  assert.ok(analysis.blindSpots?.some((spot) =>
    spot.type === 'eval' && spot.file === 'src/registry.js' && spot.line === 5));
  assert.ok((analysis.coverageConclusion?.blindSpotCount ?? 0) > 0);
  assert.ok(analysis.manualReview?.some((finding) => finding.type === 'registry-scan' && finding.file === 'src/registry.js'));

  // The same evidence survives a SQLite persist/replay round trip byte for byte.
  const reopened = await GraphStore.open(root, { scan });
  assert.deepEqual(reopened.snapshot().caveats, snapshot.caveats);
  assert.deepEqual(analyzeStructure(reopened.snapshot()).blindSpots, analysis.blindSpots);
  reopened.close();
});
