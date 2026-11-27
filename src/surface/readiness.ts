import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fingerprintTree } from '../core/fingerprint.ts';
import { Ledger } from '../ledger/ledger.ts';
import { replayLedger } from '../ledger/replay.ts';
import {
  type AttestationProvenanceEvent,
  type AttestationProvenanceSource,
  type CollectAttestationResult,
} from '../readiness/attestation.ts';
import type { CollectEvidenceResult } from '../readiness/evidence.ts';
import { ReadinessError } from '../readiness/errors.ts';
import { sha256Canonical } from '../readiness/hash.ts';
import { defaultProfilesDirectory, loadReadinessProfiles } from '../readiness/profile.ts';
import { verifyRelease } from '../readiness/release.ts';
import {
  PROFILE_IDS,
  type AttestationRecord,
  type ProfileId,
  type ReleaseVerdict,
} from '../readiness/types.ts';

/**
 * Release verification surface.
 *
 * The caller chooses a target and profiles (the same fields the `verify` tool
 * schema accepts for `scope = "release"`) and an artifact path. The artifact
 * hash is always computed from the file on disk; a caller-supplied
 * `artifact_hash`/`artifactHash` is deliberately ignored.
 */
const defaultEvidenceDirectory = '.ano/readiness/evidence';
const defaultAttestationDirectory = '.ano/readiness/attestations';
const validationDirectory = '.ano/readiness/validation';
const sha256Pattern = /^[a-f0-9]{64}$/u;
const maxTargetLength = 128;

export interface VerifyReleaseSurfaceResult {
  target: string;
  artifact: { path: string; sha256: string; bytes: number };
  /** Convenience alias of `artifact.sha256` for callers that pass it on. */
  artifactHash: string;
  sourceFingerprint: string;
  verdict: ReleaseVerdict;
  evidence: CollectEvidenceResult;
  attestations: CollectAttestationResult;
  /** Ledger receipt for the `release.verdict` event, or null when recording is disabled. */
  ledger: RecordedReleaseVerdict | null;
}

export interface RecordedReleaseVerdict {
  verdictHash: string;
  duplicate: boolean;
  eventId: string | null;
}

export interface RecordReleaseVerdictOptions {
  idemKey?: string;
  actor?: string;
  clock?: () => number;
}

function invalidInput(message: string): ReadinessError {
  return new ReadinessError('RELEASE_INPUT', message);
}

function invalidPath(message: string): ReadinessError {
  return new ReadinessError('RELEASE_PATH', message);
}

function invalidArtifact(message: string): ReadinessError {
  return new ReadinessError('RELEASE_ARTIFACT', message);
}

function requiredNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalidInput(`${label} must be a non-empty string.`);
  }
  if (value.includes('\0')) throw invalidInput(`${label} must not contain NUL bytes.`);
  return value;
}

function optionalString(input: Record<string, unknown>, keys: readonly string[], label: string): string | undefined {
  let found: string | undefined;
  for (const key of keys) {
    const value = input[key];
    if (value === undefined) continue;
    const text = requiredNonEmptyString(value, label);
    if (found !== undefined && found !== text) throw invalidInput(`${label} was supplied more than once with different values.`);
    found = text;
  }
  return found;
}

function parseTarget(input: Record<string, unknown>): string {
  const target = requiredNonEmptyString(input.target, 'target');
  if (target.length > maxTargetLength) throw invalidInput(`target must be at most ${maxTargetLength} characters.`);
  if (/[\r\n]/u.test(target)) throw invalidInput('target must be a single line.');
  return target;
}

function parseProfiles(input: Record<string, unknown>): ProfileId[] {
  const value = input.profiles;
  if (!Array.isArray(value) || value.length === 0) throw invalidInput('profiles must be a non-empty array.');
  const seen = new Set<string>();
  const profiles: ProfileId[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !(PROFILE_IDS as readonly string[]).includes(entry)) {
      throw invalidInput(`profiles must contain only ${PROFILE_IDS.join(', ')}.`);
    }
    if (seen.has(entry)) throw invalidInput(`Profile ${entry} is selected more than once.`);
    seen.add(entry);
    profiles.push(entry as ProfileId);
  }
  return profiles;
}

function parseArtifactPath(input: Record<string, unknown>): string {
  const value = input.artifact_path;
  if (value === undefined) throw invalidInput('artifact_path is required; caller-supplied artifact hashes are not evidence.');
  return requiredNonEmptyString(value, 'artifact_path');
}

