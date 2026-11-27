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
import { CURSOR_IDENTITY_SOURCES, CURSOR_SERVER_PATH, CURSOR_SERVER_NAME, cursorAdapter } from '../../src/clients/cursor.ts';
import { defaultRegistry } from '../../src/clients/registry.ts';

const AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function rootFor(t: TestContext, prefix = 'ano-cursor-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function fakeExecutable(root: string, name = 'cursor'): string {
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
    authorizationId: 'a'.repeat(64),
    root,
    clientId: 'cursor',
    scope: ['config', 'install'],
    grantedBy: 'Alice',
    grantedAt: '2026-11-22T00:00:00.000Z',
    revokedAt: null,
  };
  return (withStatement ? { ...base, statement: 'Authorize ANO Cursor configuration for this project' } : base) as ClientAuthorizationRef;
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

test('cursor adapter declares the registry identity sources and the mcpServers mapping', (t) => {
  assert.equal(cursorAdapter.id, 'cursor');
  assert.deepEqual([...CURSOR_SERVER_PATH], ['mcpServers']);
  assert.equal(CURSOR_SERVER_NAME, 'ano');
  const descriptor = defaultRegistry.get('cursor');
  assert.deepEqual(CURSOR_IDENTITY_SOURCES, descriptor.identitySources);
  assert.ok(descriptor.configCandidates.some((candidate) => candidate.key === 'mcpServers.ano'));
});

test('cursor detect finds only declared sources and never guesses', async (t) => {
  const root = rootFor(t);
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  mkdirSync(home);
  mkdirSync(bin);
  const env = { HOME: home, PATH: bin };

  const absent = await cursorAdapter.detect({ env, cwd: root, probePaths: [bin] });
  assert.equal(absent.detected, false);
  assert.deepEqual(absent.sources, []);
  assert.equal(absent.executablePath, null);

  const executableBin = fakeExecutable(root);
  const withExecutable = await cursorAdapter.detect({ env: { ...env, PATH: executableBin }, cwd: root, probePaths: [executableBin] });
  assert.equal(withExecutable.detected, true);
  assert.equal(withExecutable.executablePath, join(executableBin, 'cursor'));
  assert.equal(withExecutable.sources[0]?.kind, 'executable');
  assert.match(withExecutable.sources[0]?.detectedAt ?? '', AT_RE);

  mkdirSync(join(home, '.cursor'));
  const withUserDir = await cursorAdapter.detect({ env: { ...env, PATH: executableBin }, cwd: root, probePaths: [executableBin] });
  assert.ok(withUserDir.sources.some((source) => source.kind === 'config-path' && source.source.includes('.cursor')));

  mkdirSync(join(root, '.cursor', 'rules'), { recursive: true });
  const withProjectRules = await cursorAdapter.detect({ env: { ...env, PATH: executableBin }, cwd: root, probePaths: [executableBin] });
  assert.ok(withProjectRules.sources.some((source) => source.source.includes(join('.cursor', 'rules'))));
});

