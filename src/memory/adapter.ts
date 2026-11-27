import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { isValidCursor, makeCursor } from './cursor.ts';
import { codePointLength } from './tokenizer.ts';
import type { Cursor, DiscoverResult, IndexUnit, MemoryProviderAdapter, MessageRole, ParseEvent, ParseResult, ParseStream, SkippedArtifact, TranscriptRecord, Visibility } from './types.ts';

/**
 * The synthetic fixture adapter.
 *
 * This is intentionally the only adapter. It reads a documented, hand-authored
 * fixture shape (`unit.json` + newline-delimited JSON) and refuses anything not
 * explicitly marked `"synthetic": true`. It is not an implementation of any
 * real client's on-disk format and is not advertised as client compatibility.
 *
 * Pure core: `parseTranscriptText` takes bytes and metadata, returns records,
 * a cursor and skipped-line diagnostics. File-system wrappers are thin.
 */

export const SYNTHETIC_FORMAT_VERSION = 'synthetic-v1';
export const SYNTHETIC_MARKER_VERSION = 'synthetic-marker-v1';
export const SYNTHETIC_MAX_TEXT = 1_000_000;

export interface SyntheticAdapterOptions {
  readonly provider: string;
  readonly markerVersion?: string;
  readonly formatVersion?: string;
}

interface UnitMetadata {  readonly synthetic?: unknown;
  readonly format_version?: unknown;
  readonly session_id?: unknown;
  readonly title?: unknown;
  readonly started_at?: unknown;
  readonly visibility?: unknown;
  readonly transcript?: unknown;
  readonly unit_id?: unknown;
}

const ROLES = new Set<MessageRole>(['user', 'assistant', 'system', 'tool', 'unknown']);
const VISIBILITIES = new Set<Visibility>(['visible', 'inactive', 'hidden']);

export class SyntheticFixtureAdapter implements MemoryProviderAdapter {
  readonly provider: string;
  readonly markerVersion: string;
  readonly formatVersion: string;

  constructor(options: SyntheticAdapterOptions) {
    if (!options.provider) throw new Error('Synthetic adapter requires a provider id');
    this.provider = options.provider;
    this.markerVersion = options.markerVersion ?? SYNTHETIC_MARKER_VERSION;
    this.formatVersion = options.formatVersion ?? SYNTHETIC_FORMAT_VERSION;
  }

  async discover(root: string): Promise<DiscoverResult> {
    const units: IndexUnit[] = [];
    const skipped: SkippedArtifact[] = [];
    const seen = new Set<string>();
    const absoluteRoot = resolve(root);
    const entries = await readdir(absoluteRoot, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const unitDirectory = join(absoluteRoot, entry.name);
      const sourcePath = `${entry.name}/transcript.jsonl`;
      let metadata: UnitMetadata;
      try {
        metadata = JSON.parse(await readFile(join(unitDirectory, 'unit.json'), 'utf8')) as UnitMetadata;
      } catch (error) {
        skipped.push(this.skipped(sourcePath, `invalid-unit-metadata:${errorCode(error)}`));
        continue;
      }

      if (metadata.synthetic !== true) {
        skipped.push(this.skipped(sourcePath, 'not-synthetic-fixture'));
        continue;
      }
      const formatVersion = typeof metadata.format_version === 'string' ? metadata.format_version : '';
      if (formatVersion !== this.formatVersion) {
        skipped.push(this.skipped(sourcePath, 'unknown-format-version', formatVersion || undefined));
        continue;
      }
      const visibility = parseVisibility(metadata.visibility, 'visible');
      if (!visibility) {
        skipped.push(this.skipped(sourcePath, 'invalid-visibility', formatVersion));
        continue;
      }
      const unitId = typeof metadata.unit_id === 'string' && metadata.unit_id ? metadata.unit_id : entry.name;
      if (seen.has(unitId)) {
        skipped.push(this.skipped(sourcePath, 'duplicate-unit-id', formatVersion));
        continue;
      }
      const transcriptName = typeof metadata.transcript === 'string' ? metadata.transcript : 'transcript.jsonl';
      if (!safeRelativeFile(transcriptName)) {
        skipped.push(this.skipped(sourcePath, 'unsafe-transcript-path', formatVersion));
        continue;
      }
      const transcriptPath = resolve(unitDirectory, transcriptName);
      if (!isInside(unitDirectory, transcriptPath)) {
        skipped.push(this.skipped(sourcePath, 'unsafe-transcript-path', formatVersion));
        continue;
      }

      let buffer: Buffer;
      let info: Awaited<ReturnType<typeof stat>>;
      try {
        buffer = await readFile(transcriptPath);
        info = await stat(transcriptPath);
      } catch (error) {
        skipped.push(this.skipped(sourcePath, `transcript-unreadable:${errorCode(error)}`, formatVersion));
        continue;
      }

      seen.add(unitId);
      units.push({
        provider: this.provider,
        unitId,
        sourcePath: `${entry.name}/${transcriptName.replaceAll('\\', '/')}`,
        sessionId: typeof metadata.session_id === 'string' && metadata.session_id ? metadata.session_id : unitId,
        title: typeof metadata.title === 'string' ? metadata.title : '',
        startedAt: typeof metadata.started_at === 'string' && Number.isFinite(Date.parse(metadata.started_at))
          ? new Date(metadata.started_at).toISOString()
          : '',
        formatVersion,
        visibility,
        contentHash: sha256(buffer),
        mtimeMs: Math.floor(info.mtimeMs),
        size: info.size,
        absolutePath: transcriptPath,
      });
    }
    return { units, skipped };
  }

