import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import {
  applyClientHooks,
  planClientHooks,
  restoreClientConfig,
  type ClientConfigAuthorization,
  type ClientHooksTarget,
} from '../../src/clients/config.ts';
import {
  HOOK_INSTALL_EVENTS,
  buildHookCommand,
  buildHooksDocument,
  installClientHooks,
  resolveHooksTarget,
} from '../../src/clients/install.ts';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI_PATH = join(REPO_ROOT, 'dist', 'surface', 'cli.js');

function rootFor(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'ano-install-hooks-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function auth(root: string, clientId: string): ClientConfigAuthorization {
  return {
    authorizationId: 'b'.repeat(64),
    root,
    clientId,
    scope: ['config', 'install', 'restore'],
    grantedBy: 'Alice',
    statement: 'Authorize ANO hooks install for this project',
    grantedAt: '2026-11-26T00:00:00.000Z',
  };
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

const OTHER_FIELDS = {
  mcpServers: { other: { command: 'node', args: ['x.js'] } },
  theme: 'dark',
  custom: { nested: [1, 2, 3] },
};

// ---------------------------------------------------------------------------
// dry-run：零写
// ---------------------------------------------------------------------------

test('hooks 安装 dry-run 零写：目标文件不存在时也不创建', (t) => {
  const root = rootFor(t);
  const target = resolveHooksTarget('zcode', { home: root, root });
  assert.equal(existsSync(target.path), false);

  const result = installClientHooks(target, buildHooksDocument('zcode', root), {
    mode: 'dry-run',
    root,
    authorization: auth(root, 'zcode'),
  });

  assert.equal(result.mode, 'dry-run');
  assert.equal(result.applied, false);
  assert.equal(result.changed, true);
  assert.equal(existsSync(target.path), false, 'dry-run must not create the config file');
});

test('hooks 安装 dry-run 零写：已存在文件时字节不变', (t) => {
  const root = rootFor(t);
  const target = resolveHooksTarget('zcode', { home: root, root });
  mkdirSync(join(root, '.zcode', 'cli'), { recursive: true });
  const original = `${JSON.stringify(OTHER_FIELDS, null, 2)}\n`;
  writeFileSync(target.path, original, 'utf8');
  const before = sha256(readFileSync(target.path));

  const result = installClientHooks(target, buildHooksDocument('zcode', root), {
    mode: 'dry-run',
    root,
    authorization: auth(root, 'zcode'),
  });

  assert.equal(result.applied, false);
  assert.equal(result.changed, true);
  assert.equal(sha256(readFileSync(target.path)), before, 'dry-run must not change a byte');
});

// ---------------------------------------------------------------------------
// confirm：写入 S8 确认键，其他字段原样保留
// ---------------------------------------------------------------------------

test('hooks 安装 confirm：只写 S8 确认键，其他字段原样保留', (t) => {
  const root = rootFor(t);
  const target = resolveHooksTarget('zcode', { home: root, root });
  mkdirSync(join(root, '.zcode', 'cli'), { recursive: true });
  writeFileSync(target.path, `${JSON.stringify(OTHER_FIELDS, null, 2)}\n`, 'utf8');

  const result = installClientHooks(target, buildHooksDocument('zcode', root), {
    mode: 'apply',
    confirm: true,
    root,
    authorization: auth(root, 'zcode'),
  });

  assert.equal(result.applied, true);
  assert.equal(result.error, null);
  const doc = JSON.parse(readFileSync(target.path, 'utf8')) as Record<string, unknown>;
  // 其他字段逐字段不变
  assert.deepEqual(doc['mcpServers'], OTHER_FIELDS['mcpServers']);
  assert.equal(doc['theme'], 'dark');
  assert.deepEqual(doc['custom'], OTHER_FIELDS['custom']);
  // hooks 段只含 S8 确认键
  const hooks = doc['hooks'] as Record<string, unknown>;
  assert.equal(hooks['enabled'], true);
  const events = hooks['events'] as Record<string, unknown>;
  assert.deepEqual(Object.keys(events).sort(), [...HOOK_INSTALL_EVENTS].sort());
  for (const event of HOOK_INSTALL_EVENTS) {
    const groups = events[event] as { hooks: Record<string, unknown>[] }[];
    assert.equal(groups.length, 1);
    const entry = groups[0]!.hooks[0]!;
    assert.equal(entry['type'], 'process');
    assert.equal(typeof entry['command'], 'string');
    assert.ok(Array.isArray(entry['args']));
    assert.equal(typeof entry['timeoutMs'], 'number');
    assert.deepEqual(Object.keys(entry).sort(), ['args', 'command', 'timeoutMs', 'type']);
  }
  assert.ok(result.backupId, 'authorized write must create a backup');
});

test('hooks 安装拒绝无 confirm / 无授权（零写）', (t) => {
  const root = rootFor(t);
  const target = resolveHooksTarget('zcode', { home: root, root });
  mkdirSync(join(root, '.zcode', 'cli'), { recursive: true });
  const original = `${JSON.stringify(OTHER_FIELDS, null, 2)}\n`;
  writeFileSync(target.path, original, 'utf8');
  const before = sha256(readFileSync(target.path));

  const noConfirm = installClientHooks(target, buildHooksDocument('zcode', root), {
    mode: 'apply', root, authorization: auth(root, 'zcode'),
  });
  assert.equal(noConfirm.applied, false);
  const noAuth = installClientHooks(target, buildHooksDocument('zcode', root), {
    mode: 'apply', confirm: true, root,
  });
  assert.equal(noAuth.applied, false);
  assert.equal(sha256(readFileSync(target.path)), before);
});

// ---------------------------------------------------------------------------
// restore：字节还原
// ---------------------------------------------------------------------------

test('hooks 安装后 restore 字节还原到写入前', (t) => {
  const root = rootFor(t);
  const target = resolveHooksTarget('zcode', { home: root, root });
  mkdirSync(join(root, '.zcode', 'cli'), { recursive: true });
  const original = `${JSON.stringify(OTHER_FIELDS, null, 2)}\n`;
  writeFileSync(target.path, original, 'utf8');
  const before = Buffer.from(readFileSync(target.path));

  const installed = installClientHooks(target, buildHooksDocument('zcode', root), {
    mode: 'apply', confirm: true, root, authorization: auth(root, 'zcode'),
  });
  assert.equal(installed.applied, true);
  assert.equal(readFileSync(target.path).equals(before), false, 'install must change bytes');

  const backupId = installed.backupId!;
  // restoreClientConfig 以 hooks target 的 clientId 与路径做验证
  const adapted = {
    clientId: 'zcode', scope: 'user' as const, path: target.path,
    format: 'json' as const, serverPath: ['hooks'], serverName: 'events', allowedRoot: target.allowedRoot,
  };
  const restored = restoreClientConfig(adapted, {
    mode: 'apply', confirm: true, root, backupId, authorization: auth(root, 'zcode'),
  });
  assert.equal(restored.applied, true);
  assert.ok(readFileSync(target.path).equals(before), 'restore must be byte-identical to the original');
});

// ---------------------------------------------------------------------------
// 固定命令：绝对 node + 绝对 cli.js + 固定参数，不拼接外部输入
// ---------------------------------------------------------------------------

test('hook 命令固定绝对 node / 绝对 cli.js / 固定参数，不含外部输入', (t) => {
  const root = rootFor(t);
  for (const client of ['zcode', 'claude-code'] as const) {
    for (const event of HOOK_INSTALL_EVENTS) {
      const { command, args } = buildHookCommand(client, event, root);
      assert.ok(command.startsWith(resolve('/')) || /^[A-Za-z]:[\\/]/.test(command), `node path must be absolute: ${command}`);
      assert.ok(args[0]!.endsWith(join('dist', 'surface', 'cli.js')), 'cli path must be absolute dist entry');
      assert.ok(!args[0]!.startsWith('.'), 'cli path must not be relative');
      assert.deepEqual(args.slice(1, 3), ['hook', {
        SessionStart: 'session-start', UserPromptSubmit: 'prompt', PreToolUse: 'pre-tool', Stop: 'stop',
      }[event]]);
      assert.deepEqual(args.slice(3), ['--client', client, '--root', resolve(root), '--project-scoped']);
      // 不含 shell 元字符或外部输入痕迹
      for (const arg of args) assert.ok(!/[;&|`$]/.test(arg), `argument contains shell metacharacter: ${arg}`);
    }
  }
});

// ---------------------------------------------------------------------------
// plan：只规划 hooks 段
// ---------------------------------------------------------------------------

test('planClientHooks 只规划 hooks 段，保留其他字段', (t) => {
  const root = rootFor(t);
  const target = resolveHooksTarget('zcode', { home: root, root });
  mkdirSync(join(root, '.zcode', 'cli'), { recursive: true });
  writeFileSync(target.path, `${JSON.stringify(OTHER_FIELDS, null, 2)}\n`, 'utf8');

  const plan = planClientHooks(target, buildHooksDocument('zcode', root));
  assert.equal(plan.changed, true);
  assert.ok(plan.mergedBytes);
  const merged = JSON.parse(plan.mergedBytes.toString('utf8')) as Record<string, unknown>;
  assert.deepEqual(merged['mcpServers'], OTHER_FIELDS['mcpServers']);
  assert.equal(merged['theme'], 'dark');
  assert.ok(merged['hooks']);
});

// ---------------------------------------------------------------------------
// CLI 真实子进程：hook 入口 fail-closed，不 allow
// ---------------------------------------------------------------------------

test('CLI ano hook：S8 双字段 stdin 归一化，fail-closed 不 allow', (t) => {
  assert.ok(existsSync(CLI_PATH), 'dist/surface/cli.js must be built before this test');
  const stdin = JSON.stringify({
    hook_event_name: 'PreToolUse',
    hookEventName: 'PreToolUse',
    session_id: 'sess_cli',
    sessionId: 'sess_cli',
    cwd: REPO_ROOT,
    tool_name: 'Edit',
    toolName: 'Edit',
    tool_input: { file_path: join(REPO_ROOT, 'src', 'index.ts') },
    toolInput: { file_path: join(REPO_ROOT, 'src', 'index.ts') },
  });
  const result = spawnSync(process.execPath, [CLI_PATH, 'hook', 'pre-tool', '--client', 'zcode', '--root', REPO_ROOT], {
    input: stdin, encoding: 'utf8', cwd: REPO_ROOT,
  });
  assert.equal(result.status, 0);
  const out = JSON.parse(result.stdout.trim()) as { hookSpecificOutput: Record<string, string> };
  assert.equal(out.hookSpecificOutput['hookEventName'], 'PreToolUse');
  assert.notEqual(out.hookSpecificOutput['permissionDecision'], 'allow');
});

test('CLI ano hook：strict 模式 deny 时 stdout 仍有 JSON 且退出码为 2', (t) => {
  assert.ok(existsSync(CLI_PATH));
  const root = rootFor(t);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'hook-strict-fixture', type: 'module' }));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'index.ts'), 'export const answer = 42;\n');
  for (const args of [['init'], ['config', 'user.email', 'test@example.com'], ['config', 'user.name', 'Test'], ['add', '.'], ['commit', '-m', 'init']]) {
    assert.equal(spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' }).status, 0);
  }
  const graph = spawnSync(process.execPath, [CLI_PATH, 'rebuild', 'graph', '--root', root], { encoding: 'utf8' });
  assert.equal(graph.status, 0, graph.stderr);
  const stdin = JSON.stringify({
    hook_event_name: 'PreToolUse', session_id: 's', cwd: root,
    tool_name: 'Edit', tool_input: { file_path: join(root, 'src', 'index.ts') },
  });
  const result = spawnSync(process.execPath, [CLI_PATH, 'hook', 'pre-tool', '--client', 'zcode', '--mode', 'strict', '--root', root], {
    input: stdin, encoding: 'utf8', cwd: root,
  });
  assert.equal(result.status, 2);
  const out = JSON.parse(result.stdout.trim()) as { hookSpecificOutput: Record<string, string> };
  assert.equal(out.hookSpecificOutput['permissionDecision'], 'deny');
});

test('CLI clients install --with-hooks：ZCode mcp 段仍拒绝，hooks 段可 dry-run', (t) => {
  assert.ok(existsSync(CLI_PATH));
  const root = rootFor(t);
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const args = [
    CLI_PATH, 'clients', 'install', 'zcode',
    '--granted-by', 'Alice',
    '--statement', 'Authorize hooks install',
    '--scope', 'config,install',
    '--with-hooks',
    '--dry-run',
    '--root', root,
    '--home', home,
    '--json',
  ];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', cwd: root });
  assert.equal(result.status, 0, `dry-run should succeed: ${result.stdout} ${result.stderr}`);
  const out = JSON.parse(result.stdout.trim()) as { applied: boolean; changed: boolean; targetPath: string };
  assert.equal(out.applied, false, 'dry-run writes nothing');
  assert.equal(out.changed, true);
  // ZCode 的 mcp 配置路径不被创建/修改（mcp 段行为不变）
  const zcodeConfig = join(home, '.zcode', 'cli', 'config.json');
  assert.equal(existsSync(zcodeConfig), false, 'hooks dry-run must not create the config file');
});

test('CLI clients install zcode（无 --with-hooks）：mcp 段仍被拒绝，行为不变', (t) => {
  assert.ok(existsSync(CLI_PATH));
  const root = rootFor(t);
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const args = [
    CLI_PATH, 'clients', 'install', 'zcode',
    '--granted-by', 'Alice',
    '--statement', 'Authorize MCP install',
    '--scope', 'config,install',
    '--root', root,
    '--home', home,
    '--json',
  ];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', cwd: root });
  // ZCode 无声明可写 mcp 目标；clientInstallSurface 返回 exitCode 2。
  assert.equal(result.status, 2, `plain zcode install must stay refused: ${result.stdout} ${result.stderr}`);
  assert.match(result.stdout + result.stderr, /read-only|refus|no declared/i);
});

test('CLI clients install --with-hooks --confirm：真实写入且只写 hooks 段', (t) => {
  assert.ok(existsSync(CLI_PATH));
  const root = rootFor(t);
  const home = join(root, 'home');
  const configDir = join(home, '.zcode', 'cli');
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, 'config.json');
  const original = `${JSON.stringify({ ...OTHER_FIELDS, hooks: { enabled: false, customKey: 'keep' } }, null, 2)}\n`;
  writeFileSync(configPath, original, 'utf8');

  const args = [
    CLI_PATH, 'clients', 'install', 'zcode',
    '--granted-by', 'Alice',
    '--statement', 'Authorize hooks install',
    '--scope', 'config,install',
    '--with-hooks',
    '--confirm',
    '--root', root,
    '--home', home,
    '--json',
  ];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', cwd: root });
  assert.equal(result.status, 0, `confirm apply should succeed: ${result.stdout} ${result.stderr}`);
  const out = JSON.parse(result.stdout.trim()) as { applied: boolean };
  assert.equal(out.applied, true);
  const doc = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(doc['mcpServers'], OTHER_FIELDS['mcpServers']);
  assert.equal(doc['theme'], 'dark');
  const hooks = doc['hooks'] as Record<string, unknown>;
  assert.equal(hooks['enabled'], true);
  assert.equal(hooks['customKey'], 'keep', 'unknown hooks key must be preserved');
  assert.ok(hooks['events']);
});
