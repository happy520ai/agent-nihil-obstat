import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { canonicalJson } from '../../src/ledger/event.ts';
import {
  PROBE_MANIFEST_SCHEMA_VERSION,
  ProbeManifestCapacityError,
  ProbeManifestConflictError,
  ProbeManifestError,
  ProbeManifestStore,
  frozenProbeManifestSchema,
  probeManifestClusterSchema,
  type FrozenProbeManifest,
} from '../../src/memory/probe-manifest.ts';

// Fixtures follow the AP-02 contract (probe-contract.ts): a minimal valid
// CURRENT probe run with one active evidence alias, one tombstone, one declared
// and missing fact. Identity fields are literals so digest/byte expectations in
// the capacity tests stay deterministic (same-length ids and root paths keep
// serialized manifests byte-identical).

const CONTEXT_A = `ctx-${'a'.repeat(32)}`;
const CONTEXT_B = `ctx-${'b'.repeat(32)}`;
const CONTEXT_C = `ctx-${'c'.repeat(32)}`;
const CONTEXT_MISSING = `ctx-${'f'.repeat(32)}`;
const LEDGER_DIGEST = '1'.repeat(64);
const EVIDENCE_HASH = '2'.repeat(64);
const TOMBSTONE_HASH = '3'.repeat(64);
const T0 = '2026-11-21T00:00:00.000Z';

function probeRequest(root: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 'anchorprobe.request.v1',
    request_id: 'req-1',
    root,
    project_scope: 'scope-a',
    required_facts: ['fact.one'],
    temporal_mode: 'CURRENT',
    ...overrides,
  };
}

function probeResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 'anchorprobe.context.v1',
    request_id: 'req-1',
    context_id: CONTEXT_A,
    snapshot: {
      project_scope: 'scope-a',
      ledger_digest: LEDGER_DIGEST,
      graph_revision: null,
      source_fingerprint: null,
      connected_digest: null,
    },
    execution_status: 'OK',
    temporal_mode: 'CURRENT',
    budget_status: {
      stop_reason: 'FRONTIER_EXHAUSTED',
      retrieval_completeness: 'COMPLETE_WITHIN_DECLARED_SCOPE',
      nodes_visited: 1,
      frontier_remaining: 0,
    },
    coverage_gate: {
      status: 'INSUFFICIENT',
      required_facts: ['fact.one'],
      missing_facts: ['fact.one'],
      unresolved_conflicts: [],
      requirements_origin: 'caller_declared',
    },
    l1_invariants: [],
    active_evidence: [{
      ref: 'E1',
      record_ref: 'record-1',
      content_hash: EVIDENCE_HASH,
      status: 'active',
      source_health: 'verified_at_snapshot',
      recorded_at: '2026-11-20T00:00:00.000Z',
      effective_from: null,
      source: { kind: 'native_note' },
      content: 'approved fact text',
    }],
    deprecated_tombstones: [{
      ref: 'T1',
      record_ref: 'record-0',
      content_hash: TOMBSTONE_HASH,
      status: 'superseded',
      superseded_by: 'record-1',
      recorded_at: '2026-11-19T00:00:00.000Z',
    }],
    gaps: [{ fact_key: 'fact.one', reason: 'missing' }],
    conflicts: [],
    untrusted: true,
    ...overrides,
  };
}

