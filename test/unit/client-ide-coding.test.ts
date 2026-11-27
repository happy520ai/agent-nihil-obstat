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
  type ClientReport,
  type ConfigInput,
  type LayerReport,
  type McpClientLike,
} from '../../src/clients/types.ts';
import {
  GITHUB_COPILOT_IDENTITY_SOURCES,
  GITHUB_COPILOT_SERVER_NAME,
  GITHUB_COPILOT_SERVER_PATH,
  githubCopilotAdapter,
} from '../../src/clients/github-copilot.ts';
import { ZED_IDENTITY_SOURCES, ZED_SERVER_NAME, ZED_SERVER_PATH, zedAdapter, zedUserSettingsPath } from '../../src/clients/zed.ts';
import { JETBRAINS_AI_IDENTITY_SOURCES, jetbrainsAiAdapter } from '../../src/clients/jetbrains-ai.ts';
import { TABNINE_IDENTITY_SOURCES, tabnineAdapter } from '../../src/clients/tabnine.ts';
import { defaultRegistry } from '../../src/clients/registry.ts';

const AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function rootFor(t: TestContext, prefix = 'ano-ide-'): string {
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
  return (withStatement ? { ...base, statement: 'Authorize ANO configuration for this project' } : base) as ClientAuthorizationRef;
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

function assertNineLayers(report: ClientReport): void {
  assert.equal(report.schema, CLIENT_REPORT_SCHEMA);
  assert.deepEqual(Object.keys(report.layers).sort(), [...CAPABILITY_LAYERS].sort());
  for (const layer of CAPABILITY_LAYERS) {
    const entry: LayerReport = report.layers[layer];
    assert.equal(entry.layer, layer);
    assert.ok(entry.verdict === 'validated' || entry.verdict === 'degraded' || entry.verdict === 'unavailable');
    assert.ok(entry.evidence === 'measured' || entry.evidence === 'configured' || entry.evidence === 'assumed' || entry.evidence === 'absent');
    assert.equal(typeof entry.at, 'string');
    assert.match(entry.at, AT_RE);
    assert.equal(typeof entry.source, 'string');
    assert.ok(Array.isArray(entry.limitations));
    assert.ok(Array.isArray(entry.errors));
  }
}

test('four adapters declare the registry identity sources and public MCP mappings', (t) => {
  assert.equal(githubCopilotAdapter.id, 'github-copilot');
  assert.equal(zedAdapter.id, 'zed');
  assert.equal(jetbrainsAiAdapter.id, 'jetbrains-ai');
  assert.equal(tabnineAdapter.id, 'tabnine');

  assert.deepEqual(GITHUB_COPILOT_IDENTITY_SOURCES, defaultRegistry.get('github-copilot').identitySources);
  assert.deepEqual(ZED_IDENTITY_SOURCES, defaultRegistry.get('zed').identitySources);
  assert.deepEqual(JETBRAINS_AI_IDENTITY_SOURCES, defaultRegistry.get('jetbrains-ai').identitySources);
  assert.deepEqual(TABNINE_IDENTITY_SOURCES, defaultRegistry.get('tabnine').identitySources);

  assert.deepEqual([...GITHUB_COPILOT_SERVER_PATH], ['mcpServers']);
  assert.equal(GITHUB_COPILOT_SERVER_NAME, 'ano');
  assert.deepEqual([...ZED_SERVER_PATH], ['context_servers']);
  assert.equal(ZED_SERVER_NAME, 'ano');

  for (const id of ['github-copilot', 'zed', 'jetbrains-ai', 'tabnine']) {
    const descriptor = defaultRegistry.get(id);
    assert.equal(descriptor.identityStatus, 'declared');
    assert.equal(descriptor.initialVerdict, 'unverified', `${id} must start unverified`);
    assert.notEqual(descriptor.initialVerdict, 'validated');
  }
});

test('github-copilot detect finds only declared sources and never guesses', async (t) => {
  const root = rootFor(t);
  const home = join(root, 'home');
  mkdirSync(home);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const env = { HOME: home, PATH: bin };

  const absent = await githubCopilotAdapter.detect({ env, cwd: root, probePaths: [bin] });
  assert.equal(absent.detected, false);
  assert.deepEqual(absent.sources, []);
  assert.equal(absent.executablePath, null);

  // A project-only .mcp.json is a config candidate but not a declared identity source: no guessing.
  writeJson(join(root, '.mcp.json'), { mcpServers: {} });
  const projectOnly = await githubCopilotAdapter.detect({ env, cwd: root, probePaths: [bin] });
  assert.equal(projectOnly.detected, false);

  const executableBin = fakeExecutable(root, 'copilot');
  const withExecutable = await githubCopilotAdapter.detect({
    env: { ...env, PATH: executableBin },
    cwd: root,
    probePaths: [executableBin],
  });
  assert.equal(withExecutable.detected, true);
  assert.equal(withExecutable.executablePath, join(executableBin, 'copilot'));
  assert.equal(withExecutable.version, null, 'detect never fabricates a version');
  assert.equal(withExecutable.sources[0]?.kind, 'executable');
  assert.match(withExecutable.sources[0]?.detectedAt ?? '', AT_RE);

  writeJson(join(home, '.copilot', 'mcp-config.json'), { mcpServers: {} });
  const withUserConfig = await githubCopilotAdapter.detect({
    env: { ...env, PATH: executableBin },
    cwd: root,
    probePaths: [executableBin],
  });
  assert.ok(withUserConfig.sources.some((source) => source.kind === 'config-path' && source.source.includes('.copilot')));

  writeFileSync(join(home, '.copilot', 'copilot-instructions.md'), 'instructions\n');
  const withInstructions = await githubCopilotAdapter.detect({
    env: { ...env, PATH: executableBin },
    cwd: root,
    probePaths: [executableBin],
  });
  assert.ok(withInstructions.sources.some((source) => source.source.includes('copilot-instructions.md')));
});

test('github-copilot inspect reports nine layers, caps detected at degraded and degrades unsupported layers', async (t) => {
  const root = rootFor(t);
  const home = join(root, 'home');
  mkdirSync(home);
  const env = { HOME: home, PATH: join(root, 'missing-bin') };

  const empty = await githubCopilotAdapter.inspect({ root, env, cwd: root });
  assertNineLayers(empty);
  assert.equal(empty.status, 'unavailable');
  assert.equal(empty.coreVerdict, 'unavailable');
  assert.equal(empty.layers.detected.verdict, 'unavailable');
  assert.equal(empty.layers.configured.verdict, 'unavailable');
  assert.equal(empty.layers.mcp.verdict, 'unavailable');
  assert.equal(empty.layers.tools.verdict, 'unavailable');
  assert.equal(empty.layers.brief.verdict, 'unavailable');
  assert.equal(empty.layers.instructions.verdict, 'unavailable');
  assert.equal(empty.layers.history.verdict, 'unavailable');
  assert.equal(empty.layers['output-interception'].verdict, 'unavailable');

  const bin = fakeExecutable(root, 'copilot');
  const detected = await githubCopilotAdapter.inspect({ root, env: envFor(home, bin), cwd: root });
  assertNineLayers(detected);
  assert.equal(detected.status, 'degraded');
  assert.equal(detected.layers.detected.verdict, 'degraded', 'executable existence is E2 only; not validated');
  assert.equal(detected.layers.detected.evidence, 'measured');
  assert.equal(detected.layers.configured.verdict, 'degraded');
  assert.equal(detected.layers.configured.evidence, 'absent');
  assert.equal(detected.layers.orchestration.verdict, 'degraded');
  assert.equal(detected.layers.orchestration.details.mode, 'explicit-workflow');
  assert.equal(detected.layers.orchestration.details.measured, false);
  assert.equal(detected.layers.orchestration.evidence, 'assumed');
  assert.equal(detected.layers.history.verdict, 'unavailable');
  assert.equal(detected.layers['output-interception'].verdict, 'unavailable');
  assert.ok(detected.limitations.some((line) => line.includes('history unavailable')));
  assert.ok(detected.limitations.some((line) => line.includes('output-interception unavailable')));
  assert.ok(detected.limitations.some((line) => line.includes('code completion')));
  assert.ok(detected.limitations.some((line) => line.includes('would not imply')));
});

test('github-copilot inspect discovers an ano entry read-only in user and project candidates', async (t) => {
  const root = rootFor(t);
  const home = join(root, 'home');
  mkdirSync(home);
  const bin = fakeExecutable(root, 'copilot');
  const env = envFor(home, bin);
  const userConfigPath = join(home, '.copilot', 'mcp-config.json');
  const projectConfigPath = join(root, '.mcp.json');

  // No candidate exists: degraded with an explicit "no ano entry" limitation.
  const none = await githubCopilotAdapter.inspect({ root, env, cwd: root });
  assert.equal(none.layers.configured.verdict, 'degraded');
  assert.equal(none.layers.configured.details.exists, false);
  assert.ok(none.layers.configured.limitations.some((line) => line.includes('no ano MCP entry')));

  const original = {
    mcpServers: {
      ano: { command: 'node', args: [join(bin, 'server.js')] },
      other: { command: 'other', args: [] },
    },
    unknownTop: { keep: [1, 2, 3] },
  };
  writeJson(projectConfigPath, original);
  const projectReport = await githubCopilotAdapter.inspect({ root, env, cwd: root });
  const projectConfigured = projectReport.layers.configured;
  assert.equal(projectConfigured.verdict, 'degraded');
  assert.equal(projectConfigured.evidence, 'configured');
  assert.equal(projectConfigured.details.exists, true);
  assert.equal(projectConfigured.details.key, 'mcpServers.ano');
  assert.equal(projectConfigured.details.scope, 'project');
  assert.equal(projectConfigured.details.configPath, projectConfigPath);
  assert.ok(projectConfigured.limitations.some((line) => line.includes('no real stdio handshake')));
  assert.equal(readFileSync(projectConfigPath, 'utf8'), `${JSON.stringify(original, null, 2)}\n`);
  assert.equal(existsSync(join(root, '.ano')), false);

  writeJson(userConfigPath, original);
  const userReport = await githubCopilotAdapter.inspect({ root, env, cwd: root });
  assert.equal(userReport.layers.configured.details.scope, 'user');
  assert.equal(userReport.layers.configured.details.configPath, userConfigPath);
});

test('github-copilot inspect detects instruction files and the managed marker read-only', async (t) => {
  const root = rootFor(t);
  const home = join(root, 'home');
  mkdirSync(home);
  const bin = fakeExecutable(root, 'copilot');
  const env = envFor(home, bin);

  const none = await githubCopilotAdapter.inspect({ root, env, cwd: root });
  assert.equal(none.layers.instructions.verdict, 'degraded');
  assert.equal(none.layers.instructions.evidence, 'absent');
  assert.deepEqual(none.layers.instructions.details.rulePaths, []);

  mkdirSync(join(root, '.github'), { recursive: true });
  writeFileSync(join(root, '.github', 'copilot-instructions.md'), 'project instructions\n');
  mkdirSync(join(home, '.copilot'), { recursive: true });
  writeFileSync(join(home, '.copilot', 'copilot-instructions.md'), 'user instructions\n');
  const withRules = await githubCopilotAdapter.inspect({ root, env, cwd: root });
  const instructions = withRules.layers.instructions;
  assert.equal(instructions.verdict, 'degraded');
  assert.equal(instructions.evidence, 'measured');
  assert.equal(instructions.details.readOnly, true);
  assert.ok(instructions.details.rulePaths.some((path) => path.endsWith(join('.github', 'copilot-instructions.md'))));
  assert.ok(instructions.details.rulePaths.some((path) => path.endsWith(join('.copilot', 'copilot-instructions.md'))));

  writeFileSync(
    join(root, '.github', 'copilot-instructions.md'),
    `body\n<!-- ano:takeover:managed:v1:begin -->\nmanaged\n<!-- ano:takeover:managed:v1:end -->\n`,
  );
  const managed = await githubCopilotAdapter.inspect({ root, env, cwd: root });
  assert.equal(managed.layers.instructions.details.hasManagedSection, true);
});

test('github-copilot config dry-run previews the documented mcpServers merge and writes nothing', async (t) => {
  const root = rootFor(t);
  const home = join(root, 'home');
  mkdirSync(home);
  const bin = fakeExecutable(root, 'copilot');
  const env = envFor(home, bin);
  const configPath = join(root, '.mcp.json');
  const original = { mcpServers: { other: { command: 'other', args: ['--serve'] } }, unknownTop: { keep: true } };
  writeJson(configPath, original);
  const before = readFileSync(configPath);

  const result = await githubCopilotAdapter.config(configInput({ mode: 'dry-run', root, env }));
  assert.equal(result.mode, 'dry-run');
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0]?.operation, 'add');
  assert.equal(result.changes[0]?.key, 'mcpServers.ano');
  assert.equal(result.changes[0]?.scope, 'project');
  assert.equal(result.changes[0]?.path, configPath);
  assert.deepEqual(readFileSync(configPath), before, 'dry-run must not write');
  assert.equal(existsSync(join(root, '.ano')), false, 'dry-run must not create backups');

  mkdirSync(join(home, '.copilot'), { recursive: true });
  const userResult = await githubCopilotAdapter.config(configInput({ mode: 'dry-run', root, env, target: { scope: 'user' } }));
  assert.equal(userResult.mode, 'dry-run');
  assert.equal(userResult.changes.length, 1);
  assert.equal(userResult.changes[0]?.key, 'mcpServers.ano');
  assert.ok(userResult.changes[0]?.path?.includes(join('.copilot', 'mcp-config.json')));

  const missing = await githubCopilotAdapter.config(configInput({ mode: 'dry-run', root: join(root, 'elsewhere'), env }));
  assert.equal(missing.mode, 'dry-run');
  assert.ok(missing.warnings.some((line) => line.includes('zero write')));
});

