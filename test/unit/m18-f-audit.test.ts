/**
 * T-153 shard F: `src/audit/{deps,events,governance,index,security,util}.ts`
 * completion tests on real temporary project trees.
 *
 * Priority targets from the native baseline: `ledgerAuditInputs`,
 * `findingIdentity`, `locate`, the `listProjectFiles`/`readTextFile` error
 * boundaries, the legacy lockfile `walk`, the Tarjan component ordering and
 * the security env-literal rejection arms. Every error path is produced by a
 * real filesystem shape; nothing is mocked.
 */

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { scanDependencies } from '../../src/audit/deps.ts';
import { auditEvents, emitAuditEvents, InMemoryAuditEventSink, JsonlAuditEventSink, ledgerAuditInputs } from '../../src/audit/events.ts';
import { scanGovernance, loadGovernancePolicy } from '../../src/audit/governance.ts';
import { findingIdentity, runAudit } from '../../src/audit/index.ts';
import { scanSecurity } from '../../src/audit/security.ts';
import {
  MAX_SCAN_BYTES,
  isProbablyText,
  listProjectFiles,
  locate,
  makeFinding,
  readTextFile,
  sha256,
} from '../../src/audit/util.ts';
import type {
  AuditFinding,
  AuditGraphView,
  AuditResult,
  AuditRunOptions,
  GovernancePolicy,
} from '../../src/audit/types.ts';
import { m18fPackage, m18fRemove, m18fTempDir, m18fWrite } from '../helpers/m18-f-fixtures.ts';

const HASH = 'a'.repeat(64);

function tempProject(prefix: string): Promise<string> {
  return m18fTempDir(prefix);
}

// ---------------------------------------------------------------------------
// deps: legacy (npm v6 style) lockfile walk
// ---------------------------------------------------------------------------

test('scanDependencies walks legacy nested lockfiles and reports missing entries', async () => {
  const root = await tempProject('ano m18f deps ');
  try {
    await m18fWrite(root, 'package.json', JSON.stringify({
      dependencies: { a: '1.0.0', missing: '^1.2.3' },
      devDependencies: { b: 'latest' },
      optionalDependencies: { opt: '*' },
    }));
    await m18fWrite(root, 'package-lock.json', JSON.stringify({
      dependencies: {
        a: { version: '1.0.0', license: 'MIT', dependencies: { nested: { version: '0.1.0' } } },
        c: { version: '2.0.0' },
        bad: null,
        arr: [],
      },
    }));

    const result = await scanDependencies(root);
    assert.equal(result.declared, 4);
    assert.deepEqual(result.degraded, []);
    // The legacy walk records name/version only; license is packages-branch only.
    assert.deepEqual(result.packages, [
      { name: 'a', version: '1.0.0' },
      { name: 'nested', version: '0.1.0' },
      { name: 'c', version: '2.0.0' },
    ]);
    const rules = result.findings.map((finding) => finding.rule);
    assert.ok(rules.includes('deps/lock-entry-missing'), rules.join(','));
    assert.ok(rules.includes('deps/unpinned-range'), rules.join(','));
    assert.ok(rules.includes('deps/moving-tag'), rules.join(','));
    const missing = result.findings.filter((finding) => finding.rule === 'deps/lock-entry-missing');
    assert.equal(missing.length, 2, 'declared-but-unlocked dependencies/missing and devDependencies/b are reported');
    assert.ok(missing.some((finding) => /\bmissing\b/u.test(finding.message)));
    assert.ok(!result.findings.some((finding) => finding.message.includes('opt@')), 'optional deps may be absent');
  } finally {
    await m18fRemove(root);
  }
});

