import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { runAudit } from '../../src/audit/index.ts';
import { classifySpdx } from '../../src/audit/license.ts';
import { listFindings, resolveFinding } from '../../src/audit/findings.ts';
import { InMemoryAuditEventSink, JsonlAuditEventSink } from '../../src/audit/events.ts';
import { makeFinding } from '../../src/audit/util.ts';
import { Ledger } from '../../src/ledger/ledger.ts';

/**
 * Red-team fixtures are assembled from short, explicitly synthetic fragments.
 * This keeps realistic-looking secret/key material out of the source tree while
 * the written fixture still exercises every scanner rule.
 */
const synthetic = (...parts: string[]): string => parts.join('');
const SECRET_AWS = synthetic('AKIA', 'SYNTHETICFAKE123');
const SECRET_PASSWORD = synthetic('hunter2', 'hunter2');
const SYNTHETIC_PRIVATE_KEY = synthetic('-----BEGIN ', 'RSA ', 'PRIVATE ', 'KEY-----');
const SYNTHETIC_EVAL_CALL = synthetic('ev', 'al(input)');
const SYNTHETIC_TLS_DISABLED = synthetic('rejectUnauthorized', ': false');

async function temp(prefix: string): Promise<string> { return mkdtemp(join(tmpdir(), prefix)); }
async function write(root: string, path: string, source: string): Promise<void> {
  const target = join(root, ...path.split('/'));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, source);
}
function sha256(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function rules(result: Awaited<ReturnType<typeof runAudit>>): string[] { return result.findings.map((finding) => finding.rule); }

test('security scan stores only fingerprints and locations, never the secret text', async () => {
  const root = await temp('ano audit secret ');
  try {
    await write(root, 'src/config.js', [
      `const aws = "${SECRET_AWS}";`,
      `const password = "${SECRET_PASSWORD}";`,
      `const key = '${SYNTHETIC_PRIVATE_KEY}';`,
    ].join('\n'));
    await write(root, 'src/danger.ts', [
      `export function run(input: string) { return ${SYNTHETIC_EVAL_CALL}; }`,
      `export const agent = { ${SYNTHETIC_TLS_DISABLED} };`,
    ].join('\n'));
    await write(root, 'src/safe.ts', [
      'export const password = process.env.PASSWORD;',
      'export const apiKey = "changeme";',
      'export const token = "{{ secrets.TOKEN }}";',
    ].join('\n'));

    const result = await runAudit(root, { scope: 'security', persist: false });
    const found = rules(result);
    for (const rule of ['secret/aws-access-key-id', 'secret/generic-credential', 'secret/private-key', 'danger/eval', 'danger/tls-verification-disabled']) {
      assert.ok(found.includes(rule), `missing ${rule}; got ${found.join(',')}`);
    }
    const configFindings = result.findings.filter((finding) => finding.path === 'src/config.js');
    assert.equal(configFindings.length, 3);
    for (const finding of result.findings) {
      assert.match(finding.fingerprint, /^[a-f0-9]{64}$/);
      assert.match(finding.id, /^[a-f0-9]{64}$/);
      assert.ok(finding.path);
      assert.ok(finding.line && finding.line >= 1);
      assert.ok(!finding.message.includes(SECRET_AWS));
      assert.ok(!finding.message.includes(SECRET_PASSWORD));
    }
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(SECRET_AWS));
    assert.ok(!serialized.includes(SECRET_PASSWORD));
    assert.ok(!serialized.includes('BEGIN RSA PRIVATE KEY'));
    assert.ok(!result.findings.some((finding) => finding.path === 'src/safe.ts'), 'placeholders must not be reported as secrets');
    assert.equal(result.summary.high, 4);
    assert.equal(result.summary.medium, 1);
    assert.equal(result.ok, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('resolved findings reopen on regression and the persisted store is hash-only', async () => {
  const root = await temp('ano audit reopen ');
  try {
    await write(root, 'config.js', `const password = "${SECRET_PASSWORD}";\n`);
    const first = await runAudit(root, { scope: 'security' });
    assert.equal(first.findings.length, 1);
    const id = first.findings[0]!.id;
    const resolved = resolveFinding(root, id);
    assert.equal(resolved.status, 'resolved');

    const second = await runAudit(root, { scope: 'security' });
    assert.equal(second.findings[0]!.status, 'open');
    assert.equal(second.findings[0]!.reopened, true);

    await unlink(join(root, 'config.js'));
    const third = await runAudit(root, { scope: 'security' });
    assert.deepEqual(third.findings, []);
    assert.equal(listFindings(root).find((finding) => finding.id === id)?.status, 'resolved');

    await write(root, 'config.js', `const password = "${SECRET_PASSWORD}";\n`);
    const fourth = await runAudit(root, { scope: 'security' });
    assert.equal(fourth.findings[0]!.id, id);
    assert.equal(fourth.findings[0]!.reopened, true);

    const store = await readFile(join(root, '.ano', 'audit', 'findings.json'), 'utf8');
    assert.ok(!store.includes(SECRET_PASSWORD));
    assert.ok(!store.includes('password'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('license audit classifies SPDX expressions and copyleft conflicts locally', async () => {
  const root = await temp('ano audit license ');
  try {
    await write(root, 'package.json', JSON.stringify({ private: true, license: 'MIT' }));
    await write(root, 'package-lock.json', JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'fixture', version: '1.0.0', license: 'MIT' },
        'node_modules/left-pad': { version: '1.3.0', license: 'MIT' },
        'node_modules/agpl': { version: '1.0.0', license: 'AGPL-3.0-only' },
        'node_modules/mystery': { version: '0.1.0', license: 'LicenseRef-Proprietary' },
        'node_modules/dual': { version: '2.0.0', license: '(MIT OR GPL-3.0-only)' },
        'node_modules/combo': { version: '1.0.0', license: '(MIT AND GPL-3.0-only)' },
      },
    }));
    const result = await runAudit(root, { scope: 'license', persist: false });
    assert.equal(result.counts.packages, 5);
    assert.ok(rules(result).includes('license/strong-copyleft'));
    assert.ok(rules(result).includes('license/proprietary'));
    const strong = result.findings.filter((finding) => finding.rule === 'license/strong-copyleft');
    assert.equal(strong.length, 2, JSON.stringify(strong));
    assert.ok(strong.every((finding) => finding.severity === 'high'));
    assert.ok(!result.findings.some((finding) => finding.message.includes('dual@2.0.0')), 'OR with a permissive option is not a conflict');

    assert.equal(classifySpdx('MIT'), 'permissive');
    assert.equal(classifySpdx('(ISC OR Apache-2.0)'), 'permissive');
    assert.equal(classifySpdx('(MIT AND GPL-3.0-only)'), 'strong-copyleft');
    assert.equal(classifySpdx('GPL-2.0-only WITH Classpath-exception-2.0'), 'strong-copyleft');
    assert.equal(classifySpdx('MPL-2.0'), 'weak-copyleft');
    assert.equal(classifySpdx('MIT AND unknown-thing'), 'unknown');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('governance is graph-driven and accepts an injected graph and policy', async () => {
  const root = await temp('ano audit governance ');
  try {
    const policy = {
      modules: [
        { id: 'a', roots: ['src/a'], deniedDependencies: ['b'], allowedDependencies: ['core'] },
        { id: 'b', roots: ['src/b'], allowedDependencies: ['a'] },
        { id: 'c', roots: ['src/c'], allowedDependencies: [] },
      ],
    };
    const graph = {
      snapshot: () => ({
        revision: 'injected',
        files: {},
        edges: [
          { from: 'src/a/x.ts', to: 'src/b/y.ts', kind: 'value-confirmed', provenance: 'resolved', importedNames: [] },
          { from: 'src/b/y.ts', to: 'src/a/x.ts', kind: 'value-confirmed', provenance: 'resolved', importedNames: [] },
          { from: 'src/c/z.ts', to: 'src/b/y.ts', kind: 'value-confirmed', provenance: 'resolved', importedNames: [] },
        ],
        caveats: { unknownRatio: 0.75, degradedReasons: [], dynamicLoadCount: 0, heuristicEdges: 0 },
      }),
    };
    const result = await runAudit(root, { scope: 'governance', persist: false, context: { graph, policy } });
    const found = rules(result);
    for (const rule of ['governance/denied-dependency', 'governance/undeclared-dependency', 'governance/module-cycle', 'governance/low-confidence']) {
      assert.ok(found.includes(rule), `missing ${rule}; got ${found.join(',')}`);
    }
    assert.equal(result.counts.edges, 3);
    assert.equal(result.counts.modules, 3);

    const noGraph = await runAudit(root, { scope: 'governance', persist: false, context: { policy } });
    assert.ok(rules(noGraph).includes('governance/graph-missing'));
    assert.ok(noGraph.degraded.includes('graph-unavailable'));

    const malformedPolicy = await runAudit(root, { scope: 'governance', persist: false, context: { graph, policy: { modules: [{ id: 'x', roots: ['../outside'] }] } } });
    assert.ok(malformedPolicy.degraded.some((entry) => entry.startsWith('policy-root-invalid')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('dependency audit is offline, flags supply-chain shapes, and enforces confirm for online mode', async () => {
  const root = await temp('ano audit deps ');
  try {
    await write(root, 'package.json', JSON.stringify({
      dependencies: { foo: '^1.2.3', bar: '*', baz: 'latest', qux: 'github:a/b', pinned: '1.2.3', missing: '1.0.0' },
    }));
    await write(root, 'package-lock.json', JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': {},
        'node_modules/foo': { version: '1.2.3', hasInstallScript: true },
        'node_modules/foo-old': { name: 'foo', version: '1.2.2' },
        'node_modules/bar': { version: '2.0.0' },
        'node_modules/pinned': { version: '1.2.3' },
        'node_modules/qux': { version: '1.0.0', resolved: 'git+https://example.invalid/a/b' },
      },
    }));
    const result = await runAudit(root, { scope: 'deps', persist: false });
    const found = rules(result);
    for (const rule of ['deps/unpinned-range', 'deps/moving-tag', 'deps/non-registry-source', 'deps/lock-entry-missing', 'deps/install-script', 'deps/duplicate-version']) {
      assert.ok(found.includes(rule), `missing ${rule}; got ${found.join(',')}`);
    }
    assert.ok(result.caveats.includes('offline-only-no-osv-query'));

    await assert.rejects(runAudit(root, { scope: 'deps', online: true, persist: false }), /confirm=true/i);
    const noScanner = await runAudit(root, { scope: 'deps', online: true, confirm: true, persist: false });
    assert.equal(noScanner.network.requested, true);
    assert.equal(noScanner.network.performed, false);
    assert.equal(noScanner.network.refused, 'not-configured');

    let seen: { confirm: true; packages: unknown[] } | undefined;
    const scanner = async (request: { confirm: true; packages: unknown[] }) => {
      seen = request;
      return [makeFinding({ scope: 'deps', rule: 'deps/osv-vulnerability', severity: 'high', message: 'Injected scanner finding', fingerprint: sha256('injected') })];
    };
    const online = await runAudit(root, { scope: 'deps', online: true, confirm: true, persist: false, context: { onlineScanner: scanner } });
    assert.equal(online.network.performed, true);
    assert.ok(online.findings.some((finding) => finding.rule === 'deps/osv-vulnerability'));
    assert.equal(seen?.confirm, true);
    assert.ok((seen?.packages.length ?? 0) >= 5);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('drift checks package entries, anchors and ledger task files', async () => {
  const root = await temp('ano audit drift ');
  const ledger = await Ledger.open(root, { sessionId: 'AUDIT-DRIFT' });
  try {
    await write(root, 'package.json', JSON.stringify({ main: './dist/index.js' }));
    await write(root, 'src/here.ts', 'export const here = 1;\n');
    await ledger.createTask('T-DRIFT', ['src/gone.ts']);
    const result = await runAudit(root, {
      scope: 'drift',
      persist: false,
      context: {
        ledger,
        anchors: [{ file: 'src/anchor.ts' }, { file: 'src/here.ts' }, { file: '../outside.ts' }],
      },
    });
    const found = rules(result);
    assert.ok(found.includes('drift/entry-missing'));
    assert.ok(found.includes('drift/anchor-file-missing'));
    assert.ok(found.includes('drift/task-file-missing'));
    assert.ok(result.degraded.includes('anchor-path-invalid:../outside.ts'));
    assert.equal(result.counts.tasks, 1);
    assert.equal(result.counts.anchors, 3);
    assert.equal(result.counts.entries, 1);
  } finally { ledger.close(); await rm(root, { recursive: true, force: true }); }
});

test('audit events and the JSONL sink carry no plaintext and are deterministic', async () => {
  const root = await temp('ano audit events ');
  try {
    await write(root, 'config.js', `const password = "${SECRET_PASSWORD}";\n`);
    const sink = new InMemoryAuditEventSink();
    const first = await runAudit(root, { scope: 'security', persist: false, sink, now: () => 1_700_000_000_000 });
    const second = await runAudit(root, { scope: 'security', persist: false, now: () => 1_700_000_000_000 });
    assert.deepEqual(first.findings, second.findings);
    assert.equal(sink.events.length, first.findings.length + 1);
    assert.equal(sink.events.at(-1)?.type, 'summary');
    assert.ok(!JSON.stringify(sink.events).includes(SECRET_PASSWORD));

    const jsonl = new JsonlAuditEventSink(root);
    await runAudit(root, { scope: 'security', persist: false, sink: jsonl });
    const lines = (await readFile(jsonl.path, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { schema: string });
    assert.equal(lines.length, first.findings.length + 1);
    assert.ok(lines.every((line) => line.schema === 'ano.audit.event.v1'));
    assert.ok(!(await readFile(jsonl.path, 'utf8')).includes(SECRET_PASSWORD));

    for (const scope of ['drift', 'security', 'license', 'governance', 'deps'] as const) {
      const result = await runAudit(root, { scope, persist: false });
      assert.equal(result.schema, 'ano.audit.v1');
      assert.equal(result.scope, scope);
      assert.equal(result.summary.total, result.findings.length);
    }
    assert.equal(existsSync(join(root, '.ano', 'audit', 'findings.json')), false, 'persist=false must not write the store');
  } finally { await rm(root, { recursive: true, force: true }); }
});