test('github-copilot config apply merges only ano and refuses without authorization', async (t) => {
  const root = rootFor(t);
  const home = join(root, 'home');
  mkdirSync(home);
  const bin = fakeExecutable(root, 'copilot');
  const env = envFor(home, bin);
  const configPath = join(root, '.mcp.json');
  const other = { command: 'other-bin', args: ['--serve'], nested: { keep: [1, 2, 3] } };
  writeJson(configPath, { mcpServers: { other }, unknownTop: { z: 1 } });

  const missing = await githubCopilotAdapter.config(configInput({ mode: 'apply', root, env }));
  assert.equal(missing.mode, 'dry-run');
  assert.ok(missing.warnings.some((line) => line.includes('apply refused')));
  assert.equal(readFileSync(configPath, 'utf8'), `${JSON.stringify({ mcpServers: { other }, unknownTop: { z: 1 } }, null, 2)}\n`);
  assert.equal(existsSync(join(root, '.ano')), false);

  const noStatement = await githubCopilotAdapter.config(configInput({
    mode: 'apply',
    root,
    env,
    authorization: authorization(root, 'github-copilot', false),
  }));
  assert.equal(noStatement.mode, 'dry-run');
  assert.ok(noStatement.warnings.some((line) => line.includes('statement')));

  const applied = await githubCopilotAdapter.config(configInput({
    mode: 'apply',
    root,
    env,
    authorization: authorization(root, 'github-copilot', true),
  }));
  assert.equal(applied.mode, 'apply');
  assert.notEqual(applied.backupId, '');
  const document = readJson(configPath);
  assert.deepEqual(document['unknownTop'], { z: 1 });
  const servers = document['mcpServers'] as Record<string, unknown>;
  assert.deepEqual(servers['other'], other);
  assert.equal(typeof servers['ano'], 'object');
  assert.equal(existsSync(join(root, '.ano', 'clients', 'backups', 'github-copilot')), true);

  const replay = await githubCopilotAdapter.config(configInput({
    mode: 'apply',
    root,
    env,
    authorization: authorization(root, 'github-copilot', true),
  }));
  assert.equal(replay.mode, 'dry-run');
  if (replay.mode === 'dry-run') {
    assert.deepEqual(replay.changes, []);
    assert.ok(replay.warnings.some((line) => line.includes('already matches')));
  }
});

