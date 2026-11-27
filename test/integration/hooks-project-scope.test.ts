import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { buildHookCommand } from '../../src/clients/install.ts';
import { runCli } from '../../src/surface/cli.ts';

function fixture(t: TestContext): { root: string; other: string; home: string } {
  const home = mkdtempSync(join(tmpdir(), 'ano-hook-scope-'));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const root = join(home, 'project-a');
  const other = join(home, 'project-b');
  for (const path of [root, other]) {
    mkdirSync(path);
    writeFileSync(join(path, 'package.json'), JSON.stringify({ name: 'scope-fixture', private: true }));
    execFileSync('git', ['init', '-q', path]);
  }
  return { root, other, home };
}

const events = {
  SessionStart: 'session-start',
  UserPromptSubmit: 'prompt',
  PreToolUse: 'pre-tool',
  Stop: 'stop',
} as const;

function stdin(event: string, cwd: string): string {
  return JSON.stringify({
    hook_event_name: event,
    session_id: 'scope-fixture-session',
    cwd,
    ...(event === 'PreToolUse' ? { tool_name: 'Write', tool_input: { file_path: 'package.json' } } : {}),
  });
}

test('installed hooks skip other projects without writes, context injection or permission decisions', async (t) => {
  const { root, other } = fixture(t);
  for (const client of ['zcode', 'claude-code'] as const) {
    for (const event of Object.keys(events) as (keyof typeof events)[]) {
      const { args } = buildHookCommand(client, event, root);
      const result = await runCli([...args.slice(1)], { hookStdin: async () => stdin(event, other) });
      assert.deepEqual(result, { code: 0, output: '' }, `${client}/${event}`);
      assert.equal(existsSync(join(root, '.ano')), false, 'bound project must remain untouched');
      assert.equal(existsSync(join(other, '.ano')), false, 'unconnected host project must remain untouched');
    }
  }
});

test('installed hooks skip unverifiable and relative host directories without initializing a project', async (t) => {
  const { root, home } = fixture(t);
  for (const cwd of [home, join(home, 'missing'), 'relative-project']) {
    const { args } = buildHookCommand('zcode', 'SessionStart', root);
    const result = await runCli([...args.slice(1)], { hookStdin: async () => stdin('SessionStart', cwd) });
    assert.deepEqual(result, { code: 0, output: '' });
    assert.equal(existsSync(join(root, '.ano')), false);
    assert.equal(existsSync(join(home, '.ano')), false);
  }
});

test('installed hooks accept a subdirectory and canonical path alias of the bound project', async (t) => {
  const { root, home } = fixture(t);
  const nested = join(root, 'src');
  mkdirSync(nested);
  const alias = join(home, 'project-alias');
  symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  for (const cwd of [nested, alias]) {
    const { args } = buildHookCommand('zcode', 'SessionStart', root);
    const result = await runCli([...args.slice(1)], { hookStdin: async () => stdin('SessionStart', cwd) });
    assert.equal(result.code, 0);
    assert.notEqual(result.output, '');
    const rendered = JSON.parse(result.output) as { hookSpecificOutput?: { additionalContext?: string } };
    assert.ok(rendered.hookSpecificOutput?.additionalContext);
    assert.equal(existsSync(join(root, '.ano', 'ledger')), true);
  }
});

test('manual explicit root retains priority over host cwd when the installed-scope flag is absent', async (t) => {
  const { root, other } = fixture(t);
  const result = await runCli(['hook', 'session-start', '--client', 'zcode', '--root', root], {
    hookStdin: async () => stdin('SessionStart', other),
  });
  assert.equal(result.code, 0);
  assert.notEqual(result.output, '');
  assert.equal(existsSync(join(root, '.ano', 'ledger')), true);
  assert.equal(existsSync(join(other, '.ano')), false);
});

test('project-scoped hook requires a binding root and preserves strict mode for matching projects', async (t) => {
  const { root } = fixture(t);
  const missing = await runCli(['hook', 'pre-tool', '--client', 'zcode', '--project-scoped'], {
    hookStdin: async () => stdin('PreToolUse', root),
  });
  assert.notEqual(missing.code, 0);
  assert.match(missing.output, /requires --root/u);
  mkdirSync(join(root, '.ano'));
  writeFileSync(join(root, '.ano', 'config.toml'), '[hooks]\nmode = "strict"\n');
  const { args } = buildHookCommand('zcode', 'PreToolUse', root);
  const strict = await runCli([...args.slice(1)], {
    hookStdin: async () => JSON.stringify({ ...JSON.parse(stdin('PreToolUse', root)), tool_input: {} }),
  });
  assert.equal(strict.code, 2);
  assert.match(strict.output, /"permissionDecision":"deny"/u);
});
