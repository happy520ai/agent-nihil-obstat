import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { scanSegment } from '../../src/ledger/append.ts';
import { eventChain, type LedgerEvent } from '../../src/ledger/event.ts';
import { Ledger } from '../../src/ledger/ledger.ts';
import { MIGRATION_KEY_PREFIX, MigrationError, migrateProject } from '../../src/ledger/migrate.ts';

const TASKS = {
  seq: 5,
  tasks: [
    { id: 'T-1', title: 'Alpha', status: 'done', files: ['src/b.ts', 'src/a.ts', 'src/a.ts'], result_note: 'done', acceptance: 'a', steps: [{ text: 's', done: true }] },
    { id: 'T-2', title: '   ', status: 'in_progress', files: [], result_note: '   ', verification: '  ' },
    { id: 'T-3', title: 'Blocked', status: 'blocked', files: ['src/c.ts'] },
    { id: 'T-4', title: 'Cancelled', status: 'cancelled' },
    { id: 'T-5', status: 'todo' },
  ],
};
const ROADMAP = { seq: 2, milestones: [{ id: 'M1', title: 'M1', status: 'done' }, { id: 'M2', title: 'M2', status: 'active' }] };
const FEATURES = { seq: 1, features: [{ id: 'F-1', name: 'Feature one' }] };

