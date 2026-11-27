/**
 * T-153 shard F: `src/core/project-scan.ts` completion tests.
 *
 * Covers the real uncalled exports (`scanBudgetRemainingMs`,
 * `scanBudgetStatus`, plus the error-message helper through a real EISDIR
 * filesystem condition), the glob compiler's `**`/`?`/`dir/**` arms and real
 * temporary Git/PM trees. No dependency injection is used to fabricate errors;
 * every failure comes from an actual filesystem shape.
 */

import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import {
  ProjectScanError,
  assertValidGlob,
  createScanBudget,
  isExcluded,
  isSecretPath,
  matchesGlob,
  normalizeRelativePath,
  resolveProjectScan,
  scanBudgetExceeded,
  scanBudgetExhausted,
  scanBudgetRemainingMs,
  scanBudgetStatus,
  scanBudgetTimedOut,
  scanStatusForResult,
  shouldFollowLink,
  type ScanErrorCode,
} from '../../src/core/project-scan.ts';
import { m18fPackage, m18fRemove, m18fRepo, m18fTempDir, m18fWrite } from '../helpers/m18-f-fixtures.ts';

function assertCode(promise: Promise<unknown>, code: ScanErrorCode, pattern?: RegExp): Promise<void> {
  return assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ProjectScanError, `expected ProjectScanError, got ${String(error)}`);
    assert.equal(error.code, code);
    if (pattern !== undefined) assert.match(error.message, pattern);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Budget helpers
// ---------------------------------------------------------------------------

test('scanBudgetRemainingMs/scanBudgetStatus expose remaining time and status', () => {
  const budget = createScanBudget({ now: () => 1_000, timeoutMs: 500, maxFiles: 10 });
  assert.equal(budget.deadline, 1_500);
  assert.equal(scanBudgetRemainingMs(budget, 1_200), 300);
  assert.equal(scanBudgetRemainingMs(budget, 1_500), 0);
  assert.equal(scanBudgetRemainingMs(budget, 2_000), 0, 'remaining time clamps at zero');
  assert.equal(scanBudgetTimedOut(budget, 1_499), false);
  assert.equal(scanBudgetTimedOut(budget, 1_500), true);
  assert.equal(scanBudgetStatus(budget, 1_499), 'ok');
  assert.equal(scanBudgetStatus(budget, 1_500), 'timeout');
  assert.equal(scanBudgetExhausted(budget, 1_499), false);
  assert.equal(scanBudgetExhausted(budget, 1_500), true);

  budget.filesSeen = 10;
  assert.equal(scanBudgetExceeded(budget), true, 'file ceiling is honoured');
  budget.filesSeen = 9;
  assert.equal(scanBudgetExceeded(budget), false);

  const byteBudget = createScanBudget({ now: () => 0, maxFiles: 10, maxTotalBytes: 100 });
  assert.equal(scanBudgetExceeded(byteBudget), false);
  byteBudget.bytesSeen = 100;
  assert.equal(scanBudgetExceeded(byteBudget), true, 'byte ceiling is honoured');

  assert.equal(scanStatusForResult(budget, 0, 1_499), 'degraded', 'files=0 on a healthy budget is degraded');
  assert.equal(scanStatusForResult(byteBudget, 0, 0), 'timeout', 'exhausted budget is never ok');
});

test('scanStatusForResult reports ok only with files and a live budget', () => {
  const live = createScanBudget({ now: () => 0, timeoutMs: 1_000, maxFiles: 1 });
  assert.equal(scanStatusForResult(live, 1, 500), 'ok');
  const spent = createScanBudget({ now: () => 0, timeoutMs: 1_000, maxFiles: 1 });
  spent.filesSeen = 1;
  assert.equal(scanStatusForResult(spent, 5, 500), 'timeout');
});

// ---------------------------------------------------------------------------
// Glob compiler branches
// ---------------------------------------------------------------------------

test('glob compiler handles **, ?, dir/** and normalization edge cases', () => {
  assert.equal(normalizeRelativePath('./src/a/'), 'src/a');
  assert.equal(normalizeRelativePath('src\\a'), 'src/a');

  assert.equal(matchesGlob('**', 'anything/at/all.ts'), true);
  assert.equal(matchesGlob('a/**', 'a'), true, 'dir/** also matches the directory itself');
  assert.equal(matchesGlob('a/**', 'a/b/c'), true);
  assert.equal(matchesGlob('a/**', 'ab'), false);
  assert.equal(matchesGlob('?.ts', 'a.ts'), true);
  assert.equal(matchesGlob('?.ts', 'ab.ts'), false);
  assert.equal(matchesGlob('**/x/**', 'p/x/q.ts'), true);
  assert.equal(matchesGlob('src/**/*.test.ts', 'src/a/b.test.ts'), true);
  assert.equal(matchesGlob('src/*.test.ts', 'src/a/b.test.ts'), false);

  assert.equal(isExcluded('node_modules/pkg/index.js', ['**/node_modules/**']), true);
  assert.equal(isExcluded('src/index.ts', ['**/node_modules/**']), false);

  assert.equal(isSecretPath('.env'), true);
  assert.equal(isSecretPath('.env.local'), true);
  assert.equal(isSecretPath('id_rsa'), true);
  assert.equal(isSecretPath('keys/app.pem'), true);
  assert.equal(isSecretPath('credentials.json'), true);
  assert.equal(isSecretPath('secrets/notes.md'), true);
  assert.equal(isSecretPath('/'), false);
  assert.equal(shouldFollowLink('secrets/x', true), false, 'secret paths are never followed');
  assert.equal(shouldFollowLink('src/x', true), true);
  assert.equal(shouldFollowLink('src/x', false), false);
});

