import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  assertLegacyConnectWriteAllowed,
  brief,
  clientInstallSurface,
  cutoverStatusSurface,
  existingProjectRoot,
  migrateBackupSurface,
  migrateBackupsSurface,
  probeManifestToFrozenContext,
  releaseVerification,
  takeoverApply,
  takeoverGrant,
  trackTask,
  trackTaskUpdate,
} from '../../src/surface/service.ts';
import { cleanup, corruptConnectStore, git, gitProject, temp, write } from '../helpers/m18-d-fixtures.ts';

interface BackupVerification { readonly ok: boolean }
interface BackupEntry {
  readonly id: string;
  readonly pm: number;
  readonly ledger: number;
  readonly hash: string;
  readonly verification: BackupVerification;
}
interface BackupList { readonly backups: readonly BackupEntry[] }

/** Type narrowing for the surfaces' `Record<string, unknown>` outputs. */
function backupManifest(value: Record<string, unknown>): { id: string; verification: BackupVerification } {
  return value as { id: string; verification: BackupVerification };
}
function backupList(value: Record<string, unknown>): BackupList {
  return value as unknown as BackupList;
}

test('M18-D existingProjectRoot falls back to a Git root and discovers a nested package.json', async () => {
  const root = await gitProject();
  try {
    assert.equal(await existingProjectRoot(root), root);
    // A nested start below the Git root resolves upward to the same PM root.
    const nested = join(root, 'nested', 'deeper');
    await write(nested, 'package.json', JSON.stringify({ name: 'nested' }));
    assert.equal(await existingProjectRoot(nested), root);
  } finally {
    await cleanup(root);
  }

  // The Git root itself has no package.json: discovery must walk down into the
  // nested Node package instead of failing.
  const bare = await temp('ano m18d bare git ');
  try {
    git(bare, ['init', '-q', '-b', 'main']);
    git(bare, ['config', 'user.email', 'ano@localhost']);
    git(bare, ['config', 'user.name', 'ano']);
    await write(bare, 'server/package.json', JSON.stringify({ name: 'server', private: true }));
    await write(bare, 'server/src/alpha.ts', 'export const alpha = 1;\n');
    git(bare, ['add', '.']);
    git(bare, ['commit', '-qm', 'base']);
    assert.equal(existsSync(join(bare, 'package.json')), false);
    assert.equal(await existingProjectRoot(join(bare, 'server')), bare);
  } finally {
    await cleanup(bare);
  }
});

test('M18-D task update refuses unknown operations and non-status patches', async () => {
  const root = await gitProject();
  try {
    await trackTask(root, { id: 'T-UPD', files: ['src/alpha.ts'] }, 'm18d:upd:create');
    await assert.rejects(trackTaskUpdate(root, { operation: 'explode', id: 'T-UPD' }, 'm18d:upd:bad-op'), /not implemented/);
    await assert.rejects(trackTaskUpdate(root, { operation: 'update', id: 'T-UPD', status: 'bogus' }, 'm18d:upd:bad-status'), /Invalid task status/);
    await assert.rejects(trackTaskUpdate(root, { operation: 'update', id: 'T-UPD' }, 'm18d:upd:no-status'), /requires a non-done status/);
  } finally {
    await cleanup(root);
  }
});

test('M18-D takeover grant validates scopes and tolerates an unreadable PM identity/plan', async () => {
  const root = await gitProject();
  try {
    await assert.rejects(
      takeoverGrant(root, { scope: ['bogus'], grantedBy: 'Owner', role: 'owner', statement: 'accept' }),
      /unknown value/,
    );

    // A malformed .pm/project.json falls back to the canonical root identity,
    // and an invalid migration source leaves sourceDigestAtGrant null.
    await write(root, '.pm/project.json', '{ not json');
    await write(root, '.pm/tasks.json', JSON.stringify({ tasks: [{ title: 'no id' }] }));
    const granted = await takeoverGrant(root, {
      scope: ['tasks'],
      grantedBy: 'Owner',
      role: 'owner',
      statement: 'accept the fixture',
      grantedAt: '2026-11-25T00:00:00.000Z',
    });
    assert.equal(granted.schema, 'ano.takeover-grant/1');
    const authorization = granted.authorization as { projectId: string; projectKey: string; sourceDigestAtGrant: string | null };
    assert.equal(authorization.projectId.length, 12);
    assert.equal(authorization.projectKey, `root:${root}`);
    assert.equal(authorization.sourceDigestAtGrant, null);
  } finally {
    await cleanup(root);
  }
});

