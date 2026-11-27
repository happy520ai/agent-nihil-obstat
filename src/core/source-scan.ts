import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { defaultScanExclude, fingerprintTree, type FingerprintDegradedEntry, type SourceFileFingerprint, type SourceFingerprint } from './fingerprint.ts';
import { createScanBudget, ProjectScanError, resolveProjectScan, scanBudgetExhausted, type ResolvedProjectScan, type ScanBudget, type ScanStatus } from './project-scan.ts';

/**
 * Read-only Gate/Ledger source policy. A native `.ano` project without `.pm`
 * still consumes its `.ano/project.json` scan roots, exclusions and budgets;
 * the strict PM contract stays the default for every other resolver caller.
 * A tree with neither Git metadata nor `.pm` keeps the legacy scan-free path,
 * and a malformed `.ano` config is propagated instead of silently ignored.
 */
export async function resolveProjectSourceScan(root: string): Promise<ResolvedProjectScan | undefined> {
  try {
    return await resolveProjectScan({ startRoot: root, allowMissingPmRoot: true });
  } catch (error) {
    if (!(error instanceof ProjectScanError)) throw error;
    if (error.code === 'NOT_A_GIT_WORK_TREE') {
      try { await lstat(join(root, '.pm')); }
      catch (missing) {
        if ((missing as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw missing;
      }
    }
    throw error;
  }
}

/** Rebase a scan-root-relative POSIX path onto the shared fingerprint base. */
function rebasePath(baseRoot: string, sourceRoot: string, path: string): string {
  return relative(baseRoot, join(sourceRoot, ...path.split('/'))).split(sep).join('/');
}

/**
 * ADR-014 §5.1: compiled Python bytecode (`.pyc`) is a generated artifact and
 * never source. `__pycache__/**` is already in the ADR-009 default directory
 * exclusions; this covers loose bytecode files in ordinary source trees. An
 * explicit `includes` predicate still wins over this exclude (fingerprint
 * order), so nothing is prohibited that a caller deliberately asks for.
 */
export function isPythonBytecode(relativePath: string): boolean {
  return /\.pyc$/u.test(relativePath);
}

function treeHash(files: readonly SourceFileFingerprint[]): string {
  const tree = createHash('sha256');
  for (const file of files) tree.update(file.path).update('\0').update(file.hash).update('\0').update(String(file.size)).update('\n');
  return tree.digest('hex');
}

/** Combine per-source-root fingerprints into one project-relative fingerprint. */
export function combineSourceFingerprints(
  baseRoot: string,
  sourceRoots: readonly string[],
  parts: readonly SourceFingerprint[],
  budget: ScanBudget,
): SourceFingerprint {
  const files: SourceFileFingerprint[] = [];
  const degraded: FingerprintDegradedEntry[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const sourceRoot = sourceRoots[index]!;
    const part = parts[index]!;
    for (const file of part.files) files.push({ ...file, path: rebasePath(baseRoot, sourceRoot, file.path) });
    for (const entry of part.degraded) degraded.push({ ...entry, path: rebasePath(baseRoot, sourceRoot, entry.path) });
  }
  files.sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)));
  const bytes = files.reduce((sum, file) => sum + file.size, 0);
  const now = Date.now();
  const exhausted = scanBudgetExhausted(budget, now) || parts.some((part) => part.status === 'timeout');
  const status: ScanStatus = exhausted
    ? 'timeout'
    : degraded.length > 0 || files.length === 0
      ? 'degraded'
      : 'ok';
  const skippedLinks = parts.reduce((sum, part) => sum + (part.stats?.skippedLinks ?? 0), 0);
  const streamed = parts.reduce((sum, part) => sum + (part.stats?.streamed ?? 0), 0);
  const elapsedMs = Math.max(0, now - budget.startedAt);
  return {
    hash: treeHash(files),
    files,
    degraded,
    status,
    ...(status === 'timeout' ? { partial: true } : {}),
    completed: { files: files.length, bytes, elapsedMs },
    budget,
    ...(status === 'timeout' ? { reason: 'scan-budget-exceeded' } : {}),
    stats: {
      files: files.length,
      bytes,
      skippedLinks,
      degraded: degraded.length,
      timeout: exhausted ? 1 : 0,
      streamed,
    },
  };
}

/** Fingerprint all roots with one budget and the same scan rules as the graph. */
export async function fingerprintSourceRoots(
  baseRoot: string,
  sourceRoots: readonly string[],
  options: {
    scan?: ResolvedProjectScan;
    budgets?: ScanBudget;
    excludes?: (path: string, isDirectory?: boolean) => boolean;
    includes?: (path: string) => boolean;
    followLinks?: boolean;
    maxFileBytes?: number;
    shouldFollowLink?: (path: string) => boolean;
    /** Additional project-relative omissions for Gate-permitted runner artifacts. */
    omit?: (path: string) => boolean;
  },
): Promise<SourceFingerprint> {
  const scan = options.scan;
  const budget = options.budgets ?? createScanBudget(scan !== undefined ? {
    timeoutMs: scan.timeoutMs,
    maxFiles: scan.maxFiles,
    ...(scan.maxTotalBytes !== undefined ? { maxTotalBytes: scan.maxTotalBytes } : {}),
  } : {});
  const parts: SourceFingerprint[] = [];
  for (const sourceRoot of sourceRoots) {
    const excludes = scan?.excludes ?? options.excludes ?? defaultScanExclude;
    const includes = scan?.includes ?? options.includes;
    const omitted = (path: string): boolean => options.omit?.(rebasePath(baseRoot, sourceRoot, path)) ?? false;
    const fingerprintOptions = {
      exclude: (path: string, isDirectory?: boolean) => omitted(path) || isPythonBytecode(path) || excludes(path, isDirectory),
      ...(includes !== undefined ? { includes: (path: string) => !omitted(path) && includes(path) } : {}),
      ...(scan?.followLinks !== undefined ? { followLinks: scan.followLinks } : options.followLinks !== undefined ? { followLinks: options.followLinks } : {}),
      ...(scan?.maxFileBytes !== undefined ? { maxFileBytes: scan.maxFileBytes } : options.maxFileBytes !== undefined ? { maxFileBytes: options.maxFileBytes } : {}),
      ...(scan?.shouldFollowLink !== undefined ? { shouldFollowLink: scan.shouldFollowLink } : options.shouldFollowLink !== undefined ? { shouldFollowLink: options.shouldFollowLink } : {}),
      budgets: budget,
      onError: () => 'degrade' as const,
    };
    parts.push(await fingerprintTree(sourceRoot, fingerprintOptions));
  }
  return combineSourceFingerprints(baseRoot, sourceRoots, parts, budget);
}

/** Shared Graph/Gate/Ledger source scope; each pass receives a fresh scan budget. */
export async function fingerprintProject(
  root: string,
  scan: ResolvedProjectScan | undefined,
  omit?: (path: string) => boolean,
): Promise<SourceFingerprint> {
  if (scan !== undefined) {
    return fingerprintSourceRoots(scan.gitRoot, scan.sourceRoots, { scan, ...(omit !== undefined ? { omit } : {}) });
  }
  return fingerprintTree(root, {
    exclude: (path: string) => isPythonBytecode(path) || defaultScanExclude(path) || omit?.(path) === true,
  });
}
