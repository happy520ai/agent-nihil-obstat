import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Ledger } from '../../src/ledger/ledger.ts';
import { replayLedger } from '../../src/ledger/replay.ts';
import { viewDigest, type ViewReplayEntry } from '../../src/ledger/views.ts';
import {
  ANCHOR_PROBE_REQUEST_SCHEMA_VERSION,
  computeEvidenceDigest,
  type AnchorProbeRequest,
  type AnchorProbeSnapshot,
} from '../../src/memory/probe-contract.ts';
import { ProjectedProbeStore, type ProbeStore } from '../../src/memory/probe-store.ts';
import type { ProbeCandidate, ProbeEdge, ProbeEntryQuery } from '../../src/memory/probe.ts';
import { committedEnvelopeFromEvent, exportCommittedEvents } from '../../src/memory/replication.ts';
import { ReplicaStore } from '../../src/memory/replica.ts';
import { distributedProbe } from '../../src/memory/distributed-probe.ts';
import {
  assertExecutableContext,
  judgeConsistency,
  type ConsistencyJudgement,
} from '../../src/memory/cluster-consistency.ts';
import { verifyContextDraft } from '../../src/memory/context-verify.ts';
import { runConsumer } from '../../src/memory/consumer.ts';
import {
  createConsumerHarnessProbe,
  createTestModel,
} from '../harness/anchor-probe-consumer.ts';

/**
 * T-128 integration: a real primary ledger commits events, a read-only replica
 * applies them through the real replication path, `distributedProbe` answers in
 * QUORUM/COMMITTED mode and `judgeConsistency` gates the result. Lagging and
 * digest-tampered replicas are then pushed through `verifyContextDraft` and the
 * consumer's pre-execution gate. Every artifact stays free of Gate fields.
 */

const NOW = '2026-11-24T00:00:00.000Z';
const SCOPE = 'fixture';
const FACT_KEY = 'local.storage.engine';
const HASH = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_D = 'd'.repeat(64);

async function write(root: string, path: string, source: string): Promise<void> {
  const target = join(root, ...path.split('/'));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, source);
}

