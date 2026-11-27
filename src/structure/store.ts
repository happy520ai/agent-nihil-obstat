import { lstat, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { defaultScanExclude, fingerprintTree, type SourceFingerprint } from '../core/fingerprint.ts';
import { fingerprintSourceRoots, isPythonBytecode } from '../core/source-scan.ts';
import {
  createScanBudget,
  resolveProjectScan,
  scanBudgetExhausted,
  type ProjectScanOptions,
  type ResolvedProjectScan,
  type ScanBudget,
  type ScanStatus,
} from '../core/project-scan.ts';
import { emptyCaveats, type CallEdge, type CallLabel, type CallProvenance, type CaveatDynamicLoadSite, type CaveatSemanticGap, type DynamicLoadPattern, type DynamicLoadTier, type EdgeKind, type EdgeProvenance, type GraphCaveats, type GraphEdge, type GraphSnapshot, type SourceFile, type SymbolNode } from './types.ts';
import { buildSnapshot, ENABLE_PYTHON_STRUCTURE, EXTRACTOR_VERSION, supportedStructureExtensions, type BuildReport, type ParsedCache } from './extractor.ts';
import { createPythonResolutionContext } from './imports-python.ts';
import type { ParsedFile } from './extractors/ts.ts';
import { checkGraphFreshness, collectSourceMetadata, metadataMatches, recheckManifestContent, type SourceMetadata } from './fresh.ts';
import type { Freshness } from './types.ts';

export type { BuildReport, ParsedCache } from './extractor.ts';
export type { Freshness } from './types.ts';
export type { FreshnessCheck } from './fresh.ts';
export type { Resolution, ResolutionContext, ResolutionStatus, PathAliasRule, WorkspaceEntry, WorkspacePackage } from './imports.ts';
export type { ExportResolution, BarrelLabel, WildcardTarget } from './barrel.ts';
export type { ParsedFile, ParsedImport, LocalDefinition, NamedExport, SymbolKind, LocalCall, LocalMember, LocalInstance } from './extractors/ts.ts';

export interface GraphStoreOpenOptions {
  wasmDirectory?: string;
  /** Test/degradation seam for source reads during incremental rebuilds. */
  readFile?: (absolutePath: string) => Promise<string>;
  /**
   * ADR-009 §9 unified scan options. Accepts an already-resolved scan or raw
   * `ProjectScanOptions` (resolved against `root`). Absent means the legacy
   * single-root/default-exclude behaviour.
   */
  scan?: ResolvedProjectScan | ProjectScanOptions;
  /** Force `build()` even when a valid cache exists (`cache.rebuild`). */
  rebuild?: boolean;
  /**
   * Test seam only: opt into Python L0/L1 structure and make cache validity
   * mode-aware. Production omits it, so `ENABLE_PYTHON_STRUCTURE` stays false.
   */
  enablePythonStructure?: boolean;
}

/** Last graph build/cache outcome; surfaces never report `files=0` as `ok`. */
export interface GraphBuildOutcome {
  status: ScanStatus;
  partial: boolean;
  cache: 'hit' | 'miss';
  /** True when a timeout/degraded build retained the previous snapshot. */
  stale: boolean;
  files: number;
  symbols: number;
  completed?: { files: number; bytes: number; elapsedMs: number };
  budget?: ScanBudget;
  reason?: string;
  rootResolution?: { inputRoot: string; gitRoot: string; pmRoot: string; sourceRoots: string[] };
}

interface FileMetaRow {
  path: string;
  size: number;
  mtime_ms: number;
  ino: string;
  ctime_ms: number;
  hash: string;
}

interface FileRow {
  path: string;
  hash: string;
  dynamic_loads: number;
}

interface SymbolRow {
  id: string;
  file: string;
  name: string;
  qualified_name: string;
  symbol_kind: string;
  start_line: number;
}

interface EdgeRow {
  from_path: string;
  to_path: string;
  kind: string;
  provenance: string;
  imported_names: string;
  label: string | null;
}

interface CallRow {
  from_path: string;
  to_path: string;
  caller_symbol_id: string;
  caller_qualified_name: string;
  callee_symbol_id: string;
  callee: string;
  callee_qualified_name: string;
  provenance: string;
  label: string;
  line: number;
}

interface ParsedRow {
  path: string;
  hash: string;
  version: string;
  source_json: string;
}

interface MetaRow {
  key: string;
  value: string;
}

/** Schema 2 adds L2 call edges and the content-hash parse cache. */
const SCHEMA_VERSION = '2';

const CALL_LABELS: ReadonlySet<string> = new Set<CallLabel>([
  'local', 'imported', 'member', 'this', 'namespace', 'new', 'instance', 'barrel_wildcard',
]);

function emptySnapshot(): GraphSnapshot {
  return { revision: '', sourceFingerprint: '', files: {}, symbols: [], edges: [], calls: [], caveats: emptyCaveats() };
}

/** Type guard: a resolved scan carries executable predicates and glob arrays. */
function isResolvedProjectScan(value: ResolvedProjectScan | ProjectScanOptions): value is ResolvedProjectScan {
  const candidate = value as Partial<ResolvedProjectScan>;
  return typeof candidate.excludes === 'function'
    && Array.isArray(candidate.sourceRoots)
    && Array.isArray(candidate.excludeGlobs);
}

const DYNAMIC_LOAD_PATTERNS: ReadonlySet<string> = new Set<DynamicLoadPattern>([
  'dynamic-import', 'require', 'computed-require', 'registry-scan', 'reflection', 'eval',
]);

const DYNAMIC_LOAD_TIERS: ReadonlySet<string> = new Set<DynamicLoadTier>(['resolved', 'heuristic', 'unknown']);

/** Whitelist replay of the T-116 caveat evidence; unknown shapes are dropped. */
function replayStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === 'string');
  if (strings.length === 0) return [];
  // Preserve persisted order: the builder emits path-sorted, deterministic
  // arrays, so replay must not reorder them or a reopened snapshot would no
  // longer deep-equal the in-memory one.
  return [...new Set(strings)];
}

