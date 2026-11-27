import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { withFileLock } from '../core/lock.ts';
import { ProjectScanError, resolveProjectScan } from '../core/project-scan.ts';
import { DEFAULT_MIGRATION_SOURCES, migrateProject, planMigration, readMigrationSummary, reconcileMigration, resolveMigrationPmRoot } from '../ledger/migrate.ts';
import { backupHash, backupProject, verifyBackup } from './backup.ts';
import { canonicalJson, sha256Hex, stableJson } from './canonical.ts';
import { ConnectError, ConnectStoreError, ConnectTamperError } from './errors.ts';
import {
  MANAGED_INSTRUCTIONS_REQUIRED_SCOPES,
  installManagedInstructions,
  renderDefaultManagedInstructions,
  updateManagedInstructions,
  type ManagedInstructionsResult,
} from './managed-instructions.ts';
import { ensureSafeDirectory, resolveRoot, safeChild } from './paths.ts';
import {
  TAKEOVER_ACTIVE_PHASES,
  assertRootBinding,
  createPolicy,
  type TakeoverAuthorization,
  type TakeoverPhase,
  type TakeoverPolicy,
  type TakeoverState,
  type TakeoverTransaction,
} from './takeover-policy.ts';
import {
  TakeoverStore,
  computeTransactionId,
  defaultTakeoverIo,
  takeoverDir,
} from './takeover-store.ts';

/**
 * ADR-006 / docs/takeover.md §4-§6: the six-phase enforced-takeover transaction.
 *
 *   prepared -> migrated -> reconciled -> verified -> installed -> active
 *
 * `active` is the only main-write switch. Every earlier phase is either
 * read-only or writes ANO-owned artifacts (`.ano/takeover/**`, `.ano/backup/**`
 * and the ANO ledger), so a failure before `active` can abort with zero
 * main-write side effects. Each phase appends one idempotent journal record
 * bound to `(authorizationId, sourceDigest, backupHash)`; re-entry reads the
 * journal and resumes from the last committed phase.
 *
 * This module never writes `.pm/`, never writes user-level configuration and
 * never changes the legacy Connect/handoff semantics.
 */

export const TAKEOVER_RUN_SCHEMA = 'ano.takeover-run/1' as const;
export const TAKEOVER_STATUS_SCHEMA = 'ano.takeover-status/1' as const;

export const TAKEOVER_PREPARED_FILE = 'prepared.json' as const;
export const TAKEOVER_MIGRATION_FILE = 'migration-summary.json' as const;
export const TAKEOVER_RECONCILE_FILE = 'reconcile.json' as const;
export const TAKEOVER_VERIFICATION_FILE = 'verification.json' as const;
export const TAKEOVER_INSTALLED_FILE = 'installed.json' as const;

export const TAKEOVER_PREPARED_SCHEMA = 'ano.takeover-prepared/1' as const;
export const TAKEOVER_MIGRATION_SCHEMA = 'ano.takeover-migration-summary/1' as const;
export const TAKEOVER_RECONCILE_SCHEMA = 'ano.takeover-reconcile/1' as const;
export const TAKEOVER_VERIFICATION_SCHEMA = 'ano.takeover-verification/1' as const;
export const TAKEOVER_INSTALLED_SCHEMA = 'ano.takeover-installed/1' as const;

/** Host capability layer; ADR-006 §8 records the known-missing layers. */
export type TakeoverHostCapability = 'full' | 'degraded';

export const TAKEOVER_HOST_CAPABILITY_REASONS: readonly string[] = [
  'host exposes no output-interception interface for MCP results (T-055)',
  'hooks are tool-level gates and are not enabled for ANO',
  'no auto-launch/auto-approve capability; session permissions cannot be granted by ANO',
];

// ---- errors -------------------------------------------------------------

export class TakeoverError extends ConnectError {
  override readonly code: string = 'TAKEOVER';
  constructor(message: string) {
    super(message);
    this.name = 'TakeoverError';
  }
}

/** The old source changed after a transaction bound its digest; stop, never silently continue. */
export class TakeoverSourceDriftError extends TakeoverError {
  override readonly code = 'TAKEOVER_SOURCE_DRIFT' as const;
  constructor(message: string) {
    super(message);
    this.name = 'TakeoverSourceDriftError';
  }
}

/** A phase failed after the journal existed; the failure is recorded as `aborted`. */
export class TakeoverPhaseError extends TakeoverError {
  override readonly code = 'TAKEOVER_PHASE' as const;
  readonly phase: TakeoverPhase;
  constructor(phase: TakeoverPhase, cause: unknown) {
    super(`takeover phase ${phase} failed: ${errorMessage(cause)}`);
    this.name = 'TakeoverPhaseError';
    this.phase = phase;
  }
}

// ---- inputs -------------------------------------------------------------

/**
 * Test/CLI seam. Production callers omit it; integration tests inject failures
 * to prove the abort paths without touching a real project.
 */
export interface TakeoverRuntime {
  readonly backupProject?: typeof backupProject;
  readonly verifyBackup?: typeof verifyBackup;
  readonly migrateProject?: typeof migrateProject;
  readonly reconcileMigration?: typeof reconcileMigration;
  readonly installManagedInstructions?: typeof installManagedInstructions;
  readonly updateManagedInstructions?: typeof updateManagedInstructions;
}

