import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { nodeEvidenceAdapter, parseTestCounts } from '../../src/gate/adapters/node.ts';
import type { EvidenceParseContext } from '../../src/gate/adapters/types.ts';
import type { CoveragePolicy } from '../../src/gate/blast.ts';
import { executeEvidence, outputDigest, parseTestCounts as parseTestCountsFromEvidence } from '../../src/gate/evidence.ts';
import type { Evidence } from '../../src/gate/types.ts';
import { commandSelectsTests, fingerprintExecutionGraph, selectEvidenceAdapter, verificationParameters, verifyTask } from '../../src/gate/verify.ts';
import { Ledger } from '../../src/ledger/ledger.ts';
import { GraphStore } from '../../src/structure/store.ts';

/**
 * PY-03 parity guard (ADR-014 §2.4 / §11.4): the adapter extraction must not
 * change Node evidence in any observable byte. The fixture was captured from the
 * unmodified pre-migration sources exactly once; every assertion below either
 * replays deterministic injected run data through the Node adapter or re-runs a
 * real stated scenario and compares the normalized Evidence/Verdict JSON string.
 */

type RootKey = 'evidence' | 'selection' | 'verdict';

interface FixtureTranscript {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
}

interface FixtureScenario {
  name: string;
  argv: string[];
  timeoutMs: number;
  realRun: boolean;
  spawnError: boolean;
  transcript: FixtureTranscript;
  expectedDigest: string;
  expectedParse: { counts: Record<string, number>; ok: boolean };
  expectedEvidence: string | null;
}

interface FixtureSelectionCase {
  name: string;
  argv: string[];
  tests: string[];
  result: { ok?: boolean; error?: string };
}

interface FixtureParameterCase {
  name: string;
  taskId: string;
  argv: string[];
  tests: string[];
  canonical: string;
}

interface FixtureVerdict {
  files: Record<string, string>;
  taskId: string;
  declaredFiles: string[];
  sessionId: string;
  argv: string[];
  testFiles: string[];
  idemKey: string;
  rejections: Array<{ name: string; argv: string[]; error: string }>;
  expected: string;
  ledgerSummary: {
    argv: string[];
    counts: Record<string, number>;
    ok: boolean;
    exitCode: number | null;
    timedOut: boolean;
    signal: string | null;
    testFiles: string[];
  };
}

interface Fixture {
  schema: number;
  environment: { node: string; platform: string; arch: string };
  sourceFingerprint: string;
  graphRevision: string;
  policy: CoveragePolicy;
  roots: Record<RootKey, string>;
  scenarios: FixtureScenario[];
  parseCountsCorpus: Array<{ input: string; counts: Record<string, number> }>;
  selectionFiles: Record<string, string>;
  selectionCases: FixtureSelectionCase[];
  parameterCases: FixtureParameterCase[];
  verdict: FixtureVerdict;
}

const fixture = JSON.parse(await readFile(new URL('../fixtures/py03-node-evidence-parity.json', import.meta.url), 'utf8')) as Fixture;

const PLACEHOLDERS: Record<RootKey, string> = {
  evidence: '<ROOT_EVIDENCE>',
  selection: '<ROOT_SELECTION>',
  verdict: '<ROOT_VERDICT>',
};
const ROOTS: Record<RootKey, string> = {
  evidence: join(tmpdir(), 'ano-py03-parity-evidence'),
  selection: join(tmpdir(), 'ano-py03-parity-selection'),
  verdict: join(tmpdir(), 'ano-py03-parity-verdict'),
};

function materialize(value: string): string {
  let text = String(value);
  text = text.replaceAll('<EXEC>', process.execPath);
  text = text.replaceAll('<ABS_TEST_A>', join(ROOTS.selection, 'test', 'a.test.ts'));
  for (const key of Object.keys(ROOTS) as RootKey[]) text = text.replaceAll(PLACEHOLDERS[key], ROOTS[key]);
  return text;
}

function scrub(value: string): string {
  let text = String(value);
  text = text.replaceAll(process.execPath, '<EXEC>');
  for (const key of Object.keys(ROOTS) as RootKey[]) {
    for (const variant of [ROOTS[key], ROOTS[key].replaceAll('\\', '/'), ROOTS[key].replaceAll('/', '\\')]) text = text.replaceAll(variant, PLACEHOLDERS[key]);
  }
  return text;
}

