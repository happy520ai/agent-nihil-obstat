/**
 * Hermes Agent adapter (ADR-007 §5, ADR-008 §3, M12/T-095).
 *
 * Hermes Agent is a CLI + desktop app + cloud portal. Public interface
 * evidence (E1, see docs/evidence/client-open-agents.md):
 * - Configuration lives in `~/.hermes/config.yaml` under `mcp_servers`; a stdio
 *   server is `{ command, args, env, cwd, ... }`, an HTTP server is
 *   `{ url, headers, ... }`.
 * - Project context files are documented with precedence
 *   `.hermes.md` -> `AGENTS.override.md` -> `AGENTS.md` -> `CLAUDE.md` ->
 *   `.cursorrules`; `SOUL.md` is loaded from `HERMES_HOME` (`~/.hermes/SOUL.md`).
 * - Subagents are documented as an agent feature and Python RPC tool access
 *   exists, but no public DAG dispatch API is documented, so `orchestration`
 *   stays `degraded` with `mode:'explicit-workflow'`.
 *
 * Hard boundary (T-092 / task brief): `configCandidates.format` is json|toml
 * only, so this adapter deliberately does NOT declare a YAML config candidate
 * and refuses to write YAML. The documented entry shape is exported as inert
 * data (`hermesDesiredEntry`) for callers that have their own YAML writer; the
 * adapter itself performs zero writes. `detect`/`inspect` are read-only and
 * never execute configuration content; `verify` reuses the T-080 handshake.
 * Cloud/desktop capabilities are reported as degraded/unavailable and are never
 * presented as local takeover.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
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
  type VerifyInput,
  type VerifyResult,
} from './types.ts';
import { verifyStdioMcp } from './doctor.ts';
import { defaultRegistry } from './registry.ts';
import {
  MANAGED_INSTRUCTIONS_BEGIN,
  MANAGED_INSTRUCTIONS_END,
  MANAGED_INSTRUCTIONS_SCHEMA,
} from '../connect/managed-instructions.ts';

export const HERMES_SERVER_NAME = 'ano';
export const HERMES_SERVER_PATH = ['mcp_servers'] as const;
export const HERMES_USER_CONFIG = join('.hermes', 'config.yaml');
export const HERMES_SOUL = join('.hermes', 'SOUL.md');
/** Documented project context files, in documented precedence order. */
export const HERMES_PROJECT_RULE_PATHS = ['.hermes.md', 'HERMES.md', 'AGENTS.override.md', 'AGENTS.md', 'CLAUDE.md', '.cursorrules'] as const;

/** Declared identity sources; identical to the T-092 registry descriptor. */
const DESCRIPTOR = defaultRegistry.get('hermes-agent');
export const HERMES_AGENT_IDENTITY_SOURCES = DESCRIPTOR.identitySources;

export interface HermesAgentAdapterOptions {
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

function resolveContext(
  options: HermesAgentAdapterOptions,
  input: { readonly root?: string | undefined; readonly env?: Record<string, string> | undefined; readonly probePaths?: readonly string[] | undefined },
): AdapterContext {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, options.env ?? {});
  Object.assign(env, input.env ?? {});
  const home = options.home ?? env['HOME'] ?? env['USERPROFILE'] ?? env['HERMES_HOME'] ?? homedir();
  return {
    home,
    root: resolve(input.root ?? options.root ?? process.cwd()),
    env,
    probePaths: input.probePaths ?? options.probePaths ?? splitPath(env['PATH']),
    now: options.now ?? (() => new Date().toISOString()),
  };
}

/**
 * The documented Hermes `mcp_servers.<name>` stdio entry, exported as inert
 * data. It is never written by this adapter (YAML is outside the v1 write path).
 */
export function hermesDesiredEntry(): Record<string, unknown> {
  const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
  return { command: process.execPath, args: [join(packageRoot, 'dist', 'surface', 'mcp.js')], env: {} };
}

// ---------------------------------------------------------------------------
// detect
// ---------------------------------------------------------------------------

