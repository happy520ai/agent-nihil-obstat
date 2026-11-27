/**
 * T-179 review F1: a native `.ano` project without `.pm` must still scan with
 * the policy in `.ano/project.json`, and Graph/Gate/Ledger must all use that
 * one policy. The strict resolver, explicit PM roots and migration/takeover
 * keep rejecting a missing or invalid PM root.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { ProjectScanError, resolveProjectScan, type ScanErrorCode } from '../../src/core/project-scan.ts';
import { fingerprintProject, resolveProjectSourceScan } from '../../src/core/source-scan.ts';
import { verifyTask } from '../../src/gate/verify.ts';
import { resolveMigrationRoot } from '../../src/ledger/migrate.ts';
import { Ledger } from '../../src/ledger/ledger.ts';
import { GraphStore } from '../../src/structure/store.ts';
import { brief } from '../../src/surface/service.ts';

async function write(root: string, path: string, content: string): Promise<void> {
  const target = join(root, ...path.split('/'));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

function git(root: string, ...args: string[]): void {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
}

async function nativeProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ano native scan '));
  await write(root, 'package.json', JSON.stringify({ name: 'native-scan', private: true, type: 'module' }));
  await write(root, '.ano/project.json', JSON.stringify({
    sourceRoots: ['src', 'test'],
    exclude: ['**/ignored/**'],
    maxFiles: 1234,
    timeoutMs: 4321,
  }));
  await write(root, 'src/a.ts', 'export const a = 1;\n');
  await write(root, 'src/ignored/skip.ts', 'export const skip = 1;\n');
  await write(root, 'test/a.test.ts', `import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { a } from '../src/a.ts';
test('mutates an excluded source file', () => {
  mkdirSync('src/ignored', { recursive: true });
  writeFileSync('src/ignored/skip.ts', 'export const skip = 2;\\n');
  assert.equal(a, 1);
});
`);
  git(root, 'init', '--quiet');
  git(root, 'add', '.');
  git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'fixture');
  return root;
}

function assertProjectScanError(promise: Promise<unknown>, code: ScanErrorCode): Promise<void> {
  return assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ProjectScanError, `expected ProjectScanError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

test('strict resolution and an explicit pmRoot still reject a native root without .pm', async () => {
  const root = await nativeProject();
  try {
    await assertProjectScanError(resolveProjectScan({ startRoot: root }), 'PM_ROOT_WITHOUT_PM');
    await assertProjectScanError(
      resolveProjectScan({ startRoot: root, allowMissingPmRoot: true, pmRoot: join(root, 'src') }),
      'PM_ROOT_WITHOUT_PM',
    );
    await assertProjectScanError(resolveMigrationRoot(root), 'PM_ROOT_WITHOUT_PM');
    assert.equal(existsSync(join(root, '.pm')), false, 'validation must not create .pm');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a present but unusable .pm entry is never treated as a native project', async () => {
  const root = await nativeProject();
  try {
    await write(root, '.pm', 'not a directory');
    await assertProjectScanError(
      resolveProjectScan({ startRoot: root, allowMissingPmRoot: true }),
      'PM_ROOT_WITHOUT_PM',
    );
    await assertProjectScanError(resolveProjectSourceScan(root), 'PM_ROOT_WITHOUT_PM');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the read-only source scan consumes .ano policy without creating .pm', async () => {
  const root = await nativeProject();
  try {
    const scan = await resolveProjectSourceScan(root);
    assert.ok(scan, 'a native .ano project has a resolved read-only scan');
    assert.equal(scan.pmRoot, root);
    assert.deepEqual(scan.sourceRoots, [join(root, 'src'), join(root, 'test')]);
    assert.equal(scan.maxFiles, 1234);
    assert.equal(scan.timeoutMs, 4321);
    assert.equal(scan.excludes('src/ignored/skip.ts'), true);
    assert.equal(scan.excludes('src/a.ts'), false);

    const fingerprint = await fingerprintProject(root, scan);
    assert.equal(fingerprint.status, 'ok');
    assert.deepEqual(fingerprint.files.map((file) => file.path).sort(), ['src/a.ts', 'test/a.test.ts']);
    assert.equal(existsSync(join(root, '.pm')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('brief Graph uses the same .ano source roots and exclusions on a native project', async () => {
  const root = await nativeProject();
  try {
    const summary = await brief(root);
    const graph = summary.graph as {
      files: number;
      status: string;
      rootResolution: { inputRoot: string; gitRoot: string; pmRoot: string; sourceRoots: string[] };
    };
    assert.deepEqual(graph.rootResolution, {
      inputRoot: root,
      gitRoot: root,
      pmRoot: root,
      sourceRoots: [join(root, 'src'), join(root, 'test')],
    });
    assert.equal(graph.files, 2, 'the excluded file and out-of-root package.json are not graph input');
    assert.equal(graph.status, 'ok');
    assert.equal(existsSync(join(root, '.pm')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Gate and Ledger share the native scan policy used by the Graph', async () => {
  const root = await nativeProject();
  const ledger = await Ledger.open(root, { sessionId: 'NATIVE-SCAN' });
  const graph = await GraphStore.open(root);
  try {
    await ledger.createTask('T', ['src/a.ts', 'test/a.test.ts']);
    await ledger.updateTask('T', { status: 'in_progress' });
    const verdict = await verifyTask(root, 'T', {
      argv: [process.execPath, '--test', 'test/a.test.ts'],
      testFiles: ['test/a.test.ts'],
    }, { ledger, graph });
    assert.equal(verdict.status, 'done', JSON.stringify(verdict.reasons));
    assert.equal(ledger.getTask('T')?.status, 'done');
    assert.equal(graph.sourceFingerprint, verdict.sourceFingerprint);
    assert.equal(existsSync(join(root, '.pm')), false);
  } finally {
    ledger.close();
    graph.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('an unreadable .ano scan config fails loudly instead of silently using defaults', async () => {
  const root = await nativeProject();
  try {
    await write(root, '.ano/project.json', '{ malformed');
    await assertProjectScanError(resolveProjectSourceScan(root), 'CONFIG_INVALID');
    await assertProjectScanError(brief(root), 'CONFIG_INVALID');
    assert.equal(existsSync(join(root, '.pm')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
