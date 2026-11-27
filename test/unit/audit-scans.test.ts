import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runAudit } from '../../src/audit/index.ts';
import { packageEntries, scanDrift } from '../../src/audit/drift.ts';
import { loadGovernancePolicy, scanGovernance } from '../../src/audit/governance.ts';
import { AuditInputError, type AuditFinding, type AuditGraphView, type GovernancePolicy } from '../../src/audit/types.ts';

async function temp(prefix: string): Promise<string> { return mkdtemp(join(tmpdir(), prefix)); }

async function write(root: string, path: string, source: string): Promise<void> {
  const target = join(root, ...path.split('/'));
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, source);
}

async function writeJson(root: string, path: string, value: unknown): Promise<void> {
  await write(root, path, JSON.stringify(value));
}

function graph(
  edges: Array<{ from: string; to: string }>,
  caveats?: { unknownRatio?: number; degradedReasons?: string[]; dynamicLoadCount?: number; heuristicEdges?: number },
): AuditGraphView {
  return {
    snapshot: () => ({
      revision: 'rev-test',
      files: {},
      edges,
      ...(caveats ? { caveats } : {}),
    }),
  };
}

test('packageEntries normalizes every supported manifest entry shape', () => {
  const entries = packageEntries({
    main: './dist/index.js',
    module: ['dist/mod.mjs', 'dist/other.mjs', '', '../escape.js', 'a/../b.js', 'lib/*.js'],
    types: { types: 'types/index.d.ts', default: 'types/fallback.d.ts' },
    browser: { './dom.js': 'browser/dom.js' },
    bin: { ano: 'dist/cli.js', other: ['dist/alt.js'] },
    exports: { '.': { import: 'dist/esm.js', require: 'dist/cjs.js' }, './sub': 'dist/sub.js' },
  });
  const paths = entries.map((entry) => entry.path);
  assert.ok(paths.includes('dist/index.js'));
  assert.ok(paths.includes('dist/mod.mjs'));
  assert.ok(paths.includes('types/index.d.ts'));
  assert.ok(paths.includes('browser/dom.js'));
  assert.ok(paths.includes('dist/cli.js'));
  assert.ok(paths.includes('dist/esm.js'));
  assert.ok(paths.includes('dist/sub.js'));
  assert.ok(!paths.some((path) => path.includes('*') || path.includes('..') || path === ''), paths.join(','));
  assert.deepEqual(entries, [...entries].sort((a, b) => a.path.localeCompare(b.path)));
});

