/**
 * T-153 shard B: reachable branches of `src/memory/probe-store-bitchain.ts`.
 *
 * The existing suite covers the happy path plus seven corruption families.
 * This file drives the remaining reader validation paths by writing a real
 * cache and applying targeted byte edits, repairing enclosing checksums where
 * the intent is to reach a deeper check. No Node internals are mocked.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Ledger } from '../../src/ledger/ledger.ts';
import type { LedgerEvent } from '../../src/ledger/event.ts';
import { replayLedger } from '../../src/ledger/replay.ts';
import { viewDigest, type ViewReplayEntry } from '../../src/ledger/views.ts';
import {
  BITCHAIN_BODY_HASH_OFFSET,
  BITCHAIN_HEADER_BYTES,
  BitChainFormatError,
  BitChainProbeStore,
  bitchainBodyHash,
  openProbeStoreWithFallback,
} from '../../src/memory/probe-store-bitchain.ts';
import { canonicalJson } from '../../src/ledger/event.ts';
import type { AnchorProbeSnapshot } from '../../src/memory/probe-contract.ts';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const AT = '2026-11-21T00:00:00.000Z';
const TEXT = 'M18B_UNIQUE_RECORD_TEXT';

interface Fixture {
  readonly root: string;
  readonly entries: readonly ViewReplayEntry[];
  readonly snapshot: AnchorProbeSnapshot;
  readonly disposables: Array<() => void>;
}

async function append(ledger: Ledger, kind: LedgerEvent['kind'], payload: Record<string, unknown>, idemKey: string): Promise<LedgerEvent> {
  const result = await ledger.append({ kind, payload }, idemKey);
  if (result.event === undefined) throw new Error(`append ${kind} produced no event`);
  return result.event;
}

async function buildFixture(t: TestContext, linked: boolean): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'm18b-bitchain-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  let tick = 1_000;
  const ledger = await Ledger.open(root, {
    sessionId: 'm18b-bitchain',
    clock: () => { tick += 1; return tick; },
  });
  try {
    if (linked) {
      const g1 = await append(ledger, 'memory.revised', {
        intent: 'revise',
        fact_key: 'local.storage.engine',
        record: { text: 'SQLite', kind: 'decision', anchor: { file: 'src/a.ts', symbolId: 'sym-a' } },
        supersedes: [],
        reason: 'genesis',
        effective_from: null,
        effective_to: null,
      }, 'bc-g1');
      const g2 = await append(ledger, 'memory.revised', {
        intent: 'revise',
        fact_key: 'local.storage.engine',
        record: { text: TEXT, kind: 'decision', anchor: { file: 'src/b.ts', symbolId: 'sym-b' } },
        supersedes: [g1.id],
        reason: 'add fts',
        effective_from: null,
        effective_to: null,
      }, 'bc-g2');
      await append(ledger, 'memory.related', {
        edge: 'depends_on',
        from_ref: g2.id,
        to_ref: g1.id,
        reason: 'engine feeds engine',
      }, 'bc-rel');
    } else {
      await append(ledger, 'note.recorded', {
        note_id: 'd'.repeat(64),
        kind: 'decision',
        text: TEXT,
        created_at: AT,
        anchor: { file: 'src/a.ts', symbolId: 'sym-a' },
      }, 'bc-note');
    }
    const entries = replayLedger(join(root, '.ano', 'ledger')).entries;
    return {
      root,
      entries,
      snapshot: {
        project_scope: 'fixture',
        ledger_digest: viewDigest(entries),
        graph_revision: HASH_B,
        source_fingerprint: HASH_C,
        connected_digest: null,
      },
      disposables: [],
    };
  } finally {
    ledger.close();
  }
}

interface Regions {
  readonly header: Buffer;
  readonly record: Buffer;
  readonly index: Buffer;
  readonly manifest: Buffer;
  readonly recordOffset: number;
  readonly indexOffset: number;
  readonly manifestOffset: number;
}

function regionsOf(file: Buffer): Regions {
  const recordOffset = Number(file.readBigUInt64LE(24));
  const recordLength = Number(file.readBigUInt64LE(32));
  const indexOffset = Number(file.readBigUInt64LE(40));
  const indexLength = Number(file.readBigUInt64LE(48));
  const manifestOffset = Number(file.readBigUInt64LE(56));
  const manifestLength = Number(file.readBigUInt64LE(64));
  return {
    header: file.subarray(0, BITCHAIN_HEADER_BYTES),
    record: file.subarray(recordOffset, recordOffset + recordLength),
    index: file.subarray(indexOffset, indexOffset + indexLength),
    manifest: file.subarray(manifestOffset, manifestOffset + manifestLength),
    recordOffset,
    indexOffset,
    manifestOffset,
  };
}

function repairBodyHash(file: Buffer): void {
  const regions = regionsOf(file);
  Buffer.from(bitchainBodyHash(regions.record, regions.index, regions.manifest), 'hex')
    .copy(file, BITCHAIN_BODY_HASH_OFFSET);
}

/** Recompute the segment payload digest after a payload byte edit. */
function repairSegmentHash(file: Buffer): void {
  const recordOffset = Number(file.readBigUInt64LE(24));
  const payloadLength = Number(file.readBigUInt64LE(recordOffset + 24));
  const payload = file.subarray(recordOffset + 64, recordOffset + 64 + payloadLength);
  createHash('sha256').update(payload).digest().copy(file, recordOffset + 32);
}

