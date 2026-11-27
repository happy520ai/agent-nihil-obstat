import { readdir, lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

// ---------------------------------------------------------------------------
// Status and error contracts (ADR-009 §11)
// ---------------------------------------------------------------------------

export type ScanStatus = 'ok' | 'degraded' | 'timeout' | 'skipped-link' | 'permission-denied' | 'busy-file';
export type ScanEntryStatus = ScanStatus | 'source-changed' | 'streamed';

export type ScanErrorCode =
  | 'NO_NODE_PACKAGE'
  | 'AMBIGUOUS_SOURCE_ROOTS'
  | 'SOURCE_ROOT_OUTSIDE_GIT_ROOT'
  | 'PM_ROOT_WITHOUT_PM'
  | 'ROOT_ROLE_CONFLICT'
  | 'LINK_ESCAPE'
  | 'SCAN_BUDGET_EXCEEDED'
  | 'CONFIG_INVALID'
  | 'NOT_A_GIT_WORK_TREE';

export class ProjectScanError extends Error {
  readonly code: ScanErrorCode;
  constructor(code: ScanErrorCode, message: string) {
    super(message);
    this.name = 'ProjectScanError';
    this.code = code;
  }
}

export type ScanAmbiguityMode = 'nearest-layer' | 'error';
export type ScanCacheReuse = 'auto' | 'always' | 'never';

// ---------------------------------------------------------------------------
// Options and defaults
// ---------------------------------------------------------------------------

export interface ProjectScanCacheOptions {
  reuse?: ScanCacheReuse;
  rebuild?: boolean;
}

export interface ProjectScanOptions {
  /** Entry point used to discover the Git root and (unless gitRoot is set) as the scan start. */
  startRoot?: string;
  gitRoot?: string;
  pmRoot?: string;
  sourceRoots?: string[];
  exclude?: string[];
  include?: string[];
  /** Default false: links are reported as skipped-link, never followed. */
  followLinks?: boolean;
  /** Default 64 MiB; 0 means unlimited. */
  maxFileBytes?: number;
  /** Default 50_000; shared scan/build budget, below the 60s MCP timeout. */
  timeoutMs?: number;
  /** Default 200_000. */
  maxFiles?: number;
  maxTotalBytes?: number;
  /** Default 3; 0 only inspects the Git root itself. */
  maxDiscoverDepth?: number;
  /** Absolute epoch-ms deadline; overrides timeoutMs when present. */
  deadline?: number;
  /** Cache reuse policy; `cache.reuse` is the ADR-009 §9 spelling. */
  reuse?: ScanCacheReuse;
  onAmbiguity?: ScanAmbiguityMode;
  /** Default true; false allows a Git-root-free tree (gitRoot = startRoot). */
  requireGit?: boolean;
  /**
   * Read-only native scans may omit `.pm`: when true and no explicit `pmRoot`
   * is supplied, a root without `.pm` is scanned with the `.ano` policy only
   * (pmRoot = gitRoot). Default false keeps the strict PM contract used by the
   * resolver, migration and takeover. Never accepted from project config.
   */
  allowMissingPmRoot?: boolean;
  cache?: ProjectScanCacheOptions;
}

export const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 50_000;
export const DEFAULT_MAX_FILES = 200_000;
export const DEFAULT_MAX_DISCOVER_DEPTH = 3;

const DEFAULT_EXCLUDED_DIRECTORIES = [
  '.git', '.hg', '.svn',
  'node_modules', 'bower_components', 'jspm_packages',
  'dist', 'dist*', 'build', 'out', 'output', '.next', '.nuxt', '.output', '.turbo', '.svelte-kit', '.angular',
  'coverage', '.nyc_output', '.tsbuildinfo',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '.venv', 'venv', 'env', 'site-packages',
  'target', '.gradle', '.mvn', '.cache',
  '.idea', '.vscode', '.vs',
  '.pm', '.ano', '.zcode', '.runtime', '.zwork', '.workbuddy', '.lintenv*',
  'chrome-cdp-profile', 'chromium-profile', 'browser-profile', 'browser-profiles', '.chrome',
  'logs', 'log', 'exports', 'export',
  'backups', 'archive',
];

const DEFAULT_EXCLUDED_FILES = [
  '*.log', '_reg_*.log', '*.tmp', '*.bak',
  '*.safetensors', '*.gguf', '*.ckpt', '*.pt', '*.pth', '*.onnx', '*.h5', '*.bin', '*.tflite',
  '.env*', '*.pem', '*.key', '*.p12', '*.pfx', '*.kdbx', '*.ppk', 'id_rsa*', 'id_ed25519*', 'credentials.json',
];

/** Default safe exclusion set (ADR-009 §5.2). `data/` is deliberately absent. */
export const DEFAULT_EXCLUDES: readonly string[] = [
  ...DEFAULT_EXCLUDED_DIRECTORIES.map((name) => `**/${name}/**`),
  ...DEFAULT_EXCLUDED_FILES.map((pattern) => `**/${pattern}`),
];

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

export interface ScanBudget {
  readonly startedAt: number;
  readonly deadline: number;
  readonly timeoutMs: number;
  readonly maxFiles: number;
  readonly maxTotalBytes: number | undefined;
  filesSeen: number;
  bytesSeen: number;
}

export interface ScanBudgetOptions {
  timeoutMs?: number;
  maxFiles?: number;
  maxTotalBytes?: number;
  deadline?: number;
  now?: () => number;
}

export function createScanBudget(options: ScanBudgetOptions = {}): ScanBudget {
  const now = (options.now ?? Date.now)();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const deadline = options.deadline ?? now + timeoutMs;
  return {
    startedAt: now,
    deadline,
    timeoutMs,
    maxFiles,
    maxTotalBytes: options.maxTotalBytes,
    filesSeen: 0,
    bytesSeen: 0,
  };
}

export function scanBudgetRemainingMs(budget: ScanBudget, now: number = Date.now()): number {
  return Math.max(0, budget.deadline - now);
}

export function scanBudgetTimedOut(budget: ScanBudget, now: number = Date.now()): boolean {
  return now >= budget.deadline;
}

/** True once the file/byte ceiling is reached, independent of the clock. */
export function scanBudgetExceeded(budget: ScanBudget): boolean {
  if (budget.filesSeen >= budget.maxFiles) return true;
  if (budget.maxTotalBytes !== undefined && budget.bytesSeen >= budget.maxTotalBytes) return true;
  return false;
}

export function scanBudgetExhausted(budget: ScanBudget, now: number = Date.now()): boolean {
  return scanBudgetTimedOut(budget, now) || scanBudgetExceeded(budget);
}

export function scanBudgetStatus(budget: ScanBudget, now: number = Date.now()): 'ok' | 'timeout' {
  return scanBudgetExhausted(budget, now) ? 'timeout' : 'ok';
}

/**
 * Final top-level status for a scan result. A deadline/file-budget miss is
 * always `timeout` (never `ok` with `files=0`), and `files=0` on a healthy
 * budget is `degraded`, so `ok` can never masquerade as an empty scan.
 */
export function scanStatusForResult(budget: ScanBudget, files: number, now: number = Date.now()): ScanStatus {
  if (scanBudgetExhausted(budget, now)) return 'timeout';
  if (files === 0) return 'degraded';
  return 'ok';
}

// ---------------------------------------------------------------------------
// Glob matching, secrets, links
// ---------------------------------------------------------------------------

const globCache = new Map<string, RegExp>();

export function normalizeRelativePath(path: string): string {
  let normalized = path.replaceAll('\\', '/');
  if (normalized.startsWith('./')) normalized = normalized.slice(2);
  return normalized.replace(/\/+$/u, '');
}

export function assertValidGlob(pattern: string): void {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    throw new ProjectScanError('CONFIG_INVALID', `Invalid glob (empty or not a string): ${String(pattern)}`);
  }
  if (pattern.includes('\0')) throw new ProjectScanError('CONFIG_INVALID', `Invalid glob (NUL): ${pattern}`);
  if (pattern.includes('\\')) throw new ProjectScanError('CONFIG_INVALID', `Invalid glob (backslash): ${pattern}`);
  if (pattern.startsWith('/') || /^[A-Za-z]:/.test(pattern)) {
    throw new ProjectScanError('CONFIG_INVALID', `Invalid glob (absolute path): ${pattern}`);
  }
  if (pattern.split('/').includes('..')) {
    throw new ProjectScanError('CONFIG_INVALID', `Invalid glob (path traversal): ${pattern}`);
  }
}

