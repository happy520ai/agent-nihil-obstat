/**
 * T-153 / QF-04 shard C: Antigravity, CodeBuddy, OpenClaw and Zed adapters.
 *
 * Real tmpdir homes/projects plus real config documents exercise remote-entry
 * detection (`url`/`serverUrl`/`cmd`), malformed containers, managed rule
 * sections, unresolved/rootless targets and the shared dry-run/apply refusal
 * ladder. Zed's non-Windows settings-path branches are environment-bound and
 * are asserted as such instead of being faked.
 */

import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  ANTIGRAVITY_USER_CONFIG,
  ANTIGRAVITY_WORKSPACE_CONFIG,
  antigravityAdapter,
} from '../../src/clients/antigravity.ts';
import {
  CODEBUDDY_PROJECT_CONFIG,
  CODEBUDDY_USER_CONFIG_PRIMARY,
  codebuddyAdapter,
} from '../../src/clients/codebuddy.ts';
import {
  OPENCLAW_USER_CONFIG,
  createOpenClawAdapter,
} from '../../src/clients/openclaw.ts';
import {
  ZED_PROJECT_SETTINGS,
  zedAdapter,
  zedUserSettingsPath,
} from '../../src/clients/zed.ts';
import { MCP_TOOL_NAMES, type McpClientLike } from '../../src/clients/types.ts';
import { MANAGED_INSTRUCTIONS_BEGIN, MANAGED_INSTRUCTIONS_END } from '../../src/connect/managed-instructions.ts';
import {
  m18cAuthz,
  m18cConfig,
  m18cHomeEnv,
  m18cTmp,
  m18cWriteJson,
  m18cWriteText,
  m18cWarnings,
} from '../helpers/m18-c-fixtures.ts';

interface CustomFixture {
  root: string;
  home: string;
  bin: string;
}

function fixture(t: Parameters<typeof m18cTmp>[0], prefix: string, executables: readonly string[] = []): CustomFixture {
  const root = m18cTmp(t, prefix);
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  for (const name of executables) {
    m18cWriteText(join(bin, process.platform === 'win32' ? `${name}.cmd` : name), '');
  }
  return { root, home, bin };
}

function injectedClient(): McpClientLike {
  return {
    initialize: async () => ({ protocolVersion: '2025-06-18', serverInfo: { name: 'ano', version: '1.0.0' } }),
    listTools: async () => ({ tools: MCP_TOOL_NAMES.map((name) => ({ name, inputSchema: { type: 'object' } })) }),
    callTool: async () => ({ content: [{ type: 'text', text: JSON.stringify({ phase: 'P7', project_scope: 'local' }) }] }),
    close: async () => {},
  };
}

test('antigravity: config discovery keeps absent, malformed, container-less and remote entries distinct', async (t) => {
  const { root, home, bin } = fixture(t, 'ano-m18-c-antigravity-', ['agy']);
  const env = { ...m18cHomeEnv(home), PATH: bin };
  const userConfig = join(home, ANTIGRAVITY_USER_CONFIG);

  const absent = await antigravityAdapter.inspect({ root, cwd: root, env });
  assert.equal(absent.layers.configured.details.exists, false);
  assert.ok(absent.layers.configured.limitations.some((line) => line.includes('installed but no ano MCP entry')));

  m18cWriteText(userConfig, '{ not json');
  const malformed = await antigravityAdapter.inspect({ root, cwd: root, env });
  assert.ok(malformed.errors.some((error) => error.code === 'E2_PARSE_FAILED'));

  m18cWriteJson(userConfig, {});
  const noContainer = await antigravityAdapter.inspect({ root, cwd: root, env });
  assert.ok(noContainer.layers.configured.limitations.some((line) => line.includes('container was not found')));

  m18cWriteJson(userConfig, { mcpServers: { ano: { url: 'https://remote.test' } } });
  const urlEntry = await antigravityAdapter.inspect({ root, cwd: root, env });
  assert.equal(urlEntry.layers.configured.details.exists, true);

  m18cWriteJson(userConfig, { mcpServers: { ano: { serverUrl: 'https://remote.test' } } });
  const serverUrlEntry = await antigravityAdapter.inspect({ root, cwd: root, env });
  assert.equal(serverUrlEntry.layers.configured.details.exists, true);

  m18cWriteJson(userConfig, { mcpServers: { ano: { cmd: 'definitely-missing-agy-command' } } });
  const cmdEntry = await antigravityAdapter.inspect({ root, cwd: root, env });
  assert.ok(cmdEntry.layers.configured.limitations.some((line) => line.includes('not reachable')));
});