/** Re-hash the file body after any record-region byte edit. */
function repairRecordRegionEdits(file: Buffer): void {
  repairSegmentHash(file);
  repairManifestRegionHashes(file);
}

/** Recompute the manifest's region digests after an index or record edit. */
function repairManifestRegionHashes(file: Buffer): void {
  const regions = regionsOf(file);
  const manifest = JSON.parse(regions.manifest.toString('utf8')) as Record<string, unknown>;
  manifest.record_region_sha256 = createHash('sha256').update(regions.record).digest('hex');
  manifest.index_region_sha256 = createHash('sha256').update(regions.index).digest('hex');
  const repaired = Buffer.from(canonicalJson(manifest), 'utf8');
  assert.equal(repaired.length, regions.manifest.length, 'manifest repair must stay fixed-width');
  repaired.copy(file, regions.manifestOffset);
  repairBodyHash(file);
}

function repairIndexEdits(file: Buffer): void {
  const indexOffset = Number(file.readBigUInt64LE(40));
  const indexLength = Number(file.readBigUInt64LE(48));
  const region = file.subarray(indexOffset, indexOffset + indexLength);
  createHash('sha256').update(region.subarray(0, 48)).update(region.subarray(80)).digest().copy(file, indexOffset + 48);
  repairManifestRegionHashes(file);
}

async function writeCache(
  fixture: Fixture,
  options: { recordHeaderBytes?: 64 | 96 | 128; segmentBytes?: number } = {},
): Promise<string> {
  const path = BitChainProbeStore.databasePath(fixture.root);
  BitChainProbeStore.write(path, fixture.entries, fixture.snapshot, options);
  return path;
}

async function expectOpenCode(path: string, code: string): Promise<BitChainFormatError> {
  let thrown: unknown;
  try {
    const store = BitChainProbeStore.open(path);
    store.close();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof BitChainFormatError, `expected BitChainFormatError, got ${String(thrown)}`);
  assert.equal((thrown as BitChainFormatError).code, code, (thrown as BitChainFormatError).reason);
  return thrown as BitChainFormatError;
}

async function corruptedCase(
  t: TestContext,
  code: string,
  mutate: (file: Buffer) => void,
  options: { recordHeaderBytes?: 64 | 96 | 128; linked?: boolean } = {},
): Promise<void> {
  await t.test(code, async () => {
    const fixture = await buildFixture(t, options.linked === true);
    const path = await writeCache(fixture, { recordHeaderBytes: options.recordHeaderBytes ?? 128 });
    const file = readFileSync(path);
    mutate(file);
    await writeFile(path, file);
    await expectOpenCode(path, code);
  });
}

