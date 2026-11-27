/**
 * Kilo Code adapter (ADR-007 §5, ADR-008 §3, M12/T-095).
 *
 * Kilo Code is an IDE extension plus CLI (`kilo`, npm `@kilocode/cli`). Public
 * interface evidence (E1, see docs/evidence/client-open-agents.md):
 * - MCP servers live under the `mcp` key of `~/.config/kilo/kilo.jsonc` (global)
 *   or project `kilo.jsonc` / `.kilo/kilo.jsonc`; project config wins. A local
 *   entry is `{ type:"local", command:[exe,...], environment:{...}, enabled,
 *   timeout }`; a remote entry is `{ type:"remote", url, headers, ... }`.
 * - Rules are Markdown files under `.kilo/rules/` (backward compatible
 *   `.kilocode/rules/`), referenced by the `instructions` array in kilo.jsonc.
 * - The legacy "Orchestrator Mode" is documented as built into all agents; no
 *   public DAG dispatch API exists, so `orchestration` stays `degraded` with
 *   `mode:'explicit-workflow'`.
 *
 * Hard boundaries: `detect`/`inspect` are read-only and never execute
 * configuration content; `config` defaults to dry-run and delegates every write
 * to `src/clients/config.ts` (T-081) with an explicit authorization; `verify`
 * reuses the T-080 stdio handshake. Kilo's JSONC dialect is read tolerantly for
 * discovery, but the frozen v1 write path only accepts strict JSON, so a
 * commented JSONC file degrades to a zero-write dry-run instead of being
 * rewritten.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
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
import {
  MANAGED_INSTRUCTIONS_BEGIN,
  MANAGED_INSTRUCTIONS_END,
  MANAGED_INSTRUCTIONS_SCHEMA,
} from '../connect/managed-instructions.ts';

export const KILO_SERVER_NAME = 'ano';
export const KILO_SERVER_PATH = ['mcp'] as const;
export const KILO_USER_CONFIG = join('.config', 'kilo', 'kilo.jsonc');
export const KILO_PROJECT_CONFIGS = ['kilo.jsonc', join('.kilo', 'kilo.jsonc')] as const;
export const KILO_RULE_PATHS = ['.kilo/rules', '.kilocode/rules'] as const;

/** Declared identity sources; identical to the T-092 registry descriptor. */
const DESCRIPTOR = defaultRegistry.get('kilo-code');
export const KILO_CODE_IDENTITY_SOURCES = DESCRIPTOR.identitySources;

export interface KiloCodeAdapterOptions {
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

/** Kilo's documented local entry carries `command` as an array. */
function entryCommand(entry: unknown): string | null {
  if (entry === null || typeof entry !== 'object') return null;
  const record = entry as Record<string, unknown>;
  const command = record['command'];
  if (Array.isArray(command)) {
    for (const part of command) {
      if (typeof part === 'string' && part.length > 0) return part;
    }
    return null;
  }
  if (typeof command === 'string' && command.length > 0) return command;
  return null;
}

function isRemoteEntry(entry: unknown): boolean {
  if (entry === null || typeof entry !== 'object') return false;
  return typeof (entry as Record<string, unknown>)['url'] === 'string';
}

/** Strip JSONC comments and trailing commas without touching string contents. */
function stripJsonc(text: string): string {
  let output = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quote !== null) {
      output += character;
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      output += character;
      continue;
    }
    if (character === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
      output += '\n';
      continue;
    }
    if (character === '/' && text[index + 1] === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1;
      index += 1;
      continue;
    }
    output += character;
  }
  return output.replace(/,(\s*[}\]])/gu, '$1');
}

