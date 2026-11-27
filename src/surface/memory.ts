import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonicalJson } from '../ledger/event.ts';
import type { Ledger, LedgerNote } from '../ledger/ledger.ts';
import { replayLedger } from '../ledger/replay.ts';
import { initViews, readMemoryEdges, readMemoryRecord, syncViews, viewDigest, type MemoryEdge, type MemoryEdgeKind } from '../ledger/views.ts';
import { SyntheticFixtureAdapter } from '../memory/adapter.ts';
import { resolveAnchor, sha256, type AnchorSource, type MemoryAnchor } from '../memory/anchor.ts';
import { ingestAll, type ProviderIngestReport } from '../memory/ingest.ts';
import {
  MemoryNoteBook,
  MemoryNoteError,
  toLedgerNotePayload,
  validateMemoryFactRecord,
  validateMemoryNote,
  type MemoryFactKind,
  type MemoryNote,
  type MemoryNoteKind,
} from '../memory/note.ts';
import { deriveProbeContextId, probe, ProbeRequestError, type ProbeAnchorHealth, type ProbeCandidate, type ProbeCandidateSource, type ProbeEdge, type ProbeEntryQuery } from '../memory/probe.ts';
import {
  anchorProbeRequestSchema,
  anchorProbeResponseSchema,
  type AnchorProbeRequest,
  type AnchorProbeResponse,
  type AnchorProbeSnapshot,
  type AnchorProbeSourceHealth,
} from '../memory/probe-contract.ts';
import {
  listMemoryFactVersions,
  listMemoryRecords,
  listUnresolvedMemoryConflicts,
  readMemoryRelations,
  resolveMemoryFact,
  type MemoryConflictReport,
  type MemoryFactRead,
  type MemoryFactReadOptions,
  type MemoryRecord,
  type MemoryRelations,
} from '../memory/state.ts';
import { HistoryStore } from '../memory/store.ts';
import type { MemoryCounts, ProviderState, RecallHit, RecallQuery } from '../memory/types.ts';
import { recallConnected } from '../connect/index.ts';
import type { RecallResult } from '../connect/index.ts';
import { takeoverStatus } from '../connect/takeover.ts';
import type { TakeoverState } from '../connect/takeover-policy.ts';

/**
 * M5 Surface memory wiring (note / recall) per ADR-0003.
 *
 * The main controller owns tool registration; this module only exposes the two
 * service functions it can call:
 *   - noteSurface(ledger, input): validate a note, append `note.recorded` with
 *     the caller's idempotency key, and verify the ledger replay before
 *     reporting success.
 *   - recallSurface(root, input): open only `.ano/cache/history.db`, explicitly
 *     ingest project-local synthetic fixtures under `.ano/memory/synthetic/`,
 *     run the structured recall query, and close the store.
 *
 * No provider root is accepted from the caller: the synthetic root is always
 * derived from the project root, and no real client session is read.
 */

const SYNTHETIC_RELATIVE_ROOT = '.ano/memory/synthetic';
const HISTORY_DB_RELATIVE = '.ano/cache/history.db';
const DEFAULT_RECALL_LIMIT = 20;
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

// ============================================================================
// ADR-006 / docs/takeover.md §5: Surface takeover-state projection.
//
// The Surface never writes `.ano/takeover/**`. It reads the authoritative
// policy only through `takeoverStatus(root)` and projects it into the
// brief/track/note/recall outputs:
//   - `enforced`: ANO is the primary writer; the legacy PM source is read-only.
//   - `recovery`: ANO writes are suspended until `takeover recover` completes.
//   - `disabled`: the legacy PM path stays primary (Connect normal mode).
// A takeover state never produces Gate evidence and never changes Gate
// permissions; it only routes Surface writes and reports the role matrix.
// ============================================================================

export type TakeoverSurfaceState = TakeoverState;
export type TakeoverPrimaryWriter = 'ano' | 'legacy';
export type TakeoverLegacyRole = 'write' | 'read-only' | 'recovering';
export type TakeoverScopeOwner = 'ano' | 'legacy' | 'suspended';
export type TakeoverScopeName = 'tasks' | 'memory' | 'acceptance' | 'dag';

export interface TakeoverSurfaceStatus {
  readonly state: TakeoverSurfaceState;
  readonly primaryWriter: TakeoverPrimaryWriter;
  readonly legacyRole: TakeoverLegacyRole;
  readonly hostCapability: 'full' | 'degraded' | null;
  readonly enforcedAt: string | null;
  /** ADR-006 §5 role matrix; unauthorized scopes stay on the legacy writer. */
  readonly permissions: Readonly<Record<TakeoverScopeName, TakeoverScopeOwner>>;
  /** Default ANO workflow advertised while enforced. */
  readonly workflow: readonly string[];
  readonly nextStep: string;
}

export type TakeoverSurfaceSnapshot =
  | { readonly kind: 'absent' }
  | { readonly kind: 'ready'; readonly status: TakeoverSurfaceStatus }
  | { readonly kind: 'unreadable'; readonly error: string };

function takeoverPermissions(state: TakeoverSurfaceState, scope: readonly string[]): Record<TakeoverScopeName, TakeoverScopeOwner> {
  const authorized = new Set(scope);
  const owner = (name: TakeoverScopeName): TakeoverScopeOwner => {
    if (state === 'recovery') return 'suspended';
    if (state === 'disabled') return 'legacy';
    return authorized.has(name) ? 'ano' : 'legacy';
  };
  return {
    tasks: owner('tasks'),
    memory: owner('memory'),
    acceptance: owner('acceptance'),
    dag: owner('dag'),
  };
}

/**
 * Read the takeover projection for a project root. `absent` means no takeover
 * management exists (ordinary project, Connect normal mode); `unreadable`
 * fails closed instead of guessing at a corrupt/foreign policy document.
 */