type ResolvedRuntime = Required<TakeoverRuntime>;

export interface TakeoverRunOptions {
  /** Explicit human confirmation. Never inferred from env/config/defaults. */
  readonly confirm: boolean;
  readonly authorizationId: string;
  /** Deterministic clock for tests; defaults to now. */
  readonly now?: string;
  /** `.pm` sources to migrate; defaults to the project's migration sources. */
  readonly sources?: readonly string[];
  /** Host capability layer recorded in the verification evidence and policy. */
  readonly hostCapability?: TakeoverHostCapability;
  /** Test-only seam for fault injection. */
  readonly runtime?: TakeoverRuntime;
  /** Test-only seam: stop after this phase to simulate an interruption. */
  readonly stopAfterPhase?: TakeoverPhase;
}

export interface TakeoverPhaseSummary {
  readonly phase: TakeoverPhase;
  readonly txId: string;
  readonly evidenceHash: string | null;
  readonly at: string;
}

export interface TakeoverRunResult {
  readonly schema: typeof TAKEOVER_RUN_SCHEMA;
  readonly root: string;
  readonly authorizationId: string;
  readonly txId: string;
  /** Last journal phase; `aborted` when a phase failed. */
  readonly phase: TakeoverPhase;
  /** Authoritative policy state after the run. */
  readonly state: TakeoverState;
  readonly sourceDigest: string;
  readonly backupId: string;
  readonly backupHash: string;
  readonly evidenceHash: string | null;
  /** True when this run appended the final journal record. */
  readonly created: boolean;
  /** True when the run resumed an existing journal instead of preparing. */
  readonly resumed: boolean;
  readonly active: boolean;
  readonly aborted: boolean;
  readonly failedPhase: TakeoverPhase | null;
  readonly error: string | null;
  readonly phases: readonly TakeoverPhaseSummary[];
  /** Project-relative artifact paths written by this transaction. */
  readonly artifacts: readonly string[];
  /**
   * Auditable three-root resolution used for this run (ADR-009 §10). The PM
   * source is `pmRoot` (the Git root); `sourceRoots` are scan-only and a
   * `.pm` below them is reported in `ignoredPmRoots`, never used.
   */
  readonly rootResolution?: { readonly inputRoot: string; readonly gitRoot: string; readonly pmRoot: string; readonly sourceRoots: string[] };
  readonly ignoredPmRoots?: string[];
}

export interface TakeoverStatus {
  readonly schema: typeof TAKEOVER_STATUS_SCHEMA;
  readonly root: string;
  readonly state: TakeoverState;
  readonly policy: TakeoverPolicy | null;
  readonly authorization: TakeoverAuthorization | null;
  readonly transaction: TakeoverTransaction | null;
  readonly transactions: number;
  readonly hostCapability: TakeoverHostCapability | null;
  readonly baselineDigest: string | null;
  readonly enforcedAt: string | null;
  readonly artifacts: readonly string[];
}

// ---- artifact shapes ----------------------------------------------------

export interface TakeoverAgentsOriginal {
  readonly exists: boolean;
  readonly bytes: number;
  readonly sha256: string | null;
}

export interface TakeoverPreparedRecord {
  readonly schema: typeof TAKEOVER_PREPARED_SCHEMA;
  readonly txId: string;
  readonly authorizationId: string;
  readonly root: string;
  readonly sourceDigest: string;
  readonly backupId: string;
  readonly backupHash: string;
  readonly pm: readonly { path: string; sha256: string; bytes: number }[];
  readonly ledger: readonly { path: string; sha256: string; bytes: number }[];
  /** Sensitive files deliberately excluded from the backup (ADR-006 §2.5). */
  readonly skippedSensitive: readonly { path: string; reason: string }[];
  readonly agents: TakeoverAgentsOriginal;
  readonly createdAt: string;
}

export interface TakeoverMigrationRecord {
  readonly schema: typeof TAKEOVER_MIGRATION_SCHEMA;
  readonly txId: string;
  readonly authorizationId: string;
  readonly root: string;
  readonly sourceDigest: string;
  readonly summary: Record<string, unknown>;
  readonly result: Record<string, unknown>;
}

export interface TakeoverReconcileRecord {
  readonly schema: typeof TAKEOVER_RECONCILE_SCHEMA;
  readonly txId: string;
  readonly authorizationId: string;
  readonly root: string;
  readonly sourceDigest: string;
  readonly report: Record<string, unknown>;
}

export interface TakeoverEvidenceEntry {
  readonly kind: string;
  readonly ok: boolean;
  readonly detail: unknown;
}

export interface TakeoverVerificationRecord {
  readonly schema: typeof TAKEOVER_VERIFICATION_SCHEMA;
  readonly txId: string;
  readonly authorizationId: string;
  readonly root: string;
  readonly sourceDigest: string;
  readonly baselineDigest: string;
  readonly backupId: string;
  readonly backupHash: string;
  readonly evidence: readonly TakeoverEvidenceEntry[];
  readonly evidenceHash: string;
  readonly hostCapability: TakeoverHostCapability;
  readonly hostCapabilityReasons: readonly string[];
  readonly verifiedAt: string;
}

