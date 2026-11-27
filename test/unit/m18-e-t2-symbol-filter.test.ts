import assert from 'node:assert/strict';
import test from 'node:test';
import { t2Coverage } from '../../src/structure/t2.ts';
import { emptyCaveats, type GraphSnapshot } from '../../src/structure/types.ts';
import { m18eFileEntry, m18eSymbol } from '../helpers/m18-e-fixtures.ts';

test('T2 covers affected value symbols through resolved calls only and maps their files', () => {
  const snapshot: GraphSnapshot = {
    revision: 'rev-t2-e',
    sourceFingerprint: 'f'.repeat(64),
    files: {
      'test/a.test.ts': m18eFileEntry('test/a.test.ts'),
      'src/x.ts': m18eFileEntry('src/x.ts'),
      'src/y.ts': m18eFileEntry('src/y.ts'),
      'src/z.ts': m18eFileEntry('src/z.ts'),
    },
    symbols: [
      m18eSymbol('id-test', 'test/a.test.ts', 'suite', 1),
      m18eSymbol('id-x', 'src/x.ts', 'x', 1),
      m18eSymbol('id-y', 'src/y.ts', 'y', 1),
      { ...m18eSymbol('id-type', 'src/y.ts', 'Y', 2), symbolKind: 'type' as const },
      m18eSymbol('id-z', 'src/z.ts', 'z', 1),
    ],
    edges: [],
    calls: [
      {
        from: 'test/a.test.ts',
        to: 'src/x.ts',
        callee: 'x',
        line: 2,
        provenance: 'resolved',
        label: 'imported',
        callerSymbolId: 'id-test',
        calleeSymbolId: 'id-x',
      },
      {
        from: 'test/a.test.ts',
        to: 'src/y.ts',
        callee: 'y',
        line: 3,
        provenance: 'resolved',
        label: 'imported',
        callerSymbolId: 'id-test',
        calleeSymbolId: 'id-y',
      },
      {
        from: 'test/a.test.ts',
        to: 'src/z.ts',
        callee: 'z',
        line: 4,
        provenance: 'heuristic',
        label: 'member',
        callerSymbolId: 'id-test',
        calleeSymbolId: 'id-z',
      },
    ],
    caveats: emptyCaveats(),
  };

  const report = t2Coverage(snapshot, ['test/a.test.ts'], ['src/x.ts', 'src/y.ts', 'src/z.ts']);

  assert.equal(report.applicable, true);
  assert.equal(report.satisfied, false, 'the heuristic-only z symbol is not covered');
  assert.deepEqual(report.affectedSymbols, ['id-x', 'id-y', 'id-z'], 'a type-only touched symbol is not affected');
  assert.deepEqual(report.coveredSymbols, ['id-x', 'id-y']);
  assert.deepEqual(report.uncoveredSymbols, ['id-z']);
  assert.deepEqual(report.reachableSymbols, ['id-test', 'id-x', 'id-y'], 'only resolved call targets are reachable');
  assert.deepEqual(report.coveredFiles, ['src/x.ts', 'src/y.ts']);
  assert.equal(report.edgesUsed, 'resolved-call-edges');
  assert.equal(report.resolvedCallEdges, 2);
});
