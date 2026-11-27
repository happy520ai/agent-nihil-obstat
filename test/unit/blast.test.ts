import assert from 'node:assert/strict';
import test from 'node:test';
import { blastRadius, impact, testCoverage } from '../../src/gate/blast.ts';
import { emptyCaveats, type GraphEdge, type GraphSnapshot } from '../../src/structure/types.ts';

const edge = (from: string, to: string, kind: GraphEdge['kind'] = 'value-confirmed', provenance: GraphEdge['provenance'] = 'resolved'): GraphEdge => ({ from, to, kind, provenance, importedNames: ['x'] });
const graph = (edges: GraphEdge[]): GraphSnapshot => ({ revision: 'r1', sourceFingerprint: 'f1', files: {}, symbols: [], edges, caveats: emptyCaveats() });

test('impact takes the transitive reverse dependency superset', () => {
  assert.deepEqual(impact(graph([edge('b.ts', 'a.ts'), edge('c.ts', 'a.ts', 'unknown'), edge('d.ts', 'b.ts', 'type-only')]), ['a.ts']), ['a.ts', 'b.ts', 'c.ts', 'd.ts']);
});

test('coverage only walks value-confirmed edges from executed tests', () => {
  const snapshot = graph([edge('a.test.ts', 'a.ts'), edge('b.test.ts', 'b.ts', 'type-only'), edge('c.test.ts', 'c.ts', 'unknown')]);
  assert.deepEqual([...testCoverage(snapshot, ['a.test.ts', 'b.test.ts', 'c.test.ts'])].sort(), ['a.test.ts', 'a.ts', 'b.test.ts', 'c.test.ts']);
});

test('strict coverage reports consumers not reached by executed tests', () => {
  const snapshot = graph([edge('b.test.ts', 'b.ts'), edge('c.ts', 'a.ts')]);
  assert.deepEqual(blastRadius(snapshot, ['a.ts'], ['b.test.ts'], { minimum: 'T1', unknown: 'strict' }).uncovered, ['a.ts', 'c.ts']);
});

test('advisory does not promote unknown to coverage', () => {
  const snapshot = graph([edge('c.ts', 'a.ts', 'unknown')]);
  const result = blastRadius(snapshot, ['a.ts'], [], { minimum: 'T1', unknown: 'advisory' });
  assert.deepEqual(result.covered, []);
  assert.deepEqual(result.advisory, ['c.ts']);
  assert.deepEqual(result.uncovered, ['a.ts']);
});

function riskGraph(): GraphSnapshot {
  const files: GraphSnapshot['files'] = {};
  const symbols: GraphSnapshot['symbols'] = [];
  const edges: GraphEdge[] = [];
  const add = (path: string): void => {
    files[path] = fileEntry(path);
    symbols.push({ id: `id-${path}`, file: path, name: path, qualifiedName: path, symbolKind: 'value', startLine: 1 });
  };
  add('src/core.ts');
  add('src/mid.ts');
  add('src/x.ts');
  add('src/y.ts');
  edges.push(edge('src/mid.ts', 'src/core.ts'));
  for (let index = 0; index < 10; index += 1) {
    const leaf = `src/leaf${String(index).padStart(2, '0')}.ts`;
    add(leaf);
    edges.push(edge(leaf, 'src/mid.ts'));
  }
  return { revision: 'rev-blast-risk', sourceFingerprint: 'f'.repeat(64), files, symbols, edges, caveats: emptyCaveats() };
}

function fileEntry(path: string): { path: string; hash: string; dynamicLoads: number } {
  return { path, hash: `${path.length}${'0'.repeat(63)}`, dynamicLoads: 0 };
}

test('default blast radius keeps its exact old shape and semantics', () => {
  const snapshot = riskGraph();
  const result = blastRadius(snapshot, ['src/core.ts'], [], { minimum: 'T1', unknown: 'strict' });
  assert.deepEqual(Object.keys(result).sort(), ['advisory', 'covered', 'impacted', 'uncovered']);
  assert.equal('risk' in result, false);
  assert.deepEqual(result, blastRadius(snapshot, ['src/core.ts'], [], { minimum: 'T1', unknown: 'strict' }));
});

test('optional risk grading attaches a summary without changing the blast arrays', () => {
  const snapshot = riskGraph();
  const policy = { minimum: 'T1' as const, unknown: 'strict' as const };
  const base = blastRadius(snapshot, ['src/core.ts'], [], policy);
  const graded = blastRadius(snapshot, ['src/core.ts'], [], policy, { risk: {} });
  assert.ok(graded.risk, 'requesting risk must attach the summary');
  assert.equal(graded.risk.revision, snapshot.revision);
  assert.equal(graded.risk.levels['src/mid.ts'], 'high');
  assert.equal(graded.risk.levels['src/core.ts'], 'high');
  assert.equal(graded.risk.levels['src/x.ts'], 'low');
  assert.equal(graded.risk.counts.high, 2);
  assert.ok(graded.risk.counts.medium >= 0 && graded.risk.counts.low >= 1);
  // High centers ordered by fanout desc, then path Buffer order (mid fanout 1, core 0).
  assert.deepEqual(graded.risk.highCenters, ['src/mid.ts', 'src/core.ts']);
  assert.ok(graded.risk.testGaps.includes('src/mid.ts'));
  assert.ok(graded.risk.reviewCount > 0);
  assert.equal(JSON.stringify(graded.risk).includes('evidence_id'), false);
  assert.equal(JSON.stringify(graded.risk).includes('evidenceId'), false);

  assert.deepEqual(graded.impacted, base.impacted);
  assert.deepEqual(graded.covered, base.covered);
  assert.deepEqual(graded.uncovered, base.uncovered);
  assert.deepEqual(graded.advisory, base.advisory);
});

test('risk grading respects caller-supplied weights and thresholds', () => {
  const snapshot = riskGraph();
  const graded = blastRadius(snapshot, ['src/core.ts'], [], { minimum: 'T0', unknown: 'strict' }, {
    risk: { thresholds: { high: 10_000, medium: 10_000, highFanout: 10_000 } },
  });
  assert.ok(graded.risk);
  assert.equal(graded.risk.counts.high, 0);
  assert.equal(graded.risk.counts.low, Object.keys(graded.risk.levels).length);
  assert.deepEqual(graded.risk.highCenters, []);
});