test('cursor inspect reports all nine layers and keeps unsupported layers degraded/unavailable', async (t) => {
  const root = rootFor(t);
  const home = join(root, 'home');
  mkdirSync(home);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const emptyEnv = { HOME: home, PATH: join(root, 'missing-bin') };

  const empty = await cursorAdapter.inspect({ root, env: emptyEnv, cwd: root });
  assert.equal(empty.schema, CLIENT_REPORT_SCHEMA);
  assert.deepEqual(Object.keys(empty.layers).sort(), [...CAPABILITY_LAYERS].sort());
  assert.equal(empty.status, 'unavailable');
  assert.equal(empty.layers.detected.verdict, 'unavailable');
  assert.equal(empty.layers.configured.verdict, 'unavailable');
  assert.equal(empty.layers.history.verdict, 'unavailable');
  assert.equal(empty.layers['output-interception'].verdict, 'unavailable');
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

  const detected = await cursorAdapter.inspect({ root, env: envFor(home, fakeExecutable(root)), cwd: root });
  assert.equal(detected.status, 'degraded');
  assert.equal(detected.layers.detected.verdict, 'validated');
  assert.equal(detected.layers.configured.verdict, 'degraded');
  assert.equal(detected.layers.configured.evidence, 'absent');
  assert.equal(detected.layers.orchestration.verdict, 'degraded');
  assert.equal(detected.layers.orchestration.details.mode, 'explicit-workflow');
  assert.equal(detected.layers.orchestration.evidence, 'assumed');
  assert.equal(detected.layers.history.verdict, 'unavailable');
  assert.equal(detected.layers['output-interception'].verdict, 'unavailable');
  assert.ok(detected.limitations.some((line) => line.includes('history unavailable')));
  assert.ok(detected.limitations.some((line) => line.includes('output-interception unavailable')));
  assert.ok(detected.limitations.some((line) => line.includes('would not imply')));
});

test('cursor inspect discovers an ano entry read-only and caps configured at degraded', async (t) => {
  const root = rootFor(t);
  const home = join(root, 'home');
  mkdirSync(home);
  const bin = fakeExecutable(root);
  const env = envFor(home, bin);
  const configPath = join(root, '.cursor', 'mcp.json');
  const original = {
    mcpServers: {
      ano: { command: 'node', args: [join(bin, 'server.js')] },
      other: { command: 'other', args: [] },
    },
    unknownTop: { keep: [1, 2, 3] },
  };
  writeJson(configPath, original);

  const report = await cursorAdapter.inspect({ root, env, cwd: root });
  const configured = report.layers.configured;
  assert.equal(configured.verdict, 'degraded');
  assert.equal(configured.evidence, 'configured');
  assert.equal(configured.details.exists, true);
  assert.equal(configured.details.key, 'mcpServers.ano');
  assert.equal(configured.details.scope, 'project');
  assert.ok(configured.limitations.some((line) => line.includes('no real stdio handshake')));
  assert.equal(readFileSync(configPath, 'utf8'), `${JSON.stringify(original, null, 2)}\n`, 'inspect must not modify the config');
  assert.equal(existsSync(join(root, '.ano')), false, 'inspect must not create backup state');
});

test('cursor inspect detects .cursorrules, .cursor/rules/*.mdc and the managed marker independently', async (t) => {
  const root = rootFor(t);
  const home = join(root, 'home');
  mkdirSync(home);
  const bin = fakeExecutable(root);
  const env = envFor(home, bin);

  const noRules = await cursorAdapter.inspect({ root, env, cwd: root });
  assert.equal(noRules.layers.instructions.verdict, 'degraded');
  assert.equal(noRules.layers.instructions.evidence, 'absent');
  assert.deepEqual(noRules.layers.instructions.details.rulePaths, []);

  writeFileSync(join(root, '.cursorrules'), 'legacy rule\n');
  mkdirSync(join(root, '.cursor', 'rules'), { recursive: true });
  writeFileSync(
    join(root, '.cursor', 'rules', 'ano.mdc'),
    `---\ndescription: ANO\nglobs:\nalwaysApply: false\n---\nmanaged body\n`,
  );
  const withRules = await cursorAdapter.inspect({ root, env, cwd: root });
  const instructions = withRules.layers.instructions;
  assert.equal(instructions.verdict, 'degraded');
  assert.equal(instructions.evidence, 'measured');
  assert.equal(instructions.details.hasManagedSection, false);
  assert.equal(instructions.details.formatVersion, 'cursor-mdc/1');
  assert.equal(instructions.details.readOnly, true);
  assert.ok(instructions.details.rulePaths.some((path) => path.endsWith('.cursorrules')));
  assert.ok(instructions.details.rulePaths.some((path) => path.endsWith(join('.cursor', 'rules', 'ano.mdc'))));

  writeFileSync(
    join(root, '.cursorrules'),
    `legacy\n<!-- ano:takeover:managed:v1:begin -->\nbody\n<!-- ano:takeover:managed:v1:end -->\n`,
  );
  const managed = await cursorAdapter.inspect({ root, env, cwd: root });
  assert.equal(managed.layers.instructions.details.hasManagedSection, true);
  assert.equal(
    managed.layers.instructions.limitations.some((line) => line.includes('no ANO managed-section marker')),
    false,
  );
});

