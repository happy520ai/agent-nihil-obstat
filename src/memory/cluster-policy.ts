import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { withFileLockSync } from '../core/lock.ts';
import { isSecretPath } from '../core/project-scan.ts';
import { canonicalJson } from '../ledger/event.ts';
import { ReplicationError, screenSensitiveText, sensitivePathReason, type SensitiveFinding } from './replication.ts';

/**
 * T-129 / ADR-011 §9: cluster authorization, secret/content minimization and
 * auditable replica revocation/cleanup.
 *
 * Hard boundaries honoured here (ADR-011 §2.8, §8, §9):
 * - authorization is decided from the *local* policy object only; a remote
 *   payload never supplies scope/auth claims, so it cannot elevate privileges;
 * - replication egress carries only necessary evidence: secret-path/sensitive
 *   events are dropped (`deny`, the default), reduced to a content hash
 *   (`hash-only`) or redacted and marked non-applicable (`redact`);
 * - revocation writes an audit record (time/reason/actor/replicaId, never
 *   secret content) and marks `revokedAt`; cleanup refuses an unrevoked
 *   replica (`REVOKE_REQUIRED`), records a pre-delete manifest digest and
 *   verifies the directory is gone;
 * - there is no network implementation at all. The only accepted egress mode
 *   is `'disabled'`; any other value fails closed with `EGRESS_FORBIDDEN`.
 */

// ---------------------------------------------------------------------------
// Vocabularies and bounds
// ---------------------------------------------------------------------------

export const CLUSTER_OPERATIONS = ['read', 'apply', 'revoke'] as const;
export type ClusterOperation = (typeof CLUSTER_OPERATIONS)[number];

export const CLUSTER_SECRET_MODES = ['deny', 'hash-only', 'redact'] as const;
export type ClusterSecretMode = (typeof CLUSTER_SECRET_MODES)[number];

/** The single accepted network mode; distributed probe has no network code. */
export const CLUSTER_NETWORK_EGRESS_DISABLED = 'disabled' as const;
export type ClusterNetworkEgress = typeof CLUSTER_NETWORK_EGRESS_DISABLED;

export const CLUSTER_AUDIT_KINDS = ['replica.revoke', 'replica.cleanup', 'policy.load'] as const;
export type ClusterAuditKind = (typeof CLUSTER_AUDIT_KINDS)[number];

export const CLUSTER_EGRESS_DROP_CODES = [
  'SECRET_PATH_EXCLUDED',
  'SENSITIVE_CONTENT_EXCLUDED',
  'PAYLOAD_LIMIT_EXCEEDED',
  'EVENT_INVALID',
] as const;
export type ClusterEgressDropCode = (typeof CLUSTER_EGRESS_DROP_CODES)[number];

export const CLUSTER_DEFAULT_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
export const CLUSTER_DEFAULT_AUDIT_MAX_ENTRIES = 512;
export const CLUSTER_DEFAULT_AUDIT_MAX_BYTES = 256 * 1024;
export const CLUSTER_REMOTE_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
export const CLUSTER_REMOTE_MAX_DEPTH = 32;
export const CLUSTER_REMOTE_MAX_ARRAY_LENGTH = 4096;
export const CLUSTER_REMOTE_MAX_KEYS = 1024;

/** Same filesystem-safe identifier rule the frozen ReplicaStore enforces. */
export const CLUSTER_REPLICA_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/** Marker used by the `redact` privacy mode. */
export const REPLICA_REDACTED_MARKER = '[REDACTED]';

/**
 * Substrings that would be executable if a caller ever evaluated remote text.
 * They are surfaced for tests/audit only; this module never evaluates them.
 */
export const REMOTE_EXECUTABLE_MARKERS = [
  'eval(',
  'new Function',
  'execSync',
  'exec(',
  'spawn(',
  'process.exit',
  'child_process',
  'require(',
  'dynamic import(',
] as const;

export class ClusterPolicyError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options: { cause?: unknown } = {}) {
    super(`[${code}] ${message}`, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ClusterPolicyError';
    this.code = code;
  }
}

export const clusterPolicyErrorCodes = [
  'CONFIG_INVALID',
  'EGRESS_FORBIDDEN',
  'REPLICA_NOT_AUTHORIZED',
  'SCOPE_DENIED',
  'REPLICA_REVOKED',
  'OPERATION_FORBIDDEN',
  'REVOKE_REQUIRED',
  'REPLICA_DIRECTORY_UNSAFE',
  'REPLICA_CLEANUP_VERIFICATION_FAILED',
  'PAYLOAD_LIMIT_EXCEEDED',
  'REMOTE_PAYLOAD_INVALID',
  'AUDIT_LIMIT_EXCEEDED',
  'AUDIT_LOG_CORRUPT',
] as const;
export type ClusterPolicyErrorCode = (typeof clusterPolicyErrorCodes)[number];

function config(message: string, cause?: unknown): ClusterPolicyError {
  return new ClusterPolicyError('CONFIG_INVALID', message, cause === undefined ? {} : { cause });
}

// ---------------------------------------------------------------------------
// Policy shape
// ---------------------------------------------------------------------------

export interface ClusterReplicaPolicy {
  /** Stable replica identifier; must satisfy {@link CLUSTER_REPLICA_ID_PATTERN}. */
  readonly replicaId: string;
  /** Project scopes this replica may serve. Cross-scope requests are refused. */
  readonly allowedScopes: readonly string[];
  /** Operations this replica is authorized for (`read`/`apply`/`revoke`). */
  readonly operations: readonly ClusterOperation[];
  /** ISO-8601 timestamp set by {@link revokeReplica}; absent while active. */
  readonly revokedAt?: string;
}

