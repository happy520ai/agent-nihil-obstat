/**
 * T-130-ready red team (created by T-129) for the ADR-011 distributed-probe
 * boundary: cluster authorization, privacy minimization, revocation/cleanup,
 * remote-payload inertness and default-deny egress (§8, §9).
 *
 * Baseline eight classes:
 *   1. cross-scope replica refused (local policy + frozen ReplicaStore);
 *   2. unregistered replicaId refused;
 *   3. revoked replica refused and cleanup requires prior revocation;
 *   4. secret paths/fields are never copied by default (.env/keys/secrets and
 *      free-text secrets), with no content/hash leakage;
 *   5. remote scope/auth declarations cannot elevate local authorization;
 *   6. remote payloads are never executed (execSync/process.exit/eval stay
 *      inert and produce no side effect);
 *   7. no default egress (`disabled`) and enabling is rejected;
 *   8. audit records carry no secret content.
 *
 * Every scenario runs in a fresh `os.tmpdir()` root. Nothing writes this
 * repository's `.pm/`, `.ano/`, `src/` or user configuration, and
 * `D:/Temp/ano_probe` is never touched.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { canonicalJson, genesisHash, hashEvent, ledgerEventSchema, type LedgerEvent } from '../../src/ledger/event.ts';
import {
  distributedProbe,
  DistributedProbeError,
  type DistributedReplicaNode,
} from '../../src/memory/distributed-probe.ts';
import { judgeConsistency } from '../../src/memory/cluster-consistency.ts';
import {
  ANCHOR_PROBE_REQUEST_SCHEMA_VERSION,
  type AnchorProbeClusterMetadata,
  type AnchorProbeSnapshot,
} from '../../src/memory/probe-contract.ts';
import type { ProbeCandidate, ProbeEdge, ProbeEntryQuery } from '../../src/memory/probe.ts';
import {
  probeSnapshotIdentity,
  type ProbeEvidencePayload,
  type ProbeProvenanceView,
  type ProbeStatusView,
  type ProbeStore,
} from '../../src/memory/probe-store.ts';
import { committedEnvelopeFromEvent, ReplicationError, type CommittedEventEnvelope } from '../../src/memory/replication.ts';
import { ReplicaStore } from '../../src/memory/replica.ts';
import {
  assertClusterPolicy,
  assertReplicaApplicableEgress,
  authorizeReplica,
  cleanupReplica,
  CLUSTER_NETWORK_EGRESS_DISABLED,
  containsExecutableMarker,
  createDefaultClusterPolicy,
  filterEventsForReplica,
  parseRemotePayload,
  readClusterAudit,
  revokeReplica,
  verifyRevoked,
  type ClusterPolicy,
  type ClusterReplicaPolicy,
} from '../../src/memory/cluster-policy.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let ulidCounter = 0;
let physicalTick = 2_000_000;

function nextUlid(): string {
  ulidCounter += 1;
  let bits = BigInt(Date.now()) + BigInt(ulidCounter) * 1_000_003n;
  bits &= (1n << 128n) - 1n;
  let out = '';
  for (let index = 0; index < 26; index += 1) {
    out += ULID_ALPHABET[Number(bits & 31n)];
    bits >>= 5n;
  }
  return out;
}

function makeEnvelope(payload: Record<string, unknown>, seq: number): CommittedEventEnvelope {
  physicalTick += 1;
  const event: LedgerEvent = ledgerEventSchema.parse({
    id: nextUlid(),
    hlc: { physical: physicalTick, logical: 1, actor: 'red-team' },
    actor: 'red-team',
    kind: 'memory.revised',
    payload,
    prev_hash: genesisHash,
  });
  // committedEnvelopeFromEvent is imported above with the other frozen exports.
  return committedEnvelopeFromEvent(event, seq, 'red-seg');
}

async function makeRoot(t: TestContext, prefix = 'ano-distributed-rb-'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

function replica(replicaId: string, scopes: readonly string[], operations: readonly ('read' | 'apply' | 'revoke')[], revokedAt?: string): ClusterReplicaPolicy {
  return { replicaId, allowedScopes: scopes, operations, ...(revokedAt === undefined ? {} : { revokedAt }) };
}

function policy(root: string | undefined, replicas: readonly ClusterReplicaPolicy[], extra: Partial<ClusterPolicy> = {}): ClusterPolicy {
  return createDefaultClusterPolicy('proj-a', { ...(root === undefined ? {} : { root }), replicas, ...extra });
}

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: unknown }).code) : undefined;
}

function expectCode(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    assert.equal(codeOf(error), code, `expected ${code}, got ${String(error)}`);
    return;
  }
  assert.fail(`expected ${code} to be thrown`);
}

const SECRET_TEXT_MARKERS = [
  'ENV_SECRET_MARKER',
  'PEM_SECRET_MARKER',
  'KEY_SECRET_MARKER',
  'CREDENTIALS_SECRET_MARKER',
  'SECRETS_DIR_SECRET_MARKER',
  'api_key=ABC123',
  'hunter2',
];

const SECRET_PATHS = ['.env', '.env.local', 'keys/server.pem', 'keys/server.key', 'credentials.json', 'secrets/value.ts'];

// ---------------------------------------------------------------------------
// 1. Cross-scope replica is refused before any query
// ---------------------------------------------------------------------------

test('RB-01 cross-scope replica requests are refused with SCOPE_DENIED', async (t) => {
  const root = await makeRoot(t);
  const active = policy(root, [
    replica('r-alpha', ['proj-a'], ['read', 'apply']),
    replica('r-beta', ['proj-b'], ['read']),
  ]);

  const denied = authorizeReplica(active, 'r-alpha', 'read', 'proj-b');
  assert.equal(denied.allowed, false);
  assert.equal(denied.allowed === false ? denied.code : '', 'SCOPE_DENIED');

  const betaForeign = authorizeReplica(active, 'r-beta', 'read', 'proj-a');
  assert.equal(betaForeign.allowed, false);
  assert.equal(betaForeign.allowed === false ? betaForeign.code : '', 'SCOPE_DENIED');

  const allowed = authorizeReplica(active, 'r-alpha', 'read', 'proj-a');
  assert.equal(allowed.allowed, true);

  // The frozen ReplicaStore enforces the same boundary on an inbound batch.
  const store = ReplicaStore.open({ root, replicaId: 'r-alpha', projectScope: 'proj-a' });
  t.after(() => store.close());
  const envelope = makeEnvelope({ note: 'foreign scope' }, 1);
  expectCode(() => store.applyCommitted([envelope], { projectScope: 'proj-b' }), 'SCOPE_DENIED');
  assert.ok(envelope.event !== undefined);
});

// ---------------------------------------------------------------------------
// 2. Unregistered replicaId is refused
// ---------------------------------------------------------------------------

test('RB-02 an unregistered replicaId is refused with REPLICA_NOT_AUTHORIZED', () => {
  const active = policy(undefined, [replica('r-known', ['proj-a'], ['read', 'apply', 'revoke'])]);
  for (const ghost of ['r-ghost', 'primary', 'LOCAL', 'r-known/../r-known', 'r-known ']) {
    const decision = authorizeReplica(active, ghost, 'read', 'proj-a');
    assert.equal(decision.allowed, false, ghost);
    assert.equal(decision.allowed === false ? decision.code : '', 'REPLICA_NOT_AUTHORIZED', ghost);
  }
});

// ---------------------------------------------------------------------------
// 3. Revoked replica is refused; cleanup requires prior revocation
// ---------------------------------------------------------------------------

test('RB-03 revoked replicas are refused and cleanup refuses until revocation', async (t) => {
  const root = await makeRoot(t);
  const directory = join(root, '.ano', 'replicas', 'r-revoked');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'events.jsonl'), 'derived\n');

  const active = policy(root, [replica('r-revoked', ['proj-a'], ['read'])]);
  expectCode(() => cleanupReplica(root, 'r-revoked', active), 'REVOKE_REQUIRED');
  assert.equal(existsSync(directory), true, 'an unrevoked replica directory must survive a refused cleanup');

  const decision = authorizeReplica(active, 'r-revoked', 'read', 'proj-a');
  assert.equal(decision.allowed, true);

  const revoked = revokeReplica(active, 'r-revoked', { reason: 'decommissioned', actor: 'operator', at: '2026-11-24T01:02:03.000Z' });
  const revokedDecision = authorizeReplica(revoked, 'r-revoked', 'read', 'proj-a');
  assert.equal(revokedDecision.allowed, false);
  assert.equal(revokedDecision.allowed === false ? revokedDecision.code : '', 'REPLICA_REVOKED');
  assert.equal(verifyRevoked(revoked, 'r-revoked').revoked, true);

  const report = cleanupReplica(root, 'r-revoked', revoked, { at: '2026-11-24T01:03:00.000Z' });
  assert.equal(report.verifiedAbsent, true);
  assert.equal(existsSync(directory), false);
});

// ---------------------------------------------------------------------------
// 4. Secret paths/fields are not copied by default
// ---------------------------------------------------------------------------

test('RB-04 secret paths and fields are never replicated in the default deny mode', async (t) => {
  const root = await makeRoot(t);
  // Real secret fixture proves the module never reads source-tree secrets.
  const fixture: Record<string, string> = {
    '.env': 'ENV_SECRET_MARKER=1\n',
    'keys/server.pem': 'PEM_SECRET_MARKER\n',
    'keys/server.key': 'KEY_SECRET_MARKER\n',
    'credentials.json': 'CREDENTIALS_SECRET_MARKER\n',
    'secrets/value.ts': 'SECRETS_DIR_SECRET_MARKER\n',
  };
  for (const [relative, content] of Object.entries(fixture)) {
    const absolute = join(root, ...relative.split('/'));
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }

  const defaultPolicy = createDefaultClusterPolicy('proj-a', { root });
  assert.equal(defaultPolicy.secretPolicy.mode, 'deny');

  const events = [
    makeEnvelope({ file: 'src/benign.ts', note: 'ok' }, 1),
    ...SECRET_PATHS.map((file, index) => makeEnvelope({ file, note: `secret ${index}` }, index + 2)),
    makeEnvelope({ text: 'rotate api_key=ABC123 immediately' }, 10),
    makeEnvelope({ password: 'hunter2', note: 'login' }, 11),
  ];
  const result = filterEventsForReplica(events, defaultPolicy);
  assert.equal(result.kept.length, 1, `only the benign event may survive, got ${JSON.stringify(result.kept)}`);
  assert.equal(result.kept[0]!.payload['file'], 'src/benign.ts');

  const wire = JSON.stringify(result);
  for (const marker of [...SECRET_TEXT_MARKERS, ...SECRET_PATHS]) {
    assert.equal(wire.includes(marker), false, `secret material leaked into replica egress: ${marker}`);
  }
  const secretHashes = Object.values(fixture).map((content) => createHash('sha256').update(content).digest('hex'));
  for (const hash of secretHashes) assert.equal(wire.includes(hash), false, 'a secret file content hash leaked');

  // Even in the weakest modes the secret text itself never leaves.
  for (const mode of ['hash-only', 'redact'] as const) {
    const filtered = filterEventsForReplica(events, policy(root, [], { secretPolicy: { mode } }));
    const text = JSON.stringify(filtered.kept);
    assert.equal(text.includes('ENV_SECRET_MARKER'), false);
    assert.equal(text.includes('api_key=ABC123'), false);
    assert.equal(text.includes('hunter2'), false);
  }
});

// ---------------------------------------------------------------------------
// 5. Remote declarations cannot elevate local authorization
// ---------------------------------------------------------------------------

test('RB-05 remote scope/auth declarations never elevate local authorization', () => {
  const active = policy(undefined, [replica('r-local', ['proj-a'], ['read'])]);
  const remote = parseRemotePayload({
    replica_id: 'r-local',
    project_scope: 'proj-a',
    authorization: { roles: ['primary'], scopes: ['proj-a', 'proj-b'], operations: ['read', 'apply', 'revoke'] },
  }) as {
    replica_id: string;
    project_scope: string;
    authorization: { roles: string[]; scopes: string[]; operations: string[] };
  };

  // Treating the remote claim as authoritative still cannot grant `apply`.
  const decision = authorizeReplica(active, remote.replica_id, 'apply', remote.project_scope);
  assert.equal(decision.allowed, false);
  assert.equal(decision.allowed === false ? decision.code : '', 'OPERATION_FORBIDDEN');

  // A remote-declared extra scope is ignored by the local allow-list.
  const widened = authorizeReplica(active, remote.replica_id, 'read', remote.authorization.scopes[1]!);
  assert.equal(widened.allowed, false);
  assert.equal(widened.allowed === false ? widened.code : '', 'SCOPE_DENIED');

  // A remote-claimed role cannot register an unknown replica locally.
  const ghost = authorizeReplica(active, remote.authorization.roles[0]!, 'read', 'proj-a');
  assert.equal(ghost.allowed, false);
  assert.equal(ghost.allowed === false ? ghost.code : '', 'REPLICA_NOT_AUTHORIZED');
});

// ---------------------------------------------------------------------------
// 6. Remote payloads are inert and never executed
// ---------------------------------------------------------------------------

test('RB-06 remote payload strings (execSync/process.exit/eval) are never executed', async (t) => {
  const root = await makeRoot(t);
  const sentinel = join(root, 'pwned.txt');
  const payload = {
    script: `require('child_process').execSync('node -e "require(\\'fs\\').writeFileSync(\\'${sentinel}\\', \\'pwned\\')"')`,
    exit: 'process.exit(1)',
    evaluator: 'globalThis.eval("1+1")',
    nested: [{ marker: 'new Function("return 1")()' }],
  };

  const parsed = parseRemotePayload(payload) as typeof payload;
  assert.equal(parsed.exit, 'process.exit(1)');
  assert.equal(existsSync(sentinel), false, 'remote payload was executed');
  assert.equal(process.exitCode, undefined);

  // Routing the hostile text through replication egress keeps it inert: the
  // module treats the payload as data and produces no filesystem side effect.
  const filtered = filterEventsForReplica([makeEnvelope(payload, 1)], createDefaultClusterPolicy('proj-a', { root }));
  assert.equal(existsSync(sentinel), false, 'hostile text produced a side effect');
  assert.equal(typeof filtered.kept.length, 'number');

  // Static boundary: the policy module imports no evaluation/network module
  // and contains no dynamic import/evaluation call site.
  const source = readFileSync(new URL('../../src/memory/cluster-policy.ts', import.meta.url), 'utf8');
  const specifiers = [...source.matchAll(/from\s+'([^']+)'/gu)].map((match) => match[1]!);
  assert.ok(specifiers.length > 0);
  for (const specifier of specifiers) {
    const allowed = specifier.startsWith('./') || specifier.startsWith('../')
      || ['node:crypto', 'node:fs', 'node:path'].includes(specifier);
    assert.equal(allowed, true, `unexpected import in cluster-policy: ${specifier}`);
  }
  // Mask comments and string literals, then assert no call-site primitive.
  const codeOnly = source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/\/\/[^\n]*/gu, '')
    .replace(/'[^']*'/gu, "''")
    .replace(/"[^"]*"/gu, '""');
  for (const forbidden of ['import(', 'node:net', 'node:http', 'node:dns', 'node:tls', 'child_process', 'eval(', 'new Function', 'execSync', '.listen(']) {
    assert.equal(codeOnly.includes(forbidden), false, `cluster-policy source contains a forbidden primitive: ${forbidden}`);
  }
});

