import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, platform, arch, release, cpus, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { GraphStore } from '../src/structure/store.ts';
import {
  analyzeStructure,
  createStructureAnalysisCache,
  openStructureAnalyzer,
  type StructureAnalysis,
  type StructureAnalysisStoreSeam,
} from '../src/structure/analysis.ts';

/**
 * T-119 structure-analysis benchmark.
 *
 * Honesty rules (mirrors scripts/benchmark-anchor-probe.ts):
 * - Every number comes from this machine and this synthetic fixture. No speedup
 *   is promised or implied; the real e-commerce case is T-120's scope.
 * - Cold and hot measure the SAME snapshot/revision/input. Hot means the batch
 *   analysis cache returns the identical object; cold means `analyzeStructure`
 *   recomputes from the single snapshot.
 * - The production path is measured through `openStructureAnalyzer`; the seam
 *   counts `GraphStore.open`/`snapshot` calls so an N-opens regression cannot be
 *   hidden by timings.
 * - All temporary projects stay under os.tmpdir().
 */

export type StructureBenchScale = 'smoke' | 'S' | 'M' | 'L';

interface ScaleProfile {
  readonly files: number;
  readonly defaultIterations: number;
}

export const SCALE_PROFILES: Readonly<Record<StructureBenchScale, ScaleProfile>> = {
  smoke: { files: 24, defaultIterations: 7 },
  S: { files: 418, defaultIterations: 10 },
  M: { files: 1199, defaultIterations: 6 },
  L: { files: 4850, defaultIterations: 3 },
};

/** The user-measured real project is 485 files / 418 in-graph / ~1199 scale. */
export const REAL_CASE = {
  analyzedFiles: 485,
  inGraphFiles: 418,
  scaleFiles: 1199,
  symbols: 8125,
} as const;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index]!;
}

export interface LatencyStats {
  readonly count: number;
  readonly minMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  readonly meanMs: number;
}

function latencyStats(samples: readonly number[]): LatencyStats {
  const sorted = [...samples].sort((left, right) => left - right);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    minMs: round(sorted[0] ?? 0),
    p50Ms: round(percentile(sorted, 50)),
    p95Ms: round(percentile(sorted, 95)),
    p99Ms: round(percentile(sorted, 99)),
    maxMs: round(sorted[sorted.length - 1] ?? 0),
    meanMs: round(sum / (sorted.length === 0 ? 1 : sorted.length)),
  };
}

function measureSync(operation: () => void, iterations: number): LatencyStats {
  const samples: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    operation();
    samples.push(performance.now() - started);
  }
  return latencyStats(samples);
}

function memorySnapshot(): NodeJS.MemoryUsage {
  return process.memoryUsage();
}

// ---------------------------------------------------------------------------
// Deterministic synthetic project
// ---------------------------------------------------------------------------

export interface StructureBenchFixture {
  readonly scale: StructureBenchScale;
  readonly seed: number;
  readonly root: string;
  readonly fileCount: number;
  readonly files: readonly string[];
}

/**
 * Builds a dependency chain `m0 -> m1 -> ...` plus located blind-spot patterns at
 * fixed indices. Content depends only on the file index, so a seed reproduces
 * the same bytes and the same graph.
 */
