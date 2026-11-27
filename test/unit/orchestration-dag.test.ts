import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { accepted, completionTaskHash, emptyRuntime, schedule, taskPrompt, validatePlan, type OrchestrationPlan, type TaskSnapshot } from '../../scripts/orchestration/dag.ts';
import { JsonStateStore } from '../../scripts/orchestration/store.ts';

function task(id: string, status: TaskSnapshot['status'] = 'backlog'): TaskSnapshot {
  return { id, title: id, detail: `details ${id}`, status, files: [], steps: [], acceptance: 'verified', result_note: status === 'done' ? 'implemented' : '', verification: status === 'done' ? 'quality-current.json' : '' };
}

function plan(dependencies: Record<string, string[]>): OrchestrationPlan {
  return { schema_version: 1, milestone: 'M8', description: 'test', tasks: Object.fromEntries(Object.entries(dependencies).map(([id, depends_on]) => [id, { depends_on }])) };
}

function accept(runtime: ReturnType<typeof emptyRuntime>, id: string): void {
  runtime.completed[id] = { acceptance_verified: true, verified_at: '2026-11-21T00:00:00.000Z', verification: 'quality-current.json', task_sha256: completionTaskHash(task(id, 'done')) };
}

test('DAG blocks dependencies until controller accepts both PM completion and evidence', () => {
  const tasks = [task('A'), task('B'), task('C')];
  const dag = plan({ A: [], B: ['A'], C: ['B'] });
  const runtime = emptyRuntime();
  assert.equal(schedule({ tasks, plan: dag, runtime, sessions: [], now: 1, maxConcurrency: 2 }).find(a => a.kind === 'dispatch')?.kind, 'dispatch');
  assert.ok(schedule({ tasks, plan: dag, runtime, sessions: [], now: 1, maxConcurrency: 2 }).some(a => a.kind === 'blocked' && a.task_id === 'B'));
  tasks[0] = task('A', 'done');
  assert.ok(schedule({ tasks, plan: dag, runtime, sessions: [], now: 1, maxConcurrency: 2 }).some(a => a.kind === 'verify' && a.task_id === 'A'));
  assert.ok(!schedule({ tasks, plan: dag, runtime, sessions: [], now: 1, maxConcurrency: 2 }).some(a => a.kind === 'dispatch' && a.task_id === 'B'));
  accept(runtime, 'A');
  assert.ok(schedule({ tasks, plan: dag, runtime, sessions: [], now: 1, maxConcurrency: 2 }).some(a => a.kind === 'dispatch' && a.task_id === 'B'));
});

test('DAG rejects missing tasks, missing dependencies and cycles', () => {
  assert.throws(() => validatePlan(plan({ A: ['B'] }), [task('A')]), /unknown dependency/);
  assert.throws(() => validatePlan(plan({ A: ['A'] }), [task('A')]), /depends on itself/);
  assert.throws(() => validatePlan(plan({ A: ['B'], B: ['A'] }), [task('A'), task('B')]), /cycle/);
});

test('Existing session is adopted once; active session is never duplicated', () => {
  const dag = plan({ A: [] });
  dag.tasks.A!.session_id = 'sess-existing';
  const runtime = emptyRuntime();
  const adopted = schedule({ tasks: [task('A', 'todo')], plan: dag, runtime, sessions: [{ session_id: 'sess-existing', state: 'idle' }], now: 1, maxConcurrency: 2 });
  assert.deepEqual(adopted.map(a => a.kind), ['adopt']);
  runtime.leases.A = { task_id: 'A', lease_id: 'one', session_id: 'sess-existing', attempt: 1, acquired_at: 0, heartbeat_at: 1 };
  const active = schedule({ tasks: [task('A', 'in_progress')], plan: dag, runtime, sessions: [{ session_id: 'sess-existing', state: 'running' }], now: 2, maxConcurrency: 2 });
  assert.deepEqual(active.map(a => a.kind), ['wait']);
});

test('Missing session yields recovery with original task identity, not a new task', () => {
  const dag = plan({ A: [] });
  dag.tasks.A!.session_id = 'sess-gone';
  const runtime = emptyRuntime();
  const actions = schedule({ tasks: [task('A', 'in_progress')], plan: dag, runtime, sessions: [{ session_id: 'sess-gone', state: 'missing' }], now: 100, maxConcurrency: 2 });
  assert.equal(actions[0]?.kind, 'recover');
  assert.match(taskPrompt(task('A'), true), /断点恢复/);
  assert.match(taskPrompt(task('A'), true), /显式传 status/);
});

test('Attention and cancellation never release dependents', () => {
  const dag = plan({ A: [], B: ['A'] });
  const runtime = emptyRuntime();
  runtime.leases.A = { task_id: 'A', lease_id: 'one', session_id: 'sess-a', attempt: 1, acquired_at: 0, heartbeat_at: 1 };
  const tasks = [task('A', 'in_progress'), task('B')];
  const actions = schedule({ tasks, plan: dag, runtime, sessions: [{ session_id: 'sess-a', state: 'needs_attention' }], now: 2, maxConcurrency: 2 });
  assert.equal(actions[0]?.kind, 'attention');
  assert.equal(actions[1]?.kind, 'blocked');
});