test('cursor config dry-run previews the merge, preserves unknown fields and writes nothing', async (t) => {
  const root = rootFor(t);
  const home = join(root, 'home');
  mkdirSync(home);
  const bin = fakeExecutable(root);
  const env = envFor(home, bin);
  const configPath = join(root, '.cursor', 'mcp.json');
  const original = {
    mcpServers: { other: { command: 'other', args: ['--serve'] } },
    unknownTop: { keep: true },
  };
  writeJson(configPath, original);
  const before = readFileSync(configPath);

  const result = await cursorAdapter.config(configInput({ mode: 'dry-run', root, env }));
  assert.equal(result.mode, 'dry-run');
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0]?.operation, 'add');
  assert.equal(result.changes[0]?.key, 'mcpServers.ano');
  assert.equal(result.changes[0]?.scope, 'project');
  assert.equal(result.changes[0]?.path, configPath);
  assert.deepEqual(readFileSync(configPath), before, 'dry-run must not write');
  assert.equal(existsSync(join(root, '.ano')), false, 'dry-run must not create backups');

  const missing = await cursorAdapter.config(configInput({ mode: 'dry-run', root: join(root, 'elsewhere'), env }));
  assert.equal(missing.mode, 'dry-run');
  assert.ok(missing.warnings.some((line) => line.includes('zero write')));
});

