/**
 * Open-source agent/IDE client adapter tests (M12 / T-095).
 *
 * Covers Cline, Kilo Code, OpenClaw and Hermes Agent:
 * - public interface evidence wired to the T-092 registry descriptors;
 * - legal configuration generation where E1 public evidence exists;
 * - the hard rule that configuration content is data and is never executed
 *   (static source scan + injected malicious command);
 * - takeover / subtask capability layering (orchestration degraded +
 *   explicit-workflow, instructions read-only, history/output-interception
 *   unavailable);
 * - default zero-write and per-client failure isolation.
 *
 * All filesystem access is injected through a tmpdir; no real user home or
 * client configuration is read.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  CLINE_IDENTITY_SOURCES,
  CLINE_SERVER_NAME,
  CLINE_SERVER_PATH,
  clineConfigTarget,
  createClineAdapter,
  type ClineAdapterOptions,
} from '../../src/clients/cline.ts';
import {
  createKiloCodeAdapter,
  KILO_CODE_IDENTITY_SOURCES,
  KILO_SERVER_NAME,
  KILO_SERVER_PATH,
  kiloCodeConfigTarget,
  type KiloCodeAdapterOptions,
} from '../../src/clients/kilo-code.ts';
import {
  createOpenClawAdapter,
  OPENCLAW_IDENTITY_SOURCES,
  OPENCLAW_SERVER_NAME,
  OPENCLAW_SERVER_PATH,
  openclawConfigTarget,
  type OpenClawAdapterOptions,
} from '../../src/clients/openclaw.ts';
import {
  createHermesAgentAdapter,
  HERMES_AGENT_IDENTITY_SOURCES,
  HERMES_SERVER_NAME,
  HERMES_SERVER_PATH,
  hermesDesiredEntry,
  type HermesAgentAdapterOptions,
} from '../../src/clients/hermes-agent.ts';
import { defaultRegistry } from '../../src/clients/registry.ts';
import {
  CAPABILITY_LAYERS,
  CLIENT_IDS,
  CLIENT_REPORT_SCHEMA,
  MCP_TOOL_NAMES,
  type ClientAdapter,
  type ClientId,
  type McpClientLike,
} from '../../src/clients/types.ts';
import { MANAGED_INSTRUCTIONS_BEGIN, MANAGED_INSTRUCTIONS_END, MANAGED_INSTRUCTIONS_SCHEMA } from '../../src/connect/managed-instructions.ts';

const AT = '2026-11-23T00:00:00.000Z';

const ADAPTER_IDS = ['cline', 'kilo-code', 'openclaw', 'hermes-agent'] as const;

function tmp(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'ano-client-open-agents-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function fixture(t: TestContext): { root: string; home: string; bin: string } {
  const root = tmp(t);
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  return { root, home, bin };
}

function installExecutable(bin: string, name: string): void {
  writeFileSync(join(bin, name), '#!/usr/bin/env node\nprocess.exit(0);\n');
}

interface Grant {
  authorizationId: string;
  root: string;
  clientId: ClientId;
  scope: string[];
  grantedBy: string;
  grantedAt: string;
  revokedAt: null;
  statement: string;
}

function grantFor(root: string, clientId: ClientId): Grant {
  return {
    authorizationId: 'a'.repeat(64),
    root,
    clientId,
    scope: ['config', 'install'],
    grantedBy: 'Alice',
    grantedAt: AT,
    revokedAt: null,
    statement: 'Authorize ANO client configuration for this project',
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function injectedClient(options: { failHandshake?: boolean } = {}): McpClientLike {
  return {
    initialize: async () => {
      if (options.failHandshake === true) throw new Error('handshake refused');
      return { protocolVersion: '2025-06-18', serverInfo: { name: 'injected-ano', version: '1.0.0' } };
    },
    listTools: async () => ({ tools: MCP_TOOL_NAMES.map((name) => ({ name, inputSchema: { type: 'object' } })) }),
    callTool: async (request) => {
      if (request.name !== 'brief') return { isError: true, content: [{ type: 'text', text: 'unknown tool' }] };
      return { content: [{ type: 'text', text: JSON.stringify({ phase: 'P7', project_scope: 'local', hostCapability: 'degraded' }) }] };
    },
    close: async () => {},
  };
}

function managedRule(text = '# Rules\n'): string {
  return `${text}\n${MANAGED_INSTRUCTIONS_BEGIN}\nschema: ${MANAGED_INSTRUCTIONS_SCHEMA}\n- managed\n${MANAGED_INSTRUCTIONS_END}\n`;
}

// ---------------------------------------------------------------------------
// 1. Public interface evidence and registry wiring
// ---------------------------------------------------------------------------

test('the four open agents are registered with public sources, forms and declared identity sources', () => {
  for (const id of ADAPTER_IDS) {
    assert.ok((CLIENT_IDS as readonly string[]).includes(id), `${id} must be a canonical ClientId`);
    const descriptor = defaultRegistry.get(id);
    assert.equal(descriptor.identityStatus, 'declared');
    assert.equal(descriptor.initialVerdict, 'unverified');
    assert.ok(descriptor.officialSources.length >= 1, `${id} must cite an official public source`);
    assert.ok(descriptor.notes.some((note) => note.includes('未实测') || note.includes('待核实')), `${id} must be marked unmeasured`);
    assert.ok(descriptor.productForms.length >= 1);
  }
  assert.ok(defaultRegistry.get('cline').productForms.includes('ide-plugin'));
  assert.ok(defaultRegistry.get('cline').productForms.includes('cli'));
  assert.ok(defaultRegistry.get('kilo-code').productForms.includes('ide-plugin'));
  assert.ok(defaultRegistry.get('openclaw').productForms.includes('agent-framework'));
  assert.ok(defaultRegistry.get('hermes-agent').productForms.includes('cli'));
  assert.ok(defaultRegistry.get('hermes-agent').productForms.includes('desktop-app'));
  assert.ok(defaultRegistry.get('hermes-agent').productForms.includes('cloud-service'));
});

test('each adapter exposes the registry identity sources and the documented server mapping', () => {
  const cases: readonly { adapter: ClientAdapter; sources: unknown; path: readonly string[]; name: string }[] = [
    { adapter: createClineAdapter(), sources: CLINE_IDENTITY_SOURCES, path: CLINE_SERVER_PATH, name: CLINE_SERVER_NAME },
    { adapter: createKiloCodeAdapter(), sources: KILO_CODE_IDENTITY_SOURCES, path: KILO_SERVER_PATH, name: KILO_SERVER_NAME },
    { adapter: createOpenClawAdapter(), sources: OPENCLAW_IDENTITY_SOURCES, path: OPENCLAW_SERVER_PATH, name: OPENCLAW_SERVER_NAME },
    { adapter: createHermesAgentAdapter(), sources: HERMES_AGENT_IDENTITY_SOURCES, path: HERMES_SERVER_PATH, name: HERMES_SERVER_NAME },
  ];
  for (const entry of cases) {
    const descriptor = defaultRegistry.get(entry.adapter.id);
    assert.deepEqual(entry.adapter.identitySources, descriptor.identitySources);
    assert.deepEqual(entry.sources, descriptor.identitySources);
    assert.equal(entry.name, 'ano');
  }
  assert.deepEqual([...CLINE_SERVER_PATH], ['mcpServers']);
  assert.deepEqual([...KILO_SERVER_PATH], ['mcp']);
  assert.deepEqual([...OPENCLAW_SERVER_PATH], ['mcp', 'servers']);
  assert.deepEqual([...HERMES_SERVER_PATH], ['mcp_servers']);
});

// ---------------------------------------------------------------------------
// 2. Cline
// ---------------------------------------------------------------------------

function clineFixture(t: TestContext): { root: string; home: string; bin: string; adapter: ClientAdapter; options: ClineAdapterOptions } {
  const { root, home, bin } = fixture(t);
  const options: ClineAdapterOptions = { home, root, probePaths: [bin], env: {}, now: () => AT };
  return { root, home, bin, adapter: createClineAdapter(options), options };
}

test('cline detect is read-only, honours the settings env override, and never guesses paths', async (t) => {
  const { root, home, bin, adapter } = clineFixture(t);
  const before = readdirSync(root).sort();

  const absent = await adapter.detect({ env: {}, probePaths: [bin] });
  assert.equal(absent.clientId, 'cline');
  assert.equal(absent.detected, false);
  assert.deepEqual(absent.sources, []);
  assert.deepEqual(absent.errors, []);

  const settingsDir = join(home, '.cline', 'data', 'settings');
  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(join(settingsDir, 'cline_mcp_settings.json'), '{}\n');
  const installed = await adapter.detect({ env: {}, probePaths: [bin] });
  assert.equal(installed.detected, true);
  assert.ok(installed.sources.some((source) => source.kind === 'config-path' && source.source.includes('cline_mcp_settings.json')));

  const override = join(root, 'custom-cline-settings.json');
  writeFileSync(override, '{}\n');
  const withEnv = await adapter.detect({ env: { CLINE_MCP_SETTINGS_PATH: override }, probePaths: [bin] });
  assert.ok(withEnv.sources.some((source) => source.kind === 'env' && source.source === 'env:CLINE_MCP_SETTINGS_PATH'));

  assert.deepEqual(readdirSync(root).sort(), [...before, 'custom-cline-settings.json'].sort(), 'detect must not write');
});

test('cline inspect reports unavailable when absent and never validates', async (t) => {
  const { root, adapter } = clineFixture(t);
  const report = await adapter.inspect({ root, env: {} });
  assert.equal(report.schema, CLIENT_REPORT_SCHEMA);
  assert.equal(report.clientId, 'cline');
  assert.equal(report.status, 'unavailable');
  assert.equal(report.coreVerdict, 'unavailable');
  for (const layer of CAPABILITY_LAYERS) {
    assert.equal(report.layers[layer].verdict, 'unavailable', `${layer} must stay unavailable`);
    assert.equal(report.layers[layer].evidence, 'absent');
  }
  assert.ok(report.limitations.some((line) => /unverified|not measured/i.test(line)));
});

test('cline inspect resolves a documented mcpServers entry and .clinerules managed section read-only', async (t) => {
  const { root, home, bin, adapter } = clineFixture(t);
  const settingsDir = join(home, '.cline', 'data', 'settings');
  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(
    join(settingsDir, 'cline_mcp_settings.json'),
    `${JSON.stringify(
      {
        mcpServers: {
          ano: { command: process.execPath, args: ['dist/surface/mcp.js'], env: {} },
          otherService: { command: 'other-bin', args: ['--serve'] },
        },
        unknownTop: { keep: true },
      },
      null,
      2,
    )}\n`,
  );
  mkdirSync(join(root, '.clinerules'), { recursive: true });
  writeFileSync(join(root, '.clinerules', 'project.md'), managedRule());

  const report = await adapter.inspect({ root, env: {} });
  assert.equal(report.status, 'degraded');
  assert.equal(report.coreVerdict, 'unavailable', 'inspect performs no handshake');

  const configured = report.layers.configured;
  assert.equal(configured.verdict, 'degraded');
  assert.equal(configured.evidence, 'configured');
  assert.equal(configured.details.exists, true);
  assert.equal(configured.details.key, 'mcpServers.ano');
  assert.equal(configured.details.scope, 'user');
  assert.equal(configured.version, 'config-format:json');
  assert.ok(configured.limitations.some((line) => line.includes('not measured')));

  const instructions = report.layers.instructions;
  assert.equal(instructions.verdict, 'degraded');
  assert.equal(instructions.evidence, 'measured');
  assert.equal(instructions.details.hasManagedSection, true);
  assert.equal(instructions.details.formatVersion, MANAGED_INSTRUCTIONS_SCHEMA);
  assert.equal(instructions.details.readOnly, true);
  assert.ok(instructions.limitations.some((line) => line.includes('does not prove')));
  assert.ok(report.layers.orchestration.details.mode === 'explicit-workflow');
  assert.equal(report.layers.orchestration.verdict, 'degraded');
  assert.equal(report.layers.orchestration.details.measured, false);
});

test('cline inspect isolates malformed JSON and unknown entry fields without throwing', async (t) => {
  const { root, home, adapter } = clineFixture(t);
  const settingsDir = join(home, '.cline', 'data', 'settings');
  mkdirSync(settingsDir, { recursive: true });
  const configPath = join(settingsDir, 'cline_mcp_settings.json');

  writeFileSync(configPath, '{ not json');
  const broken = await adapter.inspect({ root, env: {} });
  assert.equal(broken.layers.configured.verdict, 'degraded');
  assert.ok(broken.layers.configured.errors.some((error) => error.code === 'E2_PARSE_FAILED'));
  assert.notEqual(broken.layers.configured.verdict, 'validated');

  writeFileSync(configPath, `${JSON.stringify({ mcpServers: { ano: { command: process.execPath, args: [], mystery: true } } })}\n`);
  const unknown = await adapter.inspect({ root, env: {} });
  assert.equal(unknown.layers.configured.verdict, 'degraded');
  assert.equal(asRecord(unknown.layers.configured.details.resolvedEntry)['command'], process.execPath);
});

test('cline config dry-run maps mcpServers.ano, writes nothing, and apply is authorization-gated', async (t) => {
  const { root, home, adapter } = clineFixture(t);
  const settingsDir = join(home, '.cline', 'data', 'settings');
  mkdirSync(settingsDir, { recursive: true });
  const configPath = join(settingsDir, 'cline_mcp_settings.json');
  const original = `${JSON.stringify({ mcpServers: { other: { command: 'x', args: ['y'] } }, unknownTop: { keep: true } }, null, 2)}\n`;
  writeFileSync(configPath, original);

  const dry = await adapter.config({ target: { scope: 'user' }, mode: 'dry-run', root });
  assert.equal(dry.mode, 'dry-run');
  assert.equal(dry.changes.length, 1);
  const change = dry.changes[0]!;
  assert.equal(change.path, resolve(configPath));
  assert.equal(change.key, 'mcpServers.ano');
  assert.equal(change.operation, 'add');
  assert.equal(change.before, null);
  const after = change.after as { command: string; args: string[] };
  assert.equal(after.command, process.execPath);
  assert.ok(after.args[0]?.endsWith(join('dist', 'surface', 'mcp.js')));
  assert.equal(readFileSync(configPath, 'utf8'), original, 'dry-run must be zero-write');

  const refused = await adapter.config({ target: { scope: 'user' }, mode: 'apply', root });
  assert.equal(refused.mode, 'dry-run');
  assert.equal(readFileSync(configPath, 'utf8'), original, 'apply without authorization must be zero-write');
  assert.ok(refused.mode === 'dry-run' && refused.warnings.some((line) => /authorization|refused/i.test(line)));

  const applied = await adapter.config({ target: { scope: 'user' }, mode: 'apply', authorization: grantFor(root, 'cline'), root });
  assert.equal(applied.mode, 'apply');
  const written = JSON.parse(readFileSync(configPath, 'utf8')) as { mcpServers: Record<string, unknown>; unknownTop: unknown };
  assert.ok(written.mcpServers['other'], 'other MCP services must be preserved');
  assert.deepEqual(written.unknownTop, { keep: true });
  assert.ok(existsSync(join(root, '.ano', 'clients', 'backups', 'cline')), 'an authorized write must be backed up');

  const replay = await adapter.config({ target: { scope: 'user' }, mode: 'apply', authorization: grantFor(root, 'cline'), root });
  assert.equal(replay.mode, 'dry-run');
  assert.equal(replay.changes.length, 0, 'idempotent replay is a zero-byte no-op');
});

test('clineConfigTarget exposes the documented mapping', () => {
  const target = clineConfigTarget('user', { home: resolve('/tmp/ano-home'), root: resolve('/tmp/ano-root') });
  assert.equal(target.clientId, 'cline');
  assert.equal(target.format, 'json');
  assert.deepEqual(target.serverPath, ['mcpServers']);
  assert.equal(target.serverName, 'ano');
  assert.equal(target.path, resolve(join('/tmp/ano-home', '.cline', 'data', 'settings', 'cline_mcp_settings.json')));
  assert.equal(target.allowedRoot, resolve('/tmp/ano-home'));
});

// ---------------------------------------------------------------------------
// 3. Kilo Code
// ---------------------------------------------------------------------------

function kiloFixture(t: TestContext): { root: string; home: string; bin: string; adapter: ClientAdapter; options: KiloCodeAdapterOptions } {
  const { root, home, bin } = fixture(t);
  const options: KiloCodeAdapterOptions = { home, root, probePaths: [bin], env: {}, now: () => AT };
  return { root, home, bin, adapter: createKiloCodeAdapter(options), options };
}

test('kilo detect probes the declared CLI and config candidates only', async (t) => {
  const { root, home, bin, adapter } = kiloFixture(t);
  const absent = await adapter.detect({ env: {}, probePaths: [bin] });
  assert.equal(absent.detected, false);
  assert.deepEqual(absent.sources, []);

  installExecutable(bin, 'kilo');
  mkdirSync(join(home, '.config', 'kilo'), { recursive: true });
  writeFileSync(join(home, '.config', 'kilo', 'kilo.jsonc'), '{}\n');

  const installed = await adapter.detect({ env: {}, probePaths: [bin] });
  assert.equal(installed.detected, true);
  assert.equal(installed.executablePath, join(bin, 'kilo'));
  assert.ok(installed.sources.some((source) => source.source === 'executable:kilo'));
  assert.ok(installed.sources.some((source) => source.source.includes('kilo.jsonc')));
});

test('kilo inspect resolves the documented mcp entry and .kilo/rules instructions', async (t) => {
  const { root, bin, adapter } = kiloFixture(t);
  installExecutable(bin, 'kilo');
  writeFileSync(
    join(root, 'kilo.jsonc'),
    `${JSON.stringify(
      {
        mcp: {
          ano: { type: 'local', command: [process.execPath, 'dist/surface/mcp.js'], environment: {}, enabled: true, timeout: 10000 },
          other: { type: 'remote', url: 'https://example.com/mcp', enabled: false },
        },
        instructions: ['.kilo/rules/formatting.md'],
      },
      null,
      2,
    )}\n`,
  );
  mkdirSync(join(root, '.kilo', 'rules'), { recursive: true });
  writeFileSync(join(root, '.kilo', 'rules', 'formatting.md'), managedRule());

  const report = await adapter.inspect({ root, env: {} });
  assert.equal(report.layers.detected.verdict, 'validated');
  const configured = report.layers.configured;
  assert.equal(configured.verdict, 'degraded');
  assert.equal(configured.evidence, 'configured');
  assert.equal(configured.details.key, 'mcp.ano');
  assert.equal(configured.details.scope, 'project');
  assert.equal(configured.version, 'config-format:jsonc');
  const kiloEntry = asRecord(configured.details.resolvedEntry);
  assert.equal(kiloEntry['type'], 'local');
  assert.deepEqual(kiloEntry['command'], [process.execPath, 'dist/surface/mcp.js']);

  const instructions = report.layers.instructions;
  assert.equal(instructions.verdict, 'degraded');
  assert.equal(instructions.evidence, 'measured');
  assert.equal(instructions.details.hasManagedSection, true);
  assert.ok(instructions.details.rulePaths.some((path) => path.endsWith(join('.kilo', 'rules', 'formatting.md'))));
  assert.equal(report.layers.orchestration.details.mode, 'explicit-workflow');
});

test('kilo inspect reads commented JSONC tolerantly but never rewrites it', async (t) => {
  const { root, bin, adapter } = kiloFixture(t);
  installExecutable(bin, 'kilo');
  const configPath = join(root, 'kilo.jsonc');
  const document = { mcp: { ano: { type: 'local', command: [process.execPath, 'dist/surface/mcp.js'], enabled: true } } };
  writeFileSync(configPath, `// project config with comments\n${JSON.stringify(document, null, 2)}\n`);

  const report = await adapter.inspect({ root, env: {} });
  assert.equal(report.layers.configured.details.exists, true);
  assert.equal(report.layers.configured.details.key, 'mcp.ano');
  assert.ok(report.layers.configured.limitations.some((line) => line.includes('JSONC')));

  const result = await adapter.config({ target: { scope: 'project' }, mode: 'apply', authorization: grantFor(root, 'kilo-code'), root });
  assert.equal(result.mode, 'dry-run');
  assert.equal(readFileSync(configPath, 'utf8').includes('// project config with comments'), true, 'commented JSONC is never rewritten');
  assert.ok(result.warnings.some((line) => /plan failed|JSON|json/i.test(line)));
});

test('kilo config generates the documented local entry and applies it to a strict JSON project file', async (t) => {
  const { root, adapter } = kiloFixture(t);
  const configPath = join(root, 'kilo.jsonc');
  const original = '{}\n';
  writeFileSync(configPath, original);

  const dry = await adapter.config({ target: { scope: 'project' }, mode: 'dry-run', root });
  assert.equal(dry.changes.length, 1);
  assert.equal(dry.changes[0]?.key, 'mcp.ano');
  assert.equal(dry.changes[0]?.operation, 'add');
  const entry = dry.changes[0]?.after as { type: string; command: string[]; enabled: boolean };
  assert.equal(entry.type, 'local');
  assert.equal(entry.command[0], process.execPath);
  assert.ok(entry.command[1]?.endsWith(join('dist', 'surface', 'mcp.js')));
  assert.equal(entry.enabled, true);
  assert.equal(readFileSync(configPath, 'utf8'), original);

  const applied = await adapter.config({ target: { scope: 'project' }, mode: 'apply', authorization: grantFor(root, 'kilo-code'), root });
  assert.equal(applied.mode, 'apply');
  const written = JSON.parse(readFileSync(configPath, 'utf8')) as { mcp: Record<string, unknown> };
  assert.equal(asRecord(written.mcp['ano'])['type'], 'local');
  assert.ok(existsSync(join(root, '.ano', 'clients', 'backups', 'kilo-code')));
});

test('kiloCodeConfigTarget exposes the documented mapping', () => {
  const target = kiloCodeConfigTarget('project', { home: resolve('/tmp/ano-home'), root: resolve('/tmp/ano-root') });
  assert.equal(target.clientId, 'kilo-code');
  assert.equal(target.format, 'json');
  assert.deepEqual(target.serverPath, ['mcp']);
  assert.equal(target.serverName, 'ano');
  assert.equal(target.path, resolve(join('/tmp/ano-root', 'kilo.jsonc')));
});

// ---------------------------------------------------------------------------
// 4. OpenClaw
// ---------------------------------------------------------------------------

function openclawFixture(t: TestContext): { root: string; home: string; bin: string; adapter: ClientAdapter; options: OpenClawAdapterOptions } {
  const { root, home, bin } = fixture(t);
  const options: OpenClawAdapterOptions = { home, root, probePaths: [bin], env: {}, now: () => AT };
  return { root, home, bin, adapter: createOpenClawAdapter(options), options };
}

test('openclaw detect probes the declared CLI and config candidates', async (t) => {
  const { home, bin, adapter } = openclawFixture(t);
  const absent = await adapter.detect({ env: {}, probePaths: [bin] });
  assert.equal(absent.detected, false);

  installExecutable(bin, 'openclaw');
  mkdirSync(join(home, '.openclaw'), { recursive: true });
  writeFileSync(join(home, '.openclaw', 'openclaw.json'), '{}\n');

  const installed = await adapter.detect({ env: {}, probePaths: [bin] });
  assert.equal(installed.detected, true);
  assert.equal(installed.executablePath, join(bin, 'openclaw'));
  assert.ok(installed.sources.some((source) => source.source.includes('openclaw.json')));
});

test('openclaw inspect resolves mcp.servers.ano and explicitly degrades rules and orchestration', async (t) => {
  const { root, home, bin, adapter } = openclawFixture(t);
  installExecutable(bin, 'openclaw');
  mkdirSync(join(home, '.openclaw'), { recursive: true });
  writeFileSync(
    join(home, '.openclaw', 'openclaw.json'),
    `${JSON.stringify(
      {
        mcp: {
          servers: {
            ano: { transport: 'stdio', command: process.execPath, args: ['dist/surface/mcp.js'], env: {}, enabled: true },
            other: { url: 'https://example.com/mcp', transport: 'streamable-http', enabled: false },
          },
        },
        channels: { whatsapp: { allowFrom: ['+15550000000'] } },
      },
      null,
      2,
    )}\n`,
  );

  const report = await adapter.inspect({ root, env: {} });
  assert.equal(report.layers.detected.verdict, 'validated');
  const configured = report.layers.configured;
  assert.equal(configured.verdict, 'degraded');
  assert.equal(configured.evidence, 'configured');
  assert.equal(configured.details.key, 'mcp.servers.ano');
  assert.equal(configured.details.scope, 'user');
  assert.equal(configured.version, 'config-format:json');
  assert.equal(asRecord(configured.details.resolvedEntry)['transport'], 'stdio');

  const instructions = report.layers.instructions;
  assert.equal(instructions.verdict, 'degraded');
  assert.equal(instructions.evidence, 'absent');
  assert.ok(instructions.limitations.some((line) => line.includes('no public rule/instruction file path')));

  const orchestration = report.layers.orchestration;
  assert.equal(orchestration.verdict, 'degraded');
  assert.equal(orchestration.details.mode, 'explicit-workflow');
  assert.equal(orchestration.details.publicApi, null);
  assert.ok(orchestration.limitations.some((line) => line.includes('sessions/agents/swarm')));
});

test('openclaw config generates the documented stdio entry and applies it with authorization', async (t) => {
  const { root, home, adapter } = openclawFixture(t);
  mkdirSync(join(home, '.openclaw'), { recursive: true });
  const configPath = join(home, '.openclaw', 'openclaw.json');
  const original = `${JSON.stringify({ mcp: { servers: { other: { url: 'https://example.com/mcp', transport: 'streamable-http' } } } }, null, 2)}\n`;
  writeFileSync(configPath, original);

  const dry = await adapter.config({ target: { scope: 'user' }, mode: 'dry-run', root });
  assert.equal(dry.changes.length, 1);
  assert.equal(dry.changes[0]?.key, 'mcp.servers.ano');
  const entry = dry.changes[0]?.after as { transport: string; command: string; args: string[]; enabled: boolean };
  assert.equal(entry.transport, 'stdio');
  assert.equal(entry.command, process.execPath);
  assert.ok(entry.args[0]?.endsWith(join('dist', 'surface', 'mcp.js')));
  assert.equal(entry.enabled, true);
  assert.equal(readFileSync(configPath, 'utf8'), original);

  const applied = await adapter.config({ target: { scope: 'user' }, mode: 'apply', authorization: grantFor(root, 'openclaw'), root });
  assert.equal(applied.mode, 'apply');
  const written = JSON.parse(readFileSync(configPath, 'utf8')) as { mcp: { servers: Record<string, unknown> } };
  assert.ok(written.mcp.servers['other'], 'other MCP servers must be preserved');
  assert.equal(asRecord(written.mcp.servers['ano'])['transport'], 'stdio');
  assert.ok(existsSync(join(root, '.ano', 'clients', 'backups', 'openclaw')));
});

test('openclawConfigTarget exposes the documented mapping', () => {
  const target = openclawConfigTarget('user', { home: resolve('/tmp/ano-home'), root: resolve('/tmp/ano-root') });
  assert.equal(target.clientId, 'openclaw');
  assert.equal(target.format, 'json');
  assert.deepEqual(target.serverPath, ['mcp', 'servers']);
  assert.equal(target.serverName, 'ano');
  assert.equal(target.path, resolve(join('/tmp/ano-home', '.openclaw', 'openclaw.json')));
});

// ---------------------------------------------------------------------------
// 5. Hermes Agent
// ---------------------------------------------------------------------------

function hermesFixture(t: TestContext): { root: string; home: string; bin: string; adapter: ClientAdapter; options: HermesAgentAdapterOptions } {
  const { root, home, bin } = fixture(t);
  const options: HermesAgentAdapterOptions = { home, root, probePaths: [bin], env: {}, now: () => AT };
  return { root, home, bin, adapter: createHermesAgentAdapter(options), options };
}

test('hermes detect probes the declared CLI, config and SOUL.md candidates', async (t) => {
  const { home, bin, adapter } = hermesFixture(t);
  const absent = await adapter.detect({ env: {}, probePaths: [bin] });
  assert.equal(absent.detected, false);

  installExecutable(bin, 'hermes');
  mkdirSync(join(home, '.hermes'), { recursive: true });
  writeFileSync(join(home, '.hermes', 'config.yaml'), 'mcp_servers: {}\n');
  writeFileSync(join(home, '.hermes', 'SOUL.md'), '# Soul\n');

  const installed = await adapter.detect({ env: {}, probePaths: [bin] });
  assert.equal(installed.detected, true);
  assert.equal(installed.executablePath, join(bin, 'hermes'));
  assert.ok(installed.sources.some((source) => source.source.includes('config.yaml')));
  assert.ok(installed.sources.some((source) => source.source.includes('SOUL.md')));
});

test('hermes inspect degrades the YAML config carrier and never claims local takeover', async (t) => {
  const { root, home, bin, adapter } = hermesFixture(t);
  installExecutable(bin, 'hermes');
  mkdirSync(join(home, '.hermes'), { recursive: true });
  writeFileSync(join(home, '.hermes', 'config.yaml'), 'mcp_servers: {}\n');
  writeFileSync(join(home, '.hermes', 'SOUL.md'), '# Soul\n');
  writeFileSync(join(root, 'AGENTS.md'), managedRule());

  const report = await adapter.inspect({ root, env: {} });
  assert.equal(report.layers.detected.verdict, 'validated');

  const configured = report.layers.configured;
  assert.equal(configured.verdict, 'degraded');
  assert.equal(configured.evidence, 'absent');
  assert.equal(configured.details.exists, false);
  assert.ok(configured.limitations.some((line) => line.includes('YAML')));
  assert.ok(configured.limitations.some((line) => line.includes('待核实')));

  const instructions = report.layers.instructions;
  assert.equal(instructions.verdict, 'degraded');
  assert.equal(instructions.evidence, 'measured');
  assert.ok(instructions.details.rulePaths.some((path) => path.endsWith('AGENTS.md')));
  assert.ok(instructions.details.rulePaths.some((path) => path.endsWith('SOUL.md')));
  assert.equal(instructions.details.hasManagedSection, true);

  assert.equal(report.layers.orchestration.verdict, 'degraded');
  assert.equal(report.layers.orchestration.details.mode, 'explicit-workflow');
  assert.equal(report.layers['output-interception'].verdict, 'unavailable');
  assert.ok(report.limitations.some((line) => /cloud-portal/i.test(line)));
});

test('hermes config refuses YAML, declares no candidate, and writes nothing', async (t) => {
  const { root, home, adapter } = hermesFixture(t);
  mkdirSync(join(home, '.hermes'), { recursive: true });
  const configPath = join(home, '.hermes', 'config.yaml');
  const original = 'mcp_servers: {}\n';
  writeFileSync(configPath, original);

  const result = await adapter.config({ target: { scope: 'user' }, mode: 'apply', authorization: grantFor(root, 'hermes-agent'), root });
  assert.equal(result.mode, 'dry-run');
  assert.deepEqual(result.changes, []);
  assert.equal(result.backupPlan, null);
  assert.equal(readFileSync(configPath, 'utf8'), original, 'YAML config is never written');
  assert.ok(result.warnings.some((line) => line.includes('YAML')));
  assert.ok(result.warnings.some((line) => line.includes('零 write') || line.includes('zero write')));
  assert.equal(defaultRegistry.get('hermes-agent').configCandidates.length, 0, 'no YAML candidate may be declared');

  const entry = hermesDesiredEntry() as { command: string; args: string[]; env: Record<string, unknown> };
  assert.equal(entry.command, process.execPath);
  assert.ok(entry.args[0]?.endsWith(join('dist', 'surface', 'mcp.js')));
});

// ---------------------------------------------------------------------------
// 6. Layering, non-amplification, verify delegation
// ---------------------------------------------------------------------------

test('all four adapters keep inspect read-only and layer capabilities without amplification', async (t) => {
  const cases: { id: ClientId; adapter: ClientAdapter; root: string; home: string; bin: string }[] = [];
  const cline = clineFixture(t);
  const kilo = kiloFixture(t);
  const openclaw = openclawFixture(t);
  const hermes = hermesFixture(t);
  installExecutable(kilo.bin, 'kilo');
  installExecutable(openclaw.bin, 'openclaw');
  installExecutable(hermes.bin, 'hermes');
  mkdirSync(join(cline.home, '.cline', 'data', 'settings'), { recursive: true });
  writeFileSync(join(cline.home, '.cline', 'data', 'settings', 'cline_mcp_settings.json'), '{}\n');
  mkdirSync(join(openclaw.home, '.openclaw'), { recursive: true });
  writeFileSync(join(openclaw.home, '.openclaw', 'openclaw.json'), '{}\n');
  mkdirSync(join(hermes.home, '.hermes'), { recursive: true });
  writeFileSync(join(hermes.home, '.hermes', 'config.yaml'), '{}\n');
  cases.push(
    { id: 'cline', adapter: cline.adapter, root: cline.root, home: cline.home, bin: cline.bin },
    { id: 'kilo-code', adapter: kilo.adapter, root: kilo.root, home: kilo.home, bin: kilo.bin },
    { id: 'openclaw', adapter: openclaw.adapter, root: openclaw.root, home: openclaw.home, bin: openclaw.bin },
    { id: 'hermes-agent', adapter: hermes.adapter, root: hermes.root, home: hermes.home, bin: hermes.bin },
  );

  for (const entry of cases) {
    const report = await entry.adapter.inspect({ root: entry.root, env: {} });
    assert.equal(report.clientId, entry.id);
    assert.notEqual(report.coreVerdict, 'validated', `${entry.id} inspect must not validate the core chain`);
    for (const layer of ['mcp', 'tools', 'brief'] as const) {
      assert.equal(report.layers[layer].verdict, 'unavailable', `${entry.id}.${layer} must be unmeasured in inspect`);
    }
    assert.equal(report.layers.orchestration.verdict, 'degraded');
    assert.equal(report.layers.orchestration.details.mode, 'explicit-workflow');
    assert.equal(report.layers.orchestration.details.measured, false);
    assert.equal(report.layers.history.verdict, 'unavailable');
    assert.equal(report.layers['output-interception'].verdict, 'unavailable');
    assert.ok(report.limitations.some((line) => line.includes('not imply')));
  }
});

test('verify delegates to the real stdio handshake and stops amplification on failure', async (t) => {
  const adapters: readonly ClientAdapter[] = [
    createClineAdapter(),
    createKiloCodeAdapter(),
    createOpenClawAdapter(),
    createHermesAgentAdapter(),
  ];
  for (const adapter of adapters) {
    const ok = await adapter.verify({ transport: 'stdio', inject: injectedClient() });
    assert.equal(ok.verdicts.mcp, 'validated');
    assert.equal(ok.verdicts.tools, 'validated');
    assert.equal(ok.verdicts.brief, 'validated');
    assert.deepEqual(ok.tools?.names, [...MCP_TOOL_NAMES]);

    const failed = await adapter.verify({ transport: 'stdio', inject: injectedClient({ failHandshake: true }) });
    assert.equal(failed.handshake, null);
    assert.equal(failed.verdicts.mcp, 'unavailable');
    assert.equal(failed.verdicts.tools, 'unavailable');
    assert.equal(failed.verdicts.brief, 'unavailable');
    assert.equal(failed.errors[0]?.code, 'E3_HANDSHAKE_FAILED');
  }
});

// ---------------------------------------------------------------------------
// 7. Configuration content is data, never executed
// ---------------------------------------------------------------------------

test('adapter sources never spawn, exec, eval or dynamically import configuration content', () => {
  const sources = ['cline.ts', 'kilo-code.ts', 'openclaw.ts', 'hermes-agent.ts'];
  const forbidden = /\b(child_process|spawn|execSync|execFile|eval|new Function|import)\s*\(/u;
  for (const name of sources) {
    const text = readFileSync(resolve('src', 'clients', name), 'utf8');
    assert.equal(forbidden.test(text), false, `${name} must not execute configuration content`);
    assert.equal(text.includes("from 'node:child_process'"), false, `${name} must not import child_process`);
  }
});

test('a malicious configured command is reported as data and never executed', async (t) => {
  const { root, home, bin, adapter } = clineFixture(t);
  const marker = join(root, 'pwned.txt');
  const malicious = process.execPath;
  const maliciousArgs = ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'pwned')`];
  const settingsDir = join(home, '.cline', 'data', 'settings');
  mkdirSync(settingsDir, { recursive: true });
  const configPath = join(settingsDir, 'cline_mcp_settings.json');
  writeFileSync(configPath, `${JSON.stringify({ mcpServers: { ano: { command: malicious, args: maliciousArgs } } })}\n`);

  const report = await adapter.inspect({ root, env: {} });
  const entry = report.layers.configured.details.resolvedEntry as { command: string; args: string[] };
  assert.equal(entry.command, malicious, 'the configured command is surfaced as inert data');
  assert.deepEqual(entry.args, maliciousArgs);

  const dry = await adapter.config({ target: { scope: 'user' }, mode: 'dry-run', root });
  assert.ok(dry.changes.length >= 0);
  assert.equal(existsSync(marker), false, 'configuration content must never be executed');
  assert.deepEqual(readdirSync(root).sort(), ['home', 'bin'].sort(), 'inspect/config must not create files');
});

// ---------------------------------------------------------------------------
// 8. Failure isolation and default zero-write
// ---------------------------------------------------------------------------

test('malformed configs are isolated per client and inspect never throws', async (t) => {
  const { root, home, adapter } = clineFixture(t);
  const settingsDir = join(home, '.cline', 'data', 'settings');
  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(join(settingsDir, 'cline_mcp_settings.json'), '{ broken');
  const clineReport = await adapter.inspect({ root, env: {} });
  assert.equal(clineReport.layers.configured.verdict, 'degraded');
  assert.ok(clineReport.errors.some((error) => error.code === 'E2_PARSE_FAILED'));

  const kilo = kiloFixture(t);
  installExecutable(kilo.bin, 'kilo');
  writeFileSync(join(kilo.root, 'kilo.jsonc'), 'not json at all');
  const kiloReport = await kilo.adapter.inspect({ root: kilo.root, env: {} });
  assert.equal(kiloReport.layers.configured.verdict, 'degraded');

  const openclaw = openclawFixture(t);
  mkdirSync(join(openclaw.home, '.openclaw'), { recursive: true });
  writeFileSync(join(openclaw.home, '.openclaw', 'openclaw.json'), '{ broken');
  const openclawReport = await openclaw.adapter.inspect({ root: openclaw.root, env: {} });
  assert.ok(openclawReport.layers.configured.errors.some((error) => error.code === 'E2_PARSE_FAILED'));
});

test('detect honours an aborted signal and reports an isolated error', async (t) => {
  const { adapter } = clineFixture(t);
  const controller = new AbortController();
  controller.abort();
  const result = await adapter.detect({ env: {}, probePaths: [], signal: controller.signal });
  assert.equal(result.detected, false);
  assert.equal(result.errors[0]?.code, 'E1_ABORTED');
});

test('detect, inspect and dry-run config are zero-write on a fresh root for all four adapters', async (t) => {
  const cline = clineFixture(t);
  const kilo = kiloFixture(t);
  const openclaw = openclawFixture(t);
  const hermes = hermesFixture(t);
  const cases = [
    { adapter: cline.adapter, root: cline.root },
    { adapter: kilo.adapter, root: kilo.root },
    { adapter: openclaw.adapter, root: openclaw.root },
    { adapter: hermes.adapter, root: hermes.root },
  ];
  for (const entry of cases) {
    const before = readdirSync(entry.root).sort();
    await entry.adapter.detect({ env: {}, cwd: entry.root, probePaths: [] });
    await entry.adapter.inspect({ root: entry.root, env: {} });
    const dry = await entry.adapter.config({ target: { scope: 'project' }, mode: 'dry-run', root: entry.root });
    assert.equal(dry.mode, 'dry-run');
    assert.deepEqual(readdirSync(entry.root).sort(), before, `${entry.adapter.id} must not create files`);
    assert.equal(existsSync(join(entry.root, '.ano')), false, `${entry.adapter.id} must not create .ano state`);
  }
});

test('config refuses a non-json format instead of guessing a carrier', async (t) => {
  const { root, adapter } = openclawFixture(t);
  const result = await adapter.config({ target: { scope: 'user', format: 'toml' }, mode: 'dry-run', root });
  assert.equal(result.mode, 'dry-run');
  assert.deepEqual(result.changes, []);
  assert.ok(result.warnings.some((line) => line.includes('json')));
});
