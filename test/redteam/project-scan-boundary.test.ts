/**
 * T-109 / SCAN-07: security red team for the ADR-009 project-scan boundary.
 *
 * Scope (docs/adr/ADR-009-project-scan-roots.md §2 hard boundaries, §5
 * exclusion/scan_ignore reuse, §6 symbolic links, §7 large files, §8 timeout
 * degradation, §10 migration/takeover root binding, §11 status/error codes):
 * link escape/loops/secret targets, secret files and directories, huge files,
 * runtime locks (EBUSY/ETXTBSY), malicious globs, nested-package root bypass,
 * PM/scan root mismatch, timeout fail-closed, cache invalidation on exclusion
 * drift, and the Gate evidence boundary.
 *
 * Every scenario runs in a fresh `os.tmpdir()` project. Nothing writes the
 * repository's own `.pm/`, `.ano/`, `src/` or user-level configuration, and
 * `<example-project>` is never touched. Refusals are asserted as explicit
 * `ProjectScanError` codes; degraded outcomes are asserted as explicit entry
 * statuses. Traversal boundaries are proven with injected `ProjectScanDeps`.
 *
 * Two tests encode the ADR contract that the current implementation does not
 * yet satisfy; they are the regression tests for the defects reported by the
 * caller (see the run report):
 *   - T-109/01b a followed symlink whose *target* is a secret path is read
 *     (ADR-009 §5.3 "链接目标" must never be re-admitted; the
 *     `secret-path-excluded` reason is unreachable in the production path).
 *   - T-109/02b the scan-free legacy fingerprint/graph path reads secrets
 *     (ADR-009 §5.2 default set is not applied by `defaultExclude`).
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import test, { type TestContext } from 'node:test';
import { classifyFingerprintError, FINGERPRINT_STREAM_CHUNK_BYTES, fingerprintTree, type SourceFingerprint } from '../../src/core/fingerprint.ts';
import {
  assertValidGlob,
  createScanBudget,
  DEFAULT_EXCLUDES,
  isExcluded,
  isSecretPath,
  matchesGlob,
  ProjectScanError,
  resolveProjectScan,
  scanBudgetExceeded,
  scanBudgetExhausted,
  scanBudgetTimedOut,
  scanStatusForResult,
  shouldFollowLink,
  type ProjectScanDeps,
  type ResolvedProjectScan,
  type ScanErrorCode,
} from '../../src/core/project-scan.ts';
import { checkGraphFreshness, fingerprintSourceRoots } from '../../src/structure/fresh.ts';
import { GraphStore, type GraphBuildOutcome } from '../../src/structure/store.ts';
import {
  planMigration,
  reconcileMigration,
  resolveMigrationPmRoot,
  resolveMigrationRoot,
  type MigrationPlan,
  type MigrationResult,
} from '../../src/ledger/migrate.ts';
import { computeTakeoverSourceDigest, runTakeover, takeoverStatus, type TakeoverRunResult, type TakeoverStatus } from '../../src/connect/takeover.ts';
import { createAuthorization } from '../../src/connect/takeover-policy.ts';
import { saveAuthorization } from '../../src/connect/takeover-store.ts';
import { resolveRoot } from '../../src/connect/paths.ts';

const NOW = '2026-11-23T00:00:00.000Z';
const GATE_TOKENS = ['evidence_id', 'verdict', 'task_id', 'approve', 'cutover'] as const;
type GateToken = (typeof GATE_TOKENS)[number];

// ---------------------------------------------------------------------------
// Compile-time Gate boundary (type-level double insurance)
// ---------------------------------------------------------------------------

type AssertKeysAbsent<T, K extends string> = { readonly [P in K]: P extends keyof T ? readonly ['unexpected key', P] : never };
const _resolvedScanGateKeys: AssertKeysAbsent<ResolvedProjectScan, GateToken> = {
  evidence_id: undefined as never,
  verdict: undefined as never,
  task_id: undefined as never,
  approve: undefined as never,
  cutover: undefined as never,
};
const _fingerprintGateKeys: AssertKeysAbsent<SourceFingerprint, GateToken> = {
  evidence_id: undefined as never,
  verdict: undefined as never,
  task_id: undefined as never,
  approve: undefined as never,
  cutover: undefined as never,
};
const _graphOutcomeGateKeys: AssertKeysAbsent<GraphBuildOutcome, GateToken> = {
  evidence_id: undefined as never,
  verdict: undefined as never,
  task_id: undefined as never,
  approve: undefined as never,
  cutover: undefined as never,
};
const _migrationPlanGateKeys: AssertKeysAbsent<MigrationPlan, GateToken> = {
  evidence_id: undefined as never,
  verdict: undefined as never,
  task_id: undefined as never,
  approve: undefined as never,
  cutover: undefined as never,
};
const _migrationResultGateKeys: AssertKeysAbsent<MigrationResult, GateToken> = {
  evidence_id: undefined as never,
  verdict: undefined as never,
  task_id: undefined as never,
  approve: undefined as never,
  cutover: undefined as never,
};
const _takeoverRunGateKeys: AssertKeysAbsent<TakeoverRunResult, GateToken> = {
  evidence_id: undefined as never,
  verdict: undefined as never,
  task_id: undefined as never,
  approve: undefined as never,
  cutover: undefined as never,
};
const _takeoverStatusGateKeys: AssertKeysAbsent<TakeoverStatus, GateToken> = {
  evidence_id: undefined as never,
  verdict: undefined as never,
  task_id: undefined as never,
  approve: undefined as never,
  cutover: undefined as never,
};
void _resolvedScanGateKeys;
void _fingerprintGateKeys;
void _graphOutcomeGateKeys;
void _migrationPlanGateKeys;
void _migrationResultGateKeys;
void _takeoverRunGateKeys;
void _takeoverStatusGateKeys;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface LockHandle {
  kill: () => Promise<void>;
}

async function makeRoot(t: TestContext, prefix = 'ano-scan-rb-'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function makeRepo(t: TestContext): Promise<string> {
  const root = await makeRoot(t);
  await mkdir(join(root, '.git'), { recursive: true });
  await mkdir(join(root, '.pm'), { recursive: true });
  return root;
}

async function pkg(directory: string, name: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name }));
}

async function assertCode(promise: Promise<unknown>, code: ScanErrorCode): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ProjectScanError, `expected ProjectScanError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function assertNoGateVocabulary(outputs: readonly unknown[]): void {
  for (const output of outputs) {
    const json = JSON.stringify(output);
    for (const token of GATE_TOKENS) {
      assert.equal(json.includes(token), false, `Gate vocabulary "${token}" leaked into scan/graph/migration output: ${json.slice(0, 240)}`);
    }
  }
}

async function canSymlink(directory: string): Promise<boolean> {
  const target = join(directory, `symlink-probe-${process.pid}.tmp`);
  const link = join(directory, `symlink-probe-${process.pid}.lnk`);
  try {
    await writeFile(target, 'x');
    await symlink(target, link, 'file');
    await rm(link, { force: true });
    await rm(target, { force: true });
    return true;
  } catch {
    await rm(link, { force: true }).catch(() => {});
    await rm(target, { force: true }).catch(() => {});
    return false;
  }
}

/**
 * Hold a real Windows exclusive lock (`FileShare.None`) on `file` so a
 * subsequent `readFile` fails with `EBUSY`. Resolves once the lock is held.
 */
