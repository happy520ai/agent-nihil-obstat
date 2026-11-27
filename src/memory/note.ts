import { assertProjectPath } from '../core/paths.ts';
import { canonicalJson } from '../ledger/event.ts';
import { sha256, type MemoryAnchor } from './anchor.ts';

/**
 * Persistent memory (Decision / Pitfall / Memory) is a ledger fact, not a
 * history.db cache row. This module owns validation and the payload shape that
 * the ledger will persist. HistoryStore never writes here.
 *
 * The current ledger event schema has no `note.recorded` kind yet. `NoteSink`
 * is the seam for that integration; the P4 tests use an in-memory book and the
 * phase report states the pending wiring explicitly instead of pretending it
 * exists.
 */

export type MemoryNoteKind = 'decision' | 'pitfall' | 'memory' | 'session_summary';
const NOTE_KINDS = new Set<MemoryNoteKind>(['decision', 'pitfall', 'memory', 'session_summary']);
const ANCHOR_KEYS = new Set(['file', 'symbolId', 'qualifiedName', 'contentFragmentHash', 'contentFragment']);
const MAX_NOTE_TEXT = 100_000;

export interface MemoryNoteInput {
  readonly kind: MemoryNoteKind;
  readonly text: string;
  readonly anchor?: MemoryAnchor;
  readonly createdAt?: string;
}

export interface MemoryNote {
  readonly id: string;
  readonly kind: MemoryNoteKind;
  readonly text: string;
  readonly anchor?: MemoryAnchor;
  readonly createdAt: string;
}

export interface NoteSink {
  persist(note: MemoryNote): Promise<void> | void;
}

export class MemoryNoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryNoteError';
  }
}

/**
 * Validation rules:
 * - memory / decision / pitfall require an Anchor; session_summary must not have one.
 * - anchors use normalized project-relative paths and never carry a line number.
 * - a provided content fragment must match its hash (or the hash is derived).
 */
export function validateMemoryNote(input: MemoryNoteInput, now = new Date().toISOString()): MemoryNote {
  if (typeof input !== 'object' || input === null) throw new MemoryNoteError('Note must be an object');
  const kind = input.kind;
  if (!NOTE_KINDS.has(kind)) throw new MemoryNoteError(`Unknown note kind: ${String(kind)}`);
  if (typeof input.text !== 'string') throw new MemoryNoteError('Note text must be a string');
  const text = input.text.trim();
  if (!text) throw new MemoryNoteError('Note text must be non-empty');
  if (text.length > MAX_NOTE_TEXT) throw new MemoryNoteError(`Note text exceeds ${MAX_NOTE_TEXT} characters`);
  const createdAt = input.createdAt === undefined ? new Date(now).toISOString() : normalizeTimestamp(input.createdAt);

  if (kind === 'session_summary') {
    if (input.anchor !== undefined) throw new MemoryNoteError('Session summary must not carry an anchor');
    return { id: noteId(kind, text, undefined), kind, text, createdAt };
  }
  if (input.anchor === undefined) throw new MemoryNoteError(`${kind} requires an anchor`);
  const anchor = normalizeAnchor(input.anchor);
  return { id: noteId(kind, text, anchor), kind, text, anchor, createdAt };
}

function normalizeAnchor(value: MemoryAnchor): MemoryAnchor {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new MemoryNoteError('Anchor must be an object');
  for (const key of Object.keys(value)) {
    if (!ANCHOR_KEYS.has(key)) throw new MemoryNoteError(`Anchor does not accept field ${JSON.stringify(key)}`);
  }
  const file = value.file;
  if (typeof file !== 'string' || !file) throw new MemoryNoteError('Anchor file must be a non-empty project-relative path');
  try { assertProjectPath(file); } catch { throw new MemoryNoteError(`Anchor file is not a normalized project-relative path: ${file}`); }
  const symbolId = optionalString(value.symbolId, 'symbolId', 256);
  if (symbolId && /:\d+$/u.test(symbolId)) throw new MemoryNoteError('Anchor symbolId must not contain a line number');
  const qualifiedName = optionalString(value.qualifiedName, 'qualifiedName', 512);
  const contentFragment = optionalString(value.contentFragment, 'contentFragment', 10_000);
  let contentFragmentHash = optionalString(value.contentFragmentHash, 'contentFragmentHash', 64);
  if (contentFragmentHash !== undefined && !/^[a-f0-9]{64}$/u.test(contentFragmentHash)) {
    throw new MemoryNoteError('Anchor contentFragmentHash must be a lowercase SHA-256 hex digest');
  }
  if (contentFragment !== undefined) {
    const computed = sha256(contentFragment);
    if (contentFragmentHash !== undefined && contentFragmentHash !== computed) {
      throw new MemoryNoteError('Anchor contentFragmentHash does not match contentFragment');
    }
    contentFragmentHash = computed;
  }
  return {
    file,
    ...(symbolId === undefined ? {} : { symbolId }),
    ...(qualifiedName === undefined ? {} : { qualifiedName }),
    ...(contentFragmentHash === undefined ? {} : { contentFragmentHash }),
    ...(contentFragment === undefined ? {} : { contentFragment }),
  };
}