export function readTakeoverSurface(root: string): TakeoverSurfaceSnapshot {
  let status;
  try {
    status = takeoverStatus(root);
  } catch (error) {
    return { kind: 'unreadable', error: error instanceof Error ? error.message : String(error) };
  }
  if (status.policy === null && status.authorization === null) return { kind: 'absent' };
  const state = status.state;
  const scope = status.policy?.authorization.scope ?? status.authorization?.scope ?? [];
  const primaryWriter: TakeoverPrimaryWriter = state === 'enforced' ? 'ano' : 'legacy';
  const legacyRole: TakeoverLegacyRole = state === 'enforced' ? 'read-only' : state === 'recovery' ? 'recovering' : 'write';
  const workflow: readonly string[] = state === 'enforced'
    ? ['brief', 'track', 'note', 'verify']
    : state === 'disabled'
      ? ['connect']
      : [];
  const nextStep = state === 'enforced'
    ? 'ANO 主写：默认使用 brief/track/note/verify；旧 PM（.pm/）只读，不双写、不回写。'
    : state === 'recovery'
      ? '接管恢复中：ANO 暂停主写；先完成 `takeover recover` 对账，再恢复旧源主写。'
      : 'PM-mcp 主写、ANO 只读（Connect 普通模式）；如需接管须先 `takeover grant` 再 `takeover --confirm`。';
  return {
    kind: 'ready',
    status: {
      state,
      primaryWriter,
      legacyRole,
      hostCapability: status.hostCapability,
      enforcedAt: status.enforcedAt,
      permissions: takeoverPermissions(state, scope),
      workflow,
      nextStep,
    },
  };
}

/**
 * The optional `{ takeover }` output field. `null` keeps the ordinary-project
 * output byte-compatible; a corrupt policy is reported as `state: "unknown"`
 * rather than hidden.
 */
export function takeoverSurfaceField(root: string): Record<string, unknown> | null {
  const snapshot = readTakeoverSurface(root);
  if (snapshot.kind === 'absent') return null;
  if (snapshot.kind === 'unreadable') return { takeover: { state: 'unknown', error: snapshot.error } };
  return { takeover: snapshot.status };
}

/**
 * Gate every ANO ledger write behind the takeover state. `enforced` and
 * `disabled` write through the native ANO path; `recovery` and an unreadable
 * policy fail closed with zero mutations.
 */
export function assertTakeoverAllowsNativeWrite(root: string): TakeoverSurfaceStatus | null {
  const snapshot = readTakeoverSurface(root);
  if (snapshot.kind === 'absent') return null;
  if (snapshot.kind === 'unreadable') {
    throw new Error(`takeover policy is unreadable (${snapshot.error}); refusing to write`);
  }
  if (snapshot.status.state === 'recovery') {
    throw new Error('takeover is in recovery: ANO writes are paused; run `takeover recover` before writing (no mutation was performed)');
  }
  return snapshot.status;
}

const NOTE_INPUT_KEYS = new Set(['root', 'idem_key', 'kind', 'text', 'anchor']);
const NOTE_ANCHOR_KEYS = new Set(['file', 'symbol_id', 'qualified_name', 'content_fragment_hash']);
const RECALL_INPUT_KEYS = new Set(['root', 'session', 'from', 'to', 'file', 'symbol', 'keyword', 'provider']);

export interface NoteSurfaceAnchor {
  readonly file: string;
  readonly symbol_id?: string;
  readonly qualified_name?: string;
  readonly content_fragment_hash?: string;
}

/** Tool-shaped (`note`) input; the anchor keys match tool-catalog.ts exactly. */
export interface NoteSurfaceInput {
  readonly root?: string;
  readonly idem_key: string;
  readonly kind: MemoryNoteKind;
  readonly text: string;
  readonly anchor?: NoteSurfaceAnchor;
}

/**
 * A MemoryNoteBook holding the recorded note plus replay metadata. `get(id)`
 * and `list()` keep answering from the book; `status`, `duplicate`, `note`,
 * `eventId` and `recorded` are the enumerable fields the MCP/CLI wiring can
 * serialize directly.
 */
export type NoteSurfaceBook = MemoryNoteBook & {
  readonly status: 'recorded' | 'duplicate';
  readonly duplicate: boolean;
  readonly note: MemoryNote;
  readonly eventId: string | null;
  readonly recorded: readonly MemoryNote[];
};

/** Tool-shaped (`recall`) input. No visibility/limit/offset: the tool schema has none. */
export interface RecallSurfaceInput {
  readonly root?: string;
  readonly session?: string;
  readonly from?: string;
  readonly to?: string;
  readonly file?: string;
  readonly symbol?: string;
  readonly keyword?: string;
  readonly provider?: string;
  /** Connected-mode free-text query; requires `source: 'connected'`. */
  readonly query?: string;
  /** Connected-mode result limit (1..100); ignored by the legacy mode. */
  readonly limit?: number;
  /** Selects the imported pm-mcp record store instead of the synthetic history. */
  readonly source?: 'connected';
}

export type RecallSurfaceStatus = 'ok' | 'degraded' | 'not_configured';

export interface RecallSurfaceProvenance {
  readonly kind: 'ano-memory-recall';
  readonly source: 'synthetic-fixtures';
  readonly historyDb: string;
  readonly syntheticRoot: string;
  readonly providers: readonly string[];
  readonly generatedAt: string;
}

export interface RecallSurfaceSummary {
  readonly configured: boolean;
  readonly mode: 'structured' | 'fts' | 'like' | 'none';
  readonly total: number;
  readonly returned: number;
  readonly limit: number;
  readonly offset: number;
  readonly ftsAvailable: boolean | null;
  readonly rebuilt: boolean | null;
  readonly counts: MemoryCounts | null;
  readonly providers: readonly ProviderState[];
  readonly providerReports: readonly ProviderIngestReport[];
  readonly skippedArtifacts: number;
}

export interface RecallSurfaceResult {
  readonly status: RecallSurfaceStatus;
  /** Recall text is untrusted data; callers must never execute or evaluate it. */
  readonly untrusted: true;
  readonly provenance: RecallSurfaceProvenance;
  /** Non-empty whenever anything was skipped, degraded or unconfigured. */
  readonly degraded: readonly string[];
  readonly summary: RecallSurfaceSummary;
  readonly hits: readonly RecallHit[];
  /** ADR-006 takeover projection; absent for an ordinary project. Read-only. */
  readonly takeover?: Record<string, unknown>;
}

/**
 * Record a note through the ledger. The note id is content-derived
 * (`kind + text + anchor`); the idempotency key is the caller's dedupe key.
 *
 * Idempotency contract:
 * - the same `idem_key` with the same note returns `duplicate: true` and does
 *   not add a second view row;
 * - if the note id already exists, its original `created_at` is reused so a
 *   retry after a process restart produces the identical payload;
 * - a key reused for a different note propagates `IdempotencyConflictError`;
 * - after every append the note is re-read from the ledger and compared; a
 *   mismatch throws instead of reporting success.
 */
