import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SyntheticFixtureAdapter, parseTranscriptStream, parseTranscriptText } from '../../src/memory/adapter.ts';
import type { IndexUnit } from '../../src/memory/types.ts';

async function temp(prefix: string): Promise<string> { return mkdtemp(join(tmpdir(), prefix)); }

async function write(root: string, path: string, content: string): Promise<void> {
  const target = join(root, ...path.split('/'));
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, content);
}

async function writeJson(root: string, path: string, value: unknown): Promise<void> {
  await write(root, path, JSON.stringify(value));
}

function sha256(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }

function adapter(): SyntheticFixtureAdapter {
  return new SyntheticFixtureAdapter({ provider: 'synthetic-test' });
}

const RECORDS = [
  JSON.stringify({
    v: 1, type: 'message', text: 'hello world', ts: '2026-01-01T00:00:00Z', role: 'user',
    files: ['src/a.ts', './src/b.ts', 'C:/abs.ts', '/abs.ts', '../up.ts', 'src\\win.ts', '', 7],
    symbols: ['alpha', 'beta'], id: 'rec-1', tool: 'bash', visibility: 'hidden',
  }),
  '',
  '{ not json',
  '[]',
  JSON.stringify({ v: 2, type: 'message', text: 'old' }),
  JSON.stringify({ v: 1, type: 'tool_call', text: 'wrong type' }),
  JSON.stringify({ v: 1, type: 'message' }),
  JSON.stringify({ v: 1, type: 'message', text: 'no timestamp' }),
  JSON.stringify({ v: 1, type: 'message', text: 'bad role', ts: '2026-01-01T00:00:00Z', role: 'wizard', visibility: 'bogus' }),
  JSON.stringify({ v: 1, type: 'message', text: 'control id', ts: '2026-01-01T00:00:00Z', id: 'bad\u0001id', tool: '' }),
  '',
].join('\n');

