/**
 * OpenClaw adapter (ADR-007 §5, ADR-008 §3, M12/T-095).
 *
 * OpenClaw is a self-hosted agent framework / CLI / desktop app. Public
 * interface evidence (E1, see docs/evidence/client-open-agents.md):
 * - Configuration lives in `~/.openclaw/openclaw.json`; the documented MCP
 *   client-side registry key is `mcp.servers.<name>`. A stdio definition is
 *   `{ command, args, cwd, env, transport:"stdio", enabled }`; an HTTP
 *   definition is `{ url, transport:"streamable-http"|"sse", headers, ... }`.
 *   `openclaw mcp add|list|show|set|unset|doctor|probe` manage those entries,
 *   while `openclaw mcp serve` exposes OpenClaw itself as an MCP server.
 * - Skills/plugins are documented mechanisms (ClawHub, npm, git, local) but no
 *   public rule-file path is documented, so `instructions` stays `degraded`
 *   with `evidence:'absent'` rather than guessing a directory.
 * - Multi-agent routing (sessions/agents/swarm/subagents) is documented as CLI
 *   surfaces, not as a public DAG dispatch API, so `orchestration` stays
 *   `degraded` with `mode:'explicit-workflow'`.
 *
 * Hard boundaries: `detect`/`inspect` are read-only and never execute
 * configuration content; `config` defaults to dry-run and delegates every write
 * to `src/clients/config.ts` (T-081) with an explicit authorization; `verify`
 * reuses the T-080 stdio handshake. The T-091 "MCP 待核实" label is superseded
 * by the E1 evidence below, but no local measurement is claimed.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLIENT_REPORT_SCHEMA,
  CORE_LAYERS,
  EXTENSION_LAYERS,
  MCP_TOOL_NAMES,
  weakestVerdict,
  type BriefLayerReport,
  type ClientAdapter,
  type ClientId,
  type ClientReport,
  type ConfigInput,
  type ConfigResult,
  type ConfigScope,
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
import { defaultRegistry } from './registry.ts';
import { allowedRootForPath } from './scope.ts';
import { redactClientConfigEntry } from './redact.ts';

export const OPENCLAW_SERVER_NAME = 'ano';
export const OPENCLAW_SERVER_PATH = ['mcp', 'servers'] as const;
export const OPENCLAW_USER_CONFIG = join('.openclaw', 'openclaw.json');

/** Declared identity sources; identical to the T-092 registry descriptor. */
const DESCRIPTOR = defaultRegistry.get('openclaw');
export const OPENCLAW_IDENTITY_SOURCES = DESCRIPTOR.identitySources;

export interface OpenClawAdapterOptions {
  /** Injected home directory; defaults to the process home. Tests must inject. */
  readonly home?: string;
  /** Default project root. */
  readonly root?: string;
  readonly env?: Record<string, string>;
  readonly probePaths?: readonly string[];
  /** Clock injection for deterministic reports. */
  readonly now?: () => string;
}

interface AdapterContext {
  readonly home: string;
  readonly root: string;
  readonly env: Record<string, string>;
  readonly probePaths: readonly string[];
  readonly now: () => string;
}