test('antigravity: config refuses unresolved/rootless targets, warns on workspace/TOML, and applies once', async (t) => {
  const { root, home } = fixture(t, 'ano-m18-c-antigravity-config-');
  const env = m18cHomeEnv(home);

  const rootless = await antigravityAdapter.config(m18cConfig({ target: { scope: 'project' }, mode: 'dry-run', env }));
  assert.ok(m18cWarnings(rootless).some((line) => line.includes('config target unresolved')));

  const invalidEnv = await antigravityAdapter.config(
    m18cConfig({ target: { scope: 'user' }, mode: 'dry-run', env: 'not-an-env-record' }),
  );
  assert.equal(invalidEnv.mode, 'dry-run');

  const workspace = await antigravityAdapter.config(
    m18cConfig({ target: { scope: 'workspace' }, mode: 'dry-run', root, env }),
  );
  assert.ok(m18cWarnings(workspace).some((line) => line.includes('workspace .agents/mcp_config.json')));

  const toml = await antigravityAdapter.config(
    m18cConfig({ target: { scope: 'user', format: 'toml' }, mode: 'dry-run', root, env }),
  );
  assert.ok(m18cWarnings(toml).some((line) => line.toLowerCase().includes('toml')));

  const projectConfig = join(root, ANTIGRAVITY_WORKSPACE_CONFIG);
  mkdirSync(resolve(projectConfig, '..'), { recursive: true });
  m18cWriteJson(projectConfig, {});
  const base = { target: { scope: 'project' as const }, mode: 'apply' as const, root, env };

  const missing = await antigravityAdapter.config(m18cConfig(base));
  assert.equal(missing.mode, 'dry-run');
  assert.ok(m18cWarnings(missing).some((line) => line.includes('missing authorization credential')));

  const blank = await antigravityAdapter.config(
    m18cConfig({ ...base, authorization: m18cAuthz(root, 'antigravity', { statement: '  ' }) }),
  );
  assert.ok(m18cWarnings(blank).some((line) => line.includes('auditable statement')));

  m18cWriteJson(join(home, ANTIGRAVITY_USER_CONFIG), {});
  const noRoot = await antigravityAdapter.config(
    m18cConfig({
      target: { scope: 'user' },
      mode: 'apply',
      env,
      authorization: m18cAuthz(root, 'antigravity', { statement: 'Authorize ANO antigravity configuration' }),
    }),
  );
  assert.ok(m18cWarnings(noRoot).some((line) => line.includes('project root is required')));

  const grant = m18cAuthz(root, 'antigravity', { statement: 'Authorize ANO antigravity configuration' });
  const applied = await antigravityAdapter.config(m18cConfig({ ...base, authorization: grant }));
  assert.equal(applied.mode, 'apply');

  const replay = await antigravityAdapter.config(m18cConfig({ ...base, authorization: grant }));
  assert.equal(replay.mode, 'dry-run');
  assert.ok(m18cWarnings(replay).some((line) => line.includes('already matches')));

  m18cWriteJson(projectConfig, {});
  const backupBlocker = join(root, '.ano', 'clients', 'backups', 'antigravity');
  rmSync(backupBlocker, { recursive: true, force: true });
  m18cWriteText(backupBlocker, 'not a directory');
  const failed = await antigravityAdapter.config(m18cConfig({ ...base, authorization: grant }));
  assert.ok(m18cWarnings(failed).some((line) => line.includes('apply failed')));
});

test('codebuddy: managed rule files and config entry shapes stay evidence-bound', async (t) => {
  const { root, home, bin } = fixture(t, 'ano-m18-c-codebuddy-', ['codebuddy']);
  const env = { ...m18cHomeEnv(home), PATH: bin };

  m18cWriteText(join(root, 'CODEBUDDY.md'), `${MANAGED_INSTRUCTIONS_BEGIN}\nschema: x\n${MANAGED_INSTRUCTIONS_END}\n`);
  m18cWriteText(join(root, 'rules', 'extra.md'), 'plain rule\n');
  const rules = await codebuddyAdapter.inspect({ root, cwd: root, env });
  assert.equal(rules.layers.instructions.details.hasManagedSection, true);
  assert.ok(
    rules.layers.instructions.details.rulePaths.some((path) => path.endsWith('CODEBUDDY.md')),
    'CODEBUDDY.md must be a rule path',
  );
  assert.ok(
    rules.layers.instructions.details.rulePaths.some((path) => path.includes('rules')),
    'the rules directory must contribute rule paths',
  );

  const userConfig = join(home, CODEBUDDY_USER_CONFIG_PRIMARY);
  m18cWriteText(userConfig, '{ broken');
  const malformed = await codebuddyAdapter.inspect({ root, cwd: root, env });
  assert.ok(malformed.errors.some((error) => error.code === 'E2_PARSE_FAILED'));

  m18cWriteJson(userConfig, { mcpServers: { ano: { url: 'https://remote.test' } } });
  const remote = await codebuddyAdapter.inspect({ root, cwd: root, env });
  assert.equal(remote.layers.configured.details.exists, true);

  m18cWriteJson(userConfig, { mcpServers: { ano: { cmd: 'definitely-missing-cbc-command' } } });
  const cmd = await codebuddyAdapter.inspect({ root, cwd: root, env });
  assert.ok(cmd.layers.configured.limitations.some((line) => line.includes('not reachable')));
});

