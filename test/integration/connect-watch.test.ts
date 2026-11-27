import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  connectProject,
  connectionStatus,
  createConnectEngine,
  exportConnection,
  planConnection,
  pmMcpAdapter,
  DEFAULT_SCAN_LIMITS,
  watchConnection,
  CONNECT_WATCH_SCHEMA,
  MIN_WATCH_INTERVAL_MS,
  type ConnectEngine,
  type ConnectWatchReport,
  type ScanLimits,
  type SourceAdapter,
  type SourceScan,
} from '../../src/connect/index.ts';
import { runCli } from '../../src/surface/cli.ts';

const CONNECT_DIR = join('.ano', 'connect');

async function rootFor(t: TestContext, prefix = 'ano-connect-watch-'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function makeFixture(root: string): Promise<void> {
  const pm = join(root, '.pm');
  await mkdir(join(pm, 'decisions'), { recursive: true });
  await writeJson(join(pm, 'project.json'), { name: 'Watch Fixture', exposure: 'local' });
  await writeJson(join(pm, 'tasks.json'), {
    seq: 1,
    tasks: [{ id: 'T-1', title: 'one', status: 'todo', type: 'feature', milestone: 'M1', priority: 'P0' }],
  });
  await writeJson(join(pm, 'roadmap.json'), {
    seq: 1,
    milestones: [{ id: 'M1', title: 'Milestone one', status: 'in_progress', order: 1 }],
  });
  await writeFile(join(pm, 'decisions', 'ADR-1.md'), '# ADR one\n\nDecision body.\n', 'utf8');
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string, rel: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = join(current, entry.name);
      const next = rel.length > 0 ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(full, next);
      else if (entry.isFile()) out.push(next);
    }
  }
  await walk(dir, '');
  return out.sort();
}

async function sourceSignature(root: string): Promise<{ hash: string; files: string[] }> {
  const base = join(root, '.pm');
  const files = await listFiles(base);
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file);
    hash.update('\0');
    hash.update(await readFile(join(base, file)));
    hash.update('\0');
  }
  return { hash: hash.digest('hex'), files };
}

function tasksJson(title: string, seq: number): string {
  return `${JSON.stringify({
    seq,
    tasks: [{ id: 'T-1', title, status: 'todo', type: 'feature', milestone: 'M1', priority: 'P0' }],
  }, null, 2)}\n`;
}

function spyEngine(inner: ConnectEngine, onConnect: (expectedDigest?: string) => void): ConnectEngine {
  return {
    planConnection: (root, options) => inner.planConnection(root, options),
    connectProject: (root, options) => {
      onConnect(options?.expectedDigest);
      return inner.connectProject(root, options);
    },
    connectionStatus: (root) => inner.connectionStatus(root),
    recallConnected: (root, input) => inner.recallConnected(root, input),
    exportConnection: (root) => inner.exportConnection(root),
    handoffReadiness: (root) => inner.handoffReadiness(root),
  };
}

test('watch commits once, then skips an unchanged digest and never touches the source', async (t) => {
  const root = await rootFor(t);
  await makeFixture(root);
  const before = await sourceSignature(root);

  const report = await watchConnection({ root, intervalMs: 50, maxCycles: 3 });

  assert.equal(report.schema, CONNECT_WATCH_SCHEMA);
  assert.equal(report.stopped, 'max-cycles');
  assert.equal(report.cycles, 3);
  assert.equal(report.intervalMs, 50);
  assert.deepEqual(report.records.map((record) => record.outcome), ['committed', 'unchanged', 'unchanged']);
  const first = report.records[0];
  assert.ok(first);
  assert.equal(report.committedDigest, first.plannedDigest);
  assert.match(first.plannedDigest, /^[0-9a-f]{64}$/);

  const status = await connectionStatus(root);
  assert.equal(status.connections[0]?.currentVersion, 1);
  assert.equal(status.tasks.find((task) => task.sourceId === 'T-1')?.title, 'one');

  const after = await sourceSignature(root);
  assert.deepEqual(after, before, 'watch must never write back to the source');
});

