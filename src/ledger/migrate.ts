/**
 * Read-only migration from the legacy `.pm/*.json` stores into ledger events.
 *
 * The source directory is never written: every file is opened with `readFile`
 * and re-hashed after the run so the caller can prove it was unchanged. Tasks
 * become real `task.created` / `task.updated` events (so task counts and status
 * views match), while milestones, features and the full source record become
 * `migration.recorded` events that preserve the original JSON without inventing
 * new domain semantics.
 *
 * Every write has a deterministic idempotency key derived from the source id
 * and (for records) a hash of the normalized source record. Re-running against
 * unchanged sources therefore appends zero new events; changing a record appends
 * a new historically-versioned record event instead of rewriting history.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { canonicalJson } from './event.ts';
import { IdempotencyConflictError, Ledger, type TaskStatus } from './ledger.ts';
import { isTaskStatus } from './views.ts';
import { listSegmentFiles, scanSegment } from './append.ts';
import {
  ProjectScanError,
  resolveProjectScan,
  type ProjectScanOptions,
  type ResolvedProjectScan,
  type ScanDiscovery,
} from '../core/project-scan.ts';

export const MIGRATION_KEY_PREFIX = 'ano:migrate:v1';
export const DEFAULT_MIGRATION_SOURCES = ['.pm/tasks.json', '.pm/roadmap.json', '.pm/features.json', '.pm/sessions.json'] as const;

export class MigrationError extends Error {
  readonly code = 'MIGRATION_ERROR';
  constructor(message: string) { super(message); this.name = 'MigrationError'; }
}

export interface MigrationSource {
  path: string;
  sha256: string | null;
  bytes: number;
  records: number;
  missing: boolean;
}
export interface MigrationTaskCounts {
  total: number;
  created: number;
  duplicate: number;
  updated: number;
  skipped: number;
}
export interface MigrationTaskPlan {
  id: string;
  title?: string;
  declaredFiles: string[];
  sourceStatus: string;
  ledgerStatus: TaskStatus;
  sourceSha256: string;
  existing: boolean;
  conflict: boolean;
}
export interface MigrationPlan {
  root: string;
  sources: MigrationSource[];
  sourceDigest: string;
  tasks: MigrationTaskPlan[];
  records: { milestones: number; features: number; sessions: number };
  existingLedgerTasks: number;
  conflicts: string[];
  sourceUnchanged: boolean;
  canApply: boolean;
}
export interface MigrationResult {
  root: string;
  sources: MigrationSource[];
  tasks: MigrationTaskCounts;
  milestones: number;
  features: number;
  sessions: number;
  apiWrites: number;
  duplicates: number;
  eventsCommitted: number;
  ledgerTasks: number;
  sourceUnchanged: boolean;
  startedAt: string;
  finishedAt: string;
}
export interface MigrationOptions {
  actor?: string;
  sessionId?: string;
  /** Defaults to the `.pm` JSON files this project actually uses. */
  sources?: string[];
  /** `error` (default) refuses divergent task creation; `skip` records a drift event. */
  onConflict?: 'error' | 'skip';
  /** Optional digest from a prior read-only plan; apply refuses stale plans. */
  expectedSourceDigest?: string;
}

/**
 * Auditable three-root resolution for migration/takeover (ADR-009 §10).
 *
 * `pmRoot` is the authoritative PM data root and defaults to the Git root;
 * `sourceRoots` are only the scan targets and never become the PM source.
 */
export interface MigrationRootResolution {
  readonly inputRoot: string;
  readonly gitRoot: string;
  readonly pmRoot: string;
  readonly sourceRoots: string[];
  readonly ignoredPmRoots: string[];
  readonly rootResolution: ResolvedProjectScan['rootResolution'];
  readonly discovery: ScanDiscovery;
}

