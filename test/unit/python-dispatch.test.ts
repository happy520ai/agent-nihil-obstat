import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { defaultScanExclude } from '../../src/core/fingerprint.ts';
import { fingerprintProject } from '../../src/core/source-scan.ts';
import {
  buildSnapshot,
  ENABLE_PYTHON_STRUCTURE,
  EXTRACTOR_VERSION,
  supportedStructureExtensions,
  SUPPORTED_STRUCTURE_EXTENSIONS,
  TS_STRUCTURE_EXTENSIONS,
} from '../../src/structure/extractor.ts';
import { checkGraphFreshness, collectSourceMetadata } from '../../src/structure/fresh.ts';
import { GraphStore } from '../../src/structure/store.ts';
import { decidePreTool, SUPPORTED_PRE_TOOL_EXTENSIONS } from '../../src/hooks/pre-tool.ts';
import type { HookInput } from '../../src/hooks/contract.ts';
import type { PreToolContext } from '../../src/hooks/pre-tool.ts';
import type { Freshness } from '../../src/structure/types.ts';

const FRESH: Freshness = { status: 'fresh', stale: 0 };
const require = createRequire(import.meta.url);

async function writeFixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ano-python-dispatch-'));
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, ...path.split('/'));
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  return root;
}

function hookInput(targetPaths: string[]): HookInput {
  return { event: 'pre-tool', client: 'zcode', hostSessionId: 'sess-python-dispatch', cwd: '/', targetPaths };
}

function hookContext(overrides: Partial<PreToolContext> = {}): PreToolContext {
  return {
    mode: 'advisory',
    root: '/project',
    freshness: FRESH,
    revision: 'rev-current',
    exists: () => true,
    exploredFiles: [],
    ...overrides,
  };
}

const PYTHON_FIXTURE = {
  'src/a.ts': 'export const a = 1;\n',
  'src/pkg/helper.py': 'def thing():\n    return 1\n',
  'src/pkg/mod.py': [
    'from .helper import thing',
    '',
    'class Greeter:',
    '    def greet(self):',
    '        return thing()',
    '',
    'VALUE = 1',
    '',
  ].join('\n'),
};

test('structure extensions have one frozen TS-only default and Python stays opt-in', () => {
  assert.equal(ENABLE_PYTHON_STRUCTURE, false);
  assert.equal(Object.isFrozen(SUPPORTED_STRUCTURE_EXTENSIONS), true);
  assert.equal(SUPPORTED_STRUCTURE_EXTENSIONS, TS_STRUCTURE_EXTENSIONS);
  assert.equal(Object.isFrozen(TS_STRUCTURE_EXTENSIONS), true);
  // The hook must share the structure layer's public default object, not a copy.
  assert.equal(SUPPORTED_PRE_TOOL_EXTENSIONS, SUPPORTED_STRUCTURE_EXTENSIONS);
  assert.equal(supportedStructureExtensions(), SUPPORTED_STRUCTURE_EXTENSIONS);
  assert.equal(supportedStructureExtensions(false), TS_STRUCTURE_EXTENSIONS);
  assert.ok(SUPPORTED_STRUCTURE_EXTENSIONS.includes('.ts'));
  assert.ok(SUPPORTED_STRUCTURE_EXTENSIONS.includes('.js'));
  assert.equal(SUPPORTED_STRUCTURE_EXTENSIONS.includes('.py'), false);
  assert.equal(SUPPORTED_STRUCTURE_EXTENSIONS.includes('.pyi'), false);

  const enabled = supportedStructureExtensions(true);
  assert.notEqual(enabled, SUPPORTED_STRUCTURE_EXTENSIONS);
  assert.equal(Object.isFrozen(enabled), true);
  for (const extension of SUPPORTED_STRUCTURE_EXTENSIONS) assert.ok(enabled.includes(extension), extension);
  assert.ok(enabled.includes('.py'));
  assert.ok(enabled.includes('.pyi'));
});

test('pre-tool keeps .py as UNSUPPORTED_LANGUAGE while the flag is closed', () => {
  const python = decidePreTool(hookInput(['src/tool.py']), hookContext());
  assert.equal(python.kind, 'allow');
  assert.equal(python.degraded?.code, 'UNSUPPORTED_LANGUAGE');

  for (const extension of SUPPORTED_PRE_TOOL_EXTENSIONS) {
    const decision = decidePreTool(hookInput([`src/tool${extension}`]), hookContext());
    assert.notEqual(decision.degraded?.code, 'UNSUPPORTED_LANGUAGE', extension);
  }
});

