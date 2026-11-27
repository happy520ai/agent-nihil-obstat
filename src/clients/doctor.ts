/**
 * Client doctor (T-080).
 *
 * Orchestrates read-only client detection, configuration discovery, real MCP
 * verification and the unified nine-layer JSON report. Every per-client phase
 * is isolated: one failure degrades that client's report and never aborts the
 * run. Nothing in this module writes client configuration.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import {
  CLIENT_REPORT_SCHEMA,
  CORE_LAYERS,
  DOCTOR_REPORT_SCHEMA,
  EXTENSION_LAYERS,
  MCP_PROTOCOL_VERSION,
  MCP_TOOL_COUNT,
  MCP_TOOL_NAMES,
  type BriefDetails,
  type BriefLayerReport,
  type ClientAdapter,
  type ClientDescriptor,
  type ClientEvidence,
  type ClientId,
  type ClientReport,
  type ClientVerdict,
  type ConfigFormat,
  type ConfigScope,
  type ConfiguredLayerReport,
  type DetectInput,
  type DetectResult,
  type DetectionEvidence,
  type DetectedLayerReport,
  type HistoryLayerReport,
  type InspectInput,
  type InstructionsLayerReport,
  type IsolatedError,
  type LayerReport,
  type McpClientLike,
  type McpHandshakeEvidence,
  type McpInitializeResult,
  type McpLayerReport,
  type MutableLayerReports,
  type OrchestrationLayerReport,
  type OutputInterceptionLayerReport,
  type ToolsDetails,
  type ToolsLayerReport,
  type VerifyInput,
  type VerifyResult,
  weakestVerdict,
} from './types.ts';
import { defaultRegistry, type ClientRegistry } from './registry.ts';
import { redactClientConfigEntry } from './redact.ts';
import { createAmazonQAdapter } from './amazon-q.ts';
import { antigravityAdapter } from './antigravity.ts';
import { createClaudeCodeAdapter } from './claude-code.ts';
import { createClineAdapter } from './cline.ts';
import { codebuddyAdapter } from './codebuddy.ts';
import { createCodegeexAdapter } from './codegeex.ts';
import { createCodexAdapter } from './codex.ts';
import { createComateAdapter } from './comate.ts';
import { cursorAdapter } from './cursor.ts';
import { createDeepSeekHarnessAdapter } from './deepseek-harness.ts';
import { githubCopilotAdapter } from './github-copilot.ts';
import { createHermesAgentAdapter } from './hermes-agent.ts';
import { jetbrainsAiAdapter } from './jetbrains-ai.ts';
import { createKiloCodeAdapter } from './kilo-code.ts';
import { createOpenClawAdapter } from './openclaw.ts';
import { opencodeAdapter } from './opencode.ts';
import { createQoderAdapter } from './qoder.ts';
import { replitAgentAdapter } from './replit-agent.ts';
import { tabnineAdapter } from './tabnine.ts';
import { createTongyiLingmaAdapter } from './tongyi-lingma.ts';
import { traeAdapter } from './trae.ts';
import { zedAdapter } from './zed.ts';
import { piAdapter } from './unknown.ts';

// ---------------------------------------------------------------------------
// Public option/report types
// ---------------------------------------------------------------------------

export interface DoctorRunOptions {
  readonly registry?: ClientRegistry;
  readonly root?: string;
  readonly home?: string;
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly probePaths?: readonly string[];
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Clock injection for deterministic reports. */
  readonly now?: () => string;
  /** Adapter overrides; absent clients fall back to generic probing. */
  readonly adapters?: Readonly<Partial<Record<ClientId, ClientAdapter>>>;
  /** Verification template applied to every client. */
  readonly verify?: VerifyInput;
  /** Per-client verification inputs (wins over `verify`). */
  readonly verifyInputs?: Readonly<Partial<Record<ClientId, VerifyInput>>>;
  /** Testing seam replacing the stdio spawn implementation. */
  readonly verifier?: (input: VerifyInput) => Promise<VerifyResult>;
  /** Read-only configuration discovery; defaults to true. Never writes. */
  readonly discoverConfig?: boolean;
  /** Restrict the run to a subset of registered ids. */
  readonly clientIds?: readonly string[];
}

export interface DoctorReport {
  readonly schema: typeof DOCTOR_REPORT_SCHEMA;
  readonly generatedAt: string;
  readonly clients: readonly ClientReport[];
  readonly limitations: readonly string[];
}

export interface ConfigDiscovery {
  readonly configPath: string | null;
  readonly scope: ConfigScope | null;
  readonly format: ConfigFormat | null;
  readonly key: string | null;
  readonly resolvedEntry: unknown;
  readonly exists: boolean;
  readonly reachable: boolean;
  readonly command: string | null;
  readonly limitations: readonly string[];
  readonly errors: readonly IsolatedError[];
}

// ---------------------------------------------------------------------------
// Unified adapter assembly (T-098 / CX-08)
// ---------------------------------------------------------------------------

/**
 * Injection seam for the unified assembly. `home`/`root`/`env`/`probePaths`
 * keep tests off the real user configuration; `now` keeps reports deterministic.
 */
export interface ClientAdapterAssemblyOptions {
  readonly home?: string;
  readonly root?: string;
  readonly env?: Record<string, string>;
  readonly probePaths?: readonly string[];
  readonly now?: () => string;
}

interface MutableAssemblyContext {
  home?: string;
  root?: string;
  env?: Record<string, string>;
  probePaths?: readonly string[];
  now?: () => string;
}

function assemblyContext(options: ClientAdapterAssemblyOptions): MutableAssemblyContext {
  const context: MutableAssemblyContext = {};
  if (options.home !== undefined) context.home = options.home;
  if (options.root !== undefined) context.root = options.root;
  if (options.env !== undefined) context.env = options.env;
  if (options.probePaths !== undefined) context.probePaths = options.probePaths;
  if (options.now !== undefined) context.now = options.now;
  return context;
}