test('watch commits a changed digest with expectedDigest and keeps versions', async (t) => {
  const root = await rootFor(t);
  await makeFixture(root);

  const report = await watchConnection({
    root,
    intervalMs: 50,
    maxCycles: 2,
    onCycle: (record) => {
      if (record.cycle === 1) writeFileSync(join(root, '.pm', 'tasks.json'), tasksJson('one-changed', 2));
    },
  });

  assert.deepEqual(report.records.map((record) => record.outcome), ['committed', 'committed']);
  assert.notEqual(report.records[0]?.plannedDigest, report.records[1]?.plannedDigest);
  const status = await connectionStatus(root);
  assert.equal(status.connections[0]?.currentVersion, 2);
  assert.equal(status.tasks.find((task) => task.sourceId === 'T-1')?.title, 'one-changed');
});

test('only digest changes trigger connectProject, always with expectedDigest', async (t) => {
  const root = await rootFor(t);
  await makeFixture(root);
  const calls: Array<string | undefined> = [];
  const engine = spyEngine(createConnectEngine(), (expectedDigest) => calls.push(expectedDigest));

  const report = await watchConnection({
    root,
    intervalMs: 50,
    maxCycles: 2,
    engine,
    onCycle: (record) => {
      if (record.cycle === 1) writeFileSync(join(root, '.pm', 'tasks.json'), tasksJson('changed', 2));
    },
  });

  assert.equal(calls.length, 2, 'unchanged cycles must not call connectProject');
  assert.equal(calls[0], report.records[0]?.plannedDigest);
  assert.equal(calls[1], report.records[1]?.plannedDigest);
  assert.notEqual(calls[0], calls[1]);
});

test('source change between plan and commit is surfaced and writes nothing', async (t) => {
  const root = await rootFor(t);
  await makeFixture(root);
  const base = await pmMcpAdapter.scan(root, DEFAULT_SCAN_LIMITS);
  const planned = base.sourceDigest;
  const actual = 'a'.repeat(64);
  assert.notEqual(planned, actual);

  let scanCalls = 0;
  const scripted: SourceAdapter = {
    kind: 'pm-mcp',
    async scan(scanRoot: string, limits: ScanLimits): Promise<SourceScan> {
      scanCalls += 1;
      // Call order: 1) planConnection observes the planned digest, 2) connectProject's
      // initial scan observes a different digest and refuses to write.
      void scanRoot;
      void limits;
      return { ...base, sourceDigest: scanCalls === 1 ? planned : actual };
    },
  };

  const report = await watchConnection({
    root,
    intervalMs: 50,
    maxCycles: 1,
    engine: createConnectEngine({ adapter: scripted }),
  });

  assert.equal(scanCalls, 2, 'plan scan plus the refused initial connect scan');
  assert.equal(report.stopped, 'max-cycles');
  assert.equal(report.cycles, 1);
  const record = report.records[0];
  assert.ok(record);
  assert.equal(record.outcome, 'source-changed');
  assert.equal(record.message, 'source-changed');
  assert.equal(record.result?.sourceUnchanged, false);
  assert.equal(record.result?.report.connected, false);
  assert.equal(report.committedDigest, undefined);
  assert.equal(existsSync(join(root, '.ano')), false, 'a refused commit must not create the store');
});

test('an adapter error stops the watch and leaves the last committed state intact', async (t) => {
  const root = await rootFor(t);
  await makeFixture(root);
  let fail = false;
  const flaky: SourceAdapter = {
    kind: 'pm-mcp',
    async scan(scanRoot: string, limits: ScanLimits): Promise<SourceScan> {
      if (fail) throw new Error('injected scan failure');
      return pmMcpAdapter.scan(scanRoot, limits);
    },
  };

  const report = await watchConnection({
    root,
    intervalMs: 50,
    maxCycles: 3,
    engine: createConnectEngine({ adapter: flaky }),
    onCycle: (record) => {
      if (record.cycle === 1) fail = true;
    },
  });

  assert.equal(report.stopped, 'error');
  assert.equal(report.cycles, 2);
  assert.match(report.error ?? '', /injected scan failure/);
  const failed = report.records[1];
  assert.ok(failed);
  assert.equal(failed.outcome, 'error');
  assert.match(failed.message ?? '', /injected scan failure/);
  assert.equal(report.committedDigest, report.records[0]?.plannedDigest);

  const status = await connectionStatus(root);
  assert.equal(status.connected, true);
  assert.equal(status.connections[0]?.currentVersion, 1);
  assert.equal(status.tasks.find((task) => task.sourceId === 'T-1')?.title, 'one');
});