function globToRegExpSource(pattern: string): string {
  let source = '';
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index]!;
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        if (pattern[index + 2] === '/') {
          source += '(?:.*/)?';
          index += 3;
        } else {
          source += '.*';
          index += 2;
        }
      } else {
        source += '[^/]*';
        index += 1;
      }
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      index += 1;
      continue;
    }
    if (char === '/' && pattern.slice(index) === '/**') {
      // `dir/**` also matches `dir` itself, so a declared directory is excluded too.
      source += '(?:/.*)?';
      index += 3;
      continue;
    }
    source += char.replace(/[.+^${}()|[\]\\]/gu, '\\$&');
    index += 1;
  }
  return source;
}

function compileGlob(pattern: string): RegExp {
  assertValidGlob(pattern);
  const cached = globCache.get(pattern);
  if (cached !== undefined) return cached;
  const compiled = new RegExp(`^${globToRegExpSource(pattern)}$`);
  globCache.set(pattern, compiled);
  return compiled;
}

export function matchesGlob(pattern: string, path: string): boolean {
  return compileGlob(pattern).test(normalizeRelativePath(path));
}

export function isExcluded(relativePath: string, globs: readonly string[] = DEFAULT_EXCLUDES): boolean {
  const normalized = normalizeRelativePath(relativePath);
  for (const glob of globs) if (compileGlob(glob).test(normalized)) return true;
  return false;
}

