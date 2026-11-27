import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeStructure } from '../../src/structure/analysis.ts';
import {
  DEFAULT_RISK_THRESHOLDS,
  DEFAULT_RISK_WEIGHTS,
  assessRisk,
  detectIifeFiles,
  isTestFile,
} from '../../src/structure/risk.ts';
import {
  emptyCaveats,
  type CallEdge,
  type GraphEdge,
  type GraphSnapshot,
  type SourceFile,
  type SymbolNode,
} from '../../src/structure/types.ts';

const fileEntry = (path: string, dynamicLoads = 0): SourceFile => ({
  path,
  hash: `${path.length}${'0'.repeat(63)}`,
  dynamicLoads,
});

const sym = (id: string, file: string, name: string, startLine = 1, qualifiedName?: string): SymbolNode => ({
  id,
  file,
  name,
  qualifiedName: qualifiedName ?? name,
  symbolKind: 'value',
  startLine,
});

const importEdge = (from: string, to: string): GraphEdge => ({
  from,
  to,
  kind: 'value-confirmed',
  provenance: 'resolved',
  importedNames: ['x'],
});

function makeSnapshot(
  files: Record<string, SourceFile>,
  symbols: SymbolNode[],
  edges: GraphEdge[],
  calls: CallEdge[] = [],
  revision = 'rev-risk',
): GraphSnapshot {
  return { revision, sourceFingerprint: 'f'.repeat(64), files, symbols, edges, calls, caveats: emptyCaveats() };
}

/** core <- mid <- 10 leaves, plus two isolated files x/y. */
function hubSnapshot(revision = 'rev-hub'): GraphSnapshot {
  const files: Record<string, SourceFile> = {};
  const symbols: SymbolNode[] = [];
  const edges: GraphEdge[] = [];
  const add = (path: string): void => {
    files[path] = fileEntry(path);
    symbols.push(sym(`id-${path}`, path, path));
  };
  add('src/core.ts');
  add('src/mid.ts');
  add('src/x.ts');
  add('src/y.ts');
  edges.push(importEdge('src/mid.ts', 'src/core.ts'));
  for (let index = 0; index < 10; index += 1) {
    const leaf = `src/leaf${String(index).padStart(2, '0')}.ts`;
    add(leaf);
    edges.push(importEdge(leaf, 'src/mid.ts'));
  }
  return makeSnapshot(files, symbols, edges, [], revision);
}

function collectKeys(value: unknown, keys: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      keys.add(key);
      collectKeys(nested, keys);
    }
  }
}

test('risk rows are explainable, stable, and ordered score desc / fanout desc / path Buffer order', () => {
  const analysis = analyzeStructure(hubSnapshot(), { touched: ['src/core.ts'], maxDepth: 3 });
  const first = assessRisk(analysis, { snapshot: hubSnapshot() });
  const second = assessRisk(analysis, { snapshot: hubSnapshot() });
  assert.deepEqual(first.rows, second.rows, 'risk grading must be deterministic across runs');

  assert.equal(first.rows[0]?.file, 'src/mid.ts');
  assert.equal(first.rows[1]?.file, 'src/core.ts');

  for (const row of first.rows) {
    const parts = row.parts;
    assert.equal(parts.direct + parts.transitive + parts.touched, parts.impactScore, `${row.file} impact parts must add up`);
    assert.ok(
      Math.abs(parts.impactScore + parts.coverageBlindness + parts.sharedDependencies + parts.fanoutTerm + parts.complexityTerm - parts.riskScore) < 1e-9,
      `${row.file} riskScore must be the sum of every explained part`,
    );
    assert.equal(row.riskScore, parts.riskScore);
    assert.ok(row.rationale.length > 0);
  }

  // Shared-dependency identity: core is shared by the high-impact consumer mid.
  const core = first.rows.find((row) => row.file === 'src/core.ts');
  assert.deepEqual(core?.sharedBy, ['src/mid.ts']);
  assert.equal(core?.parts.sharedDependencies, DEFAULT_RISK_WEIGHTS.sharedPerConsumer);

  // Equal score: path Buffer order decides (src/x.ts before src/y.ts, both zero).
  const xIndex = first.rows.findIndex((row) => row.file === 'src/x.ts');
  const yIndex = first.rows.findIndex((row) => row.file === 'src/y.ts');
  assert.ok(xIndex >= 0 && yIndex >= 0 && xIndex < yIndex, 'src/x.ts must precede src/y.ts on a tie');
  assert.equal(first.rows[xIndex]?.riskScore, first.rows[yIndex]?.riskScore);

  // Scores never increase down the list.
  for (let index = 1; index < first.rows.length; index += 1) {
    const previous = first.rows[index - 1];
    const current = first.rows[index];
    assert.ok(previous !== undefined && current !== undefined);
    assert.ok(previous.riskScore > current.riskScore
      || (previous.riskScore === current.riskScore && previous.fanout > current.fanout)
      || (previous.riskScore === current.riskScore && previous.fanout === current.fanout
        && Buffer.from(previous.file).compare(Buffer.from(current.file)) < 0),
    'ordering must follow score desc, fanout desc, path Buffer order');
  }
});

