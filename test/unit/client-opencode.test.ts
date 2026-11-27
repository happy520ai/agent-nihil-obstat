import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  CAPABILITY_LAYERS,
  CLIENT_REPORT_SCHEMA,
  MCP_TOOL_NAMES,
  type ClientAuthorizationRef,
  type ConfigInput,
  type LayerReport,
  type McpClientLike,
} from '../../src/clients/types.ts';
import {
  OPENCODE_IDENTITY_SOURCES,
  OPENCODE_SERVER_NAME,
  OPENCODE_SERVER_PATH,
  opencodeAdapter,
} from '../../src/clients/opencode.ts';
import { defaultRegistry } from '../../src/clients/registry.ts';

const AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function rootFor(t: TestContext, prefix = 'ano-opencode-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function fakeExecutable(root: string, name = 'opencode'): string {
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

function authorization(root: string, withStatement: boolean): ClientAuthorizationRef {
  const base = {
    authorizationId: 'b'.repeat(64),
    root,
    clientId: 'opencode',
    scope: ['config', 'install'],
    grantedBy: 'Alice',
    grantedAt: '2026-11-22T00:00:00.000Z',
    revokedAt: null,
  };
  return (withStatement ? { ...base, statement: 'Authorize ANO OpenCode configuration for this project' } : base) as ClientAuthorizationRef;
}

function configInput(overrides: Partial<ConfigInput> & { env?: Record<string, string> }): ConfigInput {
  return {
    target: { scope: 'project' },
    mode: 'dry-run',
    ...overrides,
  } as ConfigInput;
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

test('opencode adapter declares the executable/config-dir sources and the mcp.servers mapping', (t) => {
  assert.equal(opencodeAdapter.id, 'opencode');
  assert.deepEqual([...OPENCODE_SERVER_PATH], ['mcp', 'servers']);
  assert.equal(OPENCODE_SERVER_NAME, 'ano');
  assert.deepEqual(OPENCODE_IDENTITY_SOURCES, [
    { kind: 'executable', value: 'opencode', detail: 'OpenCode CLI on PATH' },
    { kind: 'config-path', value: '~/.config/opencode/', detail: 'user configuration directory' },
  ]);
  const descriptor = defaultRegistry.get('opencode');
  assert.ok(descriptor.configCandidates.some((candidate) => candidate.key === 'mcp.ano'));
});

test('opencode detect finds only declared sources and never guesses', async (t) => {
  const root = rootFor(t);
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  mkdirSync(home);
  mkdirSync(bin);
  const env = { HOME: home, PATH: bin };

  const absent = await opencodeAdapter.detect({ env, cwd: root, probePaths: [bin] });
  assert.equal(absent.detected, false);
  assert.deepEqual(absent.sources, []);

  const executableBin = fakeExecutable(root);
  const withExecutable = await opencodeAdapter.detect({ env: { ...env, PATH: executableBin }, cwd: root, probePaths: [executableBin] });
  assert.equal(withExecutable.detected, true);
  assert.equal(withExecutable.executablePath, join(executableBin, 'opencode'));
  assert.match(withExecutable.sources[0]?.detectedAt ?? '', AT_RE);

  mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
  const withConfigDir = await opencodeAdapter.detect({ env: { ...env, PATH: executableBin }, cwd: root, probePaths: [executableBin] });
  assert.ok(withConfigDir.sources.some((source) => source.kind === 'config-path' && source.source.includes(join('.config', 'opencode'))));
});

test('opencode inspect reports all nine layers and keeps unsupported layers degraded/unavailable', async (t) => {
  const root = rootFor(t);
  const home = join(root, 'home');
  mkdirSync(home);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const emptyEnv = { HOME: home, PATH: join(root, 'missing-bin') };

  const empty = await opencodeAdapter.inspect({ root, env: emptyEnv, cwd: root });
  assert.equal(empty.schema, CLIENT_REPORT_SCHEMA);
  assert.deepEqual(Object.keys(empty.layers).sort(), [...CAPABILITY_LAYERS].sort());
  assert.equal(empty.status, 'unavailable');
  for (const layer of CAPABILITY_LAYERS) {
    const report: LayerReport = empty.layers[layer];
    assert.equal(report.layer, layer);
    assert.ok(report.verdict === 'validated' || report.verdict === 'degraded' || report.verdict === 'unavailable');
    assert.ok(report.evidence === 'measured' || report.evidence === 'configured' || report.evidence === 'assumed' || report.evidence === 'absent');
    assert.equal(typeof report.at, 'string');
    assert.equal(typeof report.source, 'string');
    assert.ok(Array.isArray(report.limitations));
    assert.ok(Array.isArray(report.errors));
  }

  const detected = await opencodeAdapter.inspect({ root, env: envFor(home, fakeExecutable(root)), cwd: root });
  assert.equal(detected.status, 'degraded');
  assert.equal(detected.layers.detected.verdict, 'validated');
  assert.equal(detected.layers.configured.verdict, 'degraded');
  assert.equal(detected.layers.configured.evidence, 'absent');
  assert.equal(detected.layers.orchestration.verdict, 'degraded');
  assert.equal(detected.layers.orchestration.details.mode, 'explicit-workflow');
  assert.equal(detected.layers.history.verdict, 'unavailable');
  assert.equal(detected.layers['output-interception'].verdict, 'unavailable');
  assert.ok(detected.limitations.some((line) => line.includes('history unavailable')));
  assert.ok(detected.limitations.some((line) => line.includes('output-interception unavailable')));
});

test('opencode inspect discovers mcp.servers.ano read-only and prefers opencode.json', async (t) => {
  const root = rootFor(t);
  const home = join(root, 'home');
  mkdirSync(home);
  const bin = fakeExecutable(root);
  const env = envFor(home, bin);

  const altPath = join(root, '.opencode.json');
  writeJson(altPath, { mcp: { servers: { ano: { type: 'local', command: ['node', join(bin, 'server.js')] } } } });
  const altReport = await opencodeAdapter.inspect({ root, env, cwd: root });
  assert.equal(altReport.layers.configured.details.exists, true);
  assert.equal(altReport.layers.configured.details.key, 'mcp.servers.ano');
  assert.equal(altReport.layers.configured.details.configPath, altPath);
  assert.equal(altReport.layers.configured.verdict, 'degraded');
  assert.equal(altReport.layers.configured.evidence, 'configured');

  const primaryPath = join(root, 'opencode.json');
  writeJson(primaryPath, { mcp: { servers: { ano: { type: 'local', command: ['node', join(bin, 'primary.js')] } } } });
  const primaryReport = await opencodeAdapter.inspect({ root, env, cwd: root });
  assert.equal(primaryReport.layers.configured.details.configPath, primaryPath);
  assert.equal(readFileSync(altPath, 'utf8'), `${JSON.stringify({ mcp: { servers: { ano: { type: 'local', command: ['node', join(bin, 'server.js')] } } } }, null, 2)}\n`);
  assert.equal(existsSync(join(root, '.ano')), false);
});

test('opencode inspect detects AGENTS.md and the managed marker independently', async (t) => {
  const root = rootFor(t);
  const home = join(root, 'home');
  mkdirSync(home);
  const bin = fakeExecutable(root);
  const env = envFor(home, bin);

  const absent = await opencodeAdapter.inspect({ root, env, cwd: root });
  assert.equal(absent.layers.instructions.details.rulePaths.length, 0);
  assert.equal(absent.layers.instructions.evidence, 'absent');

  writeFileSync(join(root, 'AGENTS.md'), '# Project\n');
  const plain = await opencodeAdapter.inspect({ root, env, cwd: root });
  assert.equal(plain.layers.instructions.verdict, 'degraded');
  assert.equal(plain.layers.instructions.evidence, 'measured');
  assert.equal(plain.layers.instructions.details.hasManagedSection, false);
  assert.equal(plain.layers.instructions.details.readOnly, true);
  assert.ok(plain.layers.instructions.details.rulePaths.some((path) => path.endsWith('AGENTS.md')));

  writeFileSync(
    join(root, 'AGENTS.md'),
    `# Project\n<!-- ano:takeover:managed:v1:begin -->\nbody\n<!-- ano:takeover:managed:v1:end -->\n`,
  );
  const managed = await opencodeAdapter.inspect({ root, env, cwd: root });
  assert.equal(managed.layers.instructions.details.hasManagedSection, true);
});

test('opencode config dry-run previews the mcp.servers merge and writes nothing', async (t) => {
  const root = rootFor(t);
  const home = join(root, 'home');
  mkdirSync(home);
  const bin = fakeExecutable(root);
  const env = envFor(home, bin);
  const configPath = join(root, 'opencode.json');
  const original = { mcp: { servers: { other: { type: 'local', command: ['other'] } } }, theme: 'dark' };
  writeJson(configPath, original);
  const before = readFileSync(configPath);

  const result = await opencodeAdapter.config(configInput({ mode: 'dry-run', root, env }));
  assert.equal(result.mode, 'dry-run');
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0]?.operation, 'add');
  assert.equal(result.changes[0]?.key, 'mcp.servers.ano');
  assert.deepEqual(readFileSync(configPath), before);
  assert.equal(existsSync(join(root, '.ano')), false);
});

