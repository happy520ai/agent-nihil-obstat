import { createHash } from 'node:crypto';

export type TaskStatus = 'backlog' | 'todo' | 'in_progress' | 'blocked' | 'done' | 'cancelled';
export type SessionState = 'running' | 'idle' | 'needs_attention' | 'missing';

export interface TaskSnapshot {
  id: string;
  title: string;
  detail: string;
  status: TaskStatus;
  files: string[];
  steps: Array<{ text: string; done: boolean }>;
  acceptance: string;
  result_note: string;
  verification: string;
  author?: string;
}

export interface PlanEntry {
  depends_on: string[];
  gate?: string;
  mutex_group?: string;
  session_id?: string;
  model?: string;
}

export interface PlanTaskSpec {
  id: string;
  blocked_by?: string[];
}

export interface OrchestrationPlan {
  schema_version: 1;
  milestone: string;
  description: string;
  tasks: Record<string, PlanEntry>;
  task_specs?: PlanTaskSpec[];
  execution_policy?: { open_now?: string[]; never_auto_start?: string[] };
}

export interface Lease {
  task_id: string;
  lease_id: string;
  session_id?: string;
  attempt: number;
  acquired_at: number;
  heartbeat_at: number;
}

export interface RuntimeState {
  schema_version: 1;
  revision: number;
  leases: Record<string, Lease>;
  completed: Record<string, {
    acceptance_verified: true;
    verified_at: string;
    verification: string;
    source_sha256?: string;
    report_sha256?: string;
    task_sha256?: string;
  }>;
  attempts?: Record<string, number>;
  gates: Record<string, { passed: true; verified_at: string; verification: string; task_id?: string; report_sha256?: string; source_sha256?: string }>;
}

export interface SessionObservation {
  session_id: string;
  state: SessionState;
  detail?: string;
}

export type Action =
  | { kind: 'adopt'; task_id: string; session_id: string; reason: string }
  | { kind: 'dispatch'; task_id: string; model?: string; prompt: string }
  | { kind: 'wait'; task_id: string; session_id: string; reason: string }
  | { kind: 'attention'; task_id: string; session_id: string; reason: string }
  | { kind: 'recover'; task_id: string; session_id?: string; reason: string }
  | { kind: 'verify'; task_id: string; reason: string }
  | { kind: 'blocked'; task_id: string; reason: string };

export interface ScheduleInput {
  tasks: TaskSnapshot[];
  plan: OrchestrationPlan;
  runtime: RuntimeState;
  sessions: SessionObservation[];
  now: number;
  maxConcurrency: number;
  leaseTimeoutMs?: number;
}

export function emptyRuntime(): RuntimeState {
  return { schema_version: 1, revision: 0, leases: {}, completed: {}, gates: {} };
}

export function completionTaskHash(task: Pick<TaskSnapshot, 'result_note' | 'verification'>): string {
  return createHash('sha256').update(JSON.stringify([task.result_note, task.verification])).digest('hex');
}

function taskSpecBlockers(plan: OrchestrationPlan): Map<string, string[]> {
  const blockers = new Map<string, string[]>();
  for (const spec of plan.task_specs ?? []) {
    const existing = blockers.get(spec.id) ?? [];
    blockers.set(spec.id, [...existing, ...(spec.blocked_by ?? [])]);
  }
  return blockers;
}

function dependencies(plan: OrchestrationPlan, id: string): string[] {
  return [...new Set([...(plan.tasks[id]?.depends_on ?? []), ...(taskSpecBlockers(plan).get(id) ?? []).filter(value => Boolean(plan.tasks[value]))])];
}

function manualBlockers(plan: OrchestrationPlan, id: string): string[] {
  const taskBlockers = taskSpecBlockers(plan).get(id) ?? [];
  const neverAutoStart = plan.execution_policy?.never_auto_start?.includes(id) ? [`Execution policy requires a named owner to release ${id}`] : [];
  const unopenedRoot = plan.execution_policy?.open_now && dependencies(plan, id).length === 0 && !plan.execution_policy.open_now.includes(id) ? [`Root task ${id} is not in execution_policy.open_now`] : [];
  return [...taskBlockers.filter(value => !plan.tasks[value]), ...neverAutoStart, ...unopenedRoot];
}

