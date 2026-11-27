import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { LedgerEvent } from '../../src/ledger/event.ts';
import { canonicalJson } from '../../src/ledger/event.ts';
import { Ledger } from '../../src/ledger/ledger.ts';
import { replayLedger } from '../../src/ledger/replay.ts';
import { viewDigest, type ViewReplayEntry } from '../../src/ledger/views.ts';
import {
  ANCHOR_PROBE_REQUEST_SCHEMA_VERSION,
  type AnchorProbeRequest,
  type AnchorProbeSnapshot,
} from '../../src/memory/probe-contract.ts';
import { probe } from '../../src/memory/probe.ts';
import {
  ProjectedProbeStore,
  SqliteProbeStore,
  probeSnapshotIdentity,
  toProbeStore,
  type ProbeStore,
} from '../../src/memory/probe-store.ts';
import {
  BITCHAIN_BODY_HASH_OFFSET,
  BITCHAIN_HEADER_BYTES,
  BitChainFormatError,
  BitChainProbeStore,
  bitchainBodyHash,
  contentHashOfRecord,
  openProbeStoreWithFallback,
} from '../../src/memory/probe-store-bitchain.ts';

/**
 * T-059 / AP-22: BitChain experimental ProbeStore.
 *
 * The fixture is the same real committed ledger used by probe-store.test.ts, so
 * every assertion compares three backends over identical facts: the SQLite
 * baseline, the event-rebuilt projection, and the BitChain file.
 */

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const AT = '2026-11-21T00:00:00.000Z';
const ENGINE = 'local.storage.engine';
const RETENTION = 'local.retention.policy';
const FUTURE = 'local.future.plan';

interface Fixture {
  root: string;
  entries: readonly ViewReplayEntry[];
  snapshot: AnchorProbeSnapshot;
  /** Stores close before the temp root is removed (Windows file locks). */
  disposables: Array<() => void>;
  refs: { note: string; g1: string; g2: string; r1: string; f1: string };
}

async function append(
  ledger: Ledger,
  kind: LedgerEvent['kind'],
  payload: Record<string, unknown>,
  idemKey: string,
): Promise<LedgerEvent> {
  const result = await ledger.append({ kind, payload }, idemKey);
  if (result.event === undefined) throw new Error(`append ${kind} produced no event`);
  return result.event;
}

async function buildFixture(t: TestContext): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'ano-bitchain-'));
  const disposables: Array<() => void> = [];
  t.after(async () => {
    for (let index = disposables.length - 1; index >= 0; index -= 1) disposables[index]?.();
    await rm(root, { recursive: true, force: true });
  });

  let tick = 1000;
  const ledger = await Ledger.open(root, {
    sessionId: 'bitchain-test',
    clock: () => {
      tick += 1;
      return tick;
    },
  });
  try {
    const note = await append(ledger, 'note.recorded', {
      note_id: 'd'.repeat(64),
      kind: 'decision',
      text: 'Legacy lease decision',
      created_at: AT,
      anchor: { file: 'src/a.ts', symbolId: 'sym-a' },
    }, 'bc-note');

    const g1 = await append(ledger, 'memory.revised', {
      intent: 'revise',
      fact_key: ENGINE,
      record: { text: 'SQLite', kind: 'decision', anchor: { file: 'src/a.ts', symbolId: 'sym-a' } },
      supersedes: [],
      reason: 'genesis',
      effective_from: null,
      effective_to: null,
    }, 'bc-g1');
    const g2 = await append(ledger, 'memory.revised', {
      intent: 'revise',
      fact_key: ENGINE,
      record: { text: 'SQLite with FTS5', kind: 'decision', anchor: { file: 'src/a.ts', symbolId: 'sym-a' } },
      supersedes: [g1.id],
      reason: 'add fts',
      effective_from: null,
      effective_to: null,
    }, 'bc-g2');
    const r1 = await append(ledger, 'memory.revised', {
      intent: 'revise',
      fact_key: RETENTION,
      record: { text: 'Keep 30 days', kind: 'decision', anchor: { file: 'src/b.ts', symbolId: 'sym-b' } },
      supersedes: [],
      reason: 'genesis',
      effective_from: null,
      effective_to: null,
    }, 'bc-r1');
    await append(ledger, 'memory.related', {
      edge: 'depends_on',
      from_ref: g2.id,
      to_ref: r1.id,
      reason: 'engine feeds retention',
    }, 'bc-rel');
    await append(ledger, 'memory.revised', {
      intent: 'retract',
      fact_key: RETENTION,
      supersedes: [r1.id],
      reason: 'policy withdrawn',
    }, 'bc-retract');
    const f1 = await append(ledger, 'memory.revised', {
      intent: 'revise',
      fact_key: FUTURE,
      record: { text: 'Plan for 2027', kind: 'decision', anchor: { file: 'src/d.ts', symbolId: 'sym-d' } },
      supersedes: [],
      reason: 'future plan',
      // Deliberately without milliseconds: the fixed header stores the instant,
      // so a textual mismatch must not be reported as corruption.
      effective_from: '2027-01-01T00:00:00Z',
      effective_to: null,
    }, 'bc-f1');

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
      disposables,
      refs: { note: note.id, g1: g1.id, g2: g2.id, r1: r1.id, f1: f1.id },
    };
  } finally {
    ledger.close();
  }
}

