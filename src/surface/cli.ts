#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { auditSurface, brief, clientAccessPlanReport, clientDoctorReport, clientDoctorSingle, clientInstallSurface, clientRestoreSurface, createClientAuthorization, cutoverConfirmSurface, cutoverStatusSurface, defaultRoot, explore, migrateApplySurface, migrateBackupSurface, migrateBackupsSurface, migratePlanSurface, migrateReconcileSurface, migrateRestoreSurface, note, noteRelate, noteRevise, recall, recallProbe, rebuildGraph, releaseVerification, takeoverApply, takeoverDisable, takeoverGrant, takeoverRecover, takeoverRevoke, takeoverStatusSurface, trackTask, trackTaskUpdate, verifyContext, verifySurface, type ClientSurfaceEnvironment, type RecallProbeSurfaceInput } from './service.ts';
import { doctor } from './doctor.ts';
import { decidePreTool } from '../hooks/pre-tool.ts';
import { readConfig } from '../core/config.ts';
import { runSetup } from '../core/setup.ts';
import { onSessionStart, onStop } from '../hooks/session.ts';
import { GraphStore } from '../structure/store.ts';
import { Ledger } from '../ledger/ledger.ts';
import { existingProjectRoot } from './service.ts';
import { CAPABILITY_LAYERS, type ClientDescriptor, type ClientReport, type ConfigScope } from '../clients/types.ts';
import { CLIENT_CONFIG_SCOPES } from '../clients/config.ts';
import { getDescriptor, resolveClientId } from '../clients/registry.ts';
import {
  HOOK_EVENTS,
  HOOK_MODES,
  failClosedDecision,
  type HookDecision,
  type HookDegradedCode,
  type HookEvent,
  type HookInput,
  type HookMode,
} from '../hooks/contract.ts';
import { claudeCodeHookAdapter } from '../hooks/adapters/claude-code.ts';
import { zcodeHookAdapter, type HookAdapter, type HookRenderResult } from '../hooks/adapters/zcode.ts';
import type { DoctorReport } from '../clients/doctor.ts';
import type { ClientAccessPlanReport } from '../clients/capabilities.ts';
import type { ClientConfigResult } from '../clients/config.ts';
import {
  buildHooksDocument,
  installClientHooks,
  resolveHooksTarget,
  type HookInstallClient,
} from '../clients/install.ts';
import type { ClientInstallResult } from '../clients/install.ts';
import { exportProject } from './export.ts';
import { startUiServer } from './ui.ts';
import {
  connectProject,
  connectionStatus,
  exportConnection,
  handoffReadiness,
  planConnection,
  watchConnection,
  MIN_WATCH_INTERVAL_MS,
} from '../connect/index.ts';
import {
  approveBaseline,
  isInteractiveTty,
  listBaselines,
  saveBaselineDraft,
  verifyBaseline,
  BaselineError,
} from '../readiness/baseline.ts';

const help = `Agent Nihil Obstat (ANO) — P7 local alpha (P1 vertical slice preserved)

Usage:
  ano --help | --version
  ano setup --root <path> --client <zcode|claude-code> [--yes-dry-run]
  ano brief [--json] [--memory-context] [--context-budget <n>] [--root <path>]
  ano explore <symbol> [--root <path>]
  ano track create --id <task-id> [--title <text>] [--file <path>]...
  ano track <update|cancel|reopen> --id <task-id> [--status <todo|in_progress|cancelled>]
  ano track complete --id <task-id> --evidence-id <evidence-id>
  ano migrate [plan|apply|status|reconcile|backup|restore|list-backups] [--root <path>] [--expected-source-digest <sha256>] [--backup-id <id>] [--on-conflict skip]
  ano takeover grant --root <path> --scope <tasks|memory|acceptance|dag>[,...] --granted-by <name> --role <role> --statement <text> [--granted-at <iso>]
  ano takeover apply --root <path> --authorization-id <id> --confirm
  ano takeover status --root <path>
  ano takeover recover --root <path> --confirm
  ano takeover disable --root <path> --confirm
  ano takeover revoke --root <path> --confirm
  ano connect cutover [status|confirm] [--root <path>] [--name <human>] [--role <role>] [--statement <text>] [--source-digest <sha256>] [--backup-id <id>] --confirm
  ano verify <task-id> [--tier T0|T1] --test <path> [--test <path>]... -- <command> [args...]
  ano verify release --target <version> --profile <A-I> [--profile <A-I>]... --artifact <path>
  ano verify context --context-id <id> --project-scope <id> --draft <path.json>
  ano recall [--source connected --query <text> [--limit <n>]] [--session <id>] [--from <iso>] [--to <iso>] [--file <path>] [--symbol <name>] [--keyword <text>] [--provider <id>]
  ano recall --mode probe --project-scope <id> (--requirement <text>)... [--query <text>] [--temporal-mode CURRENT|AS_OF|HISTORICAL] [--as-of <iso>] [--budget <json>]
  ano note <decision|pitfall|memory|session_summary> --text <text> [--file <path>] [--symbol <id>] [--qualified-name <name>]
  ano note revise --fact-key <key> --kind <decision|pitfall|memory> --text <text> --supersedes <json> --reason <text> --effective-from <iso|null> --effective-to <iso|null> [--file <path>] [--symbol <id>] [--qualified-name <name>]
  ano note relate --edge <depends_on|explains|related_to> --from-ref <id> --to-ref <id> [--reason <text>]
  ano audit <drift|security|license|governance|deps> [--online --confirm] [--root <path>]
  ano doctor [--root <path>]
  ano doctor clients [--json] [--plan] [--all] [--root <path>] [--home <path>] [--env KEY=VALUE] [--probe-path <dir>] [--timeout-ms <ms>]
  ano doctor client <id> [--json] [--root <path>] [--home <path>] [--env KEY=VALUE] [--probe-path <dir>] [--timeout-ms <ms>]
  ano clients plan [--json] [--root <path>] [--home <path>] [--env KEY=VALUE] [--probe-path <dir>] [--timeout-ms <ms>]
  ano clients install <id> --granted-by <name> --statement <text> --scope <detect|inspect|config|install|restore>[,...] [--confirm] [--dry-run] [--with-hooks] [--config-scope <user|project|workspace>] [--config-path <path>] [--home <path>] [--role <role>] [--granted-at <iso>] [--json]
  ano clients restore <id> --backup-id <id> --granted-by <name> --statement <text> --scope <detect|inspect|config|install|restore>[,...] [--confirm] [--dry-run] [--config-scope <user|project|workspace>] [--config-path <path>] [--home <path>] [--role <role>] [--granted-at <iso>] [--json]
  ano hook <session-start|prompt|pre-tool|stop> --client <zcode|claude-code> [--root <path>] [--mode <advisory|strict>]
  ano rebuild graph [--root <path>]
  ano export [--root <path>]
  ano connect [plan|status|resume|export|handoff|ui|watch] [--root <path>] [--expected-digest <sha256>] [--port <port>] [--interval <ms>] [--max-cycles <n>]
  ano ui [--port <port>] [--root <path>]
  ano baseline list [--root <path>]
  ano baseline verify <version> [--root <path>]
  ano baseline approve <version> --name <human> --role <role> --statement <text> --confirm [--root <path>]
  ano baseline draft <spec.json> [--root <path>]

The command executes tests through an argv array without a shell. Audit is local
and read-only; online adapters require confirm=true and are never the default.
Baseline approval requires a human attestation and an interactive TTY. Release
approval, attestation, sync and push are not implemented and are never exposed
to MCP.

Connect (接入) imports a pm-mcp project read-only into .ano/connect. It never
writes back to pm-mcp, never modifies AGENTS.md or MCP configuration, and never
scans the disk for projects: --root selects the only directory that is read.
"ano connect" with no subcommand plans and applies once; "plan" is zero-write;
"resume" re-applies idempotently; "watch" runs a bounded foreground sync loop
that plans each cycle, commits only real digest changes, never writes back to
the source, and stops on Ctrl+C/AbortSignal; "handoff" reports evidence-driven
接管 readiness (blocked until migration, reconciliation, a verified backup and
a named cutover confirmation all exist) and mutates nothing; "cutover" records a
named human confirmation binding a migration digest and backup; "ui" starts a
loopback-only read-only panel. Imported records stay untrusted data and are
never executed.

Takeover (ADR-006) is explicit and project-bound: 'takeover grant' writes only
.ano/takeover/authorization.json; 'takeover apply' requires an explicit
--confirm and the matching authorization id, then runs the six-phase
transaction (backup, migration, reconcile, verify, managed section, enforced).
'takeover status' reports the persisted state and drift; disable/revoke
move enforced to recovery; 'recover' restores a verified backup, removes the
managed section and returns to disabled. Confirmation is never inferred from
the environment, a config file or a default.

Client access (ADR-007/ADR-008) is read-only by default and exposes no eighth
MCP tool. 'doctor clients' reports the full 24-client catalog (21 ADR-008 tools
plus opencode/pi/zcode) with the nine capability layers and writes nothing;
'doctor client <id>' adds the four columns public sources / detection /
config candidates / capability. 'clients plan' renders the unified access plan
(route mcp|rules|cli|explicit-workflow|skip) for every client. cloudcode
resolves to claude-code and dsh resolves to deepseek-harness; unknown ids are
rejected. 'clients install' defaults to dry-run and writes nothing without an
explicit --confirm;
even with --confirm it requires the full authorization triple
--granted-by/--statement/--scope (config+install), a declared target scope,
then a content-hash backup, drift check, atomic merge that preserves other MCP
services and unknown fields, and a committed install record. 'clients restore'
restores only a verified backup whose manifest binds the same target and
requires the restore scope. Qoder/DSH/Pi/ZCode refuse the write path honestly;
Codex stays degraded because TOML configuration is read-only in v1.
`;