export async function noteSurface(ledger: Ledger, input: NoteSurfaceInput): Promise<NoteSurfaceBook> {
  assertTakeoverAllowsNativeWrite(ledger.root);
  const { idemKey, note: validated } = parseNoteInput(input);
  const existing = ledger.getNote(validated.id);
  let note = validated;
  if (existing) {
    // created_at is not part of the note id. Reusing the recorded timestamp
    // makes a same-key retry byte-identical instead of a payload conflict.
    note = { ...validated, createdAt: existing.createdAt };
    assertStoredNote(existing, note);
  }

  const appended = await ledger.append({ kind: 'note.recorded', payload: toLedgerNotePayload(note) }, idemKey);
  const stored = ledger.getNote(note.id);
  if (!stored) throw new Error(`note.recorded ${note.id} was not materialized in the ledger`);
  assertStoredNote(stored, note);

  const book = new MemoryNoteBook();
  const recorded = await book.record(note);
  if (recorded.note.id !== note.id) throw new Error('In-memory note book disagrees with the validated note id');

  const duplicate = appended.duplicate || existing !== undefined;
  return augmentNoteBook(book, {
    status: duplicate ? ('duplicate' as const) : ('recorded' as const),
    duplicate,
    note,
    eventId: appended.event?.id ?? null,
    recorded: book.list(),
  });
}

interface NoteSurfaceMetadata {
  readonly status: 'recorded' | 'duplicate';
  readonly duplicate: boolean;
  readonly note: MemoryNote;
  readonly eventId: string | null;
  readonly recorded: readonly MemoryNote[];
}

function augmentNoteBook(book: MemoryNoteBook, metadata: NoteSurfaceMetadata): NoteSurfaceBook {
  // MemoryNoteBook stores its journal in own fields named `notes`/`sink`.
  // Never assign metadata over those names; hiding them also keeps
  // JSON.stringify(result) focused on the note fields the caller needs.
  for (const key of ['notes', 'sink']) {
    const descriptor = Object.getOwnPropertyDescriptor(book, key);
    if (descriptor?.enumerable) Object.defineProperty(book, key, { ...descriptor, enumerable: false });
  }
  return Object.assign(book, metadata);
}

/**
 * Recall session history from the only permitted sources:
 * - `<root>/.ano/cache/history.db` (the rebuildable cache);
 * - synthetic fixture units explicitly present under
 *   `<root>/.ano/memory/synthetic/`.
 *
 * Layout is intentionally narrow. If the synthetic root contains unit
 * directories directly (each with `unit.json`), the root is one provider named
 * `synthetic`; otherwise each direct subdirectory is a provider whose name is
 * the provider id. A missing/empty synthetic root returns `not_configured`
 * without opening or creating the database, and no other directory is scanned.
 *
 * The result always carries `untrusted`, `provenance`, `degraded` and
 * `summary`, including for `not_configured`.
 */
export async function recallSurface(root: string, input: RecallSurfaceInput): Promise<RecallSurfaceResult> {
  if (input.source !== undefined) throw new Error("recall source=connected is handled by recallConnectedSurface");
  if (input.query !== undefined) throw new Error("recall field query requires source='connected'");
  const query = parseRecallInput(input);
  const projectRoot = await requireProjectRoot(root);
  const syntheticRoot = join(projectRoot, '.ano', 'memory', 'synthetic');
  const takeoverField = takeoverSurfaceField(projectRoot);

  const rootState = await syntheticRootState(syntheticRoot);
  if (rootState !== 'directory') return { ...notConfigured(`synthetic-root-${rootState}`), ...(takeoverField ?? {}) };

  const planned = await planSyntheticProviders(syntheticRoot);
  if (planned.plans.length === 0) return { ...notConfigured('no-provider-directories', planned.degraded), ...(takeoverField ?? {}) };

  const store = HistoryStore.open(projectRoot);
  try {
    const reports = await ingestAll(store, planned.plans.map((plan) => ({
      adapter: new SyntheticFixtureAdapter({ provider: plan.provider }),
      root: plan.root,
    })));
    const recall = store.recall(query);
    const history = store.summary();

    const degraded = [...planned.degraded];
    for (const report of reports) {
      if (report.status === 'failed') {
        degraded.push(`provider:${report.provider}:failed${report.error ? `:${report.error}` : ''}`);
      } else if (report.status === 'degraded') {
        degraded.push(`provider:${report.provider}:degraded${report.error ? `:${report.error}` : ''}`);
      } else if (report.skipped > 0) {
        degraded.push(`provider:${report.provider}:skipped:${report.skipped}`);
      }
    }
    if (recall.degraded !== null) degraded.push(`recall:${recall.degraded}`);

    return {
      status: degraded.length === 0 ? 'ok' : 'degraded',
      untrusted: true,
      provenance: {
        kind: 'ano-memory-recall',
        source: 'synthetic-fixtures',
        historyDb: HISTORY_DB_RELATIVE,
        syntheticRoot: SYNTHETIC_RELATIVE_ROOT,
        providers: planned.plans.map((plan) => plan.provider),
        generatedAt: new Date().toISOString(),
      },
      degraded,
      summary: {
        configured: true,
        mode: recall.mode,
        total: recall.total,
        returned: recall.hits.length,
        limit: recall.limit,
        offset: recall.offset,
        ftsAvailable: recall.ftsAvailable,
        rebuilt: history.rebuilt,
        counts: history.counts,
        providers: history.providers,
        providerReports: reports,
        skippedArtifacts: history.skippedArtifacts.length,
      },
      hits: recall.hits,
      ...(takeoverField ?? {}),
    };
  } finally {
    store.close();
  }
}

/**
 * Connected-mode recall: search the imported pm-mcp record store through the
 * Connect engine. This never opens the native Ledger/Graph/history DB, so it is
 * valid for non-Node, non-Git roots, and it never records imported text as a
 * note or executes it as a script.
 */
export async function recallConnectedSurface(root: string, input: RecallSurfaceInput): Promise<RecallResult> {
  if (input.source !== 'connected') throw new Error("recallConnectedSurface requires source='connected'");
  const limit = typeof input.limit === 'number' ? input.limit : DEFAULT_RECALL_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('recall field limit must be an integer between 1 and 100');
  return await recallConnected(root, { query: parseConnectedRecallInput(input), limit });
}

