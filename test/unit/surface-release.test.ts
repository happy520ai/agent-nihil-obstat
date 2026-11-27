import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { Ledger } from '../../src/ledger/ledger.ts';
import { sha256Canonical } from '../../src/readiness/hash.ts';
import type { AttestationRecord } from '../../src/readiness/types.ts';
import {
  ledgerAttestationProvenance,
  recordReleaseVerdict,
  verifyReleaseSurface,
} from '../../src/surface/readiness.ts';

async function temp(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function write(root: string, path: string, content: string | Buffer): Promise<void> {
  const absolute = join(root, ...path.split('/'));
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
}

async function project(): Promise<{ root: string; artifactPath: string; artifactHash: string }> {
  const root = await temp('ano surface release unit ');
  await write(root, 'package.json', JSON.stringify({ name: 'unit-fixture', version: '1.0.0', private: true }));
  await write(root, 'src/index.ts', 'export const one = 1;\n');
  const bytes = Buffer.from('synthetic artifact bytes\n', 'utf8');
  await write(root, 'artifact.tgz', bytes);
  return { root, artifactPath: 'artifact.tgz', artifactHash: createHash('sha256').update(bytes).digest('hex') };
}

function attestation(id: string, overrides: Partial<AttestationRecord> = {}): AttestationRecord {
  return {
    schema: 1,
    id,
    requirement_ids: ['common.release-owner'],
    profile_ids: ['common'],
    release_target: '1.0.0',
    signer: { name: 'Unit Owner', role: 'Maintainer' },
    signed_at: '2026-01-01T00:00:00.000Z',
    expires_at: '2026-06-01T00:00:00.000Z',
    artifact_hash: 'a'.repeat(64),
    statement: 'Synthetic unit fixture.',
    ...overrides,
  };
}

test('release surface validates target, profiles and artifact input before reading anything', async (t) => {
  const fixture = await project();
  t.after(async () => { await rm(fixture.root, { recursive: true, force: true }); });

  await assert.rejects(verifyReleaseSurface(fixture.root, { profiles: ['A'], artifact_path: fixture.artifactPath }), /target/u);
  await assert.rejects(verifyReleaseSurface(fixture.root, { target: '', profiles: ['A'], artifact_path: fixture.artifactPath }), /target/u);
  await assert.rejects(verifyReleaseSurface(fixture.root, { target: '1.0.0', artifact_path: fixture.artifactPath }), /profiles/u);
  await assert.rejects(verifyReleaseSurface(fixture.root, { target: '1.0.0', profiles: [], artifact_path: fixture.artifactPath }), /profiles/u);
  await assert.rejects(verifyReleaseSurface(fixture.root, { target: '1.0.0', profiles: ['Z'], artifact_path: fixture.artifactPath }), /profiles/u);
  await assert.rejects(verifyReleaseSurface(fixture.root, { target: '1.0.0', profiles: ['common'], artifact_path: fixture.artifactPath }), /profiles/u);
  await assert.rejects(
    verifyReleaseSurface(fixture.root, { target: '1.0.0', profiles: ['A'], artifact_path: fixture.artifactPath, record_verdict: 'yes' }),
    /record_verdict/u,
  );
  await assert.rejects(
    verifyReleaseSurface(fixture.root, {
      target: '1.0.0', profiles: ['A'], artifact_path: fixture.artifactPath,
      evidence_dir: 'one', evidenceDirectory: 'two',
    }),
    /different values/u,
  );
  await assert.rejects(
    verifyReleaseSurface(join(fixture.root, 'missing'), { target: '1.0.0', profiles: ['A'], artifact_path: fixture.artifactPath }),
    /does not exist/u,
  );
  await assert.rejects(
    verifyReleaseSurface(join(fixture.root, 'package.json'), { target: '1.0.0', profiles: ['A'], artifact_path: fixture.artifactPath }),
    /plain directory/u,
  );
  await assert.rejects(
    verifyReleaseSurface(fixture.root, { target: '1.0.0', profiles: ['A'], artifact_path: 'missing.tgz', record_verdict: false }),
    /does not exist/u,
  );
});

test('validation records are only read from the fixed in-project directory', async (t) => {
  const fixture = await project();
  t.after(async () => { await rm(fixture.root, { recursive: true, force: true }); });
  await write(fixture.root, '.ano/readiness/validation', 'not a directory');
  await assert.rejects(
    verifyReleaseSurface(fixture.root, { target: '1.0.0', profiles: ['A'], artifact_path: fixture.artifactPath, record_verdict: false }),
    /plain directory/u,
  );
});

test('symlinked artifacts and evidence directories are rejected instead of followed', async (t) => {
  const fixture = await project();
  const outside = await temp('ano surface release outside ');
  t.after(async () => {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  await write(outside, 'outside.tgz', 'outside artifact');
  try {
    await symlink(join(outside, 'outside.tgz'), join(fixture.root, 'linked.tgz'));
  } catch (error) {
    t.skip(`symlink unavailable in this environment: ${String(error)}`);
    return;
  }
  await assert.rejects(
    verifyReleaseSurface(fixture.root, { target: '1.0.0', profiles: ['A'], artifact_path: 'linked.tgz', record_verdict: false }),
    /symlink/u,
  );
  await symlink(outside, join(fixture.root, 'linked-evidence'), 'dir');
  await assert.rejects(
    verifyReleaseSurface(fixture.root, {
      target: '1.0.0', profiles: ['A'], artifact_path: fixture.artifactPath,
      evidence_dir: 'linked-evidence', record_verdict: false,
    }),
    /symlink/u,
  );
});

test('release verdicts are recorded through the ledger interface idempotently', async (t) => {
  const fixture = await project();
  t.after(async () => { await rm(fixture.root, { recursive: true, force: true }); });
  const evaluated = await verifyReleaseSurface(fixture.root, {
    target: '1.0.0',
    profiles: ['A'],
    artifact_path: fixture.artifactPath,
    record_verdict: false,
  });
  assert.equal(evaluated.ledger, null);

  const first = await recordReleaseVerdict(fixture.root, evaluated.verdict, { actor: 'unit-release', clock: () => 1_000 });
  assert.equal(first.verdictHash, evaluated.verdict.verdictHash);
  assert.equal(first.duplicate, false);
  assert.match(first.eventId ?? '', /^[0-9A-HJKMNP-TV-Z]{26}$/u);
  const second = await recordReleaseVerdict(fixture.root, evaluated.verdict, { actor: 'unit-release', clock: () => 1_000 });
  assert.equal(second.duplicate, true);
  assert.equal(second.eventId, first.eventId);

  const ledger = await Ledger.open(fixture.root, { sessionId: 'UNITREAD', clock: () => 2_000 });
  try {
    assert.equal(ledger.getReleaseVerdict(evaluated.verdict.verdictHash)?.artifactHash, fixture.artifactHash);
  } finally {
    ledger.close();
  }

  await assert.rejects(
    recordReleaseVerdict(fixture.root, { ...evaluated.verdict, verdictHash: 'not-a-hash' }),
    /sha256 verdictHash/u,
  );
});

test('an idempotency key cannot reuse a verdict for a different artifact', async (t) => {
  const fixture = await project();
  t.after(async () => { await rm(fixture.root, { recursive: true, force: true }); });
  const input = { target: '1.0.0', profiles: ['A'], artifact_path: fixture.artifactPath, idem_key: 'release:key' };
  const first = await verifyReleaseSurface(fixture.root, input);
  assert.equal(first.ledger?.duplicate, false);
  const retry = await verifyReleaseSurface(fixture.root, input);
  assert.equal(retry.ledger?.duplicate, true);
  await write(fixture.root, fixture.artifactPath, 'different artifact bytes');
  const changed = await verifyReleaseSurface(fixture.root, { ...input, record_verdict: false });
  assert.notEqual(changed.artifactHash, first.artifactHash, 'the fixture must really change the artifact');
  await assert.rejects(verifyReleaseSurface(fixture.root, input), /Idempotency key.*different parameters/u);
});
test('ledger provenance accepts flat records and rejects self-contradictory events', async (t) => {
  const root = await temp('ano surface provenance ');
  const ledger = await Ledger.open(root, { sessionId: 'UNITPROV', clock: () => 1_000 });
  t.after(async () => {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  });
  const flat = attestation('flat-record');
  await ledger.append({
    kind: 'readiness.attestation',
    payload: { attestation_ref: sha256Canonical(flat), requirement_id: flat.requirement_ids[0], ...flat },
  }, 'unit:intent:flat');
  const nested = attestation('nested-record');
  await ledger.append({
    kind: 'readiness.attestation',
    payload: {
      attestation_ref: sha256Canonical(nested),
      // Full shape, but a different id means the advertised reference does not
      // describe the stored record. The source must ignore that event.
      attestation: { ...nested, id: 'different-record' },
    },
  }, 'unit:intent:nested');

  const source = ledgerAttestationProvenance(root);
  const flatEvent = await source.lookup(flat);
  assert.ok(flatEvent);
  assert.equal(flatEvent.kind, 'readiness.attestation');
  assert.equal(flatEvent.actor, 'UNITPROV');
  assert.equal(flatEvent.recordedAt, new Date(1_000).toISOString());
  assert.equal(flatEvent.attestationRef, sha256Canonical(flat));
  assert.equal(await source.lookup(nested), null);
  assert.equal(await source.lookup(attestation('absent-record')), null);

  const emptyRoot = await temp('ano surface provenance empty ');
  t.after(async () => { await rm(emptyRoot, { recursive: true, force: true }); });
  const emptySource = ledgerAttestationProvenance(emptyRoot);
  assert.equal(await emptySource.lookup(flat), null);
});
