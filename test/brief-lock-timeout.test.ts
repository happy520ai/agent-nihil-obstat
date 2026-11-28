import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { brief, briefCompact } from '../src/surface/service.ts';
import { BRIEF_COMPACT_MIN_BUDGET, compactBrief } from '../src/memory/brief-compact.ts';
import { Ledger } from '../src/ledger/ledger.ts';

async function projectFor(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ano-brief-lock-timeout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  const init = spawnSync('git', ['init', '-q', root], { windowsHide: true });
  assert.equal(init.status, 0);
  const ledger = await Ledger.open(root, { sessionId: 'SEED' });
  try { await ledger.createTask('T-KEEP', ['src/a.ts'], 'resume this task'); }
  finally { ledger.close(); }
  return root;
}

function lockViews(root: string): { path: string; owner: string } {
  const path = join(root, '.ano', 'cache', '.views.lock');
  const owner = JSON.stringify({ token: 'held-for-test', pid: process.pid, startedAt: Date.now() - 60_000 });
  writeFileSync(path, owner);
  return { path, owner };
}

function segments(root: string): Record<string, string> {
  const directory = join(root, '.ano', 'ledger');
  return Object.fromEntries(readdirSync(directory).filter(name => name.endsWith('.jsonl')).sort()
    .map(name => [name, readFileSync(join(directory, name), 'utf8')]));
}

for (const compact of [false, true]) {
  test(`${compact ? 'briefCompact' : 'brief'} reports unavailable task recovery on lock timeout`, async t => {
    const root = await projectFor(t);
    const held = lockViews(root);
    const before = segments(root);
    const result = compact
      ? await briefCompact(root, { lockTimeoutMs: 30 })
      : await brief(root, { include_memory_context: true }, { lockTimeoutMs: 30 });
    assert.equal(result.tasks, null);
    assert.deepEqual(result.task_recovery, { available: false, reason: 'LOCK_TIMEOUT' });
    const degraded = result.degraded as { code: string; message: string; lock: { owner: { pid: number; alive: boolean } } };
    assert.equal(degraded.code, 'LOCK_TIMEOUT');
    assert.match(degraded.message, /Timed out acquiring lock/);
    assert.equal(degraded.lock.owner.pid, process.pid);
    assert.equal(degraded.lock.owner.alive, true);
    assert.ok(Array.isArray(result.limitations));
    assert.ok(Array.from(JSON.stringify(result)).length <= 6000);
    assert.equal(result.memory, null);
    assert.equal(result.last_sessions, null);
    if (!compact) assert.deepEqual(result.memory_context, { available: false, reason: 'LOCK_TIMEOUT' });
    assert.equal(existsSync(join(root, '.ano', 'memory', 'probes')), false, 'degraded reads cannot freeze probe manifests');
    assert.deepEqual(segments(root), before);
    assert.equal(readFileSync(held.path, 'utf8'), held.owner);
    unlinkSync(held.path);
    const recovered = await brief(root);
    assert.ok((recovered.tasks as Array<{ id: string }>).some(task => task.id === 'T-KEEP'));
    assert.equal(recovered.task_recovery, undefined, 'healthy brief retains its legacy shape');
    assert.equal(recovered.degraded, undefined);
  });
}

test('compact truncation never invents empty tasks or empty session checks when recovery is unavailable', () => {
  const full = {
    tasks: null,
    task_recovery: { available: false, reason: 'LOCK_TIMEOUT' },
    memory: null, last_sessions: null,
    degraded: { code: 'LOCK_TIMEOUT', message: 'x'.repeat(500) },
    limitations: ['retry after owner release'],
  };
  for (const budget of [BRIEF_COMPACT_MIN_BUDGET, 80, 120, 300, 6000]) {
    const result = compactBrief(full, budget);
    assert.equal(result.tasks, null);
    assert.ok(Array.from(JSON.stringify(result)).length <= budget);
    assert.ok(result.last_sessions === undefined || result.last_sessions === null);
    assert.deepEqual(result.task_recovery, full.task_recovery);
  }
});

test('brief does not disguise unrelated acquisition failures as recovery degradation', async t => {
  const root = await projectFor(t);
  await assert.rejects(brief(root, {}, { lockTimeoutMs: -1 }), RangeError);
  writeFileSync(join(root, '.ano', 'cache', 'views.db'), 'not a sqlite database');
  await assert.rejects(brief(root, {}, { lockTimeoutMs: 30 }), (error: unknown) => {
    assert.notEqual((error as { code?: string }).code, 'LOCK_TIMEOUT');
    return true;
  });
});
