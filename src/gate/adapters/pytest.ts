import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { readConfig } from '../../core/config.ts';
import { parseJUnitXml, type JUnitXmlParseResult } from './junit-xml.ts';
import type { EvidenceAdapter, EvidenceParseContext, EvidenceParseResult, EvidencePrepareRequest, PreparedEvidenceCommand } from './types.ts';

/**
 * pytest evidence adapter (ADR-014 §4.2/§4.3).
 *
 * Behaviour:
 * - only an absolute interpreter is accepted: `.ano/config.toml` `python.interpreter`
 *   or the project `.venv`; bare `python`/`python3`/`py`/`pytest` never goes through PATH;
 * - argv must be `<interpreter> [-X utf8] -m pytest [allowed flags] <declared test files>`;
 * - ANO appends `-o junit_family=xunit2 --junitxml=<root>/.ano/tmp/verify-<runId>.xml`
 *   last, so no user option can override the owned result channel; only those ANO
 *   arguments are excluded from the persisted idempotency argv;
 * - counts come only from the JUnit XML and are cross-checked with the exit code;
 *   the artifact is bounded, read, hashed and deleted on every path.
 */
const BARE_INTERPRETERS = new Set(['python', 'python3', 'py', 'pytest', 'python.exe', 'python3.exe', 'py.exe', 'pytest.exe']);
const ARTIFACT_DIRECTORY = ['.ano', 'tmp'];
const MAX_XML_BYTES = 16 * 1024 * 1024;
/** pytest's JUnit report channel; only the classname-prefix options are untouched. */
const JUNIT_PREFIX_OPTIONS = new Set(['--junit-prefix', '--junitprefix']);
/** Ini overrides that can hijack the result family or inject extra arguments. */
const FORBIDDEN_INI = /^(?:junit_family|addopts)(?:\s*=|$)/i;
/** Flags whose next token is a value and must never be mistaken for a test path. */
const VALUE_FLAGS = new Set([
  '-k', '-m', '-W', '-r', '-n',
  '--maxfail', '--tb', '--deselect', '--ignore', '--ignore-glob', '--basetemp', '--confcutdir',
  '--import-mode', '--capture', '--durations', '--durations-min',
  '--log-level', '--log-format', '--log-date-format', '--log-file', '--log-file-level',
  '--verbosity', '--color', '--code-highlight', '--pythonwarnings',
  '--show-capture', '--timeout', '--dist',
]);
const SANITIZED_ENVIRONMENT = /^(?:PYTHON|PYTEST)/i;

interface PythonInterpreter { readonly path: string; readonly sha256: string }

function fail(message: string): never { throw new Error(message); }

function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** True only when the candidate is outside the project (the project root itself is allowed). */
function outsideProject(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate)).replaceAll('\\', '/');
  return path === '..' || path.startsWith('../') || isAbsolute(path);
}

function normalizeProjectPath(root: string, candidate: string): string {
  const absolute = resolve(root, candidate);
  const path = relative(root, absolute).replaceAll('\\', '/');
  if (!path || path === '..' || path.startsWith('../') || isAbsolute(path)) throw new Error(`Test path resolves outside the project: ${candidate}`);
  return path;
}

function splitFlag(token: string): [string, string | undefined] {
  const index = token.indexOf('=');
  return index < 0 ? [token, undefined] : [token.slice(0, index), token.slice(index + 1)];
}

/** Argparse-style abbreviation of a refused long option, bounded to avoid absurd matches. */
function abbreviatedOption(name: string, full: string): boolean {
  return name.startsWith('--') && full.startsWith(name) && name.length >= Math.max(5, full.length - 5);
}

function artifactPath(root: string, runId: string): string {
  const safeRunId = runId.replace(/[^A-Za-z0-9_-]/g, '_');
  return join(root, ...ARTIFACT_DIRECTORY, `verify-${safeRunId}.xml`);
}

function sha256Bytes(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }

function venvInterpreter(root: string): string {
  return process.platform === 'win32'
    ? join(root, '.venv', 'Scripts', 'python.exe')
    : join(root, '.venv', 'bin', 'python');
}

/** A symlinked `.ano`/`.ano/tmp` would redirect the owned result channel outside the project. */
function artifactDirectoryProblem(root: string): string | undefined {
  for (const path of [join(root, '.ano'), join(root, ...ARTIFACT_DIRECTORY)]) {
    let info;
    try { info = lstatSync(path); } catch { return `Verification result directory is missing: ${path}`; }
    if (info.isSymbolicLink()) return `Verification result directory must not be a symbolic link: ${path}`;
    if (!info.isDirectory()) return `Verification result path is not a directory: ${path}`;
  }
  return undefined;
}

function assertArtifactDirectory(root: string): void {
  const problem = artifactDirectoryProblem(root);
  if (problem !== undefined) fail(problem);
}

/**
 * Creates `.ano/tmp` only after proving `.ano` is a real directory: a symlinked
 * `.ano` would otherwise make `mkdir -p` create directories outside the project.
 */
function ensureArtifactDirectory(root: string): void {
  const ano = join(root, '.ano');
  let info;
  try { info = lstatSync(ano); } catch { mkdirSync(ano); info = lstatSync(ano); }
  if (info.isSymbolicLink()) fail(`Verification result directory must not be a symbolic link: ${ano}`);
  if (!info.isDirectory()) fail(`Verification result path is not a directory: ${ano}`);
  const tmp = join(ano, ...ARTIFACT_DIRECTORY.slice(1));
  try { info = lstatSync(tmp); } catch { mkdirSync(tmp); info = lstatSync(tmp); }
  if (info.isSymbolicLink()) fail(`Verification result directory must not be a symbolic link: ${tmp}`);
  if (!info.isDirectory()) fail(`Verification result path is not a directory: ${tmp}`);
}

/** Resolves the one interpreter ANO owns: explicit config first, project venv otherwise. */
function resolveInterpreter(root: string, requested: string): PythonInterpreter {
  const configured = readConfig(root).python.interpreter;
  let candidate: string;
  if (configured !== null) {
    if (!isAbsolute(configured)) fail(`Configured python.interpreter must be an absolute path: ${configured}`);
    candidate = resolve(configured);
  } else {
    candidate = venvInterpreter(root);
    let info;
    try { info = statSync(candidate); } catch { fail('Verification requires an absolute Python interpreter in .ano/config.toml (python.interpreter) or a project .venv'); }
    if (!info.isFile()) fail(`Python interpreter is not a regular file: ${candidate}`);
  }
  let info;
  try { info = statSync(candidate); } catch { fail(`Python interpreter does not exist: ${candidate}`); }
  if (!info.isFile()) fail(`Python interpreter is not a regular file: ${candidate}`);
  const hasSeparator = requested.includes('/') || requested.includes('\\');
  const requestedName = basename(requested).toLowerCase();
  if (!hasSeparator && BARE_INTERPRETERS.has(requestedName)) fail(`Verification must not resolve a Python interpreter through PATH; refusing executable: ${requested}`);
  if (!hasSeparator || !samePath(candidate, requested)) fail(`Verification must use the configured Python interpreter; refusing executable: ${requested}`);
  let bytes: Buffer;
  try { bytes = readFileSync(candidate); } catch { fail(`Python interpreter is not readable: ${candidate}`); }
  return { path: candidate, sha256: sha256Bytes(bytes) };
}