function replaySemanticGaps(value: unknown): CaveatSemanticGap[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const gaps: CaveatSemanticGap[] = [];
  for (const candidate of value) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const row = candidate as Partial<CaveatSemanticGap>;
    if (typeof row.file !== 'string' || typeof row.line !== 'number' || typeof row.pattern !== 'string' || typeof row.reason !== 'string') continue;
    gaps.push({ file: row.file, line: row.line, pattern: row.pattern, reason: row.reason });
  }
  return gaps;
}

function replayDynamicLoadSites(value: unknown): CaveatDynamicLoadSite[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const sites: CaveatDynamicLoadSite[] = [];
  for (const candidate of value) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const row = candidate as Partial<CaveatDynamicLoadSite>;
    if (typeof row.file !== 'string' || typeof row.line !== 'number' || typeof row.pattern !== 'string'
      || !DYNAMIC_LOAD_PATTERNS.has(row.pattern) || typeof row.tier !== 'string' || !DYNAMIC_LOAD_TIERS.has(row.tier)
      || typeof row.reason !== 'string') continue;
    sites.push({
      file: row.file,
      line: row.line,
      pattern: row.pattern as DynamicLoadPattern,
      tier: row.tier as DynamicLoadTier,
      reason: row.reason,
      ...(typeof row.target === 'string' ? { target: row.target } : {}),
    });
  }
  return sites;
}

function replayDynamicLoadKinds(value: unknown): Record<DynamicLoadTier, number> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const result: Record<DynamicLoadTier, number> = { resolved: 0, heuristic: 0, unknown: 0 };
  let present = false;
  for (const tier of ['resolved', 'heuristic', 'unknown'] as const) {
    const count = row[tier];
    if (typeof count !== 'number' || !Number.isFinite(count)) continue;
    result[tier] = count;
    present = true;
  }
  return present ? result : undefined;
}

function normalizeCaveats(value: unknown): GraphCaveats {
  const base = emptyCaveats();
  if (typeof value !== 'object' || value === null) return base;
  const candidate = value as Partial<GraphCaveats>;
  if (candidate.edgeCounts && typeof candidate.edgeCounts === 'object') {
    for (const kind of ['value-confirmed', 'type-only', 'unknown'] as const) {
      const count = candidate.edgeCounts[kind];
      if (typeof count === 'number') base.edgeCounts[kind] = count;
    }
  }
  if (typeof candidate.heuristicEdges === 'number') base.heuristicEdges = candidate.heuristicEdges;
  if (typeof candidate.unknownRatio === 'number') base.unknownRatio = candidate.unknownRatio;
  if (typeof candidate.filesWithUnresolvableDynamicLoads === 'number') base.filesWithUnresolvableDynamicLoads = candidate.filesWithUnresolvableDynamicLoads;
  if (typeof candidate.dynamicLoadCount === 'number') base.dynamicLoadCount = candidate.dynamicLoadCount;
  if (Array.isArray(candidate.degradedReasons)) {
    base.degradedReasons = candidate.degradedReasons.filter((reason): reason is string => typeof reason === 'string').sort();
  }
  for (const key of ['callEdges', 'resolvedCallEdges', 'heuristicCallEdges', 'typeOnlyCallSites', 'unresolvedCallSites', 'commonjsExports'] as const) {
    const count = candidate[key];
    if (typeof count === 'number') base[key] = count;
  }
  // T-116 located evidence. Replay through the whitelist so an old cache keeps
  // working and a corrupt/foreign field can never inject untyped data.
  const semanticGaps = replaySemanticGaps(candidate.semanticGaps);
  if (semanticGaps !== undefined) base.semanticGaps = semanticGaps;
  const dynamicLoadKinds = replayDynamicLoadKinds(candidate.dynamicLoadKinds);
  if (dynamicLoadKinds !== undefined) base.dynamicLoadKinds = dynamicLoadKinds;
  const dynamicLoadSites = replayDynamicLoadSites(candidate.dynamicLoadSites);
  if (dynamicLoadSites !== undefined) base.dynamicLoadSites = dynamicLoadSites;
  const registryFiles = replayStringList(candidate.registryFiles);
  if (registryFiles !== undefined) base.registryFiles = registryFiles;
  const reflectionFiles = replayStringList(candidate.reflectionFiles);
  if (reflectionFiles !== undefined) base.reflectionFiles = reflectionFiles;
  const zeroSymbolFiles = replayStringList(candidate.zeroSymbolFiles);
  if (zeroSymbolFiles !== undefined) base.zeroSymbolFiles = zeroSymbolFiles;
  return base;
}

