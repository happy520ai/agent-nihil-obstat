import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonicalJson } from '../ledger/event.ts';
import {
  applyEventToDb,
  initViews,
  readMemoryEdges,
  readMemoryRecords,
  resetViews,
  viewDigest,
  type MemoryRecord,
  type ViewReplayEntry,
} from '../ledger/views.ts';
import type {
  AnchorProbeRecordStatus,
  AnchorProbeSnapshot,
  AnchorProbeSource,
  AnchorProbeSourceHealth,
} from './probe-contract.ts';
import type {
  ProbeAnchorHealth,
  ProbeCandidate,
  ProbeCandidateSource,
  ProbeEdge,
  ProbeEntryQuery,
} from './probe.ts';

/**
 * ProbeStore: the storage abstraction behind the AnchorProbe read core.
 *
 * The P0 core only needs three operations (`snapshot`, `candidates`,
 * `adjacency`); the wider port below is modelled on the reads the probe and the
 * Surface actually perform so a second backend (the T-059 BitChain experiment)
 * can be swapped in without touching the core:
 *
 *   - candidates: entry routing plus the full record set used by the slow path;
 *   - adjacency: typed relations for bounded traversal, optionally scoped to
 *     one record (`ref`) so incoming and outgoing edges can be reported;
 *   - evidence/status/provenance: the frozen payload families a consumer needs
 *     after traversal, without re-reading the candidate index;
 *   - snapshotIdentity: the four bound component digests plus a stable
 *     fingerprint, so two stores over the same commit can be told apart.
 *
 * Implementations are read-only over the committed ledger. The SQLite baseline
 * below is a rebuildable cache: `rebuild` re-derives every row from committed
 * events through the ADR-005 §10 projection, and `refresh` detects a damaged or
 * stale cache and rebuilds it. Neither the cache nor a BitChain experiment is an
 * authoritative write source.
 */

/** Frozen evidence fields the response exposes, independent of routing. */
export interface ProbeEvidencePayload {
  readonly record_ref: string;
  readonly content_hash: string;
  readonly status: AnchorProbeRecordStatus;
  readonly source_health: AnchorProbeSourceHealth;
  readonly recorded_at: string;
  /** Null means the effective interval is unknown, never the epoch. */
  readonly effective_from: string | null;
  readonly source: AnchorProbeSource;
  readonly content: string;
}

/** Version/state half of a record, decoupled from its content payload. */
export interface ProbeStatusView {
  readonly record_ref: string;
  readonly status: AnchorProbeRecordStatus;
  readonly eligibility: 'governed' | 'legacy_unreviewed' | 'unknown';
  /** Projection-derived revision depth; informational, never an identity. */
  readonly version: number | null;
  readonly superseded_by: string | null;
  readonly effective_from: string | null;
  readonly effective_to: string | null;
}

/** Source half of a record: where it came from and how far it may be trusted. */
export interface ProbeProvenanceView {
  readonly record_ref: string;
  readonly source: AnchorProbeSource;
  readonly source_health: AnchorProbeSourceHealth;
  readonly qualifiers: readonly string[];
  readonly anchor: ProbeAnchorHealth;
}

/**
 * Snapshot identity. `fingerprint` is sha256 over the canonical four-digest
 * tuple, so equal fingerprints mean the same sampled commit across backends.
 *
 * The cluster fields are optional and additive (T-124): a backend whose
 * snapshot has no `cluster` segment omits them entirely, so every pre-
 * distributed backend keeps compiling and comparing unchanged.
 */
export interface ProbeSnapshotIdentity {
  readonly project_scope: string;
  readonly ledger_digest: string;
  readonly graph_revision: string | null;
  readonly source_fingerprint: string | null;
  readonly connected_digest: string | null;
  readonly fingerprint: string;
  /** Cluster identity (epoch/commit point/evidence digest); legacy snapshots omit it. */
  readonly cluster_epoch?: string | number;
  readonly commit_index?: number;
  readonly replica_id?: string;
  readonly replica_commit_index?: number;
  readonly evidence_digest?: string;
}