test('recommended tests are reverse-mapped to exact files with precise reasons and honest gaps', () => {
  const base = hubSnapshot();
  const files = { ...base.files };
  const symbols = [...base.symbols];
  const edges = [...base.edges];
  for (const path of ['test/core.test.ts', 'test/mid.test.ts', 'src/orphan.ts']) {
    files[path] = fileEntry(path);
    symbols.push(sym(`id-${path}`, path, path));
  }
  edges.push(importEdge('test/core.test.ts', 'src/core.ts'));
  edges.push(importEdge('test/mid.test.ts', 'src/mid.ts'));
  const snapshot = makeSnapshot(files, symbols, edges, [], 'rev-recommend');
  const analysis = analyzeStructure(snapshot, { touched: ['src/core.ts'], maxDepth: 3 });
  const plan = assessRisk(analysis, { snapshot });

  const core = plan.rows.find((row) => row.file === 'src/core.ts');
  assert.ok(core, 'core row must exist');
  assert.deepEqual(core.recommendation.coveringTests, ['test/core.test.ts', 'test/mid.test.ts']);
  assert.equal(core.recommendation.noCoveringTest, false);
  assert.match(core.recommendation.reason, /covering tests: test\/core\.test\.ts, test\/mid\.test\.ts/);

  const orphan = plan.rows.find((row) => row.file === 'src/orphan.ts');
  assert.ok(orphan);
  assert.deepEqual(orphan.recommendation.coveringTests, []);
  assert.equal(orphan.recommendation.noCoveringTest, true, 'an unreachable file must be reported as a gap, never given a fake test');
  assert.match(orphan.recommendation.reason, /noCoveringTest=true/);

  // Recommendations aggregate per test file with the covered file list and a reason.
  const byTest = new Map(plan.recommendations.map((item) => [item.testFile, item]));
  assert.ok(byTest.has('test/core.test.ts'));
  assert.ok(byTest.has('test/mid.test.ts'));
  const midRecommendation = byTest.get('test/mid.test.ts');
  assert.ok(midRecommendation);
  assert.ok(midRecommendation.covers.includes('src/core.ts'));
  assert.ok(midRecommendation.covers.includes('src/mid.ts'));
  assert.match(midRecommendation.reason, /reaches \d+ affected file\(s\)/);
  assert.ok(['high', 'medium'].includes(midRecommendation.riskLevel));

  // Every recommended test path is real and test-shaped; low-risk leaves are not forced in.
  for (const recommendation of plan.recommendations) {
    assert.ok(isTestFile(recommendation.testFile));
    assert.ok(snapshot.files[recommendation.testFile] !== undefined);
    for (const covered of recommendation.covers) {
      const row = plan.rows.find((candidate) => candidate.file === covered);
      assert.ok(row && row.level !== 'low', 'aggregate recommendations must exclude skippable low-risk files');
    }
  }
  const leavesRecommended = plan.recommendations.flatMap((item) => item.covers).filter((file) => file.startsWith('src/leaf'));
  assert.deepEqual(leavesRecommended, [], 'untouched low-risk leaves must not be recommended wholesale');
});