function request(fixture: Fixture, overrides: Partial<AnchorProbeRequest> = {}): AnchorProbeRequest {
  return {
    schema_version: ANCHOR_PROBE_REQUEST_SCHEMA_VERSION,
    request_id: 'req-bc-1',
    root: fixture.root,
    project_scope: 'fixture',
    temporal_mode: 'CURRENT',
    ...overrides,
  } as AnchorProbeRequest;
}

function openSqlite(fixture: Fixture): SqliteProbeStore {
  const store = SqliteProbeStore.open(fixture.root);
  fixture.disposables.push(() => store.close());
  store.rebuild(fixture.entries, fixture.snapshot);
  return store;
}

function openProjected(fixture: Fixture): ProjectedProbeStore {
  const store = ProjectedProbeStore.create(fixture.entries, fixture.snapshot);
  fixture.disposables.push(() => store.close());
  return store;
}

function writeBitChain(fixture: Fixture, options?: { recordHeaderBytes?: 64 | 96 | 128; segmentBytes?: number }): BitChainProbeStore {
  const path = BitChainProbeStore.databasePath(fixture.root);
  BitChainProbeStore.write(path, fixture.entries, fixture.snapshot, options);
  const store = BitChainProbeStore.open(path);
  fixture.disposables.push(() => store.close());
  return store;
}

function readStoreFile(fixture: Fixture): Buffer {
  return readFileSync(BitChainProbeStore.databasePath(fixture.root));
}

interface Regions {
  header: Buffer;
  record: Buffer;
  index: Buffer;
  manifest: Buffer;
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
  };
}

function recomputeBodyHash(file: Buffer): void {
  const regions = regionsOf(file);
  Buffer.from(bitchainBodyHash(regions.record, regions.index, regions.manifest), 'hex')
    .copy(file, BITCHAIN_BODY_HASH_OFFSET);
}

function recomputeSegmentHash(file: Buffer): void {
  const recordOffset = Number(file.readBigUInt64LE(24));
  const payloadLength = Number(file.readBigUInt64LE(recordOffset + 24));
  const payload = file.subarray(recordOffset + 64, recordOffset + 64 + payloadLength);
  createHash('sha256').update(payload).digest().copy(file, recordOffset + 32);
}

/**
 * Refresh the manifest's per-region hashes after a region byte was changed, so
 * the reader passes the file-level checks and reaches the deeper segment/index/
 * record checks. The digest fields are fixed-width hex, so the manifest length
 * (and therefore header_hash) is unchanged.
 */
function repairManifestRegionHashes(file: Buffer): void {
  const regions = regionsOf(file);
  const manifestOffset = regions.header.length + regions.record.length + regions.index.length;
  const manifest = JSON.parse(regions.manifest.toString('utf8')) as Record<string, unknown>;
  manifest.record_region_sha256 = createHash('sha256').update(regions.record).digest('hex');
  manifest.index_region_sha256 = createHash('sha256').update(regions.index).digest('hex');
  const repaired = Buffer.from(canonicalJson(manifest), 'utf8');
  assert.equal(repaired.length, regions.manifest.length);
  repaired.copy(file, manifestOffset);
  recomputeBodyHash(file);
}

