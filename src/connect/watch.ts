import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { clamp } from './read.ts';
import {
  connectProject as defaultConnectProject,
  planConnection as defaultPlanConnection,
  type ConnectEngine,
} from './engine.ts';
import { stableJson } from './canonical.ts';
import { ConnectSourceError } from './errors.ts';
import { ensureSafeDirectory, resolveRoot, safeChild } from './paths.ts';
import { defaultTakeoverIo, loadPolicy, readTransactions, takeoverDir } from './takeover-store.ts';
import { computeTakeoverSourceDigest } from './takeover.ts';
import { CONNECT_DRIFT_SCHEMA, CONNECT_DRIFT_WATCH_SCHEMA } from './types.ts';
import type {
  ConnectDriftFile,
  ConnectDriftReport,
  ConnectDriftWatchOptions,
  ConnectDriftWatchReport,
  ConnectDriftWatchStopReason,
  ConnectionResult,
} from './types.ts';

export { CONNECT_DRIFT_SCHEMA, CONNECT_DRIFT_WATCH_SCHEMA };

/** Schema tag for a foreground watch report. */
export const CONNECT_WATCH_SCHEMA = 'ano.connect-watch/1' as const;

/** Hard lower bound for a watch interval. Values below this are clamped up. */
export const MIN_WATCH_INTERVAL_MS = 50;
/** Default delay between two watch cycles. */
export const DEFAULT_WATCH_INTERVAL_MS = 1000;
/** Hard upper bound for a watch interval (24h). */
export const MAX_WATCH_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type ConnectWatchOutcome = 'committed' | 'unchanged' | 'source-changed' | 'error';

export type ConnectWatchStopReason = 'max-cycles' | 'aborted' | 'error';

export interface ConnectWatchCycleRecord {
  /** 1-based cycle number. */
  cycle: number;
  /** Digest observed by planConnection at the start of this cycle. */
  plannedDigest: string;
  outcome: ConnectWatchOutcome;
  /** Connection result when the cycle reached connectProject. */
  result?: ConnectionResult;
  /** Human-readable reason for source-changed/error outcomes. */
  message?: string;
}

export interface ConnectWatchOptions {
  /** Project root that owns .pm and .ano/connect. */
  root: string;
  /** Delay between cycles in milliseconds. Clamped to [MIN_WATCH_INTERVAL_MS, MAX_WATCH_INTERVAL_MS]. */
  intervalMs?: number;
  /** Deterministic test hook: stop after this many cycles. Omit to run until aborted. */
  maxCycles?: number;
  /** AbortSignal stops the foreground loop promptly (between cycles). */
  signal?: AbortSignal;
  /** Engine used for plan/connect. Defaults to the shared public Connect functions. */
  engine?: ConnectEngine;
  /** Observed after each cycle is fully recorded. */
  onCycle?: (record: ConnectWatchCycleRecord) => void;
}

export interface ConnectWatchReport {
  schema: typeof CONNECT_WATCH_SCHEMA;
  root: string;
  /** Effective interval after clamping. */
  intervalMs: number;
  maxCycles?: number;
  /** Number of cycles that ran. */
  cycles: number;
  stopped: ConnectWatchStopReason;
  /** Digest of the last successfully committed version, if any. */
  committedDigest?: string;
  /** Digest observed by the last plan, if a cycle ran. */
  lastPlannedDigest?: string;
  records: ConnectWatchCycleRecord[];
  error?: string;
}

/**
 * Bounded, explicit, foreground Connect watch.
 *
 * Each cycle plans the source digest, and only calls connectProject with
 * `expectedDigest` when that digest differs from the last committed one. Cycles
 * never overlap; the loop sleeps between cycles and resolves promptly when the
 * AbortSignal fires. It never writes back to the source, never spawns a
 * background process, and uses no timers other than the inter-cycle sleep.
 */
