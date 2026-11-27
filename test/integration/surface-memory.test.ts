import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Ledger } from '../../src/ledger/ledger.ts';
import { noteSurface, recallSurface, type NoteSurfaceInput } from '../../src/surface/memory.ts';

interface FixtureMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly ts: string;
  readonly files?: readonly string[];
  readonly symbols?: readonly string[];
}

interface FixtureUnit {
  readonly dir: string;
  readonly unitId: string;
  readonly sessionId: string;
  readonly visibility: 'visible' | 'inactive' | 'hidden';
  readonly messages: readonly FixtureMessage[];
}

const SYNTHETIC_DIR = ['.ano', 'memory', 'synthetic'] as const;

function git(root: string, args: string[]): void {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
}

async function gitProject(t: TestContext, prefix = 'ano-surface-memory-it-'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await writeFile(join(root, '.gitignore'), '.ano/\n');
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await mkdir(join(root, 'src', 'auth'), { recursive: true });
  await writeFile(join(root, 'src', 'auth', 'session.ts'), 'export function refreshToken() { return 1; }\n');
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'ano@localhost'], ['config', 'user.name', 'ano'], ['add', '.'], ['commit', '-qm', 'base']]) git(root, args);
  return root;
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
}

async function writeUnit(root: string, provider: string, unit: FixtureUnit): Promise<void> {
  const unitDir = join(root, ...SYNTHETIC_DIR, provider, unit.dir);
  await write(join(unitDir, 'unit.json'), JSON.stringify({
    synthetic: true,
    format_version: 'synthetic-v1',
    session_id: unit.sessionId,
    title: unit.unitId,
    started_at: '2026-11-01T09:00:00.000Z',
    visibility: unit.visibility,
    unit_id: unit.unitId,
    transcript: 'transcript.jsonl',
  }));
  const lines = unit.messages.map((message) => JSON.stringify({
    v: 1,
    type: 'message',
    id: message.id,
    role: message.role,
    text: message.text,
    ts: message.ts,
    ...(message.files === undefined ? {} : { files: message.files }),
    ...(message.symbols === undefined ? {} : { symbols: message.symbols }),
  }));
  await write(join(unitDir, 'transcript.jsonl'), `${lines.join('\n')}\n`);
}

async function baselineFixtures(root: string): Promise<void> {
  await writeUnit(root, 'synthetic-alpha', {
    dir: 'unit-visible',
    unitId: 'alpha-visible',
    sessionId: 'session-alpha',
    visibility: 'visible',
    messages: [
      {
        id: 'alpha-m1',
        role: 'user',
        text: 'refreshToken rotates under a lease',
        ts: '2026-11-01T09:00:01.000Z',
        files: ['src/auth/session.ts'],
        symbols: ['src/auth/session.ts::refreshToken'],
      },
      { id: 'alpha-m2', role: 'assistant', text: 'Lease renewal keeps the token fresh', ts: '2026-11-01T09:00:02.000Z' },
    ],
  });
  await writeUnit(root, 'synthetic-alpha', {
    dir: 'unit-hidden',
    unitId: 'alpha-hidden',
    sessionId: 'session-alpha',
    visibility: 'hidden',
    messages: [{ id: 'alpha-h1', role: 'user', text: 'hidden refreshToken note', ts: '2026-11-01T09:00:03.000Z' }],
  });
  await writeUnit(root, 'synthetic-alpha', {
    dir: 'unit-inactive',
    unitId: 'alpha-inactive',
    sessionId: 'session-alpha',
    visibility: 'inactive',
    messages: [{ id: 'alpha-i1', role: 'user', text: 'inactive lease note', ts: '2026-11-01T09:00:04.000Z' }],
  });
  await writeUnit(root, 'synthetic-beta', {
    dir: 'unit-visible',
    unitId: 'beta-visible',
    sessionId: 'session-beta',
    visibility: 'visible',
    messages: [{
      id: 'beta-m1',
      role: 'user',
      text: 'database migration completed',
      ts: '2026-11-01T10:00:01.000Z',
      files: ['src/db/migrate.ts'],
    }],
  });
}