async function holdExclusiveLock(file: string, timeoutMs = 10_000): Promise<LockHandle> {
  const escaped = file.replaceAll("'", "''");
  const script = `$fs = [System.IO.File]::Open('${escaped}', [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None); Write-Output 'LOCKED'; Start-Sleep -Seconds 60`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['ignore', 'pipe', 'ignore'] });
  return new Promise<LockHandle>((resolvePromise, rejectPromise) => {
    let buffer = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      rejectPromise(new Error('timed out waiting for the exclusive lock'));
    }, timeoutMs);
    const stdout = child.stdout;
    if (stdout === null) {
      clearTimeout(timer);
      child.kill();
      rejectPromise(new Error('lock process has no stdout'));
      return;
    }
    stdout.setEncoding('utf8');
    stdout.on('data', (chunk: string) => {
      if (settled) return;
      buffer += chunk;
      if (buffer.includes('LOCKED')) {
        settled = true;
        clearTimeout(timer);
        resolvePromise({
          kill: () => new Promise<void>((resolveKill) => {
            child.once('exit', () => resolveKill());
            child.kill();
          }),
        });
      }
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(error);
    });
  });
}

const SECRET_FIXTURE: Record<string, string> = {
  '.env': 'ENV_SECRET_MARKER=1\n',
  '.env.local': 'ENV_LOCAL_SECRET_MARKER=1\n',
  'keys/server.pem': 'PEM_SECRET_MARKER\n',
  'keys/server.key': 'KEY_SECRET_MARKER\n',
  'keys/server.p12': 'P12_SECRET_MARKER\n',
  'keys/server.pfx': 'PFX_SECRET_MARKER\n',
  'id_rsa': 'RSA_SECRET_MARKER\n',
  'id_ed25519': 'ED25519_SECRET_MARKER\n',
  'credentials.json': 'CREDENTIALS_SECRET_MARKER\n',
  'secrets/value.ts': 'SECRETS_DIR_SECRET_MARKER\n',
  'secrets/nested/inner.ts': 'SECRETS_NESTED_SECRET_MARKER\n',
};

async function writeSecretFixture(root: string): Promise<void> {
  for (const [path, content] of Object.entries(SECRET_FIXTURE)) {
    const absolute = join(root, ...path.split('/'));
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
}

async function takeoverFixture(t: TestContext): Promise<{ root: string; authorizationId: string }> {
  const root = await makeRoot(t, 'ano-scan-rb-takeover-');
  await mkdir(join(root, '.git'), { recursive: true });
  await mkdir(join(root, '.pm'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'gate-fixture' }));
  await writeFile(join(root, '.pm', 'project.json'), JSON.stringify({ name: 'gate-fixture' }));
  await writeFile(join(root, '.pm', 'tasks.json'), JSON.stringify({ seq: 1, tasks: [{ id: 'T-1', title: 'one', status: 'todo' }] }));
  await writeFile(join(root, 'AGENTS.md'), '# fixture\n');
  const authorization = createAuthorization({
    root: resolveRoot(root),
    projectId: 'proj-gate',
    projectKey: 'key-gate',
    scope: ['tasks', 'memory', 'acceptance', 'dag'],
    grantedBy: 'Alice',
    role: 'owner',
    statement: 'I explicitly authorize this fixture takeover.',
    grantedAt: NOW,
  });
  saveAuthorization(resolveRoot(root), authorization);
  return { root, authorizationId: authorization.authorizationId };
}

// ---- 1. symbolic links: escape, loop, secret target, default no-follow ----

