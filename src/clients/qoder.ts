/**
 * Qoder adapter (T-084 / MC-06).
 *
 * Identity and configuration facts are taken only from public Qoder
 * documentation or from an explicit read-only probe of those declared
 * sources. No path is guessed and no configuration content is executed.
 *
 * Measured facts (detection) and configuration facts (a declared config file
 * containing an `ano` entry) are reported separately and labelled:
 *   - `measured-fact:`    a real read-only probe result
 *   - `config-fact:`      a declared configuration file fact, never measured
 *   - `public-assumption:` a public-doc claim that was not measured
 *
 * Layers without a measured basis stay `unavailable`; this adapter never
 * upgrades a layer to `validated` on its own.
 */

import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, resolve } from 'node:path';
import {
  CAPABILITY_LAYERS,
  CLIENT_REPORT_SCHEMA,
  CORE_LAYERS,
  EXTENSION_LAYERS,
  type ClientAdapter,
  type CapabilityLayer,
  type ClientId,
  type ClientReport,
  type ClientStatus,
  type ConfigFormat,
  type ConfigInput,
  type ConfigResult,
  type ConfigScope,
  type DetectInput,
  type DetectResult,
  type DetectionEvidence,
  type InspectInput,
  type IsolatedError,
  type LayerReport,
  type MutableLayerReports,
  type ProposedChange,
  type VerifyInput,
  type VerifyResult,
  weakestVerdict,
} from './types.ts';
import { unavailableLayerReports, verifyStdioMcp } from './doctor.ts';
import { redactClientConfigEntry } from './redact.ts';

export const QODER_CLIENT_ID: ClientId = 'qoder';

/** Reported limitation prefixes; tests and docs rely on these exact labels. */
export const QODER_MEASURED_FACT_PREFIX = 'measured-fact:';
export const QODER_CONFIG_FACT_PREFIX = 'config-fact:';
export const QODER_PUBLIC_ASSUMPTION_PREFIX = 'public-assumption:';
export const QODER_CONFIG_REFUSED_PREFIX = 'config-refused:';

/** Documented MCP key for Qoder (`mcpServers` + server name `ano`). */
export const QODER_MCP_KEY = 'mcpServers.ano';

/**
 * Public documented Qoder CLI executable names. `qoder` is the documented CLI
 * command; `qodercli`/`qoder.exe` are the direct launcher names documented by
 * the Qoder dispatcher. No install directory is guessed.
 */
export const QODER_EXECUTABLE_NAMES: readonly string[] = Object.freeze(['qoder', 'qodercli', 'qoder.exe']);

export interface QoderConfigCandidateDeclaration {
  readonly path: string;
  readonly scope: ConfigScope;
  readonly format: ConfigFormat;
  readonly key: string;
}

/**
 * Public documented Qoder MCP settings locations (docs.qoder.com/cli/mcp-servers
 * and /cli/mcp-reference): user `~/.qoder/settings.json`, project
 * `<project>/.qoder/settings.json`, project `<project>/.mcp.json`, and local
 * `<project>/.qoder/settings.local.json`. All are JSON with `mcpServers`.
 */
export const QODER_CONFIG_CANDIDATES: readonly QoderConfigCandidateDeclaration[] = Object.freeze([
  { path: '~/.qoder/settings.json', scope: 'user', format: 'json', key: QODER_MCP_KEY },
  { path: '<root>/.qoder/settings.json', scope: 'project', format: 'json', key: QODER_MCP_KEY },
  { path: '<root>/.mcp.json', scope: 'project', format: 'json', key: QODER_MCP_KEY },
  { path: '<root>/.qoder/settings.local.json', scope: 'workspace', format: 'json', key: QODER_MCP_KEY },
]);

/** Filesystem seam so tests never touch the real user configuration. */
export interface QoderFs {
  isFile(path: string): boolean;
  readJson(path: string): { ok: true; value: unknown } | { ok: false; error: string };
}

export interface QoderAdapterOptions {
  readonly now?: () => string;
  readonly home?: string;
  readonly root?: string;
  readonly fs?: QoderFs;
}