function helpFor(root: string): string {
  if (readConfig(root).profile === 'full') return help;
  const lines = help.split('\n');
  const usageStart = lines.indexOf('Usage:');
  const usageEnd = lines.findIndex((line, index) => index > usageStart && line.length === 0);
  const core = lines.slice(usageStart + 1, usageEnd).filter((line) => {
    if (!line.startsWith('  ano ')) return false;
    if (line.includes('ano clients ')) return line.includes('ano clients install ') || line.includes('ano clients restore ');
    return /^  ano (setup|brief|explore|track|note|verify|audit|doctor|hook|connect|takeover|export)\b/u.test(line);
  });
  return [
    'Agent Nihil Obstat (ANO) — personal mode',
    '',
    'Usage:',
    '  ano help --all',
    ...core,
    '',
    'Personal help shows core commands only. `ano help --all` shows every command.',
    ...lines.slice(usageEnd + 1),
  ].join('\n');
}

export function filterDoctorReportForProfile(report: DoctorReport, profile: 'personal' | 'full', all = false): DoctorReport {
  if (all || profile === 'full') return report;
  return { ...report, clients: report.clients.filter((client) => client.layers.detected.verdict !== 'unavailable') };
}

function rootFrom(argv: string[]): string {
  const index = argv.indexOf('--root');
  return index >= 0 && argv[index + 1] ? resolve(argv[index + 1]!) : defaultRoot();
}
function values(argv: string[], flag: string): string[] {
  const result: string[] = [];
  for (let index = 0; index < argv.length; index += 1) if (argv[index] === flag && argv[index + 1]) result.push(argv[index + 1]!);
  return result;
}
function value(argv: string[], flag: string): string | undefined { return values(argv, flag)[0]; }
function hasFlag(argv: string[], flag: string): boolean { return argv.includes(flag); }

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
const PROBE_BUDGET_LIMITS = { max_candidates: 10_000, max_nodes: 10_000, max_depth: 100 } as const;

type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string };

/** Reject a flag the branch does not declare, so unknown options fail loudly. */
function unknownFlag(argv: string[], allowed: readonly string[]): string | undefined {
  for (const arg of argv) if (arg.startsWith('--') && !allowed.includes(arg)) return arg;
  return undefined;
}

