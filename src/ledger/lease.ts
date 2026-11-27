/**
 * Run leases are a small, lease-based mutual exclusion layer on top of the
 * append-only ledger. A lease has an expiry, can be extended by heartbeat, and
 * can be reclaimed by another writer once it has expired. Reclaiming emits an
 * explicit `run.lease.reclaimed` event that names the previous lease and marks
 * the reclaimed run as having produced no evidence, so evidence written under a
 * stale lease cannot be credited to the new owner.
 *
 * All timestamps are integer milliseconds from the ledger clock. The model is
 * deliberately not a distributed lock: callers must pass the returned lease id
 * (a fencing token) to any external resource they mutate.
 */

export const DEFAULT_LEASE_TTL_MS = 30_000;
export const MAX_LEASE_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_RUN_ID_LENGTH = 200;
export const MAX_LEASE_ID_LENGTH = 128;

export type RunLeaseStatus = 'active' | 'reclaimed' | 'released';

export interface RunLease {
  runId: string;
  leaseId: string;
  owner: string;
  acquiredAt: number;
  heartbeatAt: number;
  expiresAt: number;
  status: RunLeaseStatus;
  reclaimedFrom?: string;
  producedEvidence: boolean;
}

export class LeaseHeldError extends Error {
  readonly code = 'LEASE_HELD';
  constructor(message: string) { super(message); this.name = 'LeaseHeldError'; }
}
export class LeaseExpiredError extends Error {
  readonly code = 'LEASE_EXPIRED';
  constructor(message: string) { super(message); this.name = 'LeaseExpiredError'; }
}
export class LeaseMismatchError extends Error {
  readonly code = 'LEASE_MISMATCH';
  constructor(message: string) { super(message); this.name = 'LeaseMismatchError'; }
}
export class LeaseUnknownError extends Error {
  readonly code = 'LEASE_UNKNOWN';
  constructor(message: string) { super(message); this.name = 'LeaseUnknownError'; }
}

export interface AcquireLeaseOptions {
  owner?: string;
  ttlMs?: number;
  /** Supplying a lease id plus an idempotency key makes acquire retry-safe. */
  leaseId?: string;
  idemKey?: string;
}
export interface LeaseTimingOptions {
  ttlMs?: number;
  idemKey?: string;
}
export interface ReleaseLeaseOptions {
  idemKey?: string;
}

export function assertRunId(runId: string): string {
  if (typeof runId !== 'string' || !runId.trim() || runId.length > MAX_RUN_ID_LENGTH) {
    throw new Error(`Run id must be a non-empty string of at most ${MAX_RUN_ID_LENGTH} characters`);
  }
  return runId;
}

export function assertLeaseId(leaseId: string): string {
  if (typeof leaseId !== 'string' || !leaseId.trim() || leaseId.length > MAX_LEASE_ID_LENGTH) {
    throw new Error(`Lease id must be a non-empty string of at most ${MAX_LEASE_ID_LENGTH} characters`);
  }
  return leaseId;
}

export function normalizeTtlMs(ttlMs: number | undefined): number {
  const value = ttlMs ?? DEFAULT_LEASE_TTL_MS;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_LEASE_TTL_MS) {
    throw new Error(`Lease ttlMs must be a positive safe integer no greater than ${MAX_LEASE_TTL_MS}`);
  }
  return value;
}

export function isRunLeaseStatus(value: unknown): value is RunLeaseStatus {
  return value === 'active' || value === 'reclaimed' || value === 'released';
}

export interface LeaseAcquiredInput {
  runId: string;
  leaseId: string;
  owner: string;
  ttlMs: number;
  now: number;
}
export function leaseAcquiredPayload(input: LeaseAcquiredInput): Record<string, unknown> {
  return {
    run_id: input.runId,
    lease_id: input.leaseId,
    owner: input.owner,
    ttl_ms: input.ttlMs,
    acquired_at: input.now,
    heartbeat_at: input.now,
    expires_at: checkedExpiry(input.now, input.ttlMs),
    produced_evidence: false,
  };
}

export interface LeaseHeartbeatInput {
  runId: string;
  leaseId: string;
  ttlMs: number;
  now: number;
}
export function leaseHeartbeatPayload(input: LeaseHeartbeatInput): Record<string, unknown> {
  return {
    run_id: input.runId,
    lease_id: input.leaseId,
    ttl_ms: input.ttlMs,
    heartbeat_at: input.now,
    expires_at: checkedExpiry(input.now, input.ttlMs),
  };
}

export interface LeaseReclaimInput extends LeaseAcquiredInput {
  reclaimedFrom: string;
  expiredAt: number;
}
export function leaseReclaimPayload(input: LeaseReclaimInput): Record<string, unknown> {
  return {
    run_id: input.runId,
    lease_id: input.leaseId,
    owner: input.owner,
    reclaimed_from: input.reclaimedFrom,
    ttl_ms: input.ttlMs,
    acquired_at: input.now,
    heartbeat_at: input.now,
    expires_at: checkedExpiry(input.now, input.ttlMs),
    expired_at: input.expiredAt,
    // A reclaimed lease is not allowed to keep evidence credit. The new lease
    // starts clean; the old owner must re-run under a fresh lease.
    produced_evidence: false,
  };
}

export interface LeaseReleasedInput {
  runId: string;
  leaseId: string;
  now: number;
}
export function leaseReleasedPayload(input: LeaseReleasedInput): Record<string, unknown> {
  return { run_id: input.runId, lease_id: input.leaseId, released_at: input.now };
}

function checkedExpiry(now: number, ttlMs: number): number {
  const expiresAt = now + ttlMs;
  if (!Number.isSafeInteger(expiresAt)) throw new Error('Lease expiry overflow');
  return expiresAt;
}
