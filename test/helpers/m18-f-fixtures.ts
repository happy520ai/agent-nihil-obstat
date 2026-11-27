/**
 * T-153 shard F fixtures: real temporary project trees for the small-module
 * completion tests. No error objects are mocked; every failure path here is
 * produced by a real filesystem condition (directory-named config, legacy
 * lockfile shape, file-as-root walk, ...).
 */

import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function m18fTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function m18fRemove(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}

export async function m18fWrite(root: string, relative: string, content: string | Buffer): Promise<string> {
  const target = join(root, ...relative.split('/'));
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, content);
  return target;
}

/** Minimal Git work tree stub: `resolveProjectScan` only lstat()s `.git`. */
export async function m18fRepo(): Promise<string> {
  const root = await m18fTempDir('ano m18f ');
  await mkdir(join(root, '.git'), { recursive: true });
  await mkdir(join(root, '.pm'), { recursive: true });
  return root;
}

export async function m18fPackage(directory: string, name?: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  const target = join(directory, 'package.json');
  await writeFile(target, JSON.stringify(name === undefined ? {} : { name }));
  return target;
}

/** Real `git init` tree, used by the git-touched normalization test. */
export async function m18fInitGit(root: string): Promise<void> {
  const init = spawnSync('git', ['init', '-q', root], { encoding: 'utf8' });
  if (init.status !== 0) throw new Error(`git init failed: ${String(init.stderr)}`);
  for (const args of [
    ['config', 'user.email', 'test@localhost'],
    ['config', 'user.name', 'ANO Test'],
    ['config', 'core.autocrlf', 'false'],
  ] as const) {
    const configured = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    if (configured.status !== 0) throw new Error(`git config failed: ${String(configured.stderr)}`);
  }
}