function callSortKey(edge: CallEdge): string {
  return [
    edge.from,
    edge.to,
    edge.callerSymbolId ?? '',
    edge.calleeSymbolId ?? '',
    edge.callee,
    edge.calleeQualifiedName ?? '',
    edge.provenance,
    edge.label,
    String(edge.line),
  ].join('\0');
}

/**
 * P3 graph store: a real SQLite cache under `.ano/cache/graph.db`. Builds are
 * content-hash incremental (unchanged files reuse the persisted parse result)
 * and writes use `BEGIN IMMEDIATE` so there is exactly one writer; concurrent
 * writers wait up to `busy_timeout` and then fail without deleting old data.
 */
export class GraphStore {
  private readonly root: string;
  private readonly database: DatabaseSync;
  private readonly wasmDirectory?: string;
  private readonly readFile?: (absolutePath: string) => Promise<string>;
  private graph: GraphSnapshot = emptySnapshot();
  private currentFreshness: Freshness = { status: 'fresh', stale: 0 };
  private report: BuildReport | undefined;
  private closed = false;
  /** Resolved ADR-009 scan config, when the caller supplied one. */
  private scan: ResolvedProjectScan | undefined;
  /** Directories that make up the graph (resolved source roots). */
  private sourceRoots: string[] = [];
  /** Path base for graph-relative file paths and module resolution. */
  private baseRoot: string;
  private forceRebuild = false;
  private manifest: Map<string, SourceMetadata> | undefined;
  /** Build start instant bound to `manifest`; required for the metadata fast path. */
  private manifestBuiltAt: number | undefined;
  /** True when no usable manifest exists (missing/legacy/config drift); rebuild. */
  private cacheInvalid = false;
  private storedScanKey: string | undefined;
  /** Test-seam mode plus extractor/resolution inputs; invalidates stale graph caches. */
  private structureKey = '';
  private storedStructureKey: string | undefined;
  private enablePythonStructure = false;
  private lastOutcome: GraphBuildOutcome | undefined;

  private constructor(root: string, database: DatabaseSync, wasmDirectory: string | undefined, readFile: ((absolutePath: string) => Promise<string>) | undefined) {
    this.root = root;
    this.baseRoot = root;
    this.database = database;
    if (wasmDirectory !== undefined) this.wasmDirectory = wasmDirectory;
    if (readFile !== undefined) this.readFile = readFile;
  }

  static async open(root: string, options: GraphStoreOpenOptions = {}): Promise<GraphStore> {
    const absoluteRoot = resolve(root);
    const cacheDirectory = join(absoluteRoot, '.ano', 'cache');
    await mkdir(cacheDirectory, { recursive: true });
    const database = new DatabaseSync(join(cacheDirectory, 'graph.db'));
    const store = new GraphStore(absoluteRoot, database, options.wasmDirectory, options.readFile);
    store.forceRebuild = options.rebuild === true;
    store.enablePythonStructure = options.enablePythonStructure ?? ENABLE_PYTHON_STRUCTURE;
    store.scan = await store.resolveScan(options.scan);
    if (store.scan !== undefined) {
      store.sourceRoots = [...store.scan.sourceRoots];
      store.baseRoot = store.scan.gitRoot;
    } else {
      store.sourceRoots = [absoluteRoot];
      store.baseRoot = absoluteRoot;
    }
    store.structureKey = await store.computeStructureKey();
    const migrated = store.initializeSchema();
    store.graph = store.replay();
    store.loadManifest();
    if (migrated) {
      // The v1 cache had no call edges. Keep its files/edges (no destructive
      // migration) but report stale until a rebuild fills the L2 table.
      store.currentFreshness = { status: 'stale', stale: Object.keys(store.graph.files).length };
    } else if (store.scan !== undefined) {
      // ADR-009 §8.3: a valid persisted manifest answers from metadata only
      // when links are not followed. Followed links need a bounded content walk
      // because the metadata collector intentionally skips links. An unusable
      // manifest must be rebuilt; a merely stale one is not laundered.
      // Structure-mode/extractor/resolution drift also invalidates the cache.
      store.cacheInvalid = store.storedStructureKey !== store.structureKey || !store.manifestUsable();
      if (!store.cacheInvalid && store.scan.followLinks) {
        await store.checkFreshness();
      } else {
        const cacheHit = !store.cacheInvalid && await store.metadataMatchesStored();
        store.currentFreshness = cacheHit
          ? { status: 'fresh', stale: 0 }
          : { status: 'stale', stale: Object.keys(store.graph.files).length };
      }
    } else {
      const structuralCacheValid = store.storedStructureKey === store.structureKey;
      const check = await checkGraphFreshness(absoluteRoot, store.graph, {
        enablePythonStructure: store.enablePythonStructure,
      });
      if (!structuralCacheValid) {
        store.cacheInvalid = true;
        store.currentFreshness = { status: 'stale', stale: Object.keys(store.graph.files).length };
      } else {
        store.currentFreshness = check.freshness;
      }
    }
    return store;
  }