export interface ClusterSecretPolicy {
  /**
   * `deny` (default): an event carrying a secret path/sensitive content is not
   * copied at all. `hash-only`: identity + sha256 of the payload, no text.
   * `redact`: text replaced and the record marked `contentRedacted`, which the
   * frozen replication applier rejects with `REPLICA_REDACTED_EVENT`.
   */
  readonly mode: ClusterSecretMode;
}

/**
 * Local cluster policy. It is an injected/local-file object; nothing in it is
 * derived from a remote payload. `root`/`auditLogPath` are optional metadata
 * used for revocation audit and cleanup.
 */
export interface ClusterPolicy {
  readonly projectScope: string;
  readonly replicas: readonly ClusterReplicaPolicy[];
  readonly secretPolicy: ClusterSecretPolicy;
  /** Per-event serialized egress ceiling; oversized events are refused, never truncated. */
  readonly maxPayloadBytes: number;
  /** Only `'disabled'` is accepted. Absent defaults to disabled. */
  readonly networkEgress?: ClusterNetworkEgress;
  /** Local project root; required for cleanup and default audit placement. */
  readonly root?: string;
  /** Defaults to `<root>/.ano/cluster/audit.jsonl`. */
  readonly auditLogPath?: string;
  readonly auditMaxEntries?: number;
  readonly auditMaxBytes?: number;
}

export interface ClusterPolicyDefaults {
  readonly root?: string;
  readonly replicas?: readonly ClusterReplicaPolicy[];
  readonly secretPolicy?: ClusterSecretPolicy;
  readonly maxPayloadBytes?: number;
  readonly auditLogPath?: string;
  readonly auditMaxEntries?: number;
  readonly auditMaxBytes?: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

/** Validate a filesystem-safe replica id (same rule as the frozen ReplicaStore). */
export function assertClusterReplicaId(replicaId: string): string {
  if (typeof replicaId !== 'string' || !CLUSTER_REPLICA_ID_PATTERN.test(replicaId) || replicaId.includes('..')) {
    throw config(`replicaId ${JSON.stringify(replicaId)} is not a bounded filesystem-safe identifier`);
  }
  return replicaId;
}

function assertPositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw config(`${label} must be a positive integer, got ${String(value)}`);
  }
  return value as number;
}

function assertNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw config(`${label} must be a nonnegative integer, got ${String(value)}`);
  }
  return value as number;
}

/**
 * Fail-closed validation of a local policy. A network egress attempt is
 * rejected as `EGRESS_FORBIDDEN`; every other shape problem is `CONFIG_INVALID`.
 */
export function assertClusterPolicy(policy: unknown): asserts policy is ClusterPolicy {
  if (!isPlainObject(policy)) throw config('cluster policy must be an object');
  if (!isNonEmptyString(policy.projectScope)) throw config('cluster policy projectScope must be a non-empty string');
  if (!Array.isArray(policy.replicas)) throw config('cluster policy replicas must be an array');
  const seen = new Set<string>();
  for (let index = 0; index < policy.replicas.length; index += 1) {
    const raw = policy.replicas[index];
    if (!isPlainObject(raw)) throw config(`replicas[${String(index)}] must be an object`);
    const replicaId = assertClusterReplicaId(raw.replicaId as string);
    if (seen.has(replicaId)) throw config(`duplicate replicaId ${JSON.stringify(replicaId)}`);
    seen.add(replicaId);
    if (!Array.isArray(raw.allowedScopes) || raw.allowedScopes.length === 0 || !raw.allowedScopes.every(isNonEmptyString)) {
      throw config(`replicas[${String(index)}].allowedScopes must be a non-empty string array`);
    }
    if (
      !Array.isArray(raw.operations)
      || raw.operations.length === 0
      || !raw.operations.every((operation) => (CLUSTER_OPERATIONS as readonly string[]).includes(operation as string))
    ) {
      throw config(`replicas[${String(index)}].operations must be a non-empty array of ${CLUSTER_OPERATIONS.join('/')}`);
    }
    if (raw.revokedAt !== undefined && !isIsoTimestamp(raw.revokedAt)) {
      throw config(`replicas[${String(index)}].revokedAt must be an ISO-8601 timestamp`);
    }
  }
  if (!isPlainObject(policy.secretPolicy) || !(CLUSTER_SECRET_MODES as readonly string[]).includes(policy.secretPolicy.mode as string)) {
    throw config(`secretPolicy.mode must be one of ${CLUSTER_SECRET_MODES.join('/')}`);
  }
  assertPositiveInteger(policy.maxPayloadBytes, 'maxPayloadBytes');
  if (policy.networkEgress !== undefined) {
    if (policy.networkEgress !== CLUSTER_NETWORK_EGRESS_DISABLED) {
      throw new ClusterPolicyError(
        'EGRESS_FORBIDDEN',
        `networkEgress ${JSON.stringify(policy.networkEgress)} is forbidden; distributed probe has no network implementation and never sends data off-host`,
      );
    }
  }
  if (policy.root !== undefined && !isNonEmptyString(policy.root)) throw config('root must be a non-empty path');
  if (policy.auditLogPath !== undefined && !isNonEmptyString(policy.auditLogPath)) throw config('auditLogPath must be a non-empty path');
  if (policy.auditMaxEntries !== undefined) assertPositiveInteger(policy.auditMaxEntries, 'auditMaxEntries');
  if (policy.auditMaxBytes !== undefined) assertPositiveInteger(policy.auditMaxBytes, 'auditMaxBytes');
}

/** Build the fail-closed default policy: deny secrets, no egress, bounded payload. */
export function createDefaultClusterPolicy(projectScope: string, defaults: ClusterPolicyDefaults = {}): ClusterPolicy {
  const policy: ClusterPolicy = {
    projectScope,
    replicas: defaults.replicas ?? [],
    secretPolicy: defaults.secretPolicy ?? { mode: 'deny' },
    maxPayloadBytes: defaults.maxPayloadBytes ?? CLUSTER_DEFAULT_MAX_PAYLOAD_BYTES,
    networkEgress: CLUSTER_NETWORK_EGRESS_DISABLED,
    ...(defaults.root === undefined ? {} : { root: defaults.root }),
    ...(defaults.auditLogPath === undefined ? {} : { auditLogPath: defaults.auditLogPath }),
    ...(defaults.auditMaxEntries === undefined ? {} : { auditMaxEntries: defaults.auditMaxEntries }),
    ...(defaults.auditMaxBytes === undefined ? {} : { auditMaxBytes: defaults.auditMaxBytes }),
  };
  assertClusterPolicy(policy);
  return policy;
}

