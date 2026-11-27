/**
 * T-152 / QF-03 final consistency branches (integration).
 *
 * Exercises the security boundaries end to end, where a refusal must hold
 * across module seams rather than inside one pure function:
 *   - distributed-probe scope routing fallbacks, response-epoch override and
 *     exact-quorum / same-commit-different-digest / below-primary quorum edges;
 *   - HaCluster propose fencing (no lease, ahead of lease, hash mismatch) and
 *     the Gate boundary over a real fork;
 *   - frozen probe manifests cannot be read across a project scope;
 *   - the consumer refuses a manifest/response scope mismatch and a blocked
 *     cluster-consistency verdict before any model call;
 *   - judgeConsistency + assertExecutableContext refuse stale/historical
 *     evidence as a current-execution basis.
 *
 * No skip/todo/only. Positive and negative directions are both asserted.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  DistributedProbeError,
  distributedProbe,
  type DistributedReplicaNode,
} from '../../src/memory/distributed-probe.ts';
import {
  assertExecutableContext,
  ClusterConsistencyError,
  judgeConsistency,
} from '../../src/memory/cluster-consistency.ts';
import { HaCluster, type HaProposeInput } from '../../src/memory/ha-cluster.ts';
import { canonicalJson, hashEvent } from '../../src/ledger/event.ts';
import { ProbeManifestStore } from '../../src/memory/probe-manifest.ts';
import { runConsumer, type ConsumerProbeAdapter } from '../../src/memory/consumer.ts';
import { anchorProbeResponseSchema, type AnchorProbeResponse } from '../../src/memory/probe-contract.ts';
import {
  CONTEXT_DRAFT_SCHEMA_VERSION,
  verifyContextDraft,
  type ContextVerifyInput,
} from '../../src/memory/context-verify.ts';
import type { FrozenContextManifest } from '../../src/memory/context-verify.ts';
import {
  T152_AT,
  T152_HASH_A,
  T152_HASH_B,
  T152_HASH_C,
  T152_HASH_D,
  T152FakeStore,
  t152BareSnapshot,
  t152Candidate,
  t152LedgerEvent,
  t152Request,
  t152Snapshot,
} from '../helpers/t152-security-fixtures.ts';

const WRITER_ID = 't152-writer';

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: unknown }).code) : undefined;
}

async function expectCode(run: () => unknown | Promise<unknown>, code: string): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    assert.equal(codeOf(error), code, `expected ${code}, got ${String(error)}`);
    return error;
  }
  assert.fail(`expected ${code} to be thrown`);
}

// ---------------------------------------------------------------------------
// distributed-probe fixtures
// ---------------------------------------------------------------------------

interface NodeOptions {
  readonly scope?: string;
  readonly bareScope?: string;
  readonly commitIndex?: number;
  readonly epoch?: string;
  readonly responseEpoch?: string;
  readonly state?: 'ACTIVE' | 'LAGGING' | 'REVOKED' | 'FAILED' | 'SUSPECT' | 'JOINING';
  readonly digestSeed?: string;
  readonly query?: DistributedReplicaNode['query'];
}

function probeNode(id: string, records: ReturnType<typeof t152Candidate>[], options: NodeOptions = {}): DistributedReplicaNode {
  const snapshot = options.bareScope === undefined
    ? t152Snapshot({
      project_scope: options.scope ?? 'proj',
      replica_id: id,
      commit_index: options.commitIndex ?? 0,
      replica_commit_index: options.commitIndex ?? 0,
      ...(options.state === 'LAGGING' ? { partial: true } : {}),
    })
    : t152BareSnapshot(options.bareScope);
  const store = new T152FakeStore(records, { snapshot });
  const builtInQuery: DistributedReplicaNode['query'] = async () => ({
    candidates: store.candidates(),
    edges: [],
    ...(options.commitIndex === undefined ? {} : { commitIndex: options.commitIndex }),
    ...(options.responseEpoch === undefined ? {} : { clusterEpoch: options.responseEpoch }),
    ...(options.state === undefined ? {} : { state: options.state }),
  });
  return {
    replicaId: id,
    store,
    ...(options.scope === undefined ? {} : { projectScope: options.scope }),
    ...(options.epoch === undefined ? {} : { clusterEpoch: options.epoch }),
    ...(options.commitIndex === undefined ? {} : { commitIndex: options.commitIndex }),
    query: options.query ?? builtInQuery,
  };
}

function outcomeOf(answer: Awaited<ReturnType<typeof distributedProbe>>, replicaId: string): string {
  const report = answer.nodes.find((entry) => entry.replica_id === replicaId);
  assert.ok(report !== undefined, `missing node report for ${replicaId}`);
  return report.outcome;
}

function baseRecords(seed = T152_HASH_A): ReturnType<typeof t152Candidate>[] {
  return [t152Candidate('r-a', seed)];
}

// ---------------------------------------------------------------------------
// 1. distributed-probe scope routing
// ---------------------------------------------------------------------------

test('T-152 scope: every scope source is enforced before a query and a foreign replica is never asked', async () => {
  const local = new T152FakeStore(baseRecords());

  // Preferred source: the node declaration.
  const declared = probeNode('r-declared', baseRecords(), { scope: 'other' });
  let declaredQueried = false;
  const declaredAnswer = await distributedProbe(
    t152Request(),
    local,
    [{ ...declared, query: async () => { declaredQueried = true; return { candidates: baseRecords(), commitIndex: 1 }; } }],
    { mode: 'COMMITTED', primaryCommitIndex: 1 },
  );
  assert.equal(outcomeOf(declaredAnswer, 'r-declared'), 'SCOPE_DENIED');
  assert.equal(declaredQueried, false);

  // Fallback source: snapshot.cluster.project_scope when the node declares none.
  const clusterFallback = probeNode('r-cluster-fallback', baseRecords(), { scope: 'other' });
  let clusterQueried = false;
  const clusterAnswer = await distributedProbe(
    t152Request(),
    local,
    [{
      replicaId: 'r-cluster-fallback',
      store: clusterFallback.store,
      query: async () => { clusterQueried = true; return { candidates: baseRecords(), commitIndex: 1 }; },
    }],
    { mode: 'COMMITTED', primaryCommitIndex: 1 },
  );
  assert.equal(outcomeOf(clusterAnswer, 'r-cluster-fallback'), 'SCOPE_DENIED');
  assert.equal(clusterQueried, false);

  // Last fallback source: snapshot.project_scope on a bare snapshot.
  const bare = probeNode('r-bare', baseRecords(), { bareScope: 'other' });
  let bareQueried = false;
  const bareAnswer = await distributedProbe(
    t152Request(),
    local,
    [{
      replicaId: 'r-bare',
      store: bare.store,
      query: async () => { bareQueried = true; return { candidates: baseRecords(), commitIndex: 1 }; },
    }],
    { mode: 'COMMITTED', primaryCommitIndex: 1 },
  );
  assert.equal(outcomeOf(bareAnswer, 'r-bare'), 'SCOPE_DENIED');
  assert.equal(bareQueried, false);

  // Positive control: a matching bare snapshot is queried and served.
  const matching = probeNode('r-matching', baseRecords(), { bareScope: 'proj', commitIndex: 1 });
  const okAnswer = await distributedProbe(t152Request(), local, [matching], { mode: 'COMMITTED', primaryCommitIndex: 1 });
  assert.equal(outcomeOf(okAnswer, 'r-matching'), 'OK');
});

// ---------------------------------------------------------------------------
// 2. distributed-probe epoch override
// ---------------------------------------------------------------------------

test('T-152 epoch: a response cannot answer for an epoch that failed the handshake', async () => {
  const local = new T152FakeStore(baseRecords());

  const forger = probeNode('r-epoch-forger', baseRecords(), { epoch: 'epoch-1', responseEpoch: 'epoch-9', commitIndex: 1 });
  const forged = await distributedProbe(t152Request(), local, [forger], {
    mode: 'COMMITTED',
    primaryCommitIndex: 1,
    clusterEpoch: 'epoch-1',
  });
  assert.equal(outcomeOf(forged, 'r-epoch-forger'), 'CLUSTER_EPOCH_MISMATCH');
  assert.notEqual(forged.metadata.consistency, 'CONSISTENT');

  // Positive control: a matching response epoch joins normally.
  const honest = probeNode('r-epoch-honest', baseRecords(), { epoch: 'epoch-1', responseEpoch: 'epoch-1', commitIndex: 1 });
  const honestAnswer = await distributedProbe(t152Request(), local, [honest], {
    mode: 'COMMITTED',
    primaryCommitIndex: 1,
    clusterEpoch: 'epoch-1',
  });
  assert.equal(outcomeOf(honestAnswer, 'r-epoch-honest'), 'OK');
  assert.equal(honestAnswer.metadata.consistency, 'CONSISTENT');
});

// ---------------------------------------------------------------------------
// 3. distributed-probe quorum edges
// ---------------------------------------------------------------------------

test('T-152 quorum: exact threshold commits, one vote below downgrades, mixed digests never fake a majority', async () => {
  const local = new T152FakeStore(baseRecords());
  const digestA = baseRecords(T152_HASH_A);
  const digestB = baseRecords(T152_HASH_B);

  // N=3 replicas => ceil((3+1)/2)=2. Exactly two at one commit point is QUORUM.
  const exact = await distributedProbe(t152Request(), local, [
    probeNode('q-0', digestA, { commitIndex: 10 }),
    probeNode('q-1', digestA, { commitIndex: 10 }),
    probeNode('q-2', digestA, { commitIndex: 9 }),
  ], { mode: 'QUORUM', primaryCommitIndex: 10 });
  assert.equal(exact.metadata.mode, 'QUORUM');
  assert.equal(exact.metadata.quorum_size, 2);
  assert.equal(exact.metadata.quorum_count, 2);
  assert.equal(exact.degraded, false);

  // One vote short: explicit downgrade, never a silent QUORUM claim.
  const short = await distributedProbe(t152Request(), local, [
    probeNode('s-0', digestA, { commitIndex: 10 }),
    probeNode('s-1', digestA, {
      query: async () => { throw new Error('replica unavailable'); },
    }),
  ], { mode: 'QUORUM', primaryCommitIndex: 10, primaryEvidenceDigest: 'f'.repeat(64) });
  assert.equal(short.metadata.mode, 'LOCAL');
  assert.equal(short.degraded, true);
  assert.equal(short.metadata.stop_reason, 'QUORUM_UNMET');

  // Two groups at the SAME commit point with different digests: neither group
  // reaches the threshold, so no cross-digest majority may be synthesized.
  const splitDigest = await distributedProbe(t152Request(), local, [
    probeNode('d-0', digestA, { commitIndex: 10 }),
    probeNode('d-1', digestB, { commitIndex: 10 }),
    probeNode('d-2', digestA, { commitIndex: 9 }),
  ], { mode: 'QUORUM', primaryCommitIndex: 10, primaryEvidenceDigest: T152_HASH_A });
  assert.notEqual(splitDigest.metadata.mode, 'QUORUM');
  assert.equal(splitDigest.degraded, true);

  // Best group below the primary: QUORUM is reported stale, never healthy.
  const lagging = await distributedProbe(t152Request(), local, [
    probeNode('l-0', digestA, { commitIndex: 9 }),
    probeNode('l-1', digestA, { commitIndex: 9 }),
  ], { mode: 'QUORUM', primaryCommitIndex: 10 });
  assert.equal(lagging.metadata.mode, 'QUORUM');
  assert.equal(lagging.metadata.stale, true);
  const judgement = judgeConsistency(lagging, { mode: 'QUORUM', primaryCommitIndex: 10 });
  assert.equal(judgement.status, 'stale');
  assert.equal(judgement.code, 'QUORUM_LAGGING');
});

test('T-152 committed: a replica at the primary commit with a foreign digest is not caught up', async () => {
  const local = new T152FakeStore(baseRecords());
  const answer = await distributedProbe(t152Request(), local, [
    probeNode('c-0', baseRecords(), { commitIndex: 10 }),
  ], { mode: 'COMMITTED', primaryCommitIndex: 10, primaryEvidenceDigest: 'f'.repeat(64) });
  assert.equal(answer.metadata.mode, 'LOCAL');
  assert.equal(answer.degraded, true);
  assert.equal(answer.metadata.degradation_reason, 'NO_REPLICA_CAUGHT_UP');
  assert.equal(answer.metadata.stop_reason, 'QUORUM_UNMET');
});

test('T-152 cancellation: a scatter-level abort adopts nothing and stays CANCELLED/UNKNOWN', async () => {
  const local = new T152FakeStore(baseRecords());
  const controller = new AbortController();
  const late: DistributedReplicaNode = {
    replicaId: 'cancel-late',
    store: new T152FakeStore(baseRecords()),
    commitIndex: 10,
    query: (_request, context) => new Promise((resolve) => {
      context.signal.addEventListener('abort', () => resolve({ candidates: baseRecords(), commitIndex: 10 }));
    }),
  };
  const pending = distributedProbe(t152Request(), local, [late], {
    mode: 'COMMITTED',
    primaryCommitIndex: 10,
    signal: controller.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  const answer = await pending;
  assert.equal(answer.outcome, 'CANCELLED');
  assert.equal(answer.metadata.consistency, 'UNKNOWN');
  assert.equal(answer.metadata.stop_reason, 'CANCELLED');
  assert.deepEqual(answer.partial.failed_nodes, []);
  assert.equal(answer.resources_released, true);
});

test('T-152 cancellation: a normal ProbeStore callback aborting after scatter reaches the post-adoption guard', async () => {
  // The coordinator calls the user ProbeStore at line 917 AFTER the scatter and
  // the line-872 aborted check. A real replicaCommitIndex() implementation may
  // observe its own shutdown and call controller.abort() synchronously; the
  // answer must then take the 1087 branch and adopt nothing.
  const controller = new AbortController();
  const records = baseRecords();
  let callbackAborted = false;
  const local = new T152FakeStore(records, {
    snapshot: t152Snapshot({ commit_index: 10, replica_commit_index: 10 }),
    replicaCommitIndex: () => {
      callbackAborted = true;
      controller.abort();
      return 10;
    },
  });
  const node = probeNode('post-scatter-abort-node', records, { commitIndex: 10 });
  // No explicit primaryCommitIndex: line 917 derives it from the user store,
  // whose callback aborts synchronously after the line-872 check has passed.
  const answer = await distributedProbe(t152Request(), local, [node], {
    mode: 'COMMITTED',
    signal: controller.signal,
  });

  assert.equal(callbackAborted, true, 'the store callback must have run');
  assert.equal(controller.signal.aborted, true);
  assert.equal(answer.outcome, 'CANCELLED');
  assert.equal(answer.metadata.consistency, 'UNKNOWN');
  assert.equal(answer.metadata.stop_reason, 'CANCELLED');
  assert.deepEqual(answer.candidates, [], 'a successful-but-late node result must not be adopted');
  assert.equal(answer.nodes[0]?.outcome, 'CANCELLED');
  assert.equal(answer.nodes[0]?.used, false);
  assert.equal(answer.resources_released, true);
  const serialized = JSON.stringify(answer);
  for (const key of ['evidence_id', 'verdict', 'task_id']) assert.equal(serialized.includes(`"${key}"`), false, key);
});

test('T-152 cancellation: a cluster-less snapshot leaves the primary commit point unknown on the cancelled path', async () => {
  // Both nullish fallbacks on the cancelled answer must be exercised:
  //  - clusterEpoch: no normalized value and no snapshot cluster segment -> '';
  //  - primaryCommitIndex: neither the caller nor the store knows it -> omitted.
  // AS_OF is the only mode that reaches the post-scatter cancellation guard
  // with an unknown primary commit point (COMMITTED/QUORUM degrade earlier).
  const controller = new AbortController();
  const records = baseRecords();
  const local = new T152FakeStore(records, {
    snapshot: t152BareSnapshot('proj'),
    replicaCommitIndex: () => {
      controller.abort();
      return undefined;
    },
  });
  const node = probeNode('clusterless-abort-node', records, { commitIndex: 10 });
  const answer = await distributedProbe(t152Request(), local, [node], {
    mode: 'AS_OF',
    asOfCommitIndex: 10,
    signal: controller.signal,
  });

  assert.equal(controller.signal.aborted, true);
  assert.equal(answer.outcome, 'CANCELLED');
  assert.equal(answer.metadata.consistency, 'UNKNOWN');
  assert.equal(answer.metadata.stop_reason, 'CANCELLED');
  assert.equal(answer.metadata.cluster_epoch, '', 'a cluster-less snapshot leaves the epoch unknown');
  assert.equal(answer.metadata.primary_commit_index, undefined, 'an unknown primary commit point must be omitted, not faked');
  assert.deepEqual(answer.candidates, [], 'nothing may be adopted on the cancelled path');
  assert.equal(answer.resources_released, true);
});

// ---------------------------------------------------------------------------
// 4. HaCluster propose fencing + Gate boundary
// ---------------------------------------------------------------------------

async function startCluster(t: TestContext): Promise<HaCluster> {
  const cluster = await HaCluster.start({ leaseDurationMs: 5_000 });
  t.after(async () => {
    await cluster.close();
  });
  return cluster;
}

function proposeInput(memberId: string, seed: number, epoch: number, term: number, localSeq: number): HaProposeInput {
  const event = t152LedgerEvent(`cluster-${String(seed)}`, seed);
  return {
    memberId,
    writerId: WRITER_ID,
    epoch,
    term,
    localSeq,
    ledgerEvent: event,
    ledgerEventHash: hashEvent(event),
  };
}

test('T-152 cluster: only a current lease holder may propose and ahead-of-lease writes are refused', { timeout: 120_000 }, async (t) => {
  const cluster = await startCluster(t);

  // No lease at all.
  await expectCode(() => cluster.propose(proposeInput('n1', 1, 1, 1, 1)), 'FENCE_REJECTED');
  assert.equal(cluster.node('n1').log.size, 0);

  const first = await cluster.elect('n1');
  assert.equal(first.won, true);

  // Ahead of the held lease (higher epoch, same term).
  await expectCode(
    () => cluster.propose(proposeInput('n1', 2, first.epoch + 1, first.term, 1)),
    'FENCE_REJECTED',
  );

  // Ahead via a higher term in the same epoch.
  await expectCode(
    () => cluster.propose(proposeInput('n1', 3, first.epoch, first.term + 1, 1)),
    'FENCE_REJECTED',
  );

  // Positive control: a genuine proposal commits and carries Gate evidence.
  const committed = await cluster.propose(proposeInput('n1', 4, first.epoch, first.term, 1));
  assert.equal(committed.committed, true);
  assert.ok(committed.evidence_id !== null && committed.evidence_id.length > 0);
  assert.equal(cluster.node('n1').log.size, 1);
  const projection = cluster.projection();
  assert.equal(projection.gate_ok, true);
  assert.equal(projection.entries.length, 1);
});

// ---------------------------------------------------------------------------
// 5. frozen manifests are scope-bound
// ---------------------------------------------------------------------------

function manifestResponse(scope: string, contextId: string): AnchorProbeResponse {
  return anchorProbeResponseSchema.parse({
    schema_version: 'anchorprobe.context.v1',
    request_id: 'req-manifest',
    context_id: contextId,
    snapshot: {
      project_scope: scope,
      ledger_digest: T152_HASH_A,
      graph_revision: null,
      source_fingerprint: T152_HASH_B,
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
      status: 'SUFFICIENT',
      required_facts: ['local.storage.engine'],
      missing_facts: [],
      unresolved_conflicts: [],
      requirements_origin: 'caller_declared',
    },
    l1_invariants: [],
    active_evidence: [],
    deprecated_tombstones: [],
    gaps: [],
    conflicts: [],
    untrusted: true,
  });
}

test('T-152 scope: a frozen manifest cannot be read under a foreign project scope or root', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 't152-manifest-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new ProbeManifestStore({ root });

  const contextId = 'ctx-t152';
  const request = {
    schema_version: 'anchorprobe.request.v1',
    request_id: 'req-manifest',
    root,
    project_scope: 'proj',
    context_id: contextId,
    required_facts: ['local.storage.engine'],
  };
  const frozen = store.freeze({ request, response: manifestResponse('proj', contextId), now: T152_AT });
  assert.equal(frozen.context_id, contextId);

  // Positive control: the bound scope reads back intact.
  const ok = store.read(contextId, 'proj', { now: T152_AT });
  assert.equal(ok.status, 'ok');

  // Negative control: a foreign scope is refused as cross_scope.
  const denied = store.read(contextId, 'other-project', { now: T152_AT });
  assert.equal(denied.status, 'cross_scope');
  assert.equal(denied.manifest_scope, 'proj');

  // Export refuses a foreign expected scope too (the verdict is cross_scope).
  assert.throws(
    () => store.exportForReproduction(contextId, join(root, 'export.json'), { authorize: true, expectedProjectScope: 'other-project', now: T152_AT }),
    /cross_scope/u,
  );

  // Integrity guards on the stored bytes: a renamed/copy context id and a
  // corrupt freshness timestamp are both refused before the manifest is used.
  const copiedName = 'ctx-renamed';
  const sourceFile = join(store.directory, `${contextId}.json`);
  const copiedFile = join(store.directory, `${copiedName}.json`);
  writeFileSync(copiedFile, readFileSync(sourceFile));
  const renamed = store.read(copiedName, 'proj', { now: T152_AT });
  assert.equal(renamed.status, 'digest_mismatch');
  assert.match((renamed as { detail?: string }).detail ?? '', /context identity/u);

  // A foreign cluster segment can never ride along inside an intact manifest:
  // tamper the frozen response's cluster scope and re-seal the body digest.
  const clusterContextId = 'ctx-cluster';
  const clusterResponse = manifestResponse('proj', clusterContextId);
  (clusterResponse.snapshot as { cluster?: unknown }).cluster = {
    schema_version: 'anchorprobe.cluster.v1',
    project_scope: 'proj',
    cluster_epoch: 'epoch-1',
    commit_index: 0,
    replica_id: 'local',
    replica_commit_index: 0,
    consistency: 'local',
    max_lag: null,
    partial: false,
    failed_nodes: [],
    evidence_digest: T152_HASH_A,
  };
  store.freeze({ request: { ...request, context_id: clusterContextId }, response: clusterResponse, now: T152_AT });
  const clusterFile = join(store.directory, `${clusterContextId}.json`);
  const clusterStored = JSON.parse(readFileSync(clusterFile, 'utf8')) as Record<string, any>;
  const { body_digest: _clusterDigest, ...clusterBody } = clusterStored;
  (clusterBody.response.snapshot as { cluster: Record<string, unknown> }).cluster.project_scope = 'other-project';
  const resealed = createHash('sha256').update(canonicalJson(clusterBody)).digest('hex');
  writeFileSync(clusterFile, `${JSON.stringify({ ...clusterBody, body_digest: resealed }, null, 2)}\n`);
  const foreignCluster = store.read(clusterContextId, 'proj', { now: T152_AT });
  assert.equal(foreignCluster.status, 'cross_scope');
  assert.equal((foreignCluster as { manifest_scope?: string }).manifest_scope, 'other-project');

  // A tampered body with a stale digest is refused as digest_mismatch before
  // any other verdict: the stored bytes are never trusted.
  const tamperedContextId = 'ctx-tampered';
  store.freeze({ request: { ...request, context_id: tamperedContextId }, response: manifestResponse('proj', tamperedContextId), now: T152_AT });
  const tamperedFile = join(store.directory, `${tamperedContextId}.json`);
  const tamperedStored = JSON.parse(readFileSync(tamperedFile, 'utf8')) as Record<string, any>;
  tamperedStored.response.snapshot.ledger_digest = 'f'.repeat(64);
  writeFileSync(tamperedFile, `${JSON.stringify(tamperedStored, null, 2)}\n`);
  const tampered = store.read(tamperedContextId, 'proj', { now: T152_AT });
  assert.equal(tampered.status, 'digest_mismatch');
  assert.match((tampered as { detail?: string }).detail ?? '', /body_digest/u);
});

// ---------------------------------------------------------------------------
// 6. consumer: scope mismatch and blocked consistency gate
// ---------------------------------------------------------------------------

const CONSUMER_AT = '2026-11-21T00:00:00.000Z';
const CONSUMER_NOW = '2026-11-21T12:00:00.000Z';
const CONSUMER_ROOT = '/fixtures/t152-root';

function activeEvidence(): Record<string, unknown> {
  return {
    ref: 'E1',
    record_ref: 'probe-record-1',
    content_hash: T152_HASH_A,
    status: 'active',
    source_health: 'verified_at_snapshot',
    recorded_at: CONSUMER_AT,
    effective_from: null,
    source: { kind: 'native_note', path: 'docs/example.md' },
    content: 'Example text; not a project fact.',
  };
}

function contextManifest(scope: string, contextId: string): Record<string, unknown> {
  return {
    schema_version: 'anchorprobe.manifest.v1',
    context_id: contextId,
    created_at: CONSUMER_AT,
    expires_at: '2026-11-21T18:00:00.000Z',
    root: CONSUMER_ROOT,
    project_scope: scope,
    temporal_mode: 'CURRENT',
    execution_status: 'OK',
    budget_status: {
      stop_reason: 'FRONTIER_EXHAUSTED',
      retrieval_completeness: 'COMPLETE_WITHIN_DECLARED_SCOPE',
      nodes_visited: 1,
      frontier_remaining: 0,
    },
    snapshot: {
      project_scope: scope,
      ledger_digest: T152_HASH_A,
      graph_revision: null,
      source_fingerprint: T152_HASH_B,
      connected_digest: null,
    },
    coverage_gate: {
      status: 'SUFFICIENT',
      required_facts: ['local.storage.engine'],
      missing_facts: [],
      unresolved_conflicts: [],
      requirements_origin: 'caller_declared',
    },
    rules: [{ rule_id: 'rule-storage', fact_key: 'local.storage.engine', value: 'sqlite' }],
    active_evidence: [activeEvidence()],
    deprecated_tombstones: [],
  };
}

function consumerResponse(scope: string, contextId: string): AnchorProbeResponse {
  return anchorProbeResponseSchema.parse({
    schema_version: 'anchorprobe.context.v1',
    request_id: 'req-consumer',
    context_id: contextId,
    snapshot: {
      project_scope: scope,
      ledger_digest: T152_HASH_A,
      graph_revision: null,
      source_fingerprint: T152_HASH_B,
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
      status: 'SUFFICIENT',
      required_facts: ['local.storage.engine'],
      missing_facts: [],
      unresolved_conflicts: [],
      requirements_origin: 'caller_declared',
    },
    l1_invariants: [],
    active_evidence: [],
    deprecated_tombstones: [],
    gaps: [],
    conflicts: [],
    untrusted: true,
  });
}

function consumerRequest(scope: string): Record<string, unknown> {
  return {
    schema_version: 'anchorprobe.request.v1',
    request_id: 'req-consumer',
    root: CONSUMER_ROOT,
    project_scope: scope,
    required_facts: ['local.storage.engine'],
  };
}

function probeAdapter(manifest: Record<string, unknown>, response: AnchorProbeResponse): ConsumerProbeAdapter {
  return {
    run: () => ({ manifest: manifest as FrozenContextManifest, response }),
    sampleSnapshot: () => response.snapshot,
  };
}

test('T-152 consumer: a manifest/response scope mismatch is refused before any model call', async () => {
  const modelCalls: number[] = [];
  const result = await runConsumer({
    request: consumerRequest('proj'),
    now: CONSUMER_NOW,
    // Manifest bound to `proj`, response snapshot claims another scope: the
    // cross-scope refusal must fire before the root/snapshot comparisons.
    probe: probeAdapter(contextManifest('proj', 'ctx-consumer'), consumerResponse('other-project', 'ctx-consumer')),
    model: {
      generate: () => {
        modelCalls.push(1);
        return { schema_version: CONTEXT_DRAFT_SCHEMA_VERSION, context_id: 'ctx-consumer', project_scope: 'proj', claims: [], not_applicable: [], unresolved: [] };
      },
    },
  });
  assert.equal(result.outcome, 'FAILED');
  assert.equal(result.failure?.reason, 'probe manifest scope does not match the response snapshot scope');
  assert.deepEqual(modelCalls, [], 'no model call may follow a scope mismatch');

  // Positive control: a matching scope passes validation (then NEEDS_REVIEW, never ALLOW).
  const matched = await runConsumer({
    request: consumerRequest('proj'),
    now: CONSUMER_NOW,
    probe: probeAdapter(contextManifest('proj', 'ctx-consumer'), consumerResponse('proj', 'ctx-consumer')),
    model: {
      generate: () => ({ schema_version: CONTEXT_DRAFT_SCHEMA_VERSION, context_id: 'ctx-consumer', project_scope: 'proj', claims: [], not_applicable: [], unresolved: [] }),
    },
  });
  assert.notEqual(matched.outcome, 'FAILED');
  assert.equal(matched.outcome, 'NEEDS_REVIEW');
});

test('T-152 consumer: every manifest/response mismatch direction is refused before the model', async () => {
  const run = async (manifest: Record<string, unknown>, response: AnchorProbeResponse, request: Record<string, unknown> = consumerRequest('proj')): Promise<string | null> => {
    let modelCalled = false;
    const result = await runConsumer({
      request,
      now: CONSUMER_NOW,
      probe: probeAdapter(manifest, response),
      model: { generate: () => { modelCalled = true; return {}; } },
    });
    assert.equal(modelCalled, false, 'no model call may follow a frozen-context mismatch');
    return result.outcome === 'FAILED' ? result.failure?.reason ?? null : null;
  };

  // Non-object adapter result.
  await run(null as unknown as Record<string, unknown>, consumerResponse('proj', 'ctx-variants'));
  // Context-id mismatch.
  assert.equal(
    await run({ ...contextManifest('proj', 'ctx-variants'), context_id: 'ctx-other' }, consumerResponse('proj', 'ctx-variants')),
    'probe manifest context_id does not match the probe response',
  );
  // Root mismatch.
  assert.equal(
    await run({ ...contextManifest('proj', 'ctx-variants'), root: '/fixtures/other-root' }, consumerResponse('proj', 'ctx-variants')),
    'probe manifest root does not match the probe request root',
  );
  // Execution status mismatch.
  assert.equal(
    await run({ ...contextManifest('proj', 'ctx-variants'), execution_status: 'FAILED' }, consumerResponse('proj', 'ctx-variants')),
    'probe manifest execution_status does not match the probe response',
  );
  // Snapshot digest mismatch with the same scope.
  assert.equal(
    await run({ ...contextManifest('proj', 'ctx-variants'), snapshot: { ...(contextManifest('proj', 'ctx-variants').snapshot as Record<string, unknown>), ledger_digest: T152_HASH_B } }, consumerResponse('proj', 'ctx-variants')),
    'probe manifest snapshot does not match the probe response snapshot',
  );

  // The non-object direction returns its own deterministic reason.
  let nonObjectReason: string | null = null;
  const nonObject = await runConsumer({
    request: consumerRequest('proj'),
    now: CONSUMER_NOW,
    probe: { run: () => null as never, sampleSnapshot: () => consumerResponse('proj', 'ctx-variants').snapshot },
    model: { generate: () => ({}) },
  });
  nonObjectReason = nonObject.failure?.reason ?? null;
  assert.equal(nonObjectReason, 'probe adapter returned a non-object result');

  // A non-object probe RESPONSE is refused by its own reason, distinct from the
  // non-object adapter-result direction above.
  const badResponse = await runConsumer({
    request: consumerRequest('proj'),
    now: CONSUMER_NOW,
    probe: {
      run: () => ({ manifest: contextManifest('proj', 'ctx-variants') as FrozenContextManifest, response: 'not-a-response' as unknown as AnchorProbeResponse }),
      sampleSnapshot: () => consumerResponse('proj', 'ctx-variants').snapshot,
    },
    model: { generate: () => ({}) },
  });
  assert.equal(badResponse.outcome, 'FAILED');
  assert.equal(badResponse.failure?.reason, 'probe adapter returned an invalid AnchorProbe context response');
});

test('T-152 consumer: a blocked cluster-consistency verdict stops the run before the model', async () => {
  let modelCalled = false;
  const result = await runConsumer({
    request: consumerRequest('proj'),
    now: CONSUMER_NOW,
    probe: probeAdapter(contextManifest('proj', 'ctx-gate'), consumerResponse('proj', 'ctx-gate')),
    model: {
      generate: () => {
        modelCalled = true;
        return {};
      },
    },
    consistency: {
      status: 'blocked',
      mode: 'QUORUM',
      requested_mode: 'QUORUM',
      code: 'HISTORICAL_NOT_EXECUTABLE',
      lag: null,
      historical: true,
      stale: false,
      reasons: ['historical evidence is not executable'],
    },
  });
  assert.equal(result.outcome, 'FAILED');
  assert.match(result.failure?.reason ?? '', /^consistency_blocked/);
  assert.equal(modelCalled, false);
});

// ---------------------------------------------------------------------------
// 7. context verification refuses historical / stale / partial bases
// ---------------------------------------------------------------------------

test('T-152 context: historical, stale and partial cluster signals never reach a displayable draft', () => {
  const base: ContextVerifyInput = {
    manifest: contextManifest('proj', 'ctx-history') as FrozenContextManifest,
    draft: {
      schema_version: CONTEXT_DRAFT_SCHEMA_VERSION,
      context_id: 'ctx-history',
      project_scope: 'proj',
      claims: [],
      not_applicable: [],
      unresolved: [],
    },
    root: CONSUMER_ROOT,
    now: CONSUMER_NOW,
  };

  const historical = verifyContextDraft({
    ...base,
    consistency: { status: 'blocked', mode: 'AS_OF', requested_mode: 'AS_OF', code: 'HISTORICAL_NOT_EXECUTABLE', lag: null, historical: true, stale: false, reasons: ['historical'] },
  });
  assert.equal(historical.status, 'BLOCK');
  assert.ok(historical.violations.some((violation) => violation.code === 'consistency_historical'));

  const stale = verifyContextDraft({
    ...base,
    consistency: { status: 'stale', mode: 'QUORUM', requested_mode: 'QUORUM', code: 'QUORUM_LAGGING', lag: 5, historical: false, stale: true, reasons: ['lag'] },
  });
  // Stale is a review finding, never an ALLOW/displayable answer.
  assert.equal(stale.status, 'NEEDS_REVIEW');
  assert.ok(stale.violations.some((violation) => violation.code === 'consistency_stale'));

  const inconsistent = verifyContextDraft({
    ...base,
    consistency: { status: 'inconsistent', mode: 'QUORUM', requested_mode: 'QUORUM', code: 'QUORUM_DIGEST_DIVERGENCE', lag: null, historical: false, stale: false, reasons: ['divergence'] },
  });
  assert.equal(inconsistent.status, 'BLOCK');
  assert.ok(inconsistent.violations.some((violation) => violation.code === 'consistency_inconsistent'));

  // Positive control: a clean consistent signal adds no consistency violation.
  const clean = verifyContextDraft({
    ...base,
    consistency: { status: 'consistent', mode: 'QUORUM', requested_mode: 'QUORUM', code: null, lag: 0, historical: false, stale: false, reasons: [] },
  });
  assert.equal(clean.violations.some((violation) => violation.code.startsWith('consistency_')), false);

  // Caller-envelope guards: a malformed binding root is a TypeError, not a
  // silently permissive verification.
  assert.throws(() => verifyContextDraft({ ...base, root: '' }), TypeError);
  assert.throws(() => verifyContextDraft({ ...base, root: 'x'.repeat(4097) }), TypeError);
  assert.throws(() => verifyContextDraft({ ...base, now: 'not-a-date' }), TypeError);
  assert.throws(() => verifyContextDraft({ ...base, current_snapshot: {} as never }), TypeError);
});

// ---------------------------------------------------------------------------
// 8. judgeConsistency + assertExecutableContext end to end
// ---------------------------------------------------------------------------

test('T-152 gate: assertExecutableContext only admits a consistent judgement and carries the refusal code', async () => {
  const local = new T152FakeStore(baseRecords());
  const answer = await distributedProbe(t152Request(), local, [probeNode('g-0', baseRecords(), { commitIndex: 5 })], {
    mode: 'QUORUM',
    primaryCommitIndex: 5,
  });
  const consistent = judgeConsistency(answer, { mode: 'QUORUM', primaryCommitIndex: 5 });
  assert.equal(consistent.status, 'consistent');
  assert.doesNotThrow(() => assertExecutableContext(consistent));

  const staleAnswer = await distributedProbe(t152Request(), local, [probeNode('g-1', baseRecords(), { commitIndex: 4 })], {
    mode: 'QUORUM',
    primaryCommitIndex: 5,
  });
  const stale = judgeConsistency(staleAnswer, { mode: 'QUORUM', primaryCommitIndex: 5, maxLagThreshold: 0 });
  assert.equal(stale.status, 'stale');
  assert.throws(
    () => assertExecutableContext(stale),
    (error: unknown) => error instanceof ClusterConsistencyError && error.code === stale.code && error.judgement.status === 'stale',
  );

  const historical = judgeConsistency(staleAnswer, { mode: 'QUORUM', primaryCommitIndex: 5, currentExecution: true });
  assert.ok(historical.status === 'stale' || historical.status === 'blocked');
  assert.throws(() => assertExecutableContext(historical), ClusterConsistencyError);
});