export async function watchConnection(options: ConnectWatchOptions): Promise<ConnectWatchReport> {
  const intervalMs = clamp(
    options.intervalMs ?? DEFAULT_WATCH_INTERVAL_MS,
    MIN_WATCH_INTERVAL_MS,
    MAX_WATCH_INTERVAL_MS,
    DEFAULT_WATCH_INTERVAL_MS,
  );
  const maxCycles = options.maxCycles === undefined
    ? undefined
    : clamp(options.maxCycles, 0, Number.MAX_SAFE_INTEGER, 0);
  const engine = options.engine;
  const signal = options.signal;
  const records: ConnectWatchCycleRecord[] = [];
  let committedDigest: string | undefined;
  let lastPlannedDigest: string | undefined;
  let stopped: ConnectWatchStopReason = 'max-cycles';
  let errorMessage: string | undefined;

  const totalPlanned = maxCycles ?? Number.POSITIVE_INFINITY;
  for (let cycle = 1; cycle <= totalPlanned; cycle += 1) {
    if (signal?.aborted) {
      stopped = 'aborted';
      break;
    }
    let record: ConnectWatchCycleRecord;
    try {
      const plan = engine ? await engine.planConnection(options.root) : await defaultPlanConnection(options.root);
      lastPlannedDigest = plan.sourceDigest;
      if (committedDigest !== undefined && plan.sourceDigest === committedDigest) {
        record = { cycle, plannedDigest: plan.sourceDigest, outcome: 'unchanged' };
      } else {
        const result = engine
          ? await engine.connectProject(options.root, { expectedDigest: plan.sourceDigest })
          : await defaultConnectProject(options.root, { expectedDigest: plan.sourceDigest });
        if (result.sourceUnchanged === false) {
          record = {
            cycle,
            plannedDigest: plan.sourceDigest,
            outcome: 'source-changed',
            result,
            message: result.report.reason ?? 'source-changed',
          };
        } else if (result.report.connected) {
          committedDigest = result.sourceDigest;
          record = {
            cycle,
            plannedDigest: plan.sourceDigest,
            outcome: result.duplicate ? 'unchanged' : 'committed',
            result,
          };
        } else {
          record = {
            cycle,
            plannedDigest: plan.sourceDigest,
            outcome: 'error',
            result,
            message: result.report.reason ?? 'connect failed',
          };
        }
      }
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
      record = { cycle, plannedDigest: lastPlannedDigest ?? '', outcome: 'error', message: errorMessage };
      records.push(record);
      options.onCycle?.(record);
      stopped = 'error';
      break;
    }
    records.push(record);
    options.onCycle?.(record);
    if (signal?.aborted) {
      stopped = 'aborted';
      break;
    }
    if (cycle >= totalPlanned) {
      stopped = 'max-cycles';
      break;
    }
    await sleep(intervalMs, signal);
  }

  const report: ConnectWatchReport = {
    schema: CONNECT_WATCH_SCHEMA,
    root: options.root,
    intervalMs,
    ...(maxCycles === undefined ? {} : { maxCycles }),
    cycles: records.length,
    stopped,
    ...(committedDigest === undefined ? {} : { committedDigest }),
    ...(lastPlannedDigest === undefined ? {} : { lastPlannedDigest }),
    records,
    ...(errorMessage === undefined ? {} : { error: errorMessage }),
  };
  return report;
}

/** Abortable delay: resolves immediately when the signal fires. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ---- legacy-source drift (T-071 / ADR-006 §6) ---------------------------
//
// Drift detection is read-only: it compares the takeover-bound baseline digest
// with a freshly recomputed digest (the same `computeTakeoverSourceDigest` the
// takeover transaction used) and localizes differences at file granularity.
// It never writes the legacy source, never merges drift into the ledger and
// never changes the policy state; it only reports a `recovery` recommendation.

interface BaselineFile {
  path: string;
  sha256: string;
  bytes: number;
}

function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * The baseline file manifest bound at takeover time. The immutable backup
 * manifest is preferred; the prepared artifact is the fallback. Returns null
 * when no baseline manifest is available (aggregate digest comparison only).
 */
