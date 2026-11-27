import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import test from 'node:test';
import type { SourceFingerprint } from '../../src/core/fingerprint.ts';
import { resolveProjectScan } from '../../src/core/project-scan.ts';
import { buildSnapshot } from '../../src/structure/extractor.ts';
import { GraphStore } from '../../src/structure/store.ts';
import { emptyCaveats, type GraphSnapshot } from '../../src/structure/types.ts';
import { M18E_BASE_FILES, m18eFileEntry, m18eSymbol, writeM18EFixture } from '../helpers/m18-e-fixtures.ts';

test('an aliased object-literal member call runs the class-member fallback without inventing an edge', async () => {
  const root = await writeM18EFixture({
    ...M18E_BASE_FILES,
    'tsconfig.json': JSON.stringify({ compilerOptions: {} }),
    'src/foo.ts': [
      'const impl = { bar(): number { return 1; } };',
      'export { impl as Foo };',
      '',
    ].join('\n'),
    'src/main.ts': [
      "import { Foo } from './foo.js';",
      'export const x = Foo.bar();',
      '',
    ].join('\n'),
  });
  try {
    const scan = await resolveProjectScan({ startRoot: root });
    const store = await GraphStore.open(root, { scan });
    await store.build();
    const snapshot = store.snapshot();

    // The imported alias still yields a resolved value-confirmed import edge...
    assert.ok(snapshot.edges.some((edge) => edge.from === 'src/main.ts' && edge.to === 'src/foo.ts' && edge.provenance === 'resolved'));
    // ...but the object method has no class-qualified member target, so the call
    // stays explicitly unresolved instead of being guessed into the call graph.
    assert.deepEqual(snapshot.calls, []);
    assert.equal(snapshot.caveats.unresolvedCallSites, 1);
    assert.equal(snapshot.caveats.resolvedCallEdges, 0);
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a degraded directory retains the previous file, symbol, import edge and call edge', async () => {
  const root = await writeM18EFixture({
    ...M18E_BASE_FILES,
    'tsconfig.json': JSON.stringify({ compilerOptions: {} }),
    'src/keep.ts': 'export const k = 1;\n',
  });
  try {
    const previous: GraphSnapshot = {
      revision: 'rev-previous',
      sourceFingerprint: 'p'.repeat(64),
      files: {
        'src/old/a.ts': m18eFileEntry('src/old/a.ts'),
        'src/gone.ts': m18eFileEntry('src/gone.ts'),
      },
      symbols: [m18eSymbol('id-a', 'src/old/a.ts', 'a', 1), m18eSymbol('id-gone', 'src/gone.ts', 'gone', 1)],
      edges: [
        { from: 'src/old/a.ts', to: 'src/keep.ts', kind: 'value-confirmed', provenance: 'resolved', importedNames: ['k'] },
        { from: 'src/gone.ts', to: 'src/keep.ts', kind: 'value-confirmed', provenance: 'resolved', importedNames: ['k'] },
      ],
      calls: [
        { from: 'src/old/a.ts', to: 'src/keep.ts', callee: 'k', line: 2, provenance: 'resolved', label: 'imported', calleeSymbolId: 'id-k' },
        { from: 'src/gone.ts', to: 'src/keep.ts', callee: 'k', line: 2, provenance: 'resolved', label: 'imported', calleeSymbolId: 'id-k' },
      ],
      caveats: emptyCaveats(),
    };
    const fingerprint: SourceFingerprint = {
      hash: 'degraded-tree',
      files: [],
      degraded: [{ path: 'src/old', code: 'EACCES', status: 'permission-denied' }],
    };

    const { snapshot, report } = await buildSnapshot({ root, fingerprint, previous });

    assert.equal(snapshot.files['src/old/a.ts']?.path, 'src/old/a.ts', 'the degraded subtree is retained');
    assert.equal(snapshot.files['src/gone.ts'], undefined, 'a healthy deleted file is not retained');
    assert.deepEqual(snapshot.symbols.map((symbol) => symbol.id), ['id-a']);
    assert.deepEqual(snapshot.edges.map((edge) => edge.from), ['src/old/a.ts']);
    assert.deepEqual((snapshot.calls ?? []).map((call) => call.from), ['src/old/a.ts']);
    assert.equal(report.retained, 1);
    assert.equal(report.degraded, true);
    assert.ok(snapshot.caveats.degradedReasons.includes('fingerprint-degraded:src/old:EACCES'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
