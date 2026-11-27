import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { withFileLockSync } from '../core/lock.ts';
import type { AuditFinding, AuditScope } from './types.ts';
import { sortFindings } from './util.ts';

export const FINDINGS_SCHEMA = 'ano.audit.findings.v1' as const;

const storedFindingSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  scope: z.enum(['drift', 'security', 'license', 'governance', 'deps']),
  rule: z.string().min(1).max(200),
  severity: z.enum(['high', 'medium', 'low', 'info']),
  message: z.string().min(1).max(2000),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  path: z.string().min(1).max(1024).optional(),
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
  status: z.enum(['open', 'resolved']),
  firstSeen: z.string().datetime(),
  lastSeen: z.string().datetime(),
}).strict();

const storeSchema = z.object({
  schema: z.literal(FINDINGS_SCHEMA),
  updatedAt: z.string().datetime(),
  findings: z.array(storedFindingSchema),
}).strict();

export type StoredFinding = z.infer<typeof storedFindingSchema>;
export interface FindingStoreState { schema: typeof FINDINGS_SCHEMA; updatedAt: string; findings: StoredFinding[] }

export function findingStorePath(root: string): string {
  return join(root, '.ano', 'audit', 'findings.json');
}

export interface FindingStoreRead {
  findings: StoredFinding[];
  degraded: string[];
  corrupt: boolean;
}

export function readFindingStore(root: string): FindingStoreRead {
  const path = findingStorePath(root);
  if (!existsSync(path)) return { findings: [], degraded: [], corrupt: false };
  try {
    const parsed = storeSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    if (!parsed.success) return { findings: [], degraded: ['findings-store-invalid'], corrupt: true };
    return { findings: parsed.data.findings, degraded: [], corrupt: false };
  } catch {
    return { findings: [], degraded: ['findings-store-unreadable'], corrupt: true };
  }
}

function writeFindingStore(root: string, findings: StoredFinding[], now: string): void {
  const path = findingStorePath(root);
  mkdirSync(dirname(path), { recursive: true });
  const state: FindingStoreState = {
    schema: FINDINGS_SCHEMA,
    updatedAt: now,
    findings: [...findings].sort((a, b) => a.id.localeCompare(b.id)),
  };
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', 'utf8');
  renameSync(temporary, path);
}

function toFinding(stored: StoredFinding, reopened: boolean): AuditFinding {
  const finding: AuditFinding = {
    id: stored.id,
    scope: stored.scope,
    rule: stored.rule,
    severity: stored.severity,
    message: stored.message,
    fingerprint: stored.fingerprint,
    status: stored.status,
    firstSeen: stored.firstSeen,
    lastSeen: stored.lastSeen,
  };
  if (stored.path !== undefined) finding.path = stored.path;
  if (stored.line !== undefined) finding.line = stored.line;
  if (stored.column !== undefined) finding.column = stored.column;
  if (reopened) finding.reopened = true;
  return finding;
}

export interface MergeOptions {
  scope: AuditScope;
  now: string;
  /** Auto-resolve previously open findings of this scope that the complete scan no longer sees. */
  autoResolve: boolean;
  persist: boolean;
}

/**
 * Merges a scan into the local finding store. A finding that was resolved and
 * appears again is reopened with the same identity; a complete scan that no
 * longer sees an open finding marks it resolved (not deleted), so history is
 * kept and a later regression becomes an explicit reopen.
 */