export interface ProbeStore {
  /** The sampled snapshot every answer is bound to. */
  readonly snapshot: AnchorProbeSnapshot;
  /**
   * Records matching every supplied dimension (AND). `{}` or omitted returns
   * the full record set; a store with no dimension index may return nothing
   * for a routed query, which sends the probe down its documented slow path.
   */
  candidates(query?: ProbeEntryQuery): readonly ProbeCandidate[];
  /** Typed relations touching `ref` (both directions) or every relation. */
  adjacency(ref?: string): readonly ProbeEdge[];
  /** Frozen evidence payload for one record; undefined when unresolvable. */
  evidence(recordRef: string): ProbeEvidencePayload | undefined;
  /** Status/version view for one record; undefined when unresolvable. */
  status(recordRef: string): ProbeStatusView | undefined;
  /** Source/qualifier view for one record; undefined when unresolvable. */
  provenance(recordRef: string): ProbeProvenanceView | undefined;
  /** Bound snapshot plus its stable fingerprint. */
  snapshotIdentity(): ProbeSnapshotIdentity;
  /**
   * Optional replica cursor read (T-125+). Backends that are not replicas omit
   * the method entirely, so the existing SQLite/Projected/BitChain stores
   * compile and behave unchanged.
   */
  replicaCommitIndex?(): number | undefined;
}

/** Raised when a ProbeStore cache is closed or has never been populated. */
export class ProbeStoreCacheError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProbeStoreCacheError';
  }
}

export function probeSnapshotIdentity(snapshot: AnchorProbeSnapshot): ProbeSnapshotIdentity {
  const fingerprint = createHash('sha256')
    .update(canonicalJson([
      snapshot.project_scope,
      snapshot.ledger_digest,
      snapshot.graph_revision,
      snapshot.source_fingerprint,
      snapshot.connected_digest,
    ]))
    .digest('hex');
  const identity: ProbeSnapshotIdentity = {
    project_scope: snapshot.project_scope,
    ledger_digest: snapshot.ledger_digest,
    graph_revision: snapshot.graph_revision,
    source_fingerprint: snapshot.source_fingerprint,
    connected_digest: snapshot.connected_digest,
    fingerprint,
  };
  const cluster = snapshot.cluster;
  if (cluster === undefined) return identity;
  return {
    ...identity,
    cluster_epoch: cluster.cluster_epoch,
    commit_index: cluster.commit_index,
    replica_id: cluster.replica_id,
    replica_commit_index: cluster.replica_commit_index,
    evidence_digest: cluster.evidence_digest,
  };
}

/**
 * Structural guard: a ProbeStore carries the wider query port, while a bare
 * ProbeCandidateSource is the narrow injection port older callers use.
 */
export function isProbeStore(value: ProbeCandidateSource | ProbeStore): value is ProbeStore {
  const candidate = value as { candidates?: unknown; adjacency?: unknown };
  return typeof candidate.candidates === 'function' && typeof candidate.adjacency === 'function';
}

function evidenceOf(candidate: ProbeCandidate): ProbeEvidencePayload {
  return {
    record_ref: candidate.record_ref,
    content_hash: candidate.content_hash,
    status: candidate.status,
    source_health: candidate.source_health,
    recorded_at: candidate.recorded_at,
    effective_from: candidate.effective_from,
    source: candidate.source,
    content: candidate.content,
  };
}

function statusOf(candidate: ProbeCandidate): ProbeStatusView {
  return {
    record_ref: candidate.record_ref,
    status: candidate.status,
    eligibility: candidate.qualifiers.includes('legacy_unreviewed') ? 'legacy_unreviewed' : 'governed',
    version: candidate.version,
    superseded_by: candidate.superseded_by,
    effective_from: candidate.effective_from,
    effective_to: candidate.effective_to,
  };
}