/** Parse a local policy file. Remote JSON is never routed here by this module. */
export function loadClusterPolicy(text: string): ClusterPolicy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw config('cluster policy is not valid JSON', error);
  }
  assertClusterPolicy(parsed);
  return parsed;
}

/** Stable serialization for the local policy file (no remote input involved). */
export function serializeClusterPolicy(policy: ClusterPolicy): string {
  assertClusterPolicy(policy);
  return `${JSON.stringify(policy, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Authorization (local policy only; remote declarations are never consulted)
// ---------------------------------------------------------------------------

export type ClusterAuthorization =
  | { readonly allowed: true; readonly replicaId: string; readonly operation: ClusterOperation; readonly projectScope?: string }
  | { readonly allowed: false; readonly code: 'REPLICA_NOT_AUTHORIZED' | 'SCOPE_DENIED' | 'REPLICA_REVOKED' | 'OPERATION_FORBIDDEN'; readonly reason: string };

/**
 * Authorize one replica operation against the local policy.
 *
 * There is deliberately no parameter for remote claims: a remote payload's
 * declared scope/authorization is structurally incapable of reaching this
 * decision. Check order is fixed so refusals are deterministic:
 * unknown replica -> revoked -> cross-scope -> operation not granted.
 */
export function authorizeReplica(
  policy: ClusterPolicy,
  replicaId: string,
  operation: ClusterOperation,
  projectScope?: string,
): ClusterAuthorization {
  assertClusterPolicy(policy);
  if (!(CLUSTER_OPERATIONS as readonly string[]).includes(operation)) {
    throw new ClusterPolicyError('OPERATION_FORBIDDEN', `unknown operation ${JSON.stringify(operation)}`);
  }
  const replica = policy.replicas.find((entry) => entry.replicaId === replicaId);
  if (replica === undefined) {
    return {
      allowed: false,
      code: 'REPLICA_NOT_AUTHORIZED',
      reason: `replica ${JSON.stringify(replicaId)} is not registered in the local cluster policy`,
    };
  }
  if (replica.revokedAt !== undefined) {
    return {
      allowed: false,
      code: 'REPLICA_REVOKED',
      reason: `replica ${JSON.stringify(replicaId)} was revoked at ${replica.revokedAt}`,
    };
  }
  if (projectScope !== undefined && !replica.allowedScopes.includes(projectScope)) {
    return {
      allowed: false,
      code: 'SCOPE_DENIED',
      reason: `replica ${JSON.stringify(replicaId)} is not authorized for project scope ${JSON.stringify(projectScope)}`,
    };
  }
  if (!replica.operations.includes(operation)) {
    return {
      allowed: false,
      code: 'OPERATION_FORBIDDEN',
      reason: `replica ${JSON.stringify(replicaId)} is not authorized for operation ${operation}`,
    };
  }
  return {
    allowed: true,
    replicaId,
    operation,
    ...(projectScope === undefined ? {} : { projectScope }),
  };
}

// ---------------------------------------------------------------------------
// Secret screening and content minimization
// ---------------------------------------------------------------------------

const PATH_FINDER_REASONS = new Set([
  'environment file',
  'sensitive directory',
  'credential store',
  'sensitive file name',
  'key material',
  'ssh private key',
  'secret path',
]);

function sensitiveKeyReason(key: string): string | null {
  const pathReason = sensitivePathReason(key);
  if (pathReason !== null || isSecretPath(key)) return pathReason ?? 'secret path';
  const lower = key.toLowerCase();
  if (/(?:^|[^a-z])(?:secret|secrets|credential|credentials|password|passwords|token|tokens)(?:[^a-z]|$)/u.test(lower)) {
    return 'sensitive field name';
  }
  if (/(?:^|[_-])(?:api|private|access|client)[_-]?(?:key|secret)$/u.test(lower)) return 'sensitive field name';
  return null;
}

/** Conservative classification of one free-form payload string. */
export function sensitiveValueReason(value: string): string | null {
  if (isSecretPath(value)) return 'secret path';
  const findings = screenSensitiveText(value, 'value');
  if (findings.length > 0) return findings[0]!.reason;
  for (const token of value.split(/[\s"'`()\[\]{},;=]+/u)) {
    if (token.length === 0) continue;
    if (isSecretPath(token)) return 'secret path';
    const reason = sensitivePathReason(token);
    if (reason !== null) return reason;
  }
  return null;
}

function collectFindings(payload: Record<string, unknown>): SensitiveFinding[] {
  const findings = screenSensitiveText(payload, 'payload');
  const seen = new Set(findings.map((finding) => `${finding.path}\u0000${finding.reason}`));
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (!isPlainObject(node)) return;
    for (const [key, child] of Object.entries(node)) {
      const location = path.length === 0 ? key : `${path}.${key}`;
      const reason = sensitiveKeyReason(key);
      if (reason !== null) {
        const marker = `${location}\u0000${reason}`;
        if (!seen.has(marker)) {
          seen.add(marker);
          findings.push({ path: location, reason });
        }
      }
      walk(child, location);
    }
  };
  walk(payload, 'payload');
  return findings;
}

function dropCodeFor(findings: readonly SensitiveFinding[], keyHit: boolean): ClusterEgressDropCode {
  if (keyHit) return 'SENSITIVE_CONTENT_EXCLUDED';
  return findings.some((finding) => PATH_FINDER_REASONS.has(finding.reason)) ? 'SECRET_PATH_EXCLUDED' : 'SENSITIVE_CONTENT_EXCLUDED';
}

