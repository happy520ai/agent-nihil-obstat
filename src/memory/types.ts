/**
 * P4 Memory contracts.
 *
 * Adapters are pure read-side functions: `discover` returns index units and
 * `parse` returns records plus a cursor. They never touch a database. The only
 * write layer for session history is `HistoryStore` (history.db).
 *
 * All adapters shipped here read hand-authored *synthetic* fixtures and do not
 * claim compatibility with any real client's session format.
 */

export type Visibility = 'visible' | 'inactive' | 'hidden';
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool' | 'unknown';

export interface IndexUnit {
  readonly provider: string;
  readonly unitId: string;
  /** Provider-relative path, normalized with forward slashes. */
  readonly sourcePath: string;
  /**
   * Absolute transcript path discovered by the adapter. It is deliberately not
   * persisted by HistoryStore; it only lets `parse(unit, cursor)` stay a pure
   * read-side function with no provider-global state.
   */
  readonly absolutePath?: string;
  readonly sessionId: string;
  readonly title: string;
  readonly startedAt: string;
  readonly formatVersion: string;
  readonly visibility: Visibility;
  readonly contentHash: string;
  readonly mtimeMs: number;
  readonly size: number;
}

export interface SkippedArtifact {
  readonly provider: string;
  readonly sourcePath: string;
  readonly reason: string;
  readonly formatVersion?: string;
}

export interface DiscoverResult {
  readonly units: readonly IndexUnit[];
  readonly skipped: readonly SkippedArtifact[];
}

export interface TranscriptRecord {
  readonly id: string;
  readonly provider: string;
  readonly unitId: string;
  readonly sessionId: string;
  readonly sourcePath: string;
  readonly line: number;
  readonly role: MessageRole;
  readonly text: string;
  readonly timestamp: string;
  readonly visibility: Visibility;
  readonly files: readonly string[];
  readonly symbols: readonly string[];
  readonly toolName?: string;
}

export interface ParseResult {
  readonly records: readonly TranscriptRecord[];
  readonly cursor: Cursor;
  /**
   * True when the adapter returned the whole unit rather than a suffix after
   * a cursor (no cursor was supplied, or it was invalid).
   */
  readonly fullReplay: boolean;
  readonly skipped: readonly SkippedArtifact[];
}

export type ParseEvent =
  | { readonly type: 'record'; readonly record: TranscriptRecord }
  | { readonly type: 'skipped'; readonly artifact: SkippedArtifact };

/** Lazy record stream: callers can consume records without materializing them. */
export interface ParseStream {
  readonly cursor: Cursor;
  readonly fullReplay: boolean;
  readonly lineCount: number;
  readonly events: () => Iterable<ParseEvent>;
}

export interface MemoryProviderAdapter {
  readonly provider: string;
  readonly markerVersion: string;
  readonly formatVersion: string;
  discover(root: string): Promise<DiscoverResult>;
  parse(unit: IndexUnit, cursor?: Cursor): Promise<ParseResult>;
}

export interface Cursor {
  readonly v: 1;
  readonly unitId: string;
  readonly contentHash: string;
  /** Number of transcript lines already consumed. */
  readonly line: number;
}

export interface ProviderState {
  readonly provider: string;
  readonly marker: string;
  readonly formatVersion: string;
  readonly status: 'ok' | 'degraded' | 'failed';
  readonly error: string;
  readonly indexedAt: string;
  readonly units: number;
  readonly records: number;
  readonly skipped: number;
}

export interface SkippedArtifactRow {
  readonly provider: string;
  readonly sourcePath: string;
  readonly reason: string;
  readonly formatVersion: string;
}

export interface VisibilityFilter {
  readonly visibility?: Visibility | 'all';
}

export interface RecallQuery extends VisibilityFilter {
  readonly session?: string;
  readonly from?: string;
  readonly to?: string;
  readonly file?: string;
  readonly symbol?: string;
  readonly keyword?: string;
  readonly provider?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface TranscriptProvenance {
  readonly kind: 'session-transcript';
  readonly provider: string;
  readonly sessionId: string;
  readonly sourcePath: string;
  readonly line: number;
}

export interface RecallHit {
  readonly id: string;
  readonly provider: string;
  readonly sessionId: string;
  readonly sourcePath: string;
  readonly line: number;
  readonly role: MessageRole;
  readonly timestamp: string;
  readonly visibility: Visibility;
  /** Transcript text is untrusted data: callers must never execute or evaluate it. */
  readonly untrusted: true;
  readonly provenance: TranscriptProvenance;
  readonly text: string;
  /** Original-column excerpt; never built from tokenized text. */
  readonly snippet: string;
  readonly files: readonly string[];
  readonly symbols: readonly string[];
  readonly toolName?: string;
}

export interface RecallResult {
  readonly mode: 'structured' | 'fts' | 'like';
  readonly degraded: string | null;
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly hits: readonly RecallHit[];
  readonly ftsAvailable: boolean;
}

export interface MemoryCounts {
  readonly messages: number;
  readonly sessions: number;
  readonly units: number;
  readonly providers: number;
  readonly skippedArtifacts: number;
  readonly byVisibility: Readonly<Record<Visibility, number>>;
}

export interface HistorySummary {
  readonly ftsAvailable: boolean;
  readonly rebuilt: boolean;
  readonly environment: Readonly<Record<string, string>>;
  readonly counts: MemoryCounts;
  readonly providers: readonly ProviderState[];
  readonly skippedArtifacts: readonly SkippedArtifactRow[];
}