// ---------------------------------------------------------------------------
// File header validation
// ---------------------------------------------------------------------------

test('m18b bitchain rejects header endianness, record-size and bound violations', async (t) => {
  await corruptedCase(t, 'bad_endian', (file) => { file.writeUInt16LE(0x3412, 10); });
  await corruptedCase(t, 'bad_header', (file) => { file.writeUInt32LE(80, 12); });
  await corruptedCase(t, 'bad_bounds', (file) => { file.writeBigUInt64LE(BigInt(file.length), 32); });
  await corruptedCase(t, 'bad_bounds', (file) => { file.writeBigUInt64LE(1n << 53n, 72); }, { recordHeaderBytes: 64 });
  await corruptedCase(t, 'bad_header_hash', (file) => { file.writeUInt16LE(7, 80); });
});

test('m18b bitchain rejects malformed and semantically inconsistent manifests', async (t) => {
  await corruptedCase(t, 'bad_manifest', (file) => {
    const regions = regionsOf(file);
    file[regions.manifestOffset] = 0x58; // 'X': no longer valid JSON
    repairBodyHash(file);
  });
  await corruptedCase(t, 'bad_manifest', (file) => {
    const regions = regionsOf(file);
    file[regions.manifestOffset] = 0x5b; // '[': JSON array, not an object
    repairBodyHash(file);
  });
  await corruptedCase(t, 'bad_manifest', (file) => {
    const regions = regionsOf(file);
    const at = regions.manifest.indexOf(Buffer.from('anchorprobe.bitchain.v1', 'utf8'));
    assert.ok(at >= 0);
    file.write('anchorprobe.bitchain.vX', regions.manifestOffset + at, 'utf8');
    repairBodyHash(file);
  });
  await corruptedCase(t, 'bad_manifest', (file) => {
    const regions = regionsOf(file);
    const at = regions.manifest.indexOf(Buffer.from('"record_count":1', 'utf8'));
    assert.ok(at >= 0, 'single-record fixture carries record_count 1');
    file.write('"record_count":2', regions.manifestOffset + at, 'utf8');
    repairBodyHash(file);
  });
  await corruptedCase(t, 'bad_manifest', (file) => {
    const regions = regionsOf(file);
    const at = regions.manifest.indexOf(Buffer.from('"record_region_sha256":"', 'utf8'));
    assert.ok(at >= 0);
    const valueAt = regions.manifestOffset + at + '"record_region_sha256":"'.length + 1;
    file.write('0'.repeat(64), valueAt, 'utf8');
    repairBodyHash(file);
  });
  await corruptedCase(t, 'bad_manifest', (file) => {
    const regions = regionsOf(file);
    const at = regions.manifest.indexOf(Buffer.from('"snapshot_hash":"', 'utf8'));
    assert.ok(at >= 0);
    const valueAt = regions.manifestOffset + at + '"snapshot_hash":"'.length;
    file.write('0'.repeat(64), valueAt, 'utf8');
    repairBodyHash(file);
  });
  await corruptedCase(t, 'bad_manifest', (file) => {
    const regions = regionsOf(file);
    const at = regions.manifest.indexOf(Buffer.from('"source_digest":"', 'utf8'));
    assert.ok(at >= 0);
    const valueAt = regions.manifestOffset + at + '"source_digest":"'.length;
    file.write('z'.repeat(64), valueAt, 'utf8');
    repairBodyHash(file);
  });
});

// ---------------------------------------------------------------------------
// Segment and record validation
// ---------------------------------------------------------------------------

test('m18b bitchain rejects segment framing violations', async (t) => {
  await corruptedCase(t, 'bad_segment', (file) => { file.write('M18SEGMG', 128, 'ascii'); repairManifestRegionHashes(file); });
  await corruptedCase(t, 'bad_segment', (file) => { file.writeBigUInt64LE(1n, 128 + 8); repairManifestRegionHashes(file); });
  await corruptedCase(t, 'bad_segment', (file) => {
    const recordLength = Number(file.readBigUInt64LE(32));
    file.writeBigUInt64LE(BigInt(recordLength), 128 + 24); // payload exceeds the region
    repairManifestRegionHashes(file);
  });
});