/** Find the enclosing Git work-tree root by walking the ancestor chain only. */
function findGitRootSync(start: string): string | null {
  let directory = resolve(start);
  for (;;) {
    if (existsSync(join(directory, '.git'))) return directory;
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

/** `lstat`-based directory test: a symlink or plain file is not a `.pm` root. */
function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Bind a migration/takeover input to the authoritative PM root.
 *
 * The PM root is the Git root. A `.pm` below a source subdirectory (for example
 * `server/.pm`) is never the main source: when the input is below the Git root,
 * the Git root must carry `.pm`, otherwise the call fails with
 * `PM_ROOT_WITHOUT_PM` instead of silently migrating the wrong tree. Roots
 * without Git metadata keep the legacy behaviour (the input itself is the PM
 * root) so existing non-Git fixtures and stores remain usable.
 */
export function resolveMigrationPmRoot(rootInput: string): string {
  const candidate = resolve(rootInput);
  const gitRoot = findGitRootSync(candidate);
  if (gitRoot !== null && candidate !== gitRoot) {
    if (isDirectory(join(gitRoot, '.pm'))) return gitRoot;
    throw new ProjectScanError(
      'PM_ROOT_WITHOUT_PM',
      `Refusing to use a source subdirectory .pm as the PM root; the Git root has no .pm: ${candidate}`,
    );
  }
  return candidate;
}

/**
 * Full async resolution consumed by the migration/takeover surfaces. Unlike
 * {@link resolveMigrationPmRoot} this also discovers the Node source roots and
 * reports `ignoredPmRoots`, and it propagates the ADR-009 error codes
 * (`NO_NODE_PACKAGE`, `AMBIGUOUS_SOURCE_ROOTS`, `ROOT_ROLE_CONFLICT`,
 * `PM_ROOT_WITHOUT_PM`).
 */
export async function resolveMigrationRoot(
  rootInput: string,
  options: ProjectScanOptions = {},
): Promise<MigrationRootResolution> {
  const scan = await resolveProjectScan({ ...options, startRoot: rootInput });
  return {
    inputRoot: scan.startRoot,
    gitRoot: scan.gitRoot,
    pmRoot: scan.pmRoot,
    sourceRoots: [...scan.sourceRoots],
    ignoredPmRoots: [...scan.ignoredPmRoots],
    rootResolution: { ...scan.rootResolution },
    discovery: scan.discovery,
  };
}

interface LoadedSource {
  source: MigrationSource;
  json: unknown;
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}
function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function nonEmptyText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}
function normalizeFiles(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const files = value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.replaceAll('\\', '/'));
  return [...new Set(files)].sort();
}
const statusAliases: Record<string, TaskStatus> = {
  todo: 'todo',
  pending: 'todo',
  open: 'todo',
  blocked: 'todo',
  failed: 'todo',
  in_progress: 'in_progress',
  inprogress: 'in_progress',
  active: 'in_progress',
  done: 'done',
  complete: 'done',
  completed: 'done',
  cancelled: 'cancelled',
  canceled: 'cancelled',
};
interface MappedStatus {
  /** Status the ledger may hold after migration. A legacy `done` never maps to `done`. */
  status: TaskStatus;
  /** Lower-cased legacy status when it differs from the ledger status. */
  original?: string;
  verified?: boolean;
  warning?: string;
}
/**
 * Legacy statuses are evidence-free claims. In particular:
 * - `done` is not a verified completion, so it migrates to `in_progress` with
 *   `verified: false` and a warning; only Gate evidence may complete a task;
 * - `blocked`/`failed`/`pending`/`open` still map to `todo`, but the original
 *   status is preserved on the task and in a migration warning instead of
 *   being silently dropped.
 */
