/**
 * PY-10 / M23b: Python structure security red team.
 *
 * Every scenario runs in a fresh `os.tmpdir()` project. The Python sources are
 * parsed by the static WASM extractor and never executed; no interpreter,
 * venv, `site-packages` or subprocess is involved. Adversarial inputs must end
 * in explicit caveats/budgets with `unknown` edges, never a crash and never a
 * synthetic `value-confirmed` edge.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fingerprintProject } from '../../src/core/source-scan.ts';
import { testCoverage } from '../../src/gate/blast.ts';
import { buildSnapshot } from '../../src/structure/extractor.ts';
import type { GraphSnapshot } from '../../src/structure/types.ts';

async function writeProject(t: test.TestContext, files: Record<string, string | Buffer>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ano-python-redteam-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, ...path.split('/'));
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  return root;
}

async function build(root: string): Promise<GraphSnapshot> {
  const fingerprint = await fingerprintProject(root, undefined);
  const { snapshot } = await buildSnapshot({ root, fingerprint, enablePythonStructure: true });
  return snapshot;
}

async function missing(path: string): Promise<boolean> {
  try {
    await stat(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

test('static Python sources are parsed, never executed', async (t) => {
  const root = await writeProject(t, {
    'pkg/mod.py': 'VALUE = 1\n',
    'danger.py': [
      'from pkg.mod import VALUE',
      "open('EXECUTED-OPEN', 'w').write('x')",
      'import os',
      "os.system('echo EXECUTED-SYSTEM > EXECUTED-SYSTEM')",
      'raise SystemExit(1)',
      '',
    ].join('\n'),
  });
  const snapshot = await build(root);
  assert.ok(snapshot.files['danger.py'], 'the source is still statically parsed');
  assert.deepEqual(
    snapshot.edges.filter((edge) => edge.from === 'danger.py' && edge.to.endsWith('.py')).map((edge) => [edge.to, edge.kind]),
    [['pkg/mod.py', 'value-confirmed']],
  );
  assert.ok(snapshot.edges.some((edge) => edge.from === 'danger.py' && edge.to === 'os' && edge.kind === 'unknown'));
  assert.ok(await missing(join(root, 'EXECUTED-OPEN')), 'open() was never executed');
  assert.ok(await missing(join(root, 'EXECUTED-SYSTEM')), 'subprocess/system was never executed');
  assert.deepEqual(snapshot.caveats.degradedReasons, []);
  assert.equal(snapshot.calls?.length ?? 0, 0);
});

test('malformed, incomplete and binary Python produce explicit unknown edges, never value coverage', async (t) => {
  const malformed = 'from pkg.mod import VALUE\nif True\n';
  const binary = Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from('import os\nfrom pkg.mod import VALUE\n', 'utf8')]);
  const root = await writeProject(t, { 'pkg/mod.py': 'VALUE = 1\n', 'bad.py': malformed, 'bin.py': binary });
  const snapshot = await build(root);
  assert.ok(snapshot.files['bad.py']);
  assert.ok(snapshot.files['bin.py']);
  const syntaxFiles = new Set((snapshot.caveats.semanticGaps ?? []).filter((gap) => gap.pattern === 'python-syntax-error').map((gap) => gap.file));
  assert.ok(syntaxFiles.has('bad.py'));
  assert.ok(syntaxFiles.has('bin.py'));
  for (const file of ['bad.py', 'bin.py']) {
    const edges = snapshot.edges.filter((edge) => edge.from === file && (edge.to.endsWith('.py') || edge.to.endsWith('.pyi')));
    assert.ok(edges.length > 0, `${file} still records its raw import as evidence`);
    assert.ok(edges.every((edge) => edge.kind !== 'value-confirmed'), `${file} must not confirm an edge from broken syntax`);
    assert.ok(edges.every((edge) => edge.kind === 'unknown' && edge.provenance === 'heuristic' && edge.label === 'unresolved'));
  }
  const covered = testCoverage(snapshot, ['bad.py', 'bin.py']);
  assert.ok(!covered.has('pkg/mod.py'), 'broken syntax cannot prove coverage of the imported module');
});

test('AST and nested-scope budgets stop explicitly and downgrade every edge', async (t) => {
  const deepCalls = `${'f('.repeat(1200)}1${')'.repeat(1200)}\n`;
  const nestedClasses = `${Array.from({ length: 20 }, (_, index) => `${'    '.repeat(index)}class C${index}:`).join('\n')}\n${'    '.repeat(20)}pass\n`;
  const root = await writeProject(t, {
    'pkg/mod.py': 'VALUE = 1\n',
    'deep.py': `from pkg.mod import VALUE\n${deepCalls}`,
    'scope.py': `from pkg.mod import VALUE\n${nestedClasses}`,
  });
  const snapshot = await build(root);
  const gaps = snapshot.caveats.semanticGaps ?? [];
  assert.ok(gaps.some((gap) => gap.file === 'deep.py' && gap.pattern === 'depth-limit' && gap.reason.includes('STRUCTURE_BUDGET_EXCEEDED')));
  assert.ok(gaps.some((gap) => gap.file === 'scope.py' && gap.pattern === 'depth-limit' && gap.reason.includes('STRUCTURE_BUDGET_EXCEEDED')));
  for (const file of ['deep.py', 'scope.py']) {
    const edges = snapshot.edges.filter((edge) => edge.from === file);
    assert.ok(edges.length > 0);
    assert.ok(edges.every((edge) => edge.kind !== 'value-confirmed' && edge.provenance === 'heuristic' && edge.label === 'unresolved'));
  }
  assert.ok(!testCoverage(snapshot, ['deep.py', 'scope.py']).has('pkg/mod.py'));
  assert.equal(snapshot.files['deep.py'] !== undefined, true);
  assert.equal(snapshot.files['scope.py'] !== undefined, true);
});

test('sys.path mutations are caveats and unknown imports can never cover a project file', async (t) => {
  const root = await writeProject(t, {
    'pkg/mod.py': 'VALUE = 1\n',
    'app/core.py': 'X = 1\n',
    'app.py': [
      'import sys',
      "sys.path.insert(0, 'src')",
      'from missing_pkg import thing',
      'from pkg.mod import VALUE',
      '',
    ].join('\n'),
  });
  const snapshot = await build(root);
  const sysPath = (snapshot.caveats.semanticGaps ?? []).filter((gap) => gap.pattern === 'python-sys-path');
  assert.equal(sysPath.length, 1);
  assert.equal(sysPath[0]?.line, 2);
  assert.match(sysPath[0]?.reason ?? '', /sys\.path/u);
  const missingEdge = snapshot.edges.find((edge) => edge.from === 'app.py' && edge.to === 'missing_pkg');
  assert.equal(missingEdge?.kind, 'unknown');
  assert.equal(missingEdge?.provenance, 'parsed');
  // The caveat is not a silent downgrade of unrelated, statically valid edges.
  assert.ok(snapshot.edges.some((edge) => edge.from === 'app.py' && edge.to === 'pkg/mod.py' && edge.kind === 'value-confirmed'));
  const covered = testCoverage(snapshot, ['app.py']);
  assert.ok(covered.has('app.py'));
  assert.ok(covered.has('pkg/mod.py'));
  assert.ok(!covered.has('app/core.py'), 'an unrelated local module is not covered by a sys.path caveat');
  assert.ok(!covered.has('missing_pkg'));
});

test('dynamic load, reflection, eval and registry strings never become edges', async (t) => {
  const root = await writeProject(t, {
    'app/__init__.py': '',
    'app/core.py': 'X = 1\n',
    'app.py': [
      "INSTALLED_APPS = ['app.core']",
      "getattr(object, 'x')",
      "exec('x')",
      'import importlib',
      "importlib.import_module('app.core')",
      'import __future__',
      '',
    ].join('\n'),
  });
  const snapshot = await build(root);
  assert.ok(!snapshot.edges.some((edge) => edge.from === 'app.py' && edge.to === 'app/core.py'));
  assert.ok(!snapshot.edges.some((edge) => edge.kind === 'value-confirmed' && edge.to === 'app/core.py' && edge.from !== 'app/__init__.py'));
  assert.deepEqual(snapshot.caveats.registryFiles, ['app.py']);
  assert.deepEqual(snapshot.caveats.reflectionFiles, ['app.py']);
  const patterns = new Set((snapshot.caveats.semanticGaps ?? []).map((gap) => gap.pattern));
  for (const expected of ['registry-scan', 'reflection', 'eval']) assert.ok(patterns.has(expected), expected);
  assert.ok((snapshot.caveats.dynamicLoadSites ?? []).some((site) => site.file === 'app.py' && site.target === 'app.core' && site.tier === 'unknown'));
  assert.ok(!testCoverage(snapshot, ['app.py']).has('app/core.py'), 'runtime registry/dynamic load never proves coverage');
});

test('escaping python.roots is rejected and never resolves outside the project', async (t) => {
  const outside = await mkdtemp(join(tmpdir(), 'ano-python-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await mkdir(join(outside, 'pkg'), { recursive: true });
  await writeFile(join(outside, 'pkg', 'mod.py'), 'OUTSIDE = 1\n');
  const outsidePosix = outside.split(String.fromCharCode(92)).join('/');

  for (const configured of [outsidePosix, '../outside-python-root']) {
    const root = await writeProject(t, {
      '.ano/config.toml': `[python]\nroots = ["${configured}"]\n`,
      'pkg/mod.py': 'VALUE = 1\n',
      'app.py': 'from pkg.mod import VALUE\n',
    });
    const snapshot = await build(root);
    const appEdges = snapshot.edges.filter((edge) => edge.from === 'app.py');
    assert.equal(appEdges.length, 1);
    assert.equal(appEdges[0]?.to, 'pkg/mod.py');
    assert.equal(appEdges[0]?.kind, 'value-confirmed');
    assert.ok(!appEdges[0]?.to.includes('..'));
    assert.ok(!appEdges[0]?.to.includes(outside.slice(0, 3)));
    assert.ok((snapshot.caveats.semanticGaps ?? []).some((gap) => gap.pattern === 'python-source-roots' && /project-local/u.test(gap.reason)));
    await rm(root, { recursive: true, force: true });
  }
});

test('pathological long lines and bogus encoding declarations do not crash or confirm edges', async (t) => {
  const longLine = `VALUE = '${'x'.repeat(200_000)}'\n`;
  const root = await writeProject(t, {
    'pkg/mod.py': 'VALUE = 1\n',
    'long.py': `${longLine}from pkg.mod import VALUE\n`,
    'encoding.py': '# -*- coding: definitely-not-a-codec -*-\nfrom pkg.mod import VALUE\n',
  });
  const snapshot = await build(root);
  assert.ok(snapshot.files['long.py']);
  assert.ok(snapshot.files['encoding.py']);
  // A coding cookie is only a comment to the static tree; the import is real.
  const encodingEdge = snapshot.edges.find((edge) => edge.from === 'encoding.py' && edge.to === 'pkg/mod.py');
  assert.equal(encodingEdge?.kind, 'value-confirmed');
  assert.ok(snapshot.edges.every((edge) => edge.to.endsWith('.py') || edge.to.endsWith('.pyi') || !edge.to.includes('/')));
});

test('symlinked Python files are not followed into the graph', async (t) => {
  const outside = await mkdtemp(join(tmpdir(), 'ano-python-link-target-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'secret.py'), 'SECRET = 1\n');
  const root = await writeProject(t, { 'pkg/mod.py': 'VALUE = 1\n' });
  try {
    await symlink(join(outside, 'secret.py'), join(root, 'linked.py'));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    assert.ok(code === 'EPERM' || code === 'EACCES', `unexpected symlink failure: ${code}`);
    // Windows without symlink privilege: no file exists to follow, and the
    // default fingerprint contract is covered by the structure roots tests.
    return;
  }
  const snapshot = await build(root);
  assert.equal(snapshot.files['linked.py'], undefined);
  assert.ok(!snapshot.symbols.some((symbol) => symbol.file === 'linked.py'));
  assert.ok(!snapshot.edges.some((edge) => edge.from === 'linked.py' || edge.to === 'linked.py'));
});