/** Parses the fixed `<interpreter> [-X utf8] -m pytest ...` shape and refuses every ADR-014 §4.2 escape hatch. */
function parsePytestArgv(root: string, argv: readonly string[]): string[] {
  let index = 1;
  while (index < argv.length) {
    const token = argv[index]!;
    if (token === '-X') {
      const value = argv[index + 1];
      if (value === undefined) fail('The -X interpreter flag requires a value');
      if (value !== 'utf8') fail(`Verification only supports the -X utf8 interpreter flag; refusing -X ${value}`);
      index += 2;
      continue;
    }
    if (token.startsWith('-X') && !token.startsWith('--')) {
      const value = token.slice(2);
      if (value !== 'utf8') fail(`Verification only supports the -X utf8 interpreter flag; refusing -X ${value}`);
      index += 1;
      continue;
    }
    break;
  }
  if (argv[index] !== '-m') fail("Verification requires the pytest runner form '<interpreter> -m pytest'; the declared test file is not selected by argv");
  const module = argv[index + 1];
  if (module !== 'pytest') fail(`Verification must run the pytest module via -m pytest; refusing module: ${module ?? ''}`);
  const moduleEnd = index + 2;

  const positionals: string[] = [];
  for (let cursor = moduleEnd; cursor < argv.length; cursor += 1) {
    const token = argv[cursor]!;
    if (token === '--') fail('Verification must not use the pytest positional separator; the declared test file is not selected by argv');
    if (token.startsWith('--junit')) {
      const [name, inline] = splitFlag(token);
      if (!JUNIT_PREFIX_OPTIONS.has(name)) fail(`Verification owns the JUnit XML result channel; refusing user-supplied ${token}`);
      if (inline === undefined) {
        if (cursor + 1 >= argv.length) fail(`The ${name} flag requires a value`);
        cursor += 1;
      }
      continue;
    }
    if (token === '-c' || token.startsWith('-c=') || (token.startsWith('-c') && !token.startsWith('--'))) {
      const inline = token === '-c' ? undefined : token.startsWith('-c=') ? token.slice(3) : token.slice(2);
      const value = inline ?? argv[cursor + 1];
      if (value === undefined) fail('The -c flag requires a value');
      fail(`Verification must not override the pytest configuration file; refusing -c ${value}`);
    }
    if (token === '-p' || token.startsWith('-p=') || (token.startsWith('-p') && !token.startsWith('--'))) {
      const inline = token === '-p' ? undefined : token.startsWith('-p=') ? token.slice(3) : token.slice(2);
      const plugin = inline ?? argv[cursor + 1];
      if (plugin === undefined) fail('The -p flag requires a value');
      if (!plugin.startsWith('no:')) fail(`Verification only allows disabling pytest plugins; refusing plugin: ${plugin}`);
      if (inline === undefined) cursor += 1;
      continue;
    }
    if (token === '-o' || (token.startsWith('-o') && !token.startsWith('--'))) {
      const attached = token === '-o' ? undefined : token.startsWith('-o=') ? token.slice(3) : token.slice(2);
      const value = attached ?? argv[cursor + 1];
      if (value === undefined) fail('The -o flag requires a value');
      if (FORBIDDEN_INI.test(value)) fail(`Verification owns the JUnit family and addopts; refusing -o ${value}`);
      if (attached === undefined) cursor += 1;
      continue;
    }
    if (token.startsWith('-')) {
      const [name, inlineValue] = splitFlag(token);
      if (name === '--override-ini' || (name.startsWith('--override') && abbreviatedOption(name, '--override-ini'))) {
        const value = inlineValue ?? argv[cursor + 1];
        if (value === undefined) fail(`The ${name} flag requires a value`);
        if (FORBIDDEN_INI.test(value)) fail(`Verification owns the JUnit family and addopts; refusing ${name} ${value}`);
        if (inlineValue === undefined) cursor += 1;
        continue;
      }
      if (name === '--co' || abbreviatedOption(name, '--collect-only')) fail(`Verification must not collect tests without running them; refusing ${name}`);
      if (abbreviatedOption(name, '--setup-only') || abbreviatedOption(name, '--setup-plan')) fail(`Verification must not stop at setup; refusing ${name}`);
      if (abbreviatedOption(name, '--fixtures')) fail(`Verification must not dump fixtures; refusing ${name}`);
      if (name === '--rootdir' || abbreviatedOption(name, '--rootdir')) {
        const value = inlineValue ?? argv[cursor + 1];
        if (value === undefined) fail('The --rootdir flag requires a value');
        if (outsideProject(root, resolve(root, value))) fail(`Verification must not set --rootdir outside the project: ${value}`);
        if (inlineValue === undefined) cursor += 1;
        continue;
      }
      if (name === '-X' || (token.startsWith('-X') && !token.startsWith('--'))) fail('Verification only supports -X utf8 before -m pytest');
      if (inlineValue !== undefined) continue;
      if (VALUE_FLAGS.has(name)) {
        if (cursor + 1 >= argv.length) fail(`The ${name} flag requires a value`);
        cursor += 1;
        continue;
      }
      // Boolean or unknown pytest options cannot select a test file by themselves.
      continue;
    }
    positionals.push(token);
  }
  return positionals;
}