async function rootFor(t: TestContext, prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

interface Project {
  readonly root: string;
  readonly ledger: Ledger;
  readonly entries: readonly ViewReplayEntry[];
  readonly snapshot: AnchorProbeSnapshot;
  readonly request: AnchorProbeRequest;
}

/** A real project with one governed fact committed to the ledger. */
async function makeProject(t: TestContext): Promise<Project> {
  const root = await rootFor(t, 'ano-replica-consistency-');
  await write(root, 'package.json', JSON.stringify({ name: 'replica-consistency-fixture', private: true, type: 'module' }));
  const ledger = await Ledger.open(root, { sessionId: 'T128-PRIMARY', clock: () => 1_000 });
  // Close the SQLite handle before removing the tree (Windows EPERM/EBUSY).
  t.after(async () => {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  });
  const genesis = await ledger.append({
    kind: 'memory.revised',
    payload: {
      intent: 'revise',
      fact_key: FACT_KEY,
      record: { text: 'Local storage engine is SQLite.', kind: 'decision' },
      supersedes: [],
      reason: 'genesis',
      effective_from: null,
      effective_to: null,
    },
  }, 't128-genesis');
  assert.ok(genesis.event !== undefined, 'the fixture append must commit an event');
  const entries = replayLedger(join(root, '.ano', 'ledger')).entries;
  const snapshot: AnchorProbeSnapshot = {
    project_scope: SCOPE,
    ledger_digest: viewDigest(entries),
    graph_revision: null,
    source_fingerprint: null,
    connected_digest: null,
  };
  const request: AnchorProbeRequest = {
    schema_version: ANCHOR_PROBE_REQUEST_SCHEMA_VERSION,
    request_id: 'req-t128-1',
    root,
    project_scope: SCOPE,
    required_facts: [FACT_KEY],
    temporal_mode: 'CURRENT',
  } as AnchorProbeRequest;
  return { root, ledger, entries, snapshot, request };
}

/** Append one more committed event so the primary advances past the replica. */
async function advancePrimary(project: Project, text: string, idemKey: string): Promise<void> {
  const result = await project.ledger.append({
    kind: 'memory.revised',
    payload: {
      intent: 'revise',
      fact_key: 'local.storage.retention',
      record: { text, kind: 'decision' },
      supersedes: [],
      reason: 'second commit',
      effective_from: null,
      effective_to: null,
    },
  }, idemKey);
  assert.ok(result.event !== undefined);
}

function primaryStore(project: Project): ProbeStore {
  return ProjectedProbeStore.create(project.entries, project.snapshot);
}

function envelopesOf(project: Project): ReturnType<typeof exportCommittedEvents>['events'] {
  return exportCommittedEvents(project.ledger, { projectScope: SCOPE }).events;
}

function replicaNode(store: ProbeStore, replicaId: string, commitIndex: number) {
  return { replicaId, store, commitIndex, clusterEpoch: 'epoch-1' } as const;
}

/** Deterministic sampler so no Graph/Connect dependency is needed. */
function samplerFor(project: Project) {
  return (): AnchorProbeSnapshot => project.snapshot;
}

// ---------------------------------------------------------------------------
// real primary -> replica -> distributedProbe -> judgeConsistency
// ---------------------------------------------------------------------------

test('a replicated replica reaches the primary commit: QUORUM and COMMITTED judge consistent', async (t) => {
  const project = await makeProject(t);
  const pull = envelopesOf(project);
  const replica = ReplicaStore.open({
    root: project.root,
    replicaId: 'replica-0',
    projectScope: SCOPE,
    clusterEpoch: 'epoch-1',
  });
  t.after(() => replica.close());
  replica.applyCommitted(pull);

  const primary = primaryStore(project);
  const primaryDigest = computeEvidenceDigest(
    primary.candidates().map((candidate) => ({
      record_ref: candidate.record_ref,
      content_hash: candidate.content_hash,
      ...(candidate.fact_key === null ? {} : { fact_key: candidate.fact_key }),
      status: candidate.status,
    })),
  );
  const node = replicaNode(replica, 'replica-0', replica.commitIndex);

  const quorumAnswer = await distributedProbe(project.request, primary, [node], {
    mode: 'QUORUM',
    primaryCommitIndex: pull.length,
    primaryEvidenceDigest: primaryDigest,
    clusterEpoch: 'epoch-1',
    now: NOW,
  });
  assert.equal(quorumAnswer.metadata.mode, 'QUORUM');
  assert.equal(quorumAnswer.consistency, 'CONSISTENT');
  const quorumJudgement = judgeConsistency(quorumAnswer, {
    mode: 'QUORUM',
    primaryCommitIndex: pull.length,
    primaryEvidenceDigest: primaryDigest,
    maxLagThreshold: 0,
  });
  assert.equal(quorumJudgement.status, 'consistent');
  assert.equal(quorumJudgement.lag, 0);
  assert.doesNotThrow(() => assertExecutableContext(quorumJudgement));

  const committedAnswer = await distributedProbe(project.request, primary, [node], {
    mode: 'COMMITTED',
    primaryCommitIndex: pull.length,
    primaryEvidenceDigest: primaryDigest,
    clusterEpoch: 'epoch-1',
    now: NOW,
  });
  assert.equal(committedAnswer.metadata.mode, 'COMMITTED');
  const committedJudgement = judgeConsistency(committedAnswer, {
    mode: 'COMMITTED',
    primaryCommitIndex: pull.length,
    primaryEvidenceDigest: primaryDigest,
  });
  assert.equal(committedJudgement.status, 'consistent');
  assert.equal(committedJudgement.code, null);

  // The whole chain stays outside the Gate evidence channel.
  const serialized = JSON.stringify({ quorumJudgement, committedJudgement, quorumAnswer, committedAnswer });
  for (const key of ['"evidence_id"', '"verdict"', '"task_id"']) {
    assert.equal(serialized.includes(key), false, `distributed/consistency output must not carry ${key}`);
  }
});

test('a lagging replica makes the QUORUM judgement stale with the lag reported', async (t) => {
  const project = await makeProject(t);
  const firstPull = envelopesOf(project);
  const replica = ReplicaStore.open({
    root: project.root,
    replicaId: 'replica-lag',
    projectScope: SCOPE,
    clusterEpoch: 'epoch-1',
  });
  t.after(() => replica.close());
  replica.applyCommitted(firstPull);
  await advancePrimary(project, 'SQLite with FTS5', 't128-second');

  const advancedEntries = replayLedger(join(project.root, '.ano', 'ledger')).entries;
  const advancedSnapshot: AnchorProbeSnapshot = { ...project.snapshot, ledger_digest: viewDigest(advancedEntries) };
  const primary = ProjectedProbeStore.create(advancedEntries, advancedSnapshot);
  const node = replicaNode(replica, 'replica-lag', replica.commitIndex);

  const answer = await distributedProbe(project.request, primary, [node], {
    mode: 'QUORUM',
    primaryCommitIndex: advancedEntries.length,
    clusterEpoch: 'epoch-1',
    now: NOW,
  });
  assert.equal(answer.metadata.mode, 'QUORUM');
  assert.equal(answer.metadata.stale, true);
  assert.equal(answer.metadata.max_lag, 1);

  const judgement = judgeConsistency(answer, {
    mode: 'QUORUM',
    primaryCommitIndex: advancedEntries.length,
    maxLagThreshold: 0,
  });
  assert.equal(judgement.status, 'stale');
  assert.equal(judgement.code, 'QUORUM_LAGGING');
  assert.equal(judgement.lag, 1);
  assert.throws(() => assertExecutableContext(judgement), /QUORUM_LAGGING|HISTORICAL|stale/);
});

// ---------------------------------------------------------------------------
// tampered replica digest
// ---------------------------------------------------------------------------

/** Wraps a real replica but rewrites every candidate content hash. */
class TamperedReplicaStore implements ProbeStore {
  readonly snapshot: AnchorProbeSnapshot;
  private readonly inner: ProbeStore;

  constructor(inner: ProbeStore) {
    this.inner = inner;
    this.snapshot = inner.snapshot;
  }

  candidates(query?: ProbeEntryQuery): readonly ProbeCandidate[] {
    return this.inner.candidates(query).map((candidate) => ({ ...candidate, content_hash: HASH_D }));
  }

  adjacency(ref?: string): readonly ProbeEdge[] {
    return this.inner.adjacency(ref);
  }

  evidence(recordRef: string) {
    return this.inner.evidence(recordRef);
  }

  status(recordRef: string) {
    return this.inner.status(recordRef);
  }

  provenance(recordRef: string) {
    return this.inner.provenance(recordRef);
  }

  snapshotIdentity() {
    return this.inner.snapshotIdentity();
  }

  replicaCommitIndex(): number | undefined {
    return this.inner.replicaCommitIndex?.();
  }
}

test('a digest-tampered replica cannot form a quorum and is judged inconsistent', async (t) => {
  const project = await makeProject(t);
  const pull = envelopesOf(project);
  const honest = ReplicaStore.open({
    root: project.root,
    replicaId: 'replica-honest',
    projectScope: SCOPE,
    clusterEpoch: 'epoch-1',
  });
  const tampered = ReplicaStore.open({
    root: project.root,
    replicaId: 'replica-tampered',
    projectScope: SCOPE,
    clusterEpoch: 'epoch-1',
  });
  t.after(() => {
    honest.close();
    tampered.close();
  });
  honest.applyCommitted(pull);
  tampered.applyCommitted(pull);
  const tamperedStore = new TamperedReplicaStore(tampered);

  const primary = primaryStore(project);
  const primaryDigest = computeEvidenceDigest(
    primary.candidates().map((candidate) => ({
      record_ref: candidate.record_ref,
      content_hash: candidate.content_hash,
      ...(candidate.fact_key === null ? {} : { fact_key: candidate.fact_key }),
      status: candidate.status,
    })),
  );

  const answer = await distributedProbe(project.request, primary, [
    replicaNode(honest, 'replica-honest', honest.commitIndex),
    replicaNode(tamperedStore, 'replica-tampered', tampered.commitIndex),
  ], {
    mode: 'QUORUM',
    primaryCommitIndex: pull.length,
    primaryEvidenceDigest: primaryDigest,
    clusterEpoch: 'epoch-1',
    now: NOW,
  });
  // Two replicas with different digests cannot reach Q=2; the coordinator
  // explicitly downgrades instead of pretending a majority exists.
  assert.equal(answer.requested_mode, 'QUORUM');
  assert.equal(answer.metadata.mode, 'COMMITTED');
  assert.equal(answer.degraded, true);
  assert.equal(answer.metadata.stop_reason, 'QUORUM_UNMET');

  const judgement = judgeConsistency(answer, {
    mode: 'QUORUM',
    primaryCommitIndex: pull.length,
    primaryEvidenceDigest: primaryDigest,
  });
  assert.equal(judgement.status, 'inconsistent');
  assert.equal(judgement.code, 'MODE_UNMET');
  assert.throws(() => assertExecutableContext(judgement));

  // A local/primary current_snapshot that moved on blocks the same answer.
  const blocked = judgeConsistency(answer, {
    mode: 'QUORUM',
    primaryCommitIndex: pull.length,
    primaryEvidenceDigest: primaryDigest,
    currentSnapshot: { ...project.snapshot, ledger_digest: HASH_B },
  });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.code, 'CURRENT_SNAPSHOT_MISMATCH');
});

