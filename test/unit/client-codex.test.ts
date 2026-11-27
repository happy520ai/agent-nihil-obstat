import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  CODEX_IDENTITY_SOURCES,
  CODEX_SERVER_NAME,
  CODEX_SERVER_PATH,
  codexConfigTarget,
  createCodexAdapter,
} from '../../src/clients/codex.ts';
import { defaultRegistry } from '../../src/clients/registry.ts';
import { CLIENT_REPORT_SCHEMA, MCP_TOOL_NAMES, type ClientAdapter, type McpClientLike } from '../../src/clients/types.ts';
import {
  MANAGED_INSTRUCTIONS_BEGIN,
  MANAGED_INSTRUCTIONS_END,
  MANAGED_INSTRUCTIONS_SCHEMA,
} from '../../src/connect/managed-instructions.ts';

const AT = '2026-11-22T00:00:00.000Z';

function tmp(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'ano-client-codex-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function fixture(t: TestContext): { root: string; home: string; bin: string; adapter: ClientAdapter } {
  const root = tmp(t);
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const adapter = createCodexAdapter({ home, root, probePaths: [bin], env: {}, now: () => AT });
  return { root, home, bin, adapter };
}

function installExecutable(bin: string, name: string): void {
  writeFileSync(join(bin, name), '#!/usr/bin/env node\nprocess.exit(0);\n');
}

function managedAgentsMd(): string {
  return [
    '# Agent rules',
    '',
    MANAGED_INSTRUCTIONS_BEGIN,
    `schema: ${MANAGED_INSTRUCTIONS_SCHEMA}`,
    '- 本段由 ANO 强制接管流程维护。',
    MANAGED_INSTRUCTIONS_END,
    '',
  ].join('\n');
}

function authorizationFor(root: string): {
  authorizationId: string;
  root: string;
  clientId: 'codex';
  scope: string[];
  grantedBy: string;
  grantedAt: string;
  revokedAt: null;
  statement: string;
} {
  return {
    authorizationId: 'c'.repeat(64),
    root,
    clientId: 'codex',
    scope: ['config', 'install'],
    grantedBy: 'Alice',
    grantedAt: AT,
    revokedAt: null,
    statement: 'Authorize ANO client configuration for this project',
  };
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
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ phase: 'P7', project_scope: 'local', hostCapability: 'degraded' }),
          },
        ],
      };
    },
    close: async () => {},
  };
}

test('codex adapter declares registered identity sources and the public server mapping', () => {
  const adapter = createCodexAdapter();
  assert.equal(adapter.id, 'codex');
  assert.deepEqual(adapter.identitySources, defaultRegistry.get('codex').identitySources);
  assert.deepEqual([...CODEX_SERVER_PATH], ['mcp_servers']);
  assert.equal(CODEX_SERVER_NAME, 'ano');
  assert.equal(CODEX_IDENTITY_SOURCES.length, 3);
});

test('detect separates installed from absent and stays read-only', async (t) => {
  const { root, home, bin, adapter } = fixture(t);
  const before = readdirSync(root).sort();

  const absent = await adapter.detect({ env: {}, probePaths: [bin] });
  assert.equal(absent.clientId, 'codex');
  assert.equal(absent.detected, false);
  assert.equal(absent.executablePath, null);
  assert.deepEqual(absent.sources, []);
  assert.deepEqual(absent.errors, []);

  installExecutable(bin, 'codex');
  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(join(root, 'AGENTS.md'), '# rules\n');

  const installed = await adapter.detect({ env: {}, cwd: root, probePaths: [bin] });
  assert.equal(installed.detected, true);
  assert.equal(installed.executablePath, join(bin, 'codex'));
  assert.ok(installed.sources.some((source) => source.kind === 'executable' && source.source === 'executable:codex'));
  assert.ok(installed.sources.some((source) => source.kind === 'config-path' && source.source.includes('.codex')));
  assert.ok(installed.sources.some((source) => source.kind === 'config-path' && source.source.endsWith('AGENTS.md')));
  assert.deepEqual(installed.errors, []);

  assert.deepEqual(
    readdirSync(root).sort(),
    [...before, 'AGENTS.md'].sort(),
    'detect must not create anything beyond the pre-existing fixture files',
  );
});

