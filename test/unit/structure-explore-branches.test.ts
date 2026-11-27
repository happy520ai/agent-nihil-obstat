import assert from 'node:assert/strict';
import test from 'node:test';
import {
  explore,
  exploreFlow,
  exploreImpact,
  exploreOutline,
  exploreSearch,
  exploreSymbol,
  type ExploreOptions,
} from '../../src/structure/explore.ts';
import { emptyCaveats, type CallEdge, type GraphSnapshot, type SymbolNode } from '../../src/structure/types.ts';

const FRESH: ExploreOptions = { freshness: { status: 'fresh', stale: 0 } };

function symbol(id: string, file: string, name: string, qualifiedName: string, startLine: number): SymbolNode {
  return { id, file, name, qualifiedName, symbolKind: 'value', startLine };
}

function snapshot(): GraphSnapshot {
  return {
    revision: 'rev-explore',
    sourceFingerprint: 'f'.repeat(64),
    files: {
      'src/a.ts': { path: 'src/a.ts', hash: 'a'.repeat(64), dynamicLoads: 0 },
      'src/b.ts': { path: 'src/b.ts', hash: 'b'.repeat(64), dynamicLoads: 0 },
      'src/c.ts': { path: 'src/c.ts', hash: 'c'.repeat(64), dynamicLoads: 0 },
      'src/d.ts': { path: 'src/d.ts', hash: 'd'.repeat(64), dynamicLoads: 1 },
    },
    symbols: [
      symbol('id-a', 'src/a.ts', 'alpha', 'mod::alpha', 1),
      symbol('id-b', 'src/b.ts', 'beta', 'mod::beta', 2),
      symbol('id-b2', 'src/b.ts', 'betaTwo', 'mod::beta.two', 2),
      symbol('id-c', 'src/c.ts', 'gamma', 'mod::gamma', 1),
    ],
    edges: [
      { from: 'src/a.ts', to: 'src/b.ts', kind: 'value-confirmed', provenance: 'resolved', importedNames: ['beta'] },
      { from: 'src/b.ts', to: 'src/c.ts', kind: 'value-confirmed', provenance: 'resolved', importedNames: ['gamma'] },
      { from: 'src/c.ts', to: 'src/a.ts', kind: 'unknown', provenance: 'heuristic', importedNames: [] },
      { from: 'src/d.ts', to: 'src/a.ts', kind: 'type-only', provenance: 'parsed', importedNames: [] },
    ],
    calls: [
      { from: 'src/a.ts', to: 'src/b.ts', callee: 'beta', line: 3, provenance: 'resolved', label: 'imported', callerSymbolId: 'id-a', calleeSymbolId: 'id-b', calleeQualifiedName: 'mod::beta' },
      { from: 'src/d.ts', to: 'src/c.ts', callee: 'gamma', line: 4, provenance: 'heuristic', label: 'imported' },
      { from: 'src/b.ts', to: 'src/c.ts', callee: 'run', line: 5, provenance: 'resolved', label: 'local' },
      { from: 'src/c.ts', to: 'src/a.ts', callee: 'alpha', line: 6, provenance: 'resolved', label: 'imported', callerSymbolId: 'id-c', calleeSymbolId: 'id-a', calleeQualifiedName: 'mod::alpha' },
      { from: 'src/a.ts', to: 'src/c.ts', callee: 'gamma', line: 7, provenance: 'resolved', label: 'imported', callerSymbolId: 'id-a', calleeSymbolId: 'id-c', calleeQualifiedName: 'mod::gamma' },
    ],
    caveats: emptyCaveats(),
  };
}

const SOURCES: Record<string, string[]> = {
  'src/a.ts': ['export const alpha = 1;', 'const second = 2;', 'alpha();', 'third', 'fourth', 'fifth'],
  'src/b.ts': ['export function beta() {}', 'beta();'],
  'src/c.ts': ['export function gamma() {}', 'gamma();', 'more'],
  'src/d.ts': ['import { alpha } from "./a";', 'alpha();'],
};

function readSource(file: string): Promise<string> {
  const lines = SOURCES[file];
  if (!lines) return Promise.reject(new Error('missing'));
  return Promise.resolve(lines.join('\n'));
}