// ---------------------------------------------------------------------------
// context-verify integration
// ---------------------------------------------------------------------------

test('the context validator blocks an inconsistent judgement and reviews a stale one', async (t) => {
  const project = await makeProject(t);
  const probe = createConsumerHarnessProbe({
    ledger: project.ledger,
    projectScope: SCOPE,
    now: NOW,
    sampler: samplerFor(project),
  });
  const run = await probe.run({ request: project.request, now: NOW, attempt: 1 });
  const alias = run.manifest.active_evidence[0]?.ref;
  assert.ok(alias !== undefined, 'the frozen manifest must carry evidence');

  const draft = {
    schema_version: 'anchorprobe.draft.v1',
    context_id: run.manifest.context_id,
    project_scope: SCOPE,
    claims: [{
      id: 'C1',
      kind: 'CURRENT_FACT',
      fact_key: FACT_KEY,
      text: 'Local storage engine is SQLite.',
      evidence_refs: [alias],
      params: [],
    }],
    not_applicable: [],
    unresolved: [],
  };

  const base = verifyContextDraft({ manifest: run.manifest, draft, root: project.root, now: NOW });
  assert.equal(base.status, 'NEEDS_REVIEW');
  assert.equal(base.violations.some((violation) => violation.code.startsWith('consistency_')), false);

  const stale = verifyContextDraft({
    manifest: run.manifest,
    draft,
    root: project.root,
    now: NOW,
    consistency: {
      status: 'stale',
      mode: 'QUORUM',
      requested_mode: 'QUORUM',
      code: 'QUORUM_LAGGING',
      lag: 3,
      historical: false,
      stale: true,
      reasons: ['replica trails the primary'],
    },
  });
  assert.equal(stale.status, 'NEEDS_REVIEW');
  assert.notEqual(stale.status, 'ALLOW');
  assert.ok(stale.violations.some((violation) => violation.code === 'consistency_stale'));

  const inconsistent = verifyContextDraft({
    manifest: run.manifest,
    draft,
    root: project.root,
    now: NOW,
    consistency: {
      status: 'inconsistent',
      mode: 'COMMITTED',
      requested_mode: 'QUORUM',
      code: 'MODE_UNMET',
      lag: null,
      historical: false,
      stale: false,
      reasons: ['quorum unmet'],
    },
  });
  assert.equal(inconsistent.status, 'BLOCK');
  assert.ok(inconsistent.violations.some((violation) => violation.code === 'consistency_inconsistent'));

  const blocked = verifyContextDraft({
    manifest: run.manifest,
    draft,
    root: project.root,
    now: NOW,
    consistency: {
      status: 'blocked',
      mode: 'LOCAL',
      requested_mode: 'LOCAL',
      code: 'CURRENT_SNAPSHOT_MISMATCH',
      lag: null,
      historical: false,
      stale: false,
      reasons: ['ledger_digest differs'],
    },
  });
  assert.equal(blocked.status, 'BLOCK');
  assert.ok(blocked.violations.some((violation) => violation.code === 'consistency_blocked'));

  // Frozen cluster metadata follows the same boundary.
  const metadata = verifyContextDraft({
    manifest: run.manifest,
    draft,
    root: project.root,
    now: NOW,
    consistency: {
      schema_version: 'anchorprobe.cluster.v1',
      project_scope: SCOPE,
      cluster_epoch: 'epoch-1',
      commit_index: 1,
      replica_id: 'replica-0',
      replica_commit_index: 1,
      consistency: 'as_of',
      max_lag: 2,
      partial: true,
      failed_nodes: [],
      evidence_digest: HASH,
    },
  });
  assert.equal(metadata.status, 'NEEDS_REVIEW');
  assert.notEqual(metadata.status, 'ALLOW');
  assert.ok(metadata.violations.some((violation) => violation.code === 'consistency_historical'));
  assert.ok(metadata.violations.some((violation) => violation.code === 'consistency_stale'));

  const serialized = JSON.stringify({ base, stale, inconsistent, blocked, metadata });
  for (const key of ['"evidence_id"', '"verdict"', '"task_id"']) {
    assert.equal(serialized.includes(key), false);
  }
});