function parseRecordFlag(input: Record<string, unknown>): boolean {
  const value = input.record_verdict;
  if (value === undefined) return true;
  if (typeof value !== 'boolean') throw invalidInput('record_verdict must be a boolean when supplied.');
  return value;
}

async function projectRoot(root: string): Promise<string> {
  const absolute = resolve(requiredNonEmptyString(root, 'root'));
  let info;
  try {
    info = await lstat(absolute);
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'UNKNOWN';
    throw invalidPath(code === 'ENOENT' ? `Project root does not exist: ${absolute}` : `Cannot inspect project root ${absolute}: ${code}`);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw invalidPath(`Project root must be a plain directory: ${absolute}`);
  return absolute;
}

interface ResolvedPath {
  absolute: string;
  /** Project-relative path using forward slashes. */
  relative: string;
  exists: boolean;
}

/**
 * Resolves a caller-controlled path and keeps it inside the project root.
 * Symlinks are rejected at every path segment, not merely at the leaf, because
 * a symlinked parent would otherwise turn an in-root lexical path into an
 * arbitrary read. Missing paths are allowed only when the caller says so.
 */
async function resolveInsideRoot(
  root: string,
  raw: string,
  label: string,
  options: { mustExist: boolean; kind: 'file' | 'directory' },
): Promise<ResolvedPath> {
  if (raw.includes('\0')) throw invalidPath(`${label} must not contain NUL bytes.`);
  const absolute = resolve(root, raw);
  const rel = relative(root, absolute);
  if (rel.length === 0) throw invalidPath(`${label} must name a path inside the project root, not the root itself.`);
  if (rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) {
    throw invalidPath(`${label} escapes the project root: ${raw}`);
  }
  const segments = rel.split(sep).filter((segment) => segment.length > 0);
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]!);
    const last = index === segments.length - 1;
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'UNKNOWN';
      if (code === 'ENOENT' && !options.mustExist) {
        return { absolute, relative: segments.join('/'), exists: false };
      }
      if (code === 'ENOENT') throw invalidArtifact(`${label} does not exist: ${raw}`);
      throw invalidPath(`Cannot inspect ${label} ${raw}: ${code}`);
    }
    if (info.isSymbolicLink()) throw invalidPath(`${label} must not contain a symlink: ${raw}`);
    if (!last && !info.isDirectory()) throw invalidPath(`${label} has a non-directory parent: ${raw}`);
    if (last) {
      if (options.kind === 'file' && !info.isFile()) throw invalidArtifact(`${label} must be a regular file: ${raw}`);
      if (options.kind === 'directory' && !info.isDirectory()) throw invalidPath(`${label} must be a directory: ${raw}`);
    }
  }
  // Defense in depth: realpath catches junctions/reparse points that lstat does
  // not present as symbolic links on every platform.
  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(absolute)]);
  const realRelative = relative(realRoot, realTarget);
  if (realRelative.length === 0 || realRelative.startsWith('..') || isAbsolute(realRelative) || realRelative.split(sep).includes('..')) {
    throw invalidPath(`${label} resolves outside the project root: ${raw}`);
  }
  return { absolute, relative: segments.join('/'), exists: true };
}

async function hashArtifact(absolute: string, display: string): Promise<{ sha256: string; bytes: number }> {
  const before = await lstat(absolute);
  const hash = createHash('sha256');
  let bytes = 0;
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const stream = createReadStream(absolute);
    stream.on('data', (chunk: Buffer | string) => {
      hash.update(chunk);
      bytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
    });
    stream.on('error', rejectPromise);
    stream.on('end', resolvePromise);
  });
  const after = await lstat(absolute);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino || bytes !== after.size) {
    throw invalidArtifact(`artifact changed while it was being hashed: ${display}`);
  }
  return { sha256: hash.digest('hex'), bytes };
}

async function validationDirectoryFor(root: string): Promise<string | undefined> {
  const absolute = join(root, ...validationDirectory.split('/'));
  let info;
  try {
    info = await lstat(absolute);
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'UNKNOWN';
    if (code === 'ENOENT') return undefined;
    throw invalidPath(`Cannot inspect validation directory ${validationDirectory}: ${code}`);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw invalidPath(`Validation records must come from a plain directory: ${validationDirectory}`);
  }
  return absolute;
}

interface AttestationPayloadShape {
  attestation_ref?: unknown;
  attestation?: unknown;
}

/**
 * Reconstructs a full attestation record from a ledger payload when the writer
 * stored one. If the payload is only a reference (the older flat shape), the
 * reference is still accepted: the ledger event itself is the provenance, not
 * the JSON file on disk.
 */