const SECRET_DIRECTORY_SEGMENTS = new Set(['secrets', 'secret', 'credentials', 'credential']);
const SECRET_EXTENSION = /\.(?:pem|key|p12|pfx|kdbx|ppk)$/iu;
const SECRET_KEY_NAME = /^id_(?:rsa|ed25519|dsa|ecdsa)/iu;

/** Secret/key-material paths are never re-admitted by `include`. */
export function isSecretPath(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  if (normalized.length === 0) return false;
  const segments = normalized.split('/').filter((segment) => segment.length > 0);
  const base = segments[segments.length - 1] ?? '';
  if (base.startsWith('.env')) return true;
  if (SECRET_KEY_NAME.test(base)) return true;
  if (SECRET_EXTENSION.test(base)) return true;
  if (base === 'credentials.json') return true;
  for (const segment of segments) if (SECRET_DIRECTORY_SEGMENTS.has(segment)) return true;
  return false;
}

/** Links are opt-in; secret paths are never followed even when `followLinks=true`. */
export function shouldFollowLink(path: string, followLinks: boolean = false): boolean {
  return followLinks && !isSecretPath(path);
}

function matchesAnyGlob(globs: readonly string[], path: string): boolean {
  return isExcluded(path, globs);
}

// ---------------------------------------------------------------------------
// Discovery and resolution
// ---------------------------------------------------------------------------

export interface ScanCandidate {
  relativePath: string;
  absolutePath: string;
  depth: number;
  name?: string;
}

export interface ScanDiscovery {
  startRoot: string;
  gitRoot: string;
  candidates: ScanCandidate[];
  selected: string[];
  depth: number;
  truncated: boolean;
  ambiguous: boolean;
  overridden: boolean;
}

export interface ScanConfigSource {
  projectConfig?: string;
  pmProjectConfig?: string;
  pmScanIgnore?: string[];
  defaults: string[];
  explicit: string[];
  ignoredPmRoots: string[];
}

export interface ResolvedProjectScan {
  startRoot: string;
  gitRoot: string;
  pmRoot: string;
  sourceRoots: string[];
  /** Secrets stay excluded; directory ancestors of explicit includes remain traversable. */
  excludes: (relativePath: string, isDirectory?: boolean) => boolean;
  /** Executable inclusion predicate (never true for secret paths). */
  includes: (relativePath: string) => boolean;
  shouldFollowLink: (relativePath: string) => boolean;
  excludeGlobs: string[];
  includeGlobs: string[];
  followLinks: boolean;
  maxFileBytes: number;
  timeoutMs: number;
  maxFiles: number;
  maxTotalBytes: number | undefined;
  maxDiscoverDepth: number;
  onAmbiguity: ScanAmbiguityMode;
  requireGit: boolean;
  reuse: ScanCacheReuse;
  budgets: ScanBudget;
  discovery: ScanDiscovery;
  configSource: ScanConfigSource;
  rootResolution: { inputRoot: string; gitRoot: string; pmRoot: string; sourceRoots: string[] };
  ignoredPmRoots: string[];
}

