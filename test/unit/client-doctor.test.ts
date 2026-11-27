import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  CAPABILITY_LAYERS,
  CLIENT_ALIAS_TARGET,
  CLIENT_IDS,
  CLIENT_REPORT_SCHEMA,
  DOCTOR_REPORT_SCHEMA,
  EVIDENCE_CODE_LAYER,
  MCP_TOOL_NAMES,
  type CapabilityLayer,
  type ClientAdapter,
  type ClientDescriptor,
  type ClientId,
  type ClientReport,
  type ClientVerdict,
  type DetectResult,
  type IsolatedError,
  type LayerReport,
  type McpClientLike,
  type VerifyResult,
} from '../../src/clients/types.ts';
import { createRegistry, defaultRegistry, resolveClientId, UnknownClientError } from '../../src/clients/registry.ts';
import {
  discoverClientConfig,
  doctorClients,
  genericDetect,
  unavailableLayerReports,
  verifyStdioMcp,
} from '../../src/clients/doctor.ts';

const AT = '2026-11-22T00:00:00.000Z';

/** ADR-008 §3 stable ids, in catalog order. */
const ADR_008_TOOL_IDS: readonly string[] = [
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
];

/** M11 legacy clients that are deliberately outside the 21-tool catalog. */
const M11_LEGACY_IDS: readonly string[] = ['opencode', 'pi', 'zcode'];

const CANONICAL_CLIENT_IDS: readonly string[] = [...ADR_008_TOOL_IDS, ...M11_LEGACY_IDS];

/** Catalog entries reused from M11; their descriptor notes keep the M11 wording. */
const M11_REUSED_TOOL_IDS: readonly string[] = ['claude-code', 'cursor', 'codex', 'qoder'];

/** Catalog entries first introduced by ADR-008; their notes must say 待核实/未实测. */
const NEW_TOOL_IDS: readonly string[] = ADR_008_TOOL_IDS.filter((id) => !M11_REUSED_TOOL_IDS.includes(id));

