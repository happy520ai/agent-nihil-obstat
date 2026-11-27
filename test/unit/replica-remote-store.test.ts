import assert from 'node:assert/strict';
import test from 'node:test';
import type { AnchorProbeClusterMetadata, AnchorProbeSnapshot } from '../../src/memory/probe-contract.ts';
import type { ProbeCandidate, ProbeEdge } from '../../src/memory/probe.ts';
import { ProbeStoreCacheError, probeSnapshotIdentity } from '../../src/memory/probe-store.ts';
import { RemoteReplicaStore } from '../../src/memory/replica-transport.ts';

/**
 * T-144 / CV-02: RemoteReplicaStore read adapter.
 *
 * The store is a cache: reads reflect the last completed round trip and throw
 * before the first one. These tests drive the injected `read` callback directly,
 * covering every candidate/edge projection and query-filter branch without a
 * live replica.
 */

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const AT = '2026-11-21T00:00:00.000Z';

function clusterMetadata(overrides: Partial<AnchorProbeClusterMetadata> = {}): AnchorProbeClusterMetadata {
  return {
    schema_version: 'anchorprobe.cluster.v1',
    project_scope: 'fixture',
    cluster_epoch: 'epoch-1',
    commit_index: 7,
    replica_id: 'replica-a',
    replica_commit_index: 7,
    consistency: 'local',
    max_lag: null,
    partial: false,
    failed_nodes: [],
    evidence_digest: HASH_A,
    ...overrides,
  };
}

function snapshot(overrides: Partial<AnchorProbeSnapshot> = {}): AnchorProbeSnapshot {
  return {
    project_scope: 'fixture',
    ledger_digest: HASH_B,
    graph_revision: null,
    source_fingerprint: null,
    connected_digest: null,
    ...overrides,
  };
}

function candidate(overrides: Partial<ProbeCandidate> = {}): ProbeCandidate {
  return {
    record_ref: 'E1',
    fact_key: 'local.a',
    task_id: 'T1',
    file: 'src/a.ts',
    symbol: 'symA',
    source: { kind: 'native_note', path: 'src/a.ts' },
    source_health: 'verified_at_snapshot',
    status: 'active',
    content: 'alpha',
    content_hash: HASH_A,
    recorded_at: AT,
    effective_from: null,
    effective_to: null,
    superseded_by: null,
    version: 1,
    anchor: { status: 'exact', file: 'src/a.ts' },
    qualifiers: [],
    ...overrides,
  };
}

function edge(overrides: Partial<ProbeEdge> = {}): ProbeEdge {
  return { from: 'E1', to: 'E2', kind: 'depends_on', provenance: 'confirmed', ...overrides };
}

interface CacheOptions {
  readonly snapshot?: AnchorProbeSnapshot;
  readonly candidates?: readonly ProbeCandidate[];
  readonly edges?: readonly ProbeEdge[];
}

function cache(options: CacheOptions = {}): { snapshot: AnchorProbeSnapshot; candidates: readonly ProbeCandidate[]; edges: readonly ProbeEdge[] } {
  return {
    snapshot: options.snapshot ?? snapshot(),
    candidates: options.candidates ?? [],
    edges: options.edges ?? [],
  };
}

test('RemoteReplicaStore refuses reads before the first completed round trip', () => {
  const store = new RemoteReplicaStore(() => null);
  assert.throws(() => store.snapshot, ProbeStoreCacheError);
  assert.throws(() => store.candidates(), ProbeStoreCacheError);
  assert.throws(() => store.adjacency(), ProbeStoreCacheError);
  assert.throws(() => store.evidence('E1'), ProbeStoreCacheError);
  assert.equal(store.replicaCommitIndex(), undefined);
});