test('inspect reports an absent environment as unavailable and explicitly unverified', async (t) => {
  const { root, adapter } = fixture(t);
  const report = await adapter.inspect({ root, env: {} });
  assert.equal(report.schema, CLIENT_REPORT_SCHEMA);
  assert.equal(report.clientId, 'codex');
  assert.equal(report.alias, null);
  assert.equal(report.status, 'unavailable');
  assert.equal(report.coreVerdict, 'unavailable');
  for (const layer of Object.values(report.layers)) {
    assert.equal(layer.verdict, 'unavailable', `${layer.layer} must stay unavailable`);
    assert.equal(layer.evidence, 'absent');
  }
  assert.ok(report.limitations.some((line) => /unverified|not measured/i.test(line)));
});

test('inspect resolves [mcp_servers.ano], detects the managed AGENTS.md section, and never validates', async (t) => {
  const { root, home, bin, adapter } = fixture(t);
  installExecutable(bin, 'codex');
  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(
    join(home, '.codex', 'config.toml'),
    [
      'model = "gpt-5"',
      '',
      '[mcp_servers.ano]',
      `command = ${JSON.stringify(process.execPath)}`,
      'args = ["dist/surface/mcp.js"]',
      '',
      '[mcp_servers.other]',
      'command = "other-bin"',
      'args = ["--serve"]',
      '',
    ].join('\n'),
  );
  writeFileSync(join(root, 'AGENTS.md'), managedAgentsMd());

  const report = await adapter.inspect({ root, env: {} });
  assert.equal(report.status, 'degraded');
  assert.equal(report.coreVerdict, 'unavailable', 'inspect performs no handshake, so the core chain cannot validate');

  assert.equal(report.layers.detected.verdict, 'validated');
  assert.equal(report.layers.detected.details.executablePath, join(bin, 'codex'));

  const configured = report.layers.configured;
  assert.equal(configured.verdict, 'degraded', 'configured but unmeasured is degraded');
  assert.equal(configured.evidence, 'configured');
  assert.equal(configured.details.exists, true);
  assert.equal(configured.details.configPath, resolve(join(home, '.codex', 'config.toml')));
  assert.equal(configured.details.scope, 'user');
  assert.equal(configured.details.key, 'mcp_servers.ano');
  assert.equal(configured.version, 'config-format:toml');
  assert.ok(configured.limitations.some((line) => line.includes('read-only')));
  assert.ok(configured.limitations.some((line) => line.includes('not measured')));

  const instructions = report.layers.instructions;
  assert.equal(instructions.verdict, 'degraded');
  assert.equal(instructions.evidence, 'measured');
  assert.equal(instructions.details.rulePaths[0], join(root, 'AGENTS.md'));
  assert.equal(instructions.details.hasManagedSection, true);
  assert.equal(instructions.details.formatVersion, MANAGED_INSTRUCTIONS_SCHEMA);
  assert.equal(instructions.details.readOnly, true);
});

test('inspect detects AGENTS.md without a managed section and degrades instead of guessing', async (t) => {
  const { root, bin, adapter } = fixture(t);
  installExecutable(bin, 'codex');
  writeFileSync(join(root, 'AGENTS.md'), '# Plain rules\n');

  const report = await adapter.inspect({ root, env: {} });
  const instructions = report.layers.instructions;
  assert.equal(instructions.verdict, 'degraded');
  assert.equal(instructions.details.hasManagedSection, false);
  assert.equal(instructions.details.formatVersion, null);
  assert.equal(instructions.details.readOnly, true);
  assert.ok(instructions.limitations.some((line) => line.includes('no ANO managed marker pair')));
});

test('inspect refuses to validate unknown TOML fields or malformed TOML', async (t) => {
  const { root, home, bin, adapter } = fixture(t);
  installExecutable(bin, 'codex');
  mkdirSync(join(home, '.codex'), { recursive: true });
  const configPath = join(home, '.codex', 'config.toml');

  writeFileSync(
    configPath,
    [`[mcp_servers.ano]`, `command = ${JSON.stringify(process.execPath)}`, 'mystery = true', ''].join('\n'),
  );
  const unknown = await adapter.inspect({ root, env: {} });
  assert.equal(unknown.layers.configured.verdict, 'degraded');
  assert.notEqual(unknown.layers.configured.verdict, 'validated');
  assert.ok(unknown.layers.configured.limitations.some((line) => line.includes('unknown fields')));

  writeFileSync(configPath, '[mcp_servers.ano]\ncommand = \n');
  const broken = await adapter.inspect({ root, env: {} });
  assert.equal(broken.layers.configured.verdict, 'degraded');
  assert.ok(broken.layers.configured.errors.some((error) => error.code === 'E2_PARSE_FAILED'));
  assert.notEqual(broken.layers.configured.verdict, 'validated');
});

