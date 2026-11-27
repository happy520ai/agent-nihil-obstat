import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPythonResolutionContext, buildPythonImportEdges } from '../../src/structure/imports-python.ts';
import { createPythonExtractor, type PythonParsedFile } from '../../src/structure/extractors/python.ts';

async function graph(t: test.TestContext, sources: Record<string, string>): Promise<{ edges: ReturnType<typeof buildPythonImportEdges>['edges']; caveats: ReturnType<typeof buildPythonImportEdges>['caveats'] }> {
  const root = await mkdtemp(join(tmpdir(), 'ano-python-edges-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const extractor = await createPythonExtractor();
  t.after(() => extractor.close());
  const modules = new Map<string, PythonParsedFile>();
  for (const [file, source] of Object.entries(sources)) modules.set(file, extractor.parse(file, source));
  const context = await createPythonResolutionContext(root, modules.keys());
  return buildPythonImportEdges(context, modules);
}

test('Python named imports follow project reexports to the defining module', async (t) => {
  const result = await graph(t, {
    'src/pkg/__init__.py': 'from .impl import run as execute\n',
    'src/pkg/impl.py': 'def run():\n    return 1\n',
    'src/app.py': 'from pkg import execute\nfrom pkg.impl import run\n',
  });
  assert.deepEqual(result.edges.filter((edge) => edge.from === 'src/app.py'), [{
    from: 'src/app.py', to: 'src/pkg/impl.py', kind: 'value-confirmed', provenance: 'resolved', importedNames: ['execute', 'run'],
  }]);
  assert.deepEqual(result.caveats, []);
});

test('Python type-only, conditional, lazy and wildcard imports never prove value coverage', async (t) => {
  const result = await graph(t, {
    'src/pkg/__init__.py': 'from .impl import run as execute\n',
    'src/pkg/impl.py': 'def run():\n    return 1\n',
    'src/app.py': 'from typing import TYPE_CHECKING\nif TYPE_CHECKING:\n    from pkg.impl import run as typed\nif flag:\n    from pkg.impl import run as conditional\ndef load():\n    from pkg.impl import run as lazy\nfrom pkg.impl import *\n',
    'src/stub.pyi': 'from pkg.impl import run\n',
  });
  const appEdges = result.edges.filter((edge) => edge.from === 'src/app.py');
  assert.ok(appEdges.some((edge) => edge.kind === 'type-only' && edge.to === 'src/pkg/impl.py' && edge.importedNames.includes('run')));
  assert.ok(appEdges.some((edge) => edge.kind === 'unknown' && edge.label === 'conditional_import'));
  assert.ok(appEdges.some((edge) => edge.kind === 'unknown' && edge.label === 'lazy_import'));
  assert.ok(appEdges.some((edge) => edge.kind === 'unknown' && edge.label === 'barrel_wildcard'));
  assert.ok(result.edges.some((edge) => edge.from === 'src/stub.pyi' && edge.kind === 'type-only'));
  assert.ok(appEdges.every((edge) => edge.kind !== 'value-confirmed'));
});

test('Python ambiguous imports retain every candidate as unknown edges', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ano-python-edges-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const extractor = await createPythonExtractor();
  t.after(() => extractor.close());
  const modules = new Map<string, PythonParsedFile>([
    ['src/pkg/mod.py', extractor.parse('src/pkg/mod.py', 'def run():\n    return 1\n')],
    ['lib/pkg/mod.py', extractor.parse('lib/pkg/mod.py', 'def run():\n    return 1\n')],
    ['src/app.py', extractor.parse('src/app.py', 'from pkg.mod import run\n')],
  ]);
  const context = await createPythonResolutionContext(root, modules.keys());
  context.roots = ['src', 'lib'];
  const result = buildPythonImportEdges(context, modules);
  const candidates = result.edges.filter((edge) => edge.from === 'src/app.py');
  assert.deepEqual(candidates.map((edge) => edge.to).sort(), ['lib/pkg/mod.py', 'src/pkg/mod.py']);
  assert.ok(candidates.every((edge) => edge.kind === 'unknown'));
  assert.ok(result.caveats.some((caveat) => caveat.pattern === 'python-import-ambiguous'));
});

test('Python reexport cycles and over-budget chains terminate without confirmed coverage', async (t) => {
  const sources: Record<string, string> = {
    'src/a.py': 'from b import run\n',
    'src/b.py': 'from a import run\n',
    'src/app.py': 'from a import run\nfrom layer0 import finish\n',
  };
  for (let index = 0; index < 14; index += 1) sources[`src/layer${index}.py`] = `from layer${index + 1} import finish\n`;
  sources['src/layer14.py'] = 'def finish():\n    return 1\n';
  const result = await graph(t, sources);
  const appEdges = result.edges.filter((edge) => edge.from === 'src/app.py');
  assert.equal(appEdges.length, 2);
  assert.ok(appEdges.every((edge) => edge.kind === 'unknown' && edge.provenance === 'heuristic' && edge.label === 'depth_limit'));
  assert.ok(result.caveats.some((caveat) => caveat.pattern === 'python-reexport'));
});

test('Python stub targets and stub reexports never become runtime coverage', async (t) => {
  const result = await graph(t, {
    'src/stub.pyi': 'from impl import run\n',
    'src/impl.py': 'def run():\n    return 1\n',
    'src/decl.pyi': 'def declared(): ...\n',
    'src/app.py': 'from stub import run\nfrom decl import declared\nimport decl\n',
  });
  assert.ok(result.edges.length > 0);
  assert.ok(result.edges.every((edge) => edge.kind === 'type-only'));
});

test('Python namespace child imports resolve without inventing package files', async (t) => {
  const result = await graph(t, {
    'src/ns/impl.py': 'def run():\n    return 1\n',
    'src/app.py': 'from ns import impl\n',
  });
  assert.deepEqual(result.edges, [{ from: 'src/app.py', to: 'src/ns/impl.py', kind: 'value-confirmed', provenance: 'resolved', importedNames: ['impl'] }]);
});

test('Python dotted unaliased imports bind the root module during named reexport', async (t) => {
  const result = await graph(t, {
    'src/pkg/__init__.py': 'import outer.child\n',
    'src/outer/__init__.py': 'ROOT = 1\n',
    'src/outer/child.py': 'CHILD = 1\n',
    'src/app.py': 'from pkg import outer\n',
  });
  assert.deepEqual(result.edges.filter((edge) => edge.from === 'src/app.py'), [{ from: 'src/app.py', to: 'src/outer/__init__.py', kind: 'value-confirmed', provenance: 'resolved', importedNames: ['outer'] }]);
});

test('Python unresolved wildcards and heuristic imports stay advisory with caveats', async (t) => {
  const result = await graph(t, {
    'src/app.py': 'if flag:\n    from missing import name\ndef later():\n    import absent\nfrom external import *\n',
  });
  assert.equal(result.edges.length, 3);
  assert.ok(result.edges.every((edge) => edge.kind === 'unknown' && edge.provenance === 'heuristic'));
  assert.deepEqual(result.edges.map((edge) => edge.label).sort(), ['barrel_wildcard', 'conditional_import', 'lazy_import']);
  assert.equal(result.caveats.length, 3);
});

test('Python malformed source imports and conditional assignments cannot prove coverage', async (t) => {
  const result = await graph(t, {
    'src/impl.py': 'if flag:\n    run = 1\n',
    'src/broken.py': 'from impl import run\ndef broken(:\n',
    'src/app.py': 'from impl import run\n',
  });
  assert.ok(result.edges.length > 0);
  assert.ok(result.edges.every((edge) => edge.kind === 'unknown'));
  assert.ok(result.caveats.some((caveat) => caveat.pattern === 'python-syntax-error'));
});

test('Python class-local imports are not module reexports and conditional declarations stay advisory', async (t) => {
  const result = await graph(t, {
    'src/pkg/__init__.py': 'class Container:\n    from .impl import run\n',
    'src/pkg/impl.py': 'def run():\n    return 1\n',
    'src/conditional.py': 'if flag:\n    def maybe():\n        return 1\n',
    'src/app.py': 'from pkg import run\nfrom conditional import maybe\n',
  });
  const appEdges = result.edges.filter((edge) => edge.from === 'src/app.py');
  assert.equal(appEdges.length, 2);
  assert.ok(appEdges.every((edge) => edge.kind === 'unknown'));
  assert.ok(appEdges.every((edge) => edge.to !== 'src/pkg/impl.py'));
  assert.ok(result.edges.some((edge) => edge.from === 'src/pkg/__init__.py' && edge.to === 'src/pkg/impl.py' && edge.kind === 'value-confirmed'));
});

test('Python module reexports ignore class-local bindings of the same name', async (t) => {
  const result = await graph(t, {
    'src/pkg/__init__.py': 'from .impl import run\nclass Container:\n    from .other import run\n',
    'src/pkg/impl.py': 'def run():\n    return 1\n',
    'src/pkg/other.py': 'def run():\n    return 2\n',
    'src/app.py': 'from pkg import run\n',
  });
  assert.deepEqual(result.edges.filter((edge) => edge.from === 'src/app.py'), [{ from: 'src/app.py', to: 'src/pkg/impl.py', kind: 'value-confirmed', provenance: 'resolved', importedNames: ['run'] }]);
});

test('Python sys.path changes are caveats and dynamic loaders do not create import edges', async (t) => {
  const result = await graph(t, {
    'src/app.py': 'import sys\nsys.path.append("outside")\nimportlib.import_module("ghost")\n__import__("other")\n',
  });
  assert.ok(result.caveats.some((caveat) => caveat.pattern === 'python-sys-path'));
  assert.ok(result.edges.every((edge) => edge.to !== 'ghost' && edge.to !== 'other'));
});