test('scanDependencies handles install scripts and malformed packages entries', async () => {
  const root = await tempProject('ano m18f deps packages ');
  try {
    await m18fWrite(root, 'package.json', JSON.stringify({ dependencies: { a: '^1.0.0' } }));
    await m18fWrite(root, 'package-lock.json', JSON.stringify({
      packages: {
        '': { name: 'root', version: '1.0.0' },
        'node_modules/a': { version: '1.2.3', license: 'MIT', hasInstallScript: true },
        'node_modules/b': null,
        'node_modules/c': [],
        'node_modules/d': { version: '4.5.6' },
        bad: {},
      },
    }));

    const result = await scanDependencies(root);
    // The result view exposes name/version only; install scripts surface as findings.
    assert.deepEqual(result.packages, [
      { name: 'a', version: '1.2.3' },
      { name: 'd', version: '4.5.6' },
    ]);
    assert.ok(result.findings.some((finding) => finding.rule === 'deps/install-script'), result.findings.map((f) => f.rule).join(','));
    assert.ok(!result.findings.some((finding) => /node_modules\/[bcd]/u.test(finding.message)), 'malformed lock entries are skipped');
  } finally {
    await m18fRemove(root);
  }
});

// ---------------------------------------------------------------------------
// events: ledger adapter inputs and sinks
// ---------------------------------------------------------------------------

test('ledgerAuditInputs maps finding/summary events without plaintext payloads', async () => {
  const root = await tempProject('ano m18f events ');
  try {
    const finding = makeFinding({
      scope: 'security',
      rule: 'secret/private-key',
      severity: 'high',
      message: 'Private key material is present',
      fingerprint: HASH,
      path: 'keys/id_rsa',
      line: 3,
    });
    const result: AuditResult = {
      schema: 'ano.audit.v1',
      scope: 'security',
      root,
      ok: false,
      findings: [finding],
      summary: { high: 1, medium: 0, low: 0, info: 0, total: 1 },
      counts: { files: 1 },
      degraded: [],
      caveats: [],
      network: { requested: false, performed: false },
      startedAt: '2026-11-25T00:00:00.000Z',
      finishedAt: '2026-11-25T00:00:00.100Z',
      durationMs: 100,
    };

    const inputs = ledgerAuditInputs(result);
    assert.deepEqual(inputs.map((input) => input.kind), ['audit.finding', 'audit.completed']);
    assert.deepEqual(Object.keys(inputs[0]!.payload).sort(), ['at', 'finding', 'scope']);
    assert.deepEqual(Object.keys(inputs[1]!.payload).sort(), ['at', 'ok', 'scope', 'summary']);

    const sink = new InMemoryAuditEventSink();
    await emitAuditEvents(sink, result);
    assert.equal(sink.events.length, 2);
    assert.deepEqual(auditEvents(result).map((event) => event.type), ['finding', 'summary']);

    await emitAuditEvents(undefined, result);
    const jsonl = new JsonlAuditEventSink(root);
    await jsonl.record(auditEvents(result)[0]!);
    const lines = (await readFile(jsonl.path, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]!).type, 'finding');
  } finally {
    await m18fRemove(root);
  }
});

// ---------------------------------------------------------------------------
// governance: Tarjan component ordering
// ---------------------------------------------------------------------------

test('scanGovernance evaluates multiple independent cycles deterministically', () => {
  const policy: GovernancePolicy = {
    modules: [
      { id: 'a', roots: ['a'] },
      { id: 'b', roots: ['b'] },
      { id: 'c', roots: ['c'] },
      { id: 'd', roots: ['d'] },
    ],
    policies: { failOnCycles: true, enforceDeclaredDependencies: true },
  };
  const graph: AuditGraphView = {
    snapshot: () => ({
      revision: 'rev-1',
      files: {},
      edges: [
        { from: 'a/one.ts', to: 'b/two.ts' },
        { from: 'b/two.ts', to: 'a/one.ts' },
        { from: 'c/three.ts', to: 'd/four.ts' },
        { from: 'd/four.ts', to: 'c/three.ts' },
      ],
      caveats: { unknownRatio: 0 },
    }),
  };

  const result = scanGovernance(graph, { policy, degraded: [] });
  assert.equal(result.modules, 4);
  assert.equal(result.edges, 4);
  assert.deepEqual(result.findings.map((finding) => finding.rule), ['governance/module-cycle', 'governance/module-cycle']);
  assert.deepEqual(
    result.findings.map((finding) => finding.message),
    ['Cyclic module dependency: a -> b', 'Cyclic module dependency: c -> d'],
  );
});

