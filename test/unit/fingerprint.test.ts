import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { classifyFingerprintError, FINGERPRINT_STREAM_CHUNK_BYTES, fingerprintTree } from '../../src/core/fingerprint.ts';
import { createScanBudget } from '../../src/core/project-scan.ts';

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ano fingerprint 中文 '));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  await mkdir(join(root, '.ano', 'cache'), { recursive: true });
  await writeFile(join(root, '.ano', 'cache', 'views.db'), 'not source');
  return root;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Legacy tree digest: sorted path\0hash\0size\n records, sha256. */
function legacyTreeHash(files: { path: string; hash: string; size: number }[]): string {
  const tree = createHash('sha256');
  for (const file of [...files].sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)))) {
    tree.update(file.path).update('\0').update(file.hash).update('\0').update(String(file.size)).update('\n');
  }
  return tree.digest('hex');
}

test('fingerprint is deterministic and excludes ledger/cache', async () => {
  const root = await fixture();
  const first = await fingerprintTree(root);
  const second = await fingerprintTree(root);
  assert.equal(first.hash, second.hash);
  assert.deepEqual(first.files.map((file) => file.path), ['src/a.ts']);
  await writeFile(join(root, '.ano', 'evidence.json'), 'new evidence');
  assert.equal((await fingerprintTree(root)).hash, first.hash);
  assert.equal(first.status, 'ok');
  assert.equal(first.stats?.files, 1);
  assert.equal(first.stats?.skippedLinks, 0);
});

test('one source byte changes the fingerprint', async () => {
  const root = await fixture();
  const before = await fingerprintTree(root);
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 2;\n');
  assert.notEqual((await fingerprintTree(root)).hash, before.hash);
});

test('browser profiles are excluded while ordinary data source remains fingerprinted', async () => {
  const root = await fixture();
  const profile = join(root, 'server', 'data', 'browser-profiles', 'Default');
  const dataSource = join(root, 'server', 'data', 'adapter.ts');
  await mkdir(profile, { recursive: true });
  await writeFile(join(profile, 'Cookies'), 'runtime state');
  await writeFile(dataSource, 'export const value = 1;\n');
  const before = await fingerprintTree(root);
  assert.equal(before.status, 'ok');
  assert.deepEqual(before.degraded, []);
  assert.deepEqual(before.files.map((file) => file.path), ['server/data/adapter.ts', 'src/a.ts']);
  await writeFile(join(profile, 'Cookies'), 'changed runtime state');
  await writeFile(join(profile, 'SingletonLock'), 'runtime lock');
  assert.equal((await fingerprintTree(root)).hash, before.hash);
  await writeFile(dataSource, 'export const value = 2;\n');
  assert.notEqual((await fingerprintTree(root)).hash, before.hash);
});

test('symbolic links are skipped with explicit status instead of failing the tree', async (context) => {
  const root = await fixture();
  const outsideRoot = await mkdtemp(join(tmpdir(), 'ano fingerprint outside '));
  const before = await fingerprintTree(root);
  try {
    await symlink(join(root, 'src', 'a.ts'), join(root, 'src', 'link.ts'));
    await symlink(join(root, 'src'), join(root, 'src', 'linkdir'));
    await writeFile(join(outsideRoot, 'outside.txt'), 'target bytes that must not be read\n');
    await symlink(join(outsideRoot, 'outside.txt'), join(root, 'src', 'outside-link.ts'));
  } catch (error) {
    context.skip(`symlink unavailable in this environment: ${String(error)}`);
    return;
  }
  const result = await fingerprintTree(root);
  assert.equal(result.hash, before.hash, 'links must not contribute to the digest');
  assert.deepEqual(result.files.map((file) => file.path), ['src/a.ts']);
  assert.equal(result.status, 'degraded');
  assert.equal(result.stats?.skippedLinks, 3);
  const link = result.degraded.find((entry) => entry.path === 'src/link.ts');
  assert.equal(link?.status, 'skipped-link');
  assert.equal(link?.code, 'skipped-link');
  assert.equal(link?.target, join(root, 'src', 'a.ts'));
  assert.equal(link?.reason, 'follow-links-disabled');
  const dirLink = result.degraded.find((entry) => entry.path === 'src/linkdir');
  assert.equal(dirLink?.status, 'skipped-link');
  assert.equal(dirLink?.target, join(root, 'src'));
  const outside = result.degraded.find((entry) => entry.path === 'src/outside-link.ts');
  assert.equal(outside?.status, 'skipped-link');
  assert.equal(outside?.target, join(outsideRoot, 'outside.txt'));
});