function detectWith(options: HermesAgentAdapterOptions, input: DetectInput): DetectResult {
  const ctx = resolveContext(options, { root: input.cwd ?? options.root, env: input.env, probePaths: input.probePaths });
  const at = ctx.now();
  const sources: DetectionEvidence[] = [];
  const errors: IsolatedError[] = [];

  if (input.signal?.aborted === true) {
    return {
      clientId: 'hermes-agent',
      detected: false,
      executablePath: null,
      version: null,
      sources: [],
      errors: [isolated('detected', 'E1_ABORTED', 'detection was aborted', at, 'client:hermes-agent')],
    };
  }

  for (const identitySource of HERMES_AGENT_IDENTITY_SOURCES) {
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
      } else if (identitySource.kind === 'env') {
        const raw = ctx.env[identitySource.value];
        if (typeof raw === 'string' && raw.trim().length > 0 && existsSync(resolve(raw))) {
          sources.push({ source: `env:${identitySource.value}`, kind: 'env', executablePath: null, version: null, detectedAt: at });
        }
      }
    } catch (error) {
      errors.push(isolated('detected', 'E1_PROBE_FAILED', `failed to probe ${identitySource.value}: ${errorMessage(error)}`, at, identitySource.value));
    }
  }

  const executablePath = sources.find((source) => source.kind === 'executable')?.executablePath ?? null;
  return {
    clientId: 'hermes-agent',
    detected: sources.length > 0,
    executablePath,
    version: null,
    sources,
    errors,
  };
}

// ---------------------------------------------------------------------------
// inspect: rule/instruction detection (config.yaml is intentionally not read)
// ---------------------------------------------------------------------------

function hasManagedMarkers(text: string): boolean {
  return text.includes(MANAGED_INSTRUCTIONS_BEGIN) && text.includes(MANAGED_INSTRUCTIONS_END);
}