test('cursor config apply merges only the ano entry and preserves other services and unknown fields', async (t) => {
  const root = rootFor(t);
  const home = join(root, 'home');
  mkdirSync(home);
  const bin = fakeExecutable(root);
  const env = envFor(home, bin);
  const configPath = join(root, '.cursor', 'mcp.json');
  const other = { command: 'other-bin', args: ['--serve'], nested: { keep: [1, 2, 3] } };
  writeJson(configPath, { mcpServers: { other }, unknownTop: { z: 1 } });

  const applied = await cursorAdapter.config(configInput({
    mode: 'apply',
    root,
    env,
    authorization: authorization(root, true),
  }));
  assert.equal(applied.mode, 'apply');
  assert.equal(applied.backupId === '', false);
  assert.equal(applied.backupHash === '', false);
  assert.equal(applied.beforeHash === '', false);
  assert.equal(applied.afterHash !== '', true);

  const document = readJson(configPath);
  assert.deepEqual(document['mcpServers'], {
    other,
    ano: { command: 'node', args: [applied.changes[0]?.after && ((applied.changes[0].after as { args: string[] }).args[0])] },
  });
  assert.deepEqual(document['unknownTop'], { z: 1 });
  assert.equal(existsSync(join(root, '.ano', 'clients', 'backups', 'cursor')), true);

  const replay = await cursorAdapter.config(configInput({
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

test('cursor config apply refuses without a usable authorization and writes nothing', async (t) => {
  const root = rootFor(t);
  const home = join(root, 'home');
  mkdirSync(home);
  const bin = fakeExecutable(root);
  const env = envFor(home, bin);
  const configPath = join(root, '.cursor', 'mcp.json');
  writeJson(configPath, { mcpServers: {} });
  const before = readFileSync(configPath);

  const missing = await cursorAdapter.config(configInput({ mode: 'apply', root, env }));
  assert.equal(missing.mode, 'dry-run');
  assert.ok(missing.warnings.some((line) => line.includes('apply refused')));
  assert.deepEqual(readFileSync(configPath), before);

  const noStatement = await cursorAdapter.config(configInput({
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

test('cursor config refuses a target outside the declared scope and writes nothing', async (t) => {
  const root = rootFor(t);
  const outside = rootFor(t, 'ano-cursor-outside-');
  const home = join(root, 'home');
  mkdirSync(home);
  const env = envFor(home, fakeExecutable(root));
  const targetPath = join(outside, 'mcp.json');
  writeJson(targetPath, { mcpServers: {} });
  const before = readFileSync(targetPath);

  const result = await cursorAdapter.config(configInput({
    mode: 'apply',
    root,
    env,
    target: { scope: 'project', path: targetPath },
    authorization: authorization(root, true),
  }));
  assert.equal(result.mode, 'dry-run');
  assert.ok(result.warnings.some((line) => /escapes|scope|failed/iu.test(line)));
  assert.deepEqual(readFileSync(targetPath), before);
});

test('cursor verify performs a real stdio handshake and refuses to amplify on failure', async (t) => {
  const root = rootFor(t);
  const serverPath = join(root, 'fake-mcp-server.mjs');
  writeFileSync(serverPath, FAKE_SERVER);

  const ok = await cursorAdapter.verify({ transport: 'stdio', command: process.execPath, args: [serverPath, 'ok'], root });
  assert.equal(ok.handshake?.protocolVersion, '2025-06-18');
  assert.equal(ok.tools?.count, 7);
  assert.deepEqual(ok.tools?.names, [...MCP_TOOL_NAMES]);
  assert.equal(ok.verdicts.mcp, 'validated');
  assert.equal(ok.verdicts.tools, 'validated');
  assert.equal(ok.verdicts.brief, 'validated');

  const six = await cursorAdapter.verify({ transport: 'stdio', command: process.execPath, args: [serverPath, 'six'], root });
  assert.equal(six.verdicts.mcp, 'validated');
  assert.equal(six.verdicts.tools, 'degraded');
  assert.deepEqual(six.tools?.missing, ['audit']);

  const exited = await cursorAdapter.verify({ transport: 'stdio', command: process.execPath, args: [serverPath, 'exit'], root });
  assert.equal(exited.handshake, null);
  assert.equal(exited.verdicts.mcp, 'unavailable');
  assert.equal(exited.verdicts.tools, 'unavailable');
  assert.equal(exited.verdicts.brief, 'unavailable');
  assert.equal(exited.errors[0]?.code, 'E3_HANDSHAKE_FAILED');
});

test('cursor verify accepts an injected client and never invents tools', async (t) => {
  const ok = await cursorAdapter.verify({ transport: 'stdio', inject: injectedClient({}) });
  assert.equal(ok.verdicts.mcp, 'validated');
  assert.equal(ok.verdicts.tools, 'validated');
  assert.equal(ok.verdicts.brief, 'validated');

  const six = await cursorAdapter.verify({ transport: 'stdio', inject: injectedClient({ tools: MCP_TOOL_NAMES.slice(0, 6) }) });
  assert.equal(six.verdicts.tools, 'degraded');
  assert.deepEqual(six.tools?.missing, ['audit']);

  const failed = await cursorAdapter.verify({ transport: 'stdio', inject: injectedClient({ failHandshake: true }) });
  assert.equal(failed.verdicts.mcp, 'unavailable');
  assert.equal(failed.verdicts.tools, 'unavailable');
  const errors = failed.errors;
  assert.equal(errors[0]?.code, 'E3_HANDSHAKE_FAILED');
});

test('cursor detect and inspect leave the filesystem untouched on an empty root', async (t) => {
  const root = rootFor(t);
  const home = join(root, 'home');
  mkdirSync(home);
  const env = { HOME: home, PATH: join(root, 'missing-bin') };
  await cursorAdapter.detect({ env, cwd: root });
  await cursorAdapter.inspect({ root, env, cwd: root });
  assert.deepEqual(readdirSync(root).sort(), ['home']);
  assert.deepEqual(readdirSync(home), []);
});