test('zero-symbol, IIFE and dynamic/registry blind spots produce manual-review items without evidence ids', () => {
  const files: Record<string, SourceFile> = {
    'src/empty.js': fileEntry('src/empty.js'),
    'src/iife.js': fileEntry('src/iife.js'),
    'src/dyn.js': fileEntry('src/dyn.js'),
    'src/dep.js': fileEntry('src/dep.js'),
  };
  const symbols = [
    sym('id-iife', 'src/iife.js', 'local', 4, 'src/iife.js#<iife>.local'),
    sym('id-dyn', 'src/dyn.js', 'dyn', 1),
    sym('id-dep', 'src/dep.js', 'dep', 1),
  ];
  const edges = [importEdge('src/iife.js', 'src/dep.js'), importEdge('src/dyn.js', 'src/dep.js')];
  const snapshot = makeSnapshot(files, symbols, edges, [], 'rev-blind');
  const analysis = analyzeStructure(snapshot, {
    blindSpots: {
      'src/dyn.js': [{ type: 'dynamic-load', tier: 'unknown', line: 3, pattern: 'computed-require', reason: 'computed specifier' }],
      'src/iife.js': [{ type: 'reflection', line: 8, pattern: 'eval', reason: 'eval target not static' }],
    },
  });
  const plan = assessRisk(analysis, { snapshot });

  const kinds = new Set(plan.reviewItems.map((item) => item.kind));
  assert.ok(kinds.has('zero-symbol'), 'zero-symbol must be reviewed');
  assert.ok(kinds.has('dynamic-load'), 'dynamic blind spot must be reviewed');
  assert.ok(kinds.has('reflection') || kinds.has('eval'), 'registry/reflection blind spot must be reviewed');
  assert.ok(plan.reviewItems.some((item) => item.pattern === 'iife-nested-scope'), 'IIFE scope must be an explicit review item');

  const empty = plan.reviewItems.find((item) => item.kind === 'zero-symbol' && item.file === 'src/empty.js');
  assert.ok(empty);
  assert.match(empty.reason, /IIFE|nested-scope|CommonJS/);
  assert.match(empty.suggestedAction, /IIFE/);

  const dynamic = plan.reviewItems.find((item) => item.kind === 'dynamic-load' && item.file === 'src/dyn.js');
  assert.ok(dynamic);
  assert.equal(dynamic.line, 3);

  for (const item of plan.reviewItems) {
    assert.ok(item.reason.length > 0);
    assert.ok(item.suggestedAction.length > 0);
    assert.equal(item.evidenceRevision, analysis.revision);
    assert.equal('evidenceId' in item, false, 'review items never carry an evidence id');
    assert.equal('evidence_id' in item, false);
  }

  const keys = new Set<string>();
  collectKeys(JSON.parse(JSON.stringify(plan)), keys);
  assert.equal([...keys].some((key) => /evidence_?id/i.test(key)), false, 'no plan field may look like an evidence id');
  assert.ok(plan.notes.includes('risk-not-evidence:review-items-are-inputs-only'));
});

test('three-tier behaviour differs: high reviews and tests, medium tests, low skips with a reason', () => {
  const base = hubSnapshot();
  const files = { ...base.files };
  const symbols = [...base.symbols];
  const edges = [...base.edges];
  const add = (path: string): void => {
    files[path] = fileEntry(path);
    symbols.push(sym(`id-${path}`, path, path));
  };
  add('src/medium.ts');
  // Four consumers keep the file at impact 4 + 2*4 = 12: medium band, not high.
  for (let index = 0; index < 4; index += 1) {
    const consumer = `src/consumer${index}.ts`;
    add(consumer);
    edges.push(importEdge(consumer, 'src/medium.ts'));
  }
  const snapshot = makeSnapshot(files, symbols, edges, [], 'rev-tiers');
  const analysis = analyzeStructure(snapshot, { touched: ['src/core.ts'], maxDepth: 3, excludedFiles: ['src/generated/skip.ts'] });
  const plan = assessRisk(analysis, { snapshot });

  assert.ok(plan.counts.high >= 2, 'hub files must be high');
  assert.ok(plan.counts.medium >= 1, 'the eight-consumer file must be medium');
  assert.ok(plan.counts.low >= 1, 'isolated leaves must be low');
  assert.ok(plan.skippedLow >= 1, 'low files must be explicitly skippable');

  const levelOf = (file: string): string | undefined => plan.rows.find((row) => row.file === file)?.level;
  assert.equal(levelOf('src/mid.ts'), 'high');
  assert.equal(levelOf('src/core.ts'), 'high');
  assert.equal(levelOf('src/medium.ts'), 'medium');
  assert.equal(levelOf('src/x.ts'), 'low');

  const dispositionOf = (file: string): string | undefined => plan.rows.find((row) => row.file === file)?.disposition;
  assert.equal(dispositionOf('src/mid.ts'), 'review-and-test');
  assert.equal(dispositionOf('src/core.ts'), 'review-and-test');
  assert.equal(dispositionOf('src/medium.ts'), 'test');
  assert.equal(dispositionOf('src/x.ts'), 'skip');
  assert.match(plan.rows.find((row) => row.file === 'src/x.ts')?.rationale ?? '', /skip/);

  // Not one-size-fits-all: some files require review+tests, others are justified skips.
  assert.ok(plan.rows.some((row) => row.disposition === 'review-and-test'));
  assert.ok(plan.rows.some((row) => row.disposition === 'test'));
  assert.ok(plan.rows.some((row) => row.disposition === 'skip'));

  // No aggregate recommendation targets a low-risk file; no low file is forced into full verification.
  assert.ok(plan.recommendations.every((item) => item.riskLevel !== 'low'));
  assert.ok(plan.recommendations.every((item) => item.covers.every((file) => levelOf(file) !== 'low')));

  // Excluded files stay out of the denominator entirely.
  assert.equal(plan.rows.some((row) => row.file === 'src/generated/skip.ts'), false);
  assert.ok(plan.notes.includes('excluded-out-of-risk-grading:1'));
  assert.ok(plan.snapshotRevisionMatched);
});