test('scanDrift reports missing entries, anchors and task files, and degrades honestly', async () => {
  const root = await temp('ano drift ');
  try {
    await write(root, 'src/present.ts', 'export const present = 1;\n');
    const result = await scanDrift(root, {
      entries: [
        { path: 'dist/gone.js', label: 'main' },
        { path: '../outside.js', label: 'escape' },
        { path: 'src/present.ts', label: 'types' },
      ],
      anchors: [
        { file: 'src/gone.ts', symbol: 'gone' },
        { file: 'src/present.ts' },
        { file: '../../bad.ts', contentFragmentHash: 'a'.repeat(64) },
        { file: 'src/present.ts', contentFragmentHash: 'b'.repeat(64) },
      ],
      ledger: {
        getTasks: () => [
          { id: 'T-1', status: 'in_progress', declaredFiles: ['src/present.ts', 'src/deleted.ts', '../nope.ts'] },
          { id: 'T-2', status: 'cancelled', declaredFiles: ['src/never.ts'] },
        ],
      },
    });
    const rules = result.findings.map((finding) => finding.rule);
    assert.ok(rules.includes('drift/entry-missing'));
    assert.ok(rules.includes('drift/anchor-file-missing'));
    assert.ok(rules.includes('drift/task-file-missing'));
    assert.equal(result.tasks, 1, 'cancelled tasks are skipped');
    assert.equal(result.anchors, 4);
    assert.equal(result.entries, 3);
    assert.ok(result.degraded.includes('entry-path-invalid:escape'));
    assert.ok(result.degraded.some((entry) => entry.startsWith('anchor-path-invalid:')));
    assert.ok(result.degraded.some((entry) => entry.startsWith('task-path-invalid:T-1')));
    assert.deepEqual(result.caveats, ['anchor-content-fragment-hash-not-recomputed']);
    assert.ok(result.findings.some((finding) => finding.message.includes('for symbol gone')));
    assert.ok(result.findings.every((finding) => finding.fingerprint.length === 64));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('scanDrift reads package.json entries and degrades when the manifest or ledger is absent', async () => {
  const empty = await temp('ano drift empty ');
  try {
    const noManifest = await scanDrift(empty);
    assert.ok(noManifest.degraded.some((entry) => entry.startsWith('package-json-unreadable:')));
    assert.ok(noManifest.degraded.includes('ledger-not-injected'));
    assert.equal(noManifest.entries, 0);

    await writeJson(empty, 'package.json', { name: 'x', main: 'dist/index.js' });
    const noLedger = await scanDrift(empty);
    assert.equal(noLedger.entries, 1);
    assert.ok(noLedger.findings.some((finding) => finding.rule === 'drift/entry-missing'));
    assert.ok(noLedger.degraded.includes('ledger-not-injected'));
  } finally { await rm(empty, { recursive: true, force: true }); }
});

test('loadGovernancePolicy prefers .ano, falls back to .pm and reports invalid or unreadable files', async () => {
  const root = await temp('ano governance policy ');
  try {
    const nothing = await loadGovernancePolicy(root);
    assert.equal(nothing.policy, undefined);
    assert.deepEqual(nothing.degraded, []);

    await writeJson(root, '.pm/governance.json', { modules: [{ id: 'core', roots: ['src'] }] });
    const fromPm = await loadGovernancePolicy(root);
    assert.equal(fromPm.source, '.pm/governance.json');
    assert.equal(fromPm.policy?.modules.length, 1);

    await writeJson(root, '.ano/governance.json', { modules: [{ id: 'core', roots: ['src'] }] });
    const fromAno = await loadGovernancePolicy(root);
    assert.equal(fromAno.source, '.ano/governance.json');

    await writeJson(root, '.ano/governance.json', { modules: [{ id: '', roots: [] }], unexpected: 1 });
    const invalid = await loadGovernancePolicy(root);
    assert.equal(invalid.degraded.includes('policy-invalid:.ano/governance.json'), true);
    assert.equal(invalid.source, '.pm/governance.json', 'a valid fallback is still used');
    assert.equal(invalid.policy?.modules.length, 1);

    await rm(join(root, '.pm'), { recursive: true, force: true });
    await rm(join(root, '.ano'), { recursive: true, force: true });
    await writeJson(root, '.ano/governance.json', { modules: [{ id: '', roots: [] }], unexpected: 1 });
    const onlyInvalid = await loadGovernancePolicy(root);
    assert.equal(onlyInvalid.policy, undefined);
    assert.equal(onlyInvalid.degraded.includes('policy-invalid:.ano/governance.json'), true);

    await rm(join(root, '.ano'), { recursive: true, force: true });
    await mkdir(join(root, '.ano'), { recursive: true });
    await mkdir(join(root, '.ano', 'governance.json'));
    const unreadable = await loadGovernancePolicy(root);
    assert.ok(unreadable.degraded.some((entry) => entry.startsWith('policy-unreadable:.ano/governance.json:')), unreadable.degraded.join(','));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('scanGovernance reports graph-missing and policy-missing before evaluating rules', () => {
  const noGraph = scanGovernance(undefined, { degraded: ['existing'] });
  assert.equal(noGraph.findings[0]?.rule, 'governance/graph-missing');
  assert.equal(noGraph.modules, 0);
  assert.ok(noGraph.degraded.includes('graph-unavailable'));
  assert.ok(noGraph.degraded.includes('existing'));

  const noPolicy = scanGovernance(graph([{ from: 'src/a.ts', to: 'src/b.ts' }]), { degraded: [] });
  assert.equal(noPolicy.findings[0]?.rule, 'governance/policy-missing');
  assert.equal(noPolicy.edges, 1);
  assert.ok(noPolicy.degraded.includes('policy-missing'));

  const withSource = scanGovernance(undefined, { degraded: [], source: '.ano/governance.json', policy: { modules: [] } });
  assert.equal(withSource.policySource, '.ano/governance.json');
  assert.equal(withSource.modules, 0);
});

test('scanGovernance evaluates denied, undeclared and cyclic module edges', () => {
  const policy: GovernancePolicy = {
    schemaVersion: 1,
    modules: [
      { id: 'core', roots: ['src/'] },
      { id: 'api', roots: ['api'], allowedDependencies: ['core'] },
      { id: 'web', roots: ['web'], allowedDependencies: [] },
      { id: 'deny', roots: ['deny', 'weird/../path'], deniedDependencies: ['core'] },
    ],
  };
  const result = scanGovernance(graph([
    { from: 'api/x.ts', to: 'src/y.ts' },
    { from: 'src/a.ts', to: 'src/b.ts' },
    { from: 'src/a.ts', to: 'api/x.ts' },
    { from: 'web/w.ts', to: 'src/a.ts' },
    { from: 'deny/d.ts', to: 'src/a.ts' },
    { from: 'nowhere/n.ts', to: 'src/a.ts' },
  ]), { degraded: [], source: '.ano/governance.json', policy });
  const rules = result.findings.map((finding) => finding.rule);
  assert.ok(result.degraded.some((entry) => entry.startsWith('policy-root-invalid:deny:')), result.degraded.join(','));
  assert.ok(rules.includes('governance/denied-dependency'));
  assert.ok(rules.includes('governance/undeclared-dependency'));
  assert.ok(rules.includes('governance/module-cycle'));
  assert.equal(result.policySource, '.ano/governance.json');
  assert.equal(result.modules, 4);
  assert.equal(result.edges, 6);
  const undeclared = result.findings.find((finding) => finding.rule === 'governance/undeclared-dependency');
  assert.match(String(undeclared?.message), /allowed: none/);
});

test('scanGovernance honours disabled policies and surfaces graph caveats', () => {
  const policy: GovernancePolicy = {
    modules: [
      { id: 'core', roots: ['src'] },
      { id: 'api', roots: ['api'], dependsOn: [] },
    ],
    policies: { enforceDeclaredDependencies: false, failOnCycles: false },
  };
  const result = scanGovernance(graph(
    [
      { from: 'api/x.ts', to: 'src/a.ts' },
      { from: 'src/a.ts', to: 'api/x.ts' },
      { from: 'api/x.ts', to: 'src/a.ts' },
    ],
    { unknownRatio: 0.75, degradedReasons: ['tree-sitter-missing'], dynamicLoadCount: 2, heuristicEdges: 1 },
  ), { degraded: [], policy });
  assert.deepEqual(result.findings.map((finding) => finding.rule), ['governance/low-confidence']);
  assert.ok(result.degraded.includes('graph-degraded:tree-sitter-missing'));
  assert.match(result.findings[0]!.message, /0\.75/);
  assert.equal(result.policySource, undefined);
});

test('runAudit rejects invalid roots and sanitizes injected online findings', async () => {
  const missing = join(await temp('ano audit root '), 'absent');
  await assert.rejects(runAudit(missing, { scope: 'security' }), AuditInputError);

  const fileRoot = await temp('ano audit fileroot ');
  await write(fileRoot, 'a.txt', 'text');
  await assert.rejects(runAudit(join(fileRoot, 'a.txt'), { scope: 'security' }), /not a directory/);

  const root = await temp('ano audit online ');
  try {
    await writeJson(root, 'package.json', { name: 'online-fixture', dependencies: { alpha: '^1.0.0' } });
    await writeJson(root, 'package-lock.json', { packages: { 'node_modules/alpha': { name: 'alpha', version: '1.2.3' } } });
    let seenPackages: unknown;
    const scanner = async (): Promise<AuditFinding[]> => {
      const hostile: AuditFinding[] = [
        {
          id: 'x', scope: 'deps', rule: '!bad rule', severity: 'critical' as AuditFinding['severity'], message: 'plaintext leak',
          fingerprint: 'not-a-hash', path: '../escape.txt', line: -3, column: 1.5, status: 'open',
        },
        {
          id: 'y', scope: 'deps', rule: 'osv/CVE-2024-0001', severity: 'high', message: 'ignored',
          fingerprint: 'a'.repeat(64), path: 'node_modules/alpha', line: 4, column: 2, status: 'open',
        },
      ];
      return hostile;
    };
    const result = await runAudit(root, {
      scope: 'deps', online: true, confirm: true, persist: false,
      context: {
        onlineScanner: async (request) => { seenPackages = request.packages; return scanner(); },
      },
    });
    assert.equal(result.network.performed, true);
    assert.equal(result.network.requested, true);
    assert.ok(Array.isArray(seenPackages) && (seenPackages as unknown[]).length === 1);
    const sanitized = result.findings.find((finding) => finding.rule === 'online/scanner-finding');
    assert.ok(sanitized, 'the hostile rule must be replaced');
    assert.equal(sanitized.severity, 'medium');
    assert.equal(sanitized.path, undefined);
    assert.equal(sanitized.line, undefined);
    assert.equal(sanitized.column, undefined);
    assert.match(sanitized.fingerprint, /^[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(result).includes('plaintext leak'));
    const trusted = result.findings.find((finding) => finding.rule === 'osv/CVE-2024-0001');
    assert.ok(trusted);
    assert.equal(trusted.line, 4);
    assert.equal(trusted.column, 2);

    const offlineFirst = await runAudit(root, { scope: 'license', online: true, confirm: true, persist: false });
    assert.equal(offlineFirst.network.refused, 'not-configured');
    assert.ok(offlineFirst.degraded.includes('online-scanner-not-configured'));
  } finally { await rm(root, { recursive: true, force: true }); await rm(fileRoot, { recursive: true, force: true }); }
});