test('T-109/01 link escape and loops are explicit degraded records; default never follows', async (t) => {
  const root = await makeRepo(t);
  await pkg(root, 'links');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  const outside = await makeRoot(t, 'ano-scan-rb-out-');
  await writeFile(join(outside, 'outside.txt'), 'OUTSIDE_MARKER_THAT_MUST_NOT_BE_READ\n');
  if (!(await canSymlink(root))) t.skip('platform cannot create symlinks without elevated privileges');

  await symlink(join(outside, 'outside.txt'), join(root, 'src', 'escape.ts'), 'file');
  await symlink(root, join(root, 'src', 'loop'), 'dir');
  const outsideHash = sha256('OUTSIDE_MARKER_THAT_MUST_NOT_BE_READ\n');

  // Default: followLinks=false. The link is reported, never followed, never removed.
  const resolved = await resolveProjectScan({ startRoot: root });
  assert.equal(resolved.followLinks, false);
  assert.equal(resolved.shouldFollowLink('src/escape.ts'), false);
  assert.equal(shouldFollowLink('src/escape.ts', false), false);
  const before = await fingerprintSourceRoots(root, resolved.sourceRoots, { scan: resolved });
  assert.equal(before.status, 'degraded');
  assert.deepEqual(before.files.map((file) => file.path), ['package.json', 'src/a.ts']);
  const escapeEntry = before.degraded.find((entry) => entry.path === 'src/escape.ts');
  assert.ok(escapeEntry);
  assert.equal(escapeEntry.status, 'skipped-link');
  assert.equal(escapeEntry.code, 'skipped-link');
  assert.equal(escapeEntry.reason, 'follow-links-disabled');
  assert.equal(escapeEntry.target, join(outside, 'outside.txt'));
  assert.ok(before.degraded.some((entry) => entry.path === 'src/loop' && entry.status === 'skipped-link'));
  assert.equal(before.stats?.skippedLinks, 2);
  assert.equal(JSON.stringify(before).includes(outsideHash), false, 'the link target content must not be read');
  const linkStat = await lstat(join(root, 'src', 'escape.ts'));
  assert.equal(linkStat.isSymbolicLink(), true, 'the link must not be deleted or replaced');
  assert.equal(await readFile(join(outside, 'outside.txt'), 'utf8'), 'OUTSIDE_MARKER_THAT_MUST_NOT_BE_READ\n');

  // Opt-in: escape and loop are explicit LINK_ESCAPE degraded records.
  const followed = await resolveProjectScan({ startRoot: root, followLinks: true });
  assert.equal(followed.followLinks, true);
  const after = await fingerprintSourceRoots(root, followed.sourceRoots, { scan: followed });
  const escape = after.degraded.find((entry) => entry.path === 'src/escape.ts');
  assert.ok(escape);
  assert.equal(escape.code, 'LINK_ESCAPE');
  assert.equal(escape.reason, 'link-escape');
  assert.equal(escape.status, 'degraded');
  const loop = after.degraded.find((entry) => entry.path === 'src/loop');
  assert.ok(loop);
  assert.equal(loop.code, 'LINK_ESCAPE');
  assert.equal(loop.reason, 'link-loop');
  assert.equal(after.files.some((file) => file.path === 'src/escape.ts'), false);
  assert.equal(after.status, 'degraded');
  assert.equal(JSON.stringify(after).includes(outsideHash), false);
});

test('T-109/01b a followed link whose target is a secret path is recorded as secret-path-excluded and never read', async (t) => {
  const root = await makeRepo(t);
  await pkg(root, 'link-secret');
  await mkdir(join(root, 'secrets'), { recursive: true });
  await writeFile(join(root, 'secrets', 'value.ts'), 'SECRET_VIA_LINK_MARKER=1\n');
  await writeFile(join(root, 'src.ts'), 'export const a = 1;\n');
  if (!(await canSymlink(root))) t.skip('platform cannot create symlinks without elevated privileges');
  await symlink(join(root, 'secrets'), join(root, 'link-to-secret'), 'dir');

  const scan = await resolveProjectScan({ startRoot: root, sourceRoots: [root], followLinks: true });
  assert.equal(scan.shouldFollowLink('link-to-secret'), true, 'the link path itself is not secret');
  const result = await fingerprintSourceRoots(root, [root], { scan });
  const entry = result.degraded.find((degraded) => degraded.path === 'link-to-secret');
  assert.ok(entry, `expected an explicit degraded record for the secret-target link, got ${JSON.stringify(result.degraded)}`);
  assert.equal(entry.reason, 'secret-path-excluded');
  assert.equal(result.files.some((file) => file.path.startsWith('link-to-secret/')), false, 'secret directory content must not enter the fingerprint');
  assert.equal(JSON.stringify(result).includes(sha256('SECRET_VIA_LINK_MARKER=1\n')), false);
});

// ---- 2. secrets are never read by default -------------------------------

