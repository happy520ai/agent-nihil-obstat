/**
 * GitHub Copilot client adapter (ADR-008 §3/§5/§6, M12/T-093).
 *
 * Implements the four-method `ClientAdapter` contract for GitHub Copilot.
 * Everything is read-only until `config()` is called with `mode:'apply'`
 * plus an explicit authorization credential; the write itself is delegated to
 * `config.ts` (T-081), which owns backup/hash/drift/rollback and merge
 * preservation. `verify()` delegates the real stdio handshake to
 * `doctor.verifyStdioMcp`.
 *
 * Evidence discipline:
 * - `detect` probes only the declared sources (`copilot` executable,
 *   `~/.copilot/mcp-config.json`, `~/.copilot/copilot-instructions.md`).
 *   It never runs the candidate and never guesses a path.
 * - Existence of an executable or a config file is E2 evidence, so `detected`
 *   is capped at `degraded` unless a version was really measured; this adapter
 *   does not spawn `--version`, therefore `version` stays `null`.
 * - `inspect` never spawns a stdio server: `mcp`/`tools`/`brief` stay
 *   `unavailable`.
 * - Copilot is an IDE plugin + CLI + cloud agent. The cloud agent and the
 *   completion/chat surfaces are NOT an ANO DAG takeover: `orchestration` is
 *   `degraded` with `mode:'explicit-workflow'`, and `history` /
 *   `output-interception` stay `unavailable`. Code completion is never
 *   reported as agent takeover.
 *
 * Public-format basis (see docs/evidence/client-ide-coding.md): the
 * `mcpServers` container, `~/.copilot/mcp-config.json` and workspace
 * `.mcp.json` come from GitHub/VS Code public Copilot MCP docs (E1, fetched
 * 2026-11-23). `.vscode/mcp.json` is the deprecated editor-managed format
 * (`servers` key) and is deliberately not written. The documented
 * `COPILOT_HOME` override is not probed. Repository instructions
 * `.github/copilot-instructions.md` and `.github/instructions/*.instructions.md`
 * are documented (E1); the user-level `~/.copilot/copilot-instructions.md`
 * path is taken from ADR-008 §3 and was not independently fetched.
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
import { MANAGED_INSTRUCTIONS_BEGIN, MANAGED_INSTRUCTIONS_END } from '../connect/managed-instructions.ts';

// ---------------------------------------------------------------------------
// Declared identity and configuration metadata
// ---------------------------------------------------------------------------

export const GITHUB_COPILOT_SERVER_NAME = 'ano';
export const GITHUB_COPILOT_SERVER_PATH = ['mcpServers'] as const;
export const GITHUB_COPILOT_USER_CONFIG = join('.copilot', 'mcp-config.json');
export const GITHUB_COPILOT_PROJECT_CONFIG = '.mcp.json';

/**
 * Read-only identity sources. Matches the T-092 registry descriptor for
 * `github-copilot`; the adapter never probes an undeclared path.
 */
export const GITHUB_COPILOT_IDENTITY_SOURCES = [
  { kind: 'executable', value: 'copilot', detail: 'GitHub Copilot CLI（待核实）' },
  { kind: 'config-path', value: '~/.copilot/mcp-config.json', detail: 'MCP 配置候选（待核实）' },
  { kind: 'config-path', value: '~/.copilot/copilot-instructions.md', detail: '指令文件候选（待核实）' },
] as const;

/** Rule/instruction candidates. `~` expands against the injected home. */
export const GITHUB_COPILOT_USER_RULE_PATHS = [
  join('.copilot', 'copilot-instructions.md'),
  join('.copilot', 'instructions'),
] as const;

