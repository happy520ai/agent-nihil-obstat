import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { withFileLockSync } from '../core/lock.ts';
import { ConnectSourceError, ConnectStoreError, ConnectTamperError } from './errors.ts';
import { assertSafeExistingDirectory, ensureSafeDirectory, resolveRoot, safeChild } from './paths.ts';
import {
  TAKEOVER_SCHEMA_VERSION,
  TAKEOVER_TRANSACTION_SCHEMA_NAME,
  TAKEOVER_TRANSACTIONS_SCHEMA_NAME,
  assertAuthorizationIntegrity,
  assertPhaseAdvance,
  assertPolicyStateIntegrity,
  assertStateTransition,
  assertTransactionChain,
  computePolicyStateHash,
  computeTransactionEntryHash,
  parseAuthorization,
  parsePolicy,
  parseTransaction,
  parseTransactions,
  TakeoverPolicyError,
  type TakeoverAuthorization,
  type TakeoverPhase,
  type TakeoverPolicy,
  type TakeoverState,
  type TakeoverTransaction,
  type TakeoverTransactionCore,
  type TakeoverTransactionLog,
} from './takeover-policy.ts';
import { canonicalJson, sha256Hex, stableJson } from './canonical.ts';

/**
 * ADR-006 / docs/takeover.md §3.3-§5: persistence for the takeover policy and
 * its append-only transaction journal.
 *
 *   <root>/.ano/takeover/policy.json          strict three-state strategy
 *   <root>/.ano/takeover/authorization.json   grant record (ADR-006 §3.2)
 *   <root>/.ano/takeover/transactions.json    append-only phase journal
 *
 * Writes are atomic (temp file + fsync + rename) under a project-local file
 * lock. Every read validates schema, version and root binding; corruption or
 * an unknown version fails closed with a specific error and is never reset.
 */

export const TAKEOVER_DIR_REL = '.ano/takeover';

/** The phase idempotency key triple (docs/takeover.md §9.4). */
export interface TakeoverIdempotencyKey {
  authorizationId: string;
  sourceDigest: string;
  backupHash: string;
}

/** Injectable filesystem seam so tests can prove no half-file survives a failed rename. */
export interface TakeoverStoreIo {
  writeTemp: (target: string, data: string) => string;
  rename: (temp: string, target: string) => void;
  remove: (temp: string) => void;
}

