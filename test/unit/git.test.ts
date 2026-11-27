import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gitTouchedFiles } from '../../src/core/git.ts';

test('Git diff includes modified and untracked files regardless of declarations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ano git 中文 '));
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  for (const args of [['config', 'user.email', 'test@localhost'], ['config', 'user.name', 'ANO Test'], ['config', 'core.autocrlf', 'false']]) assert.equal(spawnSync('git', ['-C', root, ...args]).status, 0);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  assert.equal(spawnSync('git', ['-C', root, 'add', 'src/a.ts']).status, 0);
  assert.equal(spawnSync('git', ['-C', root, 'commit', '-qm', 'fixture baseline']).status, 0);
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 2;\n');
  await writeFile(join(root, 'src', '新增.ts'), 'export const b = 1;\n');
  await mkdir(join(root, '.ano'), { recursive: true });
  await writeFile(join(root, '.ano', 'local.json'), 'ledger');
  assert.deepEqual(await gitTouchedFiles(root), ['src/a.ts', 'src/新增.ts']);
});
