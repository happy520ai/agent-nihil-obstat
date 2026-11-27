import { z } from 'zod';
import { canonicalJson, sha256Hex } from './canonical.ts';
import { ConnectError } from './errors.ts';

/**
 * ADR-006 / docs/takeover.md §3-§4: the explicit project-takeover contract.
 *
 * This module owns the policy vocabulary and its invariants only; it performs
 * no I/O. `takeover-store.ts` persists these shapes atomically and fail-closed.
 * Every document is strict: unknown fields are rejected rather than ignored,
 * absent values are explicit null (never a missing key), and every timestamp
 * must be an ISO-8601 datetime.
 */

export const TAKEOVER_SCHEMA_VERSION = 1 as const;
export const TAKEOVER_POLICY_SCHEMA_NAME = 'ano.takeover-policy/1' as const;
export const TAKEOVER_AUTHORIZATION_SCHEMA_NAME = 'ano.takeover-authorization/1' as const;
export const TAKEOVER_TRANSACTION_SCHEMA_NAME = 'ano.takeover-transaction/1' as const;
export const TAKEOVER_TRANSACTIONS_SCHEMA_NAME = 'ano.takeover-transactions/1' as const;

/** The three persistent policy states (ADR-006 §4.1). */
export const TAKEOVER_STATES = ['disabled', 'enforced', 'recovery'] as const;
export type TakeoverState = (typeof TAKEOVER_STATES)[number];

/** Explicit authorization scope subset; no default scope is allowed. */
export const TAKEOVER_SCOPES = ['tasks', 'memory', 'acceptance', 'dag'] as const;
export type TakeoverScope = (typeof TAKEOVER_SCOPES)[number];

/** The six ordered takeover phases plus the terminal failure marker. */
export const TAKEOVER_PHASES = ['prepared', 'migrated', 'reconciled', 'verified', 'installed', 'active', 'aborted'] as const;
export type TakeoverPhase = (typeof TAKEOVER_PHASES)[number];
/** Phases that may still advance; `aborted` is terminal. */
export const TAKEOVER_ACTIVE_PHASES = ['prepared', 'migrated', 'reconciled', 'verified', 'installed', 'active'] as const;

export class TakeoverPolicyError extends ConnectError {
  override readonly code = 'TAKEOVER_POLICY' as const;
  constructor(message: string) {
    super(message);
    this.name = 'TakeoverPolicyError';
  }
}