test('Concurrency and integration mutex prevent overlapping dispatch', () => {
  const dag = plan({ A: [], B: [], C: [], D: [] });
  dag.tasks.A!.mutex_group = 'integration';
  dag.tasks.C!.mutex_group = 'integration';
  const actions = schedule({ tasks: [task('A', 'todo'), task('B', 'todo'), task('C', 'todo'), task('D', 'todo')], plan: dag, runtime: emptyRuntime(), sessions: [], now: 1, maxConcurrency: 2 });
  assert.deepEqual(actions.map(a => [a.kind, a.task_id]), [['dispatch', 'A'], ['blocked', 'B'], ['blocked', 'C'], ['blocked', 'D']]);
  const concurrent = schedule({ tasks: [task('A', 'done'), task('B', 'todo'), task('C', 'done'), task('D', 'todo')], plan: dag, runtime: emptyRuntime(), sessions: [], now: 1, maxConcurrency: 2 });
  assert.deepEqual(concurrent.filter(a => a.kind !== 'verify').map(a => [a.kind, a.task_id]), [['dispatch', 'B'], ['dispatch', 'D']]);
});

test('Persistent state claims are fenced and survived restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ano-dag-'));
  try {
    const store = new JsonStateStore(join(dir, 'nested', 'state.json'));
    const first = store.claim(task('A', 'todo'), undefined, 10);
    const duplicate = store.claim(task('A', 'todo'), undefined, 11);
    assert.equal(first.acquired, true);
    assert.equal(duplicate.acquired, false);
    assert.equal(duplicate.lease.lease_id, first.lease.lease_id);
    store.bind('A', first.lease.lease_id, 'sess-a');
    assert.throws(() => store.bind('A', 'stale-lease', 'sess-other'), /fence/);
    const restarted = new JsonStateStore(store.path);
    assert.equal(restarted.read().leases.A?.session_id, 'sess-a');
    assert.equal(restarted.claim(task('A', 'in_progress'), 'sess-a', 20, true).acquired, true);
    assert.equal(restarted.claim(task('A', 'in_progress'), 'sess-other', 21, true).acquired, false);
    const recovered = restarted.claim(task('A', 'in_progress'), undefined, 100 + 30 * 60_000);
    assert.equal(recovered.acquired, false);
    store.release('A', first.lease.lease_id);
    const retry = restarted.claim(task('A', 'todo'), undefined, 200 + 30 * 60_000);
    assert.equal(retry.acquired, true);
    assert.equal(retry.lease.attempt, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Invalid persisted state fails closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ano-dag-'));
  try {
    const path = join(dir, 'state.json');
    writeFileSync(path, '{"schema_version":1,"revision":0}');
    assert.throws(() => new JsonStateStore(path).read(), /Invalid/);
    assert.equal(readFileSync(path, 'utf8'), '{"schema_version":1,"revision":0}');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Accepted requires explicit controller attestation, not status alone', () => {
  const runtime = emptyRuntime();
  assert.equal(accepted(task('A', 'done'), runtime), false);
  accept(runtime, 'A');
  assert.equal(accepted(task('A', 'done'), runtime), true);
  assert.equal(accepted({ ...task('A', 'done'), verification: '' }, runtime), false);
});

test('schedule() is milestone-agnostic: M8-shaped and M10-shaped plans take the same path', () => {
  const build = (milestone: string, gate: string, group: string): OrchestrationPlan => ({
    schema_version: 1,
    milestone,
    description: `${milestone} plan`,
    tasks: {
      ROOT: { depends_on: [] },
      GATE: { depends_on: [], gate, mutex_group: group },
      DOWN: { depends_on: ['ROOT'], gate },
    },
  });
  for (const [milestone, gate, group] of [['M8', 'phase-p0', 'p0-integration'], ['M10', 'phase-takeover', 'm10-integration']] as const) {
    const plan = build(milestone, gate, group);
    const runtime = emptyRuntime();
    const actions = schedule({ tasks: [task('ROOT'), task('GATE'), task('DOWN')], plan, runtime, sessions: [], now: 1, maxConcurrency: 4 });
    const byTask = Object.fromEntries(actions.map(action => [action.task_id, action.kind]));
    assert.equal(byTask.ROOT, 'dispatch');
    assert.equal(byTask.GATE, 'blocked');
    assert.equal(byTask.DOWN, 'blocked');
    accept(runtime, 'ROOT');
    const integration = schedule({ tasks: [task('ROOT', 'done'), task('GATE'), task('DOWN')], plan, runtime, sessions: [], now: 2, maxConcurrency: 4 });
    assert.equal(integration.find(action => action.task_id === 'GATE')?.kind, 'dispatch');
    accept(runtime, 'GATE');
    runtime.gates[gate] = { passed: true, verified_at: '2026-11-22T00:00:00.000Z', verification: 'quality.json' };
    const opened = schedule({ tasks: [task('ROOT', 'done'), task('GATE', 'done'), task('DOWN')], plan, runtime, sessions: [], now: 2, maxConcurrency: 4 });
    assert.equal(opened.find(action => action.task_id === 'DOWN')?.kind, 'dispatch');
  }
});