function provenanceOf(candidate: ProbeCandidate): ProbeProvenanceView {
  return {
    record_ref: candidate.record_ref,
    source: candidate.source,
    source_health: candidate.source_health,
    qualifiers: candidate.qualifiers,
    anchor: candidate.anchor,
  };
}

/**
 * Adapt the narrow P0 injection port into the full ProbeStore shape. The probe
 * core always reads through a ProbeStore; this adapter keeps ad-hoc and test
 * sources (which only implement entries/edges) first-class without duplicating
 * the traversal semantics.
 */
export function adaptProbeCandidateSource(source: ProbeCandidateSource): ProbeStore {
  let all: readonly ProbeCandidate[] | undefined;
  const loadAll = (): readonly ProbeCandidate[] => {
    if (all === undefined) all = source.entries();
    return all;
  };
  return {
    get snapshot(): AnchorProbeSnapshot {
      return source.snapshot;
    },
    candidates(query?: ProbeEntryQuery): readonly ProbeCandidate[] {
      if (query === undefined || Object.keys(query).length === 0) return loadAll();
      return source.entries(query);
    },
    adjacency(): readonly ProbeEdge[] {
      return source.edges();
    },
    evidence(recordRef: string): ProbeEvidencePayload | undefined {
      const candidate = loadAll().find((item) => item.record_ref === recordRef);
      return candidate === undefined ? undefined : evidenceOf(candidate);
    },
    status(recordRef: string): ProbeStatusView | undefined {
      const candidate = loadAll().find((item) => item.record_ref === recordRef);
      return candidate === undefined ? undefined : statusOf(candidate);
    },
    provenance(recordRef: string): ProbeProvenanceView | undefined {
      const candidate = loadAll().find((item) => item.record_ref === recordRef);
      return candidate === undefined ? undefined : provenanceOf(candidate);
    },
    snapshotIdentity(): ProbeSnapshotIdentity {
      return probeSnapshotIdentity(source.snapshot);
    },
  };
}

/** Normalize either accepted source shape into the ProbeStore the core reads. */
export function toProbeStore(source: ProbeCandidateSource | ProbeStore): ProbeStore {
  return isProbeStore(source) ? source : adaptProbeCandidateSource(source);
}

/** Shared mapping rule: a projection record becomes one probe candidate. */
function candidateFromRecord(record: MemoryRecord): ProbeCandidate {
  const anchor = record.anchor;
  const file = anchor !== undefined && typeof anchor.file === 'string' ? anchor.file : null;
  const symbol = anchor === undefined
    ? null
    : typeof anchor.qualifiedName === 'string'
      ? anchor.qualifiedName
      : typeof anchor.symbolId === 'string' ? anchor.symbolId : null;
  const governed = record.eligibility === 'governed';
  return {
    record_ref: record.recordRef,
    fact_key: record.factKey,
    task_id: null,
    file,
    symbol,
    source: file === null ? { kind: 'native_note' } : { kind: 'native_note', path: file },
    source_health: governed ? 'verified_at_snapshot' : 'unknown',
    status: record.status,
    content: record.text,
    content_hash: record.contentHash,
    recorded_at: record.recordedAt,
    effective_from: record.effectiveFrom,
    effective_to: record.effectiveTo,
    superseded_by: record.supersededBy ?? null,
    version: record.version,
    anchor: { status: file === null ? 'none' : 'exact', file },
    qualifiers: governed ? [] : ['legacy_unreviewed'],
  };
}

function edgeKind(kind: string): ProbeEdge['kind'] {
  return kind === 'depends_on' || kind === 'explains' || kind === 'related_to' ? kind : 'unknown';
}

function matchesDimensions(candidate: ProbeCandidate, query: ProbeEntryQuery): boolean {
  if (query.fact_key !== undefined && candidate.fact_key !== query.fact_key) return false;
  if (query.task_id !== undefined && candidate.task_id !== query.task_id) return false;
  if (query.file !== undefined && candidate.file !== query.file) return false;
  if (query.symbol !== undefined && candidate.symbol !== query.symbol) return false;
  return true;
}

