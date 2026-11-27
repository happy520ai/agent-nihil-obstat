import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyClientHooks,
  planClientHooks,
  type ClientHooksDocument,
  type ClientHooksTarget,
} from './config.ts';
import { canonicalJson, sha256Hex, stableJson } from '../connect/canonical.ts';
import type { ClientAccessPlan, ClientAccessRoute } from './capabilities.ts';
import {
  CLIENT_CONFIG_INSTALL_SCHEMA,
  applyClientConfig,
  atomicWriteFile,
  checkClientConfigAuthorization,
  planClientConfig,
  resolveClientConfigRoot,
  restoreClientConfig as restoreClientConfigBase,
  restoreFromBackup,
  type ClientConfigAuthorization,
  type ClientConfigFormat,
  type ClientConfigHooks,
  type ClientConfigIo,
  type ClientConfigResult,
  type ClientConfigScope,
  type ClientConfigTarget,
  type ClientConfigChange,
} from './config.ts';

/**
 * Client configuration install orchestration (ADR-007 §5.4, M11/T-081).
 *
 * Transaction sequence: plan -> authorize -> backup -> drift check -> atomic
 * write -> verify -> commit (install record). Any step that fails after the
 * backup rolls the target config back to `beforeHash`. Repeat installs are
 * zero-byte no-ops; a commit failure also rolls back so a failed install never
 * leaves a configured file without a committed record.
 *
 * Default is dry-run: without `mode:'apply'`, `confirm:true` and a valid
 * authorization, nothing is written.
 */

export interface ClientInstallOptions {
  readonly mode?: 'dry-run' | 'apply';
  readonly confirm?: boolean;
  readonly authorization?: ClientConfigAuthorization;
  /** Install always backs up; the flag is accepted for signature parity. */
  readonly backup?: boolean;
  /** Canonical project root owning `.ano/clients/`. Required for apply. */
  readonly root?: string;
  readonly backupId?: string;
  readonly now?: string;
  readonly io?: ClientConfigIo;
  readonly hooks?: ClientConfigHooks;
}

export type ClientInstallAction = 'dry-run' | 'refused' | 'installed' | 'updated' | 'removed' | 'unchanged' | 'failed';

export interface ClientInstallResult {
  readonly clientId: string;
  readonly targetPath: string;
  readonly mode: 'dry-run' | 'apply';
  readonly applied: boolean;
  readonly action: ClientInstallAction;
  readonly changed: boolean;
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
  readonly backupId: string | null;
  readonly backupHash: string | null;
  readonly changes: readonly ClientConfigChange[];
  readonly warnings: readonly string[];
  readonly restoredOnFailure: boolean;
  readonly error: string | null;
  readonly installRecordId: string | null;
  readonly installRecordCreated: boolean;
}