function hitIds(result: Awaited<ReturnType<typeof recallSurface>>): string[] {
  return result.hits.map((hit) => hit.id);
}

test('recallSurface indexes only explicit synthetic providers and always returns the safety envelope', async (t) => {
  const root = await gitProject(t);
  await baselineFixtures(root);
  // Decoys outside the permitted synthetic root must never be scanned.
  await write(join(root, '.zcode', 'projects', 'p1', 'session.jsonl'), '{"v":1,"type":"message","text":"real client decoy"}\n');
  await write(join(root, '.claude', 'session.jsonl'), '{"v":1,"type":"message","text":"real client decoy"}\n');

  const result = await recallSurface(root, {});
  assert.equal(result.status, 'ok');
  assert.equal(result.untrusted, true);
  assert.equal(result.provenance.kind, 'ano-memory-recall');
  assert.equal(result.provenance.historyDb, '.ano/cache/history.db');
  assert.equal(result.provenance.syntheticRoot, '.ano/memory/synthetic');
  assert.deepEqual(result.provenance.providers, ['synthetic-alpha', 'synthetic-beta']);
  assert.deepEqual(result.degraded, []);
  assert.equal(result.summary.configured, true);
  assert.equal(result.summary.mode, 'structured');
  assert.equal(result.summary.total, 3, 'default visibility is visible only');
  assert.equal(result.summary.returned, 3);
  assert.equal(result.summary.limit, 20);
  assert.equal(result.summary.offset, 0);
  assert.equal(result.summary.ftsAvailable, true);
  assert.equal(result.summary.counts?.messages, 5);
  assert.equal(result.summary.counts?.providers, 2);
  assert.equal(result.summary.skippedArtifacts, 0);
  assert.deepEqual(result.summary.providers.map((provider) => provider.provider), ['synthetic-alpha', 'synthetic-beta']);
  assert.deepEqual(hitIds(result), ['beta-m1', 'alpha-m2', 'alpha-m1']);
  for (const hit of result.hits) {
    assert.equal(hit.untrusted, true);
    assert.equal(hit.provenance.kind, 'session-transcript');
    assert.equal(hit.provenance.provider, hit.provider);
    assert.equal(hit.provenance.sessionId, hit.sessionId);
    assert.equal(hit.provenance.line, hit.line);
  }
  assert.equal(existsSync(join(root, '.ano', 'cache', 'history.db')), true);
  assert.ok(!result.provenance.providers.some((provider) => provider.includes('zcode') || provider.includes('claude')));
});

test('recallSurface applies every structured filter and rejects script/sql fields', async (t) => {
  const root = await gitProject(t);
  await baselineFixtures(root);

  const alpha = await recallSurface(root, { provider: 'synthetic-alpha' });
  assert.deepEqual(hitIds(alpha), ['alpha-m2', 'alpha-m1']);
  assert.equal(alpha.summary.total, 2);

  const keyword = await recallSurface(root, { keyword: 'refreshToken' });
  assert.deepEqual(hitIds(keyword), ['alpha-m1'], 'hidden/inactive rows stay excluded by default');

  const file = await recallSurface(root, { file: 'src/auth/session.ts' });
  assert.deepEqual(hitIds(file), ['alpha-m1']);

  const symbol = await recallSurface(root, { symbol: 'src/auth/session.ts::refreshToken' });
  assert.deepEqual(hitIds(symbol), ['alpha-m1']);

  const session = await recallSurface(root, { session: 'session-alpha' });
  assert.deepEqual(hitIds(session), ['alpha-m2', 'alpha-m1']);

  const window = await recallSurface(root, { from: '2026-11-01T09:00:01.000Z', to: '2026-11-01T09:00:01.000Z' });
  assert.deepEqual(hitIds(window), ['alpha-m1']);

  const beta = await recallSurface(root, { provider: 'synthetic-beta' });
  assert.deepEqual(hitIds(beta), ['beta-m1']);

  const unknown = await recallSurface(root, { provider: 'no-such-provider' });
  assert.equal(unknown.status, 'ok');
  assert.deepEqual(unknown.hits, []);

  await assert.rejects(recallSurface(root, { script: 'process.exit(1)' } as never), /does not accept field/);
  await assert.rejects(recallSurface(root, { sql: 'SELECT 1' } as never), /does not accept field/);
});

