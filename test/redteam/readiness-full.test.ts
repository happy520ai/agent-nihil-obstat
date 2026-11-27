import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import test from 'node:test';
import {
  approveRelease,
  buildReleaseVerdict,
  checkApproval,
  collectFileAttestations,
  collectFileEvidence,
  loadProfileText,
  loadReadinessProfiles,
  verifyRelease,
  type CollectAttestationResult,
  type CollectEvidenceResult,
  type EvidenceRecord,
  type ReleaseVerdict,
} from '../../src/readiness/index.ts';
import {
  attestationRecord,
  createLibraryProject,
  fixtureProvenance,
  git,
  machineRecord,
  profileText,
  seedRelease,
  temp,
  write,
  writeEvidenceCase,
  writeJson,
} from '../fixtures/readiness/support.ts';
import { testOnlyInteractiveStreams } from '../../src/readiness/test-seams.ts';
import type { AttestationProvenanceSource, AttestationRecord } from '../../src/readiness/index.ts';

const loaded = await loadReadinessProfiles();
const common = loaded.common;
const profileA = loaded.profiles.find((profile) => profile.id === 'A')!;
const profileB = loaded.profiles.find((profile) => profile.id === 'B')!;
const machineRequirement = common.requirements.find((requirement) => requirement.id === 'common.code-gate')!;
const noSecretsRequirement = common.requirements.find((requirement) => requirement.id === 'common.no-secrets')!;
const attestedRequirement = common.requirements.find((requirement) => requirement.id === 'common.release-owner')!;
const now = new Date('2026-06-01T00:00:00.000Z');
const artifactHash = 'a'.repeat(64);
const sourceFingerprint = 'b'.repeat(64);

function readinessCode(error: unknown, expected: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === expected;
}

async function collectMachine(record: unknown, mode: 'raw' | 'json' = 'raw'): Promise<CollectEvidenceResult> {
  const directory = await temp('ano redteam evidence ');
  if (mode === 'raw') await writeEvidenceCase(directory, 'case', record as EvidenceRecord);
  else await writeJson(directory, 'case', record);
  const result = await collectFileEvidence({
    directory,
    requirements: new Map([[machineRequirement.id, machineRequirement]]),
    currentArtifactHash: artifactHash,
    currentSourceFingerprint: sourceFingerprint,
    now,
  });
  await rm(directory, { recursive: true, force: true });
  return result;
}

async function collectAttestation(
  record: unknown,
  provenanceOption?: AttestationProvenanceSource,
): Promise<CollectAttestationResult> {
  const directory = await temp('ano redteam attestation ');
  await writeJson(directory, 'case', record);
  const provenance = provenanceOption ?? fixtureProvenance([record as AttestationRecord]);
  const result = await collectFileAttestations({
    directory,
    requirements: new Map([
      [machineRequirement.id, machineRequirement],
      [noSecretsRequirement.id, noSecretsRequirement],
      [attestedRequirement.id, attestedRequirement],
    ]),
    currentArtifactHash: artifactHash,
    releaseTarget: 'v1.0.0',
    provenance,
    now,
  });
  await rm(directory, { recursive: true, force: true });
  return result;
}

/** Omits the provenance source entirely. */
async function collectUnprovenAttestation(record: unknown): Promise<CollectAttestationResult> {
  const directory = await temp('ano redteam attestation unproven ');
  await writeJson(directory, 'case', record);
  const result = await collectFileAttestations({
    directory,
    requirements: new Map([
      [machineRequirement.id, machineRequirement],
      [noSecretsRequirement.id, noSecretsRequirement],
      [attestedRequirement.id, attestedRequirement],
    ]),
    currentArtifactHash: artifactHash,
    releaseTarget: 'v1.0.0',
    now,
  });
  await rm(directory, { recursive: true, force: true });
  return result;
}