interface RedactOutcome {
  readonly value: unknown;
  readonly touched: boolean;
}

function redactNode(node: unknown, keyHint: string | null): RedactOutcome {
  if (typeof node === 'string') {
    return sensitiveValueReason(node) === null
      ? { value: node, touched: false }
      : { value: REPLICA_REDACTED_MARKER, touched: true };
  }
  if (Array.isArray(node)) {
    const out: unknown[] = [];
    let touched = false;
    for (const item of node) {
      const result = redactNode(item, null);
      touched = touched || result.touched;
      out.push(result.value);
    }
    return { value: out, touched };
  }
  if (isPlainObject(node)) {
    const out: Record<string, unknown> = {};
    let touched = false;
    for (const [key, child] of Object.entries(node)) {
      const keyReason = sensitiveKeyReason(key);
      if (keyReason !== null) {
        out[key] = REPLICA_REDACTED_MARKER;
        touched = true;
        continue;
      }
      const result = redactNode(child, key);
      touched = touched || result.touched;
      out[key] = result.value;
    }
    return { value: out, touched };
  }
  return { value: node, touched: false };
}

function contentHashOf(payload: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

export interface ClusterReplicaEventInput {
  readonly seq: number;
  readonly eventId: string;
  readonly hash: string;
  readonly kind: string;
  readonly payload: Record<string, unknown>;
  readonly segment?: string;
  readonly prevHash?: string;
  readonly recordedAt?: string;
  readonly contentRedacted?: boolean;
  /** Internal ledger event; never transmitted by this module. */
  readonly event?: unknown;
}

/** Minimal wire record: identity + payload, no internal envelope fields. */
export interface ClusterEgressEvent {
  readonly seq: number;
  readonly eventId: string;
  readonly hash: string;
  readonly kind: string;
  readonly payload: Record<string, unknown>;
  readonly segment: string;
  readonly prevHash: string;
  readonly recordedAt: string;
  readonly contentRedacted: boolean;
  /** True for `hash-only` minimized records; such records carry no text. */
  readonly contentMinimized: boolean;
  /** Present only on `hash-only` minimized records. */
  readonly contentHash?: string;
}

export interface ClusterEgressDrop {
  readonly seq: number | null;
  readonly eventId: string | null;
  readonly code: ClusterEgressDropCode;
  readonly reason: string;
  readonly findings: readonly SensitiveFinding[];
}

export interface ClusterFilterResult {
  readonly mode: ClusterSecretMode;
  readonly kept: readonly ClusterEgressEvent[];
  readonly dropped: readonly ClusterEgressDrop[];
  readonly findings: readonly SensitiveFinding[];
}

export interface ClusterEgressOptions {
  /** Optional top-level payload field whitelist (non-evidence fields trimmed). */
  readonly payloadFieldWhitelist?: readonly string[];
  /** Overrides `policy.maxPayloadBytes` for this call. */
  readonly maxPayloadBytes?: number;
}

function isEventInput(value: unknown): value is ClusterReplicaEventInput {
  if (!isPlainObject(value)) return false;
  return Number.isSafeInteger(value.seq)
    && (value.seq as number) >= 1
    && isNonEmptyString(value.eventId)
    && isNonEmptyString(value.hash)
    && isNonEmptyString(value.kind)
    && isPlainObject(value.payload);
}

function whitelistPayload(payload: Record<string, unknown>, whitelist?: readonly string[]): Record<string, unknown> {
  if (whitelist === undefined) return { ...payload };
  const out: Record<string, unknown> = {};
  for (const key of whitelist) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) out[key] = payload[key];
  }
  return out;
}

function baseEgress(input: ClusterReplicaEventInput, payload: Record<string, unknown>, contentRedacted: boolean): ClusterEgressEvent {
  return {
    seq: input.seq,
    eventId: input.eventId,
    hash: input.hash,
    kind: input.kind,
    payload,
    segment: input.segment ?? '',
    prevHash: input.prevHash ?? '',
    recordedAt: input.recordedAt ?? '',
    contentRedacted,
    contentMinimized: false,
  };
}

function recordBytes(record: ClusterEgressEvent): number {
  return Buffer.byteLength(canonicalJson(record), 'utf8');
}

/**
 * Filter/minimize committed events for replica egress.
 *
 * - Every event is screened with the authoritative `isSecretPath` plus the
 *   T-125 sensitive-text vocabulary; a hit means the event is secret-bearing.
 * - `deny` drops the whole event (default). `hash-only` keeps identity and a
 *   sha256 of the payload, never the text. `redact` replaces sensitive values
 *   with `[REDACTED]` and marks the record `contentRedacted`, which the frozen
 *   replication applier refuses (`REPLICA_REDACTED_EVENT`).
 * - Envelope internals (`event`, cursor metadata, arbitrary extra keys) are
 *   stripped; only the whitelisted evidence fields survive. An optional
 *   payload-field whitelist trims non-evidence payload fields.
 * - Oversized records are refused with `PAYLOAD_LIMIT_EXCEEDED`, never cut.
 */
