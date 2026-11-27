/**
 * T-153 / QF-04 shard C: TypeScript extractor AST-boundary edges.
 *
 * These inputs are real parse trees (no mocks): ambient declarations, nested
 * IIFE scopes, anonymous/named classes, dynamic specifier shapes and CommonJS
 * member forms. Every case targets a branch that the pre-T153 suite never fed
 * to the tree-sitter grammar.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createTsExtractor } from '../../src/structure/extractors/ts.ts';

test('ambient declarations are unwrapped into real definitions', async () => {
  const extractor = await createTsExtractor();
  try {
    const parsed = extractor.parse(
      'src/ambient.d.ts',
      ['declare const declaredValue: number;', 'declare function declaredFn(): void;', 'declare class DeclaredClass {}', ''].join('\n'),
    );
    const names = new Set(parsed.definitions.map((definition) => definition.name));
    assert.ok(names.has('declaredValue'), 'ambient const must be recorded');
    assert.ok(names.has('DeclaredClass'), 'ambient class must be recorded');
  } finally {
    extractor.close();
  }
});

test('nested IIFE scope records shorthand members, methods and duplicate definitions', async () => {
  const extractor = await createTsExtractor();
  try {
    const parsed = extractor.parse(
      'src/nested.js',
      [
        '(function () {',
        '  var dup = 1;',
        '  var dup = 2;',
        '  var known = 3;',
        '  var bag = { known, run() { return dup; } };',
        '  class Inner { field = 1; method() { return bag; } }',
        '  return Inner;',
        '})();',
        '',
      ].join('\n'),
    );
    assert.ok(parsed.scope, 'IIFE scope extraction must run');
    assert.ok(parsed.scope.localDefinitions >= 3, 'duplicate/known/class definitions must be captured');
    assert.ok(parsed.scope.localMembers >= 2, 'shorthand member and method must be captured');
  } finally {
    extractor.close();
  }
});

test('nested object literals beyond the scope depth record a located budget gap', async () => {
  const extractor = await createTsExtractor();
  try {
    const depth = 18;
    const source = `(function () {\n  const deep = ${'{a:'.repeat(depth)}1${'}'.repeat(depth)};\n  return deep;\n})();\n`;
    const parsed = extractor.parse('src/deep-object.js', source);
    assert.ok(parsed.scope, 'IIFE scope extraction must run');
    assert.ok(
      parsed.scope.semanticGaps.some((gap) => gap.pattern === 'depth-limit' && gap.reason.includes('STRUCTURE_BUDGET_EXCEEDED')),
      'deep nested object must stop with an explicit budget gap',
    );
  } finally {
    extractor.close();
  }
});

test('class declarations with fields and methods are walked inside IIFE scope', async () => {
  const extractor = await createTsExtractor();
  try {
    const parsed = extractor.parse(
      'src/class.js',
      [
        '(function () {',
        '  class Named { field = () => 1; method() { return field; } }',
        '  return Named;',
        '})();',
        '',
      ].join('\n'),
    );
    assert.ok(parsed.scope, 'IIFE scope extraction must run');
    assert.ok(parsed.scope.localDefinitions >= 1, 'named class must be recorded as a nested definition');
    assert.ok(parsed.scope.localMembers >= 2, 'class field and method must be recorded as nested members');
  } finally {
    extractor.close();
  }
});

test('dynamic load specifiers cover static template, concatenation and call expressions', async () => {
  const extractor = await createTsExtractor();
  try {
    const parsed = extractor.parse(
      'src/specifiers.js',
      [
        "require('./literal');",
        "require('./base/' + `seg`);",
        "require(path.join('a', 'b'));",
        'export const kept = 1;',
        '',
      ].join('\n'),
    );
    assert.equal(parsed.dynamicLoads, 3);
    const spots = parsed.blindSpots ?? [];
    assert.ok(spots.some((spot) => spot.kind === 'dynamic-load' && spot.tier === 'resolved'));
    assert.ok(spots.some((spot) => spot.kind === 'dynamic-load' && spot.tier === 'heuristic'));
    assert.ok(spots.some((spot) => spot.kind === 'dynamic-load' && spot.tier === 'unknown'));
  } finally {
    extractor.close();
  }
});

test('member expressions in new expressions produce a receiver-bearing call site', async () => {
  const extractor = await createTsExtractor();
  try {
    const parsed = extractor.parse('src/new.js', ['function build() { return new ns.Thing(); }', ''].join('\n'));
    const call = (parsed.calls ?? []).find((entry) => entry.kind === 'new');
    assert.ok(call, 'new expression must be recorded');
    assert.equal(call.receiver, 'ns');
    assert.equal(call.callee, 'Thing');
  } finally {
    extractor.close();
  }
});

test('CommonJS objects keep metadata values and shorthand/method members', async () => {
  const extractor = await createTsExtractor();
  try {
    const parsed = extractor.parse(
      'src/api.cjs',
      [
        'const known = 1;',
        'module.exports = {',
        "  name: 'tool',",
        '  id: 42,',
        '  enabled: true,',
        '  nothing: null,',
        '  description: { text: "not-a-scalar" },',
        '  [computed]: 1,',
        '  known,',
        '  run() { return known; },',
        '};',
        '',
      ].join('\n'),
    );
    const items = parsed.commonjsExports ?? [];
    const container = items.find((item) => item.qualifiedName === 'src/api.cjs#default');
    assert.ok(container, 'object export container must exist');
    const named = items.find((item) => item.qualifiedName === 'src/api.cjs#default.name');
    assert.equal(named?.metadata?.name, 'tool');
    const numeric = items.find((item) => item.qualifiedName === 'src/api.cjs#default.id');
    assert.equal(numeric?.metadata?.id, '42', 'numeric metadata must be preserved verbatim');
    const shorthand = items.find((item) => item.qualifiedName === 'src/api.cjs#default.known');
    assert.ok(shorthand, 'shorthand member must be recorded');
    const method = items.find((item) => item.qualifiedName === 'src/api.cjs#default.run');
    assert.equal(method?.executable, true, 'method_definition must be executable');
  } finally {
    extractor.close();
  }
});

test('module.exports fallback covers non-object non-callable expressions', async () => {
  const extractor = await createTsExtractor();
  try {
    const parsed = extractor.parse('src/primitive.cjs', ['module.exports = 42;', ''].join('\n'));
    const fallback = (parsed.commonjsExports ?? []).find((item) => item.qualifiedName === 'src/primitive.cjs#default');
    assert.ok(fallback, 'primitive module.exports must still be recorded');
    assert.equal(fallback.confidence, 'inferred');
    assert.equal(fallback.executable, false);
  } finally {
    extractor.close();
  }
});

test('pathological CommonJS nesting stops at the AST walk budget with evidence', async () => {
  const extractor = await createTsExtractor();
  try {
    const depth = 1002;
    const source = `module.exports = ${'{a:'.repeat(depth)}1${'}'.repeat(depth)};\n`;
    const parsed = extractor.parse('src/pathological.cjs', source);
    assert.ok(parsed.scope, 'scope extraction must run for CommonJS files');
    assert.ok(
      parsed.scope.semanticGaps.some((gap) => gap.pattern === 'depth-limit'),
      'over-deep CommonJS object must record a depth-limit gap',
    );
  } finally {
    extractor.close();
  }
});
