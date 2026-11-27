/**
 * Claude Code adapter (ADR-007 §5/§6, M11/T-082).
 *
 * `cloudcode` is an alias of `claude-code`: it never gets its own ClientId and
 * every report is emitted under `clientId='claude-code'` with `alias='cloudcode'`.
 *
 * Public format basis (see docs/evidence/client-claude-codex.md):
 * - Claude Code reads MCP servers from `~/.claude.json` (user scope) and
 *   `<project>/.mcp.json` (project scope) under the `mcpServers` container.
 *   A stdio entry is `{ command, args, env }`; `~/.claude/settings.json`
 *   carries approvals (`enabledMcpjsonServers`/`disabledMcpjsonServers`), not
 *   `mcpServers` entries.
 * - `CLAUDE.md` is the project instruction file. It is context, not enforced
 *   configuration; this adapter only ever probes it read-only.
 *
 * Hard boundaries: no configuration is written by `detect`/`inspect`; `config`
 * defaults to dry-run and delegates every write to `src/clients/config.ts`
 * (T-081) with an explicit authorization; `verify` reuses the T-080 stdio
 * handshake and never amplifies success into takeover claims.
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
  type InstructionsLayerReport,
  type InstructionsDetails,
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

export const CLAUDE_CODE_SERVER_PATH = ['mcpServers'] as const;
export const CLAUDE_CODE_SERVER_NAME = 'ano';

const DESCRIPTOR = defaultRegistry.get('claude-code');
export const CLAUDE_CODE_IDENTITY_SOURCES = DESCRIPTOR.identitySources;

/** Documentation-backed fields of one Claude Code `mcpServers` entry. */
const KNOWN_ENTRY_FIELDS = new Set([
  'type',
  'url',
  'headers',
  'headersHelper',
  'timeout',
  'alwaysLoad',
  'command',
  'args',
  'env',
  'oauth',
]);

