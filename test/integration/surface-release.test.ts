import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { fingerprintTree } from '../../src/core/fingerprint.ts';
import { Ledger } from '../../src/ledger/ledger.ts';
import { sha256Canonical, sha256Text } from '../../src/readiness/hash.ts';
import { loadReadinessProfiles } from '../../src/readiness/profile.ts';
import type { AttestationRecord, Requirement } from '../../src/readiness/types.ts';
import { verifyReleaseSurface } from '../../src/surface/readiness.ts';

const loaded = await loadReadinessProfiles();
const common = loaded.common;
const profileA = loaded.profiles.find((profile) => profile.id === 'A')!;
const requirements = [...common.requirements, ...profileA.requirements];
const target = '1.2.3';

async function temp(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function write(root: string, path: string, content: string | Buffer): Promise<void> {
  const absolute = join(root, ...path.split('/'));
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
}

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, '0') + '\0';
}

/** Minimal valid USTAR header; enough to make the fixture a real tarball. */
function tarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512, 0);
  header.write(name.slice(0, 100), 0, 100, 'utf8');
  header.write(octal(0o644, 8), 100, 8, 'ascii');
  header.write(octal(0, 8), 108, 8, 'ascii');
  header.write(octal(0, 8), 116, 8, 'ascii');
  header.write(octal(size, 12), 124, 12, 'ascii');
  header.write(octal(Math.floor(Date.now() / 1000), 12), 136, 12, 'ascii');
  header.write('        ', 148, 8, 'ascii');
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

function tarGz(files: { name: string; content: string }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const file of files) {
    const content = Buffer.from(file.content, 'utf8');
    blocks.push(tarHeader(file.name, content.length));
    const padded = Buffer.alloc(Math.ceil(content.length / 512) * 512, 0);
    content.copy(padded);
    blocks.push(padded);
  }
  blocks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(blocks));
}

interface Project {
  root: string;
  artifactPath: string;
  artifactHash: string;
  artifactBytes: number;
}

async function project(): Promise<Project> {
  const root = await temp('ano surface release ');
  await write(root, 'package.json', JSON.stringify({ name: 'surface-fixture', version: '1.2.3', private: true }, null, 2));
  await write(root, 'src/index.ts', 'export const value = 1;\n');
  const bytes = tarGz([
    { name: 'package/package.json', content: JSON.stringify({ name: 'surface-fixture', version: '1.2.3' }) },
    { name: 'package/dist/index.js', content: 'export const value = 1;\n' },
  ]);
  const artifactPath = 'release/surface-fixture-1.2.3.tgz';
  await write(root, artifactPath, bytes);
  return {
    root,
    artifactPath,
    artifactHash: createHash('sha256').update(bytes).digest('hex'),
    artifactBytes: bytes.length,
  };
}

