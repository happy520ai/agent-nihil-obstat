import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { anchorSourceFromFileSystem, type MemoryAnchor } from '../../src/memory/anchor.ts';
import { SyntheticFixtureAdapter } from '../../src/memory/adapter.ts';
import { buildMemoryBrief } from '../../src/memory/brief.ts';
import { MemoryNoteBook, validateMemoryNote, toLedgerNotePayload, MemoryNoteError } from '../../src/memory/note.ts';
import { HistoryStore, RecallQueryError } from '../../src/memory/store.ts';
import { ingestProvider } from '../../src/memory/ingest.ts';
import { planTextQuery, splitIdentifier, tokenizeText, codePointLength } from '../../src/memory/tokenizer.ts';
import type { RecallQuery } from '../../src/memory/types.ts';

const FIXTURES = fileURLToPath(new URL('../fixtures/memory/', import.meta.url));
const ALPHA_ROOT = join(FIXTURES, 'synthetic-alpha');
const BETA_ROOT = join(FIXTURES, 'synthetic-beta');
const BROKEN_ROOT = join(FIXTURES, 'synthetic-broken');

interface Harness {
  readonly root: string;
  readonly store: HistoryStore;
}

async function harness(t: TestContext): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'ano-memory-it-'));
  const store = HistoryStore.open(root);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, store };
}

function alpha(markerVersion = 'synthetic-marker-v1'): SyntheticFixtureAdapter {
  return new SyntheticFixtureAdapter({ provider: 'synthetic-alpha', markerVersion });
}

function beta(): SyntheticFixtureAdapter {
  return new SyntheticFixtureAdapter({ provider: 'synthetic-beta' });
}

async function ingestBaseline(store: HistoryStore): Promise<void> {
  const reports = [
    await ingestProvider(store, alpha(), ALPHA_ROOT),
    await ingestProvider(store, beta(), BETA_ROOT),
    await ingestProvider(store, new SyntheticFixtureAdapter({ provider: 'synthetic-broken' }), BROKEN_ROOT),
  ];
  assert.deepEqual(reports.map((report) => report.status), ['ok', 'ok', 'ok']);
}

test('synthetic adapters discover only guarded units and report skipped artifacts', async (t) => {
  const { store } = await harness(t);
  await ingestBaseline(store);

  const counts = store.counts();
  assert.equal(counts.providers, 3);
  assert.equal(counts.units, 6, '4 alpha + 2 beta, malformed unit skipped');
  assert.equal(counts.messages, 11, '8 alpha + 3 beta');
  assert.equal(counts.sessions, 6);
  assert.equal(counts.skippedArtifacts, 7, '4 discovery skips + 2 bad-record lines + 1 broken unit');

  const alphaState = store.getProvider('synthetic-alpha');
  assert.equal(alphaState?.status, 'ok');
  assert.equal(alphaState?.units, 4);
  assert.equal(alphaState?.records, 8);

  const skipped = store.skippedArtifacts('synthetic-alpha').map((row) => row.reason);
  assert.ok(skipped.includes('unknown-format-version'));
  assert.ok(skipped.includes('not-synthetic-fixture'));
  assert.ok(skipped.includes('transcript-unreadable:ENOENT'));
  assert.ok(skipped.includes('unsafe-transcript-path'));
  assert.ok(skipped.some((reason) => reason.startsWith('unknown-record-version:line 2')));
  assert.ok(skipped.some((reason) => reason.startsWith('invalid-record-json:line 3')));

  const malformed = store.skippedArtifacts('synthetic-broken');
  assert.equal(malformed.length, 1);
  assert.ok(malformed[0]?.reason.startsWith('invalid-unit-metadata'));

  assert.equal(store.listUnits('synthetic-alpha').length, 4);
  assert.ok(!store.listUnits('synthetic-alpha').some((unit) => unit.unitId.includes('unknown-format')));

  store.clear();
  assert.equal(store.counts().messages, 0);
  assert.equal(store.listProviders().length, 0);
  assert.equal(store.recall({ keyword: 'refreshToken' }).total, 0);
});