  private async resolveScan(scan?: ResolvedProjectScan | ProjectScanOptions): Promise<ResolvedProjectScan | undefined> {
    if (scan === undefined) return undefined;
    if (isResolvedProjectScan(scan)) return scan;
    return resolveProjectScan({ startRoot: this.root, ...scan });
  }

  private computeScanKey(): string | undefined {
    if (this.scan === undefined) return undefined;
    return JSON.stringify({
      baseRoot: this.baseRoot,
      sourceRoots: this.sourceRoots,
      excludeGlobs: this.scan.excludeGlobs,
      includeGlobs: this.scan.includeGlobs,
      followLinks: this.scan.followLinks,
      maxFileBytes: this.scan.maxFileBytes,
      maxFiles: this.scan.maxFiles,
      maxTotalBytes: this.scan.maxTotalBytes,
      structureKey: this.structureKey,
    });
  }

  /**
   * Cache identity for the structure mode. The extractor version is always
   * included; while Python is opted in, so are the effective Python source
   * roots from `python.roots` / pyproject setuptools. A resolution-only change
   * then forces a rebuild even when no source hash moved, while a TS-only
   * build stays byte-for-byte unaffected by Python config edits.
   */
  private async computeStructureKey(): Promise<string> {
    if (!this.enablePythonStructure) {
      return JSON.stringify({ enabled: false, extractorVersion: EXTRACTOR_VERSION });
    }
    try {
      const context = await createPythonResolutionContext(this.baseRoot, []);
      return JSON.stringify({
        enabled: true,
        extractorVersion: EXTRACTOR_VERSION,
        pythonRoots: [...context.roots],
        pythonRootCaveats: [...context.caveats],
      });
    } catch (error) {
      return JSON.stringify({
        enabled: true,
        extractorVersion: EXTRACTOR_VERSION,
        pythonRootsError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * A manifest is usable only when it is present, was written by the current
   * scan configuration and carries a build instant. Anything else fails closed
   * to a rebuild rather than risking a false-fresh verdict.
   */
  private manifestUsable(): boolean {
    const scan = this.scan;
    const manifest = this.manifest;
    const builtAt = this.manifestBuiltAt;
    if (scan === undefined || manifest === undefined || manifest.size === 0) return false;
    if (builtAt === undefined || builtAt <= 0) return false;
    const key = this.computeScanKey();
    return key !== undefined && key === this.storedScanKey;
  }

  private async metadataMatchesStored(): Promise<boolean> {
    const scan = this.scan;
    const manifest = this.manifest;
    const builtAt = this.manifestBuiltAt;
    if (scan === undefined || manifest === undefined || manifest.size === 0) return false;
    if (builtAt === undefined || builtAt <= 0) return false;
    const key = this.computeScanKey();
    if (key === undefined || key !== this.storedScanKey) return false;
    const current = await collectSourceMetadata(this.baseRoot, this.sourceRoots, scan.excludes);
    if (!metadataMatches(current, manifest)) return false;
    return recheckManifestContent(this.baseRoot, current, manifest, builtAt, this.readFile);
  }

  private createBudget(): ScanBudget {
    if (this.scan === undefined) return createScanBudget();
    return createScanBudget({
      timeoutMs: this.scan.timeoutMs,
      maxFiles: this.scan.maxFiles,
      ...(this.scan.maxTotalBytes !== undefined ? { maxTotalBytes: this.scan.maxTotalBytes } : {}),
      deadline: this.scan.budgets.deadline,
    });
  }

  private rootResolution(): { inputRoot: string; gitRoot: string; pmRoot: string; sourceRoots: string[] } | undefined {
    if (this.scan === undefined) return undefined;
    return { ...this.scan.rootResolution };
  }

  private createTables(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        dynamic_loads INTEGER NOT NULL,
        unresolved_dynamic_loads INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS symbols (
        id TEXT PRIMARY KEY,
        file TEXT NOT NULL,
        name TEXT NOT NULL,
        qualified_name TEXT NOT NULL,
        symbol_kind TEXT NOT NULL,
        start_line INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS edges (
        from_path TEXT NOT NULL,
        to_path TEXT NOT NULL,
        kind TEXT NOT NULL,
        provenance TEXT NOT NULL,
        imported_names TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (from_path, to_path, kind, provenance, label, imported_names)
      );
      CREATE TABLE IF NOT EXISTS calls (
        from_path TEXT NOT NULL,
        to_path TEXT NOT NULL,
        caller_symbol_id TEXT NOT NULL DEFAULT '',
        caller_qualified_name TEXT NOT NULL DEFAULT '',
        callee_symbol_id TEXT NOT NULL DEFAULT '',
        callee TEXT NOT NULL,
        callee_qualified_name TEXT NOT NULL DEFAULT '',
        provenance TEXT NOT NULL,
        label TEXT NOT NULL,
        line INTEGER NOT NULL,
        PRIMARY KEY (from_path, to_path, caller_symbol_id, callee_symbol_id, callee, callee_qualified_name, provenance, label, line)
      );
      CREATE TABLE IF NOT EXISTS parsed_files (
        path TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        version TEXT NOT NULL DEFAULT '',
        source_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS caveats (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS file_meta (
        path TEXT PRIMARY KEY,
        size INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        ino TEXT NOT NULL DEFAULT '',
        ctime_ms REAL NOT NULL DEFAULT 0,
        hash TEXT NOT NULL DEFAULT ''
      );
    `);
    this.migrateFileMetaColumns();
  }

  /**
   * Add the content-verification columns to a pre-upgrade `file_meta`. Old rows
   * keep `ino=''`/`ctime_ms=0`/`hash=''`, which fails the manifest guard and
   * forces one rebuild rather than trusting an unverifiable cache.
   */
  private migrateFileMetaColumns(): void {
    const columns = this.database.prepare('PRAGMA table_info(file_meta)').all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has('ino')) this.database.exec("ALTER TABLE file_meta ADD COLUMN ino TEXT NOT NULL DEFAULT ''");
    if (!names.has('ctime_ms')) this.database.exec('ALTER TABLE file_meta ADD COLUMN ctime_ms REAL NOT NULL DEFAULT 0');
    if (!names.has('hash')) this.database.exec("ALTER TABLE file_meta ADD COLUMN hash TEXT NOT NULL DEFAULT ''");
  }

  /** Returns true when a v1 cache was migrated in place (no rows deleted). */
  private initializeSchema(): boolean {
    this.database.exec('PRAGMA journal_mode = WAL');
    this.database.exec('PRAGMA busy_timeout = 5000');
    this.createTables();
    const version = this.database.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as MetaRow | undefined;
    if (version === undefined) {
      this.database.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', SCHEMA_VERSION);
      return false;
    }
    if (version.value === SCHEMA_VERSION) return false;
    if (version.value === '1') {
      // Non-destructive: the new tables already exist. Old files/edges/symbols
      // remain replayable; the missing calls are covered by a stale marker.
      this.database.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', SCHEMA_VERSION);
      return true;
    }
    // Unknown schema: rebuild tables explicitly. This is a schema decision, not
    // an I/O failure path; unreadable sources still retain from the fresh replay.
    this.database.exec('DROP TABLE IF EXISTS calls; DROP TABLE IF EXISTS parsed_files; DROP TABLE IF EXISTS edges; DROP TABLE IF EXISTS symbols; DROP TABLE IF EXISTS files; DROP TABLE IF EXISTS caveats; DROP TABLE IF EXISTS meta;');
    this.createTables();
    this.database.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', SCHEMA_VERSION);
    return false;
  }

  private replay(): GraphSnapshot {
    const metaRows = this.database.prepare('SELECT key, value FROM meta').all() as unknown as MetaRow[];
    const meta = new Map(metaRows.map((row) => [row.key, row.value]));
    const fileRows = this.database.prepare('SELECT path, hash, dynamic_loads FROM files').all() as unknown as FileRow[];
    const symbolRows = this.database.prepare('SELECT id, file, name, qualified_name, symbol_kind, start_line FROM symbols').all() as unknown as SymbolRow[];
    const edgeRows = this.database.prepare('SELECT from_path, to_path, kind, provenance, imported_names, label FROM edges').all() as unknown as EdgeRow[];
    const callRows = this.database.prepare('SELECT from_path, to_path, caller_symbol_id, caller_qualified_name, callee_symbol_id, callee, callee_qualified_name, provenance, label, line FROM calls').all() as unknown as CallRow[];

    const files: Record<string, SourceFile> = {};
    for (const row of fileRows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
      files[row.path] = { path: row.path, hash: row.hash, dynamicLoads: row.dynamic_loads };
    }
    const symbols: SymbolNode[] = symbolRows.map((row) => ({
      id: row.id,
      file: row.file,
      name: row.name,
      qualifiedName: row.qualified_name,
      symbolKind: row.symbol_kind === 'type' ? 'type' as const : 'value' as const,
      startLine: row.start_line,
    })).sort((a, b) => a.file.localeCompare(b.file)
      || a.symbolKind.localeCompare(b.symbolKind)
      || a.name.localeCompare(b.name)
      || a.id.localeCompare(b.id));
    const edges: GraphEdge[] = edgeRows.map((row) => ({
      from: row.from_path,
      to: row.to_path,
      kind: (row.kind === 'value-confirmed' || row.kind === 'type-only' ? row.kind : 'unknown') as EdgeKind,
      provenance: (row.provenance === 'parsed' || row.provenance === 'resolved' ? row.provenance : 'heuristic') as EdgeProvenance,
      importedNames: JSON.parse(row.imported_names) as string[],
      ...(row.label ? { label: row.label as NonNullable<GraphEdge['label']> } : {}),
    })).sort((a, b) => Buffer.from(`${a.from}\0${a.to}\0${a.kind}\0${a.provenance}\0${a.label ?? ''}`)
      .compare(Buffer.from(`${b.from}\0${b.to}\0${b.kind}\0${b.provenance}\0${b.label ?? ''}`)));
    const calls: CallEdge[] = callRows.map((row) => ({
      from: row.from_path,
      to: row.to_path,
      callee: row.callee,
      line: row.line,
      provenance: (row.provenance === 'resolved' ? 'resolved' : 'heuristic') as CallProvenance,
      label: CALL_LABELS.has(row.label) ? row.label as CallLabel : 'member',
      ...(row.caller_symbol_id ? { callerSymbolId: row.caller_symbol_id } : {}),
      ...(row.caller_qualified_name ? { callerQualifiedName: row.caller_qualified_name } : {}),
      ...(row.callee_symbol_id ? { calleeSymbolId: row.callee_symbol_id } : {}),
      ...(row.callee_qualified_name ? { calleeQualifiedName: row.callee_qualified_name } : {}),
    })).sort((a, b) => Buffer.from(callSortKey(a)).compare(Buffer.from(callSortKey(b))));
    const persistedCaveats = meta.get('caveats');
    const caveats = persistedCaveats ? normalizeCaveats(JSON.parse(persistedCaveats)) : emptyCaveats();
    return {
      revision: meta.get('revision') ?? '',
      sourceFingerprint: meta.get('source_fingerprint') ?? '',
      files,
      symbols,
      edges,
      calls,
      caveats,
    };
  }

  private loadParsedCache(): ParsedCache {
    const rows = this.database.prepare('SELECT path, hash, version, source_json FROM parsed_files').all() as unknown as ParsedRow[];
    const cache: ParsedCache = {};
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.source_json) as ParsedFile;
        if (parsed.file !== row.path) continue;
        cache[row.path] = { hash: row.hash, version: row.version, parsed };
      } catch {
        // A corrupt cache row is a cache miss, never a reason to drop graph data.
      }
    }
    return cache;
  }

  private persist(snapshot: GraphSnapshot, parsedFiles: ParsedCache): void {
    const insertMeta = this.database.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
    const insertFile = this.database.prepare('INSERT INTO files (path, hash, dynamic_loads, unresolved_dynamic_loads) VALUES (?, ?, ?, 0)');
    const insertSymbol = this.database.prepare('INSERT INTO symbols (id, file, name, qualified_name, symbol_kind, start_line) VALUES (?, ?, ?, ?, ?, ?)');
    const insertEdge = this.database.prepare('INSERT OR REPLACE INTO edges (from_path, to_path, kind, provenance, imported_names, label) VALUES (?, ?, ?, ?, ?, ?)');
    const insertCall = this.database.prepare('INSERT OR REPLACE INTO calls (from_path, to_path, caller_symbol_id, caller_qualified_name, callee_symbol_id, callee, callee_qualified_name, provenance, label, line) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const insertParsed = this.database.prepare('INSERT OR REPLACE INTO parsed_files (path, hash, version, source_json) VALUES (?, ?, ?, ?)');
    // Single writer: SQLite grants the write lock here. A concurrent leader that
    // dies is released by the OS, and a busy writer waits or fails as a whole.
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.exec('DELETE FROM files; DELETE FROM symbols; DELETE FROM edges; DELETE FROM calls; DELETE FROM parsed_files; DELETE FROM caveats;');
      insertMeta.run('revision', snapshot.revision);
      insertMeta.run('source_fingerprint', snapshot.sourceFingerprint);
      for (const file of Object.values(snapshot.files)) insertFile.run(file.path, file.hash, file.dynamicLoads);
      for (const symbol of snapshot.symbols) {
        insertSymbol.run(symbol.id, symbol.file, symbol.name, symbol.qualifiedName, symbol.symbolKind, symbol.startLine);
      }
      for (const edge of snapshot.edges) {
        insertEdge.run(edge.from, edge.to, edge.kind, edge.provenance, JSON.stringify(edge.importedNames), edge.label ?? '');
      }
      for (const call of snapshot.calls ?? []) {
        insertCall.run(
          call.from,
          call.to,
          call.callerSymbolId ?? '',
          call.callerQualifiedName ?? '',
          call.calleeSymbolId ?? '',
          call.callee,
          call.calleeQualifiedName ?? '',
          call.provenance,
          call.label,
          call.line,
        );
      }
      for (const [path, entry] of Object.entries(parsedFiles)) {
        insertParsed.run(path, entry.hash, entry.version ?? '', JSON.stringify(entry.parsed));
      }
      insertMeta.run('caveats', JSON.stringify(snapshot.caveats));
      this.database.exec('COMMIT');
    } catch (error) {
      try {
        this.database.exec('ROLLBACK');
      } catch {
        // The original error is more useful; a rollback failure means SQLite
        // already discarded the transaction.
      }
      throw error;
    }
  }

  private loadManifest(): void {
    const key = this.database.prepare('SELECT value FROM meta WHERE key = ?').get('scan_key') as MetaRow | undefined;
    if (key !== undefined) this.storedScanKey = key.value;
    const structureKey = this.database.prepare('SELECT value FROM meta WHERE key = ?').get('structure_key') as MetaRow | undefined;
    if (structureKey !== undefined) this.storedStructureKey = structureKey.value;
    const builtAt = this.database.prepare('SELECT value FROM meta WHERE key = ?').get('manifest_built_at') as MetaRow | undefined;
    if (builtAt !== undefined && Number.isFinite(Number(builtAt.value))) this.manifestBuiltAt = Number(builtAt.value);
    const rows = this.database.prepare('SELECT path, size, mtime_ms, ino, ctime_ms, hash FROM file_meta').all() as unknown as FileMetaRow[];
    if (rows.length > 0) {
      this.manifest = new Map(rows.map((row) => [row.path, {
        size: row.size,
        mtimeMs: row.mtime_ms,
        ino: row.ino,
        ctimeMs: row.ctime_ms,
        hash: row.hash,
      }]));
    }
  }

  /** Persist the metadata manifest and scan key after a successful build. */
  private async persistManifest(fingerprint: SourceFingerprint, builtAt: number): Promise<void> {
    const hashes = new Map(fingerprint.files.map((file) => [file.path, file.hash]));
    const manifest = new Map<string, SourceMetadata>();
    for (const file of fingerprint.files) {
      try {
        const stats = await lstat(join(this.baseRoot, file.path));
        manifest.set(file.path, {
          size: stats.size,
          mtimeMs: stats.mtimeMs,
          ino: String(stats.ino),
          ctimeMs: stats.ctimeMs,
          hash: hashes.get(file.path) ?? '',
        });
      } catch {
        // A file that vanished before stat is simply absent from the manifest.
      }
    }
    this.manifest = manifest;
    this.manifestBuiltAt = builtAt;
    this.storedScanKey = this.computeScanKey();
    this.storedStructureKey = this.structureKey;
    const insertMeta = this.database.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
    const insertMetaRow = this.database.prepare('INSERT OR REPLACE INTO file_meta (path, size, mtime_ms, ino, ctime_ms, hash) VALUES (?, ?, ?, ?, ?, ?)');
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.exec('DELETE FROM file_meta;');
      for (const [path, meta] of manifest) insertMetaRow.run(path, meta.size, meta.mtimeMs, meta.ino, meta.ctimeMs, meta.hash);
      if (this.storedScanKey !== undefined) insertMeta.run('scan_key', this.storedScanKey);
      insertMeta.run('structure_key', this.storedStructureKey);
      insertMeta.run('manifest_built_at', String(builtAt));
      this.database.exec('COMMIT');
    } catch (error) {
      try {
        this.database.exec('ROLLBACK');
      } catch {
        // The original error is more useful.
      }
      throw error;
    }
  }

  /**
   * Rebuild the graph from the current fingerprint. A budget miss keeps the
   * previous snapshot and reports `timeout`; an empty/degraded scan is persisted
   * as `degraded`, never as a healthy `files=0`.
   */
  async build(options: GraphStoreOpenOptions = {}): Promise<GraphStore> {
    this.assertOpen();
    if (options.scan !== undefined) {
      this.scan = await this.resolveScan(options.scan);
      if (this.scan !== undefined) {
        this.sourceRoots = [...this.scan.sourceRoots];
        this.baseRoot = this.scan.gitRoot;
      }
    }
    this.structureKey = await this.computeStructureKey();
    const budget = this.createBudget();
    const fingerprint = this.scan !== undefined
      ? await fingerprintSourceRoots(this.baseRoot, this.sourceRoots, { scan: this.scan, budgets: budget })
      : await fingerprintTree(this.root, {
        onError: () => 'degrade',
        budgets: budget,
        exclude: (path: string) => isPythonBytecode(path) || defaultScanExclude(path),
      });
    const now = Date.now();
    const exhausted = scanBudgetExhausted(budget, now) || fingerprint.status === 'timeout';
    const previousFiles = Object.keys(this.graph.files).length;
    const rootResolution = this.rootResolution();

    if (exhausted) {
      this.currentFreshness = { status: 'stale', stale: previousFiles };
      this.lastOutcome = {
        status: 'timeout',
        partial: true,
        cache: 'miss',
        stale: true,
        files: previousFiles,
        symbols: this.graph.symbols.length,
        ...(fingerprint.completed !== undefined ? { completed: fingerprint.completed } : {}),
        budget,
        reason: fingerprint.reason ?? 'scan-budget-exceeded',
        ...(rootResolution !== undefined ? { rootResolution } : {}),
      };
      return this;
    }

    const output = await buildSnapshot({
      root: this.baseRoot,
      fingerprint,
      previous: this.replay(),
      parsedCache: this.loadParsedCache(),
      ...(this.wasmDirectory !== undefined ? { wasmDirectory: this.wasmDirectory } : {}),
      ...(this.readFile !== undefined ? { readFile: this.readFile } : {}),
      ...(this.enablePythonStructure ? { enablePythonStructure: true } : {}),
    });
    this.persist(output.snapshot, output.parsedFiles);
    await this.persistManifest(fingerprint, budget.startedAt);
    this.graph = output.snapshot;
    this.report = output.report;
    const fileCount = Object.keys(output.snapshot.files).length;
    const degradedReasons = output.snapshot.caveats.degradedReasons;
    const status: ScanStatus = fileCount === 0
      ? 'degraded'
      : degradedReasons.length > 0
        ? 'degraded'
        : 'ok';
    this.currentFreshness = status === 'ok'
      ? { status: 'fresh', stale: 0 }
      : { status: 'degraded', stale: 0, reasons: degradedReasons.length > 0 ? degradedReasons : ['scan-empty:0-files'] };
    this.lastOutcome = {
      status,
      partial: false,
      cache: 'miss',
      stale: false,
      files: fileCount,
      symbols: output.snapshot.symbols.length,
      ...(fingerprint.completed !== undefined ? { completed: fingerprint.completed } : {}),
      budget,
      ...(rootResolution !== undefined ? { rootResolution } : {}),
    };
    return this;
  }

  /**
   * ADR-009 §8.3 cache policy. `auto` (default) reuses a valid snapshot without
   * re-walking content; `always` refuses to rebuild; `never` forces a rebuild.
   */
  async ensureFresh(): Promise<GraphBuildOutcome> {
    this.assertOpen();
    const reuse = this.scan?.reuse ?? 'auto';
    if (this.forceRebuild || reuse === 'never') {
      await this.build();
      return this.requireOutcome();
    }
    const hasFiles = Object.keys(this.graph.files).length > 0;
    if (reuse === 'always') {
      if (this.currentFreshness.status !== 'fresh' || !hasFiles) {
        throw new Error('Graph cache is not fresh; cache.reuse=always refuses to rebuild');
      }
      return this.cacheHitOutcome();
    }
    if (this.currentFreshness.status === 'fresh' && hasFiles) return this.cacheHitOutcome();
    // A valid-but-stale cache is reported, not silently rebuilt: brief/explore
    // must not present an outdated graph as fresh evidence. Only a missing or
    // unusable cache (no files, no manifest, scan-config drift, degraded scan)
    // is rebuilt here; a stale one is refreshed by an explicit `build()`.
    if (this.currentFreshness.status === 'degraded' || this.cacheInvalid || !hasFiles) {
      await this.build();
      return this.requireOutcome();
    }
    return this.staleCacheOutcome();
  }

  private requireOutcome(): GraphBuildOutcome {
    if (this.lastOutcome === undefined) throw new Error('graph build produced no outcome');
    return { ...this.lastOutcome };
  }

  /** Outcome for a cache that is valid but no longer matches the source tree. */
  private staleCacheOutcome(): GraphBuildOutcome {
    const rootResolution = this.rootResolution();
    return {
      status: 'ok',
      partial: false,
      cache: 'miss',
      stale: true,
      files: Object.keys(this.graph.files).length,
      symbols: this.graph.symbols.length,
      ...(rootResolution !== undefined ? { rootResolution } : {}),
    };
  }

  private cacheHitOutcome(): GraphBuildOutcome {
    const rootResolution = this.rootResolution();
    return {
      status: 'ok',
      partial: false,
      cache: 'hit',
      stale: false,
      files: Object.keys(this.graph.files).length,
      symbols: this.graph.symbols.length,
      ...(rootResolution !== undefined ? { rootResolution } : {}),
    };
  }

  snapshot(): GraphSnapshot {
    this.assertOpen();
    return structuredClone(this.graph);
  }

  freshness(): Freshness {
    this.assertOpen();
    return structuredClone(this.currentFreshness);
  }

  /**
   * Re-reads the tree and compares content hashes with the persisted manifest.
   * With scan options a valid manifest answers from metadata only unless links
   * are followed; a budget miss is returned as an explicit degraded reason
   * rather than `files=0` as normal.
   */
  async checkFreshness(): Promise<Freshness> {
    this.assertOpen();
    const structureKey = await this.computeStructureKey();
    if (structureKey !== this.structureKey || this.storedStructureKey !== structureKey) {
      this.structureKey = structureKey;
      this.cacheInvalid = true;
      this.currentFreshness = { status: 'stale', stale: Object.keys(this.graph.files).length };
      return structuredClone(this.currentFreshness);
    }
    if (this.scan !== undefined) {
      const scanKey = this.computeScanKey();
      const check = await checkGraphFreshness(this.baseRoot, this.graph, {
        scan: this.scan,
        sourceRoots: this.sourceRoots,
        baseRoot: this.baseRoot,
        budgets: this.createBudget(),
        ...(this.manifest !== undefined ? { manifest: this.manifest } : {}),
        ...(this.manifestBuiltAt !== undefined ? { manifestBuiltAt: this.manifestBuiltAt } : {}),
        ...(this.readFile !== undefined ? { readFile: this.readFile } : {}),
        ...(scanKey !== undefined ? { scanKey, ...(this.storedScanKey !== undefined ? { storedScanKey: this.storedScanKey } : {}) } : {}),
        ...(this.enablePythonStructure ? { enablePythonStructure: true } : {}),
      });
      this.currentFreshness = check.freshness;
      return structuredClone(this.currentFreshness);
    }
    this.currentFreshness = (await checkGraphFreshness(this.root, this.graph, {
      ...(this.enablePythonStructure ? { enablePythonStructure: true } : {}),
    })).freshness;
    return structuredClone(this.currentFreshness);
  }

  filesList(): string[] {
    this.assertOpen();
    return Object.keys(this.graph.files).sort();
  }

  get revision(): string {
    return this.graph.revision;
  }

  /**
   * Extensions this store treats as source. Main's Gate freshness uses the
   * same frozen list for before/after comparisons and idempotent reuse.
   */
  get supportedExtensions(): readonly string[] {
    return supportedStructureExtensions(this.enablePythonStructure);
  }

  get sourceFingerprint(): string {
    return this.graph.sourceFingerprint;
  }

  get lastBuild(): BuildReport | undefined {
    return this.report ? { ...this.report } : undefined;
  }

  /** Outcome of the last `build()`/`ensureFresh()`; undefined before any build. */
  get buildOutcome(): GraphBuildOutcome | undefined {
    return this.lastOutcome === undefined ? undefined : { ...this.lastOutcome };
  }

  close(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('GraphStore is closed');
  }
}
