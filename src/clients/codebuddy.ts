/**
 * Tencent CodeBuddy client adapter (ADR-008 §3/§5, M12/T-094).
 *
 * Implements the four-method `ClientAdapter` contract for CodeBuddy
 * (IDE + IDE plugin + CLI). Everything is read-only until `config()` is called
 * with `mode:'apply'` plus an explicit authorization credential; the write is
 * delegated to `config.ts` (T-081).
 *
 * Public evidence (fetched 2026-11-23):
 * - npm registry `@tencent-ai/codebuddy-code` v2.185.0 declares bin
 *   `codebuddy` -> `bin/codebuddy`; homepage `https://cnb.cool/codebuddy/codebuddy-code`
 *   (E1). The registry metadata does not document MCP config or rule files.
 * - ADR-008 §3 / docs/client-catalog.md declare MCP candidates
 *   `~/.codebuddy/.mcp.json`, `~/.codebuddy/mcp.json`, project `.mcp.json`
 *   with `mcpServers`, and rule paths `CODEBUDDY.md` / `rules/`. The official
 *   CodeBuddy docs page fetched during this task returned only a title, so
 *   those candidates are carried as `unverified` (not re-confirmed here).
 *
 * Alias discipline (ADR-008 §10.3): `cbc` is a CLI command alias, not a
 * `ClientId` alias. The adapter id stays `codebuddy`; `cbc` is only probed as
 * a declared executable source.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
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
import { MANAGED_INSTRUCTIONS_BEGIN, MANAGED_INSTRUCTIONS_END } from '../connect/managed-instructions.ts';

// ---------------------------------------------------------------------------
// Declared identity and configuration metadata
// ---------------------------------------------------------------------------

export const CODEBUDDY_SERVER_NAME = 'ano';
export const CODEBUDDY_SERVER_PATH = ['mcpServers'] as const;
export const CODEBUDDY_USER_CONFIG_PRIMARY = join('.codebuddy', '.mcp.json');
export const CODEBUDDY_USER_CONFIG_SECONDARY = join('.codebuddy', 'mcp.json');
export const CODEBUDDY_PROJECT_CONFIG = '.mcp.json';
export const CODEBUDDY_RULE_PATHS = ['CODEBUDDY.md', 'rules'] as const;

/**
 * Read-only identity sources. `cbc` is a command alias declared by ADR-008 §10.3,
 * not a ClientId alias; it is probed only as an executable name.
 */
export const CODEBUDDY_IDENTITY_SOURCES = [
  { kind: 'executable', value: 'codebuddy', detail: 'CodeBuddy CLI bin (npm @tencent-ai/codebuddy-code, E1)' },
  { kind: 'executable', value: 'cbc', detail: 'CodeBuddy CLI command alias (ADR-008 §10.3; not a ClientId alias; 待核实)' },
  { kind: 'config-path', value: '~/.codebuddy/.mcp.json', detail: 'user MCP config candidate (ADR-008 §3; 待核实)' },
  { kind: 'config-path', value: '~/.codebuddy/mcp.json', detail: 'user MCP config candidate (ADR-008 §3; 待核实)' },
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

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
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
  readonly probePaths?: readonly string[] | undefined;
}