test('opencode config apply writes the documented local entry and preserves other servers and unknown fields', async (t) => {
  const root = rootFor(t);
  const home = join(root, 'home');
  mkdirSync(home);
  const bin = fakeExecutable(root);
  const env = envFor(home, bin);
  const configPath = join(root, 'opencode.json');
  const other = { type: 'local', command: ['other-bin', '--serve'], environment: { K: 'V' } };
  writeJson(configPath, { mcp: { servers: { other }, timeout: { startup: 1000 } }, theme: 'dark' });

  const applied = await opencodeAdapter.config(configInput({
    mode: 'apply',
    root,
    env,
    authorization: authorization(root, true),
  }));
  assert.equal(applied.mode, 'apply');
  assert.equal(applied.backupId === '', false);
  assert.equal(applied.afterHash !== '', true);
  const after = applied.changes[0]?.after as { type: string; command: string[] };
  assert.equal(after.type, 'local');
  assert.equal(after.command[0], 'node');
  assert.match(after.command[1] ?? '', /dist[\\/]surface[\\/]mcp\.js$/u);

  const document = readJson(configPath);
  const mcp = document['mcp'] as { servers: Record<string, unknown>; timeout: unknown };
  assert.deepEqual(mcp.servers.other, other);
  assert.deepEqual(mcp.timeout, { startup: 1000 });
  assert.deepEqual(mcp.servers.ano, { type: 'local', command: after.command });
  assert.equal(document['theme'], 'dark');
  assert.equal(existsSync(join(root, '.ano', 'clients', 'backups', 'opencode')), true);

  const replay = await opencodeAdapter.config(configInput({
    mode: 'apply',
    root,
    env,
    authorization: authorization(root, true),
  }));
  assert.equal(replay.mode, 'dry-run');
  if (replay.mode === 'dry-run') {
    assert.deepEqual(replay.changes, []);
    assert.ok(replay.warnings.some((line) => line.includes('already matches')));
  }
});

