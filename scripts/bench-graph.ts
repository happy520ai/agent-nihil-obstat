import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { cpus, totalmem, platform, arch, release } from 'node:os';
import { GraphStore } from '../src/structure/store.ts';
import { impact } from '../src/gate/blast.ts';
import { t2Coverage } from '../src/structure/t2.ts';
import { explore, exploreSearch } from '../src/structure/explore.ts';

/**
 * Local, reproducible-by-machine benchmark. It copies a real slice of this
 * repository into os.tmpdir(), builds the real SQLite graph, then records the
 * measured first/incremental/changed-file build and query times. No values are
 * synthesised; unsupported-language and corpus limits are written down.
 */

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const outputPath = join(repositoryRoot, 'docs', 'evidence', 'p3-graph-bench.json');
const corpusRoot = await mkdtemp(join(tmpdir(), 'ano p3 bench '));

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function memoryDelta(before: NodeJS.MemoryUsage, after: NodeJS.MemoryUsage): Record<string, number> {
  return {
    rssDeltaBytes: after.rss - before.rss,
    heapUsedDeltaBytes: after.heapUsed - before.heapUsed,
    externalDeltaBytes: after.external - before.external,
    rssBytes: after.rss,
    heapUsedBytes: after.heapUsed,
  };
}

async function measure<T>(fn: () => T, iterations: number): Promise<{ ms: number[]; medianMs: number; result: T }> {
  const ms: number[] = [];
  let result: T | undefined;
  for (let index = 0; index < iterations; index += 1) {
    const start = performance.now();
    result = fn();
    ms.push(performance.now() - start);
  }
  return { ms, medianMs: median(ms), result: result as T };
}

async function measureAsync<T>(fn: () => Promise<T>, iterations: number): Promise<{ ms: number[]; medianMs: number; result: T }> {
  const ms: number[] = [];
  let result: T | undefined;
  for (let index = 0; index < iterations; index += 1) {
    const start = performance.now();
    result = await fn();
    ms.push(performance.now() - start);
  }
  return { ms, medianMs: median(ms), result: result as T };
}

