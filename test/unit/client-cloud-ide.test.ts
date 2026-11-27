import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  CAPABILITY_LAYERS,
  CLIENT_REPORT_SCHEMA,
  MCP_TOOL_COUNT,
  MCP_TOOL_NAMES,
  type ClientAuthorizationRef,
  type ConfigInput,
  type LayerReport,
  type LayerReports,
  type McpClientLike,
} from '../../src/clients/types.ts';
import { ANTIGRAVITY_AUTOMATION_NOTE, ANTIGRAVITY_IDENTITY_SOURCES, antigravityAdapter } from '../../src/clients/antigravity.ts';
import { CODEBUDDY_IDENTITY_SOURCES, codebuddyAdapter } from '../../src/clients/codebuddy.ts';
import { REPLIT_AGENT_CLOUD_ONLY_NOTE, replitAgentAdapter } from '../../src/clients/replit-agent.ts';
import { TRAE_IDENTITY_SOURCES, traeAdapter } from '../../src/clients/trae.ts';
import { defaultRegistry, resolveClientId } from '../../src/clients/registry.ts';

const AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function rootFor(t: TestContext, prefix = 'ano-cloud-ide-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function fakeExecutable(root: string, name: string): string {
  const bin = join(root, `bin-${name}`);
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, name), '#!/usr/bin/env node\nprocess.exit(0);\n');
  return bin;
}

