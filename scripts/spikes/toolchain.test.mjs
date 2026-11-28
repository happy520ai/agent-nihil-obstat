import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Language, Parser } from 'web-tree-sitter';

const require = createRequire(import.meta.url);

test('the isolated TypeScript toolchain exposes the compiler API used by S7', () => {
  const ts = require('typescript');
  for (const name of ['readConfigFile', 'parseJsonConfigFileContent', 'resolveModuleName']) {
    assert.equal(typeof ts[name], 'function', `${name} is required by S7`);
  }
  assert.equal(typeof ts.sys?.readFile, 'function');
});

for (const [grammar, source] of [
  ['typescript', 'export const value: number = 1;'],
  ['tsx', 'export const view = <div />;'],
  ['javascript', 'export const value = 1;'],
  ['python', 'def value():\n    return 1\n'],
]) {
  test(`the isolated tree-sitter runtime loads the shipped ${grammar} grammar`, async () => {
    await Parser.init();
    const language = await Language.load(require.resolve(`tree-sitter-wasms/out/tree-sitter-${grammar}.wasm`));
    const parser = new Parser();
    try {
      parser.setLanguage(language);
      const tree = parser.parse(source);
      assert.ok(tree);
      try {
        assert.equal(tree.rootNode.hasError, false);
        assert.ok(tree.rootNode.namedChildCount > 0);
      } finally {
        tree.delete();
      }
    } finally {
      parser.delete();
    }
  });
}
