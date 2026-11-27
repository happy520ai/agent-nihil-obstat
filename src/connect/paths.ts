import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { ConnectSourceError, ConnectStoreError } from './errors.ts';

/**
 * Resolve a user-supplied project root to a canonical absolute directory.
 * A symlinked root is followed once so `.ano` always lives on the real tree.
 */
export function resolveRoot(root: string): string {
  const absolute = resolve(root);
  let stats;
  try {
    stats = lstatSync(absolute);
  } catch {
    throw new ConnectSourceError(`Project root does not exist: ${absolute}`);
  }
  const canonical = stats.isSymbolicLink() ? safeRealpath(absolute) : absolute;
  assertRealDirectory(canonical, 'Project root');
  return canonical;
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    throw new ConnectSourceError(`Project root is a broken link: ${path}`);
  }
}

/** Refuse symlinks/junctions and non-directories. Missing paths are an error here. */
export function assertRealDirectory(dir: string, label: string): void {
  let stats;
  try {
    stats = lstatSync(dir);
  } catch {
    throw new ConnectSourceError(`${label} does not exist: ${dir}`);
  }
  if (stats.isSymbolicLink()) {
    throw new ConnectSourceError(`${label} is a symbolic link/junction and will not be followed: ${dir}`);
  }
  if (!stats.isDirectory()) {
    throw new ConnectSourceError(`${label} is not a directory: ${dir}`);
  }
}

/** Create a directory chain component by component, refusing to traverse a link. */
export function ensureSafeDirectory(dir: string): void {
  const resolved = resolve(dir);
  const parts = resolved.split(sep).filter((part) => part.length > 0);
  let current = resolved.startsWith(sep) ? sep : '';
  if (parts.length > 0 && /^[A-Za-z]:$/.test(parts[0] ?? '')) {
    current = `${parts[0] ?? ''}${sep}`;
    parts.shift();
  }
  for (const part of parts) {
    current = join(current, part);
    let stats;
    try {
      stats = lstatSync(current);
    } catch {
      // Missing: create exactly this component. Never use recursive mkdir here,
      // because an existing link component could otherwise be traversed.
      mkdirSync(current);
      stats = lstatSync(current);
    }
    if (stats.isSymbolicLink()) {
      throw new ConnectStoreError(`Refusing to write through a symbolic link/junction: ${current}`);
    }
    if (!stats.isDirectory()) {
      throw new ConnectStoreError(`Connect path is not a directory: ${current}`);
    }
  }
}

/** Validate every existing component of a directory without creating anything. */
export function assertSafeExistingDirectory(dir: string): void {
  const resolved = resolve(dir);
  const parts = resolved.split(sep).filter((part) => part.length > 0);
  let current = resolved.startsWith(sep) ? sep : '';
  if (parts.length > 0 && /^[A-Za-z]:$/.test(parts[0] ?? '')) {
    current = `${parts[0] ?? ''}${sep}`;
    parts.shift();
  }
  for (const part of parts) {
    current = join(current, part);
    let stats;
    try {
      stats = lstatSync(current);
    } catch {
      throw new ConnectStoreError(`Connect store directory is missing: ${current}`);
    }
    if (stats.isSymbolicLink()) {
      throw new ConnectStoreError(`Refusing to read through a symbolic link/junction: ${current}`);
    }
    if (!stats.isDirectory()) {
      throw new ConnectStoreError(`Connect store path is not a directory: ${current}`);
    }
  }
}

/** Validate a normalized relative project path (no traversal, no absolute paths). */
export function assertSafeRelative(path: string): string {
  if (path.length === 0) throw new ConnectSourceError('Empty relative path is not allowed');
  if (path.includes('\0')) throw new ConnectSourceError(`Path contains NUL: ${path}`);
  if (path.includes('\\')) throw new ConnectSourceError(`Path must use '/' separators: ${path}`);
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
    throw new ConnectSourceError(`Path must be relative: ${path}`);
  }
  if (path.split('/').includes('..')) {
    throw new ConnectSourceError(`Path traversal is not allowed: ${path}`);
  }
  return path;
}

/** Join and prove the result is still inside `dir`. */
export function safeChild(dir: string, ...parts: string[]): string {
  for (const part of parts) assertSafeRelative(part);
  const base = resolve(dir);
  const child = resolve(join(base, ...parts));
  if (child !== base && !child.startsWith(base + sep)) {
    throw new ConnectSourceError(`Path escapes the connect store: ${child}`);
  }
  return child;
}