interface ConfigDiscovery {
  readonly configPath: string | null;
  readonly scope: ConfigScope | null;
  readonly key: string | null;
  readonly resolvedEntry: unknown;
  readonly exists: boolean;
  readonly reachable: boolean;
  readonly sawCandidateFile: boolean;
  readonly limitations: readonly string[];
  readonly errors: readonly IsolatedError[];
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isolated(layer: IsolatedError['layer'], code: string, message: string, at: string, source: string | null): IsolatedError {
  return { layer, code, message, at, source };
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function splitPath(value: string | undefined): readonly string[] {
  if (typeof value !== 'string' || value.length === 0) return [];
  return value.split(delimiter).filter((part) => part.length > 0);
}

function dedupe(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function expandPath(value: string, home: string, root: string): string {
  let expanded: string;
  if (value === '~') expanded = home;
  else if (value.startsWith('~/')) expanded = join(home, value.slice(2));
  else if (value.startsWith('~\\')) expanded = join(home, value.slice(2));
  else if (isAbsolute(value)) expanded = value;
  else expanded = join(root, value);
  return resolve(expanded);
}

function findExecutable(name: string, directories: readonly string[]): string | null {
  for (const directory of directories) {
    for (const suffix of ['', '.exe', '.cmd']) {
      const candidate = join(directory, `${name}${suffix}`);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

function commandReachable(command: string, probePaths: readonly string[]): boolean {
  if (command.includes('/') || command.includes('\\')) {
    return isFile(command) || isFile(`${command}.exe`) || isFile(`${command}.cmd`);
  }
  return findExecutable(command, probePaths) !== null;
}

function entryCommand(entry: unknown): string | null {
  if (typeof entry === 'string' && entry.length > 0) return entry;
  if (entry === null || typeof entry !== 'object') return null;
  const record = entry as Record<string, unknown>;
  const command = record['command'];
  if (typeof command === 'string' && command.length > 0) return command;
  return null;
}

function isRemoteEntry(entry: unknown): boolean {
  if (entry === null || typeof entry !== 'object') return false;
  return typeof (entry as Record<string, unknown>)['url'] === 'string';
}

function resolveContext(
  options: OpenClawAdapterOptions,
  input: { readonly root?: string | undefined; readonly env?: Record<string, string> | undefined; readonly probePaths?: readonly string[] | undefined },
): AdapterContext {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, options.env ?? {});
  Object.assign(env, input.env ?? {});
  const home = options.home ?? env['HOME'] ?? env['USERPROFILE'] ?? homedir();
  return {
    home,
    root: resolve(input.root ?? options.root ?? process.cwd()),
    env,
    probePaths: input.probePaths ?? options.probePaths ?? splitPath(env['PATH']),
    now: options.now ?? (() => new Date().toISOString()),
  };
}

/** The ANO MCP entry published by this package (`package.json` `mcp` field). */
function desiredEntry(): Record<string, unknown> {
  const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
  return { transport: 'stdio', command: process.execPath, args: [join(packageRoot, 'dist', 'surface', 'mcp.js')], env: {}, enabled: true };
}

function proposedChanges(target: ClientConfigTarget, changes: readonly ClientConfigChange[]): ProposedChange[] {
  return changes.map((change) => ({
    path: target.path,
    scope: target.scope,
    key: [...change.serverPath, change.serverName].join('.'),
    operation:
      change.kind === 'add-server' ? 'add' : change.kind === 'update-server' ? 'update' : change.kind === 'remove-server' ? 'remove' : 'none',
    before: change.before,
    after: change.after,
  }));
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
    scope: [...ref.scope],
    grantedBy: ref.grantedBy,
    statement,
    grantedAt: ref.grantedAt,
    ...(ref.revokedAt === undefined ? {} : { revokedAt: ref.revokedAt }),
  };
}

// ---------------------------------------------------------------------------
// detect
// ---------------------------------------------------------------------------

function detectWith(options: OpenClawAdapterOptions, input: DetectInput): DetectResult {
  const ctx = resolveContext(options, { root: input.cwd ?? options.root, env: input.env, probePaths: input.probePaths });
  const at = ctx.now();
  const sources: DetectionEvidence[] = [];
  const errors: IsolatedError[] = [];

  if (input.signal?.aborted === true) {
    return {
      clientId: 'openclaw',
      detected: false,
      executablePath: null,
      version: null,
      sources: [],
      errors: [isolated('detected', 'E1_ABORTED', 'detection was aborted', at, 'client:openclaw')],
    };
  }

  for (const identitySource of OPENCLAW_IDENTITY_SOURCES) {
    try {
      if (identitySource.kind === 'executable') {
        const found = findExecutable(identitySource.value, ctx.probePaths);
        if (found !== null) {
          sources.push({ source: `executable:${identitySource.value}`, kind: 'executable', executablePath: found, version: null, detectedAt: at });
        }
      } else if (identitySource.kind === 'config-path') {
        const expanded = expandPath(identitySource.value, ctx.home, ctx.root);
        if (existsSync(expanded)) {
          sources.push({ source: `path:${expanded}`, kind: 'config-path', executablePath: null, version: null, detectedAt: at });
        }
      }
    } catch (error) {
      errors.push(isolated('detected', 'E1_PROBE_FAILED', `failed to probe ${identitySource.value}: ${errorMessage(error)}`, at, identitySource.value));
    }
  }

  const executablePath = sources.find((source) => source.kind === 'executable')?.executablePath ?? null;
  return {
    clientId: 'openclaw',
    detected: sources.length > 0,
    executablePath,
    version: null,
    sources,
    errors,
  };
}

// ---------------------------------------------------------------------------
// inspect: read-only configuration discovery
// ---------------------------------------------------------------------------

function discoverConfig(ctx: AdapterContext): ConfigDiscovery {
  const limitations: string[] = [];
  const errors: IsolatedError[] = [];
  const path = join(ctx.home, OPENCLAW_USER_CONFIG);
  if (!isFile(path)) {
    limitations.push('no declared OpenClaw config candidate exists');
    return { configPath: null, scope: null, key: null, resolvedEntry: null, exists: false, reachable: false, sawCandidateFile: false, limitations, errors };
  }

  const target: ClientConfigTarget = {
    clientId: 'openclaw',
    scope: 'user',
    path,
    format: 'json',
    serverPath: [...OPENCLAW_SERVER_PATH],
    serverName: OPENCLAW_SERVER_NAME,
    allowedRoot: allowedRootForPath('user', ctx),
  };
  let snapshot;
  try {
    snapshot = readClientConfig(target);
  } catch (error) {
    errors.push(isolated('configured', 'E2_PARSE_FAILED', `failed to parse ${path}: ${errorMessage(error)}`, ctx.now(), path));
    return { configPath: path, scope: 'user', key: [...OPENCLAW_SERVER_PATH, OPENCLAW_SERVER_NAME].join('.'), resolvedEntry: null, exists: true, reachable: false, sawCandidateFile: true, limitations, errors };
  }
  if (!snapshot.exists) {
    limitations.push('declared config file does not exist');
    return { configPath: null, scope: null, key: null, resolvedEntry: null, exists: false, reachable: false, sawCandidateFile: false, limitations, errors };
  }
  if (!snapshot.containerFound) {
    limitations.push('config file exists but the mcp.servers container was not found');
    return { configPath: path, scope: 'user', key: [...OPENCLAW_SERVER_PATH, OPENCLAW_SERVER_NAME].join('.'), resolvedEntry: null, exists: true, reachable: false, sawCandidateFile: true, limitations, errors };
  }
  const entry = snapshot.anoEntry;
  if (entry === null || entry === undefined) {
    limitations.push('config file has an mcp.servers container but no ano entry');
    return { configPath: path, scope: 'user', key: [...OPENCLAW_SERVER_PATH, OPENCLAW_SERVER_NAME].join('.'), resolvedEntry: null, exists: true, reachable: false, sawCandidateFile: true, limitations, errors };
  }
  const command = entryCommand(entry);
  const reachable = command !== null ? commandReachable(command, ctx.probePaths) : isRemoteEntry(entry);
  if (!reachable) limitations.push('configured entry exposes no reachable local command');
  return {
    configPath: path,
    scope: 'user',
    key: [...OPENCLAW_SERVER_PATH, OPENCLAW_SERVER_NAME].join('.'),
    resolvedEntry: redactClientConfigEntry(entry),
    exists: true,
    reachable,
    sawCandidateFile: true,
    limitations,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Layer builders
// ---------------------------------------------------------------------------

function buildDetectedLayer(detect: DetectResult, at: string): MutableLayerReports['detected'] {
  const source = detect.sources.length > 0 ? detect.sources.map((entry) => entry.source).join(', ') : 'client:openclaw';
  const limitations: string[] = [];
  let verdict: MutableLayerReports['detected']['verdict'];
  if (!detect.detected) {
    verdict = 'unavailable';
  } else if (detect.executablePath !== null || detect.version !== null) {
    verdict = 'validated';
  } else {
    verdict = 'degraded';
    limitations.push('detection lacks both an executable path and a version');
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
  const source = discovery.configPath ?? 'client:openclaw';
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
      evidence: discovery.sawCandidateFile ? 'configured' : 'absent',
      at,
      version: null,
      source,
      limitations: ['installed but no ano MCP entry was found in the declared config candidates', ...discovery.limitations],
      errors: discovery.errors,
      details: { configPath: null, scope: discovery.scope, key: discovery.key, resolvedEntry: null, exists: false },
    };
  }
  const limitations = [
    ...(discovery.reachable ? [] : ['configured entry path is not reachable']),
    ...discovery.limitations,
    'configured but not measured; unverified',
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
      resolvedEntry: discovery.resolvedEntry,
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
      source: 'client:openclaw',
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
    source: 'client:openclaw',
    limitations: [
      'skills and plugins are documented mechanisms, but no public rule/instruction file path is documented',
      'no rule path is guessed; writing instructions requires explicit authorization',
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
      source: 'client:openclaw',
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
      'documented sessions/agents/swarm/subagents surfaces are CLI mechanisms, not a public DAG dispatch API',
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
    limitations: ['no public OpenClaw output-interception interface was documented', 'tool-level hooks are not output interception'],
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

function inspectWith(options: OpenClawAdapterOptions, input: InspectInput): ClientReport {
  const ctx = resolveContext(options, { root: input.root ?? input.cwd ?? options.root, env: input.env });
  const at = ctx.now();
  const detect = detectWith(options, {
    ...(input.env !== undefined ? { env: input.env } : {}),
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });
  const discovery = discoverConfig(ctx);

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
  const limitations = [
    'inspect is read-only and performs no stdio handshake; mcp/tools/brief not measured; unverified',
    'a successful MCP handshake would not imply rule takeover, DAG takeover, history support or output interception',
  ];
  for (const layer of EXTENSION_LAYERS) {
    const report = layers[layer];
    if (report.verdict === 'unavailable') limitations.push(`${layer} unavailable: ${report.limitations[0] ?? 'not measured'}`);
  }
  const status: ClientReport['status'] = !detect.detected ? 'unavailable' : coreVerdict === 'validated' ? 'ready' : 'degraded';
  return {
    schema: CLIENT_REPORT_SCHEMA,
    clientId: 'openclaw',
    alias: null,
    status,
    coreVerdict,
    layers,
    generatedAt: at,
    limitations: dedupe(limitations),
    errors: [...detect.errors, ...discovery.errors],
  };
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

function buildTarget(input: ConfigInput, ctx: AdapterContext): ClientConfigTarget {
  const scope = input.target.scope;
  const path = input.target.path !== undefined ? resolve(input.target.path) : join(ctx.home, OPENCLAW_USER_CONFIG);
  return {
    clientId: 'openclaw',
    scope,
    path,
    format: 'json',
    serverPath: [...OPENCLAW_SERVER_PATH],
    serverName: OPENCLAW_SERVER_NAME,
    allowedRoot: allowedRootForPath(scope, ctx),
  };
}

function configWith(options: OpenClawAdapterOptions, input: ConfigInput): ConfigResult {
  const ctx = resolveContext(options, { root: input.root });
  const warnings: string[] = [];
  if (input.target.format !== undefined && input.target.format !== 'json') {
    return { mode: 'dry-run', changes: [], backupPlan: null, warnings: [`OpenClaw configuration format is json; refusing format ${input.target.format}`] };
  }
  if (input.target.scope !== 'user' && input.target.path === undefined) {
    warnings.push('OpenClaw documents a user-level config file (~/.openclaw/openclaw.json); the requested scope maps to that file');
  }
  const target = buildTarget(input, ctx);
  const entry = desiredEntry();
  let plan;
  try {
    plan = planClientConfig(target, entry);
  } catch (error) {
    return { mode: 'dry-run', changes: [], backupPlan: null, warnings: [...warnings, `config plan failed: ${errorMessage(error)}; zero write`] };
  }
  const changes = proposedChanges(target, plan.changes);
  const backupPlan =
    plan.changed && plan.afterHash !== null
      ? { backupId: `planned:${plan.afterHash.slice(0, 16)}`, path: target.path, hashAlgorithm: 'sha256' as const }
      : null;
  const baseWarnings = [...warnings, ...plan.warnings];

  if (input.mode !== 'apply') return { mode: 'dry-run', changes, backupPlan, warnings: baseWarnings };
  const root = input.root;
  if (root === undefined) {
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
      ...(input.backup === undefined ? {} : { backup: input.backup }),
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
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export function createOpenClawAdapter(options: OpenClawAdapterOptions = {}): ClientAdapter {
  return {
    id: 'openclaw' as ClientId,
    identitySources: OPENCLAW_IDENTITY_SOURCES,
    detect: async (input: DetectInput) => detectWith(options, input),
    inspect: async (input: InspectInput) => inspectWith(options, input),
    config: async (input: ConfigInput) => configWith(options, input),
    verify: (input: VerifyInput): Promise<VerifyResult> => verifyStdioMcp(input),
  };
}

/** Production instance; tests must construct their own with injected paths. */
export const openclawAdapter: ClientAdapter = createOpenClawAdapter();

/** Target mapping exported for CLI orchestration and tests. */
export function openclawConfigTarget(
  scope: ConfigScope,
  paths: { readonly home: string; readonly root: string; readonly path?: string },
): ClientConfigTarget {
  const ctx: AdapterContext = {
    home: paths.home,
    root: resolve(paths.root),
    env: {},
    probePaths: [],
    now: () => new Date().toISOString(),
  };
  return buildTarget({ target: { scope, ...(paths.path === undefined ? {} : { path: paths.path }) }, mode: 'dry-run' }, ctx);
}
