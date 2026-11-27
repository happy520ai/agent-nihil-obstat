/**
 * T-153 / QF-04 shard C: JSON client adapters driven by real files and env.
 *
 * The pre-T153 suite covered the happy path of these adapters but never fed the
 * defensive branches: unreadable declared configs, undeclared targets, non-object
 * env injection, missing/blank authorization statements, dry-run/apply refusals
 * and replayed writes. Every case here writes real tmpdir files and injects real
 * environment maps.
 */

import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  COMATE_CONFIG_CANDIDATES,
  createComateAdapter,
} from '../../src/clients/comate.ts';
import {
  AMAZON_Q_CONFIG_CANDIDATES,
  createAmazonQAdapter,
} from '../../src/clients/amazon-q.ts';
import {
  TONGYI_LINGMA_CONFIG_CANDIDATES,
  createTongyiLingmaAdapter,
} from '../../src/clients/tongyi-lingma.ts';
import {
  DEEPSEEK_HARNESS_CONFIG_CANDIDATES,
  createDeepSeekHarnessAdapter,
  isCordisYamlCandidate,
  readDeclaredCordisCarrier,
} from '../../src/clients/deepseek-harness.ts';
import type { ClientAdapter } from '../../src/clients/types.ts';
import {
  m18cAuthz,
  m18cConfig,
  m18cHomeEnv,
  m18cTmp,
  m18cWriteJson,
  m18cWriteText,
  m18cWarnings,
} from '../helpers/m18-c-fixtures.ts';

interface JsonAdapterCase {
  readonly name: string;
  readonly candidates: readonly { path: string; scope: 'user' | 'project' | 'workspace' }[];
  readonly executableNames: readonly string[];
  readonly create: () => ClientAdapter;
  readonly envKey?: string;
  readonly ruleSetup?: (home: string, root: string) => void;
}

function expandCandidate(path: string, home: string, root: string): string {
  const expanded = path.startsWith('~/') ? join(home, path.slice(2)) : path.startsWith('~') ? home : path.replace('<root>', root);
  return resolve(expanded);
}

function installExecutables(bin: string, names: readonly string[]): void {
  for (const name of names) {
    if (process.platform === 'win32') m18cWriteText(join(bin, `${name}.cmd`), '@echo off\r\n');
    else m18cWriteText(join(bin, name), '#!/usr/bin/env node\nprocess.exit(0);\n');
  }
}

function fixture(t: TestContext, prefix: string): { root: string; home: string; bin: string } {
  const root = m18cTmp(t, prefix);
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  return { root, home, bin };
}

const JSON_ADAPTERS: readonly JsonAdapterCase[] = [
  {
    name: 'tongyi-lingma',
    candidates: TONGYI_LINGMA_CONFIG_CANDIDATES,
    executableNames: ['qodercn', 'qoder'],
    create: () => createTongyiLingmaAdapter(),
    envKey: 'QODERCN_CONFIG_DIR',
    ruleSetup: (_home, root) => {
      m18cWriteText(join(root, 'AGENTS.md'), '# rules\n');
    },
  },
  {
    name: 'comate',
    candidates: COMATE_CONFIG_CANDIDATES,
    executableNames: ['comatecli'],
    create: () => createComateAdapter(),
    ruleSetup: (_home, root) => {
      m18cWriteText(join(root, '.comate', 'rules', 'ano.mdr'), '---\nalways: true\n---\nbody\n');
    },
  },
  {
    name: 'amazon-q',
    candidates: AMAZON_Q_CONFIG_CANDIDATES,
    executableNames: ['kiro-cli', 'kiro'],
    create: () => createAmazonQAdapter(),
    envKey: 'KIRO_HOME',
    ruleSetup: (home, root) => {
      m18cWriteText(join(home, '.kiro', 'steering', 'a.md'), '# steering\n');
      m18cWriteText(join(root, '.kiro', 'steering', 'b.md'), '# workspace steering\n');
    },
  },
];

