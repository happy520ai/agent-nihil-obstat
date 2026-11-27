import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isValidCursor } from './cursor.ts';
import { codePointLength, ftsExpression, indexText, planTextQuery, tokenizerEnvironment } from './tokenizer.ts';
import type {
  HistorySummary,
  IndexUnit,
  MemoryCounts,
  ParseResult,
  ProviderState,
  RecallHit,
  RecallQuery,
  RecallResult,
  SkippedArtifact,
  SkippedArtifactRow,
  TranscriptRecord,
  Visibility,
} from './types.ts';

/**
 * `history.db` is the single write layer for cached session history. It is a
 * rebuildable cache: adapter output can always be replayed from source files.
 *
 * Every SQL statement that accepts external data binds it with `?`. Recall
 * accepts a closed set of structured fields and rejects anything else, so a
 * transcript or query string is never interpreted as SQL or code.
 */

const SCHEMA_VERSION = '2';
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 20;
const ALLOWED_QUERY_KEYS = new Set(['session', 'from', 'to', 'file', 'symbol', 'keyword', 'provider', 'visibility', 'limit', 'offset']);
const VISIBILITIES: readonly Visibility[] = ['visible', 'inactive', 'hidden'];

/** DROP statements are a fixed list; no identifier ever comes from data. */
const DROP_STATEMENTS = [
  'DROP TABLE IF EXISTS message_fts',
  'DROP TABLE IF EXISTS message_tags',
  'DROP TABLE IF EXISTS messages',
  'DROP TABLE IF EXISTS sessions',
  'DROP TABLE IF EXISTS units',
  'DROP TABLE IF EXISTS skipped_artifacts',
  'DROP TABLE IF EXISTS providers',
  'DROP TABLE IF EXISTS meta',
] as const;

const COUNT_SQL = {
  messages: 'SELECT COUNT(*) AS n FROM messages',
  sessions: 'SELECT COUNT(*) AS n FROM sessions',
  units: 'SELECT COUNT(*) AS n FROM units',
  providers: 'SELECT COUNT(*) AS n FROM providers',
  skipped_artifacts: 'SELECT COUNT(*) AS n FROM skipped_artifacts',
} as const;
type CountTable = keyof typeof COUNT_SQL;

/*
 * Recall filters are a fixed set of structured fields. The SQL below is
 * completely static; every value is bound with `?` and an absent field is
 * bound as NULL. No query text is assembled from caller data.
 */
