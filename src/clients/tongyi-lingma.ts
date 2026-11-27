/**
 * 通义灵码 (Tongyi Lingma) adapter (T-096 / CX-06, ADR-008 §3 #17).
 *
 * Product reality (E0/E1, verified 2026-11-23):
 * - 通义灵码 is Alibaba's product, now branded Qoder CN (docs.qoder.cn). It is
 *   a DIFFERENT product from the international Qoder (docs.qoder.com,
 *   `ClientId='qoder'`); the two must never be merged.
 * - Qoder CN CLI executable is `qodercn` (E1: docs.qoder.cn/cli/installation,
 *   `qodercn --version`; npm `@qodercn-ai/qoderclicn`). The registry candidate
 *   `qoder` is the international Qoder CLI command and is retained only as a
 *   clearly-marked 待核实 probe name, never as proof of 通义灵码 identity.
 * - Qoder CN MCP configuration is JSON with a top-level `mcpServers` container
 *   at `~/.qoder-cn/settings.json` (user), `<project>/.qoder/settings.json`,
 *   `<project>/.mcp.json` and `<project>/.qoder/settings.local.json`
 *   (E1: docs.qoder.cn/cli/mcp-reference). Local entries use `command`/`args`.
 * - CLI management is `qodercn mcp add|list|remove`; the user config directory
 *   can be relocated with `QODERCN_CONFIG_DIR` (default `~/.qoder-cn`).
 * - Rules/instructions: `context.fileName` defaults to `AGENTS.md`
 *   (E1: docs.qoder.cn/cli/settings-reference).
 *
 * Hard boundaries: configuration content is never executed, writes are
 * delegated to `src/clients/config.ts`, undeclared paths are never probed, and
 * Chinese product/enterprise promotion (E0) is never treated as interface
 * evidence. `inspect` performs no stdio handshake; `detected` is existence-only
 * (E2) and capped at `degraded`.
 */

import { readFileSync, statSync } from 'node:fs';
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
import { unavailableLayerReports, verifyStdioMcp } from './doctor.ts';
import { redactClientConfigEntry } from './redact.ts';
import { MANAGED_INSTRUCTIONS_BEGIN, MANAGED_INSTRUCTIONS_END } from '../connect/managed-instructions.ts';

export const TONGYI_LINGMA_CLIENT_ID: ClientId = 'tongyi-lingma';

export const TONGYI_LINGMA_SERVER_NAME = 'ano';
export const TONGYI_LINGMA_SERVER_PATH = ['mcpServers'] as const;
export const TONGYI_LINGMA_MCP_KEY = 'mcpServers.ano';

/**
 * Probe order: `qodercn` is the documented Qoder CN CLI (E1); `qoder` is the
 * registry candidate and collides with the international Qoder CLI, so it is
 * marked 待核实 and never used as proof of 通义灵码 identity.
 */
export const TONGYI_LINGMA_EXECUTABLE_NAMES: readonly string[] = Object.freeze(['qodercn', 'qoder']);

export interface TongyiLingmaConfigCandidateDeclaration {
  readonly path: string;
  readonly scope: ConfigScope;
  readonly format: ConfigFormat;
  readonly key: string;
  readonly serverPath: readonly string[];
}

/**
 * Public documented Qoder CN MCP settings (E1). Precedence (later wins):
 * user -> project settings.json -> project .mcp.json -> local -> CLI args.
 */
export const TONGYI_LINGMA_CONFIG_CANDIDATES: readonly TongyiLingmaConfigCandidateDeclaration[] = Object.freeze([
  {
    path: '~/.qoder-cn/settings.json',
    scope: 'user',
    format: 'json',
    key: TONGYI_LINGMA_MCP_KEY,
    serverPath: TONGYI_LINGMA_SERVER_PATH,
  },
  {
    path: '<root>/.qoder/settings.json',
    scope: 'project',
    format: 'json',
    key: TONGYI_LINGMA_MCP_KEY,
    serverPath: TONGYI_LINGMA_SERVER_PATH,
  },
  {
    path: '<root>/.mcp.json',
    scope: 'project',
    format: 'json',
    key: TONGYI_LINGMA_MCP_KEY,
    serverPath: TONGYI_LINGMA_SERVER_PATH,
  },
  {
    path: '<root>/.qoder/settings.local.json',
    scope: 'workspace',
    format: 'json',
    key: TONGYI_LINGMA_MCP_KEY,
    serverPath: TONGYI_LINGMA_SERVER_PATH,
  },
]);

