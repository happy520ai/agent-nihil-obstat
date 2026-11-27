import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { pytestEvidenceAdapter } from '../../src/gate/adapters/pytest.ts';
import type { EvidenceParseContext } from '../../src/gate/adapters/types.ts';

const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

async function write(root: string, path: string, source: string): Promise<void> {
  const target = join(root, ...path.split('/'));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, source);
}

async function fixture(): Promise<{ root: string; python: string; artifactDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'ano pytest unit '));
  const python = join(root, process.platform === 'win32' ? 'fake-python.exe' : 'fake-python');
  await writeFile(python, 'fake interpreter bytes');
  await write(root, '.ano/config.toml', `[python]\ninterpreter = "${python.replaceAll('\\', '/')}"\n`);
  await write(root, 'test_a.py', 'def test_ok():\n    assert True\n');
  await write(root, 'test_b.py', 'def test_ok():\n    assert True\n');
  await mkdir(join(root, 'test_directory.py'));
  await mkdir(join(root, '.ano', 'tmp'), { recursive: true });
  return { root, python, artifactDir: join(root, '.ano', 'tmp') };
}

function prepareArgs(root: string, python: string, extra: string[] = [], tests: string[] = ['test_a.py'], runId = 'run-1') {
  return { root, argv: [python, '-m', 'pytest', ...extra, ...tests], testFiles: tests, runId };
}

function context(root: string, runId: string, overrides: Partial<EvidenceParseContext> = {}): EvidenceParseContext {
  return {
    root,
    runId,
    stdout: '',
    stderr: '',
    exitCode: 0,
    signal: null,
    timedOut: false,
    ...overrides,
  };
}

function passXml(): string {
  return '<?xml version="1.0" encoding="utf-8"?><testsuites name="pytest tests"><testsuite name="pytest" errors="0" failures="0" skipped="0" tests="1" time="0.01"><testcase classname="test_a" name="test_ok" time="0.001" /></testsuite></testsuites>';
}

test('prepare appends ANO-owned result arguments and keeps persisted argv artifact-free', async (t) => {
  const { root, python, artifactDir } = await fixture();
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const previous = process.env.PYTEST_ADDOPTS;
  process.env.PYTEST_ADDOPTS = '--collect-only';
  try {
    const prepared = pytestEvidenceAdapter.prepare(prepareArgs(root, python, ['-q']));
    assert.deepEqual(prepared.persistedArgv, [python, '-m', 'pytest', '-q', 'test_a.py']);
    assert.deepEqual(prepared.argv, [
      python, '-m', 'pytest', '-q', 'test_a.py',
      '-o', 'junit_family=xunit2', `--junitxml=${join(artifactDir, 'verify-run-1.xml')}`,
    ]);
    assert.ok(prepared.persistedArgv.every((token) => !token.includes('--junitxml')));
    assert.ok(!prepared.argv.some((token) => token === '--junitxml'));
    assert.equal(prepared.environment?.interpreter, python);
    assert.equal(prepared.environment?.interpreterSha256, sha256('fake interpreter bytes'));
    assert.deepEqual(prepared.env, { PYTEST_DISABLE_PLUGIN_AUTOLOAD: '1' });
    assert.ok(prepared.envExclude?.includes('PYTEST_ADDOPTS'));
    assert.equal(existsSync(artifactDir), true);
  } finally {
    if (previous === undefined) delete process.env.PYTEST_ADDOPTS;
    else process.env.PYTEST_ADDOPTS = previous;
  }
});

test('prepare falls back to the project .venv interpreter', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ano pytest venv '));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const venv = process.platform === 'win32' ? join(root, '.venv', 'Scripts', 'python.exe') : join(root, '.venv', 'bin', 'python');
  await writeFile(join(root, 'test_a.py'), 'def test_ok():\n    assert True\n');
  await mkdir(dirname(venv), { recursive: true });
  await writeFile(venv, 'venv launcher bytes');
  const prepared = pytestEvidenceAdapter.prepare({ root, argv: [venv, '-m', 'pytest', 'test_a.py'], testFiles: ['test_a.py'], runId: 'venv-run' });
  assert.equal(prepared.environment?.interpreter, venv);
  assert.equal(prepared.environment?.interpreterSha256, sha256('venv launcher bytes'));
});