export function filterEventsForReplica(
  events: readonly ClusterReplicaEventInput[],
  policy: ClusterPolicy,
  options: ClusterEgressOptions = {},
): ClusterFilterResult {
  assertClusterPolicy(policy);
  const maxPayloadBytes = options.maxPayloadBytes ?? policy.maxPayloadBytes;
  assertPositiveInteger(maxPayloadBytes, 'maxPayloadBytes');
  const mode = policy.secretPolicy.mode;
  const kept: ClusterEgressEvent[] = [];
  const dropped: ClusterEgressDrop[] = [];
  const findings: SensitiveFinding[] = [];

  for (const input of events) {
    if (!isEventInput(input)) {
      dropped.push({
        seq: null,
        eventId: null,
        code: 'EVENT_INVALID',
        reason: 'event must carry seq/eventId/hash/kind and an object payload',
        findings: [],
      });
      continue;
    }
    const payload = whitelistPayload(input.payload, options.payloadFieldWhitelist);
    if (Buffer.byteLength(canonicalJson(payload), 'utf8') > maxPayloadBytes) {
      dropped.push({
        seq: input.seq,
        eventId: input.eventId,
        code: 'PAYLOAD_LIMIT_EXCEEDED',
        reason: `payload exceeds maxPayloadBytes=${String(maxPayloadBytes)}; refusing without truncation`,
        findings: [],
      });
      continue;
    }

    const eventFindings = collectFindings(payload);
    const sensitive = eventFindings.length > 0;
    if (!sensitive) {
      const record = baseEgress(input, payload, Boolean(input.contentRedacted));
      if (recordBytes(record) > maxPayloadBytes) {
        dropped.push({
          seq: input.seq,
          eventId: input.eventId,
          code: 'PAYLOAD_LIMIT_EXCEEDED',
          reason: `record exceeds maxPayloadBytes=${String(maxPayloadBytes)}; refusing without truncation`,
          findings: [],
        });
        continue;
      }
      kept.push(record);
      continue;
    }

    findings.push(...eventFindings.map((finding) => ({ ...finding })));
    const keyHit = hasSensitiveKey(payload);
    if (mode === 'deny') {
      dropped.push({
        seq: input.seq,
        eventId: input.eventId,
        code: dropCodeFor(eventFindings, keyHit),
        reason: 'secret path/sensitive content is never copied to a replica in deny mode',
        findings: eventFindings.map((finding) => ({ ...finding })),
      });
      continue;
    }
    if (mode === 'hash-only') {
      const record: ClusterEgressEvent = {
        ...baseEgress(input, {}, false),
        contentMinimized: true,
        contentHash: contentHashOf(payload),
      };
      if (recordBytes(record) > maxPayloadBytes) {
        dropped.push({
          seq: input.seq,
          eventId: input.eventId,
          code: 'PAYLOAD_LIMIT_EXCEEDED',
          reason: `record exceeds maxPayloadBytes=${String(maxPayloadBytes)}; refusing without truncation`,
          findings: eventFindings.map((finding) => ({ ...finding })),
        });
        continue;
      }
      kept.push(record);
      continue;
    }
    // redact
    const redacted = redactNode(payload, null);
    const record: ClusterEgressEvent = {
      ...baseEgress(input, (isPlainObject(redacted.value) ? redacted.value : {}) as Record<string, unknown>, true),
    };
    if (recordBytes(record) > maxPayloadBytes) {
      dropped.push({
        seq: input.seq,
        eventId: input.eventId,
        code: 'PAYLOAD_LIMIT_EXCEEDED',
        reason: `record exceeds maxPayloadBytes=${String(maxPayloadBytes)}; refusing without truncation`,
        findings: eventFindings.map((finding) => ({ ...finding })),
      });
      continue;
    }
    kept.push(record);
  }

  return { mode, kept, dropped, findings: [...findings] };
}

function hasSensitiveKey(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hasSensitiveKey);
  if (!isPlainObject(node)) return false;
  for (const [key, child] of Object.entries(node)) {
    if (sensitiveKeyReason(key) !== null) return true;
    if (hasSensitiveKey(child)) return true;
  }
  return false;
}

/** True only when a filtered record is safe to apply to a replica view. */
export function isReplicaApplicableEgress(record: ClusterEgressEvent): boolean {
  return record.contentRedacted === false && record.contentMinimized === false;
}

/**
 * Fail-closed guard for consumers: redacted (`redact` mode) and minimized
 * (`hash-only`) records are evidence-only and can never reproduce the primary
 * view. Mirrors the frozen `REPLICA_REDACTED_EVENT` contract.
 */
export function assertReplicaApplicableEgress(record: ClusterEgressEvent): void {
  if (record.contentMinimized) {
    throw new ReplicationError('REPLICA_REDACTED_EVENT', `event ${record.eventId} was minimized to a content hash and cannot be applied to a replica view`);
  }
  if (record.contentRedacted) {
    throw new ReplicationError('REPLICA_REDACTED_EVENT', `event ${record.eventId} is redacted and cannot be applied to a replica view`);
  }
}

// ---------------------------------------------------------------------------
// Revocation, verification, audit
// ---------------------------------------------------------------------------

export interface ClusterRevokeOptions {
  readonly reason: string;
  readonly actor: string;
  /** Injectable clock for deterministic audit records. */
  readonly at?: string;
  readonly auditLogPath?: string;
  /**
   * Opt-in: require `authorizeReplica(policy, replicaId, 'revoke')` to allow.
   * Default false because revocation is a named operator action recorded in
   * the audit log, not a replica privilege.
   */
  readonly requireAuthorization?: boolean;
}

function assertActor(actor: unknown): string {
  if (!isNonEmptyString(actor)) throw config('actor must be a non-empty string');
  return actor;
}

function assertReason(reason: unknown): string {
  if (!isNonEmptyString(reason)) throw config('reason must be a non-empty string');
  return reason;
}

/**
 * Revoke a replica: append an audit record (time/reason/actor/replicaId, never
 * event content) and mark `revokedAt`. Idempotent: a second call keeps the
 * original revocation time and appends another audit line.
 */
