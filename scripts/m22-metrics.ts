#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { replayLedger } from '../src/ledger/replay.ts';

export interface M22SessionAnnotation {
  readonly host_session_id: string;
  readonly brief_chars?: number;
  readonly first_effective_action_round?: number;
  readonly pre_tool?: { readonly allow: number; readonly ask: number; readonly deny: number; readonly false_blocks: number };
  readonly unsupported_language_changes?: number;
  readonly total_changes?: number;
  readonly continue_without_benefit?: boolean;
  readonly gate_bypass_attempts?: number;
}

function nonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function collectM22Metrics(root: string, annotations: readonly M22SessionAnnotation[] = []) {
  const events = replayLedger(join(root, '.ano', 'ledger')).entries.map((entry) => entry.event);
  if (!Array.isArray(annotations)) throw new Error('M22 annotations.sessions must be an array');
  const bySession = new Map<string, M22SessionAnnotation>();
  for (const item of annotations) {
    if (!item || typeof item !== 'object' || typeof item.host_session_id !== 'string' || !item.host_session_id.trim()) {
      throw new Error('M22 annotation requires a non-empty host_session_id');
    }
    if (bySession.has(item.host_session_id)) throw new Error(`Duplicate M22 annotation: ${item.host_session_id}`);
    bySession.set(item.host_session_id, item);
  }
  const sessionIds = new Set<string>();
  for (const event of events) {
    if (event.kind !== 'session.started' && event.kind !== 'session.stop_checked') continue;
    const id = (event.payload as Record<string, unknown>)['host_session_id'];
    if (typeof id === 'string') sessionIds.add(id);
  }
  for (const id of bySession.keys()) sessionIds.add(id);
  const missing = new Set<string>();
  if (sessionIds.size === 0) missing.add('sessions');
  const sessions = [...sessionIds].sort().map((id) => {
    const annotation = bySession.get(id);
    const stops = events.filter((event) => event.kind === 'session.stop_checked' && (event.payload as Record<string, unknown>)['host_session_id'] === id);
    const stopDecisions = stops.map((event) => (event.payload as Record<string, unknown>)['decision']);
    const continues = stops.length > 0 && stopDecisions.every((decision) => decision === 'continue' || decision === 'stop-ok')
      ? stopDecisions.filter((decision) => decision === 'continue').length : null;
    if (continues === null) missing.add(`${id}.stop_continues`);
    const summaries = events.filter((event) => {
      if (event.kind !== 'note.recorded') return false;
      const payload = event.payload as Record<string, unknown>;
      if (payload['kind'] !== 'session_summary') return false;
      try {
        const parsed = JSON.parse(String(payload['text'])) as { host_session_id?: unknown; source?: unknown } | null;
        return parsed?.host_session_id === id && parsed?.source === 'hook:auto';
      } catch { return false; }
    });
    let finalUnmet: string[] | null = null;
    if (summaries.length > 0) {
      const payload = summaries.at(-1)!.payload as Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(String(payload['text']));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          && Array.isArray((parsed as Record<string, unknown>)['unmet_checks'])
          && ((parsed as Record<string, unknown>)['unmet_checks'] as unknown[]).every((item) => typeof item === 'string')) {
          finalUnmet = (parsed as { unmet_checks: string[] }).unmet_checks;
        }
      } catch {
        // A malformed historical note is missing evidence, not an empty checklist.
      }
      if (finalUnmet === null) missing.add(`${id}.final_unmet_checks`);
    } else missing.add(`${id}.final_unmet_checks`);
    const brief = nonNegative(annotation?.brief_chars);
    const firstRound = nonNegative(annotation?.first_effective_action_round);
    if (brief === null) missing.add(`${id}.brief_chars`);
    if (firstRound === null) missing.add(`${id}.first_effective_action_round`);
    const pre = annotation?.pre_tool;
    const preTool = {
      allow: nonNegative(pre?.allow), ask: nonNegative(pre?.ask), deny: nonNegative(pre?.deny), false_blocks: nonNegative(pre?.false_blocks),
    };
    const blocked = (preTool.ask ?? 0) + (preTool.deny ?? 0);
    const preToolValid = Object.values(preTool).every((value) => value !== null)
      && preTool.false_blocks !== null && preTool.false_blocks <= blocked;
    if (!preToolValid) missing.add(`${id}.pre_tool`);
    const falseBlockRate = preToolValid && blocked > 0 ? preTool.false_blocks! / blocked : null;
    if (!preToolValid) missing.add(`${id}.false_block_rate`);
    const unsupported = nonNegative(annotation?.unsupported_language_changes);
    const total = nonNegative(annotation?.total_changes);
    if (unsupported === null || total === null || total === 0 || unsupported > total) missing.add(`${id}.unsupported_language_ratio`);
    const bypass = nonNegative(annotation?.gate_bypass_attempts);
    if (bypass === null) missing.add(`${id}.gate_bypass_attempts`);
    const continueWithoutBenefit = typeof annotation?.continue_without_benefit === 'boolean'
      ? annotation.continue_without_benefit : null;
    if (continueWithoutBenefit === null) missing.add(`${id}.continue_without_benefit`);
    return {
      host_session_id: id, brief_chars: brief, first_effective_action_round: firstRound,
      pre_tool: preTool, false_block_rate: falseBlockRate,
      false_block_rate_above_30pct: preToolValid ? blocked > 0 && falseBlockRate! > 0.3 : null,
      stop_continues: continues, final_unmet_checks: finalUnmet,
      unsupported_language_changes: unsupported, total_changes: total,
      unsupported_language_ratio: unsupported !== null && total !== null && total > 0 && unsupported <= total ? unsupported / total : null,
      continue_without_benefit: continueWithoutBenefit,
      gate_bypass_attempts: bypass,
    };
  });
  const unsupportedTotal = sessions.reduce((sum, session) => sum + (session.unsupported_language_changes ?? 0), 0);
  const changeTotal = sessions.reduce((sum, session) => sum + (session.total_changes ?? 0), 0);
  const completed = new Set(events.filter((event) => {
    if (event.kind !== 'task.updated' || event.payload['status'] !== 'done') return false;
    const taskId = event.payload['task_id'];
    const verdict = event.payload['verdict'];
    if (typeof taskId !== 'string' || !taskId || !verdict || typeof verdict !== 'object' || Array.isArray(verdict)) return false;
    const claim = verdict as Record<string, unknown>;
    if (claim['status'] !== 'done' || typeof claim['evidenceId'] !== 'string' || !claim['evidenceId']
      || (claim['taskId'] !== undefined && claim['taskId'] !== taskId)) return false;
    const evidenceEvent = events.find((candidate) => candidate.kind === 'evidence.recorded'
      && candidate.payload['task_id'] === taskId
      && (candidate.payload['evidence'] as { id?: unknown } | undefined)?.id === claim['evidenceId']);
    if (!evidenceEvent) return false;
    const evidence = evidenceEvent.payload['evidence'] as Record<string, unknown>;
    const verification = evidence['verification'] as Record<string, unknown> | undefined;
    const storedVerdict = verification?.['verdict'] as Record<string, unknown> | undefined;
    const validSourceHash = typeof evidence['sourceFingerprint'] === 'string' && /^[a-f0-9]{64}$/u.test(evidence['sourceFingerprint']);
    return evidence['ok'] === true && validSourceHash
      && verification?.['evidence_id'] === claim['evidenceId'] && verification['task_id'] === taskId
      && storedVerdict?.['status'] === 'done' && storedVerdict['evidenceId'] === claim['evidenceId']
      && (storedVerdict['taskId'] === undefined || storedVerdict['taskId'] === taskId);
  }).map((event) => event.payload['task_id'] as string));
  const noBenefit = sessions.filter((session) => session.continue_without_benefit === true && session.stop_continues !== null && session.stop_continues >= 2).length;
  const ratesAboveThreshold = sessions.some((session) => session.false_block_rate_above_30pct === true) ? true
    : sessions.length > 0 && sessions.every((session) => session.false_block_rate_above_30pct === false) ? false : null;
  const noBenefitComplete = sessions.length > 0 && sessions.every((session) => session.stop_continues !== null
    && (session.stop_continues < 2 || session.continue_without_benefit !== null));
  const lockAdvisory = ratesAboveThreshold === true || noBenefit >= 2 ? true
    : ratesAboveThreshold === false && noBenefitComplete ? false : null;
  return {
    schema: 'ano.m22-metrics.v1', root: resolve(root), sessions,
    evidence_completed_tasks: completed.size,
    gate_bypass_attempts: sessions.length > 0 && sessions.every((session) => session.gate_bypass_attempts !== null) ? sessions.reduce((sum, session) => sum + session.gate_bypass_attempts!, 0) : null,
    unsupported_language_ratio: sessions.length > 0 && sessions.every((session) => session.unsupported_language_ratio !== null) && changeTotal > 0 ? unsupportedTotal / changeTotal : null,
    stop_criteria: {
      false_block_rate_above_30pct: ratesAboveThreshold,
      exhausted_continue_without_benefit_sessions: noBenefitComplete ? noBenefit : null,
      lock_default_advisory: lockAdvisory,
      action: lockAdvisory === true ? 'lock-advisory-and-register-adjustment-task' : lockAdvisory === false ? 'no-automatic-config-write' : 'insufficient-data',
    },
    data_missing: [...missing].sort(),
    limitations: ['Pre-tool decisions and human usefulness/false-block labels require annotations; hooks deliberately do not write pre-tool ledger events.', 'Metrics do not authorize setup, cutover, release or M22 closure.'],
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const value = (flag: string): string | undefined => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
  const root = value('--root');
  if (!root) throw new Error('m22-metrics requires --root <path>');
  const annotationPath = value('--annotations');
  const annotations = annotationPath ? JSON.parse(await readFile(annotationPath, 'utf8')) as { sessions?: M22SessionAnnotation[] } : {};
  process.stdout.write(`${JSON.stringify(collectM22Metrics(root, annotations.sessions ?? []), null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
