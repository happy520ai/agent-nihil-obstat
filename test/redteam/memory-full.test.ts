import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SyntheticFixtureAdapter, parseTranscriptStream, parseTranscriptText } from '../../src/memory/adapter.ts';
import { decodeCursor, makeCursor } from '../../src/memory/cursor.ts';
import { ingestProvider } from '../../src/memory/ingest.ts';
import { HistoryStore, RecallQueryError } from '../../src/memory/store.ts';
import { codePointLength, planTextQuery, queryTokens, tokenizeText } from '../../src/memory/tokenizer.ts';
import { memoryCompatibility, memoryPlannedClients } from '../../src/memory/compat.ts';
import type { Cursor, DiscoverResult, IndexUnit, MemoryProviderAdapter, ParseResult, RecallQuery } from '../../src/memory/types.ts';

const FIXTURES = fileURLToPath(new URL('../fixtures/memory/', import.meta.url));
const ALPHA_ROOT = join(FIXTURES, 'synthetic-alpha');
const BETA_ROOT = join(FIXTURES, 'synthetic-beta');

async function harness(t: TestContext): Promise<{ root: string; store: HistoryStore }> {
  const root = await mkdtemp(join(tmpdir(), 'ano-memory-red-'));
  const store = HistoryStore.open(root);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, store };
}

async function baseline(store: HistoryStore): Promise<void> {
  assert.equal((await ingestProvider(store, new SyntheticFixtureAdapter({ provider: 'synthetic-alpha' }), ALPHA_ROOT)).status, 'ok');
  assert.equal((await ingestProvider(store, new SyntheticFixtureAdapter({ provider: 'synthetic-beta' }), BETA_ROOT)).status, 'ok');
}

async function writeSyntheticUnit(root: string, provider: string, unitId: string, text: string, metadata: Record<string, unknown> = {}): Promise<void> {
  const directory = join(root, 'fixtures', provider, unitId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'unit.json'), JSON.stringify({
    synthetic: true,
    _comment: 'runtime-generated synthetic red-team fixture',
    format_version: 'synthetic-v1',
    unit_id: unitId,
    session_id: `session-${unitId}`,
    title: 'Synthetic red-team unit',
    started_at: '2026-11-10T10:00:00.000Z',
    visibility: 'visible',
    transcript: 'transcript.jsonl',
    ...metadata,
  }, null, 2));
  await writeFile(join(directory, 'transcript.jsonl'), `${JSON.stringify({ v: 1, type: 'message', id: `${unitId}-m1`, role: 'tool', ts: '2026-11-10T10:00:01.000Z', text })}\n`);
}

test('SQL injection in every structured field stays data and cannot mutate the cache', async (t) => {
  const { store } = await harness(t);
  await baseline(store);
  const before = store.counts();

  const attacks = [
    "'; DROP TABLE messages; --",
    "' OR '1'='1",
    '" OR 1=1 --',
    '1; DELETE FROM messages; --',
    'messages --',
    '\\',
    '%',
    '_',
  ];
  for (const attack of attacks) {
    assert.doesNotThrow(() => store.recall({ keyword: attack }));
    assert.doesNotThrow(() => store.recall({ provider: attack }));
    assert.doesNotThrow(() => store.recall({ session: attack }));
    assert.doesNotThrow(() => store.recall({ file: attack }));
    assert.doesNotThrow(() => store.recall({ symbol: attack }));
    assert.doesNotThrow(() => store.recall({ keyword: attack, provider: attack, session: attack, file: attack, symbol: attack }));
  }

  assert.throws(() => store.recall({ script: 'while(true){}' } as unknown as RecallQuery), RecallQueryError);
  assert.throws(() => store.recall({ sql: 'DROP TABLE messages' } as unknown as RecallQuery), RecallQueryError);
  assert.throws(() => store.recall({ exec: 'rm -rf /' } as unknown as RecallQuery), RecallQueryError);
  assert.throws(() => store.recall({ visibility: 'secret' } as unknown as RecallQuery), RecallQueryError);
  assert.throws(() => store.recall({ limit: 1_000_000 }), RecallQueryError);
  assert.throws(() => store.recall({ offset: -1 }), RecallQueryError);

  assert.deepEqual(store.counts(), before, 'tables and row counts survived every injection');
  assert.equal(store.recall({ provider: 'synthetic-alpha' }).total, 6);
  assert.equal(store.recall({ provider: 'synthetic-alpha', keyword: 'refreshToken' }).total, 2);
});

