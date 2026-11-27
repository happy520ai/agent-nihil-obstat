import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AuditAnchor, AuditEntry, AuditFinding, AuditLedgerView } from './types.ts';
import { assertSafeRelativePath, makeFinding, sha256, sortFindings } from './util.ts';

function entryValues(value: unknown, into: string[]): void {
  if (typeof value === 'string') { into.push(value); return; }
  if (Array.isArray(value)) { for (const item of value) entryValues(item, into); return; }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) entryValues(item, into);
  }
}

function normalizeEntry(raw: string): string | undefined {
  if (raw.includes('*')) return undefined;
  const trimmed = raw.replace(/^\.\//, '');
  if (!trimmed || trimmed.startsWith('../') || trimmed.startsWith('/')) return undefined;
  try { return assertSafeRelativePath(trimmed); } catch { return undefined; }
}

export function packageEntries(manifest: Record<string, unknown>): AuditEntry[] {
  const values: string[] = [];
  for (const field of ['main', 'module', 'types', 'typings', 'browser']) entryValues(manifest[field], values);
  entryValues(manifest.bin, values);
  entryValues(manifest.exports, values);
  const entries = new Map<string, string>();
  for (const value of values) {
    const path = normalizeEntry(value);
    if (path) entries.set(path, 'package.json');
  }
  return [...entries.entries()].map(([path, label]) => ({ path, label })).sort((a, b) => a.path.localeCompare(b.path));
}

async function exists(root: string, path: string): Promise<boolean> {
  try { return (await stat(join(root, ...path.split('/')))).isFile(); }
  catch { return false; }
}

export interface DriftScanResult {
  findings: AuditFinding[];
  tasks: number;
  anchors: number;
  entries: number;
  degraded: string[];
  caveats: string[];
}

/** Registered entry points, anchors and task files must still exist on disk. */
export async function scanDrift(
  root: string,
  options: { ledger?: AuditLedgerView; anchors?: AuditAnchor[]; entries?: AuditEntry[] } = {},
): Promise<DriftScanResult> {
  const degraded: string[] = [];
  const caveats: string[] = [];
  const findings: AuditFinding[] = [];
  const anchors = options.anchors ?? [];

  let entries = options.entries;
  if (!entries) {
    try {
      const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
      entries = packageEntries(manifest);
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'UNKNOWN';
      degraded.push(`package-json-unreadable:${code}`);
      entries = [];
    }
  }

  for (const entry of entries) {
    let path: string;
    try { path = assertSafeRelativePath(entry.path); }
    catch { degraded.push(`entry-path-invalid:${entry.label}`); continue; }
    if (!(await exists(root, path))) {
      findings.push(makeFinding({
        scope: 'drift',
        rule: 'drift/entry-missing',
        severity: 'medium',
        message: `Registered package entry is missing: ${entry.label}`,
        fingerprint: sha256(`entry-missing:${path}`),
        path,
      }));
    }
  }

  for (const anchor of anchors) {
    let path: string;
    try { path = assertSafeRelativePath(anchor.file); }
    catch {
      degraded.push(`anchor-path-invalid:${anchor.file.slice(0, 120)}`);
      continue;
    }
    if (!(await exists(root, path))) {
      findings.push(makeFinding({
        scope: 'drift',
        rule: 'drift/anchor-file-missing',
        severity: 'high',
        message: `Anchor file is missing${anchor.symbol ? ` for symbol ${anchor.symbol.slice(0, 120)}` : ''}`,
        fingerprint: sha256(`anchor-missing:${path}:${anchor.symbol ?? ''}`),
        path,
      }));
    }
    if (anchor.contentFragmentHash) caveats.push('anchor-content-fragment-hash-not-recomputed');
  }

  let tasks = 0;
  if (options.ledger) {
    for (const task of options.ledger.getTasks()) {
      if (task.status === 'cancelled') continue;
      tasks += 1;
      for (const file of task.declaredFiles) {
        let path: string;
        try { path = assertSafeRelativePath(file); }
        catch {
          degraded.push(`task-path-invalid:${task.id}`);
          continue;
        }
        if (await exists(root, path)) continue;
        findings.push(makeFinding({
          scope: 'drift',
          rule: 'drift/task-file-missing',
          severity: 'high',
          message: `Task ${task.id} declares a file that no longer exists`,
          fingerprint: sha256(`task-missing:${task.id}:${path}`),
          path,
        }));
      }
    }
  } else {
    degraded.push('ledger-not-injected');
  }

  return {
    findings: sortFindings(findings),
    tasks,
    anchors: anchors.length,
    entries: entries.length,
    degraded: [...new Set(degraded)].sort(),
    caveats: [...new Set(caveats)].sort(),
  };
}
