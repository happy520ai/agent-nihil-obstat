import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { ReadinessError } from './errors.ts';
import { sha256Canonical } from './hash.ts';
import { evidenceRecordSchema, type EvidenceRecord, type RejectedEvidence, type Requirement, type ValidatedEvidence } from './types.ts';

export interface CollectEvidenceOptions {
  directory: string;
  requirements: ReadonlyMap<string, Requirement>;
  currentArtifactHash: string;
  currentSourceFingerprint?: string;
  now?: Date;
  maxRawBytes?: number;
}

export interface CollectEvidenceResult {
  accepted: ValidatedEvidence[];
  rejected: RejectedEvidence[];
}

const maxEvidenceFileBytes = 1024 * 1024;
const dayMs = 24 * 60 * 60 * 1000;

/**
 * Source namespace used by `writeCheckEvidence`. Records under this namespace are
 * tool-generated local declarations, never external machine evidence.
 */
const localCheckSourcePrefix = 'ano://readiness/checks/';

/**
 * A record is only machine evidence when it came from the external file provider.
 * Local check output is a declaration even if a caller relabels its source or
 * fabricates an `origin: "external"` field: the source namespace still wins, and
 * a self-declared `local_check` origin always downgrades.
 */
function isLocalDeclaration(record: EvidenceRecord): boolean {
  return record.source_id.startsWith(localCheckSourcePrefix) || record.origin === 'local_check';
}

function reject(file: string, id: string | null, requirementId: string | null, reason: string, detail: string): RejectedEvidence {
  return { file, id, requirementId, reason, detail };
}

function issueText(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues.map((issue) => `${issue.path.join('.') || '<record>'}: ${issue.message}`).join('; ');
}

function parseTime(value: string): number {
  return Date.parse(value);
}

function assertSafeRelativeArtifact(raw: string): string {
  if (raw.includes('\\')) throw new ReadinessError('EVIDENCE_RAW_PATH', 'raw_artifact must use forward slashes.');
  if (raw.length === 0 || raw.startsWith('/') || isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) {
    throw new ReadinessError('EVIDENCE_RAW_PATH', 'raw_artifact must be a relative path.');
  }
  const segments = raw.split('/');
  if (segments.some((segment) => segment === '..' || segment === '.' || segment.length === 0)) {
    throw new ReadinessError('EVIDENCE_RAW_PATH', 'raw_artifact must be a normalized relative path.');
  }
  return raw;
}