/**
 * Assemble every available client adapter (the 21 ADR-008 tools plus the M11
 * legacy `opencode`/`pi`; `zcode` has no adapter and stays on generic probing).
 *
 * Keys are canonical ids only: `dsh` resolves to `deepseek-harness` through
 * `resolveClientId`/the registry, so the assembly never registers a `dsh` key.
 * The returned map is consumed by `doctorClients`/`doctorClient` (T-099 wires
 * `src/surface/service.ts` to this function) and by the capability plan.
 *
 * The assembly is read-only: it constructs adapters, it does not probe.
 */
export function registerAllClientAdapters(
  options: ClientAdapterAssemblyOptions = {},
): Partial<Record<ClientId, ClientAdapter>> {
  const context = assemblyContext(options);
  const now = options.now;
  const nowOptions = now === undefined ? {} : { now };
  return {
    'amazon-q': createAmazonQAdapter(nowOptions),
    antigravity: antigravityAdapter,
    'claude-code': createClaudeCodeAdapter(context),
    cline: createClineAdapter(context),
    codebuddy: codebuddyAdapter,
    codegeex: createCodegeexAdapter(nowOptions),
    codex: createCodexAdapter(context),
    comate: createComateAdapter(nowOptions),
    cursor: cursorAdapter,
    'deepseek-harness': createDeepSeekHarnessAdapter(context),
    'github-copilot': githubCopilotAdapter,
    'hermes-agent': createHermesAgentAdapter(context),
    'jetbrains-ai': jetbrainsAiAdapter,
    'kilo-code': createKiloCodeAdapter(context),
    openclaw: createOpenClawAdapter(context),
    opencode: opencodeAdapter,
    pi: piAdapter,
    qoder: createQoderAdapter(context),
    'replit-agent': replitAgentAdapter,
    tabnine: tabnineAdapter,
    'tongyi-lingma': createTongyiLingmaAdapter(nowOptions),
    trae: traeAdapter,
    zed: zedAdapter,
  };
}

interface ResolvedOptions {
  readonly registry: ClientRegistry;
  readonly root: string;
  readonly home: string;
  readonly cwd: string | null;
  readonly env: Record<string, string>;
  readonly probePaths: readonly string[];
  readonly timeoutMs: number;
  readonly signal: AbortSignal | null;
  readonly now: () => string;
  readonly adapters: Readonly<Partial<Record<ClientId, ClientAdapter>>>;
  readonly verify: VerifyInput | null;
  readonly verifyInputs: Readonly<Partial<Record<ClientId, VerifyInput>>>;
  readonly verifier: ((input: VerifyInput) => Promise<VerifyResult>) | null;
  readonly discoverConfig: boolean;
}

const DEFAULT_TIMEOUT_MS = 15_000;

const GLOBAL_LIMITATIONS: readonly string[] = [
  'read-only probe: no client configuration was written',
  'synthetic or injected stdio servers prove mechanism only, not real client compatibility',
  'a successful MCP handshake does not imply configuration is active or takeover is complete',
];

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

function addError(errors: IsolatedError[], error: IsolatedError | null | undefined): void {
  if (!error) return;
  if (errors.some((existing) => existing.code === error.code && existing.message === error.message)) return;
  errors.push(error);
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

function resolveOptions(options: DoctorRunOptions): ResolvedOptions {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, options.env ?? {});
  // An explicit probe-path list is authoritative, including the empty list:
  // hermetic callers must not fall back to the host PATH. Only callers that
  // do not supply probePaths inherit PATH from the (possibly injected) env.
  const probePaths = options.probePaths !== undefined
    ? dedupe(options.probePaths)
    : dedupe(splitPath(env['PATH'] ?? ''));
  return {
    registry: options.registry ?? defaultRegistry,
    root: options.root ?? process.cwd(),
    home: options.home ?? homedir(),
    cwd: options.cwd ?? null,
    env,
    probePaths,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    signal: options.signal ?? null,
    now: options.now ?? (() => new Date().toISOString()),
    adapters: options.adapters ?? {},
    verify: options.verify ?? null,
    verifyInputs: options.verifyInputs ?? {},
    verifier: options.verifier ?? null,
    discoverConfig: options.discoverConfig ?? true,
  };
}

function expandPath(path: string, options: ResolvedOptions): string {
  let value = path;
  if (value === '~') value = options.home;
  else if (value.startsWith('~/')) value = `${options.home}/${value.slice(2)}`;
  else if (value.startsWith('~\\')) value = `${options.home}\\${value.slice(2)}`;
  value = value.split('<root>').join(options.root);
  return resolve(value);
}

function detectInput(options: ResolvedOptions): DetectInput {
  return {
    env: options.env,
    ...(options.cwd !== null ? { cwd: options.cwd } : {}),
    probePaths: options.probePaths,
    timeoutMs: options.timeoutMs,
    ...(options.signal !== null ? { signal: options.signal } : {}),
  };
}

function inspectInput(options: ResolvedOptions): InspectInput {
  return {
    root: options.root,
    env: options.env,
    ...(options.cwd !== null ? { cwd: options.cwd } : {}),
    timeoutMs: options.timeoutMs,
    ...(options.signal !== null ? { signal: options.signal } : {}),
  };
}

function unavailableVerdicts(): Record<
  'detected' | 'configured' | 'mcp' | 'tools' | 'brief' | 'instructions' | 'orchestration' | 'history' | 'output-interception',
  ClientVerdict
> {
  return {
    detected: 'unavailable',
    configured: 'unavailable',
    mcp: 'unavailable',
    tools: 'unavailable',
    brief: 'unavailable',
    instructions: 'unavailable',
    orchestration: 'unavailable',
    history: 'unavailable',
    'output-interception': 'unavailable',
  };
}

// ---------------------------------------------------------------------------
// Default layer reports
// ---------------------------------------------------------------------------

