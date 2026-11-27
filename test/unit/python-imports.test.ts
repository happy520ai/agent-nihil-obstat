import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPythonResolutionContext, pythonModuleName, resolvePythonSpecifier } from '../../src/structure/imports-python.ts';

async function fixture(t: test.TestContext, config?: string, pyproject?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ano-python-imports-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (config) { await mkdir(join(root, '.ano')); await writeFile(join(root, '.ano', 'config.toml'), config); }
  if (pyproject) await writeFile(join(root, 'pyproject.toml'), pyproject);
  return root;
}

test('Python source roots prioritize config, setuptools where, package-dir, src and flat layout', async (t) => {
  const files = ['src/pkg/mod.py', 'lib/pkg/mod.py', 'pkg/mod.py'];
  const examples = [
    { config: '[python]\nroots = ["lib"]', pyproject: '[tool.setuptools.packages.find]\nwhere = ["src"]', expected: ['lib'] },
    { pyproject: '[tool.setuptools.packages.find]\nwhere = [\n "lib", # comment\n "src",\n]', expected: ['lib', 'src'] },
    { pyproject: '[tool.setuptools]\npackage-dir = {"" = "lib"}', expected: ['lib'] },
    { pyproject: "[tool.setuptools.package-dir]\n'' = 'lib'", expected: ['lib'] },
    { expected: ['src'] },
  ];
  for (const item of examples) {
    const root = await fixture(t, item.config, item.pyproject);
    assert.deepEqual((await createPythonResolutionContext(root, files)).roots, item.expected);
  }
  const root = await fixture(t);
  assert.deepEqual((await createPythonResolutionContext(root, ['pkg/mod.py'])).roots, ['']);
});

test('Python absolute imports use deterministic file preference and allow namespace packages', async (t) => {
  const root = await fixture(t);
  const context = await createPythonResolutionContext(root, ['src/a/b/c.py', 'src/a/b/c/__init__.py', 'src/a/b/c.pyi', 'src/a/b/stub.pyi', 'src/a/package/__init__.py', 'src/命名/模块.py']);
  assert.deepEqual(resolvePythonSpecifier(context, 'src/main.py', 'a.b.c'), { status: 'resolved', path: 'src/a/b/c.py' });
  assert.equal(resolvePythonSpecifier(context, 'src/main.py', 'a.b.stub').path, 'src/a/b/stub.pyi');
  assert.equal(resolvePythonSpecifier(context, 'src/main.py', 'a.package').path, 'src/a/package/__init__.py');
  assert.equal(resolvePythonSpecifier(context, 'src/main.py', '命名.模块').path, 'src/命名/模块.py');
  assert.equal(resolvePythonSpecifier(context, 'src/main.py', 'os.path').status, 'external');
  assert.equal(pythonModuleName(context, 'src/a/package/__init__.py'), 'a.package');
  assert.equal(pythonModuleName(context, 'src/a/b/stub.pyi'), 'a.b.stub');
});

test('Multiple roots matching one module are ambiguous, never value-confirmed', async (t) => {
  const root = await fixture(t, '[python]\nroots = ["lib", "src"]');
  const context = await createPythonResolutionContext(root, ['src/pkg/mod.py', 'lib/pkg/mod.py']);
  const result = resolvePythonSpecifier(context, 'src/main.py', 'pkg.mod');
  assert.equal(result.status, 'ambiguous');
  assert.match(result.reason ?? '', /Ambiguous Python module/u);
  assert.equal(result.path, undefined);
});

