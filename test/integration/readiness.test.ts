import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import {
  approveRelease,
  buildReleaseVerdict,
  checkApproval,
  computeProfileHash,
  definedProfiles,
  loadProfileText,
  loadReadinessProfiles,
  parseToml,
  runReadinessChecks,
  validatedProfiles,
  verifyRelease,
} from '../../src/readiness/index.ts';
import { testOnlyInteractiveStreams } from '../../src/readiness/test-seams.ts';
import {
  copyProfiles,
  createLibraryProject,
  createServiceProject,
  git,
  profileText,
  seedRelease,
  temp,
  write,
  writeValidationRecord,
} from '../fixtures/readiness/support.ts';

const loaded = await loadReadinessProfiles();
const common = loaded.common;
const profileA = loaded.profiles.find((profile) => profile.id === 'A')!;
const profileB = loaded.profiles.find((profile) => profile.id === 'B')!;
const profileC = loaded.profiles.find((profile) => profile.id === 'C')!;

function readinessCode(error: unknown, expected: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === expected;
}

test('all A-I profiles load as defined with pinned schema hashes', async () => {
  assert.deepEqual(loaded.profiles.map((profile) => profile.id), ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']);
  assert.equal(common.requirements.length, 10);
  for (const profile of [common, ...loaded.profiles]) {
    assert.equal(profile.status, 'defined', `${profile.id} must not claim validated`);
    assert.equal(profile.schemaHash, computeProfileHash(profile), `${profile.id} schema hash must match`);
    assert.ok(profile.requirements.length > 0);
  }
  assert.deepEqual(validatedProfiles(loaded.profiles), []);
  assert.equal(definedProfiles(loaded.profiles).length, 9);

  const current = await profileText('A');
  const relabeled = current
    .replace('status = "defined"', 'status = "validated"')
    .concat('\n[validation]\nproject = "example-real-application"\nvalidated_at = "2026-01-01"\nverdict_hash = "' + 'a'.repeat(64) + '"\n');
  // In-memory validation claims are not accepted: `validated` needs an external file.
  assert.throws(() => loadProfileText(relabeled), (error) => readinessCode(error, 'PROFILE_SELF_CERTIFICATION'));

  const temporary: string[] = [];
  const profilesDir = await copyProfiles(await temp('ano profiles '), { A: relabeled });
  const validationDir = await temp('ano validation ');
  temporary.push(profilesDir, validationDir);
  try {
    await assert.rejects(
      loadReadinessProfiles(profilesDir),
      (error) => readinessCode(error, 'PROFILE_SELF_CERTIFICATION'),
    );

    await writeValidationRecord(validationDir, {
      schema: 1,
      profile_id: 'A',
      project: 'example-real-application',
      validated_at: '2026-01-01',
      verdict_hash: 'a'.repeat(64),
      profile_schema_hash: profileA.schemaHash,
    });
    const promoted = await loadReadinessProfiles(profilesDir, { validationDirectory: validationDir });
    assert.equal(promoted.profiles.find((profile) => profile.id === 'A')!.status, 'validated');

    // The project cannot validate itself, and validation records cannot live in the bundle.
    const selfDir = await temp('ano validation self ');
    temporary.push(selfDir);
    await writeValidationRecord(selfDir, {
      schema: 1,
      profile_id: 'A',
      project: 'agent-nihil-obstat',
      validated_at: '2026-01-01',
      verdict_hash: 'a'.repeat(64),
      profile_schema_hash: profileA.schemaHash,
    });
    await assert.rejects(
      loadReadinessProfiles(profilesDir, { validationDirectory: selfDir }),
      (error) => readinessCode(error, 'PROFILE_SELF_CERTIFICATION'),
    );
    await assert.rejects(
      loadReadinessProfiles(profilesDir, { validationDirectory: profilesDir }),
      (error) => readinessCode(error, 'PROFILE_SELF_CERTIFICATION'),
    );

    const wrongDir = await temp('ano validation wrong ');
    temporary.push(wrongDir);
    await writeValidationRecord(wrongDir, {
      schema: 1,
      profile_id: 'A',
      project: 'example-real-application',
      validated_at: '2026-01-01',
      verdict_hash: 'a'.repeat(64),
      profile_schema_hash: 'b'.repeat(64),
    });
    await assert.rejects(
      loadReadinessProfiles(profilesDir, { validationDirectory: wrongDir }),
      (error) => readinessCode(error, 'PROFILE_VALIDATION_MISMATCH'),
    );

    const badDir = await temp('ano validation bad ');
    temporary.push(badDir);
    await writeFile(join(badDir, 'A.validation.json'), '{not json', 'utf8');
    await assert.rejects(
      loadReadinessProfiles(profilesDir, { validationDirectory: badDir }),
      (error) => readinessCode(error, 'PROFILE_VALIDATION_INVALID'),
    );
  } finally {
    for (const directory of temporary) await rm(directory, { recursive: true, force: true });
  }

  assert.throws(
    () => loadProfileText(current.replace('name = "Library / SDK / npm package"', 'name = "Library / SDK / npm package!"')),
    (error) => readinessCode(error, 'PROFILE_HASH_MISMATCH'),
  );
  assert.throws(
    () => loadProfileText(current.replace('status = "defined"', 'status = "defined"\nowner = "someone"')),
    (error) => readinessCode(error, 'PROFILE_INVALID'),
  );
  assert.throws(
    () => loadProfileText(current.replace('status = "defined"', 'status = "defined"\nstatus = "defined"')),
    (error) => readinessCode(error, 'TOML_INVALID'),
  );
});

test('the strict TOML subset rejects ambiguous or dangerous input', () => {
  const invalid = [
    'a = 1\na = 2',
    '[a]\n[a]',
    'a = 1.5',
    'a = "unterminated',
    'a = bare',
    'a = [1, "x"]',
    '__proto__ = "x"',
    '[[a]]',
    'a = { b = 1 }',
  ];
  for (const text of invalid) {
    assert.throws(() => parseToml(text), (error) => readinessCode(error, 'TOML_INVALID'), text);
  }
  const quoted = parseToml('[requirements."common.no-secrets"]\ntitle = "ok"\n');
  const requirements = quoted.requirements as Record<string, unknown>;
  assert.ok(requirements['common.no-secrets']);
});

test('common and profile A checks pass on a clean synthetic fixture, and detect leaked files', async (t) => {
  const project = await createLibraryProject();
  t.after(async () => {
    await rm(project.root, { recursive: true, force: true });
    await rm(project.workspace, { recursive: true, force: true });
  });
  const requirements = [...common.requirements, ...profileA.requirements];
  const checks = await runReadinessChecks({ root: project.root, artifactRoot: project.artifactRoot, requirements });
  assert.equal(checks.skipped.length, 0);
  assert.equal(checks.runs.length, 6);
  assert.ok(checks.runs.every((run) => run.pass), JSON.stringify(checks.runs.map((run) => [run.requirementId, run.summary])));

  await write(project.artifactRoot, '.env', 'DB_PASSWORD=hunter2\n');
  const withEnv = await runReadinessChecks({ root: project.root, artifactRoot: project.artifactRoot, requirements });
  const allowlist = withEnv.runs.find((run) => run.requirementId === 'a.tarball-allowlist')!;
  assert.equal(allowlist.pass, false);
  assert.match(allowlist.summary, /violations/i);
  await rm(join(project.artifactRoot, '.env'));

  await write(project.artifactRoot, 'dist/leak.txt', 'AKIAABCDEFGHIJKLMNOP\n');
  git(project.root, ['add', '-A']);
  git(project.root, ['commit', '-qm', 'fixture leak']);
  const withLeak = await runReadinessChecks({ root: project.root, artifactRoot: project.artifactRoot, requirements });
  const noSecrets = withLeak.runs.find((run) => run.requirementId === 'common.no-secrets')!;
  assert.equal(noSecrets.pass, false);
  assert.match(noSecrets.summary, /secret patterns/i);
  assert.equal(noSecrets.raw.includes('AKIAABCDEFGHIJKLMNOP'), false, 'raw output must not echo secret material');
});

test('profile C checks exercise local service configuration and stay honest when it is absent', async (t) => {
  const project = await createServiceProject();
  t.after(async () => {
    await rm(project.root, { recursive: true, force: true });
    await rm(project.workspace, { recursive: true, force: true });
  });
  const requirements = profileC.requirements;
  const clean = await runReadinessChecks({ root: project.root, artifactRoot: project.root, requirements });
  assert.equal(clean.runs.length, 3);
  assert.equal(clean.skipped.length, 0);
  assert.ok(clean.runs.every((run) => run.pass), JSON.stringify(clean.runs.map((run) => [run.requirementId, run.summary])));

  const configPath = join(project.root, 'deploy', 'service.json');
  const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
  delete config.health;
  (config.env as Record<string, string>).DB_PASSWORD = 'hunter2';
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  const broken = await runReadinessChecks({ root: project.root, artifactRoot: project.root, requirements });
  assert.equal(broken.runs.find((run) => run.requirementId === 'c.health-endpoints')!.pass, false);
  assert.equal(broken.runs.find((run) => run.requirementId === 'c.secrets-managed')!.pass, false);

  await rm(configPath);
  const absent = await runReadinessChecks({ root: project.root, artifactRoot: project.root, requirements });
  assert.equal(absent.runs.length, 0);
  assert.equal(absent.skipped.length, 3);
  assert.ok(absent.skipped.every((skip) => /absent/i.test(skip.reason)));
});

test('ready verdict, TTY approval, and artifact-change invalidation', async (t) => {
  const project = await createLibraryProject();
  t.after(async () => {
    await rm(project.root, { recursive: true, force: true });
    await rm(project.workspace, { recursive: true, force: true });
  });
  const seeded = await seedRelease({ ...project, common, profile: profileA });
  const now = new Date();
  const ready = await verifyRelease({
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
  assert.equal(ready.verdict.verdict, 'ready', JSON.stringify(ready.verdict.items.filter((item) => item.status === 'missing')));
  assert.equal(ready.verdict.summary.missing, 0);
  assert.ok(ready.verdict.summary.machine > 0);
  assert.ok(ready.verdict.summary.attested > 0);
  assert.ok(ready.verdict.items.every((item) => item.gap === 'none'));
  assert.ok(ready.verdict.perProfile.every((profile) => profile.status === 'ready'));
  assert.ok(ready.verdict.caveats.some((caveat) => /defined, not validated/.test(caveat)));
  assert.match(ready.verdict.verdictHash, /^[a-f0-9]{64}$/);

  const approval = await approveRelease({
    verdict: ready.verdict,
    approver: 'Fixture Release Manager',
    streams: testOnlyInteractiveStreams(),
    confirm: async () => 'APPROVE v1.2.0',
    now,
  });
  assert.equal(checkApproval(approval, {
    target: ready.verdict.target,
    artifactHash: ready.verdict.artifactHash,
    verdictHash: ready.verdict.verdictHash,
    now,
  }).valid, true);

  await write(project.artifactRoot, 'dist/index.js', 'export const run = () => 1;\nexport const extra = () => 2;\n// changed\n');
  const changedHashes = await runReadinessChecks({ root: project.root, artifactRoot: project.artifactRoot, requirements: [] });
  assert.notEqual(changedHashes.artifactHash, ready.verdict.artifactHash);
  const changed = await verifyRelease({
    target: 'v1.2.0',
    artifactHash: changedHashes.artifactHash,
    sourceFingerprint: changedHashes.sourceFingerprint,
    common,
    profiles: [profileA],
    evidenceDirectory: seeded.evidenceDir,
    attestationDirectory: seeded.attestationDir,
    attestationProvenance: seeded.provenance,
    now,
  });
  assert.equal(changed.verdict.verdict, 'blocked');
  assert.equal(changed.verdict.items.find((item) => item.id === 'common.no-secrets')!.gap, 'machine_invalid');
  assert.ok(changed.evidence.rejected.some((record) => record.reason === 'artifact_mismatch'));
  assert.ok(changed.attestations.rejected.some((record) => record.reason === 'artifact_mismatch'));

  const stale = checkApproval(approval, {
    target: changed.verdict.target,
    artifactHash: changed.verdict.artifactHash,
    verdictHash: changed.verdict.verdictHash,
    now,
  });
  assert.equal(stale.valid, false);
  assert.ok(stale.reasons.some((reason) => /Artifact hash changed/.test(reason)));
  assert.ok(stale.reasons.some((reason) => /verdict changed/.test(reason)));
});

test('attested gaps produce conditional, missing machine evidence produces blocked', async (t) => {
  const project = await createLibraryProject();
  t.after(async () => {
    await rm(project.root, { recursive: true, force: true });
    await rm(project.workspace, { recursive: true, force: true });
  });
  const seeded = await seedRelease({ ...project, common, profile: profileA });
  const args = {
    target: 'v1.2.0',
    artifactHash: seeded.artifactHash,
    sourceFingerprint: seeded.sourceFingerprint,
    common,
    profiles: [profileA],
    evidenceDirectory: seeded.evidenceDir,
    attestationDirectory: seeded.attestationDir,
    attestationProvenance: seeded.provenance,
  };

  await rm(join(seeded.attestationDir, 'att-common-rollback-plan.json'));
  const conditional = await verifyRelease(args);
  assert.equal(conditional.verdict.verdict, 'conditional');
  assert.equal(conditional.verdict.summary.missing, 1);
  const rollback = conditional.verdict.items.find((item) => item.id === 'common.rollback-plan')!;
  assert.equal(rollback.gap, 'attested_missing');
  assert.equal(conditional.verdict.perProfile.find((profile) => profile.profileId === 'common')!.status, 'conditional');

  await rm(join(seeded.evidenceDir, 'ev-common-code-gate.json'));
  const blocked = await verifyRelease(args);
  assert.equal(blocked.verdict.verdict, 'blocked');
  assert.equal(blocked.verdict.items.find((item) => item.id === 'common.code-gate')!.gap, 'machine_missing');
});

test('a profile with no evidence is blocked and never advertised as validated', () => {
  const verdict = buildReleaseVerdict({
    target: 'v0.1.0',
    artifactHash: 'b'.repeat(64),
    common,
    profiles: [profileB],
    evidence: [],
    attestations: [],
  });
  assert.equal(verdict.verdict, 'blocked');
  assert.equal(verdict.summary.machine, 0);
  assert.equal(verdict.summary.attested, 0);
  assert.ok(verdict.summary.missing > 0);
  assert.ok(verdict.caveats.some((caveat) => /Profile B .* defined, not validated/.test(caveat)));
});

test('a non-git fixture fails the history scan instead of passing silently', async (t) => {
  const project = await createServiceProject();
  t.after(async () => {
    await rm(project.root, { recursive: true, force: true });
    await rm(project.workspace, { recursive: true, force: true });
  });
  await rm(join(project.root, '.git'), { recursive: true, force: true });
  const result = await runReadinessChecks({
    root: project.root,
    artifactRoot: project.root,
    requirements: [common.requirements.find((requirement) => requirement.id === 'common.no-secrets')!],
  });
  assert.equal(result.runs.length, 1);
  assert.equal(result.runs[0]!.pass, false);
  assert.match(result.runs[0]!.summary, /failed to execute/i);
});