test('github-copilot config refuses a target outside the declared scope and isolates malformed config', async (t) => {
  const root = rootFor(t);
  const outside = rootFor(t, 'ano-ide-outside-');
  const home = join(root, 'home');
  mkdirSync(home);
  const env = envFor(home, fakeExecutable(root, 'copilot'));
  const targetPath = join(outside, 'mcp.json');
  writeJson(targetPath, { mcpServers: {} });
  const before = readFileSync(targetPath);

  const escaped = await githubCopilotAdapter.config(configInput({
    mode: 'apply',
    root,
    env,
    target: { scope: 'project', path: targetPath },
    authorization: authorization(root, 'github-copilot', true),
  }));
  assert.equal(escaped.mode, 'dry-run');
  assert.ok(escaped.warnings.some((line) => /escapes|scope|failed/iu.test(line)));
  assert.deepEqual(readFileSync(targetPath), before);

  const malformed = join(root, '.mcp.json');
  mkdirSync(dirname(malformed), { recursive: true });
  writeFileSync(malformed, '{ not json');
  const report = await githubCopilotAdapter.inspect({ root, env, cwd: root });
  assert.equal(report.layers.configured.verdict, 'degraded');
  assert.ok(report.errors.some((error) => error.code === 'E2_PARSE_FAILED' && error.layer === 'configured'));
  assert.ok(report.layers.configured.errors.some((error) => error.code === 'E2_PARSE_FAILED'));
});