// ---------------------------------------------------------------------------
// 7. Default-deny network egress
// ---------------------------------------------------------------------------

test('RB-07 network egress is disabled by default and enabling is rejected', () => {
  const defaults = createDefaultClusterPolicy('proj-a');
  assert.equal(defaults.networkEgress, CLUSTER_NETWORK_EGRESS_DISABLED);
  assert.equal(CLUSTER_NETWORK_EGRESS_DISABLED, 'disabled');

  for (const attempt of [{ networkEgress: 'enabled' }, { networkEgress: 'tcp' }, { networkEgress: 'websocket' }]) {
    expectCode(() => assertClusterPolicy({ ...defaults, ...attempt } as unknown), 'EGRESS_FORBIDDEN');
  }
  assert.doesNotThrow(() => assertClusterPolicy({ ...defaults, networkEgress: 'disabled' }));

  // The module ships no network implementation at all (static check).
  const source = readFileSync(new URL('../../src/memory/cluster-policy.ts', import.meta.url), 'utf8');
  for (const forbidden of ['createServer', 'Socket', 'fetch(', 'XMLHttpRequest']) {
    assert.equal(source.includes(forbidden), false, `network implementation token present: ${forbidden}`);
  }
});

// ---------------------------------------------------------------------------
// 8. Audit records carry no secret content
// ---------------------------------------------------------------------------

