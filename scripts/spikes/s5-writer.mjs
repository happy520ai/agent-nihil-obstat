#!/usr/bin/env node
// S5 independent segment writer.
//
// Two modes:
//   --file <segment> --source <batch-bytes> --offset <n>
//       Append exactly the first n bytes of <batch-bytes> to <segment>, fsync,
//       print READY, then stay alive until the parent force-kills this process.
//   --lock <path>
//       Exclusively create <path> (Windows/NTFS O_EXCL), print HELD, stay alive.
//
// Appending is deliberately done by this separate process so the S5 runner can
// kill it with SIGKILL / taskkill instead of simulating a crash in-process.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const GENESIS = '0'.repeat(64);

export function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

export function eventHash(event) {
  return sha256(Buffer.from(canonicalJson(event), 'utf8'));
}

// Build one batch: batch.begin + event lines + batch.end.
// batch.end.checksum covers the exact event-line bytes, including '\n'.
export function buildBatch({ batchId, actor, events, prevHash = GENESIS }) {
  let prev = prevHash;
  const builtEvents = [];
  for (const event of events) {
    const record = {
      id: event.id,
      hlc: event.hlc,
      actor,
      kind: event.kind,
      payload: event.payload,
      ...(event.idem_key === undefined ? {} : { idem_key: event.idem_key }),
      prev_hash: prev,
    };
    prev = eventHash(record);
    builtEvents.push(record);
  }

  const eventBuffers = builtEvents.map((event) => Buffer.from(`${JSON.stringify(event)}\n`, 'utf8'));
  const begin = {
    record: 'batch.begin',
    batch_id: batchId,
    actor,
    event_count: builtEvents.length,
    prev_hash: prevHash,
  };
  const end = {
    record: 'batch.end',
    batch_id: batchId,
    event_count: builtEvents.length,
    checksum: sha256(Buffer.concat(eventBuffers)),
  };
  const bytes = Buffer.concat([
    Buffer.from(`${JSON.stringify(begin)}\n`, 'utf8'),
    ...eventBuffers,
    Buffer.from(`${JSON.stringify(end)}\n`, 'utf8'),
  ]);

  return { bytes, events: builtEvents, lastHash: prev, checksum: end.checksum };
}

// Parse committed batches. Anything after the last complete, checksum-valid
// batch.end is an incomplete tail (incompleteStart) and is NOT replayed.
export function parseSegment(buffer) {
  const batches = [];
  let pos = 0;
  let incompleteStart = null;
  let error = null;

  while (pos < buffer.length) {
    const start = pos;
    const newline = buffer.indexOf(0x0a, pos);
    if (newline < 0) {
      incompleteStart = start;
      break;
    }
    const rawLine = buffer.subarray(pos, newline);
    const line = rawLine.toString('utf8');
    pos = newline + 1;

    let record;
    try {
      record = JSON.parse(line);
    } catch {
      incompleteStart = start;
      error = { at: start, reason: 'invalid JSON' };
      break;
    }

    if (record.record !== 'batch.begin') {
      incompleteStart = start;
      error = { at: start, reason: 'expected batch.begin' };
      break;
    }

    const batch = { start, begin: record, events: [], eventBuffers: [], end: null, endPos: null };
    while (pos < buffer.length) {
      const eventLineStart = pos;
      const eventNewline = buffer.indexOf(0x0a, pos);
      if (eventNewline < 0) {
        incompleteStart = batch.start;
        break;
      }
      const eventRaw = buffer.subarray(pos, eventNewline);
      const eventLine = eventRaw.toString('utf8');
      pos = eventNewline + 1;

      let eventRecord;
      try {
        eventRecord = JSON.parse(eventLine);
      } catch {
        incompleteStart = batch.start;
        error = { at: eventLineStart, reason: 'invalid event JSON' };
        break;
      }

      if (eventRecord.record === 'batch.begin') {
        incompleteStart = batch.start;
        error = { at: eventLineStart, reason: 'nested batch.begin' };
        break;
      }

      if (eventRecord.record === 'batch.end') {
        const actualChecksum = sha256(Buffer.concat(batch.eventBuffers));
        const countsMatch = eventRecord.event_count === batch.events.length;
        const checksumMatches = eventRecord.checksum === actualChecksum;
        const idsMatch = eventRecord.batch_id === batch.begin.batch_id;
        if (!countsMatch || !checksumMatches || !idsMatch) {
          incompleteStart = batch.start;
          error = {
            at: batch.start,
            reason: 'batch.end validation failed',
            countsMatch,
            checksumMatches,
            idsMatch,
          };
        } else {
          batch.end = eventRecord;
          batch.endPos = pos;
          batches.push(batch);
        }
        break;
      }

      batch.events.push(eventRecord);
      batch.eventBuffers.push(Buffer.from(`${eventLine}\n`, 'utf8'));
    }

    if (incompleteStart !== null) break;
    if (batch.end === null) {
      incompleteStart = batch.start;
      break;
    }
  }

  const committedBytes = batches.length === 0 ? 0 : batches[batches.length - 1].endPos;
  return { batches, committedBytes, incompleteStart, error };
}