const RECALL_STRUCTURED_COUNT = `
  SELECT COUNT(*) AS n FROM messages m
  WHERE (? IS NULL OR m.provider = ?)
    AND (? IS NULL OR m.session_id = ?)
    AND (? IS NULL OR m.ts_ms >= ?)
    AND (? IS NULL OR m.ts_ms <= ?)
    AND (? IS NULL OR EXISTS (SELECT 1 FROM message_tags t WHERE t.provider = m.provider AND t.message_id = m.id AND t.kind = 'file' AND t.value = ?))
    AND (? IS NULL OR EXISTS (SELECT 1 FROM message_tags t WHERE t.provider = m.provider AND t.message_id = m.id AND t.kind = 'symbol' AND t.value = ?))
    AND (? IS NULL OR m.visibility = ?)
`;
const RECALL_STRUCTURED_SELECT = `
  SELECT m.* FROM messages m
  WHERE (? IS NULL OR m.provider = ?)
    AND (? IS NULL OR m.session_id = ?)
    AND (? IS NULL OR m.ts_ms >= ?)
    AND (? IS NULL OR m.ts_ms <= ?)
    AND (? IS NULL OR EXISTS (SELECT 1 FROM message_tags t WHERE t.provider = m.provider AND t.message_id = m.id AND t.kind = 'file' AND t.value = ?))
    AND (? IS NULL OR EXISTS (SELECT 1 FROM message_tags t WHERE t.provider = m.provider AND t.message_id = m.id AND t.kind = 'symbol' AND t.value = ?))
    AND (? IS NULL OR m.visibility = ?)
  ORDER BY m.ts_ms DESC, m.provider ASC, m.id ASC
  LIMIT ? OFFSET ?
`;
const RECALL_FTS_COUNT = `
  SELECT COUNT(*) AS n FROM message_fts JOIN messages m ON m.rowid = message_fts.rowid
  WHERE message_fts MATCH ?
    AND (? IS NULL OR m.provider = ?)
    AND (? IS NULL OR m.session_id = ?)
    AND (? IS NULL OR m.ts_ms >= ?)
    AND (? IS NULL OR m.ts_ms <= ?)
    AND (? IS NULL OR EXISTS (SELECT 1 FROM message_tags t WHERE t.provider = m.provider AND t.message_id = m.id AND t.kind = 'file' AND t.value = ?))
    AND (? IS NULL OR EXISTS (SELECT 1 FROM message_tags t WHERE t.provider = m.provider AND t.message_id = m.id AND t.kind = 'symbol' AND t.value = ?))
    AND (? IS NULL OR m.visibility = ?)
`;
const RECALL_FTS_SELECT = `
  SELECT m.*, bm25(message_fts) AS score
  FROM message_fts JOIN messages m ON m.rowid = message_fts.rowid
  WHERE message_fts MATCH ?
    AND (? IS NULL OR m.provider = ?)
    AND (? IS NULL OR m.session_id = ?)
    AND (? IS NULL OR m.ts_ms >= ?)
    AND (? IS NULL OR m.ts_ms <= ?)
    AND (? IS NULL OR EXISTS (SELECT 1 FROM message_tags t WHERE t.provider = m.provider AND t.message_id = m.id AND t.kind = 'file' AND t.value = ?))
    AND (? IS NULL OR EXISTS (SELECT 1 FROM message_tags t WHERE t.provider = m.provider AND t.message_id = m.id AND t.kind = 'symbol' AND t.value = ?))
    AND (? IS NULL OR m.visibility = ?)
  ORDER BY score ASC, m.ts_ms DESC, m.provider ASC, m.id ASC
  LIMIT ? OFFSET ?
`;
const RECALL_LIKE_COUNT = `
  SELECT COUNT(*) AS n FROM messages m
  WHERE m.text LIKE ? ESCAPE '\\'
    AND (? IS NULL OR m.provider = ?)
    AND (? IS NULL OR m.session_id = ?)
    AND (? IS NULL OR m.ts_ms >= ?)
    AND (? IS NULL OR m.ts_ms <= ?)
    AND (? IS NULL OR EXISTS (SELECT 1 FROM message_tags t WHERE t.provider = m.provider AND t.message_id = m.id AND t.kind = 'file' AND t.value = ?))
    AND (? IS NULL OR EXISTS (SELECT 1 FROM message_tags t WHERE t.provider = m.provider AND t.message_id = m.id AND t.kind = 'symbol' AND t.value = ?))
    AND (? IS NULL OR m.visibility = ?)
`;
const RECALL_LIKE_SELECT = `
  SELECT m.* FROM messages m
  WHERE m.text LIKE ? ESCAPE '\\'
    AND (? IS NULL OR m.provider = ?)
    AND (? IS NULL OR m.session_id = ?)
    AND (? IS NULL OR m.ts_ms >= ?)
    AND (? IS NULL OR m.ts_ms <= ?)
    AND (? IS NULL OR EXISTS (SELECT 1 FROM message_tags t WHERE t.provider = m.provider AND t.message_id = m.id AND t.kind = 'file' AND t.value = ?))
    AND (? IS NULL OR EXISTS (SELECT 1 FROM message_tags t WHERE t.provider = m.provider AND t.message_id = m.id AND t.kind = 'symbol' AND t.value = ?))
    AND (? IS NULL OR m.visibility = ?)
  ORDER BY m.ts_ms DESC, m.provider ASC, m.id ASC
  LIMIT ? OFFSET ?
`;

interface MetaRow { key: string; value: string }
interface CountRow { n: number }
interface ProviderRow {
  provider: string;
  marker: string;
  format_version: string;
  status: string;
  error: string;
  indexed_at: string;
  units: number;
  records: number;
  skipped: number;
}
interface UnitRow {
  provider: string;
  unit_id: string;
  source_path: string;
  session_id: string;
  title: string;
  format_version: string;
  visibility: string;
  content_hash: string;
  mtime_ms: number;
  size: number;
  cursor: string;
  started_at: string;
}
interface MessageRow {
  rowid: number;
  id: string;
  provider: string;
  session_id: string;
  unit_id: string;
  source_path: string;
  line: number;
  role: string;
  tool_name: string;
  text: string;
  ts: string;
  ts_ms: number;
  visibility: string;
  score?: number;
}
interface SkippedRow { provider: string; source_path: string; reason: string; format_version: string }
interface VisibilityCountRow { visibility: string; n: number }

export interface HistoryStoreOpenOptions {
  /** Test seam for the database file; production uses `<root>/.ano/cache/history.db`. */
  readonly databasePath?: string;
}

export interface ProviderIngestInput {
  readonly marker: string;
  readonly formatVersion: string;
  readonly status: 'ok' | 'degraded' | 'failed';
  readonly error?: string;
  readonly units: number;
  readonly records: number;
  readonly skipped: number;
}

export interface UnitCursorState {
  readonly contentHash: string;
  readonly cursor: string;
}

/**
 * One provider refresh, applied atomically. Parsing happens before this call;
 * reset, indexing, pruning and the marker/provider update then commit together
 * so a failure can never destroy the previous provider cache.
 */
export interface ProviderIngestBatch {
  readonly markerChanged: boolean;
  readonly units: ReadonlyArray<{ readonly unit: IndexUnit; readonly result: ParseResult }>;
  readonly keepUnitIds: ReadonlySet<string>;
  readonly skipped: readonly SkippedArtifact[];
  readonly marker: string;
  readonly formatVersion: string;
  readonly status: 'ok' | 'degraded';
  readonly error?: string;
}

export class RecallQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecallQueryError';
  }
}