async function temp(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
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
    tools: { count: MCP_TOOL_NAMES.length, names: [...MCP_TOOL_NAMES], missing: [], extra: [] },
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

function goodAdapter(id: ClientId, at: string = AT): ClientAdapter {
  const layers = unavailableLayerReports(at, `fake:${id}`);
  const detect: DetectResult = {
    clientId: id,
    detected: true,
    executablePath: `/fake/${id}`,
    version: '1.0.0',
    sources: [
      {
        source: `executable:${id}`,
        kind: 'executable',
        executablePath: `/fake/${id}`,
        version: '1.0.0',
        detectedAt: at,
      },
    ],
    errors: [],
  };
  return {
    id,
    identitySources: [],
    detect: async () => detect,
    inspect: async () => ({
      schema: CLIENT_REPORT_SCHEMA,
      clientId: id,
      alias: null,
      status: 'degraded',
      coreVerdict: 'unavailable',
      layers: { ...layers },
      generatedAt: at,
      limitations: [],
      errors: [],
    }),
    config: async () => ({ mode: 'dry-run', changes: [], backupPlan: null, warnings: [] }),
    verify: async () => ({ handshake: null, tools: null, brief: null, verdicts: emptyVerdicts(), errors: [] }),
  };
}

function failingAdapter(id: ClientId): ClientAdapter {
  return {
    id,
    identitySources: [],
    detect: async () => {
      throw new Error('detect exploded');
    },
    inspect: async () => {
      throw new Error('inspect exploded');
    },
    config: async () => {
      throw new Error('config exploded');
    },
    verify: async () => {
      throw new Error('verify exploded');
    },
  };
}

function injectedClient(options: {
  tools?: readonly string[];
  brief?: Record<string, unknown> | 'error' | 'no-context';
  failHandshake?: boolean;
}): McpClientLike {
  return {
    initialize: async () => {
      if (options.failHandshake === true) throw new Error('handshake refused');
      return { protocolVersion: '2025-06-18', serverInfo: { name: 'injected', version: '1.0.0' } };
    },
    listTools: async () => ({
      tools: (options.tools ?? MCP_TOOL_NAMES).map((name) => ({ name, inputSchema: { type: 'object' } })),
    }),
    callTool: async (request) => {
      if (request.name !== 'brief') return { isError: true, content: [{ type: 'text', text: 'unknown tool' }] };
      if (options.brief === 'error') return { isError: true, content: [{ type: 'text', text: 'brief failed' }] };
      const payload =
        options.brief === 'no-context'
          ? { phase: 'P0' }
          : options.brief ?? { phase: 'P7', project_scope: 'local', hostCapability: 'degraded' };
      return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
    },
    close: async () => {},
  };
}

const FAKE_SERVER_SOURCE = `
const mode = process.argv[2] || 'ok';
const tools = ['brief','explore','recall','track','note','verify','audit'];
if (mode === 'exit') process.exit(0);
let buffer = '';
function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
}
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
      if (mode === 'silent') continue;
      if (mode === 'garbage') {
        process.stdout.write('this is not json\\n');
        continue;
      }
      if (mode === 'init-error') {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'initialize boom' } }) + '\\n');
        continue;
      }
      if (mode === 'minimal-init') {
        reply(message.id, {});
        continue;
      }
      reply(message.id, {
        protocolVersion: '2025-06-18',
        capabilities: {},
        serverInfo: { name: 'fake-ano', version: '1.0.0' },
      });
    } else if (message.method === 'notifications/initialized') {
      // notification, no response
    } else if (message.method === 'tools/list') {
      if (mode === 'fail-tools') {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'tools boom' } }) + '\\n');
        continue;
      }
      const names = mode === 'six' ? tools.filter((name) => name !== 'audit') : tools;
      reply(message.id, { tools: names.map((name) => ({ name, inputSchema: { type: 'object', properties: {} } })) });
    } else if (message.method === 'tools/call') {
      if (message.params && message.params.name === 'brief') {
        if (mode === 'fail-brief') {
          reply(message.id, { isError: true, content: [{ type: 'text', text: 'brief failed' }] });
          continue;
        }
        if (mode === 'no-context') {
          reply(message.id, { content: [{ type: 'text', text: JSON.stringify({ phase: 'P0' }) }] });
          continue;
        }
        reply(message.id, {
          content: [{
            type: 'text',
            text: JSON.stringify({ phase: 'P7', project_scope: 'local', memory_context: { context_id: 'ctx-1' }, hostCapability: 'degraded' }),
          }],
        });
      } else {
        reply(message.id, { isError: true, content: [{ type: 'text', text: 'unknown tool' }] });
      }
    }
  }
});
`;

async function fakeServer(): Promise<string> {
  const directory = await temp('ano doctor stdio ');
  const serverPath = join(directory, 'fake-mcp-server.mjs');
  await writeFile(serverPath, FAKE_SERVER_SOURCE);
  return serverPath;
}

function assertReportShape(report: { clients: readonly ClientReport[] }): void {
  for (const client of report.clients) {
    assert.equal(client.schema, CLIENT_REPORT_SCHEMA);
    assert.equal(typeof client.generatedAt, 'string');
    assert.ok(!Number.isNaN(Date.parse(client.generatedAt)));
    assert.deepEqual(Object.keys(client.layers).sort(), [...CAPABILITY_LAYERS].sort());
    for (const layer of CAPABILITY_LAYERS) {
      const entry: LayerReport = client.layers[layer];
      assert.equal(entry.layer, layer);
      assert.equal(EVIDENCE_CODE_LAYER[entry.code], layer);
      assert.ok(entry.verdict === 'validated' || entry.verdict === 'degraded' || entry.verdict === 'unavailable');
      assert.ok(
        entry.evidence === 'measured' || entry.evidence === 'configured' || entry.evidence === 'assumed' || entry.evidence === 'absent',
      );
      assert.equal(typeof entry.at, 'string');
      assert.ok(!Number.isNaN(Date.parse(entry.at)), `${client.clientId}.${layer} time must parse`);
      assert.ok(entry.version === null || typeof entry.version === 'string');
      assert.equal(typeof entry.source, 'string');
      assert.ok(Array.isArray(entry.limitations));
      assert.ok(Array.isArray(entry.errors));
    }
    assert.ok(Array.isArray(client.limitations));
    assert.ok(Array.isArray(client.errors));
  }
}

test('registry registers the 24 canonical clients, maps cloudcode/dsh aliases, and rejects unknown ids', () => {
  assert.deepEqual([...CLIENT_IDS], [...CANONICAL_CLIENT_IDS]);
  assert.equal((CLIENT_IDS as readonly string[]).includes('cloudcode'), false, 'cloudcode must not be a ClientId');
  assert.equal((CLIENT_IDS as readonly string[]).includes('dsh'), false, 'dsh must not be a canonical ClientId');
  assert.equal(defaultRegistry.list().length, 24);

  const claude = defaultRegistry.get('claude-code');
  assert.equal(claude.alias, 'cloudcode');
  assert.equal(defaultRegistry.get('cloudcode').id, 'claude-code');
  assert.ok(claude.identitySources.some((source) => source.kind === 'executable' && source.value === 'claude'));
  assert.ok(claude.configCandidates.length >= 2);

  // ADR-008 §8: dsh is an alias of deepseek-harness, never a separate id.
  const dsh = defaultRegistry.get('dsh');
  assert.equal(dsh.id, 'deepseek-harness');
  assert.equal(dsh.alias, 'dsh');
  assert.equal(dsh.identityStatus, 'declared');
  assert.equal(defaultRegistry.get('deepseek-harness').id, 'deepseek-harness');

  assert.equal(defaultRegistry.get('pi').identityStatus, 'unknown');
  assert.equal(defaultRegistry.get('qoder').identityStatus, 'unverified');

  for (const unknown of ['nope', '', 'Claude-Code', 'cloudcode2', 'dsh2', 'cloud', 'deepseek-harness2']) {
    assert.throws(() => defaultRegistry.get(unknown), UnknownClientError);
    assert.equal(resolveClientId(unknown), null);
  }
});

test('doctor rejects an unregistered client id', async () => {
  await assert.rejects(doctorClients({ clientIds: ['not-a-client'] }), UnknownClientError);
});

test('unified report carries evidence/time/version/source/limitations for every layer', async () => {
  const base = defaultRegistry.get('claude-code');
  const empty: ClientDescriptor = {
    ...base,
    identitySources: [],
    configCandidates: [],
    rulePaths: [],
    notes: [],
  };
  const registry = createRegistry([empty]);
  const home = await temp('ano doctor schema ');
  try {
    const bin = join(home, 'bin');
    await mkdir(bin);
    const report = await doctorClients({
      registry,
      clientIds: ['claude-code'],
      home,
      root: home,
      probePaths: [bin],
      env: {},
      now: () => AT,
    });
    assert.equal(report.schema, DOCTOR_REPORT_SCHEMA);
    assert.equal(report.clients.length, 1);
    assertReportShape(report);
    const client = report.clients[0]!;
    assert.equal(client.status, 'unavailable');
    assert.equal(client.coreVerdict, 'unavailable');
    for (const layer of CAPABILITY_LAYERS) {
      assert.equal(client.layers[layer].verdict, 'unavailable', `${layer} must be unavailable without detection`);
      assert.equal(client.layers[layer].evidence, 'absent');
      assert.equal(client.layers[layer].version, null);
    }
    assert.equal(client.layers.configured.details.exists, false);
    assert.equal(client.layers.configured.details.configPath, null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('one failing client does not block the others and the report stays complete', async () => {
  const home = await temp('ano doctor isolate ');
  try {
    const report = await doctorClients({
      clientIds: ['claude-code', 'codex', 'cursor'],
      adapters: { 'claude-code': failingAdapter('claude-code'), codex: goodAdapter('codex'), cursor: goodAdapter('cursor') },
      home,
      root: home,
      probePaths: [],
      env: {},
      now: () => AT,
    });
    assert.equal(report.clients.length, 3);
    assertReportShape(report);

    const failed = report.clients.find((client) => client.clientId === 'claude-code')!;
    assert.ok(failed.errors.length >= 1, 'the isolated failure must land in the client report');
    assert.match(JSON.stringify(failed.errors), /exploded/);
    assert.equal(failed.status, 'unavailable');
    assert.equal(failed.layers.detected.verdict, 'unavailable');

    for (const id of ['codex', 'cursor'] as const) {
      const client = report.clients.find((entry) => entry.clientId === id)!;
      assert.equal(client.errors.length, 0);
      assert.equal(client.status, 'degraded');
      assert.equal(client.layers.detected.verdict, 'validated');
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('real stdio MCP verification against a fake stdio server asserts exactly seven tools', async () => {
  const serverPath = await fakeServer();
  try {
    const result = await verifyStdioMcp({
      transport: 'stdio',
      command: process.execPath,
      args: [serverPath, 'ok'],
      timeoutMs: 10_000,
    });
    assert.equal(result.handshake !== null, true);
    assert.equal(result.handshake?.protocolVersion, '2025-06-18');
    assert.deepEqual(result.handshake?.serverInfo, { name: 'fake-ano', version: '1.0.0' });
    assert.equal(typeof result.handshake?.latencyMs, 'number');
    assert.equal(typeof result.handshake?.startedAt, 'string');
    assert.equal(result.tools?.count, 7);
    assert.deepEqual(result.tools?.names, [...MCP_TOOL_NAMES]);
    assert.deepEqual(result.tools?.missing, []);
    assert.deepEqual(result.tools?.extra, []);
    assert.equal(result.verdicts.mcp, 'validated');
    assert.equal(result.verdicts.tools, 'validated');
    assert.equal(result.verdicts.brief, 'validated');
    assert.equal(result.brief?.hasProjectContext, true);
    assert.equal(result.errors.length, 0);
  } finally {
    await rm(serverPath, { recursive: true, force: true });
  }
});

test('stdio handshake success does not amplify into tools or brief', async () => {
  const serverPath = await fakeServer();
  try {
    const six = await verifyStdioMcp({
      transport: 'stdio',
      command: process.execPath,
      args: [serverPath, 'six'],
      timeoutMs: 10_000,
    });
    assert.equal(six.verdicts.mcp, 'validated', 'the handshake itself succeeded');
    assert.equal(six.verdicts.tools, 'degraded', 'seven-tool assertion is independent of the handshake');
    assert.equal(six.tools?.count, 6);
    assert.deepEqual(six.tools?.missing, ['audit']);
    assert.notEqual(six.verdicts.tools, 'validated');

    const badBrief = await verifyStdioMcp({
      transport: 'stdio',
      command: process.execPath,
      args: [serverPath, 'fail-brief'],
      timeoutMs: 10_000,
    });
    assert.equal(badBrief.verdicts.mcp, 'validated');
    assert.equal(badBrief.verdicts.tools, 'validated');
    assert.equal(badBrief.verdicts.brief, 'degraded');
    assert.notEqual(badBrief.verdicts.brief, 'validated');

    const noContext = await verifyStdioMcp({
      transport: 'stdio',
      command: process.execPath,
      args: [serverPath, 'no-context'],
      timeoutMs: 10_000,
    });
    assert.equal(noContext.verdicts.brief, 'degraded');
    assert.equal(noContext.brief?.hasProjectContext, false);
  } finally {
    await rm(serverPath, { recursive: true, force: true });
  }
});

test('stdio handshake failure stops amplification to configured/tools/brief', async () => {
  const serverPath = await fakeServer();
  try {
    const exited = await verifyStdioMcp({
      transport: 'stdio',
      command: process.execPath,
      args: [serverPath, 'exit'],
      timeoutMs: 10_000,
    });
    assert.equal(exited.handshake, null);
    assert.equal(exited.verdicts.mcp, 'unavailable');
    assert.equal(exited.verdicts.tools, 'unavailable');
    assert.equal(exited.verdicts.brief, 'unavailable');
    assert.equal(exited.errors.length, 1);
    assert.equal(exited.errors[0]?.code, 'E3_HANDSHAKE_FAILED');

    const noCommand = await verifyStdioMcp({ transport: 'stdio' });
    assert.equal(noCommand.verdicts.mcp, 'unavailable');
    assert.equal(noCommand.errors[0]?.code, 'E3_NO_COMMAND');

    const injected = await verifyStdioMcp({ transport: 'stdio', inject: injectedClient({ failHandshake: true }) });
    assert.equal(injected.verdicts.mcp, 'unavailable');
    assert.equal(injected.verdicts.tools, 'unavailable');
    assert.equal(injected.verdicts.brief, 'unavailable');
  } finally {
    await rm(serverPath, { recursive: true, force: true });
  }
});

test('injected stdio client verifies seven tools deterministically and caps partial results', async () => {
  const ok = await verifyStdioMcp({ transport: 'stdio', inject: injectedClient({}) });
  assert.equal(ok.verdicts.mcp, 'validated');
  assert.equal(ok.verdicts.tools, 'validated');
  assert.equal(ok.verdicts.brief, 'validated');
  assert.deepEqual(ok.tools?.names, [...MCP_TOOL_NAMES]);

  const six = await verifyStdioMcp({ transport: 'stdio', inject: injectedClient({ tools: MCP_TOOL_NAMES.slice(0, 6) }) });
  assert.equal(six.verdicts.tools, 'degraded');
  assert.deepEqual(six.tools?.missing, ['audit']);

  const badBrief = await verifyStdioMcp({ transport: 'stdio', inject: injectedClient({ brief: 'error' }) });
  assert.equal(badBrief.verdicts.tools, 'validated');
  assert.equal(badBrief.verdicts.brief, 'degraded');
});

test('absence never fabricates configured and never guesses paths', async () => {
  const base = defaultRegistry.get('codex');
  const silent: ClientDescriptor = { ...base, identitySources: [], configCandidates: [], rulePaths: [], notes: [] };
  const registry = createRegistry([silent]);
  const home = await temp('ano doctor absent ');
  try {
    const bin = join(home, 'bin');
    await mkdir(bin);
    const detect = genericDetect(silent, { home, root: home, probePaths: [bin], env: {}, now: () => AT });
    assert.equal(detect.detected, false);
    assert.deepEqual(detect.sources, []);

    const discovery = discoverClientConfig(silent, { home, root: home, now: () => AT });
    assert.equal(discovery.exists, false);
    assert.equal(discovery.configPath, null);
    assert.equal(discovery.reachable, false);

    const report = await doctorClients({
      registry,
      clientIds: ['codex'],
      home,
      root: home,
      probePaths: [bin],
      env: {},
      now: () => AT,
    });
    const client = report.clients[0]!;
    assert.equal(client.status, 'unavailable');
    for (const layer of CAPABILITY_LAYERS) {
      assert.equal(client.layers[layer].verdict, 'unavailable', `${layer} must stay unavailable`);
    }
    assert.equal(client.layers.configured.evidence, 'absent');
    assert.equal(client.layers.configured.details.exists, false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('read-only config discovery resolves an ano entry and writes nothing', async () => {
  const home = await temp('ano doctor config ');
  try {
    const configPath = join(home, '.claude.json');
    const original = JSON.stringify(
      {
        mcpServers: {
          ano: { command: process.execPath, args: ['fake-mcp-server.mjs'] },
          otherService: { command: 'other', args: [] },
        },
        customField: { keep: true },
      },
      null,
      2,
    );
    await writeFile(configPath, original);
    const bin = join(home, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'claude'), '#!/usr/bin/env node\nprocess.exit(0);\n');

    const discovery = discoverClientConfig(defaultRegistry.get('claude-code'), { home, root: home, now: () => AT });
    assert.equal(discovery.exists, true);
    assert.equal(discovery.scope, 'user');
    assert.equal(discovery.key, 'mcpServers.ano');
    assert.equal(discovery.format, 'json');
    assert.equal(discovery.reachable, true);
    assert.equal(resolve(discovery.configPath ?? ''), resolve(configPath));
    const entry = discovery.resolvedEntry as { command: string; args: string[] };
    assert.equal(entry.command, process.execPath);

    const report = await doctorClients({
      clientIds: ['claude-code'],
      home,
      root: home,
      probePaths: [bin],
      env: {},
      verifier: async () => successfulVerify(),
      verify: { transport: 'stdio', command: process.execPath },
      now: () => AT,
    });
    const client = report.clients[0]!;
    assert.equal(client.layers.configured.details.exists, true);
    assert.equal(client.layers.configured.details.key, 'mcpServers.ano');
    assert.equal(client.layers.configured.evidence, 'measured');
    assert.equal(client.layers.configured.verdict, 'validated');

    assert.equal(await readFile(configPath, 'utf8'), original, 'discovery must not modify the file');
    const entries = (await readdir(home)).sort();
    assert.deepEqual(entries, ['.claude.json', 'bin'], 'no backup or scratch files may be created');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('a detected, configured and verified client reaches ready without claiming full takeover', async () => {
  const home = await temp('ano doctor ready ');
  try {
    const bin = join(home, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'claude'), '#!/usr/bin/env node\nprocess.exit(0);\n');
    const configPath = join(home, '.claude.json');
    await writeFile(
      configPath,
      JSON.stringify({ mcpServers: { ano: { command: process.execPath, args: ['fake.js'] } } }),
    );

    const report = await doctorClients({
      clientIds: ['claude-code'],
      home,
      root: home,
      probePaths: [bin],
      env: {},
      verifier: async () => successfulVerify(),
      verify: { transport: 'stdio', command: process.execPath },
      now: () => AT,
    });
    const client = report.clients[0]!;
    assert.equal(client.layers.detected.verdict, 'validated');
    assert.equal(client.layers.configured.verdict, 'validated');
    assert.equal(client.coreVerdict, 'validated');
    assert.equal(client.status, 'ready');
    assert.equal(client.layers['output-interception'].verdict, 'unavailable');
    assert.equal(client.layers.history.verdict, 'unavailable');
    assert.ok(
      client.limitations.some((line) => line.includes('output-interception unavailable')),
      'extension gaps must be listed as limitations',
    );
    assert.ok(
      JSON.stringify(report.limitations).includes('does not imply configuration is active'),
      'the report must refuse takeover amplification',
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('unknown clients stay unknown and can never be validated, even with a lying adapter', async () => {
  const at = AT;
  const layers = unavailableLayerReports(at, 'liar');
  const validated: typeof layers = {
    detected: { ...layers.detected, verdict: 'validated', evidence: 'measured' },
    configured: { ...layers.configured, verdict: 'validated', evidence: 'measured' },
    mcp: { ...layers.mcp, verdict: 'validated', evidence: 'measured' },
    tools: { ...layers.tools, verdict: 'validated', evidence: 'measured' },
    brief: { ...layers.brief, verdict: 'validated', evidence: 'measured' },
    instructions: { ...layers.instructions, verdict: 'validated', evidence: 'measured' },
    orchestration: { ...layers.orchestration, verdict: 'validated', evidence: 'measured' },
    history: { ...layers.history, verdict: 'validated', evidence: 'measured' },
    'output-interception': { ...layers['output-interception'], verdict: 'validated', evidence: 'measured' },
  };
  const liar: ClientAdapter = {
    id: 'pi',
    identitySources: [],
    detect: async () => ({
      clientId: 'pi',
      detected: true,
      executablePath: '/fake/pi',
      version: '9.9.9',
      sources: [],
      errors: [],
    }),
    inspect: async () => ({
      schema: CLIENT_REPORT_SCHEMA,
      clientId: 'pi',
      alias: null,
      status: 'ready',
      coreVerdict: 'validated',
      layers: validated,
      generatedAt: at,
      limitations: [],
      errors: [],
    }),
    config: async () => ({ mode: 'dry-run', changes: [], backupPlan: null, warnings: [] }),
    verify: async () => successfulVerify(at),
  };

  const home = await temp('ano doctor unknown ');
  try {
    const report = await doctorClients({
      clientIds: ['pi'],
      adapters: { pi: liar },
      home,
      root: home,
      probePaths: [],
      env: {},
      verify: { transport: 'stdio', command: process.execPath },
      now: () => at,
    });
    assert.equal(report.clients.length, 1);
    for (const client of report.clients) {
      assert.equal(client.status, 'unknown');
      assert.equal(client.coreVerdict, 'unavailable');
      for (const layer of CAPABILITY_LAYERS) {
        assert.equal(client.layers[layer].verdict, 'unavailable', `${client.clientId}.${layer} must not be validated`);
        assert.equal(client.layers[layer].evidence, 'absent');
      }
      assert.ok(client.limitations.some((line) => line.includes('never be validated')));
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('isolated errors carry code/time/source and stay inside their client report', async () => {
  const home = await temp('ano doctor errors ');
  try {
    const report = await doctorClients({
      clientIds: ['claude-code', 'codex'],
      adapters: { 'claude-code': failingAdapter('claude-code'), codex: goodAdapter('codex') },
      home,
      root: home,
      probePaths: [],
      env: {},
      now: () => AT,
    });
    const failed = report.clients[0]!;
    assert.ok(failed.errors.length >= 1);
    for (const error of failed.errors as IsolatedError[]) {
      assert.equal(typeof error.code, 'string');
      assert.equal(typeof error.message, 'string');
      assert.ok(!Number.isNaN(Date.parse(error.at)));
      assert.equal(typeof error.layer, 'string');
    }
    const healthy = report.clients[1]!;
    assert.equal(healthy.errors.length, 0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('all 24 canonical ids are addressable through resolveClientId and the registry', () => {
  assert.equal(CANONICAL_CLIENT_IDS.length, 24);
  for (const id of CANONICAL_CLIENT_IDS) {
    assert.equal(resolveClientId(id), id, `${id} must resolve to itself`);
    assert.equal(defaultRegistry.get(id).id, id);
    assert.equal(defaultRegistry.has(id), true);
  }
  assert.equal(defaultRegistry.list().length, 24);
  assert.equal(defaultRegistry.list().filter((descriptor) => descriptor.alias !== null).length, 2);
});

test('the 21 ADR-008 tools start declared but unverified and cite official sources', () => {
  assert.equal(ADR_008_TOOL_IDS.length, 21);
  for (const id of M11_LEGACY_IDS) {
    assert.equal((ADR_008_TOOL_IDS as readonly string[]).includes(id), false, `${id} is a legacy non-catalog client`);
  }
  for (const id of ADR_008_TOOL_IDS) {
    const descriptor = defaultRegistry.get(id);
    assert.ok(
      descriptor.identityStatus === 'declared' || descriptor.identityStatus === 'unverified',
      `${id} identity is publicly verified (ADR-008 §3)`,
    );
    assert.notEqual(descriptor.identityStatus, 'unknown', `${id} must not be an unknown identity`);
    assert.equal(descriptor.initialVerdict, 'unverified', `${id} must start unverified`);
    assert.notEqual(descriptor.initialVerdict, 'validated');
    assert.ok(descriptor.officialSources.length >= 1, `${id} must cite an official source`);
  }
  // M11 semantics preserved: qoder's public interface is still unverified (T-084).
  assert.equal(defaultRegistry.get('qoder').identityStatus, 'unverified');
  assert.equal(defaultRegistry.get('deepseek-harness').identityStatus, 'declared');
  for (const id of NEW_TOOL_IDS) {
    const descriptor = defaultRegistry.get(id);
    assert.ok(
      descriptor.notes.some((note) => note.includes('未实测') || note.includes('待核实')),
      `${id} must be explicitly marked unmeasured`,
    );
  }
});

test('aliases are stable: cloudcode -> claude-code and dsh -> deepseek-harness', () => {
  assert.deepEqual({ ...CLIENT_ALIAS_TARGET }, { cloudcode: 'claude-code', dsh: 'deepseek-harness' });
  assert.equal(resolveClientId('cloudcode'), 'claude-code');
  assert.equal(resolveClientId('dsh'), 'deepseek-harness');
  assert.equal(resolveClientId('deepseek-harness'), 'deepseek-harness');
  assert.equal(defaultRegistry.get('dsh').id, 'deepseek-harness');
  assert.equal(defaultRegistry.get('dsh').alias, 'dsh');
  assert.equal(defaultRegistry.get('cloudcode').id, 'claude-code');
  assert.equal(defaultRegistry.get('cloudcode').alias, 'cloudcode');
  assert.equal((CLIENT_IDS as readonly string[]).includes('dsh'), false);
});

test('doctor addresses all 21 ADR-008 tools and never upgrades unverified clients', async () => {
  const home = await temp('ano doctor catalog ');
  try {
    const report = await doctorClients({
      clientIds: ADR_008_TOOL_IDS,
      home,
      root: home,
      probePaths: [],
      env: {},
      now: () => AT,
    });
    assert.equal(report.schema, DOCTOR_REPORT_SCHEMA);
    assert.equal(report.clients.length, 21);
    assert.deepEqual(report.clients.map((client) => client.clientId), [...ADR_008_TOOL_IDS]);
    assertReportShape(report);
    for (const client of report.clients) {
      assert.equal(client.schema, CLIENT_REPORT_SCHEMA);
      assert.notEqual(client.status, 'ready', `${client.clientId} must not be ready while unverified`);
      assert.notEqual(client.coreVerdict, 'validated', `${client.clientId} coreVerdict must not be validated`);
      for (const layer of CAPABILITY_LAYERS) {
        assert.notEqual(client.layers[layer].verdict, 'validated', `${client.clientId}.${layer} must not be validated`);
      }
    }
    for (const id of NEW_TOOL_IDS) {
      const client = report.clients.find((entry) => entry.clientId === id)!;
      assert.ok(
        client.limitations.some((line) => line.includes('未实测') || line.includes('待核实')),
        `${id} must carry an unmeasured limitation`,
      );
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('dsh resolves to deepseek-harness and is no longer an unknown client', async () => {
  const home = await temp('ano doctor dsh ');
  try {
    const report = await doctorClients({
      clientIds: ['dsh'],
      home,
      root: home,
      probePaths: [],
      env: {},
      now: () => AT,
    });
    assert.equal(report.clients.length, 1);
    const client = report.clients[0]!;
    assert.equal(client.clientId, 'deepseek-harness');
    assert.equal(client.alias, 'dsh');
    assert.notEqual(client.status, 'unknown');
    assert.ok(
      client.limitations.some((line) => line.includes('不再是 unknown')),
      'the registry note must record the ADR-008 §8 DSH semantic change',
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('legacy M11 ids, aliases and report schemas stay compatible', () => {
  assert.equal(CLIENT_REPORT_SCHEMA, 'ano.client-report/1');
  assert.equal(DOCTOR_REPORT_SCHEMA, 'ano.client-doctor-report/1');
  for (const id of ['claude-code', 'codex', 'cursor', 'opencode', 'qoder', 'zcode']) {
    assert.equal(defaultRegistry.get(id).id, id);
    assert.equal(resolveClientId(id), id);
  }
  assert.equal(defaultRegistry.get('claude-code').alias, 'cloudcode');
  assert.equal(defaultRegistry.get('pi').identityStatus, 'unknown');
  assert.equal(defaultRegistry.get('qoder').identityStatus, 'unverified');
  assert.equal(defaultRegistry.get('zcode').identityStatus, 'declared');
});

// ---------------------------------------------------------------------------
// T-153：报错/abort、配置发现残余分支、崩溃隔离
// ---------------------------------------------------------------------------

test('T-153 stdio abort、畸形行、初始化错误与最小握手均隔离进报告', async () => {
  const serverPath = await fakeServer();
  const home = await temp('ano doctor abort ');
  try {
    const preAborted = await verifyStdioMcp({
      transport: 'stdio',
      command: process.execPath,
      args: [serverPath, 'ok'],
      timeoutMs: 5_000,
      signal: AbortSignal.abort(),
    });
    assert.equal(preAborted.handshake, null);
    assert.equal(preAborted.errors[0]?.code, 'E3_HANDSHAKE_FAILED');
    assert.match(preAborted.errors[0]?.message ?? '', /aborted|no longer running/u);

    const duringAbort = await verifyStdioMcp({
      transport: 'stdio',
      command: process.execPath,
      args: [serverPath, 'silent'],
      timeoutMs: 5_000,
      signal: AbortSignal.timeout(60),
    });
    assert.equal(duringAbort.handshake, null);
    assert.match(duringAbort.errors[0]?.message ?? '', /aborted/u);

    const garbage = await verifyStdioMcp({
      transport: 'stdio',
      command: process.execPath,
      args: [serverPath, 'garbage'],
      timeoutMs: 40,
    });
    assert.equal(garbage.errors[0]?.code, 'E3_HANDSHAKE_FAILED');
    assert.match(garbage.errors[0]?.message ?? '', /timed out/u);

    const initError = await verifyStdioMcp({
      transport: 'stdio',
      command: process.execPath,
      args: [serverPath, 'init-error'],
      timeoutMs: 1_000,
    });
    assert.equal(initError.handshake, null);
    assert.match(initError.errors[0]?.message ?? '', /initialize boom/u);

    const minimal = await verifyStdioMcp({
      transport: 'stdio',
      command: process.execPath,
      args: [serverPath, 'minimal-init'],
      timeoutMs: 1_000,
    });
    assert.equal(minimal.verdicts.mcp, 'degraded');
    assert.equal(minimal.verdicts.tools, 'unavailable');
    assert.equal(minimal.tools?.count, 7);

    const viaDoctor = await doctorClients({
      clientIds: ['claude-code'],
      home,
      root: home,
      env: {},
      probePaths: [],
      verify: { transport: 'stdio', command: process.execPath },
      verifier: async () => minimal,
      now: () => AT,
    });
    const mcpLayer = viaDoctor.clients[0]?.layers.mcp;
    assert.equal(mcpLayer?.verdict, 'degraded');
    assert.ok((mcpLayer?.limitations ?? []).some((line) => line.includes('protocolVersion')));
  } finally {
    await rm(serverPath, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('T-153 spawn 同步失败转为 E3_SPAWN_FAILED；注入客户端局部失败被逐层降级', async () => {
  const syncFailure = await verifyStdioMcp({ transport: 'stdio', command: 42 as unknown as string, timeoutMs: 100 });
  assert.equal(syncFailure.errors[0]?.code, 'E3_SPAWN_FAILED');

  const partial = await verifyStdioMcp({
    transport: 'stdio',
    inject: {
      initialize: async () => ({ protocolVersion: '2025-06-18', serverInfo: { name: 'partial', version: '1.0.0' } }),
      listTools: async () => { throw new Error('tools boom'); },
      callTool: async () => { throw new Error('brief boom'); },
      close: async () => { throw new Error('close boom'); },
    },
  });
  assert.equal(partial.verdicts.mcp, 'validated');
  assert.equal(partial.verdicts.tools, 'degraded');
  assert.equal(partial.verdicts.brief, 'degraded');
  assert.deepEqual(
    partial.errors.map((error) => error.code),
    ['E4_TOOLS_LIST_FAILED', 'E5_BRIEF_FAILED'],
  );
});

test('T-153 配置发现覆盖缺失键/非对象 JSON/解析失败/TOML/cmd/url/路径可达性', async () => {
  const home = await temp('ano doctor discovery ');
  try {
    const bin = join(home, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'svc.cmd'), '@echo off\n');
    await writeFile(join(bin, 'barecmd.exe'), '');

    const missingKey = join(home, 'missing-key.json');
    await writeFile(missingKey, JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    const nullRoot = join(home, 'null-root.json');
    await writeFile(nullRoot, 'null');
    const malformed = join(home, 'malformed.json');
    await writeFile(malformed, '{not json');
    const tomlPath = join(home, 'config.toml');
    await writeFile(tomlPath, '[mcp_servers.ano]\ncommand = "node"\nargs = ["a"]\n');
    const cmdEntry = join(home, 'cmd.json');
    await writeFile(cmdEntry, JSON.stringify({ mcp: { srv: { cmd: join(bin, 'svc') } } }));
    const urlEntry = join(home, 'url.json');
    await writeFile(urlEntry, JSON.stringify({ mcp: { srv: { url: 'https://example.invalid/mcp' } } }));
    const slashEntry = join(home, 'slash.json');
    await writeFile(slashEntry, JSON.stringify({ mcp: { srv: { command: join(bin, 'svc') } } }));
    const bareEntry = join(home, 'bare.json');
    await writeFile(bareEntry, JSON.stringify({ mcp: { srv: { command: 'barecmd' } } }));

    const base = defaultRegistry.get('claude-code');
    const descriptorFor = (path: string, format: 'json' | 'toml', key: string): ClientDescriptor => ({
      ...base,
      configCandidates: [{ path, scope: 'user', format, key }],
    });
    const options = { home, root: home, probePaths: [bin], env: {}, now: () => AT };

    const missing = discoverClientConfig(descriptorFor(missingKey, 'json', 'mcpServers.ano'), options);
    assert.equal(missing.exists, false);
    const nullDocument = discoverClientConfig(descriptorFor(nullRoot, 'json', 'mcpServers.ano'), options);
    assert.equal(nullDocument.exists, false);
    const unreadable = discoverClientConfig(descriptorFor(malformed, 'json', 'mcpServers.ano'), options);
    assert.equal(unreadable.exists, false);
    assert.equal(unreadable.errors[0]?.code, 'E2_PARSE_FAILED');

    const tomlFound = discoverClientConfig(descriptorFor(tomlPath, 'toml', 'mcp_servers.ano'), options);
    assert.equal(tomlFound.exists, true);
    assert.equal(tomlFound.command, 'node');

    const cmdFound = discoverClientConfig(descriptorFor(cmdEntry, 'json', 'mcp.srv'), options);
    assert.equal(cmdFound.command, join(bin, 'svc'));
    assert.equal(cmdFound.reachable, true);

    const urlFound = discoverClientConfig(descriptorFor(urlEntry, 'json', 'mcp.srv'), options);
    assert.equal(urlFound.command, null);
    assert.equal(urlFound.reachable, true);

    const slashFound = discoverClientConfig(descriptorFor(slashEntry, 'json', 'mcp.srv'), options);
    assert.equal(slashFound.reachable, true);

    const bareFound = discoverClientConfig(descriptorFor(bareEntry, 'json', 'mcp.srv'), options);
    assert.equal(bareFound.reachable, true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('T-153 配置发现关闭时：声明被 cap，未运行时保持 unavailable', async () => {
  const home = await temp('ano doctor cfg-off ');
  try {
    const baseLayers = unavailableLayerReports(AT, 'cfg-fallback');
    const inspectedReport: ClientReport = {
      schema: CLIENT_REPORT_SCHEMA,
      clientId: 'claude-code',
      alias: null,
      status: 'degraded',
      coreVerdict: 'degraded',
      layers: {
        ...baseLayers,
        configured: { ...baseLayers.configured, verdict: 'validated' as const, evidence: 'measured' as const },
      },
      generatedAt: AT,
      limitations: [],
      errors: [],
    };
    const cappingAdapter: ClientAdapter = {
      ...goodAdapter('claude-code'),
      inspect: async () => inspectedReport,
    };
    const capped = await doctorClients({
      clientIds: ['claude-code'],
      adapters: { 'claude-code': cappingAdapter },
      discoverConfig: false,
      home,
      root: home,
      env: {},
      probePaths: [],
      now: () => AT,
    });
    const cappedClient = capped.clients[0]!;
    assert.equal(cappedClient.layers.configured.verdict, 'degraded');
    assert.ok(cappedClient.layers.configured.limitations.some((line) => line.includes('discovery did not run')));
    assert.ok(cappedClient.limitations.some((line) => line.includes('disabled by caller')));

    const throwingInspect: ClientAdapter = {
      ...goodAdapter('claude-code'),
      inspect: async () => { throw new Error('inspect boom'); },
    };
    const unavailable = await doctorClients({
      clientIds: ['claude-code'],
      adapters: { 'claude-code': throwingInspect },
      discoverConfig: false,
      home,
      root: home,
      env: {},
      probePaths: [],
      now: () => AT,
    });
    const plainClient = unavailable.clients[0]!;
    assert.equal(plainClient.layers.configured.verdict, 'unavailable');
    assert.ok(plainClient.layers.configured.limitations.some((line) => line.includes('configuration discovery did not run')));
    assert.equal(plainClient.errors.some((error) => error.code === 'E_CLIENT_INSPECT_FAILED'), true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('T-153 验证失败、工具列表错误与空 brief 在各能力层留下限制', async () => {
  const serverPath = await fakeServer();
  const home = await temp('ano doctor layers ');
  try {
    const failTools = await verifyStdioMcp({
      transport: 'stdio',
      command: process.execPath,
      args: [serverPath, 'fail-tools'],
      timeoutMs: 1_000,
    });
    assert.equal(failTools.verdicts.mcp, 'validated');
    assert.equal(failTools.verdicts.tools, 'degraded');
    assert.equal(failTools.errors[0]?.code, 'E4_TOOLS_LIST_FAILED');

    const emptyBrief = await verifyStdioMcp({
      transport: 'stdio',
      inject: {
        initialize: async () => ({ protocolVersion: '2025-06-18', serverInfo: { name: 'empty-brief', version: '1.0.0' } }),
        listTools: async () => ({ tools: MCP_TOOL_NAMES.map((name) => ({ name, inputSchema: { type: 'object' } })) }),
        callTool: async () => ({ content: [] }),
        close: async () => {},
      },
    });
    assert.equal(emptyBrief.brief?.schema, null);
    assert.equal(emptyBrief.verdicts.brief, 'degraded');

    const failure: VerifyResult = { handshake: null, tools: null, brief: null, verdicts: emptyVerdicts(), errors: [] };
    const report = await doctorClients({
      clientIds: ['claude-code'],
      home,
      root: home,
      env: {},
      probePaths: [],
      verify: { transport: 'stdio', command: process.execPath },
      verifier: async () => failure,
      now: () => AT,
    });
    const layers = report.clients[0]!.layers;
    assert.ok(layers.mcp.limitations.some((line) => line.includes('initialize did not complete')));
    assert.ok(layers.tools.limitations.some((line) => line.includes('tools/list did not return')));
    assert.ok(layers.brief.limitations.some((line) => line.includes('brief was not callable')));
  } finally {
    await rm(serverPath, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('T-153 单个 descriptor 意外崩溃被隔离为 E_CLIENT_PROBE_CRASHED 且不阻断报告', async () => {
  const base = defaultRegistry.get('claude-code');
  const evil = { ...base } as ClientDescriptor;
  Object.defineProperty(evil, 'identityStatus', {
    get(): ClientDescriptor['identityStatus'] {
      throw new Error('descriptor exploded');
    },
    enumerable: true,
  });
  const home = await temp('ano doctor crash ');
  try {
    const report = await doctorClients({
      registry: createRegistry([evil]),
      clientIds: ['claude-code'],
      home,
      root: home,
      env: {},
      probePaths: [],
      discoverConfig: false,
      now: () => AT,
    });
    const client = report.clients[0]!;
    assert.equal(client.clientId, 'claude-code');
    assert.equal(client.status, 'unavailable');
    assert.equal(client.errors[0]?.code, 'E_CLIENT_PROBE_CRASHED');
    assert.match(client.errors[0]?.message ?? '', /descriptor exploded/u);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
