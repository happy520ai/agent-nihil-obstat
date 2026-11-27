import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { canonicalJson, sha256Hex, slugify } from './canonical.ts';
import { ConnectLimitError, ConnectSourceError } from './errors.ts';
import { assertRealDirectory, resolveRoot } from './paths.ts';
import type { ConnectIdentity, ConnectionExcludedEntry } from './types.ts';

export interface ScanLimits {
  maxFileBytes: number;
  maxFiles: number;
  maxTotalBytes: number;
  maxDepth: number;
}

export const DEFAULT_SCAN_LIMITS: ScanLimits = {
  maxFileBytes: 32 * 1024 * 1024,
  maxFiles: 20_000,
  maxTotalBytes: 512 * 1024 * 1024,
  maxDepth: 32,
};

export interface ScannedFile {
  path: string;
  bytes: number;
  hash: string;
  content: Buffer;
  mediaType: string;
  binary: boolean;
}

export interface SourceScan {
  root: string;
  source: 'pm-mcp';
  identity: ConnectIdentity;
  files: ScannedFile[];
  excluded: ConnectionExcludedEntry[];
  sourceDigest: string;
  warnings: string[];
  counts: { files: number; totalBytes: number; textFiles: number; binaryFiles: number; excluded: number; excludedBytes: number };
}

export interface SourceAdapter {
  readonly kind: 'pm-mcp';
  scan(root: string, limits: ScanLimits): Promise<SourceScan>;
}

interface EntryMeta {
  path: string;
  full: string;
  size: number;
}

/**
 * Proven rebuildable search cache (SQLite tables: files, meta — a derived file
 * inventory, not authoritative source data). These are inventoried but excluded
 * from the digest so an active pm-mcp does not block a one-click connection.
 * Only these exact root-level paths qualify; every other file is archived.
 */
const DERIVED_CACHE_PATHS = new Set(['index.db', 'index.db-wal', 'index.db-shm']);

const BINARY_EXTENSIONS = new Set([
  '.db', '.sqlite', '.sqlite3', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp',
  '.pdf', '.zip', '.gz', '.tgz', '.tar', '.7z', '.rar', '.woff', '.woff2', '.ttf', '.otf',
  '.mp3', '.mp4', '.mov', '.avi', '.wav', '.ogg', '.bin', '.exe', '.dll', '.so', '.dylib',
  '.wasm', '.class', '.jar', '.pyc', '.o', '.a',
]);

const TEXT_MEDIA_TYPES: Record<string, string> = {
  '.json': 'application/json',
  '.jsonl': 'application/jsonl',
  '.ndjson': 'application/jsonl',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.toml': 'application/toml',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.htm': 'text/html',
};