// The segment's own writer is allowed to truncate its incomplete tail.
export function recoverOwnSegment(buffer) {
  const parsed = parseSegment(buffer);
  if (parsed.incompleteStart === null) {
    return { bytes: buffer, truncated: false, parsed, committedBytes: buffer.length };
  }
  return {
    bytes: buffer.subarray(0, parsed.committedBytes),
    truncated: true,
    parsed,
    committedBytes: parsed.committedBytes,
  };
}

// Read-only replay. Incomplete tails from anyone (own or foreign) are ignored;
// callers decide whether the owner may truncate. This function never writes.
export function replaySegment(buffer, expectedPrev = GENESIS) {
  const parsed = parseSegment(buffer);
  const events = parsed.batches.flatMap((batch) => batch.events);
  const errors = [];
  let prev = expectedPrev;
  for (const event of events) {
    if (event.prev_hash !== prev) {
      errors.push({ id: event.id, expected: prev, actual: event.prev_hash });
    }
    prev = eventHash(event);
  }
  return {
    // A deliberate, detectable half-batch count is kept for assertions.
    batches: parsed.batches.length,
    events,
    eventCount: events.length,
    incompleteStart: parsed.incompleteStart,
    committedBytes: parsed.committedBytes,
    chainOk: errors.length === 0,
    chainErrors: errors,
    lastHash: prev,
  };
}

function argValue(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function appendPrefix() {
  const file = argValue('file');
  const source = argValue('source');
  const offset = Number(argValue('offset'));
  if (!file || !source || !Number.isInteger(offset) || offset < 0) {
    throw new Error('usage: --file <segment> --source <batch> --offset <n>');
  }
  const full = fs.readFileSync(source);
  if (offset > full.length) throw new Error(`offset ${offset} > source length ${full.length}`);
  const prefix = full.subarray(0, offset);

  const fd = fs.openSync(file, 'r+');
  try {
    const position = fs.fstatSync(fd).size;
    let written = 0;
    while (written < prefix.length) {
      const n = fs.writeSync(fd, prefix, written, prefix.length - written, position + written);
      if (n <= 0) throw new Error('writeSync made no progress');
      written += n;
    }
    // Durable at the injected boundary. This makes the tested state observable
    // and is the stronger case for recovery (bytes persisted, batch incomplete).
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  process.stdout.write(`READY offset=${offset} bytes=${prefix.length}\n`);
  setInterval(() => {}, 1000);
  setTimeout(() => process.exit(3), 30_000);
}

function holdLock() {
  const lockPath = argValue('lock');
  if (!lockPath) throw new Error('usage: --lock <path>');
  const fd = fs.openSync(lockPath, 'wx');
  fs.writeSync(fd, `${process.pid}\n`);
  process.stdout.write(`HELD pid=${process.pid}\n`);
  setInterval(() => {}, 1000);
  setTimeout(() => process.exit(3), 30_000);
}

// Owner-side recovery, still run as its own process:
// truncate this segment's incomplete tail to the last complete batch.end.
function recoverOwnFile() {
  const file = argValue('recover');
  if (!file) throw new Error('usage: --recover <segment>');
  const buffer = fs.readFileSync(file);
  const parsed = parseSegment(buffer);
  let truncated = false;
  if (parsed.incompleteStart !== null) {
    fs.truncateSync(file, parsed.committedBytes);
    truncated = true;
  }
  process.stdout.write(
    `TRUNCATED truncated=${truncated} committedBytes=${parsed.committedBytes}\n`,
  );
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  try {
    if (argValue('lock')) holdLock();
    else if (argValue('recover')) recoverOwnFile();
    else appendPrefix();
  } catch (error) {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exit(2);
  }
}