export function validatePlan(plan: OrchestrationPlan, tasks: TaskSnapshot[]): void {
  if (plan.schema_version !== 1) throw new Error('Unsupported orchestration plan schema');
  const stringList = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string' && item.trim().length > 0);
  if (!plan.tasks || typeof plan.tasks !== 'object' || Array.isArray(plan.tasks)) throw new Error('Invalid plan tasks');
  if (plan.task_specs !== undefined && (!Array.isArray(plan.task_specs) || plan.task_specs.some(spec => !spec || typeof spec.id !== 'string' || (spec.blocked_by !== undefined && !stringList(spec.blocked_by))))) throw new Error('Invalid task specifications');
  if (plan.execution_policy !== undefined) {
    const policy = plan.execution_policy;
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new Error('Invalid execution policy');
    for (const list of [policy.open_now, policy.never_auto_start]) {
      if (list !== undefined && (!stringList(list) || list.some(id => !plan.tasks[id]))) throw new Error('Invalid execution policy tasks');
    }
  }
  const ids = new Set(tasks.map(task => task.id));
  if (ids.size !== tasks.length) throw new Error('Duplicate PM task identity');
  const specIds = new Set<string>();
  for (const spec of plan.task_specs ?? []) {
    if (!plan.tasks[spec.id] || specIds.has(spec.id)) throw new Error(`Invalid or duplicate task specification ${spec.id}`);
    specIds.add(spec.id);
  }
  for (const [id, entry] of Object.entries(plan.tasks)) {
    if (!ids.has(id)) throw new Error(`Plan references unknown task ${id}`);
    if (!entry || !stringList(entry.depends_on)) throw new Error(`Invalid dependencies for ${id}`);
    for (const dependency of dependencies(plan, id)) {
      if (!plan.tasks[dependency]) throw new Error(`${id} has unknown dependency ${dependency}`);
      if (dependency === id) throw new Error(`${id} depends on itself`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string): void {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`Dependency cycle includes ${id}`);
    visiting.add(id);
    for (const dependency of dependencies(plan, id)) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of Object.keys(plan.tasks)) visit(id);
}

export function accepted(task: TaskSnapshot, runtime: RuntimeState): boolean {
  if (task.status !== 'done' || !task.result_note.trim() || !task.verification.trim()) return false;
  // The host adapter validates source/report freshness on every round; this also
  // invalidates an attestation when the PM completion evidence has been edited.
  const completion = runtime.completed[task.id];
  return completion?.acceptance_verified === true && completion.task_sha256 === completionTaskHash(task);
}

function unresolvedDependencies(task: TaskSnapshot, plan: OrchestrationPlan, runtime: RuntimeState, tasks: Map<string, TaskSnapshot>): string[] {
  return dependencies(plan, task.id).filter(id => {
    const dependency = tasks.get(id);
    return !dependency || !accepted(dependency, runtime);
  });
}

export function taskPrompt(task: TaskSnapshot, recovery = false): string {
  return [
    `【${recovery ? '断点恢复' : '自动派发'}：${task.id}】${task.title}`,
    '你是此任务唯一执行会话。不要创建新任务，不领取其他任务，不自行开放下游任务。',
    '先用 PM-mcp get_status/list_tasks 读取此任务最新 detail、steps、checkpoint 与验收要求，再检查现有文件。',
    '保留已有合法改动，禁止从零覆盖；只修改任务 files 声明的范围。',
    `任务要求：${task.detail}`,
    `验收标准：${task.acceptance}`,
    '写 checkpoint 时必须显式传 status，并回读确认；子任务只运行范围内的测试，不集中并发运行全量质量矩阵。',
    '完成时更新步骤、result_note、verification、files；feature/fix 只有在最新成功且匹配当前源码的质量报告存在时才能置 done。',
    '若因其他会话正在改源码而无法取得稳定全量报告，保留 in_progress，写明局部验证与等待主控集成验收。',
    '遇到权限批准、真实阻塞或指令冲突时停止并报告，不伪造验证，不修改用户级 MCP 配置，不自动 cutover。',
  ].join('\n');
}

export function schedule(input: ScheduleInput): Action[] {
  const { tasks: taskList, plan, runtime, now } = input;
  validatePlan(plan, taskList);
  if (!Number.isFinite(now) || !Number.isInteger(input.maxConcurrency) || input.maxConcurrency < 1 || input.maxConcurrency > 8) throw new Error('Invalid scheduler concurrency or clock');
  const leaseTimeout = input.leaseTimeoutMs ?? 30 * 60_000;
  if (!Number.isFinite(leaseTimeout) || leaseTimeout < 0) throw new Error('Invalid lease timeout');
  const tasks = new Map(taskList.map(task => [task.id, task]));
  const sessions = new Map<string, SessionObservation>();
  for (const observed of input.sessions) {
    if (!observed || typeof observed.session_id !== 'string' || !observed.session_id.trim() || !['running', 'idle', 'needs_attention', 'missing'].includes(observed.state)) throw new Error('Invalid session observation');
    if (sessions.has(observed.session_id)) throw new Error(`Duplicate session observation ${observed.session_id}`);
    sessions.set(observed.session_id, observed);
  }
  const actions: Action[] = [];
  const groups = new Set<string>();
  let used = 0;

  // Reserve capacity and mutexes before choosing any action. Unknown bound
  // sessions and fresh unbound claims may still be active; only an explicit
  // missing observation releases a known host-session reservation.
  for (const task of taskList) {
    const entry = plan.tasks[task.id];
    if (!entry) continue;
    const lease = runtime.leases[task.id];
    const sessionId = lease?.session_id ?? entry.session_id;
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if ((sessionId && (!session || session.state !== 'missing')) || (!sessionId && lease && now - lease.heartbeat_at <= leaseTimeout)) {
      used += 1;
      if (entry.mutex_group) groups.add(entry.mutex_group);
    }
  }

  for (const task of taskList) {
    const entry = plan.tasks[task.id];
    if (!entry) continue;
    const lease = runtime.leases[task.id];
    const sessionId = lease?.session_id ?? entry.session_id;
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (task.status === 'done') {
      if (!accepted(task, runtime)) actions.push({ kind: 'verify', task_id: task.id, reason: 'PM done needs controller verification before dependents are released' });
      continue;
    }
    const blockers = manualBlockers(plan, task.id);
    const unresolved = unresolvedDependencies(task, plan, runtime, tasks);
    const gateTask = entry.gate ? Object.entries(plan.tasks).find(([, candidate]) => candidate.gate === entry.gate && candidate.mutex_group) : undefined;
    const reason = task.status === 'blocked' || task.status === 'cancelled'
      ? `Task is ${task.status}; dependents remain gated`
      : blockers.length ? `Manual blocker requires owner action: ${blockers.join('; ')}`
      : unresolved.length ? `Waiting for accepted dependencies: ${unresolved.join(', ')}`
      : entry.gate && gateTask?.[0] !== task.id && !runtime.gates[entry.gate]?.passed ? `Phase gate ${entry.gate} is not open`
      : undefined;
    if (reason) {
      actions.push(session && session.state !== 'missing'
        ? { kind: 'attention', task_id: task.id, session_id: session.session_id, reason }
        : { kind: 'blocked', task_id: task.id, reason });
      continue;
    }
    if (session && session.state !== 'missing') {
      if (!lease) actions.push({ kind: 'adopt', task_id: task.id, session_id: session.session_id, reason: 'Adopt pre-existing task session without duplicate dispatch' });
      if (lease || task.status === 'in_progress' || session.state === 'needs_attention') {
        actions.push(session.state === 'needs_attention'
          ? { kind: 'attention', task_id: task.id, session_id: session.session_id, reason: session.detail ?? 'Session requires attention' }
          : { kind: 'wait', task_id: task.id, session_id: session.session_id, reason: `Existing session is ${session.state}${lease && now - lease.heartbeat_at > leaseTimeout ? '; refresh expired lease without starting a duplicate' : ''}${session.state === 'idle' ? '; inspect PM checkpoint before resuming' : ''}` });
      }
      continue;
    }
    if ((task.status === 'in_progress' || lease) && !sessionId) {
      actions.push({ kind: 'blocked', task_id: task.id, reason: 'No bound host session; manual recovery must identify the existing work before dispatch' });
      continue;
    }
    if (sessionId && !session) {
      actions.push({ kind: 'blocked', task_id: task.id, reason: 'Bound host session has not been observed; inspect it before recovery' });
      continue;
    }
    if (task.status !== 'in_progress' && task.status !== 'todo' && task.status !== 'backlog') continue;
    if (used >= input.maxConcurrency || groups.size > 0 || (entry.mutex_group && used > 0)) {
      actions.push({ kind: 'blocked', task_id: task.id, reason: 'Concurrency or integration mutex capacity reached' });
      continue;
    }
    used += 1;
    if (entry.mutex_group) groups.add(entry.mutex_group);
    if (sessionId) {
      actions.push({ kind: 'recover', task_id: task.id, session_id: sessionId, reason: 'Host explicitly observed the bound session as missing; resume the same task without creating a new one' });
    } else {
      actions.push({ kind: 'dispatch', task_id: task.id, ...(entry.model ? { model: entry.model } : {}), prompt: taskPrompt(task) });
    }
  }
  return actions;
}

export function claimable(task: TaskSnapshot, lease: Lease | undefined, now: number, leaseTimeoutMs = 30 * 60_000): boolean {
  return (task.status === 'todo' || task.status === 'backlog') && (!lease || now - lease.heartbeat_at > leaseTimeoutMs);
}
