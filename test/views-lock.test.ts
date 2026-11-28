import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { FileLockTimeoutError, withFileLock, withFileLockSync } from '../src/core/lock.ts';

async function pathFor(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ano-lock-diagnostic-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, 'mutex');
}

for (const mode of ['sync', 'async'] as const) {
  test(`${mode} timeout reports the live owner without exposing its token or changing its lease`, async (t) => {
    const path = await pathFor(t);
    const owner = JSON.stringify({ token: 'private-owner-token', pid: process.pid, startedAt: Date.now() - 120_000 });
    writeFileSync(path, owner);
    let calls = 0;
    const check = (error: unknown): boolean => {
      assert.ok(error instanceof FileLockTimeoutError);
      assert.equal(error.code, 'LOCK_TIMEOUT');
      assert.equal(error.path, path);
      assert.equal(error.timeoutMs, 25);
      assert.ok(error.waitedMs >= 25);
      assert.equal(error.owner.pid, process.pid);
      assert.equal(error.owner.alive, true);
      assert.equal(error.owner.metadata, 'readable');
      assert.ok(error.owner.ageMs! >= 120_000);
      assert.match(error.message, /Timed out acquiring lock/);
      assert.ok(!JSON.stringify(error).includes('private-owner-token'));
      assert.ok(!error.message.includes('private-owner-token'));
      return true;
    };
    if (mode === 'sync') assert.throws(() => withFileLockSync(path, () => { calls += 1; }, { timeoutMs: 25, staleAfterMs: 1 }), check);
    else await assert.rejects(withFileLock(path, async () => { calls += 1; }, { timeoutMs: 25, staleAfterMs: 1 }), check);
    assert.equal(calls, 0);
    assert.equal(readFileSync(path, 'utf8'), owner);
    assert.deepEqual(readdirSync(join(path, '..')), ['mutex']);
  });
}

test('async contenders yield until the active operation finishes and never overlap', async (t) => {
  const path = await pathFor(t);
  let inside = 0;
  let largest = 0;
  const results = await Promise.all(Array.from({ length: 5 }, (_, index) => withFileLock(path, async () => {
    inside += 1;
    largest = Math.max(largest, inside);
    await new Promise(resolve => setTimeout(resolve, 5));
    inside -= 1;
    return index;
  }, { timeoutMs: 2_000, staleAfterMs: 1 })));
  assert.equal(largest, 1);
  assert.deepEqual(results, [0, 1, 2, 3, 4]);
  assert.equal(existsSync(path), false);
});

test('fresh corrupt or scalar metadata remains unknown, not a dead owner to steal', async (t) => {
  for (const raw of ['{broken', 'null', '[]', '"untrusted"']) {
    const path = await pathFor(t);
    writeFileSync(path, raw);
    await assert.rejects(withFileLock(path, async () => assert.fail('must not enter'), { timeoutMs: 10 }), (error: unknown) => {
      assert.ok(error instanceof FileLockTimeoutError);
      assert.equal(error.owner.metadata, 'invalid');
      assert.equal(error.owner.alive, null);
      return true;
    });
    assert.equal(readFileSync(path, 'utf8'), raw);
  }
});

test('async acquisition retains stale dead-owner recovery and quarantines the old lease', async (t) => {
  const path = await pathFor(t);
  const child = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
  assert.equal(child.status, 0);
  assert.throws(() => process.kill(child.pid, 0));
  const owner = JSON.stringify({ token: 'old', pid: child.pid, startedAt: Date.now() - 120_000 });
  writeFileSync(path, owner);
  assert.equal(await withFileLock(path, async () => 'ok', { timeoutMs: 1_000, staleAfterMs: 1 }), 'ok');
  assert.equal(existsSync(path), false);
  const recovered = readdirSync(join(path, '..')).filter(name => name.endsWith('.reclaimed'));
  assert.equal(recovered.length, 1);
  assert.equal(readFileSync(join(path, '..', recovered[0]!), 'utf8'), owner);
});

test('async operation errors are not contention and changed ownership is never deleted', async (t) => {
  const path = await pathFor(t);
  const error = Object.assign(new Error('operation failed'), { code: 'EEXIST' });
  let calls = 0;
  await assert.rejects(withFileLock(path, async () => { calls += 1; throw error; }), candidate => candidate === error);
  assert.equal(calls, 1);
  assert.equal(existsSync(path), false);
  const foreign = JSON.stringify({ token: 'replacement', pid: process.pid, startedAt: Date.now() });
  await withFileLock(path, async () => { writeFileSync(path, foreign); });
  assert.equal(readFileSync(path, 'utf8'), foreign);
});

test('invalid wait durations fail before creating a lock', async (t) => {
  const path = await pathFor(t);
  for (const timeoutMs of [NaN, Infinity, -1]) {
    assert.throws(() => withFileLockSync(path, () => undefined, { timeoutMs }), RangeError);
    await assert.rejects(withFileLock(path, async () => undefined, { timeoutMs }), RangeError);
  }
  assert.equal(existsSync(path), false);
});
