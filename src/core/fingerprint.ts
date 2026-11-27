import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { Stats } from 'node:fs';
import { readdir, readFile, readlink, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  createScanBudget,
  DEFAULT_EXCLUDES,
  DEFAULT_MAX_FILE_BYTES,
  isExcluded,
  isSecretPath,
  ProjectScanError,
  scanBudgetExhausted,
  scanBudgetTimedOut,
  type ScanBudget,
  type ScanEntryStatus,
  type ScanStatus,
} from './project-scan.ts';

// ---------------------------------------------------------------------------
// Public contract (consumed by T-106 structure/freshness/brief)
// ---------------------------------------------------------------------------

export interface FingerprintOptions {
  /** Executable exclusion predicate; defaults to the ADR-009 default set via `defaultScanExclude`. */
  exclude?: (projectPath: string, isDirectory?: boolean) => boolean;
  /** Executable inclusion predicate; wins over `exclude` (secret paths never re-admitted). */
  includes?: (projectPath: string) => boolean;
  /** Default false: links are recorded as skipped-link and never followed. */
  followLinks?: boolean;
  /** Default 64 MiB; 0 means unlimited (no streaming threshold). */
  maxFileBytes?: number;
  /** Shared scan budget (T-104 `ResolvedProjectScan.budgets`); one is created when absent. */
  budgets?: ScanBudget;
  /** Optional T-104 link predicate; overrides `followLinks` when provided. */
  shouldFollowLink?: (relativePath: string) => boolean;
  /** Escalation hook: return 'degrade' to record instead of throwing. */
  onError?: (projectPath: string, error: unknown) => 'degrade' | 'throw';
}

export interface SourceFileFingerprint {
  path: string;
  hash: string;
  size: number;
  /** True when the digest came from the chunked streaming path (large file). */
  streamed?: boolean;
}

export interface FingerprintDegradedEntry {
  path: string;
  code: string;
  status?: ScanEntryStatus;
  /** Raw `readlink` target string for links (never resolved). */
  target?: string;
  reason?: string;
}

export interface FingerprintStats {
  files: number;
  bytes: number;
  skippedLinks: number;
  degraded: number;
  timeout: number;
  streamed: number;
}

export interface FingerprintCompleted {
  files: number;
  bytes: number;
  elapsedMs: number;
}

export interface SourceFingerprint {
  /** Tree digest over sorted `path\0hash\0size\n` records (unchanged algorithm). */
  hash: string;
  files: SourceFileFingerprint[];
  degraded: FingerprintDegradedEntry[];
  status?: ScanStatus;
  /** True when the budget was exhausted before the walk finished. */
  partial?: boolean;
  completed?: FingerprintCompleted;
  budget?: ScanBudget;
  reason?: string;
  stats?: FingerprintStats;
}

/** Default streaming block size: 4 MiB (ADR-009 §7). */
export const FINGERPRINT_STREAM_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Legacy fallback exclusion, reused by the scan-free `fingerprintTree` and the
 * scan-free graph/freshness path. It is the ADR-009 §5.2 default set plus the
 * secret category predicate, so the old interfaces can never drift from (or
 * re-admit) the resolved scan defaults. Not a locally maintained blacklist.
 */
export const defaultScanExclude = (path: string): boolean => isSecretPath(path) || isExcluded(path, DEFAULT_EXCLUDES);

function codeOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'UNKNOWN';
}

/**
 * Map a filesystem failure to an ADR-009 §11 entry status. Returns undefined
 * for unknown errors, which stay on the throw/degrade escalation path.
 */
export function classifyFingerprintError(error: unknown): { status: ScanEntryStatus; code: string } | undefined {
  const code = codeOf(error);
  if (code === 'EBUSY' || code === 'ETXTBSY') return { status: 'busy-file', code };
  if (code === 'EACCES' || code === 'EPERM') return { status: 'permission-denied', code };
  if (code === 'SOURCE_CHANGED') return { status: 'source-changed', code };
  return undefined;
}

async function rawLinkTarget(absolute: string): Promise<string | undefined> {
  try {
    return await readlink(absolute);
  } catch {
    return undefined;
  }
}

function linkEscape(relativePath: string): boolean {
  return relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath);
}