test('codebuddy: config refusals and one-shot apply on the project .mcp.json', async (t) => {
  const { root, home } = fixture(t, 'ano-m18-c-codebuddy-config-');
  const env = m18cHomeEnv(home);

  const rootless = await codebuddyAdapter.config(m18cConfig({ target: { scope: 'project' }, mode: 'dry-run', env }));
  assert.ok(m18cWarnings(rootless).some((line) => line.includes('config target unresolved')));

  const invalidEnv = await codebuddyAdapter.config(
    m18cConfig({ target: { scope: 'user' }, mode: 'dry-run', env: 'not-an-env-record' }),
  );
  assert.equal(invalidEnv.mode, 'dry-run');

  const workspace = await codebuddyAdapter.config(
    m18cConfig({ target: { scope: 'workspace' }, mode: 'dry-run', root, env }),
  );
  assert.ok(m18cWarnings(workspace).some((line) => line.includes('workspace scope maps to that file')));

  const toml = await codebuddyAdapter.config(
    m18cConfig({ target: { scope: 'user', format: 'toml' }, mode: 'dry-run', root, env }),
  );
  assert.ok(m18cWarnings(toml).some((line) => line.toLowerCase().includes('toml')));

  const projectConfig = join(root, CODEBUDDY_PROJECT_CONFIG);
  m18cWriteJson(projectConfig, {});
  const base = { target: { scope: 'project' as const }, mode: 'apply' as const, root, env };

  const blank = await codebuddyAdapter.config(
    m18cConfig({ ...base, authorization: m18cAuthz(root, 'codebuddy', { statement: '\t' }) }),
  );
  assert.equal(blank.mode, 'dry-run');
  assert.ok(m18cWarnings(blank).some((line) => line.includes('auditable statement')));

  m18cWriteJson(join(home, CODEBUDDY_USER_CONFIG_PRIMARY), {});
  const noRoot = await codebuddyAdapter.config(
    m18cConfig({
      target: { scope: 'user' },
      mode: 'apply',
      env,
      authorization: m18cAuthz(root, 'codebuddy', { statement: 'Authorize ANO codebuddy configuration' }),
    }),
  );
  assert.ok(m18cWarnings(noRoot).some((line) => line.includes('project root is required')));

  const grant = m18cAuthz(root, 'codebuddy', { statement: 'Authorize ANO codebuddy configuration' });
  const applied = await codebuddyAdapter.config(m18cConfig({ ...base, authorization: grant }));
  assert.equal(applied.mode, 'apply');

  const replay = await codebuddyAdapter.config(m18cConfig({ ...base, authorization: grant }));
  assert.equal(replay.mode, 'dry-run');
  assert.ok(m18cWarnings(replay).some((line) => line.includes('already matches')));

  m18cWriteJson(projectConfig, {});
  const backupBlocker = join(root, '.ano', 'clients', 'backups', 'codebuddy');
  rmSync(backupBlocker, { recursive: true, force: true });
  m18cWriteText(backupBlocker, 'not a directory');
  const failed = await codebuddyAdapter.config(m18cConfig({ ...base, authorization: grant }));
  assert.ok(m18cWarnings(failed).some((line) => line.includes('apply failed')));
});

