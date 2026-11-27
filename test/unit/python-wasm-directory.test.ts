import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createPythonExtractor } from '../../src/structure/extractors/python.ts';

test('an explicit WASM directory resolves and loads both real WASM assets', async (t) => {
  const wasmDirectory = await mkdtemp(join(tmpdir(), 'ano-python-wasm-'));
  t.after(async () => { await rm(wasmDirectory, { recursive: true, force: true }); });
  for (const specifier of ['web-tree-sitter/tree-sitter.wasm', 'tree-sitter-wasms/out/tree-sitter-python.wasm']) {
    const source = fileURLToPath(import.meta.resolve(specifier));
    await copyFile(source, join(wasmDirectory, basename(source)));
  }
  const extractor = await createPythonExtractor({ wasmDirectory });
  try {
    assert.equal(extractor.parse('explicit.py', 'VALUE = 1\n').definitions[0]?.name, 'VALUE');
  } finally {
    extractor.close();
  }
});