function parseNoteInput(input: NoteSurfaceInput): { readonly idemKey: string; readonly note: MemoryNote } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new MemoryNoteError('Note input must be an object');
  const record = input as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!NOTE_INPUT_KEYS.has(key)) throw new MemoryNoteError(`note does not accept field ${JSON.stringify(key)}`);
  }
  const idemKey = record.idem_key;
  if (typeof idemKey !== 'string' || idemKey.length === 0 || idemKey.length > 128) {
    throw new MemoryNoteError('note idem_key must be a non-empty string of at most 128 characters');
  }
  const anchor = record.anchor === undefined ? undefined : mapNoteAnchor(record.anchor);
  return {
    idemKey,
    note: validateMemoryNote({
      kind: record.kind as MemoryNoteKind,
      text: record.text as string,
      ...(anchor === undefined ? {} : { anchor }),
    }),
  };
}

function mapNoteAnchor(value: unknown): MemoryAnchor {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new MemoryNoteError('Note anchor must be an object');
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!NOTE_ANCHOR_KEYS.has(key)) throw new MemoryNoteError(`Note anchor does not accept field ${JSON.stringify(key)}`);
  }
  const file = record.file;
  if (typeof file !== 'string' || file.length === 0) throw new MemoryNoteError('Note anchor file must be a non-empty string');
  const symbolId = optionalAnchorString(record.symbol_id, 'symbol_id');
  const qualifiedName = optionalAnchorString(record.qualified_name, 'qualified_name');
  const contentFragmentHash = optionalAnchorString(record.content_fragment_hash, 'content_fragment_hash');
  return {
    file,
    ...(symbolId === undefined ? {} : { symbolId }),
    ...(qualifiedName === undefined ? {} : { qualifiedName }),
    ...(contentFragmentHash === undefined ? {} : { contentFragmentHash }),
  };
}

function optionalAnchorString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) throw new MemoryNoteError(`Note anchor ${field} must be a non-empty string`);
  return value;
}

function assertStoredNote(stored: LedgerNote, note: MemoryNote): void {
  const sameAnchor = canonicalJson(stored.anchor ?? null) === canonicalJson(note.anchor ?? null);
  if (stored.id !== note.id || stored.kind !== note.kind || stored.text !== note.text || stored.createdAt !== note.createdAt || !sameAnchor) {
    throw new Error(`Ledger note ${note.id} does not match the validated note; refusing to report success`);
  }
}

function parseRecallInput(input: RecallSurfaceInput): RecallQuery {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Recall input must be an object');
  const record = input as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!RECALL_INPUT_KEYS.has(key)) throw new Error(`recall does not accept field ${JSON.stringify(key)}; only structured filters are supported`);
  }
  const session = optionalRecallString(record.session, 'session');
  const from = optionalRecallTimestamp(record.from, 'from');
  const to = optionalRecallTimestamp(record.to, 'to');
  if (from !== undefined && to !== undefined && Date.parse(from) > Date.parse(to)) {
    throw new Error('recall field from must not be after to');
  }
  const file = optionalRecallString(record.file, 'file');
  const symbol = optionalRecallString(record.symbol, 'symbol');
  const keyword = optionalRecallString(record.keyword, 'keyword');
  const provider = optionalRecallString(record.provider, 'provider');
  return {
    visibility: 'visible',
    limit: DEFAULT_RECALL_LIMIT,
    offset: 0,
    ...(session === undefined ? {} : { session }),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...(file === undefined ? {} : { file }),
    ...(symbol === undefined ? {} : { symbol }),
    ...(keyword === undefined ? {} : { keyword }),
    ...(provider === undefined ? {} : { provider }),
  };
}

function parseConnectedRecallInput(input: RecallSurfaceInput): string {
  const record = input as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'root' && key !== 'query' && key !== 'source' && key !== 'limit') {
      throw new Error(`recall source=connected does not accept field ${JSON.stringify(key)}; only query and limit are supported`);
    }
  }
  const query = record.query;
  if (query === undefined) return '';
  if (typeof query !== 'string' || query.length === 0) throw new Error('recall field query must be a non-empty string');
  if (query.length > 4096) throw new Error('recall field query exceeds 4096 characters');
  return query;
}

function optionalRecallString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) throw new Error(`recall field ${field} must be a non-empty string`);
  if (value.length > 4096) throw new Error(`recall field ${field} exceeds 4096 characters`);
  return value;
}

function optionalRecallTimestamp(value: unknown, field: string): string | undefined {
  const timestamp = optionalRecallString(value, field);
  if (timestamp === undefined) return undefined;
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error(`recall field ${field} must be an ISO timestamp`);
  return timestamp;
}

interface ProviderPlan {
  readonly provider: string;
  readonly root: string;
}

interface ProviderPlanResult {
  readonly plans: readonly ProviderPlan[];
  readonly degraded: readonly string[];
}

