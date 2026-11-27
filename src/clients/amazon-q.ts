/**
 * Amazon Q Developer adapter (T-096 / CX-06, ADR-008 §3 #14).
 *
 * Product reality (E0/E1, verified 2026-11-23):
 * - Amazon Q Developer IDE plugins are discontinued on 2027-04-30
 *   (https://aws.amazon.com/q/developer/). The CLI lineage continues as Kiro.
 * - Kiro CLI v3+ ships a single standalone `kiro-cli` binary
 *   (https://kiro.dev/docs/cli/). The registry candidate `kiro` is retained as
 *   a legacy/待核实 probe name.
 * - Kiro MCP configuration is JSON with a top-level `mcpServers` container at
 *   `~/.kiro/settings/mcp.json` (user) and `.kiro/settings/mcp.json` (workspace)
 *   (https://kiro.dev/docs/mcp/configuration/). Local entries use
 *   `command`/`args`; workspace settings win over user settings.
 * - Kiro steering rules live in `~/.kiro/steering/` and `.kiro/steering/`
 *   (markdown `.md`, optional YAML front matter; AGENTS.md is also supported)
 *   (https://kiro.dev/docs/steering/).
 *
 * Hard boundaries: this adapter never executes configuration content, never
 * writes files itself (apply is delegated to `src/clients/config.ts`), never
 * reads undeclared paths, and never treats AWS/cloud model-provider capability
 * as host takeover capability. `inspect` performs no stdio handshake, so
 * `mcp`/`tools`/`brief` stay `unavailable`; `detected` is an existence-only
 * (E2) probe and is capped at `degraded` because no version was measured.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLIENT_REPORT_SCHEMA,
  CORE_LAYERS,
  EXTENSION_LAYERS,
  MCP_TOOL_NAMES,
  weakestVerdict,
  type ClientAdapter,
  type ClientId,
  type ClientReport,
  type ClientStatus,
  type ClientVerdict,
  type ConfigFormat,
  type ConfigInput,
  type ConfigResult,
  type ConfigScope,
  type DetectInput,
  type DetectResult,
  type DetectionEvidence,
  type IdentitySource,
  type InspectInput,
  type IsolatedError,
  type MutableLayerReports,
  type ProposedChange,
  type VerifyInput,
  type VerifyResult,
} from './types.ts';
import {
  applyClientConfig,
  planClientConfig,
  type ClientConfigAuthorization,
  type ClientConfigChange,
  type ClientConfigTarget,
} from './config.ts';
import { verifyStdioMcp } from './doctor.ts';
import { redactClientConfigEntry } from './redact.ts';
import { MANAGED_INSTRUCTIONS_BEGIN, MANAGED_INSTRUCTIONS_END } from '../connect/managed-instructions.ts';

export const AMAZON_Q_CLIENT_ID: ClientId = 'amazon-q';

export const AMAZON_Q_SERVER_NAME = 'ano';
export const AMAZON_Q_SERVER_PATH = ['mcpServers'] as const;
export const AMAZON_Q_MCP_KEY = 'mcpServers.ano';

/**
 * Probe order: `kiro-cli` is the documented Kiro v3+ binary (E1); `kiro` is the
 * registry-declared legacy candidate (待核实). The first match wins.
 */
export const AMAZON_Q_EXECUTABLE_NAMES: readonly string[] = Object.freeze(['kiro-cli', 'kiro']);

export interface AmazonQConfigCandidateDeclaration {
  readonly path: string;
  readonly scope: ConfigScope;
  readonly format: ConfigFormat;
  readonly key: string;
  readonly serverPath: readonly string[];
}

/**
 * Public documented Kiro MCP settings (E1). Workspace precedence over user is
 * documented; the adapter probes both and reports the first existing file.
 */
export const AMAZON_Q_CONFIG_CANDIDATES: readonly AmazonQConfigCandidateDeclaration[] = Object.freeze([
  {
    path: '~/.kiro/settings/mcp.json',
    scope: 'user',
    format: 'json',
    key: AMAZON_Q_MCP_KEY,
    serverPath: AMAZON_Q_SERVER_PATH,
  },
  {
    path: '<root>/.kiro/settings/mcp.json',
    scope: 'project',
    format: 'json',
    key: AMAZON_Q_MCP_KEY,
    serverPath: AMAZON_Q_SERVER_PATH,
  },
]);

