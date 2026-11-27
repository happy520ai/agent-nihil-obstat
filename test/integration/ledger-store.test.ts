import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { scanSegment } from '../../src/ledger/append.ts';
import { eventChain } from '../../src/ledger/event.ts';
import { IdempotencyConflictError, Ledger } from '../../src/ledger/ledger.ts';
import { completeTaskViaGate } from '../helpers/gate-complete.ts';

async function rootFor(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ano-ledger-integration-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function segmentNames(root: string): Promise<string[]> {
  const names = await readdir(join(root, '.ano', 'ledger')).catch(() => [] as string[]);
  return names.filter((name) => name.endsWith('.jsonl')).sort();
}

test('idempotency is shared across segments and lazy on the second session', async (t) => {
  const root = await rootFor(t);
  const first = await Ledger.open(root, { sessionId: 'A', clock: () => 1000 });
  const created = await first.append({ kind: 'task.created', payload: { task_id: 'SHARED', declared_files: ['a.ts'] } }, 'shared-key');
  first.close();

  const second = await Ledger.open(root, { sessionId: 'B', clock: () => 2000 });
  const duplicate = await second.append({ kind: 'task.created', payload: { task_id: 'SHARED', declared_files: ['a.ts'] } }, 'shared-key');
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(duplicate.event, created.event);
  assert.equal((await segmentNames(root)).filter((name) => name.endsWith('-B.jsonl')).length, 0);

  await assert.rejects(
    second.append({ kind: 'task.created', payload: { task_id: 'SHARED', declared_files: ['b.ts'] } }, 'shared-key'),
    IdempotencyConflictError,
  );
  assert.equal((await segmentNames(root)).filter((name) => name.endsWith('-B.jsonl')).length, 0);

  await second.append({ kind: 'task.created', payload: { task_id: 'B-ONLY', declared_files: ['b.ts'] } }, 'b-key');
  assert.equal((await segmentNames(root)).filter((name) => name.endsWith('-B.jsonl')).length, 1);
  second.close();

  const third = await Ledger.open(root, { sessionId: 'C', clock: () => 3000 });
  assert.equal(third.getTask('SHARED')?.id, 'SHARED');
  assert.equal(third.getTask('B-ONLY')?.id, 'B-ONLY');
  third.close();
});

test('replay across segments keeps task and evidence views consistent', async (t) => {
  const root = await rootFor(t);
  const first = await Ledger.open(root, { sessionId: 'A', clock: () => 1000 });
  await first.createTask('T1', ['src/a.ts'], 'Task');
  await first.append({
    kind: 'evidence.recorded',
    payload: { task_id: 'T1', evidence: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ok: true }, test_files: ['test/a.test.ts'] },
  }, 'ev-a');
  first.close();

  const second = await Ledger.open(root, { sessionId: 'B', clock: () => 2000 });
  await second.updateTask('T1', { status: 'in_progress' });
  await completeTaskViaGate(root, second, 'T1', { evidenceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', idemKey: 'ev-d' });
  await second.append({
    kind: 'evidence.recorded',
    payload: { task_id: 'T1', evidence: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', ok: true }, test_files: ['test/b.test.ts'] },
  }, 'ev-b');
  second.close();

  const third = await Ledger.open(root, { sessionId: 'C', clock: () => 3000 });
  assert.equal(third.getTask('T1')?.status, 'done');
  assert.equal(third.listEvidence('T1').length, 3);

  for (const name of await segmentNames(root)) {
    const scanned = scanSegment(await readFile(join(root, '.ano', 'ledger', name)));
    assert.equal(scanned.ignoredTail, false, name);
    assert.equal(eventChain(scanned.events), true, name);
  }

  const db = new DatabaseSync(join(root, '.ano', 'cache', 'views.db'));
  try {
    const tasks = db.prepare('SELECT id, status FROM tasks ORDER BY id').all() as Record<string, unknown>[];
    assert.deepEqual(tasks.map((row) => ({ id: String(row.id), status: String(row.status) })), [{ id: 'T1', status: 'done' }]);
    const evidence = db.prepare('SELECT id, task_id FROM evidence ORDER BY id').all() as Record<string, unknown>[];
    assert.equal(evidence.length, 3);
    for (const row of evidence) assert.equal(String(row.task_id), 'T1');
    const idempotency = db.prepare('SELECT idem_key FROM idempotency ORDER BY idem_key').all() as Record<string, unknown>[];
    assert.deepEqual(idempotency.map((row) => String(row.idem_key)), ['ano:task.create:v1:T1', 'ev-a', 'ev-b', 'ev-d']);
  } finally {
    db.close();
  }
  third.close();
});

test('two live sessions append without losing events', async (t) => {
  const root = await rootFor(t);
  const first = await Ledger.open(root, { sessionId: 'A', clock: () => 1000 });
  const second = await Ledger.open(root, { sessionId: 'B', clock: () => 1001 });

  await Promise.all([
    first.append({ kind: 'task.created', payload: { task_id: 'A1', declared_files: ['a.ts'] } }, 'a-key'),
    second.append({ kind: 'task.created', payload: { task_id: 'B1', declared_files: ['b.ts'] } }, 'b-key'),
  ]);
  first.close();
  second.close();

  assert.equal((await segmentNames(root)).length, 2);
  const reopened = await Ledger.open(root, { sessionId: 'C', clock: () => 2000 });
  assert.deepEqual(reopened.getTasks().map((task) => task.id).sort(), ['A1', 'B1']);
  reopened.close();
});

test('getTouchedFiles derives changed and untracked files, excluding the ledger cache', async (t) => {
  if (spawnSync('git', ['--version']).status !== 0) {
    t.skip('git is not available');
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'ano-ledger-git-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const git = (args: string[]) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(git(['init', '-q']).status, 0);
  for (const args of [['config', 'user.email', 'test@localhost'], ['config', 'user.name', 'ANO Test'], ['config', 'core.autocrlf', 'false']]) {
    assert.equal(git(args).status, 0);
  }
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  assert.equal(git(['add', 'src/a.ts']).status, 0);
  assert.equal(git(['commit', '-qm', 'baseline']).status, 0);
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 2;\n');
  await writeFile(join(root, 'src', 'new file.ts'), 'export const b = 1;\n');

  const ledger = await Ledger.open(root, { sessionId: 'GIT' });
  assert.deepEqual(ledger.getTouchedFiles(), ['src/a.ts', 'src/new file.ts']);
  await ledger.append({ kind: 'task.created', payload: { task_id: 'T1', declared_files: ['src/a.ts'] } }, 'k');
  assert.deepEqual(ledger.getTouchedFiles(), ['src/a.ts', 'src/new file.ts']);
  ledger.close();
});