async function hashRawArtifact(directory: string, raw: string, maxBytes: number): Promise<{ digest: string; bytes: number }> {
  assertSafeRelativeArtifact(raw);
  const absolute = resolve(directory, ...raw.split('/'));
  const inside = relative(directory, absolute);
  if (inside.startsWith('..') || isAbsolute(inside)) {
    throw new ReadinessError('EVIDENCE_RAW_PATH', 'raw_artifact escapes the evidence directory.');
  }
  const info = await lstat(absolute);
  if (info.isSymbolicLink()) throw new ReadinessError('EVIDENCE_RAW_PATH', 'raw_artifact must not be a symlink.');
  if (!info.isFile()) throw new ReadinessError('EVIDENCE_RAW_PATH', 'raw_artifact must be a regular file.');
  if (info.size > maxBytes) throw new ReadinessError('EVIDENCE_RAW_TOO_LARGE', `raw_artifact exceeds ${maxBytes} bytes.`);
  const bytes = await readFile(absolute);
  return { digest: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}

function evidenceRef(record: EvidenceRecord): string {
  return sha256Canonical({
    id: record.id,
    requirement_id: record.requirement_id,
    kind: record.kind,
    source_id: record.source_id,
    timestamp: record.timestamp,
    artifact_hash: record.artifact_hash ?? null,
    source_fingerprint: record.source_fingerprint ?? null,
    raw_artifact_hash: record.raw_artifact_hash,
    result: record.result,
    origin: record.origin ?? null,
    expires_at: record.expires_at ?? null,
    freshness_days: record.freshness_days ?? null,
  });
}

async function evaluateRecord(
  file: string,
  record: EvidenceRecord,
  options: CollectEvidenceOptions,
  now: number,
): Promise<{ accepted: ValidatedEvidence } | { rejected: RejectedEvidence }> {
  const requirement = options.requirements.get(record.requirement_id);
  if (requirement === undefined) {
    return { rejected: reject(file, record.id, record.requirement_id, 'unknown_requirement', 'No loaded requirement matches requirement_id.') };
  }
  if (record.result !== 'pass') {
    return { rejected: reject(file, record.id, record.requirement_id, 'not_passed', 'Evidence records a failing result.') };
  }
  if (requirement.kinds.length > 0 && !requirement.kinds.includes(record.kind)) {
    return { rejected: reject(file, record.id, record.requirement_id, 'kind_not_allowed', `Kind ${record.kind} is not accepted for ${requirement.id}.`) };
  }
  const timestamp = parseTime(record.timestamp);
  if (Number.isNaN(timestamp)) return { rejected: reject(file, record.id, record.requirement_id, 'bad_timestamp', 'timestamp is not valid.') };
  if (timestamp > now + 5 * 60 * 1000) {
    return { rejected: reject(file, record.id, record.requirement_id, 'future_timestamp', 'timestamp is in the future.') };
  }

  const hasArtifact = record.artifact_hash !== undefined;
  const hasSource = record.source_fingerprint !== undefined;
  if (!hasArtifact && !hasSource) {
    return { rejected: reject(file, record.id, record.requirement_id, 'missing_hash', 'Evidence binds neither an artifact hash nor a source fingerprint.') };
  }
  if (!hasArtifact) {
    return { rejected: reject(file, record.id, record.requirement_id, 'missing_hash', 'Machine evidence must bind the current artifact hash.') };
  }
  if (hasArtifact && record.artifact_hash !== options.currentArtifactHash) {
    return { rejected: reject(file, record.id, record.requirement_id, 'artifact_mismatch', 'artifact_hash does not match the current artifact.') };
  }
  if (hasSource) {
    if (options.currentSourceFingerprint === undefined) {
      return { rejected: reject(file, record.id, record.requirement_id, 'source_unverifiable', 'Evidence binds a source fingerprint but no current source fingerprint was supplied.') };
    }
    if (record.source_fingerprint !== options.currentSourceFingerprint) {
      return { rejected: reject(file, record.id, record.requirement_id, 'source_mismatch', 'source_fingerprint does not match the current source tree.') };
    }
  }

  // Expiry can only be shortened, never extended:
  // effective = min(record.expires_at, timestamp + record.freshness_days,
  //                timestamp + requirement.freshness_days).
  // A record cannot claim a longer life than the requirement allows. A rule
  // without a freshness window (freshness_days = 0) is only satisfiable when the
  // record declares its own positive freshness_days; a self-reported expires_at
  // alone is not a freshness window and fails closed.
  const hasFreshnessWindow = record.freshness_days !== undefined || requirement.freshnessDays > 0;
  if (!hasFreshnessWindow) {
    return {
      rejected: reject(
        file,
        record.id,
        record.requirement_id,
        'no_freshness',
        'Neither the evidence record nor the requirement declares a positive freshness window; expires_at alone is self-reported.',
      ),
    };
  }
  const caps: number[] = [];
  if (record.freshness_days !== undefined) caps.push(timestamp + record.freshness_days * dayMs);
  if (requirement.freshnessDays > 0) caps.push(timestamp + requirement.freshnessDays * dayMs);
  if (record.expires_at !== undefined) {
    const declared = parseTime(record.expires_at);
    if (Number.isNaN(declared)) return { rejected: reject(file, record.id, record.requirement_id, 'bad_expiry', 'expires_at is not valid.') };
    caps.push(declared);
  }
  const expires = Math.min(...caps);
  const expiresAt = new Date(expires).toISOString();
  if (expires <= now) return { rejected: reject(file, record.id, record.requirement_id, 'expired', `Evidence expired at ${expiresAt}.`) };

  let raw: { digest: string; bytes: number };
  try {
    raw = await hashRawArtifact(options.directory, record.raw_artifact, options.maxRawBytes ?? 4 * 1024 * 1024);
  } catch (error) {
    const reason = error instanceof ReadinessError ? error.code.toLowerCase() : 'raw_unreadable';
    return { rejected: reject(file, record.id, record.requirement_id, reason, error instanceof Error ? error.message : String(error)) };
  }
  if (raw.digest !== record.raw_artifact_hash) {
    return { rejected: reject(file, record.id, record.requirement_id, 'raw_hash_mismatch', 'raw_artifact_hash does not match the raw output file.') };
  }

  return {
    accepted: {
      classification: isLocalDeclaration(record) ? 'declaration' : 'machine',
      id: record.id,
      requirementId: record.requirement_id,
      kind: record.kind,
      sourceId: record.source_id,
      timestamp: record.timestamp,
      artifactHash: record.artifact_hash ?? null,
      sourceFingerprint: record.source_fingerprint ?? null,
      rawArtifactDigest: raw.digest,
      rawArtifactBytes: raw.bytes,
      expiresAt,
      evidenceRef: evidenceRef(record),
    },
  };
}

/** Reads flat `*.json` evidence records, verifies them, and never retains raw output contents. */
export async function collectFileEvidence(options: CollectEvidenceOptions): Promise<CollectEvidenceResult> {
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
  const accepted: ValidatedEvidence[] = [];
  const rejected: RejectedEvidence[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const absolute = resolve(options.directory, file);
    let record: EvidenceRecord;
    try {
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        rejected.push(reject(file, null, null, 'symlink', 'Evidence records must be regular files.'));
        continue;
      }
      if (info.size > maxEvidenceFileBytes) {
        rejected.push(reject(file, null, null, 'too_large', `Evidence file exceeds ${maxEvidenceFileBytes} bytes.`));
        continue;
      }
      const parsed = JSON.parse(await readFile(absolute, 'utf8')) as unknown;
      const result = evidenceRecordSchema.safeParse(parsed);
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
      rejected.push(reject(file, record.id, record.requirement_id, 'duplicate_id', 'Evidence id is duplicated.'));
      continue;
    }
    seen.add(record.id);
    const outcome = await evaluateRecord(file, record, options, now);
    if ('accepted' in outcome) accepted.push(outcome.accepted);
    else rejected.push(outcome.rejected);
  }
  accepted.sort((a, b) => (a.timestamp === b.timestamp ? a.id.localeCompare(b.id) : b.timestamp.localeCompare(a.timestamp)));
  return { accepted, rejected };
}

/** Convenience for checking that an evidence file path stays under its directory. */
export function isInside(directory: string, absolute: string): boolean {
  const rel = relative(directory, absolute);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..');
}
