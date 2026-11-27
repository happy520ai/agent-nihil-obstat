import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import test from 'node:test';
import type { CoveragePolicy } from '../../src/gate/blast.ts';
import type { Evidence } from '../../src/gate/types.ts';
import { verifyTask } from '../../src/gate/verify.ts';
import { Ledger } from '../../src/ledger/ledger.ts';
import { GraphStore } from '../../src/structure/store.ts';

/**
 * Real pytest evidence end to end (ADR-014 §4.3). The five status scenarios run a
 * real Python/pytest on this host; the test skips only when the host genuinely has
 * no Python with pytest (CI), never in place of a local run.
 */
const T0: CoveragePolicy = { minimum: 'T0', unknown: 'strict' };

function locatePython(): string | undefined {
  const candidates: string[] = [];
  if (process.env.ANO_TEST_PYTHON) candidates.push(process.env.ANO_TEST_PYTHON);
  if (process.platform === 'win32') candidates.push('C:/Python314/python.exe');
  for (const name of ['python3', 'python']) {
    const lookup = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' });
    if (lookup.status !== 0) continue;
    for (const line of lookup.stdout.split(/\r?\n/)) {
      const value = line.trim();
      if (value && isAbsolute(value)) candidates.push(value);
    }
  }
  for (const candidate of new Set(candidates)) {
    if (!existsSync(candidate)) continue;
    const probe = spawnSync(candidate, ['-m', 'pytest', '--version'], { encoding: 'utf8' });
    if (probe.status === 0) return resolve(candidate);
  }
  return undefined;
}

const PYTHON = locatePython();
const GIT = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
const SKIP = PYTHON === undefined || !GIT
  ? `real Python/pytest${GIT ? '' : ' and git'} unavailable on this host`
  : false;

const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

interface Scenario {
  name: string;
  source: string;
  exitCode: number;
  counts: Record<string, number>;
  ok: boolean;
  status: 'done' | 'blocked';
  error?: RegExp;
}

const SCENARIOS: Scenario[] = [
  {
    name: 'pass',
    source: 'def test_ok():\n    assert 2 + 2 == 4\n',
    exitCode: 0,
    counts: { tests: 1, pass: 1, fail: 0, skipped: 0, todo: 0, cancelled: 0 },
    ok: true,
    status: 'done',
  },
  {
    name: 'fail',
    source: 'def test_bad():\n    assert 2 + 2 == 5\n',
    exitCode: 1,
    counts: { tests: 1, pass: 0, fail: 1, skipped: 0, todo: 0, cancelled: 0 },
    ok: false,
    status: 'blocked',
  },
  {
    name: 'skip',
    source: 'import pytest\n\n\ndef test_skip():\n    pytest.skip("not ready")\n',
    exitCode: 0,
    counts: { tests: 1, pass: 0, fail: 0, skipped: 1, todo: 0, cancelled: 0 },
    ok: false,
    status: 'blocked',
  },
  {
    name: 'collection-error',
    source: 'def test_broken(:\n    pass\n',
    exitCode: 2,
    counts: { tests: 1, pass: 0, fail: 1, skipped: 0, todo: 0, cancelled: 0 },
    ok: false,
    status: 'blocked',
    error: /exit 2/,
  },
  {
    name: 'no-tests',
    source: 'def helper():\n    return 1\n',
    exitCode: 5,
    counts: {},
    ok: false,
    status: 'blocked',
    error: /no tests/,
  },
];

async function write(root: string, path: string, source: string): Promise<void> {
  const target = join(root, ...path.split('/'));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, source);
}

async function project(scenario: Scenario, python: string, pythonOnlySources = false): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `ano pytest ${scenario.name} `));
  await write(root, '.gitignore', '.ano/\n');
  // The source-scan resolver still requires a Node package manifest. The enabled
  // structure case has only Python sources, with no TS file to hide a stale graph.
  await write(root, 'package.json', '{"private":true,"type":"module"}\n');
  if (!pythonOnlySources) await write(root, 'src/app.ts', 'export const app = 1;\n');
  await write(root, '.ano/config.toml', `[python]\ninterpreter = "${python.replaceAll('\\', '/')}"\n`);
  await write(root, 'test_sample.py', scenario.source);
  const git = (args: string[]): void => {
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  };
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'ano@localhost'], ['config', 'user.name', 'ano'], ['add', '.'], ['commit', '-qm', 'base']]) git(args);
  return root;
}