/**
 * Declared identity sources. `qodercn` and `~/.qoder-cn` are E1-verified Qoder
 * CN sources; `qoder` is the registry candidate and is explicitly marked
 * 待核实/ambiguous because it is the international Qoder CLI command.
 */
export const TONGYI_LINGMA_IDENTITY_SOURCES: readonly IdentitySource[] = Object.freeze([
  { kind: 'executable', value: 'qodercn', detail: 'Qoder CN CLI 官方命令（E1: docs.qoder.cn/cli/installation）' },
  { kind: 'executable', value: 'qoder', detail: 'registry 声明的候选；与国际版 Qoder CLI 命令相同，待核实，不得据此认定通义灵码' },
  { kind: 'config-path', value: '~/.qoder-cn/settings.json', detail: 'Qoder CN 用户级设置（E1: docs.qoder.cn/cli/settings-reference）' },
  { kind: 'config-path', value: '<root>/.qoder/settings.json', detail: 'Qoder CN 项目级设置（E1；与国际版 Qoder 共用路径，须按产品身份区分）' },
  { kind: 'config-path', value: '<root>/.mcp.json', detail: 'Qoder CN 项目级 MCP 设置（E1: docs.qoder.cn/cli/mcp-reference）' },
  { kind: 'env', value: 'QODERCN_CONFIG_DIR', detail: 'Qoder CN 配置目录覆写变量（E1: docs.qoder.cn/cli/settings-reference）' },
]);

export const TONGYI_LINGMA_RULE_PATHS: readonly string[] = Object.freeze(['AGENTS.md']);

export const TONGYI_LINGMA_OFFICIAL_SOURCES: readonly string[] = Object.freeze([
  'https://lingma.aliyun.com/',
  'https://docs.qoder.cn/',
  'https://help.aliyun.com/zh/lingma/',
]);

