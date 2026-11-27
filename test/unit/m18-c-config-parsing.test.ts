/**
 * T-153 / QF-04 shard C: Codex TOML and Claude Code JSON configuration parsing.
 *
 * Real config documents are written into tmpdir homes/projects: malformed TOML,
 * missing entries, non-table entries, url-only entries, empty containers, nested
 * `projects` lookups, managed-marker malformations and write authorization
 * refusals. No parser or filesystem boundary is mocked.
 */

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  MANAGED_INSTRUCTIONS_BEGIN,
  MANAGED_INSTRUCTIONS_END,
  MANAGED_INSTRUCTIONS_SCHEMA,
} from '../../src/connect/managed-instructions.ts';
import { createCodexAdapter } from '../../src/clients/codex.ts';
import { createClaudeCodeAdapter } from '../../src/clients/claude-code.ts';
import {
  m18cAuthz,
  m18cConfig,
  m18cHomeEnv,
  m18cTmp,
  m18cWriteJson,
  m18cWriteText,
  m18cWarnings,
} from '../helpers/m18-c-fixtures.ts';

function codexFixture(t: Parameters<typeof m18cTmp>[0]): { root: string; home: string; bin: string; configPath: string } {
  const root = m18cTmp(t, 'ano-m18-c-codex-');
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  m18cWriteText(join(bin, process.platform === 'win32' ? 'codex.cmd' : 'codex'), '');
  return { root, home, bin, configPath: join(home, '.codex', 'config.toml') };
}

test('codex: aborted detection and config.toml entry-shape edges', async (t) => {
  const { root, home, bin, configPath } = codexFixture(t);
  const adapter = createCodexAdapter({ home, root, probePaths: [bin] });

  const controller = new AbortController();
  controller.abort();
  const aborted = await adapter.detect({ cwd: root, signal: controller.signal });
  assert.equal(aborted.errors[0]?.code, 'E1_ABORTED');

  m18cWriteText(configPath, ['[mcp_servers.other]', 'command = "other"', ''].join('\n'));
  const missing = await adapter.inspect({ root, env: m18cHomeEnv(home) });
  assert.equal(missing.layers.configured.details.exists, false);
  assert.ok(missing.layers.configured.limitations.some((line) => line.includes('no [mcp_servers.ano] entry')));

  m18cWriteText(configPath, ['[mcp_servers]', 'ano = "not-a-table"', ''].join('\n'));
  const nonTable = await adapter.inspect({ root, env: m18cHomeEnv(home) });
  assert.equal(nonTable.layers.configured.details.exists, true);
  assert.ok(nonTable.layers.configured.limitations.some((line) => line.includes('not a TOML table')));

  m18cWriteText(configPath, ['[mcp_servers.ano]', 'url = "https://example.test"', ''].join('\n'));
  const remote = await adapter.inspect({ root, env: m18cHomeEnv(home) });
  assert.ok(remote.layers.configured.limitations.some((line) => line.includes('remote url entry was not probed')));

  m18cWriteText(configPath, ['[mcp_servers.ano]', 'foo = "bar"', ''].join('\n'));
  const neither = await adapter.inspect({ root, env: m18cHomeEnv(home) });
  assert.ok(neither.layers.configured.limitations.some((line) => line.includes('neither command nor url')));

  // A bare command name (no path separator) is resolved through the probe PATH.
  m18cWriteText(configPath, ['[mcp_servers.ano]', 'command = "codex"', ''].join('\n'));
  const bareCommand = await adapter.inspect({ root, env: m18cHomeEnv(home) });
  assert.equal(bareCommand.layers.configured.details.exists, true);
});