export const defaultTakeoverIo: TakeoverStoreIo = {
  writeTemp(target: string, data: string): string {
    const temp = join(dirname(target), `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
    const descriptor = openSync(temp, 'wx');
    try {
      writeSync(descriptor, Buffer.from(data));
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    return temp;
  },
  rename(temp: string, target: string): void {
    renameSync(temp, target);
  },
  remove(temp: string): void {
    try {
      unlinkSync(temp);
    } catch {
      // Best effort: the next writer uses a fresh random temp name.
    }
  },
};

// ---- paths --------------------------------------------------------------

export function takeoverDir(root: string): string {
  return safeChild(resolveRoot(root), '.ano', 'takeover');
}

export function policyPath(root: string): string {
  return safeChild(takeoverDir(root), 'policy.json');
}

export function authorizationPath(root: string): string {
  return safeChild(takeoverDir(root), 'authorization.json');
}

export function transactionsPath(root: string): string {
  return safeChild(takeoverDir(root), 'transactions.json');
}

/** txId = sha256 over the canonical idempotency key (docs/takeover.md §3.3). */
export function computeTransactionId(key: TakeoverIdempotencyKey): string {
  return sha256Hex(canonicalJson({
    authorizationId: key.authorizationId,
    sourceDigest: key.sourceDigest,
    backupHash: key.backupHash,
  }));
}

// ---- inputs/results -----------------------------------------------------

export interface AppendTransactionInput extends TakeoverIdempotencyKey {
  backupId: string;
  phase: TakeoverPhase;
  /** Optional explicit id; when present it must equal the derived id. */
  txId?: string;
  evidenceHash?: string | null;
  error?: string | null;
  now?: string;
}

export interface AppendTransactionResult {
  entry: TakeoverTransaction;
  /** false means an identical record already existed (idempotent replay). */
  created: boolean;
  txId: string;
}

export interface StateTransitionInput {
  from: TakeoverState;
  to: TakeoverState;
  now?: string;
  baselineDigest?: string | null;
  hostCapability?: 'full' | 'degraded' | null;
}

export interface TakeoverRuntimeState {
  root: string;
  state: TakeoverState;
  policy: TakeoverPolicy | null;
  txId: string | null;
  phase: TakeoverPhase | null;
  transactions: number;
  updatedAt: string | null;
}

// ---- store --------------------------------------------------------------

export class TakeoverStore {
  readonly root: string;
  readonly io: TakeoverStoreIo;

  constructor(root: string, io: TakeoverStoreIo = defaultTakeoverIo) {
    this.root = resolveRoot(root);
    this.io = io;
  }

  get directory(): string {
    return takeoverDir(this.root);
  }

  get policyPath(): string {
    return policyPath(this.root);
  }

  get authorizationPath(): string {
    return authorizationPath(this.root);
  }

  get transactionsPath(): string {
    return transactionsPath(this.root);
  }

  private withLock<T>(operation: () => T): T {
    return withFileLockSync(safeChild(this.directory, 'lock'), operation);
  }

  private ensureDirectory(): void {
    ensureSafeDirectory(this.directory);
  }

  private display(path: string): string {
    return relative(this.root, path).split(sep).join('/');
  }

  /** Atomic replace: temp file + fsync + rename; temp removed on failure. */
  private writeDocument(path: string, data: string): void {
    assertSafeExistingDirectory(dirname(path));
    const temp = this.io.writeTemp(path, data);
    try {
      this.io.rename(temp, path);
    } catch (error) {
      this.io.remove(temp);
      throw error;
    }
  }

  /** Missing is absence; unreadable/invalid is corruption and throws. */
  private readDocument(path: string): unknown {
    assertSafeExistingDirectory(dirname(path));
    let stats;
    try {
      stats = lstatSync(path);
    } catch {
      throw new ConnectStoreError(`Missing takeover file: ${this.display(path)}`);
    }
    if (stats.isSymbolicLink()) {
      throw new ConnectStoreError(`Refusing to read a symbolic link/junction: ${this.display(path)}`);
    }
    let raw: Buffer;
    try {
      raw = readFileSync(path);
    } catch (error) {
      throw new ConnectStoreError(`Cannot read takeover file ${this.display(path)}: ${errorMessage(error)}`);
    }
    try {
      return JSON.parse(raw.toString('utf8')) as unknown;
    } catch (error) {
      throw new ConnectTamperError(`Takeover file is not valid JSON: ${this.display(path)} (${errorMessage(error)})`);
    }
  }

  /** Structural root binding: a document may only be consumed by its own root. */
  private assertSameRoot(document: { root: string }, label: string): void {
    if (document.root !== this.root) {
      throw new ConnectSourceError(`${label} is bound to ${document.root}, not ${this.root}`);
    }
  }

  /** Stored bytes that fail validation are corruption, not caller input errors. */
  private parsePersisted<T>(parse: () => T): T {
    try {
      return parse();
    } catch (error) {
      if (error instanceof TakeoverPolicyError) throw new ConnectTamperError(error.message);
      throw error;
    }
  }

  /** Unknown document versions are rejected explicitly, never migrated silently. */
  private assertSupportedVersion(raw: unknown, label: string): void {
    if (raw === null || typeof raw !== 'object') return; // schema reports the shape
    const version = (raw as { schemaVersion?: unknown }).schemaVersion;
    if (version !== TAKEOVER_SCHEMA_VERSION) {
      throw new ConnectTamperError(`${label} has unsupported schemaVersion: ${String(version)}`);
    }
  }

  private readPolicyOrNull(): TakeoverPolicy | null {
    const path = this.policyPath;
    if (!existsSync(path)) return null;
    const raw = this.readDocument(path);
    this.assertSupportedVersion(raw, 'takeover policy');
    const policy = this.parsePersisted(() => {
      const parsed = parsePolicy(raw);
      assertAuthorizationIntegrity(parsed.authorization);
      assertPolicyStateIntegrity(parsed);
      return parsed;
    });
    this.assertSameRoot(policy, 'takeover policy');
    if (policy.authorization.root !== this.root) {
      throw new ConnectSourceError(`takeover authorization is bound to ${policy.authorization.root}, not ${this.root}`);
    }
    return policy;
  }

  loadPolicy(): TakeoverPolicy | null {
    return this.readPolicyOrNull();
  }

  savePolicy(policy: TakeoverPolicy, options: { expectedState?: TakeoverState } = {}): TakeoverPolicy {
    const parsed = this.validatePolicy(policy);
    this.ensureDirectory();
    return this.withLock(() => this.writePolicyDocument(parsed, options.expectedState));
  }

  private validatePolicy(policy: TakeoverPolicy): TakeoverPolicy {
    const parsed = parsePolicy(policy);
    this.assertSameRoot(parsed, 'takeover policy');
    assertAuthorizationIntegrity(parsed.authorization);
    if (parsed.authorization.root !== this.root) {
      throw new ConnectSourceError(`takeover authorization is bound to ${parsed.authorization.root}, not ${this.root}`);
    }
    // Writes always recompute the state integrity hash; a caller-supplied or
    // stale hash is never persisted.
    const sealed: TakeoverPolicy = { ...parsed, stateHash: computePolicyStateHash(parsed) };
    assertPolicyStateIntegrity(sealed);
    return sealed;
  }

  private writePolicyDocument(parsed: TakeoverPolicy, expectedState?: TakeoverState): TakeoverPolicy {
    if (expectedState !== undefined) {
      const existing = this.readPolicyOrNull();
      if (existing !== null && existing.state !== expectedState) {
        throw new ConnectStoreError(`takeover state changed concurrently: expected ${expectedState}, found ${existing.state}`);
      }
    }
    this.writeDocument(this.policyPath, stableJson(parsePolicy(parsed)));
    return parsed;
  }

  // ---- authorization ----------------------------------------------------

  loadAuthorization(): TakeoverAuthorization | null {
    const path = this.authorizationPath;
    if (!existsSync(path)) return null;
    const authorization = this.parsePersisted(() => {
      const parsed = parseAuthorization(this.readDocument(path));
      assertAuthorizationIntegrity(parsed);
      return parsed;
    });
    this.assertSameRoot(authorization, 'takeover authorization');
    return authorization;
  }

  saveAuthorization(authorization: TakeoverAuthorization): TakeoverAuthorization {
    const parsed = parseAuthorization(authorization);
    this.assertSameRoot(parsed, 'takeover authorization');
    assertAuthorizationIntegrity(parsed);
    this.ensureDirectory();
    return this.withLock(() => {
      this.writeDocument(this.authorizationPath, stableJson(parsed));
      return parsed;
    });
  }

  // ---- transaction journal ---------------------------------------------

  private readLog(): TakeoverTransactionLog {
    const path = this.transactionsPath;
    if (!existsSync(path)) {
      return { schema: TAKEOVER_TRANSACTIONS_SCHEMA_NAME, schemaVersion: TAKEOVER_SCHEMA_VERSION, root: this.root, entries: [] };
    }
    const raw = this.readDocument(path);
    this.assertSupportedVersion(raw, 'takeover transaction log');
    const log = this.parsePersisted(() => parseTransactions(raw));
    this.assertSameRoot(log, 'takeover transaction log');
    for (const entry of log.entries) {
      this.assertSameRoot(entry, 'takeover transaction entry');
    }
    // History binding runs only after structural binding, so a foreign-root
    // document reports CONNECT_SOURCE rather than a generic chain failure.
    try {
      assertTransactionChain(log.entries);
    } catch (error) {
      if (error instanceof TakeoverPolicyError) throw new ConnectTamperError(error.message);
      throw error;
    }
    return log;
  }

  readTransactions(txId?: string): TakeoverTransaction[] {
    const entries = this.readLog().entries;
    return txId === undefined ? [...entries] : entries.filter((entry) => entry.txId === txId);
  }

  /**
   * Append one phase record. A completed phase replays its stored record when
   * the idempotency key and parameters match; the same key with different
   * parameters, or a phase that skips/regresses the fixed sequence, is rejected.
   */
  appendTransaction(input: AppendTransactionInput): AppendTransactionResult {
    const txId = computeTransactionId(input);
    if (input.txId !== undefined && input.txId !== txId) {
      throw new ConnectStoreError(`txId mismatch: expected ${txId} for the idempotency key`);
    }
    const now = input.now ?? new Date().toISOString();
    const core: TakeoverTransactionCore = {
      schema: TAKEOVER_TRANSACTION_SCHEMA_NAME,
      txId,
      authorizationId: input.authorizationId,
      root: this.root,
      phase: input.phase,
      sourceDigest: input.sourceDigest,
      backupId: input.backupId,
      backupHash: input.backupHash,
      evidenceHash: input.evidenceHash ?? null,
      startedAt: now,
      updatedAt: now,
      error: input.error ?? null,
    };
    this.ensureDirectory();
    return this.withLock(() => {
      const log = this.readLog();
      const history = log.entries.filter((entry) => entry.txId === txId);
      // Chain position is derived from the verified journal, never from input.
      const prevHash = log.entries.at(-1)?.entryHash ?? null;
      const candidate: TakeoverTransaction = parseTransaction({
        ...core,
        prevHash,
        entryHash: computeTransactionEntryHash(core),
      });
      const samePhase = history.find((entry) => entry.phase === candidate.phase);
      if (samePhase !== undefined) {
        if (!sameTransactionParameters(samePhase, candidate)) {
          throw new ConnectStoreError(`idempotency conflict for tx ${txId}: same key, different parameters`);
        }
        return { entry: samePhase, created: false, txId };
      }
      const latest = history.at(-1);
      if (latest !== undefined) {
        assertPhaseAdvance(latest.phase, candidate.phase);
      } else if (candidate.phase !== 'prepared') {
        throw new ConnectStoreError('the first transaction record must have phase prepared');
      }
      const next: TakeoverTransactionLog = { ...log, entries: [...log.entries, candidate] };
      this.writeDocument(this.transactionsPath, stableJson(parseTransactions(next)));
      return { entry: candidate, created: true, txId };
    });
  }

  /** Read-only combined view used by `takeover status` and crash recovery. */
  loadState(): TakeoverRuntimeState {
    const policy = this.readPolicyOrNull();
    const entries = this.readLog().entries;
    const last = entries.at(-1) ?? null;
    return {
      root: this.root,
      state: policy?.state ?? 'disabled',
      policy,
      txId: last?.txId ?? null,
      phase: last?.phase ?? null,
      transactions: entries.length,
      updatedAt: policy?.updatedAt ?? last?.updatedAt ?? null,
    };
  }

  /** Guarded, persisted state transition; illegal jumps and stale reads fail. */
  transition(input: StateTransitionInput): TakeoverPolicy {
    assertStateTransition(input.from, input.to);
    const now = input.now ?? new Date().toISOString();
    this.ensureDirectory();
    return this.withLock(() => {
      const current = this.readPolicyOrNull();
      if (current === null) {
        throw new ConnectStoreError('cannot transition takeover state: no policy document');
      }
      if (current.state !== input.from) {
        throw new ConnectStoreError(`takeover state is ${current.state}, expected ${input.from}`);
      }
      if (input.to === 'enforced' && current.authorization.revokedAt !== null) {
        throw new ConnectStoreError('cannot enforce takeover: the authorization is revoked');
      }
      const nextRecord: TakeoverPolicy = {
        ...current,
        state: input.to,
        stateChangedAt: now,
        updatedAt: now,
        enforcedAt: input.to === 'enforced' ? now : current.enforcedAt,
        recoveredAt: input.to === 'disabled' ? now : current.recoveredAt,
        baselineDigest: input.baselineDigest !== undefined ? input.baselineDigest : current.baselineDigest,
        hostCapability: input.hostCapability !== undefined ? input.hostCapability : current.hostCapability,
      };
      const parsed = this.validatePolicy(nextRecord);
      return this.writePolicyDocument(parsed, input.from);
    });
  }
}

function sameTransactionParameters(a: TakeoverTransaction, b: TakeoverTransaction): boolean {
  return a.authorizationId === b.authorizationId
    && a.backupId === b.backupId
    && a.backupHash === b.backupHash
    && a.evidenceHash === b.evidenceHash
    && a.error === b.error
    && a.sourceDigest === b.sourceDigest;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---- free functions -----------------------------------------------------

export function loadPolicy(root: string): TakeoverPolicy | null {
  return new TakeoverStore(root).loadPolicy();
}

export function savePolicy(root: string, policy: TakeoverPolicy, options: { expectedState?: TakeoverState } = {}): TakeoverPolicy {
  return new TakeoverStore(root).savePolicy(policy, options);
}

export function loadAuthorization(root: string): TakeoverAuthorization | null {
  return new TakeoverStore(root).loadAuthorization();
}

export function saveAuthorization(root: string, authorization: TakeoverAuthorization): TakeoverAuthorization {
  return new TakeoverStore(root).saveAuthorization(authorization);
}

export function readTransactions(root: string, txId?: string): TakeoverTransaction[] {
  return new TakeoverStore(root).readTransactions(txId);
}

export function appendTransaction(root: string, input: AppendTransactionInput): AppendTransactionResult {
  return new TakeoverStore(root).appendTransaction(input);
}

export function loadState(root: string): TakeoverRuntimeState {
  return new TakeoverStore(root).loadState();
}

export function applyStateTransition(root: string, input: StateTransitionInput): TakeoverPolicy {
  return new TakeoverStore(root).transition(input);
}
