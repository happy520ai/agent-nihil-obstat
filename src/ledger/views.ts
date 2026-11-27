import { createHash } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { canonicalJson, hashEvent, ledgerEventSchema, timestampString, type LedgerEvent } from './event.ts';
import { isMemoryEventKind, normalizeLedgerPayload, ledgerPayloadIssues } from './payloads.ts';
import type { LedgerEvidence, LedgerTask, TaskStatus } from './ledger.ts';
import { isRunLeaseStatus, type RunLease } from './lease.ts';

/**
 * Bumped from 3 to 4 for the cross-domain event views (notes, audit findings
 * and runs, readiness evidence/attestations, release verdicts/approvals) and
 * the migration metadata columns on `tasks`. The views database is a
 * rebuildable cache, so the migration is a full reset + replay from segments;
 * no committed ledger event is touched and no separate data migration script is
 * required. See docs/phase-2-report.md.
 *
 * Bumped from 4 to 5 for ADR-005 §10: the versioned memory projection
 * (`memory_records` / `memory_heads` / `memory_edges` / `memory_conflicts`)
 * plus the `legacy_unreviewed` registration of committed note.recorded events.
 * The upgrade is again a full reset + replay from the committed segments — the
 * projection is derived state and every revision, relation and adjudication
 * stays recoverable from the original events.
 *
 * Bumped from 5 to 6 for ADR-010 §3.3: the revision-bound structure query
 * projection (`structure_queries` / `explored_files`). `explored_files` keeps
 * the latest file-level query per file; `currentExploredFiles(revision)`
 * filters by the current graph revision, so a revision change makes older
 * evidence stale without deleting history. Same full reset + replay upgrade.
 */
export const VIEW_SCHEMA_VERSION = 6;
export interface ViewReplayEntry { event: LedgerEvent; segment: string }
export interface IdempotencyView { canonical: string; event: LedgerEvent }
export interface ViewApplyResult { applied: boolean; duplicate: boolean }
export interface LedgerNote { id: string; kind: string; text: string; anchor?: Record<string, unknown>; createdAt: string }
export interface LedgerAuditFinding { id: string; scope: string; rule: string; severity: string; fingerprint: string; status: string; reopened: boolean }
export interface LedgerAuditRun { eventId: string; scope: string; ok: boolean; summary: Record<string, unknown>; at: string }
export interface LedgerReadinessEvidence {
  evidenceRef: string;
  requirementId: string;
  evidenceId?: string;
  kind: string;
  result: string;
  sourceFingerprint?: string;
  artifactHash?: string;
  timestamp: string;
  expiresAt?: string;
}
export interface LedgerReadinessAttestation {
  attestationRef: string;
  attestationId?: string;
  requirementId?: string;
  requirementIds?: string[];
  signer: { name: string; role: string };
  signedAt: string;
  expiresAt: string;
  artifactHash: string;
  releaseTarget: string;
}
export interface LedgerReleaseVerdict {
  verdictHash: string;
  target: string;
  artifactHash: string;
  sourceFingerprint?: string;
  verdict: string;
  summary: Record<string, unknown>;
  caveats?: string[];
}
export interface LedgerReleaseApproval {
  approvalRef: string;
  target: string;
  artifactHash: string;
  verdictHash: string;
  approver: string;
  approvedAt: string;
}
/** ADR-005 §6 record states; only committed memory.* events move them. */
export type MemoryRecordStatus = 'active' | 'superseded' | 'conflicted' | 'retracted';
/** ADR-005 §8: `governed` records come from memory.* events; legacy notes are marked, never promoted automatically. */
export type MemoryEligibility = 'governed' | 'legacy_unreviewed';
export type MemoryHeadStatus = 'active' | 'retracted' | 'conflicted';
export type MemoryEdgeKind = 'depends_on' | 'explains' | 'related_to';
/**
 * ADR-005 §10 projection row. `recordRef` is the id of the introducing event
 * (`memory.revised` for governed records, `note.recorded` for legacy ones),
 * `contentHash` is derived `sha256(canonicalJson(record))`, and `version` is
 * informational depth (genesis = 1, linear revision +1) — never an identity.
 */
export interface MemoryRecord {
  recordRef: string;
  factKey: string | null;
  kind: string;
  text: string;
  anchor?: Record<string, unknown>;
  noteId?: string;
  status: MemoryRecordStatus;
  eligibility: MemoryEligibility;
  supersedesRef?: string;
  supersededBy?: string;
  contentHash: string;
  recordedAt: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  version: number;
  eventId: string;
}
/** ADR-005 §10: `fact_key -> head` index; `headRef` is null while conflicted (or after retract_all). */
export interface MemoryHead {
  factKey: string;
  headRef: string | null;
  version: number | null;
  status: MemoryHeadStatus;
}
export interface MemoryEdge {
  fromRef: string;
  toRef: string;
  edge: MemoryEdgeKind;
  reason?: string;
  eventId: string;
}
/** An undecided fork (ADR-005 §7): branch set, plus the common prior both branches depend on. */
export interface MemoryConflict {
  factKey: string;
  parentRef: string | null;
  branches: string[];
  eventId: string;
}
/**
 * ADR-010 §3.3 projection rows. `structure_queries` keeps every committed
 * query event; `explored_files` keeps the latest file-level evidence per file.
 * `recordedAt` is derived from the event HLC (ADR-005 §2.8), never supplied by
 * the caller.
 */
export type StructureQueryGranularity = 'file' | 'symbol';
export interface StructureQueryResultSummary {
  total: number;
  returned: number;
  truncated: boolean;
  impact?: string[];
  classification?: string;
}
export interface StructureQueryRow {
  eventId: string;
  file: string;
  granularity: StructureQueryGranularity;
  ref?: string;
  graphRevision: string;
  query: string;
  result: StructureQueryResultSummary;
  recordedAt: string;
  actor: string;
  hlc: { physical: number; logical: number; actor: string };
}
export interface StructureQueryFilter {
  revision?: string;
  granularity?: StructureQueryGranularity;
}
export interface ExploredState {
  /** Latest file-level evidence whose revision equals the current graph revision. */
  explored: string[];
  /** Files whose latest file-level evidence is from an older revision. */
  stale: string[];
}
export class LedgerIntegrityError extends Error { readonly code = 'LEDGER_INTEGRITY'; constructor(message: string) { super(message); this.name = 'LedgerIntegrityError'; } }
export class IdempotencyConflictError extends Error { readonly code = 'IDEMPOTENCY_CONFLICT'; constructor(message: string) { super(message); this.name = 'IdempotencyConflictError'; } }
const statuses: readonly TaskStatus[] = ['todo', 'in_progress', 'done', 'cancelled'];
export function isTaskStatus(value: unknown): value is TaskStatus { return typeof value === 'string' && (statuses as readonly string[]).includes(value); }
export function canonicalForEvent(kind: LedgerEvent['kind'], payload: Record<string, unknown>): string { return canonicalJson({ kind, payload }); }
export function viewDigest(entries: readonly ViewReplayEntry[]): string { return createHash('sha256').update(canonicalJson(entries.map(({ event, segment }) => ({ event, segment })))).digest('hex'); }