test('m18b bitchain rejects structurally malformed record headers and tails', async (t) => {
  await corruptedCase(t, 'bad_record', (file) => {
    // Frame declares 100 bytes, below the 128-byte fixed header.
    file.writeUInt32LE(100, 128 + 64);
    repairRecordRegionEdits(file);
  }, { recordHeaderBytes: 128 });
  await corruptedCase(t, 'bad_record', (file) => {
    file.write(' '.repeat(32), 128 + 68, 'ascii'); // empty record_ref
    repairRecordRegionEdits(file);
  }, { recordHeaderBytes: 128 });
  await corruptedCase(t, 'bad_record', (file) => {
    file.write('z'.repeat(32), 128 + 68 + 32, 'ascii'); // non-hex stored content hash
    repairRecordRegionEdits(file);
  }, { recordHeaderBytes: 128 });
  await corruptedCase(t, 'bad_record', (file) => {
    file.writeUInt32LE(1, 128 + 68 + 72); // declared tail length disagrees
    repairRecordRegionEdits(file);
  }, { recordHeaderBytes: 128 });
});

test('m18b bitchain rejects record tails that contradict their fixed headers', async (t) => {
  await corruptedCase(t, 'bad_record', (file) => {
    const regions = regionsOf(file);
    const at = regions.record.indexOf(Buffer.from('"record_ref":"', 'utf8'));
    assert.ok(at >= 0);
    const absolute = regions.recordOffset + at + '"record_ref":"'.length;
    file[absolute] = file[absolute] === 0x30 ? 0x31 : 0x30;
    repairRecordRegionEdits(file);
  }, { recordHeaderBytes: 128 });
  await corruptedCase(t, 'bad_record', (file) => {
    const regions = regionsOf(file);
    const at = regions.record.indexOf(Buffer.from('"content_hash":"', 'utf8'));
    assert.ok(at >= 0);
    const valueAt = regions.recordOffset + at + '"content_hash":"'.length;
    file.write('0'.repeat(64), valueAt, 'utf8');
    repairRecordRegionEdits(file);
  }, { recordHeaderBytes: 128 });
  await corruptedCase(t, 'bad_record', (file) => {
    const regions = regionsOf(file);
    const at = regions.record.indexOf(Buffer.from('"recorded_at":"', 'utf8'));
    assert.ok(at >= 0);
    const valueAt = regions.recordOffset + at + '"recorded_at":"'.length;
    file.write('X'.repeat(24), valueAt, 'ascii');
    repairRecordRegionEdits(file);
  }, { recordHeaderBytes: 128 });
});

test('m18b bitchain rejects fast-header fields that disagree with the tail', async (t) => {
  const headerCases: Array<{ name: string; mutate: (file: Buffer) => void }> = [
    { name: 'status', mutate: (file) => { file[128 + 68 + 76] = (file[128 + 68 + 76] ?? 0) ^ 0x01; } },
    { name: 'eligibility', mutate: (file) => { file[128 + 68 + 77] = (file[128 + 68 + 77] ?? 0) ^ 0x01; } },
    { name: 'source kind', mutate: (file) => { file[128 + 68 + 78] = (file[128 + 68 + 78] ?? 0) ^ 0x01; } },
    { name: 'version', mutate: (file) => { file.writeUInt32LE(999, 128 + 68 + 80); } },
    { name: 'recorded_at', mutate: (file) => { file.writeBigInt64LE(0n, 128 + 68 + 84); } },
    { name: 'effective_from', mutate: (file) => { file.writeBigInt64LE(0n, 128 + 68 + 92); } },
    { name: 'effective_to', mutate: (file) => { file.writeBigInt64LE(0n, 128 + 68 + 100); } },
  ];
  for (const item of headerCases) {
    await corruptedCase(t, 'bad_record', (file) => {
      item.mutate(file);
      repairRecordRegionEdits(file);
    }, { recordHeaderBytes: 128 });
  }
});