function parseJsonObject(raw: string, label: string): ParseResult<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, message: `${label} must be valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false, message: `${label} must be a JSON object` };
  return { ok: true, value: parsed as Record<string, unknown> };
}

function parseIsoOrNull(raw: string, label: string): ParseResult<string | null> {
  if (raw === 'null') return { ok: true, value: null };
  if (!ISO_DATETIME.test(raw) || Number.isNaN(Date.parse(raw))) return { ok: false, message: `${label} must be an ISO-8601 UTC datetime or null` };
  return { ok: true, value: raw };
}

interface ProbeBudgetInput { max_candidates?: number; max_nodes?: number; max_depth?: number }

/** `--budget` is an inline JSON object; unknown fields are rejected, not ignored. */
function parseProbeBudget(raw: string): ParseResult<ProbeBudgetInput> {
  const parsed = parseJsonObject(raw, 'recall --budget');
  if (!parsed.ok) return parsed;
  for (const key of Object.keys(parsed.value)) {
    if (!Object.hasOwn(PROBE_BUDGET_LIMITS, key)) return { ok: false, message: `recall --budget does not accept field ${JSON.stringify(key)}` };
  }
  const budget: ProbeBudgetInput = {};
  const entries = [['max_candidates', parsed.value.max_candidates], ['max_nodes', parsed.value.max_nodes], ['max_depth', parsed.value.max_depth]] as const;
  for (const [key, rawValue] of entries) {
    if (rawValue === undefined) continue;
    const limit = PROBE_BUDGET_LIMITS[key];
    if (!Number.isInteger(rawValue) || (rawValue as number) <= 0 || (rawValue as number) > limit) {
      return { ok: false, message: `recall --budget ${key} must be an integer in [1, ${limit}]` };
    }
    budget[key] = rawValue as number;
  }
  return { ok: true, value: budget };
}

function operationIdemKey(operation: string, payload: object): string {
  return `cli:note:${operation}:${createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32)}`;
}

type NoteRevisePayload = {
  fact_key: string;
  kind: 'decision' | 'pitfall' | 'memory';
  text: string;
  anchor?: { file: string; symbol_id?: string; qualified_name?: string };
  supersedes: string[];
  reason: string;
  effective_from: string | null;
  effective_to: string | null;
};

type NoteRelatePayload = {
  edge: 'depends_on' | 'explains' | 'related_to';
  from_ref: string;
  to_ref: string;
  reason?: string;
};

export interface CliContext {
  invokedPath?: string;
  /** T-166 test seam: stdin supplier for `ano hook`; defaults to process.stdin. */
  hookStdin?: () => Promise<string>;
}
const json = (value: unknown): { code: number; output: string } => ({ code: 0, output: JSON.stringify(value, null, 2) + '\n' });

// ---------------------------------------------------------------------------
// ADR-007 client command helpers
// ---------------------------------------------------------------------------

function renderClientReport(report: ClientReport): string[] {
  const lines: string[] = [];
  lines.push(`client: ${report.clientId}${report.alias === null ? '' : ` (alias ${report.alias})`}`);
  lines.push(`schema: ${report.schema}`);
  lines.push(`status: ${report.status}  coreVerdict: ${report.coreVerdict}`);
  lines.push(`generatedAt: ${report.generatedAt}`);
  for (const layer of CAPABILITY_LAYERS) {
    const entry = report.layers[layer];
    lines.push(
      `  ${layer} [${entry.code}] verdict=${entry.verdict} evidence=${entry.evidence} version=${entry.version ?? 'null'} source=${entry.source}`,
    );
    for (const limitation of entry.limitations) lines.push(`    limitation: ${limitation}`);
    for (const error of entry.errors) lines.push(`    error: ${error.code}: ${error.message}`);
  }
  if (report.limitations.length > 0) {
    lines.push('limitations:');
    for (const limitation of report.limitations) lines.push(`  - ${limitation}`);
  }
  if (report.errors.length > 0) {
    lines.push('errors:');
    for (const error of report.errors) lines.push(`  - ${error.code}: ${error.message}`);
  }
  return lines;
}

function renderClientDoctorReport(report: DoctorReport): string {
  const lines: string[] = [
    'ano client doctor report',
    `schema: ${report.schema}`,
    `generatedAt: ${report.generatedAt}`,
    `clients: ${report.clients.length}`,
    '',
  ];
  for (const client of report.clients) lines.push(...renderClientReport(client), '');
  if (report.limitations.length > 0) {
    lines.push('limitations:');
    for (const limitation of report.limitations) lines.push(`  - ${limitation}`);
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * Single-client report (T-099): the four required columns — public sources,
 * detection result, config candidates, capability — plus the report metadata.
 * The JSON form stays the frozen `ano.client-report/1` shape.
 */
function renderClientSingleReport(report: ClientReport, descriptor: ClientDescriptor): string[] {
  const lines: string[] = [];
  lines.push(`client: ${report.clientId}${report.alias === null ? '' : ` (alias ${report.alias})`}`);
  lines.push(`schema: ${report.schema}`);
  lines.push(`status: ${report.status}  coreVerdict: ${report.coreVerdict}`);
  lines.push(`generatedAt: ${report.generatedAt}`);
  lines.push('public sources:');
  if (descriptor.officialSources.length === 0) lines.push('  - (none declared)');
  for (const source of descriptor.officialSources) lines.push(`  - ${source}`);
  lines.push('detection:');
  const detected = report.layers.detected;
  lines.push(`  detected=${detected.details.detected} executablePath=${detected.details.executablePath ?? 'null'} version=${detected.details.version ?? 'null'} evidence=${detected.evidence}`);
  if (detected.details.sources.length === 0) lines.push('  sources: (none)');
  for (const source of detected.details.sources) lines.push(`  source: ${source.source}`);
  lines.push('config candidates:');
  if (descriptor.configCandidates.length === 0) lines.push('  - (none declared)');
  for (const candidate of descriptor.configCandidates) {
    lines.push(`  - ${candidate.path} (${candidate.scope}/${candidate.format}/${candidate.key})`);
  }
  lines.push('capability:');
  for (const layer of CAPABILITY_LAYERS) {
    const entry = report.layers[layer];
    lines.push(
      `  ${layer} [${entry.code}] verdict=${entry.verdict} evidence=${entry.evidence} version=${entry.version ?? 'null'} source=${entry.source}`,
    );
    for (const limitation of entry.limitations) lines.push(`    limitation: ${limitation}`);
    for (const error of entry.errors) lines.push(`    error: ${error.code}: ${error.message}`);
  }
  if (report.limitations.length > 0) {
    lines.push('limitations:');
    for (const limitation of report.limitations) lines.push(`  - ${limitation}`);
  }
  if (report.errors.length > 0) {
    lines.push('errors:');
    for (const error of report.errors) lines.push(`  - ${error.code}: ${error.message}`);
  }
  return lines;
}

/** Unified access-plan text form; `--json` emits the frozen report object. */
function renderClientAccessPlan(report: ClientAccessPlanReport): string {
  const lines: string[] = [
    'ano client access plan',
    `schema: ${report.schema}`,
    `generatedAt: ${report.generatedAt}`,
    `summary: total=${report.summary.total} mcp=${report.summary.mcp} rules=${report.summary.rules} cli=${report.summary.cli} explicitWorkflow=${report.summary.explicitWorkflow} skip=${report.summary.skip} writable=${report.summary.writable} requireAuthorization=${report.summary.requireAuthorization}`,
    '',
  ];
  for (const client of report.clients) {
    lines.push(
      `  ${client.clientId}${client.alias === null ? '' : ` (alias ${client.alias})`} route=${client.route} verdict=${client.verdict} evidence=${client.evidence} status=${client.status} target=${client.target?.path ?? '-'} authorization=${client.needsAuthorization}`,
    );
    for (const action of client.actions) lines.push(`    action: ${action}`);
    if (client.reason !== null) lines.push(`    reason: ${client.reason}`);
  }
  if (report.limitations.length > 0) {
    lines.push('limitations:');
    for (const limitation of report.limitations) lines.push(`  - ${limitation}`);
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function renderClientInstallText(clientId: string, alias: string | null, result: ClientInstallResult): string {
  const lines = [
    'ano client install',
    `mode: ${result.mode}  action: ${result.action}  applied: ${result.applied}`,
    `target: ${result.targetPath}`,
    `changed: ${result.changed}  backupId: ${result.backupId ?? 'null'}  backupHash: ${result.backupHash ?? 'null'}`,
    `beforeHash: ${result.beforeHash ?? 'null'}  afterHash: ${result.afterHash ?? 'null'}`,
    `installRecordId: ${result.installRecordId ?? 'null'}  installRecordCreated: ${result.installRecordCreated}`,
    `restoredOnFailure: ${result.restoredOnFailure}  error: ${result.error ?? 'null'}`,
  ];
  for (const warning of result.warnings) lines.push(`warning: ${warning}`);
  return `${lines.join('\n')}\n`;
}

function renderClientRestoreText(clientId: string, alias: string | null, result: ClientConfigResult): string {
  const lines = [
    'ano client restore',
    `clientId: ${clientId}${alias === null ? '' : ` (alias ${alias})`}`,
    `mode: ${result.mode}  applied: ${result.applied}  changed: ${result.changed}`,
    `target: ${result.target.path}`,
    `backupId: ${result.backupId ?? 'null'}  backupHash: ${result.backupHash ?? 'null'}`,
    `beforeHash: ${result.beforeHash ?? 'null'}  afterHash: ${result.afterHash ?? 'null'}`,
    `restoredOnFailure: ${result.restoredOnFailure}  error: ${result.error ?? 'null'}`,
  ];
  for (const warning of result.warnings) lines.push(`warning: ${warning}`);
  return `${lines.join('\n')}\n`;
}

type ClientFlagParse<T> = { ok: true; value: T } | { ok: false; message: string };

function parseEnvFlags(argv: string[]): ClientFlagParse<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const raw of values(argv, '--env')) {
    const separator = raw.indexOf('=');
    if (separator <= 0 || raw.slice(separator + 1).length === 0) {
      return { ok: false, message: `--env must be KEY=VALUE with a non-empty value: ${raw}` };
    }
    env[raw.slice(0, separator)!] = raw.slice(separator + 1)!;
  }
  return { ok: true, value: env };
}

function parseScopeFlag(raw: string, label: string): ClientFlagParse<string[]> {
  const entries = raw.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (entries.length === 0) return { ok: false, message: `${label} must list at least one scope` };
  for (const entry of entries) {
    if (!(CLIENT_CONFIG_SCOPES as readonly string[]).includes(entry)) {
      return { ok: false, message: `${label} must be a subset of ${CLIENT_CONFIG_SCOPES.join('|')}` };
    }
  }
  if (new Set(entries).size !== entries.length) return { ok: false, message: `${label} entries must be unique` };
  return { ok: true, value: entries };
}

function parseTimeoutMs(argv: string[], label: string): ClientFlagParse<number> {
  const raw = value(argv, label);
  if (raw === undefined) return { ok: true, value: 0 };
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 120_000) {
    return { ok: false, message: `${label} must be an integer between 1 and 120000` };
  }
  return { ok: true, value: parsed };
}

/** Shared read-only probe flags for `doctor clients` / `doctor client` / `clients plan`. */
function parseClientProbeFlags(
  ownArgs: string[],
  allowed: readonly string[],
  label: string = `doctor ${ownArgs[1] ?? ''}`,
): ClientFlagParse<ClientSurfaceEnvironment> {
  const unknown = unknownFlag(ownArgs, allowed);
  if (unknown) return { ok: false, message: `${label} does not accept ${unknown}` };
  const env = parseEnvFlags(ownArgs);
  if (!env.ok) return env;
  const timeout = parseTimeoutMs(ownArgs, '--timeout-ms');
  if (!timeout.ok) return timeout;
  const homeRaw = value(ownArgs, '--home');
  const probePaths = values(ownArgs, '--probe-path');
  return {
    ok: true,
    value: {
      ...(homeRaw === undefined ? {} : { home: resolve(homeRaw) }),
      ...(Object.keys(env.value).length > 0 ? { env: env.value } : {}),
      ...(probePaths.length > 0 ? { probePaths } : {}),
      ...(timeout.value === 0 ? {} : { timeoutMs: timeout.value }),
    },
  };
}

interface ParsedClientGrant {
  readonly scope: string[];
  readonly grantedBy: string;
  readonly statement: string;
  readonly role?: string;
  readonly grantedAt?: string;
}

function parseClientGrant(argv: string[], action: 'install' | 'restore'): ClientFlagParse<ParsedClientGrant> {
  const grantedBy = value(argv, '--granted-by');
  const statement = value(argv, '--statement');
  const scopeRaw = value(argv, '--scope');
  if (!grantedBy || !statement || scopeRaw === undefined) {
    return { ok: false, message: `clients ${action} requires --granted-by, --statement and --scope` };
  }
  const scope = parseScopeFlag(scopeRaw, `clients ${action} --scope`);
  if (!scope.ok) return scope;
  const required = action === 'install' ? ['config', 'install'] : ['restore'];
  for (const entry of required) {
    if (!scope.value.includes(entry)) return { ok: false, message: `clients ${action} --scope must include ${entry}` };
  }
  const grantedAt = value(argv, '--granted-at');
  if (grantedAt !== undefined && (!ISO_DATETIME.test(grantedAt) || Number.isNaN(Date.parse(grantedAt)))) {
    return { ok: false, message: 'clients --granted-at must be an ISO-8601 UTC datetime' };
  }
  const role = value(argv, '--role');
  return {
    ok: true,
    value: {
      scope: scope.value,
      grantedBy,
      statement,
      ...(role === undefined ? {} : { role }),
      ...(grantedAt === undefined ? {} : { grantedAt }),
    },
  };
}

interface ParsedClientWriteCommand {
  readonly id: string;
  readonly configScope: ConfigScope;
  readonly grant: ParsedClientGrant;
  readonly configPath?: string;
  readonly apply: boolean;
  readonly dryRunExplicit: boolean;
  readonly withHooks: boolean;
}

function parseClientWriteCommand(ownArgs: string[], action: 'install' | 'restore'): ClientFlagParse<ParsedClientWriteCommand> {
  const id = ownArgs[2] !== undefined && !ownArgs[2].startsWith('--') ? ownArgs[2] : undefined;
  if (id === undefined) return { ok: false, message: `clients ${action} requires <id>` };
  if (resolveClientId(id) === null) return { ok: false, message: `unknown client id: ${id}` };
  const installAllowed = ['--root', '--home', '--confirm', '--granted-by', '--statement', '--scope', '--role', '--granted-at', '--config-scope', '--config-path', '--dry-run', '--json', '--with-hooks'];
  const allowed = action === 'restore' ? [...installAllowed, '--backup-id'] : installAllowed;
  const unknown = unknownFlag(ownArgs, allowed);
  if (unknown) return { ok: false, message: `clients ${action} does not accept ${unknown}` };
  const grant = parseClientGrant(ownArgs, action);
  if (!grant.ok) return grant;
  const configScopeRaw = value(ownArgs, '--config-scope') ?? 'project';
  if (!['user', 'project', 'workspace'].includes(configScopeRaw)) {
    return { ok: false, message: 'clients --config-scope must be user | project | workspace' };
  }
  if (action === 'restore' && value(ownArgs, '--backup-id') === undefined) {
    return { ok: false, message: 'clients restore requires --backup-id <id>' };
  }
  const configPath = value(ownArgs, '--config-path');
  const confirm = hasFlag(ownArgs, '--confirm');
  const dryRun = hasFlag(ownArgs, '--dry-run');
  return {
    ok: true,
    value: {
      id,
      configScope: configScopeRaw as ConfigScope,
      grant: grant.value,
      ...(configPath === undefined ? {} : { configPath }),
      apply: confirm && !dryRun,
      dryRunExplicit: dryRun,
      withHooks: action === 'install' && hasFlag(ownArgs, '--with-hooks'),
    },
  };
}

// ---------------------------------------------------------------------------
// ano hook <event> --client <id> [--root] [--mode]  (T-166 / ADR-013 §4)
// ---------------------------------------------------------------------------

/** stdin 硬上限 1 MiB（ADR-013 / 实施规格 T-166）。超过即 fail-closed。 */
const HOOK_STDIN_LIMIT_BYTES = 1024 * 1024;

/** 每事件硬超时（ADR-013 §2 第 9 条）。 */
const HOOK_TIMEOUT_MS: Readonly<Record<HookEvent, number>> = {
  'pre-tool': 1500,
  'session-start': 5000,
  prompt: 1500,
  stop: 10000,
};

const HOOK_ADAPTERS: Readonly<Record<string, HookAdapter>> = {
  zcode: zcodeHookAdapter,
  'claude-code': claudeCodeHookAdapter,
};

interface ParsedHookCommand {
  readonly event: HookEvent;
  readonly client: string;
  readonly root?: string;
  readonly projectScoped: boolean;
  readonly configuredMode: boolean;
  readonly mode: HookMode;
}

function parseHookCommand(ownArgs: string[]): ClientFlagParse<ParsedHookCommand> {
  const eventRaw = ownArgs[1] !== undefined && !ownArgs[1].startsWith('--') ? ownArgs[1] : undefined;
  if (eventRaw === undefined) return { ok: false, message: 'hook requires <event>' };
  if (!(HOOK_EVENTS as readonly string[]).includes(eventRaw)) {
    return { ok: false, message: `hook <event> must be one of ${HOOK_EVENTS.join(' | ')}` };
  }
  const unknown = unknownFlag(ownArgs, ['--client', '--root', '--mode', '--project-scoped']);
  if (unknown) return { ok: false, message: `hook does not accept ${unknown}` };
  const client = value(ownArgs, '--client');
  if (client === undefined) return { ok: false, message: 'hook requires --client <id>' };
  if (!Object.hasOwn(HOOK_ADAPTERS, client)) {
    return { ok: false, message: `hook --client must be one of ${Object.keys(HOOK_ADAPTERS).join(' | ')}` };
  }
  const root = value(ownArgs, '--root');
  const projectScoped = hasFlag(ownArgs, '--project-scoped');
  if (projectScoped && root === undefined) return { ok: false, message: 'hook --project-scoped requires --root' };
  const configuredMode = projectScoped && value(ownArgs, '--mode') === undefined;
  const modeRaw = value(ownArgs, '--mode') ?? (root && !projectScoped ? readConfig(resolve(root)).hooks.mode : 'advisory');
  if (!(HOOK_MODES as readonly string[]).includes(modeRaw)) {
    return { ok: false, message: 'hook --mode must be advisory | strict' };
  }
  return {
    ok: true,
    value: {
      event: eventRaw as HookEvent,
      client,
      ...(root === undefined ? {} : { root: resolve(root) }),
      projectScoped,
      configuredMode,
      mode: modeRaw as HookMode,
    },
  };
}

/** Read stdin with an exact-byte cap; never decode more than 1 MiB. */
async function readHookStdin(supplier: () => Promise<string>): Promise<string> {
  const text = await supplier();
  if (Buffer.byteLength(text, 'utf8') > HOOK_STDIN_LIMIT_BYTES) {
    throw new Error(`hook stdin exceeds ${HOOK_STDIN_LIMIT_BYTES} bytes`);
  }
  return text;
}

/**
 * AbortSignal 硬超时（ADR-013 §2 第 9 条）：超时后 engine 必须已放弃进一步
 * 工作；即便 engine 不遵守 signal，本函数用 Promise.race 强制在超时边界返回
 * fail-closed，避免宿主被挂住。
 */
function withHardTimeout<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timeout = new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`hook hard timeout after ${ms} ms`));
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([work(controller.signal), timeout]);
}

/** Route normalized hook input to the real event engines. */
async function decideHook(
  input: HookInput,
  mode: HookMode,
  signal: AbortSignal,
  root: string,
): Promise<HookDecision> {
  if (signal.aborted) return failClosedDecision(mode, 'HOOK_TIMEOUT', 'hook was cancelled before engine dispatch');
  const projectRoot = await existingProjectRoot(root);
  const config = readConfig(projectRoot);
  if (input.event === 'session-start') {
    const ledger = await Ledger.open(projectRoot);
    try { return (await onSessionStart(input, { ledger, mode })).decision; }
    finally { ledger.close(); }
  }
  if (input.event === 'stop') {
    const ledger = await Ledger.open(projectRoot);
    try { return (await onStop(input, { ledger, mode })).decision; }
    finally { ledger.close(); }
  }
  if (input.event === 'prompt') return { kind: 'allow' };
  if (input.event === 'pre-tool') {
    const graph = await GraphStore.open(projectRoot);
    try {
      return decidePreTool(input, {
        mode,
        root: projectRoot,
        freshness: graph.freshness(),
        revision: graph.revision,
        exempt: config.hooks.exempt,
      });
    } finally { graph.close(); }
  }
  return failClosedDecision(mode, 'HOOK_INTERNAL', `unsupported hook event ${String(input.event)}`);
}

async function executeHook(
  parsed: ParsedHookCommand,
  context: CliContext,
): Promise<{ code: number; output: string }> {
  const adapter = HOOK_ADAPTERS[parsed.client]!;
  let mode = parsed.mode;
  let decision: HookDecision | null = null;
  try {
    // T-167 / ADR-013 §2 第 9 条：硬超时必须覆盖整条钩子管线——stdin 读取、
    // adapter 解析与引擎判定。旧实现只把 withHardTimeout 套在 decideHook 上，
    // 一个永不返回（或被宿主拖慢）的 stdin 会无限挂住宿主线程（红队 F-02）。
    decision = await withHardTimeout(HOOK_TIMEOUT_MS[parsed.event], async (signal) => {
      const stdin = await readHookStdin(
        context.hookStdin ?? (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of process.stdin) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
            if (Buffer.concat(chunks).byteLength > HOOK_STDIN_LIMIT_BYTES) break;
          }
          return Buffer.concat(chunks).toString('utf8');
        }),
      );
      const input = adapter.parse(stdin);
      // root 解析：显式 --root > stdin.cwd > 失败（ADR-013 §4.1）。
      const root = parsed.root ?? input.cwd;
      if (typeof root !== 'string' || root.length === 0) {
        throw new Error('hook root is ambiguous: no --root and stdin.cwd is empty');
      }
      // 安装到用户全局的 hook 只服务绑定项目；确认归属前不读配置、不打开账本。
      // null 表示未处理，不渲染 allow/ask/deny，也不向其他项目注入上下文。
      if (parsed.projectScoped) {
        if (!isAbsolute(input.cwd)) return null;
        try {
          const hostRoot = await existingProjectRoot(await realpath(input.cwd));
          const boundRoot = await existingProjectRoot(await realpath(root));
          const hostIdentity = await realpath(hostRoot);
          const boundIdentity = await realpath(boundRoot);
          const canonical = (path: string): string => process.platform === 'win32' ? path.toLowerCase() : path;
          if (canonical(hostIdentity) !== canonical(boundIdentity)) return null;
        } catch {
          return null;
        }
      }
      if (parsed.configuredMode) mode = readConfig(await existingProjectRoot(root)).hooks.mode;
      return decideHook(input, mode, signal, root);
    });
    if (decision === null) return { code: 0, output: '' };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const code: HookDegradedCode = detail.includes('exceeds') || detail.includes('not valid JSON') || detail.includes('missing')
      ? 'HOOK_INPUT_INVALID'
      : detail.includes('timeout')
        ? 'HOOK_TIMEOUT'
        : detail.includes('root')
          ? 'HOOK_ROOT_AMBIGUOUS'
          : 'HOOK_INTERNAL';
    decision = failClosedDecision(mode, code, detail);
  }
  const rendered: HookRenderResult = adapter.render(decision, parsed.event);
  const output = rendered.stdout;
  const code = rendered.exitCode;
  return code === 0 ? { code, output } : { code, output };
}

export async function runCli(argv: string[], context: CliContext = {}): Promise<{ code: number; output: string }> {
  // Everything after the first `--` belongs to the verified command, never to
  // the CLI itself (so `--root`/`--test`/`--help` there are test arguments).
  const separator = argv.indexOf('--');
  const ownArgs = separator < 0 ? argv : argv.slice(0, separator);
  if (ownArgs[0] === 'help') return { code: 0, output: hasFlag(ownArgs, '--all') ? help : helpFor(rootFrom(ownArgs)) };
  if (!ownArgs.length || ownArgs.includes('--help') || ownArgs.includes('-h')) return { code: 0, output: hasFlag(ownArgs, '--all') ? help : helpFor(rootFrom(ownArgs)) };
  if (ownArgs.length === 1 && (ownArgs[0] === '--version' || ownArgs[0] === '-v')) {
    const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
    return { code: 0, output: `${manifest.version}\n` };
  }
  if (ownArgs[0] === 'hook') {
    const parsed = parseHookCommand(ownArgs);
    if (!parsed.ok) return { code: 2, output: `${parsed.message}\n` };
    return executeHook(parsed.value, context);
  }
  const root = rootFrom(ownArgs);
  if (ownArgs[0] === 'setup') {
    const unknown = unknownFlag(ownArgs, ['--root', '--client', '--home', '--yes-dry-run']);
    if (unknown) return { code: 2, output: `setup does not accept ${unknown}\n` };
    const client = value(ownArgs, '--client');
    if (client !== 'zcode' && client !== 'claude-code') return { code: 2, output: 'setup requires --client <zcode|claude-code>\n' };
    const interactive = isInteractiveTty() && !hasFlag(ownArgs, '--yes-dry-run');
    if (!interactive) return json(await runSetup({ root, client, interactive: false, ...(value(ownArgs, '--home') ? { home: resolve(value(ownArgs, '--home')!) } : {}) }));
    const { createInterface } = await import('node:readline/promises');
    const tty = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const grantedBy = (await tty.question('具名授权人（必填）: ')).trim();
      if (!grantedBy) return { code: 2, output: 'setup cancelled: named human is required\n' };
      const result = await runSetup({
        root, client, interactive: true, grantedBy,
        ...(value(ownArgs, '--home') ? { home: resolve(value(ownArgs, '--home')!) } : {}),
        confirm: async (step, preview) => {
          process.stdout.write(`\n[ANO setup] ${step}\n${JSON.stringify(preview, null, 2)}\n`);
          return /^(?:y|yes)$/iu.test((await tty.question(`确认执行 ${step}? 输入 yes 继续: `)).trim());
        },
      });
      return { code: result.mode === 'stopped' ? 1 : 0, output: `${JSON.stringify(result, null, 2)}\n` };
    } finally { tty.close(); }
  }
  if (ownArgs[0] === 'brief') {
    // CLI parity with the MCP brief branch: `--memory-context` freezes a
    // derived probe manifest so `verify context` has a real context id to
    // consume. The manifest is cache material; it never writes the ledger.
    const allowed = ['--root', '--json', '--memory-context', '--context-budget'];
    const unknown = unknownFlag(ownArgs, allowed);
    if (unknown) return { code: 2, output: `brief does not accept ${unknown}\n` };
    const includeMemoryContext = hasFlag(ownArgs, '--memory-context');
    const contextBudgetRaw = value(ownArgs, '--context-budget');
    if (contextBudgetRaw !== undefined && !includeMemoryContext) {
      return { code: 2, output: 'brief --context-budget requires --memory-context\n' };
    }
    let contextBudget: number | undefined;
    if (contextBudgetRaw !== undefined) {
      const parsed = Number(contextBudgetRaw);
      if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 10_000) {
        return { code: 2, output: 'brief --context-budget must be an integer between 1 and 10000\n' };
      }
      contextBudget = parsed;
    }
    return json(await brief(root, {
      ...(includeMemoryContext ? { include_memory_context: true as const } : {}),
      ...(contextBudget === undefined ? {} : { context_budget: contextBudget }),
    }));
  }
  if (ownArgs[0] === 'explore' && ownArgs[1]) return json(await explore(root, ownArgs[1]));
  if (ownArgs[0] === 'track' && ownArgs[1] === 'create' && value(ownArgs, '--id')) return json(await trackTask(root, { id: value(ownArgs, '--id'), title: value(ownArgs, '--title'), files: values(ownArgs, '--file'), status: 'in_progress' }, `cli:track:${value(ownArgs, '--id')}`));
  if (ownArgs[0] === 'track' && ['update', 'cancel', 'reopen', 'complete'].includes(ownArgs[1] ?? '')) {
    const id = value(ownArgs, '--id');
    if (!id) return { code: 2, output: `track ${ownArgs[1]} requires --id <task-id>\n` };
    const status = value(ownArgs, '--status');
    if (status !== undefined && !['todo', 'in_progress', 'cancelled'].includes(status)) {
      return { code: 2, output: 'track --status must be todo | in_progress | cancelled\n' };
    }
    const payload: Record<string, unknown> = { operation: ownArgs[1], id, ...(status === undefined ? {} : { status }) };
    if (ownArgs[1] === 'complete') {
      const evidenceId = value(ownArgs, '--evidence-id');
      if (!evidenceId) return { code: 2, output: 'track complete requires --evidence-id <recorded Gate evidence id>\n' };
      payload.evidence_id = evidenceId;
    }
    return json(await trackTaskUpdate(root, payload, `cli:track:${ownArgs[1]}:${id}`));
  }
  if (ownArgs[0] === 'migrate') {
    const action = ownArgs[1] && !ownArgs[1].startsWith('--') ? ownArgs[1] : 'status';
    const expectedSourceDigest = value(ownArgs, '--expected-source-digest');
    if (expectedSourceDigest !== undefined && !/^[0-9a-f]{64}$/iu.test(expectedSourceDigest)) {
      return { code: 2, output: 'migrate --expected-source-digest must be a 64-character sha256 hex digest\n' };
    }
    if (action === 'plan') return json(await migratePlanSurface(root));
    if (action === 'reconcile') return json(await migrateReconcileSurface(root));
    if (action === 'status') {
      const plan = await migratePlanSurface(root);
      return json({ ...(await migrateReconcileSurface(root)), canApply: plan.canApply, conflicts: plan.conflicts, sources: plan.sources });
    }
    if (action === 'apply') {
      if (expectedSourceDigest === undefined) return { code: 2, output: 'migrate apply requires --expected-source-digest from a prior migrate plan\n' };
      try {
        const result = await migrateApplySurface(root, { expected_source_digest: expectedSourceDigest, ...(hasFlag(ownArgs, '--on-conflict') ? { on_conflict: 'skip' } : {}) }, `cli:migrate:${expectedSourceDigest}`);
        return { code: result.sourceUnchanged ? 0 : 1, output: JSON.stringify(result, null, 2) + '\n' };
      } catch (error) {
        return { code: 1, output: `${error instanceof Error ? error.message : String(error)}\n` };
      }
    }
    if (action === 'backup') return json(await migrateBackupSurface(root));
    if (action === 'list-backups') return json(await migrateBackupsSurface(root));
    if (action === 'restore') {
      const backupId = value(ownArgs, '--backup-id');
      if (!backupId) return { code: 2, output: 'migrate restore requires --backup-id <id>\n' };
      try {
        return json(await migrateRestoreSurface(root, { backup_id: backupId }));
      } catch (error) {
        return { code: 1, output: `${error instanceof Error ? error.message : String(error)}\n` };
      }
    }
    return { code: 2, output: 'migrate supports: plan | apply | status | reconcile | backup | restore | list-backups\n' };
  }
  if (ownArgs[0] === 'takeover') {
    const action = ownArgs[1] && !ownArgs[1].startsWith('--') ? ownArgs[1] : '';
    const rootRaw = value(ownArgs, '--root');
    if (!rootRaw) return { code: 2, output: 'takeover requires --root <path>\n' };
    const root = resolve(rootRaw);
    if (action === 'grant') {
      const allowed = ['--root', '--scope', '--granted-by', '--role', '--statement', '--granted-at'];
      const unknown = unknownFlag(ownArgs, allowed);
      if (unknown) return { code: 2, output: `takeover grant does not accept ${unknown}\n` };
      const scopeRaw = value(ownArgs, '--scope');
      const grantedBy = value(ownArgs, '--granted-by');
      const role = value(ownArgs, '--role');
      const statement = value(ownArgs, '--statement');
      const grantedAt = value(ownArgs, '--granted-at');
      if (scopeRaw === undefined) return { code: 2, output: 'takeover grant requires --scope <tasks|memory|acceptance|dag>[,...]\n' };
      const scope = scopeRaw.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
      if (scope.length === 0) return { code: 2, output: 'takeover grant requires at least one scope\n' };
      if (scope.some((entry) => !['tasks', 'memory', 'acceptance', 'dag'].includes(entry))) {
        return { code: 2, output: 'takeover grant --scope must be a subset of tasks|memory|acceptance|dag\n' };
      }
      if (new Set(scope).size !== scope.length) return { code: 2, output: 'takeover grant --scope entries must be unique\n' };
      if (!grantedBy || !role || !statement) return { code: 2, output: 'takeover grant requires --granted-by, --role and --statement\n' };
      if (grantedAt !== undefined && Number.isNaN(Date.parse(grantedAt))) {
        return { code: 2, output: 'takeover grant --granted-at must be an ISO-8601 UTC datetime\n' };
      }
      try {
        return json(await takeoverGrant(root, {
          scope,
          grantedBy,
          role,
          statement,
          ...(grantedAt === undefined ? {} : { grantedAt }),
        }));
      } catch (error) {
        return { code: 1, output: `${error instanceof Error ? error.message : String(error)}\n` };
      }
    }
    if (action === 'apply') {
      const allowed = ['--root', '--authorization-id', '--confirm'];
      const unknown = unknownFlag(ownArgs, allowed);
      if (unknown) return { code: 2, output: `takeover apply does not accept ${unknown}\n` };
      // Confirmation must be an explicit command-line flag; it is never inferred.
      if (!hasFlag(ownArgs, '--confirm')) return { code: 2, output: 'takeover apply requires an explicit --confirm\n' };
      const authorizationId = value(ownArgs, '--authorization-id');
      if (!authorizationId) return { code: 2, output: 'takeover apply requires --authorization-id <id>\n' };
      if (!/^[0-9a-f]{64}$/iu.test(authorizationId)) {
        return { code: 2, output: 'takeover apply --authorization-id must be a 64-character sha256 hex digest\n' };
      }
      try {
        const result = await takeoverApply(root, { authorizationId });
        return {
          code: result.active === true && result.aborted !== true ? 0 : 1,
          output: JSON.stringify(result, null, 2) + '\n',
        };
      } catch (error) {
        return { code: 1, output: `${error instanceof Error ? error.message : String(error)}\n` };
      }
    }
    if (action === 'status') {
      const allowed = ['--root'];
      const unknown = unknownFlag(ownArgs, allowed);
      if (unknown) return { code: 2, output: `takeover status does not accept ${unknown}\n` };
      try {
        const status = takeoverStatusSurface(root);
        return {
          code: status.state === 'unknown' ? 1 : 0,
          output: JSON.stringify(status, null, 2) + '\n',
        };
      } catch (error) {
        return { code: 1, output: `${error instanceof Error ? error.message : String(error)}\n` };
      }
    }
    if (action === 'recover' || action === 'disable' || action === 'revoke') {
      const allowed = ['--root', '--confirm'];
      const unknown = unknownFlag(ownArgs, allowed);
      if (unknown) return { code: 2, output: `takeover ${action} does not accept ${unknown}\n` };
      if (!hasFlag(ownArgs, '--confirm')) return { code: 2, output: `takeover ${action} requires an explicit --confirm\n` };
      try {
        const output = action === 'recover'
          ? await takeoverRecover(root)
          : action === 'disable'
            ? await takeoverDisable(root)
            : await takeoverRevoke(root);
        return json(output);
      } catch (error) {
        return { code: 1, output: `${error instanceof Error ? error.message : String(error)}\n` };
      }
    }
    return { code: 2, output: 'takeover supports: grant | apply | status | recover | disable | revoke\n' };
  }
  if (ownArgs[0] === 'verify' && ownArgs[1] === 'release') {
    // tier is a task-only opt-in; release verification has no downgrade path.
    if (ownArgs.some((arg) => arg === '--tier' || arg.startsWith('--tier='))) return { code: 2, output: 'verify release does not accept --tier; tier is only allowed for task verification\n' };
    const artifact = value(ownArgs, '--artifact');
    const target = value(ownArgs, '--target');
    const profiles = values(ownArgs, '--profile');
    if (!artifact || !target || !profiles.length) return { code: 2, output: 'verify release requires --target, --profile and --artifact <path>\n' };
    return json(await releaseVerification(root, { target, profiles, artifact_path: artifact, idem_key: `cli:release:${target}` }));
  }
  if (ownArgs[0] === 'verify' && ownArgs[1] === 'context') {
    const allowed = ['--root', '--context-id', '--project-scope', '--draft'];
    const unknown = unknownFlag(ownArgs, allowed);
    if (unknown) return { code: 2, output: `verify context does not accept ${unknown}\n` };
    const contextId = value(ownArgs, '--context-id');
    const projectScope = value(ownArgs, '--project-scope');
    const draftPath = value(ownArgs, '--draft');
    if (!contextId || !projectScope || !draftPath) return { code: 2, output: 'verify context requires --context-id, --project-scope and --draft <path.json>\n' };
    // The draft is untrusted data: it is read and parsed, never executed.
    let draft: unknown;
    try {
      draft = JSON.parse(await readFile(resolve(draftPath), 'utf8')) as unknown;
    } catch (error) {
      return { code: 2, output: `verify context --draft is not readable JSON: ${error instanceof Error ? error.message : String(error)}\n` };
    }
    try {
      const report = await verifyContext(root, { context_id: contextId, project_scope: projectScope, draft });
      const status = (report as { status?: unknown }).status;
      return { code: status === 'BLOCK' ? 1 : 0, output: JSON.stringify(report, null, 2) + '\n' };
    } catch (error) {
      return { code: 1, output: `${error instanceof Error ? error.message : String(error)}\n` };
    }
  }
  if (ownArgs[0] === 'recall') {
    const mode = value(ownArgs, '--mode');
    if (mode !== undefined && mode !== 'probe') return { code: 2, output: 'recall --mode supports only probe\n' };
    if (mode === 'probe') {
      const allowed = ['--root', '--mode', '--project-scope', '--requirement', '--query', '--temporal-mode', '--as-of', '--budget'];
      const unknown = unknownFlag(ownArgs, allowed);
      if (unknown) return { code: 2, output: `recall --mode probe does not accept ${unknown}\n` };
      const projectScope = value(ownArgs, '--project-scope');
      if (!projectScope) return { code: 2, output: 'recall --mode probe requires --project-scope <id>\n' };
      const requirements = values(ownArgs, '--requirement');
      const query = value(ownArgs, '--query');
      if (!requirements.length && query === undefined) return { code: 2, output: 'recall --mode probe requires --query <text> or at least one --requirement <text>\n' };
      const temporalMode = value(ownArgs, '--temporal-mode');
      if (temporalMode !== undefined && !['CURRENT', 'AS_OF', 'HISTORICAL'].includes(temporalMode)) {
        return { code: 2, output: 'recall --mode probe --temporal-mode must be CURRENT | AS_OF | HISTORICAL\n' };
      }
      const asOf = value(ownArgs, '--as-of');
      if (asOf !== undefined && (!ISO_DATETIME.test(asOf) || Number.isNaN(Date.parse(asOf)))) {
        return { code: 2, output: 'recall --mode probe --as-of must be an ISO-8601 UTC datetime\n' };
      }
      if (temporalMode !== undefined && temporalMode !== 'CURRENT' && asOf === undefined) {
        return { code: 2, output: 'recall --mode probe --as-of is required for AS_OF | HISTORICAL temporal_mode\n' };
      }
      const budgetRaw = value(ownArgs, '--budget');
      let budget: ProbeBudgetInput | undefined;
      if (budgetRaw !== undefined) {
        const parsed = parseProbeBudget(budgetRaw);
        if (!parsed.ok) return { code: 2, output: `${parsed.message}\n` };
        budget = parsed.value;
      }
      const input: RecallProbeSurfaceInput = {
        project_scope: projectScope,
        ...(requirements.length ? { requirements } : {}),
        ...(query !== undefined ? { query } : {}),
        ...(temporalMode !== undefined ? { temporal_mode: temporalMode as 'CURRENT' | 'AS_OF' | 'HISTORICAL' } : {}),
        ...(asOf !== undefined ? { as_of: asOf } : {}),
        ...(budget === undefined ? {} : { budget }),
      };
      try {
        return json(await recallProbe(root, input));
      } catch (error) {
        return { code: 1, output: `${error instanceof Error ? error.message : String(error)}\n` };
      }
    }
    const entries: Array<[string, unknown]> = ['session', 'from', 'to', 'file', 'symbol', 'keyword', 'provider'].flatMap((key) => {
      const entry = value(ownArgs, `--${key}`);
      return entry === undefined ? [] : [[key, entry]];
    });
    const source = value(ownArgs, '--source');
    const query = value(ownArgs, '--query');
    if (source !== undefined) entries.push(['source', source]);
    if (query !== undefined) entries.push(['query', query]);
    const limitRaw = value(ownArgs, '--limit');
    if (limitRaw !== undefined) {
      if (source !== 'connected') return { code: 2, output: 'recall --limit requires --source connected\n' };
      const limit = Number(limitRaw);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) return { code: 2, output: 'recall --limit must be an integer between 1 and 100\n' };
      entries.push(['limit', limit]);
    }
    return json(await recall(root, Object.fromEntries(entries)));
  }
  if (ownArgs[0] === 'note' && ownArgs[1] === 'revise') {
    const allowed = ['--root', '--kind', '--text', '--fact-key', '--supersedes', '--reason', '--effective-from', '--effective-to', '--file', '--symbol', '--qualified-name'];
    const unknown = unknownFlag(ownArgs, allowed);
    if (unknown) return { code: 2, output: `note revise does not accept ${unknown}\n` };
    const kind = value(ownArgs, '--kind');
    const text = value(ownArgs, '--text');
    const factKey = value(ownArgs, '--fact-key');
    const supersedesRaw = value(ownArgs, '--supersedes');
    const reason = value(ownArgs, '--reason');
    const effectiveFromRaw = value(ownArgs, '--effective-from');
    const effectiveToRaw = value(ownArgs, '--effective-to');
    if (!['decision', 'pitfall', 'memory'].includes(kind ?? '')) return { code: 2, output: 'note revise requires --kind decision | pitfall | memory\n' };
    if (!text) return { code: 2, output: 'note revise requires --text <text>\n' };
    if (!factKey) return { code: 2, output: 'note revise requires --fact-key <key>\n' };
    if (supersedesRaw === undefined) return { code: 2, output: 'note revise requires an explicit --supersedes <json array> ([] declares a genesis version)\n' };
    if (reason === undefined) return { code: 2, output: 'note revise requires --reason <text>\n' };
    if (effectiveFromRaw === undefined || effectiveToRaw === undefined) return { code: 2, output: 'note revise requires explicit --effective-from and --effective-to (ISO datetime or null)\n' };
    let supersedes: string[];
    try {
      const parsed = JSON.parse(supersedesRaw) as unknown;
      if (!Array.isArray(parsed) || parsed.length > 1 || parsed.some((ref) => typeof ref !== 'string' || ref.length === 0)) {
        return { code: 2, output: 'note revise --supersedes must be a JSON array of at most one ledger event id ([] declares a genesis version)\n' };
      }
      supersedes = parsed as string[];
    } catch (error) {
      return { code: 2, output: `note revise --supersedes must be valid JSON: ${error instanceof Error ? error.message : String(error)}\n` };
    }
    const effectiveFrom = parseIsoOrNull(effectiveFromRaw, '--effective-from');
    if (!effectiveFrom.ok) return { code: 2, output: `${effectiveFrom.message}\n` };
    const effectiveTo = parseIsoOrNull(effectiveToRaw, '--effective-to');
    if (!effectiveTo.ok) return { code: 2, output: `${effectiveTo.message}\n` };
    const file = value(ownArgs, '--file');
    const symbolId = value(ownArgs, '--symbol');
    const qualifiedName = value(ownArgs, '--qualified-name');
    if (!file && (symbolId !== undefined || qualifiedName !== undefined)) return { code: 2, output: 'note revise --symbol/--qualified-name require --file <path>\n' };
    const anchor = file ? { file, ...(symbolId ? { symbol_id: symbolId } : {}), ...(qualifiedName ? { qualified_name: qualifiedName } : {}) } : undefined;
    const payload: NoteRevisePayload = {
      fact_key: factKey,
      kind: kind as 'decision' | 'pitfall' | 'memory',
      text,
      ...(anchor ? { anchor } : {}),
      supersedes,
      reason,
      effective_from: effectiveFrom.value,
      effective_to: effectiveTo.value,
    };
    try {
      return json(await noteRevise(root, { idem_key: operationIdemKey('revise', payload), ...payload }));
    } catch (error) {
      return { code: 1, output: `${error instanceof Error ? error.message : String(error)}\n` };
    }
  }
  if (ownArgs[0] === 'note' && ownArgs[1] === 'relate') {
    const allowed = ['--root', '--edge', '--from-ref', '--to-ref', '--reason'];
    const unknown = unknownFlag(ownArgs, allowed);
    if (unknown) return { code: 2, output: `note relate does not accept ${unknown}\n` };
    const edge = value(ownArgs, '--edge');
    const fromRef = value(ownArgs, '--from-ref');
    const toRef = value(ownArgs, '--to-ref');
    const reason = value(ownArgs, '--reason');
    if (!['depends_on', 'explains', 'related_to'].includes(edge ?? '')) return { code: 2, output: 'note relate requires --edge depends_on | explains | related_to\n' };
    if (!fromRef) return { code: 2, output: 'note relate requires --from-ref <ledger-event-id>\n' };
    if (!toRef) return { code: 2, output: 'note relate requires --to-ref <ledger-event-id>\n' };
    const payload: NoteRelatePayload = { edge: edge as 'depends_on' | 'explains' | 'related_to', from_ref: fromRef, to_ref: toRef, ...(reason === undefined ? {} : { reason }) };
    try {
      return json(await noteRelate(root, { idem_key: operationIdemKey('relate', payload), ...payload }));
    } catch (error) {
      return { code: 1, output: `${error instanceof Error ? error.message : String(error)}\n` };
    }
  }
  if (ownArgs[0] === 'note') {
    const text = value(ownArgs, '--text');
    const kind = ownArgs[1];
    if (!text || !['decision', 'pitfall', 'memory', 'session_summary'].includes(kind ?? '')) return { code: 2, output: 'note requires a kind and --text <text>\n' };
    const file = value(ownArgs, '--file');
    const symbolId = value(ownArgs, '--symbol');
    const qualifiedName = value(ownArgs, '--qualified-name');
    const anchor = file ? { file, ...(symbolId ? { symbol_id: symbolId } : {}), ...(qualifiedName ? { qualified_name: qualifiedName } : {}) } : undefined;
    return json(await note(root, { kind: kind as 'decision' | 'pitfall' | 'memory' | 'session_summary', text, ...(anchor ? { anchor } : {}), idem_key: `cli:note:${kind}:${text}` }));
  }
  if (ownArgs[0] === 'verify' && ownArgs[1]) {
    // Task-only opt-in coverage tier. An absent --tier keeps the T1 strict
    // default; an invalid value is a parse error, never a silent default.
    if (ownArgs.some((arg) => arg.startsWith('--tier='))) return { code: 2, output: 'verify --tier must be T0 or T1 (use --tier T0)\n' };
    const tier = value(ownArgs, '--tier');
    if (tier === undefined && hasFlag(ownArgs, '--tier')) return { code: 2, output: 'verify --tier requires T0 or T1\n' };
    if (tier !== undefined && tier !== 'T0' && tier !== 'T1') return { code: 2, output: 'verify --tier must be T0 or T1\n' };
    const command = separator >= 0 ? argv.slice(separator + 1) : [];
    const testFiles = values(ownArgs, '--test');
    if (!command.length || !testFiles.length) return { code: 2, output: 'verify requires --test <file> and -- <argv>\n' };
    // No idempotency key: verifyTask derives one from the request and source
    // fingerprint, so retries reuse evidence while re-verifying changed source.
    return json(await verifySurface(root, { task_id: ownArgs[1], argv: command, test_files: testFiles, ...(tier !== undefined ? { tier } : {}) }));
  }
  if (ownArgs[0] === 'audit') {
    const scope = ownArgs[1];
    if (!scope) return { code: 2, output: 'audit requires a scope: drift, security, license, governance or deps\n' };
    const online = hasFlag(ownArgs, '--online');
    const confirm = hasFlag(ownArgs, '--confirm');
    if (online && !confirm) return { code: 2, output: 'Network-backed audit requires --confirm; the default is deny.\n' };
    return json(await auditSurface(root, { scope, online, confirm }));
  }
  if (ownArgs[0] === 'doctor' && ownArgs[1] === 'clients') {
    const parsed = parseClientProbeFlags(ownArgs, ['--root', '--home', '--env', '--probe-path', '--timeout-ms', '--json', '--plan', '--all']);
    if (!parsed.ok) return { code: 2, output: `${parsed.message}\n` };
    try {
      if (hasFlag(ownArgs, '--plan')) {
        const plan = await clientAccessPlanReport({ root, ...parsed.value });
        return hasFlag(ownArgs, '--json') ? json(plan) : { code: 0, output: renderClientAccessPlan(plan) };
      }
      const report = await clientDoctorReport({ root, ...parsed.value });
      const visible = filterDoctorReportForProfile(report, readConfig(root).profile, hasFlag(ownArgs, '--all'));
      return hasFlag(ownArgs, '--json') ? json(visible) : { code: 0, output: renderClientDoctorReport(visible) };
    } catch (error) {
      return { code: 1, output: `${error instanceof Error ? error.message : String(error)}\n` };
    }
  }
  if (ownArgs[0] === 'doctor' && ownArgs[1] === 'client') {
    const id = ownArgs[2];
    if (id === undefined || id.startsWith('--')) return { code: 2, output: 'doctor client requires <id>\n' };
    if (resolveClientId(id) === null) return { code: 2, output: `unknown client id: ${id}\n` };
    const parsed = parseClientProbeFlags(ownArgs, ['--root', '--home', '--env', '--probe-path', '--timeout-ms', '--json']);
    if (!parsed.ok) return { code: 2, output: `${parsed.message}\n` };
    try {
      const report = await clientDoctorSingle(id, { root, ...parsed.value });
      if (hasFlag(ownArgs, '--json')) return json(report);
      return { code: 0, output: `${renderClientSingleReport(report, getDescriptor(report.clientId)).join('\n')}\n` };
    } catch (error) {
      return { code: 1, output: `${error instanceof Error ? error.message : String(error)}\n` };
    }
  }
  if (ownArgs[0] === 'clients') {
    const action = ownArgs[1];
    if (action === 'plan') {
      const parsed = parseClientProbeFlags(ownArgs, ['--root', '--home', '--env', '--probe-path', '--timeout-ms', '--json'], 'clients plan');
      if (!parsed.ok) return { code: 2, output: `${parsed.message}\n` };
      try {
        const plan = await clientAccessPlanReport({ root, ...parsed.value });
        return hasFlag(ownArgs, '--json') ? json(plan) : { code: 0, output: renderClientAccessPlan(plan) };
      } catch (error) {
        return { code: 1, output: `${error instanceof Error ? error.message : String(error)}\n` };
      }
    }
    if (action !== 'install' && action !== 'restore') return { code: 2, output: 'clients supports: plan | install | restore\n' };
    const parsed = parseClientWriteCommand(ownArgs, action);
    if (!parsed.ok) return { code: 2, output: `${parsed.message}\n` };
    const homeRaw = value(ownArgs, '--home');
    const base = {
      id: parsed.value.id,
      root,
      configScope: parsed.value.configScope,
      ...(homeRaw === undefined ? {} : { home: resolve(homeRaw) }),
      ...(parsed.value.configPath === undefined ? {} : { configPath: resolve(parsed.value.configPath) }),
      apply: parsed.value.apply,
      grant: parsed.value.grant,
    };
    try {
      if (action === 'install') {
        // --with-hooks：只对 hooks 段做授权写入。ZCode 的 mcp 段仍是只读拒绝
        // （clientInstallSurface 行为不变），这里完全不触碰 mcp 配置。
        if (parsed.value.withHooks) {
          const client = resolveClientId(parsed.value.id);
          if (client !== 'zcode' && client !== 'claude-code') {
            return { code: 2, output: 'clients install --with-hooks is only supported for zcode and claude-code\n' };
          }
          let authorization;
          try {
            authorization = createClientAuthorization(root, client, parsed.value.grant);
          } catch (error) {
            return { code: 2, output: `${error instanceof Error ? error.message : String(error)}\n` };
          }
          const home = homeRaw === undefined ? resolve('~') : resolve(homeRaw);
          const hooksTarget = resolveHooksTarget(client, {
            home,
            root,
            ...(parsed.value.configPath === undefined ? {} : { path: parsed.value.configPath }),
          });
          const hooksResult = installClientHooks(hooksTarget, buildHooksDocument(client, root), {
            mode: parsed.value.apply ? 'apply' : 'dry-run',
            confirm: parsed.value.apply,
            authorization,
            root,
          });
          const code = hooksResult.error !== null ? 1
            : hooksResult.mode === 'dry-run' && !parsed.value.dryRunExplicit ? 1
              : 0;
          if (hasFlag(ownArgs, '--json')) return { code, output: JSON.stringify(hooksResult, null, 2) + '\n' };
          return {
            code,
            output: `client: ${parsed.value.id} (hooks-only)\nhooks: ${hooksResult.applied ? 'installed' : hooksResult.changed ? 'dry-run preview (zero write)' : 'unchanged'}\ntarget: ${hooksResult.targetPath}\n${hooksResult.warnings.join('\n')}\n`.trimEnd() + '\n',
          };
        }
        const outcome = await clientInstallSurface(base);
        if (!outcome.ok) return { code: outcome.exitCode, output: `${outcome.message}\n` };
        let code = 0;
        if (outcome.result.action === 'refused' || outcome.result.action === 'failed') code = 1;
        else if (outcome.result.action === 'dry-run') code = parsed.value.dryRunExplicit ? 0 : 1;
        return hasFlag(ownArgs, '--json')
          ? { code, output: JSON.stringify(outcome.result, null, 2) + '\n' }
          : { code, output: renderClientInstallText(outcome.clientId, outcome.alias, outcome.result) };
      }
      const backupId = value(ownArgs, '--backup-id')!;
      const outcome = await clientRestoreSurface({ ...base, backupId });
      if (!outcome.ok) return { code: outcome.exitCode, output: `${outcome.message}\n` };
      const code = outcome.result.applied ? 0 : (parsed.value.dryRunExplicit && outcome.result.mode === 'dry-run' ? 0 : 1);
      return hasFlag(ownArgs, '--json')
        ? { code, output: JSON.stringify(outcome.result, null, 2) + '\n' }
        : { code, output: renderClientRestoreText(outcome.clientId, outcome.alias, outcome.result) };
    } catch (error) {
      return { code: 1, output: `${error instanceof Error ? error.message : String(error)}\n` };
    }
  }
  if (ownArgs[0] === 'doctor') return json(await doctor(root, { invokedPath: context.invokedPath ?? process.argv[1] }));
  if (ownArgs[0] === 'rebuild') {
    if (ownArgs[1] !== 'graph') return { code: 2, output: 'rebuild currently supports only: rebuild graph\n' };
    return json(await rebuildGraph(root));
  }
  if (ownArgs[0] === 'export') return json(await exportProject(root));
  if (ownArgs[0] === 'connect') {
    const sub = ownArgs[1] && !ownArgs[1].startsWith('--') ? ownArgs[1] : undefined;
    const expectedDigest = value(ownArgs, '--expected-digest');
    if (expectedDigest !== undefined && !/^[0-9a-f]{64}$/iu.test(expectedDigest)) {
      return { code: 2, output: 'connect --expected-digest must be a 64-character sha256 hex digest\n' };
    }
    const options = expectedDigest === undefined ? {} : { expectedDigest };
    if (sub === undefined) {
      const plan = await planConnection(root);
      const result = await connectProject(root, options);
      return { code: result.report.connected ? 0 : 1, output: JSON.stringify({ ...result, plan }, null, 2) + '\n' };
    }
    if (sub === 'plan') return json(await planConnection(root));
    if (sub === 'cutover') {
      const action = ownArgs[2] && !ownArgs[2].startsWith('--') ? ownArgs[2] : 'status';
      if (action === 'status') return json(await cutoverStatusSurface(root));
      if (action === 'confirm') {
        if (!hasFlag(ownArgs, '--confirm')) return { code: 2, output: 'connect cutover confirm requires --confirm\n' };
        const name = value(ownArgs, '--name');
        const role = value(ownArgs, '--role');
        const statement = value(ownArgs, '--statement');
        const sourceDigest = value(ownArgs, '--source-digest');
        const backupId = value(ownArgs, '--backup-id');
        if (!name || !role || !statement || !sourceDigest || !backupId) {
          return { code: 2, output: 'connect cutover confirm requires --name, --role, --statement, --source-digest and --backup-id\n' };
        }
        try {
          return json(await cutoverConfirmSurface(root, { name, role, statement, source_digest: sourceDigest, backup_id: backupId }));
        } catch (error) {
          return { code: 1, output: `${error instanceof Error ? error.message : String(error)}\n` };
        }
      }
      return { code: 2, output: 'connect cutover supports: status | confirm\n' };
    }
    if (sub === 'resume') {
      const result = await connectProject(root, options);
      return { code: result.report.connected ? 0 : 1, output: JSON.stringify(result, null, 2) + '\n' };
    }
    if (sub === 'status') return json(await connectionStatus(root));
    if (sub === 'export') return json(await exportConnection(root));
    if (sub === 'handoff') {
      const readiness = await handoffReadiness(root);
      return { code: readiness.ready ? 0 : 1, output: JSON.stringify(readiness, null, 2) + '\n' };
    }
    if (sub === 'ui') {
      const rawPort = value(ownArgs, '--port');
      const port = rawPort === undefined ? 0 : Number(rawPort);
      if (!Number.isInteger(port) || port < 0 || port > 65535) return { code: 2, output: 'connect ui --port must be an integer between 0 and 65535\n' };
      type ConnectUiHandle = { url: string; port: number; close: () => Promise<void>; server: unknown };
      try {
        // Literal specifier so tsc rewriteRelativeImportExtensions rewrites it
        // for dist; the panel module is optional and never writes project data.
        const { startConnectServer } = await import('./connect-ui.ts') as { startConnectServer: (options: { root: string; port?: number }) => Promise<ConnectUiHandle> };
        const server = await startConnectServer({ root, port });
        return { code: 0, output: `Connect UI listening on ${server.url} (127.0.0.1 only; Ctrl+C to stop)\n` };
      } catch (error) {
        return { code: 2, output: `connect ui unavailable: ${error instanceof Error ? error.message : String(error)}\n` };
      }
    }
    if (sub === 'watch') {
      const rawInterval = value(ownArgs, '--interval');
      let interval: number | undefined;
      if (rawInterval !== undefined) {
        interval = Number(rawInterval);
        if (!Number.isInteger(interval) || interval < MIN_WATCH_INTERVAL_MS) {
          return { code: 2, output: `connect watch --interval must be an integer of at least ${MIN_WATCH_INTERVAL_MS} ms\n` };
        }
      }
      const rawMaxCycles = value(ownArgs, '--max-cycles');
      let maxCycles: number | undefined;
      if (rawMaxCycles !== undefined) {
        maxCycles = Number(rawMaxCycles);
        if (!Number.isInteger(maxCycles) || maxCycles < 1) {
          return { code: 2, output: 'connect watch --max-cycles must be a positive integer\n' };
        }
      }
      // Foreground only: Ctrl+C/SIGTERM aborts the loop, never a background process.
      const controller = new AbortController();
      const onSignal = (): void => controller.abort();
      process.once('SIGINT', onSignal);
      process.once('SIGTERM', onSignal);
      try {
        const report = await watchConnection({
          root,
          ...(interval === undefined ? {} : { intervalMs: interval }),
          ...(maxCycles === undefined ? {} : { maxCycles }),
          signal: controller.signal,
          onCycle: (record) => {
            process.stderr.write(`${JSON.stringify(record)}\n`);
          },
        });
        return {
          code: report.stopped === 'error' ? 1 : 0,
          output: JSON.stringify(report, null, 2) + '\n',
        };
      } finally {
        process.removeListener('SIGINT', onSignal);
        process.removeListener('SIGTERM', onSignal);
      }
    }
    return { code: 2, output: 'connect supports: plan | status | resume | export | handoff | ui | watch | cutover\n' };
  }
  if (ownArgs[0] === 'ui') {
    const rawPort = value(ownArgs, '--port');
    const port = rawPort === undefined ? 0 : Number(rawPort);
    if (!Number.isInteger(port) || port < 0 || port > 65535) return { code: 2, output: 'ui --port must be an integer between 0 and 65535\n' };
    const server = await startUiServer({ root, port });
    return { code: 0, output: `Read-only UI listening on ${server.url} (127.0.0.1 only; Ctrl+C to stop)\n` };
  }
  if (ownArgs[0] === 'baseline') {
    const action = ownArgs[1];
    if (action === 'list') return json(await listBaselines(root));
    if (action === 'verify' && ownArgs[2]) {
      const version = Number(ownArgs[2]);
      if (!Number.isInteger(version) || version <= 0) return { code: 2, output: 'baseline version must be a positive integer\n' };
      const result = await verifyBaseline(root, version);
      return { code: result.valid ? 0 : 1, output: JSON.stringify(result, null, 2) + '\n' };
    }
    if (action === 'draft' && ownArgs[2]) {
      const specPath = resolve(ownArgs[2]);
      const spec = JSON.parse(await readFile(specPath, 'utf8')) as unknown;
      return json(await saveBaselineDraft(root, spec));
    }
    if (action === 'approve' && ownArgs[2]) {
      const version = Number(ownArgs[2]);
      if (!Number.isInteger(version) || version <= 0) return { code: 2, output: 'baseline version must be a positive integer\n' };
      const name = value(ownArgs, '--name');
      const role = value(ownArgs, '--role');
      const statement = value(ownArgs, '--statement');
      const scope = value(ownArgs, '--scope') ?? 'acceptance-baseline';
      if (!hasFlag(ownArgs, '--confirm') || !name || !role || !statement) {
        return { code: 2, output: 'baseline approve requires --name, --role, --statement and --confirm\n' };
      }
      try {
        const result = approveBaseline(root, version, { human: true, tty: true, name, role, scope, statement }, { tty: isInteractiveTty() });
        return json(result);
      } catch (error) {
        if (error instanceof BaselineError && error.code === 'BASELINE_TTY_REQUIRED') return { code: 2, output: `${error.message}\n` };
        throw error;
      }
    }
    return { code: 2, output: 'baseline supports: list | verify <version> | draft <spec.json> | approve <version> (TTY only)\n' };
  }
  if (ownArgs[0] === 'attest') return { code: 2, output: 'attest is not implemented in P7; no attestation capability is claimed.\n' };
  if (ownArgs[0] === 'release') return { code: 2, output: 'release approve is not implemented in P7 and is never exposed as an MCP tool; agents cannot approve releases.\n' };
  if (ownArgs[0] === 'sync' || ownArgs[0] === 'push') return { code: 2, output: `${ownArgs[0]} is not implemented in P7; nothing was pushed or published.\n` };
  return { code: 2, output: `Command is not implemented in the P7 slice: ${argv.join(' ')}\n${help}` };
}
const invokedPath = process.argv[1];
if (invokedPath && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  try {
    const argv = process.argv.slice(2);
    const result = await runCli(argv, { invokedPath });
    // T-166: hooks must emit their JSON on stdout even when exitCode is 2
    // (PreToolUse deny, S8 Q4); the host reads hookSpecificOutput from stdout.
    if (argv[0] === 'hook') process.stdout.write(result.output.trimEnd() + '\n');
    else (result.code === 0 ? console.log : console.error)(result.output.trimEnd());
    process.exitCode = result.code;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
