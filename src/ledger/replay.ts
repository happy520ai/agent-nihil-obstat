import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareHlc } from '../core/hlc.ts';
import { eventChain, hashEvent, type LedgerEvent } from './event.ts';
import { listSegmentFiles, scanSegment, truncateSegmentFile } from './append.ts';
import { LedgerIntegrityError, type ViewReplayEntry } from './views.ts';

export interface SegmentReplay {
  name: string;
  events: LedgerEvent[];
  ignoredTail: boolean;
  committedBytes: number;
  bytes: number;
}

export interface ObservedIssue {
  /** Segment whose header promised the observation. */
  segment: string;
  /** Segment path named by that header. */
  path: string;
  reason: 'missing' | 'head-mismatch' | 'malformed';
}

export interface ReplayResult {
  segments: SegmentReplay[];
  entries: ViewReplayEntry[];
  ignoredTailSegments: string[];
  observedIssues: ObservedIssue[];
}

export interface ReplayOptions {
  /** The one segment this process is allowed to truncate. */
  ownSegment?: string;
  truncateOwn?: boolean;
  /** Fail closed by default when an observed segment is missing or its head changed. */
  onObservedIssue?: 'throw' | 'degrade';
}

const observedPath = /^[^/\\]+\.jsonl$/u;

/**
 * Reads the `observed` map from a segment header: segment path -> head hash
 * (the hash of that segment's first event). Older headers have no such field;
 * they make no promise and are accepted unchanged.
 */
function observedFrom(event: LedgerEvent | undefined): Record<string, string> | undefined {
  if (!event || event.kind !== 'segment.started') return undefined;
  const value = event.payload.observed;
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, string>;
}

/**
 * Read every segment independently, validate its single-segment hash chain,
 * and produce a globally HLC-ordered event list for the views.
 *
 * Foreign segments are never modified: an unterminated batch is ignored. The
 * own segment may have that tail truncated, because this process is its
 * writer and recovery is its responsibility.
 *
 * Observed-head check: a `segment.started` header lists the head hash of every
 * segment its writer could see. If one of those segments is now missing, or its
 * first event changed, replay fails closed (default) instead of silently
 * serving a smaller history. Segments created after that header are simply not
 * listed, so they are not an error.
 *
 * Kept synchronous so a caller can keep a SQLite write transaction short.
 */
export function replayLedger(directory: string, options: ReplayOptions = {}): ReplayResult {
  const names = listSegmentFiles(directory);
  const segments: SegmentReplay[] = [];
  const scannedByName = new Map<string, ReturnType<typeof scanSegment>>();
  const heads = new Map<string, string>();

  for (const name of names) {
    const path = join(directory, name);
    const bytes = readFileSync(path);
    let scanned;
    try {
      scanned = scanSegment(bytes);
    } catch (error) {
      if (error instanceof LedgerIntegrityError) throw new LedgerIntegrityError(`${error.message} (segment ${name})`);
      throw error;
    }
    if (!eventChain(scanned.events)) throw new LedgerIntegrityError(`Invalid hash chain in segment ${name}`);
    scannedByName.set(name, scanned);
    const head = scanned.events[0];
    if (head) heads.set(name, hashEvent(head));
    segments.push({
      name,
      events: scanned.events,
      ignoredTail: scanned.ignoredTail,
      committedBytes: scanned.committedBytes,
      bytes: bytes.length,
    });
  }

  const observedIssues: ObservedIssue[] = [];
  for (const segment of segments) {
    const observed = observedFrom(segment.events[0]);
    if (!observed) continue;
    for (const [path, head] of Object.entries(observed)) {
      if (!observedPath.test(path) || typeof head !== 'string' || !/^[a-f0-9]{64}$/u.test(head)) {
        observedIssues.push({ segment: segment.name, path, reason: 'malformed' });
        continue;
      }
      if (path === segment.name) continue;
      const actual = heads.get(path);
      if (actual === undefined) observedIssues.push({ segment: segment.name, path, reason: 'missing' });
      else if (actual !== head) observedIssues.push({ segment: segment.name, path, reason: 'head-mismatch' });
    }
  }
  if (observedIssues.length > 0 && (options.onObservedIssue ?? 'throw') === 'throw') {
    const issue = observedIssues[0]!;
    const detail = issue.reason === 'missing'
      ? `observed segment ${issue.path} is missing`
      : issue.reason === 'head-mismatch'
        ? `observed segment ${issue.path} has a different head hash`
        : `observed entry ${issue.path} is malformed`;
    throw new LedgerIntegrityError(`Segment ${issue.segment} is degraded: ${detail}`);
  }

  const entries: ViewReplayEntry[] = [];
  const seen = new Map<string, string>();
  for (const segment of segments) {
    const scanned = scannedByName.get(segment.name)!;
    for (const event of scanned.events) {
      const prior = seen.get(event.id);
      if (prior !== undefined) throw new LedgerIntegrityError(`Duplicate committed event id ${event.id} in segments ${prior} and ${segment.name}`);
      seen.set(event.id, segment.name);
      entries.push({ event, segment: segment.name });
    }
    if (options.truncateOwn === true && options.ownSegment === segment.name && scanned.ignoredTail) {
      truncateSegmentFile(join(directory, segment.name), scanned.committedBytes);
    }
  }

  entries.sort((left, right) => compareHlc(left.event.hlc, right.event.hlc) || left.event.id.localeCompare(right.event.id));
  return {
    segments,
    entries,
    ignoredTailSegments: segments.filter((segment) => segment.ignoredTail).map((segment) => segment.name),
    observedIssues,
  };
}
