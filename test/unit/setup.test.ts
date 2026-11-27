import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runSetup } from '../../src/core/setup.ts';
import { takeoverDisable, takeoverRecover, takeoverRevoke } from '../../src/surface/service.ts';

function fixture(t: test.TestContext, pm = false) {
  const root = mkdtempSync(join(tmpdir(), 'ano-setup-project-'));
  const home = mkdtempSync(join(tmpdir(), 'ano-setup-home-'));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'setup-fixture', private: true }));
  writeFileSync(join(root, 'src', 'index.ts'), 'export const ok = true;\n');
  if (pm) mkdirSync(join(root, '.pm'));
  for (const args of [['init', '-q'], ['config', 'user.email', 'ano@localhost'], ['config', 'user.name', 'ano'], ['add', '.'], ['commit', '-qm', 'base']]) {
    assert.equal(spawnSync('git', ['-C', root, ...args], { stdio: 'ignore' }).status, 0);
  }
  return { root, home };
}

test('non-TTY setup prints the full plan and writes nothing even with a dry-run request', async (t) => {
  const { root, home } = fixture(t, true);
  const result = await runSetup({ root, home, client: 'zcode', interactive: false });
  assert.equal(result.mode, 'plan');
  assert.deepEqual(result.steps.map((step) => step.id), ['takeover-grant', 'takeover-apply', 'hooks-install', 'personal-config', 'doctor']);
  assert.equal(existsSync(join(root, '.ano')), false);
  assert.equal(existsSync(join(home, '.zcode')), false);
});

test('TTY setup confirms every write independently and installs only isolated hooks/config', async (t) => {
  const { root, home } = fixture(t);
  const confirmations: string[] = [];
  const result = await runSetup({
    root, home, client: 'zcode', interactive: true, grantedBy: 'Administrator',
    confirm: async (step) => { confirmations.push(step); return true; },
  });
  assert.equal(result.mode, 'applied', JSON.stringify(result.steps));
  assert.deepEqual(confirmations, ['hooks-install', 'personal-config']);
  const config = JSON.parse(readFileSync(join(home, '.zcode', 'cli', 'config.json'), 'utf8')) as { hooks: unknown };
  assert.ok(config.hooks);
  assert.match(readFileSync(join(root, '.ano', 'config.toml'), 'utf8'), /profile = "personal"/u);
  assert.equal(result.firstPrompt.includes('ANO brief'), true);
});

test('existing .pm requires two distinct takeover confirmations before hooks and config', async (t) => {
  const { root, home } = fixture(t, true);
  const confirmations: string[] = [];
  const result = await runSetup({ root, home, client: 'zcode', interactive: true, grantedBy: 'Administrator', confirm: async (step) => { confirmations.push(step); return true; } });
  assert.equal(result.mode, 'applied', JSON.stringify(result.steps));
  assert.deepEqual(confirmations, ['takeover-grant', 'takeover-apply', 'hooks-install', 'personal-config']);
  assert.deepEqual(result.rollback.filter((command) => command.includes('takeover ')).map((command) => command.split(' ')[2]), ['disable', 'recover', 'revoke']);
  assert.equal((await takeoverDisable(root))['state'], 'recovery');
  assert.equal((await takeoverRecover(root))['state'], 'disabled');
  const revoked = await takeoverRevoke(root);
  assert.equal(revoked['state'], 'disabled');
  assert.equal(typeof (revoked['authorization'] as { revokedAt: unknown }).revokedAt, 'string');
});

test('setup refuses failed doctor checks before requesting or applying a write', async (t) => {
  const { root, home } = fixture(t);
  const packageRoot = join(home, 'unsupported-package');
  mkdirSync(packageRoot);
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ engines: { node: '>=99.0.0' } }));
  const confirmations: string[] = [];
  const result = await runSetup({
    root, home, client: 'zcode', interactive: true, grantedBy: 'fixture-owner',
    installation: { packageRoot, env: {} },
    confirm: async (step) => { confirmations.push(step); return true; },
  });
  assert.equal(result.mode, 'stopped', JSON.stringify(result.steps));
  assert.equal(result.steps.some((step) => step.status === 'failed'), true);
  assert.deepEqual(confirmations, []);
  assert.equal(existsSync(join(root, '.ano')), false);
  assert.equal(existsSync(join(home, '.zcode')), false);
});

