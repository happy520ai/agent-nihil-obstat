import { basename } from 'node:path';
import { canonicalJson, sha256Hex, slugify } from './canonical.ts';
import { ConnectSourceError } from './errors.ts';
import type { SourceScan } from './adapter.ts';
import type {
  ConnectIdentity,
  ConnectedIdentity,
  ConnectedTask,
  ConnectTaskCategory,
  StoredRecord,
} from './types.ts';

export interface ExtractedRecords {
  records: StoredRecord[];
  recordCounts: Record<string, number>;
  warnings: string[];
}

export function categoryForStatus(status: string): ConnectTaskCategory {
  switch (status.trim().toLowerCase()) {
    case 'done':
    case 'completed':
    case 'complete':
    case 'finished':
      return 'completed';
    case 'in_progress':
    case 'in-progress':
    case 'doing':
    case 'active':
      return 'in_progress';
    case 'todo':
    case 'pending':
    case 'planned':
      return 'todo';
    case 'cancelled':
    case 'canceled':
    case 'cancel':
      return 'cancelled';
    default:
      return 'unknown';
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConnectSourceError(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new ConnectSourceError(`${label} must be a JSON array`);
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sourceIdOf(item: Record<string, unknown>, label: string): string {
  const id = item.id ?? item.key;
  if (typeof id === 'string' && id.trim().length > 0) return id.trim();
  if (typeof id === 'number' && Number.isFinite(id)) return String(id);
  throw new ConnectSourceError(`${label} is missing a usable id`);
}

class RecordFactory {
  private readonly usedIds = new Map<string, Set<string>>();
  private readonly seenSourceIds = new Map<string, Set<string>>();
  private readonly connectionId: string;
  private readonly identity: ConnectIdentity;

  constructor(connectionId: string, identity: ConnectIdentity) {
    this.connectionId = connectionId;
    this.identity = identity;
  }

  create(
    kind: string,
    sourceId: string,
    title: string,
    status: string,
    sourcePath: string,
    searchText: string,
    raw: Record<string, unknown>,
  ): StoredRecord {
    const seen = this.seenSourceIds.get(kind) ?? new Set<string>();
    if (seen.has(sourceId)) {
      throw new ConnectSourceError(`Duplicate ${kind} source id: ${sourceId}`);
    }
    seen.add(sourceId);
    this.seenSourceIds.set(kind, seen);

    const id = this.uniqueId(kind, sourceId);
    const identity: ConnectedIdentity = { ...this.identity, kind, id };
    return {
      id,
      kind,
      sourceId,
      title,
      status,
      category: categoryForStatus(status),
      sourcePath,
      text: searchText,
      raw,
      identity,
    };
  }

  private uniqueId(kind: string, sourceId: string): string {
    const base = `${this.connectionId}-${kind}-${slugify(sourceId, 64)}`;
    const used = this.usedIds.get(kind) ?? new Set<string>();
    let candidate = base;
    if (used.has(candidate)) {
      candidate = `${base}-${sha256Hex(sourceId).slice(0, 8)}`;
    }
    if (used.has(candidate)) {
      throw new ConnectSourceError(`Cannot derive a unique id for ${kind} source id: ${sourceId}`);
    }
    used.add(candidate);
    this.usedIds.set(kind, used);
    return candidate;
  }
}

function archiveKindFor(path: string): string {
  if (path.startsWith('.runtime/')) return 'runtime';
  if (path.startsWith('snapshots/')) return 'snapshot';
  if (path.startsWith('quality-runs/')) return 'quality-run';
  if (path.startsWith('decisions/') && path.endsWith('.md')) return 'decision';
  if (path.endsWith('.jsonl') || path.endsWith('.ndjson') || path.endsWith('.log')) return 'log';
  return 'archive';
}

function knownJsonKind(path: string): string | undefined {
  switch (path) {
    case 'tasks.json':
    case 'roadmap.json':
    case 'features.json':
    case 'sessions.json':
    case 'decisions.json':
    case 'project.json':
    case 'governance.json':
    case 'orchestrator.json':
    case 'security.json':
    case 'debuglog.json':
    case 'file-notes.json':
      return path.replace(/\.json$/, '');
    default:
      return undefined;
  }
}

function searchable(parts: ReadonlyArray<unknown>): string {
  return parts.filter((part) => typeof part === 'string' && part.length > 0).join('\n');
}

function recordCollection(
  factory: RecordFactory,
  kind: string,
  items: readonly unknown[],
  label: string,
  sourcePath: string,
  titleOf: (item: Record<string, unknown>) => string,
  statusOf: (item: Record<string, unknown>) => string,
): StoredRecord[] {
  const records: StoredRecord[] = [];
  for (const item of items) {
    const object = asObject(item, `${label} entry`);
    const sourceId = sourceIdOf(object, `${label} entry`);
    const title = titleOf(object) || sourceId;
    const status = statusOf(object);
    records.push(
      factory.create(kind, sourceId, title, status, sourcePath, searchable([title, status, object.detail, object.description, object.summary, object.goal, object.name]), object),
    );
  }
  return records;
}

export function extractRecords(scan: SourceScan, connectionId: string): ExtractedRecords {
  const factory = new RecordFactory(connectionId, scan.identity);
  const records: StoredRecord[] = [];
  const warnings: string[] = [];

  for (const file of scan.files) {
    if (file.binary) {
      records.push(
        factory.create(
          archiveKindFor(file.path),
          file.path,
          file.path,
          'unknown',
          file.path,
          '',
          { path: file.path, bytes: file.bytes, hash: file.hash, mediaType: file.mediaType, binary: true },
        ),
      );
      continue;
    }

    const content = file.content.toString('utf8');
    const knownKind = knownJsonKind(file.path);

    if (file.path.endsWith('.json')) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(content) as unknown;
      } catch (error) {
        throw new ConnectSourceError(`Malformed JSON in source file ${file.path}: ${error instanceof Error ? error.message : String(error)}`);
      }

      if (file.path === 'tasks.json') {
        const object = asObject(parsed, file.path);
        const tasks = asArray(object.tasks, `${file.path}.tasks`);
        records.push(
          ...recordCollection(factory, 'task', tasks, `${file.path}.tasks`, file.path, (item) => text(item.title), (item) => text(item.status) || 'unknown'),
        );
        continue;
      }
      if (file.path === 'roadmap.json') {
        const object = asObject(parsed, file.path);
        const milestones = asArray(object.milestones, `${file.path}.milestones`);
        records.push(
          ...recordCollection(factory, 'milestone', milestones, `${file.path}.milestones`, file.path, (item) => text(item.title) || text(item.goal), (item) => text(item.status) || 'unknown'),
        );
        continue;
      }
      if (file.path === 'features.json') {
        const object = asObject(parsed, file.path);
        const features = asArray(object.features, `${file.path}.features`);
        records.push(
          ...recordCollection(factory, 'feature', features, `${file.path}.features`, file.path, (item) => text(item.name) || text(item.title), (item) => text(item.status) || 'unknown'),
        );
        continue;
      }
      if (file.path === 'sessions.json') {
        const object = asObject(parsed, file.path);
        const sessions = asArray(object.sessions, `${file.path}.sessions`);
        records.push(
          ...recordCollection(factory, 'session', sessions, `${file.path}.sessions`, file.path, (item) => text(item.summary) || text(item.title), (item) => text(item.status) || 'unknown'),
        );
        continue;
      }
      if (file.path === 'decisions.json') {
        const decisions = Array.isArray(parsed) ? parsed : asObject(parsed, file.path).decisions;
        records.push(
          ...recordCollection(factory, 'decision', asArray(decisions, `${file.path}.decisions`), `${file.path}.decisions`, file.path, (item) => text(item.title) || text(item.name), (item) => text(item.status) || 'unknown'),
        );
        continue;
      }
      if (knownKind) {
        const object = asObject(parsed, file.path);
        records.push(factory.create(knownKind, file.path, file.path, 'unknown', file.path, searchable([content]), object));
        continue;
      }
      // Unknown JSON: keep it searchable as a generic archive record.
      const raw = isObject(parsed) ? parsed : { value: parsed };
      records.push(
        factory.create(archiveKindFor(file.path), file.path, file.path, 'unknown', file.path, content, raw),
      );
      continue;
    }

    if (file.path.endsWith('.jsonl') || file.path.endsWith('.ndjson')) {
      let parsedLines = 0;
      const invalidLines: number[] = [];
      content.split(/\r?\n/).forEach((line, index) => {
        if (line.trim().length === 0) return;
        try {
          JSON.parse(line);
          parsedLines += 1;
        } catch {
          invalidLines.push(index + 1);
        }
      });
      if (invalidLines.length > 0) {
        warnings.push(`${file.path}: skipped ${invalidLines.length} unparseable JSONL line(s) (${invalidLines.slice(0, 5).join(', ')}).`);
      }
      records.push(
        factory.create('log', file.path, file.path, 'unknown', file.path, content, { path: file.path, bytes: file.bytes, parsedLines }),
      );
      continue;
    }

    if (file.path.startsWith('decisions/') && file.path.endsWith('.md')) {
      const name = basename(file.path, '.md');
      const heading = content.split(/\r?\n/).find((line) => line.startsWith('#'));
      const title = heading ? heading.replace(/^#+\s*/, '').trim() : name;
      records.push(factory.create('decision', name, title, 'unknown', file.path, searchable([title, content]), { path: file.path, title, content }));
      continue;
    }

    records.push(
      factory.create(archiveKindFor(file.path), file.path, file.path, 'unknown', file.path, content, {
        path: file.path,
        bytes: file.bytes,
        mediaType: file.mediaType,
        binary: false,
      }),
    );
  }

  const recordCounts: Record<string, number> = {};
  for (const record of records) {
    recordCounts[record.kind] = (recordCounts[record.kind] ?? 0) + 1;
  }

  return { records, recordCounts, warnings };
}

export function toConnectedTask(record: StoredRecord): ConnectedTask {
  const raw = record.raw;
  return {
    id: record.id,
    sourceId: record.sourceId,
    title: record.title,
    status: record.status,
    category: record.category,
    verification: 'unverified',
    sourcePath: record.sourcePath,
    raw,
    identity: record.identity,
    ...(typeof raw.milestone === 'string' ? { milestone: raw.milestone } : {}),
    ...(typeof raw.priority === 'string' ? { priority: raw.priority } : {}),
    ...(typeof raw.type === 'string' ? { type: raw.type } : {}),
  };
}

export function recordsFingerprint(records: readonly StoredRecord[]): string {
  return sha256Hex(canonicalJson(records.map((record) => ({ kind: record.kind, sourceId: record.sourceId, raw: record.raw, title: record.title, status: record.status }))));
}