test('detect claims Python/pytest forms only', () => {
  assert.equal(pytestEvidenceAdapter.detect(['python', '-m', 'pytest', 'test_a.py']), true);
  assert.equal(pytestEvidenceAdapter.detect(['python3.14', '-m', 'pytest']), true);
  assert.equal(pytestEvidenceAdapter.detect(['C:/Python314/python.exe', '-m', 'pytest']), true);
  assert.equal(pytestEvidenceAdapter.detect(['pytest', 'test_a.py']), true);
  assert.equal(pytestEvidenceAdapter.detect(['some-runner', '-m', 'pytest', 'test_a.py']), true);
  assert.equal(pytestEvidenceAdapter.detect([process.execPath, '--test', 'test/a.test.ts']), false);
  assert.equal(pytestEvidenceAdapter.detect(['deno', 'test']), false);
  assert.equal(pytestEvidenceAdapter.detect(['python', 'fake.py', 'test/a.test.ts']), false);
  assert.equal(pytestEvidenceAdapter.detect(['python', '--test', 'test/a.test.ts']), false);
  assert.equal(pytestEvidenceAdapter.detect([]), false);
});

test('prepare refuses bare, mismatched, relative and missing interpreters', async (t) => {
  const { root, python } = await fixture();
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  for (const bare of ['python', 'python3', 'py', 'pytest']) {
    assert.throws(() => pytestEvidenceAdapter.prepare(prepareArgs(root, bare)), /PATH|configured Python interpreter|absolute Python interpreter/, bare);
  }
  assert.throws(() => pytestEvidenceAdapter.prepare(prepareArgs(root, join(root, 'other-python.exe'))), /configured Python interpreter/);
  const missingRoot = await mkdtemp(join(tmpdir(), 'ano pytest missing '));
  t.after(async () => { await rm(missingRoot, { recursive: true, force: true }); });
  await write(missingRoot, '.ano/config.toml', `[python]\ninterpreter = "${join(missingRoot, 'missing-python').replaceAll('\\', '/')}"\n`);
  await write(missingRoot, 'test_a.py', 'def test_ok():\n    assert True\n');
  assert.throws(() => pytestEvidenceAdapter.prepare(prepareArgs(missingRoot, join(missingRoot, 'missing-python'))), /does not exist/);
  const relativeRoot = await mkdtemp(join(tmpdir(), 'ano pytest relative '));
  t.after(async () => { await rm(relativeRoot, { recursive: true, force: true }); });
  await write(relativeRoot, '.ano/config.toml', '[python]\ninterpreter = "python.exe"\n');
  await write(relativeRoot, 'test_a.py', 'def test_ok():\n    assert True\n');
  // A relative interpreter is treated as unset by readConfig, so it can only fall
  // back to a project .venv; without one the refusal is the absolute-path contract.
  assert.throws(() => pytestEvidenceAdapter.prepare(prepareArgs(relativeRoot, 'python.exe')), /absolute Python interpreter/);
  await mkdir(join(root, 'python-dir'));
  await write(root, '.ano/config.toml', `[python]\ninterpreter = "${join(root, 'python-dir').replaceAll('\\', '/')}"\n`);
  assert.throws(() => pytestEvidenceAdapter.prepare(prepareArgs(root, join(root, 'python-dir'))), /regular file/);
  assert.ok(existsSync(python));
});