test('T-109/02 secret files and directories are always excluded and never hashed', async (t) => {
  const root = await makeRepo(t);
  await pkg(root, 'secrets');
  await writeSecretFixture(root);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\n');

  const resolved = await resolveProjectScan({ startRoot: root });
  for (const path of Object.keys(SECRET_FIXTURE)) {
    assert.equal(isSecretPath(path), true, path);
    assert.equal(resolved.excludes(path), true, `${path} must be excluded`);
    assert.equal(resolved.excludes(join(root, ...path.split('/'))), true, `${path} (absolute) must be excluded`);
    assert.equal(resolved.includes(path), false, `${path} must never be included`);
    assert.equal(shouldFollowLink(path, true), false, `${path} must never be followed`);
  }
  // File-shaped secrets are in the default glob set; directory segments are
  // enforced by isSecretPath in the resolved predicate.
  for (const path of ['.env', '.env.local', 'keys/server.pem', 'keys/server.key', 'keys/server.p12', 'keys/server.pfx', 'id_rsa', 'id_ed25519', 'credentials.json']) {
    assert.equal(isExcluded(path, DEFAULT_EXCLUDES), true, path);
  }
  assert.equal(isExcluded('secrets/value.ts', DEFAULT_EXCLUDES), false, 'the secrets segment is enforced by isSecretPath, not by a default glob');

  // `include` cannot re-admit a secret path.
  const withInclude = await resolveProjectScan({
    startRoot: root,
    include: ['**/*', '**/.env*', 'secrets/**', '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx', 'id_rsa*', 'id_ed25519*', 'credentials.json'],
  });
  for (const path of Object.keys(SECRET_FIXTURE)) {
    assert.equal(withInclude.excludes(path), true, `include re-admitted ${path}`);
    assert.equal(withInclude.includes(path), false, `include predicate returned true for ${path}`);
  }

  const fingerprint = await fingerprintSourceRoots(root, resolved.sourceRoots, { scan: resolved });
  assert.deepEqual(fingerprint.files.map((file) => file.path), ['package.json', 'src/a.ts']);
  const report = JSON.stringify(fingerprint);
  for (const content of Object.values(SECRET_FIXTURE)) {
    assert.equal(report.includes(sha256(content)), false, 'a secret content hash leaked into the fingerprint report');
  }

  const store = await GraphStore.open(root, { scan: resolved });
  await store.build();
  assert.deepEqual(store.filesList(), ['src/a.ts'], 'secret files must not enter the graph file set');
  store.close();
});

test('T-109/02b the scan-free legacy fingerprint and graph paths exclude secrets', async (t) => {
  const root = await makeRepo(t);
  await pkg(root, 'legacy-secrets');
  await writeSecretFixture(root);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\n');

  const legacy = await fingerprintTree(root);
  const legacySecrets = legacy.files.filter((file) => isSecretPath(file.path)).map((file) => file.path);
  assert.deepEqual(legacySecrets, [], `the default fingerprint read secret files: ${legacySecrets.join(', ')}`);
  const report = JSON.stringify(legacy);
  for (const content of Object.values(SECRET_FIXTURE)) {
    assert.equal(report.includes(sha256(content)), false, 'a secret content hash leaked into the legacy fingerprint');
  }

  const store = await GraphStore.open(root);
  await store.build();
  const graphSecrets = store.filesList().filter((path) => isSecretPath(path));
  assert.deepEqual(graphSecrets, [], `the scan-free graph read secret files: ${graphSecrets.join(', ')}`);
  store.close();
});

// ---- 3. large files are streamed, not read whole ------------------------

test('T-109/03 files above maxFileBytes are streamed in chunks and match a full read', async (t) => {
  const root = await makeRepo(t);
  await pkg(root, 'big-file');
  await mkdir(join(root, 'src'), { recursive: true });
  const size = 3 * 1024 * 1024;
  // `.bin` is in the ADR-009 §5.2 default exclusion set, so the legacy default
  // fingerprint would skip it; `.dat` keeps this a default-path streaming test.
  const big = join(root, 'src', 'big.dat');
  await writeFile(big, '');
  await truncate(big, size);
  const expected = sha256(Buffer.alloc(size));

  const streamed = await fingerprintTree(root, { maxFileBytes: 1024 * 1024 });
  const entry = streamed.files.find((file) => file.path === 'src/big.dat');
  assert.ok(entry);
  assert.equal(entry.streamed, true, 'a file above maxFileBytes must take the streaming path');
  assert.equal(entry.size, size);
  assert.equal(entry.hash, expected);
  assert.equal(streamed.stats?.streamed, 1);
  assert.equal(FINGERPRINT_STREAM_CHUNK_BYTES, 4 * 1024 * 1024);

  // maxFileBytes=0 disables the threshold; the digest must be identical.
  const whole = await fingerprintTree(root, { maxFileBytes: 0 });
  const wholeEntry = whole.files.find((file) => file.path === 'src/big.dat');
  assert.ok(wholeEntry);
  assert.equal(wholeEntry.streamed, undefined);
  assert.equal(wholeEntry.hash, expected, 'the chunked digest must equal a full read');
  assert.equal(whole.stats?.streamed, 0);
});

// ---- 4. runtime locks degrade one file, never the tree -------------------

