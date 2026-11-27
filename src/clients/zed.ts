/**
 * Zed client adapter (ADR-008 §3/§5/§6, M12/T-093).
 *
 * Implements the four-method `ClientAdapter` contract for the Zed editor.
 * Everything is read-only until `config()` is called with `mode:'apply'`
 * plus an explicit authorization credential; the write itself is delegated to
 * `config.ts` (T-081).
 *
 * Evidence discipline:
 * - `detect` probes only the three declared settings-file candidates. Zed has
 *   no declared executable source in the T-092 registry, so no PATH probe and
 *   no version probe is performed.
 * - File existence is E2 evidence, so `detected` is capped at `degraded`.
 * - The MCP container key `context_servers` and the local entry shape
 *   (`command`/`args`/`env`) are E1 (ADR-008 §3, Zed MCP docs, fetched
 *   2026-11-23). The settings file path is explicitly 待核实 and is reported as
 *   a limitation/warning; no rule/instruction file is declared, so
 *   `instructions` stays `unavailable` and no path is guessed.
 * - `orchestration` is `degraded` + `explicit-workflow`; `history` and
 *   `output-interception` stay `unavailable`.
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
  type BackupPlan,
  type ClientAdapter,
  type ClientReport,
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

export const ZED_SERVER_NAME = 'ano';
export const ZED_SERVER_PATH = ['context_servers'] as const;
export const ZED_LINUX_USER_SETTINGS = join('.config', 'zed', 'settings.json');
export const ZED_WINDOWS_USER_SETTINGS = join('AppData', 'Roaming', 'Zed', 'settings.json');
export const ZED_MACOS_USER_SETTINGS = join('Library', 'Application Support', 'Zed', 'settings.json');
export const ZED_PROJECT_SETTINGS = join('.zed', 'settings.json');

/**
 * Read-only identity sources. Matches the T-092 registry descriptor for `zed`;
 * the adapter never probes an undeclared path.
 */
export const ZED_IDENTITY_SOURCES = [
  { kind: 'config-path', value: '~/.config/zed/settings.json', detail: 'Agent Settings 候选（路径待核实）' },
  { kind: 'config-path', value: '~/AppData/Roaming/Zed/settings.json', detail: 'Windows Agent Settings 候选（路径待核实）' },
  { kind: 'config-path', value: '~/Library/Application Support/Zed/settings.json', detail: 'macOS Agent Settings 候选（路径待核实）' },
] as const;

/** Platform-native user settings path. Exported for deterministic tests. */
export function zedUserSettingsPath(home: string): string {
  if (process.platform === 'win32') return join(home, ZED_WINDOWS_USER_SETTINGS);
  if (process.platform === 'darwin') return join(home, ZED_MACOS_USER_SETTINGS);
  return join(home, ZED_LINUX_USER_SETTINGS);
}

/** All declared user settings candidates, in probe order. */
export function zedUserSettingsCandidates(home: string): readonly string[] {
  return [
    join(home, ZED_LINUX_USER_SETTINGS),
    join(home, ZED_WINDOWS_USER_SETTINGS),
    join(home, ZED_MACOS_USER_SETTINGS),
  ];
}

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
  return { command: 'node', args: [join(packageRoot, 'dist', 'surface', 'mcp.js')], env: {} };
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
  readonly probePaths?: readonly string[] | undefined;
}

