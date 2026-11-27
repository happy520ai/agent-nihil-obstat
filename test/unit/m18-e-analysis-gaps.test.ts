import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import test from 'node:test';
import { resolveProjectScan } from '../../src/core/project-scan.ts';
import {
  analyzeFileBaseline,
  analyzeStructure,
  openStructureAnalyzer,
  structureAnalysisCacheKey,
  type StructureAnalysisOptions,
} from '../../src/structure/analysis.ts';
import { GraphStore } from '../../src/structure/store.ts';
import { M18E_BASE_FILES, writeM18EFixture } from '../helpers/m18-e-fixtures.ts';

const GAP_FIXTURE = {
  ...M18E_BASE_FILES,
  'tsconfig.json': JSON.stringify({ compilerOptions: {} }),
  'src/foo.ts': [
    'export class Foo {',
    '  static bar(): number { return 1; }',
    '}',
    'export function target(): number { return 1; }',
    'export function callerFn(): number { return target(); }',
    '',
  ].join('\n'),
  'src/main.ts': [
    "import { Foo } from './foo.js';",
    'export const x = Foo.bar();',
    '',
  ].join('\n'),
};

test('located semantic gaps mark a file unknown and sort into batch rows and the single-file baseline', async () => {
  const root = await writeM18EFixture(GAP_FIXTURE);
  try {
    const scan = await resolveProjectScan({ startRoot: root });
    const store = await GraphStore.open(root, { scan });
    await store.build();
    const snapshot = store.snapshot();

    const options = {
      touched: ['src/main.ts'],
      maxDepth: 3,
      semanticGaps: {
        'src/main.ts': [
          { line: 5, pattern: 'registry', reason: 'runtime registry dispatch' },
          { line: 2, pattern: 'eval', reason: 'eval target is not static' },
        ],
      },
    };
    const analysis = analyzeStructure(snapshot, options);
    const row = analysis.files.find((item) => item.file === 'src/main.ts');
    assert.ok(row);
    assert.equal(row.classification, 'unknown', 'a located main-gap pattern must outrank parsed');
    assert.deepEqual(row.semanticGaps, [
      { line: 2, pattern: 'eval', reason: 'eval target is not static' },
      { line: 5, pattern: 'registry', reason: 'runtime registry dispatch' },
    ], 'row gaps are ordered by line');

    const baseline = analyzeFileBaseline(snapshot, 'src/main.ts', options);
    assert.deepEqual(baseline, row, 'the single-file baseline must equal the batch row');

    // A non-main-gap pattern stays advisory and never rewrites the classification.
    const advisory = analyzeStructure(snapshot, {
      semanticGaps: { 'src/main.ts': [{ line: 3, pattern: 'note', reason: 'review hint' }] },
    });
    assert.equal(advisory.files.find((item) => item.file === 'src/main.ts')?.classification, 'parsed');
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('session outline counts resolved incoming/outgoing calls for each symbol', async () => {
  const root = await writeM18EFixture(GAP_FIXTURE);
  try {
    const scan = await resolveProjectScan({ startRoot: root });
    const session = await openStructureAnalyzer(root, { storeOptions: { scan } });
    try {
      const outline = session.outline('src/foo.ts');
      assert.ok(outline);
      const byName = new Map(outline.symbols.map((symbol) => [symbol.name, symbol]));
      assert.equal(byName.get('bar')?.incomingCalls, 1, 'main -> Foo.bar is an incoming resolved call');
      assert.equal(byName.get('bar')?.outgoingCalls, 0);
      assert.equal(byName.get('callerFn')?.outgoingCalls, 1, 'callerFn -> target is an outgoing resolved call');
      assert.equal(byName.get('target')?.incomingCalls, 1);
      assert.equal(byName.get('Foo')?.incomingCalls, 0);
      assert.equal(byName.get('Foo')?.outgoingCalls, 0);
    } finally {
      session.close();
    }
    assert.equal(session.isClosed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cache key serializes gaps, blind spots and unresolved loads deterministically', () => {
  const input: StructureAnalysisOptions = {
    semanticGaps: {
      'src/b.ts': [
        { line: 5, pattern: 'registry', reason: 'r' },
        { line: 2, pattern: 'eval', reason: 'q' },
      ],
    },
    blindSpots: {
      'src/b.ts': [
        { type: 'eval', line: 3, pattern: 'eval', reason: 'b' },
        { type: 'reflection', line: 1, pattern: 'x', reason: 'a' },
      ],
      'src/a.ts': [],
    },
    unresolvedDynamicLoads: { 'src/b.ts': 2, 'src/a.ts': 1 },
  };
  const reordered: StructureAnalysisOptions = {
    unresolvedDynamicLoads: { 'src/a.ts': 1, 'src/b.ts': 2 },
    blindSpots: {
      'src/a.ts': [],
      'src/b.ts': [
        { type: 'reflection', line: 1, pattern: 'x', reason: 'a' },
        { type: 'eval', line: 3, pattern: 'eval', reason: 'b' },
      ],
    },
    semanticGaps: {
      'src/b.ts': [
        { line: 2, pattern: 'eval', reason: 'q' },
        { line: 5, pattern: 'registry', reason: 'r' },
      ],
    },
  };

  const first = structureAnalysisCacheKey(input);
  assert.equal(first, structureAnalysisCacheKey(reordered), 'key input order must not matter');
  assert.notEqual(first, structureAnalysisCacheKey({}), 'evidence-bearing inputs need their own entry');
});