test('loadGovernancePolicy records a non-ENOENT read failure and falls through', async () => {
  const root = await tempProject('ano m18f gov ');
  try {
    await mkdir(join(root, '.ano', 'governance.json'), { recursive: true });
    const loaded = await loadGovernancePolicy(root);
    assert.equal(loaded.policy, undefined);
    assert.ok(
      loaded.degraded.includes('policy-unreadable:.ano/governance.json:EISDIR'),
      loaded.degraded.join(','),
    );
  } finally {
    await m18fRemove(root);
  }
});

// ---------------------------------------------------------------------------
// index: identity and online boundary
// ---------------------------------------------------------------------------

test('findingIdentity is the documented hash over scope/rule/fingerprint', () => {
  assert.equal(
    findingIdentity('security', 'secret/private-key', HASH),
    sha256(`security\0secret/private-key\0${HASH}`),
  );
  assert.notEqual(findingIdentity('deps', 'secret/private-key', HASH), findingIdentity('security', 'secret/private-key', HASH));
});

test('runAudit sanitizes an injected online scanner finding and keeps empty packages', async () => {
  const root = await tempProject('ano m18f online ');
  try {
    await m18fPackage(root, 'app');
    let seen: { packages: readonly unknown[] } | undefined;
    const options: AuditRunOptions = {
      scope: 'security',
      confirm: true,
      online: true,
      persist: false,
      now: () => 0,
      context: {
        onlineScanner: async (request) => {
          seen = { packages: request.packages };
          return [{
            id: 'online-1',
            scope: 'security',
            rule: 'bad rule!',
            severity: 'critical',
            message: 'raw scanner text must be replaced',
            fingerprint: 'not-a-hash',
            status: 'open',
            path: '../escape',
            line: 0,
            column: -1,
          } as unknown as AuditFinding];
        },
      },
    };
    const sink = new InMemoryAuditEventSink();
    const result = await runAudit(root, { ...options, sink });

    assert.deepEqual(seen, { packages: [] }, 'security scans carry no packages');
    assert.equal(result.network.performed, true);
    assert.equal(result.network.requested, true);
    assert.equal(result.findings.length, 1);
    const sanitized = result.findings[0]!;
    assert.equal(sanitized.rule, 'online/scanner-finding');
    assert.equal(sanitized.severity, 'medium');
    assert.match(sanitized.fingerprint, /^[a-f0-9]{64}$/u);
    assert.equal(sanitized.path, undefined);
    assert.equal(sanitized.line, undefined);
    assert.equal(sanitized.column, undefined);
    assert.equal(result.ok, false);
    assert.equal(sink.events.length, 2, 'finding plus summary are emitted');
  } finally {
    await m18fRemove(root);
  }
});

// ---------------------------------------------------------------------------
// security: rule rejection arms and walk errors
// ---------------------------------------------------------------------------

test('scanSecurity honours placeholder/path-like rejections and real rule matches', async () => {
  const root = await tempProject('ano m18f sec ');
  try {
    await m18fWrite(root, '.env', [
      'API_KEY=abcdefgh12345678',
      'SECRET=/usr/local/bin/realsecretvalue',
      'TOKEN=$SOME_VAR_XYZ_12345678',
      '',
    ].join('\n'));
    await m18fWrite(root, 'generic.txt', 'api_key = "abcd${VAR}efgh"\n');
    await m18fWrite(root, 'aws.txt', 'aws_secret_access_key = "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"\n');
    await m18fWrite(root, 'pk.txt', '-----BEGIN RSA PRIVATE KEY-----\n');
    await m18fWrite(root, 'eval.txt', 'const x = eval(code);\n');

    const result = await scanSecurity(root);
    const rules = result.findings.map((finding) => finding.rule);
    assert.ok(rules.includes('secret/env-literal'), rules.join(','));
    assert.ok(rules.includes('secret/aws-secret-access-key'), rules.join(','));
    assert.ok(rules.includes('secret/private-key'), rules.join(','));
    assert.ok(rules.includes('danger/eval'), rules.join(','));
    assert.ok(!rules.includes('secret/generic-credential'), 'placeholder-looking value is rejected');
    const envFinding = result.findings.find((finding) => finding.rule === 'secret/env-literal')!;
    assert.equal(envFinding.path, '.env');
    assert.equal(envFinding.line, 1);
    assert.equal(result.degraded.length, 0, 'no walk/read degradation expected');
  } finally {
    await m18fRemove(root);
  }
});