export function revokeReplica(policy: ClusterPolicy, replicaId: string, options: ClusterRevokeOptions): ClusterPolicy {
  assertClusterPolicy(policy);
  assertClusterReplicaId(replicaId);
  const actor = assertActor(options.actor);
  const reason = assertReason(options.reason);
  const at = options.at ?? new Date().toISOString();
  if (!isIsoTimestamp(at)) throw config('at must be an ISO-8601 timestamp');

  const existing = policy.replicas.find((entry) => entry.replicaId === replicaId);
  if (existing === undefined) {
    throw new ClusterPolicyError('REPLICA_NOT_AUTHORIZED', `replica ${JSON.stringify(replicaId)} is not registered in the local cluster policy`);
  }
  if (options.requireAuthorization === true) {
    const decision = authorizeReplica(policy, replicaId, 'revoke');
    if (!decision.allowed) {
      throw new ClusterPolicyError(decision.code, decision.reason);
    }
  }

  if (existing.revokedAt !== undefined) {
    const duplicate: ClusterAuditRecord = {
      at,
      kind: 'replica.revoke',
      replicaId,
      actor,
      reason,
      detail: `idempotent: already revoked at ${existing.revokedAt}`,
    };
    appendClusterAudit(policy, duplicate, options.auditLogPath === undefined ? {} : { auditLogPath: options.auditLogPath });
    return policy;
  }

  const record: ClusterAuditRecord = { at, kind: 'replica.revoke', replicaId, actor, reason };
  appendClusterAudit(policy, record, options.auditLogPath === undefined ? {} : { auditLogPath: options.auditLogPath });

  const revoked: ClusterReplicaPolicy = { ...existing, revokedAt: at };
  const next: ClusterPolicy = { ...policy, replicas: policy.replicas.map((entry) => (entry.replicaId === replicaId ? revoked : entry)) };
  reflectPolicy(policy, next);
  return next;
}

/**
 * Best-effort reflection so a caller holding the original policy handle sees
 * the revocation too; the returned policy remains the authoritative value.
 */
function reflectPolicy(target: ClusterPolicy, next: ClusterPolicy): void {
  try {
    (target as { replicas: readonly ClusterReplicaPolicy[] }).replicas = next.replicas;
  } catch {
    // A frozen caller-owned policy keeps its original snapshot; use the return value.
  }
}

export type ClusterRevokedVerification = { readonly revoked: true; readonly revokedAt: string } | { readonly revoked: false; readonly revokedAt: null };