export interface ClaudeCodeAdapterOptions {
  /** Injected home directory; defaults to the process home. Tests must inject. */
  readonly home?: string;
  /** Default project root; detect uses `cwd` first, inspect uses `root` first. */
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

function walkJson(value: unknown, segments: readonly string[]): { found: boolean; value: unknown } {
  let current: unknown = value;
  for (const segment of segments) {
    if (!isRecord(current) || !Object.hasOwn(current, segment)) return { found: false, value: undefined };
    current = current[segment];
  }
  return { found: true, value: current };
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
  options: ClaudeCodeAdapterOptions,
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

function detectWith(options: ClaudeCodeAdapterOptions, input: DetectInput): Promise<DetectResult> {
  const ctx = resolveContext(options, { root: input.cwd ?? options.root, env: input.env, probePaths: input.probePaths });
  const at = ctx.now();
  const sources: DetectionEvidence[] = [];
  const errors: IsolatedError[] = [];
  let executablePath: string | null = null;

  if (input.signal?.aborted === true) {
    return Promise.resolve({
      clientId: 'claude-code',
      detected: false,
      executablePath: null,
      version: null,
      sources: [],
      errors: [isolated('detected', 'E1_ABORTED', 'detection was aborted', at, 'client:claude-code')],
    });
  }

  for (const identitySource of CLAUDE_CODE_IDENTITY_SOURCES) {
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
    clientId: 'claude-code',
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

interface ConfigCandidate {
  readonly path: string;
  readonly scope: ConfigScope;
  /** `~/.claude.json` additionally nests project-local servers under `projects.<root>`. */
  readonly allowProjects: boolean;
}

function configCandidates(ctx: AdapterContext): readonly ConfigCandidate[] {
  return [
    { path: join(ctx.home, '.claude', 'settings.json'), scope: 'user', allowProjects: false },
    { path: join(ctx.home, '.claude.json'), scope: 'user', allowProjects: true },
    { path: join(ctx.root, '.mcp.json'), scope: 'project', allowProjects: false },
  ];
}

function validateEntry(entry: unknown, probePaths: readonly string[]): { reachable: boolean; limitations: string[] } {
  const limitations: string[] = [];
  if (typeof entry === 'string') {
    return {
      reachable: commandReachable(entry, probePaths),
      limitations: ['entry is a bare command string; public docs specify an object with command/args'],
    };
  }
  if (!isRecord(entry)) {
    return { reachable: false, limitations: ['entry is not a JSON object'] };
  }
  const unknown = Object.keys(entry).filter((key) => !KNOWN_ENTRY_FIELDS.has(key));
  if (unknown.length > 0) limitations.push(`entry contains unknown fields: ${unknown.join(', ')}`);

  const type = entry['type'];
  const url = entry['url'];
  const command = entry['command'];
  if (typeof url === 'string' && url.length > 0) {
    if (typeof type !== 'string' || type.length === 0) {
      limitations.push('url entry omits type; Claude Code treats typeless entries as stdio and skips them');
    }
    return { reachable: true, limitations };
  }
  if (typeof command === 'string' && command.length > 0) {
    return { reachable: commandReachable(command, probePaths), limitations };
  }
  limitations.push('entry exposes neither command nor url');
  return { reachable: false, limitations };
}

function discoverConfig(ctx: AdapterContext): ConfigDiscovery {
  const limitations: string[] = [];
  const errors: IsolatedError[] = [];
  const documents = new Map<string, unknown>();
  let sawCandidateFile = false;

  for (const candidate of configCandidates(ctx)) {
    if (!isFile(candidate.path)) continue;
    sawCandidateFile = true;

    let document: unknown;
    const cached = documents.get(candidate.path);
    if (cached !== undefined) {
      document = cached;
    } else {
      try {
        const text = readFileSync(candidate.path, 'utf8');
        const normalized = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
        document = JSON.parse(normalized) as unknown;
        documents.set(candidate.path, document);
      } catch (error) {
        errors.push(
          isolated('configured', 'E2_PARSE_FAILED', `failed to parse ${candidate.path}: ${errorMessage(error)}`, ctx.now(), candidate.path),
        );
        continue;
      }
    }
    if (!isRecord(document)) {
      errors.push(
        isolated('configured', 'E2_PARSE_FAILED', `${candidate.path} must contain a JSON object at the top level`, ctx.now(), candidate.path),
      );
      continue;
    }

    let found = walkJson(document, ['mcpServers', 'ano']);
    if (!found.found && candidate.allowProjects) {
      const projects = document['projects'];
      if (isRecord(projects)) {
        for (const key of [ctx.root, resolve(ctx.root)]) {
          const project = projects[key];
          if (!isRecord(project)) continue;
          const nested = walkJson(project, ['mcpServers', 'ano']);
          if (nested.found) {
            found = nested;
            break;
          }
        }
      }
    }
    if (!found.found) continue;

    const validation = validateEntry(found.value, ctx.probePaths);
    return {
      configPath: candidate.path,
      scope: candidate.scope,
      key: 'mcpServers.ano',
      resolvedEntry: redactClientConfigEntry(found.value),
      exists: true,
      reachable: validation.reachable,
      sawCandidateFile: true,
      limitations: validation.limitations,
      errors: [],
    };
  }

  if (errors.length > 0) {
    limitations.push('declared config candidate exists but no usable ano entry was found');
  } else if (sawCandidateFile) {
    limitations.push('declared config files exist but contain no ano MCP entry');
  } else {
    limitations.push('no declared config candidate exists');
  }
  return {
    configPath: null,
    scope: null,
    key: null,
    resolvedEntry: null,
    exists: false,
    reachable: false,
    sawCandidateFile,
    limitations,
    errors,
  };
}

// ---------------------------------------------------------------------------
// inspect: instructions (CLAUDE.md) read-only takeover detection
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
  const path = join(ctx.root, 'CLAUDE.md');
  if (!isFile(path)) {
    return {
      rulePaths: [],
      formatVersion: null,
      hasManagedSection: false,
      limitations: ['no CLAUDE.md found at the project root'],
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
  const source = detect.sources.length > 0 ? detect.sources.map((entry) => entry.source).join(', ') : 'client:claude-code';
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
  const source = discovery.configPath ?? 'client:claude-code';
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

function buildInstructionsLayer(detect: DetectResult, rules: RuleInspection, at: string): InstructionsLayerReport {
  if (!detect.detected) {
    return {
      layer: 'instructions',
      code: 'E6',
      verdict: 'unavailable',
      evidence: 'absent',
      at,
      version: null,
      source: 'client:claude-code',
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
    source: rules.rulePaths.length > 0 ? rules.rulePaths.join(', ') : 'client:claude-code',
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
      source: 'client:claude-code',
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
    clientId: 'claude-code',
    alias: 'cloudcode',
    status,
    coreVerdict,
    layers,
    generatedAt: at,
    limitations: dedupe([...extraLimitations, ...extensionLimitations, ...errors.map((error) => `${error.code}: ${error.message}`)]),
    errors,
  };
}

function inspectWith(options: ClaudeCodeAdapterOptions, input: InspectInput): Promise<ClientReport> {
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
    const layers: MutableLayerReports = unavailableLayerReports(at, 'client:claude-code');
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

function defaultConfigPath(scope: ConfigScope, ctx: AdapterContext): string {
  if (scope === 'user') return join(ctx.home, '.claude.json');
  return join(ctx.root, '.mcp.json');
}

function buildTarget(input: ConfigInput, ctx: AdapterContext, root: string): ClientConfigTarget {
  const scope = input.target.scope;
  const path = input.target.path === undefined ? defaultConfigPath(scope, ctx) : resolve(input.target.path);
  return {
    clientId: 'claude-code',
    scope,
    path,
    format: 'json',
    serverPath: [...CLAUDE_CODE_SERVER_PATH],
    serverName: CLAUDE_CODE_SERVER_NAME,
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

function configWith(options: ClaudeCodeAdapterOptions, input: ConfigInput): Promise<ConfigResult> {
  const ctx = resolveContext(options, { root: input.root });
  if (input.target.format !== undefined && input.target.format !== 'json') {
    return Promise.resolve({
      mode: 'dry-run',
      changes: [],
      backupPlan: null,
      warnings: [`claude-code configuration format is json; refusing format ${input.target.format}`],
    });
  }
  const root = input.root ?? ctx.root;
  const target = buildTarget(input, ctx, root);
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

export function createClaudeCodeAdapter(options: ClaudeCodeAdapterOptions = {}): ClientAdapter {
  return {
    id: 'claude-code' as ClientId,
    identitySources: CLAUDE_CODE_IDENTITY_SOURCES,
    detect: (input: DetectInput) => detectWith(options, input),
    inspect: (input: InspectInput) => inspectWith(options, input),
    config: (input: ConfigInput) => configWith(options, input),
    verify: (input: VerifyInput): Promise<VerifyResult> => verifyStdioMcp(input),
  };
}

/** Production instance; tests must construct their own with injected paths. */
export const claudeCodeAdapter: ClientAdapter = createClaudeCodeAdapter();

/** Target mapping exported for CLI orchestration (T-085) and tests. */
export function claudeCodeConfigTarget(
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
  return buildTarget({ target: { scope }, mode: 'dry-run' }, ctx, ctx.root);
}