export class HistoryStore {
  private readonly db: DatabaseSync;
  private readonly environment: Record<string, string>;
  private ftsAvailable = false;
  private rebuilt = false;
  private closed = false;

  private constructor(db: DatabaseSync) {
    this.db = db;
    const environment = tokenizerEnvironment();
    this.environment = {
      schema_version: SCHEMA_VERSION,
      tokenizer_version: environment.tokenizerVersion,
      identifier_split_version: environment.identifierSplitVersion,
      fts_configuration: environment.ftsConfiguration,
      icu: environment.icu,
      unicode: environment.unicode,
      segmenter: environment.segmenter,
    };
  }

  static databasePath(root: string): string {
    return join(resolve(root), '.ano', 'cache', 'history.db');
  }

  static open(root: string, options: HistoryStoreOpenOptions = {}): HistoryStore {
    const databasePath = options.databasePath ?? HistoryStore.databasePath(root);
    mkdirSync(join(databasePath, '..'), { recursive: true });
    const db = new DatabaseSync(databasePath);
    const store = new HistoryStore(db);
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      db.exec('PRAGMA journal_mode = WAL');
      store.initialize();
      return store;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  get wasRebuilt(): boolean {
    return this.rebuilt;
  }

  get supportsFts(): boolean {
    return this.ftsAvailable;
  }

  private initialize(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const existing = this.readMeta();
    const hasData = this.tableExists('messages') || this.tableExists('units');
    const hadFts = this.tableExists('message_fts');
    this.createTables();
    const keys = ['schema_version', 'tokenizer_version', 'identifier_split_version', 'fts_configuration', 'icu', 'unicode', 'segmenter'];
    const environmentChanged = hasData && keys.some((key) => existing.get(key) !== this.environment[key]);
    const storedFts = existing.get('fts_available');
    const ftsChanged = hasData && storedFts !== undefined
      && ((storedFts === '1') !== this.ftsAvailable || (storedFts === '1') !== hadFts);
    if (environmentChanged || ftsChanged) {
      this.dropTables();
      this.ftsAvailable = false;
      this.createTables();
      this.rebuilt = true;
    }
    this.writeMeta();
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS providers (
        provider TEXT PRIMARY KEY,
        marker TEXT NOT NULL,
        format_version TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT NOT NULL DEFAULT '',
        indexed_at TEXT NOT NULL,
        units INTEGER NOT NULL DEFAULT 0,
        records INTEGER NOT NULL DEFAULT 0,
        skipped INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS units (
        provider TEXT NOT NULL,
        unit_id TEXT NOT NULL,
        source_path TEXT NOT NULL,
        session_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        format_version TEXT NOT NULL,
        visibility TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        mtime_ms INTEGER NOT NULL,
        size INTEGER NOT NULL,
        cursor TEXT NOT NULL DEFAULT '',
        started_at TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (provider, unit_id)
      );
      CREATE TABLE IF NOT EXISTS sessions (
        provider TEXT NOT NULL,
        session_id TEXT NOT NULL,
        unit_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        started_at TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT '',
        visibility TEXT NOT NULL,
        source_path TEXT NOT NULL,
        PRIMARY KEY (provider, session_id)
      );
      CREATE TABLE IF NOT EXISTS messages (
        provider TEXT NOT NULL,
        id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        unit_id TEXT NOT NULL,
        source_path TEXT NOT NULL,
        line INTEGER NOT NULL,
        role TEXT NOT NULL,
        tool_name TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL,
        ts TEXT NOT NULL,
        ts_ms INTEGER NOT NULL,
        visibility TEXT NOT NULL,
        PRIMARY KEY (provider, id)
      );
      CREATE INDEX IF NOT EXISTS messages_provider ON messages(provider);
      CREATE INDEX IF NOT EXISTS messages_session ON messages(provider, session_id);
      CREATE INDEX IF NOT EXISTS messages_visibility ON messages(visibility);
      CREATE INDEX IF NOT EXISTS messages_ts ON messages(ts_ms);
      CREATE TABLE IF NOT EXISTS message_tags (
        provider TEXT NOT NULL,
        message_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (provider, message_id, kind, value)
      );
      CREATE INDEX IF NOT EXISTS message_tags_lookup ON message_tags(kind, value, provider, message_id);
      CREATE TABLE IF NOT EXISTS skipped_artifacts (
        provider TEXT NOT NULL,
        source_path TEXT NOT NULL,
        reason TEXT NOT NULL,
        format_version TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (provider, source_path, reason)
      );
    `);
    try {
      this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(tokens, tokenize='unicode61')`);
      this.ftsAvailable = true;
    } catch {
      this.ftsAvailable = false;
    }
  }

  private dropTables(): void {
    for (const statement of DROP_STATEMENTS) this.db.exec(statement);
  }

