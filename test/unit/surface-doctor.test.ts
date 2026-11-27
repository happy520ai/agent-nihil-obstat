import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { detectInstallation, doctor, PACKAGE_NAME } from '../../src/surface/doctor.ts';

async function temp(prefix: string): Promise<string> { return mkdtemp(join(tmpdir(), prefix)); }

async function write(root: string, path: string, source: string): Promise<void> {
  const target = join(root, ...path.split('/'));
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, source);
}

function git(root: string, args: string[]): void {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
}

async function gitProject(): Promise<string> {
  const root = await temp('ano doctor root ');
  await write(root, 'package.json', JSON.stringify({ name: 'fixture', version: '1.0.0' }));
  await write(root, 'src/a.ts', 'export const a = 1;\n');
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'ano@localhost'], ['config', 'user.name', 'ano'], ['add', '.'], ['commit', '-qm', 'base']]) git(root, args);
  return root;
}

test('detectInstallation covers absent invocation, env exec, dist subpaths and npx layouts', async () => {
  const packageRoot = await temp('ano install shapes ');
  try {
    const localEntry = join(packageRoot, 'dist', 'surface', 'cli.js');
    await write(packageRoot, 'dist/surface/cli.js', '#!/usr/bin/env node\n');

    const absent = detectInstallation({ packageRoot, env: {} });
    assert.equal(absent.mode, 'unknown');
    assert.equal(absent.invokedPath, undefined);
    assert.equal(absent.npxCacheEntry, undefined);
    assert.equal(absent.underNpxCache, false);
    assert.equal(absent.localDistExists, true);

    const cwdPath = join(packageRoot, 'bin', 'wrapper.js');
    const execMode = detectInstallation({ invokedPath: cwdPath, packageRoot, env: { npm_command: 'exec' } });
    assert.equal(execMode.mode, 'npx');
    assert.equal(execMode.underNpxCache, true);

    const distSubpath = join(packageRoot, 'dist', 'surface', 'other.js');
    assert.equal(detectInstallation({ invokedPath: distSubpath, packageRoot, env: {} }).mode, 'local');

    const unrelated = join(packageRoot, 'scripts', 'run.ts');
    assert.equal(detectInstallation({ invokedPath: unrelated, packageRoot, env: {} }).mode, 'unknown');

    // An invoked path that already lives inside the expected package directory.
    const directNpx = join(packageRoot, 'node_modules', '.cache', '_npx', 'hash', 'node_modules', PACKAGE_NAME, 'dist', 'surface', 'cli.js');
    await write(packageRoot, 'node_modules/.cache/_npx/hash/node_modules/agent-nihil-obstat/dist/surface/cli.js', '#!/usr/bin/env node\n');
    const direct = detectInstallation({ invokedPath: directNpx, packageRoot, env: {} });
    assert.equal(direct.mode, 'npx');
    assert.equal(direct.npxCacheExists, true);
    assert.equal(direct.npxCacheEntry, directNpx);

    // A path under `_npx` whose sibling hash directory carries the package.
    const siblingInvoked = join(packageRoot, 'node_modules', '.cache', '_npx', 'other', 'cli.js');
    const sibling = detectInstallation({ invokedPath: siblingInvoked, packageRoot, env: {} });
    assert.equal(sibling.mode, 'npx');
    assert.equal(sibling.npxCacheExists, true);
    assert.match(String(sibling.npxCacheEntry), /hash/);

    // `_npx` that is a regular file: the cache walk fails and is reported as absent.
    const brokenRoot = await temp('ano install broken ');
    try {
      await writeFile(join(brokenRoot, '_npx'), 'not a directory');
      const broken = detectInstallation({ invokedPath: join(brokenRoot, '_npx', 'x', 'cli.js'), packageRoot: brokenRoot, env: {} });
      assert.equal(broken.mode, 'npx');
      assert.equal(broken.npxCacheExists, false);
      assert.equal(broken.npxCacheEntry, undefined);
    } finally { await rm(brokenRoot, { recursive: true, force: true }); }

    const explicitExec = detectInstallation({ execPath: 'C:/fake/node.exe', packageRoot, env: {} });
    assert.equal(explicitExec.execPath, 'C:/fake/node.exe');
  } finally { await rm(packageRoot, { recursive: true, force: true }); }
});