test('codex: malformed managed markers degrade instead of claiming takeover', async (t) => {
  const { root, home, bin, configPath } = codexFixture(t);
  m18cWriteText(configPath, ['[mcp_servers.ano]', `command = ${JSON.stringify(process.execPath)}`, ''].join('\n'));

  const adapter = createCodexAdapter({ home, root, probePaths: [bin] });
  const cases: readonly { name: string; text: string; needle: string; present: boolean }[] = [
    {
      name: 'unbalanced',
      text: `${MANAGED_INSTRUCTIONS_BEGIN}\n${MANAGED_INSTRUCTIONS_BEGIN}\nbody\n${MANAGED_INSTRUCTIONS_END}\n`,
      needle: 'managed markers are malformed',
      present: false,
    },
    {
      name: 'end-before-begin',
      text: `${MANAGED_INSTRUCTIONS_END}\n${MANAGED_INSTRUCTIONS_BEGIN}\n`,
      needle: 'managed end marker appears before the begin marker',
      present: false,
    },
    {
      name: 'schema-mismatch',
      text: `${MANAGED_INSTRUCTIONS_BEGIN}\nschema: something-else\n${MANAGED_INSTRUCTIONS_END}\n`,
      needle: 'does not match',
      present: true,
    },
  ];

  for (const item of cases) {
    m18cWriteText(join(root, 'AGENTS.md'), item.text);
    const report = await adapter.inspect({ root, env: m18cHomeEnv(home) });
    assert.ok(
      report.layers.instructions.limitations.some((line) => line.includes(item.needle)),
      `${item.name}: expected limitation "${item.needle}" in ${JSON.stringify(report.layers.instructions.limitations)}`,
    );
    assert.equal(report.layers.instructions.details.hasManagedSection, item.present);
  }
});

test('codex: apply without an auditable statement refuses and writes nothing', async (t) => {
  const { root, home, configPath } = codexFixture(t);
  m18cWriteText(configPath, ['[mcp_servers.other]', 'command = "other"', ''].join('\n'));
  const adapter = createCodexAdapter({ home, root });

  const blank = await adapter.config(
    m18cConfig({
      target: { scope: 'user' },
      mode: 'apply',
      root,
      authorization: m18cAuthz(root, 'codex', { statement: '   ' }),
    }),
  );
  assert.equal(blank.mode, 'dry-run');
  assert.ok(m18cWarnings(blank).some((line) => line.includes('auditable statement')));
  assert.equal(readFileSync(configPath, 'utf8').includes('mcp_servers.ano'), false);
});

test('codex: valid authorization reaches the writer and reports the TOML refusal reason', async (t) => {
  const { root, home, configPath } = codexFixture(t);
  m18cWriteText(configPath, ['[mcp_servers.other]', 'command = "other"', ''].join('\n'));
  const adapter = createCodexAdapter({ home, root });

  const applied = await adapter.config(
    m18cConfig({
      target: { scope: 'user' },
      mode: 'apply',
      root,
      authorization: m18cAuthz(root, 'codex', { statement: 'Authorize ANO codex configuration' }),
    }),
  );
  assert.equal(applied.mode, 'dry-run');
  assert.equal(applied.changes.length > 0, true);
  assert.ok(m18cWarnings(applied).some((line) => /read-only|refused|toml/i.test(line)));
});

interface ClaudeFixture {
  root: string;
  home: string;
  bin: string;
  settingsPath: string;
  claudeJsonPath: string;
  projectPath: string;
}

function claudeFixture(t: Parameters<typeof m18cTmp>[0]): ClaudeFixture {
  const root = m18cTmp(t, 'ano-m18-c-claude-');
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  m18cWriteText(join(bin, process.platform === 'win32' ? 'claude.cmd' : 'claude'), '');
  return {
    root,
    home,
    bin,
    settingsPath: join(home, '.claude', 'settings.json'),
    claudeJsonPath: join(home, '.claude.json'),
    projectPath: join(root, '.mcp.json'),
  };
}

test('claude-code: top-level and project-nested JSON lookup edges', async (t) => {
  const { root, home, bin, settingsPath, claudeJsonPath } = claudeFixture(t);
  const adapter = createClaudeCodeAdapter({ home, root, probePaths: [bin] });
  const env = { ...m18cHomeEnv(home), PATH: bin };

  m18cWriteText(settingsPath, '[]');
  const nonObject = await adapter.inspect({ root, env });
  assert.ok(
    nonObject.errors.some((error) => error.code === 'E2_PARSE_FAILED' && error.message.includes('JSON object at the top level')),
    `expected top-level JSON object error, got ${JSON.stringify(nonObject.errors)}`,
  );

  const nestedEntry = { command: process.execPath, args: ['mcp.js'] };
  m18cWriteJson(claudeJsonPath, { projects: { [root]: { mcpServers: { ano: nestedEntry } } } });
  const nested = await adapter.inspect({ root, env });
  assert.equal(nested.layers.configured.details.exists, true);
  assert.equal(nested.layers.configured.details.configPath, resolve(claudeJsonPath));
  const resolved = nested.layers.configured.details.resolvedEntry as { command: string; args: string[] };
  assert.equal(resolved.command, nestedEntry.command);
  assert.deepEqual(resolved.args, nestedEntry.args);

  const controller = new AbortController();
  controller.abort();
  const aborted = await adapter.detect({ cwd: root, signal: controller.signal });
  assert.equal(aborted.errors[0]?.code, 'E1_ABORTED');
});

