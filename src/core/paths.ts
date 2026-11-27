import { relative, sep } from 'node:path';

export function projectPath(root: string, absolutePath: string): string {
  const path = relative(root, absolutePath);
  if (path.startsWith('..') || path === '') throw new Error(`Path is outside project root: ${absolutePath}`);
  return path.split(sep).join('/');
}

export function assertProjectPath(path: string): void {
  if (path.length === 0 || path.includes('\\') || path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.split('/').includes('..')) {
    throw new Error(`Expected a normalized relative project path: ${path}`);
  }
}