async function planSyntheticProviders(syntheticRoot: string): Promise<ProviderPlanResult> {
  const entries = (await readdir(syntheticRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
  const degraded: string[] = [];

  // Unit directories directly under the synthetic root mean the root itself is
  // the provider root. This mirrors the fixture layout used by the P4 tests
  // (`<root>/<unit>/unit.json`).
  for (const entry of entries) {
    if (await isFile(join(syntheticRoot, entry.name, 'unit.json'))) {
      return { plans: [{ provider: 'synthetic', root: syntheticRoot }], degraded };
    }
  }

  const plans: ProviderPlan[] = [];
  for (const entry of entries) {
    if (!PROVIDER_ID_PATTERN.test(entry.name)) {
      degraded.push(`provider:${entry.name}:invalid-name`);
      continue;
    }
    plans.push({ provider: entry.name, root: join(syntheticRoot, entry.name) });
  }
  return { plans, degraded };
}

type SyntheticRootState = 'missing' | 'symlink' | 'not-directory' | 'directory';

async function syntheticRootState(path: string): Promise<SyntheticRootState> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return 'symlink';
    return info.isDirectory() ? 'directory' : 'not-directory';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function notConfigured(reason: string, extraDegraded: readonly string[] = []): RecallSurfaceResult {
  return {
    status: 'not_configured',
    untrusted: true,
    provenance: {
      kind: 'ano-memory-recall',
      source: 'synthetic-fixtures',
      historyDb: HISTORY_DB_RELATIVE,
      syntheticRoot: SYNTHETIC_RELATIVE_ROOT,
      providers: [],
      generatedAt: new Date().toISOString(),
    },
    degraded: [`not-configured:${reason}`, ...extraDegraded],
    summary: {
      configured: false,
      mode: 'none',
      total: 0,
      returned: 0,
      limit: 0,
      offset: 0,
      ftsAvailable: null,
      rebuilt: null,
      counts: null,
      providers: [],
      providerReports: [],
      skippedArtifacts: 0,
    },
    hits: [],
  };
}

/**
 * Mirrors `service.existingProjectRoot` deliberately: this module must be
 * importable from the controller without a service <-> memory module cycle.
 */
async function requireProjectRoot(path: string): Promise<string> {
  const root = resolve(path);
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new Error(code === 'ENOENT' ? `Project root does not exist: ${root}` : `Cannot read project root ${root}: ${code ?? 'unknown error'}`);
  }
  if (!entries.includes('package.json')) throw new Error(`No package.json at ${root}`);
  if (!isGitWorkTree(root)) throw new Error(`A Git work tree is required at ${root}`);
  return root;
}

function isGitWorkTree(root: string): boolean {
  try {
    const output = execFileSync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    return output.trim() === 'true';
  } catch {
    return false;
  }
}

// ============================================================================
// ADR-005 P1 Surface wiring: explicit versioned memory revise/relate plus the
// governed fact read path (current/historical reads, typed relations and a
// Probe candidate source over the versioned projection).
//
// These are internal callable paths for the P2 tool contracts; none of them
// changes the MCP tool catalog. The legacy `noteSurface` branch above keeps
// its original semantics untouched: free text without a supersedes declaration
// continues to be recorded through `note.recorded`, and legacy notes are never
// promoted automatically (ADR-005 §8).
// ============================================================================

const REVISE_INPUT_KEYS = new Set(['idem_key', 'fact_key', 'kind', 'text', 'anchor', 'supersedes', 'reason', 'effective_from', 'effective_to']);
const RELATE_INPUT_KEYS = new Set(['idem_key', 'edge', 'from_ref', 'to_ref', 'reason']);
const FACT_INPUT_KEYS = new Set(['fact_key', 'mode', 'as_of', 'now']);
const FACT_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{1,119}$/u;
const RECORD_REF_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/u;
const FACT_EDGES = new Set(['depends_on', 'explains', 'related_to']);

/**
 * Private projection access for the versioned memory read path. The views
 * database is a rebuildable cache: the committed segments are replayed and
 * re-synced on every call so a read never observes a stale projection. The
 * connection is private and always closed.
 */
function withMemoryViews<T>(ledger: Ledger, read: (db: DatabaseSync) => T): T {
  const entries = existsSync(ledger.ledgerDir) ? replayLedger(ledger.ledgerDir).entries : [];
  const db = new DatabaseSync(join(ledger.cacheDir, 'views.db'));
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    initViews(db);
    syncViews(db, entries);
    return read(db);
  } finally {
    db.close();
  }
}

function requireIsoDatetimeOrNull(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !value.includes('T') || !value.endsWith('Z') || !Number.isFinite(Date.parse(value))) {
    throw new MemoryNoteError(`field ${field} must be an explicit ISO-8601 UTC datetime or null (null means unknown)`);
  }
  return value;
}

function requireIdemKey(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new MemoryNoteError(`${what} idem_key must be a non-empty string of at most 128 characters`);
  }
  return value;
}

export interface MemoryReviseSurfaceInput {
  readonly idem_key: string;
  readonly fact_key: string;
  readonly kind: MemoryFactKind;
  readonly text: string;
  readonly anchor?: NoteSurfaceAnchor;
  /**
   * Explicit prior-version declaration (ADR-005 §4.1): `[]` declares the
   * genesis version of an unused fact_key; `[headRef]` is a linear revision
   * naming the current head, or the event id of a legacy note.recorded being
   * governed. The field must be present even for a genesis version — "no
   * prior version" is a declared fact, never an omitted one.
   */
  readonly supersedes: readonly string[];
  readonly reason: string;
  readonly effective_from: string | null;
  readonly effective_to: string | null;
}

export interface MemoryReviseSurfaceResult {
  readonly status: 'recorded' | 'duplicate';
  readonly duplicate: boolean;
  readonly eventId: string;
  readonly factKey: string;
  readonly supersedes: readonly string[];
  /** The introduced record as the projection materialized it (read back). */
  readonly record: MemoryRecord;
  /** The declared prior version as the projection now holds it (read back): null when genesis, superseded when linear or a governed legacy note. */
  readonly prior: MemoryRecord | null;
  /** Governed current read of the fact after the append. */
  readonly fact: MemoryFactRead;
}

function parseReviseInput(input: MemoryReviseSurfaceInput): {
  readonly idemKey: string;
  readonly factKey: string;
  readonly supersedes: readonly string[];
  readonly recordValue: Record<string, unknown>;
  readonly factRecord: ReturnType<typeof validateMemoryFactRecord>;
  readonly payload: Record<string, unknown>;
} {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new MemoryNoteError('revise input must be an object');
  const record = input as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!REVISE_INPUT_KEYS.has(key)) throw new MemoryNoteError(`revise does not accept field ${JSON.stringify(key)}`);
  }
  const idemKey = requireIdemKey(record.idem_key, 'revise');
  const factKey = record.fact_key;
  if (typeof factKey !== 'string' || !FACT_KEY_PATTERN.test(factKey)) {
    throw new MemoryNoteError('revise fact_key must match ^[a-z0-9][a-z0-9._-]{1,119}$ (e.g. local.storage.engine)');
  }
  const reason = record.reason;
  if (typeof reason !== 'string' || reason.length < 1 || reason.length > 2000) {
    throw new MemoryNoteError('revise reason is required and must be 1..2000 characters');
  }
  // The prior-version declaration must be explicit; an omitted field is not a
  // genesis declaration (ADR-005 §4.1).
  const supersedes = record.supersedes;
  if (!Array.isArray(supersedes) || supersedes.length > 1 || supersedes.some((ref) => typeof ref !== 'string' || !RECORD_REF_PATTERN.test(ref))) {
    throw new MemoryNoteError('revise supersedes must be an explicit array of 0 or 1 ledger event ids (Crockford ULID); [] declares a genesis version');
  }
  if (!Object.hasOwn(record, 'effective_from') || !Object.hasOwn(record, 'effective_to')) {
    throw new MemoryNoteError('revise requires explicit effective_from and effective_to (ISO datetime or null when unknown)');
  }
  const effectiveFrom = requireIsoDatetimeOrNull(record.effective_from, 'effective_from');
  const effectiveTo = requireIsoDatetimeOrNull(record.effective_to, 'effective_to');
  if (effectiveFrom !== null && effectiveTo !== null && Date.parse(effectiveFrom) > Date.parse(effectiveTo)) {
    throw new MemoryNoteError('revise effective_from must not be after effective_to');
  }
  const anchor = record.anchor === undefined ? undefined : mapNoteAnchor(record.anchor);
  const factRecord = validateMemoryFactRecord({
    kind: record.kind as MemoryFactKind,
    text: record.text as string,
    ...(anchor === undefined ? {} : { anchor }),
  });
  const recordValue: Record<string, unknown> = { kind: factRecord.kind, text: factRecord.text, ...(factRecord.anchor ? { anchor: factRecord.anchor } : {}) };
  return {
    idemKey,
    factKey,
    supersedes: [...supersedes as string[]],
    factRecord,
    recordValue,
    payload: {
      intent: 'revise',
      fact_key: factKey,
      record: recordValue,
      supersedes: [...supersedes as string[]],
      reason,
      effective_from: effectiveFrom,
      effective_to: effectiveTo,
    },
  };
}