test('RB-08 revocation/cleanup audit records exclude secret content', async (t) => {
  const root = await makeRoot(t);
  const secretPayload = { file: '.env', text: 'api_key=ABC123', password: 'hunter2' };
  const digest = createHash('sha256').update(canonicalJson(secretPayload)).digest('hex');
  const directory = join(root, '.ano', 'replicas', 'r-sensitive');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'cursor.json'), `${JSON.stringify(secretPayload)}\n`);

  const base = policy(root, [
    replica('r-sensitive', ['proj-a', 'secrets-scope'], ['read', 'apply']),
  ]);
  const revoked = revokeReplica(base, 'r-sensitive', { reason: 'compromise', actor: 'alice', at: '2026-11-24T05:00:00.000Z' });
  const report = cleanupReplica(root, 'r-sensitive', revoked, { at: '2026-11-24T05:01:00.000Z', actor: 'alice' });

  assert.ok(report.fileCount >= 1);
  const auditText = readFileSync(join(root, '.ano', 'cluster', 'audit.jsonl'), 'utf8');
  const records = readClusterAudit(revoked, { fallbackRoot: root });
  assert.equal(records.length, 2);
  for (const marker of ['.env', 'api_key=ABC123', 'hunter2', 'secrets-scope', digest]) {
    assert.equal(auditText.includes(marker), false, `audit leaked secret material: ${marker}`);
  }
  // Cleanup audits metadata only: no replica content, no scope list.
  const cleanupRecord = records.find((record) => record.kind === 'replica.cleanup')!;
  assert.equal(typeof cleanupRecord.manifestDigest, 'string');
  assert.equal(cleanupRecord.totalBytes! > 0, true);
  assert.equal(JSON.stringify(cleanupRecord).includes('"payload"'), false);

  // The pre-delete manifest matches the directory that existed before removal.
  assert.equal(report.manifestDigest, cleanupRecord.manifestDigest);
  assert.equal(existsSync(directory), false);
});