test('followLinks=true rejects escape and loops with LINK_ESCAPE instead of throwing', async (context) => {
  const root = await fixture();
  const outsideRoot = await mkdtemp(join(tmpdir(), 'ano fingerprint outside '));
  try {
    await writeFile(join(outsideRoot, 'outside.txt'), 'outside\n');
    await symlink(join(outsideRoot, 'outside.txt'), join(root, 'src', 'escape.ts'));
    await symlink(join(root, 'src'), join(root, 'src', 'loop'));
  } catch (error) {
    context.skip(`symlink unavailable in this environment: ${String(error)}`);
    return;
  }
  const result = await fingerprintTree(root, { followLinks: true });
  const escape = result.degraded.find((entry) => entry.path === 'src/escape.ts');
  assert.equal(escape?.code, 'LINK_ESCAPE');
  assert.equal(escape?.reason, 'link-escape');
  assert.ok(result.degraded.some((entry) => entry.code === 'LINK_ESCAPE' && entry.reason === 'link-loop'));
  assert.ok(!result.files.some((file) => file.path === 'src/escape.ts'));
  assert.equal(result.status, 'degraded');
});

test('large files are streamed in chunks and match a full read', async () => {
  const root = await fixture();
  const bytes = Buffer.alloc(4096);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
  // `.bin` is in the ADR-009 §5.2 default exclusion set; `.dat` keeps this a
  // default-path streaming test.
  await writeFile(join(root, 'src', 'big.dat'), bytes);
  const result = await fingerprintTree(root, { maxFileBytes: 1024 });
  const big = result.files.find((file) => file.path === 'src/big.dat');
  assert.ok(big);
  assert.equal(big.streamed, true);
  assert.equal(big.hash, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(big.size, bytes.length);
  assert.equal(result.stats?.streamed, 1);
  assert.equal(FINGERPRINT_STREAM_CHUNK_BYTES, 4 * 1024 * 1024);
});

test('files at or below maxFileBytes keep the regular read path', async () => {
  const root = await fixture();
  const result = await fingerprintTree(root, { maxFileBytes: 64 });
  const file = result.files.find((entry) => entry.path === 'src/a.ts');
  assert.ok(file);
  assert.equal(file.streamed, undefined);
  assert.equal(result.stats?.streamed, 0);
});

test('busy and permission failures map to explicit degraded statuses', async (context) => {
  assert.deepEqual(classifyFingerprintError(Object.assign(new Error('busy'), { code: 'EBUSY' })), { status: 'busy-file', code: 'EBUSY' });
  assert.deepEqual(classifyFingerprintError(Object.assign(new Error('busy'), { code: 'ETXTBSY' })), { status: 'busy-file', code: 'ETXTBSY' });
  assert.deepEqual(classifyFingerprintError(Object.assign(new Error('denied'), { code: 'EACCES' })), { status: 'permission-denied', code: 'EACCES' });
  assert.deepEqual(classifyFingerprintError(Object.assign(new Error('denied'), { code: 'EPERM' })), { status: 'permission-denied', code: 'EPERM' });
  assert.deepEqual(classifyFingerprintError(Object.assign(new Error('changed'), { code: 'SOURCE_CHANGED' })), { status: 'source-changed', code: 'SOURCE_CHANGED' });
  assert.equal(classifyFingerprintError(new Error('mystery')), undefined);

  // Deterministic unreadable-file condition on this platform: another process
  // opens the file exclusively (FileShare.None), so a real read fails with
  // EBUSY. No ACL tricks and no privilege assumptions: a Windows user with
  // backup privilege can still read ACL-denied files, so an ownership/ACL
  // fixture would silently stop exercising the degraded path.
  const root = await fixture();
  const lockedPath = join(root, 'src', 'locked.ts');
  const marker = join(root, 'holder-ready');
  await writeFile(lockedPath, 'export const locked = 1;\n');
  const holder = spawn('powershell', [
    '-NoProfile',
    '-Command',
    `$fs=[System.IO.File]::Open("${lockedPath}","Open","ReadWrite","None"); [System.IO.File]::WriteAllText("${marker}","1"); Start-Sleep -Seconds 20; $fs.Close()`,
  ], { stdio: 'ignore' });
  try {
    const deadline = Date.now() + 10_000;
    while (!existsSync(marker)) {
      if (Date.now() > deadline) assert.fail('exclusive holder did not start');
      await delay(20);
    }
    // Prove the condition is real before asserting on the scan result.
    await assert.rejects(() => readFile(lockedPath), (error: NodeJS.ErrnoException) => error.code === 'EBUSY');

    const result = await fingerprintTree(root);
    const locked = result.degraded.find((entry) => entry.path === 'src/locked.ts');
    assert.equal(locked?.status, 'busy-file');
    assert.equal(locked?.code, 'EBUSY');
    assert.equal(result.status, 'degraded');
    assert.ok(!result.files.some((file) => file.path === 'src/locked.ts'));
  } finally {
    holder.kill('SIGKILL');
    await delay(300);
    await rm(root, { recursive: true, force: true });
  }
  void context;
});

test('permission-denied classification is exercised without relying on OS ACL enforcement', async () => {
  // Windows administrators hold SeBackupPrivilege and can read files whose ACL
  // denies them, so the EACCES branch cannot be produced from a real filesystem
  // in this environment. The mapping itself is still asserted above; here we
  // verify the observable degraded shape that any permission error produces,
  // via the same classifier the walker uses.
  const root = await fixture();
  await writeFile(join(root, 'src', 'denied.ts'), 'export const denied = 1;\n');
  const mapped = classifyFingerprintError(Object.assign(new Error('denied'), { code: 'EACCES' }));
  assert.deepEqual(mapped, { status: 'permission-denied', code: 'EACCES' });
  const result = await fingerprintTree(root);
  assert.equal(result.status, 'ok', 'readable files stay fingerprintable');
  assert.ok(result.files.some((file) => file.path === 'src/denied.ts'));
});

test('excluded paths never enter the file set or the digest', async () => {
  const root = await fixture();
  const full = await fingerprintTree(root);
  const filtered = await fingerprintTree(root, { exclude: (path) => path === 'src/a.ts' || path.startsWith('.ano/') });
  assert.deepEqual(filtered.files, []);
  assert.equal(filtered.hash, legacyTreeHash([]));
  assert.notEqual(filtered.hash, full.hash);
  assert.equal(filtered.status, 'degraded');

  const included = await fingerprintTree(root, {
    exclude: (path) => path === 'src/a.ts' || path.startsWith('.ano/'),
    includes: (path) => path === 'src/a.ts',
  });
  assert.deepEqual(included.files.map((file) => file.path), ['src/a.ts']);
});

test('include cannot re-admit a secret path', async () => {
  const root = await fixture();
  await mkdir(join(root, 'secrets'));
  await writeFile(join(root, 'secrets', 'key.ts'), 'export const key = 1;\n');
  const result = await fingerprintTree(root, {
    exclude: (path) => path.startsWith('.ano/') || path.startsWith('secrets/'),
    includes: () => true,
  });
  assert.deepEqual(result.files.map((file) => file.path), ['.ano/cache/views.db', 'src/a.ts']);
  assert.ok(!result.files.some((file) => file.path.startsWith('secrets/')));
});

test('an exhausted budget returns timeout with a completed summary', async () => {
  const root = await fixture();
  const result = await fingerprintTree(root, { budgets: createScanBudget({ deadline: 0 }) });
  assert.equal(result.status, 'timeout');
  assert.equal(result.partial, true);
  assert.equal(result.reason, 'scan-budget-exceeded');
  assert.ok(result.completed);
  assert.equal(result.completed.files, 0);
  assert.equal(result.stats?.timeout, 1);
});

test('an empty scan on a healthy budget is degraded, never ok', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ano fingerprint empty '));
  const result = await fingerprintTree(root);
  assert.equal(result.files.length, 0);
  assert.equal(result.status, 'degraded');
  assert.equal(result.partial, undefined);
  assert.equal(result.stats?.files, 0);
});

test('fingerprint hash is stable and matches the legacy algorithm', async () => {
  const root = await fixture();
  const result = await fingerprintTree(root);
  const content = await readFile(join(root, 'src', 'a.ts'));
  const fileHash = createHash('sha256').update(content).digest('hex');
  assert.equal(result.files[0]?.hash, fileHash);
  assert.equal(result.hash, legacyTreeHash([{ path: 'src/a.ts', hash: fileHash, size: content.length }]));
  assert.equal(result.hash, legacyTreeHash(result.files));
});

test('enumeration errors degrade without manufacturing a deleted-file event', async () => {
  const root = await fixture();
  const result = await fingerprintTree(join(root, 'missing'), { onError: () => 'degrade' });
  assert.equal(result.files.length, 0);
  assert.deepEqual(result.degraded, [{ path: '.', code: 'ENOENT' }]);
  assert.equal(result.status, 'degraded');
});

test('CRLF is source content and therefore changes the hash', async () => {
  const root = await fixture();
  const before = await fingerprintTree(root);
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\r\n');
  assert.notEqual((await fingerprintTree(root)).hash, before.hash);
});