  private tableExists(name: string): boolean {
    const row = this.db.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?`).get(name) as { name?: string } | undefined;
    return row?.name === name;
  }

  private readMeta(): Map<string, string> {
    const rows = this.db.prepare('SELECT key, value FROM meta').all() as unknown as MetaRow[];
    return new Map(rows.map((row) => [row.key, row.value]));
  }

  private writeMeta(): void {
    const statement = this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
    for (const [key, value] of Object.entries(this.environment)) statement.run(key, value);
    statement.run('fts_available', this.ftsAvailable ? '1' : '0');
  }

  getProvider(provider: string): ProviderState | undefined {
    this.assertOpen();
    const row = this.db.prepare('SELECT provider, marker, format_version, status, error, indexed_at, units, records, skipped FROM providers WHERE provider = ?').get(provider) as ProviderRow | undefined;
    return row ? toProviderState(row) : undefined;
  }

  providerMarker(provider: string): string | undefined {
    return this.getProvider(provider)?.marker;
  }

  listProviders(): ProviderState[] {
    this.assertOpen();
    const rows = this.db.prepare('SELECT provider, marker, format_version, status, error, indexed_at, units, records, skipped FROM providers ORDER BY provider').all() as unknown as ProviderRow[];
    return rows.map(toProviderState);
  }

  unitCursor(provider: string, unitId: string): UnitCursorState | undefined {
    this.assertOpen();
    const row = this.db.prepare('SELECT content_hash, cursor FROM units WHERE provider = ? AND unit_id = ?').get(provider, unitId) as { content_hash: string; cursor: string } | undefined;
    return row ? { contentHash: row.content_hash, cursor: row.cursor } : undefined;
  }

  listUnits(provider?: string): Array<{ provider: string; unitId: string; sourcePath: string; visibility: string }> {
    this.assertOpen();
    const rows = provider
      ? this.db.prepare('SELECT provider, unit_id, source_path, visibility FROM units WHERE provider = ? ORDER BY provider, unit_id').all(provider)
      : this.db.prepare('SELECT provider, unit_id, source_path, visibility FROM units ORDER BY provider, unit_id').all();
    return (rows as unknown as UnitRow[]).map((row) => ({ provider: row.provider, unitId: row.unit_id, sourcePath: row.source_path, visibility: row.visibility }));
  }

  skippedArtifacts(provider?: string): SkippedArtifactRow[] {
    this.assertOpen();
    const rows = provider
      ? this.db.prepare('SELECT provider, source_path, reason, format_version FROM skipped_artifacts WHERE provider = ? ORDER BY provider, source_path, reason').all(provider)
      : this.db.prepare('SELECT provider, source_path, reason, format_version FROM skipped_artifacts ORDER BY provider, source_path, reason').all();
    return (rows as unknown as SkippedRow[]).map((row) => ({
      provider: row.provider,
      sourcePath: row.source_path,
      reason: row.reason,
      formatVersion: row.format_version,
    }));
  }

  providerCounts(provider: string): { units: number; records: number; skipped: number } {
    this.assertOpen();
    const count = (sql: string): number => (this.db.prepare(sql).get(provider) as CountRow | undefined)?.n ?? 0;
    return {
      units: count('SELECT COUNT(*) AS n FROM units WHERE provider = ?'),
      records: count('SELECT COUNT(*) AS n FROM messages WHERE provider = ?'),
      skipped: count('SELECT COUNT(*) AS n FROM skipped_artifacts WHERE provider = ?'),
    };
  }

  counts(): MemoryCounts {
    this.assertOpen();
    const count = (table: CountTable): number => {
      const row = this.db.prepare(COUNT_SQL[table]).get() as CountRow | undefined;
      return row?.n ?? 0;
    };
    const visibilityRows = this.db.prepare('SELECT visibility, COUNT(*) AS n FROM messages GROUP BY visibility').all() as unknown as VisibilityCountRow[];
    const byVisibility: Record<Visibility, number> = { visible: 0, inactive: 0, hidden: 0 };
    for (const row of visibilityRows) {
      if (VISIBILITIES.includes(row.visibility as Visibility)) byVisibility[row.visibility as Visibility] = row.n;
    }
    return {
      messages: count('messages'),
      sessions: count('sessions'),
      units: count('units'),
      providers: count('providers'),
      skippedArtifacts: count('skipped_artifacts'),
      byVisibility,
    };
  }

  /**
   * Persist one parsed unit. The caller must pass `parseResult.fullReplay` as
   * returned by the adapter; a full replay replaces all unit messages in the
   * same transaction, while a cursor suffix upserts only new records.
   */
  indexUnit(unit: IndexUnit, result: ParseResult): { inserted: number; deleted: number } {
    this.assertOpen();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const applied = this.indexUnitLocked(unit, result);
      this.db.exec('COMMIT');
      return applied;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private indexUnitLocked(unit: IndexUnit, result: ParseResult): { inserted: number; deleted: number } {
    if (result.records.some((record) => record.provider !== unit.provider || record.unitId !== unit.unitId)) {
      throw new Error(`Parse result does not belong to unit ${unit.provider}/${unit.unitId}`);
    }
    if (!unit.provider || unit.provider !== unit.provider.trim()) throw new Error('Invalid provider id');
    const cursor = result.cursor;
    if (!isValidCursor(cursor, unit)) throw new Error(`Invalid cursor for unit ${unit.unitId}`);
    const deleted = result.fullReplay ? this.deleteUnitMessages(unit.provider, unit.unitId) : 0;
    this.upsertUnit(unit, cursor);
    this.upsertSession(unit, result.records);
    for (const record of result.records) this.upsertMessage(record);
    return { inserted: result.records.length, deleted };
  }

  /**
   * Apply one fully parsed provider refresh in a single transaction:
   * optional reset (marker bump) -> diagnostics -> unit writes -> prune ->
   * provider marker/status. If any step throws, the previous cache is intact.
   */
  applyProviderIngest(provider: string, batch: ProviderIngestBatch): { inserted: number; deleted: number; removedUnits: number } {
    this.assertOpen();
    if (batch.markerChanged) this.assertProviderIsolation(provider, batch);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (batch.markerChanged) this.resetProviderLocked(provider);
      for (const artifact of batch.skipped) this.recordSkipped(artifact);
      let inserted = 0;
      let deleted = 0;
      for (const entry of batch.units) {
        const applied = this.indexUnitLocked(entry.unit, entry.result);
        inserted += applied.inserted;
        deleted += applied.deleted;
      }
      const removedUnits = this.pruneUnitsLocked(provider, batch.keepUnitIds);
      const counts = this.providerCounts(provider);
      this.recordProvider(provider, {
        marker: batch.marker,
        formatVersion: batch.formatVersion,
        status: batch.status,
        error: batch.error ?? '',
        units: counts.units,
        records: counts.records,
        skipped: counts.skipped,
      });
      this.db.exec('COMMIT');
      return { inserted, deleted, removedUnits };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private assertProviderIsolation(provider: string, batch: ProviderIngestBatch): void {
    for (const entry of batch.units) {
      if (entry.unit.provider !== provider || entry.result.records.some((record) => record.provider !== provider)) {
        throw new Error(`Ingest batch mixes providers; expected ${provider}`);
      }
    }
  }

  recordSkipped(artifact: SkippedArtifact): void {
    this.assertOpen();
    this.db.prepare('INSERT OR REPLACE INTO skipped_artifacts (provider, source_path, reason, format_version) VALUES (?, ?, ?, ?)')
      .run(artifact.provider, artifact.sourcePath, artifact.reason, artifact.formatVersion ?? '');
  }

  finishProvider(provider: string, input: ProviderIngestInput): void {
    this.recordProvider(provider, input);
  }

  /** First positional argument is the provider id; the marker column mirrors it by design. */
  recordProvider(provider: string, input: ProviderIngestInput): void {
    this.assertOpen();
    this.db.prepare(`
      INSERT INTO providers (provider, marker, format_version, status, error, indexed_at, units, records, skipped)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET
        marker = excluded.marker,
        format_version = excluded.format_version,
        status = excluded.status,
        error = excluded.error,
        indexed_at = excluded.indexed_at,
        units = excluded.units,
        records = excluded.records,
        skipped = excluded.skipped
    `).run(provider, input.marker, input.formatVersion, input.status, input.error ?? '', new Date().toISOString(), input.units, input.records, input.skipped);
  }

  recordProviderFailure(provider: string, marker: string, formatVersion: string, error: string): void {
    this.assertOpen();
    const previous = this.getProvider(provider);
    this.recordProvider(provider, {
      marker,
      formatVersion,
      status: 'failed',
      error: error.slice(0, 500),
      units: previous?.units ?? 0,
      records: previous?.records ?? 0,
      skipped: previous?.skipped ?? 0,
    });
  }

  /** Removes one provider's rows; other providers are untouched. */
  resetProvider(provider: string): void {
    this.assertOpen();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.resetProviderLocked(provider);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private resetProviderLocked(provider: string): void {
    this.db.prepare('DELETE FROM message_tags WHERE provider = ?').run(provider);
    this.deleteProviderMessages(provider);
    this.db.prepare('DELETE FROM sessions WHERE provider = ?').run(provider);
    this.db.prepare('DELETE FROM units WHERE provider = ?').run(provider);
    this.db.prepare('DELETE FROM skipped_artifacts WHERE provider = ?').run(provider);
    this.db.prepare('DELETE FROM providers WHERE provider = ?').run(provider);
  }

  pruneUnits(provider: string, keepUnitIds: ReadonlySet<string>): number {
    this.assertOpen();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const removed = this.pruneUnitsLocked(provider, keepUnitIds);
      this.db.exec('COMMIT');
      return removed;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private pruneUnitsLocked(provider: string, keepUnitIds: ReadonlySet<string>): number {
    const rows = this.db.prepare('SELECT unit_id FROM units WHERE provider = ?').all(provider) as unknown as Array<{ unit_id: string }>;
    const removed = rows.map((row) => row.unit_id).filter((unitId) => !keepUnitIds.has(unitId));
    for (const unitId of removed) {
      this.deleteUnitMessages(provider, unitId);
      this.db.prepare('DELETE FROM sessions WHERE provider = ? AND unit_id = ?').run(provider, unitId);
      this.db.prepare('DELETE FROM units WHERE provider = ? AND unit_id = ?').run(provider, unitId);
    }
    return removed.length;
  }

  /** Drops all cached history but keeps the (rebuildable) schema. */
  clear(): void {
    this.assertOpen();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('DELETE FROM message_fts');
      this.db.exec('DELETE FROM message_tags; DELETE FROM messages; DELETE FROM sessions; DELETE FROM units; DELETE FROM skipped_artifacts; DELETE FROM providers;');
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  recall(query: RecallQuery): RecallResult {
    this.assertOpen();
    const normalized = normalizeRecallQuery(query);
    const filters = filterBindings(normalized);

    if (normalized.keyword === undefined) {
      const total = this.countStructured(filters);
      const rows = this.db.prepare(RECALL_STRUCTURED_SELECT)
        .all(...filters, normalized.limit, normalized.offset) as unknown as MessageRow[];
      return this.recallResult('structured', null, total, normalized, rows);
    }

    const plan = planTextQuery(normalized.keyword);
    if (plan.mode === 'fts' && this.ftsAvailable) {
      const expression = ftsExpression(plan.tokens);
      const total = this.countFts(expression, filters);
      const rows = this.db.prepare(RECALL_FTS_SELECT)
        .all(expression, ...filters, normalized.limit, normalized.offset) as unknown as MessageRow[];
      return this.recallResult('fts', null, total, normalized, rows);
    }

    const degraded = plan.degraded ?? (this.ftsAvailable ? 'like-fallback' : 'fts5-unavailable');
    const pattern = `%${escapeLike(normalized.keyword)}%`;
    const total = this.countLike(pattern, filters);
    const rows = this.db.prepare(RECALL_LIKE_SELECT)
      .all(pattern, ...filters, normalized.limit, normalized.offset) as unknown as MessageRow[];
    return this.recallResult('like', degraded, total, normalized, rows);
  }

  summary(): HistorySummary {
    this.assertOpen();
    return {
      ftsAvailable: this.ftsAvailable,
      rebuilt: this.rebuilt,
      environment: { ...this.environment, fts_available: this.ftsAvailable ? '1' : '0' },
      counts: this.counts(),
      providers: this.listProviders(),
      skippedArtifacts: this.skippedArtifacts(),
    };
  }

  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }

  private countStructured(filters: ReadonlyArray<string | number | null>): number {
    const row = this.db.prepare(RECALL_STRUCTURED_COUNT).get(...filters) as CountRow | undefined;
    return row?.n ?? 0;
  }

  private countFts(expression: string, filters: ReadonlyArray<string | number | null>): number {
    const row = this.db.prepare(RECALL_FTS_COUNT).get(expression, ...filters) as CountRow | undefined;
    return row?.n ?? 0;
  }

  private countLike(pattern: string, filters: ReadonlyArray<string | number | null>): number {
    const row = this.db.prepare(RECALL_LIKE_COUNT).get(pattern, ...filters) as CountRow | undefined;
    return row?.n ?? 0;
  }

  private recallResult(mode: RecallResult['mode'], degraded: string | null, total: number, query: NormalizedRecallQuery, rows: MessageRow[]): RecallResult {
    const tags = this.tagsFor(rows);
    const hits: RecallHit[] = rows.map((row) => {
      const tag = tags.get(messageKey(row.provider, row.id));
      return {
        id: row.id,
        provider: row.provider,
        sessionId: row.session_id,
        sourcePath: row.source_path,
        line: row.line,
        role: normalizeRole(row.role),
        timestamp: row.ts,
        visibility: row.visibility as Visibility,
        untrusted: true,
        provenance: {
          kind: 'session-transcript',
          provider: row.provider,
          sessionId: row.session_id,
          sourcePath: row.source_path,
          line: row.line,
        },
        text: row.text,
        snippet: snippet(row.text, query.keyword),
        files: tag?.files ?? [],
        symbols: tag?.symbols ?? [],
        ...(row.tool_name ? { toolName: row.tool_name } : {}),
      };
    });
    return {
      mode,
      degraded,
      total,
      limit: query.limit,
      offset: query.offset,
      hits,
      ftsAvailable: this.ftsAvailable,
    };
  }

  /**
   * Tags are keyed by (provider, message_id). The statement is static; each
   * recall row is one indexed lookup, so no identifier list is interpolated.
   */
  private tagsFor(rows: readonly MessageRow[]): Map<string, { files: string[]; symbols: string[] }> {
    const output = new Map<string, { files: string[]; symbols: string[] }>();
    if (rows.length === 0) return output;
    const statement = this.db.prepare('SELECT kind, value FROM message_tags WHERE provider = ? AND message_id = ? ORDER BY kind, value');
    for (const row of rows) {
      const key = messageKey(row.provider, row.id);
      const entry = output.get(key) ?? { files: [], symbols: [] };
      const tags = statement.all(row.provider, row.id) as unknown as Array<{ kind: string; value: string }>;
      for (const tag of tags) {
        if (tag.kind === 'file') entry.files.push(tag.value);
        else if (tag.kind === 'symbol') entry.symbols.push(tag.value);
      }
      output.set(key, entry);
    }
    return output;
  }

  private upsertUnit(unit: IndexUnit, cursor: ParseResult['cursor']): void {
    this.db.prepare(`
      INSERT INTO units (provider, unit_id, source_path, session_id, title, format_version, visibility, content_hash, mtime_ms, size, cursor, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, unit_id) DO UPDATE SET
        source_path = excluded.source_path,
        session_id = excluded.session_id,
        title = excluded.title,
        format_version = excluded.format_version,
        visibility = excluded.visibility,
        content_hash = excluded.content_hash,
        mtime_ms = excluded.mtime_ms,
        size = excluded.size,
        cursor = excluded.cursor,
        started_at = excluded.started_at
    `).run(unit.provider, unit.unitId, unit.sourcePath, unit.sessionId, unit.title, unit.formatVersion, unit.visibility, unit.contentHash, unit.mtimeMs, unit.size, JSON.stringify(cursor), unit.startedAt);
  }

  private upsertSession(unit: IndexUnit, records: readonly TranscriptRecord[]): void {
    const timestamps = records.map((record) => record.timestamp).sort((left, right) => Date.parse(left) - Date.parse(right));
    const updatedAt = timestamps.at(-1) ?? unit.startedAt;
    this.db.prepare(`
      INSERT INTO sessions (provider, session_id, unit_id, title, started_at, updated_at, visibility, source_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, session_id) DO UPDATE SET
        unit_id = excluded.unit_id,
        title = excluded.title,
        started_at = CASE WHEN excluded.started_at = '' THEN sessions.started_at ELSE excluded.started_at END,
        updated_at = CASE WHEN excluded.updated_at = '' THEN sessions.updated_at ELSE excluded.updated_at END,
        visibility = excluded.visibility,
        source_path = excluded.source_path
    `).run(unit.provider, unit.sessionId, unit.unitId, unit.title, unit.startedAt, updatedAt, unit.visibility, unit.sourcePath);
  }

  private upsertMessage(record: TranscriptRecord): void {
    // Identity is (provider, id): the same provider-relative message id from a
    // different provider must never overwrite or delete another provider's row.
    const existing = this.db.prepare('SELECT rowid FROM messages WHERE provider = ? AND id = ?')
      .get(record.provider, record.id) as { rowid: number } | undefined;
    if (existing) {
      if (this.ftsAvailable) this.db.prepare('DELETE FROM message_fts WHERE rowid = ?').run(existing.rowid);
      this.db.prepare('DELETE FROM message_tags WHERE provider = ? AND message_id = ?').run(record.provider, record.id);
      this.db.prepare('DELETE FROM messages WHERE provider = ? AND id = ?').run(record.provider, record.id);
    }
    const result = this.db.prepare(`
      INSERT INTO messages (provider, id, session_id, unit_id, source_path, line, role, tool_name, text, ts, ts_ms, visibility)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.provider,
      record.id,
      record.sessionId,
      record.unitId,
      record.sourcePath,
      record.line,
      record.role,
      record.toolName ?? '',
      record.text,
      record.timestamp,
      Date.parse(record.timestamp),
      record.visibility,
    );
    const rowid = Number(result.lastInsertRowid);
    if (this.ftsAvailable) {
      this.db.prepare('INSERT INTO message_fts (rowid, tokens) VALUES (?, ?)').run(rowid, indexText(record.text));
    }
    const insertTag = this.db.prepare('INSERT OR IGNORE INTO message_tags (provider, message_id, kind, value) VALUES (?, ?, ?, ?)');
    for (const file of record.files) insertTag.run(record.provider, record.id, 'file', file);
    for (const symbol of record.symbols) insertTag.run(record.provider, record.id, 'symbol', symbol);
  }

  private deleteUnitMessages(provider: string, unitId: string): number {
    const rows = this.db.prepare('SELECT rowid FROM messages WHERE provider = ? AND unit_id = ?').all(provider, unitId) as unknown as Array<{ rowid: number }>;
    if (this.ftsAvailable) {
      const deleteFts = this.db.prepare('DELETE FROM message_fts WHERE rowid = ?');
      for (const row of rows) deleteFts.run(row.rowid);
    }
    this.db.prepare('DELETE FROM message_tags WHERE provider = ? AND message_id IN (SELECT id FROM messages WHERE provider = ? AND unit_id = ?)')
      .run(provider, provider, unitId);
    this.db.prepare('DELETE FROM messages WHERE provider = ? AND unit_id = ?').run(provider, unitId);
    return rows.length;
  }

  private deleteProviderMessages(provider: string): number {
    const rows = this.db.prepare('SELECT rowid FROM messages WHERE provider = ?').all(provider) as unknown as Array<{ rowid: number }>;
    if (this.ftsAvailable) {
      const deleteFts = this.db.prepare('DELETE FROM message_fts WHERE rowid = ?');
      for (const row of rows) deleteFts.run(row.rowid);
    }
    this.db.prepare('DELETE FROM messages WHERE provider = ?').run(provider);
    return rows.length;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('HistoryStore is closed');
  }
}