/**
 * Event-rebuilt projection backend: replays committed events through the
 * ADR-005 §10 views into a private in-memory database on every construction and
 * answers straight from that projection. It owns no durable cache, so it is the
 * reference side of the cross-backend equivalence check.
 */
export class ProjectedProbeStore implements ProbeStore {
  private readonly db: DatabaseSync;
  private readonly snap: AnchorProbeSnapshot;
  private closed = false;

  private constructor(db: DatabaseSync, snapshot: AnchorProbeSnapshot) {
    this.db = db;
    this.snap = snapshot;
  }

  static create(entries: readonly ViewReplayEntry[], snapshot: AnchorProbeSnapshot): ProjectedProbeStore {
    const db = new DatabaseSync(':memory:');
    try {
      initViews(db);
      for (const entry of entries) applyEventToDb(db, entry.event, entry.segment);
    } catch (error) {
      db.close();
      throw error;
    }
    return new ProjectedProbeStore(db, snapshot);
  }

  get snapshot(): AnchorProbeSnapshot {
    this.assertOpen();
    return this.snap;
  }

  candidates(query?: ProbeEntryQuery): readonly ProbeCandidate[] {
    this.assertOpen();
    const records = readMemoryRecords(this.db);
    const candidates = records.map(candidateFromRecord);
    if (query === undefined || Object.keys(query).length === 0) return candidates;
    return candidates.filter((candidate) => matchesDimensions(candidate, query));
  }

  adjacency(ref?: string): readonly ProbeEdge[] {
    this.assertOpen();
    return readMemoryEdges(this.db, ref).map((edge) => ({
      from: edge.fromRef,
      to: edge.toRef,
      kind: edgeKind(edge.edge),
      // Registered memory.* relations are confirmed by the committed ledger;
      // heuristic code/history edges belong to other backends.
      provenance: 'confirmed',
    }));
  }

  evidence(recordRef: string): ProbeEvidencePayload | undefined {
    const candidate = this.find(recordRef);
    return candidate === undefined ? undefined : evidenceOf(candidate);
  }

  status(recordRef: string): ProbeStatusView | undefined {
    const candidate = this.find(recordRef);
    return candidate === undefined ? undefined : statusOf(candidate);
  }

  provenance(recordRef: string): ProbeProvenanceView | undefined {
    const candidate = this.find(recordRef);
    return candidate === undefined ? undefined : provenanceOf(candidate);
  }

  snapshotIdentity(): ProbeSnapshotIdentity {
    this.assertOpen();
    return probeSnapshotIdentity(this.snap);
  }

  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }

  private find(recordRef: string): ProbeCandidate | undefined {
    this.assertOpen();
    const record = readMemoryRecords(this.db).find((item) => item.recordRef === recordRef);
    return record === undefined ? undefined : candidateFromRecord(record);
  }

  private assertOpen(): void {
    if (this.closed) throw new ProbeStoreCacheError('ProjectedProbeStore is closed');
  }
}

const PROBE_STORE_SCHEMA_VERSION = '1';

interface ProbeRecordRow {
  record_ref: string;
  fact_key: string | null;
  task_id: string | null;
  file: string | null;
  symbol: string | null;
  kind: string;
  content: string;
  content_hash: string;
  status: string;
  eligibility: string;
  source_kind: string;
  source_path: string | null;
  source_health: string;
  qualifiers: string;
  anchor_status: string;
  anchor_file: string | null;
  recorded_at: string;
  effective_from: string | null;
  effective_to: string | null;
  superseded_by: string | null;
  version: number;
}

interface ProbeEdgeRow { from_ref: string; to_ref: string; kind: string; provenance: string }
interface MetaRow { key: string; value: string }
interface CountRow { n: number }

const SELECT_RECORD_COLUMNS = 'record_ref, fact_key, task_id, file, symbol, kind, content, content_hash, status, eligibility, source_kind, source_path, source_health, qualifiers, anchor_status, anchor_file, recorded_at, effective_from, effective_to, superseded_by, version';

