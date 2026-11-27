import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { initViews } from '../../src/ledger/views.ts';
import { defaultViewsPath, readExploredProjection } from '../../src/memory/explored-state.ts';
import { decidePreTool, type PreToolContext } from '../../src/hooks/pre-tool.ts';
import type { HookInput } from '../../src/hooks/contract.ts';

/**
 * T-164 pre-tool benchmark. Deliberately `.bench.ts` so the core `.test.ts`
 * suite does not pick it up; run explicitly:
 *   node --test test/benchmark/hook-pre-tool.bench.ts
 *
 * Fixture: 1200 source files, all recorded as `structure.queried` file-level
 * evidence at the current graph revision. Each decision exercises the real
 * read-only views projection (rule 6). Warm-run P95 must be <= 300 ms; the
 * cold-start (first decision after the fixture is created) is measured and
 * reported separately, never folded into the gate.
 *
 * The views cache is populated by the same `initViews` schema and the same
 * `explored_files` / `structure_queries` rows that a replayed
 * `structure.queried` event stream produces; populating them in one transaction
 * keeps fixture setup cost out of the measured decision latency. The decision
 * path under test is unchanged: it opens the cache read-only on every call.
 */

const FILE_COUNT = 1200;
const REVISION = 'bench-rev-1';
/** Statistically meaningful P95 sample; each decision reopens the views DB. */
const WARM_DECISIONS = 240;

interface LatencyStats {
  readonly count: number;
  readonly minMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  readonly meanMs: number;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

function round(value: number): number { return Math.round(value * 100) / 100; }

function stats(samples: readonly number[]): LatencyStats {
  if (samples.length === 0) return { count: 0, minMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0, meanMs: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: samples.length,
    minMs: round(sorted[0]!),
    p50Ms: round(percentile(sorted, 50)),
    p95Ms: round(percentile(sorted, 95)),
    p99Ms: round(percentile(sorted, 99)),
    maxMs: round(sorted.at(-1)!),
    meanMs: round(samples.reduce((sum, value) => sum + value, 0) / samples.length),
  };
}

function removeTempRoot(root: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try { rmSync(root, { recursive: true, force: true }); return; }
    catch { if (attempt >= 9) return; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); }
  }
}

function buildFixture(root: string, files: readonly string[]): void {
  for (const file of files) {
    const absolute = join(root, file);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, `export const x = ${file.length};\n`);
  }
}

function recordExplored(root: string, files: readonly string[]): void {
  const viewsPath = defaultViewsPath(root);
  mkdirSync(dirname(viewsPath), { recursive: true });
  const db = new DatabaseSync(viewsPath);
  initViews(db);
  const insertQuery = db.prepare(`INSERT INTO structure_queries
    (event_id, file, granularity, ref, graph_revision, query, result, recorded_at, hlc_physical, hlc_logical, hlc_actor, actor)
    VALUES (?, ?, 'file', ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertExplored = db.prepare(`INSERT INTO explored_files
    (file, graph_revision, event_id, recorded_at, hlc_physical, hlc_logical, hlc_actor)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  db.exec('BEGIN');
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index]!;
    const eventId = `bench-event-${String(index).padStart(5, '0')}`;
    const result = JSON.stringify({ total: 1, returned: 1, truncated: false, impact: [], classification: 'parsed' });
    insertQuery.run(eventId, file, null, REVISION, 'outline', result, '2026-01-01T00:00:00.000Z', 1_000_000, index, 'B', 'B');
    insertExplored.run(file, REVISION, eventId, '2026-01-01T00:00:00.000Z', 1_000_000, index, 'B');
  }
  db.exec('COMMIT');
  db.close();
}

function makeInput(files: readonly string[]): HookInput[] {
  return files.map((file) => ({
    event: 'pre-tool', client: 'zcode', hostSessionId: 'bench', cwd: '/', targetPaths: [file],
  }));
}

test('pre-tool 在 1200 文件夹具上 P95 <= 300ms（冷启动单独报告）', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ano-pre-tool-bench-'));
  t.after(() => removeTempRoot(root));

  const files: string[] = [];
  for (let index = 0; index < FILE_COUNT; index += 1) files.push(`src/mod-${String(index).padStart(4, '0')}.ts`);
  buildFixture(root, files);
  recordExplored(root, files);

  const viewsPath = defaultViewsPath(root);
  assert.equal(readExploredProjection(viewsPath, REVISION).exploredFiles.length, FILE_COUNT);

  const freshness: PreToolContext['freshness'] = { status: 'fresh', stale: 0 };
  const ctx: PreToolContext = { mode: 'advisory', root, freshness, revision: REVISION };
  const inputs = makeInput(files);

  // Cold start: first decision opens the views cache read-only for the first
  // time. Reported separately, never folded into the P95 gate.
  const coldStart = performance.now();
  const coldDecision = decidePreTool(inputs[0]!, ctx);
  const coldStartMs = round(performance.now() - coldStart);
  assert.equal(coldDecision.kind, 'allow', 'explored file at current revision must be allowed');

  // Warm latency: evenly sample the 1200-file current-revision projection.
  // Every decision does a real read-only views.db open plus the projection
  // lookup; no cross-call cache is retained by the engine.
  const samples: number[] = [];
  const stride = FILE_COUNT / WARM_DECISIONS;
  for (let index = 0; index < WARM_DECISIONS; index += 1) {
    const input = inputs[Math.min(FILE_COUNT - 1, Math.floor(index * stride))]!;
    const start = performance.now();
    const decision = decidePreTool(input, ctx);
    samples.push(performance.now() - start);
    assert.equal(decision.kind, 'allow');
  }

  const warm = stats(samples);
  const report = {
    fixtureFiles: FILE_COUNT,
    decisions: samples.length,
    sampledStride: stride,
    warm,
    coldStartMs,
    gate: { metric: 'warm.p95Ms', thresholdMs: 300, unit: 'ms' },
  };
  console.log(`pre-tool bench: ${JSON.stringify(report)}`);

  assert.equal(warm.count, WARM_DECISIONS);
  assert.ok(warm.p95Ms <= 300, `warm P95 ${String(warm.p95Ms)}ms exceeds 300ms`);
  // Cold start is reported, never silently mixed into the warm gate.
  assert.ok(Number.isFinite(coldStartMs) && coldStartMs >= 0);
});
