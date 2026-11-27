import { randomUUID } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ReadinessError } from './errors.ts';
import { sha256Canonical } from './hash.ts';
import { assertInteractiveTty, type TtyStreams } from './tty.ts';
import {
  attestationSchema,
  type AttestationRecord,
  type RejectedAttestation,
  type Requirement,
  type RequirementScope,
  type ValidatedAttestation,
} from './types.ts';

const dayMs = 24 * 60 * 60 * 1000;
const clockSkewMs = 5 * 60 * 1000;
const signatureSkewMs = 60 * 1000;
const ledgerEventIdPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** The subset of a ledger `readiness.attestation` event that proves a record was appended. */
export interface AttestationProvenanceEvent {
  /** Must be the ledger `readiness.attestation` kind. */
  kind: 'readiness.attestation';
  /** Ledger event id (ULID), for example the id of the `readiness.attestation` event. */
  eventId: string;
  /** Ledger actor that appended the event. */
  actor: string;
  /** When the ledger appended the event (ISO-8601). */
  recordedAt: string;
  /** SHA-256 canonical hash of the exact attestation record stored in the event payload. */
  attestationRef: string;
}

/**
 * Source of ledger provenance for attestations.
 *
 * This module deliberately does not read `src/ledger` itself. The release flow
 * injects a source backed by the real append-only ledger; anything else — a bare
 * directory of JSON files, a caller-supplied map, or no source at all — is
 * refused. That keeps a directory of hand-written JSON from being treated as a
 * signature.
 */
export interface AttestationProvenanceSource {
  lookup(record: AttestationRecord): Promise<AttestationProvenanceEvent | null>;
}

export interface CollectAttestationOptions {
  directory: string;
  requirements: ReadonlyMap<string, Requirement>;
  currentArtifactHash: string;
  releaseTarget: string;
  /**
   * Ledger-backed provenance source. Optional only so that omitting it fails
   * closed: without a source every attestation is rejected as unproven.
   */
  provenance?: AttestationProvenanceSource;
  now?: Date;
}

export interface CollectAttestationResult {
  accepted: ValidatedAttestation[];
  rejected: RejectedAttestation[];
}

function reject(file: string, id: string | null, requirementId: string | null, reason: string, detail: string): RejectedAttestation {
  return { file, id, requirementId, reason, detail };
}

function issueText(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues.map((issue) => `${issue.path.join('.') || '<record>'}: ${issue.message}`).join('; ');
}

function recordRef(record: AttestationRecord): string {
  return sha256Canonical(record);
}

interface ProvenanceFailure {
  ok: false;
  reason: string;
  detail: string;
}

/**
 * Default-deny provenance check. The record is accepted only when an injected
 * ledger-backed source confirms that this exact record was appended as a
 * `readiness.attestation` event. The returned event must not predate signing and
 * must not be in the future.
 */
