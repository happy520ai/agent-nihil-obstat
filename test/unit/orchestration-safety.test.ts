import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { accepted, emptyRuntime, schedule, validatePlan, type OrchestrationPlan, type RuntimeState, type TaskSnapshot } from '../../scripts/orchestration/dag.ts';
import { JsonStateStore } from '../../scripts/orchestration/store.ts';

function task(id: string, status: TaskSnapshot['status'] = 'todo'): TaskSnapshot {
  return { id, status, title: id, detail: '', files: [], steps: [], acceptance: 'tested', result_note: status === 'done' ? 'implemented' : '', verification: status === 'done' ? 'quality.json' : '' };
}

function plan(deps: Record<string, string[]>): OrchestrationPlan {
  return { schema_version: 1, milestone: 'test', description: '', tasks: Object.fromEntries(Object.entries(deps).map(([id, depends_on]) => [id, { depends_on }])) };
}

function actions(tasks: TaskSnapshot[], dag: OrchestrationPlan, runtime = emptyRuntime(), sessions: Parameters<typeof schedule>[0]['sessions'] = [], maxConcurrency = 4) {
  return schedule({ tasks, plan: dag, runtime, sessions, now: 2_000_000, maxConcurrency });
}

test('Recovery checks dependencies and phase gates before suggesting a resume', () => {
  const dag = plan({ A: [], B: ['A'] });
  dag.tasks.B!.session_id = 'sess-b';
  assert.equal(actions([task('A'), task('B', 'in_progress')], dag).find(a => a.task_id === 'B')?.kind, 'blocked');
  const gated = plan({ G: [], B: [] });
  gated.tasks.G = { depends_on: [], gate: 'phase', mutex_group: 'integration' };
  gated.tasks.B = { depends_on: [], gate: 'phase', session_id: 'sess-b' };
  assert.equal(actions([task('G', 'done'), task('B', 'in_progress')], gated).find(a => a.task_id === 'B')?.kind, 'blocked');
});

test('Manual policy and task-spec blockers apply to dispatch and recovery', () => {
  for (const status of ['todo', 'in_progress'] as const) {
    const dag = { ...plan({ A: [] }), execution_policy: { never_auto_start: ['A'] } };
    assert.equal(actions([task('A', status)], dag)[0]?.kind, 'blocked');
    const human = { ...plan({ A: [] }), task_specs: [{ id: 'A', blocked_by: ['Named owner must confirm the target'] }] };
    assert.equal(actions([task('A', status)], human)[0]?.kind, 'blocked');
  }
});

test('Task-spec dependencies participate in acceptance and cycle checks', () => {
  const dag = { ...plan({ A: [], B: [] }), task_specs: [{ id: 'B', blocked_by: ['A'] }] };
  assert.equal(actions([task('A'), task('B', 'in_progress')], dag).find(a => a.task_id === 'B')?.kind, 'blocked');
  const cyclic = { ...dag, task_specs: [{ id: 'A', blocked_by: ['B'] }, { id: 'B', blocked_by: ['A'] }] };
  assert.throws(() => validatePlan(cyclic, [task('A'), task('B')]), /cycle/);
});

test('An unbound in-progress task needs explicit host recovery, not a fictitious session', () => {
  const result = actions([task('A', 'in_progress')], plan({ A: [] }));
  assert.equal(result[0]?.kind, 'blocked');
  assert.match(result[0]?.kind === 'blocked' ? result[0].reason : '', /session|host|manual/i);
});

test('Missing observations are not evidence that a known session can safely resume', () => {
  const dag = plan({ A: [] });
  dag.tasks.A!.session_id = 'sess-a';
  assert.equal(actions([task('A')], dag)[0]?.kind, 'blocked');
  assert.equal(actions([task('A')], dag, emptyRuntime(), [{ session_id: 'sess-a', state: 'missing' }])[0]?.kind, 'recover');
});

test('Unobserved bound sessions and fresh unbound claims conservatively reserve capacity', () => {
  const dag = plan({ B: [], A: [] });
  dag.tasks.A!.session_id = 'sess-a';
  assert.equal(actions([task('B'), task('A', 'in_progress')], dag, emptyRuntime(), [], 1).find(a => a.task_id === 'B')?.kind, 'blocked');
  const runtime = emptyRuntime();
  runtime.leases.A = { task_id: 'A', lease_id: 'lease-a', attempt: 1, acquired_at: 1_999_999, heartbeat_at: 1_999_999 };
  assert.equal(actions([task('B'), task('A')], plan({ B: [], A: [] }), runtime, [], 1).find(a => a.task_id === 'B')?.kind, 'blocked');
});