const isoTimestamp = z.string().datetime();
const sha256Digest = z.string().regex(/^[0-9a-f]{64}$/u, 'expected a lowercase sha256 hex digest');

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.map(String).join('.') : '<root>'}: ${issue.message}`)
    .join('; ');
}

function parseStrict<TSchema extends z.ZodType>(schema: TSchema, value: unknown, label: string): z.infer<TSchema> {
  const result = schema.safeParse(value);
  if (!result.success) throw new TakeoverPolicyError(`${label} failed schema validation: ${formatIssues(result.error)}`);
  return result.data;
}

/** Non-throwing variant used by red-team/audit callers; empty means accepted. */
export function schemaIssues(schema: z.ZodType, value: unknown): string[] {
  const result = schema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => `${issue.path.length > 0 ? issue.path.map(String).join('.') : '<root>'}: ${issue.message}`);
}

// ---- authorization ------------------------------------------------------

const scopeList = z.array(z.enum(TAKEOVER_SCOPES)).min(1).superRefine((scopes, context) => {
  if (new Set(scopes).size !== scopes.length) {
    context.addIssue({ code: 'custom', message: 'scope entries must be unique' });
  }
});

export const TAKEOVER_AUTHORIZATION_SCHEMA = z.object({
  schema: z.literal(TAKEOVER_AUTHORIZATION_SCHEMA_NAME),
  authorizationId: sha256Digest,
  /** Canonical project realpath the authorization is structurally bound to. */
  root: z.string().min(1),
  projectId: z.string().min(1),
  projectKey: z.string().min(1),
  scope: scopeList,
  grantedBy: z.string().min(1).max(120),
  role: z.string().min(1).max(120),
  statement: z.string().min(1).max(2000),
  grantedAt: isoTimestamp,
  /** Old-source digest at grant time; null when the source was not readable. */
  sourceDigestAtGrant: sha256Digest.nullable(),
  /** Revocation is permanent; null while the authorization is live. */
  revokedAt: isoTimestamp.nullable(),
}).strict();
export type TakeoverAuthorization = z.infer<typeof TAKEOVER_AUTHORIZATION_SCHEMA>;

// ---- policy -------------------------------------------------------------

export const TAKEOVER_POLICY_SCHEMA = z.object({
  schema: z.literal(TAKEOVER_POLICY_SCHEMA_NAME),
  /** Persisted document version; unknown versions are rejected explicitly. */
  schemaVersion: z.literal(TAKEOVER_SCHEMA_VERSION),
  /** Canonical project realpath; every read/write path binds to this root. */
  root: z.string().min(1),
  projectId: z.string().min(1),
  projectKey: z.string().min(1),
  /** Embedded authorization identity, validated for integrity on load. */
  authorization: TAKEOVER_AUTHORIZATION_SCHEMA,
  state: z.enum(TAKEOVER_STATES),
  stateChangedAt: isoTimestamp,
  enforcedAt: isoTimestamp.nullable(),
  recoveredAt: isoTimestamp.nullable(),
  baselineDigest: sha256Digest.nullable(),
  hostCapability: z.enum(['full', 'degraded']).nullable(),
  /**
   * Integrity binding for the mutable state portion (ADR-006 §4.1/§4.3).
   * `sha256(canonicalJson({state, stateChangedAt, enforcedAt, recoveredAt,
   * baselineDigest, hostCapability}))`; the store recomputes it on write and
   * verifies it on read, so a forged-but-schema-valid state is refused instead
   * of being silently accepted.
   */
  stateHash: sha256Digest,
  updatedAt: isoTimestamp,
}).strict().superRefine((policy, context) => {
  // The embedded authorization must describe this exact project; a mismatched
  // root or identity would let one project's grant authorize another root.
  if (policy.authorization.root !== policy.root) {
    context.addIssue({ code: 'custom', message: 'authorization root must equal the policy root', path: ['authorization', 'root'] });
  }
  if (policy.authorization.projectId !== policy.projectId || policy.authorization.projectKey !== policy.projectKey) {
    context.addIssue({ code: 'custom', message: 'authorization identity must equal the policy identity', path: ['authorization'] });
  }
  // `enforced` must name when it took effect, a drift baseline, and a live
  // authorization. Anything else would let a partial write pose as a full switch.
  if (policy.state === 'enforced') {
    if (policy.enforcedAt === null) {
      context.addIssue({ code: 'custom', message: 'enforced requires enforcedAt', path: ['enforcedAt'] });
    }
    if (policy.baselineDigest === null) {
      context.addIssue({ code: 'custom', message: 'enforced requires baselineDigest', path: ['baselineDigest'] });
    }
    if (policy.authorization.revokedAt !== null) {
      context.addIssue({ code: 'custom', message: 'enforced must not carry a revoked authorization', path: ['authorization', 'revokedAt'] });
    }
  }
});
export type TakeoverPolicy = z.infer<typeof TAKEOVER_POLICY_SCHEMA>;

// ---- transaction records ------------------------------------------------

export const TAKEOVER_TRANSACTION_SCHEMA = z.object({
  schema: z.literal(TAKEOVER_TRANSACTION_SCHEMA_NAME),
  txId: sha256Digest,
  authorizationId: sha256Digest,
  root: z.string().min(1),
  phase: z.enum(TAKEOVER_PHASES),
  sourceDigest: sha256Digest,
  backupId: z.string().min(1).max(256),
  backupHash: sha256Digest,
  evidenceHash: sha256Digest.nullable(),
  startedAt: isoTimestamp,
  updatedAt: isoTimestamp,
  error: z.string().max(2000).nullable(),
  /** Hash of the previous entry (`null` for the genesis record); chain link. */
  prevHash: sha256Digest.nullable(),
  /** `sha256(canonicalJson(entry without prevHash/entryHash))`; history binding. */
  entryHash: sha256Digest,
}).strict();
export type TakeoverTransaction = z.infer<typeof TAKEOVER_TRANSACTION_SCHEMA>;

/** The transaction fields covered by `entryHash`, excluding the chain fields. */
export type TakeoverTransactionCore = Omit<TakeoverTransaction, 'prevHash' | 'entryHash'>;

export function transactionCore(entry: TakeoverTransaction | TakeoverTransactionCore): TakeoverTransactionCore {
  return {
    schema: entry.schema,
    txId: entry.txId,
    authorizationId: entry.authorizationId,
    root: entry.root,
    phase: entry.phase,
    sourceDigest: entry.sourceDigest,
    backupId: entry.backupId,
    backupHash: entry.backupHash,
    evidenceHash: entry.evidenceHash,
    startedAt: entry.startedAt,
    updatedAt: entry.updatedAt,
    error: entry.error,
  };
}

export function computeTransactionEntryHash(entry: TakeoverTransaction | TakeoverTransactionCore): string {
  return sha256Hex(canonicalJson(transactionCore(entry)));
}

/**
 * Verify the append-only hash chain: each record's `entryHash` binds its own
 * bytes and its `prevHash` must equal the predecessor's `entryHash`. Rewriting,
 * reordering or deleting history breaks the chain and fails closed.
 */
export function assertTransactionChain(entries: readonly TakeoverTransaction[]): void {
  let expectedPrev: string | null = null;
  for (const [index, entry] of entries.entries()) {
    if (entry.prevHash !== expectedPrev) {
      throw new TakeoverPolicyError(`transaction chain is broken at entry ${index}: prevHash mismatch`);
    }
    if (computeTransactionEntryHash(entry) !== entry.entryHash) {
      throw new TakeoverPolicyError(`transaction entry hash mismatch at entry ${index}`);
    }
    expectedPrev = entry.entryHash;
  }
}

/** Append-only transaction journal; each phase migration appends one entry. */
export const TAKEOVER_TRANSACTIONS_SCHEMA = z.object({
  schema: z.literal(TAKEOVER_TRANSACTIONS_SCHEMA_NAME),
  schemaVersion: z.literal(TAKEOVER_SCHEMA_VERSION),
  root: z.string().min(1),
  entries: z.array(TAKEOVER_TRANSACTION_SCHEMA),
}).strict();
export type TakeoverTransactionLog = z.infer<typeof TAKEOVER_TRANSACTIONS_SCHEMA>;

// ---- parsing ------------------------------------------------------------

export function parseAuthorization(value: unknown): TakeoverAuthorization {
  return parseStrict(TAKEOVER_AUTHORIZATION_SCHEMA, value, 'takeover authorization');
}

export function parsePolicy(value: unknown): TakeoverPolicy {
  return parseStrict(TAKEOVER_POLICY_SCHEMA, value, 'takeover policy');
}

export function parseTransaction(value: unknown): TakeoverTransaction {
  return parseStrict(TAKEOVER_TRANSACTION_SCHEMA, value, 'takeover transaction');
}

export function parseTransactions(value: unknown): TakeoverTransactionLog {
  return parseStrict(TAKEOVER_TRANSACTIONS_SCHEMA, value, 'takeover transaction log');
}

export function authorizationIssues(value: unknown): string[] {
  return schemaIssues(TAKEOVER_AUTHORIZATION_SCHEMA, value);
}

export function policyIssues(value: unknown): string[] {
  return schemaIssues(TAKEOVER_POLICY_SCHEMA, value);
}

export function transactionIssues(value: unknown): string[] {
  return schemaIssues(TAKEOVER_TRANSACTION_SCHEMA, value);
}

// ---- authorization identity --------------------------------------------

export interface AuthorizationIdentityInput {
  root: string;
  projectId: string;
  projectKey: string;
  scope: readonly TakeoverScope[];
  grantedBy: string;
  role: string;
  statement: string;
  grantedAt: string;
}

export interface CreateAuthorizationInput extends AuthorizationIdentityInput {
  sourceDigestAtGrant?: string | null;
}

/** Order-independent scope normalization so set-equal scopes share one id. */
export function normalizeScopes(scope: readonly TakeoverScope[]): TakeoverScope[] {
  return [...new Set(scope)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** ADR-006 §3.2 / docs/takeover.md §3.2: sha256 over the canonical identity. */
export function computeAuthorizationId(identity: AuthorizationIdentityInput): string {
  return sha256Hex(canonicalJson({
    root: identity.root,
    projectId: identity.projectId,
    projectKey: identity.projectKey,
    scope: normalizeScopes(identity.scope),
    grantedBy: identity.grantedBy,
    role: identity.role,
    statement: identity.statement,
    grantedAt: identity.grantedAt,
  }));
}

/** Fail closed when a stored/edited record no longer hashes to its id. */
export function assertAuthorizationIntegrity(authorization: TakeoverAuthorization): void {
  const expected = computeAuthorizationId(authorization);
  if (expected !== authorization.authorizationId) {
    throw new TakeoverPolicyError('authorizationId does not match the authorization fields');
  }
}

export function createAuthorization(input: CreateAuthorizationInput): TakeoverAuthorization {
  const scope = normalizeScopes(input.scope);
  const record: TakeoverAuthorization = {
    schema: TAKEOVER_AUTHORIZATION_SCHEMA_NAME,
    authorizationId: computeAuthorizationId({ ...input, scope }),
    root: input.root,
    projectId: input.projectId,
    projectKey: input.projectKey,
    scope,
    grantedBy: input.grantedBy,
    role: input.role,
    statement: input.statement,
    grantedAt: input.grantedAt,
    sourceDigestAtGrant: input.sourceDigestAtGrant ?? null,
    revokedAt: null,
  };
  return parseAuthorization(record);
}

// ---- policy factory -----------------------------------------------------

export interface CreatePolicyInput {
  root: string;
  projectId: string;
  projectKey: string;
  authorization: TakeoverAuthorization;
  state?: TakeoverState;
  stateChangedAt?: string;
  enforcedAt?: string | null;
  recoveredAt?: string | null;
  baselineDigest?: string | null;
  hostCapability?: 'full' | 'degraded' | null;
  updatedAt?: string;
}

export function createPolicy(input: CreatePolicyInput): TakeoverPolicy {
  const now = input.updatedAt ?? new Date().toISOString();
  const record: TakeoverPolicy = {
    schema: TAKEOVER_POLICY_SCHEMA_NAME,
    schemaVersion: TAKEOVER_SCHEMA_VERSION,
    root: input.root,
    projectId: input.projectId,
    projectKey: input.projectKey,
    authorization: input.authorization,
    state: input.state ?? 'disabled',
    stateChangedAt: input.stateChangedAt ?? now,
    enforcedAt: input.enforcedAt ?? null,
    recoveredAt: input.recoveredAt ?? null,
    baselineDigest: input.baselineDigest ?? null,
    hostCapability: input.hostCapability ?? null,
    stateHash: '',
    updatedAt: now,
  };
  return parsePolicy({ ...record, stateHash: computePolicyStateHash(record) });
}

// ---- state integrity ----------------------------------------------------

/** The mutable policy fields covered by `stateHash` (identity stays in the authorization). */
export interface PolicyStatePortion {
  readonly state: TakeoverState;
  readonly stateChangedAt: string;
  readonly enforcedAt: string | null;
  readonly recoveredAt: string | null;
  readonly baselineDigest: string | null;
  readonly hostCapability: 'full' | 'degraded' | null;
}

/** `stateHash = sha256(canonicalJson(state portion))`; deterministic across key order. */
export function computePolicyStateHash(policy: PolicyStatePortion): string {
  return sha256Hex(canonicalJson({
    state: policy.state,
    stateChangedAt: policy.stateChangedAt,
    enforcedAt: policy.enforcedAt,
    recoveredAt: policy.recoveredAt,
    baselineDigest: policy.baselineDigest,
    hostCapability: policy.hostCapability,
  }));
}

/**
 * Fail closed when a stored policy's state fields no longer match its hash.
 * Schema validity alone is not integrity: an edited `enforced` document can be
 * schema-valid while never having gone through the six-phase transaction.
 */
export function assertPolicyStateIntegrity(policy: TakeoverPolicy): void {
  if (computePolicyStateHash(policy) !== policy.stateHash) {
    throw new TakeoverPolicyError('policy stateHash does not match the persisted takeover state');
  }
}

// ---- state machine ------------------------------------------------------

/** The only legal forward edges (ADR-006 §4.1). Jumps are rejected. */
export const LEGAL_STATE_TRANSITIONS: Readonly<Record<TakeoverState, readonly TakeoverState[]>> = {
  disabled: ['enforced'],
  enforced: ['recovery'],
  recovery: ['disabled'],
};

export function canTransitionState(from: TakeoverState, to: TakeoverState): boolean {
  const targets = LEGAL_STATE_TRANSITIONS[from];
  return targets !== undefined && targets.includes(to);
}

export function nextStates(state: TakeoverState): readonly TakeoverState[] {
  return LEGAL_STATE_TRANSITIONS[state];
}

export function assertStateTransition(from: TakeoverState, to: TakeoverState): void {
  if (!canTransitionState(from, to)) {
    throw new TakeoverPolicyError(`illegal takeover state transition: ${from} -> ${to}`);
  }
}

/** Phase sequence is fixed; `aborted` is reachable from any live phase and terminal. */
export function assertPhaseAdvance(from: TakeoverPhase, to: TakeoverPhase): void {
  if (from === to) return;
  if (to === 'aborted') return;
  if (from === 'aborted') {
    throw new TakeoverPolicyError('aborted is terminal and cannot advance');
  }
  const fromIndex = TAKEOVER_ACTIVE_PHASES.indexOf(from);
  const toIndex = TAKEOVER_ACTIVE_PHASES.indexOf(to);
  if (fromIndex === -1 || toIndex !== fromIndex + 1) {
    throw new TakeoverPolicyError(`illegal takeover phase advance: ${from} -> ${to}`);
  }
}

// ---- structural bindings ------------------------------------------------

/** Structural root binding: a document may only be consumed by its own root. */
export function assertRootBinding(document: { root: string }, root: string): void {
  if (document.root !== root) {
    throw new TakeoverPolicyError(`document is bound to root ${document.root}, not ${root}`);
  }
}
