import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectStore } from './store.ts';
import { accepted, completionTaskHash, schedule, type OrchestrationPlan, type SessionObservation, type TaskSnapshot } from './dag.ts';
import { readCurrentFingerprint } from './state-command.ts';

interface PmTasksFile { tasks: Array<TaskSnapshot & { milestone?: string }> }

export interface RoundRequest {
  root: string;
  planPath: string;
  // Optional so a plan file can be the single source of truth for its milestone;
  // when supplied it must match the plan.
  milestone?: string;
  maxConcurrency: number;
  sessions?: SessionObservation[];
  now?: number;
  // Trusted host/test injection; the command line always computes this locally.
  currentSourceSha256?: string;
}

export function roundPlan(request: RoundRequest) {
  const plan = JSON.parse(readFileSync(request.planPath, 'utf8')) as OrchestrationPlan;
  const milestone = request.milestone ?? plan.milestone;
  if (plan.milestone !== milestone) throw new Error('Plan and requested milestone differ');
  const tasksFile = JSON.parse(readFileSync(resolve(request.root, '.pm', 'tasks.json'), 'utf8')) as PmTasksFile;
  // A plan may span several product milestones (ADR-013). Select by the plan's
  // task ids instead of dropping cross-milestone dependencies before validation.
  const plannedIds = new Set(Object.keys(plan.tasks));
  const tasks = tasksFile.tasks.filter(task => plannedIds.has(task.id));
  const sessions = request.sessions ?? [];
  if (!Array.isArray(sessions)) throw new Error('Invalid session observations');
  for (const session of sessions) {
    if (!session || !/^sess_[A-Za-z0-9._-]+$/.test(session.session_id) || !['running', 'idle', 'needs_attention', 'missing'].includes(session.state)) throw new Error('Invalid session observation');
  }
  const runtime = projectStore(request.root).read();
  const hasEvidence = Object.keys(runtime.completed).length > 0 || Object.keys(runtime.gates).length > 0;
  const currentSource = hasEvidence ? request.currentSourceSha256 ?? readCurrentFingerprint(request.root) : undefined;
  if (currentSource !== undefined && !/^[a-f0-9]{64}$/.test(currentSource)) throw new Error('Invalid current source fingerprint');
  const reportDigests = new Map<string, string | undefined>();
  const reportDigest = (path: string): string | undefined => {
    if (!reportDigests.has(path)) {
      try { reportDigests.set(path, createHash('sha256').update(readFileSync(resolve(request.root, path))).digest('hex')); }
      catch { reportDigests.set(path, undefined); }
    }
    return reportDigests.get(path);
  };
  for (const [id, evidence] of Object.entries(runtime.completed)) {
    const task = tasks.find(candidate => candidate.id === id);
    if (!task || !evidence.source_sha256 || evidence.source_sha256 !== currentSource || !evidence.report_sha256 || evidence.report_sha256 !== reportDigest(evidence.verification) || evidence.task_sha256 !== completionTaskHash(task)) delete runtime.completed[id];
  }
  for (const [gateId, evidence] of Object.entries(runtime.gates)) {
    const producerId = Object.entries(plan.tasks).find(([, entry]) => entry.gate === gateId && entry.mutex_group)?.[0];
    const producer = tasks.find(task => task.id === producerId);
    const completion = producerId ? runtime.completed[producerId] : undefined;
    if (!producer || evidence.task_id !== producerId || !accepted(producer, runtime) || !completion || evidence.source_sha256 !== currentSource || !evidence.report_sha256 || evidence.report_sha256 !== reportDigest(evidence.verification) || evidence.report_sha256 !== completion.report_sha256 || evidence.verification !== completion.verification) delete runtime.gates[gateId];
  }
  return schedule({ tasks, plan, runtime, sessions, now: request.now ?? Date.now(), maxConcurrency: request.maxConcurrency });
}

function parse(argv: string[]): RoundRequest {
  const root = process.cwd();
  let planPath: string | undefined;
  let milestone: string | undefined;
  let maxConcurrency = 4;
  let sessions: SessionObservation[] | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[++i];
    if (next === undefined) throw new Error(`Missing value for ${arg}`);
    if (arg === '--plan') planPath = resolve(root, next);
    else if (arg === '--milestone') milestone = next;
    else if (arg === '--max-concurrency') {
      maxConcurrency = Number(next);
      if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 8) throw new Error('Concurrency must be an integer from 1 to 8');
    } else if (arg === '--sessions') sessions = JSON.parse(readFileSync(resolve(root, next), 'utf8')) as SessionObservation[];
    else throw new Error(`Unknown option ${arg}`);
  }
  if (!planPath) throw new Error('Usage: cli.ts --plan <plan.json> [--milestone <id>] [--max-concurrency 1-8] [--sessions file]; the plan file declares its milestone when --milestone is omitted');
  return { root, planPath, ...(milestone ? { milestone } : {}), maxConcurrency, ...(sessions ? { sessions } : {}) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Read-only: host tools perform actual session/PM mutations after reviewing this plan.
  const request = parse(process.argv.slice(2));
  console.log(JSON.stringify({ mode: 'dry-run', actions: roundPlan(request) }, null, 2));
}
