import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { assertProjectPath } from './paths.ts';

const executeFile = promisify(execFile);

export async function gitTouchedFiles(root: string): Promise<string[]> {
  const result = await executeFile('git', ['-C', root, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 });
  const bytes = result.stdout;
  const entries: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0) {
      entries.push(bytes.subarray(start, index));
      start = index + 1;
    }
  }
  const touched = new Set<string>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!.toString('utf8');
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (code.startsWith('R') || code.startsWith('C')) index += 1;
    const normalized = path.replaceAll('\\', '/');
    assertProjectPath(normalized);
    if (!normalized.startsWith('.ano/') && !normalized.startsWith('.pm/') && !normalized.startsWith('node_modules/') && !normalized.startsWith('dist/')) touched.add(normalized);
  }
  return [...touched].sort();
}

export function normalizeTouched(root: string, files: Iterable<string>): string[] {
  const result = new Set<string>();
  for (const file of files) {
    const path = file.includes(':') || file.startsWith('/') || file.startsWith('\\') ? resolve(root, file) : resolve(root, file);
    const relative = path.slice(resolve(root).length).replaceAll('\\', '/').replace(/^\//, '');
    assertProjectPath(relative);
    result.add(relative);
  }
  return [...result].sort();
}