export interface TakeoverInstalledRecord {
  readonly schema: typeof TAKEOVER_INSTALLED_SCHEMA;
  readonly txId: string;
  readonly authorizationId: string;
  readonly root: string;
  readonly sourceDigest: string;
  readonly policyState: TakeoverState;
  readonly baselineDigest: string | null;
  readonly managed: ManagedInstructionsResult;
  readonly agentsOriginal: TakeoverAgentsOriginal;
  readonly installedAt: string;
}

// ---- helpers ------------------------------------------------------------

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function resolveRuntime(runtime: TakeoverRuntime | undefined): ResolvedRuntime {
  return {
    backupProject: runtime?.backupProject ?? backupProject,
    verifyBackup: runtime?.verifyBackup ?? verifyBackup,
    migrateProject: runtime?.migrateProject ?? migrateProject,
    reconcileMigration: runtime?.reconcileMigration ?? reconcileMigration,
    installManagedInstructions: runtime?.installManagedInstructions ?? installManagedInstructions,
    updateManagedInstructions: runtime?.updateManagedInstructions ?? updateManagedInstructions,
  };
}

function displayPath(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

function writeArtifact(root: string, name: string, value: unknown): string {
  const directory = takeoverDir(root);
  ensureSafeDirectory(directory);
  const path = safeChild(directory, name);
  const temp = defaultTakeoverIo.writeTemp(path, stableJson(value));
  try {
    defaultTakeoverIo.rename(temp, path);
  } catch (error) {
    defaultTakeoverIo.remove(temp);
    throw error;
  }
  return path;
}

function readArtifact<T extends { schema: string; txId: string }>(root: string, name: string): T | null {
  const path = safeChild(takeoverDir(root), name);
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new ConnectTamperError(`Cannot read takeover artifact ${name}: ${errorMessage(error)}`);
  }
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new ConnectTamperError(`Takeover artifact ${name} is not valid JSON: ${errorMessage(error)}`);
  }
}

function readAgentsOriginal(root: string): TakeoverAgentsOriginal {
  const file = join(root, 'AGENTS.md');
  try {
    const bytes = readFileSync(file);
    return { exists: true, bytes: bytes.length, sha256: sha256Hex(bytes) };
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { exists: false, bytes: 0, sha256: null };
    throw new ConnectStoreError(`Unable to read ${file}: ${errorMessage(error)}`);
  }
}

/** The old-source digest that migration and reconciliation both bind to. */
export function computeTakeoverSourceDigest(root: string, sources?: readonly string[]): string {
  return planMigration(root, sources === undefined ? {} : { sources: [...sources] }).sourceDigest;
}

interface TakeoverRootResolution {
  readonly inputRoot: string;
  readonly gitRoot: string;
  readonly pmRoot: string;
  readonly sourceRoots: string[];
  readonly ignoredPmRoots: string[];
}

/**
 * Bind a takeover input to the authoritative repository-root PM root.
 *
 * `resolveMigrationPmRoot` refuses a source-subdirectory `.pm` (for example
 * `server/.pm`) unless the Git root itself carries `.pm`. When the full scan
 * resolver can run (Node package + Git metadata present) its discovery report
 * is returned for audit; legacy PM-only fixtures without package/Git keep the
 * sync root binding so existing takeover semantics are unchanged.
 */
async function resolveTakeoverRoot(rootInput: string): Promise<{ root: string; resolution: TakeoverRootResolution }> {
  const inputRoot = resolveRoot(rootInput);
  const root = resolveMigrationPmRoot(inputRoot);
  try {
    const scan = await resolveProjectScan({ startRoot: inputRoot });
    return {
      root,
      resolution: {
        inputRoot: scan.startRoot,
        gitRoot: scan.gitRoot,
        pmRoot: scan.pmRoot,
        sourceRoots: [...scan.sourceRoots],
        ignoredPmRoots: [...scan.ignoredPmRoots],
      },
    };
  } catch (error) {
    if (error instanceof ProjectScanError && (error.code === 'NO_NODE_PACKAGE' || error.code === 'NOT_A_GIT_WORK_TREE' || error.code === 'PM_ROOT_WITHOUT_PM')) {
      return {
        root,
        resolution: { inputRoot, gitRoot: root, pmRoot: root, sourceRoots: [root], ignoredPmRoots: [] },
      };
    }
    throw error;
  }
}

function phaseIndex(phase: TakeoverPhase): number {
  return (TAKEOVER_ACTIVE_PHASES as readonly string[]).indexOf(phase);
}

interface TxGroup {
  readonly txId: string;
  readonly entries: TakeoverTransaction[];
}

function groupTransactions(entries: readonly TakeoverTransaction[]): TxGroup[] {
  const byId = new Map<string, TakeoverTransaction[]>();
  for (const entry of entries) {
    const list = byId.get(entry.txId);
    if (list === undefined) byId.set(entry.txId, [entry]);
    else list.push(entry);
  }
  return [...byId.entries()].map(([txId, list]) => ({ txId, entries: list }));
}

function lastEntry(group: TxGroup): TakeoverTransaction | undefined {
  return group.entries.at(-1);
}