/**
 * Declared identity sources. Includes the registry candidates plus the
 * E1-verified `kiro-cli` binary; the registry `kiro` name is kept but marked
 * 待核实 because current Kiro docs name `kiro-cli`.
 */
export const AMAZON_Q_IDENTITY_SOURCES: readonly IdentitySource[] = Object.freeze([
  { kind: 'executable', value: 'kiro-cli', detail: 'Kiro CLI v3+ standalone binary（E1: kiro.dev/docs/cli）' },
  { kind: 'executable', value: 'kiro', detail: 'registry 声明的候选；Kiro CLI 旧名/待核实' },
  { kind: 'config-path', value: '~/.kiro/settings/mcp.json', detail: 'Kiro 用户级 MCP 配置（E1: kiro.dev/docs/mcp/configuration）' },
  { kind: 'config-path', value: '<root>/.kiro/settings/mcp.json', detail: 'Kiro 工作区 MCP 配置（E1: kiro.dev/docs/mcp/configuration）' },
  { kind: 'env', value: 'KIRO_HOME', detail: 'Kiro home 覆写环境变量（registry 声明，待核实）' },
]);

export const AMAZON_Q_RULE_PATHS: readonly string[] = Object.freeze([
  '~/.kiro/steering',
  '<root>/.kiro/steering',
]);

export const AMAZON_Q_OFFICIAL_SOURCES: readonly string[] = Object.freeze([
  'https://aws.amazon.com/q/developer/',
  'https://kiro.dev/docs/cli/',
  'https://kiro.dev/docs/mcp/configuration/',
  'https://kiro.dev/docs/steering/',
]);

export const AMAZON_Q_IDE_EOL_DATE = '2027-04-30';

