import assert from 'node:assert/strict';
import test from 'node:test';
import type { SourceFingerprint } from '../../src/core/fingerprint.ts';
import { sourceDrift, sourceFreshness } from '../../src/gate/verify.ts';
import { emptyCaveats, type GraphSnapshot } from '../../src/structure/types.ts';

const before: SourceFingerprint = {
  hash: 'a'.repeat(64),
  files: [
    { path: 'src/app.ts', hash: '1'.repeat(64), size: 1 },
    { path: 'src/old.py', hash: '2'.repeat(64), size: 1 },
  ],
  degraded: [],
  status: 'ok',
};

const after: SourceFingerprint = {
  hash: 'b'.repeat(64),
  files: [
    { path: 'src/app.ts', hash: '3'.repeat(64), size: 1 },
    { path: 'src/new.py', hash: '4'.repeat(64), size: 1 },
    { path: 'output.txt', hash: '5'.repeat(64), size: 1 },
  ],
  degraded: [{ path: 'src/bad.py', code: 'too-large' }],
  status: 'degraded',
  reason: 'scan failed',
};

test('source drift includes changed, new Python and degraded scan entries', () => {
  assert.deepEqual(sourceDrift(before, after, ['.ts']), ['[source scan degraded]', 'src/app.ts', 'src/bad.py', 'src/new.py', 'src/old.py']);
});

test('graph freshness preserves degraded scan reasons and entry codes', () => {
  const snapshot: GraphSnapshot = {
    revision: 'revision-1',
    sourceFingerprint: before.hash,
    files: {},
    symbols: [],
    edges: [],
    caveats: emptyCaveats(),
  };
  assert.deepEqual(sourceFreshness(snapshot, after, ['.ts']), {
    status: 'degraded',
    stale: 0,
    reasons: ['scan failed', 'src/bad.py:too-large'],
  });
  const { status: _status, reason: _reason, ...withoutStatus } = after;
  assert.deepEqual(sourceFreshness(snapshot, { ...withoutStatus, degraded: [] }, ['.ts']), {
    status: 'degraded',
    stale: 0,
    reasons: ['source-scan-incomplete'],
  });
});
