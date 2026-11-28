import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { runCli } from '../../src/surface/cli.ts';
import { createMcpServer } from '../../src/surface/mcp.ts';
import { releaseVerification, trackTask, verifyContext, verifySurface } from '../../src/surface/service.ts';
import { toolCatalog } from '../../src/surface/tool-catalog.ts';

function git(root: string, args: readonly string[]): void {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

async function write(root: string, path: string, source: string): Promise<void> {
  const target = join(root, ...path.split('/'));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, source);
}

const PASSING_TEST = "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('a', () => assert.equal(1, 1));\n";
const FAILING_TEST = "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('a', () => assert.equal(1, 2));\n";
const MUTATES_SOURCE_TEST = "import test from 'node:test';\nimport { appendFileSync } from 'node:fs';\ntest('a', () => { appendFileSync('src/alpha.ts', 'export const drifted = 1;\\n'); });\n";

/**
 * A task whose declared file is a document: the executed test is real, but no
 * value-confirmed import reaches the document, so the T1 reachability rule
 * blocks it while an explicit T0 request can still record evidence for it.
 */
async function fixture(t: TestContext, testSource: string = PASSING_TEST): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ano-verify-tier-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await write(root, '.gitignore', '.ano/\n');
  await write(root, 'package.json', JSON.stringify({ name: 'ano-verify-tier-fixture', private: true, type: 'module' }));
  await write(root, 'src/alpha.ts', 'export const alpha = 1;\n');
  await write(root, 'docs/ops-runbook.md', '# OPS runbook\n');
  await write(root, 'test/a.test.ts', testSource);
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'ano@localhost'], ['config', 'user.name', 'ano'], ['add', '.'], ['commit', '-qm', 'base']]) git(root, args);
  return root;
}

const DOC_FILE = 'docs/ops-runbook.md';
const TEST_FILE = 'test/a.test.ts';
const TEST_ARGS = [process.execPath, '--test', TEST_FILE];

interface VerdictView {
  status: 'done' | 'blocked';
  level: 'T0' | 'T1' | 'none';
  policy: { minimum: 'T0' | 'T1'; unknown: 'strict' | 'advisory' };
  reasons: string[];
  blastRadius: { uncovered: string[] };
  evidenceId?: string;
}

interface DriftedVerdict extends VerdictView {
  freshness: { status: 'fresh' | 'stale' | 'degraded'; stale: number };
}

test('explicit task tier T0 permits a document task after real tests; absent tier keeps T1 strict', async (t) => {
  const root = await fixture(t);
  await trackTask(root, { id: 'T-STRICT', status: 'in_progress', files: [DOC_FILE] }, 'tier:create:strict');
  await trackTask(root, { id: 'T-T0', status: 'in_progress', files: [DOC_FILE] }, 'tier:create:t0');

  const strict = (await verifySurface(root, { task_id: 'T-STRICT', argv: TEST_ARGS, test_files: [TEST_FILE], idem_key: 'tier:default' })).verdict as VerdictView;
  assert.equal(strict.status, 'blocked', 'default task verification must stay T1 strict');
  assert.deepEqual(strict.policy, { minimum: 'T1', unknown: 'strict' });
  assert.ok(strict.reasons.some((reason) => /test reachability/u.test(reason)), JSON.stringify(strict.reasons));
  assert.deepEqual(strict.blastRadius.uncovered, [DOC_FILE]);

  const t0 = (await verifySurface(root, { task_id: 'T-T0', argv: TEST_ARGS, test_files: [TEST_FILE], tier: 'T0', idem_key: 'tier:t0' })).verdict as VerdictView;
  assert.equal(t0.status, 'done', JSON.stringify(t0.reasons));
  assert.equal(t0.level, 'T0');
  assert.deepEqual(t0.policy, { minimum: 'T0', unknown: 'strict' }, 'T0 never relaxes the unknown-edge rule');
  assert.deepEqual(t0.blastRadius.uncovered, []);
  assert.equal(typeof t0.evidenceId, 'string');
});