interface NormalizedRecallQuery {
  readonly session?: string;
  readonly fromMs?: number;
  readonly toMs?: number;
  readonly file?: string;
  readonly symbol?: string;
  readonly keyword?: string;
  readonly provider?: string;
  readonly visibility: Visibility | 'all';
  readonly limit: number;
  readonly offset: number;
}

function normalizeRecallQuery(query: RecallQuery): NormalizedRecallQuery {
  if (typeof query !== 'object' || query === null || Array.isArray(query)) throw new RecallQueryError('Recall query must be an object');
  for (const key of Object.keys(query)) {
    if (!ALLOWED_QUERY_KEYS.has(key)) throw new RecallQueryError(`Recall does not accept field ${JSON.stringify(key)}; only structured filters are supported`);
  }
  const stringField = (key: keyof RecallQuery): string | undefined => {
    const value = query[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.length === 0 || value.length > 4096) throw new RecallQueryError(`Recall field ${String(key)} must be a non-empty string`);
    return value;
  };
  const session = stringField('session');
  const from = stringField('from');
  const to = stringField('to');
  const file = stringField('file');
  const symbol = stringField('symbol');
  const keyword = stringField('keyword');
  const provider = stringField('provider');
  const visibility = query.visibility ?? 'visible';
  if (visibility !== 'all' && !VISIBILITIES.includes(visibility)) throw new RecallQueryError('Recall visibility must be visible, inactive, hidden or all');
  const fromMs = from === undefined ? undefined : Date.parse(from);
  const toMs = to === undefined ? undefined : Date.parse(to);
  if (from !== undefined && !Number.isFinite(fromMs)) throw new RecallQueryError('Recall field from must be an ISO timestamp');
  if (to !== undefined && !Number.isFinite(toMs)) throw new RecallQueryError('Recall field to must be an ISO timestamp');
  if (fromMs !== undefined && toMs !== undefined && fromMs > toMs) throw new RecallQueryError('Recall field from must not be after to');
  const limit = query.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new RecallQueryError(`Recall limit must be an integer between 1 and ${MAX_LIMIT}`);
  const offset = query.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0 || offset > 1_000_000) throw new RecallQueryError('Recall offset must be a non-negative integer');
  return {
    ...(session === undefined ? {} : { session }),
    ...(fromMs === undefined ? {} : { fromMs }),
    ...(toMs === undefined ? {} : { toMs }),
    ...(file === undefined ? {} : { file }),
    ...(symbol === undefined ? {} : { symbol }),
    ...(keyword === undefined ? {} : { keyword }),
    ...(provider === undefined ? {} : { provider }),
    visibility,
    limit,
    offset,
  };
}