test('T-109/04 a runtime EBUSY lock degrades one file and never fails the tree', async (t) => {
  assert.deepEqual(classifyFingerprintError(Object.assign(new Error('busy'), { code: 'EBUSY' })), { status: 'busy-file', code: 'EBUSY' });
  assert.deepEqual(classifyFingerprintError(Object.assign(new Error('busy'), { code: 'ETXTBSY' })), { status: 'busy-file', code: 'ETXTBSY' });
  assert.deepEqual(classifyFingerprintError(Object.assign(new Error('denied'), { code: 'EACCES' })), { status: 'permission-denied', code: 'EACCES' });
  assert.deepEqual(classifyFingerprintError(Object.assign(new Error('denied'), { code: 'EPERM' })), { status: 'permission-denied', code: 'EPERM' });
  assert.equal(classifyFingerprintError(new Error('mystery')), undefined);

  if (process.platform !== 'win32') t.skip('the exclusive-lock probe is Windows-specific');
  const root = await mkdtemp(join(tmpdir(), 'ano-scan-rb-busy-'));
  let lock: LockHandle | undefined;
  t.after(async () => {
    if (lock !== undefined) await lock.kill();
    await rm(root, { recursive: true, force: true });
  });
  await pkg(root, 'busy-file');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  const locked = join(root, 'src', 'locked.ts');
  await writeFile(locked, 'export const locked = 1;\n');

  try {
    lock = await holdExclusiveLock(locked);
  } catch (error) {
    t.skip(`cannot hold an exclusive lock in this environment: ${String(error)}`);
    return;
  }

  const result = await fingerprintTree(root);
  const entry = result.degraded.find((degraded) => degraded.path === 'src/locked.ts');
  assert.ok(entry, `expected a degraded record for the busy file, got ${JSON.stringify(result.degraded)}`);
  assert.equal(entry.status, 'busy-file');
  assert.equal(entry.code, 'EBUSY');
  assert.equal(result.status, 'degraded');
  assert.ok(result.files.some((file) => file.path === 'src/a.ts'), 'the rest of the tree must still be fingerprinted');
  assert.equal(result.files.some((file) => file.path === 'src/locked.ts'), false);
  assert.equal(existsSync(locked), true, 'a busy file must never be deleted or rewritten');
});

// ---- 5. malicious globs fail closed at resolution time -----------------

test('T-109/05 malicious globs are rejected as CONFIG_INVALID, never silently ignored', async (t) => {
  for (const pattern of ['', 'a\0b', 'a\\b', '/etc/**', 'C:\\Windows\\**', '..', 'a/../b', '../**']) {
    assert.throws(() => assertValidGlob(pattern), (error: unknown) => {
      assert.ok(error instanceof ProjectScanError);
      assert.equal(error.code, 'CONFIG_INVALID');
      return true;
    }, `pattern ${JSON.stringify(pattern)} must be rejected`);
  }

  const root = await makeRepo(t);
  await pkg(root, 'globs');
  for (const pattern of ['', 'a\0b', 'a\\b', '/etc/**', 'C:\\Windows\\**', '..', 'a/../b']) {
    await assertCode(resolveProjectScan({ startRoot: root, exclude: [pattern] }), 'CONFIG_INVALID');
    await assertCode(resolveProjectScan({ startRoot: root, include: [pattern] }), 'CONFIG_INVALID');
  }

  // A malicious glob smuggled through .pm/project.json is refused too.
  await writeFile(join(root, '.pm', 'project.json'), JSON.stringify({ name: 'globs', scan_ignore: ['../escape/**'] }));
  await assertCode(resolveProjectScan({ startRoot: root }), 'CONFIG_INVALID');
  await writeFile(join(root, '.pm', 'project.json'), '{ not json');
  await assertCode(resolveProjectScan({ startRoot: root }), 'CONFIG_INVALID');
  await writeFile(join(root, '.pm', 'project.json'), JSON.stringify({ name: 'globs', scan_ignore: 'not-an-array' }));
  await assertCode(resolveProjectScan({ startRoot: root }), 'CONFIG_INVALID');

  // A valid glob cannot be turned into an absolute/traversal match.
  assert.equal(matchesGlob('src/**', '/etc/passwd'), false);
  assert.equal(matchesGlob('src/**', 'etc/passwd'), false);
  assert.equal(matchesGlob('src/**', 'src/a.ts'), true);
});

// ---- 6. nested-package root bypass and role conflicts -------------------

test('T-109/06 nested-package roots cannot escape the Git root or impersonate roles', async (t) => {
  const root = await makeRepo(t);
  await pkg(join(root, 'server'), 'server');
  const external = await makeRoot(t, 'ano-scan-rb-ext-');
  await pkg(join(external, 'x'), 'x');

  await assertCode(resolveProjectScan({ startRoot: root, sourceRoots: [join(external, 'x')] }), 'SOURCE_ROOT_OUTSIDE_GIT_ROOT');
  await assertCode(resolveProjectScan({ startRoot: root, sourceRoots: [join(root, 'server'), join(external, 'x')] }), 'SOURCE_ROOT_OUTSIDE_GIT_ROOT');

  if (await canSymlink(root)) {
    await symlink(external, join(root, 'escape-link'), 'dir');
    await assertCode(resolveProjectScan({ startRoot: root, sourceRoots: [join(root, 'escape-link')] }), 'SOURCE_ROOT_OUTSIDE_GIT_ROOT');
  }

  await assertCode(resolveProjectScan({ startRoot: root, pmRoot: join(root, 'server') }), 'PM_ROOT_WITHOUT_PM');
  await mkdir(join(root, 'server', '.pm', '.runtime'), { recursive: true });
  await writeFile(join(root, 'server', '.pm', '.gitignore'), '.runtime/\n');
  await assertCode(resolveProjectScan({ startRoot: root, pmRoot: join(root, 'server') }), 'PM_ROOT_WITHOUT_PM');
  await assertCode(resolveProjectScan({ startRoot: join(root, 'server'), pmRoot: join(root, 'server') }), 'ROOT_ROLE_CONFLICT');
  await assertCode(resolveProjectScan({}), 'CONFIG_INVALID');
  await assertCode(resolveProjectScan({ startRoot: join(root, 'missing') }), 'CONFIG_INVALID');
});