export interface ProjectScanStat {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface ProjectScanDeps {
  now?: () => number;
  readdir?: (directory: string) => Promise<string[]>;
  lstat?: (path: string) => Promise<ProjectScanStat>;
  realpath?: (path: string) => Promise<string>;
  readFile?: (path: string) => Promise<string>;
}

const defaultReadFile = (path: string): Promise<string> => readFile(path, 'utf8');

function errorMessage(error: unknown): string {
  return typeof error === 'object' && error !== null && 'message' in error ? String(error.message) : String(error);
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR');
}

function invalid(message: string): never {
  throw new ProjectScanError('CONFIG_INVALID', message);
}

async function safeLstat(path: string, deps: ProjectScanDeps): Promise<ProjectScanStat | undefined> {
  try {
    return await (deps.lstat ?? lstat)(path);
  } catch {
    return undefined;
  }
}

/**
 * `.pm` state for native-scan decisions: true when it is a directory,
 * undefined only when it is genuinely absent. A present-but-unusable entry
 * (file, permission failure) reports false so the caller still fails closed.
 */
async function inspectPmDirectory(pmRoot: string, deps: ProjectScanDeps): Promise<boolean | undefined> {
  try {
    return (await (deps.lstat ?? lstat)(join(pmRoot, '.pm'))).isDirectory();
  } catch (error) {
    if (isEnoent(error)) return undefined;
    return false;
  }
}

async function pathExists(path: string, deps: ProjectScanDeps): Promise<boolean> {
  return (await safeLstat(path, deps)) !== undefined;
}

async function listDirectory(directory: string, deps: ProjectScanDeps): Promise<string[]> {
  try {
    return await (deps.readdir ?? readdir)(directory);
  } catch {
    return [];
  }
}

async function readTextFile(path: string, deps: ProjectScanDeps): Promise<string | undefined> {
  try {
    return await (deps.readFile ?? defaultReadFile)(path);
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw new ProjectScanError('CONFIG_INVALID', `Cannot read ${path}: ${errorMessage(error)}`);
  }
}

async function readJsonFile(path: string, deps: ProjectScanDeps): Promise<Record<string, unknown> | undefined> {
  const text = await readTextFile(path, deps);
  if (text === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return invalid(`Malformed JSON: ${path}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return invalid(`Expected a JSON object: ${path}`);
  }
  return parsed as Record<string, unknown>;
}

function isWithin(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  if (rel === '') return true;
  if (rel === '..' || rel.startsWith(`..${sep}`)) return false;
  return !isAbsolute(rel);
}

async function realpathSafe(path: string, deps: ProjectScanDeps): Promise<string> {
  try {
    return await (deps.realpath ?? realpath)(path);
  } catch (error) {
    return invalid(`Cannot resolve real path for ${path}: ${errorMessage(error)}`);
  }
}

async function resolveEntryRoot(absolute: string, deps: ProjectScanDeps): Promise<string> {
  const stats = await safeLstat(absolute, deps);
  if (stats === undefined) return invalid(`Project root does not exist: ${absolute}`);
  if (stats.isSymbolicLink()) {
    const canonical = await realpathSafe(absolute, deps);
    const canonicalStats = await safeLstat(canonical, deps);
    if (canonicalStats === undefined || !canonicalStats.isDirectory()) {
      return invalid(`Project root is not a directory: ${canonical}`);
    }
    return canonical;
  }
  if (!stats.isDirectory()) return invalid(`Project root is not a directory: ${absolute}`);
  return absolute;
}

async function findGitRoot(startRoot: string, deps: ProjectScanDeps): Promise<{ gitRoot: string; found: boolean }> {
  let directory = startRoot;
  for (;;) {
    if (await pathExists(join(directory, '.git'), deps)) return { gitRoot: directory, found: true };
    const parent = dirname(directory);
    if (parent === directory) return { gitRoot: startRoot, found: false };
    directory = parent;
  }
}

// ---------------------------------------------------------------------------
// Runtime validation helpers
// ---------------------------------------------------------------------------

function optionalString(value: unknown, key: string, file: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) return invalid(`${file}: ${key} must be a non-empty string`);
  return value;
}

function optionalBoolean(value: unknown, key: string, file: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') return invalid(`${file}: ${key} must be a boolean`);
  return value;
}

function optionalNumber(value: unknown, key: string, file: string, integer = false): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return invalid(`${file}: ${key} must be a non-negative finite number`);
  }
  if (integer && !Number.isInteger(value)) return invalid(`${file}: ${key} must be an integer`);
  return value;
}

function optionalFiniteNumber(value: unknown, key: string, file: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) return invalid(`${file}: ${key} must be a finite number`);
  return value;
}

function optionalStringArray(value: unknown, key: string, file: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    return invalid(`${file}: ${key} must be an array of strings`);
  }
  return value as string[];
}

function optionalEnum<T extends string>(value: unknown, key: string, allowed: readonly T[], file: string): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    return invalid(`${file}: ${key} must be one of ${allowed.join('|')}`);
  }
  return value as T;
}

const ANO_SCAN_KEYS = new Set([
  'startRoot', 'gitRoot', 'pmRoot', 'sourceRoots', 'exclude', 'include', 'followLinks',
  'maxFileBytes', 'timeoutMs', 'maxFiles', 'maxTotalBytes', 'maxDiscoverDepth', 'deadline',
  'onAmbiguity', 'requireGit', 'reuse', 'cache',
]);

const ANO_METADATA_KEYS = new Set([
  'name', 'description', 'version', 'stack', 'goals', 'phase', 'modules', 'exposure',
  'license', 'budgets', 'created', 'updated',
]);

function assertKnownAnoKeys(raw: Record<string, unknown>, file: string): void {
  for (const key of Object.keys(raw)) {
    if (ANO_METADATA_KEYS.has(key)) continue;
    if (!ANO_SCAN_KEYS.has(key)) invalid(`${file}: unknown field ${key}`);
  }
}

function validateCache(value: unknown, file: string): ProjectScanCacheOptions | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid(`${file}: cache must be an object`);
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (key !== 'reuse' && key !== 'rebuild') invalid(`${file}: unknown cache field ${key}`);
  }
  const cache: ProjectScanCacheOptions = {};
  const reuse = optionalEnum(raw['reuse'], 'cache.reuse', ['auto', 'always', 'never'] as const, file);
  if (reuse !== undefined) cache.reuse = reuse;
  const rebuild = optionalBoolean(raw['rebuild'], 'cache.rebuild', file);
  if (rebuild !== undefined) cache.rebuild = rebuild;
  return cache;
}

function validateOptions(options: ProjectScanOptions): void {
  const file = 'scan options';
  for (const key of ['startRoot', 'gitRoot', 'pmRoot'] as const) optionalString(options[key], key, file);
  for (const key of ['sourceRoots', 'exclude', 'include'] as const) optionalStringArray(options[key], key, file);
  for (const key of ['followLinks', 'requireGit', 'allowMissingPmRoot'] as const) optionalBoolean(options[key], key, file);
  for (const key of ['maxFileBytes', 'timeoutMs', 'maxFiles', 'maxTotalBytes'] as const) optionalNumber(options[key], key, file);
  optionalNumber(options.maxDiscoverDepth, 'maxDiscoverDepth', file, true);
  optionalFiniteNumber(options.deadline, 'deadline', file);
  optionalEnum(options.onAmbiguity, 'onAmbiguity', ['nearest-layer', 'error'] as const, file);
  optionalEnum(options.reuse, 'reuse', ['auto', 'always', 'never'] as const, file);
  validateCache(options.cache, file);
}

function explicitOptionKeys(options: ProjectScanOptions): string[] {
  const keys = [
    'startRoot', 'gitRoot', 'pmRoot', 'sourceRoots', 'exclude', 'include', 'followLinks',
    'maxFileBytes', 'timeoutMs', 'maxFiles', 'maxTotalBytes', 'maxDiscoverDepth', 'deadline',
    'onAmbiguity', 'requireGit', 'reuse',
  ] as const;
  return keys.filter((key) => options[key] !== undefined);
}

// ---------------------------------------------------------------------------
// Config readers
// ---------------------------------------------------------------------------

interface AnoConfig {
  path?: string;
  raw: Record<string, unknown>;
}

async function readAnoConfig(gitRoot: string, deps: ProjectScanDeps): Promise<AnoConfig> {
  const file = join(gitRoot, '.ano', 'project.json');
  const raw = await readJsonFile(file, deps);
  if (raw === undefined) return { raw: {} };
  assertKnownAnoKeys(raw, file);
  return { path: file, raw };
}

async function readAnoRequireGitHint(startRoot: string, deps: ProjectScanDeps): Promise<boolean | undefined> {
  const raw = await readJsonFile(join(startRoot, '.ano', 'project.json'), deps);
  if (raw === undefined) return undefined;
  return optionalBoolean(raw['requireGit'], 'requireGit', join(startRoot, '.ano', 'project.json'));
}

interface PmConfig {
  path?: string;
  scanIgnore: string[];
}

async function readPmScanIgnore(pmRoot: string, deps: ProjectScanDeps): Promise<PmConfig> {
  const file = join(pmRoot, '.pm', 'project.json');
  const raw = await readJsonFile(file, deps);
  if (raw === undefined) return { scanIgnore: [] };
  const value = raw['scan_ignore'];
  if (value === undefined) return { path: file, scanIgnore: [] };
  const scanIgnore = optionalStringArray(value, 'scan_ignore', file);
  return { path: file, scanIgnore: scanIgnore ?? [] };
}

async function readPackageName(path: string, deps: ProjectScanDeps): Promise<string | undefined> {
  const raw = await readJsonFile(path, deps);
  if (raw === undefined) return undefined;
  const name = raw['name'];
  return typeof name === 'string' && name.trim().length > 0 ? name : undefined;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

interface DiscoveryArgs {
  startRoot: string;
  gitRoot: string;
  excludeGlobs: readonly string[];
  maxDepth: number;
  onAmbiguity: ScanAmbiguityMode;
  deps: ProjectScanDeps;
}

async function hasDirectoryChild(directory: string, deps: ProjectScanDeps): Promise<boolean> {
  const names = await listDirectory(directory, deps);
  for (const name of names) {
    const stats = await safeLstat(join(directory, name), deps);
    if (stats !== undefined && !stats.isSymbolicLink() && stats.isDirectory()) return true;
  }
  return false;
}

async function discoverSourceRoots(args: DiscoveryArgs): Promise<ScanDiscovery> {
  const { startRoot, gitRoot, excludeGlobs, maxDepth, onAmbiguity, deps } = args;
  const candidates: ScanCandidate[] = [];
  const queue: { absolutePath: string; relativePath: string; depth: number }[] = [
    { absolutePath: gitRoot, relativePath: '.', depth: 0 },
  ];
  const visited = new Set<string>([gitRoot]);
  let depthReached = 0;
  let truncated = false;

  while (queue.length > 0) {
    const node = queue.shift()!;
    depthReached = Math.max(depthReached, node.depth);

    if (await pathExists(join(node.absolutePath, 'package.json'), deps)) {
      const name = await readPackageName(join(node.absolutePath, 'package.json'), deps);
      candidates.push({
        relativePath: node.relativePath,
        absolutePath: node.absolutePath,
        depth: node.depth,
        ...(name !== undefined ? { name } : {}),
      });
    }

    if (node.depth >= maxDepth) {
      if (await hasDirectoryChild(node.absolutePath, deps)) truncated = true;
      continue;
    }

    const names = await listDirectory(node.absolutePath, deps);
    for (const name of names) {
      const absolutePath = join(node.absolutePath, name);
      const stats = await safeLstat(absolutePath, deps);
      if (stats === undefined || stats.isSymbolicLink() || !stats.isDirectory()) continue;
      const relativePath = node.relativePath === '.' ? name : `${node.relativePath}/${name}`;
      if (isExcluded(relativePath, excludeGlobs)) continue;
      if (visited.has(absolutePath)) continue;
      visited.add(absolutePath);
      queue.push({ absolutePath, relativePath, depth: node.depth + 1 });
    }
  }

  candidates.sort((a, b) => a.depth - b.depth || Buffer.from(a.relativePath).compare(Buffer.from(b.relativePath)));
  if (candidates.length === 0) {
    throw new ProjectScanError('NO_NODE_PACKAGE', `No package.json within ${maxDepth} level(s) below Git root: ${gitRoot}`);
  }
  const nearestDepth = candidates[0]!.depth;
  const nearest = candidates.filter((candidate) => candidate.depth === nearestDepth);
  if (nearest.length > 1 && onAmbiguity === 'error') {
    throw new ProjectScanError('AMBIGUOUS_SOURCE_ROOTS', `Ambiguous source roots at depth ${nearestDepth}: ${nearest.map((candidate) => candidate.relativePath).join(', ')}`);
  }
  const selected = nearest
    .map((candidate) => candidate.absolutePath)
    .sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
  return {
    startRoot,
    gitRoot,
    candidates,
    selected,
    depth: depthReached,
    truncated,
    ambiguous: nearest.length > 1,
    overridden: false,
  };
}

async function assertInsideGitRoot(candidate: string, gitRoot: string, deps: ProjectScanDeps): Promise<void> {
  const realCandidate = await realpathSafe(candidate, deps);
  const realGitRoot = await realpathSafe(gitRoot, deps);
  if (!isWithin(realCandidate, realGitRoot)) {
    throw new ProjectScanError('SOURCE_ROOT_OUTSIDE_GIT_ROOT', `Source root is outside the Git root: ${candidate}`);
  }
}

function relativeBases(relativePath: string, gitRoot: string, sourceRoots: readonly string[]): string[] {
  if (isAbsolute(relativePath)) {
    const bases: string[] = [];
    const gitRelative = normalizeRelativePath(relative(gitRoot, relativePath).replaceAll('\\', '/'));
    if (gitRelative.length > 0 && !gitRelative.startsWith('..') && !isAbsolute(gitRelative)) bases.push(gitRelative);
    for (const sourceRoot of sourceRoots) {
      const sourceRelative = normalizeRelativePath(relative(sourceRoot, relativePath).replaceAll('\\', '/'));
      if (sourceRelative.length > 0 && !sourceRelative.startsWith('..') && !isAbsolute(sourceRelative)) bases.push(sourceRelative);
    }
    return bases.length > 0 ? bases : [normalizeRelativePath(relativePath.replaceAll('\\', '/'))];
  }
  const bases = [normalizeRelativePath(relativePath)];
  const normalized = bases[0]!;
  for (const sourceRoot of sourceRoots) {
    const sourceRelative = normalizeRelativePath(relative(gitRoot, sourceRoot).replaceAll('\\', '/'));
    if (sourceRelative.length === 0 || sourceRelative === '.' || sourceRelative.startsWith('..')) continue;
    bases.push(`${sourceRelative}/${normalized}`);
  }
  return bases;
}

// ---------------------------------------------------------------------------
// Public resolver
// ---------------------------------------------------------------------------

/**
 * Resolve the three root roles (Git / PM / source), the merged exclusion set,
 * the shared budget and the discovery report. Consumers (fingerprint, graph,
 * brief) must use this instead of walking the tree or parsing roots themselves.
 */
export async function resolveProjectScan(
  options: ProjectScanOptions = {},
  deps: ProjectScanDeps = {},
): Promise<ResolvedProjectScan> {
  validateOptions(options);

  const startRaw = options.gitRoot ?? options.startRoot;
  if (typeof startRaw !== 'string' || startRaw.trim().length === 0) {
    throw new ProjectScanError('CONFIG_INVALID', 'startRoot or gitRoot is required');
  }
  const startRoot = await resolveEntryRoot(resolve(startRaw), deps);

  let gitRoot: string;
  if (options.gitRoot !== undefined) {
    gitRoot = startRoot;
    if (options.requireGit !== false && !(await pathExists(join(gitRoot, '.git'), deps))) {
      throw new ProjectScanError('NOT_A_GIT_WORK_TREE', `A Git work tree is required at ${gitRoot}`);
    }
  } else {
    const found = await findGitRoot(startRoot, deps);
    if (found.found) {
      gitRoot = found.gitRoot;
    } else if (options.requireGit === false || (await readAnoRequireGitHint(startRoot, deps)) === false) {
      gitRoot = startRoot;
    } else {
      throw new ProjectScanError('NOT_A_GIT_WORK_TREE', `No .git found at or above: ${startRoot}`);
    }
  }

  if (options.pmRoot !== undefined && resolve(options.pmRoot) === startRoot && startRoot !== gitRoot) {
    throw new ProjectScanError('ROOT_ROLE_CONFLICT', `A single root cannot be both the PM root and the source start when the Git root differs: ${startRoot}`);
  }
  const pmRootExplicit = options.pmRoot !== undefined;
  const pmRoot = await resolveEntryRoot(pmRootExplicit ? resolve(options.pmRoot!) : gitRoot, deps);
  const pmState = await inspectPmDirectory(pmRoot, deps);
  // Only a genuinely absent .pm on a non-explicit root may use the read-only
  // native path; explicit or unusable PM roots keep failing closed.
  const nativeScan = pmState === undefined && options.allowMissingPmRoot === true && !pmRootExplicit;
  if (!nativeScan) {
    if (pmState !== true) {
      throw new ProjectScanError('PM_ROOT_WITHOUT_PM', `pmRoot has no .pm directory: ${pmRoot}`);
    }
    if (pmRoot !== gitRoot) {
      const tasks = await readJsonFile(join(pmRoot, '.pm', 'tasks.json'), deps);
      if (!Array.isArray(tasks?.['tasks'])) {
        throw new ProjectScanError('PM_ROOT_WITHOUT_PM', `pmRoot has no PM task store: ${pmRoot}`);
      }
    }
  }

  const ano = await readAnoConfig(gitRoot, deps);
  const anoFile = ano.path ?? join(gitRoot, '.ano', 'project.json');
  const pm = await readPmScanIgnore(pmRoot, deps);

  const anoSourceRoots = optionalStringArray(ano.raw['sourceRoots'], 'sourceRoots', anoFile);
  const anoExclude = optionalStringArray(ano.raw['exclude'], 'exclude', anoFile);
  const anoInclude = optionalStringArray(ano.raw['include'], 'include', anoFile);
  const anoFollowLinks = optionalBoolean(ano.raw['followLinks'], 'followLinks', anoFile);
  const anoMaxFileBytes = optionalNumber(ano.raw['maxFileBytes'], 'maxFileBytes', anoFile);
  const anoTimeoutMs = optionalNumber(ano.raw['timeoutMs'], 'timeoutMs', anoFile);
  const anoMaxFiles = optionalNumber(ano.raw['maxFiles'], 'maxFiles', anoFile);
  const anoMaxTotalBytes = optionalNumber(ano.raw['maxTotalBytes'], 'maxTotalBytes', anoFile);
  const anoMaxDiscoverDepth = optionalNumber(ano.raw['maxDiscoverDepth'], 'maxDiscoverDepth', anoFile, true);
  const anoDeadline = optionalFiniteNumber(ano.raw['deadline'], 'deadline', anoFile);
  const anoOnAmbiguity = optionalEnum(ano.raw['onAmbiguity'], 'onAmbiguity', ['nearest-layer', 'error'] as const, anoFile);
  const anoRequireGit = optionalBoolean(ano.raw['requireGit'], 'requireGit', anoFile);
  const anoReuse = optionalEnum(ano.raw['reuse'], 'reuse', ['auto', 'always', 'never'] as const, anoFile);
  const anoCache = validateCache(ano.raw['cache'], anoFile);

  const excludeGlobs = [...new Set([
    ...DEFAULT_EXCLUDES,
    ...pm.scanIgnore,
    ...(anoExclude ?? []),
    ...(options.exclude ?? []),
  ])];
  const includeGlobs = [...new Set([
    ...(anoInclude ?? []),
    ...(options.include ?? []),
  ])];
  for (const glob of [...excludeGlobs, ...includeGlobs]) assertValidGlob(glob);

  const followLinks = options.followLinks ?? anoFollowLinks ?? false;
  const maxFileBytes = options.maxFileBytes ?? anoMaxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const timeoutMs = options.timeoutMs ?? anoTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxFiles = options.maxFiles ?? anoMaxFiles ?? DEFAULT_MAX_FILES;
  const maxTotalBytes = options.maxTotalBytes ?? anoMaxTotalBytes;
  const maxDiscoverDepth = options.maxDiscoverDepth ?? anoMaxDiscoverDepth ?? DEFAULT_MAX_DISCOVER_DEPTH;
  const deadline = options.deadline ?? anoDeadline;
  const onAmbiguity = options.onAmbiguity ?? anoOnAmbiguity ?? 'nearest-layer';
  const requireGit = options.requireGit ?? anoRequireGit ?? true;
  const reuse = options.reuse ?? options.cache?.reuse ?? anoReuse ?? anoCache?.reuse ?? 'auto';

  const explicitSourceRoots = options.sourceRoots ?? anoSourceRoots;
  let sourceRoots: string[];
  let discovery: ScanDiscovery;
  if (explicitSourceRoots !== undefined) {
    if (explicitSourceRoots.length === 0) throw new ProjectScanError('CONFIG_INVALID', 'sourceRoots must not be empty');
    const selected: string[] = [];
    // Explicit CLI roots are cwd-relative; roots declared in .ano/project.json
    // are relative to the Git root that owns the config file.
    const sourceRootBase = options.sourceRoots !== undefined ? process.cwd() : gitRoot;
    for (const rawRoot of explicitSourceRoots) {
      const absolute = await resolveEntryRoot(resolve(sourceRootBase, rawRoot), deps);
      await assertInsideGitRoot(absolute, gitRoot, deps);
      if (!selected.includes(absolute)) selected.push(absolute);
    }
    sourceRoots = selected;
    discovery = {
      startRoot,
      gitRoot,
      candidates: [],
      selected: selected.slice(),
      depth: 0,
      truncated: false,
      ambiguous: false,
      overridden: true,
    };
  } else {
    discovery = await discoverSourceRoots({ startRoot, gitRoot, excludeGlobs, maxDepth: maxDiscoverDepth, onAmbiguity, deps });
    sourceRoots = discovery.selected;
  }
  discovery.overridden = explicitSourceRoots !== undefined || options.gitRoot !== undefined;

  const budgets = createScanBudget({
    timeoutMs,
    maxFiles,
    ...(maxTotalBytes !== undefined ? { maxTotalBytes } : {}),
    ...(deadline !== undefined ? { deadline } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });

  const includeAncestors = [...new Set(includeGlobs.flatMap((glob) => {
    const segments = glob.split('/');
    return segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join('/'));
  }))];
  const excludes = (relativePath: string, isDirectory = false): boolean => {
    const bases = relativeBases(relativePath, gitRoot, sourceRoots);
    for (const base of bases) if (isSecretPath(base)) return true;
    if (bases.some((base) => matchesAnyGlob(includeGlobs, base))) return false;
    // Walking an excluded parent is necessary to reach an included descendant;
    // this exception does not re-admit unrelated files or sibling directories.
    if (isDirectory && bases.some((base) => matchesAnyGlob(includeAncestors, base))) return false;
    return bases.some((base) => matchesAnyGlob(excludeGlobs, base));
  };
  const includes = (relativePath: string): boolean => {
    const bases = relativeBases(relativePath, gitRoot, sourceRoots);
    return bases.some((base) => !isSecretPath(base) && matchesAnyGlob(includeGlobs, base));
  };

  const ignoredPmRoots: string[] = [];
  for (const sourceRoot of sourceRoots) {
    if (sourceRoot === pmRoot) continue;
    if (await pathExists(join(sourceRoot, '.pm'), deps)) ignoredPmRoots.push(sourceRoot);
  }

  return {
    startRoot,
    gitRoot,
    pmRoot,
    sourceRoots,
    excludes,
    includes,
    shouldFollowLink: (relativePath: string) => shouldFollowLink(relativePath, followLinks),
    excludeGlobs: [...excludeGlobs],
    includeGlobs: [...includeGlobs],
    followLinks,
    maxFileBytes,
    timeoutMs,
    maxFiles,
    maxTotalBytes,
    maxDiscoverDepth,
    onAmbiguity,
    requireGit,
    reuse,
    budgets,
    discovery,
    configSource: {
      ...(ano.path !== undefined ? { projectConfig: ano.path } : {}),
      ...(pm.path !== undefined ? { pmProjectConfig: pm.path } : {}),
      pmScanIgnore: [...pm.scanIgnore],
      defaults: [...DEFAULT_EXCLUDES],
      explicit: explicitOptionKeys(options),
      ignoredPmRoots,
    },
    rootResolution: { inputRoot: startRoot, gitRoot, pmRoot, sourceRoots: [...sourceRoots] },
    ignoredPmRoots,
  };
}
