/**
 * Client takeover / DAG capability mapping (T-086 / MC-08).
 *
 * This module is a read-only mapping layer over the ADR-007 nine-layer client
 * report. For every registered client it derives four capability columns —
 * MCP access, rule takeover, DAG capability and recovery — from the measured
 * `instructions` / `orchestration` layers plus the M10 takeover semantics
 * (managed `AGENTS.md` section, explicit `apply --confirm`, verified-backup
 * restore).
 *
 * Hard rules (ADR-007 §2/§4, ADR-006 §8, T-055):
 * - No public session interface exists, so `orchestration` / DAG is reported as
 *   `degraded` with `mode:'explicit-workflow'` (controller harness), never
 *   `validated`. A CLI doctor success is never amplified into client automatic
 *   dispatch.
 * - `output-interception` is always `unavailable`; tool-level hooks are not
 *   output interception and no automatic interception is claimed.
 * - Host capability is `degraded`: no public output-interception,
 *   auto-approval or auto-session interface was found (T-055).
 * - Unknown clients (DSH / Pi) stay `unavailable` / `status='unknown'`.
 *
 * The mapping never writes client configuration and never performs I/O beyond
 * the `doctorClients` read-only probe it orchestrates.
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  type ClientEvidence,
  type ClientId,
  type ClientReport,
  type ClientStatus,
  type ClientVerdict,
  type ConfigFormat,
  type ConfigScope,
  type LayerReport,
  weakestVerdict,
} from './types.ts';
import { defaultRegistry } from './registry.ts';
import {
  doctorClients,
  registerAllClientAdapters,
  type DoctorReport,
  type DoctorRunOptions,
} from './doctor.ts';

export const CLIENT_TAKEOVER_CAPABILITIES_SCHEMA = 'ano.client-takeover-capabilities/1';

/**
 * T-166 / ADR-013 §2.10: hook enforcement level. Closed vocabulary; only a
 * client with real S8 (or equivalent) hook-validation evidence may claim
 * `hooks-validated`. Public-documentation-only clients are `hooks-documented`;
 * clients without a hook mechanism are `instructions-only` or `unavailable`.
 * This layer is independent of, and never weakens, `output-interception`.
 */
export const HOOK_ENFORCEMENT_LEVELS = [
  'hooks-validated',
  'hooks-documented',
  'instructions-only',
  'unavailable',
] as const;
export type HookEnforcementLevel = (typeof HOOK_ENFORCEMENT_LEVELS)[number];

/**
 * T-055 host-capability conclusions, encoded as explicit constants so tests and
 * docs can assert the degradation without re-deriving it.
 */
export const HOST_AUTO_INTERCEPTION_AVAILABLE = false;
export const HOST_AUTO_APPROVAL_AVAILABLE = false;
export const HOST_AUTO_SESSION_DAEMON_AVAILABLE = false;

/** The four reported capability columns, in stable order. */
export const CLIENT_CAPABILITY_COLUMNS = ['mcp', 'rules', 'dag', 'recovery'] as const;
export type ClientCapabilityColumn = (typeof CLIENT_CAPABILITY_COLUMNS)[number];

export interface ClientCapabilityJudgement {
  readonly verdict: ClientVerdict;
  readonly evidence: ClientEvidence;
  /** Stability/shape label, e.g. `mcp-stdio`, `explicit-workflow`. */
  readonly mode: string;
  readonly source: string;
  readonly at: string;
  readonly version: string | null;
  readonly limitations: readonly string[];
  readonly details: Readonly<Record<string, unknown>>;
}