export interface ClientInstallRecord {
  readonly schema: typeof CLIENT_CONFIG_INSTALL_SCHEMA;
  readonly id: string;
  readonly clientId: string;
  readonly root: string;
  readonly targetPath: string;
  readonly scope: ClientConfigScope;
  readonly format: ClientConfigFormat;
  readonly serverPath: readonly string[];
  readonly serverName: string;
  readonly operation: 'install' | 'remove';
  readonly authorizationId: string;
  readonly backupId: string | null;
  readonly backupHash: string | null;
  readonly beforeHash: string;
  readonly afterHash: string;
  readonly changed: boolean;
  readonly installedAt: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function installRecordPath(root: string, clientId: string): string {
  return join(root, '.ano', 'clients', 'installs', `${clientId}.json`);
}

export function readInstallRecord(root: string, clientId: string): ClientInstallRecord | null {
  const path = installRecordPath(resolveClientConfigRoot(root), clientId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ClientInstallRecord;
  } catch {
    return null;
  }
}

/**
 * Commit the install record. The id is derived from the applied state, so a
 * repeated install with the same target and `afterHash` replays the existing
 * record instead of writing again.
 */
export function writeInstallRecord(
  root: string,
  target: ClientConfigTarget,
  entry: Record<string, unknown> | null,
  applied: ClientConfigResult,
  authorization: ClientConfigAuthorization,
  now?: string,
): { record: ClientInstallRecord; created: boolean } {
  const projectRoot = resolveClientConfigRoot(root);
  const afterHash = applied.afterHash ?? sha256Hex(canonicalJson({ target: target.path, entry }));
  const id = sha256Hex(canonicalJson({
    schema: CLIENT_CONFIG_INSTALL_SCHEMA,
    clientId: target.clientId,
    targetPath: resolve(target.path),
    serverPath: target.serverPath,
    serverName: target.serverName,
    afterHash,
  }));
  const existing = readInstallRecord(projectRoot, target.clientId);
  if (existing !== null && existing.id === id && existing.afterHash === afterHash) {
    return { record: existing, created: false };
  }
  const record: ClientInstallRecord = {
    schema: CLIENT_CONFIG_INSTALL_SCHEMA,
    id,
    clientId: target.clientId,
    root: projectRoot,
    targetPath: resolve(target.path),
    scope: target.scope,
    format: target.format,
    serverPath: target.serverPath,
    serverName: target.serverName,
    operation: entry === null ? 'remove' : 'install',
    authorizationId: authorization.authorizationId,
    backupId: applied.backupId,
    backupHash: applied.backupHash,
    beforeHash: applied.beforeHash ?? '',
    afterHash,
    changed: applied.changed,
    installedAt: now ?? new Date().toISOString(),
  };
  const path = installRecordPath(projectRoot, target.clientId);
  mkdirSync(join(projectRoot, '.ano', 'clients', 'installs'), { recursive: true });
  atomicWriteFile(path, Buffer.from(stableJson(record), 'utf8'));
  return { record, created: true };
}

function baseResult(target: ClientConfigTarget, plan: ReturnType<typeof planClientConfig>, options: ClientInstallOptions): ClientInstallResult {
  return {
    clientId: target.clientId,
    targetPath: resolve(target.path),
    mode: options.mode ?? 'dry-run',
    applied: false,
    action: options.mode === 'apply' ? 'refused' : 'dry-run',
    changed: plan.changed,
    beforeHash: plan.snapshot.beforeHash,
    afterHash: plan.afterHash,
    backupId: null,
    backupHash: null,
    changes: plan.changes,
    warnings: [...plan.warnings],
    restoredOnFailure: false,
    error: null,
    installRecordId: null,
    installRecordCreated: false,
  };
}

function runTransaction(
  target: ClientConfigTarget,
  entry: Record<string, unknown> | null,
  options: ClientInstallOptions,
  requiredScopes: readonly string[],
  remove: boolean,
): ClientInstallResult {
  const plan = planClientConfig(target, entry);
  const base = baseResult(target, plan, options);
  if (!plan.changed) {
    return {
      ...base,
      action: 'unchanged',
      warnings: [...base.warnings, remove ? 'ANO entry is already absent' : 'ANO entry already matches the desired configuration'],
    };
  }

  const root = options.root === undefined ? null : resolveClientConfigRoot(options.root);
  const auth = checkClientConfigAuthorization(options.authorization, root, target.clientId, requiredScopes);
  const authReason = auth.ok ? '' : auth.reason;
  if ((options.mode ?? 'dry-run') !== 'apply' || options.confirm !== true || root === null || !auth.ok) {
    const reason = root === null ? 'project root is required for an authorized write' : authReason;
    return {
      ...base,
      action: (options.mode ?? 'dry-run') === 'apply' ? 'refused' : 'dry-run',
      warnings: [...base.warnings, `install refused (${reason}); dry-run only`],
    };
  }
  const projectRoot = root;

  let applied: ClientConfigResult;
  try {
    applied = applyClientConfig(target, entry, {
      mode: 'apply',
      confirm: true,
      authorization: auth.authorization,
      backup: true,
      root: projectRoot,
      ...(options.backupId === undefined ? {} : { backupId: options.backupId }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.io === undefined ? {} : { io: options.io }),
      ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
    });
  } catch (error) {
    // Pre-write failures (drift, backup, format) happen before any byte is
    // replaced, so there is nothing to roll back.
    return {
      ...base,
      mode: 'apply',
      action: 'failed',
      warnings: [...base.warnings, `install failed: ${errorMessage(error)}`],
      error: errorMessage(error),
    };
  }
  if (!applied.applied) {
    return {
      ...base,
      mode: 'apply',
      action: applied.refused ? 'refused' : 'failed',
      beforeHash: applied.beforeHash,
      afterHash: applied.afterHash,
      backupId: applied.backupId,
      backupHash: applied.backupHash,
      warnings: [...base.warnings, ...applied.warnings],
      restoredOnFailure: applied.restoredOnFailure,
      error: applied.error,
    };
  }

  try {
    const { record, created } = writeInstallRecord(projectRoot, target, entry, applied, auth.authorization, options.now);
    const kind = applied.changes[0]?.kind;
    const action: ClientInstallAction = remove ? 'removed' : kind === 'add-server' ? 'installed' : 'updated';
    return {
      ...base,
      mode: 'apply',
      applied: true,
      action,
      beforeHash: applied.beforeHash,
      afterHash: applied.afterHash,
      backupId: applied.backupId,
      backupHash: applied.backupHash,
      warnings: [...base.warnings, ...applied.warnings],
      installRecordId: record.id,
      installRecordCreated: created,
    };
  } catch (error) {
    // The config write succeeded but the transaction never committed: roll the
    // config back to the verified backup so state and record stay consistent.
    let restored = false;
    if (applied.backupId !== null) {
      try {
        restoreFromBackup(projectRoot, target, applied.backupId, options.io);
        restored = true;
      } catch {
        restored = false;
      }
    }
    return {
      ...base,
      mode: 'apply',
      action: 'failed',
      beforeHash: applied.beforeHash,
      afterHash: applied.afterHash,
      backupId: applied.backupId,
      backupHash: applied.backupHash,
      warnings: [...base.warnings, ...applied.warnings],
      restoredOnFailure: restored,
      error: errorMessage(error),
    };
  }
}

/**
 * Idempotently install the ANO MCP entry into a client config. Repeat calls
 * with the same desired entry are zero-byte no-ops (`action:'unchanged'`).
 */
export function installClientConfig(
  target: ClientConfigTarget,
  entry: Record<string, unknown>,
  options: ClientInstallOptions = {},
): ClientInstallResult {
  return runTransaction(target, entry, options, ['config', 'install'], false);
}

/** Remove only the ANO entry, preserving other MCP services and unknown fields. */
export function uninstallClientConfig(
  target: ClientConfigTarget,
  options: ClientInstallOptions = {},
): ClientInstallResult {
  return runTransaction(target, null, options, ['config'], true);
}

/**
 * Authorized restore from a verified backup. Delegates the write to
 * `config.ts`; the backup is verified before any byte is replaced.
 */
export function restoreClientConfig(
  target: ClientConfigTarget,
  options: ClientInstallOptions & { readonly backupId?: string } = {},
): ClientConfigResult {
  return restoreClientConfigBase(target, options);
}

// ---------------------------------------------------------------------------
// Batch authorized install (T-098 / CX-08)
// ---------------------------------------------------------------------------

/**
 * Batch options extend the single-target transaction with a per-client
 * authorization map. A real write still requires `mode:'apply'`, `confirm:true`
 * and an authorization bound to the same root and clientId; a missing entry is
 * refused with zero bytes written.
 */
export interface ClientBatchInstallOptions extends ClientInstallOptions {
  readonly authorizations?: Readonly<Record<string, ClientConfigAuthorization>>;
}

export interface ClientBatchSkipped {
  readonly clientId: string;
  readonly route: ClientAccessRoute;
  readonly reason: string;
}

export interface ClientBatchInstallSummary {
  readonly total: number;
  readonly installed: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly refused: number;
  readonly failed: number;
  readonly dryRun: number;
  readonly skipped: number;
}

export interface ClientBatchInstallResult {
  readonly mode: 'dry-run' | 'apply';
  readonly results: readonly ClientInstallResult[];
  readonly skipped: readonly ClientBatchSkipped[];
  readonly summary: ClientBatchInstallSummary;
  readonly warnings: readonly string[];
}

/** ANO package root, mirroring the frozen adapters' entry construction. */
const CLIENT_PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * The desired MCP entry declared by each writable adapter. Mirrors the frozen
 * adapters' `desiredEntry` (T-082/T-083) and the M11 CLI table; kept here so the
 * batch path can reuse the idempotent install transaction.
 */
function desiredEntryFor(clientId: string, root: string): Record<string, unknown> | null {
  const packageEntry = join(CLIENT_PACKAGE_ROOT, 'dist', 'surface', 'mcp.js');
  switch (clientId) {
    case 'claude-code':
    case 'codex':
      return { command: process.execPath, args: [join(root, 'dist', 'surface', 'mcp.js')] };
    case 'kilo-code':
      return { type: 'local', command: [process.execPath, packageEntry], enabled: true };
    case 'opencode':
      return { type: 'local', command: ['node', packageEntry] };
    case 'zed':
      return { command: 'node', args: [packageEntry], env: {} };
    case 'cursor':
    case 'github-copilot':
    case 'codebuddy':
    case 'trae':
    case 'antigravity':
      return { command: 'node', args: [packageEntry] };
    case 'cline':
    case 'amazon-q':
    case 'comate':
    case 'tongyi-lingma':
      return { command: process.execPath, args: [packageEntry] };
    default:
      return null;
  }
}

function failedBatchResult(
  plan: ClientAccessPlan,
  target: ClientConfigTarget,
  mode: 'dry-run' | 'apply',
  error: unknown,
): ClientInstallResult {
  return {
    clientId: plan.clientId,
    targetPath: target.path,
    mode,
    applied: false,
    action: 'failed',
    changed: false,
    beforeHash: null,
    afterHash: null,
    backupId: null,
    backupHash: null,
    changes: [],
    warnings: [`batch install failed: ${errorMessage(error)}`],
    restoredOnFailure: false,
    error: errorMessage(error),
    installRecordId: null,
    installRecordCreated: false,
  };
}

/**
 * Install every `mcp`-route plan in one batch. Clients whose route is not
 * `mcp` (rules/CLI/explicit-workflow/skip) are skipped with an explicit reason
 * and never receive an invalid config. Each client is a separate transaction:
 * one failure is isolated and does not abort the rest. Default is dry-run.
 */
export function installClientBatch(
  plans: readonly ClientAccessPlan[],
  options: ClientBatchInstallOptions = {},
): ClientBatchInstallResult {
  const mode: 'dry-run' | 'apply' = options.mode ?? 'dry-run';
  const root = options.root === undefined ? null : resolve(options.root);
  const results: ClientInstallResult[] = [];
  const skipped: ClientBatchSkipped[] = [];
  const warnings: string[] = [];

  for (const plan of plans) {
    if (plan.route !== 'mcp' || plan.target === null) {
      skipped.push({
        clientId: plan.clientId,
        route: plan.route,
        reason: plan.reason ?? `route ${plan.route} does not write an MCP config; skipped without generating a config`,
      });
      continue;
    }

    const target: ClientConfigTarget = {
      clientId: plan.clientId,
      scope: plan.target.scope,
      path: plan.target.path,
      format: plan.target.format,
      serverPath: [...plan.target.serverPath],
      serverName: plan.target.serverName,
      allowedRoot: plan.target.allowedRoot,
    };
    const entryRoot = root ?? plan.target.allowedRoot;
    const entry = desiredEntryFor(plan.clientId, entryRoot);
    if (entry === null) {
      skipped.push({
        clientId: plan.clientId,
        route: plan.route,
        reason: 'no declared ANO entry for this client; skipped without generating a config',
      });
      continue;
    }

    const authorization = options.authorizations?.[plan.clientId] ?? options.authorization;
    try {
      results.push(installClientConfig(target, entry, {
        ...options,
        ...(authorization === undefined ? {} : { authorization }),
      }));
    } catch (error) {
      results.push(failedBatchResult(plan, target, mode, error));
      warnings.push(`${plan.clientId}: ${errorMessage(error)}`);
    }
  }

  const summary: ClientBatchInstallSummary = {
    total: plans.length,
    installed: results.filter((result) => result.action === 'installed').length,
    updated: results.filter((result) => result.action === 'updated').length,
    unchanged: results.filter((result) => result.action === 'unchanged').length,
    refused: results.filter((result) => result.action === 'refused').length,
    failed: results.filter((result) => result.action === 'failed').length,
    dryRun: results.filter((result) => result.action === 'dry-run').length,
    skipped: skipped.length,
  };

  return { mode, results, skipped, summary, warnings };
}

// ---------------------------------------------------------------------------
// --with-hooks: authorized, recoverable hooks-section install (T-166)
// ---------------------------------------------------------------------------

/** Host events ANO installs hooks for; exactly the four S8/公开文档 events. */
export const HOOK_INSTALL_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop'] as const;
export type HookInstallEvent = (typeof HOOK_INSTALL_EVENTS)[number];

/** Clients whose hook config path is S8-confirmed writable (hooks segment only). */
export const HOOK_INSTALL_CLIENTS = ['zcode', 'claude-code'] as const;
export type HookInstallClient = (typeof HOOK_INSTALL_CLIENTS)[number];

/** Per-event hard timeout in ms, mirrored from the CLI (ADR-013 §2 第 9 条). */
const HOOK_INSTALL_TIMEOUT_MS: Readonly<Record<HookInstallEvent, number>> = {
  SessionStart: 5000,
  UserPromptSubmit: 1500,
  PreToolUse: 1500,
  Stop: 10000,
};

/**
 * Build the hook process argv. The command is a fixed absolute node path, an
 * absolute dist/surface/cli.js and fixed event/client/root arguments. NO value
 * derived from stdin, prompt, tool input or any other external input is ever
 * concatenated into this array (ADR-013 §2.4 / 实施规格 T-166).
 */
export function buildHookCommand(
  client: HookInstallClient,
  event: HookInstallEvent,
  root: string,
): { readonly command: string; readonly args: readonly string[] } {
  const node = process.execPath;
  const cli = join(CLIENT_PACKAGE_ROOT, 'dist', 'surface', 'cli.js');
  const absRoot = resolve(root);
  const uniqueEvent: Readonly<Record<HookInstallEvent, string>> = {
    SessionStart: 'session-start',
    UserPromptSubmit: 'prompt',
    PreToolUse: 'pre-tool',
    Stop: 'stop',
  };
  return {
    command: node,
    args: [cli, 'hook', uniqueEvent[event], '--client', client, '--root', absRoot, '--project-scoped'],
  };
}

/** S8/公开文档确认的键：只有 enabled / timeoutMs / maxOutputBytes / events.*.hooks。 */
export function buildHooksDocument(
  client: HookInstallClient,
  root: string,
): ClientHooksDocument {
  const events: Record<string, readonly { readonly hooks: readonly {
    readonly type: 'process'; readonly command: string; readonly args: readonly string[]; readonly timeoutMs: number;
  }[] }[]> = {};
  for (const event of HOOK_INSTALL_EVENTS) {
    const { command, args } = buildHookCommand(client, event, root);
    events[event] = [{ hooks: [{ type: 'process', command, args, timeoutMs: HOOK_INSTALL_TIMEOUT_MS[event] }] }];
  }
  return { enabled: true, events };
}

/**
 * Resolve the hooks config target. ZCode's user config is S8-confirmed
 * effective; Claude Code uses the documented user settings path. No path is
 * derived from untrusted input except the explicitly authorized --config-path
 * override validated below.
 */
export function resolveHooksTarget(
  client: HookInstallClient,
  options: { readonly home: string; readonly root: string; readonly path?: string },
): ClientHooksTarget {
  const allowedRoot = resolve(options.home);
  const explicit = options.path === undefined ? undefined : resolve(options.path);
  const path = explicit ?? (client === 'zcode'
    ? join(allowedRoot, '.zcode', 'cli', 'config.json')
    : join(allowedRoot, '.claude', 'settings.json'));
  return { clientId: client, scope: 'user', path, allowedRoot };
}

export interface ClientHooksInstallResult {
  readonly clientId: string;
  readonly targetPath: string;
  readonly mode: 'dry-run' | 'apply';
  readonly applied: boolean;
  readonly changed: boolean;
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
  readonly backupId: string | null;
  readonly warnings: readonly string[];
  readonly restoredOnFailure: boolean;
  readonly error: string | null;
}

function hooksResultFrom(result: ClientConfigResult): ClientHooksInstallResult {
  return {
    clientId: result.target.clientId,
    targetPath: resolve(result.target.path),
    mode: result.mode,
    applied: result.applied,
    changed: result.changed,
    beforeHash: result.beforeHash,
    afterHash: result.afterHash,
    backupId: result.backupId,
    warnings: result.warnings,
    restoredOnFailure: result.restoredOnFailure,
    error: result.error,
  };
}

/**
 * Install the hooks section through the same authorized transaction as the MCP
 * path. Default is dry-run (zero write). `apply` requires confirm + a valid
 * authorization bound to root/clientId with config+install scopes.
 */
export function installClientHooks(
  target: ClientHooksTarget,
  hooks: ClientHooksDocument,
  options: ClientInstallOptions = {},
): ClientHooksInstallResult {
  let plan;
  try {
    plan = planClientHooks(target, hooks);
  } catch (error) {
    return {
      clientId: target.clientId,
      targetPath: resolve(target.path),
      mode: options.mode ?? 'dry-run',
      applied: false,
      changed: false,
      beforeHash: null,
      afterHash: null,
      backupId: null,
      warnings: [`hooks plan failed: ${errorMessage(error)}`],
      restoredOnFailure: false,
      error: errorMessage(error),
    };
  }
  const projectRoot = options.root === undefined ? null : resolveClientConfigRoot(options.root);
  try {
    return hooksResultFrom(applyClientHooks(target, hooks, {
      mode: options.mode ?? 'dry-run',
      confirm: options.confirm === true,
      ...(options.authorization === undefined ? {} : { authorization: options.authorization }),
      backup: true,
      ...(projectRoot === null ? {} : { root: projectRoot }),
      ...(options.backupId === undefined ? {} : { backupId: options.backupId }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.io === undefined ? {} : { io: options.io }),
      ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
    }));
  } catch (error) {
    return {
      clientId: target.clientId,
      targetPath: resolve(target.path),
      mode: options.mode ?? 'dry-run',
      applied: false,
      changed: plan.changed,
      beforeHash: plan.beforeHash,
      afterHash: plan.afterHash,
      backupId: null,
      warnings: [`hooks install failed: ${errorMessage(error)}`],
      restoredOnFailure: false,
      error: errorMessage(error),
    };
  }
}