function attestationFromPayload(payload: Record<string, unknown>): AttestationRecord | null {
  const shape = payload as AttestationPayloadShape;
  const raw = shape.attestation !== null && typeof shape.attestation === 'object' && !Array.isArray(shape.attestation)
    ? shape.attestation as Record<string, unknown>
    : payload;
  const required = ['schema', 'id', 'requirement_ids', 'profile_ids', 'release_target', 'signer', 'signed_at', 'expires_at', 'artifact_hash', 'statement'] as const;
  if (!required.every((key) => raw[key] !== undefined)) return null;
  const signer = raw.signer;
  if (signer === null || typeof signer !== 'object' || Array.isArray(signer)) return null;
  const signerRecord = signer as Record<string, unknown>;
  if (typeof signerRecord.name !== 'string' || typeof signerRecord.role !== 'string') return null;
  if (raw.schema !== 1 || typeof raw.id !== 'string' || !Array.isArray(raw.requirement_ids) || !Array.isArray(raw.profile_ids)
    || typeof raw.release_target !== 'string' || typeof raw.signed_at !== 'string' || typeof raw.expires_at !== 'string'
    || typeof raw.artifact_hash !== 'string' || typeof raw.statement !== 'string') return null;
  return {
    schema: 1,
    id: raw.id,
    requirement_ids: raw.requirement_ids.filter((id): id is string => typeof id === 'string'),
    profile_ids: raw.profile_ids.filter((id): id is AttestationRecord['profile_ids'][number] => typeof id === 'string'),
    release_target: raw.release_target,
    signer: { name: signerRecord.name, role: signerRecord.role },
    signed_at: raw.signed_at,
    expires_at: raw.expires_at,
    artifact_hash: raw.artifact_hash,
    statement: raw.statement,
  };
}

/**
 * Ledger-backed attestation provenance.
 *
 * Reads `readiness.attestation` events from the append-only ledger and indexes
 * them by the attestation reference they bind. A directory of attestation JSON
 * files alone is never provenance; only an event in this index can confirm that
 * a record was appended by a ledger writer.
 */
export function ledgerAttestationProvenance(root: string): AttestationProvenanceSource {
  const ledgerDirectory = join(resolve(root), '.ano', 'ledger');
  let index: Map<string, AttestationProvenanceEvent> | undefined;
  const load = (): Map<string, AttestationProvenanceEvent> => {
    if (index !== undefined) return index;
    const loaded = new Map<string, AttestationProvenanceEvent>();
    const replay = replayLedger(ledgerDirectory);
    for (const { event } of replay.entries) {
      if (event.kind !== 'readiness.attestation') continue;
      const payload = event.payload;
      const reference = typeof payload.attestation_ref === 'string' ? payload.attestation_ref : null;
      if (reference === null || !sha256Pattern.test(reference)) continue;
      // When the event stored the full record, its hash must agree with the
      // advertised reference; otherwise the event is self-contradictory.
      const stored = attestationFromPayload(payload);
      if (stored !== null && sha256Canonical(stored) !== reference) continue;
      if (loaded.has(reference)) continue;
      loaded.set(reference, {
        kind: 'readiness.attestation',
        eventId: event.id,
        actor: event.actor,
        recordedAt: new Date(event.hlc.physical).toISOString(),
        attestationRef: reference,
      });
    }
    index = loaded;
    return loaded;
  };
  return {
    async lookup(record: AttestationRecord): Promise<AttestationProvenanceEvent | null> {
      return load().get(sha256Canonical(record)) ?? null;
    },
  };
}

function releaseVerdictPayload(verdict: ReleaseVerdict): Record<string, unknown> {
  return {
    target: verdict.target,
    artifact_hash: verdict.artifactHash,
    ...(verdict.sourceFingerprint === null ? {} : { source_fingerprint: verdict.sourceFingerprint }),
    verdict: verdict.verdict,
    verdict_hash: verdict.verdictHash,
    summary: verdict.summary,
    items: verdict.items.map((item) => ({
      id: item.id,
      requirement: item.requirement,
      status: item.status,
      evidenceRef: item.evidenceRef,
      expiresAt: item.expiresAt,
    })),
    caveats: verdict.caveats,
  };
}

/**
 * Appends the machine verdict to the ledger as a `release.verdict` event. This
 * is deliberately a receipt, not an approval: human approval stays a separate
 * TTY-only operation.
 */