test('a scan error on the first cycle stops honestly without creating a store', async (t) => {
  const root = await rootFor(t);
  await makeFixture(root);
  const broken: SourceAdapter = {
    kind: 'pm-mcp',
    async scan(): Promise<SourceScan> {
      throw new Error('source unavailable');
    },
  };

  const report = await watchConnection({
    root,
    intervalMs: 50,
    maxCycles: 5,
    engine: createConnectEngine({ adapter: broken }),
  });

  assert.equal(report.stopped, 'error');
  assert.equal(report.cycles, 1);
  assert.match(report.error ?? '', /source unavailable/);
  assert.equal(report.committedDigest, undefined);
  assert.equal(existsSync(join(root, '.ano')), false);
});

test('AbortSignal stops the watch promptly, including mid-sleep', async (t) => {
  const root = await rootFor(t);
  await makeFixture(root);

  const controller = new AbortController();
  const aborted = await watchConnection({
    root,
    intervalMs: 50,
    maxCycles: 100,
    signal: controller.signal,
    onCycle: (record) => {
      if (record.cycle === 1) controller.abort();
    },
  });
  assert.equal(aborted.stopped, 'aborted');
  assert.equal(aborted.cycles, 1);
  assert.equal(aborted.records[0]?.outcome, 'committed');

  const preAborted = new AbortController();
  preAborted.abort();
  const immediate = await watchConnection({ root, intervalMs: 50, maxCycles: 5, signal: preAborted.signal });
  assert.equal(immediate.stopped, 'aborted');
  assert.equal(immediate.cycles, 0);
  assert.deepEqual(immediate.records, []);

  const sleeper = new AbortController();
  const started = Date.now();
  const timer = setTimeout(() => sleeper.abort(), 100);
  const duringSleep = await watchConnection({
    root,
    intervalMs: 60_000,
    maxCycles: 10,
    signal: sleeper.signal,
  });
  clearTimeout(timer);
  assert.equal(duringSleep.stopped, 'aborted');
  assert.equal(duringSleep.cycles, 1);
  assert.ok(Date.now() - started < 5000, 'abort during the inter-cycle sleep must resolve promptly');
});

test('the interval is clamped to the documented minimum', async (t) => {
  const root = await rootFor(t);
  await makeFixture(root);
  const started = Date.now();
  const report = await watchConnection({ root, intervalMs: 1, maxCycles: 2 });
  assert.equal(report.intervalMs, MIN_WATCH_INTERVAL_MS);
  assert.ok(Date.now() - started >= MIN_WATCH_INTERVAL_MS, 'the clamped interval must actually be awaited');

  const fallback = await watchConnection({ root, maxCycles: 1 });
  assert.equal(fallback.intervalMs, 1000);
});

test('cycles never overlap', async (t) => {
  const root = await rootFor(t);
  await makeFixture(root);
  let active = 0;
  let maxActive = 0;
  const slow: SourceAdapter = {
    kind: 'pm-mcp',
    async scan(scanRoot: string, limits: ScanLimits): Promise<SourceScan> {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return pmMcpAdapter.scan(scanRoot, limits);
      } finally {
        active -= 1;
      }
    },
  };

  const report = await watchConnection({
    root,
    intervalMs: 50,
    maxCycles: 3,
    engine: createConnectEngine({ adapter: slow }),
  });

  assert.equal(report.cycles, 3);
  assert.equal(maxActive, 1, 'plan and commit scans must be serial');
});