test('scanSecurity reports a walk error when the root is not a directory', async () => {
  const root = await tempProject('ano m18f secwalk ');
  try {
    const file = await m18fWrite(root, 'plain.txt', 'hello\n');
    const result = await scanSecurity(file);
    assert.deepEqual(result.files, 0);
    assert.deepEqual(result.findings, []);
    assert.ok(
      result.degraded.some((entry) => entry.startsWith('walk-error:.:') && entry.endsWith(':ENOTDIR')),
      result.degraded.join(','),
    );
  } finally {
    await m18fRemove(root);
  }
});

// ---------------------------------------------------------------------------
// util: locate/list/read boundaries
// ---------------------------------------------------------------------------

test('locate maps byte offsets to 1-based line/column across newlines', () => {
  const text = 'a\nb\nc';
  assert.deepEqual(locate(text, 0), { line: 1, column: 1 });
  assert.deepEqual(locate(text, 2), { line: 2, column: 1 });
  assert.deepEqual(locate(text, 4), { line: 3, column: 1 });
  assert.deepEqual(locate(text, 5), { line: 3, column: 2 }, 'offset just past the end is measured from the last newline');
  assert.deepEqual(locate('', 0), { line: 1, column: 1 });
  assert.deepEqual(locate('ab\ncd', 4), { line: 2, column: 2 });
});

test('listProjectFiles is deterministic, excludes caches and fails closed via onError', async () => {
  const root = await tempProject('ano m18f walk ');
  try {
    await m18fWrite(root, 'src/b.ts', 'b');
    await m18fWrite(root, 'src/a.ts', 'a');
    await m18fWrite(root, 'node_modules/dep/index.js', 'd');
    await m18fWrite(root, '.env', 'E=1');

    const files = await listProjectFiles(root);
    assert.deepEqual(files.map((file) => file.path), ['.env', 'src/a.ts', 'src/b.ts']);

    const errors: Array<{ path: string; code: string }> = [];
    const plain = await m18fWrite(root, 'plain.txt', 'x');
    const fromFile = await listProjectFiles(plain, { onError: (path, error) => { errors.push({ path, code: String((error as NodeJS.ErrnoException).code) }); } });
    assert.deepEqual(fromFile, []);
    assert.deepEqual(errors, [{ path: '.', code: 'ENOTDIR' }]);
  } finally {
    await m18fRemove(root);
  }
});

test('readTextFile enforces binary, size, regular-file and content boundaries', async () => {
  const root = await tempProject('ano m18f read ');
  try {
    await m18fWrite(root, 'text.txt', 'hello\n');
    await m18fWrite(root, 'blob.png', 'not really png');
    await m18fWrite(root, 'binary.bin', Buffer.from([0, 1, 2, 3]));
    await writeFile(join(root, 'huge.log'), Buffer.alloc(MAX_SCAN_BYTES + 1, 65));

    assert.deepEqual(await readTextFile({ path: 'text.txt', absolute: join(root, 'text.txt') }), { text: 'hello\n' });
    assert.deepEqual(await readTextFile({ path: 'blob.png', absolute: join(root, 'blob.png') }), {});
    assert.deepEqual(await readTextFile({ path: 'binary.bin', absolute: join(root, 'binary.bin') }), {});
    assert.deepEqual(await readTextFile({ path: 'huge.log', absolute: join(root, 'huge.log') }), { degraded: `file-too-large:huge.log` });
    assert.deepEqual(
      await readTextFile({ path: 'dir', absolute: root }),
      { degraded: `not-regular:dir` },
    );
    assert.equal(isProbablyText('README'), true);
    assert.equal(isProbablyText('picture.png'), false);
  } finally {
    await m18fRemove(root);
  }
});
