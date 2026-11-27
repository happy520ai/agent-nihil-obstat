import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { withFileLockSync } from '../../src/core/lock.ts';
import { claimable, emptyRuntime, type Lease, type RuntimeState, type TaskSnapshot } from './dag.ts';

export interface StateStore {
  path: string;
  read(): RuntimeState;
  update<T>(operation: (state: RuntimeState) => T): T;
  claim(task: TaskSnapshot, sessionId?: string, now?: number, allowInProgress?: boolean): { acquired: boolean; lease: Lease };
  bind(taskId: string, leaseId: string, sessionId: string): void;
  release(taskId: string, leaseId: string): void;
}

function validState(value: unknown): asserts value is RuntimeState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Orchestrator state must be an object');
  const state = value as Partial<RuntimeState>;
  if (state.schema_version !== 1 || !Number.isSafeInteger(state.revision) || (state.revision ?? -1) < 0) throw new Error('Invalid orchestrator state version/revision');
  const isMap = (map: unknown): map is Record<string, unknown> => Boolean(map) && typeof map === 'object' && !Array.isArray(map);
  if (!isMap(state.leases) || !isMap(state.completed) || !isMap(state.gates) || (state.attempts !== undefined && !isMap(state.attempts))) throw new Error('Invalid orchestrator state maps');
  for (const [taskId, lease] of Object.entries(state.leases)) {
    if (!lease || typeof lease !== 'object' || lease.task_id !== taskId || typeof lease.lease_id !== 'string' || !lease.lease_id || !Number.isSafeInteger(lease.attempt) || lease.attempt < 1 || !Number.isFinite(lease.acquired_at) || !Number.isFinite(lease.heartbeat_at) || (lease.session_id !== undefined && typeof lease.session_id !== 'string')) throw new Error(`Invalid lease for ${taskId}`);
  }
  for (const [taskId, completion] of Object.entries(state.completed)) {
    if (!completion || typeof completion !== 'object' || completion.acceptance_verified !== true || typeof completion.verified_at !== 'string' || typeof completion.verification !== 'string' || (completion.source_sha256 !== undefined && !/^[a-f0-9]{64}$/.test(completion.source_sha256)) || (completion.report_sha256 !== undefined && !/^[a-f0-9]{64}$/.test(completion.report_sha256)) || (completion.task_sha256 !== undefined && !/^[a-f0-9]{64}$/.test(completion.task_sha256))) throw new Error(`Invalid completion evidence for ${taskId}`);
  }
  for (const [gateId, gate] of Object.entries(state.gates)) {
    if (!gate || typeof gate !== 'object' || gate.passed !== true || typeof gate.verified_at !== 'string' || typeof gate.verification !== 'string' || (gate.task_id !== undefined && typeof gate.task_id !== 'string') || (gate.report_sha256 !== undefined && !/^[a-f0-9]{64}$/.test(gate.report_sha256)) || (gate.source_sha256 !== undefined && !/^[a-f0-9]{64}$/.test(gate.source_sha256))) throw new Error(`Invalid gate evidence for ${gateId}`);
  }
  for (const [taskId, attempt] of Object.entries(state.attempts ?? {})) if (!Number.isSafeInteger(attempt) || attempt < 0) throw new Error(`Invalid attempt count for ${taskId}`);
}

export class JsonStateStore implements StateStore {
  readonly path: string;

  constructor(path: string) { this.path = path; }

  read(): RuntimeState {
    if (!existsSync(this.path)) return emptyRuntime();
    const value: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
    validState(value);
    return value;
  }

  update<T>(operation: (state: RuntimeState) => T): T {
    return withFileLockSync(`${this.path}.lock`, () => {
      const state = this.read();
      const result = operation(state);
      state.revision += 1;
      validState(state);
      mkdirSync(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      renameSync(temporary, this.path);
      return result;
    });
  }

  claim(task: TaskSnapshot, sessionId?: string, now = Date.now(), allowInProgress = false): { acquired: boolean; lease: Lease } {
    return this.update(state => {
      const existing = state.leases[task.id];
      if (allowInProgress && task.status === 'in_progress' && sessionId && existing && existing.session_id === sessionId && now - existing.heartbeat_at <= 30 * 60_000) return { acquired: true, lease: existing };
      if (allowInProgress && task.status === 'in_progress' && !existing && sessionId) {
        // Existing PM work is adopted; this is not a new task claim.
      } else if (!claimable(task, existing, now)) {
        if (!existing) throw new Error(`Cannot claim ${task.id} in status ${task.status}`);
        return { acquired: false, lease: existing };
      }
      const lease: Lease = {
        task_id: task.id,
        lease_id: randomUUID(),
        ...(sessionId ? { session_id: sessionId } : {}),
        attempt: (state.attempts?.[task.id] ?? existing?.attempt ?? 0) + 1,
        acquired_at: now,
        heartbeat_at: now,
      };
      state.leases[task.id] = lease;
      state.attempts = { ...state.attempts, [task.id]: lease.attempt };
      return { acquired: true, lease };
    });
  }

  bind(taskId: string, leaseId: string, sessionId: string): void {
    this.update(state => {
      const lease = state.leases[taskId];
      if (!lease || lease.lease_id !== leaseId) throw new Error(`Lease fence rejected stale bind for ${taskId}`);
      lease.session_id = sessionId;
      lease.heartbeat_at = Date.now();
    });
  }

  release(taskId: string, leaseId: string): void {
    this.update(state => {
      const lease = state.leases[taskId];
      if (!lease || lease.lease_id !== leaseId) return;
      delete state.leases[taskId];
    });
  }
}

export function projectStore(root: string): StateStore {
  return new JsonStateStore(resolve(root, '.pm', 'orchestration-state.json'));
}
