import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  approveRelease,
  buildReleaseVerdict,
  collectFileAttestations,
  collectFileEvidence,
  defaultProfilesDirectory,
  loadProfileText,
  loadReadinessProfiles,
  runReadinessChecks,
  signAttestation,
  writeCheckEvidence,
  type ApproveReleaseOptions,
  type AttestationProvenanceEvent,
  type AttestationProvenanceSource,
  type AttestationRecord,
  type CollectEvidenceResult,
  type Profile,
  type Requirement,
  type SignAttestationOptions,
} from '../../src/readiness/index.ts';
import * as readinessIndex from '../../src/readiness/index.ts';
import { testOnlyInteractiveStreams } from '../../src/readiness/test-seams.ts';
import {
  attestationRecord,
  copyProfiles,
  createLibraryProject,
  fixtureProvenance,
  machineRecord,
  profileText,
  seedRelease,
  temp,
  write,
  writeEvidenceCase,
  writeJson,
} from '../fixtures/readiness/support.ts';

const loaded = await loadReadinessProfiles();
const common = loaded.common;
const profileA = loaded.profiles.find((profile) => profile.id === 'A')!;
const profileB = loaded.profiles.find((profile) => profile.id === 'B')!;
const machineRequirement = common.requirements.find((requirement) => requirement.id === 'common.code-gate')!;
const attestedRequirement = common.requirements.find((requirement) => requirement.id === 'common.release-owner')!;
const now = new Date('2026-06-01T00:00:00.000Z');
const dayMs = 24 * 60 * 60 * 1000;
const artifactHash = 'a'.repeat(64);
const sourceFingerprint = 'b'.repeat(64);

function readinessCode(error: unknown, expected: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === expected;
}

async function collectMachine(requirement: Requirement, record: unknown): Promise<CollectEvidenceResult> {
  const directory = await temp('ano evidence case ');
  await writeEvidenceCase(directory, 'case', record as Parameters<typeof writeEvidenceCase>[2]);
  const result = await collectFileEvidence({
    directory,
    requirements: new Map([[requirement.id, requirement]]),
    currentArtifactHash: artifactHash,
    currentSourceFingerprint: sourceFingerprint,
    now,
  });
  await rm(directory, { recursive: true, force: true });
  return result;
}

async function collectAttestation(
  requirement: Requirement,
  record: AttestationRecord,
  provenance?: AttestationProvenanceSource,
): Promise<Awaited<ReturnType<typeof collectFileAttestations>>> {
  const directory = await temp('ano attestation case ');
  await writeJson(directory, 'case', record);
  const result = await collectFileAttestations({
    directory,
    requirements: new Map([[requirement.id, requirement]]),
    currentArtifactHash: artifactHash,
    releaseTarget: 'v1.0.0',
    ...(provenance === undefined ? {} : { provenance }),
    now,
  });
  await rm(directory, { recursive: true, force: true });
  return result;
}

function readyVerdict() {
  return {
    schema: 1 as const,
    target: 'v1.0.0',
    artifactHash,
    sourceFingerprint: null,
    verdict: 'ready' as const,
    perProfile: [],
    items: [],
    summary: { machine: 0, attested: 0, declaration: 0, missing: 0 },
    caveats: [],
    verdictHash: 'f'.repeat(64),
  };
}