export function buildFixture(scale: StructureBenchScale, seed: number): StructureBenchFixture {
  const profile = SCALE_PROFILES[scale];
  const rng = mulberry32(seed);
  const root = mkdtempSync(join(tmpdir(), `ano-structure-bench-${scale}-`));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({ name: 'structure-bench-fixture', private: true }, null, 2)}\n`);

  const files: string[] = [];
  for (let index = 0; index < profile.files; index += 1) {
    const path = `src/m${String(index).padStart(4, '0')}.ts`;
    files.push(path);
    const lines: string[] = [];
    if (index > 0) {
      const dependencyCount = 1 + Math.floor(rng() * 3);
      const seen = new Set<number>();
      for (let slot = 0; slot < dependencyCount; slot += 1) {
        const dependency = Math.floor(rng() * index);
        if (seen.has(dependency)) continue;
        seen.add(dependency);
        lines.push(`import { v${dependency} } from './m${String(dependency).padStart(4, '0')}.js';`);
      }
    }
    lines.push(`export const v${index} = ${index};`);
    lines.push(`export function f${index}(x: number): number { return x + v${index}; }`);
    if (index % 37 === 0) lines.push(`export const dynamicLiteral${index} = () => import('./m0000.js');`);
    if (index % 53 === 0) lines.push(`const target${index} = './m0001.js';`);
    if (index % 53 === 0) lines.push(`export const computedLoad${index} = () => import(target${index});`);
    if (index % 71 === 0) lines.push(`import * as fs${index} from 'node:fs';`);
    if (index % 71 === 0) lines.push(`const directory${index} = __dirname;`);
    if (index % 71 === 0) lines.push(`fs${index}.readdirSync(directory${index});`);
    if (index % 89 === 0) lines.push(`const code${index} = '1 + 1';`);
    if (index % 89 === 0) lines.push(`eval(code${index});`);
    lines.push('');
    writeFileSync(join(root, ...path.split('/')), lines.join('\n'));
  }
  return { scale, seed, root, fileCount: files.length, files };
}

function removeTempRoot(root: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= 9) {
        console.warn(`benchmark: temp root not removable (kept for inspection): ${root} — ${String(error)}`);
        return;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

// ---------------------------------------------------------------------------
// Benchmark
// ---------------------------------------------------------------------------

export interface StructureBenchmarkOptions {
  readonly scale: StructureBenchScale;
  readonly seed: number;
  readonly iterations: number;
}

export interface BuildPhase {
  readonly label: string;
  readonly elapsedMs: number;
  readonly mode: 'full' | 'incremental' | null;
  readonly files: number;
  readonly parsed: number;
  readonly reused: number;
  readonly retained: number;
  readonly revision: string;
}

export interface SessionPhase {
  readonly iterations: number;
  readonly cacheHits: number;
  readonly opens: number;
  readonly snapshots: number;
  readonly coldMs: LatencyStats;
  readonly hotMs: LatencyStats;
}

export interface StructureBenchmarkResult {
  readonly schema: 'structureanalysis.benchmark.v1';
  readonly generatedAt: string;
  readonly command: string;
  readonly scale: StructureBenchScale;
  readonly seed: number;
  readonly environment: Record<string, unknown>;
  readonly fixture: {
    readonly root: string;
    readonly requestedFiles: number;
    readonly inGraphFiles: number;
    readonly symbols: number;
    readonly edges: number;
    readonly calls: number;
    readonly blindSpots: number;
    readonly manualReview: number;
  };
  readonly builds: readonly BuildPhase[];
  readonly analysis: {
    readonly iterations: number;
    readonly coldMs: LatencyStats;
    readonly hotMs: LatencyStats;
    readonly cachedEqualsUncached: boolean;
    readonly files: number;
    readonly risks: number;
  };
  readonly session: SessionPhase;
  readonly cost: {
    readonly rssBeforeBytes: number;
    readonly rssAfterGraphBytes: number;
    readonly rssAfterAnalysisBytes: number;
    readonly heapUsedAfterAnalysisBytes: number;
  };
  readonly limitations: readonly string[];
}

const FIXED_NOW = 1_000_000;

function environmentRecord(): Record<string, unknown> {
  return {
    node: process.version,
    platform: platform(),
    arch: arch(),
    release: release(),
    cpuModel: cpus()[0]?.model ?? 'unknown',
    cpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
  };
}

export async function runBenchmark(options: StructureBenchmarkOptions): Promise<StructureBenchmarkResult> {
  const profile = SCALE_PROFILES[options.scale];
  const iterations = options.iterations > 0 ? options.iterations : profile.defaultIterations;
  const fixture = buildFixture(options.scale, options.seed);
  const rssBefore = memorySnapshot().rss;
  const builds: BuildPhase[] = [];

  // Phase 1: graph construction (cold full, unchanged incremental, one-file change).
  const store = await GraphStore.open(fixture.root);
  try {
    let started = performance.now();
    await store.build();
    builds.push({
      label: 'cold-full',
      elapsedMs: round(performance.now() - started),
      mode: store.lastBuild?.mode ?? null,
      files: store.lastBuild?.files ?? 0,
      parsed: store.lastBuild?.parsed ?? 0,
      reused: store.lastBuild?.reused ?? 0,
      retained: store.lastBuild?.retained ?? 0,
      revision: store.revision,
    });

    started = performance.now();
    await store.build();
    builds.push({
      label: 'unchanged-incremental',
      elapsedMs: round(performance.now() - started),
      mode: store.lastBuild?.mode ?? null,
      files: store.lastBuild?.files ?? 0,
      parsed: store.lastBuild?.parsed ?? 0,
      reused: store.lastBuild?.reused ?? 0,
      retained: store.lastBuild?.retained ?? 0,
      revision: store.revision,
    });

    const changed = fixture.files[0]!;
    writeFileSync(join(fixture.root, ...changed.split('/')), 'export const v0 = 1000;\nexport function f0(x: number): number { return x + v0; }\n');
    started = performance.now();
    await store.build();
    builds.push({
      label: 'one-file-changed',
      elapsedMs: round(performance.now() - started),
      mode: store.lastBuild?.mode ?? null,
      files: store.lastBuild?.files ?? 0,
      parsed: store.lastBuild?.parsed ?? 0,
      reused: store.lastBuild?.reused ?? 0,
      retained: store.lastBuild?.retained ?? 0,
      revision: store.revision,
    });
  } finally {
    store.close();
  }

  // Reopen once to measure the analysis phases on a stable persisted snapshot.
  const reader = await GraphStore.open(fixture.root);
  const snapshot = reader.snapshot();
  const analysisOptions = { touched: [fixture.files[0]!], maxDepth: 3, now: () => FIXED_NOW };
  const rssAfterGraph = memorySnapshot().rss;

  const coldSamples: number[] = [];
  let uncached: StructureAnalysis | undefined;
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    const analysis = analyzeStructure(snapshot, analysisOptions);
    coldSamples.push(performance.now() - started);
    if (uncached === undefined) uncached = analysis;
  }

  // Prime the cache once, then time only hits against the identical object.
  const cache = createStructureAnalysisCache();
  const primed = analyzeStructure(snapshot, analysisOptions);
  cache.set(snapshot.revision, analysisOptions, primed);
  const hotSamples: number[] = [];
  let hot: StructureAnalysis | undefined;
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    const cached = cache.get(snapshot.revision, analysisOptions);
    hotSamples.push(performance.now() - started);
    if (cached !== undefined) hot = cached;
  }
  const cachedEqualsUncached = JSON.stringify(hot) === JSON.stringify(uncached);

  const rssAfterAnalysis = memorySnapshot();

  // Phase 3: production path. Each analyzer call opens the store once and takes
  // one snapshot; file queries must never add either counter.
  const counter = { opens: 0, snapshots: 0 };
  const seam: StructureAnalysisStoreSeam = {
    async open(openRoot: string) {
      counter.opens += 1;
      const inner = await GraphStore.open(openRoot);
      return {
        async ensureFresh() { return inner.ensureFresh(); },
        snapshot() {
          counter.snapshots += 1;
          return inner.snapshot();
        },
        get revision() { return inner.revision; },
        close() { inner.close(); },
        freshness: () => inner.freshness(),
        get buildOutcome() { return inner.buildOutcome; },
      };
    },
  };
  const sessionCold: number[] = [];
  const sessionHot: number[] = [];
  let cacheHits = 0;
  let lastSessionAnalysis: StructureAnalysis | undefined;
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    const session = await openStructureAnalyzer(fixture.root, { ...analysisOptions, seam, cache });
    const elapsed = performance.now() - started;
    if (index === 0) sessionCold.push(elapsed);
    else {
      sessionHot.push(elapsed);
      if (lastSessionAnalysis === session.analysis) cacheHits += 1;
    }
    lastSessionAnalysis = session.analysis;
    // A batch must not reopen per file: exercise every file-level query form.
    session.outline(fixture.files[0]!);
    session.impact(fixture.files[fixture.files.length - 1]!);
    session.impactSets([fixture.files[0]!]);
    session.close();
  }
  reader.close();

  return {
    schema: 'structureanalysis.benchmark.v1',
    generatedAt: new Date().toISOString(),
    command: 'node scripts/bench-structure-analysis.ts',
    scale: options.scale,
    seed: options.seed,
    environment: environmentRecord(),
    fixture: {
      root: fixture.root,
      requestedFiles: fixture.fileCount,
      inGraphFiles: Object.keys(snapshot.files).length,
      symbols: snapshot.symbols.length,
      edges: snapshot.edges.length,
      calls: snapshot.calls?.length ?? 0,
      blindSpots: uncached?.blindSpots?.length ?? 0,
      manualReview: uncached?.manualReview?.length ?? 0,
    },
    builds,
    analysis: {
      iterations,
      coldMs: latencyStats(coldSamples),
      hotMs: latencyStats(hotSamples),
      cachedEqualsUncached,
      files: uncached?.files.length ?? 0,
      risks: uncached?.risks.length ?? 0,
    },
    session: {
      iterations,
      cacheHits,
      opens: counter.opens,
      snapshots: counter.snapshots,
      coldMs: latencyStats(sessionCold),
      hotMs: latencyStats(sessionHot),
    },
    cost: {
      rssBeforeBytes: rssBefore,
      rssAfterGraphBytes: rssAfterGraph,
      rssAfterAnalysisBytes: rssAfterAnalysis.rss,
      heapUsedAfterAnalysisBytes: rssAfterAnalysis.heapUsed,
    },
    limitations: [
      'Single local machine, single process; P50/P95 are observations, not a production latency claim.',
      `The real e-commerce case (${REAL_CASE.analyzedFiles} files analyzed / ${REAL_CASE.inGraphFiles} in graph / ${REAL_CASE.symbols} symbols) is T-120\'s controlled rerun; this fixture is synthetic.`,
      'No forced GC; RSS/heap deltas are noisy Node observations.',
      'Cold/hot compare identical snapshot, revision and input; no speedup is promised.',
    ],
  };
}

