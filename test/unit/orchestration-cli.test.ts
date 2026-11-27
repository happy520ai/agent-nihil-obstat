import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { roundPlan } from '../../scripts/orchestration/cli.ts';
import { projectStore } from '../../scripts/orchestration/store.ts';

function fixture(status: TaskStatus = 'backlog', milestone = 'M8') {
  const root = mkdtempSync(join(tmpdir(), 'ano-cli-'));
  mkdirSync(join(root, '.pm'));
  const task = { id: 'T-1', title: 'task', detail: 'scope', status, files: [], steps: [], acceptance: 'tested', result_note: status === 'done' ? 'done' : '', verification: status === 'done' ? 'quality.json' : '', milestone };
  writeFileSync(join(root, '.pm', 'tasks.json'), JSON.stringify({ tasks: [task] }));
  const plan = join(root, 'plan.json');
  writeFileSync(plan, JSON.stringify({ schema_version: 1, milestone, description: '', tasks: { 'T-1': { depends_on: [] } } }));
  return { root, plan };
}

type TaskStatus = 'backlog' | 'done';

test('CLI dry-run emits dispatch without creating a session or mutating PM', () => {
  const { root, plan } = fixture();
  try {
    const before = readFileSync(join(root, '.pm', 'tasks.json'), 'utf8');
    const actions = roundPlan({ root, planPath: plan, milestone: 'M8', maxConcurrency: 4, now: 1 });
    assert.equal(actions[0]?.kind, 'dispatch');
    assert.equal(readFileSync(join(root, '.pm', 'tasks.json'), 'utf8'), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI emits verification for done task without silently opening a gate', () => {
  const { root, plan } = fixture('done');
  try {
    assert.deepEqual(roundPlan({ root, planPath: plan, milestone: 'M8', maxConcurrency: 4, now: 1 }).map(a => a.kind), ['verify']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI rejects mismatched milestone and malformed session data', () => {
  const { root, plan } = fixture();
  try {
    assert.throws(() => roundPlan({ root, planPath: plan, milestone: 'M9', maxConcurrency: 4 }), /differ/);
    assert.throws(() => roundPlan({ root, planPath: plan, milestone: 'M8', maxConcurrency: 4, sessions: [{ session_id: 's', state: 'bad' as 'idle' }] }), /Invalid session observation/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI runs any milestone plan and keeps state scoped to the project root', () => {
  const { root, plan } = fixture('backlog', 'M10');
  try {
    writeFileSync(join(root, '.pm', 'orchestration-state.json'), JSON.stringify({ schema_version: 1, revision: 7, leases: {}, completed: {}, gates: {} }));
    const actions = roundPlan({ root, planPath: plan, milestone: 'M10', maxConcurrency: 4, now: 1 });
    assert.equal(actions[0]?.kind, 'dispatch');
    assert.equal(projectStore(root).path, join(root, '.pm', 'orchestration-state.json'));
    assert.equal(JSON.parse(readFileSync(join(root, '.pm', 'orchestration-state.json'), 'utf8')).revision, 7);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI derives milestone from the plan file when --milestone is omitted', () => {
  const { root, plan } = fixture('backlog', 'M10');
  try {
    const actions = roundPlan({ root, planPath: plan, maxConcurrency: 4, now: 1 });
    assert.equal(actions[0]?.kind, 'dispatch');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI fails closed on missing plan, cycles and unknown tasks', () => {
  const { root, plan } = fixture();
  try {
    assert.throws(() => roundPlan({ root, planPath: join(root, 'missing-plan.json'), milestone: 'M8', maxConcurrency: 4 }), /ENOENT|no such file/i);
    const cyclic = join(root, 'cyclic-plan.json');
    writeFileSync(cyclic, JSON.stringify({ schema_version: 1, milestone: 'M8', description: '', tasks: { 'T-1': { depends_on: ['T-1'] } } }));
    assert.throws(() => roundPlan({ root, planPath: cyclic, milestone: 'M8', maxConcurrency: 4 }), /itself|cycle/);
    const unknown = join(root, 'unknown-plan.json');
    writeFileSync(unknown, JSON.stringify({ schema_version: 1, milestone: 'M8', description: '', tasks: { 'T-999': { depends_on: [] } } }));
    assert.throws(() => roundPlan({ root, planPath: unknown, milestone: 'M8', maxConcurrency: 4 }), /unknown task/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Scheduler sources carry no milestone-specific plan binding', () => {
  const sources = ['scripts/orchestration/cli.ts', 'scripts/orchestration/state-command.ts', 'scripts/orchestration/dag.ts', 'scripts/orchestration/store.ts'];
  for (const source of sources) {
    const text = readFileSync(source, 'utf8');
    assert.doesNotMatch(text, /m8-plan\.json/, `${source} hardcodes a plan path`);
    assert.doesNotMatch(text, /\bM8\b/, `${source} hardcodes a milestone`);
  }
});
