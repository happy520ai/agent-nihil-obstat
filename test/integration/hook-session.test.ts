import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import {
  type HookInput,
  hookDecisionSchema,
} from '../../src/hooks/contract.ts';
import { onSessionStart, onStop, type SessionEngineContext } from '../../src/hooks/session.ts';
import { Ledger } from '../../src/ledger/ledger.ts';
import { replayLedger } from '../../src/ledger/replay.ts';
import { initViews } from '../../src/ledger/views.ts';
import { ledgerEventKinds } from '../../src/ledger/event.ts';

/**
 * T-165 / ADR-013 §4.2、§4.4、§5 集成验收：
 * 真实 git 工作树 + 真实 SQLite 账本 + 真实子进程。
 *
 * 覆盖实施规格 T-165 的四条硬断言：
 * 1. 改了无归属文件 → continue，列出该文件；
 * 2. 第 3 次 stop → 一定 stop-ok；
 * 3. 同一 host_session_id 重放 session-start → 账本只有 1 条事件；
 * 4. 会话中途被杀 → 下一次 session-start 检出上一会话未关闭。
 * 另附：C1–C4 确定性、stopContinuation 尊重、非 Git 根降级与事件 kind 只增不改。
 */

function git(root: string, args: readonly string[]): void {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr ?? result.stdout}`);
}

async function project(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ano-hook-session-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  for (const [path, content] of Object.entries({
    '.gitignore': '.ano/\\n',
    'package.json': JSON.stringify({ name: 'hook-session-fixture', private: true }, null, 2),
    'src/existing.ts': 'export const existing = 1;\n',
  })) {
    const absolute = join(root, ...path.split('/'));
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'ano@localhost'], ['config', 'user.name', 'ano'], ['add', '.'], ['commit', '-qm', 'base']]) git(root, args);
  return root;
}

function ctx(ledger: Ledger, mode: 'advisory' | 'strict' = 'advisory'): SessionEngineContext {
  return { ledger, mode };
}

function input(hostSessionId: string, event: HookInput['event'], cwd: string, extra: Partial<HookInput> = {}): HookInput {
  return { event, client: 'zcode', hostSessionId, cwd, ...extra };
}

function eventsOf(root: string, kind?: string) {
  const all = replayLedger(join(root, '.ano', 'ledger')).entries.map((entry) => entry.event);
  return kind === undefined ? all : all.filter((event) => event.kind === kind);
}

// ---------------------------------------------------------------------------
// 1. 无归属改动 → continue，列出该文件
// ---------------------------------------------------------------------------
test('C1: unowned source change triggers continue and names the file', async (t) => {
  const root = await project(t);
  const ledger = await Ledger.open(root);
  try {
    await onSessionStart(input('S-C1', 'session-start', root), ctx(ledger));
    await writeFile(join(root, 'src', 'rogue.ts'), 'export const rogue = 1;\n');

    const stop = await onStop(input('S-C1', 'stop', root), ctx(ledger));
    assert.equal(stop.decision.kind, 'continue');
    const c1 = stop.checks.find((check) => check.id === 'C1')!;
    assert.equal(c1.ok, false);
    assert.deepEqual(c1.items, ['src/rogue.ts']);
    assert.match(stop.decision.checklist.join('\n'), /src\/rogue\.ts/u);
    assert.equal(hookDecisionSchema.safeParse(stop.decision).success, true, '决定符合统一契约 schema');

    // session.stop_checked 落到真实账本，含 C1 失败与 decision=continue。
    const recorded = eventsOf(root, 'session.stop_checked');
    assert.equal(recorded.length, 1);
    assert.equal((recorded[0]!.payload as Record<string, unknown>)['decision'], 'continue');
  } finally { ledger.close(); }
});

// ---------------------------------------------------------------------------
// 2. 第 3 次 stop 一定 stop-ok（最多 2 次 continue）
// ---------------------------------------------------------------------------
test('third consecutive stop is always stop-ok (max 2 continuations)', async (t) => {
  const root = await project(t);
  const ledger = await Ledger.open(root);
  try {
    await onSessionStart(input('S-3', 'session-start', root), ctx(ledger));
    await writeFile(join(root, 'src', 'rogue.ts'), 'export const rogue = 1;\n');

    const first = await onStop(input('S-3', 'stop', root), ctx(ledger));
    const second = await onStop(input('S-3', 'stop', root), ctx(ledger));
    const third = await onStop(input('S-3', 'stop', root), ctx(ledger));
    assert.equal(first.decision.kind, 'continue');
    assert.equal(first.continuationsUsed, 1);
    assert.equal(second.decision.kind, 'continue');
    assert.equal(second.continuationsUsed, 2);
    assert.equal(third.decision.kind, 'stop-ok', '第 3 次必须 stop-ok，留 1 次宿主余量');
    assert.equal(third.continuationsUsed, 2);

    const checks = eventsOf(root, 'session.stop_checked');
    assert.equal(checks.length, 3);
    assert.deepEqual(checks.map((event) => (event.payload as Record<string, unknown>)['seq']), [1, 2, 3]);
    // 未满足项写入最后一条 stop_checked 与决定 checklist，供下次 session-start 置顶。
    const last = checks[2]!.payload as Record<string, unknown>;
    assert.equal(last['decision'], 'stop-ok');
  } finally { ledger.close(); }
});

// ---------------------------------------------------------------------------
// 3. 同一 host_session_id 重放 session-start → 账本只有 1 条事件
// ---------------------------------------------------------------------------
test('replaying session-start for the same host_session_id writes exactly one event', async (t) => {
  const root = await project(t);
  const ledger = await Ledger.open(root);
  try {
    const first = await onSessionStart(input('S-REPLAY', 'session-start', root), ctx(ledger));
    const second = await onSessionStart(input('S-REPLAY', 'session-start', root), ctx(ledger));
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(first.event.id, second.event.id, '幂等重放返回同一事件');

    const started = eventsOf(root, 'session.started');
    assert.equal(started.length, 1);
    assert.equal((started[0]!.payload as Record<string, unknown>)['host_session_id'], 'S-REPLAY');
    // SQLite 视图与 JSONL 段一致：真实账本，不是内存桩。
    const db = new DatabaseSync(join(root, '.ano', 'cache', 'views.db'));
    try {
      initViews(db);
      const count = (db.prepare('SELECT COUNT(*) AS n FROM idempotency WHERE idem_key = ?').get('session-start:S-REPLAY') as { n: number }).n;
      assert.equal(count, 1);
    } finally { db.close(); }
  } finally { ledger.close(); }
});

// ---------------------------------------------------------------------------
// 4. 会话中途被杀 → 下一次 session-start 检出上一会话未关闭
// ---------------------------------------------------------------------------
test('killed session is detected as unclosed on the next session-start', async (t) => {
  const root = await project(t);
  const ledger = await Ledger.open(root);
  try {
    // 会话 1：只写 session.started，没有 stop 摘要（模拟中途被强杀）。
    await onSessionStart(input('S-KILLED', 'session-start', root), ctx(ledger));
  } finally { ledger.close(); }

  // 会话 2：新的 host_session_id，应检出上一会话未关闭。
  const ledger2 = await Ledger.open(root);
  try {
    const next = await onSessionStart(input('S-NEXT', 'session-start', root), ctx(ledger2));
    assert.equal(next.previousSessionUnclosed, 'S-KILLED');
    assert.equal((next.event.payload as Record<string, unknown>)['previous_session_unclosed'], 'S-KILLED');
    assert.equal(next.decision.kind, 'context');
    assert.match(next.decision.additionalContext, /S-KILLED/u, '最小 brief 投影置顶显示未关闭会话');
    // T-169 合入后必须补写且仅补写一条 interrupted=true 机械摘要。
    const summaries = eventsOf(root, 'note.recorded');
    assert.equal(summaries.length, 1);
    const summary = JSON.parse(String(summaries[0]?.payload['text'])) as Record<string, unknown>;
    assert.equal(summary['host_session_id'], 'S-KILLED');
    assert.equal(summary['interrupted'], true);
  } finally { ledger2.close(); }
});

// ---------------------------------------------------------------------------
// 5. C2/C3/C4 确定性与 stopContinuation
// ---------------------------------------------------------------------------
test('C2/C3/C4 are deterministic and stopContinuation forces stop-ok', async (t) => {
  const root = await project(t);
  const ledger = await Ledger.open(root);
  try {
    // 基线：建 in_progress 任务，声明该文件（C1 有归属）。
    await ledger.createTask('T-C2', ['src/existing.ts'], '待办任务');
    await ledger.updateTask('T-C2', { status: 'in_progress' });
    await onSessionStart(input('S-C2', 'session-start', root), ctx(ledger));
    await writeFile(join(root, 'src', 'existing.ts'), 'export const existing = 2;\n');

    const stop = await onStop(input('S-C2', 'stop', root), ctx(ledger));
    assert.equal(stop.checks.find((check) => check.id === 'C1')!.ok, true, '已归属文件不触发 C1');
    assert.equal(stop.checks.find((check) => check.id === 'C2')!.ok, false, 'in_progress 无 checkpoint 触发 C2');
    assert.equal(stop.decision.kind, 'continue');
    assert.match(stop.decision.checklist.join('\n'), /C2/u);

    // 宿主已在 stop 继续中 → 即使有未满足项也不再 continue。
    const cont = await onStop(input('S-C2', 'stop', root, { stopContinuation: true }), ctx(ledger));
    assert.equal(cont.decision.kind, 'stop-ok');
  } finally { ledger.close(); }
});

// ---------------------------------------------------------------------------
// 6. 非 Git 根降级：NOT_GIT_ROOT 跳过 C1，其余照常
// ---------------------------------------------------------------------------
test('non-git root degrades with NOT_GIT_ROOT and skips C1 only', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ano-hook-session-nogit-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  // 确保不在任何 git 仓库内（os.tmpdir 通常不是 git 仓库）。
  const ledger = await Ledger.open(root);
  try {
    const started = await onSessionStart(input('S-NOGIT', 'session-start', root), ctx(ledger));
    assert.equal(started.degraded?.code, 'NOT_GIT_ROOT');
    assert.equal((started.event.payload as Record<string, unknown>)['head_commit'], null);

    const stop = await onStop(input('S-NOGIT', 'stop', root), ctx(ledger));
    assert.equal(stop.degraded?.code, 'NOT_GIT_ROOT');
    assert.equal(stop.checks.find((check) => check.id === 'C1')!.ok, true, 'C1 被跳过，不虚假 continue');
    assert.equal(stop.decision.kind, 'stop-ok');
  } finally { ledger.close(); }
});

// ---------------------------------------------------------------------------
// 7. 事件 kind 只增不改：旧 kind 索引不变，新 kind 在尾部
// ---------------------------------------------------------------------------
test('session event kinds are appended at the tail without changing existing kinds', () => {
  const legacy = [
    'segment.started', 'task.created', 'task.updated', 'evidence.recorded', 'verify.started', 'verify.finished',
    'run.lease.acquired', 'run.lease.heartbeat', 'run.lease.reclaimed', 'run.lease.released', 'migration.recorded',
    'note.recorded', 'audit.finding', 'audit.completed', 'readiness.evidence', 'readiness.attestation',
    'release.verdict', 'release.approved', 'memory.revised', 'memory.related', 'memory.conflict.resolved',
    'structure.queried',
  ];
  assert.deepEqual([...ledgerEventKinds].slice(0, legacy.length), legacy);
  assert.deepEqual([...ledgerEventKinds].slice(legacy.length), ['session.started', 'session.stop_checked']);
});

// ---------------------------------------------------------------------------
// 8. 真实子进程：ZCode stdin → 映射 → 引擎 → 渲染 stdout（S8 格式）
// ---------------------------------------------------------------------------
test('child process drives SessionStart/Stop through adapters, real git and SQLite', async (t) => {
  const root = await project(t);
  // 子进程脚本写在独立临时目录（scripts/），与 git 夹具（project/）分目录，
  // 避免解释器从脚本目录加载被植入的模块（环境隔离要求）。
  const scriptsDir = await mkdtemp(join(tmpdir(), 'ano-hook-session-scripts-'));
  t.after(async () => { await rm(scriptsDir, { recursive: true, force: true }); });
  const childRunner = join(scriptsDir, 'runner.mjs');
  const script = `
