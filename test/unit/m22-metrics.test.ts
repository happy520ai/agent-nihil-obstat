import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Ledger } from '../../src/ledger/ledger.ts';
import { noteSurface } from '../../src/surface/memory.ts';
import { buildSessionSummary, sessionSummaryText } from '../../src/hooks/summary.ts';
import { collectM22Metrics } from '../../scripts/m22-metrics.ts';
import { trackTaskUpdate, verifySurface } from '../../src/surface/service.ts';

test('M22 metrics combine ledger evidence with explicit human annotations and enforce stop criteria', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ano-m22-metrics-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'test'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'm22-metrics-fixture', type: 'module' }));
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  await writeFile(join(root, 'test', 'a.test.ts'), "import test from 'node:test';import assert from 'node:assert/strict';import { a } from '../src/a.ts';test('a',()=>assert.equal(a,1));\n");
  for (const args of [['init', '-q'], ['config', 'user.email', 'ano@localhost'], ['config', 'user.name', 'ano'], ['add', '.'], ['commit', '-qm', 'base']]) assert.equal(spawnSync('git', ['-C', root, ...args], { stdio: 'ignore' }).status, 0);
  const ledger = await Ledger.open(root);
  try {
    await ledger.createTask('T-1', ['src/a.ts', 'test/a.test.ts']);
    await ledger.updateTask('T-1', { status: 'in_progress' });
    await ledger.append({ kind: 'session.started', payload: { task_id: 'session-start:S-1', host_session_id: 'S-1', client: 'zcode', hook_mode: 'strict', head_commit: null, dirty_baseline: [], dirty_baseline_truncated: false, previous_session_unclosed: null } });
    await ledger.append({ kind: 'session.stop_checked', payload: { task_id: 'session-stop:S-1:1', host_session_id: 'S-1', seq: 1, checks: [], decision: 'continue', continuations_used: 1 } });
    const summary = buildSessionSummary({ host_session_id: 'S-1', client: 'zcode', started_at: null, head_commit: null }, { unmet_checks: ['C2:T-1'] }, { head_commit: null, files_changed: [], ended_at: '2026-11-26T00:00:00.000Z' });
    await noteSurface(ledger, { kind: 'session_summary', text: sessionSummaryText(summary), idem_key: 'm22-test-summary' });
  } finally { ledger.close(); }
  const verified = await verifySurface(root, { task_id: 'T-1', argv: [process.execPath, '--test', 'test/a.test.ts'], test_files: ['test/a.test.ts'], idem_key: 'm22-metrics:verify' });
  const verdict = verified['verdict'] as { evidenceId: string };
  await trackTaskUpdate(root, { operation: 'complete', id: 'T-1', evidence_id: verdict.evidenceId }, 'm22-metrics:complete');
  const report = collectM22Metrics(root, [{
    host_session_id: 'S-1', brief_chars: 1234, first_effective_action_round: 1,
    pre_tool: { allow: 4, ask: 1, deny: 1, false_blocks: 1 },
    unsupported_language_changes: 1, total_changes: 4, continue_without_benefit: false, gate_bypass_attempts: 0,
  }]);
  assert.equal(report.evidence_completed_tasks, 1);
  assert.equal(report.sessions[0]?.brief_chars, 1234);
  assert.equal(report.sessions[0]?.false_block_rate, 0.5);
  assert.equal(report.sessions[0]?.stop_continues, 1);
  assert.deepEqual(report.sessions[0]?.final_unmet_checks, ['C2:T-1']);
  assert.equal(report.unsupported_language_ratio, 0.25);
  assert.equal(report.stop_criteria.lock_default_advisory, true);
  assert.equal(report.stop_criteria.action, 'lock-advisory-and-register-adjustment-task');
  assert.deepEqual(report.data_missing, []);
});