test('github-copilot verify uses injected client and isolates handshake failure without amplifying', async (t) => {
  const ok = await githubCopilotAdapter.verify({ transport: 'stdio', inject: injectedClient({}) });
  assert.equal(ok.verdicts.mcp, 'validated');
  assert.equal(ok.verdicts.tools, 'validated');
  assert.equal(ok.verdicts.brief, 'validated');
  assert.equal(ok.tools?.count, 7);

  const six = await githubCopilotAdapter.verify({ transport: 'stdio', inject: injectedClient({ tools: MCP_TOOL_NAMES.slice(0, 6) }) });
  assert.equal(six.verdicts.tools, 'degraded');
  assert.deepEqual(six.tools?.missing, ['audit']);

  const failed = await githubCopilotAdapter.verify({ transport: 'stdio', inject: injectedClient({ failHandshake: true }) });
  assert.equal(failed.handshake, null);
  assert.equal(failed.verdicts.mcp, 'unavailable');
  assert.equal(failed.verdicts.tools, 'unavailable');
  assert.equal(failed.verdicts.brief, 'unavailable');
  assert.equal(failed.errors[0]?.code, 'E3_HANDSHAKE_FAILED');

  const noCommand = await githubCopilotAdapter.verify({ transport: 'stdio' });
  assert.equal(noCommand.verdicts.mcp, 'unavailable');
  assert.equal(noCommand.errors[0]?.code, 'E3_NO_COMMAND');
});