// ---------------------------------------------------------------------------
// Shared red-team contract: explicit codes, fail-closed, no silent success
// ---------------------------------------------------------------------------

test('RB-09 refusals are explicit ClusterPolicyError/ReplicationError codes', async (t) => {
  const root = await makeRoot(t);
  const active = policy(root, [replica('r-x', ['proj-a'], ['read'])]);
  assert.throws(() => cleanupReplica(root, 'r-x', active), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(codeOf(error), 'REVOKE_REQUIRED');
    return true;
  });
  const ghost = authorizeReplica(active, 'r-y', 'read', 'proj-a');
  assert.equal(ghost.allowed, false);
  assert.equal(ghost.allowed === false ? ghost.code : '', 'REPLICA_NOT_AUTHORIZED');
  // Malformed policy fails closed rather than defaulting to permissive.
  expectCode(() => assertClusterPolicy({ projectScope: 'p', replicas: 'nope', secretPolicy: { mode: 'deny' }, maxPayloadBytes: 1 }), 'CONFIG_INVALID');
  expectCode(() => assertClusterPolicy({ projectScope: 'p', replicas: [replica('r', ['p'], ['read'])], secretPolicy: { mode: 'open' }, maxPayloadBytes: 1 }), 'CONFIG_INVALID');
  expectCode(() => assertClusterPolicy({ projectScope: 'p', replicas: [replica('r', ['p'], ['read'])], secretPolicy: { mode: 'deny' }, maxPayloadBytes: 0 }), 'CONFIG_INVALID');
  // Replication errors from the frozen boundary remain explicit.
  assert.ok(new ReplicationError('REPLICA_REDACTED_EVENT', 'x') instanceof ReplicationError);
});