export function initViews(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS events (event_id TEXT PRIMARY KEY, segment TEXT NOT NULL, kind TEXT NOT NULL, actor TEXT NOT NULL, physical INTEGER NOT NULL, logical INTEGER NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL, idem_key TEXT, payload TEXT NOT NULL, event_json TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS events_idem_key ON events(idem_key);
  CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, status TEXT NOT NULL, declared_files TEXT NOT NULL, title TEXT, verdict TEXT, created_event TEXT NOT NULL, creation_canonical TEXT NOT NULL, updated_event TEXT NOT NULL, original_status TEXT, verified INTEGER, migration_warning TEXT);
  CREATE TABLE IF NOT EXISTS evidence (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, payload TEXT NOT NULL, test_files TEXT NOT NULL, event_id TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS idempotency (idem_key TEXT PRIMARY KEY, canonical TEXT NOT NULL, event_id TEXT NOT NULL, event TEXT NOT NULL, segment TEXT NOT NULL, kind TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS run_leases (run_id TEXT PRIMARY KEY, lease_id TEXT NOT NULL, owner TEXT NOT NULL, acquired_at INTEGER NOT NULL, heartbeat_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, status TEXT NOT NULL, reclaimed_from TEXT, produced_evidence INTEGER NOT NULL DEFAULT 0, event_id TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS run_leases_lease_id ON run_leases(lease_id);
  CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL, anchor TEXT, created_at TEXT NOT NULL, event_id TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS notes_kind ON notes(kind);
  CREATE TABLE IF NOT EXISTS audit_findings (id TEXT PRIMARY KEY, scope TEXT NOT NULL, rule TEXT NOT NULL, severity TEXT NOT NULL, fingerprint TEXT NOT NULL, status TEXT NOT NULL, reopened INTEGER, event_id TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS audit_findings_scope ON audit_findings(scope);
  CREATE TABLE IF NOT EXISTS audit_runs (event_id TEXT PRIMARY KEY, scope TEXT NOT NULL, ok INTEGER NOT NULL, summary TEXT NOT NULL, at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS readiness_evidence (evidence_ref TEXT PRIMARY KEY, requirement_id TEXT NOT NULL, evidence_id TEXT, kind TEXT NOT NULL, result TEXT NOT NULL, source_fingerprint TEXT, artifact_hash TEXT, timestamp TEXT NOT NULL, expires_at TEXT, event_id TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS readiness_evidence_requirement ON readiness_evidence(requirement_id);
  CREATE TABLE IF NOT EXISTS readiness_attestations (attestation_ref TEXT PRIMARY KEY, attestation_id TEXT, requirement_id TEXT, requirement_ids TEXT, signer_name TEXT NOT NULL, signer_role TEXT NOT NULL, signed_at TEXT NOT NULL, expires_at TEXT NOT NULL, artifact_hash TEXT NOT NULL, release_target TEXT NOT NULL, event_id TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS release_verdicts (verdict_hash TEXT PRIMARY KEY, target TEXT NOT NULL, artifact_hash TEXT NOT NULL, source_fingerprint TEXT, verdict TEXT NOT NULL, summary TEXT NOT NULL, caveats TEXT, event_id TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS release_approvals (approval_ref TEXT PRIMARY KEY, target TEXT NOT NULL, artifact_hash TEXT NOT NULL, verdict_hash TEXT NOT NULL, approver TEXT NOT NULL, approved_at TEXT NOT NULL, event_id TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS memory_records (record_ref TEXT PRIMARY KEY, fact_key TEXT, kind TEXT NOT NULL, text TEXT NOT NULL, anchor TEXT, note_id TEXT, status TEXT NOT NULL, eligibility TEXT NOT NULL, supersedes_ref TEXT, superseded_by TEXT, content_hash TEXT NOT NULL, recorded_at TEXT NOT NULL, effective_from TEXT, effective_to TEXT, version INTEGER NOT NULL, event_id TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS memory_records_fact_key ON memory_records(fact_key);
  CREATE INDEX IF NOT EXISTS memory_records_note_id ON memory_records(note_id);
  CREATE TABLE IF NOT EXISTS memory_heads (fact_key TEXT PRIMARY KEY, head_ref TEXT, version INTEGER, status TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS memory_edges (from_ref TEXT NOT NULL, to_ref TEXT NOT NULL, edge TEXT NOT NULL, reason TEXT, event_id TEXT NOT NULL, PRIMARY KEY (from_ref, to_ref, edge));
  CREATE INDEX IF NOT EXISTS memory_edges_to_ref ON memory_edges(to_ref);
  CREATE TABLE IF NOT EXISTS memory_conflicts (fact_key TEXT PRIMARY KEY, parent_ref TEXT, branches TEXT NOT NULL, event_id TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS structure_queries (event_id TEXT PRIMARY KEY, file TEXT NOT NULL, granularity TEXT NOT NULL, ref TEXT, graph_revision TEXT NOT NULL, query TEXT NOT NULL, result TEXT NOT NULL, recorded_at TEXT NOT NULL, hlc_physical INTEGER NOT NULL, hlc_logical INTEGER NOT NULL, hlc_actor TEXT NOT NULL, actor TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS structure_queries_file_revision ON structure_queries(file, graph_revision);
  CREATE INDEX IF NOT EXISTS structure_queries_revision ON structure_queries(graph_revision);
  CREATE TABLE IF NOT EXISTS explored_files (file TEXT PRIMARY KEY, graph_revision TEXT NOT NULL, event_id TEXT NOT NULL, recorded_at TEXT NOT NULL, hlc_physical INTEGER NOT NULL, hlc_logical INTEGER NOT NULL, hlc_actor TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS view_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  const version = Number((db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined)?.user_version ?? 0);
  if (version !== VIEW_SCHEMA_VERSION) {
    resetViews(db);
    db.prepare(`PRAGMA user_version = ${VIEW_SCHEMA_VERSION}`).run();
  }
}
export function resetViews(db: DatabaseSync): void {
  // Fixed statement text: table names are literals, never interpolated input.
  db.exec('DELETE FROM explored_files; DELETE FROM structure_queries; DELETE FROM memory_conflicts; DELETE FROM memory_edges; DELETE FROM memory_heads; DELETE FROM memory_records; DELETE FROM release_approvals; DELETE FROM release_verdicts; DELETE FROM readiness_attestations; DELETE FROM readiness_evidence; DELETE FROM audit_runs; DELETE FROM audit_findings; DELETE FROM notes; DELETE FROM run_leases; DELETE FROM idempotency; DELETE FROM evidence; DELETE FROM tasks; DELETE FROM events; DELETE FROM view_meta;');
}
/**
 * Events applied incrementally by the writer are not part of the replayed
 * entry list yet, so the stored digest no longer describes the tables. Deleting
 * it forces the next syncViews call to rebuild from the log (and therefore to
 * drop rows whose segment has since disappeared).
 */
export function invalidateViewDigest(db: DatabaseSync): void {
  db.prepare("DELETE FROM view_meta WHERE key = 'digest'").run();
}
export function syncViews(db: DatabaseSync, entries: readonly ViewReplayEntry[]): void {
  const digest = viewDigest(entries);
  const prior = db.prepare("SELECT value FROM view_meta WHERE key = 'digest'").get() as { value?: string } | undefined;
  if (prior?.value === digest) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    resetViews(db);
    for (const entry of entries) applyEventToDb(db, entry.event, entry.segment);
    db.prepare("INSERT INTO view_meta (key, value) VALUES ('digest', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(digest);
    db.exec('COMMIT');
  } catch (error) { try { db.exec('ROLLBACK'); } catch { /* retain original */ } throw error; }
}
export const rebuildViews = syncViews;

export function applyEventToDb(db: DatabaseSync, event: LedgerEvent, segment: string): ViewApplyResult {
  const parsed = ledgerEventSchema.safeParse(event);
  if (!parsed.success) throw new LedgerIntegrityError(`Invalid event ${event.id}`);
  const hash = hashEvent(event);
  const prior = db.prepare('SELECT hash FROM events WHERE event_id = ?').get(event.id) as { hash?: string } | undefined;
  if (prior) {
    if (prior.hash !== hash) throw new LedgerIntegrityError(`Conflicting event id ${event.id}`);
    return { applied: false, duplicate: true };
  }
  db.prepare('INSERT INTO events (event_id, segment, kind, actor, physical, logical, prev_hash, hash, idem_key, payload, event_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(event.id, segment, event.kind, event.actor, event.hlc.physical, event.hlc.logical, event.prev_hash, hash, event.idem_key ?? null, JSON.stringify(event.payload), JSON.stringify(event));
  const canonical = canonicalForEvent(event.kind, event.payload);
  if (event.idem_key !== undefined) {
    const idem = db.prepare('SELECT canonical FROM idempotency WHERE idem_key = ?').get(event.idem_key) as { canonical?: string } | undefined;
    if (idem) {
      if (idem.canonical !== canonical) throw new IdempotencyConflictError(`Different parameters for ${event.idem_key}`);
      return { applied: false, duplicate: true };
    }
    db.prepare('INSERT INTO idempotency (idem_key, canonical, event_id, event, segment, kind) VALUES (?, ?, ?, ?, ?, ?)')
      .run(event.idem_key, canonical, event.id, JSON.stringify(event), segment, event.kind);
  }
  applyViewEvent(db, event);
  return { applied: true, duplicate: false };
}

function applyViewEvent(db: DatabaseSync, event: LedgerEvent): void {
  if (event.kind === 'segment.started' || event.kind === 'verify.started' || event.kind === 'verify.finished' || event.kind === 'migration.recorded') return;
  const payload = event.payload;
  if (event.kind === 'note.recorded') { applyNoteRecorded(db, event); return; }
  if (event.kind === 'audit.finding') { applyAuditFinding(db, event); return; }
  if (event.kind === 'audit.completed') { applyAuditCompleted(db, event); return; }
  if (event.kind === 'readiness.evidence') { applyReadinessEvidence(db, event); return; }
  if (event.kind === 'readiness.attestation') { applyReadinessAttestation(db, event); return; }
  if (event.kind === 'release.verdict') { applyReleaseVerdict(db, event); return; }
  if (event.kind === 'release.approved') { applyReleaseApproval(db, event); return; }
  if (event.kind === 'run.lease.acquired' || event.kind === 'run.lease.heartbeat' || event.kind === 'run.lease.reclaimed' || event.kind === 'run.lease.released') {
    applyRunLeaseEvent(db, event);
    return;
  }
  if (isMemoryEventKind(event.kind)) {
    applyMemoryEvent(db, event);
    return;
  }
  if (event.kind === 'structure.queried') {
    applyStructureQueried(db, event);
    return;
  }
  const id = requiredString(payload, 'task_id', event);
  if (event.kind === 'task.created') {
    if (db.prepare('SELECT id FROM tasks WHERE id = ?').get(id)) throw new LedgerIntegrityError(`Duplicate task.created for ${id}`);
    const declared = requiredArray(payload, 'declared_files', event);
    const status = payload.status ?? 'todo';
    if (!isTaskStatus(status)) throw new LedgerIntegrityError('Invalid task status');
    db.prepare('INSERT INTO tasks (id, status, declared_files, title, verdict, created_event, creation_canonical, updated_event) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)')
      .run(id, status, JSON.stringify(declared), typeof payload.title === 'string' ? payload.title : null, event.id, canonicalForEvent(event.kind, payload), event.id);
  } else if (event.kind === 'task.updated') {
    const taskQuery = 'SELECT status, verdict, original_status, verified, migration_warning FROM tasks WHERE id = ?';
    const existing = db.prepare(taskQuery).get(id) as { status: string; verdict: string | null; original_status: string | null; verified: number | null; migration_warning: string | null } | undefined;
    if (!existing) throw new LedgerIntegrityError('Update for unknown task: ' + id);
    const status = payload.status ?? existing.status;
    if (!isTaskStatus(status)) throw new LedgerIntegrityError('Invalid task status');
    // `verdict: null` clears a prior completion verdict (used by reopenTask).
    const verdict = Object.hasOwn(payload, 'verdict')
      ? (payload.verdict === null ? null : JSON.stringify(payload.verdict))
      : existing.verdict;
    // Migration metadata is optional and only overwritten when present, so a
    // later ordinary status transition does not erase why a legacy task was
    // imported in a non-terminal state.
    const originalStatus = typeof payload.original_status === 'string' ? payload.original_status : existing.original_status;
    const verified = typeof payload.verified === 'boolean' ? (payload.verified ? 1 : 0) : existing.verified;
    const migrationWarning = typeof payload.migration_warning === 'string' ? payload.migration_warning : existing.migration_warning;
    db.prepare('UPDATE tasks SET status = ?, verdict = ?, updated_event = ?, original_status = ?, verified = ?, migration_warning = ? WHERE id = ?')
      .run(status, verdict, event.id, originalStatus, verified, migrationWarning, id);
  } else if (event.kind === 'evidence.recorded') {
    if (!db.prepare('SELECT id FROM tasks WHERE id = ?').get(id)) throw new LedgerIntegrityError(`Evidence for unknown task ${id}`);
    const evidence = requiredRecord(payload, 'evidence', event);
    const evidenceId = requiredString(evidence, 'id', event);
    const files = Array.isArray(payload.test_files) ? payload.test_files : [];
    db.prepare('INSERT INTO evidence (id, task_id, payload, test_files, event_id) VALUES (?, ?, ?, ?, ?)')
      .run(evidenceId, id, JSON.stringify(payload), JSON.stringify(files), event.id);
    // Optional lease attribution: an evidence event that names a run lease must
    // belong to the active lease. This stops a stale or forged run id from
    // being credited, and lets reclaim reset the produced_evidence flag.
    if (payload.run_id !== undefined || payload.lease_id !== undefined) {
      if (typeof payload.run_id !== 'string' || typeof payload.lease_id !== 'string') {
        throw new LedgerIntegrityError('evidence.recorded run_id and lease_id must be provided together');
      }
      const changed = db.prepare("UPDATE run_leases SET produced_evidence = 1 WHERE run_id = ? AND lease_id = ? AND status = 'active'")
        .run(payload.run_id, payload.lease_id);
      if (Number(changed.changes) !== 1) throw new LedgerIntegrityError(`Evidence ${evidenceId} does not match an active run lease`);
    }
  }
}

function validatedPayload(event: LedgerEvent): Record<string, unknown> {
  const payload = normalizeLedgerPayload(event.kind, event.payload);
  const issues = ledgerPayloadIssues(event.kind, payload);
  if (issues.length > 0) throw new LedgerIntegrityError(`${event.kind} payload is invalid: ${issues.join('; ')}`);
  return payload;
}
function applyNoteRecorded(db: DatabaseSync, event: LedgerEvent): void {
  const payload = validatedPayload(event);
  const id = requiredString(payload, 'note_id', event);
  const kind = requiredString(payload, 'kind', event);
  const text = requiredString(payload, 'text', event);
  const createdAt = requiredString(payload, 'created_at', event);
  const anchor = payload.anchor === undefined ? null : JSON.stringify(payload.anchor);
  const prior = db.prepare('SELECT kind, text, anchor, created_at FROM notes WHERE id = ?').get(id) as { kind: string; text: string; anchor: string | null; created_at: string } | undefined;
  if (prior) {
    if (prior.kind !== kind || prior.text !== text || prior.anchor !== anchor || prior.created_at !== createdAt) {
      throw new LedgerIntegrityError(`Conflicting note.recorded payload for ${id}`);
    }
  } else {
    db.prepare('INSERT INTO notes (id, kind, text, anchor, created_at, event_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, kind, text, anchor, createdAt, event.id);
  }
  // ADR-005 §8: every committed note.recorded event also registers in the
  // memory projection as a legacy_unreviewed record. The note row, its payload
  // bytes and every pre-existing read output stay untouched; the record only
  // marks eligibility (having an anchor does not assert business validity), so
  // it can never be returned as a governed fact until a memory.revised event
  // explicitly supersedes it.
  registerLegacyMemoryRecord(db, event, id, kind, text, payload.anchor === undefined ? undefined : payload.anchor as Record<string, unknown>);
}
function applyAuditFinding(db: DatabaseSync, event: LedgerEvent): void {
  const payload = validatedPayload(event);
  const finding = requiredRecord(payload, 'finding', event);
  const id = requiredString(finding, 'id', event);
  const scope = requiredString(payload, 'scope', event);
  const fingerprint = requiredString(finding, 'fingerprint', event);
  const rule = requiredString(finding, 'rule', event);
  const severity = requiredString(finding, 'severity', event);
  const status = requiredString(finding, 'status', event);
  const reopened = finding.reopened === true ? 1 : 0;
  const prior = db.prepare('SELECT scope, fingerprint, rule, severity, status FROM audit_findings WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (prior) {
    if (String(prior.scope) !== scope || String(prior.fingerprint) !== fingerprint || String(prior.rule) !== rule || String(prior.severity) !== severity) {
      throw new LedgerIntegrityError(`Conflicting audit.finding payload for ${id}`);
    }
    db.prepare('UPDATE audit_findings SET status = ?, reopened = ?, event_id = ? WHERE id = ?').run(status, reopened, event.id, id);
    return;
  }
  db.prepare('INSERT INTO audit_findings (id, scope, rule, severity, fingerprint, status, reopened, event_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, scope, rule, severity, fingerprint, status, reopened, event.id);
}
function applyAuditCompleted(db: DatabaseSync, event: LedgerEvent): void {
  const payload = validatedPayload(event);
  const scope = requiredString(payload, 'scope', event);
  const at = requiredString(payload, 'at', event);
  if (typeof payload.ok !== 'boolean') throw new LedgerIntegrityError('audit.completed requires ok');
  const summary = requiredRecord(payload, 'summary', event);
  db.prepare('INSERT INTO audit_runs (event_id, scope, ok, summary, at) VALUES (?, ?, ?, ?, ?)')
    .run(event.id, scope, payload.ok ? 1 : 0, JSON.stringify(summary), at);
}
function readinessEvidenceShape(payload: Record<string, unknown>): Record<string, unknown> {
  const nested = payload.evidence;
  const value = nested && typeof nested === 'object' && !Array.isArray(nested) ? nested as Record<string, unknown> : payload;
  return value;
}
function applyReadinessEvidence(db: DatabaseSync, event: LedgerEvent): void {
  const payload = validatedPayload(event);
  const evidence = readinessEvidenceShape(payload);
  const ref = typeof evidence.evidence_ref === 'string'
    ? evidence.evidence_ref
    : requiredString(payload, 'evidence_ref', event);
  const requirementId = requiredString(evidence, 'requirement_id', event);
  const kind = requiredString(evidence, 'kind', event);
  // A validated machine/attested record is a passing record even when it names
  // its provenance via `status` rather than `result`.
  const result = typeof evidence.result === 'string'
    ? evidence.result
    : evidence.status === 'machine' || evidence.status === 'attested' ? 'pass' : '';
  if (!result) throw new LedgerIntegrityError('readiness.evidence requires result or status');
  const timestamp = requiredString(evidence, 'timestamp', event);
  const sourceFingerprint = typeof evidence.source_fingerprint === 'string' ? evidence.source_fingerprint : null;
  const artifactHash = typeof evidence.artifact_hash === 'string' ? evidence.artifact_hash : null;
  const evidenceId = typeof evidence.id === 'string' ? evidence.id : null;
  const expiresAt = typeof evidence.expires_at === 'string' ? evidence.expires_at : null;
  const prior = db.prepare('SELECT requirement_id, kind, result, source_fingerprint, artifact_hash FROM readiness_evidence WHERE evidence_ref = ?').get(ref) as Record<string, unknown> | undefined;
  if (prior) {
    if (String(prior.requirement_id) !== requirementId || String(prior.kind) !== kind || String(prior.result) !== result
      || (prior.source_fingerprint ?? null) !== sourceFingerprint || (prior.artifact_hash ?? null) !== artifactHash) {
      throw new LedgerIntegrityError(`Conflicting readiness.evidence payload for ${ref}`);
    }
    return;
  }
  db.prepare('INSERT INTO readiness_evidence (evidence_ref, requirement_id, evidence_id, kind, result, source_fingerprint, artifact_hash, timestamp, expires_at, event_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(ref, requirementId, evidenceId, kind, result, sourceFingerprint, artifactHash, timestamp, expiresAt, event.id);
}
function readinessAttestationShape(payload: Record<string, unknown>): Record<string, unknown> {
  const nested = payload.attestation;
  const value = nested && typeof nested === 'object' && !Array.isArray(nested) ? nested as Record<string, unknown> : payload;
  return value;
}
function applyReadinessAttestation(db: DatabaseSync, event: LedgerEvent): void {
  const payload = validatedPayload(event);
  const attestation = readinessAttestationShape(payload);
  const ref = requiredString(payload, 'attestation_ref', event);
  const signer = requiredRecord(attestation, 'signer', event);
  const signerName = requiredString(signer, 'name', event);
  const signerRole = requiredString(signer, 'role', event);
  const signedAt = requiredString(attestation, 'signed_at', event);
  const expiresAt = requiredString(attestation, 'expires_at', event);
  const artifactHash = requiredString(attestation, 'artifact_hash', event);
  const releaseTarget = requiredString(attestation, 'release_target', event);
  const requirementId = typeof attestation.requirement_id === 'string' ? attestation.requirement_id : null;
  const requirementIds = Array.isArray(attestation.requirement_ids) ? JSON.stringify(attestation.requirement_ids) : null;
  const attestationId = typeof attestation.id === 'string' ? attestation.id : null;
  const prior = db.prepare('SELECT signer_name, signer_role, signed_at, expires_at, artifact_hash, release_target FROM readiness_attestations WHERE attestation_ref = ?').get(ref) as Record<string, unknown> | undefined;
  if (prior) {
    if (String(prior.signer_name) !== signerName || String(prior.signer_role) !== signerRole || String(prior.signed_at) !== signedAt
      || String(prior.expires_at) !== expiresAt || String(prior.artifact_hash) !== artifactHash || String(prior.release_target) !== releaseTarget) {
      throw new LedgerIntegrityError(`Conflicting readiness.attestation payload for ${ref}`);
    }
    return;
  }
  db.prepare('INSERT INTO readiness_attestations (attestation_ref, attestation_id, requirement_id, requirement_ids, signer_name, signer_role, signed_at, expires_at, artifact_hash, release_target, event_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(ref, attestationId, requirementId, requirementIds, signerName, signerRole, signedAt, expiresAt, artifactHash, releaseTarget, event.id);
}
function applyReleaseVerdict(db: DatabaseSync, event: LedgerEvent): void {
  const payload = validatedPayload(event);
  const verdictHash = requiredString(payload, 'verdict_hash', event);
  const target = requiredString(payload, 'target', event);
  const artifactHash = requiredString(payload, 'artifact_hash', event);
  const verdict = requiredString(payload, 'verdict', event);
  const sourceFingerprint = typeof payload.source_fingerprint === 'string' ? payload.source_fingerprint : null;
  const caveats = Array.isArray(payload.caveats) ? JSON.stringify(payload.caveats) : null;
  const summary = requiredRecord(payload, 'summary', event);
  const prior = db.prepare('SELECT target, artifact_hash, verdict, summary FROM release_verdicts WHERE verdict_hash = ?').get(verdictHash) as Record<string, unknown> | undefined;
  if (prior) {
    if (String(prior.target) !== target || String(prior.artifact_hash) !== artifactHash || String(prior.verdict) !== verdict
      || String(prior.summary) !== JSON.stringify(summary)) {
      throw new LedgerIntegrityError(`Conflicting release.verdict payload for ${verdictHash}`);
    }
    return;
  }
  db.prepare('INSERT INTO release_verdicts (verdict_hash, target, artifact_hash, source_fingerprint, verdict, summary, caveats, event_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(verdictHash, target, artifactHash, sourceFingerprint, verdict, JSON.stringify(summary), caveats, event.id);
}
function applyReleaseApproval(db: DatabaseSync, event: LedgerEvent): void {
  const payload = validatedPayload(event);
  const approvalRef = requiredString(payload, 'approval_ref', event);
  const target = requiredString(payload, 'target', event);
  const artifactHash = requiredString(payload, 'artifact_hash', event);
  const verdictHash = requiredString(payload, 'verdict_hash', event);
  const approver = requiredString(payload, 'approver', event);
  const approvedAt = requiredString(payload, 'approved_at', event);
  const prior = db.prepare('SELECT target, artifact_hash, verdict_hash, approver, approved_at FROM release_approvals WHERE approval_ref = ?').get(approvalRef) as Record<string, unknown> | undefined;
  if (prior) {
    if (String(prior.target) !== target || String(prior.artifact_hash) !== artifactHash || String(prior.verdict_hash) !== verdictHash
      || String(prior.approver) !== approver || String(prior.approved_at) !== approvedAt) {
      throw new LedgerIntegrityError(`Conflicting release.approved payload for ${approvalRef}`);
    }
    return;
  }
  db.prepare('INSERT INTO release_approvals (approval_ref, target, artifact_hash, verdict_hash, approver, approved_at, event_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(approvalRef, target, artifactHash, verdictHash, approver, approvedAt, event.id);
}

function applyRunLeaseEvent(db: DatabaseSync, event: LedgerEvent): void {
  const payload = event.payload;
  const runId = requiredString(payload, 'run_id', event);
  const leaseId = requiredString(payload, 'lease_id', event);
  const existing = db.prepare('SELECT * FROM run_leases WHERE run_id = ?').get(runId) as Record<string, unknown> | undefined;
  if (event.kind === 'run.lease.acquired') {
    if (existing && String(existing.status) === 'active') throw new LedgerIntegrityError(`run.lease.acquired for already leased run ${runId}`);
    const owner = requiredString(payload, 'owner', event);
    const acquiredAt = requiredInteger(payload, 'acquired_at', event);
    const heartbeatAt = requiredInteger(payload, 'heartbeat_at', event);
    const expiresAt = requiredInteger(payload, 'expires_at', event);
    // A released lease row may be reused by a fresh acquire. Reclaimed runs are
    // already active under the new owner, so they cannot reach this branch.
    if (existing) {
      db.prepare('UPDATE run_leases SET lease_id = ?, owner = ?, acquired_at = ?, heartbeat_at = ?, expires_at = ?, status = ?, reclaimed_from = NULL, produced_evidence = 0, event_id = ? WHERE run_id = ?')
        .run(leaseId, owner, acquiredAt, heartbeatAt, expiresAt, 'active', event.id, runId);
    } else {
      db.prepare('INSERT INTO run_leases (run_id, lease_id, owner, acquired_at, heartbeat_at, expires_at, status, reclaimed_from, produced_evidence, event_id) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, ?)')
        .run(runId, leaseId, owner, acquiredAt, heartbeatAt, expiresAt, 'active', event.id);
    }
    return;
  }
  if (!existing) throw new LedgerIntegrityError(`${event.kind} for unknown run ${runId}`);
  if (String(existing.status) !== 'active') throw new LedgerIntegrityError(`${event.kind} for non-active run lease ${runId}`);
  // A reclaim names the NEW lease in lease_id and the old lease in
  // reclaimed_from; every other lease event must match the current lease.
  if (event.kind !== 'run.lease.reclaimed' && String(existing.lease_id) !== leaseId) throw new LedgerIntegrityError(`${event.kind} lease id mismatch for run ${runId}`);
  if (event.kind === 'run.lease.heartbeat') {
    db.prepare('UPDATE run_leases SET heartbeat_at = ?, expires_at = ?, event_id = ? WHERE run_id = ?')
      .run(requiredInteger(payload, 'heartbeat_at', event), requiredInteger(payload, 'expires_at', event), event.id, runId);
  } else if (event.kind === 'run.lease.released') {
    db.prepare("UPDATE run_leases SET status = 'released', event_id = ? WHERE run_id = ?").run(event.id, runId);
  } else if (event.kind === 'run.lease.reclaimed') {
    const reclaimedFrom = requiredString(payload, 'reclaimed_from', event);
    if (reclaimedFrom !== String(existing.lease_id)) throw new LedgerIntegrityError(`run.lease.reclaimed reclaimed_from mismatch for run ${runId}`);
    // The row keeps only the newest lease (one lease per run); full history is
    // in the segments. Reclaim resets evidence credit for the old lease.
    db.prepare('UPDATE run_leases SET lease_id = ?, owner = ?, acquired_at = ?, heartbeat_at = ?, expires_at = ?, status = ?, reclaimed_from = ?, produced_evidence = 0, event_id = ? WHERE run_id = ?')
      .run(
        leaseId,
        requiredString(payload, 'owner', event),
        requiredInteger(payload, 'acquired_at', event),
        requiredInteger(payload, 'heartbeat_at', event),
        requiredInteger(payload, 'expires_at', event),
        'active',
        reclaimedFrom,
        event.id,
        runId,
      );
  } else {
    throw new LedgerIntegrityError(`Unknown run lease event ${event.kind}`);
  }
}

/**
 * ADR-005 §6/§7/§10: replay-layer projection of the versioned memory events.
 * The projection re-derives state from the committed payload bytes on every
 * rebuild, so it re-validates payloads (strict schemas from payloads.ts) and
 * re-checks every precondition instead of trusting the append layer: a state
 * transition that does not hold at replay time is a LedgerIntegrityError and
 * the view fails closed. Legacy note.recorded events are registered in
 * applyNoteRecorded (ADR-005 §8).
 */
function applyMemoryEvent(db: DatabaseSync, event: LedgerEvent): void {
  // ADR-005 §2.6: memory.* events force an idempotency key. The append layer
  // rejects missing keys; the replay layer refuses to project them.
  if (event.idem_key === undefined) throw new LedgerIntegrityError(`${event.kind} requires an idem_key`);
  const payload = validatedPayload(event);
  if (event.kind === 'memory.revised') { applyMemoryRevised(db, event, payload); return; }
  if (event.kind === 'memory.related') { applyMemoryRelated(db, event, payload); return; }
  applyMemoryConflictResolved(db, event, payload);
}

interface MemoryRecordInsert {
  factKey: string | null;
  kind: string;
  text: string;
  anchor: Record<string, unknown> | undefined;
  noteId?: string;
  status: MemoryRecordStatus;
  eligibility: MemoryEligibility;
  supersedesRef: string | null;
  contentHash: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  version: number;
}

function insertMemoryRecord(db: DatabaseSync, event: LedgerEvent, values: MemoryRecordInsert): void {
  db.prepare(`INSERT INTO memory_records (record_ref, fact_key, kind, text, anchor, note_id, status, eligibility, supersedes_ref, superseded_by, content_hash, recorded_at, effective_from, effective_to, version, event_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`)
    .run(
      event.id,
      values.factKey,
      values.kind,
      values.text,
      values.anchor === undefined ? null : JSON.stringify(values.anchor),
      values.noteId ?? null,
      values.status,
      values.eligibility,
      values.supersedesRef,
      values.contentHash,
      recordedAtOf(event),
      values.effectiveFrom,
      values.effectiveTo,
      values.version,
      event.id,
    );
}

function registerLegacyMemoryRecord(db: DatabaseSync, event: LedgerEvent, noteId: string, kind: string, text: string, anchor: Record<string, unknown> | undefined): void {
  if (db.prepare('SELECT record_ref FROM memory_records WHERE record_ref = ?').get(event.id)) return;
  insertMemoryRecord(db, event, {
    factKey: null,
    kind,
    text,
    anchor,
    noteId,
    status: 'active',
    eligibility: 'legacy_unreviewed',
    supersedesRef: null,
    contentHash: contentHashOf({ kind, text, ...(anchor === undefined ? {} : { anchor }) }),
    effectiveFrom: null,
    effectiveTo: null,
    version: 1,
  });
}

function contentHashOf(value: unknown): string { return createHash('sha256').update(canonicalJson(value)).digest('hex'); }
/** `recorded_at` is derived from the event HLC (ADR-005 §5), never backfilled from payload fields. */
function recordedAtOf(event: LedgerEvent): string { return new Date(event.hlc.physical).toISOString(); }

function memoryRecordRow(db: DatabaseSync, ref: string): Record<string, unknown> | undefined {
  return db.prepare('SELECT * FROM memory_records WHERE record_ref = ?').get(ref) as Record<string, unknown> | undefined;
}
function memoryHeadRow(db: DatabaseSync, factKey: string): Record<string, unknown> | undefined {
  return db.prepare('SELECT * FROM memory_heads WHERE fact_key = ?').get(factKey) as Record<string, unknown> | undefined;
}
function memoryConflictRow(db: DatabaseSync, factKey: string): Record<string, unknown> | undefined {
  return db.prepare('SELECT * FROM memory_conflicts WHERE fact_key = ?').get(factKey) as Record<string, unknown> | undefined;
}
function memoryHeadRowCount(db: DatabaseSync, factKey: string): number {
  return Number((db.prepare('SELECT COUNT(*) AS n FROM memory_records WHERE fact_key = ?').get(factKey) as { n: number }).n);
}
function upsertMemoryHead(db: DatabaseSync, factKey: string, headRef: string | null, version: number | null, status: MemoryHeadStatus): void {
  db.prepare(`INSERT INTO memory_heads (fact_key, head_ref, version, status) VALUES (?, ?, ?, ?)
    ON CONFLICT(fact_key) DO UPDATE SET head_ref = excluded.head_ref, version = excluded.version, status = excluded.status`)
    .run(factKey, headRef, version, status);
}
function markMemoryRecord(db: DatabaseSync, ref: string, status: MemoryRecordStatus, supersededBy: string | null): void {
  db.prepare('UPDATE memory_records SET status = ?, superseded_by = ? WHERE record_ref = ?').run(status, supersededBy, ref);
}
function effectiveBounds(payload: Record<string, unknown>, event: LedgerEvent): { effectiveFrom: string | null; effectiveTo: string | null } {
  const from = payload.effective_from;
  const to = payload.effective_to;
  // The schemas require both keys explicitly (ISO or null); re-check because the
  // replay layer must not silently treat "absent" as "unknown".
  if (from === undefined || to === undefined) throw new LedgerIntegrityError(`${event.kind} requires explicit effective_from and effective_to`);
  if (from !== null && (typeof from !== 'string' || Number.isNaN(Date.parse(from)))) throw new LedgerIntegrityError(`${event.kind} effective_from is not an ISO datetime`);
  if (to !== null && (typeof to !== 'string' || Number.isNaN(Date.parse(to)))) throw new LedgerIntegrityError(`${event.kind} effective_to is not an ISO datetime`);
  if (from !== null && to !== null && Date.parse(from) > Date.parse(to)) {
    throw new LedgerIntegrityError(`${event.kind} effective_from must not be after effective_to`);
  }
  return { effectiveFrom: from as string | null, effectiveTo: to as string | null };
}
function governedRecordValues(record: Record<string, unknown>, event: LedgerEvent, overrides: {
  factKey: string;
  status: MemoryRecordStatus;
  supersedesRef: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  version: number;
}): MemoryRecordInsert {
  return {
    factKey: overrides.factKey,
    kind: requiredString(record, 'kind', event),
    text: requiredString(record, 'text', event),
    anchor: record.anchor === undefined ? undefined : record.anchor as Record<string, unknown>,
    status: overrides.status,
    eligibility: 'governed',
    supersedesRef: overrides.supersedesRef,
    contentHash: contentHashOf(record),
    effectiveFrom: overrides.effectiveFrom,
    effectiveTo: overrides.effectiveTo,
    version: overrides.version,
  };
}

function applyMemoryRevised(db: DatabaseSync, event: LedgerEvent, payload: Record<string, unknown>): void {
  const factKey = requiredString(payload, 'fact_key', event);
  const supersedes = requiredArray(payload, 'supersedes', event);
  const head = memoryHeadRow(db, factKey);
  const conflict = memoryConflictRow(db, factKey);

  // ADR-005 §4.1/§6: retraction names the current head, which must be active.
  // A retracted head cannot be retracted again (forward correction re-enters
  // via intent=revise), and a conflicted fact_key has no head to retract —
  // only memory.conflict.resolved may leave the undecided state.
  if (payload.intent === 'retract') {
    if (!head || typeof head.head_ref !== 'string') throw new LedgerIntegrityError(`memory.revised retract for ${factKey} without a head`);
    if (head.status !== 'active') throw new LedgerIntegrityError(`memory.revised retract for ${factKey} on a ${String(head.status)} head`);
    if (supersedes[0] !== head.head_ref) throw new LedgerIntegrityError(`memory.revised retract for ${factKey} does not name the current head`);
    markMemoryRecord(db, String(head.head_ref), 'retracted', null);
    upsertMemoryHead(db, factKey, String(head.head_ref), head.version === null ? null : Number(head.version), 'retracted');
    return;
  }

  // intent === 'revise' (the schema discriminated the union).
  const record = requiredRecord(payload, 'record', event);
  const bounds = effectiveBounds(payload, event);

  if (supersedes.length === 0) {
    // Genesis (ADR-005 §6): the fact_key must never have carried a record —
    // including retracted ones, which are re-entered by superseding the head.
    if (head || conflict || memoryHeadRowCount(db, factKey) > 0) {
      throw new LedgerIntegrityError(`memory.revised genesis for non-empty fact_key ${factKey}`);
    }
    insertMemoryRecord(db, event, governedRecordValues(record, event, { ...bounds, factKey, status: 'active', supersedesRef: null, version: 1 }));
    upsertMemoryHead(db, factKey, event.id, 1, 'active');
    return;
  }

  const targetRef = supersedes[0]!;
  const target = memoryRecordRow(db, targetRef);
  // ADR-005 §7 replay rule: unknown refs (including self-references, which by
  // construction do not exist yet) fail closed.
  if (!target) throw new LedgerIntegrityError(`memory.revised for ${factKey} supersedes unresolvable ref ${targetRef}`);

  if (head && typeof head.head_ref === 'string') {
    if (targetRef === head.head_ref) {
      // Linear revision — including the §4.1 forward correction of a retracted
      // head, which is a new active record, never a state write-back: the
      // retracted record keeps its event-set status (states only change via
      // events, matching the append-layer derivation); only an active head is
      // superseded by the revision.
      if (target.fact_key === null || String(target.fact_key) !== factKey) throw new LedgerIntegrityError(`memory.revised head for ${factKey} belongs to another fact_key`);
      const version = Number(target.version) + 1;
      insertMemoryRecord(db, event, governedRecordValues(record, event, { ...bounds, factKey, status: 'active', supersedesRef: targetRef, version }));
      if (String(target.status) !== 'retracted') markMemoryRecord(db, targetRef, 'superseded', event.id);
      upsertMemoryHead(db, factKey, event.id, version, 'active');
      return;
    }
    const headRecord = memoryRecordRow(db, head.head_ref);
    if (headRecord && typeof headRecord.supersedes_ref === 'string' && headRecord.supersedes_ref === targetRef) {
      // Fork (ADR-005 §7): the incoming revision depends on the same prior as
      // the current head. Project both branches as conflicted, vacate the head,
      // and never pick a winner by replay order.
      projectMemoryFork(db, event, factKey, head.head_ref, targetRef, Number(target.version) + 1);
      return;
    }
    throw new LedgerIntegrityError(`memory.revised for ${factKey} supersedes stale ref ${targetRef} (current head ${head.head_ref})`);
  }

  if (conflict) {
    // Undecided conflict: only a revision naming the fork's common prior joins
    // the branch set; everything else fails closed while the conflict stands.
    if (typeof conflict.parent_ref === 'string' && conflict.parent_ref === targetRef) {
      const branches = JSON.parse(String(conflict.branches)) as string[];
      const version = Number(target.version) + 1;
      insertMemoryRecord(db, event, governedRecordValues(record, event, { ...bounds, factKey, status: 'conflicted', supersedesRef: targetRef, version }));
      branches.push(event.id);
      db.prepare('UPDATE memory_conflicts SET branches = ?, event_id = ? WHERE fact_key = ?').run(JSON.stringify(branches), event.id, factKey);
      return;
    }
    throw new LedgerIntegrityError(`memory.revised for ${factKey} while its conflict is undecided`);
  }

  // No head and no conflict: only the ADR-005 §8 legacy entry path is legal —
  // a memory.revised that supersedes a note.recorded event id gives the note's
  // fact a first governed version. The legacy record itself is only marked.
  if (target.fact_key === null && target.eligibility === 'legacy_unreviewed') {
    if (memoryHeadRowCount(db, factKey) > 0) throw new LedgerIntegrityError(`memory.revised legacy entry for non-empty fact_key ${factKey}`);
    insertMemoryRecord(db, event, governedRecordValues(record, event, { ...bounds, factKey, status: 'active', supersedesRef: targetRef, version: 1 }));
    markMemoryRecord(db, targetRef, 'superseded', event.id);
    upsertMemoryHead(db, factKey, event.id, 1, 'active');
    return;
  }
  throw new LedgerIntegrityError(`memory.revised for ${factKey} supersedes ${targetRef} which is not its current head`);
}

function projectMemoryFork(db: DatabaseSync, event: LedgerEvent, factKey: string, headRef: string, parentRef: string, version: number): void {
  const record = requiredRecord(event.payload, 'record', event);
  const bounds = effectiveBounds(event.payload, event);
  markMemoryRecord(db, headRef, 'conflicted', null);
  insertMemoryRecord(db, event, governedRecordValues(record, event, { ...bounds, factKey, status: 'conflicted', supersedesRef: parentRef, version }));
  upsertMemoryHead(db, factKey, null, null, 'conflicted');
  db.prepare('INSERT INTO memory_conflicts (fact_key, parent_ref, branches, event_id) VALUES (?, ?, ?, ?)')
    .run(factKey, parentRef, JSON.stringify([headRef, event.id]), event.id);
}

function applyMemoryRelated(db: DatabaseSync, event: LedgerEvent, payload: Record<string, unknown>): void {
  const fromRef = requiredString(payload, 'from_ref', event);
  const toRef = requiredString(payload, 'to_ref', event);
  const edge = requiredString(payload, 'edge', event);
  // ADR-005 §4.2: self-loops are rejected; both endpoints must resolve inside
  // this ledger (project_scope is structural — a foreign project's record ref
  // is simply unresolvable here); the triple is unique; and a relation never
  // changes any fact's effective state.
  if (fromRef === toRef) throw new LedgerIntegrityError(`memory.related rejects a self-loop edge on ${fromRef}`);
  if (!memoryRecordRow(db, fromRef)) throw new LedgerIntegrityError(`memory.related from_ref ${fromRef} is unresolvable in this ledger`);
  if (!memoryRecordRow(db, toRef)) throw new LedgerIntegrityError(`memory.related to_ref ${toRef} is unresolvable in this ledger`);
  if (db.prepare('SELECT event_id FROM memory_edges WHERE from_ref = ? AND to_ref = ? AND edge = ?').get(fromRef, toRef, edge)) {
    throw new LedgerIntegrityError(`memory.related edge ${edge} already registered for ${fromRef} -> ${toRef}`);
  }
  db.prepare('INSERT INTO memory_edges (from_ref, to_ref, edge, reason, event_id) VALUES (?, ?, ?, ?, ?)')
    .run(fromRef, toRef, edge, typeof payload.reason === 'string' ? payload.reason : null, event.id);
}

function applyMemoryConflictResolved(db: DatabaseSync, event: LedgerEvent, payload: Record<string, unknown>): void {
  const factKey = requiredString(payload, 'fact_key', event);
  const branches = requiredArray(payload, 'branches', event);
  const outcome = requiredRecord(payload, 'outcome', event);
  const conflict = memoryConflictRow(db, factKey);
  if (!conflict) throw new LedgerIntegrityError(`memory.conflict.resolved for ${factKey} without an undecided conflict`);
  const pending = JSON.parse(String(conflict.branches)) as string[];
  // ADR-005 §4.3: the declared branch set must equal the undecided set exactly
  // (compared as sorted sets); fewer omits a branch, more invents one.
  if (new Set(branches).size !== branches.length) throw new LedgerIntegrityError(`memory.conflict.resolved branches for ${factKey} contain duplicates`);
  const sorted = (values: readonly string[]) => [...values].sort();
  if (JSON.stringify(sorted(branches)) !== JSON.stringify(sorted(pending))) {
    throw new LedgerIntegrityError(`memory.conflict.resolved branches for ${factKey} do not match the undecided set`);
  }
  const outcomeType = requiredString(outcome, 'type', event);
  if (outcomeType === 'winner') {
    const winnerRef = requiredString(outcome, 'winner_ref', event);
    if (!branches.includes(winnerRef)) throw new LedgerIntegrityError(`memory.conflict.resolved winner ${winnerRef} is not a branch of ${factKey}`);
    const winner = memoryRecordRow(db, winnerRef);
    if (!winner) throw new LedgerIntegrityError(`memory.conflict.resolved winner ${winnerRef} is unresolvable`);
    for (const ref of pending) {
      if (ref === winnerRef) markMemoryRecord(db, ref, 'active', null);
      else markMemoryRecord(db, ref, 'superseded', winnerRef);
    }
    upsertMemoryHead(db, factKey, winnerRef, Number(winner.version), 'active');
  } else if (outcomeType === 'record') {
    const record = requiredRecord(outcome, 'record', event);
    const bounds = effectiveBounds(outcome, event);
    const version = pending.reduce((max, ref) => Math.max(max, Number(memoryRecordRow(db, ref)?.version ?? 0)), 0) + 1;
    insertMemoryRecord(db, event, governedRecordValues(record, event, { ...bounds, factKey, status: 'active', supersedesRef: null, version }));
    for (const ref of pending) markMemoryRecord(db, ref, 'superseded', event.id);
    upsertMemoryHead(db, factKey, event.id, version, 'active');
  } else if (outcomeType === 'retract_all') {
    for (const ref of pending) markMemoryRecord(db, ref, 'retracted', null);
    // ADR-005 §4.3: the head is vacated and the fact_key is marked retracted —
    // reads must report "retracted", not "no such fact".
    upsertMemoryHead(db, factKey, null, null, 'retracted');
  } else {
    throw new LedgerIntegrityError(`memory.conflict.resolved outcome type ${outcomeType} is unknown`);
  }
  db.prepare('DELETE FROM memory_conflicts WHERE fact_key = ?').run(factKey);
}

const STRUCTURE_GRANULARITIES: readonly StructureQueryGranularity[] = ['file', 'symbol'];

/** ADR-010 §3.2: `file` is a relative POSIX path, never absolute or backslashed. */
function isAbsoluteStructurePath(file: string): boolean {
  return file.startsWith('/') || file.startsWith('\\') || /^[A-Za-z]:[\\/]/u.test(file);
}

/**
 * ADR-010 §3.3: project a committed `structure.queried` event. The event must
 * carry an idempotency key (enforced here so replay is fail-closed too), the
 * payload is validated by the strict snake_case schema, and only `file`
 * granularity updates `explored_files`. The latest file-level evidence per
 * file wins; symbol queries never enter the explored projection.
 */
function applyStructureQueried(db: DatabaseSync, event: LedgerEvent): void {
  const payload = validatedPayload(event);
  if (event.idem_key === undefined) throw new LedgerIntegrityError('structure.queried requires an idem_key');
  const granularity = requiredString(payload, 'granularity', event);
  if (!(STRUCTURE_GRANULARITIES as readonly string[]).includes(granularity)) {
    throw new LedgerIntegrityError(`structure.queried invalid granularity: ${granularity}`);
  }
  const file = requiredString(payload, 'file', event);
  if (isAbsoluteStructurePath(file) || file.includes('\\')) {
    throw new LedgerIntegrityError(`structure.queried file must be a relative POSIX path: ${file}`);
  }
  const graphRevision = requiredString(payload, 'graph_revision', event);
  const query = requiredString(payload, 'query', event);
  const result = requiredRecord(payload, 'result', event);
  const total = requiredInteger(result, 'total', event);
  const returned = requiredInteger(result, 'returned', event);
  if (typeof result.truncated !== 'boolean') throw new LedgerIntegrityError('structure.queried result.truncated must be a boolean');
  const impact = result.impact === undefined ? undefined : requiredArray(result, 'impact', event);
  const classification = result.classification === undefined ? undefined : requiredString(result, 'classification', event);
  const ref = payload.ref === undefined ? undefined : requiredString(payload, 'ref', event);
  const recordedAt = timestampString(event.hlc);
  const resultSummary = {
    total,
    returned,
    truncated: result.truncated,
    ...(impact !== undefined ? { impact } : {}),
    ...(classification !== undefined ? { classification } : {}),
  };
  db.prepare(`INSERT INTO structure_queries (event_id, file, granularity, ref, graph_revision, query, result, recorded_at, hlc_physical, hlc_logical, hlc_actor, actor)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(event.id, file, granularity, ref ?? null, graphRevision, query, JSON.stringify(resultSummary), recordedAt, event.hlc.physical, event.hlc.logical, event.hlc.actor, event.actor);
  if (granularity !== 'file') return;
  // Replay is HLC-ordered, so the last event wins; the explicit comparison
  // keeps a manually replayed older event from regressing the latest evidence.
  db.prepare(`INSERT INTO explored_files (file, graph_revision, event_id, recorded_at, hlc_physical, hlc_logical, hlc_actor)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(file) DO UPDATE SET
      graph_revision = excluded.graph_revision,
      event_id = excluded.event_id,
      recorded_at = excluded.recorded_at,
      hlc_physical = excluded.hlc_physical,
      hlc_logical = excluded.hlc_logical,
      hlc_actor = excluded.hlc_actor
    WHERE excluded.hlc_physical > explored_files.hlc_physical
       OR (excluded.hlc_physical = explored_files.hlc_physical AND excluded.hlc_logical > explored_files.hlc_logical)
       OR (excluded.hlc_physical = explored_files.hlc_physical AND excluded.hlc_logical = explored_files.hlc_logical AND excluded.hlc_actor > explored_files.hlc_actor)`)
    .run(file, graphRevision, event.id, recordedAt, event.hlc.physical, event.hlc.logical, event.hlc.actor);
}

function requiredString(payload: Record<string, unknown>, key: string, event: LedgerEvent): string {
  const value = payload[key];
  if (typeof value !== 'string' || !value) throw new LedgerIntegrityError(`${event.kind} requires ${key}`);
  return value;
}
function requiredArray(payload: Record<string, unknown>, key: string, event: LedgerEvent): string[] {
  const value = payload[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new LedgerIntegrityError(`${event.kind} requires ${key} array`);
  return value as string[];
}
function requiredRecord(payload: Record<string, unknown>, key: string, event: LedgerEvent): Record<string, unknown> {
  const value = payload[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LedgerIntegrityError(`${event.kind} requires ${key} object`);
  return value as Record<string, unknown>;
}
function requiredInteger(payload: Record<string, unknown>, key: string, event: LedgerEvent): number {
  const value = payload[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new LedgerIntegrityError(`${event.kind} requires nonnegative integer ${key}`);
  return value as number;
}
function rowToTask(row: Record<string, unknown>): LedgerTask {
  const status = String(row.status);
  if (!isTaskStatus(status)) throw new LedgerIntegrityError('Invalid cached task status');
  const task: LedgerTask = { id: String(row.id), status, declaredFiles: JSON.parse(String(row.declared_files)) as string[] };
  if (row.title !== null && row.title !== undefined) task.title = String(row.title);
  if (row.verdict !== null && row.verdict !== undefined) task.verdict = JSON.parse(String(row.verdict));
  if (row.original_status !== null && row.original_status !== undefined) task.originalStatus = String(row.original_status);
  if (row.verified !== null && row.verified !== undefined) task.verified = Number(row.verified) === 1;
  if (row.migration_warning !== null && row.migration_warning !== undefined) task.migrationWarning = String(row.migration_warning);
  return task;
}
export function readTask(db: DatabaseSync, id: string): LedgerTask | undefined {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToTask(row) : undefined;
}
export function readTasks(db: DatabaseSync): LedgerTask[] { return (db.prepare('SELECT * FROM tasks ORDER BY id').all() as Record<string, unknown>[]).map(rowToTask); }
export function readTaskCreationCanonical(db: DatabaseSync, id: string): string | undefined { return (db.prepare('SELECT creation_canonical FROM tasks WHERE id = ?').get(id) as { creation_canonical?: string } | undefined)?.creation_canonical; }
export function readTaskCreatedEventId(db: DatabaseSync, id: string): string | undefined { return (db.prepare('SELECT created_event FROM tasks WHERE id = ?').get(id) as { created_event?: string } | undefined)?.created_event; }
export function readEventById(db: DatabaseSync, id: string): LedgerEvent | undefined { const row = db.prepare('SELECT event_json FROM events WHERE event_id = ?').get(id) as { event_json?: string } | undefined; return row ? ledgerEventSchema.parse(JSON.parse(String(row.event_json))) : undefined; }
export function findIdempotency(db: DatabaseSync, key: string): IdempotencyView | undefined { const row = db.prepare('SELECT canonical, event FROM idempotency WHERE idem_key = ?').get(key) as { canonical: string; event: string } | undefined; return row ? { canonical: row.canonical, event: ledgerEventSchema.parse(JSON.parse(row.event)) } : undefined; }
export function readEvidence(db: DatabaseSync, id: string): LedgerEvidence | undefined { const row = db.prepare('SELECT * FROM evidence WHERE id = ?').get(id) as Record<string, unknown> | undefined; return row ? toEvidence(row) : undefined; }
export function listEvidence(db: DatabaseSync, taskId?: string): LedgerEvidence[] { const rows = (taskId ? db.prepare('SELECT * FROM evidence WHERE task_id = ? ORDER BY id').all(taskId) : db.prepare('SELECT * FROM evidence ORDER BY id').all()) as Record<string, unknown>[]; return rows.map(toEvidence); }
function toEvidence(row: Record<string, unknown>): LedgerEvidence { const payload = JSON.parse(String(row.payload)) as { evidence: Record<string, unknown> }; return { id: String(row.id), taskId: String(row.task_id), evidence: payload.evidence, testFiles: JSON.parse(String(row.test_files)) as string[] }; }

function rowToRunLease(row: Record<string, unknown>): RunLease {
  const status = String(row.status);
  if (!isRunLeaseStatus(status)) throw new LedgerIntegrityError('Invalid cached run lease status');
  const lease: RunLease = {
    runId: String(row.run_id),
    leaseId: String(row.lease_id),
    owner: String(row.owner),
    acquiredAt: Number(row.acquired_at),
    heartbeatAt: Number(row.heartbeat_at),
    expiresAt: Number(row.expires_at),
    status,
    producedEvidence: Number(row.produced_evidence) === 1,
  };
  if (row.reclaimed_from !== null && row.reclaimed_from !== undefined) lease.reclaimedFrom = String(row.reclaimed_from);
  return lease;
}
export function readRunLease(db: DatabaseSync, runId: string): RunLease | undefined {
  const row = db.prepare('SELECT * FROM run_leases WHERE run_id = ?').get(runId) as Record<string, unknown> | undefined;
  return row ? rowToRunLease(row) : undefined;
}
export function readRunLeases(db: DatabaseSync): RunLease[] {
  return (db.prepare('SELECT * FROM run_leases ORDER BY run_id').all() as Record<string, unknown>[]).map(rowToRunLease);
}

function rowToNote(row: Record<string, unknown>): LedgerNote {
  const note: LedgerNote = { id: String(row.id), kind: String(row.kind), text: String(row.text), createdAt: String(row.created_at) };
  if (row.anchor !== null && row.anchor !== undefined) note.anchor = JSON.parse(String(row.anchor)) as Record<string, unknown>;
  return note;
}
export function readNote(db: DatabaseSync, id: string): LedgerNote | undefined {
  const row = db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToNote(row) : undefined;
}
export function readNotes(db: DatabaseSync): LedgerNote[] {
  return (db.prepare('SELECT * FROM notes ORDER BY created_at, id').all() as Record<string, unknown>[]).map(rowToNote);
}

const memoryRecordStatuses: readonly MemoryRecordStatus[] = ['active', 'superseded', 'conflicted', 'retracted'];
const memoryEligibilities: readonly MemoryEligibility[] = ['governed', 'legacy_unreviewed'];
const memoryHeadStatuses: readonly MemoryHeadStatus[] = ['active', 'retracted', 'conflicted'];
const memoryEdgeKinds: readonly MemoryEdgeKind[] = ['depends_on', 'explains', 'related_to'];

function checkedMemoryValue<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) throw new LedgerIntegrityError(`Invalid cached memory ${what}: ${String(value)}`);
  return value as T;
}

function rowToMemoryRecord(row: Record<string, unknown>): MemoryRecord {
  const record: MemoryRecord = {
    recordRef: String(row.record_ref),
    factKey: row.fact_key === null || row.fact_key === undefined ? null : String(row.fact_key),
    kind: String(row.kind),
    text: String(row.text),
    status: checkedMemoryValue(row.status, memoryRecordStatuses, 'record status'),
    eligibility: checkedMemoryValue(row.eligibility, memoryEligibilities, 'record eligibility'),
    contentHash: String(row.content_hash),
    recordedAt: String(row.recorded_at),
    effectiveFrom: row.effective_from === null || row.effective_from === undefined ? null : String(row.effective_from),
    effectiveTo: row.effective_to === null || row.effective_to === undefined ? null : String(row.effective_to),
    version: Number(row.version),
    eventId: String(row.event_id),
  };
  if (row.anchor !== null && row.anchor !== undefined) record.anchor = JSON.parse(String(row.anchor)) as Record<string, unknown>;
  if (row.note_id !== null && row.note_id !== undefined) record.noteId = String(row.note_id);
  if (row.supersedes_ref !== null && row.supersedes_ref !== undefined) record.supersedesRef = String(row.supersedes_ref);
  if (row.superseded_by !== null && row.superseded_by !== undefined) record.supersededBy = String(row.superseded_by);
  return record;
}
export interface MemoryRecordFilter { factKey?: string; eligibility?: MemoryEligibility; status?: MemoryRecordStatus }
export function readMemoryRecord(db: DatabaseSync, ref: string): MemoryRecord | undefined {
  const row = memoryRecordRow(db, ref);
  return row ? rowToMemoryRecord(row) : undefined;
}
export function readMemoryRecords(db: DatabaseSync, filter: MemoryRecordFilter = {}): MemoryRecord[] {
  const rows = (filter.factKey !== undefined
    ? db.prepare('SELECT * FROM memory_records WHERE fact_key = ? ORDER BY record_ref').all(filter.factKey)
    : db.prepare('SELECT * FROM memory_records ORDER BY record_ref').all()) as Record<string, unknown>[];
  return rows.map(rowToMemoryRecord).filter((record) => (filter.eligibility === undefined || record.eligibility === filter.eligibility)
    && (filter.status === undefined || record.status === filter.status));
}
function rowToMemoryHead(row: Record<string, unknown>): MemoryHead {
  return {
    factKey: String(row.fact_key),
    headRef: row.head_ref === null || row.head_ref === undefined ? null : String(row.head_ref),
    version: row.version === null || row.version === undefined ? null : Number(row.version),
    status: checkedMemoryValue(row.status, memoryHeadStatuses, 'head status'),
  };
}
export function readMemoryHead(db: DatabaseSync, factKey: string): MemoryHead | undefined {
  const row = memoryHeadRow(db, factKey);
  return row ? rowToMemoryHead(row) : undefined;
}
export function readMemoryHeads(db: DatabaseSync): MemoryHead[] {
  return (db.prepare('SELECT * FROM memory_heads ORDER BY fact_key').all() as Record<string, unknown>[]).map(rowToMemoryHead);
}
function rowToMemoryEdge(row: Record<string, unknown>): MemoryEdge {
  const edge: MemoryEdge = {
    fromRef: String(row.from_ref),
    toRef: String(row.to_ref),
    edge: checkedMemoryValue(row.edge, memoryEdgeKinds, 'edge kind'),
    eventId: String(row.event_id),
  };
  if (row.reason !== null && row.reason !== undefined) edge.reason = String(row.reason);
  return edge;
}
/** All registered relation edges, or the edges touching one record when `ref` is given. */
export function readMemoryEdges(db: DatabaseSync, ref?: string): MemoryEdge[] {
  const rows = (ref !== undefined
    ? db.prepare('SELECT * FROM memory_edges WHERE from_ref = ? OR to_ref = ? ORDER BY from_ref, to_ref, edge').all(ref, ref)
    : db.prepare('SELECT * FROM memory_edges ORDER BY from_ref, to_ref, edge').all()) as Record<string, unknown>[];
  return rows.map(rowToMemoryEdge);
}
function rowToMemoryConflict(row: Record<string, unknown>): MemoryConflict {
  const branches = JSON.parse(String(row.branches)) as unknown;
  if (!Array.isArray(branches) || branches.some((ref) => typeof ref !== 'string')) throw new LedgerIntegrityError('Invalid cached memory conflict branches');
  return {
    factKey: String(row.fact_key),
    parentRef: row.parent_ref === null || row.parent_ref === undefined ? null : String(row.parent_ref),
    branches: branches as string[],
    eventId: String(row.event_id),
  };
}
export function readMemoryConflict(db: DatabaseSync, factKey: string): MemoryConflict | undefined {
  const row = memoryConflictRow(db, factKey);
  return row ? rowToMemoryConflict(row) : undefined;
}
export function readMemoryConflicts(db: DatabaseSync): MemoryConflict[] {
  return (db.prepare('SELECT * FROM memory_conflicts ORDER BY fact_key').all() as Record<string, unknown>[]).map(rowToMemoryConflict);
}

function rowToAuditFinding(row: Record<string, unknown>): LedgerAuditFinding {
  return {
    id: String(row.id),
    scope: String(row.scope),
    rule: String(row.rule),
    severity: String(row.severity),
    fingerprint: String(row.fingerprint),
    status: String(row.status),
    reopened: Number(row.reopened) === 1,
  };
}
export function readAuditFinding(db: DatabaseSync, id: string): LedgerAuditFinding | undefined {
  const row = db.prepare('SELECT * FROM audit_findings WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToAuditFinding(row) : undefined;
}
export function readAuditFindings(db: DatabaseSync, scope?: string): LedgerAuditFinding[] {
  const rows = (scope
    ? db.prepare('SELECT * FROM audit_findings WHERE scope = ? ORDER BY id').all(scope)
    : db.prepare('SELECT * FROM audit_findings ORDER BY id').all()) as Record<string, unknown>[];
  return rows.map(rowToAuditFinding);
}
export function readAuditRuns(db: DatabaseSync): LedgerAuditRun[] {
  return (db.prepare('SELECT * FROM audit_runs ORDER BY at, event_id').all() as Record<string, unknown>[]).map((row) => ({
    eventId: String(row.event_id),
    scope: String(row.scope),
    ok: Number(row.ok) === 1,
    summary: JSON.parse(String(row.summary)) as Record<string, unknown>,
    at: String(row.at),
  }));
}
function rowToReadinessEvidence(row: Record<string, unknown>): LedgerReadinessEvidence {
  const record: LedgerReadinessEvidence = {
    evidenceRef: String(row.evidence_ref),
    requirementId: String(row.requirement_id),
    kind: String(row.kind),
    result: String(row.result),
    timestamp: String(row.timestamp),
  };
  if (row.evidence_id !== null && row.evidence_id !== undefined) record.evidenceId = String(row.evidence_id);
  if (row.source_fingerprint !== null && row.source_fingerprint !== undefined) record.sourceFingerprint = String(row.source_fingerprint);
  if (row.artifact_hash !== null && row.artifact_hash !== undefined) record.artifactHash = String(row.artifact_hash);
  if (row.expires_at !== null && row.expires_at !== undefined) record.expiresAt = String(row.expires_at);
  return record;
}
export function readReadinessEvidence(db: DatabaseSync, ref: string): LedgerReadinessEvidence | undefined {
  const row = db.prepare('SELECT * FROM readiness_evidence WHERE evidence_ref = ?').get(ref) as Record<string, unknown> | undefined;
  return row ? rowToReadinessEvidence(row) : undefined;
}
export function readReadinessEvidenceList(db: DatabaseSync, requirementId?: string): LedgerReadinessEvidence[] {
  const rows = (requirementId
    ? db.prepare('SELECT * FROM readiness_evidence WHERE requirement_id = ? ORDER BY evidence_ref').all(requirementId)
    : db.prepare('SELECT * FROM readiness_evidence ORDER BY evidence_ref').all()) as Record<string, unknown>[];
  return rows.map(rowToReadinessEvidence);
}
function rowToReadinessAttestation(row: Record<string, unknown>): LedgerReadinessAttestation {
  const record: LedgerReadinessAttestation = {
    attestationRef: String(row.attestation_ref),
    signer: { name: String(row.signer_name), role: String(row.signer_role) },
    signedAt: String(row.signed_at),
    expiresAt: String(row.expires_at),
    artifactHash: String(row.artifact_hash),
    releaseTarget: String(row.release_target),
  };
  if (row.attestation_id !== null && row.attestation_id !== undefined) record.attestationId = String(row.attestation_id);
  if (row.requirement_id !== null && row.requirement_id !== undefined) record.requirementId = String(row.requirement_id);
  if (row.requirement_ids !== null && row.requirement_ids !== undefined) record.requirementIds = JSON.parse(String(row.requirement_ids)) as string[];
  return record;
}
export function readReadinessAttestation(db: DatabaseSync, ref: string): LedgerReadinessAttestation | undefined {
  const row = db.prepare('SELECT * FROM readiness_attestations WHERE attestation_ref = ?').get(ref) as Record<string, unknown> | undefined;
  return row ? rowToReadinessAttestation(row) : undefined;
}
export function readReadinessAttestations(db: DatabaseSync): LedgerReadinessAttestation[] {
  return (db.prepare('SELECT * FROM readiness_attestations ORDER BY signed_at, attestation_ref').all() as Record<string, unknown>[]).map(rowToReadinessAttestation);
}
function rowToReleaseVerdict(row: Record<string, unknown>): LedgerReleaseVerdict {
  const record: LedgerReleaseVerdict = {
    verdictHash: String(row.verdict_hash),
    target: String(row.target),
    artifactHash: String(row.artifact_hash),
    verdict: String(row.verdict),
    summary: JSON.parse(String(row.summary)) as Record<string, unknown>,
  };
  if (row.source_fingerprint !== null && row.source_fingerprint !== undefined) record.sourceFingerprint = String(row.source_fingerprint);
  if (row.caveats !== null && row.caveats !== undefined) record.caveats = JSON.parse(String(row.caveats)) as string[];
  return record;
}
export function readReleaseVerdict(db: DatabaseSync, hash: string): LedgerReleaseVerdict | undefined {
  const row = db.prepare('SELECT * FROM release_verdicts WHERE verdict_hash = ?').get(hash) as Record<string, unknown> | undefined;
  return row ? rowToReleaseVerdict(row) : undefined;
}
export function readReleaseVerdicts(db: DatabaseSync): LedgerReleaseVerdict[] {
  return (db.prepare('SELECT * FROM release_verdicts ORDER BY verdict_hash').all() as Record<string, unknown>[]).map(rowToReleaseVerdict);
}
function rowToReleaseApproval(row: Record<string, unknown>): LedgerReleaseApproval {
  return {
    approvalRef: String(row.approval_ref),
    target: String(row.target),
    artifactHash: String(row.artifact_hash),
    verdictHash: String(row.verdict_hash),
    approver: String(row.approver),
    approvedAt: String(row.approved_at),
  };
}
export function readReleaseApproval(db: DatabaseSync, ref: string): LedgerReleaseApproval | undefined {
  const row = db.prepare('SELECT * FROM release_approvals WHERE approval_ref = ?').get(ref) as Record<string, unknown> | undefined;
  return row ? rowToReleaseApproval(row) : undefined;
}
export function readReleaseApprovals(db: DatabaseSync): LedgerReleaseApproval[] {
  return (db.prepare('SELECT * FROM release_approvals ORDER BY approved_at, approval_ref').all() as Record<string, unknown>[]).map(rowToReleaseApproval);
}

function rowToStructureQuery(row: Record<string, unknown>): StructureQueryRow {
  const record: StructureQueryRow = {
    eventId: String(row.event_id),
    file: String(row.file),
    granularity: String(row.granularity) as StructureQueryGranularity,
    graphRevision: String(row.graph_revision),
    query: String(row.query),
    result: JSON.parse(String(row.result)) as StructureQueryResultSummary,
    recordedAt: String(row.recorded_at),
    actor: String(row.actor),
    hlc: { physical: Number(row.hlc_physical), logical: Number(row.hlc_logical), actor: String(row.hlc_actor) },
  };
  if (row.ref !== null && row.ref !== undefined) record.ref = String(row.ref);
  return record;
}

/** ADR-010 §3.3: every committed query event, newest-last, optionally filtered. */
export function readStructureQueries(db: DatabaseSync, filter: StructureQueryFilter = {}): StructureQueryRow[] {
  const clauses: string[] = [];
  const params: SQLInputValue[] = [];
  if (filter.revision !== undefined) { clauses.push('graph_revision = ?'); params.push(filter.revision); }
  if (filter.granularity !== undefined) { clauses.push('granularity = ?'); params.push(filter.granularity); }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT * FROM structure_queries${where} ORDER BY hlc_physical, hlc_logical, hlc_actor, event_id`).all(...params) as Record<string, unknown>[];
  return rows.map(rowToStructureQuery);
}

/** ADR-010 §3.4: only `file` granularity at exactly the current revision counts. */
export function currentExploredFiles(db: DatabaseSync, revision: string): string[] {
  const rows = db.prepare('SELECT file FROM explored_files WHERE graph_revision = ? ORDER BY file').all(revision) as { file?: unknown }[];
  return rows.map((row) => String(row.file));
}

/** ADR-010 §3.3: current evidence plus files whose latest evidence is stale. */
export function exploredState(db: DatabaseSync, revision: string): ExploredState {
  const rows = db.prepare('SELECT file, graph_revision FROM explored_files ORDER BY file').all() as { file?: unknown; graph_revision?: unknown }[];
  const explored: string[] = [];
  const stale: string[] = [];
  for (const row of rows) {
    if (String(row.graph_revision) === revision) explored.push(String(row.file));
    else stale.push(String(row.file));
  }
  return { explored, stale };
}

/** Revision of the most recent file-level query, across revisions (summary only). */
export function readLatestStructureQueryRevision(db: DatabaseSync): string | null {
  const row = db.prepare("SELECT graph_revision FROM structure_queries WHERE granularity = 'file' ORDER BY hlc_physical DESC, hlc_logical DESC, hlc_actor DESC, event_id DESC LIMIT 1").get() as { graph_revision?: unknown } | undefined;
  return row?.graph_revision === undefined ? null : String(row.graph_revision);
}