test('recall honours every structured filter and never accepts scripts', async (t) => {
  const { store } = await harness(t);
  await ingestBaseline(store);

  const bySession = store.recall({ session: 'synthetic-session-alpha' });
  assert.equal(bySession.total, 4);
  assert.equal(bySession.mode, 'structured');

  const byFile = store.recall({ provider: 'synthetic-alpha', file: 'src/db/pool.ts' });
  assert.deepEqual(byFile.hits.map((hit) => hit.id).sort(), ['alpha-cjk', 'alpha-m2']);

  const bySymbol = store.recall({ provider: 'synthetic-alpha', symbol: 'src/auth/session.ts::refreshToken' });
  assert.deepEqual(bySymbol.hits.map((hit) => hit.id).sort(), ['alpha-m1', 'alpha-m2', 'alpha-tool']);

  const byTime = store.recall({ provider: 'synthetic-alpha', from: '2026-11-01T09:00:02.000Z', to: '2026-11-01T09:00:03.000Z' });
  assert.deepEqual(byTime.hits.map((hit) => hit.id).sort(), ['alpha-m2', 'alpha-tool']);
  assert.equal(byTime.hits[0]?.timestamp, '2026-11-01T09:00:03.000Z');

  const byProvider = store.recall({ provider: 'synthetic-beta' });
  assert.equal(byProvider.total, 3);

  assert.equal(store.recall({ provider: 'synthetic-alpha' }).total, 6, 'default is visible only');
  assert.equal(store.recall({ provider: 'synthetic-alpha', visibility: 'inactive' }).total, 1);
  assert.equal(store.recall({ provider: 'synthetic-alpha', visibility: 'hidden' }).total, 1);
  assert.equal(store.recall({ provider: 'synthetic-alpha', visibility: 'all' }).total, 8);

  const fts = store.recall({ provider: 'synthetic-alpha', keyword: 'refreshToken' });
  assert.equal(fts.mode, 'fts');
  assert.equal(fts.degraded, null);
  assert.equal(fts.total, 2);
  assert.deepEqual(fts.hits.map((hit) => hit.id).sort(), ['alpha-m1', 'alpha-m2']);

  const subword = store.recall({ provider: 'synthetic-alpha', keyword: 'token' });
  assert.equal(subword.mode, 'fts');
  assert.equal(subword.total, 2, 'identifier subtoken token matches refreshToken');

  const cjkDatabase = store.recall({ provider: 'synthetic-alpha', keyword: '数据库' });
  assert.equal(cjkDatabase.mode, 'fts');
  assert.equal(cjkDatabase.degraded, null);
  assert.deepEqual(cjkDatabase.hits.map((hit) => hit.id).sort(), ['alpha-cjk', 'alpha-m2', 'alpha-partial-m2']);

  const cjkTwo = store.recall({ provider: 'synthetic-alpha', keyword: '租约' });
  assert.equal(cjkTwo.mode, 'like');
  assert.equal(cjkTwo.degraded, 'unigram-scan');
  assert.equal(cjkTwo.total, 3);

  assert.equal(store.recall({ provider: 'synthetic-alpha', keyword: '死锁' }).degraded, 'unigram-scan');
  assert.equal(store.recall({ provider: 'synthetic-alpha', keyword: '𠮷' }).degraded, 'unigram-scan');
  const nonBmp = store.recall({ provider: 'synthetic-alpha', keyword: '𠮷野家' });
  assert.equal(nonBmp.mode, 'fts', 'three code points use FTS even when UTF-16 length is four');
  assert.deepEqual(nonBmp.hits.map((hit) => hit.id), ['alpha-cjk']);

  const originalSnippet = fts.hits.find((hit) => hit.id === 'alpha-m1')?.snippet ?? '';
  assert.ok(originalSnippet.includes('refreshToken'), 'snippet comes from the original text column');
  assert.ok(!originalSnippet.includes('refresh token'), 'snippet is not the tokenized index text');

  assert.throws(() => store.recall({ script: 'process.exit(1)' } as unknown as RecallQuery), RecallQueryError);
  assert.throws(() => store.recall({ sql: 'SELECT 1' } as unknown as RecallQuery), RecallQueryError);
  assert.throws(() => store.recall({ limit: 1000 }), RecallQueryError);
  assert.throws(() => store.recall({ from: 'not-a-date' }), RecallQueryError);
  assert.throws(() => store.recall({ from: '2026-11-02T00:00:00Z', to: '2026-11-01T00:00:00Z' }), RecallQueryError);
});

