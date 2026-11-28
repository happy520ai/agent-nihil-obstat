import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

export interface LockOptions { timeoutMs?: number; staleAfterMs?: number }
export interface LockOwnerDiagnostic {
  readonly pid: number | null;
  readonly startedAt: number | null;
  readonly ageMs: number | null;
  readonly alive: boolean | null;
  readonly metadata: 'readable' | 'invalid' | 'unreadable' | 'missing';
}
export class FileLockTimeoutError extends Error {
  readonly code = 'LOCK_TIMEOUT';
  readonly path: string;
  readonly timeoutMs: number;
  readonly waitedMs: number;
  readonly owner: LockOwnerDiagnostic;
  constructor(path: string, timeoutMs: number, waitedMs: number, owner: LockOwnerDiagnostic) {
    super(`Timed out acquiring lock ${path} after ${waitedMs}ms (timeout=${timeoutMs}ms; owner pid=${owner.pid ?? 'unknown'}, startedAt=${owner.startedAt ?? 'unknown'}, ageMs=${owner.ageMs ?? 'unknown'}, alive=${owner.alive ?? 'unknown'}, metadata=${owner.metadata})`);
    this.name = 'FileLockTimeoutError';
    this.path = path;
    this.timeoutMs = timeoutMs;
    this.waitedMs = waitedMs;
    this.owner = owner;
  }
}
function code(error: unknown): string | undefined { return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined; }
function alive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) {
    // EPERM means the process exists but belongs to another user; treating it
    // as dead would let us steal a live owner's lease.
    return code(error) === 'EPERM';
  }
}
function ownerDiagnostic(path: string): LockOwnerDiagnostic {
  const unknown = { pid: null, startedAt: null, ageMs: null, alive: null };
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); }
  catch (error) { return { ...unknown, metadata: code(error) === 'ENOENT' ? 'missing' : 'unreadable' }; }
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return { ...unknown, metadata: 'invalid' }; }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ...unknown, metadata: 'invalid' };
  const metadata = value as { pid?: unknown; startedAt?: unknown };
  const pid = typeof metadata.pid === 'number' && Number.isInteger(metadata.pid) && metadata.pid > 0 ? metadata.pid : null;
  const startedAt = typeof metadata.startedAt === 'number' && Number.isFinite(metadata.startedAt) && metadata.startedAt >= 0 ? metadata.startedAt : null;
  return { pid, startedAt, ageMs: startedAt === null ? null : Math.max(0, Date.now() - startedAt), alive: pid === null ? null : alive(pid), metadata: 'readable' };
}
interface Lease { release: () => void }
// Share acquisition/reclamation semantics; only the wait strategy differs.
function* acquire(path: string, options: LockOptions): Generator<number, Lease, void> {
  const timeout = options.timeoutMs ?? 10_000;
  const staleAfter = options.staleAfterMs ?? 60_000;
  if (!Number.isFinite(timeout) || timeout < 0 || !Number.isFinite(staleAfter) || staleAfter < 0) throw new RangeError('Lock durations must be finite non-negative numbers');
  mkdirSync(dirname(path), { recursive: true });
  const started = Date.now();
  const token = randomUUID();
  for (;;) {
    let fd: number | undefined;
    try {
      fd = openSync(path, 'wx');
      writeFileSync(fd, JSON.stringify({ token, pid: process.pid, startedAt: Date.now() }));
      fsyncSync(fd);
      let owned = true;
      return { release: () => {
        if (!owned) return;
        owned = false;
        try {
          const current = JSON.parse(readFileSync(path, 'utf8')) as { token?: string };
          if (current.token === token) unlinkSync(path);
        } catch { /* a recovered lease is not ours to delete */ }
      } };
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      fd = undefined;
      if (code(error) !== 'EEXIST') throw error;
      const waitedMs = Math.max(0, Date.now() - started);
      if (waitedMs >= timeout) throw new FileLockTimeoutError(path, timeout, waitedMs, ownerDiagnostic(path));
      try {
        const metadata = JSON.parse(readFileSync(path, 'utf8')) as { pid?: number; startedAt?: number };
        // Never steal a live owner's lock, even when it has exceeded a duration hint.
        if (!alive(metadata.pid) && typeof metadata.startedAt === 'number' && Date.now() - metadata.startedAt > staleAfter) {
          renameSync(path, `${path}.${token}.reclaimed`);
        }
      } catch (lockError) {
        if (code(lockError) === 'ENOENT') continue;
        try {
          // A truncated/corrupt lock can only be quarantined after a grace period,
          // never treated as permission for two active writers to overlap.
          if (Date.now() - statSync(path).mtimeMs > staleAfter) renameSync(path, `${path}.${token}.corrupt`);
        } catch (statError) { if (code(statError) === 'ENOENT') continue; }
      }
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    yield Math.min(10, Math.max(0, timeout - (Date.now() - started)));
  }
}
export function withFileLockSync<T>(path: string, operation: () => T, options: LockOptions = {}): T {
  const acquisition = acquire(path, options);
  let step = acquisition.next();
  while (!step.done) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, step.value);
    step = acquisition.next();
  }
  const lease = step.value;
  try { return operation(); } finally { lease.release(); }
}
export async function withFileLock<T>(path: string, operation: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const acquisition = acquire(path, options);
  let step = acquisition.next();
  while (!step.done) {
    await wait(step.value);
    step = acquisition.next();
  }
  const lease = step.value;
  try { return await operation(); } finally { lease.release(); }
}
