/**
 * T-075 / TO-11: security red team for the enforced-takeover boundary.
 *
 * Scope (docs/adr/ADR-006-project-takeover.md §2, §3, §4; docs/takeover.md §6):
 * cross-root/cross-project authorization, path traversal, forged authorization,
 * tampered policy/journal, tampered backup, malicious managed-section content,
 * concurrent legacy writes under `enforced`, Gate/permission overreach, explicit
 * authorization limits, and sensitive-file collection.
 *
 * Every scenario runs in a fresh `os.tmpdir()` project and never writes the
 * repository's own `.pm/`, `.ano/` or user-level configuration. Failures are
 * asserted as explicit error codes/messages; nothing is silently accepted.
 *
 * Known gaps found by the probes that produced this file are reported by the
 * caller (they are not fixable from a test): see the run report.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { LedgerEvent } from '../../src/ledger/event.ts';
import { replayLedger } from '../../src/ledger/replay.ts';
import { restoreProject, verifyBackup } from '../../src/connect/backup.ts';
import { assertLegacyWriteAllowed, legacyWriteDecision, roleMatrixForState } from '../../src/connect/capabilities.ts';
import {
  MANAGED_INSTRUCTIONS_BEGIN,
  MANAGED_INSTRUCTIONS_END,
  MAX_MANAGED_INSTRUCTIONS_BYTES,
  installManagedInstructions,
  renderDefaultManagedInstructions,
} from '../../src/connect/managed-instructions.ts';
import { assertSafeRelative, resolveRoot, safeChild } from '../../src/connect/paths.ts';
import {
  computeAuthorizationId,
  computePolicyStateHash,
  createAuthorization,
  createPolicy,
  type CreateAuthorizationInput,
  type TakeoverAuthorization,
} from '../../src/connect/takeover-policy.ts';
import {
  appendTransaction,
  applyStateTransition,
  computeTransactionId,
  loadAuthorization,
  loadPolicy,
  readTransactions,
  saveAuthorization,
  savePolicy,
  takeoverDir,
} from '../../src/connect/takeover-store.ts';
import {
  runTakeover,
  takeoverStatus,
  type TakeoverRunOptions,
  type TakeoverRunResult,
  type TakeoverStatus,
} from '../../src/connect/takeover.ts';
import { detectLegacyDrift, watchDrift } from '../../src/connect/watch.ts';
import { takeoverRecover, takeoverRevoke, takeoverStatusSurface } from '../../src/surface/service.ts';

const NOW = '2026-11-22T00:00:00.000Z';
const FULL_SCOPES = ['tasks', 'memory', 'acceptance', 'dag'] as const;
const AGENTS_ORIGINAL = '<!-- pm-mcp:agents-md:v1:begin -->\npm rules\n<!-- pm-mcp:agents-md:v1:end -->\n\n# User notes\n\nkeep this 字节\n';

// ---- compile-time Gate boundary (type-level double insurance) ------------
// If a takeover result/status ever grows a Gate field, this assignment stops
// compiling instead of letting the runtime assertion be the only guard.
type AssertKeysAbsent<T, K extends string> = { readonly [P in K]: P extends keyof T ? readonly ['unexpected key', P] : never };
const _runResultGateKeys: AssertKeysAbsent<TakeoverRunResult, 'evidence_id' | 'verdict' | 'task_id'> = {
  evidence_id: undefined as never,
  verdict: undefined as never,
  task_id: undefined as never,
};
const _statusGateKeys: AssertKeysAbsent<TakeoverStatus, 'evidence_id' | 'verdict' | 'task_id'> = {
  evidence_id: undefined as never,
  verdict: undefined as never,
  task_id: undefined as never,
};
void _runResultGateKeys;
void _statusGateKeys;

// ---- helpers ------------------------------------------------------------

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function expectError(error: unknown, code: string, pattern: RegExp): boolean {
  assert.equal(codeOf(error), code);
  assert.match(error instanceof Error ? error.message : String(error), pattern);
  return true;
}

async function makeRoot(t: TestContext, prefix = 'ano-rb-'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function pmFixture(root: string): Promise<void> {
  await mkdir(join(root, '.pm'), { recursive: true });
  await writeFile(join(root, '.pm', 'project.json'), `${JSON.stringify({ id: 'fixture-project', name: 'Takeover Fixture' }, null, 2)}\n`);
  await writeFile(join(root, '.pm', 'tasks.json'), `${JSON.stringify({
    seq: 1,
    tasks: [
      { id: 'T-PM-1', title: 'Migrate me', status: 'done', files: ['test/a.test.ts'] },
      { id: 'T-PM-2', title: 'Keep going', status: 'in_progress' },
    ],
  }, null, 2)}\n`);
  await writeFile(join(root, '.pm', 'roadmap.json'), `${JSON.stringify({ seq: 1, milestones: [{ id: 'M1', title: 'One', status: 'active' }] }, null, 2)}\n`);
  await writeFile(join(root, '.pm', 'features.json'), `${JSON.stringify({ seq: 1, features: [{ id: 'F-1', name: 'Feature' }] }, null, 2)}\n`);
  await writeFile(join(root, '.pm', 'sessions.json'), `${JSON.stringify({ seq: 1, sessions: [{ id: 'S-1', summary: 'seed' }] }, null, 2)}\n`);
}

function writeAgents(root: string, content: string): void {
  writeFileSync(join(root, 'AGENTS.md'), content);
}

function readAgents(root: string): string {
  return readFileSync(join(root, 'AGENTS.md'), 'utf8');
}

async function grant(root: string, overrides: Partial<CreateAuthorizationInput> = {}): Promise<TakeoverAuthorization> {
  const canonical = resolveRoot(root);
  const authorization = createAuthorization({
    root: canonical,
    projectId: 'proj-1',
    projectKey: 'key-1',
    scope: [...FULL_SCOPES],
    grantedBy: 'Alice',
    role: 'owner',
    statement: 'I explicitly authorize ANO takeover of this project.',
    grantedAt: NOW,
    ...overrides,
  });
  saveAuthorization(canonical, authorization);
  return authorization;
}

function run(root: string, authorizationId: string, extra: Partial<TakeoverRunOptions> = {}): Promise<TakeoverRunResult> {
  return runTakeover(root, { confirm: true, authorizationId, now: NOW, hostCapability: 'degraded', ...extra });
}

async function pmSnapshot(root: string): Promise<string> {
  const entries: Array<Record<string, unknown>> = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(dir, entry.name);
      const rel = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(full, rel);
      else if (entry.isFile()) {
        const bytes = await readFile(full);
        entries.push({ path: rel, bytes: bytes.length });
      }
    }
  };
  await walk(join(root, '.pm'), '');
  return JSON.stringify(entries);
}

function ledgerEvents(root: string): LedgerEvent[] {
  return replayLedger(join(root, '.ano', 'ledger')).entries.map((entry) => entry.event);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

async function collectFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await collectFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

async function canCreateSymlink(directory: string): Promise<boolean> {
  const target = join(directory, `symlink-target-${process.pid}`);
  const link = join(directory, `symlink-link-${process.pid}`);
  try {
    await writeFile(target, 'x');
    await symlink(target, link, 'file');
    await rm(link, { force: true });
    await rm(target, { force: true });
    return true;
  } catch {
    return false;
  }
}

function isSensitivePath(path: string): boolean {
  const parts = path.split('/');
  const base = parts.at(-1) ?? '';
  if (parts.includes('secrets') || parts.includes('secret')) return true;
  if (/^\.env(?:\..*)?$/u.test(base)) return true;
  if (/\.(?:pem|key|p12|pfx|kdbx|ppk)$/iu.test(base)) return true;
  return base === 'id_rsa' || base === 'id_ed25519' || base === 'credentials.json';
}

// ---- 1. cross-root / cross-project --------------------------------------

test('T-075/01 cross-root authorization is refused on apply, status and managed writes', async (t) => {
  const rootA = await makeRoot(t, 'ano-rb-a-');
  const rootB = await makeRoot(t, 'ano-rb-b-');
  await pmFixture(rootA);
  await pmFixture(rootB);
  writeAgents(rootA, AGENTS_ORIGINAL);
  writeAgents(rootB, AGENTS_ORIGINAL);
  const authA = await grant(rootA);

  // (a) root B has no authorization record at all.
  await assert.rejects(run(rootB, authA.authorizationId), (error: unknown) => expectError(error, 'TAKEOVER', /no takeover authorization/));
  assert.equal(existsSync(join(rootB, '.ano', 'takeover')), false, 'a refused cross-root apply must not create the takeover directory');

  // (b) root A's authorization record copied into root B: structural root binding rejects it.
  await mkdir(join(rootB, '.ano', 'takeover'), { recursive: true });
  writeFileSync(join(rootB, '.ano', 'takeover', 'authorization.json'), `${JSON.stringify(authA, null, 2)}\n`);
  assert.throws(() => loadAuthorization(rootB), (error: unknown) => expectError(error, 'CONNECT_SOURCE', /takeover authorization is bound to .*not/));
  await assert.rejects(run(rootB, authA.authorizationId), (error: unknown) => expectError(error, 'CONNECT_SOURCE', /bound to/));
  assert.throws(() => takeoverStatus(rootB), (error: unknown) => expectError(error, 'CONNECT_SOURCE', /bound to/));
  const surface = takeoverStatusSurface(rootB);
  assert.equal(surface.state, 'unknown');
  assert.match(String(surface.error), /bound to/);
  assert.throws(
    () => installManagedInstructions(rootB, 'managed body', { confirm: authA }),
    (error: unknown) => expectError(error, 'CONNECT_SOURCE', /not bound to the target project root/),
  );
  assert.equal(readAgents(rootB), AGENTS_ORIGINAL);

  // (c) control: root B's own grant works, so the refusal is binding-based, not a blanket block.
  const authB = await grant(rootB);
  const appliedB = await run(rootB, authB.authorizationId);
  assert.equal(appliedB.active, true);
  assert.equal(appliedB.root, resolveRoot(rootB));
});

// ---- 2. path traversal / symlinks ---------------------------------------

test('T-075/02 path traversal, absolute paths and symlinks are refused', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'ano-rb-path-'));
  t.after(async () => {
    await rm(base, { recursive: true, force: true });
  });

  // Store-level path guards.
  assert.throws(() => safeChild(base, '..', 'escape'), (error: unknown) => expectError(error, 'CONNECT_SOURCE', /Path traversal is not allowed/));
  assert.throws(() => safeChild(base, '/absolute'), (error: unknown) => expectError(error, 'CONNECT_SOURCE', /Path must be relative/));
  assert.throws(() => safeChild(base, 'C:/absolute'), (error: unknown) => expectError(error, 'CONNECT_SOURCE', /Path must be relative/));
  assert.throws(() => assertSafeRelative('a/../b'), (error: unknown) => expectError(error, 'CONNECT_SOURCE', /Path traversal is not allowed/));
  assert.throws(() => assertSafeRelative('a\\b'), (error: unknown) => expectError(error, 'CONNECT_SOURCE', /must use '\/' separators/));
  assert.equal(resolveRoot(join(base, '..', basename(base))), base, 'dot-dot path is canonicalized, not treated as a string');

  // Forged authorization whose bound root contains '..' fails integrity.
  const root = await makeRoot(t, 'ano-rb-root-');
  await pmFixture(root);
  writeAgents(root, AGENTS_ORIGINAL);
  const auth = await grant(root);
  const authorizationFile = join(takeoverDir(root), 'authorization.json');
  writeFileSync(authorizationFile, `${JSON.stringify({ ...auth, root: `${auth.root}/../escape` }, null, 2)}\n`);
  assert.throws(() => loadAuthorization(root), (error: unknown) => expectError(error, 'CONNECT_TAMPER', /authorizationId does not match/));

  // Absolute-path injection with a *valid* id for another root fails root binding.
  const injected = createAuthorization({
    root: join(root, '..', 'not-this-project'),
    projectId: auth.projectId,
    projectKey: auth.projectKey,
    scope: [...FULL_SCOPES],
    grantedBy: auth.grantedBy,
    role: auth.role,
    statement: auth.statement,
    grantedAt: NOW,
  });
  writeFileSync(authorizationFile, `${JSON.stringify(injected, null, 2)}\n`);
  assert.throws(() => loadAuthorization(root), (error: unknown) => expectError(error, 'CONNECT_SOURCE', /bound to .*not/));
  saveAuthorization(resolveRoot(root), auth);
  assert.equal(loadAuthorization(root)?.authorizationId, auth.authorizationId);

  if (!(await canCreateSymlink(base))) {
    t.skip('platform cannot create symlinks without elevated privileges');
  }

  // Symlinked AGENTS.md is never written through.
  const outside = await makeRoot(t, 'ano-rb-out-');
  await writeFile(join(outside, 'AGENTS.md'), '# outside\n');
  const symlinkRoot = await makeRoot(t, 'ano-rb-sym-');
  await pmFixture(symlinkRoot);
  const symlinkAuth = await grant(symlinkRoot);
  await symlink(join(outside, 'AGENTS.md'), join(symlinkRoot, 'AGENTS.md'), 'file');
  assert.throws(
    () => installManagedInstructions(symlinkRoot, 'managed body', { confirm: symlinkAuth }),
    (error: unknown) => expectError(error, 'CONNECT_SOURCE', /Refusing to write through a symbolic link/),
  );

  // Symlinked `.ano` component is refused by the safe-directory walk.
  const linkAnoRoot = await makeRoot(t, 'ano-rb-linkano-');
  await pmFixture(linkAnoRoot);
  await symlink(outside, join(linkAnoRoot, '.ano'), 'dir');
  const linkAnoAuth = createAuthorization({
    root: resolveRoot(linkAnoRoot), projectId: 'proj-1', projectKey: 'key-1', scope: [...FULL_SCOPES],
    grantedBy: 'Alice', role: 'owner', statement: 'authorize', grantedAt: NOW,
  });
  assert.throws(
    () => saveAuthorization(resolveRoot(linkAnoRoot), linkAnoAuth),
    (error: unknown) => expectError(error, 'CONNECT_STORE', /Refusing to write through a symbolic link\/junction/),
  );

  // Symlinked `.ano/takeover` component is refused too.
  const linkTxRoot = await makeRoot(t, 'ano-rb-linktx-');
  await pmFixture(linkTxRoot);
  await mkdir(join(linkTxRoot, '.ano'), { recursive: true });
  await symlink(outside, join(linkTxRoot, '.ano', 'takeover'), 'dir');
  const linkTxAuth = createAuthorization({
    root: resolveRoot(linkTxRoot), projectId: 'proj-1', projectKey: 'key-1', scope: [...FULL_SCOPES],
    grantedBy: 'Alice', role: 'owner', statement: 'authorize', grantedAt: NOW,
  });
  assert.throws(
    () => saveAuthorization(resolveRoot(linkTxRoot), linkTxAuth),
    (error: unknown) => expectError(error, 'CONNECT_STORE', /Refusing to write through a symbolic link\/junction/),
  );

  // A symlinked project root is canonicalized to the same real project, so it
  // cannot be used to smuggle another root's authorization.
  const canonRoot = await makeRoot(t, 'ano-rb-canon-');
  await pmFixture(canonRoot);
  writeAgents(canonRoot, AGENTS_ORIGINAL);
  const canonAuth = await grant(canonRoot);
  const link = `${canonRoot}-link`;
  await symlink(canonRoot, link, 'dir');
  t.after(async () => {
    await rm(link, { recursive: true, force: true });
  });
  assert.equal(resolveRoot(link), resolveRoot(canonRoot));
  const viaLink = await run(link, canonAuth.authorizationId);
  assert.equal(viaLink.root, resolveRoot(canonRoot));
});

// ---- 3. forged authorization -------------------------------------------

test('T-075/03 forged authorization ids and duplicate ids are refused', async (t) => {
  const root = await makeRoot(t, 'ano-rb-forge-');
  await pmFixture(root);
  writeAgents(root, AGENTS_ORIGINAL);
  const auth = await grant(root);

  // Unknown id.
  await assert.rejects(run(root, 'a'.repeat(64)), (error: unknown) => expectError(error, 'TAKEOVER', /does not match the stored authorization/));
  assert.equal(readAgents(root), AGENTS_ORIGINAL);
  assert.equal(readTransactions(root).length, 0);

  // Same id, different scope: integrity check rejects the record.
  writeFileSync(join(takeoverDir(root), 'authorization.json'), `${JSON.stringify({ ...auth, scope: ['tasks', 'memory', 'acceptance'] }, null, 2)}\n`);
  assert.throws(() => loadAuthorization(root), (error: unknown) => expectError(error, 'CONNECT_TAMPER', /authorizationId does not match/));

  // Duplicate scope entries are rejected by the strict schema.
  writeFileSync(
    join(takeoverDir(root), 'authorization.json'),
    `${JSON.stringify({ ...auth, scope: ['tasks', 'tasks', 'memory', 'acceptance', 'dag'] }, null, 2)}\n`,
  );
  assert.throws(() => loadAuthorization(root), (error: unknown) => expectError(error, 'CONNECT_TAMPER', /scope entries must be unique/));

  // saveAuthorization refuses to persist a record whose id does not match.
  assert.throws(
    () => saveAuthorization(resolveRoot(root), { ...auth, scope: ['tasks'] }),
    (error: unknown) => expectError(error, 'TAKEOVER_POLICY', /authorizationId does not match/),
  );
  saveAuthorization(resolveRoot(root), auth);

  // Identity is deterministic and scope-sensitive.
  const identity = {
    root: resolveRoot(root),
    projectId: 'proj-1',
    projectKey: 'key-1',
    grantedBy: 'Alice',
    role: 'owner',
    statement: 'I explicitly authorize ANO takeover of this project.',
    grantedAt: NOW,
  };
  const idOrdered = computeAuthorizationId({ ...identity, scope: [...FULL_SCOPES] });
  const idShuffled = computeAuthorizationId({ ...identity, scope: ['dag', 'acceptance', 'memory', 'tasks'] });
  const idNarrow = computeAuthorizationId({ ...identity, scope: ['tasks', 'memory', 'acceptance'] });
  assert.equal(idOrdered, idShuffled);
  assert.notEqual(idOrdered, idNarrow);
  assert.equal(idOrdered, auth.authorizationId);

  // An id issued for another root cannot be replayed here.
  const other = await makeRoot(t, 'ano-rb-other-');
  await pmFixture(other);
  const authOther = await grant(other);
  await assert.rejects(run(root, authOther.authorizationId), (error: unknown) => expectError(error, 'TAKEOVER', /does not match/));
});

// ---- 4a. tampered policy ------------------------------------------------

test('T-075/04a tampered policy documents fail closed', async (t) => {
  const root = await makeRoot(t, 'ano-rb-policy-');
  await pmFixture(root);
  writeAgents(root, AGENTS_ORIGINAL);
  const auth = await grant(root);
  savePolicy(resolveRoot(root), createPolicy({
    root: resolveRoot(root),
    projectId: auth.projectId,
    projectKey: auth.projectKey,
    authorization: auth,
    state: 'disabled',
    stateChangedAt: NOW,
    updatedAt: NOW,
  }));
  const policyFile = join(takeoverDir(root), 'policy.json');
  const valid = readFileSync(policyFile, 'utf8');
  const patch = (changes: Record<string, unknown>): void => {
    const current = JSON.parse(valid) as Record<string, unknown>;
    writeFileSync(policyFile, `${JSON.stringify({ ...current, ...changes }, null, 2)}\n`);
  };

  patch({ state: 'paused' });
  assert.throws(() => loadPolicy(root), (error: unknown) => expectError(error, 'CONNECT_TAMPER', /state/));

  patch({ state: 'enforced', enforcedAt: null, baselineDigest: null });
  assert.throws(() => loadPolicy(root), (error: unknown) => expectError(error, 'CONNECT_TAMPER', /enforced requires enforcedAt/));

  patch({ state: 'enforced', enforcedAt: NOW, baselineDigest: '0'.repeat(64), schemaVersion: 2 });
  assert.throws(() => loadPolicy(root), (error: unknown) => expectError(error, 'CONNECT_TAMPER', /schemaVersion/));

  // A policy document whose root names another project fails structural binding.
  patch({
    root: join(resolveRoot(root), '..', 'other-project'),
    authorization: createAuthorization({
      root: join(resolveRoot(root), '..', 'other-project'),
      projectId: 'proj-1',
      projectKey: 'key-1',
      scope: [...FULL_SCOPES],
      grantedBy: 'Alice',
      role: 'owner',
      statement: 'I explicitly authorize ANO takeover of this project.',
      grantedAt: NOW,
    }),
  });
  assert.throws(() => loadPolicy(root), (error: unknown) => expectError(error, 'CONNECT_SOURCE', /takeover policy is bound to/));

  patch({ authorization: { ...auth, scope: ['tasks'] } });
  assert.throws(() => loadPolicy(root), (error: unknown) => expectError(error, 'CONNECT_TAMPER', /authorizationId does not match/));

  writeFileSync(policyFile, '{ not json');
  assert.throws(() => loadPolicy(root), (error: unknown) => expectError(error, 'CONNECT_TAMPER', /not valid JSON/));
  assert.equal(takeoverStatusSurface(root).state, 'unknown');

  // A schema-valid forged `enforced` state is refused at load time by the
  // state integrity hash (F-03): schema validity alone is not integrity.
  patch({ state: 'enforced', enforcedAt: NOW, baselineDigest: '0'.repeat(64) });
  assert.throws(() => loadPolicy(root), (error: unknown) => expectError(error, 'CONNECT_TAMPER', /stateHash/));
  await assert.rejects(run(root, auth.authorizationId), (error: unknown) => expectError(error, 'CONNECT_TAMPER', /stateHash/));

  // Even when the attacker recomputes the state hash, the state machine still
  // refuses to treat the forged document as a completed six-phase switch.
  const forged = JSON.parse(valid) as Record<string, unknown>;
  forged['state'] = 'enforced';
  forged['enforcedAt'] = NOW;
  forged['baselineDigest'] = '0'.repeat(64);
  forged['stateHash'] = computePolicyStateHash({
    state: 'enforced',
    stateChangedAt: forged['stateChangedAt'] as string,
    enforcedAt: NOW,
    recoveredAt: null,
    baselineDigest: '0'.repeat(64),
    hostCapability: null,
  });
  writeFileSync(policyFile, `${JSON.stringify(forged, null, 2)}\n`);
  assert.equal(loadPolicy(root)?.state, 'enforced', 'a correctly hashed forged state is still schema/load valid');
  await assert.rejects(run(root, auth.authorizationId), (error: unknown) => expectError(error, 'TAKEOVER', /already enforced/));

  writeFileSync(policyFile, valid);
  assert.equal(loadPolicy(root)?.state, 'disabled');
});

// ---- 4b. tampered transaction journal -----------------------------------

test('T-075/04b tampered transaction journals fail closed', async (t) => {
  const root = await makeRoot(t, 'ano-rb-journal-');
  await pmFixture(root);
  writeAgents(root, AGENTS_ORIGINAL);
  const auth = await grant(root);
  const prepared = await run(root, auth.authorizationId, { stopAfterPhase: 'prepared' });
  const txFile = join(takeoverDir(root), 'transactions.json');
  const valid = readFileSync(txFile, 'utf8');

  writeFileSync(txFile, '{ not json');
  assert.throws(() => readTransactions(root), (error: unknown) => expectError(error, 'CONNECT_TAMPER', /not valid JSON/));

  writeFileSync(txFile, `${JSON.stringify({ ...JSON.parse(valid), schemaVersion: 2 }, null, 2)}\n`);
  assert.throws(() => readTransactions(root), (error: unknown) => expectError(error, 'CONNECT_TAMPER', /schemaVersion/));

  const rootSwapped = JSON.parse(valid) as { entries: Array<Record<string, unknown>> };
  rootSwapped.entries[0]!.root = join(resolveRoot(root), '..', 'other-project');
  writeFileSync(txFile, JSON.stringify(rootSwapped, null, 2));
  assert.throws(() => readTransactions(root), (error: unknown) => expectError(error, 'CONNECT_SOURCE', /takeover transaction entry is bound to/));

  const badTxId = JSON.parse(valid) as { entries: Array<Record<string, unknown>> };
  badTxId.entries[0]!.txId = 'not-a-sha';
  writeFileSync(txFile, JSON.stringify(badTxId, null, 2));
  assert.throws(() => readTransactions(root), (error: unknown) => expectError(error, 'CONNECT_TAMPER', /txId|schema/));

  writeFileSync(txFile, valid);
  assert.equal(readTransactions(root).length, 1);

  // F-04 regression: rewriting a historical entry without recomputing its
  // entryHash (and the successor link) is refused as tamper, not silently read.
  const rewritten = JSON.parse(valid) as { entries: Array<Record<string, unknown>> };
  rewritten.entries[0]!['error'] = 'rewritten history';
  writeFileSync(txFile, JSON.stringify(rewritten, null, 2));
  assert.throws(() => readTransactions(root), (error: unknown) => expectError(error, 'CONNECT_TAMPER', /entry hash|chain/u));
  writeFileSync(txFile, valid);
  assert.equal(readTransactions(root).length, 1, 'restored journal must verify again');

  const key = { authorizationId: auth.authorizationId, sourceDigest: prepared.sourceDigest, backupHash: prepared.backupHash };
  assert.throws(
    () => appendTransaction(root, { ...key, backupId: prepared.backupId, phase: 'migrated', txId: 'a'.repeat(64) }),
    (error: unknown) => expectError(error, 'CONNECT_STORE', /txId mismatch/),
  );
  assert.throws(
    () => appendTransaction(root, { ...key, backupId: prepared.backupId, phase: 'active' }),
    (error: unknown) => expectError(error, 'TAKEOVER_POLICY', /illegal takeover phase advance/),
  );
  assert.throws(
    () => appendTransaction(root, { ...key, backupId: 'different-backup', phase: 'prepared' }),
    (error: unknown) => expectError(error, 'CONNECT_STORE', /idempotency conflict/),
  );
  assert.equal(readTransactions(root).length, 1, 'refused appends must not modify the journal');
  assert.equal(computeTransactionId(key), prepared.txId);
});

// ---- 5. tampered backup --------------------------------------------------

test('T-075/05 tampered backup bytes are refused by the verified phase and by recover', async (t) => {
  // (a) The verified phase replays backup verification and aborts.
  const root = await makeRoot(t, 'ano-rb-backup-verify-');
  await pmFixture(root);
  writeAgents(root, AGENTS_ORIGINAL);
  const auth = await grant(root);
  const reconciled = await run(root, auth.authorizationId, { stopAfterPhase: 'reconciled' });
  const backupFile = join(root, '.ano', 'backup', reconciled.backupId, '.pm', 'tasks.json');
  const original = readFileSync(backupFile);
  writeFileSync(backupFile, `${original.toString('utf8')}TAMPERED\n`);
  const verification = await verifyBackup(root, reconciled.backupId);
  assert.equal(verification.ok, false);
  assert.match(verification.errors.join('; '), /hash mismatch/);

  const pmBefore = await pmSnapshot(root);
  const resumed = await run(root, auth.authorizationId);
  assert.equal(resumed.aborted, true);
  assert.equal(resumed.failedPhase, 'verified');
  assert.equal(resumed.active, false);
  assert.equal(resumed.state, 'disabled');
  assert.match(resumed.error ?? '', /verification evidence is incomplete or failed/);
  assert.deepEqual(readTransactions(root).map((entry) => entry.phase), ['prepared', 'migrated', 'reconciled', 'aborted']);
  assert.equal(readAgents(root).includes(MANAGED_INSTRUCTIONS_BEGIN), false);
  assert.equal(await pmSnapshot(root), pmBefore);

  // (b) recover refuses to restore a tampered backup and deletes nothing.
  const root2 = await makeRoot(t, 'ano-rb-backup-recover-');
  await pmFixture(root2);
  writeAgents(root2, AGENTS_ORIGINAL);
  const auth2 = await grant(root2);
  const active = await run(root2, auth2.authorizationId);
  applyStateTransition(resolveRoot(root2), { from: 'enforced', to: 'recovery' });
  const backupFile2 = join(root2, '.ano', 'backup', active.backupId, '.pm', 'project.json');
  writeFileSync(backupFile2, `${readFileSync(backupFile2, 'utf8')}TAMPERED\n`);
  const pmBefore2 = await pmSnapshot(root2);
  await assert.rejects(takeoverRecover(root2), /failed verification/);
  assert.equal(loadPolicy(root2)?.state, 'recovery');
  assert.equal(await pmSnapshot(root2), pmBefore2, 'a refused recover must not restore or delete anything');
  await assert.rejects(restoreProject(root2, active.backupId), /Refusing to restore/);
});

// ---- 6. malicious managed-section content -------------------------------

test('T-075/06 malicious managed-section content is refused before any byte is written', async (t) => {
  const root = await makeRoot(t, 'ano-rb-content-');
  await pmFixture(root);
  writeAgents(root, AGENTS_ORIGINAL);
  const auth = await grant(root);
  const before = readAgents(root);

  assert.throws(
    () => installManagedInstructions(root, `${MANAGED_INSTRUCTIONS_BEGIN}\nforged`, { confirm: auth }),
    (error: unknown) => expectError(error, 'CONNECT_SOURCE', /must not contain managed markers/),
  );
  assert.throws(
    () => installManagedInstructions(root, 'x'.repeat(MAX_MANAGED_INSTRUCTIONS_BYTES + 1), { confirm: auth }),
    (error: unknown) => expectError(error, 'CONNECT_LIMIT', /limit is/),
  );
  assert.throws(
    () => installManagedInstructions(root, 'body\0', { confirm: auth }),
    (error: unknown) => expectError(error, 'CONNECT_SOURCE', /NUL/),
  );
  assert.throws(
    () => installManagedInstructions(root, '   \n', { confirm: auth }),
    (error: unknown) => expectError(error, 'CONNECT_SOURCE', /must not be empty/),
  );
  assert.throws(
    () => installManagedInstructions(root, 42 as unknown as string, { confirm: auth }),
    (error: unknown) => expectError(error, 'CONNECT_SOURCE', /must be a string/),
  );
  // F-01 regression: executable HTML/JavaScript must never enter the managed span.
  for (const active of [
    '<script>alert(1)</script>',
    '<SCRIPT src="https://evil.example/x.js"></SCRIPT>',
    '<img src=x onerror=alert(1)>',
    '<a href="javascript:alert(1)">click</a>',
    '<iframe src="https://evil.example"></iframe>',
  ]) {
    assert.throws(
      () => installManagedInstructions(root, active, { confirm: auth }),
      (error: unknown) => expectError(error, 'CONNECT_SOURCE', /active HTML or JavaScript/u),
      active,
    );
  }
  // The opt-in for revoked removal is scoped to removal; it cannot inject content.
  assert.throws(
    () => installManagedInstructions(root, 'body', { confirm: { ...auth, revokedAt: NOW }, allowRevokedRemoval: true }),
    (error: unknown) => expectError(error, 'CONNECT_SOURCE', /revoked/),
  );
  assert.throws(
    () => installManagedInstructions(root, 'body', { confirm: { ...auth, revokedAt: NOW } }),
    (error: unknown) => expectError(error, 'CONNECT_SOURCE', /revoked/),
  );
  assert.throws(
    () => installManagedInstructions(root, 'body', { confirm: { ...auth, scope: ['tasks'] } }),
    (error: unknown) => expectError(error, 'CONNECT_SOURCE', /does not include the required scope/),
  );
  assert.equal(readAgents(root), before, 'refused managed writes must leave AGENTS.md byte-identical');

  // The takeover path installs only the fixed rendered body; it accepts no
  // caller-supplied section content.
  const result = await run(root, auth.authorizationId);
  const agents = readAgents(root);
  const begin = agents.indexOf(MANAGED_INSTRUCTIONS_BEGIN);
  const end = agents.indexOf(MANAGED_INSTRUCTIONS_END);
  assert.equal(begin >= 0 && end > begin, true);
  const section = agents.slice(begin + MANAGED_INSTRUCTIONS_BEGIN.length, end).trim();
  assert.equal(section, renderDefaultManagedInstructions('enforced').trim());
  assert.equal(section.toLowerCase().includes('<script'), false);
  assert.equal(result.active, true);
});

// ---- 7. concurrent legacy writes / drift --------------------------------

test('T-075/07 external legacy writes under enforced state produce drift and zero double writes', async (t) => {
  const root = await makeRoot(t, 'ano-rb-drift-');
  await pmFixture(root);
  writeAgents(root, AGENTS_ORIGINAL);
  const auth = await grant(root);
  await run(root, auth.authorizationId);

  assert.equal(legacyWriteDecision('enforced').allowed, false);
  assert.throws(
    () => assertLegacyWriteAllowed('enforced', 'tasks'),
    (error: unknown) => expectError(error, 'CONNECT_LEGACY_WRITE_BLOCKED', /legacy PM-mcp write refused/),
  );

  const journalBefore = readTransactions(root).length;
  const ledgerBefore = ledgerEvents(root).length;

  const tasksPath = join(root, '.pm', 'tasks.json');
  const tasks = JSON.parse(readFileSync(tasksPath, 'utf8')) as { seq: number; tasks: Array<Record<string, unknown>> };
  tasks.seq = 2;
  tasks.tasks.push({ id: 'T-EXTERNAL', title: 'external write', status: 'todo' });
  writeFileSync(tasksPath, `${JSON.stringify(tasks, null, 2)}\n`);
  writeFileSync(join(root, '.pm', 'external-note.json'), '{"note":"external"}\n');
  const pmAfterExternal = await pmSnapshot(root);

  const report = detectLegacyDrift(root);
  assert.equal(report?.drifted, true);
  assert.equal(report?.reconcileStale, true);
  assert.equal(report?.recommendation, 'recovery');
  assert.equal(report?.baselineDigest !== report?.currentDigest, true);
  const paths = report?.files.map((file) => file.path) ?? [];
  assert.equal(paths.includes('tasks.json'), true);
  assert.equal(paths.includes('external-note.json'), true);
  assert.equal(loadPolicy(root)?.state, 'enforced');
  assert.equal(await pmSnapshot(root), pmAfterExternal, 'drift detection is read-only');
  assert.equal(ledgerEvents(root).length, ledgerBefore, 'drift detection never writes the ledger');

  const watch = await watchDrift({ root, intervalMs: 50, maxCycles: 1, writeReport: true });
  assert.equal(watch.stopped, 'drift');
  assert.equal(watch.report?.drifted, true);
  const driftFiles = (await readdir(join(takeoverDir(root), 'drift'))).filter((name) => name.endsWith('.json'));
  assert.equal(driftFiles.length, 1);
  assert.equal(await pmSnapshot(root), pmAfterExternal, 'drift reporting never writes back');

  await assert.rejects(run(root, auth.authorizationId), (error: unknown) => expectError(error, 'TAKEOVER_SOURCE_DRIFT', /source changed/));
  assert.equal(readTransactions(root).length, journalBefore, 'a drifted apply must not append a phase');
  assert.equal(ledgerEvents(root).length, ledgerBefore, 'a drifted apply must not write the ledger');
  assert.equal(await pmSnapshot(root), pmAfterExternal, 'a drifted apply must not write the legacy source');
});

// ---- 8. Gate / permission overreach -------------------------------------

test('T-075/08 takeover state and results never carry Gate evidence_id/verdict/task_id or trigger done/approve/cutover', async (t) => {
  const root = await makeRoot(t, 'ano-rb-gate-');
  await pmFixture(root);
  writeAgents(root, AGENTS_ORIGINAL);
  const auth = await grant(root);
  const result = await run(root, auth.authorizationId);
  const status = takeoverStatus(root);
  const surface = takeoverStatusSurface(root);

  const forbidden = ['evidence_id', 'verdict', 'task_id', 'approve', 'cutover'] as const;
  for (const key of forbidden) {
    assert.equal(key in result, false, `run result must not carry ${key}`);
    assert.equal(key in status, false, `status must not carry ${key}`);
    assert.equal(key in surface, false, `surface status must not carry ${key}`);
  }
  assert.equal(/evidence_id|"verdict"|"task_id"|approve|cutover/iu.test(JSON.stringify(result)), false);
  assert.equal(/evidence_id|"verdict"|"task_id"|approve|cutover/iu.test(JSON.stringify(status)), false);

  const events = ledgerEvents(root);
  const gateKinds = [
    'evidence.recorded',
    'verify.started',
    'verify.finished',
    'readiness.evidence',
    'readiness.attestation',
    'release.verdict',
    'release.approved',
  ];
  assert.deepEqual(events.filter((event) => gateKinds.includes(event.kind)), []);
  assert.deepEqual(events.filter((event) => event.kind === 'task.updated' && event.payload.status === 'done'), []);
  assert.equal(events.some((event) => event.kind === 'task.created'), true, 'migration still records tasks');

  assert.equal(existsSync(join(root, '.ano', 'connect', 'cutover.json')), false);
  const matrix = roleMatrixForState('enforced', 'degraded');
  assert.equal(matrix.layers.find((layer) => layer.layer === 'release')?.ano, 'manual');
  assert.equal(matrix.layers.find((layer) => layer.layer === 'release')?.legacyPm, 'manual');
  assert.equal(matrix.layers.find((layer) => layer.layer === 'tasks')?.legacyPm, 'read-only');
});

// ---- 9. enforcement still needs explicit live authorization -------------

test('T-075/09 enforcement never substitutes for explicit live authorization', async (t) => {
  const root = await makeRoot(t, 'ano-rb-auth-');
  await pmFixture(root);
  writeAgents(root, AGENTS_ORIGINAL);

  await assert.rejects(run(root, 'a'.repeat(64)), (error: unknown) => expectError(error, 'TAKEOVER', /no takeover authorization/));
  assert.equal(existsSync(join(root, '.ano', 'takeover')), false);

  const auth = await grant(root);
  await assert.rejects(
    runTakeover(root, { confirm: false, authorizationId: auth.authorizationId, now: NOW }),
    (error: unknown) => expectError(error, 'TAKEOVER', /explicit confirm/),
  );
  await assert.rejects(run(root, 'b'.repeat(64)), (error: unknown) => expectError(error, 'TAKEOVER', /does not match/));

  // Scope insufficient: enforced cannot be reached.
  const narrowRoot = await makeRoot(t, 'ano-rb-narrow-');
  await pmFixture(narrowRoot);
  writeAgents(narrowRoot, AGENTS_ORIGINAL);
  const narrow = await grant(narrowRoot, { scope: ['tasks'] });
  await assert.rejects(run(narrowRoot, narrow.authorizationId), (error: unknown) => expectError(error, 'TAKEOVER', /scope does not include memory/));
  assert.equal(readAgents(narrowRoot), AGENTS_ORIGINAL);
  assert.equal(readTransactions(narrowRoot).length, 0);

  const enforced = await run(root, auth.authorizationId);
  assert.equal(enforced.active, true);
  assert.equal(enforced.state, 'enforced');

  // `enforced` is not a pass: a different id is still refused, legacy writes
  // are blocked, and recover still requires the recovery state.
  await assert.rejects(run(root, 'c'.repeat(64)), (error: unknown) => expectError(error, 'TAKEOVER', /does not match/));
  assert.throws(() => assertLegacyWriteAllowed('enforced', 'all'), /legacy PM-mcp write refused/);
  await assert.rejects(takeoverRecover(root), /recover requires recovery/);

  // Revocation is permanent: apply is refused even though the takeover ran.
  await takeoverRevoke(root);
  assert.equal(loadPolicy(root)?.state, 'recovery');
  await assert.rejects(run(root, auth.authorizationId), (error: unknown) => expectError(error, 'TAKEOVER', /revoked/));
  assert.equal(readAgents(root).includes(MANAGED_INSTRUCTIONS_BEGIN), true, 'revocation does not silently remove the managed section');
});

// ---- 10. sensitive files are not auto-collected -------------------------

test('T-075/10 takeover artifacts do not auto-collect sensitive files', async (t) => {
  const root = await makeRoot(t, 'ano-rb-secrets-');
  await pmFixture(root);
  writeAgents(root, AGENTS_ORIGINAL);
  await writeFile(join(root, '.env'), 'ROOT_ENV_SECRET=ROOT_ENV_SECRET\n');
  await mkdir(join(root, 'secrets'), { recursive: true });
  await writeFile(join(root, 'secrets', 'id_rsa'), 'RSA_PRIVATE_MARKER=RSA_PRIVATE_MARKER\n');
  await writeFile(join(root, 'credentials.json'), 'CREDENTIALS_MARKER=CREDENTIALS_MARKER\n');
  // F-02: sensitive files that live *inside* the backed-up trees are filtered
  // too, and the manifest records them explicitly as skipped-sensitive.
  await writeFile(join(root, '.pm', '.env'), 'PM_ENV_SECRET=PM_ENV_SECRET\n');
  await mkdir(join(root, '.pm', 'secrets'), { recursive: true });
  await writeFile(join(root, '.pm', 'secrets', 'id_ed25519'), 'ED25519_MARKER=ED25519_MARKER\n');
  await writeFile(join(root, '.pm', 'credentials.json'), 'PM_CREDENTIALS_MARKER=PM_CREDENTIALS_MARKER\n');
  await mkdir(join(root, '.ano', 'ledger'), { recursive: true });
  await writeFile(join(root, '.ano', 'ledger', 'keep.json'), '{"keep":true}\n');

  const auth = await grant(root);
  const result = await run(root, auth.authorizationId, { stopAfterPhase: 'prepared' });

  const prepared = readJson<{
    pm: Array<{ path: string }>;
    ledger: Array<{ path: string }>;
    skippedSensitive: Array<{ path: string; reason: string }>;
  }>(join(takeoverDir(root), 'prepared.json'));
  const manifest = readJson<{
    pm: Array<{ path: string }>;
    ledger: Array<{ path: string }>;
    skippedSensitive: Array<{ path: string; reason: string }>;
  }>(join(root, '.ano', 'backup', result.backupId, 'manifest.json'));
  const collected = [...prepared.pm, ...prepared.ledger, ...manifest.pm, ...manifest.ledger].map((entry) => entry.path);
  assert.equal(collected.some((path) => isSensitivePath(path)), false, `sensitive path collected: ${collected.join(', ')}`);
  assert.equal(collected.includes('.env'), false);
  assert.equal(collected.includes('credentials.json'), false);
  assert.equal(collected.includes('secrets/id_rsa'), false);
  assert.equal(collected.includes('.pm/.env'), false);
  assert.equal(collected.includes('.pm/credentials.json'), false);
  assert.deepEqual(
    manifest.skippedSensitive.map((entry) => entry.path).sort(),
    ['.env', 'credentials.json', 'secrets/id_ed25519'],
    'filtered files must be recorded as skipped-sensitive, never silently absent',
  );
  assert.ok(manifest.skippedSensitive.every((entry) => entry.reason.length > 0));
  assert.deepEqual(prepared.skippedSensitive, manifest.skippedSensitive);
  for (const secret of ['.pm/.env', '.pm/credentials.json', '.pm/secrets/id_ed25519']) {
    assert.equal(existsSync(join(root, '.ano', 'backup', result.backupId, secret)), false);
  }
  assert.equal(existsSync(join(root, '.ano', 'backup', result.backupId, '.env')), false);

  const artifacts = await collectFiles(takeoverDir(root));
  const text = (await Promise.all(artifacts.map((file) => readFile(file, 'utf8')))).join('\n');
  for (const marker of ['ROOT_ENV_SECRET', 'RSA_PRIVATE_MARKER', 'CREDENTIALS_MARKER', 'PM_ENV_SECRET', 'ED25519_MARKER', 'PM_CREDENTIALS_MARKER']) {
    assert.equal(text.includes(marker), false, `takeover artifact leaked ${marker}`);
  }
});
