import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readdirSync, statSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { ledgerEventSchema, type LedgerEvent } from './event.ts';
import { normalizeLineEnding } from './segment.ts';
import { LedgerIntegrityError } from './views.ts';

const batchBeginSchema = z.object({
  record: z.literal('batch.begin'),
  batch_id: z.string().min(1),
  event_count: z.number().int().nonnegative(),
}).strict();
const batchEndSchema = z.object({
  record: z.literal('batch.end'),
  batch_id: z.string().min(1),
  event_count: z.number().int().nonnegative(),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export interface ScannedSegment {
  events: LedgerEvent[];
  committedBytes: number;
  ignoredTail: boolean;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
}

export function sanitizeSessionId(sessionId: string): string {
  const sanitized = sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
  if (sanitized.length === 0) throw new Error('Session id must contain at least one safe filename character');
  return sanitized;
}

export function segmentFileName(now: number, sessionId: string): string {
  const iso = new Date(now).toISOString().replace(/[:.]/g, '-');
  return `${iso}-${sanitizeSessionId(sessionId)}.jsonl`;
}

export function listSegmentFiles(directory: string): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    throw error;
  }
}

/**
 * Segment names are `<ISO>-<session>.jsonl`; the ISO portion contains dashes,
 * so the session suffix is the stable discriminator.
 */
export function findSessionSegment(directory: string, sessionId: string): string | undefined {
  const suffix = `-${sanitizeSessionId(sessionId)}.jsonl`;
  const matches = listSegmentFiles(directory).filter((name) => {
    if (!name.endsWith(suffix)) return false;
    const timestamp = name.slice(0, -suffix.length);
    return /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(timestamp);
  });
  return matches.at(-1);
}

export function segmentDirectorySignature(directory: string): string {
  const parts: string[] = [];
  for (const name of listSegmentFiles(directory)) {
    const info = statSync(join(directory, name));
    parts.push(`${name}:${info.size}:${info.mtimeMs}`);
  }
  return parts.join('|');
}

/**
 * Stricter than segment.parseSegment on two points needed by the store:
 * - committedBytes stops before an unterminated batch instead of including
 *   its partial event lines;
 * - a batch.end whose count or checksum is wrong is rejected as corrupt
 *   committed data instead of being silently treated as a tail.
 */
export function scanSegment(bytes: Buffer): ScannedSegment {
  const events: LedgerEvent[] = [];
  let offset = 0;
  let committed = 0;
  let active: { id: string; expected: number; events: LedgerEvent[]; raw: string } | undefined;
  const lines = bytes.toString('utf8').split(/(?<=\n)/);
  for (const rawLine of lines) {
    if (rawLine === '') continue;
    if (!rawLine.endsWith('\n')) break;
    const line = normalizeLineEnding(rawLine);
    const lineBytes = Buffer.byteLength(rawLine);
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      break;
    }

    const event = ledgerEventSchema.safeParse(value);
    if (active) {
      if (event.success) {
        active.events.push(event.data);
        active.raw += line;
        offset += lineBytes;
        continue;
      }
      const end = batchEndSchema.safeParse(value);
      if (!end.success) throw new LedgerIntegrityError(`Corrupt batch ${active.id}: unexpected record at byte ${offset}`);
      if (end.data.batch_id !== active.id || end.data.event_count !== active.expected || active.events.length !== active.expected) {
        throw new LedgerIntegrityError(`Corrupt batch ${active.id}: header and end disagree on event count`);
      }
      const checksum = createHash('sha256').update(active.raw).digest('hex');
      if (checksum !== end.data.checksum) throw new LedgerIntegrityError(`Corrupt batch ${active.id}: checksum mismatch`);
      events.push(...active.events);
      offset += lineBytes;
      committed = offset;
      active = undefined;
      continue;
    }

    if (event.success) {
      events.push(event.data);
      offset += lineBytes;
      committed = offset;
      continue;
    }
    const begin = batchBeginSchema.safeParse(value);
    if (begin.success) {
      active = { id: begin.data.batch_id, expected: begin.data.event_count, events: [], raw: '' };
      offset += lineBytes;
      continue;
    }
    const end = batchEndSchema.safeParse(value);
    if (end.success) throw new LedgerIntegrityError(`Corrupt batch ${end.data.batch_id}: end without begin`);
    throw new LedgerIntegrityError(`Unknown committed record at byte ${offset}`);
  }
  return { events, committedBytes: committed, ignoredTail: committed < bytes.length };
}

export function truncateSegmentFile(path: string, length: number): void {
  const fd = openSync(path, 'r+');
  try {
    ftruncateSync(fd, length);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Append one complete batch (or the segment header plus one batch) with a
 * single O_APPEND write, then fsync. Synchronous operation keeps the caller's
 * SQLite transaction short: no event-loop yield occurs between BEGIN/COMMIT.
 */
export function appendAtomically(path: string, buffer: Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'a');
  try {
    let offset = 0;
    while (offset < buffer.length) {
      const bytesWritten = writeSync(fd, buffer, offset, buffer.length - offset, null);
      if (bytesWritten === 0) throw new Error('Ledger append wrote zero bytes');
      offset += bytesWritten;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
