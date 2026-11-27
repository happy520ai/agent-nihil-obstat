/**
 * Codex adapter (ADR-007 §5/§6, M11/T-082).
 *
 * Public format basis (see docs/evidence/client-claude-codex.md):
 * - Codex reads `~/.codex/config.toml`; MCP servers live in the root table
 *   `mcp_servers` as `[mcp_servers.<name>]` with `command`/`args`/`env` for
 *   stdio servers (Codex source `codex-rs/config/src/config_toml.rs` and
 *   `mcp_types.rs`, fetched 2026-11-22).
 * - `AGENTS.md` is the project instruction file. This adapter only probes it
 *   read-only and never writes it.
 *
 * TOML is read-only in v1 (T-081): `config()` reports the proposed change and
 * refuses any write, so an apply request degrades to a dry-run report.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import {
  CLIENT_REPORT_SCHEMA,
  CORE_LAYERS,
  EXTENSION_LAYERS,
  type ClientAdapter,
  type ClientId,
  type ClientReport,
  type ClientVerdict,
  type ConfigInput,
  type ConfigResult,
  type ConfigScope,
  type ConfiguredLayerReport,
  type DetectedLayerReport,
  type DetectInput,
  type DetectResult,
  type DetectionEvidence,
  type HistoryLayerReport,
  type InspectInput,
  type InstructionsDetails,
  type InstructionsLayerReport,
  type IsolatedError,
  type MutableLayerReports,
  type OrchestrationLayerReport,
  type OutputInterceptionLayerReport,
  type ProposedChange,
  type VerifyInput,
  type VerifyResult,
  weakestVerdict,
} from './types.ts';
import { defaultRegistry } from './registry.ts';
import { unavailableLayerReports, verifyStdioMcp } from './doctor.ts';
import { redactClientConfigEntry } from './redact.ts';
import {
  applyClientConfig,
  planClientConfig,
  readClientConfig,
  type ClientConfigAuthorization,
  type ClientConfigChange,
  type ClientConfigResult,
  type ClientConfigTarget,
} from './config.ts';
import {
  MANAGED_INSTRUCTIONS_BEGIN,
  MANAGED_INSTRUCTIONS_END,
  MANAGED_INSTRUCTIONS_SCHEMA,
} from '../connect/managed-instructions.ts';

export const CODEX_SERVER_PATH = ['mcp_servers'] as const;
export const CODEX_SERVER_NAME = 'ano';

const DESCRIPTOR = defaultRegistry.get('codex');
export const CODEX_IDENTITY_SOURCES = DESCRIPTOR.identitySources;

/** Fields accepted by Codex `RawMcpServerConfig` (source-verified, main branch). */
const KNOWN_ENTRY_FIELDS = new Set([
  'command',
  'args',
  'env',
  'env_vars',
  'cwd',
  'http_headers',
  'env_http_headers',
  'url',
  'bearer_token',
  'bearer_token_env_var',
  'http_headers_helper',
  'environment_id',
  'auth',
  'startup_timeout_sec',
  'startup_timeout_ms',
  'tool_timeout_sec',
  'enabled',
  'required',
  'startup_readiness',
  'supports_parallel_tool_calls',
  'tool_input_schema_max_bytes',
  'omit_tools_from',
  'default_tools_approval_mode',
  'enabled_tools',
  'disabled_tools',
  'scopes',
  'oauth',
  'oauth_resource',
  'name',
  'tools',
]);

