import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeStructure } from '../../src/structure/analysis.ts';
import { assessRisk } from '../../src/structure/risk.ts';
import { emptyCaveats, type GraphSnapshot } from '../../src/structure/types.ts';
import { m18eFileEntry, m18eSymbol } from '../helpers/m18-e-fixtures.ts';

test('risk review seeds keep their origin, carry the analysis revision, and expose snapshot mismatch', () => {
  const snapshot: GraphSnapshot = {
    revision: 'rev-risk-e',
    sourceFingerprint: 'f'.repeat(64),
    files: {
      'src/core.ts': m18eFileEntry('src/core.ts'),
      'src/a.ts': m18eFileEntry('src/a.ts'),
      'src/b.ts': m18eFileEntry('src/b.ts'),
    },
    symbols: [
      m18eSymbol('id-core', 'src/core.ts', 'core', 1),
      m18eSymbol('id-a', 'src/a.ts', 'a', 1),
      m18eSymbol('id-b', 'src/b.ts', 'b', 1),
    ],
    edges: [
      { from: 'src/a.ts', to: 'src/core.ts', kind: 'value-confirmed', provenance: 'resolved', importedNames: ['core'] },
      { from: 'src/b.ts', to: 'src/core.ts', kind: 'value-confirmed', provenance: 'resolved', importedNames: ['core'] },
    ],
    calls: [],
    caveats: emptyCaveats(),
  };
  const analysis = analyzeStructure(snapshot, {
    touched: ['src/core.ts'],
    maxDepth: 3,
    blindSpots: {
      'src/a.ts': [{ type: 'registry-scan', line: 1, pattern: 'registry-scan', reason: 'directory scan registers modules at runtime' }],
    },
  });

  const plan = assessRisk(analysis, { snapshot: { ...snapshot, revision: 'rev-mismatch' } });

  assert.equal(plan.snapshotRevisionMatched, false);
  assert.ok(plan.notes.includes('revision-mismatch:snapshot=rev-mismatch,analysis=rev-risk-e'));

  const origins = new Set(plan.reviewItems.map((item) => item.origin));
  assert.ok(origins.has('manual-review'), 'located registry evidence stays a manual-review input');
  assert.ok(origins.has('classification'), 'the isolated zero-edge file stays a classification input');

  const registry = plan.reviewItems.find((item) => item.kind === 'registry' && item.file === 'src/a.ts');
  assert.ok(registry);
  assert.equal(registry.line, 1);
  assert.equal(registry.origin, 'manual-review');

  for (const item of plan.reviewItems) {
    assert.equal(item.evidenceRevision, analysis.revision);
    assert.equal('evidenceId' in item, false);
    assert.equal('evidence_id' in item, false);
    assert.ok(item.reason.length > 0);
  }
});