test('BitChain matches SQLite and projection across every ProbeStore query family', async (t) => {
  const fixture = await buildFixture(t);
  const bitchain = writeBitChain(fixture);
  const sqlite = openSqlite(fixture);
  const projected = openProjected(fixture);

  assert.ok(toProbeStore(bitchain) === bitchain);
  assert.equal(bitchain.recordCount, 5);
  assert.equal(bitchain.edgeCount, 1);

  assert.deepEqual(bitchain.candidates(), sqlite.candidates());
  assert.deepEqual(bitchain.candidates(), projected.candidates());
  assert.deepEqual(bitchain.adjacency(), sqlite.adjacency());
  assert.deepEqual(bitchain.adjacency(), projected.adjacency());
  assert.deepEqual(bitchain.adjacency(fixture.refs.g2), sqlite.adjacency(fixture.refs.g2));
  assert.deepEqual(bitchain.adjacency(fixture.refs.r1), sqlite.adjacency(fixture.refs.r1));
  assert.deepEqual(bitchain.adjacency(fixture.refs.g1), sqlite.adjacency(fixture.refs.g1));
  // adjacency is bidirectional: filtering by the target still reports the edge.
  assert.ok(bitchain.adjacency(fixture.refs.r1).some((edge) => edge.from === fixture.refs.g2 && edge.to === fixture.refs.r1));

  for (const ref of [fixture.refs.note, fixture.refs.g1, fixture.refs.g2, fixture.refs.r1, fixture.refs.f1]) {
    assert.deepEqual(bitchain.evidence(ref), sqlite.evidence(ref));
    assert.deepEqual(bitchain.status(ref), sqlite.status(ref));
    assert.deepEqual(bitchain.provenance(ref), sqlite.provenance(ref));
  }
  for (const backend of [bitchain, sqlite, projected]) {
    assert.equal(backend.evidence('missing-ref'), undefined);
    assert.equal(backend.status('missing-ref'), undefined);
    assert.equal(backend.provenance('missing-ref'), undefined);
  }

  assert.deepEqual(bitchain.snapshotIdentity(), probeSnapshotIdentity(fixture.snapshot));
  assert.equal(bitchain.snapshotIdentity().fingerprint, sqlite.snapshotIdentity().fingerprint);
  assert.equal(bitchain.snapshotIdentity().graph_revision, HASH_B);

  const requests: AnchorProbeRequest[] = [
    request(fixture, { required_facts: [ENGINE] }),
    request(fixture, { required_facts: [ENGINE, RETENTION] }),
    request(fixture, { required_facts: [RETENTION] }),
    request(fixture, { required_facts: [FUTURE] }),
    request(fixture, { required_facts: ['local.absent.fact'] }),
    request(fixture, { request_id: 'req-bc-broad' }),
    request(fixture, {
      required_facts: [ENGINE],
      budget: { max_candidates: 1, max_nodes: 12, max_depth: 3 },
    }),
  ];
  for (const current of requests) {
    const fromBitChain = probe(current, bitchain, { now: AT });
    const fromSqlite = probe(current, sqlite, { now: AT });
    const fromProjection = probe(current, projected, { now: AT });
    assert.deepEqual(fromBitChain, fromSqlite);
    assert.deepEqual(fromBitChain, fromProjection);
  }

  // P0-P3 semantics travel with the backend: the current revision is active,
  // the prior one is a tombstone, the retracted record is a tombstone, and a
  // not-yet-effective fact is out of scope.
  const routed = probe(request(fixture, { required_facts: [ENGINE, RETENTION] }), bitchain, { now: AT });
  assert.equal(routed.execution_status, 'OK');
  // RETENTION is retracted, so it is a declared gap rather than a current fact.
  assert.equal(routed.coverage_gate.status, 'INSUFFICIENT');
  assert.deepEqual(routed.coverage_gate.missing_facts, [RETENTION]);
  assert.deepEqual(routed.active_evidence.map((item) => item.record_ref), [fixture.refs.g2]);
  assert.deepEqual(
    routed.deprecated_tombstones.map((item) => item.record_ref).sort(),
    [fixture.refs.g1, fixture.refs.r1].sort(),
  );
  const engineOnly = probe(request(fixture, { required_facts: [ENGINE] }), bitchain, { now: AT });
  assert.equal(engineOnly.coverage_gate.status, 'SUFFICIENT');
  const notYet = probe(request(fixture, { required_facts: [FUTURE] }), bitchain, { now: AT });
  assert.deepEqual(notYet.gaps, [{ fact_key: FUTURE, reason: 'out_of_scope' }]);
});