try {
  for (const entry of ['src', 'test', 'package.json', 'tsconfig.json']) {
    await cp(join(repositoryRoot, entry), join(corpusRoot, entry), { recursive: true });
  }

  const baselineMemory = process.memoryUsage();
  const store = await GraphStore.open(corpusRoot);

  const firstStarted = performance.now();
  await store.build();
  const firstBuildMs = performance.now() - firstStarted;
  const firstBuild = store.lastBuild;
  const afterFirstMemory = process.memoryUsage();
  const firstSnapshot = store.snapshot();

  const incrementalStarted = performance.now();
  await store.build();
  const incrementalBuildMs = performance.now() - incrementalStarted;
  const incrementalBuild = store.lastBuild;
  const afterIncrementalMemory = process.memoryUsage();

  // One real content change: append a comment to a file that participates in the
  // graph, then rebuild and verify only that file was parsed.
  const changedFile = 'src/structure/fresh.ts';
  const original = await readFile(join(corpusRoot, changedFile), 'utf8');
  await writeFile(join(corpusRoot, changedFile), `${original}\n// bench marker ${Date.now()}\n`);
  const changedStarted = performance.now();
  await store.build();
  const changedFileBuildMs = performance.now() - changedStarted;
  const changedBuild = store.lastBuild;
  const snapshot = store.snapshot();

  const options = { root: corpusRoot, freshness: store.freshness() };
  const impactMeasurement = await measure(() => impact(snapshot, ['src/structure/types.ts']).length, 20);
  const t2Measurement = await measure(() => t2Coverage(snapshot, ['test/integration/structure.test.ts'], ['src/structure/types.ts']), 20);
  const searchMeasurement = await measureAsync(
    () => exploreSearch(snapshot, { query: 'structure' }, { ...options, maxOutputChars: 4000 }),
    10,
  );
  const exploreStarted = performance.now();
  const exploreResult = await explore(snapshot, {
    task: 'trace GraphSnapshot structure edges call graph',
    touchedFiles: ['src/structure/types.ts'],
    flow: { from: 'test/integration/structure.test.ts', to: 'src/structure/types.ts' },
  }, { ...options, maxOutputChars: 4000 });
  const exploreMs = performance.now() - exploreStarted;

  const record = {
    schema: 'p3-graph-bench-v1',
    generatedAt: new Date().toISOString(),
    command: 'node scripts/bench-graph.ts',
    environment: {
      node: process.version,
      platform: platform(),
      arch: arch(),
      release: release(),
      cpuModel: cpus()[0]?.model ?? 'unknown',
      cpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
    },
    corpus: {
      source: 'copy of this repository: src/, test/, package.json, tsconfig.json',
      rootKind: 'os.tmpdir()',
      files: Object.keys(snapshot.files).length,
      symbols: snapshot.symbols.length,
      importEdges: snapshot.edges.length,
      callEdges: snapshot.calls?.length ?? 0,
      supportedExtensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
      languageAcceptanceClaimed: false,
      note: 'TS/JS grammars only. No per-language small/medium/large repository acceptance was run.',
    },
    builds: {
      first: {
        ms: firstBuildMs,
        report: firstBuild,
        memory: memoryDelta(baselineMemory, afterFirstMemory),
      },
      incrementalUnchanged: {
        ms: incrementalBuildMs,
        report: incrementalBuild,
        memory: memoryDelta(afterFirstMemory, afterIncrementalMemory),
      },
      incrementalOneChangedFile: {
        ms: changedFileBuildMs,
        report: changedBuild,
        changedFile,
      },
    },
    queries: {
      impact: {
        iterations: impactMeasurement.ms.length,
        ms: impactMeasurement.ms,
        medianMs: impactMeasurement.medianMs,
        resultSize: impactMeasurement.result,
      },
      t2: {
        iterations: t2Measurement.ms.length,
        ms: t2Measurement.ms,
        medianMs: t2Measurement.medianMs,
        applicable: t2Measurement.result.applicable,
        satisfied: t2Measurement.result.satisfied,
        affectedSymbols: t2Measurement.result.affectedSymbols.length,
        uncoveredSymbols: t2Measurement.result.uncoveredSymbols.length,
        resolvedCallEdges: t2Measurement.result.resolvedCallEdges,
      },
      exploreSearch: {
        iterations: searchMeasurement.ms.length,
        ms: searchMeasurement.ms,
        medianMs: searchMeasurement.medianMs,
        totalMatches: searchMeasurement.result.meta.totalMatches,
        returned: searchMeasurement.result.meta.returned,
        budget: searchMeasurement.result.meta.budget,
      },
      explore: {
        ms: exploreMs,
        totalMatches: exploreResult.meta.totalMatches,
        returned: exploreResult.meta.returned,
        budget: exploreResult.meta.budget,
        freshness: exploreResult.meta.freshness,
        graphRevision: exploreResult.meta.graphRevision,
      },
    },
    caveats: snapshot.caveats,
    limitations: [
      'Single local machine, single run; build timings are not statistically robust.',
      'The corpus is this repository only (TS/JS); no other language or small/medium/large external repo acceptance.',
      'Memory deltas are Node process RSS/heap observations without forced GC.',
      'Incremental parsing is verified by BuildReport.parsed/reused on the copied corpus, not a multi-process concurrency benchmark.',
    ],
  };

  await mkdir(join(repositoryRoot, 'docs', 'evidence'), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`Wrote ${outputPath}`);
  console.log(JSON.stringify({
    files: record.corpus.files,
    symbols: record.corpus.symbols,
    importEdges: record.corpus.importEdges,
    callEdges: record.corpus.callEdges,
    firstBuildMs: record.builds.first.ms,
    incrementalMs: record.builds.incrementalUnchanged.ms,
    changedFileMs: record.builds.incrementalOneChangedFile.ms,
    impactMedianMs: record.queries.impact.medianMs,
    t2MedianMs: record.queries.t2.medianMs,
    exploreSearchMedianMs: record.queries.exploreSearch.medianMs,
    exploreMs: record.queries.explore.ms,
  }, null, 2));
  store.close();
} finally {
  await rm(corpusRoot, { recursive: true, force: true });
}