/** All-nine-layer skeleton with explicit null/unknown fields. */
export function unavailableLayerReports(at: string, source: string): MutableLayerReports {
  return {
    detected: {
      layer: 'detected',
      code: 'E1',
      verdict: 'unavailable',
      evidence: 'absent',
      at,
      version: null,
      source,
      limitations: [],
      errors: [],
      details: { detected: false, executablePath: null, version: null, sources: [] },
    },
    configured: {
      layer: 'configured',
      code: 'E2',
      verdict: 'unavailable',
      evidence: 'absent',
      at,
      version: null,
      source,
      limitations: [],
      errors: [],
      details: { configPath: null, scope: null, key: null, resolvedEntry: null, exists: false },
    },
    mcp: {
      layer: 'mcp',
      code: 'E3',
      verdict: 'unavailable',
      evidence: 'absent',
      at,
      version: null,
      source,
      limitations: [],
      errors: [],
      details: { transport: 'stdio', protocolVersion: null, serverInfo: null, latencyMs: null, startedAt: null },
    },
    tools: {
      layer: 'tools',
      code: 'E4',
      verdict: 'unavailable',
      evidence: 'absent',
      at,
      version: null,
      source,
      limitations: [],
      errors: [],
      details: { count: 0, names: [], missing: [], extra: [] },
    },
    brief: {
      layer: 'brief',
      code: 'E5',
      verdict: 'unavailable',
      evidence: 'absent',
      at,
      version: null,
      source,
      limitations: [],
      errors: [],
      details: { schema: null, hasProjectContext: false, takeoverProjection: false, hostCapability: null },
    },
    instructions: {
      layer: 'instructions',
      code: 'E6',
      verdict: 'unavailable',
      evidence: 'absent',
      at,
      version: null,
      source,
      limitations: [],
      errors: [],
      details: { rulePaths: [], formatVersion: null, hasManagedSection: false, readOnly: true },
    },
    orchestration: {
      layer: 'orchestration',
      code: 'E7',
      verdict: 'unavailable',
      evidence: 'absent',
      at,
      version: null,
      source,
      limitations: [],
      errors: [],
      details: { publicApi: null, documented: false, mode: 'none', measured: false },
    },
    history: {
      layer: 'history',
      code: 'E8',
      verdict: 'unavailable',
      evidence: 'absent',
      at,
      version: null,
      source,
      limitations: [],
      errors: [],
      details: { source: null, formatVersion: null, sampleAuthorized: false, parsedRecords: 0, privacy: 'not-read' },
    },
    'output-interception': {
      layer: 'output-interception',
      code: 'E9',
      verdict: 'unavailable',
      evidence: 'absent',
      at,
      version: null,
      source,
      limitations: [],
      errors: [],
      details: { publicApi: null, hooksAreToolLevel: false, configured: false, measured: false },
    },
  };
}

// ---------------------------------------------------------------------------
// Generic read-only detection
// ---------------------------------------------------------------------------

