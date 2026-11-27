import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import {
  createClientAuthorization,
  clientInstallSurface,
  clientRestoreSurface,
} from '../../src/surface/service.ts';
import { cleanup, temp } from '../helpers/m18-d-fixtures.ts';

const grant = {
  scope: ['nope'],
  grantedBy: 'Owner',
  statement: 'authorize the fixture project',
};

test('M18-D createClientAuthorization rejects unknown scopes and empty statements', () => {
  const root = 'F:/fixture-project';
  assert.throws(() => createClientAuthorization(root, 'claude-code', grant), /unknown value/);
  assert.throws(() => createClientAuthorization(root, 'claude-code', { ...grant, scope: ['config'], grantedBy: '' }), /grantedBy/);
  assert.throws(() => createClientAuthorization(root, 'claude-code', { ...grant, scope: ['config'], statement: '' }), /statement/);
  assert.throws(
    () => createClientAuthorization(root, 'claude-code', { ...grant, scope: ['config'], grantedAt: 'not-a-date' }),
    /grantedAt/,
  );
  const ok = createClientAuthorization(root, 'claude-code', { ...grant, scope: ['config'] });
  assert.equal(ok.clientId, 'claude-code');
  assert.equal(ok.authorizationId.length, 64);
});

test('M18-D client install/restore fail fast on unknown clients before touching storage', async () => {
  const install = await clientInstallSurface({
    id: 'no-such-client',
    root: 'F:/fixture-project',
    configScope: 'project',
    apply: false,
    grant: { scope: ['config'], grantedBy: 'Owner', statement: 'statement' },
  });
  assert.equal(install.ok, false);
  if (!install.ok) assert.equal(install.exitCode, 2);

  const restore = await clientRestoreSurface({
    id: 'no-such-client',
    root: 'F:/fixture-project',
    configScope: 'project',
    backupId: 'bk-1',
    apply: false,
    grant: { scope: ['config'], grantedBy: 'Owner', statement: 'statement' },
  });
  assert.equal(restore.ok, false);
  if (!restore.ok) assert.equal(restore.exitCode, 2);

  // A known client with an unreadable root is refused before any backup/restore work.
  const missingRoot = await clientRestoreSurface({
    id: 'claude-code',
    root: join('F:/', 'definitely-missing-ano-root'),
    configScope: 'project',
    backupId: 'bk-1',
    apply: false,
    grant: { scope: ['config'], grantedBy: 'Owner', statement: 'statement' },
  });
  assert.equal(missingRoot.ok, false);
  if (!missingRoot.ok) assert.match(missingRoot.message, /Project root|does not exist/);
});

test('M18-D install/restore refuse an invalid authorization after the target resolves', async () => {
  const root = await temp('ano m18d client auth ');
  const home = await temp('ano m18d client home ');
  try {
    const grant = { scope: ['nope'], grantedBy: 'Owner', statement: 'statement' };
    const install = await clientInstallSurface({
      id: 'claude-code',
      root,
      home,
      configScope: 'project',
      apply: false,
      grant,
    });
    assert.equal(install.ok, false);
    if (!install.ok) assert.match(install.message, /unknown value/);

    const restore = await clientRestoreSurface({
      id: 'claude-code',
      root,
      home,
      configScope: 'project',
      backupId: 'bk-1',
      apply: false,
      grant,
    });
    assert.equal(restore.ok, false);
    if (!restore.ok) assert.match(restore.message, /unknown value/);
  } finally {
    await cleanup(root);
    await cleanup(home);
  }
});
