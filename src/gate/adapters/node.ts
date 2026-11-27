import { lstatSync, statSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import type { EvidenceAdapter, EvidenceParseContext, EvidenceParseResult, EvidencePrepareRequest, PreparedEvidenceCommand } from './types.ts';

/**
 * Shell wrappers are never an evidence runner, whichever adapter is selected.
 * Exported so `verify.ts` selection and the Node validation cannot drift apart.
 */
export const SHELL_EXECUTABLES: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe', 'cscript', 'wscript']);
const NODE_EXECUTABLES = new Set(['node', 'node.exe']);
/** Flags that execute code before/around the test runner instead of selecting test files. */
const PRELOAD_FLAGS = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '--snapshot-blob', '--run']);
/** Flags whose next token is a value, never a test file selection. */
const VALUE_FLAGS = new Set(['--env-file', '--env-file-if-exists', '--test-name-pattern', '--test-skip-pattern', '--test-reporter-destination', '--test-concurrency', '--test-timeout', '--test-reporter', '--test-coverage-include', '--test-coverage-exclude', '--conditions', '-C', '--max-old-space-size', '--title', '--experimental-test-isolation', '--test-isolation', '--diagnostic-dir', '--inspect-port', '--input-type']);
/** Flags that execute inline code instead of the declared test files. */
const INLINE_FLAGS = new Set(['-e', '--eval', '--eval-file', '-p', '--print', '-c', '--command', '--exec']);
/** Reporters bundled with Node. A path/package reporter can execute arbitrary code. */
const BUILTIN_REPORTERS = new Set(['spec', 'tap', 'dot', 'junit', 'lcov']);

const countPattern = /^(?:#\s*|ℹ\s+)(tests|pass|fail|failed|skipped|todo|cancelled)\s+(\d+)\s*$/gim;

function splitFlag(token: string): [string, string | undefined] {
  const index = token.indexOf('=');
  return index < 0 ? [token, undefined] : [token.slice(0, index), token.slice(index + 1)];
}

function inlineFlag(token: string): boolean {
  if (INLINE_FLAGS.has(token)) return true;
  if ([...INLINE_FLAGS].some((flag) => token.startsWith(`${flag}=`))) return true;
  // Attached short forms such as `-econsole.log(...)`.
  return /^-[epc]./.test(token) && !token.startsWith('--');
}

function preloadFlag(token: string): boolean {
  const [name] = splitFlag(token);
  if (PRELOAD_FLAGS.has(name)) return true;
  // Attached short form such as `-rhook.js`.
  return /^-r./.test(token) && !token.startsWith('--');
}

interface ParsedRunner { positionals: string[]; hasTest: boolean }

/**
 * Parses argv with the small, explicit Node option grammar the gate accepts.
 * Anything that can introduce a second script or inline code is refused before
 * positional selection is checked; only declared test files may remain.
 */
function parseRunnerArguments(argv: string[]): ParsedRunner {
  const positionals: string[] = [];
  let hasTest = false;
  let afterSeparator = false;
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (afterSeparator) { positionals.push(token); continue; }
    if (token === '--') { afterSeparator = true; continue; }
    if (inlineFlag(token)) throw new Error(`Verification must not execute inline script arguments; the declared test file is not selected by argv: ${token}`);
    if (preloadFlag(token)) throw new Error(`Verification must not preload a hook or run another script; the declared test file is not selected by argv: ${token}`);
    if (token === '--test') { hasTest = true; continue; }
    if (token.startsWith('-') && token !== '-') {
      const [name, inlineValue] = splitFlag(token);
      if (name === '--test-reporter') {
        const reporter = inlineValue ?? argv[index + 1];
        if (reporter === undefined) throw new Error('The --test-reporter flag requires a value');
        if (!BUILTIN_REPORTERS.has(reporter)) throw new Error(`Verification only supports Node's built-in test reporters; refusing reporter: ${reporter}`);
        if (inlineValue === undefined) index += 1;
        continue;
      }
      if (inlineValue !== undefined) continue;
      if (VALUE_FLAGS.has(token)) {
        if (index + 1 >= argv.length) throw new Error(`The ${token} flag requires a value`);
        index += 1;
        continue;
      }
      // A Node boolean/unknown option cannot select a test file by itself. The
      // following token is still parsed as a positional and must be declared.
      continue;
    }
    positionals.push(token);
  }
  return { positionals, hasTest };
}

function normalizeProjectPath(root: string, candidate: string): string {
  const absolute = resolve(root, candidate);
  const path = relative(root, absolute).replaceAll('\\', '/');
  if (!path || path === '..' || path.startsWith('../') || isAbsolute(path)) throw new Error(`Test path resolves outside the project: ${candidate}`);
  return path;
}

function pathInside(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path.length > 0 && path !== '..' && !path.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) && !isAbsolute(path);
}