test('exploreSearch ranks symbols and files and honours explicit limits', async () => {
  const all = await exploreSearch(snapshot(), { query: 'src' }, FRESH);
  assert.ok(all.data.totalSymbols >= 1);
  assert.ok(all.data.totalFiles >= 1);
  assert.equal(all.meta.totalMatches, all.data.entries.length);

  const limited = await exploreSearch(snapshot(), { query: 'src', limit: 3 }, FRESH);
  assert.equal(limited.data.entries.length, 3);
  assert.equal(limited.meta.budget.truncated, true, 'a hard limit counts as truncation');

  const none = await exploreSearch(snapshot(), { query: 'nothing-matches' }, FRESH);
  assert.deepEqual(none.data.entries, []);
  assert.equal(none.meta.budget.truncated, false);

  const zeroBudget = await exploreSearch(snapshot(), { query: 'alpha' }, { ...FRESH, maxOutputChars: 0 });
  assert.equal(zeroBudget.meta.budget.limitChars, 0);
  assert.equal(zeroBudget.meta.budget.truncated, true);
  assert.equal(zeroBudget.data.entries.length, 0);

  const negative = await exploreSearch(snapshot(), { query: 'alpha' }, { ...FRESH, maxOutputChars: -5 });
  assert.equal(negative.meta.budget.limitChars, 0);
  const infinite = await exploreSearch(snapshot(), { query: 'alpha' }, { ...FRESH, maxOutputChars: Number.POSITIVE_INFINITY });
  assert.equal(infinite.meta.budget.limitChars, 8000);
});

test('exploreSymbol resolves by id, file and text with snippets and relations', async () => {
  const byId = await exploreSymbol(snapshot(), { id: 'id-a', includeEdges: true }, { ...FRESH, readSource });
  const hit = byId.data.symbols[0]!;
  assert.equal(hit.id, 'id-a');
  assert.equal(hit.snippet?.startLine, 1);
  assert.equal(hit.snippet?.endLine, 3);
  assert.equal(hit.relations?.outgoingCalls.length, 2);
  assert.equal(hit.relations?.incomingCalls.length, 1);
  assert.ok((hit.relations?.importEdges.length ?? 0) >= 1);

  const byFile = await exploreSymbol(snapshot(), { file: 'src/b.ts' }, FRESH);
  assert.equal(byFile.data.symbols.length, 2);
  assert.equal(byFile.meta.notes.includes('no-source-provider:snippets-omitted'), true);
  assert.equal(byFile.data.symbols[0]!.snippet, undefined);

  const byFileAndText = await exploreSymbol(snapshot(), { file: 'src/b.ts', text: 'betaTwo' }, FRESH);
  assert.equal(byFileAndText.data.symbols.length, 1);

  const empty = await exploreSymbol(snapshot(), {}, FRESH);
  assert.deepEqual(empty.data.symbols, []);

  const hiddenSnippets = await exploreSymbol(snapshot(), { text: 'alpha', includeSnippet: false }, { ...FRESH, readSource });
  assert.equal(hiddenSnippets.data.symbols[0]!.snippet, undefined);

  const throwingReader = await exploreSymbol(snapshot(), { text: 'alpha' }, { ...FRESH, readSource: async () => { throw new Error('boom'); } });
  assert.ok(throwingReader.data.symbols.length >= 1);
  assert.equal(throwingReader.data.symbols[0]!.snippet, undefined);

  const farLine: GraphSnapshot = { ...snapshot(), symbols: [symbol('id-far', 'src/a.ts', 'alpha', 'mod::alpha', 99)] };
  const outOfRange = await exploreSymbol(farLine, { text: 'alpha' }, { ...FRESH, readSource });
  assert.equal(outOfRange.data.symbols[0]!.snippet, undefined);

  const tiny = await exploreSymbol(snapshot(), { text: 'a', includeEdges: true }, { ...FRESH, maxOutputChars: 1 });
  assert.equal(tiny.meta.budget.truncated, true);
  assert.ok(tiny.data.symbols.length < 3);
});

