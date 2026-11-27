import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { runCli } from '../../src/surface/cli.ts';
import { detectInstallation } from '../../src/surface/doctor.ts';
import { startUiServer } from '../../src/surface/ui.ts';
import { toolCatalog, humanOnlyCommands } from '../../src/surface/tool-catalog.ts';
import {
  approveBaseline,
  approvedPath,
  BaselineError,
  draftPath,
  loadApprovedBaseline,
  loadBaselineDraft,
  listBaselines,
  releaseApprovedPayload,
  saveBaselineDraft,
  verifyBaseline,
  type ReleaseApprovalEvent,
  type ReleaseApprovalVerifier,
  type ReleaseApprovedPayload,
} from '../../src/readiness/baseline.ts';
import { canonicalJson } from '../../src/ledger/event.ts';
import { PINNED } from '../../scripts/check-schema.ts';

const cliPath = fileURLToPath(new URL('../../src/surface/cli.ts', import.meta.url));
const mcpPath = fileURLToPath(new URL('../../src/surface/mcp.ts', import.meta.url));
const schemaPath = fileURLToPath(new URL('../../scripts/check-schema.ts', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const PASSING = "import test from 'node:test';import assert from 'node:assert/strict';test('a', () => assert.equal(1, 1));\n";

// Synthetic red-team values are split so the production source tree never
// contains a long, realistic-looking credential; the runtime fixture still does.
const synthetic = (...parts: string[]): string => parts.join('');
const SYNTHETIC_AWS_KEY = synthetic('AKIA', 'SYNTHETICFAKE123');
const SYNTHETIC_PASSWORD = synthetic('hunter2', 'hunter2');

async function temp(prefix: string): Promise<string> { return mkdtemp(join(tmpdir(), prefix)); }
async function write(root: string, path: string, source: string): Promise<void> {
  const target = join(root, ...path.split('/'));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, source);
}
function git(root: string, args: string[]): void {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
}
async function gitProject(prefix = 'ano surface full '): Promise<string> {
  const root = await temp(prefix);
  await write(root, '.gitignore', '.ano/\n');
  await write(root, 'package.json', JSON.stringify({ private: true, type: 'module', name: 'fixture' }));
  await write(root, 'src/alpha.ts', 'export const alpha = 1;\n');
  await write(root, 'test/a.test.ts', PASSING);
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'ano@localhost'], ['config', 'user.name', 'ano'], ['add', '.'], ['commit', '-qm', 'base']]) git(root, args);
  return root;
}
async function fileHash(root: string, path: string): Promise<string> {
  return createHash('sha256').update(await readFile(join(root, ...path.split('/')))).digest('hex');
}
async function evidenceFixture(root: string): Promise<Record<string, string>> {
  await write(root, 'reports/quality.json', JSON.stringify({ counts: { tests: 10, pass: 10, fail: 0 }, ok: true }));
  await write(root, 'reports/coverage.json', JSON.stringify({ summary: { lines: { pct: 92.5 }, branches: { pct: 88 } } }));
  await write(root, 'reports/build.json', JSON.stringify({ ok: true, exitCode: 0 }));
  return {
    quality: await fileHash(root, 'reports/quality.json'),
    coverage: await fileHash(root, 'reports/coverage.json'),
    build: await fileHash(root, 'reports/build.json'),
  };
}
function draftFrom(root: string, hashes: Record<string, string>, version = 1, createdAt = '2026-01-01T00:00:00.000Z'): unknown {
  return {
    schemaVersion: 1,
    version,
    createdAt,
    criteria: [
      { id: 'tests.pass', metric: 'counts.pass', operator: '>=', target: 10, evidence: { path: 'reports/quality.json', sha256: hashes.quality, kind: 'test' } },
      { id: 'coverage.lines', metric: 'summary.lines.pct', operator: '>=', target: 90, evidence: { path: 'reports/coverage.json', sha256: hashes.coverage, kind: 'coverage' } },
      { id: 'build.exit', metric: 'exitCode', operator: '==', target: 0, evidence: { path: 'reports/build.json', sha256: hashes.build, kind: 'build' } },
    ],
    reports: {
      quality: { path: 'reports/quality.json', sha256: hashes.quality, kind: 'report' },
      coverage: { path: 'reports/coverage.json', sha256: hashes.coverage, kind: 'coverage' },
      build: { path: 'reports/build.json', sha256: hashes.build, kind: 'build' },
    },
  };
}
function attestation(): Parameters<typeof approveBaseline>[2] {
  return { human: true, tty: true, name: 'Testing Human', role: 'Release owner', scope: 'fixture@1.0.0', statement: 'I reviewed the three reports.' };
}

