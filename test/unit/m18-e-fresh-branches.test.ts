import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { checkGraphFreshness, isGraphFresh, recheckManifestContent, type SourceMetadata } from '../../src/structure/fresh.ts';
import { emptyCaveats, type GraphSnapshot } from '../../src/structure/types.ts';
import { M18E_BASE_FILES, m18eFileEntry, writeM18EFixture } from '../helpers/m18-e-fixtures.ts';

test('a fingerprint walk that hits an unclassified error degrades instead of throwing', async () => {
  const root = await writeM18EFixture({
    ...M18E_BASE_FILES,
    'tsconfig.json': JSON.stringify({ compilerOptions: {} }),
    'src/main.ts': 'export const m = 1;\n',
  });
  try {
    // A file used as a scan root makes readdir fail with ENOTDIR, which is not in
    // the known permission/busy vocabulary and therefore reaches the degrade seam.
    const fileRoot = join(root, 'src', 'main.ts');
    const snapshot: GraphSnapshot = {
      revision: 'rev-fresh-probe',
      sourceFingerprint: 'f'.repeat(64),
      files: { 'src/main.ts': m18eFileEntry('src/main.ts') },
      symbols: [],
      edges: [],
      calls: [],
      caveats: emptyCaveats(),
    };

    const check = await checkGraphFreshness(root, snapshot, {
      sourceRoots: [fileRoot],
      excludes: () => false,
    });

    assert.equal(check.freshness.status, 'degraded');
    assert.ok(check.degradedReasons.includes('fingerprint-degraded:src/main.ts:ENOTDIR'));
    assert.equal(check.cache, 'miss');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('manifest content recheck falls back to disk reads for suspicious metadata and fails closed', async () => {
  const root = await writeM18EFixture({
    'src/a.ts': 'export const a = 1;\n',
  });
  try {
    const absolute = join(root, 'src', 'a.ts');
    const stats = await stat(absolute);
    const hash = createHash('sha256').update(await readFile(absolute, 'utf8')).digest('hex');
    const metadata: SourceMetadata = {
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      ino: String(stats.ino),
      ctimeMs: stats.ctimeMs,
      hash,
    };
    const current = new Map([['src/a.ts', metadata]]);
    const expected = new Map([['src/a.ts', { ...metadata }]]);
    // Every file is newer than the manifest instant, so the fast path must read it.
    const builtAt = Date.now() - 1_000;

    assert.equal(await recheckManifestContent(root, current, expected, builtAt), true, 'matching content verifies');

    const legacyExpected = new Map([['src/a.ts', { ...metadata, hash: '' }]]);
    assert.equal(
      await recheckManifestContent(root, current, legacyExpected, builtAt),
      false,
      'a missing stored digest fails closed',
    );

    assert.equal(
      await recheckManifestContent(root, current, expected, builtAt, async () => {
        throw new Error('read failed');
      }),
      false,
      'an unreadable suspicious file fails closed',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('isGraphFresh accepts only exactly fresh evidence', () => {
  assert.equal(isGraphFresh({ status: 'fresh', stale: 0 }), true);
  assert.equal(isGraphFresh({ status: 'stale', stale: 2 }), false);
  assert.equal(isGraphFresh({ status: 'degraded', stale: 0, reasons: ['x'] }), false);
});