// ---------------------------------------------------------------------------
// consumer pre-execution gate
// ---------------------------------------------------------------------------

test('the consumer refuses to call the model on an inconsistent judgement and emits no Gate field', async (t) => {
  const project = await makeProject(t);
  const probe = createConsumerHarnessProbe({
    ledger: project.ledger,
    projectScope: SCOPE,
    now: NOW,
    sampler: samplerFor(project),
  });
  const model = createTestModel({ generate: () => ({}) });
  const judgement: ConsistencyJudgement = {
    status: 'inconsistent',
    mode: 'COMMITTED',
    requested_mode: 'QUORUM',
    code: 'MODE_UNMET',
    lag: null,
    historical: false,
    stale: false,
    reasons: ['quorum unmet after replica digest divergence'],
  };

  const result = await runConsumer({
    request: project.request,
    probe,
    model,
    now: NOW,
    consistency: judgement,
  });

  assert.equal(result.outcome, 'FAILED');
  assert.deepEqual(result.displayable_claims, []);
  assert.equal(result.failure !== null, true);
  assert.match(result.failure!.reason, /^consistency_inconsistent: MODE_UNMET$/);
  // Execution was stopped before any model call.
  assert.equal(model.generateCalls.length, 0);
  assert.equal(probe.runCount, 1);
  assert.equal(result.consistency?.status, 'inconsistent');
  assert.equal(result.consistency?.code, 'MODE_UNMET');

  const serialized = JSON.stringify(result);
  for (const key of ['"evidence_id"', '"verdict"', '"task_id"']) {
    assert.equal(serialized.includes(key), false);
  }
});