/** Reported limitation prefixes; tests and docs rely on these exact labels. */
export const TONGYI_LINGMA_MEASURED_FACT_PREFIX = 'measured-fact:';
export const TONGYI_LINGMA_CONFIG_FACT_PREFIX = 'config-fact:';
export const TONGYI_LINGMA_PUBLIC_ASSUMPTION_PREFIX = 'public-assumption:';
export const TONGYI_LINGMA_CONFIG_REFUSED_PREFIX = 'config-refused:';

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
  for (const candidate of TONGYI_LINGMA_CONFIG_CANDIDATES) {
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

function scanRules(root: string): RuleScan {
  const rulePaths: string[] = [];
  let hasManagedSection = false;
  for (const relative of TONGYI_LINGMA_RULE_PATHS) {
    const path = resolve(root, relative);
    if (!isFile(path)) continue;
    rulePaths.push(path);
    const text = readText(path);
    if (text === null) continue;
    if (text.includes(MANAGED_INSTRUCTIONS_BEGIN) && text.includes(MANAGED_INSTRUCTIONS_END)) hasManagedSection = true;
  }
  return { rulePaths, formatVersion: rulePaths.length > 0 ? 'agents-md/1' : null, hasManagedSection };
}

// ---------------------------------------------------------------------------
// Layer builders
// ---------------------------------------------------------------------------

function buildDetectedLayer(detect: DetectResult, at: string): MutableLayerReports['detected'] {
  const source = detect.sources.length > 0 ? detect.sources.map((entry) => entry.source).join(', ') : `client:${TONGYI_LINGMA_CLIENT_ID}`;
  const limitations: string[] = [];
  let verdict: ClientVerdict;
  if (!detect.detected) {
    verdict = 'unavailable';
  } else {
    verdict = 'degraded';
    limitations.push(`${TONGYI_LINGMA_MEASURED_FACT_PREFIX} existence-only probe of declared sources; no version measured (E2 caps detected at degraded)`);
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
  const source = fact.configPath ?? `client:${TONGYI_LINGMA_CLIENT_ID}`;
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
        `${TONGYI_LINGMA_CONFIG_FACT_PREFIX} installed but no ano MCP entry found in declared config candidates`,
        ...fact.checked.map((path) => `${TONGYI_LINGMA_CONFIG_FACT_PREFIX} checked ${path}`),
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
      `${TONGYI_LINGMA_CONFIG_FACT_PREFIX} ano entry found in a declared config candidate`,
      `${TONGYI_LINGMA_CONFIG_FACT_PREFIX} configured but not measured: no stdio handshake was run`,
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

function buildInstructionsLayer(detect: DetectResult, root: string, at: string): MutableLayerReports['instructions'] {
  if (!detect.detected) {
    return {
      layer: 'instructions',
      code: 'E6',
      verdict: 'unavailable',
      evidence: 'absent',
      at,
      version: null,
      source: `client:${TONGYI_LINGMA_CLIENT_ID}`,
      limitations: ['detected prerequisite is unavailable'],
      errors: [],
      details: { rulePaths: [], formatVersion: null, hasManagedSection: false, readOnly: true },
    };
  }
  const scan = scanRules(root);
  return {
    layer: 'instructions',
    code: 'E6',
    verdict: 'degraded',
    evidence: scan.rulePaths.length > 0 ? 'measured' : 'absent',
    at,
    version: scan.formatVersion,
    source: scan.rulePaths.length > 0 ? scan.rulePaths.join(', ') : `client:${TONGYI_LINGMA_CLIENT_ID}`,
    limitations: [
      'file presence does not prove Qoder CN read or applied AGENTS.md',
      'rule detection is read-only; writing rules requires explicit authorization',
      ...(scan.rulePaths.length > 0 ? [] : ['no AGENTS.md rule file was found']),
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
      source: `client:${TONGYI_LINGMA_CLIENT_ID}`,
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
      'Qoder CN CLI scheduled tasks/run-tasks are the client\'s own task scheduler, not a verified ANO dispatch interface',
      'no public ANO dispatch interface was verified; explicit workflow fallback only',
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
      'no public Qoder CN output-interception interface was verified',
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
): TongyiLingmaConfigCandidateDeclaration | null {
  if (target.path !== undefined) {
    const requested = resolve(target.path);
    return TONGYI_LINGMA_CONFIG_CANDIDATES.find((candidate) => expandPath(candidate.path, home, root ?? home) === requested) ?? null;
  }
  if (target.scope === 'user') {
    return TONGYI_LINGMA_CONFIG_CANDIDATES.find((candidate) => candidate.scope === 'user') ?? null;
  }
  if (root === null) return null;
  return TONGYI_LINGMA_CONFIG_CANDIDATES.find((candidate) => candidate.scope === target.scope) ?? null;
}

type ResolvedTarget = { readonly ok: true; readonly target: ClientConfigTarget } | { readonly ok: false; readonly error: string };

function resolveTarget(target: ConfigInput['target'], home: string, root: string | null): ResolvedTarget {
  const candidate = selectCandidate(target, home, root);
  if (candidate === null) {
    return { ok: false, error: 'requested target is not a declared Qoder CN config candidate; refusing to guess a path or format' };
  }
  if (candidate.scope !== 'user' && root === null) {
    return { ok: false, error: 'project/workspace target requires an injected root' };
  }
  const path = expandPath(candidate.path, home, root ?? home);
  const allowedRoot = candidate.scope === 'user' ? home : (root ?? home);
  return {
    ok: true,
    target: {
      clientId: TONGYI_LINGMA_CLIENT_ID,
      scope: candidate.scope,
      path,
      format: target.format ?? candidate.format,
      serverPath: [...candidate.serverPath],
      serverName: TONGYI_LINGMA_SERVER_NAME,
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

export interface TongyiLingmaAdapterOptions {
  readonly now?: () => string;
}

/**
 * 通义灵码 adapter. `detect` probes declared sources only and never treats the
 * international `qoder` command as proof of 通义灵码 identity; `inspect` keeps
 * measured and configuration facts separate and performs no stdio handshake;
 * `config` proposes a legal Qoder CN `mcpServers.ano` entry and delegates any
 * authorized write to `src/clients/config.ts`; `verify` refuses to fabricate a
 * handshake without a real or injected stdio command.
 */
export function createTongyiLingmaAdapter(options: TongyiLingmaAdapterOptions = {}): ClientAdapter {
  const now = options.now ?? (() => new Date().toISOString());

  const adapter: ClientAdapter = {
    id: TONGYI_LINGMA_CLIENT_ID,
    identitySources: TONGYI_LINGMA_IDENTITY_SOURCES,

    async detect(input: DetectInput): Promise<DetectResult> {
      const at = now();
      const env = input.env ?? collectEnv();
      const probePaths = dedupe([...(input.probePaths ?? []), ...splitPath(env['PATH'] ?? '')]);
      const home = homeFrom(env) ?? homedir();
      const root = input.cwd ?? process.cwd();
      const sources: DetectionEvidence[] = [];
      const errors: IsolatedError[] = [];

      let executablePath: string | null = null;
      for (const name of TONGYI_LINGMA_EXECUTABLE_NAMES) {
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

      for (const candidate of TONGYI_LINGMA_CONFIG_CANDIDATES) {
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

      const configDir = envValue(env, 'QODERCN_CONFIG_DIR');
      if (configDir !== null) {
        sources.push({ source: 'env:QODERCN_CONFIG_DIR', kind: 'env', executablePath: null, version: null, detectedAt: at });
      }

      if (sources.length === 0) {
        errors.push(isolated('detected', 'E1_NO_DECLARED_SOURCE', 'no declared Qoder CN source was found; paths were not guessed', at, null));
      }

      return { clientId: TONGYI_LINGMA_CLIENT_ID, detected: sources.length > 0, executablePath, version: null, sources, errors };
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
        instructions: buildInstructionsLayer(detection, root, at),
        orchestration: buildOrchestrationLayer(detection, at),
        history: buildHistoryLayer(at),
        'output-interception': buildOutputInterceptionLayer(at),
      };

      const coreVerdict = weakestVerdict(CORE_LAYERS.map((layer) => layers[layer].verdict));
      const errors = [...detection.errors, ...fact.errors];
      const status: ClientStatus = !detection.detected ? 'unavailable' : coreVerdict === 'validated' && errors.length === 0 ? 'ready' : 'degraded';

      const limitations = dedupe([
        '通义灵码 (Qoder CN) 与国际版 Qoder 是不同产品，不得合并；官方来源为 docs.qoder.cn / lingma.aliyun.com，不是 docs.qoder.com',
        'Qoder CN 的模型供应商/云端能力不是宿主接管能力；不把模型能力误当宿主能力',
        'Qoder CN CLI 官方命令为 qodercn（E1）；registry 的 qoder 可执行候选待核实，不得据此认定通义灵码身份',
        `${TONGYI_LINGMA_MEASURED_FACT_PREFIX} detection is an existence-only probe of declared public sources; no version was measured`,
        `${TONGYI_LINGMA_CONFIG_FACT_PREFIX} configuration facts are read-only and kept separate from measured detection`,
        `${TONGYI_LINGMA_PUBLIC_ASSUMPTION_PREFIX} mcp/tools/brief were not measured; call verify() with a real or injected stdio command`,
        ...EXTENSION_LAYERS.filter((layer) => layers[layer].verdict === 'unavailable').map(
          (layer) => `${layer} unavailable: ${layers[layer].limitations[0] ?? 'not measured'}`,
        ),
        ...errors.map((error) => `${error.code}: ${error.message}`),
      ]);

      return {
        schema: CLIENT_REPORT_SCHEMA,
        clientId: TONGYI_LINGMA_CLIENT_ID,
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
          warnings: [...warnings, `${TONGYI_LINGMA_CONFIG_REFUSED_PREFIX} ${resolved.error}; zero write`],
        };
      }
      const clientTarget = resolved.target;
      if (input.target.format === 'toml') {
        warnings.push('Qoder CN public configuration is JSON; a TOML target is not a documented Qoder CN format');
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

export const tongyiLingmaAdapter: ClientAdapter = createTongyiLingmaAdapter();