test('open_now cannot override owner blockers and unopened roots do not auto-start', () => {
  const dag = { ...plan({ A: [], B: [] }), execution_policy: { open_now: ['B'], never_auto_start: ['B'] } };
  const result = actions([task('A'), task('B')], dag);
  assert.equal(result.every(action => action.kind === 'blocked'), true);
});

test('Live observations outrank expired heartbeats and reserve capacity regardless of task order', () => {
  const dag = plan({ B: [], A: [] });
  const runtime = emptyRuntime();
  runtime.leases.A = { task_id: 'A', lease_id: 'lease-a', session_id: 'sess-a', attempt: 1, acquired_at: 0, heartbeat_at: 0 };
  const result = actions([task('B'), task('A', 'in_progress')], dag, runtime, [{ session_id: 'sess-a', state: 'running' }], 1);
  assert.equal(result.find(a => a.task_id === 'A')?.kind, 'wait');
  assert.equal(result.find(a => a.task_id === 'B')?.kind, 'blocked');
  assert.equal(result.some(a => a.kind === 'recover' || a.kind === 'dispatch'), false);
});

test('A blocked live session still consumes host capacity', () => {
  const dag = plan({ B: [], A: [] });
  dag.tasks.A!.session_id = 'sess-a';
  const result = actions([task('B'), task('A', 'blocked')], dag, emptyRuntime(), [{ session_id: 'sess-a', state: 'running' }], 1);
  assert.equal(result.find(a => a.task_id === 'B')?.kind, 'blocked');
});

test('Recovery obeys concurrency and integration mutex in both task orders', () => {
  const dag = plan({ A: [], B: [] });
  dag.tasks.A!.session_id = 'sess-a';
  dag.tasks.B!.session_id = 'sess-b';
  const result = actions([task('A', 'in_progress'), task('B', 'in_progress')], dag, emptyRuntime(), [{ session_id: 'sess-a', state: 'missing' }, { session_id: 'sess-b', state: 'missing' }], 1);
  assert.equal(result.filter(a => a.kind === 'recover').length, 1);
  const mutex = plan({ A: [], B: [] });
  mutex.tasks.B!.mutex_group = 'integration';
  assert.equal(actions([task('A'), task('B')], mutex).find(a => a.task_id === 'B')?.kind, 'blocked');
});

test('Invalid numeric controls and duplicate observations fail closed', () => {
  for (const maxConcurrency of [0, NaN, 1.5, Infinity]) assert.throws(() => actions([task('A')], plan({ A: [] }), emptyRuntime(), [], maxConcurrency), /concurrency/i);
  assert.throws(() => actions([task('A')], plan({ A: [] }), emptyRuntime(), [{ session_id: 'sess-a', state: 'missing' }, { session_id: 'sess-a', state: 'running' }]), /duplicate/i);
});

test('Malformed persisted state maps and leases fail closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'ano-state-safety-'));
  try {
    const path = join(root, 'state.json');
    for (const invalid of [
      { ...emptyRuntime(), completed: 7 },
      { ...emptyRuntime(), leases: { A: { task_id: 'B', lease_id: 'bad', attempt: 1, acquired_at: 0, heartbeat_at: 0 } } },
      { ...emptyRuntime(), completed: { A: { acceptance_verified: 'yes', verified_at: '2026-11-26', verification: 'quality.json' } } },
      { ...emptyRuntime(), gates: { phase: { passed: 1, verified_at: '2026-11-26', verification: 'quality.json' } } },
    ]) {
      writeFileSync(path, JSON.stringify(invalid));
      assert.throws(() => new JsonStateStore(path).read(), /invalid/i);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('An unbound claim cannot masquerade as adoption of an existing session', () => {
  const root = mkdtempSync(join(tmpdir(), 'ano-claim-safety-'));
  try {
    const store = new JsonStateStore(join(root, 'state.json'));
    store.claim(task('A'), undefined, 1);
    assert.equal(store.claim(task('A', 'in_progress'), undefined, 2, true).acquired, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
