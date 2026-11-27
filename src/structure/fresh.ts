import { createHash } from 'node:crypto';
import { lstat, readdir, readFile as readFileFromDisk } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { createScanBudget, scanBudgetExhausted, type ResolvedProjectScan, type ScanBudget, type ScanStatus } from '../core/project-scan.ts';
import { defaultScanExclude, type SourceFingerprint } from '../core/fingerprint.ts';
import { fingerprintSourceRoots, isPythonBytecode } from '../core/source-scan.ts';
export { combineSourceFingerprints, fingerprintSourceRoots } from '../core/source-scan.ts';
import type { Freshness, GraphSnapshot } from './types.ts';
import { supportedStructureExtensions } from './extractor.ts';

export interface FreshnessCheck {
  freshness: Freshness;
  changed: string[];
  added: string[];
  removed: string[];
  degradedReasons: string[];
  /** `hit` when a valid persisted manifest answered without a full fingerprint. */
  cache?: 'hit' | 'miss';
  /** True when the shared budget was exhausted before the walk finished. */
  timeout?: boolean;
  /** Raw scan status so graph/brief surfaces can report timeout explicitly. */
  scanStatus?: ScanStatus;
}

/**
 * Metadata-only tree signature used to validate a persisted graph cache.
 *
 * `size`/`mtimeMs` alone are not a content proof: a writer can restore `mtime`
 * (`utimes`) or two writes can land in the same clock tick. `ino` catches an
 * replaced inode and `ctimeMs` catches a write/utimes that preserved `mtime`;
 * `hash` is the content digest captured when the manifest was written so a
 * file touched at/after the manifest can be re-verified by content.
 */
export interface SourceMetadata {
  size: number;
  mtimeMs: number;
  /** Inode number as text: Windows inode values exceed `Number.MAX_SAFE_INTEGER`. */
  ino: string;
  ctimeMs: number;
  /** Content sha256 from the build that wrote the manifest; '' for legacy rows. */
  hash: string;
}
export type SourceMetadataMap = Map<string, SourceMetadata>;

export interface FreshnessScanOptions {
  /** Resolved ADR-009 scan options; supplies roots, excludes and budget. */
  scan?: ResolvedProjectScan;
  sourceRoots?: string[];
  /** Path base for graph-relative file paths (normally the Git root). */
  baseRoot?: string;
  budgets?: ScanBudget;
  /** Persisted manifest. When present and matching, no content is read. */
  manifest?: ReadonlyMap<string, SourceMetadata>;
  /**
   * Build start time (ms) bound to `manifest`. A file whose `mtimeMs`/`ctimeMs`
   * is at or after this instant was touched around the build, so its metadata
   * is not trusted and its content is re-hashed. Required for the fast path;
   * a manifest without it is treated as unusable.
   */
  manifestBuiltAt?: number;
  /** Content reader used only for the suspicious-file recheck. */
  readFile?: (absolutePath: string) => Promise<string>;
  /** Canonical scan configuration, compared with `storedScanKey`. */
  scanKey?: string;
  storedScanKey?: string;
  /**
   * Opt-in Python structure (test seam). Defaults to the build-time
   * `ENABLE_PYTHON_STRUCTURE`, so `.py` files in an enabled snapshot are never
   * reported as removed while the flag is closed.
   */
  enablePythonStructure?: boolean;
  /** Legacy exclusion predicate; defaults to the ADR-009 default set via `defaultScanExclude`. */
  excludes?: (path: string, isDirectory?: boolean) => boolean;
}

function isSupported(path: string, extensions: readonly string[]): boolean {
  return extensions.some((extension) => path.endsWith(extension));
}

/** Rebase a scan-root-relative POSIX path onto the graph base root. */
function rebasePath(baseRoot: string, sourceRoot: string, path: string): string {
  const absolute = join(sourceRoot, ...path.split('/'));
  return relative(baseRoot, absolute).split(sep).join('/');
}