/**
 * Explicit versioned fact write (ADR-005 §4.1 revise branch): append one
 * `memory.revised` event carrying the complete new record, then read the fact
 * back through the versioned state read path before reporting success.
 *
 * Failure semantics: a precondition rejection (unknown ref, stale prior,
 * undecided conflict, unused/used genesis slot) leaves zero ledger rows; a
 * post-append read-back mismatch throws instead of reporting success — the
 * committed event stays auditable, but no caller is told it succeeded either.
 * The same idem_key with the same parameters returns the original event
 * (`duplicate: true`) and commits nothing new (ADR-005 §4: one revision, one
 * commit).
 */
export async function noteReviseSurface(
  ledger: Ledger,
  input: MemoryReviseSurfaceInput,
  options: Pick<MemoryFactReadOptions, 'now'> = {},
): Promise<MemoryReviseSurfaceResult> {
  assertTakeoverAllowsNativeWrite(ledger.root);
  const { idemKey, payload, factKey, supersedes, factRecord, recordValue } = parseReviseInput(input);
  const appended = await ledger.append({ kind: 'memory.revised', payload }, idemKey);
  const event = appended.event;
  if (event === undefined) throw new Error('memory.revised append returned no event');
  const priorRef = supersedes.length === 1 ? supersedes[0] : undefined;
  const read = withMemoryViews(ledger, (db) => ({
    materialized: readMemoryRecord(db, event.id),
    prior: priorRef === undefined ? null : readMemoryRecord(db, priorRef) ?? null,
    fact: resolveMemoryFact(db, factKey, { mode: 'current', ...(options.now === undefined ? {} : { now: options.now }) }),
  }));
  const stored = read.materialized;
  if (!stored) throw new Error(`memory.revised ${event.id} was not materialized in the memory projection`);
  const expectedHash = sha256(canonicalJson(recordValue));
  const sameAnchor = canonicalJson(stored.anchor ?? null) === canonicalJson(factRecord.anchor ?? null);
  if (stored.factKey !== factKey || stored.kind !== factRecord.kind || stored.text !== factRecord.text
    || stored.contentHash !== expectedHash || !sameAnchor || stored.eligibility !== 'governed') {
    throw new Error(`memory.revised ${event.id} does not match the submitted record; refusing to report success`);
  }
  if (!appended.duplicate) {
    if (stored.status !== 'active') {
      throw new Error(`memory.revised ${event.id} materialized with status ${stored.status}; refusing to report success`);
    }
    if (read.fact.headRef !== event.id) {
      throw new Error(`memory.revised ${event.id} is not the head of ${factKey}; refusing to report success`);
    }
    if (priorRef !== undefined && read.prior === null) {
      throw new Error(`memory.revised ${event.id} declared prior ${priorRef} is unresolvable after the append; refusing to report success`);
    }
    if (priorRef !== undefined && read.prior?.status !== 'superseded') {
      throw new Error(`memory.revised ${event.id} prior ${priorRef} is ${read.prior?.status ?? 'unknown'}, not superseded; refusing to report success`);
    }
  }
  return {
    status: appended.duplicate ? ('duplicate' as const) : ('recorded' as const),
    duplicate: appended.duplicate,
    eventId: event.id,
    factKey,
    supersedes: [...supersedes],
    record: stored,
    prior: read.prior,
    fact: read.fact,
  };
}

export interface MemoryRelateSurfaceInput {
  readonly idem_key: string;
  readonly edge: MemoryEdgeKind;
  readonly from_ref: string;
  readonly to_ref: string;
  readonly reason?: string;
}

export interface MemoryRelateSurfaceResult {
  readonly status: 'recorded' | 'duplicate';
  readonly duplicate: boolean;
  readonly eventId: string;
  /** The registered edge as the projection materialized it (read back). */
  readonly edge: MemoryEdge;
}

function parseRelateInput(input: MemoryRelateSurfaceInput): { readonly idemKey: string; readonly payload: Record<string, unknown>; readonly edge: MemoryEdgeKind } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new MemoryNoteError('relate input must be an object');
  const record = input as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!RELATE_INPUT_KEYS.has(key)) throw new MemoryNoteError(`relate does not accept field ${JSON.stringify(key)}`);
  }
  const idemKey = requireIdemKey(record.idem_key, 'relate');
  const edge = record.edge;
  if (typeof edge !== 'string' || !FACT_EDGES.has(edge)) {
    throw new MemoryNoteError('relate edge must be one of depends_on, explains, related_to');
  }
  const fromRef = record.from_ref;
  const toRef = record.to_ref;
  for (const [field, value] of [['from_ref', fromRef], ['to_ref', toRef]] as const) {
    if (typeof value !== 'string' || !RECORD_REF_PATTERN.test(value)) {
      throw new MemoryNoteError(`relate ${field} must be a ledger event id (Crockford ULID) that resolves in this ledger`);
    }
  }
  const reason = record.reason;
  if (reason !== undefined && (typeof reason !== 'string' || reason.length < 1 || reason.length > 2000)) {
    throw new MemoryNoteError('relate reason must be 1..2000 characters when provided');
  }
  return {
    idemKey,
    edge: edge as MemoryEdgeKind,
    payload: {
      edge,
      from_ref: fromRef,
      to_ref: toRef,
      ...(reason === undefined ? {} : { reason }),
    },
  };
}