test('prepare refuses every ADR-014 §4.2 escape hatch', async (t) => {
  const { root, python } = await fixture();
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const cases: Array<{ label: string; extra: string[]; pattern: RegExp }> = [
    { label: 'user junitxml inline', extra: ['--junitxml=forged.xml'], pattern: /JUnit XML/ },
    { label: 'user junitxml separate', extra: ['--junitxml', 'forged.xml'], pattern: /JUnit XML/ },
    { label: 'user junit-xml alias', extra: ['--junit-xml=forged.xml'], pattern: /JUnit XML/ },
    { label: 'user junit abbreviation', extra: ['--junitx=forged.xml'], pattern: /JUnit XML/ },
    { label: 'user junit bare prefix', extra: ['--junit=forged.xml'], pattern: /JUnit XML/ },
    { label: 'positional separator', extra: ['--'], pattern: /positional separator/ },
    { label: 'ini junit family override', extra: ['-o', 'junit_family=xunit1'], pattern: /JUnit family/ },
    { label: 'attached ini junit family override', extra: ['-ojunit_family=xunit1'], pattern: /JUnit family/ },
    { label: 'ini addopts injection', extra: ['-o', 'addopts=--collect-only'], pattern: /JUnit family|addopts/ },
    { label: 'override-ini junit family', extra: ['--override-ini', 'junit_family=xunit1'], pattern: /JUnit family/ },
    { label: 'override-ini addopts', extra: ['--override-ini=addopts=--collect-only'], pattern: /JUnit family|addopts/ },
    { label: 'plugin load', extra: ['-p', 'evil_plugin'], pattern: /plugins/ },
    { label: 'attached plugin load', extra: ['-pevil_plugin'], pattern: /plugins/ },
    { label: 'collect only', extra: ['--collect-only'], pattern: /collect/ },
    { label: 'collect only alias', extra: ['--co'], pattern: /collect/ },
    { label: 'collect only abbreviation', extra: ['--collect'], pattern: /collect/ },
    { label: 'setup only', extra: ['--setup-only'], pattern: /setup/ },
    { label: 'setup plan', extra: ['--setup-plan'], pattern: /setup/ },
    { label: 'fixtures dump', extra: ['--fixtures'], pattern: /fixtures/ },
    { label: 'fixtures abbreviation', extra: ['--fixt'], pattern: /fixtures/ },
    { label: 'config override', extra: ['-c', 'pytest.ini'], pattern: /configuration file/ },
    { label: 'rootdir outside', extra: ['--rootdir', '..'], pattern: /outside the project/ },
    { label: 'rootdir abbreviation outside', extra: ['--root', '..'], pattern: /outside the project/ },
    { label: 'interpreter -X dev', extra: ['-X', 'dev'], pattern: /-X utf8/ },
    { label: 'attached -Xdev', extra: ['-Xdev'], pattern: /-X utf8/ },
  ];
  for (const item of cases) {
    assert.throws(() => pytestEvidenceAdapter.prepare(prepareArgs(root, python, item.extra)), item.pattern, item.label);
  }
  assert.throws(
    () => pytestEvidenceAdapter.prepare({ root, argv: [python, '-m', 'unittest', 'test_a.py'], testFiles: ['test_a.py'], runId: 'r' }),
    /-m pytest/,
  );
  assert.throws(
    () => pytestEvidenceAdapter.prepare({ root, argv: [python, 'test_a.py'], testFiles: ['test_a.py'], runId: 'r' }),
    /runner form/,
  );
});

test('prepare still accepts the safe subset', async (t) => {
  const { root, python, artifactDir } = await fixture();
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const prepared = pytestEvidenceAdapter.prepare(prepareArgs(root, python, [
    '-p', 'no:cacheprovider', '-k', 'ok', '-q', '--rootdir', '.', '-o', 'junit_suite_name=ano', '--junit-prefix', 'ANO',
  ]));
  assert.deepEqual(prepared.testFiles, ['test_a.py']);
  assert.ok(prepared.argv.includes('no:cacheprovider'));
  assert.ok(prepared.argv.includes(join(artifactDir, 'verify-run-1.xml')) || prepared.argv.some((token) => token.endsWith('verify-run-1.xml')));
});

test('prepare accepts both safe -X utf8 spellings before the pytest module', async (t) => {
  const { root, python } = await fixture();
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  for (const prefix of [['-X', 'utf8'], ['-Xutf8']]) {
    const prepared = pytestEvidenceAdapter.prepare({
      root,
      argv: [python, ...prefix, '-m', 'pytest', 'test_a.py'],
      testFiles: ['test_a.py'],
      runId: 'utf8-run',
    });
    assert.deepEqual(prepared.persistedArgv, [python, ...prefix, '-m', 'pytest', 'test_a.py']);
  }
});

test('prepare refuses argv that does not select exactly the declared test files', async (t) => {
  const { root, python } = await fixture();
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  assert.throws(() => pytestEvidenceAdapter.prepare({ root, argv: [python, '-m', 'pytest', 'test_a.py'], testFiles: ['test_a.py', 'test_b.py'], runId: 'r' }), /Declared test is not selected by argv: test_b.py/);
  assert.throws(() => pytestEvidenceAdapter.prepare({ root, argv: [python, '-m', 'pytest', 'test_a.py', 'test_b.py'], testFiles: ['test_a.py'], runId: 'r' }), /not selected as a declared test file: test_b.py/);
  assert.throws(() => pytestEvidenceAdapter.prepare({ root, argv: [python, '-m', 'pytest', 'forged.py'], testFiles: ['test_a.py'], runId: 'r' }), /not selected as a declared test file: forged.py/);
  assert.throws(() => pytestEvidenceAdapter.prepare({ root, argv: [python, '-m', 'pytest', 'test/missing.py'], testFiles: ['test/missing.py'], runId: 'r' }), /does not exist/);
  assert.throws(() => pytestEvidenceAdapter.prepare({ root, argv: [python, '-m', 'pytest', 'test_directory.py'], testFiles: ['test_directory.py'], runId: 'r' }), /regular file/);
  assert.throws(() => pytestEvidenceAdapter.prepare({ root, argv: [python, '-m', 'pytest', '../outside.py'], testFiles: ['../outside.py'], runId: 'r' }), /outside the project/);
});