function normalizeRole(value: string): RecallHit['role'] {
  return value === 'user' || value === 'assistant' || value === 'system' || value === 'tool' ? value : 'unknown';
}

/**
 * Positional bindings for the static recall SQL. Absent filters bind as NULL,
 * which makes their `(? IS NULL OR ...)` guard a no-op.
 */
function filterBindings(query: NormalizedRecallQuery): Array<string | number | null> {
  const visibility = query.visibility === 'all' ? null : query.visibility;
  return [
    query.provider ?? null, query.provider ?? null,
    query.session ?? null, query.session ?? null,
    query.fromMs ?? null, query.fromMs ?? null,
    query.toMs ?? null, query.toMs ?? null,
    query.file ?? null, query.file ?? null,
    query.symbol ?? null, query.symbol ?? null,
    visibility, visibility,
  ];
}

function messageKey(provider: string, id: string): string {
  return `${provider}\u0000${id}`;
}

function toProviderState(row: ProviderRow): ProviderState {
  const status = row.status === 'ok' || row.status === 'degraded' ? row.status : 'failed';
  return {
    provider: row.provider,
    marker: row.marker,
    formatVersion: row.format_version,
    status,
    error: row.error,
    indexedAt: row.indexed_at,
    units: row.units,
    records: row.records,
    skipped: row.skipped,
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, (match) => `\\${match}`);
}

/** Original-column excerpt, never the tokenized index text. */
function snippet(text: string, keyword: string | undefined): string {
  const MAX = 160;
  if (codePointLength(text) <= MAX) return text;
  if (!keyword) return `${[...text].slice(0, MAX).join('')}…`;
  const lowerText = text.toLowerCase();
  const lowerKeyword = keyword.toLowerCase();
  const at = lowerText.indexOf(lowerKeyword);
  const codepoints = [...text];
  if (at < 0) return `${codepoints.slice(0, MAX).join('')}…`;
  const matchStart = [...text.slice(0, at)].length;
  const start = Math.max(0, matchStart - 40);
  const end = Math.min(codepoints.length, start + MAX);
  return `${start > 0 ? '…' : ''}${codepoints.slice(start, end).join('')}${end < codepoints.length ? '…' : ''}`;
}