test('opencode config apply merges into an existing .opencode.json instead of creating opencode.json', async (t) => {
  const root = rootFor(t);
  const home = join(root, 'home');
  mkdirSync(home);
  const bin = fakeExecutable(root);
  const env = envFor(home, bin);
  const altPath = join(root, '.opencode.json');
  writeJson(altPath, { mcp: { servers: { other: { type: 'local', command: ['other'] } } } });
  const before = readFileSync(altPath);

  const preview = await opencodeAdapter.config(configInput({ mode: 'dry-run', root, env }));
  assert.equal(preview.mode, 'dry-run');
  if (preview.mode === 'dry-run') {
    assert.equal(preview.changes[0]?.path, altPath);
    assert.ok(preview.warnings.some((line) => line.includes('.opencode.json')));
  }

  const applied = await opencodeAdapter.config(configInput({
    mode: 'apply',
    root,
    env,
    authorization: authorization(root, true),
  }));
  assert.equal(applied.mode, 'apply');
  assert.equal(existsSync(join(root, 'opencode.json')), false, 'the existing .opencode.json must be updated, not shadowed');
  const document = readJson(altPath);
  const servers = (document['mcp'] as { servers: Record<string, unknown> }).servers;
  assert.ok(servers['other']);
  assert.ok(servers['ano']);
  assert.notDeepEqual(readFileSync(altPath), before);
});

test('opencode config apply refuses without a usable authorization and writes nothing', async (t) => {
  const root = rootFor(t);
  const home = join(root, 'home');
  mkdirSync(home);
  const bin = fakeExecutable(root);
  const env = envFor(home, bin);
  const configPath = join(root, 'opencode.json');
  writeJson(configPath, { mcp: { servers: {} } });
  const before = readFileSync(configPath);

  const missing = await opencodeAdapter.config(configInput({ mode: 'apply', root, env }));
  assert.equal(missing.mode, 'dry-run');
  assert.ok(missing.warnings.some((line) => line.includes('apply refused')));
  assert.deepEqual(readFileSync(configPath), before);

  const noStatement = await opencodeAdapter.config(configInput({
    mode: 'apply',
    root,
    env,
    authorization: authorization(root, false),
  }));
  assert.equal(noStatement.mode, 'dry-run');
  assert.ok(noStatement.warnings.some((line) => line.includes('statement')));
  assert.deepEqual(readFileSync(configPath), before);
  assert.equal(existsSync(join(root, '.ano')), false);
});

test('opencode verify accepts an injected client and never invents tools', async (t) => {
  const ok = await opencodeAdapter.verify({ transport: 'stdio', inject: injectedClient({}) });
  assert.equal(ok.verdicts.mcp, 'validated');
  assert.equal(ok.verdicts.tools, 'validated');
  assert.equal(ok.verdicts.brief, 'validated');

  const six = await opencodeAdapter.verify({ transport: 'stdio', inject: injectedClient({ tools: MCP_TOOL_NAMES.slice(0, 6) }) });
  assert.equal(six.verdicts.tools, 'degraded');
  assert.deepEqual(six.tools?.missing, ['audit']);

  const failed = await opencodeAdapter.verify({ transport: 'stdio', inject: injectedClient({ failHandshake: true }) });
  assert.equal(failed.verdicts.mcp, 'unavailable');
  assert.equal(failed.verdicts.tools, 'unavailable');
  const errors = failed.errors;
  assert.equal(errors[0]?.code, 'E3_HANDSHAKE_FAILED');
});

test('opencode detect and inspect leave the filesystem untouched on an empty root', async (t) => {
  const root = rootFor(t);
  const home = join(root, 'home');
  mkdirSync(home);
  const env = { HOME: home, PATH: join(root, 'missing-bin') };
  await opencodeAdapter.detect({ env, cwd: root });
  await opencodeAdapter.inspect({ root, env, cwd: root });
  assert.deepEqual(readdirSync(root).sort(), ['home']);
  assert.deepEqual(readdirSync(home), []);
});