function envFor(home: string, bin: string): Record<string, string> {
  return { HOME: home, PATH: `${bin}${delimiter}${dirname(process.execPath)}` };
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function authorization(root: string, clientId: string, withStatement = true): ClientAuthorizationRef {
  const base = {
    authorizationId: 'a'.repeat(64),
    root,
    clientId,
    scope: ['config', 'install'],
    grantedBy: 'Alice',
    grantedAt: '2026-11-23T00:00:00.000Z',
    revokedAt: null,
  };
  return (withStatement ? { ...base, statement: `Authorize ANO ${clientId} configuration for this project` } : base) as ClientAuthorizationRef;
}

function configInput(overrides: Partial<ConfigInput> & { env?: Record<string, string> }): ConfigInput {
  return { target: { scope: 'project' }, mode: 'dry-run', ...overrides } as ConfigInput;
}

function injectedClient(options: {
  tools?: readonly string[];
  failHandshake?: boolean;
  brief?: Record<string, unknown> | 'error' | 'no-context';
}): McpClientLike {
  return {
    initialize: async () => {
      if (options.failHandshake === true) throw new Error('handshake refused');
      return { protocolVersion: '2025-06-18', serverInfo: { name: 'injected-ano', version: '1.0.0' } };
    },
    listTools: async () => ({
      tools: (options.tools ?? MCP_TOOL_NAMES).map((name) => ({ name, inputSchema: { type: 'object' } })),
    }),
    callTool: async (request) => {
      if (request.name !== 'brief') return { isError: true, content: [{ type: 'text', text: 'unknown tool' }] };
      if (options.brief === 'error') return { isError: true, content: [{ type: 'text', text: 'brief failed' }] };
      const payload = options.brief === 'no-context' ? { phase: 'P0' } : options.brief ?? { phase: 'P7', project_scope: 'local' };
      return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
    },
    close: async () => {},
  };
}

const FAKE_SERVER = `
const mode = process.argv[2] || 'ok';
const tools = ['brief','explore','recall','track','note','verify','audit'];
let buffer = '';
function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n'); }
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.method === 'initialize') {
      if (mode === 'exit') process.exit(0);
      reply(message.id, { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake-ano', version: '1.0.0' } });
    } else if (message.method === 'tools/list') {
      const names = mode === 'six' ? tools.filter((name) => name !== 'audit') : tools;
      reply(message.id, { tools: names.map((name) => ({ name, inputSchema: { type: 'object' } })) });
    } else if (message.method === 'tools/call' && message.params && message.params.name === 'brief') {
      reply(message.id, { content: [{ type: 'text', text: JSON.stringify({ phase: 'P7', project_scope: 'local' }) }] });
    }
  }
});
`;

function assertNineLayers(report: { readonly layers: LayerReports }): void {
  assert.deepEqual(Object.keys(report.layers).sort(), [...CAPABILITY_LAYERS].sort());
  for (const layer of CAPABILITY_LAYERS) {
    const entry: LayerReport = report.layers[layer] as LayerReport;
    assert.equal(entry.layer, layer);
    assert.ok(entry.verdict === 'validated' || entry.verdict === 'degraded' || entry.verdict === 'unavailable');
    assert.ok(entry.evidence === 'measured' || entry.evidence === 'configured' || entry.evidence === 'assumed' || entry.evidence === 'absent');
    assert.equal(typeof entry.at, 'string');
    assert.equal(typeof entry.source, 'string');
    assert.ok(Array.isArray(entry.limitations));
    assert.ok(Array.isArray(entry.errors));
  }
}

// ---------------------------------------------------------------------------
// Identity / contract
// ---------------------------------------------------------------------------

test('four adapters expose stable ids, seven-tool surface and declared sources', () => {
  assert.equal(MCP_TOOL_COUNT, 7);
  assert.equal(MCP_TOOL_NAMES.length, 7);
  assert.deepEqual([traeAdapter.id, antigravityAdapter.id, replitAgentAdapter.id, codebuddyAdapter.id], [
    'trae',
    'antigravity',
    'replit-agent',
    'codebuddy',
  ]);
  for (const adapter of [traeAdapter, antigravityAdapter, replitAgentAdapter, codebuddyAdapter]) {
    assert.ok(Array.isArray(adapter.identitySources));
    assert.equal(typeof adapter.detect, 'function');
    assert.equal(typeof adapter.inspect, 'function');
    assert.equal(typeof adapter.config, 'function');
    assert.equal(typeof adapter.verify, 'function');
    const descriptor = defaultRegistry.get(adapter.id);
    assert.equal(descriptor.initialVerdict, 'unverified');
  }
  assert.equal(TRAE_IDENTITY_SOURCES.length, 1);
  assert.equal(TRAE_IDENTITY_SOURCES[0]?.value, '.trae/mcp.json');
  // Registry-owned Trae metadata stays untouched (T-092); the adapter declares
  // its public source independently and never guesses a user-level path.
  assert.ok(defaultRegistry.get('trae').configCandidates.every((candidate) => candidate.path.startsWith('<root>')));
  // Registry-declared Antigravity sources are a subset of the adapter's public sources.
  for (const source of defaultRegistry.get('antigravity').identitySources) {
    assert.ok(
      ANTIGRAVITY_IDENTITY_SOURCES.some((declared) => declared.kind === source.kind && declared.value === source.value),
      `missing declared Antigravity source ${source.value}`,
    );
  }
  for (const source of defaultRegistry.get('codebuddy').identitySources) {
    assert.ok(
      CODEBUDDY_IDENTITY_SOURCES.some((declared) => declared.kind === source.kind && declared.value === source.value),
      `missing declared CodeBuddy source ${source.value}`,
    );
  }
});

test('cbc is a CLI command alias, not a ClientId alias', () => {
  assert.equal(resolveClientId('cbc'), null);
  assert.equal(codebuddyAdapter.id, 'codebuddy');
  assert.ok(CODEBUDDY_IDENTITY_SOURCES.some((source) => source.kind === 'executable' && source.value === 'cbc'));
  assert.equal(defaultRegistry.get('codebuddy').alias, null);
});

test('antigravity never declares browser automation as an MCP source', () => {
  assert.ok(ANTIGRAVITY_AUTOMATION_NOTE.includes('browser automation is not MCP support'));
  for (const source of ANTIGRAVITY_IDENTITY_SOURCES) {
    assert.equal(source.value.toLowerCase().includes('browser'), false, `unexpected browser source ${source.value}`);
  }
});

// ---------------------------------------------------------------------------
// Trae
// ---------------------------------------------------------------------------

test('trae detect finds only the declared project MCP config and never guesses an executable', async (t) => {
  const root = rootFor(t);
  const home = join(root, 'home');
  mkdirSync(home);
  const bin = fakeExecutable(root, 'trae');
  const env = envFor(home, bin);

  const absent = await traeAdapter.detect({ env, cwd: root, probePaths: [bin] });
  assert.equal(absent.detected, false);
  assert.deepEqual(absent.sources, []);

  writeJson(join(root, '.trae', 'mcp.json'), { mcpServers: {} });
  const detected = await traeAdapter.detect({ env, cwd: root, probePaths: [bin] });
  assert.equal(detected.detected, true);
  assert.equal(detected.executablePath, null);
  assert.equal(detected.sources.length, 1);
  assert.equal(detected.sources[0]?.kind, 'config-path');
  assert.equal(detected.sources[0]?.source.includes(join('.trae', 'mcp.json')), true);
  assert.match(detected.sources[0]?.detectedAt ?? '', AT_RE);
});

test('trae inspect reports nine layers, degrades configured and never validates cloud capability', async (t) => {
  const root = rootFor(t);
  const home = join(root, 'home');
  mkdirSync(home);
  const bin = fakeExecutable(root, 'trae');
  const env = envFor(home, bin);

  const empty = await traeAdapter.inspect({ root, env, cwd: root });
  assert.equal(empty.schema, CLIENT_REPORT_SCHEMA);
  assertNineLayers(empty);
  assert.equal(empty.status, 'unavailable');
  assert.equal(empty.layers.detected.verdict, 'unavailable');
  assert.equal(empty.layers.configured.verdict, 'unavailable');
  assert.equal(empty.layers.mcp.verdict, 'unavailable');
  assert.equal(empty.layers.history.verdict, 'unavailable');
  assert.equal(empty.layers['output-interception'].verdict, 'unavailable');

  writeJson(join(root, '.trae', 'mcp.json'), {
    mcpServers: { ano: { command: 'node', args: [join(bin, 'server.js')] } },
    unknownTop: { keep: true },
  });
  const report = await traeAdapter.inspect({ root, env, cwd: root });
  assert.equal(report.status, 'degraded');
  assert.equal(report.layers.detected.verdict, 'degraded');
  assert.equal(report.layers.configured.verdict, 'degraded');
  assert.equal(report.layers.configured.evidence, 'configured');
  assert.equal(report.layers.configured.details.key, 'mcpServers.ano');
  assert.equal(report.layers.orchestration.verdict, 'degraded');
  assert.equal(report.layers.orchestration.details.mode, 'explicit-workflow');
  assert.ok(report.limitations.some((line) => line.includes('cloud/Web capability is not local control')));
  assert.ok(report.layers.configured.limitations.some((line) => line.includes('user-level Trae MCP config')));
  assert.equal(report.layers.mcp.verdict, 'unavailable');
  assert.equal(report.layers.tools.verdict, 'unavailable');
  assert.equal(report.layers.brief.verdict, 'unavailable');
});

test('trae config dry-run previews the merge and apply preserves other services', async (t) => {
  const root = rootFor(t);
  const home = join(root, 'home');
  mkdirSync(home);
  const bin = fakeExecutable(root, 'trae');
  const env = envFor(home, bin);
  const configPath = join(root, '.trae', 'mcp.json');
  const other = { command: 'other-bin', args: ['--serve'], nested: { keep: [1, 2, 3] } };
  writeJson(configPath, { mcpServers: { other }, unknownTop: { z: 1 } });
  const before = readFileSync(configPath);

  const dry = await traeAdapter.config(configInput({ mode: 'dry-run', root, env }));
  assert.equal(dry.mode, 'dry-run');
  assert.equal(dry.changes.length, 1);
  assert.equal(dry.changes[0]?.operation, 'add');
  assert.equal(dry.changes[0]?.key, 'mcpServers.ano');
  assert.deepEqual(readFileSync(configPath), before, 'dry-run must not write');
  assert.equal(existsSync(join(root, '.ano')), false);

  const applied = await traeAdapter.config(configInput({
    mode: 'apply',
    root,
    env,
    authorization: authorization(root, 'trae'),
  }));
  assert.equal(applied.mode, 'apply');
  assert.equal(applied.afterHash === '', false);
  const document = readJson(configPath);
  assert.deepEqual(document['mcpServers'], {
    other,
    ano: { command: 'node', args: [(applied.changes[0]?.after as { args: string[] }).args[0]] },
  });
  assert.deepEqual(document['unknownTop'], { z: 1 });
  assert.equal(existsSync(join(root, '.ano', 'clients', 'backups', 'trae')), true);

  const replay = await traeAdapter.config(configInput({
    mode: 'apply',
    root,
    env,
    authorization: authorization(root, 'trae'),
  }));
  assert.equal(replay.mode, 'dry-run');
  if (replay.mode === 'dry-run') assert.deepEqual(replay.changes, []);
});

test('trae config refuses user scope and missing authorization with zero write', async (t) => {
  const root = rootFor(t);
  const home = join(root, 'home');
  mkdirSync(home);
  const bin = fakeExecutable(root, 'trae');
  const env = envFor(home, bin);
  const configPath = join(root, '.trae', 'mcp.json');
  writeJson(configPath, { mcpServers: {} });
  const before = readFileSync(configPath);

  const user = await traeAdapter.config(configInput({ mode: 'apply', root, env, target: { scope: 'user' } }));
  assert.equal(user.mode, 'dry-run');
  assert.ok(user.warnings.some((line) => line.includes('zero write')));

  const missing = await traeAdapter.config(configInput({ mode: 'apply', root, env }));
  assert.equal(missing.mode, 'dry-run');
  assert.ok(missing.warnings.some((line) => line.includes('apply refused')));
  assert.deepEqual(readFileSync(configPath), before);
  assert.equal(existsSync(join(root, '.ano')), false);
});

// ---------------------------------------------------------------------------
// Antigravity
// ---------------------------------------------------------------------------

test('antigravity detect finds the agy executable and declared config/plugin paths only', async (t) => {
  const root = rootFor(t);
  const home = join(root, 'home');
  mkdirSync(home);
  const empty = await antigravityAdapter.detect({ env: { HOME: home, PATH: join(root, 'missing') }, cwd: root });
  assert.equal(empty.detected, false);
  assert.deepEqual(empty.sources, []);

  const bin = fakeExecutable(root, 'agy');
  const detected = await antigravityAdapter.detect({ env: { HOME: home, PATH: bin }, cwd: root, probePaths: [bin] });
  assert.equal(detected.detected, true);
  assert.equal(detected.executablePath, join(bin, 'agy'));
  assert.ok(detected.sources.some((source) => source.source === 'executable:agy'));

  mkdirSync(join(home, '.gemini', 'config'), { recursive: true });
  writeJson(join(home, '.gemini', 'config', 'mcp_config.json'), { mcpServers: {} });
  mkdirSync(join(root, '.agents', 'plugins'), { recursive: true });
  const withPaths = await antigravityAdapter.detect({ env: { HOME: home, PATH: bin }, cwd: root, probePaths: [bin] });
  assert.ok(withPaths.sources.some((source) => source.source.includes(join('.gemini', 'config', 'mcp_config.json'))));
  assert.ok(withPaths.sources.some((source) => source.source.includes(join('.agents', 'mcp_config.json')) === false));
  assert.ok(withPaths.sources.some((source) => source.source.includes(join('.agents', 'plugins'))));
});

test('antigravity inspect separates MCP from browser automation and keeps unsupported layers unavailable', async (t) => {
  const root = rootFor(t);
  const home = join(root, 'home');
  mkdirSync(home);
  const bin = fakeExecutable(root, 'agy');
  const env = envFor(home, bin);
  writeJson(join(root, '.agents', 'mcp_config.json'), { mcpServers: { ano: { command: 'node', args: [join(bin, 's.js')] } } });

  const report = await antigravityAdapter.inspect({ root, env, cwd: root });
  assert.equal(report.schema, CLIENT_REPORT_SCHEMA);
  assertNineLayers(report);
  assert.equal(report.status, 'degraded');
  assert.equal(report.layers.detected.verdict, 'degraded');
  assert.equal(report.layers.configured.verdict, 'degraded');
  assert.equal(report.layers.configured.details.key, 'mcpServers.ano');
  assert.equal(report.layers.orchestration.verdict, 'degraded');
  assert.equal(report.layers.orchestration.details.mode, 'explicit-workflow');
  assert.ok(report.layers.orchestration.limitations.includes(ANTIGRAVITY_AUTOMATION_NOTE));
  assert.ok(report.limitations.some((line) => line.includes('browser automation is not MCP support')));
  assert.equal(report.layers.mcp.verdict, 'unavailable');
  assert.equal(report.layers.tools.verdict, 'unavailable');
  assert.equal(report.layers.brief.verdict, 'unavailable');
  assert.equal(report.layers.history.verdict, 'unavailable');
  assert.equal(report.layers['output-interception'].verdict, 'unavailable');
});

test('antigravity config dry-run and apply write the declared mcp_config.json and preserve other services', async (t) => {
  const root = rootFor(t);
  const home = join(root, 'home');
  mkdirSync(home);
  const bin = fakeExecutable(root, 'agy');
  const env = envFor(home, bin);
  const workspacePath = join(root, '.agents', 'mcp_config.json');
  const other = { command: 'other', args: ['--x'] };
  writeJson(workspacePath, { mcpServers: { other }, unknownTop: 1 });
  const before = readFileSync(workspacePath);

  const dry = await antigravityAdapter.config(configInput({ mode: 'dry-run', root, env }));
  assert.equal(dry.mode, 'dry-run');
  assert.equal(dry.changes[0]?.key, 'mcpServers.ano');
  assert.deepEqual(readFileSync(workspacePath), before);
  assert.equal(existsSync(join(root, '.ano')), false);

  const applied = await antigravityAdapter.config(configInput({
    mode: 'apply',
    root,
    env,
    authorization: authorization(root, 'antigravity'),
  }));
  assert.equal(applied.mode, 'apply');
  const document = readJson(workspacePath);
  assert.deepEqual(document['mcpServers'], {
    other,
    ano: { command: 'node', args: [(applied.changes[0]?.after as { args: string[] }).args[0]] },
  });
  assert.equal(document['unknownTop'], 1);

  const userPath = join(home, '.gemini', 'config', 'mcp_config.json');
  writeJson(userPath, { mcpServers: {} });
  const user = await antigravityAdapter.config(configInput({
    mode: 'apply',
    root,
    env,
    target: { scope: 'user' },
    authorization: authorization(root, 'antigravity'),
  }));
  assert.equal(user.mode, 'apply');
  assert.equal(readJson(userPath)['mcpServers'] !== undefined, true);
});

test('antigravity verify performs a real stdio handshake and refuses to amplify on failure', async (t) => {
  const root = rootFor(t);
  const serverPath = join(root, 'fake-mcp-server.mjs');
  writeFileSync(serverPath, FAKE_SERVER);

  const ok = await antigravityAdapter.verify({ transport: 'stdio', command: process.execPath, args: [serverPath, 'ok'], root });
  assert.equal(ok.verdicts.mcp, 'validated');
  assert.equal(ok.tools?.count, MCP_TOOL_COUNT);
  assert.equal(ok.verdicts.tools, 'validated');
  assert.equal(ok.verdicts.brief, 'validated');

  const six = await antigravityAdapter.verify({ transport: 'stdio', command: process.execPath, args: [serverPath, 'six'], root });
  assert.equal(six.verdicts.tools, 'degraded');
  assert.deepEqual(six.tools?.missing, ['audit']);

  const exited = await antigravityAdapter.verify({ transport: 'stdio', command: process.execPath, args: [serverPath, 'exit'], root });
  assert.equal(exited.handshake, null);
  assert.equal(exited.verdicts.mcp, 'unavailable');
  assert.equal(exited.verdicts.tools, 'unavailable');
  assert.equal(exited.errors[0]?.code, 'E3_HANDSHAKE_FAILED');

  const injected = await antigravityAdapter.verify({ transport: 'stdio', inject: injectedClient({}) });
  assert.equal(injected.verdicts.mcp, 'validated');
  assert.equal(injected.verdicts.tools, 'validated');
  const failed = await antigravityAdapter.verify({ transport: 'stdio', inject: injectedClient({ failHandshake: true }) });
  assert.equal(failed.verdicts.mcp, 'unavailable');
});

// ---------------------------------------------------------------------------
// Replit Agent
// ---------------------------------------------------------------------------

test('replit-agent is cloud-only: detect is false and inspect never validates any layer', async (t) => {
  const root = rootFor(t);
  const home = join(root, 'home');
  mkdirSync(home);
  const env = envFor(home, join(root, 'missing'));

  const detect = await replitAgentAdapter.detect({ env, cwd: root, probePaths: [join(root, 'missing')] });
  assert.equal(detect.detected, false);
  assert.deepEqual(detect.sources, []);

  const report = await replitAgentAdapter.inspect({ root, env, cwd: root });
  assert.equal(report.schema, CLIENT_REPORT_SCHEMA);
  assertNineLayers(report);
  assert.equal(report.status, 'unavailable');
  assert.equal(report.coreVerdict, 'unavailable');
  for (const layer of CAPABILITY_LAYERS) {
    const entry: LayerReport = report.layers[layer] as LayerReport;
    assert.notEqual(entry.verdict, 'validated', `${layer} must never be validated for a cloud-only service`);
  }
  assert.equal(report.layers.detected.verdict, 'unavailable');
  assert.equal(report.layers.configured.verdict, 'unavailable');
  assert.equal(report.layers.mcp.verdict, 'unavailable');
  assert.equal(report.layers.tools.verdict, 'unavailable');
  assert.equal(report.layers.brief.verdict, 'unavailable');
  assert.equal(report.layers.instructions.verdict, 'unavailable');
  assert.equal(report.layers.orchestration.verdict, 'degraded');
  assert.equal(report.layers.orchestration.details.mode, 'explicit-workflow');
  assert.equal(report.layers.history.verdict, 'unavailable');
  assert.equal(report.layers['output-interception'].verdict, 'unavailable');
  assert.ok(report.limitations.some((line) => line.includes(REPLIT_AGENT_CLOUD_ONLY_NOTE)));
  assert.ok(report.layers.orchestration.limitations.some((line) => line.includes('cloud agent capability is not local control')));
});

test('replit-agent config never writes a local MCP config, even on apply', async (t) => {
  const root = rootFor(t);
  const home = join(root, 'home');
  mkdirSync(home);
  const env = envFor(home, join(root, 'missing'));

  const dry = await replitAgentAdapter.config(configInput({ mode: 'dry-run', root, env }));
  assert.equal(dry.mode, 'dry-run');
  assert.deepEqual(dry.changes, []);
  assert.equal(dry.backupPlan, null);
  assert.ok(dry.warnings.some((line) => line.includes(REPLIT_AGENT_CLOUD_ONLY_NOTE)));

  const applied = await replitAgentAdapter.config(configInput({
    mode: 'apply',
    root,
    env,
    authorization: authorization(root, 'replit-agent'),
  }));
  assert.equal(applied.mode, 'dry-run');
  assert.deepEqual(applied.changes, []);
  assert.ok(applied.warnings.some((line) => line.includes('zero write')));
  assert.deepEqual(readdirSync(root).sort(), ['home']);
  assert.equal(existsSync(join(root, '.mcp.json')), false);
  assert.equal(existsSync(join(root, '.ano')), false);
});

test('replit-agent verify proves only the injected mechanism and still reports cloud-only', async (t) => {
  const root = rootFor(t);
  const ok = await replitAgentAdapter.verify({ transport: 'stdio', inject: injectedClient({}), root });
  assert.equal(ok.verdicts.mcp, 'validated');
  assert.equal(ok.tools?.count, MCP_TOOL_COUNT);
  // A synthetic pass must not leak into the client report.
  const report = await replitAgentAdapter.inspect({ root, env: { HOME: root, PATH: root }, cwd: root });
  assert.equal(report.layers.mcp.verdict, 'unavailable');
  assert.equal(report.layers.configured.verdict, 'unavailable');
  assert.ok(report.limitations.some((line) => line.includes(REPLIT_AGENT_CLOUD_ONLY_NOTE)));
});

// ---------------------------------------------------------------------------
// CodeBuddy
// ---------------------------------------------------------------------------

test('codebuddy detect probes the codebuddy/cbc command aliases and declared config candidates', async (t) => {
  const root = rootFor(t);
  const home = join(root, 'home');
  mkdirSync(home);
  const absent = await codebuddyAdapter.detect({ env: { HOME: home, PATH: join(root, 'missing') }, cwd: root });
  assert.equal(absent.detected, false);

  const bin = fakeExecutable(root, 'codebuddy');
  const detected = await codebuddyAdapter.detect({ env: { HOME: home, PATH: bin }, cwd: root, probePaths: [bin] });
  assert.equal(detected.detected, true);
  assert.equal(detected.executablePath, join(bin, 'codebuddy'));
  assert.ok(detected.sources.some((source) => source.source === 'executable:codebuddy'));

  const cbcBin = fakeExecutable(root, 'cbc');
  const withAlias = await codebuddyAdapter.detect({ env: { HOME: home, PATH: cbcBin }, cwd: root, probePaths: [cbcBin] });
  assert.equal(withAlias.executablePath, join(cbcBin, 'cbc'));

  writeJson(join(home, '.codebuddy', '.mcp.json'), { mcpServers: {} });
  const withConfig = await codebuddyAdapter.detect({ env: { HOME: home, PATH: bin }, cwd: root, probePaths: [bin] });
  assert.ok(withConfig.sources.some((source) => source.source.includes(join('.codebuddy', '.mcp.json'))));
});

test('codebuddy inspect detects declared rule paths and keeps MCP layers unmeasured', async (t) => {
  const root = rootFor(t);
  const home = join(root, 'home');
  mkdirSync(home);
  const bin = fakeExecutable(root, 'codebuddy');
  const env = envFor(home, bin);
  writeJson(join(root, '.mcp.json'), { mcpServers: { ano: { command: 'node', args: [join(bin, 's.js')] } } });
  writeFileSync(join(root, 'CODEBUDDY.md'), 'rules\n');
  mkdirSync(join(root, 'rules'), { recursive: true });
  writeFileSync(join(root, 'rules', 'extra.md'), 'extra\n');

  const report = await codebuddyAdapter.inspect({ root, env, cwd: root });
  assert.equal(report.schema, CLIENT_REPORT_SCHEMA);
  assertNineLayers(report);
  assert.equal(report.status, 'degraded');
  assert.equal(report.layers.detected.verdict, 'degraded');
  assert.equal(report.layers.configured.verdict, 'degraded');
  assert.equal(report.layers.configured.details.key, 'mcpServers.ano');
  const instructions = report.layers.instructions;
  assert.equal(instructions.verdict, 'degraded');
  assert.equal(instructions.evidence, 'measured');
  assert.ok(instructions.details.rulePaths.some((path) => path.endsWith('CODEBUDDY.md')));
  assert.ok(instructions.details.rulePaths.some((path) => path.endsWith(join('rules', 'extra.md'))));
  assert.ok(instructions.limitations.some((line) => line.includes('unverified')));
  assert.equal(report.layers.mcp.verdict, 'unavailable');
  assert.equal(report.layers.orchestration.details.mode, 'explicit-workflow');
  assert.ok(report.limitations.some((line) => line.includes('cbc is a CLI command alias')));
});

test('codebuddy config dry-run and apply merge into the declared user/project config', async (t) => {
  const root = rootFor(t);
  const home = join(root, 'home');
  mkdirSync(home);
  const bin = fakeExecutable(root, 'codebuddy');
  const env = envFor(home, bin);
  const projectPath = join(root, '.mcp.json');
  const other = { command: 'other', args: [] };
  writeJson(projectPath, { mcpServers: { other }, unknownTop: 2 });
  const before = readFileSync(projectPath);

  const dry = await codebuddyAdapter.config(configInput({ mode: 'dry-run', root, env }));
  assert.equal(dry.mode, 'dry-run');
  assert.equal(dry.changes[0]?.key, 'mcpServers.ano');
  assert.ok(dry.warnings.some((line) => line.includes('unverified')));
  assert.deepEqual(readFileSync(projectPath), before);
  assert.equal(existsSync(join(root, '.ano')), false);

  const applied = await codebuddyAdapter.config(configInput({
    mode: 'apply',
    root,
    env,
    authorization: authorization(root, 'codebuddy'),
  }));
  assert.equal(applied.mode, 'apply');
  const document = readJson(projectPath);
  assert.deepEqual(document['mcpServers'], {
    other,
    ano: { command: 'node', args: [(applied.changes[0]?.after as { args: string[] }).args[0]] },
  });
  assert.equal(document['unknownTop'], 2);

  const userPath = join(home, '.codebuddy', 'mcp.json');
  writeJson(userPath, { mcpServers: {} });
  const user = await codebuddyAdapter.config(configInput({
    mode: 'apply',
    root,
    env,
    target: { scope: 'user' },
    authorization: authorization(root, 'codebuddy'),
  }));
  assert.equal(user.mode, 'apply');
  assert.equal(readJson(userPath)['mcpServers'] !== undefined, true);
});

test('codebuddy config refuses a missing authorization with zero write', async (t) => {
  const root = rootFor(t);
  const home = join(root, 'home');
  mkdirSync(home);
  const bin = fakeExecutable(root, 'codebuddy');
  const env = envFor(home, bin);
  const projectPath = join(root, '.mcp.json');
  writeJson(projectPath, { mcpServers: {} });
  const before = readFileSync(projectPath);

  const missing = await codebuddyAdapter.config(configInput({ mode: 'apply', root, env }));
  assert.equal(missing.mode, 'dry-run');
  assert.ok(missing.warnings.some((line) => line.includes('apply refused')));
  assert.deepEqual(readFileSync(projectPath), before);
  assert.equal(existsSync(join(root, '.ano')), false);
});

// ---------------------------------------------------------------------------
// Cross-adapter isolation / zero write
// ---------------------------------------------------------------------------

test('all four adapters leave an empty injected root untouched on detect/inspect/dry-run', async (t) => {
  for (const adapter of [traeAdapter, antigravityAdapter, replitAgentAdapter, codebuddyAdapter]) {
    await t.test(`${adapter.id} read-only probe`, async (t) => {
      const root = rootFor(t, `ano-cloud-${adapter.id}-`);
      const home = join(root, 'home');
      mkdirSync(home);
      const env = { HOME: home, PATH: join(root, 'missing-bin') };
      await adapter.detect({ env, cwd: root, probePaths: [join(root, 'missing-bin')] });
      await adapter.inspect({ root, env, cwd: root });
      const dry = await adapter.config(configInput({ mode: 'dry-run', root, env }));
      assert.equal(dry.mode, 'dry-run');
      assert.deepEqual(readdirSync(root).sort(), ['home']);
      assert.deepEqual(readdirSync(home), []);
      assert.equal(existsSync(join(root, '.ano')), false);
    });
  }
});

test('verify failure isolation: handshake failure never amplifies to tools or brief', async (t) => {
  for (const adapter of [traeAdapter, codebuddyAdapter]) {
    await t.test(`${adapter.id} handshake failure`, async () => {
      const failed = await adapter.verify({ transport: 'stdio', inject: injectedClient({ failHandshake: true }) });
      assert.equal(failed.handshake, null);
      assert.equal(failed.verdicts.mcp, 'unavailable');
      assert.equal(failed.verdicts.tools, 'unavailable');
      assert.equal(failed.verdicts.brief, 'unavailable');
      assert.equal(failed.errors[0]?.code, 'E3_HANDSHAKE_FAILED');
    });
  }
});