test('local static checks are declarations and can never become machine evidence', async (t) => {
  const project = await createLibraryProject();
  const directory = await temp('ano declaration evidence ');
  t.after(async () => {
    await rm(project.root, { recursive: true, force: true });
    await rm(project.workspace, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  });
  const requirements = [...common.requirements, ...profileA.requirements];
  const checks = await runReadinessChecks({ root: project.root, artifactRoot: project.artifactRoot, requirements });
  const written = await writeCheckEvidence(directory, checks, now);
  assert.ok(written.records.length > 0);
  assert.ok(written.records.every((record) => record.origin === 'local_check'), 'check output must be marked local_check');

  const collected = await collectFileEvidence({
    directory,
    requirements: new Map(requirements.map((requirement) => [requirement.id, requirement])),
    currentArtifactHash: checks.artifactHash,
    currentSourceFingerprint: checks.sourceFingerprint,
    now,
  });
  assert.ok(collected.accepted.length > 0, 'declarations stay visible for definition/evaluation');
  assert.ok(collected.accepted.every((item) => item.classification === 'declaration'));
  assert.equal(collected.accepted.filter((item) => item.classification === 'machine').length, 0);

  const verdict = buildReleaseVerdict({
    target: 'v1.2.0',
    artifactHash: checks.artifactHash,
    sourceFingerprint: checks.sourceFingerprint,
    common,
    profiles: [profileA],
    evidence: collected.accepted,
    attestations: [],
    now,
  });
  const tarball = verdict.items.find((item) => item.id === 'a.tarball-allowlist')!;
  assert.equal(tarball.status, 'declaration');
  assert.equal(tarball.gap, 'machine_missing');
  assert.equal(verdict.verdict, 'blocked');
  assert.equal(verdict.summary.machine, 0);
  assert.ok(verdict.summary.declaration >= 6);

  // No relabeling can promote a local declaration to machine evidence.
  const relabeledSource = machineRecord(machineRequirement, artifactHash, sourceFingerprint, now, {
    source_id: 'ano://readiness/checks/common.code-gate',
    origin: 'external',
  });
  const sourceRelabel = await collectMachine(machineRequirement, relabeledSource);
  assert.equal(sourceRelabel.accepted[0]?.classification, 'declaration');

  const relabeledOrigin = machineRecord(machineRequirement, artifactHash, sourceFingerprint, now, {
    source_id: 'ci://forged-runner',
    origin: 'local_check',
  });
  const originRelabel = await collectMachine(machineRequirement, relabeledOrigin);
  assert.equal(originRelabel.accepted[0]?.classification, 'declaration');
});

test('evidence expiry is min(record.expires_at, timestamp + freshness) and cannot be self-extended', async () => {
  const strict: Requirement = { ...machineRequirement, freshnessDays: 7 };
  const twoDaysAgo = now.getTime() - 2 * dayMs;
  const longLived = machineRecord(strict, artifactHash, sourceFingerprint, now, {
    timestamp: new Date(twoDaysAgo).toISOString(),
    expires_at: new Date(now.getTime() + 3650 * dayMs).toISOString(),
    freshness_days: 30,
  });
  const cappedByRequirement = await collectMachine(strict, longLived);
  assert.equal(cappedByRequirement.accepted.length, 1, JSON.stringify(cappedByRequirement.rejected));
  assert.equal(cappedByRequirement.accepted[0]!.expiresAt, new Date(twoDaysAgo + 7 * dayMs).toISOString());

  const stale = machineRecord(strict, artifactHash, sourceFingerprint, now, {
    timestamp: new Date(now.getTime() - 10 * dayMs).toISOString(),
    expires_at: new Date(now.getTime() + 3650 * dayMs).toISOString(),
    freshness_days: 30,
  });
  const expired = await collectMachine(strict, stale);
  assert.equal(expired.accepted.length, 0);
  assert.equal(expired.rejected[0]?.reason, 'expired');

  const noRequirementWindow: Requirement = { ...machineRequirement, freshnessDays: 0 };
  const noWindow = machineRecord(noRequirementWindow, artifactHash, sourceFingerprint, now, {
    expires_at: new Date(now.getTime() + 3650 * dayMs).toISOString(),
  });
  delete (noWindow as { freshness_days?: number }).freshness_days;
  const unbacked = await collectMachine(noRequirementWindow, noWindow);
  assert.equal(unbacked.accepted.length, 0);
  assert.equal(unbacked.rejected[0]?.reason, 'no_freshness');

  const shortRecord = machineRecord(noRequirementWindow, artifactHash, sourceFingerprint, now, {
    expires_at: new Date(now.getTime() + 3650 * dayMs).toISOString(),
    freshness_days: 5,
  });
  const recordBounded = await collectMachine(noRequirementWindow, shortRecord);
  assert.equal(recordBounded.accepted.length, 1);
  assert.equal(recordBounded.accepted[0]!.expiresAt, new Date(Date.parse(shortRecord.timestamp) + 5 * dayMs).toISOString());

  const earlyExpiry = machineRecord(strict, artifactHash, sourceFingerprint, now, {
    expires_at: new Date(now.getTime() + dayMs).toISOString(),
  });
  const earlier = await collectMachine(strict, earlyExpiry);
  assert.equal(earlier.accepted[0]!.expiresAt, new Date(now.getTime() + dayMs).toISOString());
});

test('attestation expiry is capped by the requirement freshness window', async () => {
  const custom: Requirement = {
    id: 'common.short-attest',
    title: 'Short-lived attestation',
    scope: 'common',
    evidence: 'attested',
    freshnessDays: 30,
    check: null,
    kinds: [],
  };
  const oldSignature = attestationRecord(custom, artifactHash, 'v1.0.0', now, {
    signed_at: new Date(now.getTime() - 100 * dayMs).toISOString(),
    expires_at: new Date(now.getTime() + 3650 * dayMs).toISOString(),
  });
  const expired = await collectAttestation(custom, oldSignature, fixtureProvenance([oldSignature]));
  assert.equal(expired.accepted.length, 0);
  assert.equal(expired.rejected[0]?.reason, 'expired');

  const recent = attestationRecord(custom, artifactHash, 'v1.0.0', now, {
    signed_at: new Date(now.getTime() - dayMs).toISOString(),
    expires_at: new Date(now.getTime() + 3650 * dayMs).toISOString(),
  });
  const accepted = await collectAttestation(custom, recent, fixtureProvenance([recent]));
  assert.equal(accepted.accepted.length, 1);
  assert.equal(accepted.accepted[0]!.expiresAt, new Date(now.getTime() - dayMs + 30 * dayMs).toISOString());
});

test('approval and signing are impossible without explicitly supplied streams', async () => {
  const verdict = readyVerdict();
  let prompted = false;
  const base = {
    verdict,
    approver: 'Release Manager',
    confirm: async () => {
      prompted = true;
      return 'APPROVE v1.0.0';
    },
  };
  await assert.rejects(
    approveRelease(base as unknown as ApproveReleaseOptions),
    (error) => readinessCode(error, 'TTY_REQUIRED'),
  );
  assert.equal(prompted, false, 'no prompt may run without streams');

  await assert.rejects(
    approveRelease({ ...base, streams: { stdin: { isTTY: true }, stdout: { isTTY: false } } }),
    (error) => readinessCode(error, 'TTY_REQUIRED'),
  );

  await assert.rejects(
    signAttestation({
      requirementIds: [attestedRequirement.id],
      profileIds: ['common'],
      releaseTarget: 'v1.0.0',
      artifactHash,
      signer: { name: 'Release Owner', role: 'Maintainer' },
      expiresAt: new Date(now.getTime() + 30 * dayMs).toISOString(),
      statement: 'Synthetic red-team attestation.',
      confirm: async () => 'ATTEST v1.0.0',
    } as unknown as SignAttestationOptions),
    (error) => readinessCode(error, 'TTY_REQUIRED'),
  );

  // The fake-stream seam is not part of the module surface.
  assert.equal('testOnlyInteractiveStreams' in readinessIndex, false);
  assert.equal('test-seams' in readinessIndex, false);
});

test('attestations are rejected without ledger provenance and on mismatched provenance', async () => {
  const record = attestationRecord(attestedRequirement, artifactHash, 'v1.0.0', now);
  const directory = await temp('ano provenance evidence ');
  await writeJson(directory, 'case', record);
  const baseOptions = {
    directory,
    requirements: new Map([[attestedRequirement.id, attestedRequirement]]),
    currentArtifactHash: artifactHash,
    releaseTarget: 'v1.0.0',
    now,
  };
  try {
    const unproven = await collectFileAttestations(baseOptions);
    assert.equal(unproven.accepted.length, 0, 'file JSON alone is not a signature');
    assert.equal(unproven.rejected[0]?.reason, 'provenance_missing');

    const mismatched: AttestationProvenanceSource = {
      async lookup() {
        return {
          kind: 'readiness.attestation',
          eventId: `01J${'0'.repeat(23)}`,
          actor: 'ledger',
          recordedAt: new Date(now.getTime() - dayMs).toISOString(),
          attestationRef: 'c'.repeat(64),
        };
      },
    };
    const wrongRef = await collectFileAttestations({ ...baseOptions, provenance: mismatched });
    assert.equal(wrongRef.accepted.length, 0);
    assert.equal(wrongRef.rejected[0]?.reason, 'provenance_mismatch');

    const futureEvent: AttestationProvenanceSource = {
      async lookup() {
        return {
          kind: 'readiness.attestation',
          eventId: `01J${'0'.repeat(23)}`,
          actor: 'ledger',
          recordedAt: new Date(now.getTime() + 30 * dayMs).toISOString(),
          attestationRef: fixtureRef(record),
        };
      },
    };
    const future = await collectFileAttestations({ ...baseOptions, provenance: futureEvent });
    assert.equal(future.accepted.length, 0);
    assert.equal(future.rejected[0]?.reason, 'provenance_invalid');

    const broken: AttestationProvenanceSource = {
      async lookup() {
        throw new Error('ledger unreachable');
      },
    };
    const unavailable = await collectFileAttestations({ ...baseOptions, provenance: broken });
    assert.equal(unavailable.accepted.length, 0);
    assert.equal(unavailable.rejected[0]?.reason, 'provenance_unavailable');

    // Only a readiness.attestation ledger event counts as provenance.
    const wrongKindSource: AttestationProvenanceSource = {
      async lookup() {
        return {
          kind: 'evidence.recorded',
          eventId: `01J${'0'.repeat(23)}`,
          actor: 'ledger',
          recordedAt: new Date(now.getTime() - dayMs).toISOString(),
          attestationRef: fixtureRef(record),
        } as unknown as AttestationProvenanceEvent;
      },
    };
    const wrongKind = await collectFileAttestations({ ...baseOptions, provenance: wrongKindSource });
    assert.equal(wrongKind.accepted.length, 0);
    assert.equal(wrongKind.rejected[0]?.reason, 'provenance_invalid');

    // Without provenance the requirement is blocked, not silently attested.
    const commonOnly: Profile = { ...common, requirements: [attestedRequirement] };
    const emptyProfile: Profile = { ...profileB, requirements: [] };
    const verdict = buildReleaseVerdict({
      target: 'v1.0.0',
      artifactHash,
      common: commonOnly,
      profiles: [emptyProfile],
      evidence: [],
      attestations: unproven.accepted,
      rejectedAttestations: unproven.rejected,
      now,
    });
    assert.equal(verdict.verdict, 'blocked');
    assert.equal(verdict.items.find((item) => item.id === attestedRequirement.id)!.gap, 'attestation_invalid');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('attestation signing validates every human input before returning a schema-valid record', async () => {
  const base: SignAttestationOptions = {
    requirementIds: [attestedRequirement.id, attestedRequirement.id],
    profileIds: ['common', 'common'],
    releaseTarget: 'v1.0.0',
    artifactHash,
    signer: { name: '  Release Owner  ', role: '  Maintainer  ' },
    expiresAt: new Date(now.getTime() + 30 * dayMs).toISOString(),
    statement: 'Synthetic validation attestation.',
    streams: testOnlyInteractiveStreams(),
    confirm: async () => 'ATTEST v1.0.0',
    now,
  };
  await assert.rejects(signAttestation({ ...base, confirm: undefined as unknown as SignAttestationOptions['confirm'] }), (error) => readinessCode(error, 'CONFIRM_REQUIRED'));
  await assert.rejects(signAttestation({ ...base, requirementIds: [] }), (error) => readinessCode(error, 'ATTESTATION_EMPTY'));
  await assert.rejects(signAttestation({ ...base, signer: { name: ' ', role: 'Maintainer' } }), (error) => readinessCode(error, 'ATTESTATION_SIGNER'));
  await assert.rejects(signAttestation({ ...base, expiresAt: now.toISOString() }), (error) => readinessCode(error, 'ATTESTATION_EXPIRY'));
  await assert.rejects(signAttestation({ ...base, confirm: async () => 'wrong' }), (error) => readinessCode(error, 'ATTESTATION_NOT_CONFIRMED'));
  await assert.rejects(signAttestation({ ...base, artifactHash: 'not-a-hash' }), (error) => readinessCode(error, 'ATTESTATION_INVALID'));

  const signed = await signAttestation(base);
  assert.deepEqual(signed.requirement_ids, [attestedRequirement.id]);
  assert.deepEqual(signed.profile_ids, ['common']);
  assert.deepEqual(signed.signer, { name: 'Release Owner', role: 'Maintainer' });
  assert.equal(signed.signed_at, now.toISOString());
});

test('attestation collection rejects malformed records, identities, timestamps and provenance events', async () => {
  const record = attestationRecord(attestedRequirement, artifactHash, 'v1.0.0', now);
  const invalidRecords: Array<[AttestationRecord, string]> = [
    [{ ...record, requirement_ids: [attestedRequirement.id, attestedRequirement.id] }, 'duplicate_requirement'],
    [{ ...record, profile_ids: ['common', 'common'] }, 'duplicate_profile'],
    [{ ...record, signer: { name: ' ', role: 'Maintainer' } }, 'unnamed_signer'],
    [{ ...record, signed_at: 'not-a-date' }, 'schema_invalid'],
    [{ ...record, signed_at: new Date(now.getTime() + dayMs).toISOString() }, 'future_signed_at'],
  ];
  for (const [candidate, reason] of invalidRecords) {
    const result = await collectAttestation(attestedRequirement, candidate);
    assert.equal(result.accepted.length, 0);
    assert.equal(result.rejected[0]?.reason, reason);
  }

  const eventCases: Array<[Partial<AttestationProvenanceEvent>, string]> = [
    [{ eventId: 'not-a-ulid' }, 'provenance_invalid'],
    [{ actor: ' ' }, 'provenance_invalid'],
    [{ recordedAt: 'not-a-date' }, 'provenance_invalid'],
    [{ recordedAt: new Date(Date.parse(record.signed_at) - 61_000).toISOString() }, 'provenance_invalid'],
  ];
  for (const [change, reason] of eventCases) {
    const base = fixtureProvenance([record]);
    const provenance: AttestationProvenanceSource = {
      async lookup(candidate) {
        const event = await base.lookup(candidate);
        return event === null ? null : { ...event, ...change };
      },
    };
    const result = await collectAttestation(attestedRequirement, record, provenance);
    assert.equal(result.accepted.length, 0);
    assert.equal(result.rejected[0]?.reason, reason);
  }

  const noWindow: Requirement = { ...attestedRequirement, freshnessDays: 0 };
  const unbounded = attestationRecord(noWindow, artifactHash, 'v1.0.0', now);
  const noFreshness = await collectAttestation(noWindow, unbounded, fixtureProvenance([unbounded]));
  assert.equal(noFreshness.accepted.length, 0);
  assert.equal(noFreshness.rejected[0]?.reason, 'no_freshness');

  const directory = await temp('ano attestation duplicates ');
  try {
    await writeJson(directory, 'first', record);
    await writeJson(directory, 'second', record);
    await writeFile(join(directory, 'broken.json'), '{not json', 'utf8');
    await writeFile(join(directory, 'schema.json'), JSON.stringify({ id: 42 }), 'utf8');
    const result = await collectFileAttestations({
      directory,
      requirements: new Map([[attestedRequirement.id, attestedRequirement]]),
      currentArtifactHash: artifactHash,
      releaseTarget: 'v1.0.0',
      provenance: fixtureProvenance([record]),
      now,
    });
    assert.equal(result.accepted.length, 1);
    assert.ok(result.rejected.some((entry) => entry.reason === 'duplicate_id'));
    assert.ok(result.rejected.some((entry) => entry.reason === 'unreadable'));
    assert.ok(result.rejected.some((entry) => entry.reason === 'schema_invalid'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('profile assets resolve next to the module, never the host working directory', async (t) => {
  const expectedDirectory = fileURLToPath(new URL('../../src/readiness/profiles/', import.meta.url));
  assert.equal(defaultProfilesDirectory(), expectedDirectory);

  const decoy = await temp('ano host decoy ');
  t.after(async () => {
    await rm(decoy, { recursive: true, force: true });
  });
  const decoyProfiles = join(decoy, 'src', 'readiness', 'profiles');
  await mkdir(decoyProfiles, { recursive: true });
  await writeFile(join(decoyProfiles, 'common.toml'), 'schema = "garbage"\n', 'utf8');
  await writeFile(join(decoyProfiles, 'A.toml'), 'id = "not-a-profile"\n', 'utf8');
  await write(decoy, 'package.json', '{"name":"host-project"}\n');

  const moduleUrl = new URL('../../src/readiness/profile.ts', import.meta.url).href;
  const script = [
    'const mod = await import(process.argv[1]);',
    'const loaded = await mod.loadReadinessProfiles();',
    'console.log(JSON.stringify({ dir: mod.defaultProfilesDirectory(), count: loaded.profiles.length }));',
  ].join('\n');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, moduleUrl], {
    cwd: decoy,
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
  const parsed = JSON.parse(child.stdout.trim()) as { dir: string; count: number };
  assert.equal(parsed.dir, expectedDirectory);
  assert.equal(parsed.count, 9);
});

test('an explicit profile directory still refuses arbitrary profile files', async (t) => {
  const directory = await copyProfiles(await temp('ano explicit profiles '));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const explicit = await loadReadinessProfiles(directory);
  assert.equal(explicit.profiles.length, 9);
  await writeFile(join(directory, 'Z.toml'), 'schema = 1\n', 'utf8');
  await assert.rejects(
    loadReadinessProfiles(directory),
    (error) => readinessCode(error, 'PROFILE_UNKNOWN_FILE'),
  );
});

test('a validated claim cannot be promoted by any caller-supplied in-memory record', async () => {
  const current = await profileText('A');
  const relabeled = current
    .replace('status = "defined"', 'status = "validated"')
    .concat('\n[validation]\nproject = "example-real-application"\nvalidated_at = "2026-01-01"\nverdict_hash = "' + 'a'.repeat(64) + '"\n');
  // The removed `validationRecords` map is ignored, not honoured: the claim still fails closed.
  const forgedOptions = {
    validationRecords: new Map([
      ['A', {
        project: 'example-real-application',
        profileSchemaHash: profileA.schemaHash,
        validatedAt: '2026-01-01',
        verdictHash: 'a'.repeat(64),
      }],
    ]),
  };
  assert.throws(
    () => loadProfileText(relabeled, forgedOptions as unknown as { selfProjectNames?: readonly string[] }),
    (error) => readinessCode(error, 'PROFILE_SELF_CERTIFICATION'),
  );
});

test('a failing local check leaves the machine requirement missing instead of guessing', async (t) => {
  const project = await createLibraryProject();
  t.after(async () => {
    await rm(project.root, { recursive: true, force: true });
    await rm(project.workspace, { recursive: true, force: true });
  });
  await write(project.artifactRoot, 'dist/leak.txt', 'AKIAABCDEFGHIJKLMNOP\n');
  const seeded = await seedRelease({ ...project, common, profile: profileA, now });
  const { verifyRelease } = readinessIndex;
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
});

function fixtureRef(record: AttestationRecord): string {
  return readinessIndex.sha256Canonical(record);
}