test('the record region stores the original text and is a pure function of committed entries', async (t) => {
  const fixture = await buildFixture(t);
  const path = BitChainProbeStore.databasePath(fixture.root);
  const first = BitChainProbeStore.write(path, fixture.entries, fixture.snapshot, { segmentBytes: 1024 });
  const firstFile = readStoreFile(fixture);
  const firstRegions = regionsOf(firstFile);

  // The原文 lives in the record region, not only in a digest; the mutable
  // index region carries refs and hashes but no content.
  assert.ok(firstRegions.record.includes(Buffer.from('SQLite with FTS5', 'utf8')));
  assert.ok(firstRegions.record.includes(Buffer.from('Keep 30 days', 'utf8')));
  assert.equal(firstRegions.index.includes(Buffer.from('SQLite with FTS5', 'utf8')), false);
  assert.equal(firstRegions.index.includes(Buffer.from('Keep 30 days', 'utf8')), false);
  assert.equal(firstRegions.manifest.includes(Buffer.from('SQLite with FTS5', 'utf8')), false);

  const candidate = BitChainProbeStore.open(path).candidates().find((item) => item.record_ref === fixture.refs.g2);
  assert.ok(candidate);
  assert.equal(
    contentHashOfRecord({ kind: 'decision', text: 'SQLite with FTS5', anchor: { file: 'src/a.ts', symbolId: 'sym-a' } }),
    candidate.content_hash,
  );
  assert.equal(first.recordRegionSha256, createHash('sha256').update(firstRegions.record).digest('hex'));

  // Rewriting the same committed log reproduces the identical record region
  // byte for byte: records are never patched in place.
  const second = BitChainProbeStore.write(path, fixture.entries, fixture.snapshot, { segmentBytes: 1024 });
  const secondRegions = regionsOf(readStoreFile(fixture));
  assert.deepEqual(secondRegions.record, firstRegions.record);
  assert.equal(second.recordRegionSha256, first.recordRegionSha256);
  assert.equal(second.indexRegionSha256, first.indexRegionSha256);

  // A new committed record changes the record region but leaves the earlier
  // record bytes intact at the front of the append-only region.
  const ledger = await Ledger.open(fixture.root, { sessionId: 'bitchain-test-2', clock: () => 2000 });
  try {
    await append(ledger, 'memory.revised', {
      intent: 'revise',
      fact_key: 'local.late.fact',
      record: { text: 'Late fact', kind: 'decision', anchor: { file: 'src/late.ts', symbolId: 'sym-late' } },
      supersedes: [],
      reason: 'late',
      effective_from: null,
      effective_to: null,
    }, 'bc-late');
  } finally {
    ledger.close();
  }
  const lateEntries = replayLedger(join(fixture.root, '.ano', 'ledger')).entries;
  const lateSnapshot = { ...fixture.snapshot, ledger_digest: viewDigest(lateEntries) };
  const firstSegmentLength = 64 + Number(firstRegions.record.readBigUInt64LE(24));
  assert.ok(firstSegmentLength < firstRegions.record.length, 'expected the small-segment fixture to span several segments');
  BitChainProbeStore.write(path, lateEntries, lateSnapshot, { segmentBytes: 1024 });
  const lateRegions = regionsOf(readStoreFile(fixture));
  assert.equal(lateRegions.record.length > firstRegions.record.length, true);
  // The already-full leading segment is byte-identical: records are appended,
  // never rewritten.
  assert.deepEqual(lateRegions.record.subarray(0, firstSegmentLength), firstRegions.record.subarray(0, firstSegmentLength));
  const lateStore = BitChainProbeStore.open(path);
  fixture.disposables.push(() => lateStore.close());
  assert.equal(lateStore.recordCount, 6);
  assert.ok(lateStore.isFresh(lateEntries, lateSnapshot));
  assert.equal(lateStore.isFresh(fixture.entries, fixture.snapshot), false);
});

test('segment continuation keeps the directory index precise', async (t) => {
  const fixture = await buildFixture(t);
  const path = BitChainProbeStore.databasePath(fixture.root);
  // A small segment capacity forces several segments and therefore exercises
  // the continue-in-a-new-segment path plus exact per-record locations.
  const written = BitChainProbeStore.write(path, fixture.entries, fixture.snapshot, { segmentBytes: 1024 });
  assert.equal(written.recordCount, 5);
  const file = readStoreFile(fixture);
  const regions = regionsOf(file);
  let segments = 0;
  let offset = 0;
  while (offset < regions.record.length) {
    assert.equal(regions.record.subarray(offset, offset + 8).toString('ascii'), 'ANORSEG1');
    segments += 1;
    const payloadLength = Number(regions.record.readBigUInt64LE(offset + 24));
    offset += 64 + payloadLength;
  }
  assert.ok(segments > 1, `expected several segments, saw ${String(segments)}`);

  const store = BitChainProbeStore.open(path);
  fixture.disposables.push(() => store.close());
  const sqlite = openSqlite(fixture);
  assert.deepEqual(store.candidates(), sqlite.candidates());
  assert.deepEqual(store.adjacency(), sqlite.adjacency());
  for (const ref of [fixture.refs.g2, fixture.refs.r1, fixture.refs.f1]) {
    assert.deepEqual(store.evidence(ref), sqlite.evidence(ref));
  }
});

