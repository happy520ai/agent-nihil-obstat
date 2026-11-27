import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

export interface LockOptions { timeoutMs?: number; staleAfterMs?: number }
function code(error: unknown): string | undefined { return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined; }
function alive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) {
    // EPERM means the process exists but belongs to another user; treating it
    // as dead would let us steal a live owner's lease.
    return code(error) === 'EPERM';
  }
}
interface Lease { release: () => void }
function acquire(path: string, options: LockOptions): Lease {
  mkdirSync(dirname(path), { recursive: true });
  const started = Date.now();
  const token = randomUUID();
  const timeout = options.timeoutMs ?? 10_000;
  const staleAfter = options.staleAfterMs ?? 60_000;
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
      if (Date.now() - started >= timeout) throw new Error(`Timed out acquiring lock ${path}`);
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
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
}
export function withFileLockSync<T>(path: string, operation: () => T, options: LockOptions = {}): T {
  const lease = acquire(path, options);
  try { return operation(); } finally { lease.release(); }
}
export async function withFileLock<T>(path: string, operation: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const lease = acquire(path, options);
  try { return await operation(); } finally { lease.release(); }
}