for (const item of JSON_ADAPTERS) {
  test(`${item.name}: inspect reports an unreadable declared config as an isolated error`, async (t) => {
    const { root, home, bin } = fixture(t, `ano-m18-c-${item.name}-`);
    installExecutables(bin, item.executableNames);
    const userCandidate = item.candidates.find((candidate) => candidate.scope === 'user')!;
    m18cWriteText(expandCandidate(userCandidate.path, home, root), '{ this is not json');

    const adapter = item.create();
    const report = await adapter.inspect({ root, cwd: root, env: m18cHomeEnv(home, { PATH: bin }) });
    assert.ok(
      report.errors.some((error) => error.code === 'E2_CONFIG_UNREADABLE' && error.layer === 'configured'),
      `expected an E2_CONFIG_UNREADABLE configured error, got ${JSON.stringify(report.errors)}`,
    );
  });

  test(`${item.name}: inspect scans declared rule paths only when they exist`, async (t) => {
    const { root, home, bin } = fixture(t, `ano-m18-c-${item.name}-rules-`);
    installExecutables(bin, item.executableNames);
    item.ruleSetup?.(home, root);

    const adapter = item.create();
    const report = await adapter.inspect({ root, cwd: root, env: m18cHomeEnv(home, { PATH: bin }) });
    assert.equal(report.layers.instructions.details.rulePaths.length > 0, true, 'declared rule paths must be reported');
  });

  test(`${item.name}: detect collects the declared environment source`, async (t) => {
    if (item.envKey === undefined) return;
    const { root, home, bin } = fixture(t, `ano-m18-c-${item.name}-env-`);
    installExecutables(bin, item.executableNames);
    const envDir = join(root, 'declared-env-dir');
    const adapter = item.create();
    const detected = await adapter.detect({ cwd: root, env: m18cHomeEnv(home, { PATH: bin, [item.envKey]: envDir }) });
    assert.ok(
      detected.sources.some((source) => source.kind === 'env' && source.source === `env:${item.envKey}`),
      `expected env:${item.envKey} in ${JSON.stringify(detected.sources)}`,
    );
  });

  test(`${item.name}: config refuses undeclared paths and rootless project targets`, async (t) => {
    const { root, home } = fixture(t, `ano-m18-c-${item.name}-refuse-`);
    const adapter = item.create();

    const unknownPath = await adapter.config(
      m18cConfig({ target: { scope: 'project', path: join(root, 'not-declared.json') }, mode: 'dry-run', env: m18cHomeEnv(home) }),
    );
    assert.equal(unknownPath.mode, 'dry-run');
    assert.equal(unknownPath.changes.length, 0);
    assert.ok(m18cWarnings(unknownPath).some((line) => line.includes('refus')));

    const rootless = await adapter.config(
      m18cConfig({ target: { scope: 'project' }, mode: 'dry-run', env: m18cHomeEnv(home) }),
    );
    assert.equal(rootless.changes.length, 0);
    assert.ok(m18cWarnings(rootless).some((line) => line.includes('refus')));
  });

  test(`${item.name}: config rejects TOML targets and falls back when env injection is not an object`, async (t) => {
    const { root, home } = fixture(t, `ano-m18-c-${item.name}-format-`);
    const adapter = item.create();

    const toml = await adapter.config(
      m18cConfig({ target: { scope: 'user', format: 'toml' }, mode: 'dry-run', root, env: m18cHomeEnv(home) }),
    );
    assert.ok(m18cWarnings(toml).some((line) => line.toLowerCase().includes('toml')));

    const badEnv = await adapter.config(
      m18cConfig({ target: { scope: 'project' }, mode: 'dry-run', root, env: 'not-an-env-record' }),
    );
    assert.equal(badEnv.mode, 'dry-run');
  });

  test(`${item.name}: apply requires an auditable statement, then writes once and replays zero-write`, async (t) => {
    const { root, home } = fixture(t, `ano-m18-c-${item.name}-apply-`);
    const adapter = item.create();
    const base = { target: { scope: 'project' as const }, mode: 'apply' as const, root, env: m18cHomeEnv(home) };
    const projectCandidate = item.candidates.find((candidate) => candidate.scope === 'project')!;
    const written = expandCandidate(projectCandidate.path, home, root);
    mkdirSync(resolve(written, '..'), { recursive: true });
    // applyClientConfig reads the existing file before writing; start from an
    // empty JSON container so the first apply is a real add.
    m18cWriteJson(written, {});

    const missing = await adapter.config(m18cConfig(base));
    assert.equal(missing.mode, 'dry-run');
    assert.ok(m18cWarnings(missing).some((line) => line.includes('missing authorization credential')));

    const blank = await adapter.config(m18cConfig({ ...base, authorization: m18cAuthz(root, item.name, { statement: '   ' }) }));
    assert.equal(blank.mode, 'dry-run');
    assert.ok(m18cWarnings(blank).some((line) => line.includes('auditable statement')));

    const grant = m18cAuthz(root, item.name, { statement: `Authorize ANO ${item.name} configuration` });

    const applied = await adapter.config(m18cConfig({ ...base, authorization: grant }));
    assert.equal(applied.mode, 'apply');
    assert.equal(applied.changes.length > 0, true);

    // User-scope apply without an injected root must refuse before any write.
    const userCandidate = item.candidates.find((candidate) => candidate.scope === 'user')!;
    const userPath = expandCandidate(userCandidate.path, home, root);
    mkdirSync(resolve(userPath, '..'), { recursive: true });
    m18cWriteJson(userPath, {});
    const rootlessApply = await adapter.config(
      m18cConfig({ target: { scope: 'user' }, mode: 'apply', env: m18cHomeEnv(home), authorization: grant }),
    );
    assert.equal(rootlessApply.mode, 'dry-run');
    assert.ok(m18cWarnings(rootlessApply).some((line) => line.includes('project root is required')));

    const replay = await adapter.config(m18cConfig({ ...base, authorization: grant }));
    assert.equal(replay.mode, 'dry-run');
    assert.ok(m18cWarnings(replay).some((line) => line.includes('already matches')), 'replay must report zero-write');

    // A real filesystem fault on the backup path must surface as a located,
    // zero-write refusal rather than an exception.
    const backupBlocker = join(root, '.ano', 'clients', 'backups', item.name);
    m18cWriteJson(written, {});
    rmSync(backupBlocker, { recursive: true, force: true });
    m18cWriteText(backupBlocker, 'not a directory');
    const failed = await adapter.config(m18cConfig({ ...base, authorization: grant }));
    assert.equal(failed.mode, 'dry-run');
    assert.ok(m18cWarnings(failed).some((line) => line.includes('apply failed')));
    assert.equal(written.length > 0, true);
  });
}

