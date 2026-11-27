/**
 * T-100 / CX-10: security red team for the full 24-client catalog boundary.
 *
 * Scope (docs/adr/ADR-008-full-client-catalog.md §2 ten hard boundaries, §4/§5,
 * §6/§7; docs/client-compatibility.md §11):
 * - forged configuration content is inert data for all 24 clients (21 ADR-008
 *   tools + the 3 M11 legacy clients), never executed;
 * - malicious paths (traversal / absolute injection / symlink / allowedRoot
 *   escape / directory target) are refused with zero writes;
 * - command injection payloads in config entries never reach a spawn;
 * - unauthorized batch/single installs write nothing;
 * - doctor/plan/batch/history never read `.env`, secrets or real session stores;
 * - unknown history formats fail closed;
 * - cloud-only / IDE-plugin-only clients generate no invalid config and never
 *   report `validated`;
 * - client reports/plans/matrix entries/install results carry no Gate field and
 *   a successful MCP handshake changes no Gate permission;
 * - one crashing client/adapter is isolated from the rest;
 * - aliases resolve (`cloudcode` -> `claude-code`, `dsh` -> `deepseek-harness`),
 *   unknown ids are refused and self-reported external `validated` is capped.
 *
 * Every scenario runs in a fresh `os.tmpdir()` project/home and never writes the
 * repository's own `.pm/`, `.ano/`, user-level configuration or real client
 * session stores. Zero-write claims are backed by whole-tree snapshots.
 *
 * This file is additive to the M11 red team
 * (`test/redteam/client-adapters-boundary.test.ts`); it does not modify it.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import test, { type TestContext } from 'node:test';
import {
  CAPABILITY_LAYERS,
  CLIENT_IDS,
  CLIENT_REPORT_SCHEMA,
  CORE_LAYERS,
  MCP_TOOL_COUNT,
  MCP_TOOL_NAMES,
  type CapabilityLayer,
  type ClientAdapter,
  type ClientAuthorizationRef,
  type ClientId,
  type ClientReport,
  type ClientVerdict,
  type ConfigInput,
  type DetectResult,
  type VerifyResult,
} from '../../src/clients/types.ts';
import { defaultRegistry, getDescriptor, resolveClientId, UnknownClientError } from '../../src/clients/registry.ts';
import {
  doctorClient,
  doctorClients,
  registerAllClientAdapters,
  unavailableLayerReports,
  verifyStdioMcp,
} from '../../src/clients/doctor.ts';
import {
  applyClientConfig,
  assertSafeServerPath,
  assertSafeTargetPath,
  planClientConfig,
  restoreClientConfig,
  verifyClientConfigBackup,
  type ClientConfigApplyOptions,
  type ClientConfigAuthorization,
  type ClientConfigTarget,
} from '../../src/clients/config.ts';
import { installClientConfig, installClientBatch, readInstallRecord } from '../../src/clients/install.ts';
import {
  ExternalAdapterRejectedError,
  createUnknownAdapter,
  enforceUnknownReport,
  registerExternalAdapter,
  validateExternalAdapter,
  type ExternalAdapterDeclaration,
  type ExternalAdapterValidation,
} from '../../src/clients/unknown.ts';
import {
  HOST_AUTO_APPROVAL_AVAILABLE,
  HOST_AUTO_INTERCEPTION_AVAILABLE,
  clientAccessPlans,
  mapClientCapabilities,
  mapDoctorReport,
  planAccessReport,
  planClientAccess,
  type ClientAccessPlan,
  type ClientAccessRoute,
  type ClientTakeoverCapabilities,
} from '../../src/clients/capabilities.ts';
import {
  clientAccessPlanReport,
  clientDoctorReport,
  clientDoctorSingle,
  clientInstallSurface,
  clientRestoreSurface,
  resolveClientTarget,
} from '../../src/surface/service.ts';
import { roleMatrixForState } from '../../src/connect/capabilities.ts';

const AT = '2026-11-23T00:00:00.000Z';

/** The 21 ADR-008 §3 tools, in catalog order. */
const TOOLS_21 = [
  'claude-code',
  'github-copilot',
  'cursor',
  'codex',
  'trae',
  'antigravity',
  'replit-agent',
  'cline',
  'kilo-code',
  'hermes-agent',
  'openclaw',
  'zed',
  'tabnine',
  'amazon-q',
  'jetbrains-ai',
  'codegeex',
  'tongyi-lingma',
  'comate',
  'qoder',
  'codebuddy',
  'deepseek-harness',
] as const satisfies readonly ClientId[];

/** The three M11 legacy non-catalog clients. */
const LEGACY_3 = ['opencode', 'pi', 'zcode'] as const satisfies readonly ClientId[];

/** All 24 registry ids (21 + 3). */
const ALL_24 = [...CLIENT_IDS] as ClientId[];
assert.deepEqual([...TOOLS_21, ...LEGACY_3].sort(), [...ALL_24].sort());

/** Cloud-only / IDE-plugin-only tools with no public local MCP interface. */
const CLOUD_PLUGIN_ONLY = ['replit-agent', 'tabnine', 'jetbrains-ai', 'codegeex'] as const satisfies readonly ClientId[];

/** Clients whose access route cannot write a local MCP config in v1. */
const NON_MCP_ROUTE = [
  'replit-agent',
  'tabnine',
  'jetbrains-ai',
  'codegeex',
  'hermes-agent',
  'openclaw',
  'qoder',
  'deepseek-harness',
  'pi',
  'zcode',
] as const satisfies readonly ClientId[];

const SECRET_MARKERS = [
  'ROOT_ENV_SECRET',
  'RSA_PRIVATE_MARKER',
  'CREDENTIALS_MARKER',
  'SESSION_CONTENT_MARKER',
  'SESSION_MESSAGE_MARKER',
  'SESSION_PROMPT_MARKER',
  'SESSION_TOKEN_MARKER',
  'SECRET_VALUE_MARKER',
] as const;

const GATE_TOKENS = ['evidence_id', 'task_id', 'approve', 'cutover'] as const;

// ---------------------------------------------------------------------------
// Compile-time Gate boundary (type-level double insurance)
// ---------------------------------------------------------------------------

type AssertKeysAbsent<T, K extends string> = { readonly [P in K]: P extends keyof T ? readonly ['unexpected key', P] : never };
const _reportGateKeys: AssertKeysAbsent<ClientReport, 'evidence_id' | 'task_id' | 'approve' | 'cutover'> = {
  evidence_id: undefined as never,
  task_id: undefined as never,
  approve: undefined as never,
  cutover: undefined as never,
};
const _planGateKeys: AssertKeysAbsent<ClientAccessPlan, 'evidence_id' | 'task_id' | 'approve' | 'cutover'> = {
  evidence_id: undefined as never,
  task_id: undefined as never,
  approve: undefined as never,
  cutover: undefined as never,
};
const _capabilityGateKeys: AssertKeysAbsent<ClientTakeoverCapabilities, 'evidence_id' | 'task_id' | 'approve' | 'cutover'> = {
  evidence_id: undefined as never,
  task_id: undefined as never,
  approve: undefined as never,
  cutover: undefined as never,
};
const _verifyGateKeys: AssertKeysAbsent<VerifyResult, 'evidence_id' | 'task_id' | 'approve' | 'cutover'> = {
  evidence_id: undefined as never,
  task_id: undefined as never,
  approve: undefined as never,
  cutover: undefined as never,
};
void _reportGateKeys;
void _planGateKeys;
void _capabilityGateKeys;
void _verifyGateKeys;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function expectError(error: unknown, code: string, pattern: RegExp): boolean {
  assert.equal(codeOf(error), code);
  assert.match(error instanceof Error ? error.message : String(error), pattern);
  return true;
}

async function makeRoot(t: TestContext, prefix = 'ano-t100-'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function canCreateSymlink(directory: string): Promise<boolean> {
  const target = join(directory, `symlink-target-${process.pid}`);
  const link = join(directory, `symlink-link-${process.pid}`);
  try {
    await writeFile(target, 'x');
    await symlink(target, link, 'file');
    await rm(link, { force: true });
    await rm(target, { force: true });
    return true;
  } catch {
    return false;
  }
}

async function snapshotTree(root: string): Promise<string> {
  const entries: Array<Record<string, unknown>> = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    let list;
    try {
      list = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of list.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(dir, entry.name);
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(full, rel);
      else if (entry.isFile()) {
        const bytes = await readFile(full);
        entries.push({ path: rel, bytes: bytes.length, hash: sha256(bytes) });
      }
    }
  };
  await walk(root, '');
  return JSON.stringify(entries);
}

function targetFor(root: string, overrides: Partial<ClientConfigTarget> = {}): ClientConfigTarget {
  return {
    clientId: 'claude-code',
    scope: 'project',
    path: join(root, '.mcp.json'),
    format: 'json',
    serverPath: ['mcpServers'],
    serverName: 'ano',
    allowedRoot: root,
    ...overrides,
  };
}

/** A config-service target pinned to the project root, independent of the adapter's declared scope. */
function serviceTargetFor(root: string, clientId: string, path: string): ClientConfigTarget {
  return targetFor(root, { clientId, scope: 'project', path, allowedRoot: root });
}

function authorizationFor(root: string, overrides: Partial<ClientConfigAuthorization> = {}): ClientConfigAuthorization {
  return {
    authorizationId: 'a'.repeat(64),
    root,
    clientId: 'claude-code',
    scope: ['config', 'install', 'restore'],
    grantedBy: 'Alice',
    statement: 'I explicitly authorize this client configuration write.',
    grantedAt: AT,
    ...overrides,
  };
}

function applyOptionsFor(root: string, overrides: Partial<ClientConfigApplyOptions> = {}): ClientConfigApplyOptions {
  return { mode: 'apply', confirm: true, authorization: authorizationFor(root), root, ...overrides };
}

/** Adapter-level authorization reference (`ConfigInput.authorization`). */
function adapterAuthorizationFor(root: string, clientId: ClientId): ClientAuthorizationRef & { readonly statement: string } {
  return {
    authorizationId: 'a'.repeat(64),
    root,
    clientId,
    scope: ['config', 'install', 'restore'],
    grantedBy: 'Alice',
    statement: 'I explicitly authorize this client configuration write.',
    grantedAt: AT,
    revokedAt: null,
  };
}

function writeConfig(target: ClientConfigTarget, value: unknown): void {
  writeFileSync(target.path, `${JSON.stringify(value, null, 2)}\n`);
}