test('openclaw: aborted detection, absent/malformed configs and remote entry handling', async (t) => {
  const { root, home, bin } = fixture(t, 'ano-m18-c-openclaw-', ['openclaw']);
  const adapter = createOpenClawAdapter({ home, root });
  const env = { ...m18cHomeEnv(home), PATH: bin };

  const controller = new AbortController();
  controller.abort();
  const aborted = await adapter.detect({ cwd: root, signal: controller.signal });
  assert.equal(aborted.errors[0]?.code, 'E1_ABORTED');

  const absent = await adapter.inspect({ root, env });
  assert.ok(absent.layers.configured.limitations.some((line) => line.includes('no declared OpenClaw config candidate')));

  const userConfig = join(home, OPENCLAW_USER_CONFIG);
  m18cWriteText(userConfig, '{ broken');
  const malformed = await adapter.inspect({ root, env });
  assert.ok(malformed.errors.some((error) => error.code === 'E2_PARSE_FAILED'));

  m18cWriteJson(userConfig, {});
  const noContainer = await adapter.inspect({ root, env });
  assert.ok(noContainer.layers.configured.limitations.some((line) => line.includes('mcp.servers container was not found')));

  m18cWriteJson(userConfig, { mcp: { servers: {} } });
  const noAno = await adapter.inspect({ root, env });
  assert.ok(noAno.layers.configured.limitations.some((line) => line.includes('no ano entry')));

  m18cWriteJson(userConfig, { mcp: { servers: { ano: { url: 'https://remote.test' } } } });
  const remote = await adapter.inspect({ root, env });
  assert.equal(remote.layers.configured.details.exists, true);

  m18cWriteJson(userConfig, { mcp: { servers: { ano: { command: 'openclaw' } } } });
  const local = await adapter.inspect({ root, env });
  assert.equal(local.layers.configured.details.exists, true);
});

test('openclaw: config scope/format warnings and apply refusal ladder', async (t) => {
  const { root, home } = fixture(t, 'ano-m18-c-openclaw-config-');
  const adapter = createOpenClawAdapter({ home, root });
  const env = m18cHomeEnv(home);

  const wrongFormat = await adapter.config(
    m18cConfig({ target: { scope: 'user', format: 'toml' }, mode: 'dry-run', root, env }),
  );
  assert.ok(m18cWarnings(wrongFormat).some((line) => line.toLowerCase().includes('json')));

  const projectScope = await adapter.config(
    m18cConfig({ target: { scope: 'project' }, mode: 'dry-run', root, env }),
  );
  assert.ok(m18cWarnings(projectScope).some((line) => line.includes('user-level config file')));

  const userConfig = join(home, OPENCLAW_USER_CONFIG);
  m18cWriteJson(userConfig, {});

  const rootless = await adapter.config(
    m18cConfig({ target: { scope: 'user' }, mode: 'apply', env }),
  );
  assert.equal(rootless.mode, 'dry-run');
  assert.ok(m18cWarnings(rootless).some((line) => line.includes('project root is required')));

  const base = { target: { scope: 'user' as const }, mode: 'apply' as const, root, env };
  const missing = await adapter.config(m18cConfig(base));
  assert.equal(missing.mode, 'dry-run');
  assert.ok(m18cWarnings(missing).some((line) => line.includes('missing authorization credential')));

  const blank = await adapter.config(
    m18cConfig({ ...base, authorization: m18cAuthz(root, 'openclaw', { statement: '  ' }) }),
  );
  assert.equal(blank.mode, 'dry-run');
  assert.ok(m18cWarnings(blank).some((line) => line.includes('auditable statement')));

  const grant = m18cAuthz(root, 'openclaw', { statement: 'Authorize ANO openclaw configuration' });
  const applied = await adapter.config(m18cConfig({ ...base, authorization: grant }));
  assert.equal(applied.mode, 'apply');

  const replay = await adapter.config(m18cConfig({ ...base, authorization: grant }));
  assert.equal(replay.mode, 'dry-run');
  assert.ok(m18cWarnings(replay).some((line) => line.includes('already matches')));

  m18cWriteJson(userConfig, {});
  const backupBlocker = join(root, '.ano', 'clients', 'backups', 'openclaw');
  rmSync(backupBlocker, { recursive: true, force: true });
  m18cWriteText(backupBlocker, 'not a directory');
  const failed = await adapter.config(m18cConfig({ ...base, authorization: grant }));
  assert.ok(m18cWarnings(failed).some((line) => line.includes('apply failed')));
});