test('zed detect probes the declared settings candidates and never guesses', async (t) => {
  const root = rootFor(t);
  const home = join(root, 'home');
  mkdirSync(home);
  const env = { HOME: home, PATH: join(root, 'missing-bin') };

  const absent = await zedAdapter.detect({ env, cwd: root });
  assert.equal(absent.detected, false);
  assert.deepEqual(absent.sources, []);

  // A project .zed/settings.json is a config candidate but not a declared identity source.
  writeJson(join(root, '.zed', 'settings.json'), { context_servers: {} });
  const projectOnly = await zedAdapter.detect({ env, cwd: root });
  assert.equal(projectOnly.detected, false);

  const linux = join(home, '.config', 'zed', 'settings.json');
  writeJson(linux, {});
  const withLinux = await zedAdapter.detect({ env, cwd: root });
  assert.equal(withLinux.detected, true);
  assert.equal(withLinux.executablePath, null);
  assert.equal(withLinux.version, null);
  assert.ok(withLinux.sources.some((source) => source.kind === 'config-path' && source.source === `config-path:${linux}`));

  const windows = join(home, 'AppData', 'Roaming', 'Zed', 'settings.json');
  writeJson(windows, {});
  const withWindows = await zedAdapter.detect({ env, cwd: root });
  assert.ok(withWindows.sources.some((source) => source.source === `config-path:${windows}`));
});