function normalizeEvidence(evidence: Evidence): Record<string, unknown> {
  const normalized = { ...(evidence as unknown as Record<string, unknown>) };
  normalized.id = '<uuid>';
  normalized.argv = evidence.argv.map((token) => scrub(token));
  normalized.cwd = scrub(evidence.cwd);
  normalized.startedAt = '<timestamp>';
  normalized.finishedAt = '<timestamp>';
  normalized.durationMs = 0;
  if (typeof normalized.error === 'string') normalized.error = scrub(normalized.error);
  if (typeof normalized.failureExcerpt === 'string') normalized.failureExcerpt = scrub(normalized.failureExcerpt);
  return normalized;
}

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, source] of Object.entries(files)) {
    const target = join(root, ...path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, source);
  }
}

function git(root: string, args: string[]): void {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
}

test('the adapter contract is a runtime-empty, directly loadable type module', async () => {
  const contract = await import('../../src/gate/adapters/types.ts');
  assert.deepEqual(Object.keys(contract), []);
});

test('execution graph fingerprints use canonical object ordering', () => {
  assert.equal(fingerprintExecutionGraph({ second: 2, first: 1 }), fingerprintExecutionGraph({ first: 1, second: 2 }));
  assert.notEqual(fingerprintExecutionGraph({ value: 1 }), fingerprintExecutionGraph({ value: 2 }));
});

test('the executor captures asynchronous spawn errors as failed evidence', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ano-py03-spawn-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const evidence = await executeEvidence({
    argv: [join(root, 'missing-runtime'), '--test'],
    cwd: root,
    timeoutMs: 1000,
  }, fixture.sourceFingerprint, fixture.graphRevision, fixture.environment);
  assert.equal(evidence.exitCode, null);
  assert.equal(evidence.ok, false);
  assert.match(evidence.error ?? '', /ENOENT|spawn/u);
});

test('the parity fixture is the accepted pre-migration capture', () => {
  assert.equal(fixture.schema, 1);
  assert.deepEqual(fixture.roots, PLACEHOLDERS);
  assert.ok(fixture.scenarios.length >= 18);
  assert.ok(fixture.selectionCases.length >= 35);
  assert.equal(parseTestCountsFromEvidence, parseTestCounts, 'evidence.ts must keep re-exporting the migrated count parser');
});

test('Node adapter parse reproduces pre-migration counts for injected run data', async () => {
  for (const scenario of fixture.scenarios) {
    assert.equal(outputDigest(scenario.transcript.stdout, scenario.transcript.stderr), scenario.expectedDigest, `${scenario.name}: captured transcript digest`);
    const context: EvidenceParseContext = {
      root: ROOTS.evidence,
      runId: 'py03-parity-run',
      stdout: scenario.transcript.stdout,
      stderr: scenario.transcript.stderr,
      exitCode: scenario.transcript.exitCode,
      signal: scenario.transcript.signal,
      timedOut: scenario.transcript.timedOut,
      ...(scenario.spawnError ? { error: 'simulated-spawn-error' } : {}),
    };
    const parsed = await nodeEvidenceAdapter.parse(context);
    assert.deepEqual(parsed, { counts: scenario.expectedParse.counts, ok: scenario.expectedParse.ok }, scenario.name);
  }
});

test('pre-migration Evidence snapshots are reproduced byte for byte', async (t) => {
  await rm(ROOTS.evidence, { recursive: true, force: true });
  await mkdir(ROOTS.evidence, { recursive: true });
  t.after(async () => { await rm(ROOTS.evidence, { recursive: true, force: true }); });
  for (const scenario of fixture.scenarios) {
    if (!scenario.realRun) continue;
    const evidence = await executeEvidence({ argv: scenario.argv.map(materialize), cwd: ROOTS.evidence, timeoutMs: scenario.timeoutMs }, fixture.sourceFingerprint, fixture.graphRevision, fixture.environment);
    assert.equal(JSON.stringify(normalizeEvidence(evidence)), scenario.expectedEvidence, scenario.name);
  }
});

test('parseTestCounts keeps the captured corpus byte-identical', () => {
  for (const entry of fixture.parseCountsCorpus) assert.deepEqual(parseTestCounts(entry.input), entry.counts, JSON.stringify(entry.input));
});