export interface CodexAdapterOptions {
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

interface RuleInspection {
  readonly rulePaths: readonly string[];
  readonly formatVersion: string | null;
  readonly hasManagedSection: boolean;
  readonly limitations: readonly string[];
  readonly errors: readonly IsolatedError[];
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isolated(
  layer: IsolatedError['layer'],
  code: string,
  message: string,
  at: string,
  source: string | null,
): IsolatedError {
  return { layer, code, message, at, source };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function splitPath(value: string): readonly string[] {
  return value.split(delimiter).filter((part) => part.length > 0);
}

function dedupe(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function expandCandidate(value: string, home: string, root: string): string {
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

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let index = 0;
  for (;;) {
    const found = text.indexOf(needle, index);
    if (found === -1) return count;
    count += 1;
    index = found + needle.length;
  }
}

function resolveContext(
  options: CodexAdapterOptions,
  input: {
    readonly root?: string | undefined;
    readonly env?: Record<string, string> | undefined;
    readonly probePaths?: readonly string[] | undefined;
  },
): AdapterContext {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, options.env ?? {});
  Object.assign(env, input.env ?? {});
  return {
    home: options.home ?? homedir(),
    root: resolve(input.root ?? options.root ?? process.cwd()),
    env,
    probePaths: input.probePaths ?? options.probePaths ?? splitPath(env['PATH'] ?? ''),
    now: options.now ?? (() => new Date().toISOString()),
  };
}

// ---------------------------------------------------------------------------
// detect
// ---------------------------------------------------------------------------

function detectWith(options: CodexAdapterOptions, input: DetectInput): Promise<DetectResult> {
  const ctx = resolveContext(options, { root: input.cwd ?? options.root, env: input.env, probePaths: input.probePaths });
  const at = ctx.now();
  const sources: DetectionEvidence[] = [];
  const errors: IsolatedError[] = [];
  let executablePath: string | null = null;

  if (input.signal?.aborted === true) {
    return Promise.resolve({
      clientId: 'codex',
      detected: false,
      executablePath: null,
      version: null,
      sources: [],
      errors: [isolated('detected', 'E1_ABORTED', 'detection was aborted', at, 'client:codex')],
    });
  }

  for (const identitySource of CODEX_IDENTITY_SOURCES) {
    try {
      if (identitySource.kind === 'executable') {
        const found = findExecutable(identitySource.value, ctx.probePaths);
        if (found !== null) {
          sources.push({
            source: `executable:${identitySource.value}`,
            kind: 'executable',
            executablePath: found,
            version: null,
            detectedAt: at,
          });
          if (executablePath === null) executablePath = found;
        }
      } else if (identitySource.kind === 'config-path') {
        const expanded = expandCandidate(identitySource.value, ctx.home, ctx.root);
        if (existsSync(expanded)) {
          sources.push({
            source: `path:${expanded}`,
            kind: 'config-path',
            executablePath: null,
            version: null,
            detectedAt: at,
          });
        }
      }
    } catch (error) {
      errors.push(
        isolated('detected', 'E1_PROBE_FAILED', `failed to probe ${identitySource.value}: ${errorMessage(error)}`, at, identitySource.value),
      );
    }
  }

  return Promise.resolve({
    clientId: 'codex',
    detected: sources.length > 0,
    executablePath,
    version: null,
    sources,
    errors,
  });
}

// ---------------------------------------------------------------------------
// inspect: read-only configuration discovery
// ---------------------------------------------------------------------------

function validateEntry(entry: unknown, probePaths: readonly string[]): { reachable: boolean; limitations: string[] } {
  const limitations: string[] = [];
  if (!isRecord(entry)) {
    return { reachable: false, limitations: ['[mcp_servers.ano] entry is not a TOML table'] };
  }
  const unknown = Object.keys(entry).filter((key) => !KNOWN_ENTRY_FIELDS.has(key));
  if (unknown.length > 0) limitations.push(`entry contains unknown fields: ${unknown.join(', ')}`);

  const command = entry['command'];
  if (typeof command === 'string' && command.length > 0) {
    return { reachable: commandReachable(command, probePaths), limitations };
  }
  const url = entry['url'];
  if (typeof url === 'string' && url.length > 0) {
    limitations.push('remote url entry was not probed');
    return { reachable: true, limitations };
  }
  limitations.push('entry exposes neither command nor url');
  return { reachable: false, limitations };
}

function discoverConfig(ctx: AdapterContext): ConfigDiscovery {
  const path = join(ctx.home, '.codex', 'config.toml');
  if (!isFile(path)) {
    return {
      configPath: null,
      scope: null,
      key: null,
      resolvedEntry: null,
      exists: false,
      reachable: false,
      sawCandidateFile: false,
      limitations: ['no declared config candidate exists'],
      errors: [],
    };
  }
  const target: ClientConfigTarget = {
    clientId: 'codex',
    scope: 'user',
    path,
    format: 'toml',
    serverPath: [...CODEX_SERVER_PATH],
    serverName: CODEX_SERVER_NAME,
    allowedRoot: ctx.home,
  };
  let snapshot;
  try {
    snapshot = readClientConfig(target);
  } catch (error) {
    return {
      configPath: path,
      scope: 'user',
      key: 'mcp_servers.ano',
      resolvedEntry: null,
      exists: false,
      reachable: false,
      sawCandidateFile: true,
      limitations: ['config.toml exists but could not be parsed'],
      errors: [isolated('configured', 'E2_PARSE_FAILED', `failed to parse ${path}: ${errorMessage(error)}`, ctx.now(), path)],
    };
  }
  if (!snapshot.containerFound || snapshot.anoEntry === null) {
    return {
      configPath: path,
      scope: 'user',
      key: 'mcp_servers.ano',
      resolvedEntry: null,
      exists: false,
      reachable: false,
      sawCandidateFile: true,
      limitations: ['config.toml exists but contains no [mcp_servers.ano] entry', ...snapshot.warnings],
      errors: [],
    };
  }
  const validation = validateEntry(snapshot.anoEntry, ctx.probePaths);
  return {
    configPath: path,
    scope: 'user',
    key: 'mcp_servers.ano',
    resolvedEntry: redactClientConfigEntry(snapshot.anoEntry),
    exists: true,
    reachable: validation.reachable,
    sawCandidateFile: true,
    limitations: [...validation.limitations, ...snapshot.warnings],
    errors: [],
  };
}

// ---------------------------------------------------------------------------
// inspect: instructions (AGENTS.md) read-only takeover detection
// ---------------------------------------------------------------------------

function detectManagedSection(text: string): { present: boolean; formatVersion: string | null; limitations: string[] } {
  const limitations: string[] = [];
  const begins = countOccurrences(text, MANAGED_INSTRUCTIONS_BEGIN);
  const ends = countOccurrences(text, MANAGED_INSTRUCTIONS_END);
  if (begins === 0 && ends === 0) {
    return { present: false, formatVersion: null, limitations: ['no ANO managed marker pair found'] };
  }
  if (begins !== 1 || ends !== 1) {
    limitations.push(`managed markers are malformed: ${begins} begin / ${ends} end`);
    return { present: false, formatVersion: null, limitations };
  }
  const beginIndex = text.indexOf(MANAGED_INSTRUCTIONS_BEGIN);
  const endIndex = text.indexOf(MANAGED_INSTRUCTIONS_END);
  if (endIndex < beginIndex) {
    limitations.push('managed end marker appears before the begin marker');
    return { present: false, formatVersion: null, limitations };
  }
  const body = text.slice(beginIndex + MANAGED_INSTRUCTIONS_BEGIN.length, endIndex);
  const schema = /schema:\s*(\S+)/u.exec(body);
  const formatVersion = schema?.[1] ?? null;
  if (formatVersion !== MANAGED_INSTRUCTIONS_SCHEMA) {
    limitations.push(`managed section schema ${formatVersion ?? 'missing'} does not match ${MANAGED_INSTRUCTIONS_SCHEMA}`);
  }
  return { present: true, formatVersion, limitations };
}

function inspectRules(ctx: AdapterContext, at: string): RuleInspection {
  const path = join(ctx.root, 'AGENTS.md');
  if (!isFile(path)) {
    return {
      rulePaths: [],
      formatVersion: null,
      hasManagedSection: false,
      limitations: ['no AGENTS.md found at the project root'],
      errors: [],
    };
  }
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return {
      rulePaths: [path],
      formatVersion: null,
      hasManagedSection: false,
      limitations: [],
      errors: [isolated('instructions', 'E6_RULE_READ_FAILED', `failed to read ${path}: ${errorMessage(error)}`, at, path)],
    };
  }
  const managed = detectManagedSection(text);
  return {
    rulePaths: [path],
    formatVersion: managed.formatVersion,
    hasManagedSection: managed.present,
    limitations: managed.limitations,
    errors: [],
  };
}

// ---------------------------------------------------------------------------
// Layer builders
// ---------------------------------------------------------------------------

function buildDetectedLayer(detect: DetectResult, at: string): DetectedLayerReport {
  const source = detect.sources.length > 0 ? detect.sources.map((entry) => entry.source).join(', ') : 'client:codex';
  const limitations: string[] = [];
  let verdict: ClientVerdict;
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

function buildConfiguredLayer(detect: DetectResult, discovery: ConfigDiscovery, at: string): ConfiguredLayerReport {
  const source = discovery.configPath ?? 'client:codex';
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
      limitations: ['installed but no ano MCP entry was found in declared config candidates', ...discovery.limitations],
      errors: discovery.errors,
      details: { configPath: null, scope: null, key: null, resolvedEntry: null, exists: false },
    };
  }
  const limitations = [
    ...(discovery.reachable ? [] : ['configured entry command is not reachable']),
    ...discovery.limitations,
    'TOML configs are read-only in v1; apply is refused',
    'configured but not measured; unverified',
  ];
  return {
    layer: 'configured',
    code: 'E2',
    verdict: 'degraded',
    evidence: 'configured',
    at,
    version: 'config-format:toml',
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

function buildInstructionsLayer(detect: DetectResult, rules: RuleInspection, at: string): InstructionsLayerReport {
  if (!detect.detected) {
    return {
      layer: 'instructions',
      code: 'E6',
      verdict: 'unavailable',
      evidence: 'absent',
      at,
      version: null,
      source: 'client:codex',
      limitations: ['detected prerequisite is unavailable'],
      errors: [],
      details: { rulePaths: [], formatVersion: null, hasManagedSection: false, readOnly: true },
    };
  }
  const details: InstructionsDetails = {
    rulePaths: rules.rulePaths,
    formatVersion: rules.formatVersion,
    hasManagedSection: rules.hasManagedSection,
    readOnly: true,
  };
  const limitations = [
    ...rules.limitations,
    'file presence does not prove the client read or applied the rules',
    'read-only probe: no rule file was written',
  ];
  if (rules.hasManagedSection) {
    limitations.push('managed ANO section detected; installation and enforcement were not verified');
  }
  return {
    layer: 'instructions',
    code: 'E6',
    verdict: 'degraded',
    evidence: rules.rulePaths.length > 0 ? 'measured' : 'absent',
    at,
    version: rules.formatVersion,
    source: rules.rulePaths.length > 0 ? rules.rulePaths.join(', ') : 'client:codex',
    limitations,
    errors: rules.errors,
    details,
  };
}

function buildOrchestrationLayer(detected: boolean, at: string): OrchestrationLayerReport {
  if (!detected) {
    return {
      layer: 'orchestration',
      code: 'E7',
      verdict: 'unavailable',
      evidence: 'absent',
      at,
      version: null,
      source: 'client:codex',
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
    limitations: ['no public dispatch interface enumerated; explicit workflow fallback'],
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
      'no public output-interception interface enumerated',
      'tool-level hooks are not output interception',
    ],
    errors: [],
    details: { publicApi: null, hooksAreToolLevel: true, configured: false, measured: false },
  };
}

function assembleReport(
  detect: DetectResult,
  layers: MutableLayerReports,
  at: string,
  errors: readonly IsolatedError[],
  extraLimitations: readonly string[],
): ClientReport {
  const coreVerdict = weakestVerdict(CORE_LAYERS.map((layer) => layers[layer].verdict));
  const extensionLimitations: string[] = [];
  for (const layer of EXTENSION_LAYERS) {
    const report = layers[layer];
    if (report.verdict === 'unavailable') {
      extensionLimitations.push(`${layer} unavailable: ${report.limitations[0] ?? 'not measured'}`);
    }
  }
  const status: ClientReport['status'] =
    !detect.detected && detect.sources.length === 0
      ? 'unavailable'
      : coreVerdict === 'validated' && errors.length === 0
        ? 'ready'
        : 'degraded';
  return {
    schema: CLIENT_REPORT_SCHEMA,
    clientId: 'codex',
    alias: null,
    status,
    coreVerdict,
    layers,
    generatedAt: at,
    limitations: dedupe([...extraLimitations, ...extensionLimitations, ...errors.map((error) => `${error.code}: ${error.message}`)]),
    errors,
  };
}

function inspectWith(options: CodexAdapterOptions, input: InspectInput): Promise<ClientReport> {
  const ctx = resolveContext(options, { root: input.root, env: input.env });
  const at = ctx.now();
  return detectWith(options, {
    ...(input.env !== undefined ? { env: input.env } : {}),
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  }).then((detect) => {
    const discovery = discoverConfig(ctx);
    const rules = inspectRules(ctx, at);
    const layers: MutableLayerReports = unavailableLayerReports(at, 'client:codex');
    layers.detected = buildDetectedLayer(detect, at);
    layers.configured = buildConfiguredLayer(detect, discovery, at);
    layers.instructions = buildInstructionsLayer(detect, rules, at);
    layers.orchestration = buildOrchestrationLayer(detect.detected, at);
    layers.history = buildHistoryLayer(at);
    layers['output-interception'] = buildOutputInterceptionLayer(at);
    // mcp/tools/brief stay unavailable: inspect never performs a handshake.
    const errors = [...detect.errors, ...discovery.errors, ...rules.errors];
    return assembleReport(detect, layers, at, errors, [
      'mcp/tools/brief not measured by inspect; unverified',
      'synthetic or injected stdio servers prove mechanism only, not real client compatibility',
    ]);
  });
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

function buildTarget(input: ConfigInput, ctx: AdapterContext, root: string): ClientConfigTarget | null {
  const scope = input.target.scope;
  let path: string;
  if (input.target.path !== undefined) {
    path = resolve(input.target.path);
  } else if (scope === 'user') {
    path = join(ctx.home, '.codex', 'config.toml');
  } else {
    return null;
  }
  return {
    clientId: 'codex',
    scope,
    path,
    format: 'toml',
    serverPath: [...CODEX_SERVER_PATH],
    serverName: CODEX_SERVER_NAME,
    allowedRoot: resolve(scope === 'user' ? ctx.home : root),
  };
}

function desiredEntry(root: string): Record<string, unknown> {
  return { command: process.execPath, args: [join(root, 'dist', 'surface', 'mcp.js')] };
}

/**
 * The frozen `ClientAuthorizationRef` (T-080) has no `statement` field, but the
 * T-081 write path requires an auditable human statement. The adapter reads it
 * with a narrow structural cast and refuses the write when it is absent; the
 * CLI layer (T-085) must supply the full credential.
 */
function toConfigAuthorization(ref: ConfigInput['authorization']): ClientConfigAuthorization | null {
  if (ref === undefined || ref === null) return null;
  const statement = (ref as { readonly statement?: unknown }).statement;
  if (typeof statement !== 'string' || statement.trim().length === 0) return null;
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

function toProposedChanges(target: ClientConfigTarget, changes: readonly ClientConfigChange[]) {
  return changes.map((change) => ({
    path: target.path,
    scope: target.scope,
    key: `${target.serverPath.join('.')}.${target.serverName}`,
    operation:
      change.kind === 'add-server'
        ? ('add' as const)
        : change.kind === 'update-server'
          ? ('update' as const)
          : change.kind === 'remove-server'
            ? ('remove' as const)
            : ('none' as const),
    before: change.before,
    after: change.after,
  }));
}

function refusedResult(changes: readonly ProposedChange[], warnings: readonly string[]): ConfigResult {
  return { mode: 'dry-run', changes, backupPlan: null, warnings: [...warnings, 'apply refused; zero write'] };
}

function configWith(options: CodexAdapterOptions, input: ConfigInput): Promise<ConfigResult> {
  const ctx = resolveContext(options, { root: input.root });
  if (input.target.format !== undefined && input.target.format !== 'toml') {
    return Promise.resolve({
      mode: 'dry-run',
      changes: [],
      backupPlan: null,
      warnings: [`codex configuration format is toml; refusing format ${input.target.format}`],
    });
  }
  const root = input.root ?? ctx.root;
  const target = buildTarget(input, ctx, root);
  if (target === null) {
    return Promise.resolve({
      mode: 'dry-run',
      changes: [],
      backupPlan: null,
      warnings: ['codex declares only user-scope ~/.codex/config.toml; refusing to guess a project path'],
    });
  }
  const entry = desiredEntry(root);

  let plan;
  try {
    plan = planClientConfig(target, entry);
  } catch (error) {
    return Promise.resolve({
      mode: 'dry-run',
      changes: [],
      backupPlan: null,
      warnings: [`config plan failed: ${errorMessage(error)}; zero write`],
    });
  }
  const changes = toProposedChanges(target, plan.changes);
  const warnings = [...plan.warnings];

  if (input.mode !== 'apply') {
    return Promise.resolve({ mode: 'dry-run', changes, backupPlan: null, warnings });
  }
  const authorization = toConfigAuthorization(input.authorization);
  if (authorization === null) {
    return Promise.resolve(
      refusedResult(changes, [
        ...warnings,
        'apply refused (authorization reference lacks the auditable statement required by the T-081 write path); dry-run only',
      ]),
    );
  }
  try {
    const applied: ClientConfigResult = applyClientConfig(target, entry, {
      mode: 'apply',
      confirm: true,
      authorization,
      ...(input.backup === undefined ? {} : { backup: input.backup }),
      root,
    });
    if (!applied.applied) {
      return Promise.resolve(
        refusedResult(changes, [
          ...warnings,
          ...applied.warnings,
          applied.changed ? 'apply refused; dry-run only' : 'configuration already matches the desired entry; zero write',
        ]),
      );
    }
    return Promise.resolve({
      mode: 'apply',
      backupId: applied.backupId ?? '',
      backupHash: applied.backupHash ?? '',
      beforeHash: applied.beforeHash ?? '',
      afterHash: applied.afterHash ?? '',
      changes,
      restoredOnFailure: applied.restoredOnFailure,
    });
  } catch (error) {
    return Promise.resolve({
      mode: 'dry-run',
      changes,
      backupPlan: null,
      warnings: [...warnings, `apply failed: ${errorMessage(error)}; zero write`],
    });
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export function createCodexAdapter(options: CodexAdapterOptions = {}): ClientAdapter {
  return {
    id: 'codex' as ClientId,
    identitySources: CODEX_IDENTITY_SOURCES,
    detect: (input: DetectInput) => detectWith(options, input),
    inspect: (input: InspectInput) => inspectWith(options, input),
    config: (input: ConfigInput) => configWith(options, input),
    verify: (input: VerifyInput): Promise<VerifyResult> => verifyStdioMcp(input),
  };
}

/** Production instance; tests must construct their own with injected paths. */
export const codexAdapter: ClientAdapter = createCodexAdapter();

/** Target mapping exported for CLI orchestration (T-085) and tests. */
export function codexConfigTarget(
  scope: ConfigScope,
  paths: { readonly home: string; readonly root: string; readonly path?: string },
): ClientConfigTarget | null {
  const ctx: AdapterContext = {
    home: paths.home,
    root: resolve(paths.root),
    env: {},
    probePaths: [],
    now: () => new Date().toISOString(),
  };
  return buildTarget({ target: { scope }, mode: 'dry-run' }, ctx, ctx.root);
}