test('zed inspect reports nine layers, keeps instructions unavailable and caps configured at degraded', async (t) => {
  const root = rootFor(t);
  const home = join(root, 'home');
  mkdirSync(home);
  const env = { HOME: home, PATH: join(root, 'missing-bin') };

  const empty = await zedAdapter.inspect({ root, env, cwd: root });
  assertNineLayers(empty);
  assert.equal(empty.status, 'unavailable');
  assert.equal(empty.layers.detected.verdict, 'unavailable');
  assert.equal(empty.layers.instructions.verdict, 'unavailable');
  assert.ok(empty.layers.instructions.limitations.some((line) => line.includes('not guessed')));

  const settingsPath = zedUserSettingsPath(home);
  writeJson(settingsPath, {
    context_servers: { ano: { command: 'node', args: ['server.js'] }, other: { command: 'other' } },
    theme: 'andromeda',
  });
  const detected = await zedAdapter.inspect({ root, env, cwd: root });
  assertNineLayers(detected);
  assert.equal(detected.status, 'degraded');
  assert.equal(detected.layers.detected.verdict, 'degraded');
  assert.equal(detected.layers.configured.verdict, 'degraded');
  assert.equal(detected.layers.configured.evidence, 'configured');
  assert.equal(detected.layers.configured.details.key, 'context_servers.ano');
  assert.equal(detected.layers.configured.details.scope, 'user');
  assert.equal(detected.layers.configured.details.configPath, settingsPath);
  assert.ok(detected.layers.configured.limitations.some((line) => line.includes('no real stdio handshake')));
  assert.ok(detected.layers.configured.limitations.some((line) => line.includes('documented local-server form')));
  assert.ok(detected.layers.configured.limitations.some((line) => line.includes('settings path is unverified')));
  assert.equal(detected.layers.instructions.verdict, 'unavailable');
  assert.equal(detected.layers.orchestration.details.mode, 'explicit-workflow');
  assert.equal(detected.layers.history.verdict, 'unavailable');
  assert.equal(detected.layers['output-interception'].verdict, 'unavailable');
  assert.ok(detected.limitations.some((line) => line.includes('path is unverified')));

  writeJson(settingsPath, { context_servers: {} });
  const sameRootProjectSettings = join(root, '.zed', 'settings.json');
  writeJson(sameRootProjectSettings, { context_servers: { ano: { command: 'node', args: ['server.js'] } } });
  const projectDiscovered = await zedAdapter.inspect({ root, env, cwd: root });
  assert.equal(projectDiscovered.layers.configured.verdict, 'degraded');
  assert.equal(projectDiscovered.layers.configured.details.scope, 'project');
  assert.equal(projectDiscovered.layers.configured.details.configPath, sameRootProjectSettings);
  assert.equal(projectDiscovered.layers.configured.details.key, 'context_servers.ano');

  const projectRoot = rootFor(t, 'ano-ide-zed-project-');
  const projectHome = join(projectRoot, 'home');
  mkdirSync(projectHome);
  const projectSettings = join(projectRoot, '.zed', 'settings.json');
  writeJson(projectSettings, { context_servers: {} });
  const project = await zedAdapter.inspect({ root: projectRoot, env: { HOME: projectHome, PATH: join(projectRoot, 'missing-bin') }, cwd: projectRoot });
  assert.equal(project.layers.detected.verdict, 'unavailable');
  assert.equal(project.layers.configured.verdict, 'unavailable', 'project settings alone are not a declared identity source');
  assert.equal(project.layers.configured.details.exists, false);
});

test('zed config dry-run and apply target the documented context_servers key', async (t) => {
  const root = rootFor(t);
  const home = join(root, 'home');
  mkdirSync(home);
  const env = { HOME: home, PATH: join(root, 'missing-bin') };
  const settingsPath = zedUserSettingsPath(home);
  const original = { context_servers: { other: { command: 'other' } }, theme: 'andromeda' };
  writeJson(settingsPath, original);
  const before = readFileSync(settingsPath);

  const dry = await zedAdapter.config(configInput({ mode: 'dry-run', root, env, target: { scope: 'user' } }));
  assert.equal(dry.mode, 'dry-run');
  assert.equal(dry.changes.length, 1);
  assert.equal(dry.changes[0]?.key, 'context_servers.ano');
  assert.equal(dry.changes[0]?.path, settingsPath);
  assert.ok(dry.warnings.some((line) => line.includes('unverified')));
  assert.ok(dry.warnings.some((line) => line.includes('not measured')));
  assert.deepEqual(readFileSync(settingsPath), before);

  const applied = await zedAdapter.config(configInput({
    mode: 'apply',
    root,
    env,
    target: { scope: 'user' },
    authorization: authorization(root, 'zed', true),
  }));
  assert.equal(applied.mode, 'apply');
  const document = readJson(settingsPath);
  assert.equal(document['theme'], 'andromeda');
  const servers = document['context_servers'] as Record<string, unknown>;
  assert.deepEqual(servers['other'], { command: 'other' });
  assert.equal(typeof servers['ano'], 'object');
});