test('parse maps a passing JUnit XML to a single passing count and deletes the artifact', async (t) => {
  const { root, artifactDir } = await fixture();
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const xml = passXml();
  await writeFile(join(artifactDir, 'verify-parse-pass.xml'), xml);
  const parsed = await pytestEvidenceAdapter.parse(context(root, 'parse-pass'));
  assert.deepEqual(parsed.counts, { tests: 1, pass: 1, fail: 0, skipped: 0, todo: 0, cancelled: 0 });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.environment?.resultXmlSha256, sha256(xml));
  assert.equal(existsSync(join(artifactDir, 'verify-parse-pass.xml')), false);
});

test('parse keeps skipped, failing, contradictory and missing XML fail-closed', async (t) => {
  const { root, artifactDir } = await fixture();
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const writeXml = async (runId: string, xml: string) => writeFile(join(artifactDir, `verify-${runId}.xml`), xml);
  const skipped = '<?xml version="1.0"?><testsuite name="pytest" errors="0" failures="0" skipped="1" tests="1"><testcase classname="test_a" name="test_skip"><skipped message="not ready" /></testcase></testsuite>';
  await writeXml('skip', skipped);
  const skipParse = await pytestEvidenceAdapter.parse(context(root, 'skip', { exitCode: 0 }));
  assert.equal(skipParse.ok, false);
  assert.equal(skipParse.counts.skipped, 1);
  assert.equal(skipParse.error, undefined);

  const failing = '<?xml version="1.0"?><testsuite name="pytest" errors="0" failures="1" skipped="0" tests="1"><testcase classname="test_a" name="test_bad"><failure message="assert" /></testcase></testsuite>';
  await writeXml('fail', failing);
  const failParse = await pytestEvidenceAdapter.parse(context(root, 'fail', { exitCode: 1 }));
  assert.equal(failParse.ok, false);
  assert.equal(failParse.counts.fail, 1);
  assert.equal(failParse.error, undefined);

  await writeXml('contradiction', passXml());
  const contradiction = await pytestEvidenceAdapter.parse(context(root, 'contradiction', { exitCode: 1 }));
  assert.equal(contradiction.ok, false);
  assert.match(contradiction.error ?? '', /exited 1 but the JUnit XML reports no failures/);

  const missing = await pytestEvidenceAdapter.parse(context(root, 'never-written', { exitCode: 0 }));
  assert.equal(missing.ok, false);
  assert.match(missing.error ?? '', /missing or unreadable/);

  const noTests = '<?xml version="1.0"?><testsuite name="pytest" errors="0" failures="0" skipped="0" tests="0"></testsuite>';
  await writeXml('no-tests', noTests);
  const noTestParse = await pytestEvidenceAdapter.parse(context(root, 'no-tests', { exitCode: 5 }));
  assert.equal(noTestParse.ok, false);
  assert.deepEqual(noTestParse.counts, {});
  assert.match(noTestParse.error ?? '', /no tests/);

  const collectionError = '<?xml version="1.0"?><testsuite name="pytest" errors="1" failures="0" skipped="0" tests="1"><testcase classname="test_a" name="test_broken"><error message="collection" /></testcase></testsuite>';
  await writeXml('collect-error', collectionError);
  const collectParse = await pytestEvidenceAdapter.parse(context(root, 'collect-error', { exitCode: 2 }));
  assert.equal(collectParse.ok, false);
  assert.deepEqual(collectParse.counts, { tests: 1, pass: 0, fail: 1, skipped: 0, todo: 0, cancelled: 0 });
  assert.match(collectParse.error ?? '', /exit 2/);

  const mismatch = '<?xml version="1.0"?><testsuite name="pytest" errors="0" failures="0" skipped="0" tests="2"><testcase classname="test_a" name="test_ok" /></testsuite>';
  await writeXml('mismatch', mismatch);
  const mismatchParse = await pytestEvidenceAdapter.parse(context(root, 'mismatch', { exitCode: 0 }));
  assert.equal(mismatchParse.ok, false);
  assert.match(mismatchParse.error ?? '', /rejected/);

  const forged = await pytestEvidenceAdapter.parse(context(root, 'parse-pass', { exitCode: 0, stdout: '# tests 999\n# pass 999\n' }));
  assert.equal(forged.ok, false, 'a deleted artifact cannot be replaced by stdout summaries');
});

test('parse rejects an unsupported pytest exit code even with valid XML', async (t) => {
  const { root, artifactDir } = await fixture();
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const artifact = join(artifactDir, 'verify-exit-6.xml');
  await writeFile(artifact, passXml());
  const parsed = await pytestEvidenceAdapter.parse(context(root, 'exit-6', { exitCode: 6 }));
  assert.equal(parsed.ok, false);
  assert.match(parsed.error ?? '', /unsupported code \(6\)/);
  assert.equal(existsSync(artifact), false);
});

