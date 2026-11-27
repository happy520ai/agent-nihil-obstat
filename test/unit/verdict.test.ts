import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { failureExcerpt, outputDigest, parseTestCounts } from '../../src/gate/evidence.ts';
import { verdictForTask } from '../../src/gate/verdict.ts';
import type { Evidence } from '../../src/gate/types.ts';
import { emptyCaveats, type GraphSnapshot } from '../../src/structure/types.ts';

const graph: GraphSnapshot = { revision: 'g1', sourceFingerprint: 'a'.repeat(64), files: { 'a.ts': { path: 'a.ts', hash: '1', dynamicLoads: 0 }, 'a.test.ts': { path: 'a.test.ts', hash: '2', dynamicLoads: 0 } }, symbols: [], edges: [{ from: 'a.test.ts', to: 'a.ts', kind: 'value-confirmed', provenance: 'resolved', importedNames: ['a'] }], caveats: emptyCaveats() };
const evidence: Evidence = { id: randomUUID(), argv: ['node', '--test'], cwd: 'F:/fixture', sourceFingerprint: graph.sourceFingerprint, graphRevision: 'g1', environment: { node: '24', platform: 'win32', arch: 'x64' }, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 1, exitCode: 0, signal: null, timedOut: false, counts: { tests: 1, pass: 1, fail: 0 }, ok: true, outputDigest: outputDigest('pass', '') };

test('a successful current T1 evidence can satisfy task verdict', () => {
  const result = verdictForTask({ task: { id: 'T1', status: 'in_progress', declaredFiles: ['a.ts'] }, touched: [], executedTests: ['a.test.ts'], evidence, graph, freshness: { status: 'fresh', stale: 0 }, policy: { minimum: 'T1', unknown: 'strict' } });
  assert.equal(result.status, 'done');
  assert.equal(result.level, 'T1');
});

test('failed, stale and source-mismatched evidence cannot complete a task', () => {
  for (const change of [{ ok: false }, { sourceFingerprint: 'b'.repeat(64) }, { graphRevision: 'old' }]) {
    const result = verdictForTask({ task: { id: 'T1', status: 'in_progress', declaredFiles: ['a.ts'] }, touched: [], executedTests: ['a.test.ts'], evidence: { ...evidence, ...change }, graph, freshness: { status: 'fresh', stale: 0 }, policy: { minimum: 'T1', unknown: 'strict' } });
    assert.equal(result.status, 'blocked');
  }
  const stale = verdictForTask({ task: { id: 'T1', status: 'in_progress', declaredFiles: ['a.ts'] }, touched: [], executedTests: ['a.test.ts'], evidence, graph, freshness: { status: 'stale', stale: 1 }, policy: { minimum: 'T1', unknown: 'strict' } });
  assert.equal(stale.status, 'blocked');
});

test('test count parsing rejects skipped work via verdict evidence', () => {
  assert.deepEqual(parseTestCounts('# tests 3\n# pass 2\n# skipped 1\n'), { tests: 3, pass: 2, skipped: 1 });
  const result = verdictForTask({ task: { id: 'T1', status: 'in_progress', declaredFiles: ['a.ts'] }, touched: [], executedTests: ['a.test.ts'], evidence: { ...evidence, ok: false, counts: { tests: 3, pass: 2, skipped: 1 } }, graph, freshness: { status: 'fresh', stale: 0 }, policy: { minimum: 'T1', unknown: 'strict' } });
  assert.equal(result.status, 'blocked');
});

test('failure excerpt does not retain obvious token assignments', () => {
  assert.doesNotMatch(failureExcerpt('Error: token=abc123') ?? '', /abc123/);
});