test('record header sizes 64, 96 and 128 are all readable and equivalent', async (t) => {
  const fixture = await buildFixture(t);
  const sqlite = openSqlite(fixture);
  for (const headerBytes of [64, 96, 128] as const) {
    const path = join(fixture.root, `.ano/cache/probe-store-h${String(headerBytes)}.bitchain`);
    BitChainProbeStore.write(path, fixture.entries, fixture.snapshot, { recordHeaderBytes: headerBytes });
    const store = BitChainProbeStore.open(path);
    fixture.disposables.push(() => store.close());
    assert.equal(store.recordHeaderBytes, headerBytes);
    assert.deepEqual(store.candidates(), sqlite.candidates());
    assert.deepEqual(store.adjacency(), sqlite.adjacency());
    assert.deepEqual(store.snapshotIdentity(), sqlite.snapshotIdentity());
    assert.deepEqual(
      probe(request(fixture, { required_facts: [ENGINE, RETENTION] }), store, { now: AT }),
      probe(request(fixture, { required_facts: [ENGINE, RETENTION] }), sqlite, { now: AT }),
    );
  }
});

test('dropping the BitChain cache and rebuilding from committed events reproduces the answers', async (t) => {
  const fixture = await buildFixture(t);
  const path = BitChainProbeStore.databasePath(fixture.root);
  const first = writeBitChain(fixture);
  const baseline = probe(request(fixture, { required_facts: [ENGINE, RETENTION, FUTURE] }), first, { now: AT });
  const baselineCandidates = first.candidates();
  first.close();

  await rm(path, { force: true });
  const second = writeBitChain(fixture);
  assert.deepEqual(second.candidates(), baselineCandidates);
  assert.deepEqual(
    probe(request(fixture, { required_facts: [ENGINE, RETENTION, FUTURE] }), second, { now: AT }),
    baseline,
  );
});

test('the cache is bound to the committed source digest and the sampled snapshot', async (t) => {
  const fixture = await buildFixture(t);
  const store = writeBitChain(fixture);
  assert.equal(store.isFresh(fixture.entries, fixture.snapshot), true);
  assert.equal(store.isFresh([], fixture.snapshot), false);
  assert.equal(store.isFresh(fixture.entries, { ...fixture.snapshot, graph_revision: HASH_A }), false);
  assert.equal(store.sourceDigest, viewDigest(fixture.entries));
  assert.equal(store.snapshotIdentity().fingerprint, probeSnapshotIdentity(fixture.snapshot).fingerprint);

  // A stale but intact file is rebuilt from the ledger, not answered from.
  const stale = { ...fixture.snapshot, ledger_digest: HASH_A };
  assert.equal(store.refresh(fixture.entries, stale), 'rebuilt');
  assert.equal(store.snapshotIdentity().fingerprint, probeSnapshotIdentity(stale).fingerprint);
  assert.equal(store.isFresh(fixture.entries, stale), true);

  // A missing file is rebuilt too; the helper reports which backend answered.
  store.close();
  await rm(BitChainProbeStore.databasePath(fixture.root), { force: true });
  const reopened = openProbeStoreWithFallback(fixture.root, fixture.entries, fixture.snapshot);
  assert.equal(reopened.backend, 'bitchain');
  assert.equal(reopened.fallbackReason, null);
  assert.deepEqual(reopened.store.candidates(), writeBitChainCandidates(fixture));
});

function writeBitChainCandidates(fixture: Fixture) {
  const path = join(fixture.root, '.ano/cache/reference.bitchain');
  BitChainProbeStore.write(path, fixture.entries, fixture.snapshot);
  const store = BitChainProbeStore.open(path);
  fixture.disposables.push(() => store.close());
  return store.candidates();
}