// ---------------------------------------------------------------------------
// Index region validation
// ---------------------------------------------------------------------------

test('m18b bitchain rejects index region structure violations', async (t) => {
  await corruptedCase(t, 'bad_index', (file) => {
    const { indexOffset } = regionsOf(file);
    file.writeBigUInt64LE(0n, indexOffset + 28); // directory offset
    repairIndexEdits(file);
  });
  await corruptedCase(t, 'bad_index', (file) => {
    const { indexOffset } = regionsOf(file);
    file.writeBigUInt64LE(0n, indexOffset + 36); // adjacency offset
    repairIndexEdits(file);
  });
  await corruptedCase(t, 'bad_index', (file) => {
    const { indexOffset } = regionsOf(file);
    file.writeBigUInt64LE(1n, indexOffset + 20); // edge count beyond the region
    repairIndexEdits(file);
  });
  await corruptedCase(t, 'bad_index', (file) => {
    const { indexOffset } = regionsOf(file);
    file.write('z'.repeat(32), indexOffset + 80, 'ascii'); // breaks strict ref ordering
    repairIndexEdits(file);
  });
  await corruptedCase(t, 'bad_index', (file) => { const at = regionsOf(file).indexOffset; file.write('M18INDEX', at, 'ascii'); repairIndexEdits(file); });
  await corruptedCase(t, 'bad_index', (file) => { const at = regionsOf(file).indexOffset; file.writeUInt16LE(2, at + 8); repairIndexEdits(file); });
});

test('m18b bitchain rejects adjacency entries that cannot resolve', async (t) => {
  await corruptedCase(t, 'bad_edge', (file) => {
    const { indexOffset } = regionsOf(file);
    const adjacencyOffset = Number(file.readBigUInt64LE(indexOffset + 36));
    file.write('q'.repeat(32), indexOffset + adjacencyOffset + 32, 'ascii');
    repairIndexEdits(file);
  }, { linked: true });
  await corruptedCase(t, 'bad_edge', (file) => {
    const { indexOffset } = regionsOf(file);
    const adjacencyOffset = Number(file.readBigUInt64LE(indexOffset + 36));
    file.write(' '.repeat(32), indexOffset + adjacencyOffset + 32, 'ascii'); // empty endpoint
    repairIndexEdits(file);
  }, { linked: true });
});

// ---------------------------------------------------------------------------
// Deep record-tail and cross-region agreement checks
// ---------------------------------------------------------------------------

test('m18b bitchain rejects invalid tail JSON, malformed anchors and stale digests', async (t) => {
  await corruptedCase(t, 'bad_record', (file) => {
    // Tail JSON starts right after the 128-byte fixed record header.
    file[128 + 64 + 4 + 128] = 0x58; // 'X'
    repairRecordRegionEdits(file);
  }, { recordHeaderBytes: 128 });
  await corruptedCase(t, 'bad_record', (file) => {
    const regions = regionsOf(file);
    const anchorAt = regions.record.indexOf(Buffer.from('"anchor":', 'utf8'));
    assert.ok(anchorAt >= 0);
    const open = regions.record.indexOf(Buffer.from('{', 'utf8'), anchorAt);
    const close = regions.record.indexOf(Buffer.from('}', 'utf8'), open);
    assert.ok(open >= 0 && close > open);
    const absolute = regions.recordOffset + open;
    const width = close - open + 1;
    file.write('[' + ' '.repeat(width - 2) + ']', absolute, 'utf8');
    repairRecordRegionEdits(file);
  }, { recordHeaderBytes: 128 });
});

