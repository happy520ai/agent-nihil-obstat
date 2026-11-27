/**
 * Trae client adapter (ADR-008 §3/§5, M12/T-094).
 *
 * Implements the four-method `ClientAdapter` contract for Trae (editor + cloud
 * Web). Everything is read-only until `config()` is called with `mode:'apply'`
 * plus an explicit authorization credential; the write is delegated to
 * `config.ts` (T-081), which owns backup/hash/drift/rollback and merge
 * preservation.
 *
 * Public evidence (official docs fetched 2026-11-23, E1):
 * - Project MCP configuration lives at `<root>/.trae/mcp.json` with the
 *   `mcpServers` container; stdio entries use `command`/`args`/`env`, HTTP
 *   entries use `url`/`headers` (`https://docs.trae.cn/ide_add-mcp-servers`,
 *   `https://docs.trae.cn/ide_model-context-protocol`).
 * - A user-level `mcp.json` is mentioned by the same docs but its directory is
 *   not documented, so it is NOT declared as a candidate. Guessing it would
 *   violate ADR-008 §3/§5.
 *
 * The adapter never executes configuration content, never spawns a server from
 * `inspect`, and never reports a cloud/Web capability as local control.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLIENT_REPORT_SCHEMA,
  CORE_LAYERS,
  EXTENSION_LAYERS,
  MCP_TOOL_NAMES,
  weakestVerdict,
  type BriefLayerReport,
  type ClientAdapter,
  type ClientReport,
  type ClientVerdict,
  type ConfigInput,
  type ConfigResult,
  type ConfigScope,
  type ConfigTarget,
  type DetectInput,
  type DetectResult,
  type DetectionEvidence,
  type HistoryLayerReport,
  type InspectInput,
  type InstructionsLayerReport,
  type IsolatedError,
  type MutableLayerReports,
  type OrchestrationLayerReport,
  type OutputInterceptionLayerReport,
  type ProposedChange,
  type VerifyInput,
  type VerifyResult,
} from './types.ts';
import {
  applyClientConfig,
  planClientConfig,
  readClientConfig,
  type ClientConfigAuthorization,
  type ClientConfigChange,
  type ClientConfigTarget,
} from './config.ts';
import { verifyStdioMcp } from './doctor.ts';
import { redactClientConfigEntry } from './redact.ts';

// ---------------------------------------------------------------------------
// Declared identity and configuration metadata
// ---------------------------------------------------------------------------

export const TRAE_SERVER_NAME = 'ano';
export const TRAE_SERVER_PATH = ['mcpServers'] as const;
export const TRAE_PROJECT_CONFIG = join('.trae', 'mcp.json');
/** Documented global config basename; the directory is not public, so it is not a candidate. */
export const TRAE_GLOBAL_CONFIG_BASENAME = 'mcp.json';

/**
 * Read-only identity sources. Only the publicly documented project MCP config
 * path is declared; no executable name and no user-level path are guessed.
 */