/** Verify from local state that a replica is revoked. */
export function verifyRevoked(policy: ClusterPolicy, replicaId: string): ClusterRevokedVerification {
  assertClusterPolicy(policy);
  assertClusterReplicaId(replicaId);
  const replica = policy.replicas.find((entry) => entry.replicaId === replicaId);
  if (replica === undefined || replica.revokedAt === undefined) return { revoked: false, revokedAt: null };
  return { revoked: true, revokedAt: replica.revokedAt };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

interface ManifestEntry {
  readonly relativePath: string;
  readonly size: number;
  readonly hash: string;
}

export interface ClusterCleanupReport {
  readonly replicaId: string;
  readonly directory: string;
  readonly existed: boolean;
  readonly removed: boolean;
  readonly verifiedAbsent: boolean;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly manifestDigest: string;
  readonly auditRecord: ClusterAuditRecord;
}

export interface ClusterCleanupOptions {
  readonly at?: string;
  readonly actor?: string;
  readonly reason?: string;
}

function collectManifest(directory: string): ManifestEntry[] {
  const entries: ManifestEntry[] = [];
  const walk = (relative: string): void => {
    const absolute = relative.length === 0 ? directory : join(directory, relative);
    let names: string[];
    try {
      names = readdirSync(absolute).sort();
    } catch (error) {
      throw new ClusterPolicyError('REPLICA_DIRECTORY_UNSAFE', `cannot enumerate replica directory ${absolute}`, { cause: error });
    }
    for (const name of names) {
      const childRelative = relative.length === 0 ? name : `${relative}/${name}`;
      const childAbsolute = join(directory, childRelative);
      const resolved = resolve(childAbsolute);
      if (resolved !== directory && !resolved.startsWith(`${directory}${sep}`)) {
        throw new ClusterPolicyError('REPLICA_DIRECTORY_UNSAFE', `refusing a path outside the replica directory: ${resolved}`);
      }
      const metadata = lstatSync(childAbsolute);
      if (metadata.isDirectory()) {
        walk(childRelative);
        continue;
      }
      if (metadata.isSymbolicLink()) {
        // Never follow a link during hashing; record the link itself.
        let target = '';
        try {
          target = readlinkSync(childAbsolute);
        } catch {
          target = '<unreadable>';
        }
        entries.push({ relativePath: childRelative, size: 0, hash: createHash('sha256').update(`symlink:${target}`).digest('hex') });
        continue;
      }
      const bytes = readFileSync(childAbsolute);
      entries.push({ relativePath: childRelative, size: metadata.size, hash: createHash('sha256').update(bytes).digest('hex') });
    }
  };
  walk('');
  return entries;
}

function manifestDigest(entries: readonly ManifestEntry[]): string {
  const lines = entries
    .slice()
    .sort((left, right) => (left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0))
    .map((entry) => `${entry.relativePath}\t${entry.hash}`);
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/**
 * Delete `<root>/.ano/replicas/<replicaId>/` after revocation.
 *
 * Refuses an unrevoked replica (`REVOKE_REQUIRED`), records a pre-delete
 * manifest (file count/total bytes/sha256 manifest digest, no content), deletes
 * and then verifies the directory is absent. Idempotent: an already-absent
 * directory succeeds with `existed=false`.
 */
export function cleanupReplica(root: string, replicaId: string, policy: ClusterPolicy, options: ClusterCleanupOptions = {}): ClusterCleanupReport {
  assertClusterPolicy(policy);
  assertClusterReplicaId(replicaId);
  if (!isNonEmptyString(root)) throw config('root must be a non-empty path');
  const replica = policy.replicas.find((entry) => entry.replicaId === replicaId);
  if (replica === undefined) {
    throw new ClusterPolicyError('REPLICA_NOT_AUTHORIZED', `replica ${JSON.stringify(replicaId)} is not registered in the local cluster policy`);
  }
  if (replica.revokedAt === undefined) {
    throw new ClusterPolicyError('REVOKE_REQUIRED', `replica ${JSON.stringify(replicaId)} must be revoked before its derived data is cleaned up`);
  }

  const rootAbsolute = resolve(root);
  const baseDirectory = join(rootAbsolute, '.ano', 'replicas');
  const directory = resolve(join(baseDirectory, replicaId));
  if (directory !== baseDirectory && !directory.startsWith(`${baseDirectory}${sep}`)) {
    throw new ClusterPolicyError('REPLICA_DIRECTORY_UNSAFE', `refusing to clean a directory outside ${baseDirectory}: ${directory}`);
  }

  const existed = existsSync(directory);
  const entries = existed ? collectManifest(directory) : [];
  const totalBytes = entries.reduce((total, entry) => total + entry.size, 0);
  const digest = manifestDigest(entries);

  rmSync(directory, { recursive: true, force: true });
  const verifiedAbsent = !existsSync(directory);
  if (!verifiedAbsent) {
    throw new ClusterPolicyError('REPLICA_CLEANUP_VERIFICATION_FAILED', `replica directory ${directory} still exists after cleanup`);
  }

  const at = options.at ?? new Date().toISOString();
  const record: ClusterAuditRecord = {
    at,
    kind: 'replica.cleanup',
    replicaId,
    actor: options.actor ?? 'operator',
    ...(options.reason === undefined ? {} : { reason: options.reason }),
    fileCount: entries.length,
    totalBytes,
    manifestDigest: digest,
    detail: existed ? 'directory-absent-after-cleanup' : 'directory-already-absent',
  };
  appendClusterAudit(policy, record, { fallbackRoot: rootAbsolute });
  return {
    replicaId,
    directory,
    existed,
    removed: existed,
    verifiedAbsent,
    fileCount: entries.length,
    totalBytes,
    manifestDigest: digest,
    auditRecord: record,
  };
}

// ---------------------------------------------------------------------------
// Bounded audit log
// ---------------------------------------------------------------------------

export interface ClusterAuditRecord {
  readonly at: string;
  readonly kind: ClusterAuditKind;
  readonly replicaId: string;
  readonly actor: string;
  readonly reason?: string;
  readonly detail?: string;
  readonly fileCount?: number;
  readonly totalBytes?: number;
  readonly manifestDigest?: string;
}

export interface ClusterAuditOptions {
  readonly auditLogPath?: string;
  readonly fallbackRoot?: string;
  readonly maxEntries?: number;
  readonly maxBytes?: number;
}

/** Resolve the audit log path from local configuration only. */
export function resolveAuditLogPath(policy: ClusterPolicy, fallbackRoot?: string): string {
  if (policy.auditLogPath !== undefined) return resolve(policy.auditLogPath);
  const base = policy.root ?? fallbackRoot;
  if (base === undefined) {
    throw config('cluster policy carries no root/auditLogPath; refusing to guess an audit location');
  }
  return join(resolve(base), '.ano', 'cluster', 'audit.jsonl');
}

function assertAuditRecord(record: ClusterAuditRecord): void {
  if (!isIsoTimestamp(record.at)) throw config('audit record at must be an ISO-8601 timestamp');
  if (!(CLUSTER_AUDIT_KINDS as readonly string[]).includes(record.kind)) throw config(`unknown audit kind ${JSON.stringify(record.kind)}`);
  assertClusterReplicaId(record.replicaId);
  assertActor(record.actor);
  if (record.reason !== undefined) assertReason(record.reason);
  if (record.fileCount !== undefined) assertNonNegativeInteger(record.fileCount, 'audit fileCount');
  if (record.totalBytes !== undefined) assertNonNegativeInteger(record.totalBytes, 'audit totalBytes');
  if (record.manifestDigest !== undefined && !/^[a-f0-9]{64}$/u.test(record.manifestDigest)) {
    throw config('audit manifestDigest must be a lowercase sha256 hex digest');
  }
}

function atomicWrite(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, text, 'utf8');
  renameSync(temporary, file);
}

function readRawAudit(file: string): string[] {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, 'utf8');
  return text.split('\n').filter((line) => line.trim().length > 0);
}

/**
 * Append one bounded audit record under a file lock. The log is capped by entry
 * count and byte size (oldest entries evicted); a single record larger than
 * the byte cap is refused with `AUDIT_LIMIT_EXCEEDED`, never truncated.
 */
export function appendClusterAudit(policy: ClusterPolicy, record: ClusterAuditRecord, options: ClusterAuditOptions = {}): ClusterAuditRecord {
  assertClusterPolicy(policy);
  assertAuditRecord(record);
  const file = options.auditLogPath === undefined
    ? resolveAuditLogPath(policy, options.fallbackRoot)
    : resolve(options.auditLogPath);
  return appendTo(file, record, policy, options);
}

function appendTo(file: string, record: ClusterAuditRecord, policy: ClusterPolicy, options: ClusterAuditOptions): ClusterAuditRecord {
  const maxEntries = options.maxEntries ?? policy.auditMaxEntries ?? CLUSTER_DEFAULT_AUDIT_MAX_ENTRIES;
  const maxBytes = options.maxBytes ?? policy.auditMaxBytes ?? CLUSTER_DEFAULT_AUDIT_MAX_BYTES;
  assertPositiveInteger(maxEntries, 'auditMaxEntries');
  assertPositiveInteger(maxBytes, 'auditMaxBytes');
  const line = JSON.stringify(record);
  const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
  if (lineBytes > maxBytes) {
    throw new ClusterPolicyError('AUDIT_LIMIT_EXCEEDED', `audit record is ${String(lineBytes)} bytes, above the ${String(maxBytes)}-byte cap`);
  }
  withFileLockSync(`${file}.lock`, () => {
    const lines = readRawAudit(file);
    lines.push(line);
    while (lines.length > maxEntries) lines.shift();
    let text = `${lines.join('\n')}\n`;
    while (Buffer.byteLength(text, 'utf8') > maxBytes && lines.length > 1) {
      lines.shift();
      text = `${lines.join('\n')}\n`;
    }
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new ClusterPolicyError('AUDIT_LIMIT_EXCEEDED', `audit log cannot stay within ${String(maxBytes)} bytes`);
    }
    atomicWrite(file, text);
  }, { timeoutMs: 5_000 });
  return record;
}