export function mergeFindings(root: string, incoming: readonly AuditFinding[], options: MergeOptions): { findings: AuditFinding[]; outstanding: AuditFinding[]; degraded: string[] } {
  const lock = join(root, '.ano', 'audit', '.findings.lock');
  const operation = (): { findings: AuditFinding[]; outstanding: AuditFinding[]; degraded: string[] } => {
    const state = readFindingStore(root);
    const degraded = [...state.degraded];
    const previous = new Map(state.findings.filter((finding) => finding.scope === options.scope).map((finding) => [finding.id, finding]));
    const seen = new Set<string>();
    const merged: AuditFinding[] = [];
    for (const finding of sortFindings([...incoming])) {
      seen.add(finding.id);
      const prior = previous.get(finding.id);
      const reopened = prior?.status === 'resolved';
      merged.push(toFinding({
        id: finding.id,
        scope: finding.scope,
        rule: finding.rule,
        severity: finding.severity,
        message: finding.message,
        fingerprint: finding.fingerprint,
        ...(finding.path !== undefined ? { path: finding.path } : {}),
        ...(finding.line !== undefined ? { line: finding.line } : {}),
        ...(finding.column !== undefined ? { column: finding.column } : {}),
        status: 'open',
        firstSeen: prior?.firstSeen ?? options.now,
        lastSeen: options.now,
      }, reopened));
    }
    const next: StoredFinding[] = [];
    for (const stored of state.findings) {
      if (stored.scope !== options.scope) { next.push(stored); continue; }
      if (seen.has(stored.id)) {
        const finding = merged.find((candidate) => candidate.id === stored.id);
        if (!finding) continue;
        next.push({
          ...stored,
          severity: finding.severity,
          message: finding.message,
          fingerprint: finding.fingerprint,
          ...(finding.path !== undefined ? { path: finding.path } : {}),
          ...(finding.line !== undefined ? { line: finding.line } : {}),
          ...(finding.column !== undefined ? { column: finding.column } : {}),
          status: 'open',
          lastSeen: options.now,
        });
      } else {
        next.push({ ...stored, status: options.autoResolve ? 'resolved' : stored.status, lastSeen: options.now });
      }
    }
    for (const finding of merged) {
      if (next.some((stored) => stored.id === finding.id)) continue;
      next.push({
        id: finding.id,
        scope: finding.scope,
        rule: finding.rule,
        severity: finding.severity,
        message: finding.message,
        fingerprint: finding.fingerprint,
        ...(finding.path !== undefined ? { path: finding.path } : {}),
        ...(finding.line !== undefined ? { line: finding.line } : {}),
        ...(finding.column !== undefined ? { column: finding.column } : {}),
        status: 'open',
        firstSeen: finding.firstSeen ?? options.now,
        lastSeen: options.now,
      });
    }
    if (options.persist && !state.corrupt) {
      try { writeFindingStore(root, next, options.now); }
      catch (error) {
        const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'UNKNOWN';
        degraded.push(`findings-store-write-failed:${code}`);
      }
    } else if (state.corrupt) {
      degraded.push('findings-store-left-unmodified');
    }
    // Whatever remains open for this scope after the merge is what a caller
    // must treat as unresolved, including findings that were not re-observed
    // because the scan was degraded (autoResolve=false).
    const outstanding = next
      .filter((stored) => stored.scope === options.scope && stored.status === 'open')
      .map((stored) => toFinding(stored, false));
    return { findings: merged, outstanding, degraded: [...new Set(degraded)].sort() };
  };
  if (!options.persist) return operation();
  return withFileLockSync(lock, operation);
}

export function resolveFinding(root: string, id: string, now = new Date().toISOString()): StoredFinding {
  return withFileLockSync(join(root, '.ano', 'audit', '.findings.lock'), () => {
    const state = readFindingStore(root);
    if (state.corrupt) throw new Error('Finding store is corrupt; refusing to modify it');
    const finding = state.findings.find((candidate) => candidate.id === id);
    if (!finding) throw new Error(`Unknown finding: ${id}`);
    const resolved: StoredFinding = { ...finding, status: 'resolved', lastSeen: now };
    const next = state.findings.map((candidate) => candidate.id === id ? resolved : candidate);
    writeFindingStore(root, next, now);
    return resolved;
  });
}

export function listFindings(root: string): StoredFinding[] {
  return readFindingStore(root).findings;
}

/** Open findings actually present in the persisted store for one scope. */
export function openFindings(root: string, scope: AuditScope): AuditFinding[] {
  return readFindingStore(root).findings
    .filter((finding) => finding.scope === scope && finding.status === 'open')
    .map((finding) => toFinding(finding, false));
}