test('T-109/06b a source-subdirectory .pm is never used as the migration/takeover PM root', async (t) => {
  const root = await makeRepo(t);
  await pkg(join(root, 'server'), 'server');
  const server = join(root, 'server');
  await mkdir(join(server, '.pm'), { recursive: true });
  await writeFile(join(root, '.pm', 'project.json'), JSON.stringify({ name: 'p' }));
  await writeFile(join(root, '.pm', 'tasks.json'), JSON.stringify({ seq: 1, tasks: [{ id: 'T-ROOT', title: 'root task', status: 'todo' }] }));
  // The decoy is deliberately malformed: parsing it would throw.
  await writeFile(join(server, '.pm', 'tasks.json'), '{ DECOY NOT JSON');

  assert.equal(resolveMigrationPmRoot(server), root);
  const plan = planMigration(server);
  assert.equal(plan.root, root);
  assert.deepEqual(plan.tasks.map((task) => task.id), ['T-ROOT']);
  assert.deepEqual(plan.sources.map((source) => source.path), ['.pm/tasks.json', '.pm/roadmap.json', '.pm/features.json', '.pm/sessions.json']);
  assert.equal(JSON.stringify(plan).includes('DECOY'), false, 'the decoy .pm content was read');

  const resolution = await resolveMigrationRoot(server);
  assert.equal(resolution.pmRoot, root);
  assert.deepEqual(resolution.sourceRoots, [server]);
  assert.deepEqual(resolution.ignoredPmRoots, [server]);
  assert.equal(resolution.rootResolution.pmRoot, root);

  assert.equal(takeoverStatus(server).root, root);
  assert.equal(computeTakeoverSourceDigest(server), computeTakeoverSourceDigest(root));
});

// ---- 7. PM counts and graph files come from their own roots -------------

test('T-109/07 PM counts come from pmRoot while graph files come from sourceRoots', async (t) => {
  const git = await makeRepo(t);
  const pm = await makeRoot(t, 'ano-scan-rb-pm-');
  await mkdir(join(pm, '.pm'), { recursive: true });
  const server = join(git, 'server');
  await pkg(server, 'server');
  await mkdir(join(server, '.pm'), { recursive: true });
  await writeFile(join(git, '.pm', 'project.json'), JSON.stringify({ name: 'git' }));
  await writeFile(join(git, '.pm', 'tasks.json'), JSON.stringify({ seq: 1, tasks: [{ id: 'T-GIT', title: 'git task', status: 'todo' }] }));
  await writeFile(join(pm, '.pm', 'project.json'), JSON.stringify({ name: 'pm' }));
  await writeFile(join(pm, '.pm', 'tasks.json'), JSON.stringify({ seq: 1, tasks: [{ id: 'T-PM', title: 'pm task', status: 'todo' }] }));
  await writeFile(join(server, '.pm', 'tasks.json'), '{ DECOY NOT JSON');
  await writeFile(join(server, 'a.ts'), 'export const a = 1;\n');

  const scan = await resolveProjectScan({ startRoot: git, pmRoot: pm, sourceRoots: [server] });
  assert.equal(scan.pmRoot, pm);
  assert.deepEqual(scan.sourceRoots, [server]);
  assert.equal(scan.rootResolution.pmRoot, pm);
  assert.deepEqual(scan.rootResolution.sourceRoots, [server]);
  assert.deepEqual(scan.ignoredPmRoots, [server]);

  assert.deepEqual(planMigration(pm).tasks.map((task) => task.id), ['T-PM']);
  assert.deepEqual(planMigration(git).tasks.map((task) => task.id), ['T-GIT'], 'the source subdirectory decoy must not leak into PM counts');
  assert.equal(JSON.stringify(planMigration(git)).includes('DECOY'), false);

  const store = await GraphStore.open(git, { scan });
  await store.build();
  assert.deepEqual(store.filesList(), ['server/a.ts'], 'the graph must contain source-root files only');
  const graphJson = JSON.stringify(store.snapshot());
  assert.equal(graphJson.includes('T-PM'), false);
  assert.equal(graphJson.includes('T-GIT'), false);
  assert.equal(store.buildOutcome?.rootResolution?.pmRoot, pm);
  store.close();
});

// ---- 8. timeout fails closed --------------------------------------------