  async parse(unit: IndexUnit, cursor?: Cursor): Promise<ParseResult> {
    if (unit.provider !== this.provider) throw new Error(`Adapter ${this.provider} cannot parse unit from ${unit.provider}`);
    if (unit.formatVersion !== this.formatVersion) throw new Error(`Unsupported unit format: ${unit.formatVersion}`);
    if (!unit.absolutePath) throw new Error(`Unit ${unit.unitId} was not produced by discover()`);
    const buffer = await readFile(unit.absolutePath);
    if (sha256(buffer) !== unit.contentHash) throw new Error(`Unit changed while indexing: ${unit.unitId}`);
    return parseTranscriptText(unit, buffer.toString('utf8'), cursor);
  }

  /** Convenience for callers that keep only the provider root. */
  async parseFromRoot(root: string, unit: IndexUnit, cursor?: Cursor): Promise<ParseResult> {
    const absoluteRoot = resolve(root);
    const transcriptPath = resolve(absoluteRoot, unit.sourcePath);
    if (!isInside(absoluteRoot, transcriptPath)) throw new Error(`Unsafe transcript path: ${unit.sourcePath}`);
    const buffer = await readFile(transcriptPath);
    if (sha256(buffer) !== unit.contentHash) throw new Error(`Unit changed while indexing: ${unit.unitId}`);
    return parseTranscriptText(unit, buffer.toString('utf8'), cursor);
  }

  private skipped(sourcePath: string, reason: string, formatVersion?: string): SkippedArtifact {
    return {
      provider: this.provider,
      sourcePath,
      reason,
      ...(formatVersion ? { formatVersion } : {}),
    };
  }
}

/** Pure parser: no file system, no database, no provider-global state. */
export function parseTranscriptText(unit: IndexUnit, transcript: string, cursor?: Cursor): ParseResult {
  const stream = parseTranscriptStream(unit, transcript, cursor);
  const records: TranscriptRecord[] = [];
  const skipped: SkippedArtifact[] = [];
  for (const event of stream.events()) {
    if (event.type === 'record') records.push(event.record);
    else skipped.push(event.artifact);
  }
  return { records, cursor: stream.cursor, fullReplay: stream.fullReplay, skipped };
}

/**
 * Lazy record stream over one unit. Cursor validation happens before the first
 * event; an invalid cursor yields the whole unit and `fullReplay: true`.
 */