function findExecutable(name: string, directories: readonly string[]): string | null {
  for (const directory of directories) {
    for (const suffix of ['', '.exe', '.cmd']) {
      const candidate = join(directory, `${name}${suffix}`);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Probes only the sources declared by the descriptor. It never guesses a
 * default path and never executes the candidate beyond metadata checks.
 */
export function genericDetect(descriptor: ClientDescriptor, options: DoctorRunOptions = {}): DetectResult {
  return genericDetectResolved(descriptor, resolveOptions(options));
}

function genericDetectResolved(descriptor: ClientDescriptor, resolved: ResolvedOptions): DetectResult {
  const at = resolved.now();
  const sources: DetectionEvidence[] = [];
  let executablePath: string | null = null;

  for (const identitySource of descriptor.identitySources) {
    if (identitySource.kind === 'executable') {
      const found = findExecutable(identitySource.value, resolved.probePaths);
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
      const expanded = expandPath(identitySource.value, resolved);
      if (existsSync(expanded)) {
        sources.push({
          source: `path:${expanded}`,
          kind: 'config-path',
          executablePath: null,
          version: null,
          detectedAt: at,
        });
      }
    } else if (identitySource.kind === 'env') {
      const value = resolved.env[identitySource.value];
      if (typeof value === 'string' && value.length > 0) {
        sources.push({
          source: `env:${identitySource.value}`,
          kind: 'env',
          executablePath: null,
          version: null,
          detectedAt: at,
        });
      }
    }
  }

  return {
    clientId: descriptor.id,
    detected: sources.length > 0,
    executablePath,
    version: null,
    sources,
    errors: [],
  };
}

function detectFailure(clientId: ClientId, error: unknown, at: string): DetectResult {
  return {
    clientId,
    detected: false,
    executablePath: null,
    version: null,
    sources: [],
    errors: [isolated('detected', 'E1_DETECT_FAILED', errorMessage(error), at, `client:${clientId}`)],
  };
}

// ---------------------------------------------------------------------------
// Read-only configuration discovery
// ---------------------------------------------------------------------------

function walkJsonKey(value: unknown, key: string): { found: boolean; value: unknown } {
  let current: unknown = value;
  for (const part of key.split('.')) {
    if (current === null || typeof current !== 'object') return { found: false, value: undefined };
    const record = current as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(record, part)) return { found: false, value: undefined };
    current = record[part];
  }
  return { found: true, value: current };
}

function readJsonKey(text: string, key: string): { found: boolean; value: unknown } {
  const normalized = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return walkJsonKey(JSON.parse(normalized), key);
}

function parseTomlValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Minimal `[a.b]` table reader; enough to recover a declared MCP entry. */
function readTomlKey(text: string, key: string): { found: boolean; value: unknown } {
  const header = `[${key}]`;
  let seen = false;
  let active = false;
  const table: Record<string, unknown> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      active = line === header;
      if (active) seen = true;
      continue;
    }
    if (!active) continue;
    const equals = line.indexOf('=');
    if (equals < 0) continue;
    const name = line.slice(0, equals).trim();
    if (name.length > 0) table[name] = parseTomlValue(line.slice(equals + 1).trim());
  }
  return { found: seen && Object.keys(table).length > 0, value: table };
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

function commandReachable(command: string, options: ResolvedOptions): boolean {
  if (command.includes('/') || command.includes('\\')) {
    return isFile(command) || isFile(`${command}.exe`) || isFile(`${command}.cmd`);
  }
  for (const directory of options.probePaths) {
    for (const suffix of ['', '.exe', '.cmd']) {
      if (isFile(join(directory, `${command}${suffix}`))) return true;
    }
  }
  return false;
}

/**
 * Reads declared config candidates and resolves the `ano` MCP entry. Strictly
 * read-only: no writes, no merges, no backup, no secret echo.
 */
export function discoverClientConfig(
  descriptor: ClientDescriptor,
  options: DoctorRunOptions = {},
): ConfigDiscovery {
  return discoverClientConfigResolved(descriptor, resolveOptions(options));
}

function discoverClientConfigResolved(
  descriptor: ClientDescriptor,
  resolved: ResolvedOptions,
): ConfigDiscovery {
  const limitations: string[] = [];
  const errors: IsolatedError[] = [];

  for (const candidate of descriptor.configCandidates) {
    const expanded = expandPath(candidate.path, resolved);
    if (!existsSync(expanded)) continue;
    if (!isFile(expanded)) continue;

    let extracted: { found: boolean; value: unknown };
    try {
      const text = readFileSync(expanded, 'utf8');
      extracted = candidate.format === 'toml' ? readTomlKey(text, candidate.key) : readJsonKey(text, candidate.key);
    } catch (error) {
      errors.push(
        isolated('configured', 'E2_PARSE_FAILED', `failed to parse ${expanded}: ${errorMessage(error)}`, resolved.now(), expanded),
      );
      continue;
    }
    if (!extracted.found) continue;

    const command = entryCommand(extracted.value);
    let reachable = false;
    if (command === null) {
      reachable = isRemoteEntry(extracted.value);
      limitations.push('configured entry exposes no resolvable local command');
    } else {
      reachable = commandReachable(command, resolved);
    }

    return {
      configPath: expanded,
      scope: candidate.scope,
      format: candidate.format,
      key: candidate.key,
      resolvedEntry: redactClientConfigEntry(extracted.value),
      exists: true,
      reachable,
      command,
      limitations,
      errors,
    };
  }

  if (descriptor.configCandidates.length === 0) {
    limitations.push('no declared config candidates for this client');
  }
  return {
    configPath: null,
    scope: null,
    format: null,
    key: null,
    resolvedEntry: null,
    exists: false,
    reachable: false,
    command: null,
    limitations,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Real MCP verification over stdio
// ---------------------------------------------------------------------------

interface PendingCall {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

class StdioRpc {
  private readonly process: ReturnType<typeof spawn>;
  private readonly timeoutMs: number;
  private readonly signal: AbortSignal | null;
  private readonly abortListener: (() => void) | null = null;
  private buffer = '';
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<number, PendingCall>();

  constructor(process: ReturnType<typeof spawn>, timeoutMs: number, signal?: AbortSignal) {
    this.process = process;
    this.timeoutMs = timeoutMs;
    this.signal = signal ?? null;

    const stdout = this.process.stdout;
    if (stdout !== null) {
      stdout.setEncoding('utf8');
      stdout.on('data', (chunk: string) => this.onData(chunk));
    }
    const stderr = this.process.stderr;
    if (stderr !== null) stderr.resume();
    this.process.on('error', (error) => this.failAll(error));
    this.process.on('exit', (code, killSignal) => {
      this.failAll(new Error(`stdio server exited before the exchange completed (code=${code ?? 'null'}, signal=${killSignal ?? 'null'})`));
    });

    if (signal) {
      if (signal.aborted) {
        this.failAll(new Error('aborted'));
      } else {
        this.abortListener = () => this.failAll(new Error('aborted'));
        signal.addEventListener('abort', this.abortListener, { once: true });
      }
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 0) this.handleLine(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message === null || typeof message !== 'object') return;
    const record = message as Record<string, unknown>;
    const id = record['id'];
    if (typeof id !== 'number') return;
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    const error = record['error'];
    if (error !== undefined && error !== null) {
      const detail = error as { message?: unknown };
      entry.reject(new Error(typeof detail.message === 'string' ? detail.message : `JSON-RPC error for id ${id}`));
      return;
    }
    entry.resolve(record['result']);
  }

  private failAll(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Error('MCP stdio server is no longer running'));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out after ${this.timeoutMs}ms: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const payload = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
      const stdin = this.process.stdin;
      if (stdin === null) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error('MCP stdio server has no stdin'));
        return;
      }
      stdin.write(payload, (error) => {
        if (!error || this.closed) return;
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        clearTimeout(entry.timer);
        entry.reject(error);
      });
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    if (this.closed) return;
    const stdin = this.process.stdin;
    if (stdin === null) return;
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      if (this.signal !== null && this.abortListener !== null) {
        this.signal.removeEventListener('abort', this.abortListener);
      }
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error('MCP stdio exchange closed'));
      }
      this.pending.clear();
    }
    try {
      this.process.kill();
    } catch {
      // already gone
    }
  }
}

function normalizeHandshake(raw: unknown, latencyMs: number, startedAt: string): McpHandshakeEvidence {
  const record = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const protocolVersion = typeof record['protocolVersion'] === 'string' ? record['protocolVersion'] : null;
  const serverInfo = record['serverInfo'] ?? null;
  return { transport: 'stdio', protocolVersion, serverInfo, latencyMs, startedAt };
}

