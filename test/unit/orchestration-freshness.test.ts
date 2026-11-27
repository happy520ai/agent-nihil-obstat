import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { roundPlan } from '../../scripts/orchestration/cli.ts';
import { completionTaskHash, emptyRuntime, type TaskSnapshot } from '../../scripts/orchestration/dag.ts';

const source = 'a'.repeat(64);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ano-round-evidence-'));
  mkdirSync(join(root, '.pm'));
  const tasks: TaskSnapshot[] = [
    { id: 'G', title: 'integration', status: 'done', detail: '', files: [], steps: [], acceptance: 'tested', result_note: 'implemented', verification: 'quality.json' },
    { id: 'B', title: 'next', status: 'todo', detail: '', files: [], steps: [], acceptance: 'tested', result_note: '', verification: '' },
  ];
  const planPath = join(root, 'plan.json');
  const tasksPath = join(root, '.pm', 'tasks.json');
  const statePath = join(root, '.pm', 'orchestration-state.json');
  const reportPath = join(root, 'quality.json');
  writeFileSync(planPath, JSON.stringify({ schema_version: 1, milestone: 'test', description: '', tasks: { G: { depends_on: [], gate: 'phase', mutex_group: 'integration' }, B: { depends_on: ['G'], gate: 'phase' } } }));
  writeFileSync(tasksPath, JSON.stringify({ tasks }));
  const report = JSON.stringify({ ok: true, source: { stable: true, before: { sha256: source }, after: { sha256: source } } });
  writeFileSync(reportPath, report);
  const reportHash = createHash('sha256').update(report).digest('hex');
  const state = emptyRuntime();
  state.completed.G = { acceptance_verified: true, verified_at: '2026-11-26T00:00:00Z', verification: 'quality.json', source_sha256: source, report_sha256: reportHash, task_sha256: completionTaskHash(tasks[0]!) };
  state.gates.phase = { passed: true, verified_at: '2026-11-26T00:00:00Z', verification: 'quality.json', task_id: 'G', source_sha256: source, report_sha256: reportHash };
  writeFileSync(statePath, JSON.stringify(state));
  const run = (currentSourceSha256 = source) => roundPlan({ root, planPath, maxConcurrency: 2, currentSourceSha256 });
  return { root, planPath, tasksPath, statePath, reportPath, tasks, state, run };
}

for (const change of ['none', 'source', 'report', 'PM evidence', 'legacy attestation', 'gate provenance'] as const) {
  test(`Each round revalidates evidence: ${change}`, () => {
    const f = fixture();
    try {
      if (change === 'report') writeFileSync(f.reportPath, JSON.stringify({ ok: false }));
      if (change === 'PM evidence') {
        f.tasks[0]!.result_note = 'changed after controller verification';
        writeFileSync(f.tasksPath, JSON.stringify({ tasks: f.tasks }));
      }
      if (change === 'legacy attestation') {
        delete f.state.completed.G!.task_sha256;
        delete f.state.completed.G!.report_sha256;
        writeFileSync(f.statePath, JSON.stringify(f.state));
      }
      if (change === 'gate provenance') {
        f.state.gates.phase!.task_id = 'other-task';
        writeFileSync(f.statePath, JSON.stringify(f.state));
      }
      const beforeTasks = readFileSync(f.tasksPath, 'utf8');
      const beforeState = readFileSync(f.statePath, 'utf8');
      const actions = f.run(change === 'source' ? 'b'.repeat(64) : source);
      assert.equal(actions.find(action => action.task_id === 'B')?.kind, change === 'none' ? 'dispatch' : 'blocked');
      if (!['none', 'gate provenance'].includes(change)) assert.equal(actions.find(action => action.task_id === 'G')?.kind, 'verify');
      assert.equal(readFileSync(f.tasksPath, 'utf8'), beforeTasks);
      assert.equal(readFileSync(f.statePath, 'utf8'), beforeState);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
}