function candidateFromRow(row: ProbeRecordRow): ProbeCandidate {
  const sourceHealth = row.source_health === 'verified_at_snapshot' || row.source_health === 'stale'
    ? row.source_health
    : 'unknown';
  const anchorStatus = row.anchor_status === 'exact' || row.anchor_status === 'relocated' || row.anchor_status === 'stale'
    ? row.anchor_status
    : 'none';
  const sourceKind = row.source_kind === 'native_note' || row.source_kind === 'code_read'
    || row.source_kind === 'connected' || row.source_kind === 'history'
    ? row.source_kind
    : 'unknown';
  const qualifiers = JSON.parse(row.qualifiers) as unknown;
  if (!Array.isArray(qualifiers) || qualifiers.some((item) => typeof item !== 'string')) {
    throw new ProbeStoreCacheError(`probe cache row ${row.record_ref} has invalid qualifiers`);
  }
  return {
    record_ref: row.record_ref,
    fact_key: row.fact_key,
    task_id: row.task_id,
    file: row.file,
    symbol: row.symbol,
    source: row.source_path === null ? { kind: sourceKind } : { kind: sourceKind, path: row.source_path },
    source_health: sourceHealth,
    status: row.status as ProbeCandidate['status'],
    content: row.content,
    content_hash: row.content_hash,
    recorded_at: row.recorded_at,
    effective_from: row.effective_from,
    effective_to: row.effective_to,
    superseded_by: row.superseded_by,
    version: row.version,
    anchor: { status: anchorStatus, file: row.anchor_file },
    qualifiers: qualifiers as string[],
  };
}

/**
 * SQLite baseline: a denormalized, rebuildable cache of the committed memory
 * projection. Rows are derived exclusively from committed events replayed
 * through `views.ts`; the ledger stays authoritative and this file may be
 * deleted at any time.
 */
export class SqliteProbeStore implements ProbeStore {
  private readonly db: DatabaseSync;
  readonly databasePath: string;
  private snapshotValue: AnchorProbeSnapshot | null = null;
  private closed = false;

  private constructor(db: DatabaseSync, databasePath: string) {
    this.db = db;
    this.databasePath = databasePath;
  }

  static databasePath(root: string): string {
    return join(resolve(root), '.ano', 'cache', 'probe-store.db');
  }

