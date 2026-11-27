/**
 * PY-07 / M23b: Python L1 extractor (tree-sitter-python WASM).
 *
 * These cases use the real grammar (no mocks). They pin the ADR-014 §5
 * contract: L1 symbols, raw import bindings with contexts/provenance,
 * literal `__all__`, `.pyi` type-only imports and located static blind spots.
 * Every case also proves extraction stays deterministic and interpreter-free:
 * the sources are parsed, never executed.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createPythonExtractor,
  PYTHON_AST_DEPTH_LIMIT,
  PYTHON_EXTENSIONS,
  PYTHON_SCOPE_DEPTH_LIMIT,
  type PythonParsedFile,
} from '../../src/structure/extractors/python.ts';

test('extracts classes, functions, async methods and decorator names only', async () => {
  const extractor = await createPythonExtractor();
  try {
    const parsed = extractor.parse('pkg/service.py', [
      '@module_decorator',
      'class Service:',
      '    @classmethod',
      '    def build(cls): ...',
      '    @pkg.cache(maxsize=10)',
      '    async def fetch(self): ...',
      '',
      'def top(): pass',
      'async def background(): pass',
      '',
    ].join('\n'));
    const service = parsed.definitions.find((entry) => entry.qualifiedName === 'Service');
    assert.equal(service?.form, 'class');
    assert.equal(service?.kind, 'value');
    assert.equal(service?.startLine, 2);
    assert.deepEqual(service?.decorators, ['module_decorator']);
    const build = parsed.definitions.find((entry) => entry.qualifiedName === 'Service.build');
    assert.equal(build?.form, 'function');
    assert.equal(build?.ownerClass, 'Service');
    assert.equal(build?.isAsync, undefined);
    assert.deepEqual(build?.decorators, ['classmethod']);
    const fetch = parsed.definitions.find((entry) => entry.qualifiedName === 'Service.fetch');
    assert.equal(fetch?.isAsync, true);
    // Decorator arguments are never interpreted, only the dotted name is kept.
    assert.deepEqual(fetch?.decorators, ['pkg.cache']);
    assert.deepEqual(parsed.definitions.find((entry) => entry.qualifiedName === 'top')?.decorators, undefined);
    assert.equal(parsed.definitions.find((entry) => entry.qualifiedName === 'background')?.isAsync, true);
    assert.deepEqual(parsed.namedExports, []);
    assert.equal(parsed.language, 'python');
    assert.deepEqual(parsed.module, { path: 'pkg/service.py', name: 'service', isPackage: false, isStub: false });
    assert.equal(parsed.scope?.zeroDeclaration, false);
  } finally {
    extractor.close();
  }
});

test('nested classes and functions receive dotted qualified names and scope counts', async () => {
  const extractor = await createPythonExtractor();
  try {
    const parsed = extractor.parse('nested.py', [
      'class Outer:',
      '    class Inner:',
      '        def method(self): pass',
      '    def outer(self):',
      '        def inner(): pass',
      'def factory():',
      '    class Local: pass',
      '',
    ].join('\n'));
    assert.deepEqual(parsed.definitions.map((entry) => entry.qualifiedName), [
      'Outer',
      'Outer.Inner',
      'Outer.Inner.method',
      'Outer.outer',
      'Outer.outer.inner',
      'factory',
      'factory.Local',
    ]);
    assert.equal(parsed.definitions.find((entry) => entry.qualifiedName === 'Outer.Inner.method')?.ownerClass, 'Outer.Inner');
    assert.equal(parsed.scope?.localDefinitions, 2);
    assert.equal(parsed.scope?.localMembers, 0);
    assert.equal(parsed.scope?.iifeCount, 0);
  } finally {
    extractor.close();
  }
});

test('records module-level assignment targets and ignores local bindings', async () => {
  const extractor = await createPythonExtractor();
  try {
    const parsed = extractor.parse('assignments.py', [
      'MODULE = 1',
      'A, B = 1, 2',
      '[C, D] = (3, 4)',
      'X = Y = 5',
      'ANNOTATED: int = 6',
      'ONLY_ANNOTATION: int',
      '',
      'def f():',
      '    local = 1',
      'class K:',
      '    attr = 2',
      '',
    ].join('\n'));
    const names = new Set(parsed.definitions.filter((entry) => entry.form === 'assignment').map((entry) => entry.name));
    for (const expected of ['MODULE', 'A', 'B', 'C', 'D', 'X', 'Y', 'ANNOTATED']) assert.ok(names.has(expected), `${expected} must be a module-level assignment`);
    for (const skipped of ['ONLY_ANNOTATION', 'local', 'attr']) assert.ok(!names.has(skipped), `${skipped} must not become a module-level symbol`);
    assert.ok(!parsed.definitions.some((entry) => entry.qualifiedName === 'K.attr'));
    const targets = new Map(parsed.assignments.map((entry) => [entry.name, entry]));
    assert.equal(targets.get('A')?.target, 'A, B');
    assert.equal(targets.get('C')?.target, '[C, D]');
    assert.equal(targets.get('X')?.target, 'X');
    assert.equal(targets.get('ANNOTATED')?.conditional, false);
  } finally {
    extractor.close();
  }
});

test('literal __all__ supports lists, tuples, +=, partial concatenation and dynamic values', async () => {
  const extractor = await createPythonExtractor();
  try {
    const literal = extractor.parse('all1.py', "__all__ = ['a', 'b']\n");
    assert.deepEqual(literal.dunderAll, { names: ['a', 'b'], literal: true, line: 1 });
    assert.ok(literal.definitions.some((entry) => entry.name === '__all__' && entry.form === 'assignment'));

    const augmented = extractor.parse('all2.py', "__all__ = ['a']\n__all__ += ('b',)\n");
    assert.deepEqual(augmented.dunderAll, { names: ['a', 'b'], literal: true, line: 1 });

    const annotated = extractor.parse('all3.py', "__all__: list[str] = ('a',)\n");
    assert.deepEqual(annotated.dunderAll, { names: ['a'], literal: true, line: 1 });

    const extended = extractor.parse('all4.py', "__all__ = ['a']\n__all__.extend(['z'])\n");
    assert.deepEqual(extended.dunderAll, { names: ['a', 'z'], literal: true, line: 1 });

    const partial = extractor.parse('all5.py', "__all__ = ['a'] + EXTRA\n");
    assert.deepEqual(partial.dunderAll, { names: ['a'], literal: false, line: 1 });

    const dynamic = extractor.parse('all6.py', '__all__ = get_names()\n');
    assert.deepEqual(dynamic.dunderAll, { names: [], literal: false, line: 1 });
  } finally {
    extractor.close();
  }
});

test('records absolute, relative, aliased and wildcard import bindings', async () => {
  const extractor = await createPythonExtractor();
  try {
    const parsed = extractor.parse('pkg/mod.py', [
      'import os',
      'import os.path as osp, sys',
      'import a.b.c',
      'from typing import TYPE_CHECKING',
      'from . import sibling',
      'from ..pkg.mod import alpha as a, beta',
      'from pkg import *',
      'from __future__ import annotations',
      '',
    ].join('\n'));
    const os = parsed.imports.find((entry) => entry.specifier === 'os');
    assert.equal(os?.form, 'import');
    assert.equal(os?.level, 0);
    assert.equal(os?.provenance, 'value-confirmed');
    assert.deepEqual(os?.bindings, [{ localName: 'os', importedName: 'os', aliased: false }]);

    const aliased = parsed.imports.find((entry) => entry.specifier === 'os.path');
    assert.deepEqual(aliased?.bindings, [{ localName: 'osp', importedName: 'os.path', aliased: true }]);
    assert.deepEqual(aliased?.localNames, ['osp']);

    const deepImport = parsed.imports.find((entry) => entry.specifier === 'a.b.c');
    assert.deepEqual(deepImport?.importedNames, ['a.b.c']);
    // `import a.b.c` binds the root package, not the dotted path.
    assert.deepEqual(deepImport?.localNames, ['a']);
    assert.deepEqual(deepImport?.bindings, [{ localName: 'a', importedName: 'a.b.c', aliased: false }]);

    const typing = parsed.imports.find((entry) => entry.specifier === 'typing');
    assert.deepEqual(typing?.importedNames, ['TYPE_CHECKING']);

    const sibling = parsed.imports.find((entry) => entry.specifier === '.');
    assert.equal(sibling?.level, 1);
    assert.equal(sibling?.module, '');
    assert.deepEqual(sibling?.localNames, ['sibling']);

    const relative = parsed.imports.find((entry) => entry.specifier === '..pkg.mod');
    assert.equal(relative?.level, 2);
    assert.equal(relative?.module, 'pkg.mod');
    assert.deepEqual(relative?.importedNames, ['alpha', 'beta']);
    assert.deepEqual(relative?.localNames, ['a', 'beta']);

    const wildcard = parsed.imports.find((entry) => entry.specifier === 'pkg' && entry.wildcard);
    assert.equal(wildcard?.provenance, 'heuristic');
    assert.equal(wildcard?.heuristic, 'barrel_wildcard');
    assert.equal(wildcard?.typeOnly, false);
    assert.deepEqual(wildcard?.localNames, ['*']);

    const future = parsed.imports.find((entry) => entry.specifier === '__future__');
    assert.equal(future?.module, '__future__');
    assert.deepEqual(future?.importedNames, ['annotations']);
    for (const entry of parsed.imports) {
      assert.equal(entry.dynamic, false);
      assert.equal(entry.require, false);
      assert.equal(entry.literal, true);
    }
  } finally {
    extractor.close();
  }
});

test('import contexts keep TYPE_CHECKING type-only and never confirm heuristic contexts', async () => {
  const extractor = await createPythonExtractor();
  try {
    const parsed = extractor.parse('contexts.py', [
      'from typing import TYPE_CHECKING',
      'if TYPE_CHECKING:',
      '    from pkg.types import Model',
      'if not TYPE_CHECKING:',
      '    import runtime_only',
      'if typing.TYPE_CHECKING:',
      '    from pkg.other import Other',
      'if TYPE_CHECKING and flag:',
      '    import mixed_guard',
      'try:',
      '    import fast',
      'except ImportError:',
      '    import slow',
      'def load():',
      '    import lazy',
      '    try:',
      '        import lazy_try',
      '    except ImportError:',
      '        pass',
      '    if TYPE_CHECKING:',
      '        from pkg import T',
      '',
    ].join('\n'));
    const bySpecifier = (specifier: string) => parsed.imports.find((entry) => entry.specifier === specifier);
    const model = bySpecifier('pkg.types');
    assert.equal(model?.context, 'type-checking');
    assert.equal(model?.provenance, 'type-only');
    assert.equal(model?.typeOnly, true);
    assert.deepEqual(model?.typeOnlyNames, ['Model']);

    assert.equal(bySpecifier('runtime_only')?.context, 'conditional-import');
    assert.equal(bySpecifier('runtime_only')?.provenance, 'heuristic');
    assert.equal(bySpecifier('pkg.other')?.context, 'type-checking');
    assert.equal(bySpecifier('pkg.other')?.provenance, 'type-only');
    // `TYPE_CHECKING and flag` is a runtime condition; it must stay heuristic.
    assert.equal(bySpecifier('mixed_guard')?.context, 'conditional-import');
    assert.equal(bySpecifier('mixed_guard')?.provenance, 'heuristic');

    assert.equal(bySpecifier('fast')?.heuristic, 'conditional_import');
    assert.equal(bySpecifier('slow')?.heuristic, 'conditional_import');
    assert.equal(bySpecifier('lazy')?.context, 'lazy-import');
    assert.equal(bySpecifier('lazy')?.heuristic, 'lazy_import');
    // Function body wins over try for the lazy label; both are heuristic.
    assert.equal(bySpecifier('lazy_try')?.context, 'lazy-import');
    assert.equal(bySpecifier('lazy_try')?.provenance, 'heuristic');
    assert.equal(bySpecifier('pkg')?.context, 'type-checking');
    assert.equal(bySpecifier('pkg')?.provenance, 'type-only');

    for (const entry of parsed.imports) {
      if (entry.context !== 'module' || entry.wildcard) {
        assert.notEqual(entry.provenance, 'value-confirmed', `${entry.specifier} must not be value-confirmed`);
      }
    }
  } finally {
    extractor.close();
  }
});

test('class-body and with-body imports execute at module load; loop bodies stay conditional', async () => {
  const extractor = await createPythonExtractor();
  try {
    const parsed = extractor.parse('loadtime.py', [
      'class C:',
      '    import inner',
      "with open('x') as handle:",
      '    import ctx',
      'for item in items:',
      '    import each',
      'while False:',
      '    import never',
      '',
    ].join('\n'));
    const bySpecifier = (specifier: string) => parsed.imports.find((entry) => entry.specifier === specifier);
    assert.equal(bySpecifier('inner')?.context, 'module');
    assert.equal(bySpecifier('inner')?.provenance, 'value-confirmed');
    assert.equal(bySpecifier('ctx')?.context, 'module');
    assert.equal(bySpecifier('ctx')?.provenance, 'value-confirmed');
    assert.equal(bySpecifier('each')?.context, 'conditional-import');
    assert.equal(bySpecifier('each')?.provenance, 'heuristic');
    assert.equal(bySpecifier('never')?.context, 'conditional-import');
    assert.ok(parsed.definitions.some((entry) => entry.qualifiedName === 'C'));
  } finally {
    extractor.close();
  }
});

test('.pyi stubs record every import as type-only while preserving context', async () => {
  const extractor = await createPythonExtractor();
  try {
    const parsed = extractor.parse('pkg/api.pyi', [
      'from typing import Any',
      'from .base import Base',
      'try:',
      '    import fast',
      'except ImportError:',
      '    pass',
      'def f():',
      '    import lazy',
      '',
    ].join('\n'));
    assert.equal(parsed.stub, true);
    assert.equal(parsed.module.isStub, true);
    assert.equal(parsed.imports.length, 4);
    for (const entry of parsed.imports) {
      assert.equal(entry.stub, true);
      assert.equal(entry.typeOnly, true);
      assert.equal(entry.provenance, 'type-only');
      assert.deepEqual(entry.typeOnlyNames, entry.importedNames);
    }
    assert.equal(parsed.imports.find((entry) => entry.specifier === 'fast')?.context, 'conditional-import');
    assert.equal(parsed.imports.find((entry) => entry.specifier === 'lazy')?.context, 'lazy-import');
    const f = parsed.definitions.find((entry) => entry.qualifiedName === 'f');
    assert.equal(f?.stub, true);
  } finally {
    extractor.close();
  }
});

test('records dynamic-load, eval, reflection and registry blind spots without edges', async () => {
  const extractor = await createPythonExtractor();
  try {
    const parsed = extractor.parse('blind.py', [
      'import importlib as il',
      'from importlib import import_module as load',
      'import sys as system',
      "__import__('pkg.one')",
      "il.import_module('pkg.two')",
      'load(name)',
      "exec('code')",
      "eval('code')",
      "getattr(module, 'attr')",
      "builtins.getattr(module, 'attr')",
      "system.path.append('src')",
      "system.path[0] = 'lib'",
      "INSTALLED_APPS = ['django.contrib.admin', 'app.core']",
      "ROOT_URLCONF = 'proj.urls'",
      '',
    ].join('\n'));
    assert.equal(parsed.dynamicLoads, 3);
    assert.equal(parsed.unresolvedDynamicLoads, 1);
    const dynamic = parsed.blindSpots?.filter((entry) => entry.kind === 'dynamic-load') ?? [];
    assert.equal(dynamic.length, 3);
    assert.ok(dynamic.every((entry) => entry.pattern === 'dynamic-import' && entry.tier === 'unknown'));
    assert.deepEqual(dynamic.map((entry) => entry.target).sort(), ['name', 'pkg.one', 'pkg.two']);
    assert.equal(parsed.blindSpots?.filter((entry) => entry.kind === 'eval').length, 2);
    assert.equal(parsed.blindSpots?.filter((entry) => entry.kind === 'reflection').length, 2);
    const registry = parsed.blindSpots?.filter((entry) => entry.kind === 'registry-scan') ?? [];
    assert.equal(registry.length, 3);
    assert.deepEqual(registry.map((entry) => entry.target).sort(), ['app.core', 'django.contrib.admin', 'proj.urls']);
    assert.ok(parsed.blindSpots?.every((entry) => entry.tier === 'unknown'));
    // Dynamic loads are evidence only, never ParsedImport edges.
    assert.deepEqual(parsed.imports.map((entry) => entry.specifier), ['importlib', 'importlib', 'sys']);
    assert.ok(parsed.imports.every((entry) => entry.dynamic === false));
    assert.deepEqual(parsed.sysPathMutations.map((entry) => entry.method), ['append', 'assign']);
    assert.ok(parsed.sysPathMutations.every((entry) => entry.reason.includes('sys.path')));
    assert.ok(!parsed.blindSpots?.some((entry) => entry.line === 11 || entry.line === 12));
  } finally {
    extractor.close();
  }
});

test('malformed and binary sources never throw and report parser errors', async () => {
  const extractor = await createPythonExtractor();
  try {
    const brokenDefinition = extractor.parse('broken.py', 'def broken(:\n    pass\n');
    assert.equal(brokenDefinition.syntax.hasError, true);
    assert.ok(brokenDefinition.definitions.some((entry) => entry.name === 'broken'));

    const brokenBlock = extractor.parse('broken-block.py', 'if True\n    pass\n');
    assert.equal(brokenBlock.syntax.hasError, true);
    assert.equal(brokenBlock.syntax.errorCount, 1);
    assert.equal(brokenBlock.syntax.firstErrorLine, 1);

    const binary = '\u0000\u0001\u0002 not python \u0003\u0004';
    const binaryParsed = extractor.parse('binary.py', binary);
    assert.equal(binaryParsed.syntax.hasError, true);
    assert.equal(binaryParsed.definitions.length, 0);

    const empty = extractor.parse('empty.py', '');
    assert.equal(empty.syntax.hasError, false);
    assert.equal(empty.scope?.zeroDeclaration, true);
    assert.equal(empty.scope?.zeroStaticDependency, false);
    assert.equal(empty.imports.length, 0);
  } finally {
    extractor.close();
  }
});

test('zero-symbol and zero-static-dependency signals are explicit', async () => {
  const extractor = await createPythonExtractor();
  try {
    const constants = extractor.parse('constants.py', 'VALUE = 1\n');
    assert.equal(constants.scope?.zeroDeclaration, false);
    assert.equal(constants.scope?.zeroStaticDependency, true);
    const importsOnly = extractor.parse('imports_only.py', 'import os\n');
    assert.equal(importsOnly.scope?.zeroDeclaration, true);
    assert.equal(importsOnly.scope?.zeroStaticDependency, false);
  } finally {
    extractor.close();
  }
});

test('AST depth budget stops at 1000 with explicit budget evidence', async () => {
  const extractor = await createPythonExtractor();
  try {
    const source = `${'f('.repeat(1200)}1${')'.repeat(1200)}\n`;
    const parsed = extractor.parse('deep.py', source);
    assert.equal(parsed.budgets.astDepthLimit, PYTHON_AST_DEPTH_LIMIT);
    assert.equal(parsed.budgets.depthLimitExceeded, true);
    assert.equal(parsed.syntax.hasError, false);
    assert.ok(parsed.scope?.semanticGaps.some((gap) => gap.pattern === 'depth-limit' && gap.reason.includes('STRUCTURE_BUDGET_EXCEEDED')));
  } finally {
    extractor.close();
  }
});

test('nested-scope budget stops at 16 with explicit budget evidence', async () => {
  const extractor = await createPythonExtractor();
  try {
    const depth = 20;
    const source = `${Array.from({ length: depth }, (_, index) => `${'    '.repeat(index)}class C${index}:`).join('\n')}\n${'    '.repeat(depth)}pass\n`;
    const parsed = extractor.parse('deep-scopes.py', source);
    assert.equal(parsed.budgets.scopeDepthLimit, PYTHON_SCOPE_DEPTH_LIMIT);
    assert.equal(parsed.budgets.scopeLimitExceeded, true);
    assert.ok(parsed.definitions.length <= PYTHON_SCOPE_DEPTH_LIMIT + 1);
    assert.ok(parsed.scope?.semanticGaps.some((gap) => gap.pattern === 'depth-limit' && gap.reason.includes(`nested scope deeper than ${PYTHON_SCOPE_DEPTH_LIMIT}`)));
  } finally {
    extractor.close();
  }
});

test('type alias statements become type symbols', async () => {
  const extractor = await createPythonExtractor();
  try {
    const parsed = extractor.parse('alias.py', 'type Alias = int | str\n');
    const alias = parsed.definitions.find((entry) => entry.qualifiedName === 'Alias');
    assert.equal(alias?.form, 'type-alias');
    assert.equal(alias?.kind, 'type');
    assert.equal(alias?.startLine, 1);
  } finally {
    extractor.close();
  }
});

test('duplicate definitions merge deterministically without duplicate symbols', async () => {
  const extractor = await createPythonExtractor();
  try {
    const parsed = extractor.parse('overload.py', [
      'class C:',
      '    @first',
      '    def m(self): ...',
      '    @second',
      '    async def m(self): ...',
      '',
    ].join('\n'));
    const matches = parsed.definitions.filter((entry) => entry.qualifiedName === 'C.m');
    assert.equal(matches.length, 1);
    assert.deepEqual(matches[0]?.decorators, ['first', 'second']);
    assert.equal(matches[0]?.isAsync, true);
    assert.equal(matches[0]?.startLine, 3);
  } finally {
    extractor.close();
  }
});

test('repeated extraction is byte-identical across calls and extractors', async () => {
  const source = [
    'from typing import TYPE_CHECKING',
    'import importlib',
    'class Service:',
    '    @cached',
    '    async def fetch(self):',
    '        import lazy',
    'if TYPE_CHECKING:',
    '    from pkg.types import Model',
    'try:',
    '    import fast',
    'except ImportError:',
    '    import slow',
    "__all__ = ['Service', 'top']",
    'def top(): pass',
    "importlib.import_module('pkg.dyn')",
    "sys.path.append('src')",
    '',
  ].join('\n');
  const first = await createPythonExtractor();
  const second = await createPythonExtractor();
  try {
    const a = first.parse('det.py', source);
    const b = first.parse('det.py', source);
    const c = second.parse('det.py', source);
    assert.deepEqual(a, b);
    assert.deepEqual(a, c);
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  } finally {
    first.close();
    second.close();
  }
});

test('supported extensions, unsupported input and close semantics', async () => {
  assert.deepEqual([...PYTHON_EXTENSIONS], ['.py', '.pyi']);
  assert.ok(Object.isFrozen(PYTHON_EXTENSIONS));
  const extractor = await createPythonExtractor();
  assert.equal(extractor.parse('UPPER.PY', 'X = 1\n').definitions[0]?.name, 'X');
  assert.throws(() => extractor.parse('module.pyc', 'X = 1\n'), /Unsupported extension: module\.pyc/);
  assert.throws(() => extractor.parse('module.pyw', 'X = 1\n'), /Unsupported extension: module\.pyw/);
  extractor.close();
  extractor.close();
  assert.throws(() => extractor.parse('closed.py', 'X = 1\n'), /Unsupported extension: closed\.py/);
});

test('class/function body imports record binding scope while keeping the load edge', async () => {
  const extractor = await createPythonExtractor();
  try {
    const parsed = extractor.parse('pkg/__init__.py', [
      'from .impl import base',
      'class C:',
      '    from .impl import run',
      '    class Inner:',
      '        import deep',
      'def loader():',
      '    from .impl import lazy',
      'if flag:',
      '    from .impl import conditional_name',
      '',
    ].join('\n'));
    assert.equal(parsed.imports.find((entry) => entry.importedNames.includes('base'))?.scope, undefined);
    const run = parsed.imports.find((entry) => entry.importedNames.includes('run'));
    assert.equal(run?.scope, 'C');
    // The binding is class-local, but the import still executes at module load.
    assert.equal(run?.context, 'module');
    assert.equal(run?.provenance, 'value-confirmed');
    assert.equal(parsed.imports.find((entry) => entry.importedNames.includes('deep'))?.scope, 'C.Inner');
    const lazy = parsed.imports.find((entry) => entry.importedNames.includes('lazy'));
    assert.equal(lazy?.scope, 'loader');
    assert.equal(lazy?.context, 'lazy-import');
    // Module-level conditional import still binds a module global (if it runs).
    const conditional = parsed.imports.find((entry) => entry.importedNames.includes('conditional_name'));
    assert.equal(conditional?.scope, undefined);
    assert.equal(conditional?.context, 'conditional-import');
  } finally {
    extractor.close();
  }
});

test('definitions under runtime conditionals carry the conditional flag', async () => {
  const extractor = await createPythonExtractor();
  try {
    const parsed = extractor.parse('conditional-defs.py', [
      'def stable(): ...',
      'if flag:',
      '    def maybe(): ...',
      '    class Maybe: ...',
      '    MAYBE = 1',
      'try:',
      '    def fallback(): ...',
      'except ImportError:',
      '    def fallback(): ...',
      'if TYPE_CHECKING:',
      '    def typed(): ...',
      'if other_flag:',
      '    def both(): ...',
      'def both(): ...',
      'if another_flag:',
      '    def cond_only(): ...',
      '',
    ].join('\n'));
    const definition = (qualifiedName: string) => parsed.definitions.find((entry) => entry.qualifiedName === qualifiedName);
    assert.equal(definition('stable')?.conditional, undefined);
    assert.equal(definition('maybe')?.conditional, true);
    assert.equal(definition('Maybe')?.conditional, true);
    assert.equal(definition('MAYBE')?.conditional, true);
    assert.equal(definition('fallback')?.conditional, true);
    // TYPE_CHECKING definitions are type-only, not runtime-conditional names.
    assert.equal(definition('typed')?.conditional, undefined);
    assert.equal(definition('typed')?.typeOnly, true);
    // An unconditional later binding clears the conditional flag on merge.
    assert.equal(definition('both')?.conditional, undefined);
    assert.equal(definition('cond_only')?.conditional, true);
  } finally {
    extractor.close();
  }
});

test('conditional definition merges keep the flag only when every binding is conditional', async () => {
  const extractor = await createPythonExtractor();
  try {
    for (const declaration of [
      (name: string) => `def ${name}(): ...`,
      (name: string) => `class ${name}: ...`,
      (name: string) => `${name} = 1`,
      (name: string) => `type ${name} = int`,
    ]) {
      const parsed = extractor.parse('conditional-merge.py', [
        declaration('stable_first'),
        'if first_flag:',
        `    ${declaration('stable_first')}`,
        `    ${declaration('stable_last')}`,
        `    ${declaration('conditional_only')}`,
        'if second_flag:',
        `    ${declaration('conditional_only')}`,
        declaration('stable_last'),
        '',
      ].join('\n'));
      assert.equal(parsed.syntax.hasError, false);
      const definitions = new Map(parsed.definitions.map((entry) => [entry.qualifiedName, entry]));
      assert.equal(definitions.size, 3);
      assert.equal(definitions.get('stable_first')?.conditional, undefined, declaration('stable_first'));
      assert.equal(definitions.get('stable_last')?.conditional, undefined, declaration('stable_last'));
      assert.equal(definitions.get('conditional_only')?.conditional, true, declaration('conditional_only'));
    }
  } finally {
    extractor.close();
  }
});

test('literal strings and __all__ mutations preserve only statically known names', async () => {
  const extractor = await createPythonExtractor();
  try {
    const parsed = extractor.parse('all-literals.py', [
      "__all__ = ('a' 'b', ('c' + 'd'))",
      "__all__ += ['e', *EXTRA]",
      "__all__.append('f')",
      "__all__.append(dynamic_name)",
      "__all__.extend(['g', 'h'])",
      "__all__.remove('a')",
      "__all__.insert(0, 'i')",
      "__all__.pop()",
      "__all__.clear()",
      '',
    ].join('\n'));
    assert.equal(parsed.syntax.hasError, false);
    assert.deepEqual(parsed.dunderAll?.names, ['ab', 'cd', 'e', 'f', 'g', 'h']);
    assert.equal(parsed.dunderAll?.literal, false);
    assert.equal(parsed.dunderAll?.line, 1);

    const noArguments = extractor.parse('all-no-arguments.py', '__all__.append()\n');
    assert.equal(noArguments.dunderAll, undefined, 'a malformed empty call must not invent an __all__ binding');
  } finally {
    extractor.close();
  }
});

test('elif/else imports stay conditional and unknown sys.path lookalikes stay untouched', async () => {
  const extractor = await createPythonExtractor();
  try {
    const parsed = extractor.parse('clauses.py', [
      'import importlib',
      'if primary:',
      '    import first',
      'elif secondary:',
      '    import second',
      'else:',
      '    import fallback',
      "other.path.append('src')",
      "importlib.import_module(name='pkg.named')",
      'importlib.import_module()',
      '',
    ].join('\n'));
    for (const specifier of ['first', 'second', 'fallback']) {
      assert.equal(parsed.imports.find((entry) => entry.specifier === specifier)?.provenance, 'heuristic');
    }
    assert.deepEqual(parsed.sysPathMutations, []);
    const dynamic = parsed.blindSpots?.filter((entry) => entry.kind === 'dynamic-load') ?? [];
    assert.deepEqual(dynamic.map((entry) => entry.target), ['pkg.named', undefined]);
    assert.equal(parsed.dynamicLoads, 2);
    assert.equal(parsed.unresolvedDynamicLoads, 1);
  } finally {
    extractor.close();
  }
});

test('multiple independent scope-budget gaps and duplicate imports sort deterministically', async () => {
  const extractor = await createPythonExtractor();
  try {
    const deepScope = (prefix: string) => `${Array.from({ length: 18 }, (_, index) => `${'    '.repeat(index)}class ${prefix}${index}:`).join('\n')}\n${'    '.repeat(18)}pass\n`;
    const parsed = extractor.parse('multiple-gaps.py', `${deepScope('A')}\n${deepScope('B')}import os; import os\n`);
    assert.equal(parsed.budgets.scopeLimitExceeded, true);
    assert.ok((parsed.scope?.semanticGaps.length ?? 0) >= 2);
    assert.deepEqual(parsed.imports.map((entry) => entry.specifier), ['os', 'os']);
    assert.deepEqual(parsed.imports.map((entry) => entry.localNames), [['os'], ['os']]);
  } finally {
    extractor.close();
  }
});

test('incomplete class and function declarations retain explicit syntax errors', async () => {
  const extractor = await createPythonExtractor();
  try {
    for (const source of ['class Missing\n', 'def missing()\n', 'from import name\n']) {
      const parsed = extractor.parse('incomplete.py', source);
      assert.equal(parsed.syntax.hasError, true, source);
      assert.ok(parsed.syntax.errorCount > 0, source);
    }
  } finally {
    extractor.close();
  }
});

test('scope-walk node budget fails closed with explicit evidence', async () => {
  const extractor = await createPythonExtractor();
  try {
    const parsed = extractor.parse('node-budget.py', '0\n'.repeat(200_001));
    assert.equal(parsed.syntax.hasError, false);
    assert.ok(parsed.scope?.semanticGaps.some((gap) => gap.reason.includes('nested-scope node budget exhausted')));
  } finally {
    extractor.close();
  }
});

test('blind-spot node budget stops a wide call without executing it', async () => {
  const extractor = await createPythonExtractor();
  try {
    const parsed = extractor.parse('blind-node-budget.py', `f(${Array.from({ length: 50_001 }, () => '0').join(',')})\n`);
    assert.equal(parsed.syntax.hasError, false);
    assert.ok(parsed.scope?.semanticGaps.some((gap) => gap.reason.includes('AST walk node budget exhausted')));
    assert.equal(parsed.dynamicLoads, 0);
  } finally {
    extractor.close();
  }
});

test('extractor source is static-only: no interpreter, process or filesystem access', async () => {
  const path = fileURLToPath(new URL('../../src/structure/extractors/python.ts', import.meta.url));
  const source = await readFile(path, 'utf8');
  for (const forbidden of ['node:child_process', 'spawn(', 'execFile', 'execSync', 'readFileSync', 'readFile(', 'readdir(', 'python.exe']) {
    assert.ok(!source.includes(forbidden), `extractor must not contain ${forbidden}`);
  }
});

test('PythonParsedFile remains assignable to the shared ParsedFile shape', async () => {
  const extractor = await createPythonExtractor();
  try {
    const parsed: PythonParsedFile = extractor.parse('shape.py', 'def f(): pass\n');
    // Shared fields consumed by structure analysis are all present.
    assert.equal(typeof parsed.file, 'string');
    assert.ok(Array.isArray(parsed.definitions));
    assert.ok(Array.isArray(parsed.namedExports));
    assert.ok(Array.isArray(parsed.imports));
    assert.equal(typeof parsed.dynamicLoads, 'number');
    assert.equal(typeof parsed.unresolvedDynamicLoads, 'number');
    assert.ok(Array.isArray(parsed.blindSpots));
    assert.ok(parsed.scope);
  } finally {
    extractor.close();
  }
});