function inspectRules(ctx: AdapterContext, at: string): RuleInspection {
  const rulePaths: string[] = [];
  const limitations: string[] = [];
  const errors: IsolatedError[] = [];
  let hasManagedSection = false;

  const consider = (file: string, formatVersion: string): void => {
    if (!isFile(file) || rulePaths.includes(file)) return;
    rulePaths.push(file);
    const text = readText(file);
    if (text !== null && hasManagedMarkers(text)) hasManagedSection = true;
    void formatVersion;
  };

  for (const relative of HERMES_PROJECT_RULE_PATHS) {
    consider(resolve(ctx.root, relative), relative.endsWith('.mdc') ? 'cursor-mdc/1' : 'hermes-context-md/1');
  }

  const cursorRules = resolve(ctx.root, '.cursor', 'rules');
  if (isDirectory(cursorRules)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(cursorRules).sort();
    } catch (error) {
      errors.push(isolated('instructions', 'E6_RULE_READ_FAILED', `failed to read ${cursorRules}: ${errorMessage(error)}`, at, cursorRules));
    }
    for (const name of entries) {
      if (name.endsWith('.mdc')) consider(join(cursorRules, name), 'cursor-mdc/1');
    }
  }

  consider(join(ctx.home, HERMES_SOUL), 'hermes-soul-md/1');

  if (rulePaths.length === 0) limitations.push('no declared Hermes context file was found');
  if (!hasManagedSection) limitations.push('no ANO managed-section marker was found in the detected context files');
  return {
    rulePaths,
    formatVersion: hasManagedSection ? MANAGED_INSTRUCTIONS_SCHEMA : rulePaths.length > 0 ? 'hermes-context-md/1' : null,
    hasManagedSection,
    limitations,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Layer builders
// ---------------------------------------------------------------------------

function buildDetectedLayer(detect: DetectResult, at: string): MutableLayerReports['detected'] {
  const source = detect.sources.length > 0 ? detect.sources.map((entry) => entry.source).join(', ') : 'client:hermes-agent';
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

function buildConfiguredLayer(detect: DetectResult, at: string): MutableLayerReports['configured'] {
  const source = 'client:hermes-agent';
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
  return {
    layer: 'configured',
    code: 'E2',
    verdict: 'degraded',
    evidence: 'absent',
    at,
    version: null,
    source,
    limitations: [
      'config carrier is YAML (~/.hermes/config.yaml, mcp_servers); T-092 configCandidates.format is json|toml only, so no YAML candidate is declared',
      'YAML config content is not read and not written by the v1 client-config path; 待核实',
      'configured but not measured; unverified',
    ],
    errors: [],
    details: { configPath: null, scope: null, key: null, resolvedEntry: null, exists: false },
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
      source: 'client:hermes-agent',
      limitations: ['detected prerequisite is unavailable'],
      errors: [],
      details: { rulePaths: [], formatVersion: null, hasManagedSection: false, readOnly: true },
    };
  }
  const limitations = [
    ...rules.limitations,
    'file presence does not prove Hermes read or applied the context files',
    'rule detection is read-only; writing context files requires explicit authorization',
  ];
  return {
    layer: 'instructions',
    code: 'E6',
    verdict: 'degraded',
    evidence: rules.rulePaths.length > 0 ? 'measured' : 'absent',
    at,
    version: rules.formatVersion,
    source: rules.rulePaths.length > 0 ? rules.rulePaths.join(', ') : 'client:hermes-agent',
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
      source: 'client:hermes-agent',
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
      'documented subagents and Python RPC tool access are not a public DAG dispatch API',
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
      'desktop and cloud-portal capabilities are not local output interception',
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

function inspectWith(options: HermesAgentAdapterOptions, input: InspectInput): ClientReport {
  const ctx = resolveContext(options, { root: input.root ?? input.cwd ?? options.root, env: input.env });
  const at = ctx.now();
  const detect = detectWith(options, {
    ...(input.env !== undefined ? { env: input.env } : {}),
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });
  const rules = inspectRules(ctx, at);

  const layers: MutableLayerReports = {
    detected: buildDetectedLayer(detect, at),
    configured: buildConfiguredLayer(detect, at),
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
    'YAML config carrier is deliberately not declared, not read and not written (v1 write path is json/toml only); 待核实',
    'desktop and cloud-portal capabilities are degraded/unavailable and are not local takeover',
    'a successful MCP handshake would not imply rule takeover, DAG takeover, history support or output interception',
  ];
  for (const layer of EXTENSION_LAYERS) {
    const report = layers[layer];
    if (report.verdict === 'unavailable') limitations.push(`${layer} unavailable: ${report.limitations[0] ?? 'not measured'}`);
  }
  const status: ClientReport['status'] = !detect.detected ? 'unavailable' : coreVerdict === 'validated' ? 'ready' : 'degraded';
  return {
    schema: CLIENT_REPORT_SCHEMA,
    clientId: 'hermes-agent',
    alias: null,
    status,
    coreVerdict,
    layers,
    generatedAt: at,
    limitations: dedupe(limitations),
    errors: [...detect.errors, ...rules.errors],
  };
}

// ---------------------------------------------------------------------------
// config: zero-write degradation (YAML is outside the v1 write path)
// ---------------------------------------------------------------------------

function configWith(_options: HermesAgentAdapterOptions, _input: ConfigInput): ConfigResult {
  return {
    mode: 'dry-run',
    changes: [],
    backupPlan: null,
    warnings: [
      'Hermes Agent config carrier is YAML (~/.hermes/config.yaml, mcp_servers); the v1 client-config write path supports json/toml only',
      'no YAML config candidate is declared (T-092 configCandidates.format is json|toml); 待核实',
      'config refused; zero write',
    ],
  };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export function createHermesAgentAdapter(options: HermesAgentAdapterOptions = {}): ClientAdapter {
  return {
    id: 'hermes-agent' as ClientId,
    identitySources: HERMES_AGENT_IDENTITY_SOURCES,
    detect: async (input: DetectInput) => detectWith(options, input),
    inspect: async (input: InspectInput) => inspectWith(options, input),
    config: async (input: ConfigInput) => configWith(options, input),
    verify: (input: VerifyInput): Promise<VerifyResult> => verifyStdioMcp(input),
  };
}

/** Production instance; tests must construct their own with injected paths. */
export const hermesAgentAdapter: ClientAdapter = createHermesAgentAdapter();