/**
 * Metadata-only walk (readdir + lstat, never a content read). It exists so a
 * valid graph cache can be recognised without re-hashing the whole tree.
 */
export async function collectSourceMetadata(
  baseRoot: string,
  sourceRoots: readonly string[],
  excludes: (path: string, isDirectory?: boolean) => boolean,
): Promise<SourceMetadataMap> {
  const out: SourceMetadataMap = new Map();
  for (const sourceRoot of sourceRoots) await walk(sourceRoot, '');
  async function walk(directory: string, relativeDirectory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => Buffer.from(a.name).compare(Buffer.from(b.name)));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const relativePath = relativeDirectory.length === 0 ? entry.name : `${relativeDirectory}/${entry.name}`;
      if (excludes(relativePath, entry.isDirectory())) continue;
      // Keep the metadata fast path aligned with source scanning: loose `.pyc`
      // is a generated artifact. `__pycache__/**` is already in the ADR-009
      // default directory exclusions.
      if (entry.isFile() && isPythonBytecode(relativePath)) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(absolute, relativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stats = await lstat(absolute);
        out.set(relative(baseRoot, absolute).split(sep).join('/'), {
          size: stats.size,
          mtimeMs: stats.mtimeMs,
          ino: String(stats.ino),
          ctimeMs: stats.ctimeMs,
          hash: '',
        });
      } catch {
        // A vanished entry is a cache miss; never a reason to throw.
      }
    }
  }
  return out;
}

/**
 * Metadata comparison. `ino`/`ctimeMs` are skipped for legacy manifest rows
 * (stored empty/0) so a pre-upgrade cache degrades to a rebuild instead of a
 * false mismatch; the missing `manifestBuiltAt` guard elsewhere forces that
 * rebuild anyway.
 */
export function metadataMatches(current: ReadonlyMap<string, SourceMetadata>, expected: ReadonlyMap<string, SourceMetadata>): boolean {
  if (current.size !== expected.size) return false;
  for (const [path, meta] of expected) {
    const actual = current.get(path);
    if (actual === undefined || actual.size !== meta.size || actual.mtimeMs !== meta.mtimeMs) return false;
    if (meta.ino !== '' && actual.ino !== meta.ino) return false;
    if (meta.ctimeMs !== 0 && actual.ctimeMs !== meta.ctimeMs) return false;
  }
  return true;
}

/**
 * Content re-verification for files whose metadata is not trustworthy: a file
 * whose `mtimeMs` or `ctimeMs` is at/after the manifest build instant was
 * touched around the build, so size/mtime can coincide with an older content
 * revision (utimes-restored mtime, same-tick write). Genuine cache hits have
 * every file older than the build, so this reads nothing on the fast path.
 *
 * Returns false (cache unusable) when a suspicious file cannot be read or its
 * digest differs from the manifest; a missing stored digest also fails closed.
 */
export async function recheckManifestContent(
  baseRoot: string,
  current: ReadonlyMap<string, SourceMetadata>,
  expected: ReadonlyMap<string, SourceMetadata>,
  builtAt: number,
  readFile?: (absolutePath: string) => Promise<string>,
): Promise<boolean> {
  const read = readFile ?? (async (absolutePath: string) => readFileFromDisk(absolutePath, 'utf8'));
  for (const [path, meta] of current) {
    if (meta.mtimeMs < builtAt && meta.ctimeMs < builtAt) continue;
    const before = expected.get(path);
    if (before === undefined || before.hash.length === 0) return false;
    let content: string;
    try {
      content = await read(join(baseRoot, path));
    } catch {
      return false;
    }
    if (createHash('sha256').update(content).digest('hex') !== before.hash) return false;
  }
  return true;
}

