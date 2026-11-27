/**
 * T-153 shard F: `src/core/git.ts` (normalizeTouched) and `src/core/hlc.ts`
 * (textOrder/comparison tie-break) completion tests.
 *
 * Real temporary trees only; no error mocks.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeTouched, gitTouchedFiles } from '../../src/core/git.ts';
import { compareHlc, Hlc, type HlcTimestamp } from '../../src/core/hlc.ts';
import { m18fInitGit, m18fRemove, m18fTempDir, m18fWrite } from '../helpers/m18-f-fixtures.ts';

test('normalizeTouched dedupes, sorts and accepts relative/absolute/colon inputs', async () => {
  const root = await m18fTempDir('ano m18f git ');
  try {
    const absoluteInsideRoot = `${root}/src/abs.ts`;
    const result = normalizeTouched(root, [
      'src/b.ts',
      'src/a.ts',
      'src/a.ts',
      './src/c.ts',
      absoluteInsideRoot,
      'src/weird:name.ts',
    ]);
    assert.deepEqual(result, ['src/a.ts', 'src/abs.ts', 'src/b.ts', 'src/c.ts', 'src/weird:name.ts']);
  } finally {
    await m18fRemove(root);
  }
});

test('normalizeTouched fails closed on traversal outside the project root', async () => {
  const root = await m18fTempDir('ano m18f git bad ');
  try {
    assert.throws(
      () => normalizeTouched(root, ['../outside.ts']),
      /Expected a normalized relative project path/u,
    );
    assert.throws(() => normalizeTouched(root, ['/etc/passwd']), /Expected a normalized relative project path/u);
  } finally {
    await m18fRemove(root);
  }
});

test('gitTouchedFiles output normalizes back into project-relative paths', async () => {
  const root = await m18fTempDir('ano m18f gitreal ');
  try {
    const { spawnSync } = await import('node:child_process');
    await m18fInitGit(root);
    await m18fWrite(root, 'src/a.ts', 'export const a = 1;\n');
    assert.equal(spawnSync('git', ['-C', root, 'add', '.']).status, 0);
    assert.equal(spawnSync('git', ['-C', root, 'commit', '-qm', 'baseline']).status, 0);

    await m18fWrite(root, 'src/a.ts', 'export const a = 2;\n');
    await m18fWrite(root, 'src/新增.ts', 'export const b = 1;\n');
    await m18fWrite(root, '.ano/local.json', '{}');

    const touched = await gitTouchedFiles(root);
    assert.deepEqual(touched, ['src/a.ts', 'src/新增.ts'], '.ano is excluded by the porcelain filter');
    assert.deepEqual(normalizeTouched(root, touched), touched);
  } finally {
    await m18fRemove(root);
  }
});

test('compareHlc breaks physical/logical ties by actor name deterministically', () => {
  const left: HlcTimestamp = { physical: 1_000, logical: 2, actor: 'a' };
  const right: HlcTimestamp = { physical: 1_000, logical: 2, actor: 'b' };
  assert.equal(compareHlc(left, right), -1);
  assert.equal(compareHlc(right, left), 1);
  assert.equal(compareHlc(left, { ...left }), 0);

  // Physical time still dominates the actor tie-break.
  assert.equal(compareHlc({ physical: 1_001, logical: 0, actor: 'z' }, left), 1);
  assert.equal(compareHlc({ physical: 999, logical: 9, actor: 'z' }, left), -1);
  // Logical part dominates the actor tie-break when physical ties.
  assert.equal(compareHlc({ physical: 1_000, logical: 3, actor: 'z' }, left), 1);
});

test('Hlc receive reaches the future-physical reset arm', () => {
  const clock = new Hlc('local');
  clock.tick(1_000);
  const received = clock.receive({ physical: 500, logical: 9, actor: 'remote' }, 2_000);
  assert.deepEqual(received, { physical: 2_000, logical: 0, actor: 'local' });
});

test('rename/copy porcelain records are attributed to the new path only', async () => {
  const root = await m18fTempDir('ano m18f rename ');
  try {
    const { spawnSync } = await import('node:child_process');
    await m18fInitGit(root);
    await m18fWrite(root, 'a.txt', 'a\n');
    assert.equal(spawnSync('git', ['-C', root, 'add', '.']).status, 0);
    assert.equal(spawnSync('git', ['-C', root, 'commit', '-qm', 'baseline']).status, 0);
    assert.equal(spawnSync('git', ['-C', root, 'mv', 'a.txt', 'b.txt']).status, 0);

    assert.deepEqual(await gitTouchedFiles(root), ['b.txt']);
  } finally {
    await m18fRemove(root);
  }
});

test('Hlc tick advances the logical counter on equal and backwards samples', () => {
  const clock = new Hlc('local');
  assert.deepEqual(clock.tick(1_000), { physical: 1_000, logical: 0, actor: 'local' });
  assert.deepEqual(clock.tick(1_000), { physical: 1_000, logical: 1, actor: 'local' });
  assert.deepEqual(clock.tick(500), { physical: 1_000, logical: 2, actor: 'local' });
  assert.deepEqual(clock.tick(1_500), { physical: 1_500, logical: 0, actor: 'local' });
});
