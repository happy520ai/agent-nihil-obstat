import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Ledger } from '../../src/ledger/ledger.ts';
import { replayLedger } from '../../src/ledger/replay.ts';
import { brief, trackTaskUpdate, verifySurface } from '../../src/surface/service.ts';
import { noteSurface } from '../../src/surface/memory.ts';

function git(root: string, args: readonly string[]): void {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

async function fixture(t: TestContext): Promise<{ root: string; hook: (session: string, event: 'session-start' | 'stop') => Record<string, unknown> }> {
  const root = await mkdtemp(join(tmpdir(), 'ano-three-sessions-'));
  const scripts = await mkdtemp(join(tmpdir(), 'ano-three-sessions-scripts-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(scripts, { recursive: true, force: true }); });
  for (const [path, content] of Object.entries({
    '.gitignore': '.ano/\n',
    'package.json': JSON.stringify({ name: 'three-session-fixture', private: true, type: 'module' }),
    'src/index.ts': 'export const answer = 41;\n',
    'test/a.test.ts': "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { answer } from '../src/index.ts';\ntest('answer', () => assert.equal(answer, 42));\n",
  })) {
    const absolute = join(root, ...path.split('/'));
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'ano@localhost'], ['config', 'user.name', 'ano'], ['add', '.'], ['commit', '-qm', 'base']]) git(root, args);

  const runner = join(scripts, 'hook.mjs');
  await writeFile(runner, `
import { Ledger } from ${JSON.stringify(new URL('../../src/ledger/ledger.ts', import.meta.url).href)};
import { onSessionStart, onStop } from ${JSON.stringify(new URL('../../src/hooks/session.ts', import.meta.url).href)};
import { parseZcodeStdin, renderZcodeDecision } from ${JSON.stringify(new URL('../../src/hooks/adapters/zcode.ts', import.meta.url).href)};
const input = parseZcodeStdin(process.argv[4]);
const ledger = await Ledger.open(process.argv[2]);
try {
  const result = input.event === 'session-start' ? await onSessionStart(input, { ledger, mode: 'advisory' }) : await onStop(input, { ledger, mode: 'advisory' });
  const rendered = renderZcodeDecision(result.decision, input.event);
  process.stdout.write(rendered.stdout);
} finally { ledger.close(); }
`);
  return {
    root,
    hook(session, event) {
      const input = JSON.stringify({ hook_event_name: event === 'session-start' ? 'SessionStart' : 'Stop', session_id: session, cwd: root, stop_hook_active: event === 'stop' });
      const child = spawnSync(process.execPath, [runner, root, event, input], { encoding: 'utf8', cwd: root, windowsHide: true });
      assert.equal(child.status, 0, child.stderr || child.stdout);
      return JSON.parse(child.stdout) as Record<string, unknown>;
    },
  };
}

test('three real sessions carry C2 forward, clear it with checkpoint, and finish with Gate evidence', async (t) => {
  const { root, hook } = await fixture(t);
  const ledger = await Ledger.open(root);
  try {
    await ledger.createTask('T-CONT', ['src/index.ts', 'test/a.test.ts'], '三会话连续性');
    await ledger.updateTask('T-CONT', { status: 'in_progress' });
  } finally { ledger.close(); }

  // Session 1: a real child hook observes an owned edit but no checkpoint.
  hook('S-1', 'session-start');
  await writeFile(join(root, 'src', 'index.ts'), 'export const answer = 42;\n');
  hook('S-1', 'stop');
  const firstNotes = replayLedger(join(root, '.ano', 'ledger')).entries
    .map((entry) => entry.event)
    .filter((event) => event.kind === 'note.recorded');
  const firstSummary = JSON.parse(String((firstNotes.at(-1)!.payload as Record<string, unknown>)['text'])) as { unmet_checks: string[] };
  assert.ok(firstSummary.unmet_checks.includes('C2:T-CONT'));

  // Session 2: compact context contains the old C2; a real checkpoint resolves it.
  const secondStart = hook('S-2', 'session-start');
  const context = String((secondStart['hookSpecificOutput'] as Record<string, unknown>)['additionalContext']);
  assert.match(context, /ANO brief/u);
  assert.match(context, /C2:T-CONT/u);
  const checkpointLedger = await Ledger.open(root);
  try {
    await noteSurface(checkpointLedger, {
      kind: 'memory', text: 'T-CONT checkpoint 下一步：执行真实 verify 并 complete',
      anchor: { file: 'src/index.ts' }, idem_key: 'three-session:checkpoint',
    });
  } finally { checkpointLedger.close(); }
  hook('S-2', 'stop');

  // Session 3: verification and completion use the production Gate path.
  hook('S-3', 'session-start');
  const verified = await verifySurface(root, {
    task_id: 'T-CONT', argv: [process.execPath, '--test', 'test/a.test.ts'],
    test_files: ['test/a.test.ts'], idem_key: 'three-session:verify',
  });
  const verdict = verified['verdict'] as { status: string; evidenceId: string };
  assert.equal(verdict.status, 'done');
  const completed = await trackTaskUpdate(root, { operation: 'complete', id: 'T-CONT', evidence_id: verdict.evidenceId }, 'three-session:complete');
  assert.equal((completed['task'] as { status: string }).status, 'done');
  hook('S-3', 'stop');

  const finalBrief = await brief(root);
  const sessions = finalBrief['last_sessions'] as { unmet_checks: unknown[]; recent: unknown[] };
  assert.deepEqual(sessions.unmet_checks, [], 'checkpoint and later completion remove the inherited C2');
  assert.equal(sessions.recent.length, 3);
});