test('RemoteReplicaStore projects candidates, filters queries and resolves adjacency', () => {
  const candidates = [
    candidate({ record_ref: 'E1', fact_key: 'local.a', task_id: 'T1', file: 'src/a.ts', symbol: 'symA' }),
    candidate({ record_ref: 'E2', fact_key: 'local.b', task_id: 'T2', file: 'src/b.ts', symbol: 'symB', status: 'superseded', superseded_by: 'E1', qualifiers: ['legacy_unreviewed'] }),
  ];
  const edges = [edge({ from: 'E1', to: 'E2' }), edge({ from: 'E3', to: 'E1' })];
  const store = new RemoteReplicaStore(() => cache({ candidates, edges }));

  assert.deepEqual(store.candidates(), candidates);
  assert.deepEqual(store.candidates({}), candidates);

  // Each query dimension matches and mismatches independently.
  assert.deepEqual(store.candidates({ fact_key: 'local.b' }), [candidates[1]]);
  assert.deepEqual(store.candidates({ task_id: 'T1' }), [candidates[0]]);
  assert.deepEqual(store.candidates({ file: 'src/b.ts' }), [candidates[1]]);
  assert.deepEqual(store.candidates({ symbol: 'symA' }), [candidates[0]]);
  assert.deepEqual(store.candidates({ fact_key: 'local.a', task_id: 'T2' }), []);
  assert.deepEqual(store.candidates({ fact_key: 'missing' }), []);

  assert.deepEqual(store.adjacency(), edges);
  assert.deepEqual(store.adjacency('E1'), edges);
  assert.deepEqual(store.adjacency('E2'), [edges[0]]);
  assert.deepEqual(store.adjacency('absent'), []);
});

test('RemoteReplicaStore maps evidence, status and provenance views', () => {
  const records = [
    candidate({ record_ref: 'E1', qualifiers: [] }),
    candidate({
      record_ref: 'E2',
      status: 'superseded',
      superseded_by: 'E1',
      version: 3,
      effective_from: AT,
      effective_to: null,
      qualifiers: ['legacy_unreviewed'],
      source: { kind: 'history', path: 'history/1' },
      source_health: 'stale',
    }),
  ];
  const store = new RemoteReplicaStore(() => cache({ candidates: records }));

  assert.deepEqual(store.evidence('E1'), {
    record_ref: 'E1',
    content_hash: HASH_A,
    status: 'active',
    source_health: 'verified_at_snapshot',
    recorded_at: AT,
    effective_from: null,
    source: { kind: 'native_note', path: 'src/a.ts' },
    content: 'alpha',
  });
  assert.equal(store.evidence('absent'), undefined);

  const governed = store.status('E1');
  assert.equal(governed?.eligibility, 'governed');
  const legacy = store.status('E2');
  assert.equal(legacy?.eligibility, 'legacy_unreviewed');
  assert.equal(legacy?.superseded_by, 'E1');
  assert.equal(legacy?.version, 3);
  assert.equal(store.status('absent'), undefined);

  assert.deepEqual(store.provenance('E2'), {
    record_ref: 'E2',
    source: { kind: 'history', path: 'history/1' },
    source_health: 'stale',
    qualifiers: ['legacy_unreviewed'],
    anchor: { status: 'exact', file: 'src/a.ts' },
  });
  assert.equal(store.provenance('absent'), undefined);
});

test('RemoteReplicaStore derives snapshot identity and the replica commit index', () => {
  const snap = snapshot({ cluster: clusterMetadata({ replica_commit_index: 9, commit_index: 7 }) });
  let current = cache({ snapshot: snap });
  const store = new RemoteReplicaStore(() => current);

  assert.deepEqual(store.snapshotIdentity(), probeSnapshotIdentity(snap));
  assert.equal(store.replicaCommitIndex(), 9);

  // Falls back to the cluster commit index when the replica-specific one is absent.
  const { replica_commit_index: _omitted, ...fallbackMeta } = clusterMetadata({ commit_index: 7 });
  current = cache({ snapshot: snapshot({ cluster: fallbackMeta as unknown as AnchorProbeClusterMetadata }) });
  assert.equal(store.replicaCommitIndex(), 7);

  const plain = snapshot();
  current = cache({ snapshot: plain });
  assert.equal(store.replicaCommitIndex(), undefined);
});