/**
 * Recompute the current source hashes and compare them with the snapshot manifest.
 * Any unreadable path degrades freshness; a readable content mismatch is stale.
 * Without followed links, a valid persisted manifest short-circuits the walk:
 * metadata (size/mtime/ino/ctime) must match, and any file touched at/after the
 * manifest build instant is re-verified by content. Followed links require the
 * bounded fingerprint walk to validate their targets. A budget miss is reported
 * as an explicit timeout/degraded reason.
 */
export async function checkGraphFreshness(root: string, snapshot: GraphSnapshot, options: FreshnessScanOptions = {}): Promise<FreshnessCheck> {
  const scan = options.scan;
  const sourceRoots = options.sourceRoots ?? (scan !== undefined ? scan.sourceRoots : [root]);
  const baseRoot = options.baseRoot ?? (scan !== undefined ? scan.gitRoot : root);
  const excludes = options.excludes ?? scan?.excludes ?? defaultScanExclude;
  // The flag default is the build-time constant; a test seam may opt in so an
  // enabled snapshot is compared with Python as source rather than "removed".
  const supportedExtensions = supportedStructureExtensions(options.enablePythonStructure);

  if (
    scan !== undefined
    && !scan.followLinks
    && options.manifest !== undefined
    && options.manifest.size > 0
    && options.manifestBuiltAt !== undefined
    && options.manifestBuiltAt > 0
    && options.scanKey !== undefined
    && options.scanKey === options.storedScanKey
  ) {
    const current = await collectSourceMetadata(baseRoot, sourceRoots, excludes);
    if (
      metadataMatches(current, options.manifest)
      && await recheckManifestContent(baseRoot, current, options.manifest, options.manifestBuiltAt, options.readFile)
    ) {
      return {
        freshness: { status: 'fresh', stale: 0 },
        changed: [],
        added: [],
        removed: [],
        degradedReasons: [],
        cache: 'hit',
      };
    }
  }

  const budget = options.budgets ?? createScanBudget();
  const current = await fingerprintSourceRoots(baseRoot, sourceRoots, {
    ...(scan !== undefined ? { scan } : {}),
    budgets: budget,
    excludes,
  });
  const currentHashes = new Map<string, string>();
  for (const file of current.files) if (isSupported(file.path, supportedExtensions)) currentHashes.set(file.path, file.hash);
  const snapshotHashes = new Map<string, string>();
  for (const [path, file] of Object.entries(snapshot.files)) snapshotHashes.set(path, file.hash);

  const changed: string[] = [];
  for (const [path, hash] of currentHashes) {
    const previous = snapshotHashes.get(path);
    if (previous !== undefined && previous !== hash) changed.push(path);
  }
  const added = [...currentHashes.keys()].filter((path) => !snapshotHashes.has(path));
  const removed = [...snapshotHashes.keys()].filter((path) => !currentHashes.has(path));
  const timeout = current.status === 'timeout';
  const degradedReasons = [
    ...current.degraded.map((entry) => `fingerprint-degraded:${entry.path}:${entry.code}`),
    ...(timeout ? ['scan-timeout:budget-exceeded'] : []),
    ...snapshot.caveats.degradedReasons,
  ];
  const reasons = [...new Set(degradedReasons)].sort();
  const stale = changed.length + added.length + removed.length;
  const freshness: Freshness = timeout || reasons.length > 0
    ? { status: 'degraded', stale, reasons }
    : snapshot.sourceFingerprint !== current.hash || stale > 0
      ? { status: 'stale', stale }
      : { status: 'fresh', stale: 0 };
  return {
    freshness,
    changed: changed.sort(),
    added: added.sort(),
    removed: removed.sort(),
    degradedReasons: reasons,
    cache: 'miss',
    ...(timeout ? { timeout: true } : {}),
    ...(current.status !== undefined ? { scanStatus: current.status } : {}),
  };
}

/** Gate-facing predicate: only an exactly fresh graph may support completion. */
export function isGraphFresh(freshness: Freshness): boolean {
  return freshness.status === 'fresh';
}