test('m18b bitchain rejects stored text whose digest no longer matches the tail', async (t) => {
  await corruptedCase(t, 'bad_record_hash', (file) => {
    const regions = regionsOf(file);
    const at = regions.record.indexOf(Buffer.from(TEXT, 'utf8'));
    assert.ok(at >= 0);
    const absolute = regions.recordOffset + at;
    file[absolute] = file[absolute] === 0x4d ? 0x4e : 0x4d; // M <-> N
    repairRecordRegionEdits(file);
  }, { recordHeaderBytes: 128 });
});

test('m18b bitchain rejects truncated record framing inside an otherwise valid segment', async (t) => {
  await corruptedCase(t, 'bad_record', (file) => {
    const payloadLength = Number(file.readBigUInt64LE(128 + 24));
    file.writeUInt32LE(payloadLength, 128 + 64); // declared record exceeds the payload
    repairRecordRegionEdits(file);
  }, { recordHeaderBytes: 128 });
});

test('m18b bitchain rejects a record count that disagrees with the parsed records', async (t) => {
  await corruptedCase(t, 'bad_index', (file) => {
    file.writeBigUInt64LE(2n, 72); // header record_count
    const regions = regionsOf(file);
    const manifest = JSON.parse(regions.manifest.toString('utf8')) as Record<string, unknown>;
    manifest.record_count = 2;
    manifest.header_hash = createHash('sha256')
      .update(file.subarray(0, BITCHAIN_BODY_HASH_OFFSET))
      .update(file.subarray(120, BITCHAIN_HEADER_BYTES))
      .digest('hex');
    const repaired = Buffer.from(canonicalJson(manifest), 'utf8');
    assert.equal(repaired.length, regions.manifest.length);
    repaired.copy(file, regions.manifestOffset);
    repairBodyHash(file);
  }, { recordHeaderBytes: 128 });
});

// ---------------------------------------------------------------------------
// Writer parameters and fallback behaviour
// ---------------------------------------------------------------------------

test('m18b bitchain writer rejects unsupported header and segment sizes', async (t) => {
  const fixture = await buildFixture(t, false);
  const path = BitChainProbeStore.databasePath(fixture.root);
  assert.throws(() => BitChainProbeStore.write(path, fixture.entries, fixture.snapshot, { recordHeaderBytes: 80 as 64 }), /unsupported recordHeaderBytes/u);
  assert.throws(() => BitChainProbeStore.write(path, fixture.entries, fixture.snapshot, { segmentBytes: 100 }), /unsupported segmentBytes/u);
});

test('m18b bitchain open-with-fallback creates a missing cache and exposes its identity', async (t) => {
  const fixture = await buildFixture(t, false);
  const path = BitChainProbeStore.databasePath(fixture.root);
  await rm(path, { force: true });
  const opened = openProbeStoreWithFallback(fixture.root, fixture.entries, fixture.snapshot);
  const openedStore = opened.store as BitChainProbeStore;
  try {
    assert.equal(opened.backend, 'bitchain');
    assert.equal(opened.fallbackReason, null);
    assert.equal(openedStore.recordCount, 1);
    assert.ok(openedStore.snapshotHash === BitChainProbeStore.open(path).snapshotHash);
    assert.equal(openedStore.segmentBytes, 65_536);
  } finally {
    openedStore.close();
  }
});

test('m18b bitchain falls back to SQLite on a corrupt cache and rebuilds a stale one', async (t) => {
  const fixture = await buildFixture(t, false);
  const path = await writeCache(fixture);
  const file = readFileSync(path);
  file.write('XNOBITC1', 0, 'ascii');
  await writeFile(path, file);

  const fallback = openProbeStoreWithFallback(fixture.root, fixture.entries, fixture.snapshot);
  assert.equal(fallback.backend, 'sqlite');
  assert.match(fallback.fallbackReason ?? '', /^bad_magic:/u);
  (fallback.store as unknown as { close(): void }).close();

  const fresh = BitChainProbeStore.open(await writeCache(fixture));
  assert.equal(fresh.isFresh(fixture.entries, fixture.snapshot), true);
  assert.equal(fresh.refresh(fixture.entries, { ...fixture.snapshot, ledger_digest: HASH_A }), 'rebuilt');
  fresh.close();
});