test('config dry-run maps [mcp_servers.ano] and writes nothing', async (t) => {
  const { root, home, adapter } = fixture(t);
  const configPath = join(home, '.codex', 'config.toml');
  mkdirSync(join(home, '.codex'), { recursive: true });
  const original = ['[mcp_servers.other]', 'command = "other-bin"', ''].join('\n');
  writeFileSync(configPath, original);

  const result = await adapter.config({ target: { scope: 'user' }, mode: 'dry-run', root });
  assert.equal(result.mode, 'dry-run');
  assert.equal(result.backupPlan, null);
  assert.equal(result.changes.length, 1);
  const change = result.changes[0]!;
  assert.equal(change.path, resolve(configPath));
  assert.equal(change.scope, 'user');
  assert.equal(change.key, 'mcp_servers.ano');
  assert.equal(change.operation, 'add');
  assert.equal(change.before, null);
  const after = change.after as { command: string; args: string[] };
  assert.equal(after.command, process.execPath);
  assert.deepEqual(after.args, [join(root, 'dist', 'surface', 'mcp.js')]);
  assert.equal(readFileSync(configPath, 'utf8'), original, 'dry-run must be zero-write');
});

test('config apply is refused for TOML and never writes, even with authorization', async (t) => {
  const { root, home, adapter } = fixture(t);
  const configPath = join(home, '.codex', 'config.toml');
  mkdirSync(join(home, '.codex'), { recursive: true });
  const original = ['[mcp_servers.other]', 'command = "other-bin"', ''].join('\n');
  writeFileSync(configPath, original);

  const grant = authorizationFor(root);
  const result = await adapter.config({ target: { scope: 'user' }, mode: 'apply', authorization: grant, root });
  assert.equal(result.mode, 'dry-run', 'TOML apply degrades to a dry-run report');
  assert.equal(result.changes.length, 1, 'the proposed change is still reported');
  assert.equal(readFileSync(configPath, 'utf8'), original, 'TOML apply must be zero-write');
  assert.ok(result.mode === 'dry-run' && result.warnings.some((line) => /read-only|refused/i.test(line)));
  assert.equal(existsSync(join(root, '.ano', 'clients', 'backups', 'codex')), false);
});

test('config refuses to guess a non-user path and refuses a non-toml format', async (t) => {
  const { root, adapter } = fixture(t);
  const project = await adapter.config({ target: { scope: 'project' }, mode: 'dry-run', root });
  assert.equal(project.mode, 'dry-run');
  assert.equal(project.changes.length, 0);
  assert.ok(project.mode === 'dry-run' && project.warnings.some((line) => line.includes('refusing to guess')));

  const wrongFormat = await adapter.config({ target: { scope: 'user', format: 'json' }, mode: 'dry-run', root });
  assert.equal(wrongFormat.changes.length, 0);
  assert.ok(wrongFormat.mode === 'dry-run' && wrongFormat.warnings.some((line) => line.includes('toml')));
});

test('codexConfigTarget exposes the declared mapping', () => {
  const home = resolve('/tmp/ano-codex-home');
  const root = resolve('/tmp/ano-codex-root');
  const target = codexConfigTarget('user', { home, root });
  assert.equal(target?.clientId, 'codex');
  assert.equal(target?.scope, 'user');
  assert.equal(target?.format, 'toml');
  assert.deepEqual(target?.serverPath, ['mcp_servers']);
  assert.equal(target?.serverName, 'ano');
  assert.equal(target?.allowedRoot, home);
  assert.equal(target?.path, resolve(join(home, '.codex', 'config.toml')));
  assert.equal(codexConfigTarget('project', { home, root }), null);
});

test('verify reuses the real stdio handshake and stops amplification on failure', async (t) => {
  const { adapter } = fixture(t);
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
});