function assertDeclaredSelection(root: string, positionals: readonly string[], tests: readonly string[]): void {
  if (!tests.length) fail('Verification requires at least one declared test file');
  const declared = new Set<string>();
  for (const test of tests) {
    const path = normalizeProjectPath(root, test);
    const absolute = resolve(root, path);
    let info;
    try { info = lstatSync(absolute); } catch { fail(`Declared test file does not exist: ${path}`); }
    if (!info.isFile()) fail(`Declared test path is not a regular file: ${path}`);
    declared.add(path);
  }
  const selected = new Set<string>();
  for (const token of positionals) {
    let path: string;
    try { path = normalizeProjectPath(root, token); }
    catch { fail(`Argument is not selected as a test file: ${token}`); }
    if (!declared.has(path)) fail(`Argument is not selected as a declared test file: ${path}`);
    selected.add(path);
  }
  for (const test of declared) if (!selected.has(test)) fail(`Declared test is not selected by argv: ${test}`);
}

/** ANO-owned arguments are appended last so no user option can override the family or artifact. */
const ANO_JUNIT_ARGUMENTS = (artifact: string): string[] => ['-o', 'junit_family=xunit2', `--junitxml=${artifact}`];

function evidenceCounts(result: JUnitXmlParseResult | undefined): Record<string, number> {
  if (result === undefined || !result.ok) return {};
  return {
    tests: result.counts.tests ?? result.tests,
    pass: result.counts.pass,
    fail: result.counts.fail,
    skipped: result.counts.skipped,
    todo: result.counts.todo,
    cancelled: result.counts.cancelled,
  };
}

function exitReason(exitCode: number): string {
  if (exitCode === 1) return 'pytest reported failing tests (exit 1)';
  if (exitCode === 2) return 'pytest was interrupted or hit a collection error (exit 2)';
  if (exitCode === 3) return 'pytest internal error (exit 3)';
  if (exitCode === 4) return 'pytest usage error (exit 4)';
  if (exitCode === 5) return 'pytest collected no tests (exit 5)';
  return `pytest exited with an unsupported code (${exitCode})`;
}

