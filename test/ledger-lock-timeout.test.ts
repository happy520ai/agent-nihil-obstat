import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { withFileLock } from '../src/core/lock.ts';
import { Ledger } from '../src/ledger/ledger.ts';

async function rootFor(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ano-ledger-lock-wait-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function segments(root: string): Record<string, string> {
  const directory = join(root, '.ano', 'ledger');
  if (!existsSync(directory)) return {};
  return Object.fromEntries(readdirSync(directory).filter(name => name.endsWith('.jsonl')).sort()
    .map(name => [name, readFileSync(join(directory, name), 'utf8')]));
}

test('Ledger.open yields while a live views lock awaits its same-process release', async (t) => {
  const root = await rootFor(t);
  const seed = await Ledger.open(root, { sessionId: 'SEED' });
  await seed.createTask('T-RESUME', ['src/a.ts'], 'keep the breakpoint');
  seed.close();
  const before = segments(root);
  let release!: () => void;
  let entered!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const holder = withFileLock(join(root, '.ano', 'cache', '.views.lock'), async () => {
    entered();
    await released;
  });
  await ready;
  const timer = setTimeout(release, 30);
  try {
    const reopened = await Ledger.open(root, { sessionId: 'READER', lockTimeoutMs: 2_000 });
    try { assert.equal(reopened.getTask('T-RESUME')?.title, 'keep the breakpoint'); }
    finally { reopened.close(); }
    assert.deepEqual(segments(root), before, 'opening a reader never appends ledger events');
  } finally {
    clearTimeout(timer);
    release();
    await holder;
  }
});

test('a timed-out ledger append never executes and leaves the live owner and ledger intact', async (t) => {
  const root = await rootFor(t);
  const ledger = await Ledger.open(root, { sessionId: 'WRITER', lockTimeoutMs: 40 });
  try {
    await ledger.createTask('T-EXISTING', ['src/a.ts'], 'existing');
    const before = segments(root);
    const path = join(root, '.ano', 'cache', '.views.lock');
    mkdirSync(join(root, '.ano', 'cache'), { recursive: true });
    const owner = JSON.stringify({ token: 'foreign-owner', pid: process.pid, startedAt: 0 });
    writeFileSync(path, owner);
    await assert.rejects(ledger.createTask('T-NOT-COMMITTED', ['src/b.ts'], 'must not run'), (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, 'LOCK_TIMEOUT');
      assert.match((error as Error).message, /Timed out acquiring lock/);
      return true;
    });
    assert.deepEqual(segments(root), before);
    assert.equal(readFileSync(path, 'utf8'), owner);
    assert.equal(existsSync(join(root, '.ano', 'ledger', '.WRITER.lock')), false, 'the failed waiter releases only its own session lock');
  } finally { ledger.close(); }
});

test('concurrent same-session appends yield to the owner and each commit once', async (t) => {
  const root = await rootFor(t);
  const ledger = await Ledger.open(root, { sessionId: 'SHARED', lockTimeoutMs: 2_000 });
  try {
    await Promise.all(Array.from({ length: 6 }, (_, index) => ledger.createTask(`T-${index}`, ['src/a.ts'], `task ${index}`)));
    assert.equal(ledger.getTasks().length, 6);
    assert.deepEqual(new Set(ledger.getTasks().map(task => task.id)), new Set(Array.from({ length: 6 }, (_, index) => `T-${index}`)));
  } finally { ledger.close(); }
  const reopened = await Ledger.open(root, { sessionId: 'VERIFY' });
  try { assert.equal(reopened.getTasks().length, 6, 'replay agrees with all completed appends'); }
  finally { reopened.close(); }
});