test('default snapshot excludes .py and .pyc while the flag is closed', async (t) => {
  const root = await writeFixture({
    ...PYTHON_FIXTURE,
    'src/pkg/stray.pyc': 'not source',
    'src/pkg/__pycache__/mod.cpython-311.pyc': 'not source',
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const fingerprint = await fingerprintProject(root, undefined);
  assert.deepEqual(
    fingerprint.files.map((file) => file.path).filter((path) => path.startsWith('src/pkg/')).sort(),
    ['src/pkg/helper.py', 'src/pkg/mod.py'],
    'the fingerprint keeps .py but drops loose and cached bytecode',
  );

  const { snapshot, report } = await buildSnapshot({ root, fingerprint });
  assert.equal(report.degraded, false);
  assert.ok(snapshot.files['src/a.ts']);
  assert.equal(snapshot.files['src/pkg/mod.py'], undefined);
  assert.equal(snapshot.files['src/pkg/helper.py'], undefined);
  assert.equal(snapshot.symbols.some((symbol) => symbol.file.endsWith('.py')), false);
  assert.equal(snapshot.edges.some((edge) => edge.from.endsWith('.py') || edge.to.endsWith('.py')), false);
});

test('opted-in Python graph uses module-qualified L1 symbols and L0/L1 edges only', async (t) => {
  const root = await writeFixture(PYTHON_FIXTURE);
  t.after(() => rm(root, { recursive: true, force: true }));
  const fingerprint = await fingerprintProject(root, undefined);

  const { snapshot, report, parsedFiles } = await buildSnapshot({ root, fingerprint, enablePythonStructure: true });
  assert.equal(report.degraded, false);
  assert.deepEqual(Object.keys(snapshot.files).sort(), ['src/a.ts', 'src/pkg/helper.py', 'src/pkg/mod.py']);
  assert.equal(parsedFiles['src/pkg/mod.py']?.version, `${EXTRACTOR_VERSION}+python`);
  assert.equal(parsedFiles['src/a.ts']?.version, `${EXTRACTOR_VERSION}+python`);

  const method = snapshot.symbols.find((symbol) => symbol.name === 'greet');
  assert.equal(method?.qualifiedName, 'pkg.mod:Greeter.greet');
  assert.equal(method?.file, 'src/pkg/mod.py');
  const moduleSymbol = snapshot.symbols.find((symbol) => symbol.qualifiedName === 'pkg.mod');
  assert.equal(moduleSymbol?.name, 'mod');
  assert.equal(moduleSymbol?.file, 'src/pkg/mod.py');
  const assignment = snapshot.symbols.find((symbol) => symbol.name === 'VALUE');
  assert.equal(assignment?.qualifiedName, 'pkg.mod:VALUE');
  assert.ok(snapshot.symbols.some((symbol) => symbol.file === 'src/a.ts' && symbol.name === 'a'));

  const edge = snapshot.edges.find((candidate) => candidate.from === 'src/pkg/mod.py' && candidate.to === 'src/pkg/helper.py');
  assert.equal(edge?.kind, 'value-confirmed');
  assert.equal(edge?.provenance, 'resolved');
  assert.ok(edge?.importedNames.includes('thing'));

  // ADR-014 §8: no Python L2 call edges, even though greet() calls thing().
  assert.equal((snapshot.calls ?? []).length, 0);
  assert.equal(snapshot.caveats.callEdges, 0);

  // Reusing the enabled parse cache must reproduce the same module-qualified
  // Python symbols (they are projected after the resolver context is built).
  const reused = await buildSnapshot({
    root,
    fingerprint,
    previous: snapshot,
    parsedCache: parsedFiles,
    enablePythonStructure: true,
  });
  assert.equal(reused.report.reused, 3);
  assert.equal(reused.snapshot.revision, snapshot.revision);
  assert.deepEqual(reused.snapshot.symbols, snapshot.symbols);

  // A flag-off build never reuses Python-enabled parse-cache entries.
  const disabled = await buildSnapshot({ root, fingerprint, previous: snapshot, parsedCache: parsedFiles });
  assert.equal(disabled.report.reused, 0);
  assert.equal(disabled.snapshot.files['src/pkg/mod.py'], undefined);
  assert.equal(disabled.parsedFiles['src/pkg/mod.py'], undefined);
  assert.equal(disabled.parsedFiles['src/a.ts']?.version, EXTRACTOR_VERSION);
});

test('Python extractor init failure degrades with explicit reasons, not a zero graph', async (t) => {
  const root = await writeFixture(PYTHON_FIXTURE);
  t.after(() => rm(root, { recursive: true, force: true }));
  const fingerprint = await fingerprintProject(root, undefined);

  // Run after a successful default init, so only the grammar load fails here.
  // The directory deliberately carries the TS grammar but no Python grammar.
  const wasmDirectory = join(root, 'wasm-without-python-grammar');
  await mkdir(wasmDirectory, { recursive: true });
  await copyFile(require.resolve('web-tree-sitter/tree-sitter.wasm'), join(wasmDirectory, 'tree-sitter.wasm'));
  for (const grammar of ['tree-sitter-typescript.wasm', 'tree-sitter-tsx.wasm', 'tree-sitter-javascript.wasm']) {
    await copyFile(require.resolve(`tree-sitter-wasms/out/${grammar}`), join(wasmDirectory, grammar));
  }

  const output = await buildSnapshot({
    root,
    fingerprint,
    enablePythonStructure: true,
    wasmDirectory,
  });
  assert.equal(output.report.degraded, true);
  assert.ok(output.snapshot.caveats.degradedReasons.some((reason) => reason.startsWith('python-extractor-init-failed:')));
  assert.ok(output.snapshot.caveats.degradedReasons.some((reason) => reason.startsWith('parse-failed:src/pkg/mod.py:')));
  assert.ok(output.snapshot.files['src/a.ts'], 'TS parsing still succeeds');
  assert.equal(output.snapshot.files['src/pkg/mod.py'], undefined);
});

test('enabled Python snapshots are fresh as a whole; flag-off freshness still treats .py as removed', async (t) => {
  const root = await writeFixture(PYTHON_FIXTURE);
  t.after(() => rm(root, { recursive: true, force: true }));
  const fingerprint = await fingerprintProject(root, undefined);
  const { snapshot } = await buildSnapshot({ root, fingerprint, enablePythonStructure: true });

  const enabled = await checkGraphFreshness(root, snapshot, { enablePythonStructure: true });
  assert.equal(enabled.freshness.status, 'fresh');
  assert.deepEqual(enabled.removed, []);

  await writeFile(join(root, 'src', 'pkg', 'mod.py'), 'VALUE = 2\n');
  const changed = await checkGraphFreshness(root, snapshot, { enablePythonStructure: true });
  assert.deepEqual(changed.removed, []);
  assert.deepEqual(changed.changed, ['src/pkg/mod.py']);
  assert.equal(changed.freshness.status, 'stale');

  const disabled = await checkGraphFreshness(root, snapshot);
  assert.equal(disabled.freshness.status, 'stale');
  assert.deepEqual(disabled.removed.sort(), ['src/pkg/helper.py', 'src/pkg/mod.py']);
});

test('metadata fast path drops loose and cached .pyc like source scanning', async (t) => {
  const root = await writeFixture({
    'src/a.ts': 'export const a = 1;\n',
    'src/kept.py': 'VALUE = 1\n',
    'src/stray.pyc': 'bytecode',
    'src/__pycache__/kept.cpython-311.pyc': 'bytecode',
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const metadata = await collectSourceMetadata(root, [root], defaultScanExclude);
  assert.deepEqual([...metadata.keys()].sort(), ['src/a.ts', 'src/kept.py']);
});

test('graph cache invalidates when the Python structure mode changes', async (t) => {
  const root = await writeFixture(PYTHON_FIXTURE);
  t.after(() => rm(root, { recursive: true, force: true }));

  const enabled = await GraphStore.open(root, { enablePythonStructure: true });
  try {
    await enabled.ensureFresh();
    assert.ok(enabled.snapshot().files['src/pkg/mod.py']);
  } finally {
    enabled.close();
  }

  const disabled = await GraphStore.open(root);
  try {
    const outcome = await disabled.ensureFresh();
    assert.equal(outcome.cache, 'miss', 'an enabled cache is not reused in TS-only mode');
    assert.equal(disabled.snapshot().files['src/pkg/mod.py'], undefined);
  } finally {
    disabled.close();
  }
});

test('graph cache invalidates when python.roots changes without a source edit', async (t) => {
  const root = await writeFixture({
    '.ano/config.toml': '[python]\nroots = ["lib"]\n',
    'lib/pkg/mod.py': 'def main():\n    return 1\n',
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const first = await GraphStore.open(root, { enablePythonStructure: true });
  let firstRevision = '';
  try {
    await first.ensureFresh();
    firstRevision = first.revision;
    assert.ok(first.snapshot().symbols.some((symbol) => symbol.qualifiedName === 'pkg.mod:main'));
  } finally {
    first.close();
  }

  await writeFile(join(root, '.ano', 'config.toml'), '[python]\nroots = ["src"]\n');
  const second = await GraphStore.open(root, { enablePythonStructure: true });
  try {
    const outcome = await second.ensureFresh();
    assert.equal(outcome.cache, 'miss', 'a root-only config change forces a rebuild');
    assert.notEqual(second.revision, firstRevision);
    assert.ok(second.snapshot().symbols.some((symbol) => symbol.qualifiedName === 'lib.pkg.mod:main'));
  } finally {
    second.close();
  }
});

test('graph cache invalidates when pyproject source roots change', async (t) => {
  const root = await writeFixture({
    'pyproject.toml': '[tool.setuptools.packages.find]\nwhere = ["lib"]\n',
    'lib/pkg/mod.py': 'def main():\n    return 1\n',
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const first = await GraphStore.open(root, { enablePythonStructure: true });
  let firstRevision = '';
  try {
    await first.ensureFresh();
    firstRevision = first.revision;
    assert.ok(first.snapshot().symbols.some((symbol) => symbol.qualifiedName === 'pkg.mod:main'));
  } finally {
    first.close();
  }

  await writeFile(join(root, 'pyproject.toml'), '[tool.setuptools.packages.find]\nwhere = ["src"]\n');
  const second = await GraphStore.open(root, { enablePythonStructure: true });
  try {
    const outcome = await second.ensureFresh();
    assert.equal(outcome.cache, 'miss');
    assert.notEqual(second.revision, firstRevision);
    assert.ok(second.snapshot().symbols.some((symbol) => symbol.qualifiedName === 'lib.pkg.mod:main'));
  } finally {
    second.close();
  }
});