test('claude-code: mcpServers.ano entry shapes cover bare/non-object/neither', async (t) => {
  const { root, home, bin, projectPath } = claudeFixture(t);
  const adapter = createClaudeCodeAdapter({ home, root, probePaths: [bin] });
  const env = { ...m18cHomeEnv(home), PATH: bin };

  m18cWriteJson(projectPath, { mcpServers: { ano: 'some-command' } });
  const bare = await adapter.inspect({ root, env });
  assert.ok(bare.layers.configured.limitations.some((line) => line.includes('bare command string')));

  m18cWriteJson(projectPath, { mcpServers: { ano: 42 } });
  const nonObject = await adapter.inspect({ root, env });
  assert.ok(nonObject.layers.configured.limitations.some((line) => line.includes('not a JSON object')));

  m18cWriteJson(projectPath, { mcpServers: { ano: { foo: 'bar' } } });
  const neither = await adapter.inspect({ root, env });
  assert.ok(neither.layers.configured.limitations.some((line) => line.includes('neither command nor url')));
});

test('claude-code: managed marker ordering and schema mismatches stay degraded', async (t) => {
  const { root, home, bin, projectPath } = claudeFixture(t);
  m18cWriteJson(projectPath, { mcpServers: { ano: { command: process.execPath } } });
  const adapter = createClaudeCodeAdapter({ home, root, probePaths: [bin] });
  const env = { ...m18cHomeEnv(home), PATH: bin };

  m18cWriteText(
    join(root, 'CLAUDE.md'),
    `${MANAGED_INSTRUCTIONS_END}\n${MANAGED_INSTRUCTIONS_BEGIN}\n`,
  );
  const reversed = await adapter.inspect({ root, env });
  assert.ok(reversed.layers.instructions.limitations.some((line) => line.includes('end marker appears before')));

  m18cWriteText(
    join(root, 'CLAUDE.md'),
    `${MANAGED_INSTRUCTIONS_BEGIN}\nschema: not-the-schema\n${MANAGED_INSTRUCTIONS_END}\n`,
  );
  const schema = await adapter.inspect({ root, env });
  assert.ok(schema.layers.instructions.limitations.some((line) => line.includes(MANAGED_INSTRUCTIONS_SCHEMA)));
});

test('claude-code: apply refuses a blank statement, then writes and replays zero-write', async (t) => {
  const { root, home, projectPath } = claudeFixture(t);
  m18cWriteJson(projectPath, {});
  const adapter = createClaudeCodeAdapter({ home, root });
  const base = { target: { scope: 'project' as const }, mode: 'apply' as const, root, env: m18cHomeEnv(home) };

  const blank = await adapter.config(
    m18cConfig({ ...base, authorization: m18cAuthz(root, 'claude-code', { statement: '' }) }),
  );
  assert.equal(blank.mode, 'dry-run');
  assert.ok(m18cWarnings(blank).some((line) => line.includes('auditable statement')));

  const grant = m18cAuthz(root, 'claude-code', { statement: 'Authorize ANO claude-code configuration' });
  const applied = await adapter.config(m18cConfig({ ...base, authorization: grant }));
  assert.equal(applied.mode, 'apply');
  assert.equal(applied.changes.length > 0, true);

  const replay = await adapter.config(m18cConfig({ ...base, authorization: grant }));
  assert.equal(replay.mode, 'dry-run');
  assert.ok(m18cWarnings(replay).some((line) => line.includes('already matches')));

  // A real backup-path fault must degrade to a located zero-write refusal.
  m18cWriteJson(projectPath, {});
  const backupBlocker = join(root, '.ano', 'clients', 'backups', 'claude-code');
  rmSync(backupBlocker, { recursive: true, force: true });
  m18cWriteText(backupBlocker, 'not a directory');
  const failed = await adapter.config(m18cConfig({ ...base, authorization: grant }));
  assert.ok(m18cWarnings(failed).some((line) => line.includes('apply failed')));
});
