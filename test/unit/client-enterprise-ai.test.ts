import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  CAPABILITY_LAYERS,
  CLIENT_ALIAS_TARGET,
  CLIENT_IDS,
  CLIENT_REPORT_SCHEMA,
  MCP_TOOL_COUNT,
  MCP_TOOL_NAMES,
  type ClientAdapter,
  type ClientAuthorizationRef,
  type ConfigInput,
  type LayerReport,
  type McpClientLike,
} from '../../src/clients/types.ts';
import { defaultRegistry } from '../../src/clients/registry.ts';
import { doctorClients } from '../../src/clients/doctor.ts';
import { QODER_CONFIG_CANDIDATES } from '../../src/clients/qoder.ts';
import {
  AMAZON_Q_CONFIG_CANDIDATES,
  AMAZON_Q_EXECUTABLE_NAMES,
  AMAZON_Q_IDE_EOL_DATE,
  AMAZON_Q_IDENTITY_SOURCES,
  amazonQAdapter,
} from '../../src/clients/amazon-q.ts';
import {
  CODEGEEX_CONFIG_CANDIDATES,
  CODEGEEX_IDENTITY_SOURCES,
  codegeexAdapter,
} from '../../src/clients/codegeex.ts';
import {
  TONGYI_LINGMA_CONFIG_CANDIDATES,
  TONGYI_LINGMA_EXECUTABLE_NAMES,
  TONGYI_LINGMA_IDENTITY_SOURCES,
  tongyiLingmaAdapter,
} from '../../src/clients/tongyi-lingma.ts';
import {
  COMATE_CONFIG_CANDIDATES,
  COMATE_EXECUTABLE_NAMES,
  COMATE_IDENTITY_SOURCES,
  comateAdapter,
} from '../../src/clients/comate.ts';

const AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function rootFor(t: TestContext, prefix = 'ano-enterprise-ai-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function fakeExecutable(root: string, name: string): string {
  const bin = join(root, 'bin');
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

function authorization(root: string, clientId: string, withStatement: boolean): ClientAuthorizationRef {
  const base = {
    authorizationId: 'a'.repeat(64),
    root,
    clientId,
    scope: ['config', 'install'],
    grantedBy: 'Alice',
    grantedAt: '2026-11-22T00:00:00.000Z',
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

function failingAdapter(id: 'amazon-q' | 'codegeex' | 'tongyi-lingma' | 'comate'): ClientAdapter {
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

test('four adapters are declared, unverified, evidence-backed and registry-consistent', () => {
  const expected: Readonly<Record<string, readonly string[]>> = {
    'amazon-q': ['ide-plugin', 'cli', 'cloud-service'],
    codegeex: ['ide-plugin'],
    'tongyi-lingma': ['ide-plugin', 'editor', 'cli'],
    comate: ['editor', 'ide-plugin', 'cli'],
  };
  const adapters: Readonly<Record<string, ClientAdapter>> = {
    'amazon-q': amazonQAdapter,
    codegeex: codegeexAdapter,
    'tongyi-lingma': tongyiLingmaAdapter,
    comate: comateAdapter,
  };
  for (const id of ['amazon-q', 'codegeex', 'tongyi-lingma', 'comate']) {
    const descriptor = defaultRegistry.get(id);
    assert.equal(descriptor.identityStatus, 'declared', `${id} identity is publicly verified`);
    assert.equal(descriptor.initialVerdict, 'unverified', `${id} must start unverified`);
    assert.notEqual(descriptor.initialVerdict, 'validated');
    assert.ok(descriptor.officialSources.length >= 1, `${id} must cite an official source`);
    assert.deepEqual(descriptor.productForms, expected[id]);
    assert.ok(
      descriptor.notes.some((note) => note.includes('未实测') || note.includes('待核实')),
      `${id} must be explicitly marked unmeasured`,
    );
    const adapter = adapters[id]!;
    assert.equal(adapter.id, id);
    assert.ok(Array.isArray(adapter.identitySources));
  }

  // Amazon Q: registry candidate plus the E1-verified kiro-cli binary.
  assert.ok(AMAZON_Q_IDENTITY_SOURCES.some((source) => source.kind === 'executable' && source.value === 'kiro-cli'));
  assert.ok(AMAZON_Q_IDENTITY_SOURCES.some((source) => source.kind === 'executable' && source.value === 'kiro'));
  assert.ok(AMAZON_Q_IDENTITY_SOURCES.some((source) => source.value === '~/.kiro/settings/mcp.json'));

  // Tongyi Lingma: verified qodercn plus the ambiguous qoder candidate.
  assert.ok(TONGYI_LINGMA_IDENTITY_SOURCES.some((source) => source.kind === 'executable' && source.value === 'qodercn'));
  const qoderCandidate = TONGYI_LINGMA_IDENTITY_SOURCES.find((source) => source.kind === 'executable' && source.value === 'qoder');
  assert.ok(qoderCandidate !== undefined);
  assert.match(qoderCandidate.detail ?? '', /待核实/);

  // Comate: comatecli only; cbc is never a Comate source.
  assert.ok(COMATE_IDENTITY_SOURCES.some((source) => source.kind === 'executable' && source.value === 'comatecli'));
  assert.equal(
    COMATE_IDENTITY_SOURCES.some((source) => source.value === 'cbc'),
    false,
    'cbc belongs to Tencent CodeBuddy, not Comate',
  );

  // CodeGeeX: no declared local source at all.
  assert.deepEqual([...CODEGEEX_IDENTITY_SOURCES], []);
  assert.deepEqual([...CODEGEEX_CONFIG_CANDIDATES], []);
});

test('qoder (international) and tongyi-lingma (Qoder CN) are distinct products', () => {
  assert.equal(defaultRegistry.get('qoder').id, 'qoder');
  assert.equal(defaultRegistry.get('tongyi-lingma').id, 'tongyi-lingma');
  assert.notEqual(defaultRegistry.get('qoder').id, defaultRegistry.get('tongyi-lingma').id);

  const qoderSources = new Set(defaultRegistry.get('qoder').officialSources);
  const lingmaSources = defaultRegistry.get('tongyi-lingma').officialSources;
  assert.ok([...qoderSources].some((source) => source.includes('qoder.com')));
  assert.ok(lingmaSources.some((source) => source.includes('docs.qoder.cn')));
  for (const source of lingmaSources) {
    assert.equal(qoderSources.has(source), false, `official source must not be shared: ${source}`);
  }

  const qoderUserCandidate = QODER_CONFIG_CANDIDATES.find((candidate) => candidate.scope === 'user');
  const lingmaUserCandidate = TONGYI_LINGMA_CONFIG_CANDIDATES.find((candidate) => candidate.scope === 'user');
  assert.ok(qoderUserCandidate !== undefined);
  assert.ok(lingmaUserCandidate !== undefined);
  assert.notEqual(qoderUserCandidate.path, lingmaUserCandidate.path);
  assert.ok(lingmaUserCandidate.path.includes('.qoder-cn'));
  assert.ok(TONGYI_LINGMA_EXECUTABLE_NAMES.includes('qodercn'));
});

test('Amazon Q distinguishes IDE plugin / Kiro CLI / cloud and cites E1 MCP config', async (t) => {
  const root = rootFor(t);
  const home = join(root, 'home');
  mkdirSync(home);
  const env = { HOME: home, PATH: join(root, 'missing-bin') };

  assert.equal(AMAZON_Q_IDE_EOL_DATE, '2027-04-30');
  assert.ok(AMAZON_Q_EXECUTABLE_NAMES.includes('kiro-cli'));
  assert.ok(AMAZON_Q_EXECUTABLE_NAMES.includes('kiro'));
  assert.ok(AMAZON_Q_CONFIG_CANDIDATES.some((candidate) => candidate.key === 'mcpServers.ano' && candidate.scope === 'user'));
  assert.ok(AMAZON_Q_CONFIG_CANDIDATES.some((candidate) => candidate.key === 'mcpServers.ano' && candidate.scope === 'project'));

  const empty = await amazonQAdapter.inspect({ root, env, cwd: root });
  assert.equal(empty.schema, CLIENT_REPORT_SCHEMA);
  assert.equal(empty.status, 'unavailable');
  for (const layer of CAPABILITY_LAYERS) {
    const report: LayerReport = empty.layers[layer];
    assert.notEqual(report.verdict, 'validated', `${layer} must not be validated without measurement`);
    assert.match(report.at, AT_RE);
  }
  assert.ok(empty.limitations.some((line) => line.includes('2027-04-30')));
  assert.ok(empty.limitations.some((line) => /cloud model-provider capability is not Amazon Q host takeover/i.test(line)));

  const bin = fakeExecutable(root, 'kiro-cli');
  const detected = await amazonQAdapter.detect({ env: envFor(home, bin), cwd: root, probePaths: [bin] });
  assert.equal(detected.detected, true);
  assert.equal(detected.executablePath, join(bin, 'kiro-cli'));
  assert.equal(detected.sources[0]?.kind, 'executable');

  mkdirSync(join(home, '.kiro', 'settings'), { recursive: true });
  writeJson(join(home, '.kiro', 'settings', 'mcp.json'), { mcpServers: {} });
  const withConfig = await amazonQAdapter.detect({ env: envFor(home, bin), cwd: root, probePaths: [bin] });
  assert.ok(withConfig.sources.some((source) => source.kind === 'config-path' && source.source.includes('.kiro')));
});

test('Amazon Q config proposes a legal mcpServers.ano entry and writes nothing by default', async (t) => {
  const root = rootFor(t);
  const home = join(root, 'home');
  mkdirSync(home);
  const bin = fakeExecutable(root, 'kiro-cli');
  const env = envFor(home, bin);
  const configPath = join(home, '.kiro', 'settings', 'mcp.json');
  writeJson(configPath, { mcpServers: { other: { command: 'other', args: ['--serve'] } } });
  const before = readFileSync(configPath);

  const dry = await amazonQAdapter.config(configInput({ mode: 'dry-run', target: { scope: 'user' }, env }));
  assert.equal(dry.mode, 'dry-run');
  assert.equal(dry.changes.length, 1);
  assert.equal(dry.changes[0]?.operation, 'add');
  assert.equal(dry.changes[0]?.key, 'mcpServers.ano');
  assert.equal(dry.changes[0]?.path, configPath);
  const after = dry.changes[0]?.after as { command: string; args: string[] };
  assert.equal(typeof after.command, 'string');
  assert.ok(after.args.length >= 1);
  assert.deepEqual(readFileSync(configPath), before, 'dry-run must not write');
  assert.equal(existsSync(join(root, '.ano')), false, 'dry-run must not create backup state');

  const applied = await amazonQAdapter.config(configInput({
    mode: 'apply',
    root,
    target: { scope: 'user' },
    env,
    authorization: authorization(root, 'amazon-q', true),
  }));
  assert.equal(applied.mode, 'apply');
  const document = readJson(configPath);
  const servers = document['mcpServers'] as Record<string, unknown>;
  assert.deepEqual(servers['other'], { command: 'other', args: ['--serve'] });
  assert.ok(servers['ano'] !== undefined);
  assert.ok(existsSync(join(root, '.ano', 'clients', 'backups', 'amazon-q')));

  const refused = await amazonQAdapter.config(configInput({
    mode: 'apply',
    root,
    target: { scope: 'user' },
    env,
    authorization: authorization(root, 'amazon-q', false),
  }));
  assert.equal(refused.mode, 'dry-run');
  assert.ok(refused.warnings.some((line) => line.includes('statement')));
});

test('CodeGeeX is IDE-plugin-only: no local MCP interface and no fabricated config', async (t) => {
  const root = rootFor(t);
  const home = join(root, 'home');
  mkdirSync(home);
  const env = { HOME: home, PATH: join(root, 'missing-bin') };

  const detect = await codegeexAdapter.detect({ env, cwd: root, probePaths: [join(root, 'missing-bin')] });
  assert.equal(detect.detected, false);
  assert.deepEqual(detect.sources, []);
  assert.equal(detect.errors[0]?.code, 'E1_NO_PUBLIC_LOCAL_INTERFACE');

  const report = await codegeexAdapter.inspect({ root, env, cwd: root });
  assert.equal(report.status, 'unavailable');
  for (const layer of CAPABILITY_LAYERS) {
    assert.equal(report.layers[layer].verdict, 'unavailable', `${layer} must stay unavailable`);
  }
  assert.ok(report.limitations.some((line) => line.includes('IDE-plugin')));
  assert.ok(report.limitations.some((line) => line.includes('E0')));
  assert.ok(report.limitations.some((line) => line.includes('模型/云端能力不是宿主接管能力')));
  assert.ok(report.limitations.some((line) => line.includes('refusing to generate an invalid MCP config')));

  const dry = await codegeexAdapter.config(configInput({ mode: 'dry-run', root, env }));
  assert.equal(dry.mode, 'dry-run');
  assert.deepEqual(dry.changes, []);
  assert.ok(dry.warnings.some((line) => line.includes('config-refused') && line.includes('invalid MCP config')));

  const apply = await codegeexAdapter.config(configInput({
    mode: 'apply',
    root,
    env,
    authorization: authorization(root, 'codegeex', true),
  }));
  assert.equal(apply.mode, 'dry-run');
  assert.deepEqual(apply.changes, []);
  assert.deepEqual(readdirSync(root).sort(), ['home'], 'CodeGeeX must not write anything');
});

test('Tongyi Lingma detects qodercn and proposes a legal Qoder CN config', async (t) => {
  const root = rootFor(t);
  const home = join(root, 'home');
  mkdirSync(home);
  const bin = fakeExecutable(root, 'qodercn');
  const env = envFor(home, bin);

  const detected = await tongyiLingmaAdapter.detect({ env, cwd: root, probePaths: [bin] });
  assert.equal(detected.detected, true);
  assert.equal(detected.executablePath, join(bin, 'qodercn'));

  const report = await tongyiLingmaAdapter.inspect({ root, env, cwd: root });
  assert.equal(report.layers.detected.verdict, 'degraded', 'existence-only E2 detection is capped at degraded');
  assert.equal(report.layers.detected.evidence, 'measured');
  assert.equal(report.layers.configured.verdict, 'degraded');
  assert.ok(report.limitations.some((line) => line.includes('不同产品')));
  assert.ok(report.limitations.some((line) => line.includes('qodercn')));
  assert.ok(report.limitations.some((line) => line.includes('模型供应商/云端能力不是宿主接管能力')));

  const configPath = join(home, '.qoder-cn', 'settings.json');
  writeJson(configPath, { mcpServers: {} });
  const dry = await tongyiLingmaAdapter.config(configInput({ mode: 'dry-run', target: { scope: 'user' }, env }));
  assert.equal(dry.mode, 'dry-run');
  assert.equal(dry.changes.length, 1);
  assert.equal(dry.changes[0]?.key, 'mcpServers.ano');
  assert.equal(dry.changes[0]?.path, configPath);
  assert.deepEqual(readdirSync(join(home, '.qoder-cn')).sort(), ['settings.json'], 'dry-run must not write');
});

test('Comate detects comatecli, scans .mdr rules and keeps cbc out of scope', async (t) => {
  const root = rootFor(t);
  const home = join(root, 'home');
  mkdirSync(home);
  const bin = fakeExecutable(root, 'comatecli');
  const env = envFor(home, bin);

  assert.deepEqual([...COMATE_EXECUTABLE_NAMES], ['comatecli']);
  const aliasTarget = CLIENT_ALIAS_TARGET as Record<string, unknown>;
  assert.equal(aliasTarget['cbc'], undefined, 'cbc is not a ClientId alias');
  assert.equal(aliasTarget['comatecli'], undefined, 'comatecli is not a ClientId alias');
  assert.equal((CLIENT_IDS as readonly string[]).includes('cbc'), false);
  assert.equal((CLIENT_IDS as readonly string[]).includes('comatecli'), false);

  const detected = await comateAdapter.detect({ env, cwd: root, probePaths: [bin] });
  assert.equal(detected.detected, true);
  assert.equal(detected.executablePath, join(bin, 'comatecli'));

  mkdirSync(join(root, '.comate', 'rules'), { recursive: true });
  writeFileSync(join(root, '.comate', 'rules', 'ano.mdr'), '---\nalways: true\n---\nbody\n');
  const report = await comateAdapter.inspect({ root, env, cwd: root });
  const instructions = report.layers.instructions;
  assert.equal(instructions.verdict, 'degraded');
  assert.equal(instructions.details.formatVersion, 'comate-mdr/1');
  assert.ok(instructions.details.rulePaths.some((path) => path.endsWith(join('.comate', 'rules', 'ano.mdr'))));
  assert.ok(report.limitations.some((line) => line.includes('cbc') && line.includes('CodeBuddy')));

  mkdirSync(join(home, '.comate'), { recursive: true });
  const dry = await comateAdapter.config(configInput({ mode: 'dry-run', target: { scope: 'user' }, env }));
  assert.equal(dry.mode, 'dry-run');
  assert.equal(dry.changes.length, 1);
  assert.equal(dry.changes[0]?.operation, 'add');
  assert.equal(dry.changes[0]?.key, 'mcpServers.ano');
  assert.equal(dry.changes[0]?.path, join(home, '.comate', 'mcp.json'));
  assert.ok(COMATE_CONFIG_CANDIDATES.some((candidate) => candidate.scope === 'project'));
  assert.equal(existsSync(join(home, '.comate', 'mcp.json')), false, 'dry-run must not create the config file');
});

test('all four adapters delegate MCP verification and refuse to amplify on failure', async (t) => {
  assert.equal(MCP_TOOL_COUNT, 7);
  const adapters: readonly ClientAdapter[] = [amazonQAdapter, codegeexAdapter, tongyiLingmaAdapter, comateAdapter];
  for (const adapter of adapters) {
    const ok = await adapter.verify({ transport: 'stdio', inject: injectedClient({}) });
    assert.equal(ok.verdicts.mcp, 'validated', `${adapter.id} mcp`);
    assert.equal(ok.verdicts.tools, 'validated', `${adapter.id} tools`);
    assert.equal(ok.verdicts.brief, 'validated', `${adapter.id} brief`);
    assert.equal(ok.tools?.count, 7);
    assert.deepEqual(ok.tools?.names, [...MCP_TOOL_NAMES]);

    const six = await adapter.verify({ transport: 'stdio', inject: injectedClient({ tools: MCP_TOOL_NAMES.slice(0, 6) }) });
    assert.equal(six.verdicts.tools, 'degraded');
    assert.deepEqual(six.tools?.missing, ['audit']);

    const failed = await adapter.verify({ transport: 'stdio', inject: injectedClient({ failHandshake: true }) });
    assert.equal(failed.verdicts.mcp, 'unavailable');
    assert.equal(failed.verdicts.tools, 'unavailable');
    assert.equal(failed.verdicts.brief, 'unavailable');
    assert.equal(failed.errors[0]?.code, 'E3_HANDSHAKE_FAILED');

    const noCommand = await adapter.verify({ transport: 'stdio' });
    assert.equal(noCommand.verdicts.mcp, 'unavailable');
    assert.equal(noCommand.errors[0]?.code, 'E3_NO_COMMAND');
  }
});

test('Amazon Q verify performs a real stdio handshake against a fake server', async (t) => {
  const root = rootFor(t);
  const serverPath = join(root, 'fake-mcp-server.mjs');
  writeFileSync(serverPath, FAKE_SERVER);
  const ok = await amazonQAdapter.verify({ transport: 'stdio', command: process.execPath, args: [serverPath, 'ok'], root });
  assert.equal(ok.handshake?.protocolVersion, '2025-06-18');
  assert.equal(ok.tools?.count, 7);
  assert.equal(ok.verdicts.mcp, 'validated');
  assert.equal(ok.verdicts.tools, 'validated');
  assert.equal(ok.verdicts.brief, 'validated');

  const exited = await amazonQAdapter.verify({ transport: 'stdio', command: process.execPath, args: [serverPath, 'exit'], root });
  assert.equal(exited.handshake, null);
  assert.equal(exited.verdicts.mcp, 'unavailable');
  assert.equal(exited.errors[0]?.code, 'E3_HANDSHAKE_FAILED');
});

test('doctor isolates one failing adapter and never validates unverified clients', async (t) => {
  const root = rootFor(t);
  const home = join(root, 'home');
  mkdirSync(home);
  const env = { HOME: home, PATH: join(root, 'missing-bin') };

  const report = await doctorClients({
    clientIds: ['amazon-q', 'codegeex', 'tongyi-lingma', 'comate'],
    adapters: {
      'amazon-q': failingAdapter('amazon-q'),
      codegeex: codegeexAdapter,
      'tongyi-lingma': tongyiLingmaAdapter,
      comate: comateAdapter,
    },
    home,
    root,
    probePaths: [],
    env,
  });
  assert.equal(report.clients.length, 4);
  const failed = report.clients.find((client) => client.clientId === 'amazon-q')!;
  assert.ok(failed.errors.length >= 1, 'the isolated failure must land in the amazon-q report');
  assert.equal(failed.status, 'unavailable');

  for (const id of ['codegeex', 'tongyi-lingma', 'comate']) {
    const client = report.clients.find((entry) => entry.clientId === id)!;
    assert.equal(
      client.errors.some((error) => error.message.includes('exploded')),
      false,
      `${id} must not inherit the amazon-q failure`,
    );
    assert.notEqual(client.status, 'ready', `${id} must not be ready while unverified`);
    for (const layer of CAPABILITY_LAYERS) {
      assert.notEqual(client.layers[layer].verdict, 'validated', `${id}.${layer} must not be validated`);
    }
  }
});

test('detect and inspect leave an empty root untouched for all four adapters', async (t) => {
  const root = rootFor(t);
  const home = join(root, 'home');
  mkdirSync(home);
  const env = { HOME: home, PATH: join(root, 'missing-bin') };
  for (const adapter of [amazonQAdapter, codegeexAdapter, tongyiLingmaAdapter, comateAdapter]) {
    await adapter.detect({ env, cwd: root, probePaths: [join(root, 'missing-bin')] });
    await adapter.inspect({ root, env, cwd: root });
  }
  assert.deepEqual(readdirSync(root).sort(), ['home']);
  assert.deepEqual(readdirSync(home), []);
});
