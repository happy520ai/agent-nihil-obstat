import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { Language, Parser } from 'web-tree-sitter';

const root = new URL('../../', import.meta.url);
const require = createRequire(import.meta.url);
interface Scenario {
  scenario: string;
  exitCode: number;
  xmlMissing?: boolean;
  xmlSample?: string;
  xmlSha256?: string;
  suiteAttributes?: Array<Record<string, string>>;
  cases?: Array<{ classname: string | null; name: string | null; statuses: string[] }>;
  sourceFiles: Record<string, string>;
}
interface SpikeEvidence {
  methodology: {
    live: boolean;
    projectCreatedUnderOsTmpdir: boolean;
    gitRepository: boolean;
    venvCreated: boolean;
    networkUsed: boolean;
    newProjectDependencies: number;
    unicodeAndSpacePath: boolean;
    pluginAutoloadDisabled: boolean;
    python: string;
    pytest: string;
    rawPytestEvidenceSha256: string;
  };
  results: Scenario[];
  treeSitter: { loaded: boolean; source: string; hasError: boolean; wasmSha256: string; nodeTypes: Array<[string, number]> };
  decision: { m23a: string; m23b: string; pythonStructureEnabled: boolean; claimPythonSupport: boolean };
}
const evidence = JSON.parse(await readFile(new URL('docs/evidence/s9-python-pytest.json', root), 'utf8')) as SpikeEvidence;
const scenario = (name: string): Scenario => {
  const found = evidence.results.find((entry) => entry.scenario === name);
  assert.ok(found, name);
  return found;
};

test('PY-01 accepted ADR-014 stays registered in the public snapshot', async () => {
  const adr = await readFile(new URL('docs/adr/ADR-014-python-language-pack.md', root), 'utf8');
  assert.match(adr, /状态：\*\*已接受\*\*/u);
  assert.match(adr, /具名审阅人：project owner/u);
  assert.match(adr, /ADR-014/u);
  const registration = JSON.parse(await readFile(new URL('docs/m23-registration.json', root), 'utf8')) as { tasks: Array<{ key: string }> };
  assert.deepEqual(registration.tasks.map((entry) => entry.key), Array.from({ length: 12 }, (_, i) => `PY-${String(i + 1).padStart(2, '0')}`));
});

test('S9 records a real isolated venv and all six pytest exit codes without a support claim', () => {
  const method = evidence.methodology;
  for (const value of [method.live, method.projectCreatedUnderOsTmpdir, method.gitRepository, method.venvCreated, method.unicodeAndSpacePath, method.pluginAutoloadDisabled]) assert.equal(value, true);
  assert.equal(method.networkUsed, false);
  assert.equal(method.newProjectDependencies, 0);
  assert.match(method.python, /^Python 3\./u);
  assert.match(method.pytest, /^pytest \d/u);
  assert.match(method.rawPytestEvidenceSha256, /^[a-f0-9]{64}$/u);
  assert.equal(evidence.results.length, 13);
  assert.deepEqual([...new Set(evidence.results.map((entry) => entry.exitCode))].sort(), [0, 1, 2, 3, 4, 5]);
  assert.equal(evidence.decision.m23a, 'feasible');
  assert.equal(evidence.decision.m23b, 'feasible');
  assert.equal(evidence.decision.pythonStructureEnabled, false);
  assert.equal(evidence.decision.claimPythonSupport, false);
});

test('S9 preserves actual pytest status mappings, source specimens and original XML digests', () => {
  for (const [name, status] of [['pass', undefined], ['fail', 'failure'], ['error', 'error'], ['skip', 'skipped'], ['xfail', 'skipped'], ['xpass', undefined], ['strict_xpass', 'failure'], ['collection_error', 'error']] as const) {
    assert.deepEqual(scenario(name).cases?.[0]?.statuses, status ? [status] : []);
    assert.ok(Object.keys(scenario(name).sourceFiles).length > 0);
  }
  for (const entry of evidence.results.filter((item) => !item.xmlMissing)) {
    assert.match(entry.xmlSha256 ?? '', /^[a-f0-9]{64}$/u);
    assert.match(entry.xmlSample ?? '', /^<\?xml /u);
    assert.doesNotMatch(entry.xmlSample ?? '', /<(?:S9_ROOT|BASE_PYTHON|HOST)>/u);
  }
  assert.equal(scenario('no_tests').exitCode, 5);
  assert.equal(scenario('no_tests').suiteAttributes?.[0]?.tests, '0');
  assert.equal(scenario('interrupt').exitCode, 2);
  assert.equal(scenario('interrupt').suiteAttributes?.[0]?.tests, '0');
  assert.equal(scenario('interrupt').cases?.length, 1);
  assert.equal(scenario('internal_error').exitCode, 3);
  assert.equal(scenario('internal_error').xmlMissing, true);
  assert.equal(scenario('usage_error').exitCode, 4);
  assert.equal(scenario('usage_error').xmlMissing, true);
});

test('S9 records the conftest JUnit rewrite as a trust boundary, not tamper resistance', () => {
  const rewrite = scenario('conftest_rewrite');
  assert.equal(rewrite.exitCode, 0);
  assert.equal(rewrite.cases?.[0]?.classname, 'forged');
  assert.equal(rewrite.cases?.[0]?.name, 'all_green');
  assert.match(rewrite.sourceFiles['conftest.py'] ?? '', /pytest_sessionfinish/u);
  assert.match(rewrite.sourceFiles['conftest.py'] ?? '', /write_text/u);
});

test('S9 actual Python source still parses with the installed WASM and matching node inventory', async () => {
  const wasm = require.resolve('tree-sitter-wasms/out/tree-sitter-python.wasm');
  assert.equal(createHash('sha256').update(await readFile(wasm)).digest('hex'), evidence.treeSitter.wasmSha256);
  await Parser.init();
  const parser = new Parser();
  parser.setLanguage(await Language.load(wasm));
  const tree = parser.parse(evidence.treeSitter.source);
  assert.ok(tree);
  try {
    assert.equal(tree.rootNode.hasError, false);
    const types = new Map<string, number>();
    const queue = [tree.rootNode];
    while (queue.length) {
      const node = queue.pop()!;
      types.set(node.type, (types.get(node.type) ?? 0) + 1);
      for (const child of node.namedChildren) if (child) queue.push(child);
    }
    assert.deepEqual([...types].sort(([a], [b]) => a.localeCompare(b)), evidence.treeSitter.nodeTypes);
  } finally { tree.delete(); parser.delete(); }
});
