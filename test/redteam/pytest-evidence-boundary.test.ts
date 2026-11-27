import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { pytestEvidenceAdapter } from '../../src/gate/adapters/pytest.ts';
import type { EvidenceParseContext } from '../../src/gate/adapters/types.ts';
import type { GraphStore } from '../../src/structure/store.ts';
import { Ledger } from '../../src/ledger/ledger.ts';
import { verifyTask } from '../../src/gate/verify.ts';

/**
 * PY-06 pytest evidence red team: the ANO owns the result channel, the interpreter
 * never comes from PATH, and every XML/exit-code contradiction is fail-closed.
 */
const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

async function write(root: string, path: string, source: string): Promise<void> {
  const target = join(root, ...path.split('/'));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, source);
}

async function fixture(): Promise<{ root: string; python: string; artifactDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'ano pytest redteam '));
  const python = join(root, process.platform === 'win32' ? 'fake-python.exe' : 'fake-python');
  await writeFile(python, 'fake interpreter bytes');
  await write(root, '.ano/config.toml', `[python]\ninterpreter = "${python.replaceAll('\\', '/')}"\n`);
  await write(root, 'test_a.py', 'def test_ok():\n    assert True\n');
  await mkdir(join(root, '.ano', 'tmp'), { recursive: true });
  return { root, python, artifactDir: join(root, '.ano', 'tmp') };
}

function prepareArgs(root: string, python: string, extra: string[], tests: string[] = ['test_a.py'], runId = 'redteam-run') {
  return { root, argv: [python, '-m', 'pytest', ...extra, ...tests], testFiles: tests, runId };
}

function context(root: string, runId: string, overrides: Partial<EvidenceParseContext> = {}): EvidenceParseContext {
  return { root, runId, stdout: '', stderr: '', exitCode: 0, signal: null, timedOut: false, ...overrides };
}

const PASS_XML = '<?xml version="1.0"?><testsuites><testsuite name="pytest" errors="0" failures="0" skipped="0" tests="1"><testcase classname="test_a" name="test_ok" /></testsuite></testsuites>';

test('the gate refuses any user attempt to own the JUnit channel', async (t) => {
  const { root, python } = await fixture();
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  for (const extra of [
    ['--junitxml=forged.xml'],
    ['--junitxml', 'forged.xml'],
    ['--junit-xml=forged.xml'],
    ['--junitx=forged.xml'],
    ['--junit=forged.xml'],
    ['-o', 'junit_family=xunit1'],
    ['-ojunit_family=xunit1'],
    ['--override-ini', 'junit_family=xunit1'],
    ['--override-ini=addopts=--collect-only'],
  ]) {
    assert.throws(() => pytestEvidenceAdapter.prepare(prepareArgs(root, python, extra)), /JUnit XML|JUnit family/, extra.join(' '));
  }
  const prepared = pytestEvidenceAdapter.prepare(prepareArgs(root, python, ['-q', '--junit-prefix', 'ANO']));
  assert.deepEqual(prepared.argv.slice(-3), ['-o', 'junit_family=xunit2', prepared.argv[prepared.argv.length - 1]]);
  assert.ok(prepared.argv[prepared.argv.length - 1]!.startsWith('--junitxml='), 'the owned artifact must be the last argument');
  assert.equal(prepared.argv.filter((token) => token.startsWith('--junitxml=')).length, 1);
  assert.ok(prepared.persistedArgv!.every((token) => !token.includes('junitxml') && !token.includes('junit_family')));
});

test('the interpreter never resolves through PATH or an unowned file', async (t) => {
  const { root, python } = await fixture();
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  for (const bare of ['python', 'python3', 'py', 'pytest']) {
    assert.throws(() => pytestEvidenceAdapter.prepare(prepareArgs(root, bare, [])), /PATH|absolute Python interpreter/, bare);
  }
  assert.throws(() => pytestEvidenceAdapter.prepare(prepareArgs(root, join(root, 'other-python.exe'), [])), /configured Python interpreter/);
  assert.throws(() => pytestEvidenceAdapter.prepare({
    root,
    argv: [python, '-m', 'pytest', '--junitxml=x.xml', 'test_a.py'],
    testFiles: ['test_a.py'],
    runId: 'r',
  }), /JUnit XML/);
});

test('dangerous pytest options are refused before execution', async (t) => {
  const { root, python } = await fixture();
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const cases: Array<{ extra: string[]; pattern: RegExp }> = [
    { extra: ['-p', 'evil'], pattern: /plugins/ },
    { extra: ['--collect-only'], pattern: /collect/ },
    { extra: ['--co'], pattern: /collect/ },
    { extra: ['--collect'], pattern: /collect/ },
    { extra: ['--setup-only'], pattern: /setup/ },
    { extra: ['--setup-plan'], pattern: /setup/ },
    { extra: ['--fixtures'], pattern: /fixtures/ },
    { extra: ['--fixt'], pattern: /fixtures/ },
    { extra: ['-c', 'pytest.ini'], pattern: /configuration file/ },
    { extra: ['--rootdir', '..'], pattern: /outside the project/ },
    { extra: ['--root', '..'], pattern: /outside the project/ },
    { extra: ['-X', 'dev'], pattern: /-X utf8/ },
    { extra: ['--'], pattern: /positional separator/ },
    { extra: ['forged.py'], pattern: /not selected as a declared test file/ },
  ];
  for (const item of cases) {
    assert.throws(() => pytestEvidenceAdapter.prepare(prepareArgs(root, python, item.extra)), item.pattern, item.extra.join(' '));
  }
  const allowed = pytestEvidenceAdapter.prepare(prepareArgs(root, python, ['-p', 'no:cacheprovider', '-k', 'ok', '--rootdir', '.']));
  assert.ok(allowed.argv.includes('no:cacheprovider'));
});