/** Bare `node`/`node.exe` can be hijacked by a project-local executable; pin it to the running runtime. */
export function normalizeNodeRunnerExecutable(argv: readonly string[]): string[] {
  if (!argv.length) return [];
  const executable = basename(argv[0]!).toLowerCase();
  if (!NODE_EXECUTABLES.has(executable)) return [...argv];
  if (argv[0]!.includes('/') || argv[0]!.includes('\\')) return [...argv];
  return [process.execPath, ...argv.slice(1)];
}

/**
 * Requires a supported real Node test runner (`node`/`node.exe`), the `--test`
 * flag, and exactly the declared test files as positional arguments. A wrapper
 * script (`node --test fake.mjs a.test.ts`), a non-Node interpreter, inline
 * evaluation, a shell, a preload hook, or a custom reporter is refused because
 * the observed summary would not be produced by the declared files.
 */
export function validateNodeTestCommand(root: string, argv: readonly string[], tests: readonly string[]): void {
  if (!argv.length) throw new Error('Verification requires an argv array');
  const rawExecutable = argv[0]!;
  const executable = basename(rawExecutable).toLowerCase();
  if (SHELL_EXECUTABLES.has(executable)) throw new Error(`Verification must not execute through a shell; the declared test file is not selected by argv: ${executable}`);
  if (!NODE_EXECUTABLES.has(executable)) throw new Error(`Verification must use the supported Node test runner (node/node.exe); refusing executable: ${rawExecutable}`);
  if (rawExecutable.includes('/') || rawExecutable.includes('\\')) {
    const candidate = isAbsolute(rawExecutable) ? rawExecutable : resolve(root, rawExecutable);
    let info;
    try { info = statSync(candidate); } catch { throw new Error(`Node executable does not exist: ${rawExecutable}`); }
    if (!info.isFile()) throw new Error(`Node executable is not a regular file: ${rawExecutable}`);
    if (pathInside(root, candidate)) throw new Error('Node executable must not come from inside the project under test');
  }
  const parsed = parseRunnerArguments([...argv]);
  if (!parsed.hasTest) throw new Error('Verification requires the Node test runner flag --test; the declared test file is not selected by argv');
  if (!tests.length) throw new Error('Verification requires at least one declared test file');

  const declared = new Set<string>();
  for (const test of tests) {
    const path = normalizeProjectPath(root, test);
    const absolute = resolve(root, path);
    let info;
    try { info = lstatSync(absolute); } catch { throw new Error(`Declared test file does not exist: ${path}`); }
    if (!info.isFile()) throw new Error(`Declared test path is not a regular file: ${path}`);
    declared.add(path);
  }

  const selected = new Set<string>();
  for (const token of parsed.positionals) {
    let path: string;
    try { path = normalizeProjectPath(root, token); }
    catch { throw new Error(`Argument is not selected as a test file: ${token}`); }
    if (!declared.has(path)) throw new Error(`Argument is not selected as a declared test file: ${path}`);
    selected.add(path);
  }
  for (const test of declared) if (!selected.has(test)) throw new Error(`Declared test is not selected by argv: ${test}`);
}

/** Node TAP/spec summary counts; regex kept byte-identical to the pre-migration parser. */
export function parseTestCounts(output: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const match of output.matchAll(countPattern)) {
    const name = match[1]!.toLowerCase();
    const key = name === 'failed' ? 'fail' : name;
    counts[key] = Number(match[2]);
  }
  return counts;
}

export const nodeEvidenceAdapter: EvidenceAdapter = {
  id: 'node',
  detect(argv: readonly string[]): boolean {
    if (!argv.length) return false;
    return NODE_EXECUTABLES.has(basename(argv[0]!).toLowerCase());
  },
  prepare(request: EvidencePrepareRequest): PreparedEvidenceCommand {
    const argv = normalizeNodeRunnerExecutable(request.argv);
    validateNodeTestCommand(request.root, argv, request.testFiles);
    return { argv, testFiles: [...request.testFiles] };
  },
  parse(context: EvidenceParseContext): EvidenceParseResult {
    const output = context.stdout + '\n' + context.stderr;
    const counts = parseTestCounts(output);
    const noMatchingTests = /^1\.\.0\s*$/im.test(output) || /no tests? (?:found|matching)/i.test(output);
    const tests = counts.tests ?? 0;
    const pass = counts.pass ?? 0;
    const failed = counts.fail ?? 0;
    const skipped = counts.skipped ?? 0;
    const todo = counts.todo ?? 0;
    const cancelled = counts.cancelled ?? 0;
    const ok = context.exitCode === 0 && !context.timedOut && !context.error && !noMatchingTests
      && tests > 0 && pass === tests && failed === 0 && skipped === 0 && todo === 0 && cancelled === 0;
    return { counts, ok };
  },
};
