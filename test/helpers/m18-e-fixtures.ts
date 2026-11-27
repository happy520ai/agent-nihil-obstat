import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SourceFile, SymbolNode } from '../../src/structure/types.ts';

/** Materialise a temporary project tree; callers own cleanup. */
export async function writeM18EFixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ano m18e '));
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, ...path.split('/'));
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  return root;
}

export function m18eFileEntry(path: string, dynamicLoads = 0): SourceFile {
  return { path, hash: `${path.length}${'0'.repeat(63)}`, dynamicLoads };
}

export function m18eSymbol(id: string, file: string, name: string, startLine = 1): SymbolNode {
  return { id, file, name, qualifiedName: name, symbolKind: 'value', startLine };
}

/** Minimal git/pm scaffold so `resolveProjectScan` accepts a temp root. */
export const M18E_BASE_FILES: Record<string, string> = {
  '.git/HEAD': 'ref: refs/heads/main\n',
  '.pm/project.json': JSON.stringify({ name: 'm18e-fixture' }),
  'package.json': JSON.stringify({ name: 'm18e-fixture', private: true }),
};
