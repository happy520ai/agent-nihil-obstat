/**
 * T-088 / MC-10: security red team for the ADR-007 multi-client boundary.
 *
 * Scope (docs/adr/ADR-007-client-adapters.md §2 hard boundaries, §5.4/§5.6,
 * §7; docs/client-compatibility.md §4/§9):
 * forged client ids, incomplete third-party declarations, lying adapters,
 * malicious configuration paths, configuration races, command injection,
 * unauthorized writes, secret/session reads, unknown session formats, Gate
 * overreach, failure isolation and sensitive-file collection.
 *
 * Every scenario runs in a fresh `os.tmpdir()` project/home and never writes
 * the repository's own `.pm/`, `.ano/` or user-level configuration. Refusals
 * are asserted as explicit error codes/messages; zero-write claims are backed
 * by whole-tree snapshots.
 *
 * Former finding F-01 (fixed in T-089): a caller that could supply
 * `serverPath: ['__proto__']` directly to `planClientConfig` /
 * `applyClientConfig` polluted `Object.prototype` (library-level hardening gap;
 * production adapters and `resolveClientTarget` only ever pass fixed safe
 * constants). `src/clients/config.ts` now refuses reserved segments and navigates
 * with `Object.hasOwn` + `Object.create(null)`; the regression is T-089/01 below.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
  type ClientId,
  type ClientReport,
  type ClientVerdict,
  type DetectResult,
  type VerifyResult,
} from '../../src/clients/types.ts';
import { defaultRegistry, getDescriptor, resolveClientId, UnknownClientError } from '../../src/clients/registry.ts';
import { discoverClientConfig, doctorClient, doctorClients, unavailableLayerReports, verifyStdioMcp } from '../../src/clients/doctor.ts';
import {
  applyClientConfig,
  assertSafeServerPath,
  assertSafeTargetPath,
  discoverClientConfig as discoverClientConfigTargets,
  planClientConfig,
  restoreClientConfig,
  verifyClientConfigBackup,
  type ClientConfigApplyOptions,
  type ClientConfigAuthorization,
  type ClientConfigHooks,
  type ClientConfigTarget,
} from '../../src/clients/config.ts';
import { installClientConfig, readInstallRecord, type ClientInstallResult } from '../../src/clients/install.ts';
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
  mapClientCapabilities,
  mapDoctorReport,
} from '../../src/clients/capabilities.ts';
import { CLAUDE_CODE_SERVER_PATH, createClaudeCodeAdapter } from '../../src/clients/claude-code.ts';
import { CODEX_SERVER_PATH, createCodexAdapter } from '../../src/clients/codex.ts';
import { CURSOR_SERVER_PATH } from '../../src/clients/cursor.ts';
import { OPENCODE_SERVER_PATH } from '../../src/clients/opencode.ts';
import { QODER_CONFIG_CANDIDATES, createQoderAdapter, type QoderFs } from '../../src/clients/qoder.ts';
import {
  clientDoctorReport,
  clientDoctorSingle,
  clientInstallSurface,
  clientRestoreSurface,
  resolveClientTarget,
} from '../../src/surface/service.ts';
import { roleMatrixForState } from '../../src/connect/capabilities.ts';

const AT = '2026-11-23T00:00:00.000Z';
const DESIRED: Record<string, unknown> = { command: 'node', args: ['dist/surface/mcp.js'] };
const SECRET_MARKERS = [
  'ROOT_ENV_SECRET',
  'RSA_PRIVATE_MARKER',
  'CREDENTIALS_MARKER',
  'SESSION_CONTENT_MARKER',
  'SESSION_MESSAGE_MARKER',
  'SESSION_PROMPT_MARKER',
  'SESSION_TOKEN_MARKER',
] as const;

// ---------------------------------------------------------------------------
// Compile-time Gate boundary (type-level double insurance)
// ---------------------------------------------------------------------------

type AssertKeysAbsent<T, K extends string> = { readonly [P in K]: P extends keyof T ? readonly ['unexpected key', P] : never };
const _reportGateKeys: AssertKeysAbsent<ClientReport, 'evidence_id' | 'verdict' | 'task_id' | 'approve' | 'cutover'> = {
  evidence_id: undefined as never,
  verdict: undefined as never,
  task_id: undefined as never,
  approve: undefined as never,
  cutover: undefined as never,
};
const _capabilityGateKeys: AssertKeysAbsent<ReturnType<typeof mapClientCapabilities>, 'evidence_id' | 'verdict' | 'task_id' | 'approve' | 'cutover'> = {
  evidence_id: undefined as never,
  verdict: undefined as never,
  task_id: undefined as never,
  approve: undefined as never,
  cutover: undefined as never,
};
const _verifyGateKeys: AssertKeysAbsent<VerifyResult, 'evidence_id' | 'verdict' | 'task_id' | 'approve' | 'cutover'> = {
  evidence_id: undefined as never,
  verdict: undefined as never,
  task_id: undefined as never,
  approve: undefined as never,
  cutover: undefined as never,
};
const _installGateKeys: AssertKeysAbsent<ClientInstallResult, 'evidence_id' | 'verdict' | 'task_id' | 'approve' | 'cutover'> = {
  evidence_id: undefined as never,
  verdict: undefined as never,
  task_id: undefined as never,
  approve: undefined as never,
  cutover: undefined as never,
};
void _reportGateKeys;
void _capabilityGateKeys;
void _verifyGateKeys;
void _installGateKeys;

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

async function makeRoot(t: TestContext, prefix = 'ano-t088-'): Promise<string> {
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

function writeConfig(target: ClientConfigTarget, value: unknown): void {
  writeFileSync(target.path, `${JSON.stringify(value, null, 2)}\n`);
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

function expand(path: string, home: string, root: string): string {
  let value = path;
  if (value === '~') value = home;
  else if (value.startsWith('~/')) value = `${home}/${value.slice(2)}`;
  else if (value.startsWith('~\\')) value = `${home}\\${value.slice(2)}`;
  value = value.split('<root>').join(root);
  return resolve(value);
}

class TrackingQoderFs implements QoderFs {
  readonly files = new Map<string, string>();
  readonly reads: string[] = [];

  isFile(path: string): boolean {
    return this.files.has(path);
  }

  readJson(path: string): { ok: true; value: unknown } | { ok: false; error: string } {
    this.reads.push(path);
    const content = this.files.get(path);
    if (content === undefined) return { ok: false, error: 'ENOENT' };
    try {
      return { ok: true, value: JSON.parse(content) as unknown };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

function maliciousEntry(sentinel: string): Record<string, unknown> {
  return {
    command: `node; touch ${sentinel}`,
    args: [
      `$(touch ${sentinel})`,
      `\`touch ${sentinel}\``,
      `a && touch ${sentinel}`,
      '<script>alert(1)</script>',
      'line1\nline2',
    ],
    env: { API_KEY: 'SECRET_VALUE_MARKER' },
  };
}

function assertNoGateTokens(value: unknown): void {
  const json = JSON.stringify(value);
  for (const token of ['evidence_id', 'task_id', 'approve', 'cutover']) {
    assert.equal(json.includes(token), false, `Gate token leaked: ${token}`);
  }
}

async function readSourceFile(name: string): Promise<string> {
  return readFile(new URL(`../../src/clients/${name}`, import.meta.url), 'utf8');
}

// ---- 1. forged clients ---------------------------------------------------

test('T-088/01 forged ids, incomplete third-party declarations and lying adapters are refused or capped', async (t) => {
  const root = await makeRoot(t, 'ano-t088-forge-');
  void root;

  // Unknown ids are rejected at every entry point.
  for (const unknown of ['not-a-client', '', 'Claude-Code', 'cloudcode2', 'dsh2']) {
    assert.throws(() => defaultRegistry.get(unknown), UnknownClientError);
  }
  assert.equal(resolveClientId('cloudcode'), 'claude-code');
  assert.equal(resolveClientId('cloudcode2'), null);
  await assert.rejects(doctorClients({ clientIds: ['not-a-client'] }), UnknownClientError);
  await assert.rejects(clientDoctorReport({ clientIds: ['not-a-client'] }), UnknownClientError);
  await assert.rejects(clientDoctorSingle('not-a-client'), UnknownClientError);

  // A third-party declaration must provide all four implementations.
  for (const field of ['detect', 'inspect', 'config', 'verify'] as const) {
    const broken = declaration();
    delete (broken as unknown as Record<string, unknown>)[field];
    const result = validateExternalAdapter(broken, validValidation);
    assert.equal(result.ok, false, `${field} must be required`);
    assert.ok(result.issues.some((issue) => issue.code === `${field.toUpperCase()}_MISSING`));
  }

  // Capability / evidence / validation declarations are mandatory.
  const noCapabilities = declaration();
  delete (noCapabilities as unknown as Record<string, unknown>).capabilities;
  assert.ok(validateExternalAdapter(noCapabilities, validValidation).issues.some((issue) => issue.code === 'CAPABILITIES_MISSING'));
  assert.ok(
    validateExternalAdapter(declaration({ evidence: { source: '', measured: false } }), validValidation)
      .issues.some((issue) => issue.code === 'EVIDENCE_SOURCE_MISSING'),
  );
  assert.ok(
    validateExternalAdapter(declaration({ identitySources: [] }), validValidation)
      .issues.some((issue) => issue.code === 'IDENTITY_SOURCES_MISSING'),
  );
  const measuredIncomplete = validateExternalAdapter(declaration({ evidence: { source: 'https://example.test/e', measured: true } }), validValidation);
  assert.ok(measuredIncomplete.issues.some((issue) => issue.code === 'EVIDENCE_MEASURED_AT_MISSING'));
  assert.ok(measuredIncomplete.issues.some((issue) => issue.code === 'EVIDENCE_VERSION_MISSING'));
  assert.ok(
    validateExternalAdapter(declaration(), { ...validValidation, check: () => false })
      .issues.some((issue) => issue.code === 'VALIDATION_CHECK_FAILED'),
  );

  // Identity-unknown clients cannot be claimed by an external adapter.
  const identityUnknown = validateExternalAdapter(declaration({ id: 'pi' }), validValidation);
  assert.ok(identityUnknown.issues.some((issue) => issue.code === 'ID_IDENTITY_UNKNOWN'));
  assert.throws(
    () => registerExternalAdapter(declaration({ id: 'pi' }), validValidation),
    (error: unknown) => error instanceof ExternalAdapterRejectedError
      && error.issues.some((issue) => issue.code === 'ID_IDENTITY_UNKNOWN'),
  );
  // ADR-008 §8: `dsh` is a legacy alias of deepseek-harness, not a canonical
  // ClientId, so an external adapter cannot claim it either.
  const legacyAlias = validateExternalAdapter(declaration({ id: 'dsh' }), validValidation);
  assert.ok(legacyAlias.issues.some((issue) => issue.code === 'ID_UNKNOWN'));

  // Self-reported validated/measured is capped without trusted evidence.
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

  // Pi stays unknown even with a lying injected adapter; no path is guessed.
  const piDescriptor = getDescriptor('pi');
  assert.equal(piDescriptor.identityStatus, 'unknown');
  assert.deepEqual(piDescriptor.identitySources, []);
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
  assert.ok(piReport.limitations.some((line) => line.includes('never be validated')));

  const enforcedPi = enforceUnknownReport(lyingReport('pi'));
  assert.equal(enforcedPi.status, 'unknown');
  assert.equal(enforcedPi.coreVerdict, 'unavailable');

  // ADR-008 §8: dsh is the declared deepseek-harness alias. The unknown gate no
  // longer applies, but with no local measurement it is not upgraded and no
  // layer is validated.
  const dshDescriptor = getDescriptor('dsh');
  assert.equal(dshDescriptor.id, 'deepseek-harness');
  assert.equal(dshDescriptor.alias, 'dsh');
  assert.equal(dshDescriptor.identityStatus, 'declared');
  const dshReport = await doctorClient(dshDescriptor, { probePaths: [], env: { PATH: '' }, now: () => AT });
  assert.equal(dshReport.clientId, 'deepseek-harness');
  assert.notEqual(dshReport.status, 'unknown');
  assert.notEqual(dshReport.status, 'ready');
  assert.notEqual(dshReport.coreVerdict, 'validated');
  for (const layer of CAPABILITY_LAYERS) {
    assert.notEqual(dshReport.layers[layer].verdict, 'validated', `deepseek-harness.${layer}`);
  }
});

// ---- 2. malicious configuration paths ------------------------------------

test('T-088/02 traversal, absolute injection, symlinks and directory targets are refused with zero writes', async (t) => {
  const root = await makeRoot(t, 'ano-t088-path-');
  const outside = await makeRoot(t, 'ano-t088-out-');
  const entry = { command: process.execPath, args: ['dist/surface/mcp.js'] };

  // (a) `..` escape outside the declared scope.
  const escapePath = join(outside, 'escape.json');
  await writeFile(escapePath, '{"mcpServers":{}}\n');
  const escapeTarget = targetFor(root, { path: escapePath });
  assert.throws(() => assertSafeTargetPath(escapeTarget), /escapes/u);
  assert.throws(
    () => applyClientConfig(escapeTarget, entry, applyOptionsFor(root)),
    (error: unknown) => expectError(error, 'CLIENT_CONFIG_PATH', /escapes/u),
  );
  assert.equal(await readFile(escapePath, 'utf8'), '{"mcpServers":{}}\n', 'a refused escape must not touch the outside file');

  // (b) Prefix-sibling escape (`rootA` vs `rootAB`) is not an escape by string prefix.
  const siblingA = join(root, 'rootA');
  const siblingB = join(root, 'rootAB');
  await mkdir(siblingA);
  await mkdir(siblingB);
  const siblingFile = join(siblingB, 'config.json');
  await writeFile(siblingFile, '{}');
  const siblingTarget = targetFor(root, { path: siblingFile, allowedRoot: siblingA });
  assert.throws(() => assertSafeTargetPath(siblingTarget), /escapes/u);
  assert.equal(await readFile(siblingFile, 'utf8'), '{}');

  // (c) A directory (simulated real client directory) is not a config file.
  const realClientDir = join(root, '.claude');
  await mkdir(realClientDir);
  const dirTarget = targetFor(root, { path: realClientDir });
  assert.throws(() => assertSafeTargetPath(dirTarget), /not a regular file/u);
  assert.deepEqual(await readdir(realClientDir), [], 'a refused directory target must stay empty');

  const symlinks = await canCreateSymlink(root);
  if (symlinks) {
    // (d) Symlinked config file.
    const real = join(root, 'real.json');
    await writeFile(real, '{"mcpServers":{}}\n');
    const link = join(root, 'link.json');
    await symlink(real, link, 'file');
    assert.throws(() => assertSafeTargetPath(targetFor(root, { path: link })), /symbolic link/u);
    assert.equal(await readFile(real, 'utf8'), '{"mcpServers":{}}\n');

    // (e) Symlinked parent directory.
    const linkDir = join(root, 'linkdir');
    await symlink(outside, linkDir, 'dir');
    assert.throws(
      () => assertSafeTargetPath(targetFor(root, { path: join(linkDir, 'config.json') })),
      /symbolic link\/junction/u,
    );

    // (f) Symlinked allowedRoot cannot smuggle an outside file in.
    const allowedLink = join(root, 'allowed-link');
    await symlink(outside, allowedLink, 'dir');
    const outsideAllowed = join(outside, 'allowed.json');
    await writeFile(outsideAllowed, '{}');
    assert.throws(
      () => assertSafeTargetPath(targetFor(root, { path: join(allowedLink, 'allowed.json'), allowedRoot: allowedLink })),
      /symbolic link\/junction/u,
    );
    assert.equal(await readFile(outsideAllowed, 'utf8'), '{}');
  } else {
    t.skip('platform cannot create symlinks without elevated privileges');
  }

  // Discovery reports escapes/symlinks as rejected and never follows them.
  const discovery = discoverClientConfigTargets([
    escapeTarget,
    siblingTarget,
    targetFor(root, { path: join(root, 'missing.json') }),
  ]);
  assert.equal(discovery.found, null);
  assert.equal(discovery.rejected.length, 2);
  assert.equal(discovery.missing.length, 1);

  // A real client config file in an isolated home is only read, never written.
  const home = await makeRoot(t, 'ano-t088-home-');
  const settingsPath = join(home, '.claude', 'settings.json');
  await mkdir(join(home, '.claude'));
  await writeFile(settingsPath, '{"mcpServers":{"other":{"command":"x"}}}\n');
  const settingsTarget = targetFor(home, { path: settingsPath, allowedRoot: home });
  const before = await readFile(settingsPath);
  const dry = applyClientConfig(settingsTarget, entry);
  assert.equal(dry.mode, 'dry-run');
  assert.equal(dry.applied, false);
  const noAuth = applyClientConfig(settingsTarget, entry, { mode: 'apply', confirm: true, root: home });
  assert.equal(noAuth.applied, false);
  assert.equal(noAuth.refused, true);
  assert.deepEqual(await readFile(settingsPath), before);
  assert.deepEqual((await readdir(join(home, '.claude'))).sort(), ['settings.json']);

  // Surface target resolution refuses unsupported clients and escaping paths.
  const escaped = resolveClientTarget('claude-code', { scope: 'project', home, root, path: escapePath });
  assert.equal(escaped.ok, false);
  if (!escaped.ok) assert.match(escaped.reason, /escapes/u);
  for (const id of ['qoder', 'dsh', 'pi', 'zcode'] as const) {
    const refused = resolveClientTarget(id, { scope: 'user', home, root });
    assert.equal(refused.ok, false, `${id} must refuse the write honestly`);
  }
  assert.equal(resolveClientTarget('codex', { scope: 'project', home, root }).ok, false);
});

// ---- 3. configuration races and tampered backups -------------------------

test('T-088/03 concurrent beforeHash drift and tampered backups are refused with zero writes', async (t) => {
  const entry = { command: process.execPath, args: ['dist/surface/mcp.js'] };

  // (a) apply: drift between backup and write is refused; the concurrent bytes survive.
  const rootA = await makeRoot(t, 'ano-t088-drift-a-');
  const targetA = targetFor(rootA);
  writeConfig(targetA, { mcpServers: { other: { command: 'x' } } });
  const drifted = Buffer.from('{"mcpServers":{"ano":{"command":"concurrent"}}}\n');
  const hooks: ClientConfigHooks = { afterBackup: () => writeFileSync(targetA.path, drifted) };
  assert.throws(
    () => applyClientConfig(targetA, entry, applyOptionsFor(rootA, { hooks })),
    (error: unknown) => expectError(error, 'CLIENT_CONFIG_DRIFT', /concurrently/u),
  );
  assert.deepEqual(readFileSync(targetA.path), drifted, 'the concurrent writer bytes must remain');

  // (b) install: same drift yields action=failed and writes nothing.
  const rootB = await makeRoot(t, 'ano-t088-drift-b-');
  const targetB = targetFor(rootB);
  writeConfig(targetB, { mcpServers: { other: { command: 'x' } } });
  const installHooks: ClientConfigHooks = { afterBackup: () => writeFileSync(targetB.path, drifted) };
  const install = installClientConfig(targetB, entry, applyOptionsFor(rootB, { hooks: installHooks }));
  assert.equal(install.action, 'failed');
  assert.equal(install.applied, false);
  assert.deepEqual(readFileSync(targetB.path), drifted);

  // (c) Tampered backup artifact: verification fails and restore is refused.
  const rootC = await makeRoot(t, 'ano-t088-backup-c-');
  const targetC = targetFor(rootC);
  writeConfig(targetC, { mcpServers: { other: { command: 'x' } } });
  const installedC = installClientConfig(targetC, entry, applyOptionsFor(rootC));
  assert.equal(installedC.action, 'installed');
  const backupIdC = installedC.backupId as string;
  const verifiedC = verifyClientConfigBackup(rootC, 'claude-code', backupIdC);
  assert.equal(verifiedC.ok, true);
  const configuredC = readFileSync(targetC.path);
  writeFileSync(verifiedC.path as string, 'corrupted');
  assert.equal(verifyClientConfigBackup(rootC, 'claude-code', backupIdC).ok, false);
  const restoreC = restoreClientConfig(targetC, applyOptionsFor(rootC, { backupId: backupIdC }));
  assert.equal(restoreC.applied, false);
  assert.deepEqual(readFileSync(targetC.path), configuredC, 'a refused restore must not rewrite the target');

  // (d) Tampered manifest beforeHash fails verification.
  const rootD = await makeRoot(t, 'ano-t088-backup-d-');
  const targetD = targetFor(rootD);
  writeConfig(targetD, { mcpServers: { other: { command: 'x' } } });
  const installedD = installClientConfig(targetD, entry, applyOptionsFor(rootD));
  const backupIdD = installedD.backupId as string;
  const manifestPathD = join(rootD, '.ano', 'clients', 'backups', 'claude-code', backupIdD, 'manifest.json');
  const manifestD = JSON.parse(readFileSync(manifestPathD, 'utf8')) as Record<string, unknown>;
  manifestD['beforeHash'] = '0'.repeat(64);
  writeFileSync(manifestPathD, `${JSON.stringify(manifestD, null, 2)}\n`);
  const verificationD = verifyClientConfigBackup(rootD, 'claude-code', backupIdD);
  assert.equal(verificationD.ok, false);
  assert.ok(verificationD.errors.some((line) => line.includes('hash mismatch')));

  // (e) An unknown/foreign backup id is not usable.
  const restoreE = restoreClientConfig(targetD, applyOptionsFor(rootD, { backupId: 'cfg-missing-00000000' }));
  assert.equal(restoreE.applied, false);
  assert.ok(restoreE.warnings.some((line) => line.includes('no verified backup')));

  // (f) Surface restore refuses to restore a backup into a different target.
  const rootF = await makeRoot(t, 'ano-t088-backup-f-');
  const targetF = targetFor(rootF);
  writeConfig(targetF, { mcpServers: {} });
  const installedF = installClientConfig(targetF, entry, applyOptionsFor(rootF));
  const otherPath = join(rootF, 'other.json');
  await writeFile(otherPath, '{"mcpServers":{}}\n');
  const grant = { scope: ['config', 'restore'], grantedBy: 'Alice', statement: 'authorize', grantedAt: AT };
  const mismatch = await clientRestoreSurface({
    id: 'claude-code',
    root: rootF,
    configScope: 'project',
    configPath: otherPath,
    backupId: installedF.backupId as string,
    apply: true,
    grant,
  });
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) assert.equal(mismatch.exitCode, 1);
  assert.deepEqual(readFileSync(otherPath), Buffer.from('{"mcpServers":{}}\n'));
});

// ---- 4. command injection stays inert -----------------------------------

test('T-088/04 shell metacharacters and script payloads are inert data; config content is never executed', async (t) => {
  const root = await makeRoot(t, 'ano-t088-inject-');
  const target = targetFor(root);
  writeConfig(target, { mcpServers: { other: { command: 'x' } } });
  const sentinel = join(root, 'SENTINEL_PWNED');
  const payload = maliciousEntry(sentinel);

  const result = applyClientConfig(target, payload, applyOptionsFor(root));
  assert.equal(result.applied, true);
  assert.equal(existsSync(sentinel), false, 'configuration content must never be executed');

  const text = readFileSync(target.path, 'utf8');
  assert.ok(text.includes('$(touch'), 'command substitution must be preserved as data');
  assert.ok(text.includes('`touch'), 'backticks must be preserved as data');
  assert.ok(text.includes('a && touch'), 'shell chaining must be preserved as data');
  assert.ok(text.includes('<script>'), 'script payloads must be preserved as data');
  assert.ok(text.includes('line1\\nline2'), 'newlines must be JSON-escaped, not interpreted');
  assert.ok(text.includes('SECRET_VALUE_MARKER'), 'env values stay in the document bytes');
  assert.ok(text.includes('other'), 'unrelated services are preserved');

  // The install path is equally inert.
  const root2 = await makeRoot(t, 'ano-t088-inject-install-');
  const target2 = targetFor(root2);
  writeConfig(target2, { mcpServers: {} });
  const installed = installClientConfig(target2, payload, applyOptionsFor(root2));
  assert.equal(installed.action, 'installed');
  assert.equal(existsSync(sentinel), false);
  assert.ok(readFileSync(target2.path, 'utf8').includes('<script>'));

  // Adapters treat pre-existing malicious config content as data (dry-run only).
  const maliciousConfigPath = join(root, 'malicious.json');
  const maliciousDocument = `${JSON.stringify({ mcpServers: { evil: { command: `x; touch ${sentinel}` } } })}\n`;
  await writeFile(maliciousConfigPath, maliciousDocument);
  const claude = createClaudeCodeAdapter({ home: root, root });
  const plan = await claude.config({ mode: 'dry-run', target: { scope: 'project', path: maliciousConfigPath } });
  assert.equal(plan.mode, 'dry-run');
  assert.equal(existsSync(sentinel), false);
  assert.equal(plan.changes.length, 1);
  assert.equal(plan.changes[0]?.key, 'mcpServers.ano');
  assert.deepEqual(
    await readFile(maliciousConfigPath, 'utf8'),
    maliciousDocument,
    'a dry-run plan must leave the source file byte-identical',
  );
  assert.ok(plan.changes.every((change) => change.operation !== 'remove'));

  // Static guard: the write path and adapters contain no execution primitives.
  const sources = ['config.ts', 'install.ts', 'claude-code.ts', 'codex.ts', 'cursor.ts', 'opencode.ts', 'qoder.ts', 'unknown.ts'];
  const forbidden = ['child_process', 'spawn(', 'execSync', 'spawnSync', 'eval(', 'new Function'];
  for (const name of sources) {
    const source = await readSourceFile(name);
    for (const token of forbidden) {
      assert.equal(source.includes(token), false, `${name} must not contain ${token}`);
    }
  }
  const doctorSource = await readSourceFile('doctor.ts');
  assert.match(doctorSource, /shell:\s*false/u, 'the only spawn site must disable the shell');

  // Production serverPath declarations are fixed and safe.
  for (const segment of [...CLAUDE_CODE_SERVER_PATH, ...CODEX_SERVER_PATH, ...CURSOR_SERVER_PATH, ...OPENCODE_SERVER_PATH]) {
    assert.equal(['__proto__', 'constructor', 'prototype'].includes(segment), false);
  }
});

// ---- 5. unauthorized writes ----------------------------------------------

test('T-088/05 missing confirm/statement/scope/revocation and root mismatch write nothing', async (t) => {
  const entry = { command: process.execPath, args: ['dist/surface/mcp.js'] };

  // applyClientConfig refusals.
  const rootA = await makeRoot(t, 'ano-t088-auth-a-');
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

  // installClientConfig refusals.
  const rootB = await makeRoot(t, 'ano-t088-auth-b-');
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

  // Surface install defaults to dry-run and refuses a narrow grant.
  const rootC = await makeRoot(t, 'ano-t088-auth-c-');
  const homeC = await makeRoot(t, 'ano-t088-auth-home-c-');
  const grant = { scope: ['config', 'install'], grantedBy: 'Alice', statement: 'authorize', grantedAt: AT };
  const dry = await clientInstallSurface({ id: 'claude-code', root: rootC, configScope: 'project', home: homeC, apply: false, grant });
  assert.equal(dry.ok, true);
  if (dry.ok) assert.equal(dry.result.mode, 'dry-run');
  assert.equal(existsSync(join(rootC, '.mcp.json')), false, 'dry-run must not create the target');

  const narrow = await clientInstallSurface({
    id: 'claude-code',
    root: rootC,
    configScope: 'project',
    home: homeC,
    apply: true,
    grant: { ...grant, scope: ['config'] },
  });
  assert.equal(narrow.ok, true);
  if (narrow.ok) {
    assert.equal(narrow.result.applied, false);
    assert.equal(narrow.result.action, 'refused');
  }
  assert.equal(existsSync(join(rootC, '.mcp.json')), false);
});

// ---- 6. secret / real-session reads --------------------------------------

test('T-088/06 doctor, discovery and adapters never read secrets or real session stores', async (t) => {
  const home = await makeRoot(t, 'ano-t088-secret-home-');
  const root = await makeRoot(t, 'ano-t088-secret-root-');
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

  // Qoder adapter with a read-tracking filesystem seam: only declared candidates are read.
  const fs = new TrackingQoderFs();
  const qoderSettings = expand('~/.qoder/settings.json', home, root);
  fs.files.set(qoderSettings, JSON.stringify({
    mcpServers: { ano: { command: 'node', args: ['x'], env: { API_KEY: 'SECRET_VALUE_MARKER' } } },
  }));
  fs.files.set(expand('~/.env', home, root), 'ROOT_ENV_SECRET=ROOT_ENV_SECRET\n');
  fs.files.set(expand('~/secrets/id_rsa', home, root), 'RSA_PRIVATE_MARKER=RSA_PRIVATE_MARKER\n');
  fs.files.set(expand('~/credentials.json', home, root), 'CREDENTIALS_MARKER=CREDENTIALS_MARKER\n');
  fs.files.set(expand('~/.claude/projects/proj-1/session.jsonl', home, root), 'SESSION_CONTENT_MARKER\n');
  const qoder = createQoderAdapter({ now: () => AT, home, root, fs });
  const detect = await qoder.detect({ env: {} });
  const inspect = await qoder.inspect({});
  assert.equal(detect.detected, true);
  for (const read of fs.reads) {
    assert.equal(read.includes('.env'), false, `secret file read: ${read}`);
    assert.equal(read.includes('id_rsa'), false, `secret file read: ${read}`);
    assert.equal(read.includes('credentials.json'), false, `secret file read: ${read}`);
    assert.equal(read.includes('.claude/projects'), false, `session store read: ${read}`);
  }
  assert.ok(fs.reads.includes(qoderSettings), 'the declared candidate is the only config read');
  const qoderJson = JSON.stringify(inspect);
  for (const marker of SECRET_MARKERS) assert.equal(qoderJson.includes(marker), false, `qoder report leaked ${marker}`);
  assert.equal(qoderJson.includes('SECRET_VALUE_MARKER'), false, 'env values must never be echoed');
  assert.ok(qoderJson.includes('API_KEY'), 'env key names are allowed');

  // Real doctor run on the isolated home/root: no secret or session marker leaks.
  await mkdir(join(home, '.claude'), { recursive: true });
  await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: { ano: { command: process.execPath, args: ['fake.js'] } } }));
  const bin = join(home, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'claude'), '#!/usr/bin/env node\nprocess.exit(0);\n');
  const report = await doctorClients({
    clientIds: ['claude-code'],
    home,
    root,
    probePaths: [bin],
    env: {},
    verifier: async () => successfulVerify(AT),
    verify: { transport: 'stdio', command: process.execPath },
    now: () => AT,
  });
  const reportJson = JSON.stringify(report);
  for (const marker of SECRET_MARKERS) assert.equal(reportJson.includes(marker), false, `doctor report leaked ${marker}`);
  assert.equal(reportJson.includes('id_rsa'), false);
  assert.equal(reportJson.includes('credentials.json'), false);
  assert.equal(reportJson.includes('.claude/projects'), false);

  // Config discovery only reads the declared candidate, never the session store.
  const discovery = discoverClientConfig(getDescriptor('claude-code'), { home, root, now: () => AT });
  assert.equal(discovery.exists, true);
  assert.equal(resolve(discovery.configPath ?? ''), resolve(join(home, '.claude.json')));
  assert.equal(JSON.stringify(discovery).includes('SESSION_CONTENT_MARKER'), false);
});

// ---- 7. unknown session formats fail closed -----------------------------

test('T-088/07 unknown/corrupt session formats are never parsed and history stays unverified', async (t) => {
  const home = await makeRoot(t, 'ano-t088-history-home-');
  const root = await makeRoot(t, 'ano-t088-history-root-');
  const sessionDir = join(home, '.claude', 'projects', 'proj-1');
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, 'good.jsonl'), `${JSON.stringify({ timestamp: AT, content: 'SESSION_CONTENT_MARKER' })}\n`);
  await writeFile(join(sessionDir, 'unknown.xml'), 'SESSION_MESSAGE_MARKER');
  await writeFile(join(sessionDir, 'corrupt.json'), '{ not json SESSION_PROMPT_MARKER');
  await writeFile(join(sessionDir, 'empty.json'), '[]');

  await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: { ano: { command: process.execPath, args: ['fake.js'] } } }));
  const bin = join(home, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'claude'), '#!/usr/bin/env node\nprocess.exit(0);\n');

  const report = await doctorClients({
    clientIds: ['claude-code', 'codex', 'dsh'],
    home,
    root,
    probePaths: [bin],
    env: {},
    verifier: async () => successfulVerify(AT),
    verify: { transport: 'stdio', command: process.execPath },
    now: () => AT,
  });

  for (const client of report.clients) {
    const history = client.layers.history;
    assert.equal(history.verdict, 'unavailable', `${client.clientId} history must stay unavailable`);
    assert.equal(history.evidence, 'absent');
    assert.equal(history.details.sampleAuthorized, false);
    assert.equal(history.details.parsedRecords, 0);
    assert.equal(history.details.privacy, 'not-read');
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
    assert.equal(history.details.formatVersion, null);
    assert.equal(history.details.source, null);
  }
  const json = JSON.stringify(report);
  for (const marker of ['SESSION_CONTENT_MARKER', 'SESSION_MESSAGE_MARKER', 'SESSION_PROMPT_MARKER']) {
    assert.equal(json.includes(marker), false, `session content leaked: ${marker}`);
  }

  // `history` is an extension layer: it never joins the core chain.
  assert.equal((CORE_LAYERS as readonly string[]).includes('history'), false);
});

// ---- 8. Gate overreach and MCP non-amplification ------------------------

test('T-088/08 client reports/capabilities/MCP results carry no Gate fields and MCP success changes no Gate permission', async (t) => {
  const home = await makeRoot(t, 'ano-t088-gate-home-');
  const root = await makeRoot(t, 'ano-t088-gate-root-');
  await mkdir(join(root, '.pm'), { recursive: true });
  await writeFile(join(root, '.pm', 'tasks.json'), '{"seq":1,"tasks":[]}\n');
  await mkdir(join(root, '.ano', 'ledger'), { recursive: true });
  await writeFile(join(root, '.ano', 'ledger', 'keep.json'), '{"keep":true}\n');
  await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: { ano: { command: process.execPath, args: ['fake.js'] } } }));
  const bin = join(home, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'claude'), '#!/usr/bin/env node\nprocess.exit(0);\n');

  const before = await snapshotTree(root);
  const matrixBefore = roleMatrixForState('enforced', 'degraded');

  const report = await doctorClients({
    clientIds: ['claude-code'],
    home,
    root,
    probePaths: [bin],
    env: {},
    verifier: async () => successfulVerify(AT),
    verify: { transport: 'stdio', command: process.execPath },
    now: () => AT,
  });
  const capabilities = mapDoctorReport(report);

  assert.equal(report.clients[0]?.layers.mcp.verdict, 'validated');
  assert.equal(report.clients[0]?.layers.tools.verdict, 'validated');
  assert.equal(report.clients[0]?.layers.brief.verdict, 'validated');
  assert.equal(report.clients[0]?.status, 'ready');

  const claude = capabilities.clients.find((entry) => entry.clientId === 'claude-code');
  assert.equal(claude?.mcp.verdict, 'validated', 'MCP success is reported as MCP access only');
  assert.equal(claude?.rules.verdict, 'degraded', 'rules are not taken over by an MCP handshake');
  assert.equal(claude?.dag.verdict, 'degraded', 'DAG is not taken over by an MCP handshake');
  assert.equal(claude?.recovery.verdict, 'degraded');
  assert.equal(claude?.outputInterception.verdict, 'unavailable');
  assert.equal(claude?.hostCapability, 'degraded');
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

  // Seven tools is the invariant; an eighth tool degrades the tools layer.
  assert.equal(MCP_TOOL_COUNT, 7);
  assert.equal(MCP_TOOL_NAMES.length, 7);
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
});

// ---- 9. failure isolation ------------------------------------------------

test('T-088/09 one crashing client or adapter never blocks the others', async (t) => {
  const home = await makeRoot(t, 'ano-t088-isolate-');
  const root = await makeRoot(t, 'ano-t088-isolate-root-');
  // Give the healthy clients a declared, reachable config so their configured
  // layer validates and the isolation contrast is exact.
  await mkdir(join(home, '.codex'));
  await writeFile(join(home, '.codex', 'config.toml'), `[mcp_servers.ano]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ["x"]\n`);
  await mkdir(join(home, '.cursor'));
  await writeFile(join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { ano: { command: process.execPath, args: ['x'] } } }));
  const report = await doctorClients({
    clientIds: ['claude-code', 'codex', 'cursor'],
    adapters: {
      'claude-code': throwingAdapter('claude-code'),
      codex: goodAdapter('codex'),
      cursor: goodAdapter('cursor'),
    },
    home,
    root,
    probePaths: [],
    env: {},
    verifier: async () => successfulVerify(AT),
    verify: { transport: 'stdio', command: process.execPath },
    now: () => AT,
  });
  assert.equal(report.clients.length, 3);
  const failed = report.clients.find((client) => client.clientId === 'claude-code');
  assert.ok(failed?.errors.some((error) => error.message.includes('exploded')));
  assert.equal(failed?.status, 'unavailable');
  assert.equal(failed?.layers.detected.verdict, 'unavailable');
  for (const id of ['codex', 'cursor'] as const) {
    const healthy = report.clients.find((client) => client.clientId === id);
    assert.equal(healthy?.errors.length, 0);
    assert.equal(healthy?.status, 'ready');
    assert.equal(healthy?.layers.detected.verdict, 'validated');
    assert.equal(healthy?.layers.configured.verdict, 'validated');
    assert.equal(healthy?.layers.mcp.verdict, 'validated');
  }

  const mapped = mapDoctorReport(report);
  assert.equal(mapped.clients.length, 3);
  assert.equal(mapped.clients.find((client) => client.clientId === 'claude-code')?.mcp.verdict, 'unavailable');
  assert.equal(mapped.clients.find((client) => client.clientId === 'codex')?.mcp.verdict, 'validated');

  // A crashing registered external adapter is isolated too.
  const crashing = registerExternalAdapter(
    declaration({
      id: 'codex',
      detect: async () => {
        throw new Error('external detect exploded');
      },
    }),
    validValidation,
  );
  const isolated = await doctorClient(getDescriptor('codex'), { adapters: { codex: crashing }, home, root, now: () => AT });
  assert.equal(isolated.status, 'unavailable');
  assert.ok(isolated.errors.some((error) => error.code === 'E1_DETECT_FAILED'));
});

// ---- 10. sensitive-file collection ---------------------------------------

test('T-088/10 client-config backup/install collects no sensitive files and leaks no secret values', async (t) => {
  const root = await makeRoot(t, 'ano-t088-collect-');
  await writeFile(join(root, '.env'), 'ROOT_ENV_SECRET=ROOT_ENV_SECRET\n');
  await mkdir(join(root, 'secrets'));
  await writeFile(join(root, 'secrets', 'id_rsa'), 'RSA_PRIVATE_MARKER=RSA_PRIVATE_MARKER\n');
  await writeFile(join(root, 'credentials.json'), 'CREDENTIALS_MARKER=CREDENTIALS_MARKER\n');

  const target = targetFor(root);
  writeConfig(target, { mcpServers: {} });
  const entry = { command: process.execPath, args: ['dist/surface/mcp.js'], env: { API_KEY: 'SECRET_VALUE_MARKER' } };
  const installed = installClientConfig(target, entry, applyOptionsFor(root));
  assert.equal(installed.action, 'installed');
  assert.equal(installed.applied, true);

  // Only the target config backup and the install record exist under `.ano/clients`.
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
  }

  // Artifact text must not leak unrelated project secrets.
  const artifactText = (await Promise.all(collected.map((path) => readFile(join(root, '.ano', 'clients', path), 'utf8')))).join('\n');
  for (const marker of SECRET_MARKERS) assert.equal(artifactText.includes(marker), false, `artifact leaked ${marker}`);

  // The install record carries hashes and paths only, never the config's secret env value.
  const record = readInstallRecord(root, 'claude-code');
  assert.ok(record !== null);
  const recordJson = JSON.stringify(record);
  assert.equal(recordJson.includes('SECRET_VALUE_MARKER'), false);
  assert.equal(recordJson.includes('API_KEY'), false);
  assert.equal(recordJson.includes('ROOT_ENV_SECRET'), false);
  assert.equal(recordJson.includes('RSA_PRIVATE_MARKER'), false);
  assert.equal(recordJson.includes('CREDENTIALS_MARKER'), false);
  assert.equal(record?.authorizationId, 'a'.repeat(64));

  // Restore is authorized and byte-exact; dry-run restore writes nothing.
  const configured = readFileSync(target.path);
  const dryRestore = restoreClientConfig(target, { root, backupId: installed.backupId as string });
  assert.equal(dryRestore.mode, 'dry-run');
  assert.equal(dryRestore.applied, false);
  assert.deepEqual(readFileSync(target.path), configured);
  const restored = restoreClientConfig(target, applyOptionsFor(root, { backupId: installed.backupId as string }));
  assert.equal(restored.applied, true);
});

// ---- registry / layer invariants -----------------------------------------

test('T-088/11 registry invariants and the fixed serverPath declarations hold', () => {
  assert.deepEqual([...CLIENT_IDS], [
    'claude-code', 'github-copilot', 'cursor', 'codex', 'trae', 'antigravity',
    'replit-agent', 'cline', 'kilo-code', 'hermes-agent', 'openclaw', 'zed',
    'tabnine', 'amazon-q', 'jetbrains-ai', 'codegeex', 'tongyi-lingma',
    'comate', 'qoder', 'codebuddy', 'deepseek-harness', 'opencode', 'pi', 'zcode',
  ]);
  assert.equal(CLIENT_IDS.length, 24);
  assert.equal(defaultRegistry.list().length, 24);
  assert.equal(getDescriptor('cloudcode').id, 'claude-code');
  assert.equal(getDescriptor('dsh').id, 'deepseek-harness');
  assert.equal(getDescriptor('dsh').identityStatus, 'declared');
  assert.equal(getDescriptor('qoder').identityStatus, 'unverified');
  assert.equal(QODER_CONFIG_CANDIDATES.length, 4);
  for (const candidate of QODER_CONFIG_CANDIDATES) {
    assert.equal(candidate.format, 'json');
    assert.equal(candidate.key, 'mcpServers.ano');
  }
  // The declared server containers are fixed keys; no traversal or prototype key.
  const declared = [CLAUDE_CODE_SERVER_PATH, CODEX_SERVER_PATH, CURSOR_SERVER_PATH, OPENCODE_SERVER_PATH];
  for (const path of declared) {
    for (const segment of path) {
      assert.equal(['__proto__', 'constructor', 'prototype', '..', '.'].includes(segment), false);
    }
  }
});

// ---- 12. F-01 prototype-pollution hardening (T-089) ----------------------

test('T-089/01 reserved serverPath segments are refused and Object.prototype stays clean', async (t) => {
  const root = await makeRoot(t, 'ano-t089-proto-');
  const entry = { command: process.execPath, args: ['dist/surface/mcp.js'] };

  // The validator itself rejects every reserved segment.
  for (const segment of ['__proto__', 'prototype', 'constructor']) {
    assert.throws(
      () => assertSafeServerPath([segment]),
      /reserved serverPath segment/u,
      `${segment} must be refused by the validator`,
    );
  }
  assert.doesNotThrow(() => assertSafeServerPath(['mcpServers']));

  const polluted = targetFor(root, { serverPath: ['__proto__'] });
  assert.throws(() => assertSafeTargetPath(polluted), /reserved serverPath segment/u);
  assert.throws(
    () => planClientConfig(polluted, entry),
    (error: unknown) => expectError(error, 'CLIENT_CONFIG_PATH', /reserved serverPath segment/u),
  );
  assert.throws(
    () => applyClientConfig(polluted, entry, applyOptionsFor(root)),
    (error: unknown) => expectError(error, 'CLIENT_CONFIG_PATH', /reserved serverPath segment/u),
  );

  // The library-level pollution is gone: no own `ano` key on Object.prototype,
  // and a fresh object does not inherit one either.
  assert.equal(Object.hasOwn(Object.prototype, 'ano'), false, 'Object.prototype must not gain an ano key');
  assert.equal((Object.prototype as unknown as Record<string, unknown>).ano, undefined);
  assert.equal(({} as Record<string, unknown>).ano, undefined);

  // The refused plan wrote nothing into the project root.
  assert.deepEqual(await readdir(root), [], 'a refused reserved-key plan must be zero-write');

  // Other reserved segments are refused on the same path.
  for (const segment of ['prototype', 'constructor']) {
    assert.throws(
      () => planClientConfig(targetFor(root, { serverPath: [segment] }), entry),
      /reserved serverPath segment/u,
      `${segment} must be refused on the merge path`,
    );
  }
  assert.equal(Object.hasOwn(Object.prototype, 'ano'), false);
});

// ---------------------------------------------------------------------------
// T-100 / CX-10 (M12): full 24-client catalog boundary scan.
//
// Appended by T-100; the twelve M11 red-team cases above are unchanged. This
// case extends the same assertions to the 21 ADR-008 tools plus the three M11
// legacy clients: per-client malicious paths, inert forged payloads, no Gate
// overreach, and cloud/plugin-only clients never generating a config.
// ---------------------------------------------------------------------------

test('T-100/12 full 24-client catalog: malicious paths, inert payloads and no Gate overreach', async (t) => {
  const { registerAllClientAdapters } = await import('../../src/clients/doctor.ts');
  const { clientAccessPlanReport, clientInstallSurface } = await import('../../src/surface/service.ts');
  const { installClientBatch } = await import('../../src/clients/install.ts');

  const root = await makeRoot(t, 'ano-t100-cx10-');
  const home = await makeRoot(t, 'ano-t100-cx10-home-');
  const outside = await makeRoot(t, 'ano-t100-cx10-out-');
  const adapters = registerAllClientAdapters({ home, root, env: { HOME: home, USERPROFILE: home } });
  const env = { HOME: home, USERPROFILE: home };
  const sentinel = join(root, 'SENTINEL_CX10');
  const payload = maliciousEntry(sentinel);
  type AdapterConfigInput = Parameters<ClientAdapter['config']>[0];

  for (const id of CLIENT_IDS) {
    const adapter = adapters[id];
    const descriptor = getDescriptor(id);
    const candidate = descriptor.configCandidates.find((entry) => entry.format === 'json');
    const scope = 'project' as const;
    const basePath = candidate !== undefined ? expand(candidate.path, home, root) : join(root, `cx10-${id}.json`);

    // (a) A traversal path outside the project scope is refused with zero write.
    const escapePath = join(outside, `${id}-escape.json`);
    const escapeBytes = '{"mcpServers":{}}\n';
    await writeFile(escapePath, escapeBytes);
    if (adapter !== undefined) {
      const escaped = await adapter.config({
        mode: 'apply',
        target: { scope, path: escapePath },
        root,
        authorization: {
          authorizationId: 'a'.repeat(64),
          root,
          clientId: id,
          scope: ['config', 'install', 'restore'],
          grantedBy: 'Alice',
          statement: 'authorize',
          grantedAt: AT,
          revokedAt: null,
        },
        env,
      } as unknown as AdapterConfigInput);
      assert.equal(escaped.mode, 'dry-run', `${id}: traversal must be refused`);
    }
    assert.equal(await readFile(escapePath, 'utf8'), escapeBytes, `${id}: traversal wrote nothing`);

    // (b) Forged config content is inert data: a dry-run plan leaves the source
    // byte-identical and executes nothing.
    await mkdir(resolve(basePath, '..'), { recursive: true });
    const maliciousDocument = `${JSON.stringify({ mcpServers: { evil: { command: `x; touch ${sentinel}`, args: ['$(touch pwned)'] } } })}\n`;
    await writeFile(basePath, maliciousDocument);
    if (adapter !== undefined) {
      const plan = await adapter.config({
        mode: 'dry-run',
        target: { scope, path: basePath },
        root,
        env,
      } as unknown as AdapterConfigInput);
      assert.equal(plan.mode, 'dry-run', `${id}: dry-run plan`);
      assert.equal(plan.changes.every((change) => change.operation !== 'remove'), true, id);
    }
    assert.deepEqual(await readFile(basePath, 'utf8'), maliciousDocument, `${id}: forged content stays byte-identical`);
    assert.equal(existsSync(sentinel), false, `${id}: forged content was executed`);

    // (c) The declared target never contains a Gate field.
    if (adapter !== undefined) {
      const inspected = await adapter.inspect({ root, env });
      assertNoGateTokens(inspected);
    }
  }

  // (d) Every catalog client has a plan; cloud/plugin-only clients are skipped
  // with no write target, and no plan carries a Gate field.
  const plan = await clientAccessPlanReport({ clientIds: [...CLIENT_IDS], home, root, probePaths: [] });
  assert.equal(plan.clients.length, CLIENT_IDS.length);
  for (const entry of plan.clients) {
    assertNoGateTokens(entry);
    assert.ok(['mcp', 'rules', 'cli', 'explicit-workflow', 'skip'].includes(entry.route), entry.clientId);
    if (entry.route === 'skip') assert.equal(entry.target, null, `${entry.clientId} skip route must not name a target`);
  }
  for (const id of ['replit-agent', 'tabnine', 'jetbrains-ai', 'codegeex'] as const) {
    const entry = plan.clients.find((client) => client.clientId === id);
    assert.equal(entry?.route, 'skip', `${id} must be skipped`);
    assert.equal(entry?.target, null, `${id} must not name a target`);
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

  // (e) A batch install without authorizations applies nothing and writes nothing.
  const before = await snapshotTree(root);
  const batch = installClientBatch(plan.clients, { root, mode: 'apply', confirm: true });
  assert.equal(batch.results.filter((result) => result.applied).length, 0);
  for (const result of batch.results) assert.equal(result.applied, false);
  assert.equal(await snapshotTree(root), before, 'unauthorized batch install writes nothing');

  // (f) Read-only doctor + capability mapping carry no Gate token and change no
  // Gate permission.
  const report = await doctorClients({
    clientIds: [...CLIENT_IDS],
    home,
    root,
    probePaths: [],
    env,
    adapters,
    now: () => AT,
  });
  assert.equal(report.clients.length, CLIENT_IDS.length);
  assertNoGateTokens(report);
  assertNoGateTokens(mapDoctorReport(report));
  const matrixBefore = roleMatrixForState('enforced', 'degraded');
  assert.deepEqual(roleMatrixForState('enforced', 'degraded'), matrixBefore);
  assert.equal(MCP_TOOL_COUNT, 7);

  // The same forged payload is inert through the config service and preserves
  // unrelated services as data.
  const payloadTarget = targetFor(root);
  writeFileSync(payloadTarget.path, '{"mcpServers":{"other":{"command":"x"}}}\n');
  const payloadResult = applyClientConfig(payloadTarget, payload, applyOptionsFor(root));
  assert.equal(payloadResult.applied, true);
  const payloadText = readFileSync(payloadTarget.path, 'utf8');
  assert.ok(payloadText.includes('$(touch'), 'command substitution preserved as data');
  assert.ok(payloadText.includes('a && touch'), 'shell chaining preserved as data');
  assert.ok(payloadText.includes('other'), 'unrelated service preserved');
  assert.equal(existsSync(sentinel), false, 'the forged payload was never executed');
});