/**
 * In-memory stand-in for the controlled ledger. Only events explicitly issued
 * by the test (i.e. by the orchestrator) are visible to the verifier.
 */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function ledgerEventId(sequence: number): string {
  let value = sequence;
  let id = '';
  for (let index = 0; index < 26; index += 1) {
    id = CROCKFORD[value % 32] + id;
    value = Math.floor(value / 32);
  }
  return id;
}
function fakeLedger(): { verifier: ReleaseApprovalVerifier; issue: (expected: ReleaseApprovedPayload) => ReleaseApprovalEvent } {
  const events: ReleaseApprovalEvent[] = [];
  let sequence = 0;
  return {
    verifier: (request) => events.find((event) =>
      (request.eventId === undefined || event.event_id === request.eventId)
      && canonicalJson(event.payload) === canonicalJson(request.expected)) ?? null,
    issue: (expected) => {
      const event: ReleaseApprovalEvent = { event_id: ledgerEventId(++sequence), kind: 'release.approved', payload: expected };
      events.push(event);
      return event;
    },
  };
}
function approveThroughLedger(root: string, version: number, approvedAt = '2026-01-02T00:00:00.000Z') {
  const draft = loadBaselineDraft(root, version);
  const ledger = fakeLedger();
  ledger.issue(releaseApprovedPayload(draft, { ...attestation(), approvedAt }));
  const approved = approveBaseline(root, version, attestation(), { tty: true, approvedAt, verifier: ledger.verifier });
  return { approved, ledger };
}
function resultText(result: unknown): Record<string, unknown> {
  const content = (result as { content?: Array<{ type: 'text'; text: string }> }).content;
  return JSON.parse(content?.[0]?.text ?? '{}') as Record<string, unknown>;
}
async function httpStatus(url: string, options: http.RequestOptions): Promise<number> {
  return new Promise((resolveStatus, reject) => {
    const request = http.request(url, options, (response) => {
      response.resume();
      response.on('end', () => resolveStatus(response.statusCode ?? 0));
    });
    request.on('error', reject);
    request.end();
  });
}