test('forged stdout cannot outrank the owned XML and every contradiction is fail-closed', async (t) => {
  const { root, artifactDir } = await fixture();
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const put = async (runId: string, xml: string) => writeFile(join(artifactDir, `verify-${runId}.xml`), xml);

  await put('pass', PASS_XML);
  const pass = await pytestEvidenceAdapter.parse(context(root, 'pass', { stdout: '# tests 999\n# pass 999\n' }));
  assert.equal(pass.ok, true);
  assert.deepEqual(pass.counts, { tests: 1, pass: 1, fail: 0, skipped: 0, todo: 0, cancelled: 0 });
  assert.equal(pass.environment?.resultXmlSha256, sha256(PASS_XML));

  const noXml = await pytestEvidenceAdapter.parse(context(root, 'forged-stdout', { stdout: '# tests 999\n# pass 999\n' }));
  assert.equal(noXml.ok, false);
  assert.match(noXml.error ?? '', /missing or unreadable/);

  const skippedXml = '<?xml version="1.0"?><testsuite name="pytest" errors="0" failures="1" skipped="1" tests="2"><testcase name="a"><failure /></testcase><testcase name="b"><skipped /></testcase></testsuite>';
  await put('skipped', skippedXml);
  const skipped = await pytestEvidenceAdapter.parse(context(root, 'skipped', { exitCode: 0 }));
  assert.equal(skipped.ok, false);
  assert.equal(skipped.counts.skipped, 1);
  assert.match(skipped.error ?? '', /exited 0 but the JUnit XML reports failures/);

  await put('contradiction', PASS_XML);
  const contradiction = await pytestEvidenceAdapter.parse(context(root, 'contradiction', { exitCode: 1 }));
  assert.equal(contradiction.ok, false);
  assert.match(contradiction.error ?? '', /exited 1 but the JUnit XML reports no failures/);

  const noTestsXml = '<?xml version="1.0"?><testsuite name="pytest" errors="0" failures="0" skipped="0" tests="0"></testsuite>';
  await put('no-tests', noTestsXml);
  const noTests = await pytestEvidenceAdapter.parse(context(root, 'no-tests', { exitCode: 5 }));
  assert.equal(noTests.ok, false);
  assert.deepEqual(noTests.counts, {});
  assert.match(noTests.error ?? '', /no tests/);

  const mismatchXml = '<?xml version="1.0"?><testsuite name="pytest" errors="0" failures="0" skipped="0" tests="2"><testcase name="a" /></testsuite>';
  await put('mismatch', mismatchXml);
  const mismatch = await pytestEvidenceAdapter.parse(context(root, 'mismatch', { exitCode: 0 }));
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.error ?? '', /rejected/);

  await put('doctype', '<!DOCTYPE x [<!ENTITY y "z">]><testsuite tests="1"><testcase name="a" /></testsuite>');
  const doctype = await pytestEvidenceAdapter.parse(context(root, 'doctype', { exitCode: 0 }));
  assert.equal(doctype.ok, false);
  assert.match(doctype.error ?? '', /rejected|DOCTYPE|ENTITY/i);

  assert.equal(existsSync(join(artifactDir, 'verify-pass.xml')), false);
  assert.equal(existsSync(join(artifactDir, 'verify-doctype.xml')), false);
  assert.equal(existsSync(join(artifactDir, 'verify-no-tests.xml')), false);
});

test('a symlinked artifact or result directory cannot redirect the owned channel', async (t) => {
  const { root, artifactDir } = await fixture();
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const target = join(root, 'target.xml');
  await writeFile(target, PASS_XML);
  try {
    await symlink(target, join(artifactDir, 'verify-link.xml'), 'file');
  } catch (error) {
    t.skip(`platform cannot create a file link: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const linked = await pytestEvidenceAdapter.parse(context(root, 'link', { exitCode: 0 }));
  assert.equal(linked.ok, false);
  assert.match(linked.error ?? '', /symbolic link/);
  assert.equal(existsSync(target), true);
});

test('verifyTask refuses pytest misuse before recording any evidence', async (t) => {
  const { root, python } = await fixture();
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const ledger = await Ledger.open(root, { sessionId: 'PY06-BOUNDARY' });
  try {
    await ledger.createTask('T', ['test_a.py']);
    await ledger.updateTask('T', { status: 'in_progress' });
    const graph = {} as GraphStore;
    const cases: Array<{ argv: string[]; pattern: RegExp }> = [
      { argv: [python, '-m', 'pytest', '--junitxml=forged.xml', 'test_a.py'], pattern: /JUnit XML/ },
      { argv: [python, '-m', 'pytest', '--collect-only', 'test_a.py'], pattern: /collect/ },
      { argv: [python, '-m', 'pytest', '-p', 'evil', 'test_a.py'], pattern: /plugins/ },
      { argv: ['python', '-m', 'pytest', 'test_a.py'], pattern: /PATH/ },
      { argv: [python, '-m', 'pytest', '--rootdir', '..', 'test_a.py'], pattern: /outside the project/ },
    ];
    for (const [index, item] of cases.entries()) {
      await assert.rejects(
        verifyTask(root, 'T', { argv: item.argv, testFiles: ['test_a.py'], idemKey: `refuse-${index}` }, { ledger, graph }),
        item.pattern,
      );
    }
    assert.equal(ledger.listEvidence('T').length, 0, 'refused pytest argv must not record evidence');
    assert.equal(ledger.getTask('T')?.status, 'in_progress');
  } finally {
    ledger.close();
  }
});