test('T-109/08 budget exhaustion fails closed as timeout, never as an empty ok', async (t) => {
  const expired = createScanBudget({ deadline: 0 });
  assert.equal(scanBudgetTimedOut(expired), true);
  assert.equal(scanBudgetExceeded(expired), false, 'the file/byte ceiling is independent of the clock');
  assert.equal(scanBudgetExhausted(expired), true);
  assert.equal(scanStatusForResult(expired, 0), 'timeout');
  assert.equal(scanStatusForResult(createScanBudget({ now: () => 1000 }), 0, 1000), 'degraded');
  assert.equal(scanStatusForResult(createScanBudget({ now: () => 1000 }), 5, 1000), 'ok');
  const cappedBudget = createScanBudget({ maxFiles: 1, now: () => 1000 });
  assert.equal(scanBudgetExceeded(cappedBudget), false);
  cappedBudget.filesSeen = 1;
  assert.equal(scanBudgetExceeded(cappedBudget), true);

  const root = await makeRepo(t);
  await pkg(root, 'timeout');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  await writeFile(join(root, 'src', 'b.ts'), 'export const b = 1;\n');

  const fingerprint = await fingerprintTree(root, { budgets: createScanBudget({ deadline: 0 }) });
  assert.equal(fingerprint.status, 'timeout');
  assert.equal(fingerprint.partial, true);
  assert.equal(fingerprint.reason, 'scan-budget-exceeded');
  assert.ok(fingerprint.completed);
  assert.equal(fingerprint.completed.files, 0);
  assert.equal(fingerprint.stats?.timeout, 1);
  assert.notEqual(fingerprint.status, 'ok');

  const capped = await fingerprintTree(root, { budgets: createScanBudget({ maxFiles: 1, now: () => 1000 }) });
  assert.equal(capped.status, 'timeout');
  assert.equal(capped.partial, true);
  assert.equal(capped.reason, 'scan-budget-exceeded');

  const scan = await resolveProjectScan({ startRoot: root });
  const store = await GraphStore.open(root, { scan });
  await store.build();
  const previousFiles = store.filesList();
  const previousRevision = store.revision;
  assert.ok(previousFiles.length > 0);

  const timed = await store.build({ scan: { startRoot: root, deadline: Date.now() - 1000 } });
  const outcome = timed.buildOutcome!;
  assert.equal(outcome.status, 'timeout');
  assert.equal(outcome.partial, true);
  assert.equal(outcome.stale, true);
  assert.equal(outcome.files, previousFiles.length, 'the previous snapshot is retained, not replaced by files=0');
  assert.equal(outcome.reason, 'scan-budget-exceeded');
  assert.ok(outcome.completed);
  assert.ok(outcome.budget);
  assert.deepEqual(store.filesList(), previousFiles);
  assert.equal(store.revision, previousRevision);
  assert.equal(store.freshness().status, 'stale');
  store.close();
});

// ---- 9. exclusion drift cannot be hidden as fresh ------------------------

test('T-109/09 exclusion-config drift invalidates the cache; excluded content changes do not', async (t) => {
  const root = await makeRepo(t);
  const server = join(root, 'server');
  await pkg(server, 'server');
  await mkdir(join(root, 'logs'), { recursive: true });
  await writeFile(join(server, 'a.ts'), 'export const a = 1;\n');
  await writeFile(join(root, 'logs', 'run.log'), 'log\n');
  const pmConfig = join(root, '.pm', 'project.json');
  await writeFile(pmConfig, JSON.stringify({ name: 'drift', scan_ignore: ['logs/**'] }));
  const pmBefore = await readFile(pmConfig, 'utf8');

  const scan = await resolveProjectScan({ startRoot: root });
  assert.deepEqual(scan.sourceRoots, [server]);
  const store = await GraphStore.open(root, { scan });
  await store.build();
  assert.equal(store.freshness().status, 'fresh');
  store.close();
  assert.equal(await readFile(pmConfig, 'utf8'), pmBefore, '.pm/project.json must never be rewritten');

  // A no-op exclusion change still changes the scan key: the cache is stale.
  await writeFile(pmConfig, JSON.stringify({ name: 'drift', scan_ignore: ['logs/**', 'nothing/**'] }));
  const nextScan = await resolveProjectScan({ startRoot: root });
  const reopened = await GraphStore.open(root, { scan: nextScan });
  assert.equal(reopened.freshness().status, 'stale', 'scan-ignore drift must invalidate the cache instead of reporting fresh');
  const outcome = await reopened.ensureFresh();
  assert.equal(outcome.cache, 'miss');
  assert.equal(reopened.freshness().status, 'fresh');
  reopened.close();

  // Changing a file inside an excluded directory must not affect the graph.
  await writeFile(join(root, 'logs', 'run.log'), 'CHANGED LOG\n');
  const afterExcluded = await GraphStore.open(root, { scan: nextScan });
  assert.equal(afterExcluded.freshness().status, 'fresh');
  assert.deepEqual(afterExcluded.filesList(), ['server/a.ts']);
  const check = await afterExcluded.checkFreshness();
  assert.equal(check.status, 'fresh');
  afterExcluded.close();

  // Control: a non-excluded change does change the fingerprint.
  const beforeChange = await fingerprintSourceRoots(root, nextScan.sourceRoots, { scan: nextScan });
  await writeFile(join(server, 'a.ts'), 'export const a = 2;\n');
  const afterChange = await fingerprintSourceRoots(root, nextScan.sourceRoots, { scan: nextScan });
  assert.notEqual(afterChange.hash, beforeChange.hash);
});

// ---- 10. Gate evidence boundary -----------------------------------------

test('T-109/10 scan/graph/migration/takeover outputs carry no Gate vocabulary', async (t) => {
  const { root, authorizationId } = await takeoverFixture(t);
  const scan = await resolveProjectScan({ startRoot: root });
  const fingerprint = await fingerprintSourceRoots(root, scan.sourceRoots, { scan });
  const store = await GraphStore.open(root, { scan });
  await store.build();
  const outcome = store.buildOutcome!;
  const plan = planMigration(root);
  const reconcile = reconcileMigration(root);
  const status = takeoverStatus(root);
  const run = await runTakeover(root, { confirm: true, authorizationId, now: NOW, hostCapability: 'degraded' });
  store.close();

  assertNoGateVocabulary([scan, fingerprint, outcome, plan, reconcile, status, run]);
  assert.equal(existsSync(join(root, '.ano', 'connect', 'cutover.json')), false);
  assert.equal(existsSync(join(root, '.ano', 'evidence')), false);
});

// ---- 11. injected deps prove the traversal boundary ---------------------