test('weights and thresholds are exported, normalised, and respected', () => {
  const analysis = analyzeStructure(hubSnapshot(), { touched: ['src/core.ts'], maxDepth: 3 });
  assert.equal(DEFAULT_RISK_WEIGHTS.sharedPerConsumer, 2);
  assert.equal(DEFAULT_RISK_WEIGHTS.blindPenalty, 2);
  assert.equal(DEFAULT_RISK_THRESHOLDS.high, 20);
  assert.equal(DEFAULT_RISK_THRESHOLDS.medium, 8);

  const relaxed = assessRisk(analysis, {
    snapshot: hubSnapshot(),
    weights: { sharedPerConsumer: 0, direct: 1, transitive: 1 },
    thresholds: { high: 10_000, medium: 10_000, highFanout: 10_000 },
  });
  assert.equal(relaxed.weights.sharedPerConsumer, 0);
  assert.equal(relaxed.weights.direct, 1);
  assert.equal(relaxed.weights.transitive, 1);
  assert.equal(relaxed.thresholds.medium, 10_000);
  assert.equal(relaxed.counts.high, 0, 'raised thresholds must keep hub files out of the high band');
  assert.equal(relaxed.counts.low, relaxed.rows.length);
});

test('without a snapshot the plan degrades honestly: disabled mapping, zero shared term, no fabricated tests', () => {
  const analysis = analyzeStructure(hubSnapshot(), { touched: ['src/core.ts'], maxDepth: 3 });
  const plan = assessRisk(analysis);
  assert.ok(plan.rows.length > 0);
  assert.equal(plan.snapshotRevisionMatched, false, 'without a snapshot there is no revision to match');
  assert.ok(plan.notes.includes('snapshot-unavailable:test-recommendations-disabled'));
  assert.ok(plan.notes.includes('snapshot-unavailable:shared-dependencies-disabled'));
  for (const row of plan.rows) {
    assert.equal(row.parts.sharedDependencies, 0);
    assert.deepEqual(row.recommendation.coveringTests, []);
    assert.equal(row.recommendation.noCoveringTest, true);
  }
  assert.deepEqual(plan.recommendations, []);
  assert.ok(plan.testGaps.length > 0, 'high/medium files without tests remain visible gaps');
});

test('isTestFile recognises test paths without treating source files as tests', () => {
  for (const path of ['test/a.test.ts', 'src/a.spec.ts', 'tests/helper.cjs', '__tests__/x.ts', 'test/unit/deep.ts', 'tests/nested/a.cjs']) {
    assert.equal(isTestFile(path), true, path);
  }
  for (const path of ['src/a.ts', 'src/test-util.ts', 'src/index.cjs']) {
    assert.equal(isTestFile(path), false, path);
  }
});

test('detectIifeFiles finds captured nested scopes and ignores ordinary files', () => {
  const snapshot = makeSnapshot(
    { 'src/iife.js': fileEntry('src/iife.js'), 'src/plain.ts': fileEntry('src/plain.ts') },
    [sym('id-1', 'src/iife.js', 'local', 3, 'src/iife.js#<iife>.local'), sym('id-2', 'src/plain.ts', 'plain', 1)],
    [],
    [],
    'rev-iife-detect',
  );
  assert.deepEqual(detectIifeFiles(snapshot), ['src/iife.js']);
});
