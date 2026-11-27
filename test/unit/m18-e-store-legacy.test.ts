import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GraphStore } from '../../src/structure/store.ts';

test('a legacy scan-free build degrades when the graph root disappears', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'ano m18e store '));
  const target = join(parent, 'real');
  try {
    await mkdir(join(target, 'src'), { recursive: true });
    await writeFile(join(target, 'package.json'), JSON.stringify({ name: 'legacy-fixture', private: true }));
    await writeFile(join(target, 'src', 'a.ts'), 'export const a = 1;\n');

    // Open through a junction, then remove only the junction. The cache lives in
    // the real directory, so the store still holds a database while its root is
    // gone and the next fingerprint walk must degrade rather than throw.
    const link = join(parent, 'link');
    await symlink(target, link, 'junction');
    const store = await GraphStore.open(link);
    try {
      await rm(link);
      const outcome = await store.ensureFresh();
      assert.equal(outcome.status, 'degraded');
      assert.ok(store.snapshot().caveats.degradedReasons.includes('fingerprint-degraded:.:ENOENT'));
    } finally {
      store.close();
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
