import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  CLAUDE_CODE_IDENTITY_SOURCES,
  CLAUDE_CODE_SERVER_NAME,
  CLAUDE_CODE_SERVER_PATH,
  claudeCodeConfigTarget,
  createClaudeCodeAdapter,
} from '../../src/clients/claude-code.ts';
import { defaultRegistry } from '../../src/clients/registry.ts';
import {
  CLIENT_IDS,
  CLIENT_REPORT_SCHEMA,
  MCP_TOOL_NAMES,
  type ClientAdapter,
  type McpClientLike,
} from '../../src/clients/types.ts';
import {
  MANAGED_INSTRUCTIONS_BEGIN,
  MANAGED_INSTRUCTIONS_END,
  MANAGED_INSTRUCTIONS_SCHEMA,
} from '../../src/connect/managed-instructions.ts';

const AT = '2026-11-22T00:00:00.000Z';

function tmp(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'ano-client-claude-code-'));
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
  const adapter = createClaudeCodeAdapter({ home, root, probePaths: [bin], env: {}, now: () => AT });
  return { root, home, bin, adapter };
}

function installExecutable(bin: string, name: string): void {
  writeFileSync(join(bin, name), '#!/usr/bin/env node\nprocess.exit(0);\n');
}

function managedClaudeMd(): string {
  return [
    '# Project rules',
    '',
    MANAGED_INSTRUCTIONS_BEGIN,
    `schema: ${MANAGED_INSTRUCTIONS_SCHEMA}`,
    '- 本段由 ANO 强制接管流程维护。',
    MANAGED_INSTRUCTIONS_END,
    '',
    'User content stays outside the managed span.',
    '',
  ].join('\n');
}