async function rootFor(t: TestContext, prefix: string, files: Record<string, unknown> | null = { tasks: TASKS, roadmap: ROADMAP, features: FEATURES }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (!files) return root;
  for (const [name, value] of Object.entries(files)) {
    const path = join(root, '.pm', `${name}.json`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  }
  return root;
}
async function write(root: string, path: string, source: string): Promise<void> {
  const target = join(root, ...path.split('/'));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, source);
}
function sha256(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
async function committedEvents(root: string): Promise<LedgerEvent[]> {
  const dir = join(root, '.ano', 'ledger');
  const names = (await readdir(dir).catch(() => [] as string[])).filter((name) => name.endsWith('.jsonl')).sort();
  const events: LedgerEvent[] = [];
  for (const name of names) {
    const scanned = scanSegment(await readFile(join(dir, name)));
    assert.equal(scanned.ignoredTail, false, `${name} must not have an uncommitted tail`);
    assert.equal(eventChain(scanned.events), true, `${name} must have a valid hash chain`);
    events.push(...scanned.events);
  }
  return events;
}
/** Content, size and mtime of every source file, so a write is provable. */
async function pmSnapshot(root: string): Promise<string> {
  const dir = join(root, '.pm');
  const names = (await readdir(dir, { recursive: true })) as string[];
  const entries: Array<Record<string, unknown>> = [];
  for (const name of names.sort()) {
    const path = join(dir, name);
    const info = await stat(path);
    if (!info.isFile()) continue;
    const bytes = await readFile(path);
    entries.push({ name: name.replaceAll('\\', '/'), sha256: sha256(bytes), bytes: bytes.length, mtimeMs: info.mtimeMs });
  }
  return JSON.stringify(entries);
}

test('migration maps tasks to ledger events, preserves statuses/files, and never writes .pm', async (t) => {
  const root = await rootFor(t, 'ano-p2-migrate-');
  const before = await pmSnapshot(root);
  const result = await migrateProject(root, { sessionId: 'MIG-1', actor: 'migrant' });
  assert.equal(result.sourceUnchanged, true);
  assert.equal(result.tasks.total, 5);
  assert.equal(result.tasks.created, 5);
  assert.equal(result.tasks.updated, 4, 'done, blocked, in_progress and cancelled need status events');
  assert.equal(result.tasks.skipped, 0);
  assert.equal(result.ledgerTasks, 5);
  assert.equal(result.milestones, 2);
  assert.equal(result.features, 1);
  assert.ok(result.eventsCommitted > 0);

  const after = await pmSnapshot(root);
  assert.equal(after, before, 'migration must not modify content, size or mtime of .pm sources');

  const reopened = await Ledger.open(root, { sessionId: 'MIG-READ' });
  try {
    assert.deepEqual(reopened.getTasks().map((task) => task.id), ['T-1', 'T-2', 'T-3', 'T-4', 'T-5']);
    assert.equal(reopened.getTask('T-1')?.status, 'in_progress', 'a legacy done is not a verified completion');
    assert.equal(reopened.getTask('T-1')?.originalStatus, 'done');
    assert.equal(reopened.getTask('T-1')?.verified, false);
    assert.match(String(reopened.getTask('T-1')?.migrationWarning), /Gate evidence/);
    assert.equal(reopened.getTask('T-1')?.title, 'Alpha');
    assert.deepEqual(reopened.getTask('T-1')?.declaredFiles, ['src/a.ts', 'src/b.ts'], 'files are deduped and sorted');
    assert.equal(reopened.getTask('T-2')?.status, 'in_progress');
    assert.equal(reopened.getTask('T-2')?.title, undefined, 'empty titles are not migrated');
    assert.equal(reopened.getTask('T-3')?.status, 'todo', 'blocked maps to todo without inventing a status');
    assert.equal(reopened.getTask('T-3')?.originalStatus, 'blocked', 'the blocked origin stays readable');
    assert.match(String(reopened.getTask('T-3')?.migrationWarning), /original status/);
    assert.equal(reopened.getTask('T-4')?.status, 'cancelled');
    assert.equal(reopened.getTask('T-5')?.status, 'todo');
  } finally {
    reopened.close();
  }

  const events = await committedEvents(root);
  assert.equal(events.filter((event) => event.kind === 'task.created').length, 5);
  assert.equal(events.filter((event) => event.kind === 'task.updated').length, 4);
  assert.equal(events.filter((event) => event.kind === 'task.updated' && event.payload.status === 'done').length, 0, 'migration must never write a done transition');
  assert.equal(events.filter((event) => event.kind === 'segment.started').length, 1);
  const records = events.filter((event) => event.kind === 'migration.recorded');
  assert.equal(records.filter((event) => event.payload.entity === 'task').length, 5);
  assert.equal(records.filter((event) => event.payload.entity === 'milestone').length, 2);
  assert.equal(records.filter((event) => event.payload.entity === 'feature').length, 1);
  assert.equal(records.filter((event) => event.payload.entity === 'migration').length, 1);
  const taskTwo = records.find((event) => event.payload.entity === 'task' && event.payload.id === 'T-2');
  assert.ok(taskTwo);
  const data = taskTwo.payload.data as Record<string, unknown>;
  assert.equal('title' in data, false, 'empty title must be omitted from the record');
  assert.equal('result_note' in data, false, 'empty completion note must be omitted from the record');
  assert.equal('verification' in data, false, 'empty verification text must be omitted from the record');

  const idemKeys = events.filter((event) => event.idem_key).map((event) => event.idem_key!);
  assert.equal(new Set(idemKeys).size, idemKeys.length, 'no idempotency key may be committed twice');
  assert.ok(idemKeys.every((key) => key.startsWith(MIGRATION_KEY_PREFIX)));
});

test('a second migration appends zero events, in the same or a new session', async (t) => {
  const root = await rootFor(t, 'ano-p2-migrate-twice-');
  const first = await migrateProject(root, { sessionId: 'MIG-1' });
  const before = await committedEvents(root);
  const beforePm = await pmSnapshot(root);

  const second = await migrateProject(root, { sessionId: 'MIG-1' });
  assert.equal(second.tasks.total, first.tasks.total);
  assert.equal(second.tasks.created, 0);
  assert.equal(second.tasks.updated, 0);
  assert.equal(second.tasks.duplicate, first.tasks.total);
  assert.equal(second.apiWrites, 0, 'an unchanged re-run must not issue a new write');
  assert.equal(second.eventsCommitted, 0, 'an unchanged re-run must commit zero events');
  assert.equal(second.ledgerTasks, first.ledgerTasks);
  assert.equal(second.sourceUnchanged, true);
  assert.deepEqual(await committedEvents(root), before);

  const third = await migrateProject(root, { sessionId: 'MIG-2' });
  assert.equal(third.eventsCommitted, 0, 'a fresh session must not append a header or summary when nothing changed');
  assert.equal(third.apiWrites, 0);
  assert.deepEqual(await committedEvents(root), before);
  assert.equal(await pmSnapshot(root), beforePm);
});

test('changed sources add a history record instead of rewriting it (skip conflict mode)', async (t) => {
  const root = await rootFor(t, 'ano-p2-migrate-change-');
  const first = await migrateProject(root, { sessionId: 'MIG-1' });
  const beforeEvents = (await committedEvents(root)).length;

  const changed = JSON.parse(JSON.stringify(TASKS)) as { tasks: Array<Record<string, unknown>> };
  changed.tasks[0]!.title = 'Alpha v2';
  changed.tasks.push({ id: 'T-6', title: 'Added', status: 'todo', files: ['src\\win.ts'] });
  await writeFile(join(root, '.pm', 'tasks.json'), `${JSON.stringify(changed, null, 2)}\n`);
  const beforePm = await pmSnapshot(root);

  const third = await migrateProject(root, { sessionId: 'MIG-3', onConflict: 'skip' });
  assert.equal(third.tasks.total, 6);
  assert.equal(third.tasks.created, 1, 'the new task is created');
  assert.equal(third.tasks.skipped, 1, 'the changed task creation is reported, not silently overwritten');
  assert.equal(third.ledgerTasks, 6);
  assert.equal(third.sourceUnchanged, true);
  assert.ok(third.eventsCommitted > 0);

  const events = await committedEvents(root);
  assert.ok(events.length > beforeEvents);
  assert.equal(events.filter((event) => event.kind === 'task.created').length, first.tasks.total + 1, 'history keeps the original creation and adds the new task');
  const drift = events.find((event) => event.kind === 'migration.recorded' && event.payload.entity === 'task.drift' && event.payload.id === 'T-1');
  assert.ok(drift, 'the divergent task is recorded as drift');
  const taskRecords = events.filter((event) => event.kind === 'migration.recorded' && event.payload.entity === 'task' && event.payload.id === 'T-1');
  assert.equal(taskRecords.length, 2, 'both source versions of the record are preserved');
  const added = await Ledger.open(root, { sessionId: 'MIG-READ' });
  try {
    assert.deepEqual(added.getTask('T-6')?.declaredFiles, ['src/win.ts'], 'backslashes are normalized in declared files');
  } finally {
    added.close();
  }
  assert.equal(await pmSnapshot(root), beforePm, 'the changed source is still read-only');
});

test('malformed or duplicate-id sources fail before creating a ledger', async (t) => {
  const malformed = await rootFor(t, 'ano-p2-migrate-bad-', null);
  await write(malformed, '.pm/tasks.json', '{not valid json');
  await assert.rejects(migrateProject(malformed, { sessionId: 'BAD' }), MigrationError);
  assert.equal(existsSync(join(malformed, '.ano', 'ledger')), false, 'a malformed source must not create a ledger');

  const duplicate = await rootFor(t, 'ano-p2-migrate-dup-');
  const duplicated = { tasks: [{ id: 'T-1', status: 'todo' }, { id: 'T-1', status: 'done' }] };
  await writeFile(join(duplicate, '.pm', 'tasks.json'), `${JSON.stringify(duplicated, null, 2)}\n`);
  await assert.rejects(migrateProject(duplicate, { sessionId: 'DUPLICATE' }), /duplicate task id T-1/);
});

test('missing sources migrate to an explicit empty summary and remain idempotent', async (t) => {
  const root = await rootFor(t, 'ano-p2-migrate-empty-', null);
  const result = await migrateProject(root, { sessionId: 'EMPTY' });
  assert.equal(result.tasks.total, 0);
  assert.equal(result.tasks.created, 0);
  assert.equal(result.ledgerTasks, 0);
  assert.equal(result.sourceUnchanged, true);
  assert.equal(result.sources.every((source) => source.missing), true);
  const events = await committedEvents(root);
  assert.equal(events.filter((event) => event.kind === 'migration.recorded').length, 1, 'one explicit summary event');
  const again = await migrateProject(root, { sessionId: 'EMPTY' });
  assert.equal(again.eventsCommitted, 0);
  assert.equal(again.apiWrites, 0);
});
