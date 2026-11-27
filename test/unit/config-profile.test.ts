import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readConfig, writeDefaultConfig } from '../../src/core/config.ts';
import { filterDoctorReportForProfile, runCli } from '../../src/surface/cli.ts';
import type { DoctorReport } from '../../src/clients/doctor.ts';

test('existing projects without config stay full; setup defaults are personal and non-overwriting', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ano-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(readConfig(root).profile, 'full');
  assert.equal(readConfig(root).exists, false);
  const first = await writeDefaultConfig(root);
  assert.equal(first.written, true);
  assert.equal(readConfig(root).profile, 'personal');
  assert.equal(readConfig(root).hooks.mode, 'advisory');
  await writeFile(first.path, 'profile = "full"\n[hooks]\nmode = "strict"\n');
  assert.equal((await writeDefaultConfig(root)).written, false);
  assert.equal(readConfig(root).profile, 'full');
  assert.equal(readConfig(root).hooks.mode, 'strict');
});

test('only four supported keys are parsed; unknown and malformed entries warn without failing', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ano-config-warnings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.ano'));
  await writeFile(join(root, '.ano', 'config.toml'), [
    'profile = "personal"', 'unknown = 1', '[hooks]', 'mode = "advisory"',
    'exempt = ["*.md", "docs/**"]', 'prompt_hint = "先恢复上下文"', 'extra = true', '[other]', 'x = 1',
  ].join('\n'));
  const config = readConfig(root);
  assert.equal(config.profile, 'personal');
  assert.deepEqual(config.hooks.exempt, ['*.md', 'docs/**']);
  assert.equal(config.hooks.prompt_hint, '先恢复上下文');
  assert.equal(config.warnings.length, 3);
});

test('personal help lists core commands and help --all preserves the complete catalog', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ano-help-profile-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeDefaultConfig(root);
  const personal = await runCli(['--help', '--root', root]);
  assert.equal(personal.code, 0);
  assert.match(personal.output, /personal mode/u);
  assert.match(personal.output, /ano brief/u);
  assert.doesNotMatch(personal.output, /ano migrate \[/u);
  assert.doesNotMatch(personal.output, /ano clients plan/u);
  const full = await runCli(['help', '--all', '--root', root]);
  assert.match(full.output, /ano migrate \[/u);
  assert.match(full.output, /ano clients plan/u);
});

test('personal doctor keeps detected clients and --all restores unavailable entries', () => {
  const client = (clientId: string, verdict: 'validated' | 'degraded' | 'unavailable') => ({ clientId, layers: { detected: { verdict } } });
  const report = { clients: [client('zcode', 'validated'), client('other', 'degraded'), client('absent', 'unavailable')] } as unknown as DoctorReport;
  assert.deepEqual(filterDoctorReportForProfile(report, 'personal').clients.map((entry) => entry.clientId), ['zcode', 'other']);
  assert.equal(filterDoctorReportForProfile(report, 'personal', true).clients.length, 3);
  assert.equal(filterDoctorReportForProfile(report, 'full').clients.length, 3);
});