test('doctor reports fallbacks when the package manifest is unreadable', async () => {
  const packageRoot = await temp('ano doctor nomanifest ');
  const root = await gitProject();
  try {
    const report = await doctor(root, { packageRoot, env: {} });
    assert.equal(report.package.name, PACKAGE_NAME);
    assert.equal(report.package.version, 'unknown');
    assert.equal(report.package.engines, undefined);
    assert.equal(report.node.supported, undefined);
    assert.ok(report.checks.some((check) => check.id === 'installation.local-dist' && check.status === 'warn'));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(packageRoot, { recursive: true, force: true });
  }
});

test('doctor classifies supported, unsupported and unparsable node engine ranges', async () => {
  const root = await gitProject();
  try {
    for (const [engine, expected] of [['>=1.0.0', 'ok'], ['>=99.0.0', 'fail'], ['~1.2.3', 'warn'], ['>=24.0', 'ok']] as const) {
      const packageRoot = await temp('ano doctor engine ');
      try {
        await write(packageRoot, 'package.json', JSON.stringify({ name: 'engine-fixture', version: '2.0.0', engines: { node: engine } }));
        const report = await doctor(root, { packageRoot, env: {} });
        const check = report.checks.find((item) => item.id === 'node.engine');
        assert.ok(check, `node.engine check missing for ${engine}`);
        assert.equal(check.status, expected, `${engine} should be ${expected}`);
        assert.equal(report.package.engines, engine);
        assert.equal(report.node.supported, expected === 'fail' ? false : expected === 'ok' ? true : undefined);
      } finally { await rm(packageRoot, { recursive: true, force: true }); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('doctor reports a missing project root, non-git directory and absent .ano state', async () => {
  const packageRoot = await temp('ano doctor package ');
  const root = await temp('ano doctor plain ');
  try {
    await write(packageRoot, 'package.json', JSON.stringify({ name: 'engine-fixture', version: '1.0.0' }));
    await write(root, 'src/a.ts', 'export const a = 1;\n');
    const report = await doctor(root, { packageRoot, env: {} });
    assert.equal(report.project.packageJson, false);
    assert.equal(report.project.gitWorkTree, false);
    assert.equal(report.project.anoDirectory, false);
    assert.equal(report.project.ledgerSegments, 0);
    assert.equal(report.project.graphCache, false);
    assert.equal(report.project.auditStore, false);
    assert.ok(report.checks.some((check) => check.id === 'root.package-json' && check.status === 'fail'));
    assert.ok(report.checks.some((check) => check.id === 'root.git-work-tree' && check.status === 'fail'));

    const missingRoot = join(root, 'not-here');
    const missing = await doctor(missingRoot, { packageRoot, env: {} });
    assert.ok(missing.checks.some((check) => check.id === 'root.exists' && check.status === 'fail'));
    assert.equal(existsSync(missingRoot), false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(packageRoot, { recursive: true, force: true });
  }
});

test('doctor treats the root package manifest as optional for multi-package and non-Node Git projects', async () => {
  const root = await gitProject();
  try {
    await rm(join(root, 'package.json'));
    await write(root, 'server/package.json', JSON.stringify({ name: 'server' }));
    await write(root, 'client/package.json', JSON.stringify({ name: 'client' }));
    const report = await doctor(root);
    assert.equal(report.project.packageJson, false);
    assert.equal(report.project.gitWorkTree, true);
    assert.ok(report.checks.some((check) => check.id === 'root.package-json' && check.status === 'warn'));
    assert.equal(report.checks.some((check) => check.status === 'fail'), false);
    await rm(join(root, 'server'), { recursive: true });
    await rm(join(root, 'client'), { recursive: true });
    await write(root, 'pyproject.toml', '[project]\nname = "fixture"\n');
    assert.equal((await doctor(root)).checks.some((check) => check.status === 'fail'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('doctor counts ledger segments and detects the graph/audit caches', async () => {
  const root = await gitProject();
  try {
    await write(root, '.ano/ledger/0001.jsonl', '{"event":1}\n');
    await write(root, '.ano/ledger/0002.jsonl', '{"event":2}\n');
    await write(root, '.ano/ledger/ignored.txt', 'x\n');
    await write(root, '.ano/cache/graph.db', 'db');
    await write(root, '.ano/audit/findings.json', '{}');
    const report = await doctor(root);
    assert.equal(report.project.anoDirectory, true);
    assert.equal(report.project.ledgerSegments, 2);
    assert.equal(report.project.graphCache, true);
    assert.equal(report.project.auditStore, true);
    assert.equal(report.installation.mode, 'unknown');
    assert.equal(report.installation.underNpxCache, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