function mapStatus(value: unknown): MappedStatus {
  if (value === undefined || value === null) return { status: 'todo' };
  if (typeof value !== 'string') throw new MigrationError('Task status must be a string');
  const original = value.trim().toLowerCase();
  if (original.length === 0) return { status: 'todo' };
  const mapped = statusAliases[original] ?? 'todo';
  if (mapped === 'done') {
    return {
      status: 'in_progress',
      original,
      verified: false,
      warning: 'legacy done is not a verified completion; migrated to in_progress until Gate evidence exists',
    };
  }
  if (mapped === 'todo' && original !== 'todo') {
    return {
      status: 'todo',
      original,
      warning: `legacy status ${original} was imported as todo; the original status is preserved in original_status`,
    };
  }
  if (mapped !== original) return { status: mapped, original };
  return { status: mapped };
}
/** Empty title / completion / verification text is dropped, not migrated as an empty claim. */
function sanitizeRecord(record: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) continue;
    if (typeof value === 'string' && value.trim().length === 0) {
      if (key === 'title' || key === 'result_note' || key === 'verification' || key === 'detail') continue;
    }
    result[key] = value;
  }
  return result;
}
function arrayAt(json: unknown, key: string, path: string): unknown[] {
  if (!isRecord(json)) throw new MigrationError(`${path} must contain a JSON object`);
  const value = json[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new MigrationError(`${path} field ${key} must be an array`);
  return value;
}
function loadSource(root: string, path: string): LoadedSource {
  const parts = path.split('/');
  if (!path.startsWith('.pm/') || parts.some((part) => part === '..' || part === '.' || part.length === 0)) {
    throw new MigrationError(`Migration source must stay inside .pm/: ${path}`);
  }
  let current = resolve(root);
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    try {
      const info = lstatSync(current);
      if (info.isSymbolicLink()) throw new MigrationError(`Migration source contains a symbolic link: ${path}`);
      if (index < parts.length - 1 && !info.isDirectory()) throw new MigrationError(`Migration source parent is not a directory: ${path}`);
      if (index === parts.length - 1 && !info.isFile()) throw new MigrationError(`Migration source is not a regular file: ${path}`);
    } catch (error) {
      if (error instanceof MigrationError) throw error;
      if (errorCode(error) === 'ENOENT') return { source: { path, sha256: null, bytes: 0, records: 0, missing: true }, json: undefined };
      throw error;
    }
  }
  const absolute = current;
  let bytes: Buffer;
  try {
    bytes = readFileSync(absolute);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { source: { path, sha256: null, bytes: 0, records: 0, missing: true }, json: undefined };
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new MigrationError(`${path} is not valid JSON`);
  }
  return { source: { path, sha256: sha256(bytes), bytes: bytes.length, records: 0, missing: false }, json };
}
function committedEventCount(ledgerDir: string): number {
  let count = 0;
  for (const name of listSegmentFiles(ledgerDir)) count += scanSegment(readFileSync(join(ledgerDir, name))).events.length;
  return count;
}

function migrationSourceDigest(sources: MigrationSource[]): string {
  return sha256(canonicalJson(sources.map((source) => ({ path: source.path, sha256: source.sha256, missing: source.missing }))));
}

function committedTaskIdentities(root: string): Map<string, { title?: string; files: string[]; status: TaskStatus }> {
  const directory = join(root, '.ano', 'ledger');
  const tasks = new Map<string, { title?: string; files: string[]; status: TaskStatus }>();
  for (const name of listSegmentFiles(directory)) {
    const segment = scanSegment(readFileSync(join(directory, name)));
    for (const event of segment.events) {
      const payload = event.payload;
      if (event.kind === 'task.created' && typeof payload.task_id === 'string') {
        const files = Array.isArray(payload.declared_files) ? payload.declared_files.filter((item): item is string => typeof item === 'string') : [];
        const status = isTaskStatus(payload.status) ? payload.status : 'todo';
        tasks.set(payload.task_id, { ...(typeof payload.title === 'string' ? { title: payload.title } : {}), files, status });
      } else if (event.kind === 'task.updated' && typeof payload.task_id === 'string') {
        const task = tasks.get(payload.task_id);
        if (task && isTaskStatus(payload.status)) task.status = payload.status;
      }
    }
  }
  return tasks;
}