test('zed: settings parsing edges, platform path boundary, config apply and verify', async (t) => {
  const { root, home } = fixture(t, 'ano-m18-c-zed-');
  const env = m18cHomeEnv(home);
  const userSettings = zedUserSettingsPath(home);

  m18cWriteText(userSettings, '{ broken');
  const malformed = await zedAdapter.inspect({ root, cwd: root, env });
  assert.ok(malformed.errors.some((error) => error.code === 'E2_PARSE_FAILED'));

  m18cWriteJson(userSettings, {});
  const noContainer = await zedAdapter.inspect({ root, cwd: root, env });
  assert.ok(noContainer.layers.configured.limitations.some((line) => line.includes('context_servers container was not found')));

  m18cWriteJson(userSettings, { context_servers: {} });
  const noAno = await zedAdapter.inspect({ root, cwd: root, env });
  assert.ok(noAno.layers.configured.limitations.some((line) => line.includes('no ano entry')));

  m18cWriteJson(userSettings, { context_servers: { ano: { url: 'https://remote.test' } } });
  const remote = await zedAdapter.inspect({ root, cwd: root, env });
  assert.equal(remote.layers.configured.details.exists, true);

  // Only the host platform branch can execute here; the other two are
  // environment boundaries, not fabricated inputs.
  assert.equal(typeof zedUserSettingsPath(home), 'string');

  const projectConfig = join(root, ZED_PROJECT_SETTINGS);
  m18cWriteJson(projectConfig, {});
  const base = { target: { scope: 'project' as const }, mode: 'apply' as const, root, env };

  const unresolved = await zedAdapter.config(m18cConfig({ target: { scope: 'project' }, mode: 'dry-run', env }));
  assert.ok(m18cWarnings(unresolved).some((line) => line.includes('config target unresolved')));

  const invalidEnv = await zedAdapter.config(
    m18cConfig({ target: { scope: 'user' }, mode: 'dry-run', env: 'not-an-env-record' }),
  );
  assert.equal(invalidEnv.mode, 'dry-run');

  const noRootUser = await zedAdapter.config(
    m18cConfig({
      target: { scope: 'user' },
      mode: 'apply',
      env,
      authorization: m18cAuthz(root, 'zed', { statement: 'Authorize ANO zed configuration' }),
    }),
  );
  assert.ok(m18cWarnings(noRootUser).some((line) => line.includes('project root is required')));

  const workspace = await zedAdapter.config(
    m18cConfig({ target: { scope: 'workspace' }, mode: 'dry-run', root, env }),
  );
  assert.ok(m18cWarnings(workspace).some((line) => line.includes('workspace scope maps to the project')));

  const toml = await zedAdapter.config(
    m18cConfig({ target: { scope: 'user', format: 'toml' }, mode: 'dry-run', root, env }),
  );
  assert.ok(m18cWarnings(toml).some((line) => line.toLowerCase().includes('toml')));

  const missing = await zedAdapter.config(m18cConfig(base));
  assert.equal(missing.mode, 'dry-run');
  assert.ok(m18cWarnings(missing).some((line) => line.includes('missing authorization credential')));

  const blank = await zedAdapter.config(
    m18cConfig({ ...base, authorization: m18cAuthz(root, 'zed', { statement: '' }) }),
  );
  assert.equal(blank.mode, 'dry-run');
  assert.ok(m18cWarnings(blank).some((line) => line.includes('auditable statement')));

  const grant = m18cAuthz(root, 'zed', { statement: 'Authorize ANO zed configuration' });
  const applied = await zedAdapter.config(m18cConfig({ ...base, authorization: grant }));
  assert.equal(applied.mode, 'apply');

  const replay = await zedAdapter.config(m18cConfig({ ...base, authorization: grant }));
  assert.equal(replay.mode, 'dry-run');
  assert.ok(m18cWarnings(replay).some((line) => line.includes('already matches')));

  m18cWriteJson(projectConfig, {});
  const backupBlocker = join(root, '.ano', 'clients', 'backups', 'zed');
  rmSync(backupBlocker, { recursive: true, force: true });
  m18cWriteText(backupBlocker, 'not a directory');
  const failed = await zedAdapter.config(m18cConfig({ ...base, authorization: grant }));
  assert.ok(m18cWarnings(failed).some((line) => line.includes('apply failed')));

  const verified = await zedAdapter.verify({ transport: 'stdio', inject: injectedClient(), root });
  assert.equal(verified.verdicts.mcp, 'validated');
});

test('antigravity/codebuddy/zed: inspect with no injected home/root resolves zero declared candidates', async (t) => {
  m18cTmp(t, 'ano-m18-c-no-candidates-');
  const antigravity = await antigravityAdapter.inspect({ env: {} });
  assert.equal(antigravity.layers.configured.verdict, 'unavailable');

  const codebuddy = await codebuddyAdapter.inspect({ env: {} });
  assert.equal(codebuddy.layers.configured.verdict, 'unavailable');

  const zed = await zedAdapter.inspect({ env: {} });
  assert.equal(zed.layers.configured.verdict, 'unavailable');
});