function readBaselineFiles(root: string, backupId: string | null): BaselineFile[] | null {
  const candidates: string[] = [];
  if (backupId !== null) candidates.push(safeChild(root, '.ano', 'backup', backupId, 'manifest.json'));
  candidates.push(safeChild(takeoverDir(root), 'prepared.json'));
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { pm?: unknown };
      if (!Array.isArray(raw.pm)) continue;
      const files: BaselineFile[] = [];
      for (const entry of raw.pm) {
        if (typeof entry !== 'object' || entry === null) continue;
        const record = entry as Record<string, unknown>;
        if (typeof record.path !== 'string' || typeof record.sha256 !== 'string' || typeof record.bytes !== 'number') continue;
        files.push({ path: record.path, sha256: record.sha256, bytes: record.bytes });
      }
      return files;
    } catch {
      // A corrupt/unusable baseline is skipped; the digest comparison still runs.
    }
  }
  return null;
}

/** Current `.pm` tree hashes, path-relative and deterministically ordered. */
function readCurrentPmFiles(root: string): BaselineFile[] {
  const base = safeChild(root, '.pm');
  const out: BaselineFile[] = [];
  if (!existsSync(base)) return out;
  const walk = (dir: string, prefix: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      const rel = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile()) {
        try {
          const bytes = readFileSync(full);
          out.push({ path: rel, sha256: sha256Hex(bytes), bytes: bytes.length });
        } catch {
          // An unreadable file is skipped; the digest comparison remains authoritative.
        }
      }
    }
  };
  walk(base, '');
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function diffBaselineFiles(baseline: readonly BaselineFile[], current: readonly BaselineFile[]): ConnectDriftFile[] {
  const base = new Map(baseline.map((file) => [file.path, file]));
  const now = new Map(current.map((file) => [file.path, file]));
  const paths = [...new Set([...base.keys(), ...now.keys()])].sort();
  const files: ConnectDriftFile[] = [];
  for (const path of paths) {
    const before = base.get(path);
    const after = now.get(path);
    if (before !== undefined && after === undefined) {
      files.push({ path, kind: 'removed', baselineSha256: before.sha256, baselineBytes: before.bytes });
    } else if (before === undefined && after !== undefined) {
      files.push({ path, kind: 'added', currentSha256: after.sha256, currentBytes: after.bytes });
    } else if (before !== undefined && after !== undefined && before.sha256 !== after.sha256) {
      files.push({
        path,
        kind: 'modified',
        baselineSha256: before.sha256,
        currentSha256: after.sha256,
        baselineBytes: before.bytes,
        currentBytes: after.bytes,
      });
    }
  }
  return files;
}

export interface DetectLegacyDriftOptions {
  /** Migration source paths; defaults to the project's migration sources. */
  sources?: readonly string[];
  /** Deterministic clock for tests; defaults to now. */
  now?: string;
}

/**
 * Detect external writes to the legacy source since the enforced takeover.
 * Returns null when the project has no enforced takeover (ordinary Connect
 * projects are untouched). The report is read-only and never writes back.
 */