/**
 * Find the live transaction for this authorization. A source change is drift
 * and stops the run; an aborted transaction is not resumable (the store makes
 * `aborted` terminal), so a fresh backup/transaction is required.
 */
function selectResumeTarget(store: TakeoverStore, authorizationId: string, sourceDigest: string): TxGroup | null {
  const groups = groupTransactions(store.readTransactions().filter((entry) => entry.authorizationId === authorizationId));
  const live = groups.filter((group) => lastEntry(group)?.phase !== 'aborted');
  if (live.length === 0) return null;
  live.sort((a, b) => {
    const left = lastEntry(a)?.updatedAt ?? '';
    const right = lastEntry(b)?.updatedAt ?? '';
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const target = live.at(-1);
  if (target === undefined) return null;
  const bound = lastEntry(target)?.sourceDigest;
  if (bound !== sourceDigest) {
    throw new TakeoverSourceDriftError(
      `takeover source changed since the transaction started: expected ${bound ?? 'none'}, found ${sourceDigest}`,
    );
  }
  return target;
}

interface TxContext {
  readonly root: string;
  readonly store: TakeoverStore;
  readonly authorization: TakeoverAuthorization;
  readonly sources: readonly string[];
  readonly digest: string;
  readonly now: string;
  readonly hostCapability: TakeoverHostCapability;
  readonly runtime: ResolvedRuntime;
  readonly txId: string;
  readonly backupId: string;
  readonly backupHash: string;
  readonly entries: readonly TakeoverTransaction[];
  readonly artifacts: readonly string[];
  readonly lastCreated: boolean;
}

function contextFromEntries(
  root: string,
  store: TakeoverStore,
  authorization: TakeoverAuthorization,
  sources: readonly string[],
  digest: string,
  now: string,
  hostCapability: TakeoverHostCapability,
  runtime: ResolvedRuntime,
  entries: readonly TakeoverTransaction[],
  artifacts: readonly string[],
  lastCreated: boolean,
): TxContext {
  const last = entries.at(-1);
  if (last === undefined) throw new TakeoverError('takeover transaction has no journal records');
  return {
    root,
    store,
    authorization,
    sources,
    digest,
    now,
    hostCapability,
    runtime,
    txId: last.txId,
    backupId: last.backupId,
    backupHash: last.backupHash,
    entries,
    artifacts,
    lastCreated,
  };
}

function ensureDisabledPolicy(
  store: TakeoverStore,
  authorization: TakeoverAuthorization,
  hostCapability: TakeoverHostCapability,
  now: string,
): TakeoverPolicy {
  const existing = store.loadPolicy();
  if (existing !== null) {
    if (existing.authorization.authorizationId !== authorization.authorizationId) {
      // ADR-006 §4.1: `disabled` requires a fresh explicit grant before a new
      // six-phase transaction. An explicit re-grant on the same root starts a
      // new cycle instead of replaying the previous authorization's journal.
      if (existing.state !== 'disabled') {
        throw new TakeoverError('stored takeover policy belongs to a different authorization');
      }
      return store.savePolicy(createPolicy({
        root: store.root,
        projectId: authorization.projectId,
        projectKey: authorization.projectKey,
        authorization,
        state: 'disabled',
        stateChangedAt: now,
        updatedAt: now,
        hostCapability,
      }));
    }
    if (existing.state !== 'disabled') {
      throw new TakeoverError(`takeover policy is ${existing.state}; a new takeover requires disabled`);
    }
    return existing;
  }
  return store.savePolicy(createPolicy({
    root: store.root,
    projectId: authorization.projectId,
    projectKey: authorization.projectKey,
    authorization,
    state: 'disabled',
    stateChangedAt: now,
    updatedAt: now,
    hostCapability,
  }));
}

// ---- phases -------------------------------------------------------------

interface PhaseOutcome {
  readonly evidenceHash: string;
  readonly artifacts: readonly string[];
}

async function assertSourceUnchanged(ctx: TxContext): Promise<void> {
  const current = computeTakeoverSourceDigest(ctx.root, ctx.sources);
  if (current !== ctx.digest) {
    throw new TakeoverSourceDriftError(`takeover source changed: expected ${ctx.digest}, found ${current}`);
  }
}

function requireBinding<T extends { schema: string; txId: string }>(
  record: T | null,
  ctx: TxContext,
  label: string,
): T {
  if (record === null) throw new TakeoverError(`missing ${label} artifact`);
  if (record.txId !== ctx.txId) throw new TakeoverError(`${label} artifact is bound to a different transaction`);
  return record;
}

async function preparePhase(
  root: string,
  store: TakeoverStore,
  authorization: TakeoverAuthorization,
  sources: readonly string[],
  digest: string,
  now: string,
  hostCapability: TakeoverHostCapability,
  runtime: ResolvedRuntime,
): Promise<TxContext> {
  const backupId = `takeover-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const manifest = await runtime.backupProject(root, backupId);
  const hash = backupHash(manifest);
  const verification = await runtime.verifyBackup(root, manifest.id);
  if (!verification.ok) {
    throw new TakeoverError(`takeover backup failed verification: ${verification.errors.join(', ')}`);
  }
  const agents = readAgentsOriginal(root);
  const txId = computeTransactionId({
    authorizationId: authorization.authorizationId,
    sourceDigest: digest,
    backupHash: hash,
  });
  const record: TakeoverPreparedRecord = {
    schema: TAKEOVER_PREPARED_SCHEMA,
    txId,
    authorizationId: authorization.authorizationId,
    root,
    sourceDigest: digest,
    backupId: manifest.id,
    backupHash: hash,
    pm: manifest.pm,
    ledger: manifest.ledger,
    skippedSensitive: manifest.skippedSensitive,
    agents,
    createdAt: now,
  };
  const artifact = writeArtifact(root, TAKEOVER_PREPARED_FILE, record);
  ensureDisabledPolicy(store, authorization, hostCapability, now);
  const appended = store.appendTransaction({
    authorizationId: authorization.authorizationId,
    sourceDigest: digest,
    backupHash: hash,
    backupId: manifest.id,
    phase: 'prepared',
    evidenceHash: sha256Hex(canonicalJson(record)),
    now,
  });
  return {
    root,
    store,
    authorization,
    sources,
    digest,
    now,
    hostCapability,
    runtime,
    txId: appended.txId,
    backupId: manifest.id,
    backupHash: hash,
    entries: [appended.entry],
    artifacts: [displayPath(root, artifact)],
    lastCreated: appended.created,
  };
}

async function migratePhase(ctx: TxContext): Promise<PhaseOutcome> {
  const result = await ctx.runtime.migrateProject(ctx.root, {
    expectedSourceDigest: ctx.digest,
    actor: 'ano-takeover',
    sources: [...ctx.sources],
  });
  const summary = readMigrationSummary(ctx.root);
  if (summary === undefined) throw new TakeoverError('migration did not record a migration summary');
  if (String(summary.source_sha256) !== ctx.digest) {
    throw new TakeoverError('migration summary is bound to a different source digest');
  }
  const record: TakeoverMigrationRecord = {
    schema: TAKEOVER_MIGRATION_SCHEMA,
    txId: ctx.txId,
    authorizationId: ctx.authorization.authorizationId,
    root: ctx.root,
    sourceDigest: ctx.digest,
    summary,
    result: result as unknown as Record<string, unknown>,
  };
  const artifact = writeArtifact(ctx.root, TAKEOVER_MIGRATION_FILE, record);
  return {
    evidenceHash: sha256Hex(canonicalJson(summary)),
    artifacts: [displayPath(ctx.root, artifact)],
  };
}

async function reconcilePhase(ctx: TxContext): Promise<PhaseOutcome> {
  const report = ctx.runtime.reconcileMigration(ctx.root, { sources: [...ctx.sources] });
  const missing = Array.isArray(report.missing) ? report.missing : [];
  const conflicts = Array.isArray(report.conflicts) ? report.conflicts : [];
  if (report.sourceUnchanged !== true) {
    throw new TakeoverError('source changed since migration; reconciliation stopped');
  }
  if (missing.length > 0) {
    throw new TakeoverError(`reconciliation found ${missing.length} missing source task(s)`);
  }
  if (conflicts.length > 0) {
    throw new TakeoverError(`reconciliation found ${conflicts.length} conflicting task(s)`);
  }
  const record: TakeoverReconcileRecord = {
    schema: TAKEOVER_RECONCILE_SCHEMA,
    txId: ctx.txId,
    authorizationId: ctx.authorization.authorizationId,
    root: ctx.root,
    sourceDigest: ctx.digest,
    report,
  };
  const artifact = writeArtifact(ctx.root, TAKEOVER_RECONCILE_FILE, record);
  return {
    evidenceHash: sha256Hex(canonicalJson(report)),
    artifacts: [displayPath(ctx.root, artifact)],
  };
}

async function verifyPhase(ctx: TxContext): Promise<PhaseOutcome> {
  const prepared = requireBinding(readArtifact<TakeoverPreparedRecord>(ctx.root, TAKEOVER_PREPARED_FILE), ctx, TAKEOVER_PREPARED_FILE);
  const migration = requireBinding(readArtifact<TakeoverMigrationRecord>(ctx.root, TAKEOVER_MIGRATION_FILE), ctx, TAKEOVER_MIGRATION_FILE);
  const reconcile = requireBinding(readArtifact<TakeoverReconcileRecord>(ctx.root, TAKEOVER_RECONCILE_FILE), ctx, TAKEOVER_RECONCILE_FILE);

  // Recovery drill: replay-verify the immutable backup. No real rollback.
  const backup = await ctx.runtime.verifyBackup(ctx.root, ctx.backupId);
  const agents = readAgentsOriginal(ctx.root);
  if (prepared.agents.sha256 !== agents.sha256 || prepared.agents.bytes !== agents.bytes) {
    throw new TakeoverError('AGENTS.md changed after prepare; recovery drill refused');
  }
  const missing = Array.isArray(reconcile.report.missing) ? reconcile.report.missing : [];
  const conflicts = Array.isArray(reconcile.report.conflicts) ? reconcile.report.conflicts : [];
  const migrationBound = String(migration.summary.source_sha256) === ctx.digest;
  const reconcileOk = reconcile.report.sourceUnchanged === true && missing.length === 0 && conflicts.length === 0;

  const evidence: TakeoverEvidenceEntry[] = [
    {
      kind: 'backup',
      ok: backup.ok,
      detail: {
        id: ctx.backupId,
        hash: ctx.backupHash,
        pmFiles: backup.pm,
        ledgerFiles: backup.ledger,
        errors: backup.errors,
      },
    },
    {
      kind: 'migration',
      ok: migrationBound,
      detail: { sourceDigest: ctx.digest, summaryHash: sha256Hex(canonicalJson(migration.summary)) },
    },
    {
      kind: 'reconcile',
      ok: reconcileOk,
      detail: { sourceUnchanged: reconcile.report.sourceUnchanged ?? null, missing, conflicts },
    },
    {
      kind: 'authorization',
      ok: true,
      detail: {
        authorizationId: ctx.authorization.authorizationId,
        root: ctx.authorization.root,
        scope: ctx.authorization.scope,
        grantedBy: ctx.authorization.grantedBy,
        statementHash: sha256Hex(ctx.authorization.statement),
      },
    },
    { kind: 'agentsOriginal', ok: true, detail: agents },
    {
      kind: 'hostCapability',
      ok: true,
      detail: { capability: ctx.hostCapability, reasons: [...TAKEOVER_HOST_CAPABILITY_REASONS] },
    },
    { kind: 'baselineDigest', ok: true, detail: { digest: ctx.digest } },
  ];
  if (evidence.some((entry) => !entry.ok)) {
    throw new TakeoverError('verification evidence is incomplete or failed');
  }
  const evidenceHash = sha256Hex(canonicalJson(evidence));
  const record: TakeoverVerificationRecord = {
    schema: TAKEOVER_VERIFICATION_SCHEMA,
    txId: ctx.txId,
    authorizationId: ctx.authorization.authorizationId,
    root: ctx.root,
    sourceDigest: ctx.digest,
    baselineDigest: ctx.digest,
    backupId: ctx.backupId,
    backupHash: ctx.backupHash,
    evidence,
    evidenceHash,
    hostCapability: ctx.hostCapability,
    hostCapabilityReasons: [...TAKEOVER_HOST_CAPABILITY_REASONS],
    verifiedAt: ctx.now,
  };
  const artifact = writeArtifact(ctx.root, TAKEOVER_VERIFICATION_FILE, record);
  return { evidenceHash, artifacts: [displayPath(ctx.root, artifact)] };
}

async function installPhase(ctx: TxContext): Promise<PhaseOutcome> {
  const verification = requireBinding(readArtifact<TakeoverVerificationRecord>(ctx.root, TAKEOVER_VERIFICATION_FILE), ctx, TAKEOVER_VERIFICATION_FILE);
  if (verification.evidence.some((entry) => !entry.ok)) {
    throw new TakeoverError('verification evidence is not satisfactory');
  }
  const prepared = requireBinding(readArtifact<TakeoverPreparedRecord>(ctx.root, TAKEOVER_PREPARED_FILE), ctx, TAKEOVER_PREPARED_FILE);
  // The managed section is installed before the switch, so it honestly
  // declares the still-disabled policy state. `active` flips it to enforced.
  const managed = ctx.runtime.installManagedInstructions(
    ctx.root,
    renderDefaultManagedInstructions('disabled'),
    { confirm: ctx.authorization },
  );
  const record: TakeoverInstalledRecord = {
    schema: TAKEOVER_INSTALLED_SCHEMA,
    txId: ctx.txId,
    authorizationId: ctx.authorization.authorizationId,
    root: ctx.root,
    sourceDigest: ctx.digest,
    policyState: 'disabled',
    baselineDigest: verification.baselineDigest,
    managed,
    agentsOriginal: prepared.agents,
    installedAt: ctx.now,
  };
  const artifact = writeArtifact(ctx.root, TAKEOVER_INSTALLED_FILE, record);
  return {
    evidenceHash: sha256Hex(canonicalJson(record)),
    artifacts: [displayPath(ctx.root, artifact)],
  };
}

async function activePhase(ctx: TxContext): Promise<PhaseOutcome> {
  const installed = requireBinding(readArtifact<TakeoverInstalledRecord>(ctx.root, TAKEOVER_INSTALLED_FILE), ctx, TAKEOVER_INSTALLED_FILE);
  // Reversible managed-section flip first; the policy transition is the
  // authoritative main-write switch and is rolled back to `disabled` if it fails.
  const managed = ctx.runtime.updateManagedInstructions(
    ctx.root,
    renderDefaultManagedInstructions('enforced'),
    { confirm: ctx.authorization },
  );
  let policy: TakeoverPolicy;
  const current = ctx.store.loadPolicy();
  if (current !== null && current.state === 'enforced') {
    // Crash window: the policy switched before the active record was appended.
    // The policy is authoritative, so replay the active evidence without a
    // second transition.
    policy = current;
  } else {
    try {
      policy = ctx.store.transition({
        from: 'disabled',
        to: 'enforced',
        baselineDigest: ctx.digest,
        hostCapability: ctx.hostCapability,
        now: ctx.now,
      });
    } catch (error) {
      try {
        ctx.runtime.updateManagedInstructions(
          ctx.root,
          renderDefaultManagedInstructions('disabled'),
          { confirm: ctx.authorization },
        );
      } catch {
        // Preserve the original transition failure; the section is reversible.
      }
      throw error;
    }
  }
  const record = {
    txId: ctx.txId,
    authorizationId: ctx.authorization.authorizationId,
    root: ctx.root,
    state: policy.state,
    enforcedAt: policy.enforcedAt,
    baselineDigest: ctx.digest,
    hostCapability: ctx.hostCapability,
    managed,
  };
  return { evidenceHash: sha256Hex(canonicalJson(record)), artifacts: [] };
}

type PhaseHandler = (ctx: TxContext) => Promise<PhaseOutcome>;

function handlerFor(phase: TakeoverPhase): PhaseHandler | null {
  switch (phase) {
    case 'migrated':
      return migratePhase;
    case 'reconciled':
      return reconcilePhase;
    case 'verified':
      return verifyPhase;
    case 'installed':
      return installPhase;
    case 'active':
      return activePhase;
    default:
      return null;
  }
}

async function appendAborted(ctx: TxContext, error: unknown): Promise<void> {
  try {
    ctx.store.appendTransaction({
      authorizationId: ctx.authorization.authorizationId,
      sourceDigest: ctx.digest,
      backupHash: ctx.backupHash,
      backupId: ctx.backupId,
      phase: 'aborted',
      error: errorMessage(error).slice(0, 2000),
      now: ctx.now,
    });
  } catch {
    // The journal may already be unavailable; the original failure is authoritative.
  }
}

async function runPhase(ctx: TxContext, phase: TakeoverPhase, handler: PhaseHandler): Promise<TxContext> {
  try {
    await assertSourceUnchanged(ctx);
    const outcome = await handler(ctx);
    const appended = ctx.store.appendTransaction({
      authorizationId: ctx.authorization.authorizationId,
      sourceDigest: ctx.digest,
      backupHash: ctx.backupHash,
      backupId: ctx.backupId,
      phase,
      evidenceHash: outcome.evidenceHash,
      now: ctx.now,
    });
    return {
      ...ctx,
      entries: [...ctx.entries, appended.entry],
      artifacts: [...ctx.artifacts, ...outcome.artifacts],
      lastCreated: appended.created,
    };
  } catch (error) {
    // `active` may already have flipped the policy; appending `aborted` there
    // would make the journal terminal and hide the authoritative state.
    if (phase !== 'active') await appendAborted(ctx, error);
    throw new TakeoverPhaseError(phase, error);
  }
}

function buildResult(
  ctx: TxContext,
  resumed: boolean,
  failedPhase: TakeoverPhase | null,
  error: string | null,
): TakeoverRunResult {
  const entries = ctx.store.readTransactions(ctx.txId);
  const last = entries.at(-1);
  const policy = ctx.store.loadPolicy();
  return {
    schema: TAKEOVER_RUN_SCHEMA,
    root: ctx.root,
    authorizationId: ctx.authorization.authorizationId,
    txId: ctx.txId,
    phase: last?.phase ?? 'prepared',
    state: policy?.state ?? 'disabled',
    sourceDigest: ctx.digest,
    backupId: ctx.backupId,
    backupHash: ctx.backupHash,
    evidenceHash: last?.evidenceHash ?? null,
    created: ctx.lastCreated,
    resumed,
    active: last?.phase === 'active',
    aborted: last?.phase === 'aborted',
    failedPhase,
    error,
    phases: entries.map((entry) => ({
      phase: entry.phase,
      txId: entry.txId,
      evidenceHash: entry.evidenceHash,
      at: entry.updatedAt,
    })),
    artifacts: ctx.artifacts,
  };
}

async function executeTakeover(
  root: string,
  store: TakeoverStore,
  authorization: TakeoverAuthorization,
  input: TakeoverRunOptions,
  sources: readonly string[],
  digest: string,
  runtime: ResolvedRuntime,
): Promise<TakeoverRunResult> {
  const now = input.now ?? new Date().toISOString();
  const hostCapability = input.hostCapability ?? 'degraded';
  let ctx: TxContext | null = null;
  let resumed = false;

  try {
    const policy = store.loadPolicy();
    const target = selectResumeTarget(store, authorization.authorizationId, digest);

    if (policy?.state === 'enforced') {
      if (target === null) {
        throw new TakeoverError('project is already enforced under a different source digest; disable/recover first');
      }
      const last = lastEntry(target);
      if (last?.phase === 'active') {
        return buildResult(
          contextFromEntries(root, store, authorization, sources, digest, now, hostCapability, runtime, target.entries, [], false),
          true,
          null,
          null,
        );
      }
      if (last?.phase !== 'installed') {
        throw new TakeoverError(`project is already enforced but the transaction is at ${last?.phase ?? 'none'}; refusing to continue`);
      }
      // Crash window: the policy switched before the active record appended.
    }

    if (target !== null) {
      if (policy === null) {
        throw new TakeoverError('takeover journal exists without a policy document; failing closed');
      }
      ctx = contextFromEntries(root, store, authorization, sources, digest, now, hostCapability, runtime, target.entries, [], false);
      resumed = true;
    } else {
      ctx = await preparePhase(root, store, authorization, sources, digest, now, hostCapability, runtime);
    }

    if (input.stopAfterPhase !== undefined && ctx.entries.at(-1)?.phase === input.stopAfterPhase) {
      return buildResult(ctx, resumed, null, null);
    }

    for (const phase of TAKEOVER_ACTIVE_PHASES) {
      if (phase === 'prepared') continue;
      const handler = handlerFor(phase);
      if (handler === null) continue;
      const current = ctx.entries.at(-1);
      if (current === undefined) throw new TakeoverError('takeover transaction has no journal records');
      const currentIndex = phaseIndex(current.phase);
      const nextIndex = phaseIndex(phase);
      if (nextIndex <= currentIndex) continue;
      if (nextIndex !== currentIndex + 1) {
        throw new TakeoverError(`cannot advance takeover from ${current.phase} to ${phase}`);
      }
      ctx = await runPhase(ctx, phase, handler);
      if (input.stopAfterPhase === phase) {
        return buildResult(ctx, resumed, null, null);
      }
    }
    return buildResult(ctx, resumed, null, null);
  } catch (error) {
    if (ctx !== null && error instanceof TakeoverPhaseError) {
      return buildResult(ctx, resumed, error.phase, errorMessage(error));
    }
    throw error;
  }
}

// ---- public API ---------------------------------------------------------

/**
 * Run the six-phase enforced-takeover transaction. Idempotent: the same
 * `(authorizationId, sourceDigest, backupHash)` replays the stored journal
 * without new backups or new main-write effects. Requires explicit `confirm`.
 */
export async function runTakeover(rootInput: string, input: TakeoverRunOptions): Promise<TakeoverRunResult> {
  if (input.confirm !== true) {
    throw new TakeoverError('explicit confirm is required; takeover never infers authorization');
  }
  if (input.stopAfterPhase !== undefined && !(TAKEOVER_ACTIVE_PHASES as readonly string[]).includes(input.stopAfterPhase)) {
    throw new TakeoverError(`stopAfterPhase must be one of ${TAKEOVER_ACTIVE_PHASES.join(', ')}`);
  }
  const { root, resolution } = await resolveTakeoverRoot(rootInput);
  const store = new TakeoverStore(root);
  const authorization = store.loadAuthorization();
  if (authorization === null) {
    throw new TakeoverError('no takeover authorization exists; run `takeover grant` first');
  }
  if (authorization.authorizationId !== input.authorizationId) {
    throw new TakeoverError('authorizationId does not match the stored authorization');
  }
  assertRootBinding(authorization, root);
  if (authorization.revokedAt !== null) {
    throw new TakeoverError('takeover authorization has been revoked');
  }
  const authorizationScopes = authorization.scope as readonly string[];
  for (const required of MANAGED_INSTRUCTIONS_REQUIRED_SCOPES) {
    if (!authorizationScopes.includes(required)) {
      throw new TakeoverError(`authorization scope does not include ${required}; managed instructions cannot be installed`);
    }
  }
  const sources = input.sources ?? [...DEFAULT_MIGRATION_SOURCES];
  const digest = computeTakeoverSourceDigest(root, sources);
  const runtime = resolveRuntime(input.runtime);
  const policy = store.loadPolicy();
  if (
    policy !== null
    && policy.authorization.authorizationId !== authorization.authorizationId
    && policy.state !== 'disabled'
  ) {
    throw new TakeoverError('stored takeover policy belongs to a different authorization');
  }
  if (policy?.state === 'recovery') {
    throw new TakeoverError('takeover is in recovery; run `takeover recover` before a new takeover');
  }

  const outcome = await withFileLock(
    safeChild(takeoverDir(root), 'orchestration.lock'),
    () => executeTakeover(root, store, authorization, input, sources, digest, runtime),
    // A dead owner's lease is reclaimed quickly so crash re-entry is not blocked
    // for a minute; a live owner is never stolen (see core/lock.ts).
    { timeoutMs: 10_000, staleAfterMs: 1_000 },
  );
  return {
    ...outcome,
    rootResolution: { inputRoot: resolution.inputRoot, gitRoot: resolution.gitRoot, pmRoot: resolution.pmRoot, sourceRoots: resolution.sourceRoots },
    ignoredPmRoots: resolution.ignoredPmRoots,
  };
}

/** Read-only combined view for `takeover status` and crash recovery. */
export function takeoverStatus(rootInput: string): TakeoverStatus {
  const root = resolveMigrationPmRoot(resolveRoot(rootInput));
  const store = new TakeoverStore(root);
  const state = store.loadState();
  const policy = store.loadPolicy();
  const authorization = store.loadAuthorization();
  const entries = store.readTransactions();
  const directory = takeoverDir(root);
  const artifacts = existsSync(directory)
    ? readdirSync(directory).filter((name) => name.endsWith('.json')).sort()
    : [];
  return {
    schema: TAKEOVER_STATUS_SCHEMA,
    root,
    state: state.state,
    policy,
    authorization,
    transaction: entries.at(-1) ?? null,
    transactions: entries.length,
    hostCapability: policy?.hostCapability ?? null,
    baselineDigest: policy?.baselineDigest ?? null,
    enforcedAt: policy?.enforcedAt ?? null,
    artifacts,
  };
}