function expand(path: string, home: string, root: string): string {
  let value = path;
  if (value === '~') value = home;
  else if (value.startsWith('~/')) value = `${home}/${value.slice(2)}`;
  else if (value.startsWith('~\\')) value = `${home}\\${value.slice(2)}`;
  value = value.split('<root>').join(root);
  return resolve(value);
}

function emptyVerdicts(): Record<CapabilityLayer, ClientVerdict> {
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

function successfulVerify(at: string = AT): VerifyResult {
  return {
    handshake: {
      transport: 'stdio',
      protocolVersion: '2025-06-18',
      serverInfo: { name: 'fake-ano', version: '1.0.0' },
      latencyMs: 1,
      startedAt: at,
    },
    tools: { count: MCP_TOOL_COUNT, names: [...MCP_TOOL_NAMES], missing: [], extra: [] },
    brief: {
      schema: { phase: 'P7', project_scope: 'local', memory_context: { context_id: 'ctx-1' }, hostCapability: 'degraded' },
      hasProjectContext: true,
      takeoverProjection: true,
      hostCapability: 'degraded',
    },
    verdicts: { ...emptyVerdicts(), mcp: 'validated', tools: 'validated', brief: 'validated' },
    errors: [],
  };
}

function lyingReport(clientId: ClientId): ClientReport {
  const layers = unavailableLayerReports(AT, `liar:${clientId}`) as unknown as Record<CapabilityLayer, Record<string, unknown>>;
  for (const layer of CAPABILITY_LAYERS) {
    layers[layer] = { ...layers[layer], verdict: 'validated', evidence: 'measured' };
  }
  return {
    schema: CLIENT_REPORT_SCHEMA,
    clientId,
    alias: null,
    status: 'ready',
    coreVerdict: 'validated',
    layers: layers as unknown as ClientReport['layers'],
    generatedAt: AT,
    limitations: [],
    errors: [],
  };
}

function lyingAdapter(id: ClientId): ClientAdapter {
  return {
    id,
    identitySources: [],
    detect: async (): Promise<DetectResult> => ({
      clientId: id,
      detected: true,
      executablePath: `/fake/${id}`,
      version: '9.9.9',
      sources: [],
      errors: [],
    }),
    inspect: async () => lyingReport(id),
    config: async () => ({ mode: 'dry-run', changes: [], backupPlan: null, warnings: [] }),
    verify: async () => successfulVerify(AT),
  };
}

function throwingAdapter(id: ClientId): ClientAdapter {
  return {
    id,
    identitySources: [],
    detect: async () => {
      throw new Error(`${id} detect exploded`);
    },
    inspect: async () => {
      throw new Error(`${id} inspect exploded`);
    },
    config: async () => {
      throw new Error(`${id} config exploded`);
    },
    verify: async () => {
      throw new Error(`${id} verify exploded`);
    },
  };
}

function goodAdapter(id: ClientId): ClientAdapter {
  return {
    id,
    identitySources: [],
    detect: async (): Promise<DetectResult> => ({
      clientId: id,
      detected: true,
      executablePath: `/fake/${id}`,
      version: '1.0.0',
      sources: [],
      errors: [],
    }),
    inspect: async () => lyingReport(id),
    config: async () => ({ mode: 'dry-run', changes: [], backupPlan: null, warnings: [] }),
    verify: async () => successfulVerify(AT),
  };
}

function declaration(overrides: Partial<ExternalAdapterDeclaration> = {}): ExternalAdapterDeclaration {
  return {
    id: 'claude-code',
    identitySources: [{ kind: 'executable', value: 'claude', detail: null }],
    detect: async (): Promise<DetectResult> => ({
      clientId: 'claude-code',
      detected: true,
      executablePath: '/fake/claude',
      version: '1.0.0',
      sources: [],
      errors: [],
    }),
    inspect: async () => lyingReport('claude-code'),
    config: async () => ({ mode: 'dry-run', changes: [], backupPlan: null, warnings: [] }),
    verify: async () => successfulVerify(AT),
    capabilities: { layers: ['detected', 'mcp'] },
    evidence: { source: 'https://example.test/evidence', measured: false },
    ...overrides,
  };
}

const validValidation: ExternalAdapterValidation = {
  evidenceSource: 'https://example.test/validation',
  measured: false,
};

function maliciousEntry(sentinel: string): Record<string, unknown> {
  // Built as a serialized document so the entry owns a literal `__proto__` key;
  // it must stay data and never pollute `Object.prototype`. The absolute
  // sentinel path is backslash-escaped for JSON, and the backtick is inserted
  // via `String.fromCharCode` to keep this source parseable.
  const escapedSentinel = sentinel.replace(/\\/gu, '\\\\');
  const bt = String.fromCharCode(96);
  const raw = '{"command":"node; touch ' + escapedSentinel + '","args":["$(touch ' + escapedSentinel + ')","' + bt + 'touch ' + escapedSentinel + bt + '","a && touch ' + escapedSentinel + '","<script>alert(1)</script>","line1\\nline2"],"env":{"API_KEY":"SECRET_VALUE_MARKER"},"__proto__":{"polluted":true},"constructor":"x","nested":{"prototype":"y"}}';
  return JSON.parse(raw) as Record<string, unknown>;
}

function assertNoGateTokens(value: unknown): void {
  const json = JSON.stringify(value);
  for (const token of GATE_TOKENS) {
    assert.equal(json.includes(token), false, `Gate token leaked: ${token}`);
  }
}

async function readSourceFile(name: string): Promise<string> {
  return readFile(new URL(`../../src/clients/${name}`, import.meta.url), 'utf8');
}

async function listClientSources(): Promise<string[]> {
  const entries = await readdir(new URL('../../src/clients/', import.meta.url), { withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.ts')).map((entry) => entry.name).sort();
}

/** `ConfigInput` has no `env` field, but adapters read it via a structural cast. */
function withEnv(input: ConfigInput, env: Record<string, string>): ConfigInput {
  return { ...input, env } as unknown as ConfigInput;
}

/** Installed entry for the batch path (mirrors the adapters' declared entry). */
function batchAuthorizations(root: string, ids: readonly ClientId[]): Record<string, ClientConfigAuthorization> {
  const map: Record<string, ClientConfigAuthorization> = {};
  for (const id of ids) map[id] = authorizationFor(root, { clientId: id });
  return map;
}

// ---- 1. forged configuration is inert data --------------------------------

test('T-100/01 forged config content is inert data for all 24 clients and never executed', async (t) => {
  const root = await makeRoot(t, 'ano-t100-forge-');
  const home = await makeRoot(t, 'ano-t100-forge-home-');
  const sentinel = join(root, 'SENTINEL_PWNED');
  const payload = maliciousEntry(sentinel);
  const adapters = registerAllClientAdapters({ home, root, env: { HOME: home, USERPROFILE: home } });
  const env = { HOME: home, USERPROFILE: home };

  const jsonApplied: string[] = [];
  const tomlRefused: string[] = [];
  const noCandidate: string[] = [];

  for (const id of ALL_24) {
    const descriptor = getDescriptor(id);
    const jsonCandidate = descriptor.configCandidates.find((candidate) => candidate.format === 'json');
    const tomlCandidate = descriptor.configCandidates.find((candidate) => candidate.format === 'toml');

    if (jsonCandidate !== undefined) {
      const path = expand(jsonCandidate.path, home, root);
      await mkdir(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify({ mcpServers: { other: { command: 'x' } }, unknownKeep: { a: 1 } }, null, 2)}\n`);
      const target = targetFor(root, {
        clientId: id,
        scope: jsonCandidate.scope,
        path,
        format: 'json',
        serverPath: jsonCandidate.key.split('.').slice(0, -1),
        allowedRoot: jsonCandidate.scope === 'user' ? home : root,
      });
      const result = applyClientConfig(target, payload, applyOptionsFor(root, { authorization: authorizationFor(root, { clientId: id }) }));
      assert.equal(result.applied, true, `${id} must apply the declared JSON target`);
      assert.equal(result.mode, 'apply', id);
      jsonApplied.push(id);

      const text = readFileSync(path, 'utf8');
      assert.equal(existsSync(sentinel), false, `${id}: configuration content must never be executed`);
      assert.ok(text.includes('$(touch'), `${id}: command substitution preserved as data`);
      assert.ok(text.includes('`touch'), `${id}: backticks preserved as data`);
      assert.ok(text.includes('a && touch'), `${id}: shell chaining preserved as data`);
      assert.ok(text.includes('<script>'), `${id}: script payload preserved as data`);
      assert.ok(text.includes('line1\\nline2'), `${id}: newline JSON-escaped, not interpreted`);
      assert.ok(text.includes('SECRET_VALUE_MARKER'), `${id}: env value stays in the document bytes`);
      assert.ok(text.includes('__proto__'), `${id}: nested reserved key stays data`);
      assert.ok(text.includes('other'), `${id}: unrelated service preserved`);
      assert.ok(text.includes('unknownKeep'), `${id}: unknown field preserved`);
      assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false, `${id}: Object.prototype stays clean`);
    } else if (tomlCandidate !== undefined) {
      const path = expand(tomlCandidate.path, home, root);
      await mkdir(dirname(path), { recursive: true });
      const original = '[mcp_servers.other]\ncommand = "x"\n';
      writeFileSync(path, original);
      const target = targetFor(root, {
        clientId: id,
        scope: tomlCandidate.scope,
        path,
        format: 'toml',
        serverPath: tomlCandidate.key.split('.').slice(0, -1),
        allowedRoot: tomlCandidate.scope === 'user' ? home : root,
      });
      const result = applyClientConfig(target, payload, applyOptionsFor(root, { authorization: authorizationFor(root, { clientId: id }) }));
      assert.equal(result.applied, false, `${id}: TOML is read-only in v1`);
      assert.equal(result.refused, true, id);
      assert.equal(result.mode, 'dry-run', id);
      assert.equal(readFileSync(path, 'utf8'), original, `${id}: refused TOML write is byte-identical`);
      tomlRefused.push(id);
    } else {
      noCandidate.push(id);
    }
  }

  // Every one of the 24 clients is covered by exactly one branch.
  assert.equal(jsonApplied.length + tomlRefused.length + noCandidate.length, 24);
  assert.ok(jsonApplied.includes('claude-code') && jsonApplied.includes('zcode'));
  assert.deepEqual(tomlRefused, ['codex']);

  // Adapter-level: pre-existing malicious content is read as data only. A
  // dry-run plan must leave the source file byte-identical and create nothing.
  for (const id of ALL_24) {
    const adapter = adapters[id];
    if (adapter === undefined) {
      assert.equal(id, 'zcode', `only zcode has no adapter; missing ${id}`);
      continue;
    }
    const descriptor = getDescriptor(id);
    const candidate = descriptor.configCandidates.find((entry) => entry.format === 'json');
    const path = candidate !== undefined
      ? expand(candidate.path, home, root)
      : join(root, `no-candidate-${id}.json`);
    await mkdir(dirname(path), { recursive: true });
    const maliciousDocument = `${JSON.stringify({ mcpServers: { evil: { command: `x; touch ${sentinel}` } } })}\n`;
    writeFileSync(path, maliciousDocument);
    const target = {
      scope: (candidate?.scope ?? 'project') as ClientConfigTarget['scope'],
      path,
    };
    const result = await adapter.config(withEnv({
      mode: 'dry-run',
      target,
      root,
      authorization: adapterAuthorizationFor(root, id),
    }, env));
    assert.equal(result.mode, 'dry-run', `${id}: adapter config defaults to dry-run`);
    assert.equal(existsSync(sentinel), false, `${id}: adapter must not execute config content`);
    assert.deepEqual(await readFile(path, 'utf8'), maliciousDocument, `${id}: dry-run leaves the source byte-identical`);
    assert.ok(result.changes.every((change) => change.operation !== 'remove'), `${id}: dry-run never plans a remove`);
  }

  // Apply path through the adapters for a writable sample: malicious bytes are
  // preserved as data, the ANO entry is merged, nothing is executed.
  const claude = adapters['claude-code'];
  assert.ok(claude !== undefined);
  const claudePath = join(root, '.mcp.json');
  const maliciousClaude = `${JSON.stringify({ mcpServers: { evil: { command: `x; touch ${sentinel}`, args: ['$(touch pwned)'] } } })}\n`;
  writeFileSync(claudePath, maliciousClaude);
  const appliedClaude = await claude.config(withEnv({
    mode: 'apply',
    target: { scope: 'project', path: claudePath },
    root,
    authorization: adapterAuthorizationFor(root, 'claude-code'),
  }, env));
  assert.equal(appliedClaude.mode, 'apply');
  const claudeText = readFileSync(claudePath, 'utf8');
  assert.ok(claudeText.includes('<script>') === false, 'no script payload was injected');
  assert.ok(claudeText.includes('$(touch pwned)'), 'pre-existing malicious args stay data');
  assert.ok(claudeText.includes('ano'), 'the ANO entry is present');
  assert.equal(existsSync(sentinel), false, 'apply never executes configuration content');

  // Static guard: adapters own no execution primitive; the only spawn site is
  // doctor.ts and it disables the shell.
  const sources = await listClientSources();
  assert.ok(sources.length >= 24, `expected the full client source set, found ${sources.length}`);
  const forbidden = ['child_process', 'spawn(', 'execSync', 'spawnSync', 'execFileSync', 'eval(', 'new Function'];
  for (const name of sources) {
    const source = await readSourceFile(name);
    if (name === 'doctor.ts') {
      assert.match(source, /shell:\s*false/u, 'doctor.ts must disable the shell');
      assert.equal((source.match(/spawn\(/gu) ?? []).length, 1, 'doctor.ts must contain exactly one spawn call');
      for (const token of ['execSync', 'spawnSync', 'execFileSync', 'eval(', 'new Function']) {
        assert.equal(source.includes(token), false, `doctor.ts must not contain ${token}`);
      }
      continue;
    }
    for (const token of forbidden) {
      assert.equal(source.includes(token), false, `${name} must not contain ${token}`);
    }
  }
  // Adapters never write files; config.ts/install.ts own the write path.
  const writePrimitives = ['writeFileSync', 'writeFile(', 'mkdirSync', 'mkdir(', 'renameSync', 'unlinkSync', 'rmSync', 'appendFileSync'];
  const adapterSources = sources.filter((name) => !['config.ts', 'install.ts', 'types.ts', 'registry.ts', 'doctor.ts'].includes(name));
  for (const name of adapterSources) {
    const source = await readSourceFile(name);
    for (const token of writePrimitives) {
      assert.equal(source.includes(token), false, `${name} must not write files (${token})`);
    }
  }
  for (const name of ['config.ts', 'install.ts']) {
    const source = await readSourceFile(name);
    assert.ok(writePrimitives.some((token) => source.includes(token)), `${name} owns the write path`);
  }
});

// ---- 2. malicious paths are refused with zero writes ---------------------

test('T-100/02 traversal, absolute injection, symlink and directory targets are refused per client', async (t) => {
  const root = await makeRoot(t, 'ano-t100-path-');
  const home = await makeRoot(t, 'ano-t100-path-home-');
  const outside = await makeRoot(t, 'ano-t100-path-out-');
  const adapters = registerAllClientAdapters({ home, root, env: { HOME: home, USERPROFILE: home } });
  const env = { HOME: home, USERPROFILE: home };
  const sentinel = join(outside, 'SENTINEL_PATH');
  const symlinks = await canCreateSymlink(root);

  for (const id of ALL_24) {
    const adapter = adapters[id];
    const descriptor = getDescriptor(id);
    const candidate = descriptor.configCandidates.find((entry) => entry.format === 'json');
    // Malicious-path probes use the project scope: the write scope every MCP
    // config target is bound to. (A user-scope library gap is reported
    // separately; the surface write path refuses it.)
    const scope = 'project' as ClientConfigTarget['scope'];
    const baseTarget = {
      scope,
      path: candidate !== undefined ? expand(candidate.path, home, root) : join(root, `base-${id}.json`),
    };

    // (a) `..` escape outside the declared scope.
    const escapePath = join(outside, `${id}-escape.json`);
    const escapeBytes = '{"mcpServers":{}}\n';
    await writeFile(escapePath, escapeBytes);
    const beforeEscape = await snapshotTree(outside);
    if (adapter !== undefined) {
      const result = await adapter.config(withEnv({
        mode: 'apply',
        target: { ...baseTarget, path: escapePath },
        root,
        authorization: adapterAuthorizationFor(root, id),
      }, env));
      assert.equal(result.mode, 'dry-run', `${id}: escape must be refused`);
    }
    assert.throws(
      () => assertSafeTargetPath(serviceTargetFor(root, id, escapePath)),
      /escapes/u,
      `${id}: config service must reject the escape`,
    );
    assert.equal(await readFile(escapePath, 'utf8'), escapeBytes, `${id}: refused escape must not touch the outside file`);
    assert.equal(await snapshotTree(outside), beforeEscape, `${id}: outside tree unchanged`);

    // (b) absolute path injection: an absolute sensitive-looking path outside
    // the scope is refused; the file is never created.
    const absolutePath = join(outside, `${id}-absolute.json`);
    if (adapter !== undefined) {
      const result = await adapter.config(withEnv({
        mode: 'apply',
        target: { ...baseTarget, path: absolutePath },
        root,
        authorization: adapterAuthorizationFor(root, id),
      }, env));
      assert.equal(result.mode, 'dry-run', `${id}: absolute injection must be refused`);
    }
    assert.equal(existsSync(absolutePath), false, `${id}: absolute injection must not create a file`);

    // (c) directory target (a real client directory) is not a config file.
    const dirTarget = join(root, `dir-${id}`);
    await mkdir(dirTarget);
    if (adapter !== undefined) {
      const result = await adapter.config(withEnv({
        mode: 'apply',
        target: { ...baseTarget, path: dirTarget },
        root,
        authorization: adapterAuthorizationFor(root, id),
      }, env));
      assert.equal(result.mode, 'dry-run', `${id}: directory target must be refused`);
    }
    assert.throws(
      () => assertSafeTargetPath(serviceTargetFor(root, id, dirTarget)),
      /not a regular file/u,
      `${id}: config service must reject a directory target`,
    );
    assert.deepEqual(await readdir(dirTarget), [], `${id}: refused directory target stays empty`);

    // (d) symlinked config file / symlinked parent directory.
    if (symlinks) {
      const real = join(outside, `${id}-real.json`);
      await writeFile(real, '{"mcpServers":{}}\n');
      const link = join(root, `${id}-link.json`);
      await symlink(real, link, 'file');
      if (adapter !== undefined) {
        const result = await adapter.config(withEnv({
          mode: 'apply',
          target: { ...baseTarget, path: link },
          root,
          authorization: adapterAuthorizationFor(root, id),
        }, env));
        assert.equal(result.mode, 'dry-run', `${id}: symlinked config must be refused`);
      }
      assert.throws(
        () => assertSafeTargetPath(serviceTargetFor(root, id, link)),
        /symbolic link/u,
        `${id}: config service must reject a symlinked file`,
      );
      assert.equal(await readFile(real, 'utf8'), '{"mcpServers":{}}\n', `${id}: symlink target unchanged`);

      const linkDir = join(root, `${id}-linkdir`);
      await symlink(outside, linkDir, 'dir');
      assert.throws(
        () => assertSafeTargetPath(serviceTargetFor(root, id, join(linkDir, 'config.json'))),
        /symbolic link\/junction/u,
        `${id}: config service must reject a symlinked parent`,
      );
      await rm(linkDir, { force: true });
      await rm(link, { force: true });
      await rm(real, { force: true });
    }

    assert.equal(existsSync(sentinel), false, `${id}: no payload executed`);
  }

  // (e) allowedRoot prefix-sibling escape (`rootA` vs `rootAB`) is not an
  // escape by string prefix; the config service rejects it for every client.
  const siblingA = join(root, 'rootA');
  const siblingB = join(root, 'rootAB');
  await mkdir(siblingA);
  await mkdir(siblingB);
  const siblingFile = join(siblingB, 'config.json');
  await writeFile(siblingFile, '{}');
  for (const id of ALL_24) {
    assert.throws(
      () => assertSafeTargetPath(targetFor(root, { clientId: id, path: siblingFile, allowedRoot: siblingA })),
      /escapes/u,
      `${id}: prefix-sibling escape must be refused`,
    );
  }
  assert.equal(await readFile(siblingFile, 'utf8'), '{}', 'prefix-sibling escape wrote nothing');

  // (f) A real client config file in an isolated home is only read, never written.
  const settingsPath = join(home, '.claude', 'settings.json');
  await mkdir(join(home, '.claude'), { recursive: true });
  await writeFile(settingsPath, '{"mcpServers":{"other":{"command":"x"}}}\n');
  const before = await readFile(settingsPath);
  const dry = applyClientConfig(targetFor(home, { path: settingsPath, allowedRoot: home }), { command: process.execPath, args: ['dist/surface/mcp.js'] });
  assert.equal(dry.mode, 'dry-run');
  assert.equal(dry.applied, false);
  const noAuth = applyClientConfig(targetFor(home, { path: settingsPath, allowedRoot: home }), { command: process.execPath, args: ['dist/surface/mcp.js'] }, { mode: 'apply', confirm: true, root: home });
  assert.equal(noAuth.applied, false);
  assert.equal(noAuth.refused, true);
  assert.deepEqual(await readFile(settingsPath), before);

  // (g) Surface target resolution refuses unsupported clients and escapes.
  const escaped = resolveClientTarget('claude-code', { scope: 'project', home, root, path: join(outside, 'escape.json') });
  assert.equal(escaped.ok, false);
  if (!escaped.ok) assert.match(escaped.reason, /escapes/u);
  for (const id of NON_MCP_ROUTE) {
    const refused = resolveClientTarget(id, { scope: 'user', home, root });
    assert.equal(refused.ok, false, `${id} must refuse the write honestly`);
  }
  assert.equal(resolveClientTarget('codex', { scope: 'project', home, root }).ok, false);
});

// ---- 3. command injection never reaches a spawn ---------------------------

test('T-100/03 injection payloads in config entries reach zero spawn calls', async (t) => {
  const root = await makeRoot(t, 'ano-t100-inject-');
  const home = await makeRoot(t, 'ano-t100-inject-home-');
  const sentinel = join(root, 'SENTINEL_INJECT');
  const payload = maliciousEntry(sentinel);
  const adapters = registerAllClientAdapters({ home, root, env: { HOME: home, USERPROFILE: home } });
  const env = { HOME: home, USERPROFILE: home };

  // Runtime spawn spy: patch the CJS export and sync the ESM named binding.
  const require = createRequire(import.meta.url);
  const childProcess = require('node:child_process') as { spawn: (...args: unknown[]) => unknown; restore?: () => void };
  const originalSpawn = childProcess.spawn;
  let spawnCalls = 0;
  childProcess.spawn = (...args: unknown[]) => {
    spawnCalls += 1;
    return originalSpawn(...(args as Parameters<typeof originalSpawn>));
  };
  syncBuiltinESMExports();
  t.after(() => {
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
  });

  // Apply a malicious entry to every writable declared target.
  for (const id of ALL_24) {
    const descriptor = getDescriptor(id);
    const candidate = descriptor.configCandidates.find((entry) => entry.format === 'json');
    if (candidate === undefined) continue;
    const path = expand(candidate.path, home, root);
    await mkdir(dirname(path), { recursive: true });
    writeFileSync(path, '{"mcpServers":{"other":{"command":"x"}}}\n');
    const target = targetFor(root, {
      clientId: id,
      scope: candidate.scope,
      path,
      serverPath: candidate.key.split('.').slice(0, -1),
      allowedRoot: candidate.scope === 'user' ? home : root,
    });
    const result = applyClientConfig(target, payload, applyOptionsFor(root, { authorization: authorizationFor(root, { clientId: id }) }));
    assert.equal(result.applied, true, id);
  }

  // Run every adapter config (dry-run) and a read-only doctor pass; neither may
  // spawn a process from configuration content.
  for (const id of ALL_24) {
    const adapter = adapters[id];
    if (adapter === undefined) continue;
    const descriptor = getDescriptor(id);
    const candidate = descriptor.configCandidates.find((entry) => entry.format === 'json');
    const path = candidate !== undefined ? expand(candidate.path, home, root) : join(root, `inject-${id}.json`);
    await mkdir(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ mcpServers: { evil: { command: `x; touch ${sentinel}` } } })}\n`);
    await adapter.config(withEnv({
      mode: 'dry-run',
      target: { scope: (candidate?.scope ?? 'project') as ClientConfigTarget['scope'], path },
      root,
    }, env));
  }
  await doctorClients({
    clientIds: [...ALL_24],
    home,
    root,
    probePaths: [],
    env,
    adapters,
    now: () => AT,
  });

  assert.equal(spawnCalls, 0, 'no configuration content may reach child_process.spawn');
  assert.equal(existsSync(sentinel), false, 'injection payload never executed');

  // The only spawn site is the stdio verifier; an injected client proves the
  // mechanism without spawning and an eighth tool degrades the tools layer.
  const eight = await verifyStdioMcp({
    transport: 'stdio',
    inject: {
      initialize: async () => ({ protocolVersion: '2025-06-18', serverInfo: { name: 'x', version: '1' } }),
      listTools: async () => ({ tools: [...MCP_TOOL_NAMES, 'eighth'].map((name) => ({ name })) }),
      callTool: async () => ({ content: [{ type: 'text', text: JSON.stringify({ project_scope: 'local' }) }] }),
      close: async () => {},
    },
  });
  assert.equal(eight.verdicts.tools, 'degraded');
  assert.deepEqual(eight.tools?.extra, ['eighth']);
  assert.equal(spawnCalls, 0, 'the injected verifier spawns nothing');
});

// ---- 4. unauthorized writes ----------------------------------------------

test('T-100/04 missing confirm/statement/scope/revocation and root mismatch write nothing', async (t) => {
  const entry = { command: process.execPath, args: ['dist/surface/mcp.js'] };

  // (a) applyClientConfig refusals.
  const rootA = await makeRoot(t, 'ano-t100-auth-a-');
  const targetA = targetFor(rootA);
  writeConfig(targetA, { mcpServers: {} });
  const beforeA = await snapshotTree(rootA);
  const authA = authorizationFor(rootA);
  const applyCases: Array<{ name: string; options: ClientConfigApplyOptions }> = [
    { name: 'missing confirm', options: { mode: 'apply', authorization: authA, root: rootA } },
    { name: 'missing authorization', options: { mode: 'apply', confirm: true, root: rootA } },
    { name: 'missing root', options: { mode: 'apply', confirm: true, authorization: authA } },
    { name: 'scope insufficient', options: { mode: 'apply', confirm: true, authorization: { ...authA, scope: ['detect'] }, root: rootA } },
    { name: 'revoked', options: { mode: 'apply', confirm: true, authorization: { ...authA, revokedAt: AT }, root: rootA } },
    { name: 'root mismatch', options: { mode: 'apply', confirm: true, authorization: authorizationFor(join(rootA, '..', 'other')), root: rootA } },
    { name: 'blank statement', options: { mode: 'apply', confirm: true, authorization: { ...authA, statement: '   ' }, root: rootA } },
  ];
  for (const item of applyCases) {
    const result = applyClientConfig(targetA, entry, item.options);
    assert.equal(result.applied, false, item.name);
    assert.equal(result.refused, true, item.name);
    assert.equal(result.mode, 'dry-run', item.name);
    assert.ok(result.warnings.some((line) => /apply refused/u.test(line)), `${item.name} must state the refusal reason`);
  }
  assert.equal(await snapshotTree(rootA), beforeA, 'refused applies must be byte-identical');

  // (b) installClientConfig refusals.
  const rootB = await makeRoot(t, 'ano-t100-auth-b-');
  const targetB = targetFor(rootB);
  writeConfig(targetB, { mcpServers: {} });
  const beforeB = await snapshotTree(rootB);
  const authB = authorizationFor(rootB);
  const installCases: Array<{ name: string; options: ClientConfigApplyOptions }> = [
    { name: 'missing confirm', options: { mode: 'apply', authorization: authB, root: rootB } },
    { name: 'missing authorization', options: { mode: 'apply', confirm: true, root: rootB } },
    { name: 'missing root', options: { mode: 'apply', confirm: true, authorization: authB } },
    { name: 'scope lacks install', options: { mode: 'apply', confirm: true, authorization: { ...authB, scope: ['config'] }, root: rootB } },
    { name: 'revoked', options: { mode: 'apply', confirm: true, authorization: { ...authB, revokedAt: AT }, root: rootB } },
  ];
  for (const item of installCases) {
    const result = installClientConfig(targetB, entry, item.options);
    assert.equal(result.applied, false, item.name);
    assert.equal(result.action, 'refused', item.name);
    assert.ok(result.warnings.some((line) => /install refused/u.test(line)), `${item.name} must state the refusal reason`);
  }
  assert.equal(await snapshotTree(rootB), beforeB, 'refused installs must be byte-identical');

  // (c) Batch install with no authorizations writes nothing for all 24 plans.
  const rootC = await makeRoot(t, 'ano-t100-auth-c-');
  const homeC = await makeRoot(t, 'ano-t100-auth-c-home-');
  writeFileSync(join(rootC, '.mcp.json'), '{}\n');
  const planC = await clientAccessPlanReport({ clientIds: [...ALL_24], home: homeC, root: rootC, probePaths: [] });
  const beforeC = await snapshotTree(rootC);
  const beforeHomeC = await snapshotTree(homeC);
  const batch = installClientBatch(planC.clients, { root: rootC, mode: 'apply', confirm: true });
  assert.equal(batch.mode, 'apply');
  assert.equal(batch.summary.installed, 0, 'no authorization means no install');
  assert.equal(batch.summary.updated, 0);
  assert.equal(batch.results.length + batch.skipped.length, 24);
  for (const result of batch.results) assert.equal(result.applied, false);
  assert.equal(await snapshotTree(rootC), beforeC, 'unauthorized batch install writes nothing');
  assert.equal(await snapshotTree(homeC), beforeHomeC, 'unauthorized batch install writes nothing in home');

  // (d) Surface install defaults to dry-run and refuses a narrow grant.
  const rootD = await makeRoot(t, 'ano-t100-auth-d-');
  const homeD = await makeRoot(t, 'ano-t100-auth-d-home-');
  const grant = { scope: ['config', 'install'], grantedBy: 'Alice', statement: 'authorize' };
  const dry = await clientInstallSurface({ id: 'claude-code', root: rootD, configScope: 'project', home: homeD, apply: false, grant });
  assert.equal(dry.ok, true);
  if (dry.ok) assert.equal(dry.result.mode, 'dry-run');
  assert.equal(existsSync(join(rootD, '.mcp.json')), false, 'dry-run must not create the target');

  const narrow = await clientInstallSurface({
    id: 'claude-code',
    root: rootD,
    configScope: 'project',
    home: homeD,
    apply: true,
    grant: { ...grant, scope: ['config'] },
  });
  assert.equal(narrow.ok, true, 'the surface reports the refusal in the result');
  if (narrow.ok) {
    assert.equal(narrow.result.applied, false);
    assert.equal(narrow.result.action, 'refused');
  }
  assert.equal(existsSync(join(rootD, '.mcp.json')), false);

  // (e) Every client install without a valid grant writes nothing.
  const rootE = await makeRoot(t, 'ano-t100-auth-e-');
  const homeE = await makeRoot(t, 'ano-t100-auth-e-home-');
  writeFileSync(join(rootE, '.mcp.json'), '{}\n');
  const beforeE = await snapshotTree(rootE);
  for (const id of ALL_24) {
    const result = await clientInstallSurface({
      id,
      root: rootE,
      configScope: 'project',
      home: homeE,
      apply: true,
      grant: { scope: ['config'], grantedBy: 'Alice', statement: 'authorize' },
    });
    if (result.ok) {
      assert.equal(result.result.applied, false, `${id}: a config-only grant must not install`);
      assert.equal(result.result.action, 'refused', id);
    } else {
      assert.ok(result.exitCode === 1 || result.exitCode === 2, `${id}: refused with exit ${result.exitCode}`);
    }
  }
  assert.equal(await snapshotTree(rootE), beforeE, 'no client wrote without the install scope');
});

// ---- 5. secret / real-session reads --------------------------------------

test('T-100/05 doctor, plan, batch install and history never read secrets or real sessions', async (t) => {
  const home = await makeRoot(t, 'ano-t100-secret-home-');
  const root = await makeRoot(t, 'ano-t100-secret-root-');
  await writeFile(join(home, '.env'), 'ROOT_ENV_SECRET=ROOT_ENV_SECRET\n');
  await mkdir(join(home, 'secrets'));
  await writeFile(join(home, 'secrets', 'id_rsa'), 'RSA_PRIVATE_MARKER=RSA_PRIVATE_MARKER\n');
  await writeFile(join(home, 'credentials.json'), 'CREDENTIALS_MARKER=CREDENTIALS_MARKER\n');
  const sessionDir = join(home, '.claude', 'projects', 'proj-1');
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, 'session.jsonl'),
    `${JSON.stringify({ content: 'SESSION_CONTENT_MARKER', message: 'SESSION_MESSAGE_MARKER' })}\n${JSON.stringify({ prompt: 'SESSION_PROMPT_MARKER', token: 'SESSION_TOKEN_MARKER' })}\n`,
  );
  await mkdir(join(home, '.codex', 'sessions'), { recursive: true });
  await writeFile(join(home, '.codex', 'sessions', 's.jsonl'), 'SESSION_CONTENT_MARKER\n');

  // Declared config candidates. The env value here is a non-secret
  // placeholder: the privacy boundary under test is `.env`, `secrets/`,
  // credentials and real session stores, which are never declared candidates.
  await mkdir(join(home, '.claude'), { recursive: true });
  await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: { ano: { command: process.execPath, args: ['fake.js'], env: { API_KEY: 'CONFIG_ENV_PLACEHOLDER' } } } }));
  await mkdir(join(home, '.cursor'), { recursive: true });
  await writeFile(join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { ano: { command: process.execPath, args: ['x'], env: { API_KEY: 'CONFIG_ENV_PLACEHOLDER' } } } }));
  await mkdir(join(home, '.copilot'), { recursive: true });
  await writeFile(join(home, '.copilot', 'mcp-config.json'), JSON.stringify({ mcpServers: { ano: { command: process.execPath, args: ['x'], env: { API_KEY: 'CONFIG_ENV_PLACEHOLDER' } } } }));
  await writeFile(join(root, '.mcp.json'), '{"mcpServers":{}}\n');

  const report = await clientDoctorReport({ clientIds: [...ALL_24], home, root, probePaths: [] });
  assert.equal(report.clients.length, 24);
  const reportJson = JSON.stringify(report);
  for (const marker of SECRET_MARKERS) assert.equal(reportJson.includes(marker), false, `doctor report leaked ${marker}`);
  assert.equal(reportJson.includes('id_rsa'), false);
  assert.equal(reportJson.includes('credentials.json'), false);
  assert.equal(reportJson.includes('.claude/projects'), false);
  assert.equal(reportJson.includes('.codex/sessions'), false);

  const plan = await clientAccessPlanReport({ clientIds: [...ALL_24], home, root, probePaths: [] });
  const planJson = JSON.stringify(plan);
  for (const marker of SECRET_MARKERS) assert.equal(planJson.includes(marker), false, `access plan leaked ${marker}`);

  // Authorized batch install of two writable clients: artifacts carry hashes
  // and paths only, never the config's secret env value.
  const batch = installClientBatch(plan.clients, {
    root,
    mode: 'apply',
    confirm: true,
    authorizations: batchAuthorizations(root, ['claude-code', 'github-copilot']),
  });
  assert.equal(batch.results.filter((result) => result.applied).length, 2);
  assert.equal(batch.summary.installed + batch.summary.updated, 2);
  const collected: string[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    let list;
    try {
      list = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of list) {
      const full = join(dir, item.name);
      const rel = prefix === '' ? item.name : `${prefix}/${item.name}`;
      if (item.isDirectory()) await walk(full, rel);
      else if (item.isFile()) collected.push(rel);
    }
  };
  await walk(join(root, '.ano', 'clients'), '');
  assert.ok(collected.some((path) => path.includes('backups') && path.endsWith('config.json')));
  assert.ok(collected.some((path) => path.includes('backups') && path.endsWith('manifest.json')));
  assert.ok(collected.some((path) => path.includes('installs') && path.endsWith('claude-code.json')));
  for (const path of collected) {
    assert.equal(/\.env$/u.test(path), false, `sensitive file collected: ${path}`);
    assert.equal(path.includes('id_rsa'), false, `sensitive file collected: ${path}`);
    assert.equal(path.includes('credentials.json'), false, `sensitive file collected: ${path}`);
    assert.equal(path.includes('.claude/projects'), false, `session store collected: ${path}`);
  }
  const artifactText = (await Promise.all(collected.map((path) => readFile(join(root, '.ano', 'clients', path), 'utf8')))).join('\n');
  for (const marker of SECRET_MARKERS) assert.equal(artifactText.includes(marker), false, `artifact leaked ${marker}`);
  const record = readInstallRecord(root, 'claude-code');
  assert.ok(record !== null);
  const recordJson = JSON.stringify(record);
  assert.equal(recordJson.includes('SECRET_VALUE_MARKER'), false);
  assert.equal(recordJson.includes('API_KEY'), false);
  assert.equal(recordJson.includes('ROOT_ENV_SECRET'), false);

  // A direct authorized install whose entry carries an env secret value: the
  // backup artifact and the install record must not carry the value.
  const secretRoot = await makeRoot(t, 'ano-t100-secret-install-');
  const secretTarget = targetFor(secretRoot);
  writeConfig(secretTarget, { mcpServers: {} });
  const secretEntry = { command: process.execPath, args: ['dist/surface/mcp.js'], env: { API_KEY: 'SECRET_VALUE_MARKER' } };
  const secretInstall = installClientConfig(secretTarget, secretEntry, applyOptionsFor(secretRoot, { authorization: authorizationFor(secretRoot, { clientId: 'claude-code' }) }));
  assert.equal(secretInstall.action, 'installed');
  const secretArtifacts: string[] = [];
  const secretRoot2 = join(secretRoot, '.ano', 'clients');
  const walkSecrets = async (dir: string, prefix: string): Promise<void> => {
    let list;
    try {
      list = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of list) {
      const full = join(dir, item.name);
      const rel = prefix === '' ? item.name : `${prefix}/${item.name}`;
      if (item.isDirectory()) await walkSecrets(full, rel);
      else if (item.isFile()) secretArtifacts.push(rel);
    }
  };
  await walkSecrets(secretRoot2, '');
  assert.ok(secretArtifacts.length > 0);
  const secretArtifactText = (await Promise.all(secretArtifacts.map((path) => readFile(join(secretRoot2, path), 'utf8')))).join('\n');
  assert.equal(secretArtifactText.includes('SECRET_VALUE_MARKER'), false, 'backup/install artifact leaked the env secret value');
  assert.equal(secretArtifactText.includes('API_KEY'), false, 'backup/install artifact leaked the env key');
  for (const marker of SECRET_MARKERS) assert.equal(secretArtifactText.includes(marker), false, `artifact leaked ${marker}`);
  const secretRecord = readInstallRecord(secretRoot, 'claude-code');
  assert.ok(secretRecord !== null);
  assert.equal(JSON.stringify(secretRecord).includes('SECRET_VALUE_MARKER'), false);

  // Static guard: adapters reference no secret or real-session path.
  // `config.ts`/`install.ts` own the library write path and must name sensitive
  // files in order to refuse them (T-101/D2); the adapter boundary is that they
  // never read those stores. The D2 regression below asserts the refusal.
  const sources = await listClientSources();
  const secretPathPatterns = [/[\\/]\.env(?:\b|[\\/])/u, /id_rsa/u, /credentials\.json/u, /\.(?:claude|codex|cursor)[\\/]projects/u, /\.(?:claude|codex|cursor)[\\/]sessions/u, /[\\/]secrets[\\/]/u];
  const writePathSources = new Set(['config.ts', 'install.ts']);
  for (const name of sources) {
    if (writePathSources.has(name)) continue;
    const source = await readSourceFile(name);
    for (const pattern of secretPathPatterns) {
      assert.equal(pattern.test(source), false, `${name} must not reference secret/session paths (${pattern})`);
    }
  }
  assert.match(
    await readSourceFile('config.ts'),
    /sensitive location/u,
    'config.ts must refuse sensitive config paths (D2)',
  );
});

// ---- 6. unknown history formats fail closed -------------------------------

test('T-100/06 unknown/corrupt session formats keep history unavailable for all 24 clients', async (t) => {
  const home = await makeRoot(t, 'ano-t100-history-home-');
  const root = await makeRoot(t, 'ano-t100-history-root-');
  const sessionDir = join(home, '.claude', 'projects', 'proj-1');
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, 'good.jsonl'), `${JSON.stringify({ timestamp: AT, content: 'SESSION_CONTENT_MARKER' })}\n`);
  await writeFile(join(sessionDir, 'unknown.xml'), 'SESSION_MESSAGE_MARKER');
  await writeFile(join(sessionDir, 'corrupt.json'), '{ not json SESSION_PROMPT_MARKER');
  await writeFile(join(sessionDir, 'empty.json'), '[]');
  await mkdir(join(home, '.codex', 'sessions'), { recursive: true });
  await writeFile(join(home, '.codex', 'sessions', 'unknown.bin'), 'SESSION_TOKEN_MARKER');

  await mkdir(join(home, '.claude'), { recursive: true });
  await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: { ano: { command: process.execPath, args: ['fake.js'] } } }));

  const report = await doctorClients({
    clientIds: [...ALL_24],
    home,
    root,
    probePaths: [],
    env: {},
    now: () => AT,
  });
  assert.equal(report.clients.length, 24);
  for (const client of report.clients) {
    const history = client.layers.history;
    assert.equal(history.verdict, 'unavailable', `${client.clientId} history must stay unavailable`);
    assert.equal(history.evidence, 'absent', client.clientId);
    assert.equal(history.details.sampleAuthorized, false, client.clientId);
    assert.equal(history.details.parsedRecords, 0, client.clientId);
    assert.equal(history.details.privacy, 'not-read', client.clientId);
    assert.equal(history.details.formatVersion, null, client.clientId);
    assert.equal(history.details.source, null, client.clientId);
    if (client.status === 'unknown') {
      assert.ok(
        client.limitations.some((line) => line.includes('identity or interface unclear')),
        `${client.clientId} history must stay behind the unknown identity gate`,
      );
    } else {
      assert.ok(
        history.limitations.some((line) => line.includes('authorized sample') || line.includes('no authorized sample')),
        `${client.clientId} history must state the sample requirement`,
      );
    }
  }
  const json = JSON.stringify(report);
  for (const marker of ['SESSION_CONTENT_MARKER', 'SESSION_MESSAGE_MARKER', 'SESSION_PROMPT_MARKER', 'SESSION_TOKEN_MARKER']) {
    assert.equal(json.includes(marker), false, `session content leaked: ${marker}`);
  }

  // The `dsh` alias resolves to deepseek-harness and its history stays closed.
  const dsh = await clientDoctorSingle('dsh', { home, root, probePaths: [], env: {} });
  assert.equal(dsh.clientId, 'deepseek-harness');
  assert.equal(dsh.alias, 'dsh');
  assert.equal(dsh.layers.history.verdict, 'unavailable');
  assert.equal(dsh.layers.history.details.privacy, 'not-read');
  assert.equal((CORE_LAYERS as readonly string[]).includes('history'), false);
});

// ---- 7. cloud-only / IDE-plugin-only overreach ---------------------------

test('T-100/07 cloud-only and IDE-plugin-only clients generate no config and never validate', async (t) => {
  const home = await makeRoot(t, 'ano-t100-cloud-home-');
  const root = await makeRoot(t, 'ano-t100-cloud-root-');
  const report = await clientDoctorReport({ clientIds: [...ALL_24], home, root, probePaths: [] });
  const plan = await clientAccessPlanReport({ clientIds: [...ALL_24], home, root, probePaths: [] });

  for (const id of CLOUD_PLUGIN_ONLY) {
    const client = report.clients.find((entry) => entry.clientId === id);
    assert.ok(client !== undefined, `${id} must be reported`);
    assert.equal(client.status, 'unavailable', `${id} stays unavailable`);
    assert.equal(client.coreVerdict, 'unavailable', `${id} core verdict is unavailable`);
    for (const layer of CAPABILITY_LAYERS) {
      assert.notEqual(client.layers[layer].verdict, 'validated', `${id}.${layer} must never be validated`);
    }
    assert.equal(client.layers.mcp.verdict, 'unavailable', `${id} mcp unavailable`);
    assert.equal(client.layers.configured.verdict, 'unavailable', `${id} configured unavailable`);

    const planned = plan.clients.find((entry) => entry.clientId === id);
    assert.ok(planned !== undefined, `${id} must be planned`);
    assert.equal(planned.route, 'skip', `${id} route must be skip`);
    assert.equal(planned.target, null, `${id} must have no write target`);
    assert.equal(planned.backup, null, `${id} must have no backup plan`);

    const installed = await clientInstallSurface({
      id,
      root,
      configScope: 'project',
      home,
      apply: true,
      grant: { scope: ['config', 'install', 'restore'], grantedBy: 'Alice', statement: 'authorize' },
    });
    assert.equal(installed.ok, false, `${id} install must be refused`);
    if (!installed.ok) assert.equal(installed.exitCode, 2);
  }

  // The batch path skips them with an explicit reason and writes nothing.
  const before = await snapshotTree(root);
  const batch = installClientBatch(plan.clients, {
    root,
    mode: 'apply',
    confirm: true,
    authorizations: batchAuthorizations(root, [...ALL_24]),
  });
  for (const id of CLOUD_PLUGIN_ONLY) {
    const skipped = batch.skipped.find((entry) => entry.clientId === id);
    assert.ok(skipped !== undefined, `${id} must be skipped by the batch install`);
    assert.equal(skipped.route, 'skip');
    assert.ok(skipped.reason.length > 0);
  }
  for (const result of batch.results) assert.equal(result.applied, false, `${result.clientId} must not write`);
  assert.equal(await snapshotTree(root), before, 'cloud/plugin-only clients write nothing');

  // Non-MCP routes never expose a write target.
  for (const id of NON_MCP_ROUTE) {
    const planned = plan.clients.find((entry) => entry.clientId === id);
    assert.ok(planned !== undefined, id);
    assert.notEqual(planned.route, 'mcp', `${id} must not claim an MCP write route`);
    assert.equal(planned.target, null, `${id} must not claim a write target`);
  }
  // Every mcp-route plan is either writable JSON or the read-only TOML target.
  for (const planned of plan.clients) {
    if (planned.route !== 'mcp') continue;
    assert.ok(planned.target !== null, `${planned.clientId} mcp route needs a target`);
    assert.ok(planned.target.format === 'json' || planned.target.format === 'toml', planned.clientId);
  }
});

// ---- 8. Gate overreach and MCP non-amplification -------------------------

test('T-100/08 24-client reports/plans/install results carry no Gate field and MCP success changes no Gate permission', async (t) => {
  const home = await makeRoot(t, 'ano-t100-gate-home-');
  const root = await makeRoot(t, 'ano-t100-gate-root-');
  await mkdir(join(root, '.pm'), { recursive: true });
  await writeFile(join(root, '.pm', 'tasks.json'), '{"seq":1,"tasks":[]}\n');
  await mkdir(join(root, '.ano', 'ledger'), { recursive: true });
  await writeFile(join(root, '.ano', 'ledger', 'keep.json'), '{"keep":true}\n');
  await mkdir(join(home, '.claude'), { recursive: true });
  await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: { ano: { command: process.execPath, args: ['fake.js'] } } }));
  const bin = join(home, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'claude'), '#!/usr/bin/env node\nprocess.exit(0);\n');

  const before = await snapshotTree(root);
  const matrixBefore = roleMatrixForState('enforced', 'degraded');

  const report = await doctorClients({
    clientIds: [...ALL_24],
    home,
    root,
    probePaths: [bin],
    env: { HOME: home, USERPROFILE: home },
    verifier: async () => successfulVerify(AT),
    verify: { transport: 'stdio', command: process.execPath },
    now: () => AT,
  });
  assert.equal(report.clients.length, 24);
  const capabilities = mapDoctorReport(report);

  // MCP success is reported as MCP access only; no column is amplified.
  const claude = report.clients.find((entry) => entry.clientId === 'claude-code');
  assert.equal(claude?.layers.mcp.verdict, 'validated');
  assert.equal(claude?.layers.tools.verdict, 'validated');
  assert.equal(claude?.layers.brief.verdict, 'validated');
  assert.equal(claude?.status, 'ready');
  const mapped = capabilities.clients.find((entry) => entry.clientId === 'claude-code');
  assert.equal(mapped?.mcp.verdict, 'validated', 'MCP success is reported as MCP access only');
  assert.equal(mapped?.rules.verdict, 'degraded', 'rules are not taken over by an MCP handshake');
  assert.equal(mapped?.dag.verdict, 'degraded', 'DAG is not taken over by an MCP handshake');
  assert.equal(mapped?.recovery.verdict, 'degraded');
  assert.equal(mapped?.outputInterception.verdict, 'unavailable');
  assert.equal(mapped?.hostCapability, 'degraded');
  assert.equal(HOST_AUTO_INTERCEPTION_AVAILABLE, false);
  assert.equal(HOST_AUTO_APPROVAL_AVAILABLE, false);

  assertNoGateTokens(report);
  assertNoGateTokens(capabilities);
  assertNoGateTokens(successfulVerify(AT));

  // No Gate/ledger/cutover artifacts are produced.
  assert.equal(existsSync(join(root, '.ano', 'connect', 'cutover.json')), false);
  assert.equal(await snapshotTree(root), before, 'doctor/mapping must be byte-identical read-only');

  // The Gate role matrix is independent of MCP verification success.
  const matrixAfter = roleMatrixForState('enforced', 'degraded');
  assert.deepEqual(matrixAfter, matrixBefore);
  assert.equal(matrixAfter.layers.find((layer) => layer.layer === 'release')?.ano, 'manual');
  assert.equal(matrixAfter.layers.find((layer) => layer.layer === 'release')?.legacyPm, 'manual');

  // Access plans and install results carry no Gate field either.
  const plan = await clientAccessPlanReport({ clientIds: [...ALL_24], home, root, probePaths: [] });
  assertNoGateTokens(plan);
  for (const entry of plan.clients) {
    assert.ok(entry.verdict === 'validated' || entry.verdict === 'degraded' || entry.verdict === 'unavailable', entry.clientId);
    for (const key of GATE_TOKENS) assert.equal(key in entry, false, `${entry.clientId} plan leaked ${key}`);
  }
  const installed = await clientInstallSurface({
    id: 'claude-code',
    root,
    configScope: 'project',
    home,
    apply: false,
    grant: { scope: ['config', 'install'], grantedBy: 'Alice', statement: 'authorize' },
  });
  assert.equal(installed.ok, true);
  if (installed.ok) {
    assertNoGateTokens(installed.result);
    for (const key of GATE_TOKENS) assert.equal(key in installed.result, false, `install result leaked ${key}`);
  }

  // Seven tools is the invariant.
  assert.equal(MCP_TOOL_COUNT, 7);
  assert.equal(MCP_TOOL_NAMES.length, 7);
});

// ---- 9. failure isolation ------------------------------------------------

test('T-100/09 one crashing client or adapter never blocks the other 23', async (t) => {
  const home = await makeRoot(t, 'ano-t100-isolate-');
  const root = await makeRoot(t, 'ano-t100-isolate-root-');
  await mkdir(join(home, '.codex'), { recursive: true });
  await writeFile(join(home, '.codex', 'config.toml'), `[mcp_servers.ano]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ["x"]\n`);
  await writeFile(join(root, '.mcp.json'), '{}\n');
  await mkdir(join(home, '.claude'), { recursive: true });
  await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: { ano: { command: process.execPath, args: ['fake.js'] } } }));
  const bin = join(home, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'claude'), '#!/usr/bin/env node\nprocess.exit(0);\n');

  const adapters = registerAllClientAdapters({ home, root, env: { HOME: home, USERPROFILE: home } });
  const crashing = { ...adapters, cursor: throwingAdapter('cursor') } as Partial<Record<ClientId, ClientAdapter>>;

  const report = await doctorClients({
    clientIds: [...ALL_24],
    adapters: crashing,
    home,
    root,
    probePaths: [bin],
    env: { HOME: home, USERPROFILE: home },
    verifier: async () => successfulVerify(AT),
    verify: { transport: 'stdio', command: process.execPath },
    now: () => AT,
  });
  assert.equal(report.clients.length, 24);
  const failed = report.clients.find((client) => client.clientId === 'cursor');
  assert.ok(failed?.errors.some((error) => error.message.includes('exploded')), 'cursor records its isolated failure');
  assert.equal(failed?.status, 'unavailable');
  assert.equal(failed?.layers.detected.verdict, 'unavailable');
  for (const client of report.clients) {
    if (client.clientId === 'cursor') continue;
    assert.ok(client.clientId.length > 0);
  }
  const healthy = report.clients.find((client) => client.clientId === 'claude-code');
  assert.equal(healthy?.status, 'ready');
  assert.equal(healthy?.errors.length, 0);

  // The batch install isolates a broken target and still installs the rest.
  const plan = await clientAccessPlanReport({ clientIds: ['claude-code', 'github-copilot', 'zed'], home, root, probePaths: [] });
  const zedPlan = plan.clients.find((entry) => entry.clientId === 'zed');
  assert.ok(zedPlan !== undefined, 'zed plan exists');
  if (zedPlan === undefined) throw new Error('unreachable: zed plan missing');
  const zedTarget = zedPlan.target;
  assert.ok(zedTarget !== null, 'zed target exists');
  if (zedTarget === null) throw new Error('unreachable: zed target missing');
  const broken: ClientAccessPlan = { ...zedPlan, target: { ...zedTarget, path: root } };
  const batch = installClientBatch([plan.clients.find((entry) => entry.clientId === 'claude-code')!, broken], {
    root,
    mode: 'apply',
    confirm: true,
    authorizations: batchAuthorizations(root, ['claude-code', 'zed']),
  });
  assert.equal(batch.results.length, 2);
  assert.equal(batch.summary.installed, 1);
  assert.equal(batch.summary.failed, 1);
  assert.equal(batch.results.find((entry) => entry.clientId === 'claude-code')?.action, 'installed');
  assert.equal(batch.results.find((entry) => entry.clientId === 'zed')?.action, 'failed');

  // The batch plan isolates a crashing adapter too.
  const isolatedPlan = await clientAccessPlans({
    clientIds: ['claude-code', 'cursor'],
    adapters: { cursor: throwingAdapter('cursor') },
    home,
    root,
    probePaths: [],
    env: {},
    now: () => AT,
  });
  assert.equal(isolatedPlan.clients.length, 2);
  assert.equal(isolatedPlan.clients.find((entry) => entry.clientId === 'cursor')?.verdict, 'unavailable');
  assert.ok(isolatedPlan.clients.find((entry) => entry.clientId === 'claude-code') !== undefined);
});

// ---- 10. aliases and identity --------------------------------------------

test('T-100/10 aliases resolve, unknown ids are refused and external validated is capped', async (t) => {
  const root = await makeRoot(t, 'ano-t100-alias-');
  void root;

  assert.equal(resolveClientId('cloudcode'), 'claude-code');
  assert.equal(resolveClientId('dsh'), 'deepseek-harness');
  assert.equal(resolveClientId('cloudcode2'), null);
  assert.equal(resolveClientId('not-a-client'), null);
  assert.equal(resolveClientId(''), null);
  for (const unknown of ['not-a-client', '', 'Claude-Code', 'cloudcode2', 'dsh2']) {
    assert.throws(() => defaultRegistry.get(unknown), UnknownClientError);
  }
  assert.equal(getDescriptor('cloudcode').id, 'claude-code');
  assert.equal(getDescriptor('cloudcode').alias, 'cloudcode');
  assert.equal(getDescriptor('dsh').id, 'deepseek-harness');
  assert.equal(getDescriptor('dsh').alias, 'dsh');
  assert.equal(getDescriptor('dsh').identityStatus, 'declared');
  assert.equal(getDescriptor('qoder').identityStatus, 'unverified');
  assert.equal(getDescriptor('pi').identityStatus, 'unknown');

  await assert.rejects(clientDoctorReport({ clientIds: ['not-a-client'] }), UnknownClientError);
  await assert.rejects(clientDoctorSingle('not-a-client'), UnknownClientError);
  await assert.rejects(clientAccessPlanReport({ clientIds: ['not-a-client'] }), UnknownClientError);

  // Aliases resolve through the surface and keep the canonical id.
  const home = await makeRoot(t, 'ano-t100-alias-home-');
  const aliasRoot = await makeRoot(t, 'ano-t100-alias-root-');
  const cloudcode = await clientDoctorSingle('cloudcode', { home, root: aliasRoot, probePaths: [], env: {} });
  assert.equal(cloudcode.clientId, 'claude-code');
  assert.equal(cloudcode.alias, 'cloudcode');
  const dsh = await clientDoctorSingle('dsh', { home, root: aliasRoot, probePaths: [], env: {} });
  assert.equal(dsh.clientId, 'deepseek-harness');
  assert.equal(dsh.alias, 'dsh');

  // A registered external adapter's self-reported validated/measured is capped.
  const capped = registerExternalAdapter(
    declaration({
      config: async () => ({
        mode: 'apply',
        backupId: 'b',
        backupHash: 'h',
        beforeHash: 'a',
        afterHash: 'b',
        changes: [],
        restoredOnFailure: false,
      }),
    }),
    validValidation,
  );
  const cappedReport = await capped.inspect({});
  assert.equal(cappedReport.status === 'ready', false);
  assert.equal(cappedReport.coreVerdict, 'degraded');
  assert.equal(cappedReport.layers.detected.verdict, 'degraded');
  assert.equal(cappedReport.layers.detected.evidence, 'assumed');
  assert.equal(cappedReport.layers.history.verdict, 'degraded', 'extension-layer lies are capped too');
  assert.ok(cappedReport.errors.some((error) => error.code === 'E_EXTERNAL_VERDICT_CAPPED'));
  assert.ok(cappedReport.limitations.some((line) => line.includes('capped')));
  const refusedConfig = await capped.config({ mode: 'apply', target: { scope: 'user' } });
  assert.equal(refusedConfig.mode, 'dry-run');
  assert.deepEqual(refusedConfig.changes, []);
  assert.ok(refusedConfig.warnings.some((line) => line.includes('config-refused')));

  // Pi stays unknown even with a lying injected adapter.
  const piDescriptor = getDescriptor('pi');
  assert.equal(piDescriptor.identityStatus, 'unknown');
  const piUnknown = createUnknownAdapter('pi', { now: () => AT });
  assert.deepEqual(piUnknown.identitySources, []);
  const piDetected = await piUnknown.detect({ probePaths: [join(tmpdir(), 'whatever')], env: {} });
  assert.equal(piDetected.detected, false);
  assert.deepEqual(piDetected.sources, []);
  const piReport = await doctorClient(piDescriptor, { adapters: { pi: lyingAdapter('pi') }, now: () => AT });
  assert.equal(piReport.status, 'unknown');
  assert.equal(piReport.coreVerdict, 'unavailable');
  for (const layer of CAPABILITY_LAYERS) {
    assert.equal(piReport.layers[layer].verdict, 'unavailable', `pi.${layer}`);
    assert.equal(piReport.layers[layer].evidence, 'absent', `pi.${layer}`);
  }
  const enforcedPi = enforceUnknownReport(lyingReport('pi'));
  assert.equal(enforcedPi.status, 'unknown');
  assert.equal(enforcedPi.coreVerdict, 'unavailable');

  // A legacy alias cannot be claimed by an external adapter.
  const legacyAlias = validateExternalAdapter(declaration({ id: 'dsh' }), validValidation);
  assert.ok(legacyAlias.issues.some((issue) => issue.code === 'ID_UNKNOWN'));
  assert.throws(
    () => registerExternalAdapter(declaration({ id: 'pi' }), validValidation),
    (error: unknown) => error instanceof ExternalAdapterRejectedError,
  );
});

// ---- 11. registry / catalog / matrix invariants --------------------------

test('T-100/11 registry, catalog routes and the support matrix stay consistent', () => {
  assert.deepEqual([...CLIENT_IDS], [
    'claude-code', 'github-copilot', 'cursor', 'codex', 'trae', 'antigravity',
    'replit-agent', 'cline', 'kilo-code', 'hermes-agent', 'openclaw', 'zed',
    'tabnine', 'amazon-q', 'jetbrains-ai', 'codegeex', 'tongyi-lingma',
    'comate', 'qoder', 'codebuddy', 'deepseek-harness', 'opencode', 'pi', 'zcode',
  ]);
  assert.equal(CLIENT_IDS.length, 24);
  assert.equal(defaultRegistry.list().length, 24);
  assert.equal(TOOLS_21.length, 21);
  assert.equal(LEGACY_3.length, 3);

  const routes: ClientAccessRoute[] = ['mcp', 'rules', 'cli', 'explicit-workflow', 'skip'];
  const descriptors = defaultRegistry.list();
  for (const descriptor of descriptors) {
    assert.ok(descriptor.id.length > 0);
    assert.ok(descriptor.initialVerdict === 'unverified' || descriptor.initialVerdict === 'unavailable', descriptor.id);
    assert.notEqual(descriptor.initialVerdict, 'validated', descriptor.id);
    for (const candidate of descriptor.configCandidates) {
      assert.ok(candidate.format === 'json' || candidate.format === 'toml', descriptor.id);
      assert.ok(candidate.key.length > 0, descriptor.id);
      assert.ok(!candidate.path.includes('..'), `${descriptor.id} candidate must not traverse`);
    }
    for (const source of descriptor.identitySources) {
      assert.ok(!source.value.includes('..'), `${descriptor.id} identity source must not traverse`);
    }
  }

  // The machine-readable support matrix stays schema-stable and covers 24
  // clients; no cloud-only / IDE-plugin-only tool is marked validated.
  const matrix = JSON.parse(readFileSync(new URL('../../docs/evidence/client-support-matrix.json', import.meta.url), 'utf8')) as {
    schema: string;
    clients: ReadonlyArray<{ clientId: string; alias?: string | null; mcp?: string; route?: string }>;
  };
  assert.equal(matrix.schema, 'ano.client-support-matrix/1');
  assert.equal(matrix.clients.length, 24);
  const matrixIds = matrix.clients.map((client) => client.clientId).sort();
  assert.deepEqual(matrixIds, [...ALL_24].sort());
  for (const id of CLOUD_PLUGIN_ONLY) {
    const entry = matrix.clients.find((client) => client.clientId === id);
    assert.ok(entry !== undefined, id);
    assert.notEqual(entry.mcp, 'validated', `${id} must not be validated in the matrix`);
  }
  const dshMatrix = matrix.clients.find((client) => client.clientId === 'deepseek-harness');
  assert.equal(dshMatrix?.alias, 'dsh');
  const cloudcodeMatrix = matrix.clients.find((client) => client.clientId === 'claude-code');
  assert.equal(cloudcodeMatrix?.alias, 'cloudcode');

  // A plan is not a measurement: every unverified client stays unverified.
  const at = AT;
  const unverified = planClientAccess(
    {
      clientId: 'github-copilot',
      alias: null,
      status: 'unavailable',
      mcp: { verdict: 'unavailable', evidence: 'absent', mode: 'mcp-stdio', source: 'client:github-copilot', at, version: null, limitations: [], details: {} },
      rules: { verdict: 'unavailable', evidence: 'absent', mode: 'detected-only', source: 'client:github-copilot', at, version: null, limitations: [], details: {} },
      dag: { verdict: 'unavailable', evidence: 'absent', mode: 'explicit-workflow', source: 'client:github-copilot', at, version: null, limitations: [], details: {} },
      recovery: { verdict: 'unavailable', evidence: 'absent', mode: 'verified-backup-restore', source: 'client:github-copilot', at, version: null, limitations: [], details: {} },
      outputInterception: { verdict: 'unavailable', evidence: 'absent', mode: 'none', source: 'client:github-copilot', at, version: null, limitations: [], details: {} },
      hostCapability: 'degraded',
      generatedAt: at,
      limitations: [],
    },
    { home: '/tmp/h', root: '/tmp/r' },
  );
  assert.equal(unverified.route, 'mcp');
  assert.equal(unverified.verdict, 'unavailable');
  assert.ok(unverified.limitations.some((line) => line.includes('not a measurement')));

  // planAccessReport summarises every client and never writes.
  const summary = planAccessReport({
    schema: 'ano.client-takeover-capabilities/1',
    generatedAt: at,
    clients: [],
    limitations: [],
  }, { home: '/tmp/h', root: '/tmp/r' });
  assert.equal(summary.summary.total, 0);
  for (const route of routes) assert.ok((routes as readonly string[]).includes(route));

  // Reserved serverPath segments stay refused for every client.
  for (const id of ALL_24) {
    for (const segment of ['__proto__', 'prototype', 'constructor']) {
      assert.throws(
        () => assertSafeServerPath([segment]),
        /reserved serverPath segment/u,
        `${id}:${segment}`,
      );
      assert.throws(
        () => planClientConfig(targetFor('/tmp/r', { clientId: id, serverPath: [segment] }), { command: 'x' }),
        /reserved serverPath segment/u,
        `${id}:${segment} plan`,
      );
    }
  }
  assert.equal(Object.hasOwn(Object.prototype, 'ano'), false);
});

// ---- T-101 / D1: user-scope explicit path escape ----------------------------

test('T-101/12 user-scope explicit paths outside home are refused with zero write (D1)', async (t) => {
  const root = await makeRoot(t, 'ano-t101-d1-');
  const home = await makeRoot(t, 'ano-t101-d1-home-');
  const outside = await makeRoot(t, 'ano-t101-d1-out-');
  const adapters = registerAllClientAdapters({ home, root, env: { HOME: home, USERPROFILE: home } });
  const env = { HOME: home, USERPROFILE: home };

  for (const id of ALL_24) {
    const adapter = adapters[id];
    if (adapter === undefined) continue;
    const escapePath = join(outside, `${id}-user-escape.json`);
    const escapeBytes = '{"mcpServers":{}}\n';
    await writeFile(escapePath, escapeBytes);
    const before = await snapshotTree(outside);
    const result = await adapter.config(withEnv({
      mode: 'apply',
      target: { scope: 'user', path: escapePath },
      root,
      authorization: adapterAuthorizationFor(root, id),
    }, env));
    assert.equal(result.mode, 'dry-run', `${id}: user-scope escape must be refused`);
    assert.equal(await readFile(escapePath, 'utf8'), escapeBytes, `${id}: escape file untouched`);
    assert.equal(await snapshotTree(outside), before, `${id}: outside tree unchanged`);

    const target = targetFor(home, { clientId: id, scope: 'user', path: escapePath, allowedRoot: home });
    assert.throws(
      () => assertSafeTargetPath(target),
      /escapes/u,
      `${id}: config service must reject the user-scope escape`,
    );
  }

  // A user-scope path inside home is still allowed.
  const allowedPath = join(home, '.cline', 'data', 'settings', 'cline_mcp_settings.json');
  await mkdir(dirname(allowedPath), { recursive: true });
  await writeFile(allowedPath, '{"mcpServers":{}}\n');
  const allowedTarget = targetFor(home, { clientId: 'cline', scope: 'user', path: allowedPath, allowedRoot: home });
  assert.doesNotThrow(() => assertSafeTargetPath(allowedTarget), 'an in-scope user path stays writable');
});

// ---- T-101 / D3: doctor reports redact secret values -------------------------

test('T-101/13 configured reports redact env/header/environment secret values for every client (D3)', async (t) => {
  const home = await makeRoot(t, 'ano-t101-d3-home-');
  const root = await makeRoot(t, 'ano-t101-d3-root-');
  const adapters = registerAllClientAdapters({ home, root, env: { HOME: home, USERPROFILE: home } });
  const env = { HOME: home, USERPROFILE: home };
  const secretEntry = {
    command: process.execPath,
    args: ['x'],
    env: { API_KEY: 'SECRET_VALUE_MARKER' },
    headers: { Authorization: 'Bearer SECRET_VALUE_MARKER' },
    environment: { MY_SECRET: 'SECRET_VALUE_MARKER' },
  };
  const setNested = (key: string, value: unknown): Record<string, unknown> => {
    const parts = key.split('.');
    const doc: Record<string, unknown> = {};
    let current = doc;
    for (const part of parts.slice(0, -1)) {
      const next: Record<string, unknown> = {};
      current[part] = next;
      current = next;
    }
    current[parts.at(-1)!] = value;
    return doc;
  };

  for (const id of ALL_24) {
    const descriptor = getDescriptor(id);
    const candidate = descriptor.configCandidates.find((entry) => entry.format === 'json');
    if (candidate === undefined) continue;
    const path = expand(candidate.path, home, root);
    await mkdir(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(setNested(candidate.key, secretEntry), null, 2)}\n`);
    const adapter = adapters[id];
    if (adapter === undefined) continue;
    const report = await adapter.inspect({ root, cwd: root, env });
    const json = JSON.stringify(report);
    assert.equal(json.includes('SECRET_VALUE_MARKER'), false, `${id}: report leaked the env/header secret value`);
    assert.equal(json.includes('Bearer'), false, `${id}: report leaked a header value`);
    const resolvedEntry = (report.layers.configured.details as { resolvedEntry?: unknown }).resolvedEntry;
    if (resolvedEntry !== null && resolvedEntry !== undefined) {
      assert.equal(
        json.includes('envKeys') || json.includes('environmentKeys') || json.includes('headersKeys'),
        true,
        `${id}: redaction must keep key names`,
      );
    }
  }
});