// ---------------------------------------------------------------------------
// Markdown / CLI
// ---------------------------------------------------------------------------

function formatLatency(stats: LatencyStats): string {
  return `p50 ${stats.p50Ms} / p95 ${stats.p95Ms} / p99 ${stats.p99Ms} / max ${stats.maxMs} ms (n=${stats.count})`;
}

export function renderMarkdown(result: StructureBenchmarkResult): string {
  const lines: string[] = [];
  lines.push('# 结构分析性能基准（T-119 / SG-09）');
  lines.push('');
  lines.push(`- 生成时间：${result.generatedAt}`);
  lines.push(`- 命令：\`${result.command} --scale ${result.scale} --seed ${result.seed}\``);
  lines.push(`- 环境：node ${String(result.environment.node)} / ${String(result.environment.platform)} ${String(result.environment.arch)} ${String(result.environment.release)} / ${String(result.environment.cpuModel)} x${String(result.environment.cpuCount)}`);
  lines.push(`- 档位：${result.scale}；请求文件 ${result.fixture.requestedFiles}，进图 ${result.fixture.inGraphFiles}，符号 ${result.fixture.symbols}，边 ${result.fixture.edges}，调用 ${result.fixture.calls}，盲区 ${result.fixture.blindSpots}，人工复核 ${result.fixture.manualReview}`);
  lines.push('');
  lines.push('## 1. 图构建（同硬件、同夹具）');
  lines.push('');
  lines.push('| 阶段 | 耗时 ms | 模式 | 文件 | 解析 | 复用 | 保留 |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const build of result.builds) {
    lines.push(`| ${build.label} | ${build.elapsedMs} | ${build.mode ?? 'n/a'} | ${build.files} | ${build.parsed} | ${build.reused} | ${build.retained} |`);
  }
  lines.push('');
  lines.push('说明：`unchanged-incremental` 的 `parsed=0/reused>0` 证明未变文件从内容哈希缓存复用；`one-file-changed` 仅重解析被改文件。');
  lines.push('');
  lines.push('## 2. 批量分析（同一快照，缓存未命中 vs 命中）');
  lines.push('');
  lines.push(`- 冷（无缓存计算）：${formatLatency(result.analysis.coldMs)}`);
  lines.push(`- 热（缓存命中）：${formatLatency(result.analysis.hotMs)}`);
  lines.push(`- 缓存结果与无缓存 deep-equal（JSON 口径）：${result.analysis.cachedEqualsUncached}`);
  lines.push(`- 文件行 ${result.analysis.files}，风险行 ${result.analysis.risks}`);
  lines.push('');
  lines.push('## 3. 生产路径 openStructureAnalyzer');
  lines.push('');
  lines.push(`- 冷（首次会话）：${formatLatency(result.session.coldMs)}`);
  lines.push(`- 热（后续同修订会话）：${formatLatency(result.session.hotMs)}`);
  lines.push(`- DB open 次数 ${result.session.opens} / snapshot 次数 ${result.session.snapshots}（每次分析各 1 次，文件查询不增加）`);
  lines.push(`- 会话缓存命中 ${result.session.cacheHits}/${Math.max(0, result.session.iterations - 1)}`);
  lines.push('');
  lines.push('## 4. 内存');
  lines.push('');
  lines.push(`- RSS：before ${result.cost.rssBeforeBytes} B / graph 后 ${result.cost.rssAfterGraphBytes} B / 分析后 ${result.cost.rssAfterAnalysisBytes} B`);
  lines.push(`- heapUsed（分析后）：${result.cost.heapUsedAfterAnalysisBytes} B（未强制 GC）`);
  lines.push('');
  lines.push('## 5. 限制');
  lines.push('');
  for (const limitation of result.limitations) lines.push(`- ${limitation}`);
  lines.push('');
  return lines.join('\n');
}