test('explicit T0 still blocks a source rewrite detected during the test run', async (t) => {
  const root = await fixture(t, MUTATES_SOURCE_TEST);
  await trackTask(root, { id: 'T-T0-DRIFT', status: 'in_progress', files: [DOC_FILE] }, 'tier:create:drift');
  const verdict = (await verifySurface(root, {
    task_id: 'T-T0-DRIFT', argv: TEST_ARGS, test_files: [TEST_FILE], tier: 'T0', idem_key: 'tier:t0:drift',
  })).verdict as DriftedVerdict;

  assert.equal(verdict.status, 'blocked', JSON.stringify(verdict.reasons));
  assert.equal(verdict.level, 'none', 'source drift must never be reported as a T0 pass');
  assert.deepEqual(verdict.policy, { minimum: 'T0', unknown: 'strict' });
  assert.equal(verdict.freshness.status, 'stale');
  assert.ok(verdict.reasons.some((reason) => /latest execution failed/u.test(reason)), JSON.stringify(verdict.reasons));
  assert.equal(typeof verdict.evidenceId, 'string');
});

test('explicit T0 still blocks a failing test runner', async (t) => {
  const root = await fixture(t, FAILING_TEST);
  await trackTask(root, { id: 'T-T0-FAIL', status: 'in_progress', files: [DOC_FILE] }, 'tier:create:fail');
  const verdict = (await verifySurface(root, {
    task_id: 'T-T0-FAIL', argv: TEST_ARGS, test_files: [TEST_FILE], tier: 'T0', idem_key: 'tier:t0:fail',
  })).verdict as VerdictView;

  assert.equal(verdict.status, 'blocked', JSON.stringify(verdict.reasons));
  assert.equal(verdict.level, 'none', 'a failed run must never be reported as a T0 pass');
  assert.deepEqual(verdict.policy, { minimum: 'T0', unknown: 'strict' });
  assert.ok(verdict.reasons.some((reason) => /latest execution failed/u.test(reason)), JSON.stringify(verdict.reasons));
  assert.equal(typeof verdict.evidenceId, 'string');
});

test('an idempotency key cannot be reused to downgrade or upgrade its recorded tier', async (t) => {
  const root = await fixture(t);
  await trackTask(root, { id: 'T-UP', status: 'in_progress', files: [DOC_FILE] }, 'tier:create:up');
  await trackTask(root, { id: 'T-DOWN', status: 'in_progress', files: [DOC_FILE] }, 'tier:create:down');

  // T0 first, then a T1 retry under the same key: the policy is part of the
  // recorded verification parameters, so the retry is refused.
  const first = (await verifySurface(root, { task_id: 'T-UP', argv: TEST_ARGS, test_files: [TEST_FILE], tier: 'T0', idem_key: 'tier:switch:up' })).verdict as VerdictView;
  assert.equal(first.status, 'done');
  await assert.rejects(
    verifySurface(root, { task_id: 'T-UP', argv: TEST_ARGS, test_files: [TEST_FILE], tier: 'T1', idem_key: 'tier:switch:up' }),
    /different verification parameters|different coverage policy/u,
  );

  // T1 (blocked) first, then a T0 retry under the same key: equally refused, so
  // a blocked strict attempt cannot be laundered into a T0 pass.
  const strict = (await verifySurface(root, { task_id: 'T-DOWN', argv: TEST_ARGS, test_files: [TEST_FILE], idem_key: 'tier:switch:down' })).verdict as VerdictView;
  assert.equal(strict.status, 'blocked');
  await assert.rejects(
    verifySurface(root, { task_id: 'T-DOWN', argv: TEST_ARGS, test_files: [TEST_FILE], tier: 'T0', idem_key: 'tier:switch:down' }),
    /different verification parameters|different coverage policy/u,
  );
});

test('tier is validated on direct service calls and rejected outside the task branch', async (t) => {
  const root = await fixture(t);
  const base = { task_id: 'T-NOT-CREATED', argv: TEST_ARGS, test_files: [TEST_FILE], idem_key: 'tier:invalid' };
  await assert.rejects(verifySurface(root, { ...base, tier: 'T2' }), /tier must be 'T0' or 'T1'/u);
  await assert.rejects(verifySurface(root, { ...base, tier: 1 }), /tier must be 'T0' or 'T1'/u);
  await assert.rejects(verifySurface(root, { ...base, tier: null }), /tier must be 'T0' or 'T1'/u);
  assert.equal(existsSync(join(root, '.ano', 'ledger')), false, 'invalid tier is rejected before the ledger is opened');

  await assert.rejects(
    releaseVerification(root, { target: '0.1.0', profiles: ['A'], artifact_path: 'dist/ano.tgz', idem_key: 'tier:release', tier: 'T0' }),
    /only allowed for task verification/u,
  );
  await assert.rejects(
    verifyContext(root, { context_id: 'ctx-tier', project_scope: 'tier', draft: {}, tier: 'T0' } as never),
    /only allowed for task verification/u,
  );
});