function mediaTypeFor(path: string): string {
  return TEXT_MEDIA_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

function isBinaryContent(path: string, content: Buffer): boolean {
  if (BINARY_EXTENSIONS.has(extname(path).toLowerCase())) return true;
  const head = content.subarray(0, 8192);
  for (let index = 0; index < head.length; index += 1) {
    if (head[index] === 0) return true;
  }
  return false;
}

function listEntries(
  dirAbs: string,
  dirRel: string,
  depth: number,
  limits: ScanLimits,
  out: EntryMeta[],
  excluded: ConnectionExcludedEntry[],
): void {
  if (depth > limits.maxDepth) {
    throw new ConnectLimitError(`Source directory nesting exceeds ${limits.maxDepth} levels: ${dirRel || '.'}`);
  }
  let entries;
  try {
    entries = readdirSync(dirAbs, { withFileTypes: true });
  } catch (error) {
    throw new ConnectSourceError(`Cannot read source directory ${dirRel || '.'}: ${errorMessage(error)}`);
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const full = join(dirAbs, entry.name);
    const rel = dirRel.length > 0 ? `${dirRel}/${entry.name}` : entry.name;
    let stats;
    try {
      stats = lstatSync(full);
    } catch (error) {
      throw new ConnectSourceError(`Cannot stat source entry ${rel}: ${errorMessage(error)}`);
    }
    if (stats.isSymbolicLink()) {
      // Never follow symlinks or Windows junctions: a link is an explicit refusal, not a silent skip.
      throw new ConnectSourceError(`Refusing to follow symbolic link/junction in source: ${rel}`);
    }
    if (stats.isDirectory()) {
      listEntries(full, rel, depth + 1, limits, out, excluded);
      continue;
    }
    if (!stats.isFile()) {
      throw new ConnectSourceError(`Source contains a non-regular file (socket/fifo/device): ${rel}`);
    }
    if (DERIVED_CACHE_PATHS.has(rel)) {
      // Derived cache: inventory only, never read, never hashed, never part of the digest.
      excluded.push({ path: rel, reason: 'derived-cache', bytes: stats.size });
      continue;
    }
    if (stats.size > limits.maxFileBytes) {
      throw new ConnectLimitError(`Source file exceeds ${limits.maxFileBytes} bytes: ${rel} (${stats.size} bytes)`);
    }
    out.push({ path: rel, full, size: stats.size });
    if (out.length > limits.maxFiles) {
      throw new ConnectLimitError(`Source contains more than ${limits.maxFiles} files`);
    }
  }
}

function readSourceFiles(entries: readonly EntryMeta[], limits: ScanLimits): ScannedFile[] {
  const files: ScannedFile[] = [];
  let totalBytes = 0;
  for (const entry of entries) {
    let content: Buffer;
    try {
      content = readFileSync(entry.full);
    } catch (error) {
      throw new ConnectSourceError(`Cannot read source file ${entry.path}: ${errorMessage(error)}`);
    }
    if (content.length > limits.maxFileBytes) {
      throw new ConnectLimitError(`Source file exceeds ${limits.maxFileBytes} bytes: ${entry.path} (${content.length} bytes)`);
    }
    totalBytes += content.length;
    if (totalBytes > limits.maxTotalBytes) {
      throw new ConnectLimitError(`Source tree exceeds ${limits.maxTotalBytes} bytes`);
    }
    const binary = isBinaryContent(entry.path, content);
    files.push({
      path: entry.path,
      bytes: content.length,
      hash: sha256Hex(content),
      content,
      mediaType: mediaTypeFor(entry.path),
      binary,
    });
  }
  return files;
}

function assertSameListing(before: readonly EntryMeta[], after: readonly EntryMeta[]): void {
  if (before.length !== after.length) {
    throw new ConnectSourceError('Source file set changed while reading; refusing an inconsistent import');
  }
  for (let index = 0; index < before.length; index += 1) {
    const left = before[index];
    const right = after[index];
    if (!left || !right || left.path !== right.path || left.size !== right.size) {
      throw new ConnectSourceError('Source file set changed while reading; refusing an inconsistent import');
    }
  }
}

const STABLE_PROJECT_ID_FIELDS = ['id', 'project_id', 'projectId', 'uuid', 'key'] as const;

function stableProjectKey(root: string, project: Record<string, unknown>): string {
  for (const field of STABLE_PROJECT_ID_FIELDS) {
    const value = project[field];
    if (typeof value === 'string' && value.trim().length > 0) return `field:${field}:${value.trim()}`;
  }
  return `root:${root}`;
}

function readIdentity(root: string, files: readonly ScannedFile[]): ConnectIdentity {
  const instance = sha256Hex(root).slice(0, 16);
  const projectFile = files.find((file) => file.path === 'project.json');
  let rawName = 'unknown-project';
  let projectObject: Record<string, unknown> = {};
  if (projectFile) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(projectFile.content.toString('utf8')) as unknown;
    } catch (error) {
      throw new ConnectSourceError(`Malformed .pm/project.json: ${errorMessage(error)}`);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ConnectSourceError('.pm/project.json must contain a JSON object');
    }
    projectObject = parsed as Record<string, unknown>;
    const name = projectObject.name;
    if (typeof name === 'string' && name.trim().length > 0) rawName = name.trim();
  }
  const projectKey = stableProjectKey(root, projectObject);
  return {
    tool: 'pm-mcp',
    instance,
    project: slugify(rawName),
    displayName: rawName,
    projectId: sha256Hex(projectKey).slice(0, 12),
    projectKey,
  };
}

export const pmMcpAdapter: SourceAdapter = {
  kind: 'pm-mcp',
  async scan(root: string, limits: ScanLimits): Promise<SourceScan> {
    const canonicalRoot = resolveRoot(root);
    const pmDir = join(canonicalRoot, '.pm');
    assertRealDirectory(pmDir, '.pm source');

    const firstListing: EntryMeta[] = [];
    const firstExcluded: ConnectionExcludedEntry[] = [];
    listEntries(pmDir, '', 0, limits, firstListing, firstExcluded);
    const files = readSourceFiles(firstListing, limits);

    // Read-after verification: the archived listing and every content hash must
    // match. Derived cache files are intentionally not compared (pm-mcp may be
    // writing them); any other dynamic source still fails closed.
    const secondListing: EntryMeta[] = [];
    const secondExcluded: ConnectionExcludedEntry[] = [];
    listEntries(pmDir, '', 0, limits, secondListing, secondExcluded);
    assertSameListing(firstListing, secondListing);
    const rerun = readSourceFiles(secondListing, limits);
    for (let index = 0; index < files.length; index += 1) {
      const before = files[index];
      const after = rerun[index];
      if (!before || !after || before.hash !== after.hash || before.bytes !== after.bytes) {
        throw new ConnectSourceError(`Source file changed while reading: ${before?.path ?? 'unknown'}`);
      }
    }

    const identity = readIdentity(canonicalRoot, files);
    const digestInput = files.map((file) => ({ path: file.path, hash: file.hash, bytes: file.bytes }));
    const sourceDigest = sha256Hex(canonicalJson(digestInput));
    const binaryFiles = files.filter((file) => file.binary).length;
    const warnings: string[] = [];
    if (binaryFiles > 0) {
      warnings.push(`Archived ${binaryFiles} binary file(s); binary blobs are exported but not text-searched.`);
    }
    if (firstExcluded.length > 0) {
      warnings.push(
        `Excluded ${firstExcluded.length} rebuildable derived search cache file(s) (${firstExcluded.map((entry) => entry.path).join(', ')}); ` +
          'cache is not part of the digest and is not a byte-for-byte backup. Authoritative JSON and history files are fully retained.',
      );
    }
    return {
      root: canonicalRoot,
      source: 'pm-mcp',
      identity,
      files,
      excluded: firstExcluded,
      sourceDigest,
      warnings,
      counts: {
        files: files.length,
        totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
        textFiles: files.length - binaryFiles,
        binaryFiles,
        excluded: firstExcluded.length,
        excludedBytes: firstExcluded.reduce((sum, entry) => sum + entry.bytes, 0),
      },
    };
  },
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
