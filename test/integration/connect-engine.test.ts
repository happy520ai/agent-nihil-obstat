import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  connectProject,
  connectionStatus,
  createConnectEngine,
  exportConnection,
  handoffReadiness,
  planConnection,
  recallConnected,
  ConnectSourceError,
  ConnectStoreError,
  ConnectTamperError,
  ConnectLimitError,
} from '../../src/connect/index.ts';
import { Ledger } from '../../src/ledger/ledger.ts';

const CONNECT_DIR = join('.ano', 'connect');

async function rootFor(t: TestContext, prefix = 'ano-connect-'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

interface FixtureOptions {
  project?: string;
  tasks?: unknown[];
  extra?: Record<string, string | Buffer>;
}

const DEFAULT_TASKS: unknown[] = [
  {
    id: 'T-1',
    title: 'First task',
    status: 'done',
    type: 'feature',
    milestone: 'M1',
    priority: 'P0',
    detail: 'unique-needle in the first task',
    unknownField: { keep: true, nested: [1, 2, 3] },
  },
  { id: 'T-2', title: 'Second task', status: 'in_progress', type: 'fix', milestone: 'M2', priority: 'P1', detail: 'banana' },
  { id: 'T-3', title: 'Cancelled task', status: 'cancelled', type: 'feature', milestone: 'M1', priority: 'P2' },
];

async function makeFixture(root: string, options: FixtureOptions = {}): Promise<void> {
  const pm = join(root, '.pm');
  await mkdir(join(pm, 'decisions'), { recursive: true });
  await writeJson(join(pm, 'project.json'), { name: options.project ?? 'Fixture Project', exposure: 'local' });
  await writeJson(join(pm, 'tasks.json'), { seq: options.tasks?.length ?? 1, tasks: options.tasks ?? DEFAULT_TASKS });
  await writeJson(join(pm, 'roadmap.json'), {
    seq: 1,
    milestones: [
      { id: 'M1', title: 'Milestone one', status: 'done', order: 1 },
      { id: 'M2', title: 'Milestone two', status: 'in_progress', order: 2 },
    ],
  });
  await writeJson(join(pm, 'features.json'), {
    seq: 1,
    features: [{ id: 'F-1', name: 'Feature one', status: 'implemented', entry_files: ['src/a.ts'] }],
  });
  await writeJson(join(pm, 'sessions.json'), {
    seq: 1,
    sessions: [{ id: 'S-1', date: '2026-01-01T00:00:00.000Z', author: 'test', summary: 'session summary' }],
  });
  await writeFile(join(pm, 'decisions', 'ADR-1.md'), '# ADR one\n\nDecision body with needle-decision.\n', 'utf8');
  const extra = options.extra ?? {
    'notes/custom.txt': 'custom text file\nsecond line\n',
    'blobs/logo.bin': Buffer.from([0, 1, 2, 3, 255, 254]),
  };
  for (const [name, content] of Object.entries(extra)) {
    const target = join(pm, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
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

async function hashTree(root: string, sub = ''): Promise<string> {
  const base = sub.length > 0 ? join(root, sub) : root;
  const hash = createHash('sha256');
  let files: string[] = [];
  try {
    files = await listFiles(base);
  } catch {
    return 'missing';
  }
  for (const file of files) {
    const full = join(base, file);
    const content = await readFile(full);
    const metadata = await stat(full);
    hash.update(file);
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
    hash.update(String(metadata.mtimeMs));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function sourceSignature(root: string): Promise<{ hash: string; files: string[] }> {
  return { hash: await hashTree(root, '.pm'), files: await listFiles(join(root, '.pm')) };
}

test('planConnection is zero-write and reports a complete plan', async (t) => {
  const root = await rootFor(t);
  await makeFixture(root);
  const before = await sourceSignature(root);

  const plan = await planConnection(root);

  assert.equal(plan.schema, 'ano.connect/1');
  assert.equal(plan.source, 'pm-mcp');
  assert.equal(plan.root, root);
  assert.match(plan.connectionId, /^CN-[0-9a-f]{16}$/);
  assert.match(plan.sourceDigest, /^[0-9a-f]{64}$/);
  assert.equal(plan.canConnect, true);
  assert.equal(plan.identity.tool, 'pm-mcp');
  assert.equal(plan.identity.displayName, 'Fixture Project');
  assert.ok(plan.files.some((file) => file.path === 'tasks.json'));
  assert.ok(plan.files.some((file) => file.path === 'blobs/logo.bin'));
  assert.equal(plan.counts.tasks, 3);
  assert.equal(plan.counts.files, plan.files.length);
  assert.equal(plan.capabilities.join(','), 'read,recall,export');
  assert.equal(existsSync(join(root, '.ano')), false, 'plan must not create .ano');

  const after = await sourceSignature(root);
  assert.equal(after.hash, before.hash, 'plan must not change source bytes or mtimes');
  assert.deepEqual(after.files, before.files);
});

test('connect is idempotent: duplicate run adds no files and leaves source untouched', async (t) => {
  const root = await rootFor(t);
  await makeFixture(root);
  const sourceBefore = await sourceSignature(root);

  const first = await connectProject(root);
  assert.equal(first.duplicate, false);
  assert.equal(first.report.connected, true);
  assert.equal(first.report.version, 1);
  assert.ok(first.report.files > 0);
  assert.ok(first.report.snapshotPath.endsWith('.json'));

  const storeBefore = await listFiles(join(root, CONNECT_DIR));
  const second = await connectProject(root);
  assert.equal(second.duplicate, true);
  assert.equal(second.sourceUnchanged, true);
  assert.equal(second.report.version, 1);
  const storeAfter = await listFiles(join(root, CONNECT_DIR));
  assert.deepEqual(storeAfter, storeBefore, 'duplicate connect must not add or remove store files');

  const sourceAfter = await sourceSignature(root);
  assert.equal(sourceAfter.hash, sourceBefore.hash);
});

test('done maps to completed + unverified and the ANO ledger Gate state is untouched', async (t) => {
  const root = await rootFor(t);
  await makeFixture(root);

  const ledger = await Ledger.open(root, { sessionId: 'connect-gate-test' });
  await ledger.createTask('T-GATE', ['src/gate.ts'], 'Gate task');
  const ledgerBefore = await ledger.getTask('T-GATE');
  assert.equal(ledgerBefore?.status, 'todo');
  ledger.close();
  const ledgerHashBefore = await hashTree(root, join('.ano', 'ledger'));

  const result = await connectProject(root);
  assert.equal(result.report.tasks, 3);

  const ledgerHashAfter = await hashTree(root, join('.ano', 'ledger'));
  assert.equal(ledgerHashAfter, ledgerHashBefore, 'connect must not modify the ANO ledger/Gate store');
  const reopened = await Ledger.open(root, { sessionId: 'connect-gate-test' });
  assert.equal(reopened.getTask('T-GATE')?.status, 'todo');
  reopened.close();

  const status = await connectionStatus(root);
  assert.equal(status.connected, true);
  assert.equal(status.tasks.length, 3);
  const done = status.tasks.find((task) => task.sourceId === 'T-1');
  assert.ok(done);
  assert.equal(done.status, 'done', 'original status string is preserved');
  assert.equal(done.category, 'completed');
  assert.equal(done.verification, 'unverified');
  assert.deepEqual(done.raw.unknownField, { keep: true, nested: [1, 2, 3] });
  assert.equal(done.identity.kind, 'task');
  assert.equal(done.identity.tool, 'pm-mcp');
  assert.notEqual(done.id, 'T-1');
  assert.ok(done.id.startsWith('CN-'));
  assert.equal(status.untrusted, true);
});

test('all files and unknown fields are archived and export reconstructs exact bytes', async (t) => {
  const root = await rootFor(t);
  const binary = Buffer.from([0, 1, 2, 3, 255, 254]);
  const custom = 'custom text file\nsecond line\n';
  await makeFixture(root, { extra: { 'notes/custom.txt': custom, 'blobs/logo.bin': binary, 'weird/unknown.dat': 'mystery' } });
  const tasksBytes = await readFile(join(root, '.pm', 'tasks.json'));

  await connectProject(root);
  const exported = await exportConnection(root);

  assert.equal(exported.schema, 'ano.connect-export/1');
  assert.equal(exported.versions.length, 1);
  const files = exported.versions[0]?.files ?? [];
  const tasksEntry = files.find((file) => file.path === 'tasks.json');
  if (!tasksEntry) throw new Error('tasks.json missing from export');
  assert.equal(tasksEntry.base64, tasksBytes.toString('base64'));
  assert.equal(Buffer.from(tasksEntry.base64, 'base64').equals(tasksBytes), true);
  assert.equal(tasksEntry.bytes, tasksBytes.length);
  const binaryEntry = files.find((file) => file.path === 'blobs/logo.bin');
  if (!binaryEntry) throw new Error('binary missing from export');
  assert.equal(Buffer.from(binaryEntry.base64, 'base64').equals(binary), true);
  const customEntry = files.find((file) => file.path === 'notes/custom.txt');
  if (!customEntry) throw new Error('custom text missing from export');
  assert.equal(Buffer.from(customEntry.base64, 'base64').toString('utf8'), custom);
  assert.ok(files.some((file) => file.path === 'weird/unknown.dat'));

  const taskRecord = exported.records.find((record) => record['id'] === 'T-1');
  assert.ok(taskRecord);
  assert.deepEqual((taskRecord as Record<string, unknown>).unknownField, { keep: true, nested: [1, 2, 3] });
  assert.equal(exported.tasks.find((task) => task.sourceId === 'T-1')?.verification, 'unverified');
  assert.ok(exported.limitations.some((limit) => limit.includes('not a native pm-mcp ledger')));
  assert.ok(exported.limitations.some((limit) => limit.includes('does not automatically write')));
});

test('source change appends a version, refuses a stale expectedDigest and archives deletions', async (t) => {
  const root = await rootFor(t);
  await makeFixture(root, { tasks: [
    { id: 'T-1', title: 'Original one', status: 'todo', detail: 'keep' },
    { id: 'T-2', title: 'Doomed two', status: 'todo', detail: 'remove me' },
  ] });
  const first = await connectProject(root);
  const firstDigest = first.sourceDigest;
  assert.equal(first.report.version, 1);

  await writeJson(join(root, '.pm', 'tasks.json'), { seq: 2, tasks: [
    { id: 'T-1', title: 'Renamed one', status: 'in_progress', detail: 'keep' },
    { id: 'T-3', title: 'New three', status: 'todo' },
  ] });

  const refused = await connectProject(root, { expectedDigest: firstDigest });
  assert.equal(refused.sourceUnchanged, false);
  assert.equal(refused.duplicate, false);
  assert.equal(refused.report.connected, false);
  assert.equal((await connectionStatus(root)).connections[0]?.currentVersion, 1);

  const second = await connectProject(root);
  assert.equal(second.duplicate, false);
  assert.equal(second.report.version, 2);
  assert.equal(second.report.changes.removed, 1);
  assert.equal(second.report.changes.updated, 1);
  assert.equal(second.report.changes.added, 1);

  const status = await connectionStatus(root);
  assert.deepEqual(status.tasks.map((task) => task.sourceId).sort(), ['T-1', 'T-3']);
  const renamed = status.tasks.find((task) => task.sourceId === 'T-1');
  assert.equal(renamed?.title, 'Renamed one');
  assert.equal(renamed?.status, 'in_progress');
  assert.equal(renamed?.category, 'in_progress');

  const exported = await exportConnection(root);
  assert.equal(exported.versions.length, 2);
  const v1Files = exported.versions.find((version) => version.version === 1)?.files ?? [];
  assert.ok(v1Files.some((file) => file.path === 'tasks.json'), 'old version raw files are retained');
  const removed = exported.changes.find((change) => change.kind === 'removed');
  assert.ok(removed);
  assert.equal(removed.sourcePath, 'tasks.json');
  assert.ok(removed.archivedIn, 'deletion has an explicit archival destination');
  assert.equal(existsSync(join(root, removed.archivedIn as string)), true);
  assert.ok(existsSync(join(root, CONNECT_DIR, 'snapshots')));

  const recall = await recallConnected(root, { query: 'Doomed two' });
  assert.ok(recall.results.some((hit) => hit.version === 1), 'history remains searchable');
});

test('duplicate ids, malformed JSON and a missing source fail closed', async (t) => {
  const duplicate = await rootFor(t);
  await makeFixture(duplicate, { tasks: [
    { id: 'T-DUP', title: 'one', status: 'todo' },
    { id: 'T-DUP', title: 'two', status: 'todo' },
  ] });
  await assert.rejects(planConnection(duplicate), ConnectSourceError);

  const malformed = await rootFor(t);
  await makeFixture(malformed);
  await writeFile(join(malformed, '.pm', 'tasks.json'), '{ not json', 'utf8');
  await assert.rejects(connectProject(malformed), ConnectSourceError);

  const missing = await rootFor(t);
  await assert.rejects(planConnection(missing), ConnectSourceError);

  const unsupported = await rootFor(t);
  await makeFixture(unsupported);
  await assert.rejects(connectProject(unsupported, { source: 'other' as unknown as 'pm-mcp' }), ConnectSourceError);
});

test('symlinks, junctions and path escapes are refused without following them', async (t) => {
  const root = await rootFor(t);
  const outside = await rootFor(t, 'ano-connect-outside-');
  await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8');
  await makeFixture(root);
  await symlink(outside, join(root, '.pm', 'link-dir'), 'junction');
  await assert.rejects(planConnection(root), /symbolic link|junction/i);
  await rm(join(root, '.pm', 'link-dir'));

  const linkedPm = await rootFor(t);
  const realPm = await rootFor(t, 'ano-connect-realpm-');
  await makeFixture(realPm);
  await symlink(realPm, join(linkedPm, '.pm'), 'junction');
  await assert.rejects(planConnection(linkedPm), /symbolic link|junction/i);
});

test('tampered blobs and corrupt storage are rejected, never treated as empty', async (t) => {
  const root = await rootFor(t);
  await makeFixture(root);
  await connectProject(root);
  const exported = await exportConnection(root);
  const entry = exported.versions[0]?.files.find((file) => file.path === 'tasks.json');
  if (!entry) throw new Error('tasks.json blob missing');
  const blobPath = join(root, CONNECT_DIR, 'blobs', entry.hash);
  await appendFile(blobPath, Buffer.from([1]));
  await assert.rejects(connectionStatus(root), ConnectTamperError);
  await assert.rejects(exportConnection(root), ConnectTamperError);

  const corrupt = await rootFor(t);
  await makeFixture(corrupt);
  await connectProject(corrupt);
  await rm(join(corrupt, CONNECT_DIR, 'current.json'));
  // A missing current pointer is a first-commit crash window: readers project
  // the latest verified manifest without writing.
  const projected = await connectionStatus(corrupt);
  assert.equal(projected.connected, true);
  assert.equal(projected.connections[0]?.currentVersion, 1);
  assert.equal(existsSync(join(corrupt, CONNECT_DIR, 'current.json')), false, 'readers must not repair');
  const recalled = await recallConnected(corrupt, { query: 'task' });
  assert.ok(recalled.total >= 1);
  // The connect path performs the real repair under its lock.
  const repaired = await connectProject(corrupt);
  assert.equal(repaired.duplicate, true);
  assert.equal(existsSync(join(corrupt, CONNECT_DIR, 'current.json')), true);

  // A current pointer referencing an unknown digest is genuine corruption.
  const currentPath = join(corrupt, CONNECT_DIR, 'current.json');
  const manifest = JSON.parse(await readFile(currentPath, 'utf8')) as { connectionId: string };
  await writeJson(currentPath, {
    schema: 'ano.connect-current/1',
    connectionId: manifest.connectionId,
    sourceDigest: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    version: 99,
    snapshotPath: '.ano/connect/snapshots/missing.json',
    snapshotHash: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    updatedAt: new Date().toISOString(),
  });
  await assert.rejects(connectionStatus(corrupt), ConnectStoreError);
  await assert.rejects(recallConnected(corrupt), ConnectStoreError);
});

test('recall searches records and history with limits, truncation and untrusted marking', async (t) => {
  const root = await rootFor(t);
  const longText = `start-${'x'.repeat(1200)}-needle-long`;
  await makeFixture(root, { extra: { 'notes/long.txt': longText } });

  await connectProject(root);
  const hit = await recallConnected(root, { query: 'unique-needle' });
  assert.ok(hit.results.length >= 1);
  assert.equal(hit.untrusted, true);
  assert.match(hit.notice, /untrusted/i);
  const taskHit = hit.results.find((result) => result.kind === 'task');
  assert.ok(taskHit);
  assert.equal(taskHit.sourcePath, 'tasks.json');
  assert.equal(taskHit.snapshotDigest, (await connectionStatus(root)).connections[0]?.sourceDigest);

  const limited = await recallConnected(root, { query: 'task', limit: 1 });
  assert.equal(limited.results.length, 1);
  assert.equal(limited.limit, 1);
  assert.equal(limited.truncated, limited.total > 1);

  const long = await recallConnected(root, { query: 'needle-long' });
  assert.ok(long.results.length >= 1);
  assert.ok((long.results[0]?.text.length ?? 0) <= 501);
  assert.equal(long.results[0]?.truncated, true);

  const empty = await recallConnected(root, { query: 'definitely-not-present-xyz' });
  assert.equal(empty.results.length, 0);
  assert.equal(empty.total, 0);
});

test('non-Node, non-Git directories connect without any Node/Git dependency', async (t) => {
  const root = await rootFor(t);
  await makeFixture(root);
  assert.equal(existsSync(join(root, '.git')), false);
  assert.equal(existsSync(join(root, 'package.json')), false);
  assert.equal(existsSync(join(root, 'node_modules')), false);

  const result = await connectProject(root);
  assert.equal(result.report.connected, true);
  const status = await connectionStatus(root);
  assert.equal(status.connected, true);
  assert.equal(status.tasks.length, 3);
});

test('cross-project and cross-root identities never collide', async (t) => {
  const alpha = await rootFor(t);
  await makeFixture(alpha, { project: 'Alpha Project' });
  const beta = await rootFor(t);
  await makeFixture(beta, { project: 'Beta Project' });
  const alphaClone = await rootFor(t);
  await makeFixture(alphaClone, { project: 'Alpha Project' });

  const alphaResult = await connectProject(alpha);
  const betaResult = await connectProject(beta);
  const cloneResult = await connectProject(alphaClone);

  assert.notEqual(alphaResult.connectionId, betaResult.connectionId);
  assert.notEqual(alphaResult.connectionId, cloneResult.connectionId, 'same project in a different workspace gets a different instance id');

  const alphaStatus = await connectionStatus(alpha);
  const betaStatus = await connectionStatus(beta);
  const alphaTaskIds = new Set(alphaStatus.tasks.map((task) => task.id));
  const betaTaskIds = new Set(betaStatus.tasks.map((task) => task.id));
  for (const id of alphaTaskIds) assert.equal(betaTaskIds.has(id), false, `task id collision: ${id}`);
  assert.ok([...alphaTaskIds].every((id) => id.startsWith('CN-')));
});

test('fault injection leaves a checkpoint and a retry resumes without duplicate writes', async (t) => {
  const root = await rootFor(t);
  await makeFixture(root, { tasks: [
    { id: 'T-1', title: 'one', status: 'todo' },
    { id: 'T-2', title: 'two', status: 'todo' },
  ] });
  let attempts = 0;
  const failing = createConnectEngine({
    batchSize: 1,
    hooks: {
      afterBatch: async (info) => {
        attempts += 1;
        if (info.batchIndex === 0) throw new Error('injected batch failure');
      },
    },
  });
  await assert.rejects(failing.connectProject(root), /injected batch failure/);
  assert.equal(attempts, 1);
  assert.ok(existsSync(join(root, CONNECT_DIR, 'checkpoints')), 'checkpoint directory exists after failure');

  const resumed = await createConnectEngine({ batchSize: 1 }).connectProject(root);
  assert.equal(resumed.report.connected, true);
  assert.equal(resumed.report.resumedFromCheckpoint, true);
  assert.deepEqual((await listFiles(join(root, CONNECT_DIR, 'checkpoints'))), [], 'checkpoint is removed after success');

  const status = await connectionStatus(root);
  assert.equal(status.tasks.length, 2);
  const exported = await exportConnection(root);
  assert.ok(exported.versions[0]?.files.length === status.connections[0]?.files);
});

test('status and recall with no connection are zero-write and return empty', async (t) => {
  const root = await rootFor(t);
  await makeFixture(root);

  const status = await connectionStatus(root);
  assert.equal(status.connected, false);
  assert.deepEqual(status.tasks, []);
  assert.deepEqual(status.connections, []);
  const recall = await recallConnected(root, { query: 'anything' });
  assert.equal(recall.total, 0);
  assert.deepEqual(recall.results, []);
  assert.equal(existsSync(join(root, '.ano')), false, 'read-only status must not create .ano');
});

test('size limits fail loudly instead of silently truncating', async (t) => {
  const root = await rootFor(t);
  await makeFixture(root);
  const engine = createConnectEngine({ maxFileBytes: 8 });
  await assert.rejects(engine.planConnection(root), ConnectLimitError);
  await assert.rejects(engine.connectProject(root), ConnectLimitError);
  assert.equal(existsSync(join(root, '.ano', 'connect', 'current.json')), false);
});

test('derived search cache is excluded from the digest but inventoried; unknown DB is still archived', async (t) => {
  const root = await rootFor(t);
  await makeFixture(root, {
    extra: {
      'index.db': Buffer.from('sqlite-index-cache'),
      'index.db-wal': Buffer.from('wal'),
      'index.db-shm': Buffer.from('shm'),
      'other/unknown.db': Buffer.from('unknown db'),
    },
  });

  const plan = await planConnection(root);
  assert.deepEqual(plan.excluded.map((entry) => entry.path).sort(), ['index.db', 'index.db-shm', 'index.db-wal']);
  assert.ok(plan.excluded.every((entry) => entry.reason === 'derived-cache'));
  assert.equal(plan.counts.excluded, 3);
  assert.equal(plan.counts.excludedBytes, 18 + 3 + 3);
  assert.ok(plan.files.every((file) => !file.path.startsWith('index.db')), 'cache files are not archived');
  assert.ok(plan.files.some((file) => file.path === 'other/unknown.db'), 'unknown DB is still archived');
  assert.ok(plan.warnings.some((warning) => warning.includes('derived search cache')));

  const first = await connectProject(root);
  assert.equal(first.report.excluded.length, 3);
  assert.ok(first.report.warnings.some((warning) => warning.includes('derived search cache')));

  await writeFile(join(root, '.pm', 'index.db'), Buffer.from('changed cache contents'));
  await writeFile(join(root, '.pm', 'index.db-shm'), Buffer.from('changed shm'));
  const second = await connectProject(root);
  assert.equal(second.duplicate, true, 'cache-only changes must not create a new version');
  assert.equal(second.report.version, 1);

  const status = await connectionStatus(root);
  assert.equal(status.excluded.length, 3);
  assert.equal(status.tasks.length, 3);
  const exported = await exportConnection(root);
  assert.equal(exported.excluded.length, 3);
  assert.equal(exported.versions[0]?.excluded.length, 3);
  assert.ok(!exported.versions[0]?.files.some((file) => file.path.startsWith('index.db')));
  const unknown = exported.versions[0]?.files.find((file) => file.path === 'other/unknown.db');
  if (!unknown) throw new Error('unknown DB missing from export');
  assert.equal(Buffer.from(unknown.base64, 'base64').toString('utf8'), 'unknown db');
  assert.ok(exported.limitations.some((limit) => limit.includes('not a byte-for-byte backup')));
});

test('project rename keeps connectionId and derived task ids stable', async (t) => {
  const root = await rootFor(t);
  await makeFixture(root, { project: 'Old Project Name' });
  const first = await connectProject(root);
  const before = await connectionStatus(root);
  assert.equal(before.tasks.length, 3);

  await writeJson(join(root, '.pm', 'project.json'), { name: 'New Project Name', exposure: 'local' });
  const second = await connectProject(root);
  assert.equal(second.connectionId, first.connectionId, 'rename must not change the connection id');
  assert.equal(second.report.version, 2);

  const after = await connectionStatus(root);
  assert.equal(after.connections[0]?.connectionId, first.connectionId);
  assert.deepEqual(
    after.tasks.map((task) => task.id).sort(),
    before.tasks.map((task) => task.id).sort(),
    'rename must not change derived task ids',
  );
  assert.equal(after.identity?.project, 'new-project-name');
  assert.equal(after.identity?.projectKey, before.identity?.projectKey);
});

test('crash window between manifest and current pointer is recovered, and reverse drift fails closed', async (t) => {
  const root = await rootFor(t);
  await makeFixture(root, { tasks: [{ id: 'T-1', title: 'v1 title', status: 'todo' }] });
  await connectProject(root);
  const currentV1 = await readFile(join(root, CONNECT_DIR, 'current.json'), 'utf8');

  await writeJson(join(root, '.pm', 'tasks.json'), { seq: 2, tasks: [{ id: 'T-1', title: 'v2 title', status: 'todo' }] });
  await connectProject(root);
  assert.equal((await connectionStatus(root)).connections[0]?.currentVersion, 2);

  // Simulate a crash after the manifest commit but before the current pointer write.
  await writeFile(join(root, CONNECT_DIR, 'current.json'), currentV1);
  const recovered = await connectionStatus(root);
  assert.equal(recovered.connections[0]?.currentVersion, 2);
  assert.equal(recovered.tasks.find((task) => task.sourceId === 'T-1')?.title, 'v2 title');
  // Readers project the latest verified manifest but do not repair the pointer.
  const projectedCurrent = JSON.parse(await readFile(join(root, CONNECT_DIR, 'current.json'), 'utf8')) as { version: number };
  assert.equal(projectedCurrent.version, 1);
  // The connect path performs the real repair under its lock.
  const duplicate = await connectProject(root);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.report.version, 2);
  const repaired = JSON.parse(await readFile(join(root, CONNECT_DIR, 'current.json'), 'utf8')) as { version: number };
  assert.equal(repaired.version, 2);

  // A current pointer that references an unknown digest is genuine corruption.
  const manifest = JSON.parse(await readFile(join(root, CONNECT_DIR, 'current.json'), 'utf8')) as { connectionId: string };
  await writeJson(join(root, CONNECT_DIR, 'current.json'), {
    schema: 'ano.connect-current/1',
    connectionId: manifest.connectionId,
    sourceDigest: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    version: 99,
    snapshotPath: '.ano/connect/snapshots/missing.json',
    snapshotHash: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    updatedAt: new Date().toISOString(),
  });
  await assert.rejects(connectionStatus(root), ConnectStoreError);
});

test('A->B->A source rollback reuses the immutable snapshot and diffs v2->v3', async (t) => {
  const root = await rootFor(t);
  const aTasks = [{ id: 'T-1', title: 'A title', status: 'todo', detail: 'alpha' }];
  const bTasks = [{ id: 'T-1', title: 'B title', status: 'todo', detail: 'beta' }];
  await makeFixture(root, { tasks: aTasks });
  const a1 = await connectProject(root);

  await writeJson(join(root, '.pm', 'tasks.json'), { seq: 2, tasks: bTasks });
  const b = await connectProject(root);
  assert.equal(b.report.version, 2);

  await writeJson(join(root, '.pm', 'tasks.json'), { seq: 1, tasks: aTasks });
  const a2 = await connectProject(root);
  assert.equal(a2.report.version, 3);
  assert.equal(a2.duplicate, false);
  assert.equal(a2.sourceDigest, a1.sourceDigest, 'rollback returns to the exact A digest');
  assert.equal(a2.report.previousDigest, b.sourceDigest, 'v3 diffs against B');

  const exported = await exportConnection(root);
  assert.equal(exported.versions.length, 3);
  const v1 = exported.versions.find((version) => version.version === 1);
  const v3 = exported.versions.find((version) => version.version === 3);
  if (!v1 || !v3) throw new Error('missing versions');
  assert.equal(v3.snapshotPath, v1.snapshotPath, 'immutable content snapshot is reused');
  assert.equal(v3.changes.filter((change) => change.kind === 'updated').length, 1, 'v2->v3 diff is accurate');

  const status = await connectionStatus(root);
  assert.equal(status.connections[0]?.currentVersion, 3);
  assert.equal(status.tasks.find((task) => task.sourceId === 'T-1')?.title, 'A title');
});

test('fault hooks cover snapshot-written and manifest-written crash windows', async (t) => {
  const snapshotRoot = await rootFor(t);
  await makeFixture(snapshotRoot, { tasks: [{ id: 'T-1', title: 'one', status: 'todo' }] });
  let snapshotAttempts = 0;
  const snapshotEngine = createConnectEngine({
    hooks: {
      afterSnapshotWritten: async () => {
        snapshotAttempts += 1;
        if (snapshotAttempts === 1) throw new Error('injected snapshot crash');
      },
    },
  });
  await assert.rejects(snapshotEngine.connectProject(snapshotRoot), /injected snapshot crash/);
  const snapshotRetry = await createConnectEngine({}).connectProject(snapshotRoot);
  assert.equal(snapshotRetry.report.connected, true);
  assert.equal(snapshotRetry.report.resumedFromCheckpoint, true);
  assert.equal((await connectionStatus(snapshotRoot)).tasks.length, 1);

  const currentRoot = await rootFor(t);
  await makeFixture(currentRoot, { tasks: [{ id: 'T-1', title: 'one', status: 'todo' }] });
  let currentAttempts = 0;
  const currentEngine = createConnectEngine({
    hooks: {
      afterManifestWritten: async () => {
        currentAttempts += 1;
        if (currentAttempts === 1) throw new Error('injected current crash');
      },
    },
  });
  await assert.rejects(currentEngine.connectProject(currentRoot), /injected current crash/);
  const projected = await connectionStatus(currentRoot);
  assert.equal(projected.connected, true);
  assert.equal(projected.connections[0]?.currentVersion, 1);
  assert.equal(existsSync(join(currentRoot, CONNECT_DIR, 'current.json')), false, 'reader must not repair');
  const currentRetry = await createConnectEngine({}).connectProject(currentRoot);
  assert.equal(currentRetry.duplicate, true);
  assert.equal(existsSync(join(currentRoot, CONNECT_DIR, 'current.json')), true, 'connect repairs under lock');

  // Snapshot bytes are on disk but the checkpoint does not reference them yet.
  const beforeCheckpointRoot = await rootFor(t);
  await makeFixture(beforeCheckpointRoot, { tasks: [{ id: 'T-1', title: 'one', status: 'todo' }] });
  let beforeAttempts = 0;
  const beforeEngine = createConnectEngine({
    hooks: {
      beforeSnapshotCheckpoint: async () => {
        beforeAttempts += 1;
        if (beforeAttempts === 1) throw new Error('injected pre-checkpoint crash');
      },
    },
  });
  await assert.rejects(beforeEngine.connectProject(beforeCheckpointRoot), /injected pre-checkpoint crash/);
  const beforeRetry = await createConnectEngine({}).connectProject(beforeCheckpointRoot);
  assert.equal(beforeRetry.report.connected, true);
  assert.equal(beforeRetry.report.resumedFromCheckpoint, true);
  assert.equal((await connectionStatus(beforeCheckpointRoot)).tasks.length, 1);
});

test('concurrent readers observe only committed states while writers serialize', async (t) => {
  const root = await rootFor(t);
  await makeFixture(root, { tasks: [{ id: 'T-1', title: 'v1', status: 'todo' }] });
  await connectProject(root);
  await writeJson(join(root, '.pm', 'tasks.json'), { seq: 2, tasks: [{ id: 'T-1', title: 'v2', status: 'todo' }] });

  const writerPromises = [connectProject(root), connectProject(root), createConnectEngine({}).connectProject(root)];
  const statusPromises = Array.from({ length: 6 }, () => connectionStatus(root));
  const recallPromises = Array.from({ length: 4 }, () => recallConnected(root, { limit: 5 }));
  const [writeResults, statusResults, recallResults] = await Promise.all([
    Promise.all(writerPromises),
    Promise.all(statusPromises),
    Promise.all(recallPromises),
  ]);

  for (const result of writeResults) {
    assert.equal(result.report.connected, true);
    assert.equal(result.report.version, 2);
  }
  for (const status of statusResults) {
    assert.equal(status.connected, true);
    assert.ok([1, 2].includes(status.connections[0]?.currentVersion ?? -1), 'reader saw a partial state');
  }
  for (const recall of recallResults) {
    assert.equal(recall.untrusted, true);
  }
  const final = await connectionStatus(root);
  assert.equal(final.connections[0]?.currentVersion, 2);
  assert.equal(final.tasks.find((task) => task.sourceId === 'T-1')?.title, 'v2');
});

test('recall, export and status verify every historical version hash and fail closed', async (t) => {
  const root = await rootFor(t);
  await makeFixture(root, { tasks: [{ id: 'T-1', title: 'one', status: 'todo' }] });
  await connectProject(root);
  await writeJson(join(root, '.pm', 'tasks.json'), { seq: 2, tasks: [{ id: 'T-1', title: 'two', status: 'todo' }] });
  await connectProject(root);

  const exported = await exportConnection(root);
  const v1 = exported.versions.find((version) => version.version === 1);
  if (!v1) throw new Error('v1 missing');
  const snapshotPath = join(root, v1.snapshotPath);
  const raw = JSON.parse(await readFile(snapshotPath, 'utf8')) as { records: unknown[] };
  raw.records = [];
  await writeFile(snapshotPath, JSON.stringify(raw, null, 2));

  await assert.rejects(connectionStatus(root), ConnectTamperError);
  await assert.rejects(recallConnected(root, { query: 'one' }), ConnectTamperError);
  await assert.rejects(exportConnection(root), ConnectTamperError);
});

test('symlink hardening refuses source file, blob, parent directory and store root links', async (t) => {
  const outside = await rootFor(t, 'ano-connect-outside-');
  await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8');

  const sourceLink = await rootFor(t);
  await makeFixture(sourceLink);
  await symlink(join(outside, 'secret.txt'), join(sourceLink, '.pm', 'linked.txt'), 'file');
  await assert.rejects(planConnection(sourceLink), /symbolic link|junction/i);

  const blobRoot = await rootFor(t);
  await makeFixture(blobRoot);
  await connectProject(blobRoot);
  const exported = await exportConnection(blobRoot);
  const entry = exported.versions[0]?.files.find((file) => file.path === 'tasks.json');
  if (!entry) throw new Error('tasks.json missing');
  const blobPath = join(blobRoot, CONNECT_DIR, 'blobs', entry.hash);
  await rm(blobPath, { force: true });
  await symlink(join(outside, 'secret.txt'), blobPath, 'file');
  await assert.rejects(connectionStatus(blobRoot), ConnectStoreError);

  const parentRoot = await rootFor(t);
  await makeFixture(parentRoot);
  await connectProject(parentRoot);
  const blobsDir = join(parentRoot, CONNECT_DIR, 'blobs');
  await rm(blobsDir, { recursive: true, force: true });
  await symlink(outside, blobsDir, 'junction');
  await assert.rejects(connectionStatus(parentRoot), ConnectStoreError);

  const storeRoot = await rootFor(t);
  await makeFixture(storeRoot);
  await mkdir(join(storeRoot, '.ano'), { recursive: true });
  await symlink(outside, join(storeRoot, '.ano', 'connect'), 'junction');
  await assert.rejects(connectProject(storeRoot), ConnectStoreError);
  assert.deepEqual(await readdir(outside), ['secret.txt'], 'refused to create through a linked store root');
});

test('handoff is blocked with explicit evidence gaps until migration/backup/cutover', async (t) => {
  const root = await rootFor(t);
  const before = await handoffReadiness(root);
  assert.equal(before.ready, false);
  assert.ok(before.blockers.length > 0);
  assert.equal(before.connectionId, undefined);

  await makeFixture(root);
  await connectProject(root);
  const after = await handoffReadiness(root);
  assert.equal(after.ready, false);
  assert.ok(after.blockers.some((blocker) => /not migrated|migrate/.test(blocker)));
  assert.ok(after.blockers.some((blocker) => /backup/.test(blocker)));
  assert.ok(after.blockers.some((blocker) => /cutover confirmation/.test(blocker)));
  assert.equal(after.connectionId?.startsWith('CN-'), true);
});