function normalizeTools(raw: unknown): ToolsDetails {
  const record = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const list = Array.isArray(record['tools']) ? record['tools'] : [];
  const names: string[] = [];
  for (const item of list) {
    if (item !== null && typeof item === 'object') {
      const name = (item as Record<string, unknown>)['name'];
      if (typeof name === 'string') names.push(name);
    }
  }
  const expected = MCP_TOOL_NAMES as readonly string[];
  return {
    count: names.length,
    names,
    missing: expected.filter((name) => !names.includes(name)),
    extra: names.filter((name) => !expected.includes(name)),
  };
}

function extractBriefPayload(record: Record<string, unknown>): unknown {
  if (record['payload'] !== undefined) return record['payload'];
  if (record['structuredContent'] !== undefined) return record['structuredContent'];
  const content = record['content'];
  if (Array.isArray(content)) {
    const first = content[0];
    if (first !== null && typeof first === 'object') {
      const text = (first as Record<string, unknown>)['text'];
      if (typeof text === 'string') {
        try {
          return JSON.parse(text);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function normalizeBrief(raw: unknown): BriefDetails {
  const record = isRecord(raw) ? raw : {};
  const payload = extractBriefPayload(record);
  const payloadRecord = isRecord(payload) ? payload : null;
  const hasProjectContext =
    payloadRecord !== null &&
    (typeof payloadRecord['project_scope'] === 'string' ||
      isRecord(payloadRecord['memory_context']) ||
      Object.prototype.hasOwnProperty.call(payloadRecord, 'project') ||
      Object.prototype.hasOwnProperty.call(payloadRecord, 'hostCapability'));
  const takeoverProjection =
    payloadRecord !== null &&
    (Object.prototype.hasOwnProperty.call(payloadRecord, 'hostCapability') ||
      Object.prototype.hasOwnProperty.call(payloadRecord, 'primaryWriter') ||
      Object.prototype.hasOwnProperty.call(payloadRecord, 'role') ||
      Object.prototype.hasOwnProperty.call(payloadRecord, 'roles'));
  const rawHostCapability = payloadRecord?.['hostCapability'];
  const hostCapability =
    rawHostCapability === 'validated' || rawHostCapability === 'degraded' || rawHostCapability === 'unavailable'
      ? rawHostCapability
      : null;
  return { schema: payload, hasProjectContext, takeoverProjection, hostCapability };
}

interface VerifyParts {
  readonly handshake: McpHandshakeEvidence | null;
  readonly tools: ToolsDetails | null;
  readonly toolsError: IsolatedError | null;
  readonly brief: BriefDetails | null;
  readonly briefError: IsolatedError | null;
}

function finalizeVerify(parts: VerifyParts): VerifyResult {
  const verdicts = unavailableVerdicts();
  const errors: IsolatedError[] = [];
  addError(errors, parts.toolsError);
  addError(errors, parts.briefError);

  const handshake = parts.handshake;
  const handshakeOk = handshake !== null && handshake.protocolVersion !== null;
  if (handshake === null) {
    verdicts.mcp = 'unavailable';
  } else if (
    handshake.protocolVersion === null ||
    handshake.serverInfo === null ||
    handshake.startedAt === null ||
    handshake.latencyMs === null
  ) {
    verdicts.mcp = 'degraded';
  } else {
    verdicts.mcp = 'validated';
  }

  if (handshakeOk) {
    if (parts.toolsError !== null || parts.tools === null) {
      verdicts.tools = 'degraded';
    } else if (
      parts.tools.count === MCP_TOOL_COUNT &&
      parts.tools.missing.length === 0 &&
      parts.tools.extra.length === 0
    ) {
      verdicts.tools = 'validated';
    } else {
      verdicts.tools = 'degraded';
    }

    if (parts.briefError !== null || parts.brief === null) {
      verdicts.brief = 'degraded';
    } else if (parts.brief.hasProjectContext) {
      verdicts.brief = 'validated';
    } else {
      verdicts.brief = 'degraded';
    }
  }

  return { handshake, tools: parts.tools, brief: parts.brief, verdicts, errors };
}

function verifyFailure(at: string, error: IsolatedError): VerifyResult {
  return { handshake: null, tools: null, brief: null, verdicts: unavailableVerdicts(), errors: [error] };
}

/**
 * Real MCP verification. Uses the injected client when provided (tests only);
 * otherwise spawns the declared stdio command and speaks newline-delimited
 * JSON-RPC. Handshake failure stops amplification: tools/brief stay
 * `unavailable`. Handshake success never auto-validates tools or brief.
 */
export async function verifyStdioMcp(input: VerifyInput): Promise<VerifyResult> {
  if (input.inject !== undefined) return verifyInjected(input, input.inject);

  const command = input.command;
  if (command === undefined || command.length === 0) {
    return verifyFailure(
      new Date().toISOString(),
      isolated('mcp', 'E3_NO_COMMAND', 'no stdio command provided; refusing to fabricate a handshake', new Date().toISOString(), null),
    );
  }

  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = new Date().toISOString();
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, input.env ?? {});

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(command, input.args ?? [], {
      env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
      ...(input.root !== undefined ? { cwd: input.root } : {}),
    });
  } catch (error) {
    return verifyFailure(
      startedAt,
      isolated('mcp', 'E3_SPAWN_FAILED', `failed to spawn ${command}: ${errorMessage(error)}`, new Date().toISOString(), command),
    );
  }

  const rpc = new StdioRpc(child, timeoutMs, input.signal);
  try {
    const started = performance.now();
    const initialized = (await rpc.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'ano-doctor', version: '1.0.0' },
    })) as McpInitializeResult;
    const latencyMs = Math.max(0, Math.round(performance.now() - started));
    const handshake = normalizeHandshake(initialized, latencyMs, startedAt);
    rpc.notify('notifications/initialized', {});

    let tools: ToolsDetails | null = null;
    let toolsError: IsolatedError | null = null;
    try {
      tools = normalizeTools(await rpc.request('tools/list', {}));
    } catch (error) {
      toolsError = isolated('tools', 'E4_TOOLS_LIST_FAILED', errorMessage(error), new Date().toISOString(), command);
    }

    let brief: BriefDetails | null = null;
    let briefError: IsolatedError | null = null;
    try {
      brief = normalizeBrief(
        await rpc.request('tools/call', { name: 'brief', arguments: input.root !== undefined ? { root: input.root } : {} }),
      );
    } catch (error) {
      briefError = isolated('brief', 'E5_BRIEF_FAILED', errorMessage(error), new Date().toISOString(), command);
    }

    return finalizeVerify({ handshake, tools, toolsError, brief, briefError });
  } catch (error) {
    return verifyFailure(
      startedAt,
      isolated('mcp', 'E3_HANDSHAKE_FAILED', errorMessage(error), new Date().toISOString(), command),
    );
  } finally {
    rpc.close();
  }
}

