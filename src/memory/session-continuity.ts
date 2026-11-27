import type { MemoryNote } from './note.ts';
import type { SessionSummary } from '../hooks/summary.ts';

export interface ContinuityTask {
  readonly id: string;
  readonly declaredFiles: readonly string[];
}

export interface SessionSummaryLine {
  readonly host_session_id: string;
  readonly ended_at: string;
  readonly files_changed_count: number;
  readonly tasks_count: number;
  readonly unmet_checks: readonly string[];
  readonly interrupted: boolean;
}

export interface UnresolvedSessionCheck {
  readonly host_session_id: string;
  readonly check: string;
}

export interface SessionContinuity {
  readonly latest: SessionSummary | null;
  readonly recent: readonly SessionSummaryLine[];
  readonly unmet_checks: readonly UnresolvedSessionCheck[];
}

function isSummary(value: unknown): value is SessionSummary {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const summary = value as Partial<SessionSummary>;
  return typeof summary.host_session_id === 'string'
    && typeof summary.ended_at === 'string'
    && typeof summary.files_changed_count === 'number'
    && typeof summary.tasks_count === 'number'
    && typeof summary.interrupted === 'boolean'
    && Array.isArray(summary.files_changed)
    && summary.files_changed.every((file) => typeof file === 'string')
    && Array.isArray(summary.tasks)
    && summary.tasks.every((task) => task !== null && typeof task === 'object' && typeof task.id === 'string' && typeof task.checkpoint === 'boolean')
    && Array.isArray(summary.unmet_checks)
    && summary.unmet_checks.every((check) => typeof check === 'string');
}

/** Parse only the mechanical metadata shape; note text remains untrusted. */
export function buildSessionContinuity(
  notes: readonly Pick<MemoryNote, 'kind' | 'text' | 'createdAt'>[],
  tasks: readonly ContinuityTask[],
): SessionContinuity {
  const latestBySession = new Map<string, SessionSummary>();
  for (const note of notes) {
    if (note.kind !== 'session_summary') continue;
    try {
      const parsed: unknown = JSON.parse(note.text);
      if (isSummary(parsed)) latestBySession.set(parsed.host_session_id, parsed);
    } catch {
      // Malformed historical notes cannot become continuity facts.
    }
  }
  const summaries = [...latestBySession.values()].sort((left, right) =>
    right.ended_at.localeCompare(left.ended_at) || right.host_session_id.localeCompare(left.host_session_id));
  const ownedFiles = new Set(tasks.flatMap((task) => task.declaredFiles.map((file) => file.replaceAll('\\', '/'))));
  const checkpointTasks = new Set<string>();
  for (const summary of summaries) {
    for (const task of summary.tasks) if (task.checkpoint) checkpointTasks.add(task.id);
  }
  const unmet: UnresolvedSessionCheck[] = [];
  for (const summary of [...summaries].reverse()) {
    for (const check of summary.unmet_checks) {
      const separator = check.indexOf(':');
      const id = separator < 0 ? check : check.slice(0, separator);
      const items = separator < 0 ? [] : check.slice(separator + 1).split(',').filter((item) => item.length > 0);
      const resolved = id === 'C1'
        ? items.every((file) => ownedFiles.has(file))
        : (id === 'C2' || id === 'C3') && items.every((task) => checkpointTasks.has(task));
      if (!resolved) unmet.push({ host_session_id: summary.host_session_id, check });
    }
  }
  return {
    latest: summaries[0] ?? null,
    recent: summaries.slice(0, 3).map((summary) => ({
      host_session_id: summary.host_session_id,
      ended_at: summary.ended_at,
      files_changed_count: summary.files_changed_count,
      tasks_count: summary.tasks_count,
      unmet_checks: summary.unmet_checks,
      interrupted: summary.interrupted,
    })),
    unmet_checks: unmet,
  };
}