test('discover reports every skipped artifact shape and indexes metadata defaults', async () => {
  const root = await temp('ano adapter discover ');
  try {
    await write(root, 'plain-file.txt', 'x');
    await writeJson(root, 'unit-visible/unit.json', {
      synthetic: true, format_version: 'synthetic-v1', unit_id: 'unit-visible',
      session_id: 'session-1', title: 'Visible unit', started_at: '2026-01-01T00:00:00Z', visibility: 'visible', transcript: 'transcript.jsonl',
    });
    await write(root, 'unit-visible/transcript.jsonl', RECORDS);

    await mkdir(join(root, 'no-metadata'), { recursive: true });
    await writeJson(root, 'bad-metadata/unit.json', {});
    await write(root, 'bad-metadata/unit.json', '{ not json');

    await writeJson(root, 'not-synthetic/unit.json', { synthetic: false, format_version: 'synthetic-v1' });
    await writeJson(root, 'no-format/unit.json', { synthetic: true });
    await writeJson(root, 'old-format/unit.json', { synthetic: true, format_version: 'synthetic-v0' });
    await writeJson(root, 'bad-visibility/unit.json', { synthetic: true, format_version: 'synthetic-v1', visibility: 'nope' });
    await writeJson(root, 'unsafe-transcript/unit.json', { synthetic: true, format_version: 'synthetic-v1', transcript: '../outside.jsonl' });
    await writeJson(root, 'absolute-transcript/unit.json', { synthetic: true, format_version: 'synthetic-v1', transcript: 'C:/outside.jsonl' });
    await writeJson(root, 'missing-transcript/unit.json', { synthetic: true, format_version: 'synthetic-v1', transcript: 'gone.jsonl' });

    await writeJson(root, 'defaults/unit.json', { synthetic: true, format_version: 'synthetic-v1', unit_id: '', session_id: 7, title: 9, started_at: 'nonsense', visibility: undefined });
    await write(root, 'defaults/transcript.jsonl', JSON.stringify({ v: 1, type: 'message', text: 'defaults', ts: '2026-01-01T00:00:00Z' }));

    await writeJson(root, 'dup-a/unit.json', { synthetic: true, format_version: 'synthetic-v1', unit_id: 'same-id' });
    await write(root, 'dup-a/transcript.jsonl', JSON.stringify({ v: 1, type: 'message', text: 'one', ts: '2026-01-01T00:00:00Z' }));
    await writeJson(root, 'dup-b/unit.json', { synthetic: true, format_version: 'synthetic-v1', unit_id: 'same-id' });
    await write(root, 'dup-b/transcript.jsonl', JSON.stringify({ v: 1, type: 'message', text: 'two', ts: '2026-01-01T00:00:00Z' }));

    const discovered = await adapter().discover(root);
    const reasons = discovered.skipped.map((artifact) => artifact.reason);
    for (const reason of ['invalid-unit-metadata:', 'not-synthetic-fixture', 'unknown-format-version', 'invalid-visibility', 'unsafe-transcript-path', 'transcript-unreadable:ENOENT', 'duplicate-unit-id']) {
      assert.ok(reasons.some((entry) => entry.startsWith(reason)), `missing ${reason}: ${reasons.join(',')}`);
    }
    assert.equal(discovered.skipped.filter((artifact) => artifact.reason === 'unknown-format-version').length, 2, 'missing and unknown versions');
    assert.equal(discovered.skipped.filter((artifact) => artifact.reason === 'unsafe-transcript-path').length, 2);

    const ids = discovered.units.map((unit) => unit.unitId).sort();
    assert.deepEqual(ids, ['defaults', 'same-id', 'unit-visible']);
    const defaults = discovered.units.find((unit) => unit.unitId === 'defaults')!;
    assert.equal(defaults.sessionId, 'defaults');
    assert.equal(defaults.title, '');
    assert.equal(defaults.startedAt, '');
    assert.equal(defaults.visibility, 'visible');
    assert.equal(defaults.sourcePath, 'defaults/transcript.jsonl');

    const visible = discovered.units.find((unit) => unit.unitId === 'unit-visible')!;
    assert.equal(visible.sessionId, 'session-1');
    assert.equal(visible.visibility, 'visible', 'unknown visibility falls back to visible');
    assert.match(visible.contentHash, /^[a-f0-9]{64}$/);
    assert.ok(visible.size > 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('discover validates the constructor and parse refuses foreign or mutated units', async () => {
  assert.throws(() => new SyntheticFixtureAdapter({ provider: '' }), /provider id/);

  const root = await temp('ano adapter parse ');
  try {
    await writeJson(root, 'unit/unit.json', { synthetic: true, format_version: 'synthetic-v1', unit_id: 'unit-1' });
    await write(root, 'unit/transcript.jsonl', RECORDS);
    const discovered = await adapter().discover(root);
    const unit = discovered.units[0]!;

    const parsed = await adapter().parse(unit);
    assert.ok(parsed.records.length >= 1);
    assert.ok(parsed.skipped.length >= 5);

    await assert.rejects(adapter().parse({ ...unit, provider: 'other' }), /cannot parse unit/);
    await assert.rejects(adapter().parse({ ...unit, formatVersion: 'synthetic-v9' }), /Unsupported unit format/);
    await assert.rejects(adapter().parse({ ...unit, absolutePath: '' }), /was not produced by discover/);
    await assert.rejects(adapter().parse({ ...unit, contentHash: 'f'.repeat(64) }), /changed while indexing/);

    const fromRoot = await adapter().parseFromRoot(root, unit);
    assert.deepEqual(fromRoot.records.length, parsed.records.length);
    await assert.rejects(adapter().parseFromRoot(root, { ...unit, sourcePath: '../outside.jsonl' }), /Unsafe transcript path/);
    await assert.rejects(adapter().parseFromRoot(root, { ...unit, contentHash: 'f'.repeat(64) }), /changed while indexing/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('parseTranscriptText covers unknown record shapes, id fallback and oversized records', () => {
  const unit: IndexUnit = {
    provider: 'synthetic-test', unitId: 'unit-1', sourcePath: 'unit/transcript.jsonl', sessionId: 'session-1',
    title: 't', startedAt: '2026-01-01T00:00:00Z', formatVersion: 'synthetic-v1', visibility: 'visible',
    contentHash: sha256('x'), mtimeMs: 0, size: 0, absolutePath: '/tmp/does-not-exist',
  };

  const result = parseTranscriptText(unit, RECORDS);
  const reasons = result.skipped.map((artifact) => artifact.reason);
  for (const reason of ['invalid-record-json:line 3', 'invalid-record-json:line 4', 'unknown-record-version:line 5', 'unknown-record-type:line 6', 'empty-text:line 7', 'invalid-timestamp:line 8']) {
    assert.ok(reasons.includes(reason), `${reason} missing from ${reasons.join(',')}`);
  }
  const first = result.records[0]!;
  assert.equal(first.id, 'rec-1');
  assert.equal(first.role, 'user');
  assert.equal(first.toolName, 'bash');
  assert.equal(first.visibility, 'hidden');
  assert.deepEqual(first.files, ['src/a.ts', 'src/b.ts', 'src/win.ts']);
  assert.deepEqual(first.symbols, ['alpha', 'beta']);

  const unknownRole = result.records.find((record) => record.text === 'bad role')!;
  assert.equal(unknownRole.role, 'unknown');
  assert.equal(unknownRole.visibility, 'visible', 'invalid record visibility falls back to the unit');

  const controlId = result.records.find((record) => record.text === 'control id')!;
  assert.notEqual(controlId.id, 'bad\u0001id');
  assert.match(controlId.id, /^[a-f0-9]{64}$/);
  assert.equal(controlId.toolName, undefined);

  const oversized = parseTranscriptText(unit, JSON.stringify({
    v: 1, type: 'message', text: 'a'.repeat(1_000_001), ts: '2026-01-01T00:00:00Z',
  }));
  assert.equal(oversized.records.length, 0);
  assert.deepEqual(oversized.skipped.map((artifact) => artifact.reason), ['record-too-large:line 1']);

  const symbols = parseTranscriptText(unit, JSON.stringify({
    v: 1, type: 'message', text: 'many', ts: '2026-01-01T00:00:00Z',
    files: ['src/a.ts', 'src/a.ts'], symbols: ['a', 'a', 'b', 'x'.repeat(513)],
  })).records[0]!;
  assert.deepEqual(symbols.files, ['src/a.ts']);
  assert.deepEqual(symbols.symbols, ['a', 'b']);
});

test('parseTranscriptStream repairs cursors and replays the remaining lines', () => {
  const unit: IndexUnit = {
    provider: 'synthetic-test', unitId: 'unit-2', sourcePath: 'unit/transcript.jsonl', sessionId: 'session-2',
    title: 't', startedAt: '2026-01-01T00:00:00Z', formatVersion: 'synthetic-v1', visibility: 'visible',
    contentHash: sha256('x'), mtimeMs: 0, size: 0, absolutePath: '/tmp/does-not-exist',
  };
  const transcript = [
    JSON.stringify({ v: 1, type: 'message', text: 'first', ts: '2026-01-01T00:00:00Z' }),
    JSON.stringify({ v: 1, type: 'message', text: 'second', ts: '2026-01-01T00:00:01Z' }),
    '',
  ].join('\r\n');

  const fromStart = parseTranscriptStream(unit, transcript);
  assert.equal(fromStart.fullReplay, true);
  assert.deepEqual([...fromStart.events()].map((event) => event.type), ['record', 'record']);
  assert.equal(fromStart.lineCount, 2);

  const validCursor = { ...fromStart.cursor, line: 1 } as unknown as Parameters<typeof parseTranscriptStream>[2];
  const resumed = parseTranscriptStream(unit, transcript, validCursor);
  assert.equal(resumed.fullReplay, false);
  const resumedEvents = [...resumed.events()];
  assert.equal(resumedEvents.length, 1);
  assert.equal((resumedEvents[0] as { record: { text: string } }).record.text, 'second');

  const invalidCursor = { ...fromStart.cursor, contentHash: 'f'.repeat(64) } as unknown as Parameters<typeof parseTranscriptStream>[2];
  const replayed = parseTranscriptStream(unit, transcript, invalidCursor);
  assert.equal(replayed.fullReplay, true);
  assert.equal([...replayed.events()].length, 2);
});