/** Read-only preview. It does not open/initialize a Ledger or create .ano/. */
export function planMigration(root: string, options: Pick<MigrationOptions, 'sources'> = {}): MigrationPlan {
  const projectRoot = resolveMigrationPmRoot(root);
  const sourcePaths = options.sources ?? [...DEFAULT_MIGRATION_SOURCES];
  if (new Set(sourcePaths).size !== sourcePaths.length) throw new MigrationError('Migration source paths must be unique');
  const loaded = sourcePaths.map((path) => loadSource(projectRoot, path));
  const tasksSource = loaded.find((entry) => entry.source.path === '.pm/tasks.json');
  const plannedTasks: MigrationTaskPlan[] = [];
  if (tasksSource && !tasksSource.source.missing) {
    const rows = arrayAt(tasksSource.json, 'tasks', tasksSource.source.path);
    tasksSource.source.records = rows.length;
    const seen = new Set<string>();
    for (const raw of rows) {
      if (!isRecord(raw)) throw new MigrationError('.pm/tasks.json tasks entries must be objects');
      const id = nonEmptyText(raw.id);
      if (!id) throw new MigrationError('.pm/tasks.json contains a task without an id');
      if (seen.has(id)) throw new MigrationError(`.pm/tasks.json contains duplicate task id ${id}`);
      seen.add(id);
      const title = nonEmptyText(raw.title);
      const declaredFiles = normalizeFiles(raw.files);
      const mapped = mapStatus(raw.status);
      plannedTasks.push({
        id,
        ...(title === undefined ? {} : { title }),
        declaredFiles,
        sourceStatus: typeof raw.status === 'string' ? raw.status : 'todo',
        ledgerStatus: mapped.status,
        sourceSha256: sha256(canonicalJson(sanitizeRecord(raw))),
        existing: false,
        conflict: false,
      });
    }
  }
  const roadmap = loaded.find((entry) => entry.source.path === '.pm/roadmap.json');
  const featureSource = loaded.find((entry) => entry.source.path === '.pm/features.json');
  const sessions = loaded.find((entry) => entry.source.path === '.pm/sessions.json');
  const milestoneCount = roadmap && !roadmap.source.missing ? arrayAt(roadmap.json, 'milestones', roadmap.source.path).length : 0;
  const featureCount = featureSource && !featureSource.source.missing ? arrayAt(featureSource.json, 'features', featureSource.source.path).length : 0;
  const sessionCount = sessions && !sessions.source.missing ? arrayAt(sessions.json, 'sessions', sessions.source.path).length : 0;
  if (roadmap && !roadmap.source.missing) roadmap.source.records = milestoneCount;
  if (featureSource && !featureSource.source.missing) featureSource.source.records = featureCount;
  if (sessions && !sessions.source.missing) sessions.source.records = sessionCount;

  const existing = committedTaskIdentities(projectRoot);
  const conflicts: string[] = [];
  const tasks = plannedTasks.map((task) => {
    const prior = existing.get(task.id);
    if (!prior) return task;
    const conflict = prior.title !== task.title || canonicalJson(prior.files) !== canonicalJson(task.declaredFiles);
    if (conflict) conflicts.push(task.id);
    return { ...task, existing: true, conflict };
  });
  const after = sourcePaths.map((path) => loadSource(projectRoot, path).source);
  const identity = (source: MigrationSource) => ({ path: source.path, sha256: source.sha256, bytes: source.bytes, missing: source.missing });
  const sourceUnchanged = canonicalJson(loaded.map((entry) => identity(entry.source))) === canonicalJson(after.map(identity));
  const sources = after.map((source, index) => ({ ...source, records: loaded[index]!.source.records }));
  return {
    root: projectRoot,
    sources,
    sourceDigest: migrationSourceDigest(sources),
    tasks,
    records: { milestones: milestoneCount, features: featureCount, sessions: sessionCount },
    existingLedgerTasks: existing.size,
    conflicts,
    sourceUnchanged,
    canApply: sourceUnchanged && conflicts.length === 0,
  };
}

/** Latest committed migration summary, or undefined when the project was never migrated. */
export function readMigrationSummary(root: string): Record<string, unknown> | undefined {
  const directory = join(resolveMigrationPmRoot(root), '.ano', 'ledger');
  let latest: Record<string, unknown> | undefined;
  for (const name of listSegmentFiles(directory)) {
    for (const event of scanSegment(readFileSync(join(directory, name))).events) {
      if (event.kind === 'migration.recorded' && event.payload.entity === 'migration') latest = event.payload;
    }
  }
  return latest;
}

/** Read-only reconciliation summary comparing PM task IDs to committed ledger tasks. */
export function reconcileMigration(root: string, options: Pick<MigrationOptions, 'sources'> = {}): Record<string, unknown> {
  const plan = planMigration(root, options);
  const missing = plan.tasks.filter((task) => !task.existing).map((task) => task.id);
  const present = plan.tasks.filter((task) => task.existing && !task.conflict).map((task) => task.id);
  return {
    schema: 'ano.migration-reconcile/1',
    root: plan.root,
    sourceDigest: plan.sourceDigest,
    sourceUnchanged: plan.sourceUnchanged,
    canApply: plan.canApply,
    sourceTasks: plan.tasks.length,
    ledgerTasks: plan.existingLedgerTasks,
    matched: present.length,
    missing,
    conflicts: plan.conflicts,
    records: plan.records,
  };
}