test('malicious transcript text is stored and returned, never executed', async (t) => {
  const { store } = await harness(t);
  await ingestBaseline(store);
  const before = store.counts().messages;
  const hits = store.recall({ provider: 'synthetic-alpha', keyword: 'DROP' });
  assert.equal(hits.mode, 'fts');
  assert.equal(hits.total, 1);
  assert.ok(hits.hits[0]?.text.includes('DROP TABLE messages'));
  assert.ok(hits.hits[0]?.text.includes("require('node:child_process')"));
  assert.equal(store.counts().messages, before, 'messages table survives transcript SQL text');
  assert.equal(existsSync(join(process.cwd(), 'pwned-synthetic')), false);
  assert.equal(store.recall({ provider: 'synthetic-alpha' }).total, 6);

  const injectionQueries = [
    "'; DROP TABLE messages; --",
    "' OR '1'='1",
    '%',
    '_',
    '1; DELETE FROM messages WHERE 1=1; --',
  ];
  for (const keyword of injectionQueries) {
    const result = store.recall({ keyword });
    assert.ok(result.total <= before, `injected keyword ${JSON.stringify(keyword)} cannot exceed real rows`);
  }
  assert.equal(store.counts().messages, before);
  assert.equal(store.getProvider('synthetic-alpha')?.status, 'ok');
});

test('cursor reuse, corrupt cursor fallback and marker bump', async (t) => {
  const { root, store } = await harness(t);
  await ingestBaseline(store);

  const second = await ingestProvider(store, alpha(), ALPHA_ROOT);
  assert.equal(second.records, 0, 'unchanged units are consumed by the cursor');
  assert.equal(second.reused, 4);
  assert.equal(second.fullReplays, 0);
  assert.equal(second.cursorFallbacks, 0);
  assert.equal(store.counts().messages, 11);

  store.close();
  const dbPath = HistoryStore.databasePath(root);
  const raw = new DatabaseSync(dbPath);
  raw.prepare('UPDATE units SET cursor = ? WHERE provider = ? AND unit_id = ?').run('{broken', 'synthetic-alpha', 'alpha-visible');
  raw.close();

  const reopened = HistoryStore.open(root);
  t.after(() => reopened.close());
  const afterCorrupt = await ingestProvider(reopened, alpha(), ALPHA_ROOT);
  assert.equal(afterCorrupt.cursorFallbacks, 1);
  assert.equal(afterCorrupt.fullReplays, 1);
  assert.equal(afterCorrupt.records, 4, 'invalid cursor degrades to a full replay of that unit');
  assert.equal(reopened.counts().messages, 11, 'full replay replaces rather than duplicates');

  const bumped = await ingestProvider(reopened, alpha('synthetic-marker-v2'), ALPHA_ROOT);
  assert.equal(bumped.markerChanged, true);
  assert.equal(bumped.records, 8);
  assert.equal(reopened.getProvider('synthetic-alpha')?.marker, 'synthetic-marker-v2');
  assert.equal(reopened.counts().messages, 11);
  assert.equal(reopened.recall({ provider: 'synthetic-alpha', keyword: 'refreshToken' }).total, 2);
  reopened.close();
  store.close();
});

test('tokenizer/ICU meta changes force a rebuild; real SQLite and FTS5 are used', async (t) => {
  const { root, store } = await harness(t);
  await ingestBaseline(store);
  assert.equal(store.supportsFts, true);
  store.close();

  const dbPath = HistoryStore.databasePath(root);
  const raw = new DatabaseSync(dbPath);
  const ftsRow = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'message_fts'").get() as { name?: string } | undefined;
  const versionRow = raw.prepare('SELECT sqlite_version() AS version').get() as { version: string };
  assert.equal(ftsRow?.name, 'message_fts');
  assert.match(versionRow.version, /^\d+\.\d+\.\d+$/);
  raw.prepare('UPDATE meta SET value = ? WHERE key = ?').run('0.0-test', 'icu');
  raw.close();

  const rebuilt = HistoryStore.open(root);
  t.after(() => rebuilt.close());
  assert.equal(rebuilt.wasRebuilt, true);
  assert.equal(rebuilt.counts().messages, 0);
  assert.equal(rebuilt.summary().environment.icu, process.versions.icu ?? 'unknown');
  rebuilt.close();
});

test('FTS configuration changes force a rebuild as well', async (t) => {
  const { root, store } = await harness(t);
  await ingestBaseline(store);
  store.close();
  const raw = new DatabaseSync(HistoryStore.databasePath(root));
  raw.prepare('UPDATE meta SET value = ? WHERE key = ?').run('fts5-unicode64-obsolete', 'fts_configuration');
  raw.close();

  const rebuilt = HistoryStore.open(root);
  t.after(() => rebuilt.close());
  assert.equal(rebuilt.wasRebuilt, true);
  assert.equal(rebuilt.counts().messages, 0);
  rebuilt.close();
});