interface CliOptions {
  scale: StructureBenchScale;
  seed: number;
  iterations: number;
  jsonPath: string | null;
  mdPath: string | null;
  keepWorkRoot: boolean;
}

function parseCli(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    scale: 'S',
    seed: 20_261_124,
    iterations: 0,
    jsonPath: null,
    mdPath: null,
    keepWorkRoot: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--scale') {
      const value = argv[index + 1];
      if (value !== 'smoke' && value !== 'S' && value !== 'M' && value !== 'L') throw new Error(`unknown scale ${value}`);
      options.scale = value;
      index += 1;
    } else if (arg === '--seed') {
      options.seed = Number(argv[index + 1]);
      index += 1;
    } else if (arg === '--iterations') {
      options.iterations = Number(argv[index + 1]);
      index += 1;
    } else if (arg === '--json') {
      options.jsonPath = argv[index + 1]!;
      index += 1;
    } else if (arg === '--md') {
      options.mdPath = argv[index + 1]!;
      index += 1;
    } else if (arg === '--keep-work-root') {
      options.keepWorkRoot = true;
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  const result = await runBenchmark({ scale: options.scale, seed: options.seed, iterations: options.iterations });
  const markdown = renderMarkdown(result);
  const jsonPath = options.jsonPath ?? join(tmpdir(), 'ano-structure-analysis-benchmark', `benchmark-${options.scale}.json`);
  const mdPath = options.mdPath ?? join(tmpdir(), 'ano-structure-analysis-benchmark', `benchmark-${options.scale}.md`);
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(mdPath, markdown);
  if (!options.keepWorkRoot) removeTempRoot(result.fixture.root);
  else console.log(`夹具保留：${result.fixture.root}`);
  process.stdout.write(markdown);
  process.stdout.write(`\nJSON 写入：${jsonPath}\nMD 写入：${mdPath}\n`);
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await main();
}