async function makeRoot(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

function freezeOk(store: ProbeManifestStore, contextId: string, now: string) {
  return store.freeze({ request: probeRequest(store.root), response: probeResponse({ context_id: contextId }), now });
}

function tamperEvidence(file: string, extraText: string): void {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { response: { active_evidence: Array<{ content: string }> } };
  parsed.response.active_evidence[0]!.content += extraText;
  writeFileSync(file, JSON.stringify(parsed, null, 2), 'utf8');
}

test('probe manifest lifecycle', async (t) => {
  await t.test('freeze writes a digest-bound manifest with reference map, rules, freshness and evidence text', async () => {
    const root = await makeRoot('probe-manifest-freeze-');
    const store = new ProbeManifestStore({ root });
    const result = freezeOk(store, CONTEXT_A, T0);
    assert.equal(result.duplicate, false);
    assert.deepEqual(result.evicted, []);

    const file = join(root, '.ano', 'memory', 'probes', `${CONTEXT_A}.json`);
    assert.ok(existsSync(file));
    assert.equal(result.bytes, Buffer.byteLength(readFileSync(file, 'utf8'), 'utf8'));

    const verdict = store.read(CONTEXT_A, 'scope-a', { now: T0 });
    assert.equal(verdict.status, 'ok');
    if (verdict.status !== 'ok') return;
    const manifest: FrozenProbeManifest = verdict.manifest;
    assert.equal(verdict.age_ms, 0);

    // Envelope: version, scope binding, digest.
    assert.equal(manifest.schema_version, PROBE_MANIFEST_SCHEMA_VERSION);
    assert.equal(manifest.context_id, CONTEXT_A);
    assert.deepEqual(manifest.binding, { project_scope: 'scope-a', root });
    assert.match(manifest.body_digest, /^[a-f0-9]{64}$/u);

    // Reference mapping: every alias resolves to record_ref/content_hash.
    assert.deepEqual(manifest.reference_map.entries, [
      { ref: 'E1', kind: 'active_evidence', record_ref: 'record-1', content_hash: EVIDENCE_HASH, status: 'active', superseded_by: null },
      { ref: 'T1', kind: 'deprecated_tombstone', record_ref: 'record-0', content_hash: TOMBSTONE_HASH, status: 'superseded', superseded_by: 'record-1' },
    ]);
    assert.deepEqual(manifest.reference_map.conflicts, []);
    assert.deepEqual(manifest.reference_map.unresolved_conflict_ids, []);

    // Rules frozen from the request + coverage verdict.
    assert.deepEqual(manifest.rules, {
      request_id: 'req-1',
      required_facts: ['fact.one'],
      temporal_mode: 'CURRENT',
      as_of: null,
      budget: { max_candidates: 16, max_nodes: 12, max_depth: 3 },
      coverage_status: 'INSUFFICIENT',
      coverage_requirements_origin: 'caller_declared',
    });

    // Freshness: snapshot verbatim + per-source health counts.
    assert.equal(manifest.freshness.ledger_digest, LEDGER_DIGEST);
    assert.equal(manifest.freshness.frozen_at, T0);
    assert.equal(manifest.freshness.verified_sources, 1);
    assert.equal(manifest.freshness.stale_sources, 0);
    assert.equal(manifest.freshness.unknown_sources, 0);

    // Evidence text frozen verbatim.
    assert.equal(manifest.response.active_evidence[0]!.content, 'approved fact text');

    // The body digest recomputes independently over the canonical body.
    const { body_digest: storedDigest, ...body } = JSON.parse(readFileSync(file, 'utf8')) as FrozenProbeManifest;
    assert.equal(createHash('sha256').update(canonicalJson(body)).digest('hex'), storedDigest);
    assert.equal(storedDigest, manifest.body_digest);

    // Snapshot freshness is reported only when a current digest is supplied.
    assert.deepEqual(store.read(CONTEXT_A, 'scope-a', { now: T0, currentLedgerDigest: LEDGER_DIGEST }), {
      status: 'ok',
      manifest,
      age_ms: 0,
      snapshot_fresh: true,
    });
    const stale = store.read(CONTEXT_A, 'scope-a', { now: T0, currentLedgerDigest: '9'.repeat(64) });
    assert.equal(stale.status, 'ok');
    if (stale.status === 'ok') assert.equal(stale.snapshot_fresh, false);
    assert.equal((store.read(CONTEXT_A, 'scope-a', { now: T0 }) as { snapshot_fresh: boolean | null }).snapshot_fresh, null);
    rmSync(root, { recursive: true, force: true });
  });

  await t.test('read distinguishes unknown, corrupt, digest-mismatch, schema-mismatch and cross-scope', async () => {
    const rootA = await makeRoot('probe-manifest-verdict-a-');
    const storeA = new ProbeManifestStore({ root: rootA });
    freezeOk(storeA, CONTEXT_A, T0);
    const fileA = join(storeA.directory, `${CONTEXT_A}.json`);

    // Unknown: never issued.
    assert.deepEqual(storeA.read(CONTEXT_MISSING, 'scope-a', { now: T0 }), { status: 'unknown', context_id: CONTEXT_MISSING });
    // Unknown: outside the storage-safe id vocabulary (never freezable).
    assert.deepEqual(storeA.read('a/b', 'scope-a', { now: T0 }), { status: 'unknown', context_id: 'a/b' });

    // Corrupt: not JSON / wrong shape.
    const corruptId = `ctx-${'e'.repeat(32)}`;
    mkdirSync(storeA.directory, { recursive: true });
    writeFileSync(join(storeA.directory, `${corruptId}.json`), 'not json {', 'utf8');
    assert.equal(storeA.read(corruptId, 'scope-a', { now: T0 }).status, 'corrupt');
    writeFileSync(join(storeA.directory, `${corruptId}.json`), JSON.stringify({}), 'utf8');
    assert.equal(storeA.read(corruptId, 'scope-a', { now: T0 }).status, 'corrupt');

    // Schema mismatch: recognizable envelope version from another era.
    writeFileSync(join(storeA.directory, `${corruptId}.json`), JSON.stringify({ schema_version: 'anchorprobe.manifest.v0' }), 'utf8');
    assert.deepEqual(storeA.read(corruptId, 'scope-a', { now: T0 }), {
      status: 'schema_mismatch',
      context_id: corruptId,
      manifest_version: 'anchorprobe.manifest.v0',
    });

    // Cross scope: wrong expected scope and a manifest planted from another root.
    // (Checked before tampering: digest integrity precedes every other verdict.)
    const cross = storeA.read(CONTEXT_A, 'scope-b', { now: T0 });
    assert.equal(cross.status, 'cross_scope');
    if (cross.status === 'cross_scope') {
      assert.equal(cross.manifest_scope, 'scope-a');
      assert.equal(cross.manifest_root, rootA);
    }
    const rootB = await makeRoot('probe-manifest-verdict-b-');
    const storeB = new ProbeManifestStore({ root: rootB });
    mkdirSync(storeB.directory, { recursive: true });
    writeFileSync(join(storeB.directory, `${CONTEXT_A}.json`), readFileSync(fileA, 'utf8'), 'utf8');
    const planted = storeB.read(CONTEXT_A, 'scope-a', { now: T0 });
    assert.equal(planted.status, 'cross_scope');
    if (planted.status === 'cross_scope') assert.equal(planted.manifest_root, rootA);

    // Digest mismatch: any on-disk edit of the frozen evidence.
    tamperEvidence(fileA, ' tampered');
    const mismatch = storeA.read(CONTEXT_A, 'scope-a', { now: T0 });
    assert.equal(mismatch.status, 'digest_mismatch');
    if (mismatch.status === 'digest_mismatch') assert.match(mismatch.detail, /does not match/);
    // The failure branch carries no evidence text.
    assert.ok(!JSON.stringify(mismatch).includes('approved fact text'));
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  });

  await t.test('TTL expiry is deterministic and sweep removes expired manifests and temp leftovers', async () => {
    const root = await makeRoot('probe-manifest-ttl-');
    const store = new ProbeManifestStore({ root, ttlMs: 1_000 });
    const result = freezeOk(store, CONTEXT_A, T0);
    assert.equal(result.expires_at, '2026-11-21T00:00:01.000Z');

    assert.equal(store.read(CONTEXT_A, 'scope-a', { now: '2026-11-21T00:00:00.999Z' }).status, 'ok');
    assert.equal(store.read(CONTEXT_A, 'scope-a', { now: '2026-11-21T00:00:01.000Z' }).status, 'ok');
    const expired = store.read(CONTEXT_A, 'scope-a', { now: '2026-11-21T00:00:01.001Z' });
    assert.equal(expired.status, 'expired');
    if (expired.status === 'expired') {
      assert.equal(expired.expires_at, '2026-11-21T00:00:01.000Z');
      assert.ok(!JSON.stringify(expired).includes('approved fact text'));
    }

    // Sweep removes the expired manifest and .tmp leftovers.
    mkdirSync(store.directory, { recursive: true });
    const tempName = `${CONTEXT_A}.json.999.111.tmp`;
    writeFileSync(join(store.directory, tempName), 'partial', 'utf8');
    const report = store.sweep({ now: '2026-11-21T00:00:01.001Z' });
    assert.deepEqual(report.removed_expired, [CONTEXT_A]);
    assert.deepEqual(report.removed_temp, [tempName]);
    assert.deepEqual(report.removed_capacity, []);
    assert.equal(store.read(CONTEXT_A, 'scope-a', { now: '2026-11-21T00:00:01.001Z' }).status, 'unknown');

    // A later freeze finds nothing expired and evicts nothing.
    const next = freezeOk(store, CONTEXT_B, '2026-11-21T00:00:02.000Z');
    assert.deepEqual(next.evicted, []);
    rmSync(root, { recursive: true, force: true });
  });

  await t.test('capacity limits evict oldest manifests and refuse oversized ones', async () => {
    // Count capacity: the third freeze evicts the oldest (ties broken by id).
    const countRoot = await makeRoot('probe-manifest-cap-count-');
    const countStore = new ProbeManifestStore({ root: countRoot, maxCount: 2 });
    freezeOk(countStore, CONTEXT_A, T0);
    freezeOk(countStore, CONTEXT_B, T0);
    const third = freezeOk(countStore, CONTEXT_C, T0);
    assert.deepEqual(third.evicted, [CONTEXT_A]);
    assert.equal(countStore.read(CONTEXT_A, 'scope-a', { now: T0 }).status, 'unknown');
    assert.equal(countStore.read(CONTEXT_B, 'scope-a', { now: T0 }).status, 'ok');
    assert.equal(countStore.read(CONTEXT_C, 'scope-a', { now: T0 }).status, 'ok');
    rmSync(countRoot, { recursive: true, force: true });

    // Byte capacity: measure a freeze, then refuse a manifest above the limit.
    // The roots use same-length prefixes so the measured size transfers exactly.
    const sizeRoot = await makeRoot('probe-manifest-cap-size-m-');
    const sizeProbe = new ProbeManifestStore({ root: sizeRoot });
    const measured = freezeOk(sizeProbe, CONTEXT_A, T0);
    rmSync(sizeRoot, { recursive: true, force: true });

    const refuseRoot = await makeRoot('probe-manifest-cap-size-r-');
    const refuseStore = new ProbeManifestStore({ root: refuseRoot, maxTotalBytes: measured.bytes - 1 });
    assert.throws(() => freezeOk(refuseStore, CONTEXT_A, T0), ProbeManifestCapacityError);
    assert.equal(existsSync(join(refuseRoot, '.ano', 'memory', 'probes')), false, 'nothing is written when the manifest alone exceeds capacity');
    rmSync(refuseRoot, { recursive: true, force: true });

    // Byte-driven eviction: a second freeze evicts the first instead of failing.
    const evictRoot = await makeRoot('probe-manifest-cap-size-v-');
    const evictStore = new ProbeManifestStore({ root: evictRoot, maxTotalBytes: 2 * measured.bytes - 1, maxCount: 10 });
    freezeOk(evictStore, CONTEXT_A, T0);
    const evicted = freezeOk(evictStore, CONTEXT_B, T0);
    assert.deepEqual(evicted.evicted, [CONTEXT_A]);
    assert.equal(evictStore.read(CONTEXT_A, 'scope-a', { now: T0 }).status, 'unknown');
    assert.equal(evictStore.read(CONTEXT_B, 'scope-a', { now: T0 }).status, 'ok');
    rmSync(evictRoot, { recursive: true, force: true });
  });

  await t.test('cleanup never touches the ledger, .pm, cache or files outside the probes directory', async () => {
    const root = await makeRoot('probe-manifest-isolation-');
    mkdirSync(join(root, '.ano', 'ledger'), { recursive: true });
    mkdirSync(join(root, '.ano', 'cache'), { recursive: true });
    mkdirSync(join(root, '.ano', 'memory'), { recursive: true });
    mkdirSync(join(root, '.pm'), { recursive: true });
    writeFileSync(join(root, '.ano', 'ledger', 'seg-000001.jsonl'), 'ledger-bytes', 'utf8');
    writeFileSync(join(root, '.ano', 'cache', 'history.db'), 'cache-bytes', 'utf8');
    writeFileSync(join(root, '.ano', 'memory', 'other.json'), 'keep-me', 'utf8');
    writeFileSync(join(root, '.pm', 'tasks.json'), 'pm-bytes', 'utf8');

    const store = new ProbeManifestStore({ root });
    freezeOk(store, CONTEXT_A, T0);
    freezeOk(store, CONTEXT_B, T0);
    assert.equal(store.delete(CONTEXT_B), true);
    assert.equal(store.delete(CONTEXT_B), false);
    assert.throws(() => store.delete('..'), ProbeManifestError, 'deletion is restricted to storage-safe context ids');
    const report = store.sweep({ now: T0 });
    assert.deepEqual(report.removed_expired, []);
    assert.deepEqual(report.removed_capacity, []);

    assert.equal(readFileSync(join(root, '.ano', 'ledger', 'seg-000001.jsonl'), 'utf8'), 'ledger-bytes');
    assert.equal(readFileSync(join(root, '.ano', 'cache', 'history.db'), 'utf8'), 'cache-bytes');
    assert.equal(readFileSync(join(root, '.ano', 'memory', 'other.json'), 'utf8'), 'keep-me');
    assert.equal(readFileSync(join(root, '.pm', 'tasks.json'), 'utf8'), 'pm-bytes');
    const remaining = readdirSync(store.directory).filter((name) => name.endsWith('.json'));
    assert.deepEqual(remaining, [`${CONTEXT_A}.json`]);
    rmSync(root, { recursive: true, force: true });
  });

  await t.test('freeze refuses inconsistent client payloads and never writes partial state', async () => {
    const root = await makeRoot('probe-manifest-refuse-');
    const store = new ProbeManifestStore({ root });
    const probesDir = join(root, '.ano', 'memory', 'probes');

    // Response fails the AP-02 schema (missing untrusted flag).
    const invalidResponse = probeResponse();
    delete (invalidResponse as Record<string, unknown>).untrusted;
    assert.throws(() => store.freeze({ request: probeRequest(root), response: invalidResponse, now: T0 }), ProbeManifestError);
    assert.equal(existsSync(probesDir), false, 'a rejected freeze writes nothing');

    // request/response identity mismatches.
    assert.throws(
      () => store.freeze({ request: probeRequest(root, { request_id: 'req-2' }), response: probeResponse(), now: T0 }),
      /request_id req-2 does not match/,
    );
    assert.throws(
      () => store.freeze({ request: probeRequest(root, { context_id: CONTEXT_B }), response: probeResponse(), now: T0 }),
      /context_id/,
    );
    assert.throws(
      () => store.freeze({ request: probeRequest(root, { project_scope: 'scope-b' }), response: probeResponse(), now: T0 }),
      /project_scope/,
    );
    assert.throws(
      () => store.freeze({ request: probeRequest('F:/somewhere/else'), response: probeResponse(), now: T0 }),
      /does not match the store root/,
    );

    // A response whose context id is outside the storage-safe vocabulary cannot be frozen.
    assert.throws(
      () => store.freeze({ request: probeRequest(root), response: probeResponse({ context_id: 'a:b' }), now: T0 }),
      ProbeManifestError,
    );
    assert.equal(existsSync(probesDir), false);
    rmSync(root, { recursive: true, force: true });
  });

  await t.test('re-freeze renews an identical manifest, refuses different bytes, and repairs only via explicit delete', async () => {
    const root = await makeRoot('probe-manifest-refreeze-');
    const store = new ProbeManifestStore({ root });
    freezeOk(store, CONTEXT_A, T0);
    const file = join(store.directory, `${CONTEXT_A}.json`);

    // Same material, later clock: freshness is renewed, not a conflict.
    const renewed = freezeOk(store, CONTEXT_A, '2026-11-21T01:00:00.000Z');
    assert.equal(renewed.duplicate, true);
    assert.equal(renewed.frozen_at, '2026-11-21T01:00:00.000Z');
    const verdict = store.read(CONTEXT_A, 'scope-a', { now: '2026-11-21T01:00:00.000Z' });
    assert.equal(verdict.status, 'ok');
    if (verdict.status === 'ok') assert.equal(verdict.manifest.freshness.frozen_at, '2026-11-21T01:00:00.000Z');

    // Different bytes under one context id: refused, original file untouched.
    const different = probeResponse({
      context_id: CONTEXT_A,
      active_evidence: [{
        ref: 'E1',
        record_ref: 'record-1',
        content_hash: EVIDENCE_HASH,
        status: 'active',
        source_health: 'verified_at_snapshot',
        recorded_at: '2026-11-20T00:00:00.000Z',
        effective_from: null,
        source: { kind: 'native_note' },
        content: 'different evidence text',
      }],
    });
    assert.throws(() => store.freeze({ request: probeRequest(root), response: different, now: '2026-11-21T02:00:00.000Z' }), ProbeManifestConflictError);
    assert.equal(store.read(CONTEXT_A, 'scope-a', { now: '2026-11-21T02:00:00.000Z' }).status, 'ok');

    // An externally corrupted file occupying the id is never silently overwritten.
    writeFileSync(file, 'garbage', 'utf8');
    assert.throws(() => freezeOk(store, CONTEXT_A, '2026-11-21T03:00:00.000Z'), ProbeManifestConflictError);
    assert.equal(store.delete(CONTEXT_A), true);
    const repaired = freezeOk(store, CONTEXT_A, '2026-11-21T03:00:00.000Z');
    assert.equal(repaired.duplicate, false);
    assert.equal(store.read(CONTEXT_A, 'scope-a', { now: '2026-11-21T03:00:00.000Z' }).status, 'ok');
    rmSync(root, { recursive: true, force: true });
  });

  await t.test('export requires explicit authorization and only exports intact manifests', async () => {
    const root = await makeRoot('probe-manifest-export-');
    const store = new ProbeManifestStore({ root, ttlMs: 1_000 });
    freezeOk(store, CONTEXT_A, T0);
    const target = join(root, 'exports', 'reproduction', `${CONTEXT_A}.json`);

    // Authorization is explicit and mandatory.
    assert.throws(
      () => store.exportForReproduction(CONTEXT_A, target, { authorize: false, expectedProjectScope: 'scope-a' }),
      /requires explicit authorization/,
    );
    assert.throws(
      () => store.exportForReproduction(CONTEXT_MISSING, target, { authorize: true, expectedProjectScope: 'scope-a', now: T0 }),
      /unknown; nothing to export/,
    );

    // Intact manifest: the exported copy is equivalent to the frozen one.
    const exported = store.exportForReproduction(CONTEXT_A, target, { authorize: true, expectedProjectScope: 'scope-a', now: T0 });
    assert.equal(exported.source_status, 'ok');
    const liveVerdict = store.read(CONTEXT_A, 'scope-a', { now: T0 });
    assert.equal(liveVerdict.status, 'ok');
    if (liveVerdict.status !== 'ok') return;
    assert.equal(exported.body_digest, liveVerdict.manifest.body_digest);
    const exportedManifest = JSON.parse(readFileSync(target, 'utf8')) as FrozenProbeManifest;
    assert.equal(canonicalJson(exportedManifest), canonicalJson(liveVerdict.manifest));

    // Exports never land inside the managed directory.
    assert.throws(
      () => store.exportForReproduction(CONTEXT_A, join(store.directory, 'copy.json'), { authorize: true, expectedProjectScope: 'scope-a', now: T0 }),
      /outside/,
    );

    // Expired-but-intact manifests export as honest historical artifacts.
    const expiredTarget = join(root, 'exports', 'expired', `${CONTEXT_A}.json`);
    const expiredExport = store.exportForReproduction(CONTEXT_A, expiredTarget, { authorize: true, expectedProjectScope: 'scope-a', now: '2026-11-21T00:00:02.000Z' });
    assert.equal(expiredExport.source_status, 'expired');
    assert.ok(existsSync(expiredTarget));

    // Tampered manifests are refused (the digest check precedes every verdict).
    tamperEvidence(join(store.directory, `${CONTEXT_A}.json`), ' tampered');
    assert.throws(
      () => store.exportForReproduction(CONTEXT_A, join(root, 'exports', 'tampered.json'), { authorize: true, expectedProjectScope: 'scope-a' }),
      /not intact/,
    );
    rmSync(root, { recursive: true, force: true });
  });

  await t.test('store options are bounded and validated', async () => {
    const root = await makeRoot('probe-manifest-options-');
    assert.throws(() => new ProbeManifestStore({ root, ttlMs: 100 }), /ttlMs/);
    assert.throws(() => new ProbeManifestStore({ root, ttlMs: 2_592_000_001 }), /ttlMs/);
    assert.throws(() => new ProbeManifestStore({ root, maxCount: 0 }), /maxCount/);
    assert.throws(() => new ProbeManifestStore({ root, maxTotalBytes: 1_023 }), /maxTotalBytes/);
    assert.throws(() => new ProbeManifestStore({ root: '' }), /root/);
    assert.equal(new ProbeManifestStore({ root }).directory, join(root, '.ano', 'memory', 'probes'));
    rmSync(root, { recursive: true, force: true });
  });
});

test('manifest cluster metadata is optional, digest-bound and scope-checked', async (t) => {
  const CLUSTER = {
    schema_version: 'anchorprobe.cluster.v1',
    project_scope: 'scope-a',
    cluster_epoch: 'ep-1',
    commit_index: 12,
    replica_id: 'replica-0',
    replica_commit_index: 9,
    consistency: 'committed',
    max_lag: 3,
    partial: true,
    failed_nodes: ['replica-1'],
    evidence_digest: '4'.repeat(64),
  } as const;
  const MANIFEST_CLUSTER = {
    cluster_epoch: 'ep-1',
    commit_index: 12,
    replica_id: 'replica-0',
    evidence_digest: '4'.repeat(64),
  };

  await t.test('the cluster segment participates in body_digest and reads back intact', async () => {
    const root = await makeRoot('probe-manifest-cluster-freeze-');
    const store = new ProbeManifestStore({ root });
    const response = probeResponse({
      context_id: CONTEXT_A,
      snapshot: { ...(probeResponse().snapshot as Record<string, unknown>), cluster: CLUSTER },
    });
    const result = store.freeze({ request: probeRequest(root), response, now: T0 });
    assert.equal(result.duplicate, false);

    const verdict = store.read(CONTEXT_A, 'scope-a', { now: T0 });
    assert.equal(verdict.status, 'ok');
    if (verdict.status !== 'ok') return;
    assert.deepEqual(verdict.manifest.cluster, MANIFEST_CLUSTER);

    const file = join(store.directory, `${CONTEXT_A}.json`);
    const parsedFile = JSON.parse(readFileSync(file, 'utf8')) as FrozenProbeManifest;
    const { body_digest: storedDigest, ...body } = parsedFile;
    assert.equal(createHash('sha256').update(canonicalJson(body)).digest('hex'), storedDigest);
    const { cluster: _cluster, ...bodyWithoutCluster } = body;
    assert.notEqual(
      createHash('sha256').update(canonicalJson(bodyWithoutCluster)).digest('hex'),
      storedDigest,
      'removing the cluster segment must change the body digest',
    );

    // Export carries the cluster identity too.
    const exported = store.exportForReproduction(CONTEXT_A, join(root, 'export.json'), { authorize: true, expectedProjectScope: 'scope-a', now: T0 });
    const exportedManifest = JSON.parse(readFileSync(join(root, 'export.json'), 'utf8')) as FrozenProbeManifest;
    assert.equal(exported.body_digest, exportedManifest.body_digest);
    assert.deepEqual(exportedManifest.cluster, verdict.manifest.cluster);
    rmSync(root, { recursive: true, force: true });
  });

  await t.test('legacy manifests without a cluster segment still validate', async () => {
    const root = await makeRoot('probe-manifest-cluster-legacy-');
    const store = new ProbeManifestStore({ root });
    freezeOk(store, CONTEXT_A, T0);
    const verdict = store.read(CONTEXT_A, 'scope-a', { now: T0 });
    assert.equal(verdict.status, 'ok');
    if (verdict.status !== 'ok') return;
    assert.equal(verdict.manifest.cluster, undefined);

    const file = join(store.directory, `${CONTEXT_A}.json`);
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    assert.equal('cluster' in parsed, false);
    assert.equal(frozenProbeManifestSchema.safeParse(parsed).success, true);
    rmSync(root, { recursive: true, force: true });
  });

  await t.test('the frozen cluster segment is strictly bounded', () => {
    assert.equal(probeManifestClusterSchema.safeParse(MANIFEST_CLUSTER).success, true);
    assert.equal(probeManifestClusterSchema.safeParse({ ...MANIFEST_CLUSTER, extra: 1 }).success, false);
    assert.equal(probeManifestClusterSchema.safeParse({ ...MANIFEST_CLUSTER, commit_index: -1 }).success, false);
    assert.equal(probeManifestClusterSchema.safeParse({ ...MANIFEST_CLUSTER, replica_id: 'bad id!' }).success, false);
    assert.equal(probeManifestClusterSchema.safeParse({ ...MANIFEST_CLUSTER, evidence_digest: 'x'.repeat(64) }).success, false);
  });

  await t.test('cross-scope cluster metadata is refused at freeze and read time', async () => {
    const root = await makeRoot('probe-manifest-cluster-scope-');
    const store = new ProbeManifestStore({ root });
    const foreign = probeResponse({
      context_id: CONTEXT_A,
      snapshot: { ...(probeResponse().snapshot as Record<string, unknown>), cluster: { ...CLUSTER, project_scope: 'scope-b' } },
    });
    assert.throws(() => store.freeze({ request: probeRequest(root), response: foreign, now: T0 }), /SCOPE_DENIED/);
    assert.equal(existsSync(store.directory), false);

    // Even a digest-repaired foreign cluster segment is caught at read time.
    freezeOk(store, CONTEXT_A, T0);
    const file = join(store.directory, `${CONTEXT_A}.json`);
    const planted = JSON.parse(readFileSync(file, 'utf8')) as FrozenProbeManifest;
    const repairedBody = {
      ...planted,
      response: {
        ...planted.response,
        snapshot: { ...planted.response.snapshot, cluster: { ...CLUSTER, project_scope: 'scope-b' } },
      },
      cluster: MANIFEST_CLUSTER,
    };
    const { body_digest: _oldDigest, ...withoutDigest } = repairedBody;
    const body_digest = createHash('sha256').update(canonicalJson(withoutDigest)).digest('hex');
    writeFileSync(file, JSON.stringify({ ...withoutDigest, body_digest }, null, 2), 'utf8');

    const verdict = store.read(CONTEXT_A, 'scope-a', { now: T0 });
    assert.equal(verdict.status, 'cross_scope');
    if (verdict.status === 'cross_scope') assert.equal(verdict.manifest_scope, 'scope-b');
    rmSync(root, { recursive: true, force: true });
  });
});