export async function migrateProject(root: string, options: MigrationOptions = {}): Promise<MigrationResult> {
  const projectRoot = resolveMigrationPmRoot(root);
  const sourcePaths = options.sources ?? [...DEFAULT_MIGRATION_SOURCES];
  const onConflict = options.onConflict ?? 'error';
  const startedAt = new Date().toISOString();
  const loaded = sourcePaths.map((path) => loadSource(projectRoot, path));
  const sourceDigestAtStart = migrationSourceDigest(loaded.map((entry) => entry.source));
  if (options.expectedSourceDigest !== undefined && options.expectedSourceDigest !== sourceDigestAtStart) {
    throw new MigrationError('Migration source changed since plan; nothing was written');
  }
  const beforeApply = sourcePaths.map((path) => loadSource(projectRoot, path).source);
  if (migrationSourceDigest(beforeApply) !== sourceDigestAtStart) throw new MigrationError('Migration source changed before apply; nothing was written');
  const plan = planMigration(projectRoot, { sources: sourcePaths });
  if (!plan.sourceUnchanged || (plan.conflicts.length > 0 && onConflict === 'error')) {
    throw new MigrationError('Migration plan is stale or has task conflicts; nothing was written');
  }
  const ledger = await Ledger.open(projectRoot, {
    ...(options.actor === undefined ? {} : { actor: options.actor }),
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
  });
  const ledgerDir = ledger.ledgerDir;
  const beforeEvents = committedEventCount(ledgerDir);
  const tasks: MigrationTaskCounts = { total: 0, created: 0, duplicate: 0, updated: 0, skipped: 0 };
  let milestones = 0;
  let features = 0;
  let sessionRecords = 0;
  let sessionSourceCount = 0;
  let apiWrites = 0;
  let duplicates = 0;
  try {
    const taskSource = loaded.find((entry) => entry.source.path === '.pm/tasks.json');
    if (taskSource && !taskSource.source.missing) {
      const records = arrayAt(taskSource.json, 'tasks', taskSource.source.path);
      taskSource.source.records = records.length;
      tasks.total = records.length;
      const seen = new Set<string>();
      for (const raw of records) {
        if (!isRecord(raw)) throw new MigrationError('.pm/tasks.json tasks entries must be objects');
        const id = nonEmptyText(raw.id);
        if (!id) throw new MigrationError('.pm/tasks.json contains a task without an id');
        if (seen.has(id)) throw new MigrationError(`.pm/tasks.json contains duplicate task id ${id}`);
        seen.add(id);
        const title = nonEmptyText(raw.title);
        const declaredFiles = normalizeFiles(raw.files);
        const status = mapStatus(raw.status);        const record = sanitizeRecord(raw);
        const recordHash = sha256(canonicalJson(record));
        try {
          const created = await ledger.createTask(id, declaredFiles, title, `${MIGRATION_KEY_PREFIX}:task.created:${id}`);
          if (created.duplicate) tasks.duplicate += 1; else { tasks.created += 1; apiWrites += 1; }
        } catch (error) {
          if (!(error instanceof IdempotencyConflictError) || onConflict !== 'skip') throw error;
          tasks.skipped += 1;
          const drift = await ledger.append({
            kind: 'migration.recorded',
            payload: { source_file: taskSource.source.path, entity: 'task.drift', id, source_sha256: recordHash, data: record },
          }, `${MIGRATION_KEY_PREFIX}:drift:task:${id}:${recordHash}`);
          if (drift.duplicate) duplicates += 1; else apiWrites += 1;
        }
        if (status.status !== 'todo' || status.original !== undefined) {
          const update = await ledger.append({
            kind: 'task.updated',
            payload: {
              task_id: id,
              status: status.status,
              ...(status.original === undefined ? {} : { original_status: status.original }),
              ...(status.verified === undefined ? {} : { verified: status.verified }),
              ...(status.warning === undefined ? {} : { migration_warning: status.warning }),
            },
          }, `${MIGRATION_KEY_PREFIX}:task.updated:${id}:${status.status}:${status.original ?? 'direct'}`);
          if (update.duplicate) duplicates += 1; else { tasks.updated += 1; apiWrites += 1; }
        }
        const recorded = await ledger.append({
          kind: 'migration.recorded',
          payload: { source_file: taskSource.source.path, entity: 'task', id, source_sha256: recordHash, data: record },
        }, `${MIGRATION_KEY_PREFIX}:record:task:${id}:${recordHash}`);
        if (recorded.duplicate) duplicates += 1; else apiWrites += 1;
      }
    }

    for (const [path, listKey, entity] of [['.pm/roadmap.json', 'milestones', 'milestone'], ['.pm/features.json', 'features', 'feature']] as const) {
      const source = loaded.find((entry) => entry.source.path === path);
      if (!source || source.source.missing) continue;
      const records = arrayAt(source.json, listKey, path);
      source.source.records = records.length;
      for (const raw of records) {
        if (!isRecord(raw)) throw new MigrationError(`${path} ${listKey} entries must be objects`);
        const id = nonEmptyText(raw.id) ?? nonEmptyText(raw.name);
        if (!id) throw new MigrationError(`${path} contains a ${entity} without an id`);
        const recordHash = sha256(canonicalJson(raw));
        const recorded = await ledger.append({
          kind: 'migration.recorded',
          payload: { source_file: path, entity, id, source_sha256: recordHash, data: raw },
        }, `${MIGRATION_KEY_PREFIX}:record:${entity}:${id}:${recordHash}`);
        if (recorded.duplicate) duplicates += 1; else apiWrites += 1;
        if (entity === 'milestone') milestones += 1; else features += 1;
      }
    }

    const sessions = loaded.find((entry) => entry.source.path === '.pm/sessions.json');
    if (sessions && !sessions.source.missing) {
      const sessionRows = arrayAt(sessions.json, 'sessions', sessions.source.path);
      const seenSessions = new Set<string>();
      sessions.source.records = sessionRows.length;
      sessionSourceCount = sessionRows.length;
      for (const raw of sessionRows) {
        if (!isRecord(raw) || !nonEmptyText(raw.id)) continue;
        const id = nonEmptyText(raw.id)!;
        if (seenSessions.has(id)) throw new MigrationError(`.pm/sessions.json contains duplicate session id ${id}`);
        seenSessions.add(id);
        const data = sanitizeRecord(raw);
        const recordHash = sha256(canonicalJson(data));
        const result = await ledger.append({
          kind: 'migration.recorded',
          payload: { source_file: sessions.source.path, entity: 'session', id, source_sha256: recordHash, data },
        }, `${MIGRATION_KEY_PREFIX}:record:session:${id}:${recordHash}`);
        if (result.duplicate) duplicates += 1; else { apiWrites += 1; sessionRecords += 1; }
      }
    }

    const afterRead = sourcePaths.map((path) => loadSource(projectRoot, path).source);
    const identity = (source: MigrationSource) => ({ path: source.path, sha256: source.sha256, bytes: source.bytes, missing: source.missing });
    const sourceUnchanged = canonicalJson(loaded.map((entry) => identity(entry.source))) === canonicalJson(afterRead.map(identity));
    const sourceDigest = migrationSourceDigest(loaded.map((entry) => entry.source));
    const summary = await ledger.append({
      kind: 'migration.recorded',
      payload: {
        source_file: '.pm',
        entity: 'migration',
        id: `migrate-${sourceDigest.slice(0, 26)}`,
        source_sha256: sourceDigest,
        sources: afterRead.map(identity),
        // Stable source-derived record counts only. Run-specific counters would
        // change the canonical payload and turn an unchanged re-run into a new
        // event, which would violate "second migration appends zero".
        source_records: { tasks: tasks.total, milestones, features, sessions: sessionSourceCount },
      },
    }, `${MIGRATION_KEY_PREFIX}:summary:${sourceDigest}`);
    if (summary.duplicate) duplicates += 1; else apiWrites += 1;

    const ledgerTasks = ledger.getTasks().length;
    const finishedAt = new Date().toISOString();
    return {
      root: projectRoot,
      sources: afterRead.map((source, index) => ({ ...source, records: loaded[index]!.source.records })),
      tasks,
      milestones,
      features,
      sessions: sessionRecords,
      apiWrites,
      duplicates,
      eventsCommitted: committedEventCount(ledgerDir) - beforeEvents,
      ledgerTasks,
      sourceUnchanged,
      startedAt,
      finishedAt,
    };
  } finally {
    ledger.close();
  }
}

/** CLI-friendly alias: `ano migrate` runs exactly this library function. */
export const migrate = migrateProject;
