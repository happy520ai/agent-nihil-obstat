import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile, readdir as fsReaddir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';
import {
  DEFAULT_EXCLUDES,
  ProjectScanError,
  createScanBudget,
  isExcluded,
  isSecretPath,
  matchesGlob,
  resolveProjectScan,
  scanBudgetTimedOut,
  scanStatusForResult,
  shouldFollowLink,
  type ProjectScanDeps,
  type ScanErrorCode,
} from '../../src/core/project-scan.ts';

async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ano scan '));
  await mkdir(join(root, '.git'), { recursive: true });
  await mkdir(join(root, '.pm'), { recursive: true });
  return root;
}

async function pkg(directory: string, name: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name }));
}

async function outside(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'ano outside '));
}

function assertCode(promise: Promise<unknown>, code: ScanErrorCode): Promise<void> {
  return assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ProjectScanError, `expected ProjectScanError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

test('discovers a nested package when the Git root has no package.json', async () => {
  const root = await repo();
  await pkg(join(root, 'server'), 'server');
  const resolved = await resolveProjectScan({ startRoot: root });
  assert.equal(resolved.gitRoot, root);
  assert.equal(resolved.pmRoot, root);
  assert.deepEqual(resolved.sourceRoots, [join(root, 'server')]);
  assert.equal(resolved.discovery.ambiguous, false);
  assert.equal(resolved.discovery.overridden, false);
  assert.equal(resolved.discovery.candidates.length, 1);
  const candidate = resolved.discovery.candidates[0]!;
  assert.equal(candidate.relativePath, 'server');
  assert.equal(candidate.depth, 1);
  assert.equal(candidate.name, 'server');
  assert.equal(resolved.rootResolution.inputRoot, root);
});

test('single-package repository resolves the root itself as the source root', async () => {
  const root = await repo();
  await pkg(root, 'single');
  const resolved = await resolveProjectScan({ startRoot: root });
  assert.equal(resolved.gitRoot, root);
  assert.equal(resolved.pmRoot, root);
  assert.deepEqual(resolved.sourceRoots, [root]);
  assert.deepEqual(resolved.discovery.candidates, [{ relativePath: '.', absolutePath: root, depth: 0, name: 'single' }]);
  assert.equal(resolved.discovery.ambiguous, false);
});

test('multiple candidates resolve to the nearest layer and can be forced to error', async () => {
  const root = await repo();
  await pkg(join(root, 'server'), 'server');
  await pkg(join(root, 'client'), 'client');
  await pkg(join(root, 'workbench'), 'workbench');

  const resolved = await resolveProjectScan({ startRoot: root });
  assert.deepEqual(resolved.sourceRoots, [join(root, 'client'), join(root, 'server'), join(root, 'workbench')]);
  assert.equal(resolved.discovery.ambiguous, true);
  assert.equal(resolved.discovery.candidates.length, 3);

  await assertCode(resolveProjectScan({ startRoot: root, onAmbiguity: 'error' }), 'AMBIGUOUS_SOURCE_ROOTS');

  const nested = await repo();
  await pkg(join(nested, 'a'), 'a');
  await pkg(join(nested, 'a', 'b'), 'b');
  const nearest = await resolveProjectScan({ startRoot: nested });
  assert.deepEqual(nearest.sourceRoots, [join(nested, 'a')]);
  assert.equal(nearest.discovery.ambiguous, false);
});

test('zero candidates report NO_NODE_PACKAGE instead of a root error', async () => {
  const root = await repo();
  await assertCode(resolveProjectScan({ startRoot: root }), 'NO_NODE_PACKAGE');
});

test('explicit source roots avoid NO_NODE_PACKAGE for package-less repositories', async () => {
  const root = await repo();
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  const resolved = await resolveProjectScan({ startRoot: root, sourceRoots: [join(root, 'src')] });
  assert.deepEqual(resolved.sourceRoots, [join(root, 'src')]);
  assert.equal(resolved.discovery.overridden, true);
  assert.deepEqual(resolved.discovery.candidates, []);
});

test('discovery stays inside the Git root and respects the depth limit', async () => {
  const root = await repo();
  const external = await outside();
  await pkg(join(external, 'sneaky'), 'sneaky');
  await pkg(join(root, 'shallow'), 'shallow');
  await pkg(join(root, 'a', 'b', 'c'), 'deep');

  const visited: string[] = [];
  const deps: ProjectScanDeps = {
    readdir: async (directory) => {
      visited.push(directory);
      return fsReaddir(directory);
    },
  };
  const resolved = await resolveProjectScan({ startRoot: root, maxDiscoverDepth: 2 }, deps);
  assert.deepEqual(resolved.sourceRoots, [join(root, 'shallow')]);
  assert.ok(resolved.discovery.candidates.every((candidate) => candidate.depth <= 2));
  assert.equal(resolved.discovery.truncated, true);
  assert.ok(visited.length > 0);
  for (const directory of visited) {
    const relative = resolve(directory).slice(resolve(root).length);
    assert.ok(relative === '' || relative.startsWith(sep), `discovery left the Git root: ${directory}`);
  }
  assert.ok(!visited.includes(external));
});

test('a source root outside the Git root is rejected', async () => {
  const root = await repo();
  const external = await outside();
  await pkg(join(external, 'x'), 'x');
  await assertCode(resolveProjectScan({ startRoot: root, sourceRoots: [join(external, 'x')] }), 'SOURCE_ROOT_OUTSIDE_GIT_ROOT');
});

test('a pmRoot without .pm is rejected', async () => {
  const root = await repo();
  await pkg(join(root, 'plain'), 'plain');
  await assertCode(resolveProjectScan({ startRoot: root, pmRoot: join(root, 'plain') }), 'PM_ROOT_WITHOUT_PM');
});

test('a nested runtime-only .pm cannot override the authoritative scan_ignore', async (t) => {
  const root = await repo();
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = join(root, 'server');
  await pkg(server, 'server');
  await pkg(join(root, 'scheduler-tool'), 'scheduler-tool');
  await mkdir(join(server, '.pm', '.runtime'), { recursive: true });
  await writeFile(join(server, '.pm', '.gitignore'), '.runtime/\n');
  const pmConfig = join(root, '.pm', 'project.json');
  const content = JSON.stringify({ scan_ignore: ['scheduler-tool/**'] });
  await writeFile(pmConfig, content);

  const baseline = await resolveProjectScan({ startRoot: root });
  assert.deepEqual(baseline.sourceRoots, [server]);
  assert.deepEqual(baseline.configSource.pmScanIgnore, ['scheduler-tool/**']);
  await assertCode(resolveProjectScan({ startRoot: root, pmRoot: server }), 'PM_ROOT_WITHOUT_PM');
  assert.equal(await readFile(pmConfig, 'utf8'), content, 'root validation must not rewrite PM configuration');
  assert.deepEqual((await fsReaddir(join(server, '.pm'))).sort(), ['.gitignore', '.runtime']);
});

test('an alternate PM root needs a task array, not only project metadata or an invalid task store', async (t) => {
  const root = await repo();
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = join(root, 'server');
  await pkg(server, 'server');
  await mkdir(join(server, '.pm'));
  await writeFile(join(server, '.pm', 'project.json'), JSON.stringify({ name: 'decoy' }));
  await assertCode(resolveProjectScan({ startRoot: root, pmRoot: server }), 'PM_ROOT_WITHOUT_PM');

  const tasksFile = join(server, '.pm', 'tasks.json');
  for (const tasks of [{}, { tasks: null }, { tasks: 'not-an-array' }]) {
    await writeFile(tasksFile, JSON.stringify(tasks));
    await assertCode(resolveProjectScan({ startRoot: root, pmRoot: server }), 'PM_ROOT_WITHOUT_PM');
  }
  await writeFile(tasksFile, '{ malformed');
  await assertCode(resolveProjectScan({ startRoot: root, pmRoot: server }), 'CONFIG_INVALID');
});

test('an alternate PM root with an empty task store remains valid without project metadata', async (t) => {
  const root = await repo();
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = join(root, 'server');
  await pkg(server, 'server');
  await mkdir(join(server, '.pm'));
  const tasksFile = join(server, '.pm', 'tasks.json');
  const content = JSON.stringify({ seq: 0, tasks: [] });
  await writeFile(tasksFile, content);

  const resolved = await resolveProjectScan({ startRoot: root, pmRoot: server });
  assert.equal(resolved.pmRoot, server);
  assert.deepEqual(resolved.sourceRoots, [server]);
  assert.deepEqual(resolved.configSource.pmScanIgnore, []);
  assert.equal(await readFile(tasksFile, 'utf8'), content);
});

test('a root cannot be both the PM root and the source start when the Git root differs', async () => {
  const root = await repo();
  await pkg(join(root, 'server'), 'server');
  await assertCode(
    resolveProjectScan({ startRoot: join(root, 'server'), pmRoot: join(root, 'server') }),
    'ROOT_ROLE_CONFLICT',
  );
});

test('reuses .pm scan_ignore read-only and merges it ahead of defaults', async () => {
  const root = await repo();
  await pkg(join(root, 'server'), 'server');
  const pmConfig = join(root, '.pm', 'project.json');
  await writeFile(pmConfig, JSON.stringify({ name: 'fixture', scan_ignore: ['server/data/**', 'custom/**'] }));
  const before = await readFile(pmConfig, 'utf8');

  const resolved = await resolveProjectScan({ startRoot: root, exclude: ['explicit/**'], include: ['server/data/keep/**'] });
  const after = await readFile(pmConfig, 'utf8');
  assert.equal(after, before, '.pm/project.json must never be rewritten');

  assert.ok(resolved.excludeGlobs.includes('server/data/**'));
  assert.ok(resolved.excludeGlobs.includes('custom/**'));
  assert.ok(resolved.excludeGlobs.includes('explicit/**'));
  assert.ok(resolved.excludeGlobs.some((glob) => glob.includes('node_modules')));
  assert.deepEqual(resolved.configSource.pmScanIgnore, ['server/data/**', 'custom/**']);

  assert.equal(resolved.excludes('server/data/other.ts'), true);
  assert.equal(resolved.excludes(join(root, 'server', 'data', 'other.ts')), true);
  assert.equal(resolved.excludes('custom/x.ts'), true);
  assert.equal(resolved.excludes('explicit/x.ts'), true);
  assert.equal(resolved.excludes('dist/bundle.js'), true);
  assert.equal(resolved.excludes('src/a.ts'), false);
  assert.equal(resolved.excludes('server/data', true), false, 'included descendants keep parent directories traversable');
  assert.equal(resolved.excludes('server/data'), true, 'a file with the parent name remains excluded');
  assert.equal(resolved.excludes('server/data/other', true), true, 'unrelated siblings remain excluded');
  assert.equal(resolved.excludes('server/data/keep/a.ts'), false, 'include overrides a scan_ignore exclusion');
  assert.equal(resolved.excludes('server/data/keep/a.ts'), false);
});

test('explicit options override .ano project configuration', async () => {
  const root = await repo();
  await pkg(join(root, 'server'), 'server');
  await pkg(join(root, 'client'), 'client');
  await mkdir(join(root, '.ano'), { recursive: true });
  await writeFile(join(root, '.ano', 'project.json'), JSON.stringify({
    sourceRoots: ['server'],
    exclude: ['ano-only/**'],
    maxFileBytes: 111,
    timeoutMs: 222,
    onAmbiguity: 'error',
  }));

  const fromConfig = await resolveProjectScan({ startRoot: root });
  assert.deepEqual(fromConfig.sourceRoots, [join(root, 'server')]);
  assert.equal(fromConfig.maxFileBytes, 111);
  assert.equal(fromConfig.timeoutMs, 222);
  assert.equal(fromConfig.onAmbiguity, 'error');
  assert.ok(fromConfig.excludeGlobs.includes('ano-only/**'));
  assert.equal(fromConfig.discovery.overridden, true);

  const overridden = await resolveProjectScan({ startRoot: root, sourceRoots: [join(root, 'client')], maxFileBytes: 333 });
  assert.deepEqual(overridden.sourceRoots, [join(root, 'client')]);
  assert.equal(overridden.maxFileBytes, 333);
  assert.equal(overridden.timeoutMs, 222);
});

test('include can never re-admit secret paths', async () => {
  const root = await repo();
  await pkg(join(root, 'server'), 'server');
  const resolved = await resolveProjectScan({
    startRoot: root,
    include: ['.env', '**/*.pem', 'secrets/**', 'credentials.json', '**/.env*'],
  });
  for (const secret of ['.env', '.env.local', 'server/.env', 'secrets/value.ts', 'server/secrets/value.ts', 'keys/server.pem', 'credentials.json']) {
    assert.equal(resolved.excludes(secret), true, secret);
    assert.equal(resolved.includes(secret), false, secret);
  }
  assert.equal(isSecretPath('server/.env.local'), true);
  assert.equal(isSecretPath('id_rsa'), true);
  assert.equal(isSecretPath('id_ed25519.pub'), true);
  assert.equal(isSecretPath('src/a.ts'), false);
});

test('links are not followed by default', async (context) => {
  const root = await repo();
  await pkg(join(root, 'server'), 'server');
  try {
    await symlink(join(root, 'server'), join(root, 'linkdir'), 'dir');
  } catch (error) {
    context.skip(`symlink unavailable in this environment: ${String(error)}`);
    return;
  }
  const resolved = await resolveProjectScan({ startRoot: root });
  assert.equal(resolved.followLinks, false);
  assert.deepEqual(resolved.sourceRoots, [join(root, 'server')]);
  assert.equal(resolved.shouldFollowLink('linkdir'), false);
  assert.equal(shouldFollowLink('linkdir', false), false);
  assert.equal(shouldFollowLink('linkdir', true), true);
  assert.equal(shouldFollowLink('secrets/value', true), false);
});

test('budget exhaustion reports timeout rather than an empty ok result', async () => {
  const budget = createScanBudget({ timeoutMs: 1, now: () => 1000 });
  assert.equal(scanBudgetTimedOut(budget, 1000), false);
  assert.equal(scanBudgetTimedOut(budget, 1002), true);
  assert.equal(scanStatusForResult(budget, 5, 1000), 'ok');
  assert.equal(scanStatusForResult(budget, 0, 1000), 'degraded');
  assert.equal(scanStatusForResult(budget, 5, 1002), 'timeout');
  assert.equal(scanStatusForResult(budget, 0, 1002), 'timeout');

  const capped = createScanBudget({ maxFiles: 2, now: () => 1000 });
  capped.filesSeen = 2;
  assert.equal(scanStatusForResult(capped, 2, 1000), 'timeout');

  const root = await repo();
  await pkg(join(root, 'server'), 'server');
  const resolved = await resolveProjectScan({ startRoot: root, timeoutMs: 1, deadline: Date.now() - 1 });
  assert.equal(scanBudgetTimedOut(resolved.budgets), true);
  assert.equal(scanStatusForResult(resolved.budgets, 0), 'timeout');
});

test('default exclusions cover dependency, build, runtime and secret categories', () => {
  for (const path of [
    'node_modules/x.js',
    'server/dist/a.js',
    '.git/config',
    '.pm/tasks.json',
    '.ano/cache/graph.db',
    'coverage/lcov.info',
    '.venv/lib/python.js',
    'chrome-cdp-profile/Default/Cookies',
    'server/data/browser-profiles/Default/Cookies',
    'server/data/browser-profiles/shop-1/SingletonLock',
    'logs/run.log',
    'model.safetensors',
    'secret.pem',
  ]) {
    assert.equal(isExcluded(path, DEFAULT_EXCLUDES), true, path);
  }
  assert.equal(isExcluded('src/a.ts', DEFAULT_EXCLUDES), false);
  assert.equal(isExcluded('server/data/a.ts', DEFAULT_EXCLUDES), false, 'data/ is not excluded by default');
  assert.equal(matchesGlob('**/*.log', 'a/b/c.log'), true);
  assert.equal(matchesGlob('server/data/**', 'server/data/nested/c.ts'), true);
  assert.equal(matchesGlob('server/data/**', 'server/data'), true);
  assert.equal(matchesGlob('server/data/**', 'other/server/data/c.ts'), false);
});

test('invalid configuration is rejected instead of silently ignored', async () => {
  const root = await repo();
  await pkg(join(root, 'server'), 'server');
  await assertCode(resolveProjectScan({ startRoot: root, exclude: ['../etc/**'] }), 'CONFIG_INVALID');
  await assertCode(resolveProjectScan({ startRoot: root, exclude: ['C:\\\\windows\\\\**'] }), 'CONFIG_INVALID');
  await assertCode(resolveProjectScan({}), 'CONFIG_INVALID');

  await mkdir(join(root, '.ano'), { recursive: true });
  await writeFile(join(root, '.ano', 'project.json'), JSON.stringify({ unknownField: true }));
  await assertCode(resolveProjectScan({ startRoot: root }), 'CONFIG_INVALID');
});

test('source/.pm roots below the Git root are reported as ignored PM roots', async () => {
  const root = await repo();
  await pkg(join(root, 'server'), 'server');
  await mkdir(join(root, 'server', '.pm'), { recursive: true });
  const resolved = await resolveProjectScan({ startRoot: root });
  assert.deepEqual(resolved.ignoredPmRoots, [join(root, 'server')]);
  assert.deepEqual(resolved.configSource.ignoredPmRoots, [join(root, 'server')]);
  assert.equal(resolved.pmRoot, root);
});