test('runtime-generated malicious transcript is returned as text and never executed', async (t) => {
  const { root, store } = await harness(t);
  const marker = join(root, 'pwned-marker.txt');
  const payload = [
    `$(touch ${marker})`,
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`,
    "'; DROP TABLE messages; --",
    'process.exit(99)',
  ].join(' | ');
  await writeSyntheticUnit(root, 'synthetic-evil', 'unit-evil', payload);
  const report = await ingestProvider(store, new SyntheticFixtureAdapter({ provider: 'synthetic-evil' }), join(root, 'fixtures', 'synthetic-evil'));
  assert.equal(report.status, 'ok');
  assert.equal(existsSync(marker), false, 'payload was not executed');

  const hit = store.recall({ provider: 'synthetic-evil', keyword: 'writeFileSync' });
  assert.equal(hit.total, 1);
  assert.equal(hit.hits[0]?.text, payload);
  assert.ok(!existsSync(marker));
  assert.equal(store.counts().messages, 1);
  const snippet = store.recall({ provider: 'synthetic-evil' }).hits[0]?.snippet ?? '';
  assert.ok(snippet.includes('writeFileSync'));
  assert.ok(payload.includes(snippet.replaceAll('…', '')));
});

test('one provider failing does not poison another provider', async (t) => {
  const { root, store } = await harness(t);
  await baseline(store);
  const alphaBefore = store.getProvider('synthetic-alpha');
  const betaBefore = store.getProvider('synthetic-beta');

  const failed = await ingestProvider(store, new SyntheticFixtureAdapter({ provider: 'synthetic-missing' }), join(root, 'missing-provider'));
  assert.equal(failed.status, 'failed');
  assert.match(failed.error ?? '', /ENOENT|no such file|does not exist/i);
  assert.equal(store.getProvider('synthetic-missing')?.status, 'failed');
  assert.deepEqual(store.getProvider('synthetic-alpha'), alphaBefore);
  assert.deepEqual(store.getProvider('synthetic-beta'), betaBefore);
  assert.equal(store.recall({ provider: 'synthetic-beta' }).total, 3);
});

test('unit-level parse failure is isolated, visible as degraded, and recoverable', async (t) => {
  const { store } = await harness(t);
  const inner = new SyntheticFixtureAdapter({ provider: 'synthetic-alpha' });
  const flaky: MemoryProviderAdapter = {
    provider: inner.provider,
    markerVersion: inner.markerVersion,
    formatVersion: inner.formatVersion,
    discover: (root): Promise<DiscoverResult> => inner.discover(root),
    parse: (unit: IndexUnit, cursor?: Cursor): Promise<ParseResult> => {
      if (unit.unitId === 'alpha-visible') return Promise.reject(new Error('synthetic parse failure'));
      return inner.parse(unit, cursor);
    },
  };
  const degraded = await ingestProvider(store, flaky, ALPHA_ROOT);
  assert.equal(degraded.status, 'degraded');
  assert.equal(degraded.parseErrors, 1);
  assert.ok(store.skippedArtifacts('synthetic-alpha').some((row) => row.reason.startsWith('parse-error:synthetic parse failure')));
  assert.equal(store.recall({ provider: 'synthetic-alpha', keyword: 'refreshToken' }).total, 0, 'failed unit is not half-indexed');
  assert.ok(store.getProvider('synthetic-alpha')?.status === 'degraded');

  const recovered = await ingestProvider(store, new SyntheticFixtureAdapter({ provider: 'synthetic-alpha' }), ALPHA_ROOT);
  assert.equal(recovered.status, 'ok');
  assert.equal(store.recall({ provider: 'synthetic-alpha', keyword: 'refreshToken' }).total, 2);
  assert.equal(store.counts().messages, 8);
});

test('unknown formats skip only that unit and unknown record versions only that line', async (t) => {
  const { root, store } = await harness(t);
  await baseline(store);
  const skipped = store.skippedArtifacts('synthetic-alpha');
  assert.ok(skipped.some((row) => row.reason === 'unknown-format-version'));
  assert.ok(!store.listUnits('synthetic-alpha').some((unit) => unit.unitId === 'alpha-unknown-format'));
  assert.ok(store.getProvider('synthetic-alpha')?.status === 'ok', 'unknown format does not poison the provider');
  assert.equal(store.recall({ provider: 'synthetic-alpha', keyword: '数据库' }).total, 3);
  assert.equal(store.recall({ provider: 'synthetic-alpha', keyword: '未来版本' }).total, 0, 'unknown version line was skipped');
  assert.ok(skipped.some((row) => row.reason.startsWith('unknown-record-version:line 2')));

  await writeSyntheticUnit(root, 'synthetic-mixed', 'unit-mixed', '第一行有效合成记录', { format_version: 'synthetic-v1' });
  const report = await ingestProvider(store, new SyntheticFixtureAdapter({ provider: 'synthetic-mixed' }), join(root, 'fixtures', 'synthetic-mixed'));
  assert.equal(report.status, 'ok');
  assert.equal(report.records, 1);
});

test('cursor validation degrades to full replay and no cursor is trusted across content hashes', async (t) => {
  const { store } = await harness(t);
  await baseline(store);
  const adapter = new SyntheticFixtureAdapter({ provider: 'synthetic-alpha' });
  const discovered = await adapter.discover(ALPHA_ROOT);
  const unit = discovered.units.find((candidate) => candidate.unitId === 'alpha-visible');
  assert.ok(unit);
  const valid = makeCursor(unit, 1);
  assert.equal(decodeCursor(JSON.stringify(valid), unit)?.line, 1);
  const suffix = await adapter.parse(unit, valid);
  assert.equal(suffix.fullReplay, false);
  assert.equal(suffix.records.length, 3);
  assert.equal(suffix.records[0]?.id, 'alpha-m2');

  const invalid = { ...valid, contentHash: '0'.repeat(64) };
  assert.equal(decodeCursor(JSON.stringify(invalid), unit), undefined);
  const full = await adapter.parse(unit, invalid as Cursor);
  assert.equal(full.fullReplay, true);
  assert.equal(full.records.length, 4);

  const malformed = decodeCursor('{not json', unit);
  assert.equal(malformed, undefined);
  const unstable = { ...unit, contentHash: '1'.repeat(64) };
  assert.equal(decodeCursor(JSON.stringify(valid), unstable), undefined);

  const pure = parseTranscriptText(unit, '{"v":1,"type":"message","id":"x","role":"user","ts":"2026-11-01T00:00:00Z","text":"合成"}\n', valid);
  assert.equal(pure.fullReplay, false);
  assert.equal(pure.records.length, 0);

  const transcript = [
    '{"v":1,"type":"message","id":"s1","role":"user","ts":"2026-11-01T00:00:00Z","text":"合成一"}',
    '{"v":99,"type":"message","id":"s2","role":"user","ts":"2026-11-01T00:00:01Z","text":"未来"}',
    '{"v":1,"type":"message","id":"s3","role":"user","ts":"2026-11-01T00:00:02Z","text":"合成二"}',
  ].join('\n');
  const stream = parseTranscriptStream(unit, transcript);
  const events = [...stream.events()];
  assert.equal(stream.cursor.line, 3);
  assert.equal(stream.fullReplay, true);
  assert.deepEqual(events.map((event) => event.type), ['record', 'skipped', 'record']);
  assert.deepEqual(parseTranscriptText(unit, transcript).records.map((record) => record.id), ['s1', 's3']);
});

test('two-character CJK degrades while identifier subtokens use FTS', async (t) => {
  const { store } = await harness(t);
  await baseline(store);

  for (const query of ['租约', '死锁', '账本', '租', '𠮷']) {
    const plan = planTextQuery(query);
    assert.equal(plan.mode, 'like', `${query} must use the LIKE fallback`);
    assert.equal(plan.degraded, 'unigram-scan');
  }
  const result = store.recall({ provider: 'synthetic-alpha', keyword: '租约' });
  assert.equal(result.mode, 'like');
  assert.equal(result.degraded, 'unigram-scan');
  assert.equal(result.total, 3);
  assert.ok(result.hits.every((hit) => hit.text.includes('租约')));

  assert.equal(planTextQuery('数据库').mode, 'fts');
  assert.deepEqual(queryTokens('refreshToken'), tokenizeText('refreshToken'));
  assert.ok(queryTokens('refreshToken').includes('token'));
  assert.equal(store.recall({ provider: 'synthetic-alpha', keyword: 'refreshToken' }).total, 2);
  assert.equal(store.recall({ provider: 'synthetic-alpha', keyword: 'token' }).total, 2);
  assert.equal(store.recall({ provider: 'synthetic-beta', keyword: 'XMLHttpRequest' }).total, 1);
  assert.equal(store.recall({ provider: 'synthetic-beta', keyword: 'utf8Decode' }).total, 1);
  assert.equal(store.recall({ provider: 'synthetic-beta', keyword: 'base64' }).total, 1);
  assert.equal(codePointLength('𠮷'), 1);
  assert.equal(codePointLength('𠮷野家'), 3);
});

test('marker bump resets only its provider; beta cache is untouched', async (t) => {
  const { store } = await harness(t);
  await baseline(store);
  const betaBefore = store.getProvider('synthetic-beta');
  const betaHits = store.recall({ provider: 'synthetic-beta', keyword: '数据库' }).total;

  const bumped = await ingestProvider(store, new SyntheticFixtureAdapter({ provider: 'synthetic-alpha', markerVersion: 'synthetic-marker-v9' }), ALPHA_ROOT);
  assert.equal(bumped.markerChanged, true);
  assert.equal(bumped.records, 8);
  assert.deepEqual(store.getProvider('synthetic-beta'), betaBefore);
  assert.equal(store.recall({ provider: 'synthetic-beta', keyword: '数据库' }).total, betaHits);
  assert.equal(store.getProvider('synthetic-alpha')?.marker, 'synthetic-marker-v9');
});

test('inactive and hidden history is retained but excluded from default recall', async (t) => {
  const { store } = await harness(t);
  await baseline(store);
  assert.equal(store.recall({ provider: 'synthetic-alpha' }).total, 6);
  assert.equal(store.recall({ provider: 'synthetic-alpha', visibility: 'inactive' }).total, 1);
  assert.equal(store.recall({ provider: 'synthetic-alpha', visibility: 'hidden' }).total, 1);
  assert.equal(store.recall({ provider: 'synthetic-alpha', visibility: 'all' }).total, 8);
  assert.equal(store.counts().byVisibility.inactive, 1);
  assert.equal(store.counts().byVisibility.hidden, 1);
  assert.equal(store.recall({ provider: 'synthetic-alpha', keyword: 'SYNTHETIC_NOT_A_REAL_SECRET' }).total, 0);
  assert.equal(store.recall({ provider: 'synthetic-alpha', keyword: 'SYNTHETIC_NOT_A_REAL_SECRET', visibility: 'hidden' }).total, 1);
});

test('compatibility matrix claims synthetic-only and names planned clients without support', () => {
  assert.equal(memoryCompatibility.length, 1);
  assert.equal(memoryCompatibility[0]?.status, 'synthetic-only');
  assert.equal(memoryCompatibility[0]?.sampleSource, 'hand-authored-synthetic-fixtures');
  assert.ok(memoryCompatibility[0]?.limitations.some((line) => line.includes('No real client session file')));
  assert.deepEqual(memoryPlannedClients, ['ZCode', 'Qoder', 'Codex', 'Claude Code', 'WorkBuddy']);
  assert.ok(memoryCompatibility.every((entry) => entry.status === 'synthetic-only'));
});