test('watch preserves idempotent snapshots across A->B->A', async (t) => {
  const root = await rootFor(t);
  await makeFixture(root);
  const versionA = tasksJson('A', 1);
  const versionB = tasksJson('B', 2);
  writeFileSync(join(root, '.pm', 'tasks.json'), versionA);

  const report = await watchConnection({
    root,
    intervalMs: 50,
    maxCycles: 3,
    onCycle: (record) => {
      if (record.cycle === 1) writeFileSync(join(root, '.pm', 'tasks.json'), versionB);
      if (record.cycle === 2) writeFileSync(join(root, '.pm', 'tasks.json'), versionA);
    },
  });

  assert.deepEqual(report.records.map((record) => record.outcome), ['committed', 'committed', 'committed']);
  const exported = await exportConnection(root);
  assert.equal(exported.versions.length, 3);
  const first = exported.versions[0];
  const third = exported.versions[2];
  assert.ok(first && third);
  assert.equal(third.snapshotPath, first.snapshotPath, 'A->B->A reuses the immutable snapshot');
  assert.equal(third.sourceDigest, first.sourceDigest);
  assert.notEqual(exported.versions[1]?.sourceDigest, first.sourceDigest);
});

test('CLI connect watch stays foreground, is bounded and validates flags', async (t) => {
  const root = await rootFor(t);
  await makeFixture(root);

  const help = await runCli(['--help']);
  assert.match(help.output, /ano connect \[plan\|status\|resume\|export\|handoff\|ui\|watch\]/);

  const badInterval = await runCli(['connect', 'watch', '--root', root, '--interval', '10', '--max-cycles', '1']);
  assert.equal(badInterval.code, 2);
  assert.match(badInterval.output, /--interval/);

  const badMax = await runCli(['connect', 'watch', '--root', root, '--interval', '50', '--max-cycles', '0']);
  assert.equal(badMax.code, 2);
  assert.match(badMax.output, /--max-cycles/);

  const result = await runCli(['connect', 'watch', '--root', root, '--interval', '50', '--max-cycles', '2']);
  assert.equal(result.code, 0, result.output);
  const report = JSON.parse(result.output) as ConnectWatchReport;
  assert.equal(report.schema, CONNECT_WATCH_SCHEMA);
  assert.equal(report.stopped, 'max-cycles');
  assert.equal(report.cycles, 2);
  assert.equal(report.intervalMs, 50);
  assert.equal((await connectionStatus(root)).connections[0]?.currentVersion, 1);
});

test('plan digest is recomputed every cycle even when the source is unchanged', async (t) => {
  const root = await rootFor(t);
  await makeFixture(root);
  const planned: string[] = [];
  const inner = createConnectEngine();
  const engine: ConnectEngine = {
    planConnection: async (planRoot, options) => {
      const plan = await inner.planConnection(planRoot, options);
      planned.push(plan.sourceDigest);
      return plan;
    },
    connectProject: (connectRoot, options) => inner.connectProject(connectRoot, options),
    connectionStatus: (statusRoot) => inner.connectionStatus(statusRoot),
    recallConnected: (recallRoot, input) => inner.recallConnected(recallRoot, input),
    exportConnection: (exportRoot) => inner.exportConnection(exportRoot),
    handoffReadiness: (handoffRoot) => inner.handoffReadiness(handoffRoot),
  };

  const report = await watchConnection({ root, intervalMs: 50, maxCycles: 3, engine });

  assert.equal(planned.length, 3, 'every cycle plans the source digest');
  assert.deepEqual(report.records.map((record) => record.plannedDigest), planned);
  assert.equal(report.cycles, 3);
});

test('public watch API is exported and a second connect outside the watch still works', async (t) => {
  const root = await rootFor(t);
  await makeFixture(root);
  assert.equal(typeof watchConnection, 'function');
  assert.equal(typeof planConnection, 'function');
  await watchConnection({ root, intervalMs: 50, maxCycles: 1 });
  const resumed = await connectProject(root);
  assert.equal(resumed.duplicate, true);
  assert.equal(resumed.report.version, 1);
});
