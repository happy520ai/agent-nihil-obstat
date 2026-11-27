import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { AuditFinding, AuditSeverity, AuditSummary } from './types.ts';

export const DEFAULT_EXCLUDES = ['.git', '.ano', '.pm', 'node_modules', 'dist', 'coverage'];
export const MAX_SCAN_BYTES = 4 * 1024 * 1024;

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.pdf', '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.wasm', '.class', '.jar', '.o', '.a', '.obj', '.lib', '.pdb',
  '.mp3', '.mp4', '.mov', '.avi', '.webm', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.db', '.sqlite', '.sqlite3',
]);

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function normalizeRelativePath(path: string): string {
  return path.split(sep).join('/').replace(/\\/g, '/');
}

/** Rejects absolute, drive-letter, traversal and empty project paths. */
export function assertSafeRelativePath(path: string): string {
  const normalized = normalizeRelativePath(path);
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.split('/').includes('..')) {
    throw new Error(`Expected a relative project path inside the project: ${path}`);
  }
  return normalized;
}

export function isExcludedPath(path: string): boolean {
  return normalizeRelativePath(path).split('/').some((part) => DEFAULT_EXCLUDES.includes(part));
}

export function isProbablyText(path: string): boolean {
  const lower = path.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return true;
  return !BINARY_EXTENSIONS.has(lower.slice(dot));
}

export interface ProjectFile {
  path: string;
  absolute: string;
}

/** Deterministic, non-following walk that skips caches, VCS metadata and dependencies. */
export async function listProjectFiles(root: string, options: { onError?: (path: string, error: unknown) => void } = {}): Promise<ProjectFile[]> {
  const files: ProjectFile[] = [];
  async function walk(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      options.onError?.(normalizeRelativePath(relative(root, directory)) || '.', error);
      return;
    }
    entries.sort((a, b) => Buffer.from(a.name).compare(Buffer.from(b.name)));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const path = normalizeRelativePath(relative(root, absolute));
      if (isExcludedPath(path)) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { await walk(absolute); continue; }
      if (!entry.isFile()) continue;
      files.push({ path, absolute });
    }
  }
  await walk(root);
  files.sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)));
  return files;
}

export interface TextReadResult {
  text?: string;
  degraded?: string;
}

/** Reads a text file with a hard size cap and a NUL-byte binary check. */
export async function readTextFile(file: ProjectFile): Promise<TextReadResult> {
  if (!isProbablyText(file.path)) return {};
  try {
    const info = await stat(file.absolute);
    if (!info.isFile()) return { degraded: `not-regular:${file.path}` };
    if (info.size > MAX_SCAN_BYTES) return { degraded: `file-too-large:${file.path}` };
    const bytes = await readFile(file.absolute);
    if (bytes.includes(0)) return {};
    return { text: bytes.toString('utf8') };
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'UNKNOWN';
    return { degraded: `read-error:${file.path}:${code}` };
  }
}

/** 1-based line/column of a byte/character offset in a text buffer. */
export function locate(text: string, index: number): { line: number; column: number } {
  let line = 1;
  let lastNewline = -1;
  for (let cursor = 0; cursor < index && cursor < text.length; cursor += 1) {
    if (text.charCodeAt(cursor) === 10) { line += 1; lastNewline = cursor; }
  }
  return { line, column: index - lastNewline };
}

export function findingId(scope: AuditFinding['scope'], rule: string, fingerprint: string, path: string | undefined, line: number | undefined, column: number | undefined): string {
  return sha256([scope, rule, fingerprint, path ?? '', line ?? 0, column ?? 0].join('\0'));
}

export function makeFinding(input: {
  scope: AuditFinding['scope'];
  rule: string;
  severity: AuditSeverity;
  message: string;
  fingerprint: string;
  path?: string;
  line?: number;
  column?: number;
}): AuditFinding {
  const finding: AuditFinding = {
    id: findingId(input.scope, input.rule, input.fingerprint, input.path, input.line, input.column),
    scope: input.scope,
    rule: input.rule,
    severity: input.severity,
    message: input.message,
    fingerprint: input.fingerprint,
    status: 'open',
  };
  if (input.path !== undefined) finding.path = input.path;
  if (input.line !== undefined) finding.line = input.line;
  if (input.column !== undefined) finding.column = input.column;
  return finding;
}

export function summarize(findings: readonly Pick<AuditFinding, 'severity'>[]): AuditSummary {
  const summary: AuditSummary = { high: 0, medium: 0, low: 0, info: 0, total: findings.length };
  for (const finding of findings) summary[finding.severity] += 1;
  return summary;
}

export function sortFindings(findings: AuditFinding[]): AuditFinding[] {
  return findings.sort((a, b) => Buffer.from(`${a.path ?? ''}\0${String(a.line ?? 0).padStart(9, '0')}\0${a.scope}\0${a.rule}\0${a.fingerprint}`)
    .compare(Buffer.from(`${b.path ?? ''}\0${String(b.line ?? 0).padStart(9, '0')}\0${b.scope}\0${b.rule}\0${b.fingerprint}`)));
}

export function uniqStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