test('M22 metrics reject impossible annotations and do not count incomplete gate evidence', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ano-m22-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.ano', 'ledger'), { recursive: true });
  const ledger = await Ledger.open(root);
  try {
    await ledger.append({ kind: 'session.started', payload: { task_id: 'session-start:S-INVALID', host_session_id: 'S-INVALID', client: 'zcode', hook_mode: 'advisory', head_commit: null, dirty_baseline: [], dirty_baseline_truncated: false, previous_session_unclosed: null } });
    await ledger.append({ kind: 'session.stop_checked', payload: { task_id: 'session-stop:S-INVALID:1', host_session_id: 'S-INVALID', seq: 1, checks: [], decision: 'stop-ok', continuations_used: 0 } });
    await ledger.createTask('T-INVALID', []);
    await assert.rejects(ledger.append({ kind: 'task.updated', payload: { task_id: 'T-INVALID', status: 'done', verdict: { status: 'done', evidenceId: 'missing-evidence' } } }), /not recorded/u);
    const summary = buildSessionSummary({ host_session_id: 'S-INVALID', client: 'zcode', started_at: null, head_commit: null }, { unmet_checks: [] }, { head_commit: null, files_changed: [], ended_at: '2026-11-26T00:00:00.000Z' });
    await noteSurface(ledger, { kind: 'session_summary', text: sessionSummaryText(summary), idem_key: 'm22-invalid-summary' });
  } finally { ledger.close(); }

  const annotation = {
    host_session_id: 'S-INVALID', brief_chars: 100, first_effective_action_round: 1,
    pre_tool: { allow: 0, ask: 1, deny: 0, false_blocks: 2 },
    unsupported_language_changes: 5, total_changes: 2, continue_without_benefit: false, gate_bypass_attempts: 0,
  };
  const report = collectM22Metrics(root, [annotation]);
  assert.equal(report.sessions[0]?.false_block_rate, null);
  assert.equal(report.sessions[0]?.false_block_rate_above_30pct, null);
  assert.equal(report.sessions[0]?.unsupported_language_ratio, null);
  assert.equal(report.stop_criteria.false_block_rate_above_30pct, null);
  assert.equal(report.stop_criteria.lock_default_advisory, null);
  assert.equal(report.stop_criteria.action, 'insufficient-data');
  assert.equal(report.evidence_completed_tasks, 0);
  assert.ok(report.data_missing.includes('S-INVALID.pre_tool'));
  assert.ok(report.data_missing.includes('S-INVALID.unsupported_language_ratio'));

  const zeroBlocks = collectM22Metrics(root, [{ ...annotation,
    pre_tool: { allow: 1, ask: 0, deny: 0, false_blocks: 0 }, unsupported_language_changes: 0,
  }]);
  assert.equal(zeroBlocks.sessions[0]?.false_block_rate, null);
  assert.equal(zeroBlocks.stop_criteria.false_block_rate_above_30pct, false);
  assert.equal(zeroBlocks.stop_criteria.lock_default_advisory, false);
  assert.deepEqual(zeroBlocks.data_missing, []);

  const boundary = collectM22Metrics(root, [{ ...annotation,
    pre_tool: { allow: 0, ask: 10, deny: 0, false_blocks: 3 }, unsupported_language_changes: 0,
  }]);
  assert.equal(boundary.sessions[0]?.false_block_rate, 0.3);
  assert.equal(boundary.stop_criteria.lock_default_advisory, false);

  const triggered = collectM22Metrics(root, [{ ...annotation,
    pre_tool: { allow: 0, ask: 10, deny: 0, false_blocks: 4 }, unsupported_language_changes: 0,
  }, { host_session_id: 'S-PARTIAL' }]);
  assert.equal(triggered.stop_criteria.false_block_rate_above_30pct, true);
  assert.equal(triggered.stop_criteria.lock_default_advisory, true);
});