function readyVerdict(): ReleaseVerdict {
  return {
    schema: 1,
    target: 'v1.0.0',
    artifactHash,
    sourceFingerprint: null,
    verdict: 'ready',
    perProfile: [],
    items: [],
    summary: { machine: 0, attested: 0, declaration: 0, missing: 0 },
    caveats: [],
    verdictHash: 'f'.repeat(64),
  };
}

test('file evidence rejects hand-filled machine flags, missing hashes, stale, expired and mismatched records', async () => {
  const valid = machineRecord(machineRequirement, artifactHash, sourceFingerprint, now);
  const accepted = await collectMachine(valid);
  assert.equal(accepted.accepted.length, 1);
  assert.equal(accepted.rejected.length, 0);

  const forgedStatus = await collectMachine({ ...valid, status: 'machine' }, 'json');
  assert.equal(forgedStatus.rejected[0]?.reason, 'schema_invalid');
  const forgedFlag = await collectMachine({ ...valid, machine: true }, 'json');
  assert.equal(forgedFlag.rejected[0]?.reason, 'schema_invalid');

  const noBinding = { ...valid };
  delete noBinding.artifact_hash;
  delete noBinding.source_fingerprint;
  assert.equal((await collectMachine(noBinding)).rejected[0]?.reason, 'missing_hash');

  const sourceOnly = { ...valid };
  delete sourceOnly.artifact_hash;
  assert.equal((await collectMachine(sourceOnly)).rejected[0]?.reason, 'missing_hash');

  const { raw_artifact_hash: _rawHash, ...noRawHash } = valid;
  assert.equal((await collectMachine(noRawHash, 'json')).rejected[0]?.reason, 'schema_invalid');

  const missingRaw = { ...valid, raw_artifact: 'raw/does-not-exist.txt' };
  assert.equal((await collectMachine(missingRaw, 'json')).rejected[0]?.reason, 'raw_unreadable');

  const traversal = { ...valid, raw_artifact: '../outside.txt' };
  assert.equal((await collectMachine(traversal, 'json')).rejected[0]?.reason, 'evidence_raw_path');

  const wrongRawHash = { ...valid, raw_artifact: 'raw/present.txt', raw_artifact_hash: 'c'.repeat(64) };
  const wrongRawDirectory = await temp('ano redteam raw ');
  await write(wrongRawDirectory, 'raw/present.txt', 'some raw output');
  await writeJson(wrongRawDirectory, 'case', wrongRawHash);
  const wrongRaw = await collectFileEvidence({
    directory: wrongRawDirectory,
    requirements: new Map([[machineRequirement.id, machineRequirement]]),
    currentArtifactHash: artifactHash,
    currentSourceFingerprint: sourceFingerprint,
    now,
  });
  await rm(wrongRawDirectory, { recursive: true, force: true });
  assert.equal(wrongRaw.rejected[0]?.reason, 'raw_hash_mismatch');

  const expired = await collectMachine({
    ...valid,
    expires_at: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
  });
  assert.equal(expired.rejected[0]?.reason, 'expired');

  const oldArtifact = await collectMachine({ ...valid, artifact_hash: 'd'.repeat(64) });
  assert.equal(oldArtifact.rejected[0]?.reason, 'artifact_mismatch');

  const oldSource = await collectMachine({ ...valid, source_fingerprint: 'e'.repeat(64) });
  assert.equal(oldSource.rejected[0]?.reason, 'source_mismatch');

  const future = await collectMachine({ ...valid, timestamp: new Date(now.getTime() + 60 * 60 * 1000).toISOString() });
  assert.equal(future.rejected[0]?.reason, 'future_timestamp');

  const failed = await collectMachine({ ...valid, result: 'fail' });
  assert.equal(failed.rejected[0]?.reason, 'not_passed');

  const wrongKind = await collectMachine({ ...valid, kind: 'deploy_record' });
  assert.equal(wrongKind.rejected[0]?.reason, 'kind_not_allowed');

  const duplicateDirectory = await temp('ano redteam duplicate ');
  await writeEvidenceCase(duplicateDirectory, 'one', valid);
  await writeEvidenceCase(duplicateDirectory, 'two', valid);
  const duplicate = await collectFileEvidence({
    directory: duplicateDirectory,
    requirements: new Map([[machineRequirement.id, machineRequirement]]),
    currentArtifactHash: artifactHash,
    currentSourceFingerprint: sourceFingerprint,
    now,
  });
  await rm(duplicateDirectory, { recursive: true, force: true });
  assert.equal(duplicate.accepted.length, 1);
  assert.equal(duplicate.rejected[0]?.reason, 'duplicate_id');
});