function parseJsonc(text: string): unknown {
  const normalized = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return JSON.parse(stripJsonc(normalized)) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function walkJson(value: unknown, segments: readonly string[]): { found: boolean; value: unknown } {
  let current: unknown = value;
  for (const segment of segments) {
    if (!isRecord(current) || !Object.hasOwn(current, segment)) return { found: false, value: undefined };
    current = current[segment];
  }
  return { found: true, value: current };
}

function resolveContext(
  options: KiloCodeAdapterOptions,
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
  return { type: 'local', command: [process.execPath, join(packageRoot, 'dist', 'surface', 'mcp.js')], enabled: true };
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

function detectWith(options: KiloCodeAdapterOptions, input: DetectInput): DetectResult {
  const ctx = resolveContext(options, { root: input.cwd ?? options.root, env: input.env, probePaths: input.probePaths });
  const at = ctx.now();
  const sources: DetectionEvidence[] = [];
  const errors: IsolatedError[] = [];

  if (input.signal?.aborted === true) {
    return {
      clientId: 'kilo-code',
      detected: false,
      executablePath: null,
      version: null,
      sources: [],
      errors: [isolated('detected', 'E1_ABORTED', 'detection was aborted', at, 'client:kilo-code')],
    };
  }

  for (const identitySource of KILO_CODE_IDENTITY_SOURCES) {
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
    clientId: 'kilo-code',
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

interface DeclaredCandidate {
  readonly path: string;
  readonly scope: ConfigScope;
}

function declaredCandidates(ctx: AdapterContext): readonly DeclaredCandidate[] {
  const candidates: DeclaredCandidate[] = [];
  for (const relative of KILO_PROJECT_CONFIGS) candidates.push({ path: join(ctx.root, relative), scope: 'project' });
  candidates.push({ path: join(ctx.home, KILO_USER_CONFIG), scope: 'user' });
  return candidates;
}

function discoverConfig(ctx: AdapterContext): ConfigDiscovery {
  const limitations: string[] = [];
  const errors: IsolatedError[] = [];
  let sawCandidateFile = false;

  for (const candidate of declaredCandidates(ctx)) {
    if (!isFile(candidate.path)) continue;
    sawCandidateFile = true;
    const target: ClientConfigTarget = {
      clientId: 'kilo-code',
      scope: candidate.scope,
      path: candidate.path,
      format: 'json',
      serverPath: [...KILO_SERVER_PATH],
      serverName: KILO_SERVER_NAME,
      allowedRoot: allowedRootForPath(candidate.scope, ctx),
    };

    let entry: unknown;
    let parseFailed = false;
    try {
      const snapshot = readClientConfig(target);
      if (!snapshot.containerFound) {
        limitations.push('config file exists but the mcp container was not found');
        return { configPath: candidate.path, scope: candidate.scope, key: [...KILO_SERVER_PATH, KILO_SERVER_NAME].join('.'), resolvedEntry: null, exists: true, reachable: false, sawCandidateFile: true, limitations, errors };
      }
      entry = snapshot.anoEntry;
    } catch (error) {
      // JSONC with comments: fall back to a tolerant read-only parse so the
      // discovery layer can still report the declared entry.
      const text = readText(candidate.path);
      if (text === null) {
        errors.push(isolated('configured', 'E2_PARSE_FAILED', `failed to read ${candidate.path}: ${errorMessage(error)}`, ctx.now(), candidate.path));
        parseFailed = true;
      } else {
        try {
          const document = parseJsonc(text);
          const walked = walkJson(document, [...KILO_SERVER_PATH, KILO_SERVER_NAME]);
          if (!walked.found) {
            limitations.push('JSONC config parsed tolerantly but no mcp.ano entry was found');
            return { configPath: candidate.path, scope: candidate.scope, key: [...KILO_SERVER_PATH, KILO_SERVER_NAME].join('.'), resolvedEntry: null, exists: true, reachable: false, sawCandidateFile: true, limitations, errors };
          }
          entry = walked.value;
          limitations.push('config is JSONC with comments; read tolerantly, but the v1 write path requires strict JSON');
        } catch (parseError) {
          errors.push(isolated('configured', 'E2_PARSE_FAILED', `failed to parse ${candidate.path}: ${errorMessage(parseError)}`, ctx.now(), candidate.path));
          parseFailed = true;
        }
      }
    }
    if (parseFailed) continue;
    if (entry === null || entry === undefined) {
      limitations.push('config file has an mcp container but no ano entry');
      return { configPath: candidate.path, scope: candidate.scope, key: [...KILO_SERVER_PATH, KILO_SERVER_NAME].join('.'), resolvedEntry: null, exists: true, reachable: false, sawCandidateFile: true, limitations, errors };
    }
    const command = entryCommand(entry);
    const reachable = command !== null ? commandReachable(command, ctx.probePaths) : isRemoteEntry(entry);
    if (!reachable) limitations.push('configured entry exposes no reachable local command');
    return {
      configPath: candidate.path,
      scope: candidate.scope,
      key: [...KILO_SERVER_PATH, KILO_SERVER_NAME].join('.'),
      resolvedEntry: redactClientConfigEntry(entry),
      exists: true,
      reachable,
      sawCandidateFile: true,
      limitations,
      errors,
    };
  }

  if (errors.length > 0) limitations.push('declared config candidate exists but no usable ano entry was found');
  else if (sawCandidateFile) limitations.push('declared config files exist but contain no ano MCP entry');
  else limitations.push('no declared Kilo Code config candidate exists');
  return { configPath: null, scope: null, key: null, resolvedEntry: null, exists: false, reachable: false, sawCandidateFile, limitations, errors };
}

// ---------------------------------------------------------------------------
// inspect: rule/instruction detection
// ---------------------------------------------------------------------------

function hasManagedMarkers(text: string): boolean {
  return text.includes(MANAGED_INSTRUCTIONS_BEGIN) && text.includes(MANAGED_INSTRUCTIONS_END);
}

function inspectRules(ctx: AdapterContext, at: string): RuleInspection {
  const rulePaths: string[] = [];
  const limitations: string[] = [];
  const errors: IsolatedError[] = [];
  let hasManagedSection = false;

  const consider = (file: string): void => {
    if (!isFile(file)) return;
    if (rulePaths.includes(file)) return;
    rulePaths.push(file);
    const text = readText(file);
    if (text !== null && hasManagedMarkers(text)) hasManagedSection = true;
  };

  for (const relative of KILO_RULE_PATHS) {
    const path = resolve(ctx.root, relative);
    if (isDirectory(path)) {
      let entries: string[] = [];
      try {
        entries = readdirSync(path).sort();
      } catch (error) {
        errors.push(isolated('instructions', 'E6_RULE_READ_FAILED', `failed to read ${path}: ${errorMessage(error)}`, at, path));
        continue;
      }
      for (const name of entries) {
        if (name.endsWith('.md')) consider(join(path, name));
      }
      continue;
    }
    consider(path);
  }

  // The `instructions` array in kilo.jsonc is the documented way to reference
  // rule files. Non-glob entries that exist are included read-only.
  for (const candidate of declaredCandidates(ctx)) {
    const text = readText(candidate.path);
    if (text === null) continue;
    let document: unknown;
    try {
      document = parseJsonc(text);
    } catch {
      continue;
    }
    const instructions = walkJson(document, ['instructions']);
    if (!instructions.found || !Array.isArray(instructions.value)) continue;
    for (const item of instructions.value) {
      if (typeof item !== 'string' || item.length === 0) continue;
      if (/[*?[\]{}]/u.test(item)) continue;
      consider(resolve(ctx.root, item));
    }
  }

  if (rulePaths.length === 0) limitations.push('no declared Kilo Code rule file was found');
  if (!hasManagedSection) limitations.push('no ANO managed-section marker was found in the detected rule files');
  return {
    rulePaths,
    formatVersion: hasManagedSection ? MANAGED_INSTRUCTIONS_SCHEMA : rulePaths.length > 0 ? 'kilo-rules-md/1' : null,
    hasManagedSection,
    limitations,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Layer builders
// ---------------------------------------------------------------------------

function buildDetectedLayer(detect: DetectResult, at: string): MutableLayerReports['detected'] {
  const source = detect.sources.length > 0 ? detect.sources.map((entry) => entry.source).join(', ') : 'client:kilo-code';
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
  const source = discovery.configPath ?? 'client:kilo-code';
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
    version: 'config-format:jsonc',
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
      source: 'client:kilo-code',
      limitations: ['detected prerequisite is unavailable'],
      errors: [],
      details: { rulePaths: [], formatVersion: null, hasManagedSection: false, readOnly: true },
    };
  }
  const limitations = [
    ...rules.limitations,
    'file presence does not prove Kilo Code read or applied the rules',
    'rule detection is read-only; writing rules requires explicit authorization',
  ];
  return {
    layer: 'instructions',
    code: 'E6',
    verdict: 'degraded',
    evidence: rules.rulePaths.length > 0 ? 'measured' : 'absent',
    at,
    version: rules.formatVersion,
    source: rules.rulePaths.length > 0 ? rules.rulePaths.join(', ') : 'client:kilo-code',
    limitations,
    errors: rules.errors,
    details: {
      rulePaths: rules.rulePaths,
      formatVersion: rules.formatVersion,
      hasManagedSection: rules.hasManagedSection,
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
      source: 'client:kilo-code',
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
      'the documented legacy Orchestrator Mode is built into agents but exposes no public DAG dispatch interface',
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
    limitations: ['no public Kilo Code output-interception interface was documented', 'tool-level hooks are not output interception'],
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

function inspectWith(options: KiloCodeAdapterOptions, input: InspectInput): ClientReport {
  const ctx = resolveContext(options, { root: input.root ?? input.cwd ?? options.root, env: input.env });
  const at = ctx.now();
  const detect = detectWith(options, {
    ...(input.env !== undefined ? { env: input.env } : {}),
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });
  const discovery = discoverConfig(ctx);
  const rules = inspectRules(ctx, at);

  const layers: MutableLayerReports = {
    detected: buildDetectedLayer(detect, at),
    configured: buildConfiguredLayer(detect, discovery, at),
    mcp: unavailableMcpLayer(at),
    tools: unavailableToolsLayer(at),
    brief: unavailableBriefLayer(at),
    instructions: buildInstructionsLayer(detect, rules, at),
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
    clientId: 'kilo-code',
    alias: null,
    status,
    coreVerdict,
    layers,
    generatedAt: at,
    limitations: dedupe(limitations),
    errors: [...detect.errors, ...discovery.errors, ...rules.errors],
  };
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

function defaultProjectConfigPath(ctx: AdapterContext): string {
  for (const relative of KILO_PROJECT_CONFIGS) {
    const path = join(ctx.root, relative);
    if (isFile(path)) return path;
  }
  return join(ctx.root, KILO_PROJECT_CONFIGS[0]!);
}

function buildTarget(input: ConfigInput, ctx: AdapterContext): ClientConfigTarget {
  const scope = input.target.scope;
  const path =
    input.target.path !== undefined
      ? resolve(input.target.path)
      : scope === 'user'
        ? join(ctx.home, KILO_USER_CONFIG)
        : defaultProjectConfigPath(ctx);
  return {
    clientId: 'kilo-code',
    scope,
    path,
    format: 'json',
    serverPath: [...KILO_SERVER_PATH],
    serverName: KILO_SERVER_NAME,
    allowedRoot: allowedRootForPath(scope, ctx),
  };
}

function configWith(options: KiloCodeAdapterOptions, input: ConfigInput): ConfigResult {
  const ctx = resolveContext(options, { root: input.root });
  const warnings: string[] = [];
  if (input.target.format !== undefined && input.target.format !== 'json') {
    return { mode: 'dry-run', changes: [], backupPlan: null, warnings: [`Kilo Code configuration format is json/jsonc; refusing format ${input.target.format}`] };
  }
  if (input.target.scope === 'workspace' && input.target.path === undefined) {
    warnings.push('Kilo Code documents user and project scopes; workspace scope maps to the project config file');
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

export function createKiloCodeAdapter(options: KiloCodeAdapterOptions = {}): ClientAdapter {
  return {
    id: 'kilo-code' as ClientId,
    identitySources: KILO_CODE_IDENTITY_SOURCES,
    detect: async (input: DetectInput) => detectWith(options, input),
    inspect: async (input: InspectInput) => inspectWith(options, input),
    config: async (input: ConfigInput) => configWith(options, input),
    verify: (input: VerifyInput): Promise<VerifyResult> => verifyStdioMcp(input),
  };
}

/** Production instance; tests must construct their own with injected paths. */
export const kiloCodeAdapter: ClientAdapter = createKiloCodeAdapter();

/** Target mapping exported for CLI orchestration and tests. */
export function kiloCodeConfigTarget(
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