/** Read the bounded audit log (fail-closed on corruption). */
export function readClusterAudit(policy: ClusterPolicy, options: ClusterAuditOptions = {}): readonly ClusterAuditRecord[] {
  assertClusterPolicy(policy);
  const file = resolveAuditLogPath(policy, options.fallbackRoot);
  if (!existsSync(file)) return [];
  const lines = readRawAudit(file);
  const records: ClusterAuditRecord[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new ClusterPolicyError('AUDIT_LOG_CORRUPT', `audit line ${String(index + 1)} is not valid JSON`, { cause: error });
    }
    if (!isPlainObject(parsed)) throw new ClusterPolicyError('AUDIT_LOG_CORRUPT', `audit line ${String(index + 1)} is not an object`);
    assertAuditRecord(parsed as unknown as ClusterAuditRecord);
    records.push(parsed as unknown as ClusterAuditRecord);
  }
  return records;
}

// ---------------------------------------------------------------------------
// Remote payload handling: data only, never executed
// ---------------------------------------------------------------------------

export interface RemotePayloadLimits {
  readonly maxBytes?: number;
  readonly maxDepth?: number;
  readonly maxArrayLength?: number;
  readonly maxKeys?: number;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Strictly validate a remote payload as inert JSON-compatible data.
 *
 * It rejects functions/symbols/bigints/undefined, cycles, depth/array/key
 * overflow and total byte overflow (`PAYLOAD_LIMIT_EXCEEDED` /
 * `REMOTE_PAYLOAD_INVALID`). The returned value is a frozen deep copy. This
 * function never evaluates, imports, spawns or resolves paths from the input.
 */
export function parseRemotePayload(raw: unknown, limits: RemotePayloadLimits = {}): unknown {
  const maxBytes = limits.maxBytes ?? CLUSTER_REMOTE_MAX_PAYLOAD_BYTES;
  const maxDepth = limits.maxDepth ?? CLUSTER_REMOTE_MAX_DEPTH;
  const maxArrayLength = limits.maxArrayLength ?? CLUSTER_REMOTE_MAX_ARRAY_LENGTH;
  const maxKeys = limits.maxKeys ?? CLUSTER_REMOTE_MAX_KEYS;
  assertPositiveInteger(maxBytes, 'maxBytes');
  assertPositiveInteger(maxDepth, 'maxDepth');
  assertPositiveInteger(maxArrayLength, 'maxArrayLength');
  assertPositiveInteger(maxKeys, 'maxKeys');

  let totalBytes = 0;
  const visit = (node: unknown, depth: number, path: string): void => {
    if (depth > maxDepth) {
      throw new ClusterPolicyError('PAYLOAD_LIMIT_EXCEEDED', `remote payload exceeds depth ${String(maxDepth)} at ${path}`);
    }
    if (node === null || typeof node === 'boolean' || typeof node === 'number') return;
    if (typeof node === 'string') {
      totalBytes += Buffer.byteLength(node, 'utf8');
      if (totalBytes > maxBytes) {
        throw new ClusterPolicyError('PAYLOAD_LIMIT_EXCEEDED', `remote payload exceeds ${String(maxBytes)} bytes at ${path}`);
      }
      return;
    }
    if (typeof node === 'undefined' || typeof node === 'function' || typeof node === 'symbol' || typeof node === 'bigint') {
      throw new ClusterPolicyError('REMOTE_PAYLOAD_INVALID', `remote payload carries a non-JSON value at ${path}`);
    }
    if (Array.isArray(node)) {
      if (node.length > maxArrayLength) {
        throw new ClusterPolicyError('PAYLOAD_LIMIT_EXCEEDED', `remote payload array at ${path} exceeds ${String(maxArrayLength)} items`);
      }
      node.forEach((item, index) => visit(item, depth + 1, `${path}[${String(index)}]`));
      return;
    }
    if (typeof node === 'object') {
      const keys = Object.keys(node as Record<string, unknown>);
      if (keys.length > maxKeys) {
        throw new ClusterPolicyError('PAYLOAD_LIMIT_EXCEEDED', `remote payload object at ${path} exceeds ${String(maxKeys)} keys`);
      }
      for (const key of keys) visit((node as Record<string, unknown>)[key], depth + 1, `${path}.${key}`);
      return;
    }
    throw new ClusterPolicyError('REMOTE_PAYLOAD_INVALID', `remote payload carries an unsupported value at ${path}`);
  };
  visit(raw, 0, 'payload');

  let text: string;
  try {
    text = JSON.stringify(raw);
  } catch (error) {
    throw new ClusterPolicyError('REMOTE_PAYLOAD_INVALID', 'remote payload is not JSON-serializable', { cause: error });
  }
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new ClusterPolicyError('PAYLOAD_LIMIT_EXCEEDED', `remote payload exceeds ${String(maxBytes)} bytes`);
  }
  return deepFreeze(JSON.parse(text) as unknown);
}

/** Recursively report executable-looking markers; diagnostic only, never runs them. */
export function containsExecutableMarker(value: unknown): boolean {
  if (typeof value === 'string') {
    return REMOTE_EXECUTABLE_MARKERS.some((marker) => value.includes(marker));
  }
  if (Array.isArray(value)) return value.some(containsExecutableMarker);
  if (isPlainObject(value)) return Object.values(value).some(containsExecutableMarker);
  return false;
}