import { spawnSync } from 'node:child_process';
import { Ledger } from ${JSON.stringify(new URL('../../src/ledger/ledger.ts', import.meta.url).href)};
import { onSessionStart, onStop } from ${JSON.stringify(new URL('../../src/hooks/session.ts', import.meta.url).href)};
import { parseZcodeStdin, renderZcodeDecision } from ${JSON.stringify(new URL('../../src/hooks/adapters/zcode.ts', import.meta.url).href)};
const root = process.argv[2];
const event = process.argv[3];
const stdin = await new Promise((resolveText) => {
  let text = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { text += chunk; });
  process.stdin.on('end', () => resolveText(text));
});
const input = parseZcodeStdin(stdin);
const ledger = await Ledger.open(root);
try {
  const ctx = { ledger, mode: 'advisory' };
  const result = input.event === 'session-start' ? await onSessionStart(input, ctx) : await onStop(input, ctx);
  const rendered = renderZcodeDecision(result.decision, input.event);
  process.stdout.write(JSON.stringify({ stdout: rendered.stdout, exitCode: rendered.exitCode, decision: result.decision.kind, event: result.event.kind }));
} finally { ledger.close(); }
`;
  await writeFile(childRunner, script);

  const stdin = JSON.stringify({
    hook_event_name: 'SessionStart', session_id: 'S-CHILD', cwd: root,
    source: 'startup', permission_mode: 'default',
  });
  const start = spawnSync(process.execPath, [childRunner, root, 'session-start'], { input: stdin, encoding: 'utf8' });
  assert.equal(start.status, 0, start.stderr);
  const startOut = JSON.parse(start.stdout) as { decision: string; event: string; stdout: string };
  assert.equal(startOut.decision, 'context');
  assert.equal(startOut.event, 'session.started');
  const rendered = JSON.parse(startOut.stdout.trim()) as { hookSpecificOutput?: { hookEventName?: string; additionalContext?: string } };
  assert.equal(rendered.hookSpecificOutput?.hookEventName, 'SessionStart');
  assert.match(rendered.hookSpecificOutput?.additionalContext ?? '', /ANO brief/u, 'S8 Q5 additionalContext 格式');

  await writeFile(join(root, 'src', 'rogue.ts'), 'export const rogue = 1;\n');
  const stopStdin = JSON.stringify({
    hook_event_name: 'Stop', session_id: 'S-CHILD', cwd: root, stop_hook_active: false,
  });
  const stop = spawnSync(process.execPath, [childRunner, root, 'stop'], { input: stopStdin, encoding: 'utf8' });
  assert.equal(stop.status, 0, stop.stderr);
  const stopOut = JSON.parse(stop.stdout) as { decision: string; event: string; stdout: string };
  assert.equal(stopOut.decision, 'continue');
  assert.equal(stopOut.event, 'session.stop_checked');
  const stopRendered = JSON.parse(stopOut.stdout.trim()) as { decision?: string; systemMessage?: string };
  assert.equal(stopRendered.decision, 'block', 'S8 Q6：continue 必须以 decision:block + systemMessage 渲染');
  assert.match(stopRendered.systemMessage ?? '', /src\/rogue\.ts/u);

  const ledger = await Ledger.open(root);
  try {
    assert.equal(eventsOf(root, 'session.started').length, 1);
    assert.equal(eventsOf(root, 'session.stop_checked').length, 1);
  } finally { ledger.close(); }
});