function optionalString(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) throw new MemoryNoteError(`Anchor ${field} must be a non-empty string`);
  if (value.length > max) throw new MemoryNoteError(`Anchor ${field} exceeds ${max} characters`);
  return value;
}

function normalizeTimestamp(value: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new MemoryNoteError('Note createdAt must be an ISO timestamp');
  return new Date(value).toISOString();
}

function noteId(kind: MemoryNoteKind, text: string, anchor: MemoryAnchor | undefined): string {
  return sha256(canonicalJson({ kind, text, anchor: anchor ?? null }));
}

/**
 * ADR-005 §4: the record embedded in a `memory.revised` payload. Anchors are
 * optional (a governed fact may be pure business content) and the kind
 * vocabulary is narrower than the note kinds: a `session_summary` is
 * historical material and never becomes a versioned fact.
 */
export type MemoryFactKind = 'decision' | 'pitfall' | 'memory';

export interface MemoryFactRecordInput {
  readonly kind: MemoryFactKind;
  readonly text: string;
  readonly anchor?: MemoryAnchor;
}

export interface MemoryFactRecord {
  readonly kind: MemoryFactKind;
  readonly text: string;
  readonly anchor?: MemoryAnchor;
}

/**
 * Validation rules mirror validateMemoryNote (same text bounds, same anchor
 * normalization), except an anchor is not required and session_summary is
 * rejected. The result is the exact `record` object the memory.revised payload
 * carries; its content hash is derived by the projection, never self-reported.
 */
export function validateMemoryFactRecord(input: MemoryFactRecordInput): MemoryFactRecord {
  if (typeof input !== 'object' || input === null) throw new MemoryNoteError('Fact record must be an object');
  if (input.kind !== 'decision' && input.kind !== 'pitfall' && input.kind !== 'memory') {
    throw new MemoryNoteError(`Unknown fact record kind: ${String((input as { kind?: unknown }).kind)}`);
  }
  if (typeof input.text !== 'string') throw new MemoryNoteError('Fact record text must be a string');
  const text = input.text.trim();
  if (!text) throw new MemoryNoteError('Fact record text must be non-empty');
  if (text.length > MAX_NOTE_TEXT) throw new MemoryNoteError(`Fact record text exceeds ${MAX_NOTE_TEXT} characters`);
  const anchor = input.anchor === undefined ? undefined : normalizeAnchor(input.anchor);
  return { kind: input.kind, text, ...(anchor === undefined ? {} : { anchor }) };
}

/** Exact payload the ledger `note.recorded` event should receive once that kind exists. */
export function toLedgerNotePayload(note: MemoryNote): Record<string, unknown> {
  return {
    note_id: note.id,
    kind: note.kind,
    text: note.text,
    created_at: note.createdAt,
    ...(note.anchor ? { anchor: note.anchor } : {}),
  };
}

export interface RecordNoteResult {
  readonly note: MemoryNote;
  readonly duplicate: boolean;
}

/**
 * Minimal in-memory journal used by tests and by the brief aggregator before
 * ledger wiring lands. `persist` is where a ledger-backed sink will be plugged
 * in; it must be idempotent on `note.id`.
 */
export class MemoryNoteBook {
  private readonly notes = new Map<string, MemoryNote>();
  private readonly sink: NoteSink | undefined;

  constructor(sink?: NoteSink) {
    this.sink = sink;
  }

  async record(input: MemoryNoteInput): Promise<RecordNoteResult> {
    const note = validateMemoryNote(input);
    const existing = this.notes.get(note.id);
    if (existing) return { note: existing, duplicate: true };
    if (this.sink) await this.sink.persist(note);
    this.notes.set(note.id, note);
    return { note, duplicate: false };
  }

  list(): MemoryNote[] {
    return [...this.notes.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }

  get(id: string): MemoryNote | undefined {
    return this.notes.get(id);
  }
}