test('T-109/11 injected deps prove discovery stays inside the Git root and never reads secrets', async (t) => {
  const root = await makeRepo(t);
  await pkg(join(root, 'server'), 'server');
  await writeSecretFixture(root);
  await writeFile(join(root, '.pm', 'project.json'), JSON.stringify({ name: 'deps', scan_ignore: ['logs/**'] }));
  const external = await makeRoot(t, 'ano-scan-rb-ext-');
  await pkg(join(external, 'sneaky'), 'sneaky');

  const visited: string[] = [];
  const read: string[] = [];
  const lstatted: string[] = [];
  const deps: ProjectScanDeps = {
    readdir: async (directory) => {
      visited.push(directory);
      return readdir(directory);
    },
    lstat: async (path) => {
      lstatted.push(path);
      return lstat(path);
    },
    readFile: async (path) => {
      read.push(path);
      return readFile(path, 'utf8');
    },
  };

  const resolved = await resolveProjectScan({ startRoot: root }, deps);
  assert.ok(visited.length > 0);
  for (const directory of visited) {
    const rel = relative(root, directory).split(sep).join('/');
    assert.ok(rel.length === 0 || (!rel.startsWith('..') && !isAbsolute(rel)), `discovery left the Git root: ${directory}`);
  }
  assert.equal(visited.includes(external), false, 'discovery must never read a sibling/outside directory');
  for (const path of read) {
    const rel = relative(root, path).split(sep).join('/');
    assert.ok(rel.length === 0 || (!rel.startsWith('..') && !isAbsolute(rel)), `read outside the Git root: ${path}`);
    assert.equal(isSecretPath(rel), false, `the resolver read a secret path: ${path}`);
  }
  for (const path of lstatted) {
    const rel = relative(root, path).split(sep).join('/');
    assert.ok(rel.length === 0 || (!rel.startsWith('..') && !isAbsolute(rel)), `lstat outside the Git root: ${path}`);
  }
  assert.ok(read.some((path) => path.endsWith(join('.pm', 'project.json'))), 'scan_ignore must be read from the PM root');
  assert.deepEqual(resolved.sourceRoots, [join(root, 'server')]);
});

// ---- 12. legacy interfaces remain compatible ----------------------------

test('T-109/12 scan-free legacy interfaces remain compatible', async (t) => {
  const root = await makeRepo(t);
  await pkg(root, 'legacy');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  await mkdir(join(root, '.ano', 'cache'), { recursive: true });
  await writeFile(join(root, '.ano', 'cache', 'views.db'), 'not source');

  const first = await fingerprintTree(root);
  const second = await fingerprintTree(root);
  assert.equal(first.hash, second.hash);
  assert.deepEqual(first.files.map((file) => file.path), ['package.json', 'src/a.ts']);

  const store = await GraphStore.open(root);
  await store.build();
  assert.deepEqual(store.filesList(), ['src/a.ts']);
  const snapshot = store.snapshot();
  store.close();
  const legacyFreshness = await checkGraphFreshness(root, snapshot);
  assert.equal(legacyFreshness.freshness.status, 'fresh');

  const byGitRoot = await resolveProjectScan({ gitRoot: root });
  assert.equal(byGitRoot.gitRoot, root);
  const cacheReuse = await resolveProjectScan({ startRoot: root, cache: { reuse: 'never' } });
  assert.equal(cacheReuse.reuse, 'never');
  const topReuse = await resolveProjectScan({ startRoot: root, reuse: 'always' });
  assert.equal(topReuse.reuse, 'always');
  const rawOptions = await resolveProjectScan({ startRoot: root, followLinks: false, maxFileBytes: 1024, timeoutMs: 2048 });
  assert.equal(rawOptions.followLinks, false);
  assert.equal(rawOptions.maxFileBytes, 1024);
  assert.equal(rawOptions.timeoutMs, 2048);
});

// ---- 13. error-code contract (ADR-009 §11) ------------------------------

test('T-109/13 scan error codes are explicit and stable', async (t) => {
  const root = await makeRepo(t);
  await pkg(root, 'codes');
  await assertCode(resolveProjectScan({ startRoot: root, exclude: ['..'] }), 'CONFIG_INVALID');
  await assertCode(resolveProjectScan({ startRoot: root, sourceRoots: [] }), 'CONFIG_INVALID');
  await assertCode(resolveProjectScan({ startRoot: root, onAmbiguity: 'nope' as never }), 'CONFIG_INVALID');
  await assertCode(resolveProjectScan({ startRoot: root, cache: { reuse: 'nope' as never } }), 'CONFIG_INVALID');
  await assertCode(resolveProjectScan({ startRoot: root, maxDiscoverDepth: 1.5 }), 'CONFIG_INVALID');

  const ambiguous = await makeRepo(t);
  await pkg(join(ambiguous, 'a'), 'a');
  await pkg(join(ambiguous, 'b'), 'b');
  await assertCode(resolveProjectScan({ startRoot: ambiguous, onAmbiguity: 'error' }), 'AMBIGUOUS_SOURCE_ROOTS');

  const noPackage = await makeRepo(t);
  await assertCode(resolveProjectScan({ startRoot: noPackage }), 'NO_NODE_PACKAGE');

  const noGit = await makeRoot(t, 'ano-scan-rb-nogit-');
  await mkdir(join(noGit, '.pm'), { recursive: true });
  await pkg(noGit, 'no-git');
  await assertCode(resolveProjectScan({ startRoot: noGit }), 'NOT_A_GIT_WORK_TREE');
  const relaxed = await resolveProjectScan({ startRoot: noGit, requireGit: false });
  assert.equal(relaxed.gitRoot, noGit);
  assert.equal(codeOf(new ProjectScanError('LINK_ESCAPE', 'x')), 'LINK_ESCAPE');
});