function runDetect(context: ProbeContext): DetectResult {
  const at = new Date().toISOString();
  const env = context.env ?? {};
  const home = homeFrom(env);
  const sources: DetectionEvidence[] = [];

  if (home !== null) {
    for (const path of zedUserSettingsCandidates(home)) {
      if (isFile(path)) {
        sources.push({
          source: `config-path:${path}`,
          kind: 'config-path',
          executablePath: null,
          version: null,
          detectedAt: at,
        });
      }
    }
  }

  return {
    clientId: 'zed',
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
  if (context.home !== null) {
    for (const path of zedUserSettingsCandidates(context.home)) {
      candidates.push({
        clientId: 'zed',
        scope: 'user',
        path,
        format: 'json',
        serverPath: [...ZED_SERVER_PATH],
        serverName: ZED_SERVER_NAME,
        allowedRoot: context.home,
      });
    }
  }
  if (context.root !== null) {
    candidates.push({
      clientId: 'zed',
      scope: 'project',
      path: join(context.root, ZED_PROJECT_SETTINGS),
      format: 'json',
      serverPath: [...ZED_SERVER_PATH],
      serverName: ZED_SERVER_NAME,
      allowedRoot: context.root,
    });
  }
  return candidates;
}

function discoverConfig(context: TargetContext, probePaths: readonly string[], at: string): ConfigDiscovery {
  const candidates = configCandidates(context);
  const limitations: string[] = [];
  const errors: IsolatedError[] = [];
  if (candidates.length === 0) {
    limitations.push('no declared config candidate could be resolved from the injected home/root');
  }

  let firstExisting: { path: string; scope: ConfigScope; key: string } | null = null;
  for (const target of candidates) {
    if (!existsSync(target.path)) continue;
    const key = [...target.serverPath, target.serverName].join('.');
    let snapshot;
    try {
      snapshot = readClientConfig(target);
    } catch (error) {
      errors.push({ layer: 'configured', code: 'E2_PARSE_FAILED', message: errorMessage(error), at, source: target.path });
      continue;
    }
    if (!snapshot.exists) continue;
    if (firstExisting === null) firstExisting = { path: target.path, scope: target.scope, key };
    const entry = snapshot.anoEntry;
    if (entry !== null && entry !== undefined) {
      const command = entryCommand(entry);
      const reachable = command !== null ? commandReachableIn(command, probePaths) : isRemoteEntry(entry);
      return {
        configPath: target.path,
        scope: target.scope,
        key,
        entry: redactClientConfigEntry(entry),
        exists: true,
        reachable,
        limitations: reachable ? [] : ['configured entry path is not reachable'],
        errors,
      };
    }
    if (!snapshot.containerFound) {
      limitations.push(`${target.path}: context_servers container was not found`);
    } else {
      limitations.push(`${target.path}: context_servers container has no ano entry`);
    }
  }

  if (firstExisting !== null) {
    return {
      configPath: firstExisting.path,
      scope: firstExisting.scope,
      key: firstExisting.key,
      entry: null,
      exists: true,
      reachable: false,
      limitations,
      errors,
    };
  }
  return { configPath: null, scope: null, key: null, entry: null, exists: false, reachable: false, limitations, errors };
}

function commandReachableIn(command: string, probePaths: readonly string[]): boolean {
  if (command.includes('/') || command.includes('\\')) return isFile(command) || isFile(`${command}.exe`);
  for (const directory of probePaths) {
    for (const suffix of ['', '.exe', '.cmd']) {
      if (isFile(join(directory, `${command}${suffix}`))) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Layer builders
// ---------------------------------------------------------------------------

function buildDetectedLayer(detect: DetectResult, at: string): MutableLayerReports['detected'] {
  const source = detect.sources.length > 0 ? detect.sources.map((entry) => entry.source).join(', ') : 'client:zed';
  if (!detect.detected) {
    return {
      layer: 'detected',
      code: 'E1',
      verdict: 'unavailable',
      evidence: 'absent',
      at,
      version: null,
      source,
      limitations: ['no declared Zed settings file was found; paths were not guessed'],
      errors: detect.errors,
      details: { detected: false, executablePath: null, version: null, sources: detect.sources },
    };
  }
  return {
    layer: 'detected',
    code: 'E1',
    verdict: detect.version !== null ? 'validated' : 'degraded',
    evidence: 'measured',
    at,
    version: detect.version,
    source,
    limitations: [
      'settings-file existence is E2 evidence only; no version was measured',
      'the settings file path is 待核实/unverified; only the context_servers key is E1',
    ],
    errors: detect.errors,
    details: { detected: true, executablePath: null, version: detect.version, sources: detect.sources },
  };
}

function buildConfiguredLayer(detect: DetectResult, discovery: ConfigDiscovery, at: string): MutableLayerReports['configured'] {
  const source = discovery.configPath ?? 'client:zed';
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
      limitations: ['settings file found but no ano context server was found in the declared candidates', ...discovery.limitations],
      errors: discovery.errors,
      details: { configPath: null, scope: discovery.scope, key: discovery.key, resolvedEntry: null, exists: false },
    };
  }
  const limitations = [
    ...(discovery.reachable ? [] : ['configured entry path is not reachable']),
    ...discovery.limitations,
    'no real stdio handshake was performed during inspect',
    'settings path is unverified; entry shape follows the documented local-server form (command/args/env, E1), not measured',
  ];
  return {
    layer: 'configured',
    code: 'E2',
    verdict: 'degraded',
    evidence: 'configured',
    at,
    version: 'config-format:json',
    source,
    limitations,
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

function buildInstructionsLayer(at: string): InstructionsLayerReport {
  return {
    layer: 'instructions',
    code: 'E6',
    verdict: 'unavailable',
    evidence: 'absent',
    at,
    version: null,
    source: 'adr-008:no-declared-rule-file',
    limitations: [
      'no public Zed rule/instruction file is declared; the path is not guessed',
      'Zed MCP servers provide their own instructions; that is not a host instruction takeover',
    ],
    errors: [],
    details: { rulePaths: [], formatVersion: null, hasManagedSection: false, readOnly: true },
  };
}

function buildOrchestrationLayer(at: string): OrchestrationLayerReport {
  return {
    layer: 'orchestration',
    code: 'E7',
    verdict: 'degraded',
    evidence: 'assumed',
    at,
    version: null,
    source: 'adr-008:explicit-workflow-fallback',
    limitations: [
      'no public Zed subagent/dispatch interface was verified',
      'explicit workflow fallback only; automatic dispatch is not claimed',
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
    source: 'adr-008:no-authorized-sample',
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
    source: 'adr-008:no-public-interface',
    limitations: [
      'no public Zed output-interception interface was verified',
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
    instructions: buildInstructionsLayer(at),
    orchestration: buildOrchestrationLayer(at),
    history: buildHistoryLayer(at),
    'output-interception': buildOutputInterceptionLayer(at),
  };
  const coreVerdict = weakestVerdict(CORE_LAYERS.map((layer) => layers[layer].verdict));
  const limitations: string[] = [
    'inspect is read-only and performs no stdio handshake; mcp/tools/brief stay unmeasured',
    'a successful MCP handshake would not imply rule takeover, DAG takeover, history support or output interception',
    'Zed settings path is unverified (待核实); the context_servers key and local entry shape are E1 and not measured',
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
    clientId: 'zed',
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
    if (context.home === null) return { ok: false, error: 'user-scope target requires an injected HOME/USERPROFILE' };
    return { ok: true, path: zedUserSettingsPath(context.home), allowedRoot: context.home };
  }
  if (context.root === null) return { ok: false, error: 'project/workspace target requires an injected root' };
  return { ok: true, path: join(context.root, ZED_PROJECT_SETTINGS), allowedRoot: context.root };
}

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

function dryRun(changes: readonly ProposedChange[], backupPlan: BackupPlan | null, warnings: readonly string[]): ConfigResult {
  return { mode: 'dry-run', changes, backupPlan, warnings };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const zedAdapter: ClientAdapter = {
  id: 'zed',
  identitySources: ZED_IDENTITY_SOURCES,

  async detect(input: DetectInput): Promise<DetectResult> {
    return runDetect({ env: input.env, cwd: input.cwd, probePaths: input.probePaths });
  },

  async inspect(input: InspectInput): Promise<ClientReport> {
    const at = new Date().toISOString();
    const env = input.env;
    const home = homeFrom(env);
    const root = input.root !== undefined ? resolve(input.root) : input.cwd !== undefined ? resolve(input.cwd) : null;
    const detect = runDetect({ env, cwd: input.cwd });
    const probePaths = splitPath(env?.['PATH'] ?? process.env['PATH']);
    const discovery = discoverConfig({ home, root }, probePaths, at);
    return buildReport(detect, discovery, at);
  },

  async config(input: ConfigInput): Promise<ConfigResult> {
    const home = configHome(input);
    const root = input.root !== undefined ? resolve(input.root) : null;
    const resolved = resolveConfigPath(input.target, { home, root });
    if (!resolved.ok) {
      return dryRun([], null, [`config target unresolved: ${resolved.error}; zero write`]);
    }
    const warnings: string[] = [
      'Zed settings file path is unverified (待核实); only the context_servers key and local entry shape are E1',
      'context_servers local entry uses the documented command/args/env shape (E1); not measured on a real Zed install',
    ];
    if (input.target.scope === 'workspace' && input.target.path === undefined) {
      warnings.push('Zed public configuration documents user and project scopes; workspace scope maps to the project .zed/settings.json');
    }
    if (input.target.format === 'toml') {
      warnings.push('Zed settings are JSON; a TOML target is not a documented Zed format');
    }
    const target: ClientConfigTarget = {
      clientId: 'zed',
      scope: input.target.scope,
      path: resolved.path,
      format: input.target.format ?? 'json',
      serverPath: [...ZED_SERVER_PATH],
      serverName: ZED_SERVER_NAME,
      allowedRoot: resolved.allowedRoot,
    };
    const entry = anoEntry();
    let plan;
    try {
      plan = planClientConfig(target, entry);
    } catch (error) {
      return dryRun([], null, [...warnings, `config plan failed: ${errorMessage(error)}; zero write`]);
    }
    const changes = proposedChanges(target, plan.changes);
    const backupPlan = plan.changed && plan.afterHash !== null
      ? { backupId: `planned:${plan.afterHash.slice(0, 16)}`, path: target.path, hashAlgorithm: 'sha256' as const }
      : null;
    const baseWarnings = [...warnings, ...plan.warnings];

    if (input.mode !== 'apply') {
      return dryRun(changes, backupPlan, baseWarnings);
    }
    if (root === null) {
      return dryRun(changes, backupPlan, [...baseWarnings, 'apply refused (project root is required for an authorized write); dry-run only']);
    }
    const authorization = mapAuthorization(input.authorization);
    if (typeof authorization === 'string') {
      return dryRun(changes, backupPlan, [...baseWarnings, `apply refused (${authorization}); dry-run only`]);
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
        return dryRun(changes, backupPlan, [...baseWarnings, ...applied.warnings, reason]);
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
      return dryRun(changes, backupPlan, [...baseWarnings, `apply failed: ${errorMessage(error)}; zero write`]);
    }
  },

  async verify(input: VerifyInput): Promise<VerifyResult> {
    return verifyStdioMcp(input);
  },
};