interface EvidenceRunResult { verdict: Awaited<ReturnType<typeof verifyTask>>; evidence: Evidence }

async function runVerification(root: string, python: string, idemKey: string, timeoutMs?: number, enablePythonStructure = false, structure?: boolean): Promise<EvidenceRunResult> {
  const ledger = await Ledger.open(root, { sessionId: `PY05-${idemKey}` });
  const graph = await GraphStore.open(root, { enablePythonStructure });
  try {
    await ledger.createTask('T', ['test_sample.py']);
    await ledger.updateTask('T', { status: 'in_progress' });
    const verdict = await verifyTask(root, 'T', {
      argv: [python, '-m', 'pytest', '-q', 'test_sample.py'],
      testFiles: ['test_sample.py'],
      idemKey,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(structure !== undefined ? { structure } : {}),
    }, { ledger, graph }, T0);
    const [record] = ledger.listEvidence('T');
    assert.ok(record, 'pytest verification must record evidence');
    return { verdict, evidence: record.evidence as unknown as Evidence };
  } finally {
    ledger.close();
    graph.close();
  }
}

test('real pytest evidence matches Node verdict semantics for the five status scenarios', { skip: SKIP }, async (t) => {
  const python = PYTHON!;
  for (const scenario of SCENARIOS) {
    const root = await project(scenario, python);
    t.after(async () => { await rm(root, { recursive: true, force: true }); });
    const { verdict, evidence } = await runVerification(root, python, `scenario-${scenario.name}`);
    assert.equal(verdict.status, scenario.status, `${scenario.name}: ${JSON.stringify(verdict.reasons)}`);
    assert.equal(verdict.level, scenario.ok ? 'T0' : 'none', scenario.name);
    assert.equal(evidence.ok, scenario.ok, scenario.name);
    assert.equal(evidence.exitCode, scenario.exitCode, scenario.name);
    assert.deepEqual(evidence.counts, scenario.counts, scenario.name);
    if (scenario.error) assert.match(evidence.error ?? '', scenario.error, scenario.name);
    else assert.equal(evidence.error, undefined, scenario.name);
    const environment = evidence.environment as unknown as Record<string, unknown>;
    assert.equal(environment.interpreter, resolve(python), scenario.name);
    assert.equal(environment.interpreterSha256, sha256(readFileSync(resolve(python))), scenario.name);
    if (scenario.counts.tests !== undefined) assert.match(String(environment.resultXmlSha256), /^[a-f0-9]{64}$/, scenario.name);
    assert.ok(evidence.argv.some((token) => token.startsWith('--junitxml=')), scenario.name);
    assert.deepEqual(await readdir(join(root, '.ano', 'tmp')), [], `${scenario.name}: the result artifact must be deleted`);
  }
});

test('Gate freshness follows the enabled Python graph for a Python-only source tree', { skip: SKIP }, async (t) => {
  const python = PYTHON!;
  const scenario = SCENARIOS[0]!;
  const root = await project(scenario, python, true);
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const { verdict, evidence } = await runVerification(root, python, 'python-only-freshness', undefined, true, true);
  assert.equal(verdict.status, 'done', JSON.stringify(verdict.reasons));
  assert.equal(verdict.level, 'T0');
  assert.deepEqual(verdict.freshness, { status: 'fresh', stale: 0 });
  assert.equal(verdict.structure?.policyEffect, 'recorded');
  assert.equal(evidence.ok, true);
});