export const GITHUB_COPILOT_PROJECT_RULE_PATHS = [
  join('.github', 'copilot-instructions.md'),
  join('.github', 'instructions'),
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
  const sources: DetectionEvidence[] = [];
  let executablePath: string | null = null;

  for (const directory of probePaths) {
    if (executablePath !== null) break;
    for (const suffix of ['', '.exe', '.cmd']) {
      const candidate = join(directory, `copilot${suffix}`);
      if (isFile(candidate)) {
        sources.push({
          source: 'executable:copilot',
          kind: 'executable',
          executablePath: candidate,
          version: null,
          detectedAt: at,
        });
        executablePath = candidate;
        break;
      }
    }
  }

  if (home !== null) {
    const configPath = join(home, GITHUB_COPILOT_USER_CONFIG);
    if (isFile(configPath)) {
      sources.push({
        source: 'config-path:~/.copilot/mcp-config.json',
        kind: 'config-path',
        executablePath: null,
        version: null,
        detectedAt: at,
      });
    }
    const instructions = join(home, '.copilot', 'copilot-instructions.md');
    if (isFile(instructions)) {
      sources.push({
        source: 'config-path:~/.copilot/copilot-instructions.md',
        kind: 'config-path',
        executablePath: null,
        version: null,
        detectedAt: at,
      });
    }
  }

  return {
    clientId: 'github-copilot',
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

interface ConfigCandidate {
  readonly scope: ConfigScope;
  readonly path: string;
  readonly key: string;
  readonly reachable: boolean;
}

interface ConfigDiscovery {
  readonly configPath: string | null;
  readonly scope: ConfigScope | null;
  readonly key: string | null;
  readonly entry: unknown;
  readonly exists: boolean;
  readonly reachable: boolean;
  readonly checked: readonly string[];
  readonly limitations: readonly string[];
  readonly errors: readonly IsolatedError[];
}

function configCandidates(context: TargetContext): ClientConfigTarget[] {
  const candidates: ClientConfigTarget[] = [];
  if (context.home !== null) {
    candidates.push({
      clientId: 'github-copilot',
      scope: 'user',
      path: join(context.home, GITHUB_COPILOT_USER_CONFIG),
      format: 'json',
      serverPath: [...GITHUB_COPILOT_SERVER_PATH],
      serverName: GITHUB_COPILOT_SERVER_NAME,
      allowedRoot: context.home,
    });
  }
  if (context.root !== null) {
    candidates.push({
      clientId: 'github-copilot',
      scope: 'project',
      path: join(context.root, GITHUB_COPILOT_PROJECT_CONFIG),
      format: 'json',
      serverPath: [...GITHUB_COPILOT_SERVER_PATH],
      serverName: GITHUB_COPILOT_SERVER_NAME,
      allowedRoot: context.root,
    });
  }
  return candidates;
}

function discoverConfig(context: TargetContext, probePaths: readonly string[], at: string): ConfigDiscovery {
  const candidates = configCandidates(context);
  const limitations: string[] = [];
  const errors: IsolatedError[] = [];
  const checked: string[] = [];
  if (candidates.length === 0) {
    limitations.push('no declared config candidate could be resolved from the injected home/root');
  }

  let firstExisting: ConfigCandidate | null = null;
  for (const target of candidates) {
    checked.push(target.path);
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
    const entry = snapshot.anoEntry;
    const command = entryCommand(entry);
    const reachable = command !== null ? commandReachable(command, probePaths) : isRemoteEntry(entry);
    const candidate: ConfigCandidate = { scope: target.scope, path: target.path, key, reachable };
    if (firstExisting === null) firstExisting = candidate;
    if (entry !== null && entry !== undefined) {
      return {
        configPath: target.path,
        scope: target.scope,
        key,
        entry: redactClientConfigEntry(entry),
        exists: true,
        reachable,
        checked,
        limitations: reachable ? [] : ['configured entry path is not reachable'],
        errors,
      };
    }
    if (!snapshot.containerFound) {
      limitations.push(`${target.path}: mcpServers container was not found`);
    } else {
      limitations.push(`${target.path}: mcpServers container has no ano entry`);
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
      checked,
      limitations,
      errors,
    };
  }
  return { configPath: null, scope: null, key: null, entry: null, exists: false, reachable: false, checked, limitations, errors };
}

// ---------------------------------------------------------------------------
// inspect: rule/instruction detection
// ---------------------------------------------------------------------------

interface RuleScan {
  readonly rulePaths: readonly string[];
  readonly formatVersion: string | null;
  readonly hasManagedSection: boolean;
}

function formatVersionFor(path: string): string {
  return path.endsWith('.instructions.md') ? 'github-copilot-instructions-md/1' : 'github-copilot-instructions/1';
}

function scanRules(root: string | null, home: string | null): RuleScan {
  const rulePaths: string[] = [];
  const versions: string[] = [];
  let hasManagedSection = false;

  const visitFile = (path: string): void => {
    if (!isFile(path)) return;
    rulePaths.push(path);
    const version = formatVersionFor(path);
    if (!versions.includes(version)) versions.push(version);
    const text = readText(path);
    if (text !== null && text.includes(MANAGED_INSTRUCTIONS_BEGIN) && text.includes(MANAGED_INSTRUCTIONS_END)) {
      hasManagedSection = true;
    }
  };

  const visitDirectory = (path: string): void => {
    if (!isDirectory(path)) return;
    rulePaths.push(path);
    let entries: string[] = [];
    try {
      entries = readdirSync(path).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      if (!name.endsWith('.md')) continue;
      visitFile(join(path, name));
    }
  };

  if (home !== null) {
    for (const relative of GITHUB_COPILOT_USER_RULE_PATHS) {
      const path = join(home, relative);
      if (isDirectory(path)) visitDirectory(path);
      else visitFile(path);
    }
  }
  if (root !== null) {
    for (const relative of GITHUB_COPILOT_PROJECT_RULE_PATHS) {
      const path = join(root, relative);
      if (isDirectory(path)) visitDirectory(path);
      else visitFile(path);
    }
  }

  return { rulePaths, formatVersion: versions.length > 0 ? versions.join(',') : null, hasManagedSection };
}

// ---------------------------------------------------------------------------
// Layer builders
// ---------------------------------------------------------------------------

function buildDetectedLayer(detect: DetectResult, at: string): MutableLayerReports['detected'] {
  const source = detect.sources.length > 0 ? detect.sources.map((entry) => entry.source).join(', ') : 'client:github-copilot';
  if (!detect.detected) {
    return {
      layer: 'detected',
      code: 'E1',
      verdict: 'unavailable',
      evidence: 'absent',
      at,
      version: null,
      source,
      limitations: ['no declared GitHub Copilot source was found; paths were not guessed'],
      errors: detect.errors,
      details: {
        detected: false,
        executablePath: null,
        version: null,
        sources: detect.sources,
      },
    };
  }
  const limitations = [
    'executable/config existence is E2 evidence only; no version was measured',
    'Copilot IDE plugin presence is not probed because no plugin source is declared',
  ];
  if (detect.executablePath === null) limitations.push('no copilot executable was found on the declared PATH candidates');
  return {
    layer: 'detected',
    code: 'E1',
    verdict: detect.version !== null ? 'validated' : 'degraded',
    evidence: 'measured',
    at,
    version: detect.version,
    source,
    limitations,
    errors: detect.errors,
    details: {
      detected: true,
      executablePath: detect.executablePath,
      version: detect.version,
      sources: detect.sources,
    },
  };
}

function buildConfiguredLayer(detect: DetectResult, discovery: ConfigDiscovery, at: string): MutableLayerReports['configured'] {
  const source = discovery.configPath ?? 'client:github-copilot';
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
      limitations: [
        'installed but no ano MCP entry was found in the declared config candidates',
        ...discovery.limitations,
      ],
      errors: discovery.errors,
      details: { configPath: null, scope: discovery.scope, key: discovery.key, resolvedEntry: null, exists: false },
    };
  }
  const limitations = [
    ...(discovery.reachable ? [] : ['configured entry path is not reachable']),
    ...discovery.limitations,
    'no real stdio handshake was performed during inspect',
    'Copilot cloud-agent surfaces are not a local MCP configuration',
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

function buildInstructionsLayer(detect: DetectResult, root: string | null, home: string | null, at: string): InstructionsLayerReport {
  if (!detect.detected) {
    return {
      layer: 'instructions',
      code: 'E6',
      verdict: 'unavailable',
      evidence: 'absent',
      at,
      version: null,
      source: 'client:github-copilot',
      limitations: ['detected prerequisite is unavailable'],
      errors: [],
      details: { rulePaths: [], formatVersion: null, hasManagedSection: false, readOnly: true },
    };
  }
  const scan = scanRules(root, home);
  const limitations = [
    'file presence does not prove Copilot read or applied the instructions',
    'instruction detection is read-only; writing instruction files requires explicit authorization',
    ...(scan.rulePaths.length > 0 ? [] : ['no declared Copilot instruction file was found']),
    ...(scan.hasManagedSection ? [] : ['no ANO managed-section marker was found in the detected instruction files']),
  ];
  return {
    layer: 'instructions',
    code: 'E6',
    verdict: 'degraded',
    evidence: scan.rulePaths.length > 0 ? 'measured' : 'absent',
    at,
    version: scan.formatVersion,
    source: scan.rulePaths.length > 0 ? scan.rulePaths.join(', ') : 'client:github-copilot',
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
      'no public Copilot subagent/dispatch interface was verified',
      'GitHub Copilot cloud agent and IDE completion are not ANO DAG takeover; explicit manual workflow only',
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
      'no public Copilot output-interception interface was verified',
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

function buildReport(detect: DetectResult, discovery: ConfigDiscovery, root: string | null, home: string | null, at: string): ClientReport {
  const layers: MutableLayerReports = {
    detected: buildDetectedLayer(detect, at),
    configured: buildConfiguredLayer(detect, discovery, at),
    mcp: unavailableMcpLayer(at),
    tools: unavailableToolsLayer(at),
    brief: unavailableBriefLayer(at),
    instructions: buildInstructionsLayer(detect, root, home, at),
    orchestration: buildOrchestrationLayer(at),
    history: buildHistoryLayer(at),
    'output-interception': buildOutputInterceptionLayer(at),
  };
  const coreVerdict = weakestVerdict(CORE_LAYERS.map((layer) => layers[layer].verdict));
  const limitations: string[] = [
    'inspect is read-only and performs no stdio handshake; mcp/tools/brief stay unmeasured',
    'a successful MCP handshake would not imply rule takeover, DAG takeover, history support or output interception',
    'GitHub Copilot code completion and cloud agent capability are not ANO agent takeover',
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
    clientId: 'github-copilot',
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
    return { ok: true, path: join(context.home, GITHUB_COPILOT_USER_CONFIG), allowedRoot: context.home };
  }
  if (context.root === null) return { ok: false, error: 'project/workspace target requires an injected root' };
  return { ok: true, path: join(context.root, GITHUB_COPILOT_PROJECT_CONFIG), allowedRoot: context.root };
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

function dryRun(changes: readonly ProposedChange[], backupPlan: BackupPlan | null, warnings: readonly string[]): ConfigResult {
  return { mode: 'dry-run', changes, backupPlan, warnings };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const githubCopilotAdapter: ClientAdapter = {
  id: 'github-copilot',
  identitySources: GITHUB_COPILOT_IDENTITY_SOURCES,

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
    return buildReport(detect, discovery, root, home, at);
  },

  async config(input: ConfigInput): Promise<ConfigResult> {
    const home = configHome(input);
    const root = input.root !== undefined ? resolve(input.root) : null;
    const resolved = resolveConfigPath(input.target, { home, root });
    if (!resolved.ok) {
      return dryRun([], null, [`config target unresolved: ${resolved.error}; zero write`]);
    }
    const warnings: string[] = [];
    if (input.target.scope === 'workspace' && input.target.path === undefined) {
      warnings.push('GitHub Copilot public configuration documents user (~/.copilot/mcp-config.json) and workspace (.mcp.json) scopes; workspace scope maps to the project .mcp.json');
    }
    if (input.target.format === 'toml') {
      warnings.push('GitHub Copilot public MCP configuration is JSON; a TOML target is not a documented format');
    }
    if (input.target.scope === 'project') {
      warnings.push('workspace .mcp.json uses the documented native Copilot mcpServers container (E1); $COPILOT_HOME override is documented but not probed');
      warnings.push('.vscode/mcp.json is the deprecated editor-managed format (servers key) and is deliberately not written by this adapter');
    }
    const target: ClientConfigTarget = {
      clientId: 'github-copilot',
      scope: input.target.scope,
      path: resolved.path,
      format: input.target.format ?? 'json',
      serverPath: [...GITHUB_COPILOT_SERVER_PATH],
      serverName: GITHUB_COPILOT_SERVER_NAME,
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