// ---------------------------------------------------------------------------
// T-130 red-team additions (append-only; RB-01..RB-09 above are unchanged):
// forged replica escalation, inert poisoned payloads, mixed-version refusal,
// missing-segment honesty and real child-process cleanup.
// ---------------------------------------------------------------------------

const RB_HASH_A = 'a'.repeat(64);
const RB_HASH_B = 'b'.repeat(64);
const WORKER_PATH = fileURLToPath(new URL('../../src/memory/replica-worker.ts', import.meta.url));

function rbDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rbWaitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await rbDelay(10);
  }
  assert.fail(`timed out waiting for ${label}`);
}

function rbProcessExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function rbSnap(commitIndex: number, overrides: Partial<AnchorProbeClusterMetadata> = {}): AnchorProbeSnapshot {
  const metadata: AnchorProbeClusterMetadata = {
    schema_version: 'anchorprobe.cluster.v1',
    project_scope: 'proj-a',
    cluster_epoch: 'epoch-1',
    commit_index: commitIndex,
    replica_id: 'local',
    replica_commit_index: commitIndex,
    consistency: 'local',
    max_lag: null,
    partial: false,
    failed_nodes: [],
    evidence_digest: RB_HASH_A,
    ...overrides,
  };
  return {
    project_scope: metadata.project_scope,
    ledger_digest: RB_HASH_A,
    graph_revision: null,
    source_fingerprint: RB_HASH_B,
    connected_digest: null,
    cluster: metadata,
  };
}

function rbRecord(recordRef: string, content: string): ProbeCandidate {
  return {
    record_ref: recordRef,
    fact_key: 'local.storage.engine',
    task_id: null,
    file: null,
    symbol: null,
    source: { kind: 'native_note' },
    source_health: 'verified_at_snapshot',
    status: 'active',
    content,
    content_hash: RB_HASH_A,
    recorded_at: '2026-11-21T00:00:00.000Z',
    effective_from: null,
    effective_to: null,
    superseded_by: null,
    version: null,
    anchor: { status: 'none', file: null },
    qualifiers: [],
  };
}

class RbFakeStore implements ProbeStore {
  private readonly records: readonly ProbeCandidate[];
  private readonly snap: AnchorProbeSnapshot;

  constructor(records: readonly ProbeCandidate[], snap: AnchorProbeSnapshot) {
    this.records = records;
    this.snap = snap;
  }

  get snapshot(): AnchorProbeSnapshot {
    return this.snap;
  }

  candidates(query?: ProbeEntryQuery): readonly ProbeCandidate[] {
    if (query === undefined || Object.keys(query).length === 0) return this.records;
    return this.records.filter((record) => query.fact_key === undefined || record.fact_key === query.fact_key);
  }

  adjacency(): readonly ProbeEdge[] {
    return [];
  }

  evidence(recordRef: string): ProbeEvidencePayload | undefined {
    const record = this.find(recordRef);
    return record === undefined
      ? undefined
      : {
        record_ref: record.record_ref,
        content_hash: record.content_hash,
        status: record.status,
        source_health: record.source_health,
        recorded_at: record.recorded_at,
        effective_from: record.effective_from,
        source: record.source,
        content: record.content,
      };
  }

  status(recordRef: string): ProbeStatusView | undefined {
    const record = this.find(recordRef);
    return record === undefined
      ? undefined
      : {
        record_ref: record.record_ref,
        status: record.status,
        eligibility: record.qualifiers.includes('legacy_unreviewed') ? 'legacy_unreviewed' : 'governed',
        version: record.version,
        superseded_by: record.superseded_by,
        effective_from: record.effective_from,
        effective_to: record.effective_to,
      };
  }

  provenance(recordRef: string): ProbeProvenanceView | undefined {
    const record = this.find(recordRef);
    return record === undefined
      ? undefined
      : {
        record_ref: record.record_ref,
        source: record.source,
        source_health: record.source_health,
        qualifiers: record.qualifiers,
        anchor: record.anchor,
      };
  }

  snapshotIdentity() {
    return probeSnapshotIdentity(this.snap);
  }

  replicaCommitIndex(): number | undefined {
    return this.snap.cluster?.replica_commit_index;
  }

  private find(recordRef: string): ProbeCandidate | undefined {
    return this.records.find((record) => record.record_ref === recordRef);
  }
}

function rbRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: ANCHOR_PROBE_REQUEST_SCHEMA_VERSION,
    request_id: 'rb-req',
    root: 'F:/project',
    project_scope: 'proj-a',
    required_facts: ['local.storage.engine'],
    ...overrides,
  };
}

