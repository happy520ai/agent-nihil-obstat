import { canonicalJson } from '../ledger/event.ts';
import { noteSurface } from '../surface/memory.ts';
import type { Ledger } from '../ledger/ledger.ts';

/** Mechanical session summary: metadata only, never transcript or model prose. */
export interface SessionSummary {
  readonly host_session_id: string;
  readonly client: string;
  readonly source: 'hook:auto';
  readonly started_at: string | null;
  readonly ended_at: string;
  readonly head_before: string | null;
  readonly head_after: string | null;
  readonly files_changed: readonly string[];
  readonly files_changed_count: number;
  readonly tasks: readonly SessionSummaryTask[];
  readonly tasks_count: number;
  readonly verifies: readonly SessionSummaryVerify[];
  readonly notes_recorded: Readonly<Record<'decision' | 'pitfall' | 'memory', number>>;
  readonly pre_tool: Readonly<Record<'allow' | 'ask' | 'deny' | 'degraded', number>>;
  readonly unmet_checks: readonly string[];
  readonly interrupted: boolean;
  readonly untrusted: true;
}

export interface SessionSummaryTask {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly checkpoint: boolean;
}

export interface SessionSummaryVerify {
  readonly task: string;
  readonly ok: boolean;
  readonly evidence_id: string | null;
}

export interface SessionStartedForSummary {
  readonly host_session_id: string;
  readonly client: string;
  readonly started_at: string | null;
  readonly head_commit: string | null;
}

export interface SessionLedgerWindow {
  readonly tasks?: readonly SessionSummaryTask[];
  readonly verifies?: readonly SessionSummaryVerify[];
  readonly notes_recorded?: Partial<Record<'decision' | 'pitfall' | 'memory', number>>;
  readonly pre_tool?: Partial<Record<'allow' | 'ask' | 'deny' | 'degraded', number>>;
  readonly unmet_checks?: readonly string[];
}

export interface SessionGitNow {
  readonly head_commit: string | null;
  readonly files_changed: readonly string[];
  readonly ended_at: string;
}

export const SESSION_SUMMARY_FILES_LIMIT = 200;
export const SESSION_SUMMARY_TASKS_LIMIT = 50;

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function nonNegative(value: number | undefined): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function buildSessionSummary(
  sessionStarted: SessionStartedForSummary,
  ledgerWindow: SessionLedgerWindow,
  gitNow: SessionGitNow,
  options: { interrupted?: boolean } = {},
): SessionSummary {
  const files = uniqueSorted(gitNow.files_changed);
  const tasks = (ledgerWindow.tasks ?? []).slice(0, SESSION_SUMMARY_TASKS_LIMIT);
  const notes = ledgerWindow.notes_recorded ?? {};
  const preTool = ledgerWindow.pre_tool ?? {};
  return {
    host_session_id: sessionStarted.host_session_id,
    client: sessionStarted.client,
    source: 'hook:auto',
    started_at: sessionStarted.started_at,
    ended_at: gitNow.ended_at,
    head_before: sessionStarted.head_commit,
    head_after: gitNow.head_commit,
    files_changed: files.slice(0, SESSION_SUMMARY_FILES_LIMIT),
    files_changed_count: files.length,
    tasks,
    tasks_count: (ledgerWindow.tasks ?? []).length,
    verifies: [...(ledgerWindow.verifies ?? [])],
    notes_recorded: {
      decision: nonNegative(notes.decision),
      pitfall: nonNegative(notes.pitfall),
      memory: nonNegative(notes.memory),
    },
    pre_tool: {
      allow: nonNegative(preTool.allow),
      ask: nonNegative(preTool.ask),
      deny: nonNegative(preTool.deny),
      degraded: nonNegative(preTool.degraded),
    },
    unmet_checks: uniqueSorted(ledgerWindow.unmet_checks ?? []),
    interrupted: options.interrupted === true,
    untrusted: true,
  };
}

export function sessionSummaryText(summary: SessionSummary): string {
  return canonicalJson(summary);
}

export async function persistSessionSummary(
  ledger: Ledger,
  summary: SessionSummary,
  seq: number,
): Promise<{ duplicate: boolean; eventId: string | null }> {
  if (!Number.isSafeInteger(seq) || seq < 1) throw new Error('summary seq must be a positive integer');
  const result = await noteSurface(ledger, {
    kind: 'session_summary',
    text: sessionSummaryText(summary),
    idem_key: `session-summary:${summary.host_session_id}:${seq}`,
  });
  return { duplicate: result.duplicate, eventId: result.eventId };
}

export function nextSessionSummarySeq(ledger: Ledger, hostSessionId: string): number {
  let count = 0;
  for (const note of ledger.listNotes()) {
    if (note.kind !== 'session_summary') continue;
    try {
      const parsed = JSON.parse(note.text) as { host_session_id?: unknown };
      if (parsed.host_session_id === hostSessionId) count += 1;
    } catch {
      // A malformed historical note cannot create a new identity or suppress the next sequence.
    }
  }
  return count + 1;
}
