/**
 * DeepSeek Harness adapter (ADR-008 §8, M12/T-097).
 *
 * `dsh` is an alias of `deepseek-harness`; it is resolved by the registry and
 * is never a separate unknown identity. DeepSeek Harness is a real product
 * (official product page, MIT/TypeScript repository and documentation site),
 * so the client-level identity is `declared` (E1) and the adapter is evidence
 * driven instead of a permanent ban.
 *
 * Public basis (see docs/evidence/client-deepseek-harness.md):
 * - CLI executable `dsh` (`npx @deepseek-ai/dsh web`), profiles
 *   `web/headless/sdk/sdk-minimal/acp`.
 * - Configuration carrier is Cordis YAML: `cordis.yml` and the user patch
 *   `$DSH_HOME/cordis.patch.yml` (plus `$DSH_HOME/profiles/<name>/cordis.patch.yml`).
 * - ANO is loaded as an MCP server by DSH's own MCP client
 *   `@deepseek-ai/dsh-mcp-client` (`mcp__<serverName>__<tool>`).
 * - ACP stdio (`dsh --profile acp`) and SDK stdio JSON-RPC (`dsh --profile sdk`)
 *   are DSH's own interfaces; they are NOT ANO MCP verification.
 *
 * Hard boundaries: detect/inspect are read-only and probe only declared
 * sources; `config` never writes (the Cordis YAML carrier is not writable by
 * the T-081 config service, which supports json|toml only); `verify` delegates
 * to the T-080 stdio handshake and refuses to pass an ACP/SDK profile off as
 * ANO MCP verification. No private path or YAML schema is guessed.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, isAbsolute, join, resolve } from 'node:path';
import {
  CLIENT_REPORT_SCHEMA,
  CORE_LAYERS,
  EXTENSION_LAYERS,
  MCP_TOOL_NAMES,
  type ClientAdapter,
  type CapabilityLayer,
  type ClientId,
  type ClientReport,
  type ClientStatus,
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
  type VerifyInput,
  type VerifyResult,
  weakestVerdict,
} from './types.ts';
import { defaultRegistry } from './registry.ts';
import { unavailableLayerReports, verifyStdioMcp } from './doctor.ts';

export const DEEPSEEK_HARNESS_ID = 'deepseek-harness' as const;
export const DEEPSEEK_HARNESS_ALIAS = 'dsh' as const;
export const DEEPSEEK_HARNESS_SERVER_NAME = 'ano' as const;
export const DEEPSEEK_HARNESS_NPM_PACKAGE = '@deepseek-ai/dsh' as const;
export const DEEPSEEK_HARNESS_MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client' as const;

/** Documented `dsh --profile` values (E1). ACP/SDK are DSH interfaces, not ANO MCP. */
export const DEEPSEEK_HARNESS_CLI_PROFILES = ['web', 'headless', 'sdk', 'sdk-minimal', 'acp'] as const;

/** Limitation prefixes; tests and docs rely on these exact labels. */
export const DSH_MEASURED_FACT_PREFIX = 'measured-fact:';
export const DSH_PUBLIC_ASSUMPTION_PREFIX = 'public-assumption:';
export const DSH_CONFIG_REFUSED_PREFIX = 'config-refused:';

const DESCRIPTOR = defaultRegistry.get(DEEPSEEK_HARNESS_ID);
export const DEEPSEEK_HARNESS_IDENTITY_SOURCES = DESCRIPTOR.identitySources;
export const DEEPSEEK_HARNESS_OFFICIAL_SOURCES = DESCRIPTOR.officialSources;

/**
 * Declared configuration carriers. Both are Cordis YAML; the exact patch schema
 * is 待核实 and is never guessed. `$DSH_HOME` is expanded from the injected env.
 */
export interface DeepSeekHarnessConfigCandidateDeclaration {
  readonly path: string;
  readonly scope: ConfigScope;
  readonly format: 'yaml';
  /** Dotted key inside the document; null while the schema is unverified. */
  readonly key: string | null;
}