test('Relative imports follow package level and reject escaping top-level, malformed and missing modules', async (t) => {
  const root = await fixture(t);
  const context = await createPythonResolutionContext(root, ['src/pkg/__init__.py', 'src/pkg/mod.py', 'src/pkg/sub/__init__.py', 'src/pkg/sub/child.py', 'src/top.py']);
  assert.equal(resolvePythonSpecifier(context, 'src/pkg/sub/child.py', '..mod').path, 'src/pkg/mod.py');
  assert.equal(resolvePythonSpecifier(context, 'src/pkg/sub/child.py', '.').path, 'src/pkg/sub/__init__.py');
  assert.equal(resolvePythonSpecifier(context, 'src/pkg/mod.py', '.').path, 'src/pkg/__init__.py');
  assert.equal(resolvePythonSpecifier(context, 'src/pkg/sub/child.py', '...top').status, 'unresolved');
  assert.match(resolvePythonSpecifier(context, 'src/pkg/sub/child.py', '...top').reason ?? '', /escapes/u);
  assert.equal(resolvePythonSpecifier(context, 'src/top.py', '.pkg').status, 'unresolved');
  assert.equal(resolvePythonSpecifier(context, 'src/pkg/mod.py', '.absent').status, 'unresolved');
  for (const specifier of ['a/b', '../outside', 'a..b', '', 'a.1b', '/tmp/x', 'a\\b']) assert.equal(resolvePythonSpecifier(context, 'src/pkg/mod.py', specifier).status, 'unresolved', specifier);
});

test('Unsupported or escaping pyproject roots fall back with caveats', async (t) => {
  for (const pyproject of ['[tool.setuptools.packages.find]\nwhere = [1]', '[tool.setuptools]\npackage-dir = {"pkg" = "lib"}', '[tool.setuptools.packages.find]\nwhere = ["../outside"]', '[tool.setuptools.packages.find]\nwhere = ["lib"]\nwhere = ["src"]']) {
    const root = await fixture(t, undefined, pyproject);
    const context = await createPythonResolutionContext(root, ['src/pkg/mod.py']);
    assert.deepEqual(context.roots, ['src']);
    assert.ok(context.caveats.length > 0, pyproject);
  }
});

test('Python resolver never considers venv, site-packages, bytecode or paths outside the manifest', async (t) => {
  const root = await fixture(t);
  const context = await createPythonResolutionContext(root, ['.venv/Lib/site-packages/evil.py', 'venv/lib/evil.py', 'pkg/__pycache__/evil.py', '../outside.py', 'src/pkg/mod.pyc', 'src/pkg/real.py']);
  assert.deepEqual([...context.files], ['src/pkg/real.py']);
  assert.equal(resolvePythonSpecifier(context, 'src/pkg/real.py', 'evil').status, 'external');
});

test('Python manifest rejects absolute and control-character paths', async (t) => {
  const root = await fixture(t);
  const context = await createPythonResolutionContext(root, ['C:/outside.py', '/outside.py', 'src/../../outside.py', 'src/bad\u0000.py', 'src/bad\n.py', 'src/pkg/real.py']);
  assert.deepEqual([...context.files], ['src/pkg/real.py']);
});

test('Python root inference refuses oversized and symlinked pyproject files', async (t) => {
  const root = await fixture(t, undefined, '[tool.setuptools.packages.find]\nwhere = ["lib"]\n' + '#'.repeat(1_048_576));
  const oversized = await createPythonResolutionContext(root, ['src/pkg/mod.py', 'lib/pkg/mod.py']);
  assert.deepEqual(oversized.roots, ['src']);
  assert.ok(oversized.caveats.length > 0);
  await rm(join(root, 'pyproject.toml'));
  const outside = await fixture(t, undefined, '[tool.setuptools.packages.find]\nwhere = ["lib"]');
  try {
    await symlink(join(outside, 'pyproject.toml'), join(root, 'pyproject.toml'), 'file');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EPERM') { t.skip('Creating file symlinks is not permitted on this host'); return; }
    throw error;
  }
  const linked = await createPythonResolutionContext(root, ['src/pkg/mod.py', 'lib/pkg/mod.py']);
  assert.deepEqual(linked.roots, ['src']);
  assert.ok(linked.caveats.length > 0);
});
