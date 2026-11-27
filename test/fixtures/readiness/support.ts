import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  defaultProfilesDirectory,
  runReadinessChecks,
  sha256Canonical,
  sha256Text,
  writeCheckEvidence,
  type AttestationProvenanceEvent,
  type AttestationProvenanceSource,
  type AttestationRecord,
  type EvidenceRecord,
  type Profile,
  type ReadinessCheckResult,
  type Requirement,
  type ValidationFileRecord,
} from '../../../src/readiness/index.ts';
import { PROFILE_IDS } from '../../../src/readiness/types.ts';

export async function temp(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function write(root: string, path: string, content: string): Promise<void> {
  const target = join(root, ...path.split('/'));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}

export function git(root: string, args: string[]): void {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
}

export function initGit(root: string): void {
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'readiness@example.invalid']);
  git(root, ['config', 'user.name', 'Readiness Fixture']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'fixture']);
}

export function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

const libraryPackage = JSON.stringify({
  name: 'fixture-library',
  version: '1.2.0',
  license: 'MIT',
  type: 'module',
  files: ['dist', 'README.md', 'LICENSE', 'CHANGELOG.md'],
  types: './dist/index.d.ts',
  exports: {
    '.': {
      types: './dist/index.d.ts',
      import: './dist/index.js',
    },
  },
}, null, 2);

export interface LibraryProject {
  root: string;
  artifactRoot: string;
  workspace: string;
}

/** Synthetic library project. Everything is fabricated for local tests. */
export async function createLibraryProject(): Promise<LibraryProject> {
  const root = await temp('ano readiness library ');
  const workspace = await temp('ano readiness workspace ');
  const artifactRoot = join(root, 'pack');
  await write(root, 'package.json', libraryPackage);
  await write(root, 'README.md', '# fixture-library\n\nKnown limitations: see [limitations](docs/limitations.md).\n');
  await write(root, 'CHANGELOG.md', '# Changelog\n\n## [1.2.0]\n\n- Synthetic fixture release.\n');
  await write(root, 'docs/limitations.md', '# Limitations\n\nThis synthetic fixture does not prove production behavior.\n');
  await write(root, 'api/baseline.json', JSON.stringify({ version: '1.1.0', exports: [{ name: 'run', kind: 'function' }] }));
  await write(root, 'api/current.json', JSON.stringify({ version: '1.2.0', exports: [{ name: 'run', kind: 'function' }, { name: 'extra', kind: 'function' }] }));
  await write(artifactRoot, 'package.json', libraryPackage);
  await write(artifactRoot, 'README.md', '# fixture-library\n\nSee [limitations](../docs/limitations.md).\n');
  await write(artifactRoot, 'LICENSE', 'MIT\n');
  await write(artifactRoot, 'CHANGELOG.md', '# Changelog\n\n## [1.2.0]\n');
  await write(artifactRoot, 'dist/index.js', 'export const run = () => 1;\nexport const extra = () => 2;\n');
  await write(artifactRoot, 'dist/index.d.ts', 'export declare const run: () => number;\nexport declare const extra: () => number;\n');
  initGit(root);
  return { root, artifactRoot, workspace };
}

export interface ServiceProject {
  root: string;
  workspace: string;
}

/** Synthetic backend service project with a pre-production config file. */
export async function createServiceProject(): Promise<ServiceProject> {
  const root = await temp('ano readiness service ');
  const workspace = await temp('ano readiness workspace ');
  await write(root, 'README.md', '# fixture-service\n\nKnown limitations: see [limitations](docs/limitations.md).\n');
  await write(root, 'docs/limitations.md', '# Limitations\n\nSynthetic service fixture.\n');
  await write(root, 'deploy/service.json', JSON.stringify({
    health: '/healthz',
    ready: '/readyz',
    timeouts: { requestMs: 2000 },
    rateLimit: { rps: 50 },
    circuitBreaker: { failures: 5 },
    env: { DB_PASSWORD: 'secretRef:db-password', API_TOKEN: '${API_TOKEN}' },
  }, null, 2));
  initGit(root);
  return { root, workspace };
}

export interface SeedResult {
  evidenceDir: string;
  attestationDir: string;
  artifactHash: string;
  sourceFingerprint: string;
  checks: ReadinessCheckResult;
  /** Test seam: stands in for the ledger-backed provenance source production injects. */
  provenance: AttestationProvenanceSource;
}

/** Writes one valid machine evidence record plus its raw output file. */
export async function writeEvidenceCase(directory: string, name: string, record: EvidenceRecord, rawText = 'synthetic pass'): Promise<void> {
  await mkdir(join(directory, 'raw'), { recursive: true });
  const rawArtifact = `raw/${name}.txt`;
  await writeFile(join(directory, ...rawArtifact.split('/')), rawText, 'utf8');
  await writeFile(join(directory, `${name}.json`), `${JSON.stringify({
    ...record,
    raw_artifact: rawArtifact,
    raw_artifact_hash: sha256Text(rawText),
  }, null, 2)}\n`, 'utf8');
}