async function verifyProvenance(
  record: AttestationRecord,
  signedAt: number,
  options: CollectAttestationOptions,
  now: number,
): Promise<{ ok: true } | ProvenanceFailure> {
  if (options.provenance === undefined) {
    return {
      ok: false,
      reason: 'provenance_missing',
      detail: 'No ledger provenance source is configured; a bare JSON file is not a signed attestation.',
    };
  }
  let event: AttestationProvenanceEvent | null;
  try {
    event = await options.provenance.lookup(record);
  } catch (error) {
    return {
      ok: false,
      reason: 'provenance_unavailable',
      detail: `Ledger provenance lookup failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (event === null) {
    return {
      ok: false,
      reason: 'provenance_missing',
      detail: 'No readiness.attestation ledger event binds this attestation record.',
    };
  }
  if (event.kind !== 'readiness.attestation') {
    return { ok: false, reason: 'provenance_invalid', detail: 'Provenance event is not a readiness.attestation ledger event.' };
  }
  if (!ledgerEventIdPattern.test(event.eventId)) {
    return { ok: false, reason: 'provenance_invalid', detail: 'Provenance event id is not a ledger ULID.' };
  }
  if (typeof event.actor !== 'string' || event.actor.trim().length === 0) {
    return { ok: false, reason: 'provenance_invalid', detail: 'Provenance event has no ledger actor.' };
  }
  if (event.attestationRef !== recordRef(record)) {
    return {
      ok: false,
      reason: 'provenance_mismatch',
      detail: 'Ledger event is bound to a different attestation hash than the file on disk.',
    };
  }
  const recordedAt = Date.parse(event.recordedAt);
  if (Number.isNaN(recordedAt)) {
    return { ok: false, reason: 'provenance_invalid', detail: 'Provenance recordedAt is not a valid timestamp.' };
  }
  if (recordedAt > now + clockSkewMs) {
    return { ok: false, reason: 'provenance_invalid', detail: 'Provenance recordedAt is in the future.' };
  }
  if (recordedAt < signedAt - signatureSkewMs) {
    return { ok: false, reason: 'provenance_invalid', detail: 'Ledger event predates the attestation signature.' };
  }
  return { ok: true };
}

/** Verifies persisted attestations. An attestation can never satisfy a machine-only requirement. */
export async function collectFileAttestations(options: CollectAttestationOptions): Promise<CollectAttestationResult> {
  const now = (options.now ?? new Date()).getTime();
  let entries;
  try {
    entries = await readdir(options.directory, { withFileTypes: true });
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return { accepted: [], rejected: [] };
    }
    throw error;
  }
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => entry.name).sort();
  const accepted: ValidatedAttestation[] = [];
  const rejected: RejectedAttestation[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const absolute = resolve(options.directory, file);
    let record: AttestationRecord;
    try {
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        rejected.push(reject(file, null, null, 'symlink', 'Attestations must be regular files.'));
        continue;
      }
      const parsed = JSON.parse(await readFile(absolute, 'utf8')) as unknown;
      const result = attestationSchema.safeParse(parsed);
      if (!result.success) {
        const id = typeof parsed === 'object' && parsed !== null && 'id' in parsed && typeof parsed.id === 'string' ? parsed.id : null;
        rejected.push(reject(file, id, null, 'schema_invalid', issueText(result.error)));
        continue;
      }
      record = result.data;
    } catch (error) {
      rejected.push(reject(file, null, null, 'unreadable', error instanceof Error ? error.message : String(error)));
      continue;
    }
    if (seen.has(record.id)) {
      rejected.push(reject(file, record.id, null, 'duplicate_id', 'Attestation id is duplicated.'));
      continue;
    }
    seen.add(record.id);
    if (new Set(record.requirement_ids).size !== record.requirement_ids.length) {
      rejected.push(reject(file, record.id, null, 'duplicate_requirement', 'requirement_ids contains duplicates.'));
      continue;
    }
    if (new Set(record.profile_ids).size !== record.profile_ids.length) {
      rejected.push(reject(file, record.id, null, 'duplicate_profile', 'profile_ids contains duplicates.'));
      continue;
    }
    if (record.signer.name.trim().length === 0 || record.signer.role.trim().length === 0) {
      rejected.push(reject(file, record.id, null, 'unnamed_signer', 'Attestation must name a signer and role.'));
      continue;
    }
    const signedAt = Date.parse(record.signed_at);
    const expiresAt = Date.parse(record.expires_at);
    if (Number.isNaN(signedAt) || Number.isNaN(expiresAt)) {
      rejected.push(reject(file, record.id, null, 'bad_timestamp', 'Attestation timestamps are not valid.'));
      continue;
    }
    if (signedAt > now + clockSkewMs) {
      rejected.push(reject(file, record.id, null, 'future_signed_at', 'signed_at is in the future.'));
      continue;
    }
    if (record.artifact_hash !== options.currentArtifactHash) {
      for (const requirementId of record.requirement_ids) {
        rejected.push(reject(file, record.id, requirementId, 'artifact_mismatch', 'Attestation is bound to a different artifact.'));
      }
      continue;
    }
    if (record.release_target !== options.releaseTarget) {
      for (const requirementId of record.requirement_ids) {
        rejected.push(reject(file, record.id, requirementId, 'target_mismatch', 'Attestation is for a different release target.'));
      }
      continue;
    }
    const provenance = await verifyProvenance(record, signedAt, options, now);
    if (!provenance.ok) {
      for (const requirementId of record.requirement_ids) {
        rejected.push(reject(file, record.id, requirementId, provenance.reason, provenance.detail));
      }
      continue;
    }
    for (const requirementId of record.requirement_ids) {
      const requirement = options.requirements.get(requirementId);
      if (requirement === undefined) {
        rejected.push(reject(file, record.id, requirementId, 'unknown_requirement', 'No loaded requirement matches this id.'));
        continue;
      }
      if (!record.profile_ids.includes(requirement.scope)) {
        rejected.push(reject(file, record.id, requirementId, 'scope_mismatch', `Attestation does not include scope ${requirement.scope}.`));
        continue;
      }
      if (requirement.evidence === 'machine') {
        rejected.push(reject(file, record.id, requirementId, 'machine_requirement', 'An attestation cannot satisfy a machine-only requirement.'));
        continue;
      }
      // Attestation life can only be shortened by the requirement window, never
      // extended by the record itself: effective = min(expires_at, signed_at + freshness).
      if (!Number.isSafeInteger(requirement.freshnessDays) || requirement.freshnessDays <= 0) {
        rejected.push(reject(file, record.id, requirementId, 'no_freshness', 'Requirement declares no positive freshness window; attestation expiry cannot be bounded.'));
        continue;
      }
      const effectiveExpiry = Math.min(expiresAt, signedAt + requirement.freshnessDays * dayMs);
      if (effectiveExpiry <= now) {
        rejected.push(reject(file, record.id, requirementId, 'expired', `Attestation expired at ${new Date(effectiveExpiry).toISOString()}.`));
        continue;
      }
      accepted.push({
        status: 'attested',
        id: record.id,
        requirementId,
        profileIds: record.profile_ids as RequirementScope[],
        signer: { name: record.signer.name, role: record.signer.role },
        signedAt: record.signed_at,
        expiresAt: new Date(effectiveExpiry).toISOString(),
        artifactHash: record.artifact_hash,
        releaseTarget: record.release_target,
        attestationRef: recordRef(record),
      });
    }
  }
  accepted.sort((a, b) => (a.signedAt === b.signedAt ? a.id.localeCompare(b.id) : b.signedAt.localeCompare(a.signedAt)));
  return { accepted, rejected };
}

export interface SignAttestationOptions {
  requirementIds: string[];
  profileIds: RequirementScope[];
  releaseTarget: string;
  artifactHash: string;
  signer: { name: string; role: string };
  expiresAt: string;
  statement: string;
  /**
   * Required. Pass the real process streams for a human CLI TTY. There is no
   * ambient fallback: an approval can never be produced without explicit streams.
   * Fake streams are only available through the explicit test-only seam in
   * `./test-seams.ts`, which is not exported from the module surface.
   */
  streams: TtyStreams;
  confirm: (prompt: string) => Promise<string>;
  now?: Date;
}

/**
 * Human-only attestation entry point. It is intentionally not wired into MCP or the
 * seven agent tools; non-interactive callers are rejected before any prompt.
 *
 * The returned record is a proof *format*, not cryptographic non-repudiation. It is
 * only accepted later when a ledger source confirms a `readiness.attestation` event
 * binding this exact record; possession of the JSON file proves nothing on its own.
 */
export async function signAttestation(options: SignAttestationOptions): Promise<AttestationRecord> {
  assertInteractiveTty(options.streams);
  if (typeof options.confirm !== 'function') {
    throw new ReadinessError('CONFIRM_REQUIRED', 'Attestation requires an interactive confirmation callback.');
  }
  if (options.requirementIds.length === 0) throw new ReadinessError('ATTESTATION_EMPTY', 'An attestation must cover at least one requirement.');
  if (options.signer.name.trim().length === 0 || options.signer.role.trim().length === 0) {
    throw new ReadinessError('ATTESTATION_SIGNER', 'A named signer and role are required.');
  }
  const now = options.now ?? new Date();
  if (!(Date.parse(options.expiresAt) > now.getTime())) throw new ReadinessError('ATTESTATION_EXPIRY', 'Attestation expiry must be in the future.');
  const expected = `ATTEST ${options.releaseTarget}`;
  const answer = await options.confirm(`Type "${expected}" to sign: `);
  if (answer.trim() !== expected) throw new ReadinessError('ATTESTATION_NOT_CONFIRMED', 'Attestation confirmation did not match.');
  const record: AttestationRecord = {
    schema: 1,
    id: randomUUID(),
    requirement_ids: [...new Set(options.requirementIds)],
    profile_ids: [...new Set(options.profileIds)],
    release_target: options.releaseTarget,
    signer: { name: options.signer.name.trim(), role: options.signer.role.trim() },
    signed_at: now.toISOString(),
    expires_at: options.expiresAt,
    artifact_hash: options.artifactHash,
    statement: options.statement,
  };
  const parsed = attestationSchema.safeParse(record);
  if (!parsed.success) throw new ReadinessError('ATTESTATION_INVALID', issueText(parsed.error));
  return parsed.data;
}