test('assertValidGlob rejects empty, NUL, backslash, absolute and traversal patterns', () => {
  for (const bad of ['', 'a\0b', 'a\\b', '/absolute/path', 'C:/drive/path', '../up', 'a/../b']) {
    assert.throws(() => assertValidGlob(bad), ProjectScanError, bad);
  }
  assert.doesNotThrow(() => assertValidGlob('src/**/*.ts'));
});

// ---------------------------------------------------------------------------
// Real filesystem boundaries
// ---------------------------------------------------------------------------

test('a directory named .ano/project.json surfaces a real EISDIR config failure', async () => {
  const root = await m18fRepo();
  try {
    await m18fPackage(root, 'app');
    await mkdir(join(root, '.ano', 'project.json'), { recursive: true });
    await assertCode(
      resolveProjectScan({ startRoot: root }),
      'CONFIG_INVALID',
      /Cannot read .*project\.json: .*EISDIR/u,
    );
  } finally {
    await m18fRemove(root);
  }
});

test('a non-object .pm/project.json is rejected by the JSON boundary', async () => {
  const root = await m18fRepo();
  try {
    await m18fPackage(root, 'app');
    await m18fWrite(root, '.pm/project.json', '[]');
    await assertCode(resolveProjectScan({ startRoot: root }), 'CONFIG_INVALID', /Expected a JSON object/u);
  } finally {
    await m18fRemove(root);
  }
});

test('requireGit=false in .ano/project.json allows a Git-root-free tree', async () => {
  const root = await m18fTempDir('ano m18f nogit ');
  try {
    await mkdir(join(root, '.pm'), { recursive: true });
    await m18fWrite(root, '.ano/project.json', JSON.stringify({ requireGit: false }));
    await m18fPackage(root, 'app');
    const resolved = await resolveProjectScan({ startRoot: root });
    assert.equal(resolved.gitRoot, root);
    assert.equal(resolved.pmRoot, root);
    assert.deepEqual(resolved.sourceRoots, [root]);
  } finally {
    await m18fRemove(root);
  }
});

test('discovery truncation and anonymous package names are observable', async () => {
  const root = await m18fRepo();
  try {
    await m18fPackage(root);
    await mkdir(join(root, 'sub', 'deep'), { recursive: true });
    const truncated = await resolveProjectScan({ startRoot: root, maxDiscoverDepth: 0 });
    assert.equal(truncated.discovery.truncated, true, 'depth 0 still reports unvisited directories');
    assert.deepEqual(truncated.sourceRoots, [root]);
    assert.equal(truncated.discovery.candidates[0]!.name, undefined, 'nameless package.json omits the field');

    const deeper = await resolveProjectScan({ startRoot: root, maxDiscoverDepth: 1 });
    assert.equal(deeper.discovery.truncated, true);
  } finally {
    await m18fRemove(root);
  }
});

test('option validation rejects negative, infinite and fractional numbers', async () => {
  const root = await m18fTempDir('ano m18f opts ');
  try {
    await assertCode(resolveProjectScan({ startRoot: root, maxFiles: -1 }), 'CONFIG_INVALID', /non-negative finite number/u);
    await assertCode(resolveProjectScan({ startRoot: root, timeoutMs: Number.POSITIVE_INFINITY }), 'CONFIG_INVALID', /non-negative finite number/u);
    await assertCode(resolveProjectScan({ startRoot: root, maxDiscoverDepth: 1.5 }), 'CONFIG_INVALID', /must be an integer/u);
    await assertCode(resolveProjectScan({ startRoot: root, deadline: Number.NaN }), 'CONFIG_INVALID', /finite number/u);
  } finally {
    await m18fRemove(root);
  }
});

test('explicit source roots must exist and be directories', async () => {
  const root = await m18fRepo();
  try {
    await m18fPackage(root, 'app');
    const file = await m18fWrite(root, 'plain.txt', 'x');
    await assertCode(
      resolveProjectScan({ startRoot: root, sourceRoots: [file] }),
      'CONFIG_INVALID',
      /Project root is not a directory/u,
    );
  } finally {
    await m18fRemove(root);
  }
});

test('a pmRoot without a .pm directory is rejected', async () => {
  const root = await m18fRepo();
  const other = await m18fTempDir('ano m18f pmbad ');
  try {
    await m18fPackage(root, 'app');
    await assertCode(
      resolveProjectScan({ startRoot: root, pmRoot: other }),
      'PM_ROOT_WITHOUT_PM',
      /no \.pm directory/u,
    );
  } finally {
    await m18fRemove(root);
    await m18fRemove(other);
  }
});

test('source roots carrying their own .pm directory are reported as ignored PM roots', async () => {
  const root = await m18fRepo();
  try {
    await m18fPackage(root, 'root-pkg');
    const server = join(root, 'server');
    await m18fPackage(server, 'server-pkg');
    await mkdir(join(server, '.pm'), { recursive: true });
    const resolved = await resolveProjectScan({ startRoot: root, sourceRoots: [server] });
    assert.deepEqual(resolved.sourceRoots, [server]);
    assert.deepEqual(resolved.ignoredPmRoots, [server]);
  } finally {
    await m18fRemove(root);
  }
});
