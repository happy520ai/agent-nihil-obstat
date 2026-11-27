/**
 * T-153 分片 A：CLI handler 错误出口与客户端安装/恢复文本渲染。
 *
 * 只调用导出的 `runCli`，以临时项目根驱动真实解析与 surface；不修改源码，
 * 不触碰真实用户目录。错误出口统一断言 exit code 2（参数/授权拒绝），
 * 成功路径只读或写入隔离的 tmp 根。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runCli } from '../../src/surface/cli.ts';

function initGitProject(root: string): void {
  writeFileSync(join(root, '.gitignore'), '.ano/\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  mkdirSync(join(root, 'test'), { recursive: true });
  writeFileSync(join(root, 'test', 'a.test.ts'), "import test from 'node:test';\n");
  for (const args of [['init', '-q'], ['config', 'user.email', 'ano@localhost'], ['config', 'user.name', 'ano'], ['add', '.'], ['commit', '-qm', 'base']] as const) {
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
}

function rootFor(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'ano-cli-handlers-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

const INSTALL_GRANT = ['--granted-by', 'Alice', '--statement', 'authorize ANO client access', '--scope', 'config,install'] as const;

test('T-153 CLI 参数/标志错误出口返回 2 且不落盘', async (t) => {
  const root = rootFor(t);
  const cases: ReadonlyArray<{ argv: readonly string[]; match: RegExp }> = [
    { argv: ['brief', '--context-budget', '20'], match: /requires --memory-context/u },
    { argv: ['brief', '--memory-context', '--context-budget', '0'], match: /integer between 1 and 10000/u },
    { argv: ['track', 'update', '--id', 'T1', '--status', 'bogus'], match: /--status must be/u },
    { argv: ['track', 'complete', '--id', 'T1'], match: /--evidence-id/u },
    { argv: ['migrate', 'apply'], match: /--expected-source-digest/u },
    { argv: ['migrate', 'status', '--expected-source-digest', 'xyz'], match: /64-character sha256/u },
    { argv: ['takeover', 'grant'], match: /--scope/u },
    { argv: ['takeover', 'apply'], match: /--confirm/u },
    { argv: ['verify', 'release'], match: /--target, --profile and --artifact/u },
    { argv: ['recall', '--mode', 'nope'], match: /supports only probe/u },
    { argv: ['recall', '--mode', 'probe'], match: /--project-scope/u },
    { argv: ['recall', '--mode', 'probe', '--project-scope', 'local', '--query', 'x', '--budget', '{"max_candidates":0}'], match: /integer in \[1,/u },
    { argv: ['recall', '--mode', 'probe', '--project-scope', 'local', '--query', 'x', '--budget', '{"nope":1}'], match: /does not accept field/u },
    { argv: ['recall', '--mode', 'probe', '--project-scope', 'local', '--query', 'x', '--temporal-mode', 'NOPE'], match: /CURRENT \| AS_OF \| HISTORICAL/u },
    { argv: ['recall', '--mode', 'probe', '--project-scope', 'local', '--query', 'x', '--temporal-mode', 'AS_OF'], match: /--as-of is required/u },
    { argv: ['recall', '--limit', '5'], match: /requires --source connected/u },
    { argv: ['note', 'revise', '--kind', 'decision', '--text', 't', '--fact-key', 'k', '--supersedes', '[]', '--reason', 'r', '--effective-from', 'null', '--effective-to', 'null', '--symbol', 's'], match: /require --file/u },
    { argv: ['note', 'revise', '--kind', 'decision', '--text', 't', '--fact-key', 'k', '--supersedes', 'notjson', '--reason', 'r', '--effective-from', 'null', '--effective-to', 'null'], match: /valid JSON/u },
    { argv: ['note', 'relate', '--edge', 'bogus'], match: /depends_on \| explains \| related_to/u },
    { argv: ['doctor', 'clients', '--nope'], match: /does not accept/u },
    { argv: ['doctor', 'clients', '--env', 'BAD'], match: /KEY=VALUE/u },
    { argv: ['doctor', 'clients', '--timeout-ms', '0'], match: /integer between 1 and 120000/u },
    { argv: ['doctor', 'client', 'nope'], match: /unknown client id/u },
    { argv: ['clients', 'install'], match: /requires <id>/u },
    { argv: ['clients', 'install', 'nope', ...INSTALL_GRANT], match: /unknown client id/u },
    { argv: ['clients', 'install', 'claude-code', '--granted-by', 'A', '--statement', 'S', '--scope', 'detect'], match: /must include config/u },
    { argv: ['clients', 'install', 'claude-code', ...INSTALL_GRANT, '--granted-at', 'bad'], match: /--granted-at must be/u },
    { argv: ['clients', 'install', 'claude-code', ...INSTALL_GRANT, '--config-scope', 'bogus'], match: /must be user \| project \| workspace/u },
    { argv: ['clients', 'install', 'claude-code', ...INSTALL_GRANT, '--nope'], match: /does not accept/u },
    { argv: ['clients', 'restore', 'claude-code', '--granted-by', 'A', '--statement', 'S', '--scope', 'restore'], match: /requires --backup-id/u },
    { argv: ['clients', 'plan', '--nope'], match: /does not accept/u },
    { argv: ['audit', 'security', '--online'], match: /requires --confirm/u },
    { argv: ['rebuild', 'nope'], match: /supports only/u },
    { argv: ['connect', '--expected-digest', 'xyz'], match: /64-character sha256/u },
    { argv: ['connect', 'cutover', 'confirm', '--confirm'], match: /requires --name/u },
    { argv: ['connect', 'cutover', 'nope'], match: /supports: status \| confirm/u },
    { argv: ['connect', 'ui', '--port', '70000'], match: /between 0 and 65535/u },
    { argv: ['connect', 'watch', '--interval', '1'], match: /at least/u },
    { argv: ['connect', 'watch', '--max-cycles', '0'], match: /positive integer/u },
    { argv: ['connect', 'nope'], match: /supports: plan/u },
    { argv: ['baseline', 'verify', 'abc'], match: /positive integer/u },
    { argv: ['baseline', 'approve', '1'], match: /requires --name/u },
    { argv: ['sync'], match: /not implemented in P7/u },
    { argv: ['push'], match: /not implemented in P7/u },
    { argv: ['attest'], match: /not implemented in P7/u },
    { argv: ['release'], match: /not implemented in P7/u },
    { argv: ['frobnicate'], match: /not implemented in the P7 slice/u },
  ];

  for (const item of cases) {
    const result = await runCli([...item.argv, '--root', root]);
    assert.equal(result.code, 2, `${item.argv.join(' ')} expected exit 2`);
    assert.match(result.output, item.match, `${item.argv.join(' ')} output: ${result.output}`);
    assert.equal(result.output.length > 0, true);
  }

  // 无 scope 的 audit 在触碰项目扫描之前就被拒绝。
  const missingScope = await runCli(['audit']);
  assert.equal(missingScope.code, 2);
  assert.match(missingScope.output, /requires a scope/u);
});

test('T-153 clients install/restore 文本渲染、dry-run 退出码与幂等', async (t) => {
  const root = rootFor(t);
  writeFileSync(join(root, '.mcp.json'), '{}\n');

  const dryRun = await runCli(['clients', 'install', 'claude-code', ...INSTALL_GRANT, '--dry-run', '--root', root]);
  assert.equal(dryRun.code, 0);
  assert.match(dryRun.output, /ano client install/u);
  assert.match(dryRun.output, /action: dry-run/u);

  const implicitDryRun = await runCli(['clients', 'install', 'claude-code', ...INSTALL_GRANT, '--root', root]);
  assert.equal(implicitDryRun.code, 1, 'a silent dry-run is reported as exit 1');
  assert.match(implicitDryRun.output, /applied: false/u);

  const appliedJson = await runCli(['clients', 'install', 'claude-code', ...INSTALL_GRANT, '--confirm', '--json', '--root', root]);
  assert.equal(appliedJson.code, 0);
  const appliedResult = JSON.parse(appliedJson.output) as { action: string; backupId: string | null };
  assert.equal(appliedResult.action, 'installed');
  assert.equal(typeof appliedResult.backupId, 'string');

  const restored = await runCli([
    'clients',
    'restore',
    'claude-code',
    '--backup-id',
    appliedResult.backupId ?? '',
    '--granted-by',
    'Alice',
    '--statement',
    'restore verified backup',
    '--scope',
    'restore',
    '--confirm',
    '--root',
    root,
  ]);
  assert.equal(restored.code, 0);
  assert.match(restored.output, /ano client restore/u);
  assert.match(restored.output, /applied: true/u);
  assert.match(restored.output, /changed: true/u);

  const reinstalled = await runCli(['clients', 'install', 'claude-code', ...INSTALL_GRANT, '--confirm', '--root', root]);
  assert.equal(reinstalled.code, 0);
  assert.match(reinstalled.output, /action: installed/u);
  assert.match(reinstalled.output, /applied: true/u);
});

test('T-153 doctor/clients plan 只读路径携带 home/env/probe-path 且输出合法 JSON', async (t) => {
  const root = rootFor(t);

  const report = await runCli(['doctor', 'clients', '--home', root, '--env', 'ANO_TEST=1', '--probe-path', root, '--json', '--root', root]);
  assert.equal(report.code, 0);
  const parsed = JSON.parse(report.output) as { schema: string; clients: unknown[] };
  assert.equal(parsed.schema, 'ano.client-doctor-report/1');
  assert.ok(parsed.clients.length > 0);

  const plan = await runCli(['clients', 'plan', '--json', '--root', root]);
  assert.equal(plan.code, 0);
  const accessPlan = JSON.parse(plan.output) as { schema: string; clients: unknown[] };
  assert.equal(accessPlan.schema, 'ano.client-access-plan/1');
  assert.ok(accessPlan.clients.length > 0);
});

test('T-153 CLI 成功路径：task/takeover/recall/note/rebuild/export/doctor/clients plan 真实渲染', async (t) => {
  const root = rootFor(t);
  initGitProject(root);

  const created = await runCli(['track', 'create', '--id', 'T1', '--title', 'demo', '--file', 'test/a.test.ts', '--root', root]);
  assert.equal(created.code, 0, created.output);
  const updated = await runCli(['track', 'update', '--id', 'T1', '--status', 'todo', '--root', root]);
  assert.equal(updated.code, 0, updated.output);

  const granted = await runCli(['takeover', 'grant', '--scope', 'tasks', '--granted-by', 'Alice', '--role', 'owner', '--statement', 'grant tasks', '--root', root]);
  assert.equal(granted.code, 0, granted.output);
  const takeoverStatus = await runCli(['takeover', 'status', '--root', root]);
  assert.equal(takeoverStatus.code, 0, takeoverStatus.output);
  const takeoverState = JSON.parse(takeoverStatus.output) as { state: string };
  assert.equal(takeoverState.state, 'disabled', 'grant alone must not become enforced');

  const recalled = await runCli(['recall', '--session', 's1', '--root', root]);
  assert.equal(recalled.code, 0, recalled.output);
  const noted = await runCli(['note', 'decision', '--text', 'hello world', '--file', 'test/a.test.ts', '--root', root]);
  assert.equal(noted.code, 0, noted.output);

  const rebuilt = await runCli(['rebuild', 'graph', '--root', root]);
  assert.equal(rebuilt.code, 0, rebuilt.output);
  const exported = await runCli(['export', '--root', root]);
  assert.equal(exported.code, 0, exported.output);

  const doctorText = await runCli(['doctor', 'clients', '--home', root, '--probe-path', join(root, 'test'), '--root', root]);
  assert.equal(doctorText.code, 0, doctorText.output);
  assert.match(doctorText.output, /ano client doctor report/u);

  const single = await runCli(['doctor', 'client', 'claude-code', '--home', root, '--probe-path', join(root, 'test'), '--root', root]);
  assert.equal(single.code, 0, single.output);
  assert.match(single.output, /public sources:/u);

  const planText = await runCli(['clients', 'plan', '--root', root]);
  assert.equal(planText.code, 0, planText.output);
  assert.match(planText.output, /ano client access plan/u);
});