export function parseTranscriptStream(unit: IndexUnit, transcript: string, cursor?: Cursor): ParseStream {
  const lines = transcript.replaceAll('\r\n', '\n').split('\n');
  if (lines.length > 0 && lines.at(-1) === '') lines.pop();
  const validCursor = cursor && isValidCursor(cursor, unit) ? cursor : undefined;
  const start = validCursor ? Math.min(validCursor.line, lines.length) : 0;
  const fullReplay = validCursor === undefined;

  function* events(): Generator<ParseEvent> {
    for (let index = start; index < lines.length; index += 1) {
      const lineNumber = index + 1;
      const raw = lines[index] ?? '';
      if (raw.trim() === '') continue;
      const parsed = safeJson(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        yield skippedEvent(unit, `invalid-record-json:line ${lineNumber}`);
        continue;
      }
      const record = parsed as Record<string, unknown>;
      if (record.v !== 1) {
        yield skippedEvent(unit, `unknown-record-version:line ${lineNumber}`);
        continue;
      }
      if (record.type !== 'message') {
        yield skippedEvent(unit, `unknown-record-type:line ${lineNumber}`);
        continue;
      }
      const text = typeof record.text === 'string' ? record.text.replaceAll('\u0000', '\uFFFD') : '';
      if (!text) {
        yield skippedEvent(unit, `empty-text:line ${lineNumber}`);
        continue;
      }
      if (codePointLength(text) > SYNTHETIC_MAX_TEXT) {
        yield skippedEvent(unit, `record-too-large:line ${lineNumber}`);
        continue;
      }
      const timestamp = typeof record.ts === 'string' && Number.isFinite(Date.parse(record.ts))
        ? new Date(record.ts).toISOString()
        : undefined;
      if (!timestamp) {
        yield skippedEvent(unit, `invalid-timestamp:line ${lineNumber}`);
        continue;
      }
      const role = typeof record.role === 'string' && ROLES.has(record.role as MessageRole) ? record.role as MessageRole : 'unknown';
      const visibility = parseVisibility(record.visibility, null) ?? unit.visibility;
      const files = stringList(record.files).map(normalizeFile).filter((file): file is string => file !== undefined);
      const symbols = stringList(record.symbols).filter((symbol) => symbol.length <= 512);
      const suppliedId = typeof record.id === 'string' && record.id.length > 0 && record.id.length <= 200 && !/[\u0000-\u001f]/u.test(record.id)
        ? record.id
        : undefined;
      const toolName = typeof record.tool === 'string' && record.tool.length > 0 && record.tool.length <= 200 ? record.tool : undefined;
      yield {
        type: 'record',
        record: {
          id: suppliedId ?? sha256Text(`${unit.provider}\0${unit.unitId}\0${lineNumber}\0${text}`),
          provider: unit.provider,
          unitId: unit.unitId,
          sessionId: unit.sessionId,
          sourcePath: unit.sourcePath,
          line: lineNumber,
          role,
          text,
          timestamp,
          visibility,
          files: unique(files),
          symbols: unique(symbols),
          ...(toolName ? { toolName } : {}),
        },
      };
    }
  }

  return { cursor: makeCursor(unit, lines.length), fullReplay, lineCount: lines.length, events };
}

function skippedEvent(unit: IndexUnit, reason: string): ParseEvent {
  return { type: 'skipped', artifact: { provider: unit.provider, sourcePath: unit.sourcePath, reason } };
}

function parseVisibility(value: unknown, fallback: Visibility | null): Visibility | null {
  if (value === undefined) return fallback;
  return typeof value === 'string' && VISIBILITIES.has(value as Visibility) ? value as Visibility : null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, 100);
}

function normalizeFile(value: string): string | undefined {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return undefined;
  if (normalized.split('/').includes('..')) return undefined;
  return normalized.slice(0, 512);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function safeRelativeFile(value: string): boolean {
  const normalized = value.replaceAll('\\', '/');
  return normalized.length > 0
    && !normalized.startsWith('/')
    && !/^[A-Za-z]:/.test(normalized)
    && !normalized.split('/').includes('..');
}

function isInside(parent: string, child: string): boolean {
  const normalizedParent = resolve(parent);
  const normalizedChild = resolve(child);
  return normalizedChild === normalizedParent || normalizedChild.startsWith(normalizedParent.endsWith(sep) ? normalizedParent : `${normalizedParent}${sep}`);
}

function safeJson(raw: string): unknown {
  try { return JSON.parse(raw) as unknown; } catch { return undefined; }
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof (error as { code?: unknown }).code === 'string') {
    return (error as { code: string }).code;
  }
  return error instanceof Error ? error.message.slice(0, 120) : 'unknown';
}

function sha256(buffer: Buffer | string): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function sha256Text(text: string): string {
  return sha256(text);
}