async function verifyInjected(input: VerifyInput, client: McpClientLike): Promise<VerifyResult> {
  const startedAt = new Date().toISOString();
  let handshake: McpHandshakeEvidence | null = null;
  try {
    const started = performance.now();
    const initialized = await client.initialize();
    const latencyMs = Math.max(0, Math.round(performance.now() - started));
    handshake = {
      transport: 'stdio',
      protocolVersion: initialized.protocolVersion,
      serverInfo: initialized.serverInfo ?? null,
      latencyMs,
      startedAt,
    };
  } catch (error) {
    return verifyFailure(
      startedAt,
      isolated('mcp', 'E3_HANDSHAKE_FAILED', errorMessage(error), new Date().toISOString(), null),
    );
  }

  let tools: ToolsDetails | null = null;
  let toolsError: IsolatedError | null = null;
  try {
    tools = normalizeTools(await client.listTools());
  } catch (error) {
    toolsError = isolated('tools', 'E4_TOOLS_LIST_FAILED', errorMessage(error), new Date().toISOString(), null);
  }

  let brief: BriefDetails | null = null;
  let briefError: IsolatedError | null = null;
  try {
    brief = normalizeBrief(await client.callTool({ name: 'brief', arguments: input.root !== undefined ? { root: input.root } : {} }));
  } catch (error) {
    briefError = isolated('brief', 'E5_BRIEF_FAILED', errorMessage(error), new Date().toISOString(), null);
  }

  const result = finalizeVerify({ handshake, tools, toolsError, brief, briefError });
  try {
    await client.close();
  } catch {
    // ignore close failures
  }
  return result;
}

// ---------------------------------------------------------------------------
// Layer assembly
// ---------------------------------------------------------------------------