test('Node-only argv validation keeps the captured refusal text', async (t) => {
  await rm(ROOTS.selection, { recursive: true, force: true });
  await writeFiles(ROOTS.selection, fixture.selectionFiles);
  await mkdir(join(ROOTS.selection, 'test', 'directory.test.ts'), { recursive: true });
  t.after(async () => { await rm(ROOTS.selection, { recursive: true, force: true }); });

  for (const item of fixture.selectionCases) {
    let actual: { ok?: boolean; error?: string };
    try {
      commandSelectsTests(ROOTS.selection, item.argv.map(materialize), item.tests);
      actual = { ok: true };
    } catch (error) {
      actual = { error: (error as Error).message };
    }
    assert.deepEqual(actual, item.result, item.name);
  }

  const byName = new Map(fixture.selectionCases.map((item) => [item.name, item]));
  for (const name of ['python-runner', 'python-with-test-flag', 'deno-runner', 'shell-sh', 'shell-cmd', 'empty-argv']) {
    const item = byName.get(name);
    assert.ok(item, name);
    assert.throws(
      () => selectEvidenceAdapter(item.argv.map(materialize)),
      (error: unknown) => {
        assert.equal((error as Error).message, item.result.error, name);
        return true;
      },
      name,
    );
  }
  assert.equal(selectEvidenceAdapter([process.execPath, '--test']).id, 'node');
  assert.equal(selectEvidenceAdapter(['node', '--test']).id, 'node');
  assert.equal(nodeEvidenceAdapter.detect(['python', '--test']), false);
  assert.equal(nodeEvidenceAdapter.detect([]), false);
});

test('verificationParameters keeps the captured redacted canonical form', () => {
  for (const item of fixture.parameterCases) {
    const canonical = verificationParameters(item.taskId, item.argv.map(materialize), item.tests, fixture.policy);
    assert.equal(scrub(canonical), item.canonical, item.name);
  }
});

test('pre-migration Verdict and ledger summary are reproduced byte for byte', async (t) => {
  const root = ROOTS.verdict;
  await rm(root, { recursive: true, force: true });
  await writeFiles(root, fixture.verdict.files);
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'ano@localhost'], ['config', 'user.name', 'ano'], ['add', '.'], ['commit', '-qm', 'base']]) git(root, args);

  const ledger = await Ledger.open(root, { sessionId: fixture.verdict.sessionId });
  const graph = await GraphStore.open(root);
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  try {
    await ledger.createTask(fixture.verdict.taskId, fixture.verdict.declaredFiles);
    await ledger.updateTask(fixture.verdict.taskId, { status: 'in_progress' });

    for (const rejection of fixture.verdict.rejections) {
      let message: string | null = null;
      try {
        await verifyTask(root, fixture.verdict.taskId, { argv: rejection.argv, testFiles: fixture.verdict.testFiles, idemKey: `py03-reject-${rejection.name}` }, { ledger, graph });
      } catch (error) {
        message = (error as Error).message;
      }
      assert.equal(message, rejection.error, rejection.name);
    }
    assert.equal(ledger.listEvidence(fixture.verdict.taskId).length, 0, 'refused runners must not record evidence');

    const verdict = await verifyTask(root, fixture.verdict.taskId, {
      argv: fixture.verdict.argv.map(materialize),
      testFiles: fixture.verdict.testFiles,
      idemKey: fixture.verdict.idemKey,
    }, { ledger, graph });
    const normalized = structuredClone(verdict) as unknown as Record<string, unknown>;
    if ('evidenceId' in normalized) normalized.evidenceId = '<uuid>';
    assert.equal(scrub(JSON.stringify(normalized)), fixture.verdict.expected);

    const [record] = ledger.listEvidence(fixture.verdict.taskId);
    assert.ok(record, 'the verdict run must record evidence');
    const recorded = record.evidence as unknown as Evidence;
    assert.deepEqual({
      argv: recorded.argv.map((token) => scrub(token)),
      counts: recorded.counts,
      ok: recorded.ok,
      exitCode: recorded.exitCode,
      timedOut: recorded.timedOut,
      signal: recorded.signal,
      testFiles: record.testFiles,
    }, fixture.verdict.ledgerSummary);
  } finally {
    ledger.close();
    graph.close();
  }
});