test('provider isolation: one failing provider does not affect another', async (t) => {
  const { root, store } = await harness(t);
  await ingestBaseline(store);

  const missing = new SyntheticFixtureAdapter({ provider: 'synthetic-missing' });
  const failed = await ingestProvider(store, missing, join(root, 'does-not-exist'));
  assert.equal(failed.status, 'failed');
  assert.equal(store.getProvider('synthetic-missing')?.status, 'failed');
  assert.equal(store.recall({ provider: 'synthetic-alpha' }).total, 6);
  assert.equal(store.recall({ provider: 'synthetic-beta' }).total, 3);
  assert.equal(store.getProvider('synthetic-alpha')?.status, 'ok');

  const broken = await ingestProvider(store, new SyntheticFixtureAdapter({ provider: 'synthetic-broken' }), BROKEN_ROOT);
  assert.equal(broken.status, 'ok');
  assert.equal(store.counts().messages, 11);
});

test('memory notes require anchors and brief surfaces relevant or stale knowledge', async (t) => {
  const { root } = await harness(t);
  // Anchor source: the symbol used at note time is replaced by a renamed
  // symbol, but the original fragment remains in the file.
  const oldSymbol = { id: 'old-symbol-id', file: 'src/auth/session.ts', name: 'refreshToken', qualifiedName: 'refreshToken' };
  const newSymbol = { id: 'new-symbol-id', file: 'src/auth/session.ts', name: 'refreshTokenV2', qualifiedName: 'refreshTokenV2' };
  const fileContent = 'export function refreshTokenV2() { return 1; } // refreshToken history';
  const source = {
    findSymbolById: (id: string) => (id === newSymbol.id ? newSymbol : undefined),
    findSymbolByQualifiedName: (qualifiedName: string, file: string) => (qualifiedName === newSymbol.qualifiedName && file === newSymbol.file ? newSymbol : undefined),
    readFile: (file: string) => (file === 'src/auth/session.ts' ? fileContent : undefined),
  };

  assert.throws(() => validateMemoryNote({ kind: 'memory', text: 'no anchor' }), MemoryNoteError);
  assert.throws(() => validateMemoryNote({ kind: 'session_summary', text: 'summary', anchor: { file: 'src/a.ts' } }), MemoryNoteError);
  assert.throws(() => validateMemoryNote({ kind: 'memory', text: 'line number', anchor: { file: 'src/a.ts', symbolId: 'src/a.ts::x:12' } }), MemoryNoteError);
  assert.throws(() => validateMemoryNote({ kind: 'memory', text: 'absolute', anchor: { file: 'C:/a.ts' } }), MemoryNoteError);
  assert.throws(() => validateMemoryNote({ kind: 'memory', text: 'backslash', anchor: { file: 'src\\a.ts' } }), MemoryNoteError);

  const fragment: MemoryAnchor = {
    file: 'src/auth/session.ts',
    symbolId: oldSymbol.id,
    qualifiedName: oldSymbol.qualifiedName,
    contentFragment: 'refreshToken history',
  };
  const note = validateMemoryNote({ kind: 'decision', text: 'refreshToken must be renewed under a lease', anchor: fragment }, '2026-11-19T00:00:00.000Z');
  assert.equal(note.anchor?.contentFragmentHash?.length, 64);
  assert.equal(toLedgerNotePayload(note).note_id, note.id);

  const book = new MemoryNoteBook();
  const first = await book.record({ kind: 'decision', text: 'refreshToken must be renewed under a lease', anchor: fragment, createdAt: '2026-11-19T00:00:00.000Z' });
  const duplicate = await book.record({ kind: 'decision', text: 'refreshToken must be renewed under a lease', anchor: fragment, createdAt: '2026-11-19T00:00:00.000Z' });
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  await book.record({ kind: 'session_summary', text: 'Synthetic P4 session summary', createdAt: '2026-11-19T00:01:00.000Z' });
  const staleNote = await book.record({ kind: 'memory', text: 'missing file anchor', anchor: { file: 'src/missing.ts' }, createdAt: '2026-11-19T00:02:00.000Z' });

  const brief = buildMemoryBrief({
    notes: book.list(),
    anchorSource: source,
    touchedFiles: ['src/auth/session.ts'],
    exploredFiles: [],
    history: {
      ftsAvailable: true,
      rebuilt: false,
      providers: [],
      counts: { messages: 0, sessions: 0, units: 0, providers: 0, skippedArtifacts: 0, byVisibility: { visible: 0, inactive: 0, hidden: 0 } },
      skippedArtifacts: [],
    },
    now: '2026-11-19T00:03:00.000Z',
  });

  const anchored = brief.knowledge.relevant.find((entry) => entry.id === note.id);
  assert.ok(anchored, 'renamed symbol is relocated and surfaces in brief');
  assert.equal(anchored?.resolution?.status, 'relocated');
  assert.equal(anchored?.resolution?.level, 3);
  assert.ok(brief.knowledge.stale.some((entry) => entry.id === staleNote.note.id));
  assert.equal(brief.knowledge.counts.decision, 1);
  assert.equal(brief.knowledge.counts.session_summary, 1);
  assert.equal(brief.unexploredChanges.touched, 1);
  assert.deepEqual(brief.unexploredChanges.modifiedWithoutExplore, ['src/auth/session.ts']);
  assert.match(brief.unexploredChanges.warning ?? '', /without a structure query/);
  assert.equal(existsSync(join(root, 'src', 'auth', 'session.ts')), false);

  const fileSource = anchorSourceFromFileSystem(root);
  assert.equal(fileSource.readFile('src/auth/session.ts'), undefined);
});