export const pytestEvidenceAdapter: EvidenceAdapter = {
  id: 'pytest',
  detect(argv: readonly string[]): boolean {
    if (!argv.length) return false;
    // Only genuine pytest shapes are claimed; `python fake.py` and `python --test`
    // must keep falling through to the pre-migration Node refusal text.
    if (/^pytest(?:\.exe)?$/i.test(basename(argv[0]!))) return true;
    for (let index = 1; index < argv.length - 1; index += 1) {
      if (argv[index] === '-m' && argv[index + 1] === 'pytest') return true;
    }
    return false;
  },
  prepare(request: EvidencePrepareRequest): PreparedEvidenceCommand {
    const interpreter = resolveInterpreter(request.root, request.argv[0]!);
    const positionals = parsePytestArgv(request.root, request.argv);
    assertDeclaredSelection(request.root, positionals, request.testFiles);
    const canonicalArgv = [interpreter.path, ...request.argv.slice(1)];
    ensureArtifactDirectory(request.root);
    assertArtifactDirectory(request.root);
    const artifact = artifactPath(request.root, request.runId);
    // A pre-existing path could be a symlink or a stale file; the run must create it.
    try { unlinkSync(artifact); } catch { /* absent */ }
    const envExclude = Object.keys(process.env).filter((key) => SANITIZED_ENVIRONMENT.test(key)).sort();
    return {
      argv: [...canonicalArgv, ...ANO_JUNIT_ARGUMENTS(artifact)],
      persistedArgv: canonicalArgv,
      testFiles: [...request.testFiles],
      environment: { interpreter: interpreter.path, interpreterSha256: interpreter.sha256 },
      env: { PYTEST_DISABLE_PLUGIN_AUTOLOAD: '1' },
      ...(envExclude.length > 0 ? { envExclude } : {}),
    };
  },
  async parse(context: EvidenceParseContext): Promise<EvidenceParseResult> {
    const artifact = artifactPath(context.root, context.runId);
    const directoryProblem = artifactDirectoryProblem(context.root);
    let bytes: Buffer | undefined;
    let artifactError: string | undefined;
    let result: JUnitXmlParseResult | undefined;
    let xmlSha256: string | undefined;
    let removable = false;
    if (directoryProblem !== undefined) {
      artifactError = directoryProblem;
    } else {
      let info;
      try { info = lstatSync(artifact); } catch { artifactError = 'pytest JUnit XML result is missing or unreadable'; }
      if (info !== undefined) {
        if (info.isSymbolicLink()) artifactError = 'pytest JUnit XML result must not be a symbolic link';
        else if (!info.isFile()) artifactError = 'pytest JUnit XML result is not a regular file';
        else {
          removable = true;
          if (info.size > MAX_XML_BYTES) artifactError = 'pytest JUnit XML result exceeds the 16 MiB limit';
          else {
            try { bytes = readFileSync(artifact); } catch { artifactError = 'pytest JUnit XML result is unreadable'; }
          }
        }
      }
    }
    if (bytes !== undefined) {
      xmlSha256 = sha256Bytes(bytes);
      result = parseJUnitXml(bytes);
    }
    // Only a verified-regular artifact inside a non-symlinked directory is removed.
    if (removable) { try { unlinkSync(artifact); } catch { /* already removed */ } }
    const environment = xmlSha256 === undefined ? undefined : { resultXmlSha256: xmlSha256 };
    const counts = evidenceCounts(result);
    const failed = (error: string): EvidenceParseResult => ({ counts, ok: false, ...(environment !== undefined ? { environment } : {}), error });
    if (context.error !== undefined) return { counts: {}, ok: false, ...(environment !== undefined ? { environment } : {}) };
    if (context.timedOut) return failed('pytest timed out before producing a complete JUnit XML result');
    if (context.exitCode === null) return failed('pytest did not exit normally');
    if (context.exitCode === 5) return failed(exitReason(5));
    if (context.exitCode === 2) return failed(exitReason(2));
    if (context.exitCode === 3) return failed(exitReason(3));
    if (context.exitCode === 4) return failed(exitReason(4));
    if (result === undefined) return failed(artifactError ?? 'pytest JUnit XML result is missing or unreadable');
    if (!result.ok) return failed(`pytest JUnit XML was rejected: ${result.anomalies.slice(0, 3).join(', ')}`);
    if (context.exitCode === 0) {
      if (result.failures + result.errors > 0) return failed('pytest exited 0 but the JUnit XML reports failures or errors');
      if (result.tests === 0) return failed('pytest exited 0 without collecting any tests');
      const pass = result.counts.pass;
      const ok = pass === result.tests && result.counts.skipped === 0 && result.counts.todo === 0 && result.counts.cancelled === 0;
      return { counts, ok, ...(environment !== undefined ? { environment } : {}) };
    }
    if (context.exitCode === 1) {
      if (result.failures + result.errors === 0) return failed('pytest exited 1 but the JUnit XML reports no failures or errors');
      return { counts, ok: false, ...(environment !== undefined ? { environment } : {}) };
    }
    return failed(exitReason(context.exitCode));
  },
};