const defaultFs: QoderFs = {
  isFile: (path) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
  readJson: (path) => {
    try {
      return { ok: true, value: JSON.parse(readFileSync(path, 'utf8')) as unknown };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Type-safe layer replacement: avoids assigning through a union key. */
function mapLayerReports(
  layers: MutableLayerReports,
  transform: (entry: LayerReport, layer: CapabilityLayer) => LayerReport,
): MutableLayerReports {
  const next: Record<string, LayerReport> = { ...layers };
  for (const layer of CAPABILITY_LAYERS) {
    next[layer] = transform(next[layer] as LayerReport, layer);
  }
  return next as MutableLayerReports;
}

function dedupe(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function collectEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function splitPath(value: string): readonly string[] {
  return value.split(delimiter).filter((part) => part.length > 0);
}

function expandPath(path: string, home: string, root: string): string {
  let value = path;
  if (value === '~') value = home;
  else if (value.startsWith('~/')) value = `${home}/${value.slice(2)}`;
  else if (value.startsWith('~\\')) value = `${home}\\${value.slice(2)}`;
  value = value.split('<root>').join(root);
  return resolve(value);
}

function findExecutable(name: string, directories: readonly string[], fs: QoderFs): string | null {
  for (const directory of directories) {
    for (const suffix of ['', '.exe', '.cmd']) {
      const candidate = resolve(directory, `${name}${suffix}`);
      if (fs.isFile(candidate)) return candidate;
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

interface QoderConfigFact {
  readonly configPath: string | null;
  readonly scope: ConfigScope | null;
  readonly format: ConfigFormat | null;
  readonly key: string | null;
  readonly resolvedEntry: unknown;
  readonly exists: boolean;
  readonly checked: readonly string[];
  readonly errors: readonly IsolatedError[];
}

function probeConfigFact(fs: QoderFs, home: string, root: string, now: () => string): QoderConfigFact {
  const checked: string[] = [];
  const errors: IsolatedError[] = [];
  for (const candidate of QODER_CONFIG_CANDIDATES) {
    const path = expandPath(candidate.path, home, root);
    checked.push(path);
    if (!fs.isFile(path)) continue;
    const parsed = fs.readJson(path);
    if (!parsed.ok) {
      errors.push({
        layer: 'configured',
        code: 'E2_CONFIG_UNREADABLE',
        message: `declared candidate is not readable JSON: ${parsed.error}`,
        at: now(),
        source: path,
      });
      continue;
    }
    const walked = walkKey(parsed.value, candidate.key);
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

const EXTENSION_NOT_MEASURED: Readonly<Record<string, string>> = Object.freeze({
  instructions: `${QODER_PUBLIC_ASSUMPTION_PREFIX} Qoder public docs mention .qoder/rules project rules; this adapter did not measure them`,
  orchestration: `${QODER_PUBLIC_ASSUMPTION_PREFIX} Qoder public docs describe CLI scheduled tasks/loop/agent teams; no public MCP dispatch interface was measured`,
  history: 'no authorized sample and no measured public history format; never read',
  'output-interception': 'no public output-interception interface measured; tool-level hooks are not output interception',
});

function proposedEntry(root: string): Record<string, unknown> {
  return { type: 'stdio', command: process.execPath, args: [resolve(root, 'dist/surface/mcp.js')] };
}

function selectCandidate(
  target: ConfigInput['target'],
  home: string,
  root: string,
): QoderConfigCandidateDeclaration | null {
  if (target.path !== undefined) {
    const requested = expandPath(target.path, home, root);
    return QODER_CONFIG_CANDIDATES.find((candidate) => expandPath(candidate.path, home, root) === requested) ?? null;
  }
  if (target.scope !== undefined) {
    return QODER_CONFIG_CANDIDATES.find((candidate) => candidate.scope === target.scope) ?? null;
  }
  return QODER_CONFIG_CANDIDATES[0] ?? null;
}

/**
 * Qoder adapter. `detect` probes declared sources only; `inspect` keeps
 * measured and configuration facts separate; `config` only proposes (never
 * applies); `verify` refuses to fabricate a handshake without a real or
 * injected stdio command.
 */
export function createQoderAdapter(options: QoderAdapterOptions = {}): ClientAdapter {
  const now = options.now ?? (() => new Date().toISOString());
  const home = options.home ?? homedir();
  const root = options.root ?? process.cwd();
  const fs = options.fs ?? defaultFs;

  const adapter: ClientAdapter = {
    id: QODER_CLIENT_ID,
    identitySources: [
      { kind: 'executable', value: 'qoder', detail: 'documented Qoder CLI command' },
      { kind: 'executable', value: 'qodercli', detail: 'documented direct Qoder CLI launcher name' },
      { kind: 'executable', value: 'qoder.exe', detail: 'documented direct Qoder CLI launcher name' },
      { kind: 'config-path', value: '~/.qoder/settings.json', detail: 'public documented user MCP settings' },
      { kind: 'config-path', value: '<root>/.qoder/settings.json', detail: 'public documented project MCP settings' },
      { kind: 'config-path', value: '<root>/.mcp.json', detail: 'public documented project MCP settings' },
      { kind: 'config-path', value: '<root>/.qoder/settings.local.json', detail: 'public documented local MCP settings' },
    ],

    async detect(input: DetectInput): Promise<DetectResult> {
      const at = now();
      const env = input.env ?? collectEnv();
      const probePaths = dedupe([...(input.probePaths ?? []), ...splitPath(env['PATH'] ?? '')]);
      const sources: DetectionEvidence[] = [];
      const errors: IsolatedError[] = [];

      let executablePath: string | null = null;
      for (const name of QODER_EXECUTABLE_NAMES) {
        const found = findExecutable(name, probePaths, fs);
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

      for (const candidate of QODER_CONFIG_CANDIDATES) {
        const path = expandPath(candidate.path, home, root);
        if (fs.isFile(path)) {
          sources.push({
            source: `config-path:${candidate.path}`,
            kind: 'config-path',
            executablePath: null,
            version: null,
            detectedAt: at,
          });
        }
      }

      if (sources.length === 0) {
        errors.push({
          layer: 'detected',
          code: 'E1_NO_DECLARED_SOURCE',
          message: 'no declared Qoder source was found; paths were not guessed',
          at,
          source: null,
        });
      }

      return { clientId: QODER_CLIENT_ID, detected: sources.length > 0, executablePath, version: null, sources, errors };
    },

    async inspect(input: InspectInput): Promise<ClientReport> {
      const at = now();
      const detection = await adapter.detect({
        ...(input.env !== undefined ? { env: input.env } : {}),
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      });

      let layers: MutableLayerReports = unavailableLayerReports(at, `client:${QODER_CLIENT_ID}`);
      const fact = probeConfigFact(fs, home, root, now);
      const errors: IsolatedError[] = [...detection.errors, ...fact.errors];

      if (detection.detected) {
        layers.detected = {
          ...layers.detected,
          verdict: 'degraded',
          evidence: 'measured',
          version: null,
          source: detection.sources.map((entry) => entry.source).join(', '),
          limitations: [
            `${QODER_MEASURED_FACT_PREFIX} detection probed declared public sources only`,
            `${QODER_MEASURED_FACT_PREFIX} version left null: no public version probe was run`,
            ...detection.errors.map((error) => `${error.code}: ${error.message}`),
          ],
          details: {
            detected: true,
            executablePath: detection.executablePath,
            version: null,
            sources: detection.sources,
          },
        };
      } else {
        layers.detected = {
          ...layers.detected,
          limitations: [
            `${QODER_MEASURED_FACT_PREFIX} no declared source was found; no path was guessed`,
            ...detection.errors.map((error) => `${error.code}: ${error.message}`),
          ],
        };
      }

      if (!detection.detected) {
        layers.configured = {
          ...layers.configured,
          limitations: [
            `${QODER_CONFIG_FACT_PREFIX} detected prerequisite unavailable; configuration is not guessed`,
          ],
        };
      } else if (fact.exists && fact.configPath !== null) {
        layers.configured = {
          ...layers.configured,
          verdict: 'degraded',
          evidence: 'configured',
          version: fact.format === null ? null : `config-format:${fact.format}`,
          source: fact.configPath,
          limitations: [
            `${QODER_CONFIG_FACT_PREFIX} ano entry found in a declared config candidate`,
            `${QODER_CONFIG_FACT_PREFIX} configured but not measured: no stdio handshake was run`,
            ...fact.errors.map((error) => `${error.code}: ${error.message}`),
          ],
          details: {
            configPath: fact.configPath,
            scope: fact.scope,
            key: fact.key,
            resolvedEntry: fact.resolvedEntry,
            exists: true,
          },
        };
      } else {
        layers.configured = {
          ...layers.configured,
          verdict: 'degraded',
          evidence: 'absent',
          source: `client:${QODER_CLIENT_ID}`,
          limitations: [
            `${QODER_CONFIG_FACT_PREFIX} no ano entry in declared candidates`,
            ...fact.checked.map((path) => `${QODER_CONFIG_FACT_PREFIX} checked ${path}`),
            ...fact.errors.map((error) => `${error.code}: ${error.message}`),
          ],
          details: { configPath: null, scope: null, key: null, resolvedEntry: null, exists: false },
        };
      }

      const extensionLimitations = {} as Record<CapabilityLayer, readonly string[]>;
      for (const layer of EXTENSION_LAYERS) {
        extensionLimitations[layer] = [EXTENSION_NOT_MEASURED[layer] ?? 'not measured'];
      }
      const withExtensionLimits = mapLayerReports(layers, (entry, layer) => ({
        ...entry,
        limitations: extensionLimitations[layer] ?? entry.limitations,
      }));
      layers = withExtensionLimits;

      const coreVerdict = weakestVerdict(CORE_LAYERS.map((layer) => layers[layer].verdict));
      let status: ClientStatus;
      if (!detection.detected) status = 'unavailable';
      else if (coreVerdict === 'validated' && errors.length === 0) status = 'ready';
      else status = 'degraded';

      const limitations = dedupe([
        detection.detected
          ? `${QODER_MEASURED_FACT_PREFIX} detected facts come from a read-only probe of declared public sources`
          : `${QODER_MEASURED_FACT_PREFIX} detection found no declared public source`,
        `${QODER_CONFIG_FACT_PREFIX} configuration facts are read-only and kept separate from measured detection`,
        `${QODER_PUBLIC_ASSUMPTION_PREFIX} layers without a measured basis stay unavailable`,
        'mcp/tools/brief were not measured; call verify() with a real or injected stdio command',
        ...EXTENSION_LAYERS.map((layer) => EXTENSION_NOT_MEASURED[layer] ?? 'not measured'),
        ...errors.map((error) => `${error.code}: ${error.message}`),
      ]);

      return {
        schema: CLIENT_REPORT_SCHEMA,
        clientId: QODER_CLIENT_ID,
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
      if (input.mode === 'apply') {
        return {
          mode: 'dry-run',
          changes: [],
          backupPlan: null,
          warnings: [
            ...warnings,
            `${QODER_CONFIG_REFUSED_PREFIX} apply refused: Qoder adapter never writes configuration; use the ANO config service`,
          ],
        };
      }
      const candidate = selectCandidate(input.target, home, root);
      if (candidate === null) {
        return {
          mode: 'dry-run',
          changes: [],
          backupPlan: null,
          warnings: [
            ...warnings,
            `${QODER_CONFIG_REFUSED_PREFIX} requested target is not a declared Qoder config candidate; refusing to guess a path or format`,
          ],
        };
      }
      const fact = probeConfigFact(fs, home, root, now);
      const path = expandPath(candidate.path, home, root);
      const change: ProposedChange = {
        path,
        scope: candidate.scope,
        key: candidate.key,
        operation: fact.exists && fact.configPath === path ? 'update' : 'add',
        before: fact.exists && fact.configPath === path ? fact.resolvedEntry : null,
        after: proposedEntry(root),
      };
      return { mode: 'dry-run', changes: [change], backupPlan: null, warnings };
    },

    async verify(input: VerifyInput): Promise<VerifyResult> {
      // No command and no injected client: verifyStdioMcp refuses to fabricate
      // a handshake and reports `mcp=unavailable` (E3_NO_COMMAND).
      return verifyStdioMcp(input);
    },
  };
  return adapter;
}

export const qoderAdapter: ClientAdapter = createQoderAdapter();