test('exploreOutline lists symbols with optional source snippets', async () => {
  const withSource = await exploreOutline(snapshot(), { file: 'src/b.ts' }, { ...FRESH, readSource });
  assert.equal(withSource.data.symbols.length, 2);
  assert.equal(withSource.data.symbols[0]!.snippet?.startLine, 2);
  assert.deepEqual(withSource.meta.notes, []);

  const withoutSource = await exploreOutline(snapshot(), { file: 'src/b.ts' }, FRESH);
  assert.equal(withoutSource.data.symbols.length, 2);
  assert.ok(withoutSource.meta.notes.includes('no-source-provider:snippets-omitted'));

  const missing = await exploreOutline(snapshot(), { file: 'src/nope.ts' }, FRESH);
  assert.deepEqual(missing.data.symbols, []);
  assert.equal(missing.meta.totalMatches, 0);
});

test('exploreImpact computes import and call closures with provenance filters', async () => {
  const impact = await exploreImpact(snapshot(), { touched: ['src/c.ts'] }, FRESH);
  assert.deepEqual(impact.data.touched, ['src/c.ts']);
  assert.deepEqual(impact.data.impactedFiles, ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts']);
  assert.ok(impact.data.callerFiles.includes('src/b.ts'));
  assert.deepEqual(impact.data.callerSymbols, ['id-a', 'id-c']);

  const resolvedOnly = await exploreImpact(snapshot(), { touched: ['src/c.ts'] }, { ...FRESH, includeHeuristicCalls: false });
  assert.ok(resolvedOnly.data.callerFiles.includes('src/b.ts'));

  const noCalls: GraphSnapshot = { ...snapshot(), calls: undefined as unknown as CallEdge[] };
  const noCallImpact = await exploreImpact(noCalls, { touched: ['src/b.ts'] }, FRESH);
  assert.deepEqual(noCallImpact.data.callerSymbols, ['id-b', 'id-b2']);

  const tiny = await exploreImpact(snapshot(), { touched: ['src/c.ts'] }, { ...FRESH, maxOutputChars: 5 });
  assert.equal(tiny.meta.budget.truncated, true);
});

test('exploreFlow walks resolved calls, clamps limits and reports enumeration caps', async () => {
  const direct = await exploreFlow(snapshot(), { from: 'src/a.ts', to: 'src/b.ts' }, { ...FRESH, readSource });
  assert.equal(direct.data.from, 'src/a.ts');
  assert.equal(direct.data.to, 'src/b.ts');
  assert.ok(direct.data.paths.length >= 1);
  const step = direct.data.paths[0]!.steps[0]!;
  assert.equal(step.fromFile, 'src/a.ts');
  assert.ok(step.callSnippet);
  assert.ok(step.definitionSnippet);
  assert.ok(direct.meta.notes.includes('resolved-call-edges-only'));

  const bySymbol = await exploreFlow(snapshot(), { from: 'alpha', to: 'gamma' }, { ...FRESH, readSource });
  assert.ok(bySymbol.data.paths.length >= 1);
  assert.equal(bySymbol.data.paths[0]!.start, 'symbol:id-a');

  const withHeuristics = await exploreFlow(snapshot(), { from: 'src/d.ts', to: 'src/c.ts' }, { ...FRESH, includeHeuristicCalls: true });
  assert.ok(withHeuristics.data.paths.length >= 1);
  assert.ok(!withHeuristics.meta.notes.some((note) => note.startsWith('resolved-call-edges-only')));

  const noSource = await exploreFlow(snapshot(), { from: 'src/a.ts', to: 'src/b.ts' }, FRESH);
  assert.ok(noSource.meta.notes.includes('no-source-provider:snippets-omitted'));

  const missing = await exploreFlow(snapshot(), { from: 'src/nowhere.ts', to: 'src/b.ts' }, FRESH);
  assert.deepEqual(missing.data.paths, []);

  const emptyAnchors = await exploreFlow(snapshot(), {}, FRESH);
  assert.deepEqual(emptyAnchors.data.paths, []);
  assert.equal(emptyAnchors.data.from, '');
  assert.equal(emptyAnchors.data.to, '');

  const capped = await exploreFlow(snapshot(), { from: 'src/a.ts', to: 'src/c.ts', maxPaths: 0, maxDepth: 0 }, { ...FRESH, includeHeuristicCalls: true });
  assert.equal(capped.data.enumerationLimitReached, true);
  assert.ok(capped.meta.notes.some((note) => note.startsWith('path-enumeration-limit:')));
  assert.ok(capped.data.paths.length <= 1);

  const clipped = await exploreFlow(snapshot(), { from: 'src/a.ts', to: 'src/c.ts', maxPaths: 9999, maxDepth: 99 }, FRESH);
  assert.ok(clipped.meta.notes.every((note) => !note.startsWith('path-enumeration-limit:')));
});

test('explore orchestrates task-derived candidates and trims every section under a tiny budget', async () => {
  const broad = await explore(snapshot(), { task: 'fix alpha and beta in src/a.ts and src/b.ts' }, { ...FRESH, maxOutputChars: 100_000 });
  assert.equal(broad.data.task, 'fix alpha and beta in src/a.ts and src/b.ts');
  assert.ok(broad.data.symbols);
  assert.ok(broad.data.search);
  assert.ok(broad.data.outline, 'task files produce an outline section');
  assert.ok(broad.data.impact, 'task files produce an impact section');
  assert.ok(broad.data.flow, 'two candidates produce an implicit flow section');

  const explicit = await explore(snapshot(), {
    task: 'anything',
    symbols: ['alpha'],
    files: ['src/a.ts'],
    touchedFiles: ['src/a.ts'],
    flow: { from: 'src/a.ts', to: 'src/b.ts' },
  }, { ...FRESH, maxOutputChars: 100_000 });
  assert.equal(explicit.data.symbols?.totalMatches, 1);
  assert.equal(explicit.data.outline?.totalMatches, 1);
  assert.ok(explicit.data.flow);

  const trimmed = await explore(snapshot(), {
    task: 'fix alpha and beta in src/a.ts and src/b.ts',
    symbols: ['alpha', 'beta'],
    files: ['src/b.ts'],
    touchedFiles: ['src/c.ts'],
    flow: { from: 'src/a.ts', to: 'src/c.ts' },
  }, { ...FRESH, maxOutputChars: 1 });
  assert.equal(trimmed.meta.budget.truncated, true);
  assert.equal(trimmed.data.flow?.paths.length, 0);
  assert.equal(trimmed.data.outline?.symbols.length, 0);
  assert.equal(trimmed.data.symbols!.symbols.length, 0);
  assert.equal(trimmed.data.search!.entries.length, 0);
  assert.equal(trimmed.data.impact?.callerSymbols.length, 0);
  assert.equal(trimmed.data.impact?.impactedFiles.length, 0);

  const noMatches = await explore(snapshot(), { task: 'zzz', symbols: ['nope'], files: [], touchedFiles: [] }, FRESH);
  assert.equal(noMatches.data.flow, undefined);
  assert.equal(noMatches.data.outline, undefined);
  assert.equal(noMatches.data.impact, undefined);
  assert.equal(noMatches.data.symbols!.totalMatches, 0);
  assert.equal(noMatches.data.search!.totalMatches, 0);
});

test('exploreFlow deduplicates identical paths and keeps file-level start nodes', async () => {
  const duplicate: CallEdge[] = [
    { from: 'src/a.ts', to: 'src/b.ts', callee: 'beta', line: 3, provenance: 'resolved', label: 'imported' },
    { from: 'src/a.ts', to: 'src/b.ts', callee: 'beta', line: 3, provenance: 'resolved', label: 'imported' },
  ];
  const dupSnapshot: GraphSnapshot = { ...snapshot(), symbols: [], calls: duplicate };
  const result = await exploreFlow(dupSnapshot, { from: 'src/a.ts', to: 'src/b.ts' }, FRESH);
  assert.equal(result.data.paths.length, 1, 'identical paths are deduplicated');
  assert.equal(result.data.paths[0]!.start, 'file:src/a.ts');
  assert.equal(result.data.paths[0]!.target, 'file:src/b.ts');
});