test('a stale judgement never releases displayable claims even if verification were permissive', async (t) => {
  const project = await makeProject(t);
  const probe = createConsumerHarnessProbe({
    ledger: project.ledger,
    projectScope: SCOPE,
    now: NOW,
    sampler: samplerFor(project),
  });
  const run = await probe.run({ request: project.request, now: NOW, attempt: 1 });
  const alias = run.manifest.active_evidence[0]?.ref as string;
  const model = createTestModel({
    generate: () => ({
      schema_version: 'anchorprobe.draft.v1',
      context_id: run.manifest.context_id,
      project_scope: SCOPE,
      claims: [{
        id: 'C1',
        kind: 'CURRENT_FACT',
        fact_key: FACT_KEY,
        text: 'Local storage engine is SQLite.',
        evidence_refs: [alias],
        params: [],
      }],
      not_applicable: [],
      unresolved: [],
    }),
  });

  const result = await runConsumer({
    request: project.request,
    probe,
    model,
    now: NOW,
    consistency: {
      status: 'stale',
      mode: 'QUORUM',
      requested_mode: 'QUORUM',
      code: 'MAX_LAG_EXCEEDED',
      lag: 4,
      historical: false,
      stale: true,
      reasons: ['max_lag 4 exceeds threshold 1'],
    },
  });

  assert.equal(result.outcome, 'NEEDS_REVIEW');
  assert.deepEqual(result.displayable_claims, []);
  assert.equal(model.generateCalls.length, 1);
  const serialized = JSON.stringify(result);
  for (const key of ['"evidence_id"', '"verdict"', '"task_id"']) {
    assert.equal(serialized.includes(key), false);
  }
});