test('exact symbol anchors resolve at level 1 and unknown files go stale', async (t) => {
  await harness(t); // owns temp cleanup
  const symbol = { id: 'stable-id', file: 'src/a.ts', name: 'a', qualifiedName: 'a' };
  const exact = {
    findSymbolById: () => symbol,
    findSymbolByQualifiedName: () => undefined,
    readFile: () => 'export const a = 1;',
  };
  const note = validateMemoryNote({ kind: 'memory', text: 'exact anchor', anchor: { file: 'src/a.ts', symbolId: 'stable-id', qualifiedName: 'a' } });
  const { resolveAnchor } = await import('../../src/memory/anchor.ts');
  const resolution = resolveAnchor(note.anchor!, exact);
  assert.equal(resolution.status, 'exact');
  assert.equal(resolution.level, 1);

  const skipped = resolveAnchor({ file: 'src/a.ts', symbolId: 'gone', qualifiedName: 'gone' }, {
    findSymbolById: () => undefined,
    findSymbolByQualifiedName: () => undefined,
    readFile: () => 'nothing',
  });
  assert.equal(skipped.status, 'stale');
  assert.equal(skipped.status === 'stale' ? skipped.reason : '', 'relocation-failed');
});

test('tokenizer follows the S1 decisions and the same function tokenizes both sides', () => {
  assert.deepEqual(splitIdentifier('XMLHttpRequest'), ['xml', 'http', 'request']);
  assert.deepEqual(splitIdentifier('parseHTMLString'), ['parse', 'html', 'string']);
  assert.deepEqual(splitIdentifier('utf8Decode'), ['utf', '8', 'decode']);
  assert.deepEqual(splitIdentifier('base64'), ['base', '64']);
  assert.deepEqual(splitIdentifier('refresh_token'), ['refresh', 'token']);
  assert.deepEqual(splitIdentifier('kebab-case'), ['kebab', 'case']);
  assert.deepEqual(splitIdentifier('a.b.c'), ['a', 'b', 'c']);
  assert.deepEqual(splitIdentifier('refreshToken'), ['refresh', 'token']);
  assert.deepEqual(splitIdentifier('HTTPServer'), ['http', 'server']);
  assert.deepEqual(splitIdentifier('OAuth2Token'), ['o', 'auth', '2', 'token']);
  assert.deepEqual(splitIdentifier('$scope'), ['scope']);
  assert.deepEqual(splitIdentifier('a1b2'), ['a', '1', 'b', '2']);
  assert.deepEqual(splitIdentifier(''), []);

  assert.equal(codePointLength('𠮷'), 1);
  assert.equal('𠮷'.length, 2);
  assert.equal(codePointLength('𠮷野家'), 3);
  assert.equal(planTextQuery('租约').mode, 'like');
  assert.equal(planTextQuery('租约').degraded, 'unigram-scan');
  assert.equal(planTextQuery('𠮷').mode, 'like');
  assert.equal(planTextQuery('数据库').mode, 'fts');
  assert.equal(planTextQuery('𠮷野家').mode, 'fts');
  assert.equal(planTextQuery('refreshToken').mode, 'fts');
  assert.equal(planTextQuery('token').mode, 'fts');
  assert.deepEqual(tokenizeText('调用refreshToken函数'), tokenizeText('调用refreshToken函数'));
  const tokens = tokenizeText('调用refreshToken函数');
  assert.ok(tokens.includes('refresh'));
  assert.ok(tokens.includes('token'));
  assert.ok(tokens.includes('refreshToken'));
});