function runDetect(context: ProbeContext): DetectResult {
  const at = new Date().toISOString();
  const env = context.env ?? {};
  const probePaths = context.probePaths ?? splitPath(env['PATH'] ?? process.env['PATH'] ?? '');
  const home = homeFrom(env);
  const cwd = context.cwd ?? process.cwd();
  const sources: DetectionEvidence[] = [];
  let executablePath: string | null = null;

  for (const name of ['codebuddy', 'cbc']) {
    for (const directory of probePaths) {
      if (executablePath !== null) break;
      for (const suffix of ['', '.exe', '.cmd']) {
        const candidate = join(directory, `${name}${suffix}`);
        if (isFile(candidate)) {
          sources.push({
            source: `executable:${name}`,
            kind: 'executable',
            executablePath: candidate,
            version: null,
            detectedAt: at,
          });
          if (executablePath === null) executablePath = candidate;
          break;
        }
      }
    }
    if (executablePath !== null) break;
  }

  const pathCandidates: string[] = [
    ...(home !== null ? [join(home, CODEBUDDY_USER_CONFIG_PRIMARY), join(home, CODEBUDDY_USER_CONFIG_SECONDARY)] : []),
  ];
  for (const candidate of pathCandidates) {
    if (isFile(candidate)) {
      sources.push({
        source: `path:${candidate}`,
        kind: 'config-path',
        executablePath: null,
        version: null,
        detectedAt: at,
      });
    }
  }
  const projectConfig = resolve(cwd, CODEBUDDY_PROJECT_CONFIG);
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
    clientId: 'codebuddy',
    detected: sources.length > 0,
    executablePath,
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

function userConfigPath(context: TargetContext): string | null {
  if (context.home === null) return null;
  const primary = join(context.home, CODEBUDDY_USER_CONFIG_PRIMARY);
  const secondary = join(context.home, CODEBUDDY_USER_CONFIG_SECONDARY);
  if (isFile(primary)) return primary;
  if (isFile(secondary)) return secondary;
  return primary;
}

function configCandidates(context: TargetContext): ClientConfigTarget[] {
  const candidates: ClientConfigTarget[] = [];
  const userPath = userConfigPath(context);
  if (userPath !== null) {
    candidates.push({
      clientId: 'codebuddy',
      scope: 'user',
      path: userPath,
      format: 'json',
      serverPath: [...CODEBUDDY_SERVER_PATH],
      serverName: CODEBUDDY_SERVER_NAME,
      allowedRoot: context.home as string,
    });
  }
  if (context.root !== null) {
    candidates.push({
      clientId: 'codebuddy',
      scope: 'project',
      path: join(context.root, CODEBUDDY_PROJECT_CONFIG),
      format: 'json',
      serverPath: [...CODEBUDDY_SERVER_PATH],
      serverName: CODEBUDDY_SERVER_NAME,
      allowedRoot: context.root,
    });
  }
  return candidates;
}

function discoverConfig(context: TargetContext, probePaths: readonly string[]): ConfigDiscovery {
  const candidates = configCandidates(context);
  const limitations: string[] = ['CodeBuddy MCP config paths are ADR-008 §3 candidates; the official docs page did not re-confirm them (unverified)'];
  const errors: IsolatedError[] = [];
  if (candidates.length === 0) {
    limitations.push('no declared config candidate could be resolved from the injected home/root');
  }
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
// inspect: rule/instruction detection
// ---------------------------------------------------------------------------

interface RuleScan {
  readonly rulePaths: readonly string[];
  readonly formatVersion: string | null;
  readonly hasManagedSection: boolean;
}

function scanRules(root: string | null): RuleScan {
  const rulePaths: string[] = [];
  let formatVersion: string | null = null;
  let hasManagedSection = false;
  if (root === null) return { rulePaths, formatVersion, hasManagedSection };

  for (const relative of CODEBUDDY_RULE_PATHS) {
    const path = resolve(root, relative);
    if (isDirectory(path)) {
      rulePaths.push(path);
      if (formatVersion === null) formatVersion = 'codebuddy-rules/1';
      let entries: string[] = [];
      try {
        entries = readdirSync(path).sort();
      } catch {
        continue;
      }
      for (const name of entries) {
        const file = join(path, name);
        if (!isFile(file)) continue;
        rulePaths.push(file);
        const text = readText(file);
        if (text !== null && text.includes(MANAGED_INSTRUCTIONS_BEGIN) && text.includes(MANAGED_INSTRUCTIONS_END)) {
          hasManagedSection = true;
        }
      }
      continue;
    }
    if (!isFile(path)) continue;
    rulePaths.push(path);
    if (formatVersion === null) formatVersion = 'codebuddy-md/1';
    const text = readText(path);
    if (text !== null && text.includes(MANAGED_INSTRUCTIONS_BEGIN) && text.includes(MANAGED_INSTRUCTIONS_END)) {
      hasManagedSection = true;
    }
  }
  return { rulePaths, formatVersion, hasManagedSection };
}

// ---------------------------------------------------------------------------
// Layer builders
// ---------------------------------------------------------------------------

function buildDetectedLayer(detect: DetectResult, at: string): MutableLayerReports['detected'] {
  const source = detect.sources.length > 0 ? detect.sources.map((entry) => entry.source).join(', ') : 'client:codebuddy';
  const limitations: string[] = [];
  let verdict: ClientVerdict;
  if (!detect.detected) {
    verdict = 'unavailable';
    limitations.push('no declared CodeBuddy identity source was found');
  } else if (detect.executablePath !== null) {
    verdict = 'degraded';
    limitations.push('executable presence is E2/E3; no version was measured and no MCP handshake was performed');
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
  const source = discovery.configPath ?? 'client:codebuddy';
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

function buildInstructionsLayer(detect: DetectResult, root: string | null, at: string): InstructionsLayerReport {
  if (!detect.detected) {
    return {
      layer: 'instructions',
      code: 'E6',
      verdict: 'unavailable',
      evidence: 'absent',
      at,
      version: null,
      source: 'client:codebuddy',
      limitations: ['detected prerequisite is unavailable'],
      errors: [],
      details: { rulePaths: [], formatVersion: null, hasManagedSection: false, readOnly: true },
    };
  }
  const scan = scanRules(root);
  const limitations = [
    'rule paths are ADR-008 §3 candidates; the official docs page did not re-confirm them (unverified)',
    'file presence does not prove CodeBuddy read or applied the rules',
    'rule detection is read-only; writing rules requires explicit authorization',
    ...(scan.rulePaths.length > 0 ? [] : ['no declared CodeBuddy rule file was found']),
    ...(scan.hasManagedSection ? [] : ['no ANO managed-section marker was found in the detected rule files']),
  ];
  return {
    layer: 'instructions',
    code: 'E6',
    verdict: 'degraded',
    evidence: scan.rulePaths.length > 0 ? 'measured' : 'absent',
    at,
    version: scan.formatVersion,
    source: scan.rulePaths.length > 0 ? scan.rulePaths.join(', ') : 'client:codebuddy',
    limitations,
    errors: [],
    details: {
      rulePaths: scan.rulePaths,
      formatVersion: scan.formatVersion,
      hasManagedSection: scan.hasManagedSection,
      readOnly: true,
    },
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
      source: 'client:codebuddy',
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
      'no public CodeBuddy subagent/skill dispatch interface was verified',
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
      'no public CodeBuddy output-interception interface was verified',
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

function buildReport(detect: DetectResult, discovery: ConfigDiscovery, root: string | null, at: string): ClientReport {
  const layers: MutableLayerReports = {
    detected: buildDetectedLayer(detect, at),
    configured: buildConfiguredLayer(detect, discovery, at),
    mcp: unavailableMcpLayer(at),
    tools: unavailableToolsLayer(at),
    brief: unavailableBriefLayer(at),
    instructions: buildInstructionsLayer(detect, root, at),
    orchestration: buildOrchestrationLayer(detect, at),
    history: buildHistoryLayer(at),
    'output-interception': buildOutputInterceptionLayer(at),
  };
  const coreVerdict = weakestVerdict(CORE_LAYERS.map((layer) => layers[layer].verdict));
  const limitations: string[] = [
    'inspect is read-only and performs no stdio handshake; mcp/tools/brief stay unmeasured',
    'a successful MCP handshake would not imply rule takeover, DAG takeover, history support or output interception',
    'cbc is a CLI command alias, not a ClientId alias; adapter identity stays codebuddy',
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
    clientId: 'codebuddy',
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
    const path = userConfigPath(context);
    if (path === null) return { ok: false, error: 'user-scope target requires an injected HOME/USERPROFILE' };
    return { ok: true, path, allowedRoot: context.home as string };
  }
  if (context.root === null) return { ok: false, error: 'project/workspace target requires an injected root' };
  return { ok: true, path: join(context.root, CODEBUDDY_PROJECT_CONFIG), allowedRoot: context.root };
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

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const codebuddyAdapter: ClientAdapter = {
  id: 'codebuddy',
  identitySources: CODEBUDDY_IDENTITY_SOURCES,

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
    const discovery = discoverConfig({ home, root }, probePaths);
    return buildReport(detect, discovery, root, at);
  },

  async config(input: ConfigInput): Promise<ConfigResult> {
    const home = configHome(input);
    const root = input.root !== undefined ? resolve(input.root) : null;
    const resolved = resolveConfigPath(input.target, { home, root });
    if (!resolved.ok) {
      return { mode: 'dry-run', changes: [], backupPlan: null, warnings: [`config target unresolved: ${resolved.error}; zero write`] };
    }
    const warnings: string[] = ['CodeBuddy MCP config candidates are ADR-008 §3 declarations; public docs did not re-confirm them (unverified)'];
    if (input.target.scope === 'workspace' && input.target.path === undefined) {
      warnings.push('CodeBuddy documents a project .mcp.json; workspace scope maps to that file');
    }
    if (input.target.format === 'toml') {
      warnings.push('CodeBuddy public configuration is JSON; a TOML target is not a documented CodeBuddy format');
    }
    const target: ClientConfigTarget = {
      clientId: 'codebuddy',
      scope: input.target.scope,
      path: resolved.path,
      format: input.target.format ?? 'json',
      serverPath: [...CODEBUDDY_SERVER_PATH],
      serverName: CODEBUDDY_SERVER_NAME,
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
    if (root === null && input.target.scope !== 'user') {
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
        ...(root === null ? {} : { root }),
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