test('jetbrains-ai is IDE-plugin-only: detect/config unavailable and never validated', async (t) => {
  const root = rootFor(t);
  const home = join(root, 'home');
  mkdirSync(home);
  const env = { HOME: home, PATH: join(root, 'missing-bin') };

  const detect = await jetbrainsAiAdapter.detect({ env, cwd: root });
  assert.equal(detect.detected, false);
  assert.deepEqual(detect.sources, []);
  assert.equal(detect.errors[0]?.code, 'E1_NO_DECLARED_SOURCE');

  const report = await jetbrainsAiAdapter.inspect({ root, env, cwd: root });
  assertNineLayers(report);
  assert.equal(report.status, 'unavailable');
  assert.equal(report.coreVerdict, 'unavailable');
  for (const layer of CAPABILITY_LAYERS) {
    assert.notEqual(report.layers[layer].verdict, 'validated', `${layer} must never be validated`);
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
  assert.ok(report.limitations.some((line) => line.includes('IDE-plugin-only')));
  assert.ok(report.limitations.some((line) => line.includes('completion') && line.includes('not ANO agent takeover')));

  const dry = await jetbrainsAiAdapter.config(configInput({ mode: 'dry-run', root, env }));
  assert.equal(dry.mode, 'dry-run');
  assert.deepEqual(dry.changes, []);
  assert.equal(dry.backupPlan, null);
  assert.ok(dry.warnings.some((line) => line.includes('zero write')));

  const apply = await jetbrainsAiAdapter.config(configInput({
    mode: 'apply',
    root,
    env,
    authorization: authorization(root, 'jetbrains-ai', true),
  }));
  assert.equal(apply.mode, 'dry-run', 'IDE-plugin-only apply must stay dry-run');
  assert.deepEqual(apply.changes, []);
  assert.ok(apply.warnings.some((line) => line.includes('zero write')));
  assert.equal(existsSync(join(root, '.ano')), false);
  assert.deepEqual(readdirSync(root).sort(), ['home']);

  const verify = await jetbrainsAiAdapter.verify({ transport: 'stdio' });
  assert.equal(verify.verdicts.mcp, 'unavailable');
  assert.equal(verify.errors[0]?.code, 'E3_NO_COMMAND');
});

test('tabnine is IDE-plugin + cloud only: detect/config unavailable and completion not takeover', async (t) => {
  const root = rootFor(t);
  const home = join(root, 'home');
  mkdirSync(home);
  const env = { HOME: home, PATH: join(root, 'missing-bin') };

  const detect = await tabnineAdapter.detect({ env, cwd: root });
  assert.equal(detect.detected, false);
  assert.equal(detect.errors[0]?.code, 'E1_NO_DECLARED_SOURCE');

  const report = await tabnineAdapter.inspect({ root, env, cwd: root });
  assertNineLayers(report);
  assert.equal(report.status, 'unavailable');
  assert.equal(report.coreVerdict, 'unavailable');
  for (const layer of CAPABILITY_LAYERS) {
    assert.notEqual(report.layers[layer].verdict, 'validated', `${layer} must never be validated`);
  }
  assert.equal(report.layers.mcp.verdict, 'unavailable');
  assert.equal(report.layers.configured.verdict, 'unavailable');
  assert.equal(report.layers.orchestration.verdict, 'degraded');
  assert.equal(report.layers.orchestration.details.mode, 'explicit-workflow');
  assert.ok(report.limitations.some((line) => line.includes('cloud-agent capability is not ANO agent takeover')));

  const apply = await tabnineAdapter.config(configInput({
    mode: 'apply',
    root,
    env,
    authorization: authorization(root, 'tabnine', true),
  }));
  assert.equal(apply.mode, 'dry-run');
  assert.deepEqual(apply.changes, []);
  assert.ok(apply.warnings.some((line) => line.includes('zero write')));
  assert.equal(existsSync(join(root, '.ano')), false);
});

test('all four adapters leave an empty root untouched and never create backup state', async (t) => {
  for (const adapter of [githubCopilotAdapter, zedAdapter, jetbrainsAiAdapter, tabnineAdapter]) {
    const root = rootFor(t, `ano-ide-empty-${adapter.id}-`);
    const home = join(root, 'home');
    mkdirSync(home);
    const env = { HOME: home, PATH: join(root, 'missing-bin') };
    await adapter.detect({ env, cwd: root });
    await adapter.inspect({ root, env, cwd: root });
    await adapter.config(configInput({ mode: 'dry-run', root, env }));
    assert.deepEqual(readdirSync(root).sort(), ['home'], `${adapter.id} must not create files`);
    assert.deepEqual(readdirSync(home), [], `${adapter.id} must not write into home`);
    assert.equal(existsSync(join(root, '.ano')), false);
  }
});