test('a malformed synthetic unit degrades the result instead of faking a clean recall', async (t) => {
  const root = await gitProject(t);
  await baselineFixtures(root);
  await write(join(root, ...SYNTHETIC_DIR, 'synthetic-broken', 'unit-bad', 'unit.json'), '{not valid json');

  const result = await recallSurface(root, {});
  assert.equal(result.status, 'degraded');
  assert.deepEqual(hitIds(result), ['beta-m1', 'alpha-m2', 'alpha-m1'], 'one bad provider does not abort valid providers');
  assert.ok(result.degraded.includes('provider:synthetic-broken:skipped:1'), result.degraded.join('; '));
  assert.equal(result.summary.skippedArtifacts, 1);
  assert.equal(result.summary.providerReports.find((report) => report.provider === 'synthetic-broken')?.skipped, 1);
  assert.equal(result.summary.providers.find((provider) => provider.provider === 'synthetic-broken')?.status, 'ok');
});

test('a unit directory directly under the synthetic root is the single "synthetic" provider', async (t) => {
  const root = await gitProject(t);
  await writeUnit(root, '.', {
    dir: 'unit-direct',
    unitId: 'direct-unit',
    sessionId: 'session-direct',
    visibility: 'visible',
    messages: [{
      id: 'direct-m1',
      role: 'user',
      text: 'direct fixture refreshToken',
      ts: '2026-11-02T09:00:01.000Z',
      files: ['src/direct.ts'],
    }],
  });

  const result = await recallSurface(root, {});
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.provenance.providers, ['synthetic']);
  assert.deepEqual(hitIds(result), ['direct-m1']);
  assert.equal((await recallSurface(root, { provider: 'synthetic' })).summary.total, 1);
  assert.equal((await recallSurface(root, { provider: 'unit-direct' })).summary.total, 0);
});

test('a note survives a real ledger restart and is replayed from the segment log', async (t) => {
  const root = await gitProject(t);
  const input: NoteSurfaceInput = {
    idem_key: 'surface-note:restart',
    kind: 'pitfall',
    text: 'recall must not scan real client sessions',
    anchor: { file: 'src/auth/session.ts', qualified_name: 'refreshToken' },
  };

  const ledger = await Ledger.open(root);
  let noteId: string;
  let createdAt: string;
  let segmentPath: string;
  try {
    const first = await noteSurface(ledger, input);
    assert.equal(first.duplicate, false);
    noteId = first.note.id;
    createdAt = first.note.createdAt;
    segmentPath = ledger.segmentPath;
  } finally {
    ledger.close();
  }

  const rawSegment = await readFile(segmentPath, 'utf8');
  assert.ok(rawSegment.includes('note.recorded'), 'the note is committed to the append-only segment');
  assert.ok(rawSegment.includes(noteId), 'the segment contains the content-derived note id');

  // Remove the rebuildable views cache so reopening must replay the segment.
  for (const suffix of ['', '-wal', '-shm']) await rm(`${join(root, '.ano', 'cache', 'views.db')}${suffix}`, { force: true });
  assert.equal(existsSync(join(root, '.ano', 'cache', 'views.db')), false);

  const reopened = await Ledger.open(root);
  try {
    const replayed = reopened.getNote(noteId);
    assert.equal(replayed?.kind, 'pitfall');
    assert.equal(replayed?.text, input.text);
    assert.equal(replayed?.createdAt, createdAt);
    assert.deepEqual(replayed?.anchor, { file: 'src/auth/session.ts', qualifiedName: 'refreshToken' });

    const retried = await noteSurface(reopened, input);
    assert.equal(retried.duplicate, true);
    assert.equal(retried.note.id, noteId);
    assert.equal(retried.note.createdAt, createdAt, 'a restart retry reuses the recorded timestamp');
    assert.equal(reopened.listNotes().length, 1);
  } finally {
    reopened.close();
  }
});
