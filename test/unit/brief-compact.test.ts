import assert from 'node:assert/strict';
import test from 'node:test';
import { compactBrief, BRIEF_COMPACT_MIN_BUDGET } from '../../src/memory/brief-compact.ts';
import { buildSessionContinuity } from '../../src/memory/session-continuity.ts';
import { buildSessionSummary, sessionSummaryText } from '../../src/hooks/summary.ts';
import type { MemoryNote } from '../../src/memory/note.ts';

const length = (value: unknown): number => Array.from(JSON.stringify(value)).length;

function summary(id: string, ended: string, unmet: string[] = [], checkpoint = false) {
  return buildSessionSummary({ host_session_id: id, client: 'zcode', started_at: null, head_commit: null }, {
    tasks: [{ id: 'T-1', from: 'todo', to: 'in_progress', checkpoint }],
    unmet_checks: unmet,
  }, { head_commit: null, files_changed: ['src/中文.ts'], ended_at: ended });
}

function note(id: string, ended: string, unmet: string[] = [], checkpoint = false): MemoryNote {
  return { id, kind: 'session_summary', text: sessionSummaryText(summary(id, ended, unmet, checkpoint)), createdAt: ended };
}

test('briefCompact preserves priority and reports every omitted section', () => {
  const full = {
    tasks: [{ id: 'T-焦点', status: 'in_progress', title: '继续实现'.repeat(10) }],
    memory: { focus: { next_step: '补 checkpoint' }, knowledge: { relevant: [{ text: '长知识'.repeat(100) }] } },
    last_sessions: { latest: { host_session_id: 'S-1' }, recent: [{ host_session_id: 'S-1' }], unmet_checks: [{ host_session_id: 'S-1', check: 'C2:T-1' }] },
    graph: { freshness: { status: 'fresh' } },
    limitations: ['x'.repeat(1000)],
  };
  const compact = compactBrief(full, 400);
  assert.ok(length(compact) <= 400);
  assert.deepEqual((compact.last_sessions as { unmet_checks: unknown[] }).unmet_checks, [{ host_session_id: 'S-1', check: 'C2:T-1' }]);
  assert.ok(Array.isArray(compact.truncated));
  assert.ok((compact.truncated as string[]).includes('knowledge'));
  const large = compactBrief(full);
  assert.equal(large.truncated, undefined);
});

test('briefCompact budget uses code points and rejects impossible budgets', () => {
  const full = { tasks: [{ id: '任务', status: 'in_progress' }], memory: { focus: '下一步' }, last_sessions: { unmet_checks: [] } };
  const budget = length(compactBrief(full, 6000));
  assert.ok(length(compactBrief(full, budget)) <= budget);
  assert.ok(length(compactBrief(full, BRIEF_COMPACT_MIN_BUDGET)) <= BRIEF_COMPACT_MIN_BUDGET);
  assert.throws(() => compactBrief(full, BRIEF_COMPACT_MIN_BUDGET - 1), RangeError);
});

test('last_sessions keeps latest full summary, three recent lines, and resolves later checkpoints', () => {
  const continuity = buildSessionContinuity([
    note('S-1', '2026-11-26T00:00:00.000Z', ['C2:T-1']),
    note('S-2', '2026-11-26T01:00:00.000Z', [], true),
    note('S-3', '2026-11-26T02:00:00.000Z'),
    note('S-4', '2026-11-26T03:00:00.000Z'),
  ], [{ id: 'T-1', declaredFiles: [] }]);
  assert.equal(continuity.latest?.host_session_id, 'S-4');
  assert.deepEqual(continuity.recent.map((item) => item.host_session_id), ['S-4', 'S-3', 'S-2']);
  assert.deepEqual(continuity.unmet_checks, []);
});

test('malformed untrusted summaries are ignored instead of crashing brief', () => {
  const malformed = { id: 'bad', kind: 'session_summary', createdAt: '2026-11-26T00:00:00.000Z', text: JSON.stringify({ host_session_id: 'bad', ended_at: 'now', files_changed: [], files_changed_count: 0, tasks: [null], tasks_count: 1, unmet_checks: [null], interrupted: false }) } as MemoryNote;
  assert.deepEqual(buildSessionContinuity([malformed], []).unmet_checks, []);
  assert.equal(buildSessionContinuity([malformed], []).latest, null);
});

test('unmet C1 resolves only after every changed file has task ownership', () => {
  const notes = [note('S-1', '2026-11-26T00:00:00.000Z', ['C1:src/a.ts,src/b.ts'])];
  assert.equal(buildSessionContinuity(notes, [{ id: 'T-1', declaredFiles: ['src/a.ts'] }]).unmet_checks.length, 1);
  assert.equal(buildSessionContinuity(notes, [{ id: 'T-1', declaredFiles: ['src/a.ts', 'src/b.ts'] }]).unmet_checks.length, 0);
});