test('the verify tool schema exposes task-only tier and the CLI enforces it on every branch', async (t) => {
  const root = await fixture(t);
  const verify = toolCatalog.find((tool) => tool.name === 'verify');
  assert.ok(verify);
  const task = { scope: 'task', task_id: 'T-SCHEMA', argv: TEST_ARGS, test_files: [TEST_FILE], idem_key: 'tier:schema' };
  assert.equal(verify.input.safeParse({ ...task, tier: 'T0' }).success, true);
  assert.equal(verify.input.safeParse({ ...task, tier: 'T1' }).success, true);
  assert.equal(verify.input.safeParse({ ...task, tier: 'T2' }).success, false);
  assert.equal(verify.input.safeParse({ ...task, tier: 0 }).success, false);
  assert.equal(verify.input.safeParse({ scope: 'release', target: '0.1.0', profiles: ['A'], artifact_path: 'dist/ano.tgz', idem_key: 'tier:schema:release', tier: 'T0' }).success, false);
  assert.equal(verify.input.safeParse({ scope: 'context', context_id: 'ctx', project_scope: 'p', draft: {}, idem_key: 'tier:schema:context', tier: 'T0' }).success, false);

  const invalid = await runCli(['verify', 'T-CLI', '--tier', 'T2', '--test', TEST_FILE, '--root', root, '--', ...TEST_ARGS]);
  assert.equal(invalid.code, 2, invalid.output);
  assert.match(invalid.output, /--tier must be T0 or T1/u);

  const missing = await runCli(['verify', 'T-CLI', '--test', TEST_FILE, '--root', root, '--tier', '--', ...TEST_ARGS]);
  assert.equal(missing.code, 2, missing.output);
  assert.match(missing.output, /--tier requires T0 or T1/u);

  const release = await runCli(['verify', 'release', '--target', '0.1.0', '--profile', 'A', '--artifact', 'dist/ano.tgz', '--tier', 'T0', '--root', root]);
  assert.equal(release.code, 2, release.output);
  assert.match(release.output, /does not accept --tier/u);

  const context = await runCli(['verify', 'context', '--context-id', 'ctx', '--project-scope', 'p', '--draft', 'draft.json', '--tier', 'T0', '--root', root]);
  assert.equal(context.code, 2, context.output);
  assert.match(context.output, /does not accept --tier/u);

  await trackTask(root, { id: 'T-CLI', status: 'in_progress', files: [DOC_FILE] }, 'tier:create:cli');
  const accepted = await runCli(['verify', 'T-CLI', '--tier', 'T0', '--test', TEST_FILE, '--root', root, '--', ...TEST_ARGS]);
  assert.equal(accepted.code, 0, accepted.output);
  const verdict = (JSON.parse(accepted.output) as { verdict: VerdictView }).verdict;
  assert.equal(verdict.status, 'done');
  assert.deepEqual(verdict.policy, { minimum: 'T0', unknown: 'strict' });
});

test('CLI absent --tier and explicit --tier T1 both stay strict T1', async (t) => {
  const root = await fixture(t);
  await trackTask(root, { id: 'T-CLI-DEFAULT', status: 'in_progress', files: [DOC_FILE] }, 'tier:create:cli-default');
  await trackTask(root, { id: 'T-CLI-STRICT', status: 'in_progress', files: [DOC_FILE] }, 'tier:create:cli-strict');

  const absent = await runCli(['verify', 'T-CLI-DEFAULT', '--test', TEST_FILE, '--root', root, '--', ...TEST_ARGS]);
  assert.equal(absent.code, 0, absent.output);
  const absentVerdict = (JSON.parse(absent.output) as { verdict: VerdictView }).verdict;
  assert.equal(absentVerdict.status, 'blocked', JSON.stringify(absentVerdict.reasons));
  assert.deepEqual(absentVerdict.policy, { minimum: 'T1', unknown: 'strict' });
  assert.deepEqual(absentVerdict.blastRadius.uncovered, [DOC_FILE]);
  assert.ok(absentVerdict.reasons.some((reason) => /test reachability/u.test(reason)), JSON.stringify(absentVerdict.reasons));

  const explicit = await runCli(['verify', 'T-CLI-STRICT', '--tier', 'T1', '--test', TEST_FILE, '--root', root, '--', ...TEST_ARGS]);
  assert.equal(explicit.code, 0, explicit.output);
  const explicitVerdict = (JSON.parse(explicit.output) as { verdict: VerdictView }).verdict;
  assert.equal(explicitVerdict.status, 'blocked', JSON.stringify(explicitVerdict.reasons));
  assert.deepEqual(explicitVerdict.policy, { minimum: 'T1', unknown: 'strict' });
  assert.deepEqual(explicitVerdict.blastRadius.uncovered, [DOC_FILE]);
});