/**
 * Explicit typed relation between two records (ADR-005 §4.2): append one
 * `memory.related` event and read the edge back. A relation never changes any
 * fact's status; duplicate edges are rejected by the ledger and retries reuse
 * the original idempotency key.
 */
export async function noteRelateSurface(ledger: Ledger, input: MemoryRelateSurfaceInput): Promise<MemoryRelateSurfaceResult> {
  assertTakeoverAllowsNativeWrite(ledger.root);
  const { idemKey, payload, edge } = parseRelateInput(input);
  const appended = await ledger.append({ kind: 'memory.related', payload }, idemKey);
  const event = appended.event;
  if (event === undefined) throw new Error('memory.related append returned no event');
  const fromRef = payload.from_ref as string;
  const toRef = payload.to_ref as string;
  const stored = withMemoryViews(ledger, (db) => readMemoryEdges(db, fromRef).find((candidate) =>
    candidate.fromRef === fromRef && candidate.toRef === toRef && candidate.edge === edge));
  if (!stored) throw new Error(`memory.related ${event.id} was not materialized in the memory projection`);
  if (stored.eventId !== event.id) {
    throw new Error(`memory.related edge ${edge} ${fromRef} -> ${toRef} belongs to event ${stored.eventId}; refusing to report success`);
  }
  return {
    status: appended.duplicate ? ('duplicate' as const) : ('recorded' as const),
    duplicate: appended.duplicate,
    eventId: event.id,
    edge: stored,
  };
}

export interface MemoryFactSurfaceInput {
  readonly fact_key: string;
  /** Defaults to `current`; `historical` requires `as_of`. */
  readonly mode?: 'current' | 'historical';
  /** ISO datetime for historical reads; never backfilled from recorded_at. */
  readonly as_of?: string;
  /** Deterministic clock override for current reads. */
  readonly now?: string;
}

export interface MemoryFactSurfaceResult {
  /** The governed fact read per ADR-005 §9 (usable current fact, historical evidence, retracted, conflicted...). */
  readonly fact: MemoryFactRead;
  /** Every version ever introduced for the fact, genesis first. */
  readonly versions: readonly MemoryRecord[];
  /** Typed relation edges touching the resolved/head record; null when none applies. */
  readonly relations: MemoryRelations | null;
}

function parseFactInput(input: MemoryFactSurfaceInput): { readonly factKey: string; readonly options: MemoryFactReadOptions } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new MemoryNoteError('fact input must be an object');
  const record = input as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!FACT_INPUT_KEYS.has(key)) throw new MemoryNoteError(`fact read does not accept field ${JSON.stringify(key)}`);
  }
  const factKey = record.fact_key;
  if (typeof factKey !== 'string' || !FACT_KEY_PATTERN.test(factKey)) {
    throw new MemoryNoteError('fact read fact_key must match ^[a-z0-9][a-z0-9._-]{1,119}$ (e.g. local.storage.engine)');
  }
  const mode = record.mode === undefined ? 'current' : record.mode;
  if (mode !== 'current' && mode !== 'historical') throw new MemoryNoteError('fact read mode must be current or historical');
  const asOf = record.as_of === undefined ? undefined : requireIsoDatetimeOrNull(record.as_of, 'as_of') ?? undefined;
  const now = record.now === undefined ? undefined : requireIsoDatetimeOrNull(record.now, 'now') ?? undefined;
  if (mode === 'historical' && asOf === undefined) throw new MemoryNoteError('fact read mode historical requires as_of');
  if (asOf !== undefined && mode !== 'historical') throw new MemoryNoteError('fact read as_of requires mode historical');
  if (now !== undefined && mode !== 'current') throw new MemoryNoteError('fact read now applies to current reads only');
  return { factKey, options: { mode, ...(asOf === undefined ? {} : { asOf }), ...(now === undefined ? {} : { now }) } };
}

/**
 * Governed fact query path (ADR-005 §9/§10 read model): resolve one fact in
 * `current` or `historical` mode, list its versions and the typed relations of
 * the resolved record. Legacy notes (no fact_key) are unreachable here by
 * construction; undecided conflicts are reported, never resolved by replay
 * order.
 */
export async function memoryFactSurface(ledger: Ledger, input: MemoryFactSurfaceInput): Promise<MemoryFactSurfaceResult> {
  const { factKey, options } = parseFactInput(input);
  return withMemoryViews(ledger, (db) => {
    const fact = resolveMemoryFact(db, factKey, options);
    const relationsRef = fact.record?.recordRef ?? fact.headRef;
    return {
      fact,
      versions: listMemoryFactVersions(db, factKey),
      relations: relationsRef !== null && relationsRef !== undefined ? readMemoryRelations(db, relationsRef) : null,
    };
  });
}

export interface MemoryProbeSourceOptions {
  /** Deterministic clock forwarded to the probe core for CURRENT reads. */
  readonly now?: string;
  /** Graph-backed anchor resolution; omit for a ledger-only source. */
  readonly anchorSource?: AnchorSource;
}

function memoryRecordCandidate(record: MemoryRecord, options: MemoryProbeSourceOptions): ProbeCandidate {
  const anchor = record.anchor === undefined ? undefined : record.anchor as unknown as MemoryAnchor;
  const resolution = anchor !== undefined && options.anchorSource !== undefined ? resolveAnchor(anchor, options.anchorSource) : undefined;
  const health: AnchorProbeSourceHealth = resolution === undefined ? 'unknown' : resolution.status === 'stale' ? 'stale' : 'verified_at_snapshot';
  const anchorHealth: ProbeAnchorHealth = resolution === undefined
    ? { status: 'none', file: anchor?.file ?? null }
    : {
      status: resolution.status === 'exact' ? 'exact' : resolution.status === 'relocated' ? 'relocated' : 'stale',
      file: resolution.file,
    };
  return {
    record_ref: record.recordRef,
    fact_key: record.factKey,
    task_id: null,
    file: anchor?.file ?? null,
    symbol: anchor?.qualifiedName ?? null,
    source: anchor?.file === undefined ? { kind: 'native_note' } : { kind: 'native_note', path: anchor.file },
    source_health: health,
    status: record.status,
    content: record.text,
    content_hash: record.contentHash,
    recorded_at: record.recordedAt,
    effective_from: record.effectiveFrom,
    effective_to: record.effectiveTo,
    superseded_by: record.supersededBy ?? null,
    version: record.version,
    anchor: anchorHealth,
    // Eligibility is a read-side qualifier: it keeps legacy_unreviewed records
    // from passing as approved facts (ADR-005 §8) and never upgrades status.
    qualifiers: [record.eligibility],
  };
}