async function writeMachineEvidence(root: string, requirement: Requirement, artifactHash: string, now: number): Promise<void> {
  const text = `synthetic pass for ${requirement.id}`;
  const id = `ev-${requirement.id}`;
  const directory = join(root, '.ano', 'readiness', 'evidence');
  await write(root, `.ano/readiness/evidence/raw/${id}.txt`, text);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${id}.json`), `${JSON.stringify({
    schema: 1,
    id,
    requirement_id: requirement.id,
    kind: requirement.kinds[0] ?? 'artifact_scan',
    source_id: 'fixture://surface-release',
    timestamp: new Date(now - 60_000).toISOString(),
    artifact_hash: artifactHash,
    raw_artifact: `raw/${id}.txt`,
    raw_artifact_hash: sha256Text(text),
    result: 'pass',
    freshness_days: Math.max(1, requirement.freshnessDays),
  }, null, 2)}\n`, 'utf8');
}

async function writeAttestation(root: string, requirement: Requirement, artifactHash: string, now: number): Promise<AttestationRecord> {
  const id = `att-${requirement.id}`;
  const record: AttestationRecord = {
    schema: 1,
    id,
    requirement_ids: [requirement.id],
    profile_ids: [requirement.scope],
    release_target: target,
    signer: { name: 'Surface Fixture Owner', role: 'Maintainer' },
    signed_at: new Date(now - 60_000).toISOString(),
    expires_at: new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString(),
    artifact_hash: artifactHash,
    statement: 'Synthetic test attestation recorded through the ledger fixture.',
  };
  await write(root, `.ano/readiness/attestations/${id}.json`, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

async function recordAttestations(root: string, records: AttestationRecord[], now: number): Promise<void> {
  const ledger = await Ledger.open(root, { sessionId: 'SURFACERELEASE', clock: () => now });
  try {
    for (const record of records) {
      await ledger.append({
        kind: 'readiness.attestation',
        payload: { attestation_ref: sha256Canonical(record), attestation: record },
      }, `surface:attestation:${record.id}`);
    }
  } finally {
    ledger.close();
  }
}

test('a real tarball produces a ready verdict, local SHA-256, current fingerprint and a ledger receipt', async (t) => {
  const fixture = await project();
  t.after(async () => { await rm(fixture.root, { recursive: true, force: true }); });
  // An existing but empty validation directory means "no validated records",
  // not an error: every bundled profile is defined, not validated.
  await mkdir(join(fixture.root, '.ano', 'readiness', 'validation'), { recursive: true });
  const now = Date.now();
  const attestations: AttestationRecord[] = [];
  for (const requirement of requirements) {
    if (requirement.evidence === 'attested') attestations.push(await writeAttestation(fixture.root, requirement, fixture.artifactHash, now));
    else await writeMachineEvidence(fixture.root, requirement, fixture.artifactHash, now);
  }
  await recordAttestations(fixture.root, attestations, now);
  const expectedSource = (await fingerprintTree(fixture.root)).hash;

  const result = await verifyReleaseSurface(fixture.root, {
    target,
    profiles: ['A'],
    artifact_path: fixture.artifactPath,
    // Self-reported hashes must be ignored; the file is hashed locally.
    artifact_hash: '0'.repeat(64),
    artifactHash: 'f'.repeat(64),
  });

  assert.equal(result.target, target);
  assert.equal(result.artifact.path, fixture.artifactPath);
  assert.equal(result.artifact.sha256, fixture.artifactHash);
  assert.equal(result.artifact.bytes, fixture.artifactBytes);
  assert.equal(result.artifactHash, fixture.artifactHash);
  assert.equal(result.sourceFingerprint, expectedSource);
  assert.equal(result.verdict.verdict, 'ready', JSON.stringify(result.verdict.items.filter((item) => item.gap !== 'none')));
  assert.equal(result.verdict.artifactHash, fixture.artifactHash);
  assert.equal(result.verdict.summary.missing, 0);
  assert.ok(result.verdict.summary.machine > 0);
  assert.equal(result.verdict.summary.attested, 2);
  assert.equal(result.evidence.rejected.length, 0, JSON.stringify(result.evidence.rejected));
  assert.equal(result.attestations.rejected.length, 0, JSON.stringify(result.attestations.rejected));
  assert.equal(result.attestations.accepted.length, 2);
  assert.ok(result.ledger);
  assert.equal(result.ledger.duplicate, false);
  assert.match(result.ledger.eventId ?? '', /^[0-9A-HJKMNP-TV-Z]{26}$/u);

  const readback = await Ledger.open(fixture.root, { sessionId: 'SURFACEREAD' });
  try {
    assert.equal(readback.getReleaseVerdict(result.verdict.verdictHash)?.verdict, 'ready');
  } finally {
    readback.close();
  }

  const repeated = await verifyReleaseSurface(fixture.root, { target, profiles: ['A'], artifact_path: fixture.artifactPath });
  assert.equal(repeated.ledger?.duplicate, true);
  assert.equal(repeated.ledger?.eventId, result.ledger.eventId);
});

test('missing machine evidence is an honest blocked verdict, not a ready one', async (t) => {
  const fixture = await project();
  t.after(async () => { await rm(fixture.root, { recursive: true, force: true }); });

  const result = await verifyReleaseSurface(fixture.root, {
    target,
    profiles: ['A'],
    artifact_path: fixture.artifactPath,
    record_verdict: false,
  });

  assert.equal(result.verdict.verdict, 'blocked');
  assert.ok(result.verdict.summary.missing > 0);
  assert.equal(result.verdict.summary.machine, 0);
  assert.equal(result.verdict.summary.attested, 0);
  assert.equal(result.evidence.accepted.length, 0);
  assert.equal(result.attestations.accepted.length, 0);
  assert.ok(result.verdict.items.some((item) => item.gap === 'machine_missing'));
  assert.equal(result.ledger, null);
});

test('attestation JSON without a readiness.attestation ledger event is not human endorsement', async (t) => {
  const fixture = await project();
  t.after(async () => { await rm(fixture.root, { recursive: true, force: true }); });
  const now = Date.now();
  for (const requirement of requirements) {
    if (requirement.evidence === 'attested') await writeAttestation(fixture.root, requirement, fixture.artifactHash, now);
    else await writeMachineEvidence(fixture.root, requirement, fixture.artifactHash, now);
  }
  // Deliberately no ledger append: the bare JSON files must not pass provenance.

  const result = await verifyReleaseSurface(fixture.root, {
    target,
    profiles: ['A'],
    artifact_path: fixture.artifactPath,
    record_verdict: false,
  });

  assert.notEqual(result.verdict.verdict, 'ready');
  assert.equal(result.attestations.accepted.length, 0);
  assert.ok(result.attestations.rejected.some((record) => record.reason === 'provenance_missing'));
  assert.ok(result.verdict.items.some((item) => item.gap === 'attestation_invalid'));
});

test('artifact and evidence paths stay inside the project and reject non-files', async (t) => {
  const fixture = await project();
  t.after(async () => { await rm(fixture.root, { recursive: true, force: true }); });

  await assert.rejects(
    verifyReleaseSurface(fixture.root, { target, profiles: ['A'] }),
    /artifact_path is required/u,
  );
  await assert.rejects(
    verifyReleaseSurface(fixture.root, { target, profiles: ['A'], artifact_path: 'release' }),
    /regular file/u,
  );
  await assert.rejects(
    verifyReleaseSurface(fixture.root, { target, profiles: ['A'], artifact_path: '../outside.tgz' }),
    /escapes the project root/u,
  );
  await assert.rejects(
    verifyReleaseSurface(fixture.root, { target, profiles: ['A'], artifact_path: fixture.artifactPath, evidence_dir: '../evidence' }),
    /escapes the project root/u,
  );
  await assert.rejects(
    verifyReleaseSurface(fixture.root, { target, profiles: ['A'], artifact_path: fixture.artifactPath, evidence_dir: 'package.json' }),
    /must be a directory/u,
  );
  await assert.rejects(
    verifyReleaseSurface(fixture.root, { target, profiles: ['B', 'B'], artifact_path: fixture.artifactPath }),
    /selected more than once/u,
  );

  const absolute = join(fixture.root, ...fixture.artifactPath.split('/'));
  const result = await verifyReleaseSurface(fixture.root, {
    target,
    profiles: ['A'],
    artifact_path: absolute,
    record_verdict: false,
  });
  assert.equal(result.artifact.path, fixture.artifactPath);
  assert.equal(result.artifactHash, fixture.artifactHash);
});