test('MCP validates tier end-to-end: invalid/release/context rejected, T0 accepted, absent tier stays T1', async (t) => {
  const root = await fixture(t);
  await trackTask(root, { id: 'T-MCP-T0', status: 'in_progress', files: [DOC_FILE] }, 'tier:mcp:create:t0');
  await trackTask(root, { id: 'T-MCP-STRICT', status: 'in_progress', files: [DOC_FILE] }, 'tier:mcp:create:strict');
  const server = createMcpServer(root);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'ano-verify-tier', version: '1.0.0' });
  await client.connect(clientTransport);
  try {
    const invalid = await client.callTool({
      name: 'verify',
      arguments: { root, idem_key: 'tier:mcp:invalid', scope: 'task', task_id: 'T-MCP', argv: TEST_ARGS, test_files: [TEST_FILE], tier: 'T2' },
    }) as { isError?: boolean; content: { text: string }[] };
    assert.equal(invalid.isError, true);
    assert.match(invalid.content[0]!.text, /tier|T0|T1|invalid/iu);

    const release = await client.callTool({
      name: 'verify',
      arguments: { root, idem_key: 'tier:mcp:release', scope: 'release', target: '0.1.0', profiles: ['A'], artifact_path: 'dist/ano.tgz', tier: 'T0' },
    }) as { isError?: boolean; content: { text: string }[] };
    assert.equal(release.isError, true);
    assert.match(release.content[0]!.text, /only allowed for task verification/u);

    const context = await client.callTool({
      name: 'verify',
      arguments: { root, idem_key: 'tier:mcp:context', scope: 'context', context_id: 'ctx-tier', project_scope: 'tier', draft: {}, tier: 'T0' },
    }) as { isError?: boolean; content: { text: string }[] };
    assert.equal(context.isError, true);
    assert.match(context.content[0]!.text, /only allowed for task verification/u);

    const accepted = await client.callTool({
      name: 'verify',
      arguments: { root, idem_key: 'tier:mcp:t0', scope: 'task', task_id: 'T-MCP-T0', argv: TEST_ARGS, test_files: [TEST_FILE], tier: 'T0' },
    }) as { isError?: boolean; content: { text: string }[] };
    assert.equal(accepted.isError, undefined, accepted.content[0]?.text ?? 'verify returned an unexpected error');
    const t0Verdict = (JSON.parse(accepted.content[0]!.text) as { verdict: VerdictView }).verdict;
    assert.equal(t0Verdict.status, 'done', JSON.stringify(t0Verdict.reasons));
    assert.equal(t0Verdict.level, 'T0');
    assert.deepEqual(t0Verdict.policy, { minimum: 'T0', unknown: 'strict' });

    const strict = await client.callTool({
      name: 'verify',
      arguments: { root, idem_key: 'tier:mcp:strict', scope: 'task', task_id: 'T-MCP-STRICT', argv: TEST_ARGS, test_files: [TEST_FILE] },
    }) as { isError?: boolean; content: { text: string }[] };
    assert.equal(strict.isError, undefined, strict.content[0]?.text ?? 'verify returned an unexpected error');
    const strictVerdict = (JSON.parse(strict.content[0]!.text) as { verdict: VerdictView }).verdict;
    assert.equal(strictVerdict.status, 'blocked', JSON.stringify(strictVerdict.reasons));
    assert.deepEqual(strictVerdict.policy, { minimum: 'T1', unknown: 'strict' });
    assert.deepEqual(strictVerdict.blastRadius.uncovered, [DOC_FILE]);
  } finally {
    await client.close();
    await server.close();
  }
});