test('attestations cannot masquerade as machine evidence, expire, or bind an old artifact', async () => {
  const valid = attestationRecord(attestedRequirement, artifactHash, 'v1.0.0', now);
  const accepted = await collectAttestation(valid);
  assert.equal(accepted.accepted.length, 1);
  assert.equal(accepted.rejected.length, 0);

  const forgedStatus = await collectAttestation({ ...valid, status: 'machine' });
  assert.equal(forgedStatus.rejected[0]?.reason, 'schema_invalid');
  const { artifact_hash: _artifactHash, ...missingArtifact } = valid;
  assert.equal((await collectAttestation(missingArtifact)).rejected[0]?.reason, 'schema_invalid');

  const machineClaim = await collectAttestation(attestationRecord(noSecretsRequirement, artifactHash, 'v1.0.0', now));
  assert.equal(machineClaim.rejected[0]?.reason, 'machine_requirement');

  const expired = await collectAttestation({
    ...valid,
    expires_at: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
  });
  assert.equal(expired.rejected[0]?.reason, 'expired');

  const oldArtifact = await collectAttestation(attestationRecord(attestedRequirement, 'd'.repeat(64), 'v1.0.0', now));
  assert.equal(oldArtifact.rejected[0]?.reason, 'artifact_mismatch');

  const wrongTarget = await collectAttestation(attestationRecord(attestedRequirement, artifactHash, 'v2.0.0', now));
  assert.equal(wrongTarget.rejected[0]?.reason, 'target_mismatch');

  const wrongScope = await collectAttestation(attestationRecord(attestedRequirement, artifactHash, 'v1.0.0', now, { profile_ids: ['A'] }));
  assert.equal(wrongScope.rejected[0]?.reason, 'scope_mismatch');

  const future = await collectAttestation(attestationRecord(attestedRequirement, artifactHash, 'v1.0.0', now, {
    signed_at: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
  }));
  assert.equal(future.rejected[0]?.reason, 'future_signed_at');

  const unknown = await collectAttestation(attestationRecord(attestedRequirement, artifactHash, 'v1.0.0', now, { requirement_ids: ['common.unknown'] }));
  assert.equal(unknown.rejected[0]?.reason, 'unknown_requirement');
});

test('an attestation for a machine-only requirement leaves the release blocked', async () => {
  const masquerade = await collectAttestation(attestationRecord(noSecretsRequirement, artifactHash, 'v1.0.0', now));
  assert.equal(masquerade.accepted.length, 0);
  assert.equal(masquerade.rejected[0]?.reason, 'machine_requirement');
  const verdict = buildReleaseVerdict({
    target: 'v1.0.0',
    artifactHash,
    common,
    profiles: [profileB],
    evidence: [],
    attestations: masquerade.accepted,
    rejectedAttestations: masquerade.rejected,
    now,
  });
  assert.equal(verdict.verdict, 'blocked');
  assert.equal(verdict.items.find((item) => item.id === 'common.no-secrets')!.gap, 'attestation_invalid');
});