test('M18-D takeover apply rejects a malformed authorization id before running the transaction', async () => {
  const root = await gitProject();
  try {
    await assert.rejects(takeoverApply(root, { authorizationId: 'not-a-sha' }), /64-character sha256/);
  } finally {
    await cleanup(root);
  }
});

test('M18-D client install refuses a registered client with no declared MCP entry', async () => {
  const root = await gitProject();
  try {
    const result = await clientInstallSurface({
      id: 'zed',
      root,
      configScope: 'project',
      apply: false,
      grant: { scope: ['install'], grantedBy: 'Owner', statement: 'install zed' },
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.exitCode, 2);
      assert.match(result.message, /unsupported|no declared|entry/i);
    }
  } finally {
    await cleanup(root);
  }
});

test('M18-D backup listing verifies every manifest and reports hashes', async () => {
  const root = await gitProject();
  try {
    await write(root, '.pm/project.json', JSON.stringify({ name: 'backup-fixture' }));
    await write(root, '.pm/tasks.json', JSON.stringify({ tasks: [{ id: 'T-1', title: 'one', status: 'todo' }] }));

    const created = backupManifest(await migrateBackupSurface(root, { id: 'bk-list-1' }));
    assert.equal(created.id, 'bk-list-1');
    assert.equal(created.verification.ok, true);

    const listed = backupList(await migrateBackupsSurface(root));
    assert.equal(listed.backups.length, 1);
    const entry = listed.backups[0];
    assert.ok(entry);
    assert.equal(entry.id, 'bk-list-1');
    assert.equal(entry.pm, 2);
    assert.equal(entry.ledger, 0);
    assert.equal(typeof entry.hash, 'string');
    assert.equal(entry.hash.length, 64);
    assert.equal(entry.verification.ok, true);

    // A missing backup directory stays an empty listing, never an error.
    const other = await gitProject();
    try {
      assert.deepEqual(backupList(await migrateBackupsSurface(other)).backups, []);
    } finally {
      await cleanup(other);
    }
  } finally {
    await cleanup(root);
  }
});

test('M18-D cutover status is an explicit unconfirmed state before any cutover', async () => {
  const root = await gitProject();
  try {
    const status = await cutoverStatusSurface(root);
    assert.equal(status.confirmed, false);
    assert.equal('sourceDigest' in status, false);
  } finally {
    await cleanup(root);
  }
});

test('M18-D releaseVerification forwards input validation failures', async () => {
  const root = await gitProject();
  try {
    await assert.rejects(releaseVerification(root, {}), /target|invalid/i);
  } finally {
    await cleanup(root);
  }
});

test('M18-D probeManifestToFrozenContext rejects malformed manifests with the first schema issue', () => {
  assert.throws(() => probeManifestToFrozenContext({}), /not a valid frozen manifest/);
  assert.throws(
    () => probeManifestToFrozenContext({ schema_version: 'anchorprobe.manifest.v1', context_id: 'c1' }),
    /not a valid frozen manifest/,
  );
});

test('M18-D legacy Connect writes fail closed on an unreadable takeover policy', async () => {
  const root = await gitProject();
  try {
    await write(root, '.ano/takeover/policy.json', '{ not json');
    assert.throws(() => assertLegacyConnectWriteAllowed(root), /unreadable/);
  } finally {
    await cleanup(root);
  }
});

test('M18-D brief reports an unreadable Connect store instead of dropping it', async () => {
  const root = await gitProject();
  try {
    await write(root, '.pm/project.json', JSON.stringify({ name: 'connect-error-fixture' }));
    await corruptConnectStore(root);
    const summary = await brief(root);
    const connected = summary.connected as { connected: boolean; error?: string; errors?: string[]; limitations: string[] };
    assert.equal(connected.connected, false);
    assert.equal(typeof connected.error, 'string');
    assert.ok((connected.errors ?? []).length >= 1);
    assert.ok(connected.limitations.some((item) => item.includes('Connect storage is unreadable')));
    assert.equal(existsSync(join(root, '.ano/connect/current.json')), true);
  } finally {
    await cleanup(root);
  }
});
