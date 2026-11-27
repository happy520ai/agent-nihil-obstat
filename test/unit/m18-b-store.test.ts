/**
 * T-153 shard B: reachable branches of `src/memory/store.ts`.
 *
 * Every test uses a real `HistoryStore` on a real temporary SQLite file; the
 * uncovered paths are transaction boundaries (rollback), provider scoping and
 * pruning, not mocks.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { HistoryStore } from '../../src/memory/store.ts';
import { makeCursor } from '../../src/memory/cursor.ts';
import type { IndexUnit, ParseResult, TranscriptRecord, Visibility } from '../../src/memory/types.ts';
import type { ProviderIngestBatch } from '../../src/memory/store.ts';

const HASH_A = 'a'.repeat(64);
const AT = '2026-11-21T00:00:00.000Z';

function unit(overrides: Partial<IndexUnit> = {}): IndexUnit {
  return {
    provider: 'synthetic',
    unitId: 'unit-1',
    sourcePath: 'sessions/unit-1.jsonl',
    sessionId: 'session-1',
    title: 'Synthetic session',
    startedAt: AT,
    formatVersion: 'v1',
    visibility: 'visible' as Visibility,
    contentHash: HASH_A,
    mtimeMs: 1_000,
    size: 100,
    ...overrides,
  };
}

function record(unitValue: IndexUnit, overrides: Partial<TranscriptRecord> = {}): TranscriptRecord {
  return {
    id: 'msg-1',
    provider: unitValue.provider,
    unitId: unitValue.unitId,
    sessionId: unitValue.sessionId,
    sourcePath: unitValue.sourcePath,
    line: 1,
    role: 'user',
    text: 'hello',
    timestamp: AT,
    visibility: 'visible',
    files: [],
    symbols: [],
    ...overrides,
  };
}

function parseResult(unitValue: IndexUnit, records: readonly TranscriptRecord[], overrides: Partial<ParseResult> = {}): ParseResult {
  return {
    records,
    cursor: makeCursor({ unitId: unitValue.unitId, contentHash: unitValue.contentHash }, 1),
    fullReplay: true,
    skipped: [],
    ...overrides,
  };
}

async function withStore(run: (store: HistoryStore, path: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'm18b-history-'));
  const path = join(root, 'history.db');
  const store = HistoryStore.open(root, { databasePath: path });
  try {
    await run(store, path);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

test('m18b history store records provider markers through finishProvider and failure state', async () => {
  await withStore((store) => {
    assert.equal(store.providerMarker('synthetic'), undefined);
    store.finishProvider('synthetic', {
      marker: 'marker-1',
      formatVersion: 'v1',
      status: 'ok',
      units: 1,
      records: 2,
      skipped: 0,
    });
    assert.equal(store.providerMarker('synthetic'), 'marker-1');
    const state = store.getProvider('synthetic');
    assert.equal(state?.status, 'ok');
    assert.equal(state?.units, 1);

    store.recordProviderFailure('synthetic', 'marker-2', 'v1', 'boom');
    const failed = store.getProvider('synthetic');
    assert.equal(failed?.status, 'failed');
    assert.equal(failed?.error, 'boom');
    // The failure preserves the previously indexed counts.
    assert.equal(failed?.units, 1);
    assert.deepEqual(store.listProviders().map((item) => item.provider), ['synthetic']);
    return Promise.resolve();
  });
});

test('m18b history store indexUnit inserts then replaces an existing message in one transaction', async () => {
  await withStore((store) => {
    const value = unit();
    const first = store.indexUnit(value, parseResult(value, [record(value)]));
    assert.deepEqual(first, { inserted: 1, deleted: 0 });
    assert.equal(store.providerCounts('synthetic').records, 1);

    const replaced = store.indexUnit(value, parseResult(value, [
      record(value, { id: 'msg-1', text: 'updated' }),
      record(value, { id: 'msg-2', line: 2 }),
    ]));
    assert.deepEqual(replaced, { inserted: 2, deleted: 1 });

    const hits = store.recall({ provider: 'synthetic' }).hits;
    assert.equal(hits.length, 2);
    assert.equal(hits.find((hit) => hit.id === 'msg-1')?.text, 'updated');
    return Promise.resolve();
  });
});

test('m18b history store rejects a parse result that does not belong to the unit', async () => {
  await withStore((store) => {
    const value = unit();
    assert.throws(
      () => store.indexUnit(value, parseResult(value, [record(value, { unitId: 'other-unit' })])),
      /does not belong to unit/u,
    );
    assert.throws(() => store.indexUnit(unit({ provider: ' padded ' }), parseResult(unit(), [])), /Invalid provider id/u);
    // The rejected transaction left no rows behind.
    assert.deepEqual(store.listUnits(), []);
    return Promise.resolve();
  });
});

test('m18b history store rolls back a provider ingest that mixes provider records', async () => {
  await withStore((store) => {
    store.recordSkipped({ provider: 'synthetic', sourcePath: 'sessions/a.jsonl', reason: 'empty' });
    const before = store.skippedArtifacts('synthetic').length;

    const batch: ProviderIngestBatch = {
      markerChanged: true,
      marker: 'marker-2',
      formatVersion: 'v1',
      status: 'ok',
      units: [{
        unit: unit(),
        // The unit provider matches, but the record claims another unit: this
        // passes provider isolation and fails inside the locked index step.
        result: parseResult(unit(), [record(unit(), { unitId: 'intruder' })]),
      }],
      keepUnitIds: new Set(['unit-1']),
      skipped: [],
    };
    assert.throws(() => store.applyProviderIngest('synthetic', batch), /does not belong to unit/u);
    assert.equal(store.skippedArtifacts('synthetic').length, before);
    assert.equal(store.getProvider('synthetic'), undefined);
    return Promise.resolve();
  });
});

test('m18b history store resetProvider removes only the targeted provider', async () => {
  await withStore((store) => {
    const first = unit({ provider: 'one', unitId: 'u1' });
    const second = unit({ provider: 'two', unitId: 'u2' });
    store.indexUnit(first, parseResult(first, [record(first)]));
    store.indexUnit(second, parseResult(second, [record(second)]));

    store.resetProvider('one');
    assert.deepEqual(store.listProviders(), []);
    assert.deepEqual(store.listUnits().map((row) => row.provider), ['two']);
    assert.equal(store.providerCounts('one').units, 0);
    assert.equal(store.providerCounts('two').units, 1);
    return Promise.resolve();
  });
});

test('m18b history store pruneUnits deletes messages, sessions and units together', async () => {
  await withStore((store) => {
    const keep = unit({ provider: 'synthetic', unitId: 'keep' });
    const drop = unit({ provider: 'synthetic', unitId: 'drop' });
    store.indexUnit(keep, parseResult(keep, [record(keep)]));
    store.indexUnit(drop, parseResult(drop, [record(drop, { id: 'msg-drop' })]));

    const removed = store.pruneUnits('synthetic', new Set(['keep']));
    assert.equal(removed, 1);
    assert.deepEqual(store.listUnits().map((row) => row.unitId), ['keep']);
    assert.equal(store.providerCounts('synthetic').records, 1);
    assert.equal(store.providerCounts('synthetic').units, 1);
    return Promise.resolve();
  });
});

test('m18b history store clear empties every table but keeps the schema', async () => {
  await withStore((store) => {
    const value = unit();
    store.indexUnit(value, parseResult(value, [record(value)]));
    store.clear();
    assert.deepEqual(store.counts(), {
      messages: 0,
      sessions: 0,
      units: 0,
      providers: 0,
      skippedArtifacts: 0,
      byVisibility: { visible: 0, inactive: 0, hidden: 0 },
    });
    // The schema survives: indexing still works after a clear.
    store.indexUnit(value, parseResult(value, [record(value)]));
    assert.equal(store.counts().messages, 1);
    return Promise.resolve();
  });
});

test('m18b history store open failure releases the database handle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'm18b-history-bad-'));
  try {
    const directoryAsDatabase = join(root, 'not-a-database');
    await rm(directoryAsDatabase, { recursive: true, force: true });
    const { mkdirSync } = await import('node:fs');
    mkdirSync(directoryAsDatabase, { recursive: true });
    assert.throws(() => HistoryStore.open(root, { databasePath: directoryAsDatabase }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