test('corruption fails closed with an explicit reason and falls back to SQLite', async (t) => {
  const fixture = await buildFixture(t);
  const path = BitChainProbeStore.databasePath(fixture.root);
  const sqlite = openSqlite(fixture);
  const baseline = probe(request(fixture, { required_facts: [ENGINE, RETENTION] }), sqlite, { now: AT });
  const baselineCandidates = sqlite.candidates();

  const cases: Array<{ name: string; code: string; mutate: (file: Buffer) => void }> = [
    {
      name: 'wrong magic',
      code: 'bad_magic',
      mutate: (file) => { file.write('XNOBITC1', 0, 'ascii'); },
    },
    {
      name: 'wrong version',
      code: 'bad_version',
      mutate: (file) => { file.writeUInt16LE(999, 8); },
    },
    {
      name: 'truncated header',
      code: 'truncated',
      mutate: (file) => { file.subarray(0, 100).copy(file); },
    },
    {
      name: 'flipped manifest byte',
      code: 'bad_body_hash',
      mutate: (file) => {
        const regions = regionsOf(file);
        const at = regions.manifest.indexOf(Buffer.from(viewDigest(fixture.entries), 'utf8'));
        assert.ok(at >= 0, 'source digest should appear in the manifest');
        const absolute = regions.header.length + regions.record.length + regions.index.length + at;
        file[absolute] = file[absolute]! === 0x61 ? 0x62 : 0x61;
      },
    },
    {
      name: 'flipped record byte',
      code: 'bad_segment_hash',
      mutate: (file) => {
        const regions = regionsOf(file);
        const at = regions.record.indexOf(Buffer.from('SQLite with FTS5', 'utf8'));
        assert.ok(at >= 0);
        const absolute = regions.header.length + at;
        file[absolute] = file[absolute]! === 0x53 ? 0x54 : 0x53;
        repairManifestRegionHashes(file);
      },
    },
    {
      name: 'flipped index hash',
      code: 'bad_index_hash',
      mutate: (file) => {
        const regions = regionsOf(file);
        const absolute = regions.header.length + regions.record.length + 48;
        file[absolute] = file[absolute]! ^ 0x01;
        repairManifestRegionHashes(file);
      },
    },
    {
      name: 'tampered content with enclosing checksums repaired',
      code: 'bad_record_hash',
      mutate: (file) => {
        const regions = regionsOf(file);
        const at = regions.record.indexOf(Buffer.from('SQLite with FTS5', 'utf8'));
        assert.ok(at >= 0);
        const absolute = regions.header.length + at;
        file[absolute] = file[absolute]! === 0x53 ? 0x54 : 0x53;
        recomputeSegmentHash(file);
        repairManifestRegionHashes(file);
      },
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      BitChainProbeStore.write(path, fixture.entries, fixture.snapshot);
      const file = readStoreFile(fixture);
      if (item.name === 'truncated header') {
        await writeFile(path, file.subarray(0, 100));
      } else {
        item.mutate(file);
        await writeFile(path, file);
      }

      let thrown: unknown;
      try {
        BitChainProbeStore.open(path);
      } catch (error) {
        thrown = error;
      }
      assert.ok(thrown instanceof BitChainFormatError, `expected BitChainFormatError, got ${String(thrown)}`);
      assert.equal((thrown as BitChainFormatError).code, item.code);

      // The corruption is reported explicitly and the SQLite baseline answers
      // the same request with the same facts; nothing is silently hidden.
      const fallback = openProbeStoreWithFallback(fixture.root, fixture.entries, fixture.snapshot);
      assert.equal(fallback.backend, 'sqlite');
      assert.match(fallback.fallbackReason ?? '', new RegExp(`^${item.code}:`));
      assert.deepEqual(fallback.store.candidates(), baselineCandidates);
      assert.deepEqual(probe(request(fixture, { required_facts: [ENGINE, RETENTION] }), fallback.store, { now: AT }), baseline);
      (fallback.store as SqliteProbeStore).close();
    });
  }
});

test('an empty committed log produces a valid empty BitChain cache', async (t) => {
  const fixture = await buildFixture(t);
  const path = join(fixture.root, '.ano/cache/empty.bitchain');
  const snapshot: AnchorProbeSnapshot = {
    project_scope: 'fixture',
    ledger_digest: '0'.repeat(64),
    graph_revision: null,
    source_fingerprint: null,
    connected_digest: null,
  };
  const written = BitChainProbeStore.write(path, [], snapshot);
  assert.equal(written.recordCount, 0);
  assert.equal(written.edgeCount, 0);
  const store = BitChainProbeStore.open(path);
  fixture.disposables.push(() => store.close());
  assert.deepEqual(store.candidates(), []);
  assert.deepEqual(store.adjacency(), []);
  assert.equal(store.evidence('anything'), undefined);
  assert.equal(store.isFresh([], snapshot), true);
});