export const DEEPSEEK_HARNESS_CONFIG_CANDIDATES: readonly DeepSeekHarnessConfigCandidateDeclaration[] = Object.freeze([
  { path: '<root>/cordis.yml', scope: 'project', format: 'yaml', key: null },
  { path: '$DSH_HOME/cordis.patch.yml', scope: 'user', format: 'yaml', key: null },
]);

/** Documented user patch path template (profile name is caller-supplied, never guessed). */
export const DEEPSEEK_HARNESS_PROFILE_PATCH_TEMPLATE = '$DSH_HOME/profiles/<name>/cordis.patch.yml';

export interface DeepSeekHarnessAdapterOptions {
  /** Injected home directory; defaults to HOME/USERPROFILE then the process home. */
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
  readonly dshHome: string | null;
  readonly now: () => string;
}

interface ConfigFact {
  readonly configPath: string | null;
  readonly scope: ConfigScope | null;
  readonly format: 'yaml' | null;
  readonly key: string | null;
  readonly exists: boolean;
  readonly checked: readonly string[];
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

function expandCandidate(value: string, ctx: AdapterContext): string {
  let expanded = value;
  // Substitute placeholders before path joining so `$DSH_HOME` and `<root>`
  // prefixes are never concatenated onto the project root.
  if (ctx.dshHome !== null) expanded = expanded.split('$DSH_HOME').join(ctx.dshHome);
  expanded = expanded.split('<root>').join(ctx.root);
  if (expanded === '~') expanded = ctx.home;
  else if (expanded.startsWith('~/')) expanded = join(ctx.home, expanded.slice(2));
  else if (expanded.startsWith('~\\')) expanded = join(ctx.home, expanded.slice(2));
  else if (!isAbsolute(expanded)) expanded = join(ctx.root, expanded);
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
  options: DeepSeekHarnessAdapterOptions,
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
  const home = options.home ?? env['HOME'] ?? env['USERPROFILE'] ?? homedir();
  const dshHomeRaw = env['DSH_HOME'];
  const dshHome = typeof dshHomeRaw === 'string' && dshHomeRaw.length > 0 ? resolve(dshHomeRaw) : null;
  return {
    home,
    root: resolve(input.root ?? options.root ?? process.cwd()),
    env,
    probePaths: input.probePaths ?? options.probePaths ?? splitPath(env['PATH'] ?? ''),
    dshHome,
    now: options.now ?? (() => new Date().toISOString()),
  };
}

function unavailableVerdicts(): Record<CapabilityLayer, ClientVerdict> {
  const verdicts = {} as Record<CapabilityLayer, ClientVerdict>;
  for (const layer of CORE_LAYERS) verdicts[layer] = 'unavailable';
  for (const layer of EXTENSION_LAYERS) verdicts[layer] = 'unavailable';
  return verdicts;
}

// ---------------------------------------------------------------------------
// detect
// ---------------------------------------------------------------------------

function detectWith(options: DeepSeekHarnessAdapterOptions, input: DetectInput): DetectResult {
  const ctx = resolveContext(options, {
    root: input.cwd ?? options.root,
    env: input.env,
    probePaths: input.probePaths,
  });
  const at = ctx.now();
  const sources: DetectionEvidence[] = [];
  const errors: IsolatedError[] = [];
  let executablePath: string | null = null;

  if (input.signal?.aborted === true) {
    return {
      clientId: DEEPSEEK_HARNESS_ID,
      detected: false,
      executablePath: null,
      version: null,
      sources: [],
      errors: [isolated('detected', 'E1_ABORTED', 'detection was aborted', at, `client:${DEEPSEEK_HARNESS_ID}`)],
    };
  }

  for (const identitySource of DEEPSEEK_HARNESS_IDENTITY_SOURCES) {
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
      } else if (identitySource.kind === 'env') {
        const value = ctx.env[identitySource.value];
        if (typeof value === 'string' && value.length > 0) {
          sources.push({
            source: `env:${identitySource.value}`,
            kind: 'env',
            executablePath: null,
            version: null,
            detectedAt: at,
          });
        }
      } else if (identitySource.kind === 'config-path') {
        if (identitySource.value.includes('$DSH_HOME') && ctx.dshHome === null) continue;
        const expanded = expandCandidate(identitySource.value, ctx);
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

  if (sources.length === 0) {
    errors.push(
      isolated(
        'detected',
        'E1_NO_DECLARED_SOURCE',
        'no declared DeepSeek Harness source was found; no private path was guessed',
        at,
        `client:${DEEPSEEK_HARNESS_ID}`,
      ),
    );
  }

  return {
    clientId: DEEPSEEK_HARNESS_ID,
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

function probeConfigFact(ctx: AdapterContext): ConfigFact {
  const checked: string[] = [];
  for (const candidate of DEEPSEEK_HARNESS_CONFIG_CANDIDATES) {
    if (candidate.path.includes('$DSH_HOME') && ctx.dshHome === null) continue;
    const path = expandCandidate(candidate.path, ctx);
    checked.push(path);
    if (!isFile(path)) continue;
    // YAML is never parsed here: the patch schema is 待核实 and guessing it is
    // forbidden. File presence is the only reported configuration fact.
    return {
      configPath: path,
      scope: candidate.scope,
      format: 'yaml',
      key: null,
      exists: true,
      checked,
      errors: [],
    };
  }
  return { configPath: null, scope: null, format: null, key: null, exists: false, checked, errors: [] };
}

// ---------------------------------------------------------------------------
// Layer builders
// ---------------------------------------------------------------------------

function buildDetectedLayer(detect: DetectResult, at: string): DetectedLayerReport {
  const source = detect.sources.length > 0 ? detect.sources.map((entry) => entry.source).join(', ') : `client:${DEEPSEEK_HARNESS_ID}`;
  const limitations: string[] = [];
  let verdict: ClientVerdict;
  if (!detect.detected) {
    verdict = 'unavailable';
    limitations.push(`${DSH_MEASURED_FACT_PREFIX} 本机未发现 dsh 可执行与 $DSH_HOME（只读存在性核对，未猜测私有路径）`);
  } else if (detect.executablePath !== null && detect.version !== null) {
    verdict = 'validated';
  } else {
    verdict = 'degraded';
    limitations.push(`${DSH_MEASURED_FACT_PREFIX} detection probed declared public sources only; version left null (no version probe was run)`);
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

function buildConfiguredLayer(detect: DetectResult, fact: ConfigFact, at: string): ConfiguredLayerReport {
  const source = fact.configPath ?? `client:${DEEPSEEK_HARNESS_ID}`;
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
        'installed but no declared Cordis config file was found',
        ...fact.checked.map((path) => `${DSH_MEASURED_FACT_PREFIX} checked ${path}`),
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
    version: 'config-format:yaml',
    source,
    limitations: [
      'Cordis YAML 配置载体存在；具体 patch schema 待核实，未解析、未回显内容',
      'configured but not measured; unverified',
    ],
    errors: fact.errors,
    details: {
      configPath: fact.configPath,
      scope: fact.scope,
      key: fact.key,
      resolvedEntry: null,
      exists: true,
    },
  };
}

function buildMcpLayer(detect: DetectResult, at: string): MutableLayerReports['mcp'] {
  if (!detect.detected) {
    return {
      layer: 'mcp',
      code: 'E3',
      verdict: 'unavailable',
      evidence: 'absent',
      at,
      version: null,
      source: `client:${DEEPSEEK_HARNESS_ID}`,
      limitations: ['detected prerequisite is unavailable'],
      errors: [],
      details: { transport: 'stdio', protocolVersion: null, serverInfo: null, latencyMs: null, startedAt: null },
    };
  }
  return {
    layer: 'mcp',
    code: 'E3',
    verdict: 'degraded',
    evidence: 'assumed',
    at,
    version: null,
    source: 'adr-008:dsch-mcp-client',
    limitations: [
      `${DSH_PUBLIC_ASSUMPTION_PREFIX} ANO 作为 MCP server 由 ${DEEPSEEK_HARNESS_MCP_CLIENT_PACKAGE} 加载（E1）；本机未实测 stdio 握手`,
      'ACP/SDK 握手不得当作 ANO MCP 七工具验证',
    ],
    errors: [],
    details: { transport: 'stdio', protocolVersion: null, serverInfo: null, latencyMs: null, startedAt: null },
  };
}

function buildToolsLayer(detect: DetectResult, at: string): MutableLayerReports['tools'] {
  if (!detect.detected) {
    return {
      layer: 'tools',
      code: 'E4',
      verdict: 'unavailable',
      evidence: 'absent',
      at,
      version: null,
      source: `client:${DEEPSEEK_HARNESS_ID}`,
      limitations: ['detected prerequisite is unavailable'],
      errors: [],
      details: { count: 0, names: [], missing: [...MCP_TOOL_NAMES], extra: [] },
    };
  }
  return {
    layer: 'tools',
    code: 'E4',
    verdict: 'degraded',
    evidence: 'assumed',
    at,
    version: null,
    source: 'adr-008:dsch-mcp-client',
    limitations: [
      `${DSH_PUBLIC_ASSUMPTION_PREFIX} ANO MCP 七工具（${MCP_TOOL_NAMES.join('/')}）未实测；公开接口存在不等于本机可用`,
    ],
    errors: [],
    details: { count: 0, names: [], missing: [...MCP_TOOL_NAMES], extra: [] },
  };
}

function buildBriefLayer(detect: DetectResult, at: string): MutableLayerReports['brief'] {
  if (!detect.detected) {
    return {
      layer: 'brief',
      code: 'E5',
      verdict: 'unavailable',
      evidence: 'absent',
      at,
      version: null,
      source: `client:${DEEPSEEK_HARNESS_ID}`,
      limitations: ['detected prerequisite is unavailable'],
      errors: [],
      details: { schema: null, hasProjectContext: false, takeoverProjection: false, hostCapability: null },
    };
  }
  return {
    layer: 'brief',
    code: 'E5',
    verdict: 'degraded',
    evidence: 'assumed',
    at,
    version: null,
    source: 'adr-008:dsch-mcp-client',
    limitations: [`${DSH_PUBLIC_ASSUMPTION_PREFIX} brief 未实测；不得判 validated`],
    errors: [],
    details: { schema: null, hasProjectContext: false, takeoverProjection: false, hostCapability: null },
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
      source: `client:${DEEPSEEK_HARNESS_ID}`,
      limitations: ['detected prerequisite is unavailable'],
      errors: [],
      details: { rulePaths: [], formatVersion: null, hasManagedSection: false, readOnly: true },
    };
  }
  const details: InstructionsDetails = {
    rulePaths: [],
    formatVersion: null,
    hasManagedSection: false,
    readOnly: true,
  };
  return {
    layer: 'instructions',
    code: 'E6',
    verdict: 'degraded',
    evidence: 'assumed',
    at,
    version: null,
    source: 'adr-008:cordis-plugin-architecture',
    limitations: [
      `${DSH_PUBLIC_ASSUMPTION_PREFIX} 无公开规则/指令文件接口；Cordis 插件架构不投影为项目规则接管（待核实）`,
      'file presence does not prove the client read or applied the rules',
    ],
    errors: [],
    details,
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
      source: `client:${DEEPSEEK_HARNESS_ID}`,
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
      'no public dispatch interface enumerated; explicit workflow fallback',
      'ACP/SDK 握手不得当作 ANO MCP 七工具验证',
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
  const status: ClientStatus = !detect.detected
    ? 'unavailable'
    : coreVerdict === 'validated' && errors.length === 0
      ? 'ready'
      : 'degraded';
  return {
    schema: CLIENT_REPORT_SCHEMA,
    clientId: DEEPSEEK_HARNESS_ID,
    alias: DEEPSEEK_HARNESS_ALIAS,
    status,
    coreVerdict,
    layers,
    generatedAt: at,
    limitations: dedupe([...extraLimitations, ...extensionLimitations, ...errors.map((error) => `${error.code}: ${error.message}`)]),
    errors,
  };
}

function inspectWith(options: DeepSeekHarnessAdapterOptions, input: InspectInput): ClientReport {
  const ctx = resolveContext(options, { root: input.root, env: input.env });
  const at = ctx.now();
  const detect = detectWith(options, {
    ...(input.env !== undefined ? { env: input.env } : {}),
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });
  const fact = probeConfigFact(ctx);
  const layers: MutableLayerReports = unavailableLayerReports(at, `client:${DEEPSEEK_HARNESS_ID}`);
  layers.detected = buildDetectedLayer(detect, at);
  layers.configured = buildConfiguredLayer(detect, fact, at);
  layers.mcp = buildMcpLayer(detect, at);
  layers.tools = buildToolsLayer(detect, at);
  layers.brief = buildBriefLayer(detect, at);
  layers.instructions = buildInstructionsLayer(detect, at);
  layers.orchestration = buildOrchestrationLayer(detect, at);
  layers.history = buildHistoryLayer(at);
  layers['output-interception'] = buildOutputInterceptionLayer(at);

  const errors = [...detect.errors, ...fact.errors];
  const extra: string[] = [
    `${DSH_MEASURED_FACT_PREFIX} 身份与公开接口已核实（E1）：${DEEPSEEK_HARNESS_OFFICIAL_SOURCES.join('、')}`,
    `${DSH_PUBLIC_ASSUMPTION_PREFIX} 能力层未实测，绝不判 validated`,
    `${DSH_PUBLIC_ASSUMPTION_PREFIX} dsh 是 deepseek-harness 的别名（registry 解析），不是独立 unknown 身份`,
    `ANO 作为 MCP server 由 ${DEEPSEEK_HARNESS_MCP_CLIENT_PACKAGE} 加载；ACP/SDK 握手不得当作 ANO MCP 七工具验证`,
    'Cordis YAML 配置载体（cordis.yml / $DSH_HOME/cordis.patch.yml）；T-081 v1 仅支持 json|toml',
    'mcp/tools/brief not measured by inspect; unverified',
    'synthetic or injected stdio servers prove mechanism only, not real client compatibility',
  ];
  if (!detect.detected) {
    extra.push(`${DSH_MEASURED_FACT_PREFIX} 本机未发现 dsh 可执行与 $DSH_HOME（只读存在性核对，未猜测私有路径）`);
  }
  return assembleReport(detect, layers, at, errors, extra);
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

/**
 * DeepSeek Harness writes nothing. The declared carrier is Cordis YAML, which
 * the T-081 config service cannot write in v1 (json|toml only), so every request
 * degrades to a zero-write dry-run report. No writable target is fabricated and
 * no patch schema is guessed.
 */
function configWith(_options: DeepSeekHarnessAdapterOptions, input: ConfigInput): ConfigResult {
  const warnings = [
    'DeepSeek Harness 配置载体为 Cordis YAML（cordis.yml / $DSH_HOME/cordis.patch.yml）',
    'T-081 配置服务 v1 仅支持 json|toml；YAML 写入不支持，apply 拒绝，零写',
    `${DSH_CONFIG_REFUSED_PREFIX} cordis.patch.yml 的具体 patch schema 待核实（E1 仅确认载体与 mcp__<server>__<tool> 命名）；不伪造可写配置`,
  ];
  if (input.mode === 'apply') {
    warnings.push(`${DSH_CONFIG_REFUSED_PREFIX} apply refused: YAML 配置载体不受 T-081 支持；zero write`);
    if (input.authorization === undefined) {
      warnings.push(`${DSH_CONFIG_REFUSED_PREFIX} apply refused: 缺显式授权；zero write`);
    }
  }
  return { mode: 'dry-run', changes: [], backupPlan: null, warnings };
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

/**
 * Returns the DSH profile when the command is a `dsh --profile <name>`
 * invocation. Those profiles (ACP/SDK/...) are DSH's own interfaces and must
 * never be reported as ANO MCP verification.
 */
function dshNonMcpProfile(command: string, args: readonly string[]): string | null {
  const base = basename(command).toLowerCase();
  if (base !== 'dsh' && base !== 'dsh.exe' && base !== 'dsh.cmd') return null;
  let profile: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === '--profile' && index + 1 < args.length) {
      profile = args[index + 1] ?? null;
    } else if (arg.startsWith('--profile=')) {
      profile = arg.slice('--profile='.length);
    }
  }
  if (profile === null) return null;
  return (DEEPSEEK_HARNESS_CLI_PROFILES as readonly string[]).includes(profile) ? profile : null;
}

async function verifyWith(input: VerifyInput): Promise<VerifyResult> {
  if (input.command !== undefined && input.command.length > 0) {
    const profile = dshNonMcpProfile(input.command, input.args ?? []);
    if (profile !== null) {
      return {
        handshake: null,
        tools: null,
        brief: null,
        verdicts: unavailableVerdicts(),
        errors: [
          isolated(
            'mcp',
            'E3_DSH_PROFILE_NOT_MCP',
            `dsh --profile ${profile} 是 DSH 自身接口（ACP/SDK 等），不得当作 ANO MCP 七工具验证`,
            new Date().toISOString(),
            input.command,
          ),
        ],
      };
    }
  }
  // Real stdio handshake (injectable in tests). The handshake always speaks MCP
  // initialize/tools/list/brief, so an ACP/SDK profile cannot be smuggled in.
  return verifyStdioMcp(input);
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export function createDeepSeekHarnessAdapter(options: DeepSeekHarnessAdapterOptions = {}): ClientAdapter {
  return {
    id: DEEPSEEK_HARNESS_ID as ClientId,
    identitySources: DEEPSEEK_HARNESS_IDENTITY_SOURCES,
    detect: (input: DetectInput) => Promise.resolve(detectWith(options, input)),
    inspect: (input: InspectInput) => Promise.resolve(inspectWith(options, input)),
    config: (input: ConfigInput) => Promise.resolve(configWith(options, input)),
    verify: (input: VerifyInput): Promise<VerifyResult> => verifyWith(input),
  };
}

/** Production instance; tests must construct their own with injected paths. */
export const deepSeekHarnessAdapter: ClientAdapter = createDeepSeekHarnessAdapter();

/** Exported for CLI orchestration (T-085) and tests; YAML is not T-081-writable. */
export const DEEPSEEK_HARNESS_CONFIG_TARGET: ConfigResult = Object.freeze({
  mode: 'dry-run',
  changes: [],
  backupPlan: null,
  warnings: [
    'DeepSeek Harness 配置载体为 Cordis YAML；T-081 v1 仅支持 json|toml，apply 拒绝，零写',
  ],
});

/** Read-only view of the declared Cordis YAML carrier; never parsed or written. */
export function readDeclaredCordisCarrier(path: string): { exists: boolean; bytes: number } {
  if (!isFile(path)) return { exists: false, bytes: 0 };
  try {
    return { exists: true, bytes: readFileSync(path).length };
  } catch (error) {
    throw new Error(`failed to read declared Cordis carrier ${path}: ${errorMessage(error)}`);
  }
}

/** Type guard used by tests/docs to assert the declared carrier format. */
export function isCordisYamlCandidate(value: unknown): value is DeepSeekHarnessConfigCandidateDeclaration {
  return isRecord(value) && value['format'] === 'yaml';
}