  static open(root: string, databasePath: string = SqliteProbeStore.databasePath(root)): SqliteProbeStore {
    mkdirSync(join(databasePath, '..'), { recursive: true });
    const db = new DatabaseSync(databasePath);
    const store = new SqliteProbeStore(db, databasePath);
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      store.initialize();
      return store;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  get snapshot(): AnchorProbeSnapshot {
    this.assertOpen();
    if (this.snapshotValue === null) throw new ProbeStoreCacheError('Probe store has not been rebuilt yet');
    return this.snapshotValue;
  }

  candidates(query?: ProbeEntryQuery): readonly ProbeCandidate[] {
    this.assertOpen();
    const clauses: string[] = [];
    const bindings: string[] = [];
    if (query !== undefined) {
      if (query.fact_key !== undefined) { clauses.push('fact_key = ?'); bindings.push(query.fact_key); }
      if (query.task_id !== undefined) { clauses.push('task_id = ?'); bindings.push(query.task_id); }
      if (query.file !== undefined) { clauses.push('file = ?'); bindings.push(query.file); }
      if (query.symbol !== undefined) { clauses.push('symbol = ?'); bindings.push(query.symbol); }
    }
    const sql = `SELECT ${SELECT_RECORD_COLUMNS} FROM probe_records${clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY record_ref`;
    const rows = this.db.prepare(sql).all(...bindings) as unknown as ProbeRecordRow[];
    return rows.map(candidateFromRow);
  }

  adjacency(ref?: string): readonly ProbeEdge[] {
    this.assertOpen();
    const rows = (ref === undefined
      ? this.db.prepare('SELECT from_ref, to_ref, kind, provenance FROM probe_edges ORDER BY from_ref, to_ref, kind').all()
      : this.db.prepare('SELECT from_ref, to_ref, kind, provenance FROM probe_edges WHERE from_ref = ? OR to_ref = ? ORDER BY from_ref, to_ref, kind').all(ref, ref)) as unknown as ProbeEdgeRow[];
    return rows.map((row) => ({
      from: row.from_ref,
      to: row.to_ref,
      kind: edgeKind(row.kind),
      provenance: row.provenance === 'heuristic' ? 'heuristic' : row.provenance === 'unknown' ? 'unknown' : 'confirmed',
    }));
  }

  evidence(recordRef: string): ProbeEvidencePayload | undefined {
    const candidate = this.find(recordRef);
    return candidate === undefined ? undefined : evidenceOf(candidate);
  }

  status(recordRef: string): ProbeStatusView | undefined {
    const candidate = this.find(recordRef);
    return candidate === undefined ? undefined : statusOf(candidate);
  }

  provenance(recordRef: string): ProbeProvenanceView | undefined {
    const candidate = this.find(recordRef);
    return candidate === undefined ? undefined : provenanceOf(candidate);
  }

  snapshotIdentity(): ProbeSnapshotIdentity {
    return probeSnapshotIdentity(this.snapshot);
  }

  /**
   * Rebuild the whole cache from committed events in one transaction. The
   * projection replay re-validates payloads and preconditions, so a corrupt or
   * violates-history entry fails closed instead of being cached.
   */
  rebuild(entries: readonly ViewReplayEntry[], snapshot: AnchorProbeSnapshot): void {
    this.assertOpen();
    // A dropped table is recreated before replay; the projection itself is
    // reset from committed events, never patched in place.
    this.initialize();
    initViews(this.db);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      resetViews(this.db);
      for (const entry of entries) applyEventToDb(this.db, entry.event, entry.segment);
      this.db.prepare('DELETE FROM probe_records').run();
      this.db.prepare('DELETE FROM probe_edges').run();
      const insertRecord = this.db.prepare(`
        INSERT INTO probe_records (${SELECT_RECORD_COLUMNS})
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertEdge = this.db.prepare('INSERT INTO probe_edges (from_ref, to_ref, kind, provenance) VALUES (?, ?, ?, ?) ON CONFLICT(from_ref, to_ref, kind) DO NOTHING');
      let recordCount = 0;
      let edgeCount = 0;
      for (const record of readMemoryRecords(this.db)) {
        const candidate = candidateFromRecord(record);
        const anchorFile = candidate.anchor.file;
        insertRecord.run(
          candidate.record_ref,
          candidate.fact_key,
          candidate.task_id,
          candidate.file,
          candidate.symbol,
          record.kind,
          candidate.content,
          candidate.content_hash,
          candidate.status,
          record.eligibility,
          candidate.source.kind,
          candidate.source.path ?? null,
          candidate.source_health,
          JSON.stringify(candidate.qualifiers),
          candidate.anchor.status,
          anchorFile,
          candidate.recorded_at,
          candidate.effective_from,
          candidate.effective_to,
          candidate.superseded_by,
          candidate.version,
        );
        recordCount += 1;
      }
      for (const edge of readMemoryEdges(this.db)) {
        insertEdge.run(edge.fromRef, edge.toRef, edgeKind(edge.edge), 'confirmed');
        edgeCount += 1;
      }
      const meta = this.db.prepare('INSERT INTO probe_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
      meta.run('schema_version', PROBE_STORE_SCHEMA_VERSION);
      meta.run('source_digest', viewDigest(entries));
      meta.run('record_count', String(recordCount));
      meta.run('edge_count', String(edgeCount));
      meta.run('cache_digest', this.computeCacheDigest());
      meta.run('snapshot', canonicalJson(snapshot));
      this.snapshotValue = snapshot;
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* retain original error */ }
      throw error;
    }
  }

  /**
   * Return `fresh` when the cached digest, snapshot and row counts still match
   * the committed log; otherwise rebuild and return `rebuilt`. A missing or
   * damaged table is treated as corruption, never as an empty result.
   */
  refresh(entries: readonly ViewReplayEntry[], snapshot: AnchorProbeSnapshot): 'fresh' | 'rebuilt' {
    this.assertOpen();
    let intact = false;
    try {
      const meta = this.readMeta();
      const records = this.count('probe_records');
      const edges = this.count('probe_edges');
      intact = meta.get('schema_version') === PROBE_STORE_SCHEMA_VERSION
        && meta.get('source_digest') === viewDigest(entries)
        && meta.get('snapshot') === canonicalJson(snapshot)
        && meta.get('cache_digest') === this.computeCacheDigest()
        && Number(meta.get('record_count') ?? '') === records
        && Number(meta.get('edge_count') ?? '') === edges
        && this.snapshotValue !== null
        && canonicalJson(this.snapshotValue) === canonicalJson(snapshot);
    } catch {
      intact = false;
    }
    if (intact) return 'fresh';
    this.rebuild(entries, snapshot);
    return 'rebuilt';
  }

  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }

  private find(recordRef: string): ProbeCandidate | undefined {
    const row = this.db.prepare(`SELECT ${SELECT_RECORD_COLUMNS} FROM probe_records WHERE record_ref = ?`).get(recordRef) as ProbeRecordRow | undefined;
    return row === undefined ? undefined : candidateFromRow(row);
  }

  private count(table: 'probe_records' | 'probe_edges'): number {
    return Number((this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as CountRow | undefined)?.n ?? 0);
  }

  /**
   * Digest over the cached fact rows themselves, so edited content is detected
   * even when the row count and committed-log digest are unchanged.
   */
  private computeCacheDigest(): string {
    const records = this.db.prepare('SELECT record_ref, content_hash, content, status, eligibility, version FROM probe_records ORDER BY record_ref').all() as unknown as Array<Record<string, unknown>>;
    const edges = this.db.prepare('SELECT from_ref, to_ref, kind, provenance FROM probe_edges ORDER BY from_ref, to_ref, kind').all() as unknown as Array<Record<string, unknown>>;
    return createHash('sha256').update(canonicalJson([records, edges])).digest('hex');
  }

  private readMeta(): Map<string, string> {
    const rows = this.db.prepare('SELECT key, value FROM probe_meta').all() as unknown as MetaRow[];
    return new Map(rows.map((row) => [row.key, row.value]));
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS probe_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS probe_records (
        record_ref TEXT PRIMARY KEY,
        fact_key TEXT,
        task_id TEXT,
        file TEXT,
        symbol TEXT,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        eligibility TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_path TEXT,
        source_health TEXT NOT NULL,
        qualifiers TEXT NOT NULL,
        anchor_status TEXT NOT NULL,
        anchor_file TEXT,
        recorded_at TEXT NOT NULL,
        effective_from TEXT,
        effective_to TEXT,
        superseded_by TEXT,
        version INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS probe_records_fact_key ON probe_records(fact_key);
      CREATE INDEX IF NOT EXISTS probe_records_file ON probe_records(file);
      CREATE INDEX IF NOT EXISTS probe_records_symbol ON probe_records(symbol);
      CREATE TABLE IF NOT EXISTS probe_edges (
        from_ref TEXT NOT NULL,
        to_ref TEXT NOT NULL,
        kind TEXT NOT NULL,
        provenance TEXT NOT NULL,
        PRIMARY KEY (from_ref, to_ref, kind)
      );
      CREATE INDEX IF NOT EXISTS probe_edges_to_ref ON probe_edges(to_ref);
    `);
  }

  private assertOpen(): void {
    if (this.closed) throw new ProbeStoreCacheError('SqliteProbeStore is closed');
  }
}