function buildDetectedLayer(descriptor: ClientDescriptor, detect: DetectResult, at: string): DetectedLayerReport {
  const source = detect.sources.length > 0 ? detect.sources.map((entry) => entry.source).join(', ') : `client:${descriptor.id}`;
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

function capValidated<T extends LayerReport>(report: T, reason: string): T {
  if (report.verdict !== 'validated') return report;
  return {
    ...report,
    verdict: 'degraded',
    evidence: 'configured',
    limitations: [...report.limitations, reason],
  } as T;
}

function buildConfiguredLayer(
  descriptor: ClientDescriptor,
  detect: DetectResult,
  discovery: ConfigDiscovery | null,
  discoveryEnabled: boolean,
  mcpValidated: boolean,
  fallback: LayerReport | null,
  at: string,
): ConfiguredLayerReport {
  const source = discovery?.configPath ?? `client:${descriptor.id}`;
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

  if (discoveryEnabled && discovery !== null) {
    if (!discovery.exists) {
      return {
        layer: 'configured',
        code: 'E2',
        verdict: 'degraded',
        evidence: 'absent',
        at,
        version: null,
        source,
        limitations: ['installed but no ano MCP entry found in declared config candidates', ...discovery.limitations],
        errors: discovery.errors,
        details: { configPath: null, scope: null, key: null, resolvedEntry: null, exists: false },
      };
    }
    const verdict: ClientVerdict = mcpValidated && discovery.reachable ? 'validated' : 'degraded';
    const evidence: ClientEvidence = discovery.reachable ? (mcpValidated ? 'measured' : 'configured') : 'configured';
    const limitations = [
      ...(discovery.reachable ? [] : ['configured entry path is not reachable']),
      ...discovery.limitations,
    ];
    return {
      layer: 'configured',
      code: 'E2',
      verdict,
      evidence,
      at,
      version: discovery.format === null ? null : `config-format:${discovery.format}`,
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

  if (fallback !== null && fallback.layer === 'configured') {
    return capValidated(fallback, 'configuration discovery did not run; declaration capped at degraded');
  }
  return {
    layer: 'configured',
    code: 'E2',
    verdict: 'unavailable',
    evidence: 'absent',
    at,
    version: null,
    source,
    limitations: ['configuration discovery did not run'],
    errors: [],
    details: { configPath: null, scope: null, key: null, resolvedEntry: null, exists: false },
  };
}

function buildMcpLayer(verify: VerifyResult, at: string): McpLayerReport {
  const handshake = verify.handshake;
  const limitations: string[] = [];
  if (handshake === null) {
    limitations.push('stdio initialize did not complete; mcp layer unavailable');
  } else {
    if (handshake.protocolVersion === null) limitations.push('initialize response omitted protocolVersion');
    if (handshake.serverInfo === null) limitations.push('initialize response omitted serverInfo');
    if (handshake.latencyMs === null) limitations.push('initialize latency was not measured');
  }
  return {
    layer: 'mcp',
    code: 'E3',
    verdict: verify.verdicts.mcp,
    evidence: handshake === null ? 'absent' : 'measured',
    at,
    version: handshake?.protocolVersion ?? null,
    source: handshake === null ? 'stdio:not-verified' : 'stdio:initialize',
    limitations,
    errors: verify.errors.filter((error) => error.layer === 'mcp'),
    details: {
      transport: 'stdio',
      protocolVersion: handshake?.protocolVersion ?? null,
      serverInfo: handshake?.serverInfo ?? null,
      latencyMs: handshake?.latencyMs ?? null,
      startedAt: handshake?.startedAt ?? null,
    },
  };
}

function buildToolsLayer(verify: VerifyResult, at: string): ToolsLayerReport {
  const tools = verify.tools;
  const limitations: string[] = [];
  if (tools === null) {
    limitations.push('tools/list did not return a tool set');
  } else {
    if (tools.count !== MCP_TOOL_COUNT) limitations.push(`tools/list returned ${tools.count} tools, expected ${MCP_TOOL_COUNT}`);
    if (tools.missing.length > 0) limitations.push(`missing tools: ${tools.missing.join(', ')}`);
    if (tools.extra.length > 0) limitations.push(`unexpected tools: ${tools.extra.join(', ')}`);
  }
  return {
    layer: 'tools',
    code: 'E4',
    verdict: verify.verdicts.tools,
    evidence: tools === null ? 'absent' : 'measured',
    at,
    version: null,
    source: tools === null ? 'stdio:not-verified' : 'stdio:tools/list',
    limitations,
    errors: verify.errors.filter((error) => error.layer === 'tools'),
    details: {
      count: tools?.count ?? 0,
      names: tools?.names ?? [],
      missing: tools?.missing ?? [...MCP_TOOL_NAMES],
      extra: tools?.extra ?? [],
    },
  };
}

function buildBriefLayer(verify: VerifyResult, at: string): BriefLayerReport {
  const brief = verify.brief;
  const limitations: string[] = [];
  if (brief === null) {
    limitations.push('brief was not callable or returned no parsable payload');
  } else if (!brief.hasProjectContext) {
    limitations.push('brief response lacks recognizable project context');
  }
  return {
    layer: 'brief',
    code: 'E5',
    verdict: verify.verdicts.brief,
    evidence: brief === null ? 'absent' : 'measured',
    at,
    version: null,
    source: brief === null ? 'stdio:not-verified' : 'stdio:tools/call:brief',
    limitations,
    errors: verify.errors.filter((error) => error.layer === 'brief'),
    details: {
      schema: brief?.schema ?? null,
      hasProjectContext: brief?.hasProjectContext ?? false,
      takeoverProjection: brief?.takeoverProjection ?? false,
      hostCapability: brief?.hostCapability ?? null,
    },
  };
}

function buildInstructionsLayer(
  descriptor: ClientDescriptor,
  detect: DetectResult,
  options: ResolvedOptions,
  at: string,
): InstructionsLayerReport {
  if (!detect.detected) {
    return {
      layer: 'instructions',
      code: 'E6',
      verdict: 'unavailable',
      evidence: 'absent',
      at,
      version: null,
      source: `client:${descriptor.id}`,
      limitations: ['detected prerequisite is unavailable'],
      errors: [],
      details: { rulePaths: [], formatVersion: null, hasManagedSection: false, readOnly: true },
    };
  }
  const rulePaths = descriptor.rulePaths
    .map((path) => expandPath(path, options))
    .filter((path) => existsSync(path));
  return {
    layer: 'instructions',
    code: 'E6',
    verdict: 'degraded',
    evidence: rulePaths.length > 0 ? 'measured' : 'absent',
    at,
    version: null,
    source: rulePaths.length > 0 ? rulePaths.join(', ') : `client:${descriptor.id}`,
    limitations: [
      'file presence does not prove the client read or applied the rules',
      'managed-section detection is delegated to the client adapter',
    ],
    errors: [],
    details: {
      rulePaths,
      formatVersion: null,
      hasManagedSection: false,
      readOnly: true,
    },
  };
}

function buildOrchestrationLayer(descriptor: ClientDescriptor, detect: DetectResult, at: string): OrchestrationLayerReport {
  if (!detect.detected) {
    return {
      layer: 'orchestration',
      code: 'E7',
      verdict: 'unavailable',
      evidence: 'absent',
      at,
      version: null,
      source: `client:${descriptor.id}`,
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

function computeStatus(detect: DetectResult, coreVerdict: ClientVerdict, errors: readonly IsolatedError[]): ClientReport['status'] {
  if (!detect.detected && detect.sources.length === 0) return 'unavailable';
  if (coreVerdict === 'validated' && errors.length === 0) return 'ready';
  return 'degraded';
}

/** Last-resort isolation: even an unexpected crash becomes one client's report. */
function crashedClientReport(descriptor: ClientDescriptor, error: unknown, at: string): ClientReport {
  return {
    schema: CLIENT_REPORT_SCHEMA,
    clientId: descriptor.id,
    alias: descriptor.alias,
    status: 'unavailable',
    coreVerdict: 'unavailable',
    layers: unavailableLayerReports(at, `client:${descriptor.id}`),
    generatedAt: at,
    limitations: [
      ...descriptor.notes,
      'client probe crashed; this report is an isolated failure and does not block other clients',
    ],
    errors: [isolated('client', 'E_CLIENT_PROBE_CRASHED', errorMessage(error), at, `client:${descriptor.id}`)],
  };
}

function unknownClientReport(descriptor: ClientDescriptor, at: string): ClientReport {
  const layers = unavailableLayerReports(at, `client:${descriptor.id}`);
  const limitations = [
    ...descriptor.notes,
    'identity or interface unclear: probe declared public sources only',
    'all capability layers stay unavailable and can never be validated',
  ];
  return {
    schema: CLIENT_REPORT_SCHEMA,
    clientId: descriptor.id,
    alias: descriptor.alias,
    status: 'unknown',
    coreVerdict: 'unavailable',
    layers,
    generatedAt: at,
    limitations,
    errors: [],
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/** Probe one client. Never throws for client-local failures. */
export async function doctorClient(
  descriptor: ClientDescriptor,
  options: DoctorRunOptions = {},
): Promise<ClientReport> {
  const resolved = resolveOptions(options);
  const at = resolved.now();

  if (descriptor.identityStatus === 'unknown') {
    return unknownClientReport(descriptor, at);
  }

  const errors: IsolatedError[] = [];
  const limitations: string[] = [];
  const adapter = resolved.adapters[descriptor.id] ?? null;

  // Phase 1: detect (adapter first, generic fallback).
  let detect: DetectResult;
  if (adapter !== null) {
    try {
      detect = await adapter.detect(detectInput(resolved));
    } catch (error) {
      detect = detectFailure(descriptor.id, error, resolved.now());
    }
  } else {
    try {
      detect = genericDetectResolved(descriptor, resolved);
    } catch (error) {
      detect = detectFailure(descriptor.id, error, resolved.now());
    }
  }
  addError(errors, detect.errors[0]);

  // Phase 2: read-only configuration discovery.
  let discovery: ConfigDiscovery | null = null;
  if (resolved.discoverConfig) {
    try {
      discovery = discoverClientConfigResolved(descriptor, resolved);
    } catch (error) {
      addError(errors, isolated('configured', 'E2_DISCOVERY_FAILED', errorMessage(error), resolved.now(), null));
    }
  } else {
    limitations.push('configuration discovery disabled by caller');
  }
  if (discovery !== null) {
    for (const error of discovery.errors) addError(errors, error);
  }

  // Phase 3: adapter inspection (authoritative extension detail when present).
  let inspected: ClientReport | null = null;
  if (adapter !== null) {
    try {
      inspected = await adapter.inspect(inspectInput(resolved));
    } catch (error) {
      addError(errors, isolated('client', 'E_CLIENT_INSPECT_FAILED', errorMessage(error), resolved.now(), `adapter:${descriptor.id}`));
    }
  }
  if (inspected !== null) {
    for (const error of inspected.errors) addError(errors, error);
  }

  // Phase 4: real MCP verification (injectable).
  const verifyInput = resolved.verifyInputs[descriptor.id] ?? resolved.verify ?? null;
  let verify: VerifyResult | null = null;
  if (verifyInput !== null) {
    try {
      verify = resolved.verifier !== null ? await resolved.verifier(verifyInput) : await verifyStdioMcp(verifyInput);
    } catch (error) {
      addError(errors, isolated('mcp', 'E3_VERIFY_FAILED', errorMessage(error), resolved.now(), verifyInput.command ?? null));
    }
  } else {
    limitations.push('MCP verification not requested for this client');
  }
  if (verify !== null) {
    for (const error of verify.errors) addError(errors, error);
  }

  // Assemble layers, then overlay doctor-owned measurements.
  const layers: MutableLayerReports =
    inspected !== null ? { ...inspected.layers } : unavailableLayerReports(at, `client:${descriptor.id}`);
  const mcpValidated = verify?.verdicts.mcp === 'validated';

  layers.detected = buildDetectedLayer(descriptor, detect, at);
  layers.configured = buildConfiguredLayer(
    descriptor,
    detect,
    discovery,
    resolved.discoverConfig,
    mcpValidated,
    inspected !== null ? inspected.layers.configured : null,
    at,
  );

  if (verify !== null) {
    layers.mcp = buildMcpLayer(verify, at);
    layers.tools = buildToolsLayer(verify, at);
    layers.brief = buildBriefLayer(verify, at);
  } else {
    layers.mcp = capValidated(layers.mcp, 'MCP verification not run; validated verdict not allowed');
    layers.tools = capValidated(layers.tools, 'MCP verification not run; validated verdict not allowed');
    layers.brief = capValidated(layers.brief, 'MCP verification not run; validated verdict not allowed');
  }

  if (inspected === null) {
    layers.instructions = buildInstructionsLayer(descriptor, detect, resolved, at);
    layers.orchestration = buildOrchestrationLayer(descriptor, detect, at);
    layers.history = buildHistoryLayer(at);
    layers['output-interception'] = buildOutputInterceptionLayer(at);
  }

  const extensionLimitations: string[] = [];
  for (const layer of EXTENSION_LAYERS) {
    const report = layers[layer];
    if (report.verdict === 'unavailable') {
      extensionLimitations.push(`${layer} unavailable: ${report.limitations[0] ?? 'not measured'}`);
    }
  }

  const coreVerdict = weakestVerdict(CORE_LAYERS.map((layer) => layers[layer].verdict));
  const allLimitations = dedupe([
    ...limitations,
    ...descriptor.notes,
    ...extensionLimitations,
    ...errors.map((error) => `${error.code}: ${error.message}`),
  ]);

  return {
    schema: CLIENT_REPORT_SCHEMA,
    clientId: descriptor.id,
    alias: descriptor.alias,
    status: computeStatus(detect, coreVerdict, errors),
    coreVerdict,
    layers,
    generatedAt: at,
    limitations: allLimitations,
    errors,
  };
}

/** Run every registered client (or the requested subset) with failure isolation. */
export async function doctorClients(options: DoctorRunOptions = {}): Promise<DoctorReport> {
  const resolved = resolveOptions(options);
  const ids = options.clientIds ?? resolved.registry.list().map((descriptor) => descriptor.id);
  const clients: ClientReport[] = [];
  for (const id of ids) {
    const descriptor = resolved.registry.get(id);
    try {
      clients.push(await doctorClient(descriptor, options));
    } catch (error) {
      clients.push(crashedClientReport(descriptor, error, resolved.now()));
    }
  }
  return {
    schema: DOCTOR_REPORT_SCHEMA,
    generatedAt: resolved.now(),
    clients,
    limitations: GLOBAL_LIMITATIONS,
  };
}
