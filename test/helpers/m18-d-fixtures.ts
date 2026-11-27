import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Shared fixtures for the T153 shard-D coverage tests. */

export async function temp(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function write(root: string, path: string, source: string): Promise<void> {
  const target = join(root, ...path.split('/'));
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, source);
}

/** Best-effort recursive cleanup: Windows can hold a just-closed SQLite handle briefly. */
export async function cleanup(root: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

export function git(root: string, args: string[]): void {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
}

/** A real Git work tree with a Node package and one source file. */
export async function gitProject(manifest: Record<string, unknown> = { private: true, type: 'module' }): Promise<string> {
  const root = await temp('ano m18d ');
  await write(root, '.gitignore', '.ano/\n');
  await write(root, 'package.json', JSON.stringify(manifest));
  await write(root, 'src/alpha.ts', 'export const alpha = 1;\nexport function beta() { return alpha; }\n');
  await write(root, 'test/a.test.ts', "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('a', () => assert.equal(1, 1));\n");
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'ano@localhost'], ['config', 'user.name', 'ano'], ['add', '.'], ['commit', '-qm', 'base']]) {
    git(root, args);
  }
  return root;
}

export interface PmOptions {
  readonly name?: string;
  readonly tasks?: Array<Record<string, unknown>>;
  readonly extra?: Record<string, string>;
}

/** A pm-mcp shaped `.pm` root (no `.ano`, no Git required by itself). */
export async function pmRoot(options: PmOptions = {}): Promise<string> {
  const root = await temp('ano m18d pm ');
  await mkdir(join(root, '.pm'), { recursive: true });
  await writeFile(join(root, '.pm', 'project.json'), JSON.stringify({ name: options.name ?? 'Fixture Project', version: '0.1.0' }));
  await writeFile(join(root, '.pm', 'tasks.json'), JSON.stringify({
    tasks: options.tasks ?? [
      { id: 'T-001', title: 'First task', status: 'done' },
      { id: 'T-002', title: 'Second task', status: 'in_progress' },
    ],
  }));
  for (const [relative, content] of Object.entries(options.extra ?? {})) {
    await write(root, `.pm/${relative}`, content);
  }
  return root;
}

/** Corrupt `.ano/connect/current.json` so `connectionStatus` fails closed. */
export async function corruptConnectStore(root: string): Promise<void> {
  await write(root, '.ano/connect/current.json', JSON.stringify({ schema: 'not-the-current-schema' }));
}