function matchesMemoryProbeQuery(candidate: ProbeCandidate, query: ProbeEntryQuery): boolean {
  if (query.fact_key !== undefined && candidate.fact_key !== query.fact_key) return false;
  if (query.task_id !== undefined && candidate.task_id !== query.task_id) return false;
  if (query.file !== undefined && candidate.file !== query.file) return false;
  if (query.symbol !== undefined && candidate.symbol !== query.symbol) return false;
  return true;
}

/**
 * Build the Probe candidate source from the versioned projection (read model
 * in `state.ts`). Candidates are the materialized records verbatim — status,
 * effective interval, version and eligibility come from the projection and are
 * never re-derived here. Undecided fork branches are excluded: a conflicted
 * record is never returned as evidence (ADR-005 §7); the probe wrapper reports
 * the fork itself in the response conflicts.
 */
function buildMemoryProbeSource(db: DatabaseSync, snapshot: AnchorProbeSnapshot, options: MemoryProbeSourceOptions): ProbeCandidateSource {
  const candidates: ProbeCandidate[] = [];
  for (const record of listMemoryRecords(db)) {
    if (record.status === 'conflicted') continue;
    candidates.push(memoryRecordCandidate(record, options));
  }
  const edges: ProbeEdge[] = readMemoryEdges(db).map((edge) => ({
    from: edge.fromRef,
    to: edge.toRef,
    kind: edge.edge,
    provenance: 'confirmed' as const,
  }));
  return {
    snapshot,
    entries: (query?: ProbeEntryQuery) => (query === undefined ? candidates : candidates.filter((candidate) => matchesMemoryProbeQuery(candidate, query))),
    edges: () => edges,
  };
}

/** Read-only candidate source over the versioned projection of an open ledger. */
export function memoryProbeSource(ledger: Ledger, snapshot: AnchorProbeSnapshot, options: MemoryProbeSourceOptions = {}): ProbeCandidateSource {
  return withMemoryViews(ledger, (db) => buildMemoryProbeSource(db, snapshot, options));
}

export interface MemoryProbeRunOptions extends MemoryProbeSourceOptions {
  /** Caller-sampled snapshot; the default binds only the ledger commit digest. */
  readonly snapshot?: AnchorProbeSnapshot;
}

function ledgerOnlySnapshot(ledger: Ledger, projectScope: string): AnchorProbeSnapshot {
  const digest = existsSync(ledger.ledgerDir) ? viewDigest(replayLedger(ledger.ledgerDir).entries) : viewDigest([]);
  return { project_scope: projectScope, ledger_digest: digest, graph_revision: null, source_fingerprint: null, connected_digest: null };
}

/**
 * Report undecided projection forks (ADR-005 §7) in the probe response. The
 * P0 core detects equal-version conflicts between active evidence, which a
 * single-head projection cannot produce; these entries carry the projection's
 * undecided branch sets instead. Forks on required facts are referenced from
 * coverage_gate.unresolved_conflicts so the gate cannot claim SUFFICIENT.
 */
function withProjectionForks(response: AnchorProbeResponse, conflicts: readonly MemoryConflictReport[], required: readonly string[]): AnchorProbeResponse {
  if (conflicts.length === 0) return response;
  const requiredSet = new Set(required);
  const forks = conflicts.map((conflict, index) => ({
    conflict_id: `fork-${index + 1}`,
    fact_key: conflict.factKey,
    record_refs: [...conflict.branches],
    status: 'unresolved' as const,
  }));
  const referenced = forks.filter((fork) => requiredSet.has(fork.fact_key)).map((fork) => fork.conflict_id);
  let gate = response.coverage_gate;
  if (referenced.length > 0 && gate.status === 'SUFFICIENT') {
    gate = {
      ...gate,
      status: 'INSUFFICIENT' as const,
      missing_facts: [...new Set([...gate.missing_facts, ...forks.filter((fork) => referenced.includes(fork.conflict_id)).map((fork) => fork.fact_key)])],
    };
  }
  return anchorProbeResponseSchema.parse({
    ...response,
    conflicts: [...response.conflicts, ...forks],
    coverage_gate: { ...gate, unresolved_conflicts: [...gate.unresolved_conflicts, ...referenced] },
  });
}

/**
 * Run one read-only AnchorProbe request over the versioned memory projection.
 * The P0 probe core is used unchanged; this wrapper binds the request root to
 * the open ledger, feeds projection-backed candidates and re-reports undecided
 * projection forks in the response conflicts.
 */
export function memoryProbeSurface(ledger: Ledger, rawRequest: unknown, options: MemoryProbeRunOptions = {}): AnchorProbeResponse {
  let request: AnchorProbeRequest;
  try {
    request = anchorProbeRequestSchema.parse(rawRequest);
  } catch (error) {
    throw new ProbeRequestError('AnchorProbe request failed schema validation', { cause: error });
  }
  if (resolve(request.root) !== ledger.root) {
    throw new ProbeRequestError(`AnchorProbe request root ${request.root} does not match the open ledger ${ledger.root}`);
  }
  const snapshot = options.snapshot ?? ledgerOnlySnapshot(ledger, request.project_scope);
  const { source, conflicts } = withMemoryViews(ledger, (db) => ({
    source: buildMemoryProbeSource(db, snapshot, options),
    conflicts: listUnresolvedMemoryConflicts(db),
  }));
  const response = withProjectionForks(
    probe(request, source, options.now === undefined ? {} : { now: options.now }),
    conflicts,
    request.required_facts ?? [],
  );
  return { ...response, context_id: deriveProbeContextId(request, response) };
}