function rbOutcome(answer: Awaited<ReturnType<typeof distributedProbe>>, replicaId: string): string {
  const report = answer.nodes.find((node) => node.replica_id === replicaId);
  assert.ok(report !== undefined, `missing node report for ${replicaId}`);
  return report.outcome;
}

test('RB-10 a forged replica cannot impersonate an authorized node or fabricate quorum evidence', async () => {
  const local = new RbFakeStore([rbRecord('r-primary', 'primary-A')], rbSnap(3));
  const legit: DistributedReplicaNode = {
    replicaId: 'r-legit',
    store: new RbFakeStore([rbRecord('r-primary', 'primary-A')], rbSnap(3, { replica_id: 'r-legit' })),
    projectScope: 'proj-a',
    query: async () => ({ candidates: [rbRecord('r-primary', 'primary-A')], commitIndex: 3 }),
  };

  // A second node reusing an authorized replicaId is refused before any query.
  const impersonator: DistributedReplicaNode = { ...legit };
  await assert.rejects(
    () => distributedProbe(rbRequest(), local, [legit, impersonator], { mode: 'QUORUM', primaryCommitIndex: 3 }),
    (error: unknown) => error instanceof DistributedProbeError && error.code === 'DISTRIBUTED_PROBE_OPTIONS_INVALID',
  );

  // Cross-scope forgery is refused without querying the foreign node.
  const foreign: DistributedReplicaNode = { ...legit, replicaId: 'r-foreign', projectScope: 'proj-b' };
  const foreignAnswer = await distributedProbe(rbRequest(), local, [legit, foreign], { mode: 'QUORUM', primaryCommitIndex: 3 });
  assert.equal(rbOutcome(foreignAnswer, 'r-foreign'), 'SCOPE_DENIED');

  // A fabricated evidence digest cannot back a quorum claim.
  const liar: DistributedReplicaNode = {
    ...legit,
    replicaId: 'r-liar',
    store: new RbFakeStore([rbRecord('r-primary', 'primary-A')], rbSnap(3, { replica_id: 'r-liar' })),
    query: async () => ({ candidates: [rbRecord('r-primary', 'primary-A')], commitIndex: 3, evidenceDigest: 'f'.repeat(64) }),
  };
  const liarAnswer = await distributedProbe(rbRequest(), local, [legit, liar], { mode: 'QUORUM', primaryCommitIndex: 3 });
  assert.equal(rbOutcome(liarAnswer, 'r-liar'), 'VIEW_DIGEST_MISMATCH');

  // An epoch forger is refused before its bytes can join the quorum.
  const epochLiar: DistributedReplicaNode = {
    ...legit,
    replicaId: 'r-epoch-liar',
    query: async () => ({ candidates: [rbRecord('r-primary', 'primary-A')], commitIndex: 3, clusterEpoch: 'epoch-9' }),
  };
  const epochAnswer = await distributedProbe(rbRequest(), local, [legit, epochLiar], {
    mode: 'QUORUM',
    primaryCommitIndex: 3,
    clusterEpoch: 'epoch-1',
  });
  assert.equal(rbOutcome(epochAnswer, 'r-epoch-liar'), 'CLUSTER_EPOCH_MISMATCH');
  assert.notEqual(epochAnswer.metadata.consistency, 'CONSISTENT');
});

test('RB-11 poisoned remote payloads stay inert and minimized egress can never reproduce a view', async (t) => {
  const root = await makeRoot(t);
  const sentinel = join(root, 'pwned.txt');
  const script = `require('child_process').execSync('node -e "require(\\'fs\\').writeFileSync(\\'${sentinel}\\', \\'pwned\\')"')`;
  const parsed = parseRemotePayload({ script, evaluator: 'globalThis.eval("1+1")', nested: [{ marker: 'new Function("return 1")()' }] });
  assert.equal(Object.isFrozen(parsed), true, 'remote payload must be a frozen copy');
  assert.equal(containsExecutableMarker(parsed), true);
  assert.equal(existsSync(sentinel), false, 'poisoned remote payload was executed');

  // Deny mode drops secret material but carries hostile text as inert data.
  const denied = filterEventsForReplica([
    { seq: 1, eventId: 'EV-POISON', hash: RB_HASH_A, kind: 'note.recorded', payload: { file: '.env', text: 'ENV_SECRET_MARKER' } },
    { seq: 2, eventId: 'EV-HOSTILE', hash: RB_HASH_B, kind: 'note.recorded', payload: { text: script } },
  ], policy(root, []));
  assert.equal(denied.kept.length, 1);
  assert.equal(denied.kept[0]!.eventId, 'EV-HOSTILE');
  assert.equal(JSON.stringify(denied).includes('ENV_SECRET_MARKER'), false);
  assert.equal(existsSync(sentinel), false);

  // hash-only egress is explicitly non-applicable to a replica view.
  const minimized = filterEventsForReplica([
    { seq: 1, eventId: 'EV-MIN', hash: RB_HASH_A, kind: 'note.recorded', payload: { file: '.env', text: 'ENV_SECRET_MARKER' } },
  ], policy(root, [], { secretPolicy: { mode: 'hash-only' } }));
  assert.equal(minimized.kept.length, 1);
  assert.equal(minimized.kept[0]!.contentMinimized, true);
  expectCode(() => assertReplicaApplicableEgress(minimized.kept[0]!), 'REPLICA_REDACTED_EVENT');
});