test('prepare clears a pre-existing artifact path before the run', async (t) => {
  const { root, python, artifactDir } = await fixture();
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const stale = join(artifactDir, 'verify-run-1.xml');
  await writeFile(stale, 'stale bytes');
  pytestEvidenceAdapter.prepare(prepareArgs(root, python));
  assert.equal(existsSync(stale), false, 'the run must create its own artifact, not inherit one');
});

test('prepare rejects a symlinked result directory', async (t) => {
  const { root, python, artifactDir } = await fixture();
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const outside = await mkdtemp(join(tmpdir(), 'ano pytest outside '));
  t.after(async () => { await rm(outside, { recursive: true, force: true }); });
  await rm(artifactDir, { recursive: true, force: true });
  try {
    await symlink(outside, artifactDir, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    t.skip(`platform cannot create a directory link: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  assert.throws(() => pytestEvidenceAdapter.prepare(prepareArgs(root, python)), /symbolic link/);
});

test('parse rejects oversized artifacts without reading and removes the regular file', async (t) => {
  const { root, artifactDir } = await fixture();
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const big = join(artifactDir, 'verify-big.xml');
  await writeFile(big, '<x/>');
  await truncate(big, 16 * 1024 * 1024 + 1);
  const parsed = await pytestEvidenceAdapter.parse(context(root, 'big', { exitCode: 0 }));
  assert.equal(parsed.ok, false);
  assert.match(parsed.error ?? '', /16 MiB/);
  assert.equal(existsSync(big), false);
});

test('parse rejects a symlinked artifact without following or deleting the target', async (t) => {
  const { root, artifactDir } = await fixture();
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const target = join(root, 'outside-target.xml');
  await writeFile(target, passXml());
  const link = join(artifactDir, 'verify-link.xml');
  try {
    await symlink(target, link, 'file');
  } catch (error) {
    t.skip(`platform cannot create a file link: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const parsed = await pytestEvidenceAdapter.parse(context(root, 'link', { exitCode: 0 }));
  assert.equal(parsed.ok, false);
  assert.match(parsed.error ?? '', /symbolic link/);
  assert.equal(existsSync(target), true, 'the link target must never be read or deleted');
});

test('parse refuses a symlinked result directory without deleting outside data', async (t) => {
  const { root, artifactDir } = await fixture();
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const outside = await mkdtemp(join(tmpdir(), 'ano pytest parse outside '));
  t.after(async () => { await rm(outside, { recursive: true, force: true }); });
  const outsideArtifact = join(outside, 'verify-linked.xml');
  await writeFile(outsideArtifact, passXml());
  await rm(artifactDir, { recursive: true, force: true });
  try {
    await symlink(outside, artifactDir, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    t.skip(`platform cannot create a directory link: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const parsed = await pytestEvidenceAdapter.parse(context(root, 'linked', { exitCode: 0 }));
  assert.equal(parsed.ok, false);
  assert.match(parsed.error ?? '', /symbolic link/);
  assert.equal(existsSync(outsideArtifact), true);
});

test('parse fails closed on timeout, spawn error and hostile XML', async (t) => {
  const { root, artifactDir } = await fixture();
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await writeFile(join(artifactDir, 'verify-timeout.xml'), passXml());
  const timeout = await pytestEvidenceAdapter.parse(context(root, 'timeout', { timedOut: true, exitCode: null, signal: 'SIGKILL' }));
  assert.equal(timeout.ok, false);
  assert.match(timeout.error ?? '', /timed out/);
  assert.equal(existsSync(join(artifactDir, 'verify-timeout.xml')), false);

  const spawnError = await pytestEvidenceAdapter.parse(context(root, 'spawn', { exitCode: null, error: 'spawn failed' }));
  assert.equal(spawnError.ok, false);
  assert.equal(spawnError.error, undefined, 'the executor keeps the spawn error text');

  await writeFile(join(artifactDir, 'verify-doctype.xml'), '<!DOCTYPE x [<!ENTITY y "z">]><testsuite tests="1"><testcase name="a" /></testsuite>');
  const doctype = await pytestEvidenceAdapter.parse(context(root, 'doctype', { exitCode: 0 }));
  assert.equal(doctype.ok, false);
  assert.match(doctype.error ?? '', /rejected|DOCTYPE|ENTITY/i);
  assert.equal(existsSync(join(artifactDir, 'verify-doctype.xml')), false);
});