/** Reported limitation prefixes; tests and docs rely on these exact labels. */
export const AMAZON_Q_MEASURED_FACT_PREFIX = 'measured-fact:';
export const AMAZON_Q_CONFIG_FACT_PREFIX = 'config-fact:';
export const AMAZON_Q_PUBLIC_ASSUMPTION_PREFIX = 'public-assumption:';
export const AMAZON_Q_CONFIG_REFUSED_PREFIX = 'config-refused:';

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function dedupe(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function splitPath(value: string | undefined): readonly string[] {
  if (typeof value !== 'string' || value.length === 0) return [];
  return value.split(delimiter).filter((part) => part.length > 0);
}

function collectEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function envValue(env: Record<string, string> | undefined, key: string): string | null {
  if (env === undefined) return null;
  const value = env[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function homeFrom(env: Record<string, string> | undefined): string | null {
  return envValue(env, 'HOME') ?? envValue(env, 'USERPROFILE');
}

function expandPath(path: string, home: string, root: string): string {
  let value = path;
  if (value === '~') value = home;
  else if (value.startsWith('~/')) value = `${home}/${value.slice(2)}`;
  else if (value.startsWith('~\\')) value = `${home}\\${value.slice(2)}`;
  value = value.split('<root>').join(root);
  return resolve(value);
}

function findExecutable(name: string, directories: readonly string[]): string | null {
  for (const directory of directories) {
    for (const suffix of ['', '.exe', '.cmd']) {
      const candidate = resolve(directory, `${name}${suffix}`);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

function walkKey(value: unknown, key: string): { found: boolean; value: unknown } {
  let current: unknown = value;
  for (const part of key.split('.')) {
    if (!isRecord(current)) return { found: false, value: null };
    if (!Object.prototype.hasOwnProperty.call(current, part)) return { found: false, value: null };
    current = current[part];
  }
  return { found: true, value: current };
}

function isolated(layer: IsolatedError['layer'], code: string, message: string, at: string, source: string | null): IsolatedError {
  return { layer, code, message, at, source };
}

/** The ANO MCP entry published by this package (`package.json` `mcp` field). */
function anoEntry(): Record<string, unknown> {
  const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
  return { command: process.execPath, args: [join(packageRoot, 'dist', 'surface', 'mcp.js')] };
}

// ---------------------------------------------------------------------------
// Read-only configuration fact
// ---------------------------------------------------------------------------

interface ConfigFact {
  readonly configPath: string | null;
  readonly scope: ConfigScope | null;
  readonly format: ConfigFormat | null;
  readonly key: string | null;
  readonly resolvedEntry: unknown;
  readonly exists: boolean;
  readonly checked: readonly string[];
  readonly errors: readonly IsolatedError[];
}

function probeConfigFact(home: string, root: string, at: string): ConfigFact {
  const checked: string[] = [];
  const errors: IsolatedError[] = [];
  for (const candidate of AMAZON_Q_CONFIG_CANDIDATES) {
    const path = expandPath(candidate.path, home, root);
    checked.push(path);
    if (!isFile(path)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    } catch (error) {
      errors.push(isolated('configured', 'E2_CONFIG_UNREADABLE', `declared candidate is not readable JSON: ${errorMessage(error)}`, at, path));
      continue;
    }
    const walked = walkKey(parsed, candidate.key);
    if (walked.found) {
      return {
        configPath: path,
        scope: candidate.scope,
        format: candidate.format,
        key: candidate.key,
        resolvedEntry: redactClientConfigEntry(walked.value),
        exists: true,
        checked,
        errors,
      };
    }
  }
  return { configPath: null, scope: null, format: null, key: null, resolvedEntry: null, exists: false, checked, errors };
}

// ---------------------------------------------------------------------------
// Rule / instruction scan
// ---------------------------------------------------------------------------

interface RuleScan {
  readonly rulePaths: readonly string[];
  readonly formatVersion: string | null;
  readonly hasManagedSection: boolean;
}

function scanRules(home: string, root: string): RuleScan {
  const rulePaths: string[] = [];
  let formatVersion: string | null = null;
  let hasManagedSection = false;
  for (const relative of AMAZON_Q_RULE_PATHS) {
    const path = expandPath(relative, home, root);
    if (!isDirectory(path)) continue;
    rulePaths.push(path);
    let entries: string[] = [];
    try {
      entries = readdirSync(path).sort();
    } catch {
      entries = [];
    }
    let markdownSeen = false;
    for (const name of entries) {
      if (!name.endsWith('.md')) continue;
      markdownSeen = true;
      const file = join(path, name);
      if (!isFile(file)) continue;
      rulePaths.push(file);
      const text = readText(file);
      if (text === null) continue;
      if (text.includes(MANAGED_INSTRUCTIONS_BEGIN) && text.includes(MANAGED_INSTRUCTIONS_END)) hasManagedSection = true;
    }
    if (markdownSeen && formatVersion === null) formatVersion = 'kiro-steering-md/1';
  }
  return { rulePaths, formatVersion, hasManagedSection };
}

// ---------------------------------------------------------------------------
// Layer builders
// ---------------------------------------------------------------------------

function buildDetectedLayer(detect: DetectResult, at: string): MutableLayerReports['detected'] {
  const source = detect.sources.length > 0 ? detect.sources.map((entry) => entry.source).join(', ') : `client:${AMAZON_Q_CLIENT_ID}`;
  const limitations: string[] = [];
  let verdict: ClientVerdict;
  if (!detect.detected) {
    verdict = 'unavailable';
  } else {
    verdict = 'degraded';
    limitations.push(`${AMAZON_Q_MEASURED_FACT_PREFIX} existence-only probe of declared sources; no version measured (E2 caps detected at degraded)`);
  }
  return {
    layer: 'detected',
    code: 'E1',
    verdict,
    evidence: detect.detected ? 'measured' : 'absent',
    at,
    version: null,
    source,
    limitations,
    errors: detect.errors,
    details: {
      detected: detect.detected,
      executablePath: detect.executablePath,
      version: null,
      sources: detect.sources,
    },
  };
}

function buildConfiguredLayer(detect: DetectResult, fact: ConfigFact, at: string): MutableLayerReports['configured'] {
  const source = fact.configPath ?? `client:${AMAZON_Q_CLIENT_ID}`;
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
  if (!fact.exists) {
    return {
      layer: 'configured',
      code: 'E2',
      verdict: 'degraded',
      evidence: 'absent',
      at,
      version: null,
      source,
      limitations: [
        `${AMAZON_Q_CONFIG_FACT_PREFIX} installed but no ano MCP entry found in declared config candidates`,
        ...fact.checked.map((path) => `${AMAZON_Q_CONFIG_FACT_PREFIX} checked ${path}`),
        ...fact.errors.map((error) => `${error.code}: ${error.message}`),
      ],
      errors: fact.errors,
      details: { configPath: null, scope: null, key: null, resolvedEntry: null, exists: false },
    };
  }
  return {
    layer: 'configured',
    code: 'E2',
    verdict: 'degraded',
    evidence: 'configured',
    at,
    version: fact.format === null ? null : `config-format:${fact.format}`,
    source,
    limitations: [
      `${AMAZON_Q_CONFIG_FACT_PREFIX} ano entry found in a declared config candidate`,
      `${AMAZON_Q_CONFIG_FACT_PREFIX} configured but not measured: no stdio handshake was run`,
      ...fact.errors.map((error) => `${error.code}: ${error.message}`),
    ],
    errors: fact.errors,
    details: {
      configPath: fact.configPath,
      scope: fact.scope,
      key: fact.key,
      resolvedEntry: fact.resolvedEntry,
      exists: true,
    },
  };
}

function buildInstructionsLayer(detect: DetectResult, home: string, root: string, at: string): MutableLayerReports['instructions'] {
  if (!detect.detected) {
    return {
      layer: 'instructions',
      code: 'E6',
      verdict: 'unavailable',
      evidence: 'absent',
      at,
      version: null,
      source: `client:${AMAZON_Q_CLIENT_ID}`,
      limitations: ['detected prerequisite is unavailable'],
      errors: [],
      details: { rulePaths: [], formatVersion: null, hasManagedSection: false, readOnly: true },
    };
  }
  const scan = scanRules(home, root);
  return {
    layer: 'instructions',
    code: 'E6',
    verdict: 'degraded',
    evidence: scan.rulePaths.length > 0 ? 'measured' : 'absent',
    at,
    version: scan.formatVersion,
    source: scan.rulePaths.length > 0 ? scan.rulePaths.join(', ') : `client:${AMAZON_Q_CLIENT_ID}`,
    limitations: [
      'file presence does not prove Kiro read or applied the steering rules',
      'Kiro also supports AGENTS.md in the workspace root and ~/.kiro/steering (E1); not enumerated by the registry rulePaths',
      'rule detection is read-only; writing rules requires explicit authorization',
      ...(scan.rulePaths.length > 0 ? [] : ['no declared Kiro steering file was found']),
      ...(scan.hasManagedSection ? [] : ['no ANO managed-section marker was found in the detected rule files']),
    ],
    errors: [],
    details: {
      rulePaths: scan.rulePaths,
      formatVersion: scan.formatVersion,
      hasManagedSection: scan.hasManagedSection,
      readOnly: true,
    },
  };
}

function buildOrchestrationLayer(detect: DetectResult, at: string): MutableLayerReports['orchestration'] {
  if (!detect.detected) {
    return {
      layer: 'orchestration',
      code: 'E7',
      verdict: 'unavailable',
      evidence: 'absent',
      at,
      version: null,
      source: `client:${AMAZON_Q_CLIENT_ID}`,
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
      'no public Amazon Q / Kiro dispatch interface for ANO was verified',
      'explicit workflow / harness fallback only; automatic dispatch is not claimed',
    ],
    errors: [],
    details: { publicApi: null, documented: false, mode: 'explicit-workflow', measured: false },
  };
}

function buildHistoryLayer(at: string): MutableLayerReports['history'] {
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

function buildOutputInterceptionLayer(at: string): MutableLayerReports['output-interception'] {
  return {
    layer: 'output-interception',
    code: 'E9',
    verdict: 'unavailable',
    evidence: 'absent',
    at,
    version: null,
    source: 'adr-007:no-public-interface',
    limitations: [
      'no public Amazon Q / Kiro output-interception interface was verified',
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

function unavailableBriefLayer(at: string): MutableLayerReports['brief'] {
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

// ---------------------------------------------------------------------------
// config target resolution
// ---------------------------------------------------------------------------

function selectCandidate(
  target: ConfigInput['target'],
  home: string,
  root: string | null,
): AmazonQConfigCandidateDeclaration | null {
  if (target.path !== undefined) {
    const requested = resolve(target.path);
    return AMAZON_Q_CONFIG_CANDIDATES.find((candidate) => expandPath(candidate.path, home, root ?? home) === requested) ?? null;
  }
  if (target.scope === 'user') {
    return AMAZON_Q_CONFIG_CANDIDATES.find((candidate) => candidate.scope === 'user') ?? null;
  }
  if (root === null) return null;
  return AMAZON_Q_CONFIG_CANDIDATES.find((candidate) => candidate.scope === target.scope) ?? null;
}

type ResolvedTarget = { readonly ok: true; readonly target: ClientConfigTarget } | { readonly ok: false; readonly error: string };

function resolveTarget(target: ConfigInput['target'], home: string, root: string | null): ResolvedTarget {
  const candidate = selectCandidate(target, home, root);
  if (candidate === null) {
    return { ok: false, error: 'requested target is not a declared Amazon Q / Kiro config candidate; refusing to guess a path or format' };
  }
  if (candidate.scope !== 'user' && root === null) {
    return { ok: false, error: 'project/workspace target requires an injected root' };
  }
  const path = expandPath(candidate.path, home, root ?? home);
  const allowedRoot = candidate.scope === 'user' ? home : (root ?? home);
  return {
    ok: true,
    target: {
      clientId: AMAZON_Q_CLIENT_ID,
      scope: candidate.scope,
      path,
      format: target.format ?? candidate.format,
      serverPath: [...candidate.serverPath],
      serverName: AMAZON_Q_SERVER_NAME,
      allowedRoot,
    },
  };
}

function configEnv(input: ConfigInput): Record<string, string> | undefined {
  const extra = (input as { readonly env?: unknown }).env;
  if (extra !== undefined && extra !== null && typeof extra === 'object' && !Array.isArray(extra)) {
    return extra as Record<string, string>;
  }
  return undefined;
}

function configHome(input: ConfigInput): string {
  return homeFrom(configEnv(input)) ?? homeFrom(collectEnv()) ?? homedir();
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
// Adapter
// ---------------------------------------------------------------------------

export interface AmazonQAdapterOptions {
  readonly now?: () => string;
}

/**
 * Amazon Q Developer adapter. `detect` probes declared sources only;
 * `inspect` keeps measured and configuration facts separate and never performs
 * a stdio handshake; `config` proposes a legal Kiro `mcpServers.ano` entry and
 * delegates any authorized write to `src/clients/config.ts`; `verify` refuses
 * to fabricate a handshake without a real or injected stdio command.
 */
export function createAmazonQAdapter(options: AmazonQAdapterOptions = {}): ClientAdapter {
  const now = options.now ?? (() => new Date().toISOString());

  const adapter: ClientAdapter = {
    id: AMAZON_Q_CLIENT_ID,
    identitySources: AMAZON_Q_IDENTITY_SOURCES,

    async detect(input: DetectInput): Promise<DetectResult> {
      const at = now();
      const env = input.env ?? collectEnv();
      const probePaths = dedupe([...(input.probePaths ?? []), ...splitPath(env['PATH'] ?? '')]);
      const home = homeFrom(env) ?? homedir();
      const root = input.cwd ?? process.cwd();
      const sources: DetectionEvidence[] = [];
      const errors: IsolatedError[] = [];

      let executablePath: string | null = null;
      for (const name of AMAZON_Q_EXECUTABLE_NAMES) {
        const found = findExecutable(name, probePaths);
        if (found !== null) {
          executablePath = found;
          sources.push({
            source: `executable:${name}`,
            kind: 'executable',
            executablePath: found,
            version: null,
            detectedAt: at,
          });
          break;
        }
      }

      for (const candidate of AMAZON_Q_CONFIG_CANDIDATES) {
        const path = expandPath(candidate.path, home, root);
        if (isFile(path)) {
          sources.push({
            source: `config-path:${candidate.path}`,
            kind: 'config-path',
            executablePath: null,
            version: null,
            detectedAt: at,
          });
        }
      }

      const kiroHome = envValue(env, 'KIRO_HOME');
      if (kiroHome !== null) {
        sources.push({ source: 'env:KIRO_HOME', kind: 'env', executablePath: null, version: null, detectedAt: at });
      }

      if (sources.length === 0) {
        errors.push(isolated('detected', 'E1_NO_DECLARED_SOURCE', 'no declared Amazon Q / Kiro source was found; paths were not guessed', at, null));
      }

      return { clientId: AMAZON_Q_CLIENT_ID, detected: sources.length > 0, executablePath, version: null, sources, errors };
    },

    async inspect(input: InspectInput): Promise<ClientReport> {
      const at = now();
      const env = input.env;
      const home = homeFrom(env) ?? homedir();
      const root = input.root !== undefined ? resolve(input.root) : input.cwd !== undefined ? resolve(input.cwd) : process.cwd();
      const detection = await adapter.detect({
        ...(input.env !== undefined ? { env: input.env } : {}),
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      });

      const fact = probeConfigFact(home, root, at);
      const layers: MutableLayerReports = {
        detected: buildDetectedLayer(detection, at),
        configured: buildConfiguredLayer(detection, fact, at),
        mcp: unavailableMcpLayer(at),
        tools: unavailableToolsLayer(at),
        brief: unavailableBriefLayer(at),
        instructions: buildInstructionsLayer(detection, home, root, at),
        orchestration: buildOrchestrationLayer(detection, at),
        history: buildHistoryLayer(at),
        'output-interception': buildOutputInterceptionLayer(at),
      };

      const coreVerdict = weakestVerdict(CORE_LAYERS.map((layer) => layers[layer].verdict));
      const errors = [...detection.errors, ...fact.errors];
      const status: ClientStatus = !detection.detected ? 'unavailable' : coreVerdict === 'validated' && errors.length === 0 ? 'ready' : 'degraded';

      const limitations = dedupe([
        'Amazon Q Developer IDE plugin support ends 2027-04-30; the CLI lineage continues as Kiro (E1: aws.amazon.com/q/developer/)',
        'AWS/cloud model-provider capability is not Amazon Q host takeover capability; no cloud capability is claimed as local control',
        `${AMAZON_Q_MEASURED_FACT_PREFIX} detection is an existence-only probe of declared public sources; no version was measured`,
        `${AMAZON_Q_CONFIG_FACT_PREFIX} configuration facts are read-only and kept separate from measured detection`,
        `${AMAZON_Q_PUBLIC_ASSUMPTION_PREFIX} mcp/tools/brief were not measured; call verify() with a real or injected stdio command`,
        ...EXTENSION_LAYERS.filter((layer) => layers[layer].verdict === 'unavailable').map(
          (layer) => `${layer} unavailable: ${layers[layer].limitations[0] ?? 'not measured'}`,
        ),
        ...errors.map((error) => `${error.code}: ${error.message}`),
      ]);

      return {
        schema: CLIENT_REPORT_SCHEMA,
        clientId: AMAZON_Q_CLIENT_ID,
        alias: null,
        status,
        coreVerdict,
        layers,
        generatedAt: at,
        limitations,
        errors,
      };
    },

    async config(input: ConfigInput): Promise<ConfigResult> {
      const warnings = ['configuration writes are owned by the ANO config service; this adapter only proposes'];
      const home = configHome(input);
      const root = input.root !== undefined ? resolve(input.root) : null;
      const resolved = resolveTarget(input.target, home, root);
      if (!resolved.ok) {
        return {
          mode: 'dry-run',
          changes: [],
          backupPlan: null,
          warnings: [...warnings, `${AMAZON_Q_CONFIG_REFUSED_PREFIX} ${resolved.error}; zero write`],
        };
      }
      const clientTarget = resolved.target;
      if (input.target.format === 'toml') {
        warnings.push('Kiro public configuration is JSON; a TOML target is not a documented Kiro format');
      }
      const entry = anoEntry();
      let plan;
      try {
        plan = planClientConfig(clientTarget, entry);
      } catch (error) {
        return { mode: 'dry-run', changes: [], backupPlan: null, warnings: [...warnings, `config plan failed: ${errorMessage(error)}; zero write`] };
      }
      const changes = proposedChanges(clientTarget, plan.changes);
      const backupPlan = plan.changed && plan.afterHash !== null
        ? { backupId: `planned:${plan.afterHash.slice(0, 16)}`, path: clientTarget.path, hashAlgorithm: 'sha256' as const }
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
        const applied = applyClientConfig(clientTarget, entry, {
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

  return adapter;
}

export const amazonQAdapter: ClientAdapter = createAmazonQAdapter();