test('a tarball with a planted secret is blocked by the real local check', async (t) => {
  const project = await createLibraryProject();
  t.after(async () => {
    await rm(project.root, { recursive: true, force: true });
    await rm(project.workspace, { recursive: true, force: true });
  });
  await write(project.artifactRoot, 'dist/leak.txt', 'AKIAABCDEFGHIJKLMNOP\n');
  git(project.root, ['add', '-A']);
  git(project.root, ['commit', '-qm', 'planted secret']);
  const seeded = await seedRelease({ ...project, common, profile: profileA, now });
  const result = await verifyRelease({
    target: 'v1.2.0',
    artifactHash: seeded.artifactHash,
    sourceFingerprint: seeded.sourceFingerprint,
    common,
    profiles: [profileA],
    evidenceDirectory: seeded.evidenceDir,
    attestationDirectory: seeded.attestationDir,
    attestationProvenance: seeded.provenance,
    now,
  });
  assert.equal(result.verdict.verdict, 'blocked');
  const item = result.verdict.items.find((entry) => entry.id === 'common.no-secrets')!;
  assert.equal(item.gap, 'machine_invalid');
  assert.match(item.reason, /not_passed/);
  assert.ok(result.evidence.rejected.some((record) => record.requirementId === 'common.no-secrets' && record.reason === 'not_passed'));
  assert.equal(seeded.checks.runs.find((run) => run.requirementId === 'common.no-secrets')!.raw.includes('AKIAABCDEFGHIJKLMNOP'), false);
});

test('release approval refuses non-TTY callers and tampered or stale approvals', async () => {
  const verdict = readyVerdict();
  await assert.rejects(
    approveRelease({
      verdict,
      approver: 'Agent Transport',
      streams: { stdin: { isTTY: false }, stdout: { isTTY: false } },
      confirm: async () => 'APPROVE v1.0.0',
    }),
    (error) => readinessCode(error, 'TTY_REQUIRED'),
  );

  const tty = testOnlyInteractiveStreams();
  await assert.rejects(
    approveRelease({ verdict, approver: 'Release Manager', streams: tty, confirm: async () => 'yes' }),
    (error) => readinessCode(error, 'APPROVAL_NOT_CONFIRMED'),
  );
  await assert.rejects(
    approveRelease({ verdict: { ...verdict, verdict: 'conditional' }, approver: 'Release Manager', streams: tty, confirm: async () => 'APPROVE v1.0.0' }),
    (error) => readinessCode(error, 'RELEASE_NOT_READY'),
  );

  const approval = await approveRelease({
    verdict,
    approver: 'Release Manager',
    streams: tty,
    confirm: async () => 'APPROVE v1.0.0',
    now,
  });
  assert.equal(checkApproval(approval, { target: 'v1.0.0', artifactHash, verdictHash: verdict.verdictHash, now }).valid, true);

  const tampered = checkApproval({ ...approval, approver: 'Mallory' }, {
    target: 'v1.0.0',
    artifactHash,
    verdictHash: verdict.verdictHash,
    now,
  });
  assert.equal(tampered.valid, false);
  assert.ok(tampered.reasons.some((reason) => /hash does not match/.test(reason)));

  const stale = checkApproval(approval, {
    target: 'v1.0.0',
    artifactHash: '9'.repeat(64),
    verdictHash: '8'.repeat(64),
    now,
  });
  assert.equal(stale.valid, false);
  assert.ok(stale.reasons.some((reason) => /Artifact hash changed/.test(reason)));
  assert.ok(stale.reasons.some((reason) => /verdict changed/.test(reason)));
});

test('a profile cannot self-certify validated status without an external project record', async () => {
  const current = await profileText('A');
  const relabeled = current
    .replace('status = "defined"', 'status = "validated"')
    .concat('\n[validation]\nproject = "agent-nihil-obstat"\nvalidated_at = "2026-01-01"\nverdict_hash = "' + 'a'.repeat(64) + '"\n');
  // No in-memory validation map exists any more; without an external file this fails closed.
  assert.throws(() => loadProfileText(relabeled), (error) => readinessCode(error, 'PROFILE_SELF_CERTIFICATION'));
  assert.throws(
    () => loadProfileText(relabeled, { selfProjectNames: ['example-real-application'] }),
    (error) => readinessCode(error, 'PROFILE_SELF_CERTIFICATION'),
  );
  assert.throws(
    () => loadProfileText(current.replace('status = "defined"', 'status = "validated"')),
    (error) => readinessCode(error, 'PROFILE_INVALID'),
  );
});