test('RB-12 mixed replica versions surface conflicts and judge inconsistent, never COMPLETE', async () => {
  const local = new RbFakeStore([rbRecord('r-x', 'A')], rbSnap(3));
  const full: DistributedReplicaNode = {
    replicaId: 'r-full',
    store: new RbFakeStore([rbRecord('r-x', 'A')], rbSnap(3, { replica_id: 'r-full' })),
    projectScope: 'proj-a',
    query: async () => ({ candidates: [rbRecord('r-x', 'A')], commitIndex: 3 }),
  };
  const lagging: DistributedReplicaNode = {
    replicaId: 'r-lagging',
    store: new RbFakeStore([rbRecord('r-y', 'B')], rbSnap(2, { replica_id: 'r-lagging' })),
    projectScope: 'proj-a',
    query: async () => ({ candidates: [rbRecord('r-y', 'B')], commitIndex: 2 }),
  };
  const answer = await distributedProbe(rbRequest(), local, [full, lagging], { mode: 'QUORUM', primaryCommitIndex: 3 });
  assert.ok(answer.conflicts.some((conflict) => conflict.kind === 'commit'), 'divergent commits must stay visible');
  assert.equal(answer.metadata.mode, 'COMMITTED');
  assert.equal(answer.degraded, true);
  assert.notEqual(answer.metadata.consistency, 'CONSISTENT');
  const judgement = judgeConsistency(answer, { mode: 'QUORUM', primaryCommitIndex: 3 });
  assert.equal(judgement.status, 'inconsistent');
  assert.equal(judgement.code, 'MODE_UNMET');

  // Epoch divergence between otherwise healthy nodes is an explicit conflict.
  const epochA: DistributedReplicaNode = {
    ...full,
    replicaId: 'r-epoch-a',
    query: async () => ({ candidates: [rbRecord('r-x', 'A')], commitIndex: 3, clusterEpoch: 'epoch-1' }),
  };
  const epochB: DistributedReplicaNode = {
    ...full,
    replicaId: 'r-epoch-b',
    query: async () => ({ candidates: [rbRecord('r-x', 'A')], commitIndex: 3, clusterEpoch: 'epoch-2' }),
  };
  const epochAnswer = await distributedProbe(rbRequest(), local, [epochA, epochB], { mode: 'QUORUM', primaryCommitIndex: 3 });
  assert.ok(epochAnswer.conflicts.some((conflict) => conflict.kind === 'cluster_epoch'));
  assert.notEqual(epochAnswer.metadata.consistency, 'CONSISTENT');
});

test('RB-13 a permanently missing segment is never reported COMPLETE across reopen', async (t) => {
  const root = await makeRoot(t);
  let previous = genesisHash;
  const envelopes: CommittedEventEnvelope[] = [];
  for (let index = 1; index <= 3; index += 1) {
    physicalTick += 1;
    const event: LedgerEvent = ledgerEventSchema.parse({
      id: nextUlid(),
      hlc: { physical: physicalTick, logical: 1, actor: 'rb-missing' },
      actor: 'rb-missing',
      kind: 'memory.revised',
      idem_key: `rb-missing-${String(index)}`,
      payload: {
        intent: 'revise',
        fact_key: `local.missing.${String(index)}`,
        record: { text: `value ${String(index)}`, kind: 'decision', anchor: { file: 'src/rb.ts', symbolId: 'sym-rb' } },
        supersedes: [],
        reason: 'genesis',
        effective_from: null,
        effective_to: null,
      },
      prev_hash: previous,
    });
    previous = hashEvent(event);
    envelopes.push(committedEnvelopeFromEvent(event, index, 'rb-missing-seg'));
  }

  const replica = ReplicaStore.open({ root, replicaId: 'r-missing', projectScope: 'proj-a' });
  t.after(() => replica.close());
  const report = replica.applyCommitted(envelopes.slice(1));
  assert.equal(report.commitIndex, 0);
  assert.deepEqual(report.gaps, [1]);
  assert.equal(report.complete, false);
  assert.equal(replica.clusterMetadata().partial, true);
  assert.deepEqual(replica.candidates(), []);
  assert.equal(replica.resumePullRequest().fromCommitIndex, 0);
  replica.close();

  const reopened = ReplicaStore.open({ root, replicaId: 'r-missing', projectScope: 'proj-a' });
  t.after(() => reopened.close());
  assert.equal(reopened.commitIndex, 0, 'the cursor must not advance over a permanent gap');
  assert.equal(reopened.clusterMetadata().partial, true);
  const again = reopened.applyCommitted(envelopes.slice(1));
  assert.equal(again.duplicates, 2);
  assert.equal(again.commitIndex, 0);
  assert.equal(again.complete, false);
});