export interface ClientTakeoverCapabilities {
  readonly clientId: ClientId;
  readonly alias: string | null;
  readonly status: ClientStatus;
  /** ANO MCP package access: configured + stdio handshake + tools + brief. */
  readonly mcp: ClientCapabilityJudgement;
  /** Project rule takeover: instructions layer + managed-section detection. */
  readonly rules: ClientCapabilityJudgement;
  /** DAG capability: generic explicit scheduler, never client auto-dispatch. */
  readonly dag: ClientCapabilityJudgement;
  /** Recovery: M10 backup/rollback and client-config restore, labelled separately. */
  readonly recovery: ClientCapabilityJudgement;
  /** Always `unavailable`; no automatic output interception is claimed. */
  readonly outputInterception: ClientCapabilityJudgement;
  /**
   * T-166: hook enforcement level; never upgrades `outputInterception`.
   * Optional for source compatibility with pre-T-166 hand-built report fixtures;
   * `mapClientCapabilities` always populates it.
   */
  readonly enforcement?: HookEnforcementLevel;
  /** Host capability layer; fixed `degraded` per T-055 / ADR-006 §8. */
  readonly hostCapability: ClientVerdict;
  readonly generatedAt: string;
  readonly limitations: readonly string[];
}

export interface ClientTakeoverCapabilitiesReport {
  readonly schema: typeof CLIENT_TAKEOVER_CAPABILITIES_SCHEMA;
  readonly generatedAt: string;
  readonly clients: readonly ClientTakeoverCapabilities[];
  readonly limitations: readonly string[];
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function dedupe(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function joinSources(reports: readonly LayerReport[]): string {
  return dedupe(reports.map((report) => report.source).filter((source) => source.length > 0)).join(', ');
}

const EVIDENCE_ORDER: Readonly<Record<ClientEvidence, number>> = {
  absent: 0,
  assumed: 1,
  configured: 2,
  measured: 3,
};

/** The strongest evidence among the MCP-facing layers. */
function strongestEvidence(values: readonly ClientEvidence[]): ClientEvidence {
  let best: ClientEvidence = 'absent';
  for (const value of values) {
    if (EVIDENCE_ORDER[value] > EVIDENCE_ORDER[best]) best = value;
  }
  return best;
}

function isDetected(report: ClientReport): boolean {
  return report.layers.detected.verdict !== 'unavailable';
}

// ---------------------------------------------------------------------------
// Column mappings
// ---------------------------------------------------------------------------

/**
 * MCP column: weakest of the four MCP-facing layers. A `validated` result only
 * means the ANO package can be configured and called; it never means rule or
 * DAG takeover.
 */
function buildMcpJudgement(report: ClientReport, at: string): ClientCapabilityJudgement {
  const layers = report.layers;
  const verdict = weakestVerdict([
    layers.configured.verdict,
    layers.mcp.verdict,
    layers.tools.verdict,
    layers.brief.verdict,
  ]);
  return {
    verdict,
    evidence: strongestEvidence([
      layers.configured.evidence,
      layers.mcp.evidence,
      layers.tools.evidence,
      layers.brief.evidence,
    ]),
    mode: 'mcp-stdio',
    source: joinSources([layers.configured, layers.mcp, layers.tools, layers.brief]),
    at,
    version: layers.mcp.version,
    limitations: dedupe([
      ...layers.configured.limitations,
      ...layers.mcp.limitations,
      ...layers.tools.limitations,
      ...layers.brief.limitations,
      'a successful MCP handshake does not imply configuration is active or takeover is complete',
    ]),
    details: {
      configured: layers.configured.verdict,
      mcp: layers.mcp.verdict,
      tools: layers.tools.verdict,
      brief: layers.brief.verdict,
      coreVerdict: report.coreVerdict,
    },
  };
}

/**
 * Rules column: the instructions layer, capped at `degraded`. Rule-file
 * presence and managed-section detection are read-only facts; installing or
 * updating the managed section requires explicit authorization.
 */
function buildRulesJudgement(report: ClientReport, at: string): ClientCapabilityJudgement {
  const layer = report.layers.instructions;
  const verdict: ClientVerdict = layer.verdict === 'validated' ? 'degraded' : layer.verdict;
  const hasManagedSection = layer.details.hasManagedSection === true;
  return {
    verdict,
    evidence: layer.evidence,
    mode: hasManagedSection ? 'managed-section' : 'detected-only',
    source: layer.source,
    at,
    version: layer.version,
    limitations: dedupe([
      ...layer.limitations,
      'rule file presence does not prove the client read or applied the rules',
      'managed-section write requires explicit authorization and is not performed by this read-only mapping',
    ]),
    details: {
      rulePaths: layer.details.rulePaths,
      formatVersion: layer.details.formatVersion,
      hasManagedSection,
      readOnly: true,
      writePath: 'explicit-apply-confirm',
    },
  };
}

/**
 * DAG column: the generic explicit scheduler (`--plan` dry-run, lease,
 * recovery) is available for a detected client, but client-native automatic
 * dispatch is not. Therefore the column is `degraded` with
 * `mode:'explicit-workflow'`, or `unavailable` for unknown clients.
 */
function buildDagJudgement(report: ClientReport, at: string): ClientCapabilityJudgement {
  const layer = report.layers.orchestration;
  const detected = isDetected(report);
  const verdict: ClientVerdict = detected ? 'degraded' : 'unavailable';
  return {
    verdict,
    evidence: detected ? (layer.evidence === 'measured' ? 'measured' : 'assumed') : 'absent',
    mode: 'explicit-workflow',
    source: detected ? layer.source : `client:${report.clientId}`,
    at,
    version: layer.version,
    limitations: dedupe([
      ...(detected ? layer.limitations : ['detected prerequisite is unavailable']),
      'client-native automatic dispatch is not available; the generic scheduler is driven explicitly through --plan dry-run by the controller harness',
      'CLI doctor success is not evidence of client automatic dispatch',
    ]),
    details: {
      orchestrationVerdict: layer.verdict,
      orchestrationMode: layer.details.mode,
      publicApi: layer.details.publicApi,
      genericScheduler: 'explicit-plan-dry-run',
      autoDispatch: false,
      lease: true,
      recovery: true,
    },
  };
}

/**
 * Recovery column: two separate paths, both requiring explicit authorization
 * and a verified backup. Neither is automatic, so the column is `degraded`
 * for detected clients and `unavailable` for unknown clients.
 */
function buildRecoveryJudgement(report: ClientReport, at: string): ClientCapabilityJudgement {
  const detected = isDetected(report);
  const pathVerdict: ClientVerdict = detected ? 'degraded' : 'unavailable';
  return {
    verdict: pathVerdict,
    evidence: detected ? 'assumed' : 'absent',
    mode: 'verified-backup-restore',
    source: detected ? 'adr-006:backup-rollback+client-config-restore' : `client:${report.clientId}`,
    at,
    version: null,
    limitations: dedupe([
      ...(detected ? [] : ['detected prerequisite is unavailable']),
      'recovery requires explicit --confirm and a verified backup; it is never automatic',
      'M10 takeover recovery and client configuration restore are separate paths',
    ]),
    details: {
      takeoverRecovery: pathVerdict,
      clientConfigRestore: pathVerdict,
      requiresAuthorization: true,
      confirm: true,
      restoreScope: 'restore',
      takeoverBackupPath: '.ano/backup/<id>/',
      clientConfigBackupPath: '.ano/clients/backups/<clientId>/<id>/',
    },
  };
}

/**
 * Output interception is never available: no public interface exists (T-055)
 * and tool-level hooks are not output interception.
 */
function buildOutputInterceptionJudgement(report: ClientReport, at: string): ClientCapabilityJudgement {
  const layer = report.layers['output-interception'];
  return {
    verdict: 'unavailable',
    evidence: 'absent',
    mode: 'none',
    source: layer.source,
    at,
    version: null,
    limitations: dedupe([
      ...layer.limitations,
      'no public output-interception interface is claimed; tool-level hooks are not output interception',
      'automatic output interception is unavailable',
    ]),
    details: {
      publicApi: null,
      hooksAreToolLevel: true,
      configured: false,
      measured: false,
    },
  };
}

/**
 * T-166 hook enforcement level (ADR-013 §2.10). ZCode alone has real S8 host
 * evidence and is `hooks-validated`; Claude Code is public-documentation-only
 * (`hooks-documented`); a detected client with an instructions carrier is
 * `instructions-only`; everything else is `unavailable`. This is a label only:
 * it never changes `outputInterception`, which stays `unavailable`.
 */
export function buildEnforcementLevel(report: ClientReport): HookEnforcementLevel {
  if (report.clientId === 'zcode') return 'hooks-validated';
  if (report.clientId === 'claude-code') return 'hooks-documented';
  if (isDetected(report) && report.layers.instructions.verdict !== 'unavailable') return 'instructions-only';
  return 'unavailable';
}

// ---------------------------------------------------------------------------
// Report mapping
// ---------------------------------------------------------------------------

/** Map one ADR-007 client report into the four takeover/DAG columns. */
export function mapClientCapabilities(report: ClientReport): ClientTakeoverCapabilities {
  const at = report.generatedAt;
  const mcp = buildMcpJudgement(report, at);
  const rules = buildRulesJudgement(report, at);
  const dag = buildDagJudgement(report, at);
  const recovery = buildRecoveryJudgement(report, at);
  const outputInterception = buildOutputInterceptionJudgement(report, at);
  const enforcement = buildEnforcementLevel(report);
  return {
    clientId: report.clientId,
    alias: report.alias,
    status: report.status,
    mcp,
    rules,
    dag,
    recovery,
    outputInterception,
    enforcement,
    hostCapability: 'degraded',
    generatedAt: at,
    limitations: dedupe([
      ...mcp.limitations,
      ...rules.limitations,
      ...dag.limitations,
      ...recovery.limitations,
      ...outputInterception.limitations,
      `hook enforcement level is ${enforcement}; tool-level hooks never become output interception`,
    ]),
  };
}

/** Map a full doctor report; one client failure is already isolated by the doctor. */
export function mapDoctorReport(doctor: DoctorReport): ClientTakeoverCapabilitiesReport {
  return {
    schema: CLIENT_TAKEOVER_CAPABILITIES_SCHEMA,
    generatedAt: doctor.generatedAt,
    clients: doctor.clients.map(mapClientCapabilities),
    limitations: dedupe([
      ...doctor.limitations,
      'read-only mapping: no client configuration was written',
      'no client-native automatic dispatch or output interception is claimed',
      'host capability is degraded: no public output-interception, auto-approval or auto-session interface (T-055)',
    ]),
  };
}

/**
 * Run the read-only doctor orchestration and map every client. Failures are
 * isolated per client by `doctorClients`; this function never throws for a
 * single-client probe failure.
 */
export async function clientTakeoverCapabilities(
  options: DoctorRunOptions = {},
): Promise<ClientTakeoverCapabilitiesReport> {
  return mapDoctorReport(await doctorClients(options));
}

// ---------------------------------------------------------------------------
// Unified access plan (T-098 / CX-08)
// ---------------------------------------------------------------------------

/**
 * The unified capability plan turns the four capability columns into one
 * executable access decision per client:
 *
 * - `mcp`: a public MCP interface is documented and a writable JSON/TOML
 *   configuration target is declared. The plan names the target, the backup
 *   location and the exact apply steps. TOML targets stay dry-run-only because
 *   `config.ts` refuses to write them in v1.
 * - `rules`: no writable MCP target, but a rule/instruction carrier is
 *   documented; the managed section is written through the explicit
 *   apply/confirm path.
 * - `cli`: the vendor CLI is the documented access path (`qoder mcp add`).
 * - `explicit-workflow`: the client exists but exposes no writable local
 *   interface in v1; the generic scheduler is driven explicitly.
 * - `skip`: cloud-only / IDE-plugin-only / unknown identity. No configuration
 *   is generated, so no invalid MCP entry can be written.
 *
 * Every declaration below mirrors an adapter-declared candidate or an explicit
 * adapter refusal. Registry candidates that disagree are recorded in
 * `details.registryCandidateDrift` for the T-102 registry correction; the
 * adapter remains the measured source of truth.
 */

export const CLIENT_ACCESS_PLAN_SCHEMA = 'ano.client-access-plan/1';

export const CLIENT_ACCESS_ROUTES = ['mcp', 'rules', 'cli', 'explicit-workflow', 'skip'] as const;
export type ClientAccessRoute = (typeof CLIENT_ACCESS_ROUTES)[number];

export interface ClientAccessTarget {
  readonly scope: ConfigScope;
  readonly path: string;
  readonly format: ConfigFormat;
  readonly serverPath: readonly string[];
  readonly serverName: string;
  readonly allowedRoot: string;
}

export interface ClientAccessBackupPlan {
  /** Null in a plan; the real id is minted when an authorized apply backs up. */
  readonly backupId: string | null;
  readonly path: string;
  readonly hashAlgorithm: 'sha256';
}

export interface ClientAccessPlan {
  readonly clientId: ClientId;
  readonly alias: string | null;
  readonly status: ClientStatus;
  readonly route: ClientAccessRoute;
  readonly verdict: ClientVerdict;
  readonly evidence: ClientEvidence;
  readonly source: string;
  readonly target: ClientAccessTarget | null;
  readonly needsAuthorization: boolean;
  readonly confirm: boolean;
  readonly backup: ClientAccessBackupPlan | null;
  readonly actions: readonly string[];
  readonly reason: string | null;
  readonly limitations: readonly string[];
  readonly details: Readonly<Record<string, unknown>>;
}

export interface ClientAccessPlanSummary {
  readonly total: number;
  readonly mcp: number;
  readonly rules: number;
  readonly cli: number;
  readonly explicitWorkflow: number;
  readonly skip: number;
  readonly writable: number;
  readonly requireAuthorization: number;
}

export interface ClientAccessPlanReport {
  readonly schema: typeof CLIENT_ACCESS_PLAN_SCHEMA;
  readonly generatedAt: string;
  readonly clients: readonly ClientAccessPlan[];
  readonly summary: ClientAccessPlanSummary;
  readonly limitations: readonly string[];
}

interface ClientAccessDeclaration {
  readonly route: ClientAccessRoute;
  readonly reason: string | null;
  readonly target: {
    readonly scope: ConfigScope;
    readonly path: string;
    readonly format: ConfigFormat;
    readonly serverPath: readonly string[];
    readonly serverName: string;
  } | null;
  readonly rulePaths: readonly string[];
  readonly cli: readonly string[];
}

/**
 * Adapter-measured access declarations. Paths use `~` (home) and `<root>`
 * (project) tokens and are expanded by `resolveAccessTarget`.
 */
const CLIENT_ACCESS_DECLARATIONS: Readonly<Record<ClientId, ClientAccessDeclaration>> = {
  'claude-code': {
    route: 'mcp',
    reason: null,
    target: { scope: 'project', path: '<root>/.mcp.json', format: 'json', serverPath: ['mcpServers'], serverName: 'ano' },
    rulePaths: ['CLAUDE.md'],
    cli: [],
  },
  'github-copilot': {
    route: 'mcp',
    reason: null,
    target: { scope: 'user', path: '~/.copilot/mcp-config.json', format: 'json', serverPath: ['mcpServers'], serverName: 'ano' },
    rulePaths: ['~/.copilot/copilot-instructions.md', '~/.copilot/instructions'],
    cli: [],
  },
  cursor: {
    route: 'mcp',
    reason: null,
    target: { scope: 'project', path: '<root>/.cursor/mcp.json', format: 'json', serverPath: ['mcpServers'], serverName: 'ano' },
    rulePaths: ['.cursorrules', '.cursor/rules'],
    cli: [],
  },
  codex: {
    route: 'mcp',
    // config.ts refuses TOML writes in v1; the plan stays dry-run-only.
    reason: 'codex declares only ~/.codex/config.toml; TOML is read-only in v1, so the plan is dry-run-only',
    target: { scope: 'user', path: '~/.codex/config.toml', format: 'toml', serverPath: ['mcp_servers'], serverName: 'ano' },
    rulePaths: ['AGENTS.md'],
    cli: [],
  },
  trae: {
    route: 'mcp',
    reason: null,
    target: { scope: 'project', path: '<root>/.trae/mcp.json', format: 'json', serverPath: ['mcpServers'], serverName: 'ano' },
    rulePaths: [],
    cli: [],
  },
  antigravity: {
    route: 'mcp',
    reason: null,
    target: { scope: 'user', path: '~/.gemini/config/mcp_config.json', format: 'json', serverPath: ['mcpServers'], serverName: 'ano' },
    rulePaths: [],
    cli: [],
  },
  'replit-agent': {
    route: 'skip',
    reason: 'cloud-only service: no local MCP/configuration interface; refusing to generate an invalid config',
    target: null,
    rulePaths: [],
    cli: [],
  },
  cline: {
    route: 'mcp',
    reason: null,
    target: { scope: 'user', path: '~/.cline/data/settings/cline_mcp_settings.json', format: 'json', serverPath: ['mcpServers'], serverName: 'ano' },
    rulePaths: ['.clinerules', '.cline/rules'],
    cli: [],
  },
  'kilo-code': {
    route: 'mcp',
    reason: 'kilo.jsonc is parsed as JSON by config.ts; commented JSONC degrades to a zero-write plan',
    target: { scope: 'project', path: '<root>/kilo.jsonc', format: 'json', serverPath: ['mcp'], serverName: 'ano' },
    rulePaths: ['.kilo/rules', '.kilocode/rules'],
    cli: [],
  },
  'hermes-agent': {
    route: 'rules',
    reason: 'the documented config carrier is YAML (~/.hermes/config.yaml), which config.ts does not write in v1; rule takeover stays explicit',
    target: null,
    rulePaths: ['~/.hermes/SOUL.md', '.hermes.md', 'HERMES.md', 'AGENTS.md', 'CLAUDE.md', '.cursorrules'],
    cli: ['hermes'],
  },
  openclaw: {
    route: 'explicit-workflow',
    reason: 'official docs do not state an MCP interface (ADR-008 §3); skills/plugins are driven as an explicit workflow and no config is guessed',
    target: null,
    rulePaths: [],
    cli: ['openclaw'],
  },
  zed: {
    route: 'mcp',
    reason: 'the settings file path is not officially confirmed; the plan targets the adapter-declared candidate and stays unverified',
    target: { scope: 'user', path: '~/.config/zed/settings.json', format: 'json', serverPath: ['context_servers'], serverName: 'ano' },
    rulePaths: [],
    cli: [],
  },
  tabnine: {
    route: 'skip',
    reason: 'IDE-plugin + cloud only: no public MCP interface; refusing to generate an invalid config',
    target: null,
    rulePaths: [],
    cli: [],
  },
  'amazon-q': {
    route: 'mcp',
    reason: null,
    target: { scope: 'user', path: '~/.kiro/settings/mcp.json', format: 'json', serverPath: ['mcpServers'], serverName: 'ano' },
    rulePaths: ['~/.kiro/steering', '<root>/.kiro/steering'],
    cli: ['kiro-cli'],
  },
  'jetbrains-ai': {
    route: 'skip',
    reason: 'IDE-plugin only: no public MCP interface; refusing to generate an invalid config',
    target: null,
    rulePaths: [],
    cli: [],
  },
  codegeex: {
    route: 'skip',
    reason: 'IDE-plugin only: no public local MCP interface; refusing to generate an invalid config',
    target: null,
    rulePaths: [],
    cli: [],
  },
  'tongyi-lingma': {
    route: 'mcp',
    reason: null,
    target: { scope: 'user', path: '~/.qoder-cn/settings.json', format: 'json', serverPath: ['mcpServers'], serverName: 'ano' },
    rulePaths: ['AGENTS.md'],
    cli: ['qodercn'],
  },
  comate: {
    route: 'mcp',
    reason: null,
    target: { scope: 'user', path: '~/.comate/mcp.json', format: 'json', serverPath: ['mcpServers'], serverName: 'ano' },
    rulePaths: ['.comate/rules'],
    cli: ['comatecli'],
  },
  qoder: {
    route: 'cli',
    reason: 'the Qoder adapter never writes configuration (T-084); the documented `qoder mcp add|list|remove` CLI is the explicit access path',
    target: null,
    rulePaths: [],
    cli: ['qoder', 'mcp', 'add'],
  },
  codebuddy: {
    route: 'mcp',
    reason: null,
    target: { scope: 'user', path: '~/.codebuddy/.mcp.json', format: 'json', serverPath: ['mcpServers'], serverName: 'ano' },
    rulePaths: ['CODEBUDDY.md', 'rules'],
    cli: ['codebuddy', 'cbc'],
  },
  'deepseek-harness': {
    route: 'explicit-workflow',
    reason: 'the Cordis YAML carrier is not writable by config.ts in v1; ANO is loaded through an explicit Cordis patch workflow',
    target: null,
    rulePaths: [],
    cli: ['dsh'],
  },
  // `dsh` is a ClientId-union alias only; reports always use the canonical id.
  dsh: {
    route: 'explicit-workflow',
    reason: 'the Cordis YAML carrier is not writable by config.ts in v1; ANO is loaded through an explicit Cordis patch workflow',
    target: null,
    rulePaths: [],
    cli: ['dsh'],
  },
  opencode: {
    route: 'mcp',
    reason: null,
    target: { scope: 'project', path: '<root>/opencode.json', format: 'json', serverPath: ['mcp', 'servers'], serverName: 'ano' },
    rulePaths: ['AGENTS.md'],
    cli: [],
  },
  pi: {
    route: 'skip',
    reason: 'identity or interface unclear: no declared public source and no config path may be guessed',
    target: null,
    rulePaths: [],
    cli: [],
  },
  zcode: {
    route: 'skip',
    reason: 'ZCode host configuration is read-only for clients (M5/M10); refusing to modify it',
    target: null,
    rulePaths: ['AGENTS.md'],
    cli: [],
  },
};

function fallbackDeclaration(route: 'explicit-workflow' | 'skip', reason: string): ClientAccessDeclaration {
  return { route, reason, target: null, rulePaths: [], cli: [] };
}

function expandAccessPath(path: string, home: string, root: string): string {
  let value = path;
  if (value === '~') value = home;
  else if (value.startsWith('~/')) value = `${home}/${value.slice(2)}`;
  value = value.split('<root>').join(root);
  return resolve(value);
}

function resolveAccessTarget(
  target: ClientAccessDeclaration['target'],
  home: string,
  root: string,
): ClientAccessTarget | null {
  if (target === null) return null;
  return {
    scope: target.scope,
    path: expandAccessPath(target.path, home, root),
    format: target.format,
    serverPath: target.serverPath,
    serverName: target.serverName,
    allowedRoot: resolve(target.scope === 'user' ? home : root),
  };
}

export interface ClientAccessPlanOptions {
  readonly home?: string;
  readonly root?: string;
}

/** Plan the executable access route for one mapped client. */
export function planClientAccess(
  client: ClientTakeoverCapabilities,
  options: ClientAccessPlanOptions = {},
): ClientAccessPlan {
  const home = options.home ?? homedir();
  const root = options.root ?? process.cwd();
  const declaration = CLIENT_ACCESS_DECLARATIONS[client.clientId] ?? fallbackDeclaration(
    client.status === 'unknown' ? 'skip' : 'explicit-workflow',
    'no adapter-measured access declaration; degraded to an explicit workflow',
  );

  const unknown = client.status === 'unknown';
  const route: ClientAccessRoute = unknown ? 'skip' : declaration.route;
  const reason = unknown
    ? 'identity or interface unclear: no access path is declared and no config may be guessed'
    : declaration.reason;
  const target = route === 'mcp' ? resolveAccessTarget(declaration.target, home, root) : null;
  const writable = target !== null && target.format === 'json';
  const needsAuthorization = route === 'mcp' || route === 'rules';

  const backup: ClientAccessBackupPlan | null =
    route === 'mcp' && target !== null
      ? {
          backupId: null,
          path: join(root, '.ano', 'clients', 'backups', client.clientId),
          hashAlgorithm: 'sha256',
        }
      : null;

  const actions: string[] = [];
  if (route === 'mcp' && target !== null && writable) {
    actions.push('dry-run: plan the ano MCP entry without writing');
    actions.push('apply: authorize with statement + --confirm, back up, atomically write, verify, commit the install record');
  } else if (route === 'mcp') {
    actions.push('dry-run only: the declared config format is read-only in v1; no byte is written');
  } else if (route === 'rules') {
    actions.push('write the managed rule section through the explicit apply --confirm path');
  } else if (route === 'cli') {
    actions.push(`run the vendor CLI explicitly: ${declaration.cli.join(' ')}`);
  } else if (route === 'explicit-workflow') {
    actions.push('drive the generic scheduler explicitly (--plan dry-run); no client auto-dispatch');
  } else {
    actions.push('no writable local interface; skipped without generating a config');
  }

  const verdict: ClientVerdict =
    route === 'mcp'
      ? client.mcp.verdict
      : route === 'rules'
        ? client.rules.verdict
        : weakestVerdict([client.mcp.verdict, client.rules.verdict, client.dag.verdict, client.recovery.verdict]);
  const evidence = strongestEvidence([
    client.mcp.evidence,
    client.rules.evidence,
    client.dag.evidence,
    client.recovery.evidence,
  ]);

  return {
    clientId: client.clientId,
    alias: client.alias,
    status: client.status,
    route,
    verdict,
    evidence,
    source: `client:${client.clientId}`,
    target,
    needsAuthorization,
    confirm: route === 'mcp' || route === 'rules',
    backup,
    actions,
    reason,
    limitations: dedupe([
      ...client.limitations,
      ...(reason === null ? [] : [reason]),
      ...(route === 'mcp' && writable
        ? ['apply requires the declared config file to already exist; config.ts refuses to create a missing file']
        : []),
      'a plan is not a measurement: unverified clients stay unverified until a real probe runs',
    ]),
    details: {
      declarationRoute: declaration.route,
      writable,
      format: target?.format ?? null,
      serverPath: target?.serverPath ?? [],
      rulePaths: declaration.rulePaths,
      cli: declaration.cli,
      mcpVerdict: client.mcp.verdict,
      rulesVerdict: client.rules.verdict,
      dagVerdict: client.dag.verdict,
      recoveryVerdict: client.recovery.verdict,
      registryCandidateDrift:
        client.clientId === 'trae' ||
        client.clientId === 'openclaw' ||
        client.clientId === 'amazon-q' ||
        client.clientId === 'tongyi-lingma' ||
        client.clientId === 'github-copilot',
    },
  };
}

/** Plan every client in a mapped capability report. */
export function planAccessReport(
  report: ClientTakeoverCapabilitiesReport,
  options: ClientAccessPlanOptions = {},
): ClientAccessPlanReport {
  const clients = report.clients.map((client) => planClientAccess(client, options));
  const summary: ClientAccessPlanSummary = {
    total: clients.length,
    mcp: clients.filter((client) => client.route === 'mcp').length,
    rules: clients.filter((client) => client.route === 'rules').length,
    cli: clients.filter((client) => client.route === 'cli').length,
    explicitWorkflow: clients.filter((client) => client.route === 'explicit-workflow').length,
    skip: clients.filter((client) => client.route === 'skip').length,
    writable: clients.filter((client) => client.target !== null && client.target.format === 'json').length,
    requireAuthorization: clients.filter((client) => client.needsAuthorization).length,
  };
  return {
    schema: CLIENT_ACCESS_PLAN_SCHEMA,
    generatedAt: report.generatedAt,
    clients,
    summary,
    limitations: dedupe([
      ...report.limitations,
      'plan is read-only: no client configuration was written',
      'clients without a public MCP interface are skipped; no invalid config is generated',
      'MCP validated means the ANO package is callable, not that rules/DAG/recovery are taken over',
    ]),
  };
}

/**
 * Run the read-only doctor orchestration with the unified adapter assembly and
 * map every client into an executable access plan. Unlike `doctorClients`, this
 * entry point defaults to the real adapters so the plan reflects adapter-measured
 * sources instead of generic probing. Per-client probe failures stay isolated.
 */
export async function clientAccessPlans(
  options: DoctorRunOptions = {},
): Promise<ClientAccessPlanReport> {
  const capabilities = await clientTakeoverCapabilities({
    ...options,
    adapters: options.adapters ?? registerAllClientAdapters(options),
  });
  return planAccessReport(capabilities, {
    ...(options.home === undefined ? {} : { home: options.home }),
    ...(options.root === undefined ? {} : { root: options.root }),
  });
}
