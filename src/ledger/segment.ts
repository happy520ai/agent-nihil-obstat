import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ledgerEventSchema, type LedgerEvent } from './event.ts';

const batchBegin = z.object({ record: z.literal('batch.begin'), batch_id: z.string().min(1), event_count: z.number().int().nonnegative() }).strict();
const batchEnd = z.object({ record: z.literal('batch.end'), batch_id: z.string().min(1), event_count: z.number().int().nonnegative(), checksum: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type BatchInput = { id: string; events: LedgerEvent[] };

export function encodeBatch(id: string, events: LedgerEvent[]): Buffer {
  const lines = events.map((event) => JSON.stringify(event) + '\n');
  const checksum = createHash('sha256').update(lines.join('')).digest('hex');
  const begin = JSON.stringify({ record: 'batch.begin', batch_id: id, event_count: events.length }) + '\n';
  const end = JSON.stringify({ record: 'batch.end', batch_id: id, event_count: events.length, checksum }) + '\n';
  return Buffer.from(begin + lines.join('') + end);
}

export function encodeEvents(events: LedgerEvent[]): Buffer {
  return Buffer.from(events.map((event) => JSON.stringify(event) + '\n').join(''));
}

export interface ParsedSegment {
  events: LedgerEvent[];
  committedBytes: number;
  validBytes: number;
  ignoredTail: boolean;
  errors: string[];
}

/**
 * A committed line is written with `\n`. A CRLF checkout (git autocrlf, a
 * text-mode copy) changes the bytes without changing the content, which would
 * otherwise make every stored checksum fail forever. Normalize only `\r\n`
 * line endings before parsing/checksumming; byte offsets still use the raw
 * line so truncation keeps pointing at real file bytes.
 */
export function normalizeLineEnding(line: string): string {
  return line.endsWith('\r\n') ? `${line.slice(0, -2)}\n` : line;
}

export function parseSegment(bytes: Buffer): ParsedSegment {
  const events: LedgerEvent[] = [];
  const errors: string[] = [];
  let offset = 0;
  let lastValid = 0;
  let active: { id: string; expected: number; events: LedgerEvent[]; raw: string } | undefined;
  const lines = bytes.toString('utf8').split(/(?<=\n)/);
  for (const rawLine of lines) {
    if (rawLine === '') continue;
    if (!rawLine.endsWith('\n')) break;
    const line = normalizeLineEnding(rawLine);
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      break;
    }
    const event = ledgerEventSchema.safeParse(value);
    if (event.success && !active) {
      events.push(event.data);
    } else {
      const begin = batchBegin.safeParse(value);
      const end = batchEnd.safeParse(value);
      if (begin.success && !active) {
        active = { id: begin.data.batch_id, expected: begin.data.event_count, events: [], raw: '' };
      } else if (event.success && active) {
        active.events.push(event.data);
        active.raw += line;
      } else if (end.success && active && active.id === end.data.batch_id && active.events.length === active.expected && active.events.length === end.data.event_count && createHash('sha256').update(active.raw).digest('hex') === end.data.checksum) {
        events.push(...active.events);
        active = undefined;
      } else {
        errors.push(`Invalid record at byte ${offset}; remaining tail ignored`);
        break;
      }
    }
    offset += Buffer.byteLength(rawLine);
    lastValid = offset;
  }
  return { events, committedBytes: offset, validBytes: lastValid, ignoredTail: offset < bytes.length, errors };
}

export function parseEvents(bytes: Buffer): { events: LedgerEvent[]; validBytes: number; ignoredTail: boolean } {
  const events: LedgerEvent[] = [];
  let validBytes = 0;
  for (const rawLine of bytes.toString('utf8').split(/(?<=\n)/)) {
    if (!rawLine) continue;
    if (!rawLine.endsWith('\n')) break;
    const parsed = ledgerEventSchema.safeParse(JSON.parse(normalizeLineEnding(rawLine)));
    if (!parsed.success) break;
    events.push(parsed.data);
    validBytes += Buffer.byteLength(rawLine);
  }
  return { events, validBytes, ignoredTail: validBytes < bytes.length };
}