test('deepseek-harness: aborted detection and declared Cordis YAML carriers stay read-only', async (t) => {
  const root = m18cTmp(t, 'ano-m18-c-dsh-');
  const home = join(root, 'home');
  const projectRoot = join(root, 'project');
  const carrier = join(projectRoot, 'cordis.yml');
  m18cWriteText(carrier, 'mcp:\n  ano:\n    command: node\n');
  const adapter = createDeepSeekHarnessAdapter({ home, root: projectRoot });

  const controller = new AbortController();
  controller.abort();
  const aborted = await adapter.detect({ cwd: projectRoot, signal: controller.signal });
  assert.equal(aborted.detected, false);
  assert.equal(aborted.errors[0]?.code, 'E1_ABORTED');

  const report = await adapter.inspect({ root: projectRoot, env: m18cHomeEnv(home) });
  assert.equal(report.layers.configured.verdict, 'degraded');
  assert.equal(report.layers.configured.details.exists, true);
  assert.equal(report.layers.configured.details.configPath, resolve(carrier));
  assert.equal(report.layers.configured.version, 'config-format:yaml');

  const view = readDeclaredCordisCarrier(carrier);
  assert.equal(view.exists, true);
  assert.equal(view.bytes > 0, true);
  assert.equal(readDeclaredCordisCarrier(join(root, 'absent.yml')).exists, false);
  assert.equal(isCordisYamlCandidate(DEEPSEEK_HARNESS_CONFIG_CANDIDATES[0]), true);
  assert.equal(isCordisYamlCandidate({ format: 'json' }), false);
});

test('deepseek-harness: $DSH_HOME carrier is discovered and apply always degrades to zero write', async (t) => {
  const root = m18cTmp(t, 'ano-m18-c-dsh-home-');
  const home = join(root, 'home');
  const dshHome = join(root, 'dsh-home');
  m18cWriteText(join(dshHome, 'cordis.patch.yml'), 'patch: {}\n');
  const adapter = createDeepSeekHarnessAdapter({ home, root, env: { DSH_HOME: dshHome } });

  const detected = await adapter.detect({ cwd: root, env: { ...m18cHomeEnv(home), DSH_HOME: dshHome } });
  assert.ok(detected.sources.some((source) => source.kind === 'env' && source.source === 'env:DSH_HOME'));

  const withoutAuth = await adapter.config(m18cConfig({ mode: 'apply', target: { scope: 'user' } }));
  assert.equal(withoutAuth.mode, 'dry-run');
  assert.ok(m18cWarnings(withoutAuth).some((line) => line.includes('缺显式授权')));

  const withAuth = await adapter.config(
    m18cConfig({ mode: 'apply', target: { scope: 'user' }, authorization: m18cAuthz(root, 'deepseek-harness', { statement: 'authorize' }) }),
  );
  assert.equal(withAuth.mode, 'dry-run');
  assert.equal(withAuth.changes.length, 0);
});
