/**
 * T-129 / DC-07: cluster authorization, privacy minimization and auditable
 * replica revocation/cleanup (ADR-011 §9).
 *
 * Every scenario runs against injected local policy objects in a fresh
 * `os.tmpdir()` project. Refusals are asserted as explicit codes; remote
 * declarations are shown to be structurally incapable of elevating local
 * authorization; no network, subprocess or eval path is exercised.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { canonicalJson, genesisHash, ledgerEventSchema, type LedgerEvent } from '../../src/ledger/event.ts';
import { applyEventBatch, committedEnvelopeFromEvent, committedEnvelopeIssue, emptyReplicaApplyState, ReplicationError, type CommittedEventEnvelope } from '../../src/memory/replication.ts';
import {
  appendClusterAudit,
  assertClusterPolicy,
  assertClusterReplicaId,
  assertReplicaApplicableEgress,
  authorizeReplica,
  cleanupReplica,
  CLUSTER_DEFAULT_MAX_PAYLOAD_BYTES,
  CLUSTER_NETWORK_EGRESS_DISABLED,
  CLUSTER_OPERATIONS,
  CLUSTER_SECRET_MODES,
  containsExecutableMarker,
  createDefaultClusterPolicy,
  filterEventsForReplica,
  isReplicaApplicableEgress,
  loadClusterPolicy,
  parseRemotePayload,
  readClusterAudit,
  revokeReplica,
  serializeClusterPolicy,
  verifyRevoked,
  type ClusterEgressEvent,
  type ClusterPolicy,
  type ClusterReplicaPolicy,
  type ClusterReplicaEventInput,
} from '../../src/memory/cluster-policy.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let ulidCounter = 0;
let physicalTick = 1_000_000;
let seqCounter = 0;

function nextUlid(): string {
  ulidCounter += 1;
  let bits = BigInt(Date.now()) + BigInt(ulidCounter);
  bits &= (1n << 128n) - 1n;
  let out = '';
  for (let index = 0; index < 26; index += 1) {
    out += ULID_ALPHABET[Number(bits & 31n)];
    bits >>= 5n;
  }
  return out;
}

function makeEvent(prevHash: string, kind: LedgerEvent['kind'], payload: Record<string, unknown>): LedgerEvent {
  physicalTick += 1;
  return ledgerEventSchema.parse({
    id: nextUlid(),
    hlc: { physical: physicalTick, logical: 1, actor: 'cluster-policy-unit' },
    actor: 'cluster-policy-unit',
    kind,
    payload,
    prev_hash: prevHash,
  });
}

function makeEnvelope(payload: Record<string, unknown>, kind: LedgerEvent['kind'] = 'memory.revised'): CommittedEventEnvelope {
  seqCounter += 1;
  const event = makeEvent(genesisHash, kind, payload);
  return committedEnvelopeFromEvent(event, seqCounter, 'unit-seg');
}

async function makeRoot(t: TestContext, prefix = 'ano-cluster-policy-'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

function replica(
  replicaId: string,
  allowedScopes: readonly string[],
  operations: readonly ClusterReplicaPolicy['operations'][number][],
  revokedAt?: string,
): ClusterReplicaPolicy {
  return { replicaId, allowedScopes, operations, ...(revokedAt === undefined ? {} : { revokedAt }) };
}

function policyWith(root: string | undefined, replicas: readonly ClusterReplicaPolicy[], extra: Partial<ClusterPolicy> = {}): ClusterPolicy {
  return createDefaultClusterPolicy('proj-a', {
    ...(root === undefined ? {} : { root }),
    replicas,
    ...extra,
  });
}

function errorWithCode(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof Error, `expected an Error, got ${String(error)}`);
    assert.equal((error as { code?: unknown }).code, code, `expected ${code}, got ${String((error as Error).message)}`);
    return;
  }
  assert.fail(`expected ${code} to be thrown`);
}

function assertReplicationCode(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof ReplicationError, `expected ReplicationError, got ${String(error)}`);
    assert.equal(error.code, code);
    return;
  }
  assert.fail(`expected ReplicationError ${code} to be thrown`);
}

function egressKeys(record: ClusterEgressEvent): string[] {
  return Object.keys(record).sort();
}

const SECRET_MARKERS = ['.env', 'server.pem', 'credentials.json', 'secrets/value.ts', 'api_key', 'hunter2'];

// ---------------------------------------------------------------------------
// 1. Authorization matrix (replica x scope x operation), fail-closed codes
// ---------------------------------------------------------------------------

test('T-129/01 authorization matrix covers replica/scope/operation dimensions', () => {
  const policy = policyWith(undefined, [
    replica('r-read', ['proj-a'], ['read']),
    replica('r-apply', ['proj-a', 'proj-b'], ['read', 'apply']),
    replica('r-full', ['proj-a'], [...CLUSTER_OPERATIONS]),
  ]);

  const allowed = authorizeReplica(policy, 'r-read', 'read', 'proj-a');
  assert.equal(allowed.allowed, true);

  const forbidden = authorizeReplica(policy, 'r-read', 'apply', 'proj-a');
  assert.equal(forbidden.allowed, false);
  if (!forbidden.allowed) assert.equal(forbidden.code, 'OPERATION_FORBIDDEN');

  const crossScope = authorizeReplica(policy, 'r-apply', 'read', 'proj-x');
  assert.equal(crossScope.allowed, false);
  if (!crossScope.allowed) assert.equal(crossScope.code, 'SCOPE_DENIED');

  const unknown = authorizeReplica(policy, 'r-ghost', 'read', 'proj-a');
  assert.equal(unknown.allowed, false);
  if (!unknown.allowed) assert.equal(unknown.code, 'REPLICA_NOT_AUTHORIZED');

  // No scope argument: only the replica registry and its operations matter.
  assert.equal(authorizeReplica(policy, 'r-read', 'read').allowed, true);
  const noScopeApply = authorizeReplica(policy, 'r-read', 'apply');
  assert.equal(noScopeApply.allowed, false);
});

test('T-129/02 a revoked replica is refused before scope/operation checks', async (t) => {
  const root = await makeRoot(t);
  const base = policyWith(root, [replica('r-revoke-me', ['proj-a'], ['read', 'apply'])]);
  const revoked = revokeReplica(base, 'r-revoke-me', { reason: 'compromise', actor: 'alice', at: '2026-11-24T00:00:00.000Z' });
  const decision = authorizeReplica(revoked, 'r-revoke-me', 'read', 'proj-a');
  assert.equal(decision.allowed, false);
  if (!decision.allowed) assert.equal(decision.code, 'REPLICA_REVOKED');
  // Even a wrong scope reports the revocation first: deterministic order.
  const revokedWrongScope = authorizeReplica(revoked, 'r-revoke-me', 'read', 'proj-other');
  assert.equal(revokedWrongScope.allowed, false);
  if (!revokedWrongScope.allowed) assert.equal(revokedWrongScope.code, 'REPLICA_REVOKED');
});

test('T-129/03 malformed replica ids are refused as CONFIG_INVALID', () => {
  for (const bad of ['', '../escape', 'a/b', 'x'.repeat(129), 'a b']) {
    errorWithCode(() => assertClusterReplicaId(bad), 'CONFIG_INVALID');
  }
  assert.equal(assertClusterReplicaId('r-ok'), 'r-ok');
});

// ---------------------------------------------------------------------------
// 2. Privacy: three modes over secret paths and text
// ---------------------------------------------------------------------------

test('T-129/04 deny mode (default) never copies secret-path or sensitive-text events', () => {
  const policy = createDefaultClusterPolicy('proj-a');
  assert.equal(policy.secretPolicy.mode, 'deny');
  const envelopes = [
    makeEnvelope({ note: 'plain decision', file: 'src/a.ts' }),
    makeEnvelope({ file: '.env' }),
    makeEnvelope({ file: 'secrets/value.ts' }),
    makeEnvelope({ file: 'keys/server.pem' }),
    makeEnvelope({ file: 'credentials.json' }),
    makeEnvelope({ text: 'rotate the api_key please' }),
    makeEnvelope({ password: 'hunter2' }),
  ];
  const result = filterEventsForReplica(envelopes, policy);
  assert.equal(result.mode, 'deny');
  assert.equal(result.kept.length, 1);
  assert.equal(result.kept[0]!.payload['file'], 'src/a.ts');
  assert.equal(result.dropped.length, 6);
  assert.ok(result.dropped.every((drop) => drop.code === 'SECRET_PATH_EXCLUDED' || drop.code === 'SENSITIVE_CONTENT_EXCLUDED'));
  const wire = JSON.stringify(result.kept);
  for (const marker of SECRET_MARKERS) assert.equal(wire.includes(marker), false, `secret marker leaked: ${marker}`);
  const secretHashes = envelopes.slice(1).map((envelope) => createHash('sha256').update(canonicalJson(envelope.payload)).digest('hex'));
  for (const hash of secretHashes) assert.equal(wire.includes(hash), false, 'secret content hash leaked');
});

test('T-129/05 hash-only emits identity plus content hash and no text', () => {
  const payload = { file: '.env.local', text: 'ENV_SECRET_MARKER=1' };
  const envelope = makeEnvelope(payload);
  const plain = makeEnvelope({ file: 'src/a.ts' });
  const policy = policyWith(undefined, [], { secretPolicy: { mode: 'hash-only' } });
  const result = filterEventsForReplica([envelope, plain], policy);
  assert.equal(result.kept.length, 2);
  const minimized = result.kept.find((record) => record.eventId === envelope.eventId)!;
  assert.equal(minimized.contentMinimized, true);
  assert.deepEqual(minimized.payload, {});
  assert.equal(minimized.contentHash, createHash('sha256').update(canonicalJson(payload)).digest('hex'));
  assert.equal(isReplicaApplicableEgress(minimized), false);
  const full = result.kept.find((record) => record.eventId === plain.eventId)!;
  assert.equal(full.contentMinimized, false);
  assert.deepEqual(full.payload, { file: 'src/a.ts' });
  const wire = JSON.stringify(result.kept);
  for (const marker of ['.env.local', 'ENV_SECRET_MARKER']) assert.equal(wire.includes(marker), false, `text leaked in hash-only mode: ${marker}`);
});

test('T-129/06 redact marks records non-applicable and the frozen applier refuses them', () => {
  const payload = { file: 'src/a.ts', text: 'keep this', api_key: 'ABC123', nested: { password: 'hunter2' } };
  const envelope = makeEnvelope(payload);
  const policy = policyWith(undefined, [], { secretPolicy: { mode: 'redact' } });
  const result = filterEventsForReplica([envelope], policy);
  assert.equal(result.kept.length, 1);
  const redacted = result.kept[0]!;
  assert.equal(redacted.contentRedacted, true);
  assert.equal(redacted.payload['text'], 'keep this');
  assert.equal(redacted.payload['api_key'], '[REDACTED]');
  assert.equal((redacted.payload['nested'] as Record<string, unknown>)['password'], '[REDACTED]');
  assert.equal(isReplicaApplicableEgress(redacted), false);
  assertReplicationCode(() => assertReplicaApplicableEgress(redacted), 'REPLICA_REDACTED_EVENT');

  // The frozen replication boundary independently rejects redacted envelopes.
  const redactedEnvelope: CommittedEventEnvelope = { ...envelope, contentRedacted: true };
  assert.match(committedEnvelopeIssue(redactedEnvelope) ?? '', /contentRedacted/);
  assertReplicationCode(() => applyEventBatch(emptyReplicaApplyState(), [redactedEnvelope]), 'REPLICA_REDACTED_EVENT');
});

test('T-129/07 redact preserves non-sensitive fields and sensitive field names are caught', () => {
  const policy = policyWith(undefined, [], { secretPolicy: { mode: 'redact' } });
  const result = filterEventsForReplica([
    makeEnvelope({ fact_key: 'engine', record: 'SQLite', credential: 'CRED_MARKER', note: 'ok' }),
  ], policy);
  const record = result.kept[0]!;
  assert.equal(record.payload['fact_key'], 'engine');
  assert.equal(record.payload['record'], 'SQLite');
  assert.equal(record.payload['note'], 'ok');
  assert.equal(record.payload['credential'], '[REDACTED]');
  assert.equal(JSON.stringify(result.kept).includes('CRED_MARKER'), false);
});

// ---------------------------------------------------------------------------
// 3. Minimal evidence: whitelist, internal-field stripping, size ceiling
// ---------------------------------------------------------------------------

test('T-129/08 egress whitelist strips internal envelope fields', () => {
  const envelope = makeEnvelope({ file: 'src/a.ts' });
  const input = {
    ...envelope,
    event: envelope.event,
    cursor: { commitIndex: 7 },
    debugStack: 'internal',
    __internal: { session: 'unit' },
  } as unknown as ClusterReplicaEventInput;
  const policy = createDefaultClusterPolicy('proj-a');
  const result = filterEventsForReplica([input], policy);
  assert.deepEqual(egressKeys(result.kept[0]!), [
    'contentMinimized',
    'contentRedacted',
    'eventId',
    'hash',
    'kind',
    'payload',
    'prevHash',
    'recordedAt',
    'segment',
    'seq',
  ]);
  const wire = JSON.stringify(result.kept);
  assert.equal(wire.includes('cursor'), false);
  assert.equal(wire.includes('debugStack'), false);
  assert.equal(wire.includes('__internal'), false);
  assert.equal(wire.includes('cluster-policy-unit'), false, 'internal actor bytes were stripped with the event field');
});

test('T-129/09 optional payload field whitelist trims non-evidence payload fields', () => {
  const envelope = makeEnvelope({ fact_key: 'engine', record: 'SQLite', internal_note: 'scratch' });
  const policy = createDefaultClusterPolicy('proj-a');
  const result = filterEventsForReplica([envelope], policy, { payloadFieldWhitelist: ['fact_key', 'record'] });
  assert.deepEqual(result.kept[0]!.payload, { fact_key: 'engine', record: 'SQLite' });
  assert.equal(JSON.stringify(result.kept).includes('internal_note'), false);
});

test('T-129/10 oversized records are refused, never truncated', () => {
  const policy = policyWith(undefined, [], { maxPayloadBytes: 512 });
  assert.equal(CLUSTER_DEFAULT_MAX_PAYLOAD_BYTES, 16 * 1024 * 1024);
  const big = makeEnvelope({ text: 'x'.repeat(4096) });
  const ok = makeEnvelope({ text: 'small' });
  const result = filterEventsForReplica([big, ok], policy);
  assert.equal(result.kept.length, 1);
  assert.equal(result.kept[0]!.eventId, ok.eventId);
  assert.equal(result.dropped.length, 1);
  assert.equal(result.dropped[0]!.code, 'PAYLOAD_LIMIT_EXCEEDED');
  assert.equal(result.dropped[0]!.reason.includes('without truncation'), true);
});

test('T-129/11 malformed events are dropped as EVENT_INVALID', () => {
  const policy = createDefaultClusterPolicy('proj-a');
  const result = filterEventsForReplica([{ seq: 0, eventId: 'x', hash: 'y', kind: 'z', payload: {} }], policy);
  assert.equal(result.kept.length, 0);
  assert.equal(result.dropped[0]!.code, 'EVENT_INVALID');
});

// ---------------------------------------------------------------------------
// 4. Revocation, verification, cleanup and audit
// ---------------------------------------------------------------------------

test('T-129/12 revocation writes an audit record without secret content and is verifiable', async (t) => {
  const root = await makeRoot(t);
  const base = policyWith(root, [replica('r-a', ['proj-a'], ['read'])]);
  const revoked = revokeReplica(base, 'r-a', {
    reason: 'credential compromise',
    actor: 'alice',
    at: '2026-11-24T02:03:04.000Z',
  });
  assert.equal(verifyRevoked(revoked, 'r-a').revoked, true);
  assert.equal(verifyRevoked(revoked, 'r-a').revokedAt, '2026-11-24T02:03:04.000Z');
  assert.equal(verifyRevoked(revoked, 'r-missing').revoked, false);
  // Best-effort reflection onto the caller's handle.
  assert.equal(verifyRevoked(base, 'r-a').revoked, true);

  const auditPath = join(root, '.ano', 'cluster', 'audit.jsonl');
  assert.equal(existsSync(auditPath), true);
  const records = readClusterAudit(revoked);
  assert.equal(records.length, 1);
  assert.equal(records[0]!.kind, 'replica.revoke');
  assert.equal(records[0]!.replicaId, 'r-a');
  assert.equal(records[0]!.actor, 'alice');
  const raw = readFileSync(auditPath, 'utf8');
  for (const marker of ['.env', 'server.pem', 'hunter2', 'ENV_SECRET']) assert.equal(raw.includes(marker), false, `audit leaked ${marker}`);

  // Idempotent second revocation keeps the original timestamp.
  const again = revokeReplica(revoked, 'r-a', { reason: 'again', actor: 'bob', at: '2026-11-24T03:00:00.000Z' });
  assert.equal(verifyRevoked(again, 'r-a').revokedAt, '2026-11-24T02:03:04.000Z');
  assert.equal(readClusterAudit(again).length, 2);
});

test('T-129/13 cleanup refuses an unrevoked replica, then deletes and verifies', async (t) => {
  const root = await makeRoot(t);
  const directory = join(root, '.ano', 'replicas', 'r-clean');
  mkdirSync(join(directory, 'nested'), { recursive: true });
  writeFileSync(join(directory, 'events.jsonl'), 'one\n');
  writeFileSync(join(directory, 'cursor.json'), '{"commitIndex":1}\n');
  writeFileSync(join(directory, 'nested', 'cache.db'), 'x'.repeat(128));

  const active = policyWith(root, [replica('r-clean', ['proj-a'], ['read'])]);
  errorWithCode(() => cleanupReplica(root, 'r-clean', active), 'REVOKE_REQUIRED');
  assert.equal(existsSync(directory), true, 'unrevoked cleanup must not delete anything');

  const revoked = revokeReplica(active, 'r-clean', { reason: 'decommission', actor: 'operator', at: '2026-11-24T04:00:00.000Z' });
  const report = cleanupReplica(root, 'r-clean', revoked, { at: '2026-11-24T04:01:00.000Z', actor: 'operator' });
  assert.equal(report.existed, true);
  assert.equal(report.verifiedAbsent, true);
  assert.equal(report.fileCount, 3);
  assert.ok(report.totalBytes > 0);
  assert.match(report.manifestDigest, /^[a-f0-9]{64}$/u);
  assert.equal(existsSync(directory), false);

  const audit = readClusterAudit(revoked, { fallbackRoot: root });
  const cleanupRecord = audit.find((record) => record.kind === 'replica.cleanup');
  assert.ok(cleanupRecord, 'cleanup must be audited');
  assert.equal(cleanupRecord!.fileCount, 3);
  assert.equal(cleanupRecord!.totalBytes, report.totalBytes);
  assert.equal(cleanupRecord!.manifestDigest, report.manifestDigest);
  const raw = JSON.stringify(audit);
  assert.equal(raw.includes('one'), false, 'audit carried replica content');

  // Idempotent second cleanup succeeds with existed=false.
  const second = cleanupReplica(root, 'r-clean', revoked);
  assert.equal(second.existed, false);
  assert.equal(second.verifiedAbsent, true);
});

test('T-129/14 cleanup refuses a replica missing from the local policy', async (t) => {
  const root = await makeRoot(t);
  const policy = policyWith(root, []);
  errorWithCode(() => cleanupReplica(root, 'r-unknown', policy), 'REPLICA_NOT_AUTHORIZED');
});

test('T-129/15 audit log is bounded by entry count and byte size', async (t) => {
  const root = await makeRoot(t);
  const policy = policyWith(root, [], { auditMaxEntries: 3, auditMaxBytes: 4096 });
  for (let index = 0; index < 6; index += 1) {
    appendClusterAudit(policy, {
      at: `2026-11-24T00:00:0${String(index)}.000Z`,
      kind: 'policy.load',
      replicaId: `r-${String(index)}`,
      actor: 'tester',
    });
  }
  const bounded = readClusterAudit(policy);
  assert.equal(bounded.length, 3);
  assert.equal(bounded.at(-1)!.replicaId, 'r-5');

  const tiny = policyWith(root, [], { auditLogPath: join(root, 'tiny-audit.jsonl'), auditMaxBytes: 200, auditMaxEntries: 100 });
  for (let index = 0; index < 4; index += 1) {
    appendClusterAudit(tiny, {
      at: `2026-11-24T00:00:0${String(index)}.000Z`,
      kind: 'policy.load',
      replicaId: `r-${String(index)}`,
      actor: 'tester',
      detail: 'x'.repeat(80),
    });
  }
  const tinyText = readFileSync(join(root, 'tiny-audit.jsonl'), 'utf8');
  assert.ok(Buffer.byteLength(tinyText, 'utf8') <= 200, `audit exceeded byte cap: ${Buffer.byteLength(tinyText, 'utf8')}`);

  const impossible = policyWith(root, [], { auditLogPath: join(root, 'impossible.jsonl'), auditMaxBytes: 20 });
  errorWithCode(() => appendClusterAudit(impossible, {
    at: '2026-11-24T00:00:00.000Z',
    kind: 'policy.load',
    replicaId: 'r-1',
    actor: 'tester',
  }), 'AUDIT_LIMIT_EXCEEDED');
});

test('T-129/16 corrupt audit logs fail closed', async (t) => {
  const root = await makeRoot(t);
  const policy = policyWith(root, []);
  mkdirSync(join(root, '.ano', 'cluster'), { recursive: true });
  writeFileSync(join(root, '.ano', 'cluster', 'audit.jsonl'), '{ not json\n');
  errorWithCode(() => readClusterAudit(policy), 'AUDIT_LOG_CORRUPT');
});

// ---------------------------------------------------------------------------
// 5. Remote payloads are inert; remote claims cannot elevate authorization
// ---------------------------------------------------------------------------

test('T-129/17 remote payloads are parsed as bounded inert data and never executed', async (t) => {
  const sentinel = join(tmpdir(), `ano-cluster-policy-sentinel-${process.pid}.txt`);
  const remote = {
    script: `require('child_process').execSync('node -e "require(\\'fs\\').writeFileSync(\\'${sentinel}\\', \\'pwned\\')"')`,
    exit: 'process.exit(1)',
    dynamic: 'new Function("return 1")()',
    nested: { values: [1, 'two', null, false] },
  };
  const parsed = parseRemotePayload(remote);
  assert.deepEqual(parsed, JSON.parse(JSON.stringify(remote)));
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(containsExecutableMarker(parsed), true);
  assert.equal(existsSync(sentinel), false, 'a remote string was executed');
  assert.equal(process.exitCode, undefined);

  errorWithCode(() => parseRemotePayload({ tooBig: 'x'.repeat(1024) }, { maxBytes: 16 }), 'PAYLOAD_LIMIT_EXCEEDED');
  errorWithCode(() => parseRemotePayload({ fn: () => 1 }), 'REMOTE_PAYLOAD_INVALID');
  errorWithCode(() => parseRemotePayload({ a: [{ b: [{ c: [{ d: 1 }] }] }] }, { maxDepth: 2 }), 'PAYLOAD_LIMIT_EXCEEDED');
  errorWithCode(() => parseRemotePayload({ list: new Array(8).fill(1) }, { maxArrayLength: 4 }), 'PAYLOAD_LIMIT_EXCEEDED');
});

test('T-129/18 remote authorization declarations cannot elevate local authorization', () => {
  const policy = policyWith(undefined, [replica('r-read', ['proj-a'], ['read'])]);
  const remoteClaims = parseRemotePayload({
    replicaId: 'r-read',
    authorization: { scopes: ['proj-a'], operations: ['read', 'apply', 'revoke'] },
    project_scope: 'proj-a',
  }) as { replicaId: string; authorization: { scopes: string[]; operations: string[] }; project_scope: string };

  // The caller must resolve identity/scope locally. Feeding the remote
  // declaration back as if it were authoritative still fails.
  const apply = authorizeReplica(policy, remoteClaims.replicaId, 'apply', remoteClaims.project_scope);
  assert.equal(apply.allowed, false);
  if (!apply.allowed) assert.equal(apply.code, 'OPERATION_FORBIDDEN');

  // A remote-claimed replica id that is not registered stays unauthorized.
  const ghost = authorizeReplica(policy, 'r-remote-declared', 'read', 'proj-a');
  assert.equal(ghost.allowed, false);
  if (!ghost.allowed) assert.equal(ghost.code, 'REPLICA_NOT_AUTHORIZED');

  // A remote-claimed foreign scope cannot widen the local scope list.
  const widened = authorizeReplica(policy, 'r-read', 'read', 'proj-remote-declared');
  assert.equal(widened.allowed, false);
  if (!widened.allowed) assert.equal(widened.code, 'SCOPE_DENIED');
});

// ---------------------------------------------------------------------------
// 6. Default-deny egress configuration
// ---------------------------------------------------------------------------

test('T-129/19 network egress defaults to disabled and enabling is rejected', () => {
  const policy = createDefaultClusterPolicy('proj-a');
  assert.equal(policy.networkEgress, CLUSTER_NETWORK_EGRESS_DISABLED);
  for (const mode of ['enabled', 'tcp', 'websocket', true] as const) {
    errorWithCode(() => assertClusterPolicy({ ...policy, networkEgress: mode } as unknown), 'EGRESS_FORBIDDEN');
  }
  // Explicitly disabled (or absent) is accepted.
  assert.equal(assertClusterPolicy({ ...policy, networkEgress: 'disabled' }), undefined);
  assert.equal(assertClusterPolicy({ projectScope: 'p', replicas: [replica('r', ['p'], ['read'])], secretPolicy: { mode: 'deny' }, maxPayloadBytes: 1024 }), undefined);
});

test('T-129/20 policy serialization round-trips through the local file form', () => {
  const policy = policyWith(undefined, [replica('r-a', ['proj-a'], ['read', 'apply'])], { secretPolicy: { mode: 'redact' } });
  const loaded = loadClusterPolicy(serializeClusterPolicy(policy));
  assert.deepEqual(loaded, policy);
  assert.equal(CLUSTER_SECRET_MODES.includes(loaded.secretPolicy.mode), true);
  errorWithCode(() => loadClusterPolicy('{ nope'), 'CONFIG_INVALID');
  errorWithCode(() => loadClusterPolicy(JSON.stringify({ ...policy, maxPayloadBytes: 0 })), 'CONFIG_INVALID');
});

// ---------------------------------------------------------------------------
// T-153：授权拒绝与策略/审计残余分支
// ---------------------------------------------------------------------------

test('T-153 策略结构非法值与未知操作逐项拒绝', () => {
  const base = policyWith(undefined, [replica('r-a', ['proj-a'], ['read'])]);
  errorWithCode(() => assertClusterPolicy({ ...base, replicas: [{ ...base.replicas[0]!, allowedScopes: [] }] }), 'CONFIG_INVALID');
  errorWithCode(() => assertClusterPolicy({ ...base, replicas: [{ ...base.replicas[0]!, allowedScopes: [''] }] }), 'CONFIG_INVALID');
  errorWithCode(() => assertClusterPolicy({ ...base, replicas: [{ ...base.replicas[0]!, operations: [] }] }), 'CONFIG_INVALID');
  errorWithCode(() => assertClusterPolicy({ ...base, replicas: [{ ...base.replicas[0]!, operations: ['bogus'] }] }), 'CONFIG_INVALID');
  errorWithCode(() => assertClusterPolicy({ ...base, replicas: [{ ...base.replicas[0]!, revokedAt: 'not-a-date' }] }), 'CONFIG_INVALID');
  errorWithCode(() => authorizeReplica(base, 'r-a', 'bogus' as never), 'OPERATION_FORBIDDEN');
});

test('T-153 redact 覆盖敏感字段名正则、嵌套数组与原始值', () => {
  const policy = policyWith(undefined, [], { secretPolicy: { mode: 'redact' } });
  const payload = {
    my_secret: 'MARKER',
    list: ['keep', '.env'],
    nested: { deep: [1, 'token=abc'] },
    count: 3,
  };
  const result = filterEventsForReplica([makeEnvelope(payload)], policy);
  const record = result.kept[0]!;
  assert.equal(record.contentRedacted, true);
  assert.equal(record.payload['my_secret'], '[REDACTED]');
  assert.deepEqual(record.payload['list'], ['keep', '[REDACTED]']);
  assert.deepEqual((record.payload['nested'] as Record<string, unknown>)['deep'], [1, '[REDACTED]']);
  assert.equal(record.payload['count'], 3);
  assert.equal(JSON.stringify(result.kept).includes('MARKER'), false);
  assert.equal(JSON.stringify(result.kept).includes('token=abc'), false);
});

test('T-153 egress 记录尺寸上限在三种模式下均拒绝且不截断', () => {
  const plain = policyWith(undefined, [], { maxPayloadBytes: 300 });
  const plainResult = filterEventsForReplica([makeEnvelope({ text: 'x'.repeat(220) })], plain);
  assert.equal(plainResult.kept.length, 0);
  assert.equal(plainResult.dropped[0]?.code, 'PAYLOAD_LIMIT_EXCEEDED');
  assert.match(plainResult.dropped[0]?.reason ?? '', /record exceeds maxPayloadBytes/u);

  const hashOnly = policyWith(undefined, [], { maxPayloadBytes: 200, secretPolicy: { mode: 'hash-only' } });
  const hashResult = filterEventsForReplica([makeEnvelope({ file: '.env', note: 'x' })], hashOnly);
  assert.equal(hashResult.kept.length, 0);
  assert.equal(hashResult.dropped[0]?.code, 'PAYLOAD_LIMIT_EXCEEDED');

  const redact = policyWith(undefined, [], { maxPayloadBytes: 200, secretPolicy: { mode: 'redact' } });
  const redactResult = filterEventsForReplica([makeEnvelope({ file: '.env', note: 'x' })], redact);
  assert.equal(redactResult.kept.length, 0);
  assert.equal(redactResult.dropped[0]?.code, 'PAYLOAD_LIMIT_EXCEEDED');
});

test('T-153 revoke 需要授权时先拒绝；冻结策略的反映回写安全失败', async (t) => {
  const root = await makeRoot(t);
  const base = policyWith(root, [replica('r-a', ['proj-a'], ['read'])]);
  errorWithCode(
    () => revokeReplica(base, 'r-a', { reason: 'compromise', actor: 'alice', requireAuthorization: true }),
    'OPERATION_FORBIDDEN',
  );
  const allowedPolicy = policyWith(root, [replica('r-b', ['proj-a'], ['read', 'revoke'])]);
  const allowed = revokeReplica(allowedPolicy, 'r-b', { reason: 'compromise', actor: 'alice', requireAuthorization: true });
  assert.equal(allowed.replicas[0]?.revokedAt !== undefined, true);

  const frozen = Object.freeze(policyWith(root, [replica('r-c', ['proj-a'], ['read'])]));
  const next = revokeReplica(frozen, 'r-c', { reason: 'compromise', actor: 'alice' });
  assert.equal(next.replicas[0]?.revokedAt !== undefined, true);
});

test('T-153 cleanup 将目录当文件枚举失败与符号链接清单条目', async (t) => {
  const root = await makeRoot(t);
  const policy = policyWith(root, [replica('r-a', ['proj-a'], ['read'])]);
  const revoked = revokeReplica(policy, 'r-a', { reason: 'cleanup', actor: 'alice' });

  const directory = join(root, '.ano', 'replicas', 'r-a');
  mkdirSync(join(root, '.ano', 'replicas'), { recursive: true });
  writeFileSync(directory, 'not a directory');
  errorWithCode(() => cleanupReplica(root, 'r-a', revoked), 'REPLICA_DIRECTORY_UNSAFE');

  await rm(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(root, 'link-target.txt'), 'target');
  symlinkSync(join(root, 'link-target.txt'), join(directory, 'link.txt'));
  const report = cleanupReplica(root, 'r-a', revoked);
  assert.equal(report.fileCount, 1);
  assert.equal(existsSync(directory), false);
});

test('T-153 审计路径缺失/摘要非法/fileCount 负数逐项 CONFIG_INVALID', async (t) => {
  const rootless = createDefaultClusterPolicy('proj-a');
  const record = { at: '2026-11-24T02:03:04.000Z', kind: 'replica.revoke' as const, replicaId: 'r-a', actor: 'alice' };
  errorWithCode(() => appendClusterAudit(rootless, record), 'CONFIG_INVALID');

  const root = await makeRoot(t);
  const policy = policyWith(root, [replica('r-a', ['proj-a'], ['read'])]);
  errorWithCode(() => appendClusterAudit(policy, { ...record, manifestDigest: 'zz' }), 'CONFIG_INVALID');
  errorWithCode(() => appendClusterAudit(policy, { ...record, fileCount: -1 }), 'CONFIG_INVALID');
});

test('T-153 remote payload 键数上限与可执行标记原始值分支', () => {
  errorWithCode(() => parseRemotePayload({ a: 1, b: 2 }, { maxKeys: 1 }), 'PAYLOAD_LIMIT_EXCEEDED');
  assert.equal(containsExecutableMarker(42), false);
  assert.equal(containsExecutableMarker(null), false);
});