test('RB-14 a SIGKILLed worker leaves no live process once stdio is released', { timeout: 60_000 }, async (t) => {
  const root = await makeRoot(t);
  const child = spawn(process.execPath, [WORKER_PATH], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pid = child.pid;
  assert.ok(pid !== undefined, 'worker pid must exist');
  child.stdin.on('error', () => {});
  const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
  child.stdin.write(`${JSON.stringify({ type: 'init', id: 'rb-cleanup-init', payload: { root, replicaId: 'r-rb-cleanup', projectScope: 'proj-a' } })}\n`);
  await rbWaitFor(() => rbProcessExists(pid), 5_000, 'worker startup');
  assert.equal(child.kill('SIGKILL'), true);
  await exited;
  await rbWaitFor(() => rbProcessExists(pid) === false, 2_000, 'worker reaping');
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
  child.unref();
  assert.equal(rbProcessExists(pid), false, 'a killed worker must not survive stdio cleanup');
});

// ---------------------------------------------------------------------------
// CV-04 red-team additions: untrusted replica payloads are validated before
// they can join a quorum; unserviceable and snapshot-less nodes are never
// silently counted as evidence.
// ---------------------------------------------------------------------------

function probeNode(id: string, query: DistributedReplicaNode['query'], overrides: Partial<DistributedReplicaNode> = {}): DistributedReplicaNode {
  return {
    replicaId: id,
    store: new RbFakeStore([rbRecord('r-primary', 'A')], rbSnap(3, { replica_id: id })),
    ...overrides,
    query,
  } as DistributedReplicaNode;
}

test('RB-15 a node whose store cannot produce a snapshot is NODE_UNAVAILABLE', async () => {
  const local = new RbFakeStore([rbRecord('r-primary', 'A')], rbSnap(3));
  const node: DistributedReplicaNode = {
    replicaId: 'r-broken-snapshot',
    store: {
      get snapshot(): AnchorProbeSnapshot {
        throw new Error('snapshot directory missing');
      },
      candidates: () => [],
      adjacency: () => [],
    } as unknown as ProbeStore,
    commitIndex: 3,
  };
  const answer = await distributedProbe(rbRequest(), local, [node], { mode: 'QUORUM', primaryCommitIndex: 3 });
  const report = answer.nodes.find((entry) => entry.replica_id === 'r-broken-snapshot');
  assert.equal(report?.outcome, 'NODE_UNAVAILABLE');
  assert.match(report?.detail ?? '', /snapshot unavailable/u);
  assert.deepEqual(answer.partial.failed_nodes, ['r-broken-snapshot']);
});

test('RB-16 malformed remote payloads are refused before joining any quorum', async () => {
  const local = new RbFakeStore([rbRecord('r-primary', 'A')], rbSnap(3));
  const cases: Array<{ id: string; query: DistributedReplicaNode['query']; detail: RegExp }> = [
    {
      id: 'r-null-response',
      query: async () => null as unknown as never,
      detail: /candidates array/u,
    },
    {
      id: 'r-bad-edges',
      query: async () => ({ candidates: [rbRecord('r-primary', 'A')], edges: {} as unknown as ProbeEdge[], commitIndex: 3 }),
      detail: /edges must be an array/u,
    },
    {
      id: 'r-bad-candidate',
      query: async () => ({ candidates: [{ nope: true } as unknown as ProbeCandidate], commitIndex: 3 }),
      detail: /malformed candidate/u,
    },
    {
      id: 'r-bad-digest-input',
      query: async () => ({ candidates: [{ record_ref: 'r-x' } as unknown as ProbeCandidate], commitIndex: 3 }),
      detail: /failed digest recomputation/u,
    },
  ];

  for (const item of cases) {
    const answer = await distributedProbe(rbRequest(), local, [probeNode(item.id, item.query)], {
      mode: 'COMMITTED',
      primaryCommitIndex: 3,
    });
    const report = answer.nodes.find((entry) => entry.replica_id === item.id);
    assert.equal(report?.outcome, 'NODE_UNAVAILABLE', item.id);
    assert.match(report?.detail ?? '', item.detail);
    assert.ok(answer.partial.failed_nodes.includes(item.id), item.id);
  }
});

test('RB-17 replicas in a non-serviceable state are refused without being trusted', async () => {
  const local = new RbFakeStore([rbRecord('r-primary', 'A')], rbSnap(3));
  const states = ['REVOKED', 'FAILED', 'SUSPECT', 'JOINING'] as const;
  for (const state of states) {
    const answer = await distributedProbe(
      rbRequest(),
      local,
      [probeNode(`r-${state.toLowerCase()}`, async () => ({ candidates: [rbRecord('r-primary', 'A')], commitIndex: 3, state }))],
      { mode: 'COMMITTED', primaryCommitIndex: 3 },
    );
    const report = answer.nodes.find((entry) => entry.replica_id === `r-${state.toLowerCase()}`);
    assert.equal(report?.outcome, 'NODE_UNAVAILABLE', state);
    assert.match(report?.detail ?? '', /not serviceable/u);
  }
});