export function detectLegacyDrift(rootInput: string, options: DetectLegacyDriftOptions = {}): ConnectDriftReport | null {
  const root = resolveRoot(rootInput);
  const policy = loadPolicy(root);
  if (policy === null || policy.state !== 'enforced') return null;
  const baselineDigest = policy.baselineDigest;
  if (baselineDigest === null) {
    throw new ConnectSourceError('enforced takeover policy has no baseline digest');
  }
  const transactions = readTransactions(root);
  const last = transactions.at(-1) ?? null;
  const currentDigest = computeTakeoverSourceDigest(root, options.sources === undefined ? undefined : [...options.sources]);
  const detectedAt = options.now ?? new Date().toISOString();
  const drifted = currentDigest !== baselineDigest;
  let files: ConnectDriftFile[] = [];
  let note: string;
  if (!drifted) {
    note = 'legacy source digest matches the takeover baseline';
  } else {
    const baselineFiles = readBaselineFiles(root, last?.backupId ?? null);
    if (baselineFiles === null) {
      note = 'legacy source digest differs from the takeover baseline; no baseline file manifest was available for localization';
    } else {
      files = diffBaselineFiles(baselineFiles, readCurrentPmFiles(root));
      note = 'legacy source changed after takeover; reconcile is stale and no write-back is performed';
    }
  }
  return {
    schema: CONNECT_DRIFT_SCHEMA,
    root,
    state: policy.state,
    authorizationId: policy.authorization.authorizationId,
    baselineDigest,
    currentDigest,
    drifted,
    files,
    detectedAt,
    recommendation: drifted ? 'recovery' : 'none',
    reconcileStale: drifted,
    ...(last === null ? {} : { backupId: last.backupId, backupHash: last.backupHash }),
    note,
  };
}

/** Persist one drift report under `.ano/takeover/drift/` (ANO-owned, never `.pm`). */
export function writeDriftReport(rootInput: string, report: ConnectDriftReport): string {
  const root = resolveRoot(rootInput);
  const directory = safeChild(takeoverDir(root), 'drift');
  ensureSafeDirectory(directory);
  const stamp = report.detectedAt.replace(/[^0-9A-Za-z._-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'drift';
  const path = safeChild(directory, `${stamp}.json`);
  const temp = defaultTakeoverIo.writeTemp(path, stableJson(report));
  try {
    defaultTakeoverIo.rename(temp, path);
  } catch (error) {
    defaultTakeoverIo.remove(temp);
    throw error;
  }
  return path;
}

/**
 * Bounded, explicit, foreground drift watch. It polls `detectLegacyDrift`
 * between cycles, stops at the first drifted report, and preserves the same
 * no-overlap / abortable semantics as `watchConnection`. Ordinary projects
 * (no enforced policy) simply never report drift.
 */
export async function watchDrift(options: ConnectDriftWatchOptions): Promise<ConnectDriftWatchReport> {
  const intervalMs = clamp(
    options.intervalMs ?? DEFAULT_WATCH_INTERVAL_MS,
    MIN_WATCH_INTERVAL_MS,
    MAX_WATCH_INTERVAL_MS,
    DEFAULT_WATCH_INTERVAL_MS,
  );
  const maxCycles = options.maxCycles === undefined
    ? undefined
    : clamp(options.maxCycles, 0, Number.MAX_SAFE_INTEGER, 0);
  const signal = options.signal;
  const totalPlanned = maxCycles ?? Number.POSITIVE_INFINITY;
  let cycles = 0;
  let stopped: ConnectDriftWatchStopReason = 'max-cycles';
  let report: ConnectDriftReport | undefined;
  let errorMessage: string | undefined;

  for (let cycle = 1; cycle <= totalPlanned; cycle += 1) {
    if (signal?.aborted) {
      stopped = 'aborted';
      break;
    }
    cycles = cycle;
    try {
      const found = detectLegacyDrift(options.root, options.sources === undefined ? {} : { sources: options.sources });
      if (found !== null && found.drifted) {
        report = found;
        if (options.writeReport !== false) writeDriftReport(options.root, found);
        options.onDetect?.(found);
        stopped = 'drift';
        break;
      }
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
      stopped = 'error';
      break;
    }
    if (signal?.aborted) {
      stopped = 'aborted';
      break;
    }
    if (cycle >= totalPlanned) {
      stopped = 'max-cycles';
      break;
    }
    await sleep(intervalMs, signal);
  }

  return {
    schema: CONNECT_DRIFT_WATCH_SCHEMA,
    root: options.root,
    intervalMs,
    ...(maxCycles === undefined ? {} : { maxCycles }),
    cycles,
    stopped,
    ...(report === undefined ? {} : { report }),
    ...(errorMessage === undefined ? {} : { error: errorMessage }),
  };
}