/**
 * Fingerprint a source tree.
 *
 * - Links are never followed by default; they are recorded as `skipped-link`
 *   with the raw target string and `follow-links-disabled`, counted in
 *   `stats.skippedLinks`, and never enter the file set or the tree digest.
 * - Files larger than `maxFileBytes` are hashed with a 4 MiB chunked stream.
 * - Busy/permission/changed files are degraded entries, never tree failures.
 * - A shared budget that is exhausted yields `status='timeout'` with a
 *   `completed` summary; an empty scan on a healthy budget is `degraded`.
 */
export async function fingerprintTree(root: string, options: FingerprintOptions = {}): Promise<SourceFingerprint> {
  const excludes = options.exclude ?? defaultScanExclude;
  const includes = options.includes;
  const isExcluded = (path: string, isDirectory = false): boolean => {
    if (includes !== undefined && includes(path)) return isSecretPath(path);
    return excludes(path, isDirectory);
  };
  const followLinks = options.followLinks ?? false;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const shouldFollow = options.shouldFollowLink ?? ((_relativePath: string) => followLinks);
  const budget = options.budgets ?? createScanBudget();

  const files: SourceFileFingerprint[] = [];
  const degraded: FingerprintDegradedEntry[] = [];
  let skippedLinks = 0;
  let streamedCount = 0;
  let totalBytes = 0;
  let timedOut = false;

  const rootReal = await realpath(root).catch(() => resolve(root));
  const visitedRealDirs = new Set<string>([rootReal]);

  const record = (entry: FingerprintDegradedEntry): void => {
    degraded.push(entry);
  };

  /** Chunked sha256; resolves undefined when the clock budget runs out. */
  const streamHash = async (absolute: string): Promise<{ hash: string; size: number } | undefined> => {
    const hash = createHash('sha256');
    let size = 0;
    const stream = createReadStream(absolute, { highWaterMark: FINGERPRINT_STREAM_CHUNK_BYTES });
    try {
      for await (const chunk of stream) {
        if (scanBudgetTimedOut(budget)) {
          stream.destroy();
          return undefined;
        }
        const buffer = chunk as Buffer;
        hash.update(buffer);
        size += buffer.length;
      }
    } catch (error) {
      stream.destroy();
      throw error;
    }
    return { hash: hash.digest('hex'), size };
  };

  const hashFile = async (absolute: string, path: string, before: Stats): Promise<void> => {
    budget.filesSeen += 1;
    const useStream = maxFileBytes > 0 && before.size > maxFileBytes;
    try {
      let hash: string;
      let size: number;
      let streamed = false;
      if (useStream) {
        const result = await streamHash(absolute);
        if (result === undefined) {
          timedOut = true;
          return;
        }
        hash = result.hash;
        size = result.size;
        streamed = true;
      } else {
        const bytes = await readFile(absolute);
        hash = createHash('sha256').update(bytes).digest('hex');
        size = bytes.length;
      }
      const after = await stat(absolute);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino || size !== after.size) {
        throw Object.assign(new Error(`Source changed during fingerprinting: ${path}`), { code: 'SOURCE_CHANGED' });
      }
      files.push({ path, hash, size, ...(streamed ? { streamed: true } : {}) });
      totalBytes += size;
      budget.bytesSeen += size;
      if (streamed) streamedCount += 1;
    } catch (error) {
      const known = classifyFingerprintError(error);
      if (known !== undefined) {
        record({ path, code: known.code, status: known.status });
        return;
      }
      if (options.onError?.(path, error) === 'degrade') {
        record({ path, code: codeOf(error) });
        return;
      }
      throw error;
    }
  };

  const walk = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      const path = relative(root, directory).split(sep).join('/') || '.';
      const known = classifyFingerprintError(error);
      if (known !== undefined) {
        record({ path, code: known.code, status: known.status });
        return;
      }
      if (options.onError?.(path, error) !== 'degrade') throw error;
      record({ path, code: codeOf(error) });
      return;
    }
    entries.sort((a, b) => Buffer.from(a.name).compare(Buffer.from(b.name)));
    for (const entry of entries) {
      if (timedOut) return;
      if (scanBudgetExhausted(budget)) {
        timedOut = true;
        return;
      }
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute).split(sep).join('/');
      // A link whose own path is inside a secret directory is never followed or
      // read; record it explicitly instead of dropping it silently.
      if (entry.isSymbolicLink() && isSecretPath(path)) {
        skippedLinks += 1;
        const target = await rawLinkTarget(absolute);
        record({
          path,
          code: 'skipped-link',
          status: 'skipped-link',
          ...(target !== undefined ? { target } : {}),
          reason: 'secret-path-excluded',
        });
        continue;
      }
      if (isExcluded(path, entry.isDirectory())) continue;

      if (entry.isSymbolicLink()) {
        if (!shouldFollow(path)) {
          skippedLinks += 1;
          const target = await rawLinkTarget(absolute);
          record({
            path,
            code: 'skipped-link',
            status: 'skipped-link',
            ...(target !== undefined ? { target } : {}),
            reason: followLinks ? 'secret-path-excluded' : 'follow-links-disabled',
          });
          continue;
        }
        let real: string;
        try {
          real = await realpath(absolute);
        } catch (error) {
          record({ path, code: codeOf(error), status: 'degraded', reason: 'broken-link' });
          continue;
        }
        const target = await rawLinkTarget(absolute);
        if (linkEscape(relative(rootReal, real))) {
          const escape = new ProjectScanError('LINK_ESCAPE', `Symbolic link escapes the scan root: ${path} -> ${real}`);
          record({
            path,
            code: escape.code,
            status: 'degraded',
            ...(target !== undefined ? { target } : {}),
            reason: 'link-escape',
          });
          continue;
        }
        // ADR-009 §5.3: judge the *resolved target's* relative path, never the
        // link path. A followed link must not re-admit a secret directory/file.
        if (isSecretPath(relative(rootReal, real).split(sep).join('/'))) {
          skippedLinks += 1;
          record({
            path,
            code: 'skipped-link',
            status: 'skipped-link',
            ...(target !== undefined ? { target } : {}),
            reason: 'secret-path-excluded',
          });
          continue;
        }
        if (visitedRealDirs.has(real)) {
          const loop = new ProjectScanError('LINK_ESCAPE', `Symbolic link loop: ${path} -> ${real}`);
          record({
            path,
            code: loop.code,
            status: 'degraded',
            ...(target !== undefined ? { target } : {}),
            reason: 'link-loop',
          });
          continue;
        }
        visitedRealDirs.add(real);
        let before: Stats;
        try {
          before = await stat(absolute);
        } catch (error) {
          const known = classifyFingerprintError(error);
          if (known !== undefined) {
            record({ path, code: known.code, status: known.status, ...(target !== undefined ? { target } : {}) });
            continue;
          }
          if (options.onError?.(path, error) !== 'degrade') throw error;
          record({ path, code: codeOf(error), ...(target !== undefined ? { target } : {}) });
          continue;
        }
        if (before.isDirectory()) {
          await walk(absolute);
          continue;
        }
        if (!before.isFile()) {
          record({ path, code: 'NON_REGULAR_FILE', status: 'degraded', reason: 'non-regular-entry' });
          continue;
        }
        await hashFile(absolute, path, before);
        continue;
      }

      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) {
        record({ path, code: 'NON_REGULAR_FILE', status: 'degraded', reason: 'non-regular-entry' });
        continue;
      }
      let before: Stats;
      try {
        before = await stat(absolute);
      } catch (error) {
        const known = classifyFingerprintError(error);
        if (known !== undefined) {
          record({ path, code: known.code, status: known.status });
          continue;
        }
        if (options.onError?.(path, error) !== 'degrade') throw error;
        record({ path, code: codeOf(error) });
        continue;
      }
      if (!before.isFile()) {
        record({ path, code: 'NON_REGULAR_FILE', status: 'degraded', reason: 'non-regular-entry' });
        continue;
      }
      await hashFile(absolute, path, before);
    }
  };

  await walk(root);
  files.sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)));
  const tree = createHash('sha256');
  for (const file of files) tree.update(file.path).update('\0').update(file.hash).update('\0').update(String(file.size)).update('\n');

  const now = Date.now();
  const elapsedMs = Math.max(0, now - budget.startedAt);
  const exhausted = scanBudgetExhausted(budget, now);
  const status: ScanStatus = exhausted
    ? 'timeout'
    : degraded.length > 0 || files.length === 0
      ? 'degraded'
      : 'ok';

  return {
    hash: tree.digest('hex'),
    files,
    degraded,
    status,
    ...(status === 'timeout' ? { partial: true } : {}),
    completed: { files: files.length, bytes: totalBytes, elapsedMs },
    budget,
    ...(status === 'timeout' ? { reason: 'scan-budget-exceeded' } : {}),
    stats: {
      files: files.length,
      bytes: totalBytes,
      skippedLinks,
      degraded: degraded.length,
      timeout: exhausted ? 1 : 0,
      streamed: streamedCount,
    },
  };
}
