import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { scanSegment } from '../../src/ledger/append.ts';
import { eventChain, genesisHash } from '../../src/ledger/event.ts';
import { Ledger, IdempotencyConflictError } from '../../src/ledger/ledger.ts';
import { parseSegment } from '../../src/ledger/segment.ts';
import { completeTaskViaGate } from '../helpers/gate-complete.ts';

async function rootFor(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ano-ledger-unit-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function segmentNames(root: string): Promise<string[]> {
  const names = await readdir(join(root, '.ano', 'ledger')).catch(() => [] as string[]);
  return names.filter((name) => name.endsWith('.jsonl')).sort();
}

function segmentPath(root: string, name: string): string {
  return join(root, '.ano', 'ledger', name);
}

test('open is lazy; first append writes a legacy header and one checksum batch', async (t) => {
  const root = await rootFor(t);
  const ledger = await Ledger.open(root, { sessionId: 'S1', actor: 'A', clock: () => 1000 });
  assert.deepEqual(await segmentNames(root), []);

  const result = await ledger.createTask('T1', ['src/a.ts'], 'First task');
  assert.equal(result.duplicate, false);
  assert.equal(result.task.status, 'todo');

  const files = await segmentNames(root);
  assert.equal(files.length, 1);
  assert.match(files[0]!, /-S1\.jsonl$/);
  const bytes = await readFile(segmentPath(root, files[0]!));
  const lines = bytes.toString('utf8').trimEnd().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(lines[0]?.kind, 'segment.started');
  assert.equal(lines[0]?.prev_hash, genesisHash);
  assert.equal(lines[1]?.record, 'batch.begin');
  assert.equal(lines[2]?.kind, 'task.created');
  assert.equal(lines[3]?.record, 'batch.end');

  const parsed = parseSegment(bytes);
  assert.equal(parsed.events.length, 2);
  assert.equal(parsed.ignoredTail, false);
  assert.equal(eventChain(parsed.events), true);
  ledger.close();
});

test('same idempotency key and canonical parameters has no second side effect', async (t) => {
  const root = await rootFor(t);
  const ledger = await Ledger.open(root, { sessionId: 'S', clock: () => 2000 });
  const first = await ledger.append({ kind: 'task.created', payload: { task_id: 'T1', declared_files: ['src/a.ts'] } }, 'k1');
  const second = await ledger.append({ kind: 'task.created', payload: { declared_files: ['src/a.ts'], task_id: 'T1' } }, 'k1');
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.deepEqual(second.event, first.event);

  const [file] = await segmentNames(root);
  const scanned = scanSegment(await readFile(segmentPath(root, file!)));
  assert.equal(scanned.events.filter((event) => event.kind === 'task.created').length, 1);
  assert.equal(ledger.getTask('T1')?.status, 'todo');
  ledger.close();
});

test('same key with different canonical parameters is rejected without appending', async (t) => {
  const root = await rootFor(t);
  const ledger = await Ledger.open(root, { sessionId: 'S', clock: () => 3000 });
  await ledger.append({ kind: 'task.created', payload: { task_id: 'T1', declared_files: ['a.ts'] } }, 'k');
  const [file] = await segmentNames(root);
  const before = await readFile(segmentPath(root, file!));

  await assert.rejects(
    ledger.append({ kind: 'task.created', payload: { task_id: 'T1', declared_files: ['b.ts'] } }, 'k'),
    IdempotencyConflictError,
  );
  await assert.rejects(
    ledger.append({ kind: 'task.updated', payload: { task_id: 'T1', status: 'in_progress' } }, 'k'),
    IdempotencyConflictError,
  );

  assert.deepEqual(await readFile(segmentPath(root, file!)), before);
  assert.equal(ledger.getTask('T1')?.status, 'todo');
  ledger.close();
});

test('task CRUD and evidence reads materialize from the log', async (t) => {
  const root = await rootFor(t);
  const ledger = await Ledger.open(root, { sessionId: 'CRUD', clock: () => 4000 });
  const created = await ledger.createTask('T1', ['src/a.ts', 'src/b.ts'], 'Task one');
  assert.equal(created.task.status, 'todo');
  assert.deepEqual(created.task.declaredFiles, ['src/a.ts', 'src/b.ts']);
  assert.equal(created.task.title, 'Task one');

  assert.equal((await ledger.updateTask('T1', { status: 'in_progress' })).status, 'in_progress');
  await completeTaskViaGate(root, ledger, 'T1');
  assert.equal(ledger.getTask('T1')?.status, 'done');

  const evidence = { id: '11111111-1111-4111-8111-111111111111', ok: true, counts: { tests: 2, pass: 2 } };
  const recorded = await ledger.append({
    kind: 'evidence.recorded',
    payload: { task_id: 'T1', evidence, test_files: ['test/a.test.ts'] },
  }, 'ev-1');
  assert.equal(recorded.duplicate, false);

  const read = ledger.getEvidence(evidence.id);
  assert.equal(read?.taskId, 'T1');
  assert.deepEqual(read?.testFiles, ['test/a.test.ts']);
  assert.deepEqual(read?.evidence, evidence);
  assert.equal(ledger.listEvidence('T1').length, 2);
  assert.equal(ledger.listEvidence('missing').length, 0);
  assert.deepEqual(ledger.getTasks().map((task) => task.id), ['T1']);
  assert.equal(ledger.getTask('missing'), undefined);
  ledger.close();
});

test('reopening the same session appends to one segment instead of creating another', async (t) => {
  const root = await rootFor(t);
  const first = await Ledger.open(root, { sessionId: 'SAME', clock: () => 5000 });
  await first.append({ kind: 'task.created', payload: { task_id: 'T1', declared_files: ['a.ts'] } }, 'a');
  first.close();

  const second = await Ledger.open(root, { sessionId: 'SAME', clock: () => 6000 });
  await completeTaskViaGate(root, second, 'T1', { idemKey: 'same-ev', updateIdemKey: 'b' });
  second.close();

  const files = (await segmentNames(root)).filter((name) => name.endsWith('-SAME.jsonl'));
  assert.equal(files.length, 1);
  const scanned = scanSegment(await readFile(segmentPath(root, files[0]!)));
  assert.equal(scanned.events.filter((event) => event.kind === 'segment.started').length, 1);
  assert.equal(scanned.events.filter((event) => event.kind === 'task.created').length, 1);
  assert.equal(scanned.events.filter((event) => event.kind === 'task.updated').length, 1);
  assert.equal(eventChain(scanned.events), true);
});

test('views.db is a rebuildable cache for tasks and evidence', async (t) => {
  const root = await rootFor(t);
  const ledger = await Ledger.open(root, { sessionId: 'REBUILD', clock: () => 7000 });
  await ledger.createTask('T1', ['src/a.ts'], 'Rebuild');
  await completeTaskViaGate(root, ledger, 'T1');
  const evidence = { id: '22222222-2222-4222-8222-222222222222', ok: true };
  await ledger.append({ kind: 'evidence.recorded', payload: { task_id: 'T1', evidence, test_files: ['test/a.test.ts'] } }, 'e');
  const beforeTask = ledger.getTask('T1');
  const beforeEvidence = ledger.listEvidence('T1');
  ledger.close();

  const viewsPath = join(root, '.ano', 'cache', 'views.db');
  assert.equal(existsSync(viewsPath), true);
  await rm(join(root, '.ano', 'cache'), { recursive: true, force: true });

  const reopened = await Ledger.open(root, { sessionId: 'REBUILD', clock: () => 8000 });
  assert.deepEqual(reopened.getTask('T1'), beforeTask);
  assert.deepEqual(reopened.listEvidence('T1'), beforeEvidence);
  assert.equal(existsSync(viewsPath), true);
  reopened.close();
});

test('only the owner segment tail is truncated', async (t) => {
  const root = await rootFor(t);
  const ledger = await Ledger.open(root, { sessionId: 'OWN', clock: () => 9000 });
  await ledger.append({ kind: 'task.created', payload: { task_id: 'T1', declared_files: ['a.ts'] } }, 'k');
  ledger.close();

  const [file] = await segmentNames(root);
  const path = segmentPath(root, file!);
  const valid = await readFile(path);
  const tail = Buffer.from('{"record":"batch.begin","batch_id":"partial","event_count":1}\n{"id":"');
  await writeFile(path, Buffer.concat([valid, tail]));

  const reopened = await Ledger.open(root, { sessionId: 'OWN', clock: () => 10000 });
  assert.deepEqual(await readFile(path), valid);
  assert.equal(reopened.getTask('T1')?.status, 'todo');

  await reopened.append({ kind: 'task.updated', payload: { task_id: 'T1', status: 'in_progress' } }, 'u');
  const after = scanSegment(await readFile(path));
  assert.equal(after.ignoredTail, false);
  assert.equal(eventChain(after.events), true);
  reopened.close();
});

test('a foreign segment tail is ignored without changing its bytes', async (t) => {
  const root = await rootFor(t);
  const other = await Ledger.open(root, { sessionId: 'OTHER', clock: () => 11000 });
  await other.append({ kind: 'task.created', payload: { task_id: 'OTHER', declared_files: ['other.ts'] } }, 'o');
  other.close();

  const otherFile = (await segmentNames(root)).find((name) => name.endsWith('-OTHER.jsonl'));
  assert.ok(otherFile);
  const otherPath = segmentPath(root, otherFile);
  const valid = await readFile(otherPath);
  const tail = Buffer.from('{"record":"batch.begin","batch_id":"foreign-tail","event_count":2}\n');
  await writeFile(otherPath, Buffer.concat([valid, tail]));
  const before = await readFile(otherPath);

  const mine = await Ledger.open(root, { sessionId: 'MINE', clock: () => 12000 });
  assert.deepEqual(await readFile(otherPath), before);
  assert.equal(mine.getTask('OTHER')?.id, 'OTHER');

  await mine.append({ kind: 'task.created', payload: { task_id: 'MINE', declared_files: ['mine.ts'] } }, 'm');
  assert.deepEqual(await readFile(otherPath), before);
  mine.close();
});

test('a broken hash chain in committed data is rejected on open', async (t) => {
  const root = await rootFor(t);
  const ledger = await Ledger.open(root, { sessionId: 'BROKEN', clock: () => 13000 });
  await ledger.append({ kind: 'task.created', payload: { task_id: 'T1', declared_files: ['a.ts'] } }, 'k1');
  await completeTaskViaGate(root, ledger, 'T1', { idemKey: 'ev-chain', updateIdemKey: 'k2' });
  ledger.close();

  const [file] = await segmentNames(root);
  const path = segmentPath(root, file!);
  const lines = (await readFile(path, 'utf8')).trimEnd().split('\n');
  const header = JSON.parse(lines[0]!) as Record<string, unknown>;
  header.payload = { ...(header.payload as Record<string, unknown>), started_at: 'tampered' };
  lines[0] = JSON.stringify(header);
  await writeFile(path, `${lines.join('\n')}\n`);

  await assert.rejects(Ledger.open(root, { sessionId: 'BROKEN' }), /Invalid hash chain/);
});

test('a complete batch with a bad checksum is rejected as corrupt committed data', async (t) => {
  const root = await rootFor(t);
  const ledger = await Ledger.open(root, { sessionId: 'CORRUPT', clock: () => 14000 });
  await ledger.append({ kind: 'task.created', payload: { task_id: 'T1', declared_files: ['a.ts'] } }, 'k');
  ledger.close();

  const [file] = await segmentNames(root);
  const path = segmentPath(root, file!);
  const lines = (await readFile(path, 'utf8')).trimEnd().split('\n');
  const eventLine = lines.findIndex((line) => line.includes('"kind":"task.created"'));
  assert.ok(eventLine >= 0);
  const event = JSON.parse(lines[eventLine]!) as Record<string, unknown>;
  event.payload = { task_id: 'T1', declared_files: ['tampered.ts'] };
  lines[eventLine] = JSON.stringify(event);
  await writeFile(path, `${lines.join('\n')}\n`);

  await assert.rejects(Ledger.open(root, { sessionId: 'CORRUPT' }), /checksum mismatch/);
});
