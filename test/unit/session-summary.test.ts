import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Ledger } from '../../src/ledger/ledger.ts';
import { replayLedger } from '../../src/ledger/replay.ts';
import {
  buildSessionSummary,
  nextSessionSummarySeq,
  persistSessionSummary,
  sessionSummaryText,
  type SessionSummary,
} from '../../src/hooks/summary.ts';

function input(): Parameters<typeof buildSessionSummary> {
  return [
    { host_session_id: 'sess-1', client: 'zcode', started_at: '2026-11-26T00:00:00.000Z', head_commit: 'a'.repeat(40) },
    {
      tasks: [{ id: 'T-1', from: 'unknown', to: 'in_progress', checkpoint: true }],
      verifies: [{ task: 'T-1', ok: true, evidence_id: 'ev-1' }],
      notes_recorded: { decision: 1, pitfall: 0, memory: 2 },
      pre_tool: { allow: 3, ask: 1, deny: 0, degraded: 1 },
      unmet_checks: ['C2:T-1'],
    },
    { head_commit: 'b'.repeat(40), files_changed: ['src/b.ts', 'src/a.ts'], ended_at: '2026-11-26T00:01:00.000Z' },
  ];
}

test('mechanical summary is deterministic and sorted without transcript content', () => {
  const args = input();
  const first = buildSessionSummary(...args);
  const second = buildSessionSummary(...args);
  assert.equal(sessionSummaryText(first), sessionSummaryText(second));
  assert.deepEqual(first.files_changed, ['src/a.ts', 'src/b.ts']);
  assert.equal(first.untrusted, true);
  assert.equal(first.source, 'hook:auto');
  assert.equal(first.interrupted, false);
  assert.equal(first.tasks_count, 1);
  assert.equal(first.pre_tool.allow, 3);
  assert.equal(first.notes_recorded.decision, 1);
});

test('summary caps files/tasks and keeps counts without leaking prompt or secrets', () => {
  const args = input();
  args[1] = { ...args[1], tasks: Array.from({ length: 55 }, (_, i) => ({ id: `T-${i}`, from: 'unknown', to: 'todo', checkpoint: false })) };
  args[2] = { ...args[2], files_changed: Array.from({ length: 205 }, (_, i) => `src/${i}.ts`) };
  const summary = buildSessionSummary(args[0], args[1], args[2], { interrupted: true });
  assert.equal(summary.files_changed.length, 200);
  assert.equal(summary.files_changed_count, 205);
  assert.equal(summary.tasks.length, 50);
  assert.equal(summary.tasks_count, 55);
  assert.equal(summary.interrupted, true);
  const text = sessionSummaryText(summary);
  assert.equal(text.includes('prompt'), false);
  assert.equal(text.includes('api_key'), false);
  assert.equal(text.includes('sk-test-secret'), false);
});

test('summary persists through the real note path with idempotent sequence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ano-session-summary-'));
  const ledger = await Ledger.open(root);
  try {
    const summary: SessionSummary = buildSessionSummary(...input());
    const first = await persistSessionSummary(ledger, summary, 1);
    const second = await persistSessionSummary(ledger, summary, 1);
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(nextSessionSummarySeq(ledger, summary.host_session_id), 2);
    const events = replayLedger(ledger.ledgerDir).entries.map((entry) => entry.event);
    const notes = events.filter((event) => event.kind === 'note.recorded');
    assert.equal(notes.length, 1);
    assert.equal(notes[0]?.payload['kind'], 'session_summary');
    assert.equal(notes[0]?.payload['evidence_id'], undefined);
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});