export async function recordReleaseVerdict(
  root: string,
  verdict: ReleaseVerdict,
  options: RecordReleaseVerdictOptions = {},
): Promise<RecordedReleaseVerdict> {
  if (!verdict || typeof verdict !== 'object' || typeof verdict.verdictHash !== 'string' || !sha256Pattern.test(verdict.verdictHash)) {
    throw invalidInput('A release verdict with a sha256 verdictHash is required.');
  }
  const ledger = await Ledger.open(resolve(root), {
    ...(options.actor === undefined ? {} : { actor: options.actor }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  try {
    const result = await ledger.append(
      { kind: 'release.verdict', payload: releaseVerdictPayload(verdict) },
      options.idemKey ?? `release.verdict:${verdict.verdictHash}`,
    );
    return {
      verdictHash: verdict.verdictHash,
      duplicate: result.duplicate,
      eventId: result.event?.id ?? null,
    };
  } finally {
    ledger.close();
  }
}

/**
 * Compute a real release verdict for `root`.
 *
 * Path rules:
 * - `artifact_path` is required and must resolve to a regular, non-symlink file
 *   inside the project root. Directories, missing paths and `..`/absolute
 *   escapes are rejected.
 * - Evidence and attestation directories default to
 *   `.ano/readiness/evidence` and `.ano/readiness/attestations`. Tests may pass
 *   `evidence_dir`/`evidenceDirectory` and
 *   `attestation_dir`/`attestationDirectory`; both are held to the same
 *   in-root, non-symlink rule so the tool can never read arbitrary locations.
 * - Validation records are only read from `.ano/readiness/validation`.
 *
 * The artifact SHA-256 and the source fingerprint are always computed here.
 * Any `artifact_hash`/`artifactHash` in `input` is ignored by this internal API;
 * the strict public schema rejects those fields. The artifact SHA-256 and source
 * fingerprint are independent: source hashing excludes `dist/` artifacts.
 */
export async function verifyReleaseSurface(
  root: string,
  input: Record<string, unknown>,
): Promise<VerifyReleaseSurfaceResult> {
  const target = parseTarget(input);
  const profileIds = parseProfiles(input);
  const artifactPath = parseArtifactPath(input);
  const recordVerdict = parseRecordFlag(input);
  const evidenceOverride = optionalString(input, ['evidence_dir', 'evidenceDirectory'], 'evidence directory');
  const attestationOverride = optionalString(input, ['attestation_dir', 'attestationDirectory'], 'attestation directory');
  const idemKey = optionalString(input, ['idem_key'], 'idem_key');
  if (idemKey !== undefined && idemKey.length > 128) throw invalidInput('idem_key must be at most 128 characters.');

  const project = await projectRoot(root);
  const now = new Date();

  const profiles = await loadReadinessProfiles(defaultProfilesDirectory(), await validationDirectoryFor(project).then((directory) =>
    directory === undefined ? {} : { validationDirectory: directory }));
  const selected = profiles.profiles.filter((profile) => profileIds.includes(profile.id as ProfileId));

  const artifact = await resolveInsideRoot(project, artifactPath, 'artifact_path', { mustExist: true, kind: 'file' });
  const artifactHash = await hashArtifact(artifact.absolute, artifact.relative);

  const evidenceDirectory = await resolveInsideRoot(
    project,
    evidenceOverride ?? defaultEvidenceDirectory,
    'evidence directory',
    { mustExist: false, kind: 'directory' },
  );
  const attestationDirectory = await resolveInsideRoot(
    project,
    attestationOverride ?? defaultAttestationDirectory,
    'attestation directory',
    { mustExist: false, kind: 'directory' },
  );

  const source = await fingerprintTree(project);
  if (source.degraded.length > 0) {
    throw invalidInput(`Source fingerprint is degraded: ${source.degraded.map((item) => `${item.path}:${item.code}`).join(', ')}`);
  }
  const result = await verifyRelease({
    target,
    artifactHash: artifactHash.sha256,
    sourceFingerprint: source.hash,
    common: profiles.common,
    profiles: selected,
    evidenceDirectory: evidenceDirectory.absolute,
    attestationDirectory: attestationDirectory.absolute,
    attestationProvenance: ledgerAttestationProvenance(project),
    now,
  });

  let ledger: RecordedReleaseVerdict | null = null;
  if (recordVerdict) {
    ledger = await recordReleaseVerdict(project, result.verdict, idemKey === undefined ? {} : { idemKey });
  }

  return {
    target,
    artifact: { path: artifact.relative, sha256: artifactHash.sha256, bytes: artifactHash.bytes },
    artifactHash: artifactHash.sha256,
    sourceFingerprint: source.hash,
    verdict: result.verdict,
    evidence: result.evidence,
    attestations: result.attestations,
    ledger,
  };
}
