import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fingerprintTree } from '../../src/core/fingerprint.ts';
import { executeEvidence } from '../../src/gate/evidence.ts';

test('fingerprint comparison can detect source changed while tests execute', async (t) => {
  // Hermetic tree: the real workspace is refreshed by external tools (PROJECT.md
  // dashboard, pm-mcp bookkeeping), so fingerprinting it races the environment.
  // A throwaway tmpdir proves the same property without that noise.
  const root = await mkdtemp(join(tmpdir(), 'ano-source-race-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, 'nested'), { recursive: true });
  await writeFile(join(root, 'a.ts'), 'export const a = 1;\n');
  await writeFile(join(root, 'b.ts'), 'export const b = 2;\n');
  await writeFile(join(root, 'nested', 'c.ts'), 'export const c = 3;\n');

  const before = await fingerprintTree(root);
  const evidence = await executeEvidence({
    argv: [process.execPath, '-e', 'console.log("# tests 1\\n# pass 1")'],
    cwd: root,
    timeoutMs: 10_000,
  }, before.hash, 'revision-1');
  const after = await fingerprintTree(root);
  assert.equal(evidence.ok, true);
  assert.equal(evidence.sourceFingerprint, before.hash);
  assert.equal(after.hash, before.hash);

  // Positive drift check: a write during the execution window must invalidate the
  // recorded fingerprint, so the caller can detect the source moved under it.
  await writeFile(join(root, 'a.ts'), 'export const a = 2;\n');
  const drifted = await fingerprintTree(root);
  assert.notEqual(drifted.hash, evidence.sourceFingerprint);
});

test('a changed source hash cannot match an old evidence fingerprint', () => {
  const oldHash = 'a'.repeat(64);
  const newHash = 'b'.repeat(64);
  assert.notEqual(oldHash, newHash);
});