test('doctor distinguishes local dist, npx release and source invocation', async () => {
  const packageRoot = await temp('ano doctor install ');
  try {
    await write(packageRoot, 'package.json', JSON.stringify({ name: 'agent-nihil-obstat', version: '0.0.0' }));
    const localEntry = join(packageRoot, 'dist', 'surface', 'cli.js');
    await write(packageRoot, 'dist/surface/cli.js', '#!/usr/bin/env node\n');
    const npxEntry = join(packageRoot, 'node_modules', '.cache', '_npx', 'abc', 'node_modules', 'agent-nihil-obstat', 'dist', 'surface', 'cli.js');
    await write(packageRoot, 'node_modules/.cache/_npx/abc/node_modules/agent-nihil-obstat/dist/surface/cli.js', '#!/usr/bin/env node\n');

    assert.equal(detectInstallation({ invokedPath: localEntry, packageRoot }).mode, 'local');
    const npx = detectInstallation({ invokedPath: npxEntry, packageRoot });
    assert.equal(npx.mode, 'npx');
    assert.equal(npx.underNpxCache, true);
    assert.equal(npx.npxCacheExists, true);
    assert.match(String(npx.npxCacheEntry), /_npx/);
    assert.equal(detectInstallation({ invokedPath: join(packageRoot, 'src', 'surface', 'cli.ts'), packageRoot }).mode, 'source');
  } finally { await rm(packageRoot, { recursive: true, force: true }); }

  const root = await gitProject();
  try {
    const run = spawnSync(process.execPath, [cliPath, 'doctor', '--root', root], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(run.stdout) as Record<string, any>;
    assert.equal(report.schema, 'ano.doctor.v1');
    assert.equal(report.installation.mode, 'source');
    assert.equal(report.tools.count, 7);
    assert.equal(report.human.mcpApproval, false);
    assert.equal(report.network.default, 'deny');
    assert.equal(report.network.confirmRequired, true);
    assert.equal(report.schemaCheck.checkCommand, 'node scripts/check-schema.ts');
    assert.ok(report.checks.some((check: { id: string }) => check.id === 'installation.local-dist'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rebuild graph, export and audit commands operate on the real project', async () => {
  const root = await gitProject();
  try {
    const first = await runCli(['rebuild', 'graph', '--root', root]);
    assert.equal(first.code, 0, first.output);
    const graph = JSON.parse(first.output) as Record<string, any>;
    assert.equal(graph.files, 2);
    assert.equal(typeof graph.revision, 'string');
    assert.ok(graph.revision.length > 0);
    const second = await runCli(['rebuild', 'graph', '--root', root]);
    assert.equal((JSON.parse(second.output) as Record<string, any>).revision, graph.revision);

    const tracked = await runCli(['track', 'create', '--id', 'EXP-1', '--title', 'export', '--file', 'src/alpha.ts', '--root', root]);
    assert.equal(tracked.code, 0, tracked.output);
    const exported = await runCli(['export', '--root', root]);
    assert.equal(exported.code, 0, exported.output);
    const snapshot = JSON.parse(exported.output) as Record<string, any>;
    assert.equal(snapshot.schema, 'ano.export.v1');
    assert.equal(snapshot.graph.files, 2);
    assert.ok(Array.isArray(snapshot.findings));
    assert.ok(snapshot.limitations.some((item: string) => /plaintext secrets/.test(item)));

    await write(root, 'src/secret.js', `export const password = "${SYNTHETIC_PASSWORD}";\n`);
    const audited = await runCli(['audit', 'security', '--root', root]);
    assert.equal(audited.code, 0, audited.output);
    const audit = JSON.parse(audited.output) as Record<string, any>;
    assert.equal(audit.scope, 'security');
    assert.ok(audit.findings.some((finding: Record<string, unknown>) => finding.rule === 'secret/generic-credential'));
    assert.ok(!audited.output.includes(SYNTHETIC_PASSWORD));

    const online = await runCli(['audit', 'deps', '--online', '--root', root]);
    assert.equal(online.code, 2);
    assert.match(online.output, /--confirm/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('read-only UI is loopback-only, GET-only, CSP-hardened and HTML-escaped', async () => {
  const root = await gitProject();
  let handle;
  try {
    const tracked = await runCli(['track', 'create', '--id', 'UI-1', '--title', '<script>alert(1)</script>', '--file', 'src/alpha.ts', '--root', root]);
    assert.equal(tracked.code, 0, tracked.output);
    handle = await startUiServer({ root, port: 0 });
    assert.match(handle.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);

    const page = await fetch(handle.url);
    assert.equal(page.status, 200);
    const csp = page.headers.get('content-security-policy') ?? '';
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'none'/);
    const html = await page.text();
    assert.ok(html.includes('&lt;script&gt;'), html.slice(0, 500));
    assert.ok(!html.includes('<script>'), 'the raw script tag must never appear');

    const json = await fetch(`${handle.url}export.json`);
    assert.equal(json.status, 200);
    assert.match(json.headers.get('content-type') ?? '', /application\/json/);
    const rawJson = await json.text();
    assert.ok(!rawJson.includes('<script>'));
    const parsed = JSON.parse(rawJson) as Record<string, any>;
    assert.equal(parsed.tasks[0].title, '<script>alert(1)</script>');

    const post = await fetch(handle.url, { method: 'POST', body: 'x' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET');
    const head = await fetch(handle.url, { method: 'HEAD' });
    assert.equal(head.status, 405, 'the UI is GET-only');
    const missing = await fetch(`${handle.url}../secret`);
    assert.equal(missing.status, 404);

    const spoofedHost = await httpStatus(handle.url, { method: 'GET', headers: { host: 'evil.example' } });
    assert.equal(spoofedHost, 403);

    await assert.rejects(startUiServer({ root, host: '0.0.0.0' }), /127\.0\.0\.1/);
  } finally {
    if (handle) await handle.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('acceptance baseline is versioned, evidence-recomputed, immutable and TTY-only', async () => {
  const root = await temp('ano baseline ');
  try {
    const hashes = await evidenceFixture(root);
    const draft = draftFrom(root, hashes, 1);
    saveBaselineDraft(root, draft);
    assert.equal(existsSync(draftPath(root, 1)), true);

    const first = approveThroughLedger(root, 1);
    const approved = first.approved;
    assert.equal(approved.status, 'approved');
    assert.match(approved.contentSha256, /^[a-f0-9]{64}$/);
    assert.equal(existsSync(approvedPath(root, 1)), true);
    const verification = await verifyBaseline(root, 1, { verifier: first.ledger.verifier });
    assert.equal(verification.valid, true, JSON.stringify(verification));
    assert.equal(verification.approvalVerified, true);
    assert.deepEqual(verification.criteria.map((criterion) => criterion.actual), [10, 92.5, 0]);

    assert.throws(() => approveBaseline(root, 1, attestation(), { tty: true, verifier: fakeLedger().verifier }), (error: unknown) => error instanceof BaselineError && error.code === 'BASELINE_IMMUTABLE');
    assert.throws(() => saveBaselineDraft(root, draft), (error: unknown) => error instanceof BaselineError && error.code === 'BASELINE_IMMUTABLE');

    saveBaselineDraft(root, draftFrom(root, hashes, 2));
    const second = approveThroughLedger(root, 2).approved;
    assert.equal(second.version, 2);
    assert.equal((await listBaselines(root)).filter((listing) => listing.status === 'approved').length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('baseline approval refuses non-TTY, fake hashes, hand-written PASS and report mutation', async () => {
  const root = await temp('ano baseline hard ');
  try {
    const hashes = await evidenceFixture(root);
    saveBaselineDraft(root, draftFrom(root, hashes, 1));
    assert.throws(() => approveBaseline(root, 1, attestation(), { tty: false, verifier: fakeLedger().verifier }), (error: unknown) => error instanceof BaselineError && error.code === 'BASELINE_TTY_REQUIRED');
    assert.equal(existsSync(approvedPath(root, 1)), false);

    const forged = structuredClone(draftFrom(root, hashes, 2)) as Record<string, any>;
    forged.criteria[0].evidence.sha256 = 'f'.repeat(64);
    assert.throws(() => saveBaselineDraft(root, forged), (error: unknown) => error instanceof BaselineError && error.code === 'BASELINE_EVIDENCE_MISMATCH');

    const escaped = structuredClone(draftFrom(root, hashes, 3)) as Record<string, any>;
    escaped.criteria[0].evidence.path = '../outside.json';
    assert.throws(() => saveBaselineDraft(root, escaped), (error: unknown) => error instanceof BaselineError && error.code === 'BASELINE_INVALID');

    const selfReference = structuredClone(draftFrom(root, hashes, 4)) as Record<string, any>;
    selfReference.reports.quality.path = '.ano/readiness/baselines/self.json';
    selfReference.reports.quality.sha256 = 'a'.repeat(64);
    assert.throws(() => saveBaselineDraft(root, selfReference), (error: unknown) => error instanceof BaselineError && error.code === 'BASELINE_INVALID');

    await write(root, 'reports/hand-pass.json', JSON.stringify({ result: 'PASS' }));
    const passHash = await fileHash(root, 'reports/hand-pass.json');
    const handPass = structuredClone(draftFrom(root, hashes, 5)) as Record<string, any>;
    handPass.criteria = [{ id: 'hand', metric: 'result', operator: '==', target: 1, evidence: { path: 'reports/hand-pass.json', sha256: passHash, kind: 'test' } }];
    saveBaselineDraft(root, handPass);
    const handPassApproval = approveThroughLedger(root, 5);
    const evaluated = await verifyBaseline(root, 5, { verifier: handPassApproval.ledger.verifier });
    assert.equal(evaluated.valid, false);
    assert.ok(evaluated.problems.some((problem) => problem.includes('machine-pass-must-be-numeric')), JSON.stringify(evaluated.problems));

    await write(root, 'reports/coverage.json', JSON.stringify({ summary: { lines: { pct: 100 } } }));
    const mutated = await verifyBaseline(root, 5, { verifier: handPassApproval.ledger.verifier });
    assert.equal(mutated.valid, false);
    assert.ok(mutated.problems.some((problem) => problem.startsWith('report-hash-mismatch')));

    const approvedRaw = JSON.parse(await readFile(approvedPath(root, 5), 'utf8')) as Record<string, unknown>;
    await writeFile(approvedPath(root, 5), JSON.stringify({ ...approvedRaw, notes: 'tampered' }, null, 2), 'utf8');
    assert.throws(() => loadApprovedBaseline(root, 5, { verifier: handPassApproval.ledger.verifier }), (error: unknown) => error instanceof BaselineError && error.code === 'BASELINE_INTEGRITY');

    const cliApprove = await runCli(['baseline', 'approve', '1', '--name', 'X', '--role', 'Y', '--statement', 'Z', '--confirm', '--root', root]);
    assert.equal(cliApprove.code, 2);
    assert.match(cliApprove.output, /TTY/);
    assert.deepEqual((await listBaselines(root)).map((listing) => `${listing.version}:${listing.status}`), ['1:draft', '5:approved']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('MCP exposes audit through real stdio without exposing approval tools', async () => {
  const root = await gitProject();
  const transport = new StdioClientTransport({ command: process.execPath, args: [mcpPath], env: { ...process.env, ANO_ROOT: root }, stderr: 'pipe' });
  const client = new Client({ name: 'ano-surface-test', version: '1.0.0' });
  try {
    await write(root, 'src/secret.js', `export const aws = "${SYNTHETIC_AWS_KEY}";\n`);
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name), ['brief', 'explore', 'recall', 'track', 'note', 'verify', 'audit']);
    assert.ok(!listed.tools.some((tool) => /approve|attest|sync|push/.test(tool.name)));
    const auditSchema = listed.tools.find((tool) => tool.name === 'audit')?.inputSchema as { properties?: Record<string, unknown> };
    assert.ok(auditSchema.properties && 'online' in auditSchema.properties && 'confirm' in auditSchema.properties);

    const brief = await client.callTool({ name: 'brief', arguments: { root } });
    assert.equal(brief.isError, undefined, JSON.stringify(brief));
    const audited = await client.callTool({ name: 'audit', arguments: { root, idem_key: 'a1', scope: 'security' } });
    assert.equal(audited.isError, undefined, JSON.stringify(audited));
    const result = resultText(audited);
    assert.ok(Array.isArray(result.findings));
    assert.ok((result.findings as Array<Record<string, unknown>>).some((finding) => finding.rule === 'secret/aws-access-key-id'));
    assert.ok(!JSON.stringify(audited).includes(SYNTHETIC_AWS_KEY));

    const refusedOnline = await client.callTool({ name: 'audit', arguments: { root, idem_key: 'a2', scope: 'deps', online: true } });
    assert.equal(refusedOnline.isError, true);
    assert.match(JSON.stringify(refusedOnline), /confirm=true/);
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('brief, explore, track and verify remain functional after the P5 surface extension', async () => {
  const root = await gitProject();
  try {
    const tracked = await runCli(['track', 'create', '--id', 'T-REG', '--title', 'regression', '--file', 'test/a.test.ts', '--root', root]);
    assert.equal(tracked.code, 0, tracked.output);
    const rebuilt = await runCli(['rebuild', 'graph', '--root', root]);
    assert.equal(rebuilt.code, 0, rebuilt.output);
    const explored = await runCli(['explore', 'alpha', '--root', root]);
    assert.equal(explored.code, 0, explored.output);
    assert.ok((JSON.parse(explored.output) as Record<string, unknown>).symbols);
    const verified = await runCli(['verify', 'T-REG', '--test', 'test/a.test.ts', '--root', root, '--', process.execPath, '--test', 'test/a.test.ts']);
    assert.equal(verified.code, 0, verified.output);
    assert.equal((JSON.parse(verified.output) as Record<string, any>).verdict.status, 'done');
    const briefed = await runCli(['brief', '--root', root]);
    assert.equal(briefed.code, 0, briefed.output);
    const brief = JSON.parse(briefed.output) as Record<string, any>;
    assert.equal(brief.phase, 'P7');
    assert.equal(brief.tasks[0].status, 'done');
    assert.ok(brief.limitations.some((item: string) => /MCP cannot approve/.test(item)));

    const help = await runCli([]);
    assert.match(help.output, /P1 vertical slice/);
    assert.doesNotMatch(help.output, /ready for release/);
    for (const command of [['release', 'approve'], ['sync'], ['push'], ['attest']]) {
      const rejected = await runCli(command);
      assert.equal(rejected.code, 2);
      assert.match(rejected.output, /not implemented/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('schema pin check covers exactly seven tools and ledger event kinds', () => {
  const result = spawnSync(process.execPath, [schemaPath], { encoding: 'utf8', cwd: repoRoot });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /7 tools \+ ledger event schema \(24 kinds\)/u);
  assert.deepEqual(PINNED.ledgerKinds.slice(-6), ['memory.revised', 'memory.related', 'memory.conflict.resolved', 'structure.queried', 'session.started', 'session.stop_checked']);
  assert.equal(toolCatalog.length, 7);
  assert.deepEqual(toolCatalog.map((tool) => tool.name), ['brief', 'explore', 'recall', 'track', 'note', 'verify', 'audit']);
  assert.ok(humanOnlyCommands.includes('baseline approve'));
});