function authorizationFor(root: string): {
  authorizationId: string;
  root: string;
  clientId: 'claude-code';
  scope: string[];
  grantedBy: string;
  grantedAt: string;
  revokedAt: null;
  statement: string;
} {
  return {
    authorizationId: 'a'.repeat(64),
    root,
    clientId: 'claude-code',
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

test('claude-code adapter declares registered identity sources and the public server mapping', () => {
  const adapter = createClaudeCodeAdapter();
  assert.equal(adapter.id, 'claude-code');
  assert.deepEqual(adapter.identitySources, defaultRegistry.get('claude-code').identitySources);
  assert.deepEqual([...CLAUDE_CODE_SERVER_PATH], ['mcpServers']);
  assert.equal(CLAUDE_CODE_SERVER_NAME, 'ano');
  assert.equal(CLAUDE_CODE_IDENTITY_SOURCES.length, 3);
  assert.equal((CLIENT_IDS as readonly string[]).includes('cloudcode'), false, 'cloudcode is an alias, not a ClientId');
});

test('detect separates installed from absent and stays read-only', async (t) => {
  const { root, home, bin, adapter } = fixture(t);
  const before = readdirSync(root).sort();

  const absent = await adapter.detect({ env: {}, probePaths: [bin] });
  assert.equal(absent.clientId, 'claude-code');
  assert.equal(absent.detected, false);
  assert.equal(absent.executablePath, null);
  assert.deepEqual(absent.sources, []);
  assert.deepEqual(absent.errors, []);

  installExecutable(bin, 'claude');
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(root, 'CLAUDE.md'), '# rules\n');

  const installed = await adapter.detect({ env: {}, cwd: root, probePaths: [bin] });
  assert.equal(installed.detected, true);
  assert.equal(installed.executablePath, join(bin, 'claude'));
  assert.ok(installed.sources.some((source) => source.kind === 'executable' && source.source === 'executable:claude'));
  assert.ok(installed.sources.some((source) => source.kind === 'config-path' && source.source.includes('.claude')));
  assert.ok(installed.sources.some((source) => source.kind === 'config-path' && source.source.endsWith('CLAUDE.md')));
  assert.deepEqual(installed.errors, []);

  assert.deepEqual(
    readdirSync(root).sort(),
    [...before, 'CLAUDE.md'].sort(),
    'detect must not create anything beyond the pre-existing fixture files',
  );
});

test('inspect reports an absent environment as unavailable and explicitly unverified', async (t) => {
  const { root, adapter } = fixture(t);
  const report = await adapter.inspect({ root, env: {} });
  assert.equal(report.schema, CLIENT_REPORT_SCHEMA);
  assert.equal(report.clientId, 'claude-code');
  assert.equal(report.alias, 'cloudcode');
  assert.equal(report.status, 'unavailable');
  assert.equal(report.coreVerdict, 'unavailable');
  for (const layer of Object.values(report.layers)) {
    assert.equal(layer.verdict, 'unavailable', `${layer.layer} must stay unavailable`);
    assert.equal(layer.evidence, 'absent');
  }
  assert.equal(report.layers.configured.details.exists, false);
  assert.ok(
    report.limitations.some((line) => /unverified|not measured/i.test(line)),
    'the report must state that real layers were not measured',
  );
});

test('inspect resolves a real public mcpServers entry, detects the managed CLAUDE.md section, and never validates', async (t) => {
  const { root, home, bin, adapter } = fixture(t);
  installExecutable(bin, 'claude');
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(
    join(root, '.mcp.json'),
    `${JSON.stringify(
      {
        mcpServers: {
          ano: { command: process.execPath, args: ['dist/surface/mcp.js'] },
          otherService: { command: 'other-bin', args: ['--serve'] },
        },
        unknownTop: { keep: true },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(root, 'CLAUDE.md'), managedClaudeMd());

  const report = await adapter.inspect({ root, env: {} });
  assert.equal(report.status, 'degraded');
  assert.equal(report.coreVerdict, 'unavailable', 'inspect performs no handshake, so the core chain cannot validate');

  assert.equal(report.layers.detected.verdict, 'validated');
  assert.equal(report.layers.detected.details.executablePath, join(bin, 'claude'));

  const configured = report.layers.configured;
  assert.equal(configured.verdict, 'degraded', 'configured but unmeasured is degraded');
  assert.equal(configured.evidence, 'configured');
  assert.equal(configured.details.exists, true);
  assert.equal(configured.details.configPath, resolve(join(root, '.mcp.json')));
  assert.equal(configured.details.scope, 'project');
  assert.equal(configured.details.key, 'mcpServers.ano');
  assert.equal(configured.version, 'config-format:json');
  assert.ok(configured.limitations.some((line) => line.includes('not measured')));

  const instructions = report.layers.instructions;
  assert.equal(instructions.verdict, 'degraded');
  assert.equal(instructions.evidence, 'measured');
  assert.equal(instructions.details.rulePaths.length, 1);
  assert.equal(instructions.details.rulePaths[0], join(root, 'CLAUDE.md'));
  assert.equal(instructions.details.hasManagedSection, true);
  assert.equal(instructions.details.formatVersion, MANAGED_INSTRUCTIONS_SCHEMA);
  assert.equal(instructions.details.readOnly, true);
  assert.ok(instructions.limitations.some((line) => line.includes('does not prove')));
});

test('inspect detects CLAUDE.md without a managed section and degrades instead of guessing', async (t) => {
  const { root, bin, adapter } = fixture(t);
  installExecutable(bin, 'claude');
  writeFileSync(join(root, 'CLAUDE.md'), '# Plain rules\n');

  const report = await adapter.inspect({ root, env: {} });
  const instructions = report.layers.instructions;
  assert.equal(instructions.verdict, 'degraded');
  assert.equal(instructions.details.hasManagedSection, false);
  assert.equal(instructions.details.formatVersion, null);
  assert.equal(instructions.details.readOnly, true);
  assert.ok(instructions.limitations.some((line) => line.includes('no ANO managed marker pair')));
});

test('inspect treats malformed managed markers as absent and reports the reason', async (t) => {
  const { root, bin, adapter } = fixture(t);
  installExecutable(bin, 'claude');
  writeFileSync(join(root, 'CLAUDE.md'), `${MANAGED_INSTRUCTIONS_BEGIN}\nschema: ${MANAGED_INSTRUCTIONS_SCHEMA}\n`);

  const report = await adapter.inspect({ root, env: {} });
  assert.equal(report.layers.instructions.details.hasManagedSection, false);
  assert.ok(report.layers.instructions.limitations.some((line) => line.includes('malformed')));
});

test('inspect refuses to validate unknown entry fields or malformed JSON', async (t) => {
  const { root, bin, adapter } = fixture(t);
  installExecutable(bin, 'claude');

  writeFileSync(
    join(root, '.mcp.json'),
    `${JSON.stringify({ mcpServers: { ano: { command: process.execPath, args: [], mystery: true } } })}\n`,
  );
  const unknown = await adapter.inspect({ root, env: {} });
  assert.equal(unknown.layers.configured.verdict, 'degraded');
  assert.notEqual(unknown.layers.configured.verdict, 'validated');
  assert.ok(unknown.layers.configured.limitations.some((line) => line.includes('unknown fields')));

  writeFileSync(join(root, '.mcp.json'), '{ not json');
  const broken = await adapter.inspect({ root, env: {} });
  assert.equal(broken.layers.configured.verdict, 'degraded');
  assert.ok(broken.layers.configured.errors.some((error) => error.code === 'E2_PARSE_FAILED'));
  assert.notEqual(broken.layers.configured.verdict, 'validated');
});

test('inspect flags a typeless url entry using the public Claude Code rule', async (t) => {
  const { root, bin, adapter } = fixture(t);
  installExecutable(bin, 'claude');
  writeFileSync(
    join(root, '.mcp.json'),
    `${JSON.stringify({ mcpServers: { ano: { url: 'https://example.com/mcp' } } })}\n`,
  );
  const report = await adapter.inspect({ root, env: {} });
  assert.equal(report.layers.configured.verdict, 'degraded');
  assert.ok(report.layers.configured.limitations.some((line) => line.includes('typeless')));
});

test('config dry-run maps mcpServers.ano and writes nothing', async (t) => {
  const { root, home, adapter } = fixture(t);
  const configPath = join(root, '.mcp.json');
  const original = `${JSON.stringify(
    { mcpServers: { other: { command: 'x', args: ['y'] } }, unknownTop: { keep: true } },
    null,
    2,
  )}\n`;
  writeFileSync(configPath, original);

  const result = await adapter.config({ target: { scope: 'project' }, mode: 'dry-run', root });
  assert.equal(result.mode, 'dry-run');
  assert.equal(result.backupPlan, null);
  assert.equal(result.changes.length, 1);
  const change = result.changes[0]!;
  assert.equal(change.path, resolve(configPath));
  assert.equal(change.scope, 'project');
  assert.equal(change.key, 'mcpServers.ano');
  assert.equal(change.operation, 'add');
  assert.equal(change.before, null);
  const after = change.after as { command: string; args: string[] };
  assert.equal(after.command, process.execPath);
  assert.deepEqual(after.args, [join(root, 'dist', 'surface', 'mcp.js')]);
  assert.equal(readFileSync(configPath, 'utf8'), original, 'dry-run must be zero-write');

  const user = await adapter.config({ target: { scope: 'user' }, mode: 'dry-run', root });
  assert.equal(user.changes[0]?.path, resolve(join(home, '.claude.json')));
  assert.equal(readdirSync(root).sort().includes('.claude.json'), false);
});

test('config apply without an explicit authorization is refused and writes nothing', async (t) => {
  const { root, adapter } = fixture(t);
  const configPath = join(root, '.mcp.json');
  const original = `${JSON.stringify({ mcpServers: {} })}\n`;
  writeFileSync(configPath, original);

  const result = await adapter.config({ target: { scope: 'project' }, mode: 'apply', root });
  assert.equal(result.mode, 'dry-run');
  assert.equal(readFileSync(configPath, 'utf8'), original);
  if (result.mode === 'dry-run') {
    assert.ok(result.warnings.some((line) => /authorization|refused/i.test(line)));
  }
});

test('config apply with an authorization reference lacking a statement is refused and writes nothing', async (t) => {
  const { root, adapter } = fixture(t);
  const configPath = join(root, '.mcp.json');
  const original = '{}\n';
  writeFileSync(configPath, original);
  const grant = {
    authorizationId: 'd'.repeat(64),
    root,
    clientId: 'claude-code' as const,
    scope: ['config'],
    grantedBy: 'Alice',
    grantedAt: AT,
    revokedAt: null,
  };
  const result = await adapter.config({ target: { scope: 'project' }, mode: 'apply', authorization: grant, root });
  assert.equal(result.mode, 'dry-run');
  assert.equal(result.changes.length, 1, 'the proposed change is still reported');
  assert.equal(readFileSync(configPath, 'utf8'), original);
  assert.ok(result.mode === 'dry-run' && result.warnings.some((line) => /statement/i.test(line)));
});

test('config apply with authorization writes the ANO entry and preserves other services and unknown fields', async (t) => {
  const { root, adapter } = fixture(t);
  const configPath = join(root, '.mcp.json');
  const original = `${JSON.stringify(
    { mcpServers: { other: { command: 'other-bin', args: ['--serve'], nested: { keep: [1, 2, 3] } } }, unknownTop: { keep: true } },
    null,
    2,
  )}\n`;
  writeFileSync(configPath, original);

  const authorization = authorizationFor(root);
  const result = await adapter.config({ target: { scope: 'project' }, mode: 'apply', authorization, root });
  assert.equal(result.mode, 'apply');
  assert.equal(result.changes[0]?.operation, 'add');
  assert.ok(result.beforeHash !== result.afterHash);

  const written = JSON.parse(readFileSync(configPath, 'utf8')) as {
    mcpServers: Record<string, unknown>;
    unknownTop: unknown;
  };
  const ano = written.mcpServers['ano'] as { command: string; args: string[] };
  assert.equal(ano.command, process.execPath);
  assert.deepEqual(ano.args, [join(root, 'dist', 'surface', 'mcp.js')]);
  assert.ok(written.mcpServers['other'], 'other MCP services must be preserved');
  assert.deepEqual(written.unknownTop, { keep: true }, 'unknown fields must be preserved');
  assert.ok(existsSync(join(root, '.ano', 'clients', 'backups', 'claude-code')), 'an authorized write must be backed up');
  const afterFirst = readFileSync(configPath, 'utf8');

  const replay = await adapter.config({ target: { scope: 'project' }, mode: 'apply', authorization, root });
  assert.equal(replay.mode, 'dry-run');
  assert.equal(replay.changes.length, 0, 'idempotent replay is a zero-byte no-op');
  assert.equal(readFileSync(configPath, 'utf8'), afterFirst);
});

test('config honors an explicit path override and refuses a non-json format', async (t) => {
  const { root, adapter } = fixture(t);
  const custom = join(root, 'custom.json');
  writeFileSync(custom, '{}\n');
  const grant = authorizationFor(root);
  const applied = await adapter.config({
    target: { scope: 'project', path: custom },
    mode: 'apply',
    authorization: grant,
    root,
  });
  assert.equal(applied.mode, 'apply');
  assert.equal(applied.changes[0]?.path, resolve(custom));
  assert.ok(existsSync(custom));

  const wrongFormat = await adapter.config({ target: { scope: 'project', format: 'toml' }, mode: 'dry-run', root });
  assert.equal(wrongFormat.mode, 'dry-run');
  assert.ok(wrongFormat.mode === 'dry-run' && wrongFormat.warnings.some((line) => line.includes('json')));
  assert.equal(existsSync(join(root, 'config.toml')), false);
});

test('claudeCodeConfigTarget exposes the declared mapping', () => {
  const home = resolve('/tmp/ano-home');
  const root = resolve('/tmp/ano-root');
  const target = claudeCodeConfigTarget('project', { home, root });
  assert.equal(target.clientId, 'claude-code');
  assert.equal(target.scope, 'project');
  assert.equal(target.format, 'json');
  assert.deepEqual(target.serverPath, ['mcpServers']);
  assert.equal(target.serverName, 'ano');
  assert.equal(target.allowedRoot, root);
  assert.equal(target.path, resolve(join(root, '.mcp.json')));
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

  const noCommand = await adapter.verify({ transport: 'stdio' });
  assert.equal(noCommand.verdicts.mcp, 'unavailable');
  assert.equal(noCommand.errors[0]?.code, 'E3_NO_COMMAND');
});