test('M22 metrics treat malformed summaries as missing and reject duplicate annotations', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ano-m22-malformed-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.ano', 'ledger'), { recursive: true });
  const ledger = await Ledger.open(root);
  try {
    await ledger.append({ kind: 'session.started', payload: { task_id: 'session-start:S-BAD-SUMMARY', host_session_id: 'S-BAD-SUMMARY', client: 'zcode', hook_mode: 'advisory', head_commit: null, dirty_baseline: [], dirty_baseline_truncated: false, previous_session_unclosed: null } });
    await ledger.append({ kind: 'session.stop_checked', payload: { task_id: 'session-stop:S-BAD-SUMMARY:1', host_session_id: 'S-BAD-SUMMARY', seq: 1, checks: [], decision: 'stop-ok', continuations_used: 0 } });
    await noteSurface(ledger, { kind: 'session_summary', text: '{malformed', idem_key: 'm22-malformed-summary' });
    await noteSurface(ledger, { kind: 'session_summary', text: JSON.stringify({ host_session_id: 'S-BAD-SUMMARY', source: 'hook:auto', unmet_checks: [42] }), idem_key: 'm22-invalid-checklist' });
  } finally { ledger.close(); }
  const annotation = { host_session_id: 'S-BAD-SUMMARY' };
  const report = collectM22Metrics(root, [annotation]);
  assert.equal(report.sessions[0]?.final_unmet_checks, null);
  assert.ok(report.data_missing.includes('S-BAD-SUMMARY.final_unmet_checks'));
  assert.throws(() => collectM22Metrics(root, [annotation, annotation]), /Duplicate M22 annotation/u);
});

test('M22 metrics require explicit boolean usefulness labels for the two-session stop criterion', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ano-m22-continue-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ledger = await Ledger.open(root);
  try {
    for (const id of ['S-A', 'S-B']) {
      await ledger.append({ kind: 'session.started', payload: { task_id: `session-start:${id}`, host_session_id: id, client: 'zcode', hook_mode: 'advisory', head_commit: null, dirty_baseline: [], dirty_baseline_truncated: false, previous_session_unclosed: null } });
      for (const seq of [1, 2]) {
        await ledger.append({ kind: 'session.stop_checked', payload: { task_id: `session-stop:${id}:${seq}`, host_session_id: id, seq, checks: [], decision: 'continue', continuations_used: seq } });
      }
    }
  } finally { ledger.close(); }
  const annotations = ['S-A', 'S-B'].map((id) => ({
    host_session_id: id, pre_tool: { allow: 1, ask: 0, deny: 0, false_blocks: 0 }, continue_without_benefit: true,
  }));
  const triggered = collectM22Metrics(root, annotations);
  assert.equal(triggered.stop_criteria.exhausted_continue_without_benefit_sessions, 2);
  assert.equal(triggered.stop_criteria.lock_default_advisory, true);
  const invalid = collectM22Metrics(root, [{ ...annotations[0]!, continue_without_benefit: 'true' as unknown as boolean }, annotations[1]!]);
  assert.equal(invalid.sessions[0]?.continue_without_benefit, null);
  assert.equal(invalid.stop_criteria.lock_default_advisory, null);
  assert.equal(invalid.stop_criteria.action, 'insufficient-data');
  assert.ok(invalid.data_missing.includes('S-A.continue_without_benefit'));
});

test('M22 metrics never invent missing human data or write project configuration', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ano-m22-missing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const report = collectM22Metrics(root, [{ host_session_id: 'S-MISSING' }]);
  assert.equal(report.sessions[0]?.brief_chars, null);
  assert.equal(report.sessions[0]?.false_block_rate, null);
  assert.equal(report.gate_bypass_attempts, null);
  assert.equal(report.stop_criteria.false_block_rate_above_30pct, null);
  assert.ok(report.data_missing.includes('S-MISSING.brief_chars'));
  assert.ok(report.data_missing.includes('S-MISSING.pre_tool'));

  const filesBefore = await readdir(root);
  assert.deepEqual(filesBefore, []);
  const output = spawnSync(process.execPath, ['scripts/m22-metrics.ts', '--root', root], { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(output.status, 0, output.stderr);
  const cliReport = JSON.parse(output.stdout) as { data_missing: string[]; sessions: unknown[] };
  assert.deepEqual(cliReport.sessions, []);
  assert.ok(cliReport.data_missing.includes('sessions'));
  assert.deepEqual(await readdir(root), filesBefore);
});