export const TRAE_IDENTITY_SOURCES = [
  {
    kind: 'config-path',
    value: '.trae/mcp.json',
    detail: 'project MCP config (official Trae docs, E1)',
  },
] as const;

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function envValue(env: Record<string, string> | undefined, key: string): string | null {
  if (env === undefined) return null;
  const value = env[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function homeFrom(env: Record<string, string> | undefined): string | null {
  return envValue(env, 'HOME') ?? envValue(env, 'USERPROFILE');
}

function splitPath(value: string | undefined): readonly string[] {
  if (typeof value !== 'string' || value.length === 0) return [];
  return value.split(delimiter).filter((part) => part.length > 0);
}

function commandReachable(command: string, probePaths: readonly string[]): boolean {
  if (command.includes('/') || command.includes('\\')) {
    return isFile(command) || isFile(`${command}.exe`) || isFile(`${command}.cmd`);
  }
  for (const directory of probePaths) {
    for (const suffix of ['', '.exe', '.cmd']) {
      if (isFile(join(directory, `${command}${suffix}`))) return true;
    }
  }
  return false;
}

function entryCommand(entry: unknown): string | null {
  if (typeof entry === 'string' && entry.length > 0) return entry;
  if (entry === null || typeof entry !== 'object') return null;
  const record = entry as Record<string, unknown>;
  const command = record['command'];
  if (typeof command === 'string' && command.length > 0) return command;
  const cmd = record['cmd'];
  if (typeof cmd === 'string' && cmd.length > 0) return cmd;
  return null;
}

function isRemoteEntry(entry: unknown): boolean {
  if (entry === null || typeof entry !== 'object') return false;
  return typeof (entry as Record<string, unknown>)['url'] === 'string';
}

/** The ANO MCP entry published by this package (`package.json` `mcp` field). */
function anoEntry(): Record<string, unknown> {
  const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
  return { command: 'node', args: [join(packageRoot, 'dist', 'surface', 'mcp.js')] };
}

function proposedChanges(target: ClientConfigTarget, changes: readonly ClientConfigChange[]): ProposedChange[] {
  return changes.map((change) => ({
    path: target.path,
    scope: target.scope,
    key: [...change.serverPath, change.serverName].join('.'),
    operation:
      change.kind === 'add-server'
        ? 'add'
        : change.kind === 'update-server'
          ? 'update'
          : change.kind === 'remove-server'
            ? 'remove'
            : 'none',
    before: change.before,
    after: change.after,
  }));
}

// ---------------------------------------------------------------------------
// detect
// ---------------------------------------------------------------------------

interface ProbeContext {
  readonly env?: Record<string, string> | undefined;
  readonly cwd?: string | undefined;
}

function runDetect(context: ProbeContext): DetectResult {
  const at = new Date().toISOString();
  const cwd = context.cwd ?? process.cwd();
  const sources: DetectionEvidence[] = [];
  const projectConfig = resolve(cwd, TRAE_PROJECT_CONFIG);
  if (isFile(projectConfig)) {
    sources.push({
      source: `path:${projectConfig}`,
      kind: 'config-path',
      executablePath: null,
      version: null,
      detectedAt: at,
    });
  }
  return {
    clientId: 'trae',
    detected: sources.length > 0,
    executablePath: null,
    version: null,
    sources,
    errors: [],
  };
}

// ---------------------------------------------------------------------------
// read-only configuration discovery
// ---------------------------------------------------------------------------

interface TargetContext {
  readonly home: string | null;
  readonly root: string | null;
}

interface ConfigDiscovery {
  readonly configPath: string | null;
  readonly scope: ConfigScope | null;
  readonly key: string | null;
  readonly entry: unknown;
  readonly exists: boolean;
  readonly reachable: boolean;
  readonly limitations: readonly string[];
  readonly errors: readonly IsolatedError[];
}

function configCandidates(context: TargetContext): ClientConfigTarget[] {
  const candidates: ClientConfigTarget[] = [];
  if (context.root !== null) {
    candidates.push({
      clientId: 'trae',
      scope: 'project',
      path: join(context.root, TRAE_PROJECT_CONFIG),
      format: 'json',
      serverPath: [...TRAE_SERVER_PATH],
      serverName: TRAE_SERVER_NAME,
      allowedRoot: context.root,
    });
  }
  return candidates;
}

function discoverConfig(context: TargetContext, probePaths: readonly string[]): ConfigDiscovery {
  const candidates = configCandidates(context);
  const limitations: string[] = [];
  const errors: IsolatedError[] = [];
  if (candidates.length === 0) {
    limitations.push('no declared config candidate could be resolved from the injected root');
  }
  limitations.push(
    `user-level Trae MCP config is documented only as "${TRAE_GLOBAL_CONFIG_BASENAME}" without a public directory; it is not declared as a candidate`,
  );
  for (const target of candidates) {
    if (!existsSync(target.path)) continue;
    const key = [...target.serverPath, target.serverName].join('.');
    let snapshot;
    try {
      snapshot = readClientConfig(target);
    } catch (error) {
      errors.push({ layer: 'configured', code: 'E2_PARSE_FAILED', message: errorMessage(error), at: new Date().toISOString(), source: target.path });
      continue;
    }
    if (!snapshot.exists) {
      limitations.push('declared config file does not exist');
      continue;
    }
    if (!snapshot.containerFound) {
      limitations.push('config file exists but the mcpServers container was not found');
      return { configPath: target.path, scope: target.scope, key, entry: null, exists: true, reachable: false, limitations, errors };
    }
    const entry = snapshot.anoEntry;
    if (entry === null || entry === undefined) {
      limitations.push('config file has an mcpServers container but no ano entry');
      return { configPath: target.path, scope: target.scope, key, entry: null, exists: true, reachable: false, limitations, errors };
    }
    const command = entryCommand(entry);
    const reachable = command !== null ? commandReachable(command, probePaths) : isRemoteEntry(entry);
    if (!reachable) limitations.push('configured entry path is not reachable');
    return { configPath: target.path, scope: target.scope, key, entry: redactClientConfigEntry(entry), exists: true, reachable, limitations, errors };
  }
  return { configPath: null, scope: null, key: null, entry: null, exists: false, reachable: false, limitations, errors };
}

// ---------------------------------------------------------------------------
// Layer builders
// ---------------------------------------------------------------------------

function buildDetectedLayer(detect: DetectResult, at: string): MutableLayerReports['detected'] {
  const source = detect.sources.length > 0 ? detect.sources.map((entry) => entry.source).join(', ') : 'client:trae';
  const limitations: string[] = [];
  let verdict: ClientVerdict;
  if (!detect.detected) {
    verdict = 'unavailable';
    limitations.push('no declared Trae identity source was found; a cloud/Web login is not probed');
  } else {
    verdict = 'degraded';
    limitations.push('detection lacks both an executable path and a version (config-file presence is E2 only)');
  }
  return {
    layer: 'detected',
    code: 'E1',
    verdict,
    evidence: detect.detected ? 'measured' : 'absent',
    at,
    version: detect.version,
    source,
    limitations,
    errors: detect.errors,
    details: {
      detected: detect.detected,
      executablePath: detect.executablePath,
      version: detect.version,
      sources: detect.sources,
    },
  };
}

function buildConfiguredLayer(detect: DetectResult, discovery: ConfigDiscovery, at: string): MutableLayerReports['configured'] {
  const source = discovery.configPath ?? 'client:trae';
  if (!detect.detected) {
    return {
      layer: 'configured',
      code: 'E2',
      verdict: 'unavailable',
      evidence: 'absent',
      at,
      version: null,
      source,
      limitations: ['detected prerequisite is unavailable; configured is not guessed'],
      errors: [],
      details: { configPath: null, scope: null, key: null, resolvedEntry: null, exists: false },
    };
  }
  if (!discovery.exists) {
    return {
      layer: 'configured',
      code: 'E2',
      verdict: 'degraded',
      evidence: 'absent',
      at,
      version: null,
      source,
      limitations: ['installed but no ano MCP entry was found in the declared config candidates', ...discovery.limitations],
      errors: discovery.errors,
      details: { configPath: null, scope: discovery.scope, key: discovery.key, resolvedEntry: null, exists: false },
    };
  }
  return {
    layer: 'configured',
    code: 'E2',
    verdict: 'degraded',
    evidence: 'configured',
    at,
    version: 'config-format:json',
    source,
    limitations: [
      ...(discovery.reachable ? [] : ['configured entry path is not reachable']),
      ...discovery.limitations,
      'no real stdio handshake was performed during inspect',
    ],
    errors: discovery.errors,
    details: {
      configPath: discovery.configPath,
      scope: discovery.scope,
      key: discovery.key,
      resolvedEntry: discovery.entry,
      exists: true,
    },
  };
}

function buildInstructionsLayer(detect: DetectResult, at: string): InstructionsLayerReport {
  if (!detect.detected) {
    return {
      layer: 'instructions',
      code: 'E6',
      verdict: 'unavailable',
      evidence: 'absent',
      at,
      version: null,
      source: 'client:trae',
      limitations: ['detected prerequisite is unavailable'],
      errors: [],
      details: { rulePaths: [], formatVersion: null, hasManagedSection: false, readOnly: true },
    };
  }
  return {
    layer: 'instructions',
    code: 'E6',
    verdict: 'degraded',
    evidence: 'absent',
    at,
    version: null,
    source: 'client:trae',
    limitations: [
      'no Trae rule/instruction file is publicly documented; custom agents/skills are not rule takeover',
      'rule detection is read-only; writing rules requires explicit authorization',
    ],
    errors: [],
    details: { rulePaths: [], formatVersion: null, hasManagedSection: false, readOnly: true },
  };
}

function buildOrchestrationLayer(detect: DetectResult, at: string): OrchestrationLayerReport {
  if (!detect.detected) {
    return {
      layer: 'orchestration',
      code: 'E7',
      verdict: 'unavailable',
      evidence: 'absent',
      at,
      version: null,
      source: 'client:trae',
      limitations: ['detected prerequisite is unavailable'],
      errors: [],
      details: { publicApi: null, documented: false, mode: 'none', measured: false },
    };
  }
  return {
    layer: 'orchestration',
    code: 'E7',
    verdict: 'degraded',
    evidence: 'assumed',
    at,
    version: null,
    source: 'adr-007:explicit-workflow-fallback',
    limitations: [
      'no public Trae dispatch/orchestration interface was verified',
      'cloud Web/agent capability is not local MCP dispatch and is not claimed as takeover',
      'explicit workflow / harness fallback only; automatic dispatch is not claimed',
    ],
    errors: [],
    details: { publicApi: null, documented: false, mode: 'explicit-workflow', measured: false },
  };
}

function buildHistoryLayer(at: string): HistoryLayerReport {
  return {
    layer: 'history',
    code: 'E8',
    verdict: 'unavailable',
    evidence: 'absent',
    at,
    version: null,
    source: 'adr-007:no-authorized-sample',
    limitations: [
      'requires an authorized sample or a public format; synthetic fixtures do not upgrade this layer',
      'real session content and secrets are never read',
    ],
    errors: [],
    details: { source: null, formatVersion: null, sampleAuthorized: false, parsedRecords: 0, privacy: 'not-read' },
  };
}

function buildOutputInterceptionLayer(at: string): OutputInterceptionLayerReport {
  return {
    layer: 'output-interception',
    code: 'E9',
    verdict: 'unavailable',
    evidence: 'absent',
    at,
    version: null,
    source: 'adr-007:no-public-interface',
    limitations: [
      'no public Trae output-interception interface was verified',
      'tool-level hooks are not output interception',
    ],
    errors: [],
    details: { publicApi: null, hooksAreToolLevel: true, configured: false, measured: false },
  };
}

function unavailableMcpLayer(at: string): MutableLayerReports['mcp'] {
  return {
    layer: 'mcp',
    code: 'E3',
    verdict: 'unavailable',
    evidence: 'absent',
    at,
    version: null,
    source: 'inspect:read-only',
    limitations: ['inspect does not spawn a stdio server; call verify() for a real handshake'],
    errors: [],
    details: { transport: 'stdio', protocolVersion: null, serverInfo: null, latencyMs: null, startedAt: null },
  };
}

function unavailableToolsLayer(at: string): MutableLayerReports['tools'] {
  return {
    layer: 'tools',
    code: 'E4',
    verdict: 'unavailable',
    evidence: 'absent',
    at,
    version: null,
    source: 'inspect:read-only',
    limitations: ['tools/list was not requested during inspect'],
    errors: [],
    details: { count: 0, names: [], missing: [...MCP_TOOL_NAMES], extra: [] },
  };
}

function unavailableBriefLayer(at: string): BriefLayerReport {
  return {
    layer: 'brief',
    code: 'E5',
    verdict: 'unavailable',
    evidence: 'absent',
    at,
    version: null,
    source: 'inspect:read-only',
    limitations: ['brief was not called during inspect'],
    errors: [],
    details: { schema: null, hasProjectContext: false, takeoverProjection: false, hostCapability: null },
  };
}

function buildReport(detect: DetectResult, discovery: ConfigDiscovery, at: string): ClientReport {
  const layers: MutableLayerReports = {
    detected: buildDetectedLayer(detect, at),
    configured: buildConfiguredLayer(detect, discovery, at),
    mcp: unavailableMcpLayer(at),
    tools: unavailableToolsLayer(at),
    brief: unavailableBriefLayer(at),
    instructions: buildInstructionsLayer(detect, at),
    orchestration: buildOrchestrationLayer(detect, at),
    history: buildHistoryLayer(at),
    'output-interception': buildOutputInterceptionLayer(at),
  };
  const coreVerdict = weakestVerdict(CORE_LAYERS.map((layer) => layers[layer].verdict));
  const limitations: string[] = [
    'inspect is read-only and performs no stdio handshake; mcp/tools/brief stay unmeasured',
    'a successful MCP handshake would not imply rule takeover, DAG takeover, history support or output interception',
    'Trae cloud/Web capability is not local control and is never reported as validated local takeover',
  ];
  for (const layer of EXTENSION_LAYERS) {
    const report = layers[layer];
    if (report.verdict === 'unavailable') {
      limitations.push(`${layer} unavailable: ${report.limitations[0] ?? 'not measured'}`);
    }
  }
  const status: ClientReport['status'] = !detect.detected ? 'unavailable' : coreVerdict === 'validated' ? 'ready' : 'degraded';
  return {
    schema: CLIENT_REPORT_SCHEMA,
    clientId: 'trae',
    alias: null,
    status,
    coreVerdict,
    layers,
    generatedAt: at,
    limitations,
    errors: [...detect.errors, ...discovery.errors],
  };
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

type ResolvedConfigPath =
  | { readonly ok: true; readonly path: string; readonly allowedRoot: string }
  | { readonly ok: false; readonly error: string };

function resolveConfigPath(spec: ConfigTarget, context: TargetContext): ResolvedConfigPath {
  if (typeof spec.path === 'string' && spec.path.trim().length > 0) {
    const path = resolve(spec.path);
    const allowedRoot = spec.scope === 'user' ? context.home ?? dirname(path) : context.root ?? dirname(path);
    return { ok: true, path, allowedRoot };
  }
  if (spec.scope === 'user') {
    // The user-level file name is public but its directory is not; refuse to guess.
    return { ok: false, error: 'user-scope Trae MCP config has no publicly documented directory; only the project .trae/mcp.json is declared' };
  }
  if (context.root === null) return { ok: false, error: 'project/workspace target requires an injected root' };
  return { ok: true, path: join(context.root, TRAE_PROJECT_CONFIG), allowedRoot: context.root };
}

/**
 * `ConfigInput` (T-080) has no `env` field. Production falls back to
 * `process.env`; tests inject `env` through a structurally-compatible object so
 * no real user home is read.
 */
function configEnv(input: ConfigInput): Record<string, string> | undefined {
  const extra = (input as { readonly env?: unknown }).env;
  if (extra !== undefined && extra !== null && typeof extra === 'object' && !Array.isArray(extra)) {
    return extra as Record<string, string>;
  }
  return undefined;
}

function configHome(input: ConfigInput): string | null {
  return homeFrom(configEnv(input)) ?? homeFrom(process.env as Record<string, string>);
}

function mapAuthorization(ref: ConfigInput['authorization']): ClientConfigAuthorization | string {
  if (ref === undefined || ref === null) return 'missing authorization credential';
  const statement = (ref as { readonly statement?: unknown }).statement;
  if (typeof statement !== 'string' || statement.trim().length === 0) {
    return 'authorization reference lacks the auditable statement required by the T-081 write path';
  }
  return {
    authorizationId: ref.authorizationId,
    root: ref.root,
    clientId: ref.clientId,
    scope: ref.scope,
    grantedBy: ref.grantedBy,
    statement,
    grantedAt: ref.grantedAt,
    ...(ref.revokedAt === undefined ? {} : { revokedAt: ref.revokedAt }),
  };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const traeAdapter: ClientAdapter = {
  id: 'trae',
  identitySources: TRAE_IDENTITY_SOURCES,

  async detect(input: DetectInput): Promise<DetectResult> {
    return runDetect({ env: input.env, cwd: input.cwd });
  },

  async inspect(input: InspectInput): Promise<ClientReport> {
    const at = new Date().toISOString();
    const env = input.env;
    const home = homeFrom(env);
    const root = input.root !== undefined ? resolve(input.root) : input.cwd !== undefined ? resolve(input.cwd) : null;
    const detect = runDetect({ env, cwd: input.cwd });
    const probePaths = splitPath(env?.['PATH'] ?? process.env['PATH']);
    const discovery = discoverConfig({ home, root }, probePaths);
    return buildReport(detect, discovery, at);
  },

  async config(input: ConfigInput): Promise<ConfigResult> {
    const home = configHome(input);
    const root = input.root !== undefined ? resolve(input.root) : null;
    const resolved = resolveConfigPath(input.target, { home, root });
    if (!resolved.ok) {
      return { mode: 'dry-run', changes: [], backupPlan: null, warnings: [`config target unresolved: ${resolved.error}; zero write`] };
    }
    const warnings: string[] = [];
    if (input.target.scope === 'workspace' && input.target.path === undefined) {
      warnings.push('Trae public configuration documents a project .trae/mcp.json; workspace scope maps to that file');
    }
    if (input.target.format === 'toml') {
      warnings.push('Trae public configuration is JSON; a TOML target is not a documented Trae format');
    }
    const target: ClientConfigTarget = {
      clientId: 'trae',
      scope: input.target.scope,
      path: resolved.path,
      format: input.target.format ?? 'json',
      serverPath: [...TRAE_SERVER_PATH],
      serverName: TRAE_SERVER_NAME,
      allowedRoot: resolved.allowedRoot,
    };
    const entry = anoEntry();
    let plan;
    try {
      plan = planClientConfig(target, entry);
    } catch (error) {
      return { mode: 'dry-run', changes: [], backupPlan: null, warnings: [...warnings, `config plan failed: ${errorMessage(error)}; zero write`] };
    }
    const changes = proposedChanges(target, plan.changes);
    const backupPlan = plan.changed && plan.afterHash !== null
      ? { backupId: `planned:${plan.afterHash.slice(0, 16)}`, path: target.path, hashAlgorithm: 'sha256' as const }
      : null;
    const baseWarnings = [...warnings, ...plan.warnings];

    if (input.mode !== 'apply') {
      return { mode: 'dry-run', changes, backupPlan, warnings: baseWarnings };
    }
    if (root === null) {
      return { mode: 'dry-run', changes, backupPlan, warnings: [...baseWarnings, 'apply refused (project root is required for an authorized write); dry-run only'] };
    }
    const authorization = mapAuthorization(input.authorization);
    if (typeof authorization === 'string') {
      return { mode: 'dry-run', changes, backupPlan, warnings: [...baseWarnings, `apply refused (${authorization}); dry-run only`] };
    }
    try {
      const applied = applyClientConfig(target, entry, {
        mode: 'apply',
        confirm: true,
        authorization,
        backup: input.backup ?? true,
        root,
      });
      if (!applied.applied) {
        const reason = applied.changed ? 'apply refused; dry-run only' : 'configuration already matches the desired entry; zero write';
        return { mode: 'dry-run', changes, backupPlan, warnings: [...baseWarnings, ...applied.warnings, reason] };
      }
      return {
        mode: 'apply',
        backupId: applied.backupId ?? '',
        backupHash: applied.backupHash ?? '',
        beforeHash: applied.beforeHash ?? '',
        afterHash: applied.afterHash ?? '',
        changes,
        restoredOnFailure: applied.restoredOnFailure,
      };
    } catch (error) {
      return { mode: 'dry-run', changes, backupPlan, warnings: [...baseWarnings, `apply failed: ${errorMessage(error)}; zero write`] };
    }
  },

  async verify(input: VerifyInput): Promise<VerifyResult> {
    return verifyStdioMcp(input);
  },
};