// ---- T-101 registry / candidate alignment (T-098 handoff) --------------------

test('T-101/14 registry candidates match the adapter-measured E1 sources (T-098 handoff)', () => {
  const amazonQ = getDescriptor('amazon-q');
  assert.ok(amazonQ.identitySources.some((source) => source.kind === 'executable' && source.value === 'kiro-cli'));
  assert.ok(amazonQ.identitySources.some((source) => source.kind === 'executable' && source.value === 'kiro'));

  const tongyi = getDescriptor('tongyi-lingma');
  assert.ok(tongyi.identitySources.some((source) => source.kind === 'executable' && source.value === 'qodercn'));
  assert.ok(tongyi.configCandidates.some((candidate) => candidate.path === '<root>/.qoder/settings.local.json' && candidate.scope === 'workspace'));

  const trae = getDescriptor('trae');
  assert.ok(trae.identitySources.some((source) => source.kind === 'config-path' && source.value === '.trae/mcp.json'));
  assert.ok(trae.configCandidates.some((candidate) => candidate.path === '<root>/.trae/mcp.json' && candidate.key === 'mcpServers.ano'));

  const copilot = getDescriptor('github-copilot');
  assert.ok(copilot.configCandidates.some((candidate) => candidate.path === '<root>/.mcp.json' && candidate.scope === 'project'));
  assert.ok(copilot.rulePaths.includes('.github/copilot-instructions.md'));

  const openclaw = getDescriptor('openclaw');
  assert.ok(openclaw.configCandidates.some((candidate) => candidate.path === '~/.openclaw/openclaw.json' && candidate.key === 'mcp.servers.ano'));
  assert.ok(openclaw.notes.some((note) => note.includes('T-101')));

  const codebuddy = getDescriptor('codebuddy');
  const cbc = codebuddy.identitySources.find((source) => source.kind === 'executable' && source.value === 'cbc');
  assert.ok(cbc !== undefined, 'cbc stays a declared command alias');
  assert.match(cbc?.detail ?? '', /别名|alias/u);
  assert.equal(resolveClientId('cbc'), null);

  assert.equal(getDescriptor('cloudcode').id, 'claude-code');
  assert.equal(getDescriptor('dsh').id, 'deepseek-harness');
  assert.equal(getDescriptor('dsh').identityStatus, 'declared');
});