test('repeated setup preserves enforced takeover authorization and the original transaction', async (t) => {
  const { root, home } = fixture(t, true);
  const options = { root, home, client: 'zcode' as const, interactive: true, grantedBy: 'fixture-owner' };
  const first = await runSetup({ ...options, confirm: async () => true });
  assert.equal(first.mode, 'applied');
  const authPath = join(root, '.ano', 'takeover', 'authorization.json');
  const original = readFileSync(authPath, 'utf8');
  const confirmations: string[] = [];
  const second = await runSetup({ ...options, confirm: async (step) => { confirmations.push(step); return true; } });
  assert.equal(second.mode, 'applied', JSON.stringify(second.steps));
  assert.equal(readFileSync(authPath, 'utf8'), original);
  assert.equal(confirmations.some((step) => step.startsWith('takeover-')), false);
  assert.equal(second.steps.filter((step) => step.id.startsWith('takeover-')).every((step) => step.status === 'skipped'), true);
  assert.equal(second.steps.find((step) => step.id === 'personal-config')?.status, 'skipped');
});

test('setup reports configuration write failure without hiding the applied hook rollback', async (t) => {
  const { root, home } = fixture(t);
  mkdirSync(join(home, '.zcode', 'cli'), { recursive: true });
  writeFileSync(join(home, '.zcode', 'cli', 'config.json'), JSON.stringify({ existing: true }));
  const result = await runSetup({
    root, home, client: 'zcode', interactive: true, grantedBy: 'fixture-owner',
    confirm: async (step) => {
      if (step === 'personal-config') {
        writeFileSync(join(root, '.ano', 'config.toml'), '', { flag: 'wx' });
        rmSync(join(root, '.ano', 'config.toml'));
        mkdirSync(join(root, '.ano', 'config.toml'));
      }
      return true;
    },
  });
  assert.equal(result.mode, 'stopped', JSON.stringify(result.steps));
  assert.equal(result.steps.find((step) => step.id === 'hooks-install')?.status, 'applied');
  assert.equal(result.steps.find((step) => step.id === 'personal-config')?.status, 'failed');
  assert.ok(result.rollback.length > 0);
});

test('refusing the first write stops before config creation', async (t) => {
  const { root, home } = fixture(t);
  const result = await runSetup({ root, home, client: 'zcode', interactive: true, grantedBy: 'Administrator', confirm: async () => false });
  assert.equal(result.mode, 'stopped');
  assert.equal(existsSync(join(root, '.ano')), false);
  assert.equal(existsSync(join(home, '.zcode')), false);
});

test('declining takeover apply reports how to revoke the already granted authorization', async (t) => {
  const { root, home } = fixture(t, true);
  const result = await runSetup({
    root, home, client: 'zcode', interactive: true, grantedBy: 'fixture-owner',
    confirm: async (step) => step === 'takeover-grant',
  });
  assert.equal(result.mode, 'stopped');
  assert.equal(result.steps.find((step) => step.id === 'takeover-grant')?.status, 'applied');
  assert.equal(result.steps.find((step) => step.id === 'takeover-apply')?.status, 'skipped');
  assert.equal(result.rollback.some((command) => command.includes('takeover revoke')), true);
  assert.equal(existsSync(join(home, '.zcode')), false);
});

test('failed takeover preflight reports grant revocation and never installs hooks', async (t) => {
  const { root, home } = fixture(t, true);
  writeFileSync(join(root, '.pm', 'tasks.json'), '{"tasks":');
  const result = await runSetup({
    root, home, client: 'zcode', interactive: true, grantedBy: 'fixture-owner',
    confirm: async () => true,
  });
  assert.equal(result.mode, 'stopped', JSON.stringify(result.steps));
  assert.equal(result.steps.find((step) => step.id === 'takeover-apply')?.status, 'failed');
  assert.equal(result.rollback[0]?.includes('takeover revoke'), true);
  assert.equal(result.rollback.some((command) => command.includes('takeover recover')), false);
  assert.equal(existsSync(join(home, '.zcode')), false);
});