test('real pytest idempotency reuses evidence despite the ANO runId in --junitxml', { skip: SKIP }, async (t) => {
  const python = PYTHON!;
  const scenario = SCENARIOS[0]!;
  const root = await project(scenario, python);
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const ledger = await Ledger.open(root, { sessionId: 'PY05-IDEM' });
  const graph = await GraphStore.open(root);
  try {
    await ledger.createTask('T', ['test_sample.py']);
    await ledger.updateTask('T', { status: 'in_progress' });
    const request = { argv: [python, '-m', 'pytest', '-q', 'test_sample.py'], testFiles: ['test_sample.py'], idemKey: 'idem' };
    const first = await verifyTask(root, 'T', request, { ledger, graph }, T0);
    assert.equal(first.status, 'done', JSON.stringify(first.reasons));
    const evidenceIds = ledger.listEvidence('T').map((record) => record.id);
    assert.equal(evidenceIds.length, 1);
    const second = await verifyTask(root, 'T', request, { ledger, graph }, T0);
    assert.equal(second.status, 'done', JSON.stringify(second.reasons));
    assert.deepEqual(ledger.listEvidence('T').map((record) => record.id), evidenceIds, 'the retry must reuse the recorded evidence');
    assert.equal(second.evidenceId, first.evidenceId);
    assert.deepEqual(await readdir(join(root, '.ano', 'tmp')), [], 'no artifact survives the retry');
  } finally {
    ledger.close();
    graph.close();
  }
});

test('real pytest ignores hostile PYTEST_ADDOPTS and PYTHONPATH through environment sanitization', { skip: SKIP }, async (t) => {
  const python = PYTHON!;
  const scenario = SCENARIOS[0]!;
  const root = await project(scenario, python);
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const saved = { addopts: process.env.PYTEST_ADDOPTS, plugins: process.env.PYTEST_PLUGINS, pythonpath: process.env.PYTHONPATH };
  process.env.PYTEST_ADDOPTS = '--collect-only';
  process.env.PYTEST_PLUGINS = 'does_not_exist';
  process.env.PYTHONPATH = join(root, 'hostile-modules');
  try {
    const { verdict, evidence } = await runVerification(root, python, 'sanitized-env');
    assert.equal(verdict.status, 'done', JSON.stringify(verdict.reasons));
    assert.equal(evidence.ok, true);
    assert.deepEqual(evidence.counts, scenario.counts);
  } finally {
    if (saved.addopts === undefined) delete process.env.PYTEST_ADDOPTS;
    else process.env.PYTEST_ADDOPTS = saved.addopts;
    if (saved.plugins === undefined) delete process.env.PYTEST_PLUGINS;
    else process.env.PYTEST_PLUGINS = saved.plugins;
    if (saved.pythonpath === undefined) delete process.env.PYTHONPATH;
    else process.env.PYTHONPATH = saved.pythonpath;
  }
});

test('a real pytest timeout cleans the artifact and cannot pass', { skip: SKIP }, async (t) => {
  const python = PYTHON!;
  const scenario: Scenario = {
    name: 'timeout',
    source: 'import time\n\n\ndef test_slow():\n    time.sleep(5)\n',
    exitCode: 1,
    counts: {},
    ok: false,
    status: 'blocked',
  };
  const root = await project(scenario, python);
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const { verdict, evidence } = await runVerification(root, python, 'slow-timeout', 500);
  assert.equal(verdict.status, 'blocked', JSON.stringify(verdict.reasons));
  assert.equal(evidence.ok, false);
  assert.equal(evidence.timedOut, true);
  assert.deepEqual(await readdir(join(root, '.ano', 'tmp')), [], 'a timed-out run must not leave a result artifact');
});

test('a pytest run that creates a new .py source is always source drift', { skip: SKIP }, async (t) => {
  const python = PYTHON!;
  const scenario: Scenario = {
    name: 'drift',
    source: 'from pathlib import Path\n\n\ndef test_writes_py():\n    Path("extra.py").write_text("x = 1\\n", encoding="utf-8")\n',
    exitCode: 0,
    counts: { tests: 1, pass: 1, fail: 0, skipped: 0, todo: 0, cancelled: 0 },
    ok: false,
    status: 'blocked',
  };
  const root = await project(scenario, python);
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const { verdict, evidence } = await runVerification(root, python, 'py-drift');
  assert.equal(verdict.status, 'blocked', JSON.stringify(verdict.reasons));
  assert.equal(evidence.ok, false);
  assert.match(evidence.error ?? '', /Source changed during test execution: extra\.py/);
  assert.equal(existsSync(join(root, 'extra.py')), true, 'the test really wrote the .py source');
});