export async function writeJson(directory: string, name: string, value: unknown): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function machineRecord(
  requirement: Requirement,
  artifactHash: string,
  sourceFingerprint: string,
  now: Date,
  overrides: Partial<EvidenceRecord> = {},
): EvidenceRecord {
  const base: EvidenceRecord = {
    schema: 1,
    id: `ev-${slug(requirement.id)}`,
    requirement_id: requirement.id,
    kind: requirement.kinds[0] ?? 'artifact_scan',
    source_id: 'fixture://synthetic',
    timestamp: new Date(now.getTime() - 60_000).toISOString(),
    artifact_hash: artifactHash,
    source_fingerprint: sourceFingerprint,
    raw_artifact: 'raw/placeholder.txt',
    raw_artifact_hash: '0'.repeat(64),
    result: 'pass',
    freshness_days: requirement.freshnessDays,
  };
  return { ...base, ...overrides };
}

export function attestationRecord(
  requirement: Requirement,
  artifactHash: string,
  target: string,
  now: Date,
  overrides: Partial<AttestationRecord> = {},
): AttestationRecord {
  const days = Math.min(Math.max(requirement.freshnessDays, 1), 30);
  const base: AttestationRecord = {
    schema: 1,
    id: `att-${slug(requirement.id)}`,
    requirement_ids: [requirement.id],
    profile_ids: [requirement.scope],
    release_target: target,
    signer: { name: 'Fixture Release Owner', role: 'Maintainer' },
    signed_at: new Date(now.getTime() - 60_000).toISOString(),
    expires_at: new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString(),
    artifact_hash: artifactHash,
    statement: 'Synthetic fixture attestation. This is not a real release signature.',
  };
  return { ...base, ...overrides };
}

/** Simulates ledger provenance for records written by a fixture. Test seam only. */
export function fixtureProvenance(records: AttestationRecord[]): AttestationProvenanceSource {
  const events = new Map<string, AttestationProvenanceEvent>();
  records.forEach((record, index) => {
    events.set(record.id, {
      kind: 'readiness.attestation',
      eventId: `01J${String(index + 1).padStart(23, '0')}`,
      actor: 'fixture-ledger',
      recordedAt: new Date(Date.parse(record.signed_at) + 1000).toISOString(),
      attestationRef: sha256Canonical(record),
    });
  });
  return {
    async lookup(record) {
      return events.get(record.id) ?? null;
    },
  };
}

export interface SeedReleaseOptions {
  root: string;
  artifactRoot: string;
  workspace: string;
  common: Profile;
  profile: Profile;
  target?: string;
  now?: Date;
}

/**
 * Runs local checks and fills the remaining requirements with synthetic evidence/attestations.
 *
 * Check output is written as local declarations (never machine evidence). A machine
 * requirement whose local check failed is left without machine evidence on purpose:
 * the fixture never fabricates external proof for a failed local check.
 */
export async function seedRelease(options: SeedReleaseOptions): Promise<SeedResult> {
  const now = options.now ?? new Date();
  const target = options.target ?? 'v1.2.0';
  const evidenceDir = join(options.workspace, 'evidence');
  const attestationDir = join(options.workspace, 'attestations');
  await mkdir(evidenceDir, { recursive: true });
  await mkdir(attestationDir, { recursive: true });
  const requirements = [...options.common.requirements, ...options.profile.requirements];
  const checks = await runReadinessChecks({ root: options.root, artifactRoot: options.artifactRoot, requirements, now });
  await writeCheckEvidence(evidenceDir, checks, now);
  const runs = new Map(checks.runs.map((run) => [run.requirementId, run]));
  const attestations: AttestationRecord[] = [];
  for (const requirement of requirements) {
    if (requirement.evidence === 'machine') {
      const run = runs.get(requirement.id);
      if (run !== undefined && !run.pass) continue;
      const record = machineRecord(requirement, checks.artifactHash, checks.sourceFingerprint, now);
      await writeEvidenceCase(evidenceDir, record.id, record);
      continue;
    }
    const record = attestationRecord(requirement, checks.artifactHash, target, now);
    await writeJson(attestationDir, record.id, record);
    attestations.push(record);
  }
  return {
    evidenceDir,
    attestationDir,
    artifactHash: checks.artifactHash,
    sourceFingerprint: checks.sourceFingerprint,
    checks,
    provenance: fixtureProvenance(attestations),
  };
}

/** Copies the bundled profiles into a temp directory, optionally replacing some files. */
export async function copyProfiles(destination: string, overrides: Record<string, string> = {}): Promise<string> {
  const source = defaultProfilesDirectory();
  await mkdir(destination, { recursive: true });
  for (const id of ['common', ...PROFILE_IDS]) {
    const file = `${id}.toml`;
    const text = overrides[id] ?? await readFile(join(source, file), 'utf8');
    await writeFile(join(destination, file), text, 'utf8');
  }
  return destination;
}

/** Writes an external validation record as `<profile>.validation.json`. */
export async function writeValidationRecord(directory: string, record: ValidationFileRecord): Promise<void> {
  await writeJson(directory, `${record.profile_id}.validation`, record);
}

export async function profileText(id: string): Promise<string> {
  return readFile(join(defaultProfilesDirectory(), `${id}.toml`), 'utf8');
}
